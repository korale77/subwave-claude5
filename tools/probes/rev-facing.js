// ADVERSARIAL REVIEW PROBE 4 - "the fish always look the same way relative to
// us", measured with a sample size that does not depend on which animals
// happened to be sitting on the orbit centre.
//
//   node tools/probe.mjs --file tools/probes/rev-facing.js
//
// WHY THIS REPLACES THE ORBIT AS PRIMARY EVIDENCE. I ran a 12 m two-orbit
// manoeuvre twice against the SAME unmodified build and the headline statistic
// moved from "median swept bearing 355 deg, 12 animals locked" to "median 66
// deg, 0 locked": an orbit scores whichever handful of animals is inside the
// circle that run, so its N is ~10-40 and its variance is enormous. It is not
// evidence. This probe pools the same underlying quantity over EVERY animal
// within 20 m at 20 Hz for a 100 m swim - tens of thousands of observations -
// and bins it by distance, which is the axis the alleged defect lives on.
//
// THREE STATISTICS, all per distance band, all pooled:
//
//  1. |RELATIVE BEARING| = |wrap(animal heading - bearing from animal to
//     diver)|. 0 deg is nose-on, 180 deg is tail-on. The complaint is that this
//     is pinned; the circular concentration |mean exp(i*rel)| says how pinned,
//     and tailOnFrac (|rel| > 135 deg) says which way.
//  2. RADIAL SPEED, the component of the animal's own world velocity along the
//     diver->animal direction. A repulsion pinned to the diver shows up here
//     directly and unambiguously: positive means "moving away from the diver".
//     This is the mechanism, not a proxy for it.
//  3. WORLD SPEED. The old FLEE steer sets a target velocity of magnitude vMax
//     - the animal's full burst - for ANY animal inside R_panic, with no
//     falloff, so the speed should step up sharply at that radius and be flat
//     inside it. A falloff makes it a ramp instead.
//
// Plus per-animal CLOSEST APPROACH over the swim, which is what "we can't get
// near them" means as a number.
//
// The diver is real (KeyW held, yaw/pitch steered, simulate untouched in the
// window); the swim is due north out of the lagoon census point, where the
// seabed measures -14.7 to -17.5 m for 200 m so the near-field geometry is
// constant.

const g = window.subwave;
const sim = g.creatures;
const sp = g.spawner;
const { quat } = await import('/src/core/math.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const START = [0, -8, 240];
const HEADING = 0;
const DIST_TARGET = 100;
const FILL_MS = 10000;
const MAX_MS = 34000;
const HZ = 20;
const BANDS = [0, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20];

const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r3 = (v) => (v === null || v === undefined || !isFinite(v) ? null : +v.toFixed(3));

g.player.inVessel = false;
g.input.enabled = true;
g.input.pointerLocked = true;

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

// ---- accumulators ----------------------------------------------------------
const NB = BANDS.length - 1;
const acc = Array.from({ length: NB }, () => ({ n: 0, cos: 0, sin: 0, absRel: 0,
  tailOn: 0, noseOn: 0, radial: 0, radialAbs: 0, speed: 0, speedMax: 0 }));
const closest = new Map();       // handle -> min distance over the swim
const fwd = new Float32Array(3);
const qtmp = new Float32Array(4);

g.input.keys.add('KeyW');
await sleep(500);
const t0 = performance.now();
let travelled = 0;
const p0 = [g.player.position[0], g.player.position[1], g.player.position[2]];
const prev = p0.slice();
let nSamples = 0;

await new Promise((resolve) => {
  let lastAt = -1e9;
  const step = () => {
    const now = performance.now() - t0;
    const p = g.player.position;
    travelled += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
    prev[0] = p[0]; prev[1] = p[1]; prev[2] = p[2];
    g.player.yaw = HEADING;
    g.player.pitch = Math.max(-0.5, Math.min(0.5, 0.30 * (START[1] - p[1])));

    if (now - lastAt >= 1000 / HZ) {
      lastAt = now;
      nSamples++;
      for (let i = 0; i < sim.capacity; i++) {
        if (!sim.alive[i]) continue;
        const dx = sim.posX[i] - p[0], dy = sim.posY[i] - p[1], dz = sim.posZ[i] - p[2];
        const d = Math.hypot(dx, dy, dz);
        if (d >= BANDS[NB]) continue;
        const h = sim.handleOf(i);
        const c = closest.get(h);
        if (c === undefined || d < c) closest.set(h, d);
        let b = 0; while (b < NB - 1 && d >= BANDS[b + 1]) b++;
        const a = acc[b];
        qtmp[0] = sim.orient[i * 4]; qtmp[1] = sim.orient[i * 4 + 1];
        qtmp[2] = sim.orient[i * 4 + 2]; qtmp[3] = sim.orient[i * 4 + 3];
        quat.forward(fwd, qtmp);
        const hdg = Math.atan2(fwd[0], -fwd[2]);
        const brg = Math.atan2(-dx, dz);            // animal -> diver
        const rel = wrapPi(hdg - brg);
        const ux = dx / d, uy = dy / d, uz = dz / d;  // diver -> animal, unit
        const vr = sim.velX[i] * ux + sim.velY[i] * uy + sim.velZ[i] * uz;
        const spd = Math.hypot(sim.velX[i], sim.velY[i], sim.velZ[i]);
        a.n++; a.cos += Math.cos(rel); a.sin += Math.sin(rel);
        a.absRel += Math.abs(rel);
        if (Math.abs(rel) > 2.356) a.tailOn++;
        if (Math.abs(rel) < 0.785) a.noseOn++;
        a.radial += vr; a.radialAbs += Math.abs(vr);
        a.speed += spd; if (spd > a.speedMax) a.speedMax = spd;
      }
    }
    if (travelled >= DIST_TARGET || now > MAX_MS) { resolve(); return; }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
});
g.input.keys.delete('KeyW');
const dur = (performance.now() - t0) / 1000;

const closestArr = [...closest.values()];
return {
  probe: 'rev-facing',
  setup: { start: START, targetDist: DIST_TARGET, travelled: r3(travelled),
    durationS: r3(dur), meanSpeed: r3(travelled / dur), samples: nSamples,
    observations: acc.reduce((s, a) => s + a.n, 0) },
  byDistanceBand: acc.map((a, k) => ({
    band: `${BANDS[k]}-${BANDS[k + 1]} m`,
    n: a.n,
    concentration: a.n ? r3(Math.hypot(a.cos, a.sin) / a.n) : null,
    meanAbsRelDeg: a.n ? r3((a.absRel / a.n) * 180 / Math.PI) : null,
    tailOnFrac: a.n ? r3(a.tailOn / a.n) : null,
    noseOnFrac: a.n ? r3(a.noseOn / a.n) : null,
    meanRadialSpeed_awayFromDiver: a.n ? r3(a.radial / a.n) : null,
    meanAbsRadialSpeed: a.n ? r3(a.radialAbs / a.n) : null,
    meanWorldSpeed: a.n ? r3(a.speed / a.n) : null,
    maxWorldSpeed: r3(a.speedMax),
  })),
  closestApproach: {
    animalsWithin20m: closestArr.length,
    median: r3(median(closestArr)),
    min: r3(closestArr.length ? Math.min(...closestArr) : null),
    within2m: closestArr.filter((d) => d < 2).length,
    within3m: closestArr.filter((d) => d < 3).length,
    within5m: closestArr.filter((d) => d < 5).length,
    within8m: closestArr.filter((d) => d < 8).length,
  },
  context: { creatureCount: sim.count, nearFieldCount: sp.stats.nearFieldCount,
    drawnInstances: g.creaturePass.stats.instances },
};
