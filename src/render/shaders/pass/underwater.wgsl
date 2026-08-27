// SUBWAVE - the underwater composite.
//
// This pass owns the water medium for the whole frame WHENEVER THE EYE IS UNDER
// THE SURFACE, which is the case it exists for. It reconstructs the world
// position behind each pixel, works out how far the light travelled, and applies
// the transport model from common/water.wgsl once. Doing it here rather than
// per-shader is what guarantees that terrain, the vessel, creatures and the
// ocean surface itself all fade at exactly the same rate - the single most
// common way an underwater renderer looks wrong is several surfaces disagreeing
// about how much water is in front of them.
//
// With the eye in AIR it does not touch the medium at all. It is not even
// scheduled more than a couple of metres above the waterline, and a submerged
// fragment seen from a boat has to be fogged by the shader that drew it or the
// ocean surface refracts an unattenuated seabed through the shallows. That split
// is written down once, in applyViewRayWater() in common/water.wgsl; both halves
// were being run at once and the measurement that caught it is in that comment.
//
// TRUE BLACK BELOW 520 m (verified, not asserted):
//   daylightAtDepth() is pure Beer-Lambert, exp(-Kd * d). For the clearest
//   water in the game (ABYSSAL_VOID, Kd_blue = 0.0182) that is exp(-9.464) =
//   7.75e-5 at 520 m - small, but auto-exposure will happily open up 14 stops
//   and turn it into a grey soup with visible noise. aphoticFactor() closes the
//   window with smoothstep(320, 520, d), and WGSL's smoothstep returns exactly
//   1.0 at and above its upper edge, so every daylight-derived term is
//   identically 0.0 at 520 m and below. What survives from the DAYLIGHT is only
//   the direct transmittance of radiance that other passes produced - lamps,
//   bioluminescence, emissive vents - which is precisely the design intent.
//
//   AND ONE THING THAT IS NOT DAYLIGHT, which this clause claimed to be an
//   exhaustive list of long after it stopped being one. deepKeyInScatter() below
//   opens on the exactly complementary gate `1 - aphoticFactor(camDepth)`, so
//   the two hand over and never overlap: above 319.8 m the key is multiplied by
//   exactly 0.0 and below 520 m the daylight is. Its colour is per water column
//   (RENDER.DEEP_KEY_PALETTE) and its energy is one number for the whole ocean
//   (RENDER.DEEP_KEY_RADIANCE, whose zero still restores this paragraph
//   literally).

#define OCEAN_GROUP 1
#define OCEAN_BINDING 0
#include "../common/ocean.wgsl"
#include "../common/frame.wgsl"
#include "../common/math.wgsl"
#include "../common/water.wgsl"
#include "../common/fullscreen.wgsl"

/// Marine snow layers along the view ray. Six geometrically spaced shells put
/// motes from arm's length out to about 20 m, which is the range over which the
/// eye can actually resolve individual particles: 0.45, 0.97, 2.08, 4.47, 9.62
/// and 20.68 m.
///
/// THIS IS THE CEILING, NOT THE COUNT. How many of the six a given water
/// actually marches is `SnowCharacter.layers` in common/water.wgsl, which is
/// where every other property of a mote now lives as well - albedo, size,
/// spacing, sink, clumping and reach were all compile-time constants here for
/// the life of the project, so density was the only thing that could differ
/// between the reef and the abyss. The shell GEOMETRY stays compile-time
/// because it sets the loop's unrolled shape and the `cover` weighting curve,
/// and both must be indexed against the fixed maximum or shortening the field
/// would also change the near shells' opacity.
const SNOW_LAYERS : i32 = 6;
const SNOW_NEAR : f32 = 0.45;
const SNOW_RATIO : f32 = 2.15;

/// How the lattice spacing grows with range: `cell ~ tk^SNOW_PERSPECTIVE`.
///
/// 1.0 - the shipped value, written as a bare `tk * cellScale` - means the cell
/// is a fixed ANGLE, so every mote in the field subtends the same angle whether
/// it is at 0.45 m or 20.7 m. That is what a lens-dirt overlay looks like, and
/// once the motes became coherent discs it was the remaining reason the field
/// read as bokeh rather than as depth: nothing in it was nearer than anything
/// else. 0.0 would be the physically correct fixed WORLD size, and it is
/// unusable for the opposite reason - the far shells fall below a pixel and come
/// back as the speckle this whole item exists to remove.
///
/// 0.62 splits it. Against the reference shell the near shell's motes come out
/// 1.79x larger in angle and the 9.6 m shell 0.55x, a 4.4:1 near-to-far ratio
/// across the field, with the smallest mote in the fine-water character still
/// 2.6 px of radius. Per-shell screen COVERAGE is untouched by this: the motes
/// per steradian go as (tk/cell)^2 and each one's area as (cell/tk)^2, so the
/// product is `occupancy * radius^2` for any exponent.
const SNOW_PERSPECTIVE : f32 = 0.62;
/// The shell whose mote size SNOW_PERSPECTIVE leaves alone - the third of six,
/// so the redistribution is centred rather than one-sided.
const SNOW_CELL_REF : f32 = 2.08;

/// How much of the deep key a marine-snow mote reflects.
///
/// A mote sitting in a field of mean radiance L receives 4*PI*L and re-radiates
/// albedo*E/PI = 4*albedo*L, so 4.0 is the physically consistent value - and it
/// is far too much here, because the motes sit at 0.45-20 m where the key's own
/// in-scatter has reached only 4-40% of its asymptote, so at 4.0 every mote is
/// brighter than anything behind it and the near field becomes a snowstorm.
/// This is the near-field's share of a light whose whole point is the far field.
///
/// AGAINST THE KEY'S MEAN RADIANCE, NOT ITS VALUE ALONG THE VIEW RAY. The
/// angular weight is mean 1 over the sphere, so the authored radiance IS the
/// field's mean and the mean is what a small ball in it actually integrates.
/// Weighting a mote by the view direction instead would be a stand-in for its
/// own forward-scattering phase function, and at DEEP_KEY_G = 0.75 the weight
/// peaks at 28x - which puts a field of motes 10x brighter than the seabed in
/// front of anyone who looks up at the key.
const SNOW_DEEP_KEY_GAIN : f32 = 0.6;

/// How much of the froxel volume's LOCAL in-scatter rate a mote returns.
///
/// The rate is in radiance per metre and a mote's reflected radiance is not, so
/// this carries a length; the original 9.0 was calibrated against a reference
/// gap of 1 m - see the per-metre correction in marineSnow() for what it used
/// to multiply and why the shells could not share one gain.
/// 2026-08-18 drastic pass: 9.0 -> 3.5. At 9.0 a vessel flood turned the
/// snow field into the brightest thing in every deep frame - the "dust in
/// the headlights" report - and the subject the lamp was pointed at lost the
/// exposure contest to its own beam. 3.5 keeps motes visible in a beam
/// without letting them carry the frame.
const SNOW_LOCAL_GAIN : f32 = 3.5;

/// Whether the froxel increment is read as a RATE (1) or as the raw per-shell
/// integral the shipped build used (0). Its own gate rather than sharing
/// SNOW_CHARACTER's, because the two are independent claims about two
/// different mistakes and each has to be bisectable on its own.
const SNOW_LOCAL_PER_METRE : f32 = 1.0;

/// Half-width of the band around the FLAT sea level in which the waterline is
/// classified per pixel, metres. frame.camWater.w measures against y = 0, so the
/// band has to contain the whole wave excursion or a camera riding a swell crest
/// two metres up is classified by the whole-frame flag and the meniscus strobes
/// exactly when the sea is rough enough to need it. Mirrors WATERLINE_BAND +
/// OceanSim.verticalBound in render/passes/underwater.js.
fn waterlineBand() -> f32 { return 2.0 + 1.6 * ocean.wind.w; }

@group(1) @binding(1) var sceneColorTex : texture_2d<f32>;
@group(1) @binding(2) var sceneDepthTex : texture_depth_2d;
@group(1) @binding(3) var compositeTex  : texture_2d<f32>;
/// Metres of the view ray, in front of this pixel, that lie inside a pressurised
/// volume - the signed sum of hull crossings written by pass/entity.wgsl. Zero
/// over every pixel of every frame that does not contain the station. See
/// FragOut.dryPath there for the encoding and why it is signed.
@group(1) @binding(4) var dryPathTex    : texture_2d<f32>;

// ---------------------------------------------------------------------------
// The deep key
// ---------------------------------------------------------------------------

/// The key's angular weight, MEAN 1 OVER THE SPHERE.
///
/// `4*PI*phaseHG` integrates to exactly 1 over the sphere for any g, and
/// mix(1, w, d) of two mean-1 functions is mean 1 as well - so neither knob
/// changes how much key there is, only where it points. That is the same
/// discipline causticFactor() keeps, and for the same reason: this term covers
/// most of the pixels of a deep frame, so a shape control that also changed
/// energy would drive auto-exposure and be indistinguishable from a brightness
/// control that does not work.
///
/// `cosTheta` is dot(view ray, direction TO the key) - the identical convention
/// waterMediumWeighted() uses for the sun, so looking AT the key is +1.
fn deepKeyWeight(cosTheta: f32) -> f32 {
  let lobe = 4.0 * PI * phaseHG(cosTheta, frame.deepKeyDir.w);
  return mix(1.0, lobe, saturate(frame.deepKeyRadiance.w));
}

/// The key's radiance arriving along a view ray, before any medium.
fn deepKeyAlong(rayDir: vec3f) -> vec3f {
  return frame.deepKeyRadiance.rgb * deepKeyWeight(dot(rayDir, frame.deepKeyDir.xyz));
}

/// The key's in-scatter over `wet` metres of water in front of a pixel.
///
/// `deepKeyRadiance` is authored as the ASYMPTOTIC radiance, so the only thing
/// the medium contributes here is how fast the path gets there: this is the
/// airlight buildup `1 - exp(-sigma_t * s)`, which is exactly the shape
/// waterInScatter()'s `reach` term has once its source is a constant, and it
/// saturates at the authored colour rather than at (sigmaS/sigmaT) times it.
/// See RENDER.DEEP_KEY_RADIANCE for why the albedo is deliberately not in here.
///
/// AND IT IS PER PLACE, which is why nothing in this file has to know that.
/// `frame.deepKeyRadiance.rgb` carries the LOCAL water column's key - one
/// authored chromaticity per water type from RENDER.DEEP_KEY_PALETTE, sprung on
/// the CPU over RENDER.WATER_BLEND_TAU and scaled by the one master magnitude,
/// so it arrives here already resolved. A single global key was measured to be a
/// common-mode term that moved every deep frame into the same histogram cell;
/// the fix is entirely upstream of this line and the shape of it is unchanged.
///
/// PER-CHANNEL sigma_t, and that is the point: in ABYSSAL_VOID red builds up
/// 2.6x faster than blue and saturates at 2.6x less, so the near haze is warmer
/// than the far haze without a second authored colour. It is also what puts
/// aerial perspective on relief that is currently delivered as one flat value -
/// the deep anchors' geometry runs from a 1.5 m minimum to a 562-10,576 m p95
/// with an infFraction of 0.000-0.209, i.e. the far field of those frames is
/// LANDFORM, not empty water.
///
/// The sight density belongs here for the same reason it belongs on every other
/// submerged path: it scales sigma_t and sigma_s together and this term is on
/// the sight path.
fn deepKeyInScatter(rayDir: vec3f, wet: f32) -> vec3f {
  let sigmaT = max(waterSightSigmaT(), vec3f(1e-5));
  return deepKeyAlong(rayDir) * (vec3f(1.0) - exp(-sigmaT * max(wet, 0.0)));
}

// ---------------------------------------------------------------------------
// Marine snow
// ---------------------------------------------------------------------------

/// Particulate along the view ray.
///
/// Each layer is a 3D lattice sampled in ABSOLUTE world space, so the motes
/// parallax against camera motion exactly like real geometry - which is the
/// whole point. A screen-space overlay reads as dirt on the lens the moment the
/// player strafes.
///
/// The lattice spacing grows LINEARLY with distance, so a mote's angular size
/// is the same at every shell and only its concentration falls with range. That
/// gives the eye a few parallax-rich nearby aggregates instead of six equally
/// strong layers that read as a veil pasted over the scenery.
///
/// THE SHELL DISTANCE MUST NOT BE DITHERED PER PIXEL, AND FOR THE LIFE OF THE
/// PROJECT IT WAS. `tk` used to carry `* (1.0 + 0.13 * blueNoise(pix))`, and the
/// lattice coordinate is `q = (camAbs + rayDir*tk) / (tk * cellScale)`, whose
/// derivative is
///
///   dq/dtk = -camAbs / (tk^2 * cellScale)
///
/// - i.e. the dither is amplified by the camera's ABSOLUTE world position over
/// the shell distance squared. At the Boulder Field anchor (|camAbs| = 1817 m,
/// tk = 0.45 m) that factor is 11,400 per metre, so a 13% dither moved the
/// lattice by SIX HUNDRED CELLS between adjacent pixels. Every pixel was an
/// independent point sample of the mote field and no mote was ever a coherent
/// disc; what the frame showed was a frozen 1-px dither pattern (blueNoise is a
/// pure function of pixel coordinate, so TAA could not average it either) whose
/// density happened to track the field.
///
/// MEASURED, over an 800 x 230 crop of pure open water at the Boulder Field
/// anchor - the same crop reports ZERO blobs with the snow density forced to 0,
/// so every blob in it is a mote. With the dither: 517 blobs of MEAN AREA
/// 1.53 px, covering 0.43%. Without it, and with SNOW_PERSPECTIVE: 6 blobs of
/// mean area 339 px (median 397), covering 1.11%. Two hundred times the area per
/// mote. The A/B that identified the mechanism was blunter still - scaling
/// `cellScale` by EIGHT, a pure geometric size knob, moved the mean blob area
/// from 2.35 px to 2.38 px with the dither in, and to 30.3 px with it out. A
/// size knob that changes nothing is a size knob that is not reaching the
/// geometry.
///
/// Nothing replaced it, because the dither was buying nothing. A shell is a
/// SPHERE centred on the eye, so it has no edge anywhere on screen to break up,
/// and `centre` already scatters a mote's radial position over +-0.3 of a cell.
/// A mote is also strictly inside its own cell (radius <= 0.22 against a centre
/// in [0.2, 0.8]), so crossing a cell boundary cannot clip one either.
///
/// `wetStart`/`wetEnd` bound the segment of the ray that is actually WATER. A
/// mote cannot drift through a sealed room, and from outside one it cannot be
/// inside it either, so both ends are needed and not just the far one.
///
/// `ch` is the local water column's particulate character - see
/// snowCharacter() in common/water.wgsl. It is resolved ONCE per pixel by the
/// caller rather than per shell, because it reads only per-frame uniforms.
fn marineSnow(rayDir: vec3f, wetStart: f32, wetEnd: f32, uv: vec2f, density: f32,
              ch: SnowCharacter) -> vec4f {
  var accum = vec3f(0.0);
  var cover = 0.0;
  let camAbs = frame.cameraPos.xyz + frame.worldOrigin.xyz;
  let t0 = currentTime();
  let fwd = max(dot(rayDir, frame.cameraFwd.xyz), 0.05);
  // SEEDED AT wetStart, NOT AT ZERO. `local` below is the volume's increment
  // between two layers, and the volume integrates from the EYE - so the first
  // mote past a window would otherwise be credited with the whole integral
  // across the dry room in front of it and flare.
  var prevVol = select(vec3f(0.0), sampleFroxel(uv, wetStart * fwd).rgb,
                       wetStart > 1e-3);

  // The distance the PREVIOUS froxel tap was taken at, so the volume's
  // increment can be turned into a per-metre rate below.
  var prevT = wetStart;

  var t = SNOW_NEAR;
  for (var k = 0; k < SNOW_LAYERS; k = k + 1) {
    // A shorter field is a real cost saving as well as a look: each shell is a
    // froxel tap and three hashes at full resolution. Placed before the
    // geometry so a clear column pays for none of it.
    if (f32(k) >= ch.layers) { break; }
    let tk = t;
    t = t * SNOW_RATIO;
    if (tk >= wetEnd) { break; }
    if (tk < wetStart) { continue; }

    // Reduces to `tk * ch.cellScale` exactly at SNOW_PERSPECTIVE = 1.
    let cell = ch.cellScale * SNOW_CELL_REF * pow(tk / SNOW_CELL_REF, SNOW_PERSPECTIVE);
    let p = camAbs + rayDir * tk;
    let q = (p + vec3f(0.0, t0 * ch.sink, 0.0)) / cell;
    let id = floor(q);

    // Nearby shells carry the readable particulate. Far shells decay
    // geometrically so they establish depth without flattening the biome.
    let shellWeight = pow(ch.shellDecay, f32(k));

    // A low-frequency world-space cell groups motes into broad, coherent
    // pockets. The empty water between pockets is as important visually as the
    // aggregates: uniform randomness across the screen reads as video noise.
    let pocketId = floor(id / 4.0) + vec3f(f32(k) * 17.3);
    let pocket = 1.65 * smoothstep(0.46, 0.82, hash13(pocketId));
    let occupancy = saturate(density * shellWeight * pocket * ch.occupancy);
    if (hash13(id + vec3f(f32(k) * 91.7)) > occupancy) { continue; }

    let centre = 0.2 + 0.6 * hash33(id + vec3f(f32(k) * 37.0));
    let d = length(fract(q) - centre);
    let sizeJitter = mix(0.58, 1.08, hash13(id + vec3f(43.1)));
    // Against the fixed SNOW_LAYERS, not against ch.layers: the taper is a
    // property of the shell's RANGE, so a column that stops at five shells must
    // still shade its fifth one the way a six-shell column does.
    let rangeSize = mix(1.0, ch.taper, f32(k) / f32(SNOW_LAYERS - 1));
    let radius = ch.radius * sizeJitter * rangeSize;
    let mote = smoothstep(radius, radius * ch.coreFrac, d);
    if (mote <= 0.0) { continue; }

    let dep = max(0.0, seaLevel() - p.y);
    // Local light: the froxel volume's accumulated in-scatter grows along the
    // ray, so its increment between layers is proportional to the illumination
    // actually present at this distance. That is what makes motes flare inside
    // the vessel's headlight cone and vanish outside it, and as of the deep
    // beacon promotion it is no longer a term that is zero everywhere but
    // inside a headlight.
    //
    // PER METRE, NOT PER SHELL, and this is a correction rather than a taste.
    // The shells are GEOMETRICALLY spaced, so the gap they difference runs
    // 0.45 m at the first to 11.06 m at the last: the raw increment credited a
    // 20 m mote with the volume integrated over eleven metres of water and a
    // 0.5 m one with half a metre of it, a 25x range on a quantity that is
    // supposed to say how bright it is HERE. Dividing by the gap makes it the
    // volume's local in-scatter RATE, which is the term proportional to the
    // irradiance a mote actually intercepts. The reference gap is 1 m, so the
    // gain below is unchanged in magnitude and the near shells - the ones a
    // lamp is for - gain about 2x while the last shell loses 11x, which is
    // most of what read as a distant glowing haze rather than as particles.
    let viewDepth = tk * fwd;
    let vol = sampleFroxel(uv, viewDepth).rgb;
    let gap = mix(1.0, max(tk - prevT, 0.05), SNOW_LOCAL_PER_METRE);
    let local = max(vol - prevVol, vec3f(0.0)) / gap;
    prevVol = vol;
    prevT = tk;

    // THE TWO AMBIENTS HAND OVER TO EACH OTHER AND NEVER OVERLAP. Above the
    // window the mote is lit by daylight; below it, by the deep key, on the
    // exactly complementary gate. Before the key existed this term was
    // identically zero below 520 m and a mote was visible only inside a lamp's
    // froxel increment - which is most of why the deep has no near-field depth
    // cue at all.
    let apSnow = aphoticFactor(dep);
    let ambient = ambientAtDepth(dep) * apSnow * 0.35
                + frame.deepKeyRadiance.rgb * (SNOW_DEEP_KEY_GAIN * (1.0 - apSnow));
    let radiance = (ambient + local * SNOW_LOCAL_GAIN) * ch.albedo;
    accum += radiance * waterTransmittance(tk) * mote;
    cover += mote * mix(0.50, 0.28, f32(k) / f32(SNOW_LAYERS - 1));
  }
  return vec4f(accum, saturate(cover));
}

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

@fragment
fn fs_underwater(in: FSOut) -> @location(0) vec4f {
  let pix = vec2i(fsPixelCoord(in.pos));
  let src = textureLoad(sceneColorTex, pix, 0).rgb;
  let ndc = textureLoad(sceneDepthTex, pix, 0);
  let ray = fsViewRay(in.uv);

  // --- how far did the light travel ---------------------------------------
  var dist = frame.camPlanes.w;
  if (ndc > 1e-7) {
    dist = length(worldFromDepth(in.uv, ndc, frame.invViewProj) - frame.cameraPos.xyz);
  }

  // --- and how much of it was actually WATER -------------------------------
  // The dry bubble the player is standing in, or the dry room they are looking
  // into, as a signed sum of hull crossings; see FragOut.dryPath in
  // pass/entity.wgsl. Zero for every pixel that does not contain the station,
  // which is what makes this pass algebraically unchanged everywhere else.
  //
  // Clamped, because a hull with a hole in its inward skin sums NEGATIVE, and
  // "the whole ray is wet" is the safe reading of a broken envelope. That is
  // why tools/test-habitat.mjs section 8 - every interior face inside the
  // envelope - is load-bearing for this encoding and not merely tidy.
  let dryPath = max(textureLoad(dryPathTex, pix, 0).r, 0.0);
  let wetLen  = max(dist - dryPath, 0.0);
  // WHERE the dry part sits is a per-FRAME question, not a per-pixel one:
  // either the eye is inside the bubble and the dry metres are in front, or it
  // is in the water and they are behind the glass. So it is settled by the
  // eye's own flag, exactly as the medium's ownership is.
  let wetStart = select(0.0, dryPath, eyeIsDry());

  // --- air or water for THIS pixel ----------------------------------------
  // Near the waterline the classification has to be per pixel: the camera is
  // genuinely half in and half out, and a whole-frame flag strobes at 60 Hz on
  // a few centimetres of chop. The probe sits 0.35 m down the ray - just past
  // the near plane - and the ocean height there comes from the SAME Gerstner
  // sum the CPU buoyancy query uses, so the meniscus tracks the waves the
  // vessel is actually floating on.
  let camAbs = frame.cameraPos.xyz + frame.worldOrigin.xyz;
  var waterMask = select(0.0, 1.0, isUnderwater());
  var rim = 0.0;
  var uvBend = vec2f(0.0);
  if (abs(frame.camWater.w) < waterlineBand()) {
    let probe = camAbs + ray * 0.35;
    // Eight components, not all 32: the probe is 35 cm from the eye, so only
    // the long waves change the answer across the screen, and this runs at
    // full resolution on every pixel of the frame.
    let h = seaLevel() + oceanGerstnerCount(probe.xz, ocean.timing.x, 8u).disp.y;
    let f = (probe.y - h) / 0.35;
    let edge = f / max(fwidth(f), 1e-5);      // signed distance in pixels
    waterMask = saturate(0.5 - edge);
    // A bright sliver of specular on the meniscus itself, and a refractive
    // bulge on the water side: right at the eye the surface is a thick lens.
    rim = exp(-abs(edge) * 0.7) * 0.35;
    let grad = vec2f(dpdx(f), dpdy(f));
    let gl = max(length(grad), 1e-6);
    let bulge = pow(saturate(1.0 - abs(edge) / 7.0), 1.7);
    uvBend = (grad / gl) * bulge * 14.0 * frame.screen.zw * select(-1.0, 1.0, f < 0.0);
  }

  if (waterMask <= 0.001) {
    return vec4f(src, 1.0);
  }

  var scene = src;
  if (any(uvBend != vec2f(0.0))) {
    let bentUv = clamp(in.uv + uvBend, vec2f(0.0), vec2f(1.0));
    let bp = clamp(vec2i(bentUv * frame.screen.xy), vec2i(0), vec2i(frame.screen.xy) - vec2i(1));
    scene = textureLoad(sceneColorTex, bp, 0).rgb;
  }

  // --- the medium ----------------------------------------------------------
  // ONLY WITH THE EYE UNDER THE SURFACE. Above it the water in front of a
  // submerged fragment has already been applied by the geometry shader that drew
  // it, because this pass is not even scheduled once the camera clears the
  // waterline band and the ocean surface's refraction reads a snapshot taken
  // before this pass runs. See applyViewRayWater() in common/water.wgsl for the
  // full ownership rule and for what doing both cost.
  //
  // Inside the band the camera can be above the flat sea level and still have
  // most of the frame behind a wave, which is what waterMask sorts out per
  // pixel - but ownership is a per-FRAME question, so it is settled by the same
  // isUnderwater() flag the geometry shaders read and the two can never overlap.
  //
  // THE DEPTH THE WATER STARTS AT, not the depth the eye is at. From a dry room
  // the first wet metre is at the pane, which through the commons dome is three
  // metres shallower than the eye; everywhere else wetStart is zero and this is
  // cameraDepth() exactly as before.
  let camDepth = max(0.02, cameraDepth() - ray.y * wetStart);
  var lit = scene;
  // wetLen, not dist: a pixel whose whole ray is inside a pressure hull falls
  // out of every branch below - no medium, no volume, no particulate, no eye
  // vignette - with no special case anywhere for the habitat.
  if (isUnderwater() && wetLen > 0.02) {
    // applyWaterMedium wants the direction the light TRAVELS along the view ray,
    // i.e. away from the eye - the same convention terrain.wgsl and entity.wgsl
    // use when they pass -V. Handing it the eye-ward direction instead negates
    // the phase-function argument, which swaps the forward and backward lobes:
    // swimming toward a low sun would go dark and away from it would glow.
    //
    // The depth handed over is the EYE's, and that is now the whole point: the
    // in-scatter integral carries the exp(-Kd * depth) stratification along the
    // ray itself, so the near water in front of the eye - which is what the
    // exp(-sigma_t t) weight actually selects - is evaluated at the depth it is
    // really at. The midpoint of the path used to stand in for it, and on a
    // pixel with no geometry behind it that midpoint is half the DRAW DISTANCE
    // away; see waterInScatter() for the sawtooth that produced.
    //
    // applyViewRayMedium, not applyWaterMedium: on the frames the froxel volume
    // ran it owns the collimated beam and this must not add it as well. That is
    // the one term that moves, and it moves in exactly one place - see
    // froxelOwnsBeam() and the ownership block at the top of
    // sim/froxel_integrate.wgsl.
    lit = applyViewRayMedium(scene, wetLen, camDepth, ray);
    // Close the daylight window below TRUE_DARK_DEPTH. At ap = 0 this collapses
    // to pure transmittance: no ambient, no in-scatter, no deep tint. Keyed to
    // the eye rather than to a point down the ray, so it is one value for the
    // whole frame and cannot band across it.
    //
    // Over the same WET path applyWaterMedium used, not the geometric one: a ray
    // that leaves the surface stops being attenuated there, and the two branches
    // of this mix have to agree about where that is or the blend darkens what it
    // is only supposed to be draining of daylight.
    // --- enclosure -----------------------------------------------------------
    // frame.caveMedium.x: the eye is inside a carved cave void, as a SPRUNG
    // 0..RENDER.CAVE_ENCLOSURE scalar (main.js springs it on WATER_BLEND_TAU;
    // the knob folds into the spring target CPU-side). The analytic in-scatter
    // above is built from the DAYLIGHT field of an open water column, and the
    // deep key below is the open ocean's asymptotic light - under a rock roof
    // most of both is occluded geometry this composite cannot see. Draining
    // them here through the SAME mix the aphotic gate already owns keeps the
    // medium applied exactly once; the froxel term (the lamps) and the marine
    // snow survive in full, which is the whole difference between "dark" and
    // "off". IT MUST BE THE SPRING AND NOT THE FLAG: the review measured the
    // binary FLAG_IN_CAVE step collapsing the in-scatter mix to 0.15 in ONE
    // FRAME at a 16 m mouth - 85% of the frame's light strobing with the
    // mouth-plane flicker the cave residency defends against with a 6 s
    // timer. The flag still drives the JS consumers (HUD, spawner); this
    // pixel path takes the sprung value. At 0 this is bit-for-bit the
    // pre-cave image.
    let enclosure = clamp(frame.caveMedium.x, 0.0, 1.0);
    let apRaw = aphoticFactor(camDepth);
    let ap = apRaw * (1.0 - enclosure);
    let wet = waterPathLength(wetLen, camDepth, ray.y);
    // The cave sight-chroma neutralisation (frame.caveMedium.y) lives INSIDE
    // waterTransmittance() - see the derivation at its definition in
    // common/water.wgsl. This drained branch, the lamp legs in
    // evalPunctualLights and froxel_inject all take it from that one site.
    lit = mix(scene * waterTransmittance(wet), lit, ap);

    // --- the deep key --------------------------------------------------------
    // AND WHAT THE MIX ABOVE COLLAPSES TO IS NO LONGER NOTHING. Everything it
    // drains is daylight-derived and must still die; what replaces it is a
    // separate authored source that opens on the exactly complementary gate, so
    // the two hand over rather than overlap and no frame above 319.8 m can
    // change by a bit - smoothstep returns exactly 0.0 below its lower edge, so
    // `1 - ap` there is exactly 0.0.
    //
    // Over the SAME wet path, for the same reason the mix above uses it: a ray
    // that leaves the medium stops accumulating there.
    //
    // ADDED, not mixed. It is a source in the water in front of the pixel, so
    // it composites over whatever the surface behind it delivered exactly as
    // the froxel segment below does - and like that term it must survive the
    // aphotic mix rather than be drained by it.
    // (1 - apRaw), not (1 - ap): scaling ap by the enclosure must not OPEN the
    // deep key's complementary gate wider - the key is occluded by the same
    // roof, so it takes the same enclosure factor instead.
    lit += deepKeyInScatter(ray, wet) * (1.0 - apRaw) * (1.0 - enclosure);

    // --- the volume --------------------------------------------------------
    // The collimated sun beam (god rays) and every lamp's in-scatter, marched
    // per froxel against the real sigma_t slant and modulated by the caustic
    // irradiance ratio and the sun cascades. The analytic model above no longer
    // carries the beam at all on these frames, so this is an exchange and not
    // an addition - see froxelOwnsBeam().
    //
    // AFTER the aphotic mix on purpose. The volume's daylight term dies with
    // sigma_t and is already below 1e-5 of the surface value at TRUE_DARK_DEPTH,
    // but its LAMP term must survive to 700 m; folding it into the mix above
    // would drain the headlights along with the daylight.
    //
    // viewDepth, not the radial distance: the froxel slabs are planes normal to
    // the camera forward axis, which is the same convention the snow loop below
    // and every geometry pass use.
    //
    // OVER THE WET SEGMENT ONLY. A single sampleFroxel() is the running integral
    // from the EYE, and the volume's medium test is `depthAt(p) > 0` - true of
    // every froxel inside a room 33 m down - so from the commons it would start
    // several metres of room air too early. froxelSegment() differences two taps;
    // it is exact here because underwater the volume's alpha is exactly 1.0.
    let fwd = max(dot(ray, frame.cameraFwd.xyz), 1e-3);
    lit += froxelSegment(in.uv, wetStart * fwd, (wetStart + wetLen) * fwd);

    // --- particulate -------------------------------------------------------
    // waterBottom.w is the exact sprung authored load. The old turbidity proxy
    // collapsed every multiplier <= 1 to the same value, so pristine brine,
    // clear reef water, and the abyss all received an identical snow field.
    // frame.veilTune.z = RENDER.SNOW_DENSITY_SCALE, the clarity pass's global
    // snow cut; identity 1.0. The per-type snowMultiplier stays in waterBottom.w.
    let density = marineSnowDensity(camDepth) * frame.waterBottom.w
                * max(frame.veilTune.z, 0.0);
    if (density > 0.001) {
      // ...and waterBottom.w is only HOW MUCH. What a mote looks like - size,
      // spacing, sink, clumping, reach and colour - comes from snowCharacter(),
      // which reads the same sprung column plus the phase asymmetry and the
      // biome's own haze chromaticity. Resolved once per pixel: it touches
      // nothing that varies along the ray.
      let snow = marineSnow(ray, wetStart, wetStart + wetLen, in.uv, density,
                            snowCharacter());
      lit = lit * (1.0 - snow.a) + snow.rgb;
    }

  }

  // --- optics of the eye ---------------------------------------------------
  // A radial vignette, and nothing more (its 0.94/0.98 blue shift was deleted
  // by the 2026-08-17 clarity pass - it was a whole-frame desaturating multiply
  // on every underwater pixel). There is still no underwater colour LUT and no
  // display-referred saturation push in this pass; the one chroma term the
  // clarity pass added is scene-referred and energy-preserving
  // (localWaterTint()'s unit-luma sharpen, RENDER.VEIL_CHROMA). If the water
  // looks wrong the coefficients are wrong.
  // Deliberately weak: the LENS pass already applies a cos^4 vignette to the
  // same frame, and the two multiply. At 0.30 against the lens vignette's old
  // full-strength default the corner of every underwater frame sat at ~11% of
  // centre, which is most of what read as a featureless blue tunnel.
  //
  // OUTSIDE the medium branch, and keyed on the EYE rather than on the pixel.
  // It is an optic of the observer, so it belongs to the whole frame or to none
  // of it: applied per pixel it would stop at every window edge, and a 12% step
  // in the frame corner exactly where the lens pass puts its own vignette is a
  // hard line across the glass. A dry eye has air in front of it and gets none.
  if (isUnderwater() && !eyeIsDry()) {
    let r = length(in.uv - vec2f(0.5)) * 1.4142;
    let vig = 1.0 - 0.12 * smoothstep(0.55, 1.05, r);
    // The 2026-08 clarity pass removed the (0.94, 0.98, 1.0) blue shift that
    // rode this vignette: it was a whole-frame desaturating multiply toward
    // blue on every underwater pixel, which is the opposite of the pass's
    // goal. The radial shape survives unchanged.
    lit *= vec3f(vig);
  }

  lit += vec3f(rim) * frame.sunIlluminance.rgb * 0.35;

  return vec4f(mix(src, lit, waterMask), 1.0);
}

/// 1:1 copy back into sceneColor. sceneColor is not COPY_DST, so the round trip
/// has to be a draw rather than a texture copy.
@fragment
fn fs_blit(in: FSOut) -> @location(0) vec4f {
  return textureLoad(compositeTex, vec2i(fsPixelCoord(in.pos)), 0);
}
