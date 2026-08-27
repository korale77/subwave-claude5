#!/usr/bin/env node
/**
 * Gaze audit for the showcase route (src/demo/script.js), OFFLINE.
 *
 * "There's a part where the camera just looks down at the ground" is the
 * playtest note this answers, and it is measurable without a browser: every
 * navigable step authors an eye path (`point`) and a gaze target (`look`), both
 * pure functions of the terrain, so the DEPRESSION ANGLE of each leg is known
 * before a frame is rendered. This walks the route and prints, per leg, the
 * pitch at the start and at the end of the leg plus the worst value along it,
 * and it names the legs that spend real time below the floor-ward threshold.
 *
 *   node tools/probes/demo-gaze.mjs                  # the whole route
 *   node tools/probes/demo-gaze.mjs --segment kelp-dwell
 *   node tools/probes/demo-gaze.mjs --down 20        # flag pitch below -20 deg
 *
 * WHAT IT CANNOT SEE, stated rather than implied. The director eases the gaze
 * (LOOK_TAU, the rate and acceleration clamps) and blends the last `lead`
 * metres of a leg onto the next step's look point, so the DELIVERED pitch lags
 * the authored one by a fraction of a second and rounds every corner. It also
 * cannot see fauna: `watchFauna` aims at a live animal, so a benthic subject
 * points the lens down by however much the animal is below the diver, and only
 * the authored `scanPitch` is visible here. Both make this a screen on the
 * AUTHORED geometry - a leg it clears can still deliver a floor-ward frame, and
 * the capture harness is what shows that.
 *
 * The eye is the waypoint plus the swimming eye height, matching demo/director
 * `_eye()` (player.position + currentEyeHeight); a flyTo leg's eye is the hull
 * origin, which is what the cockpit camera is rigidly attached to.
 */

import { PLAYER, WORLD } from '../../src/core/constants.js';
import { quat } from '../../src/core/math.js';
import * as terrain from '../../src/world/terrain.js';
import { setBiomeSeed } from '../../src/world/biomes.js';
import { setCaveSeed } from '../../src/world/caves.js';
import { SEGMENTS } from '../../src/demo/script.js';
import { getBiomeAnchors } from '../../src/world/biome_anchors.js';
import { findSpawnPoint } from '../../src/world/terrain.js';

const args = process.argv.slice(2);
const flag = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const ONLY = flag('--segment', null);
/** Depression angle, degrees, at which a leg reads as "looking at the floor". */
const DOWN = Number(flag('--down', 20));
/** Samples along a leg. */
const N = 24;

terrain.setSeed(WORLD.DEFAULT_SEED);
setBiomeSeed(WORLD.DEFAULT_SEED);
setCaveSeed(WORLD.DEFAULT_SEED);

const spawn = findSpawnPoint();
const game = {
  terrain,
  spawn,
  player: { position: Float64Array.from(spawn.position) },
  vessel: {
    position: Float64Array.from(spawn.vesselPad),
    orientation: quat.create(),
    piloted: false,
    teleport(x, y, z, yaw = 0, pitch = 0) {
      this.position[0] = x; this.position[1] = y; this.position[2] = z;
      quat.fromEuler(this.orientation, yaw, pitch, 0);
    },
  },
  creatures: null,
  biomeAnchors: () => getBiomeAnchors(terrain),
};

const resolve = (pt, out) => {
  if (typeof pt === 'function') return pt(game, out);
  out[0] = pt[0]; out[1] = pt[1]; out[2] = pt[2];
  return out;
};

const pitchDeg = (eye, tgt) => {
  const dx = tgt[0] - eye[0], dy = tgt[1] - eye[1], dz = tgt[2] - eye[2];
  return Math.atan2(dy, Math.max(Math.hypot(dx, dz), 1e-3)) * 180 / Math.PI;
};

const _a = new Float64Array(3), _b = new Float64Array(3), _e = new Float64Array(3);

console.log(`\nSUBWAVE demo gaze audit  -  seed ${WORLD.DEFAULT_SEED}, ` +
  `flagging authored pitch below -${DOWN.toFixed(0)} deg\n`);
let flagged = 0;

for (const seg of SEGMENTS) {
  if (ONLY && seg.id !== ONLY) continue;
  if (typeof seg.cut === 'function') {
    try {
      const t = seg.cut(game)?.target;
      if (t && t.x != null && t.z != null) {
        game.player.position[0] = t.x;
        game.player.position[2] = t.z;
        game.player.position[1] = terrain.sampleHeight(t.x, t.z);
      }
    } catch { /* a string cut has no offline arrival */ }
  }
  try { seg.onStart?.(game); } catch { /* onStart may need the live game */ }

  const rows = [];
  let prev = null;                       // previous navigable waypoint (eye path)
  // A STRING CUT'S ARRIVAL CANNOT BE REPRODUCED OFFLINE (it is a jumpTo, with
  // every latch and re-seat that path owns), so until the segment's first
  // navigable waypoint resolves there is no honest eye to measure a gaze from.
  // Reporting one anyway is how this probe first printed a 2,379 m sight line
  // on the jelly opener: the eye was still standing on the beach.
  let eyeKnown = typeof seg.cut !== 'string';
  for (let i = 0; i < seg.steps.length; i++) {
    const st = seg.steps[i];
    const nav = st.swimTo || st.flyTo || st.walkTo;
    const kind = st.swimTo ? 'swimTo' : st.flyTo ? 'flyTo' : st.walkTo ? 'walkTo'
      : st.dwell?.look ? 'dwell' : st.lookAt ? 'lookAt' : null;
    if (!kind) {
      if (st.watchFauna && st.watchFauna.scanPitch != null) {
        rows.push({ i, kind: 'fauna', a: st.watchFauna.scanPitch * 180 / Math.PI,
          b: st.watchFauna.scanPitch * 180 / Math.PI, worst: 0, note: st.watchFauna.name || '' });
      }
      continue;
    }
    let eyeA, eyeB, look;
    try {
      if (nav) {
        resolve(nav.point, _b);
        eyeB = [_b[0], _b[1], _b[2]];
        eyeA = prev ? prev.slice() : eyeB.slice();
        prev = eyeB.slice();
        look = nav.look ? [...resolve(nav.look, _a)] : eyeB.slice();
      } else {
        // A gaze-only step: the eye stands where the last waypoint left it.
        if (!prev && !eyeKnown) continue;
        eyeA = eyeB = prev ? prev.slice() : [...game.player.position];
        look = [...resolve(st.dwell ? st.dwell.look : st.lookAt.point, _a)];
      }
    } catch (e) { rows.push({ i, kind, error: e.message }); continue; }

    const eyeUp = st.flyTo ? 0 : PLAYER.EYE_HEIGHT;
    // A BARE NAV STEP AIMS AT ITS OWN WAYPOINT, AND ITS LAST METRES ARE NEVER
    // AIMED AT IT. Without `look` the gaze target IS the destination, so the
    // pitch at the waypoint itself is atan2(-eyeHeight, 0) = -90 deg by
    // construction - which this probe duly printed for every walkTo inside the
    // station, twelve violations that are an artifact of the measurement. Two
    // things end that approach in the director and both are inside the lead
    // window: the step finishes at `arriveR`, and over the last `lead` metres
    // the gaze has already blended onto the NEXT step's look point
    // (_navBlend / _peekNextNav). So the sampling stops at the lead, which is
    // the last range at which the authored waypoint is still the whole gaze.
    const LEAD = { swimTo: 9, walkTo: 5, flyTo: 110 };
    const stop = nav && !nav.look
      ? Math.max(nav.lead ?? LEAD[kind], (nav.arriveR ?? 2.5) + 0.5) : 0;
    const sample = (u) => {
      _e[0] = eyeA[0] + (eyeB[0] - eyeA[0]) * u;
      _e[1] = eyeA[1] + (eyeB[1] - eyeA[1]) * u + eyeUp;
      _e[2] = eyeA[2] + (eyeB[2] - eyeA[2]) * u;
      const d = Math.hypot(look[0] - _e[0], look[1] - _e[1], look[2] - _e[2]);
      return d <= stop ? null : pitchDeg(_e, look);
    };
    let worst = Infinity, worstAt = 0, a = null, b = null;
    for (let k = 0; k <= N; k++) {
      const u = k / N;
      const p = sample(u);
      if (p == null) continue;
      if (a == null) a = p;
      b = p;
      if (p < worst) { worst = p; worstAt = u; }
    }
    if (a == null) {
      // Shorter than its own lead window: the gaze is blended toward the next
      // step for the whole leg, so there is no authored depression angle here
      // to report. Every leg of the cave transit is like this by design.
      rows.push({ i, kind, error: 'leg is shorter than its lead window' });
      continue;
    }
    const range = Math.hypot(look[0] - eyeB[0], look[1] - eyeB[1] - eyeUp, look[2] - eyeB[2]);
    rows.push({ i, kind, a, b, worst, worstAt, range: Math.max(range, stop) });
  }
  if (!rows.length) continue;
  console.log(`-- ${seg.id}`);
  for (const r of rows) {
    if (r.error) { console.log(`   step ${r.i} ${r.kind}: UNRESOLVED (${r.error})`); continue; }
    if (r.kind === 'fauna') {
      console.log(`   -- step ${String(r.i).padStart(2)} fauna   scanPitch ` +
        `${r.a.toFixed(1).padStart(6)} deg  (aims at a live animal: ${r.note})`);
      continue;
    }
    const bad = r.worst < -DOWN;
    if (bad) flagged++;
    console.log(`   ${bad ? 'XX' : 'ok'} step ${String(r.i).padStart(2)} ${r.kind.padEnd(7)}` +
      ` pitch ${r.a.toFixed(1).padStart(6)} -> ${r.b.toFixed(1).padStart(6)} deg` +
      `   worst ${r.worst.toFixed(1).padStart(6)} @${(r.worstAt * 100).toFixed(0)}%` +
      `   gaze range ${r.range.toFixed(0).padStart(4)} m`);
  }
}
console.log(`\n${flagged ? `${flagged} leg(s) authored below -${DOWN} deg` : 'no leg is authored into the floor'}\n`);
