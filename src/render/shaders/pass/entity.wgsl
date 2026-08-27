// SUBWAVE - entities.
//
// The vessel today, creatures tomorrow. One pipeline, one vertex format, one
// per-draw uniform carrying a model matrix, LAST FRAME'S model matrix, and a
// material selector.
//
// WHY TWO MATRICES. The vessel's nacelles tilt and its rotors spin - each is a
// separate node with its own transform - so a motion vector reconstructed from
// the camera alone would be wrong on exactly the parts that move fastest, and
// TAA would smear a spinning rotor into a grey disc. Shipping the previous
// frame's node matrix is four extra vec4s per draw and it makes every moving
// sub-assembly reproject correctly.
//
// Both matrices are already CAMERA-RELATIVE: the CPU subtracted
// frame.worldOrigin from the translation column of each, using the CURRENT
// origin for both, so a rebase frame produces no false motion.
//
// MATERIALS ARE PROCEDURAL AND SELECTED BY INDEX. There are no textures. The
// hull's plate layout, seams, fasteners, finish and wear are synthesised here
// from the mesh UV and the object-space position, which means they are stable
// under any camera motion and cost nothing to stream.
//
// EVERY DETAIL BAND IS FILTERED BY THE PIXEL FOOTPRINT, exactly as terrain.wgsl
// filters its substrates, and for the same reason. The Kestrel is a 7.4 m object
// normally seen from 8 to 30 m, where one pixel spans 15 to 60 mm; a 2 cm
// brushing groove and a 3 mm scribe line are far below that, and detail below
// the Nyquist limit carries no signal, only shimmer. What made this pass ship a
// surface that read as a missing-texture checker was not a debug pattern - it
// was two unfiltered sub-pixel bands driving a screen-space-derivative bump on a
// near-mirror metal, so the 2x2 derivative quad became the visible feature and
// stamped a hard chequer of specular over the whole hull. Filtered bands and a
// relief channel in METRES fix it at the root; there is no distance fudge left.

// The hull is the one surface in the frame whose entire material story is what
// it reflects, so it opts into the sky-view-LUT environment in
// common/lighting.wgsl instead of the irradiance SH. This must precede the
// include; see envRadiance() there for the measurement that motivates it.
#define SHARP_ENV_SPECULAR

#include "../common/frame.wgsl"
#include "../common/math.wgsl"
#include "../common/noise.wgsl"
#include "../common/brdf.wgsl"
#include "../common/shadow.wgsl"
#include "../common/water.wgsl"
#include "../common/lighting.wgsl"
// For pixelFootprint() and bandGain() only - the same two filtering primitives
// the terrain uses. They live in triplanar.wgsl because that is where projected
// detail needed them first; they are pure functions of the derivatives and bind
// nothing.
#include "../common/triplanar.wgsl"

// ---------------------------------------------------------------------------
// Per-draw
// ---------------------------------------------------------------------------

struct EntityUniform {
  model     : mat4x4f,   // camera-relative, current frame
  prevModel : mat4x4f,   // camera-relative in the CURRENT origin, last frame
  /// x = material id, y = wear 0..1, z = emissive gain, w = hull integrity 0..1
  params    : vec4f,
  /// rgb = base tint multiplier, a = roughness bias
  tint      : vec4f,
  /// x = shadow cascade index for vs_entity_shadow, y = hull wetness 0..1,
  /// z = cos(lamp cone half-angle), w = 1/(cos(inner) - cos(outer)). x is
  /// ignored by the colour pass and y-w by the depth pass; the block exists
  /// because there was no spare component anywhere else.
  shadow    : vec4f,
};

@group(1) @binding(0) var<uniform> entity : EntityUniform;

// Material ids, matching VESSEL_MATERIAL in entities/vessel_mesh.js:
//   0 hull  1 canopy  2 nacelle  3 rotor  4 skid  5 emissive  6 cabin
// and HABITAT_MATERIAL in entities/habitat_mesh.js:
//   7 hab panel  8 hab glass  9 hab viewport  10 hab interior  11 hab screen
//
// THE HABITAT DOES NOT REUSE THE VESSEL'S SKIN, and that is not a style
// preference. hullDetail() is platedSkin() at PLATE_CELLS = 1.85 cells/m with an
// 11% `rolled` family of bare mill-finish plates at ALLOY_F0, metallic 1. On a
// 7.4 m airframe those read as the occasional replaced panel. On a 50 m building
// lit by the underwater ambient SH - 63.7% of the frame at 8 m, though note that
// figure is a PRE-238fab9 measurement, taken when evalAmbient had no depth term
// at all, so read it as "the ambient dominates a shallow frame" and not as a
// current share - every one of them mirrors that ambient, and a photographed
// approach showed the result: irregular half-metre white polygons scattered over
// every module, which is the "camouflage" platedSkin's own comment warns about,
// at building scale. A pressure hull is also not an airframe: it is welded and
// painted, its stiffeners are RINGS, and nothing on it is left bare.
const MAT_CANOPY : f32 = 1.0;

struct VSOut {
  @builtin(position) pos : vec4f,
  @location(0) worldPos  : vec3f,   // camera-relative
  @location(1) normal    : vec3f,   // world space
  @location(2) uv        : vec2f,   // per-part atlas region
  @location(3) objectPos : vec3f,   // body space, for the procedural detail
  @location(4) curClip   : vec4f,   // UNJITTERED clip position, this frame
  @location(5) prevClip  : vec4f,   // UNJITTERED clip position, last frame
};

// The 48-byte vertex the mesh generator emits. `tangent` is consumed by the
// creature materials that will share this pipeline; the vessel's detail is a
// function of object-space position, so its normal perturbation needs no
// tangent frame and the attribute is only declared here to keep one layout.
@vertex
fn vs_entity(
  @location(0) position : vec3f,
  @location(1) normal   : vec3f,
  @location(2) tangent  : vec4f,
  @location(3) uv       : vec2f,
) -> VSOut {
  _ = tangent;
  var out : VSOut;

  let world = entity.model * vec4f(position, 1.0);
  let prevWorld = entity.prevModel * vec4f(position, 1.0);

  // The node matrices are rigid (rotation + translation, unit scale), so the
  // inverse-transpose is the rotation itself and normals transform with the
  // same 3x3 the positions do. No normal matrix is uploaded, and none is needed.
  let rot = mat3x3f(entity.model[0].xyz, entity.model[1].xyz, entity.model[2].xyz);

  out.worldPos = world.xyz;
  out.normal = normalize(rot * normal);
  out.uv = uv;
  out.objectPos = position;
  out.pos = frame.viewProj * world;
  out.curClip = frame.viewProjUnjittered * world;
  out.prevClip = frame.prevViewProj * prevWorld;
  return out;
}

/// Shadow caster. Depth only, no fragment stage; only the position attribute is
/// fetched. `entity.model` is already camera-relative, exactly as the colour
/// path uses it, so the two transforms cannot drift.
@vertex
fn vs_entity_shadow(@location(0) position : vec3f) -> @builtin(position) vec4f {
  let world = entity.model * vec4f(position, 1.0);
  return shadowCasterClip(world.xyz, u32(entity.shadow.x));
}

// ---------------------------------------------------------------------------
// Procedural surface
// ---------------------------------------------------------------------------

// The Kestrel is skinned the way an airframe is: discrete PLATES, each cut from
// its own piece of stock, each with its own finish, joined by scribed seams and
// held by rows of flush fasteners. PLATE IDENTITY carries the material at
// playing distance, not high-frequency noise - a 0.54 m plate is thirty pixels
// at nine metres and a rolling groove is a fraction of one - and a patchwork of
// subtly different plates is what reads as a manufactured object.
//
//   band              feature   relief    full to   gone by   (face-on, 1080p)
//   plate layout       0.54 m   0.9 mm    always    -          never fades
//   plate seam         1.5 mm   2.2 mm    coverage-prefiltered, all ranges
//   fastener rows      4.8 mm   1.1 mm    coverage-prefiltered, all ranges
//   staining/streaks   0.42 m   -         always    -          never fades
//   composite mottle    55 mm   0.4 mm     6.9 m    13.8 m
//   rolling grain       24 mm   0.15 mm    3.0 m     6.0 m     -> roughness
//   duct turning marks  12 mm   0.12 mm    1.5 m     3.0 m     -> roughness
//
// The two bands marked "-> roughness" hand their amplitude to the BRDF as they
// fade instead of simply vanishing. That is not a nicety: a groove field the
// screen cannot resolve is a ROUGHER surface, not a smooth one, and letting a
// brushed plate converge to a mirror is what put the white crust on this hull.

/// Plate density, cells per metre. 1.85 gives plates about 0.54 m across, which
/// is the size a 7.4 m airframe is actually skinned in. The nacelle ducts are
/// smaller parts and get a proportionally finer layout.
const PLATE_CELLS    : f32 = 1.85;
const NACELLE_CELLS  : f32 = 4.60;

/// Flush-seam half-width and depth, metres. A scribed join between two skin
/// plates is about 1.5 mm of gap and barely deeper than it is wide.
const SEAM_HALF_W    : f32 = 0.0015;
const SEAM_DEPTH     : f32 = 0.0022;
/// The sealant-and-chipped-paint band either side of that join, and how much it
/// darkens. 10 mm each side is a 20 mm band, which is what carries the panel
/// read at nine metres; it is still coverage-conserved by scribe(), so it
/// converges into the plate colour rather than crawling. 0.20 is the ceiling -
/// more turns the hull into a visible wireframe inside three metres, which is
/// the failure the hairline alone was avoiding.
const JOIN_BAND_HALF_W : f32 = 0.010;
const JOIN_BAND_DARKEN : f32 = 0.20;
/// Dirt halo under each fastener head. Five times the head's radius, so the row
/// stays a dotted line at nine metres instead of dissolving with the head.
const RIVET_HALO     : f32 = 0.025;
/// Oil-canning: rolled sheet is never dead flat between its fasteners. 0.9 mm
/// of swell per plate is the single strongest cue that a hull is panelled metal
/// rather than moulded.
const PLATE_SWELL    : f32 = 0.0009;

/// Fastener pitch along a seam, head radius, how far it stands proud, and how
/// far in from the join the row runs. All metres.
const RIVET_PITCH    : f32 = 0.115;
const RIVET_RADIUS   : f32 = 0.0048;
const RIVET_RELIEF   : f32 = 0.0011;
const RIVET_INSET    : f32 = 0.0075;

/// Rolling grain: 24 mm across the grain, stretched 14:1 along it.
const GRAIN_PITCH    : f32 = 0.024;
const GRAIN_ANISO    : f32 = 14.0;
const GRAIN_RELIEF   : f32 = 0.00015;
/// Roughness a fully unresolved rolling grain is worth - the variance the bump
/// gave up, handed to the BRDF rather than thrown away.
const GRAIN_ROUGHNESS: f32 = 0.085;

/// Composite mottle and the staining field, metres.
const WEAVE_PITCH    : f32 = 0.055;
const WEAVE_RELIEF   : f32 = 0.0004;
const STAIN_SCALE    : f32 = 0.42;

/// Duct turning marks: pitch, relief and the roughness they leave behind.
const TURN_PITCH     : f32 = 0.012;
const TURN_RELIEF    : f32 = 0.00012;
const TURN_ROUGHNESS : f32 = 0.060;

/// How far in from a join the edge wear reaches, and how much of it a
/// factory-fresh airframe already has. Nothing that has flown has clean plate
/// edges; a skin with none is the tell of a CAD render.
const EDGE_WEAR_BAND : f32 = 0.020;
const EDGE_WEAR_FLOOR: f32 = 0.16;

/// Normal-incidence reflectance of the bare skin, and of a fastener head.
///
/// THESE ARE f0, NOT A PAINT COLOUR. A metal has no diffuse lobe at all, so its
/// albedo channel IS its Fresnel reflectance (brdf.wgsl mixes f0 = albedo at
/// metallic 1). The mill plates used to carry 0.150 here, which is a grey-paint
/// value: worked through this shader's own envBRDFApprox at roughness 0.25 and
/// NoV 0.7 it returns 14.3% of the environment, against the 16.9% the painted
/// plate beside it returns as diffuse plus specular. Bare alloy was rendering
/// DARKER than the paint next to it, which is why the 43% of the hull that is
/// supposed to be metal contributed nothing. 0.62/0.60/0.57 is anodised
/// titanium-aluminium and takes the same plate to 59.1%, a 4.1x brightening.
const ALLOY_F0   : vec3f = vec3f(0.620, 0.600, 0.570);
const STEEL_F0   : vec3f = vec3f(0.550, 0.560, 0.570);

/// Livery. The Kestrel is the hero asset and it was, measured, 8.6% chroma -
/// every visible colour in the spawn screenshot was borrowed sky. The scheme is
/// a coloured upper decking with a high-visibility nose band, which is what a
/// survey craft actually wears: readable from a standing eye on the beach, and
/// the only saturated thing in a frame otherwise made of sand, sky and water.
///
/// The livery is PAINT, so it goes on the painted and composite families and
/// never on a bare mill plate - an unpainted plate inside the decking reads as a
/// replaced panel, which is exactly right. Its edges are jittered per plate so
/// they step at the joins instead of cutting a smooth arc across the skin; see
/// liveryEdge().
const LIVERY_DECK : vec3f = vec3f(0.026, 0.068, 0.082);   // deep petrol, chroma 0.68
const LIVERY_TRIM : vec3f = vec3f(0.560, 0.165, 0.030);   // hi-vis orange, chroma 0.95

/// The decking's lower edge, in OBJECT-NORMAL y, with its feather and its
/// per-plate jitter in the same units.
///
/// Keyed on the normal rather than on a height because the hull is slab-sided
/// amidships (superellipse exponent 4.4): objN.y steps discontinuously across
/// the chine there, so the boundary lands exactly on that hard edge - which is
/// where a decking line belongs and where masking tape would actually go. On
/// the rounded nose and tail objN.y varies smoothly instead, and there the
/// per-plate jitter is what makes the edge step from plate to plate.
const DECK_EDGE_N   : f32 = 0.12;
const DECK_FEATHER  : f32 = 0.10;
const DECK_JITTER   : f32 = 0.30;

/// Object-space z of the nose band's aft edge, its feather and its jitter, all
/// metres. The hull runs z -3.70 (nose) to +3.70, so this is the forward 1.15 m.
const TRIM_NOSE_Z      : f32 = -2.55;
const TRIM_NOSE_FEATHER: f32 = 0.02;
const TRIM_NOSE_JITTER : f32 = 0.16;

/// Canopy frame: mullion relief in metres, and how wide the mullions are in UV.
const CANOPY_FRAME_RELIEF : f32 = 0.004;
const CANOPY_KEEL_HALF_W  : f32 = 0.011;
const CANOPY_SILL_HALF_W  : f32 = 0.028;
/// Fraction of a lamp lens's on-axis luminance that is still visible from
/// outside its beam - the reflector and the lens body scattering. A few tenths
/// of a percent is what a real spotlight does; at 0.4% a lit flood lens sits at
/// 25 renderer units, which is a distinctly glowing lens with a small halo in
/// daylight and a beacon at depth, where the measured ambient is 0.0021.
const LENS_OFF_AXIS : f32 = 0.004;

/// Instrument glow seen through the pane. Teal, matching UI_COLORS.instrument,
/// and dim enough that daylight reflection still wins at every angle but head-on.
const CANOPY_INTERIOR : vec3f = vec3f(0.008, 0.026, 0.023);

const SEED_PLATE : u32 = 0x4b65u;
const SEED_GRAIN : u32 = 0x8a13u;
const SEED_STAIN : u32 = 0x51d7u;
const SEED_WEAVE : u32 = 0x2c41u;

/// A procedural surface sample: what the fragment stage needs before lighting.
struct Detail {
  albedo    : vec3f,
  roughness : f32,
  metallic  : f32,
  /// Displacement in METRES, the channel the shading normal is derived from.
  /// Not a [0,1] knob: a 1.1 mm rivet head and a 2.2 mm scribe have to hand
  /// perturbNormal() gradients that differ by exactly their real ratio, or the
  /// only way to make either look right is a fudge factor that breaks the other.
  relief    : f32,
  /// Cavity term in [0,1] for ambient occlusion. 1 = fully exposed.
  ao        : f32,
};

/// Coverage-weighted scribed line. `dist` and `halfWidth` in metres, `foot` from
/// pixelFootprint().
///
/// A 1.5 mm seam is a twentieth of a pixel at nine metres. Drawn at its true
/// width it lands in one fragment in twenty and crawls; widened to a pixel and
/// left at full contrast it turns a distant airframe into a wireframe. The
/// analytic prefilter is both at once - widen to the pixel AND scale the
/// contrast by the coverage that was lost - so the line's contribution to the
/// pixel is conserved and it converges into the plate colour, not into sparkle.
fn scribe(dist: f32, halfWidth: f32, foot: f32) -> f32 {
  let w = max(halfWidth, foot * 0.5);
  return (1.0 - smoothstep(w, w * 2.0, dist)) * min(1.0, halfWidth / w);
}

/// The same prefilter for a round feature, whose coverage falls as the AREA
/// ratio rather than the width ratio.
fn stud(dist: f32, radius: f32, foot: f32) -> f32 {
  let r = max(radius, foot * 0.5);
  let cov = min(1.0, radius / r);
  return (1.0 - smoothstep(r * 0.72, r, dist)) * cov * cov;
}

/// Gain for a band that feeds the RELIEF channel or modulates gloss.
///
/// bandGain() fades a band out at a TWO pixel period, which is the right limit
/// for something sampled once per fragment. Relief is not: perturbNormal()
/// differentiates it with dpdx/dpdy, which are constant over the 2x2 fragment
/// quad, so the finest structure a bump can carry has a FOUR pixel period -
/// twice bandGain's limit - and below it the quad itself becomes the visible
/// feature. Measured: the nacelles' 12 mm turning marks at the cockpit's
/// 3.78 mm footprint are a 3.17 px grating, and beating that against the 4 px
/// quad gives 1/|1/3.17 - 1/4| = 15.3 px, which is exactly the stripe spacing
/// in the cockpit capture. reliefGain(0.012, 0.00378) = 0.0 removes it, and the
/// amplitude is handed to roughness, which is the correct trade.
///
/// Keep bandGain for pure ALBEDO bands: those take no derivative, and TAA
/// resolves them.
fn reliefGain(featureMetres: f32, foot: f32) -> f32 {
  return 1.0 - smoothstep(featureMetres * 0.125, featureMetres * 0.25, foot);
}

/// A livery edge that terminates ON a panel join.
///
/// A painted boundary that cuts a smooth arc through the middle of a plate
/// reads as a decal; a real scheme is masked plate by plate, so its edge steps
/// at every seam. Offsetting the threshold by a PER-PLATE constant does exactly
/// that for the cost of one fract(): the boundary is piecewise constant over
/// each Worley cell and jumps wherever two cells meet, which is where the seam
/// is. `t`, `edge`, `feather` and `amount` are all in whatever units `t` is.
fn liveryEdge(t: f32, edge: f32, feather: f32, jitter: f32, amount: f32) -> f32 {
  let e = edge + (jitter - 0.5) * amount;
  return smoothstep(e, e + feather, t);
}

/// The plated skin shared by the hull and the nacelle shrouds.
///
/// Evaluated in OBJECT space so the plates stay welded to the airframe however
/// it moves, and `objN` is the OBJECT-space geometric normal so that "upper
/// surface" and "underside" mean the vessel's own up and down rather than the
/// world's - a hull inverted in a barrel roll must not have its salt streaks
/// migrate to the other side.
fn platedSkin(objectPos: vec3f, objN: vec3f, wear: f32, foot: f32,
              cells: f32, seed: u32) -> Detail {
  var d : Detail;

  // ---- plate layout ------------------------------------------------------
  let w = worley3(objectPos * cells, seed, 1.0);
  // Cell units back to metres. F1 and F2 - F1 both have unit gradient, so the
  // conversion is exact and the widths above are real widths.
  let toJoin  = (w.y - w.x) / cells;
  let plateId = w.z;

  // Per-plate stock, in three families, and this is the band that carries the
  // material at every distance, so it never fades.
  //
  // THE FAMILIES ARE DELIBERATELY CLOSE IN BRIGHTNESS. What separates them is
  // mostly whether they are METAL - a bare plate carries a sky reflection and a
  // painted one does not - because a large albedo split between neighbouring
  // plates does not read as an airframe, it reads as camouflage. Real panel
  // variation on a real aircraft is a paint batch you can only see in raking
  // light, plus the occasional unpainted or composite panel.
  let batch = fract(plateId * 7.31);                // decorrelated per-plate roll
  let jitter = fract(plateId * 19.73);              // and a second, for livery edges
  // ROLLED = bare mill-finish alloy, COMPOSITE = moulded panel, PAINT = the rest.
  // The three are selected by hard thresholds on the cell id, so a plate has one
  // finish over its whole area, which is the point.
  //
  // ROLLED USED TO BE 43% AND IT HAD TO COME DOWN. Once a bare plate carries a
  // real alloy f0 against a real sky it is genuinely far brighter than the paint
  // beside it - which is correct, and which is exactly why it cannot be half the
  // hull: forty-three percent of plates picked at random to be mirrors is the
  // camouflage this comment warns about, with the contrast turned up. At 14%
  // they read as what they are, the occasional unpainted or replaced panel, and
  // the hull reads as a painted airframe.
  let rolled = step(0.75, plateId) * (1.0 - step(0.86, plateId));   // ~11%
  let composite = step(0.86, plateId);                              // ~14%
  let paint = 1.0 - rolled - composite;                             // ~75%

  // The two DIELECTRIC families, and they are now within 1.23:1 in value. They
  // used to be 2.08:1 - composite 0.072 against a bare plate's 0.150 - which is
  // the camouflage the paragraph above warns against, and with the seams
  // correctly prefiltered to invisibility at nine metres there was no line
  // anywhere to explain the step. What separates them now is FINISH: composite
  // is matte (roughness 0.55-0.67) and carries a weave; paint is semi-gloss.
  var albedo = vec3f(0.135, 0.140, 0.152) * (0.94 + 0.12 * batch) * paint
             + vec3f(0.108, 0.114, 0.107) * (0.90 + 0.20 * batch) * composite;
  // Paint and composite are dielectrics; only the mill-finish plates are metal.
  var metallic = rolled;
  // A mill finish is SATIN, not a mirror. At 0.25 the bare plates returned the
  // sunward horizon almost undimmed - measured at 25.0 renderer units against a
  // 0.42 zenith - so every one of them blew to white wherever the hull curved
  // through the reflection, and scattered white cells is camouflage again.
  var roughness = (0.36 + 0.10 * batch) * paint
                + (0.32 + 0.14 * batch) * rolled
                + (0.55 + 0.12 * batch) * composite;

  // ---- livery ------------------------------------------------------------
  // Paint only. `objectPos` is the vessel's own body space for the hull and the
  // NACELLE's own space for a duct, so the decking mask is written against the
  // object normal, which means the same thing in both.
  let painted = paint + composite;
  let deck = liveryEdge(objN.y, DECK_EDGE_N, DECK_FEATHER, jitter, DECK_JITTER);
  let nose = 1.0 - liveryEdge(objectPos.z, TRIM_NOSE_Z, TRIM_NOSE_FEATHER,
                              jitter, TRIM_NOSE_JITTER);
  albedo = mix(albedo, LIVERY_DECK, deck * painted * 0.90);
  albedo = mix(albedo, LIVERY_TRIM, nose * painted * 0.92);
  // Paint is glossier than the primer under it, and a fresh trim colour is the
  // glossiest thing on the airframe.
  roughness -= (deck * 0.05 + nose * 0.09) * painted;

  // The mill plates take their reflectance LAST, so nothing above can drag a
  // metal's f0 toward a paint value. See ALLOY_F0.
  albedo = mix(albedo, ALLOY_F0 * (0.94 + 0.10 * batch), rolled);

  // Oil-canning. F1 rising from the plate's middle to its edge IS the bow of a
  // sheet pulled down onto its frame at the joins.
  var relief = PLATE_SWELL * (0.45 - w.x);

  // ---- seams and fasteners ----------------------------------------------
  // THE VISIBLE WIDTH OF A PANEL JOIN IS NOT THE 1.5 MM GAP. It is the sealant
  // bead and the chipped paint edge either side of it, which is about 20 mm on a
  // real airframe, and that band is what makes a hull read as panelled at nine
  // metres. The hairline below is physically right and physically invisible:
  // measured at the spawn framing the vessel is 11.4 m away, one pixel is
  // 23.1 mm, the seam's coverage weight is 0.130 and its whole contribution is a
  // 2.8-code darkening against an 11.3-code plate spread. The prefilter was
  // correct and the conclusion drawn from it was wrong.
  let joinBand = scribe(toJoin, JOIN_BAND_HALF_W, foot);
  albedo *= 1.0 - joinBand * JOIN_BAND_DARKEN;
  roughness += joinBand * 0.06;

  let seam = scribe(toJoin, SEAM_HALF_W, foot);
  relief -= SEAM_DEPTH * seam;
  // A join is a shadow line as well as a groove. The coverage weighting inside
  // scribe() is what keeps this honest: at nine metres a 1.5 mm gap covers a
  // sixth of a pixel and darkens it by six percent, which is exactly how visible
  // a flush seam on a real airframe is at that range.
  albedo *= 1.0 - seam * 0.38;

  // Heads sit in a row a fixed inset in from the join at a fixed pitch along it.
  // The row parameter has to be a quantity that runs ALONG the seam; with no
  // per-plate frame available the cheap stable choice is an oblique walk through
  // object space, rotated per plate so two neighbours do not put their fasteners
  // on the same stations. Distance to the nearest head is then the hypotenuse of
  // (along the seam, across to the row).
  let along = (objectPos.x * 0.31 + objectPos.y * 0.72 + objectPos.z * 0.69)
            / RIVET_PITCH + plateId * 3.7;
  let station = abs(fract(along) - 0.5) * RIVET_PITCH;
  let across = abs(toJoin - RIVET_INSET);
  let toHead = sqrt(station * station + across * across);
  let rivet = stud(toHead, RIVET_RADIUS, foot);
  relief += RIVET_RELIEF * rivet;
  // The head itself is a fifth of a pixel at nine metres; the dirt ring around
  // it is a whole one, and it is the ring that keeps a fastener row visible.
  albedo *= 1.0 - stud(toHead, RIVET_HALO, foot) * 0.10;
  // Heads are stainless whatever the plate around them is: brighter, harder and
  // always metal, which is why a fastener row reads even on a painted panel. The
  // value here is STEEL's f0, for the same reason ALLOY_F0 is - at metallic 0.90
  // the old 0.168 made every rivet head a very dark mirror.
  albedo = mix(albedo, STEEL_F0, rivet * 0.65);
  metallic = mix(metallic, 0.90, rivet * 0.65);

  // ---- rolling grain -----------------------------------------------------
  // Mill grooves running along the plate's own stock direction. Two plates side
  // by side catch the light differently because their grain runs differently,
  // which is the whole reason to key the direction on the plate id.
  // The stock direction comes from `batch`, not from plateId: plateId already
  // decided the FINISH, so keying the angle on it too would give every bare plate
  // in the world a grain within the same 150 degree wedge.
  let ang = batch * TAU;
  let ca = cos(ang);
  let sa = sin(ang);
  // reliefGain, not bandGain: this band drives BOTH the bump and the gloss, and
  // both are read through the 2x2 derivative quad. See reliefGain().
  let grainGain = reliefGain(GRAIN_PITCH, foot);
  let gu = (objectPos.x * ca + objectPos.z * sa) / GRAIN_PITCH;
  let gv = (objectPos.z * ca - objectPos.x * sa + objectPos.y * 0.61)
         / (GRAIN_PITCH * GRAIN_ANISO);
  let grain = gradientQuick2(vec2f(gu, gv), SEED_GRAIN) * rolled;
  relief += GRAIN_RELIEF * grain * grainGain;
  // Resolved, the grain modulates gloss along its length; unresolved, its whole
  // amplitude becomes roughness. Only the bare rolled plates have a mill grain -
  // paint fills it and composite was never rolled.
  roughness += rolled * GRAIN_ROUGHNESS * (1.0 - grainGain)
             - 0.030 * grain * grainGain;

  // ---- composite mottle --------------------------------------------------
  let weaveGain = reliefGain(WEAVE_PITCH, foot) * composite;
  var weave = 0.0;
  if (weaveGain > 0.004) { weave = fbmCheap3(objectPos * (1.0 / WEAVE_PITCH), SEED_WEAVE); }
  relief += WEAVE_RELIEF * weave * weaveGain;
  albedo *= 1.0 + 0.16 * weave * weaveGain;

  // ---- staining and edge wear -------------------------------------------
  // Salt dries where water sits and nothing scrubs it: in the seams, at the
  // plate edges, under every head, and preferentially on the undersides where
  // spray runs and never dries in the sun.
  let stain = fbmCheap3(objectPos * (1.0 / STAIN_SCALE), SEED_STAIN) * 0.5 + 0.5;
  let underside = saturate(-objN.y);
  let sunward = saturate(objN.y);
  let edge = saturate(1.0 - toJoin / EDGE_WEAR_BAND);         // 1 on the join
  // Anodising and paint thin from the edge inward. WHAT IS UNDERNEATH IS THE
  // ALLOY, not grey primer - a worn plate edge on a real airframe is the part
  // that catches the sky, which is why edge wear reads at all. A bare mill plate
  // has nothing to lose, so it only gets rougher. Handing everything a light
  // grey dielectric instead was a second route to the same flat-clay result the
  // 0.150 metal albedo produced.
  let scuff = saturate(edge * edge * (EDGE_WEAR_FLOOR + wear) * (0.55 + 0.75 * stain));
  let strip = scuff * 0.55 * (1.0 - rolled);
  albedo = mix(albedo, ALLOY_F0 * 0.88, strip);
  metallic = max(metallic, strip);
  // The upper surfaces bleach where the sun sits on them all day; that IS a
  // paint effect and stays a lightening.
  let bleach = sunward * 0.10 * (EDGE_WEAR_FLOOR + wear) * (1.0 - rolled);
  albedo = mix(albedo, vec3f(0.200, 0.202, 0.206), bleach);
  roughness += (scuff + bleach) * 0.22;

  // Biofouling. A green-brown film wherever water lingers, biased into the
  // seams and onto the undersides, and DIELECTRIC: where it grows the surface
  // stops being metal, which is the strongest cue that a vessel has spent real
  // time in the water. It vanishes entirely at wear 0 - a clean hull is clean.
  let bioMask = saturate(wear * (0.30 + 0.45 * edge + 0.35 * underside));
  let bio = bioMask * smoothstep(0.42, 0.86, stain);
  albedo = mix(albedo, vec3f(0.058, 0.074, 0.045), bio * 0.85);
  metallic *= 1.0 - bio * 0.92;
  roughness += bio * 0.30;

  // Ambient occlusion follows the geometry the relief just described: the seams
  // and the gaps around the heads are where ambient light cannot reach.
  d.ao = saturate(1.0 - seam * 0.55 - rivet * 0.20 - bio * 0.25);
  d.albedo = albedo;
  d.metallic = saturate(metallic);
  d.roughness = clamp(roughness, MIN_PERCEPTUAL_ROUGHNESS, 1.0);
  d.relief = relief;
  return d;
}

/// Hull skin: the plated stock at airframe pitch.
fn hullDetail(objectPos: vec3f, objN: vec3f, wear: f32, foot: f32) -> Detail {
  return platedSkin(objectPos, objN, wear, foot, PLATE_CELLS, SEED_PLATE);
}

/// Nacelle shroud: the plated skin at a finer plate pitch, plus the concentric
/// turning marks a lathed duct actually carries around its thrust axis.
fn nacelleDetail(objectPos: vec3f, objN: vec3f, wear: f32, foot: f32) -> Detail {
  var d = platedSkin(objectPos, objN, wear, foot, NACELLE_CELLS, SEED_PLATE ^ 0x1111u);
  let r = length(objectPos.xz);
  // ON THE DUCT ONLY. buildNacelle emits the lathed shroud AND the swept pylon
  // stub into one part, and a pylon is not a turned part - concentric marks
  // centred on the thrust axis have no business on it. The duct wall spans
  // r 0.50-0.62 and the pylon r 0.11-0.33, so 0.40 separates them cleanly.
  let onDuct = smoothstep(0.38, 0.42, r);
  // reliefGain, not bandGain: see reliefGain(). At the cockpit's 3.78 mm
  // footprint this band is a 3.17 px grating and it beat with the derivative
  // quad into a 15 px moire across both forward nacelles; reliefGain takes it
  // to exactly zero there and hands its whole amplitude to roughness.
  let turnGain = reliefGain(TURN_PITCH, foot) * onDuct;
  let turn = cos(r * (TAU / TURN_PITCH));
  d.relief += TURN_RELIEF * turn * turnGain;
  // Same trade as the rolling grain: gloss modulation while resolved, roughness
  // once it is not.
  d.roughness = clamp(d.roughness + TURN_ROUGHNESS * onDuct * (1.0 - turnGain)
                    - 0.045 * turn * turnGain,
                      MIN_PERCEPTUAL_ROUGHNESS, 1.0);

  // The inlet lip in the trim colour. An orange ring around each duct is the
  // single strongest silhouette cue the vessel has, in air and underwater, and
  // it is a real convention - a ducted fan's lip is where the danger is.
  // buildNacelle puts the lip at y > CHORD*0.5 - LIP = 0.215.
  let lip = smoothstep(0.205, 0.225, objectPos.y) * smoothstep(0.38, 0.44, r);
  d.albedo = mix(d.albedo, LIVERY_TRIM, lip * 0.92);
  d.metallic *= 1.0 - lip * 0.92;
  d.roughness = clamp(mix(d.roughness, 0.30, lip * 0.92),
                      MIN_PERCEPTUAL_ROUGHNESS, 1.0);
  return d;
}

/// Grit scuffing on the skid shoes: feature size and depth, metres.
const SKID_SCUFF_SCALE  : f32 = 0.11;
const SKID_SCUFF_RELIEF : f32 = 0.0006;

/// Skid shoes: glass-filled nylon, dark and dielectric, polished flat on the
/// underside where they have taken the vessel's weight on grit.
fn skidDetail(objectPos: vec3f, objN: vec3f, foot: f32) -> Detail {
  var d : Detail;
  let gain = bandGain(SKID_SCUFF_SCALE, foot);
  var scuff = 0.0;
  if (gain > 0.004) { scuff = fbmCheap3(objectPos * (1.0 / SKID_SCUFF_SCALE), 0x71a3u); }
  let ground = saturate(-objN.y);
  d.albedo = vec3f(0.040, 0.041, 0.043) * (1.0 + 0.22 * scuff * gain)
           * mix(1.0, 0.78, ground);
  d.metallic = 0.06;
  // The wear face is burnished; the rest keeps its moulded matte finish.
  d.roughness = clamp(mix(0.68, 0.34, ground) + 0.10 * scuff * gain,
                      MIN_PERCEPTUAL_ROUGHNESS, 1.0);
  // The albedo term keeps bandGain; the RELIEF term needs reliefGain, because
  // the bump is read through the 2x2 derivative quad and dies two octaves
  // earlier than a directly sampled band.
  d.relief = SKID_SCUFF_RELIEF * scuff * reliefGain(SKID_SCUFF_SCALE, foot);
  d.ao = saturate(0.82 - 0.10 * ground);
  return d;
}

/// Rotor blades: moulded composite, black, semi-gloss. No relief worth
/// resolving on something that spends its working life as a blurred disc.
fn rotorDetail() -> Detail {
  var d : Detail;
  d.albedo = vec3f(0.030, 0.031, 0.034);
  d.metallic = 0.10;
  d.roughness = 0.26;
  d.relief = 0.0;
  d.ao = 0.72;
  return d;
}

/// Canopy: laminated glass in a metal frame.
///
/// It stays in the OPAQUE pass. The Fresnel rim and the reflected sky are what
/// read as glass, not the transmission, and a transparent canopy would have to
/// sort against the ocean surface and the volumetrics for no visible gain. What
/// it does need is a FRAME and an EDGE - one smooth dark dome reads as painted
/// plastic, and two mullions plus a thick green laminate edge turn it back into
/// glazing.
///
/// `uv.y` runs from the sill (0) to the apex (1) and `uv.x` is azimuth, so the
/// fore-aft centre rib is the meridian through u = 0.25 and u = 0.75 - one great
/// circle over the apex, exactly where a canopy's keel runs.
///
/// This is the one material whose features are laid out in UV rather than in
/// object space, so its filtering comes from fwidth(uv) directly instead of from
/// pixelFootprint(): the mullions are a fixed fraction of the canopy, not a
/// fixed number of millimetres.
fn canopyDetail(uv: vec2f) -> Detail {
  var d : Detail;

  let keelDist = abs(fract(uv.x * 2.0) - 0.5) * 0.5;
  // Mullion widths are floored at the UV footprint so they stay at least a pixel
  // wide at any range instead of breaking into a dashed line. The fract() above
  // is discontinuous exactly on the keel, which is why the width comes from
  // fwidth(uv.x) and never from the folded coordinate.
  let wKeel = max(CANOPY_KEEL_HALF_W, fwidth(uv.x));
  let wSill = max(CANOPY_SILL_HALF_W, fwidth(uv.y));
  let frame = max(1.0 - smoothstep(wKeel, wKeel * 1.9, keelDist),
                  1.0 - smoothstep(wSill, wSill * 1.9, uv.y));

  // Glass: near-zero albedo and a mirror finish, so everything seen in it is
  // reflection. A laminated pane is thickest at the sill, where the interlayer
  // absorbs enough to go green - the standard tell of real glazing.
  let sill = 1.0 - smoothstep(0.0, 0.34, uv.y);
  let glassAlbedo = mix(vec3f(0.006, 0.008, 0.010), vec3f(0.004, 0.014, 0.010), sill);
  let glassRough = mix(0.038, 0.13, sill);

  d.albedo = mix(glassAlbedo, vec3f(0.052, 0.055, 0.058), frame);
  d.metallic = frame * 0.55;
  d.roughness = clamp(mix(glassRough, 0.42, frame), MIN_PERCEPTUAL_ROUGHNESS, 1.0);
  // The frame stands proud of the pane, which is what catches a highlight along
  // the keel and reads the canopy as an assembly rather than a shell.
  d.relief = CANOPY_FRAME_RELIEF * frame;
  d.ao = saturate(1.0 - sill * 0.30 - frame * 0.15);
  return d;
}

/// Cockpit interior: anti-glare moulding, machined console faces, a dark floor,
/// and the instrument fascia.
///
/// `uv.y` is the CAVITY term the generator baked in - 0 at the open lip, 1 on
/// the floor - and it is exact, because the shell is generated in code. It is
/// what makes the interior read as an enclosed volume rather than as folded
/// card, and it is the reason nothing here needs a screen-space AO pass to work.
///
/// The glareshield is the DARKEST thing on the vessel on purpose: a real one is
/// near-black so that it does not reflect in the canopy in front of the pilot.
fn cabinDetail(objectPos: vec3f, uv: vec2f, foot: f32) -> Detail {
  var d : Detail;
  let cavity = uv.y;

  // Console faces are the near-vertical side walls; the fascia is the shallow
  // canted panel ahead of the pilot. VESSEL.COCKPIT_EYE sits at z = -0.35, so
  // everything forward of -0.85 is in front of him.
  let side = smoothstep(0.26, 0.40, abs(objectPos.x));
  let fwd  = smoothstep(-0.80, -1.05, objectPos.z);
  let floorward = smoothstep(0.30, 0.17, objectPos.y);

  // Anti-glare moulding: near-black, matte, and it owns the lip and the fascia
  // surround. AN AIRCRAFT COCKPIT IS THE DARKEST PLACE ON THE AIRFRAME and that
  // is not a style choice - anything light in front of the pilot reflects in the
  // canopy and sits between him and the horizon.
  var albedo = vec3f(0.026, 0.029, 0.028);
  var rough = 0.76;
  var metal = 0.0;

  // Console cheeks: the same dark grey a degree lighter and a degree glossier,
  // so they separate from the moulding by FINISH rather than by value. They are
  // PAINTED, not bare - a polished console would mirror the sky straight into
  // the pilot's eye, and rendered as a 0.72 f0 mirror it turned the whole
  // interior into a white bowl.
  let console = side * (1.0 - floorward);
  albedo = mix(albedo, vec3f(0.052, 0.055, 0.056), console);
  rough = mix(rough, 0.44, console);

  // Floor: dark, moulded, and scuffed by boots.
  albedo = mix(albedo, vec3f(0.032, 0.032, 0.034), floorward);
  rough = mix(rough, 0.70, floorward);

  // A machined rail capping the coaming lip. This IS bare metal, so the value is
  // an f0, and it is the one bright line in the cabin: it draws the edge between
  // the interior and the world, which a uniformly dark tub cannot do.
  let rail = 1.0 - smoothstep(0.020, 0.075, cavity);
  albedo = mix(albedo, ALLOY_F0 * 0.90, rail);
  rough = mix(rough, 0.32, rail);
  metal = max(metal, rail);

  // A milled grain across the console faces, 3 mm pitch, gated by reliefGain so
  // it cannot become the derivative quad at cockpit range the way the nacelles'
  // turning marks did.
  let millGain = reliefGain(0.003, foot) * console;
  let mill = cos(objectPos.z * (TAU / 0.003));
  d.relief = 0.00004 * mill * millGain;
  rough += 0.05 * console * (1.0 - millGain);

  d.albedo = albedo;
  d.roughness = clamp(rough, MIN_PERCEPTUAL_ROUGHNESS, 1.0);
  d.metallic = saturate(metal);
  // A cockpit tub is a hole, and it is a hole under a hull and a canopy: even
  // the lip sees only about half the sky, and the footwell sees almost none.
  // With the bowl handed a full hemisphere it rendered as bright as the beach.
  d.ao = saturate(mix(0.55, 0.16, cavity));
  return d;
}

/// Instrument fascia glow. Teal, matching UI_COLORS.instrument and the canopy's
/// own CANOPY_INTERIOR term, so the glass and the panel behind it agree.
const CABIN_INSTRUMENT : vec3f = vec3f(0.06, 0.30, 0.27);

// ---------------------------------------------------------------------------
// Pelagos Habitat
// ---------------------------------------------------------------------------
//
// THESE FOUR MATERIALS READ THEIR uv IN METRES, not in [0,1]. habitat_mesh.js
// rescales every part's UVs at build time (`metreUV`) so that u is arc length
// around a shell and v is distance along its axis. That is the only thing that
// makes one panel pitch correct on a 6.4 m module, a 1.6 m corridor and a flat
// deck at once - a normalised v would put four ribs on the corridor and four on
// the module, at wildly different real pitches - and it lets every band below
// filter against pixelFootprint() in the same units, exactly as the vessel's
// object-space bands do.
//
// Sizes are chosen for the range this building is actually seen at. The
// approach frames it from 25-50 m, where one pixel is 25-50 mm; the hatch is
// read from 2-4 m. So the structure-carrying bands are the 1.15 m panel grid
// and the 1.60 m stiffener rings, both of which survive the whole approach, and
// everything finer hands itself to roughness on the way in.

/// Panel joint pitch across (u) and along (v) a habitat shell, metres.
const HAB_PANEL_U     : f32 = 1.15;
const HAB_PANEL_V     : f32 = 1.60;
/// Welded joint half-width and how much it darkens. A habitat is welded, not
/// riveted: the line is wider and softer than the vessel's scribed seam and
/// there are no fastener rows anywhere on it.
const HAB_WELD_HALF_W : f32 = 0.016;
const HAB_WELD_DARKEN : f32 = 0.26;
/// External stiffener ring: how proud it stands and how wide it is, metres. A
/// ring frame is the single most recognisable feature of a pressure vessel.
const HAB_RIB_RELIEF  : f32 = 0.010;
const HAB_RIB_HALF_W  : f32 = 0.085;
/// Biofouling. Scale of the patch field and how far a streak is stretched
/// downward relative to it.
const HAB_FOUL_SCALE  : f32 = 0.85;
const HAB_FOUL_STRETCH: f32 = 5.5;
/// What settles on a submerged structure: a living algal film.
///
/// It puts VALUE VARIATION on a bright building, and value variation is what
/// survives an optical veil - a uniformly bright object at 30 m in Sand Plains
/// water is the same code as the water behind it. But the dark olive this
/// replaces was ALSO the cheapest colour available and was not being spent: at
/// 0.052/0.061/0.040 it delivered hue 215 degrees at 4 m, i.e. the water's own
/// hue, so a large patchy field that is already implemented, already sharpened
/// into patches and already weighted by objN.y contributed no chroma at all.
///
/// A real chlorophyll albedo delivers hue 191 at 4 m and holds 191-208 across the
/// whole range sweep, against a 1 : 1.4 : 6 blue key. It is the highest
/// colour-per-instruction change on the exterior.
const HAB_FOUL_TINT   : vec3f = vec3f(0.055, 0.145, 0.028);

/// Painted pressure-hull panel: the modules, corridors, deck and legs.
///
/// The part's `tint` carries the paint colour, so this one function skins the
/// bone-white shells, the deep petrol roof caps and the near-black leg tubes -
/// the value split between them is the silhouette, and it is authored in
/// habitat_mesh.js where the geometry is, not buried here.
fn habPanelDetail(objectPos: vec3f, objN: vec3f, uv: vec2f, foot: f32) -> Detail {
  var d : Detail;

  // Marine paint over composite: a dielectric, semi-gloss, and never metal.
  var albedo = vec3f(1.0);
  var rough = 0.42;

  // ---- panel grid --------------------------------------------------------
  // Distance to the nearest joint in each axis, in metres, so scribe() gets a
  // real width and prefilters itself.
  let du = abs(fract(uv.x / HAB_PANEL_U + 0.5) - 0.5) * HAB_PANEL_U;
  let dv = abs(fract(uv.y / HAB_PANEL_V + 0.5) - 0.5) * HAB_PANEL_V;
  let weld = max(scribe(du, HAB_WELD_HALF_W, foot), scribe(dv, HAB_WELD_HALF_W, foot));
  albedo *= 1.0 - weld * HAB_WELD_DARKEN;
  rough += weld * 0.08;

  // ---- stiffener rings ---------------------------------------------------
  // A raised ring frame on every second panel joint along the axis. reliefGain,
  // not bandGain: this is read through the derivative quad by perturbNormal and
  // dies two octaves before a directly sampled band would.
  let dRing = abs(fract(uv.y / (HAB_PANEL_V * 2.0) + 0.5) - 0.5) * (HAB_PANEL_V * 2.0);
  let ring = 1.0 - smoothstep(HAB_RIB_HALF_W * 0.5, HAB_RIB_HALF_W, dRing);
  d.relief = HAB_RIB_RELIEF * ring * reliefGain(HAB_RIB_HALF_W * 2.0, foot);
  // A proud edge collects wear and loses gloss even where the bump is gone.
  rough += ring * 0.05;

  // ---- per-panel paint batch --------------------------------------------
  // Whole-panel value jitter, tiny on purpose. Real repainted panels differ by
  // a percent or two; anything more is the camouflage platedSkin warns about,
  // and this building has far more area than the vessel to make it out of.
  let cell = vec2f(floor(uv.x / HAB_PANEL_U), floor(uv.y / HAB_PANEL_V));
  let batch = hash12(cell);
  albedo *= 0.965 + 0.07 * batch;

  // ---- biofouling --------------------------------------------------------
  // Growth settles from above and runs DOWN, so the field is stretched in world
  // y and weighted by how up-facing the surface is. Horizontal surfaces silt up;
  // an overhang stays clean, which is why the underside of the deck reads as
  // structure and the top of it reads as neglected.
  let fp = vec3f(objectPos.x, objectPos.y / HAB_FOUL_STRETCH, objectPos.z)
         * (1.0 / HAB_FOUL_SCALE);
  let foulGain = bandGain(HAB_FOUL_SCALE, foot);
  var foul = 0.0;
  if (foulGain > 0.004) {
    foul = saturate(fbmCheap3(fp, 0x9d27u) * 0.5 + 0.5);
    // Sharpen into patches with clean paint between them rather than a uniform
    // grey wash, which would only lower contrast - the opposite of the point.
    foul = smoothstep(0.36, 0.80, foul) * foulGain;
  }
  // Up-facing surfaces foul most, vertical ones streak, overhangs stay clean.
  let settle = saturate(0.30 + 0.70 * objN.y);
  foul *= settle;
  albedo = mix(albedo, HAB_FOUL_TINT, foul * 0.72);
  rough = mix(rough, 0.88, foul * 0.85);

  d.albedo = albedo;
  d.metallic = 0.0;
  d.roughness = clamp(rough, MIN_PERCEPTUAL_ROUGHNESS, 1.0);
  // The ring frames shade their own recesses; the fouling sits in them.
  d.ao = saturate(1.0 - weld * 0.35 - foul * 0.30);
  return d;
}

/// Glazing pane pitch and mullion half-width, metres. A 0.95 m pane in a 40 mm
/// frame is real architectural glazing and it is what the window BANDS on the
/// modules and the panels of the commons dome are both cut into.
const HAB_PANE_PITCH  : f32 = 0.95;
const HAB_MULLION_HW  : f32 = 0.040;
const HAB_MULLION_REL : f32 = 0.022;

/// The mullion grid shared by the exterior glazing and the interior viewport,
/// so a pane and the pane behind it line up instead of moireing against
/// each other. Returns coverage in [0, 1].
fn habMullion(uv: vec2f, foot: f32) -> f32 {
  let du = abs(fract(uv.x / HAB_PANE_PITCH + 0.5) - 0.5) * HAB_PANE_PITCH;
  let dv = abs(fract(uv.y / HAB_PANE_PITCH + 0.5) - 0.5) * HAB_PANE_PITCH;
  return max(scribe(du, HAB_MULLION_HW, foot), scribe(dv, HAB_MULLION_HW, foot));
}

/// What a pressure port lets through, as an OPACITY.
///
/// Thick laminated glazing at 33 m, fouled on its wet face, is nowhere near
/// clear - and the number is doing visual work as well as physical. Its
/// predecessor was an emissive fake: a constant warm patch outward
/// (HAB_ROOM_SPILL) and an analytic water colour inward (habViewportRadiance),
/// neither of which ever sampled anything. Both are gone; the room seen from the
/// sea and the sea seen from the room are the real geometry now, and this is the
/// only knob between them.
///
/// It is a TRANSMITTANCE, never a gain. At full transmittance the panes metered
/// brighter than the lit room around them, which walks them up the AgX shoulder
/// and takes their colour with it - the commons band read pale lavender at 1.0
/// and sea-blue at 0.5 on the same scene. That is CLAUDE.md's "a brighter object
/// is a whiter one" again, and the lever is reflectance, not exposure.
const HAB_PANE_OPACITY : f32 = 0.40;

/// Fresnel F0 for the two faces of the same pane, and they are NOT one number.
///
/// The outward skin is a glass/WATER interface: n 1.52 against 1.333 gives
/// ((1.52-1.333)/(1.52+1.333))^2 = 0.0043, so from outside a pane barely
/// reflects at all and what you see through it is the room. The inward skin is
/// glass/AIR at 0.043, ten times more, so from the commons the pane catches the
/// lit room at grazing angles - which is what reads as glass. This is what the
/// two materials are for.
const GLASS_F0_WATER : f32 = 0.0043;
const GLASS_F0_AIR   : f32 = 0.043;

/// Exterior glazing: module window bands, the commons dome, the hatch porthole.
///
/// DRAWN TRANSPARENT, in the `glazing` pass after the underwater composite - see
/// makeGlazingPass in render/passes/entities.js for why it cannot be drawn with
/// the rest of the entities and why the blend algebra closes exactly. What this
/// function still owns is the mullion grid, the frame metal and the roughness;
/// the alpha is assembled in fs_entity from habMullion() and the Fresnel term.
fn habGlassDetail(uv: vec2f, foot: f32) -> Detail {
  var d : Detail;
  let frame_ = habMullion(uv, foot);

  // Laminated pane: almost no albedo and a near-mirror finish, so everything
  // seen in it is reflection.
  let paneAlbedo = vec3f(0.008, 0.013, 0.016);
  // Anodised dark frame. Metal, so this value is an f0.
  let frameAlbedo = STEEL_F0 * 0.30;

  d.albedo = mix(paneAlbedo, frameAlbedo, frame_);
  d.metallic = frame_ * 0.85;
  // 0.10, NOT a mirror. At 0.055 a point lamp a metre off the hatch put a
  // one-pixel specular on the porthole that AgX clipped to a white star with a
  // bloom halo - the same "yellow sun" read the rebuild is removing, arriving
  // by a different route. Real toughened glazing at depth is never optically
  // flat anyway: it is thick, slightly wavy, and it fouls.
  d.roughness = clamp(mix(0.10, 0.38, frame_), MIN_PERCEPTUAL_ROUGHNESS, 1.0);
  d.relief = HAB_MULLION_REL * frame_ * reliefGain(HAB_MULLION_HW * 2.0, foot);
  d.ao = saturate(1.0 - frame_ * 0.22);
  return d;
}

/// Interior face of the same glazing: the frame you look at the sea through.
///
/// It used to carry habViewportRadiance(), which SYNTHESISED the sea from
/// applyWaterMediumFast() against black over a fixed 60 m path - a flat analytic
/// fill with no seabed, no creatures and no light shafts in it, and a window
/// band that was the same colour top to bottom. The pane transmits now, so the
/// sea behind it is the sea.
fn habViewportDetail(uv: vec2f, foot: f32) -> Detail {
  var d : Detail;
  let frame_ = habMullion(uv, foot);
  // Inboard mullions are painted, not anodised - you are looking at the inside
  // of the window frame.
  d.albedo = mix(vec3f(0.004, 0.006, 0.008), vec3f(0.075, 0.079, 0.082), frame_);
  d.metallic = 0.0;
  d.roughness = clamp(mix(0.09, 0.55, frame_), MIN_PERCEPTUAL_ROUGHNESS, 1.0);
  d.relief = HAB_MULLION_REL * frame_ * reliefGain(HAB_MULLION_HW * 2.0, foot);
  d.ao = saturate(1.0 - frame_ * 0.25);
  return d;
}

/// Ceiling cove glow, and the gain that scales it. Warm, and deliberately
/// modest: it is a lit SURFACE, not a lamp, so it has to sit under the punctual
/// interior lights rather than compete with them.
const HAB_COVE      : vec3f = vec3f(0.98, 0.82, 0.62);
/// 0.34, not 0.055, AND IT IS NOT A BRIGHTNESS KNOB. The cove is emissive on
/// DOWN-FACING interior faces only, so unlike a punctual lamp it cannot leak
/// through the shell it sits in - which is what lets it carry the share of the
/// room that the interior lamps give up (see habitat.js). At this gain it
/// delivers scene [0.333, 0.279, 0.211], well under the AgX shoulder; the
/// console faces at emission 1.15 are what happens above it.
const HAB_COVE_GAIN : f32   = 0.34;

/// Height of the interior dado rail above the room floor, metres, and the floor
/// plane itself in habitat object space. habitat_mesh.js puts the walkable slab
/// top at y = 0.20, and HABITAT_SITE.interior.floorY is that same plane.
const HAB_FLOOR_Y  : f32 = 0.20;
const HAB_DADO_Y   : f32 = 1.05;
const HAB_DADO_HW  : f32 = 0.055;

/// Dry interior surfaces: floor, wall and ceiling from ONE material, selected by
/// the object-space normal.
///
/// Selecting on the normal rather than shipping three materials is what keeps
/// the room's parts mergeable: the interior is built from box slabs whose faces
/// already point the right way, so a floor slab's top is a floor and its
/// underside is the ceiling of nothing, for free. cabinDetail() is not usable
/// here for the opposite reason to hullDetail(): a cockpit is deliberately the
/// darkest place on an airframe (albedo 0.026) so it will not reflect in the
/// canopy, and a habitat's commons is a lit white room.
fn habInteriorDetail(objectPos: vec3f, objN: vec3f, foot: f32) -> Detail {
  var d : Detail;
  let up = saturate(objN.y);
  let down = saturate(-objN.y);
  let side = saturate(1.0 - up - down);

  // ---- wall --------------------------------------------------------------
  // Light warm panelling above a mid-grey dado, split by a painted rail. The
  // rail is the one horizontal line in the room and it is what gives a
  // 4 m box a readable eye height.
  let above = step(HAB_DADO_Y, objectPos.y - HAB_FLOOR_Y);
  var albedo = mix(vec3f(0.175, 0.150, 0.115), vec3f(0.340, 0.300, 0.235), above);
  var rough = mix(0.62, 0.46, above);
  let rail = 1.0 - smoothstep(HAB_DADO_HW, HAB_DADO_HW * 2.0,
                              abs(objectPos.y - HAB_FLOOR_Y - HAB_DADO_Y));
  albedo = mix(albedo, vec3f(0.150, 0.078, 0.032), rail * 0.9);
  rough = mix(rough, 0.34, rail * 0.9);
  // Vertical wall panel joints, in habitat object metres. The interior is
  // axis-aligned by construction (HABITAT_SITE.yaw is 0), so the joint runs on
  // whichever horizontal axis the wall does not face.
  let along = mix(objectPos.x, objectPos.z, step(0.5, abs(objN.x)));
  let dj = abs(fract(along / 1.20 + 0.5) - 0.5) * 1.20;
  let joint = scribe(dj, 0.010, foot);
  albedo *= 1.0 - joint * 0.30;

  // ---- floor -------------------------------------------------------------
  // Dark non-slip plate with a raised tread grid. Dark, because a bright floor
  // bounces the interior lamps back into the ceiling and flattens the room -
  // the same failure cabinDetail's "white bowl" comment records.
  // Warm-biased and lifted. The old value was blue-biased and delivered hue 244
  // at saturation 0.56 - the single most lavender surface in the room.
  var fAlbedo = vec3f(0.060, 0.050, 0.038);
  let tx = abs(fract(objectPos.x / 0.42 + 0.5) - 0.5) * 0.42;
  let tz = abs(fract(objectPos.z / 0.42 + 0.5) - 0.5) * 0.42;
  let tread = max(scribe(tx, 0.014, foot), scribe(tz, 0.014, foot));
  fAlbedo *= 1.0 + tread * 0.55;
  let fRough = 0.66 - tread * 0.12;

  // ---- ceiling -----------------------------------------------------------
  // Off-white acoustic panel, matte, brighter than the walls so the lamps in it
  // read as coves rather than as bare bulbs.
  let cAlbedo = vec3f(0.375, 0.345, 0.285);
  let cRough = 0.78;

  d.albedo = albedo * side + fAlbedo * up + cAlbedo * down;
  d.roughness = clamp(rough * side + fRough * up + cRough * down,
                      MIN_PERCEPTUAL_ROUGHNESS, 1.0);
  d.metallic = 0.0;
  d.relief = 0.0018 * tread * up * reliefGain(0.028, foot);
  // REAL GEOMETRIC AO, and it used to be 0.26 of it.
  //
  // That 0.26 was written against "the sky ambient has no depth term, so a
  // sealed room 33 m down is handed the full noon sky" - a defect that had
  // ALREADY BEEN FIXED when it was authored. common/lighting.wgsl multiplies
  // both ambient lobes by daylightAtDepth(pointDepth); the magnitude was never
  // the problem. So the constant was compensation stacked on a working depth
  // term: it cut the room's brightness 3.85x and did nothing whatever to the
  // 1 : 4.1 blue cast it was written to remove.
  //
  // Raising it back ALONE would only have made the room bluer, because what is
  // left down here is 90% sky. It comes back at the same time as
  // HAB_ROOM_BOUNCE, which replaces that sky with the room's own paint; the two
  // are one change and either half on its own measures worse.
  d.ao = 0.85 * saturate(1.0 - up * 0.22 - joint * side * 0.20);
  return d;
}

/// Mikkelsen surface-gradient bump: perturb a normal by the screen derivatives
/// of a scalar height field, with no tangent frame required. The vessel HAS a
/// tangent frame, but the procedural detail is a function of object-space
/// position rather than of UV, so differentiating the UV would be wrong.
///
/// `relief` and `P` are in the SAME units - metres - because the |det| factor
/// cancels the pixel footprint out of the ratio and what is left is the true
/// d(relief)/d(position). That is why `scale` is 1.0 at the one call site: at
/// unit scale this returns the exact bump normal of the relief field, and any
/// other value is a lie about how deep the surface is.
fn perturbNormal(N: vec3f, P: vec3f, relief: f32, scale: f32) -> vec3f {
  let dpx = dpdx(P);
  let dpy = dpdy(P);
  let r1 = cross(dpy, N);
  let r2 = cross(N, dpx);
  let det = dot(dpx, r1);
  let surfGrad = sign(det) * (dpdx(relief) * r1 + dpdy(relief) * r2);
  return normalize(abs(det) * N - scale * surfGrad);
}

// ---------------------------------------------------------------------------
// Fragment
// ---------------------------------------------------------------------------

struct FragOut {
  @location(0) color    : vec4f,
  @location(1) velocity : vec2f,
  /// SIGNED hull crossing, metres. See the dryPath declaration in
  /// render/renderer.js for the target and pass/underwater.wgsl for the consumer.
  ///
  /// THE DRY PART OF A VIEW RAY IS A SEGMENT, NOT A PREFIX, and that is why this
  /// is a signed distance rather than a mask. While the glazing was opaque no
  /// camera could see an interior surface from outside the hull, so "this pixel
  /// is dry" implied "the whole ray was dry" and a flag would have done. The
  /// moment a pane transmits, a diver at 33 m looks straight into the commons
  /// and a prefix claims that ray never touched water - an unfogged white room
  /// floating in the sea, which is exactly what passes/entities.js already warns
  /// about.
  ///
  /// So each fragment contributes a signed crossing and the target SUMS them:
  ///   a dry opaque surface      +viewDist   the ray ends inside the bubble
  ///   habitat GLASS   (mat 8)   -viewDist   the ray ENTERED the bubble here
  ///   habitat VIEWPORT (mat 9)  +viewDist   the ray LEFT the bubble here
  /// and `dist - sum` is the wet length, for an eye on either side and for any
  /// number of hulls in between.
  ///
  /// The sign is free, because moduleShell()'s `inward: true` reverses normals
  /// AND winding: under back-face culling a front-facing mat-8 fragment is
  /// always an entry and a front-facing mat-9 fragment is always an exit. The
  /// glazing writes no depth, so its layers are unordered - which is precisely
  /// why the accumulation has to be a SUM and not a replace.
  @location(2) dryPath  : f32,
  /// The SSAO gate: this pixel's delivered ambient share. See aoGate() in
  /// common/water.wgsl. Instrument glow, lamp lenses and the cove strip are in
  /// the denominator only, so emissives keep their radiance under SSAO.
  @location(3) gate     : f32,
};

@fragment
fn fs_entity(in: VSOut) -> FragOut {
  let P = in.worldPos;
  let absPos = toAbsolute(P);
  let depth = seaLevel() - absPos.y;              // positive underwater

  let toEye = frame.cameraPos.xyz - P;
  let viewDist = length(toEye);
  let V = toEye / max(viewDist, 1e-4);

  let geoN = normalize(in.normal);
  let material = entity.params.x;
  let wear = entity.params.y;

  // One pixel's worth of world, metres. Every detail band below is filtered
  // against this rather than against viewDist, so a hull raked by the view loses
  // its fine bands at the range the screen actually stops resolving them.
  let foot = pixelFootprint(P);

  // OBJECT-space geometric normal. The node matrices are rigid with unit scale,
  // so the inverse rotation is the transpose and this is three dot products
  // against its columns. Wanted because "upper surface" and "underside" have to
  // mean the VESSEL's up and down: keyed on the world normal, every salt streak
  // would migrate to the other side of the hull through a barrel roll.
  let objN = normalize(vec3f(dot(entity.model[0].xyz, geoN),
                             dot(entity.model[1].xyz, geoN),
                             dot(entity.model[2].xyz, geoN)));

  var d : Detail;
  if (material < 0.5) {
    d = hullDetail(in.objectPos, objN, wear, foot);
  } else if (material < 1.5) {
    d = canopyDetail(in.uv);
  } else if (material < 2.5) {
    d = nacelleDetail(in.objectPos, objN, wear, foot);
  } else if (material < 3.5) {
    d = rotorDetail();
  } else if (material < 4.5) {
    d = skidDetail(in.objectPos, objN, foot);
  } else if (material < 5.5) {
    // Emissive trim: the lamp lenses. Almost black unlit, and the whole read
    // comes from the emissive term added after lighting.
    d.albedo = vec3f(0.02);
    d.metallic = 0.0;
    d.roughness = 0.4;
    d.relief = 0.0;
    d.ao = 1.0;
  } else if (material < 6.5) {
    d = cabinDetail(in.objectPos, in.uv, foot);
  } else if (material < 7.5) {
    d = habPanelDetail(in.objectPos, objN, in.uv, foot);
  } else if (material < 8.5) {
    d = habGlassDetail(in.uv, foot);
  } else if (material < 9.5) {
    d = habViewportDetail(in.uv, foot);
  } else if (material < 10.5) {
    d = habInteriorDetail(in.objectPos, objN, foot);
  } else {
    // A lit panel in a dry room: a console face or a light cove. Almost black
    // unlit, like the vessel's lamp lenses; the read is the emissive term.
    d.albedo = vec3f(0.02);
    d.metallic = 0.0;
    d.roughness = 0.35;
    d.relief = 0.0;
    d.ao = 0.6;
  }

  d.albedo *= entity.tint.rgb;
  d.roughness = clamp(d.roughness + entity.tint.a, MIN_PERCEPTUAL_ROUGHNESS, 1.0);

  // Battle damage: past 55% integrity the hull scars, which shows as scattered
  // paint loss and a rougher, less metallic surface.
  let integrity = entity.params.w;
  // The procedural habitat uses an integrity value above one as a deliberately
  // out-of-band marker for its sealed cabin surfaces. Vessel integrity is
  // clamped to [0, 1], so the two meanings cannot collide.
  let dryInteriorSurface = integrity > 1.5;
  let scar = saturate(1.0 - integrity / 0.55);
  if (scar > 0.0) {
    let s = saturate(fbm3(in.objectPos * 2.6, 0x33b1u, 4, 2.0, 0.5) * 0.5 + 0.5 - (1.0 - scar) * 0.5);
    d.albedo = mix(d.albedo, vec3f(0.055, 0.038, 0.030), s * scar);
    d.roughness = clamp(d.roughness + s * scar * 0.35, MIN_PERCEPTUAL_ROUGHNESS, 1.0);
    d.metallic *= 1.0 - s * scar * 0.6;
  }

  // scale 1.0, and it is not a tuning value: d.relief is in METRES, so the
  // surface gradient perturbNormal() forms from it is the true d(relief)/dx and
  // the tilt is the real arctangent of the real slope. There is no distance
  // fudge here any more, and there must not be one - every band above has
  // already filtered itself at its own Nyquist limit, and the seams and heads
  // are coverage-weighted, so the gradient this sees is bounded by construction.
  // A global bump fade was what the previous version used INSTEAD of filtering,
  // and it could only ever trade a shimmering grid for a plastic one.
  //
  // perturbNormal takes derivatives, so it must be evaluated in UNIFORM control
  // flow - the branch has to be on the RESULT, never around the call.
  let bumped = perturbNormal(geoN, P, d.relief, 1.0);
  // A normal tipped past the horizon would light the surface from inside it.
  let N = select(geoN, bumped, dot(bumped, geoN) >= 0.05);

  // Wet sheen: a hull that just came out of the water is still sheeted, and it
  // dries from the top down. Wetting darkens (water fills the surface pores)
  // and smooths; multiplying specular instead is what makes wet metal plastic.
  //
  // The quantity being modelled is TIME SINCE THE HULL WAS LAST SUBMERGED, and
  // it arrives as entity.shadow.y from passes/entities.js. It used to be
  // `1 - absPos.y * 0.55`, i.e. the fragment's height above the WORLD origin,
  // which reaches zero only at y = 1.818 m - so on a beach the terrain
  // generator happened to put below that height (nothing guarantees otherwise;
  // findSpawnPoint derives it), every up-facing surface of a bone-dry hull
  // would have rendered 28% darker with its roughness cut from 0.36 to 0.16.
  let wet = entity.shadow.y * saturate(0.5 + 0.5 * N.y);
  d.albedo *= mix(1.0, 0.72, wet);
  d.roughness = mix(d.roughness, d.roughness * 0.35 + 0.03, wet);

  var emissive = vec3f(0.0);
  if (material > 10.5) {
    // Interior lit panels. Flat, unlike a lamp lens: a console face is a
    // diffuse emitter and has no beam axis to fall off around.
    emissive = entity.tint.rgb * entity.params.z;
  } else if (material > 9.5) {
    // Interior light coves: the ceiling panel between the lamp housings is
    // itself a lit surface. Nothing else in a dry white room reads as
    // "the ceiling is the light" - a punctual lamp alone leaves a hard pool.
    emissive = HAB_COVE * saturate(-objN.y) * HAB_COVE_GAIN;
  } else if (material > 6.5) {
    // GLAZING IS NEVER EMISSIVE, and both faces used to be. The outward skin
    // carried a constant warm patch (HAB_ROOM_SPILL x WINDOW_SPILL) standing in
    // for the room behind it; the inward skin carried an analytic water colour
    // standing in for the sea. Neither ever sampled anything, so the commons
    // dome photographed as a flat pale lavender ceiling and a window band was
    // one colour top to bottom. The pane transmits now: what is behind it is
    // behind it.
    //
    // Painted panel: never emissive either. The habitat's lamps are real lights.
    // Painted panel: never emissive. The habitat's lamps are real lights.
    emissive = vec3f(0.0);
  } else if (material > 5.5) {
    // The instrument fascia: the canted panel ahead of the pilot, below the
    // anti-glare lip. It is what the CABIN lamp was built to light and what the
    // canopy's CANOPY_INTERIOR term has been claiming to be visible through the
    // glass since before any of it existed.
    let fascia = smoothstep(-1.15, -1.32, in.objectPos.z)
               * smoothstep(0.24, 0.30, in.objectPos.y)
               * (1.0 - smoothstep(0.34, 0.46, abs(in.objectPos.x)));
    emissive = CABIN_INSTRUMENT * fascia;
  } else if (material > 4.5) {
    // A BEAM LAMP'S LENS IS NOT A LAMBERTIAN EMITTER. Its rating is an on-axis
    // luminous intensity and essentially all of it leaves inside the cone; what
    // is visible from outside the cone is the reflector and the lens body
    // scattering, which on real spotlights is a few tenths of a percent of the
    // on-axis luminance. Emitting the full radiance in every direction instead
    // makes a 6.4 Mnit floodlight as bright seen edge-on as down the barrel,
    // and it blew a third of the frame white at four metres.
    //
    // The dome's own normal is the axis at its apex and tilts away toward the
    // rim, so each element beams along its own normal - which is both the right
    // physics and the reason the lens still catches the eye as you cross in
    // front of it. Cone terms come from the lamp's own VESSEL_LIGHTS entry, so a
    // point-source lens (cos(outer) = -1) correctly stays visible all round.
    // Smoothstepped, matching spotAttenuation()'s core in common/lighting.wgsl:
    // the lens and the beam it emits are meant to be one shape, so a squared
    // ramp here against a smoothstep there would put a ring on the lens that the
    // light on the rock does not have.
    let onAxis = saturate((dot(geoN, V) - entity.shadow.z) * entity.shadow.w);
    let profile = onAxis * onAxis * (3.0 - 2.0 * onAxis);
    let beam = LENS_OFF_AXIS + (1.0 - LENS_OFF_AXIS) * profile;
    emissive = entity.tint.rgb * entity.params.z * beam;
  } else if (material == MAT_CANOPY) {
    // The instrument panel seen THROUGH the pane: strongest looking straight in,
    // gone at the grazing angles where the reflection takes over. This is the
    // term that reads the canopy as glass with a cockpit behind it rather than
    // as a dark shell, and it is the correct shape - what you see through a
    // dielectric is 1 - F(theta), which falls exactly this way.
    let straightOn = saturate(dot(geoN, V));
    emissive = CANOPY_INTERIOR * straightOn * straightOn;
  }

  var s = makeSurface(P, N, geoN, V, d.albedo, d.roughness, d.metallic, d.ao,
                      emissive, 0.0);
  // BELOW SEA LEVEL IS NOT THE SAME AS IN THE WATER. This is what stops
  // evalPunctualLights attenuating the room's own lamps by 4 m of ocean that is
  // not in the room, and what swaps the blue sky SH for the room's own bounce in
  // evalAmbient. See SurfaceCtx.dryInterior.
  s.dryInterior = select(0.0, 1.0, dryInteriorSurface);
  let viewDepth = max(dot(-toEye, frame.cameraFwd.xyz), nearPlane());
  let lit = evalLightingSplitTranslucent(s, in.pos.xy, viewDepth, 0.0);
  var radiance = lit.total + emissive;

  // Caustics dance across a submerged hull exactly as they do across the
  // seabed; without them the vessel reads as pasted onto the scene.
  if (depth > 0.0 && !dryInteriorSurface) {
    // MEAN ZERO: causticFactor() is a mean-1 multiplier on the direct beam, so
    // the ambient share is its DEPARTURE from 1 and cannot lift the DC. 0.42 ->
    // 0.12 for the reason terrain.wgsl's CAUSTIC_AMBIENT_GAIN docstring gives.
    let cf = causticFactor(P, N, depth);
    radiance += evalAmbientSH(N) * daylightAtDepth(depth) * surfaceDiffuse(s)
              * ((cf - vec3f(1.0)) * 0.12);
  }

  // ---- participating medium, LAST ---------------------------------------
  // Only the submerged portion of the view ray is in water: seen from the air
  // a half-surfaced hull must have its wet half fogged and its dry half clear.
  // Seen from below, pass/underwater.wgsl owns the whole ray instead.
  //
  // A DRY SURFACE STILL HAS WATER IN FRONT OF IT UNLESS THE EYE IS IN THE SAME
  // ROOM. This was an unconditional `!dryInteriorSurface`, and that was sound
  // only while the glazing was opaque: no camera could see an interior surface
  // from outside the hull, so "the surface is dry" and "the ray is dry" were the
  // same statement. They stop being the same the instant a pane transmits, and
  // an unconditional skip then renders the commons as an unfogged white plate at
  // 33 m. applyViewRayWater() is already a no-op with the eye submerged, so this
  // costs nothing on the frames the composite owns.
  let isGlazing = material > 7.5 && material < 9.5;
  let raySkipsMedium = dryInteriorSurface && eyeIsDry();
  if (!raySkipsMedium) {
    radiance = applyViewRayWater(radiance, viewDist, depthAt(P), -V);
  }
  // Same split for the aerial volume: applied here in air, and left to
  // pass/underwater.wgsl's fullscreen composite when the eye is submerged.
  if (!raySkipsMedium) {
    radiance = applyViewRayFroxel(radiance, in.pos.xy * frame.screen.zw, viewDepth);
  }

  // ---- SSAO gate ---------------------------------------------------------
  // The delivered ambient share; see the terrain pass's gate block. On a
  // dry-room ray the ambient reaches the eye unattenuated, which is exactly
  // what skipping the medium mirror below computes.
  var aoAmb = lit.ambient;
  if (!raySkipsMedium) {
    aoAmb = aoAmbientThroughMedium(aoAmb, viewDist, depthAt(P), -V,
                                   in.pos.xy * frame.screen.zw, viewDepth);
  }

  // ---- and the pane owns the medium in front of ITSELF --------------------
  // The glazing is drawn AFTER pass/underwater.wgsl (see makeGlazingPass), so
  // the composite has already fogged the background over `dist - dryPath` -
  // which is exactly the distance to this pane - and cannot cover the pane's own
  // radiance, because it had not been drawn yet. Same situation as
  // pass/glow.wgsl, and the same rule: exactly one thing is owed, applied once.
  //
  // applyViewRayMedium, never applyWaterMedium: on the frames the volume ran it
  // owns the collimated beam, and adding it here as well is the double
  // application that turned 2 m of clear reef water into a white-out.
  //
  // With a DRY eye there is no water between it and the pane at all, and the
  // branch below would put 33 m of it there. Known bound: a different module's
  // outer glass seen across open water from inside the commons also gets none,
  // because eyeIsDry() is a property of the eye and not of that pane - the error
  // is confined to a second-order specular at F0 = 0.0043.
  if (isGlazing && isUnderwater() && !eyeIsDry()) {
    let fwd = max(dot(-V, frame.cameraFwd.xyz), 1e-3);
    radiance = applyViewRayMedium(radiance, viewDist, cameraDepth(), -V)
             + froxelSegment(in.pos.xy * frame.screen.zw, 0.0, viewDist * fwd);
  }

  // ---- motion vector ----------------------------------------------------
  let cur = in.curClip.xy / max(in.curClip.w, 1e-6);
  let prv = in.prevClip.xy / max(in.prevClip.w, 1e-6);
  // NDC -> UV: half scale, and y flips because UV runs down the screen. Same
  // convention as pass/terrain.wgsl, which pass/taa.wgsl consumes as
  // historyUV = uv - velocity.
  let velocity = (cur - prv) * vec2f(0.5, -0.5);

  // ---- alpha --------------------------------------------------------------
  // 1.0 for every material but the glazing. The opaque pipeline carries no blend
  // state and discards it, which is what lets ONE fragment entry point serve
  // both it and the transparent `glazing` pipeline.
  //
  // A mullion is opaque metal, so it takes alpha straight to 1; the pane between
  // them passes HAB_PANE_OPACITY of what is behind it, rising to full at the
  // Fresnel edge where a real pane turns into a mirror. The two faces use
  // different F0 - see GLASS_F0_WATER / GLASS_F0_AIR.
  var alpha = 1.0;
  if (isGlazing) {
    let inward = material > 8.5;
    let f0 = select(GLASS_F0_WATER, GLASS_F0_AIR, inward);
    let F = f0 + (1.0 - f0) * pow(1.0 - saturate(dot(N, V)), 5.0);
    let mull = habMullion(in.uv, foot);
    alpha = mull + (1.0 - mull) * mix(HAB_PANE_OPACITY, 1.0, F);
  }

  var out : FragOut;
  out.color = vec4f(radiance, alpha);
  out.velocity = velocity;
  // The ray ends inside a pressurised volume, so every metre of it in front of
  // this fragment was air. The glazing contributes the OTHER sign, from its own
  // entry point (fs_entity_drypath); see FragOut.dryPath.
  out.dryPath = select(0.0, viewDist, dryInteriorSurface);
  // Against the FINAL radiance, pane-medium branch included, so the ratio is
  // the delivered pixel's. The glazing pipeline write-masks this target off.
  out.gate = aoGate(aoAmb, radiance);
  return out;
}

/// The glazing's hull crossing, and nothing else.
///
/// The panes have to contribute to `dryPath` BEFORE pass/underwater.wgsl runs
/// and their colour AFTER it, so they are drawn twice: once here, inside the
/// entity pass, with colour and velocity write-masked off, and once by the
/// glazing pass further down the frame. This half is ten lines and no shading.
///
/// The sign comes from the material and therefore from which skin is facing the
/// eye - see FragOut.dryPath. Colour and velocity are still produced because
/// WebGPU requires a fragment output for every target the pipeline is given,
/// even one whose write mask is zero.
@fragment
fn fs_entity_drypath(in: VSOut) -> FragOut {
  let viewDist = length(frame.cameraPos.xyz - in.worldPos);
  var out : FragOut;
  out.color = vec4f(0.0);
  out.velocity = vec2f(0.0);
  out.dryPath = select(viewDist, -viewDist, entity.params.x < 8.5);
  out.gate = 0.0;                       // write-masked, produced because WebGPU
                                        // requires an output per target
  return out;
}
