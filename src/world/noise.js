/**
 * SUBWAVE procedural noise.
 *
 * Every function here is a PURE function of (coordinates, seed). No internal
 * state, no permutation tables to initialise, no allocation in the hot path.
 * That gives us the determinism contract the world generator needs: the same
 * seed produces a bit-identical planet on every machine, and a chunk can be
 * regenerated in isolation without touching its neighbours.
 *
 * All 2D/3D functions return values in [-1, 1] unless the name says otherwise
 * (`*01` variants return [0, 1]; worley returns distances in [0, ~1.5]).
 */

import { hash2i, hash3i, TAU, lerp, saturate, smootherstep } from '../core/math.js';

// ---------------------------------------------------------------------------
// Integer hashing
// ---------------------------------------------------------------------------

/** 2D hash with a seed folded in. Returns [0,1). */
export function hash2(x, y, seed) {
  return hash3i(x, y, seed) / 4294967296;
}

/** 3D hash with a seed folded in. Returns [0,1). */
export function hash3(x, y, z, seed) {
  return hash3i(hash2i(x, y) ^ 0x9e3779b9, z, seed) / 4294967296;
}

/** 2D hash to a unit gradient vector, written into `out`. */
function grad2(x, y, seed, out) {
  const a = hash3i(x, y, seed) * 1.4629180792671596e-9; // 2*PI / 2^32
  out[0] = Math.cos(a);
  out[1] = Math.sin(a);
}

/** 3D hash to a unit gradient vector, written into `out`. */
function grad3(x, y, z, seed, out) {
  const h1 = hash3i(x, y, z ^ seed);
  const h2 = hash3i(z, seed, h1 | 0);
  const theta = h1 * 1.4629180792671596e-9;         // [0, 2PI)
  const cosPhi = (h2 / 4294967296) * 2 - 1;         // [-1, 1]
  const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
  out[0] = sinPhi * Math.cos(theta);
  out[1] = sinPhi * Math.sin(theta);
  out[2] = cosPhi;
}

// Scratch vectors. Noise is single-threaded per worker, so module scratch is safe.
const _g0 = new Float64Array(2);
const _g1 = new Float64Array(2);
const _g2 = new Float64Array(2);
const _g3 = new Float64Array(2);
const _h = [new Float64Array(3), new Float64Array(3), new Float64Array(3), new Float64Array(3),
            new Float64Array(3), new Float64Array(3), new Float64Array(3), new Float64Array(3)];

// ---------------------------------------------------------------------------
// Value noise
// ---------------------------------------------------------------------------

/** 2D value noise. Cheap; good for masks and low-frequency variation. */
export function value2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = smootherstep(0, 1, xf);
  const v = smootherstep(0, 1, yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (lerp(lerp(a, b, u), lerp(c, d, u), v) * 2 - 1);
}

/** 3D value noise. */
export function value3(x, y, z, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = smootherstep(0, 1, xf);
  const v = smootherstep(0, 1, yf);
  const w = smootherstep(0, 1, zf);
  const c000 = hash3(xi, yi, zi, seed);
  const c100 = hash3(xi + 1, yi, zi, seed);
  const c010 = hash3(xi, yi + 1, zi, seed);
  const c110 = hash3(xi + 1, yi + 1, zi, seed);
  const c001 = hash3(xi, yi, zi + 1, seed);
  const c101 = hash3(xi + 1, yi, zi + 1, seed);
  const c011 = hash3(xi, yi + 1, zi + 1, seed);
  const c111 = hash3(xi + 1, yi + 1, zi + 1, seed);
  const x00 = lerp(c000, c100, u), x10 = lerp(c010, c110, u);
  const x01 = lerp(c001, c101, u), x11 = lerp(c011, c111, u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 2 - 1;
}

// ---------------------------------------------------------------------------
// Gradient (Perlin) noise
// ---------------------------------------------------------------------------

/** 2D gradient noise, roughly [-1,1]. Smoother and more natural than value noise. */
export function perlin2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = smootherstep(0, 1, xf);
  const v = smootherstep(0, 1, yf);

  grad2(xi, yi, seed, _g0);
  grad2(xi + 1, yi, seed, _g1);
  grad2(xi, yi + 1, seed, _g2);
  grad2(xi + 1, yi + 1, seed, _g3);

  const n00 = _g0[0] * xf + _g0[1] * yf;
  const n10 = _g1[0] * (xf - 1) + _g1[1] * yf;
  const n01 = _g2[0] * xf + _g2[1] * (yf - 1);
  const n11 = _g3[0] * (xf - 1) + _g3[1] * (yf - 1);

  // 1.4142 normalises the theoretical max of sqrt(2)/2 back toward 1.
  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v) * 1.4142135623730951;
}

/** 3D gradient noise, roughly [-1,1]. */
export function perlin3(x, y, z, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = smootherstep(0, 1, xf);
  const v = smootherstep(0, 1, yf);
  const w = smootherstep(0, 1, zf);

  let k = 0;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        grad3(xi + dx, yi + dy, zi + dz, seed, _h[k++]);
      }
    }
  }
  const d = (i, dx, dy, dz) => _h[i][0] * (xf - dx) + _h[i][1] * (yf - dy) + _h[i][2] * (zf - dz);

  const n000 = d(0, 0, 0, 0), n100 = d(1, 1, 0, 0);
  const n010 = d(2, 0, 1, 0), n110 = d(3, 1, 1, 0);
  const n001 = d(4, 0, 0, 1), n101 = d(5, 1, 0, 1);
  const n011 = d(6, 0, 1, 1), n111 = d(7, 1, 1, 1);

  const x00 = lerp(n000, n100, u), x10 = lerp(n010, n110, u);
  const x01 = lerp(n001, n101, u), x11 = lerp(n011, n111, u);
  // Measured normalisation for continuous random unit gradients (see simplex2).
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 1.547;
}

// ---------------------------------------------------------------------------
// Simplex noise
// ---------------------------------------------------------------------------

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

/**
 * 2D simplex noise in roughly [-1,1].
 * Cheaper and less directionally biased than Perlin - the workhorse for terrain.
 */
export function simplex2(x, y, seed = 0) {
  const s = (x + y) * F2;
  const i = Math.floor(x + s), j = Math.floor(y + s);
  const t = (i + j) * G2;
  const X0 = i - t, Y0 = j - t;
  const x0 = x - X0, y0 = y - Y0;

  const i1 = x0 > y0 ? 1 : 0;
  const j1 = x0 > y0 ? 0 : 1;

  const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;

  let n = 0;

  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 > 0) {
    grad2(i, j, seed, _g0);
    t0 *= t0;
    n += t0 * t0 * (_g0[0] * x0 + _g0[1] * y0);
  }
  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 > 0) {
    grad2(i + i1, j + j1, seed, _g1);
    t1 *= t1;
    n += t1 * t1 * (_g1[0] * x1 + _g1[1] * y1);
  }
  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 > 0) {
    grad2(i + 1, j + 1, seed, _g2);
    t2 *= t2;
    n += t2 * t2 * (_g2[0] * x2 + _g2[1] * y2);
  }
  // The textbook constant (70) assumes the classic 8-gradient set. We use
  // continuous random unit gradients, whose observed peak is ~0.7071 of that,
  // so this factor is measured rather than quoted. See tools/test-noise.mjs.
  return 99.2 * n;
}

const F3 = 1 / 3;
const G3 = 1 / 6;

/** 3D simplex noise in roughly [-1,1]. Used for caves and volumetric detail. */
export function simplex3(x, y, z, seed = 0) {
  const s = (x + y + z) * F3;
  const i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s);
  const t = (i + j + k) * G3;
  const x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t);

  let i1, j1, k1, i2, j2, k2;
  if (x0 >= y0) {
    if (y0 >= z0)      { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
    else               { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
  } else {
    if (y0 < z0)       { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0)  { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else               { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
  }

  const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
  const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
  const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;

  let n = 0;
  const corner = (gi, gx, gy, gz, px, py, pz) => {
    let tt = 0.6 - px * px - py * py - pz * pz;
    if (tt <= 0) return 0;
    grad3(gx, gy, gz, seed, _h[gi]);
    tt *= tt;
    return tt * tt * (_h[gi][0] * px + _h[gi][1] * py + _h[gi][2] * pz);
  };
  n += corner(0, i, j, k, x0, y0, z0);
  n += corner(1, i + i1, j + j1, k + k1, x1, y1, z1);
  n += corner(2, i + i2, j + j2, k + k2, x2, y2, z2);
  n += corner(3, i + 1, j + 1, k + 1, x3, y3, z3);
  // Measured normalisation for continuous random unit gradients (see simplex2).
  return 41.6 * n;
}

// ---------------------------------------------------------------------------
// Worley / cellular noise
// ---------------------------------------------------------------------------

/**
 * 2D Worley noise.
 * @returns {{f1: number, f2: number, cellX: number, cellY: number, id: number}}
 *   f1/f2 are the distances to the nearest and second-nearest feature points,
 *   normalised so f1 is usually in [0,1]. `id` identifies the owning cell,
 *   which is what scatter placement and biome shattering use.
 */
const _worleyResult = { f1: 0, f2: 0, cellX: 0, cellY: 0, id: 0 };
export function worley2(x, y, seed = 0, jitter = 1) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = Infinity, f2 = Infinity;
  let bestX = 0, bestY = 0;

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const h = hash3i(cx, cy, seed);
      const px = cx + 0.5 + (((h & 0xffff) / 65535) - 0.5) * jitter;
      const py = cy + 0.5 + ((((h >>> 16) & 0xffff) / 65535) - 0.5) * jitter;
      const ddx = px - x, ddy = py - y;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d < f1) { f2 = f1; f1 = d; bestX = cx; bestY = cy; }
      else if (d < f2) { f2 = d; }
    }
  }
  _worleyResult.f1 = f1;
  _worleyResult.f2 = f2;
  _worleyResult.cellX = bestX;
  _worleyResult.cellY = bestY;
  _worleyResult.id = hash2i(bestX, bestY);
  return _worleyResult;
}

/** Scalar shorthand: distance to the nearest feature point, in [0,1]. */
export const worley2F1 = (x, y, seed = 0, jitter = 1) => saturate(worley2(x, y, seed, jitter).f1);

/** F2-F1: bright cell borders. Great for cracked mud, coral plates, crystal facets. */
export function worley2Edge(x, y, seed = 0, jitter = 1) {
  const w = worley2(x, y, seed, jitter);
  return saturate(w.f2 - w.f1);
}

/** 3D Worley F1. Used for cave chambers and cloud erosion. */
export function worley3F1(x, y, z, seed = 0, jitter = 1) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let f1 = Infinity;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx, cy = yi + dy, cz = zi + dz;
        const h = hash3i(cx, cy, cz ^ seed);
        const h2 = hash3i(cz, cx, seed);
        const px = cx + 0.5 + (((h & 0x3ff) / 1023) - 0.5) * jitter;
        const py = cy + 0.5 + ((((h >>> 10) & 0x3ff) / 1023) - 0.5) * jitter;
        const pz = cz + 0.5 + (((h2 & 0x3ff) / 1023) - 0.5) * jitter;
        const ddx = px - x, ddy = py - y, ddz = pz - z;
        const d = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d < f1) f1 = d;
      }
    }
  }
  return saturate(Math.sqrt(f1));
}

/**
 * Full 3D Worley: f1 and f2 in RAW cell units, plus the owning cell's id.
 *
 * worley3F1 above saturates its result, which is right for a [0,1] mask and
 * wrong for anything that needs a distance: the volumetric layer converts these
 * back to metres and clamping at 1 cell would flatten every chamber wall further
 * out than one cell. Nothing here is clamped.
 *
 * f2 - f1 is zero exactly on a cell boundary, so it selects the Voronoi FACES -
 * which in 3D are two-dimensional sheets, not tubes. That distinction matters
 * and is used deliberately (see the fissure network in world/caves.js).
 *
 * @returns {{f1:number, f2:number, cellX:number, cellY:number, cellZ:number, id:number}}
 */
const _worley3Result = { f1: 0, f2: 0, cellX: 0, cellY: 0, cellZ: 0, id: 0 };
export function worley3(x, y, z, seed = 0, jitter = 1) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let f1 = Infinity, f2 = Infinity;
  let bx = 0, by = 0, bz = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx, cy = yi + dy, cz = zi + dz;
        // Same 10-bit jitter packing as worley3F1, so the two agree cell for cell.
        const h = hash3i(cx, cy, cz ^ seed);
        const h2 = hash3i(cz, cx, seed);
        const px = cx + 0.5 + (((h & 0x3ff) / 1023) - 0.5) * jitter;
        const py = cy + 0.5 + ((((h >>> 10) & 0x3ff) / 1023) - 0.5) * jitter;
        const pz = cz + 0.5 + (((h2 & 0x3ff) / 1023) - 0.5) * jitter;
        const ddx = px - x, ddy = py - y, ddz = pz - z;
        const d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
        if (d < f1) { f2 = f1; f1 = d; bx = cx; by = cy; bz = cz; }
        else if (d < f2) { f2 = d; }
      }
    }
  }
  _worley3Result.f1 = f1;
  _worley3Result.f2 = f2;
  _worley3Result.cellX = bx;
  _worley3Result.cellY = by;
  _worley3Result.cellZ = bz;
  _worley3Result.id = hash3i(bx, by, bz);
  return _worley3Result;
}

/** F2-F1 in RAW cell units: zero on a Voronoi face, growing into the cells. */
export function worley3Edge(x, y, z, seed = 0, jitter = 1) {
  const w = worley3(x, y, z, seed, jitter);
  return w.f2 - w.f1;
}

// ---------------------------------------------------------------------------
// Fractal combinations
// ---------------------------------------------------------------------------

/**
 * Fractal Brownian motion. The default terrain building block.
 * @param {(x:number,y:number,seed:number)=>number} basis
 */
export function fbm2(basis, x, y, seed, octaves = 5, lacunarity = 2.0, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += basis(x * freq, y * freq, seed + i * 1013) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / (norm || 1);
}

export function fbm3(basis, x, y, z, seed, octaves = 5, lacunarity = 2.0, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += basis(x * freq, y * freq, z * freq, seed + i * 1013) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / (norm || 1);
}

/**
 * Ridged multifractal in [0,1]. Produces sharp crests - the right basis for
 * mountain ridges, canyon walls and the trench shoulders.
 */
export function ridged2(x, y, seed, octaves = 5, lacunarity = 2.0, gain = 0.5, sharpness = 1.0) {
  let sum = 0, amp = 1, freq = 1, norm = 0, weight = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(simplex2(x * freq, y * freq, seed + i * 1013));
    n *= n;
    n *= weight;
    weight = saturate(n * sharpness * 2);
    sum += n * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return saturate(sum / (norm || 1));
}

export function ridged3(x, y, z, seed, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0, weight = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(simplex3(x * freq, y * freq, z * freq, seed + i * 1013));
    n *= n;
    n *= weight;
    weight = saturate(n * 2);
    sum += n * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return saturate(sum / (norm || 1));
}

/** Billow: |noise|, giving rounded, cloud-like or dune-like lumps. In [0,1]. */
export function billow2(x, y, seed, octaves = 5, lacunarity = 2.0, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += Math.abs(simplex2(x * freq, y * freq, seed + i * 1013)) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return saturate(sum / (norm || 1));
}

/** Turbulence: fbm of |noise|, offset to [0,1]. */
export function turbulence3(x, y, z, seed, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += Math.abs(simplex3(x * freq, y * freq, z * freq, seed + i * 1013)) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return saturate(sum / (norm || 1));
}

/**
 * Domain warp: displace the sample point by another noise field before
 * evaluating. This is what turns "obviously procedural" into "geological".
 * Writes the warped coordinates into `out` (length 2).
 */
export function domainWarp2(out, x, y, seed, strength = 1, frequency = 1, octaves = 3) {
  const wx = fbm2(simplex2, x * frequency + 5.2, y * frequency + 1.3, seed + 7717, octaves);
  const wy = fbm2(simplex2, x * frequency + 9.1, y * frequency + 4.7, seed + 3313, octaves);
  out[0] = x + wx * strength;
  out[1] = y + wy * strength;
  return out;
}

/** Two-level domain warp (Inigo Quilez style). Slower, dramatically better. */
export function domainWarp2x(out, x, y, seed, strength = 1, frequency = 1) {
  const q0 = fbm2(simplex2, x * frequency, y * frequency, seed + 101, 4);
  const q1 = fbm2(simplex2, x * frequency + 5.2, y * frequency + 1.3, seed + 202, 4);
  const r0 = fbm2(simplex2, x * frequency + 4 * q0 + 1.7, y * frequency + 4 * q1 + 9.2, seed + 303, 4);
  const r1 = fbm2(simplex2, x * frequency + 4 * q0 + 8.3, y * frequency + 4 * q1 + 2.8, seed + 404, 4);
  out[0] = x + r0 * strength;
  out[1] = y + r1 * strength;
  return out;
}

const _warp = new Float64Array(2);

/** Warped fbm - the standard "interesting terrain" call. */
export function warpedFbm2(x, y, seed, { octaves = 5, warpStrength = 0.6, warpFrequency = 0.5, lacunarity = 2, gain = 0.5 } = {}) {
  domainWarp2(_warp, x, y, seed, warpStrength, warpFrequency, 3);
  return fbm2(simplex2, _warp[0], _warp[1], seed, octaves, lacunarity, gain);
}

// ---------------------------------------------------------------------------
// Derivatives and flow
// ---------------------------------------------------------------------------

/**
 * Analytic-ish gradient of a 2D scalar field via central differences.
 * `out` receives [d/dx, d/dy]. `eps` should match the sampling scale.
 */
export function gradient2(out, fn, x, y, eps = 0.01) {
  const dx = (fn(x + eps, y) - fn(x - eps, y)) / (2 * eps);
  const dy = (fn(x, y + eps) - fn(x, y - eps)) / (2 * eps);
  out[0] = dx;
  out[1] = dy;
  return out;
}

/**
 * Divergence-free 2D curl noise. Perfect for water currents and for pushing
 * marine snow around without it clumping.  `out` receives [vx, vy].
 */
export function curl2(out, x, y, seed, eps = 0.05) {
  const n1 = fbm2(simplex2, x, y + eps, seed, 3);
  const n2 = fbm2(simplex2, x, y - eps, seed, 3);
  const n3 = fbm2(simplex2, x + eps, y, seed, 3);
  const n4 = fbm2(simplex2, x - eps, y, seed, 3);
  out[0] = (n1 - n2) / (2 * eps);
  out[1] = -(n3 - n4) / (2 * eps);
  return out;
}

/**
 * 3D curl noise for volumetric currents. `out` receives [vx, vy, vz].
 *
 * v = curl(P) where P = (Px, Py, Pz) are three independent scalar potentials.
 * Because v is a curl, div(v) is analytically zero; the residual you can
 * measure numerically is pure finite-difference truncation error, which scales
 * as O(eps^2) of the potential's curvature.
 *
 * `eps` must therefore be small RELATIVE TO THE FEATURE SIZE of the potential.
 * The potential here is a 3-octave fbm whose finest octave has features of
 * order 0.25 units, so the default eps of 0.01 keeps the residual negligible.
 * Passing a large eps does not make the field non-solenoidal - it just makes
 * this approximation of the derivative coarse.
 */
export function curl3(out, x, y, z, seed, eps = 0.01) {
  const s1 = seed, s2 = seed + 8191, s3 = seed + 16381;
  const P = (s, ox, oy, oz) => fbm3(simplex3, x + ox, y + oy, z + oz, s, 3);
  const inv = 1 / (2 * eps);

  // curl(P) = (dPz/dy - dPy/dz,  dPx/dz - dPz/dx,  dPy/dx - dPx/dy)
  const dPz_dy = (P(s3, 0, eps, 0) - P(s3, 0, -eps, 0)) * inv;
  const dPy_dz = (P(s2, 0, 0, eps) - P(s2, 0, 0, -eps)) * inv;
  const dPx_dz = (P(s1, 0, 0, eps) - P(s1, 0, 0, -eps)) * inv;
  const dPz_dx = (P(s3, eps, 0, 0) - P(s3, -eps, 0, 0)) * inv;
  const dPy_dx = (P(s2, eps, 0, 0) - P(s2, -eps, 0, 0)) * inv;
  const dPx_dy = (P(s1, 0, eps, 0) - P(s1, 0, -eps, 0)) * inv;

  out[0] = dPz_dy - dPy_dz;
  out[1] = dPx_dz - dPz_dx;
  out[2] = dPy_dx - dPx_dy;
  return out;
}

// ---------------------------------------------------------------------------
// Shaping helpers
// ---------------------------------------------------------------------------

/** Map [-1,1] to [0,1]. */
export const to01 = (n) => n * 0.5 + 0.5;

/**
 * Terracing / stratification. Quantises `v` into `steps` bands with `softness`
 * blending. Gives sedimentary rock layers and salt-flat plateaus.
 */
export function terrace(v, steps, softness = 0.25) {
  const s = v * steps;
  const f = Math.floor(s);
  const frac = s - f;
  const eased = softness <= 0 ? 0 : smootherstep(0.5 - softness * 0.5, 0.5 + softness * 0.5, frac);
  return (f + eased) / steps;
}

/**
 * Erosion-flavoured shaping: pulls values toward their local slope, flattening
 * valleys and sharpening ridges without a full hydraulic simulation.
 * `slope` is the gradient magnitude at the sample.
 */
export function erodeShape(height, slope, strength = 0.5) {
  const flatten = 1 / (1 + slope * slope * 8);
  return lerp(height, height * (0.65 + 0.35 * flatten), strength);
}

/**
 * Smooth minimum (polynomial). Blends two SDFs/heights without a crease -
 * essential for stitching caves into the heightfield and merging rock blobs.
 */
export function smin(a, b, k = 1) {
  const h = saturate(0.5 + (0.5 * (b - a)) / k);
  return lerp(b, a, h) - k * h * (1 - h);
}

export function smax(a, b, k = 1) {
  return -smin(-a, -b, k);
}

/** Radial falloff in [0,1]: 1 at the centre, 0 beyond `radius`. */
export function radialFalloff(x, y, cx, cy, radius, softness = 0.35) {
  const d = Math.hypot(x - cx, y - cy) / radius;
  return 1 - smootherstep(1 - softness, 1, d);
}

/**
 * Terrain-scale gradient of an arbitrary height function, returning a unit
 * surface normal in `out` (length 3, world axes with +Y up).
 */
export function normalFromHeight(out, heightFn, x, z, eps = 0.5) {
  const hL = heightFn(x - eps, z);
  const hR = heightFn(x + eps, z);
  const hD = heightFn(x, z - eps);
  const hU = heightFn(x, z + eps);
  const nx = hL - hR;
  const nz = hD - hU;
  const ny = 2 * eps;
  const len = Math.hypot(nx, ny, nz) || 1;
  out[0] = nx / len;
  out[1] = ny / len;
  out[2] = nz / len;
  return out;
}

// ---------------------------------------------------------------------------
// Blue-noise / scatter point sets
// ---------------------------------------------------------------------------

/**
 * Deterministic jittered-grid point in cell (cx, cz). This is how every piece
 * of scatter (kelp, rocks, ore nodes, creatures) is placed: no global list, no
 * streaming state - a chunk just enumerates the cells it covers.
 *
 * `out` receives [x, z, rand0, rand1] where the randoms are stable per point.
 */
export function scatterPoint(out, cx, cz, cellSize, seed, jitter = 0.85) {
  const h1 = hash3i(cx, cz, seed);
  const h2 = hash3i(cz, cx, seed ^ 0x5bf03635);
  const jx = ((h1 & 0xffff) / 65535 - 0.5) * jitter;
  const jz = (((h1 >>> 16) & 0xffff) / 65535 - 0.5) * jitter;
  out[0] = (cx + 0.5 + jx) * cellSize;
  out[1] = (cz + 0.5 + jz) * cellSize;
  out[2] = (h2 & 0xffff) / 65535;
  out[3] = ((h2 >>> 16) & 0xffff) / 65535;
  return out;
}

/**
 * Poisson-ish disk sampling over a rectangle, seeded and deterministic.
 * Used at bake time for landmark and cluster placement where jittered grids
 * look too regular. Returns an array of [x, y] pairs.
 */
export function poissonDisk(width, height, minDistance, seed, maxAttempts = 24) {
  const cellSize = minDistance / Math.SQRT2;
  const gw = Math.ceil(width / cellSize);
  const gh = Math.ceil(height / cellSize);
  const grid = new Int32Array(gw * gh).fill(-1);
  const points = [];
  const active = [];
  let rngState = (seed | 0) >>> 0;
  const rand = () => {
    rngState = (rngState + 0x6d2b79f5) >>> 0;
    let t = rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const addPoint = (x, y) => {
    const idx = points.length;
    points.push([x, y]);
    active.push(idx);
    const gx = Math.floor(x / cellSize), gy = Math.floor(y / cellSize);
    if (gx >= 0 && gx < gw && gy >= 0 && gy < gh) grid[gy * gw + gx] = idx;
  };

  const fits = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const gx = Math.floor(x / cellSize), gy = Math.floor(y / cellSize);
    const x0 = Math.max(0, gx - 2), x1 = Math.min(gw - 1, gx + 2);
    const y0 = Math.max(0, gy - 2), y1 = Math.min(gh - 1, gy + 2);
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const pi = grid[yy * gw + xx];
        if (pi < 0) continue;
        const p = points[pi];
        if (Math.hypot(p[0] - x, p[1] - y) < minDistance) return false;
      }
    }
    return true;
  };

  addPoint(rand() * width, rand() * height);

  while (active.length) {
    const ai = Math.floor(rand() * active.length);
    const pi = active[ai];
    const [px, py] = points[pi];
    let placed = false;
    for (let a = 0; a < maxAttempts; a++) {
      const angle = rand() * TAU;
      const r = minDistance * (1 + rand());
      const nx = px + Math.cos(angle) * r;
      const ny = py + Math.sin(angle) * r;
      if (fits(nx, ny)) { addPoint(nx, ny); placed = true; break; }
    }
    if (!placed) active.splice(ai, 1);
  }
  return points;
}

// ---------------------------------------------------------------------------
// Sampling utilities
// ---------------------------------------------------------------------------

/**
 * Bake a 2D noise field into a Float32Array. Used for wave spectra, cloud
 * shape textures and the biome mask atlas.
 */
export function bakeField2(width, height, fn) {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[y * width + x] = fn(x, y);
    }
  }
  return out;
}

/**
 * Periodic gradient noise: the integer LATTICE is wrapped modulo `period`, so
 * the field repeats bit-exactly every `period` units with no seam and no
 * mirroring.
 *
 * Wrapping the lattice (rather than sampling a torus embedded in a higher
 * dimension) is both exact and cheaper. A torus projection has to round-trip
 * through cos/sin, and the last-bit differences that introduces are enough to
 * land two "identical" samples in different simplex cells.
 *
 * `period` must be a positive integer, and x/y are in lattice units.
 */
export function periodicPerlin2(x, y, period, seed = 0) {
  const p = period | 0;
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = smootherstep(0, 1, xf);
  const v = smootherstep(0, 1, yf);

  const w = (n) => ((n % p) + p) % p;
  const x0 = w(xi), x1 = w(xi + 1);
  const y0 = w(yi), y1 = w(yi + 1);

  grad2(x0, y0, seed, _g0);
  grad2(x1, y0, seed, _g1);
  grad2(x0, y1, seed, _g2);
  grad2(x1, y1, seed, _g3);

  const n00 = _g0[0] * xf + _g0[1] * yf;
  const n10 = _g1[0] * (xf - 1) + _g1[1] * yf;
  const n01 = _g2[0] * xf + _g2[1] * (yf - 1);
  const n11 = _g3[0] * (xf - 1) + _g3[1] * (yf - 1);

  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v) * 1.4142135623730951;
}

/** Periodic 3D gradient noise. Used for tiling cloud shape and detail volumes. */
export function periodicPerlin3(x, y, z, period, seed = 0) {
  const p = period | 0;
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = smootherstep(0, 1, xf);
  const v = smootherstep(0, 1, yf);
  const w = smootherstep(0, 1, zf);

  const wrap = (n) => ((n % p) + p) % p;
  const gx = [wrap(xi), wrap(xi + 1)];
  const gy = [wrap(yi), wrap(yi + 1)];
  const gz = [wrap(zi), wrap(zi + 1)];

  let k = 0;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        grad3(gx[dx], gy[dy], gz[dz], seed, _h[k++]);
      }
    }
  }
  const d = (i, dx, dy, dz) => _h[i][0] * (xf - dx) + _h[i][1] * (yf - dy) + _h[i][2] * (zf - dz);

  const n000 = d(0, 0, 0, 0), n100 = d(1, 1, 0, 0);
  const n010 = d(2, 0, 1, 0), n110 = d(3, 1, 1, 0);
  const n001 = d(4, 0, 0, 1), n101 = d(5, 1, 0, 1);
  const n011 = d(6, 0, 1, 1), n111 = d(7, 1, 1, 1);

  const x00 = lerp(n000, n100, u), x10 = lerp(n010, n110, u);
  const x01 = lerp(n001, n101, u), x11 = lerp(n011, n111, u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 1.547;
}

/**
 * Seeded, exactly-tileable fbm for repeating textures.
 * Octave i samples at 2^i times the frequency with 2^i times the lattice
 * period, so every octave wraps at the same world interval.
 * `period` must be an integer.
 */
export function tileableFbm2(x, y, period, seed, octaves = 4, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += periodicPerlin2(x * freq, y * freq, period * freq, seed + i * 1013) * amp;
    norm += amp;
    amp *= gain;
    freq *= 2;
  }
  return sum / (norm || 1);
}

/** Exactly-tileable 3D fbm, for cloud and detail volume textures. */
export function tileableFbm3(x, y, z, period, seed, octaves = 4, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += periodicPerlin3(x * freq, y * freq, z * freq, period * freq, seed + i * 1013) * amp;
    norm += amp;
    amp *= gain;
    freq *= 2;
  }
  return sum / (norm || 1);
}

/**
 * Tileable Worley, wrapped on the cell lattice. Returns 1 - F1 so that cell
 * centres are bright: this is the standard "billow" input for cloud erosion.
 */
export function tileableWorley3(x, y, z, period, seed = 0, jitter = 1) {
  const p = period | 0;
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const wrap = (n) => ((n % p) + p) % p;
  let f1 = Infinity;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx, cy = yi + dy, cz = zi + dz;
        const h = hash3i(wrap(cx), wrap(cy), wrap(cz) ^ seed);
        const h2 = hash3i(wrap(cz), wrap(cx), seed);
        const px = cx + 0.5 + (((h & 0x3ff) / 1023) - 0.5) * jitter;
        const py = cy + 0.5 + ((((h >>> 10) & 0x3ff) / 1023) - 0.5) * jitter;
        const pz = cz + 0.5 + (((h2 & 0x3ff) / 1023) - 0.5) * jitter;
        const ddx = px - x, ddy = py - y, ddz = pz - z;
        const d = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d < f1) f1 = d;
      }
    }
  }
  return saturate(1 - Math.sqrt(f1));
}
