#!/usr/bin/env node
/**
 * Caustics tile verification.
 *
 * Everything here runs offline: it imports the REAL lattice, ring sizes and
 * constants out of src/render/passes/caustics.js, replicates buildWaves() and
 * the arithmetic of shaders/sim/caustics.wgsl, and measures the tile. What it
 * proves:
 *
 *   1. Lattice hygiene. Integer entries, no duplicates, and - the one that
 *      matters - no two modes anywhere sharing a primitive DIRECTION, with k
 *      and -k counted as the same one. Two counter-propagating modes of equal
 *      |k| lock their curvature to one spatial pattern and read as a standing
 *      stripe; the ten-mode set this replaced broke its own comment three times.
 *   2. Periodicity. The texture is sampled as a world-space repeat, so every
 *      wavevector must be an exact integer multiple of 2*PI/CAUSTICS_SCALE or
 *      there is a seam on every seabed in the game.
 *   3. The sampling floor. The shortest mode must still get 8 texels at the
 *      LOWEST preset resolution, which is what sizes CAUSTICS_SCALE.
 *   4. sigma is exact. The focusing invariant recomputed from the EMITTED
 *      amplitudes must equal CAUSTIC_FOCUS_SIGMA at every weather state and
 *      wind heading - that is the whole point of pinning an rms rather than an
 *      L1 sum, and it is what the deleted windGain made impossible.
 *   4b. ...and the invariant is the one the docstring names. 4 alone CANNOT
 *      FAIL - it evaluates the same closed form on amplitudes that were divided
 *      by it - so 4b samples the Hessian NUMERICALLY over the tile and checks
 *      the closed form against the field. It also measures c*rms(h_xx), which
 *      an earlier draft claimed sigma was, and which swings 2.2x with heading.
 *   5. The tile FOLDS. det J must reach its floor in every weather state and at
 *      every wind heading, with the fold and clamp fractions inside the honesty
 *      budget the single-sheet model can carry.
 *   6. The baked means are still the means. RENDER.CAUSTIC_TILE_MEAN and
 *      RENDER.CAUSTIC_COMPOSITE_MEAN are constants in two shaders; this is what
 *      makes baking them safe instead of publishing them per rebake.
 *   7. The mip chain preserves the mean at every level, which is why it is a
 *      box filter and not a tent or a Gaussian - checked against the OFFSETS
 *      AND WEIGHTS PARSED OUT OF sim/caustics_mip.wgsl, because a JS box chain
 *      on even dimensions preserves the mean by construction and would go on
 *      passing if the shader were swapped for a tent.
 *   8. The consumer cannot run away. mean 1 and a hard ceiling, against the
 *      predecessor's mean 3.86 and ceiling 94.6.
 *   9. ...and it does not drift with minification more than the recorded
 *      amount. CAUSTIC_COMPOSITE_MEAN is baked at LOD 0 and applied at every
 *      LOD, so the DC rises as the box chain stops the clamp firing. Pinned
 *      here so it cannot grow unnoticed.
 *
 * Run:  node tools/test-caustics.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { OceanSpectrum } from '../src/sim/ocean.js';
import { RENDER, WEATHER } from '../src/core/constants.js';
import { TAU } from '../src/core/math.js';
import {
  LATTICE, RING_SIZES, CAUSTIC_WAVES, CAUSTIC_FOCUS_SIGMA,
  RECEIVER_DEPTH, INTENSITY_CLAMP, IOR_RGB,
} from '../src/render/passes/caustics.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const TILE = RENDER.CAUSTICS_SCALE;
const BASE = TAU / TILE;
const DET_FLOOR = 1e-3;           // matches the max(abs(det), 1e-3) in the shader
const STATES = ['clear', 'breezy', 'overcast', 'squall', 'storm', 'fogbank'];
/**
 * DENSE. This was [0, 37, 74, 111], which stepped over the tile mean's own
 * minimum at 75 deg and so reported the spread as +/-0.32% when it is +/-0.59%.
 * A four-point sweep of a quantity with 90 deg structure is not a sweep.
 */
const HEADINGS = Array.from({ length: 12 }, (_, i) => i * 15);
/** Phases spanning the exact 200 s loop: every omega is a multiple of 2*PI/200. */
const PHASES = Array.from({ length: 8 }, (_, i) => (i * 200) / 8);

// ---------------------------------------------------------------------------
// buildWaves(), replicated
// ---------------------------------------------------------------------------

/** k-space annulus area per ring member. Same construction as caustics.js. */
const RING_AREA = (() => {
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
  const out = new Float64Array(LATTICE.length);
  o = 0;
  for (let r = 0; r < n; r++) {
    const kIn = edges[r] * BASE;
    const kOut = edges[r + 1] * BASE;
    const dA = (Math.PI * (kOut * kOut - kIn * kIn)) / RING_SIZES[r];
    for (let i = 0; i < RING_SIZES[r]; i++) out[o++] = dA;
  }
  return out;
})();

function spectrumFor(stateId, headingDeg) {
  const sp = new OceanSpectrum();
  sp.windSpeed = WEATHER[stateId.toUpperCase()].windSpeed;
  const a = (headingDeg * Math.PI) / 180;
  sp.windDir = [Math.cos(a), Math.sin(a)];
  return sp;
}

/** The wave table the pass would write into its uniform buffer. */
function buildWaves(spectrum) {
  const c = RECEIVER_DEPTH * (1 - 1 / IOR_RGB[1]);
  const amps = new Float64Array(CAUSTIC_WAVES);
  const kmags = new Float64Array(CAUSTIC_WAVES);
  let sumSq = 0;
  for (let i = 0; i < CAUSTIC_WAVES; i++) {
    const kx = LATTICE[i][0] * BASE;
    const kz = LATTICE[i][1] * BASE;
    const kmag = Math.hypot(kx, kz);
    kmags[i] = kmag;
    amps[i] = Math.sqrt(Math.max(2 * spectrum.phillips(kx, kz, kmag) * RING_AREA[i], 0));
    const q = amps[i] * kmag * kmag;
    sumSq += q * q;
  }
  const sigmaRaw = c * Math.sqrt((3 / 16) * sumSq);
  const scale = sigmaRaw > 1e-12 ? CAUSTIC_FOCUS_SIGMA / sigmaRaw : 0;
  const waves = [];
  for (let i = 0; i < CAUSTIC_WAVES; i++) {
    waves.push({
      nx: LATTICE[i][0], nz: LATTICE[i][1],
      kx: LATTICE[i][0] * BASE, kz: LATTICE[i][1] * BASE, kmag: kmags[i],
      amp: amps[i] * scale,
      omega: spectrum.omega(kmags[i]),
      phase: ((i * 0.6180339887) % 1) * TAU,
    });
  }
  return waves;
}

/** sigma = c * rms(h_xx) for an isotropic set, from the emitted amplitudes. */
function sigmaOf(waves, c) {
  let s = 0;
  for (const w of waves) {
    const q = w.amp * w.kmag * w.kmag;
    s += q * q;
  }
  return c * Math.sqrt((3 / 16) * s);
}

// ---------------------------------------------------------------------------
// cs_caustics(), replicated
// ---------------------------------------------------------------------------

/**
 * Hessian of the wave sum on a res x res tile at every listed time.
 *
 * Separable: on the integer lattice cos(k.p) factors into per-axis tables, so
 * the whole sweep costs one trig table per mode instead of res^2 evaluations.
 */
function hessianCache(waves, res, times) {
  const n = waves.length;
  const cells = res * res;
  const hxx = new Float32Array(cells * times.length);
  const hzz = new Float32Array(cells * times.length);
  const hxz = new Float32Array(cells * times.length);
  const cu = [], su = [], cv = [], sv = [];
  for (let i = 0; i < n; i++) {
    const au = new Float64Array(res), bu = new Float64Array(res);
    const av = new Float64Array(res), bv = new Float64Array(res);
    for (let j = 0; j < res; j++) {
      const t = (j + 0.5) / res;
      au[j] = Math.cos(TAU * waves[i].nx * t); bu[j] = Math.sin(TAU * waves[i].nx * t);
      av[j] = Math.cos(TAU * waves[i].nz * t); bv[j] = Math.sin(TAU * waves[i].nz * t);
    }
    cu.push(au); su.push(bu); cv.push(av); sv.push(bv);
  }
  const cxx = new Float64Array(n), czz = new Float64Array(n), cxz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = waves[i];
    cxx[i] = w.amp * w.kx * w.kx;
    czz[i] = w.amp * w.kz * w.kz;
    cxz[i] = w.amp * w.kx * w.kz;
  }
  for (let ti = 0; ti < times.length; ti++) {
    const t = times[ti];
    const ct = new Float64Array(n), st = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const tp = -waves[i].omega * t + waves[i].phase;
      ct[i] = Math.cos(tp); st[i] = Math.sin(tp);
    }
    const off = ti * cells;
    for (let y = 0; y < res; y++) {
      const row = off + y * res;
      for (let x = 0; x < res; x++) {
        let axx = 0, azz = 0, axz = 0;
        for (let i = 0; i < n; i++) {
          const cs = cu[i][x] * cv[i][y] - su[i][x] * sv[i][y];
          const ss = su[i][x] * cv[i][y] + cu[i][x] * sv[i][y];
          const cth = cs * ct[i] - ss * st[i];
          axx -= cxx[i] * cth; azz -= czz[i] * cth; axz -= cxz[i] * cth;
        }
        const o = row + x;
        hxx[o] = axx; hzz[o] = azz; hxz[o] = axz;
      }
    }
  }
  return { hxx, hzz, hxz, cells, times: times.length };
}

/** E = min(1/max(|det J|, floor), clamp) plus the statistics of det itself. */
function tileStats(cache, ch) {
  const c = RECEIVER_DEPTH * (1 - 1 / IOR_RGB[ch]);
  const total = cache.cells * cache.times;
  let minDet = Infinity, fold = 0, clamped = 0, s = 0, s2 = 0;
  for (let o = 0; o < total; o++) {
    const det = (1 + c * cache.hxx[o]) * (1 + c * cache.hzz[o]) - (c * cache.hxz[o]) ** 2;
    const a = Math.abs(det);
    if (a < minDet) minDet = a;
    if (det < 0) fold++;
    const e = Math.min(1 / Math.max(a, DET_FLOOR), INTENSITY_CLAMP);
    if (e >= INTENSITY_CLAMP - 1e-9) clamped++;
    s += e; s2 += e * e;
  }
  const mean = s / total;
  return {
    minDet, fold: fold / total, clamp: clamped / total, mean,
    sd: Math.sqrt(Math.max(s2 / total - mean * mean, 0)),
  };
}

/** One channel's tile, at every time in the cache. */
function buildTiles(cache, res, ch) {
  const c = RECEIVER_DEPTH * (1 - 1 / IOR_RGB[ch]);
  const n = cache.cells * cache.times;
  const out = new Float32Array(n);
  for (let o = 0; o < n; o++) {
    const det = (1 + c * cache.hxx[o]) * (1 + c * cache.hzz[o]) - (c * cache.hxz[o]) ** 2;
    out[o] = Math.min(1 / Math.max(Math.abs(det), DET_FLOOR), INTENSITY_CLAMP);
  }
  return out;
}

/** Bilinear sample of a tile with a repeating address mode. */
function sampleRepeat(tile, base, res, u, v) {
  const x = u * res - 0.5, y = v * res - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const i0 = ((x0 % res) + res) % res, i1 = (((x0 + 1) % res) + res) % res;
  const j0 = ((y0 % res) + res) % res, j1 = (((y0 + 1) % res) + res) % res;
  const a = tile[base + j0 * res + i0], b = tile[base + j0 * res + i1];
  const c = tile[base + j1 * res + i0], d = tile[base + j1 * res + i1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/**
 * causticFactor()'s composite at k = 1, sampled at texel rate over a `patch`
 * metre square of world so the two taps' relative offsets are the real ones.
 */
function compositeStats(tiles, res, times, mean, grid = 192, patch = 28) {
  const tap2 = RENDER.CAUSTIC_TAP2_SCALE;
  const cells = res * res;
  let s = 0, n = 0, mx = -Infinity, mn = Infinity;
  for (let ti = 0; ti < times.length; ti++) {
    const base = ti * cells, t = times[ti];
    for (let gy = 0; gy < grid; gy++) {
      for (let gx = 0; gx < grid; gx++) {
        const u = ((gx + 0.5) / grid * patch) / TILE;
        const v = ((gy + 0.5) / grid * patch) / TILE;
        const c1 = sampleRepeat(tiles, base, res, u + 0.014 * t, v - 0.011 * t);
        const c2 = sampleRepeat(tiles, base, res, u * tap2 - 0.019 * t, v * tap2 + 0.008 * t);
        const e = Math.min((c1 / mean) * (c2 / mean), RENDER.CAUSTICS_INTENSITY_CLAMP);
        s += e; n++;
        if (e > mx) mx = e;
        if (e < mn) mn = e;
      }
    }
  }
  return { mean: s / n, min: mn, max: mx };
}

// ---------------------------------------------------------------------------
// 1. Lattice hygiene
// ---------------------------------------------------------------------------

console.log('\n  1. lattice hygiene\n');

{
  const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a; };
  const primKey = (n) => {
    const g = gcd(n[0], n[1]) || 1;
    let x = n[0] / g, z = n[1] / g;
    if (x < 0 || (x === 0 && z < 0)) { x = -x; z = -z; }
    return `${x},${z}`;
  };

  check('every LATTICE entry is a pair of integers',
        LATTICE.every((n) => n.length === 2 && Number.isInteger(n[0]) && Number.isInteger(n[1])));

  const ringSum = RING_SIZES.reduce((a, b) => a + b, 0);
  check('LATTICE.length === CAUSTIC_WAVES === sum(RING_SIZES)',
        LATTICE.length === CAUSTIC_WAVES && ringSum === CAUSTIC_WAVES,
        `${LATTICE.length} / ${CAUSTIC_WAVES} / ${ringSum}`);

  const exact = new Set();
  let dupExact = 0;
  for (const n of LATTICE) {
    const k = `${n[0]},${n[1]}`;
    if (exact.has(k)) dupExact++;
    exact.add(k);
  }
  check('no duplicate wavevectors', dupExact === 0, `${dupExact} duplicates`);

  const dirs = new Map();
  const shared = [];
  for (let i = 0; i < LATTICE.length; i++) {
    const d = primKey(LATTICE[i]);
    if (dirs.has(d)) shared.push(`${dirs.get(d)}~${i} (${d})`);
    else dirs.set(d, i);
  }
  check('no two modes share a primitive direction (k and -k identified)',
        shared.length === 0,
        shared.length ? shared.join(', ') : `${dirs.size} distinct directions`);

  // The shader carries its own copy of the count and its own array size, and
  // nothing else compares them: a mismatch reads back garbage amplitudes.
  const src = readFileSync(join(ROOT, 'src/render/shaders/sim/caustics.wgsl'), 'utf8');
  const nWaves = Number((src.match(/const\s+CAUSTIC_WAVES\s*:\s*u32\s*=\s*(\d+)u/) || [])[1]);
  const nArray = Number((src.match(/waves\s*:\s*array<vec4f,\s*(\d+)>/) || [])[1]);
  check('sim/caustics.wgsl agrees with the JS wave count',
        nWaves === CAUSTIC_WAVES && nArray === CAUSTIC_WAVES * 2,
        `shader ${nWaves} waves / array ${nArray}, JS ${CAUSTIC_WAVES}`);

  // The mip depth is one number in four places: the texture declaration, the
  // dispatch count, and the CAUSTIC_MAX_LOD define in BOTH the renderer and the
  // offline compiler. Only one of the ways to break the set fails loudly -
  // dispatching fewer levels than are declared leaves the tail holding
  // undefined contents and textureSampleLevel reports nothing. All four are
  // derived from RENDER.CAUSTICS_MIP_LEVELS now; this is what keeps them that way.
  const derived = [
    ['src/render/renderer.js', /CAUSTIC_MAX_LOD:\s*`?\$?\{?\(?RENDER\.CAUSTICS_MIP_LEVELS/],
    ['tools/wgsl-compile.mjs', /CAUSTIC_MAX_LOD:\s*\(?RENDER\.CAUSTICS_MIP_LEVELS/],
    ['src/render/renderer.js', /mips:\s*RENDER\.CAUSTICS_MIP_LEVELS/],
    ['src/render/passes/caustics.js', /MIP_LEVELS\s*=\s*RENDER\.CAUSTICS_MIP_LEVELS/],
  ];
  const stale = derived.filter(([f, re]) => !re.test(readFileSync(join(ROOT, f), 'utf8')));
  check('the mip depth is DERIVED in all four places, never a literal',
        stale.length === 0,
        stale.length ? stale.map(([f]) => f).join(', ')
                     : `${RENDER.CAUSTICS_MIP_LEVELS} levels, max LOD ${RENDER.CAUSTICS_MIP_LEVELS - 1}`);

  // The tile's ceiling and the composite's ceiling must be ONE number:
  // CAUSTIC_COMPOSITE_MEAN is below 1 only because of the clamp, so a
  // divergence silently invalidates it.
  check('INTENSITY_CLAMP is RENDER.CAUSTICS_INTENSITY_CLAMP, not a second copy',
        INTENSITY_CLAMP === RENDER.CAUSTICS_INTENSITY_CLAMP &&
        /INTENSITY_CLAMP\s*=\s*RENDER\.CAUSTICS_INTENSITY_CLAMP/
          .test(readFileSync(join(ROOT, 'src/render/passes/caustics.js'), 'utf8')),
        `${INTENSITY_CLAMP} / ${RENDER.CAUSTICS_INTENSITY_CLAMP}`);
}

// ---------------------------------------------------------------------------
// 2. Periodicity  -  the tiling contract
// ---------------------------------------------------------------------------

console.log('\n  2. periodicity\n');

{
  let worst = 0;
  for (const [nx, nz] of LATTICE) {
    worst = Math.max(worst,
      Math.abs((nx * BASE * TILE) / TAU - nx),
      Math.abs((nz * BASE * TILE) / TAU - nz));
  }
  check('every mode advances an exact integer number of cycles per tile',
        worst < 1e-12, `residue ${worst.toExponential(3)} cycles`);
}

// ---------------------------------------------------------------------------
// 3. The sampling floor
// ---------------------------------------------------------------------------

console.log('\n  3. sampling floor\n');

{
  // 256 is the LOWEST causticsResolution any preset in gpu.js selects.
  const LOWEST_RES = 256;
  const floorM = (8 * TILE) / LOWEST_RES;
  let maxMag = 0, minMag = Infinity;
  for (const n of LATTICE) {
    const m = Math.hypot(n[0], n[1]);
    if (m > maxMag) maxMag = m;
    if (m < minMag) minMag = m;
  }
  const minLambda = TILE / maxMag;
  check('the shortest mode still gets 8 texels at the LOW preset',
        minLambda >= floorM,
        `lambda ${minLambda.toFixed(4)} m = ${(minLambda / TILE * LOWEST_RES).toFixed(1)} texels ` +
        `(floor ${floorM.toFixed(4)} m); longest ${(TILE / minMag).toFixed(3)} m`);
}

// ---------------------------------------------------------------------------
// 4. sigma is exact at every state and heading
// ---------------------------------------------------------------------------

console.log('\n  4. focusing invariant\n');

{
  const c = RECEIVER_DEPTH * (1 - 1 / IOR_RGB[1]);
  let worst = 0, worstAt = '';
  for (const id of STATES) {
    for (const h of HEADINGS) {
      const waves = buildWaves(spectrumFor(id, h));
      const err = Math.abs(sigmaOf(waves, c) - CAUSTIC_FOCUS_SIGMA);
      if (err > worst) { worst = err; worstAt = `${id}@${h}deg`; }
    }
  }
  check('sigma recomputed from the emitted amplitudes equals CAUSTIC_FOCUS_SIGMA',
        worst < 1e-9,
        `worst |error| ${worst.toExponential(2)} at ${worstAt} (sigma = ${CAUSTIC_FOCUS_SIGMA})`);
}

// ---------------------------------------------------------------------------
// 4b. ...and it is the invariant the docstring names, checked against the FIELD
// ---------------------------------------------------------------------------

console.log('\n  4b. the invariant, against a numerically sampled Hessian\n');

{
  const c = RECEIVER_DEPTH * (1 - 1 / IOR_RGB[1]);
  const RES4 = 256;
  let worstFrob = 0, worstFrobAt = '';
  let worstRatio = 0;
  let hxxLo = Infinity, hxxHi = 0, hxxLoAt = '', hxxHiAt = '';

  for (const id of ['clear', 'fogbank', 'storm']) {
    for (const h of [0, 30, 45, 60, 90, 135]) {
      const waves = buildWaves(spectrumFor(id, h));
      const cache = hessianCache(waves, RES4, [0]);

      let sxx = 0, szz = 0, sxz = 0;
      for (let o = 0; o < cache.cells; o++) {
        sxx += cache.hxx[o] * cache.hxx[o];
        szz += cache.hzz[o] * cache.hzz[o];
        sxz += cache.hxz[o] * cache.hxz[o];
      }
      const frobMeasured = c * Math.sqrt((sxx + szz + 2 * sxz) / cache.cells);
      const rmsHxx = c * Math.sqrt(sxx / cache.cells);

      // Closed form: E[hxx^2 + hzz^2 + 2 hxz^2] = 1/2 sum (A k^2)^2 for ANY
      // direction spread, because cos^4 + sin^4 + 2 cos^2 sin^2 = 1.
      let sumSq = 0;
      for (const w of waves) { const q = w.amp * w.kmag * w.kmag; sumSq += q * q; }
      const frobPredicted = c * Math.sqrt(0.5 * sumSq);

      const err = Math.abs(frobMeasured / frobPredicted - 1);
      if (err > worstFrob) { worstFrob = err; worstFrobAt = `${id}@${h}deg`; }
      worstRatio = Math.max(worstRatio,
        Math.abs(CAUSTIC_FOCUS_SIGMA / frobMeasured - Math.sqrt(3 / 8)));

      if (rmsHxx < hxxLo) { hxxLo = rmsHxx; hxxLoAt = `${id}@${h}deg`; }
      if (rmsHxx > hxxHi) { hxxHi = rmsHxx; hxxHiAt = `${id}@${h}deg`; }
    }
  }

  check('the closed form equals the SAMPLED Frobenius rms of c*H',
        worstFrob < 0.01,
        `worst ${(worstFrob * 100).toFixed(4)}% at ${worstFrobAt}`);
  check('sigma / (c * rms_F) is sqrt(3/8) at every state and heading',
        worstRatio < 1e-3,
        `worst |ratio - ${Math.sqrt(3 / 8).toFixed(6)}| ${worstRatio.toExponential(2)}`);
  // NOT an assertion, a record: sigma is NOT c*rms(h_xx). Phillips' cos^2
  // spreading puts 81-85% of the curvature weight within 45 deg of the wind
  // axis, so h_xx alone swings with the heading and the Frobenius norm does not.
  console.log(`        c*rms(h_xx) spans ${hxxLo.toFixed(4)} (${hxxLoAt}) - ` +
              `${hxxHi.toFixed(4)} (${hxxHiAt}), ratio ${(hxxHi / hxxLo).toFixed(2)}x, ` +
              `against sigma = ${CAUSTIC_FOCUS_SIGMA} - it is NOT that quantity\n`);
}

// ---------------------------------------------------------------------------
// 5 + 6. The tile folds, and the baked means are still the means
// ---------------------------------------------------------------------------

console.log('\n  5. folds, and 6. the baked means\n');

const RES = 256;
let worstTileMean = 0, worstTileAt = '';
let worstComposite = 0, worstCompositeAt = '';
let minFold = 1, maxFold = 0, minClamp = 1, maxClamp = 0, worstMinDet = 0;
let clearRow = null;

{
  const T4 = [0, 50, 100, 150];
  for (const id of STATES) {
    for (const h of HEADINGS) {
      const waves = buildWaves(spectrumFor(id, h));
      const cache = hessianCache(waves, RES, PHASES);
      for (let ch = 0; ch < 3; ch++) {
        const st = tileStats(cache, ch);
        minFold = Math.min(minFold, st.fold); maxFold = Math.max(maxFold, st.fold);
        minClamp = Math.min(minClamp, st.clamp); maxClamp = Math.max(maxClamp, st.clamp);
        worstMinDet = Math.max(worstMinDet, st.minDet);
        const err = Math.abs(st.mean / RENDER.CAUSTIC_TILE_MEAN[ch] - 1);
        if (err > worstTileMean) { worstTileMean = err; worstTileAt = `${id}@${h}deg ch${ch}`; }
        if (id === 'clear' && h === 0 && ch === 1) clearRow = st;
      }
      const small = hessianCache(waves, RES, T4);
      for (let ch = 0; ch < 3; ch++) {
        const tiles = buildTiles(small, RES, ch);
        const cs = compositeStats(tiles, RES, T4, RENDER.CAUSTIC_TILE_MEAN[ch]);
        const err = Math.abs(cs.mean / RENDER.CAUSTIC_COMPOSITE_MEAN[ch] - 1);
        if (err > worstComposite) { worstComposite = err; worstCompositeAt = `${id}@${h}deg ch${ch}`; }
      }
    }
  }

  console.log(`        clear @ 0 deg, green: min|det| ${clearRow.minDet.toExponential(3)}, ` +
              `fold ${(clearRow.fold * 100).toFixed(4)}%, clamp ${(clearRow.clamp * 100).toFixed(4)}%, ` +
              `mean ${clearRow.mean.toFixed(5)}, sd/mean ${(clearRow.sd / clearRow.mean).toFixed(4)}\n`);

  check('det J reaches its floor in EVERY state and heading',
        worstMinDet < 1e-3, `worst min|det| over the sweep ${worstMinDet.toExponential(3)}`);
  check('fold fraction stays inside the single-sheet honesty budget',
        minFold >= 0.0005 && maxFold <= 0.010,
        `${(minFold * 100).toFixed(4)}% - ${(maxFold * 100).toFixed(4)}% (budget 0.05% - 1.0%)`);
  check('clamp fraction stays inside its band',
        minClamp >= 0.008 && maxClamp <= 0.030,
        `${(minClamp * 100).toFixed(4)}% - ${(maxClamp * 100).toFixed(4)}% (band 0.8% - 3.0%)`);
  check('RENDER.CAUSTIC_TILE_MEAN is within 1.5% everywhere',
        worstTileMean < 0.015,
        `worst ${(worstTileMean * 100).toFixed(3)}% at ${worstTileAt}`);
  check('RENDER.CAUSTIC_COMPOSITE_MEAN is within 1.5% everywhere',
        worstComposite < 0.015,
        `worst ${(worstComposite * 100).toFixed(3)}% at ${worstCompositeAt}`);
}

// ---------------------------------------------------------------------------
// 7. The mip chain preserves the mean
// ---------------------------------------------------------------------------

console.log('\n  7. mip chain\n');

{
  // THE SHADER'S OWN KERNEL, not a JS reimplementation of it. A box chain on
  // even dimensions preserves the mean by construction, so a JS-only check
  // would go on passing at 1e-6 with a tent filter in the shader - and the
  // mean-preserving property is what BOTH consumers' normalisation rests on.
  const mipSrc = readFileSync(join(ROOT, 'src/render/shaders/sim/caustics_mip.wgsl'), 'utf8');
  const taps = [...mipSrc.matchAll(/textureLoad\(\s*srcTex\s*,\s*s\s*\+\s*vec2i\((-?\d+)\s*,\s*(-?\d+)\)/g)]
    .map((m) => [Number(m[1]), Number(m[2])]);
  const weight = Number((mipSrc.match(/\(\s*a\s*\+\s*b\s*\+\s*c\s*\+\s*d\s*\)\s*\*\s*([\d.]+)/) || [])[1]);
  const strideTwo = /vec2i\(gid\.xy\)\s*\*\s*2/.test(mipSrc);
  const want = new Set(['0,0', '1,0', '0,1', '1,1']);
  check('sim/caustics_mip.wgsl is the exact 2x2 box: stride 2, four quad taps, weight 1/4',
        strideTwo && taps.length === 4 && new Set(taps.map((t) => t.join(','))).size === 4 &&
        taps.every((t) => want.has(t.join(','))) && Math.abs(weight - 0.25) < 1e-9,
        `stride2 ${strideTwo}, taps ${taps.map((t) => `(${t})`).join('')}, weight ${weight}`);

  const waves = buildWaves(spectrumFor('clear', 0));
  const cache = hessianCache(waves, 512, [0]);
  let cur = buildTiles(cache, 512, 0);
  let res = 512;
  const meanOf = (a, n) => { let s = 0; for (let i = 0; i < n * n; i++) s += a[i]; return s / (n * n); };
  const means = [meanOf(cur, res)];
  for (let lvl = 1; lvl <= 4; lvl++) {
    const nr = res >> 1;
    const next = new Float32Array(nr * nr);
    for (let y = 0; y < nr; y++) {
      for (let x = 0; x < nr; x++) {
        next[y * nr + x] = (cur[2 * y * res + 2 * x] + cur[2 * y * res + 2 * x + 1] +
                            cur[(2 * y + 1) * res + 2 * x] + cur[(2 * y + 1) * res + 2 * x + 1]) * 0.25;
      }
    }
    cur = next; res = nr;
    means.push(meanOf(cur, res));
  }
  let worst = 0;
  for (const m of means) worst = Math.max(worst, Math.abs(m / means[0] - 1));
  check('a 512 -> 32 box chain preserves the mean at every level',
        worst < 1e-6, `levels ${means.map((m) => m.toFixed(6)).join(' / ')}`);
}

// ---------------------------------------------------------------------------
// 8. The consumer cannot run away
// ---------------------------------------------------------------------------

console.log('\n  8. the consumer\n');

{
  const waves = buildWaves(spectrumFor('clear', 0));
  const cache = hessianCache(waves, 512, PHASES);
  let worstMean = 0, worstMax = 0;
  for (let ch = 0; ch < 3; ch++) {
    const tiles = buildTiles(cache, 512, ch);
    const cs = compositeStats(tiles, 512, PHASES, RENDER.CAUSTIC_TILE_MEAN[ch], 256);
    const cm = RENDER.CAUSTIC_COMPOSITE_MEAN[ch];
    worstMean = Math.max(worstMean, Math.abs(cs.mean / cm - 1));
    worstMax = Math.max(worstMax, cs.max / cm);
  }
  check('causticFactor() at k = 1 has mean 1.000 +/- 0.02',
        worstMean < 0.02, `worst |mean - 1| ${(worstMean * 100).toFixed(3)}%`);
  check('causticFactor() at k = 1 cannot exceed 6.2',
        worstMax <= 6.2,
        `ceiling ${worstMax.toFixed(4)} (shipped predecessor: 94.60)`);
}

// ---------------------------------------------------------------------------
// 9. ...and its DC does not run away down the mip chain
// ---------------------------------------------------------------------------

console.log('\n  9. the consumer, minified\n');

{
  // CAUSTIC_COMPOSITE_MEAN is baked at LOD 0 and applied at every LOD. It is
  // below 1 only because the clamp removes energy, and the box chain removes
  // exactly the peaks that clamp - so the DC rises with minification. Small,
  // measured, and pinned here so it cannot grow without anyone noticing.
  const MAXLOD = RENDER.CAUSTICS_MIP_LEVELS - 1;
  const LOD2 = Math.log2(RENDER.CAUSTIC_TAP2_SCALE);
  const T4 = [0, 50, 100, 150];
  const waves = buildWaves(spectrumFor('clear', 0));
  const cache = hessianCache(waves, 512, T4);
  const rows = [];
  let worst = 0, worstAt = '';

  for (let ch = 0; ch < 3; ch++) {
    const full = buildTiles(cache, 512, ch);
    // One box chain per phase, exactly as caustics_mip.wgsl builds it.
    const chains = [];
    for (let ti = 0; ti < T4.length; ti++) {
      let cur = full.subarray(ti * 512 * 512, (ti + 1) * 512 * 512);
      let r = 512;
      const lv = [{ a: cur, r }];
      for (let l = 1; l <= MAXLOD; l++) {
        const nr = r >> 1;
        const next = new Float32Array(nr * nr);
        for (let y = 0; y < nr; y++) {
          for (let x = 0; x < nr; x++) {
            next[y * nr + x] = (cur[2 * y * r + 2 * x] + cur[2 * y * r + 2 * x + 1] +
                                cur[(2 * y + 1) * r + 2 * x] + cur[(2 * y + 1) * r + 2 * x + 1]) * 0.25;
          }
        }
        cur = next; r = nr; lv.push({ a: cur, r });
      }
      chains.push(lv);
    }
    const tap = (lv, u, v) => sampleRepeat(lv.a, 0, lv.r, u, v);
    const m = RENDER.CAUSTIC_TILE_MEAN[ch];
    const cm = RENDER.CAUSTIC_COMPOSITE_MEAN[ch];
    const dc = [];
    for (let L = 0; L <= MAXLOD; L++) {
      // The hardware blends the two levels around a fractional LOD; tap 2 sits
      // a constant log2(CAUSTIC_TAP2_SCALE) coarser, so it is always fractional.
      const l2 = Math.min(Math.max(L + LOD2, 0), MAXLOD);
      const lo = Math.floor(l2), hi = Math.min(lo + 1, MAXLOD), f = l2 - lo;
      let s = 0, n = 0;
      for (let ti = 0; ti < T4.length; ti++) {
        const t = T4[ti];
        for (let gy = 0; gy < 192; gy++) {
          for (let gx = 0; gx < 192; gx++) {
            const u = (((gx + 0.5) / 192) * 28) / TILE;
            const v = (((gy + 0.5) / 192) * 28) / TILE;
            const c1 = tap(chains[ti][L], u + 0.014 * t, v - 0.011 * t);
            const u2 = u * RENDER.CAUSTIC_TAP2_SCALE - 0.019 * t;
            const v2 = v * RENDER.CAUSTIC_TAP2_SCALE + 0.008 * t;
            const c2 = tap(chains[ti][lo], u2, v2) * (1 - f) + tap(chains[ti][hi], u2, v2) * f;
            s += Math.min((c1 / m) * (c2 / m), RENDER.CAUSTICS_INTENSITY_CLAMP);
            n++;
          }
        }
      }
      const v = s / n / cm;
      dc.push(v);
      if (Math.abs(v - 1) > worst) { worst = Math.abs(v - 1); worstAt = `ch${ch} lod${L}`; }
    }
    rows.push(`ch${ch} ` + dc.map((x) => x.toFixed(4)).join(' / '));
  }
  for (const r of rows) console.log(`        ${r}`);
  console.log('');
  check("causticFactor()'s DC stays inside 4% at every level of the chain",
        worst < 0.04, `worst ${(worst * 100).toFixed(2)}% at ${worstAt} (LOD 0 is the baked one)`);
}

console.log(failures === 0 ? '\nAll caustics checks passed.\n'
                           : `\n${failures} caustics check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
