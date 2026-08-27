/**
 * SUBWAVE sky, atmosphere and day/night.
 *
 * Owns three things:
 *
 *   1. The atmosphere LUTs. A physically parameterised Rayleigh + Mie + ozone
 *      medium (Bruneton's parameterisation, Hillaire's multiple-scattering
 *      closed form) evaluated by compute into a transmittance LUT (256x64), a
 *      multiple-scattering LUT (32x32) and a per-frame sky-view LUT (256x128).
 *      The justification for that model over Preetham/Hosek-Wilkie is at the
 *      top of shaders/common/atmosphere.wgsl - the short version is that both
 *      empirical fits are undefined below the horizon and give luminance
 *      rather than the spectral irradiance the underwater optics need.
 *
 *   2. The ephemeris. Sun and two moons out of WorldClock, plus the lighting
 *      key-frame interpolation that turns time of day into renderer.env's
 *      sun colour/intensity and the SH ambient probe.
 *
 *   3. The star field. SKY.STAR_COUNT stars on a Fibonacci lattice with a
 *      realistic magnitude distribution, blackbody colours and per-star
 *      scintillation, bucketed into a celestial grid so a fullscreen shader
 *      can find the handful that matter for a pixel.
 *
 * Everything here is deterministic: the same WorldClock always produces the
 * same sky, and the star field is generated from a fixed seed.
 */

import { SKY, TIME_KEYS, RENDER, WORLD } from '../core/constants.js';
import { FORMATS } from '../core/gpu.js';
import {
  createUniformBuffer, createStorageBuffer, createStorageTexture, StructWriter,
} from '../core/resources.js';
import { BindGroupBuilder, STAGE } from '../core/pipelines.js';
import { profiler } from '../core/profiler.js';
import {
  clamp, saturate, lerp, smoothstep, TAU, makeRng,
} from '../core/math.js';

/** Byte size of the Sky uniform. Must match `struct Sky` in common/atmosphere.wgsl. */
export const SKY_UNIFORM_BYTES = 320;

/** LUT dimensions. Mirrored as consts in common/atmosphere.wgsl. */
export const SKY_LUT = {
  TRANSMITTANCE_W: 256, TRANSMITTANCE_H: 64,
  VIEW_W: 256, VIEW_H: 128,
  MULTISCATTER: 32,
};

/**
 * Star bucket grid: uniform in azimuth, uniform in sin(declination), so every
 * cell subtends the same solid angle. MUST match STAR_GRID_U / STAR_GRID_V in
 * shaders/pass/sky_render.wgsl.
 */
const STAR_GRID_U = 96;
const STAR_GRID_V = 48;
/**
 * Angular padding used when inserting a star into the grid, radians.
 *
 * It must be at least STAR_MAX_ANGLE in shaders/pass/sky_render.wgsl, which is
 * the radius beyond which the fragment shader guarantees a star contributes
 * nothing. Anything larger there and a pixel would read a cell the star was
 * never inserted into, clipping its point spread at the cell edge. With this
 * padding the fragment shader only ever has to read ONE cell.
 */
const STAR_INSERT_PAD = 0.034;

/** Magnitude range sampled by the inverse CDF, and its exponent (DESIGN 03.8.6). */
const STAR_MAG_MIN = -1.4;
const STAR_MAG_MAX = 6.8;
const STAR_MAG_SLOPE = 0.42;

/**
 * Magnitude-limited spectral mix, from DESIGN 03.8.6. Colours are linear RGB,
 * normalised so the brightest channel is 1: the magnitude carries all of the
 * intensity, and only the hue lives here.
 */
const STAR_CLASSES = [
  { fraction: 0.055, color: [0.735, 0.815, 1.000] },  // O/B  22000 K
  { fraction: 0.130, color: [0.885, 0.915, 1.000] },  // A     9200 K
  { fraction: 0.180, color: [1.000, 0.975, 0.965] },  // F     7000 K
  { fraction: 0.220, color: [1.000, 0.925, 0.830] },  // G     5700 K
  { fraction: 0.290, color: [1.000, 0.808, 0.630] },  // K     4400 K
  { fraction: 0.125, color: [1.000, 0.660, 0.400] },  // M     3200 K
];

/**
 * Top-of-atmosphere solar irradiance in RENDERER units.
 *
 * The renderer's illuminance scale is set by SKY.SUN_INTENSITY_NOON = 118,
 * which is the sun's ground-level illuminance at solar noon. Roughly 90% of
 * the top-of-atmosphere irradiance survives a vertical air path at this
 * turbidity, so scaling the spectral shape by 118/0.90 makes the LUT-derived
 * sun agree with the key-frame table it shares the frame with. Getting this
 * wrong shows up as a sun disc that does not match the sunlight on the water.
 */
const SUN_TOA_SCALE = SKY.SUN_INTENSITY_NOON / 0.90;

/**
 * Clamp on the sun disc's radiance. Physically it is E/omega = ~1.9e6, which
 * is Inf in the rgba16float scene target. 30,000 keeps the disc four orders of
 * magnitude above the sky, so it still blooms and still saturates the
 * tonemapper, without producing a NaN the moment TAA averages it.
 */
const SUN_DISC_CLAMP = 30000;

/**
 * Radiance scale applied to the TIME_KEYS sky colours.
 *
 * TIME_KEYS.skyColor is an art-directed, perceptually compressed colour (its
 * midnight/noon ratio is 1/160, where the physical ratio is 1/1.4e7). It is
 * BINDING, so rather than replace it we scale it into radiance units. The
 * value is chosen so the noon SH DC term lands at ~0.22 of the sun's
 * illuminance, which is the measured clear-sky ratio in DESIGN 03.9.3
 * (17,000 lux of sky against 78,000 lux of sun) and the ratio that
 * common/water.wgsl's ambientAtDepth assumes when it adds ambientSH[0] to
 * sunIlluminance.
 */
const SKY_RADIANCE_SCALE = 13.5;
/** A clear sky's horizon is brighter than its zenith by roughly this factor. */
const HORIZON_BRIGHTNESS = 1.42;
/** Cosine-weighted hemisphere irradiance is E = PI * (a*zenith + b*horizon). */
const SKY_IRRADIANCE_ZENITH_WEIGHT = 0.65;
const SKY_IRRADIANCE_HORIZON_WEIGHT = 0.35;
/** Overcast redistributes total illuminance into the sky at this efficiency. */
const OVERCAST_SKY_FRACTION = 0.22;
/** Overcast sky colour: near neutral with a faint blue lift (DESIGN 03.9.3). */
const OVERCAST_SKY_COLOR = [0.980, 1.000, 1.045];

/** Sidereal day / solar day. Makes the star field drift a full turn per year. */
const SIDEREAL_RATE = 1.0027379;

/** Turbidity range the Mie coefficient is scaled over (DESIGN 03.8.2). */
const TURBIDITY_MIN = 0.6;
const TURBIDITY_MAX = 6.0;
const TURBIDITY_DEFAULT = 2.2;

export class SkySystem {
  /**
   * Accepts either the explicit resources or a Renderer, because boot builds
   * one from the renderer and tools build one from a device.
   *
   * @param {GPUDevice|import('../render/renderer.js').Renderer} deviceOrRenderer
   * @param {import('../core/shaderlib.js').ShaderLibrary} [shaders]
   * @param {import('../core/pipelines.js').PipelineCache} [pipelines]
   * @param {import('../core/time.js').WorldClock} [worldClock]
   */
  constructor(deviceOrRenderer, shaders, pipelines, worldClock) {
    const isRenderer = !!(deviceOrRenderer && deviceOrRenderer.gpu && deviceOrRenderer.targets);
    /** @type {import('../render/renderer.js').Renderer|null} */
    this.renderer = isRenderer ? deviceOrRenderer : null;
    this.device = isRenderer ? deviceOrRenderer.gpu.device : deviceOrRenderer;
    this.shaders = isRenderer ? deviceOrRenderer.shaders : shaders;
    this.pipelines = isRenderer ? deviceOrRenderer.pipelines : pipelines;
    this.worldClock = isRenderer ? (shaders || null) : (worldClock || null);

    // --- ephemeris state ---------------------------------------------------
    this.sunDir = new Float32Array([0, 1, 0]);
    this.sunColor = new Float32Array([1, 0.97, 0.91]);
    this.sunIntensity = 0;
    this.sunElevation = 0;

    /** Both moons, in SKY.MOONS order. */
    this.moons = SKY.MOONS.map((m) => ({
      name: m.name,
      dir: new Float32Array([0, -1, 0]),
      color: new Float32Array(m.albedo),
      /** Illuminated fraction of the disc, 0 = new, 1 = full. */
      illumination: 0,
      /** Horizontal illuminance contributed to the scene, renderer units. */
      intensity: 0,
      angularRadius: m.angularRadius,
    }));
    /** Index of the moon currently filling the renderer's directional slot. */
    this.brightestMoon = 0;

    this.starVisibility = 0;
    this.turbidity = TURBIDITY_DEFAULT;
    /**
     * Metres the cloud deck has drifted downwind since boot. Kept in f64: this
     * grows past a million metres in a long session, where an f32 accumulator
     * has a 0.06 m quantum and would swallow a single frame's 0.07 m step.
     */
    this.cloudDrift = new Float64Array(2);

    // --- ambient probe inputs (kept for the debug overlay) -----------------
    this.zenithColor = new Float32Array(3);
    this.horizonColor = new Float32Array(3);
    this.groundColor = new Float32Array(3);

    // --- GPU resources -----------------------------------------------------
    this.uniformBuffer = null;
    this.uniformData = new ArrayBuffer(SKY_UNIFORM_BYTES);
    this.uniformF32 = new Float32Array(this.uniformData);
    this.uniformWriter = new StructWriter(this.uniformF32);
    this.multiScatterTexture = null;
    this.multiScatterView = null;
    this.starBuffer = null;
    this.starCellBuffer = null;
    this.starEntryCount = 0;

    /** LUTs that only depend on turbidity, rebuilt when it moves. */
    this._lutsDirty = true;
    this._lutTurbidity = -1;

    /** Scratch, so update() allocates nothing. */
    this._key = {
      sunColor: new Float32Array(3),
      skyColor: new Float32Array(3),
      intensity: 0,
      sunElev: 0,
    };
    this._rotation = new Float32Array(9);
    this._tmpColor = new Float32Array(3);
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  async init() {
    const device = this.device;
    if (!device) throw new Error('[SkySystem] no GPU device');

    this.uniformBuffer = createUniformBuffer(device, SKY_UNIFORM_BYTES, 'sky-uniform');

    this.multiScatterTexture = createStorageTexture(
      device, 'skyMultiScatter', SKY_LUT.MULTISCATTER, SKY_LUT.MULTISCATTER, FORMATS.hdr);
    this.multiScatterView = this.multiScatterTexture.createView({ label: 'skyMultiScatter.view' });

    this._buildStarField();

    await this.shaders.preload([
      'sim/sky_transmittance.wgsl',
      'sim/sky_multiscatter.wgsl',
      'sim/sky_view.wgsl',
      'pass/sky_render.wgsl',
      'pass/clouds.wgsl',
    ]);

    // Seed the uniform so the first frame's LUT passes have real parameters
    // even if update() has not run yet.
    if (this.worldClock) this._writeUniform(this.worldClock, this.renderer);
    return this;
  }

  // -------------------------------------------------------------------------
  // Star field
  // -------------------------------------------------------------------------

  /**
   * Generate the star catalogue and bucket it into the celestial grid.
   *
   * Positions come from a Fibonacci lattice jittered by 0.6 of the mean
   * spacing: a raw lattice is visibly regular (the eye finds the spiral
   * immediately) and pure white noise clumps. Magnitudes come from the real
   * N(<m) ~ 10^(0.42 m) law by inverse CDF, which is what makes the field read
   * as a sky rather than as evenly-scattered dots.
   */
  _buildStarField() {
    const count = SKY.STAR_COUNT;
    const rng = makeRng(0x57a25);
    const dirs = new Float32Array(count * 3);
    const mags = new Float32Array(count);
    const colors = new Float32Array(count * 3);
    const phases = new Float32Array(count);

    // Mean angular spacing over the whole sphere, for the jitter magnitude.
    const meanSpacing = Math.sqrt((4 * Math.PI) / count);
    const jitterScale = 0.6 * meanSpacing;

    const magLow = Math.pow(10, STAR_MAG_SLOPE * STAR_MAG_MIN);
    const magHigh = Math.pow(10, STAR_MAG_SLOPE * STAR_MAG_MAX);

    for (let i = 0; i < count; i++) {
      // Fibonacci lattice: y uniform in [-1,1], azimuth by the golden angle.
      const y = 1 - ((i + 0.5) * 2) / count;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const phi = i * 2.39996322972865332;
      let x = Math.cos(phi) * r;
      let z = Math.sin(phi) * r;
      let sy = y;

      // Jitter in the tangent plane, then renormalise back onto the sphere.
      const t1x = -Math.sin(phi), t1y = 0, t1z = Math.cos(phi);
      const t2x = -sy * Math.cos(phi), t2y = r, t2z = -sy * Math.sin(phi);
      const j1 = (rng() * 2 - 1) * jitterScale;
      const j2 = (rng() * 2 - 1) * jitterScale;
      x += t1x * j1 + t2x * j2;
      sy += t1y * j1 + t2y * j2;
      z += t1z * j1 + t2z * j2;
      const inv = 1 / Math.hypot(x, sy, z);
      dirs[i * 3 + 0] = x * inv;
      dirs[i * 3 + 1] = sy * inv;
      dirs[i * 3 + 2] = z * inv;

      // Inverse CDF of N(<m) ~ 10^(0.42 m) over [STAR_MAG_MIN, STAR_MAG_MAX].
      const u = rng();
      mags[i] = Math.log10(magLow + u * (magHigh - magLow)) / STAR_MAG_SLOPE;

      // Spectral class by cumulative fraction.
      let pick = rng();
      let cls = STAR_CLASSES[STAR_CLASSES.length - 1];
      for (const c of STAR_CLASSES) {
        if (pick < c.fraction) { cls = c; break; }
        pick -= c.fraction;
      }
      colors[i * 3 + 0] = cls.color[0];
      colors[i * 3 + 1] = cls.color[1];
      colors[i * 3 + 2] = cls.color[2];

      phases[i] = rng() * 100;
    }

    // --- bucket into the celestial grid ------------------------------------
    // Each star is inserted into every cell its point spread can touch, so a
    // pixel only ever reads the single cell it falls in. Near the poles the
    // azimuthal padding widens until a star covers the whole ring, which is
    // correct and costs almost nothing: only a handful of stars are that close
    // to a pole.
    const cellCount = STAR_GRID_U * STAR_GRID_V;
    const counts = new Uint32Array(cellCount);

    const sinPad = Math.sin(STAR_INSERT_PAD);
    const forEachCell = (i, visit) => {
      const dy = dirs[i * 3 + 1];
      const cosDec = Math.sqrt(Math.max(1e-6, 1 - dy * dy));
      const az = Math.atan2(dirs[i * 3 + 2], dirs[i * 3 + 0]);
      const u = ((az / TAU + 0.5) % 1 + 1) % 1;
      const v = saturate(dy * 0.5 + 0.5);

      // Largest azimuth deviation on a circle of angular radius PAD centred at
      // this declination is asin(sin PAD / cos dec), NOT PAD / cos dec: the
      // small-angle form under-covers, and near the poles it under-covers by
      // enough to drop a star out of a cell that can see it.
      const ratio = sinPad / cosDec;
      const du = ratio >= 1 ? 0.5 : Math.min(0.5, Math.asin(ratio) / TAU);
      const dv = STAR_INSERT_PAD * 0.5;

      const v0 = Math.max(0, Math.floor((v - dv) * STAR_GRID_V));
      const v1 = Math.min(STAR_GRID_V - 1, Math.floor((v + dv) * STAR_GRID_V));
      const u0 = Math.floor((u - du) * STAR_GRID_U);
      const u1 = Math.floor((u + du) * STAR_GRID_U);

      for (let cv = v0; cv <= v1; cv++) {
        for (let cu = u0; cu <= u1; cu++) {
          const wrapped = ((cu % STAR_GRID_U) + STAR_GRID_U) % STAR_GRID_U;
          visit(cv * STAR_GRID_U + wrapped);
        }
      }
    };

    for (let i = 0; i < count; i++) forEachCell(i, (cell) => { counts[cell]++; });

    const offsets = new Uint32Array(cellCount);
    let total = 0;
    for (let c = 0; c < cellCount; c++) {
      offsets[c] = total;
      total += counts[c];
    }

    const cursor = offsets.slice();
    const entries = new Float32Array(total * 8);
    for (let i = 0; i < count; i++) {
      forEachCell(i, (cell) => {
        const o = cursor[cell]++ * 8;
        entries[o + 0] = dirs[i * 3 + 0];
        entries[o + 1] = dirs[i * 3 + 1];
        entries[o + 2] = dirs[i * 3 + 2];
        entries[o + 3] = mags[i];
        entries[o + 4] = colors[i * 3 + 0];
        entries[o + 5] = colors[i * 3 + 1];
        entries[o + 6] = colors[i * 3 + 2];
        entries[o + 7] = phases[i];
      });
    }

    const cells = new Uint32Array(cellCount * 2);
    for (let c = 0; c < cellCount; c++) {
      cells[c * 2 + 0] = offsets[c];
      cells[c * 2 + 1] = counts[c];
    }

    this.starEntryCount = total;
    this.starCatalogue = { dirs, mags, colors, phases, count };
    if (this.device) {
      this.starBuffer = createStorageBuffer(this.device, entries, 'sky-stars');
      this.starCellBuffer = createStorageBuffer(this.device, cells, 'sky-star-cells');
    } else {
      this.starEntries = entries;
      this.starCells = cells;
    }
    return { entries, cells, total };
  }

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------

  /**
   * Advance the sky for one frame and publish it to the renderer.
   *
   * @param {import('../core/time.js').WorldClock} worldClock
   * @param {import('../render/renderer.js').Renderer} renderer
   * @param {number} [dt] real seconds since the previous frame
   */
  update(worldClock, renderer, dt = 0) {
    this.worldClock = worldClock;
    const env = renderer.env;

    this._sampleTimeKeys(worldClock.dayFraction);
    this._updateEphemeris(worldClock);
    this._updateLighting(env);
    this._updateAmbient(renderer, env);

    // Cloud deck drift. Wind at 3 km is about 1.35x the 10 m wind
    // (the surface boundary layer takes the rest), which is why a cloud
    // shadow crosses the water faster than the whitecaps do.
    const windDir = env.windDir || [1, 0];
    const layerSpeed = (env.windSpeed || 0) * 1.35;
    this.cloudDrift[0] += windDir[0] * layerSpeed * dt;
    this.cloudDrift[1] += windDir[1] * layerSpeed * dt;

    const turbidity = clamp(
      env.airTurbidity != null ? env.airTurbidity : TURBIDITY_DEFAULT,
      TURBIDITY_MIN, TURBIDITY_MAX);
    // The turbidity-only LUTs are worth ~1 ms to rebuild, so only do it when
    // the value has actually moved. 2% is far below the visible threshold.
    if (Math.abs(turbidity - this._lutTurbidity) > 0.02 * Math.max(1, this._lutTurbidity)) {
      this._lutsDirty = true;
      this._lutTurbidity = turbidity;
    }
    this.turbidity = turbidity;

    this._writeUniform(worldClock, renderer);
  }

  /** Interpolate the TIME_KEYS table at a day fraction into this._key. */
  _sampleTimeKeys(dayFraction) {
    const t = ((dayFraction % 1) + 1) % 1;
    let i = 0;
    while (i < TIME_KEYS.length - 2 && TIME_KEYS[i + 1].t <= t) i++;
    const a = TIME_KEYS[i];
    const b = TIME_KEYS[i + 1];
    const span = Math.max(b.t - a.t, 1e-6);
    const f = saturate((t - a.t) / span);

    const k = this._key;
    for (let c = 0; c < 3; c++) {
      k.sunColor[c] = lerp(a.sunColor[c], b.sunColor[c], f);
      k.skyColor[c] = lerp(a.skyColor[c], b.skyColor[c], f);
    }
    k.intensity = lerp(a.intensity, b.intensity, f);
    k.sunElev = lerp(a.sunElev, b.sunElev, f);
    return k;
  }

  /** Sun and moon directions, phases and illuminances. */
  _updateEphemeris(worldClock) {
    worldClock.sunDirection(this.sunDir);
    this.sunElevation = Math.asin(clamp(this.sunDir[1], -1, 1));

    let best = 0;
    let bestIntensity = -1;
    for (let i = 0; i < this.moons.length; i++) {
      const m = this.moons[i];
      const spec = SKY.MOONS[i];
      worldClock.moonDirection(m.dir, i);

      // Phase from the actual geometry, not from the orbital phase counter, so
      // the terminator the sky shader draws and the light the scene receives
      // can never disagree. Both vectors point AWAY from the viewer, so the
      // moon is FULL when they are opposed: the sub-viewer point of the disc
      // has outward normal -moonDir, and its cosine to the sun is -cosPhase.
      // That is the same quantity moonDisc() in pass/sky_render.wgsl uses.
      const cosPhase = clamp(
        m.dir[0] * this.sunDir[0] + m.dir[1] * this.sunDir[1] + m.dir[2] * this.sunDir[2],
        -1, 1);
      m.illumination = 0.5 * (1 - cosPhase);

      // E = E_full * k^1.35 * max(0, sin h). The 1.35 exponent approximates the
      // lunar opposition surge: a half moon is far less than half as bright as
      // a full one, which is a real and surprisingly visible effect.
      const altitude = Math.max(0, m.dir[1]);
      m.intensity = spec.intensity * Math.pow(m.illumination, 1.35) * altitude;
      if (m.intensity > bestIntensity) {
        bestIntensity = m.intensity;
        best = i;
      }
    }
    this.brightestMoon = best;
  }

  /**
   * How close the deck is to unbroken, from the cloud cover.
   *
   * This is the ONLY thing that may dim the world by cloud. Cover itself must
   * not: a scattered cumulus field at 0.45 leaves the sun at full strength
   * between the clouds and removes it entirely behind one, and the per-pixel
   * version of that is the cloud render. Keying the dim on cover instead cost
   * 38% of the sunlight at cover 0.45 (env.sunIntensity 73.17 -> 45.35) and
   * desaturated the ambient probe from B/R 1.80 to 1.47, so every fix to the
   * empty sky made the lit world worse.
   */
  _overcastFraction(env) {
    const cloud = saturate(env.cloudCover != null ? env.cloudCover : 0);
    return smoothstep(SKY.OVERCAST_BAND[0], SKY.OVERCAST_BAND[1], cloud);
  }

  /** Publish sun and moon into renderer.env. */
  _updateLighting(env) {
    const k = this._key;
    const overcast = this._overcastFraction(env);

    // Full overcast kills the direct sun; a broken deck barely touches it. The
    // residual 2% keeps a hint of a disc behind a stratus deck rather than
    // switching the key light off, which reads as a bug.
    const sunDim = 1 - 0.98 * overcast;

    // Horizon gate. TIME_KEYS carries a small non-zero sun intensity through
    // astronomical twilight (0.002 at t=0.20), but a sun below the horizon
    // delivers no DIRECT light - that glow belongs to the sky term. The gate
    // closes exactly where lighting.wgsl's evalSun stops evaluating the sun
    // (L.y <= -0.05), so no energy is created or lost at the boundary and
    // env.sunIntensity is genuinely zero at night.
    const horizonGate = smoothstep(-0.05, -0.005, this.sunDir[1]);
    this.sunIntensity = k.intensity * SKY.SUN_INTENSITY_NOON * sunDim * horizonGate;

    for (let c = 0; c < 3; c++) {
      // The key table's sun colour is already the atmospherically reddened
      // colour at that elevation; SUN_ILLUMINANCE is the spectral shape of the
      // source itself, so the two multiply.
      this.sunColor[c] = k.sunColor[c] * SKY.SUN_ILLUMINANCE[c];
    }

    env.sunDir[0] = this.sunDir[0];
    env.sunDir[1] = this.sunDir[1];
    env.sunDir[2] = this.sunDir[2];
    env.sunColor[0] = this.sunColor[0];
    env.sunColor[1] = this.sunColor[1];
    env.sunColor[2] = this.sunColor[2];
    env.sunIntensity = this.sunIntensity;
    env.sunAngularRadius = SKY.SUN_ANGULAR_RADIUS;

    const m = this.moons[this.brightestMoon];
    env.moonDir[0] = m.dir[0];
    env.moonDir[1] = m.dir[1];
    env.moonDir[2] = m.dir[2];
    env.moonColor[0] = m.color[0];
    env.moonColor[1] = m.color[1];
    env.moonColor[2] = m.color[2];
    // Moonlight is dimmed by cloud exactly as sunlight is.
    env.moonIntensity = m.intensity * sunDim;
    env.moonPhase = m.illumination;
    env.dayFraction = this.worldClock ? this.worldClock.dayFraction : env.dayFraction;

    // Stars appear once the sun is well below the horizon. They are additive
    // into the HDR buffer, but TIME_KEYS' sky colours are perceptually
    // compressed rather than physical, so the automatic drown-out a physical
    // sky would give does not happen and the ramp has to be explicit.
    // -1 deg to -12 deg is civil through nautical twilight.
    this.starVisibility = 1 - smoothstep(-0.21, -0.017, this.sunDir[1]);
  }

  /**
   * Build the SH ambient probe for the current sky.
   *
   * The zenith/horizon/ground triple is what renderer.updateAmbientSH()
   * integrates; the magnitudes here are the whole reason ambient light tracks
   * the time of day rather than being a constant fudge.
   */
  _updateAmbient(renderer, env) {
    const k = this._key;
    const overcast = this._overcastFraction(env);
    const sinElev = Math.max(0, this.sunDir[1]);

    // Clear-sky radiance from the key table.
    const zen = this.zenithColor;
    const hor = this.horizonColor;
    const gnd = this.groundColor;

    // Warm the horizon toward the sun's colour through twilight. The width is
    // in elevation, so it opens up at exactly the same time the key table's
    // sun colour goes orange.
    const warm = 0.55 * Math.exp(-Math.pow(this.sunDir[1] / 0.25, 2));

    // An unbroken deck shifts the sky's HUE toward neutral without touching
    // its magnitude; the magnitude change is the overcast redistribution
    // below. Applying OVERCAST_SKY_COLOR as an absolute colour instead would
    // light a cloudy midnight as brightly as a cloudy noon.
    const keyLuma = (k.skyColor[0] + k.skyColor[1] + k.skyColor[2]) / 3;
    const neutralLuma = (OVERCAST_SKY_COLOR[0] + OVERCAST_SKY_COLOR[1] + OVERCAST_SKY_COLOR[2]) / 3;
    const neutralScale = keyLuma / neutralLuma;
    // The horizon tint is likewise a hue borrowed from the sun, renormalised
    // to the sky's own brightness and then lifted: at sunset the horizon is
    // genuinely brighter than the zenith, which is the whole look.
    const sunLuma = (k.sunColor[0] + k.sunColor[1] + k.sunColor[2]) / 3;
    const warmScale = sunLuma > 1e-4 ? (keyLuma / sunLuma) * 1.6 : 0;

    for (let c = 0; c < 3; c++) {
      const base = lerp(k.skyColor[c], OVERCAST_SKY_COLOR[c] * neutralScale, overcast);
      zen[c] = base * SKY_RADIANCE_SCALE;
      hor[c] = lerp(base, k.sunColor[c] * warmScale, warm) * SKY_RADIANCE_SCALE * HORIZON_BRIGHTNESS;
    }

    // Overcast redistribution (DESIGN 03.9.3): the direct sun goes away and
    // the sky carries OVERCAST_SKY_FRACTION of what the two used to deliver
    // together. At noon that makes the overcast sky BRIGHTER than the clear
    // one while the scene as a whole loses three quarters of its light, which
    // is exactly how an overcast day looks.
    const skyIrradianceClear = Math.PI * (
      SKY_IRRADIANCE_ZENITH_WEIGHT * (zen[0] + zen[1] + zen[2]) / 3 +
      SKY_IRRADIANCE_HORIZON_WEIGHT * (hor[0] + hor[1] + hor[2]) / 3);
    const sunIrradianceClear = k.intensity * SKY.SUN_INTENSITY_NOON * sinElev;
    const overcastGain = clamp(
      (OVERCAST_SKY_FRACTION * (sunIrradianceClear + skyIrradianceClear)) /
        Math.max(skyIrradianceClear, 1e-6),
      0.20, 3.0);
    const skyScale = lerp(1, overcastGain, overcast);

    for (let c = 0; c < 3; c++) {
      zen[c] *= skyScale;
      hor[c] *= skyScale;
    }

    // The ground is the open ocean: a Lambertian reflector lit by whatever sun
    // and sky survive. E/PI turns irradiance into the radiance the probe wants.
    const skyIrradiance = skyIrradianceClear * skyScale;
    for (let c = 0; c < 3; c++) {
      const sunTerm = this.sunColor[c] * this.sunIntensity * sinElev;
      gnd[c] = SKY.GROUND_ALBEDO[c] * (sunTerm + skyIrradiance) / Math.PI;
    }

    renderer.updateAmbientSH(zen, hor, gnd);
  }

  // -------------------------------------------------------------------------
  // Uniform
  // -------------------------------------------------------------------------

  /**
   * World -> celestial rotation for the star field.
   *
   * The celestial pole sits at altitude = latitude in the north (-Z), the sky
   * spins about it once per sidereal day, and the stars are catalogued in that
   * frame. Doing the transform here rather than rotating 3,800 star vectors
   * every frame is the entire reason the star buffer can be static.
   */
  _celestialRotation(worldClock, out) {
    const lat = worldClock.latitude;
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    // NEGATIVE, so the sky turns the same way the sun does. The shader maps
    // world -> celestial, so the world direction of a fixed star is R^T times
    // its catalogue vector; with +theta that traces the diurnal arc backwards
    // and the stars rise in the west while the sun rises in the east.
    const theta = -(worldClock.totalSeconds / SKY.SECONDS_PER_DAY) * TAU * SIDEREAL_RATE;
    const c = Math.cos(theta);
    const s = Math.sin(theta);

    // Rows of the matrix (world -> celestial), then stored column-major to
    // match WGSL's mat3x3f.
    const r00 = c,   r01 = -s * cosLat, r02 = -s * sinLat;
    const r10 = 0,   r11 = sinLat,      r12 = -cosLat;
    const r20 = s,   r21 = c * cosLat,  r22 = c * sinLat;

    out[0] = r00; out[1] = r10; out[2] = r20;
    out[3] = r01; out[4] = r11; out[5] = r21;
    out[6] = r02; out[7] = r12; out[8] = r22;
    return out;
  }

  /** Serialise the Sky uniform. Order MUST match `struct Sky`. */
  _writeUniform(worldClock, renderer) {
    const env = renderer ? renderer.env : null;
    const w = this.uniformWriter.reset();

    const cameraY = renderer ? renderer.camera.position[1] : 0;
    const viewerAltitude = clamp(cameraY - WORLD.SEA_LEVEL, 0, RENDER.MAX_VIEW_DISTANCE * 4);
    const Rg = SKY.PLANET_RADIUS;
    const Rt = SKY.ATMOSPHERE_RADIUS;

    // Mie scales with turbidity: it is the single control that turns a clear
    // blue sky into a white hazy one, and it is the only atmosphere parameter
    // the weather system touches.
    const mie = SKY.MIE * this.turbidity;
    const mieAbs = SKY.MIE_ABSORPTION * this.turbidity;
    // Haze is less forward-scattering than clean air aerosol; raising g with
    // turbidity is what gives a hazy sky its big soft solar aureole.
    const mieG = lerp(SKY.MIE_G, 0.86, saturate((this.turbidity - 2.2) / 3.8));

    w.vec4(this.sunDir[0], this.sunDir[1], this.sunDir[2], SKY.SUN_ANGULAR_RADIUS);
    w.vec4(SKY.SUN_ILLUMINANCE[0] * SUN_TOA_SCALE,
           SKY.SUN_ILLUMINANCE[1] * SUN_TOA_SCALE,
           SKY.SUN_ILLUMINANCE[2] * SUN_TOA_SCALE,
           SUN_DISC_CLAMP);

    for (let i = 0; i < 2; i++) {
      const m = this.moons[i];
      const spec = SKY.MOONS[i];
      // Disc radiance = illuminance / solid angle. The 0.5 undoes the
      // Lommel-Seeliger factor at the centre of a full disc, so a full moon
      // renders at the illuminance the scene lighting was given.
      const solidAngle = Math.PI * spec.angularRadius * spec.angularRadius;
      const discScale = spec.intensity / (solidAngle * 0.5);
      w.vec4(m.dir[0], m.dir[1], m.dir[2], spec.angularRadius);
      w.vec4(spec.albedo[0] * discScale, spec.albedo[1] * discScale,
             spec.albedo[2] * discScale, m.illumination);
    }

    w.vec4(SKY.RAYLEIGH[0], SKY.RAYLEIGH[1], SKY.RAYLEIGH[2], SKY.RAYLEIGH_SCALE_HEIGHT);
    w.vec4(mie, mie, mie, SKY.MIE_SCALE_HEIGHT);
    w.vec4(mieAbs, mieAbs, mieAbs, mieG);
    w.vec4(SKY.OZONE[0], SKY.OZONE[1], SKY.OZONE[2], 15000);
    w.vec4(SKY.GROUND_ALBEDO[0], SKY.GROUND_ALBEDO[1], SKY.GROUND_ALBEDO[2], 25000);
    w.vec4(Rg, Rt, viewerAltitude, Math.sqrt(Rt * Rt - Rg * Rg));

    const turbidityNorm = saturate((this.turbidity - TURBIDITY_MIN) / (TURBIDITY_MAX - TURBIDITY_MIN));
    const time = worldClock ? worldClock.totalSeconds : 0;
    w.vec4(this.starVisibility, turbidityNorm, time, SKY.GALAXY_STRENGTH);
    w.vec4(this.turbidity, this.starVisibility, 1.0, SKY.AIRGLOW);

    const cloudCover = env && env.cloudCover != null ? saturate(env.cloudCover) : 0.15;
    const rain = env && env.rain != null ? saturate(env.rain) : 0;
    const cloudType = env && env.cloudType != null ? saturate(env.cloudType) : 0.5;
    const cloudDensity = SKY.CLOUD_DENSITY * (1 + SKY.CLOUD_RAIN_DENSITY_GAIN * rain);
    w.vec4(SKY.CLOUD_BOTTOM, SKY.CLOUD_TOP, cloudCover, cloudDensity);
    w.vec4(cloudType, rain, SKY.CLOUD_EROSION, saturate(cloudType * 2 - 1));

    const windDir = (env && env.windDir) || [1, 0];
    w.vec4(this.cloudDrift[0], this.cloudDrift[1], windDir[0], windDir[1]);

    if (worldClock) this._celestialRotation(worldClock, this._rotation);
    w.mat3(this._rotation);

    if (w.bytes !== SKY_UNIFORM_BYTES) {
      throw new Error(
        `[SkySystem] Sky uniform is ${w.bytes} bytes but atmosphere.wgsl declares ` +
        `${SKY_UNIFORM_BYTES}. The JS writer and the WGSL struct have drifted apart.`);
    }
    if (this.device && this.uniformBuffer) {
      this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData, 0, SKY_UNIFORM_BYTES);
    }
  }

  // -------------------------------------------------------------------------
  // Frame graph passes
  // -------------------------------------------------------------------------

  /**
   * The three LUT compute passes, in dependency order.
   *
   * None of them binds group 0: the frame bind group holds skyLUT and
   * transmittanceLUT as SAMPLED textures, and WebGPU forbids a texture being a
   * writable storage binding and a sampled binding inside one usage scope. So
   * each pass owns its whole group 0.
   */
  makePasses() {
    return [this._makeTransmittancePass(), this._makeMultiScatterPass(), this._makeSkyViewPass()];
  }

  _makeTransmittancePass() {
    const sky = this;
    let pipeline = null;
    let bindGroup = null;

    // RenderTargets.resize() rebuilds EVERY declared target, fixed-size LUTs
    // included, so the views these groups hold are destroyed by a window
    // resize and have to be rebuilt - and the fresh textures hold garbage
    // until the LUTs are recomputed, hence _lutsDirty.
    const build = (ctx) => {
      const b = new BindGroupBuilder('skyTransmittance');
      b.uniform(sky.uniformBuffer, STAGE.C);
      b.storageTexture(ctx.targets.view('transmittanceLUT'), STAGE.C, { format: FORMATS.hdr });
      const built = b.build(ctx.pipelines);
      bindGroup = built.group;
      return built.layout;
    };

    return {
      name: 'skyTransmittance',
      type: 'compute',
      writes: ['transmittanceLUT'],
      enabled() { return sky._lutsDirty; },
      init(ctx) {
        const module = ctx.shaders.module('sim/sky_transmittance.wgsl', {}, 'sky-transmittance');
        const layout = build(ctx);
        pipeline = ctx.pipelines.computePipeline({
          label: 'skyTransmittance',
          layout: ctx.pipelines.pipelineLayout('skyTransmittance.pl', [layout]),
          compute: { module, entryPoint: 'cs_transmittance' },
        });
      },
      resize(ctx) {
        build(ctx);
        sky._lutsDirty = true;
      },
      execute(ctx, encoder) {
        if (!pipeline) return;
        const pass = encoder.beginComputePass(
          profiler.gpuPass({ label: 'skyTransmittance' }, 'skyTransmittance'));
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(SKY_LUT.TRANSMITTANCE_W / 8, SKY_LUT.TRANSMITTANCE_H / 8, 1);
        pass.end();
      },
    };
  }

  _makeMultiScatterPass() {
    const sky = this;
    let pipeline = null;
    let bindGroup = null;

    const build = (ctx) => {
      const b = new BindGroupBuilder('skyMultiScatter');
      b.uniform(sky.uniformBuffer, STAGE.C);
      b.sampler(ctx.samplers.linearClamp, STAGE.C);
      b.texture(ctx.targets.view('transmittanceLUT'), STAGE.C);
      b.storageTexture(sky.multiScatterView, STAGE.C, { format: FORMATS.hdr });
      const built = b.build(ctx.pipelines);
      bindGroup = built.group;
      return built.layout;
    };

    return {
      name: 'skyMultiScatter',
      type: 'compute',
      reads: ['transmittanceLUT'],
      writes: ['_skyMultiScatter'],
      enabled() { return sky._lutsDirty; },
      init(ctx) {
        const module = ctx.shaders.module('sim/sky_multiscatter.wgsl', {}, 'sky-multiscatter');
        const layout = build(ctx);
        pipeline = ctx.pipelines.computePipeline({
          label: 'skyMultiScatter',
          layout: ctx.pipelines.pipelineLayout('skyMultiScatter.pl', [layout]),
          compute: { module, entryPoint: 'cs_multiscatter' },
        });
      },
      resize(ctx) { build(ctx); },
      execute(ctx, encoder) {
        if (!pipeline) return;
        const pass = encoder.beginComputePass(
          profiler.gpuPass({ label: 'skyMultiScatter' }, 'skyMultiScatter'));
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(SKY_LUT.MULTISCATTER / 8, SKY_LUT.MULTISCATTER / 8, 1);
        pass.end();
        // Both turbidity-driven LUTs are now current.
        sky._lutsDirty = false;
      },
    };
  }

  _makeSkyViewPass() {
    const sky = this;
    let pipeline = null;
    let bindGroup = null;

    const build = (ctx) => {
      const b = new BindGroupBuilder('skyView');
      b.uniform(sky.uniformBuffer, STAGE.C);
      b.sampler(ctx.samplers.linearClamp, STAGE.C);
      b.texture(ctx.targets.view('transmittanceLUT'), STAGE.C);
      b.texture(sky.multiScatterView, STAGE.C);
      b.storageTexture(ctx.targets.view('skyLUT'), STAGE.C, { format: FORMATS.hdr });
      const built = b.build(ctx.pipelines);
      bindGroup = built.group;
      return built.layout;
    };

    return {
      name: 'skyView',
      type: 'compute',
      reads: ['transmittanceLUT', '_skyMultiScatter'],
      writes: ['skyLUT'],
      init(ctx) {
        const module = ctx.shaders.module('sim/sky_view.wgsl', {}, 'sky-view');
        const layout = build(ctx);
        pipeline = ctx.pipelines.computePipeline({
          label: 'skyView',
          layout: ctx.pipelines.pipelineLayout('skyView.pl', [layout]),
          compute: { module, entryPoint: 'cs_skyview' },
        });
      },
      resize(ctx) { build(ctx); },
      execute(ctx, encoder) {
        if (!pipeline) return;
        const pass = encoder.beginComputePass(profiler.gpuPass({ label: 'skyView' }, 'skyView'));
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(SKY_LUT.VIEW_W / 8, SKY_LUT.VIEW_H / 8, 1);
        pass.end();
      },
    };
  }

  // -------------------------------------------------------------------------

  destroy() {
    this.uniformBuffer?.destroy();
    this.multiScatterTexture?.destroy();
    this.starBuffer?.destroy();
    this.starCellBuffer?.destroy();
  }
}
