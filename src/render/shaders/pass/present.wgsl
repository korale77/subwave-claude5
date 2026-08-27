// SUBWAVE - final blit from the internal render target to the swap chain.
//
// Only used when the post chain is disabled; normally the tonemap pass writes
// the swap chain directly and this never runs. It exists so that a debug view
// or a stripped-down quality tier still produces an image.

#include "../common/fullscreen.wgsl"
#include "../common/math.wgsl"

@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var srcSampler : sampler;

@fragment
fn fs_present(in: FSOut) -> @location(0) vec4f {
  let hdr = textureSample(srcTex, srcSampler, in.uv).rgb;
  // Even in the fallback path we must tonemap: sceneColor is HDR and writing it
  // raw to an 8-bit swap chain clips everything above 1.0 to white.
  let mapped = tonemapAgX(hdr);
  return vec4f(linearToSrgb(mapped), 1.0);
}
