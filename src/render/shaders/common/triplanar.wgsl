// SUBWAVE - triplanar texturing.
//
// Terrain is marching-cubes geometry with no UV parameterisation, and it never
// will have one: the surface is regenerated per chunk and can be arbitrarily
// overhung, so there is no stable 2D atlas to unwrap into. Everything it is
// textured with is therefore projected from the three world axes and blended by
// how much the surface faces each of them.
//
// The cost is real - three taps per map instead of one - so the rules are:
//   - compute the weights ONCE per fragment and reuse them for albedo,
//     normal, roughness and AO (the *W variants below take them as an argument)
//   - never call these outside a fragment shader; they rely on implicit
//     derivatives for mip selection
//   - never wrap a call in a branch. textureSample requires uniform control
//     flow, and an early-out on "this axis is nearly zero" makes every
//     subsequent sample illegal. Weight-culling here removes a plane's
//     CONTRIBUTION, not its tap; skipping the tap needs textureSampleGrad.

#pragma once

#include "math.wgsl"

/// Exponent applied to |N| before normalising. Higher = narrower blend band and
/// less smearing on the 45 degree faces, at the cost of a visible transition.
/// 4.0 is the terrain default and holds up on everything from sand to cliffs.
const TRIPLANAR_SHARPNESS : f32 = 4.0;

/// Planes below this weight are dropped entirely. Below ~2% the plane is
/// projecting nearly edge-on, so its texels are stretched by 50x or more and
/// all it adds is a smeared streak.
const TRIPLANAR_CULL : f32 = 0.02;

// ---------------------------------------------------------------------------
// Weights and projection
// ---------------------------------------------------------------------------

/// Blend weights for the X, Y and Z planes from a world-space GEOMETRIC normal.
/// Use the geometric normal, not the normal-mapped one, or the projection
/// wobbles with the detail and the whole surface swims.
fn triplanarWeights(normal: vec3f, sharpness: f32) -> vec3f {
  var w = pow(abs(normal), vec3f(sharpness));
  w /= max(w.x + w.y + w.z, 1e-5);
  w = select(vec3f(0.0), w, w > vec3f(TRIPLANAR_CULL));
  return w / max(w.x + w.y + w.z, 1e-5);
}

/// The three projected UV sets plus the sign correction each one needs when its
/// tangent-space normal is decoded.
struct TriplanarUV {
  x     : vec2f,
  y     : vec2f,
  z     : vec2f,
  // Per-plane (u, v) mirroring. A negated UV axis negates the corresponding
  // tangent axis, so a normal map sampled through a mirrored projection lights
  // from the wrong side unless these are applied to its xy.
  flipX : vec2f,
  flipY : vec2f,
  flipZ : vec2f,
};

/// World-space projection. `scale` is tiles per metre (the reciprocal of the
/// material's "metres per tile"), so 0.5 means one tile every 2 m.
///
/// The X and Z projections are mirrored by the sign of the normal. Without
/// that, the two sides of a ridge project the same texture in opposite
/// directions and the crest gets a hard mirrored seam running along it.
fn triplanarUV(worldPos: vec3f, normal: vec3f, scale: f32) -> TriplanarUV {
  // Not sign(): sign(0) is 0, which would collapse a UV axis to a constant on
  // a perfectly axis-aligned face.
  let sx = select(-1.0, 1.0, normal.x >= 0.0);
  let sz = select(-1.0, 1.0, normal.z >= 0.0);

  var uv : TriplanarUV;
  // -P.y so that image-space +v (which runs down) maps to world down, i.e.
  // textures are the right way up on every wall.
  uv.x = vec2f(-worldPos.z * sx, -worldPos.y) * scale;
  uv.y = vec2f(worldPos.x, worldPos.z) * scale;
  uv.z = vec2f(worldPos.x * sz, -worldPos.y) * scale;
  uv.flipX = vec2f(-sx, -1.0);
  uv.flipY = vec2f(1.0, 1.0);
  uv.flipZ = vec2f(sz, -1.0);
  return uv;
}

// ---------------------------------------------------------------------------
// Colour / data sampling
// ---------------------------------------------------------------------------

/// Blend three plane samples with precomputed weights.
fn triplanarSampleW(tex: texture_2d<f32>, samp: sampler, uv: TriplanarUV, w: vec3f) -> vec4f {
  let cx = textureSample(tex, samp, uv.x);
  let cy = textureSample(tex, samp, uv.y);
  let cz = textureSample(tex, samp, uv.z);
  return cx * w.x + cy * w.y + cz * w.z;
}

/// One-shot triplanar sample at the default sharpness. Correct for albedo,
/// roughness, AO - anything whose channels are linear in the blend.
fn triplanarSample(tex: texture_2d<f32>, samp: sampler, worldPos: vec3f, normal: vec3f, scale: f32) -> vec4f {
  let w = triplanarWeights(normal, TRIPLANAR_SHARPNESS);
  return triplanarSampleW(tex, samp, triplanarUV(worldPos, normal, scale), w);
}

// ---------------------------------------------------------------------------
// Normal mapping
// ---------------------------------------------------------------------------

/// Decode a two-channel tangent-space normal and rebuild z. Works for both
/// rg8unorm and rgba8unorm maps, and the reconstruction is what keeps the
/// result unit length after BC5-style compression has mangled xy.
fn decodeTangentNormal(s: vec4f) -> vec3f {
  let n = s.xy * 2.0 - vec2f(1.0);
  return vec3f(n, sqrt(saturate(1.0 - dot(n, n))));
}

/// Whiteout blend of three plane normals.
///
/// The naive version - reproject each tangent normal into world space and
/// average - destroys exactly the detail you care about. On a 45 degree face
/// two planes carry ~0.5 weight each, and their tangent normals are unrelated
/// perturbations of two different axes, so averaging them cancels the lateral
/// components and pulls the result back toward the geometric normal. The
/// surfaces with the most relief end up the flattest.
///
/// Whiteout adds the geometric normal into each tangent xy BEFORE blending and
/// forces z positive, so what gets summed is three perturbations of one shared
/// direction rather than three competing directions. Detail survives the
/// transition band, and the blend degrades to the geometric normal only where
/// the maps themselves are flat.
fn triplanarNormalW(tex: texture_2d<f32>, samp: sampler, uv: TriplanarUV, w: vec3f, normal: vec3f) -> vec3f {
  var tx = decodeTangentNormal(textureSample(tex, samp, uv.x));
  var ty = decodeTangentNormal(textureSample(tex, samp, uv.y));
  var tz = decodeTangentNormal(textureSample(tex, samp, uv.z));
  tx = vec3f(tx.xy * uv.flipX, tx.z);
  ty = vec3f(ty.xy * uv.flipY, ty.z);
  tz = vec3f(tz.xy * uv.flipZ, tz.z);

  let ax = vec3f(tx.xy + normal.zy, abs(tx.z) * normal.x);
  let ay = vec3f(ty.xy + normal.xz, abs(ty.z) * normal.y);
  let az = vec3f(tz.xy + normal.xy, abs(tz.z) * normal.z);

  // Swizzle each plane's result back to world axes before summing.
  let blended = ax.zyx * w.x + ay.xzy * w.y + az.xyz * w.z;
  let len = length(blended);
  return select(normal, blended / len, len > 1e-5);
}

fn triplanarNormal(tex: texture_2d<f32>, samp: sampler, worldPos: vec3f, normal: vec3f, scale: f32) -> vec3f {
  let w = triplanarWeights(normal, TRIPLANAR_SHARPNESS);
  return triplanarNormalW(tex, samp, triplanarUV(worldPos, normal, scale), w, normal);
}

// ---------------------------------------------------------------------------
// Material layer blending
// ---------------------------------------------------------------------------

/// Height-aware blend of two material layers.
///
/// A linear cross-fade between sand and rock produces a soft grey band that
/// exists nowhere in nature: real sand sits IN the low points of the rock and
/// the rock's high points punch through it. Feeding each layer's height map
/// into the blend reproduces that - wherever one layer is locally taller it
/// wins outright, so the boundary follows the grain of both surfaces and
/// interlocks instead of dissolving.
///
/// `a`, `b`     incoming linear layer weights (typically summing to 1)
/// `heightA/B`  the layers' height channels, [0,1]
/// `sharpness`  the height window over which the two interpenetrate, in the
///              same units as the heights. 0.22 is the terrain default; 0.02
///              gives a razor boundary, 0.6 degrades toward a 50/50 mush.
/// Returns the two normalised weights.
fn heightBlend(a: f32, b: f32, heightA: f32, heightB: f32, sharpness: f32) -> vec2f {
  let ha = a + heightA;
  let hb = b + heightB;
  let cutoff = max(ha, hb) - max(sharpness, 1e-3);
  let wa = max(ha - cutoff, 0.0);
  let wb = max(hb - cutoff, 0.0);
  return vec2f(wa, wb) / max(wa + wb, 1e-5);
}

/// Reoriented normal mapping (Barre-Brisebois & Hill): layer `detail` on top of
/// `base` by rotating the detail normal into the base normal's frame, rather
/// than adding or lerping them. A lerp of two normals averages away both, and
/// adding them lets a strong detail normal tip the result past horizontal; RNM
/// treats detail as a perturbation OF the base, so the base's shape is
/// preserved exactly and the detail rides on it.
///
/// Identities worth knowing: a flat `detail` returns `base` unchanged, and a
/// flat `base` returns `detail` unchanged.
fn blendNormalRNM(base: vec3f, detail: vec3f, strength: f32) -> vec3f {
  let d = mix(vec3f(0.0, 0.0, 1.0), detail, saturate(strength));
  let t = base + vec3f(0.0, 0.0, 1.0);
  let u = d * vec3f(-1.0, -1.0, 1.0);
  return normalize(t * (dot(t, u) / max(t.z, 1e-4)) - u);
}

// ---------------------------------------------------------------------------
// Band filtering
// ---------------------------------------------------------------------------
//
// A procedural material is a sum of frequency bands, and the only way to keep
// it from shimmering is to drop each band once the screen can no longer
// resolve it. Distance is the obvious control and it is not sufficient: a beach
// seen along its length is thirty metres away and a thousand metres away in the
// same fifty pixels, so a distance fade either kills the foreground or lets the
// horizon alias. What actually matters is the WORLD SIZE OF ONE PIXEL, which
// the position derivatives give exactly, grazing angle included.

/// World-space extent of one screen pixel at this fragment, in metres.
///
/// Fragment stage only - it uses implicit derivatives. Camera-relative or
/// absolute position both work; only the difference between neighbouring
/// fragments is read.
fn pixelFootprint(worldPos: vec3f) -> f32 {
  return max(length(dpdx(worldPos)), length(dpdy(worldPos)));
}

/// Gain for a detail band whose characteristic feature is `featureMetres`
/// across, given the pixel footprint from pixelFootprint().
///
/// Full strength while the feature spans four pixels or more, zero once it is
/// down to two - the Nyquist limit, below which the band carries no signal, only
/// shimmer. Quote the band's MIDDLE octave as the feature size: an fbm's top
/// octave holds a quarter of its energy and a sixteenth of its variance, and
/// letting that one octave decide would strip the whole band three times too
/// early. What survives of it is inside TAA's reconstruction window.
///
/// Bands must be zero-mean for this to be correct: fading one out has to
/// converge the material to its own average, not darken it.
fn bandGain(featureMetres: f32, footprint: f32) -> f32 {
  return 1.0 - smoothstep(featureMetres * 0.25, featureMetres * 0.5, footprint);
}

// ---------------------------------------------------------------------------
// Distance-faded detail
// ---------------------------------------------------------------------------
//
// The shared detail texture is two octaves of the same map at very different
// world scales, cross-faded by view distance so neither ever aliases:
//
//   near octave  4.0 tiles/m -> 25 cm features. Full strength to 6 m, gone
//                by 26 m; past that its texels are below a pixel.
//   far  octave  0.25 tiles/m -> 4 m features. Fades in over 10..45 m and back
//                out over 180..400 m, where even 4 m features shrink under a
//                pixel and would shimmer under camera motion.
//
// Between 26 m and 180 m the far octave alone carries the break-up, which is
// what stops mid-distance terrain reading as flat vertex colour.

const DETAIL_NEAR_SCALE     : f32 = 4.0;
const DETAIL_FAR_SCALE      : f32 = 0.25;
const DETAIL_NEAR_FADE_START: f32 = 6.0;
const DETAIL_NEAR_FADE_END  : f32 = 26.0;
const DETAIL_FAR_FADE_IN0   : f32 = 10.0;
const DETAIL_FAR_FADE_IN1   : f32 = 45.0;
const DETAIL_FAR_FADE_OUT0  : f32 = 180.0;
const DETAIL_FAR_FADE_OUT1  : f32 = 400.0;

fn detailFadeNear(viewDist: f32) -> f32 {
  return 1.0 - smoothstep(DETAIL_NEAR_FADE_START, DETAIL_NEAR_FADE_END, viewDist);
}

fn detailFadeFar(viewDist: f32) -> f32 {
  return smoothstep(DETAIL_FAR_FADE_IN0, DETAIL_FAR_FADE_IN1, viewDist)
       * (1.0 - smoothstep(DETAIL_FAR_FADE_OUT0, DETAIL_FAR_FADE_OUT1, viewDist));
}

/// UV of the single strongest plane. Detail is high frequency and low contrast,
/// so blending it across three planes buys nothing visible for triple the taps;
/// the seam where the dominant axis changes is hidden by the base material's
/// own triplanar blend.
fn dominantPlaneUV(worldPos: vec3f, normal: vec3f, scale: f32) -> vec2f {
  let a = abs(normal);
  let sx = select(-1.0, 1.0, normal.x >= 0.0);
  let sz = select(-1.0, 1.0, normal.z >= 0.0);
  let uvX = vec2f(-worldPos.z * sx, -worldPos.y);
  let uvY = vec2f(worldPos.x, worldPos.z);
  let uvZ = vec2f(worldPos.x * sz, -worldPos.y);
  let pick = select(select(uvZ, uvY, a.y >= a.z), uvX, a.x >= max(a.y, a.z));
  return pick * scale;
}

/// Multiplicative albedo break-up, centred on 1.0. Two taps total.
///
/// `strength` is the material's detail amount; the far octave is applied at
/// 0.6 of it, matching how the far detail NORMAL is weighted, so albedo and
/// normal detail fade together rather than one outliving the other.
fn detailTexture(tex: texture_2d<f32>, samp: sampler, worldPos: vec3f, normal: vec3f,
                 viewDist: f32, strength: f32) -> f32 {
  // Both taps are unconditional: an early-out on the fades would put the
  // samples in non-uniform control flow.
  let near = textureSample(tex, samp, dominantPlaneUV(worldPos, normal, DETAIL_NEAR_SCALE)).r;
  let far  = textureSample(tex, samp, dominantPlaneUV(worldPos, normal, DETAIL_FAR_SCALE)).r;

  let mNear = mix(1.0, near * 2.0, saturate(strength * detailFadeNear(viewDist)));
  let mFar  = mix(1.0, far * 2.0, saturate(strength * 0.6 * detailFadeFar(viewDist)));
  return mNear * mFar;
}
