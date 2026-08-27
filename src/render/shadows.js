/**
 * SUBWAVE cascaded sun shadows - the PRODUCER half.
 *
 * shaders/common/shadow.wgsl is the consumer and it is the contract. This file
 * fits the cascades, writes `renderer.shadowMatrices`, and runs one depth-only
 * render pass per cascade into a layer of `shadowAtlas`. Everything the receiver
 * knows about the fit it recovers from the matrix itself (texel world size from
 * |row0|, NDC-per-metre from |row2|), so there is exactly one number that has to
 * agree across the boundary and it is the matrix.
 *
 * REVERSE-Z, like the rest of the renderer. The ortho's near plane faces the
 * sun, so cascade NDC z is 1 at the light and 0 at the far end; the atlas clears
 * to 0.0 and the caster pipelines compare 'greater'. A ZERO matrix is the
 * documented "this cascade is off" state - it makes clip.w 0 and the receiver
 * early-outs to fully lit - which is why every path that declines to draw zeroes
 * rather than leaving stale data.
 *
 * ---------------------------------------------------------------------------
 * WHY A BOUNDING SPHERE, AND WHY IT IS SNAPPED IN ABSOLUTE SPACE
 *
 * The fit is the bounding SPHERE of the camera frustum slice, not an AABB of its
 * corners. A sphere is invariant under camera ROTATION, so the cascade's extent
 * does not breathe as the player looks around - and because the extent is
 * constant, the ortho centre can be snapped to a whole number of shadow texels,
 * which is what stops the shadow edges from crawling as the camera translates.
 * A corner AABB is up to 30% tighter and shimmers on every mouse movement, which
 * is far worse than the resolution it buys. Do not "optimise" it.
 *
 * The snap is computed in ABSOLUTE world coordinates and only then rebased
 * against camera.worldOrigin. Snapping the camera-relative centre would anchor
 * the texel lattice to the origin, and the origin jumps in whole metres every
 * REBASE_RADIUS - which is not a whole number of texels, so every rebase would
 * shift the entire shadow lattice and flash the whole screen.
 *
 * ---------------------------------------------------------------------------
 * THE OCEAN SURFACE MUST NEVER BECOME A CASTER.
 *
 * Water refracts light, it does not block it, and that refraction is already
 * modelled: lighting.wgsl multiplies the sun by refractedIlluminance() and by
 * causticFactor() before the shadow term. Rendering the wave mesh into
 * the atlas would put the ENTIRE seabed in shadow and delete the caustics with
 * it, because a caustic is focused direct sun and is extinguished wherever the
 * beam is blocked. If the flat-looking sea ever needs fixing, the fix is to make
 * the surface a shadow RECEIVER, never a caster.
 */

import { mat4 } from '../core/math.js';
import { RENDER } from '../core/constants.js';
import { depthAttachment } from '../core/pipelines.js';
import { profiler } from '../core/profiler.js';

const ZERO = new Float32Array(3);
const UP = new Float32Array([0, 1, 0]);
/** Metres of slack on the far (down-sun) plane, paying back the 1 m depth snap. */
const DEPTH_SNAP_SLACK = 1;

/**
 * Fits the sun shadow cascades and renders the atlas.
 *
 * Casters opt in by exposing two methods on their frame-graph pass:
 *   `beginShadowFrame(ctx, shadows)`  once per frame, before any cascade
 *   `castShadows(ctx, renderPass, cascade, shadows) -> drawCount`
 * Both are optional; a pass with neither simply casts nothing.
 */
export class ShadowSystem {
  /**
   * @param {import('./renderer.js').Renderer} renderer
   * @param {object} game the Game instance, for the caster passes and env
   */
  constructor(renderer, game) {
    this.renderer = renderer;
    this.game = game;

    const preset = renderer.gpu.preset;
    /** Cascades actually rendered. Mirrors shadowCascadeCount() in shadow.wgsl. */
    this.count = Math.max(1, Math.min(preset.shadowCascades, RENDER.SHADOW_CASCADES));
    this.resolution = preset.shadowResolution;

    /** Light basis, a PURE ROTATION so the x/y texel snap is separable. */
    this.lightView = new Float32Array(16);
    /** Light-space x axis in world space (row 0 of lightView). */
    this.lightRight = new Float32Array(3);
    /** Light-space y axis in world space (row 1 of lightView). */
    this.lightUp = new Float32Array(3);
    /**
     * Light-space z axis in world space. lookAt's row 2 is -forward, and the
     * light camera looks along -sunDir, so this is exactly +sunDir: the
     * light-space z of a point is dot(p, sunDir), no matrix multiply needed.
     */
    this.lightDir = new Float32Array(3);

    this._ortho = new Float32Array(16);
    this._negSun = new Float32Array(3);

    /**
     * Per-cascade fit, in the units the culling wants: ABSOLUTE light-space
     * bounds, so a caster is tested without ever building a matrix.
     */
    this.cascades = [];
    for (let i = 0; i < this.count; i++) {
      this.cascades.push({
        index: i, active: false,
        near: 0, far: 0, radius: 0, texel: 0, half: 0, depthRange: 0,
        // The ADOPTED fit, in absolute light-space coordinates. Held across
        // frames on which this cascade is not re-rendered, so the matrix keeps
        // pointing at the pixels the atlas actually holds. `fitRadius` is
        // `radius` plus the cadence pad and is what the ortho is sized to.
        snapX: NaN, snapY: NaN, snapZ: NaN, fitRadius: -1,
        // Absolute light-space slab this cascade rasterises.
        xMin: 0, xMax: 0, yMin: 0, yMax: 0, zMin: 0, zMax: 0,
        // Absolute world centre of the sphere, for the underwater gate.
        centreY: 0,
        /** Redrawn this frame? */
        render: false,
        lastRenderFrame: -1000,
        draws: 0,
      });
    }

    /** Published for probe.mjs; the fit is otherwise invisible from outside. */
    this.stats = {
      active: false, sunElevationDeg: 0, cascades: this.cascades,
      totalDraws: 0,
    };

    /** Scratch for projectBox(): [cx, cy, cz, rx, ry, rz] in light space. */
    this._box = new Float64Array(6);
  }

  // -------------------------------------------------------------------------
  // Queries the caster passes use
  // -------------------------------------------------------------------------

  /**
   * Project an ABSOLUTE world AABB onto the light basis.
   *
   * Returns the SAME scratch array every call - consume it before the next call.
   * Computing this once per caster and testing it against all four cascades is
   * what keeps the terrain's 3,293-chunk sweep under a tenth of a millisecond.
   *
   * @returns {Float64Array} [centreX, centreY, centreZ, radX, radY, radZ] in light space
   */
  projectBox(minX, minY, minZ, maxX, maxY, maxZ) {
    const s = this.lightRight, u = this.lightUp, d = this.lightDir;
    const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5;
    const ex = (maxX - minX) * 0.5, ey = (maxY - minY) * 0.5, ez = (maxZ - minZ) * 0.5;
    const b = this._box;
    b[0] = cx * s[0] + cy * s[1] + cz * s[2];
    b[1] = cx * u[0] + cy * u[1] + cz * u[2];
    b[2] = cx * d[0] + cy * d[1] + cz * d[2];
    b[3] = ex * Math.abs(s[0]) + ey * Math.abs(s[1]) + ez * Math.abs(s[2]);
    b[4] = ex * Math.abs(u[0]) + ey * Math.abs(u[1]) + ez * Math.abs(u[2]);
    b[5] = ex * Math.abs(d[0]) + ey * Math.abs(d[1]) + ez * Math.abs(d[2]);
    return b;
  }

  /**
   * Does a box already projected by projectBox() overlap cascade `i`'s volume?
   * @param {number} i cascade index
   * @param {ArrayLike<number>} b the projectBox() result
   */
  boxCasts(i, b) {
    const c = this.cascades[i];
    if (!c.active) return false;
    return b[0] + b[3] >= c.xMin && b[0] - b[3] <= c.xMax
        && b[1] + b[4] >= c.yMin && b[1] - b[4] <= c.yMax
        && b[2] + b[5] >= c.zMin && b[2] - b[5] <= c.zMax;
  }

  /**
   * Sphere-vs-cascade test for a moving caster, in ABSOLUTE coordinates.
   *
   * Deliberately NOT camera.isSphereVisible: cascade 0's sphere reaches behind
   * the camera and well outside the frustum laterally, and a caster the eye
   * cannot see is exactly the one whose shadow the eye CAN.
   */
  sphereCasts(i, centre, radius) {
    const c = this.cascades[i];
    if (!c.active) return false;
    const s = this.lightRight, u = this.lightUp, d = this.lightDir;
    const x = centre[0] * s[0] + centre[1] * s[1] + centre[2] * s[2];
    const y = centre[0] * u[0] + centre[1] * u[1] + centre[2] * u[2];
    const z = centre[0] * d[0] + centre[1] * d[1] + centre[2] * d[2];
    return x + radius >= c.xMin && x - radius <= c.xMax
        && y + radius >= c.yMin && y - radius <= c.yMax
        && z + radius >= c.zMin && z - radius <= c.zMax;
  }

  /**
   * Smallest caster diameter, metres, whose shadow survives the receiver's PCF
   * kernel in cascade `i`. Anything narrower is filtered away to nothing, so
   * drawing it is pure cost.
   *
   * The radii mirror sampleShadowPCF()'s `select(1.5, 2.5, cascade < 2u)`.
   */
  minCasterSize(i) {
    const c = this.cascades[i];
    const pcfTexels = i < 2 ? 2.5 : 1.5;
    return RENDER.SHADOW_MIN_CASTER_TEXELS * pcfTexels * c.texel;
  }

  // -------------------------------------------------------------------------
  // Fit
  // -------------------------------------------------------------------------

  /** Fraction of SHADOW_FAR at which cascade `i` ends. Mirrors shadow.wgsl. */
  _splitFraction(i) {
    // A tier running fewer cascades drops the NEAREST splits, keeping the
    // trailing 1.0 so the last cascade always reaches the far distance.
    return RENDER.SHADOW_SPLITS[i + (RENDER.SHADOW_CASCADES - this.count)];
  }

  /**
   * Fit every cascade for this frame and write renderer.shadowMatrices.
   * @returns {boolean} false when the sun cannot cast and everything was zeroed
   */
  _fit(ctx) {
    const r = this.renderer;
    const env = r.env;
    const camera = ctx.camera;
    const sun = env.sunDir;

    // The same gate evalSun() uses, plus the night gate the Frame uniform uses.
    // Zero is the documented "off" state, not a fallback.
    if (sun[1] <= -0.05 || env.sunIntensity < 0.02) {
      r.shadowMatrices.fill(0);
      r.uploadShadowMatrices();
      for (const c of this.cascades) { c.active = false; c.draws = 0; }
      this.stats.active = false;
      this.stats.totalDraws = 0;
      return false;
    }

    // ---- light basis ------------------------------------------------------
    // Eye at the relative origin: the rotation is all that matters, and putting
    // the eye anywhere else would only add a translation the ortho re-centres
    // away. lookAt() handles the sun-overhead degeneracy via anyPerpendicular,
    // where the basis would flip discontinuously and jump the whole shadow map
    // for one frame. MEASURED over 20,000 samples of a full WorldClock day, the
    // sun peaks at 77.97 degrees at dayFraction 0.5, so it never comes within
    // twelve degrees of the singularity and that branch cannot be reached.
    this._negSun[0] = -sun[0]; this._negSun[1] = -sun[1]; this._negSun[2] = -sun[2];
    const V = this.lightView;
    mat4.lookAt(V, ZERO, this._negSun, UP);
    this.lightRight[0] = V[0]; this.lightRight[1] = V[4]; this.lightRight[2] = V[8];
    this.lightUp[0] = V[1]; this.lightUp[1] = V[5]; this.lightUp[2] = V[9];
    this.lightDir[0] = V[2]; this.lightDir[1] = V[6]; this.lightDir[2] = V[10];

    const s = this.lightRight, u = this.lightUp, d = this.lightDir;
    const origin = camera.worldOrigin;
    const ox = origin[0] * s[0] + origin[1] * s[1] + origin[2] * s[2];
    const oy = origin[0] * u[0] + origin[1] * u[1] + origin[2] * u[2];
    const oz = origin[0] * d[0] + origin[1] * d[1] + origin[2] * d[2];

    // The fit scales linearly with the frustum's corner slope, and the FOV is
    // NOT constant - the vessel's speed kick drives it, and CameraRig lerps
    // toward its target with 1 - exp(-6 dt), which never lands twice on the same
    // float. Reading it live is not optional; QUANTISING it is not either.
    //
    // The cadence below only holds a cascade when its fitted radius REPEATS, so
    // an f32 wobble in the last ulp of the FOV re-fits every cascade every
    // frame. MEASURED without this: standing perfectly still, cascades 2 and 3
    // re-rendered on 97% and 96% of frames instead of 50% and 25%. Rounding the
    // corner slope UP to 1/256 makes the fit reproducible while only ever
    // growing the sphere, by at most 0.4%.
    const ty = Math.tan(camera.fov * 0.5);
    const tx = ty * camera.aspect;
    const k = Math.ceil(Math.sqrt(tx * tx + ty * ty) * 256) / 256;
    const k2 = k * k;

    const RES = this.resolution;
    const GUARD = RENDER.SHADOW_FIT_GUARD_TEXELS;
    const EXT = RENDER.SHADOW_CASTER_EXTRUSION;
    const CUTOFF = RENDER.SHADOW_UNDERWATER_CUTOFF;
    const frameIndex = ctx.frameIndex;

    let anyActive = false;
    for (let i = 0; i < this.count; i++) {
      const c = this.cascades[i];
      c.draws = 0;
      const near = i === 0 ? 0 : RENDER.SHADOW_FAR * this._splitFraction(i - 1);
      const far = RENDER.SHADOW_FAR * this._splitFraction(i);
      c.near = near;
      c.far = far;

      // ---- bounding sphere of the frustum slice ---------------------------
      // Centre on the view axis at zc, equidistant from the near and far
      // corners: 2*zc*(f-n) = (f^2-n^2)(1+k2). When that puts zc past the far
      // plane the near corners are already inside the far corners' sphere, so
      // the far plane alone bounds the slice.
      let zc, radius;
      if (k2 * (far + near) >= far - near) {
        zc = far;
        radius = far * Math.sqrt(k2);
      } else {
        zc = 0.5 * (far + near) * (1 + k2);
        radius = 0.5 * Math.sqrt((far - near) * (far - near)
          + 2 * (far * far + near * near) * k2
          + (far + near) * (far + near) * k2 * k2);
      }

      const cxAbs0 = camera.position[0] + camera.forward[0] * zc;
      const cyAbs0 = camera.position[1] + camera.forward[1] * zc;
      const czAbs0 = camera.position[2] + camera.forward[2] * zc;
      c.centreY = cyAbs0;

      // ---- underwater gate ------------------------------------------------
      // underwaterShadowStrength() has faded the shadow to nothing by
      // SHADOW_UNDERWATER_CUTOFF, so a cascade whose SHALLOWEST point is deeper
      // than that cannot change a single pixel. Correct by construction, and it
      // costs one compare.
      //
      // THIS GATE AND THAT FADE ARE ONE NUMBER, not two that happen to agree.
      // renderer.js publishes CUTOFF to the preprocessor as SHADOW_UW_CUTOFF
      // and water.wgsl's smoothstep reads it, so raising the gate can no longer
      // arm caster chains whose output the receiver multiplies by zero.
      //
      // BUT THE GATE IS STILL WEAKER THAN IT LOOKS, and anyone raising CUTOFF
      // has to know it: the test is on the cascade's SHALLOWEST point, and
      // cascade 3 is fitted to a 613 m radius, so its shallowest point sits in
      // the 95-260 m band while the EYE and every receiver in the frame are
      // kilometres deeper. MEASURED caster draws at 95 vs 260: Boulder Field
      // 620 -> 620 (already above the gate), Shelf Break 485 -> 655, Twilight
      // Terraces 475 -> 646, but also Rock Spires 309 -> 534 and Canyon Wall
      // 0 -> 315, and those last two are at 365 m and 505 m where the fade is
      // exactly 0 - pure cost, zero pixels. A gate that also tested the
      // cascade's DEEPEST point, or simply the camera depth, would not do that.
      // It is left alone because at 95 m the case never arises.
      if (-(cyAbs0 + radius) > CUTOFF) {
        c.active = false;
        c.render = false;
        c.fitRadius = -1;
        r.shadowMatrices.fill(0, i * 16, i * 16 + 16);
        continue;
      }

      // ---- update cadence -------------------------------------------------
      // A cascade held for N frames must keep covering a frustum slice that is
      // still moving, so the sphere it is FITTED to is the geometric one padded
      // by the camera's own travel over that window. Translation is bounded by
      // Vne; rotation is not, so the containment test below is what actually
      // guarantees coverage and the pad only stops a slow walk from dirtying
      // every cascade every frame.
      const interval = RENDER.SHADOW_UPDATE_INTERVALS[
        Math.min(i, RENDER.SHADOW_UPDATE_INTERVALS.length - 1)];
      const fitRadius = radius + (interval - 1) * RENDER.SHADOW_CADENCE_PAD;

      // ---- texel snap, in ABSOLUTE space ----------------------------------
      // The sphere occupies RES - 2*GUARD texels; `half` is then texel * RES/2,
      // an exact multiple of the texel, so the layer's whole footprint lands on
      // the same world lattice and the snap cannot slide it.
      const texel = 2 * fitRadius / (RES - 2 * GUARD);
      const half = texel * RES * 0.5;

      const lx = cxAbs0 * s[0] + cyAbs0 * s[1] + czAbs0 * s[2];
      const ly = cxAbs0 * u[0] + cyAbs0 * u[1] + czAbs0 * u[2];
      const lz = cxAbs0 * d[0] + cyAbs0 * d[1] + czAbs0 * d[2];

      // Adopt a new fit when the held one has expired, when the projection
      // changed under us (the FOV moves with speed), or when this frame's slice
      // no longer fits inside the one the atlas actually holds. Otherwise keep
      // the adopted snap: the layer already contains exactly the right pixels
      // for exactly this matrix, so redrawing would reproduce the same image.
      // What the hold DOES defer is streaming terrain and the scatter sway,
      // and that is what the interval caps.
      const held = c.active && c.fitRadius === fitRadius
        && frameIndex - c.lastRenderFrame < interval
        && Math.abs(lx - c.snapX) + radius <= c.half
        && Math.abs(ly - c.snapY) + radius <= c.half
        && Math.abs(lz - c.snapZ) + radius <= c.fitRadius + DEPTH_SNAP_SLACK;

      if (!held) {
        c.snapX = Math.floor(lx / texel) * texel;
        c.snapY = Math.floor(ly / texel) * texel;
        // Depth is snapped to whole METRES, not texels: the ortho range is
        // 2R + EXT + 1 whatever the snap is, so this only decides where the
        // slab sits, and a metre is far below the constant bias it perturbs.
        c.snapZ = Math.floor(lz);
        c.radius = radius; c.fitRadius = fitRadius; c.texel = texel; c.half = half;
        c.render = true;
        c.lastRenderFrame = frameIndex;
      } else {
        c.render = false;
      }
      const snapX = c.snapX, snapY = c.snapY, snapZ = c.snapZ;
      const R = c.fitRadius, H = c.half;

      c.xMin = snapX - H; c.xMax = snapX + H;
      c.yMin = snapY - H; c.yMax = snapY + H;
      c.zMin = snapZ - R - DEPTH_SNAP_SLACK;
      c.zMax = snapZ + R + EXT;
      c.depthRange = c.zMax - c.zMin;
      c.active = true;
      anyActive = true;

      // ---- matrix ---------------------------------------------------------
      // Rebuilt EVERY frame even when the atlas is not, because the matrix is
      // camera-relative and worldOrigin rebases in whole metres - which is not
      // a whole number of texels. Rebuilding from the adopted ABSOLUTE snap is
      // what makes a rebase invisible.
      const rx = snapX - ox, ry = snapY - oy, rz = snapZ - oz;
      // orthoReverseZ takes POSITIVE distances along -view z. A point's view z
      // is dot(p, sunDir), so the plane nearest the light (clip.z = 1) is the
      // one HIGHEST toward the sun and its ortho `near` is -(rz + radius + EXT).
      // That is routinely negative, which is meaningless for a perspective
      // frustum and perfectly ordinary for an orthographic one.
      mat4.orthoReverseZ(this._ortho,
        rx - half, rx + half, ry - half, ry + half,
        -rz - radius - EXT, -rz + radius + DEPTH_SNAP_SLACK);
      mat4.multiply(r.shadowMatrices.subarray(i * 16, i * 16 + 16),
        this._ortho, V);
    }

    // Any cascade the tier does not run must also read as "off" - the shader
    // clamps its index, but a stale matrix there would still be sampled.
    for (let i = this.count; i < RENDER.SHADOW_CASCADES; i++) {
      r.shadowMatrices.fill(0, i * 16, i * 16 + 16);
    }

    // queue.writeBuffer is ordered ahead of the command buffer this frame's
    // encoder is submitted in, exactly as _uploadLights() relies on.
    r.uploadShadowMatrices();

    this.stats.active = anyActive;
    this.stats.sunElevationDeg = Math.asin(Math.max(-1, Math.min(1, sun[1]))) * 180 / Math.PI;
    return anyActive;
  }

  // -------------------------------------------------------------------------

  /**
   * The frame-graph pass. Registered by render/passes/index.js, which places it
   * after the sky and caustics compute and before anything that shades.
   *
   * It has no `enabled()` on purpose: when it declines to draw it still has to
   * run, because zeroing the matrices IS the "shadows off" signal and a pass
   * that is skipped cannot send it.
   */
  makePass() {
    const self = this;
    return {
      name: 'shadow',
      type: 'render',
      reads: [],
      writes: ['shadowAtlas'],

      execute(ctx, encoder) {
        self.stats.totalDraws = 0;
        if (!self._fit(ctx)) return;

        let anyRender = false;
        for (let i = 0; i < self.count; i++) {
          if (self.cascades[i].active && self.cascades[i].render) anyRender = true;
        }
        if (!anyRender) return;

        const casters = [self.game.terrainPass, self.game.entitiesPass,
          self.game.scatterPass];
        for (const p of casters) p?.beginShadowFrame?.(ctx, self);

        for (let i = 0; i < self.count; i++) {
          const cascade = self.cascades[i];
          if (!cascade.active || !cascade.render) continue;
          const label = `shadow.c${i}`;
          const pass = encoder.beginRenderPass(profiler.gpuPass({
            label,
            colorAttachments: [],
            depthStencilAttachment: depthAttachment(
              ctx.targets.subView('shadowAtlas', {
                dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1,
              }),
              { clear: true }),
          }, label));
          let draws = 0;
          for (const p of casters) draws += p?.castShadows?.(ctx, pass, i, self) || 0;
          pass.end();
          cascade.draws = draws;
          self.stats.totalDraws += draws;
        }
      },
    };
  }
}
