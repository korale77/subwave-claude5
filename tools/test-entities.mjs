#!/usr/bin/env node
/**
 * SUBWAVE entity physics verification.
 *
 * Runs the real Vessel and Player integrators against the real terrain and the
 * real CPU wave field, headless, and asserts the behaviours the design promises.
 * Every number printed is measured, not asserted from a table.
 *
 * Usage: node tools/test-entities.mjs
 * Exit code is non-zero if any check fails.
 */

import * as terrain from '../src/world/terrain.js';
import { CollisionWorld, createRayHit, createCapsuleContact, SpatialHash } from '../src/world/collision.js';
import { Vessel } from '../src/entities/vessel.js';
import { Player, PLAYER_STATE_NAMES } from '../src/entities/player.js';
import { buildVesselMesh, buildHullSections } from '../src/entities/vessel_mesh.js';
import { VESSEL, PLAYER as P, WORLD, oxygenDepthMultiplier } from '../src/core/constants.js';
import { FIXED_DT } from '../src/core/time.js';
import { vec3, quat } from '../src/core/math.js';
import { events, EVENTS } from '../src/core/events.js';

let failures = 0;
let checks = 0;

const fmt = (v, d = 3) => (typeof v === 'number' ? v.toFixed(d) : String(v));

function check(name, condition, detail) {
  checks++;
  if (condition) {
    console.log(`  ok   ${name}${detail ? '   ' + detail : ''}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? '   ' + detail : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

// ---------------------------------------------------------------------------
// A stub input device: every action reads a value from a plain object.
// ---------------------------------------------------------------------------

class StubInput {
  constructor() {
    this.axes = {};
    this.down = {};
    this.pressed = {};
    this.lookX = 0;
    this.lookY = 0;
  }
  axis(a) { return this.axes[a] || 0; }
  isDown(a) { return !!this.down[a]; }
  wasPressed(a) { return !!this.pressed[a]; }
  wasReleased() { return false; }
  look(out) { out[0] = this.lookX; out[1] = this.lookY; return out; }
  moveVector(out) {
    out[0] = this.axis('moveRight');
    out[1] = this.axis('moveForward');
    return out;
  }
  clearEdges() { this.pressed = {}; }
}

// ---------------------------------------------------------------------------

terrain.setSeed(WORLD.DEFAULT_SEED);
const collision = new CollisionWorld(terrain, { seed: WORLD.DEFAULT_SEED });
collision.setSeaState(2, 0.6);

// Survey the generated world once so the tests below run over REAL ground and
// REAL open water rather than over hard-coded coordinates that a terrain tweak
// would silently invalidate.
const survey = (() => {
  let highest = -Infinity, hx = 0, hz = 0;
  let deepest = Infinity, dx = 0, dz = 0;
  for (let x = -3000; x <= 3000; x += 50) {
    for (let z = -3000; z <= 3000; z += 50) {
      const h = terrain.sampleHeight(x, z);
      if (h > highest) { highest = h; hx = x; hz = z; }
      if (h < deepest) { deepest = h; dx = x; dz = z; }
    }
  }
  return { highest, hx, hz, deepest, dx, dz };
})();
console.log(`world survey: peak ${survey.highest.toFixed(1)} m at (${survey.hx}, ${survey.hz}), ` +
  `deepest ${survey.deepest.toFixed(1)} m at (${survey.dx}, ${survey.dz})`);

// ===========================================================================
section('0. Math: quat.lookRotation builds a right-handed basis');
// ===========================================================================
{
  // lookRotation shipped for a long time with both of its cross products in the
  // wrong argument order, which negated `right` and left `up` alone: a
  // determinant -1 basis. fromMat3 reads a reflection as garbage and
  // quat.normalize hides it, so nothing threw - EVERY purely horizontal forward
  // came back as the identity, i.e. facing north. That is not a numerical
  // tolerance to guard, it is a handedness invariant, so this asserts the
  // determinant directly rather than only the round trip.
  const q = quat.create();
  const f = vec3.create(), u = vec3.create(), r = vec3.create(), d = vec3.create();
  let worstFwd = 0, minDet = Infinity, upFailures = 0, worstDir = null;
  const dirs = [];
  // A spiral over the whole sphere, plus the degenerate axes by hand.
  for (let i = 0; i < 40; i++) {
    const a = i * 2.3998, b = (i / 40) * Math.PI - Math.PI / 2;
    dirs.push([Math.cos(b) * Math.sin(a), Math.sin(b), -Math.cos(b) * Math.cos(a)]);
  }
  dirs.push([0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]);
  for (const c of dirs) {
    vec3.normalize(d, vec3.set(d, c[0], c[1], c[2]));
    quat.lookRotation(q, d);
    quat.forward(f, q); quat.up(u, q); quat.right(r, q);
    const err = Math.hypot(f[0] - d[0], f[1] - d[1], f[2] - d[2]);
    if (err > worstFwd) { worstFwd = err; worstDir = c; }
    // det[right, up, -forward] must be +1 for a right-handed basis.
    const nx = -f[0], ny = -f[1], nz = -f[2];
    const det = r[0] * (u[1] * nz - u[2] * ny)
      - r[1] * (u[0] * nz - u[2] * nx)
      + r[2] * (u[0] * ny - u[1] * nx);
    minDet = Math.min(minDet, det);
    // Away from the poles the frame must be the upright one, not the flipped one.
    if (Math.abs(d[1]) < 0.999 && u[1] <= 0) upFailures++;
  }
  check('lookRotation reproduces the direction it was given',
    worstFwd < 1e-5,
    `worst forward error ${worstFwd.toExponential(2)} over ${dirs.length} directions` +
    (worstDir ? ` (at ${worstDir.map((v) => fmt(v, 2)).join(', ')})` : ''));
  check('lookRotation builds a RIGHT-handed basis', minDet > 0.9999,
    `min det[right, up, -forward] = ${fmt(minDet, 6)}, must be +1 (a reflection reads -1)`);
  check('lookRotation keeps +Y upright away from the poles', upFailures === 0,
    `${upFailures} of ${dirs.length} directions came back inverted`);
  // With the default up reference it must agree exactly with the Euler builder,
  // which is what the vessel's attitude target uses.
  let worstEuler = 0;
  const qe = quat.create();
  for (const yaw of [0, 0.9, -2.2, 3.0, 1.5708]) {
    for (const p of [0, 0.5, -0.7, 1.3, -1.4]) {
      const cp = Math.cos(p);
      vec3.set(d, Math.sin(yaw) * cp, Math.sin(p), -Math.cos(yaw) * cp);
      quat.lookRotation(q, d);
      quat.fromEuler(qe, yaw, p, 0);
      // q and -q are the same rotation, so compare on the near hemisphere.
      const s = quat.dot(q, qe) < 0 ? -1 : 1;
      for (let i = 0; i < 4; i++) worstEuler = Math.max(worstEuler, Math.abs(q[i] * s - qe[i]));
    }
  }
  check('lookRotation(dir, worldUp) equals fromEuler(yaw, pitch, 0)',
    worstEuler < 1e-5, `max |dq| = ${worstEuler.toExponential(2)}`);
}

// ===========================================================================
section('1. Mesh and hull sections');
// ===========================================================================
{
  const mesh = buildVesselMesh({ tier: 2 });
  let nonFinite = 0;
  for (let i = 0; i < mesh.vertices.length; i++) {
    if (!Number.isFinite(mesh.vertices[i])) nonFinite++;
  }
  check('mesh has no non-finite vertex data', nonFinite === 0,
    `verts=${mesh.vertexCount} tris=${mesh.indexCount / 3}`);

  let badWinding = 0, faces = 0;
  const F = 12, d = mesh.vertices, ix = mesh.indices;
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i] * F, b = ix[i + 1] * F, c = ix[i + 2] * F;
    const e1x = d[b] - d[a], e1y = d[b + 1] - d[a + 1], e1z = d[b + 2] - d[a + 2];
    const e2x = d[c] - d[a], e2y = d[c + 1] - d[a + 1], e2z = d[c + 2] - d[a + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) continue;
    faces++;
    if ((nx * d[a + 3] + ny * d[a + 4] + nz * d[a + 5]) / l < -0.15) badWinding++;
  }
  check('every face winds with its vertex normal', badWinding === 0,
    `${badWinding}/${faces} inverted`);

  const s = buildHullSections(15);
  let vol = 0;
  for (let i = 0; i < s.count; i++) vol += s.area[i] * s.dz[i];
  check('hull section volume equals VESSEL.DISPLACEMENT',
    Math.abs(vol - VESSEL.DISPLACEMENT) < 1e-4,
    `${fmt(vol, 5)} m^3 vs ${VESSEL.DISPLACEMENT}`);
}

// ===========================================================================
section('2. Vessel: full throttle climb in air');
// ===========================================================================
{
  const v = new Vessel(collision);
  vec3.set(v.position, 0, 260, 0);
  v.ballastVolume = 0;
  const input = new StubInput();
  input.axes.moveUp = 1;      // full collective
  input.axes.throttle = 1;    // full forward translation

  let maxSpeed = 0, maxY = -Infinity, nonFinite = 0;
  const y0 = v.position[1];
  for (let i = 0; i < 3000; i++) {
    v.simulate(FIXED_DT, input, i * FIXED_DT);
    const sp = vec3.len(v.velocity);
    if (sp > maxSpeed) maxSpeed = sp;
    if (v.position[1] > maxY) maxY = v.position[1];
    if (!vec3.isFinite(v.position) || !vec3.isFinite(v.velocity) ||
        !Number.isFinite(v.orientation[3])) nonFinite++;
  }
  const climbed = v.position[1] - y0;
  check('state stays finite over 3000 steps', nonFinite === 0, `${nonFinite} bad steps`);
  check('climbs under full collective', climbed > 100,
    `climbed ${fmt(climbed, 1)} m in ${fmt(3000 * FIXED_DT, 1)} s, peak ${fmt(maxY, 1)} m`);
  check('peak speed within 10% of VESSEL.MAX_AIRSPEED',
    maxSpeed <= VESSEL.MAX_AIRSPEED * 1.10,
    `peak ${fmt(maxSpeed, 2)} m/s vs limit ${fmt(VESSEL.MAX_AIRSPEED * 1.1, 2)} m/s ` +
    `(Vne ${VESSEL.MAX_AIRSPEED})`);
  check('attitude stays sane (|roll| < 30 deg)',
    Math.abs(quat.toEuler(v.orientation).roll) < 0.52,
    `roll ${fmt(quat.toEuler(v.orientation).roll * 57.2958, 2)} deg, ` +
    `pitch ${fmt(quat.toEuler(v.orientation).pitch * 57.2958, 2)} deg`);
}

// ===========================================================================
section('3. Vessel: neutral ballast depth hold');
// ===========================================================================
{
  const v = new Vessel(collision);
  vec3.set(v.position, survey.dx, -120, survey.dz);
  v.stationKeeping = false;   // no thruster depth hold: buoyancy and ballast only
  v.trimNeutral();

  const d0 = -v.position[1];
  let maxDrift = 0, maxThrust = 0, sumThrust = 0;
  const steps = Math.round(60 / FIXED_DT);
  for (let i = 0; i < steps; i++) {
    v.simulate(FIXED_DT, new StubInput(), i * FIXED_DT);
    const drift = Math.abs(-v.position[1] - d0);
    if (drift > maxDrift) maxDrift = drift;
    const t = v.totalThrust;
    if (t > maxThrust) maxThrust = t;
    sumThrust += t;
  }
  check('neutral fill is the analytic neutral point',
    Math.abs(v.neutralBallastFraction() - 0.5164) < 0.001,
    `fill ${fmt(v.neutralBallastFraction(), 4)} (VESSEL.BALLAST_NEUTRAL preset ${VESSEL.BALLAST_NEUTRAL})`);
  check('depth held within 2 m over 60 s', maxDrift < 2.0,
    `max drift ${fmt(maxDrift, 4)} m from ${fmt(d0, 1)} m`);
  check('the hold is buoyancy, not thrust', maxThrust < 20,
    `mean thrust ${fmt(sumThrust / steps, 2)} N, peak ${fmt(maxThrust, 2)} N ` +
    `(weight ${fmt(v.mass * WORLD.GRAVITY, 0)} N)`);
}

// ===========================================================================
section('4. Vessel: air <-> water transition');
// ===========================================================================
{
  const v = new Vessel(collision);
  // Start well clear of the island so the seabed is far below.
  vec3.set(v.position, survey.dx, 45, survey.dz);
  // Nose down 40 degrees and dive.
  quat.fromEuler(v.orientation, 0, -0.70, 0);
  quat.copy(v.prevOrientation, v.orientation);
  vec3.set(v.velocity, 0, -20, 0);
  v.ballastVolume = VESSEL.BALLAST_VOLUME * 0.6;
  // No vertical hold, so the vessel actually commits to the dive.
  v.stationKeeping = false;

  const input = new StubInput();
  let maxDv = 0, maxDvStep = -1, nonFinite = 0;
  let sawEntry = false, minBeta = 1, maxBeta = 0;
  const prev = vec3.create();
  const steps = Math.round(12 / FIXED_DT);
  for (let i = 0; i < steps; i++) {
    vec3.copy(prev, v.velocity);
    v.simulate(FIXED_DT, input, i * FIXED_DT);
    const dv = vec3.dist(prev, v.velocity);
    if (dv > maxDv) { maxDv = dv; maxDvStep = i; }
    if (!vec3.isFinite(v.velocity) || !Number.isFinite(v.orientation[3])) nonFinite++;
    if (v.beta > 0.5) sawEntry = true;
    minBeta = Math.min(minBeta, v.beta);
    maxBeta = Math.max(maxBeta, v.beta);
  }
  // Bound: the solver clamps linear acceleration to MAX_LINEAR_ACCEL
  // (DESIGN/04.4.3), so no fixed step may change velocity by more than
  // MAX_LINEAR_ACCEL * FIXED_DT. Terrain contact impulses are excluded - there is
  // no terrain within 500 m of this test.
  //
  // The clamp is 120 m/s^2, not the 45 it was: 45 sat BELOW the ordinary drag
  // deceleration at the vessel's own design speed, so it fired throughout normal
  // cruise instead of only in extremis. See MAX_LINEAR_ACCEL in vessel.js.
  const bound = 120 * FIXED_DT;   // 2.0 m/s at 60 Hz
  check('vessel actually crossed the surface', sawEntry,
    `beta swept ${fmt(minBeta, 3)} -> ${fmt(maxBeta, 3)}, final depth ${fmt(v.depth, 2)} m`);
  check('no NaN through the transition', nonFinite === 0, `${nonFinite} bad steps`);
  check(`no per-step velocity jump above ${fmt(bound, 3)} m/s`, maxDv <= bound * 1.001,
    `max |dv| = ${fmt(maxDv, 4)} m/s at step ${maxDvStep}`);
  check('hull survived the entry', v.hull > 0,
    `hull ${fmt(v.hull, 1)}%, entry speed ${fmt(v.lastEntrySpeed, 2)} m/s, ` +
    `angle ${fmt(v.lastEntryAngle * 57.2958, 1)} deg`);
}

// ===========================================================================
section('5. Vessel: skip off the surface');
// ===========================================================================
{
  // Swept over approach heights, because a skip is a WAVE-PHASE-DEPENDENT event
  // and testing one phase tests luck.
  //
  // A skip requires the hull to be closing on the surface along its local normal
  // (`vn < 0`). Cross on the receding back of a wave and that is false, so no
  // skip is possible however shallow and fast the approach - which is correct
  // physics, not a missing feature. This test used to launch from exactly 3.0 m
  // and passed because that trajectory happened to arrive on a rising face; the
  // approach is slightly different now that the ballast trims itself, it arrives
  // on a falling one, and a single-phase assertion called that a regression.
  const heights = [2.0, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5];
  let skipped = 0, totalSkips = 0;
  const angles = [];
  for (const h of heights) {
    const v = new Vessel(collision);
    vec3.set(v.position, survey.dx, h, survey.dz);
    quat.identity(v.orientation);
    quat.copy(v.prevOrientation, v.orientation);
    // Shallow (about 5 deg) and fast: the skip envelope.
    vec3.set(v.velocity, 0, -4.0, -45.0);
    v.stationKeeping = false;

    let skips = 0;
    const off = events.on(EVENTS.VESSEL_SKIP, () => skips++);
    for (let i = 0; i < 240; i++) v.simulate(FIXED_DT, new StubInput(), i * FIXED_DT);
    off();
    if (skips > 0) skipped++;
    totalSkips += skips;
    angles.push(fmt(v.lastEntryAngle * 57.2958, 1));
  }
  check('a shallow high-speed entry skips off the surface',
    skipped >= Math.ceil(heights.length * 0.5),
    `${skipped}/${heights.length} approach heights skipped, ${totalSkips} skips total; ` +
    `entry angles ${angles.join(', ')} deg (skip envelope < ` +
    `${fmt(VESSEL.SKIP_ANGLE * 57.2958, 1)} deg and closing)`);
}

// ===========================================================================
section('5b. Vessel: no tunnelling at the new top speeds');
// ===========================================================================
{
  // Terrain contact is a 14-PROBE query, not a swept test - collision.js explains
  // why a sweep is the wrong shape for a height field that re-meshes as you move.
  // Probes can in principle step past thin geometry, and at MAX_AIRSPEED a 60 Hz
  // step travels 2 m, so this asserts the thing that would break first.
  //
  // It does not, and the reason is geometric: the hull is 7.4 m long and 2.6 m
  // tall, so a 2 m step cannot carry it through anything the probes would have
  // caught. This test exists to keep that true - it fails the moment someone
  // raises the speed ceiling far enough, or shrinks the hull, for the step to
  // approach the hull's own size.
  const results = [];
  for (const speed of [VESSEL.MAX_SUBSPEED, VESSEL.MAX_AIRSPEED * 0.67, VESSEL.MAX_AIRSPEED]) {
    const v = new Vessel(collision);
    // Straight at the island's summit from 2 km out, at half its height.
    vec3.set(v.position, survey.hx - 2000, survey.highest * 0.5, survey.hz);
    quat.fromEuler(v.orientation, Math.PI / 2, 0, 0);      // heading east
    quat.copy(v.prevOrientation, v.orientation);
    vec3.set(v.velocity, speed, 0, 0);
    v.board();                        // seed the aim from the hull, not due north
    v.aimYaw = Math.PI / 2;
    v.prevAimYaw = v.aimYaw;
    v.stationKeeping = false;
    const input = new StubInput();
    input.axes.throttle = 1;

    let deepestInside = 0, maxPen = 0, nonFinite = 0;
    for (let i = 0; i < 3000; i++) {
      v.simulate(FIXED_DT, input, i * FIXED_DT);
      const ground = terrain.sampleHeight(v.position[0], v.position[2]);
      deepestInside = Math.min(deepestInside, v.position[1] - ground);
      maxPen = Math.max(maxPen, v._hullContact.maxPenetration || 0);
      if (!vec3.isFinite(v.position) || !vec3.isFinite(v.velocity)) nonFinite++;
    }
    results.push({ speed, deepestInside, maxPen, nonFinite, step: speed * FIXED_DT });
  }
  const worstInside = Math.min(...results.map((r) => r.deepestInside));
  const worstPen = Math.max(...results.map((r) => r.maxPen));
  const bad = results.reduce((a, r) => a + r.nonFinite, 0);
  check('the hull centre never ends a step below the terrain', worstInside > -1.0,
    results.map((r) => `${fmt(r.speed, 0)} m/s (${fmt(r.step, 2)} m/step): ` +
      `inside ${fmt(r.deepestInside, 2)} m`).join(', '));
  check('contact penetration stays within the solver\'s reach', worstPen < 3.0,
    `worst penetration ${fmt(worstPen, 2)} m against a ${fmt(VESSEL.LENGTH, 1)} m hull`);
  check('flying into an island at Vne stays finite', bad === 0, `${bad} bad steps`);
}

// ===========================================================================
section('5c. Vessel: roll stability');
// ===========================================================================
{
  // Reported from play: "it easily flips/rolls left and right, quite unstable."
  //
  // The hard case is HOVERING SUBMERGED, and it is hard for a real reason: at neutral
  // buoyancy with no thrust there is nothing for the flight computer to vector, so the
  // hull has to be passively stable on its own. It was not. Roll had no fin damping at
  // all (the aero block has a roll-rate term, the hydro block had only the generic
  // HYDRO_ANG_* figures, and those came from a table for a SLENDER hull), and 0.28 m of
  // CoB-above-CoM gave the roll mode a 5.7 s period with almost no damping.
  //
  // Measured before: a roll disturbance at hover peaked at 56 deg and was still 25 deg
  // off level ten seconds later.
  const cases = [
    { label: 'hovering at depth', y: -200, throttle: 0, maxPeak: 0.60, maxResidual: 0.09 },
    { label: 'cruising at depth', y: -200, throttle: 1, maxPeak: 0.35, maxResidual: 0.05 },
  ];
  for (const c of cases) {
    const v = new Vessel(collision);
    vec3.set(v.position, survey.dx, c.y, survey.dz);
    quat.identity(v.orientation);
    quat.copy(v.prevOrientation, v.orientation);
    v.board();
    v.aimYaw = 0; v.aimPitch = 0; v.prevAimYaw = 0; v.prevAimPitch = 0;
    const input = new StubInput();
    input.axes.throttle = c.throttle;
    for (let i = 0; i < 900; i++) v.simulate(FIXED_DT, input, i * FIXED_DT);

    // Kick it: 1.2 rad/s of roll rate about the hull's own forward axis, hands off.
    const fwd = vec3.create();
    quat.forward(fwd, v.orientation);
    vec3.scaleAndAdd(v.angularVelocity, v.angularVelocity, fwd, 1.2);

    const e = { yaw: 0, pitch: 0, roll: 0 };
    let peak = 0;
    for (let i = 0; i < 600; i++) {
      v.simulate(FIXED_DT, input, (900 + i) * FIXED_DT);
      quat.toEuler(v.orientation, e);
      peak = Math.max(peak, Math.abs(e.roll));
    }
    quat.toEuler(v.orientation, e);
    const residual = Math.abs(e.roll);
    check(`a roll disturbance settles while ${c.label}`,
      peak < c.maxPeak && residual < c.maxResidual,
      `peaked at ${fmt(peak * 57.2958, 1)} deg, back to ` +
      `${fmt(residual * 57.2958, 1)} deg after 10 s ` +
      `(limits ${fmt(c.maxPeak * 57.2958, 0)} / ${fmt(c.maxResidual * 57.2958, 0)} deg)`);
  }
}

// ===========================================================================
section('6. Collision: raycast');
// ===========================================================================
{
  const hit = createRayHit();
  const origin = vec3.create();
  const dir = vec3.create();
  let hits = 0, maxSteps = 0, totalSteps = 0, exhausted = 0, maxError = 0;
  const N = 400;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const x = Math.cos(a) * 220, z = Math.sin(a) * 220;
    vec3.set(origin, x, terrain.sampleHeight(x, z) + 180, z);
    vec3.set(dir, 0, -1, 0);
    collision.raycast(origin, dir, 400, hit);
    if (hit.hit) {
      hits++;
      const err = Math.abs(hit.point[1] - terrain.sampleHeight(hit.point[0], hit.point[2]));
      if (err > maxError) maxError = err;
    }
    if (hit.exhausted) exhausted++;
    totalSteps += hit.steps;
    if (hit.steps > maxSteps) maxSteps = hit.steps;
  }
  check('every downward ray finds the ground', hits === N, `${hits}/${N}`);
  check('no ray exhausted its step budget', exhausted === 0, `${exhausted}`);
  check('hit point lies on the surface', maxError < 0.02,
    `max |y - h(x,z)| = ${fmt(maxError, 5)} m`);
  console.log(`       mean ${fmt(totalSteps / N, 1)} steps/ray, worst ${maxSteps}`);

  // Oblique rays through varied terrain.
  let obliqueHits = 0, obliqueMaxErr = 0;
  for (let i = 0; i < 200; i++) {
    const a = (i / 200) * Math.PI * 2;
    vec3.set(origin, Math.cos(a) * 400, 90, Math.sin(a) * 400);
    vec3.set(dir, -Math.cos(a) * 0.6, -0.7, -Math.sin(a) * 0.6);
    vec3.normalize(dir, dir);
    collision.raycast(origin, dir, 600, hit);
    if (hit.hit) {
      obliqueHits++;
      const err = Math.abs(hit.point[1] - terrain.sampleHeight(hit.point[0], hit.point[2]));
      if (err > obliqueMaxErr) obliqueMaxErr = err;
    }
  }
  check('oblique rays resolve to the surface too', obliqueMaxErr < 0.05,
    `${obliqueHits}/200 hits, max error ${fmt(obliqueMaxErr, 5)} m`);
}

// ===========================================================================
section('7. Collision: spatial hash');
// ===========================================================================
{
  const hash = new SpatialHash(4096, 16, 4096);
  const px = new Float32Array(4096);
  const py = new Float32Array(4096);
  const pz = new Float32Array(4096);
  let seed = 12345;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 4096; i++) {
    px[i] = (rnd() - 0.5) * 2000;
    py[i] = (rnd() - 0.5) * 400;
    pz[i] = (rnd() - 0.5) * 2000;
    hash.insert(i, px[i], py[i], pz[i]);
  }
  const out = new Int32Array(4096);
  let mismatches = 0;
  for (let q = 0; q < 60; q++) {
    const qx = (rnd() - 0.5) * 2000, qy = (rnd() - 0.5) * 400, qz = (rnd() - 0.5) * 2000;
    const r = 10 + rnd() * 60;
    const n = hash.queryRadius(qx, qy, qz, r, out);
    let brute = 0;
    for (let i = 0; i < 4096; i++) {
      if (Math.hypot(px[i] - qx, py[i] - qy, pz[i] - qz) <= r) brute++;
    }
    if (n !== brute) mismatches++;
    // Duplicate check.
    const seen = new Set();
    for (let i = 0; i < n; i++) {
      if (seen.has(out[i])) { mismatches++; break; }
      seen.add(out[i]);
    }
  }
  check('queryRadius matches brute force and never duplicates', mismatches === 0,
    `${mismatches} mismatching queries over 60`);

  for (let i = 0; i < 2048; i++) hash.remove(i);
  check('remove keeps the count consistent', hash.count === 2048, `count ${hash.count}`);
  let stillThere = 0;
  for (let q = 0; q < 20; q++) {
    const n = hash.queryRadius(px[q], py[q], pz[q], 0.001, out);
    if (n > 0) stillThere++;
  }
  check('removed entities are gone', stillThere === 0, `${stillThere} ghosts`);
}

// ===========================================================================
section('8. Collision: water surface agrees with itself');
// ===========================================================================
{
  const s = collision.waterSurfaceAt(37.5, -12.25, 8.0);
  const h = collision.waterHeightAt(37.5, -12.25, 8.0);
  check('waterSurfaceAt and waterHeightAt agree', Math.abs(s.y - h) < 1e-5,
    `${fmt(s.y, 6)} vs ${fmt(h, 6)}`);
  check('surface normal is normalised and up',
    Math.abs(vec3.len(s.normal) - 1) < 1e-5 && s.normal[1] > 0.5,
    `n = ${vec3.str(s.normal, 4)}`);

  // Determinism: the same query must be bit-identical across calls.
  const a = collision.waterHeightAt(101.3, 55.7, 12.5);
  const b = collision.waterHeightAt(101.3, 55.7, 12.5);
  check('wave field is deterministic', a === b, `${a} === ${b}`);

  let min = Infinity, max = -Infinity;
  for (let i = 0; i < 2000; i++) {
    const y = collision.waterHeightAt(i * 3.7, i * -2.1, i * 0.05);
    if (y < min) min = y;
    if (y > max) max = y;
  }
  check('wave heights are bounded and finite',
    Number.isFinite(min) && Number.isFinite(max) && max - min < 6,
    `range ${fmt(min, 3)} .. ${fmt(max, 3)} m at sea state 2`);
}

// ===========================================================================
section('9. Player: 10000 steps on real terrain');
// ===========================================================================
{
  const p = new Player(collision);
  // Start on the highest ground the generator produced.
  const sx = survey.hx, sz = survey.hz;
  vec3.set(p.position, sx, terrain.sampleHeight(sx, sz) + 0.5, sz);
  p.oxygen = p.oxygenCapacity;

  const input = new StubInput();
  let minClearance = Infinity;
  let maxHorizontal = 0;      // while walking on walkable ground
  let maxAnySpeed = 0;        // including slides and falls
  let nonFinite = 0;
  let slideSteps = 0;
  let footsteps = 0;
  const offStep = events.on(EVENTS.PLAYER_FOOTSTEP, () => footsteps++);

  for (let i = 0; i < 10000; i++) {
    // A wandering walk: turn slowly, sprint in bursts, jump occasionally.
    const t = i * FIXED_DT;
    input.axes.moveForward = 1;
    input.axes.moveRight = Math.sin(t * 0.37) * 0.6;
    input.down.sprint = (i % 600) < 300;
    input.pressed.jump = (i % 420) === 0;
    input.lookX = Math.sin(t * 0.11) * 0.004;
    p.simulate(FIXED_DT, input, t);
    input.clearEdges();

    const ground = terrain.sampleHeight(p.position[0], p.position[2]);
    const clearance = p.position[1] - ground;
    if (clearance < minClearance) minClearance = clearance;
    const hs = Math.hypot(p.velocity[0], p.velocity[2]);
    if (hs > maxAnySpeed) maxAnySpeed = hs;
    if (p.grounded && p.walkable) {
      if (hs > maxHorizontal) maxHorizontal = hs;
    } else if (!p.walkable) {
      slideSteps++;
    }
    if (!vec3.isFinite(p.position) || !vec3.isFinite(p.velocity)) nonFinite++;
  }
  offStep();

  check('player state stays finite', nonFinite === 0, `${nonFinite} bad steps`);
  // The footprint sampler takes the MAXIMUM height over the capsule footprint,
  // so the feet can legitimately sit above the centre sample on a ridge; what
  // must never happen is going below it.
  check('player never falls through the terrain', minClearance > -0.35,
    `min feet-above-centre-sample ${fmt(minClearance, 4)} m`);
  check('horizontal speed never exceeds run speed under power',
    maxHorizontal <= P.RUN_SPEED * 1.02,
    `peak ${fmt(maxHorizontal, 4)} m/s vs RUN_SPEED ${P.RUN_SPEED}; ` +
    `peak including gravity-driven slides ${fmt(maxAnySpeed, 4)} m/s over ${slideSteps} slide steps`);
  check('footsteps fired while walking', footsteps > 100, `${footsteps} steps`);
  console.log(`       ended at ${vec3.str(p.position, 1)}, state ${PLAYER_STATE_NAMES[p.state]}, ` +
    `stamina ${fmt(p.stamina, 1)}`);
}

// ===========================================================================
section('10. Player: oxygen drain and refill');
// ===========================================================================
{
  const p = new Player(collision);
  const input = new StubInput();

  // --- surface: no drain -----------------------------------------------
  vec3.set(p.position, survey.dx, 20, survey.dz);
  p.oxygen = p.oxygenCapacity * 0.5;
  const startAir = p.oxygen;
  for (let i = 0; i < 300; i++) p.simulate(FIXED_DT, input, i * FIXED_DT);
  check('oxygen refills in air', p.oxygen > startAir,
    `${fmt(startAir, 1)} -> ${fmt(p.oxygen, 1)} s over 5 s`);

  // --- submerged idle at 10 m ------------------------------------------
  const p2 = new Player(collision);
  vec3.set(p2.position, survey.dx, -10, survey.dz);
  vec3.set(p2.velocity, 0, 0, 0);
  p2.oxygen = p2.oxygenCapacity;
  const o0 = p2.oxygen;
  for (let i = 0; i < 600; i++) {
    p2.simulate(FIXED_DT, input, i * FIXED_DT);
    p2.position[1] = -10;          // pin the depth so the comparison is exact
    p2.velocity[1] = 0;
  }
  const drained10 = o0 - p2.oxygen;
  check('submerged oxygen drains', drained10 > 0,
    `${fmt(drained10, 3)} s of tank used in 10 s at ${fmt(p2.depth, 1)} m`);

  // --- submerged idle at 60 m: pressure multiplies consumption ----------
  const p3 = new Player(collision);
  vec3.set(p3.position, survey.dx, -60, survey.dz);
  p3.oxygen = p3.oxygenCapacity;
  const o1 = p3.oxygen;
  for (let i = 0; i < 600; i++) {
    p3.simulate(FIXED_DT, input, i * FIXED_DT);
    p3.position[1] = -60;
    p3.velocity[1] = 0;
  }
  const drained60 = o1 - p3.oxygen;
  const ratio = drained60 / drained10;
  // The eye sits PLAYER.EYE_HEIGHT above the feet, and depth is measured at
  // the eye, so a capsule pinned at y = -10 breathes at 10 - 1.68 m.
  const expected = oxygenDepthMultiplier(60 - P.EYE_HEIGHT) /
    oxygenDepthMultiplier(10 - P.EYE_HEIGHT);
  check('depth multiplies consumption per oxygenDepthMultiplier()',
    Math.abs(ratio - expected) < 0.08,
    `measured ${fmt(ratio, 4)}x, expected ${fmt(expected, 4)}x ` +
    `(${fmt(drained60, 2)} s vs ${fmt(drained10, 2)} s per 10 s)`);

  // --- drowning ---------------------------------------------------------
  const p4 = new Player(collision);
  vec3.set(p4.position, survey.dx, -30, survey.dz);
  p4.oxygen = 0.01;
  const h0 = p4.health;
  for (let i = 0; i < Math.round(8 / FIXED_DT); i++) {
    p4.simulate(FIXED_DT, input, i * FIXED_DT);
    p4.position[1] = -30;
    p4.velocity[1] = 0;
  }
  check('drowning costs health once the grace expires', p4.health < h0,
    `health ${fmt(h0, 1)} -> ${fmt(p4.health, 1)} after 8 s dry`);

  // --- warnings ---------------------------------------------------------
  const p5 = new Player(collision);
  vec3.set(p5.position, survey.dx, -8, survey.dz);
  p5.oxygen = P.OXYGEN_WARN + 1;
  let warnings = [];
  const off = events.on(EVENTS.PLAYER_OXYGEN_LOW, (e) => warnings.push(e.tier));
  for (let i = 0; i < Math.round(40 / FIXED_DT); i++) {
    p5.simulate(FIXED_DT, input, i * FIXED_DT);
    p5.position[1] = -8;
    p5.velocity[1] = 0;
  }
  off();
  check('oxygen warnings escalate warn -> critical -> empty',
    warnings.includes('warn') && warnings.includes('critical') && warnings.includes('empty'),
    `tiers seen: ${warnings.join(', ') || 'none'}`);
}

// ===========================================================================
section('11. Player: waterline transition');
// ===========================================================================
{
  const p = new Player(collision);
  const input = new StubInput();
  vec3.set(p.position, survey.dx, 14, survey.dz);
  vec3.set(p.velocity, 0, -8, 0);
  let entered = 0, exited = 0;
  const offA = events.on(EVENTS.PLAYER_ENTER_WATER, () => entered++);
  const offB = events.on(EVENTS.PLAYER_EXIT_WATER, () => exited++);
  let maxDv = 0, deepest = Infinity;
  const prev = vec3.create();
  for (let i = 0; i < 900; i++) {
    vec3.copy(prev, p.velocity);
    p.simulate(FIXED_DT, input, i * FIXED_DT);
    const dv = vec3.dist(prev, p.velocity);
    if (dv > maxDv) maxDv = dv;
    if (p.position[1] < deepest) deepest = p.position[1];
  }
  offA(); offB();
  check('entering the water fires PLAYER_ENTER_WATER', entered === 1, `${entered} events`);
  // The largest step change is the water's drag on a 20 m/s plunge, which is
  // a genuine 4.8 g deceleration, not a solver discontinuity.
  check('no velocity discontinuity at the waterline', maxDv < 1.0,
    `max |dv| ${fmt(maxDv, 4)} m/s per step`);
  check('the player stops sinking and rises again',
    p.position[1] > deepest + 1.0 && p.velocity[1] > 0,
    `plunged to ${fmt(deepest, 2)} m, now at ${fmt(p.position[1], 2)} m ` +
    `rising at ${fmt(p.velocity[1], 3)} m/s, state ${PLAYER_STATE_NAMES[p.state]}`);
}

// ===========================================================================
section('12. Boarding round trip');
// ===========================================================================
{
  const v = new Vessel(collision);
  const p = new Player(collision);
  vec3.set(v.position, survey.dx, 1.0, survey.dz);
  const hatch = vec3.create();
  v.hatchPosition(hatch);
  vec3.set(p.position, hatch[0], hatch[1] - 1.0, hatch[2] + 1.0);

  check('player can board within BOARD_RANGE', v.canBoard(p.position),
    `distance ${fmt(vec3.dist(hatch, p.position), 2)} m, range ${VESSEL.BOARD_RANGE}`);
  p.enterVessel(v);
  check('boarding sets inVessel', p.inVessel && v.piloted, '');
  for (let i = 0; i < 120; i++) {
    v.simulate(FIXED_DT, new StubInput(), i * FIXED_DT);
    p.simulateInVessel(FIXED_DT, v);
  }
  check('oxygen is topped up while piloting', p.oxygen >= p.oxygenCapacity - 1e-3,
    `${fmt(p.oxygen, 1)} / ${fmt(p.oxygenCapacity, 1)} s`);
  p.exitVessel(v);
  check('disembarking clears inVessel', !p.inVessel && !v.piloted,
    `player at ${vec3.str(p.position, 2)}`);
}

// ===========================================================================
section('13. Vessel: 20000-step randomised stability fuzz');
// ===========================================================================
{
  const v = new Vessel(collision);
  vec3.set(v.position, survey.dx, 12, survey.dz);
  const input = new StubInput();
  let seed = 0xc0ffee;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  let nonFinite = 0, maxSpeed = 0, maxOmega = 0, crossings = 0;
  let wasWet = false, maxDv = 0;
  let maxDvContacts = 0, maxFreeDv = 0, maxDvImpulse = false;
  // IMPULSIVE events legitimately step the velocity outside the acceleration
  // clamp: a terrain contact resolves with sequential impulses, and skipping off
  // the water reflects the normal component of the velocity outright. Track them so
  // the checks below can tell "the vessel hit something" from "the solver came
  // apart", which a single loose threshold cannot.
  let impulseThisStep = false;
  const offImpulse = [
    events.on(EVENTS.VESSEL_SKIP, () => { impulseThisStep = true; }),
    events.on(EVENTS.VESSEL_ENTER_WATER, () => { impulseThisStep = true; }),
  ];
  const prev = vec3.create();
  for (let i = 0; i < 20000; i++) {
    if (i % 37 === 0) {
      input.axes.throttle = rnd() * 2 - 1;
      input.axes.moveRight = rnd() * 2 - 1;
      input.axes.moveUp = rnd() * 2 - 1;
      input.axes.roll = rnd() * 2 - 1;
      input.lookX = (rnd() - 0.5) * 0.03;
      input.lookY = (rnd() - 0.5) * 0.03;
      if (rnd() < 0.05) v.stationKeeping = rnd() < 0.5;
    }
    vec3.copy(prev, v.velocity);
    impulseThisStep = false;
    v.simulate(FIXED_DT, input, i * FIXED_DT);
    const impulsive = impulseThisStep || v._hullContact.contacts > 0;
    const dv = vec3.dist(prev, v.velocity);
    if (dv > maxDv) {
      maxDv = dv;
      // Record WHY the step was large. A collision impulse is applied outside the
      // acceleration clamp by design, so the interesting question is not how big
      // the largest step was but whether anything large happened without a
      // collision to explain it - which would be the solver coming apart.
      maxDvContacts = v._hullContact.contacts;
      maxDvImpulse = impulsive;
    }
    if (!impulsive && dv > maxFreeDv) maxFreeDv = dv;
    const sp = vec3.len(v.velocity);
    const om = vec3.len(v.angularVelocity);
    if (sp > maxSpeed) maxSpeed = sp;
    if (om > maxOmega) maxOmega = om;
    const wet = v.wetted > 0.5;
    if (wet !== wasWet) { crossings++; wasWet = wet; }
    if (!vec3.isFinite(v.position) || !vec3.isFinite(v.velocity) ||
        !vec3.isFinite(v.angularVelocity) || !Number.isFinite(v.orientation[3]) ||
        !Number.isFinite(v.hull) || !Number.isFinite(v.ballastVolume)) nonFinite++;
  }
  const qLen = Math.hypot(v.orientation[0], v.orientation[1], v.orientation[2], v.orientation[3]);
  check('20000 randomised steps stay finite', nonFinite === 0, `${nonFinite} bad steps`);
  check('quaternion stays normalised', Math.abs(qLen - 1) < 1e-4, `|q| = ${fmt(qLen, 8)}`);
  check('linear speed stays under the solver clamp', maxSpeed <= 180.001,
    `peak ${fmt(maxSpeed, 2)} m/s vs MAX_LINEAR_SPEED 180 ` +
    `(Vne ${VESSEL.MAX_AIRSPEED} in air, ${VESSEL.MAX_SUBSPEED} submerged)`);
  check('angular speed stays under the 6 rad/s clamp', maxOmega <= 6.001,
    `peak ${fmt(maxOmega, 3)} rad/s`);
  // Two separate claims, because they fail for different reasons. Away from a
  // collision the acceleration clamp is the whole story and must hold tightly. A
  // step WITH contacts may exceed it - sequential impulses are applied outside the
  // clamp on purpose - but then a contact has to actually be there to explain it.
  const CLAMP = 120;   // MAX_LINEAR_ACCEL in vessel.js
  check('acceleration is clamped on every non-impulsive step',
    maxFreeDv <= CLAMP * FIXED_DT * 1.001,
    `largest step with no contact and no surface impulse ${fmt(maxFreeDv, 4)} m/s ` +
    `vs the ${fmt(CLAMP * FIXED_DT, 4)} m/s a ${CLAMP} m/s^2 clamp allows`);
  check('the largest step of all is explained by an impulse',
    maxDv <= CLAMP * FIXED_DT * 1.001 || maxDvImpulse,
    `max |dv| ${fmt(maxDv, 4)} m/s, ${maxDvContacts} hull contact(s), ` +
    `surface impulse ${maxDvImpulse ? 'yes' : 'NO - unexplained'}`);
  for (const off of offImpulse) off();
  console.log(`       ${crossings} waterline crossings, hull ${fmt(v.hull, 1)}%, ` +
    `ballast ${fmt(v.ballastFill, 3)}, power ${fmt(v.powerFraction, 3)}`);
}

// ===========================================================================
console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${checks - failures}/${checks} checks\n`);
process.exit(failures ? 1 : 0);
