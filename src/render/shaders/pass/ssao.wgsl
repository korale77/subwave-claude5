// SUBWAVE - screen-space ambient occlusion.
//
// Three fragment entry points, one per subpass of render/passes/ssao.js:
//
//   fs_ssao        half-res: depth -> view-space position -> hemispheric
//                  occlusion estimate, blue-noise rotated per pixel per frame
//   fs_ssao_blur   half-res: depth-aware 3x3 of the estimate
//   fs_ssao_apply  full-res: depth-aware upsample, multiplied into sceneColor
//                  through the aoGate written by the geometry passes
//
// WHAT THIS PASS MAY AND MAY NOT TOUCH. The apply half multiplies sceneColor
// by 1 - SSAO_STRENGTH * gate * (1 - ao), where `gate` is the pixel's own
// delivered AMBIENT share (aoGate() in common/water.wgsl). So the only energy
// SSAO can remove is ambient: emission, the sun's direct beam (the CSM owns
// that occlusion), punctual lamps and the medium's in-scatter are all outside
// the gate's numerator. The removal is luminance-exact and lies along the
// pixel's own chroma - see the RENDER.SSAO_STRENGTH docstring for the whole
// contract, and the pass registration in render/passes/index.js for why this
// runs after the last opaque depth writer and before the sky.
//
// JITTER IS CONSISTENT, NOT REMOVED. sceneDepth is rendered with the JITTERED
// projection, so every unprojection here uses frame.invProj - the inverse of
// that same jittered matrix - and the whole AO field wobbles sub-pixel with
// the depth buffer it came from. That is deliberate: this runs before TAA,
// which averages the wobble and the kernel noise together. Do not "fix" the
// jitter out of the reconstruction; a stationary AO field over a jittering
// depth buffer is the version that shimmers.

#include "../common/fullscreen.wgsl"

struct SsaoParams {
  // x = world-space radius (m), y = cosine bias, z = intensity, w = power
  params0 : vec4f,
  // x = strength (apply mix), y = fade start (m), z = fade end (m), w unused
  params1 : vec4f,
};

@group(1) @binding(0) var<uniform> ssao : SsaoParams;
@group(1) @binding(1) var depthTex : texture_depth_2d;
// fs_ssao_blur: the raw estimate. fs_ssao_apply: the blurred one.
@group(1) @binding(2) var aoInput  : texture_2d<f32>;
// fs_ssao_apply only: the ambient-share gate the geometry passes wrote.
@group(1) @binding(3) var gateTex  : texture_2d<f32>;

/// Clamp on the projected kernel radius, half-res pixels. The lower bound
/// keeps a far surface from collapsing the kernel into its own texel (pure
/// self-occlusion noise); the upper keeps a near wall from scattering taps
/// across the whole screen, which is both slow and wrong (the gather misses
/// everything between the sparse taps).
const SSAO_MAX_RADIUS_PX : f32 = 40.0;
const SSAO_MIN_RADIUS_PX : f32 = 2.0;
/// Golden-angle turns across the tap spiral - decorrelates the tap directions
/// without a per-tap hash.
const SSAO_SPIRAL_TURNS : f32 = 3.7;

/// Reverse-Z-infinite view-space reconstruction at a FULL-RES texel.
/// Returns view-space position; .z is negative in front of the camera
/// (o[11] = -1), and w = 0 flags "no geometry on this ray" (depth cleared 0).
fn viewPosAt(pix: vec2i, dims: vec2i) -> vec4f {
  let p = clamp(pix, vec2i(0), dims - 1);
  let z = textureLoad(depthTex, p, 0);
  if (z <= 0.0) { return vec4f(0.0); }
  let uv = (vec2f(p) + 0.5) / vec2f(dims);
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let h = frame.invProj * vec4f(ndc, z, 1.0);
  return vec4f(h.xyz / h.w, 1.0);
}

/// The view-space normal from depth alone, one-sided differences choosing the
/// flatter neighbour on each axis so a depth edge does not smear a bogus
/// 45-degree normal across the silhouette. One texel of error survives at the
/// crease itself; SSAO_BIAS exists to absorb exactly that.
fn viewNormalAt(pix: vec2i, dims: vec2i, pC: vec3f) -> vec3f {
  let pR = viewPosAt(pix + vec2i(2, 0), dims);
  let pL = viewPosAt(pix - vec2i(2, 0), dims);
  let pD = viewPosAt(pix + vec2i(0, 2), dims);
  let pU = viewPosAt(pix - vec2i(0, 2), dims);
  var dx = pR.xyz - pC;
  if (pL.w > 0.0 && (pR.w == 0.0 || abs(pL.z - pC.z) < abs(pR.z - pC.z))) {
    dx = pC - pL.xyz;
  }
  var dy = pD.xyz - pC;
  if (pU.w > 0.0 && (pD.w == 0.0 || abs(pU.z - pC.z) < abs(pD.z - pC.z))) {
    dy = pC - pU.xyz;
  }
  var n = normalize(cross(dy, dx));
  // Face the camera: the eye is at the view-space origin, so a visible
  // surface's normal must oppose the view ray.
  if (dot(n, -pC) < 0.0) { n = -n; }
  return n;
}

// ---------------------------------------------------------------------------
// 1. The half-res occlusion estimate
// ---------------------------------------------------------------------------

@fragment
fn fs_ssao(in: FSOut) -> @location(0) vec4f {
  let dims = vec2i(textureDimensions(depthTex, 0));
  let halfPix = vec2i(in.pos.xy);
  // The full-res texel this half-res pixel stands on. 2x + 0 rather than a
  // 2x2 average: AO needs one coherent surface, not a blend across an edge.
  let pix = halfPix * 2;

  let centre = viewPosAt(pix, dims);
  if (centre.w == 0.0) { return vec4f(1.0); }        // sky - nothing to occlude
  let P = centre.xyz;
  let axial = -P.z;

  let fade = smoothstep(ssao.params1.y, ssao.params1.z, axial);
  if (fade >= 1.0) { return vec4f(1.0); }

  let N = viewNormalAt(pix, dims, P);

  let radius = ssao.params0.x;
  let bias = ssao.params0.y;
  // Projected kernel radius in HALF-RES pixels: world metres * (pixels per
  // metre at this depth). proj[1][1] = 1/tan(fovY/2); half-res height is half
  // the depth buffer's.
  let halfH = f32(dims.y) * 0.5;
  let radiusPx = clamp(radius * frame.proj[1][1] * halfH * 0.5 / max(axial, 1e-3),
                       SSAO_MIN_RADIUS_PX, SSAO_MAX_RADIUS_PX);

  // Blue noise, already golden-ratio stepped per frame (frame.wgsl) - the
  // spiral phase decorrelates neighbours and TAA integrates the sequence.
  let noise = blueNoise(vec2u(halfPix));

  var occ = 0.0;
  for (var i = 0u; i < u32(SSAO_SAMPLES); i++) {
    let t = (f32(i) + 0.5) / f32(SSAO_SAMPLES);
    let ang = 6.2831853 * (t * SSAO_SPIRAL_TURNS + noise);
    let r = radiusPx * sqrt(t);
    let offs = vec2f(cos(ang), sin(ang)) * r;
    // Tap coordinates are half-res; the depth fetch is the matching full-res
    // texel, same 2x mapping as the centre.
    let tapPix = (halfPix + vec2i(offs)) * 2;
    let S = viewPosAt(tapPix, dims);
    if (S.w == 0.0) { continue; }                    // tap fell on sky
    let v = S.xyz - P;
    let dl = length(v);
    if (dl < 1e-4) { continue; }
    // Alchemy-style horizon term: how far above the tangent plane the tap
    // sits, times a quadratic range falloff so occluders count fully at
    // contact and not at all past the radius. A tap FAR in front of the
    // surface (a fish over the seabed) scores near zero twice: its direction
    // is off-normal and its distance is past the falloff.
    let fall = saturate(1.0 - dl / radius);
    occ += saturate(dot(N, v) / dl - bias) * fall * fall;
  }

  // Normalised to the tap count; x2 because the mean unoccluded horizon term
  // over a hemisphere is ~0.5, so a fully-buried sample can actually reach 1.
  let raw = saturate(1.0 - ssao.params0.z * occ * (2.0 / f32(SSAO_SAMPLES)));
  let ao = pow(raw, ssao.params0.w);
  return vec4f(mix(ao, 1.0, fade));
}

// ---------------------------------------------------------------------------
// 2. Depth-aware 3x3 blur, still half-res
// ---------------------------------------------------------------------------

/// Relative-depth tolerance of the blur and upsample weights. 5% of the
/// centre's own range: tight enough that a kelp blade does not average with
/// the seabed 10 m behind it, loose enough that a slope's own texels count.
const SSAO_DEPTH_TOL : f32 = 0.05;

fn axialAt(pix: vec2i, dims: vec2i) -> f32 {
  let z = textureLoad(depthTex, clamp(pix, vec2i(0), dims - 1), 0);
  // near/ndc.z is exact under this projection (see debugReadDepth); 1e9 for
  // "no geometry" so the weight against any real surface goes to zero.
  if (z <= 0.0) { return 1e9; }
  return frame.camPlanes.x / z;
}

@fragment
fn fs_ssao_blur(in: FSOut) -> @location(0) vec4f {
  let dims = vec2i(textureDimensions(depthTex, 0));
  let halfDims = vec2i(textureDimensions(aoInput, 0));
  let halfPix = vec2i(in.pos.xy);

  let a0 = axialAt(halfPix * 2, dims);
  if (a0 >= 1e8) { return vec4f(1.0); }

  var sum = 0.0;
  var wsum = 0.0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let hp = clamp(halfPix + vec2i(dx, dy), vec2i(0), halfDims - 1);
      let ai = axialAt(hp * 2, dims);
      let w = exp(-abs(ai - a0) / (a0 * SSAO_DEPTH_TOL + 1e-3));
      sum += textureLoad(aoInput, hp, 0).r * w;
      wsum += w;
    }
  }
  return vec4f(sum / max(wsum, 1e-4));
}

// ---------------------------------------------------------------------------
// 3. Full-res edge-aware upsample, applied through the gate
// ---------------------------------------------------------------------------

/// The output is a MULTIPLIER, not a colour: passes/ssao.js binds this with
/// Blend.multiply (src * dst), so sceneColor never has to be copied to be
/// read. At SSAO_STRENGTH = 0 the pass never runs; if it did, the multiplier
/// is exactly 1.0 and float multiplication by 1.0 is exact, so the bisect
/// holds either way.
@fragment
fn fs_ssao_apply(in: FSOut) -> @location(0) vec4f {
  let dims = vec2i(textureDimensions(depthTex, 0));
  let halfDims = vec2i(textureDimensions(aoInput, 0));
  let pix = vec2i(in.pos.xy);

  let z0 = textureLoad(depthTex, clamp(pix, vec2i(0), dims - 1), 0);
  if (z0 <= 0.0) { return vec4f(1.0); }              // sky / clouds
  let a0 = frame.camPlanes.x / z0;

  // Bilinear-plus-depth upsample over the 2x2 half-res neighbourhood. Each
  // candidate's depth is read at the SAME full-res texel the AO pass sampled
  // (2x its half-res coordinate), so the weight compares like with like.
  let hpf = in.uv * vec2f(halfDims) - 0.5;
  let base = vec2i(floor(hpf));
  let f = fract(hpf);
  let bil = vec4f((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y),
                  (1.0 - f.x) * f.y,         f.x * f.y);

  var ao = 0.0;
  var wsum = 0.0;
  var nearest = 1.0;
  var nearestDiff = 1e30;
  for (var i = 0; i < 4; i++) {
    let hp = clamp(base + vec2i(i & 1, i >> 1), vec2i(0), halfDims - 1);
    let ai = axialAt(hp * 2, dims);
    let diff = abs(ai - a0);
    let w = bil[i] * exp(-diff / (a0 * SSAO_DEPTH_TOL + 1e-3));
    let v = textureLoad(aoInput, hp, 0).r;
    ao += v * w;
    wsum += w;
    if (diff < nearestDiff) { nearestDiff = diff; nearest = v; }
  }
  // All four half-res parents belong to other surfaces (a one-pixel sliver):
  // take the depth-nearest one rather than a meaningless blend.
  let aoUp = select(nearest, ao / wsum, wsum > 1e-3);

  let gate = textureLoad(gateTex, clamp(pix, vec2i(0), dims - 1), 0).r;
  let m = 1.0 - ssao.params1.x * gate * (1.0 - aoUp);
  return vec4f(m, m, m, 1.0);
}
