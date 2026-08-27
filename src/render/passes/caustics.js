/**
 * SUBWAVE caustics pass.
 *
 * Generates the tiling caustic pattern that common/water.wgsl projects onto the
 * seabed, the terrain, creature hides and the vessel hull, plus the mip chain
 * both consumers minify it through. The method and the reason for choosing it
 * over photon splatting are documented at the top of shaders/sim/caustics.wgsl.
 *
 * The wave set lives on the integer lattice of the CAUSTICS_SCALE tile, so the
 * texture is periodic by construction - no seam, at any sampling rate. The
 * amplitudes come from the same Phillips spectrum the ocean surface uses, so
 * the wind's HEADING orients the filaments and its speed moves which ring
 * carries the variance.
 *
 * WIND SPEED NO LONGER MOVES THE CONTRAST, and the old header claimed it did.
 * CAUSTIC_FOCUS_SIGMA is pinned, so the rescale below divides out exactly the
 * wind dependence Phillips puts in: measured, tile mean 1.32947 and sd/mean
 * 0.7173 at fogbank's 2.0 m/s against 1.32695 and 0.7141 at storm's 24.0 m/s,
 * and the ring shares of the curvature variance move at most 5 points between
 * those two extremes. That is the price of a pattern whose consumers can divide
 * by ONE baked mean; the alternative is the per-state normalisation error the
 * deleted FROXEL_CAUSTIC_MEAN carried. Weather still reaches the caustics, by
 * the per-state multiplier in frame.waterSurface.x.
 *
 * WHAT IT DRAWS IS ANISOTROPIC, and that is Phillips, not a defect in the
 * lattice: the cos^2 spreading plus the 0.055 back lobe put 81-85% of the
 * curvature weight sum (A k^2)^2 within +/-45 deg of the wind AXIS against 50%
 * for an isotropic sea, and the E field's autocorrelation half-width measures
 * 0.2975 m across the wind against 0.1179 m along it - a 2.52:1 streak field,
 * not the closed polygonal net a real shallow-water caustic makes. Narrowing
 * the spread is the next lever and is deferred.
 *
 * Depth fade is NOT applied here. common/water.wgsl's causticFactor() already
 * multiplies by 1 - smoothstep(0, CAUSTICS_MAX_DEPTH, depth), which is
 * identically zero at and beyond 62 m; doing it twice would square the ramp.
 */

import { profiler } from '../../core/profiler.js';
import { STAGE } from '../../core/pipelines.js';
import { createUniformBuffer } from '../../core/resources.js';
import { RENDER } from '../../core/constants.js';
import { angleDelta, TAU } from '../../core/math.js';

/**
 * Number of periodic components. Matches CAUSTIC_WAVES in caustics.wgsl, which
 * tools/test-caustics.mjs reads out of the shader text and compares.
 *
 * Derivation: the participation ratio (sum w)^2 / sum w^2 over the curvature
 * weights w = (A_i k_i^2)^2 measures 7.3 / 9.3 / 11.2 / 14.0 / 17.1 at N = 24 /
 * 32 / 40 / 48 / 56, and the excess kurtosis of h_xx -0.313 / -0.242 / -0.192 /
 * -0.173 / -0.149. The focusing invariant below is an rms, which is only an
 * invariant on a near-Gaussian field, and 48 is the first count whose
 * participation clears 14. Fold, clamp and mean statistics are already flat
 * from 32 modes, so this is a Gaussianity choice and not a statistics choice.
 */
export const CAUSTIC_WAVES = 48;

/**
 * 48 wavevectors on the tile's integer lattice, on seven logarithmic rings of
 * |n| = 1, 2.24, 4, 7, 12, 18, 24 with 2/4/5/7/9/10/11 members. Angles are
 * spread by the golden angle and snapped to the nearest integer point; NO TWO
 * MODES ANYWHERE SHARE A PRIMITIVE DIRECTION, k and -k counting as the same
 * one - two counter-propagating modes of equal |k| lock their curvature to the
 * same spatial pattern and read as a standing stripe. Verified by
 * tools/test-caustics.mjs: 0 duplicates, 0 shared directions, periodicity
 * residue 0 cycles. Wavelengths span 0.5735 m to 14.0 m; the short end is the
 * 0.4-0.8 m band that actually focuses sunlight, which the previous ten-mode
 * set (3.40 m floor, and 3 collinear pairs against its own comment) could not
 * represent at all.
 */
export const LATTICE = [
  [1, 1], [-1, 0],
  [2, -2], [0, 2], [-1, -2], [2, 1],
  [-3, 2], [1, -4], [2, 3], [-4, -1], [4, -2],
  [-3, 6], [-2, -7], [6, 4], [-7, 2], [4, -6], [1, 7], [-5, -4],
  [12, -1], [-8, 9], [1, -12], [8, 9], [-12, -1], [9, -7], [-2, 12], [-6, -10], [11, 3],
  [-15, 8], [6, -17], [7, 17], [-17, -8], [17, -5], [-9, 15], [-4, -18], [14, 10], [-18, 2], [12, -14],
  [1, 24], [-16, -17], [24, 1], [-18, 15], [3, -24], [14, 20], [-23, -5], [21, -12], [-7, 23], [-10, -22], [22, 9],
];

/** Member count of each ring of LATTICE, in order. Sums to CAUSTIC_WAVES. */
export const RING_SIZES = [2, 4, 5, 7, 9, 10, 11];

/**
 * Depth of the notional receiving plane, metres. FROZEN: it is only ever the
 * reference depth CAUSTIC_FOCUS_SIGMA is quoted at, because sigma and this are
 * redundant - the shader only ever sees the product c * rms_F(Hessian). Making c
 * per-pixel is a real improvement and is deliberately deferred.
 */
export const RECEIVER_DEPTH = 3.0;

/**
 * Peak irradiance multiple, and it is a RESOLUTION LIMIT rather than a taste
 * knob. The sun's disc subtends 9.3 mrad, which refracts to 3.47 mrad in
 * seawater and so blurs the pattern by 10.4 mm at the reference depth; against
 * that blur a fold's peak brackets at 4.4-6.5 and a cusp's at 8.7-12.9. 6.0
 * therefore passes an ordinary fold intact and clips only the cusps, which are
 * the places the single-sheet model is lying anyway. Do not raise it.
 *
 * DERIVED, not a second copy: common/water.wgsl clamps the two-tap composite at
 * the same ceiling, and CAUSTIC_COMPOSITE_MEAN is below 1 only because of it, so
 * two independent 6.0s would let the tile's ceiling and the composite's drift
 * apart with nothing but a 1.5% tolerance to notice.
 */
export const INTENSITY_CLAMP = RENDER.CAUSTICS_INTENSITY_CLAMP;

/** Refractive index of seawater at 610 / 550 / 460 nm. */
export const IOR_RGB = [1.3305, 1.3345, 1.3405];

/**
 * Dimensionless focusing strength of the tile, defined as
 *   sigma = c * sqrt(3/16 * sum (A_i k_i^2)^2),  c = RECEIVER_DEPTH * (1 - 1/n).
 *
 * WHAT THAT QUANTITY IS, stated correctly - an earlier draft of this docstring
 * called it "c * rms(h_xx), independent of wind direction", and it is neither.
 * With random phases E[h_xx^2] = 1/2 * sum (A k^2)^2 cos^4(psi_i), so the 3/16
 * needs E[cos^4] = 3/8, i.e. an ISOTROPIC direction spread - which the very
 * line below destroys, because spectrum.phillips() carries a cos^2 spreading.
 * Measured over the tile, c*rms(h_xx) runs 0.3608 / 0.3246 / 0.2841 / 0.2350 /
 * 0.1656 at wind headings 0 / 30 / 45 / 60 / 90 deg, a 2.2x spread that equals
 * 0.28 only near 47 deg, and the same shape at every weather state.
 *
 * The quantity that IS heading-invariant, for ANY direction distribution, is
 * the Frobenius rms of the scaled Hessian:
 *   E[h_xx^2 + h_zz^2 + 2 h_xz^2] = 1/2 * sum (A k^2)^2
 * exactly, because cos^4 + sin^4 + 2 cos^2 sin^2 = 1. So sigma is sqrt(3/8)
 * times c * rms_F(H), and it is that product it pins. Verified numerically over
 * a 192^2 tile at 3 states x 8 headings: c*rms_F = 0.457238 at EVERY one of the
 * 24, and sigma/rms_F = 0.612372 = sqrt(3/8) to six digits. det J is built from
 * all three Hessian components, which is why the invariant that governs the
 * fold statistics is the Frobenius one and not h_xx's.
 *
 * It replaces sum|c*A*k^2|, which is an L1 norm and therefore NOT invariant in
 * mode count: splitting one mode into ten leaves the L1 sum unchanged while the
 * field's variance collapses, because ten cosines rarely align. Measured on the
 * two lattices at the same field, L1/sigma is 6.32 at ten modes and 11.60 at
 * forty-eight - a factor of 1.83 - which is why TARGET_CURVATURE = 1.35 could
 * never be reasoned about, and why the old comment ("above 1.0 the determinant
 * can reach zero") was wrong by that factor on its own lattice.
 *
 * The GAME'S OWN OCEAN, put through the SAME functional at this receiver depth,
 * runs sigma = 0.368 (fogbank) / 0.474 (clear) / 0.539 (breezy) / 0.613
 * (overcast) / 0.819 (squall) / 1.034 (storm). 0.28 is 59% of clear's, and that
 * is deliberate: the single-sheet E = 1/|det J| model draws a multi-valued map
 * as single-valued, so the fold fraction is the honesty budget. Measured at
 * 0.28 it is 0.19-0.39% of the tile over every weather state and wind heading;
 * at the sea's own 0.474 it would be about 7%.
 */
export const CAUSTIC_FOCUS_SIGMA = 0.28;

/**
 * k-space annulus area each ring member stands for, in the same units as the
 * wavevectors, so an amplitude can be drawn as sqrt(2 * P(k) * dA).
 *
 * Ring radius is the mean |n| of the ring's members; the annulus edges sit at
 * the geometric means of neighbouring radii, and the outermost two edges are
 * extrapolated geometrically so the first and last rings are not truncated.
 * Pure geometry, so it is computed once at module load rather than per rebake.
 */
const RING_AREA = (() => {
  const base = TAU / RENDER.CAUSTICS_SCALE;
  const radii = [];
  let o = 0;
  for (const m of RING_SIZES) {
    let s = 0;
    for (let i = 0; i < m; i++) s += Math.hypot(LATTICE[o + i][0], LATTICE[o + i][1]);
    radii.push(s / m);
    o += m;
  }
  const n = radii.length;
  const edges = new Array(n + 1);
  for (let r = 1; r < n; r++) edges[r] = Math.sqrt(radii[r - 1] * radii[r]);
  edges[0] = (radii[0] * radii[0]) / edges[1];
  edges[n] = (radii[n - 1] * radii[n - 1]) / edges[n - 1];

  const out = new Float64Array(CAUSTIC_WAVES);
  o = 0;
  for (let r = 0; r < n; r++) {
    const kIn = edges[r] * base;
    const kOut = edges[r + 1] * base;
    const dA = (Math.PI * (kOut * kOut - kIn * kIn)) / RING_SIZES[r];
    for (let i = 0; i < RING_SIZES[r]; i++) out[o++] = dA;
  }
  return out;
})();

/**
 * Mip levels of the caustics target, base included, so MIP_LEVELS - 1 box
 * dispatches run. DERIVED from the same constant renderer.js declares the
 * texture and the CAUSTIC_MAX_LOD define with - dispatching fewer levels than
 * the texture carries leaves the tail levels holding undefined contents, and
 * nothing would report it.
 */
const MIP_LEVELS = RENDER.CAUSTICS_MIP_LEVELS;

/**
 * @param {import('../../sim/ocean.js').OceanSim} sim
 * @returns {object} a frame-graph pass
 */
export function createCausticsPass(sim) {
  let pipeline = null;
  let layout = null;
  let group = null;
  let uniformBuffer = null;
  let mipPipeline = null;
  let mipLayout = null;
  /** @type {GPUBindGroup[]} one per destination level, index 0 = level 1. */
  let mipGroups = [];
  /** @type {GPUBuffer[]} destination dimensions, one per destination level. */
  let mipBuffers = [];
  let resolution = RENDER.CAUSTICS_RESOLUTION;
  let lastWind = -1;
  let lastWindAngle = 0;

  const data = new Float32Array(8 + CAUSTIC_WAVES * 8);
  const mipDims = new Uint32Array(4);
  /**
   * Scope names, hoisted: they are Map keys in profiler._sample, so building
   * them per frame allocated four strings a frame for nothing. The DESCRIPTOR
   * objects are deliberately still fresh per frame - profiler.gpuPass() mutates
   * the descriptor it is handed and returns early WITHOUT clearing
   * timestampWrites when profiling is off or the scope cap is hit, so a reused
   * object would carry a stale query index into a frame that never wrote it.
   */
  const MIP_NAMES = Array.from({ length: MIP_LEVELS - 1 }, (_, i) => `caustics.mip${i + 1}`);

  return {
    name: 'caustics',
    type: 'compute',
    writes: ['caustics'],

    enabled(ctx) {
      return !!pipeline && ctx.gpu.preset.caustics;
    },

    init(ctx) {
      resolution = ctx.targets.size('caustics').width;
      uniformBuffer = createUniformBuffer(ctx.device, data.byteLength, 'caustics-params');
      for (let m = 1; m < MIP_LEVELS; m++) {
        mipBuffers.push(createUniformBuffer(ctx.device, 16, `caustics-mip${m}-params`));
      }

      const module = ctx.shaders.module('sim/caustics.wgsl', {}, 'caustics');
      layout = ctx.pipelines.bindGroupLayout('caustics.bgl', [
        { binding: 0, visibility: STAGE.C, buffer: { type: 'uniform' } },
        {
          binding: 1, visibility: STAGE.C,
          storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
        },
      ]);
      pipeline = ctx.pipelines.computePipeline({
        label: 'caustics',
        layout: ctx.pipelines.pipelineLayout('caustics.pl', [layout]),
        compute: { module, entryPoint: 'cs_caustics' },
      });

      const mipModule = ctx.shaders.module('sim/caustics_mip.wgsl', {}, 'caustics-mip');
      mipLayout = ctx.pipelines.bindGroupLayout('caustics.mip.bgl', [
        { binding: 0, visibility: STAGE.C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: STAGE.C, texture: { sampleType: 'unfilterable-float' } },
        {
          binding: 2, visibility: STAGE.C,
          storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
        },
      ]);
      mipPipeline = ctx.pipelines.computePipeline({
        label: 'caustics.mip',
        layout: ctx.pipelines.pipelineLayout('caustics.mip.pl', [mipLayout]),
        compute: { module: mipModule, entryPoint: 'cs_caustics_mip' },
      });

      rebuild(ctx);
      buildWaves();
    },

    resize(ctx) {
      resolution = ctx.targets.size('caustics').width;
      rebuild(ctx);
    },

    execute(ctx, encoder) {
      const spectrum = sim.spectrum;
      // Direction as well as speed: Phillips' cos^2 spreading means the tile's
      // amplitudes are a function of the wind's HEADING too, so a veering wind
      // that never changes speed would otherwise leave the filaments aligned to
      // a sea that no longer exists. Speed alone no longer moves the pattern's
      // contrast - that is what pinning sigma buys - but it still moves which
      // ring carries the variance, so both tests stay.
      const angle = Math.atan2(spectrum.windDir[1], spectrum.windDir[0]);
      if (Math.abs(spectrum.windSpeed - lastWind) > 0.25 ||
          Math.abs(angleDelta(lastWindAngle, angle)) > 0.08) buildWaves();

      data[0] = sim.time;
      data[1] = RENDER.CAUSTICS_SCALE;
      data[2] = INTENSITY_CLAMP;
      data[3] = RECEIVER_DEPTH;
      data[4] = 1 - 1 / IOR_RGB[0];
      data[5] = 1 - 1 / IOR_RGB[1];
      data[6] = 1 - 1 / IOR_RGB[2];
      data[7] = resolution;
      ctx.device.queue.writeBuffer(uniformBuffer, 0, data.buffer, 0, data.byteLength);

      const pass = encoder.beginComputePass(profiler.gpuPass({ label: 'caustics' }, 'caustics'));
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      const g = Math.ceil(resolution / 8);
      pass.dispatchWorkgroups(g, g, 1);
      pass.end();

      // ONE COMPUTE PASS PER LEVEL. Level m samples level m-1 while writing
      // level m, and a texture bound as a writable storage target and as a
      // sampled texture inside ONE synchronisation scope is rejected by WebGPU
      // even when the mip ranges are disjoint - the same rule the shadow atlas
      // note in CLAUDE.md records. Each level also gets its own profiler scope
      // name: profiler._sample() AVERAGES same-named scopes, so four passes
      // under one name would report the cost of a single level.
      for (let m = 1; m < MIP_LEVELS; m++) {
        const w = Math.max(1, resolution >> m);
        const name = MIP_NAMES[m - 1];
        const mip = encoder.beginComputePass(profiler.gpuPass({ label: name }, name));
        mip.setPipeline(mipPipeline);
        mip.setBindGroup(0, mipGroups[m - 1]);
        const mg = Math.ceil(w / 8);
        mip.dispatchWorkgroups(mg, mg, 1);
        mip.end();
      }
    },

    destroy() {
      uniformBuffer?.destroy();
      for (const b of mipBuffers) b.destroy();
      mipBuffers = [];
      mipGroups = [];
    },
  };

  function rebuild(ctx) {
    if (!layout) return;
    // A storage-texture binding must name exactly ONE mip level, so the base
    // dispatch cannot use the full five-level view that bind group 0 samples.
    group = ctx.device.createBindGroup({
      label: 'caustics.bg',
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        {
          binding: 1,
          resource: ctx.targets.subView('caustics', { baseMipLevel: 0, mipLevelCount: 1 }),
        },
      ],
    });

    mipGroups = [];
    for (let m = 1; m < MIP_LEVELS; m++) {
      const w = Math.max(1, resolution >> m);
      mipDims[0] = w;
      mipDims[1] = w;
      mipDims[2] = 0;
      mipDims[3] = 0;
      ctx.device.queue.writeBuffer(mipBuffers[m - 1], 0, mipDims);
      mipGroups.push(ctx.device.createBindGroup({
        label: `caustics.mip${m}.bg`,
        layout: mipLayout,
        entries: [
          { binding: 0, resource: { buffer: mipBuffers[m - 1] } },
          {
            binding: 1,
            resource: ctx.targets.subView('caustics', { baseMipLevel: m - 1, mipLevelCount: 1 }),
          },
          {
            binding: 2,
            resource: ctx.targets.subView('caustics', { baseMipLevel: m, mipLevelCount: 1 }),
          },
        ],
      }));
    }
  }

  /**
   * Resample the tile's wave set from the current wind.
   *
   * Amplitudes are VARIANCE-CORRECT: A = sqrt(2 * P(k) * dA), where dA is the
   * annulus area the ring member represents. Drawing sqrt(P(k)) instead - which
   * is what shipped - treats a representative mode as a point sample of a
   * DENSITY, and on this spectrum that makes the curvature per mode A*k^2
   * proportional to k^0, i.e. flat: a 0.57 m ring and a 14 m ring would carry
   * equal weight and the spectrum's own shape would be discarded. With the bin
   * area in, sum A^2/2 equals the integral of P over the covered band and the
   * curvature per mode goes as k, which is Phillips' saturation range.
   *
   * The set is then rescaled so sigma = sqrt(3/8) * c * rms_F(Hessian) hits
   * CAUSTIC_FOCUS_SIGMA - the Frobenius rms, NOT rms(h_xx); see the constant's
   * docstring and the comment on sigmaRaw below. Without that rescale the
   * pattern's contrast would swing over several orders of magnitude with wind
   * speed, because Phillips does.
   */
  function buildWaves() {
    const spectrum = sim.spectrum;
    const base = TAU / RENDER.CAUSTICS_SCALE;
    const c = RECEIVER_DEPTH * (1 - 1 / IOR_RGB[1]);

    const amps = new Float64Array(CAUSTIC_WAVES);
    const kmags = new Float64Array(CAUSTIC_WAVES);
    let sumSq = 0;

    for (let i = 0; i < CAUSTIC_WAVES; i++) {
      const kx = LATTICE[i][0] * base;
      const kz = LATTICE[i][1] * base;
      const kmag = Math.hypot(kx, kz);
      kmags[i] = kmag;
      amps[i] = Math.sqrt(Math.max(2 * spectrum.phillips(kx, kz, kmag) * RING_AREA[i], 0));
      const q = amps[i] * kmag * kmag;
      sumSq += q * q;
    }

    // sqrt(3/8) * c * rms_F(Hessian), in closed form and O(N): with random
    // phases E[h_xx^2 + h_zz^2 + 2 h_xz^2] = 1/2 * sum (A k^2)^2 for ANY
    // direction spread, and 3/16 = 3/8 * 1/2. It is NOT c*rms(h_xx) - see the
    // CAUSTIC_FOCUS_SIGMA docstring; that one swings 2.2x with the wind heading
    // and this does not move at all.
    const sigmaRaw = c * Math.sqrt((3 / 16) * sumSq);
    const scale = sigmaRaw > 1e-12 ? CAUSTIC_FOCUS_SIGMA / sigmaRaw : 0;

    for (let i = 0; i < CAUSTIC_WAVES; i++) {
      const o = 8 + i * 8;
      data[o + 0] = LATTICE[i][0] * base;
      data[o + 1] = LATTICE[i][1] * base;
      data[o + 2] = amps[i] * scale;
      // The ocean's own quantised dispersion, so a saved game restores the
      // caustics in the same phase as the waves that cast them.
      data[o + 3] = spectrum.omega(kmags[i]);
      // Deterministic, evenly spread phases from the golden ratio.
      data[o + 4] = ((i * 0.6180339887) % 1) * TAU;
      data[o + 5] = 0;
      data[o + 6] = 0;
      data[o + 7] = 0;
    }
    lastWind = spectrum.windSpeed;
    lastWindAngle = Math.atan2(spectrum.windDir[1], spectrum.windDir[0]);
  }
}
