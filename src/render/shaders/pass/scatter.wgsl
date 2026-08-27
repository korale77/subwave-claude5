// SUBWAVE - scatter.
//
// Every plant, rock, coral, crystal, fungus and ore node on the seabed, drawn as
// ONE INSTANCED DRAW PER MESH TYPE PER CHUNK. There is no per-object uniform: the
// instance stream carries the whole transform, and the per-draw uniform carries
// only what a TYPE knows - its emission, its sway strength, its fade window and
// its chunk's rebased origin.
//
// THE INSTANCE TRANSFORM IS A 3x4, NOT A QUATERNION. The three rows hold the
// SCALED basis vectors plus the translation, so the vertex stage is three dot
// products with no trig, no quaternion algebra and no renormalisation - and a
// non-uniformly scaled instance (a stretched kelp blade, a flattened rubble
// plate) costs nothing extra. See SCATTER_STRIDE in world/scatter.js for the
// byte layout; it is authoritative and this file must agree with it.
//
// POSITIONS ARE CHUNK-LOCAL, exactly as in pass/terrain.wgsl and for the same
// reason: `scatter.chunkOrigin` is the chunk's origin already rebased into
// camera-relative space on the CPU in f64, so a frond 3 km from the world origin
// still has sub-millimetre vertex precision instead of the 0.24 mm an absolute
// f32 would leave it with.
//
// MATERIAL IS PER VERTEX, NOT PER DRAW. world/meshgen.js stamps a MESH_MATERIAL
// slot onto every vertex, so a single mushroom mesh lights its stem as flora and
// its gills as emissive, and a gorgonian fan asks for evalTranslucency on the
// membrane and not on the stem - inside ONE draw, with no second mesh and no
// texture. The slot is interpolated FLAT, because a value blended across a
// triangle that straddles two parts would select a third material that is not
// present in either.
//
// SWAY IS DRIVEN BY THE MESH'S OWN SWAY WEIGHT (colour.w: 0 at the anchor, 1 at
// the tip), which is the one channel meshgen guarantees on every vertex of every
// generator. The bend goes as weight^2, which is what plants a base and moves a
// tip: a linear ramp lifts the whole plant off the ground. The previous frame's
// sway is evaluated analytically at t - dt so TAA reprojects a moving frond
// instead of smearing it into a grey smudge.
//
// EMISSIVE TYPES MUST GLOW WHERE THERE IS NO LIGHT. Emission is added to
// radiance BEFORE applyWaterMedium, so a crystal spire at 900 m is attenuated by
// the water between it and the eye - which is correct, and is why a 4.8 cd/m2
// spire is a soft blue smear at 90 m and a hard facet at 5 m.

#include "../common/frame.wgsl"
#include "../common/math.wgsl"
#include "../common/noise.wgsl"
#include "../common/brdf.wgsl"
#include "../common/shadow.wgsl"
#include "../common/water.wgsl"
#include "../common/lighting.wgsl"
// For pixelFootprint() and bandGain() only - the same two filtering primitives
// the terrain and the vessel use, for the same reason: a detail band below the
// Nyquist limit of the pixel footprint carries no signal, only shimmer. Scatter
// needs them more than either, because a seagrass blade at 40 m is two pixels
// wide and its veins are eight millimetres apart.
#include "../common/triplanar.wgsl"

// ---------------------------------------------------------------------------
// Per-draw
// ---------------------------------------------------------------------------

struct ScatterUniform {
  /// xyz = chunk origin, camera-relative. x/z are the chunk corner and y is
  /// -worldOrigin.y, because the instance stream carries ABSOLUTE height.
  chunkOrigin : vec4f,
  /// rgb = emissive radiance (colour * cd/m2, premultiplied),
  /// w = respiration rate in rad/s (0 = a steady glow, e.g. an ore vein)
  emissive    : vec4f,
  /// x = roughness bias, y = translucency scale, z = sway tip travel (m),
  /// w = optical thickness (m)
  params      : vec4f,
  /// x = fade start (m), y = fade end (m), z = base AO, w = type id
  shape       : vec4f,
  /// rgb = biome-local colour multiplier on the mesh's own vertex colour,
  /// w = metallic bias
  colorMul    : vec4f,
  /// x = algal film scale: 1 on bare mineral, 0 on living tissue that keeps its
  ///     own surface clean. Only mineralSurface reads it.
  /// y = fluorescence: 0 = this type's emission burns on its own (a mineral
  ///     vein, bioluminescence), 1 = it is RE-EMITTED daylight and has to be
  ///     pumped by the blue that survives to this depth.
  /// zw = reserved
  extra       : vec4f,
};

@group(1) @binding(0) var<uniform> scatter : ScatterUniform;

// MESH_MATERIAL slots, matching world/meshgen.js. Three bits, eight slots.
const MM_ROCK        : u32 = 0u;
const MM_FLORA       : u32 = 1u;
const MM_TRANSLUCENT : u32 = 2u;
const MM_EMISSIVE    : u32 = 3u;
const MM_CRYSTAL     : u32 = 4u;
const MM_BONE        : u32 = 5u;
const MM_SEDIMENT    : u32 = 6u;
const MM_METAL       : u32 = 7u;

/// Sway rate in WATER, radians per second. 0.9 is a ~7 s period, which is the
/// swell period driving the orbital motion a kelp stipe actually rides.
const SWAY_RATE_WATER : f32 = 0.9;
/// Sway rate in AIR. Dune grass in a Beaufort-3 wind moves at 1-2 Hz, not at the
/// ocean's 0.14 Hz; at 0.9 rad/s the shore grass was a 7 s period on a 0.6 m
/// blade, which reads as completely static. 2.6 rad/s is a 2.4 s carrier, and
/// the 0.23 rad/s gust envelope on top of it is what keeps it from metronoming.
const SWAY_RATE_AIR : f32 = 2.6;
/// Secondary cross-current lobe, as a fraction of the primary.
const SWAY_CROSS : f32 = 0.45;
/// How much the surge strengthens with sea state. frame.waterSurface.w is the
/// Douglas number, so this reaches 1.7x in a storm and 1.0x on a glassy day.
const SWAY_SEA_GAIN : f32 = 0.09;
/// Depth at which surface surge has fully died away, metres. Wave-driven orbital
/// motion decays as exp(-2*pi*d/L); for the 40 m swell this game generates that
/// is done by ~90 m, below which the only motion left is the slow thermohaline
/// drift that never stops - hence a floor rather than zero.
const SWAY_SURGE_DEPTH : f32 = 90.0;
const SWAY_DEEP_FLOOR : f32 = 0.28;

/// Fallback reflected fraction after a fluorescent pigment absorbs its pump.
/// All live fluorescent rows are the four corals handled below; the fallback
/// makes a future row safe until it authors its own family response.
const FLUO_ABSORB : vec3f = vec3f(1.00, 0.35, 0.02);

/// Fluorescent host tissue is not one pigment. The four coral generators carry
/// different protein families, so forcing all four through one red-biased
/// reflectance response made the whole garden pale pink. These are REFLECTED
/// fractions after pigment absorption; emission remains separately authored in
/// world/scatter.js and is still pumped by surviving blue daylight below.
///
/// IMPORTANT: world/scatter.js re-levels every family's colorMul so its
/// post-response Rec709 luminance stays at the pre-split baseline (0.092-0.106).
/// This is a chroma change, not a brightness change. On the fixed 2026-08-03
/// census, Coral Garden off-hue coverage moved 1.743% -> 16.546%, scene
/// luminance stayed 0.142, and clipped pixels remained 0.012%.
///
/// RE-SEPARATED 2026-08-07 (P3 shallow colour pass). The first split kept three
/// of the four families red-dominant (salmon / orange-red / magenta), and under
/// reef water - which transmits red 26x worse than blue over the sight path -
/// three red-dominant reflectances all deliver the same washed pink; the
/// matched-pair tour read reef x coral at 0.688 with every coral in one hue
/// family. The families are now spread across the axes the water can actually
/// deliver: branching keeps its warm salmon (red survives the near field where
/// the type dominates), brain keeps its GFP green (a chromoprotein-violet body
/// was tried in the same pass and MEASURED WORSE - delivered pale lilac, and
/// the reef anchor's hue entropy fell 1.691 -> 1.597 because the frame lost
/// its one green mode), fan moves to a gold (red+green, and green survives
/// distance where red does not), tube to a hard teal (green+blue, no red to
/// lose), and the reef pillar to an amber-gold so Shallow Reef gets the gold
/// family the fan brings everywhere else. Emission triples in world/scatter.js
/// are untouched: this is a REFLECTANCE separation, because a brighter coral
/// is a whiter one.
///
/// THE LUMA LEVELLING IS EXACT ONLY UNDER A WHITE ILLUMINANT. The six
/// families' Rec709 lumas are equalised (test-scatter recomputes them), but
/// these bodies are lit by blue-green water light, under which a pigment
/// with more green/blue reflects MORE ENERGY than its white-light luma says:
/// at an illustrative deep-water r:g:b of 0.05:1:4 the fan delivers ~2.3x
/// its old energy and the tube ~0.85x. That is the DESIGN - the gold fan is
/// "the coral that stays coloured at range" precisely because its green lobe
/// survives - but it is an energy change under coloured light, not a pure
/// hue rotation, and the biome where most fans live (Shelf Break, 13.7% of
/// footprint) was measured after the fact rather than assumed neutral.
/// 2026-08-17 clarity pass: branching, fan, tube and pillar pigments were
/// DEEPENED (minor channels cut, max channel never raised - "a brighter
/// object is a whiter one"), and each family's colorMul in world/scatter.js
/// was re-levelled in the same change so the delivered material luminance
/// stays at the established 0.1061 (test-scatter asserts it to +-0.001).
fn fluorescentReflectance(typeId: u32) -> vec3f {
  switch typeId {
    case 7u:  { return vec3f(1.00, 0.20, 0.02); } // branching: DsRed / salmon
    case 8u:  { return vec3f(0.12, 1.00, 0.08); } // brain: GFP green
    case 9u:  { return vec3f(0.55, 1.00, 0.02); } // fan: gold
    case 10u: { return vec3f(0.03, 1.00, 0.62); } // tube: teal
    case 31u: { return vec3f(1.00, 0.70, 0.03); } // reef pillar: amber-gold
    case 32u: { return vec3f(1.00, 0.08, 0.20); } // garden crown: pink-red protein
    // Crimson Meadow pair (2026-08-18). The pigment is a REFLECTANCE: the red
    // comes from CUTTING G/B, never from raising R above 1.0, because the AgX
    // shoulder makes a brighter object a whiter one (see the emission block
    // below) - the same rule every case above obeys.
    // Blood grass: B must be the SMALLEST channel, not G. The water column
    // amplifies delivered B against R by 2-5x at 14 m, so an authored B > G
    // guarantees magenta - measured 38 degrees off the reference before this
    // flipped (delivered dominant hue bin 300-330 against the reference's
    // 330-30 with literally zero mass in 300-330).
    case 56u: { return vec3f(1.00, 0.28, 0.02); } // blood grass: crimson carpet
    case 57u: { return vec3f(0.92, 0.10, 0.70); } // crimson plume: magenta accent
    default:  { return FLUO_ABSORB; }
  }
}

struct VSOut {
  @builtin(position) pos : vec4f,
  @location(0) worldPos  : vec3f,   // camera-relative
  @location(1) normal    : vec3f,   // world space, sway-corrected
  @location(2) uv        : vec2f,   // x = around, y = along the stalk
  @location(3) objectPos : vec3f,   // mesh-local, for the procedural detail
  @location(4) albedo    : vec3f,   // mesh vertex colour * instance tint * type
  @location(5) curClip   : vec4f,   // UNJITTERED clip position, this frame
  @location(6) prevClip  : vec4f,   // UNJITTERED clip position, last frame
  /// x = sway phase, y = variant 0..1, z = emissive scale 0..1
  @location(7) extra     : vec3f,
  @location(8) @interpolate(flat) material : u32,
};

/// Sway displacement in WORLD metres for a vertex whose sway weight is `w`.
///
/// Returns xyz = displacement, w = d|displacement|/dweight along the primary
/// direction, which the caller needs in order to tilt the normal by the same
/// shear that moved the vertex. Without that term a swaying frond keeps the
/// lighting of a stationary one and reads as a flag painted on a pole.
/// `depth` is the VERTEX's depth and drives the surge falloff, so a kelp tip
/// 16 m above its own holdfast feels the shallower water it is actually in.
/// `rootDepth` is the INSTANCE's, and it alone picks the medium: a seagrass tuft
/// in 1 m of water is 3.3 m tall at max scale and pokes clear of the surface, so
/// a per-vertex medium test would run the top of one blade at the air rate and
/// the bottom at the water rate and tear the mesh apart in time.
fn swayOffset(w: f32, phase: f32, amp: f32, strength: f32, t: f32,
              depth: f32, rootDepth: f32) -> vec4f {
  if (strength <= 0.0 || amp <= 0.0 || w <= 0.0) { return vec4f(0.0); }

  // Surge from the surface, plus a floor so the deep never goes perfectly still.
  let seaState = frame.waterSurface.w;
  let surge = mix(1.0, SWAY_DEEP_FLOOR, saturate(max(depth, 0.0) / SWAY_SURGE_DEPTH))
            * (1.0 + seaState * SWAY_SEA_GAIN);
  // Gusts: a slow envelope on top of the carrier, so a bed breathes instead of
  // metronoming. Offsetting it by the instance phase decorrelates neighbours.
  let gust = 0.66 + 0.34 * sin(t * 0.23 + phase * 0.41);
  let a = amp * strength * surge * gust;

  // weight^2: zero value AND zero derivative at the anchor, so a root is welded
  // to the ground rather than merely coincident with it.
  let w2 = w * w;
  let rate = select(SWAY_RATE_AIR, SWAY_RATE_WATER, rootDepth > 0.0);
  let carrier = sin(t * rate + phase);
  let cross = sin(t * rate * 0.73 + phase * 1.7 + 1.3);

  let wd = frame.windDir.xy;
  let along = vec3f(wd.x, 0.0, wd.y);
  let side = vec3f(-wd.y, 0.0, wd.x);

  var d = along * (carrier * a * w2) + side * (cross * a * SWAY_CROSS * w2);
  // A bent stalk is a shorter stalk. Without this the tip traces an arc longer
  // than the stalk and the plant visibly stretches at the extremes.
  let horiz = a * w2;
  d.y -= horiz * horiz * 0.35;

  // d/dw of the primary lobe.
  return vec4f(d, 2.0 * w * a * carrier);
}

@vertex
fn vs_scatter(
  // ---- mesh (40 B stride) ----
  @location(0) position  : vec3f,
  @location(1) normal    : vec3f,
  @location(2) uv        : vec2f,
  @location(3) vcolor    : vec4f,   // sqrt(linear rgb), a = material slot / 255
  @location(4) swayWeight: f32,
  // ---- instance (64 B stride) ----
  @location(5) row0      : vec4f,
  @location(6) row1      : vec4f,
  @location(7) row2      : vec4f,
  @location(8) tint      : vec4f,
  @location(9) swayPhase : f32,
  @location(10) swayAmp  : f32,
  @location(11) instMeta : vec4f,
) -> VSOut {
  var out : VSOut;

  let basisX = vec3f(row0.x, row1.x, row2.x);
  let basisY = vec3f(row0.y, row1.y, row2.y);
  let basisZ = vec3f(row0.z, row1.z, row2.z);
  let translation = vec3f(row0.w, row1.w, row2.w) + scatter.chunkOrigin.xyz;

  // ---- distance fade -----------------------------------------------------
  // The instance origin sits ON the ground, so a uniform shrink of the LOCAL
  // position sinks the plant into the seabed rather than sliding it sideways.
  // That is the one fade an opaque pass can do honestly: alpha dithering needs a
  // blend or a discard, and both cost more than this on every fragment of every
  // plant in order to improve the last two metres of a fade nobody looks at.
  //
  // instMeta.x staggers the window per instance so a meadow does not collapse as one
  // ring, which is the single most obvious LOD artefact a grass field can have.
  let dist = length(translation - frame.cameraPos.xyz);
  let stagger = 0.82 + 0.36 * instMeta.x;
  let keep = 1.0 - smoothstep(scatter.shape.x * stagger, scatter.shape.y * stagger, dist);
  let local = position * keep;

  // ---- sway --------------------------------------------------------------
  let basePos = basisX * local.x + basisY * local.y + basisZ * local.z + translation;
  let depth = depthAt(basePos);
  let rootDepth = depthAt(translation);
  let t = currentTime();
  let strength = scatter.params.z * keep;
  let sway = swayOffset(swayWeight, swayPhase, swayAmp, strength, t, depth, rootDepth);
  let prevSway = swayOffset(swayWeight, swayPhase, swayAmp, strength,
                            t - deltaTime(), depth, rootDepth);

  let world = basePos + sway.xyz;
  let prevWorld = basePos + prevSway.xyz;

  // ---- normal ------------------------------------------------------------
  // The basis may be non-uniformly scaled, so normals transform by the
  // inverse-transpose. For a diagonal scale in an orthonormal frame that is the
  // frame with each column divided by its own SQUARED length, which is three
  // reciprocals rather than a 3x3 inverse.
  let lx2 = max(dot(basisX, basisX), 1e-8);
  let ly2 = max(dot(basisY, basisY), 1e-8);
  let lz2 = max(dot(basisZ, basisZ), 1e-8);
  var N = normalize(basisX * (normal.x / lx2)
                  + basisY * (normal.y / ly2)
                  + basisZ * (normal.z / lz2));

  // Shear the normal by the same gradient that displaced the vertex. The shear
  // maps the local up axis onto the sway direction at sway.w per unit weight, and
  // the stalk spans |basisY| metres, so the world-space rate is sway.w / |basisY|.
  let stalkLen = sqrt(ly2);
  if (sway.w != 0.0) {
    let up = basisY / stalkLen;
    let wd = frame.windDir.xy;
    let along = vec3f(wd.x, 0.0, wd.y);
    N = normalize(N - along * (dot(N, up) * sway.w / max(stalkLen, 0.05)));
  }

  // Vertex colour is stored as sqrt(linear) in eight bits, so squaring is the
  // decode. See packMesh() in render/passes/scatter.js for why.
  let meshAlbedo = vcolor.rgb * vcolor.rgb;

  out.worldPos = world;
  out.normal = N;
  out.uv = uv;
  out.objectPos = position;
  out.albedo = meshAlbedo * (tint.rgb * 2.0) * scatter.colorMul.rgb;
  out.extra = vec3f(swayPhase, instMeta.z, tint.a);
  out.material = u32(round(vcolor.a * 255.0)) & 7u;
  out.pos = frame.viewProj * vec4f(world, 1.0);
  out.curClip = frame.viewProjUnjittered * vec4f(world, 1.0);
  out.prevClip = frame.prevViewProj * vec4f(prevWorld, 1.0);
  return out;
}

/// Shadow caster. Depth only, no fragment stage.
///
/// KEPT ADJACENT TO vs_scatter DELIBERATELY. Every line down to `world` is a
/// verbatim copy of the block above, and it has to stay that way: the distance
/// fade is a geometric SHRINK (`position * keep`) and the sway is a world-space
/// displacement, so a caster that skipped either would cast the shadow of a
/// plant that is not on screen - a kelp bed whose every blade self-shadows and
/// crawls. Both are pure functions of frame state the shadow pass does not
/// touch, so both evaluate identically here.
///
/// `scatter.chunkOrigin.w` carries the cascade index; it was unused and the CPU
/// wrote 0 into it, so ScatterUniform does not change size.
@vertex
fn vs_scatter_shadow(
  @location(0) position  : vec3f,
  @location(4) swayWeight: f32,
  @location(5) row0      : vec4f,
  @location(6) row1      : vec4f,
  @location(7) row2      : vec4f,
  @location(9) swayPhase : f32,
  @location(10) swayAmp  : f32,
  @location(11) instMeta : vec4f,
) -> @builtin(position) vec4f {
  let basisX = vec3f(row0.x, row1.x, row2.x);
  let basisY = vec3f(row0.y, row1.y, row2.y);
  let basisZ = vec3f(row0.z, row1.z, row2.z);
  let translation = vec3f(row0.w, row1.w, row2.w) + scatter.chunkOrigin.xyz;

  let dist = length(translation - frame.cameraPos.xyz);
  let stagger = 0.82 + 0.36 * instMeta.x;
  let keep = 1.0 - smoothstep(scatter.shape.x * stagger, scatter.shape.y * stagger, dist);
  let local = position * keep;

  let basePos = basisX * local.x + basisY * local.y + basisZ * local.z + translation;
  let depth = depthAt(basePos);
  let rootDepth = depthAt(translation);
  let strength = scatter.params.z * keep;
  let sway = swayOffset(swayWeight, swayPhase, swayAmp, strength, currentTime(),
                        depth, rootDepth);
  let world = basePos + sway.xyz;

  return shadowCasterClip(world, u32(scatter.chunkOrigin.w));
}

// ---------------------------------------------------------------------------
// Procedural surfaces
// ---------------------------------------------------------------------------

struct Surface {
  albedo    : vec3f,
  roughness : f32,
  metallic  : f32,
  ao        : f32,
  /// 0 opaque .. 1 fully light-transmitting tissue.
  translucency : f32,
  /// Multiplies the type's emissive radiance. Lets a slot put its glow where the
  /// organism actually makes light - gills, polyp mouths, a crystal core.
  glow      : f32,
};

/// Per-slot base roughness. These are the material's own properties; the type
/// only ever biases them, which is why `scatter.params.x` is added and not
/// substituted.
fn slotRoughness(m: u32) -> f32 {
  switch (m) {
    case 0u: { return 0.85; }   // ROCK
    case 1u: { return 0.70; }   // FLORA
    case 2u: { return 0.62; }   // TRANSLUCENT
    case 3u: { return 0.48; }   // EMISSIVE
    case 4u: { return 0.12; }   // CRYSTAL
    case 5u: { return 0.68; }   // BONE
    case 6u: { return 0.93; }   // SEDIMENT
    default: { return 0.42; }   // METAL
  }
}

/// Per-slot translucency, before the type's scale.
fn slotTranslucency(m: u32) -> f32 {
  switch (m) {
    case 2u: { return 0.85; }   // TRANSLUCENT: blades, fans, membranes
    case 3u: { return 0.55; }   // EMISSIVE: fruiting tissue is thin and lit
    case 4u: { return 0.60; }   // CRYSTAL
    case 1u: { return 0.15; }   // FLORA: a stipe passes a little light
    case 5u: { return 0.25; }   // BONE
    default: { return 0.0; }    // ROCK, SEDIMENT, METAL
  }
}

/// How much of the type's emission a slot is responsible for. A mushroom's
/// stem is not the part that glows, and an ore body's light comes out of its
/// veins rather than off its whole surface.
fn slotEmissiveGate(m: u32) -> f32 {
  switch (m) {
    case 3u: { return 1.00; }   // EMISSIVE
    case 4u: { return 0.85; }   // CRYSTAL
    case 7u: { return 0.35; }   // METAL: vein glow
    case 2u: { return 0.20; }   // TRANSLUCENT: a lit tip on a sea whip
    default: { return 0.05; }
  }
}

/// Mineral: rock, boulder, shingle, gravel, vent chimney, sediment crust.
///
/// Two bands of object-space fbm - a coarse lithology and a fine grain - each
/// gated by bandGain against the pixel footprint, plus an algal film that only
/// grows on upward faces in the photic zone. The film is not decoration: bare
/// rock and rock with two centimetres of turf on it are the difference between a
/// seabed and a quarry.
fn mineralSurface(albedo: vec3f, p: vec3f, N: vec3f, depth: f32,
                  footprint: f32, variant: f32, m: u32) -> Surface {
  var s : Surface;

  let coarse = fbm3(p * 1.8 + vec3f(variant * 7.0), 0x3b71u, 3, 2.0, 0.5)
             * bandGain(0.55, footprint);
  let grain = fbm3(p * 14.0, 0x91c3u, 2, 2.0, 0.5) * bandGain(0.07, footprint);
  let mottle = 0.5 + 0.25 * coarse + 0.25 * grain;

  var a = albedo * (0.74 + 0.52 * mottle);

  // Algal turf: photic zone only, upward faces only, thicker in the shallows
  // where the irradiance actually supports it.
  //
  // scatter.extra.x switches it off for LIVING tissue that nonetheless arrives
  // here. meshgen stamps brain coral MESH_MATERIAL.ROCK - 100% of its vertices,
  // and 202 of them in the reef chunk under the qa reef-floor camera alone - so
  // every upward face of every dome was being mixed 70% toward (0.038, 0.058,
  // 0.030): its albedo of [0.218, 0.183, 0.133] became [0.092, 0.096, 0.061],
  // 19% reflectance down to 9%, with visible green mottling on the crown. A
  // coral head is not a rock and nothing settles on a living polyp.
  let photic = 1.0 - smoothstep(20.0, 95.0, depth);
  let facing = saturate(N.y * 0.85 + 0.15);
  let turfPatch = saturate(fbm3(p * 3.4, 0x5ae1u, 3, 2.0, 0.5) * 0.5 + 0.5);
  let film = photic * facing * smoothstep(0.42, 0.78, turfPatch) * scatter.extra.x;
  a = mix(a, vec3f(0.038, 0.058, 0.030), film * 0.7);

  s.albedo = a;
  s.roughness = slotRoughness(m) + (1.0 - mottle) * 0.08 - film * 0.12;
  s.metallic = select(0.0, 0.9 * (1.0 - film), m == MM_METAL);
  s.ao = saturate(0.62 + 0.38 * mottle);
  s.translucency = 0.0;

  // TWO GLOW MASKS, BECAUSE TWO DIFFERENT THINGS EMIT HERE.
  //
  // A mineral vein glows out of the CRACKS, so its mask is high where the coarse
  // lithology band is low - deliberately anti-correlated with the albedo, which
  // is right for an ore body.
  //
  // Living tissue is the opposite, and the vein mask on tissue was measured doing
  // real damage. Brain coral is the one organism that shades through this
  // function - meshgen builds it as a carbonate dome and stamps every vertex ROCK
  // - and the vein mask put its fluorescence exactly where its albedo was
  // darkest, so the emission CANCELLED the only surface detail a smooth dome has.
  // MEASURED in sceneColor on the reef, dome pixels against the bare sand beside
  // them: the emission raised the dome to 1.82x the sand while dropping its
  // coefficient of variation from 0.273 to 0.189 - a cv gain of 0.69, i.e. the
  // glow was deleting 31% of what texture was left. It photographed as a green
  // snowball.
  //
  // GFP-family protein sits in the coenosarc tissue, which is thickest on the
  // ridges - the same places the coarse band already brightens - so a fluorescent
  // type gets the mask the RIGHT way round.
  //
  // The mask alone is not enough, because most of a dome's variation is SHADING
  // and an emission that ignores the normal dilutes it whatever it correlates
  // with. Fluorescence is EXCITED light - a surface can only re-emit the blue it
  // receives - so it carries the same normal dependence the diffuse term does.
  // (1 + N.y)/2 is the fraction of a uniform downwelling hemisphere a surface
  // sees; the floor is the diffuse part of the underwater light field, which
  // arrives from every direction and is why an overhang still fluoresces.
  //
  // MEASURED at the shipped emission, everything else held: the vein mask gives a
  // dome cv of 0.214 and this pair gives 0.229, cv gains of 0.787 and 0.839. Both
  // are still under 1, because the emission does not carry the CAUSTIC
  // modulation the diffuse term does - what these two terms fix is the glow
  // OPPOSING the surface, not the last of the dilution.
  let veinGlow = saturate(0.30 + 0.70 * (1.0 - mottle));
  let downwelling = 0.30 + 0.70 * (0.5 + 0.5 * N.y);
  let tissueGlow = saturate(0.30 + 0.70 * mottle) * downwelling;
  s.glow = mix(veinGlow, tissueGlow, scatter.extra.y) * (1.0 - film);
  return s;
}

/// Flora: an opaque stipe, stem or holdfast. Fibrous along its own axis.
fn floraSurface(albedo: vec3f, uv: vec2f, footprint: f32, variant: f32) -> Surface {
  var s : Surface;
  // Fibres run ALONG the stalk, so the band is a function of uv.x (around) at a
  // frequency set by uv.y (along). On a 2 cm stipe these are ~1 mm apart.
  let fibre = sin(uv.x * 48.0 + variant * 5.0) * 0.5 + 0.5;
  let mottle = fbm3(vec3f(uv.x * 6.0, uv.y * 3.0, variant * 4.0), 0x62b9u, 2, 2.0, 0.5) * 0.5 + 0.5;
  s.albedo = albedo * (0.82 + 0.30 * mottle) * (1.0 + (fibre - 0.5) * 0.16 * bandGain(0.0012, footprint));
  s.roughness = slotRoughness(MM_FLORA) + (1.0 - mottle) * 0.08;
  s.metallic = 0.0;
  // The base of a stipe sits inside its own holdfast and sees almost no sky.
  s.ao = 0.42 + 0.58 * saturate(uv.y);
  s.translucency = slotTranslucency(MM_FLORA);
  s.glow = saturate(uv.y);
  return s;
}

/// Translucent: kelp blade, seagrass, gorgonian membrane, alien frond.
///
/// uv.x runs across the blade and uv.y along it, which is the one place this pass
/// can rely on a real parameterisation - so the midrib, the length gradient and
/// the bleached tip are all authored in UV and none of them alias.
fn frondSurface(albedo: vec3f, uv: vec2f, depth: f32, footprint: f32, variant: f32) -> Surface {
  var s : Surface;

  // Midrib: a darker, thicker spine down the centre of the blade.
  let across = abs(uv.x * 2.0 - 1.0);
  let rib = 1.0 - smoothstep(0.06, 0.22, across);
  let alongGrad = saturate(uv.y);
  // Chlorophyll concentrates toward the base; the tip is bleached and frayed by
  // light and abrasion.
  let bleach = smoothstep(0.62, 1.0, alongGrad) * (0.55 + 0.45 * variant);

  var a = albedo * (0.78 + 0.34 * (1.0 - alongGrad));
  a = mix(a, a * vec3f(1.5, 1.35, 0.95), bleach * 0.6);
  a = mix(a, a * 0.62, rib * 0.7);

  // Cross-veins, filtered: on a 40 cm blade they span 8 mm and are gone by 3 m.
  let veins = sin(alongGrad * 64.0 + variant * 6.0) * 0.5 + 0.5;
  a *= 1.0 + (veins - 0.5) * 0.14 * bandGain(0.008, footprint);
  // Deep fronds are darker: less pigment where there is less light to harvest.
  a *= 1.0 - saturate(depth / 1600.0) * 0.30;

  s.albedo = a;
  s.roughness = slotRoughness(MM_TRANSLUCENT) - rib * 0.14;
  s.metallic = 0.0;
  // Self-shadowing inside a tuft: the base of a blade sees almost no sky.
  s.ao = 0.45 + 0.55 * alongGrad;
  s.translucency = slotTranslucency(MM_TRANSLUCENT);
  s.glow = alongGrad * alongGrad;
  return s;
}

/// Emissive: fungal gills, glow pods, tube-worm plumes, lit polyp mouths.
fn glowSurface(albedo: vec3f, p: vec3f, N: vec3f, uv: vec2f,
               footprint: f32, phase: f32, variant: f32) -> Surface {
  var s : Surface;

  // Radial gills. atan2 of the object-space XZ is stable because the generators
  // build these forms about their own axis.
  let ang = atan2(p.z, p.x);
  let gillCount = 26.0 + floor(variant * 14.0);
  let gill = 0.5 + 0.5 * sin(ang * gillCount);
  let gillGate = bandGain(0.012, footprint);
  // Gills are on the UNDERSIDE. Facing down selects them, not uv.
  let under = saturate(-N.y * 1.4);

  let flesh = fbm3(p * 6.0, 0x4d81u, 3, 2.0, 0.5) * 0.5 + 0.5;
  var a = albedo * (0.80 + 0.40 * flesh);
  a = mix(a, a * vec3f(1.30, 1.15, 0.90), smoothstep(0.5, 1.0, uv.y) * 0.3);

  s.albedo = a;
  s.roughness = slotRoughness(MM_EMISSIVE) - under * 0.10;
  s.metallic = 0.0;
  s.ao = 1.0 - under * 0.30;
  s.translucency = slotTranslucency(MM_EMISSIVE);

  // Slow respiration. scatter.emissive.w is 0 for a mineral vein, so an ore node
  // holds a steady glow while living tissue breathes.
  let rate = scatter.emissive.w;
  let pulse = 1.0 - rate * (0.28 - 0.28 * sin(currentTime() * rate + phase * 2.3));
  s.glow = pulse * (0.35 + 0.90 * under * mix(0.5, gill, gillGate) + 0.30 * saturate(uv.y));
  return s;
}

/// Crystal: shard, spire, deep quartz. Faceted, dielectric, lit from within.
fn crystalSurface(albedo: vec3f, p: vec3f, N: vec3f, V: vec3f,
                  footprint: f32, variant: f32) -> Surface {
  var s : Surface;

  // Growth banding along the crystal's own axis. Quantising to hard steps is
  // what makes it read as a mineral rather than as a painted gradient.
  let band = terrace(saturate(p.y * 0.5 + 0.5 + variant * 0.2), 7.0, 0.16);
  let gate = bandGain(0.28, footprint);
  let flaw = fbm3(p * 9.0, 0x6c37u, 2, 2.0, 0.5) * bandGain(0.11, footprint);

  s.albedo = albedo * (0.82 + 0.36 * mix(0.5, band, gate));
  s.roughness = slotRoughness(MM_CRYSTAL) + abs(flaw) * 0.12;
  s.metallic = 0.0;
  s.ao = 1.0;
  s.translucency = slotTranslucency(MM_CRYSTAL);

  // Emission rises toward grazing angles: the light is made INSIDE the crystal,
  // so the eye sees more of it through a longer chord of the body. That is the
  // Fresnel-complement term a thin lit shell obeys, and it is what gives a lit
  // crystal its bright rim instead of a flat wash.
  let grazing = 1.0 - saturate(abs(dot(N, V)));
  s.glow = 0.45 + 0.85 * grazing * grazing + 0.25 * band;
  return s;
}

/// Bone and carbonate: whale ribs, sponge skeletons, dead coral rock.
fn boneSurface(albedo: vec3f, p: vec3f, uv: vec2f, footprint: f32, variant: f32) -> Surface {
  var s : Surface;

  // Ostia / cancellous porosity. worley3F1 returns a distance with unit gradient
  // in CELL units, so dividing by the density converts it back to metres and the
  // threshold below is a real pore radius.
  let density = 95.0;
  let d = worley3F1(p * density + vec3f(variant * 5.0), 0x1e93u, 1.0) / density;
  let pore = (1.0 - smoothstep(0.0035, 0.0090, d)) * bandGain(0.014, footprint);
  let weave = fbm3(p * 11.0, 0x8f45u, 3, 2.0, 0.5) * bandGain(0.09, footprint);

  var a = albedo * (0.78 + 0.44 * (weave * 0.5 + 0.5));
  a = mix(a, a * 0.42, pore * 0.85);
  // The rim of a barrel sponge or the crest of a rib is paler where it is
  // thinnest and where nothing settles on it.
  a *= 1.0 + smoothstep(0.82, 1.0, uv.y) * 0.35;

  s.albedo = a;
  s.roughness = slotRoughness(MM_BONE) + pore * 0.18;
  s.metallic = 0.0;
  s.ao = (1.0 - pore * 0.5) * saturate(0.6 + 0.4 * uv.y);
  s.translucency = slotTranslucency(MM_BONE);
  s.glow = 0.4 + 0.6 * pore;
  return s;
}

// ---------------------------------------------------------------------------
// Fragment
// ---------------------------------------------------------------------------

struct FragOut {
  @location(0) color    : vec4f,
  @location(1) velocity : vec2f,
  /// The SSAO gate: this pixel's delivered ambient share. See aoGate() in
  /// common/water.wgsl. The emissive term is in the denominator only, which is
  /// what keeps a glowcup's radiance out of SSAO's reach by construction.
  @location(2) gate     : f32,
};

@fragment
fn fs_scatter(in: VSOut, @builtin(front_facing) frontFacing: bool) -> FragOut {
  let P = in.worldPos;
  let absPos = toAbsolute(P);
  let depth = seaLevel() - absPos.y;              // positive underwater

  let toEye = frame.cameraPos.xyz - P;
  let viewDist = length(toEye);
  let V = toEye / max(viewDist, 1e-4);

  // Thin geometry is drawn with culling off, so a back face has to be flipped or
  // half of every blade in the ocean is lit from behind its own surface. This is
  // the ONE place two-sided geometry needs a special case; everything downstream
  // then sees a normal that faces the eye.
  let geoN = select(-normalize(in.normal), normalize(in.normal), frontFacing);

  // pixelFootprint and bandGain take derivatives, so they must be evaluated in
  // UNIFORM control flow - outside the material branch, never inside it.
  let footprint = pixelFootprint(P);
  let variant = in.extra.y;
  let m = in.material;

  var s : Surface;
  if (m == MM_TRANSLUCENT) {
    s = frondSurface(in.albedo, in.uv, depth, footprint, variant);
  } else if (m == MM_FLORA) {
    s = floraSurface(in.albedo, in.uv, footprint, variant);
  } else if (m == MM_EMISSIVE) {
    s = glowSurface(in.albedo, in.objectPos, geoN, in.uv, footprint, in.extra.x, variant);
  } else if (m == MM_CRYSTAL) {
    s = crystalSurface(in.albedo, in.objectPos, geoN, V, footprint, variant);
  } else if (m == MM_BONE) {
    s = boneSurface(in.albedo, in.objectPos, in.uv, footprint, variant);
  } else {
    // ROCK, SEDIMENT and METAL share one lithology; the slot picks the roughness
    // and whether it is a conductor.
    s = mineralSurface(in.albedo, in.objectPos, geoN, depth, footprint, variant, m);
  }

  let roughness = clamp(s.roughness + scatter.params.x, MIN_PERCEPTUAL_ROUGHNESS, 1.0);
  let metallic = saturate(s.metallic + scatter.colorMul.w);
  let ao = saturate(s.ao * scatter.shape.z);
  let translucency = saturate(s.translucency * scatter.params.y);

  // Fluorescent tissue cannot reflect the pump it just re-emitted. See
  // fluorescentReflectance(). Applied here rather than inside the five surface
  // functions
  // because it is a property of the ORGANISM (scatter.extra.y), not of the
  // material slot, and brain coral shades through mineralSurface while the other
  // three shade through floraSurface and frondSurface.
  let pigment = fluorescentReflectance(u32(round(scatter.shape.w)));
  let albedo = s.albedo * mix(vec3f(1.0), pigment, scatter.extra.y);

  // ---- emission, and the one kind of it that is not self-powered ----------
  // FLUORESCENCE IS RE-EMITTED LIGHT, NOT MANUFACTURED LIGHT. The GFP-family
  // proteins in a reef coral absorb 400-500 nm and emit at 490-610 nm, so the
  // long wavelength is made AT the coral, BELOW the water column that already
  // took the red out of the daylight. That is the only mechanism that beats the
  // path here: over the reef's 6.3 m column plus an 8 m sightline in
  // REEF_TURQUOISE, red transmits 0.0131 against blue's 0.3475 - a MEASURED 26x
  // differential that no albedo can climb. (The water got clearer when it was
  // retuned from Jerlov II to IB; every channel roughly doubled and the RATIO
  // moved from 26.2 to 26.5, so it is the ratio that is structural.)
  //
  // Being excited light, it must go out at night and fade with depth, so the
  // pump is the surviving blue daylight and nothing else. It is also a property
  // of the whole TISSUE rather than of one organ, so it skips the slot gate -
  // that gate exists to put a mushroom's light in its gills and an ore body's in
  // its veins, and at FLORA's 0.05 it was throwing away 95% of a coral.
  //
  // DO NOT FLOOR OR GAMMA-CORRECT THIS PUMP TO "GET MORE COLOUR OUT OF THE
  // REEF". It was tried and it is the wrong lever, for a reason that is
  // arithmetic rather than aesthetic: THE FLUORESCENCE-TO-DIFFUSE RATIO IS
  // ALREADY INDEPENDENT OF THE TIME OF DAY. `surfaceDaylightFraction()` is
  // exactly the factor by which the diffuse irradiance lighting the same coral
  // is ALSO down, so both terms scale together and the only thing a floor
  // changes is the absolute radiance - which the auto-exposure then takes
  // straight back out of the frame. MEASURED at the reef anchor, day fraction
  // 0.305, sun 19.2 deg, pump 0.146: multiplying the four coral rows' emission
  // by 3 dropped the frame's own exposure 1.9915 -> 1.8168, and the delivered
  // HSV saturation of a foreground coral patch went the WRONG way, 0.128 ->
  // 0.093. At 8x (exposure 1.6458) it was 0.046 and at 16x (1.4129) 0.052, both
  // with the albedo cut 2.5-3.3x as well, so those two are a floor rather than a
  // clean sweep - the trend is the same and the direction is the point. The
  // extra light pushes the coral past the AgX shoulder, where chroma is crushed:
  // a BRIGHTER coral is a WHITER one. The pale pink was never a brightness
  // deficit. It was the tissue reflecting the blue it should have been absorbing
  // (fluorescentReflectance) on an albedo levelled against the seabed instead of against
  // the render.
  let fluo = scatter.extra.y;
  let pump = mix(1.0, surfaceDaylightFraction() * daylightAtDepth(depth).b, fluo);
  let emitGate = mix(slotEmissiveGate(m), 1.0, fluo);
  let emissive = scatter.emissive.rgb * (in.extra.z * s.glow * emitGate * pump);

  let surf = makeSurface(P, geoN, geoN, V, albedo, roughness, metallic, ao,
                         emissive, translucency);
  let viewDepth = max(dot(-toEye, frame.cameraFwd.xyz), nearPlane());

  let lit = evalLightingSplitTranslucent(surf, in.pos.xy, viewDepth, scatter.params.w);
  var radiance = lit.total + emissive;

  // Caustics dance across a coral head exactly as they do across the sand it
  // grows out of; without them the reef reads as pasted onto the seabed.
  if (depth > 0.0) {
    // MEAN ZERO: causticFactor() is a mean-1 multiplier on the direct beam, so
    // the ambient share is its DEPARTURE from 1 and cannot lift the DC. 0.42 ->
    // 0.12 for the reason terrain.wgsl's CAUSTIC_AMBIENT_GAIN docstring gives -
    // the sky is a 90 deg source and its own caustic is washed out.
    let cf = causticFactor(P, geoN, depth);
    radiance += evalAmbientSH(geoN) * daylightAtDepth(depth) * surfaceDiffuse(surf)
              * ((cf - vec3f(1.0)) * 0.12);
  }

  // ---- participating medium, LAST ---------------------------------------
  // Shore grass and the island fronds are in AIR, so only the submerged part of
  // the view ray may be fogged - the same split pass/entity.wgsl makes for a
  // half-surfaced hull. Below the waterline pass/underwater.wgsl owns the ray.
  radiance = applyViewRayWater(radiance, viewDist, depthAt(P), -V);
  // Same split for the aerial volume: applied here in air, and left to
  // pass/underwater.wgsl's fullscreen composite when the eye is submerged.
  let screenUV = in.pos.xy * frame.screen.zw;
  radiance = applyViewRayFroxel(radiance, screenUV, viewDepth);

  // ---- SSAO gate ---------------------------------------------------------
  // The delivered ambient share; see the terrain pass's gate block. The
  // mean-zero caustic wiggle above is outside the numerator on purpose.
  let aoAmb = aoAmbientThroughMedium(lit.ambient, viewDist, depthAt(P), -V,
                                     screenUV, viewDepth);

  // ---- motion vector ----------------------------------------------------
  let cur = in.curClip.xy / max(in.curClip.w, 1e-6);
  let prv = in.prevClip.xy / max(in.prevClip.w, 1e-6);
  // NDC -> UV: half scale, and y flips because UV runs down the screen. Same
  // convention as pass/terrain.wgsl, which pass/taa.wgsl consumes as
  // historyUV = uv - velocity.
  let velocity = (cur - prv) * vec2f(0.5, -0.5);

  var out : FragOut;
  out.color = vec4f(radiance, 1.0);
  out.velocity = velocity;
  out.gate = aoGate(aoAmb, radiance);
  return out;
}
