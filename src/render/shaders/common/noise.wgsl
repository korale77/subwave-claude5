// SUBWAVE - GPU procedural noise.
//
// The shader-side twin of src/world/noise.js. The two are NOT required to agree
// bit for bit, and the split of responsibility is what makes that safe:
//
//   CPU noise is TRUTH.      Heightfield, collision, caves, spawn placement -
//                            anything the simulation and the renderer could
//                            disagree about. Deterministic across machines.
//   GPU noise is APPEARANCE. Material break-up, kelp sway, cloud shape, flow
//                            fields, dither. Nothing can be collided with.
//
// They still have to LOOK like the same world, so the lattice hash, the
// gradient distribution and the fractal weighting below are exact ports of the
// JS. Three divergences are deliberate:
//
//   1. f32 instead of f64 coordinates. A lattice fraction is computed as
//      p - floor(p); at 3 km from the origin an f32 has an ulp of 2.4e-4, so
//      the fraction is quantised to ~1/4000 of a cell (invisible), but by 1e6
//      metres it collapses entirely. Feed these functions coordinates already
//      scaled toward the lattice (worldPos * frequency), never a huge number
//      that you scale down inside the call.
//   2. cos/sin/sqrt round differently on every GPU. Gradient directions land
//      within ~4e-7 rad of the CPU's, which moves a lattice value by orders of
//      magnitude less than a texel of anything that samples it.
//   3. The *Cheap* family swaps the CPU's continuous random gradient angle for
//      a discrete 8- (2D) or 12-direction (3D) set. That is a visible
//      statistical difference at one octave and invisible at three, and it
//      removes two transcendentals per lattice corner - the entire point.
//
// Ranges match the JS: signed basis functions are roughly [-1,1], ridged /
// billow / turbulence / worley are [0,1].

#pragma once

#include "math.wgsl"

// 1/2^32 and 2*PI/2^32. The JS divides a u32 by 4294967296 in double precision;
// f32(u32) rounds to 24 bits first, so the two differ by at most 2^-25 relative.
const NOISE_INV_U32   : f32 = 2.3283064365386963e-10;
const NOISE_ANGLE_U32 : f32 = 1.4629180792671596e-9;
const NOISE_OCTAVE_SEED : u32 = 1013u;

// ---------------------------------------------------------------------------
// Integer lattice hashing - bit-exact port of core/math.js hash2i / hash3i.
// ---------------------------------------------------------------------------
//
// Math.imul is a 32-bit wrapping multiply and `>>>` is a logical shift, so the
// u32 arithmetic here reproduces the JS bit pattern exactly. Everything that
// wants a CPU-consistent field must route through these rather than through the
// float hashes in math.wgsl, which have no CPU counterpart.

fn hash2i(x: i32, y: i32) -> u32 {
  var h = (bitcast<u32>(x) * 0x8da6b343u) ^ (bitcast<u32>(y) * 0xd8163841u);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h ^= h >> 12u;
  h = h * 0x297a2d39u;
  return h ^ (h >> 15u);
}

fn hash3i(x: i32, y: i32, z: i32) -> u32 {
  var h = (bitcast<u32>(x) * 0x8da6b343u) ^ (bitcast<u32>(y) * 0xd8163841u) ^ (bitcast<u32>(z) * 0xcb1ab31fu);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h ^= h >> 12u;
  h = h * 0x297a2d39u;
  return h ^ (h >> 15u);
}

/// Seeded lattice hash to [0,1). Matches noise.js hash2.
fn latticeHash2(c: vec2i, seed: u32) -> f32 {
  return f32(hash3i(c.x, c.y, bitcast<i32>(seed))) * NOISE_INV_U32;
}

/// Seeded 3D lattice hash to [0,1). Matches noise.js hash3, including the
/// golden-ratio fold that decorrelates the xy pair from z.
fn latticeHash3(c: vec3i, seed: u32) -> f32 {
  let xy = bitcast<i32>(hash2i(c.x, c.y) ^ 0x9e3779b9u);
  return f32(hash3i(xy, c.z, bitcast<i32>(seed))) * NOISE_INV_U32;
}

/// Unit gradient at a 2D lattice point, angle uniform on [0, 2PI).
fn latticeGrad2(c: vec2i, seed: u32) -> vec2f {
  let a = f32(hash3i(c.x, c.y, bitcast<i32>(seed))) * NOISE_ANGLE_U32;
  return vec2f(cos(a), sin(a));
}

/// Unit gradient at a 3D lattice point, uniform on the sphere. Uniformity comes
/// from sampling cos(phi) rather than phi: sampling the angle directly would
/// cluster gradients at the poles and give the noise a vertical grain.
fn latticeGrad3(c: vec3i, seed: u32) -> vec3f {
  let s = bitcast<i32>(seed);
  let h1 = hash3i(c.x, c.y, c.z ^ s);
  let h2 = hash3i(c.z, s, bitcast<i32>(h1));
  let theta = f32(h1) * NOISE_ANGLE_U32;
  let cosPhi = f32(h2) * NOISE_INV_U32 * 2.0 - 1.0;
  let sinPhi = sqrt(max(0.0, 1.0 - cosPhi * cosPhi));
  return vec3f(sinPhi * cos(theta), sinPhi * sin(theta), cosPhi);
}

/// Quick 2D gradient: the 4 axes and 4 diagonals, chosen by three hash bits.
/// Bit 2 picks axis vs diagonal; bits 0 and 1 then mean different things in the
/// two cases so that all 8 directions come out equally likely - reusing one bit
/// for both the axis choice and its sign silently drops a direction and leaves
/// a faint diagonal bias in the field.
fn quickGrad2(c: vec2i, seed: u32) -> vec2f {
  let h = hash3i(c.x, c.y, bitcast<i32>(seed)) >> 29u;
  let sa = select(-1.0, 1.0, (h & 1u) == 0u);
  let sb = select(-1.0, 1.0, (h & 2u) == 0u);
  let axis = select(vec2f(sb, 0.0), vec2f(0.0, sb), (h & 1u) != 0u);
  return select(axis, vec2f(sa, sb) * 0.70710678, (h & 4u) == 0u);
}

/// Quick 3D gradient: the 12 cube-edge directions (Perlin's improved set).
fn quickGrad3(c: vec3i, seed: u32) -> vec3f {
  let h = hash3i(c.x, c.y, c.z ^ bitcast<i32>(seed));
  let sa = select(-1.0, 1.0, (h & 4u) == 0u);
  let sb = select(-1.0, 1.0, (h & 8u) == 0u);
  let axis = (h >> 4u) % 3u;
  let g = select(select(vec3f(sa, sb, 0.0), vec3f(sa, 0.0, sb), axis == 1u), vec3f(0.0, sa, sb), axis == 0u);
  return g * 0.70710678;
}

// ---------------------------------------------------------------------------
// Value noise
// ---------------------------------------------------------------------------

fn value2(p: vec2f, seed: u32) -> f32 {
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let u = vec2f(smootherstep(0.0, 1.0, f.x), smootherstep(0.0, 1.0, f.y));
  let a = latticeHash2(i, seed);
  let b = latticeHash2(i + vec2i(1, 0), seed);
  let c = latticeHash2(i + vec2i(0, 1), seed);
  let d = latticeHash2(i + vec2i(1, 1), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}

fn value3(p: vec3f, seed: u32) -> f32 {
  let i = vec3i(floor(p));
  let f = p - floor(p);
  let u = vec3f(smootherstep(0.0, 1.0, f.x), smootherstep(0.0, 1.0, f.y), smootherstep(0.0, 1.0, f.z));
  let c000 = latticeHash3(i + vec3i(0, 0, 0), seed);
  let c100 = latticeHash3(i + vec3i(1, 0, 0), seed);
  let c010 = latticeHash3(i + vec3i(0, 1, 0), seed);
  let c110 = latticeHash3(i + vec3i(1, 1, 0), seed);
  let c001 = latticeHash3(i + vec3i(0, 0, 1), seed);
  let c101 = latticeHash3(i + vec3i(1, 0, 1), seed);
  let c011 = latticeHash3(i + vec3i(0, 1, 1), seed);
  let c111 = latticeHash3(i + vec3i(1, 1, 1), seed);
  let x00 = mix(c000, c100, u.x);
  let x10 = mix(c010, c110, u.x);
  let x01 = mix(c001, c101, u.x);
  let x11 = mix(c011, c111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z) * 2.0 - 1.0;
}

// ---------------------------------------------------------------------------
// Gradient (Perlin) noise
// ---------------------------------------------------------------------------

/// 2D gradient noise, roughly [-1,1]. The 1.4142 factor pulls the theoretical
/// peak of sqrt(2)/2 back toward unity.
fn gradient2(p: vec2f, seed: u32) -> f32 {
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let u = vec2f(smootherstep(0.0, 1.0, f.x), smootherstep(0.0, 1.0, f.y));

  let n00 = dot(latticeGrad2(i, seed), f);
  let n10 = dot(latticeGrad2(i + vec2i(1, 0), seed), f - vec2f(1.0, 0.0));
  let n01 = dot(latticeGrad2(i + vec2i(0, 1), seed), f - vec2f(0.0, 1.0));
  let n11 = dot(latticeGrad2(i + vec2i(1, 1), seed), f - vec2f(1.0, 1.0));

  return mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y) * 1.41421356;
}

/// 3D gradient noise, roughly [-1,1]. 1.547 is the measured normalisation for
/// continuous random unit gradients, not the textbook value for the 12-vector
/// set (see tools/test-noise.mjs).
fn gradient3(p: vec3f, seed: u32) -> f32 {
  let i = vec3i(floor(p));
  let f = p - floor(p);
  let u = vec3f(smootherstep(0.0, 1.0, f.x), smootherstep(0.0, 1.0, f.y), smootherstep(0.0, 1.0, f.z));

  let n000 = dot(latticeGrad3(i + vec3i(0, 0, 0), seed), f - vec3f(0.0, 0.0, 0.0));
  let n100 = dot(latticeGrad3(i + vec3i(1, 0, 0), seed), f - vec3f(1.0, 0.0, 0.0));
  let n010 = dot(latticeGrad3(i + vec3i(0, 1, 0), seed), f - vec3f(0.0, 1.0, 0.0));
  let n110 = dot(latticeGrad3(i + vec3i(1, 1, 0), seed), f - vec3f(1.0, 1.0, 0.0));
  let n001 = dot(latticeGrad3(i + vec3i(0, 0, 1), seed), f - vec3f(0.0, 0.0, 1.0));
  let n101 = dot(latticeGrad3(i + vec3i(1, 0, 1), seed), f - vec3f(1.0, 0.0, 1.0));
  let n011 = dot(latticeGrad3(i + vec3i(0, 1, 1), seed), f - vec3f(0.0, 1.0, 1.0));
  let n111 = dot(latticeGrad3(i + vec3i(1, 1, 1), seed), f - vec3f(1.0, 1.0, 1.0));

  let x00 = mix(n000, n100, u.x);
  let x10 = mix(n010, n110, u.x);
  let x01 = mix(n001, n101, u.x);
  let x11 = mix(n011, n111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z) * 1.547;
}

// ---------------------------------------------------------------------------
// Simplex noise
// ---------------------------------------------------------------------------

const NOISE_F2 : f32 = 0.36602540378;   // (sqrt(3) - 1) / 2
const NOISE_G2 : f32 = 0.21132486540;   // (3 - sqrt(3)) / 6
const NOISE_F3 : f32 = 0.33333333333;
const NOISE_G3 : f32 = 0.16666666667;

/// 2D simplex noise, roughly [-1,1]. Fewer taps than Perlin and no axis-aligned
/// grain, which is why it is the terrain workhorse.
fn simplex2(p: vec2f, seed: u32) -> f32 {
  let s = (p.x + p.y) * NOISE_F2;
  let ij = floor(p + vec2f(s));
  let t = (ij.x + ij.y) * NOISE_G2;
  let p0 = p - (ij - vec2f(t));

  // Which of the two triangles in the rhombus we are in.
  let step1 = select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), p0.x > p0.y);
  let p1 = p0 - step1 + vec2f(NOISE_G2);
  let p2 = p0 - vec2f(1.0) + vec2f(2.0 * NOISE_G2);

  let i = vec2i(ij);
  var n = 0.0;

  var t0 = 0.5 - dot(p0, p0);
  if (t0 > 0.0) { t0 *= t0; n += t0 * t0 * dot(latticeGrad2(i, seed), p0); }
  var t1 = 0.5 - dot(p1, p1);
  if (t1 > 0.0) { t1 *= t1; n += t1 * t1 * dot(latticeGrad2(i + vec2i(step1), seed), p1); }
  var t2 = 0.5 - dot(p2, p2);
  if (t2 > 0.0) { t2 *= t2; n += t2 * t2 * dot(latticeGrad2(i + vec2i(1, 1), seed), p2); }

  // 99.2, not the textbook 70: that constant assumes the classic 8-gradient
  // set, and continuous random gradients peak at ~0.7071 of it.
  return 99.2 * n;
}

/// 3D simplex noise, roughly [-1,1]. Caves, volumetric detail, curl potentials.
fn simplex3(p: vec3f, seed: u32) -> f32 {
  let s = (p.x + p.y + p.z) * NOISE_F3;
  let ijk = floor(p + vec3f(s));
  let t = (ijk.x + ijk.y + ijk.z) * NOISE_G3;
  let p0 = p - (ijk - vec3f(t));

  // Branchless rank ordering of (x,y,z): g.x = x>=y, g.y = y>=z, g.z = z>=x.
  // step1/step2 are the first and second corner offsets of the simplex, and
  // this reproduces all six orderings of the JS if-chain exactly.
  let g = step(p0.yzx, p0.xyz);
  let l = vec3f(1.0) - g;
  let step1 = min(g, l.zxy);
  let step2 = max(g, l.zxy);

  let p1 = p0 - step1 + vec3f(NOISE_G3);
  let p2 = p0 - step2 + vec3f(2.0 * NOISE_G3);
  let p3 = p0 - vec3f(1.0) + vec3f(3.0 * NOISE_G3);

  let i = vec3i(ijk);
  var n = 0.0;

  var t0 = 0.6 - dot(p0, p0);
  if (t0 > 0.0) { t0 *= t0; n += t0 * t0 * dot(latticeGrad3(i, seed), p0); }
  var t1 = 0.6 - dot(p1, p1);
  if (t1 > 0.0) { t1 *= t1; n += t1 * t1 * dot(latticeGrad3(i + vec3i(step1), seed), p1); }
  var t2 = 0.6 - dot(p2, p2);
  if (t2 > 0.0) { t2 *= t2; n += t2 * t2 * dot(latticeGrad3(i + vec3i(step2), seed), p2); }
  var t3 = 0.6 - dot(p3, p3);
  if (t3 > 0.0) { t3 *= t3; n += t3 * t3 * dot(latticeGrad3(i + vec3i(1, 1, 1), seed), p3); }

  return 41.6 * n;
}

// ---------------------------------------------------------------------------
// Worley / cellular noise
// ---------------------------------------------------------------------------

/// 2D Worley. Returns (F1, F2): distances to the nearest and second-nearest
/// feature point. F2 - F1 gives cell borders (cracked mud, coral plates);
/// F1 alone gives the classic cell field.
fn worley2(p: vec2f, seed: u32, jitter: f32) -> vec2f {
  let base = vec2i(floor(p));
  var f1 = 1e9;
  var f2 = 1e9;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let c = base + vec2i(dx, dy);
      let h = hash3i(c.x, c.y, bitcast<i32>(seed));
      let r = vec2f(f32(h & 0xffffu), f32((h >> 16u) & 0xffffu)) * (1.0 / 65535.0);
      let feature = vec2f(c) + vec2f(0.5) + (r - vec2f(0.5)) * jitter;
      let d = length(feature - p);
      f2 = min(f2, max(f1, d));
      f1 = min(f1, d);
    }
  }
  return vec2f(f1, f2);
}

/// 3D Worley F1 in [0,1]. Cave chambers, cloud erosion, coral clumping.
/// Uses 10-bit jitter fields to match the CPU's packing exactly.
fn worley3F1(p: vec3f, seed: u32, jitter: f32) -> f32 {
  let base = vec3i(floor(p));
  var best = 1e9;
  for (var dz = -1; dz <= 1; dz++) {
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let c = base + vec3i(dx, dy, dz);
        let h = hash3i(c.x, c.y, c.z ^ bitcast<i32>(seed));
        let h2 = hash3i(c.z, c.x, bitcast<i32>(seed));
        let r = vec3f(f32(h & 0x3ffu), f32((h >> 10u) & 0x3ffu), f32(h2 & 0x3ffu)) * (1.0 / 1023.0);
        let feature = vec3f(c) + vec3f(0.5) + (r - vec3f(0.5)) * jitter;
        let d = feature - p;
        best = min(best, dot(d, d));
      }
    }
  }
  return saturate(sqrt(best));
}

/// Full 3D Worley: (F1, F2, cell identity in [0,1)).
///
/// F1 is the distance to the nearest feature POINT - the middle of a cell. What
/// tiles a surface into PLATES with a line along every join is F2 - F1, which is
/// zero exactly on a cell boundary. The two are not interchangeable and reaching
/// for F1 where an edge was wanted draws one dot per cell instead of one line
/// per join; that is precisely the bug the Kestrel's hull shipped with, where
/// 3 mm "panel lines" turned out to be a 0.54 m lattice of sub-pixel dots.
///
/// The third component identifies the owning cell, which is what per-plate
/// variation (finish, tint, grain direction) is keyed on. Distances are in CELL
/// units, so divide by the cell density to get metres - the gradient of F1 and
/// of F2 - F1 is unit, so that conversion is exact and a width expressed in
/// metres afterwards is a real width.
fn worley3(p: vec3f, seed: u32, jitter: f32) -> vec3f {
  let base = vec3i(floor(p));
  var f1 = 1e9;
  var f2 = 1e9;
  var owner = vec3i(0);
  for (var dz = -1; dz <= 1; dz++) {
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let c = base + vec3i(dx, dy, dz);
        let h = hash3i(c.x, c.y, c.z ^ bitcast<i32>(seed));
        let h2 = hash3i(c.z, c.x, bitcast<i32>(seed));
        let r = vec3f(f32(h & 0x3ffu), f32((h >> 10u) & 0x3ffu), f32(h2 & 0x3ffu)) * (1.0 / 1023.0);
        let feature = vec3f(c) + vec3f(0.5) + (r - vec3f(0.5)) * jitter;
        let d = length(feature - p);
        // Keep the second-nearest without a branch on the winner: max(f1, d) is
        // the larger of the incumbent and the candidate, and min-ing that into
        // f2 is correct whether or not d displaces f1 below.
        f2 = min(f2, max(f1, d));
        if (d < f1) { f1 = d; owner = c; }
      }
    }
  }
  return vec3f(f1, f2, f32(hash3i(owner.x, owner.y, owner.z ^ bitcast<i32>(seed))) * NOISE_INV_U32);
}

// ---------------------------------------------------------------------------
// Fractal combinations
// ---------------------------------------------------------------------------
//
// WGSL has no function pointers, so - unlike the JS, which takes a basis
// callback - the basis is baked in: fbm2/ridged2/billow2/domainWarp2 are
// simplex2, fbm3/turbulence3 are simplex3. That is the basis every CPU caller
// passes in practice. Octave seeds advance by 1013 exactly as they do on the
// CPU, so an octave of the GPU field lands on the CPU field's lattice.

fn fbm2(p: vec2f, seed: u32, octaves: i32, lacunarity: f32, gain: f32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var freq = 1.0;
  var norm = 0.0;
  for (var i = 0; i < octaves; i++) {
    sum += simplex2(p * freq, seed + u32(i) * NOISE_OCTAVE_SEED) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / max(norm, EPSILON);
}

fn fbm3(p: vec3f, seed: u32, octaves: i32, lacunarity: f32, gain: f32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var freq = 1.0;
  var norm = 0.0;
  for (var i = 0; i < octaves; i++) {
    sum += simplex3(p * freq, seed + u32(i) * NOISE_OCTAVE_SEED) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / max(norm, EPSILON);
}

/// Ridged multifractal in [0,1]. The weight feedback is what makes it a
/// multifractal rather than an fbm of |noise|: a low octave that is already
/// flat suppresses the detail above it, so crests stay sharp and the flanks
/// stay smooth instead of every slope being equally busy.
fn ridged2(p: vec2f, seed: u32, octaves: i32, lacunarity: f32, gain: f32, sharpness: f32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var freq = 1.0;
  var norm = 0.0;
  var weight = 1.0;
  for (var i = 0; i < octaves; i++) {
    var n = 1.0 - abs(simplex2(p * freq, seed + u32(i) * NOISE_OCTAVE_SEED));
    n *= n;
    n *= weight;
    weight = saturate(n * sharpness * 2.0);
    sum += n * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return saturate(sum / max(norm, EPSILON));
}

/// Billow: fbm of |noise|, giving rounded dune- and cloud-like lumps. [0,1].
fn billow2(p: vec2f, seed: u32, octaves: i32, lacunarity: f32, gain: f32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var freq = 1.0;
  var norm = 0.0;
  for (var i = 0; i < octaves; i++) {
    sum += abs(simplex2(p * freq, seed + u32(i) * NOISE_OCTAVE_SEED)) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return saturate(sum / max(norm, EPSILON));
}

/// Turbulence: the 3D billow. Smoke, silt plumes, vent shimmer. [0,1].
fn turbulence3(p: vec3f, seed: u32, octaves: i32, lacunarity: f32, gain: f32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var freq = 1.0;
  var norm = 0.0;
  for (var i = 0; i < octaves; i++) {
    sum += abs(simplex3(p * freq, seed + u32(i) * NOISE_OCTAVE_SEED)) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return saturate(sum / max(norm, EPSILON));
}

/// Divergence-free 3D flow field, v = curl(P) over three independent scalar
/// potentials. div(v) is zero, so particles advected by it never pile up or
/// thin out - the reason marine snow and silt use this rather than three raw
/// noise channels.
///
/// The cancellation is exact, not approximate: central-difference operators in
/// different axes commute, so the mixed second differences in div(v) cancel
/// term for term. Measured residual 6.7e-14 in f64. That only holds for a
/// SINGLE eps, though - differencing this field again with a step other than
/// `eps` gives an O(h^2 - eps^2) residual, so an advection scheme that wants
/// the divergence to stay zero must reuse the same step.
///
/// `eps` must also be small relative to the potential's finest feature
/// (~0.25 units for the 3-octave fbm here); 0.01 is the CPU default. Six fbm3
/// evaluations, so this belongs in a compute pass over particles and never in
/// a per-pixel path.
fn curlNoise3(p: vec3f, seed: u32, eps: f32) -> vec3f {
  let s1 = seed;
  let s2 = seed + 8191u;
  let s3 = seed + 16381u;
  let ex = vec3f(eps, 0.0, 0.0);
  let ey = vec3f(0.0, eps, 0.0);
  let ez = vec3f(0.0, 0.0, eps);
  let inv = 1.0 / (2.0 * eps);

  let dPz_dy = (fbm3(p + ey, s3, 3, 2.0, 0.5) - fbm3(p - ey, s3, 3, 2.0, 0.5)) * inv;
  let dPy_dz = (fbm3(p + ez, s2, 3, 2.0, 0.5) - fbm3(p - ez, s2, 3, 2.0, 0.5)) * inv;
  let dPx_dz = (fbm3(p + ez, s1, 3, 2.0, 0.5) - fbm3(p - ez, s1, 3, 2.0, 0.5)) * inv;
  let dPz_dx = (fbm3(p + ex, s3, 3, 2.0, 0.5) - fbm3(p - ex, s3, 3, 2.0, 0.5)) * inv;
  let dPy_dx = (fbm3(p + ex, s2, 3, 2.0, 0.5) - fbm3(p - ex, s2, 3, 2.0, 0.5)) * inv;
  let dPx_dy = (fbm3(p + ey, s1, 3, 2.0, 0.5) - fbm3(p - ey, s1, 3, 2.0, 0.5)) * inv;

  return vec3f(dPz_dy - dPy_dz, dPx_dz - dPz_dx, dPy_dx - dPx_dy);
}

/// Displace a sample point by an independent noise field before evaluating it.
/// This is the single cheapest way to stop a field reading as "procedural":
/// straight fbm has isotropic, evenly-sized blobs, warped fbm gets the stretched
/// and folded look of something that was deposited and then deformed.
fn domainWarp2(p: vec2f, seed: u32, strength: f32, frequency: f32, octaves: i32) -> vec2f {
  let q = p * frequency;
  let wx = fbm2(q + vec2f(5.2, 1.3), seed + 7717u, octaves, 2.0, 0.5);
  let wy = fbm2(q + vec2f(9.1, 4.7), seed + 3313u, octaves, 2.0, 0.5);
  return p + vec2f(wx, wy) * strength;
}

// ---------------------------------------------------------------------------
// Cheap variants - per-pixel budget
// ---------------------------------------------------------------------------
//
// Three octaves of gradient noise built on the discrete gradient sets, so a
// 2D evaluation costs 12 integer hashes and no transcendentals at all. Use
// these for material break-up, dither modulation and anything else evaluated
// once per fragment; use fbm2/fbm3 when the result has to line up with a
// CPU-generated field.

fn gradientQuick2(p: vec2f, seed: u32) -> f32 {
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let u = f * f * f * (f * (f * 6.0 - vec2f(15.0)) + vec2f(10.0));

  let n00 = dot(quickGrad2(i, seed), f);
  let n10 = dot(quickGrad2(i + vec2i(1, 0), seed), f - vec2f(1.0, 0.0));
  let n01 = dot(quickGrad2(i + vec2i(0, 1), seed), f - vec2f(0.0, 1.0));
  let n11 = dot(quickGrad2(i + vec2i(1, 1), seed), f - vec2f(1.0, 1.0));

  return mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y) * 1.41421356;
}

fn gradientQuick3(p: vec3f, seed: u32) -> f32 {
  let i = vec3i(floor(p));
  let f = p - floor(p);
  let u = f * f * f * (f * (f * 6.0 - vec3f(15.0)) + vec3f(10.0));

  let n000 = dot(quickGrad3(i + vec3i(0, 0, 0), seed), f - vec3f(0.0, 0.0, 0.0));
  let n100 = dot(quickGrad3(i + vec3i(1, 0, 0), seed), f - vec3f(1.0, 0.0, 0.0));
  let n010 = dot(quickGrad3(i + vec3i(0, 1, 0), seed), f - vec3f(0.0, 1.0, 0.0));
  let n110 = dot(quickGrad3(i + vec3i(1, 1, 0), seed), f - vec3f(1.0, 1.0, 0.0));
  let n001 = dot(quickGrad3(i + vec3i(0, 0, 1), seed), f - vec3f(0.0, 0.0, 1.0));
  let n101 = dot(quickGrad3(i + vec3i(1, 0, 1), seed), f - vec3f(1.0, 0.0, 1.0));
  let n011 = dot(quickGrad3(i + vec3i(0, 1, 1), seed), f - vec3f(0.0, 1.0, 1.0));
  let n111 = dot(quickGrad3(i + vec3i(1, 1, 1), seed), f - vec3f(1.0, 1.0, 1.0));

  let x00 = mix(n000, n100, u.x);
  let x10 = mix(n010, n110, u.x);
  let x01 = mix(n001, n101, u.x);
  let x11 = mix(n011, n111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z) * 1.547;
}

// Gradient noise is intrinsically lower contrast than simplex - the CPU's own
// perlin2 has 0.305 RMS against simplex2's 0.538 - so a raw substitution of
// fbmCheap2 for fbm2 would visibly flatten a material at the LOD boundary.
// These are the measured RMS ratios that make the two interchangeable:
// 1/1.75 normalises the octave weights, the second factor matches amplitude.
const FBM_CHEAP_GAIN2 : f32 = 1.7678;
const FBM_CHEAP_GAIN3 : f32 = 1.3220;

/// 3-octave fbm for per-pixel use, amplitude-matched to fbm2. Measured
/// RMS 0.357 against fbm2(3 octaves) 0.353, with excursions to +-1.15.
fn fbmCheap2(p: vec2f, seed: u32) -> f32 {
  var n = gradientQuick2(p, seed);
  n += gradientQuick2(p * 2.0, seed + NOISE_OCTAVE_SEED) * 0.5;
  n += gradientQuick2(p * 4.0, seed + 2u * NOISE_OCTAVE_SEED) * 0.25;
  return n * (FBM_CHEAP_GAIN2 / 1.75);
}

/// 3-octave 3D fbm for per-pixel use, amplitude-matched to fbm3.
fn fbmCheap3(p: vec3f, seed: u32) -> f32 {
  var n = gradientQuick3(p, seed);
  n += gradientQuick3(p * 2.0, seed + NOISE_OCTAVE_SEED) * 0.5;
  n += gradientQuick3(p * 4.0, seed + 2u * NOISE_OCTAVE_SEED) * 0.25;
  return n * (FBM_CHEAP_GAIN3 / 1.75);
}

// ---------------------------------------------------------------------------
// Tileable noise - for baking repeating textures
// ---------------------------------------------------------------------------
//
// The integer LATTICE is wrapped modulo `period`, so the field repeats exactly
// with no seam and no mirroring. Wrapping the lattice is both exact and cheaper
// than embedding a torus in 4D/6D: the torus route has to round-trip through
// cos/sin, and the last-bit differences that introduces are enough to put two
// "identical" samples in different cells. `period` is in lattice cells and must
// be a positive integer.

fn wrapLattice2(c: vec2i, period: i32) -> vec2i {
  return ((c % vec2i(period)) + vec2i(period)) % vec2i(period);
}

fn wrapLattice3(c: vec3i, period: i32) -> vec3i {
  return ((c % vec3i(period)) + vec3i(period)) % vec3i(period);
}

fn periodicPerlin2(p: vec2f, period: i32, seed: u32) -> f32 {
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let u = vec2f(smootherstep(0.0, 1.0, f.x), smootherstep(0.0, 1.0, f.y));

  let n00 = dot(latticeGrad2(wrapLattice2(i, period), seed), f);
  let n10 = dot(latticeGrad2(wrapLattice2(i + vec2i(1, 0), period), seed), f - vec2f(1.0, 0.0));
  let n01 = dot(latticeGrad2(wrapLattice2(i + vec2i(0, 1), period), seed), f - vec2f(0.0, 1.0));
  let n11 = dot(latticeGrad2(wrapLattice2(i + vec2i(1, 1), period), seed), f - vec2f(1.0, 1.0));

  return mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y) * 1.41421356;
}

fn periodicPerlin3(p: vec3f, period: i32, seed: u32) -> f32 {
  let i = vec3i(floor(p));
  let f = p - floor(p);
  let u = vec3f(smootherstep(0.0, 1.0, f.x), smootherstep(0.0, 1.0, f.y), smootherstep(0.0, 1.0, f.z));

  let n000 = dot(latticeGrad3(wrapLattice3(i + vec3i(0, 0, 0), period), seed), f - vec3f(0.0, 0.0, 0.0));
  let n100 = dot(latticeGrad3(wrapLattice3(i + vec3i(1, 0, 0), period), seed), f - vec3f(1.0, 0.0, 0.0));
  let n010 = dot(latticeGrad3(wrapLattice3(i + vec3i(0, 1, 0), period), seed), f - vec3f(0.0, 1.0, 0.0));
  let n110 = dot(latticeGrad3(wrapLattice3(i + vec3i(1, 1, 0), period), seed), f - vec3f(1.0, 1.0, 0.0));
  let n001 = dot(latticeGrad3(wrapLattice3(i + vec3i(0, 0, 1), period), seed), f - vec3f(0.0, 0.0, 1.0));
  let n101 = dot(latticeGrad3(wrapLattice3(i + vec3i(1, 0, 1), period), seed), f - vec3f(1.0, 0.0, 1.0));
  let n011 = dot(latticeGrad3(wrapLattice3(i + vec3i(0, 1, 1), period), seed), f - vec3f(0.0, 1.0, 1.0));
  let n111 = dot(latticeGrad3(wrapLattice3(i + vec3i(1, 1, 1), period), seed), f - vec3f(1.0, 1.0, 1.0));

  let x00 = mix(n000, n100, u.x);
  let x10 = mix(n010, n110, u.x);
  let x01 = mix(n001, n101, u.x);
  let x11 = mix(n011, n111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z) * 1.547;
}

/// Exactly tileable fbm. Octave i runs at 2^i times the frequency AND 2^i times
/// the lattice period, so every octave wraps at the same world interval.
fn tileableFbm2(p: vec2f, period: i32, seed: u32, octaves: i32, gain: f32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var norm = 0.0;
  var scale = 1;
  for (var i = 0; i < octaves; i++) {
    sum += periodicPerlin2(p * f32(scale), period * scale, seed + u32(i) * NOISE_OCTAVE_SEED) * amp;
    norm += amp;
    amp *= gain;
    scale *= 2;
  }
  return sum / max(norm, EPSILON);
}

fn tileableFbm3(p: vec3f, period: i32, seed: u32, octaves: i32, gain: f32) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var norm = 0.0;
  var scale = 1;
  for (var i = 0; i < octaves; i++) {
    sum += periodicPerlin3(p * f32(scale), period * scale, seed + u32(i) * NOISE_OCTAVE_SEED) * amp;
    norm += amp;
    amp *= gain;
    scale *= 2;
  }
  return sum / max(norm, EPSILON);
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

/// Map a signed basis value to [0,1].
fn to01(n: f32) -> f32 { return n * 0.5 + 0.5; }

/// Quantise into `steps` bands with `softness` blending: sedimentary strata,
/// evaporite terraces, the banding on a shell.
fn terrace(v: f32, steps: f32, softness: f32) -> f32 {
  let s = v * steps;
  let base = floor(s);
  let frac = s - base;
  let eased = select(smootherstep(0.5 - softness * 0.5, 0.5 + softness * 0.5, frac), 0.0, softness <= 0.0);
  return (base + eased) / steps;
}
