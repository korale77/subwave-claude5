// SUBWAVE - caustics mip chain.
//
// A BOX filter, and it has to be a box filter: E = 1/|det J| is what the
// consumers read, and the box average of E is exactly the mean of E over the
// destination texel, so every level has the SAME mean and the mean-preserving
// contract both consumers rely on survives minification unchanged. Measured
// over levels 0..4 of a 512^2 tile: mean 1.327151 at every level, sd/mean
// 0.725 / 0.717 / 0.692 / 0.615 / 0.446.
//
// It is not only anti-aliasing. The sun is not a point: its disc subtends
// 9.3 mrad, which refracts to 3.47 mrad in seawater and blurs the caustic on
// the seabed by that angle times the depth. A distant or deep seabed is
// minified by roughly the same factor, so the chain reproduces the solar blur
// for free instead of needing a second filter for it.
//
// textureLoad, not a sampler: the source view is a single mip level and the
// four taps are the exact 2x2 quad, so there is nothing for a filter to decide.

struct MipParams { dims : vec4u };   // x = destination width, y = destination height

@group(0) @binding(0) var<uniform> mip : MipParams;
@group(0) @binding(1) var srcTex : texture_2d<f32>;
@group(0) @binding(2) var dstTex : texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn cs_caustics_mip(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= mip.dims.x || gid.y >= mip.dims.y) { return; }
  let s = vec2i(gid.xy) * 2;
  let a = textureLoad(srcTex, s + vec2i(0, 0), 0);
  let b = textureLoad(srcTex, s + vec2i(1, 0), 0);
  let c = textureLoad(srcTex, s + vec2i(0, 1), 0);
  let d = textureLoad(srcTex, s + vec2i(1, 1), 0);
  textureStore(dstTex, vec2u(gid.xy), (a + b + c + d) * 0.25);
}
