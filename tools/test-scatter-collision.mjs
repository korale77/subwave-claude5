#!/usr/bin/env node
/**
 * SUBWAVE static scatter collision verification (backlog 3.5), offline.
 *
 * Runs the real scatter bake, the real proxy streamer and the real capsule and
 * hull resolvers against the real terrain, headless. Asserts:
 *   1. the authored proxy table covers exactly the collidable rows;
 *   2. every authored capsule still fits the mesh its row actually ships
 *      (rebuilt here from the row's own meshParams, so the table cannot drift
 *      the way the test-meshgen registry sizes did);
 *   3. proxies register deterministically for a known chunk, a query at a
 *      ventChimney instance hits it, and no soft-flora instance ever gets one;
 *   4. the second hash holds the real static population of two dense 3x3
 *      rings with zero overflow (the entity hash could not: 2,048 slots);
 *   5. a swimmer holding W into a vent chimney is held outside its radius,
 *      position-level, with no velocity smoothing anywhere near the swim model;
 *   6. WORLD.SCATTER_COLLISION = 0 reproduces the proxy-free trajectories
 *      bit for bit (the bisect);
 *   7. the vessel hull takes contact against a proxy at speed, does not
 *      tunnel, and reports an impact.
 *
 * Usage: node tools/test-scatter-collision.mjs
 */

import * as terrain from '../src/world/terrain.js';
import {
  CollisionWorld, createCapsuleContact, createHullContact,
  VESSEL_HULL_PROBES, VESSEL_HULL_PROBE_COUNT, VESSEL_PROBE_RADIUS,
} from '../src/world/collision.js';
import { ScatterCollision, PROXY_CAPSULES } from '../src/world/scatter_collision.js';
import {
  SCATTER_TYPES, SCATTER_BY_KEY, SCATTER_FLAG, generateScatterForChunk,
} from '../src/world/scatter.js';
import { scatterGeneratorArgs } from '../src/render/scatter_emit.js';
import * as meshgen from '../src/world/meshgen.js';
import { PLACES } from '../src/world/places.js';
import { WORLD, PLAYER, VESSEL } from '../src/core/constants.js';
import { vec3, quat } from '../src/core/math.js';

let failures = 0;
let checks = 0;
const fmt = (v, d = 3) => (typeof v === 'number' ? v.toFixed(d) : String(v));

function check(name, condition, detail) {
  checks++;
  if (condition) console.log(`  ok   ${name}${detail ? '   ' + detail : ''}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? '   ' + detail : ''}`); }
}

function section(title) {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

terrain.setSeed(WORLD.DEFAULT_SEED);
const CHUNK = WORLD.CHUNK_SIZE;

// ---------------------------------------------------------------------------
section('1. proxy table coverage');

{
  const collidable = SCATTER_TYPES.filter((t) => t.collidable).map((t) => t.key);
  const authored = Object.keys(PROXY_CAPSULES);
  const missing = collidable.filter((k) => !authored.includes(k));
  const extra = authored.filter((k) => !SCATTER_BY_KEY[k] || !SCATTER_BY_KEY[k].collidable);
  check('every collidable row has a proxy', missing.length === 0,
    missing.length ? 'missing: ' + missing.join(' ') : `${collidable.length} rows covered`);
  check('no proxy for a non-collidable row', extra.length === 0,
    extra.length ? 'extra: ' + extra.join(' ') : 'soft flora stays soft');
}

// ---------------------------------------------------------------------------
section('2. authored capsules fit the shipped meshes (drift guard)');

{
  let worst = '';
  let allInside = true, allRadii = true;
  for (const t of SCATTER_TYPES) {
    if (!t.collidable) continue;
    const mesh = meshgen[t.generator](
      ...scatterGeneratorArgs(t, { ...t.meshParams, detail: t.maxDetail }));
    const pos = mesh.positions, idx = mesh.indices;
    let yMin = Infinity, yMax = -Infinity, xMin = Infinity, xMax = -Infinity,
      zMin = Infinity, zMax = -Infinity;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (y < yMin) yMin = y; if (y > yMax) yMax = y;
      if (x < xMin) xMin = x; if (x > xMax) xMax = x;
      if (z < zMin) zMin = z; if (z > zMax) zMax = z;
    }
    let rMax = 0;
    for (let i = 0; i < mesh.indexCount; i += 3) {
      const i0 = idx[i];
      const r = Math.hypot(pos[i0 * 3], pos[i0 * 3 + 2]);
      if (r > rMax) rMax = r;
    }
    // Inflate the AABB 25%: a capsule endpoint is a CENTRE, its surface may
    // graze the hull, and the authored numbers round.
    const gx = (xMax - xMin) * 0.25 + 0.3, gy = (yMax - yMin) * 0.25 + 0.3,
      gz = (zMax - zMin) * 0.25 + 0.3;
    for (const cap of PROXY_CAPSULES[t.key]) {
      for (const [x, y, z] of [[cap[0], cap[1], cap[2]], [cap[3], cap[4], cap[5]]]) {
        if (x < xMin - gx || x > xMax + gx || y < yMin - gy || y > yMax + gy ||
            z < zMin - gz || z > zMax + gz) {
          allInside = false;
          worst = `${t.key} endpoint (${x},${y},${z}) outside y[${fmt(yMin, 2)},${fmt(yMax, 2)}]`;
        }
      }
      if (cap[6] > rMax * 1.2 || cap[6] < rMax * 0.02) {
        allRadii = false;
        worst = `${t.key} r ${cap[6]} vs mesh rMax ${fmt(rMax, 2)}`;
      }
    }
  }
  check('every capsule endpoint lies inside its mesh envelope', allInside, worst);
  check('every capsule radius is inside [0.02, 1.2] x mesh max radius', allRadii, worst);
}

// ---------------------------------------------------------------------------
section('3. registration at Emberthroat: hits a ventChimney, never a seagrass');

const ember = PLACES.find((p) => p.short === 'ember');
const collision = new CollisionWorld(terrain, { seed: WORLD.DEFAULT_SEED });
const sc = new ScatterCollision(collision);
const focus = Float32Array.of(ember.x, ember.seabedY, ember.z);

{
  // Drain the whole ring: one bake per update, 3x3 = at most 9 + margin.
  for (let i = 0; i < 24; i++) sc.update(focus, focus);
  check('the 3x3 ring registered', sc.stats.chunksLive === 9,
    `${sc.stats.chunksLive} chunks, ${sc.stats.proxiesLive} proxies, ` +
    `worst bake ${fmt(sc.stats.worstBakeMs, 2)} ms`);

  // Find the delivered ventChimney instance nearest the place centre, from the
  // same pure bake the streamer used.
  const chimneyId = SCATTER_BY_KEY.ventChimney.id;
  const ccx = Math.floor(ember.x / CHUNK), ccz = Math.floor(ember.z / CHUNK);
  let best = null, bestD = Infinity;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const r = generateScatterForChunk(ccx + dx, ccz + dz, 0, { collidableOnly: true });
      const u8 = new Uint8Array(r.instances.buffer);
      for (let i = 0; i < r.count; i++) {
        if (u8[i * 64 + 61] !== chimneyId) continue;
        const x = (ccx + dx) * CHUNK + r.instances[i * 16 + 3];
        const y = r.instances[i * 16 + 7];
        const z = (ccz + dz) * CHUNK + r.instances[i * 16 + 11];
        const d = Math.hypot(x - ember.x, z - ember.z);
        if (d < bestD) { bestD = d; best = [x, y, z]; }
      }
    }
  }
  check('Emberthroat delivers a ventChimney instance', best !== null,
    best ? `nearest at r=${fmt(bestD, 1)} m from the place centre` : 'none in the ring');

  const hits = new Int32Array(64);
  const n = collision.statics.query(best[0], best[1] + 2, best[2], 2.5, hits);
  let chimneyHit = false;
  for (let i = 0; i < n; i++) {
    if (collision.statics.typeId[hits[i]] === chimneyId) chimneyHit = true;
  }
  check('a query at that instance returns its chimney proxy', chimneyHit,
    `${n} candidates within 2.5 m`);

  // No soft-flora proxy anywhere: scan every live slot.
  const seagrassId = SCATTER_BY_KEY.seagrass.id;
  const kelpId = SCATTER_BY_KEY.kelpStalk ? SCATTER_BY_KEY.kelpStalk.id : -1;
  let soft = 0;
  const st = collision.statics;
  for (let i = 0; i < st.capacity; i++) {
    if (!st.present[i]) continue;
    const t = SCATTER_TYPES[st.typeId[i]];
    if (!t || !t.collidable) soft++;
    if (st.typeId[i] === seagrassId || st.typeId[i] === kelpId) soft++;
  }
  check('no proxy carries a non-collidable type (seagrass, kelp, ...)', soft === 0,
    `${st.count} live proxies scanned`);

  // Determinism: a second world building the same ring lands the same shapes.
  const collision2 = new CollisionWorld(terrain, { seed: WORLD.DEFAULT_SEED });
  const sc2 = new ScatterCollision(collision2);
  for (let i = 0; i < 24; i++) sc2.update(focus, focus);
  const st2 = collision2.statics;
  let sum1 = 0, sum2 = 0;
  for (let i = 0; i < st.capacity; i++) {
    if (st.present[i]) sum1 += st.ax[i] + st.ay[i] + st.az[i] + st.bx[i] + st.by[i] + st.bz[i] + st.r[i];
    if (st2.present[i]) sum2 += st2.ax[i] + st2.ay[i] + st2.az[i] + st2.bx[i] + st2.by[i] + st2.bz[i] + st2.r[i];
  }
  check('registration is deterministic (same seed, same shapes)',
    st.count === st2.count && sum1 === sum2,
    `${st.count} proxies, coordinate sum ${fmt(sum1, 4)}`);
}

// ---------------------------------------------------------------------------
section('4. the second hash holds two dense rings, zero overflow');

{
  const cw = new CollisionWorld(terrain, { seed: WORLD.DEFAULT_SEED });
  const s = new ScatterCollision(cw);
  // Two DISJOINT dense shallow rings (coral garden and reef water measured
  // 950+ collidable instances in single chunks - the worst known density).
  const fa = Float32Array.of(600, -10, 900);
  const fb = Float32Array.of(700, -12, -350);
  for (let i = 0; i < 40; i++) s.update(fa, fb);

  let expected = 0;
  for (const [x, z] of [[600, 900], [700, -350]]) {
    const ccx = Math.floor(x / CHUNK), ccz = Math.floor(z / CHUNK);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const r = generateScatterForChunk(ccx + dx, ccz + dz, 0, { collidableOnly: true });
        const u8 = new Uint8Array(r.instances.buffer);
        for (let i = 0; i < r.count; i++) {
          if (u8[i * 64 + 63] & SCATTER_FLAG.COLLIDABLE) expected++;
        }
      }
    }
  }
  check('18 chunks registered', s.stats.chunksLive === 18, `${s.stats.chunksLive}`);
  check('the hash holds at least the real static count', cw.statics.count >= expected,
    `${cw.statics.count} proxies >= ${expected} collidable instances`);
  check('zero overflow at the densest known pairing', cw.statics.overflow === 0,
    `capacity ${cw.statics.capacity}, used ${cw.statics.count}`);
  check('the entity hash could not have held them', expected > 2048,
    `${expected} > 2048 (the recorded sizing error)`);
}

// ---------------------------------------------------------------------------
section('5. a swimmer holding W into a chimney is held outside it');

{
  // The nearest chimney proxy to the Emberthroat centre, from the hash itself.
  const chimneyId = SCATTER_BY_KEY.ventChimney.id;
  const st = collision.statics;
  let target = -1, tD = Infinity;
  for (let i = 0; i < st.capacity; i++) {
    if (!st.present[i] || st.typeId[i] !== chimneyId) continue;
    const d = Math.hypot(st.mx[i] - ember.x, st.mz[i] - ember.z);
    if (d < tD) { tD = d; target = i; }
  }
  const axp = st.mx[target], azp = st.mz[target];
  const rw = st.r[target];

  // True separation between the player capsule and the (tilted) proxy
  // capsule: min over 64 samples of the proxy segment of the point-to-segment
  // distance to the player's vertical axis. Measuring against one endpoint's
  // XZ was wrong for a chimney aligned to a 0.23 slope.
  const separation = (body) => {
    const pAy0 = body.position[1] + body.radius;
    const pAy1 = body.position[1] + body.height - body.radius;
    let min = Infinity;
    for (let k = 0; k <= 64; k++) {
      const u = k / 64;
      const sx = st.ax[target] + (st.bx[target] - st.ax[target]) * u;
      const sy = st.ay[target] + (st.by[target] - st.ay[target]) * u;
      const sz = st.az[target] + (st.bz[target] - st.az[target]) * u;
      const cy = Math.min(Math.max(sy, pAy0), pAy1);
      const d = Math.hypot(sx - body.position[0], sy - cy, sz - body.position[2]);
      if (d < min) min = d;
    }
    return min;
  };

  // A capsule body 3 m out at the chimney's own depth, driven straight at the
  // axis at sprint speed for 5 simulated seconds. Velocity is REWRITTEN toward
  // the axis every step, so the contact must hold position-level, every step.
  const body = {
    position: vec3.create(axp + 3, st.ay[target], azp),
    velocity: vec3.create(),
    radius: PLAYER.RADIUS,
    height: PLAYER.HEIGHT,
  };
  const contact = createCapsuleContact();
  const dt = 1 / 60;
  let minSep = Infinity;
  for (let i = 0; i < 300; i++) {
    const dx = axp - body.position[0], dz = azp - body.position[2];
    const l = Math.hypot(dx, dz) || 1;
    body.velocity[0] = (dx / l) * PLAYER.SWIM_SPRINT_SPEED;
    body.velocity[1] = 0;
    body.velocity[2] = (dz / l) * PLAYER.SWIM_SPRINT_SPEED;
    collision.resolveCapsule(body, dt, contact, 0);
    const sep = separation(body);
    if (sep < minSep) minSep = sep;
  }
  const floor = rw + PLAYER.RADIUS - 0.05;
  check('held outside the proxy radius for 5 s of held sprint', minSep >= floor,
    `min capsule separation ${fmt(minSep)} m >= ${fmt(floor)} m ` +
    `(proxy r ${fmt(rw, 2)}, residual penetration ${fmt(Math.max(0, rw + PLAYER.RADIUS - minSep))} m)`);
  check('contact reported as a wall, not smoothed', contact.wallHit === true,
    `wallNormal (${fmt(contact.wallNormal[0], 2)}, ${fmt(contact.wallNormal[2], 2)})`);
}

// ---------------------------------------------------------------------------
section('6. WORLD.SCATTER_COLLISION = 0 is the pre-proxy game, bit for bit');

{
  // Aim the trajectory THROUGH the chimney proxy section 5 collided with, so
  // the un-gated run demonstrably has something to differ about.
  const chimneyId = SCATTER_BY_KEY.ventChimney.id;
  const st = collision.statics;
  let target = -1, tD = Infinity;
  for (let i = 0; i < st.capacity; i++) {
    if (!st.present[i] || st.typeId[i] !== chimneyId) continue;
    const d = Math.hypot(st.mx[i] - ember.x, st.mz[i] - ember.z);
    if (d < tD) { tD = d; target = i; }
  }
  const start = vec3.create(st.mx[target] + 4, st.my[target], st.mz[target]);
  const run = (world) => {
    const body = {
      position: vec3.clone(start), velocity: vec3.create(),
      radius: PLAYER.RADIUS, height: PLAYER.HEIGHT,
    };
    const c = createCapsuleContact();
    const trace = [];
    for (let i = 0; i < 120; i++) {
      body.velocity[0] = -2.5; body.velocity[1] = 0; body.velocity[2] = 0;
      world.resolveCapsule(body, 1 / 60, c, 0);
      trace.push(body.position[0], body.position[1], body.position[2]);
    }
    return trace;
  };

  WORLD.SCATTER_COLLISION = 0;
  const gated = run(collision);              // proxies REGISTERED but gated off
  WORLD.SCATTER_COLLISION = 1;
  const bare = run(new CollisionWorld(terrain, { seed: WORLD.DEFAULT_SEED })); // never had proxies
  const live = run(collision);               // proxies live again

  let identical = gated.length === bare.length;
  for (let i = 0; i < gated.length && identical; i++) identical = gated[i] === bare[i];
  let differs = false;
  for (let i = 0; i < live.length; i++) if (live[i] !== bare[i]) { differs = true; break; }
  check('gated trajectory is bit-identical to a proxy-free world', identical,
    `${gated.length / 3} steps compared`);
  check('...and the un-gated one actually differs (the feature exists)', differs);
}

// ---------------------------------------------------------------------------
section('7. the vessel hull takes contact and does not tunnel');

{
  const chimneyId = SCATTER_BY_KEY.ventChimney.id;
  const st = collision.statics;
  let target = -1, tD = Infinity;
  for (let i = 0; i < st.capacity; i++) {
    if (!st.present[i] || st.typeId[i] !== chimneyId) continue;
    const d = Math.hypot(st.mx[i] - ember.x, st.mz[i] - ember.z);
    if (d < tD) { tD = d; target = i; }
  }
  const cx = (st.ax[target] + st.bx[target]) * 0.5;
  const cy = (st.ay[target] + st.by[target]) * 0.5;
  const cz = (st.az[target] + st.bz[target]) * 0.5;

  // A rigid hull, 30 m out at the chimney's mid height, closing at the
  // submerged top speed. Free flight plus the contact solver - no force model,
  // so the only thing that can stop it IS the proxy contact.
  const body = {
    position: vec3.create(cx - 30, cy, cz),
    orientation: quat.create(),
    velocity: vec3.create(VESSEL.MAX_SUBSPEED, 0, 0),
    angularVelocity: vec3.create(),
    mass: VESSEL.MASS,
    inertia: VESSEL.INERTIA,
  };
  const out = createHullContact();
  const dt = 1 / 60;
  let contacts = 0, worstImpact = 0, minDist = Infinity, crossed = false;
  for (let i = 0; i < 240; i++) {
    vec3.scaleAndAdd(body.position, body.position, body.velocity, dt);
    collision.resolveVesselHull(
      body, VESSEL_HULL_PROBES, VESSEL_HULL_PROBE_COUNT, VESSEL_PROBE_RADIUS,
      dt, out, 0);
    if (out.contacts > 0) {
      contacts += out.contacts;
      if (out.impactSpeed > worstImpact) worstImpact = out.impactSpeed;
    }
    const d = cx - body.position[0];
    if (d < minDist && Math.abs(body.position[2] - cz) < 4) minDist = d;
    if (body.position[0] > cx + 2) crossed = true;
  }
  check('the hull contacted the proxy', contacts > 0, `${contacts} probe contacts`);
  check('an impact speed was measured', worstImpact > 1,
    `${fmt(worstImpact, 1)} m/s closing (arrived at ${VESSEL.MAX_SUBSPEED} m/s)`);
  check('the hull did not tunnel through the chimney', !crossed,
    `final x offset ${fmt(body.position[0] - cx, 2)} m (negative = held before the axis)`);
}

// ---------------------------------------------------------------------------
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
