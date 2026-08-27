#!/usr/bin/env node
/**
 * SUBWAVE vessel control-authority verification.
 *
 * THE TEST THAT WOULD HAVE CAUGHT IT.
 *
 * A playtest reported that turning the Kestrel with the mouse made it oscillate
 * uncontrollably and sometimes flip onto its back. Every automated suite was
 * green at the time, and the vessel's own "control feel" test in test-input.mjs
 * passed - because that test flies at 90 m ALTITUDE and drives only the PITCH
 * axis, which is the one regime where the bug does not appear.
 *
 * The bug was in the thrust allocator. It assumed differential fore/aft throttle
 * makes pitch and differential port/starboard makes roll, which is true only
 * while the ducts point straight up. The real thrust axis is
 * d(theta,phi) = (-cos(t)sin(p), cos(t)cos(p), sin(t)), so the moment is
 * r_i x (T_i * d), and as the ducts tilt toward -90 degrees the roles ROTATE:
 * differential throttle stops making pitch and starts making yaw, while
 * differential TILT takes over pitch and roll. At exactly -90 degrees the old
 * mixer had ZERO pitch authority and was feeding pitch commands into the yaw
 * axis. Underwater at neutral trim the vertical demand is zero by definition, so
 * any forward demand drove the schedule straight there: pressing W was enough.
 *
 * So this file measures, for every tilt and vectoring angle in the actuator
 * range, whether a commanded moment actually comes out of the physics:
 *
 *   1. SIGN     - the delivered moment must never oppose the commanded one.
 *   2. GAIN     - it must never collapse toward zero.
 *   3. COUPLING - it must not leak into the axes that were not asked for.
 *
 * Nothing here is asserted from a table. Every number is measured by running the
 * real _allocate, the real actuator lag, and the real _applyThrust, and reading
 * the torque that lands on the rigid body.
 *
 * Usage: node tools/test-vessel-control.mjs
 * Exit code is non-zero if any check fails.
 */

import * as terrain from '../src/world/terrain.js';
import { CollisionWorld } from '../src/world/collision.js';
import {
  Vessel, solveLeastNorm, TILT_SCHED_MIN, TILT_SCHED_MAX,
} from '../src/entities/vessel.js';
import { VESSEL, WORLD } from '../src/core/constants.js';
import { vec3, quat } from '../src/core/math.js';

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

terrain.setSeed(WORLD.DEFAULT_SEED);
const collision = new CollisionWorld(terrain);

const AXIS_NAMES = ['pitch', 'yaw', 'roll'];

/**
 * Drive one commanded body torque through the whole allocation and propulsion
 * path and measure the body torque that actually results.
 *
 * Deliberately goes through _allocate -> _updateActuators -> _applyThrust rather
 * than inspecting the Jacobian, so that an allocator which solves the right
 * matrix but applies it to the wrong nacelle still fails.
 */
function measureMoment(v, tilt, phi, axis, magnitude, throttle) {
  const n = VESSEL.NACELLE_COUNT;
  // Park the actuators at the operating point and let the spool settle there, so
  // we measure authority ABOUT that point rather than the transient into it.
  v.nacelleTilt.fill(tilt);
  v.nacelleYaw.fill(phi);
  v.nacelleThrottle.fill(throttle);
  quat.identity(v.orientation);
  vec3.zero(v.velocity);
  vec3.zero(v.angularVelocity);
  v.beta = 0;
  v.betaControl = 0;
  v.breachTimer = Infinity;
  v.groundClearance = Infinity;
  v.controlAuthority = 1;

  vec3.zero(v.commandedTorque);
  v.commandedTorque[axis] = magnitude;

  const tMax = v._maxThrustPerNacelle();
  v._allocate(n, tMax, throttle, tilt, phi);
  // Converge the actuators onto the new commands. 40 steps at 1/60 s is 0.67 s,
  // several spool and slew time constants.
  for (let i = 0; i < 40; i++) v._updateActuators(1 / 60);

  const force = vec3.create();
  const torque = vec3.create();
  v._applyThrust(force, torque);
  // The reference state is the same geometry with NO control demand: what we want
  // is the moment the CONTROL produced, not the airframe's trim moment.
  vec3.zero(v.commandedTorque);
  v._allocate(n, tMax, throttle, tilt, phi);
  for (let i = 0; i < 40; i++) v._updateActuators(1 / 60);
  const force0 = vec3.create();
  const torque0 = vec3.create();
  v._applyThrust(force0, torque0);

  const dTorque = vec3.create();
  vec3.sub(dTorque, torque, torque0);
  const dForce = vec3.create();
  vec3.sub(dForce, force, force0);
  // Orientation is identity, so world and body frames coincide.
  return { dTorque, dForce };
}

// ===========================================================================
section('1. Control authority across the whole tilt range');
// ===========================================================================
{
  const v = new Vessel(collision);
  vec3.set(v.position, 0, 400, 0);
  const MAG = 20000;             // N.m, a firm but not saturating demand
  const THROTTLE = 0.5;          // mid-throttle: symmetric headroom either way

  for (let axis = 0; axis < 3; axis++) {
    let worstGain = Infinity, worstGainTilt = 0;
    let worstCoupling = 0, worstCouplingTilt = 0;
    let signInversions = 0, firstInversionTilt = null;
    let samples = 0;

    // The SCHEDULE range: these are the common tilt angles the mixer can actually
    // command, and therefore the whole reachable state space. The PHYSICAL range
    // deliberately extends further so that differential tilt still has travel when
    // the schedule is parked at its own limit - see the headroom check in
    // section 2. Sweeping the physical range instead would measure authority at a
    // common tilt sitting hard against the actuator stop, where zero authority is
    // the correct answer and not a defect.
    for (let tilt = TILT_SCHED_MIN; tilt <= TILT_SCHED_MAX + 1e-9; tilt += 0.02) {
      const { dTorque } = measureMoment(v, tilt, 0, axis, MAG, THROTTLE);
      const along = dTorque[axis] / MAG;
      // Component of the delivered moment perpendicular to the demanded axis.
      const cross = Math.hypot(
        ...[0, 1, 2].filter((a) => a !== axis).map((a) => dTorque[a])) / MAG;
      if (along <= 0) {
        signInversions++;
        if (firstInversionTilt === null) firstInversionTilt = tilt;
      }
      if (along < worstGain) { worstGain = along; worstGainTilt = tilt; }
      if (cross > worstCoupling) { worstCoupling = cross; worstCouplingTilt = tilt; }
      samples++;
    }

    const nm = AXIS_NAMES[axis];
    check(`${nm} authority never inverts sign`, signInversions === 0,
      signInversions === 0
        ? `${samples} tilt angles from ${fmt(TILT_SCHED_MIN, 2)} to ` +
          `${fmt(TILT_SCHED_MAX, 2)} rad, all same sign as commanded`
        : `${signInversions}/${samples} angles delivered the WRONG SIGN, first at ` +
          `tilt ${fmt(firstInversionTilt, 3)} rad (${fmt(firstInversionTilt * 57.2958, 1)} deg)`);
    check(`${nm} authority never collapses`, worstGain > 0.55,
      `worst delivered/commanded = ${fmt(worstGain, 3)} at tilt ${fmt(worstGainTilt, 3)} rad ` +
      `(${fmt(worstGainTilt * 57.2958, 1)} deg)`);
    check(`${nm} does not leak into the other axes`, worstCoupling < 0.35,
      `worst off-axis/commanded = ${fmt(worstCoupling, 3)} at tilt ` +
      `${fmt(worstCouplingTilt, 3)} rad`);
  }
}

// ===========================================================================
section('2. The two regimes that used to be broken, called out by name');
// ===========================================================================
{
  const v = new Vessel(collision);
  vec3.set(v.position, 0, 400, 0);
  const MAG = 20000;

  // Ducts straight up: the ONLY regime the old mixer was correct in.
  for (let axis = 0; axis < 3; axis++) {
    const { dTorque } = measureMoment(v, 0, 0, axis, MAG, 0.5);
    check(`hover (tilt 0): ${AXIS_NAMES[axis]} responds`,
      dTorque[axis] / MAG > 0.55,
      `delivered/commanded = ${fmt(dTorque[axis] / MAG, 3)}`);
  }

  // Ducts straight forward: submerged cruise at neutral trim, where a forward
  // demand puts the schedule and where the old mixer had NO pitch or roll
  // authority and sent pitch commands into yaw.
  const FULL = -Math.PI / 2;
  for (let axis = 0; axis < 3; axis++) {
    const { dTorque } = measureMoment(v, FULL, 0, axis, MAG, 0.5);
    check(`submerged cruise (tilt -90 deg): ${AXIS_NAMES[axis]} responds`,
      dTorque[axis] / MAG > 0.55,
      `delivered/commanded = ${fmt(dTorque[axis] / MAG, 3)}`);
  }

  // THE INVARIANT that makes the above possible. Differential tilt is the
  // primary pitch and roll effector at full tilt, so if the schedule could reach
  // the physical stop there would be no travel left to control with - and if the
  // schedule could pass -PI/2, cos(theta) would go negative and every pitch and
  // roll sign would invert, which is the flip the playtest reported.
  check('the tilt schedule stops short of the physical stop, both ends',
    TILT_SCHED_MIN > VESSEL.NACELLE_PITCH_RANGE[0] &&
    TILT_SCHED_MAX < VESSEL.NACELLE_PITCH_RANGE[1],
    `schedule [${fmt(TILT_SCHED_MIN, 4)}, ${fmt(TILT_SCHED_MAX, 4)}] inside ` +
    `physical [${fmt(VESSEL.NACELLE_PITCH_RANGE[0], 4)}, ` +
    `${fmt(VESSEL.NACELLE_PITCH_RANGE[1], 4)}]; headroom ` +
    `${fmt(TILT_SCHED_MIN - VESSEL.NACELLE_PITCH_RANGE[0], 3)} rad below, ` +
    `${fmt(VESSEL.NACELLE_PITCH_RANGE[1] - TILT_SCHED_MAX, 3)} rad above`);
  check('the tilt schedule never reaches the sign inversion at -PI/2',
    TILT_SCHED_MIN >= -Math.PI / 2,
    `TILT_SCHED_MIN = ${fmt(TILT_SCHED_MIN, 6)}, -PI/2 = ${fmt(-Math.PI / 2, 6)}`);
}

// ===========================================================================
section('3. Control moments are pure couples');
// ===========================================================================
{
  // Every effector is antisymmetric over the four nacelles, so a control demand
  // must produce NO net force. This is what stops an attitude correction from
  // also shoving the vessel up or down - the failure mode the old per-nacelle
  // clamping produced on every single correction, because clipping one duct to 0
  // and another to 1 is not symmetric.
  const v = new Vessel(collision);
  vec3.set(v.position, 0, 400, 0);
  const MAG = 20000;
  let worst = 0, worstAt = '';
  for (const tilt of [0, -0.4, -0.8, -1.2, -Math.PI / 2]) {
    for (let axis = 0; axis < 3; axis++) {
      const { dTorque, dForce } = measureMoment(v, tilt, 0, axis, MAG, 0.5);
      // Newtons of spurious force per newton-metre of commanded moment, scaled by
      // a 1 m arm to be dimensionless.
      const ratio = vec3.len(dForce) / Math.max(vec3.len(dTorque), 1);
      if (ratio > worst) {
        worst = ratio;
        worstAt = `tilt ${fmt(tilt, 2)} rad, ${AXIS_NAMES[axis]}`;
      }
    }
  }
  check('a control moment produces almost no net force', worst < 0.20,
    `worst |dF| / |dM| = ${fmt(worst, 4)} per metre at ${worstAt}`);
}

// ===========================================================================
section('4. Saturation keeps the moment pointing where it was asked');
// ===========================================================================
{
  // Under saturation the delivered moment must stay PARALLEL to the demand - it
  // may be weaker, but it must not rotate. A control system whose output
  // DIRECTION changes when it saturates will limit-cycle, and the old allocator
  // rotated the moment whenever a nacelle clipped.
  const v = new Vessel(collision);
  vec3.set(v.position, 0, 400, 0);
  let worstAngle = 0, worstAt = '';
  // A demand far beyond what the actuators can deliver, at a throttle with almost
  // no headroom.
  for (const tilt of [0, -0.7, -Math.PI / 2]) {
    for (const throttle of [0.05, 0.5, 0.95]) {
      for (let axis = 0; axis < 3; axis++) {
        const { dTorque } = measureMoment(v, tilt, 0, axis, 900000, throttle);
        const len = vec3.len(dTorque);
        if (len < 1) continue;
        // Angle between the delivered moment and the commanded axis.
        const ang = Math.acos(Math.min(1, Math.abs(dTorque[axis]) / len)) * 57.2958;
        if (ang > worstAngle) {
          worstAngle = ang;
          worstAt = `tilt ${fmt(tilt, 2)}, throttle ${fmt(throttle, 2)}, ${AXIS_NAMES[axis]}`;
        }
      }
    }
  }
  check('a saturated demand still points where it was asked', worstAngle < 25,
    `worst misalignment ${fmt(worstAngle, 1)} deg at ${worstAt}`);
}

// ===========================================================================
section('5. The least-norm solve itself');
// ===========================================================================
{
  const B = new Float64Array(15);
  const u = new Float64Array(5);
  const n = new Float64Array(9);
  const tau = new Float64Array(3);

  // A well-conditioned case: reproduce the demand exactly.
  B.fill(0);
  B[0] = 7; B[4] = 7; B[8] = 7;      // columns 0,1,2 -> pitch, yaw, roll
  tau[0] = 100; tau[1] = -200; tau[2] = 50;
  solveLeastNorm(B, tau, u, n);
  const got = [
    B[0] * u[0] + B[3] * u[1] + B[6] * u[2] + B[9] * u[3] + B[12] * u[4],
    B[1] * u[0] + B[4] * u[1] + B[7] * u[2] + B[10] * u[3] + B[13] * u[4],
    B[2] * u[0] + B[5] * u[1] + B[8] * u[2] + B[11] * u[3] + B[14] * u[4],
  ];
  // RELATIVE, not absolute: the Tikhonov term is deliberately non-zero, so the
  // residual scales with the demand and an absolute bound would just be a
  // statement about how big the test's numbers happen to be.
  const err = Math.hypot(got[0] - tau[0], got[1] - tau[1], got[2] - tau[2]);
  const rel = err / Math.hypot(tau[0], tau[1], tau[2]);
  check('a full-rank demand is reproduced exactly', rel < 1e-6,
    `relative residual ${rel.toExponential(2)} (${err.toExponential(2)} N.m of ` +
    `${fmt(Math.hypot(tau[0], tau[1], tau[2]), 0)})`);

  // An all-zero Jacobian must not produce a NaN. This is the parked-vessel case:
  // no thrust to vector means no authority, and the honest answer is zero.
  B.fill(0);
  solveLeastNorm(B, tau, u, n);
  check('a rank-zero Jacobian yields zero, not NaN',
    u.every((x) => Number.isFinite(x)) && u.every((x) => Math.abs(x) < 1e-9),
    `u = [${Array.from(u).map((x) => fmt(x, 6)).join(', ')}]`);

  // A rank-deficient Jacobian: yaw unachievable. The solve must satisfy what it
  // can and stay finite, not blow up on the unreachable component.
  B.fill(0);
  B[0] = 7; B[8] = 7;                // pitch and roll only, nothing on yaw
  tau[0] = 100; tau[1] = 5000; tau[2] = 50;
  solveLeastNorm(B, tau, u, n);
  const gotP = B[0] * u[0];
  const gotR = B[8] * u[2];
  check('a rank-deficient Jacobian stays finite and serves what it can',
    u.every((x) => Number.isFinite(x)) &&
    Math.abs(gotP - 100) < 1e-3 && Math.abs(gotR - 50) < 1e-3,
    `pitch ${fmt(gotP, 3)}/100, roll ${fmt(gotR, 3)}/50, yaw unachievable as expected`);
}

// ===========================================================================
console.log(`\n${failures === 0 ? `PASSED: ${checks}/${checks} checks` : `FAILED: ${checks - failures}/${checks} checks`}\n`);
process.exit(failures ? 1 : 0);
