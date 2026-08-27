// SUBWAVE - bloom: threshold, 13-tap Karis downsample, tent upsample.
//
// The 13-tap filter (Jimenez, SIGGRAPH 2014) is used rather than a box or a
// separable Gaussian because it is stable under downsampling: a naive box
// filter at half resolution flickers violently on the ocean's specular
// highlights as they cross pixel boundaries.
//
// FIREFLIES. A single sub-pixel highlight brighter than the rest of the frame
// by three orders of magnitude - which describes every sun glint on a wave -
// becomes a stationary bright dot that pops in and out between frames. The
// prefilter therefore averages the five 2x2 groups with a Karis weight
// 1/(1+luma), which is a partial-luminance-average that suppresses the outlier
// without darkening the genuinely bright region around it. This is applied ONLY
// on the first downsample; applying it further down would eat the bloom itself.

#include "../common/math.wgsl"

struct BloomParams {
  // xy = 1/srcSize, zw = srcSize
  texel  : vec4f,
  // x = threshold, y = soft knee, z = upsample radius (in dst texels), w = 1 if Karis
  knobs  : vec4f,
};

struct ExposureState {
  bins       : array<u32, 256>,
  exposure   : f32,
  ev         : f32,
  avgLum     : f32,
  validPixels: f32,
};

@group(1) @binding(0) var<uniform> bloom : BloomParams;
@group(1) @binding(1) var srcTex : texture_2d<f32>;
@group(1) @binding(2) var srcSampler : sampler;
@group(1) @binding(3) var<storage, read> exposureState : ExposureState;

struct BloomOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
};

/// Local fullscreen triangle. Bloom does not include frame.wgsl - it never
/// needs the camera - so it cannot use the shared fullscreen vertex shader.
@vertex
fn vs_bloom(@builtin(vertex_index) vi: u32) -> BloomOut {
  let x = f32(vi & 2u);
  let y = f32((vi << 1u) & 2u);
  var out: BloomOut;
  out.uv = vec2f(x, y);
  out.pos = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
  return out;
}

fn karisWeight(c: vec3f) -> f32 {
  return 1.0 / (1.0 + luminance(c));
}

/// 13 taps in a "double cross": four inner 2x2 corners plus a 3x3 ring.
fn downsample13(uv: vec2f, texel: vec2f, karis: bool) -> vec3f {
  let a = textureSample(srcTex, srcSampler, uv + texel * vec2f(-2.0,  2.0)).rgb;
  let b = textureSample(srcTex, srcSampler, uv + texel * vec2f( 0.0,  2.0)).rgb;
  let c = textureSample(srcTex, srcSampler, uv + texel * vec2f( 2.0,  2.0)).rgb;
  let d = textureSample(srcTex, srcSampler, uv + texel * vec2f(-2.0,  0.0)).rgb;
  let e = textureSample(srcTex, srcSampler, uv).rgb;
  let f = textureSample(srcTex, srcSampler, uv + texel * vec2f( 2.0,  0.0)).rgb;
  let g = textureSample(srcTex, srcSampler, uv + texel * vec2f(-2.0, -2.0)).rgb;
  let h = textureSample(srcTex, srcSampler, uv + texel * vec2f( 0.0, -2.0)).rgb;
  let i = textureSample(srcTex, srcSampler, uv + texel * vec2f( 2.0, -2.0)).rgb;
  let j = textureSample(srcTex, srcSampler, uv + texel * vec2f(-1.0,  1.0)).rgb;
  let k = textureSample(srcTex, srcSampler, uv + texel * vec2f( 1.0,  1.0)).rgb;
  let l = textureSample(srcTex, srcSampler, uv + texel * vec2f(-1.0, -1.0)).rgb;
  let m = textureSample(srcTex, srcSampler, uv + texel * vec2f( 1.0, -1.0)).rgb;

  // The five overlapping 2x2 groups the 13 taps decompose into.
  let g0 = (j + k + l + m) * 0.25;
  let g1 = (a + b + d + e) * 0.25;
  let g2 = (b + c + e + f) * 0.25;
  let g3 = (d + e + g + h) * 0.25;
  let g4 = (e + f + h + i) * 0.25;

  if (karis) {
    let w0 = karisWeight(g0) * 0.5;
    let w1 = karisWeight(g1) * 0.125;
    let w2 = karisWeight(g2) * 0.125;
    let w3 = karisWeight(g3) * 0.125;
    let w4 = karisWeight(g4) * 0.125;
    let wsum = w0 + w1 + w2 + w3 + w4;
    return (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / max(wsum, 1e-5);
  }
  return g0 * 0.5 + (g1 + g2 + g3 + g4) * 0.125;
}

/// Soft-knee threshold. A hard threshold makes bloom pop on as a value crosses
/// it; the quadratic knee ramps in over a stop either side of the cut.
fn thresholdSoft(c: vec3f, threshold: f32, knee: f32) -> vec3f {
  let br = maxComponent(c);
  let k = max(knee, 1e-4);
  let soft = clamp(br - threshold + k, 0.0, 2.0 * k);
  let contribution = max(soft * soft / (4.0 * k), br - threshold);
  return c * (contribution / max(br, 1e-5));
}

@fragment
fn fs_prefilter(in: BloomOut) -> @location(0) vec4f {
  var c = downsample13(in.uv, bloom.texel.xy, bloom.knobs.w > 0.5);
  // Threshold in EXPOSED units: BLOOM_THRESHOLD is a display-referred number,
  // so it has to be compared after the auto-exposure gain, not before it.
  c *= exposureState.exposure;
  c = thresholdSoft(max(c, vec3f(0.0)), bloom.knobs.x, bloom.knobs.y);
  // Undo the exposure so the chain stays scene-referred and the tonemap can
  // apply exposure exactly once.
  c /= max(exposureState.exposure, 1e-6);
  return vec4f(c, 1.0);
}

@fragment
fn fs_downsample(in: BloomOut) -> @location(0) vec4f {
  return vec4f(downsample13(in.uv, bloom.texel.xy, false), 1.0);
}

/// 3x3 tent. Cheap, and the correct partner to the 13-tap downsample: together
/// they approximate a wide Gaussian with no visible box edges.
@fragment
fn fs_upsample(in: BloomOut) -> @location(0) vec4f {
  let r = bloom.texel.xy * bloom.knobs.z;
  let uv = in.uv;
  var acc = textureSample(srcTex, srcSampler, uv + vec2f(-r.x,  r.y)).rgb;
  acc += textureSample(srcTex, srcSampler, uv + vec2f(0.0,  r.y)).rgb * 2.0;
  acc += textureSample(srcTex, srcSampler, uv + vec2f( r.x,  r.y)).rgb;
  acc += textureSample(srcTex, srcSampler, uv + vec2f(-r.x, 0.0)).rgb * 2.0;
  acc += textureSample(srcTex, srcSampler, uv).rgb * 4.0;
  acc += textureSample(srcTex, srcSampler, uv + vec2f( r.x, 0.0)).rgb * 2.0;
  acc += textureSample(srcTex, srcSampler, uv + vec2f(-r.x, -r.y)).rgb;
  acc += textureSample(srcTex, srcSampler, uv + vec2f(0.0, -r.y)).rgb * 2.0;
  acc += textureSample(srcTex, srcSampler, uv + vec2f( r.x, -r.y)).rgb;
  return vec4f(acc * (1.0 / 16.0), 1.0);
}
