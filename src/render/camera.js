/**
 * SUBWAVE camera.
 *
 * Owns the view/projection matrices, the camera-relative world origin, TAA
 * jitter, and the frame-over-frame history the temporal passes need.
 *
 * CAMERA-RELATIVE RENDERING (important, and the reason this class is not
 * trivial): the world spans 6144 m horizontally and 1600 m vertically. At
 * absolute coordinates, float32 leaves roughly 0.25 mm of precision 3 km from
 * the origin - fine for a vertex position, but the ocean surface's wave
 * cascades and the depth reconstruction in post are differential quantities,
 * and they visibly jitter at that precision.
 *
 * So we render everything relative to a periodically-rebased origin: shaders
 * receive positions with `worldOrigin` already subtracted, keeping the values
 * the GPU actually works with near zero. `worldOrigin` moves in whole-metre
 * steps only, so rebasing never introduces sub-metre motion that TAA would
 * read as a scene change.
 */

import {
  mat4, vec3, quat, clamp, HALF_PI, halton23, wrapAngle,
  Frustum, degToRad, lerp,
} from '../core/math.js';
import { RENDER } from '../core/constants.js';

const TAA_SEQUENCE_LENGTH = 8;

export class Camera {
  constructor() {
    /** ABSOLUTE world position. The only place absolute coords are stored. */
    this.position = vec3.create(0, 4, 0);
    this.orientation = quat.create();

    /** Euler convenience for the first-person controllers. */
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    /** When true, orientation is authoritative and yaw/pitch/roll are ignored. */
    this.useQuaternion = false;

    this.fov = degToRad(75);
    this.aspect = 16 / 9;
    this.near = RENDER.NEAR_PLANE;

    // --- derived, rebuilt every frame ------------------------------------
    this.view = mat4.create();
    this.proj = mat4.create();               // jittered
    this.projUnjittered = mat4.create();
    this.viewProj = mat4.create();
    this.viewProjUnjittered = mat4.create();
    this.invView = mat4.create();
    this.invProj = mat4.create();
    this.invViewProj = mat4.create();

    this.forward = vec3.create(0, 0, -1);
    this.right = vec3.create(1, 0, 0);
    this.up = vec3.create(0, 1, 0);

    /** Camera position expressed in camera-relative space (tiny, near zero). */
    this.relativePosition = vec3.create();
    /** The absolute origin that camera-relative space is measured from. */
    this.worldOrigin = vec3.create();

    // --- history ---------------------------------------------------------
    this.prevViewProj = mat4.create();
    this.prevPosition = vec3.create();
    this.prevRelativePosition = vec3.create();
    this.prevWorldOrigin = vec3.create();
    this.speed = 0;
    this._hasHistory = false;

    // --- TAA -------------------------------------------------------------
    this.jitter = new Float32Array(2);
    this.prevJitter = new Float32Array(2);
    this.jitterEnabled = true;
    this._jitterIndex = 0;
    this._haltonScratch = new Float32Array(2);

    this.frustum = new Frustum();
    /**
     * The eye is sealed in a pressurised room below sea level - today, the
     * habitat. It does NOT override `isUnderwater`; see that getter. It is read
     * by the handful of things that are properties of the EYE rather than of the
     * frame: the depth grade, the underwater composite's own vignette, the lens
     * droplet latch, and which side of a window pane the medium lives on.
     */
    this.dryInterior = false;

    // Scratch to keep update() allocation-free.
    this._tmpTarget = vec3.create();
    this._tmpMat = mat4.create();
  }

  /** Set orientation from yaw/pitch/roll. Pitch is clamped to avoid gimbal flip. */
  setEuler(yaw, pitch, roll = 0) {
    this.yaw = wrapAngle(yaw);
    this.pitch = clamp(pitch, -HALF_PI + 0.001, HALF_PI - 0.001);
    this.roll = roll;
    this.useQuaternion = false;
  }

  /** Set orientation directly. Used by the vessel, which can loop and bank. */
  setOrientation(q) {
    quat.copy(this.orientation, q);
    this.useQuaternion = true;
  }

  /**
   * Rebuild every derived matrix.
   * Call once per frame AFTER all movement, BEFORE any pass reads the camera.
   *
   * @param {number} width  render target width in pixels
   * @param {number} height render target height in pixels
   * @param {number} dt     seconds since the previous update (for speed)
   */
  update(width, height, dt) {
    // --- history snapshot (before anything changes) ----------------------
    if (this._hasHistory) {
      mat4.copy(this.prevViewProj, this.viewProjUnjittered);
      vec3.copy(this.prevPosition, this.position);
      vec3.copy(this.prevWorldOrigin, this.worldOrigin);
      this.prevJitter[0] = this.jitter[0];
      this.prevJitter[1] = this.jitter[1];
    }

    this.aspect = width / Math.max(1, height);

    // --- orientation basis ----------------------------------------------
    if (this.useQuaternion) {
      quat.forward(this.forward, this.orientation);
      quat.right(this.right, this.orientation);
      quat.up(this.up, this.orientation);
    } else {
      quat.fromEuler(this.orientation, this.yaw, this.pitch, this.roll);
      quat.forward(this.forward, this.orientation);
      quat.right(this.right, this.orientation);
      quat.up(this.up, this.orientation);
    }

    // --- origin rebasing --------------------------------------------------
    // Rebase in whole metres so the shift is exactly representable and cannot
    // introduce sub-pixel motion that TAA would misread as scene movement.
    const dx = this.position[0] - this.worldOrigin[0];
    const dz = this.position[2] - this.worldOrigin[2];
    const dy = this.position[1] - this.worldOrigin[1];
    const r = RENDER.REBASE_RADIUS;
    if (Math.abs(dx) > r || Math.abs(dz) > r || Math.abs(dy) > r) {
      this.worldOrigin[0] = Math.round(this.position[0]);
      this.worldOrigin[1] = Math.round(this.position[1]);
      this.worldOrigin[2] = Math.round(this.position[2]);
    }

    vec3.sub(this.relativePosition, this.position, this.worldOrigin);
    // Express the PREVIOUS position in the CURRENT origin's space, so motion
    // vectors stay correct across a rebase frame.
    vec3.sub(this.prevRelativePosition, this.prevPosition, this.worldOrigin);

    // --- speed (for FOV kick, audio doppler, motion blur) ----------------
    if (dt > 0 && this._hasHistory) {
      const moved = vec3.dist(this.position, this.prevPosition);
      // Smooth so a single hitched frame does not spike the FOV.
      this.speed = lerp(this.speed, moved / dt, 0.35);
    }

    // --- view matrix ------------------------------------------------------
    // Built in camera-relative space: the eye is at `relativePosition`.
    vec3.add(this._tmpTarget, this.relativePosition, this.forward);
    mat4.lookAt(this.view, this.relativePosition, this._tmpTarget, this.up);

    // --- projection (reverse-Z, infinite far) ----------------------------
    mat4.perspectiveReverseZInfinite(this.projUnjittered, this.fov, this.aspect, this.near);

    if (this.jitterEnabled) {
      this._jitterIndex = (this._jitterIndex + 1) % TAA_SEQUENCE_LENGTH;
      halton23(this._jitterIndex + 1, this._haltonScratch);
      // Halton gives [0,1); centre it and convert to NDC units (2/resolution).
      this.jitter[0] = ((this._haltonScratch[0] - 0.5) * 2.0) / width * RENDER.TAA_JITTER_SCALE;
      this.jitter[1] = ((this._haltonScratch[1] - 0.5) * 2.0) / height * RENDER.TAA_JITTER_SCALE;
      mat4.applyJitter(this.proj, this.projUnjittered, this.jitter[0], this.jitter[1]);
    } else {
      this.jitter[0] = 0;
      this.jitter[1] = 0;
      mat4.copy(this.proj, this.projUnjittered);
    }

    // --- composites -------------------------------------------------------
    mat4.multiply(this.viewProj, this.proj, this.view);
    mat4.multiply(this.viewProjUnjittered, this.projUnjittered, this.view);
    mat4.invertRigid(this.invView, this.view);
    mat4.invert(this.invProj, this.proj);
    mat4.invert(this.invViewProj, this.viewProj);

    // Cull against the UNJITTERED frustum - jitter is a sub-pixel offset and
    // culling against it would cause objects to pop at the screen edge.
    this.frustum.fromViewProj(this.viewProjUnjittered);

    if (!this._hasHistory) {
      // First frame: history == current, so velocities are zero rather than garbage.
      mat4.copy(this.prevViewProj, this.viewProjUnjittered);
      vec3.copy(this.prevPosition, this.position);
      vec3.copy(this.prevWorldOrigin, this.worldOrigin);
      vec3.copy(this.prevRelativePosition, this.relativePosition);
      this.prevJitter[0] = this.jitter[0];
      this.prevJitter[1] = this.jitter[1];
      this._hasHistory = true;
    }
  }

  /**
   * Convert an absolute world position into the camera-relative space the
   * shaders expect. Every draw call that submits world geometry must do this.
   */
  toRelative(out, absolutePos) {
    return vec3.sub(out, absolutePos, this.worldOrigin);
  }

  toAbsolute(out, relativePos) {
    return vec3.add(out, relativePos, this.worldOrigin);
  }

  /** Frustum test for an absolute-space sphere. */
  isSphereVisible(centerAbs, radius) {
    return this.frustum.containsSphere(
      centerAbs[0] - this.worldOrigin[0],
      centerAbs[1] - this.worldOrigin[1],
      centerAbs[2] - this.worldOrigin[2],
      radius,
    );
  }

  /** Frustum test for an absolute-space AABB given as min/max components. */
  isBoxVisible(minX, minY, minZ, maxX, maxY, maxZ) {
    const o = this.worldOrigin;
    return this.frustum.containsBoxMinMax(
      minX - o[0], minY - o[1], minZ - o[2],
      maxX - o[0], maxY - o[1], maxZ - o[2],
    );
  }

  /** Depth below the sea surface, positive when submerged. */
  get depth() { return Math.max(0, -this.position[1]); }
  /**
   * IN THE WATER, WHICH IS NOT THE SAME QUESTION AS "IS THE AIR AROUND ME WET".
   *
   * This used to read `y < 0 && !this.dryInterior`, and that single `&&` broke
   * FIVE separate contracts the instant a player stepped into the habitat,
   * because this flag is what decides WHO OWNS THE MEDIUM:
   *
   *   1. passes/underwater.js disables the fullscreen composite entirely (the
   *      station is 33 m down, far outside the waterline band).
   *   2. So applyViewRayWater() takes ownership back - and computes it against a
   *      camera the Frame uniform now claims is in AIR at -33 m. `eyeAbove` is
   *      max(-33.25, 0) = 0, so the whole outside view ray is fogged with the
   *      in-scatter and the deep tint evaluated at DEPTH ZERO: full surface
   *      irradiance, which is the milky white-out reported from play.
   *   3. waterSightDensity() returns 1.0 instead of Sand Plains' 0.30, so
   *      sigma_t AND sigma_s outside the windows are 3.33x too high.
   *   4. froxelOwnsBeam() goes false while FLAG_VOLUMETRICS_ON is still set, so
   *      the geometry shaders add the analytic collimated beam and the volume
   *      adds its own: the sun is counted TWICE.
   *   5. waterPathLength(dist, 0, dirY) returns 0 for any UPWARD ray, so looking
   *      up out of the dome was perfectly clear while looking level was behind
   *      the over-dense veil - a hard split across one frame.
   *
   * The camera inside a pressure hull IS in the water. It merely has a dry
   * bubble around it, and that bubble is expressed PER PIXEL by the `dryPath`
   * render target, which carries the signed sum of hull crossings in front of
   * the eye. `dryInterior` survives as the eye's own medium and nothing else.
   */
  get isUnderwater() { return this.position[1] < 0; }

  /** tan(fovY/2), which the shaders use to rebuild view rays. */
  get tanHalfFov() { return Math.tan(this.fov * 0.5); }

  /** Reset history so the next frame produces no motion vectors. Use after a teleport. */
  resetHistory() {
    this._hasHistory = false;
    this.speed = 0;
  }
}

/**
 * Camera rig: applies smoothed follow, shake and FOV kick on top of a target
 * transform. The player and vessel controllers set the target; this produces
 * the final camera state.
 *
 * Shake is deliberately additive in ANGLE, not position: translating the camera
 * inside a cockpit clips through the canopy, whereas angular shake reads as the
 * whole vehicle being hit and never breaks the geometry.
 */
export class CameraRig {
  constructor(camera) {
    this.camera = camera;

    this.baseFov = degToRad(75);
    this.targetFov = this.baseFov;
    this.fovKickScale = 1.0;
    this.fovSmoothing = 6.0;

    /** Active shake sources, each {amplitude, frequency, decay, elapsed, seed}. */
    this.shakes = [];
    this.shakeScale = 1.0;
    this._shakeAngles = new Float32Array(3);

    /** Head bob, for on-foot movement. */
    this.bobScale = 1.0;
    this._bobPhase = 0;
    this._bobAmount = 0;

    this._tmp = vec3.create();
  }

  /**
   * @param {number} amplitude radians of peak angular displacement
   * @param {number} frequency Hz
   * @param {number} duration  seconds to decay to zero
   */
  addShake(amplitude, frequency, duration) {
    if (this.shakeScale <= 0) return;
    this.shakes.push({
      amplitude, frequency,
      decay: 1 / Math.max(duration, 0.01),
      elapsed: 0,
      seed: Math.random() * 1000,
    });
    // Cap concurrent shakes; beyond a handful they just average into mush.
    if (this.shakes.length > 8) this.shakes.shift();
  }

  /** Impact shake scaled by collision speed. */
  addImpact(speed) {
    const a = clamp(speed / 40, 0.02, 1.0);
    this.addShake(a * 0.09, 22, 0.45 + a * 0.35);
  }

  /** Continuous low rumble, e.g. from thrusters or a nearby leviathan. */
  setRumble(intensity) {
    this._rumble = clamp(intensity, 0, 1);
  }

  /** Advance bob for on-foot locomotion. `speed01` is 0..1 of run speed. */
  updateBob(dt, speed01, grounded) {
    if (!grounded || this.bobScale <= 0) {
      this._bobAmount = lerp(this._bobAmount, 0, 1 - Math.exp(-8 * dt));
      return;
    }
    this._bobPhase += dt * (7.0 + speed01 * 5.0);
    this._bobAmount = lerp(this._bobAmount, speed01 * this.bobScale, 1 - Math.exp(-6 * dt));
  }

  /**
   * Apply rig effects to the camera. Call after the camera's position and
   * orientation are set but BEFORE camera.update().
   */
  apply(dt) {
    const cam = this.camera;

    // --- FOV ------------------------------------------------------------
    const speedKick = clamp(cam.speed / 60, 0, 1) * degToRad(11) * this.fovKickScale;
    const desired = this.targetFov + speedKick;
    cam.fov = lerp(cam.fov, desired, 1 - Math.exp(-this.fovSmoothing * dt));

    // --- shake ----------------------------------------------------------
    let sx = 0, sy = 0, sz = 0;
    for (let i = this.shakes.length - 1; i >= 0; i--) {
      const s = this.shakes[i];
      s.elapsed += dt;
      const life = 1 - s.elapsed * s.decay;
      if (life <= 0) { this.shakes.splice(i, 1); continue; }
      // Squared falloff feels like a real impact: sharp onset, long tail.
      const env = life * life * s.amplitude * this.shakeScale;
      const t = s.elapsed * s.frequency * 6.28318;
      sx += Math.sin(t + s.seed) * env;
      sy += Math.sin(t * 1.37 + s.seed * 2.1) * env;
      sz += Math.sin(t * 0.83 + s.seed * 3.7) * env * 0.6;
    }

    if (this._rumble > 0) {
      const t = performance.now() * 0.001;
      const r = this._rumble * 0.004 * this.shakeScale;
      sx += Math.sin(t * 31.7) * r;
      sy += Math.sin(t * 27.1) * r;
    }

    // --- head bob -------------------------------------------------------
    if (this._bobAmount > 0.001) {
      const b = this._bobAmount;
      sy += Math.sin(this._bobPhase) * 0.012 * b;
      sx += Math.sin(this._bobPhase * 0.5) * 0.008 * b;
      sz += Math.sin(this._bobPhase * 0.5) * 0.010 * b;
    }

    this._shakeAngles[0] = sx;
    this._shakeAngles[1] = sy;
    this._shakeAngles[2] = sz;

    if (sx !== 0 || sy !== 0 || sz !== 0) {
      if (cam.useQuaternion) {
        quat.rotateX(cam.orientation, cam.orientation, sx);
        quat.rotateY(cam.orientation, cam.orientation, sy);
        quat.rotateZ(cam.orientation, cam.orientation, sz);
      } else {
        cam.pitch = clamp(cam.pitch + sx, -HALF_PI + 0.001, HALF_PI - 0.001);
        cam.yaw += sy;
        cam.roll += sz;
      }
    }
  }
}
