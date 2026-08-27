// ADVERSARIAL REVIEW PROBE 2 - "we barely see any fish in the shallows",
// plus the failure modes the fix could have introduced.
//
//   node tools/probe.mjs --file tools/probes/rev-swim.js
//
// ONE REAL SWIM, 200 m due NORTH from the lagoon census point, at cruise.
// North is chosen because the seabed along it measures -14.7 to -17.5 m over
// the whole 200 m (offline terrain.sampleHeightFast at 25 m intervals), so the
// near-field radius, the water type and the depth band are constant and the
// drawn-instance comparison is not confounded by the column changing under it.
// nearfield-lib.js uses due WEST, which reaches -10.5 m by 200 m.
//
// THE DIVER IS REAL. KeyW is held in input.keys and the yaw/pitch pair is
// steered; Player.simulate is untouched during the measurement window, so the
// swim lag, the buoyancy, the waterline and the spawner's own finite-difference
// of its centre are all the ones the game uses. The existing acceptance probes
// (nearfield-swim.js, fish-facing.js) replace simulate for at least part of the
// run; this one only pins during the FILL, and the pin is released 0.5 s before
// t = 0 so no teleport is inside the window.
//
// WHAT IT REPORTS
//  1. DRAWN CREATURE INSTANCES, creaturePass.stats.instances, sampled at 2 Hz
//     over the first 60 m and over the whole 200 m: min / median / max. This is
//     the pass's own post-cull count, i.e. what is actually rasterised, which is
//     the closest scalar to "we barely see any fish". A 20 Hz series is kept as
//     well, because a 2 Hz sample of a FROZEN counter looks identical to a
//     healthy one.
//  2. STALENESS. Total agent count, near-field-flagged alive count, population
//     inside 45 m and the alive-to-counted ratio over the whole 200 m; the
//     dwell of individual handles inside the ball; how much of the population
//     present at t = 0 is still inside the ball at the end (a near field that is
//     DRAGGED would keep all of it); and the world displacement of those animals
//     against the diver's own 200 m (a dragged field displaces with the diver, a
//     healthy one does not).
//  3. POP-IN. Every spawn is intercepted at the source - _placeGroup is wrapped
//     so a near-field seed is identified exactly, not inferred - and tested
//     against the SAME camera object the hide rule uses (sim._ctx.camera) for
//     frustum visibility, and against 0.85 R for distance. Reports seeds per
//     second inside the frustum within 0.85 R, which the rule says must be 0,
//     and the minimum in-frustum seed distance, which the rule does not bound
//     but the eye does.

const g = window.subwave;
const sim = g.creatures;
const sp = g.spawner;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const START = [0, -8, 240];
const HEADING = 0;             // due north (-Z)
const DIST_TARGET = 200;
const SEG1 = 60;               // the "60 m straight line" the review asks for
const FILL_MS = 9000;
const MAX_MS = 56000;
const SAMPLE_HZ = 20;          // the 2 Hz series is decimated from this one
const NEAR_R = 45;

const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r3 = (v) => (v === null || v === undefined || !isFinite(v) ? null : +v.toFixed(3));
const summary = (a) => {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return { n: a.length, min: r3(s[0]), p10: r3(s[Math.floor(a.length * 0.1)]),
    median: r3(median(a)), mean: r3(a.reduce((q, x) => q + x, 0) / a.length),
    max: r3(s[s.length - 1]) };
};

// ---- state the hooks read (declared FIRST, so nothing is in a TDZ) ----------
let started = false;
let t0 = performance.now();
const nowS = () => (performance.now() - t0) / 1000;
const seeds = [];              // near-field seeds: {t, d, frac, visible, camD}
const removals = [];           // {t, reason, d, dwell, nearFlag}
const ball = new Map();        // handle -> {first, last, n} seconds inside 45 m
const _vp = new Float32Array(3);
let placeRegion = null;

g.player.inVessel = false;
g.input.enabled = true;
g.input.pointerLocked = true;

// ---- fill ------------------------------------------------------------------
g.player.position.set(START);
g.player.prevPosition.set(START);
g.player.velocity[0] = 0; g.player.velocity[1] = 0; g.player.velocity[2] = 0;
g.player.yaw = HEADING; g.player.pitch = 0;
const realSim = g.player.simulate.bind(g.player);
g.player.simulate = (dt, input, t) => {
  realSim(dt, input, t);
  g.player.prevPosition.set(START);
  g.player.position.set(START);
  g.player.velocity[0] = 0; g.player.velocity[1] = 0; g.player.velocity[2] = 0;
};
await sleep(FILL_MS);
g.player.simulate = realSim;
const stationaryDrawn = g.creaturePass.stats.instances;
const stationaryNear = sp.stats.nearFieldCount;

// ---- hooks -----------------------------------------------------------------
const realPlace = sp._placeGroup.bind(sp);
sp._placeGroup = function (...args) {
  placeRegion = args[5] || null;
  try { return realPlace(...args); } finally { placeRegion = null; }
};
const realSpawn = sim.spawn.bind(sim);
sim.spawn = function (spi, x, y, z, opts) {
  const h = realSpawn(spi, x, y, z, opts);
  if (h >= 0 && started && placeRegion) {
    const reg = placeRegion;
    const cam = (sim._ctx && sim._ctx.camera) || g.renderer.camera;
    const d = Math.hypot(x - reg.x, y - reg.y, z - reg.z);
    let vis = false;
    if (cam && cam.isSphereVisible) {
      _vp[0] = x; _vp[1] = y; _vp[2] = z;
      vis = !!cam.isSphereVisible(_vp, Math.max(0.2, sim.bodyLength[h & 0xffff] * 0.6));
    }
    const cp = cam && cam.position;
    seeds.push({ t: nowS(), d, frac: reg.rMax > 0 ? d / reg.rMax : 0, visible: vis,
      camD: cp ? Math.hypot(x - cp[0], y - cp[1], z - cp[2]) : null });
  }
  return h;
};
const realDespawn = sim.despawn.bind(sim);
sim.despawn = function (handle, reason = 'despawn') {
  if (started) {
    const i = sim.slotOf(handle);
    if (i >= 0) {
      const p = g.player.position;
      const d = Math.hypot(sim.posX[i] - p[0], sim.posY[i] - p[1], sim.posZ[i] - p[2]);
      const b = ball.get(handle);
      removals.push({ t: nowS(), reason, d, dwell: b ? b.last - b.first : null,
        nearFlag: sp._nearFieldSlot[handle & 0xffff] });
    }
  }
  return realDespawn(handle, reason);
};

// ---- the swim --------------------------------------------------------------
const series = [];
let travelled = 0;
g.input.keys.add('KeyW');
await sleep(500);              // let the pin's last frame wash out
t0 = performance.now();
started = true;
const p0 = [g.player.position[0], g.player.position[1], g.player.position[2]];
const prev = p0.slice();

/** Agents inside the ball at t = 0, for the drag test. */
const t0Set = new Map();
for (let i = 0; i < sim.capacity; i++) {
  if (!sim.alive[i]) continue;
  const d = Math.hypot(sim.posX[i] - p0[0], sim.posY[i] - p0[1], sim.posZ[i] - p0[2]);
  if (d <= NEAR_R) t0Set.set(sim.handleOf(i), [sim.posX[i], sim.posY[i], sim.posZ[i]]);
}

await new Promise((resolve) => {
  let lastSampleAt = -1e9;
  const step = () => {
    const t = nowS();
    const p = g.player.position;
    travelled += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
    prev[0] = p[0]; prev[1] = p[1]; prev[2] = p[2];

    g.player.yaw = HEADING;
    g.player.pitch = Math.max(-0.5, Math.min(0.5, 0.30 * (START[1] - p[1])));

    if (t * 1000 - lastSampleAt >= 1000 / SAMPLE_HZ) {
      lastSampleAt = t * 1000;
      let near = 0, nearFlagAlive = 0, maxNearD = 0, forwardCount = 0;
      const fx = Math.sin(HEADING), fz = -Math.cos(HEADING);
      for (let i = 0; i < sim.capacity; i++) {
        if (!sim.alive[i]) continue;
        const dx = sim.posX[i] - p[0], dy = sim.posY[i] - p[1], dz = sim.posZ[i] - p[2];
        const d = Math.hypot(dx, dy, dz);
        if (sp._nearFieldSlot[i] === 1) {
          nearFlagAlive++;
          if (d > maxNearD) maxNearD = d;
        }
        if (d <= NEAR_R) {
          near++;
          if (dx * fx + dz * fz > 0) forwardCount++;
          const h = sim.handleOf(i);
          let b = ball.get(h);
          if (!b) { b = { first: t, last: t, n: 0 }; ball.set(h, b); }
          b.last = t; b.n++;
        }
      }
      series.push({ t, travelled, drawn: g.creaturePass.stats.instances,
        count: sim.count, near, nearFlagAlive, maxNearD, forwardCount, y: p[1],
        radius: sp.stats.nearFieldRadius, spFwd: sp.stats.nearFieldForward });
    }

    if (travelled >= DIST_TARGET || t * 1000 > MAX_MS) { resolve(); return; }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
});
started = false;
g.input.keys.delete('KeyW');

// ---- analysis --------------------------------------------------------------
const pEnd = [g.player.position[0], g.player.position[1], g.player.position[2]];
const playerDisp = Math.hypot(pEnd[0] - p0[0], pEnd[1] - p0[1], pEnd[2] - p0[2]);

let t0Alive = 0, t0StillNear = 0;
const t0Disp = [];
for (const [h, q] of t0Set) {
  const i = sim.slotOf(h);
  if (i < 0) continue;
  t0Alive++;
  const d = Math.hypot(sim.posX[i] - pEnd[0], sim.posY[i] - pEnd[1], sim.posZ[i] - pEnd[2]);
  if (d <= NEAR_R) t0StillNear++;
  t0Disp.push(Math.hypot(sim.posX[i] - q[0], sim.posY[i] - q[1], sim.posZ[i] - q[2]));
}

const seg1 = series.filter((s) => s.travelled <= SEG1);
const lastQ = series.filter((s) => s.travelled > DIST_TARGET * 0.75);
const at2Hz = (rows) => { const o = []; let next = 0; for (const r of rows) { if (r.t >= next) { o.push(r); next = r.t + 0.5; } } return o; };
const drawnOf = (rows) => rows.map((r) => r.drawn);

const tEnd = series.length ? series[series.length - 1].t : 1;
const dwell = [];
for (const [, b] of ball) if (b.first > 0.6 && b.last < tEnd - 0.6) dwell.push(b.last - b.first);

const inFrustumSeeds = seeds.filter((s) => s.visible);
const violations = seeds.filter((s) => s.visible && s.frac < 0.85);
const dur = tEnd || 1;

return {
  probe: 'rev-swim',
  setup: { start: START, headingRad: HEADING, seabedAlongPath_m: '-14.7 to -17.5',
    targetDist: DIST_TARGET, travelled: r3(travelled), durationS: r3(tEnd),
    meanSpeed: r3(travelled / dur), playerDisplacement: r3(playerDisp),
    samples: series.length, fillMs: FILL_MS },
  stationaryBeforeMoving: { drawnInstances: stationaryDrawn, nearFieldCount: stationaryNear },

  drawnInstances_first60m_2Hz: summary(drawnOf(at2Hz(seg1))),
  drawnInstances_first60m_20Hz: summary(drawnOf(seg1)),
  drawnInstances_full200m_2Hz: summary(drawnOf(at2Hz(series))),
  drawnInstances_full200m_20Hz: summary(drawnOf(series)),
  drawnInstances_lastQuarter_2Hz: summary(drawnOf(at2Hz(lastQ))),

  population: {
    within45m: summary(series.map((s) => s.near)),
    within45m_first60m: summary(seg1.map((s) => s.near)),
    within45m_lastQuarter: summary(lastQ.map((s) => s.near)),
    forwardShare: r3(series.reduce((q, r) => q + (r.near ? r.forwardCount / r.near : 0), 0) / (series.length || 1)),
    totalAgents: summary(series.map((s) => s.count)),
    nearFieldFlaggedAlive: summary(series.map((s) => s.nearFlagAlive)),
    aliveToCountedRatio: summary(series.map((s) => (s.near ? s.nearFlagAlive / s.near : 0))),
    maxDistanceOfLiveNearFieldAgent: summary(series.map((s) => s.maxNearD)),
    nearFieldRadius: summary(series.map((s) => s.radius)),
  },

  staleness: {
    dwellInsideBall_freshEntrants_s: summary(dwell),
    distinctHandlesEverInsideBall: ball.size,
    handlesInsideBallAtT0: t0Set.size,
    ofThose_stillAlive: t0Alive,
    ofThose_stillInsideBallAtEnd: t0StillNear,
    ofThose_worldDisplacement_m: summary(t0Disp),
    playerDisplacement_m: r3(playerDisp),
    removalsPerS: r3(removals.length / dur),
    removals_minDistance_m: r3(removals.length ? Math.min(...removals.map((r) => r.d)) : null),
    removals_byReason: removals.reduce((o, r) => { o[r.reason] = (o[r.reason] || 0) + 1; return o; }, {}),
    nearFieldSeedsPerS: r3(seeds.length / dur),
  },

  popIn: {
    nearFieldSeeds: seeds.length,
    inFrustumSeeds: inFrustumSeeds.length,
    inFrustumSeedsPerS: r3(inFrustumSeeds.length / dur),
    VIOLATIONS_inFrustum_within085R: violations.length,
    violationsPerS: r3(violations.length / dur),
    inFrustumSeed_distanceFromEye_m: summary(inFrustumSeeds.map((s) => s.d)),
    inFrustumSeed_fracOfR: summary(inFrustumSeeds.map((s) => s.frac)),
    allSeed_fracOfR: summary(seeds.map((s) => s.frac)),
    minSeedDistance_any_m: r3(seeds.length ? Math.min(...seeds.map((s) => s.d)) : null),
  },

  spawnerCounters: {
    nearFieldSpawned: sp.stats.nearFieldSpawned, nearFieldRetired: sp.stats.nearFieldRetired,
    nearFieldReclaimed: sp.stats.nearFieldReclaimed, aiMs: r3(sim.stats.msLast),
  },
};
