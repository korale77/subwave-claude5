// Probe: "they always look away from us, fish AND rays" - measured on the axis
// the defect actually lives on, which is d / rPanic and NOT d.
//
//   node tools/probe.mjs --file tools/probes/facing-normalised.js
//
// WHY THIS EXISTS ALONGSIDE rev-facing.js. That probe bins by ABSOLUTE metres
// and STATUS headlines its 6-8 m band (concentration 0.864 -> 0.148). For a
// 0.11 m Coppersprat rPanic is 4.66 m, so the 6-8 m band is entirely OUTSIDE
// the flee radius by construction - it could only ever read clean, whatever the
// flee term did inside. Every number quoted off it is true and none of it
// covers the range the player is complaining about.
//
// Two changes, and they are the whole point:
//
//  1. BIN BY d / rPanic(bodyLength). One 0.11 m sprat and one 1.30 m ray at the
//     same 5 m are at 1.07 and 0.28 of their own radii - opposite ends of the
//     falloff - and pooling them in a "4-6 m" bucket averages the defect away.
//  2. SPLIT BY BODY LENGTH (<0.3 / 0.3-1.0 / >1.0 m). rPanic is max(2 + 12L,
//     4 + 6L), so it runs from 4.1 m on a Glimmerkrill to 17.6 m on a Sandveil
//     Ray and 57 m on a Gloomray. The report names rays specifically and the
//     large class is 1.5% of a pooled sample, i.e. invisible in the mean.
//
// Plus the school-level discriminator STATUS item C asks for and that no
// existing probe does: grouped by schoolId, is the SHOAL coherent, and does its
// mean heading TRACK the diver? That separates "each fish independently points
// away" from "alignment propagates one fish's yield to the whole body".
//
// READ `tailOnFrac` AND `meanAbsRelDeg`, NOT `concentration`. Concentration says
// only whether the bearing is CONSTANT, and a TANGENTIAL escape holds it
// constant at 90 deg exactly as a radial one holds it at 180 - so it is maximal
// for the bug and for the ideal fix alike. On the single-animal probe it read
// 0.096 / 0.998 / 0.910 over three runs of one fixed build. It is kept here
// because it still separates "locked" from "indifferent", but it cannot say
// which way the animal is pointing and must never be the headline.
//
// AND CHECK `distinctAnimals` BEFORE BELIEVING ANY ROW. The near bands of a
// 100 m swim carry 10-40 observations against 15,000 in the far field, because
// the player panic radius is ~2.3 m on a small fish. One after-run's ">1.0 m
// class is still pinned at 0.82" was 169 samples of a SINGLE animal.
//
// EVERYTHING ELSE IS rev-facing.js's, deliberately: a real 100 m swim with KeyW
// held, every animal within 20 m at 20 Hz, tens of thousands of observations.
// DO NOT replace this with an orbit. STATUS "Measurement bugs": the same 12 m
// two-orbit manoeuvre against ONE unmodified build reported "12 animals locked",
// then "1 locked", then "0 locked", because an orbit scores whichever 3-40
// animals happen to lie inside the circle that run.

const g = window.subwave;
const sim = g.creatures;
const sp = g.spawner;
const { quat } = await import('/src/core/math.js');
const C = await import('/src/entities/creatures.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const START = [0, -8, 240];
const HEADING = 0;
const DIST_TARGET = 100;
const FILL_MS = 10000;
const MAX_MS = 34000;
const HZ = 20;
const BANDS = [0, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20];
// Fractions of the animal's OWN panic radius. The falloff is linear to zero at
// 1.0, so anything at or beyond that band is an untreated control.
const FRACS = [0, 0.25, 0.5, 0.75, 1.0, 1.5, 1e9];
// Body-length classes. 0.3 m is where max(2+12L, 4+6L) switches branch (below
// it the 4+6L fear floor wins), 1.0 m is where the radius passes 14 m.
const LCLASS = [0, 0.3, 1.0, 1e9];
const LCLASS_NAME = ['<0.3 m', '0.3-1.0 m', '>1.0 m'];
const MIN_SCHOOL = 5;

const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r3 = (v) => (v === null || v === undefined || !isFinite(v) ? null : +v.toFixed(3));

// The radius the FLEE block uses for the PLAYER, rebuilt from the module's own
// exports rather than copied, so this probe cannot drift away from the engine.
// The fallback is the pre-split formula, which is what makes a before-run and
// an after-run comparable: each bins by the radius its own build was using.
//
// GETTING THIS WRONG SILENTLY RUINS THE AXIS. Binning an after-run by the
// PREDATOR radius put a Sandveil Ray's observations at 0.5-0.75 R when they were
// really at 2.4x its player radius, i.e. in a band where no player force exists
// at all, and the row read as an unfixed regression.
const panicRadius = (bodyLength) => (C.playerPanicRadius
  ? C.playerPanicRadius(bodyLength)
  : Math.max(C.PANIC_FLOOR_M + C.PANIC_BODY_LENGTHS * bodyLength,
    C.fearFleeRadius(bodyLength)));
const predatorRadius = (bodyLength) => Math.max(
  C.PANIC_FLOOR_M + C.PANIC_BODY_LENGTHS * bodyLength, C.fearFleeRadius(bodyLength));

// Restored in the finally at the end. Leaving `input.enabled` or a held KeyW
// behind poisons every later probe in the same browser.
const saved = { inVessel: g.player.inVessel, enabled: g.input.enabled,
  locked: g.input.pointerLocked, simulate: g.player.simulate };
g.player.inVessel = false;
g.input.enabled = true;
g.input.pointerLocked = true;

g.player.position.set(START);
g.player.prevPosition.set(START);
g.player.velocity[0] = 0; g.player.velocity[1] = 0; g.player.velocity[2] = 0;
g.player.yaw = HEADING; g.player.pitch = 0;
// Hold the diver still while the near field fills, so the swim starts from a
// settled population rather than from whatever the teleport left behind.
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
const NF = FRACS.length - 1;
const NL = LCLASS.length - 1;
const mkAcc = () => ({ n: 0, cos: 0, sin: 0, absRel: 0, tailOn: 0, noseOn: 0,
  radial: 0, radialAbs: 0, speed: 0, speedMax: 0, dSum: 0, rSum: 0,
  inVessel: 0, inPred: 0, handles: new Set() });
const byBand = Array.from({ length: NB }, mkAcc);
const byFrac = Array.from({ length: NF }, mkAcc);
// The cross-tab is the actual deliverable: fraction-of-own-radius x size class.
const byFracL = Array.from({ length: NL }, () => Array.from({ length: NF }, mkAcc));
const closest = new Map();          // handle -> min distance over the swim
const fwd = new Float32Array(3);
const qtmp = new Float32Array(4);

// School-level: one entry per (schoolId, sample), accumulated across the swim.
// Keyed on schoolId alone and reduced per sample, because the question is about
// the shoal as a body and not about any individual in it.
const schoolAcc = new Map();        // schoolId -> {n, coh, track, dSum}

const classOf = (L) => { let k = 0; while (k < NL - 1 && L >= LCLASS[k + 1]) k++; return k; };

const tally = (a, rel, vr, spd, d, rP, inV, inP, handle) => {
  a.n++; a.cos += Math.cos(rel); a.sin += Math.sin(rel);
  a.absRel += Math.abs(rel);
  if (Math.abs(rel) > 2.356) a.tailOn++;      // |rel| > 135 deg
  if (Math.abs(rel) < 0.785) a.noseOn++;      // |rel| <  45 deg
  a.radial += vr; a.radialAbs += Math.abs(vr);
  a.speed += spd; if (spd > a.speedMax) a.speedMax = spd;
  a.dSum += d; a.rSum += rP;
  // Which OTHER threat branch could be acting. Without these a row cannot be
  // attributed: an animal fleeing the parked sub or a real predator produces
  // exactly the same relative-bearing statistic as one fleeing the diver.
  if (inV) a.inVessel++;
  if (inP) a.inPred++;
  // Distinct animals behind the row. A high concentration on n = 50 samples of
  // ONE animal is the pooled-probe form of the orbit lottery and means nothing.
  a.handles.add(handle);
};

g.input.keys.add('KeyW');
await sleep(500);
const t0 = performance.now();
let travelled = 0;
const prev = [g.player.position[0], g.player.position[1], g.player.position[2]];
let nSamples = 0;

try {
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
        // Per-sample school reduction. Headings as unit vectors so the mean is
        // circular; the diver bearing summed the same way.
        const schools = new Map();

        for (let i = 0; i < sim.capacity; i++) {
          if (!sim.alive[i]) continue;
          const dx = sim.posX[i] - p[0], dy = sim.posY[i] - p[1], dz = sim.posZ[i] - p[2];
          const d = Math.hypot(dx, dy, dz);
          if (d >= BANDS[NB]) continue;
          const L = sim.bodyLength[i];
          const rP = panicRadius(L);
          const h = sim.handleOf(i);
          const c = closest.get(h);
          if (c === undefined || d < c) closest.set(h, d);

          qtmp[0] = sim.orient[i * 4]; qtmp[1] = sim.orient[i * 4 + 1];
          qtmp[2] = sim.orient[i * 4 + 2]; qtmp[3] = sim.orient[i * 4 + 3];
          quat.forward(fwd, qtmp);
          const hdg = Math.atan2(fwd[0], -fwd[2]);
          const brg = Math.atan2(-dx, dz);            // animal -> diver
          const rel = wrapPi(hdg - brg);              // 0 nose-on, +-pi tail-on
          const ux = dx / d, uy = dy / d, uz = dz / d;  // diver -> animal, unit
          const vr = sim.velX[i] * ux + sim.velY[i] * uy + sim.velZ[i] * uz;
          const spd = Math.hypot(sim.velX[i], sim.velY[i], sim.velZ[i]);

          // Is the parked sub nearer than the diver? The FLEE block takes the
          // NEAREST threat, so a row with this high is measuring the vessel.
          const inV = sim.distToVessel[i] < d;
          // Would this observation have been inside the PRE-SPLIT radius? That is
          // the before/after axis, and it is all this can say - it is NOT "a
          // predator is near", which an earlier draft called it and which needs a
          // neighbour query this probe does not do.
          const inP = d < predatorRadius(L);

          let b = 0; while (b < NB - 1 && d >= BANDS[b + 1]) b++;
          tally(byBand[b], rel, vr, spd, d, rP, inV, inP, h);
          const f = d / rP;
          let k = 0; while (k < NF - 1 && f >= FRACS[k + 1]) k++;
          tally(byFrac[k], rel, vr, spd, d, rP, inV, inP, h);
          const lc = classOf(L);
          tally(byFracL[lc][k], rel, vr, spd, d, rP, inV, inP, h);

          const sid = sim.schoolId[i];
          if (sid >= 0) {
            let s = schools.get(sid);
            if (!s) { s = { n: 0, hx: 0, hz: 0, bx: 0, bz: 0, d: 0 }; schools.set(sid, s); }
            s.n++;
            s.hx += Math.sin(hdg); s.hz += Math.cos(hdg);
            // Bearing diver -> school member, so the school mean is the direction
            // the shoal sits in as seen from the diver.
            s.bx += ux; s.bz += uz; s.d += d;
          }
        }

        for (const [sid, s] of schools) {
          if (s.n < MIN_SCHOOL) continue;
          // (i) heading coherence: |mean unit heading|. 1 = the shoal moves as one
          // body, 0 = every member points somewhere different.
          const coh = Math.hypot(s.hx, s.hz) / s.n;
          // (ii) does that mean heading point away from the diver? The bearing
          // diver->school, against the shoal's own mean heading. cos = +1 means
          // the shoal is swimming directly away from where the diver is.
          const hm = Math.atan2(s.hx, s.hz);
          const bm = Math.atan2(s.bx, s.bz);
          const track = Math.cos(wrapPi(hm - bm));
          let a = schoolAcc.get(sid);
          if (!a) { a = { n: 0, coh: 0, track: 0, dSum: 0, members: 0 }; schoolAcc.set(sid, a); }
          a.n++; a.coh += coh; a.track += track; a.dSum += s.d / s.n; a.members += s.n;
        }
      }
      if (travelled >= DIST_TARGET || now > MAX_MS) { resolve(); return; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
} finally {
  // A throw inside the rAF callback never settles the promise, so without
  // this the probe would hang to the 90 s CDP deadline WITH W STILL HELD,
  // and leave the session walking north for whatever ran next.
  g.input.keys.delete('KeyW');
  g.player.simulate = saved.simulate;
  g.player.inVessel = saved.inVessel;
  g.input.enabled = saved.enabled;
  g.input.pointerLocked = saved.locked;
}
const dur = (performance.now() - t0) / 1000;

const summarise = (a, label) => ({
  bin: label,
  n: a.n,
  concentration: a.n ? r3(Math.hypot(a.cos, a.sin) / a.n) : null,
  meanAbsRelDeg: a.n ? r3((a.absRel / a.n) * 180 / Math.PI) : null,
  tailOnFrac: a.n ? r3(a.tailOn / a.n) : null,
  noseOnFrac: a.n ? r3(a.noseOn / a.n) : null,
  meanRadialSpeed_awayFromDiver: a.n ? r3(a.radial / a.n) : null,
  meanWorldSpeed: a.n ? r3(a.speed / a.n) : null,
  meanDist: a.n ? r3(a.dSum / a.n) : null,
  meanPlayerRadius: a.n ? r3(a.rSum / a.n) : null,
  distinctAnimals: a.handles.size,
  fracVesselNearerThanDiver: a.n ? r3(a.inVessel / a.n) : null,
  fracInsidePreSplitRadius: a.n ? r3(a.inPred / a.n) : null,
});
const fracLabel = (k) => (k === NF - 1 ? `>${FRACS[k]} R` : `${FRACS[k]}-${FRACS[k + 1]} R`);

const closestArr = [...closest.values()];
const schoolRows = [...schoolAcc.entries()]
  .filter(([, a]) => a.n >= 4)
  .map(([sid, a]) => ({ schoolId: sid, samples: a.n,
    meanMembersInRange: r3(a.members / a.n),
    headingCoherence: r3(a.coh / a.n),
    meanAwayAlignment: r3(a.track / a.n),
    meanRange: r3(a.dSum / a.n) }))
  .sort((x, y) => x.meanRange - y.meanRange);

return {
  probe: 'facing-normalised',
  setup: { start: START, targetDist: DIST_TARGET, travelled: r3(travelled),
    durationS: r3(dur), meanSpeed: r3(travelled / dur), samples: nSamples,
    observations: byFrac.reduce((s, a) => s + a.n, 0) },
  // The headline. The complaint lives in the first two rows.
  byPanicFraction: byFrac.map((a, k) => summarise(a, fracLabel(k))),
  // The ray question. Read the >1.0 m row against the <0.3 m row.
  byPanicFractionAndSize: LCLASS_NAME.map((name, lc) => ({
    sizeClass: name,
    bins: byFracL[lc].map((a, k) => summarise(a, fracLabel(k))),
  })),
  // Kept so these numbers are comparable with everything already in STATUS.
  byDistanceBand: byBand.map((a, k) => summarise(a, `${BANDS[k]}-${BANDS[k + 1]} m`)),
  // STATUS item C's discriminator. High coherence AND high away-alignment at
  // short range is the shoal turning as a body; high away-alignment with LOW
  // coherence is each fish independently pointing away.
  schools: { counted: schoolRows.length, minMembers: MIN_SCHOOL, rows: schoolRows.slice(0, 24) },
  closestApproach: {
    animalsWithin20m: closestArr.length,
    median: r3(median(closestArr)),
    min: r3(closestArr.length ? Math.min(...closestArr) : null),
    within2m: closestArr.filter((d) => d < 2).length,
    within3m: closestArr.filter((d) => d < 3).length,
    within5m: closestArr.filter((d) => d < 5).length,
  },
  context: { creatureCount: sim.count, nearFieldCount: sp.stats.nearFieldCount,
    drawnInstances: g.creaturePass.stats.instances },
};
