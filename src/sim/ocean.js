/**
 * SUBWAVE ocean wave simulation.
 *
 * A linear, directional, wind-driven gravity-wave field. The spectrum is
 * Phillips (Tessendorf's form, with the k -> 0 divergence killed by the
 * exp(-1/(kL)^2) factor and everything below OCEAN.MIN_WAVELENGTH suppressed),
 * split across three band-limited cascades, evolved with the deep-water
 * dispersion relation and synthesised by an inverse FFT in compute.
 *
 * THREE THINGS IN THIS FILE ARE LOAD-BEARING AND EASY TO GET WRONG:
 *
 * 1. The GPU field and the CPU query must agree, because buoyancy, the
 *    waterline and the half-submerged camera mask all run off
 *    `sampleHeightCPU`. The CPU surrogate is built from the SAME h0 lattice -
 *    same integer hash, same Box-Muller, same band weights - by taking the 32
 *    strongest modes with their true wavevectors and phases, then matching the
 *    total variance. Read the note on `sampleHeightCPU` for exactly what that
 *    does and does not guarantee; the short version is that Hs, the peak
 *    period, the dominant direction and the swell phase are right, and
 *    `cpuPointwiseRms` measures what is left over.
 *
 * 2. Loop quantisation. Every angular frequency is snapped to a multiple of
 *    2*PI/LOOP_PERIOD, so the entire field is exactly periodic with a 200 s
 *    period. That lets `time` be wrapped into [0, 200) with no drift, which
 *    keeps f32 phase precision constant no matter how long the session runs -
 *    an unwrapped clock loses a wave crest of precision after about four hours.
 *
 * 3. Amplitude normalisation, and it is PER BAND. The Phillips form sets the
 *    SHAPE; the absolute scale is normalised so the field's significant wave
 *    height is exactly the sea state's Hs from constants.js. Without that step
 *    the drawn sea and the gameplay sea state are unrelated numbers that happen
 *    to share a name - but with a SINGLE scale it also pins the chop, because a
 *    Phillips spectrum normalised to Hs has a wind-independent high-k tail (see
 *    OCEAN.RESOLVED_SLOPE_FRACTION). The swell band and the short bands are
 *    therefore scaled separately, the short bands against Cox & Munk's measured
 *    slope variance and the swell band re-solved so the total is still exactly
 *    Hs^2/16.
 */

import {
  createUniformBuffer, createStorageBuffer, createTexture,
  TextureUsage, mipCount,
} from '../core/resources.js';
import { profiler } from '../core/profiler.js';
import { OCEAN, WORLD, TRUE_DARK_DEPTH } from '../core/constants.js';
import { clamp, angleDelta, TAU } from '../core/math.js';
import { createOceanSurfacePass } from '../render/passes/ocean.js';
import { createUnderwaterPass } from '../render/passes/underwater.js';
import { createCausticsPass } from '../render/passes/caustics.js';

/** Real seconds after which the whole wave field repeats exactly. */
export const OCEAN_LOOP_PERIOD = 200.0;

/**
 * Cox & Munk's total mean-square surface slope for a wind of U10 m/s - the 1954
 * sun-glitter photogrammetry result, still the reference measurement.
 *
 * Mirrors `oceanCoxMunkSlopeVariance` in shaders/common/ocean.wgsl exactly. The
 * bake uses it as the target the resolved cascades are renormalised onto, and
 * the surface shader uses it as the total the specular roughness makes up the
 * difference to; they have to be the same curve or the two disagree about how
 * much slope exists.
 * @param {number} u10 wind speed at 10 m, m/s
 */
export function coxMunkSlopeVariance(u10) {
  return 0.003 + 0.00512 * Math.max(u10, 0);
}

/**
 * Horizontal displacement gain per cascade, as a multiple of OCEAN.CHOPPINESS.
 * The long swell must stay near 1.0 or it self-intersects; the ripple cascade
 * can be pushed hardest because its Jacobian is clamped by the foam threshold
 * long before the geometry folds visibly.
 */
export const OCEAN_CASCADE_CHOP = [0.74074, 1.0, 1.18519];

/** Number of complex fields carried through the IFFT (see ocean_spectrum.wgsl). */
export const OCEAN_FIELDS = 4;

/**
 * Gerstner modes in the CPU surrogate and the LOW-tier vertex path.
 *
 * 32 is where the curve flattens. The Phillips spectrum on a 256^2 x 3 lattice
 * spreads its energy over ~27,000 live modes; the strongest 16 hold 6% of the
 * variance at sea state 4 and the strongest 512 hold only 41%. Mode count
 * therefore cannot buy pointwise agreement with the drawn field - which is why
 * the amplitudes are energy-matched instead (see `bake`).
 */
export const OCEAN_GERSTNER_WAVES = 32;

/**
 * Jacobian -> foam conversion gain. With FOAM_JACOBIAN_THRESHOLD = 0.52 this
 * saturates the accumulator at J = -0.17, i.e. only where the surface has
 * genuinely folded rather than merely steepened.
 */
export const OCEAN_FOAM_GAIN = 1.45;

/** Total Gerstner steepness is scaled down to this so crests cannot fold over. */
const MAX_TOTAL_STEEPNESS = 0.85;

/**
 * Ceiling on the energy-matching gain. In a nearly flat sea the selected modes
 * hold a vanishing share of an already vanishing variance, and an uncapped gain
 * would turn numerical dust into visible waves.
 */
const MAX_ENERGY_GAIN = 6.0;

/** Lattice radius, in bins, searched when extracting the dominant modes. */
const MODE_SEARCH_RADIUS = 48;

/** Re-bake the spectrum when the wind moves by more than this. */
const REBAKE_SPEED_DELTA = 0.35;      // m/s
const REBAKE_DIR_DELTA = 0.08;        // radians

// ---------------------------------------------------------------------------
// The spectral model, mirrored bit-for-bit by common/ocean.wgsl
// ---------------------------------------------------------------------------

/** triple32. Must match `oceanHashU32` in common/ocean.wgsl exactly. */
function hashU32(x) {
  let h = x >>> 0;
  h = (h ^ (h >>> 17)) >>> 0; h = Math.imul(h, 0xed5ad4bb) >>> 0;
  h = (h ^ (h >>> 11)) >>> 0; h = Math.imul(h, 0xac4c1b51) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0; h = Math.imul(h, 0x31848bab) >>> 0;
  h = (h ^ (h >>> 14)) >>> 0;
  return h;
}

function hashCell(n, m, cascade, seed) {
  const s = (Math.imul(n, 0x9e3779b1) + Math.imul(m, 0x85ebca6b) +
             Math.imul(cascade, 0xc2b2ae35) + seed) >>> 0;
  return hashU32(s);
}

const INV_U32 = 2.3283064365386963e-10;

/** The GPU's smoothstep, so the band weights match to the last bit. */
const smooth01 = (e0, e1, x) => {
  const t = clamp((x - e0) / Math.max(e1 - e0, 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Two standard normals, written into `out`. Mirrors `oceanGauss2`. */
function gauss2(out, n, m, cascade, seed) {
  const h0 = hashCell(n, m, cascade, seed);
  const h1 = hashU32(h0 ^ 0x68bc21eb);
  const u1 = (h0 + 0.5) * INV_U32;
  const u2 = (h1 + 0.5) * INV_U32;
  const r = Math.sqrt(-2.0 * Math.log(u1));
  const theta = TAU * u2;
  out[0] = r * Math.cos(theta);
  out[1] = r * Math.sin(theta);
  return out;
}

/**
 * The spectral model as a plain object so it can be constructed, evaluated and
 * unit-tested without a GPU. `bake()` returns everything the CPU query and the
 * uniform upload need.
 */
export class OceanSpectrum {
  /**
   * @param {{seed?: number, cascadeSizes?: number[], fftSize?: number,
   *          cascadeCount?: number}} [opts]
   */
  constructor(opts = {}) {
    this.seed = (opts.seed != null ? opts.seed : WORLD.DEFAULT_SEED) >>> 0;
    this.cascadeSizes = opts.cascadeSizes || OCEAN.CASCADE_SIZES;
    this.n = opts.fftSize || OCEAN.FFT_SIZE;
    this.cascadeCount = opts.cascadeCount || 3;

    this.windSpeed = 4.5;
    this.windDir = [1, 0];
    this.hs = 0.32;
    this.gravity = OCEAN.GRAVITY;
    this.minWavelength = OCEAN.MIN_WAVELENGTH;
    this.chopScale = 1.0;

    /**
     * Per-cascade h0 amplitude scale. Cascade 0 is solved so the TOTAL variance
     * is exactly hs^2/16; cascades 1 and 2 share the band gain that puts the
     * resolved slope on Cox & Munk's curve. See `bake`.
     */
    this.h0Scales = new Float64Array(3).fill(1);
    /** The gain applied to the short bands over the plain Hs normalisation. */
    this.bandGain = 1;
    /** Mean-square surface slope the three cascades actually resolve. */
    this.mssResolved = 0;
    /** Total surface variance of the full field, m^2. */
    this.m0 = 0;
    /** Variance carried by the Gerstner surrogate after energy matching, m^2. */
    this.m0Gerstner = 0;
    /** Amplitude gain applied to reach the true variance. */
    this.energyGain = 1;
    /** Variance the surrogate fails to represent, metres RMS. Zero once matched. */
    this.cpuRmsError = 0;
    /** RMS pointwise difference between the surrogate and the drawn field, metres. */
    this.cpuPointwiseRms = 0;

    /** (kx, kz, amp, omega, phase, invK, steepness, 0) x OCEAN_GERSTNER_WAVES. */
    this.waves = new Float32Array(OCEAN_GERSTNER_WAVES * 8);

    this._g2 = new Float32Array(2);
  }

  /** Cascade tile size in metres. */
  size(c) { return this.cascadeSizes[c]; }

  /**
   * Cascade 0's h0 scale. `h0Scales` is authoritative; this is the single
   * number tools/probes/ocean-field.js reports, and it is the swell band's.
   */
  get h0Scale() { return this.h0Scales[0]; }

  /**
   * Phillips, identical to `oceanPhillips` in the shader.
   *
   * NO AMPLITUDE CONSTANT. There used to be an `OCEAN.PHILLIPS_A` here and it
   * tuned nothing whatsoever: `bake()` normalises the field to the sea state's
   * Hs, so every amplitude appears as A * scale^2 = hs^2/16 regardless of A.
   * Measured before it was removed - forcing A to 10x and to 1/10 and re-running
   * the whole GPU pipeline gave cascade RMS heights of 0.07464 / 0.07466 /
   * 0.07468 m, bit-for-bit the same sea across a 100x range, with only h0Scale
   * moving (16.99 / 5.373 / 53.726, exactly proportional to 1/sqrt(A)). Anyone
   * told to "tune PHILLIPS_A to fix the sea" changed nothing and concluded the
   * FFT was broken. The levers on short-wave slope are MIN_WAVELENGTH and the
   * per-band gain in `bake()`.
   *
   * @param {number} kx @param {number} kz @param {number} kmag
   */
  phillips(kx, kz, kmag) {
    if (kmag < 1e-6) return 0;
    const u10 = Math.max(this.windSpeed, 0.05);
    const bigL = (u10 * u10) / this.gravity;
    const k2 = kmag * kmag;
    const k4 = k2 * k2;
    const c = (kx * this.windDir[0] + kz * this.windDir[1]) / kmag;
    let dir = c * c;
    if (c < 0) dir *= 0.055;
    const l = this.minWavelength;
    return Math.exp(-1 / (k2 * bigL * bigL)) / k4 * dir * Math.exp(-k2 * l * l);
  }

  /** Partition of unity across cascades. Identical to `oceanBandWeight`. */
  bandWeight(kmag, cascade) {
    const n = this.n;
    const count = this.cascadeCount;
    const taper = 1.26;
    const k01 = (Math.PI * n / this.cascadeSizes[0]) / taper;
    const k12 = (Math.PI * n / this.cascadeSizes[1]) / taper;
    const w01 = smooth01(k01 / taper, k01 * taper, kmag);
    const w12 = smooth01(k12 / taper, k12 * taper, kmag);
    if (count < 2) return 1;
    if (count < 3) return cascade === 0 ? 1 - w01 : w01;
    if (cascade === 0) return 1 - w01;
    if (cascade === 1) return w01 * (1 - w12);
    return w12;
  }

  /**
   * Quantised deep-water dispersion. Identical to `oceanOmega`, including the
   * tanh clamp - Math.tanh is exact for a large argument and WGSL's is not, so
   * the clamp lives on this side purely to keep the two definitions the same
   * text. tanh(20) is 1.0 to double precision, so it changes nothing here.
   */
  omega(kmag) {
    const w = Math.sqrt(this.gravity * kmag * Math.tanh(Math.min(kmag * 400.0, 20.0)));
    const w0 = TAU / OCEAN_LOOP_PERIOD;
    return Math.floor(w / w0 + 0.5) * w0;
  }

  /**
   * Mean square amplitude of h0 at one lattice site, before the random draw and
   * the h0 scale. Mirrors
   * `oceanH0` in the shader, including the zeroed n = 0 / m = 0 edges: those
   * sites are their own mirror under k -> -k, so leaving them populated puts an
   * unpaired non-Hermitian mode in the spectrum and the height field comes back
   * with an imaginary part.
   */
  modeAmplitude(n, m, kx, kz, kmag, cascade) {
    if (n === 0 || m === 0 || kmag < 1e-6) return 0;
    // The (2*PI/L)^2 bin area is not cosmetic and not absorbable into the
    // Phillips constant once there is more than one cascade - see oceanBinArea
    // in common/ocean.wgsl for what dropping it does to the sea.
    const dk = TAU / this.cascadeSizes[cascade];
    return this.phillips(kx, kz, kmag) * this.bandWeight(kmag, cascade) * dk * dk;
  }

  /**
   * Recompute the amplitude normalisation and the dominant-mode table for the
   * current wind. O(N^2 * cascades) for the variance sum plus a bounded search
   * for the modes - about 15 ms at N = 256, and it only runs when the weather
   * actually changes.
   */
  bake() {
    const N = this.n;
    const half = N * 0.5;

    // --- variance and slope variance, PER BAND -----------------------------
    // E|h0(k)|^2 = P(k) * W_c(k) for a unit scale, and the real surface sums a
    // mode and its mirror, so cascade c contributes 2 * scale_c^2 * sumPW[c] to
    // the height variance and 2 * scale_c^2 * sumK2PW[c] to the mean-square
    // slope. Both accumulators ride the same O(N^2 * cascades) loop.
    const sumPW = [0, 0, 0];
    const sumK2PW = [0, 0, 0];
    for (let c = 0; c < this.cascadeCount; c++) {
      const dk = TAU / this.cascadeSizes[c];
      for (let m = 0; m < N; m++) {
        const kz = (m - half) * dk;
        for (let n = 0; n < N; n++) {
          const kx = (n - half) * dk;
          const kmag = Math.hypot(kx, kz);
          const p = this.modeAmplitude(n, m, kx, kz, kmag, c);
          sumPW[c] += p;
          sumK2PW[c] += kmag * kmag * p;
        }
      }
    }

    // --- band renormalisation ---------------------------------------------
    //
    // A SINGLE Hs scale gives the sea a wind-INDEPENDENT chop. That is
    // arithmetic, not a slip: m0 = 0.5275*PI*A*L^2 with L = U^2/g, while the
    // variance above a wavenumber k0 >> 1/L is PI*A/(2*k0^2) with no L in it at
    // all - so dividing by sqrt(m0) to hit Hs divides the high-k tail by L and
    // the Douglas table has Hs proportional to U^2 exactly. Measured: cascade 1's
    // RMS height went 0.0283 -> 0.0331 -> 0.0338 -> 0.0304 m across sea states
    // 2/3/4/6 while cascade 0's went 0.0748 -> 1.05 m, and the total resolved
    // slope variance ran 0.0070 -> 0.0156 against Cox-Munk's 0.0260 -> 0.0849.
    //
    // So the short bands are scaled to a slope TARGET and cascade 0 is then
    // re-solved to put the total variance back on Hs^2/16 exactly.
    let totalPW = 0;
    let hiPW = 0;
    let hiK2PW = 0;
    for (let c = 0; c < this.cascadeCount; c++) totalPW += sumPW[c];
    for (let c = 1; c < this.cascadeCount; c++) { hiPW += sumPW[c]; hiK2PW += sumK2PW[c]; }

    const base = totalPW > 1e-20 ? this.hs / (4 * Math.sqrt(2 * totalPW)) : 0;
    const b2 = 2 * base * base;
    const varLo = b2 * sumPW[0];
    const varHi = b2 * hiPW;
    const target = OCEAN.RESOLVED_SLOPE_FRACTION * coxMunkSlopeVariance(this.windSpeed);
    // What cascade 0 already contributes to the slope is not the short bands' to
    // find, so it comes off the target first.
    const deficit = Math.max(target - b2 * sumK2PW[0], 0);
    const mssHi = b2 * hiK2PW;
    // The swell may not be borrowed against past SWELL_VARIANCE_FLOOR, or a
    // nearly flat sea - where cascade 0 holds almost nothing to begin with -
    // drives its scale to zero and Hs overshoots.
    const gainCap = Math.sqrt(1 + (1 - OCEAN.SWELL_VARIANCE_FLOOR) * varLo / Math.max(varHi, 1e-30));
    const bandGain = mssHi > 1e-30
      ? clamp(Math.sqrt(deficit / mssHi), 1, Math.min(OCEAN.MAX_BAND_GAIN, gainCap))
      : 1;

    const hiVar = bandGain * bandGain * varHi;
    this.h0Scales[0] = sumPW[0] > 1e-30
      ? Math.sqrt(Math.max(this.hs * this.hs / 16 - hiVar, 0) / (2 * sumPW[0]))
      : 0;
    this.h0Scales[1] = base * bandGain;
    this.h0Scales[2] = base * bandGain;
    this.bandGain = bandGain;

    this.m0 = 0;
    this.mssResolved = 0;
    for (let c = 0; c < this.cascadeCount; c++) {
      const s2 = 2 * this.h0Scales[c] * this.h0Scales[c];
      this.m0 += s2 * sumPW[c];
      this.mssResolved += s2 * sumK2PW[c];
    }

    // --- extract the dominant travelling modes ----------------------------
    // Grouping the lattice site k with its mirror -k gives two travelling
    // waves. The one belonging to site k has wavevector -k, real amplitude
    // 2|h0(k)| and phase -arg(h0(k)); enumerating every site therefore
    // enumerates every wave exactly once.
    const best = [];
    const radius = Math.min(half, MODE_SEARCH_RADIUS);
    for (let c = 0; c < this.cascadeCount; c++) {
      const dk = TAU / this.cascadeSizes[c];
      const chop = OCEAN_CASCADE_CHOP[c] * OCEAN.CHOPPINESS * this.chopScale;
      const lo = Math.max(0, Math.floor(half - radius));
      const hi = Math.min(N, Math.ceil(half + radius));
      for (let m = lo; m < hi; m++) {
        const kz = (m - half) * dk;
        for (let n = lo; n < hi; n++) {
          const kx = (n - half) * dk;
          const kmag = Math.hypot(kx, kz);
          const p = this.modeAmplitude(n, m, kx, kz, kmag, c);
          if (p <= 0) continue;
          gauss2(this._g2, n, m, c, this.seed);
          const s = Math.sqrt(0.5 * p) * this.h0Scales[c];
          const re = this._g2[0] * s;
          const im = this._g2[1] * s;
          // Relative, not absolute: an absolute floor empties the candidate
          // list entirely in a glass-calm sea and the surrogate goes flat.
          const amp = 2 * Math.hypot(re, im);
          if (amp <= 0) continue;
          best.push({
            kx: -kx, kz: -kz, kmag, amp,
            phase: -Math.atan2(im, re),
            omega: this.omega(kmag),
            chop,
          });
        }
      }
    }
    best.sort((a, b) => b.amp - a.amp);
    const chosen = best.slice(0, OCEAN_GERSTNER_WAVES);

    // ENERGY MATCHING, and it is a deliberate trade.
    //
    // The selected modes are the strongest, so they carry the peak wavelength,
    // the dominant direction and the phase of the swell the player can see -
    // but only a few per cent of the total variance. Left unscaled, the vessel
    // would barely move in a sea drawn with metre-high waves, which is a far
    // worse failure than being out of phase with any particular crest.
    //
    // So a single gain brings the surrogate's variance up to the true m0.
    // Consequences, stated exactly:
    //   sigma_cpu == sigma_full, so Hs and the vessel's heave amplitude are right;
    //   the peak period and direction are right;
    //   the pointwise RMS difference from the drawn field is
    //     sqrt(2*m0 - 2*gain*captured), reported as `cpuPointwiseRms`.
    let raw = 0;
    for (const w of chosen) raw += 0.5 * w.amp * w.amp;
    const gain = raw > 1e-20 ? Math.min(Math.sqrt(this.m0 / raw), MAX_ENERGY_GAIN) : 1;

    // Bound the total steepness so the Gerstner sum cannot fold over itself.
    // sum(A_i * steepness_i * |k_i|) < 1 is the exact non-self-intersection
    // condition for a superposition of Gerstner waves.
    let steepSum = 0;
    for (const w of chosen) steepSum += w.amp * gain * w.chop * w.kmag;
    const steepScale = steepSum > MAX_TOTAL_STEEPNESS
      ? MAX_TOTAL_STEEPNESS / steepSum : 1;

    this.waves.fill(0);
    let captured = 0;
    for (let i = 0; i < chosen.length; i++) {
      const w = chosen[i];
      const amp = w.amp * gain;
      const o = i * 8;
      this.waves[o + 0] = w.kx;
      this.waves[o + 1] = w.kz;
      this.waves[o + 2] = amp;
      this.waves[o + 3] = w.omega;
      this.waves[o + 4] = w.phase;
      this.waves[o + 5] = 1 / w.kmag;
      this.waves[o + 6] = w.chop * steepScale;
      this.waves[o + 7] = 0;
      captured += 0.5 * amp * amp;   // variance of a cosine of amplitude A
    }
    this.m0Gerstner = captured;
    this.energyGain = gain;
    this.cpuRmsError = Math.sqrt(Math.max(0, this.m0 - this.m0Gerstner));
    this.cpuPointwiseRms = Math.sqrt(Math.max(0, this.m0 + this.m0Gerstner - 2 * gain * raw));
    return this;
  }

  /**
   * Displacement and slope of the Gerstner sum at a LATTICE point.
   * Writes [dx, dy, dz, slopeX, slopeZ] into `out`. Allocation-free.
   */
  gerstnerAt(out, px, pz, t) {
    let dx = 0, dy = 0, dz = 0, sx = 0, sz = 0;
    const w = this.waves;
    for (let i = 0; i < OCEAN_GERSTNER_WAVES; i++) {
      const o = i * 8;
      const amp = w[o + 2];
      if (amp <= 0) continue;
      const kx = w[o + 0], kz = w[o + 1];
      const phase = kx * px + kz * pz - w[o + 3] * t + w[o + 4];
      const s = Math.sin(phase);
      const c = Math.cos(phase);
      dy += amp * c;
      const q = amp * w[o + 6] * w[o + 5] * s;
      dx -= kx * q;
      dz -= kz * q;
      sx -= kx * amp * s;
      sz -= kz * amp * s;
    }
    out[0] = dx; out[1] = dy; out[2] = dz; out[3] = sx; out[4] = sz;
    return out;
  }
}

// ---------------------------------------------------------------------------
// OceanSim
// ---------------------------------------------------------------------------

export class OceanSim {
  /**
   * @param {GPUDevice|object} deviceOrRenderer a GPUDevice, or the Renderer
   *   (which is what main.js hands us - it carries the device, the shader
   *   library, the pipeline cache and the quality preset in one object).
   * @param {import('../core/shaderlib.js').ShaderLibrary} [shaders]
   * @param {import('../core/pipelines.js').PipelineCache} [pipelines]
   */
  constructor(deviceOrRenderer, shaders, pipelines) {
    const isRenderer = deviceOrRenderer && deviceOrRenderer.gpu && deviceOrRenderer.shaders;
    /** @type {object|null} */
    this.renderer = isRenderer ? deviceOrRenderer : null;
    this.device = isRenderer ? deviceOrRenderer.gpu.device : deviceOrRenderer;
    this.shaders = isRenderer ? deviceOrRenderer.shaders : shaders;
    this.pipelines = isRenderer ? deviceOrRenderer.pipelines : pipelines;
    this.preset = isRenderer ? deviceOrRenderer.gpu.preset : null;

    const preset = this.preset || {};
    this.n = preset.oceanFftSize || OCEAN.FFT_SIZE;
    this.cascadeCount = preset.oceanCascades || 3;
    this.gerstnerOnly = !!preset.oceanGerstnerFallback;

    this.spectrum = new OceanSpectrum({
      seed: WORLD.DEFAULT_SEED,
      cascadeSizes: OCEAN.CASCADE_SIZES,
      fftSize: this.n,
      cascadeCount: this.cascadeCount,
    });

    /** Wrapped into [0, OCEAN_LOOP_PERIOD): the field is exactly periodic. */
    this.time = 0;

    this.uniformBuffer = null;
    this.hktBuffer = null;
    this.h0Texture = null;
    this.displacementTexture = null;
    this.derivativeTexture = null;
    this.foamTextures = [null, null];
    this.mipLevels = 1;

    // 7 vec4 header + 2 vec4 per Gerstner wave. Must match OceanParams in
    // shaders/common/ocean.wgsl.
    this._uniformData = new Float32Array(28 + OCEAN_GERSTNER_WAVES * 8);
    this._uniformU32 = new Uint32Array(this._uniformData.buffer);
    this._scratch = new Float32Array(5);
    this._surface = { height: 0, dispX: 0, dispZ: 0, nx: 0, ny: 1, nz: 0 };

    this._bakeDirty = true;
    // -1 is an impossible wind speed, so the first update() always bakes; there
    // is no such sentinel for an angle, which wraps.
    this._lastWindSpeed = -1;
    this._lastWindAngle = 0;
    this._parity = 0;
    this._ready = false;
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  async init() {
    this.spectrum.bake();

    if (this.shaders) {
      await this.shaders.preload([
        'sim/ocean_spectrum.wgsl',
        'sim/ocean_fft.wgsl',
        'sim/ocean_foam.wgsl',
        'sim/caustics.wgsl',
        'pass/ocean_surface.wgsl',
        'pass/underwater.wgsl',
      ]);
    }

    this.uniformBuffer = createUniformBuffer(this.device, this._uniformData.byteLength, 'ocean-params');
    this._writeUniform(0);

    // The cascade textures exist even on the Gerstner path, at 4x4, so the
    // surface pass has exactly one bind-group layout to build. Three texels per
    // cascade costs nothing and removes a whole branch from the render side.
    this._createTextures();
    if (!this.gerstnerOnly) {
      const hktBytes = OCEAN_FIELDS * this.cascadeCount * this.n * this.n * 8;
      this.hktBuffer = createStorageBuffer(this.device, hktBytes, 'ocean-hkt');
      this._buildPipelines();
    }
    this._ready = true;
    return this;
  }

  _createTextures() {
    const device = this.device;
    const N = this.gerstnerOnly ? 4 : this.n;
    const C = this.cascadeCount;
    this.mipLevels = mipCount(N, N);

    // COPY_SRC costs nothing at runtime and is what makes the synthesised field
    // verifiable: tools/probe.mjs can read a cascade back and measure that the
    // GPU's Hs, its displacement sign and its Jacobian agree with the CPU model
    // in src/sim/ocean.js. Without it the whole FFT path can only be checked by
    // looking at it.
    const arrayTex = (label, format, mips) => createTexture(device, {
      label, width: N, height: N, depthOrArrayLayers: C, format,
      mipLevelCount: mips,
      usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING
           | TextureUsage.COPY_SRC,
    });

    this.h0Texture = arrayTex('ocean-h0', 'rgba32float', 1);
    this.displacementTexture = arrayTex('ocean-displacement', 'rgba16float', this.mipLevels);
    this.derivativeTexture = arrayTex('ocean-derivative', 'rgba16float', this.mipLevels);
    // THE FOAM NEEDS A MIP CHAIN, and it did not have one while the Jacobian
    // threshold produced no foam anywhere. Whitecap coverage is an AREA
    // fraction, so a pixel covering 36 m of sea along the view ray has to read
    // the mean over those 36 m; sampled from mip 0 it reads a 0.25 m texel and
    // the far sea sparkles with individual whitecaps that are 18x smaller than
    // the pixel showing them.
    this.foamTextures[0] = arrayTex('ocean-foam-a', 'rgba16float', this.mipLevels);
    this.foamTextures[1] = arrayTex('ocean-foam-b', 'rgba16float', this.mipLevels);

    const view = (t, opts) => t.createView({ dimension: '2d-array', ...opts });
    const mip0 = { baseMipLevel: 0, mipLevelCount: 1 };
    this._views = {
      h0Storage: view(this.h0Texture),
      h0Sampled: view(this.h0Texture),
      dispStorage0: view(this.displacementTexture, mip0),
      derivStorage0: view(this.derivativeTexture, mip0),
      disp: view(this.displacementTexture),
      deriv: view(this.derivativeTexture),
      // Storage bindings address exactly one level; the sampled views carry the
      // whole chain.
      foamStorage: [view(this.foamTextures[0], mip0), view(this.foamTextures[1], mip0)],
      foamPrev: [view(this.foamTextures[0], mip0), view(this.foamTextures[1], mip0)],
      foamSampled: [view(this.foamTextures[0]), view(this.foamTextures[1])],
    };
  }

  _buildPipelines() {
    const device = this.device;
    const cache = this.pipelines;
    const N = this.n;
    const defines = {
      FFT_SIZE: N,
      FFT_LOG2: Math.round(Math.log2(N)),
      FFT_HALF: N >> 1,
      TRUE_DARK_DEPTH: TRUE_DARK_DEPTH.toFixed(1),
      OCEAN_CASCADES: this.cascadeCount,
    };

    const specModule = this.shaders.module('sim/ocean_spectrum.wgsl', defines, 'ocean-spectrum');
    const fftModule = this.shaders.module('sim/ocean_fft.wgsl', defines, 'ocean-fft');
    const foamModule = this.shaders.module('sim/ocean_foam.wgsl', defines, 'ocean-foam');

    const C = GPUShaderStage.COMPUTE;
    const uniformEntry = { binding: 0, visibility: C, buffer: { type: 'uniform' } };
    const storageTex = (binding, format = 'rgba16float') => ({
      binding, visibility: C,
      storageTexture: { access: 'write-only', format, viewDimension: '2d-array' },
    });
    const sampledTex = (binding, sampleType = 'float') => ({
      binding, visibility: C, texture: { sampleType, viewDimension: '2d-array' },
    });

    // --- bake -------------------------------------------------------------
    const bakeLayout = cache.bindGroupLayout('ocean.bake.bgl', [
      uniformEntry, storageTex(1, 'rgba32float'),
    ]);
    this._bakePipeline = cache.computePipeline({
      label: 'ocean.bake',
      layout: cache.pipelineLayout('ocean.bake.pl', [bakeLayout]),
      compute: { module: specModule, entryPoint: 'cs_bakeSpectrum' },
    });
    this._bakeGroup = device.createBindGroup({
      label: 'ocean.bake.bg', layout: bakeLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this._views.h0Storage },
      ],
    });

    // --- evolve -----------------------------------------------------------
    const evolveLayout = cache.bindGroupLayout('ocean.evolve.bgl', [
      uniformEntry,
      sampledTex(2, 'unfilterable-float'),
      { binding: 3, visibility: C, buffer: { type: 'storage' } },
    ]);
    this._evolvePipeline = cache.computePipeline({
      label: 'ocean.evolve',
      layout: cache.pipelineLayout('ocean.evolve.pl', [evolveLayout]),
      compute: { module: specModule, entryPoint: 'cs_evolve' },
    });
    this._evolveGroup = device.createBindGroup({
      label: 'ocean.evolve.bg', layout: evolveLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 2, resource: this._views.h0Sampled },
        { binding: 3, resource: { buffer: this.hktBuffer } },
      ],
    });

    // --- FFT --------------------------------------------------------------
    const fftLayout = cache.bindGroupLayout('ocean.fft.bgl', [
      { binding: 0, visibility: C, buffer: { type: 'storage' } },
    ]);
    const fftPl = cache.pipelineLayout('ocean.fft.pl', [fftLayout]);
    this._fftRowPipeline = cache.computePipeline({
      label: 'ocean.fft.row', layout: fftPl,
      compute: { module: fftModule, entryPoint: 'cs_fftRow' },
    });
    this._fftColPipeline = cache.computePipeline({
      label: 'ocean.fft.col', layout: fftPl,
      compute: { module: fftModule, entryPoint: 'cs_fftCol' },
    });
    this._fftGroup = device.createBindGroup({
      label: 'ocean.fft.bg', layout: fftLayout,
      entries: [{ binding: 0, resource: { buffer: this.hktBuffer } }],
    });

    // --- assemble ---------------------------------------------------------
    const assembleLayout = cache.bindGroupLayout('ocean.assemble.bgl', [
      uniformEntry,
      { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
      storageTex(2), storageTex(3), storageTex(4),
      sampledTex(5),
    ]);
    this._assemblePipeline = cache.computePipeline({
      label: 'ocean.assemble',
      layout: cache.pipelineLayout('ocean.assemble.pl', [assembleLayout]),
      compute: { module: foamModule, entryPoint: 'cs_assemble' },
    });
    this._assembleGroups = [0, 1].map((parity) => device.createBindGroup({
      label: `ocean.assemble.bg${parity}`, layout: assembleLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.hktBuffer } },
        { binding: 2, resource: this._views.dispStorage0 },
        { binding: 3, resource: this._views.derivStorage0 },
        { binding: 4, resource: this._views.foamStorage[parity] },
        // Mip 0 only: cs_assemble reads last frame's accumulator with an
        // explicit textureLoad at level 0, and a full-chain view here would be
        // a different binding for the same fetch.
        { binding: 5, resource: this._views.foamPrev[1 - parity] },
      ],
    }));

    // --- mip chain --------------------------------------------------------
    const mipLayout = cache.bindGroupLayout('ocean.mip.bgl', [
      sampledTex(6), storageTex(7),
    ]);
    this._mipPipeline = cache.computePipeline({
      label: 'ocean.mip',
      layout: cache.pipelineLayout('ocean.mip.pl', [mipLayout]),
      compute: { module: foamModule, entryPoint: 'cs_mipReduce' },
    });
    const mipChain = (tex) => {
      const steps = [];
      for (let level = 0; level + 1 < this.mipLevels; level++) {
        const size = Math.max(1, N >> (level + 1));
        steps.push({
          size,
          group: device.createBindGroup({
            label: `${tex.label}.mip${level + 1}`, layout: mipLayout,
            entries: [
              {
                binding: 6,
                resource: tex.createView({
                  dimension: '2d-array', baseMipLevel: level, mipLevelCount: 1,
                }),
              },
              {
                binding: 7,
                resource: tex.createView({
                  dimension: '2d-array', baseMipLevel: level + 1, mipLevelCount: 1,
                }),
              },
            ],
          }),
        });
      }
      return steps;
    };
    this._mipSteps = [
      ...mipChain(this.displacementTexture), ...mipChain(this.derivativeTexture),
    ];
    // The foam ping-pongs, so only the half written this frame is worth
    // reducing - the other half is last frame's and is about to be overwritten.
    this._foamMipSteps = [mipChain(this.foamTextures[0]), mipChain(this.foamTextures[1])];
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  /**
   * Advance the field and push the uniform. Call once per frame, before the
   * renderer encodes.
   * @param {number} dt seconds
   * @param {object} [renderer] the Renderer, for its `env` weather state
   */
  update(dt, renderer) {
    const env = (renderer || this.renderer)?.env;
    if (env) {
      const speed = env.windSpeed != null ? env.windSpeed : this.spectrum.windSpeed;
      const dir = env.windDir || this.spectrum.windDir;
      const angle = Math.atan2(dir[1], dir[0]);
      const seaState = OCEAN.SEA_STATES[clamp(Math.round(env.seaState || 0), 0, 9)];

      // angleDelta, not a raw subtraction: a wind that drifts across +/-PI is a
      // heading change of a few thousandths, and differencing the atan2 values
      // reads it as 2*PI and re-bakes - a 20 ms hitch - on every frame it hovers
      // there.
      if (Math.abs(speed - this._lastWindSpeed) > REBAKE_SPEED_DELTA ||
          Math.abs(angleDelta(this._lastWindAngle, angle)) > REBAKE_DIR_DELTA ||
          this.spectrum.hs !== seaState.hs) {
        const len = Math.max(Math.hypot(dir[0], dir[1]), 1e-6);
        this.spectrum.windSpeed = speed;
        this.spectrum.windDir[0] = dir[0] / len;
        this.spectrum.windDir[1] = dir[1] / len;
        this.spectrum.hs = seaState.hs;
        // `env.choppiness` is an ABSOLUTE gain - weather.js publishes
        // OCEAN.CHOPPINESS multiplied by its own sea-state ramp - while
        // `chopScale` is the dimensionless modifier its JSDoc and its default of
        // 1.0 declare, and _writeUniform multiplies by OCEAN.CHOPPINESS again.
        // Assigning the absolute straight in applied the constant TWICE: at sea
        // state 2 the uniform received 1.2825 where the intent was 0.950, every
        // cascade 1.35x over, and raising CHOPPINESS from 1.35 to 1.5 moved the
        // effective value from 1.822 to 2.25 rather than from 1.35 to 1.5.
        // Dividing it back out is what makes OCEAN.CHOPPINESS mean what it says
        // and what makes `hBound` in passes/ocean.js consistent with the
        // displacement it is bounding.
        this.spectrum.chopScale = env.choppiness != null
          ? env.choppiness / OCEAN.CHOPPINESS : 1.0;
        this.spectrum.bake();
        this._lastWindSpeed = speed;
        this._lastWindAngle = angle;
        this._bakeDirty = true;
      }
      // Publish the measured whitecap coverage back to the renderer so the sky,
      // audio and surface-transmission maths all key off one number.
      env.foamCoverage = this.whitecapCoverage();
    }

    // Exact wrap: every omega is a multiple of 2*PI/LOOP_PERIOD, so the field at
    // t and t + LOOP_PERIOD is identical to the last bit.
    this.time += dt;
    if (this.time >= OCEAN_LOOP_PERIOD) this.time -= OCEAN_LOOP_PERIOD;

    this._writeUniform(dt);
  }

  /**
   * Monahan & O'Muircheartaigh's whitecap coverage, W = 3.84e-6 * U10^3.41.
   * The surface shader uses it to modulate how much daylight actually gets
   * through the interface, which is a real effect at storm wind speeds.
   */
  whitecapCoverage() {
    const u = Math.max(this.spectrum.windSpeed, 0);
    return clamp(3.84e-6 * Math.pow(u, 3.41), 0, 0.35);
  }

  _writeUniform(dt) {
    const f = this._uniformData;
    const u = this._uniformU32;
    const s = this.spectrum;
    const N = this.n;
    const sizes = OCEAN.CASCADE_SIZES;

    f[0] = sizes[0]; f[1] = sizes[1]; f[2] = sizes[2]; f[3] = 1 / N;
    f[4] = OCEAN_CASCADE_CHOP[0] * OCEAN.CHOPPINESS * s.chopScale;
    f[5] = OCEAN_CASCADE_CHOP[1] * OCEAN.CHOPPINESS * s.chopScale;
    f[6] = OCEAN_CASCADE_CHOP[2] * OCEAN.CHOPPINESS * s.chopScale;
    f[7] = N;
    f[8] = s.windDir[0]; f[9] = s.windDir[1]; f[10] = s.windSpeed; f[11] = s.hs;
    // spectrum.x used to carry OCEAN.PHILLIPS_A, which the Hs normalisation
    // cancelled exactly and which therefore tuned nothing (see
    // OceanSpectrum.phillips). It carries cascade 0's h0 scale now; cascades 1
    // and 2 follow in spectrum.w and shading.y.
    f[12] = s.h0Scales[0]; f[13] = s.minWavelength; f[14] = s.gravity;
    f[15] = s.h0Scales[1];
    f[16] = this.time; f[17] = dt; f[18] = OCEAN.FOAM_DECAY_RATE; f[19] = OCEAN.FOAM_JACOBIAN_THRESHOLD;
    f[20] = OCEAN_FOAM_GAIN;
    f[21] = s.h0Scales[2];
    f[22] = OCEAN_LOOP_PERIOD;
    // f[23] fills out the vec4 and is not read by any shader - see the note on
    // `shading` in shaders/common/ocean.wgsl. The Cox-Munk slope variance is
    // derived GPU-side by oceanCoxMunkSlopeVariance() so the Gerstner path has
    // it too; keeping the same number here means it stays meaningful if anything
    // ever does want it, without a second definition drifting from the first.
    f[23] = coxMunkSlopeVariance(s.windSpeed);
    u[24] = N; u[25] = Math.round(Math.log2(N)); u[26] = this.cascadeCount; u[27] = s.seed;
    f.set(s.waves, 28);

    this.device.queue.writeBuffer(this.uniformBuffer, 0, f.buffer, 0, f.byteLength);
  }

  // -------------------------------------------------------------------------
  // Passes
  // -------------------------------------------------------------------------

  /** The simulation compute pass. Registered at the top of the frame graph. */
  makePasses() {
    if (this.gerstnerOnly) return [];
    const sim = this;
    return [{
      name: 'oceanSim',
      type: 'compute',
      writes: [],
      enabled: () => sim._ready,
      execute(ctx, encoder) { sim.encode(encoder); },
    }];
  }

  makeCausticsPass() { return createCausticsPass(this); }
  /** @param {import('./sky.js').SkySystem} sky bound for the reflected sky LUT. */
  makeSurfacePass(sky) { return createOceanSurfacePass(this, sky); }
  makeUnderwaterPass() { return createUnderwaterPass(this); }

  /**
   * Encode one simulation step.
   *
   * The h0 bake gets its own compute pass: it WRITES the h0 texture that the
   * evolve step SAMPLES, and WebGPU forbids a texture being both a writable
   * storage binding and a sampled binding inside one pass.
   */
  encode(encoder) {
    if (!this._ready || this.gerstnerOnly) return;
    const N = this.n;
    const C = this.cascadeCount;
    const groups = Math.ceil(N / 8);

    if (this._bakeDirty) {
      const bake = encoder.beginComputePass(profiler.gpuPass({ label: 'ocean.bake' }, 'ocean.bake'));
      bake.setPipeline(this._bakePipeline);
      bake.setBindGroup(0, this._bakeGroup);
      bake.dispatchWorkgroups(groups, groups, C);
      bake.end();
      this._bakeDirty = false;
    }

    this._parity ^= 1;
    const pass = encoder.beginComputePass(profiler.gpuPass({ label: 'oceanSim' }, 'oceanSim'));

    pass.setPipeline(this._evolvePipeline);
    pass.setBindGroup(0, this._evolveGroup);
    pass.dispatchWorkgroups(groups, groups, C);

    // Rows then columns. Dispatches inside one compute pass are ordered and
    // WebGPU inserts the memory barrier between them, so no explicit sync.
    const slices = OCEAN_FIELDS * C;
    pass.setBindGroup(0, this._fftGroup);
    pass.setPipeline(this._fftRowPipeline);
    pass.dispatchWorkgroups(N, slices, 1);
    pass.setPipeline(this._fftColPipeline);
    pass.dispatchWorkgroups(N, slices, 1);

    pass.setPipeline(this._assemblePipeline);
    pass.setBindGroup(0, this._assembleGroups[this._parity]);
    pass.dispatchWorkgroups(groups, groups, C);

    pass.setPipeline(this._mipPipeline);
    for (const step of this._mipSteps) {
      pass.setBindGroup(0, step.group);
      const g = Math.ceil(step.size / 8);
      pass.dispatchWorkgroups(g, g, C);
    }
    for (const step of this._foamMipSteps[this._parity]) {
      pass.setBindGroup(0, step.group);
      const g = Math.ceil(step.size / 8);
      pass.dispatchWorkgroups(g, g, C);
    }

    pass.end();
  }

  /** Which half of the foam ping-pong holds this frame's result. */
  get foamParity() { return this._parity; }
  /** The foam texture written this frame (the other half of the ping-pong). */
  get foamTexture() { return this.foamTextures[this._parity]; }
  get foamView() { return this._views ? this._views.foamSampled[this._parity] : null; }
  foamViewFor(parity) { return this._views ? this._views.foamSampled[parity & 1] : null; }
  get displacementView() { return this._views ? this._views.disp : null; }
  get derivativeView() { return this._views ? this._views.deriv : null; }

  // -------------------------------------------------------------------------
  // CPU query
  // -------------------------------------------------------------------------

  /**
   * Surface height at an absolute world (x, z).
   *
   * APPROXIMATION, DELIBERATE AND BOUNDED - and the bound is not the one people
   * expect, so read this before trusting the number.
   *
   * The drawn surface sums ~27,000 live spectral modes. This sums 32 of them:
   * the strongest, taken from the same lattice with their true wavevectors,
   * frequencies and phases, then amplitude-matched so the surrogate carries the
   * full variance (see OceanSpectrum.bake). What that buys and what it costs:
   *
   *   EXACT      significant wave height, so the vessel heaves by the right
   *              amount and the waterline sits at the right average level
   *   EXACT      peak wavelength, dominant direction and swell phase, so the
   *              vessel rides the long wave the player can actually see
   *   EXACT      periodicity: 200 s, to the last bit
   *   APPROX     pointwise height. `spectrum.cpuPointwiseRms` measures it; it
   *              runs about 0.3 * Hs, i.e. 0.5 m in a 1.65 m sea state 4.
   *
   * No 32-component model can do better pointwise: the strongest 512 modes
   * still hold only 41% of the variance of a fetch-limited sea. That residual
   * is the sub-metre chop, and section 05 feeds it to the vessel as synthetic
   * high-frequency buoyancy noise rather than pretending it is geometry.
   *
   * Gerstner displacement means the lattice point that LANDS at (x, z) is not
   * (x, z), so we invert the map with three fixed-point iterations. The map is
   * a contraction with modulus equal to the total steepness, which `bake()`
   * bounds below 0.85, so three iterations leave under 0.85^3 = 61% of an
   * already sub-centimetre residual.
   */
  sampleHeightCPU(x, z, time) {
    const t = time != null ? time : this.time;
    const s = this._scratch;
    let px = x, pz = z;
    for (let i = 0; i < 3; i++) {
      this.spectrum.gerstnerAt(s, px, pz, t);
      px = x - s[0];
      pz = z - s[2];
    }
    this.spectrum.gerstnerAt(s, px, pz, t);
    return s[1];
  }

  /**
   * Height plus the surface normal at an absolute world (x, z). Returns a
   * shared object - copy what you need before the next call.
   */
  sampleSurfaceCPU(x, z, time) {
    const t = time != null ? time : this.time;
    const s = this._scratch;
    let px = x, pz = z;
    for (let i = 0; i < 3; i++) {
      this.spectrum.gerstnerAt(s, px, pz, t);
      px = x - s[0];
      pz = z - s[2];
    }
    this.spectrum.gerstnerAt(s, px, pz, t);
    const inv = 1 / Math.hypot(s[3], 1, s[4]);
    const o = this._surface;
    o.height = s[1];
    o.dispX = s[0];
    o.dispZ = s[2];
    o.nx = -s[3] * inv;
    o.ny = inv;
    o.nz = -s[4] * inv;
    return o;
  }

  /** Signed distance from a world point to the surface. Positive above water. */
  signedDistanceToSurface(x, y, z, time) {
    return y - WORLD.SEA_LEVEL - this.sampleHeightCPU(x, z, time);
  }

  /**
   * Conservative vertical bound on the displaced surface, metres. Used to
   * expand clipmap block bounds before frustum culling; must never under-report
   * or blocks pop at the screen edge.
   */
  get verticalBound() {
    return 1.6 * this.spectrum.hs + 0.5;
  }

  destroy() {
    this.uniformBuffer?.destroy();
    this.hktBuffer?.destroy();
    this.h0Texture?.destroy();
    this.displacementTexture?.destroy();
    this.derivativeTexture?.destroy();
    this.foamTextures[0]?.destroy();
    this.foamTextures[1]?.destroy();
    this._ready = false;
  }
}
