#!/usr/bin/env node
/**
 * Coral-corridor water-classification survey - the evidence that sizes
 * WORLD.WATER_TYPE_DWELL and judges the dive-coral route, offline, no browser.
 *
 * The showcase's dive-coral segment stages 320 m short of the coral anchor and
 * flies its arrival heading down through the waterline, then swims two low
 * legs. The approach corridor is a Reef/Kelp patchwork - STATUS records the
 * best bearing at 64% reef - so the sprung water column flickered and the
 * segment photographed green, which the demo papered over with
 * game.waterColumnPin. The pin is a real-demo violation; the honest fix
 * needs two numbers this probe measures:
 *
 *   1. THE PATCH-TIME HISTOGRAM. _updateWaterColumn classifies at the camera
 *      every frame, so what matters for a temporal dwell is not the minority
 *      SHARE of the corridor but the DURATION of each contiguous non-reef run
 *      at the leg's real speed. A dwell longer than the longest transient
 *      patch makes the column stable without ever lying about a genuine
 *      biome change (which sustains past any dwell).
 *   2. THE BEST STAGING LINE. If patches longer than a reasonable dwell
 *      survive on the wet portion, the staged approach in demo/script.js
 *      moves (distance/bearing are script data, not world data).
 *
 * The walk mirrors the segment: staging = along(view, yaw+PI, 320) at y=80,
 * dive line to (viewX, viewY+2, viewZ), then the two swim legs - BOTH east
 * (yaw+PI-0.25 20 m at floor+1.5, then yaw+PI+0.35 44 m at floor+1.2),
 * re-aimed twice by this probe's own surveys. The anchor sits ON the
 * Reef/Kelp water boundary with the solid reef mass east; the original
 * westward legs crossed 0.5-3.0 s kelp runs, and the first re-aim (leg 2
 * only) still ENDED leg 1 inside the patchwork, where the swimmer's
 * arrive-and-turn camp outlasted the dwell and the capture photographed the
 * coral-swim beat green. ENDPOINTS MATTER AS MUCH AS LINES - a transit-speed
 * model alone missed that - so this probe reports both. Sampling is 2 m of
 * arc, eye
 * y linearly interpolated - the same question _updateWaterColumn asks, point
 * for point, including the real slope (the slope=0 lie collapses the
 * classifier; see waterTypeAt's docstring).
 *
 * Speeds: submerged dive at 0.55 throttle x MAX_SUBSPEED; swims at
 * PLAYER.SWIM_SPEED. The air portion classifies too (the above-water sea takes
 * its optics from the sample under the camera) but is reported separately -
 * only the wet portion drives the dwell.
 *
 * Usage: node tools/probes/coral-corridor.mjs [--sweep]
 *   --sweep   also survey candidate staging bearings/distances for the
 *             route touch-up decision.
 */
import { WORLD, PLAYER, VESSEL, WATER_TYPES } from '../../src/core/constants.js';
import * as terrain from '../../src/world/terrain.js';
import { setBiomeSeed, waterTypeAt } from '../../src/world/biomes.js';
import { resolveBiomeAnchors } from '../../src/world/biome_anchors.js';

terrain.setSeed(WORLD.DEFAULT_SEED);
setBiomeSeed(WORLD.DEFAULT_SEED);

const anchors = resolveBiomeAnchors(terrain);
const coral = anchors.find((a) => a.short === 'coral');
if (!coral) { console.error('no coral anchor'); process.exit(1); }

const REEF_ID = WATER_TYPES.REEF_TURQUOISE.id;
const STEP = 2;                                  // metres of arc per sample
const DIVE_SPEED = 0.55 * VESSEL.MAX_SUBSPEED;   // submerged, segment throttle
const SWIM_SPEED = PLAYER.SWIM_SPEED;

const along = (x, z, yaw, dist) => [x + Math.sin(yaw) * dist, z - Math.cos(yaw) * dist];

/** Classify one eye position the way _updateWaterColumn does. */
function classify(x, y, z) {
  const h = terrain.sampleHeightFast(x, z);
  const slope = terrain.sampleSlope(x, z);
  return waterTypeAt(x, z, h, Math.max(0, -y), slope, terrain).id;
}

/** Sample a straight 3D leg; returns [{x,y,z,id}]. */
function walkLeg(x0, y0, z0, x1, y1, z1) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz);
  const n = Math.max(2, Math.ceil(len / STEP));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = x0 + dx * t, y = y0 + dy * t, z = z0 + dz * t;
    out.push({ x, y, z, id: classify(x, y, z) });
  }
  return out;
}

/** Contiguous same-id runs over samples, in metres and (at `speed`) seconds. */
function runs(samples, speed) {
  const out = [];
  for (const s of samples) {
    const last = out[out.length - 1];
    if (last && last.id === s.id) { last.m += STEP; continue; }
    out.push({ id: s.id, m: STEP });
  }
  for (const r of out) r.s = r.m / speed;
  return out;
}

const typeName = (id) =>
  Object.values(WATER_TYPES).find((t) => t.id === id)?.name ?? `id${id}`;

function report(label, samples, speed) {
  const wet = samples.filter((s) => s.y < 0);
  const share = wet.length
    ? wet.filter((s) => s.id === REEF_ID).length / wet.length : 0;
  const rr = runs(wet, speed).filter((r) => r.id !== REEF_ID);
  const worst = rr.reduce((a, r) => Math.max(a, r.s), 0);
  console.log(`\n  ${label}`);
  console.log(`    wet samples ${wet.length}/${samples.length}, reef share ` +
    `${(100 * share).toFixed(1)}%, speed ${speed.toFixed(1)} m/s`);
  if (rr.length) {
    console.log(`    non-reef patches (${rr.length}): ` +
      rr.map((r) => `${typeName(r.id)} ${r.m}m/${r.s.toFixed(2)}s`).join(', '));
    console.log(`    longest non-reef patch ${worst.toFixed(2)} s`);
  } else {
    console.log('    non-reef patches: none');
  }
  return { share, worst, patches: rr };
}

// --- the segment's actual path ---------------------------------------------
const a = coral;
const [sx, sz] = along(a.viewX, a.viewZ, a.yaw + Math.PI, 320);
const ay = (a.viewY ?? terrain.sampleHeight(a.viewX, a.viewZ) + 2) + 2;
const [l1x, l1z] = along(a.viewX, a.viewZ, a.yaw + Math.PI - 0.25, 20);
const [l2x, l2z] = along(a.viewX, a.viewZ, a.yaw + Math.PI + 0.35, 44);
const l1y = terrain.sampleHeight(l1x, l1z) + 1.5;
const l2y = terrain.sampleHeight(l2x, l2z) + 1.2;

console.log(`coral anchor view (${a.viewX.toFixed(0)}, ${ay.toFixed(1)}, ` +
  `${a.viewZ.toFixed(0)}), yaw ${a.yaw.toFixed(2)}; staging 320 m out at y=80`);

const dive = walkLeg(sx, 80, sz, a.viewX, ay, a.viewZ);
const swim1 = walkLeg(a.viewX, ay, a.viewZ, l1x, l1y, l1z);
const swim2 = walkLeg(l1x, l1y, l1z, l2x, l2y, l2z);

const dParts = [
  report('DIVE leg (staged 320 m line, wet portion)', dive, DIVE_SPEED),
  report('SWIM leg 1 (arrival -> east, yaw+PI-0.25 20 m)', swim1, SWIM_SPEED),
  report('SWIM leg 2 (-> east, yaw+PI+0.35 44 m)', swim2, SWIM_SPEED),
];

// --- waypoint camps ---------------------------------------------------------
// A swimmer ARRIVES at each waypoint and turns, so the camera sits near it
// for seconds - longer than any dwell. A waypoint whose neighbourhood is
// minority-classified therefore commits the wrong type no matter what the
// transit runs said; this is exactly how the first re-aim failed. Report the
// 9x9 m neighbourhood of every point the route stops at.
console.log('\n  waypoint camps (kelp cells in the 9x9 m neighbourhood, of 25):');
for (const [label, x, z] of [
  ['arrival/disembark', a.viewX, a.viewZ],
  ['swim leg 1 end', l1x, l1z],
  ['swim leg 2 end', l2x, l2z],
]) {
  let bad = 0;
  for (let dx = -4; dx <= 4; dx += 2) {
    for (let dz = -4; dz <= 4; dz += 2) {
      if (classify(x + dx, terrain.sampleHeightFast(x + dx, z + dz) + 1.4, z + dz)
          !== REEF_ID) bad++;
    }
  }
  console.log(`    ${label.padEnd(20)} ${bad}/25${bad > 0 ? '  <-- camp risk' : ''}`);
}

// --- dwell sizing -----------------------------------------------------------
// A dwell commits a run only when its duration meets the threshold. Count the
// commits (visible column flips) the whole wet path would produce per dwell.
const wetAll = [
  ...dive.filter((s) => s.y < 0).map((s) => ({ ...s, sp: DIVE_SPEED })),
  ...swim1.filter((s) => s.y < 0).map((s) => ({ ...s, sp: SWIM_SPEED })),
  ...swim2.filter((s) => s.y < 0).map((s) => ({ ...s, sp: SWIM_SPEED })),
];
const allRuns = [];
for (const s of wetAll) {
  const last = allRuns[allRuns.length - 1];
  if (last && last.id === s.id) { last.s += STEP / s.sp; continue; }
  allRuns.push({ id: s.id, s: STEP / s.sp });
}
console.log('\n  dwell sizing over the whole wet path ' +
  `(${allRuns.length - 1} raw transitions):`);
for (const D of [0, 0.5, 1.0, 1.5, 2.0, 3.0]) {
  let committed = REEF_ID, flips = 0;
  for (const r of allRuns) {
    if (r.id !== committed && r.s >= D) { committed = r.id; flips++; }
  }
  console.log(`    dwell ${D.toFixed(1)}s -> ${flips} committed flip(s)`);
}

// --- staging sweep ----------------------------------------------------------
if (process.argv.includes('--sweep')) {
  console.log('\n  staging sweep (wet-portion reef share of the dive line):');
  let best = null;
  for (let db = -60; db <= 60; db += 5) {
    for (let dist = 120; dist <= 360; dist += 40) {
      const yaw = a.yaw + Math.PI + (db * Math.PI) / 180;
      const [x, z] = along(a.viewX, a.viewZ, yaw, dist);
      const leg = walkLeg(x, 80, z, a.viewX, ay, a.viewZ).filter((s) => s.y < 0);
      if (!leg.length) continue;
      const share = leg.filter((s) => s.id === REEF_ID).length / leg.length;
      const rr = runs(leg, DIVE_SPEED).filter((r) => r.id !== REEF_ID);
      const worst = rr.reduce((acc, r) => Math.max(acc, r.s), 0);
      if (!best || share > best.share) best = { db, dist, share, worst };
    }
  }
  console.log(`    best: bearing yaw+PI${best.db >= 0 ? '+' : ''}${best.db} deg, ` +
    `${best.dist} m out -> reef ${(100 * best.share).toFixed(1)}%, ` +
    `longest patch ${best.worst.toFixed(2)}s`);
}

const worstAll = Math.max(...dParts.map((p) => p.worst));
console.log(`\n  VERDICT: longest wet non-reef patch ${worstAll.toFixed(2)} s; ` +
  'a WATER_TYPE_DWELL above that holds the column through the corridor.');
