/**
 * SUBWAVE player.
 *
 * A first-person capsule that walks, wades, treads and swims, plus the survival
 * systems that make the ocean dangerous: oxygen, pressure, stamina, health.
 *
 * `position` is the FEET point - the bottom of the capsule. Everything the
 * controller has to reason about (the ground, the step-up, the waterline, the
 * eye) is measured from the feet, and keeping the origin there removes an
 * offset from every one of those tests.
 *
 * Two locomotion models share one integrator:
 *
 *   LAND   a velocity-target character controller. Horizontal velocity is
 *          steered toward `inputDir * targetSpeed` with a hard acceleration
 *          clamp, never by adding impulses - so the top speed is EXACT and no
 *          amount of bunny-hopping stacks past it. Gravity, coyote time, a
 *          jump buffer, step-up and slope sliding sit on top.
 *
 *   SWIM   a force-integrated 6-DOF rigid body. Buoyancy, linear drag and
 *          finning thrust, with the body's orientation free (yaw about the
 *          BODY up axis, not the world's - that is what makes swimming feel
 *          weightless while walking stays grounded).
 *
 * Oxygen is the spine of the survival design and it is modelled with real
 * physiology: a demand regulator delivers gas at ambient pressure, so tank
 * consumption scales LINEARLY with absolute pressure. A tank that lasts 90 s at
 * the surface lasts about 40 s at 100 m. That single fact is what makes the
 * deep unreachable until the technology changes, and it must never be
 * "simplified away".
 */

import {
  vec3, quat, clamp, saturate, lerp, smoothstep, damp, wrapAngle,
  HALF_PI, PI, TAU,
} from '../core/math.js';
import { PLAYER, PLAYER_LAMP, WORLD, oxygenDepthMultiplier } from '../core/constants.js';
import { events, EVENTS } from '../core/events.js';
import { settings } from '../core/settings.js';
import { ACTION } from '../core/input.js';
import {
  createCapsuleContact, MATERIAL_NAMES, MATERIAL_GRIP, MATERIAL_SOFTNESS,
} from '../world/collision.js';

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export const PLAYER_STATE = {
  GROUNDED: 0,
  AIRBORNE: 1,
  SLIDING: 2,
  WADING: 3,
  TREADING: 4,
  SWIM_FREE: 5,
  PILOTING: 6,
  BLACKOUT: 7,
};

export const PLAYER_STATE_NAMES = [
  'GROUNDED', 'AIRBORNE', 'SLIDING', 'WADING', 'TREADING', 'SWIM_FREE',
  'PILOTING', 'BLACKOUT',
];

// ---------------------------------------------------------------------------
// Tuning that is not in constants.js
// ---------------------------------------------------------------------------

/** Directional speed multipliers. No diagonal boost: the input is normalised. */
const STRAFE_MULTIPLIER = 0.86;
const BACKWARD_MULTIPLIER = 0.72;

/** Gravity shaping. A snappier fall than the rise reads as more responsive. */
const GRAVITY_RISE_HELD = 1.00;
const GRAVITY_RISE_RELEASED = 2.15;
const GRAVITY_FALL = 1.35;
const TERMINAL_VELOCITY_AIR = 58.0;

const JUMP_BUFFER = 0.15;
const JUMP_COOLDOWN = 0.18;

/** Kinetic friction of a body sliding down rock, DESIGN/05.2.4. */
const SLIDE_FRICTION = 0.28;
/** Steering authority retained while sliding: a slide is survivable. */
const SLIDE_CONTROL = 0.35;

/** Fall damage, DESIGN/05.2.2. */
const FALL_SAFE_SPEED = 6.5;

/** Metres of ground travel per full two-step cycle. */
const STRIDE_WALK = 1.56;
const STRIDE_RUN = 2.12;
const STRIDE_CROUCH = 1.02;
const FOOTSTEP_MIN_INTERVAL = 0.20;

/** Head-bob amplitudes, metres and radians. */
const BOB_Y = Float32Array.of(0.021, 0.034, 0.014);   // walk, run, crouch
const BOB_X = Float32Array.of(0.026, 0.041, 0.018);

/** Crouch transition times, seconds. */
const CROUCH_DOWN_TIME = 0.18;
const CROUCH_UP_TIME = 0.24;

/**
 * Depth at which the suit's closed-cell foam has compressed enough to make the
 * diver exactly neutral (DESIGN/05.3.2). Above it you float, below it you sink,
 * and descending therefore gets easier while ascending gets harder - which is
 * real, and is the most quietly frightening thing about depth.
 */
const NEUTRAL_DEPTH = 18.5;
/** Terminal sink rate once the foam is fully crushed, m/s. */
const MAX_SINK_DRIFT = 1.1;

/** Stroke cycle rates, Hz. */
const STROKE_HZ_CRUISE = 0.82;
const STROKE_HZ_SPRINT = 1.55;

/** Stroke pulse shape: baseline, surge amplitude, and the surge's sharpness. */
const PULSE_BASE = 0.34;
const PULSE_SURGE = 1.62;
const PULSE_SHARP = 1.35;
/**
 * Mean of the stroke pulse over one full cycle.
 *
 * Divided out so the pulse has unit mean, which now makes `pulse - 1` a
 * ZERO-MEAN surge - the form the camera needs, since a surge with a DC term
 * would leave the eye sitting permanently forward of the body.
 *
 * It used to be load-bearing for a different reason: the pulse multiplied the
 * thrust, so without the normalisation every swim speed constant read 24% high
 * (mean 0.807) while _simulateSwim's docstring claimed the steady state was
 * exact. The pulse no longer touches the thrust, but the normalisation is worth
 * exactly as much on the camera.
 *
 * SUMMED rather than written down, so that retuning the three shape constants
 * above cannot silently reintroduce a DC offset.
 */
const PULSE_MEAN = (() => {
  const N = 1024;
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const s = Math.sin(TAU * (i / N));
    sum += PULSE_BASE + PULSE_SURGE * Math.max(0, s) ** PULSE_SHARP;
  }
  return sum / N;
})();
/**
 * How fast the camera's stroke surge fades once the diver stops finning, 1/s.
 * The stroke PHASE freezes when there is no input, so without this the eye
 * would hold whatever fraction of a lunge it was in - up to 4 cm - for as long
 * as the player coasted.
 */
const STROKE_SURGE_FADE = 12;
/** Fore-aft camera lunge per unit of stroke surge, metres. */
const STROKE_SURGE_THROW = 0.030;

/** Water entry/exit hysteresis so a wave chop cannot flicker the state. */
const SUBMERGENCE_HYSTERESIS = 0.05;
/**
 * Hardest pitch a swimmer can reach, radians (~85 deg).
 *
 * Just short of vertical on purpose: you can look almost straight down at the
 * seabed or straight up at the surface, but you can never cross the pole and
 * end up inverted. The previous free-6-DOF swim model had no such limit and
 * tumbled - see _readLook().
 */
const SWIM_PITCH_LIMIT = 1.4835;
const EYE_HYSTERESIS = 0.12;

/**
 * Ceiling that unaided regeneration walks toward. Above this you keep whatever
 * you have; regeneration is a floor-raiser, not a leveller. See _updateHealth,
 * which used to enforce this in both directions.
 */
const HEALTH_REGEN_CAP = 70;

/** Refractive index of seawater; narrows the apparent field of view. */
const N_WATER = 1.339;
const UNDERWATER_FOV_BLEND = 0.65;
const FOV_AIR = 62 * (PI / 180);

/** Drowning: a damage-free grace so a player 4 m from air always makes it. */
const DROWN_GRACE = 3.0;

/**
 * The suit lamp's colour as a vec3, the one field PLAYER_LAMP cannot hold in the
 * form addLight() wants. Everything else about the lamp - intensity, range, both
 * cone angles, the beam shape and the mount offset - is on PLAYER_LAMP in
 * core/constants.js, where it is live-bisectable; see the block there.
 */
const LAMP_COLOR = vec3.create(
  PLAYER_LAMP.color[0], PLAYER_LAMP.color[1], PLAYER_LAMP.color[2]);

// ---------------------------------------------------------------------------

const _v = vec3.create();
const _v2 = vec3.create();
const _dir = vec3.create();
const _thrust = vec3.create();
const _accel = vec3.create();
const _fwd = vec3.create();
const _right = vec3.create();
const _up = vec3.create();
const _q = quat.create();
const _look = new Float32Array(2);
const _move = new Float32Array(2);

export class Player {
  /** @param {import('../world/collision.js').CollisionWorld} collision */
  constructor(collision) {
    this.collision = collision;

    // --- transform -------------------------------------------------------
    /** Feet position, absolute world space. */
    this.position = vec3.create(0, 0, 0);
    this.velocity = vec3.create();
    this.prevPosition = vec3.create();
    this.orientation = quat.create();
    this.prevOrientation = quat.create();
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;

    // --- body ------------------------------------------------------------
    this.radius = PLAYER.RADIUS;
    this.height = PLAYER.HEIGHT;
    this.crouchBlend = 0;

    // --- state -----------------------------------------------------------
    this.state = PLAYER_STATE.GROUNDED;
    this.grounded = false;
    this.walkable = true;
    this.submergence = 0;
    this.eyeSubmerged = false;
    this.depth = 0;
    this.waterSurfaceY = 0;
    this.coyoteTimer = 0;
    this.jumpBuffer = 0;
    this.jumpCooldown = 0;
    this.jumpHeld = false;
    this.inVessel = false;
    this.vessel = null;
    /** True only after cycling the fixed habitat airlock. */
    this.inHabitat = false;
    this.habitat = null;

    // --- survival --------------------------------------------------------
    this.oxygenTier = 0;
    this.suitTier = 0;
    this.finTier = 1;
    this.oxygenCapacity = PLAYER.OXYGEN_TIERS[0];
    this.oxygen = this.oxygenCapacity;
    this.health = PLAYER.MAX_HEALTH;
    this.stamina = PLAYER.MAX_STAMINA;
    this.exhausted = false;
    this.alive = true;
    this._damageTimer = PLAYER.HEALTH_REGEN_DELAY;
    this._staminaTimer = 0;
    this._drownTimer = 0;
    this._oxygenWarnTier = 0;
    this._respawnTimer = 0;

    // --- locomotion feel --------------------------------------------------
    this.stepPhase = 0;
    this._lastFootstep = 0;
    this._strokePhase = 0;
    /**
     * Zero-mean fin-stroke surge, for the camera and any animation that wants
     * the rhythm. It is deliberately NOT in the thrust - see _simulateSwim.
     */
    this.strokeSurge = 0;
    this.bobIntensity = 0;
    this._bobOffset = vec3.create();
    this._landingDip = 0;
    this._landingDipVel = 0;
    this._rollInputTimer = 0;

    // --- tools ------------------------------------------------------------
    this.lampOn = false;

    // --- scratch ----------------------------------------------------------
    this.contact = createCapsuleContact();
    this._body = {
      position: this.position,
      velocity: this.velocity,
      radius: this.radius,
      height: this.height,
      stepHeight: PLAYER.STEP_HEIGHT,
      stepDown: PLAYER.STEP_HEIGHT * 1.3,
      maxSlope: PLAYER.MAX_SLOPE,
    };
    this._cameraPos = vec3.create();
    this._cameraQuat = quat.create();
    this._lightPos = vec3.create();
    this._lightDir = vec3.create();
    this._time = 0;
  }

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------

  get swimming() {
    return this.state === PLAYER_STATE.SWIM_FREE || this.state === PLAYER_STATE.TREADING;
  }
  get crouching() { return this.crouchBlend > 0.5; }
  get eyePosition() { return this.position[1] + this.currentEyeHeight; }
  get currentHeight() { return lerp(PLAYER.HEIGHT, PLAYER.CROUCH_HEIGHT, this.crouchBlend); }
  get currentEyeHeight() {
    return lerp(PLAYER.EYE_HEIGHT, PLAYER.CROUCH_EYE_HEIGHT, this.crouchBlend);
  }
  /** Vertical FOV in radians, narrowed by the mask's air/water interface. */
  get cameraFov() {
    const full = 2 * Math.atan(Math.tan(FOV_AIR * 0.5) / N_WATER);
    const under = FOV_AIR + (full - FOV_AIR) * UNDERWATER_FOV_BLEND;
    return lerp(FOV_AIR, under, this.eyeSubmerged ? 1 : 0);
  }
  /** Seconds of gas left at the CURRENT drain rate - the number the HUD shows. */
  get oxygenSeconds() {
    return this.oxygen / Math.max(this._oxygenRate || 1, 1e-3);
  }
  get suitDepthRating() { return PLAYER.SUIT_DEPTH_TIERS[this.suitTier]; }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  /**
   * One fixed step.
   * @param {number} dt
   * @param {object} input InputManager (or anything with the same queries)
   * @param {number} worldSeconds ocean time, for the wave field
   */
  simulate(dt, input, worldSeconds) {
    this._time = worldSeconds;
    vec3.copy(this.prevPosition, this.position);
    quat.copy(this.prevOrientation, this.orientation);

    if (this.state === PLAYER_STATE.BLACKOUT) {
      this._simulateBlackout(dt, worldSeconds);
      return;
    }

    this._readLook(dt, input);
    this._sampleWater(worldSeconds);
    this._updateStance(dt, input);
    this._selectState();

    if (this.swimming) this._simulateSwim(dt, input);
    else this._simulateLand(dt, input);

    this._updateSurvival(dt, input);
    this._updateFeel(dt);
    this._handleInteraction(input);
  }

  /** The player is seated: physics off, everything else on. */
  simulateInVessel(dt, vessel) {
    if (vessel.disembarkRequested) {
      vessel.disembarkRequested = false;
      this.exitVessel(vessel);
      return;
    }
    this.state = PLAYER_STATE.PILOTING;
    vec3.copy(this.prevPosition, this.position);
    vec3.copy(this.position, vessel.position);
    vec3.zero(this.velocity);
    this.submergence = 0;
    this.eyeSubmerged = false;
    this.depth = vessel.depth;

    // The cabin recycler tops the tank up in six seconds and holds it there.
    this.oxygen = Math.min(
      this.oxygenCapacity, this.oxygen + this.oxygenCapacity * (1 / 6) * dt);
    this.stamina = Math.min(PLAYER.MAX_STAMINA, this.stamina + 22 * dt);
    this._damageTimer += dt;
    if (this._damageTimer > 3.0) {
      this.health = Math.min(PLAYER.MAX_HEALTH, this.health + 6.5 * dt);
    }
    this._drownTimer = 0;
    this._oxygenWarnTier = 0;
    this.bobIntensity = 0;
  }

  // -------------------------------------------------------------------------
  // Orientation
  // -------------------------------------------------------------------------

  /**
   * Look. On land yaw is about WORLD up and roll is pinned to zero; underwater
   * yaw is about the BODY up axis, which is what lets a diver barrel-roll into
   * a cave mouth. The crossfade happens across the waterline transition.
   */
  _readLook(dt, input) {
    input.look(_look, dt);
    const dyaw = _look[0];
    const dpitch = _look[1];

    // ONE orientation model for swimming and for walking: a compass heading
    // plus a CLAMPED pitch, with roll damped to zero.
    //
    // Swimming used to integrate incremental quaternion rotations about the
    // body axes instead - true 6-DOF, no pitch limit - and it tumbled. Push the
    // nose up far enough and you went over the top and swam on inverted, with
    // the seabed above your head and no way to tell which way was up.
    //
    // The old auto-level could not save it because it zeroed the wrong thing:
    // it drove the body's RIGHT vector horizontal, which an upside-down diver
    // satisfies perfectly. Levelling roll says nothing about whether UP is up.
    //
    // Clamping pitch makes inversion unreachable rather than merely
    // discouraged, and it is what a first-person swimmer should feel anyway -
    // you can look almost straight down at the seabed, but you never barrel-roll.
    this.yaw = wrapAngle(this.yaw + dyaw);
    this.pitch = clamp(this.pitch + dpitch, -SWIM_PITCH_LIMIT, SWIM_PITCH_LIMIT);
    this.roll = damp(this.roll, 0, 4.0, dt);
    quat.fromEuler(this.orientation, this.yaw, this.pitch, this.roll);
  }

  // -------------------------------------------------------------------------
  // Waterline
  // -------------------------------------------------------------------------

  _sampleWater(time) {
    const p = this.position;
    // A pressure room can sit thirty metres below sea level and still contain
    // air. Height alone is therefore not a medium test. The habitat transition
    // owns this latch so a player cannot become dry by clipping against its
    // exterior shell.
    if (this.inHabitat && this.habitat?.playerInside) {
      this.waterSurfaceY = p[1] - 10;
      this.submergence = 0;
      this.eyeSubmerged = false;
      this.depth = 0;
      return;
    }
    this.waterSurfaceY = this.collision.waterHeightAt(p[0], p[2], time);
    const h = this.currentHeight;
    this.submergence = saturate((this.waterSurfaceY - p[1]) / h);
    const eyeY = p[1] + this.currentEyeHeight;
    // Hysteresis on the eye test: without it a 2 cm chop strobes the fov,
    // the audio filter and the mask vignette at wave frequency.
    const band = this.eyeSubmerged ? -EYE_HYSTERESIS : EYE_HYSTERESIS;
    this.eyeSubmerged = this.waterSurfaceY > eyeY + band;
    this.depth = Math.max(0, this.waterSurfaceY - eyeY);
  }

  _selectState() {
    const wasSwimming = this.swimming;
    const s = this.submergence;
    const enterBand = 0.45 + (this.swimming ? -SUBMERGENCE_HYSTERESIS : SUBMERGENCE_HYSTERESIS);

    let next;
    if (this.grounded && s < 0.02) {
      next = this.walkable ? PLAYER_STATE.GROUNDED : PLAYER_STATE.SLIDING;
    } else if (this.grounded && s < 0.90) {
      next = PLAYER_STATE.WADING;
    } else if (this.eyeSubmerged) {
      next = PLAYER_STATE.SWIM_FREE;
    } else if (s > enterBand) {
      next = PLAYER_STATE.TREADING;
    } else {
      next = this.grounded
        ? (this.walkable ? PLAYER_STATE.GROUNDED : PLAYER_STATE.SLIDING)
        : PLAYER_STATE.AIRBORNE;
    }

    if (next !== this.state) {
      const nowSwimming = next === PLAYER_STATE.SWIM_FREE || next === PLAYER_STATE.TREADING;
      if (nowSwimming && !wasSwimming) {
        events.emit(EVENTS.PLAYER_ENTER_WATER, {
          speed: vec3.len(this.velocity), position: this.position,
        });
        // Entering at speed hurts, but only well past a competent dive.
        const impact = -this.velocity[1];
        if (impact > 14) this.damage(0.9 * this._fallDamage(impact - 7.5), 'impact');
      } else if (!nowSwimming && wasSwimming) {
        events.emit(EVENTS.PLAYER_EXIT_WATER, {
          speed: vec3.len(this.velocity), position: this.position,
        });
      }
      this.state = next;
    }
  }

  // -------------------------------------------------------------------------
  // Stance
  // -------------------------------------------------------------------------

  _updateStance(dt, input) {
    const wantCrouch = input.isDown(ACTION.CROUCH) && !this.swimming;
    const rate = wantCrouch ? dt / CROUCH_DOWN_TIME : -dt / CROUCH_UP_TIME;
    if (!wantCrouch && this.crouchBlend > 0) {
      // Refuse to stand up into a ceiling. On a height field the only ceiling
      // is the terrain itself, so this is a cheap upward clearance test.
      const headroom = this.collision.footprintHeight(
        this.position[0], this.position[2], this.radius);
      if (headroom > this.position[1] + PLAYER.HEIGHT * 0.98) return;
    }
    this.crouchBlend = saturate(this.crouchBlend + rate);
    this._body.height = this.currentHeight;
  }

  // -------------------------------------------------------------------------
  // Land locomotion
  // -------------------------------------------------------------------------

  _simulateLand(dt, input) {
    const c = this.contact;
    const grip = MATERIAL_GRIP[c.material] || 1;

    // ---- desired horizontal velocity -------------------------------------
    input.moveVector(_move);
    const strafe = _move[0];
    const forward = _move[1];
    quat.forward(_fwd, this.orientation);
    _fwd[1] = 0;
    vec3.normalize(_fwd, _fwd);
    vec3.set(_right, -_fwd[2], 0, _fwd[0]);

    const sprinting = this._wantsSprint(input, forward);
    let target = PLAYER.WALK_SPEED;
    if (this.crouchBlend > 0.5) target = PLAYER.CROUCH_SPEED;
    else if (sprinting) target = PLAYER.RUN_SPEED;
    // Wading resistance: the deeper the water, the more it costs to push it.
    if (this.state === PLAYER_STATE.WADING) {
      target *= lerp(1.0, 0.36, smoothstep(0.10, 0.85, this.submergence));
    }
    // Directional penalties, applied to the target and not to the input, so a
    // diagonal is never faster than a straight line.
    const dirScale = forward < -0.01
      ? BACKWARD_MULTIPLIER
      : lerp(STRAFE_MULTIPLIER, 1.0, Math.abs(forward));
    target *= dirScale;

    vec3.set(_dir, _right[0] * strafe + _fwd[0] * forward, 0, _right[2] * strafe + _fwd[2] * forward);
    const inputLen = Math.hypot(_dir[0], _dir[2]);
    if (inputLen > 1e-4) {
      _dir[0] /= inputLen;
      _dir[2] /= inputLen;
    }
    const wantX = _dir[0] * target * Math.min(inputLen, 1);
    const wantZ = _dir[2] * target * Math.min(inputLen, 1);

    // ---- acceleration ----------------------------------------------------
    const sliding = this.state === PLAYER_STATE.SLIDING;
    const airborne = this.state === PLAYER_STATE.AIRBORNE;
    let accel;
    if (airborne) accel = PLAYER.AIR_ACCEL;
    else if (sliding) accel = PLAYER.GROUND_ACCEL * SLIDE_CONTROL;
    else accel = PLAYER.GROUND_ACCEL * grip;

    const wantSq = wantX * wantX + wantZ * wantZ;
    if (wantSq < 1e-6 && !airborne) {
      // No input on the ground: exponential friction, which is what
      // PLAYER.GROUND_FRICTION is - a rate, not an acceleration. Exponential
      // decay is also unconditionally stable, unlike a constant deceleration
      // that overshoots through zero at large dt.
      const k = Math.exp(-PLAYER.GROUND_FRICTION * grip * dt);
      this.velocity[0] *= k;
      this.velocity[2] *= k;
    } else {
      // Steer the velocity toward the target with a hard delta clamp. The
      // speed therefore approaches the target and can never pass it, which is
      // what makes the top speed exact and unbunny-hoppable.
      const dvx = wantX - this.velocity[0];
      const dvz = wantZ - this.velocity[2];
      const dvLen = Math.hypot(dvx, dvz);
      if (dvLen > 1e-6) {
        const k = Math.min(1, (accel * dt) / dvLen);
        this.velocity[0] += dvx * k;
        this.velocity[2] += dvz * k;
      }
    }

    // ---- slope sliding ---------------------------------------------------
    if (sliding) {
      // Downslope unit vector: world down projected onto the surface plane.
      const n = c.normal;
      const d = -n[1];
      vec3.set(_v, -d * n[0], -1 - d * n[1], -d * n[2]);
      vec3.normalize(_v, _v);
      const slopeAngle = Math.acos(clamp(n[1], -1, 1));
      const a = WORLD.GRAVITY * (Math.sin(slopeAngle) - SLIDE_FRICTION * Math.cos(slopeAngle));
      if (a > 0) vec3.scaleAndAdd(this.velocity, this.velocity, _v, a * dt);
    }

    // ---- gravity and jump -------------------------------------------------
    this.jumpCooldown = Math.max(0, this.jumpCooldown - dt);
    if (input.wasPressed(ACTION.JUMP)) this.jumpBuffer = JUMP_BUFFER;
    else this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.jumpHeld = input.isDown(ACTION.JUMP);

    if (this.grounded) this.coyoteTimer = PLAYER.COYOTE_TIME;
    else this.coyoteTimer = Math.max(0, this.coyoteTimer - dt);

    const canJump = this.coyoteTimer > 0 && this.jumpCooldown <= 0 &&
      this.state !== PLAYER_STATE.SLIDING;
    if (this.jumpBuffer > 0 && canJump) {
      this.velocity[1] = Math.sqrt(2 * WORLD.GRAVITY * PLAYER.JUMP_HEIGHT);
      this.jumpBuffer = 0;
      this.coyoteTimer = 0;
      this.jumpCooldown = JUMP_COOLDOWN;
      this.grounded = false;
      events.emit(EVENTS.PLAYER_FOOTSTEP, {
        material: MATERIAL_NAMES[c.material], position: this.position, speed: 0.6,
      });
    } else {
      const rising = this.velocity[1] > 0;
      const gMul = rising
        ? (this.jumpHeld ? GRAVITY_RISE_HELD : GRAVITY_RISE_RELEASED)
        : GRAVITY_FALL;
      // Wading and shallow water partially support the body.
      const support = this.state === PLAYER_STATE.WADING
        ? saturate(this.submergence) * 0.55 : 0;
      this.velocity[1] -= WORLD.GRAVITY * gMul * (1 - support) * dt;
      if (this.velocity[1] < -TERMINAL_VELOCITY_AIR) this.velocity[1] = -TERMINAL_VELOCITY_AIR;
    }

    // ---- resolve ----------------------------------------------------------
    this._body.radius = this.radius;
    this._body.height = this.currentHeight;
    const wasGrounded = this.grounded;
    c.grounded = this.grounded;
    if (this.inHabitat && this.habitat?.playerInside) {
      this.habitat.resolvePlayer(this._body, dt, c);
    } else {
      this.collision.resolveCapsule(this._body, dt, c, this._time);
    }
    this.grounded = c.grounded;
    this.walkable = c.walkable;

    if (this.grounded && !wasGrounded && c.landingSpeed > 0) {
      this._onLand(c.landingSpeed, c.material);
    }
  }

  _wantsSprint(input, forward) {
    if (this.crouchBlend > 0.5) return false;
    if (forward < 0.1) return false;               // no sprinting backwards
    if (this.exhausted) return false;
    if (!input.isDown(ACTION.SPRINT)) return false;
    return this.stamina >= (this._sprinting ? 0.1 : 12);
  }

  _onLand(speed, material) {
    const softness = MATERIAL_SOFTNESS[material] || 0;
    let dmg = this._fallDamage(speed);
    if (softness >= 0.6) dmg *= 0.55;
    if (dmg > 0) this.damage(dmg, 'fall');
    // Camera dip, as an impulse on a critically damped spring.
    this._landingDipVel -= Math.min(0.14, 0.010 * speed) * 22;
    events.emit(EVENTS.PLAYER_FOOTSTEP, {
      material: MATERIAL_NAMES[material], position: this.position,
      speed: clamp(speed / 8, 0.3, 1.6),
    });
  }

  _fallDamage(v) {
    if (v <= FALL_SAFE_SPEED) return 0;
    const over = v - FALL_SAFE_SPEED;
    return Math.min(PLAYER.MAX_HEALTH, 7.4 * over * (1 + 0.045 * over));
  }

  // -------------------------------------------------------------------------
  // Swimming
  // -------------------------------------------------------------------------

  /**
   * Force-integrated swimming. The diver answers the keys DIRECTLY: the thrust
   * vector is the commanded direction, this step, and the only lag between a
   * key and a velocity is the drag's own time constant of 1/SWIM_DRAG = 0.167 s.
   *
   * Thrust is sized so its steady state against the linear drag is EXACTLY the
   * documented cruise or sprint speed - `v_target * SWIM_DRAG` balances
   * `-v * SWIM_DRAG` at `v = v_target` - which is what makes SWIM_DRAG a free
   * response-time parameter rather than a speed.
   *
   * TWO THINGS USED TO SIT BETWEEN THE KEY AND THE DIVER, and a playtest found
   * both at once ("it keeps swimming forward for a while"):
   *
   * 1. The thrust DIRECTION was slewed toward the demanded one at
   *    PLAYER.SWIM_TURN_RATE = 3.2 rad/s, documented as "what stops a diver
   *    reversing instantly". A reversal is pi radians, so it bought 0.98 s of
   *    continuing forward - and it was worse than that, because the slew was a
   *    normalised LERP, which is degenerate at exactly pi: lerping a unit vector
   *    toward its own negation stays COLLINEAR with it, and renormalising puts
   *    it straight back where it started. A dead-ahead W followed by a dead-ahead
   *    S therefore never turned the thrust round AT ALL. Measured on that build:
   *    2.5 s of held S left the diver swimming forward at 3.40 m/s, and the only
   *    reason a human ever escaped is that a human's aim wobbles off the pole.
   *    There is nothing left for a direction limiter to protect: the velocity
   *    itself is a 0.167 s first-order lag, which is the smoothing.
   * 2. The drag was slow enough (0.426 s) to coast for another half second on
   *    top. See PLAYER.SWIM_DRAG.
   *
   * The stroke pulse is now CAMERA-ONLY (`strokeSurge`). It multiplied the
   * thrust, and at the drag a responsive diver needs it stopped being a texture
   * and became the ride. The drag is the only thing filtering it, and its corner
   * moved from 0.374 Hz to 0.955 Hz while the cruise stroke stayed at 0.82 Hz -
   * so raising the drag UNCOVERS the surge instead of smoothing it. Measured at
   * cruise, holding W: velocity swung 2.48-5.95 m/s at the old drag (89% of the
   * mean) and 1.75-7.93 m/s at 6.0 (161%), against a mean of 4.0 either way. The
   * player asked for smooth; a surging camera reads as effort, but a velocity
   * that halves and doubles twice a second reads as the controls not tracking.
   */
  _simulateSwim(dt, input) {
    input.moveVector(_move);
    const strafe = _move[0];
    const forward = _move[1];
    const vertical = input.axis(ACTION.MOVE_UP);
    const wantsThrust = Math.abs(strafe) + Math.abs(forward) + Math.abs(vertical) > 0.01;
    const sprinting = input.isDown(ACTION.SPRINT) && !this.exhausted &&
      this.stamina > 12 && forward > 0.1;

    const targetSpeed = (sprinting ? PLAYER.SWIM_SPRINT_SPEED : PLAYER.SWIM_SPEED) *
      (this.finTier >= 2 ? PLAYER.FINS_MULTIPLIER : 1.0);

    // Stroke pulsing. The rhythm is kept in full - the phase, the stroke event
    // the audio hangs off, and the camera lunge - but it drives NOTHING that
    // moves the diver. Normalised to unit mean so `- 1` leaves a zero-mean
    // surge; see PULSE_MEAN.
    const f = sprinting ? STROKE_HZ_SPRINT : STROKE_HZ_CRUISE;
    if (wantsThrust) this._strokePhase = (this._strokePhase + f * dt) % 1;
    const s = Math.sin(TAU * this._strokePhase);
    const surge =
      (PULSE_BASE + PULSE_SURGE * Math.max(0, s) ** PULSE_SHARP) / PULSE_MEAN - 1;
    this.strokeSurge = wantsThrust
      ? surge : damp(this.strokeSurge, 0, STROKE_SURGE_FADE, dt);
    if (wantsThrust && this._strokePhase < f * dt) {
      events.emit(EVENTS.PLAYER_SWIM_STROKE, {
        position: this.position, effort: sprinting ? 1 : 0.55,
      });
    }

    // Desired thrust direction, view-relative for the horizontal axes and
    // world-vertical for ascend/descend (a diver kicks up, not "up-ish").
    quat.forward(_fwd, this.orientation);
    quat.right(_right, this.orientation);
    vec3.set(_dir,
      _fwd[0] * forward + _right[0] * strafe,
      _fwd[1] * forward + _right[1] * strafe + vertical * 0.62,
      _fwd[2] * forward + _right[2] * strafe);
    if (vec3.sqrLen(_dir) > 1e-6) vec3.normalize(_dir, _dir);
    else vec3.zero(_dir);

    // No slew, no smoothing, no state: the thrust IS the commanded direction.
    vec3.scale(_thrust, _dir, wantsThrust ? targetSpeed * PLAYER.SWIM_DRAG : 0);

    // Buoyancy. Positive near the surface, crossing zero at NEUTRAL_DEPTH as
    // the suit foam compresses, then negative and asymptotically capped.
    let drift = PLAYER.SWIM_BUOYANCY * (1 - this.depth / NEUTRAL_DEPTH);
    drift = clamp(drift, -MAX_SINK_DRIFT, PLAYER.SWIM_BUOYANCY);
    // Treading: a little extra kick keeps the mouth above the chop.
    if (this.state === PLAYER_STATE.TREADING && vertical >= 0) drift += 0.42;

    // a = thrust - (v - drift) * dragRate. The drag is linear, which is the
    // correct regime for a 0.3 m body at 2 m/s in water (Re ~ 6e5, but the flow
    // stays attached over a streamlined diver), and it keeps the integrator
    // stable at the fixed step without a velocity clamp.
    //
    // Writing the drag RELATIVE TO THE DRIFT is what makes the stop brake safe:
    // the vertical steady state is `drift` for ANY dragRate, so braking harder
    // cannot pin an idle diver in the water column or slow their rise to the
    // surface - it only settles them onto the drift sooner. (It is also exactly
    // the same expression as before: thrust - v*D + drift*D.)
    //
    // A centred input commands a STOP, the same rule the vessel's throttle
    // follows, so releasing the keys raises the drag rather than merely removing
    // the thrust. There was once a flare-to-brake branch here bound to
    // ACTION.CROUCH; it was dead code, because CONTEXT.SWIM has no CROUCH
    // binding and cannot sensibly get one - ControlLeft is already the descend
    // half of MOVE_UP. Hanging the flare off "no direction commanded" needs no
    // key at all, and a diver who has stopped finning really has stopped being
    // streamlined.
    const dragRate = wantsThrust
      ? PLAYER.SWIM_DRAG : PLAYER.SWIM_DRAG * PLAYER.SWIM_STOP_DRAG_MULT;
    for (let i = 0; i < 3; i++) {
      const rel = this.velocity[i] - (i === 1 ? drift : 0);
      _accel[i] = _thrust[i] - rel * dragRate;
    }
    // Cap what the body can exchange with the water, by ONE scalar over the
    // whole vector - see PLAYER.SWIM_MAX_ACCEL. Scaling the components
    // separately would point the acceleration somewhere the diver did not ask
    // for, which is the same argument the vessel's allocator makes.
    const aMag = Math.hypot(_accel[0], _accel[1], _accel[2]);
    if (aMag > PLAYER.SWIM_MAX_ACCEL) {
      vec3.scale(_accel, _accel, PLAYER.SWIM_MAX_ACCEL / aMag);
    }
    for (let i = 0; i < 3; i++) this.velocity[i] += _accel[i] * dt;

    if (sprinting) {
      this.stamina = Math.max(0, this.stamina - PLAYER.STAMINA_SPRINT_DRAIN * 0.78 * dt);
      this._staminaTimer = 0;
    }

    // Collision still uses the upright capsule: a swimmer bumping a wall
    // should stop, not tilt.
    this._body.radius = this.radius;
    this._body.height = this.currentHeight;
    this.contact.grounded = false;
    if (this.inHabitat && this.habitat?.playerInside) {
      this.habitat.resolvePlayer(this._body, dt, this.contact);
    } else {
      this.collision.resolveCapsule(this._body, dt, this.contact, this._time);
    }
    this.habitat?.resolveExteriorPlayer(this);
    this.grounded = this.contact.grounded;
    this.walkable = this.contact.walkable;

    // Do not let the swimmer's head rise above the wave crest.
    const maxY = this.waterSurfaceY - this.currentEyeHeight * 0.55;
    if (this.position[1] > maxY && this.velocity[1] > 0) {
      this.position[1] = maxY;
      this.velocity[1] *= 0.25;
    }
  }

  // -------------------------------------------------------------------------
  // Survival
  // -------------------------------------------------------------------------

  _updateSurvival(dt, input) {
    this._updateOxygen(dt, input);
    this._updatePressure(dt);
    this._updateStamina(dt, input);
    this._updateHealth(dt);
  }

  /**
   * Oxygen. Consumption is `activity x depth`, where the depth term is the
   * absolute pressure ratio - a regulator hands you gas at ambient pressure,
   * so at 30 m every breath costs four times what it does at the surface.
   */
  _updateOxygen(dt, input) {
    const scale = settings.get('oxygenRateScale') || 1;
    const submerged = this.eyeSubmerged;

    if (!submerged) {
      // Mouth clear: the tank refills from the atmosphere. A tank tops up in
      // 1/OXYGEN_REFILL_RATE seconds regardless of its size, so upgrading
      // never makes surfacing slower.
      const before = this.oxygen;
      this.oxygen = Math.min(
        this.oxygenCapacity,
        this.oxygen + this.oxygenCapacity * PLAYER.OXYGEN_REFILL_RATE * dt);
      if (before < this.oxygenCapacity && this.oxygen > before && this._oxygenWarnTier > 0) {
        events.emit(EVENTS.PLAYER_OXYGEN_REFILL, { source: 'surface' });
        this._oxygenWarnTier = 0;
      }
      this._oxygenRate = 0;
      this._drownTimer = 0;
      return;
    }

    let activity = PLAYER.OXYGEN_RATE_IDLE;
    input.moveVector(_move);
    const moving = Math.abs(_move[0]) + Math.abs(_move[1]) +
      Math.abs(input.axis(ACTION.MOVE_UP)) > 0.01;
    if (moving) {
      activity = input.isDown(ACTION.SPRINT)
        ? PLAYER.OXYGEN_RATE_SPRINT : PLAYER.OXYGEN_RATE_SWIM;
    }
    // Panic: a hurt diver breathes harder, which costs them the very gas they
    // need to escape. Deliberate, and it is the design's cruellest feedback loop.
    if (this.health < PLAYER.MAX_HEALTH * 0.35) activity *= PLAYER.OXYGEN_RATE_PANIC;

    const rate = activity * oxygenDepthMultiplier(this.depth) * scale;
    this._oxygenRate = rate;
    this.oxygen = Math.max(0, this.oxygen - rate * dt);

    // ---- warning escalation ---------------------------------------------
    const remaining = this.oxygen / Math.max(rate, 1e-3);
    let tier = 0;
    if (this.oxygen <= 0) tier = 3;
    else if (remaining <= PLAYER.OXYGEN_CRITICAL) tier = 2;
    else if (remaining <= PLAYER.OXYGEN_WARN) tier = 1;
    if (tier > this._oxygenWarnTier) {
      this._oxygenWarnTier = tier;
      events.emit(EVENTS.PLAYER_OXYGEN_LOW, {
        seconds: remaining,
        tier: tier === 3 ? 'empty' : tier === 2 ? 'critical' : 'warn',
      });
    }

    // ---- drowning --------------------------------------------------------
    if (this.oxygen <= 0) {
      this._drownTimer += dt;
      if (this._drownTimer > DROWN_GRACE) {
        this.damage(PLAYER.DROWN_DPS * dt, 'drowning');
      }
    } else {
      this._drownTimer = 0;
    }
  }

  /** Past the suit's rating the diver's air spaces start to fail. */
  _updatePressure(dt) {
    const rated = this.suitDepthRating;
    const f = (this.depth - rated) / rated;
    if (f <= 0) return;
    const dps = Math.min(90, PLAYER.PRESSURE_DPS + 55 * f ** 1.6);
    this.damage(dps * dt, 'pressure');
  }

  _updateStamina(dt, input) {
    const sprintingOnLand = !this.swimming && this.grounded &&
      input.isDown(ACTION.SPRINT) && Math.hypot(this.velocity[0], this.velocity[2]) > 0.5 &&
      !this.exhausted && this.crouchBlend < 0.5;
    this._sprinting = sprintingOnLand;
    if (sprintingOnLand) {
      this.stamina = Math.max(0, this.stamina - PLAYER.STAMINA_SPRINT_DRAIN * 0.33 * dt);
      this._staminaTimer = 0;
    } else {
      this._staminaTimer += dt;
      if (this._staminaTimer > PLAYER.STAMINA_REGEN_DELAY) {
        const rate = this.state === PLAYER_STATE.TREADING
          ? PLAYER.STAMINA_REGEN * 1.33 : PLAYER.STAMINA_REGEN;
        this.stamina = Math.min(PLAYER.MAX_STAMINA, this.stamina + rate * dt);
      }
    }
    if (this.stamina <= 0 && !this.exhausted) {
      this.exhausted = true;
      events.emit(EVENTS.PLAYER_STAMINA_EMPTY, {});
    } else if (this.exhausted && this.stamina >= 25) {
      this.exhausted = false;
    }
  }

  _updateHealth(dt) {
    this._damageTimer += dt;
    // Soft-capped without treatment: a hurt player is nudged home, never
    // hard-blocked.
    //
    // THE `health < CAP` GUARD IS LOAD-BEARING, and it was missing. Written as a
    // bare `health = Math.min(CAP, health + rate*dt)` the line is not a
    // regeneration at all above the cap - it is an assignment DOWN to it. Every
    // player at full health lost exactly 30 HP the moment HEALTH_REGEN_DELAY
    // (12 s) elapsed without damage, which is the state the game starts in, the
    // state respawn() leaves, and the state heal() aims at. Measured: 100.0 ->
    // 70.0 in one step, silently, with no PLAYER_DAMAGE event, so nothing on the
    // HUD or in the event log could attribute it.
    if (this._damageTimer > PLAYER.HEALTH_REGEN_DELAY
        && this.health > 0 && this.health < HEALTH_REGEN_CAP) {
      this.health = Math.min(HEALTH_REGEN_CAP, this.health + PLAYER.HEALTH_REGEN_RATE * dt);
    }
  }

  /** @param {number} amount HP @param {string} source for the HUD and audio */
  damage(amount, source, direction = null) {
    if (!(amount > 0) || !this.alive) return;
    this.health = Math.max(0, this.health - amount);
    this._damageTimer = 0;
    events.emit(EVENTS.PLAYER_DAMAGE, { amount, source, direction });
    if (this.health <= 0) this._die(source);
  }

  heal(amount) {
    if (!(amount > 0) || !this.alive) return;
    this.health = Math.min(PLAYER.MAX_HEALTH, this.health + amount);
    events.emit(EVENTS.PLAYER_HEAL, { amount });
  }

  _die(cause) {
    this.alive = false;
    this.state = PLAYER_STATE.BLACKOUT;
    this._respawnTimer = 0;
    events.emit(EVENTS.PLAYER_DEATH, { cause, position: this.position });
  }

  /**
   * The blackout: the body keeps drifting on buoyancy and drag for the death
   * cam, then the respawn hands control back at the anchor.
   */
  _simulateBlackout(dt, time) {
    this._respawnTimer += dt;
    this._sampleWater(time);
    if (this.submergence > 0.5) {
      const drift = clamp(PLAYER.SWIM_BUOYANCY * (1 - this.depth / NEUTRAL_DEPTH),
        -MAX_SINK_DRIFT, PLAYER.SWIM_BUOYANCY);
      // Same water, same limits as _simulateSwim: drag toward the drift, capped
      // at SWIM_MAX_ACCEL. A body that dies falling and lands in the sea arrives
      // at the same 20 m/s a live diver does, and must not hit a wall either.
      for (let i = 0; i < 3; i++) {
        _accel[i] = -(this.velocity[i] - (i === 1 ? drift : 0)) * PLAYER.SWIM_DRAG;
      }
      const aMag = Math.hypot(_accel[0], _accel[1], _accel[2]);
      if (aMag > PLAYER.SWIM_MAX_ACCEL) {
        vec3.scale(_accel, _accel, PLAYER.SWIM_MAX_ACCEL / aMag);
      }
      for (let i = 0; i < 3; i++) this.velocity[i] += _accel[i] * dt;
    } else {
      this.velocity[1] -= WORLD.GRAVITY * dt;
    }
    this._body.height = this.currentHeight;
    this.contact.grounded = this.grounded;
    if (this.inHabitat && this.habitat?.playerInside) {
      this.habitat.resolvePlayer(this._body, dt, this.contact);
    } else {
      this.collision.resolveCapsule(this._body, dt, this.contact, this._time);
    }
    this.grounded = this.contact.grounded;

    if (this._respawnTimer >= 5.2) this.respawn();
  }

  /** Restore the player at the base anchor. Full health, full tank, no chill. */
  respawn(anchor = WORLD.BASE_POSITION) {
    this.inHabitat = false;
    if (this.habitat) this.habitat.playerInside = false;
    vec3.set(this.position, anchor[0], anchor[1], anchor[2]);
    // Snap to the actual ground: the anchor is authored, the terrain is not.
    this.position[1] = this.collision.footprintHeight(
      this.position[0], this.position[2], this.radius);
    vec3.zero(this.velocity);
    vec3.copy(this.prevPosition, this.position);
    this.health = PLAYER.MAX_HEALTH;
    this.oxygen = this.oxygenCapacity;
    this.stamina = PLAYER.MAX_STAMINA;
    this.alive = true;
    this.state = PLAYER_STATE.GROUNDED;
    this.grounded = true;
    this._drownTimer = 0;
    this._oxygenWarnTier = 0;
    this._damageTimer = PLAYER.HEALTH_REGEN_DELAY;
    events.emit(EVENTS.PLAYER_RESPAWN, { position: this.position });
  }

  /**
   * Move the diver instantly and completely, for the developer jump menu.
   *
   * Deliberately NOT built on respawn(): that one forces GROUNDED, snaps Y to
   * the footprint unconditionally (wrong for an eye hovering 6 m over the
   * abyssal plain), never touches the orientation at all, and emits
   * PLAYER_RESPAWN - a death event that must not fire because someone opened a
   * menu.
   *
   * EVERY FIELD BELOW HAS TO BE WRITTEN BY HAND, and the reason is on record.
   * A probe that wrote `position` and not `prevPosition` left the camera a
   * measured MEAN 447.71 m from the player, worst 670 m - permanently, not for
   * one frame, because applyCamera() lerps prevPosition -> position while only
   * simulate() ever refreshes prevPosition. The orientation has exactly the same
   * shape: the quaternion is rebuilt only inside simulate(), so the yaw/pitch
   * scalars, the quaternion AND both history slots must already agree before the
   * next frame draws.
   *
   * `position` is the FEET point, and it is ALIASED by this._body.position, so
   * it is written through vec3.set and never reassigned - rebinding the array
   * would detach the capsule from the collision solver silently.
   *
   * @param {number} x
   * @param {number} y  FEET height, absolute metres
   * @param {number} z
   * @param {number} yaw    compass heading in radians (0 = north, +PI/2 = east)
   * @param {number} pitch  radians, positive UP
   * @param {object} [opts]
   * @param {boolean} [opts.heal=true] restore health, oxygen and stamina
   * @param {number} [opts.time=0] world seconds, for the wave surface sample
   */
  teleport(x, y, z, yaw, pitch, opts = {}) {
    vec3.set(this.position, x, y, z);
    vec3.zero(this.velocity);
    vec3.copy(this.prevPosition, this.position);
    this.yaw = yaw;
    this.pitch = pitch;
    this.roll = 0;
    quat.fromEuler(this.orientation, yaw, pitch, 0);
    quat.copy(this.prevOrientation, this.orientation);

    // STANCE FIRST, because currentEyeHeight depends on crouchBlend and both the
    // medium latch below and teleport.js's deriveY are computed from it. Zeroing
    // it afterwards would silently raise the eye by up to 0.70 m
    // (EYE_HEIGHT 1.68 - CROUCH_EYE_HEIGHT 0.98) after the arrival had already
    // been placed - and _updateStance forces the crouch off while swimming
    // anyway, so the eye would drift up with no input.
    this.crouchBlend = 0;

    // THE MEDIUM LATCH. eyeSubmerged is hysteresed (+/-EYE_HYSTERESIS) and drives
    // the camera FOV, so a diver dropped 700 m down would render an AIR fov until
    // the next step re-latched it. Seed the latch from the raw test first, then
    // let _sampleWater fill in waterSurfaceY, submergence and depth against the
    // REAL wave surface - the sea is not a flat plane at y = 0, and hard-coding
    // one here would disagree with the solver on the very next step.
    this.eyeSubmerged = (y + this.currentEyeHeight) < 0;
    this._sampleWater(opts.time ?? 0);

    // DERIVE the state, do not assert it. Asserting GROUNDED whenever the eye is
    // dry put the player in PLAYER_STATE.GROUNDED at 123 m of altitude for one
    // step, with ground friction, ground acceleration and a live jump buffer. On
    // arrival we know the ground height, so ask.
    const feetClearance = y - this.collision.footprintHeight(x, z, this.radius);
    this.grounded = !this.eyeSubmerged && feetClearance < PLAYER.STEP_HEIGHT;
    this.walkable = true;
    if (this.eyeSubmerged) this.state = PLAYER_STATE.SWIM_FREE;
    else if (this.grounded) this.state = PLAYER_STATE.GROUNDED;
    else this.state = PLAYER_STATE.AIRBORNE;

    // LOCOMOTION FEEL, STANCE AND THE JUMP BUFFER. None of this is position, and
    // all of it survives a jump and is APPLIED BEFORE the first sim step:
    // applyCamera() transforms _bobOffset and adds it to the camera, so the first
    // frame at the destination is drawn with the departure's bob and landing dip;
    // a non-zero jumpBuffer fires a jump on arrival; and contact.material picks
    // the previous ground's grip and footstep for a step.
    this.coyoteTimer = 0;
    this.jumpBuffer = 0;
    this.jumpCooldown = 0;
    this.jumpHeld = false;
    this.stepPhase = 0;
    this._strokePhase = 0;
    this.strokeSurge = 0;
    this.bobIntensity = 0;
    this._landingDip = 0;
    this._landingDipVel = 0;
    this._rollInputTimer = 0;
    vec3.zero(this._bobOffset);

    // Survival timers. Arriving mid-drown or mid-pressure-damage would carry the
    // previous location's death into the new one, which reads as the jump
    // killing you.
    this._drownTimer = 0;
    this._oxygenWarnTier = 0;
    this._respawnTimer = 0;
    this._damageTimer = PLAYER.HEALTH_REGEN_DELAY;
    if (opts.heal !== false) {
      this.health = PLAYER.MAX_HEALTH;
      this.oxygen = this.oxygenCapacity;
      this.stamina = PLAYER.MAX_STAMINA;
      this.exhausted = false;
      this.alive = true;
    }
  }

  // -------------------------------------------------------------------------
  // Feel: bob, footsteps, camera
  // -------------------------------------------------------------------------

  _updateFeel(dt) {
    const speed = Math.hypot(this.velocity[0], this.velocity[2]);
    this.bobIntensity = this.grounded && !this.swimming
      ? saturate(speed / PLAYER.RUN_SPEED) : 0;

    // Step phase advances with DISTANCE, not time: the bob stays in sync at
    // any speed and stops dead the instant the player does.
    if (this.grounded && !this.swimming && speed > 0.15) {
      const stride = this.crouchBlend > 0.5 ? STRIDE_CROUCH
        : (speed > PLAYER.WALK_SPEED * 1.2 ? STRIDE_RUN : STRIDE_WALK);
      const before = this.stepPhase;
      this.stepPhase += (speed * dt) / stride * TAU;
      if (Math.floor(before / PI) !== Math.floor(this.stepPhase / PI)) {
        if (this._time - this._lastFootstep >= FOOTSTEP_MIN_INTERVAL) {
          this._lastFootstep = this._time;
          events.emit(EVENTS.PLAYER_FOOTSTEP, {
            material: MATERIAL_NAMES[this.contact.material],
            position: this.position,
            speed: saturate(speed / PLAYER.RUN_SPEED),
          });
        }
      }
      if (this.stepPhase > TAU * 1024) this.stepPhase %= TAU;
    }

    // Landing dip: a critically damped spring on the camera's Y offset.
    this._landingDipVel += (-180 * this._landingDip - 22 * this._landingDipVel) * dt;
    this._landingDip += this._landingDipVel * dt;
    if (Math.abs(this._landingDip) < 1e-5 && Math.abs(this._landingDipVel) < 1e-4) {
      this._landingDip = 0;
      this._landingDipVel = 0;
    }

    // Positional head bob. CameraRig contributes the ANGULAR component; this is
    // the translation, which has to be here because it depends on the stride.
    const motion = settings.get('headBob');
    const idx = this.crouchBlend > 0.5 ? 2 : (speed > PLAYER.WALK_SPEED * 1.2 ? 1 : 0);
    const amp = this.bobIntensity * motion;
    this._bobOffset[0] = BOB_X[idx] * amp * Math.sin(this.stepPhase * 0.5);
    this._bobOffset[1] = BOB_Y[idx] * amp * Math.abs(Math.sin(this.stepPhase)) + this._landingDip;
    this._bobOffset[2] = 0;

    if (this.swimming) {
      // Stroke surge and the idle breathing rise, phase-locked to the fins.
      //
      // This lunge is now the ONLY place the stroke is expressed, the thrust
      // having been made smooth so the diver tracks the keys. It carries the
      // pulse's own sharp shape rather than a sine, and STROKE_SURGE_THROW is
      // set so the travel stays what it was: the surge spans [-0.579, +1.429],
      // so 0.030 m gives 6.0 cm peak to peak against the sine's 5.6 cm. The
      // stroke therefore reads as hard as it ever did - harder, since the shape
      // is now the sharp one - while the velocity no longer moves with it.
      const ph = TAU * this._strokePhase;
      this._bobOffset[1] += (0.019 * Math.sin(ph + HALF_PI) + 0.011 * Math.sin(this._time * 1.5)) * motion;
      this._bobOffset[2] += STROKE_SURGE_THROW * this.strokeSurge * motion;
    }
  }

  /**
   * @param {import('../render/camera.js').Camera} camera
   * @param {number} alpha render interpolation factor in [0,1)
   */
  applyCamera(camera, alpha) {
    vec3.lerp(this._cameraPos, this.prevPosition, this.position, alpha);
    quat.slerp(this._cameraQuat, this.prevOrientation, this.orientation, alpha);
    quat.normalize(this._cameraQuat, this._cameraQuat);

    this._cameraPos[1] += this.currentEyeHeight;
    // Bob is in view space so it tilts with the head.
    vec3.transformQuat(_v, this._bobOffset, this._cameraQuat);
    vec3.add(camera.position, this._cameraPos, _v);
    camera.setOrientation(this._cameraQuat);
  }

  /**
   * The suit lamp, aimed where the player is looking.
   *
   * HELD IN A HAND, NOT STRAPPED TO THE TEMPLE. PLAYER_LAMP.mount is an offset
   * from the EYE in the player's own frame, and the argument for its size is on
   * that constant: a lamp beside the eye makes the light vector and the view
   * vector the same vector, every lit surface is shaded at its own N.V, and the
   * beam reads as a flash photograph - a bright decal with no form. The offset
   * is the only thing that lets the terrain's relief normals show shape.
   */
  submitLights(renderer) {
    if (!this.lampOn || this.inVessel) return;
    quat.forward(this._lightDir, this.orientation);
    vec3.copy(this._lightPos, this.position);
    this._lightPos[1] += this.currentEyeHeight;
    quat.right(_right, this.orientation);
    quat.up(_up, this.orientation);
    const m = PLAYER_LAMP.mount;
    vec3.scaleAndAdd(this._lightPos, this._lightPos, _right, m[0]);
    vec3.scaleAndAdd(this._lightPos, this._lightPos, _up, m[1]);
    vec3.scaleAndAdd(this._lightPos, this._lightPos, this._lightDir, -m[2]);

    renderer.addLight({
      position: this._lightPos,
      color: LAMP_COLOR,
      intensity: PLAYER_LAMP.intensity,
      range: PLAYER_LAMP.range,
      type: this.inHabitat ? 'interior' : 'spot',
      direction: this._lightDir,
      innerAngle: PLAYER_LAMP.coneInner,
      outerAngle: PLAYER_LAMP.cone,
      fill: PLAYER_LAMP.fill,
      fillPower: PLAYER_LAMP.fillPower,
      volumetric: PLAYER_LAMP.vol,
      falloff: PLAYER_LAMP.falloff,
    });
  }

  // -------------------------------------------------------------------------
  // Interaction and boarding
  // -------------------------------------------------------------------------

  _handleInteraction(input) {
    if (input.wasPressed(ACTION.FLASHLIGHT)) this.lampOn = !this.lampOn;
    // The station uses INTERACT rather than BOARD: the same airlock works while
    // the Kestrel remains parked outside, and boarding retains its dedicated
    // anti-frustration binding.
    if (this.habitat && input.wasPressed(ACTION.INTERACT)) {
      if (this.habitat.tryInteract(this)) return;
    }
    // Boarding is never blocked - not by damage, not by creature proximity.
    // The vessel is always a refuge (anti-frustration guarantee AF-10).
    if (this.vessel && input.wasPressed(ACTION.BOARD) && this.vessel.canBoard(this.position)) {
      this.enterVessel(this.vessel);
    }
  }

  enterVessel(vessel) {
    if (this.inVessel) return false;
    if (!vessel.board()) return false;
    this.inVessel = true;
    this.vessel = vessel;
    this.state = PLAYER_STATE.PILOTING;
    vec3.zero(this.velocity);
    return true;
  }

  /**
   * Leave the vessel. Underwater the player inherits the hull's velocity
   * (capped) and the oxygen clock starts immediately - stepping out at 300 m
   * should feel exactly as committing as it is.
   */
  exitVessel(vessel = this.vessel) {
    if (!this.inVessel || !vessel) return false;
    const underwater = vessel.underwater;
    // disembark() writes the FEET point, which is what `position` is. Dropping
    // it by the eye height here would bury the player under the terrain on land
    // and place them back inside the hull in the water.
    vessel.disembark(this.position);
    vec3.copy(this.prevPosition, this.position);
    vec3.copy(this.velocity, vessel.velocity);
    vec3.clampLen(this.velocity, this.velocity, 3.0);
    this.inVessel = false;
    this.state = underwater ? PLAYER_STATE.SWIM_FREE : PLAYER_STATE.AIRBORNE;
    this.eyeSubmerged = underwater;
    this.grounded = false;
    this._drownTimer = 0;
    this._oxygenWarnTier = 0;
    quat.copy(this.orientation, vessel.orientation);
    quat.toEuler(this.orientation, this);
    this.roll = 0;
    return true;
  }

  /** The vessel the boarding prompt should target. Set by the game each frame. */
  setVessel(vessel) { this.vessel = vessel; }
  /** The fixed station whose airlock can change the local movement medium. */
  setHabitat(habitat) { this.habitat = habitat; }

  // -------------------------------------------------------------------------
  // Upgrades and serialisation
  // -------------------------------------------------------------------------

  setOxygenTier(tier) {
    this.oxygenTier = clamp(tier | 0, 0, PLAYER.OXYGEN_TIERS.length - 1);
    const capacity = PLAYER.OXYGEN_TIERS[this.oxygenTier];
    // Keep the FRACTION when upgrading, so a swap never empties the tank.
    this.oxygen = (this.oxygen / this.oxygenCapacity) * capacity;
    this.oxygenCapacity = capacity;
  }

  setSuitTier(tier) {
    this.suitTier = clamp(tier | 0, 0, PLAYER.SUIT_DEPTH_TIERS.length - 1);
  }

  serialize() {
    return {
      position: Array.from(this.position),
      yaw: this.yaw, pitch: this.pitch,
      health: this.health,
      oxygen: this.oxygen,
      stamina: this.stamina,
      oxygenTier: this.oxygenTier,
      suitTier: this.suitTier,
      finTier: this.finTier,
      lampOn: this.lampOn,
    };
  }

  deserialize(s) {
    if (!s) return;
    this.position.set(s.position);
    vec3.copy(this.prevPosition, this.position);
    this.yaw = s.yaw;
    this.pitch = s.pitch;
    quat.fromEuler(this.orientation, this.yaw, this.pitch, 0);
    quat.copy(this.prevOrientation, this.orientation);
    this.setOxygenTier(s.oxygenTier);
    this.setSuitTier(s.suitTier);
    this.finTier = s.finTier | 0;
    this.health = s.health;
    this.oxygen = s.oxygen;
    this.stamina = s.stamina;
    this.lampOn = !!s.lampOn;
    this.alive = this.health > 0;
  }
}
