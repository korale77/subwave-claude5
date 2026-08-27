/**
 * SUBWAVE cave streaming.
 *
 * Streams marching-cubes cave chunks (world/caves.js, 32 m cubes, 3-D
 * addresses) around the camera, the way world/chunks.js streams the 2-D
 * heightfield clipmap. Deliberately much simpler than ChunkManager, because
 * the problem is smaller on every axis: no LOD (DESIGN/02 8.6 - at a 120-220 m
 * draw distance and ~10k tris a chunk, caves never LOD), a radius of
 * CAVE_STREAM_RADIUS instead of 4 km, and a population where the overwhelming
 * majority of probed addresses contain NOTHING - the field's occupancy test
 * rejects them in ~28 us inside the worker and the emptiness is cached here
 * FOREVER, because a chunk is a pure function of (address, seed).
 *
 * WHERE THE WORK HAPPENS. All baking is off-thread (cave_worker.js; the
 * inline path exists for Node and for a dead pool, exactly like the terrain
 * streamer's). One bake is 14-75 ms measured, so the inline fallback admits at
 * most one per update and the game visibly under-streams caves rather than
 * stuttering - the same trade chunks.js makes, taken harder because cave
 * geometry is optional scenery until the player is inside it.
 *
 * THE MOUTH REGISTRY. The terrain pass cannot know where the volumetric layer
 * has carved the seabed open - that is the heightfield's one-surface-per-column
 * blindness - so this manager also publishes the CAVE MOUTH DISCS near the
 * camera (position, surface height, discard radius). pass/terrain.wgsl
 * discards its fragments inside those discs (the masked pipeline), and the
 * cave mesh's own kept surface copy backs the hole; see world/cave_mesh.js for
 * why over-covering is safe and under-covering is not. Same stamp/lifecycle
 * discipline as chunks.js: one monotonic `seq` per job, checked on arrival,
 * so a rescan cannot double-bake and an unload cannot be resurrected.
 */

import { WORLD, STREAMING } from '../core/constants.js';
import { BufferUsage, createBuffer } from '../core/resources.js';
import { caveSkeleton, CAVE_MACRO_SIZE, CAVE_SKIRT, CAVE_CELL } from './caves.js';
import { bakeCaveChunk, mouthDiscRadius } from './cave_mesh.js';
import * as terrainModule from './terrain.js';

const CHUNK = WORLD.CAVE_CHUNK_SIZE;

/** Streaming radius, metres. DESIGN/02 8.2 quotes 90-220 by tier; one value
 *  here, chosen against the deep water's own sight range (140 m cluster far
 *  plane submerged) - geometry past it is fog. */
const CAVE_STREAM_RADIUS = 128;
/** Vertical half-extent of the streamed slab, metres. A PROCEDURAL mouth
 *  shaft is at most ~54 m of drop and a chamber 48 m across. The AUTHORED
 *  Jellyshroom corridor (world/cave_sites.js) drops 78 m mouth-to-hall and
 *  its hall is 44 m tall, which this slab covers only by chunk granularity
 *  (the 2026-08-18 review measured the stated margin consumed: from the
 *  arrival eye the floor row is exactly the last row inside the slab). A
 *  future authored site that descends further than ~90 m from any eye
 *  position on its route must RAISE this, or its far end silently unmeshes
 *  into open water. */
const CAVE_STREAM_HEIGHT = 96;
/** Metres of camera travel before the desired set is recomputed. */
const RESCAN_DISTANCE = 10;
/** Chunks kept beyond the radius before they are dropped. */
const UNLOAD_MARGIN = 1.3;
/** Hard cap on resident chunks (DESIGN/02 table 8.2 Ultra). */
const MAX_RESIDENT = 96;
/** Uploads admitted per frame; each is two writeBuffer calls, ~0.05 ms. */
const MAX_UPLOADS_PER_FRAME = 4;
/** Known-empty address cache cap; clearing only costs re-probes. */
const EMPTY_CACHE_MAX = 40000;
/** Cold macro cells scanned for mouths per update (0.02-0.28 ms each). */
const MOUTH_CELLS_PER_UPDATE = 8;
/** Mouth discs are published within this range of the camera. */
const MOUTH_RANGE = 320;

/** Pack a 3-D chunk address into one integer. 10 signed bits per axis covers
 *  |c| < 512, i.e. 16.4 km of world per axis - four times the hard boundary. */
function key3(cx, cy, cz) {
  return ((cx & 0x3ff) << 20) | ((cy & 0x3ff) << 10) | (cz & 0x3ff);
}

export class CaveChunkManager {
  /**
   * @param {GPUDevice|null} device null in offline tests: geometry is baked
   *   and accounted but never uploaded.
   * @param {import('../render/camera.js').Camera|{position: ArrayLike<number>}} camera
   * @param {{workers?: number}} [opts] 0 forces the inline path (tests).
   */
  constructor(device, camera, opts = {}) {
    this.device = device;
    this.camera = camera;

    /** @type {Map<number, object>} resident chunks with GPU buffers. */
    this.chunks = new Map();
    /** @type {Set<number>} addresses proven to hold no cave geometry. */
    this._empty = new Set();
    this.queue = [];
    this.queued = new Set();
    this._pending = new Map();
    this._completed = [];
    this._seq = new Map();
    this._seqNext = 1;

    this._lastScanX = Infinity;
    this._lastScanY = Infinity;
    this._lastScanZ = Infinity;
    this._visible = [];

    // Mouth registry: per macro cell (XZ column x vertical band), the discs it
    // contributes. Cells are scanned cold at a bounded rate; `null` marks a
    // cell queued but not yet scanned.
    this._mouthCells = new Map();
    this._mouthScanQueue = [];
    /** Flat active disc list [x, z, surfaceY, discardR] near the camera. */
    this._activeDiscs = [];
    this._discsDirty = true;

    this.stats = {
      loaded: 0, queued: 0, inFlight: 0, pendingUploads: 0, visible: 0,
      triangles: 0, culledTriangles: 0, gpuBytes: 0, emptyKnown: 0,
      workerBakeMsLast: 0, workerBakeMsAvg: 0, workerBakeMsPeak: 0,
      uploadsThisFrame: 0, mouthDiscs: 0, workerCount: 0,
    };
    this._bakeMsAccum = 0;
    this._bakeCount = 0;
    this._triangles = 0;
    this._gpuBytes = 0;
    this._destroyed = false;

    this._workers = [];
    this._readyWorkers = 0;
    this._busyWorkers = 0;
    this._poolReady = this._initWorkers(opts);
  }

  get poolReady() { return this._poolReady; }

  // -------------------------------------------------------------------------
  // Worker pool (one worker; the cave stream is not bake-bound in practice)
  // -------------------------------------------------------------------------

  _initWorkers(opts) {
    const explicit = opts && opts.workers !== undefined;
    if (explicit && (opts.workers | 0) <= 0) return Promise.resolve();
    if (typeof Worker !== 'function') return Promise.resolve();

    const want = explicit ? (opts.workers | 0) : 1;
    const url = new URL('./cave_worker.js', import.meta.url);
    const seed = terrainModule.getSeed();
    const handshakes = [];
    for (let i = 0; i < want; i++) {
      let w;
      try {
        w = new Worker(url, { type: 'module' });
      } catch (e) {
        console.warn('[caves] cave worker unavailable, baking inline:', e.message);
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
    return Promise.all(handshakes);
  }

  _onWorkerMessage(slot, msg) {
    if (msg.t === 'ready') {
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = 0; }
      if (!slot.ready) { slot.ready = true; this._readyWorkers++; }
      this._settle(slot);
      return;
    }
    if (msg.t !== 'baked' && msg.t !== 'error') return;
    const job = slot.job;
    if (job) { slot.job = null; this._busyWorkers--; }

    if (msg.t === 'error') {
      console.error('[caves] cave bake failed at', msg.key, msg.message);
      if (job) this._forgetPending(job);
      this._fill(slot);
      return;
    }

    if (!job || this._destroyed || job.seq !== this._seq.get(job.key)) {
      if (job) this._forgetPending(job);
      this._recycle(slot, msg.buf);
    } else if (msg.empty) {
      this._forgetPending(job);
      this._seq.delete(job.key);
      this._rememberEmpty(job.key);
    } else {
      this._completed.push({ job, msg, slot });
    }
    this._fill(slot);
  }

  _fill(slot) {
    if (this._destroyed || !slot.ready || slot.job || this.queue.length === 0) return;
    const job = this.queue.shift();
    this.queued.delete(job.key);
    this._pending.set(job.key, job);
    slot.job = job;
    this._busyWorkers++;
    slot.w.postMessage({ t: 'bake', key: job.key, cx: job.cx, cy: job.cy, cz: job.cz, seq: job.seq });
  }

  _dispatchAll() {
    for (const slot of this._workers) {
      if (slot.ready && !slot.job && this.queue.length > 0) this._fill(slot);
    }
  }

  _recycle(slot, buf) {
    if (!slot || !slot.ready || !buf || buf.byteLength === 0) return;
    slot.w.postMessage({ t: 'recycle', buf }, [buf]);
  }

  _retireWorker(slot, why) {
    const i = this._workers.indexOf(slot);
    if (i < 0) return;
    this._workers.splice(i, 1);
    if (slot.ready) this._readyWorkers--;
    slot.ready = false;
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = 0; }
    try { slot.w.terminate(); } catch { /* already gone */ }
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
    if (!this._destroyed) console.warn('[caves] cave worker retired:', why);
    this._settle(slot);
  }

  _settle(slot) {
    const resolve = slot.resolve;
    if (resolve) { slot.resolve = null; resolve(); }
  }

  // -------------------------------------------------------------------------
  // Streaming
  // -------------------------------------------------------------------------

  /**
   * Per-frame step: rescan on travel, keep the worker fed, upload what has
   * landed, advance the mouth scan. Cheap when the camera has not moved.
   * @param {ArrayLike<number>} cameraPos absolute world position
   */
  update(cameraPos) {
    if (this._destroyed) return;
    const x = cameraPos[0], y = cameraPos[1], z = cameraPos[2];
    const dx = x - this._lastScanX, dy = y - this._lastScanY, dz = z - this._lastScanZ;
    if (dx * dx + dy * dy + dz * dz > RESCAN_DISTANCE * RESCAN_DISTANCE) {
      this._rescan(x, y, z);
    }
    if (this._readyWorkers > 0) this._dispatchAll();
    else if (this._workers.length === 0) this._drainInline();
    this._drainUploads();
    this._scanMouthCells();
    this._updateStats();
  }

  _rescan(camX, camY, camZ) {
    this._lastScanX = camX;
    this._lastScanY = camY;
    this._lastScanZ = camZ;
    this._discsDirty = true;

    // The vertical slab the scan covers, clamped to the band the field is
    // defined over - outside it generateCaveChunk can only return null.
    const y0 = Math.max(WORLD.CAVE_MIN_Y, camY - CAVE_STREAM_HEIGHT);
    const y1 = Math.min(WORLD.CAVE_MAX_Y, camY + CAVE_STREAM_HEIGHT);
    if (y0 > y1 + CHUNK) { this._unloadBeyond(camX, camY, camZ); return; }

    const c0x = Math.floor((camX - CAVE_STREAM_RADIUS) / CHUNK);
    const c1x = Math.floor((camX + CAVE_STREAM_RADIUS) / CHUNK);
    const c0z = Math.floor((camZ - CAVE_STREAM_RADIUS) / CHUNK);
    const c1z = Math.floor((camZ + CAVE_STREAM_RADIUS) / CHUNK);
    const c0y = Math.floor(y0 / CHUNK);
    const c1y = Math.floor(y1 / CHUNK);
    const r2 = CAVE_STREAM_RADIUS * CAVE_STREAM_RADIUS;

    for (const key of this.queued) this._seq.delete(key);
    this.queue.length = 0;
    this.queued.clear();

    for (let cz = c0z; cz <= c1z; cz++) {
      const zc = (cz + 0.5) * CHUNK - camZ;
      for (let cx = c0x; cx <= c1x; cx++) {
        const xc = (cx + 0.5) * CHUNK - camX;
        const d2 = xc * xc + zc * zc;
        if (d2 > r2) continue;
        for (let cy = c0y; cy <= c1y; cy++) {
          const key = key3(cx, cy, cz);
          if (this._empty.has(key)) continue;
          const existing = this.chunks.get(key);
          if (existing) { existing.keep = true; continue; }
          if (this._pending.has(key) || this.queued.has(key)) continue;
          const yc = (cy + 0.5) * CHUNK - camY;
          const seq = this._seqNext++;
          this._seq.set(key, seq);
          this.queued.add(key);
          this.queue.push({ key, cx, cy, cz, dist: d2 + yc * yc, seq });
        }
      }
    }
    this.queue.sort((a, b) => a.dist - b.dist);

    const room = MAX_RESIDENT - this.chunks.size - this._pending.size;
    if (this.queue.length > Math.max(0, room)) {
      for (let i = Math.max(0, room); i < this.queue.length; i++) {
        this.queued.delete(this.queue[i].key);
        this._seq.delete(this.queue[i].key);
      }
      this.queue.length = Math.max(0, room);
    }

    this._unloadBeyond(camX, camY, camZ);

    // Queue the macro cells around the camera for the mouth registry. The
    // whole vertical band, because a mouth's OWNING cell is the one holding
    // its below-surface start point, not the one its shaft opens through.
    const mr = MOUTH_RANGE;
    const mx0 = Math.floor((camX - mr) / CAVE_MACRO_SIZE);
    const mx1 = Math.floor((camX + mr) / CAVE_MACRO_SIZE);
    const mz0 = Math.floor((camZ - mr) / CAVE_MACRO_SIZE);
    const mz1 = Math.floor((camZ + mr) / CAVE_MACRO_SIZE);
    const my0 = Math.floor(WORLD.CAVE_MIN_Y / CAVE_MACRO_SIZE);
    const my1 = Math.floor(WORLD.CAVE_MAX_Y / CAVE_MACRO_SIZE);
    for (let mz = mz0; mz <= mz1; mz++) {
      for (let mx = mx0; mx <= mx1; mx++) {
        for (let my = my0; my <= my1; my++) {
          const mk = `${mx},${my},${mz}`;
          if (!this._mouthCells.has(mk)) {
            this._mouthCells.set(mk, null);
            this._mouthScanQueue.push([mx, my, mz, mk]);
          }
        }
      }
    }
  }

  _unloadBeyond(camX, camY, camZ) {
    const ur = CAVE_STREAM_RADIUS * UNLOAD_MARGIN;
    const ur2 = ur * ur;
    for (const chunk of this.chunks.values()) {
      if (chunk.keep) { chunk.keep = false; continue; }
      const dx = (chunk.cx + 0.5) * CHUNK - camX;
      const dy = (chunk.cy + 0.5) * CHUNK - camY;
      const dz = (chunk.cz + 0.5) * CHUNK - camZ;
      if (dx * dx + dz * dz > ur2 ||
          Math.abs(dy) > CAVE_STREAM_HEIGHT * UNLOAD_MARGIN + CHUNK) {
        this._unload(chunk);
      }
    }
  }

  /** INLINE FALLBACK: one bake per update, 14-75 ms each. Node's path; in the
   *  browser it only runs if the worker died, where slow streaming beats a
   *  nine-frame stall per chunk. */
  _drainInline() {
    if (this.queue.length === 0) return;
    const job = this.queue.shift();
    this.queued.delete(job.key);
    if (job.seq !== this._seq.get(job.key)) return;
    const baked = bakeCaveChunk(job.cx, job.cy, job.cz);
    if (!baked) {
      this._seq.delete(job.key);
      this._rememberEmpty(job.key);
      return;
    }
    this._publish(job, baked);
  }

  _drainUploads() {
    this.stats.uploadsThisFrame = 0;
    let n = 0;
    while (this._completed.length > 0 && n < MAX_UPLOADS_PER_FRAME) {
      const done = this._completed.shift();
      n++;
      this._publish(done.job, done.msg);
      this._recycle(done.slot, done.msg.buf);
    }
    this.stats.uploadsThisFrame = n;
  }

  _publish(job, baked) {
    if (this._destroyed) return;
    if (job.seq !== this._seq.get(job.key)) { this._forgetPending(job); return; }
    this._forgetPending(job);
    this._seq.delete(job.key);

    const chunk = {
      key: job.key, cx: job.cx, cy: job.cy, cz: job.cz, keep: false,
      vertexCount: baked.vertexCount,
      indexCount: baked.indexCount,
      triangleCount: baked.triangleCount,
      aabb: baked.aabb,
      grottoFraction: baked.grottoFraction,
      vertexBytes: baked.vbBytes,
      indexBytes: baked.ibBytes,
      // Geode spar instances (world/cave_mesh.js SPAR block): count, the
      // per-variant partition (sorted at bake time, one instanced range per
      // variant) and the GPU bytes. Zero/null outside the Geode band.
      sparCount: baked.sparCount || 0,
      sparCounts: baked.sparCounts || null,
      sparBytes: baked.sparBytes || 0,
      // Authored-site prop instances (world/cave_mesh.js CAVE PROP block):
      // jellyshrooms and speleothems, same packed layout as the spar, drawn
      // by the same pass off their own library. Zero/null away from any
      // authored site.
      propCount: baked.propCount || 0,
      propCounts: baked.propCounts || null,
      propBytes: baked.propBytes || 0,
      // The LATTICE origin, not the chunk corner: packed vertex positions are
      // relative to generateCaveChunk's `mesh.origin`, which sits one skirt
      // cell outside the 32 m cube on every axis.
      originX: job.cx * CHUNK - CAVE_SKIRT * CAVE_CELL,
      originY: job.cy * CHUNK - CAVE_SKIRT * CAVE_CELL,
      originZ: job.cz * CHUNK - CAVE_SKIRT * CAVE_CELL,
      vertexBuffer: null, indexBuffer: null, sparBuffer: null, propBuffer: null,
    };

    if (this.device) {
      chunk.vertexBuffer = createBuffer(this.device, {
        label: `cave.vb.${baked.vbBytes}`,
        size: baked.vbBytes,
        usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      });
      chunk.indexBuffer = createBuffer(this.device, {
        label: `cave.ib.${baked.ibBytes}`,
        size: baked.ibBytes,
        usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(chunk.vertexBuffer, 0, baked.buf, 0, baked.vbBytes);
      this.device.queue.writeBuffer(chunk.indexBuffer, 0, baked.buf, baked.vbBytes, baked.ibBytes);
      if (chunk.sparCount > 0) {
        chunk.sparBuffer = createBuffer(this.device, {
          label: `cave.spar.${chunk.sparBytes}`,
          size: chunk.sparBytes,
          usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(chunk.sparBuffer, 0, baked.buf,
          baked.vbBytes + baked.ibBytes, chunk.sparBytes);
      }
      if (chunk.propCount > 0) {
        chunk.propBuffer = createBuffer(this.device, {
          label: `cave.prop.${chunk.propBytes}`,
          size: chunk.propBytes,
          usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(chunk.propBuffer, 0, baked.buf,
          baked.vbBytes + baked.ibBytes + chunk.sparBytes, chunk.propBytes);
      }
    }

    const old = this.chunks.get(job.key);
    if (old) this._unload(old);
    this.chunks.set(job.key, chunk);
    this._triangles += chunk.triangleCount;
    this._gpuBytes += baked.vbBytes + baked.ibBytes + chunk.sparBytes + chunk.propBytes;
    this.stats.culledTriangles += baked.culledTriangles || 0;

    this._bakeMsAccum += baked.bakeMs || 0;
    this._bakeCount++;
    this.stats.workerBakeMsLast = baked.bakeMs || 0;
    this.stats.workerBakeMsAvg = this._bakeMsAccum / this._bakeCount;
    if ((baked.bakeMs || 0) > this.stats.workerBakeMsPeak) {
      this.stats.workerBakeMsPeak = baked.bakeMs;
    }
  }

  _unload(chunk) {
    this._triangles -= chunk.triangleCount || 0;
    this._gpuBytes -= (chunk.vertexBytes || 0) + (chunk.indexBytes || 0) +
      (chunk.sparBytes || 0) + (chunk.propBytes || 0);
    chunk.vertexBuffer?.destroy();
    chunk.indexBuffer?.destroy();
    chunk.sparBuffer?.destroy();
    chunk.propBuffer?.destroy();
    this.chunks.delete(chunk.key);
    this._seq.delete(chunk.key);
  }

  _forgetPending(job) {
    if (this._pending.get(job.key) === job) this._pending.delete(job.key);
  }

  _rememberEmpty(key) {
    if (this._empty.size >= EMPTY_CACHE_MAX) this._empty.clear();
    this._empty.add(key);
  }

  // -------------------------------------------------------------------------
  // Mouth registry
  // -------------------------------------------------------------------------

  _scanMouthCells() {
    let budget = MOUTH_CELLS_PER_UPDATE;
    while (budget-- > 0 && this._mouthScanQueue.length > 0) {
      const [mx, my, mz, mk] = this._mouthScanQueue.shift();
      const sk = caveSkeleton(mx, my, mz);
      let discs = null;
      for (let m = 0; m < sk.mouthCount; m++) {
        const x = sk.mouths[m * 3], z = sk.mouths[m * 3 + 2];
        // The disc sits at the SURFACE the shaft opens through, which is the
        // heightfield above the start point, not the start point itself.
        const h = terrainModule.sampleHeight(x, z);
        (discs ??= []).push(x, z, h, mouthDiscRadius(sk.mouthRadius[m]));
      }
      this._mouthCells.set(mk, discs || []);
      if (discs) this._discsDirty = true;
    }
  }

  /**
   * The cave-mouth discs the terrain pass must discard inside, nearest first,
   * as a flat [x, z, surfaceY, radius] array. Rebuilt lazily on rescan or when
   * a cold cell scan finds new mouths.
   * @param {number} maxDiscs cap (the shader-side array size)
   */
  activeMouthDiscs(maxDiscs = 16) {
    if (!this._discsDirty) return this._activeDiscs;
    this._discsDirty = false;
    const camX = this._lastScanX, camZ = this._lastScanZ;
    const all = [];
    for (const discs of this._mouthCells.values()) {
      if (!discs) continue;
      for (let i = 0; i < discs.length; i += 4) {
        const dx = discs[i] - camX, dz = discs[i + 1] - camZ;
        const d2 = dx * dx + dz * dz;
        if (d2 < MOUTH_RANGE * MOUTH_RANGE) {
          all.push({ d2, x: discs[i], z: discs[i + 1], y: discs[i + 2], r: discs[i + 3] });
        }
      }
    }
    all.sort((a, b) => a.d2 - b.d2);
    const out = this._activeDiscs;
    out.length = 0;
    for (let i = 0; i < Math.min(all.length, maxDiscs); i++) {
      out.push(all[i].x, all[i].z, all[i].y, all[i].r);
    }
    this.stats.mouthDiscs = out.length / 4;
    return out;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /** Chunks whose absolute AABB survives the frustum test. Reused array. */
  visibleChunks(camera = this.camera) {
    const out = this._visible;
    out.length = 0;
    for (const chunk of this.chunks.values()) {
      if (!chunk.vertexBuffer) continue;
      const b = chunk.aabb;
      if (!camera.isBoxVisible(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ)) continue;
      out.push(chunk);
    }
    this.stats.visible = out.length;
    return out;
  }

  _updateStats() {
    this.stats.loaded = this.chunks.size;
    this.stats.queued = this.queue.length;
    this.stats.inFlight = this._busyWorkers;
    this.stats.pendingUploads = this._completed.length;
    this.stats.triangles = this._triangles;
    this.stats.gpuBytes = this._gpuBytes;
    this.stats.emptyKnown = this._empty.size;
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
    for (const chunk of this.chunks.values()) {
      chunk.vertexBuffer?.destroy();
      chunk.indexBuffer?.destroy();
      chunk.sparBuffer?.destroy();
      chunk.propBuffer?.destroy();
    }
    this.chunks.clear();
    this.queue.length = 0;
    this.queued.clear();
    this._updateStats();
  }
}
