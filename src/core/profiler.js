/**
 * SUBWAVE profiler.
 *
 * CPU section timers plus GPU timestamp queries (when the adapter exposes the
 * 'timestamp-query' feature). GPU results arrive one to three frames late, so
 * every pass keeps a small ring of resolved samples and reports a moving
 * average.
 *
 * THE CPU TIMERS AND THE GPU SCOPES ARE NOT THE SAME KIND OF NUMBER. A CPU
 * section is a real wall-clock interval on one thread. A GPU scope is a
 * begin-to-end delta on a pipelined timeline that also bills whatever idle and
 * whatever other scopes overlap it, and on this machine those deltas are not a
 * cost of any kind - not absolute, not a delta, not even a ranking. Read
 * `gpuTotal`'s docstring before quoting a single GPU figure out of here.
 *
 * Usage:
 *   profiler.beginFrame();
 *   profiler.cpu('sim'); ...work...; profiler.cpuEnd('sim');
 *   const pass = encoder.beginRenderPass(profiler.gpuPass(desc, 'terrain'));
 *   profiler.endFrame(device);
 */

/**
 * Timestamped GPU scopes per frame. Scopes past this cap silently get no
 * timestamps, and gpuBreakdown() keeps reporting their LAST resolved average -
 * so the overrun does not look like an overrun, it looks like a stale number.
 * The frame requested 34 scopes before the shadow cascades and 38 after, and at
 * 32 the tail (tonemap, lens, hud, present) was being reported from history.
 * 64 costs 1 KB of query buffer.
 */
const MAX_GPU_SCOPES = 64;
const RING = 30;

/**
 * How far the sum of a frame's scope durations may exceed that frame's measured
 * GPU span before the scopes are declared non-additive.
 *
 * The span is the only hard bound there is: every scope begins at or after the
 * first begin and ends at or before the last end, so if the durations really are
 * disjoint their sum cannot exceed it. A couple of percent of slack absorbs the
 * resolution of the timestamp counter itself; anything past that means the
 * intervals overlap and adding them up counts the same nanoseconds many times.
 */
const ADDITIVE_TOLERANCE = 1.02;

class Sample {
  constructor(name) {
    this.name = name;
    this.ring = new Float32Array(RING);
    this.count = 0;
    this.index = 0;
    this.last = 0;
    this.peak = 0;
  }
  push(ms) {
    this.last = ms;
    this.ring[this.index] = ms;
    this.index = (this.index + 1) % RING;
    this.count = Math.min(this.count + 1, RING);
    if (ms > this.peak) this.peak = ms;
  }
  get average() {
    if (this.count === 0) return 0;
    let s = 0;
    for (let i = 0; i < this.count; i++) s += this.ring[i];
    return s / this.count;
  }
  get max() {
    let m = 0;
    for (let i = 0; i < this.count; i++) if (this.ring[i] > m) m = this.ring[i];
    return m;
  }
  decayPeak(rate = 0.98) { this.peak *= rate; }
}

export class Profiler {
  constructor() {
    this.enabled = true;
    /** @type {Map<string, Sample>} */
    this.cpuSamples = new Map();
    /** @type {Map<string, Sample>} */
    this.gpuSamples = new Map();
    this._cpuOpen = new Map();
    this._order = [];

    // GPU timestamp machinery
    this.gpuAvailable = false;
    this.querySet = null;
    this.resolveBuffer = null;
    /** Pool of mapped-readback buffers so we never stall. */
    this._readbackPool = [];
    this._inFlight = 0;
    this._maxInFlight = 3;
    this._scopeNames = [];
    this._scopeCount = 0;
    this.period = 1; // ns per timestamp tick (WebGPU reports nanoseconds)

    /**
     * Per-FRAME aggregates, kept because a per-scope average cannot be summed.
     *
     * `_scopeSum` adds a frame's scope durations up inside that one frame, which
     * is not what summing the per-scope averages does: the shadow cascades are on
     * staggered update intervals 1/1/2/4, so `shadow.c3`'s ring holds only the
     * frames it actually rendered and its average is its cost ON THOSE FRAMES.
     * Adding that into a per-frame total bills it four times over.
     *
     * `_frameSpan` is the first begin to the last end on the GPU timeline. It is
     * a hard upper bound on any disjoint sum and is the quantity the old
     * `gpuTotal` docstring was claiming to report.
     */
    this._scopeSum = new Sample('gpuScopeSum');
    this._frameSpan = new Sample('gpuFrameSpan');

    /**
     * Set the moment a frame asks for more scopes than MAX_GPU_SCOPES.
     *
     * An over-cap scope gets no timestamps at all and its Sample keeps returning
     * its LAST resolved average forever - stable, plausible and meaningless. It
     * shipped that way once at 32 against 34 requested. Latching it here is what
     * lets gpuTotal refuse instead of adding a stale number to a real one.
     */
    this.scopeOverflow = false;

    /** Counters other systems bump each frame. */
    this.counters = Object.create(null);
    this._counterOrder = [];
  }

  /** Allocate the timestamp query resources. Safe to call when unsupported. */
  initGPU(device, adapterHasTimestamp) {
    if (!adapterHasTimestamp) {
      this.gpuAvailable = false;
      return false;
    }
    try {
      this.querySet = device.createQuerySet({
        label: 'profiler-timestamps',
        type: 'timestamp',
        count: MAX_GPU_SCOPES * 2,
      });
      this.resolveBuffer = device.createBuffer({
        label: 'profiler-resolve',
        size: MAX_GPU_SCOPES * 2 * 8,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });
      for (let i = 0; i < this._maxInFlight; i++) {
        this._readbackPool.push({
          buffer: device.createBuffer({
            label: `profiler-readback-${i}`,
            size: MAX_GPU_SCOPES * 2 * 8,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          }),
          busy: false,
        });
      }
      this.gpuAvailable = true;
      return true;
    } catch (err) {
      console.warn('[profiler] timestamp queries unavailable:', err);
      this.gpuAvailable = false;
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Frame lifecycle
  // -------------------------------------------------------------------------

  beginFrame() {
    this._scopeCount = 0;
    this._scopeNames.length = 0;
    for (const k of this._counterOrder) this.counters[k] = 0;
  }

  // -------------------------------------------------------------------------
  // CPU timing
  // -------------------------------------------------------------------------

  cpu(name) {
    if (!this.enabled) return;
    this._cpuOpen.set(name, performance.now());
  }

  cpuEnd(name) {
    if (!this.enabled) return 0;
    const start = this._cpuOpen.get(name);
    if (start === undefined) return 0;
    this._cpuOpen.delete(name);
    const ms = performance.now() - start;
    this._sample(this.cpuSamples, name).push(ms);
    return ms;
  }

  /** Time a synchronous function. */
  measure(name, fn) {
    if (!this.enabled) return fn();
    const t0 = performance.now();
    const r = fn();
    this._sample(this.cpuSamples, name).push(performance.now() - t0);
    return r;
  }

  _sample(map, name) {
    let s = map.get(name);
    if (!s) {
      s = new Sample(name);
      map.set(name, s);
      if (!this._order.includes(name)) this._order.push(name);
    }
    return s;
  }

  // -------------------------------------------------------------------------
  // GPU timing
  // -------------------------------------------------------------------------

  /**
   * Attach timestampWrites to a render/compute pass descriptor.
   * Returns the descriptor (mutated) so it can be used inline.
   */
  gpuPass(descriptor, name) {
    if (!this.enabled || !this.gpuAvailable) return descriptor;
    if (this._scopeCount >= MAX_GPU_SCOPES) {
      if (!this.scopeOverflow) {
        this.scopeOverflow = true;
        console.warn(`[profiler] frame asked for more than ${MAX_GPU_SCOPES} GPU scopes ` +
          `('${name}' and any after it get none). Every GPU number is now stale; raise ` +
          'MAX_GPU_SCOPES.');
      }
      return descriptor;
    }
    const i = this._scopeCount++;
    this._scopeNames.push(name);
    descriptor.timestampWrites = {
      querySet: this.querySet,
      beginningOfPassWriteIndex: i * 2,
      endOfPassWriteIndex: i * 2 + 1,
    };
    return descriptor;
  }

  /** Resolve and asynchronously read back this frame's timestamps. */
  endFrame(device, encoder) {
    if (!this.enabled || !this.gpuAvailable || this._scopeCount === 0) return;
    const slot = this._readbackPool.find((s) => !s.busy);
    if (!slot) return; // all buffers in flight; skip this frame's timings

    const count = this._scopeCount * 2;
    encoder.resolveQuerySet(this.querySet, 0, count, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, slot.buffer, 0, count * 8);

    slot.busy = true;
    const names = this._scopeNames.slice();
    // Read back after this frame's submit lands.
    queueMicrotask(() => {
      slot.buffer.mapAsync(GPUMapMode.READ).then(() => {
        const data = new BigUint64Array(slot.buffer.getMappedRange());
        // The per-frame aggregates have to be built HERE, from one frame's raw
        // timestamps, because neither of them can be recovered from the per-scope
        // rings afterwards - see _scopeSum / _frameSpan.
        let sum = 0, seen = 0;
        let minBegin = 0n, maxEnd = 0n;
        for (let i = 0; i < names.length; i++) {
          const t0 = data[i * 2];
          const t1 = data[i * 2 + 1];
          if (t1 > t0) {
            const ms = Number(t1 - t0) / 1e6;
            if (ms >= 0 && ms < 1000) {
              this._sample(this.gpuSamples, names[i]).push(ms);
              sum += ms;
              if (seen === 0 || t0 < minBegin) minBegin = t0;
              if (seen === 0 || t1 > maxEnd) maxEnd = t1;
              seen++;
            }
          }
        }
        if (seen > 0) {
          const span = Number(maxEnd - minBegin) / 1e6;
          if (span >= 0 && span < 1000) {
            this._scopeSum.push(sum);
            this._frameSpan.push(span);
          }
        }
        slot.buffer.unmap();
        slot.busy = false;
      }).catch(() => { slot.busy = false; });
    });
  }

  // -------------------------------------------------------------------------
  // Counters
  // -------------------------------------------------------------------------

  count(name, n = 1) {
    if (this.counters[name] === undefined) {
      this.counters[name] = 0;
      this._counterOrder.push(name);
    }
    this.counters[name] += n;
  }

  setCount(name, n) {
    if (this.counters[name] === undefined) this._counterOrder.push(name);
    this.counters[name] = n;
  }

  // -------------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------------

  /**
   * Sum of ONE frame's scope durations, averaged over the ring. NaN when there
   * is no resolved timing yet.
   *
   * Correct arithmetic, which summing the per-scope averages was not: the
   * staggered shadow cascades contribute their average on every frame there
   * instead of only on the frames they render. Still only MEANINGFUL when the
   * scopes are additive - see gpuScopesAdditive.
   */
  get gpuScopeSum() {
    return this._scopeSum.count === 0 ? NaN : this._scopeSum.average;
  }

  /**
   * First pass begin to last pass end on the GPU timeline, averaged. NaN when
   * there is no resolved timing yet.
   *
   * This is the only GPU-side figure here that is measured rather than derived,
   * and it is a SPAN, not a busy time: if the queue stalls mid-frame waiting on
   * the swap chain, the wait is inside the span.
   */
  get gpuFrameSpan() {
    return this._frameSpan.count === 0 ? NaN : this._frameSpan.average;
  }

  /**
   * Whether a frame's scope durations may be added up at all.
   *
   * Every scope lies inside the span by construction, so a disjoint set cannot
   * sum past it. When it does, the intervals OVERLAP - each scope's begin-to-end
   * delta is charging for time the others are charging for too - and the sum
   * counts the same nanoseconds once per scope.
   */
  get gpuScopesAdditive() {
    const sum = this.gpuScopeSum, span = this.gpuFrameSpan;
    if (!(sum >= 0) || !(span >= 0)) return false;
    return sum <= span * ADDITIVE_TOLERANCE + 0.05;
  }

  /**
   * The GPU frame time, or NaN when this machine cannot tell you one.
   *
   * IT USED TO ADD UP THE PER-SCOPE AVERAGES AND THAT NUMBER WAS A FICTION.
   * Measured here 2026-08-04, headless Chrome on macOS, camera pinned at the
   * Shallow Reef with the frame vsync-locked at a flat 8.33 ms in every arm: the
   * old sum read 41.9 ms with the scatter pass running and 49.6 ms with
   * `graph.setDisabled('scatter', true)` - five to six times the wall frame and
   * **+18.4% for REMOVING 1.66 ms of real work**. It is not a scaling error that
   * cancels in a ratio; it inverts the sign of an A/B.
   *
   * The cause is that a vsync-limited frame leaves the GPU mostly idle, and a
   * pass's begin-to-end timestamp delta bills the idle as well as the work. Take
   * a pass out and the same idle is shared among fewer scopes, so every survivor
   * inflates: clouds.march 2.45 -> 2.83 ms, taa 1.62 -> 2.09, underwater.blit
   * 1.59 -> 2.09, none of which did any more work than before. The scopes then
   * sum past the frame span, which is exactly what gpuScopesAdditive detects.
   *
   * So this REFUSES rather than lying: NaN when no timing has resolved, when a
   * frame overran MAX_GPU_SCOPES (stale averages), or when the scopes overlap.
   *
   * WHAT SURVIVES THE REFUSAL IS LESS THAN THIS DOCSTRING USED TO CLAIM.
   * Withdrawn 2026-08-05: "the per-scope breakdown remains useful for RANKING
   * passes even when their absolute durations are inflated." That contradicted
   * the paragraph above it - shared idle is billed to each scope in whatever
   * proportion the driver happens to overlap them, which is not a monotone
   * function of the work - and it is refuted by measurement. Two arms of one
   * probe at one station (`jumpTo('reef')`), differing ONLY in `--no-vsync`:
   *
   *   vsync,    107 fps / 9.31 ms: clouds.march 3.642, underwater.blit 2.554,
   *     underwater 2.551, glazing 2.532, glow 2.516, ocean.shade 2.474,
   *     terrain 2.427, bloom.prefilter 2.383
   *   no-vsync, 172 fps / 5.81 ms: underwater.blit 2.551, underwater 2.549,
   *     glazing 2.519, glow 2.512, ocean.shade 2.493, bloom.down1 2.453,
   *     bloom.prefilter 2.449, ocean.depth 2.426
   *
   * `clouds.march` is FIRST in one arm and off the list in the other, and so is
   * `terrain`, on identical work. In the second arm the entire top eight lies
   * inside 2.426-2.551 ms - a 5.2% spread over passes whose workloads differ by
   * orders of magnitude, a fullscreen blit against the ocean shading pass -
   * which is the signature of every scope billing ONE shared interval instead
   * of its own. The order is not even stable against itself: two consecutive
   * six-second windows in ONE process at ONE station returned different top-six
   * SETS, top-ten spreads of 6.5% and 9.1%, and 45 scopes summing to 61.37 and
   * 59.29 ms inside measured spans of 5.814 and 5.768 ms.
   *
   * So on this machine the per-scope averages support NO cost claim at all.
   * The two instruments that do are `gpuFrameSpan` - measured, GPU-side, and
   * still only a span - and wall-clock throughput under `--no-vsync`, which is
   * what `tools/probes/motion-budget.js` exists to take. `main.js`'s F3 row
   * prints the span AND the refusal reason: a row that simply vanishes reads as
   * "not instrumented", which is the opposite of what happened.
   */
  get gpuTotal() {
    if (this.scopeOverflow) return NaN;
    if (!this.gpuScopesAdditive) return NaN;
    return this.gpuScopeSum;
  }

  /** Why gpuTotal refused, or null if it did not. For probes and the overlay. */
  gpuTotalRefusal() {
    if (this._scopeSum.count === 0) return 'no GPU timing has resolved yet';
    if (this.scopeOverflow) {
      return `a frame asked for more than ${MAX_GPU_SCOPES} GPU scopes, so some ` +
        'averages are stale';
    }
    if (!this.gpuScopesAdditive) {
      return `scopes overlap: they sum to ${this.gpuScopeSum.toFixed(2)} ms inside a ` +
        `measured ${this.gpuFrameSpan.toFixed(2)} ms frame span, so their durations ` +
        'are not additive';
    }
    return null;
  }

  /**
   * [name, avgMs] pairs ordered by descending average.
   *
   * NOT "slowest first", which is what this said until 2026-08-05: the averages
   * are not costs and their order is not a ranking. See gpuTotal for the two
   * arms that killed that claim. Kept because it is the only per-pass evidence
   * there is: it still shows a pass that stopped running, or one that changed
   * by an order of magnitude, which no aggregate can.
   */
  gpuBreakdown(limit = 20) {
    return [...this.gpuSamples.values()]
      .map((s) => [s.name, s.average])
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);
  }

  cpuBreakdown(limit = 20) {
    return [...this.cpuSamples.values()]
      .map((s) => [s.name, s.average])
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);
  }

  /** Multi-line text block for the F3 overlay. */
  report({ gpuLimit = 12, cpuLimit = 8 } = {}) {
    const lines = [];
    const gpu = this.gpuBreakdown(gpuLimit);
    if (gpu.length) {
      const why = this.gpuTotalRefusal();
      // The span is printed even when the sum is refused: it is measured, and a
      // reader who sees only "unavailable" will go and re-derive the bad sum.
      lines.push(why
        ? `GPU  span ${this.gpuFrameSpan.toFixed(2)} ms  (total unavailable - ${why})`
        : `GPU  ${this.gpuTotal.toFixed(2)} ms`);
      // Labelled, because an indented list sorted by a millisecond figure IS a
      // cost ranking to anyone reading it, and these are not one - the same
      // eight passes reorder between two windows of one run. See gpuTotal.
      if (why) lines.push('  per-scope averages below are NOT a cost ranking:');
      for (const [name, ms] of gpu) {
        lines.push(`  ${name.padEnd(22, ' ')} ${ms.toFixed(3).padStart(7)} ms`);
      }
    } else if (!this.gpuAvailable) {
      lines.push('GPU  (timestamp-query unavailable)');
    }
    const cpu = this.cpuBreakdown(cpuLimit);
    if (cpu.length) {
      lines.push('CPU');
      for (const [name, ms] of cpu) {
        lines.push(`  ${name.padEnd(22, ' ')} ${ms.toFixed(3).padStart(7)} ms`);
      }
    }
    if (this._counterOrder.length) {
      lines.push('Counters');
      for (const k of this._counterOrder) {
        lines.push(`  ${k.padEnd(22, ' ')} ${String(this.counters[k]).padStart(7)}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * Structured snapshot for the QA harness and automated perf checks.
   *
   * `gpuTotal` IS A NUMBER OR A STRING, AND THE STRING IS DELIBERATE. It used
   * to carry the NaN that gpuTotal returns when it refuses, and `JSON.stringify`
   * writes NaN as `null` - so a JSON reader could not tell "this instrument was
   * lying" from "field absent", and worse, `null` coerces to ZERO, which would
   * pass a `gpuTotal < 8.33` budget check on a build with no timing at all. A
   * string survives JSON, says why on its face, and coerces to NaN, so every
   * comparison against it is false and every sum through it is NaN. A consumer
   * that assumed a number gets a loud TypeError from `.toFixed`, which is the
   * correct outcome for arithmetic that was never valid. Test
   * `Number.isFinite(snap.gpuTotal)` before using it. Same treatment for the two
   * raw aggregates, which are NaN until the first readback resolves.
   */
  snapshot() {
    const gpu = {}, cpu = {};
    for (const [k, s] of this.gpuSamples) gpu[k] = { avg: s.average, max: s.max, last: s.last };
    for (const [k, s] of this.cpuSamples) cpu[k] = { avg: s.average, max: s.max, last: s.last };
    const refusal = this.gpuTotalRefusal();
    const orRefused = (v) =>
      (Number.isFinite(v) ? v : `REFUSED: ${refusal ?? 'not a finite number'}`);
    return {
      gpu, cpu, counters: { ...this.counters },
      gpuTotal: refusal === null ? this.gpuTotal : `REFUSED: ${refusal}`,
      gpuScopeSum: orRefused(this.gpuScopeSum),
      gpuFrameSpan: orRefused(this.gpuFrameSpan),
      gpuScopesAdditive: this.gpuScopesAdditive,
      gpuTotalRefusal: this.gpuTotalRefusal(),
      scopeOverflow: this.scopeOverflow,
    };
  }

  reset() {
    this.cpuSamples.clear();
    this.gpuSamples.clear();
    this._cpuOpen.clear();
    this._order.length = 0;
    this._scopeSum = new Sample('gpuScopeSum');
    this._frameSpan = new Sample('gpuFrameSpan');
    // scopeOverflow is NOT cleared: it is a property of the frame this build
    // submits, not of the sampling window, and a reset between A/B arms must not
    // launder it away.
  }

  destroy() {
    this.querySet?.destroy();
    this.resolveBuffer?.destroy();
    for (const s of this._readbackPool) s.buffer.destroy();
    this._readbackPool.length = 0;
    this.gpuAvailable = false;
  }
}

export const profiler = new Profiler();
