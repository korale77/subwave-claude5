// SUBWAVE - lens effects and the final encode to the swap chain.
//
// This is the last pass that touches colour. It takes the display-referred
// linear image the tonemap produced, applies the effects that belong to the
// LENS rather than to the scene, upscales from render resolution to the
// backbuffer, and encodes to sRGB exactly once.
//
// Order matters and is physical: droplets refract first (they sit on the glass,
// in front of everything), then chromatic aberration (the optics behind them),
// then vignette (the aperture), then grain (the sensor).
//
// WATER DROPLETS. When the hull breaks the surface the canopy is sheeted with
// water that beads, runs down under gravity and is dragged aft by airflow.
// Each droplet is a tiny plano-convex lens, so it is drawn as a UV
// displacement rather than as a white blob - a blob reads as dirt, a
// displacement reads as water. They dry over a few seconds; the trail a running
// droplet leaves behind is a weaker, narrower displacement, which is why a
// streak looks like a streak and not like a scratch.

#include "../common/frame.wgsl"
#include "../common/fullscreen.wgsl"
#include "../common/math.wgsl"

struct LensParams {
  // x = chromatic aberration, y = vignette, z = grain, w = wetness 0..1
  amounts : vec4f,
  // x = time (s), y = aspect, z = fine-mist layer weight (0 on tier LOW),
  // w = stress 0..1
  misc    : vec4f,
  // x = airflow drag, y = fall speed, z = droplet scale, w = refraction strength
  drops   : vec4f,
  // x = sharpen strength 0..1, y = 1/width, z = 1/height,
  // w = demo fade to black 0..1 (see the return statement)
  tune    : vec4f,
};

@group(1) @binding(0) var<uniform> lens : LensParams;
@group(1) @binding(1) var srcTex : texture_2d<f32>;

/// Film-grain amplitude at slider 1.0, in 8-bit code values peak-to-peak,
/// applied in DISPLAY-ENCODED space (see the grain block in fs_lens). 4.8 codes
/// is a filmic 400-ASA read at full strength; the 0.25 default lands at 1.2
/// codes, which also happens to dither the 8-bit encode.
const GRAIN_CODES : f32 = 4.8 / 255.0;

/// One layer of beaded water. Returns xy = UV displacement, z = specular mask.
fn dropletLayer(uv: vec2f, cells: f32, seed: f32, t: f32, wetness: f32, drift: vec2f) -> vec3f {
  // Cells are square in SCREEN space, not UV space, or every drop is an ellipse.
  let aspect = lens.misc.y;
  let p = vec2f(uv.x * aspect, uv.y) * cells + vec2f(seed * 17.0, seed * 41.0);
  let base = floor(p);
  var disp = vec2f(0.0);
  var mask = 0.0;

  // 3x3 so a droplet straddling a cell edge is not clipped in half.
  for (var j = -1; j <= 1; j = j + 1) {
    for (var i = -1; i <= 1; i = i + 1) {
      let cell = base + vec2f(f32(i), f32(j));
      let h = hash22(cell + vec2f(seed));
      let h2 = hash22(cell.yx + vec2f(seed * 3.7));

      // Roughly a third of the cells hold a drop at any time, and only the
      // heavier ones run; the rest cling until they dry.
      let exists = step(h.x, 0.34 + 0.4 * wetness);
      let runner = step(h2.x, 0.55);
      // A runner accelerates down its cell and restarts, which is what a bead
      // shedding off a windshield actually does.
      let phase = fract(t * lens.drops.y * (0.4 + 0.9 * h2.y) + h.y);
      let slide = runner * phase * phase * 1.6;

      var centre = cell + vec2f(0.35 + 0.3 * h2.y, 0.25 + 0.5 * h.y);
      centre += vec2f(drift.x * slide, -slide);

      let radius = (0.10 + 0.22 * h2.y) * lens.drops.z * wetness * exists;
      let d = p - centre;
      let r = length(d);

      // The bead itself: a spherical cap, so the displacement is the surface
      // gradient and peaks at the rim rather than the middle.
      let inside = saturate(1.0 - r / max(radius, 1e-4));
      let cap = sqrt(max(inside, 0.0));
      let n = select(vec2f(0.0), d / max(r, 1e-4), r > 1e-4);
      disp += n * cap * (1.0 - inside * 0.35) * step(r, radius) * lens.drops.w;
      mask = max(mask, cap * step(r, radius));

      // The trail: narrow, above the bead, and only where it has actually run.
      let tw = radius * 0.30;
      let alongY = centre.y - (p.y);
      let inTrail = step(0.0, alongY) * step(alongY, slide * 1.05) * step(abs(d.x), tw);
      let trail = inTrail * (1.0 - saturate(alongY / max(slide, 1e-4))) * runner * exists;
      disp += vec2f(sign(d.x) * trail * 0.35, 0.0) * lens.drops.w;
      mask = max(mask, trail * 0.4);
    }
  }
  // Back to UV space; the x axis was stretched by the aspect above.
  return vec3f(disp.x / (cells * lens.misc.y), disp.y / cells, mask);
}

/// RCAS-style contrast-adaptive sharpen, 5 taps on the cross.
///
/// A TAA resolve is a 1-pixel box in disguise: even perfectly converged and with
/// zero motion it is down to 0.900 of contrast at half-Nyquist and 0.637 at
/// Nyquist, which is the "blurry" every TAA renderer sharpens back and which this
/// one never did - a grep for sharpen/rcas/cas/unsharp across the whole project
/// returned nothing.
///
/// The local min/max limiter is what makes this safe to run before the CA taps
/// and after the tonemap: the sharpened value can never leave the range its own
/// four neighbours already span, so it cannot ring on an edge, cannot manufacture
/// a halo, and cannot resurrect a firefly that TAA just spent its budget removing.
fn sharpen(uv: vec2f, strength: f32) -> vec3f {
  let px = vec2f(lens.tune.y, 0.0);
  let py = vec2f(0.0, lens.tune.z);
  let e = textureSample(srcTex, linearClampSampler, uv).rgb;
  if (strength <= 0.001) { return e; }
  let b = textureSample(srcTex, linearClampSampler, uv - py).rgb;
  let d = textureSample(srcTex, linearClampSampler, uv - px).rgb;
  let f = textureSample(srcTex, linearClampSampler, uv + px).rgb;
  let h = textureSample(srcTex, linearClampSampler, uv + py).rgb;

  let mn = min(min(min(b, d), min(f, h)), e);
  let mx = max(max(max(b, d), max(f, h)), e);
  // Adaptive: full sharpening where there is headroom on both sides, none where
  // the neighbourhood is already at the top of the range. Per channel, because a
  // luma-only amplitude over-sharpens saturated blue - which is most of this game.
  let amp = sqrt(saturate(min(mn, max(vec3f(2.0) - mx, vec3f(0.0))) / max(mx, vec3f(1e-4))));
  let w = -amp * (strength * 0.25);
  return max((b + d + f + h) * w + e, vec3f(0.0)) / max(1.0 + 4.0 * w, vec3f(1e-4));
}

@fragment
fn fs_lens(in: FSOut) -> @location(0) vec4f {
  var uv = in.uv;
  let centred = (uv - vec2f(0.5)) * vec2f(lens.misc.y, 1.0);
  let r2 = dot(centred, centred);

  // --- droplets -------------------------------------------------------------
  var dropMask = 0.0;
  let wetness = lens.amounts.w;
  if (wetness > 0.002) {
    // Airflow drags the beads aft; the vessel's own speed is the drag term.
    let drift = vec2f(-clamp(frame.prevCameraPos.w * lens.drops.x, -1.5, 1.5), 0.0);
    let big = dropletLayer(uv, 9.0, 1.0, lens.misc.x, wetness, drift);
    uv += big.xy;
    dropMask = big.z;
    // The second, finer layer is the expensive half of the effect and the
    // least visible; the lowest tier drops it entirely. The branch is on a
    // uniform, so the whole draw takes one side or the other.
    if (lens.misc.z > 0.5) {
      let fine = dropletLayer(uv, 26.0, 7.0, lens.misc.x, wetness * 0.7, drift * 0.4);
      uv += fine.xy * 0.45;
      dropMask = max(dropMask, fine.z * 0.5);
    }
  }

  // --- chromatic aberration -------------------------------------------------
  // Transverse CA: the displacement is radial and grows with r^2, which is what
  // a real lens does. A fixed per-channel offset looks like a misaligned panel.
  //
  // The AMPLITUDE is the part that was wrong. r2 reaches 1.37 at the corner of a
  // 2.11:1 frame, and the old literals (0.0016 + 0.0090*r2) put 5.9 px of R-to-B
  // separation at x=1490 and 8.4 px at the corner. Any feature thinner than that
  // gets rendered three times in three pure primaries - which is exactly what the
  // shore grass did. CA_CENTRE/CA_EDGE hold it to ~1.1 px at the corner at full
  // slider, sub-pixel everywhere else.
  let ca = lens.amounts.x * (CA_CENTRE + CA_EDGE * r2);
  let dir = centred / max(sqrt(r2), 1e-4) * vec2f(1.0 / lens.misc.y, 1.0);
  // Sharpen once at the base position and carry the correction onto the two
  // displaced channel taps. With CA now bounded to ~1 px at the corner the offset
  // is sub-pixel over the whole frame, so the sharpening delta is the same there
  // to well within a code value - and this costs 7 taps instead of the 15 a
  // per-channel sharpen would.
  let sharpened = sharpen(uv, lens.tune.x);
  let plain = textureSample(srcTex, linearClampSampler, uv).rgb;
  let delta = sharpened - plain;
  var color = vec3f(
    textureSample(srcTex, linearClampSampler, uv + dir * ca).r,
    plain.g,
    textureSample(srcTex, linearClampSampler, uv - dir * ca).b) + delta;

  // A bead is a lens: it concentrates light, so it reads slightly brighter and
  // slightly cooler than what is behind it.
  color = mix(color, color * vec3f(0.94, 1.02, 1.10) + vec3f(0.012), dropMask * 0.55);

  // --- vignette -------------------------------------------------------------
  // Cos^4 falloff, the natural one, rather than a painted-on oval.
  //
  // It runs AFTER the exposure histogram meters, so auto-exposure cannot and does
  // not compensate for it - whatever this removes is removed from the delivered
  // image. At full strength that is 48.4% of every frame's light, and on the
  // smooth gradients underwater it was measured to be 91% of all the visible
  // structure in the frame. The default strength lives in settings.js and is low
  // on purpose; raise the SLIDER for a stronger look, never VIGNETTE_FALLOFF.
  let cos4 = 1.0 / (1.0 + r2 * VIGNETTE_FALLOFF);
  let vig = mix(1.0, pow(cos4, VIGNETTE_POWER), saturate(lens.amounts.y));
  color *= vig;

  // Under stress the periphery reddens and closes in. Physiological, not UI:
  // this is the character's vision, which is why it lives in the lens pass.
  let stress = lens.misc.w;
  if (stress > 0.001) {
    let edge = saturate(r2 * 1.6 - 0.15) * stress;
    color = mix(color, vec3f(luminance(color)) * vec3f(0.85, 0.10, 0.08), edge * 0.75);
  }

  // --- encode, then grain ---------------------------------------------------
  // GRAIN IS ADDED IN DISPLAY-ENCODED SPACE, AFTER the sRGB transfer, and its
  // amplitude is quoted in 8-bit CODE VALUES. This is not a stylistic choice,
  // it is the only place it can go.
  //
  // Adding a fixed amplitude to the display-referred LINEAR image (which is
  // what this pass used to do) makes the visible grain a function of how steep
  // the transfer curve is at that pixel, and the sRGB curve's slope near black
  // is 12.92 - two orders of magnitude steeper than at white. A +-0.011 linear
  // perturbation is a third of a code value on a bright beach and swings from
  // code 0 to code 34 in 120 m of water. Measured on the shipped
  // `underwater-deep` scenario: 8.36 code values of high-frequency deviation in
  // the darkest quartile of the frame, which read as a fixed crosshatch because
  // the blue-noise tile is 64x64 and the pattern was strong enough to see the
  // tile repeat. Encoding first makes the grain perceptually uniform, so one
  // number describes it everywhere.
  var encoded = linearToSrgb(max(color, vec3f(0.0)));

  // Blue noise, not white: white grain is what TAA spends its whole budget
  // trying to remove, and blue noise reads as film rather than as static. The
  // shadow weighting survives - real sensor noise IS worse in the shadows -
  // but as a mild perceptual tilt rather than as a transfer-curve accident.
  let n = blueNoise(fsPixelCoord(in.pos)) - 0.5;
  let shadowWeight = 1.0 - saturate(luminance(encoded) * 1.6);
  encoded += vec3f(n * lens.amounts.z * GRAIN_CODES * (0.55 + 0.45 * shadowWeight));

  // Quantisation dither, always on and independent of the grain slider. The
  // swap chain is 8 bit and the deep is a very long, very smooth blue gradient:
  // without a dither it bands into visible contours. Exactly one code value
  // peak-to-peak from a decorrelated tap of the same tile, which is the textbook
  // amount - enough to break the contour, too little to see.
  let dn = blueNoise(fsPixelCoord(in.pos) + vec2u(31u, 17u)) - 0.5;
  encoded += vec3f(dn * (1.0 / 255.0));

  // The showcase demo's cross-segment fade. It was a full-screen DOM overlay
  // until the recorder landed, and a canvas capture stream cannot see DOM - a
  // recorded run hard-cut at every segment boundary while the live view faded.
  // It multiplies the DISPLAY CODE VALUE, after the encode and after the grain
  // and the dither, because that is what a CSS overlay of black at opacity a
  // did: browser compositing is in sRGB space, so doing it here preserves the
  // look rather than reinterpreting it, and it fades the film grain out with
  // the picture instead of leaving it crawling over black. Being the last
  // operation of the last pass, it is downstream of the exposure histogram and
  // of the TAA resolve, so a fade to black can neither drag auto-exposure nor
  // enter the temporal history. Rests at exactly 0 whenever the demo is idle.
  return vec4f(encoded * (1.0 - saturate(lens.tune.w)), 1.0);
}
