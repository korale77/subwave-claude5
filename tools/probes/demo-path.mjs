#!/usr/bin/env node
/**
 * Clearance audit for the showcase route (src/demo/script.js), OFFLINE.
 *
 * "Just pick a path where we can see the beauty of coral and fish but not bump
 * into things" is a measurable request, and this is what measures it. For every
 * navigation waypoint the route authors, and for every straight leg between two
 * of them, it reports the minimum distance to the heightfield and to the LIVE
 * scatter collision proxies, and names the prop that comes closest.
 *
 *   node tools/probes/demo-path.mjs                    # the whole route
 *   node tools/probes/demo-path.mjs --segment kelp-dwell
 *   node tools/probes/demo-path.mjs --clear 3.0        # required margin
 *
 * NO BROWSER AND NO TRANSCRIPTION, and both halves of that are deliberate.
 * `world/terrain.js`, `world/scatter.js` and `world/scatter_collision.js` are
 * all device-free and deterministic, so the audit is a pure function of the
 * seed - and the proxies come from a REAL CollisionWorld + ScatterCollision
 * driven to a drained queue, not from a local copy of the capsule transform.
 * A copy of that basis maths is exactly the drift this project keeps paying
 * for (see CLAUDE.md on scatter_emit.js), and it would let the audit pass a
 * route the running game then pushes the camera off.
 *
 * WHAT IT CANNOT SEE, stated rather than implied: kelp is not a collidable row
 * (you swim through fronds on purpose), so a kelp leg is audited against the
 * terrain and against the ROCKS among the stipes - which is what actually
 * grounded the lens on three captured runs - and not against the plants. Fauna
 * is live population and is outside an offline audit entirely.
 */

import { WORLD } from '../../src/core/constants.js';
import { quat } from '../../src/core/math.js';
import * as terrain from '../../src/world/terrain.js';
import { setBiomeSeed } from '../../src/world/biomes.js';
import { CollisionWorld } from '../../src/world/collision.js';
import { ScatterCollision } from '../../src/world/scatter_collision.js';
import { SCATTER_TYPES } from '../../src/world/scatter.js';
import { setCaveSeed, isInsideCave } from '../../src/world/caves.js';
import { SEGMENTS } from '../../src/demo/script.js';
import { HABITAT_SITE } from '../../src/world/habitat_site.js';
import { getBiomeAnchors } from '../../src/world/biome_anchors.js';
import { findSpawnPoint } from '../../src/world/terrain.js';

const args = process.argv.slice(2);
const flag = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const ONLY = flag('--segment', null);
/** Required margin, metres. The player capsule is 0.4 m and a proxy errs
 *  passable by design, so 2.5 m is "the lens never fills with a prop". */
const WANT = Number(flag('--clear', 2.5));
/** Sample spacing along a leg, metres. */
const STEP = 0.5;

terrain.setSeed(WORLD.DEFAULT_SEED);
setBiomeSeed(WORLD.DEFAULT_SEED);
setCaveSeed(WORLD.DEFAULT_SEED);

const collision = new CollisionWorld(terrain, { seed: WORLD.DEFAULT_SEED });
const scatterCol = new ScatterCollision(collision);
const statics = collision.statics;
const TYPE_KEY = SCATTER_TYPES.map((t) => t.key);
const scratch = new Int32Array(512);

/**
 * The minimal `game` the route's point functions read. Every field here is
 * named by src/demo/script.js; nothing else is invented, so a script that grows
 * a new dependency fails loudly rather than resolving a wrong number.
 */
const spawn = findSpawnPoint();
const game = {
  terrain,
  spawn,
  collision,
  // The WALKER. Only the beach approach resolves a waypoint from it (its
  // stand-off is chosen on the side the walker is already coming from), and
  // the segment loop below seats it on each cut so the audit reads the pose
  // the route actually starts each scene from rather than the spawn.
  player: { position: Float64Array.from(spawn.position) },
  vessel: {
    position: Float64Array.from(spawn.vesselPad),
    // THE POSE, NOT JUST THE POSITION. The beach approach resolves its
    // stand-off from the hull's own heading, so a stub with no orientation
    // made that leg UNRESOLVED - which this audit counts as a violation, which
    // is the right outcome but not a useful one. Identity is the pose a
    // cold-booted hull has (main.js sets the pad position and nothing writes a
    // yaw), and teleport writes the same quaternion the real one does.
    orientation: quat.create(),
    piloted: false,
    // The route re-parks the hull in onStart (the beach pad, the cave mouth),
    // and two segments resolve waypoints FROM that pose. Modelling the same
    // call is what keeps the audit on the route the game actually flies -
    // without it the jelly segment audits a 2.4 km leg from the beach.
    teleport(x, y, z, yaw = 0, pitch = 0) {
      this.position[0] = x; this.position[1] = y; this.position[2] = z;
      quat.fromEuler(this.orientation, yaw, pitch, 0);
    },
  },
  creatures: null,
  biomeAnchors: () => getBiomeAnchors(terrain),
};

/** Inside a carved void the heightfield is not the floor - see caves.js. A
 *  corridor waypoint is 80 m "under" the terrain by construction. */
const inCave = (x, y, z) => isInsideCave(x, y, z);

/** Drain the proxy queue around a point so the audit sees every nearby prop. */
function primeAt(x, z) {
  const f = Float32Array.of(x, 0, z);
  scatterCol.update(f, f);
  for (let i = 0; i < 400 && scatterCol._queue.length > 0; i++) scatterCol.update(f, f);
}

/** Distance from a point to a capsule's surface (negative = inside). */
function capsuleDist(id, x, y, z) {
  const ax = statics.ax[id], ay = statics.ay[id], az = statics.az[id];
  const dx = statics.bx[id] - ax, dy = statics.by[id] - ay, dz = statics.bz[id] - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  let t = 0;
  if (len2 > 1e-9) {
    t = ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const px = ax + dx * t, py = ay + dy * t, pz = az + dz * t;
  return Math.hypot(x - px, y - py, z - pz) - statics.r[id];
}

/** Worst clearance over one straight leg. */
function auditLeg(a, b) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const n = Math.max(1, Math.ceil(len / STEP));
  let worstProp = Infinity, worstPropKey = '-', worstPropAt = 0;
  let worstGround = Infinity, worstGroundAt = 0;
  let primeX = Infinity, primeZ = Infinity;
  let cavePoints = 0;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const x = a[0] + (b[0] - a[0]) * u;
    const y = a[1] + (b[1] - a[1]) * u;
    const z = a[2] + (b[2] - a[2]) * u;
    if (Math.abs(x - primeX) > 32 || Math.abs(z - primeZ) > 32) {
      primeAt(x, z); primeX = x; primeZ = z;
    }
    if (!inCave(x, y, z)) {
      const g = y - terrain.sampleHeight(x, z);
      if (g < worstGround) { worstGround = g; worstGroundAt = u * len; }
    } else cavePoints++;
    const m = statics.query(x, y, z, 30, scratch);
    for (let k = 0; k < m; k++) {
      const d = capsuleDist(scratch[k], x, y, z);
      if (d < worstProp) {
        worstProp = d;
        worstPropKey = TYPE_KEY[statics.typeId[scratch[k]]] || `type${statics.typeId[scratch[k]]}`;
        worstPropAt = u * len;
      }
    }
  }
  return { len, worstProp, worstPropKey, worstPropAt, worstGround, worstGroundAt,
    caveFrac: cavePoints / (n + 1) };
}

/** Pull the ordered navigation waypoints out of one segment. */
function waypoints(seg) {
  const out = [];
  for (let i = 0; i < seg.steps.length; i++) {
    const st = seg.steps[i];
    const nav = st.swimTo || st.flyTo || st.walkTo;
    if (!nav) continue;
    const kind = st.swimTo ? 'swimTo' : st.flyTo ? 'flyTo' : 'walkTo';
    const p = new Float64Array(3);
    try {
      if (typeof nav.point === 'function') nav.point(game, p);
      else { p[0] = nav.point[0]; p[1] = nav.point[1]; p[2] = nav.point[2]; }
    } catch (e) {
      out.push({ i, kind, error: e.message });
      continue;
    }
    out.push({ i, kind, p: [p[0], p[1], p[2]] });
  }
  return out;
}

let violations = 0;
console.log(`\nSUBWAVE demo path audit  -  seed ${WORLD.DEFAULT_SEED}, ` +
  `${STEP} m sampling, want >= ${WANT.toFixed(1)} m\n`);

for (const seg of SEGMENTS) {
  if (ONLY && seg.id !== ONLY) continue;
  // A COMPUTED cut names where the scene starts, and the beach opener resolves
  // its walk from exactly that. A string cut is a jumpTo, whose arrival this
  // stub cannot reproduce offline; those segments open with a swim or a fly
  // whose own waypoint is absolute, so nothing reads the pose there.
  if (typeof seg.cut === 'function') {
    try {
      const t = seg.cut(game)?.target;
      if (t && t.x != null && t.z != null) {
        game.player.position[0] = t.x;
        game.player.position[2] = t.z;
        game.player.position[1] = terrain.sampleHeight(t.x, t.z);
      }
    } catch (e) { console.log(`   cut '${seg.id}' threw: ${e.message}`); }
  }
  try { seg.onStart?.(game); } catch (e) { console.log(`   onStart '${seg.id}' threw: ${e.message}`); }
  const wps = waypoints(seg);
  if (wps.length === 0) continue;
  console.log(`-- ${seg.id}`);
  for (const w of wps) {
    if (w.error) { console.log(`   step ${w.i} ${w.kind}: UNRESOLVED (${w.error})`); violations++; }
  }
  const usable = wps.filter((w) => !w.error);
  // The waypoints themselves: a leg can be clear and still park the camera in
  // a prop, which is the failure the delivered Platter frame shows.
  for (const w of usable) {
    primeAt(w.p[0], w.p[2]);
    const cave = inCave(w.p[0], w.p[1], w.p[2]);
    const g = cave ? Infinity : w.p[1] - terrain.sampleHeight(w.p[0], w.p[2]);
    let best = Infinity, key = '-';
    const m = statics.query(w.p[0], w.p[1], w.p[2], 30, scratch);
    for (let k = 0; k < m; k++) {
      const d = capsuleDist(scratch[k], w.p[0], w.p[1], w.p[2]);
      if (d < best) { best = d; key = TYPE_KEY[statics.typeId[scratch[k]]] || '?'; }
    }
    const bad = best < WANT || g < 1.0;
    if (bad) violations++;
    console.log(`   ${bad ? 'XX' : 'ok'} wp step ${String(w.i).padStart(2)} ${w.kind.padEnd(7)}` +
      ` ground ${(cave ? '  cave' : g.toFixed(1).padStart(6))} m   prop ` +
      `${(best === Infinity ? '   inf' : best.toFixed(1).padStart(6))} m  ${key}`);
  }
  for (let i = 1; i < usable.length; i++) {
    const r = auditLeg(usable[i - 1].p, usable[i].p);
    // A leg that crosses a carved mouth reads 0 m of "ground" at the lip by
    // construction - the heightfield is breached there and the hull flies
    // through the hole. The prop check still applies; the terrain one cannot.
    const bad = r.worstProp < WANT || (r.caveFrac === 0 && r.worstGround < 1.0);
    if (bad) violations++;
    console.log(`   ${bad ? 'XX' : 'ok'} leg ${String(usable[i - 1].i).padStart(2)}->` +
      `${String(usable[i].i).padStart(2)} ${r.len.toFixed(0).padStart(4)} m   ` +
      `ground ${(r.worstGround === Infinity ? '  cave' : r.worstGround.toFixed(1).padStart(6))} m ` +
      `@${r.worstGroundAt.toFixed(0)}   ` +
      `prop ${(r.worstProp === Infinity ? '   inf' : r.worstProp.toFixed(1).padStart(6))} m ` +
      `@${r.worstPropAt.toFixed(0)}  ${r.worstPropKey}` +
      (r.caveFrac > 0 ? `   [${(r.caveFrac * 100).toFixed(0)}% in cave]` : ''));
  }
}

console.log(`\n${violations ? `${violations} clearance violation(s)` : 'every audited waypoint and leg is clear'}`);
console.log('NOTE kelp rows are not collidable; kelp legs are audited against terrain and rock only.\n');
process.exitCode = violations ? 1 : 0;
