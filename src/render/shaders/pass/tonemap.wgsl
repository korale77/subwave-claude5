// SUBWAVE - exposure, bloom composite, depth-band grade, AgX tonemap.
//
// AgX rather than ACES. ACES' RRT rotates saturated blues toward magenta as
// they brighten - the notorious "purple sky" - and this game is a saturated
// blue from the second minute to the last. AgX desaturates toward white on the
// way up instead, which is what a real sensor does and what the deep needs.
//
// The grade is a function of DEPTH, evaluated continuously between the keys in
// DEPTH_BANDS rather than switched at the boundaries. Descending is a slow
// colour death: gain drains the red channel first (which is exactly what the
// water's Kd does physically), saturation falls, and the black point lifts
// toward the water's own deep tint so that "black" underwater is never neutral.
//
// Output is DISPLAY-REFERRED LINEAR, not sRGB. The lens pass does the encode,
// because chromatic aberration and droplet refraction must resample a linear
// image or their edges pick up a gamma-shifted fringe.

#include "../common/frame.wgsl"
#include "../common/fullscreen.wgsl"
#include "../common/math.wgsl"

struct GradeParams {
  // rgb = lift (added after tonemap), w = contrast pivot strength
  lift  : vec4f,
  // rgb = linear gain, w = saturation
  gain  : vec4f,
  // rgb = per-channel gamma applied in display space, w = bloom intensity
  gamma : vec4f,
  // x = AgX look power, y = AgX look saturation, zw = unused
  look  : vec4f,
};

struct ExposureState {
  bins       : array<u32, 256>,
  exposure   : f32,
  ev         : f32,
  avgLum     : f32,
  validPixels: f32,
};

@group(1) @binding(0) var<uniform> grade : GradeParams;
@group(1) @binding(1) var srcTex : texture_2d<f32>;
@group(1) @binding(2) var bloomTex : texture_2d<f32>;
@group(1) @binding(3) var<storage, read> exposureState : ExposureState;

fn saturation(c: vec3f, s: f32) -> vec3f {
  return max(mix(vec3f(luminance(c)), c, s), vec3f(0.0));
}

@fragment
fn fs_tonemap(in: FSOut) -> @location(0) vec4f {
  var hdr = max(textureSample(srcTex, linearClampSampler, in.uv).rgb, vec3f(0.0));

  // Bloom is scene-referred, so it is added before exposure - a bright thing
  // must bloom by the same amount whether or not the eye has adapted to it.
  // The chain already holds only the thresholded excess, so this is an add
  // rather than a blend; blending would darken everything that does not bloom.
  hdr += textureSample(bloomTex, linearClampSampler, in.uv).rgb * max(grade.gamma.w, 0.0);

  // Exposure. The player's EV compensation is already folded into
  // exposureState.exposure by the adaptation pass, so that the bloom threshold
  // and this tonemap agree about what "one stop over" means; re-applying it
  // here would double every stop of compensation.
  hdr *= exposureState.exposure;

  // Scene-referred grade: channel gain and saturation. Doing this before the
  // tonemap keeps the tonemap's own desaturation-on-the-shoulder intact.
  hdr *= grade.gain.rgb;
  hdr = saturation(hdr, grade.gain.w);

  // AgX WITHOUT its EOTF, so what follows is a display CODE value. The grade has
  // to run here: `lift` means "raise black this far up the display range" and the
  // contrast S-curve pivots on 0.5, and neither statement is true of a linear
  // signal. The EOTF is applied last, immediately before returning.
  var mapped = agxEncode(hdr, grade.look.x, grade.look.y);

  // Display-referred grade: lift the black point toward the water's colour and
  // apply the per-channel gamma that drains red with depth.
  mapped = mapped + grade.lift.rgb * (1.0 - mapped);
  mapped = pow(max(mapped, vec3f(0.0)), grade.gamma.rgb);

  // Contrast about 0.5, S-curve, strength in lift.w.
  let contrasted = mapped + (mapped - vec3f(0.5)) * grade.lift.w *
    (vec3f(1.0) - abs(mapped - vec3f(0.5)) * 2.0);
  mapped = max(contrasted, vec3f(0.0));

  // EOTF LAST. Everything above is a code value; lens.wgsl encodes to sRGB
  // exactly once, so without this the image is gamma-decoded twice and 18% grey
  // lands at code 187 instead of 128.
  return vec4f(pow(mapped, vec3f(2.2)), 1.0);
}
