/**
 * Frame time UNDER MOTION, which is the one measurement the 2026-08-01/02 biome
 * pass never took.
 *
 * The scatter LOD caps were raised on 2026-08-02 and drawn triangles went
 * 2.4-3.0x. Every frame-time number quoted for that change - and every qa.mjs
 * scenario - was taken with a PINNED CAMERA, where the chunk streamer, the
 * scatter LOD chain and the near-field director are all idle. That is exactly
 * the configuration in which a geometry increase costs nothing, and it is not a
 * configuration a player is ever in. The cost of the raise, if it has one, shows
 * up as bake and upload pressure while moving.
 *
 * IT DRIVES A REAL KEY. `g.input.keys.add('KeyW')` is the path rev-swim.js uses;
 * writing `vessel.throttle` directly does NOT move a piloted hull, and the first
 * cut of this probe did exactly that and reported `speed: 0` at four of five
 * stations while cheerfully printing a "moving" column. It now ABORTS if the
 * camera has not actually travelled, because a motion test that does not move is
 * the vacuous-pass failure CLAUDE.md's measurement-bugs list already records
 * twice.
 *
 * IT ALSO REFUSES TO REPORT A PRESENTATION CADENCE AS A COST, which is what it
 * did for its whole life before 2026-08-04. requestAnimationFrame is paced by
 * the compositor's vsync, so on a frame with any headroom left EVERY interval
 * this probe can observe is the refresh period and nothing else. Measured on
 * 2026-08-04, default launcher, this build: all ten medians across the five
 * stations landed in 8.05-8.32 ms against a 120 Hz period of 8.333 ms, i.e. the
 * probe reported the same number whatever the frame cost. A median that sits on
 * the cadence is now marked VOID by name rather than printed as a plausible
 * millisecond figure.
 *
 * Usage:
 *   node tools/probe.mjs --no-vsync --file tools/probes/motion-budget.js
 *
 * WITHOUT `--no-vsync` EVERY ROW COMES BACK VOID, and that is the correct
 * result, not a broken probe. With it, read `meanMs` - throughput over the whole
 * window - and not `p50`: uncapped rAF lets the CPU run several frames ahead of
 * the GPU and then block, which makes the per-frame interval bimodal and its
 * median meaningless in the other direction. `gpuFrameSpan` is the measured
 * GPU-side companion; see the profiler's gpuTotal docstring for why the scope
 * SUM is not.
 *
 * THE PER-SCOPE BREAKDOWN IS NOT A RANKING EITHER, AND THIS PROBE IS WHERE THAT
 * CLAIM WAS WITHDRAWN. `profiler.gpuTotal`'s docstring used to say the breakdown
 * "remains useful for RANKING passes even when their absolute durations are
 * inflated"; the measurement below killed it and the profiler dropped the
 * sentence on 2026-08-05, so do not go looking for it there. Measured
 * 2026-08-04, two runs of one probe at one station differing ONLY in
 * `--no-vsync`: the top five went
 * clouds.march / terrain / entities / scatter / ocean.shade in one arm and
 * bloom.prefilter / ocean.shade / taa / glazing / glow in the other - nearly
 * disjoint, with five unrelated passes reporting within 1.7% of each other.
 * Five passes agreeing to 1.7% is the signature of every scope billing the same
 * shared idle interval, not of five passes costing the same. The inflation is
 * not a common factor, so it does not cancel in an ordering.
 *
 * WHAT IS TRUSTWORTHY HERE, and it is only these two: `gpuFrameSpan`, which is
 * first-begin to last-end on the GPU timeline and is measured rather than
 * derived; and the WALL-CLOCK throughput (`meanMs`, frames per wall second)
 * under `--no-vsync`. Both are whole-frame figures. To attribute a cost to one
 * pass, A/B it with `graph.setDisabled(name, true)` and read those two - do not
 * read its scope.
 */

const STATIONS = [
  { name: 'reef', biome: 2 },
  { name: 'coral', biome: 3 },
  { name: 'kelp', biome: 5 },
  { name: 'terrace', biome: 9 },
  { name: 'trenchfloor', biome: 13 },
];

/**
 * SPEED, not distance, below which the run is not a motion test at all.
 *
 * It used to be a flat 25 m of travel over a 600-FRAME window, which silently
 * assumed the window was about five seconds long - true only while rAF is paced
 * by a 120 Hz vsync. Uncapped (`--no-vsync`, which is the only way this probe
 * reports a cost at all) the same 600 frames take under four seconds and the
 * diver covers 11-20 m, so every station aborted as "the camera did not move"
 * while moving at a perfectly correct 5 m/s. A speed gate asks the question the
 * guard was always for and does not care how the frames are paced.
 *
 * Sprint swim is 4.0/6.5 m/s and the submerged hull is 38; the gates are set
 * near half of each, low enough to survive a collision or a slope and high
 * enough that a stuck body cannot pass.
 */
const MIN_SWIM_SPEED = 3.0;
const MIN_FLY_SPEED = 15.0;
const SETTLE_FRAMES = 150;
const STILL_FRAMES = 240;
const MOVE_FRAMES = 600;

/**
 * Refresh rates a real display might be running at, and how close a median has
 * to sit to one of their periods before the sample is declared cadence-locked.
 *
 * The rate is matched from the DATA rather than asked of the platform, because
 * nothing in the web platform reports it: `screen` has no refresh field, and
 * deriving it from the frame intervals is circular - those intervals ARE the
 * thing under test. Matching the median against the small set of periods real
 * hardware actually presents at is the honest version of the same question.
 *
 * 0.3 ms is deliberately tight. It is wide enough to absorb the jitter on a
 * locked sample (measured spread across ten locked medians here: 8.05-8.32 ms,
 * i.e. 0.28 ms below the 8.333 ms period at worst) and narrow enough that a
 * frame genuinely costing 8.7 ms is still reported. A frame that genuinely costs
 * 8.33 ms on a 120 Hz display is indistinguishable from a locked one BY
 * CONSTRUCTION, and calling that VOID is the right answer, not a false positive.
 */
const REFRESH_HZ = [240, 165, 144, 120, 90, 75, 60, 30];
const CADENCE_TOL_MS = 0.3;

/**
 * Second, independent lock test, because the median test above LEAKS.
 *
 * A vsync-locked median jitters DOWNWARD - the interval is measured between two
 * rAF callback entries and the callback is dispatched a variable moment after
 * the vsync itself - so it sits at or just under the period, never above. First
 * run of the median test on this build, 15 samples, caught 14: one still-camera
 * median came back 8.02 ms, which is 0.313 ms under the 120 Hz period and slips
 * past a 0.3 ms band by 13 microseconds while being every bit as locked as the
 * other fourteen. Widening the band would start swallowing real costs, so the
 * leak is closed with a different question instead: not "is the middle of the
 * distribution on the period" but "is the distribution PILED UP on it". A cost
 * distribution is not - it is spread by the work each frame happens to do.
 */
const LOCK_WINDOW_MS = 0.5;
const LOCK_FRACTION = 0.6;

/** The refresh rate whose period is nearest `ms`, with that distance. */
function nearestRefresh(ms) {
  let best = 0, dist = Infinity;
  for (const hz of REFRESH_HZ) {
    const d = Math.abs(ms - 1000 / hz);
    if (d < dist) { dist = d; best = hz; }
  }
  return { hz: best, dist };
}

/**
 * The refresh rate this sample is locked to, or 0 if it is not locked.
 *
 * @param {number} p50 median frame interval, ms
 * @param {number[]} dts every frame interval in the sample, ms
 */
function cadenceHz(p50, dts) {
  const { hz, dist } = nearestRefresh(p50);
  if (dist < CADENCE_TOL_MS) return hz;
  const period = 1000 / hz;
  let on = 0;
  for (const d of dts) if (Math.abs(d - period) < LOCK_WINDOW_MS) on++;
  return on / dts.length >= LOCK_FRACTION ? hz : 0;
}

const g = subwave.game ?? subwave;
const prof = (await import('/src/core/profiler.js')).profiler;

/**
 * Sample per-frame wall time for `frames` rendered frames, accumulating the
 * camera's own travel so the caller can prove the sample was taken in motion,
 * and testing the resulting median against the presentation cadence.
 */
async function sample(frames) {
  const dts = [];
  const cam = subwave.renderer.camera.position;
  const start = [cam[0], cam[1], cam[2]];
  const prev = start.slice();
  let travelled = 0;
  prof.reset();
  const t0 = performance.now();
  await new Promise((res) => {
    let n = 0;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      if (n > 0) dts.push(now - last);
      last = now;
      travelled += Math.hypot(cam[0] - prev[0], cam[1] - prev[1], cam[2] - prev[2]);
      prev[0] = cam[0]; prev[1] = cam[1]; prev[2] = cam[2];
      if (++n > frames) return res();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // Throughput over the whole window. This is the statistic that survives an
  // uncapped rAF, where the per-frame interval is bimodal; the queue cannot run
  // ahead for ever, so frames-per-wall-second is still the real cost.
  const wall = performance.now() - t0;
  const mean = wall / dts.length;
  dts.sort((a, b) => a - b);
  const at = (p) => dts[Math.min(dts.length - 1, Math.floor(dts.length * p))];
  const median = at(0.5);
  const hz = cadenceHz(median, dts);
  const span = prof.gpuFrameSpan;
  // UNCAPPED rAF is bimodal: the CPU submits several frames back to back and
  // then blocks on swap-chain backpressure, so the low percentiles are submit
  // time and the high ones are the block. Measured here at the reef with
  // --no-vsync: median 0.84 ms against a mean of 5.72 and a p99 of 108. Neither
  // tail is a frame cost, so they are reported as BURST rather than as numbers.
  const bursty = median < mean * 0.5;
  return {
    travelled,
    seconds: wall / 1000,
    speed: travelled / (wall / 1000),
    median, mean, bursty,
    p95: at(0.95), p99: at(0.99), max: dts[dts.length - 1],
    over16: dts.filter((d) => d > 16.7).length,
    n: dts.length,
    cadenceHz: hz,
    gpuFrameSpan: Number.isFinite(span) ? +span.toFixed(3) : null,
  };
}

/**
 * Render one sample as reported fields, replacing every wall-clock figure with
 * the string VOID when the median is the refresh period.
 *
 * The whole point is that a cadence-locked run must not hand back a number a
 * reader can put in a table. `gpuFrameSpan` is kept either way - it is measured
 * on the GPU timeline and is not paced by the compositor - and so is `mean`,
 * which is what the reader should be looking at once --no-vsync is on.
 */
function report(s, prefix) {
  const v = s.cadenceHz ? 'VOID' : null;
  return {
    [`${prefix}Median`]: v ?? (s.bursty ? 'BURST' : +s.median.toFixed(2)),
    [`${prefix}Mean`]: v ?? +s.mean.toFixed(2),
    [`${prefix}P99`]: v ?? (s.bursty ? 'BURST' : +s.p99.toFixed(2)),
    [`${prefix}GpuSpan`]: s.gpuFrameSpan,
  };
}

const out = [];
for (const st of STATIONS) {
  subwave.worldClock.setDayFraction(0.32);
  subwave.jumpTo(st.biome);
  await sample(SETTLE_FRAMES);                  // let streaming and scatter drain
  const still = await sample(STILL_FRAMES);

  // Swim, on the real input path, holding a heading so the streamer is fed a
  // continuous frontier rather than a circle it has already baked.
  const p = g.player;
  const heading = 1.9;
  g.input.keys.add('KeyW');
  g.input.keys.add('ShiftLeft');                // sprint: 6.5 m/s, worst case
  const pin = setInterval(() => {
    p.aimYaw = heading;
    p.aimPitch = 0.02;
    p.oxygen = p.oxygenCapacity;
    p.health = 100;
  }, 8);
  const moving = await sample(MOVE_FRAMES);
  clearInterval(pin);
  g.input.keys.delete('KeyW');
  g.input.keys.delete('ShiftLeft');

  // THE VESSEL IS THE REAL STREAMING STRESS: 38 m/s submerged is six times a
  // sprinting diver, i.e. a 64 m chunk every 1.7 s. Swimming does not test the
  // mesher at all.
  //
  // `board()` is a NO-OP on a hull already flagged piloted, and board() is what
  // seeds the aim and the direct model's lagged angles - so the flag has to be
  // cleared first. Writing `vessel.throttle` without boarding does nothing at
  // all, which is how the first cut of this probe measured `speed: 0`.
  const v = g.vessel;
  v.position.set([p.position[0], p.position[1] + 6, p.position[2]]);
  v.prevPosition.set(v.position);
  v.velocity.set([0, 0, 0]);
  v.angularVelocity?.set?.([0, 0, 0]);
  v.hull = v.hullMax;
  g.player.inVessel = true;
  v.piloted = false;
  v.board();
  v.aimYaw = heading; v.aimPitch = 0.0;
  v.prevAimYaw = heading; v.prevAimPitch = 0.0;
  g.input.keys.add('KeyW');
  const vpin = setInterval(() => { v.aimYaw = heading; v.aimPitch = 0.0; v.hull = v.hullMax; }, 8);
  const flying = await sample(MOVE_FRAMES);
  clearInterval(vpin);
  g.input.keys.delete('KeyW');
  g.player.inVessel = false;
  v.piloted = false;

  // SCATTER STATS FREEZE WHEN THE PASS IS DISABLED. `stats.triangles` and
  // `stats.visibleInstances` are written inside execute(), so under a
  // `graph.setDisabled('scatter', true)` A/B they keep reporting the last
  // ENABLED frame's numbers rather than zero - measured, an off arm reported the
  // identical 6,253,806 triangles its on arm had. Read them as a description of
  // the scene, never as evidence about which arm ran.
  const s = subwave.scatterPass?.stats ?? {};
  out.push({
    station: st.name,
    swimM: +moving.travelled.toFixed(1),
    flyM: +flying.travelled.toFixed(1),
    swimSpeed: +moving.speed.toFixed(1),
    flySpeed: +flying.speed.toFixed(1),
    valid: moving.speed >= MIN_SWIM_SPEED && flying.speed >= MIN_FLY_SPEED,
    ...report(still, 'still'),
    ...report(moving, 'swim'),
    ...report(flying, 'fly'),
    flyOver16ms: flying.cadenceHz ? 'VOID' : (flying.bursty ? 'BURST' : flying.over16),
    ofFrames: flying.n,
    scatterVisible: s.visibleInstances ?? -1,
    scatterTris: s.triangles ?? -1,
  });
}

const invalid = out.filter((r) => !r.valid)
  .map((r) => `${r.station} (swim ${r.swimSpeed} m/s, fly ${r.flySpeed} m/s)`);
const voided = out.filter((r) => r.flyMedian === 'VOID').map((r) => r.station);
return JSON.stringify({
  ok: invalid.length === 0 && voided.length === 0,
  abort: invalid.length ? `NOT A MOTION TEST at: ${invalid.join(', ')} - the camera did not move` : null,
  void: voided.length
    ? `CADENCE, NOT COST, at: ${voided.join(', ')} - the median is the display refresh ` +
      'period. Relaunch with: node tools/probe.mjs --no-vsync --file tools/probes/motion-budget.js'
    : null,
  rows: out,
}, null, 1);
