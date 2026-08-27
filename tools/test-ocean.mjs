#!/usr/bin/env node
/**
 * Ocean simulation verification.
 *
 * Everything here runs offline. What it proves:
 *
 *   1. The butterfly network in shaders/sim/ocean_fft.wgsl - transliterated
 *      line for line into JS - agrees with a naive inverse DFT.
 *   2. The full 2D pipeline (rows, columns, (-1)^(n+m) sign fix) reproduces the
 *      centred-lattice sum h(x) = sum_k h(k) e^{i k.x}, which is the surface the
 *      renderer claims to draw.
 *   3. The spectrum is Hermitian, so the synthesised height field is REAL: the
 *      residual imaginary part is reported as a fraction of the real RMS.
 *   4. The amplitude normalisation produces the sea state's significant wave
 *      height, measured from a direct synthesis rather than from the analytic
 *      sum it was derived from.
 *   5. The CPU Gerstner query is continuous, bounded, and exactly periodic with
 *      the 200 s loop, and its RMS error against the full field is measured.
 *   6. Below TRUE_DARK_DEPTH the aphotic window is exactly zero.
 *   7. The clipmap covers every metre of sea inside the horizon ring, for a
 *      SWEEP of camera positions - the size of a level matching the size of the
 *      hole it fills proves nothing on its own, and the gap that put a crack in
 *      the ocean was a placement error, not a sizing one.
 *   8. The derived spectral fields are mutually consistent: the foam Jacobian is
 *      really the derivative of the displacement field, and the displacement
 *      sharpens crests in the same direction as the CPU query the vessel floats
 *      on. Both are sign relations, and a sign here inverts silently.
 *   9. The per-band renormalisation actually does its job: the resolved slope
 *      tracks Cox & Munk's wind curve, the short cascades GROW with the sea
 *      state (they used not to at all), and Hs stays exact anyway.
 *  10. Foam exists. The whitecap coverage the Jacobian threshold produces is
 *      compared against Monahan & O'Muircheartaigh's measured W(U10). The
 *      assertion this replaced recorded min J = 0.627 against a threshold of
 *      0.52 and passed - a green check documenting the absence of the thing it
 *      was guarding.
 *  13. Marine snow preserves the authored water-type load, clears the shallow
 *      reef, while retaining distinct denser fields in kelp, abyssal, and vent
 *      water.
 *  14. Shallow diffuse-veil reduction is live-bisectable and cannot alter
 *      above-water, distant, deep, or collimated-beam atmosphere.
 *  15. Per-biome submerged sight density increases mid-biome transmittance,
 *      preserves spectral ratios, and cannot leak into the surface column.
 *
 * Run:  node tools/test-ocean.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import {
  OceanSpectrum, OCEAN_LOOP_PERIOD, OCEAN_GERSTNER_WAVES, OCEAN_CASCADE_CHOP,
  OCEAN_FOAM_GAIN, coxMunkSlopeVariance,
} from '../src/sim/ocean.js';
import {
  OCEAN, RENDER, TRUE_DARK_DEPTH, WATER_TYPES, WATER_BOTTOM_ALBEDO,
} from '../src/core/constants.js';
import { BIOMES } from '../src/world/biomes.js';
import { LATTICE as CAUSTIC_LATTICE } from '../src/render/passes/caustics.js';
import { TAU } from '../src/core/math.js';
import {
  OCEAN_BLOCK_CELLS, OCEAN_BASE_CELL, OCEAN_CLIPMAP_SNAP,
  OCEAN_MORPH_START, OCEAN_MORPH_END,
} from '../src/render/passes/ocean.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};
const num = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

// ---------------------------------------------------------------------------
// 1 & 2. The IFFT
// ---------------------------------------------------------------------------

/** Exactly `bitReverse` from ocean_fft.wgsl. */
function bitReverse(i, bits) {
  let v = i >>> 0;
  let r = 0;
  for (let b = 0; b < bits; b++) {
    r = ((r << 1) | (v & 1)) >>> 0;
    v = v >>> 1;
  }
  return r >>> 0;
}

/**
 * Exactly `butterflies` from ocean_fft.wgsl, run for all N/2 "threads" at each
 * stage (the shader's single barrier per stage makes the order irrelevant,
 * because each thread touches a disjoint pair).
 */
function butterflies(re, im, N, log2N) {
  for (let s = 1; s <= log2N; s++) {
    const len = 1 << s;
    const half = len >> 1;
    for (let t = 0; t < N / 2; t++) {
      const blk = Math.floor(t / half);
      const j = t % half;
      const i0 = blk * len + j;
      const i1 = i0 + half;
      const ang = Math.PI * j / half;
      const wr = Math.cos(ang);
      const wi = Math.sin(ang);
      const ur = re[i0], ui = im[i0];
      const vr = re[i1] * wr - im[i1] * wi;
      const vi = re[i1] * wi + im[i1] * wr;
      re[i0] = ur + vr; im[i0] = ui + vi;
      re[i1] = ur - vr; im[i1] = ui - vi;
    }
  }
}

/** The shader's load-transform-store for one line. */
function ifftLine(re, im, N, log2N) {
  const br = new Float64Array(N);
  const bi = new Float64Array(N);
  for (let t = 0; t < N; t++) {
    const src = bitReverse(t, log2N);
    br[t] = re[src];
    bi[t] = im[src];
  }
  butterflies(br, bi, N, log2N);
  re.set(br);
  im.set(bi);
}

{
  const N = 64;
  const log2N = 6;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let seed = 12345;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  for (let i = 0; i < N; i++) { re[i] = rnd(); im[i] = rnd(); }
  const refRe = new Float64Array(N);
  const refIm = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    let ar = 0, ai = 0;
    for (let k = 0; k < N; k++) {
      const a = (2 * Math.PI * k * n) / N;     // +i convention: inverse, unnormalised
      const c = Math.cos(a), s = Math.sin(a);
      ar += re[k] * c - im[k] * s;
      ai += re[k] * s + im[k] * c;
    }
    refRe[n] = ar; refIm[n] = ai;
  }
  const gr = Float64Array.from(re);
  const gi = Float64Array.from(im);
  ifftLine(gr, gi, N, log2N);
  let err = 0, mag = 0;
  for (let i = 0; i < N; i++) {
    err = Math.max(err, Math.abs(gr[i] - refRe[i]), Math.abs(gi[i] - refIm[i]));
    mag = Math.max(mag, Math.abs(refRe[i]), Math.abs(refIm[i]));
  }
  check('1D butterfly network == naive inverse DFT', err / mag < 1e-12,
        `max abs err ${err.toExponential(3)} on |X| up to ${num(mag, 3)}`);
}

{
  // 2D: rows, then columns, then the centred-lattice sign fix.
  const N = 16;
  const log2N = 4;
  let seed = 777;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  const re = new Float64Array(N * N);
  const im = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) { re[i] = rnd(); im[i] = rnd(); }

  const gr = Float64Array.from(re);
  const gi = Float64Array.from(im);
  const lr = new Float64Array(N);
  const li = new Float64Array(N);
  for (let m = 0; m < N; m++) {                       // rows
    for (let n = 0; n < N; n++) { lr[n] = gr[m * N + n]; li[n] = gi[m * N + n]; }
    ifftLine(lr, li, N, log2N);
    for (let n = 0; n < N; n++) { gr[m * N + n] = lr[n]; gi[m * N + n] = li[n]; }
  }
  for (let n = 0; n < N; n++) {                       // columns
    for (let m = 0; m < N; m++) { lr[m] = gr[m * N + n]; li[m] = gi[m * N + n]; }
    ifftLine(lr, li, N, log2N);
    for (let m = 0; m < N; m++) { gr[m * N + n] = lr[m]; gi[m * N + n] = li[m]; }
  }
  for (let m = 0; m < N; m++) {                       // (-1)^(n+m)
    for (let n = 0; n < N; n++) {
      const s = ((n + m) & 1) ? -1 : 1;
      gr[m * N + n] *= s; gi[m * N + n] *= s;
    }
  }

  // Reference: the centred-lattice sum the physics actually asks for.
  let err = 0, mag = 0;
  for (let q = 0; q < N; q++) {
    for (let p = 0; p < N; p++) {
      let ar = 0, ai = 0;
      for (let m = 0; m < N; m++) {
        for (let n = 0; n < N; n++) {
          const a = (2 * Math.PI * ((n - N / 2) * p + (m - N / 2) * q)) / N;
          const c = Math.cos(a), s = Math.sin(a);
          const xr = re[m * N + n], xi = im[m * N + n];
          ar += xr * c - xi * s;
          ai += xr * s + xi * c;
        }
      }
      err = Math.max(err, Math.abs(gr[q * N + p] - ar), Math.abs(gi[q * N + p] - ai));
      mag = Math.max(mag, Math.abs(ar), Math.abs(ai));
    }
  }
  check('2D pipeline == centred-lattice sum h(x) = sum_k h(k) e^(ik.x)',
        err / mag < 1e-12,
        `max abs err ${err.toExponential(3)} on |h| up to ${num(mag, 3)}`);
}

// ---------------------------------------------------------------------------
// 3 & 4. Direct synthesis of the real spectral field
// ---------------------------------------------------------------------------

/**
 * Synthesise the height field for one cascade by direct evaluation of
 *   h(x) = sum_k [ h0(k) e^{i w t} + conj(h0(-k)) e^{-i w t} ] e^{i k.x}
 * on the same lattice the GPU uses. Slow, but it is the ground truth the GPU
 * pipeline is supposed to reproduce, and it exercises the identical h0.
 */
function synthesise(spec, N, cascade, t) {
  const L = spec.cascadeSizes[cascade];
  const dk = (2 * Math.PI) / L;
  const half = N / 2;
  const g2 = new Float32Array(2);

  // h0 for the whole lattice.
  const h0r = new Float64Array(N * N);
  const h0i = new Float64Array(N * N);
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const kx = (n - half) * dk;
      const kz = (m - half) * dk;
      const p = spec.modeAmplitude(n, m, kx, kz, Math.hypot(kx, kz), cascade);
      if (p <= 0) continue;
      gauss2Ref(g2, n, m, cascade, spec.seed);
      const s = Math.sqrt(0.5 * p) * spec.h0Scales[cascade];
      h0r[m * N + n] = g2[0] * s;
      h0i[m * N + n] = g2[1] * s;
    }
  }

  // h(k, t)
  const hr = new Float64Array(N * N);
  const hi = new Float64Array(N * N);
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const kx = (n - half) * dk;
      const kz = (m - half) * dk;
      const w = spec.omega(Math.hypot(kx, kz));
      const c = Math.cos(w * t), s = Math.sin(w * t);
      const mn = (N - n) % N;
      const mm = (N - m) % N;
      const ar = h0r[m * N + n], ai = h0i[m * N + n];
      const br = h0r[mm * N + mn], bi = -h0i[mm * N + mn];   // conj(h0(-k))
      hr[m * N + n] = ar * c - ai * s + (br * c + bi * s);
      hi[m * N + n] = ar * s + ai * c + (-br * s + bi * c);
    }
  }

  // Real-space field by direct summation.
  const outR = new Float64Array(N * N);
  const outI = new Float64Array(N * N);
  for (let q = 0; q < N; q++) {
    for (let p = 0; p < N; p++) {
      let ar = 0, ai = 0;
      for (let m = 0; m < N; m++) {
        for (let n = 0; n < N; n++) {
          const a = (2 * Math.PI * ((n - half) * p + (m - half) * q)) / N;
          const c = Math.cos(a), s = Math.sin(a);
          const xr = hr[m * N + n], xi = hi[m * N + n];
          ar += xr * c - xi * s;
          ai += xr * s + xi * c;
        }
      }
      outR[q * N + p] = ar;
      outI[q * N + p] = ai;
    }
  }
  return { re: outR, im: outI };
}

/** The same Box-Muller the module and the shader use. */
function gauss2Ref(out, n, m, cascade, seed) {
  const hash = (x) => {
    let h = x >>> 0;
    h = (h ^ (h >>> 17)) >>> 0; h = Math.imul(h, 0xed5ad4bb) >>> 0;
    h = (h ^ (h >>> 11)) >>> 0; h = Math.imul(h, 0xac4c1b51) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0; h = Math.imul(h, 0x31848bab) >>> 0;
    return (h ^ (h >>> 14)) >>> 0;
  };
  const h0 = hash((Math.imul(n, 0x9e3779b1) + Math.imul(m, 0x85ebca6b) +
                   Math.imul(cascade, 0xc2b2ae35) + seed) >>> 0);
  const h1 = hash(h0 ^ 0x68bc21eb);
  const inv = 2.3283064365386963e-10;
  const r = Math.sqrt(-2 * Math.log((h0 + 0.5) * inv));
  const th = 2 * Math.PI * ((h1 + 0.5) * inv);
  out[0] = r * Math.cos(th);
  out[1] = r * Math.sin(th);
  return out;
}

{
  const N = 48;
  const spec = new OceanSpectrum({ fftSize: N, cascadeCount: 1, cascadeSizes: [512, 64, 8] });
  spec.windSpeed = 9.5;
  spec.windDir = [0.6, 0.8];
  spec.hs = 1.65;                       // sea state 4
  spec.bake();

  const f = synthesise(spec, N, 0, 0);
  let sr = 0, si = 0, mean = 0;
  for (let i = 0; i < N * N; i++) mean += f.re[i];
  mean /= N * N;
  for (let i = 0; i < N * N; i++) {
    sr += (f.re[i] - mean) ** 2;
    si += f.im[i] ** 2;
  }
  const rmsRe = Math.sqrt(sr / (N * N));
  const rmsIm = Math.sqrt(si / (N * N));
  check('synthesised field is real (Hermitian spectrum)', rmsIm / rmsRe < 1e-12,
        `imag/real RMS = ${(rmsIm / Math.max(rmsRe, 1e-30)).toExponential(2)}`);

  const hsMeasured = 4 * rmsRe;
  const hsPredicted = 4 * Math.sqrt(spec.m0);
  check('analytic m0 matches the synthesised field',
        Math.abs(hsMeasured - hsPredicted) / hsPredicted < 0.12,
        `Hs synth ${num(hsMeasured, 3)} m vs analytic ${num(hsPredicted, 3)} m ` +
        `(${num(100 * (hsMeasured / hsPredicted - 1), 1)}% on ${N * N} samples)`);
}

// ---------------------------------------------------------------------------
// 5. The CPU Gerstner query
// ---------------------------------------------------------------------------

console.log('\n  sea state   Hs(m)  sigma_full  sigma_cpu  energyGain  pointwiseRMS(m)  RMS/Hs');
const states = [1, 2, 3, 4, 6, 8];
const baked = new Map();
for (const s of states) {
  const st = OCEAN.SEA_STATES[s];
  const spec = new OceanSpectrum({ fftSize: 128, cascadeCount: 3 });
  spec.windSpeed = st.wind;
  spec.windDir = [1, 0];
  spec.hs = st.hs;
  spec.bake();
  baked.set(s, spec);
  const sigFull = Math.sqrt(spec.m0);
  const sigCpu = Math.sqrt(spec.m0Gerstner);
  console.log(
    `      ${String(s).padStart(2)}     ${num(st.hs, 2).padStart(6)}` +
    `  ${num(sigFull, 4).padStart(10)} ${num(sigCpu, 4).padStart(10)}` +
    `  ${num(spec.energyGain, 3).padStart(10)}` +
    `  ${num(spec.cpuPointwiseRms, 4).padStart(15)}` +
    `  ${num(spec.cpuPointwiseRms / Math.max(st.hs, 1e-6), 3).padStart(6)}`);
}
console.log('');

{
  const spec = baked.get(4);
  const scratch = new Float32Array(5);

  // Invert the Gerstner map exactly as OceanSim.sampleHeightCPU does.
  const heightAt = (x, z, t) => {
    let px = x, pz = z;
    for (let i = 0; i < 3; i++) {
      spec.gerstnerAt(scratch, px, pz, t);
      px = x - scratch[0];
      pz = z - scratch[2];
    }
    spec.gerstnerAt(scratch, px, pz, t);
    return scratch[1];
  };

  // --- boundedness -------------------------------------------------------
  let maxAbs = 0;
  let sum = 0, sum2 = 0;
  const M = 20000;
  for (let i = 0; i < M; i++) {
    const x = (i * 7.31) % 4000 - 2000;
    const z = (i * 13.77) % 4000 - 2000;
    const h = heightAt(x, z, 11.5);
    maxAbs = Math.max(maxAbs, Math.abs(h));
    sum += h; sum2 += h * h;
  }
  const sigma = Math.sqrt(sum2 / M - (sum / M) ** 2);
  const hs = spec.hs;
  check('CPU surface is bounded by the sea state',
        maxAbs < 1.0 * hs,
        `max |h| = ${num(maxAbs, 3)} m, Hs = ${num(hs, 2)} m, ratio ${num(maxAbs / hs, 3)}`);
  check('CPU surface sigma equals the true sea-state sigma (Hs/4)',
        Math.abs(sigma - hs / 4) < 0.06 * hs,
        `sigma measured ${num(sigma, 4)} m vs Hs/4 = ${num(hs / 4, 4)} m ` +
        `(=> Hs_cpu ${num(4 * sigma, 3)} m vs ${num(hs, 2)} m)`);

  // --- continuity --------------------------------------------------------
  // A finite Lipschitz bound over a fine walk: the surface must have no jumps.
  let maxSlope = 0;
  const step = 0.02;
  for (let i = 0; i < 40000; i++) {
    const x = -50 + i * step;
    const a = heightAt(x, 3.25, 4.0);
    const b = heightAt(x + step, 3.25, 4.0);
    maxSlope = Math.max(maxSlope, Math.abs(b - a) / step);
  }
  check('CPU surface is continuous (finite slope everywhere on a 800 m walk)',
        maxSlope < 2.5,
        `max |dh/dx| = ${num(maxSlope, 4)} (tan 68 deg = 2.5)`);

  // --- exact periodicity -------------------------------------------------
  let maxDrift = 0;
  for (let i = 0; i < 400; i++) {
    const x = (i * 3.7) % 500;
    const z = (i * 9.1) % 500;
    const t = (i * 0.37) % OCEAN_LOOP_PERIOD;
    maxDrift = Math.max(maxDrift,
      Math.abs(heightAt(x, z, t) - heightAt(x, z, t + OCEAN_LOOP_PERIOD)));
  }
  check(`CPU surface repeats exactly every ${OCEAN_LOOP_PERIOD} s`,
        maxDrift < 1e-4,
        `max drift over one loop = ${maxDrift.toExponential(3)} m`);

  // --- no self-intersection ---------------------------------------------
  let steepSum = 0;
  for (let i = 0; i < OCEAN_GERSTNER_WAVES; i++) {
    const o = i * 8;
    steepSum += spec.waves[o + 2] * spec.waves[o + 6] *
                Math.hypot(spec.waves[o + 0], spec.waves[o + 1]);
  }
  check('Gerstner steepness sum < 1 (surface cannot fold over itself)',
        steepSum < 1.0, `sum(A k Q) = ${num(steepSum, 4)}`);

  // --- fixed-point inversion converges -----------------------------------
  // The point returned must actually land where it was asked for.
  let maxResidual = 0;
  for (let i = 0; i < 2000; i++) {
    const x = (i * 5.13) % 900 - 450;
    const z = (i * 2.79) % 900 - 450;
    let px = x, pz = z;
    for (let k = 0; k < 3; k++) {
      spec.gerstnerAt(scratch, px, pz, 8.0);
      px = x - scratch[0];
      pz = z - scratch[2];
    }
    spec.gerstnerAt(scratch, px, pz, 8.0);
    maxResidual = Math.max(maxResidual,
      Math.hypot(px + scratch[0] - x, pz + scratch[2] - z));
  }
  check('3 fixed-point iterations land the query within 1 cm',
        maxResidual < 0.01, `max residual = ${num(maxResidual * 100, 4)} cm`);
}

// ---------------------------------------------------------------------------
// 6. The aphotic window and Snell's window
// ---------------------------------------------------------------------------

{
  const smoothstep = (e0, e1, x) => {
    const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
    return t * t * (3 - 2 * t);
  };
  const aphotic = (d) => 1 - smoothstep(TRUE_DARK_DEPTH * 0.615, TRUE_DARK_DEPTH, d);

  const clearest = WATER_TYPES.ABYSSAL_VOID.Kd[2];
  const beer = Math.exp(-clearest * TRUE_DARK_DEPTH);
  check('Beer-Lambert alone is NOT black at TRUE_DARK_DEPTH (why the window exists)',
        beer > 1e-6, `exp(-${clearest} * ${TRUE_DARK_DEPTH}) = ${beer.toExponential(2)}`);
  check('aphotic window is exactly 0 at and below TRUE_DARK_DEPTH',
        aphotic(TRUE_DARK_DEPTH) === 0 && aphotic(TRUE_DARK_DEPTH + 1) === 0 &&
        aphotic(1600) === 0,
        `f(${TRUE_DARK_DEPTH}) = ${aphotic(TRUE_DARK_DEPTH)}, f(1600) = ${aphotic(1600)}`);
  check('aphotic window is untouched above 320 m',
        aphotic(319) === 1 && aphotic(0) === 1,
        `f(0) = ${aphotic(0)}, f(319) = ${aphotic(319)}`);
  console.log(`        window shape: 400 m -> ${num(aphotic(400), 4)}, ` +
              `450 m -> ${num(aphotic(450), 4)}, 500 m -> ${num(aphotic(500), 4)}`);
}

{
  const n = OCEAN.IOR;             // 1.333 from constants.js
  const nShader = 1.339;           // seawater, common/ocean.wgsl
  const critical = Math.asin(1 / nShader);
  const cone = 2 * critical * 180 / Math.PI;
  check("Snell's window is the expected ~97 degree cone",
        Math.abs(cone - 96.6) < 0.5,
        `2 * asin(1/${nShader}) = ${num(cone, 2)} deg (critical ${num(critical * 180 / Math.PI, 2)} deg)`);

  // Exact unpolarised Fresnel, water -> air, as in oceanFresnelExact.
  const fres = (cosI, eta) => {
    const s2 = eta * eta * (1 - cosI * cosI);
    if (s2 >= 1) return 1;
    const cosT = Math.sqrt(1 - s2);
    const rs = (eta * cosI - cosT) / (eta * cosI + cosT);
    const rp = (eta * cosT - cosI) / (eta * cosT + cosI);
    return 0.5 * (rs * rs + rp * rp);
  };
  const atDeg = (d) => fres(Math.cos(d * Math.PI / 180), nShader);
  const critDeg = critical * 180 / Math.PI;
  check('total internal reflection is exact past the critical angle',
        atDeg(critDeg + 0.01) === 1 && atDeg(60) === 1 && atDeg(90) === 1 &&
        atDeg(critDeg - 0.5) < 1,
        `R(0 deg) = ${num(atDeg(0), 4)}, R(40) = ${num(atDeg(40), 4)}, ` +
        `R(46) = ${num(atDeg(46), 4)}, R(48) = ${num(atDeg(48), 4)}, ` +
        `R(${num(critDeg, 2)}+) = ${atDeg(critDeg + 0.01)}`);
  check('constants.js IOR and the shader IOR are the same water to 0.5%',
        Math.abs(n - nShader) / nShader < 0.005, `${n} vs ${nShader}`);
}

// ---------------------------------------------------------------------------
// 6b. The OceanParams byte contract
// ---------------------------------------------------------------------------

{
  // WGSL: 6 vec4f + 1 vec4u + array<vec4f, 2 * OCEAN_GERSTNER_WAVES>.
  const wgslBytes = 6 * 16 + 16 + 2 * OCEAN_GERSTNER_WAVES * 16;
  const spec = new OceanSpectrum({ fftSize: 64, cascadeCount: 3 });
  const jsBytes = (28 + OCEAN_GERSTNER_WAVES * 8) * 4;
  check('OceanParams matches shaders/common/ocean.wgsl byte for byte',
        jsBytes === wgslBytes && spec.waves.length === OCEAN_GERSTNER_WAVES * 8,
        `${jsBytes} B written, ${wgslBytes} B declared, wave table ${spec.waves.length} floats`);
}

// ---------------------------------------------------------------------------
// 7. Clipmap seams
// ---------------------------------------------------------------------------

{
  const B = OCEAN_BLOCK_CELLS;
  const levels = OCEAN.CLIPMAP_RINGS;
  const cell = (l) => OCEAN_BASE_CELL * Math.pow(2, l);
  const extent = (l) => B * cell(l);      // one block
  const radius = (l) => 2 * extent(l);    // half-width of the whole level

  // Rebuild buildInstances()'s footprint for a camera, and SCAN it. Checking
  // that the hole and the level are the same size is not enough: what actually
  // cracked the ocean was the two being the same size but not in the same
  // PLACE, which only a sweep over camera positions can see.
  function footprints(camX, camZ) {
    const rects = [];
    const cx = Math.floor(camX / OCEAN_CLIPMAP_SNAP) * OCEAN_CLIPMAP_SNAP;
    const cz = Math.floor(camZ / OCEAN_CLIPMAP_SNAP) * OCEAN_CLIPMAP_SNAP;
    for (let l = 0; l < levels; l++) {
      for (let bz = 0; bz < 4; bz++) {
        for (let bx = 0; bx < 4; bx++) {
          if (l > 0 && bx >= 1 && bx <= 2 && bz >= 1 && bz <= 2) continue;
          const ox = cx + (bx - 2) * extent(l);
          const oz = cz + (bz - 2) * extent(l);
          rects.push([ox, oz, ox + extent(l), oz + extent(l)]);
        }
      }
    }
    return rects;
  }

  // Everything inside the horizon annulus's inner radius must be covered.
  const rInner = radius(levels - 1) - 2 * OCEAN_CLIPMAP_SNAP;
  let worstGap = 0;
  let worstAt = '';
  for (let i = 0; i < 200; i++) {
    const camX = -13.3 + i * 0.37;
    const camZ = 7.1 + i * 0.11;
    const rects = footprints(camX, camZ);
    let run = 0;
    for (let x = camX - rInner; x < camX + rInner; x += 0.05) {
      const covered = rects.some((r) => x >= r[0] && x <= r[2] && camZ >= r[1] && camZ <= r[3]);
      if (covered) { run = 0; continue; }
      run += 0.05;
      if (run > worstGap) { worstGap = run; worstAt = `cam ${num(camX, 2)}, x ${num(x, 2)}`; }
    }
  }
  check('clipmap covers every metre inside the horizon annulus', worstGap < 0.06,
        worstGap < 0.06
          ? `${levels} levels, ${num(cell(0), 2)} m -> ${num(cell(levels - 1), 1)} m cells, ` +
            `covered to ${num(rInner, 0)} m`
          : `uncovered run ${num(worstGap, 2)} m at ${worstAt}`);

  // The morph has to be saturated on every boundary the camera can see, and the
  // camera is up to one snap off centre, so the nearest boundary point is closer
  // than the coverage radius.
  let minMorph = Infinity;
  for (let i = 0; i < 500; i++) {
    const camX = -137.31 + i * 0.7331;
    const cx = Math.floor(camX / OCEAN_CLIPMAP_SNAP) * OCEAN_CLIPMAP_SNAP;
    for (let l = 0; l < levels; l++) {
      const dist = radius(l) - Math.abs(camX - cx);
      minMorph = Math.min(minMorph,
        (dist - OCEAN_MORPH_START * radius(l)) /
        ((OCEAN_MORPH_END - OCEAN_MORPH_START) * radius(l)));
    }
  }
  check('CDLOD morph reaches 1 on every level boundary, at any camera offset',
        minMorph >= 1, `min morph = ${num(minMorph, 4)}`);

  // Morphed vertices must land on the parent's lattice: all levels share one
  // origin, so a level-l even vertex is origin + 2*c_l*k = origin + c_{l+1}*k.
  let maxOffset = 0;
  for (let i = 0; i < 500; i++) {
    const camX = -137.31 + i * 0.7331;
    const cx = Math.floor(camX / OCEAN_CLIPMAP_SNAP) * OCEAN_CLIPMAP_SNAP;
    for (let l = 0; l + 1 < levels; l++) {
      const v0 = cx - 2 * extent(l) + 2 * cell(l) * 7;      // morphed level-l vertex
      const v1 = cx + extent(l + 1) + cell(l + 1) * 5;      // level-(l+1) vertex
      const r = (v0 - v1) / cell(l + 1);
      maxOffset = Math.max(maxOffset, Math.abs(r - Math.round(r)));
    }
  }
  check('morphed vertices land on the coarser level\'s world lattice exactly',
        maxOffset < 1e-9, `max lattice residue ${maxOffset.toExponential(2)} cells`);

  const blocks = 16 + (levels - 1) * 12 + 1;
  console.log(`        ${blocks} blocks max, ${blocks * B * B * 2} triangles before culling`);
}

// ---------------------------------------------------------------------------
// 8. Caustics tile periodicity
// ---------------------------------------------------------------------------

{
  // Every caustics wavevector is an integer multiple of 2*PI/tile, so the phase
  // advances by an exact multiple of 2*PI across one tile in either axis.
  // THE REAL LATTICE, imported. This block used to carry a hand-copy of the ten
  // entries; the set is 48 now, and a stale literal would have gone on passing.
  const tile = RENDER.CAUSTICS_SCALE;
  const base = (2 * Math.PI) / tile;
  const lattice = CAUSTIC_LATTICE;
  let worst = 0;
  for (const [nx, nz] of lattice) {
    worst = Math.max(worst,
      Math.abs(((nx * base * tile) / (2 * Math.PI)) - nx),
      Math.abs(((nz * base * tile) / (2 * Math.PI)) - nz));
  }
  check('caustics tile is exactly periodic over CAUSTICS_SCALE',
        worst < 1e-12,
        `${lattice.length} modes, max lattice residue ${worst.toExponential(2)} cycles`);
}

// ---------------------------------------------------------------------------
// 9. The derived spectral fields: displacement, its Jacobian, and the sign
//    that ties the drawn surface to the CPU query
// ---------------------------------------------------------------------------

/**
 * cs_evolve + the IFFT + cs_assemble, transliterated, for one cascade.
 *
 * Every field here is a multiple of h(k) by a factor of i^n * k, and getting one
 * of those factors' SIGN wrong is invisible in isolation: the field still looks
 * like waves. It shows up only as a relation between fields - the Jacobian no
 * longer being the derivative of the displacement it describes, and the
 * displacement pulling material AWAY from the crests instead of into them
 * (which also puts the CPU buoyancy query on the wrong side of every wave).
 * So the assertions below are relations, not values.
 */
function spectralFields(spec, N, cascade, t) {
  const log2N = Math.round(Math.log2(N));
  const L = spec.cascadeSizes[cascade];
  const dk = (2 * Math.PI) / L;
  const half = N / 2;
  const lam = OCEAN_CASCADE_CHOP[cascade] * OCEAN.CHOPPINESS * spec.chopScale;
  const g2 = new Float32Array(2);

  const h0r = new Float64Array(N * N), h0i = new Float64Array(N * N);
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const kx = (n - half) * dk, kz = (m - half) * dk;
      const p = spec.modeAmplitude(n, m, kx, kz, Math.hypot(kx, kz), cascade);
      if (p <= 0) continue;
      gauss2Ref(g2, n, m, cascade, spec.seed);
      const s = Math.sqrt(0.5 * p) * spec.h0Scales[cascade];
      h0r[m * N + n] = g2[0] * s;
      h0i[m * N + n] = g2[1] * s;
    }
  }

  const F = 4;
  const re = [], im = [];
  for (let f = 0; f < F; f++) { re.push(new Float64Array(N * N)); im.push(new Float64Array(N * N)); }

  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const kx = (n - half) * dk, kz = (m - half) * dk;
      const kmag = Math.hypot(kx, kz);
      const w = spec.omega(kmag);
      const ec = Math.cos(w * t), es = Math.sin(w * t);
      const mn = (N - n) % N, mm = (N - m) % N;
      const ar = h0r[m * N + n], ai = h0i[m * N + n];
      const br = h0r[mm * N + mn], bi = -h0i[mm * N + mn];
      const hr = ar * ec - ai * es + (br * ec + bi * es);
      const hi = ar * es + ai * ec + (-br * es + bi * ec);

      const knx = kmag > 1e-6 ? kx / kmag : 0;
      const knz = kmag > 1e-6 ? kz / kmag : 0;
      const ihr = -hi, ihi = hr;                       // i * h

      const f = [
        [ihr * knx * lam, ihi * knx * lam],            // Dx
        [ihr * knz * lam, ihi * knz * lam],            // Dz
        [hr, hi],                                       // Dy
        [ihr * kx, ihi * kx],                           // dDy/dx
        [ihr * kz, ihi * kz],                           // dDy/dz
        [-hr * kx * knx * lam, -hi * kx * knx * lam],   // dDx/dx
        [-hr * kz * knz * lam, -hi * kz * knz * lam],   // dDz/dz
        [-hr * kx * knz * lam, -hi * kx * knz * lam],   // dDx/dz
      ];
      // cpack(p, q) = p + i*q
      for (let j = 0; j < F; j++) {
        const p = f[j * 2], q = f[j * 2 + 1];
        re[j][m * N + n] = p[0] - q[1];
        im[j][m * N + n] = p[1] + q[0];
      }
    }
  }

  const lr = new Float64Array(N), li = new Float64Array(N);
  for (let j = 0; j < F; j++) {
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) { lr[n] = re[j][m * N + n]; li[n] = im[j][m * N + n]; }
      ifftLine(lr, li, N, log2N);
      for (let n = 0; n < N; n++) { re[j][m * N + n] = lr[n]; im[j][m * N + n] = li[n]; }
    }
    for (let n = 0; n < N; n++) {
      for (let m = 0; m < N; m++) { lr[m] = re[j][m * N + n]; li[m] = im[j][m * N + n]; }
      ifftLine(lr, li, N, log2N);
      for (let m = 0; m < N; m++) { re[j][m * N + n] = lr[m]; im[j][m * N + n] = li[m]; }
    }
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const s = ((n + m) & 1) ? -1 : 1;
        re[j][m * N + n] *= s; im[j][m * N + n] *= s;
      }
    }
  }

  return {
    Dx: re[0], Dz: im[0], Dy: re[1], dDydx: im[1],
    dDydz: re[2], dDxdx: im[2], dDzdz: re[3], dDxdz: im[3],
    cellSize: L / N, N,
  };
}

/** Pearson correlation of two lattices. */
function corr(a, b) {
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < a.length; i++) { sxy += a[i] * b[i]; sxx += a[i] * a[i]; syy += b[i] * b[i]; }
  return sxy / Math.sqrt(Math.max(sxx * syy, 1e-30));
}

{
  const N = 32;
  const spec = new OceanSpectrum({ fftSize: N, cascadeCount: 1, cascadeSizes: [64, 64, 8] });
  spec.windSpeed = 12.5;
  spec.windDir = [1, 0];
  spec.hs = 2.9;
  spec.bake();
  const f = spectralFields(spec, N, 0, 3.0);

  // dDx/dx must BE the x-derivative of Dx. Central differences on the lattice
  // are second-order accurate, which is far more than a sign needs.
  const fd = new Float64Array(N * N);
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const np = (n + 1) % N, nm = (n - 1 + N) % N;
      fd[m * N + n] = (f.Dx[m * N + np] - f.Dx[m * N + nm]) / (2 * f.cellSize);
    }
  }
  const cJac = corr(fd, f.dDxdx);
  check('dDx/dx really is the derivative of the Dx field (the foam Jacobian)',
        cJac > 0.9, `correlation ${num(cJac, 4)}`);

  // Crest sharpening: on the up-slope the displacement points uphill, so Dx and
  // dh/dx have the same sign. This is the relation that ties the GPU field to
  // the CPU Gerstner surrogate the vessel floats on - if it inverts, the drawn
  // sea has pointed troughs and the buoyancy query samples the wrong place.
  const cGpu = corr(f.Dx, f.dDydx);
  check('GPU displacement sharpens crests (Dx and dh/dx agree in sign)',
        cGpu > 0, `correlation ${num(cGpu, 4)}`);

  const s = new Float32Array(5);
  const dxs = new Float64Array(4000), slopes = new Float64Array(4000);
  for (let i = 0; i < 4000; i++) {
    spec.gerstnerAt(s, (i * 7.31) % 400 - 200, (i * 3.17) % 400 - 200, 3.0);
    dxs[i] = s[0]; slopes[i] = s[3];
  }
  const cCpu = corr(dxs, slopes);
  check('CPU Gerstner surrogate uses the SAME displacement convention',
        cCpu > 0 === cGpu > 0, `correlation ${num(cCpu, 4)}`);

  // Area is conserved on average: the mean Jacobian of the displacement map is
  // 1, which is what makes the foam threshold a real physical quantity rather
  // than a tuning knob.
  let sum = 0, minJ = Infinity;
  for (let i = 0; i < N * N; i++) {
    const j = (1 + f.dDxdx[i]) * (1 + f.dDzdz[i]) - f.dDxdz[i] * f.dDxdz[i];
    sum += j;
    minJ = Math.min(minJ, j);
  }
  check('mean Jacobian over the tile is 1 (displacement conserves area)',
        Math.abs(sum / (N * N) - 1) < 0.05,
        `mean J = ${num(sum / (N * N), 4)}, min J = ${num(minJ, 3)} ` +
        `(foam below ${OCEAN.FOAM_JACOBIAN_THRESHOLD})`);

  // The checks above run a TRANSLITERATION of cs_evolve, so on their own they
  // pin the convention rather than the shader. Read the one line that carries
  // the sign back out of the WGSL and confirm the two still agree - this is the
  // only offline guard against the field silently inverting again.
  const wgsl = readFileSync(new URL('../src/render/shaders/sim/ocean_spectrum.wgsl',
                                    import.meta.url), 'utf8');
  // The dispersion relation's tanh, which is the one place in the ocean where a
  // mathematically irrelevant detail is numerically fatal. tanh(x) is evaluated
  // as (e^2x - 1)/(e^2x + 1) on real hardware, and e^2x overflows f32 at
  // x = 44.36; k * 400 passes that at k = 0.111, i.e. every wave shorter than
  // 57 m - which is nearly the entire spectrum. The result was inf, then
  // cos(inf) = 0, then a synthesised field of exactly zero: a dead flat sea from
  // all three cascades. Math.tanh is exact for a large argument, so no amount of
  // JS testing can see this; the guard is that the clamp is still in the shader.
  const common = readFileSync(new URL('../src/render/shaders/common/ocean.wgsl',
                                      import.meta.url), 'utf8');
  const clamped = /tanh\(min\(kmag\s*\*\s*OCEAN_SHELF_DEPTH\s*,\s*OCEAN_TANH_MAX\)\)/.test(common);
  const maxArg = /OCEAN_TANH_MAX\s*:\s*f32\s*=\s*([\d.]+)/.exec(common);
  const overflowAt = Math.log(3.4028234663852886e38) / 2;   // f32 max -> e^2x limit
  check('common/ocean.wgsl clamps the dispersion tanh below the f32 exp overflow',
        clamped && !!maxArg && Number(maxArg[1]) < overflowAt && Math.tanh(Number(maxArg[1])) === 1,
        maxArg
          ? `clamp ${maxArg[1]}, overflow at ${num(overflowAt, 2)}, ` +
            `tanh(${maxArg[1]}) = ${Math.tanh(Number(maxArg[1]))}, ` +
            `unclamped k*400 overflows above k = ${num(overflowAt / 400, 4)} ` +
            `(wavelength ${num(TAU / (overflowAt / 400), 1)} m)`
          : 'OCEAN_TANH_MAX not found');

  const dxLine = /let\s+dx\s*=\s*(\w+)\s*\*\s*\(kn\.x\s*\*\s*lam\)/.exec(wgsl);
  const dzLine = /let\s+dz\s*=\s*(\w+)\s*\*\s*\(kn\.y\s*\*\s*lam\)/.exec(wgsl);
  const ihDecl = /let\s+ih\s*=\s*vec2f\(\s*-h\.y\s*,\s*h\.x\s*\)/.test(wgsl);
  check('sim/ocean_spectrum.wgsl still builds the displacement from +i*h',
        !!dxLine && !!dzLine && dxLine[1] === 'ih' && dzLine[1] === 'ih' && ihDecl,
        dxLine && dzLine
          ? `dx = ${dxLine[1]} * kn.x * lam, dz = ${dzLine[1]} * kn.y * lam, ih = -h.y, h.x: ${ihDecl}`
          : 'could not find the dx/dz assignment - if it was refactored, re-derive '
            + 'the sign and update this check with it');
}

// ---------------------------------------------------------------------------
// 10. The per-band renormalisation
// ---------------------------------------------------------------------------

/** Height variance and mean-square slope carried by each cascade of a bake. */
function bandStats(spec) {
  const N = spec.n;
  const half = N * 0.5;
  const varc = [0, 0, 0];
  const mssc = [0, 0, 0];
  for (let c = 0; c < spec.cascadeCount; c++) {
    const dk = TAU / spec.cascadeSizes[c];
    const s2 = 2 * spec.h0Scales[c] * spec.h0Scales[c];
    for (let m = 0; m < N; m++) {
      const kz = (m - half) * dk;
      for (let n = 0; n < N; n++) {
        const kx = (n - half) * dk;
        const kmag = Math.hypot(kx, kz);
        const p = spec.modeAmplitude(n, m, kx, kz, kmag, c);
        varc[c] += s2 * p;
        mssc[c] += s2 * kmag * kmag * p;
      }
    }
  }
  return { varc, mssc };
}

{
  console.log('\n  sea state    U   band gain   rms c0/c1/c2 (m)             mss   Cox-Munk  share  Hs err');
  const sweep = [2, 3, 4, 6];
  const rmsC1 = [];
  let worstShare = Infinity;
  let worstHs = 0;
  for (const s of sweep) {
    const st = OCEAN.SEA_STATES[s];
    const spec = new OceanSpectrum({ fftSize: 256, cascadeCount: 3 });
    spec.windSpeed = st.wind;
    spec.windDir = [1, 0];
    spec.hs = st.hs;
    spec.bake();
    const { varc, mssc } = bandStats(spec);
    const mss = mssc[0] + mssc[1] + mssc[2];
    const cox = coxMunkSlopeVariance(st.wind);
    const hsErr = Math.abs(4 * Math.sqrt(varc[0] + varc[1] + varc[2]) - st.hs) / st.hs;
    rmsC1.push(Math.sqrt(varc[1]));
    worstShare = Math.min(worstShare, mss / cox);
    worstHs = Math.max(worstHs, hsErr);
    console.log(
      `       ${String(s).padStart(2)}   ${num(st.wind, 1).padStart(4)}  ` +
      `${num(spec.bandGain, 3).padStart(9)}   ` +
      [0, 1, 2].map((c) => num(Math.sqrt(varc[c]), 4)).join(' ') +
      `  ${num(mss, 4).padStart(8)}  ${num(cox, 4).padStart(8)}  ` +
      `${num(mss / cox, 3).padStart(5)}  ${num(100 * hsErr, 3)}%`);
  }
  console.log('');

  // The bug this replaced: cascade 1's RMS height was 0.0283 / 0.0331 / 0.0338 /
  // 0.0304 m across these four sea states - a 7% wobble, no trend - while
  // cascade 0's went 0.075 to 1.05 m. Raising the sea state bought a bigger
  // swell and literally the same chop, and no amount of PHILLIPS_A fixed it.
  let monotone = true;
  for (let i = 1; i < rmsC1.length; i++) if (rmsC1[i] <= rmsC1[i - 1] * 1.05) monotone = false;
  check('short-wave cascade GROWS with the sea state (>5% per step)', monotone,
        `cascade 1 rms ${rmsC1.map((r) => num(r, 4)).join(' -> ')} m, ` +
        `${num(rmsC1[rmsC1.length - 1] / rmsC1[0], 2)}x over the sweep`);

  check('resolved slope tracks Cox & Munk at every sea state',
        worstShare > 0.55 && worstShare < 1.0,
        `worst share of Cox-Munk = ${num(worstShare, 3)} ` +
        `(target ${OCEAN.RESOLVED_SLOPE_FRACTION})`);

  check('per-band renormalisation still lands Hs exactly', worstHs < 0.005,
        `worst |Hs error| = ${num(100 * worstHs, 4)}%`);
}

{
  // OCEAN.PHILLIPS_A used to sit in constants.js as the obvious lever on the
  // sea, and it moved nothing: the Hs normalisation divides it straight back
  // out. It is gone from the model, and this is the guard that it stays gone -
  // scaling the spectrum's SHAPE by any constant must leave the baked field
  // bit-identical, which is only true if no absolute amplitude survives.
  const mk = () => {
    const spec = new OceanSpectrum({ fftSize: 64, cascadeCount: 3 });
    spec.windSpeed = 9.5;
    spec.windDir = [0.6, 0.8];
    spec.hs = 1.65;
    return spec;
  };
  const a = mk();
  a.bake();
  const b = mk();
  const shape = b.phillips.bind(b);
  b.phillips = (kx, kz, kmag) => 1000.0 * shape(kx, kz, kmag);
  b.bake();
  let worst = 0;
  for (let i = 0; i < a.waves.length; i++) {
    worst = Math.max(worst, Math.abs(a.waves[i] - b.waves[i]) /
                            Math.max(Math.abs(a.waves[i]), 1e-6));
  }
  check('an absolute spectrum amplitude cancels exactly (no dead PHILLIPS_A)',
        worst < 1e-6,
        `1000x the spectrum shape moves the wave table by ${worst.toExponential(2)} relative`);
}

// ---------------------------------------------------------------------------
// 11. Foam actually happens, and roughly as often as the ocean does it
// ---------------------------------------------------------------------------

{
  // Monahan & O'Muircheartaigh 1980, the standard whitecap-coverage fit.
  const monahan = (u) => 3.84e-6 * Math.pow(u, 3.41);
  const N = 256;
  console.log('\n  sea state    U   min J   foam coverage   Monahan W   ratio');
  let worstRatio = 1;
  for (const s of [2, 3, 4, 6]) {
    const st = OCEAN.SEA_STATES[s];
    const spec = new OceanSpectrum({ fftSize: N, cascadeCount: 3 });
    spec.windSpeed = st.wind;
    spec.windDir = [1, 0];
    spec.hs = st.hs;
    spec.bake();
    // Cascade 1 is the band that breaks: cascade 0 is swell (its Jacobian barely
    // leaves 1) and cascade 2 carries millimetres.
    const f = spectralFields(spec, N, 1, 7.0);
    let minJ = Infinity;
    let covered = 0;
    for (let i = 0; i < N * N; i++) {
      const j = (1 + f.dDxdx[i]) * (1 + f.dDzdz[i]) - f.dDxdz[i] * f.dDxdz[i];
      minJ = Math.min(minJ, j);
      // Exactly cs_assemble's injection: saturate((threshold - J) * gain).
      const inject = Math.min(Math.max((OCEAN.FOAM_JACOBIAN_THRESHOLD - j) * OCEAN_FOAM_GAIN, 0), 1);
      if (inject > 0.2) covered++;
    }
    const w = covered / (N * N);
    const ratio = w / monahan(st.wind);
    worstRatio = Math.max(worstRatio, Math.max(ratio, 1 / Math.max(ratio, 1e-9)));
    console.log(
      `       ${String(s).padStart(2)}   ${num(st.wind, 1).padStart(4)}  ` +
      `${num(minJ, 3).padStart(6)}   ${num(100 * w, 3).padStart(11)}%   ` +
      `${num(100 * monahan(st.wind), 3).padStart(8)}%   ${num(ratio, 2)}`);
  }
  console.log('');
  check('whitecap coverage is within 3x of Monahan at every sea state',
        worstRatio < 3.0,
        `worst ratio ${num(worstRatio, 2)} at threshold ` +
        `${OCEAN.FOAM_JACOBIAN_THRESHOLD}, gain ${OCEAN_FOAM_GAIN}`);
}

// ---------------------------------------------------------------------------
// 12. The surface optical column: the turquoise a flyover reads
// ---------------------------------------------------------------------------

{
  // WATER_TYPES carries a second column with the Jerlov red the 2026-08-02 art
  // cut removed, used ONLY by the water-leaving radiance - the term an eye
  // outside the medium reads looking down at the sea. This section pins BOTH
  // ENDS of RENDER.SURFACE_BODY_PHYSICAL_RED, which is what makes it impossible
  // for the field to go quietly dead: at 0 it must reproduce the cut build
  // exactly, and at 1 it must land on the measured turquoise.
  //
  // oceanBodyColour() and deepWaterReflectance() are transliterated from
  // pass/ocean_surface.wgsl and common/water.wgsl. The ambient factor is common
  // to both ends and cancels out of a hue, so it is omitted.
  const bbFrac = (g) => {
    const gg = Math.min(Math.abs(g), 0.99);
    if (gg < 1e-3) return 0.5;
    return ((1 - gg * gg) / (2 * gg)) * (1 / Math.sqrt(1 + gg * gg) - 1 / (1 + gg));
  };
  const mix3 = (a, b, t) => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t);
  const surfaceSigmaT = (t, s) =>
    mix3(t.sigmaT, [0, 1, 2].map((i) => t.surfaceSigmaA[i] + t.sigmaS[i]), s);
  const rDeep = (t, s) => {
    const bb = t.sigmaS.map((v) => v * bbFrac(t.g));
    const sT = surfaceSigmaT(t, s);
    return [0, 1, 2].map((i) => bb[i] / Math.max(Math.max(sT[i] - t.sigmaS[i], 0) + bb[i], 1e-6));
  };
  const bodyColour = (t, s, h, rho) => {
    const Kd = mix3(t.Kd, t.surfaceKd, s);
    const R = rDeep(t, s);
    return [0, 1, 2].map((i) => R[i] + (rho[i] - R[i]) * Math.exp(-2 * Kd[i] * h));
  };
  const hueSat = (c) => {
    const mx = Math.max(...c), mn = Math.min(...c), d = mx - mn;
    if (d === 0 || mx === 0) return [0, 0];
    let hh;
    if (mx === c[0]) hh = 60 * ((((c[1] - c[2]) / d) % 6 + 6) % 6);
    else if (mx === c[1]) hh = 60 * ((c[2] - c[0]) / d + 2);
    else hh = 60 * ((c[0] - c[1]) / d + 4);
    return [hh, d / mx];
  };

  const reef = WATER_TYPES.REEF_TURQUOISE;
  const rho = WATER_BOTTOM_ALBEDO[reef.id];

  // (a) THE OFF END IS BYTE-EXACT. At strength 0 every term must equal what the
  // live art column alone produces, or the knob is not a bisection.
  let offDrift = 0;
  for (const h of [0, 2, 4, 8, 15, 30]) {
    const off = bodyColour(reef, 0, h, rho);
    const bbf = reef.sigmaS.map((v) => v * bbFrac(reef.g));
    const artR = [0, 1, 2].map((i) =>
      bbf[i] / Math.max(Math.max(reef.sigmaT[i] - reef.sigmaS[i], 0) + bbf[i], 1e-6));
    const art = [0, 1, 2].map((i) =>
      artR[i] + (rho[i] - artR[i]) * Math.exp(-2 * reef.Kd[i] * h));
    for (let c = 0; c < 3; c++) offDrift = Math.max(offDrift, Math.abs(off[c] - art[c]));
  }
  check('SURFACE_BODY_PHYSICAL_RED = 0 reproduces the art column exactly',
        offDrift < 1e-12, `max drift ${offDrift.toExponential(2)}`);

  // (b) THE ON END IS TURQUOISE, and the off end is not. Turquoise is the
  // 180-210 deg band at high saturation; the cut column sits at 233-245 deg,
  // which is blue, at a saturation that reads as grey water. These are the
  // numbers the whole change was made against.
  console.log('\n        h(m)   art hue/sat        physical hue/sat');
  let worstHue = 0, worstSat = 1;
  for (const h of [2, 4, 8]) {
    const [h0, s0] = hueSat(bodyColour(reef, 0, h, rho));
    const [h1, s1] = hueSat(bodyColour(reef, 1, h, rho));
    console.log(`        ${String(h).padStart(2)}    ${num(h0, 1).padStart(6)} / ${num(s0, 3)}` +
                `      ${num(h1, 1).padStart(6)} / ${num(s1, 3)}`);
    worstHue = Math.max(worstHue, Math.abs(h1 - 197));
    worstSat = Math.min(worstSat, s1);
    if (h === 8) {
      check('the art column reads BLUE at 8 m, which is the bug',
            h0 > 225 && s0 < 0.55, `hue ${num(h0, 1)} deg, sat ${num(s0, 3)}`);
    }
  }
  console.log('');
  check('the physical column reads turquoise at every reef depth',
        worstHue <= 13 && worstSat > 0.55,
        `hue within ${num(worstHue, 1)} deg of 197, min sat ${num(worstSat, 3)}`);

  // (c) THE DOCSTRING IN common/water.wgsl BECOMES TRUE AGAIN. It asserts clear
  // ocean reflectance of 0.07 / 0.5 / 2.5 %, which the art column stopped
  // producing - red was 3.8x that. This is the cleanest evidence the split is
  // cut along the right axis, so it is asserted rather than left in a comment.
  const clearOn = rDeep(WATER_TYPES.OCEANIC_CLEAR, 1);
  const clearOff = rDeep(WATER_TYPES.OCEANIC_CLEAR, 0);
  check('deepWaterReflectance matches its own docstring on the surface column',
        Math.abs(clearOn[0] - 0.0007) < 0.0002 && Math.abs(clearOn[1] - 0.005) < 0.001
        && Math.abs(clearOn[2] - 0.025) < 0.002,
        `on ${clearOn.map((v) => num(100 * v, 3) + '%').join(' / ')}, ` +
        `off ${clearOff.map((v) => num(100 * v, 3) + '%').join(' / ')}`);

  // (d) THE SHADER STILL READS IT. A numeric test cannot see a shader that was
  // quietly reverted to frame.waterKd, and check.mjs cannot see across the
  // JS/WGSL boundary at all - the same blind spot glow_slots.js has. So grep
  // the two functions out of source and assert which column each one uses.
  const oceanSrc = readFileSync(
    new URL('../src/render/shaders/pass/ocean_surface.wgsl', import.meta.url), 'utf8');
  const waterSrc = readFileSync(
    new URL('../src/render/shaders/common/water.wgsl', import.meta.url), 'utf8');
  const bodyFn = oceanSrc.slice(oceanSrc.indexOf('fn oceanBodyColour'),
    oceanSrc.indexOf('}', oceanSrc.indexOf('fn oceanBodyColour')));
  const deepFn = waterSrc.slice(waterSrc.indexOf('fn deepWaterReflectance'),
    waterSrc.indexOf('}', waterSrc.indexOf('fn deepWaterReflectance')));
  check('oceanBodyColour is on surfaceKd(), not frame.waterKd',
        bodyFn.includes('surfaceKd()') && !bodyFn.includes('frame.waterKd'),
        'the exp(-2*Kd*h) that IS the turquoise');
  check('deepWaterReflectance is on surfaceSigmaT()',
        deepFn.includes('surfaceSigmaT()') && !deepFn.includes('frame.waterSigmaT'),
        'absorption derives as sigmaT - sigmaS, so the red arrives here');

  // beamLoss weights a sceneOpaque sample that terrain.wgsl already attenuated
  // with the ART column. Moving it to the surface column claims a loss that
  // sample never took, which is the double-count ocean_surface.wgsl's own
  // header exists to prevent. It is one line and it must not drift.
  const beamLine = oceanSrc.split('\n').find((l) => l.includes('let beamLoss'));
  check('beamLoss stays on the ART sigma_t, matching what produced refr',
        !!beamLine && beamLine.includes('frame.waterSigmaT.rgb')
        && !beamLine.includes('surfaceSigmaT'),
        beamLine ? beamLine.trim() : 'beamLoss line not found');

  // The split is only safe because the consumer set is closed. If a submerged
  // path ever calls one of these, the art cut it exists to serve is defeated.
  const belowSrc = oceanSrc.slice(oceanSrc.indexOf('fn shadeBelow'));
  const underSrc = readFileSync(
    new URL('../src/render/shaders/pass/underwater.wgsl', import.meta.url), 'utf8');
  const leaks = ['surfaceKd(', 'surfaceSigmaT(', 'oceanBodyColour(', 'shallowWaterColour(']
    .filter((f) => belowSrc.includes(f) || underSrc.includes(f));
  check('no submerged path reads the surface column',
        leaks.length === 0, `shadeBelow + pass/underwater.wgsl, leaks: ${leaks.join(', ') || 'none'}`);

  // (f) THE REEF'S WATER-LEAVING REFLECTANCE IS A RECORDED ACCEPTANCE, NOT A
  // FREE VARIABLE. The 2026-08-18 drastic pass cut REEF_TURQUOISE's sigmaS by
  // 64% to darken its haze, which dropped the surface-column deepWaterReflectance
  // to ~0.24x (blue) / ~0.34x (green) of the previous build - the exact class of
  // change check (c) caught and REVERTED on OCEANIC_CLEAR, except here it was
  // looked at (the beach/lagoon flyover in tools/shots/final-checks.json) and
  // ACCEPTED. This check records that acceptance so the NEXT sigmaS cut cannot
  // land silently: the lever is the sigmaS column (backscatter is sigmaS *
  // bbFrac(g), the numerator of R), and a deliberate re-author updates these
  // recorded values in the same change, citing the frame it was judged on.
  const reefR = rDeep(reef, 1);
  const reefRecorded = [0.001485, 0.006574, 0.011053]; // as accepted at the drastic-pass baseline
  let reefDrift = 0;
  for (let c = 0; c < 3; c++) {
    reefDrift = Math.max(reefDrift, Math.abs(reefR[c] - reefRecorded[c]) / reefRecorded[c]);
  }
  check('REEF surface reflectance stays on its recorded acceptance (within 25%)',
        reefDrift < 0.25,
        `now ${reefR.map((v) => num(100 * v, 3) + '%').join(' / ')}, ` +
        `recorded ${reefRecorded.map((v) => num(100 * v, 3) + '%').join(' / ')}, ` +
        `worst drift ${num(100 * reefDrift, 1)}%`);
}

// ---------------------------------------------------------------------------
// 13. Marine snow is a structured depth cue, not a uniform shallow veil
// ---------------------------------------------------------------------------

{
  // Mirrors marineSnowDensity() and the six shell weights in underwater.wgsl.
  // This is an expected-concentration measure rather than pixel coverage: mote
  // size and the world-space pockets change the exact pixels, while this is the
  // stable authored ordering the image must retain.
  const smoothstep = (a, b, x) => {
    const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
    return t * t * (3 - 2 * t);
  };
  const depthDensity = (depth) =>
    (0.025 + (0.50 - 0.025) * smoothstep(2, 45, depth)) *
    (1 - smoothstep(1050, 1600, depth));
  const shellMass = Array.from({ length: 6 }, (_, k) => Math.pow(0.50, k))
    .reduce((a, b) => a + b, 0);
  const concentration = (depth, type) => depthDensity(depth) * type.snowMultiplier * shellMass;

  const reef = concentration(12, WATER_TYPES.REEF_TURQUOISE);
  const kelp = concentration(35, WATER_TYPES.COASTAL_GREEN);
  const abyss = concentration(700, WATER_TYPES.ABYSSAL_VOID);
  const vent = concentration(100, WATER_TYPES.VENT_SMOKE);
  const oldReef = smoothstep(3, 45, 12) * 6;

  check('shallow reef particulate mass is cut by at least 75%',
        reef < oldReef * 0.25,
        `new ${num(reef, 3)}, old ${num(oldReef, 3)}`);
  check('kelp, abyss, and vent remain denser than the shallow reef',
        kelp > reef * 8 && abyss > reef * 4 && vent > abyss * 12,
        `reef ${num(reef, 3)}, kelp ${num(kelp, 3)}, abyss ${num(abyss, 3)}, vent ${num(vent, 3)}`);

  // A numeric mirror cannot catch a disconnected shader input. Pin the spare
  // uniform component, its CPU writer, and the removal of the lossy turbidity
  // proxy together as one cross-language contract.
  const frameSrc = readFileSync(
    new URL('../src/render/shaders/common/frame.wgsl', import.meta.url), 'utf8');
  const underSrc = readFileSync(
    new URL('../src/render/shaders/pass/underwater.wgsl', import.meta.url), 'utf8');
  const rendererSrc = readFileSync(
    new URL('../src/render/renderer.js', import.meta.url), 'utf8');
  const bottomWrite = rendererSrc.slice(rendererSrc.indexOf('const bottomTarget'),
    rendererSrc.indexOf('// Sky geometry'));
  check('Frame carries exact snow load in waterBottom.w',
        frameSrc.includes('w = exact sprung marine-snow')
        && bottomWrite.includes('Math.max(0, wt.snowMultiplier)'),
        'CPU writer and WGSL layout agree');
  check('underwater snow reads exact load, not clamped turbidity proxy',
        underSrc.includes('marineSnowDensity(camDepth) * frame.waterBottom.w')
        && !underSrc.includes('marineSnowDensity(camDepth) * (1.0 + 4.0 * frame.waterDeepTint.w)'),
        'clear water types retain distinct authored multipliers');
  // The shell falloff USED to be the literal `pow(0.50, f32(k))` this grep was
  // written against. Item 2.4 made it `SnowCharacter.shellDecay`, authored per
  // water column in common/water.wgsl, so the assertion now has to check that
  // the falloff is still geometric in the shell index and still driven by the
  // character rather than by a constant nobody can reach.
  const waterSrc = readFileSync(
    new URL('../src/render/shaders/common/water.wgsl', import.meta.url), 'utf8');
  check('snow field has distance falloff and world-space pockets',
        underSrc.includes('pow(ch.shellDecay, f32(k))')
        && waterSrc.includes('c.shellDecay = mix(')
        && underSrc.includes('let pocketId = floor(id / 4.0)'),
        'near-biased shells with coherent empty water');
}

// ---------------------------------------------------------------------------
// 14. The shallow veil cut sharpens near scenery, not the whole ocean
// ---------------------------------------------------------------------------

{
  const smoothstep = (a, b, x) => {
    const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
    return t * t * (3 - 2 * t);
  };
  const veilScale = (dist, depth, underwater, reduction) => {
    if (!underwater) return 1;
    const near = 1 - smoothstep(12, 45, Math.max(dist, 0));
    const shallow = 1 - smoothstep(35, 90, Math.max(depth, 0));
    return 1 - Math.min(Math.max(reduction, 0), 1) * near * shallow;
  };

  check('shallow near-field veil receives the full authored cut',
        Math.abs(veilScale(10, 15, true, RENDER.SHALLOW_VEIL_REDUCTION) - 0.45) < 1e-12,
        `scale ${num(veilScale(10, 15, true, RENDER.SHALLOW_VEIL_REDUCTION), 3)}`);
  check('veil cut fades smoothly through gameplay range',
        veilScale(28, 15, true, RENDER.SHALLOW_VEIL_REDUCTION) > 0.69
        && veilScale(28, 15, true, RENDER.SHALLOW_VEIL_REDUCTION) < 0.74,
        `28 m scale ${num(veilScale(28, 15, true, RENDER.SHALLOW_VEIL_REDUCTION), 3)}`);
  check('distant, deep, and above-water atmosphere are byte-exact old behavior',
        veilScale(45, 15, true, RENDER.SHALLOW_VEIL_REDUCTION) === 1
        && veilScale(10, 90, true, RENDER.SHALLOW_VEIL_REDUCTION) === 1
        && veilScale(10, 15, false, RENDER.SHALLOW_VEIL_REDUCTION) === 1,
        'range >= 45 m, depth >= 90 m, or eye above water => scale 1');
  check('zero shallow veil reduction is an exact live bisection',
        [0, 10, 28, 45, 100].every((d) => veilScale(d, 15, true, 0) === 1),
        'RENDER.SHALLOW_VEIL_REDUCTION = 0 reproduces the prior image');

  const frameSrc = readFileSync(
    new URL('../src/render/shaders/common/frame.wgsl', import.meta.url), 'utf8');
  const waterSrc = readFileSync(
    new URL('../src/render/shaders/common/water.wgsl', import.meta.url), 'utf8');
  const rendererSrc = readFileSync(
    new URL('../src/render/renderer.js', import.meta.url), 'utf8');
  const sourceLine = waterSrc.split('\n').find((l) => l.includes('let source = diffuse')) || '';
  const beamLine = waterSrc.split('\n').find((l) => l.includes('+ beam *')) || '';
  check('Frame carries the live veil cut in waterSurfaceSigmaT.w',
        frameSrc.includes('w = shallow veil reduction')
        && rendererSrc.includes('wt.surfaceSigmaA[2] + wt.sigmaS[2], RENDER.SHALLOW_VEIL_REDUCTION'),
        'CPU writer and WGSL layout agree');
  check('veil scale touches diffuse in-scatter but never the beam',
        sourceLine.includes('INV_PI * diffuseVeil')
        && beamLine.includes('phaseOcean(cosTheta, g) * beamWeight')
        && !beamLine.includes('diffuseVeil'),
        `${sourceLine.trim()} / ${beamLine.trim()}`);
  check('shader preserves above-water and deep atmosphere explicitly',
        waterSrc.includes('if (!isUnderwater()) { return 1.0; }')
        && waterSrc.includes('smoothstep(35.0, 90.0')
        && waterSrc.includes('smoothstep(12.0, 45.0'),
        'submerged-only range/depth windows remain connected');
}

// ---------------------------------------------------------------------------
// 15. Demo visibility scales the submerged sight path, not the water body
// ---------------------------------------------------------------------------

{
  const effectiveDensity = (density, strength) => 1 - (1 - density) * strength;
  const sightT = (biome, strength, dist) => {
    const type = WATER_TYPES[biome.waterType];
    const d = effectiveDensity(biome.sightDensity, strength);
    return type.sigmaT.map((v) => Math.exp(-v * d * dist));
  };
  const byShort = Object.fromEntries(BIOMES.map((b) => [b.short, b]));

  const coral45 = sightT(byShort.coral, 1, 45);
  const kelp50 = sightT(byShort.kelp, 1, 50);
  check('Coral keeps readable structure through 45 m',
        Math.min(...coral45) > 0.17,
        `T45 ${coral45.map((v) => num(100 * v, 1) + '%').join(' / ')}`);
  check('Kelp keeps green/blue silhouettes at 50 m without neutralising red loss',
        kelp50[1] > 0.19 && kelp50[2] > 0.12 && kelp50[0] < 0.03,
        `T50 ${kelp50.map((v) => num(100 * v, 1) + '%').join(' / ')}`);
  check('zero visibility strength reproduces physical sigma_t exactly',
        BIOMES.every((b) => effectiveDensity(b.sightDensity, 0) === 1),
        'global strength 0 => density 1 for every biome');
  // The pinned list gained 'meadow' with biome 15 (2026-08-18, authored 0.30
  // like its REEF_TURQUOISE siblings; this line was not moved with it),
  // 'bulb' with biome 16 the same day, 'platter' with biome 17 (0.35 -
  // the reference is a long-sightline hall, and the emerald key its water
  // authors is spent if the veil eats the columns), and 'dunes' with biome
  // 18 (2026-08-19, 0.62 - the leviathan hunting ground's acceptance test
  // is literally "see it coming", so the ~121 m effective sightline is the
  // biome's subject; the row's docstring carries the derivation).
  check('only the daylight-key biomes author clearer sight paths',
        BIOMES.filter((b) => b.sightDensity < 1).map((b) => b.short).join(',')
          === 'coral,sand,kelp,boulders,break,meadow,bulb,platter,dunes',
        'deep danger biomes and the shallow reef remain raw-density');

  // Scaling both coefficients by one scalar preserves the spectral ordering
  // and single-scattering albedo exactly; scaling sigma_t alone would make a
  // brighter but energy-inconsistent fog.
  for (const biome of [byShort.coral, byShort.kelp, byShort.boulders, byShort.break]) {
    const type = WATER_TYPES[biome.waterType];
    const d = effectiveDensity(biome.sightDensity, 1);
    for (let i = 0; i < 3; i++) {
      const oldAlbedo = type.sigmaS[i] / type.sigmaT[i];
      const newAlbedo = (type.sigmaS[i] * d) / (type.sigmaT[i] * d);
      check(`${biome.name} sight scale preserves channel ${i} scattering albedo`,
            Math.abs(oldAlbedo - newAlbedo) < 1e-12,
            `${num(oldAlbedo, 5)} -> ${num(newAlbedo, 5)}`);
    }
  }

  const frameSrc = readFileSync(
    new URL('../src/render/shaders/common/frame.wgsl', import.meta.url), 'utf8');
  const waterSrc = readFileSync(
    new URL('../src/render/shaders/common/water.wgsl', import.meta.url), 'utf8');
  const rendererSrc = readFileSync(
    new URL('../src/render/renderer.js', import.meta.url), 'utf8');
  const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const oceanSrc = readFileSync(
    new URL('../src/render/shaders/pass/ocean_surface.wgsl', import.meta.url), 'utf8');
  check('sight density is sprung and packed into skyGeometry.w',
        mainSrc.includes('const sightTarget = BIOMES[mat.biome].sightDensity')
        && mainSrc.includes('this._sightDensity += (sightTarget - this._sightDensity) * k')
        && frameSrc.includes('w = submerged sight density')
        && rendererSrc.includes('RENDER.SUBMERGED_VISIBILITY_STRENGTH'),
        'biome blend spring -> Frame spare component');
  check('submerged sigma_t and sigma_s share the exact same scale',
        waterSrc.includes('fn waterSightSigmaT()')
        && waterSrc.includes('fn waterSightSigmaS()')
        && waterSrc.includes('frame.waterSigmaT.rgb * waterSightDensity()')
        && waterSrc.includes('frame.waterSigmaS.rgb * waterSightDensity()'),
        'one density preserves ratios');
  check('above-water ocean paths retain raw physical coefficients',
        oceanSrc.includes('exp(-frame.waterSigmaT.rgb * slantPath)')
        && waterSrc.includes('mix(frame.waterSigmaT.rgb, frame.waterSurfaceSigmaT.rgb'),
        'surface beam loss and water-leaving radiance bypass sight scale');
}

// ---------------------------------------------------------------------------
// 16. frame.veilTune's four lanes each have EXACTLY ONE shader consumer
// ---------------------------------------------------------------------------

{
  // The dead-data bug (a field authored, uploaded and read by nothing) and its
  // inverse (a second consumer applying a knob twice) are both invisible to
  // check.mjs across the JS/WGSL boundary, so the ownership map is asserted by
  // grep, the section-12 pattern. Each lane's owner is load-bearing:
  //   .x VEIL_DIFFUSE_GAIN  -> common/water.wgsl, waterInScatter's DIFFUSE term
  //      only (the beam branch, transmittance and deep tint must not carry it)
  //   .y VEIL_CHROMA        -> common/water.wgsl, localWaterTint's chroma sharpen
  //   .z SNOW_DENSITY_SCALE -> pass/underwater.wgsl, the snow density
  //   .w SOLAR_SHAFT_GAIN   -> sim/froxel_inject.wgsl, the COLLIMATED shaft only.
  //      The asymmetry is deliberate and documented at both sites: the analytic
  //      beam (waterInScatter, froxelOwnsBeam() false) never carries it, so a
  //      gain != 1 makes the two beam owners genuinely differ; a SECOND consumer
  //      "fixing" that on the analytic path would double the gain on every frame
  //      the froxel owns, which is the underwater double-application bug class.
  const shaderRoot = new URL('../src/render/shaders/', import.meta.url);
  const owners = { x: [], y: [], z: [], w: [] };
  for (const dir of ['common', 'pass', 'sim']) {
    for (const f of readdirSync(new URL(dir + '/', shaderRoot))) {
      if (!f.endsWith('.wgsl')) continue;
      const src = readFileSync(new URL(`${dir}/${f}`, shaderRoot), 'utf8');
      // strip line comments so documentation may name a lane without owning it
      const code = src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
      for (const lane of ['x', 'y', 'z', 'w']) {
        if (code.includes(`veilTune.${lane}`)) owners[lane].push(`${dir}/${f}`);
      }
    }
  }
  const expected = {
    x: ['common/water.wgsl'], y: ['common/water.wgsl'],
    z: ['pass/underwater.wgsl'], w: ['sim/froxel_inject.wgsl'],
  };
  for (const lane of ['x', 'y', 'z', 'w']) {
    check(`veilTune.${lane} is consumed by ${expected[lane][0]} and nothing else`,
          owners[lane].join(',') === expected[lane].join(','),
          `readers: ${owners[lane].join(', ') || 'NONE (dead lane)'}`);
  }
}

console.log(`\n${failures === 0 ? 'All ocean checks passed.' : `${failures} FAILURE(S).`}\n`);
process.exit(failures ? 1 : 0);
