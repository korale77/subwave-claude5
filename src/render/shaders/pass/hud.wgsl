// SUBWAVE - HUD composite onto the windshield glass.
//
// The HUD texture is a flat Canvas2D raster. Everything that makes it read as
// LIGHT PROJECTED ONTO A CURVED CANOPY rather than a sticker on the monitor
// happens here, and all of it is geometric rather than decorative:
//
//   1. Canopy curvature. The image is remapped through a mild anisotropic
//      barrel distortion about a centre slightly above the screen centre,
//      because the pilot's eye sits below the canopy apex. Horizontal wrap is
//      stronger than vertical - that is the shape of a bubble canopy.
//   2. Head parallax. The virtual image is collimated at a finite distance, so
//      when the pilot's head lags the hull the whole image slides. The slide is
//      weighted by r^2 so the boresight stays put and the edges swim, which is
//      what a real reflector sight does.
//   3. Edge chromatic fringing. A combiner glass is a dielectric stack; its
//      dispersion grows with incidence angle, so the fringe is a function of
//      r^2 and vanishes on axis.
//   4. Instrument glow reflected in the glass. The instruments below the
//      glareshield reflect off the inside of the canopy, mirrored about the
//      coaming line, blurred, smeared upward and masked to the upper canopy.
//      This single term is what makes the cockpit feel enclosed.
//
// The pass writes premultiplied alpha over the already-tonemapped swap chain.
// The HUD is emissive UI and must never be tonemapped with the scene.

#include "../common/fullscreen.wgsl"
#include "../common/math.wgsl"

struct HudParams {
  // xy = head parallax in UV, z = canopy k1, w = canopy k2
  parallax : vec4f,
  // x = fringe strength, y = glass reflection gain, z = emissive gain,
  // w = master opacity (1 normally; the demo's fade to black drives it)
  optics   : vec4f,
  // x = time (s), y = aspect, z = mask mode (0 canopy, 1 dive mask), w = projector flicker
  mode     : vec4f,
  // x = scanline strength, y = coaming line (uv.y), z = stress, w = boot 0..1
  glass    : vec4f,
};

@group(1) @binding(0) var<uniform> hud : HudParams;
@group(1) @binding(1) var hudTex : texture_2d<f32>;
@group(1) @binding(2) var hudSampler : sampler;

/// Optical centre of the canopy in UV. Above screen centre: the eye is low.
const CANOPY_CENTRE : vec2f = vec2f(0.5, 0.455);
/// Vertical stretch < 1 makes the canopy wrap harder left-right than up-down.
const CANOPY_ANISO : f32 = 0.72;

struct Warp {
  uv : vec2f,
  radial : vec2f,   // aspect-corrected offset from the optical centre
  r2 : f32,
};

/// Aspect-corrected radial coordinate plus the curvature + parallax remap.
fn canopyWarp(uv: vec2f) -> Warp {
  var d = uv - CANOPY_CENTRE;
  d.x *= hud.mode.y;
  let e = vec2f(d.x, d.y * CANOPY_ANISO);
  let r2 = dot(e, e);
  let k = 1.0 + hud.parallax.z * r2 + hud.parallax.w * r2 * r2;

  var warped = d * k;
  warped.x /= hud.mode.y;

  var out: Warp;
  // Parallax grows toward the edge: the boresight is the one place on a
  // collimated display that must not move when the pilot's head does.
  out.uv = CANOPY_CENTRE + warped + hud.parallax.xy * (0.30 + 0.70 * saturate(r2 * 4.0));
  out.radial = d;
  out.r2 = r2;
  return out;
}

/// Two incommensurate sinusoids: a cheap, non-crawling smudge/wipe pattern for
/// the glass. A hash would sparkle under the HUD's own sub-pixel motion.
fn glassSmudge(uv: vec2f) -> f32 {
  let a = sin(uv.x * 23.0 + uv.y * 7.0) * 0.5 + 0.5;
  let b = sin(uv.x * 9.7 - uv.y * 15.3 + 1.7) * 0.5 + 0.5;
  return mix(0.55, 1.0, a * 0.6 + b * 0.4);
}

/**
 * Reflection of the instrument glow in the canopy. The instruments live in the
 * lower part of the frame; their light bounces off the inside of the glass and
 * appears mirrored about the coaming, smeared vertically by the glass thickness
 * and heavily blurred because the reflection is off-focus.
 */
fn glassReflection(uv: vec2f) -> vec3f {
  let mirrorY = hud.glass.y;
  let base = vec2f(uv.x, mirrorY * 2.0 - uv.y);
  // Masked rather than early-returned: textureSample below must stay in
  // uniform control flow or its derivatives are undefined.
  let valid = step(-0.2, base.y) * step(base.y, 1.2);

  var acc = vec3f(0.0);
  var wsum = 0.0;
  // Seven taps along a vertical smear with a slight horizontal spread; the
  // reflection of a bright horizontal instrument is a vertical streak.
  for (var i = 0; i < 7; i = i + 1) {
    let t = (f32(i) - 3.0) / 3.0;
    let o = vec2f(t * 0.010, t * 0.026 - 0.004);
    let w = 1.0 - abs(t) * 0.7;
    let s = textureSample(hudTex, hudSampler, base + o);
    acc += s.rgb * s.a * w;
    wsum += w;
  }
  acc /= max(wsum, 1e-4);

  // Only the upper canopy carries the reflection, and it fades where the glass
  // is nearly edge-on to the eye.
  let height = smoothstep(0.62, 0.02, uv.y);
  return acc * height * glassSmudge(uv) * valid;
}

@fragment
fn fs_hud(in: FSOut) -> @location(0) vec4f {
  let w = canopyWarp(in.uv);

  // Sample each primary through its own dispersion offset. The offsets are
  // along the radial direction, which is what a real dispersive combiner does -
  // a fixed xy offset would look like a broken TV instead.
  let fringe = hud.optics.x * w.r2;
  var radial = w.radial;
  radial.x /= hud.mode.y;
  let sR = textureSample(hudTex, hudSampler, w.uv + radial * fringe);
  let sG = textureSample(hudTex, hudSampler, w.uv);
  let sB = textureSample(hudTex, hudSampler, w.uv - radial * fringe);

  var rgb = vec3f(sR.r, sG.g, sB.b);
  var a = (sR.a + sG.a + sB.a) * 0.3333333;

  // Sampling outside the source must not wrap the compass ribbon around to the
  // depth tape; the sampler clamps, so kill anything the warp pushed off-image.
  let inside = step(0.0, w.uv.x) * step(w.uv.x, 1.0) * step(0.0, w.uv.y) * step(w.uv.y, 1.0);
  a *= inside;
  rgb *= inside;

  // Under extreme stress the instruments desaturate: the periphery of human
  // colour vision fails first under hypoxia and g-load. DESIGN/04 4.3.9 calls
  // for 25% at 1.20x the hull rating, which is what glass.z carries.
  rgb = mix(rgb, vec3f(luminance(rgb)), hud.glass.z * 0.25);

  // The HUD is drawn in sRGB-encoded instrument colours; the swap chain at this
  // point is already sRGB-encoded scene, so no conversion belongs here. Only the
  // emissive gain from the luminance adaptation applies.
  var gain = hud.optics.z * hud.mode.w;

  // Cold-boot wipe: a bright scan line sweeps down as the projector strikes.
  let boot = hud.glass.w;
  if (boot < 1.0) {
    let sweep = boot * 1.25;
    let band = 1.0 - saturate(abs(in.uv.y - sweep) * 26.0);
    a *= saturate((sweep - in.uv.y) * 8.0 + 0.15);
    gain *= 1.0 + band * 2.5;
  }

  // Projector raster. Extremely subtle - one part in eight - and disabled on the
  // dive mask, which is a printed display rather than a projection. The period
  // is one OUTPUT pixel, not one render pixel: this pass runs after the lens
  // upscale, so frame.screen would give the raster the wrong pitch whenever the
  // render scale is not 1.
  let scan = 1.0 - hud.glass.x * (1.0 - hud.mode.z) *
    (0.5 + 0.5 * sin(in.uv.y * frame.outputSize.y * PI)) * 0.125;
  gain *= scan;

  let outA = saturate(a) * hud.optics.w;
  var outRGB = rgb * gain * outA;

  // Additive: the reflection is light added to the glass, not a layer over it,
  // so it must not contribute to alpha. It DOES have to obey the master
  // opacity, which it did not until the demo's fade started driving optics.w:
  // additive light is unaffected by a destination alpha, so a fully faded HUD
  // kept a glass reflection glowing over the black cut.
  outRGB += glassReflection(in.uv) * hud.optics.y * hud.optics.z * hud.optics.w;

  return vec4f(outRGB, outA);
}
