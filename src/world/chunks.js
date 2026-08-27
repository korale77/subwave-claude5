/**
 * SUBWAVE terrain streaming.
 *
 * Concentric LOD rings around the camera. Ring k covers everything closer than
 * WORLD.LOD_BASE_DISTANCE * 2^k and is meshed at half the vertex density of
 * ring k-1, so a chunk's triangle count falls as 4^-k while its screen area
 * falls as roughly the same - which is the whole point of a clipmap: constant
 * triangle density per pixel from the boots to the horizon.
 *
 * The chunk FOOTPRINT stays at WORLD.CHUNK_SIZE (128 m) in every ring. Growing
 * the footprint with the ring would cut the draw count, but it would also make
 * a chunk's mesh depend on which ring it is in AND on where its neighbours
 * start, and the whole design here rests on a chunk being a pure function of
 * (cx, cz, lod). Instead the far rings are made cheap: at ring 6 a chunk is two
 * triangles, and 3000 of them cost less than one ring-0 chunk.
 *
 * WHERE THE WORK HAPPENS. The mesher runs in a pool of module Web Workers
 * (terrain_worker.js). One LOD-0 bake is a measured 17.71 ms mean / 23.32 ms
 * p99 - up to four 120 Hz frames - and a bake is INDIVISIBLE, so no frame
 * budget can cut one up; that is why the time-budget-plus-debt scheme below
 * could only ever stop bakes landing back to back, never make one shorter.
 * With the pool, all that is left on the frame is the UPLOAD: two writeBuffer
 * calls on a transferred ArrayBuffer, a measured 0.02 ms per LOD-0 chunk. An
 * upload IS divisible, so it takes a real time budget
 * (STREAMING.UPLOAD_MS_PER_FRAME) and deferring one costs latency, never work.
 *
 * THE INLINE PATH IS NOT DEAD CODE. `_dispatchInline` is the fallback when no
 * worker can be constructed or when the pool dies mid-session, and it is the
 * path Node takes: `typeof Worker === 'undefined'` there, which is what lets
 * tools/test-terrain.mjs keep driving `while (cm.stats.queued > 0) cm.update()`
 * as a synchronous loop. It keeps BAKE_MS_PER_FRAME and the carried debt,
 * because on that path they are still the only defence there is.
 *
 * ASYNC LIFECYCLE. Once a bake outlives the call that started it, two silent
 * failures open up: a rescan re-queueing a chunk that is already being made
 * (double-baking the most expensive class of chunk every 0.10 s at 119 m/s),
 * and a completing bake resurrecting a chunk that `_unload` dropped while it
 * was in flight (a GPU-buffer leak with no symptom). Both are closed by one
 * monotonic stamp per job - see `_seq`.
 */

import { WORLD, RENDER, STREAMING } from '../core/constants.js';
import { events, EVENTS } from '../core/events.js';
import { BufferUsage, createBuffer } from '../core/resources.js';
import * as terrainModule from './terrain.js';

const CHUNK_SIZE = WORLD.CHUNK_SIZE;

/**
 * Metres the camera must travel past a ring boundary before a chunk changes
 * LOD. Without it a player hovering on a boundary rebakes the same ring twice a
 * second and never lets the queue drain.
 */
const LOD_HYSTERESIS = 24;

/** Metres the camera must move before the desired set is recomputed. */
const RESCAN_DISTANCE = 12;

/**
 * Seconds of travel to bias the streaming centre forward by.
 *
 * Chunks are baked NEAREST FIRST, which is right when you are standing still and
 * wrong when you are moving: the nearest un-baked chunk is behind you as often as
 * ahead, and at speed the ones you are about to need arrive last. Offsetting the
 * scan centre along the velocity vector orders the queue by where you are GOING,
 * so a throttled queue spends its budget on ground you will actually see.
 *
 * 1.2 s is 144 m at the Kestrel's 120 m/s and 46 m at its submerged 38 - about one
 * chunk of lead in each case, which is what the bake needs to stay ahead.
 *
 * It matters MORE with a worker pool, not less: the pool drains the queue faster,
 * so a larger share of what it bakes is ground the player has not reached yet.
 */
const STREAM_LEAD_SECONDS = 1.2;

/**
 * INLINE FALLBACK ONLY: frame time the streamer will spend baking on the main
 * thread, milliseconds, and the ceiling on how much overrun it carries forward.
 *
 * A COUNT budget cannot bound frame time when one unit costs anywhere from 9 to
 * 31.5 ms - measured - so a single admitted bake can be four 120 Hz frames long.
 * The count budget is kept as a coarse guard, but the real limit is time, plus a
 * DEBT: a frame that overran by 20 ms bakes nothing for the next 20 ms of frames.
 * That does not make any single bake shorter - only the worker does that - but it
 * stops them landing back to back, which is what reads as judder.
 */
const BAKE_MS_PER_FRAME = 4.0;
const BAKE_DEBT_MAX_MS = 40.0;

/**
 * Milliseconds the boot loop will wait on the pool before looking again.
 *
 * Boot is driven by worker replies, not by a timer: every `baked` message wakes
 * the loop, so the pool is refilled the instant a slot frees. This is only the
 * safety net that keeps boot moving if every reply is lost.
 */
const BOOT_POLL_MS = 50;

/**
 * Streaming radius reduction with depth.
 *
 * Underwater the view distance is not set by the clipmap, it is set by the water:
 * this project's own measured extinction has red gone by 18 m, green by 80 m and
 * blue by 182 m. Streaming terrain out to 4 km at 250 m down bakes ground that is
 * physically invisible, and the queue measured 1,282 chunks deep in steady-state
 * submerged flight while air flight held at 53.
 *
 * QUANTISED, with the step deliberately coarse. The radius feeds chunk residency,
 * so a radius that slid continuously with depth would load and unload the same
 * ring every time the vessel bobbed. Four steps, and depth has to cross a whole one
 * to change anything.
 */
const DEPTH_RADIUS_STEPS = Float64Array.of(1.0, 0.80, 0.60, 0.45);
const DEPTH_RADIUS_DEPTHS = Float64Array.of(0, 40, 90, 160);

/** Chunks kept beyond the streaming radius before they are dropped. */
const UNLOAD_MARGIN = 1.15;

export class ChunkManager {
  /**
   * @param {GPUDevice} device
   * @param {import('../render/camera.js').Camera} camera
   * @param {object} [terrain] the terrain module; injectable for tests/workers
   * @param {{workers?: number}} [opts] `workers` forces the pool size; 0 forces
   *   the inline path, which is what a test wanting a synchronous drain asks for.
   */
  constructor(device, camera, terrain = terrainModule, opts = {}) {
    this.device = device;
    this.camera = camera;
    this.terrain = terrain;

    /** @type {Map<number, object>} live chunks, keyed by packed (cx, cz) */
    this.chunks = new Map();
    /** @type {Array<object>} pending bake jobs, nearest first */
    this.queue = [];
    /** @type {Set<number>} keys already queued, so a rescan cannot double-queue */
    this.queued = new Set();
    /**
     * @type {Map<number, object>} key -> the job that owns it, from the moment it
     * leaves `queue` until its mesh is uploaded or dropped. This is what stops a
     * rescan re-queueing a chunk that is already being made: with a worker a job
     * is in neither `queue` nor `queued` while it is in flight, and a rescan runs
     * every 12 m of travel - every 0.10 s at 119 m/s.
     */
    this._pending = new Map();
    /** @type {Array<{job: object, msg: object, slot: object}>} meshes back from a
     *  worker, waiting for an upload slot. */
    this._completed = [];
    /**
     * @type {Map<number, number>} key -> the stamp of the newest job for it.
     *
     * A job whose stamp no longer matches its key's is superseded (a rescan asked
     * for a different LOD) or orphaned (`_unload` dropped the chunk while the bake
     * was in flight), and its mesh is discarded on arrival. Without it a stale
     * completion resurrects a chunk outside the residency radius, allocates GPU
     * buffers for it and emits CHUNK_LOADED - silently.
     *
     * The counter is GLOBAL rather than per key on purpose: `_unload` deletes the
     * key's entry, so a per-key counter would restart at 1 and could hand a new
     * job the same stamp a stale one is still carrying.
     */
    this._seq = new Map();
    this._seqNext = 1;

    this.ringRadius = new Float64Array(WORLD.LOD_RINGS);
    for (let i = 0; i < WORLD.LOD_RINGS; i++) {
      this.ringRadius[i] = WORLD.LOD_BASE_DISTANCE * Math.pow(2, i);
    }
    this.viewRadius = Math.min(RENDER.MAX_VIEW_DISTANCE, this.ringRadius[WORLD.LOD_RINGS - 1]);

    /** INLINE FALLBACK: bake budget per frame, in LOD-0-equivalent chunks. */
    this.bakeBudget = 1.0;
    /** INLINE FALLBACK: carried bake overrun, milliseconds. See _drain(). */
    this._bakeDebtMs = 0;
    /** Index into DEPTH_RADIUS_STEPS; a rescan is forced when it changes. */
    this._radiusStep = 0;
    /** INLINE FALLBACK: hard cap on bakes per frame regardless of cost. */
    this.maxBakesPerFrame = 32;
    /** Hard cap on uploads per frame regardless of the time budget. */
    this.maxUploadsPerFrame = STREAMING.MAX_UPLOADS_PER_FRAME;
    /** Hard cap on resident chunks; the farthest queued jobs are dropped. */
    this.maxChunks = 4096;

    // Cost normalisation: a LOD-0 chunk is 1.0.
    this._lod0Vertices = this._vertexCountFor(0);

    // Interleave scratch for the INLINE path, sized for the largest chunk. One
    // allocation, forever. The worker path never touches it - its mesh arrives
    // already interleaved, in a buffer it owns.
    const maxBytes = this._lod0Vertices * terrain.VERTEX_STRIDE;
    this._staging = new ArrayBuffer(maxBytes);
    this._stagingF32 = new Float32Array(this._staging);
    this._stagingU8 = new Uint8Array(this._staging);

    /** @type {Map<number, GPUBuffer[]>} exact-size buffer pools, by byte length */
    this._vertexPool = new Map();
    this._indexPool = new Map();
    this._pooledCount = 0;
    this._pooledBytes = 0;

    this._visible = [];
    this._lastScanX = Infinity;
    this._lastScanZ = Infinity;

    // Running totals, maintained by _onBaked/_unload. Recomputing them by walking
    // all 3,293 resident chunks was affordable once per bake and is not once per
    // frame, which is what the worker path would have made it.
    this._triangles = 0;
    this._gpuBytes = 0;

    this.stats = {
      loaded: 0, queued: 0, inFlight: 0, pendingUploads: 0, visible: 0,
      triangles: 0, visibleTriangles: 0,
      // MAIN-THREAD bake only. On the worker path this reads 0 for the whole
      // session, which is the headline claim of the change and must not be
      // muddied by folding the worker's own bake time into it.
      bakeMsLast: 0, bakeMsAvg: 0, bakeMsPeak: 0,
      workerBakeMsLast: 0, workerBakeMsAvg: 0, workerBakeMsPeak: 0,
      uploadMsLast: 0, uploadMsPeak: 0,
      gpuBytes: 0, pooledBuffers: 0, pooledBytes: 0,
      bakesThisFrame: 0, uploadsThisFrame: 0, workerCount: 0,
    };
    this._bakeMsAccum = 0;
    this._bakeCount = 0;
    this._workerBakeMsAccum = 0;
    this._workerBakeCount = 0;
    this._destroyed = false;

    /** @type {Array<object>} pool slots: { w, job, ready, timer, resolve } */
    this._workers = [];
    this._readyWorkers = 0;
    this._busyWorkers = 0;
    this._progressResolve = null;
    /** Settles when every worker has answered `ready` or been retired. */
    this._poolReady = this._initWorkers(opts);
  }

  get loadedCount() { return this.chunks.size; }

  // -------------------------------------------------------------------------
  // Keys and LOD
  // -------------------------------------------------------------------------

  /** Pack a signed chunk coordinate pair into one integer key. Bijective for
   *  |cx|,|cz| < 32768, which is 4 million metres of world in each direction. */
  static key(cx, cz) { return ((cx & 0xffff) << 16) | (cz & 0xffff); }

  _vertexCountFor(lod) {
    const res = this.terrain.lodResolution(lod);
    return res * res + 4 * (res - 1);
  }

  /**
   * Ring for a chunk at `dist` metres, with hysteresis against its current ring.
   */
  _lodFor(dist, current) {
    let want = WORLD.LOD_RINGS - 1;
    for (let l = 0; l < WORLD.LOD_RINGS; l++) {
      if (dist < this.ringRadius[l]) { want = l; break; }
    }
    if (current === undefined || want === current) return want;
    const boundary = this.ringRadius[want > current ? current : want];
    if (Math.abs(dist - boundary) < LOD_HYSTERESIS) return current;
    return want;
  }

  // -------------------------------------------------------------------------
  // Worker pool
  // -------------------------------------------------------------------------

  /**
   * Build the pool and shake hands with it.
   *
   * Three layers of failure handling, all of them needed. `new Worker(...)`
   * throws synchronously only on a bad URL or a SecurityError; a module
   * RESOLUTION failure surfaces asynchronously as an `error` event whose message
   * is EMPTY - measured - so the deadline below is the only thing that can tell
   * "still loading" from "will never load". And a worker is not usable until it
   * has answered `ready`, because terrain.js derives its seeds at module load
   * from WORLD.DEFAULT_SEED and the game overrides that afterwards: a bake that
   * overtook its `init` would be meshed against the wrong seed and put a seam in
   * the world.
   *
   * @returns {Promise<void>}
   */
  _initWorkers(opts) {
    const explicit = opts && opts.workers !== undefined;
    if (explicit && (opts.workers | 0) <= 0) return Promise.resolve();
    // Node has no Worker, so the offline suites fall through to the inline path
    // with no try/catch noise and no change in behaviour.
    if (typeof Worker !== 'function') return Promise.resolve();

    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    const want = explicit ? (opts.workers | 0)
      : Math.max(1, Math.min(STREAMING.WORKER_POOL_MAX,
        cores - STREAMING.WORKER_CORES_RESERVED));

    // A real file resolved against import.meta.url, not a blob: a blob-URL module
    // worker resolves its imports against the blob's own origin, which is exactly
    // the case that fails with an empty error message.
    const url = new URL('./terrain_worker.js', import.meta.url);
    const seed = this.terrain.getSeed();
    const handshakes = [];

    for (let i = 0; i < want; i++) {
      let w;
      try {
        w = new Worker(url, { type: 'module' });
      } catch (e) {
        console.warn('[chunks] terrain worker unavailable, baking inline:', e.message);
        break;
      }
      const slot = { w, job: null, ready: false, timer: 0, resolve: null };
      w.onmessage = (ev) => this._onWorkerMessage(slot, ev.data);
      w.onerror = (ev) => this._retireWorker(slot, (ev && ev.message) || 'error event');
      w.onmessageerror = () => this._retireWorker(slot, 'message could not be deserialised');
      this._workers.push(slot);
      handshakes.push(new Promise((resolve) => {
        slot.resolve = resolve;
        slot.timer = setTimeout(
          () => this._retireWorker(slot, `no ready reply in ${STREAMING.WORKER_READY_TIMEOUT_MS} ms`),
          STREAMING.WORKER_READY_TIMEOUT_MS);
      }));
      w.postMessage({ t: 'init', seed });
    }

    if (handshakes.length === 0) return Promise.resolve();
    return Promise.all(handshakes).then(() => {
      if (this._readyWorkers === 0 && !this._destroyed) {
        console.warn('[chunks] no terrain worker came up; baking inline');
      }
    });
  }

  /** Resolves when the pool has finished its handshake. Boot awaits it. */
  get poolReady() { return this._poolReady; }

  _onWorkerMessage(slot, msg) {
    if (msg.t === 'ready') {
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = 0; }
      if (!slot.ready) { slot.ready = true; this._readyWorkers++; }
      this._settle(slot);
      this._wake();
      return;
    }

    // Checked BEFORE the slot is freed: an unrecognised reply must not be able
    // to release a job that is still being worked on.
    if (msg.t !== 'baked' && msg.t !== 'error') return;
    const job = slot.job;
    if (job) { slot.job = null; this._busyWorkers--; }

    if (msg.t === 'error') {
      // The bake threw. That is a bug in the mesher, not in the worker, so the
      // worker keeps its place in the pool and only the job is lost; the next
      // rescan re-queues the chunk.
      console.error('[chunks] terrain bake failed at', msg.key, msg.message);
      if (job) this._forgetPending(job);
      this._fill(slot);
      this._wake();
      return;
    }

    // Drop a superseded or orphaned mesh HERE rather than at upload time: it
    // frees the transfer buffer a frame earlier and it keeps `_completed` to at
    // most one entry per key, which is what makes the two stats disjoint.
    if (!job || this._destroyed || job.seq !== this._seq.get(job.key)) {
      if (job) this._forgetPending(job);
      this._recycle(slot, msg.buf);
    } else {
      this._completed.push({ job, msg, slot });
    }
    // Refill immediately rather than waiting for the next frame: between frames
    // is exactly when the pool should be working.
    this._fill(slot);
    this._wake();
  }

  /** Post the next queued job to an idle, ready slot. */
  _fill(slot) {
    if (this._destroyed || !slot.ready || slot.job || this.queue.length === 0) return;
    // EXACTLY ONE job in flight per worker. A job sitting in a worker's mailbox
    // cannot be re-prioritised or cancelled, so a queue inside the worker turns
    // a direction change into stale bakes the player has to wait through. With
    // one-in-flight the worst case after a reversal is poolSize stale bakes, all
    // of them worker time and all dropped by the stamp check.
    const job = this.queue.shift();
    this.queued.delete(job.key);
    this._pending.set(job.key, job);
    slot.job = job;
    this._busyWorkers++;
    slot.w.postMessage({ t: 'bake', key: job.key, cx: job.cx, cz: job.cz, lod: job.lod, seq: job.seq });
  }

  /** Fill every idle slot. Not budgeted: a postMessage of a job descriptor is
   *  sub-microsecond, and the only per-frame budget that buys anything is the
   *  upload one. */
  _dispatchAll() {
    let dispatched = 0;
    for (let i = 0; i < this._workers.length; i++) {
      const slot = this._workers[i];
      if (slot.ready && !slot.job && this.queue.length > 0) { this._fill(slot); dispatched++; }
    }
    this.stats.bakesThisFrame = dispatched;
  }

  /**
   * Hand a spent transfer buffer back to the worker that made it.
   *
   * REQUIRED, not an optimisation. queue.writeBuffer copies at call time, so the
   * buffer is free the instant the upload returns, and at 119 m/s the pool
   * produces ~3.5 MB/s of large transferred ArrayBuffers. Letting those become
   * main-thread garbage reintroduces exactly the GC pauses this change exists to
   * remove.
   */
  _recycle(slot, buf) {
    // byteLength 0 means it has already been transferred away.
    if (!slot || !slot.ready || !buf || buf.byteLength === 0) return;
    slot.w.postMessage({ t: 'recycle', buf }, [buf]);
  }

  _retireWorker(slot, why) {
    const i = this._workers.indexOf(slot);
    if (i < 0) return;                       // already retired
    this._workers.splice(i, 1);
    if (slot.ready) this._readyWorkers--;
    slot.ready = false;
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = 0; }
    try { slot.w.terminate(); } catch { /* already gone */ }

    // Its job is the nearest outstanding one by construction, so it goes back to
    // the FRONT of the queue rather than the tail.
    const job = slot.job;
    slot.job = null;
    if (job) {
      this._busyWorkers--;
      this._forgetPending(job);
      if (!this.queued.has(job.key) && this._seq.get(job.key) === job.seq) {
        this.queued.add(job.key);
        this.queue.unshift(job);
      }
    }
    if (!this._destroyed) console.warn('[chunks] terrain worker retired:', why);
    this._settle(slot);
    this._wake();
  }

  /** Release a slot's handshake promise exactly once. */
  _settle(slot) {
    const resolve = slot.resolve;
    if (resolve) { slot.resolve = null; resolve(); }
  }

  /** Wake the boot loop; see init(). */
  _wake() {
    const resolve = this._progressResolve;
    if (resolve) { this._progressResolve = null; resolve(); }
  }

  _waitForPool(ms) {
    return new Promise((resolve) => {
      // The timer is cleared by the wake, not left to fire: boot runs this loop
      // once per chunk, and an uncleared 50 ms timer per iteration would leave
      // thousands of them queued behind the boot it is meant to be driving.
      const timer = setTimeout(() => {
        if (this._progressResolve === wake) this._progressResolve = null;
        resolve();
      }, ms);
      const wake = () => { clearTimeout(timer); resolve(); };
      this._progressResolve = wake;
    });
  }

  // -------------------------------------------------------------------------
  // Streaming
  // -------------------------------------------------------------------------

  /**
   * Pre-bake the rings around the camera before the first frame, yielding to
   * the event loop between batches so the boot screen keeps painting.
   * @param {(t: number) => void} [onProgress] 0..1
   */
  async init(onProgress) {
    await this._poolReady;
    if (this._destroyed) return this;
    const p = this.camera.position;
    this._rescan(p[0], p[2]);
    const total = this.queue.length;
    if (total === 0) { onProgress?.(1); return this; }

    // Worker path. Boot is driven by the replies themselves: each one wakes this
    // loop, which refills the pool and uploads whatever has landed. Nothing is
    // being rendered yet, so uploads are not budgeted - the entire 30.66 MB of
    // resident geometry is about 66 ms of writeBuffer.
    while (!this._destroyed && this._readyWorkers > 0 &&
           (this.queue.length > 0 || this._pending.size > 0)) {
      this._dispatchAll();
      this._drainUploads(Infinity);
      onProgress?.(Math.min(1, (total - this.queue.length - this._pending.size) / total));
      if (this.queue.length === 0 && this._pending.size === 0) break;
      await this._waitForPool(BOOT_POLL_MS);
    }

    // Inline path, and the tail of a boot whose pool died: bake in slices,
    // yielding between them so the boot progress bar still paints.
    while (this.queue.length > 0 && !this._destroyed) {
      // Four LOD-0-equivalents per slice: about 90 ms of bake, which is short
      // enough that the boot progress bar still paints between batches and long
      // enough that the yields do not dominate. Nothing is being rendered yet,
      // so frame time is not the constraint - responsiveness is.
      this._drain(4, 256, Infinity);
      onProgress?.(Math.min(1, (total - this.queue.length) / total));
      await new Promise((r) => setTimeout(r, 0));
    }

    this._updateStats();
    onProgress?.(1);
    return this;
  }

  /**
   * Per-frame streaming step. Cheap when the camera has not moved: the desired
   * set is only recomputed after RESCAN_DISTANCE metres of travel.
   *
   * @param {ArrayLike<number>} cameraPos absolute world position
   * @param {ArrayLike<number>} [cameraVel] world velocity, m/s. Used to bias the
   *   streaming centre forward - see STREAM_LEAD_SECONDS. Optional: without it the
   *   behaviour is exactly the old nearest-first ordering about the camera.
   */
  update(cameraPos, cameraVel) {
    if (this._destroyed) return;
    let x = cameraPos[0], z = cameraPos[2];
    if (cameraVel) {
      x += cameraVel[0] * STREAM_LEAD_SECONDS;
      z += cameraVel[2] * STREAM_LEAD_SECONDS;
    }
    // Streaming radius shrinks with depth, in coarse steps. See
    // DEPTH_RADIUS_STEPS: below the surface the water sets the view distance long
    // before the clipmap does.
    const depth = Math.max(0, -cameraPos[1]);
    let step = 0;
    for (let i = DEPTH_RADIUS_DEPTHS.length - 1; i >= 0; i--) {
      if (depth >= DEPTH_RADIUS_DEPTHS[i]) { step = i; break; }
    }
    const dx = x - this._lastScanX, dz = z - this._lastScanZ;
    if (step !== this._radiusStep ||
        dx * dx + dz * dz > RESCAN_DISTANCE * RESCAN_DISTANCE) {
      this._radiusStep = step;
      this._rescan(x, z);
    }
    if (this._readyWorkers > 0) this._dispatchAll();
    else if (this._workers.length === 0) this._drain(this.bakeBudget, this.maxBakesPerFrame);
    // else: the pool is mid-handshake. It is bounded by WORKER_READY_TIMEOUT_MS,
    // after which either a worker is ready or the pool is empty and this falls
    // through to the inline path.
    this._drainUploads(STREAMING.UPLOAD_MS_PER_FRAME);
    this._updateStats();
  }

  /**
   * Rebuild the desired chunk set and the unload list.
   *
   * Note that `camX/camZ` here is the LEAD point, not the camera - see update().
   * The residency radius is measured from it, which is what makes the queue order
   * follow the direction of travel. The unload margin absorbs the offset, so
   * nothing directly behind a fast-moving camera is dropped while still visible.
   */
  _rescan(camX, camZ) {
    this._lastScanX = camX;
    this._lastScanZ = camZ;
    const radius = this.viewRadius * DEPTH_RADIUS_STEPS[this._radiusStep];
    const half = CHUNK_SIZE * 0.5;
    const c0x = Math.floor((camX - radius) / CHUNK_SIZE);
    const c1x = Math.floor((camX + radius) / CHUNK_SIZE);
    const c0z = Math.floor((camZ - radius) / CHUNK_SIZE);
    const c1z = Math.floor((camZ + radius) / CHUNK_SIZE);
    const r2 = radius * radius;

    // A queued job this scan does not re-enqueue ceases to exist, so its stamp
    // goes with it. Without this `_seq` grows for the life of the session by
    // every chunk that was ever queued and then left behind.
    for (const key of this.queued) this._seq.delete(key);
    this.queue.length = 0;
    this.queued.clear();

    for (let cz = c0z; cz <= c1z; cz++) {
      const centreZ = cz * CHUNK_SIZE + half;
      const ddz = centreZ - camZ;
      for (let cx = c0x; cx <= c1x; cx++) {
        const centreX = cx * CHUNK_SIZE + half;
        const ddx = centreX - camX;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 > r2) continue;

        const dist = Math.sqrt(d2);
        const key = ChunkManager.key(cx, cz);
        const existing = this.chunks.get(key);
        const lod = this._lodFor(dist, existing ? existing.lod : undefined);
        if (existing) {
          existing.keep = true;
          if (existing.lod === lod) continue;
        }
        // Already being made at the LOD we want. Leaving it alone is what stops
        // the double-bake; an in-flight job at the WRONG LOD is left to run but
        // superseded by the new stamp, so its mesh is dropped on arrival rather
        // than overwriting the newer one.
        const pending = this._pending.get(key);
        if (pending && pending.lod === lod) continue;
        if (this.queued.has(key)) continue;
        const seq = this._seqNext++;
        this._seq.set(key, seq);
        this.queued.add(key);
        this.queue.push({ key, cx, cz, lod, dist, seq });
      }
    }

    // Nearest first: the chunk under the player's feet must never be the last
    // one to arrive.
    this.queue.sort((a, b) => a.dist - b.dist);
    const room = this.maxChunks - this.chunks.size - this._pending.size;
    if (this.queue.length > room) {
      for (let i = Math.max(0, room); i < this.queue.length; i++) {
        this.queued.delete(this.queue[i].key);
        this._seq.delete(this.queue[i].key);
      }
      this.queue.length = Math.max(0, room);
    }

    // Unload anything the scan did not claim, with a margin so a chunk sitting
    // exactly on the radius does not oscillate.
    const unloadR2 = (radius * UNLOAD_MARGIN) * (radius * UNLOAD_MARGIN);
    for (const chunk of this.chunks.values()) {
      if (chunk.keep) { chunk.keep = false; continue; }
      const ddx = chunk.originX + half - camX;
      const ddz = chunk.originZ + half - camZ;
      if (ddx * ddx + ddz * ddz > unloadR2) this._unload(chunk);
    }
    this._updateStats();
  }

  /**
   * INLINE FALLBACK: process the queue until the time budget, the cost budget or
   * the hard cap is spent.
   *
   * TIME is the real limit, because a "cost" unit is anywhere from 9 to 31.5 ms of
   * measured wall clock depending on how much of the layer stack the ground
   * activates. A pure count or cost budget therefore cannot bound the frame: at
   * 120 Hz a single admitted LOD-0 bake is up to four frames long. Flying at
   * 120 m/s made that unmissable - measured, 14 frames in 610 over 16.7 ms with a
   * 33 ms worst case, which is a visible stutter about once a second.
   *
   * The DEBT is the part that matters. Overrun is carried forward and worked off,
   * so a frame that spent 30 ms bakes nothing for the next 30 ms of frames. It
   * cannot make an individual bake shorter - only the worker pool does that - but
   * it stops bakes landing back to back, and back-to-back is what reads as judder.
   *
   * The first job is always admitted when there is no debt, so the horizon still
   * fills and a stationary player is unaffected.
   */
  _drain(costBudget, maxJobs, msBudget = BAKE_MS_PER_FRAME) {
    let cost = 0;
    let jobs = 0;
    // Work off any overrun carried from previous frames before baking again.
    if (msBudget !== Infinity && this._bakeDebtMs > 0) {
      this._bakeDebtMs = Math.max(0, this._bakeDebtMs - msBudget);
      this.stats.bakesThisFrame = 0;
      return;
    }
    const t0 = performance.now();
    while (this.queue.length > 0 && cost < costBudget && jobs < maxJobs) {
      const job = this.queue.shift();
      this.queued.delete(job.key);
      cost += this._vertexCountFor(job.lod) / this._lod0Vertices;
      jobs++;
      this._dispatchInline(job);
      // Checked AFTER the first bake so progress is always made.
      if (performance.now() - t0 >= msBudget) break;
    }
    const spent = performance.now() - t0;
    if (msBudget !== Infinity && spent > msBudget) {
      this._bakeDebtMs = Math.min(BAKE_DEBT_MAX_MS, spent - msBudget);
    }
    this.stats.bakesThisFrame = jobs;
  }

  /**
   * Bake one chunk on the calling thread and upload it immediately.
   *
   * The fallback for a pool that could not be built or has died, and the path
   * Node takes - which is what keeps the offline suites' synchronous
   * `while (stats.queued > 0) update()` loops terminating.
   */
  _dispatchInline(job) {
    const data = this.terrain.bakeChunk(job.cx, job.cz, job.lod);
    this.terrain.interleaveChunk(data, this._stagingF32, this._stagingU8);
    this._onBaked(job, {
      vertexCount: data.vertexCount,
      indexCount: data.indexCount,
      triangleCount: data.triangleCount,
      aabb: data.aabb,
      skirtDepth: data.skirtDepth,
      bakeMs: data.bakeMs,
      offThread: false,
      vbSource: this._staging,
      vbOffset: 0,
      vbBytes: data.vertexCount * this.terrain.VERTEX_STRIDE,
      ibSource: data.indices.buffer,
      ibOffset: data.indices.byteOffset,
      ibBytes: data.indices.byteLength,
    });
  }

  /**
   * Upload finished meshes until the time budget or the hard cap is spent.
   *
   * Unlike a bake, an upload is divisible EXACTLY: it is a per-chunk 0.02 ms
   * operation, so a budget can stop between any two of them and whatever does
   * not fit is already baked and simply waits a frame.
   */
  _drainUploads(msBudget) {
    this.stats.uploadsThisFrame = 0;
    if (this._completed.length === 0) { this.stats.uploadMsLast = 0; return; }
    const t0 = performance.now();
    let n = 0;
    while (this._completed.length > 0 && n < this.maxUploadsPerFrame) {
      const done = this._completed.shift();
      n++;
      const msg = done.msg;
      this._onBaked(done.job, {
        vertexCount: msg.vertexCount,
        indexCount: msg.indexCount,
        triangleCount: msg.triangleCount,
        aabb: msg.aabb,
        skirtDepth: msg.skirtDepth,
        bakeMs: msg.bakeMs,
        offThread: true,
        vbSource: msg.buf,
        vbOffset: 0,
        vbBytes: msg.vbBytes,
        ibSource: msg.buf,
        ibOffset: msg.vbBytes,
        ibBytes: msg.ibBytes,
      });
      this._recycle(done.slot, msg.buf);
      // Checked AFTER the first upload so progress is always made.
      if (performance.now() - t0 >= msBudget) break;
    }
    const spent = performance.now() - t0;
    this.stats.uploadsThisFrame = n;
    this.stats.uploadMsLast = spent;
    if (spent > this.stats.uploadMsPeak) this.stats.uploadMsPeak = spent;
  }

  /**
   * Upload a finished mesh and publish the chunk.
   *
   * `mesh` is normalised so the worker and the inline path share this code: the
   * vertex and index bytes arrive as (ArrayBuffer, byte offset, byte length),
   * which is all writeBuffer needs and is the one shape both a transferred
   * packed buffer and the inline staging buffer can present.
   */
  _onBaked(job, mesh) {
    if (this._destroyed) return;
    // Superseded by a newer job for this key, or orphaned by _unload while the
    // bake was in flight. Publishing it would resurrect a chunk outside the
    // residency radius and leak its GPU buffers, silently.
    if (job.seq !== this._seq.get(job.key)) { this._forgetPending(job); return; }
    this._forgetPending(job);
    this._seq.delete(job.key);
    const device = this.device;

    let chunk = this.chunks.get(job.key);
    if (chunk) {
      // LOD change: release the old buffers before claiming new ones so the
      // pool can hand the same allocation straight back when sizes match.
      this._forgetTotals(chunk);
      this._releaseBuffers(chunk);
    } else {
      chunk = {
        key: job.key, cx: job.cx, cz: job.cz,
        originX: job.cx * CHUNK_SIZE, originZ: job.cz * CHUNK_SIZE,
        keep: false,
      };
      this.chunks.set(job.key, chunk);
    }

    chunk.lod = job.lod;
    chunk.vertexCount = mesh.vertexCount;
    chunk.indexCount = mesh.indexCount;
    chunk.triangleCount = mesh.triangleCount;
    chunk.aabb = mesh.aabb;
    chunk.skirtDepth = mesh.skirtDepth;
    chunk.vertexBytes = mesh.vbBytes;
    chunk.indexBytes = mesh.ibBytes;
    chunk.vertexBuffer = this._acquire(this._vertexPool, mesh.vbBytes, BufferUsage.VERTEX, 'chunk.vb');
    chunk.indexBuffer = this._acquire(this._indexPool, mesh.ibBytes, BufferUsage.INDEX, 'chunk.ib');

    device.queue.writeBuffer(chunk.vertexBuffer, 0, mesh.vbSource, mesh.vbOffset, mesh.vbBytes);
    device.queue.writeBuffer(chunk.indexBuffer, 0, mesh.ibSource, mesh.ibOffset, mesh.ibBytes);

    this._triangles += chunk.triangleCount;
    this._gpuBytes += mesh.vbBytes + mesh.ibBytes;

    if (mesh.offThread) {
      this._workerBakeMsAccum += mesh.bakeMs;
      this._workerBakeCount++;
      this.stats.workerBakeMsLast = mesh.bakeMs;
      this.stats.workerBakeMsAvg = this._workerBakeMsAccum / this._workerBakeCount;
      if (mesh.bakeMs > this.stats.workerBakeMsPeak) this.stats.workerBakeMsPeak = mesh.bakeMs;
    } else {
      this._bakeMsAccum += mesh.bakeMs;
      this._bakeCount++;
      this.stats.bakeMsLast = mesh.bakeMs;
      this.stats.bakeMsAvg = this._bakeMsAccum / this._bakeCount;
      if (mesh.bakeMs > this.stats.bakeMsPeak) this.stats.bakeMsPeak = mesh.bakeMs;
    }

    events.emit(EVENTS.CHUNK_LOADED, { cx: job.cx, cz: job.cz, lod: job.lod });
  }

  /** Drop a job's claim on its key, but only if it still owns it: a superseded
   *  job must not evict the newer one that replaced it. */
  _forgetPending(job) {
    if (this._pending.get(job.key) === job) this._pending.delete(job.key);
  }

  _forgetTotals(chunk) {
    this._triangles -= chunk.triangleCount || 0;
    this._gpuBytes -= (chunk.vertexBytes || 0) + (chunk.indexBytes || 0);
  }

  _unload(chunk) {
    this._forgetTotals(chunk);
    this._releaseBuffers(chunk);
    this.chunks.delete(chunk.key);
    // A bake still in flight for this key now compares its stamp against
    // `undefined`, is dropped on arrival, and cannot resurrect the chunk.
    this._seq.delete(chunk.key);
    events.emit(EVENTS.CHUNK_UNLOADED, { cx: chunk.cx, cz: chunk.cz });
  }

  // -------------------------------------------------------------------------
  // Buffer pool
  // -------------------------------------------------------------------------
  //
  // Keyed by EXACT byte length, which sounds naive and is not: chunk sizes are
  // fully determined by the LOD, so there are only LOD_RINGS distinct sizes in
  // the whole system and every free buffer is an exact fit for the next chunk
  // that enters the same ring. Rounding up to power-of-two buckets would waste
  // up to 45% of the vertex memory for no reuse benefit at all.

  _acquire(pool, bytes, usage, label) {
    const free = pool.get(bytes);
    if (free && free.length > 0) {
      this._pooledCount--;
      this._pooledBytes -= bytes;
      return free.pop();
    }
    return createBuffer(this.device, {
      label: `${label}.${bytes}`,
      size: bytes,
      usage: usage | BufferUsage.COPY_DST,
    });
  }

  _release(pool, bytes, buffer) {
    let free = pool.get(bytes);
    if (!free) { free = []; pool.set(bytes, free); }
    free.push(buffer);
    this._pooledCount++;
    this._pooledBytes += bytes;
  }

  _releaseBuffers(chunk) {
    if (chunk.vertexBuffer) {
      this._release(this._vertexPool, chunk.vertexBytes, chunk.vertexBuffer);
      chunk.vertexBuffer = null;
    }
    if (chunk.indexBuffer) {
      this._release(this._indexPool, chunk.indexBytes, chunk.indexBuffer);
      chunk.indexBuffer = null;
    }
  }

  /** Destroy pooled buffers above `keepPerSize`. Call on a memory-pressure hint. */
  trimPool(keepPerSize = 2) {
    for (const pool of [this._vertexPool, this._indexPool]) {
      for (const [bytes, free] of pool) {
        while (free.length > keepPerSize) {
          free.pop().destroy();
          this._pooledCount--;
          this._pooledBytes -= bytes;
        }
      }
    }
    this._updateStats();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /**
   * Chunks whose ABSOLUTE bounding box survives the frustum test, sorted front
   * to back so the depth buffer rejects the far ones cheaply.
   *
   * Returns a REUSED array - copy it if you need it to outlive the frame.
   */
  visibleChunks(camera = this.camera) {
    const out = this._visible;
    out.length = 0;
    let tris = 0;
    const px = camera.position[0], pz = camera.position[2];
    for (const chunk of this.chunks.values()) {
      if (!chunk.vertexBuffer) continue;
      const b = chunk.aabb;
      if (!camera.isBoxVisible(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ)) continue;
      const cxm = chunk.originX + CHUNK_SIZE * 0.5 - px;
      const czm = chunk.originZ + CHUNK_SIZE * 0.5 - pz;
      chunk.sortKey = cxm * cxm + czm * czm;
      out.push(chunk);
      tris += chunk.triangleCount;
    }
    out.sort((a, b) => a.sortKey - b.sortKey);
    this.stats.visible = out.length;
    this.stats.visibleTriangles = tris;
    return out;
  }

  /** Loaded chunk covering a world position, or undefined. */
  chunkAt(x, z) {
    return this.chunks.get(ChunkManager.key(
      Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)));
  }

  /**
   * Publish the streaming counters.
   *
   * `queued`, `inFlight` and `pendingUploads` are three DISJOINT counts of work
   * that is not on the GPU yet: not started, being baked, and baked but not
   * uploaded. `queued` keeps its old meaning - the queue has work - because the
   * offline suites drive `while (stats.queued > 0)` loops on it and the debug
   * overlay reads it; anything that has to know whether the ground under a point
   * is finished must add all three (see the scatter pass).
   */
  _updateStats() {
    this.stats.loaded = this.chunks.size;
    this.stats.queued = this.queue.length;
    this.stats.inFlight = this._busyWorkers;
    this.stats.pendingUploads = this._completed.length;
    this.stats.triangles = this._triangles;
    this.stats.gpuBytes = this._gpuBytes;
    this.stats.pooledBuffers = this._pooledCount;
    this.stats.pooledBytes = this._pooledBytes;
    this.stats.workerCount = this._readyWorkers;
  }

  destroy() {
    this._destroyed = true;
    for (const slot of this._workers) {
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = 0; }
      try { slot.w.terminate(); } catch { /* already gone */ }
      this._settle(slot);
    }
    this._workers.length = 0;
    this._readyWorkers = 0;
    this._busyWorkers = 0;
    this._completed.length = 0;
    this._pending.clear();
    this._seq.clear();
    this._wake();
    for (const chunk of this.chunks.values()) {
      chunk.vertexBuffer?.destroy();
      chunk.indexBuffer?.destroy();
    }
    this.chunks.clear();
    for (const pool of [this._vertexPool, this._indexPool]) {
      for (const free of pool.values()) for (const b of free) b.destroy();
      pool.clear();
    }
    this._pooledCount = 0;
    this._pooledBytes = 0;
    this._triangles = 0;
    this._gpuBytes = 0;
    this.queue.length = 0;
    this.queued.clear();
    this._updateStats();
  }
}
