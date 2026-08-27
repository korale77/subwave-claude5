/**
 * SUBWAVE vessel - the Kestrel, a single-seat aerodyne/submersible.
 *
 * TWO CONTROL PATHS, ONE BODY.
 *
 * PILOTED, the Kestrel is flown DIRECTLY (see _directControl): the hull points
 * where the aim points, with zero roll and a 0.09 s lag, and it moves along that
 * heading at a speed set by the throttle with a 0.25 s lag. No attitude cascade,
 * no allocator, no aero or hydro moments. That is a deliberate reversal of what
 * this file used to do, made at the user's explicit instruction after a playtest
 * measured the rigid-body loop delivering 0.4% of a 126 degree flick at the
 * moment the hand stopped and taking five seconds to finish the rest. The whole
 * argument is in CLAUDE.md's control contract; do not "restore" the cascade to
 * the piloted path without reading it.
 *
 * UNPILOTED, it is the rigid body it always was: gravity, buoyancy, drag,
 * added mass and ground contact, integrated semi-implicitly. That path is what
 * makes a parked vessel sit on its skids and settle on a reef, and it is why
 * every force term below still exists.
 *
 * BOTH paths share: the wave-field sampling, the ballast, the submergence latch,
 * terrain contact, and every system (power, hull, depth rating, oxygen, lights).
 * The medium is a continuous scalar `beta` derived from how much of the hull is
 * under water. Nothing is ever teleported, reparented or reset at the waterline.
 *
 * The rigid-body physics, in the order the step runs:
 *   0. (piloted only) _directControl writes the orientation, velocity and
 *      position outright and steps 5-6 below are skipped entirely
 *   1. sample the wave field along the hull -> submerged volume, wetted
 *      fraction w, centre of buoyancy
 *   2. beta = smoothstep(0.05, 0.95, w); a lagged copy blends the CONTROL gains
 *      so a wave slapping the hull cannot make the autopilot chatter
 *   3. ballast: flood/blow at the tank rates, with blow authority falling to
 *      zero as ambient pressure approaches the air flask pressure
 *   4. the mixer: cascaded attitude -> rate -> torque PIDs produce per-nacelle
 *      throttle and tilt commands, slew-limited by the actuators
 *   5. forces: gravity, Archimedes, four vectored thrusters with momentum-theory
 *      inflow lapse and ground effect, aerodynamic lift/drag/damping *(1-beta),
 *      hydrodynamic drag/damping/Munk *beta, water-entry slam
 *   6. semi-implicit Euler with a body-frame added-mass matrix, quaternion
 *      integration, then terrain contact
 *   7. systems: power, hull integrity, depth rating, cabin oxygen, lights
 *
 * Coordinates: body +X starboard, +Y up, -Z forward. World +X east, +Y up,
 * +Z south, sea level y = 0, depth = -y.
 */

import {
  vec3, quat, mat4, clamp, saturate, lerp, smoothstep, damp, moveTowards,
  wrapAngle, headingFromDir, VEC3_UP, PID, TAU, PI, makeRng,
} from '../core/math.js';
import { VESSEL, VESSEL_LIGHTS, WORLD } from '../core/constants.js';
import { events, EVENTS } from '../core/events.js';
import { settings } from '../core/settings.js';
import { ACTION } from '../core/input.js';
import { createVertexBuffer, createIndexBuffer } from '../core/resources.js';
import {
  buildVesselMesh, buildHullSections, VESSEL_NODE, VESSEL_NODE_COUNT,
  VESSEL_LIGHT_MOUNTS, VESSEL_LIGHT_AIM, VESSEL_VERTEX_STRIDE,
} from './vessel_mesh.js';
import {
  VESSEL_HULL_PROBES, VESSEL_HULL_PROBE_COUNT, VESSEL_PROBE_RADIUS,
  createHullContact, createWaterSample, MATERIAL_NAMES,
} from '../world/collision.js';

// ---------------------------------------------------------------------------
// Derived physical constants
// ---------------------------------------------------------------------------

const G = WORLD.GRAVITY;
const RHO_WATER = WORLD.WATER_DENSITY;
const RHO_AIR_0 = WORLD.AIR_DENSITY;
/** Density scale height, metres. Standard troposphere. */
const AIR_SCALE_HEIGHT = 8200;

/** Rotor disc: duct throat radius 0.62 m, matching vessel_mesh's nacelle. */
const DUCT_RADIUS = 0.62;
const DUCT_DIAMETER = DUCT_RADIUS * 2;
const A_DISC = PI * DUCT_RADIUS * DUCT_RADIUS;

/**
 * Depth at which the HP air flask can no longer overcome ambient pressure and
 * the main ballast tanks simply cannot be blown (DESIGN/04.3.3). Below this the
 * only way up is thrust, which is the design's central dread mechanic.
 */
const BLOW_DEPTH_LIMIT = 1400;

/**
 * Rate feedback on the vertical position hold, 1/s.
 *
 * The hold is P+D on a double integrator: omega_n = sqrt(0.90) = 0.95 rad/s, and
 * this sets zeta = HOLD_RATE_GAIN / (2 * omega_n) = 0.84 - comfortably damped.
 * The PID's own derivative term is far too small to do this on its own.
 */
const HOLD_RATE_GAIN = 1.60;

/** Nacelle spool time constants, seconds (DESIGN/04.2.3 and 04.3.7). */
const SPOOL_TAU_AIR = 0.18;
const SPOOL_TAU_WATER = 0.34;

/** Control-blend lag. Physics blends instantly; gains must not. */
const CONTROL_BLEND_TAU = 0.35;

/**
 * Solver stability clamps (DESIGN/04.2.9 and 04.4.3). The clipped energy is
 * not thrown away - it is converted into hull damage and camera shake, so a
 * catastrophic entry still hurts, it just cannot launch the body into a NaN.
 */
/**
 * Solver acceleration clamp, m/s^2.
 *
 * It has to sit ABOVE what ordinary physics produces, or it stops being a
 * safeguard and becomes part of the model. At 45 it was below the plain
 * hydrodynamic drag deceleration at the vessel's own design speed - 481 kN on
 * 5,075 kg of effective mass is 95 m/s^2 - so the clamp fired continuously in
 * normal submerged cruise. Which would have been merely wrong, except that
 * saturating it also charged hull damage: an ordinary dive billed 181% of the hull
 * to "impact" without ever touching anything. See _integrate.
 */
const MAX_LINEAR_ACCEL = 120.0;    // m/s^2
const MAX_ANGULAR_ACCEL = 9.0;     // rad/s^2
/**
 * Solver speed clamp. Must sit ABOVE MAX_AIRSPEED, not on it: Vne is enforced by
 * the flight computer, and a power-off dive is supposed to be able to exceed it
 * and take the overspeed damage. A clamp equal to Vne silently does the flight
 * computer's job for it and the damage mechanic never fires.
 */
const MAX_LINEAR_SPEED = 180.0;    // m/s
const MAX_ANGULAR_SPEED = 6.0;     // rad/s

/**
 * Aerodynamic coefficients from DESIGN/04.2.4. CL_max comes from
 * VESSEL.LIFT_COEFF; the rest describe the shape of the curve, not its size.
 */
const CL_SLOPE = 2.40;
const STALL_BLEND_START = 0.175;
const STALL_BLEND_END = 0.280;
const INDUCED_DRAG_K = 0.421;      // 1/(pi * AR_eff * e_osw), AR 1.05, e 0.72
const SIDESLIP_DRAG = 0.140;
const CY_BETA = -1.90;
const CMQ = -6.80;
const CLP = -0.42;
const CNR = -0.95;
/**
 * Directional (weathervane) stability derivative, dCn/dbeta. NEGATIVE, and the
 * sign is the whole content of this constant.
 *
 * It shipped as +0.24, which made the airframe open-loop directionally
 * DIVERGENT in air. Measured on the bare airframe with the controller removed:
 * 10 degrees of sideslip ran to 112.7 degrees in one second. Nothing said so,
 * because the attitude cascade was strong enough to sit on it in ordinary
 * flight - it merely spent authority holding the hull straight that it should
 * have been spending on the pilot.
 *
 * The sign is fixed by the frame, not by taste. Body +Y is up and a positive
 * moment about +Y yaws the nose to PORT; positive sideslip means the hull is
 * drifting to STARBOARD, and a weathervane turns the nose INTO the relative
 * wind, i.e. to starboard. So a stabilising yawing moment is NEGATIVE for
 * positive sideslip. The hydrodynamic fin term in _applyHydro already had this
 * right - it subtracts its stiffness from the body-Y moment (`_v2[1] -= ...`)
 * and its comment spells out the same handedness argument. The aerodynamic
 * weathervane, which is the same physics in the other medium, simply disagreed
 * with it.
 */
const CN_BETA = -0.24;
/** Below this speed the /(2|v|) damping terms are singular; substitute this. */
const AERO_DAMPING_FLOOR = 3.0;

/**
 * Hydrodynamic damping about each BODY axis, N.m/(rad/s)^2 and N.m/(rad/s).
 * DESIGN/04.3.6 tabulates these for a 2.19 m^3 hull; the Kestrel displaces
 * VESSEL.DISPLACEMENT, and rotational damping scales with the wetted area
 * moment, i.e. roughly linearly in displaced volume for a similar shape.
 *
 * THE ROLL FIGURES ARE NOT FROM THAT TABLE, because the table is for a SLENDER hull
 * and slender-body roll damping badly under-predicts this one. The Kestrel has an L/D
 * of 1.76 and carries four ducted nacelles out at 1.85 m of lateral offset, and at
 * zero forward speed those appendages are the dominant roll damping there is: rolling
 * at rate p, each duct's 1.21 m^2 disc moves vertically at p*1.85 and eddies hard.
 * Summed over four nacelles that is about 17 kN.m/(rad/s)^2, and the hull's own
 * eddy-making adds a comparable amount - against the 1.2 the slender table gave.
 *
 * This matters because a neutrally buoyant submersible at hover has NO attitude
 * authority: there is no thrust to vector, so the flight computer cannot help and the
 * hull has to be passively stable on its own. Measured before: a roll disturbance at
 * hover peaked at 56 degrees and was still 25 degrees off level ten seconds later.
 */
const HYDRO_SCALE = VESSEL.DISPLACEMENT / 2.19;
const HYDRO_ANG_QUAD = Float32Array.of(5400 * HYDRO_SCALE, 6100 * HYDRO_SCALE, 12000 * HYDRO_SCALE);
const HYDRO_ANG_LIN = Float32Array.of(2600 * HYDRO_SCALE, 2900 * HYDRO_SCALE, 2600 * HYDRO_SCALE);
/**
 * Linear (skin-friction) drag per body axis, N/(m/s). Small next to the
 * quadratic term at any real speed; its job is to kill numerical jitter as the
 * velocity crosses zero, where a purely quadratic law has zero damping.
 */
const HYDRO_LIN_DRAG = Float32Array.of(200, 400, 60);

/**
 * Hydrodynamic fin stiffness about body X (pitch) and body Y (yaw), N.m per
 * (m/s) of speed per (m/s) of transverse velocity.
 *
 * THE HULL WAS DIRECTIONALLY UNSTABLE UNDERWATER AND NOTHING SAID SO. The Munk
 * moment below destabilises yaw by construction, the aerodynamic weathervane
 * (CN_BETA) is gated off underwater by `w = 1 - beta`, and there was no
 * hydrodynamic equivalent - so submerged, the only thing opposing a broach was
 * quadratic RATE damping, which resists the rate and not the ANGLE. The flight
 * computer was the sole source of static stability.
 *
 * That was survivable at 8.8 m/s. The Munk moment grows with v^2, so by 20 m/s it
 * was 2.6x the available control moment: the vessel broached, and the thrust it
 * was still pointing along its own axis drove it to the surface. Going faster did
 * not create the instability, it revealed it.
 *
 * Sized from the fins the mesh already carries, as
 * 0.5 * rho_water * S * Cl_alpha * arm:
 *   pitch  stern planes  1.35 m^2, Cl_a 2.8, arm 3.2 m  ->  6200
 *   yaw    vertical fin  1.05 m^2, Cl_a 2.8, arm 3.0 m  ->  4520
 * Net of the Munk coefficients (3003 pitch, 1771 yaw) that leaves the hull
 * statically stable on both axes with a comfortable margin, without making it so
 * stiff that the flight computer cannot point it - the fins have to be beatable,
 * because pointing the hull is how this vessel steers.
 */
const HYDRO_FIN = Float32Array.of(6200, 4520);
/**
 * Moment arms of those same fins, metres. The SAME surface supplies stiffness and
 * RATE DAMPING - its local incidence is (transverse velocity + arm * rate) / speed
 * - so the damping is not a free parameter and must not be tuned separately.
 * Keeping the stiffness while dropping the damping is what turns a stabiliser into
 * a 4.7 rad/s undamped resonance, which is exactly what happened when this was
 * first added with stiffness alone.
 */
const HYDRO_FIN_ARM = Float32Array.of(3.2, 3.0);

/**
 * Hydrodynamic ROLL-RATE damping from the horizontal surfaces, N.m per (rad/s) per
 * (m/s) of speed.
 *
 * The same modelling gap as the yaw stiffness, on the one axis left over: the aero
 * block carries a roll-damping coefficient (CLP) and the hydro block carried only the
 * generic HYDRO_ANG_* terms, which are the SMALLEST of the three axes. Rolling at rate
 * p, a horizontal surface sees an up-flow of p*y at spanwise station y and an equal
 * down-flow on the other side, so it opposes the roll with
 * rho * S * Cl_alpha * s^2 / 6 per m/s - and that term was simply absent in water.
 *
 * Sized from the stern planes alone (S = 1.35 m^2, Cl_alpha = 2.8, semi-span 1.0 m),
 * which is worth 646 and gives zeta = 0.88 at 30 m/s. Including the hull's full beam as
 * a lifting surface would give ten times that and make the vessel feel welded.
 *
 * It scales with speed, so it does nothing at hover - correctly, because a stationary
 * hull has no flow over its fins. Hover roll is handled by ballasting and form damping
 * instead; see COB_OFFSET and HYDRO_ANG_*.
 */
const HYDRO_FIN_ROLL = 646;

/**
 * The fins are also CONTROL SURFACES: stern planes and a rudder.
 *
 * They have to be, and the reason is structural rather than decorative. Fin
 * stiffness scales with dynamic pressure, so with v^2; thrust-vectoring authority
 * comes from ducts that are constant-power, so it FALLS as 1/v. Give the hull fins
 * and nothing else, and the ratio of stability to control degrades as the square
 * of speed until the vessel simply flies along its own velocity vector and cannot
 * be re-pointed. Measured, at 37.7 m/s the hull sat at +11.7 degrees with the trim
 * integrator saturated and the controller commanding full nose-down: the vessel
 * held whatever flight path the initial transient gave it and climbed out of the
 * sea. It was perfectly stable and completely uncontrollable.
 *
 * A deflected fin's authority scales with the SAME q as its stiffness, so the
 * controllable incidence range becomes speed-independent - which is why every real
 * aircraft and every real submarine steers this way. The two effectors are exactly
 * complementary: vectored thrust has all the authority at rest and none at speed,
 * control surfaces the reverse, and the allocator's headroom weighting picks
 * whichever is currently worth using without being told.
 *
 * Modelled as moment-only. A deflection does also produce a small direct lift
 * force, but it is second order next to the attitude change it causes, and this is
 * the standard approximation.
 */
const FIN_DEFLECT_MAX = 0.35;      // rad, about 20 degrees
const FIN_SLEW_RATE = 2.5;         // rad/s
/**
 * Radians of fin deflection shown per radian of aim error under DIRECT control.
 * Display only - see _directActuators, where nothing this schedule produces is
 * applied to the body. 2.0 saturates the surfaces at 10 degrees of aim error,
 * which is about what a hard flick opens up against the 0.09 s attitude lag.
 */
const FIN_DISPLAY_GAIN = 2.0;
/**
 * Stiffness-matched attitude-to-torque gain, as a fraction of the fin stiffness
 * the vessel is currently sitting on.
 *
 * A rate cascade cannot hold an attitude against a stiff plant. The commanded
 * torque out of the cascade is (angular acceleration x inertia), and the
 * acceleration is bounded by the rate loop's own gain and rate ceiling - here that
 * caps the torque at 43 kN.m, against a fin stiffness of 8.8 MN.m/rad at 38 m/s.
 * The controller could therefore command 0.28 degrees of incidence and no more,
 * whatever the attitude error was, and the measured behaviour was exactly that:
 * the error stayed at 18 degrees while the loop sat pinned at its ceiling.
 *
 * So the attitude error also drives torque DIRECTLY, with a gain proportional to
 * the stiffness it has to work against. That is not a trick - it is what a control
 * surface does mechanically, and it is why the term vanishes with q when there is
 * no stiffness to match. No integrator, so nothing to wind up, and the fins' own
 * rate damping - which scales with the same q - damps it.
 */
const KP_FIN_TORQUE = 0.85;
/**
 * Share of the fins' own maximum moment the stiffness-matched term may ask for.
 * Under 1 so the rate cascade keeps some deflection to work with, and so the term can
 * never be the thing that saturates the allocator.
 */
const FIN_TORQUE_FRAC = 0.85;

/**
 * MANOEUVRING THRUSTERS: three tunnel thrusters, one per body axis, and the
 * reason a submersible can turn on the spot.
 *
 * WHY THE DUCTS CANNOT DO THIS. The four nacelles share ONE common tilt, so at
 * zero net thrust the two differential-throttle patterns give, exactly:
 *
 *   armZ x d = (7.10 cos t + 0.10 sin t, 0, 0)      -> PITCH only
 *   armX x d = (0, -7.14 sin t, 7.14 cos t)         -> YAW and ROLL, locked at -tan t
 *
 * That is TWO attitude degrees of freedom, not three, and which two depends on
 * the tilt. The angle effectors cannot make up the difference: their moment is
 * SUM_i s_i T_i (r_i x dv), whose effective arm under a pure +/- couple is
 * SUM_i r_i = 0.5 m rather than the 7.1 m of the geometric arm - and a pure
 * couple is exactly what a station-keeping vessel must use, because anything
 * else shoves it off station. Vectoring needs COMMON thrust, and submerged at
 * neutral buoyancy there is none: measured, the common throttle sits at 0.000,
 * controlAuthority at 0.06-0.19, and the hull rotated 0.0 degrees in five
 * seconds of held mouse. The player's report was "in the water it basically
 * doesn't react to our controls" and it was completely accurate.
 *
 * Tunnel thrusters are opposed pairs firing through the hull, so they deliver a
 * pure couple with zero net force - the one thing the ducts cannot do. Constant
 * torque, so the response is the same every time; that predictability is the
 * point, and it is what was asked for.
 *
 * SIZED AGAINST THE COB PENDULUM ON PITCH AND ROLL, NOT AGAINST THE INERTIA. The
 * inertia only sets how fast the vessel gets there; what decides where it STOPS is
 * COB_OFFSET, which at neutral buoyancy is a righting moment of
 * 43.6 kN * 0.55 m * sin(angle) - 23.9 kN.m at 85 degrees. Sized off the inertia
 * alone at 14 kN.m, the pitch thruster held exactly asin(14000/(43600*0.55)) =
 * 35.8 degrees and the measured hover settle was 36.9: the pilot aimed at 63
 * degrees and the vessel simply stopped short, which reads as the controls giving
 * out. 30 kN.m carries the whole pitch envelope with margin.
 *
 * ROLL IS DELIBERATELY LEFT WEAKER THAN ITS PENDULUM. 9 kN.m against 23.9 means
 * the hull is passively self-righting in roll and the thruster cannot fight that -
 * which is exactly what is wanted, because the requirement is zero roll. The roll
 * channel is there to DAMP, not to command. Yaw has no pendulum at all, so 20
 * kN.m is set by the inertia (26.0k at neutral ballast) and the HYDRO_ANG_*
 * damping, and settles at about 0.85 rad/s.
 *
 * Water only - hovering in AIR already works, because holding altitude needs real
 * thrust and that thrust is there to vector (measured: 44 degrees of yaw in five
 * seconds at full authority). And faded out with speed, so once the ducts and
 * fins have dynamic pressure to work with, cruise is exactly as it was.
 */
const MANEUVER_TORQUE = [30000, 20000, 9000];   // N.m, [pitch, yaw, roll]
const MANEUVER_FADE_LO = 2.0;      // m/s, full authority below this
const MANEUVER_FADE_HI = 9.0;      // m/s, the ducts and fins have taken over above it

/**
 * Lateral force demand, as a fraction of the vessel's weight, below which the
 * common nacelle vectoring has nothing real to point at and fades out. See the
 * yawSched block: below this the quantity it inverts is trim dither, whose sign
 * flips the schedule by pi and slams the ducts between their opposite stops.
 */
const YAW_SCHED_LO = 0.015;
const YAW_SCHED_HI = 0.055;

/**
 * Envelope protection gains. The Kestrel has T/W = 2.75 and only 1.16 m^2 of
 * drag area on its surge axis, so nothing PHYSICAL stops it at
 * VESSEL.MAX_AIRSPEED - a fly-by-wire vehicle is stopped by its flight
 * computer, exactly as a real one is. In MANUAL the protection is off and
 * overspeed damages the hull instead.
 */
const VNE_GAIN = 1.8;              // 1/s, commanded accel per m/s of overspeed
const CLIMB_GAIN = 1.2;
/**
 * Braking gain when the throttle is centred, 1/s of commanded deceleration per m/s of
 * speed. Saturates against AX_CMD_MAX above about 12 m/s, so it is a firm constant
 * deceleration from high speed and a soft proportional settle at the end rather than
 * a lurch to a halt.
 */
const BRAKE_GAIN = 1.2;
/**
 * Seconds-to-splashdown over which Vne is walked from the air limit down to the
 * submerged one. At VNE_GAIN and 120 m/s the deceleration needs a few seconds, so
 * the window starts well out; below the lower bound the protection is fully in.
 */
const SURFACE_SLOW_LEAD_MIN = 1.2;
const SURFACE_SLOW_LEAD_MAX = 6.0;
const OVERSPEED_DPS = 0.80;        // hull % per second per m/s over Vne

/**
 * Cascaded attitude gains: an OUTER proportional loop on the quaternion
 * attitude error produces a body-rate command, and an INNER proportional loop
 * on the rate error produces an angular acceleration. Pitch, yaw, roll.
 *
 * The inner gains are chosen from the ACTUATOR pole, not from taste. The
 * nacelles spool with tau = SPOOL_TAU_AIR / SPOOL_TAU_WATER, i.e. poles at
 * 5.6 rad/s in air and 2.9 rad/s in water. A rate loop of the form
 * Kp/(s*(1+tau*s)) crosses over at roughly Kp, so its phase margin is
 * 90deg - atan(Kp*tau). The gains below give 43-51 deg in air and 48-55 deg in
 * water. The gains they replace were 4.6-11.5, which put crossover WELL above
 * the water pole - a phase margin near zero, which is the textbook recipe for a
 * limit cycle, and is what the playtest reported as "oscillates uncontrollably".
 *
 * The outer gains are the inner ones divided by about three, which is the usual
 * loop-separation rule: the rate loop must settle inside the time the attitude
 * loop takes to notice. That ratio is why the WATER gains cannot simply be raised
 * for feel: the outer gain is what the player experiences as responsiveness (the
 * attitude loop settles with a time constant of 1/Kp_att), but raising it alone
 * closes the separation and rings.
 *
 * The water figures were raised once the manoeuvring thrusters existed. A playtest
 * reported "once submerged, we need to swipe the mouse multiple times to turn just
 * a tiny bit", and the outer water gain of 0.65 was a 1.54 s time constant against
 * air's 0.67 - submerged really was three times slower to answer, and the report
 * was precise. The inner gains are still bounded by the duct spool pole (tau 0.34 s
 * in water), which is what sets the phase margin: at 3.0 the margin is
 * 90deg - atan(3.0*0.34) = 44deg, in the same band as the air figures rather than
 * the near-zero margin of the gains that limit-cycled. The thrusters themselves
 * have no spool at all, so at hover the true margin is larger than this.
 *
 * There is deliberately NO INTEGRATOR on either loop, per DESIGN/12.8.4:
 * "steady-state attitude error is corrected by the outer loop, never by a
 * windup-prone integrator on a torque command". The previous rate PID carried
 * ki of 1.4-3.8 plus an `integral *= 0.94` anti-windup hack that read the
 * PREVIOUS step's saturation flag.
 */
const KP_ATT_AIR = Float32Array.of(2.00, 1.50, 2.50);      // pitch, yaw, roll
// Roll is deliberately left at its old, slower water figures. The playtest asked for
// responsiveness in POINTING - pitch and yaw - and for roll to be absent; a roll
// channel geared up to match only makes the hull answer faster to disturbances it
// should be absorbing. Measured, the raised roll gains cost 5 degrees of extra bank
// in a hard diagonal and bought nothing the player can feel.
const KP_ATT_WATER = Float32Array.of(1.00, 0.95, 0.95);
const KP_RATE_AIR = Float32Array.of(6.00, 4.50, 7.50);
const KP_RATE_WATER = Float32Array.of(3.00, 2.80, 2.80);

/**
 * TRIM: a slow integrator on the ATTITUDE error, 1/s.
 *
 * A proportional-only cascade leaves a steady attitude offset against any steady
 * moment, and the airframe has a large one: the aerodynamic centre sits ahead of
 * the CoM, and submerged the centre of buoyancy sits above it. Measured, that
 * offset was 4.7 degrees nose-down at 120 m/s - and because the wing's lift is
 * CL_SLOPE times the angle of attack, 4.7 degrees of nose-down is 39 kN of
 * DOWNFORCE, which is more than the entire commanded climb. The vessel could not
 * climb at full power, and nothing about the symptom pointed at the attitude loop.
 *
 * This is what an aircraft's trim wheel does, and it is what DESIGN/12.8.4 means
 * by "steady-state attitude error is corrected by the outer auto-level loop or by
 * TRIM, never by a windup-prone integrator on a torque command". The prohibition
 * is on integrating into the torque command, which is where the old rate PID put
 * it; integrating the ANGLE and limiting the result to a fraction of the rate
 * envelope cannot wind up into a torque spike.
 */
const KI_ATT = 0.55;
/** Trim's share of the rate envelope. Bounded so it can never dominate. */
const TRIM_AUTHORITY = 0.5;
/**
 * Attitude error, radians, inside which trim is allowed to integrate at all.
 * Trim cancels DISTURBANCES; a slew is a command, not a disturbance, and
 * integrating one winds up an overshoot that has to be paid back. 7 degrees.
 */
const TRIM_BAND = 0.12;
/** 1/s. Outside the band trim bleeds out rather than freezing, so re-entering
 *  the band does not step the rate command. */
const TRIM_BLEED = 1.5;

/**
 * FLIGHT-PATH COMMAND. At speed the aim commands where the vessel GOES, not
 * where the hull points, and the difference between those two is the whole
 * character of this vehicle.
 *
 * Once the fins matter the hull weathervanes onto its own velocity vector and
 * is slow to be held anywhere else: their stiffness is 6-8.8 MN.m/rad submerged
 * at 38 m/s against a measured control moment of 2.44 MN.m in yaw and 3.52 MN.m
 * in pitch in the SAME medium (an earlier draft of this comment set the water
 * stiffness against the AIR control figure, ~150 kN.m - 16x out for the medium
 * it describes). That is not a defect to be
 * tuned out - it is what a 4.5 tonne body moving at 38 m/s through water does,
 * and it is why real submarines and real aircraft are within a couple of degrees
 * of their flight path at all times.
 *
 * So the outer loop stops fighting it and uses it. It biases the ATTITUDE target
 * by the flight-path error, which commands a small angle of attack; the fins turn
 * that into lift - one degree is worth 48 kN at 38 m/s, more than the vessel
 * weighs - and the lift curves the velocity vector until it points where the
 * player aimed. Commanding attitude directly instead, which is what this replaces,
 * left the vessel holding whatever flight path its launch transient gave it: aimed
 * level, it climbed out of the sea at 11 degrees with the controller saturated
 * against the fins the entire way.
 *
 * The blend is by speed, because the two regimes need opposite things. Below
 * FPA_SPEED_LO there is no meaningful fin lift and vectored thrust points the hull
 * directly; above FPA_SPEED_HI the fins own the vessel and the flight path is the
 * only thing worth commanding.
 */
const FPA_GAIN = 1.6;
const AOA_LIMIT = 0.12;            // rad, about 7 deg of commanded incidence
const FPA_SPEED_LO = 5.0;          // m/s
const FPA_SPEED_HI = 14.0;

/**
 * Body-rate ceilings, rad/s. Each is held BELOW the rate error at which the
 * inner loop's output would saturate against MAX_ANGULAR_ACCEL
 * (= MAX_ANGULAR_ACCEL / KP_RATE), so the ceiling bites before saturation does.
 * The old pairing had roll saturating at 0.78 rad/s of error against a
 * 2.094 rad/s ceiling, which made the control bang-bang: the allocator clipped
 * one nacelle to 0 and another to 1 on every correction, injecting a vertical
 * force impulse each time.
 */
const RATE_MAX_AIR = Float32Array.of(1.396, 1.200, 1.100);
const RATE_MAX_WATER = Float32Array.of(1.100, 1.000, 1.222);

/**
 * THE AIM.
 *
 * The mouse integrates a persistent 3-D aim - a compass heading and a pitch -
 * exactly as the player's own look does (see Player._readLook). It does not
 * command a rate and it does not derive a target from its own speed. Both of
 * those have been tried here and both failed: a target read from pointer SPEED
 * collapsed to zero the instant the mouse stopped, so you could not hold a
 * climb; and a rate command on yaw against an integrated aim on pitch made the
 * two axes behave like different vehicles.
 *
 * The gain is exactly 1.0 on both axes, with no scaling, no rate limit, no
 * queue and NO RAIL of any kind. Mouse sensitivity is therefore IDENTICAL in the
 * cockpit and on foot, and the pointer gain is exactly 1.000 at every aim pitch.
 *
 * THE OFFSET RAIL THAT USED TO LIVE HERE IS GONE, and it had to go. It bounded
 * how far the aim could lead the NOSE, which only makes sense while the nose is
 * allowed to lag - and the direct model keeps the hull inside 0.2 s of the aim,
 * so there is nothing left to bound. Worse, it was measurably eating the
 * pointer: the yaw rail tightened with pitch to bound the roll a heading offset
 * couples, and the coupling is what a rigid-body attitude loop suffers, not
 * something a kinematic hull can even have. Measured on the build the user
 * complained about, the pointer gain fell to 0.913 / 0.504 / 0.358 / 0.303 at
 * aim pitches of 15 / 30 / 45 / 60 degrees - up to 65% of the hand movement
 * destroyed - and above 65 degrees the rail reopened and permitted 110-114
 * degrees of coupled roll against its own 31.5 degree budget. Both halves of
 * that are cured by the same change: with roll structurally zero there is no
 * coupling to budget, so there is no rail.
 *
 * AIM_PITCH_LIMIT SURVIVES. 85 degrees, matching PLAYER's SWIM_PITCH_LIMIT and
 * DESIGN/12.8.2's A_PITCH_LIMIT. It is what keeps a heading meaningful and it
 * is why the vessel can dive and surface on the mouse alone.
 */
const AIM_PITCH_LIMIT = 1.4835;

/**
 * Below this horizontal component of the hull's forward vector the nose is inside
 * 6 degrees of vertical, where a compass heading is both meaningless and
 * ill-conditioned (headingFromDir is atan2 of two quantities both going to zero).
 * Callers must skip the heading entirely inside that cone. See hullAim().
 */
const AIM_RAIL_MIN_HORIZ = 0.10;

/**
 * THE ROLL REFERENCE, for the RIGID-BODY path only.
 *
 * Holding the hull wings-level while the nose sweeps in heading by Delta-psi at pitch
 * p demands a body ROLL of Delta-psi * sin(p). Near level that is nothing; pointed
 * steeply it is almost the whole of the command. That coupling is what made a
 * rigid-body attitude loop roll the hull out of a diagonal sweep, and LEVEL_FADE_*
 * retires the world horizon as a roll reference where it stops meaning anything:
 * inside ~10 degrees of vertical the nose sits inside the cone the horizon subtends,
 * so an arbitrarily small change of heading is an arbitrarily large roll command.
 * Above LEVEL_FADE_HI the target references the hull's own up instead; below
 * LEVEL_FADE_LO nothing changes at all.
 *
 * NONE OF THIS IS ON THE PILOTED PATH ANY MORE. _directControl builds the hull
 * attitude from (heading, pitch) with the roll argument set to a literal zero, so
 * the coupling cannot arise: there is no attitude error to decompose and no roll
 * channel to reference. This block survives for simulateUnpiloted and for the
 * offline physics tests that fly the rigid body directly.
 */
const LEVEL_FADE_LO = 0.85;        // |sin(aimPitch)|, 58 deg - inert below this
const LEVEL_FADE_HI = 0.985;       // 80 deg - the horizon is nearly worthless above this
const LEVEL_FADE_FLOOR = 0.15;     // but never worth NOTHING; see _levelness()
const ROLL_REF_MIN = 0.15;         // shortest projection that still defines a twist
const ROLL_REF_DECAY = 3.0;        // 1/s, bleed the twist where it is undefined
/**
 * DESIGN/12.8.5 asks for a visual-only camera roll underwater, where the hull stays
 * level. Not implemented, on purpose: the cockpit camera is rigid to the hull (see
 * applyCamera), and rolling the view against the hull tilts the canopy frame away
 * from the horizon - a quieter version of the same complaint that made the view
 * rigid in the first place. If it is wanted later it belongs in the chase camera.
 */

/** Commanded body accelerations at full stick, m/s^2. */
const AZ_CMD_MAX = 7.00;
const AX_CMD_MAX = 14.00;
const AY_CMD_MAX = 4.00;

/**
 * Reference angle, radians, that non-dimensionalises the tilt and vectoring
 * effectors in _allocate. The throttle effectors are expressed as a fraction of
 * full throttle; without a matching scale for the angle effectors the least-norm
 * solve would be comparing newtons against radians and would silently prefer
 * whichever unit happened to be numerically larger.
 */
const ANG_REF = 0.25;

/**
 * Schedule clamp on the common nacelle tilt, radians.
 *
 * The SCHEDULE must be able to reach exactly -PI/2, because underwater at
 * neutral trim the vertical demand is zero by definition and any forward demand
 * genuinely wants thrust along body -Z. Clamping the schedule short of vertical
 * leaves an uncommanded lift component: at -78 degrees with the Kestrel's cruise
 * thrust that is several m/s^2 of unwanted climb.
 *
 * The PHYSICAL range (VESSEL.NACELLE_PITCH_RANGE) deliberately extends a little
 * PAST -PI/2 so that differential tilt - which is the primary pitch and roll
 * effector at full tilt, see _allocate - still has two-sided room when the
 * schedule is sitting at the extreme.
 */
export const TILT_SCHED_MIN = -PI * 0.5;
export const TILT_SCHED_MAX = 0.47;

/**
 * Throttle ceiling under silent running, as a fraction of full.
 *
 * This has to be set against the DRAG-LIMITED top speed, not picked as a
 * fraction that sounds quiet. Because the ducts are constant-shaft-power
 * (thrustLapse), speed goes as the cube root of available power, so the old cap
 * of 0.22 against the Kestrel's current thrust would still make about 25 m/s out
 * of a 41 m/s top speed - no trade at all. 0.045 gives roughly 15 m/s, which is
 * a real choice between seeing and being seen.
 */
const SILENT_THROTTLE_CAP = 0.045;

/** Number of hull stations the buoyancy integrator uses. */
const HULL_SECTION_COUNT = 15;

/** Light group order, matching VESSEL_LIGHTS. */
const LIGHT_GROUPS = ['flood', 'wide', 'work', 'cabin', 'strobe'];

/** What the one "lights" key drives. See toggleExteriorLights(). */
const EXTERIOR_LIGHT_GROUPS = ['flood', 'wide', 'work'];

/** Xenon strobe from DESIGN/04.6.6: 0.90 Hz, flashes at +0 ms and +49.2 ms. */
const STROBE_PERIOD = 1 / 0.9;
const STROBE_PHASES = Float64Array.of(0, 0.0492);
/** Flash width, seconds. Used only when the frame history is unusable. */
const STROBE_WIDTH = 0.0012;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Planckian-locus colour temperature to LINEAR RGB, normalised so the result
 * has unit luminance. Kang et al. 2002, the same approximation the WGSL side
 * uses, so a lamp's colour is identical on both.
 */
export function kelvinToLinearRGB(out, kelvin) {
  // t is HECTOkelvin, exactly as in common/math.wgsl. Every break point and
  // offset below is tied to that scale; expressing t in kilokelvin instead and
  // keeping the same constants shifts the curve by log(10) per channel, which
  // pins red, green and blue to 1.0 for anything above about 4,000 K and turns
  // the whole lamp table into undifferentiated white.
  const t = clamp(kelvin, 1000, 15000) / 100;
  let r, g, b;
  if (t <= 66) {
    r = 1;
    g = saturate(0.39008157 * Math.log(t) - 0.63184144);
  } else {
    r = saturate(1.29293618 * ((t - 60) ** -0.1332047592));
    g = saturate(1.12989086 * ((t - 60) ** -0.0755148492));
  }
  if (t >= 66) b = 1;
  else if (t <= 19) b = 0;
  else b = saturate(0.54320678 * Math.log(t - 10) - 1.19625408);
  // sRGB -> linear, then normalise to unit luminance so `intensity` in the
  // light table means candela and not "candela times whatever the tint is".
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  r = lin(r); g = lin(g); b = lin(b);
  const lum = Math.max(0.2126 * r + 0.7152 * g + 0.0722 * b, 1e-4);
  out[0] = r / lum;
  out[1] = g / lum;
  out[2] = b / lum;
  return out;
}

/** Air density at altitude. Below sea level the water model takes over. */
const airDensity = (y) => RHO_AIR_0 * Math.exp(-Math.max(0, y) / AIR_SCALE_HEIGHT);

/**
 * Fraction of a superellipse cross-section lying below a horizontal cut at
 * normalised height f in [0,1].
 *
 * For n = 2 the exact answer is the circular-segment formula; as n grows the
 * section becomes a rounded rectangle and the answer tends to f itself. Rather
 * than integrate per station per frame, blend between the two - the error
 * peaks at 1.3% of a station's area near n = 3, which is far below the error
 * the wave field itself carries.
 */
function areaBelowFraction(f, n) {
  const t = clamp(f, 0, 1);
  const h = 2 * t - 1;
  const ellipse = (Math.asin(h) + h * Math.sqrt(Math.max(0, 1 - h * h)) + PI * 0.5) / PI;
  return lerp(ellipse, t, saturate((n - 2) / 2.4));
}

/**
 * Momentum-theory thrust lapse with forward speed at constant shaft power.
 *
 * Static: P = T0 * v_h with v_h = sqrt(T0 / (2*rho*A)).
 * In axial flight at inflow V the induced velocity solves
 *   2*rho*A * v_i * (V + v_i)^2 = P
 * and the thrust is T = 2*rho*A * (V + v_i) * v_i.
 *
 * This is why the Kestrel accelerates hard off the hover and then stops
 * gaining: at 78 m/s a duct sized for a 26 kN static thrust is only making
 * about 19 kN of it. Newton from v_i = v_h converges to 1e-4 in three steps.
 */
/**
 * Minimum-norm solution of B*u = tau, where B is 3x5 column-major.
 *
 * There are five effectors and three torque axes, so the system is
 * underdetermined and has a family of solutions; the minimum-norm one spreads
 * the demand over whichever effectors currently have authority, which is exactly
 * the behaviour wanted as the nacelles tilt and the effectors trade roles.
 *
 * u = B^T * (B*B^T + lambda*I)^-1 * tau. The Tikhonov term is scaled by the
 * matrix's own magnitude so it is dimensionally meaningful and so a parked
 * vessel - which really has no authority at all, having no thrust to vector -
 * yields a small command rather than a division by almost zero.
 *
 * @param {Float64Array} B 3xN, column-major: B[col*3 + row]
 * @param {ArrayLike<number>} tau demanded body torque, 3
 * @param {Float64Array} u out, N
 * @param {Float64Array} n scratch, 9 (holds B*B^T)
 * @param {number} cols number of effector columns
 */
export function solveLeastNorm(B, tau, u, n, cols = 5) {
  // N = B * B^T, symmetric 3x3.
  for (let r = 0; r < 3; r++) {
    for (let c = r; c < 3; c++) {
      let s = 0;
      for (let k = 0; k < cols; k++) s += B[k * 3 + r] * B[k * 3 + c];
      n[r * 3 + c] = s;
      n[c * 3 + r] = s;
    }
  }
  const trace = n[0] + n[4] + n[8];
  const lambda = trace * 1e-9 + 1e-6;
  n[0] += lambda; n[4] += lambda; n[8] += lambda;

  // Symmetric 3x3 inverse by cofactors, applied straight to tau.
  const a = n[0], b = n[1], c = n[2], d = n[4], e = n[5], f = n[8];
  const c00 = d * f - e * e;
  const c01 = c * e - b * f;
  const c02 = b * e - c * d;
  const det = a * c00 + b * c01 + c * c02;
  if (!(Math.abs(det) > 1e-12)) { u.fill(0); return u; }
  const inv = 1 / det;
  const c11 = a * f - c * c;
  const c12 = c * b - a * e;
  const c22 = a * d - b * b;
  const y0 = (c00 * tau[0] + c01 * tau[1] + c02 * tau[2]) * inv;
  const y1 = (c01 * tau[0] + c11 * tau[1] + c12 * tau[2]) * inv;
  const y2 = (c02 * tau[0] + c12 * tau[1] + c22 * tau[2]) * inv;

  for (let k = 0; k < cols; k++) {
    u[k] = B[k * 3] * y0 + B[k * 3 + 1] * y1 + B[k * 3 + 2] * y2;
  }
  return u;
}

function thrustLapse(staticThrust, rho, axialSpeed) {
  if (staticThrust <= 0) return 0;
  const k = 2 * rho * A_DISC;
  const vh = Math.sqrt(staticThrust / k);
  const P = staticThrust * vh;
  // Below -v_h/2 the rotor is in the vortex-ring state, which momentum theory
  // does not describe at all; clamp there and let drag do the work.
  const V = Math.max(axialSpeed, -vh * 0.5);
  let vi = vh;
  for (let i = 0; i < 4; i++) {
    const s = V + vi;
    const f = k * vi * s * s - P;
    const df = k * s * (V + 3 * vi);
    if (Math.abs(df) < 1e-6) break;
    vi = Math.max(1e-3, vi - f / df);
  }
  return clamp((k * (V + vi) * vi) / staticThrust, 0, 1.25);
}

// ---------------------------------------------------------------------------
// Vessel
// ---------------------------------------------------------------------------

const _f = vec3.create();
const _f2 = vec3.create();
const _tq = vec3.create();
const _v = vec3.create();
const _v2 = vec3.create();
const _p = vec3.create();
const _dir = vec3.create();
const _vb = vec3.create();
const _fwd = vec3.create();
const _up = vec3.create();
const _right = vec3.create();
const _q = quat.create();
const _aimFwd = vec3.create();
const _dollyEye = vec3.create();
// Direct-control scratch. Deliberately NOT the shared _fwd/_up/_right/_v set:
// _step computes those from the PRE-step orientation and _sampleMedium has
// already consumed them, so writing the post-step axes over them would be an
// invisible aliasing bug of exactly the kind _allocate's scratch comment warns
// about.
const _dFwd = vec3.create();
const _dUp = vec3.create();
const _dRight = vec3.create();
const _dVel = vec3.create();
const _dAxis = vec3.create();
const _dQ = quat.create();

/**
 * Where the hull's nose points, as a compass heading and a pitch, for code that
 * has to compare the pilot's aim against the airframe.
 *
 * This exists because `quat.toEuler` CANNOT be used for it. toEuler folds roll
 * into yaw and INVERTS its reported pitch past 90 degrees of roll - a hull truly
 * pitched +0.300 reads as -0.300 at 180 degrees of roll - so every consumer that
 * measured the aim against it was reading a fiction whenever the vessel rolled.
 * The forward VECTOR has neither problem: `asin(fwd.y)` is exactly roll-immune,
 * and `headingFromDir` only degenerates where a heading genuinely has no meaning.
 *
 * `heading` is null with the nose inside AIM_RAIL_MIN_HORIZ of vertical, where
 * the heading is both meaningless and ill-conditioned; callers must skip
 * whatever they were going to do with it rather than substitute a value.
 *
 * @param {Float32Array} orientation hull quaternion
 * @returns {{ heading: number|null, pitch: number }} radians
 */
function hullAim(orientation) {
  quat.forward(_aimFwd, orientation);
  const horiz = Math.hypot(_aimFwd[0], _aimFwd[2]);
  return {
    heading: horiz > AIM_RAIL_MIN_HORIZ ? headingFromDir(_aimFwd) : null,
    pitch: Math.asin(clamp(_aimFwd[1], -1, 1)),
  };
}

export class Vessel {
  /**
   * @param {import('../world/collision.js').CollisionWorld} collision
   * @param {GPUDevice} [device] omit for headless physics (tests, servers)
   */
  constructor(collision, device = null) {
    this.collision = collision;
    this.device = device;
    this.name = VESSEL.NAME;

    // --- rigid body ------------------------------------------------------
    this.position = vec3.create(0, 2, 0);
    this.orientation = quat.create();
    this.velocity = vec3.create();
    this.angularVelocity = vec3.create();
    this.mass = VESSEL.MASS;
    this.inertia = vec3.create(VESSEL.INERTIA[0], VESSEL.INERTIA[1], VESSEL.INERTIA[2]);

    /** Previous step's transform, for render interpolation and motion vectors. */
    this.prevPosition = vec3.create(0, 2, 0);
    this.prevOrientation = quat.create();

    // --- medium ----------------------------------------------------------
    /** Submerged volume, m^3, and wetted fraction in [0,1]. */
    this.submergedVolume = 0;
    this.wetted = 0;
    /** Instantaneous physics blend, 0 = air, 1 = water. */
    this.beta = 0;
    /** Lagged control blend. Gains follow this, never `beta`. */
    this.betaControl = 0;
    this.centreOfBuoyancy = vec3.create();
    this.depth = 0;
    this.waterSurfaceY = 0;
    this.groundClearance = Infinity;

    // --- ballast ---------------------------------------------------------
    this.ballastVolume = VESSEL.BALLAST_VOLUME * VESSEL.BALLAST_NEUTRAL;
    /** True only inside simulateUnpiloted(): disables every autopilot channel. */
    this.unpiloted = false;
    /** -1 blowing, 0 settled, +1 flooding. Diagnostics and the compressor draw. */
    this.ballastCommand = 0;

    // --- propulsion ------------------------------------------------------
    const n = VESSEL.NACELLE_COUNT;
    this.nacelleTilt = new Float32Array(n);       // rad, 0 = thrust straight up
    this.nacelleYaw = new Float32Array(n);        // rad, lateral vectoring
    this.nacelleThrottle = new Float32Array(n);   // 0..1, actual (spooled)
    this.nacelleCommand = new Float32Array(n);    // 0..1, demanded
    this.nacelleTiltCommand = new Float32Array(n);
    this.nacelleYawCommand = new Float32Array(n);
    this.nacelleThrust = new Float32Array(n);     // N, this step
    this.nacelleHealth = new Float32Array(n).fill(1);
    this.rotorPhase = new Float32Array(n);
    /** Control-surface deflections, radians. Stern planes and rudder. */
    this.finPitch = 0;
    this.finYaw = 0;
    this.finPitchCommand = 0;
    this.finYawCommand = 0;
    this.nacellePos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      this.nacellePos[i * 3] = VESSEL.NACELLE_POSITIONS[i][0];
      this.nacellePos[i * 3 + 1] = VESSEL.NACELLE_POSITIONS[i][1];
      this.nacellePos[i * 3 + 2] = VESSEL.NACELLE_POSITIONS[i][2];
    }

    // Effector sign patterns and their EFFECTIVE ARMS, for _allocate.
    //
    // Every control effector is one of two antisymmetric patterns over the four
    // nacelles: fore-positive (`signZ`) or starboard-positive (`signX`). Because
    // all four ducts share a common tilt and vectoring angle, the sum
    // `sum_i s_i * (r_i x v)` collapses to `(sum_i s_i * r_i) x v` - so the whole
    // per-nacelle sum reduces to ONE cross product against a vector that is pure
    // geometry and can be computed once, here.
    //
    // Both patterns are antisymmetric, so `sum_i s_i = 0` and every effector is a
    // pure COUPLE: it produces moment without any net force. That is what lets
    // the attitude loop act without disturbing the vertical channel.
    this._signZ = new Float32Array(n);
    this._signX = new Float32Array(n);
    this._armZ = vec3.create();
    this._armX = vec3.create();
    for (let i = 0; i < n; i++) {
      const x = this.nacellePos[i * 3];
      const y = this.nacellePos[i * 3 + 1];
      const z = this.nacellePos[i * 3 + 2];
      const sz = z < 0 ? 1 : -1;        // forward of the CoM counts positive
      const sx = x > 0 ? 1 : -1;        // starboard counts positive
      this._signZ[i] = sz;
      this._signX[i] = sx;
      this._armZ[0] += sz * x; this._armZ[1] += sz * y; this._armZ[2] += sz * z;
      this._armX[0] += sx * x; this._armX[1] += sx * y; this._armX[2] += sx * z;
    }

    // --- control ---------------------------------------------------------
    this.ctrl = {
      collective: 0, translate: 0, lateral: 0,
    };
    /**
     * The AIM: a persistent commanded heading and pitch, integrated from the
     * pointer. This is the whole control scheme - the vessel flies to where the
     * aim points, and W/S drives along it. See AIM_PITCH_LIMIT.
     *
     * `aimYaw` is a compass heading (0 = north, clockwise) and `aimPitch` is
     * positive nose-up, both matching the project's binding convention.
     */
    this.aimYaw = 0;
    this.aimPitch = 0;
    /** Previous-step aim, for render interpolation. See applyCamera(). */
    this.prevAimYaw = 0;
    this.prevAimPitch = 0;
    /**
     * The HULL's own heading and pitch under direct control: the aim passed
     * through one first-order lag each. The orientation quaternion is rebuilt
     * from these two numbers and a literal zero roll every step, which is what
     * makes roll structurally impossible rather than merely small.
     *
     * Held as ANGLES rather than filtered as a quaternion, and that is not a
     * shortcut. Slerping between two zero-roll quaternions does NOT stay
     * zero-roll: the zero-roll orientations are a 2-sphere inside SO(3) and the
     * slerp geodesic leaves it, which is the same reason an FPS camera
     * interpolates yaw and pitch separately instead of slerping look rotations.
     * Measured: slerping from level to heading 90 deg / pitch 45 deg peaks at
     * 9.42 degrees of roll at the midpoint - twenty times the 0.5 degree budget,
     * from an interpolation between two orientations that both have none.
     * Filtering the two chart coordinates is the same exponential lag, expressed
     * in the chart where roll is identically zero.
     */
    this._dirYaw = 0;
    this._dirPitch = 0;
    /** Whether _dirYaw/_dirPitch have been seeded from a real hull attitude. */
    this._dirSeeded = false;
    /** Attitude the controller is flying to, rebuilt every step from the aim. */
    this.attitudeTarget = quat.create();
    /**
     * Scratch and state for the attitude target's ROLL REFERENCE. Dedicated
     * rather than module-level because _updateAttitudeTarget runs inside _mix,
     * where _q already holds conj(orientation) and _fwd/_up/_right are live from
     * _step; aliasing one of those would be invisible until the vessel misbehaved
     * in a way nothing pointed at the mixer. See LEVEL_FADE_LO.
     */
    this._aimDir = vec3.create();
    this._rollUpHull = vec3.create();
    this._rollUpWorld = vec3.create();
    this._rollCross = vec3.create();
    /** Signed roll of the hull about the commanded nose, radians. Persistent so
     *  a degenerate geometry can bleed it out instead of stepping it. */
    this._rollTwist = 0;
    /**
     * Whether a centred vertical trim latches an altitude or depth hold.
     *
     * Public because a test that wants to watch raw buoyancy - the pendulum
     * settling, the neutral trim converging, a free ascent - has to be able to
     * take the thrusters out of the loop. That used to be done by switching the
     * vessel into a "manual" flight mode, which was a whole second control law
     * maintained for the benefit of three test setups.
     */
    this.stationKeeping = true;
    /** World-y reference the vertical hold is flying to, or null when driving. */
    this.holdY = null;
    this.holdPid = new PID(0.90, 0.05, 0.35, 4.0, AZ_CMD_MAX);
    /** Torque the mixer asked for this step, body axes. Diagnostics + HUD. */
    this.commandedTorque = vec3.create();
    /** Body-frame moment the manoeuvring thrusters are delivering, N.m. */
    this.maneuverTorque = vec3.create();
    this.mixerSaturated = false;

    // --- systems ---------------------------------------------------------
    this.hullTier = 0;
    this.powerTier = 0;
    this.hull = VESSEL.MAX_HULL;
    this.hullMax = VESSEL.MAX_HULL;
    this.powerCapacity = VESSEL.POWER_TIERS[0];
    this.power = VESSEL.POWER_TIERS[0];
    this.powerDraw = 0;
    this.cabinOxygen = VESSEL.CABIN_OXYGEN;
    this.silentRunning = false;
    // `work` is ON, which DESIGN/04.6.1 has OFF. It is no longer an ore-picking
    // tool that the player switches in: aimed 40 deg forward-down it is the
    // near-field ground fill, and it is part of what the one lights key drives.
    // 1.02 kW of exterior lighting against an 1,100 kW core.
    this.lights = { flood: true, wide: true, work: true, cabin: true, strobe: false };
    this._lightColor = {};
    for (const id of LIGHT_GROUPS) {
      this._lightColor[id] = kelvinToLinearRGB(vec3.create(), VESSEL_LIGHTS[id.toUpperCase()].kelvin);
    }
    this._creakAccum = 0;
    this._depthWarned = 0;
    this._powerWarned = false;

    // --- transition ------------------------------------------------------
    this.inWater = false;
    this._wasSubmerged = false;
    /** Latched submergence with hysteresis; see the end of _sampleMedium(). */
    this._ctxWet = false;
    /** Live surface height + normal under the vessel centre. */
    this.surfaceSample = createWaterSample();
    this.entryTimer = Infinity;
    this.breachTimer = Infinity;
    this.skipCount = 0;
    this._skipCooldown = 0;
    this.lastEntrySpeed = 0;
    this.lastEntryAngle = 0;

    // --- boarding / camera ----------------------------------------------
    this.piloted = false;
    this.disembarkRequested = false;
    this.boardBlend = 0;
    this.cameraMode = 'cockpit';
    this._chasePos = vec3.create();
    this._chaseVel = vec3.create();
    this._chaseValid = false;
    // Chase-to-cockpit dolly: 1 = the ordinary chase pose, 0 = the camera IS
    // the cockpit pose (position, orientation and FOV all converged), so a
    // CAMERA_TOGGLE at 0 is cut-free. The demo director animates it for the
    // board-and-dive transition; nothing else writes it, and the toggle
    // resets it so free play can never inherit a half-dollied chase view.
    this.chaseDolly = 1;
    /**
     * CHASE-CAMERA PITCH BIAS, radians, SUBTRACTED from the aim pitch where the
     * chase POINT is placed - and nowhere else. Positive lifts the camera and
     * tips the view down, which is what puts a climbing hull's terrain back in
     * frame instead of leaving the summit clipped at the bottom edge.
     *
     * DELIBERATELY NOT ON THE COCKPIT PATH. The cockpit camera is rigidly
     * attached to the hull and must stay that way - the nacelles clear the
     * frame by five degrees and a biased cockpit eye swings them in (see
     * CLAUDE.md's control contract). The chase eye is 12.5 m outside the hull,
     * so nothing can be exposed there.
     *
     * The demo director writes it and restores it to 0 on every exit; free play
     * never touches it, and CAMERA_TOGGLE resets it beside chaseDolly so a
     * reclaimed session can never inherit a tilted chase view.
     */
    this.chasePitchBias = 0;
    this._cameraPos = vec3.create();
    this._cameraQuat = quat.create();
    this.hatchLocal = vec3.create(0, 0.62, -0.35);

    // --- geometry --------------------------------------------------------
    this.sections = buildHullSections(HULL_SECTION_COUNT);
    this.mesh = null;
    this.gpu = null;
    this.nodeMatrices = new Float32Array(VESSEL_NODE_COUNT * 16);
    this.prevNodeMatrices = new Float32Array(VESSEL_NODE_COUNT * 16);
    this.modelMatrix = mat4.create();
    /**
     * The transform this frame is DRAWN at: the sim state interpolated by the
     * render alpha. The mesh and the cockpit eye both come from it, so they can
     * never separate. See applyRender().
     */
    this._renderPos = vec3.create();
    this._renderQuat = quat.create();
    /** Half-extent of the hull in body Y, used by the buoyancy fast paths. */
    this._hullHalfHeight = 1.30;
    this._hullRadius = 4.2;

    this._hullContact = createHullContact();
    this._rng = makeRng(0x4b657374);
    this._time = 0;
    this._lastLightTime = -Infinity;
    this._lightScratch = vec3.create();
    this._lightDir = vec3.create();
    this._lookScratch = new Float32Array(2);
    this._rateCmd = vec3.create();
    this._rate = vec3.create();
    this._attErr = vec3.create();
    this._attTrim = vec3.create();
    this._qErr = quat.create();
    this._camQuat = quat.create();
    // Thrust allocation scratch: the 3x5 moment Jacobian and its solve. See
    // _allocate(). Preallocated because the mixer runs every step.
    this._allocB = new Float64Array(30);
    this._allocU = new Float64Array(10);
    this._allocN = new Float64Array(9);
    this._allocD = vec3.create();
    this._allocDTheta = vec3.create();
    this._allocDPhi = vec3.create();
    this._allocCross = vec3.create();
    /** Fraction of the demanded control moment the actuators could deliver. */
    this.controlAuthority = 1;
    this._scaleOne = vec3.create(1, 1, 1);
    this._nodeLocal = mat4.create();
    this._nodeWorld = mat4.create();
    this.totalThrust = 0;
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  /**
   * Build the mesh and, if a device was supplied, upload it. Physics does not
   * depend on any of this: a headless test can construct a Vessel and fly it.
   */
  init({ tier = 2 } = {}) {
    this.mesh = buildVesselMesh({ tier });
    this._hullRadius = this.mesh.boundingRadius;
    this._hullHalfHeight = Math.max(
      Math.abs(this.mesh.bounds.min[1]), Math.abs(this.mesh.bounds.max[1]));

    if (this.device) {
      this.gpu = {
        vertexBuffer: createVertexBuffer(this.device, this.mesh.vertices, 'vessel.vb'),
        indexBuffer: createIndexBuffer(this.device, this.mesh.indices, 'vessel.ib'),
        stride: VESSEL_VERTEX_STRIDE,
        parts: this.mesh.parts,
      };
    }
    this._updateNodeMatrices(true);
    return this;
  }

  destroy() {
    this.gpu?.vertexBuffer?.destroy();
    this.gpu?.indexBuffer?.destroy();
    this.gpu = null;
  }

  // -------------------------------------------------------------------------
  // Public state
  // -------------------------------------------------------------------------

  /** Latched, hysteresed submergence. See the end of _sampleMedium(). */
  get underwater() { return this._ctxWet; }
  /**
   * Depth the vertical hold is flying to, metres positive down, or null.
   *
   * The HUD's depth tape has always drawn a hold bug from this field; the vessel
   * simply never exposed it, so the bug never appeared.
   */
  get depthHold() {
    if (this.holdY == null || !this._ctxWet) return null;
    return Math.max(0, this.waterSurfaceY - this.holdY);
  }
  get speed() { return vec3.len(this.velocity); }
  get cameraFov() {
    if (this.cameraMode === 'cockpit') return VESSEL.FOV_COCKPIT * (PI / 180);
    // The dolly converges the FOV with the pose, so the toggle at 0 is
    // invisible in every channel the camera has.
    const s = clamp(this.chaseDolly, 0, 1);
    return (VESSEL.FOV_COCKPIT + (VESSEL.FOV_CHASE - VESSEL.FOV_COCKPIT) * s) * (PI / 180);
  }
  /** Effective crush depth, degraded by accumulated hull damage. */
  get depthRating() {
    const base = VESSEL.DEPTH_RATINGS[this.hullTier];
    const h = this.hull / VESSEL.MAX_HULL;
    // 100% -> 1.00, 55% -> 0.85, 35% -> 0.65, 18% -> 0.40 (DESIGN/04.5.3),
    // smoothstepped so the HUD redline slides rather than jumps.
    const mul = 0.40 + 0.60 * smoothstep(0.18, 0.80, h);
    return base * mul;
  }
  get ballastFill() { return this.ballastVolume / VESSEL.BALLAST_VOLUME; }
  get powerFraction() { return this.power / this.powerCapacity; }

  /**
   * Ballast fill that makes the vessel exactly neutral at its current load.
   * Buoyancy is fixed by the hull; the only variable is how much water is in
   * the tanks, so this inverts m_total = rho * V_disp.
   */
  neutralBallastFraction() {
    const target = (RHO_WATER * VESSEL.DISPLACEMENT - VESSEL.MASS) / (RHO_WATER * VESSEL.BALLAST_VOLUME);
    return clamp(target, 0, 1);
  }

  /** World-space hatch position, the reference point for boarding prompts. */
  hatchPosition(out) {
    vec3.transformQuat(out, this.hatchLocal, this.orientation);
    return vec3.add(out, out, this.position);
  }

  canBoard(playerPosition) {
    this.hatchPosition(_p);
    return vec3.dist(_p, playerPosition) <= VESSEL.BOARD_RANGE;
  }

  board() {
    if (this.piloted) return false;
    this.piloted = true;
    this.disembarkRequested = false;
    this.boardBlend = 0;
    // Seed the aim from the hull's CURRENT attitude, so boarding does not
    // command an attitude change. Without this the aim survives from the last
    // flight and you board with the previous sortie's nose attitude still
    // commanded - the vessel pitches the moment you sit down.
    const seat = hullAim(this.orientation);
    if (seat.heading !== null) this.aimYaw = wrapAngle(seat.heading);
    this.aimPitch = clamp(seat.pitch, -AIM_PITCH_LIMIT, AIM_PITCH_LIMIT);
    this.prevAimYaw = this.aimYaw;
    this.prevAimPitch = this.aimPitch;
    // The direct model's own lagged copy starts ON the aim, so the first piloted
    // step commands no motion at all. hullAim is roll-immune, so a vessel parked
    // canted on a slope hands over its true heading and pitch and simply rolls
    // level - it does not inherit a fictitious yaw out of quat.toEuler.
    this._dirYaw = this.aimYaw;
    this._dirPitch = this.aimPitch;
    this._dirSeeded = true;
    this._rollTwist = 0;
    vec3.zero(this._attTrim);
    this.holdY = null;
    this.holdPid.reset();
    events.emit(EVENTS.VESSEL_ENTER, { underwater: this.underwater });
    return true;
  }

  /**
   * Leave the vessel. Writes the world position the player's FEET should
   * appear at: 1.1 m up the hull's own up axis from the hatch, which puts them
   * standing on the crown and clear of every probe sphere, or on the nearest
   * walkable footing when that footing is close enough to have been the thing
   * they stepped down onto.
   */
  disembark(out) {
    this.piloted = false;
    this.disembarkRequested = false;
    this.boardBlend = 0;
    // The lagged hull angles belong to a pilot. Dropping them here means the next
    // board() re-seeds from whatever attitude the rigid body has settled into.
    this._dirSeeded = false;
    this.hatchPosition(out);
    quat.up(_up, this.orientation);
    vec3.scaleAndAdd(out, out, _up, 1.1);
    if (!this.underwater) {
      this.collision.findFooting(_p, out[0], out[2], 2.5, this._time);
      // Only snap to the ground if it is actually near the hatch; a vessel
      // hovering 30 m up must not drop the player onto the seabed.
      if (Math.abs(_p[1] - out[1]) < 4) vec3.copy(out, _p);
    }
    events.emit(EVENTS.VESSEL_EXIT, { underwater: this.underwater, position: out });
    return out;
  }

  /**
   * Move the hull instantly, for the developer jump menu.
   *
   * Seeds the same state board() does, for the same reason board() gives: on the
   * direct path the AIM *is* the commanded attitude, so a hull set down somewhere
   * new with the last sortie's aim still standing pitches the moment the
   * simulation resumes. Roll is a literal 0 - the control contract - and
   * quat.toEuler is never used to read this hull back.
   *
   * @param {number} x @param {number} y @param {number} z  absolute metres
   * @param {number} yaw    compass heading in radians
   * @param {number} pitch  radians, positive UP
   */
  teleport(x, y, z, yaw, pitch) {
    vec3.set(this.position, x, y, z);
    vec3.copy(this.prevPosition, this.position);
    vec3.zero(this.velocity);
    vec3.zero(this.angularVelocity);
    quat.fromEuler(this.orientation, yaw, pitch, 0);
    quat.copy(this.prevOrientation, this.orientation);

    this.aimYaw = wrapAngle(yaw);
    this.aimPitch = clamp(pitch, -AIM_PITCH_LIMIT, AIM_PITCH_LIMIT);
    this.prevAimYaw = this.aimYaw;
    this.prevAimPitch = this.aimPitch;
    this._dirYaw = this.aimYaw;
    this._dirPitch = this.aimPitch;
    this._dirSeeded = true;
    this._rollTwist = 0;
    vec3.zero(this._attTrim);
    this.holdY = null;
    this.holdPid.reset();

    // THE MEDIUM LATCH, written explicitly. `underwater` is a getter over
    // _ctxWet, which only _sampleMedium writes and only through hysteresis on
    // beta (in above 0.72, out below 0.42). A hull carried from the beach to
    // 1300 m would therefore keep reporting DRY until beta climbed on the next
    // step - and main._updateInputContext, the control legend, the Vne limit and
    // the ballast target all read that latch on the very next frame. Every one
    // of those is a "discrete decisions read the latch" clause in the control
    // contract, so the latch is what has to be told.
    // Against the REAL wave surface, not a flat y = 0: the hull can straddle a
    // waterline the chop has moved, and the 0.42/0.72 hysteresis would then hold
    // the wrong answer until beta crossed the far edge.
    this.waterSurfaceY = this.collision.waterHeightAt(x, z, this._time);
    const wet = y < this.waterSurfaceY;
    this._ctxWet = wet;
    this.depth = Math.max(0, this.waterSurfaceY - y);

    // THE WHOLE TRANSITION BLOCK, not just the latch it feeds. _updateTransition
    // compares `inWater` against the new sample on the very next step, so a hull
    // carried from the trench to the beach with `inWater` still true emits
    // vessel:exitWater ON DRY LAND - measured, along with a breach spray and the
    // 0.35x thrust notch that comes with it - and a stale entryTimer carried
    // 0.483 s of entry-drag spike across the jump.
    this.inWater = wet;
    this._wasSubmerged = wet;
    this.entryTimer = Infinity;
    this.breachTimer = Infinity;
    this.skipCount = 0;
    this._skipCooldown = 0;
    this.lastEntrySpeed = 0;
    this.lastEntryAngle = 0;
    this._depthWarned = 0;
    this._creakAccum = 0;
    // betaControl is the control-path gain schedule and it is TAU-lagged, so it
    // carried 0.760 of "submerged" onto the beach. beta itself is recomputed
    // from geometry on the next step; this one is state.
    this.betaControl = wet ? 1 : 0;
    // The tanks are an integrator. Without this the hull arrives with the
    // abyss's flooded ballast - measured 0.594 m^3 - and has to pump it out.
    this.trimNeutral();

    // The chase camera runs a critically damped spring on an ABSOLUTE point.
    // Without this it integrates the whole jump and flies across the world - see
    // the snap flag in applyCamera().
    this._chaseValid = false;

    // SEED THE MOTION-VECTOR HISTORY. _updateNodeMatrices' own comment names
    // this caller ("construction, boarding, a teleport"). Without it the first
    // applyRender() rolls the DEPARTURE's node matrices into prevNodeMatrices,
    // and entity.wgsl's prevModel then describes a hull 3.6 km away: measured
    // 3601.3 m of per-node translation delta on the first rendered frame, 0.0000
    // on the second. camera.resetHistory() does not cover this - it equalises
    // prevViewProj, and per-object motion vectors are an independent source.
    this._updateNodeMatrices(true);
  }

  // -------------------------------------------------------------------------
  // Simulation entry points
  // -------------------------------------------------------------------------

  /**
   * One fixed step with the player at the controls.
   *
   * With `piloted` set - which is what board() does, and what the game always
   * does before calling this - the step is DIRECT: see _directControl. Calling it
   * on a vessel that is not flagged piloted runs the rigid body instead, which is
   * what the offline physics suites in tools/test-entities.mjs rely on to exercise
   * buoyancy, the transition and the surface skip.
   */
  simulate(dt, input, worldSeconds) {
    this._readInput(input, dt);
    this._step(dt, worldSeconds);
    if (this.boardBlend < 1) {
      this.boardBlend = saturate(this.boardBlend + dt / VESSEL.BOARD_DURATION);
    }
  }

  /**
   * Step the vessel with nobody aboard.
   *
   * An unpiloted vessel must be INERT: gravity, buoyancy, drag and ground
   * contact only, with every autopilot channel off.
   *
   * Leaving the assist running looks reasonable - "it holds station" - and is
   * badly wrong. The altitude channel latches a hold reference and then flies
   * to maintain it, so a vessel parked on a beach lifts off its skids and any
   * bias in the thrust model walks it away. It really did: the Kestrel climbed
   * 25 m and departed at 10 m/s, which meant the player could never reach it to
   * board, and E appeared to be broken.
   *
   * Station-keeping is a PILOTED convenience. Parked, the thing sits still.
   */
  simulateUnpiloted(dt, worldSeconds) {
    const c = this.ctrl;
    c.collective = 0; c.translate = 0; c.lateral = 0;
    this.holdY = null;
    this.unpiloted = true;
    this._step(dt, worldSeconds);
    this.unpiloted = false;
    if (this.boardBlend > 0) {
      this.boardBlend = saturate(this.boardBlend - dt / VESSEL.EXIT_DURATION);
    }
  }

  _readInput(input, dt) {
    const c = this.ctrl;
    // THROTTLE is the fore/aft axis, MOVE_RIGHT is strafe, MOVE_UP is optional
    // vertical trim. That is the whole movement input set; everything else about
    // where the vessel goes comes from the aim below.
    c.translate = input.axis(ACTION.THROTTLE);
    c.lateral = input.axis(ACTION.MOVE_RIGHT);
    c.collective = input.axis(ACTION.MOVE_UP);

    // THE AIM. The mouse integrates a persistent heading and pitch, exactly as
    // it does on foot, and the airframe flies to it. See AIM_PITCH_LIMIT for
    // why this replaced a pitch-aim/yaw-rate hybrid, and why the gain is 1.0.
    this.prevAimYaw = this.aimYaw;
    this.prevAimPitch = this.aimPitch;
    // input.look() DRAINS the accumulator, and exactly ONE consumer may call it
    // per sim step (Player or Vessel, never both). The full drain contract -
    // per-frame arrival vs per-step consumption, why endFrame() must not clear
    // the deltas - is at look()'s docstring in core/input.js.
    const look = input.look(this._lookScratch, dt);
    // THE AIM IS POSITIONAL. It integrates the pointer EXACTLY - no rate limit, no
    // queue, no smoothing - so it is the same instrument in the cockpit as on foot.
    //
    // Both of the things this replaces failed, in opposite directions, and the
    // second one is the more instructive:
    //
    // A per-step rate CLAMP discarded whatever the pointer delivered above one
    // step's allowance. input.look() drains the accumulator, so the excess was not
    // deferred, it was destroyed: a swipe worth 75.6 degrees on foot moved the aim
    // 11.7, and the player had to swipe five times to turn once.
    //
    // Queuing the remainder instead fixed the loss and bought a worse problem. A
    // queue is a signed NET accumulator, so input in the opposite direction has to
    // cancel the backlog before the aim can move that way at all. Measured: 20
    // frames of mouse-left banked up 70 degrees of undelivered travel, and when the
    // mouse reversed the aim carried on LEFT for another 13 degrees over 0.32 s
    // before it would turn. A sustained sweep queued 235 degrees and took 0.97 s to
    // reverse. That is indistinguishable from inertia, and it punished exactly the
    // fast corrective inputs it should have served best. A queue is simply the wrong
    // structure for a pointing device: the player is telling us where their hand IS,
    // not asking us to replay where it has BEEN.
    //
    // Positional has neither failure. Nothing is lost, because the aim is an exact
    // integral; nothing lags, because a reversal moves the aim on the very next
    // step.
    //
    // AND THERE IS NOTHING ELSE. No rail, no clamp against the hull, no coupled-roll
    // budget - the two lines below are the whole of the pointer path, so the gain is
    // exactly 1.000 at every aim pitch. What used to sit here was an offset rail
    // whose yaw width tightened with pitch to bound the roll a heading offset
    // couples out of the geometry, and it was measurably eating the player's hand:
    // gain 0.913 at 15 degrees of aim pitch, 0.504 at 30, 0.358 at 45, 0.303 at 60.
    // It also had to reopen above 65 degrees, where it then permitted 110-114
    // degrees of coupled roll against its own 31.5 degree budget. Both failures are
    // the same failure - the rail was defending against an attitude error that a
    // kinematic hull does not have. See _directControl, and AIM_PITCH_LIMIT.
    this.aimYaw = wrapAngle(this.aimYaw + look[0]);
    this.aimPitch = clamp(this.aimPitch + look[1], -AIM_PITCH_LIMIT, AIM_PITCH_LIMIT);

    if (input.wasPressed(ACTION.CAMERA_TOGGLE)) {
      this.cameraMode = this.cameraMode === 'cockpit' ? 'chase' : 'cockpit';
      this._chaseValid = false;
      this.chaseDolly = 1;
      this.chasePitchBias = 0;
    }
    if (input.wasPressed(ACTION.LIGHTS_TOGGLE)) this.toggleExteriorLights();
    if (input.wasPressed(ACTION.LIGHTS_FLOOD)) this.toggleLight('flood');
    if (input.wasPressed(ACTION.LIGHTS_WIDE)) this.toggleLight('wide');
    if (input.wasPressed(ACTION.LIGHTS_WORK)) this.toggleLight('work');
    if (input.wasPressed(ACTION.LIGHTS_CABIN)) this.toggleLight('cabin');
    // Silent running is a submerged concept; pressing it in the air is a no-op
    // rather than a state the player then has to notice and undo.
    if (input.wasPressed(ACTION.SILENT_RUNNING) && this._ctxWet) {
      this.setSilentRunning(!this.silentRunning);
    }
    // The vessel owns the input while it is being flown, so it is the vessel
    // that hears the egress key; the player consumes the flag next tick.
    if (input.wasPressed(ACTION.DISEMBARK)) this.disembarkRequested = true;
  }

  toggleLight(group) {
    if (!(group in this.lights)) return;
    if (this.silentRunning && group !== 'cabin') return;
    this.lights[group] = !this.lights[group];
    events.emit(EVENTS.VESSEL_LIGHT_TOGGLE, { group, on: this.lights[group] });
  }

  /**
   * The single "lights on" verb: every exterior beam at once.
   *
   * L used to toggle `flood` ALONE, and that is the whole of the playtest report
   * - two lamps 1.24 m apart with nothing else lit ahead read as "2 little jets
   * of light in an inverted V shape" and, close in, as two circles on the rock.
   * The wide beams were on the whole time and contributed nothing to it: they
   * aimed 25 deg OUTBOARD, so they lit the flanks, and they had no key in the
   * legend at all. One switch now turns on the core, the fill and the ground
   * lamp together, which is what a headlight switch means.
   *
   * The strobe is deliberately NOT in the package - it is an emergency beacon
   * and an always-on one is unusable - and the cabin lamp is interior, so it
   * keeps its own switch. The digit keys still reach every group individually.
   */
  toggleExteriorLights() {
    if (this.silentRunning) return;
    const on = !EXTERIOR_LIGHT_GROUPS.some((id) => this.lights[id]);
    for (const id of EXTERIOR_LIGHT_GROUPS) {
      if (this.lights[id] === on) continue;
      this.lights[id] = on;
      events.emit(EVENTS.VESSEL_LIGHT_TOGGLE, { group: id, on });
    }
  }

  /**
   * Silent running: everything that radiates goes off and thrust is capped
   * below the cavitation and motor-noise thresholds. The player trades seeing
   * for being seen.
   */
  setSilentRunning(on) {
    this.silentRunning = on;
    if (on) {
      for (const id of LIGHT_GROUPS) {
        if (id !== 'cabin') this.lights[id] = false;
      }
    }
  }

  // -------------------------------------------------------------------------
  // The step
  // -------------------------------------------------------------------------

  _step(dt, worldSeconds) {
    this._time = worldSeconds;
    vec3.copy(this.prevPosition, this.position);
    quat.copy(this.prevOrientation, this.orientation);

    quat.forward(_fwd, this.orientation);
    quat.up(_up, this.orientation);
    quat.right(_right, this.orientation);

    this._sampleMedium(dt, worldSeconds);
    this._updateBallast(dt);

    const mass = VESSEL.MASS + RHO_WATER * this.ballastVolume;
    this.mass = mass;
    // Flooding the tanks adds distributed mass; the diagonal grows with it.
    const inertiaScale = mass / VESSEL.MASS;
    this.inertia[0] = VESSEL.INERTIA[0] * inertiaScale;
    this.inertia[1] = VESSEL.INERTIA[1] * inertiaScale;
    this.inertia[2] = VESSEL.INERTIA[2] * inertiaScale;

    this._updateTransition(dt);

    // ---- the fork ---------------------------------------------------------
    // PILOTED: kinematic. The orientation, velocity and position are WRITTEN by
    // _directControl, and the whole force pipeline below is skipped - there is no
    // wrench to accumulate and nothing to integrate. Terrain contact still runs,
    // and it still runs against the real hull probes with real impulses, which is
    // what keeps a kinematic vessel out of the seabed.
    //
    // Everything else in this method is shared: the wave field, the ballast, the
    // submergence latch, the mass, the transition events, the systems and the node
    // matrices all behave identically either way.
    if (this._directControl(dt, mass)) {
      this._updateActuators(dt);
      this._resolveTerrain(dt);
      this._updateSystems(dt);
      return;
    }

    if (this.unpiloted) {
      // Engines off, and that has to mean the NACELLE THROTTLES are zero.
      // Skipping only the collective channel was not enough: the mixer still
      // emitted the hover term that cancels gravity, so the vessel held station
      // and then climbed away on the smallest thrust-model bias. With nobody
      // aboard the Kestrel is a heavy object - gravity, buoyancy, drag and the
      // ground, nothing else.
      // The COMMANDS have to be zeroed, not just the current throttle.
      // _updateActuators runs immediately below and spools the throttle toward
      // nacelleCommand, so zeroing only the throttle is undone within the same
      // step - it leaves the last flown step's demand standing and the engines
      // spool straight back up. Measured: a vessel parked after a fast flight
      // climbed 61 m in 4 seconds with nobody aboard.
      //
      // This is the same failure recorded as fixed once already ("the
      // vessel flew away by itself"), and it was only half fixed. It stayed hidden
      // because nothing ever flew the Kestrel hard and then stepped out of it.
      this.nacelleThrottle.fill(0);
      this.nacelleCommand.fill(0);
      this.finPitchCommand = 0;
      this.finYawCommand = 0;
      vec3.zero(this.commandedTorque);
      this.mixerSaturated = false;
      this.controlAuthority = 1;
    } else {
      this._mix(dt, mass);
    }
    this._updateActuators(dt);

    // ---- accumulate forces and torques, world frame ----------------------
    vec3.zero(_f);
    vec3.zero(_tq);
    this._applyGravity(_f, mass);
    this._applyBuoyancy(_f, _tq);
    this._applyThrust(_f, _tq);
    this._applyManeuver(_f, _tq);
    this._applyAero(_f, _tq);
    this._applyHydro(_f, _tq);
    this._applyEntrySlam(_f, _tq);

    this._integrate(dt, _f, _tq, mass);
    this._resolveTerrain(dt);
    this._updateSystems(dt);
  }

  // -------------------------------------------------------------------------
  // Direct control - the piloted path
  // -------------------------------------------------------------------------

  /**
   * Fly the vessel KINEMATICALLY: the hull points where the aim points and moves
   * along it. Writes the orientation, the velocity and the position outright.
   *
   * WHY THIS REPLACED A CONTROL CASCADE. The rigid-body path did everything a
   * flight control system should - shortest-arc attitude error, a rate inner
   * loop, a headroom-weighted allocator over ten effectors, plant inversion on
   * the effective inertia - and the vessel was still, measurably, not steerable.
   * The hull was the entire lag: a 0.15 s hand swipe worth 126 degrees had moved
   * the view 0.47 degrees (0.4%) at the moment the hand stopped, and the rest
   * arrived over the following five seconds; tau63 was 0.8-1.4 s. Everything
   * upstream of the airframe - the DOM, the accumulator, the aim gain, the camera
   * - measured exact. That is not a tuning problem. A 4.5 tonne body with 6 MN.m
   * of fin stiffness at 38 m/s genuinely cannot be re-pointed faster than that,
   * so the honest options were to keep an unflyable vehicle or to stop simulating
   * the airframe on the piloted path. The user chose the second, explicitly.
   *
   * WHAT IT COSTS, stated plainly so nobody has to rediscover it: a piloted
   * Kestrel has no momentum, no angle of attack, no sideslip, no stall, no
   * hydrodynamic weathervane and no coupling of any kind between its axes.
   * Releasing the throttle stops it in mid-air. All of that physics still exists
   * and still runs for an unpiloted hull, which is why the whole force pipeline
   * is still in this file.
   *
   * WHAT IT KEEPS: terrain contact (real probes, real impulses - see
   * _resolveTerrain, called by _step immediately after this), the submergence
   * latch and its hysteresis, depth, pressure and crush damage, ballast and
   * buoyancy STATE, the water-entry and breach events, power, lights and hull
   * integrity, and the rigid cockpit camera.
   *
   * @param {number} dt fixed step, seconds
   * @param {number} mass current mass including flooded ballast, kg
   * @returns {boolean} true if this step was handled here and _step must stop
   */
  _directControl(dt, mass) {
    if (!this.piloted || this.unpiloted) return false;
    if (!this._dirSeeded) {
      // Anything that sets `piloted` without going through board() lands here, and
      // seeding from the hull is what stops such a vessel snapping to a stale aim.
      const seat = hullAim(this.orientation);
      this._dirYaw = seat.heading !== null ? wrapAngle(seat.heading) : this.aimYaw;
      this._dirPitch = clamp(seat.pitch, -AIM_PITCH_LIMIT, AIM_PITCH_LIMIT);
      this._dirSeeded = true;
    }
    const c = this.ctrl;

    // ---- attitude --------------------------------------------------------
    // One first-order lag per chart coordinate, k = 1 - exp(-dt/tau), which is
    // frame-rate independent and stores NOTHING: whatever the pointer delivered
    // this step is already in `aimYaw`/`aimPitch`, and this only decides how fast
    // the hull closes on it. A rate limit or a queue in this position is what
    // destroyed or replayed the player's hand movement in the two models before
    // this one; a lag on a positional target can do neither.
    //
    // The yaw filter runs on the WRAPPED delta, so a heading crossing north takes
    // the short way. The pitch filter needs no wrap - it is clamped to +/-85 deg.
    const kA = 1 - Math.exp(-dt / VESSEL.DIRECT_AIM_TAU);
    this._dirYaw = wrapAngle(this._dirYaw + wrapAngle(this.aimYaw - this._dirYaw) * kA);
    this._dirPitch += (this.aimPitch - this._dirPitch) * kA;
    // ROLL IS THE LITERAL CONSTANT ZERO. Not a small number, not a damped
    // reference, not a channel the controller nulls - an argument that is always
    // 0, so `right.y` is 0 by construction at every attitude. That is the change
    // that makes "no lateral rolls or barrel rolls" structural instead of merely
    // bounded, and it is why the coupled-roll budget, the levelness fade and the
    // roll rate ceiling are all off this path.
    quat.fromEuler(this.orientation, this._dirYaw, this._dirPitch, 0);

    // ---- angular velocity, DERIVED ---------------------------------------
    // The body is kinematic, so its angular velocity is not integrated, it is the
    // finite difference of the attitude. It still has to be right: resolveVesselHull
    // builds each contact point's velocity as v + omega x r, so a stale or zero
    // omega would let a probe on the far end of a 7.4 m hull resolve against the
    // wrong closing speed. (Contact impulses do write back into it; the next step
    // simply recomputes it.)
    quat.conjugate(_dQ, this.prevOrientation);
    quat.multiply(_dQ, this.orientation, _dQ);
    if (_dQ[3] < 0) { _dQ[0] = -_dQ[0]; _dQ[1] = -_dQ[1]; _dQ[2] = -_dQ[2]; _dQ[3] = -_dQ[3]; }
    const sinHalf = Math.hypot(_dQ[0], _dQ[1], _dQ[2]);
    if (sinHalf > 1e-9 && dt > 0) {
      const s = (2 * Math.atan2(sinHalf, _dQ[3])) / (sinHalf * dt);
      vec3.set(this.angularVelocity, _dQ[0] * s, _dQ[1] * s, _dQ[2] * s);
    } else {
      vec3.zero(this.angularVelocity);
    }

    // ---- velocity --------------------------------------------------------
    quat.forward(_dFwd, this.orientation);
    quat.up(_dUp, this.orientation);
    quat.right(_dRight, this.orientation);

    // A CENTRED THROTTLE COMMANDS A STOP. That clause of the old contract is the
    // one thing about the throttle that was always right, and it survives for
    // free here: with the stick centred the target velocity is the zero vector
    // and the same lag that accelerates the vessel decelerates it.
    const vMax = this._directSpeedLimit();
    const surge = c.translate >= 0
      ? c.translate * vMax
      : c.translate * vMax * VESSEL.DIRECT_REVERSE_FRAC;
    vec3.scale(_dVel, _dFwd, surge);
    vec3.scaleAndAdd(_dVel, _dVel, _dRight, c.lateral * VESSEL.DIRECT_STRAFE_SPEED);
    vec3.scaleAndAdd(_dVel, _dVel, _dUp, c.collective * VESSEL.DIRECT_VERT_SPEED);

    const kV = 1 - Math.exp(-dt / VESSEL.DIRECT_VEL_TAU);
    // Written component-wise rather than through vec3.lerp because the CONTACT
    // impulses from the previous step are still sitting in `this.velocity`, and
    // they must decay through this filter like anything else - that is what makes
    // a vessel held against a cliff push rather than either stick or tunnel.
    this.velocity[0] += (_dVel[0] - this.velocity[0]) * kV;
    this.velocity[1] += (_dVel[1] - this.velocity[1]) * kV;
    this.velocity[2] += (_dVel[2] - this.velocity[2]) * kV;
    vec3.clampLen(this.velocity, this.velocity, MAX_LINEAR_SPEED);
    vec3.scaleAndAdd(this.position, this.position, this.velocity, dt);

    // The HUD's depth tape draws a hold bug from `holdY`. Under direct control a
    // centred throttle really does hold the altitude or depth it has - exactly,
    // and without an autopilot - so reporting it is the truth and not a prop.
    const idle = Math.abs(c.translate) < 0.01 && Math.abs(c.lateral) < 0.01 &&
      c.collective === 0;
    this.holdY = this.stationKeeping && idle ? this.position[1] : null;

    // No allocation happens on this path, so there is no saturation and no
    // authority to report. Unity is the honest value: every commanded attitude is
    // delivered, because the attitude IS the command.
    vec3.zero(this.commandedTorque);
    vec3.zero(this.maneuverTorque);
    this.mixerSaturated = false;
    this.controlAuthority = 1;

    this._directActuators(mass);

    if (!vec3.isFinite(this.position) || !vec3.isFinite(this.velocity) ||
        !Number.isFinite(this.orientation[3])) {
      console.error('[Vessel] non-finite direct-control state; restoring previous transform');
      vec3.copy(this.position, this.prevPosition);
      quat.copy(this.orientation, this.prevOrientation);
      vec3.zero(this.velocity);
      vec3.zero(this.angularVelocity);
      this._dirSeeded = false;
    }
    return true;
  }

  /**
   * Top speed under direct control, m/s.
   *
   * Read off the LATCHED `underwater`, never off raw `beta` - a hull at the
   * surface swings beta from 0.3 to 0.9 with the chop, and a speed limit that
   * swung 120 <-> 38 with it would slam a cruising vessel several times a second.
   * That clause of the contract survives unchanged.
   *
   * The flight computer also SLOWS DOWN FOR THE WATER on a descent. Arriving from
   * the air at 120 m/s costs 0.42 * (120-38)^1.45 = 250% of the hull to the slam
   * term in _onWaterEntry, so without this the single most obvious thing to do
   * with a flying submarine destroys it. The window is a time-to-surface rather
   * than an altitude, so skimming the waves at Vne stays legal; it terminates
   * because the cap never falls below MAX_SUBSPEED, so the vessel keeps closing.
   */
  _directSpeedLimit() {
    let vMax = this._ctxWet ? VESSEL.MAX_SUBSPEED : VESSEL.MAX_AIRSPEED;
    if (!this._ctxWet && this.velocity[1] < -0.1) {
      const toSurface = (this.position[1] - this.waterSurfaceY) / -this.velocity[1];
      vMax = lerp(VESSEL.MAX_SUBSPEED, vMax,
        smoothstep(SURFACE_SLOW_LEAD_MIN, SURFACE_SLOW_LEAD_MAX, toSurface));
    }
    return vMax;
  }

  /**
   * Point the ducts and deflect the fins the way a vessel actually holding this
   * state would have to.
   *
   * DISPLAY AND POWER ONLY. Under direct control no thrust is applied to
   * anything - _applyThrust is not called on this path - so this schedule cannot
   * move the vessel and is not a control law. It exists because the nacelles,
   * their rotors and the control surfaces are visible parts of the model that the
   * player watches, and because _updatePower charges the cell from
   * `nacelleThrottle`: a vessel that flies with its ducts frozen pointing up and
   * draws no current would be a lie in both places.
   *
   * The numbers are not invented. The ducts are pointed along the force a real
   * hull would need - the residual of weight against buoyancy, plus the drag of
   * moving at this speed - and the throttle is that force over the thrust
   * genuinely available at this speed and in this medium, lapse included. Full
   * ahead submerged therefore tilts them to horizontal and shows a low throttle,
   * which is exactly what the rigid-body mixer used to compute, for the same
   * reasons.
   *
   * @param {number} mass current mass including flooded ballast, kg
   */
  _directActuators(mass) {
    const n = VESSEL.NACELLE_COUNT;
    const spd = vec3.len(this.velocity);
    const rho = lerp(airDensity(this.position[1]), RHO_WATER, this.beta);

    const residual = mass * G - RHO_WATER * G * this.submergedVolume;
    const drag = 0.5 * rho * this._surgeDragArea() * spd * spd;
    vec3.set(_dVel, 0, residual, 0);
    if (spd > 1e-3) vec3.scaleAndAdd(_dVel, _dVel, this.velocity, drag / spd);
    quat.conjugate(_dQ, this.orientation);
    vec3.transformQuat(_dVel, _dVel, _dQ);              // body frame
    const fLen = vec3.len(_dVel);

    // Thrust axis d(theta,phi) = (-cos t sin p, cos t cos p, sin t): the body-Z
    // component is sin(theta) outright, which inverts without an atan2 on a
    // quantity that is zero by definition at neutral trim.
    let tiltCmd = 0;
    let yawCmd = 0;
    if (fLen > 1e-3) {
      tiltCmd = clamp(Math.asin(clamp(_dVel[2] / fLen, -1, 1)),
        TILT_SCHED_MIN, TILT_SCHED_MAX);
      const weight = mass * G;
      yawCmd = clamp(Math.atan2(-_dVel[0], _dVel[1]),
        VESSEL.NACELLE_YAW_RANGE[0], VESSEL.NACELLE_YAW_RANGE[1])
        * smoothstep(YAW_SCHED_LO * weight, YAW_SCHED_HI * weight,
          Math.hypot(_dVel[0], _dVel[1]));
    }
    const ct = Math.cos(tiltCmd), st = Math.sin(tiltCmd);
    const cp = Math.cos(yawCmd), sp = Math.sin(yawCmd);

    const tStatic = this._maxThrustPerNacelle();
    vec3.set(_dAxis, -ct * sp, ct * cp, st);
    vec3.transformQuat(_dAxis, _dAxis, this.orientation);
    const tMax = Math.max(1,
      tStatic * thrustLapse(tStatic, rho, vec3.dot(this.velocity, _dAxis)));

    let cmd = clamp(fLen / (n * tMax), 0, 1);
    if (this.silentRunning) cmd = Math.min(cmd, SILENT_THROTTLE_CAP);
    for (let i = 0; i < n; i++) {
      this.nacelleCommand[i] = cmd;
      this.nacelleTiltCommand[i] = tiltCmd;
      this.nacelleYawCommand[i] = yawCmd;
      this.nacelleThrust[i] = this.nacelleThrottle[i] * tMax * this.nacelleHealth[i];
    }
    this.totalThrust = cmd * tMax * n;

    // Control surfaces deflect with the aim error, which is what a stern plane
    // and a rudder visibly do while a vehicle is turning. Sign follows the same
    // handedness as the hydrodynamic term in _applyHydro: a positive body-X
    // moment is nose-UP, a positive body-Y moment is nose-to-PORT, so a turn to
    // starboard shows negative rudder.
    const pitchErr = this.aimPitch - this._dirPitch;
    const yawErr = wrapAngle(this.aimYaw - this._dirYaw);
    this.finPitchCommand = clamp(pitchErr * FIN_DISPLAY_GAIN,
      -FIN_DEFLECT_MAX, FIN_DEFLECT_MAX);
    this.finYawCommand = clamp(-yawErr * FIN_DISPLAY_GAIN,
      -FIN_DEFLECT_MAX, FIN_DEFLECT_MAX);
  }

  // -------------------------------------------------------------------------
  // Medium sampling
  // -------------------------------------------------------------------------

  /**
   * Integrate the submerged volume by slicing the hull at its physics
   * stations. Each station contributes its cross-sectional area times the
   * fraction of that area below the local wave height; the first moment of the
   * same integral is the centre of buoyancy, which is what rights the vessel.
   */
  _sampleMedium(dt, time) {
    const col = this.collision;
    const pos = this.position;
    // Full sample (height AND normal): the slam model needs the normal, and on
    // a steep wave face it is nowhere near vertical.
    col.waterSurfaceAt(pos[0], pos[2], time, this.surfaceSample);
    this.waterSurfaceY = this.surfaceSample.y;
    this.depth = Math.max(0, this.waterSurfaceY - pos[1]);
    this.groundClearance = pos[1] - col.heightAt(pos[0], pos[2]);

    // Fast paths. The hull's vertical half-extent when rolled to any attitude
    // is bounded by its bounding radius, and the wave field cannot exceed a few
    // metres, so a 6 m margin is a safe decision boundary.
    const reach = this._hullRadius * 0.55 + 6;
    if (pos[1] - reach > this.waterSurfaceY) {
      this.submergedVolume = 0;
      this.wetted = 0;
      vec3.copy(this.centreOfBuoyancy, pos);
    } else if (pos[1] + reach < this.waterSurfaceY) {
      this.submergedVolume = VESSEL.DISPLACEMENT;
      this.wetted = 1;
      vec3.set(_v, VESSEL.COB_OFFSET[0], VESSEL.COB_OFFSET[1], VESSEL.COB_OFFSET[2]);
      vec3.transformQuat(this.centreOfBuoyancy, _v, this.orientation);
      vec3.add(this.centreOfBuoyancy, this.centreOfBuoyancy, pos);
    } else {
      const s = this.sections;
      let volume = 0, mx = 0, my = 0, mz = 0;
      // Vertical half-extent of a station's cross-section at this attitude:
      // the section spans (a) along body X and (b) along body Y, so its
      // projection onto world Y is |a * right.y| + |b * up.y|.
      const upY = Math.abs(_up[1]);
      const rightY = Math.abs(_right[1]);
      for (let i = 0; i < s.count; i++) {
        vec3.set(_v, 0, s.yc[i], s.z[i]);
        vec3.transformQuat(_v2, _v, this.orientation);
        const wx = pos[0] + _v2[0], wy = pos[1] + _v2[1], wz = pos[2] + _v2[2];
        const halfV = Math.max(0.02, s.b[i] * upY + s.a[i] * rightY);
        const waterY = col.waterHeightAt(wx, wz, time);
        const f = clamp((waterY - (wy - halfV)) / (2 * halfV), 0, 1);
        if (f <= 0) continue;
        const frac = areaBelowFraction(f, s.n[i]);
        const v = s.area[i] * s.dz[i] * frac;
        volume += v;
        mx += wx * v;
        my += (wy - halfV * (1 - f)) * v;
        mz += wz * v;
      }
      this.submergedVolume = volume;
      this.wetted = saturate(volume / VESSEL.DISPLACEMENT);
      if (volume > 1e-5) {
        vec3.set(this.centreOfBuoyancy, mx / volume, my / volume, mz / volume);
        // As the hull goes fully under, hand over to the exact metacentric
        // offset so the self-righting moment matches VESSEL.COB_OFFSET.
        const k = smoothstep(0.90, 1.0, this.wetted);
        if (k > 0) {
          vec3.set(_v, VESSEL.COB_OFFSET[0], VESSEL.COB_OFFSET[1], VESSEL.COB_OFFSET[2]);
          vec3.transformQuat(_v2, _v, this.orientation);
          vec3.add(_v2, _v2, pos);
          vec3.lerp(this.centreOfBuoyancy, this.centreOfBuoyancy, _v2, k);
        }
      } else {
        vec3.copy(this.centreOfBuoyancy, pos);
      }
    }

    this.beta = smoothstep(0.05, 0.95, this.wetted);
    this.betaControl = damp(this.betaControl, this.beta, 1 / CONTROL_BLEND_TAU, dt);

    // LATCHED submergence, with the hysteresis DESIGN/12.10.1 calls mandatory.
    //
    // Every DISCRETE decision - which input context is live, which legend is on
    // screen, which Vne applies, whether the overspeed check uses the air or the
    // water limit, where the ballast is heading - reads this and never raw `beta`.
    // A hull sitting at the surface has `beta` swinging roughly 0.3 to 0.9 with
    // the chop, so a bare `beta > 0.5` test flips all of those several times a
    // second: the binding set changes under the player's fingers, and Vne jumps
    // between 120 and 38 m/s at wave frequency, which slams a cruising vessel.
    // The band is wide enough that one wave cannot cross both edges.
    if (!this._ctxWet && this.beta > 0.72) this._ctxWet = true;
    else if (this._ctxWet && this.beta < 0.42) this._ctxWet = false;
  }

  // -------------------------------------------------------------------------
  // Ballast
  // -------------------------------------------------------------------------

  /**
   * Automatic ballast.
   *
   * ONE ACTUATOR, ONE OBJECTIVE: the tanks null the residual FORCE, and nothing
   * else. Holding a POSITION is the thrusters' job, in _mix. That division is the
   * whole content of this rewrite.
   *
   * What it replaces did both. It nulled the residual AND chased the depth error,
   * while _mix's depthPid chased the same depth error with the thrusters - two
   * integrating actuators on one plant with no arbitration between them. And the
   * pump was bang-bang with a deadband of 0.0025 m^3 against a per-step increment
   * of 0.0035 (flood) or 0.00567 (blow), so the deadband was SMALLER than one
   * step's movement: a limit cycle of plus or minus 3.6 to 5.8 kg at the sim rate,
   * guaranteed by arithmetic. Rate-limiting toward an exact target lands on it and
   * stops, so there is no deadband to get wrong.
   *
   * The target is also what removes the dive and surface keys. Submerged, the
   * tanks flood to neutral so the vessel goes where it is pointed. At the surface
   * they blow dry, which leaves about 6 kN of reserve buoyancy - so the Kestrel
   * FLOATS rather than wallowing at the waterline, and diving is a matter of
   * aiming down and opening the throttle.
   */
  _updateBallast(dt) {
    const target = this._ctxWet
      ? VESSEL.BALLAST_VOLUME * this.neutralBallastFraction()
      : 0;
    const prev = this.ballastVolume;
    let rate;
    if (target > prev) {
      // Flooding is free: the sea does the work through open vents.
      rate = VESSEL.BALLAST_FILL_RATE;
    } else {
      // Blowing needs HP air, and below BLOW_DEPTH_LIMIT the flask can no longer
      // overcome ambient pressure at all. DESIGN/04.3.3's central dread mechanic.
      rate = VESSEL.BALLAST_BLOW_RATE * clamp(1 - this.depth / BLOW_DEPTH_LIMIT, 0, 1);
    }
    this.ballastVolume = moveTowards(this.ballastVolume, target, rate * dt);
    // The HP air compressor draws the same power whether a human or the trim
    // computer opened the valve; _updatePower reads this field to charge it.
    this.ballastCommand = Math.sign(this.ballastVolume - prev);
  }

  /** Snap the tanks to the neutral fill for the current load. */
  trimNeutral() {
    this.ballastVolume = VESSEL.BALLAST_VOLUME * this.neutralBallastFraction();
  }

  // -------------------------------------------------------------------------
  // Transition
  // -------------------------------------------------------------------------

  _updateTransition(dt) {
    if (this.entryTimer < Infinity) this.entryTimer += dt;
    if (this.breachTimer < Infinity) this.breachTimer += dt;
    if (this._skipCooldown > 0) {
      this._skipCooldown -= dt;
      if (this._skipCooldown <= 0) this.skipCount = 0;
    }

    const wet = this.wetted > 0.05;
    if (wet && !this.inWater) {
      this.inWater = true;
      this._onWaterEntry();
    } else if (!wet && this.inWater) {
      this.inWater = false;
    }

    // Breach: the ducts clear the surface and thrust recovers over 300 ms.
    if (this.wetted < 0.95 && this._wasSubmerged) {
      this._wasSubmerged = false;
      this.breachTimer = 0;
      events.emit(EVENTS.VESSEL_EXIT_WATER, {
        speed: this.speed, position: this.position,
      });
    } else if (this.wetted >= 0.95) {
      this._wasSubmerged = true;
    }
  }

  /**
   * First contact with the water. Either the hull skips off the surface (a
   * shallow, fast, flat entry - exactly what a stone or a badly flown seaplane
   * does) or it commits and the slam model takes over.
   */
  _onWaterEntry() {
    const speed = vec3.len(this.velocity);
    if (speed < 0.1) { this.entryTimer = 0; return; }

    const nrm = this.surfaceSample.normal;

    const vn = vec3.dot(this.velocity, nrm);         // negative going in
    const gamma = Math.asin(clamp(-vn / speed, -1, 1));
    this.lastEntrySpeed = -vn;
    this.lastEntryAngle = gamma;

    // NOT WHILE THE VESSEL IS BEING FLOWN. A skip is a rigid-body event - it
    // reflects the normal component of the velocity and kicks the nose up - and
    // under direct control the velocity filter would erase both inside 0.25 s,
    // leaving a hop the pilot did not command and cannot correct. That is exactly
    // the class of "weird movement" this control model exists to remove. An
    // unpiloted hull dropped or thrown at the sea still skips.
    const canSkip = !this.piloted && gamma < VESSEL.SKIP_ANGLE &&
      speed > VESSEL.SKIP_MIN_SPEED && vn < 0 && this.skipCount < 5;
    if (canSkip) {
      const deg = gamma * (180 / PI);
      const en = clamp(0.62 - 0.020 * deg, 0.20, 0.62);
      const et = clamp(0.88 - 0.006 * deg, 0.60, 0.88);
      // Split into normal and tangential, bounce the normal, retain the rest.
      vec3.scale(_v, nrm, vn);
      vec3.sub(_v2, this.velocity, _v);              // tangential
      vec3.scale(_v, nrm, -vn * en);                 // reflected normal
      vec3.scaleAndAdd(this.velocity, _v, _v2, et);
      // Nose-up kick: the water pushes on the belly, ahead of the CoM.
      vec3.scaleAndAdd(this.angularVelocity, this.angularVelocity, _right, 0.55);
      // Lift clear so the same crossing cannot fire twice.
      this.position[1] += 0.35;
      this.skipCount++;
      this._skipCooldown = 3.0;
      this.inWater = false;
      this.damageHull(0.09 * Math.hypot(this.velocity[0], this.velocity[2]), 'skip');
      events.emit(EVENTS.VESSEL_SKIP, { speed, position: this.position });
      return;
    }

    this.entryTimer = 0;
    events.emit(EVENTS.VESSEL_ENTER_WATER, {
      speed: -vn, position: this.position, angle: gamma,
    });
    // Slam damage past the gannet-speed threshold.
    // Slam damage above the speed the hull is RATED to enter at, which is its own
    // submerged design speed - a vessel certified for 38 m/s underwater does not
    // break by arriving there at 38 m/s. This threshold used to be a hard-coded
    // 18 m/s, set when MAX_SUBSPEED was 21: an ordinary dive at the design speed
    // now cost 34% of the hull, and a fast entry destroyed it outright, which made
    // "fly it into the sea" - the single most obvious thing to do with a flying
    // submarine - a way to lose the vessel.
    if (-vn > VESSEL.MAX_SUBSPEED) {
      this.damageHull(0.42 * (-vn - VESSEL.MAX_SUBSPEED) ** 1.45, 'slam');
    }
  }

  /**
   * Von Karman water-entry slam. A decaying impact coefficient over a wetted
   * area that ramps in, applied at the lowest point of the hull - which is
   * ahead of the CoM on a nose-down entry and therefore pitches the nose up.
   * That moment is real, and it is why a badly flown entry tumbles.
   */
  _applyEntrySlam(force, torque) {
    const t = this.entryTimer;
    if (t > VESSEL.TRANSITION_TIME) return;

    const nrm = this.surfaceSample.normal;
    const vn = vec3.dot(this.velocity, nrm);
    if (vn >= 0) return;

    // Alignment: a nose-first entry cuts, a belly-flop slams.
    vec3.negate(_v, _fwd);
    vec3.normalize(_v2, this.velocity);
    const align = vec3.dot(_v, _v2);
    const csScale = lerp(1.65, 0.42, smoothstep(0.42, 0.94, align));

    const cs = (1 + (VESSEL.ENTRY_DRAG_SPIKE - 1) * Math.exp(-t / 0.085)) * csScale;
    const aWet = VESSEL.AIR_REFERENCE_AREA[1] * 0.32 * smoothstep(0, 0.180, t);
    const mag = 0.5 * RHO_WATER * cs * aWet * vn * Math.abs(vn);

    vec3.scale(_v, nrm, -mag);
    vec3.add(force, force, _v);

    // Applied at the lowest hull point, not the CoM.
    vec3.scale(_v2, _up, -this._hullHalfHeight);
    vec3.cross(_f2, _v2, _v);
    vec3.add(torque, torque, _f2);
  }

  // -------------------------------------------------------------------------
  // The mixer
  // -------------------------------------------------------------------------

  /**
   * Cascaded attitude -> rate -> torque control, then a thrust allocation that
   * turns the demanded wrench into four throttle and tilt commands.
   *
   * NOT ON THE PILOTED PATH. _directControl handles a flown vessel and returns
   * before any of this runs; everything from here to _applyHydro exists for the
   * unpiloted rigid body and for the offline physics suites that fly it directly.
   * It is kept, and kept correct, because a parked vessel is still a 4.5 tonne
   * object sitting in a fluid, and because it is the model any future autopilot
   * (a return-to-base beacon, a towed vessel) would have to be built on.
   */
  /**
   * How much the WORLD HORIZON is worth as a roll reference for the current aim:
   * 1 while the nose is anywhere near level, 0 once it is inside ~10 degrees of
   * vertical.
   *
   * Scheduled on the pilot's aim, and deliberately NOT on the hull. A hull that
   * has tumbled to vertical while the aim is level must still receive a full
   * levelling command - that is what rights an inverted vessel - so the hull must
   * not appear here. It reads `aimPitch` rather than the flight-path-biased
   * `pitchTarget` for the same reason in miniature: the AoA bias is the
   * controller's business, not the pilot's, and letting it move the schedule
   * would make the fade depend on airspeed.
   *
   * @returns {number} 0..1
   */
  _levelness() {
    // Floored, never zero. Retiring the horizon COMPLETELY leaves the roll axis
    // with no reference at all, and "no reference" is not the same as "no roll":
    // measured, a near-vertical diving turn left the hull banked 69 degrees three
    // seconds after the pilot let go, and nothing was ever going to take it out,
    // because the target was tracking whatever roll the hull happened to have. A
    // small residual authority levels it eventually without ever demanding a roll
    // rate that matters - at the pitch limit the induced demand is 0.16 rad/s
    // against a 1.222 ceiling.
    return LEVEL_FADE_FLOOR + (1 - LEVEL_FADE_FLOOR)
      * (1 - smoothstep(LEVEL_FADE_LO, LEVEL_FADE_HI, Math.abs(Math.sin(this.aimPitch))));
  }

  /**
   * Build the attitude the controller flies to from the aim.
   *
   * The hull is held WINGS-LEVEL. There is no coordinated-turn bank: a playtest
   * asked for "no lateral rolls, barrel rolls or other", and a bank derived from
   * the pilot's own aim rate was both the last remaining source of commanded roll
   * and a frame-rate-dependent one (input.look() drains the mouse accumulator
   * while the fixed step runs 0, 1 or 2 times per frame, so a one-step derivative
   * of the aim chopped between twice nominal and zero, and it passed through
   * atan2 and a 60 degree clamp BEFORE any filter could see it). Flat turns are
   * the accepted trade. If bank is ever wanted back it belongs on the roll
   * reference below, not on a raw input derivative.
   */
  _updateAttitudeTarget(dt) {
    // Flight-path command. See FPA_GAIN: the aim names where the vessel GOES, and
    // the attitude target is offset by whatever incidence gets it there.
    const spd = vec3.len(this.velocity);
    const fpaAuthority = smoothstep(FPA_SPEED_LO, FPA_SPEED_HI, spd);
    let pitchTarget = this.aimPitch;
    if (fpaAuthority > 1e-3) {
      const fpa = Math.asin(clamp(this.velocity[1] / Math.max(spd, 1e-3), -1, 1));
      const aoa = clamp(FPA_GAIN * wrapAngle(this.aimPitch - fpa), -AOA_LIMIT, AOA_LIMIT);
      pitchTarget += aoa * fpaAuthority;
    }
    // Still bounded by the aim's own envelope plus the incidence allowance, so a
    // flight-path chase can never command an attitude the airframe should not hold.
    pitchTarget = clamp(pitchTarget, -AIM_PITCH_LIMIT - AOA_LIMIT,
      AIM_PITCH_LIMIT + AOA_LIMIT);
    // ---- roll reference -------------------------------------------------
    // Wings-level means level WITH RESPECT TO SOMETHING, and near vertical there
    // is nothing to be level with: the horizon subtends a cone the nose is
    // sitting inside, so an arbitrarily small change of heading is an
    // arbitrarily large change of commanded roll. That is the geometry behind
    // the barrel roll a playtest reported. Above LEVEL_FADE_HI
    // the target therefore references the HULL'S OWN up instead - the roll
    // channel simply holds what it has and the rate loop damps it - and between
    // the two it blends.
    //
    // With the aim level `levelness` is exactly 1 and `twist` contributes
    // nothing, so the target is bit-identical to the plain fromEuler this
    // replaced. That is what keeps hands-off inversion recovery working.
    const levelness = this._levelness();
    if (levelness < 0.999) {
      const cp = Math.cos(pitchTarget);
      vec3.set(this._aimDir, Math.sin(this.aimYaw) * cp, Math.sin(pitchTarget),
        -Math.cos(this.aimYaw) * cp);
      quat.up(this._rollUpHull, this.orientation);
      vec3.projectOnPlane(this._rollUpHull, this._rollUpHull, this._aimDir);
      vec3.projectOnPlane(this._rollUpWorld, VEC3_UP, this._aimDir);
      const lh = vec3.len(this._rollUpHull), lw = vec3.len(this._rollUpWorld);
      if (lh > ROLL_REF_MIN && lw > ROLL_REF_MIN) {
        vec3.scale(this._rollUpHull, this._rollUpHull, 1 / lh);
        vec3.scale(this._rollUpWorld, this._rollUpWorld, 1 / lw);
        // Signed angle from the level reference to the hull's own up, about the
        // commanded nose.
        vec3.cross(this._rollCross, this._rollUpWorld, this._rollUpHull);
        this._rollTwist = Math.atan2(vec3.dot(this._rollCross, this._aimDir),
          vec3.dot(this._rollUpWorld, this._rollUpHull));
      } else {
        // The hull's up is parallel to the commanded nose, so no twist between
        // them is defined. Bleed the last good value rather than STEP the roll
        // command, which would be a torque spike on a degenerate geometry.
        this._rollTwist = damp(this._rollTwist, 0, ROLL_REF_DECAY, dt);
      }
    } else {
      this._rollTwist = 0;
    }
    // fromEuler applies its roll argument LAST, i.e. intrinsically about body +Z,
    // which is -forward. Rotating the up-reference about +aimDir by theta is
    // therefore the roll argument -theta: to place the reference at the hull's own
    // up we pass the negated twist. Euler roll is POSITIVE when starboard rises;
    // this project has already shipped one inverted-sign look bug, so the test for
    // this asserts DIRECTION and not just magnitude.
    quat.fromEuler(this.attitudeTarget, this.aimYaw, pitchTarget,
      -(1 - levelness) * this._rollTwist);
  }

  _mix(dt, mass) {
    const c = this.ctrl;
    const bc = this.betaControl;
    const n = VESSEL.NACELLE_COUNT;

    // Body-frame angular velocity.
    quat.conjugate(_q, this.orientation);
    vec3.transformQuat(this._rate, this.angularVelocity, _q);
    const rate = this._rate;   // [pitch about X, yaw about Y, roll about Z]

    this._updateAttitudeTarget(dt);

    // ---- attitude loop: shortest-arc quaternion error --------------------
    //
    // The error is taken as a QUATERNION, not as an Euler decomposition. The
    // Euler version this replaces read `quat.toEuler`'s pitch and roll and drove
    // body-axis rates from them, which fails in two ways that both showed up in
    // flight: toEuler folds roll into yaw and returns roll = 0 within a quarter
    // of a degree of vertical pitch, so the roll channel commanded FULL SCALE
    // from a fabricated zero; and at high bank a body-X rate no longer changes
    // Euler pitch at all, so the pitch channel silently cross-coupled into yaw.
    //
    // The shortest-arc negation below is what makes an inverted hull RECOVER
    // rather than fight: without it the error can describe the long way round,
    // and the controller happily drives a 350 degree rotation.
    quat.multiply(this._qErr, this.attitudeTarget, _q);   // _q is conj(orientation)
    const qe = this._qErr;
    if (qe[3] < 0) { qe[0] = -qe[0]; qe[1] = -qe[1]; qe[2] = -qe[2]; qe[3] = -qe[3]; }
    const sinHalf = Math.hypot(qe[0], qe[1], qe[2]);
    const angle = 2 * Math.atan2(sinHalf, qe[3]);
    if (sinHalf > 1e-6) {
      const s = angle / sinHalf;
      vec3.set(this._attErr, qe[0] * s, qe[1] * s, qe[2] * s);
      // The error is a WORLD-frame rotation vector; the rate command is a
      // body-frame one, so it has to be rotated in.
      vec3.transformQuat(this._attErr, this._attErr, _q);
    } else {
      vec3.zero(this._attErr);
    }

    // Scaling the demand by the authority the allocator actually had last step is
    // the cheapest possible windup prevention: with no integrators left, the only
    // way this cascade can misbehave under saturation is by asking for a rate the
    // ducts cannot produce and then over-correcting when they can again. A parked
    // vessel has no thrust to vector and therefore, quite correctly, almost no
    // attitude authority - a submarine with the motors off cannot manoeuvre.
    const auth = Math.sqrt(saturate(this.controlAuthority));
    const rateCmd = this._rateCmd;
    const trim = this._attTrim;
    for (let a = 0; a < 3; a++) {
      const kp = lerp(KP_ATT_AIR[a], KP_ATT_WATER[a], bc);
      const rm = lerp(RATE_MAX_AIR[a], RATE_MAX_WATER[a], bc);
      // Trim integrates the ANGLE, and only while the allocator is not saturated -
      // integrating against an actuator that has already run out of travel is the
      // definition of windup.
      //
      // AND ONLY WHILE THE VESSEL IS ACTUALLY HOLDING, not while it is slewing.
      // Trim exists to cancel a steady DISTURBANCE. During a slew the error is
      // large and one-signed for as long as the pilot keeps moving the aim, which
      // is not a disturbance - it is the command - so integrating it is windup on
      // the tracking error, and the integral then has to be paid back on the far
      // side. Measured at hover once the thrusters gave yaw real authority: a 60
      // degree flick wound trim to -0.25 rad/s during the sweep and then overshot
      // to +24.6 degrees and rang for fifteen seconds, on an axis with no
      // hydrostatic stiffness to damp it. Gated to a few degrees of error it
      // cannot wind up at all, and outside the band it bleeds out rather than
      // being dropped, so re-entering the band does not step the command.
      if (!this.mixerSaturated && Math.abs(this._attErr[a]) < TRIM_BAND) {
        trim[a] = clamp(trim[a] + this._attErr[a] * KI_ATT * dt,
          -rm * TRIM_AUTHORITY, rm * TRIM_AUTHORITY);
      } else {
        trim[a] = damp(trim[a], 0, TRIM_BLEED, dt);
      }
      rateCmd[a] = clamp(kp * this._attErr[a] + trim[a], -rm, rm) * auth;
    }

    // ---- rate loop ------------------------------------------------------
    // Proportional only. See KP_ATT_AIR for why there is no integrator and why
    // these gains are set from the actuator pole rather than by feel.
    const spdSq = vec3.sqrLen(this.velocity);
    for (let a = 0; a < 3; a++) {
      const kp = lerp(KP_RATE_AIR[a], KP_RATE_WATER[a], bc);
      let alpha = kp * (rateCmd[a] - rate[a]);
      alpha = clamp(alpha, -MAX_ANGULAR_ACCEL, MAX_ANGULAR_ACCEL);
      // Torque = effective inertia * angular acceleration. This is a
      // FEED-FORWARD INVERSION of the plant, so it must use the same effective
      // inertia the integrator will divide by - which is built from the true
      // `beta`, not from the lagged `betaControl`. Using the lagged value here
      // made the closed-loop gain wrong by up to 1.94x (yaw) for the 0.35 s the
      // lag takes to catch up, on every single waterline crossing - and at the
      // surface `beta` oscillates continuously with the waves, so the loop gain
      // oscillated with them. `betaControl` schedules the GAINS above, which is
      // what a lag is for; it must not appear in a plant inversion.
      const ieff = this.inertia[a] + this.beta * VESSEL.ADDED_MASS[a] * VESSEL.INERTIA[a];
      this.commandedTorque[a] = alpha * ieff;
      // Stiffness-matched attitude-to-torque path, on the two axes the fins act on.
      // See KP_FIN_TORQUE. Zero in air, where beta is zero and the rate cascade
      // already suffices.
      //
      // CLAMPED TO WHAT THE FINS CAN ACTUALLY PRODUCE, which is the part that matters.
      // Unbounded, a sustained turn - where the attitude error never closes, because
      // the aim keeps moving - drove the commanded yaw torque to 6 MN.m against a
      // rudder good for 1.4, and the allocator saturated so hard that control
      // authority on EVERY axis fell to 0.17. The vessel then wandered in roll and
      // pitch, could not hold its flight path, climbed to the surface and capsized in
      // the chop. Those look like four bugs and are one: never command a torque no
      // effector can deliver, because the cost is not just that axis, it is the joint
      // saturation scalar dragging every other axis down with it.
      //
      // Both axes need the term, and for the same reason: turning needs about 5 deg of
      // HELD SIDESLIP to generate the side force that curves the path, which costs
      // 366 kN.m against the fin stiffness, and the rate cascade can only ever command
      // 234. Dropping it from yaw does not tame the turn, it stops the vessel turning
      // at all - measured, the yaw rate decayed to zero with the mouse still sweeping.
      if (a < 2) {
        const finAuthority = HYDRO_FIN[a] * this.beta * spdSq * FIN_DEFLECT_MAX;
        this.commandedTorque[a] += clamp(
          KP_FIN_TORQUE * HYDRO_FIN[a] * this.beta * spdSq * this._attErr[a],
          -finAuthority * FIN_TORQUE_FRAC, finAuthority * FIN_TORQUE_FRAC);
      }
    }

    // ---- hydrostatic righting moment, fed forward on PITCH ----------------
    // COB_OFFSET puts the centre of buoyancy 0.55 m above the CoM, which is a
    // pendulum: at neutral buoyancy it is 43.6 kN * 0.55 m * sin(angle), so 23.9
    // kN.m at 85 degrees, and it opposes any nose-up or nose-down attitude the
    // pilot asks the vessel to HOLD at hover. That is a steady, known, computable
    // disturbance, so it belongs in a plant inversion and not in an integrator -
    // this codebase already inverts the effective mass, the effective inertia and
    // the thrust lapse for exactly the same reason. Discovering it with trim
    // instead needed trim to wind up to the full pendulum, which meant trim could
    // not be gated, which meant it also wound up on the tracking error during a
    // slew: measured, a 60 degree flick overshot to 24.6 degrees and rang for
    // fifteen seconds. Fed forward, the proportional loop holds the attitude and
    // trim is left doing the job it is for.
    //
    // PITCH ONLY. In ROLL the pendulum is the vessel's passive self-righting, it
    // is what a hovering hull has instead of a roll effector, and the requirement
    // is zero roll - so it is left alone to do its work. Yaw has no pendulum: the
    // buoyant force is vertical, so its moment about the vertical axis is zero.
    //
    // Scaled by the same fade as the thrusters, because they are the effector
    // that pays for it; with dynamic pressure up the fins absorb it instead.
    const mFade = this._maneuverFade(Math.sqrt(spdSq));
    if (mFade > 1e-3 && this.submergedVolume > 0) {
      vec3.sub(_v, this.centreOfBuoyancy, this.position);
      vec3.set(_v2, 0, RHO_WATER * G * this.submergedVolume, 0);
      vec3.cross(_v, _v, _v2);            // world-frame righting moment
      vec3.transformQuat(_v, _v, _q);     // _q is conj(orientation)
      this.commandedTorque[0] -= clamp(_v[0] * mFade,
        -MANEUVER_TORQUE[0], MANEUVER_TORQUE[0]);
    }

    // ---- vertical channel ------------------------------------------------
    // DESIGN/04.2.7: with the vertical trim centred the vessel holds ALTITUDE
    // (or DEPTH once submerged). Both are held against a POSITION reference,
    // never against vertical speed: an integrator fed vertical speed has no
    // position term at all, so the smallest bias in the thrust model walks a
    // parked vessel off its pad and never brings it back.
    //
    // The hold engages only while STATION-KEEPING - no vertical trim AND no
    // translation demand. That condition is what makes point-and-go work: aim
    // down, press W, and the vessel dives, because a depth hold that stayed
    // engaged under thrust would spend the whole descent fighting it. Let go and
    // it parks at the depth it reached, which is the behaviour that makes the
    // craft feel moored rather than sinking.
    const stationKeeping = this.stationKeeping && c.collective === 0 &&
      Math.abs(c.translate) < 0.01 && Math.abs(c.lateral) < 0.01;
    // ONE law, referenced to world y, in both media. There used to be three
    // branches - an altitude hold in y, a depth hold in depth (which is -y, so it
    // needed its output negated), and a "straddling the waterline" branch that
    // latched nothing and merely bled the vertical rate. The two references were
    // an invitation to a sign error, and the dead band between beta 0.4 and 0.6
    // meant a vessel parked exactly at the surface never held anything at all.
    // Depth and altitude are the same quantity measured from opposite ends.
    let azCmd = c.collective * AZ_CMD_MAX;
    if (this.unpiloted || !stationKeeping) {
      // Nobody aboard, or the pilot is driving. See simulateUnpiloted().
      this.holdY = null;
      if (this.unpiloted) azCmd = 0;
    } else {
      if (this.holdY == null) {
        // Lead the capture by half a second of the current drift, so engaging the
        // hold while moving does not yank the vessel back (DESIGN/12.8.6).
        this.holdY = this.position[1] + this.velocity[1] * 0.45;
        this.holdPid.reset();
      }
      // The PID's own derivative term is worth only 0.35 of damping against a 0.9
      // stiffness, which is badly underdamped; the explicit rate term brings the
      // loop to zeta ~= 0.84.
      azCmd = this.holdPid.update(clamp(this.holdY - this.position[1], -20, 20), dt) -
        this.velocity[1] * HOLD_RATE_GAIN;
    }
    // Climb/descent-rate envelope protection.
    const vy = this.velocity[1];
    azCmd = Math.min(azCmd, CLIMB_GAIN * (VESSEL.MAX_CLIMB_RATE - vy));
    azCmd = Math.max(azCmd, CLIMB_GAIN * (-VESSEL.MAX_CLIMB_RATE - vy));

    // Vertical force the thrusters must produce: whatever gravity and buoyancy do
    // not already cancel. The demanded acceleration is added below, against the
    // effective mass rather than the dry one.
    const buoyancy = RHO_WATER * G * this.submergedVolume;
    const residualY = mass * G - buoyancy;

    // ---- longitudinal / lateral channels ---------------------------------
    // _q still holds conj(orientation) from the attitude loop above.
    vec3.transformQuat(_v2, this.velocity, _q);
    const vBody = _v2;                                  // body-frame velocity
    const forwardSpeed = -vBody[2];
    const lateralSpeed = vBody[0];
    // A CENTRED THROTTLE COMMANDS A STOP, not zero acceleration.
    //
    // This is the same law the vertical channel already uses - centred trim holds a
    // depth rather than holding a rate of descent - and for the same reason: on a
    // vectored-thrust vehicle the natural meaning of "no input" is "stay put".
    //
    // It used to command zero ACCELERATION, and combined with the drag compensation
    // below that made the flight computer a cruise control: with the stick centred it
    // commanded exactly enough thrust to cancel drag and held whatever speed it had.
    // Measured, releasing the throttle from full and waiting a full minute left the
    // vessel still doing 30.1 of 37.8 m/s submerged and 118.9 of 120 m/s in air. It
    // effectively never stopped.
    // SURGE ONLY. The lateral axis deliberately just coasts on its drag, which is
    // 3-6x the surge axis' and arrests a strafe on its own. Braking it too looks like
    // symmetry and is not: a hard turn carries real sideslip, so a lateral
    // velocity-hold spends the turn fighting the fins for it. Measured, adding it put
    // the vessel at 88 degrees of roll and drove it to the surface mid-turn.
    let axCmd = Math.abs(c.translate) > 0.01
      ? c.translate * AX_CMD_MAX
      : clamp(-forwardSpeed * BRAKE_GAIN, -AX_CMD_MAX, AX_CMD_MAX);
    let ayCmd = c.lateral * AY_CMD_MAX;
    // Vne, with the flight computer SLOWING DOWN FOR THE WATER.
    //
    // Hitting the sea at 120 m/s is unsurvivable: the hydrodynamic drag on entry is
    // over 4 MN, the solver clamps the acceleration and converts the clipped energy
    // into hull damage, and the slam term alone is several hundred per cent of the
    // hull. Without this the single most obvious thing a player can do with a
    // flying submarine - dive it into the sea - destroys it, so the vessel is
    // decelerated to its submerged limit on the approach. A real fly-by-wire
    // aircraft protects its own envelope exactly like this.
    let vMax = this._ctxWet ? VESSEL.MAX_SUBSPEED : VESSEL.MAX_AIRSPEED;
    if (!this._ctxWet && this.velocity[1] < -0.1) {
      const toSurface = (this.position[1] - this.waterSurfaceY) / -this.velocity[1];
      vMax = lerp(VESSEL.MAX_SUBSPEED, vMax,
        smoothstep(SURFACE_SLOW_LEAD_MIN, SURFACE_SLOW_LEAD_MAX, toSurface));
    }
    // Vne protection: as the airspeed approaches the limit the commanded
    // forward acceleration is driven to zero and then negative, which tilts
    // the nacelles back. This is what actually holds the vessel at Vne.
    axCmd = Math.min(axCmd, VNE_GAIN * (vMax - forwardSpeed));
    axCmd = Math.max(axCmd, VNE_GAIN * (-vMax * 0.5 - forwardSpeed));
    ayCmd = clamp(ayCmd, VNE_GAIN * (-vMax * 0.3 - lateralSpeed), VNE_GAIN * (vMax * 0.3 - lateralSpeed));

    // ---- allocation ------------------------------------------------------
    // Assemble the demanded force as ONE BODY-FRAME VECTOR, then point the ducts
    // at it. The previous form kept the vertical channel in the world frame and
    // divided it by `max(up.y, 0.35)` to account for bank. That divisor is wrong
    // in two ways that both mattered: at the 85 degrees of pitch this control
    // scheme now allows, up.y is 0.087 and the floor under-delivers lift by 4x;
    // and it has no branch at all for an INVERTED hull, where up.y is negative
    // and "up" thrust along body +Y points at the seabed - so an upside-down
    // vessel was actively driven downward with no recovery law anywhere.
    //
    // In the body frame there is no special case. A demand the ducts cannot
    // point at simply projects short, and an inverted hull produces a NEGATIVE
    // projection, so the throttle goes to zero and buoyancy plus the attitude
    // loop right the vessel - which is what should always have happened.
    const rho = lerp(airDensity(this.position[1]), RHO_WATER, this.beta);
    const dragFwd = 0.5 * rho * this._surgeDragArea() * forwardSpeed * Math.abs(forwardSpeed);
    // Force = EFFECTIVE mass * commanded acceleration, and submerged the
    // effective mass includes the entrained water. Sizing these against the dry
    // mass, which is what this replaces, delivered only 0.88 of the commanded
    // surge, 0.55 of the heave and 0.72 of the sway underwater - the vertical
    // channel and the depth hold were running at a little over half strength and
    // nothing in the code said so. `beta`, not `betaControl`: this is physics.
    const b = this.beta;
    const mSway = mass + b * VESSEL.ADDED_MASS[0] * VESSEL.MASS;
    const mHeave = mass + b * VESSEL.ADDED_MASS[1] * VESSEL.MASS;
    const mSurge = mass + b * VESSEL.ADDED_MASS[2] * VESSEL.MASS;
    // Drag compensation is scaled by the THROTTLE, so it fades out as the stick
    // returns to centre. Compensating unconditionally is what turned a centred stick
    // into a cruise control; compensating not at all would make the throttle a force
    // command whose achieved acceleration tapers off as speed builds. Scaled, it is
    // an acceleration command while you are driving and nothing at all when you are
    // not - and on an analog throttle a partial setting settles at a partial cruise
    // speed, which is what an analog throttle should do.
    const fSurge = mSurge * axCmd + dragFwd * Math.min(1, Math.abs(c.translate));
    // The world-frame vertical demand, rotated into the body frame.
    vec3.set(_v, 0, residualY + mHeave * azCmd, 0);
    vec3.transformQuat(_v, _v, _q);
    // Plus the body-frame translation demands. Body -Z is forward.
    const fx = _v[0] + mSway * ayCmd;
    const fy = _v[1];
    const fz = _v[2] - fSurge;
    const fLen = Math.hypot(fx, fy, fz);

    // Thrust axis d(theta,phi) = Rz(phi)*Rx(theta)*(0,1,0)
    //                          = (-cos(t)sin(p), cos(t)cos(p), sin(t)).
    // Inverting that for the direction of the demand: the z component is sin(t)
    // outright, and the remaining two give phi directly. No atan2 on a quantity
    // that is zero by definition at neutral buoyancy, which is what made the old
    // schedule flip from 0 to -pi where a submersible spends its whole life.
    let tiltSched = 0;
    let yawSched = 0;
    if (fLen > 1e-3) {
      // TILT_SCHED_*, not the physical range: the schedule stops at vertical so
      // cos(theta) can never go negative and invert the control signs, while the
      // physical range keeps room past it for differential tilt to work in.
      tiltSched = clamp(Math.asin(clamp(fz / fLen, -1, 1)),
        TILT_SCHED_MIN, TILT_SCHED_MAX);
      // FADED OUT WHEN THERE IS NO LATERAL DEMAND TO POINT AT, which is most of
      // submerged life. Both fx and fy are `residualY` times a hull axis, and at
      // neutral buoyancy residualY dithers about zero - so its SIGN flips this
      // atan2 by exactly pi, which then clamps to the OPPOSITE NACELLE_YAW_RANGE
      // rail. The fLen guard cannot catch it because fLen is dominated by the
      // surge demand fz. The cost is not cosmetic: dTheta, the differential-TILT
      // column and the primary submerged pitch and roll effector, rotates by 24
      // degrees with the flip, and the physical nacelles then take 0.4 s to slew
      // there while _applyThrust uses the angle they are actually at and the
      // allocator solved for the one it commanded.
      //
      // Scaled against the vessel's own WEIGHT because that is a stable reference
      // that exists at every trim; a smooth fade rather than a deadband, because a
      // deadband would only trade one discontinuity for another.
      const weight = mass * G;
      yawSched = clamp(Math.atan2(-fx, fy),
        VESSEL.NACELLE_YAW_RANGE[0], VESSEL.NACELLE_YAW_RANGE[1])
        * smoothstep(YAW_SCHED_LO * weight, YAW_SCHED_HI * weight, Math.hypot(fx, fy));
    }

    const ct = Math.cos(tiltSched), st = Math.sin(tiltSched);
    const cp = Math.cos(yawSched), sp = Math.sin(yawSched);

    // Thrust ACTUALLY AVAILABLE per nacelle at this speed, not the static figure.
    //
    // The ducts are constant-shaft-power (thrustLapse), so a duct rated at 46 kN
    // static delivers about 32 kN at 120 m/s. Sizing the throttle against the
    // static number - which is what this did - asks for 100% and gets 69%, and the
    // shortfall lands wherever the demand happened to be pointing. It showed up as
    // the vessel being unable to climb at full power near Vne, with nothing about
    // the symptom pointing at the mixer. Same class of error as using the dry mass
    // in a force demand: a plant inversion has to invert the real plant.
    const tStatic = this._maxThrustPerNacelle();
    vec3.set(_v, -ct * sp, ct * cp, st);
    vec3.transformQuat(_v, _v, this.orientation);
    const tMax = Math.max(1, tStatic * thrustLapse(tStatic, rho, vec3.dot(this.velocity, _v)));

    // Size the throttle by PROJECTING the demand onto the axis the ducts can
    // actually reach, not by its magnitude. Once the actuator range bites - a
    // pure strafe would need 90 degrees of yaw vectoring and only 24 are
    // available - the axis no longer points at the demand, and asking for the
    // full magnitude would spend the shortfall as thrust in a direction nobody
    // asked for. DESIGN/04.2.7's saturation priority puts translation last,
    // which is exactly what a projection does.
    const demand = fx * (-ct * sp) + fy * (ct * cp) + fz * st;
    const base = clamp(demand / (n * tMax), 0, 1);
    this._allocate(n, tMax, base, tiltSched, yawSched);
  }

  /**
   * Turn a collective throttle plus the commanded body torque into four nacelle
   * throttle, tilt and yaw demands.
   *
   * WHY THIS SOLVES A JACOBIAN INSTEAD OF HARD-CODING WHICH EFFECTOR DOES WHAT
   * --------------------------------------------------------------------------
   * The obvious mixer - and the one this replaces - says "pitch is differential
   * fore/aft thrust, roll is differential port/starboard". That is true only
   * while the ducts point straight up. The thrust axis is
   * d(theta,phi) = (-cos(t)sin(p), cos(t)cos(p), sin(t)), so the moment is
   * r_i x (T_i * d), and as theta rotates toward -90 degrees the roles ROTATE
   * with it:
   *
   *                                theta = 0        theta = -90 deg
   *   diff fore/aft throttle       pitch (7.10 m)   almost nothing
   *   diff port/stbd throttle      roll  (7.14 m)   YAW   (7.14 m)
   *   diff fore/aft tilt           almost nothing   PITCH (7.10 m)
   *   diff port/stbd tilt          -                ROLL  (7.14 m)
   *   diff yaw couple              yaw   (7.10 m)   zero (scales with cos t)
   *
   * The old mixer assumed the left column always held, so at full tilt it asked
   * differential fore/aft thrust for a pitch moment it could not produce, and
   * asked differential port/starboard for roll while actually getting yaw. And
   * full tilt is not an exotic corner: underwater at neutral buoyancy the
   * vertical demand is zero by definition, so ANY forward demand drove the
   * schedule straight to -90 degrees. Pressing W underwater was sufficient. The
   * rate loops then wound up against an axis with no authority, and because the
   * old NACELLE_PITCH_RANGE allowed -110 degrees the vessel could tilt PAST
   * vertical, where cos(theta) changes sign and the pitch and roll channels
   * invert outright - positive feedback, and the reported flip onto its back.
   *
   * Computing what each effector actually does at the CURRENT angles removes the
   * assumption entirely. At every angle in the range at least three strong,
   * independent effectors exist (see the table), so authority never collapses
   * and never inverts. tools/test-vessel-control.mjs asserts exactly that across
   * the whole sweep.
   *
   * Moments still come out of r x F in _applyThrust - no abstract torque is ever
   * injected into the rigid body, which is the property that makes the vessel
   * rock and settle on a reef instead of behaving like a puppet.
   */
  _allocate(n, tMax, base, tiltCmd, yawCmd) {
    const B = this._allocB;      // 3x5, column-major: B[col*3 + row]
    const u = this._allocU;
    // Dedicated scratch. The module-level temporaries are shared across the whole
    // force pipeline and aliasing one of them here would be invisible until the
    // vessel misbehaved in a way nothing pointed at the mixer.
    const d = this._allocD, dTheta = this._allocDTheta, dPhi = this._allocDPhi;
    const m = this._allocCross;
    const ct = Math.cos(tiltCmd), st = Math.sin(tiltCmd);
    const cp = Math.cos(yawCmd), sp = Math.sin(yawCmd);

    // The three directions an effector can push along: the thrust axis itself,
    // and its derivatives with respect to tilt and to lateral vectoring.
    vec3.set(d, -ct * sp, ct * cp, st);
    vec3.set(dTheta, st * sp, -st * cp, ct);
    vec3.set(dPhi, -ct * cp, -ct * sp, 0);

    // Every effector is one of two sign patterns over the four nacelles, so the
    // sum over nacelles collapses to a single cross product against a precomputed
    // effective arm - see _armZ / _armX in the constructor.
    //
    // The angle columns are scaled by the MEAN achieved thrust rather than each
    // nacelle's own: with healthy nacelles they are identical, and the residual
    // error with a damaged one is a gain error the loop absorbs, not a sign error.
    let tBar = 0;
    for (let i = 0; i < n; i++) tBar += this.nacelleThrottle[i];
    tBar = (tBar / n) * tMax;
    // A parked vessel has no thrust to vector, so the angle effectors genuinely have
    // no authority - and the floor here must stay small enough to SAY so. It used to
    // be 5% of tMax, which is 22 kN of imaginary thrust: the solve came out
    // well-conditioned, the allocator reported controlAuthority = 1, and the physics
    // delivered nothing, so the attitude loop was open without anything reporting it.
    // The Tikhonov term in solveLeastNorm handles the conditioning; this only needs to
    // keep the column from being exactly zero.
    const tAng = Math.max(tBar, 0.002 * tMax) * ANG_REF;

    // ---- headroom weighting ---------------------------------------------
    // Each column is SCALED BY THE TRAVEL THAT EFFECTOR ACTUALLY HAS LEFT, and
    // the solve then works in units of "fraction of available travel". This is
    // what makes the allocation prefer the effector that can deliver instead of
    // merely the one with the largest gain.
    //
    // It matters enormously here, and only because the ducts are constant-power.
    // Submerged cruise needs about 10% throttle out of a possible 100%, so the
    // differential-throttle effectors have very little headroom while differential
    // TILT has plenty. An unweighted least-norm solve does not know that: it
    // splits the demand by gain, hands a quarter of it to an effector with a
    // twentieth of the travel, and then the joint scale below - which can only
    // scale everything together - drags the strong effectors down with the weak
    // one. Measured, that left 16% of the demanded pitch moment available against a
    // destabilising hull moment three times larger, and the vessel tumbled.
    const headThrottle = Math.max(Math.min(base, 1 - base) * 0.95, 1e-4);
    const headTilt = Math.max(Math.min(
      tiltCmd - VESSEL.NACELLE_PITCH_RANGE[0],
      VESSEL.NACELLE_PITCH_RANGE[1] - tiltCmd) / ANG_REF, 1e-4);
    const headYaw = Math.max(Math.min(
      yawCmd - VESSEL.NACELLE_YAW_RANGE[0],
      VESSEL.NACELLE_YAW_RANGE[1] - yawCmd) / ANG_REF, 1e-4);
    const h0 = headThrottle * tMax;
    const h1 = headThrottle * tMax;
    const h2 = headTilt * tAng;
    const h3 = headTilt * tAng;
    const h4 = headYaw * tAng;

    vec3.cross(m, this._armZ, d);      B[0] = m[0] * h0; B[1] = m[1] * h0; B[2] = m[2] * h0;
    vec3.cross(m, this._armX, d);      B[3] = m[0] * h1; B[4] = m[1] * h1; B[5] = m[2] * h1;
    vec3.cross(m, this._armZ, dTheta); B[6] = m[0] * h2; B[7] = m[1] * h2; B[8] = m[2] * h2;
    vec3.cross(m, this._armX, dTheta); B[9] = m[0] * h3; B[10] = m[1] * h3; B[11] = m[2] * h3;
    vec3.cross(m, this._armZ, dPhi);   B[12] = m[0] * h4; B[13] = m[1] * h4; B[14] = m[2] * h4;

    // Control surfaces: stern planes on pitch, rudder on yaw. Single-axis and
    // decoupled, and their gain carries the q that makes them the effector of
    // choice at speed and worthless at rest. See FIN_DEFLECT_MAX.
    //
    // NO HEADROOM WEIGHT ON THESE TWO COLUMNS, and that is a fix, not an omission.
    // Headroom weighting is only meaningful for an INCREMENTAL command: the
    // throttle and tilt effectors are added to a schedule, so what is left of
    // their travel really does depend on where the schedule already sits. The fin
    // commands below are ABSOLUTE - `finPitchCommand = k * u * FIN_DEFLECT_MAX`,
    // referenced to zero, not to the current deflection - so the deflection the
    // surface happens to be holding is not a constraint on the next command at
    // all.
    //
    // Weighting them anyway, with a TWO-SIDED headroom min(max - d, max + d),
    // closed a loop that was never meant to exist: at a steady deflection d the
    // weight is (max - |d|)/max, and the largest command it can then produce is
    // max - |d|, whose fixed point is exactly half travel. Measured, the rudder
    // self-limited at 10.50 of 20.05 degrees at EVERY speed - the airframe was
    // flying on half a rudder and nothing reported it, because a half-scale
    // effector still has the right sign and the right gain slope.
    const spd = vec3.len(this.velocity);
    const qFin = this.beta * spd * spd * FIN_DEFLECT_MAX;
    const h5 = qFin * HYDRO_FIN[0];
    const h6 = qFin * HYDRO_FIN[1];
    B[15] = h5; B[16] = 0; B[17] = 0;
    B[18] = 0; B[19] = h6; B[20] = 0;

    // ---- manoeuvring thrusters ------------------------------------------
    // Three tunnel thrusters, one per body axis, and they are what lets a
    // submersible turn on the spot. See MANEUVER_TORQUE: without them the vessel
    // measurably did not rotate AT ALL at hover - four co-tilted ducts have only
    // two attitude degrees of freedom at zero net thrust, and neither of them is
    // yaw. Single-axis, decoupled, each its own resource.
    const mFade = this._maneuverFade(spd);
    const h7 = MANEUVER_TORQUE[0] * mFade;
    const h8 = MANEUVER_TORQUE[1] * mFade;
    const h9 = MANEUVER_TORQUE[2] * mFade;
    B[21] = h7; B[22] = 0; B[23] = 0;
    B[24] = 0; B[25] = h8; B[26] = 0;
    B[27] = 0; B[28] = 0; B[29] = h9;

    // u is now in fractions of available travel, so the limit on each is 1.
    solveLeastNorm(B, this.commandedTorque, u, this._allocN, 10);

    // ---- joint saturation ------------------------------------------------
    // When the demand still exceeds what the actuators can deliver, scale ALL FIVE
    // effectors by ONE scalar. That keeps the delivered moment PARALLEL to the
    // demanded moment - it comes out weaker, but it still points where the
    // controller asked.
    //
    // Clamping each nacelle independently, which is what this replaces, does
    // something much worse than weaken the moment: it clips one duct to 0 and
    // another to 1, which is asymmetric, so it produces a net VERTICAL FORCE
    // impulse on every attitude correction and rotates the delivered moment away
    // from the demanded one. A control system whose output direction changes under
    // saturation is a control system that will limit-cycle.
    //
    // Grouped by SHARED RESOURCE: the two differential-throttle effectors both
    // spend throttle travel, and the two differential-tilt effectors both spend
    // tilt travel, so within a group the demands add.
    const needThrottle = Math.abs(u[0]) + Math.abs(u[1]);
    const needTilt = Math.abs(u[2]) + Math.abs(u[3]);
    const needYaw = Math.abs(u[4]);
    let k = 1;
    if (needThrottle > 1) k = Math.min(k, 1 / needThrottle);
    if (needTilt > 1) k = Math.min(k, 1 / needTilt);
    if (needYaw > 1) k = Math.min(k, 1 / needYaw);
    // The fins are their own resource, one axis each. So are the thrusters.
    if (Math.abs(u[5]) > 1) k = Math.min(k, 1 / Math.abs(u[5]));
    if (Math.abs(u[6]) > 1) k = Math.min(k, 1 / Math.abs(u[6]));
    for (let a = 0; a < 3; a++) {
      if (Math.abs(u[7 + a]) > 1) k = Math.min(k, 1 / Math.abs(u[7 + a]));
    }
    k = clamp(k, 0, 1);
    this.controlAuthority = k;
    this.mixerSaturated = k < 0.999;

    for (let i = 0; i < n; i++) {
      const sz = this._signZ[i];
      const sx = this._signX[i];

      let cmdT = base + k * headThrottle * (sz * u[0] + sx * u[1]);
      cmdT = clamp(cmdT, 0, 1);
      if (this.silentRunning) cmdT = Math.min(cmdT, SILENT_THROTTLE_CAP);
      this.nacelleCommand[i] = cmdT;

      this.nacelleTiltCommand[i] = clamp(
        tiltCmd + k * headTilt * (sz * u[2] + sx * u[3]) * ANG_REF,
        VESSEL.NACELLE_PITCH_RANGE[0], VESSEL.NACELLE_PITCH_RANGE[1]);
      this.nacelleYawCommand[i] = clamp(
        yawCmd + k * headYaw * sz * u[4] * ANG_REF,
        VESSEL.NACELLE_YAW_RANGE[0], VESSEL.NACELLE_YAW_RANGE[1]);
    }

    // Absolute, referenced to zero deflection. `u` is in fractions of full
    // travel, so this is dimensionally the same statement as B[15]/B[18] above -
    // which is what makes the delivered moment equal the solved one.
    this.finPitchCommand = clamp(k * u[5] * FIN_DEFLECT_MAX,
      -FIN_DEFLECT_MAX, FIN_DEFLECT_MAX);
    this.finYawCommand = clamp(k * u[6] * FIN_DEFLECT_MAX,
      -FIN_DEFLECT_MAX, FIN_DEFLECT_MAX);

    // Body-frame moment the thrusters are being asked for, in N.m. Stored rather
    // than applied here because _allocate runs inside the mixer and the force
    // pipeline has not started yet; _applyManeuver adds it.
    for (let a = 0; a < 3; a++) {
      this.maneuverTorque[a] = clamp(k * u[7 + a], -1, 1) * MANEUVER_TORQUE[a] * mFade;
    }
  }

  /**
   * How much of the manoeuvring thrusters is available right now: everything at
   * rest underwater, nothing in air, and nothing once the ducts and fins have
   * dynamic pressure to work with.
   *
   * @param {number} spd speed through the water, m/s
   * @returns {number} 0..1
   */
  _maneuverFade(spd) {
    return this.beta * (1 - smoothstep(MANEUVER_FADE_LO, MANEUVER_FADE_HI, spd));
  }

  /**
   * Manoeuvring thrusters: a pure couple, no net force.
   *
   * Tunnel thrusters are opposed pairs firing through the hull, so the forces
   * cancel exactly and only the moment survives. That is the point of them here -
   * a neutrally buoyant vessel holding station cannot afford an attitude input
   * that also shoves it sideways, which is precisely what makes the ducts useless
   * for the job (see MANEUVER_TORQUE).
   */
  _applyManeuver(force, torque) {
    if (this.maneuverTorque[0] === 0 && this.maneuverTorque[1] === 0
      && this.maneuverTorque[2] === 0) return;
    vec3.transformQuat(_v, this.maneuverTorque, this.orientation);
    vec3.add(torque, torque, _v);
  }

  /** Quadratic drag area on the surge axis for the current medium, m^2. */
  _surgeDragArea() {
    const air = VESSEL.AIR_DRAG_COEFF[2] * VESSEL.AIR_REFERENCE_AREA[2];
    return lerp(air, VESSEL.WATER_DRAG_COEFF[2], this.beta);
  }

  /**
   * Static thrust available from one nacelle right now: medium, aeration,
   * ground effect and health, before the momentum-theory speed lapse.
   *
   * The aeration notch is the most important feel element of the transition. A
   * duct that is half in air and half in water pumps almost nothing, so you
   * CANNOT hover half-submerged; the correct technique is ballast, and the
   * game teaches that in the first ten minutes.
   */
  _maxThrustPerNacelle() {
    const b = this.beta;
    const mediumMult = lerp(1.0, VESSEL.WATER_THRUST_EFFICIENCY, b);
    const aeration = 1.0 - 0.45 * (4.0 * b * (1.0 - b));
    let breach = 1;
    if (this.breachTimer < 0.30) {
      const k = saturate(this.breachTimer / 0.30);
      breach = 0.35 + 0.65 * k * k * (3 - 2 * k);
    }
    return VESSEL.THRUST_PER_NACELLE * mediumMult * aeration * breach;
  }

  /** Slew the actuators and spool the rotors toward their commands. */
  _updateActuators(dt) {
    const n = VESSEL.NACELLE_COUNT;
    const slew = VESSEL.NACELLE_SLEW_RATE * dt;
    const tau = lerp(SPOOL_TAU_AIR, SPOOL_TAU_WATER, this.beta);
    const k = 1 - Math.exp(-dt / tau);
    for (let i = 0; i < n; i++) {
      this.nacelleTilt[i] = clamp(
        moveTowards(this.nacelleTilt[i], this.nacelleTiltCommand[i], slew),
        VESSEL.NACELLE_PITCH_RANGE[0], VESSEL.NACELLE_PITCH_RANGE[1]);
      this.nacelleYaw[i] = clamp(
        moveTowards(this.nacelleYaw[i], this.nacelleYawCommand[i], slew),
        VESSEL.NACELLE_YAW_RANGE[0], VESSEL.NACELLE_YAW_RANGE[1]);
      this.nacelleThrottle[i] += (this.nacelleCommand[i] - this.nacelleThrottle[i]) * k;
      // Visual rotor rate: 2850 rpm in air, 276 rpm in water (cavitation).
      const rpm = lerp(2850, 276, this.beta) * this.nacelleThrottle[i];
      this.rotorPhase[i] = (this.rotorPhase[i] + (rpm / 60) * TAU * dt) % TAU;
    }
    const finSlew = FIN_SLEW_RATE * dt;
    this.finPitch = clamp(moveTowards(this.finPitch, this.finPitchCommand, finSlew),
      -FIN_DEFLECT_MAX, FIN_DEFLECT_MAX);
    this.finYaw = clamp(moveTowards(this.finYaw, this.finYawCommand, finSlew),
      -FIN_DEFLECT_MAX, FIN_DEFLECT_MAX);
  }

  // -------------------------------------------------------------------------
  // Forces
  // -------------------------------------------------------------------------

  _applyGravity(force, mass) {
    force[1] -= mass * G;
  }

  _applyBuoyancy(force, torque) {
    if (this.submergedVolume <= 0) return;
    const fb = RHO_WATER * G * this.submergedVolume;
    force[1] += fb;
    // Torque about the CoM from a force applied at the centre of buoyancy.
    vec3.sub(_v, this.centreOfBuoyancy, this.position);
    vec3.set(_v2, 0, fb, 0);
    vec3.cross(_f2, _v, _v2);
    vec3.add(torque, torque, _f2);
  }

  /**
   * Four vectored thrusters. Each produces a force along its own tilted axis
   * at its own mounting point, so pitch, roll and yaw moments all fall out of
   * the geometry rather than being injected as abstract torques.
   */
  _applyThrust(force, torque) {
    const n = VESSEL.NACELLE_COUNT;
    const tMax = this._maxThrustPerNacelle();
    const rho = lerp(airDensity(this.position[1]), RHO_WATER, this.beta);
    const ge = this._groundEffect();
    let totalThrust = 0;

    for (let i = 0; i < n; i++) {
      const theta = this.nacelleTilt[i];
      const phi = this.nacelleYaw[i];
      const ct = Math.cos(theta), st = Math.sin(theta);
      const cp = Math.cos(phi), sp = Math.sin(phi);
      // Body-frame thrust axis Rz(phi)*Rx(theta)*(0,1,0): theta = 0 is
      // straight up, theta = -PI/2 is straight forward (-Z), and phi vectors
      // the jet laterally. The node transform below composes it the same way.
      vec3.set(_v, -ct * sp, ct * cp, st);
      vec3.transformQuat(_dir, _v, this.orientation);

      const staticThrust = tMax * this.nacelleHealth[i];
      const axial = vec3.dot(this.velocity, _dir);
      const lapse = thrustLapse(staticThrust, rho, axial);
      const T = this.nacelleThrottle[i] * staticThrust * lapse * ge;
      this.nacelleThrust[i] = T;
      totalThrust += T;

      vec3.scale(_f2, _dir, T);
      vec3.add(force, force, _f2);

      vec3.set(_v, this.nacellePos[i * 3], this.nacellePos[i * 3 + 1], this.nacellePos[i * 3 + 2]);
      vec3.transformQuat(_v2, _v, this.orientation);
      vec3.cross(_v, _v2, _f2);
      vec3.add(torque, torque, _v);
    }
    this.totalThrust = totalThrust;
  }

  /**
   * Ducted-fan thrust augmentation near a reflecting surface. Water reflects
   * the downwash less than rock does because it deforms and entrains air,
   * which is why the gain is halved over the sea.
   */
  _groundEffect() {
    const h = Math.max(0, Math.min(
      this.groundClearance,
      this.wetted > 0.02 ? Infinity : this.position[1] - this.waterSurfaceY));
    if (!(h < VESSEL.GROUND_EFFECT_HEIGHT)) return 1;
    const overWater = this.position[1] - this.waterSurfaceY < this.groundClearance;
    const gain = (VESSEL.GROUND_EFFECT_GAIN - 1) * (overWater ? 0.57 : 1.0);
    return 1 + gain * Math.exp(-2.40 * h / DUCT_DIAMETER);
  }

  /**
   * Aerodynamics, weighted by (1 - beta). Quadratic drag per body axis, modest
   * body lift with a soft stall, a sideslip penalty, and rate damping.
   */
  _applyAero(force, torque) {
    const w = 1 - this.beta;
    if (w < 1e-3) return;
    const rho = airDensity(this.position[1]);
    const speed = vec3.len(this.velocity);
    if (speed < 1e-3) return;

    quat.conjugate(_q, this.orientation);
    vec3.transformQuat(_v, this.velocity, _q);
    const vb = _v;

    // Per-axis quadratic drag in the body frame.
    vec3.set(_v2,
      -0.5 * rho * VESSEL.AIR_DRAG_COEFF[0] * VESSEL.AIR_REFERENCE_AREA[0] * vb[0] * Math.abs(vb[0]),
      -0.5 * rho * VESSEL.AIR_DRAG_COEFF[1] * VESSEL.AIR_REFERENCE_AREA[1] * vb[1] * Math.abs(vb[1]),
      -0.5 * rho * VESSEL.AIR_DRAG_COEFF[2] * VESSEL.AIR_REFERENCE_AREA[2] * vb[2] * Math.abs(vb[2]));

    const q = 0.5 * rho * speed * speed;
    const sRef = VESSEL.AIR_REFERENCE_AREA[1];
    const alpha = Math.atan2(-vb[1], -vb[2]);
    const sideslip = Math.asin(clamp(vb[0] / Math.max(speed, 0.1), -1, 1));

    const clLin = CL_SLOPE * alpha;
    const clPlate = 2.0 * Math.sin(alpha) * Math.cos(alpha);
    const stall = smoothstep(STALL_BLEND_START, STALL_BLEND_END, Math.abs(alpha));
    const cl = clamp(lerp(clLin, clPlate, stall), -VESSEL.LIFT_COEFF, VESSEL.LIFT_COEFF);

    // Lift acts perpendicular to the relative wind, in the body's vertical
    // plane: take body up and remove its component along the velocity.
    vec3.normalize(_f2, this.velocity);
    const upDot = vec3.dot(_up, _f2);
    vec3.scaleAndAdd(_dir, _up, _f2, -upDot);
    if (vec3.sqrLen(_dir) > 1e-6) {
      vec3.normalize(_dir, _dir);
      vec3.scaleAndAdd(force, force, _dir, q * sRef * cl * w);
    }
    // Induced drag and the sideslip penalty act along the relative wind.
    const cdi = INDUCED_DRAG_K * cl * cl + SIDESLIP_DRAG * Math.abs(sideslip);
    vec3.scaleAndAdd(force, force, _f2, -q * sRef * cdi * w);
    // Side force from sideslip, in the body X axis.
    _v2[0] += q * sRef * CY_BETA * sideslip;

    vec3.transformQuat(_f2, _v2, this.orientation);
    vec3.scaleAndAdd(force, force, _f2, w);

    // ---- damping and weathervane moments --------------------------------
    vec3.transformQuat(_v, this.angularVelocity, _q);   // body rates
    const vClamp = Math.max(speed, AERO_DAMPING_FLOOR);
    const L = VESSEL.LENGTH, B = VESSEL.BEAM;
    vec3.set(_v2,
      q * sRef * L * CMQ * (_v[0] * L / (2 * vClamp)),
      q * sRef * L * (CNR * (_v[1] * L / (2 * vClamp)) + CN_BETA * sideslip),
      q * sRef * B * CLP * (_v[2] * B / (2 * vClamp)));
    vec3.transformQuat(_f2, _v2, this.orientation);
    vec3.scaleAndAdd(torque, torque, _f2, w);
  }

  /**
   * Hydrodynamics, weighted by beta. The drag coefficients in constants.js are
   * DRAG AREAS (Cd * A, m^2) - unlike the air terms they have no companion
   * reference-area array, because a submerged hull's reference area is the
   * whole wetted body and folding the two together is how submarine
   * coefficients are conventionally published.
   */
  _applyHydro(force, torque) {
    const b = this.beta;
    if (b < 1e-3) return;

    quat.conjugate(_q, this.orientation);
    // Body velocity needs its OWN scratch: the rotational block below reuses
    // _v for the body rates, and the Munk moment still needs the velocity.
    vec3.transformQuat(_vb, this.velocity, _q);
    const vb = _vb;

    // Entry drag spike: the cavity has not formed yet and the hull is pushing
    // solid water out of the way.
    let spike = 1;
    if (this.entryTimer < VESSEL.TRANSITION_TIME) {
      spike = 1 + (VESSEL.ENTRY_DRAG_SPIKE - 1) * Math.exp(-this.entryTimer / 0.085);
    }
    const k = 0.5 * RHO_WATER * b * spike;

    vec3.set(_v2,
      -(k * VESSEL.WATER_DRAG_COEFF[0] * vb[0] * Math.abs(vb[0]) + HYDRO_LIN_DRAG[0] * b * vb[0]),
      -(k * VESSEL.WATER_DRAG_COEFF[1] * vb[1] * Math.abs(vb[1]) + HYDRO_LIN_DRAG[1] * b * vb[1]),
      -(k * VESSEL.WATER_DRAG_COEFF[2] * vb[2] * Math.abs(vb[2]) + HYDRO_LIN_DRAG[2] * b * vb[2]));
    vec3.transformQuat(_f2, _v2, this.orientation);
    vec3.add(force, force, _f2);

    // Rotational damping.
    vec3.transformQuat(_v, this.angularVelocity, _q);
    vec3.set(_v2,
      -(HYDRO_ANG_QUAD[0] * _v[0] * Math.abs(_v[0]) + HYDRO_ANG_LIN[0] * _v[0]) * b,
      -(HYDRO_ANG_QUAD[1] * _v[1] * Math.abs(_v[1]) + HYDRO_ANG_LIN[1] * _v[1]) * b,
      -(HYDRO_ANG_QUAD[2] * _v[2] * Math.abs(_v[2]) + HYDRO_ANG_LIN[2] * _v[2]) * b);

    // Munk moment: an axisymmetric body moving at an angle to its axis in an
    // ideal fluid feels a destabilising couple. It is what makes a submarine
    // want to broach sideways, and it is one of the things that goes wrong
    // when the flight computer is damaged.
    const maX = VESSEL.ADDED_MASS[0] * VESSEL.MASS * b;
    const maY = VESSEL.ADDED_MASS[1] * VESSEL.MASS * b;
    const maZ = VESSEL.ADDED_MASS[2] * VESSEL.MASS * b;
    _v2[0] += (maZ - maY) * vb[2] * vb[1];
    _v2[1] += (maZ - maX) * vb[2] * vb[0];

    // Fins and stern planes. The only source of STATIC stability underwater - they
    // oppose the ANGLE, where the damping above only opposes the rate. See
    // HYDRO_FIN for why the hull needs them and what happened without them.
    //
    // The local flow the fin actually sees is the transverse velocity at ITS OWN
    // position, which is the hull's plus `omega x r`. That single expression gives
    // both the weathervane stiffness and the rate damping, correctly coupled.
    //
    // Signs. A fin turns the nose TOWARD the velocity vector, and "toward" has
    // opposite handedness on the two axes: for a body drifting up (vb[1] > 0) that
    // means nose-up, which is +X; for a body drifting to starboard (vb[0] > 0) it
    // means nose-to-starboard, which is -Y. That asymmetry is also why the Munk
    // moment above, written with one algebraic form for both axes, destabilises
    // yaw while stabilising pitch.
    //
    // `speed * v` rather than `speed^2 * sin(incidence)`: identical to first order,
    // and smooth and correctly signed through zero and through a reversal, where
    // an asin would need guarding.
    //
    // The DEFLECTION enters as an incidence offset on the same surface, which is
    // why its authority carries the same q and stays usable at any speed the
    // stiffness is significant at. See FIN_DEFLECT_MAX.
    const spd = vec3.len(vb);
    // Roll-rate damping from the same surfaces. See HYDRO_FIN_ROLL.
    _v2[2] -= HYDRO_FIN_ROLL * b * spd * _v[2];
    _v2[0] += HYDRO_FIN[0] * b * spd *
      (vb[1] - _v[0] * HYDRO_FIN_ARM[0] + spd * this.finPitch);
    _v2[1] -= HYDRO_FIN[1] * b * spd *
      (vb[0] + _v[1] * HYDRO_FIN_ARM[1] - spd * this.finYaw);

    vec3.transformQuat(_f2, _v2, this.orientation);
    vec3.add(torque, torque, _f2);
  }

  // -------------------------------------------------------------------------
  // Integration
  // -------------------------------------------------------------------------

  /**
   * Semi-implicit Euler with a body-frame diagonal added-mass matrix.
   * Accelerating a submerged hull also accelerates the water around it, and
   * the entrained mass is wildly anisotropic - heaving the Kestrel drags along
   * nearly as much water as the vessel weighs, while surging drags a fifth of
   * that. Ignoring it makes a submersible feel like a hovercraft.
   */
  _integrate(dt, force, torque, mass) {
    const b = this.beta;
    quat.conjugate(_q, this.orientation);

    // ---- linear ----------------------------------------------------------
    vec3.transformQuat(_v, force, _q);                  // body-frame force
    _v[0] /= mass + b * VESSEL.ADDED_MASS[0] * VESSEL.MASS;
    _v[1] /= mass + b * VESSEL.ADDED_MASS[1] * VESSEL.MASS;
    _v[2] /= mass + b * VESSEL.ADDED_MASS[2] * VESSEL.MASS;
    vec3.transformQuat(_v2, _v, this.orientation);      // world acceleration

    let a = vec3.len(_v2);
    if (a > MAX_LINEAR_ACCEL) {
      // Purely a numerical safeguard. It does NOT damage the hull.
      //
      // It used to, on the reasoning that a slam hard enough to saturate the solver
      // is a slam hard enough to hurt - which is true of a slam and false of
      // everything else that can saturate it. Drag, thrust and the entry spike all
      // saturate it too, so an ordinary high-speed dive was charged 181% of the hull
      // for an "impact" that never happened. Real impacts are already accounted for
      // where they physically occur: the slam term in _onWaterEntry and the contact
      // term in _resolveTerrain, both of which are driven by a measured impact
      // speed. A numerical clamp is not a physical event and must not be billed as
      // one.
      vec3.scale(_v2, _v2, MAX_LINEAR_ACCEL / a);
    }
    vec3.scaleAndAdd(this.velocity, this.velocity, _v2, dt);
    vec3.clampLen(this.velocity, this.velocity, MAX_LINEAR_SPEED);
    vec3.scaleAndAdd(this.position, this.position, this.velocity, dt);

    // ---- angular ---------------------------------------------------------
    vec3.transformQuat(_v, torque, _q);                 // body-frame torque
    vec3.transformQuat(_v2, this.angularVelocity, _q);  // body-frame rate
    const ix = this.inertia[0] + b * VESSEL.ADDED_MASS[0] * VESSEL.INERTIA[0];
    const iy = this.inertia[1] + b * VESSEL.ADDED_MASS[1] * VESSEL.INERTIA[1];
    const iz = this.inertia[2] + b * VESSEL.ADDED_MASS[2] * VESSEL.INERTIA[2];
    // Euler's equation: I*alpha = tau - omega x (I*omega).
    _v[0] -= _v2[1] * (iz * _v2[2]) - _v2[2] * (iy * _v2[1]);
    _v[1] -= _v2[2] * (ix * _v2[0]) - _v2[0] * (iz * _v2[2]);
    _v[2] -= _v2[0] * (iy * _v2[1]) - _v2[1] * (ix * _v2[0]);
    _v[0] /= ix; _v[1] /= iy; _v[2] /= iz;

    let aa = vec3.len(_v);
    if (aa > MAX_ANGULAR_ACCEL) vec3.scale(_v, _v, MAX_ANGULAR_ACCEL / aa);
    vec3.scaleAndAdd(_v2, _v2, _v, dt);
    vec3.clampLen(_v2, _v2, MAX_ANGULAR_SPEED);
    vec3.transformQuat(this.angularVelocity, _v2, this.orientation);

    quat.integrate(this.orientation, this.orientation, this.angularVelocity, dt);

    // A single non-finite value here would propagate through the whole save.
    // Restore the last good transform instead, and say so.
    if (!vec3.isFinite(this.position) || !vec3.isFinite(this.velocity) ||
        !Number.isFinite(this.orientation[3])) {
      console.error('[Vessel] non-finite state; restoring previous transform');
      vec3.copy(this.position, this.prevPosition);
      quat.copy(this.orientation, this.prevOrientation);
      vec3.zero(this.velocity);
      vec3.zero(this.angularVelocity);
    }
  }

  _resolveTerrain(dt) {
    const c = this.collision.resolveVesselHull(
      this, VESSEL_HULL_PROBES, VESSEL_HULL_PROBE_COUNT, VESSEL_PROBE_RADIUS, dt,
      this._hullContact, this._time);
    if (c.contacts > 0 && c.impactSpeed > 4.0) {
      this.damageHull(0.30 * (c.impactSpeed - 4.0) ** 1.30, 'collision');
      events.emit(EVENTS.VESSEL_COLLIDE, {
        speed: c.impactSpeed, normal: c.normal, material: MATERIAL_NAMES[c.material],
      });
    }
    this.habitat?.resolveVessel(this);
  }

  // -------------------------------------------------------------------------
  // Systems
  // -------------------------------------------------------------------------

  _updateSystems(dt) {
    this._updatePower(dt);
    this._updateDepthRating(dt);
    this._updateOxygen(dt);

    // Overspeed. In assisted flight the envelope protection means this never
    // fires; in manual it is the only thing that stops you.
    const v = this.speed;
    if (!this._ctxWet && v > VESSEL.MAX_AIRSPEED) {
      this.damageHull(OVERSPEED_DPS * (v - VESSEL.MAX_AIRSPEED) * dt, 'overspeed');
    }
  }

  /** Fixed structures are injected like terrain so headless physics stays usable. */
  setHabitat(habitat) { this.habitat = habitat; }

  _updatePower(dt) {
    let draw = VESSEL.POWER_DRAW_IDLE;
    let thrustFraction = 0;
    for (let i = 0; i < VESSEL.NACELLE_COUNT; i++) thrustFraction += this.nacelleThrottle[i];
    thrustFraction /= VESSEL.NACELLE_COUNT;
    // Induced power goes as thrust^1.5, so a hover costs far less than a climb.
    draw += VESSEL.POWER_DRAW_THRUST_MAX * thrustFraction ** 1.5;
    for (const id of LIGHT_GROUPS) {
      if (this.lights[id]) draw += VESSEL_LIGHTS[id.toUpperCase()].draw;
    }
    if (this.ballastCommand < 0) draw += 4.2;
    this.powerDraw = draw;

    // The pad recharges; everything else drains.
    const onPad = this.groundClearance < 1.5 &&
      Math.hypot(this.position[0] - WORLD.VESSEL_PAD_POSITION[0],
                 this.position[2] - WORLD.VESSEL_PAD_POSITION[2]) < 8;
    const net = onPad ? VESSEL.POWER_RECHARGE_RATE - draw : -draw;
    this.power = clamp(this.power + (net * dt) / 3600, 0, this.powerCapacity);

    const frac = this.powerFraction;
    if (frac < 0.12 && !this._powerWarned) {
      this._powerWarned = true;
      events.emit(EVENTS.VESSEL_POWER_LOW, { fraction: frac });
    } else if (frac > 0.2) {
      this._powerWarned = false;
    }
    // A dead cell caps propulsion; it does not switch it off, because a vessel
    // that cannot move at all is a softlock.
    if (frac <= 0.04) {
      for (let i = 0; i < VESSEL.NACELLE_COUNT; i++) {
        this.nacelleCommand[i] = Math.min(this.nacelleCommand[i], 0.4);
      }
    }
  }

  /**
   * Depth rating, creaking and pressure damage. The creaks are a Poisson
   * process whose rate rises with stress, so they arrive irregularly - a
   * metronome would read as a machine, and this has to read as a hull.
   */
  _updateDepthRating(dt) {
    const rating = this.depthRating;
    const ratio = this.depth / rating;

    const stress = saturate((ratio - VESSEL.CREAK_THRESHOLD) / (1 - VESSEL.CREAK_THRESHOLD));
    if (stress > 0) {
      this._creakAccum += 1.40 * stress * dt;
      // Exponential inter-arrival sampling from a uniform draw.
      if (this._creakAccum > -Math.log(Math.max(this._rng(), 1e-6))) {
        this._creakAccum = 0;
        events.emit(EVENTS.VESSEL_HULL_CREAK, { depth: this.depth, intensity: stress });
      }
    } else {
      this._creakAccum = 0;
    }

    if (ratio > 1) {
      const over = this.depth - rating;
      this.damageHull(VESSEL.OVERDEPTH_DPS * (over / 100) ** 1.60 * dt, 'pressure');
    }

    const severity = ratio >= 1.2 ? 2 : ratio >= 1.0 ? 1 : 0;
    if (severity !== this._depthWarned) {
      this._depthWarned = severity;
      if (severity > 0) {
        events.emit(EVENTS.VESSEL_DEPTH_WARNING, { depth: this.depth, rating, severity });
      }
    }
  }

  /**
   * Cabin oxygen. Submerged and powered, the electrolyser makes more oxygen
   * than the pilot breathes, so the reserve refills - the "unlimited air in
   * the vessel" promise is physically motivated rather than asserted.
   */
  _updateOxygen(dt) {
    const generating = this.beta > 0.6 && this.powerFraction > 0.04;
    if (generating) {
      this.cabinOxygen = Math.min(VESSEL.CABIN_OXYGEN, this.cabinOxygen + dt * 2.5);
    } else if (this.piloted) {
      this.cabinOxygen = Math.max(0, this.cabinOxygen - dt);
    }
  }

  /** @param {number} amount percent of hull integrity */
  damageHull(amount, source) {
    if (!(amount > 0)) return;
    this.hull = clamp(this.hull - amount, 0, this.hullMax);
    events.emit(EVENTS.VESSEL_DAMAGE, { amount, subsystem: 'hull', source });
    // Being below 18% leaves a permanent scar on the maximum integrity.
    if (this.hull < 18) this.hullMax = Math.min(this.hullMax, VESSEL.MAX_HULL - 6);
  }

  repair(amount) {
    this.hull = clamp(this.hull + amount, 0, this.hullMax);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /**
   * Rebuild the per-node model matrices. Nacelles carry their tilt and lateral
   * vector; rotors carry the spin on top of that. Keeping the previous frame's
   * matrices is what lets the entity pass emit correct motion vectors for a
   * spinning rotor on a rolling vessel.
   */
  _updateNodeMatrices(initial) {
    if (!initial) this.prevNodeMatrices.set(this.nodeMatrices);
    // A seeding call (construction, boarding, a teleport) has no render alpha to
    // interpolate with, so it snaps the render transform to the sim state.
    if (initial) {
      vec3.copy(this._renderPos, this.position);
      quat.copy(this._renderQuat, this.orientation);
    }

    const one = this._scaleOne;
    // FROM THE RENDER TRANSFORM, NOT THE SIM STATE, and this is load-bearing.
    //
    // applyCamera places the eye at lerp(prevPosition, position, alpha). If the
    // mesh is built from `position` instead, the hull is drawn up to one whole sim
    // step ahead of where the camera believes it is - 2 m at 120 m/s and 60 Hz, on
    // a 7.4 m hull whose cockpit eye sits at COCKPIT_EYE inside it. The eye then
    // falls out of the hull, the back-face culling that hides the hull and canopy
    // stops hiding them, and the nacelles - already ~42 degrees off the view axis
    // against a 37 degree half-FOV - swing into frame. Reported from play as
    // "the various parts of the vessel move forward while the camera stays back...
    // a bunch of disconnected floating vessel parts, some clipped".
    //
    // It was latent for as long as the vessel accelerated slowly, and invisible to
    // the whole screenshot suite because every QA scenario freezes the simulation,
    // where alpha effects cannot appear.
    mat4.fromRotationTranslationScale(this.modelMatrix, this._renderQuat, this._renderPos, one);

    // Hull and skids ride the body directly.
    this.nodeMatrices.set(this.modelMatrix, VESSEL_NODE.HULL * 16);
    this.nodeMatrices.set(this.modelMatrix, VESSEL_NODE.SKIDS * 16);

    const nacelleNodes = [
      VESSEL_NODE.NACELLE_FL, VESSEL_NODE.NACELLE_FR,
      VESSEL_NODE.NACELLE_RL, VESSEL_NODE.NACELLE_RR,
    ];
    const rotorNodes = [
      VESSEL_NODE.ROTOR_FL, VESSEL_NODE.ROTOR_FR,
      VESSEL_NODE.ROTOR_RL, VESSEL_NODE.ROTOR_RR,
    ];
    const local = this._nodeLocal;
    const world = this._nodeWorld;

    for (let i = 0; i < VESSEL.NACELLE_COUNT; i++) {
      vec3.set(_p,
        this.nacellePos[i * 3], this.nacellePos[i * 3 + 1], this.nacellePos[i * 3 + 2]);
      quat.identity(_q);
      quat.rotateZ(_q, _q, this.nacelleYaw[i]);
      quat.rotateX(_q, _q, this.nacelleTilt[i]);
      mat4.fromRotationTranslationScale(local, _q, _p, one);
      mat4.multiply(world, this.modelMatrix, local);
      this.nodeMatrices.set(world, nacelleNodes[i] * 16);

      quat.rotateY(_q, _q, this.rotorPhase[i]);
      mat4.fromRotationTranslationScale(local, _q, _p, one);
      mat4.multiply(world, this.modelMatrix, local);
      this.nodeMatrices.set(world, rotorNodes[i] * 16);
    }

    if (initial) this.prevNodeMatrices.set(this.nodeMatrices);
  }

  /**
   * Camera.
   *
   * THE COCKPIT IS RIGIDLY ATTACHED TO THE HULL, and it has to be.
   *
   * The cockpit view only works at all because of back-face culling: the eye sits
   * inside the hull and inside the canopy, so both present only their back faces
   * and vanish without a special case (see render/passes/entities.js). But the
   * NACELLES are outside the hull - 1.85 m out to each side and 1.65 m forward of
   * an eye at (0, 0.72, -0.35) - which puts them about 42 degrees off the view axis
   * against the cockpit FOV's 37 degree half-angle. They clear the frame by five
   * degrees, and that margin is the only thing keeping them out of it.
   *
   * So rotating the camera away from the hull's own heading swings them straight
   * into view, and because the hull between them is back-face culled they arrive as
   * pieces of vessel floating in mid-air with nothing joining them up. An earlier
   * version of this method pointed the camera at the AIM instead, to keep the
   * hull's attitude error out of the pilot's sight and out of the hand-in-the-loop
   * feedback path that error can drive. It bought nothing that the fixes to the
   * allocator, the loop gains and the fins had not already bought, and it cost
   * that: 50 degrees of aim lead put a duct in the middle of the windscreen.
   *
   * This is also what Subnautica does, and why it feels direct: the mouse steers
   * the vehicle and the view goes with it, so you are always looking forward
   * through the canopy. Responsiveness comes from the hull tracking the aim
   * closely - which is now DIRECT_AIM_TAU's single job, and is why decoupling the
   * view was never the answer - and never from letting the view leave the vehicle.
   *
   * CHASE view still leads with the aim. The camera is 12.5 m outside the hull
   * there, so no interior geometry can be exposed, and watching the hull swing into
   * line is the entire point of an external view.
   *
   * @param {import('../render/camera.js').Camera} camera
   * @param {number} alpha render interpolation factor in [0,1)
   * @param {number} dt real render delta, seconds
   */
  /**
   * Resolve the transform this frame is DRAWN at, and rebuild the node matrices
   * from it. Must run once per RENDERED frame, before applyCamera and before the
   * entity pass reads nodeMatrices - and unconditionally, because a parked vessel
   * is still drawn while the camera is on the player.
   *
   * The mesh and the cockpit eye have to come from ONE transform or they separate
   * by up to a sim step of travel; see _updateNodeMatrices for what that looks
   * like. Rebuilding per rendered frame also makes prevNodeMatrices the previous
   * RENDERED frame, which is what the motion vectors want in the first place -
   * TAA reprojects between rendered frames, not between sim steps.
   */
  applyRender(alpha) {
    vec3.lerp(this._renderPos, this.prevPosition, this.position, alpha);
    quat.slerp(this._renderQuat, this.prevOrientation, this.orientation, alpha);
    quat.normalize(this._renderQuat, this._renderQuat);
    this._updateNodeMatrices(false);
  }

  applyCamera(camera, alpha, dt = 1 / 60) {
    // A hitch must not let the chase spring integrate a huge step and fling the
    // camera across the world.
    const cdt = clamp(dt, 0, 1 / 20);
    // Resolve the drawn transform HERE rather than requiring the caller to have
    // done it. applyRender must run exactly once per rendered frame - it rolls
    // prevNodeMatrices, which the motion vectors read - and making applyCamera own
    // it is what guarantees the two are called the same number of times. main.js
    // calls applyRender directly only on the frames where the camera is NOT on the
    // vessel and applyCamera therefore does not run.
    this.applyRender(alpha);
    // THE SAME transform the mesh was just built from, not a second interpolation
    // of the same inputs. Sharing the value is what makes "rigidly attached to the
    // hull" true of the DRAWN hull rather than of the simulated one.
    vec3.copy(this._cameraPos, this._renderPos);
    quat.copy(this._cameraQuat, this._renderQuat);

    if (this.cameraMode === 'cockpit') {
      vec3.set(_p, VESSEL.COCKPIT_EYE[0], VESSEL.COCKPIT_EYE[1], VESSEL.COCKPIT_EYE[2]);
      // Seat and heading both from the HULL. Rigidly.
      vec3.transformQuat(_v, _p, this._cameraQuat);
      vec3.add(camera.position, this._cameraPos, _v);
      camera.setOrientation(this._cameraQuat);
    } else {
      // Chase: hang the ideal point behind the AIM rather than behind the hull, so
      // the camera leads the turn and the hull is seen yawed and banked against the
      // view. Safe out here, and the point of the view.
      //
      // Yaw is interpolated through the WRAPPED DELTA, not between the absolute
      // values: a heading crossing north goes from +3.14 to -3.14, and lerping those
      // two takes the camera the long way round in a single frame.
      const aimYawR = this.prevAimYaw + wrapAngle(this.aimYaw - this.prevAimYaw) * alpha;
      // chasePitchBias tips the PLACEMENT only, never the hull and never the
      // cockpit - see the field's own note for why that distinction is the
      // whole safety argument.
      const aimPitchR = lerp(this.prevAimPitch, this.aimPitch, alpha)
        - clamp(this.chasePitchBias, -0.8, 0.8);
      quat.fromEuler(this._camQuat, aimYawR, aimPitchR, 0);
      quat.forward(_fwd, this._camQuat);
      quat.up(_up, this._camQuat);
      vec3.scaleAndAdd(_p, this._cameraPos, _fwd, -VESSEL.CHASE_DISTANCE);
      vec3.scaleAndAdd(_p, _p, _up, VESSEL.CHASE_HEIGHT);
      // VELOCITY FEED-FORWARD. The spring below trails a moving target by
      // exactly `10 * CHASE_DAMPING * v / CHASE_SPRING` in the steady state, so
      // without this the camera sat 72 m further back than CHASE_DISTANCE at a
      // 66 m/s cruise and the hull photographed as a speck. Offsetting the
      // IDEAL point by that same lag cancels it at every speed while leaving the
      // spring's whole response to ACCELERATION intact - which is the part that
      // reads as weight. VESSEL.CHASE_LAG_COMP = 0 is the bisect back to the
      // old image; the derivation is on the constant.
      vec3.scaleAndAdd(_p, _p, this.velocity,
        VESSEL.CHASE_LAG_COMP * 10 * VESSEL.CHASE_DAMPING / VESSEL.CHASE_SPRING);
      // Dolly toward the cockpit POSE, not toward a shrunken offset: scaling
      // the offsets to zero would park the ideal point at the HULL ORIGIN and
      // feed lookRotation a vanishing vector. Instead the spring target lerps
      // to the cockpit eye, so at chaseDolly 0 the spring settles exactly
      // where cockpit mode would put the camera (the orientation and FOV
      // converge below and in cameraFov()).
      if (this.chaseDolly < 1) {
        vec3.set(_dollyEye, VESSEL.COCKPIT_EYE[0], VESSEL.COCKPIT_EYE[1], VESSEL.COCKPIT_EYE[2]);
        vec3.transformQuat(_dollyEye, _dollyEye, this._cameraQuat);
        vec3.add(_dollyEye, _dollyEye, this._cameraPos);
        vec3.lerp(_p, _dollyEye, _p, clamp(this.chaseDolly, 0, 1));
      }
      if (!this._chaseValid) {
        // First frame in chase view: snap. Springing in from wherever the
        // scratch happened to be would swing the camera across the world.
        vec3.copy(this._chasePos, _p);
        vec3.zero(this._chaseVel);
        this._chaseValid = true;
      }
      // Critically damped spring toward the ideal chase point. The REAL frame
      // delta: this was hard-coded to 1/60 while being called once per rendered
      // frame, so at 120 fps the spring ran at twice its intended rate and the
      // resulting camera motion read as the vessel itself wobbling.
      vec3.sub(_v, _p, this._chasePos);
      vec3.scaleAndAdd(this._chaseVel, this._chaseVel, _v, VESSEL.CHASE_SPRING * cdt);
      vec3.scale(this._chaseVel, this._chaseVel, Math.exp(-VESSEL.CHASE_DAMPING * 10 * cdt));
      vec3.scaleAndAdd(this._chasePos, this._chasePos, this._chaseVel, cdt);
      vec3.copy(camera.position, this._chasePos);
      vec3.sub(_v, this._cameraPos, this._chasePos);
      // The look-at direction vanishes as the dolly closes on the hull, so the
      // orientation hands over to the HULL quat (the cockpit orientation) on
      // the same scalar. From directly behind, look-at-hull and hull-forward
      // differ only by the height offset's few degrees of pitch, so the
      // handover reads as a gentle settle, not a swing.
      if (vec3.len(_v) > 0.5) {
        quat.lookRotation(_q, _v);
        if (this.chaseDolly < 1) {
          quat.slerp(_q, _q, this._cameraQuat, 1 - clamp(this.chaseDolly, 0, 1));
          quat.normalize(_q, _q);
        }
      } else {
        quat.copy(_q, this._cameraQuat);
      }
      camera.setOrientation(_q);
    }
  }

  /**
   * Register the vessel's lamps with the renderer. Called every frame: the
   * light list is rebuilt from scratch so a light never survives its owner.
   */
  submitLights(renderer) {
    // Always advance the strobe's frame history, even on the paths that never
    // reach the strobe, or the next visible frame sees a gap of unknown length.
    const strobing = this._strobeFired();
    if (this.silentRunning) {
      if (this.lights.cabin) this._submitGroup(renderer, 'cabin', 0.09);
      return;
    }
    for (const id of LIGHT_GROUPS) {
      if (!this.lights[id]) continue;
      if (id === 'strobe' && !strobing) continue;
      this._submitGroup(renderer, id, 1);
    }
  }

  /**
   * Whether a xenon flash falls in the interval since the previous submit.
   *
   * DESIGN/04.6.6 specifies a 1.2 ms flash, which is a fourteenth of a 60 Hz
   * frame: asking whether NOW lies inside that window throws away three flashes
   * in four and turns a 0.9 Hz double-pulse into random flicker. The design
   * also calls the strobe a "full-strength single-frame injection", so the
   * correct question is whether a flash HAPPENED since the last frame, which
   * renders every flash exactly once at any frame rate.
   */
  _strobeFired() {
    const prev = this._lastLightTime;
    const now = this._time;
    this._lastLightTime = now;
    // A pause, a seek or the very first frame leaves no usable interval.
    if (!(now > prev) || now - prev > STROBE_PERIOD) {
      const phase = ((now % STROBE_PERIOD) + STROBE_PERIOD) % STROBE_PERIOD;
      return phase < STROBE_WIDTH ||
        (phase >= STROBE_PHASES[1] && phase < STROBE_PHASES[1] + STROBE_WIDTH);
    }
    for (let i = 0; i < STROBE_PHASES.length; i++) {
      const p = STROBE_PHASES[i];
      if (Math.floor((now - p) / STROBE_PERIOD) !== Math.floor((prev - p) / STROBE_PERIOD)) {
        return true;
      }
    }
    return false;
  }

  _submitGroup(renderer, id, scale) {
    const def = VESSEL_LIGHTS[id.toUpperCase()];
    const mounts = VESSEL_LIGHT_MOUNTS[id];
    const aims = VESSEL_LIGHT_AIM[id];
    const color = this._lightColor[id];
    // Brown-out flicker below 8% cell, and a hard dim when the bus is low.
    const brownout = this.powerFraction < 0.08
      ? 0.55 + 0.45 * Math.sin(this._time * 5.65)
      : 1;
    const intensity = def.intensity * scale * brownout;

    for (let i = 0; i < mounts.length; i++) {
      vec3.set(_p, mounts[i][0], mounts[i][1], mounts[i][2]);
      vec3.transformQuat(this._lightScratch, _p, this.orientation);
      vec3.add(this._lightScratch, this._lightScratch, this.position);
      vec3.set(_v, aims[i][0], aims[i][1], aims[i][2]);
      vec3.normalize(_v, _v);
      vec3.transformQuat(this._lightDir, _v, this.orientation);

      renderer.addLight({
        position: this._lightScratch,
        color,
        intensity,
        range: def.range,
        // The cabin lamp is sealed inside the hull: it lights the interior and
        // must not scatter in the ocean outside it. See LIGHT_INTERIOR.
        type: def.id === 'cabin' ? 'interior' : (def.cone >= 3.0 ? 'point' : 'spot'),
        direction: this._lightDir,
        innerAngle: def.coneInner,
        outerAngle: def.cone,
        fill: def.fill,
        fillPower: def.fillPower,
        volumetric: def.vol,
        falloff: def.falloff,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Serialisation
  // -------------------------------------------------------------------------

  serialize() {
    return {
      position: Array.from(this.position),
      orientation: Array.from(this.orientation),
      velocity: Array.from(this.velocity),
      ballastVolume: this.ballastVolume,
      hull: this.hull,
      hullMax: this.hullMax,
      hullTier: this.hullTier,
      powerTier: this.powerTier,
      power: this.power,
      cabinOxygen: this.cabinOxygen,
      lights: { ...this.lights },
    };
  }

  deserialize(s) {
    if (!s) return;
    this.position.set(s.position);
    this.orientation.set(s.orientation);
    this.velocity.set(s.velocity);
    vec3.copy(this.prevPosition, this.position);
    quat.copy(this.prevOrientation, this.orientation);
    this.ballastVolume = s.ballastVolume;
    this.hull = s.hull;
    this.hullMax = s.hullMax;
    this.hullTier = s.hullTier | 0;
    this.powerTier = s.powerTier | 0;
    this.powerCapacity = VESSEL.POWER_TIERS[this.powerTier];
    this.power = clamp(s.power, 0, this.powerCapacity);
    this.cabinOxygen = s.cabinOxygen;
    Object.assign(this.lights, s.lights);
    // The aim is pilot state, not vessel state: a loaded vessel is not being
    // flown, and board() seeds the aim from the hull's attitude anyway.
    this.holdY = null;
    this.holdPid.reset();
    this._updateNodeMatrices(true);
  }
}
