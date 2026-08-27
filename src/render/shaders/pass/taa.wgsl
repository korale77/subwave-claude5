// SUBWAVE - temporal anti-aliasing.
//
// Camera already applies the Halton(2,3) jitter to frame.proj, so this pass only
// has to resolve. The three things that make or break a TAA in this game:
//
//   1. YCoCg NEIGHBOURHOOD CLIPPING. Clamping in RGB clamps each channel
//      independently, which desaturates every edge between two saturated
//      colours - and this game is a saturated blue with amber instruments in
//      front of it. YCoCg separates luma from chroma so the clip happens along
//      the axis the eye actually notices. We CLIP the history toward the
//      current sample rather than CLAMP it: clamping snaps the history to the
//      face of the box and leaves a bright rim on every silhouette.
//
//   2. DILATED VELOCITY. The velocity is taken from whichever pixel of the 3x3
//      neighbourhood is nearest the camera. Without this, the one-pixel border
//      around a moving object reprojects with the background's velocity, and
//      the vessel drags a ghost.
//
//   3. VARIANCE-BASED BOX SIZE. The clip box is the neighbourhood mean plus or
//      minus a multiple of the standard deviation, intersected with the true
//      min/max. On the ocean surface, whose specular detail is genuinely
//      high-variance, that box is wide enough not to reject valid history but
//      tight enough that the surface does not smear into a mirror.
//
// History is fetched with a bicubic Catmull-Rom rather than bilinear: bilinear
// re-filters the history every frame and the image is visibly soft after a
// dozen frames of motion.

#include "../common/frame.wgsl"
#include "../common/fullscreen.wgsl"
#include "../common/math.wgsl"

struct TaaParams {
  // x = feedbackMin, y = feedbackMax, z = variance gamma, w = velocity scale
  tune  : vec4f,
  // xy = 1/renderSize, zw = renderSize
  texel : vec4f,
};

@group(1) @binding(0) var<uniform> taa : TaaParams;
@group(1) @binding(1) var colorTex : texture_2d<f32>;
@group(1) @binding(2) var historyTex : texture_2d<f32>;
@group(1) @binding(3) var velocityTex : texture_2d<f32>;
@group(1) @binding(4) var depthTex : texture_depth_2d;

fn rgbToYCoCg(c: vec3f) -> vec3f {
  return vec3f(
    0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
    0.5 * c.r - 0.5 * c.b,
    -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}

fn yCoCgToRgb(c: vec3f) -> vec3f {
  let t = c.x - c.z;
  return vec3f(t + c.y, c.x + c.z, t - c.y);
}

/// Tonemap-for-averaging (Karis). Blending in a range-compressed space stops a
/// single very bright sample from dominating the temporal average and flashing.
fn compress(c: vec3f) -> vec3f { return c / (1.0 + max(c.x, max(c.y, c.z))); }
/// The 1e-5 floor bounds the reconstruction at 1e5, which is above the 65504
/// ceiling of the rgba16float history buffer - so the storage format clips
/// before the inverse does, and the transform is exact everywhere it matters.
fn decompress(c: vec3f) -> vec3f { return c / max(1.0 - max(c.x, max(c.y, c.z)), 1e-5); }

/// Clip the history to the AABB along the segment toward the current colour.
fn clipToAABB(history: vec3f, current: vec3f, boxMin: vec3f, boxMax: vec3f) -> vec3f {
  let centre = 0.5 * (boxMax + boxMin);
  let extent = max(0.5 * (boxMax - boxMin), vec3f(1e-5));
  let offset = history - centre;
  let unit = offset / extent;
  let maxUnit = max(abs(unit.x), max(abs(unit.y), abs(unit.z)));
  if (maxUnit > 1.0) {
    return centre + offset / maxUnit;
  }
  return history;
}

/// Catmull-Rom in 9 bilinear fetches instead of 16 point fetches: the middle
/// pair of taps in each axis is folded into one hardware-filtered sample at the
/// weighted offset, which is exact for a separable kernel.
fn sampleHistoryCatmullRom(uv: vec2f, texel: vec2f, size: vec2f) -> vec3f {
  let samplePos = uv * size;
  let texPos1 = floor(samplePos - 0.5) + 0.5;
  let f = samplePos - texPos1;

  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);

  let w12 = w1 + w2;
  let offset12 = w2 / max(w12, vec2f(1e-5));

  let texPos0 = (texPos1 - 1.0) * texel;
  let texPos3 = (texPos1 + 2.0) * texel;
  let texPos12 = (texPos1 + offset12) * texel;

  var result = vec3f(0.0);
  result += textureSampleLevel(historyTex, linearClampSampler, vec2f(texPos0.x, texPos0.y), 0.0).rgb * w0.x * w0.y;
  result += textureSampleLevel(historyTex, linearClampSampler, vec2f(texPos12.x, texPos0.y), 0.0).rgb * w12.x * w0.y;
  result += textureSampleLevel(historyTex, linearClampSampler, vec2f(texPos3.x, texPos0.y), 0.0).rgb * w3.x * w0.y;
  result += textureSampleLevel(historyTex, linearClampSampler, vec2f(texPos0.x, texPos12.y), 0.0).rgb * w0.x * w12.y;
  result += textureSampleLevel(historyTex, linearClampSampler, vec2f(texPos12.x, texPos12.y), 0.0).rgb * w12.x * w12.y;
  result += textureSampleLevel(historyTex, linearClampSampler, vec2f(texPos3.x, texPos12.y), 0.0).rgb * w3.x * w12.y;
  result += textureSampleLevel(historyTex, linearClampSampler, vec2f(texPos0.x, texPos3.y), 0.0).rgb * w0.x * w3.y;
  result += textureSampleLevel(historyTex, linearClampSampler, vec2f(texPos12.x, texPos3.y), 0.0).rgb * w12.x * w3.y;
  result += textureSampleLevel(historyTex, linearClampSampler, vec2f(texPos3.x, texPos3.y), 0.0).rgb * w3.x * w3.y;
  return max(result, vec3f(0.0));
}

@fragment
fn fs_taa(in: FSOut) -> @location(0) vec4f {
  let size = taa.texel.zw;
  let texel = taa.texel.xy;
  let pixel = vec2i(in.pos.xy);
  let maxCoord = vec2i(size) - vec2i(1);

  // --- neighbourhood + dilated velocity ------------------------------------
  var mean = vec3f(0.0);
  var meanSq = vec3f(0.0);
  var boxMin = vec3f(1e30);
  var boxMax = vec3f(-1e30);
  // Reverse-Z: the CLOSEST fragment has the LARGEST depth value.
  var closestDepth = -1.0;
  var closestOffset = vec2i(0, 0);

  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      let o = vec2i(x, y);
      let c = clamp(pixel + o, vec2i(0), maxCoord);
      let s = rgbToYCoCg(compress(max(textureLoad(colorTex, c, 0).rgb, vec3f(0.0))));
      mean += s;
      meanSq += s * s;
      boxMin = min(boxMin, s);
      boxMax = max(boxMax, s);
      let d = textureLoad(depthTex, c, 0);
      if (d > closestDepth) {
        closestDepth = d;
        closestOffset = o;
      }
    }
  }
  mean /= 9.0;
  meanSq /= 9.0;
  let sigma = sqrt(max(meanSq - mean * mean, vec3f(0.0)));
  let gamma = taa.tune.z;
  // Intersect the variance box with the true min/max so a genuinely uniform
  // neighbourhood does not get an artificially wide tolerance.
  let clipMin = max(mean - sigma * gamma, boxMin);
  let clipMax = min(mean + sigma * gamma, boxMax);

  let velCoord = clamp(pixel + closestOffset, vec2i(0), maxCoord);
  let velocity = textureLoad(velocityTex, velCoord, 0).rg * taa.tune.w;

  let current = max(textureLoad(colorTex, pixel, 0).rgb, vec3f(0.0));
  let currentC = compress(current);
  let currentY = rgbToYCoCg(currentC);

  // --- history -------------------------------------------------------------
  let historyUV = in.uv - velocity;
  let offscreen = any(historyUV < vec2f(0.0)) || any(historyUV > vec2f(1.0));

  var history = sampleHistoryCatmullRom(historyUV, texel, size);
  var historyC = rgbToYCoCg(compress(history));
  historyC = clipToAABB(historyC, currentY, clipMin, clipMax);

  // --- feedback ------------------------------------------------------------
  // Fast motion gets less history: the reprojection is least trustworthy
  // exactly when the screen is moving, and the eye is least able to see
  // aliasing then anyway.
  let velPixels = length(velocity * size);
  var feedback = mix(taa.tune.y, taa.tune.x, saturate(velPixels / 32.0));

  // Luminance-difference weighting (Lottes): where the history and the current
  // frame disagree strongly in luma, trust the current frame more. This is what
  // stops the vessel from ghosting against a bright surface.
  let lumaDiff = abs(historyC.x - currentY.x);
  feedback *= 1.0 - saturate(lumaDiff * 4.0) * 0.5;

  if (offscreen) { feedback = 0.0; }

  let resolvedC = mix(currentC, yCoCgToRgb(historyC), feedback);
  let resolved = decompress(max(resolvedC, vec3f(0.0)));
  // Clamp to the history target's own ceiling: an Inf written into the history
  // poisons every subsequent frame's neighbourhood statistics.
  return vec4f(clamp(resolved, vec3f(0.0), vec3f(65504.0)), 1.0);
}
