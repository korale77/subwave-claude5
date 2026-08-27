// SUBWAVE - cascaded sun shadows.
//
// REVERSE-Z THROUGHOUT. Each cascade is an orthographic projection whose near
// plane faces the light, so cascade NDC z is 1 at the light and 0 at the far
// end of the ortho range, and the comparison sampler runs `compare: 'greater'`:
// a receiver is LIT when its own depth is greater than the recorded blocker's.
// Every bias therefore ADDS to the reference depth (pushing the receiver
// toward the light), which is the opposite sign to a conventional depth buffer.
//
// The receiver knows only two things about how the CPU fitted the cascades,
// and the shadow pass must honour both:
//
//   1. cascade i covers view distances out to
//        CASCADE_SPLIT_i * frame.camPlanes.y
//      where the fractions below mirror RENDER.SHADOW_SPLITS in constants.js.
//   2. shadowMatrices[i] maps CAMERA-RELATIVE world space directly to that
//      cascade's clip space.
//
// Nothing else is uniform-fed. Texel world size and the NDC-per-metre depth
// scale are recovered from the matrix itself, so re-fitting a cascade (which
// happens whenever the camera moves half a texel, or crosses the waterline and
// the cascades are refitted to a shorter distance) can never desynchronise the
// receiver from the caster.

#pragma once

#include "frame.wgsl"
#include "math.wgsl"
#include "water.wgsl"

// Fractions of frame.camPlanes.y (the shadow far distance). Mirrors
// RENDER.SHADOW_SPLITS. The table always has four entries; a tier running
// fewer cascades drops the NEAREST splits (see cascadeSplitFraction), which
// keeps the trailing 1.0 so the last cascade always reaches the far distance.
const CASCADE_SPLIT_0 : f32 = 0.06;
const CASCADE_SPLIT_1 : f32 = 0.16;
const CASCADE_SPLIT_2 : f32 = 0.38;
const CASCADE_SPLIT_3 : f32 = 1.00;
const CASCADE_SPLIT_COUNT : u32 = 4u;

/// Fraction of a cascade's range spent cross-fading into the next one.
const SHADOW_CASCADE_BLEND : f32 = 0.08;

/// Normal-offset strength in texels of the receiving cascade.
const SHADOW_NORMAL_OFFSET_TEXELS : f32 = 1.7;

/// Constant receiver bias in cascade NDC depth. Mirrors RENDER.SHADOW_DEPTH_BIAS.
///
/// Its world-space size is this number times the cascade's ortho depth range,
/// which render/shadows.js fits as 2R + SHADOW_CASTER_EXTRUSION + 1. MEASURED on
/// the four-cascade fit this build produces at fov 62 deg, aspect 2.2145
/// (R = 36.8 / 98.1 / 233.0 / 613.2 m):
///
///   cascade   depth range    constant bias    that cascade's texel
///      0         334.6 m         6.0 cm             3.6 cm
///      1         456.2 m         8.2 cm             9.6 cm
///      2         727.0 m        13.1 cm            22.8 cm
///      3        1487.4 m        26.8 cm            60.0 cm
///
/// So it is 1.7 texels in cascade 0 and under half a texel everywhere beyond,
/// which is exactly the scaling peter-panning wants: the near cascade, where the
/// eye can see a contact shadow, pays the smallest world-space offset.
const SHADOW_DEPTH_BIAS_NDC : f32 = 0.00018;

/// Slope scale for the texel-sized receiver bias. Mirrors RENDER.SHADOW_SLOPE_BIAS.
const SHADOW_SLOPE_BIAS : f32 = 2.4;

/// Vogel spiral increment (the golden angle, 2*PI / phi^2).
const VOGEL_GOLDEN_ANGLE : f32 = 2.39996323;

// ---------------------------------------------------------------------------
// Caster side
// ---------------------------------------------------------------------------

/// Clip position of a caster vertex in cascade `cascade`.
///
/// This lives beside the receiver, in the same file, on purpose: the caster MUST
/// use the exact matrix the receiver will sample. If a caster ever transformed
/// with a matrix of its own the shadow would detach from the geometry, and the
/// two would drift silently because nothing downstream can tell a displaced
/// shadow from a badly biased one.
///
/// `worldPos` is CAMERA-RELATIVE, like every other position in this renderer -
/// the CPU folded frame.worldOrigin into the matrix when it fitted the cascade.
///
/// The projection is orthographic, so clip.w is 1 and no divide is needed; the
/// rasteriser still does it, and 1.0 is exactly what sampleShadowPCF's
/// `clip.w <= 0` early-out tests for.
fn shadowCasterClip(worldPos: vec3f, cascade: u32) -> vec4f {
  return shadowMatrices[cascade] * vec4f(worldPos, 1.0);
}

// ---------------------------------------------------------------------------
// Cascade selection
// ---------------------------------------------------------------------------

/// Number of cascades actually rendered this frame. frame.counts.y mirrors the
/// SHADOW_CASCADES define, but the min keeps the array indexing in range even
/// if a preset ever ships fewer atlas layers than the shader was built for.
fn shadowCascadeCount() -> u32 {
  return max(min(frame.counts.y, u32(SHADOW_CASCADES)), 1u);
}

fn cascadeSplitFraction(index: u32) -> f32 {
  let k = index + (CASCADE_SPLIT_COUNT - shadowCascadeCount());
  if (k == 0u) { return CASCADE_SPLIT_0; }
  if (k == 1u) { return CASCADE_SPLIT_1; }
  if (k == 2u) { return CASCADE_SPLIT_2; }
  return CASCADE_SPLIT_3;
}

/// View distance at which cascade `index` stops being valid.
fn cascadeFarDistance(index: u32) -> f32 {
  return frame.camPlanes.y * cascadeSplitFraction(index);
}

/// View distance at which cascade `index` starts. Cascades are nested from the
/// camera, so this is only used to size the cross-fade band.
fn cascadeNearDistance(index: u32) -> f32 {
  if (index == 0u) { return 0.0; }
  return cascadeFarDistance(index - 1u);
}

/// Pick the tightest cascade that still contains `viewDepth` (distance along
/// the camera forward axis, metres). Distances past the last split clamp to the
/// last cascade; sampleShadow() fades them out rather than letting them pop.
fn selectCascade(viewDepth: f32) -> u32 {
  let count = shadowCascadeCount();
  for (var i = 0u; i + 1u < count; i++) {
    if (viewDepth < cascadeFarDistance(i)) { return i; }
  }
  return count - 1u;
}

// ---------------------------------------------------------------------------
// Cascade metrics recovered from the matrix
// ---------------------------------------------------------------------------

/// Metres covered by one shadow texel in cascade `cascade`.
///
/// shadowMatrices is column-major, so clip.x = dot(row0, worldPos) + m[3].x
/// with row0 = (m[0].x, m[1].x, m[2].x). For an orthographic fit |row0| is the
/// NDC-x change per metre; NDC spans 2 units across SHADOW_RESOLUTION texels,
/// hence texelWorld = 2 / (|row0| * resolution).
fn cascadeTexelWorldSize(cascade: u32) -> f32 {
  let m = shadowMatrices[cascade];
  let row0 = vec3f(m[0].x, m[1].x, m[2].x);
  return 2.0 / max(length(row0) * f32(SHADOW_RESOLUTION), 1e-6);
}

/// NDC depth change per metre moved along the light direction, for converting a
/// world-space bias into this cascade's depth units.
fn cascadeDepthScale(cascade: u32) -> f32 {
  let m = shadowMatrices[cascade];
  return length(vec3f(m[0].z, m[1].z, m[2].z));
}

// ---------------------------------------------------------------------------
// Bias
// ---------------------------------------------------------------------------

/// Normal-offset bias: move the lookup position off the surface along the
/// shading/geometric normal before projecting into the cascade.
///
///   offset = normal * texelWorldSize * 1.7 * sqrt(1 - NoL^2)
///
/// The sqrt term is sin(theta) between the normal and the light: at normal
/// incidence a texel is flat and no offset is needed, while at grazing
/// incidence a single texel spans a large depth range and self-shadows. Scaling
/// by the cascade's own texel size is what makes one constant work across a
/// 35:1 range of cascade footprints.
fn applyNormalOffset(worldPos: vec3f, normal: vec3f, NoL: f32, cascade: u32) -> vec3f {
  let sinTheta = sqrt(saturate(1.0 - NoL * NoL));
  let offset = cascadeTexelWorldSize(cascade) * SHADOW_NORMAL_OFFSET_TEXELS * sinTheta;
  return worldPos + normal * offset;
}

/// Slope-scaled depth bias in cascade NDC units. The world-space error a single
/// texel can hide is texelWorld * tan(theta), so the bias is expressed in
/// metres first and converted with the cascade's own depth scale.
fn shadowDepthBias(NoL: f32, cascade: u32) -> f32 {
  let cosL = max(NoL, 0.05);
  let tanTheta = min(sqrt(saturate(1.0 - cosL * cosL)) / cosL, 8.0);
  let worldBias = cascadeTexelWorldSize(cascade) * (1.0 + SHADOW_SLOPE_BIAS * tanTheta);
  return worldBias * cascadeDepthScale(cascade) + SHADOW_DEPTH_BIAS_NDC;
}

// ---------------------------------------------------------------------------
// PCF
// ---------------------------------------------------------------------------

/// Vogel disk: `count` points spiralling out with equal-area spacing, rotated
/// by `phi`. sqrt(i/count) is what makes the samples uniform over the disk
/// rather than clumping at the centre.
fn shadowVogelDisk(index: u32, count: u32, phi: f32) -> vec2f {
  let r = sqrt((f32(index) + 0.5) / f32(count));
  let theta = f32(index) * VOGEL_GOLDEN_ANGLE + phi;
  return vec2f(cos(theta), sin(theta)) * r;
}

/// Per-pixel rotation angle for the PCF kernel.
///
/// The shading point is projected to its own pixel rather than taking a
/// fragCoord parameter, so the same function serves fragment shaders, the
/// froxel injection compute pass and anything else that shades a world point.
/// The unjittered matrix is used so the angle does not wobble with the TAA
/// sub-pixel offset.
fn shadowKernelRotation(worldPos: vec3f) -> f32 {
  let clip = frame.viewProjUnjittered * vec4f(worldPos, 1.0);
  let ndc = clip.xy / max(abs(clip.w), 1e-6);
  let pixel = (ndc * vec2f(0.5, -0.5) + vec2f(0.5)) * frame.screen.xy;
  return interleavedGradientNoise(pixel, f32(frameIndex() % 64u)) * TAU;
}

/// Percentage-closer filtering of one cascade.
///
/// A rotated Vogel disk beats a fixed grid for two reasons. A fixed kernel
/// applies the identical quantisation error to every pixel of a shadow edge, so
/// the error is spatially correlated and appears as staircase banding, and the
/// penumbra width is quantised to the tap spacing. Rotating the disk by a
/// per-pixel angle decorrelates neighbouring pixels: the same total error is
/// still there but is now high-frequency noise, which TAA (and the eye)
/// integrate away into a smooth gradient. The Vogel spiral in particular has no
/// preferred axis, so no residual grid direction survives the rotation.
///
/// Returns 1 = fully lit, 0 = fully shadowed.
fn sampleShadowPCF(worldPos: vec3f, normal: vec3f, NoL: f32, cascade: u32) -> f32 {
  let biased = applyNormalOffset(worldPos, normal, NoL, cascade);
  let clip = shadowMatrices[cascade] * vec4f(biased, 1.0);
  if (clip.w <= 0.0) { return 1.0; }

  let ndc = clip.xyz / clip.w;
  let uv = ndc.xy * vec2f(0.5, -0.5) + vec2f(0.5);
  // Outside the cascade footprint, or past its far plane (reverse-Z: z <= 0).
  // Unlit-by-default would put a black slab beyond the last cascade.
  if (ndc.z <= 0.0 || any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return 1.0; }

  let reference = ndc.z + shadowDepthBias(NoL, cascade);

  // Far cascades already cover 30x more world per texel, so they keep a tighter
  // texel radius: the same radius would smear a metres-wide penumbra and leak
  // light under distant cliffs.
  let radiusTexels = select(1.5, 2.5, cascade < 2u);
  let radiusUV = radiusTexels / f32(SHADOW_RESOLUTION);
  let phi = shadowKernelRotation(worldPos);

  var sum = 0.0;
  for (var i = 0u; i < u32(SHADOW_PCF_TAPS); i++) {
    let offset = shadowVogelDisk(i, u32(SHADOW_PCF_TAPS), phi) * radiusUV;
    // Level variant: the gradient-based textureSampleCompare requires uniform
    // control flow, which a cascade-selected, early-returning shadow lookup can
    // never guarantee.
    sum += textureSampleCompareLevel(shadowAtlas, shadowSampler, uv + offset, cascade, reference);
  }
  return sum / f32(SHADOW_PCF_TAPS);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Sun shadow attenuation for a camera-relative world position.
/// `normal` should be the GEOMETRIC normal (normal maps must not steer the
/// offset, or flat ground picks up shadow acne wherever the map tilts away
/// from the light). `viewDepth` is the distance along the camera forward axis.
/// Returns 1 = fully lit, 0 = fully shadowed.
fn sampleShadow(worldPos: vec3f, normal: vec3f, NoL: f32, viewDepth: f32) -> f32 {
  let shadowFar = frame.camPlanes.y;
  if (viewDepth >= shadowFar) { return 1.0; }

  let count = shadowCascadeCount();
  let cascade = selectCascade(viewDepth);
  var shadow = sampleShadowPCF(worldPos, normal, NoL, cascade);

  // Cross-fade the last SHADOW_CASCADE_BLEND of each cascade into its
  // successor. Without this the resolution step between cascades draws a hard
  // arc across the ground exactly where the penumbra width changes. The band is
  // filtered rather than dithered because a dithered seam only resolves when
  // TAA is running, and the low tiers that need cheap shadows are the ones
  // least able to hide the fizz.
  let far = cascadeFarDistance(cascade);
  let band = max((far - cascadeNearDistance(cascade)) * SHADOW_CASCADE_BLEND, 1e-3);
  let t = saturate((viewDepth - (far - band)) / band);
  if (t > 0.0) {
    if (cascade + 1u < count) {
      shadow = mix(shadow, sampleShadowPCF(worldPos, normal, NoL, cascade + 1u), t);
    } else {
      shadow = mix(shadow, 1.0, t);   // fade out at the shadow far distance
    }
  }

  // Underwater the direct beam has been scattered so many times that it arrives
  // from everywhere: a hard shadow at 60 m is physically wrong and reads as a
  // dirty texture. underwaterShadowStrength() is the authored fade.
  let depth = depthAt(worldPos);
  if (depth > 0.0) {
    shadow = mix(1.0, shadow, underwaterShadowStrength(depth));
  }
  return saturate(shadow);
}
