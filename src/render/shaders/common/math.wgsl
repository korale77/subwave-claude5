// SUBWAVE - shared WGSL math.
// No dependencies. Included by nearly everything.

#pragma once

const PI          : f32 = 3.14159265359;
const TAU         : f32 = 6.28318530718;
const HALF_PI     : f32 = 1.57079632679;
const INV_PI      : f32 = 0.31830988618;
const INV_4PI     : f32 = 0.07957747155;
const EPSILON     : f32 = 1e-6;
const FLT_MAX     : f32 = 3.402823466e38;
const DEG2RAD     : f32 = 0.01745329252;
const RAD2DEG     : f32 = 57.2957795131;
const GOLDEN      : f32 = 1.61803398875;

fn sqr(x: f32) -> f32 { return x * x; }
fn pow5(x: f32) -> f32 { let x2 = x * x; return x2 * x2 * x; }
fn maxComponent(v: vec3f) -> f32 { return max(v.x, max(v.y, v.z)); }
fn minComponent(v: vec3f) -> f32 { return min(v.x, min(v.y, v.z)); }
fn luminance(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn average(v: vec3f) -> f32 { return (v.x + v.y + v.z) * 0.3333333; }

fn remap(x: f32, a0: f32, a1: f32, b0: f32, b1: f32) -> f32 {
  return b0 + (x - a0) / max(a1 - a0, EPSILON) * (b1 - b0);
}
fn remapClamped(x: f32, a0: f32, a1: f32, b0: f32, b1: f32) -> f32 {
  return b0 + saturate((x - a0) / max(a1 - a0, EPSILON)) * (b1 - b0);
}

/// Ken Perlin's C2-continuous smoothstep. Use where the derivative matters
/// (normals, displacement), otherwise the built-in smoothstep is fine.
fn smootherstep(edge0: f32, edge1: f32, x: f32) -> f32 {
  let t = saturate((x - edge0) / max(edge1 - edge0, EPSILON));
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

/// Frame-rate independent exponential approach.
fn damp(a: f32, b: f32, rate: f32, dt: f32) -> f32 {
  return b + (a - b) * exp(-rate * dt);
}

/// Polynomial smooth minimum. Blends two SDFs without a crease.
fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = saturate(0.5 + 0.5 * (b - a) / max(k, EPSILON));
  return mix(b, a, h) - k * h * (1.0 - h);
}
fn smax(a: f32, b: f32, k: f32) -> f32 { return -smin(-a, -b, k); }

/// Schlick's Fresnel approximation for a scalar F0.
fn fresnelSchlick(cosTheta: f32, f0: f32) -> f32 {
  return f0 + (1.0 - f0) * pow5(saturate(1.0 - cosTheta));
}
fn fresnelSchlick3(cosTheta: f32, f0: vec3f) -> vec3f {
  return f0 + (vec3f(1.0) - f0) * pow5(saturate(1.0 - cosTheta));
}
/// Roughness-aware variant, so rough surfaces do not get a hard rim highlight.
fn fresnelSchlickRoughness(cosTheta: f32, f0: vec3f, roughness: f32) -> vec3f {
  let fr = max(vec3f(1.0 - roughness), f0);
  return f0 + (fr - f0) * pow5(saturate(1.0 - cosTheta));
}

// ---------------------------------------------------------------------------
// Depth (reverse-Z, infinite far plane)
// ---------------------------------------------------------------------------
//
// proj[10] = 0, proj[11] = -1, proj[14] = near, so:
//   clipZ = near,  clipW = -viewZ   ->  ndcZ = near / -viewZ
// Therefore linear view depth is simply near / ndcZ, and ndcZ -> 0 at infinity.

fn linearizeDepth(ndcDepth: f32, near: f32) -> f32 {
  return near / max(ndcDepth, 1e-7);
}

fn depthToViewZ(ndcDepth: f32) -> f32 {
  return -linearizeDepth(ndcDepth, EPSILON);
}

/// Reconstruct a camera-relative world position from a UV and a depth sample.
fn worldFromDepth(uv: vec2f, ndcDepth: f32, invViewProj: mat4x4f) -> vec3f {
  let ndc = vec4f(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0, ndcDepth, 1.0);
  let p = invViewProj * ndc;
  return p.xyz / p.w;
}

/// A normalised view ray for a UV, from the camera basis. Cheaper than a
/// matrix multiply and exact for a symmetric frustum.
fn viewRayFromUV(uv: vec2f, fwd: vec3f, right: vec3f, up: vec3f, tanHalfFov: f32, aspect: f32) -> vec3f {
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  return normalize(fwd + right * (ndc.x * tanHalfFov * aspect) + up * (ndc.y * tanHalfFov));
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/// Octahedral normal encoding: a unit vector in 2 channels with ~0.1 deg error.
/// Halves G-buffer normal cost versus storing xyz.
fn octEncode(n: vec3f) -> vec2f {
  let absN = abs(n);
  var p = n.xy * (1.0 / (absN.x + absN.y + absN.z));
  if (n.z < 0.0) {
    let s = vec2f(select(-1.0, 1.0, p.x >= 0.0), select(-1.0, 1.0, p.y >= 0.0));
    p = (vec2f(1.0) - abs(p.yx)) * s;
  }
  return p * 0.5 + 0.5;
}

fn octDecode(e: vec2f) -> vec3f {
  let f = e * 2.0 - 1.0;
  var n = vec3f(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
  let t = saturate(-n.z);
  n = vec3f(n.xy + select(vec2f(t), vec2f(-t), n.xy >= vec2f(0.0)), n.z);
  return normalize(n);
}

fn packUnorm2(v: vec2f) -> f32 {
  let u = vec2u(saturate(v) * 65535.0);
  return bitcast<f32>((u.x << 16u) | u.y);
}

fn unpackUnorm2(f: f32) -> vec2f {
  let u = bitcast<u32>(f);
  return vec2f(f32(u >> 16u), f32(u & 0xffffu)) / 65535.0;
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

fn srgbToLinear(c: vec3f) -> vec3f {
  let cutoff = c <= vec3f(0.04045);
  let low = c / 12.92;
  let high = pow((c + vec3f(0.055)) / 1.055, vec3f(2.4));
  return select(high, low, cutoff);
}

fn linearToSrgb(c: vec3f) -> vec3f {
  let cutoff = c <= vec3f(0.0031308);
  let low = c * 12.92;
  let high = 1.055 * pow(c, vec3f(1.0 / 2.4)) - vec3f(0.055);
  return select(high, low, cutoff);
}

/// Colour temperature (Kelvin) to linear RGB. Used for the vessel lamps, which
/// are specified in Kelvin so they read as real fixtures.
fn kelvinToRGB(kelvin: f32) -> vec3f {
  let t = clamp(kelvin, 1000.0, 15000.0) / 100.0;
  var r: f32; var g: f32; var b: f32;
  if (t <= 66.0) {
    r = 1.0;
    g = saturate(0.39008157 * log(t) - 0.63184144);
  } else {
    r = saturate(1.29293618 * pow(t - 60.0, -0.1332047592));
    g = saturate(1.12989086 * pow(t - 60.0, -0.0755148492));
  }
  if (t >= 66.0) { b = 1.0; }
  else if (t <= 19.0) { b = 0.0; }
  else { b = saturate(0.54320678 * log(t - 10.0) - 1.19625408); }
  return srgbToLinear(vec3f(r, g, b));
}

// ---------------------------------------------------------------------------
// Hashing (for dithering and stochastic effects; the world uses noise.wgsl)
// ---------------------------------------------------------------------------

fn hash11(p: f32) -> f32 {
  var x = fract(p * 0.1031);
  x *= x + 33.33;
  x *= x + x;
  return fract(x);
}

fn hash12(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn hash13(p: vec3f) -> f32 {
  var p3 = fract(p * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

fn hash22(p: vec2f) -> vec2f {
  var p3 = fract(vec3f(p.xyx) * vec3f(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

fn hash33(p: vec3f) -> vec3f {
  var p3 = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

/// Interleaved gradient noise. The right choice for per-pixel dithering that
/// TAA will resolve; cheaper than a texture fetch and well distributed.
fn interleavedGradientNoise(pixel: vec2f, frameIdx: f32) -> f32 {
  let p = pixel + 5.588238 * frameIdx;
  return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/// Build an orthonormal basis around a unit vector (Duff et al., branchless).
fn orthonormalBasis(n: vec3f) -> mat3x3f {
  let s = select(-1.0, 1.0, n.z >= 0.0);
  let a = -1.0 / (s + n.z);
  let b = n.x * n.y * a;
  let t = vec3f(1.0 + s * n.x * n.x * a, s * b, -s * n.x);
  let bt = vec3f(b, s + n.y * n.y * a, -n.y);
  return mat3x3f(t, bt, n);
}

/// Uniformly distributed point on a hemisphere around +Z, cosine weighted.
fn cosineHemisphere(u: vec2f) -> vec3f {
  let r = sqrt(u.x);
  let theta = TAU * u.y;
  return vec3f(r * cos(theta), r * sin(theta), sqrt(max(0.0, 1.0 - u.x)));
}

/// Ray vs sphere. Returns (tNear, tFar); tFar < 0 means a miss.
fn raySphere(origin: vec3f, dir: vec3f, center: vec3f, radius: f32) -> vec2f {
  let oc = origin - center;
  let b = dot(oc, dir);
  let c = dot(oc, oc) - radius * radius;
  let disc = b * b - c;
  if (disc < 0.0) { return vec2f(-1.0, -1.0); }
  let s = sqrt(disc);
  return vec2f(-b - s, -b + s);
}

/// Ray vs the horizontal plane y = planeY. Returns t, or -1.
fn rayPlaneY(origin: vec3f, dir: vec3f, planeY: f32) -> f32 {
  if (abs(dir.y) < 1e-6) { return -1.0; }
  let t = (planeY - origin.y) / dir.y;
  return select(-1.0, t, t >= 0.0);
}

/// Ray vs axis-aligned box. Returns (tNear, tFar); tFar < tNear means a miss.
fn rayAABB(origin: vec3f, invDir: vec3f, bmin: vec3f, bmax: vec3f) -> vec2f {
  let t0 = (bmin - origin) * invDir;
  let t1 = (bmax - origin) * invDir;
  let tmin = min(t0, t1);
  let tmax = max(t0, t1);
  return vec2f(maxComponent(tmin), minComponent(tmax));
}

// ---------------------------------------------------------------------------
// Tonemapping
// ---------------------------------------------------------------------------

/// AgX inset + log encode + sigmoid. Returns AgX-base CODE values, which is what
/// the look and the outset matrix both expect. Chosen over ACES because ACES
/// pushes saturated blues toward purple, and this game is almost entirely
/// saturated blue.
fn agxSigmoid(colorIn: vec3f) -> vec3f {
  let m1 = mat3x3f(
    vec3f(0.842479, 0.042328, 0.042376),
    vec3f(0.078360, 0.878468, 0.078845),
    vec3f(0.079160, 0.079200, 0.878780));

  var c = m1 * max(colorIn, vec3f(0.0));
  // Log encode over a 16.5 stop range.
  c = clamp((log2(max(c, vec3f(1e-10))) + 12.47393) / 16.5, vec3f(0.0), vec3f(1.0));
  // Sigmoid.
  let c2 = c * c;
  let c3 = c2 * c;
  return 15.5 * c3 * c3 - 40.14 * c3 * c2 + 31.96 * c2 * c2 - 6.868 * c3 + 0.4298 * c2 + 0.1191 * c - 0.00232;
}

/// The AgX "look": an ASC-CDL power and a saturation about luma, applied in code
/// space between the sigmoid and the outset matrix.
///
/// BASE AgX IS DELIBERATELY FLAT. The sigmoid desaturates toward white on the way
/// up - which is the whole reason it was chosen over ACES - and without a look to
/// put chroma back the image is grey. Every reference implementation carries one;
/// this renderer shipped without it, and measured delivered saturation was 11.2%
/// against 42.5% present in the scene radiance.
fn agxLook(c: vec3f, power: f32, sat: f32) -> vec3f {
  let luma = luminance(c);
  let p = pow(max(c, vec3f(0.0)), vec3f(power));
  return max(vec3f(luma) + sat * (p - vec3f(luma)), vec3f(0.0));
}

/// AgX through the outset matrix, still DISPLAY-ENCODED (no EOTF).
///
/// The per-depth grade runs on this value, because lift and the contrast pivot
/// are both code quantities: a lift of 0.1 means "raise black to 10% of the way
/// up the display range", which is only true before the EOTF.
fn agxEncode(colorIn: vec3f, lookPower: f32, lookSat: f32) -> vec3f {
  let m2 = mat3x3f(
    vec3f( 1.196881, -0.052909, -0.052374),
    vec3f(-0.098020,  1.151824, -0.100603),
    vec3f(-0.099121, -0.098844,  1.153010));
  return max(m2 * agxLook(agxSigmoid(colorIn), lookPower, lookSat), vec3f(0.0));
}

/// Full AgX, returning DISPLAY-REFERRED LINEAR as every caller in this project
/// assumes.
///
/// THE pow(2.2) IS NOT OPTIONAL. The sigmoid emits a display CODE value, and both
/// callers (pass/lens.wgsl and pass/present.wgsl) run linearToSrgb afterwards - so
/// without the EOTF here the image is gamma-decoded twice. Measured: 18% scene
/// grey landed at code 187 instead of 128, no pixel in the shipped spawn frame
/// fell below code 0.442, and the transfer function alone threw away 71% of the
/// scene's chroma.
fn tonemapAgX(colorIn: vec3f) -> vec3f {
  return pow(agxEncode(colorIn, AGX_LOOK_POWER, AGX_LOOK_SATURATION), vec3f(2.2));
}

/// Reinhard with a white point, for UI and debug views.
fn tonemapReinhard(c: vec3f, white: f32) -> vec3f {
  let l = luminance(c);
  let ln = l * (1.0 + l / (white * white)) / (1.0 + l);
  return c * (ln / max(l, EPSILON));
}
