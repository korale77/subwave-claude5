// SUBWAVE - terrain.
//
// One draw per chunk. The vertex stream carries chunk-LOCAL xz, ABSOLUTE y, the
// baked normal, chunk uv, and two 4-byte material payloads the biome baker
// produced on the CPU. Everything below a metre is synthesised here.
//
// WHY THE MATERIAL IS HALF-BAKED. The biome classifier is a fourteen-way scored
// vote over depth, slope and radius with a noise-jittered input. Evaluating it
// per pixel would cost more than the lighting; evaluating it per vertex and
// interpolating the RESULT (albedo, roughness, rockiness, sediment) is exact
// wherever that field is smooth, which it is by construction, and it costs four
// interpolators. What the fragment stage adds is the part that must NOT be
// interpolated: the metre-and-below structure, which is procedural, triplanar,
// and identical on both sides of every chunk seam because it is a pure function
// of absolute world position.
//
// GEOLOGY CHECKLIST, because "no obvious tiling, no plastic sheen, visible
// strata, wet darkening near the waterline" is the acceptance criterion:
//   - four uncorrelated frequency bands per material, no ratio a small
//     integer, so nothing beats against anything into a visible grid
//   - strata are a function of world Y, folded in XZ, so bedding planes run
//     level across a whole cliff the way real sediment does
//   - rock and sediment interlock through heightBlend(), never a lerp
//   - roughness has a 0.42 floor, and the wet band raises reflectance by
//     LOWERING roughness rather than by adding a specular multiplier
//   - the shading normal is perturbed by the surface gradient of the same
//     height channel that drove the albedo, so light and colour agree about
//     where the bumps are
//
// TWO HEIGHT CHANNELS, NOT ONE. Every substrate reports its structure twice:
// `height` in [0,1], which is what heightBlend() interlocks the layers on and
// what modulates the albedo, and `relief` in METRES, which is what the shading
// normal is derived from. They are not interchangeable. A [0,1] channel throws
// away the one thing the normal needs - how far the surface actually moves - so
// a 3 cm sand ripple and a 14 m boulder swell hand the bump code identical
// gradients and the only way to make either look right is a global fudge factor
// that makes the other look wrong. In metres there is no fudge factor:
// perturbNormal() is called with scale 1.0 and the tilt it produces is the real
// arctangent of the real slope.
//
// DETAIL BAND TABLE. Every band is faded out by pixel footprint, not distance,
// so the fade is correct at grazing incidence too (see bandGain() in
// triplanar.wgsl). The distances quoted are for a FACE-ON surface at the
// default 75 degree vertical FOV over a 765 px-tall target, where one pixel
// spans about d/500 metres; on ground raked by the view they arrive far sooner,
// which is exactly the case that used to alias.
//
//   band            feature   relief   full to   gone by
//   macro chroma    233 m       -        -        -           never fades
//   macro value      71 m       -        -        -           never fades
//   sand bedform     12 m     0.22 m   1.5 km    3.0 km
//   sand ripple      0.55 m   0.030 m    69 m    137 m
//   sand grain       0.18 m   0.008 m    22 m     45 m
//   rock coarse      6.9 m    1.30 m    860 m     1.7 km
//   rock strata hue  6.4 m      -        -        -           never fades
//   rock strata form 3.2 m    0.30 m    400 m    800 m
//   rock bed risers  1.07 m     -       133 m    267 m
//   rock sub-bedding 1.63 m   0.070 m   204 m    408 m
//   rock mid         1.7 m    0.30 m    212 m    425 m
//   rock joints      0.70 m   0.11 m     87 m    175 m
//   rock fine        0.45 m   0.035 m    56 m    112 m
//
// The three macro bands - the two albedo fields and sand bedform - are the ONLY
// thing breaking the surface up past a hundred metres, and without them mid and
// long range terrain collapses back to flat interpolated vertex colour, so they
// are deliberately given feature sizes an order of magnitude larger than
// anything else here and do not reach their fade until the far edge of the draw
// distance, or at all.
//
// THE STRATA ARE FILTERED IN THREE PIECES, not one, because they are three
// different signals. The HUE band never fades - a bedding sequence is what a
// distant cliff IS - and it can afford not to, because its two end members are
// equal-luminance (1.0005) so at four pixels per bed it averages to one tone
// instead of to a set of rings. The bedded FORM - the differential-erosion
// staircase, which reaches the picture through dpdx() of a relief in metres -
// is a derivative, so it has to go a full octave earlier than the band itself:
// a one-pixel finite difference of a 6.4 m period is a faithful gradient at
// eight pixels per bed and moire at four. And the RISERS inside each bed are a
// 1.07 m harmonic that terrace() emits no matter how soft it is told to be, so
// they are crossfaded back to the sine they came from before they go sub-pixel.

#include "../common/frame.wgsl"
#include "../common/math.wgsl"
#include "../common/noise.wgsl"
#include "../common/brdf.wgsl"
#include "../common/shadow.wgsl"
#include "../common/water.wgsl"
#include "../common/lighting.wgsl"
#include "../common/triplanar.wgsl"

// ---------------------------------------------------------------------------
// Per-draw
// ---------------------------------------------------------------------------

struct ChunkUniform {
  /// xyz = chunk origin in CAMERA-RELATIVE space (the CPU has already
  /// subtracted frame.worldOrigin.xz), w = chunk footprint in metres.
  origin : vec4f,
  /// x = LOD index, y = metres between samples, zw = reserved.
  params : vec4f,
};

@group(1) @binding(0) var<uniform> chunk : ChunkUniform;

#ifdef CAVE_MOUTHS
/// Cave-mouth suppression discs - the MASKED pipeline variant only.
///
/// A heightfield has one surface per column, so the terrain mesh has no way to
/// carry the hole a cave mouth carves through the seabed: the volumetric field
/// (world/caves.js) opens it, the cave pass draws the shaft, and this pass
/// would roof it over. The fix is DESIGN/02 8.7's surface suppression, cut to
/// the shipped mouth shape: mouths are vertical capsules, so their surface
/// breaches are discs, and the fragment stage discards inside them. Only the
/// chunks whose footprint intersects a disc take this pipeline - `discard`
/// disables early-Z for every draw of the pipeline that contains it, so the
/// masked variant exists precisely to keep that cost off the other ~800 draws
/// (same reasoning as the design's masked batch).
///
/// Each disc is (x, z, surfaceY, radius) in ABSOLUTE metres. The y test keeps
/// the discard away from the chunk SKIRTS: a skirt is a vertical curtain up to
/// 64 m deep at the chunk border, and a disc near one would otherwise punch a
/// see-through slot in it far below the mouth it belongs to.
struct CaveMouths {
  /// x = live disc count, yzw unused.
  count : vec4f,
  discs : array<vec4f, 16>,
};
@group(1) @binding(1) var<uniform> mouths : CaveMouths;
#endif

struct VSOut {
  /// Clip space out of the vertex stage, FRAMEBUFFER PIXELS into the fragment
  /// stage - which is what the clustered light lookup wants for its tile index.
  @builtin(position) pos : vec4f,
  @location(0) worldPos  : vec3f,   // camera-relative
  @location(1) normal    : vec3f,
  @location(2) uv        : vec2f,
  @location(3) material  : vec4f,   // rgb = sqrt(albedo), a = roughness
  @location(4) surface   : vec4f,   // sediment, rockiness, ao, blended macroStyle
  @location(5) curClip   : vec4f,   // UNJITTERED clip position, this frame
  @location(6) prevClip  : vec4f,   // UNJITTERED clip position, last frame
};

@vertex
fn vs_terrain(
  @location(0) localPos : vec3f,
  @location(1) normal   : vec3f,
  @location(2) uv       : vec2f,
  @location(3) material : vec4f,
  @location(4) surface  : vec4f,
) -> VSOut {
  var out : VSOut;

  // localPos.xz is 0..128 and localPos.y is the ABSOLUTE height. Rebasing here,
  // rather than shipping absolute vertex positions, is what keeps float32
  // exact: neither operand ever exceeds a few thousand and the sum is small.
  let p = vec3f(chunk.origin.x + localPos.x,
                localPos.y - frame.worldOrigin.y,
                chunk.origin.z + localPos.z);

  out.worldPos = p;
  out.normal = normal;
  out.uv = uv;
  out.material = material;
  out.surface = surface;

  out.pos = frame.viewProj * vec4f(p, 1.0);
  // Terrain is static: last frame's world position is this same point, and the
  // only thing that moved is the camera. Both of these are UNJITTERED, which is
  // why the fragment stage needs no jitter correction on the motion vector.
  out.curClip = frame.viewProjUnjittered * vec4f(p, 1.0);
  out.prevClip = frame.prevViewProj * vec4f(p, 1.0);
  return out;
}

/// Shadow caster. Depth only - there is NO fragment stage on the caster
/// pipeline, and nothing here alpha-tests, so the whole cost is this transform
/// plus the 12 bytes of position fetched out of the 40-byte vertex.
///
/// The rebase MUST be identical to vs_terrain's, character for character, or the
/// shadow lands somewhere other than the geometry that cast it. `chunk.params.z`
/// carries the cascade index - it was already declared reserved and the CPU
/// already wrote 0 there, so ChunkUniform does not change size.
@vertex
fn vs_terrain_shadow(@location(0) localPos : vec3f) -> @builtin(position) vec4f {
  let p = vec3f(chunk.origin.x + localPos.x,
                localPos.y - frame.worldOrigin.y,
                chunk.origin.z + localPos.z);
  return shadowCasterClip(p, u32(chunk.params.z));
}

// ---------------------------------------------------------------------------
// Procedural substrate
// ---------------------------------------------------------------------------

// Frequencies in tiles per metre. Deliberately non-harmonic - no ratio here is
// a small integer - so the bands never phase-lock into a visible grid.
const ROCK_COARSE   : f32 = 0.0730;
const ROCK_MID      : f32 = 0.2910;
const ROCK_FINE     : f32 = 1.1300;
const SAND_BEDFORM  : f32 = 0.0410;
const SAND_RIPPLE   : f32 = 0.6100;
const SAND_GRAIN    : f32 = 2.7000;
/// Joint cells averaged 2.7 m across at the old 0.37 and read as crazy paving
/// on a hillside. Real cooling joints in basalt are a metre or so.
const FRACTURE_CELL : f32 = 0.7100;

/// The feature size each band is filtered against, metres. See the band table
/// at the top of the file - these are middle-octave wavelengths, not the band's
/// base period, because an fbm's top octave must not be allowed to strip the
/// whole band three times too early.
const FEAT_ROCK_COARSE : f32 = 6.90;
const FEAT_ROCK_MID    : f32 = 1.70;
const FEAT_ROCK_FINE   : f32 = 0.45;
const FEAT_JOINT       : f32 = 0.70;
const FEAT_SUBBED      : f32 = 1.63;
const FEAT_SAND_BED    : f32 = 12.0;
const FEAT_SAND_RIPPLE : f32 = 0.55;
const FEAT_SAND_GRAIN  : f32 = 0.18;

/// Relief amplitude of each band, METRES of surface displacement. These are the
/// numbers the shading normal is built from, so they are physical claims: sand
/// ripples really are three centimetres, joints really are a hand's width deep,
/// and the coarse rock swell really is over a metre.
const RELIEF_ROCK_COARSE : f32 = 1.30;
const RELIEF_ROCK_MID    : f32 = 0.30;
const RELIEF_ROCK_FINE   : f32 = 0.035;
const RELIEF_STRATA      : f32 = 0.30;
const RELIEF_SUBBED      : f32 = 0.070;
const RELIEF_JOINT       : f32 = 0.11;
const RELIEF_SAND_BED    : f32 = 0.22;
const RELIEF_SAND_RIPPLE : f32 = 0.030;
const RELIEF_SAND_GRAIN  : f32 = 0.008;

/// Repeat length of the bedded sequence in metres, and how far the whole stack
/// is folded. NOT the thickness of one bed: terrace() puts its transitions at
/// v = 1/6, 1/2 and 5/6, each of which the sine crosses twice, so one period is
/// SIX risers at 0.74 / 1.73 / 0.74 / 0.74 / 1.73 / 0.74 m and the beds average
/// 1.07 m - which is what basalt flows and their partings actually do. (The
/// note here used to say the same thing for the wrong reason, "three steps
/// across each half of the sine"; the count is right, the mechanism is not.)
/// The sub-bedding period is deliberately not a divisor of the major one: two
/// commensurate periods produce a barcode, two incommensurate ones produce a
/// sequence that takes tens of metres to repeat.
const STRATA_PERIOD     : f32 = 6.4;
const STRATA_SUB_PERIOD : f32 = 1.63;
/// Vertical throw of the tectonic fold, metres. 5.5 m is LESS THAN ONE BED over
/// a 161 m field, so the stack came out level to within one bed across a whole
/// kilometre of island and the eye read the beds as concentric contour rings of
/// the cone - the terracing artifact, at its own root. 15 m is 2.3 beds, which
/// is a sequence that visibly dips across a headland.
const STRATA_WARP       : f32 = 15.0;
const STRATA_WARP_FREQ  : f32 = 0.0062;
/// Bed-THICKNESS jitter: a 26 m field in world Y (about four beds) driving
/// 1.8 rad of phase, so the local period wanders between roughly 5.5 and 7.6 m
/// and no two beds in the stack are the same thickness.
///
/// Bounded well under the base phase rate of TAU / 6.4 = 0.982 rad/m so the
/// sequence can never fold back on itself and put two risers in one place: the
/// jitter's own rate is 1.8 * 0.357 * 2PI * 0.0385 = 0.155 rad/m typical, and
/// 0.42 rad/m at a three-sigma spike of the fbm's derivative.
const STRATA_SEQ_FREQ   : f32 = 0.0385;
const STRATA_SEQ_PHASE  : f32 = 1.80;
/// Metres of rise a bedding riser spans, per unit of terrace() softness.
///
/// terrace() confines its transition to `softness / steps` of its input, and
/// the input here is a sine of period STRATA_PERIOD, whose steepest slope is
/// PI / STRATA_PERIOD per metre. So the riser is
/// softness * STRATA_PERIOD / (steps * PI) metres tall - 0.26 m at the 0.38
/// this shader authors the near field with.
///
/// That is the sharpest edge in the whole file, it drives RELIEF_STRATA and so
/// lands in the SHADING NORMAL, and the strata band has no gain fade to hide
/// behind. Below about two pixels per riser it stops being a bedding plane and
/// becomes specular noise crawling over a cliff. Widening the riser with the
/// pixel footprint is the analytic answer: the banding survives to any range
/// because its low frequencies are untouched, and what it converges to is the
/// smooth sine it came from rather than a shimmering staircase.
const STRATA_RISER_METRES : f32 = STRATA_PERIOD / (3.0 * PI);
const STRATA_SOFT_NEAR    : f32 = 0.38;

/// The two MACRO albedo fields, in tiles per metre: 233 m of chroma and 71 m of
/// value. Nothing else in this file lives above 24.4 m and the biome field's own
/// feather is 260-1400 m, so between those two scales the terrain had no albedo
/// variation whatsoever - a real baked LOD-0 chunk on the island flank carries
/// NINE distinct 8-bit albedo triples across 16,641 vertices (luminance cv
/// 0.9%), the lagoon floor forty (cv 2.4%). A 128 m square of island had nine
/// colours in it, and that gap is the whole of why every seabed and beach reads
/// as one flat tone from 25 m out to the horizon.
///
/// Both feature sizes are far above every LOD sample pitch including LOD 6's
/// 64 m, so neither can alias at any range and neither needs a bandGain fade.
const MACRO_FREQ_CHROMA : f32 = 0.0043;
const MACRO_FREQ_VALUE  : f32 = 0.0141;
/// Chroma axis: warm carbonate and oxidised sediment against cool basaltic
/// sand, which is what a real seabed does between 50 and 300 m. Applied as a
/// multiplier on a ZERO-MEAN field, so the surface average is untouched.
///
/// The numbers look large and arrive small. fbmCheap2's RMS is 0.357, so 0.42
/// is 15% RMS of red against 12% of blue - a 12% RMS swing of B/R in the ALBEDO
/// - and the sky's own blue ambient on a 5% rock, plus AgX, take that down to a
/// measured 2% of displayed B/G on the island flank. There is no point being
/// timid at the input end of that chain.
const MACRO_CHROMA : vec3f = vec3f(0.42, 0.11, -0.34);
const MACRO_VALUE  : f32 = 0.30;
/// How much of that a substrate gets. A beach or a reef flat really is close to
/// uniform, so it takes the floor; bare rock and everything below the photic
/// zone takes the whole amount, because past ~90 m the water column has already
/// eaten the hue differences the biome catalogue separates its records by and
/// patchiness is the only variation left that survives (see biomes.js).
const MACRO_MIN : f32 = 0.35;
const MACRO_DEEP_LO : f32 = 60.0;
const MACRO_DEEP_HI : f32 = 140.0;

const SEED_ROCK     : u32 = 0x51a7u;
const SEED_STRATA   : u32 = 0x9c3du;
const SEED_SAND     : u32 = 0x2f18u;
const SEED_FRACTURE : u32 = 0x77e5u;
const SEED_MACRO    : u32 = 0x3b91u;
const SEED_GEOLOGY  : u32 = 0xc4a7u;

/// Two-octave billow on the quick gradient basis, returned ZERO-MEAN so a
/// distance fade converges it to the surface average instead of brightening it.
/// billow2() from noise.wgsl would do the same job through simplex2, which
/// costs six transcendentals per octave - affordable once per vertex, not once
/// per pixel. The 0.34 is the measured mean of the rectified sum.
fn billowCheap2(p: vec2f, seed: u32) -> f32 {
  var n = abs(gradientQuick2(p, seed));
  n += abs(gradientQuick2(p * 2.13, seed + NOISE_OCTAVE_SEED)) * 0.5;
  return saturate(n * 0.90) - 0.34;
}

struct Substrate {
  tint   : vec3f,   // multiplicative modulation of the biome albedo, ~[0.6, 1.4]
  height : f32,     // [0,1], the channel heightBlend() interlocks on
  relief : f32,     // METRES of displacement, the channel the normal comes from
  rough  : f32,     // additive roughness offset
  glint  : f32,     // [0,1] weight for the narrow grain-scale specular lobe
};

/// Smooth triangular selector on the ordered BIOMES[].macroStyle coordinate.
/// Neighbouring families overlap, so a biome blend produces a geological
/// transition rather than a hard material seam or an invented integer biome.
fn stylePulse(style: f32, centre: f32, radius: f32) -> f32 {
  return 1.0 - smoothstep(radius * 0.42, radius, abs(style - centre));
}

struct GeologyMacro {
  tint         : vec3f, // multiplicative albedo, centred near one
  heightOffset : f32,   // signed offset to the height-blend/cavity channel
  relief       : f32,   // metres; feeds the physical surface-gradient normal
  rough        : f32,   // additive perceptual roughness
};

/// Biome-scale geology at 12-36 m, above substrate detail and below landform.
///
/// One cellular evaluation is deliberately shared by carbonate dissolution,
/// kelp-bed pitting, boulder joints and deep stress fractures. The identity
/// comes from different interpretations of the same stable field, plus folded
/// bedding and fluting. This is materially cheaper than evaluating a separate
/// noise stack for every family and guarantees every feature is stationary in
/// absolute world space.
fn geologyMacro(absPos: vec3f, geoN: vec3f, style: f32, foot: f32) -> GeologyMacro {
  let carbonate = stylePulse(style, 0.20, 0.15);
  let kelpStone = stylePulse(style, 0.38, 0.085);
  let blockRock = stylePulse(style, 0.48, 0.085);
  let shelfBeds = stylePulse(style, 0.58, 0.085);
  let spireFlute = stylePulse(style, 0.68, 0.085);
  let terraceBeds = stylePulse(style, 0.79, 0.12);
  let pressure = smoothstep(0.86, 0.97, style);

  // 18 m base cells survive to kilometre-scale views. bandGain removes their
  // relief before it can alias, while their low-frequency chroma may remain.
  let reliefGain = bandGain(12.0, foot);
  let uv = dominantPlaneUV(absPos, geoN, 1.0 / 18.0);
  let warp = fbmCheap2(uv * 0.53 + vec2f(4.7, -2.1), SEED_GEOLOGY);
  let cells = worley2(uv + vec2f(warp * 0.31, -warp * 0.23), SEED_GEOLOGY + 7u, 0.92);

  // Dissolution holes at feature points, broad eroded cell rims, and the
  // narrow borders of larger blocks. All are [0,1].
  let pit = 1.0 - smoothstep(0.10, 0.46, cells.x);
  let eroded = 1.0 - smoothstep(0.30, 0.68, cells.x);
  let border = 1.0 - smoothstep(0.018, 0.105, cells.y - cells.x);

  // Folded beds are a world-Y sequence, so they traverse cliff faces instead
  // of becoming contour decals. Spire flutes run along the dominant face; two
  // oblique stress sets cross rather than forming another polygon lattice.
  let layers = sin((absPos.y + warp * 13.0) * (TAU / 15.5));
  let flute = sin((uv.x + warp * 0.24) * TAU);
  let stressA = abs(sin(dot(uv, vec2f(0.82, 0.57)) * TAU + warp * 0.8));
  let stressB = abs(sin(dot(uv, vec2f(-0.36, 0.93)) * TAU - warp * 0.6));
  let stress = 1.0 - smoothstep(0.035, 0.16, min(stressA, stressB));

  var g : GeologyMacro;
  g.tint = vec3f(1.0);

  // Reef carbonate: warm weathered crowns over cool cyan dissolution holes.
  g.tint *= vec3f(1.0) + (0.30 - pit) * carbonate * vec3f(0.34, 0.18, -0.12);
  // Kelp substrate: dark moss-green pitting, broader and less regular than the
  // carbonate pores. It must remain visible after the green water column.
  g.tint *= vec3f(1.0) + (0.32 - eroded) * kelpStone * vec3f(0.20, 0.36, 0.13);
  // Boulder blocks: cool raised plates divided by dark, sediment-catching seams.
  g.tint *= vec3f(1.0) + (0.18 - border) * blockRock * vec3f(0.22, 0.27, 0.34);
  // Shelf and terrace/canyon beds use different colour axes: golden carbonate
  // ledges at the shelf, iron-violet members farther down.
  g.tint *= vec3f(1.0) + layers * shelfBeds * vec3f(0.25, 0.09, -0.17);
  g.tint *= vec3f(1.0) + layers * terraceBeds * vec3f(0.20, -0.04, 0.18);
  // Rock Spires acquire long cool flutes instead of the same polygon crackle.
  g.tint *= vec3f(1.0) + flute * spireFlute * vec3f(0.08, -0.03, 0.20);
  // Deep pressure fractures carry sparse cold mineral fill. They brighten only
  // the line, leaving most of the wall as black negative space.
  g.tint *= vec3f(1.0) + stress * pressure * vec3f(0.10, 0.27, 0.58);
  g.tint = clamp(g.tint, vec3f(0.48), vec3f(1.58));

  g.heightOffset = (-pit * carbonate * 0.26
                  - eroded * kelpStone * 0.18
                  - border * blockRock * 0.24
                  + layers * shelfBeds * 0.14
                  + flute * spireFlute * 0.16
                  + layers * terraceBeds * 0.12
                  - stress * pressure * 0.22) * reliefGain;
  g.relief = (-pit * carbonate * 0.46
            - eroded * kelpStone * 0.32
            - border * blockRock * 0.38
            + layers * shelfBeds * 0.34
            + flute * spireFlute * 0.52
            + layers * terraceBeds * 0.29
            - stress * pressure * 0.31) * reliefGain;
  g.rough = carbonate * (pit - 0.30) * 0.09
          + kelpStone * eroded * 0.08
          + blockRock * border * 0.11
          + shelfBeds * layers * 0.055
          + pressure * (0.04 - stress * 0.13);
  return g;
}

/// Bare rock: three noise bands, a joint network, and a two-scale bedded stack.
///
/// `slopeTan` is |grad h| = tan(theta), and it gates the strata. That is not an
/// art choice: a bedding plane exposed face-on IS the top of a bed, one uniform
/// lithology from edge to edge, and it shows no banding at all. Banding is what
/// you see where the land surface CUTS ACROSS the stack, which is precisely a
/// steep face. Painting bands onto flat ground is the tell of procedural rock.
fn rockSubstrate(absPos: vec3f, geoN: vec3f, w: vec3f, slopeTan: f32,
                 foot: f32, macroStyle: f32) -> Substrate {
  // Triplanar only for the mid band. It is the one whose features are large
  // enough for a projection seam to show; the coarse band is evaluated in 3D
  // (no projection at all) and the fine band is below the seam's own scale.
  // Each band is kept in RAW and FADED form. The faded one is what the height,
  // relief and tint are built from; the raw one is what the joint lattice is
  // warped by, because a warp that fades with distance would drag every joint
  // sideways as the player walks toward the cliff - a detail fade may remove a
  // feature but it may never move one.
  let midGain = bandGain(FEAT_ROCK_MID, foot);
  let midRaw = fbmCheap2(absPos.zy * ROCK_MID, SEED_ROCK) * w.x
             + fbmCheap2(absPos.xz * ROCK_MID, SEED_ROCK) * w.y
             + fbmCheap2(absPos.xy * ROCK_MID, SEED_ROCK) * w.z;
  let mid = midRaw * midGain;

  let coarseRaw = fbmCheap3(absPos * ROCK_COARSE, SEED_ROCK + 17u);
  let coarse = coarseRaw * bandGain(FEAT_ROCK_COARSE, foot);

  // The fine band is faded out rather than allowed to alias into sparkle.
  let fineGain = bandGain(FEAT_ROCK_FINE, foot);
  var fine = 0.0;
  if (fineGain > 0.004) { fine = fbmCheap3(absPos * ROCK_FINE, SEED_ROCK + 31u) * fineGain; }

  // Bedding planes are a function of world Y, so they stay level across an
  // entire cliff face, with the stack folded by a low-frequency XZ field the
  // way real strata are folded by tectonics. terrace() gives the plates their
  // flat tops and their risers; the sine keeps the sequence periodic without
  // the hard discontinuity a fract() would put through every band boundary.
  //
  // The fold field is 161 m across, an order of magnitude wider than anything
  // else here, so it doubles as the LITHOLOGY field: it decides which part of
  // the island is warm oxidised tuff and which is cool fresh basalt, for free,
  // and everything downstream that belongs to a member - the joints, the
  // bedding, the hue - is gated on it rather than on a field of its own.
  let fold = fbmCheap2(absPos.xz * STRATA_WARP_FREQ, SEED_STRATA);
  let y = absPos.y + fold * STRATA_WARP;
  // BED THICKNESS IS NOT CONSTANT, and a fixed period is half of why the island
  // read as a contour map. A pure sine of period STRATA_PERIOD puts a band at
  // exactly the same world Y everywhere, so every band is a level contour of a
  // cone and the eye joins them into concentric rings.
  //
  // The jitter is a function of Y (and of the fold, so no two headlands get the
  // same sequence), NOT a modulation of the period itself. Writing
  // `y * TAU / period(x, z)` is the obvious way to vary bed thickness and it is
  // wrong: it multiplies the phase by the ELEVATION, so at the island's 200 m
  // summit the fold's 0.013/m gradient becomes 1.05 rad/m of HORIZONTAL phase -
  // a 6 m vertical stripe pattern, a worse artifact than the one being fixed.
  let bedJitter = fbmCheap2(vec2f(y * STRATA_SEQ_FREQ, fold * 4.0), SEED_STRATA + 5u);
  let bedSine = 0.5 + 0.5 * sin(y * (TAU / STRATA_PERIOD) + bedJitter * STRATA_SEQ_PHASE);
  // Two pixels per riser, never sharper than the near-field authored value.
  let riserSoft = clamp(foot * (2.0 / STRATA_RISER_METRES), STRATA_SOFT_NEAR, 1.0);
  // ...and then the risers are crossfaded out to the sine they came from,
  // because softness alone never removes them. terrace(v, 3, s) emits SIX
  // risers across one period of the sine - a 1.07 m mean harmonic, 0.56 px at
  // 800 m - and softness only drops that harmonic's peak gradient from 2.42/m
  // at s = 0.38 to 0.92/m at s = 1.0, both measured. The claim this file used to
  // make here, that s = 1.0 is "a pure smootherstep between plates, no flat
  // riser left at all", is false: smootherstep has ZERO derivative at both ends,
  // so the treads survive at every softness there is.
  //
  // The crossfade is mean-preserving to six decimals: terrace() is odd-symmetric
  // about 0.5 and the sine's distribution is symmetric about 0.5, so both limbs
  // integrate to exactly 0.5 and fading the risers out cannot slide a distant
  // cliff half a bed lighter or darker.
  let stepFade = bandGain(STRATA_PERIOD / 6.0, foot);
  let bedMajor = mix(bedSine, terrace(bedSine, 3.0, riserSoft), stepFade);
  // Sub-bedding: thin partings within each major bed. Phase-shifted so its
  // crests do not land on the major risers, and carried ZERO-MEAN in [-0.5,
  // 0.5] so that fading it out past 200 m converges the rock to the major
  // sequence rather than sliding every distant cliff half a bed darker.
  let bedMinor = 0.5 * sin(y * (TAU / STRATA_SUB_PERIOD) + 1.7)
               * bandGain(FEAT_SUBBED, foot);
  // Only a face that cuts the stack shows the stack: onset at a 14 degree
  // flank, full exposure by 39 degrees. And only a BEDDED member has a stack to
  // cut - the other half of why the island read as a contour map was that every
  // square metre of it was bedded, so the rings never stopped.
  //
  // `fold` is already the lithology field and the joint network is already
  // gated on its low end (see jointGain below), so gating the bedding on its
  // HIGH end costs no extra noise evaluation and makes the two structures
  // mutually exclusive: the cool massive basalt cools into columns and shows no
  // bedding at all, the warm oxidised tuff and ash above it is bedded and has
  // no columns. Measured over the fold distribution (fbmCheap2, RMS 0.357):
  // 35% of the island fully bedded, 20% fully massive, 45% in between.
  let carbonateStyle = stylePulse(macroStyle, 0.20, 0.15);
  let shelfStyle = stylePulse(macroStyle, 0.58, 0.10);
  let deepBeddedStyle = stylePulse(macroStyle, 0.79, 0.14);
  let beddingCharacter = clamp(0.16 + shelfStyle * 0.84 + deepBeddedStyle * 0.70
                              - carbonateStyle * 0.12, 0.08, 1.0);
  let bedding = smoothstep(0.25, 0.80, slopeTan) * smoothstep(-0.30, 0.14, fold)
              * beddingCharacter;
  // The bedded FORM is filtered a full octave before the band it comes from.
  // s.relief reaches the picture through dpdx() in perturbNormal(), i.e. as a
  // one-pixel finite difference, and that is a faithful gradient of a 6.4 m
  // period only while the period spans eight pixels or more. At the island's
  // measured 690-904 m it spans 3.6-4.7, where the difference beats against the
  // pixel grid and hands the shading normal a horizontal corduroy no albedo fix
  // can touch. Full to a 0.8 m footprint (about 400 m face-on), gone by 1.6 m
  // (about 800 m). The HUE band below is deliberately NOT filtered with it.
  let bedShape = bedding * bandGain(STRATA_PERIOD * 0.5, foot);

  // Joint network. worley2's F2-F1 goes to zero exactly on a cell boundary,
  // which is where a joint belongs. The dominant plane is enough: a projection
  // seam is invisible next to the crack it runs through. 0.09 rather than the
  // old 0.16 because a joint is a crack, not a valley - at 0.16 the cells read
  // as paving slabs with mortar between them.
  //
  // TWO THINGS STOP IT READING AS CRAZY PAVING, and shrinking the cell is not
  // one of them - that only makes a denser net of the same net.
  //
  // First, the lattice is DOMAIN-WARPED by the raw coarse and mid bands, which
  // are already in hand, so it costs no extra noise evaluation. An unwarped
  // Worley field is a jittered square lattice and the eye finds the lattice:
  // every cell is within a factor of two of every other and their boundaries
  // meet at a small set of angles. Up to half a cell of warp off a 13.7 m and a
  // 3.4 m field bends whole runs of joints around the rock's own form the way a
  // cooling front actually propagates, and it destroys the size uniformity too,
  // because the warp's Jacobian stretches one patch and compresses the next.
  //
  // Second, jointing belongs to a LITHOLOGY, not to rock in general. A massive
  // basalt flow cools into columns; the tuff and ash members have no columnar
  // structure at all and weather as unbroken faces. `fold` already decides
  // which member this is - it is what feeds bandMix below - so the same field
  // gates the joints, and the net covers something under half the island
  // instead of every square metre of it.
  let basaltStyle = 1.0 - smoothstep(0.08, 0.18, macroStyle);
  let blockStyle = stylePulse(macroStyle, 0.48, 0.10);
  let spireStyle = stylePulse(macroStyle, 0.68, 0.10);
  let pressureStyle = smoothstep(0.88, 0.97, macroStyle);
  // The old one-size-fits-all stack remains as microstructure, but it must not
  // remain the PRIMARY silhouette inside a family that now has its own macro
  // form. Carbonate, shelf beds and spire flutes suppress it most strongly;
  // basalt keeps it almost intact. A non-zero floor prevents polished clay.
  let sharedDetail = clamp(1.0 - carbonateStyle * 0.72
                          - stylePulse(macroStyle, 0.38, 0.10) * 0.48
                          - blockStyle * 0.36 - shelfStyle * 0.62
                          - spireStyle * 0.66 - deepBeddedStyle * 0.56
                          - pressureStyle * 0.68, 0.20, 1.0);
  let jointCharacter = clamp(0.16 + basaltStyle * 0.84 + blockStyle * 0.55
                            + spireStyle * 0.42 + pressureStyle * 0.32, 0.12, 1.0);
  let jointGain = bandGain(FEAT_JOINT, foot)
                * (1.0 - smoothstep(-0.22, 0.22, fold)) * jointCharacter;
  let warp = vec2f(coarseRaw, midRaw) * 0.55;
  let cell = worley2(dominantPlaneUV(absPos, geoN, FRACTURE_CELL) + warp, SEED_FRACTURE, 1.0);
  let joint = mix(1.0, smoothstep(0.0, 0.09, cell.y - cell.x), jointGain);

  var s : Substrate;
  s.height = saturate(0.5 + coarse * 0.30 * sharedDetail
                    + mid * 0.26 * sharedDetail + fine * 0.16 * sharedDetail
                    + (bedMajor - 0.5) * 0.34 * bedShape)
           * (0.62 + 0.38 * joint);

  // Differential erosion: soft beds recess and hard beds stand proud, so the
  // stack is a physical staircase and not a stripe painted on a smooth wall.
  // This is what makes strata survive into the SHADING - a banded albedo alone
  // reads as a decal the moment the sun moves.
  s.relief = coarse * RELIEF_ROCK_COARSE * sharedDetail
           + mid * RELIEF_ROCK_MID * sharedDetail
           + fine * RELIEF_ROCK_FINE * sharedDetail
           + (bedMajor - 0.5) * RELIEF_STRATA * bedShape
           + bedMinor * RELIEF_SUBBED * bedShape
           - (1.0 - joint) * RELIEF_JOINT;

  // Oxidised tuff bands alternating with fresh basalt. The strata drive the HUE
  // and the noise bands drive the VALUE; swapping those two is what makes
  // procedural rock read as camouflage. The lithology field slides the whole
  // island's rock between the two end members so no two headlands match.
  //
  // BOTH HALVES OF THAT WERE INVERTED IN THE CODE, and together they were the
  // terracing. The old coefficient of 1.7 against a +/-0.5 input drove
  // saturate() hard into its rails, so what came out was a two-level square
  // wave rather than a gradient; and the old end members differed by 2.332x in
  // LUMINANCE (1.22 stops) against a B/G chromaticity change of only 1.088 to
  // 0.851 - precisely the swap the paragraph above forbids.
  //
  // 0.62 keeps the whole excursion inside the mix: 0.5 * 0.62 = 0.31 from the
  // two bedded terms together, plus 0.26 * 0.8 = 0.208 at a typical fold
  // extreme, is 0.518 - and the fold gate on `bedding` above removes the beds
  // entirely at the negative end, which is the half that would clip low.
  // Integrated over the fold field's real distribution (Gaussian, RMS 0.357,
  // support +/-1.15) the clipped fraction of the cycle goes from 41.8% to 0.01%
  // with the sub-bedding faded out, and from 37.2% to 0.12% with it at full.
  let bandMix = saturate(0.5 + mix(bedMajor - 0.5, bedMinor, 0.30) * bedding * 0.62
                       + fold * 0.26);
  // Equal-luminance end members: Rec709 0.9582 and 0.9587, a ratio of 1.0005,
  // against B/G 1.281 vs 0.731 and R/G 0.896 vs 1.237 - a 1.75x chroma swing at
  // constant value. Their midpoint luminance is 0.9585 against the old pair's
  // 0.9592, so the rock's average brightness does not move.
  //
  // That is the whole point. A 6.4 m band subtends 3.6-4.7 px at the island's
  // measured 690-904 m, and at that size a LUMINANCE band is the ring: the
  // measured autocorrelation of the rendered cone peaked at 4 px against a
  // predicted 3.6-4.7. A chroma band of the same size is averaged away by the
  // display chain and by the eye, and only survives where the beds are large
  // enough on screen to read as lithology in the first place.
  let lith = mix(vec3f(0.86, 0.96, 1.23), vec3f(1.15, 0.93, 0.68), bandMix);
  s.tint = lith * (0.86 + 0.28 * s.height);

  // Joints are recessed, silted and rougher; crest facets are water-polished.
  // The beds carry a roughness difference too - the tuff is the porous, poorly
  // cemented member and the basalt is dense - which keeps the banding legible
  // under a sky bright enough to wash the albedo difference out. On bedShape
  // rather than bedding: a roughness band is a specular VALUE cue, so it belongs
  // with the form and not with the hue, and it has to leave with it.
  s.rough = 0.10 * (1.0 - joint) - 0.08 * s.height
          + (bandMix - 0.5) * 0.12 * bedShape;
  // Bare rock has no loose facets to catch the sun; glitter is a sediment
  // effect and sandSubstrate() is where it is weighted.
  s.glint = 0.0;
  return s;
}

/// Loose sediment: bedforms, ripples and grain. No joints, no strata - sand has
/// neither. What it does have is MINERAL SORTING, which is where its colour
/// structure comes from; see the tint below.
fn sandSubstrate(absPos: vec3f, foot: f32) -> Substrate {
  // The largest band. Bar-and-trough, scour lanes, shell-hash patches: metres
  // to tens of metres, far too big to alias, and therefore the only thing
  // holding a sand flat together past a hundred metres. Without it the middle
  // distance is flat interpolated vertex colour, which is exactly what the
  // beach looked like.
  let bedform = fbmCheap2(absPos.xz * SAND_BEDFORM, SEED_SAND + 3u)
              * bandGain(FEAT_SAND_BED, foot);

  // The bedforms curve because RIPPLE SPACE is domain-warped on a 160 m field,
  // not because the coordinate frame is rotated by an angle a(x, z). That
  // rotation is the obvious way to write it and it is wrong: d/dx of
  // (x cos a + z sin a) carries a |p| * da/dx term, so the ripple frequency is
  // multiplied by the sample's DISTANCE FROM THE WORLD ORIGIN. Three kilometres
  // out that is a factor of sixty and a 1.6 m ripple aliases into per-pixel
  // sparkle no detail fade can rescue. Warping AFTER the anisotropic scale
  // keeps the displacement at 0.9 of a ripple period - a full period of lateral
  // wander - with a Jacobian within 4% of identity anywhere in the world.
  let rip = vec2f(absPos.x, absPos.z * 3.4) * SAND_RIPPLE;
  let q = absPos.xz * 0.0062;
  let drift = vec2f(fbmCheap2(q + vec2f(5.2, 1.3), SEED_SAND),
                    fbmCheap2(q + vec2f(9.1, 4.7), SEED_SAND + 7u)) * 0.9;
  let ripple = billowCheap2(rip + drift, SEED_SAND + 11u)
             * bandGain(FEAT_SAND_RIPPLE, foot);

  let grainGain = bandGain(FEAT_SAND_GRAIN, foot);
  var grain = 0.0;
  if (grainGain > 0.004) { grain = fbmCheap2(absPos.xz * SAND_GRAIN, SEED_SAND + 23u) * grainGain; }

  var s : Substrate;
  s.height = saturate(0.5 + bedform * 0.22 + ripple * 0.62 + grain * 0.26);
  s.relief = bedform * RELIEF_SAND_BED
           + ripple * RELIEF_SAND_RIPPLE
           + grain * RELIEF_SAND_GRAIN;

  // Mineral sorting, and the reason this is a COLOUR and not a grey ramp.
  // Heavy minerals - magnetite and olivine off a volcanic island - are nearly
  // twice the density of the carbonate fraction, so the backwash strands them
  // in the ripple troughs while the pale shell hash winnows onto the crests.
  // A real beach is therefore laminated dark-cool and light-warm at ripple
  // scale, and reproducing that is worth more than any amount of extra relief:
  // a single-hue surface reads as poured concrete no matter how bumpy it is.
  let sorting = smoothstep(0.20, 0.80, s.height);
  s.tint = mix(vec3f(0.63, 0.61, 0.66), vec3f(1.32, 1.25, 1.08), sorting)
         * (0.94 + 0.12 * bedform);
  // Rippled sand is slightly glossier in the troughs where the finest material
  // settles, which is the only specular cue a flat seabed has.
  s.rough = -0.05 + 0.10 * (1.0 - s.height);
  // The glitter lobe rides the grain band's own footprint gain, so it exists
  // only where a 0.18 m feature still spans four pixels or more.
  s.glint = grainGain;
  return s;
}

/// Mikkelsen surface-gradient bump mapping: perturb an arbitrary normal by the
/// screen derivatives of a scalar height field, with no tangent frame and no UV
/// set. It is the only formulation that works under a triplanar projection,
/// because there is no single parameterisation to differentiate against.
///
/// `relief` and `P` must be in the SAME units - metres here - because the
/// |det| factor cancels the pixel footprint out of the ratio and what is left
/// is the true d(relief)/d(position). That is why `scale` is 1.0 at the one
/// call site: at unit scale this returns the exact bump normal of the height
/// field, and any other value is a lie about how deep the surface is.
fn perturbNormal(N: vec3f, P: vec3f, relief: f32, scale: f32) -> vec3f {
  let dpx = dpdx(P);
  let dpy = dpdy(P);
  let r1 = cross(dpy, N);
  let r2 = cross(N, dpx);
  let det = dot(dpx, r1);
  let surfGrad = sign(det) * (dpdx(relief) * r1 + dpdy(relief) * r2);
  return normalize(abs(det) * N - scale * surfGrad);
}

/// Caustic contrast added to the AMBIENT term. evalSun() already modulates the
/// direct beam; this is the diffuse-sky share of the same wave lensing, and it
/// is what keeps the pattern faintly alive inside shadows and under cloud.
///
/// It multiplies `causticFactor() - 1`, which is MEAN ZERO, so whatever the
/// value it can no longer lift the DC. That is the load-bearing part: at 0.42
/// against the old mean-3.86 factor this term added a measured 111% of the
/// ambient diffuse as a flat brightness at the lagoon station, which is most of
/// why the shallow seabed read as frosted glass.
///
/// 0.42 -> 0.12. The sky is a roughly 90 deg source, so its caustic blur at the
/// receiver is about 0.75*depth - 2.2 m at 3 m of water - against a 0.57-1.2 m
/// pattern, i.e. completely washed out, and the physically correct gain is near
/// zero. What is genuinely still collimated is the clear-sky circumsolar
/// aureole within 10-15 deg of the sun, which brackets the honest value at
/// <= 0.25. 0.12 is a look value inside that bracket.
const CAUSTIC_AMBIENT_GAIN : f32 = 0.12;

/// How dark the deepest cavity of the detail height field goes, as a fraction
/// of the ambient. Applied one-sided below the field's 0.5 mean, so it reaches
/// the same 0.55 floor the two-sided version did without carrying its 22.5%
/// bias out to the horizon.
const CAVITY_STRENGTH : f32 = 0.45;

/// The grain-scale glitter lobe. 0.24 perceptual is GGX alpha 0.0576, a lobe
/// about 3.3 degrees wide against the main lobe's 27 - narrow enough to break
/// into individual highlights over a normal that jitters 7.7 degrees per grain
/// patch, wide enough that each highlight still covers two to four pixels
/// inside the 22 m the band is at full strength over, rather than one. A single
/// pixel is the classic TAA firefly and it is the whole risk in this feature.
///
/// The weight is an AREAL COVERAGE - what fraction of the grains present a
/// specular facet - so a quarter is a physical claim about shell hash and quartz
/// in a volcanic sand, not a brightness knob. It has to be that large because
/// only a small part of the surface ever satisfies a 3.3 degree lobe at once:
/// measured on the spawn beach at 0.10, the isolated-highlight population moved
/// 0.352% -> 0.360% and the peak 166.5 -> 171.1, which is not a glitter.
const GLINT_ROUGHNESS : f32 = 0.24;
const GLINT_WEIGHT    : f32 = 0.25;

// --- wet band ---------------------------------------------------------------
//
// Ground within WET_FULL metres of the waterline is saturated and dries out by
// WET_DRY. Those are HORIZONTAL distances, because a swash zone is a horizontal
// thing: it is however far up the strand the last wave ran, and on a beach at
// seven degrees that is fifty times its own height.
//
// WHY NOT terrain.distanceToShore(). That function is the exact answer and it
// is a marching root-find along the island radius costing about 45 us a call -
// a CPU query for surf audio and spawning, not something a fragment shader can
// ever have, per pixel or per vertex. What IS available here is the FIRST
// NEWTON STEP of that same root-find: the height above sea level divided by the
// surface gradient is where the h = 0 contour lies along the line of steepest
// descent. On a strand, where the gradient is smooth over tens of metres, the
// two agree to well inside the width of the band, and the estimate costs one
// divide off a normal this shader already had.
//
// The elevation cap is what keeps that honest on a cliff, where the gradient is
// large, the Newton step is short, and a naive reading would call forty metres
// of headland damp. Nothing above WET_CAP_HI is ever wet, full stop.
const WET_FULL   : f32 = 1.5;
const WET_DRY    : f32 = 7.0;
/// Floor on the gradient used for the Newton step. 0.02 caps a dead-flat tidal
/// flat at fifty times its height above the sea rather than at infinity.
const WET_MIN_GRAD : f32 = 0.02;
const WET_CAP_LO : f32 = 2.0;
const WET_CAP_HI : f32 = 4.5;

struct FragOut {
  @location(0) color    : vec4f,
  @location(1) velocity : vec2f,
  /// The SSAO gate: this pixel's delivered ambient share. See aoGate() in
  /// common/water.wgsl and RENDER.SSAO_STRENGTH in core/constants.js.
  @location(2) gate     : f32,
};

@fragment
fn fs_terrain(in: VSOut) -> FragOut {
  let P = in.worldPos;
  let absPos = toAbsolute(P);
  let depth = seaLevel() - absPos.y;              // positive underwater

#ifdef CAVE_MOUTHS
  // Open the cave mouths BEFORE any shading work. Behind every discarded
  // fragment stands the cave pass's own copy of this surface (the keep ring in
  // world/cave_mesh.js), so an over-generous disc shows rock, never sky.
  {
    let n = min(u32(mouths.count.x), 16u);
    for (var i = 0u; i < n; i++) {
      let d = mouths.discs[i];
      let dx = absPos.x - d.x;
      let dz = absPos.z - d.y;
      if (dx * dx + dz * dz < d.w * d.w && absPos.y > d.z - 8.0) { discard; }
    }
  }
#endif

  let toEye = frame.cameraPos.xyz - P;
  let viewDist = length(toEye);
  let V = toEye / max(viewDist, 1e-4);

  // Interpolation denormalises the vertex normal. The GEOMETRIC normal is the
  // one every projection and every shadow lookup must use.
  let geoN = normalize(in.normal);
  let w = triplanarWeights(geoN, TRIPLANAR_SHARPNESS);

  // Slope as |grad h| = tan(theta), NOT as 1 - cos(theta).
  //
  // This is the unit the biome catalogue quotes its slope bands in - biomes.js
  // says so explicitly - and the unit the CPU's sampleSlope() returns, so it is
  // the only measure a threshold authored over there may be compared against.
  // 1 - cos(theta) is bounded and cheap and looks like it would do, and it is
  // not a gradient: it reads 0.055 on the 19 degree flank the catalogue calls
  // 0.34. Every crossover in this shader used to be written that way, against
  // thresholds plainly reasoned about as gradients, which pushed the rock/sand
  // transition out to 33..57 degrees and made the lower two thirds of the
  // island's slope range come out as sediment whatever the biome said.
  let up = max(geoN.y, 1e-3);
  let slopeTan = sqrt(max(1.0 - up * up, 0.0)) / up;

  // One pixel's worth of world, metres. Every detail band is filtered against
  // this rather than against viewDist, so ground raked by the view - a beach
  // seen along its length, the whole reason the old surface shimmered out to
  // the horizon - loses its fine bands at the range the screen actually stops
  // resolving them.
  let foot = pixelFootprint(P);

  // ---- substrates ------------------------------------------------------
  let macroStyle = in.surface.w;
  let rock = rockSubstrate(absPos, geoN, w, slopeTan, foot, macroStyle);
  let sand = sandSubstrate(absPos, foot);
  let geology = geologyMacro(absPos, geoN, macroStyle, foot);

  // Rock wins on steep ground, sediment on flat ground, and the biome's own
  // rockiness/sediment shift the crossover - so a boulder field stays rocky
  // where it is level and an abyssal plain stays soft where it tilts.
  let sediment = in.surface.x;
  let rockiness = in.surface.y;

  // Curvature. surface.z is the baker's concavity term: it saturates at 1 on
  // flat and convex ground and falls only where the neighbourhood sits ABOVE
  // the sample, so 1 - it is a direct read of how much of a hollow this is.
  // Hollows are where loose material ends up - that is the entire mechanism of
  // a sediment trap - so concavity pushes the blend toward sand even on ground
  // steep enough that the slope term wanted rock. Gullies silt up; the ribs
  // between them stay bare. Nothing else in the shader can produce that,
  // because it is the only signal here that knows about the SECOND derivative
  // of the terrain.
  //
  // Weighted by the biome's own sediment supply, because a trap only fills if
  // there is something to fill it with: a gully in a beach silts up completely,
  // the same gully in a bare basalt headland barely at all.
  let concavity = 1.0 - in.surface.z;
  let rockAmount = saturate(remapClamped(slopeTan, 0.34, 0.90, 0.0, 1.0)
                          + rockiness * 0.75 - sediment * 0.55
                          - concavity * (0.30 + 0.70 * sediment) * 0.90);

  // heightBlend, not mix: sand settles INTO the rock's hollows and the rock's
  // high points punch through it. A lerp dissolves each into the other and the
  // boundary reads as a decal.
  let bw = heightBlend(rockAmount, 1.0 - rockAmount, rock.height, sand.height, 0.22);
  var tint = rock.tint * bw.x + sand.tint * bw.y;
  var detailHeight = rock.height * bw.x + sand.height * bw.y;
  var detailRelief = rock.relief * bw.x + sand.relief * bw.y;
  var roughOffset = rock.rough * bw.x + sand.rough * bw.y;

  // Macro geology belongs to exposed rock only. Multiplying by the same
  // height-blend weight that exposes the rock prevents a pressure fracture or
  // carbonate pore from being painted across loose sand in the neighbouring
  // biome, while macroStyle itself still interpolates smoothly at the border.
  tint *= mix(vec3f(1.0), geology.tint, bw.x);
  detailHeight = saturate(detailHeight + geology.heightOffset * bw.x);
  detailRelief += geology.relief * bw.x;
  roughOffset += geology.rough * bw.x;

  // Vertex albedo is sqrt-encoded; squaring restores four stops of precision in
  // the dark basalts that dominate everything below the shelf break.
  let baseAlbedo = in.material.rgb * in.material.rgb;
  var albedo = baseAlbedo * tint;
  var roughness = clamp(in.material.a + roughOffset, 0.42, 1.0);

  // ---- macro patchiness ------------------------------------------------
  // The band the eye reads TERRAIN SHAPE at - tens to a couple of hundred
  // metres - had nothing in it at all; see MACRO_FREQ_CHROMA. Two zero-mean
  // fields on separate axes fill it: chroma at 233 m and value at 71 m, so the
  // two never phase-lock into patches of one shape.
  //
  // The amount is derived from rockiness and depth rather than from a per-biome
  // table because both are already interpolated smoothly across the vertex
  // stream, and a per-biome constant would have to arrive as a biome ID, which
  // is categorical and cannot be interpolated across a boundary without
  // inventing a biome that is not there.
  let macroAmt = mix(MACRO_MIN, 1.0,
                     max(rockiness, smoothstep(MACRO_DEEP_LO, MACRO_DEEP_HI, depth)));
  let macroA = fbmCheap2(absPos.xz * MACRO_FREQ_CHROMA, SEED_MACRO) * macroAmt;
  let macroB = fbmCheap2(absPos.xz * MACRO_FREQ_VALUE, SEED_MACRO + 5u) * macroAmt;
  albedo *= (vec3f(1.0) + MACRO_CHROMA * macroA) * (1.0 + MACRO_VALUE * macroB);

  // ---- wet band --------------------------------------------------------
  // Everything below the waterline is saturated; above it the swash zone dries
  // out over a few metres of strand. Wetting darkens because water fills the
  // surface pores (a real and large effect) and SMOOTHS. Adding a specular
  // multiplier instead is what makes wet rock look like plastic.
  let above = max(-depth, 0.0);                     // metres above sea level
  let shoreDist = above / max(slopeTan, WET_MIN_GRAD);
  let wet = (1.0 - smoothstep(WET_FULL, WET_DRY, shoreDist))
          * (1.0 - smoothstep(WET_CAP_LO, WET_CAP_HI, above));
  albedo *= mix(1.0, 0.52, wet);
  // Smoother, not smooth. A saturated grain bed still scatters - it is packed
  // sand with a film on it, not a puddle - and taking the roughness far enough
  // down to give it a mirror lobe makes the swash zone the BRIGHTEST thing on
  // the beach under a low sun, which is backwards: wet sand is conspicuously
  // darker than dry sand from every angle but the specular one.
  roughness = mix(roughness, roughness * 0.62 + 0.05, wet);
  // The swash planes the bedforms off as it drains: wet sand is measurably
  // flatter than the dry sand a metre up the beach, and leaving the ripples at
  // full relief under a mirror-smooth surface is what makes a wet band read as
  // a painted stripe rather than as water.
  detailRelief *= mix(1.0, 0.45, wet * bw.y);

  // ---- normal ----------------------------------------------------------
  // scale 1.0, and it is not a tuning value. detailRelief is in METRES, so the
  // surface gradient perturbNormal() forms from it is the true dh/dx and the
  // tilt is the real arctangent of the real slope. Every band already faded
  // itself out at its own Nyquist limit, so there is nothing left here to
  // shimmer and nothing to compensate for with a distance falloff.
  var N = perturbNormal(geoN, P, detailRelief, 1.0);
  // A normal tipped past the horizon would light the surface from inside it.
  if (dot(N, geoN) < 0.05) { N = geoN; }

  // Cavity term from the same height channel: the recesses the bump just made
  // are exactly the recesses ambient light cannot reach.
  //
  // ONE-SIDED, about the band's own mean. Every detail band here is zero-mean
  // by triplanar.wgsl's contract, so `detailHeight` converges to 0.5 as the
  // footprint grows and the old `0.55 + 0.45 * detailHeight` therefore converged
  // to 0.775 - a flat 22.5% ambient darkening at range with exactly zero
  // variance, on top of a measured surface.z of 0.983 on flat seabed. It bought
  // no shape for it and it is a direct contributor to the hazy, low-contrast
  // mid and far field. Recesses must darken; crests must not brighten; and with
  // nothing left to read the term must converge to 1.0, not to 0.775.
  let ao = saturate(in.surface.z * (1.0 - CAVITY_STRENGTH * saturate(1.0 - detailHeight * 2.0)));

  // ---- shading ---------------------------------------------------------
  let s = makeSurface(P, N, geoN, V, albedo, roughness, 0.0, ao, vec3f(0.0), 0.0);
  let viewDepth = max(dot(-toEye, frame.cameraFwd.xyz), nearPlane());
  let lit = evalLightingSplitTranslucent(s, in.pos.xy, viewDepth, 0.0);
  var radiance = lit.total;

  // Mineral glitter. Quartz and shell facets on loose sediment catch the sun at
  // grain scale, and the 0.42 roughness floor - which is there so the beach
  // cannot fizz under TAA - makes that impossible on the main lobe: a beach
  // ripple crest lands at roughness 0.69, GGX alpha 0.476, which smears the
  // sun's 0.53 degree disc over roughly 27 degrees. That is a sheen and it can
  // never be a glitter. A second, narrow lobe on the SAME shading normal
  // supplies one; the grain band has already tilted that normal by up to 7.7
  // degrees (0.008 m of relief across 0.37 m features), which is what makes the
  // highlights break up at grain scale rather than following the ripples.
  //
  // Weighted by the grain band's own bandGain, so the lobe is at full strength
  // only while a 0.18 m feature spans four pixels or more (to 22 m), is gone by
  // 45 m, and can never become the sub-pixel sparkle that TAA turns into
  // crawling fireflies. That weighting is the safety property, not a look knob:
  // if the glitter is ever wanted further out, the grain band has to reach
  // further out with it.
  // ALBEDO ZERO, and that is the whole difference between a glitter and a 10%
  // brightness lift. evalSun() returns evalBRDF(), which is diffuse PLUS
  // specular, so weighting a second full evaluation adds GLINT_WEIGHT of another
  // diffuse lobe - measured with the albedo left in: the beach's isolated
  // highlight population moved from 0.362% to 0.384% of pixels and its peak from
  // 157.5 to 166.3, i.e. almost nothing, because the sharp lobe was buried under
  // a flat 10% of Lambert. With surfaceDiffuse() forced to zero, f0 stays at
  // F0_DIELECTRIC (0.04, right for a quartz or shell facet) and what is left is
  // only the narrow lobe: its peak D is 95.9 against the base lobe's 1.40. At
  // the shipped quarter weight the near beach's peak goes 166.5 -> 186.2 and its
  // isolated-highlight population 0.352% -> 0.375% of pixels.
  let glintW = sand.glint * bw.y * GLINT_WEIGHT;
  if (glintW > 0.002) {
    let gs = makeSurface(P, N, geoN, V, vec3f(0.0), GLINT_ROUGHNESS, 0.0, ao, vec3f(0.0), 0.0);
    radiance += evalSun(gs, viewDepth, 0.0) * glintW;
  }

  if (depth > 0.0) {
    let cf = causticFactor(P, N, depth);
    radiance += evalAmbientSH(N) * daylightAtDepth(depth) * surfaceDiffuse(s)
              * ((cf - vec3f(1.0)) * CAUSTIC_AMBIENT_GAIN);
  }

  // ---- participating medium, LAST --------------------------------------
  // Only the submerged part of the view ray is in water. From the air over a
  // reef that is a small fraction of the ray, so the seabed stays legible.
  // From BELOW, pass/underwater.wgsl owns the whole ray and this stands down -
  // see applyViewRayWater() for why doing both is what erased the seabed.
  radiance = applyViewRayWater(radiance, viewDist, depth, -V);
  // The aerial volume, which the froxel pass owns and which this pass applies
  // nowhere else. Submerged it stands down: pass/underwater.wgsl adds the volume
  // once for the whole frame then.
  let screenUV = in.pos.xy * frame.screen.zw;
  radiance = applyViewRayFroxel(radiance, screenUV, viewDepth);

  // ---- SSAO gate ---------------------------------------------------------
  // The ambient share of the delivered pixel; render/passes/ssao.js multiplies
  // exactly this much of sceneColor by the AO term. The mean-zero caustic
  // wiggle and the glint above are deliberately OUTSIDE the numerator: the
  // glint is direct sun (the CSM owns it) and the wiggle redistributes the
  // ambient it modulates, so gating it would only add noise to the ratio.
  let aoAmb = aoAmbientThroughMedium(lit.ambient, viewDist, depth, -V,
                                     screenUV, viewDepth);

  // ---- motion vector ---------------------------------------------------
  let cur = in.curClip.xy / max(in.curClip.w, 1e-6);
  let prv = in.prevClip.xy / max(in.prevClip.w, 1e-6);
  // NDC -> UV: half scale, and y flips because UV runs down the screen.
  let velocity = (cur - prv) * vec2f(0.5, -0.5);

  var out : FragOut;
  out.color = vec4f(radiance, 1.0);
  out.velocity = velocity;
  out.gate = aoGate(aoAmb, radiance);
  return out;
}
