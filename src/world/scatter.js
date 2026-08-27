/**
 * SUBWAVE scatter placement.
 *
 * Every small thing that grows out of, or lies on, the seabed: kelp, seagrass,
 * corals, sponges, fungi, crystals, rocks, boulders, bone, vent chimneys and
 * the ore nodes the mining system will consume.
 *
 * NO GLOBAL LIST AND NO STREAMING STATE. Placement is a pure function of
 * (worldSeed, typeId, cellX, cellZ, subIndex). A chunk enumerates the cells it
 * covers, hashes each one, and rejects. Nothing is remembered between calls, so
 * a chunk can be regenerated in isolation, in any order, on any machine, and
 * come out bit-identical. That is the same contract terrain.js holds and it is
 * what makes the whole world resumable from a single u32.
 *
 * CELLS NEST INSIDE CHUNKS BY CONSTRUCTION. A type declares `cells`, an INTEGER
 * count of cells per chunk edge, and the cell size is derived as
 * CHUNK_SIZE / cells. Declaring the size in metres instead and asserting it
 * divides 128 looks equivalent and is not: 1.28 is not representable in binary,
 * 128 / 1.28 is 100.00000000000001, and the last cell of every chunk would
 * either be visited twice or not at all. With an integer count the cell index
 * range of a chunk is exact, so no instance is ever duplicated across a chunk
 * boundary and none is ever lost at one.
 *
 * Because scatterPoint() jitters by at most +/-0.425 of a cell, a cell's point
 * always lands inside its own cell and therefore inside its own chunk. There is
 * no cross-chunk overlap to reconcile.
 *
 * THE FIELD GRID IS WHY THIS IS FAST. A naive implementation asks
 * terrain.sampleSlope() per candidate, which is four full heightfield
 * evaluations at a measured 3.2 us, and a single dense chunk offers ~6000
 * candidates - 19 ms, per chunk, for the filter alone. Instead each chunk bakes
 * a 4 m field grid ONCE (height, slope, biome) and every candidate is filtered
 * against a bilinear lookup. Only the candidates that survive every filter pay
 * for one exact terrain.sampleHeight(), because that one is what plants the
 * mesh on the ground the renderer actually draws.
 *
 * Coordinates: +X east, +Y up, +Z south, metres, sea level y = 0. Depths in the
 * type table are POSITIVE METRES DOWN, so a range with negative bounds is above
 * the waterline. Albedos and emissive colours are LINEAR RGB.
 */

import { WORLD, RENDER } from '../core/constants.js';
import { TAU, clamp, lerp, saturate, smoothstep, hashU32 } from '../core/math.js';
import { hash2, hash3, simplex2, fbm2, scatterPoint } from './noise.js';
import * as terrain from './terrain.js';
import { biomeAt, BIOME_COUNT } from './biomes.js';
import { MESH_DETAIL, MESH_PALETTE } from './meshgen.js';
import { insideHabitatClearing } from './habitat_site.js';
import { insideAbyssEncounterFootprint } from './abyss_encounter_site.js';
import { PLACES } from './places.js';
import { caveSkeleton, CAVE_MACRO_SIZE } from './caves.js';

const CHUNK_SIZE = WORLD.CHUNK_SIZE;

// ===========================================================================
// Instance record
// ===========================================================================

/**
 * BYTES PER INSTANCE: 64, and the layout below is authoritative. The render
 * pass declares a vertex buffer with `stepMode: 'instance'` against exactly
 * these offsets, and tools/test-scatter.mjs asserts the stride.
 *
 *   off  size  format      field
 *     0    16  float32x4   row0  = (Bx.x, By.x, Bz.x, localX)
 *    16    16  float32x4   row1  = (Bx.y, By.y, Bz.y, absoluteY)
 *    32    16  float32x4   row2  = (Bx.z, By.z, Bz.z, localZ)
 *    48     4  unorm8x4    tint  = (r, g, b, emissiveScale 0..1)
 *    52     4  float32     swayPhase   radians, stable per instance
 *    56     4  float32     swayAmp     0..2 flexibility multiplier
 *    60     4  unorm8x4    meta  = (fadeRand, typeId/255, variant/255, flags/255)
 *
 * WHY A 3x4 AND NOT A QUATERNION + SCALE. B* are the SCALED basis vectors, so
 * the vertex shader is three dot products and no trig, no quaternion algebra
 * and no normalisation - and a non-uniform scale (a stretched kelp blade, a
 * flattened rubble plate) is free. Packing a quaternion into 4 bytes saves 20
 * bytes an instance and costs a reconstruct in every vertex of every plant.
 *
 * `localX`/`localZ` are CHUNK-LOCAL (0..128) and `absoluteY` is absolute world
 * height, which is exactly terrain.js's vertex convention. The per-draw uniform
 * carries the chunk origin already rebased into camera-relative space, computed
 * on the CPU in f64. Storing absolute XZ instead would leave a plant 3 km from
 * the origin with 0.24 mm of positional resolution - survivable - but its
 * per-vertex geometry would inherit the same quantisation and a 4 mm kelp frond
 * would visibly stairstep.
 *
 * `tint.rgb` decodes as `t * 2`, i.e. a multiplier in [0, 2] with 0.5 meaning
 * unity. `meta.y * 255` recovers the type id.
 */
export const SCATTER_STRIDE = 64;
export const SCATTER_FLOATS_PER_INSTANCE = SCATTER_STRIDE / 4;

/** Instance flag bits, packed into meta.w. */
export const SCATTER_FLAG = {
  HARVESTABLE: 1,
  COLLIDABLE: 2,
  SWAYS: 4,
  EMISSIVE: 8,
};

// There is deliberately NO material enum here. world/meshgen.js stamps
// MESH_MATERIAL onto every VERTEX, so a single mushroom mesh already lights its
// stem as flora and its gills as emissive, and a coral fan already asks for
// evalTranslucency on the membrane and not on the stem. A second, per-TYPE
// material class would be a coarser copy of a finer truth, and the two would
// disagree the first time a generator changed its mind. What a type owns is the
// stuff a mesh cannot know: how bright its bioluminescence is, how far it is
// worth drawing, and how hard the current pushes it.

// ===========================================================================
// Type catalogue
// ===========================================================================

/** Biome id -> bitmask helper. Biome ids come from world/biomes.js BIOMES. */
const bm = (...ids) => ids.reduce((m, i) => m | (1 << i), 0);

// Biome id aliases, so the table below reads as prose rather than as integers.
const BEACH = 0, BASALT = 1, REEF = 2, CORAL_GDN = 3, SAND = 4, KELP = 5;
const BOULDERS = 6, BREAK = 7, SPIRES = 8, TERRACE = 9, CANYON = 10;
const ABYSSAL = 11, TRENCH_WALL = 12, TRENCH_FLOOR = 13, OSSUARY = 14;
const MEADOW = 15, BULB = 16, PLATTER = 17, DUNES = 18;

/**
 * THE PER-BIOME HUE FAMILIES the `biomeTint` maps below draw from.
 *
 * Linear RGB, transcribed from the biome brief's identity matrix, whose "Palette and
 * atmosphere" column is binding art direction. They are authored as hues and
 * NORMALISED TO UNIT REC709 LUMA at bake time, so nothing here changes how much
 * light a biome returns - only which way it is coloured.
 *
 * TWO FAMILIES PER BIOME, DELIBERATELY OPPOSED, AND THAT IS THE WHOLE DESIGN.
 * Painting every prop in a biome one colour lowers the WITHIN-frame hue spread
 * even as it raises the BETWEEN-frame difference, and a cosine that falls while
 * hue entropy falls with it is a regression dressed as a win - it is the failure
 * mode the retired dominant-hue-spread metric had. So each biome carries a
 * MINERAL hue for its rock and a contrasting ACCENT hue for the life and the
 * crystal growing on it: cold blue rock under violet crowns in Rock Spires,
 * iron-red ledges under violet seams in Canyon Wall, pale warm sediment under
 * cold ghost-white forms on the Abyssal Plain. Two hue families in one frame is
 * what raises entropy; one is what flattens it.
 *
 * Trench Floor (13) has NO entry on purpose. It holds 0.063% of the seabed, its
 * authored [1000, 1700] m band cannot be met by a world whose deepest reachable
 * point is -1055.7 m, and it loses 84.8% of its own box to Abyssal Plain.
 * Colouring a place no frame can photograph is the stub this project forbids.
 */
const HUE = Object.freeze({
  // 0 Volcanic Beach - "warm charcoal, rust, wet highlights"
  beachAsh: [1.16, 1.00, 0.78],
  // 1 Island Basalt - "warm brown-black basalt, oxidized orange seams"
  basaltOxide: [1.30, 0.92, 0.62],
  // 2 Shallow Reef - "cream, cyan, salmon"
  reefCarbonate: [1.08, 1.02, 0.90],
  // 4 Sand Plains - "pale gold, desaturated blue"
  sandGold: [1.14, 1.02, 0.80],
  // The LIVING gold of the same identity: the meadow, not the sediment. It is
  // deliberately stronger than sandGold because a blade is seen against open
  // blue water, not against the sand that already carries the mineral hue -
  // and because the P3 baseline measured Sand Plains at 0.181 bits of hue
  // entropy, the flattest underwater frame on the tour, with seagrass holding
  // 76% of the biome's footprint in exactly the water's own cyan. The anchor
  // sits at 51 m, where the red half of a gold is already gone, so the tint's
  // whole visible effect is its BLUE CUT (0.235 after normalisation) pulling
  // the blade off the water's hue toward green; a milder 0.55-blue first cut
  // measured no entropy movement at all, and at 51 m the downwelling light is
  // ~4:1 blue:green, so anything short of a hard cut still reflects net blue.
  // Normalises to 1.458 on red, under BIOME_TINT_CEIL's 1.5990.
  sandGrassGold: [1.55, 1.00, 0.25],
  // 5 Kelp Forest - deep saturated emerald since the 2026-08-18 rebuild (ref
  // SCR-20260801-gooy): the reference blades are dark forest green, not the
  // wheat-olive this row used to author ([1.08, 1.06, 0.74]). Red and blue
  // are cut, green held just over unity - a hue rotation toward emerald, not
  // a brightness change. Peak channel 1.10 x the emit path's 1.2508 = 1.376,
  // under BIOME_TINT_CEIL's 1.5990.
  // Round 2 (delivered frames): [0.62, 1.10, 0.52] still read neon lime
  // under the new green key; round 4: [0.40, 0.80, 0.34] was still pale
  // mint. The whole forest needs to sit DARK against the luminous haze,
  // which is where the reference's mood lives - the trunks in the reference
  // are near-silhouettes.
  kelpOlive: [0.26, 0.58, 0.22],
  // 6 Boulder Field - "cool gray-green rock, muted coral accents"
  boulderGreen: [0.86, 1.06, 0.94],
  boulderCoral: [1.20, 0.94, 0.90],
  // 7 Shelf Break - "golden-brown beds fading into clean blue"
  breakGold: [1.22, 1.00, 0.70],
  breakBlue: [0.86, 0.98, 1.22],
  // 8 Rock Spires - "cold blue rock with sparse violet crowns"
  spireBlue: [0.82, 0.96, 1.28],
  spireViolet: [1.14, 0.86, 1.32],
  // 9 Twilight Terraces - "indigo, violet veils, pale translucent sponges"
  terraceIndigo: [0.90, 0.94, 1.30],
  terraceViolet: [1.16, 0.88, 1.24],
  // 10 Canyon Wall - "iron-red and violet rock against dark blue"
  canyonIron: [1.42, 0.86, 0.66],
  canyonViolet: [1.02, 0.88, 1.32],
  // 11 Abyssal Plain - "near-black indigo, pale sediment, marine snow"
  abyssSediment: [1.10, 1.00, 0.88],
  abyssGhost: [0.92, 0.98, 1.20],
  // 12 Trench Wall - "black-blue with thin violet mineral seams"
  trenchBlack: [0.92, 0.94, 1.26],
  trenchSeam: [1.20, 0.86, 1.24],
  // 14 Ossuary Flats - DESIGN/01 8.5: "bone-fragment gravel", 176,170,156 over
  // 120,116,108. One family only, the MINERAL one, and that is deliberate: the
  // biome's two-family split is pale warm bone against the pallid grey haze
  // its NEPHELOID water already carries, so a second authored accent would
  // fight the water for the accent role.
  ossuaryIvory: [1.10, 1.03, 0.86],
});

/**
 * Ore resources a node can carry. Ids are stable; the mining system indexes
 * this list and RESOURCE_MINED carries the id.
 */
export const ORE_MATERIALS = Object.freeze([
  Object.freeze({ id: 0, key: 'iron', name: 'Iron Nodule', color: [0.088, 0.052, 0.038] }),
  Object.freeze({ id: 1, key: 'copper', name: 'Copper Seam', color: [0.104, 0.062, 0.031] }),
  Object.freeze({ id: 2, key: 'titanium', name: 'Titanium Ore', color: [0.072, 0.076, 0.082] }),
  Object.freeze({ id: 3, key: 'quartz', name: 'Deep Quartz', color: [0.150, 0.170, 0.196] }),
  Object.freeze({ id: 4, key: 'sulphur', name: 'Vent Sulphur', color: [0.196, 0.152, 0.048] }),
]);

/**
 * THE SCATTER TABLE.
 *
 * Fields, and the units they are in:
 *
 *   generator      export name in world/meshgen.js that builds this mesh
 *   meshParams     forwarded to that generator; also the LOD segment counts
 *   biomes         bitmask of biome ids this type may appear in
 *   biomeDensity   optional SPARSE {biomeId: weight} map, weights in [0, 1],
 *                  thinning this type inside the named biomes only. Absent, or
 *                  absent for a given biome, means 1.0 and costs nothing - the
 *                  whole mechanism short-circuits on a null and emits
 *                  byte-identical instances. It exists because `biomes` was a
 *                  ONE-BIT accept/reject: a type was either the biome's carpet
 *                  or absent from it, so the same nine shared props defined five
 *                  different deep biomes. A weight is what makes the biome brief's
 *                  binding `Avoid` column enforceable rather than aspirational.
 *
 *                  IT THINS THE OFFERED POPULATION, BEFORE THE PER-CHUNK CAP.
 *                  So the chunk's `keep` is recomputed against the already-thinned
 *                  count and the delivered count is w x the old count, not
 *                  min(cap, w x old). Weighting a type that is riding its cap
 *                  therefore does exactly what it says; weighting one that is not
 *                  does too.
 *
 *                  NO WEIGHT IS AUTHORED TODAY, AND THAT IS A RESULT, NOT AN
 *                  OMISSION. Three conservative weights shipped with the mechanism
 *                  - seagrass 0.35 in Sand Plains, rockSmall 0.35 in Boulder Field,
 *                  pebbleField 0.30 in Twilight Terraces - and were measured on the
 *                  DELIVERED frames of the 14-anchor tour (tools/test-variety.mjs,
 *                  control-passed, worst self-cosine 0.9980):
 *
 *                    Boulder Field hue entropy 0.172 -> 0.105 bits
 *                    Sand Plains   hue entropy 0.118 -> 0.072 bits
 *
 *                  Both frames got POORER, and the paired PNGs say why in one look:
 *                  the after is the same frame with a scattering of small pale rocks
 *                  REMOVED AND NOTHING PUT BACK. A weight can only subtract. On its
 *                  own it is a subtraction shipped ahead of its replacement, which
 *                  is the plan's own hard sequencing rule ("no reduction ships
 *                  before its replacement") applied to geometry instead of to light,
 *                  and the biome brief's Avoid column is not satisfied by emptiness -
 *                  "small rocks on a normal slope" becomes "a normal slope".
 *
 *                  So all three were removed and the MECHANISM was kept, which was
 *                  always the deliverable. TWO THINGS MUST BE TRUE BEFORE ANY WEIGHT
 *                  LANDS AGAIN, and neither is negotiable:
 *
 *                    1. A weight that removes N instances SHIPS WITH WHAT REPLACES
 *                       THEM, in the same change. The replacement is the biome's
 *                       authored landform or exclusive form, not a different shared
 *                       prop at a different density.
 *                    2. It is GATED ON DELIVERED HUE ENTROPY AT THAT BIOME'S ANCHOR
 *                       NOT FALLING, measured on the frames rather than on the
 *                       instance counts. The counts above did exactly what they were
 *                       authored to do - the delivered ratios were 0.3506, 0.3528
 *                       and 0.3016 against 0.35, 0.35 and 0.30 - and the picture
 *                       still got worse. An offline count is not evidence.
 *                    3. IT IS GATED ON A MATCHED PAIR, NOT ON TWO TOURS. The pair
 *                       above must be the same tree and the same `--only` set with
 *                       the weight as the only difference, because per-anchor
 *                       metrics are not comparable across `--only` sets and a tour
 *                       difference is dominated by FAUNA. Measured that way, only
 *                       ONE of the two headline drops is this mechanism's: Sand
 *                       Plains 0.0912 -> 0.1282 bits when the seagrass came back,
 *                       and Boulder Field 0.0841 -> 0.0831 - i.e. nothing - when
 *                       1,731 cobbles did. The Boulder Field bits were three
 *                       glassclaws that the baseline frame happened to contain.
 *                       See the rockSmall row for the full reading.
 *
 *                  STAGE 3.1 AUTHORED THE FIRST REAL WEIGHTS (2026-08-07), and
 *                  they meet all three conditions: mushroomCap {ABYSSAL 0.50,
 *                  TERRACE 0.55}, mushroomCluster {ABYSSAL 0.80}, glowPod
 *                  {TERRACE 0.85}, shipped IN THE SAME CHANGE as the abyssRib
 *                  0.18 -> 0.30 and terraceShelf 1.15 -> 1.50 raises, gated on
 *                  matched-pair delivered hue entropy. The reasoning and the
 *                  census numbers live at the mushroomCap row; test-scatter 5b's
 *                  ratio assertions now have a live subject set.
 *   biomeTint      optional SPARSE {biomeId: [r, g, b]} map of LINEAR RGB
 *                  multipliers on this type's per-instance albedo tint, so ONE
 *                  mesh reads iron-red in Canyon Wall and black-violet in Trench
 *                  Wall. It rides the same per-candidate biomeAt() the mask
 *                  already paid for, is written AFTER the accept decision so no
 *                  instance moves, and reaches the shader through three bytes
 *                  that already exist (`tint.rgb`, pass/scatter.wgsl:286). Absent
 *                  means byte-identical output.
 *
 *                  IT IS NORMALISED TO UNIT REC709 LUMA AT BAKE TIME, and that
 *                  is not tidiness. It is the same rule renderer.js applies to
 *                  BIOMES[].fogTint: a colour multiplier that changes ENERGY
 *                  feeds the auto-exposure histogram, so a "richer" biome would
 *                  quietly re-expose the whole frame and the change would read as
 *                  a tone bug rather than a hue one. Author a HUE here; the bake
 *                  divides the luma out. See bakeBiomeTints() for the ceiling
 *                  that stops the bright half of the encode clipping in silence.
 *
 *                  IT IS NOT AUTHORED ON THE FOUR CORAL FAMILIES. Their colour
 *                  is a measured pigment model - colorMul levelled to a fixed
 *                  post-response luminance against fluorescentReflectance() in
 *                  the shader - and a second, coarser hue rotation on top of it
 *                  would be two pigment models disagreeing. Nor on the twelve
 *                  signature rows: each lives in ONE biome, where a per-biome
 *                  tint is a constant and belongs in colorMul. Nor on the five
 *                  ore rows, whose host-rock and vein colours come from
 *                  meshgen's ORE_APPEARANCE precisely so a resource is found BY
 *                  EYE, and a hue that rotated with the biome is the one change
 *                  that would break that.
 *
 *                  AUTHOR ONLY PAIRS THAT EXIST. Every value below was checked
 *                  against censusTypeByBiome over 111 chunks first, and three
 *                  candidates were dropped because the world places ZERO of that
 *                  type in that biome - beachPebble and deepGrass in Sand Plains,
 *                  whose depth bands do not meet the biome's, and ventChimney in
 *                  Canyon Wall, which offers ONE instance. A field authored onto
 *                  a pair with no instances is the dead-authored-data bug this
 *                  project keeps re-finding, and a type mask is not evidence the
 *                  pair occurs.
 *
 *                  WHERE IT DELIVERS, MEASURED, AND THIS IS THE RESULT TO READ
 *                  BEFORE AUTHORING MORE OF IT. A tint is a REFLECTANCE, so it
 *                  reaches the frame only where the type has SCREEN AREA, where
 *                  there is LIGHT on it, and where the hue is off the frame's own
 *                  dominant. A/B on SCATTER_TUNING.biomeAppearanceStrength over
 *                  tools/test-variety.mjs, same anchor set both arms, control
 *                  self-cosine 0.9994-0.9999:
 *
 *                    kelp      hue entropy 0.974 -> 1.143 bits (+17.4%), and the
 *                              paired frames show it - the stalks stop being the
 *                              same mint as the water and read green against it
 *                    the six deep anchors (boulders 97 m ... trenchWall 971 m)
 *                              -0.027 to +0.000 bits, i.e. NOTHING
 *                    every median frame luminance within 0.52%, worst 0.52%
 *
 *                  The deep result is not a bug in this mechanism, it is the
 *                  Stage 2 diagnosis arriving early: diffuse in-scatter is 92-94%
 *                  of a deep pixel, nulling the scatter pass at Abyssal Plain
 *                  drops scene luminance 99.86%, and below 95 m there is no
 *                  directional term at all - so an albedo down there is
 *                  multiplied by almost nothing and no reflectance change can
 *                  show. THE DEEP TINTS ARE AUTHORED ANYWAY AND ON PURPOSE: they
 *                  are the reflectance the Stage 2 lights will land on, and the
 *                  byte-level separation is real and measurable offline today
 *                  (rockMedium delivers 122.3 degrees of hue between Canyon Wall
 *                  and Trench Wall, asserted in test-scatter section 5c). Do not
 *                  re-derive them from a deep screenshot before those lights
 *                  exist and conclude they do nothing.
 *
 *                  AND DO NOT A/B THIS OFF A PAIR OF TOUR FRAMES. Two traps cost
 *                  a whole measurement pass here. Per-anchor metrics are NOT
 *                  comparable across runs with different `--only` sets - the same
 *                  reef frame read 1.813 bits in a 7-anchor tour and 1.69-1.71 in
 *                  a 2-anchor one, which looked exactly like a regression caused
 *                  by an edit that had not happened yet. And a whole-frame pixel
 *                  difference between two runs is dominated by FAUNA: the sand
 *                  anchor measured 63% of pixels moved and a p99 of 176/765
 *                  between two arms whose visible difference was a ray and two
 *                  urchins in different places.
 *   biomeGlow      optional SPARSE {biomeId: scale} map in (0, 1] on this type's
 *                  per-instance EMISSIVE scale - `tint.a`, which the shader
 *                  multiplies straight into scatter.emissive.rgb
 *                  (pass/scatter.wgsl:716) and which glow.js reads back out of
 *                  byte 51 as `emitScale`, so the geometry and its aureole dim
 *                  together and cannot disagree.
 *
 *                  IT CAN ONLY REDUCE, BY CONSTRUCTION, AND THAT DECIDES WHERE
 *                  IT MAY BE AUTHORED TODAY. The base is saturate(0.55 + 0.45*h3)
 *                  whose top is exactly 1.0, so any scale above 1 would clip the
 *                  bright half of the hash and deliver less variation, not more -
 *                  bakeBiomeGlow() throws rather than allowing it. Below ~95 m
 *                  the frame IS the emissive scatter (nulling the scatter pass at
 *                  Abyssal Plain drops scene luminance 99.86%), so a cut there is
 *                  a subtraction of the only light in the image and it does not
 *                  ship before Stage 2 gives it a replacement. The values
 *                  authored here are therefore all in biomes that still have
 *                  daylight, and the deep cuts the biome brief's Avoid column asks
 *                  for are deliberately absent rather than forgotten.
 *   signatureBiome optional biome id whose exclusive skyline/landmark this is
 *   density        instances per 100 m^2 at FULL density modulation. For a
 *                  colony type this is the PEAK inside a colony, not the mean.
 *   cells          cells per chunk edge (integer). cellSize = 128 / cells.
 *   maxPerCell     hard cap on one cell's draws, so a density spike cannot
 *                  turn one cell into a hedge
 *   scale          [min, max] uniform scale multiplier
 *   stretch        [min, max] EXTRA vertical scale on top of `scale`
 *   slope          [min, max] terrain gradient magnitude (tan of the angle)
 *   depth          [min, max] POSITIVE metres below sea level; negative = above
 *   align          0 = stays vertical regardless of the ground, 1 = fully
 *                  aligned to the surface normal
 *   tilt           random tilt jitter about a hashed axis, radians
 *   sink           metres the instance origin is pushed BELOW the ground per
 *                  unit of vertical scale. Base-anchored meshes (plants, corals,
 *                  chimneys) want a little, so the root is buried rather than
 *                  balanced; origin-centred meshes (rock, boulder, pebble, ore)
 *                  are already half-buried at 0, so they want almost none.
 *   colony         null, or {size (m), coverage 0..1, edge 0..1}
 *   sways          true if the current bends it (drives SCATTER_FLAG.SWAYS)
 *   stiffness      0 = a rag, 1 = a stick. Inverted into the per-instance sway
 *                  amplitude, so a bed of one type still does not move as one.
 *   swayStrength   metres the TIP travels at unit amplitude. Giant kelp swings
 *                  1.3 m; a seagrass blade 13 cm. The mesh's own sway weight
 *                  (colour.w, 0 at the anchor and 1 at the tip) shapes it.
 *   twoSided       true for single-sided sheets - blades, fronds, gorgonian
 *                  membranes - which must be drawn with culling off or half of
 *                  every plant in the ocean disappears when seen from behind.
 *                  Closed solids stay false and keep their back-face rejection.
 *   emissive       peak emissive luminance, cd/m^2
 *   emissiveColor  linear RGB of that emission
 *   fluoresces     true if that emission is FLUORESCENCE rather than
 *                  bioluminescence or a mineral glow. The shader then pumps it
 *                  with the blue daylight surviving to the instance's depth
 *                  instead of letting it burn on its own, and skips the
 *                  material slot's emissive gate because the whole tissue
 *                  carries the protein rather than one organ. It is the only
 *                  mechanism that puts colour back on a reef: over the reef's
 *                  6.3 m column plus an 8 m sightline, red transmits 0.0131
 *                  against blue's 0.3475, a MEASURED 26x differential that no
 *                  albedo can climb.
 *
 *                  THE MECHANISM IS PHYSICS; THE COEFFICIENT IS NOT, AND THIS
 *                  IS THE HONEST NUMBER. A heavily pigmented coral re-emits
 *                  roughly 1-3% of the blue it absorbs. At the reef that is
 *                  0.9 x 73.4 = 66 units of absorbed blue irradiance, so a real
 *                  peak fluorescent radiance is 0.2-0.6. These types are
 *                  authored at a peak of about 3.4, i.e. 6x the top of the real
 *                  range (it was 2.2 and 4x). That is a deliberate exaggeration
 *                  and it is the only one here: the pump, the depth falloff and
 *                  the night cut-off are all the genuine article, and at a true
 *                  quantum yield the reef stays a grey silhouette past 4 m. Do
 *                  not re-derive these from first principles and conclude they
 *                  are too high - they are, on purpose, by a stated factor.
 *
 *                  THE ABSORPTION IS THE OTHER HALF OF THE MECHANISM AND IT IS
 *                  WHERE THE COLOUR ACTUALLY COMES FROM. A surface cannot both
 *                  reflect the blue pump and re-emit it. One shared response
 *                  fixed that double count but made all four coral families the
 *                  same pale pink. `fluorescentReflectance()` now gives the four
 *                  families distinct reflected spectra - salmon (branching),
 *                  GFP green (brain), gold (fan) and teal (tube) since the P3
 *                  shallow colour pass; the first split's four were three
 *                  red-dominant hues plus green, and the water's 26x red
 *                  deficit collapsed the three back onto one pink. (A violet
 *                  brain was tried in that pass and measured worse - see the
 *                  coralBrain row.)
 *                  The four colorMul rows are re-levelled so their
 *                  post-response luminance remains exactly 0.092-0.106: colour
 *                  changes, energy does not. Measured on the fixed shallow
 *                  census after the first split, Coral Garden off-hue coverage
 *                  was 1.743% -> 16.546% with scene luminance unchanged at
 *                  0.142 and 0.012% clipping.
 *   algalFilm      0..1 scale on mineralSurface's algal turf. 1 on bare rock,
 *                  0 on living tissue. It only reaches the shader for types
 *                  whose mesh stamps ROCK, SEDIMENT or METAL - which includes
 *                  brain coral, because meshgen builds it as a carbonate dome.
 *   roughnessBias  OPTIONAL additive bias on the material slot's own base
 *                  roughness (pass/scatter.wgsl `params.x`; absent = 0, the
 *                  historical value). Added for the emerald rebuild: the
 *                  TRANSLUCENT slot's 0.62 base made wet kelp membranes
 *                  mirror the bright canopy, and no albedo edit could darken
 *                  a pixel that was mostly reflection.
 *   colorMul       multiplier on the MESH's own vertex colour. meshgen owns
 *                  albedo - MESH_PALETTE, transcribed from DESIGN/01 - and this
 *                  is the CALIBRATION on top of it.
 *
 *                  THE REFERENCE IS THE VEIL, NOT THE SEABED, AND THAT IS THE
 *                  CORRECTION. It is not a stylistic knob: MESH_PALETTE is
 *                  authored as sRGB display bytes, so MESH_PALETTE.PALE_ROCK
 *                  converts to a linear reflectance of 0.43 and
 *                  MESH_PALETTE.CORAL_CREAM to 0.84, and left alone every rock in
 *                  the game renders two to four times brighter than the ground it
 *                  sits on - white plastic pebbles on grey sand, which is what the
 *                  first build shipped. But the MINERAL rows were then set by
 *                  matching seabed reflectance (reef 0.196, abyssal plain 0.087),
 *                  and the coral and sponge rows inherited the same reference,
 *                  which is the wrong one for them.
 *
 *                  What decides whether an object reads UNDERWATER is its ratio to
 *                  the additive in-scatter veil between it and the eye, not its
 *                  ratio to the sand. MEASURED at REEF_TURQUOISE, 10 m of column
 *                  and a 10 m sightline: CORAL_ORANGE is linear (0.767, 0.220,
 *                  0.106) and carries a Weber contrast against the water beside it
 *                  of +107.9 / +67.5 / +20.3%; through coralFan's old
 *                  [0.32, 0.32, 0.30] that became +34.5 / +21.6 / +6.1%, a 3.1x
 *                  loss that moved the veil from 48% of the pixel to 74% in red.
 *                  The PALETTE was never the problem - post-multiplier CIELAB C*
 *                  is coralFan 50.2, glowPod 41.9, coralBranching 34.3 - the LEVEL
 *                  was. The two SPONGE rows are therefore ~1.75x their
 *                  seabed-matched values. The MINERAL rows are unchanged,
 *                  because for a rock the seabed IS the right reference: a stone
 *                  brighter than the sediment it lies in reads as a bug.
 *
 *                  THE THREE WARM CORAL ROWS WENT BACK DOWN AGAIN, AND THAT IS
 *                  NOT A REVERSAL OF THE VEIL ARGUMENT - IT IS THE VEIL ARGUMENT
 *                  APPLIED TO THE RIGHT QUANTITY. What the 1.75x bought was Weber
 *                  contrast in LUMINANCE, and luminance contrast against a blue
 *                  veil is a grey-on-blue silhouette. MEASURED at the reef anchor
 *                  with those values shipped, the delivered coral pixel was
 *                  sRGB (189, 184, 222): hue 248, blue-DOMINANT, HSV saturation
 *                  0.170, on a frame whose own dominant hue was 225. The coral
 *                  never left the water's hue at all, and 0.61% of that frame
 *                  cleared a 40-degrees-off-dominant test. What reads underwater
 *                  is HUE, and hue survives only while the pixel stays off the
 *                  AgX shoulder - a brighter coral is a WHITER one.
 *
 *                  The split keeps the established luminance baseline rather
 *                  than tuning against a prettier exposure: branching, fan, and
 *                  tube tissue remain 0.106 Rec709 linear; brain remains 0.092.
 *                  Their uniform triples are calibration gains only. Spectral
 *                  shaping stays in the shader, where reflection and the
 *                  separately pumped fluorescence cannot drift into two
 *                  contradictory pigment models.
 *   oreAppearance  ore types only: the row of meshgen's ORE_APPEARANCE table
 *                  that supplies the host rock colour, the vein colour and the
 *                  vein's own emission. Distinct from ore.materialId, which is
 *                  what the mining system harvests - two nodes can look alike
 *                  and yield different things, and one resource can outcrop in
 *                  two different host rocks.
 *   translucency   SCALES the translucency the vertex's material slot implies.
 *                  0 forces opaque; 1 leaves the slot's own value alone.
 *   thickness      optical thickness in METRES, for evalTranslucency. A seagrass
 *                  blade is 2 mm and a brain coral is 50 mm, and the difference
 *                  is the whole reason one glows when backlit and the other does
 *                  not.
 *   maxDetail      MESH_DETAIL ceiling. The LOD chain runs from here down to
 *                  LOW; a type placed by the thousand never asks for HIGH.
 *   viewDistance   metres past which this type is not drawn at all
 *   fadeStart      metres at which it begins shrinking out
 *   maxLod         highest terrain LOD ring that still generates this type
 *   maxPerChunk    per-type cap inside one chunk
 *   importance     degradation order; the LOWEST importance is dropped first
 *   ore            null, or {materialId, amount: [min, max]}
 *   collidable     true if the future collision proxy should include it
 *
 * ON VIEW DISTANCES. They look short for a game with a 4 km view distance and
 * they are set by physics, not by taste. WATER_TYPES.REEF_TURQUOISE has a blue
 * beam extinction of 0.144 /m, so 1% of the contrast of a coral head survives
 * 32 m; OCEANIC_CLEAR's 0.0415 /m reaches 111 m. Drawing a seagrass blade at
 * 400 m underwater renders a sub-pixel triangle into fog that has already
 * saturated. The two ABOVE-WATER types are the exceptions and get to reach
 * further, because air does not do that.
 */
export const SCATTER_TYPES = Object.freeze([
  Object.freeze({
    id: 0, key: 'shoreGrass', name: 'Shore Grass',
    generator: 'generateShoreGrass', meshParams: { blades: 11, height: 0.55 },
    biomes: bm(BEACH, BASALT), density: 30, cells: 50, maxPerCell: 8,
    // depth -150 is an ALTITUDE of 150 m, and it is what puts anything at all on
    // the volcano. The Island Basalt anchor sits at +122.7 m with a median slope
    // of 1.01 over its own 60 m, and every type that names BASALT used to stop at
    // -34 to -96 - so a MEASURED ZERO instances of any type existed within 60 m
    // of it. The whole biome was bare terrain.
    scale: [1.30, 2.60], stretch: [0.8, 1.4], slope: [0, 0.72], depth: [-150, -0.35],
    align: 0.85, tilt: 0.14, sink: 0.06,
    colony: { size: 46, coverage: 0.64, edge: 0.5 },
    // 0.07 was 0.06-0.09 m of tip travel on a MEASURED mean plant height of
    // 1.34 m - 5-7% of its own height at a 7 s period, which is
    // indistinguishable from static. Dune grass in a Beaufort-3 wind moves
    // 15-30% of its height; 0.24 with SWAY_RATE_AIR gives 0.21-0.32 m, i.e.
    // 16-24% at a 2.4 s carrier.
    sways: true, stiffness: 0.25, swayStrength: 0.24, twoSided: true,
    emissive: 0, emissiveColor: [0, 0, 0],
    fluoresces: false, algalFilm: 0.00,
    colorMul: [1.00, 1.00, 1.00], translucency: 1.00, thickness: 0.0020,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 200, fadeStart: 136, maxLod: 1, maxPerChunk: 2400, importance: 3,
    ore: null, collidable: false,
    note: 'Binds the dune crest above the strand line; the only reason the beach reads as land.',
  }),
  Object.freeze({
    id: 1, key: 'alienFrond', name: 'Alien Frond',
    generator: 'generateAlienFrond', meshParams: { size: 1.2, leaflets: 7 },
    biomes: bm(BEACH, BASALT), density: 11, cells: 32, maxPerCell: 2,
    scale: [0.8, 2.3], stretch: [0.85, 1.5], slope: [0, 0.90], depth: [-200, -1.0],
    align: 0.7, tilt: 0.12, sink: 0.12,
    colony: { size: 74, coverage: 0.50, edge: 0.45 },
    // In AIR, on a MEASURED mean plant height of 1.98 m: 0.26 was 9-13% of its
    // own height. 0.42 gives 0.29-0.43 m, i.e. 14-22%.
    sways: true, stiffness: 0.42, swayStrength: 0.42, twoSided: true,
    emissive: 0, emissiveColor: [0, 0, 0],
    fluoresces: false, algalFilm: 0.00,
    colorMul: [1.00, 1.00, 1.00], translucency: 1.00, thickness: 0.0040,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 340, fadeStart: 230, maxLod: 2, maxPerChunk: 220, importance: 5,
    ore: null, collidable: false,
    note: 'The island silhouette. Tall enough to break the basalt skyline from the beach.',
  }),
  Object.freeze({
    id: 2, key: 'beachPebble', name: 'Beach Shingle',
    generator: 'generatePebble', meshParams: { size: 1.0, irregularity: 0.32 },
    biomes: bm(BEACH, REEF, SAND), density: 11, cells: 50, maxPerCell: 8,
    // Shingle is the same pebble on two shores and it should not be: volcanic
    // ash against carbonate grit, at the one scale a diver reads shingle at.
    // SAND is in the mask and is deliberately NOT tinted - censused over 111
    // chunks, this type places ZERO instances in Sand Plains, because its
    // [-7, 4] m band and the biome's [10, 90] m band do not meet. A tint there
    // would be exactly the dead authored data this pass exists to stop adding.
    biomeTint: { [BEACH]: HUE.beachAsh, [REEF]: HUE.reefCarbonate },
    scale: [0.05, 0.16], stretch: [0.5, 0.9], slope: [0, 0.5], depth: [-7, 4],
    align: 0.95, tilt: 0.7, sink: 0.06,
    colony: null,
    sways: false, stiffness: 1, swayStrength: 0.00, twoSided: false,
    emissive: 0, emissiveColor: [0, 0, 0],
    fluoresces: false, algalFilm: 1.00,
    colorMul: [0.34, 0.32, 0.30], translucency: 0.00, thickness: 0.0500,
    maxDetail: MESH_DETAIL.MEDIUM,
    viewDistance: 68, fadeStart: 44, maxLod: 0, maxPerChunk: 1100, importance: 1,
    ore: null, collidable: false,
    note: 'Spans the waterline deliberately: shingle is what a swash zone leaves behind.',
  }),
  Object.freeze({
    id: 3, key: 'seagrass', name: 'Seagrass',
    generator: 'generateSeagrass', meshParams: { blades: 11, height: 0.7 },
    // 46 instances per 100 m^2 at 1.62 m of MEASURED mean height made this the
    // default carpet of four biomes and 50 of the 55 silhouette-area points the
    // four commonest types held between them. DESIGN/01 6.1 authors fl_siltgrass
    // at H 0.70 m; the scale band below delivers a mean 0.79 m, so the meadow is
    // still a meadow and stops being the skyline.
    // BULB was added here on 2026-08-18 and removed the same day on the
    // first delivered frames: at density 30 the grove floor was a seagrass
    // lawn and the reference's clean white sand was gone. The teal pomPuff
    // row carries the grove's ground interest instead.
    biomes: bm(REEF, SAND), density: 30, cells: 50, maxPerCell: 8,
    // NO biomeDensity. A 0.35 weight in Sand Plains shipped here and was removed:
    // it delivered its ratio exactly (0.3506) and cost the anchor frame hue
    // entropy 0.118 -> 0.072 bits. Sand Plains' dune bowls and rare oases are the
    // replacement and they are Stage 3; see the biomeDensity entry in the table
    // header for the two conditions any future weight must meet.
    // GOLD IN SAND PLAINS ONLY (P3 shallow colour pass). The census puts
    // seagrass at 99,406 instances / 86k m^2 of footprint there - 76% of the
    // biome - all delivered in the water's own cyan, and the anchor frame
    // measured 0.181 bits of hue entropy, the tour's flattest. The tint is the
    // biome's authored "pale gold" landing on its one carrier of screen area,
    // and it is what separates Sand Plains from Shallow Reef (their pair read
    // 0.888, the tour's worst): the REEF meadow stays untinted green.
    biomeTint: { [SAND]: HUE.sandGrassGold },
    scale: [0.80, 1.60], stretch: [0.7, 1.3], slope: [0, 0.36], depth: [1.0, 68],
    align: 0.95, tilt: 0.1, sink: 0.05,
    colony: { size: 38, coverage: 0.58, edge: 0.55 },
    // Real seagrass under 6 m of water lays over 40-70% of its length. 0.13 was
    // a MEASURED 0.19 m of mean tip travel on a mean plant height of 1.62 m -
    // a 12% sweep at a 7 s period, which is visually static. 0.32 measures 0.478
    // m mean over the 2,600 tufts of the reef chunk at the live sea state of 3,
    // i.e. 29% of height mean and 52% on the worst instance once the 0.66-1.0
    // gust envelope is included.
    sways: true, stiffness: 0.12, swayStrength: 0.32, twoSided: true,
    emissive: 0, emissiveColor: [0, 0, 0],
    fluoresces: false, algalFilm: 0.00,
    colorMul: [1.00, 1.00, 1.00], translucency: 1.00, thickness: 0.0020,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 92, fadeStart: 60, maxLod: 0, maxPerChunk: 2600, importance: 2,
    ore: null, collidable: false,
    note: 'Meadow filler on the sand flats. The softest thing in the game and it must move.',
  }),
  Object.freeze({
    id: 4, key: 'deepGrass', name: 'Abyssal Sea Whip',
    generator: 'generateSeagrass', meshParams: { blades: 8, height: 1.6 },
    biomes: bm(TERRACE, ABYSSAL, SAND), density: 5.0, cells: 40, maxPerCell: 3,
    // Ghost-white against the Abyssal Plain's pale warm sediment so the whip
    // reads as tissue rather than as sediment that happens to stand up; indigo
    // in the Terraces, where it is part of the violet backbone. SAND is in the
    // mask and is not tinted: censused over 111 chunks this type places ZERO
    // instances in Sand Plains, whose [10, 90] m band never meets the [130, 1500]
    // one below.
    biomeTint: { [TERRACE]: HUE.terraceIndigo, [ABYSSAL]: HUE.abyssGhost },
    scale: [0.90, 1.90], stretch: [1.1, 1.9], slope: [0, 0.3], depth: [130, 1500],
    align: 0.9, tilt: 0.16, sink: 0.08,
    colony: { size: 96, coverage: 0.38, edge: 0.5 },
    sways: true, stiffness: 0.3, swayStrength: 0.11, twoSided: true,
    emissive: 0.35, emissiveColor: [0.18, 0.52, 0.62],
    fluoresces: false, algalFilm: 0.00,
    colorMul: [0.70, 0.78, 0.88], translucency: 0.90, thickness: 0.0030,
    maxDetail: MESH_DETAIL.MEDIUM,
    viewDistance: 135, fadeStart: 90, maxLod: 1, maxPerChunk: 900, importance: 3,
    ore: null, collidable: false,
    note: 'A faint tip glow: the deep plain needs something to catch a lamp at 900 m.',
  }),
  Object.freeze({
    id: 5, key: 'kelpStalk', name: 'Bull Kelp',
    // BOULDERS-ONLY SINCE THE 2026-08-18 EMERALD REBUILD (round 6). This row
    // used to carry the Kelp Forest's understory too; the rebuild's dark
    // forest needed that understory taller, thicker, darker and
    // surface-capped, and every one of those levers is either per-ROW
    // (colorMul, translucency, meshParams) or normalised away (biomeTint is
    // unit-luma - it cannot darken), so styling it here would have restyled
    // Boulder Field's understory with it. The Kelp Forest's understory is
    // now its own row - kelpVine, id 67, at the end of the table (ids are
    // placement salts; the mask change moves no boulders instance, because
    // placement streams are salted by TYPE id and only the per-cell accept
    // reads the mask). Every field below is the pre-rebuild value, so
    // Boulder Field's delivered understory is bit-identical to before.
    generator: 'generateKelp',
    meshParams: { blades: 14, height: 10.0, bands: 3 },
    biomes: bm(BOULDERS), density: 8.5, cells: 25, maxPerCell: 3,
    // Cool grey-green: an understory plant on Boulder Field's slabs.
    biomeTint: { [BOULDERS]: HUE.boulderGreen },
    // 6.0 -> 10.0 m and `bands: 3`. The height is item 3.4; the bands are what
    // stop a taller stalk reading as a longer bare pole - blades gather into
    // three clusters weighted toward the head instead of furring the whole
    // stipe evenly. 11.08 m of local mesh against a scale band whose top is
    // 1.62 reaches 18.0 m, and `depth[0] = 20` is what clears it: the shallow
    // edge of a depth band has to clear the TALLEST instance the band can draw,
    // because a stipe is sized by its own scale and knows nothing about the
    // water over it. See kelpGiant's row for the 36.4% breach this rule exists
    // to prevent.
    // depth hi 110 -> 86, 2026-08-18, BY EXPLICIT USER PLAYTEST INSTRUCTION
    // for the Platter Forest (biome 17, 88-124 m): "they should be their own
    // biome, no tall plants". This row's BOULDERS carriage was delivering
    // 2,398 stalks of 10-18 m kelp wall into the forest's 3x3-chunk anchor
    // box on Boulder Field's interleaved dune flanks - the only tall plant
    // that reaches past 88 m at all. The cut is measured, not guessed:
    // Boulder Field's own anchor box (-992, -544) holds 1,006 kelpStalk and
    // loses exactly 50 of them (5.0%) - kelp lives on the biome's shallow
    // half, so the biome that carries this row keeps its understory where it
    // is judged. 86 also stays physically defensible for a photic organism
    // (real bull kelp stops nearer 30 m).
    scale: [0.8, 1.35], stretch: [1.0, 1.20], slope: [0, 0.66], depth: [20, 86],
    align: 1.0, tilt: 0.08, sink: 0.1,
    colony: { size: 120, coverage: 0.5, edge: 0.42 },
    sways: true, stiffness: 0.08, swayStrength: 0.55, twoSided: true,
    emissive: 0, emissiveColor: [0, 0, 0],
    fluoresces: false, algalFilm: 0.00,
    colorMul: [1.00, 1.00, 1.00], translucency: 1.00, thickness: 0.0040,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 190, fadeStart: 128, maxLod: 1, maxPerChunk: 900, importance: 6,
    ore: null, collidable: false,
    note: 'Colony size 120 m: a kelp bed is a landmark, not a sprinkle.',
  }),
  Object.freeze({
    id: 6, key: 'kelpGiant', name: 'Giant Kelp',
    generator: 'generateGiantKelp',
    // 2026-08-18 emerald rebuild (ref SCR-20260801-gooy), round 3 sized by
    // playtest ("at least 3-4 times taller than what we have now"): height
    // 24 -> 42 under the new per-instance `surfaceCap`, which clamps each
    // plant's vertical scale to the water over it - so the row delivers
    // 40-55 m trunks on deep ground and proportionally shorter ones from
    // 30 m of water up, with no static tallest-instance bound. blades 26,
    // bands 5, secondary 2, girth 1.75, bladeWide 1.35, crown 10 (the heavy
    // drooping head the playtest asked for - "ours look like a stick with a
    // few stems"). Density 0.9 -> 1.5.
    meshParams: { blades: 26, height: 84.0, bands: 5, secondary: 2,
      girth: 2.2, bladeWide: 1.35, bladeLen: 1.1, crown: 10 },
    biomes: bm(KELP), signatureBiome: KELP, density: 1.5, cells: 16, maxPerCell: 2,
    // 16.77 m of LOCAL mesh height against the old [0.85, 2.2] x [1.0, 2.2] reached
    // 81.9 m, so a MEASURED 36.4% of instances breached the waterline and clipped
    // to white. That is the regression this row exists to remember, and the rule it
    // produced is the one every number below is derived from: A STIPE IS SIZED BY
    // ITS OWN SCALE BAND AND KNOWS NOTHING ABOUT THE WATER OVER IT, so the SHALLOW
    // EDGE OF THE DEPTH BAND MUST CLEAR THE TALLEST INSTANCE THE SCALE BAND CAN
    // DRAW. Everything else is negotiable; this is not.
    //
    // 2026-08-06, item 3.4: 16.0 -> 24.0 m and the depth band moved WITH it, in the
    // same change, because moving one without the other is what caused the 36.4%.
    // Local mesh height is 25.25 m (the canopy bend adds a little over the authored
    // 24), the scale band tops out at 1.4 x 1.05 = 1.47, so the tallest instance is
    // 37.1 m and `depth[0] = 38` clears it. That band still covers 89.1% of the
    // Kelp Forest's own seabed - measured, floor depth p5 33 / p50 56.5 / p95 74.9
    // over 19,320 samples - so raising it does not empty the biome, which is the
    // failure the old comment records for depth 24. The ANCHOR was re-derived in
    // this same commit and sits at 43.1 m, inside the band.
    //
    // `bands: 4` and `secondary: 1` are the shape half. A 25 m stipe with blades
    // spiralled evenly up it is a furred pole; the reference frame this biome is
    // authored against is a braided stalk with a drooping CROWN at its head, which
    // is what four head-weighted bands plus one branch deliver. FRUIT IS NOT ON THIS
    // ROW - see kelpChampion, which is how the biome brief's "10-20% of mature giants
    // carry fruit" is authored deterministically instead of by a correlated hash.
    // `surfaceCap` supersedes the static breach arithmetic that used to live
    // here (see the cap comment in the placement loop): depth[0] is now only
    // "the least water worth a giant" - at 30 m the cap delivers a ~25 m
    // plant - and the crown stays 2.5 m under the waterline at every column.
    surfaceCap: 2.5,
    scale: [1.05, 1.30], stretch: [1.0, 1.05], slope: [0, 0.95], depth: [48, 190],
    align: 1.0, tilt: 0.05, sink: 0.14,
    // Coverage exactly at the signature contract's 0.50 cap (test-scatter:
    // a signature keeps negative space); the rebuild's extra forest mass
    // rides the non-signature rows (bloom/champion/canopy/titan).
    colony: { size: 150, coverage: 0.50, edge: 0.38 },
    sways: true, stiffness: 0.05, swayStrength: 2.2, twoSided: true,
    emissive: 0, emissiveColor: [0, 0, 0],
    fluoresces: false, algalFilm: 0.00,
    colorMul: [0.32, 0.45, 0.26], roughnessBias: 0.30, translucency: 0.30, thickness: 0.0050,
    maxDetail: MESH_DETAIL.HIGH,
    // maxPerChunk 190 -> 120 with the emerald rebuild: the lusher mesh is
    // ~2,200 verts at HIGH, and 120 x 2,200 = 264,000 keeps the worst chunk
    // BELOW the 190 x 1,485 = 282,150 the old giant already shipped.
    viewDistance: 300, fadeStart: 210, maxLod: 2, maxPerChunk: 120, importance: 8,
    ore: null, collidable: false,
    note: 'The forest canopy. 25-37 m tall, so the eye under it has a ceiling.',
  }),
  Object.freeze({
    id: 7, key: 'coralBranching', name: 'Branching Coral',
    generator: 'generateCoralBranching', meshParams: { attractors: 320, spread: 0.55, height: 2.0 },
    biomes: bm(REEF, CORAL_GDN), density: 7.0, cells: 50, maxPerCell: 3,
    // DESIGN/01 6.1 authors fl_pillar_coral at H 2.60 m. At the old 1.1 m mesh
    // height this delivered a mean 1.42 m - 1.8x under the spec for the type that
    // IS the shape of the Coral Garden.
    scale: [0.55, 1.9], stretch: [0.8, 1.4], slope: [0, 0.92], depth: [1.5, 48],
    align: 0.7, tilt: 0.22, sink: 0.18,
    colony: { size: 54, coverage: 0.6, edge: 0.5 },
    sways: false, stiffness: 1, swayStrength: 0.00, twoSided: false,
    emissive: 7.0, emissiveColor: [1.00, 0.42, 0.20],
    fluoresces: true, algalFilm: 0.00,
    // 0.527 keeps post-pigment albedo luminance at the established 0.106 while
    // fluorescentReflectance(7) supplies the saturated DsRed/salmon spectrum
    // (deepened 2026-08-17, re-levelled here in the same change).
    colorMul: [0.527, 0.527, 0.527], translucency: 0.50, thickness: 0.0200,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 145, fadeStart: 98, maxLod: 1, maxPerChunk: 1400, importance: 7,
    ore: null, collidable: true,
    note: 'Acropora habit: the densest thing on the reef and the reason it reads as a reef. '
      + 'The orange is DsRed-family fluorescence, brightest at the growing tips, because '
      + 'floraSurface puts its glow on uv.y - which is exactly where the protein is.',
  }),
  Object.freeze({
    id: 8, key: 'coralBrain', name: 'Brain Coral',
    generator: 'generateCoralBrain', meshParams: { folds: 9, radius: 0.9 },
    biomes: bm(REEF, CORAL_GDN, BOULDERS), density: 2.2, cells: 32, maxPerCell: 1,
    scale: [0.5, 2.1], stretch: [0.75, 1.25], slope: [0, 0.44], depth: [3, 52],
    align: 0.8, tilt: 0.12, sink: 0.24,
    colony: null,
    sways: false, stiffness: 1, swayStrength: 0.00, twoSided: false,
    // 5.0 WAS TUNED AGAINST AN ALBEDO AND HAD TO BE RETUNED AGAINST A RENDER.
    // The albedo comparison said the dome was three quarters of the seabed's
    // reflectance and therefore safe. What reached the screen was 1.82x the
    // RADIANCE of the sand beside it, and the fluorescence was 23.9% of that.
    // MEASURED in sceneColor at the reef-close camera, dome pixels isolated by
    // an A/B against the same frozen frame with the type blacked out, sand by a
    // second A/B with all scatter blacked out. At 2.4 the emission is 16.0% of
    // the dome and the whole dome renders at 1.240x the sand, with the daylight
    // pump and the night cut-off untouched (green fraction 0.468 by day against
    // the sand's 0.399, and 0.304 at day fraction 0). The rest of the excess was
    // never emission at all - see colorMul.
    // 3.4 preserves the measured fluorescence share after pigment absorption;
    // it is not a brightness lever (see the header's failed emission sweep).
    emissive: 3.4, emissiveColor: [0.18, 1.00, 0.26],
    fluoresces: true, algalFilm: 0.00,
    // ALSO MEASURED AGAINST THE RENDER, NOT THE TABLE. [0.20, 0.20, 0.17] is an
    // albedo luminance of 0.147 against the reef seabed's 0.196 - three quarters
    // - yet with the fluorescence muted the dome still rendered 1.384x the sand's
    // radiance, because a lit convex dome and a flat seabed do not collect the
    // same irradiance. 0.72x of it, an albedo luminance of 0.106, measures 1.042x
    // the sand with the fluorescence muted: the dome now sits ON the sand's own
    // brightness and the fluorescence carries the whole of the difference, which
    // is what makes it read as a coral rather than as a lit stone.
    // 0.168 keeps the pre-split 0.092 material luminance while the family
    // response moves the reflected body toward GFP green. THE GREEN STAYS, AND
    // THAT IS A MEASURED DECISION, NOT AN OMISSION FROM THE P3 COLOUR PASS: a
    // chromoprotein-violet body (response [0.45, 0.09, 1.00], re-levelled to
    // the same 0.092) was tried in that pass and read as pale lilac in the
    // delivered frames - violet is red+blue, the water takes the red, and what
    // is left sits in the veil's own hue band. The reef anchor's matched-pair
    // hue entropy fell 1.691 -> 1.597 bits because the frame lost its only
    // green mode. Green is the axis the water delivers; the dome keeps it.
    colorMul: [0.168, 0.168, 0.168], translucency: 0.35, thickness: 0.0500,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 180, fadeStart: 120, maxLod: 1, maxPerChunk: 320, importance: 6,
    ore: null, collidable: true,
    note: 'Boulder-sized single heads. Deliberately not clustered - brain corals compete. '
      + 'GFP green, and the one coral that shades through mineralSurface: its glow follows '
      + 'the lithology band rather than opposing it, because tissue is not an ore vein.',
  }),
  Object.freeze({
    id: 9, key: 'coralFan', name: 'Gorgonian Fan',
    generator: 'generateCoralFan', meshParams: { thickness: 0.17, height: 1.6 },
    biomes: bm(CORAL_GDN, BREAK, SPIRES, CANYON), density: 4.5, cells: 40, maxPerCell: 2,
    scale: [0.5, 1.8], stretch: [0.8, 1.6], slope: [0.32, 1.7], depth: [8, 260],
    align: 0.3, tilt: 0.3, sink: 0.16,
    colony: { size: 68, coverage: 0.4, edge: 0.5 },
    sways: true, stiffness: 0.55, swayStrength: 0.09, twoSided: true,
    emissive: 8.5, emissiveColor: [1.00, 0.22, 0.34],
    fluoresces: true, algalFilm: 0.00,
    // 0.4358 keeps post-response material luminance at 0.106; the family
    // response supplies a GOLD spectrum (P3 shallow colour pass - the old
    // orange-red was a third red-dominant family that delivered the same
    // washed pink as branching once the water took the red). Gold keeps a
    // green lobe, and green survives the sight path where red does not, so
    // the fan is the coral that stays coloured at range.
    colorMul: [0.4358, 0.4358, 0.4358], translucency: 1.00, thickness: 0.0060,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 180, fadeStart: 120, maxLod: 1, maxPerChunk: 430, importance: 7,
    ore: null, collidable: true,
    note: 'align 0.3 on a 0.32+ slope: a fan grows ACROSS the current, so it stands off the wall. '
      + 'Highest emissive of the four corals because frondSurface gates its glow on uv.y SQUARED, '
      + 'so only the outer third of the fan actually lights up.',
  }),
  Object.freeze({
    id: 10, key: 'coralTube', name: 'Tube Coral',
    generator: 'generateCoralTube', meshParams: { attractors: 130, height: 1.5 },
    biomes: bm(CORAL_GDN, BOULDERS, BREAK), density: 3.6, cells: 40, maxPerCell: 6,
    // NO biomeTint on any of the four coral families - see the table header. But
    // NOTES' Boulder Field palette reads "cool gray-green rock, MUTED coral
    // accents", and a self-lit violet tube is not a muted accent. It is the
    // largest emitter the biome has that is not an ore vein: measured over 111
    // chunks, coralTube carries 14.53% of Boulder Field's emitted flux against
    // oreCopper's 44.36% and oreIron's 41.11%. At a p50 of 93 m in COASTAL_GREEN
    // the biome is still lit by the sun and by the cast shadow Stage 2.2 gives
    // back, so this dims an accent rather than removing the light from a frame
    // that is made of emissive scatter - which is why it is one of the two
    // biomeGlow values that ship before that stage.
    biomeGlow: { [BOULDERS]: 0.55 },
    // DESIGN/01 6.1 authors fl_tuberod at 1.60 m; the old 0.6 m mesh delivered a
    // mean 0.51 m, 3.1x under.
    scale: [0.45, 1.3], stretch: [0.8, 1.5], slope: [0, 1.1], depth: [2, 180],
    align: 0.55, tilt: 0.26, sink: 0.2,
    colony: { size: 40, coverage: 0.5, edge: 0.6 },
    sways: false, stiffness: 1, swayStrength: 0.00, twoSided: false,
    emissive: 6.5, emissiveColor: [0.62, 0.20, 0.56],
    fluoresces: true, algalFilm: 0.00,
    // 0.4325 keeps post-response material luminance at 0.106. The body moved
    // from violet-magenta to TEAL in the P3 shallow colour pass: magenta was
    // the fourth red-leaning family and the tube vanished into the branching
    // corals around it. Teal (g = b, no red to lose) is the one family the
    // water delivers at full saturation, and the magenta polyp fluorescence
    // below now sits on a complementary body instead of a same-hue one.
    colorMul: [0.4325, 0.4325, 0.4325], translucency: 0.70, thickness: 0.0100,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 95, fadeStart: 64, maxLod: 0, maxPerChunk: 950, importance: 4,
    ore: null, collidable: false,
    note: 'Polyp mouths carry a magenta fluorescence - real, and it survives the blue water. '
      + 'MAGENTA, not the violet this used to ask for: the Stokes shift means an emission is '
      + 'always LONGER-wavelength than what excited it, so blue-pumped violet cannot exist. '
      + 'Was 0.4 through the FLORA gate of 0.05, an effective 0.02 that nothing could see.',
  }),
  Object.freeze({
    id: 11, key: 'spongeBarrel', name: 'Barrel Sponge',
    generator: 'generateSponge',
    meshParams: { form: 'barrel', height: 1.2, bore: 0.62, tubes: 4, ribs: 5 },
    biomes: bm(BOULDERS, BREAK, TERRACE, CANYON), density: 1.3, cells: 25, maxPerCell: 1,
    // Takes the ACCENT hue in the three biomes that have one, so the barrel
    // stands off its own ground rather than matching it: a muted coral form on
    // Boulder Field's grey-green slabs, violet against Canyon Wall's iron-red.
    // In Twilight Terraces it is the pale violet the biome is named for, and
    // section 4 promotes it to that biome's backbone. Shelf Break has no accent
    // it should take - a cool sponge would fight the golden strata - so it holds
    // the biome's own gold and reads as part of the bedding.
    biomeTint: {
      [BOULDERS]: HUE.boulderCoral, [BREAK]: HUE.breakGold,
      [TERRACE]: HUE.terraceViolet, [CANYON]: HUE.canyonViolet,
    },
    scale: [0.5, 1.6], stretch: [0.8, 1.4], slope: [0, 0.78], depth: [22, 420],
    align: 0.75, tilt: 0.16, sink: 0.2,
    colony: null,
    sways: false, stiffness: 1, swayStrength: 0.00, twoSided: false,
    emissive: 0, emissiveColor: [0, 0, 0],
    fluoresces: false, algalFilm: 0.00,
    // 1.45x rather than the corals' 1.75x, and THE REASON FOR THE HEDGE IS GONE.
    // It was written when a sponge at 200-1100 m sat in a frame that was already
    // over-bright for an unrelated reason - the sky ambient SH had no depth term,
    // so the seabed was lit by the surface sky at any depth - and the shipped
    // close-up at 291 m clipped to white. `238fab9` gave evalAmbient its depth
    // term (common/lighting.wgsl multiplies both lobes by daylightAtDepth of the
    // POINT's depth), so the lighting model this was hedging against no longer
    // exists and the deep is now dark. THIS VALUE WAS NOT RE-DERIVED AFTERWARDS.
    // Whether it should go back to the 1.75x the docstring above quotes for both
    // sponge rows is open, and it is a question for a photographed close-up at
    // 291 m, not for arithmetic - the warm coral rows show the 1.75x can be wrong
    // on its own terms.
    colorMul: [0.49, 0.46, 0.45], translucency: 0.45, thickness: 0.0300,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 175, fadeStart: 118, maxLod: 1, maxPerChunk: 230, importance: 6,
    ore: null, collidable: true,
    note: 'Xestospongia habit. Two metres across at max scale, so it is cover as well as decor.',
  }),
  Object.freeze({
    id: 12, key: 'spongeGlass', name: 'Glass Sponge',
    generator: 'generateSponge',
    meshParams: { form: 'tube', height: 1.5, bore: 0.66, tubes: 5, ribs: 4 },
    // 2.2 per 100 m^2 of a 1.5 m capsule made this ONE generator 27-34% of the
    // silhouette area at five of the fourteen anchors. It is a vase cluster now
    // and it does not have to carry the whole deep on its own.
    biomes: bm(BREAK, TRENCH_WALL, ABYSSAL, CANYON), density: 1.4, cells: 32, maxPerCell: 2,
    // Violet on the two walls, ghost-white on the plain, clean blue at the shelf
    // break where the palette is "golden-brown beds fading into clean blue" and
    // this is the thing furthest down the slope.
    biomeTint: {
      [BREAK]: HUE.breakBlue, [CANYON]: HUE.canyonViolet,
      [ABYSSAL]: HUE.abyssGhost, [TRENCH_WALL]: HUE.trenchSeam,
    },
    // Section 4 makes Trench Wall THE glass-sponge biome, and NOTES' Shelf Break
    // Avoid column reads "mushrooms, pod gardens, trench crystals" - a deep
    // luminous form is off-identity there, where the read is meant to be urn
    // sponges and bedded strata under the last daylight (p50 210 m). Measured
    // over 111 chunks this carries 14.71% of Shelf Break's emitted flux, so 0.60
    // removes 5.9% of it from a biome that still has a sun; its glow in the three
    // lightless biomes below is untouched, because there it IS the light.
    biomeGlow: { [BREAK]: 0.60 },
    scale: [0.5, 1.7], stretch: [1.0, 1.6], slope: [0.08, 1.5], depth: [180, 1600],
    align: 0.45, tilt: 0.28, sink: 0.16,
    colony: { size: 82, coverage: 0.44, edge: 0.5 },
    sways: false, stiffness: 1, swayStrength: 0.00, twoSided: false,
    emissive: 0.75, emissiveColor: [0.44, 0.70, 0.86],
    fluoresces: false, algalFilm: 0.00,
    colorMul: [0.44, 0.49, 0.58], translucency: 1.00, thickness: 0.0200,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 160, fadeStart: 106, maxLod: 1, maxPerChunk: 380, importance: 7,
    ore: null, collidable: false,
    note: 'Hexactinellid silica: translucent AND faintly luminous, which is what sells the abyss.',
  }),
  Object.freeze({
    id: 13, key: 'rockSmall', name: 'Cobble',
    generator: 'generateRock', meshParams: { size: 1.0, irregularity: 0.42 },
    // BULB added 2026-08-18 with biome 16 (same reasoning as seagrass's bit:
    // additive only, and the reference scatters a few dark cobbles on the sand).
    // PLATTER added 2026-08-18 with biome 17: the reference floor carries real
    // rubble between the tuft patches, and the record authors rockiness 0.30.
    biomes: bm(BASALT, REEF, BOULDERS, SPIRES, CANYON, BREAK, BULB, PLATTER), density: 7.0, cells: 50, maxPerCell: 8,
    // The MINERAL hue of every biome it lies in. This is the highest-count row
    // in the table and it is the same grey cobble in six places; a cobble is
    // also the one prop a diver is always within a few metres of, which is where
    // reflectance still beats the haze.
    biomeTint: {
      [BASALT]: HUE.basaltOxide, [REEF]: HUE.reefCarbonate, [BOULDERS]: HUE.boulderGreen,
      [BREAK]: HUE.breakGold, [SPIRES]: HUE.spireBlue, [CANYON]: HUE.canyonIron,
    },
    // NO biomeDensity. A 0.35 weight in Boulder Field shipped here (delivered
    // ratio 0.3528) and was removed with the other two, for the sequencing reason
    // in the table header: it deletes the "small rocks" half of the Avoid column's
    // "small rocks on a normal slope" and the house-sized slabs that replace them
    // are Stage 3.
    //
    // BUT THE 0.172 -> 0.105 BIT DROP AT THIS ANCHOR IS NOT THIS WEIGHT, AND THE
    // MISATTRIBUTION IS WORTH KEEPING. A matched A/B - same tree, same 2-anchor
    // --only set, control self-cosine 0.9979 - restored 1,731 instances to the
    // frame and moved delivered hue entropy 0.0841 -> 0.0831 bits, against a
    // repeat-to-repeat spread of 0.0011 on the identical build. That is nothing.
    // Opening the PNGs says where the bits went: the baseline frame carries THREE
    // glassclaws with cyan-green legs and neither arm carries any, and they are
    // the only non-blue hue in a frame that is otherwise blue haze over pale
    // rock. CLAUDE.md already warns that a whole-frame difference between two
    // tour runs is dominated by FAUNA; this is that warning arriving as a wrong
    // diagnosis of a real problem. Sand Plains' seagrass IS causal and measured
    // (0.0912 -> 0.1282 in the same pair). Boulder Field's colour problem is that
    // it has none of its own to lose.
    scale: [0.12, 0.42], stretch: [0.6, 1.0], slope: [0, 1.50], depth: [-220, 900],
    align: 0.9, tilt: 0.6, sink: 0.08,
    colony: null,
    sways: false, stiffness: 1, swayStrength: 0.00, twoSided: false,
    emissive: 0, emissiveColor: [0, 0, 0],
    fluoresces: false, algalFilm: 1.00,
    colorMul: [1.00, 1.00, 1.00], translucency: 0.00, thickness: 0.0500,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 82, fadeStart: 54, maxLod: 0, maxPerChunk: 1300, importance: 2,
    ore: null, collidable: false,
    note: 'The single highest-count type. Breaks the terrain shader up at boot-print distance.',
  }),
  Object.freeze({
    id: 14, key: 'rockMedium', name: 'Rock',
    generator: 'generateRock', meshParams: { size: 1.0, irregularity: 0.5 },
    biomes: bm(BASALT, BOULDERS, SPIRES, CANYON, BREAK, TRENCH_WALL), density: 2.4, cells: 32, maxPerCell: 2,
    // THE WORKED EXAMPLE for this mechanism: one waist-high rock that reads
    // oxidised orange on the volcano, cool grey-green in the boulder field,
    // golden-brown in the bedded strata, cold blue among the spires, IRON-RED in
    // Canyon Wall and BLACK-VIOLET on the trench wall - and none of it moved a
    // single instance or changed the frame's energy, because the hues are
    // normalised to unit Rec709 luma and the tint is written after the accept.
    biomeTint: {
      [BASALT]: HUE.basaltOxide, [BOULDERS]: HUE.boulderGreen, [BREAK]: HUE.breakGold,
      [SPIRES]: HUE.spireBlue, [CANYON]: HUE.canyonIron, [TRENCH_WALL]: HUE.trenchBlack,
    },
    scale: [0.35, 1.10], stretch: [0.65, 1.15], slope: [0, 1.35], depth: [-220, 1400],
    align: 0.85, tilt: 0.45, sink: 0.10,
    colony: null,
    sways: false, stiffness: 1, swayStrength: 0.00, twoSided: false,
    emissive: 0, emissiveColor: [0, 0, 0],
    fluoresces: false, algalFilm: 1.00,
    colorMul: [1.00, 1.00, 1.00], translucency: 0.00, thickness: 0.0500,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 210, fadeStart: 142, maxLod: 1, maxPerChunk: 460, importance: 5,
    ore: null, collidable: true,
    note: 'Waist-high: the size that reads as scale reference against the player capsule.',
  }),
  Object.freeze({
    id: 15, key: 'boulder', name: 'Boulder',
    generator: 'generateBoulder', meshParams: { size: 1.0, irregularity: 0.58 },
    biomes: bm(BOULDERS, SPIRES, CANYON, BASALT), density: 0.34, cells: 10, maxPerCell: 1,
    // The mineral hue again, and it matters most here: this is the only type
    // that survives to LOD 3, so a 10 m erratic is the biome's colour at the
    // distance where nothing else of the biome is drawn at all.
    biomeTint: {
      [BASALT]: HUE.basaltOxide, [BOULDERS]: HUE.boulderGreen,
      [SPIRES]: HUE.spireBlue, [CANYON]: HUE.canyonIron,
    },
    scale: [1.20, 3.60], stretch: [0.6, 1.05], slope: [0, 0.95], depth: [-220, 1500],
    align: 0.75, tilt: 0.3, sink: 0.14,
    colony: null,
    sways: false, stiffness: 1, swayStrength: 0.00, twoSided: false,
    emissive: 0, emissiveColor: [0, 0, 0],
    fluoresces: false, algalFilm: 1.00,
    colorMul: [3.00, 3.00, 3.00], translucency: 0.00, thickness: 0.0500,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 320, fadeStart: 230, maxLod: 3, maxPerChunk: 120, importance: 9,
    ore: null, collidable: true,
    note: 'The only type that survives to LOD 3. A 10 m erratic is a navigational landmark.',
  }),
  Object.freeze({
    id: 16, key: 'rubblePlate', name: 'Rubble Plate',
    generator: 'generateRock', meshParams: { size: 1.0, irregularity: 0.66 },
    biomes: bm(BREAK, SPIRES, CANYON, TRENCH_WALL, BOULDERS), density: 3.6, cells: 40, maxPerCell: 3,
    // Talus is spalled off the wall behind it, so it takes the wall's own
    // mineral hue in all five biomes and nothing else.
    biomeTint: {
      [BOULDERS]: HUE.boulderGreen, [BREAK]: HUE.breakGold, [SPIRES]: HUE.spireBlue,
      [CANYON]: HUE.canyonIron, [TRENCH_WALL]: HUE.trenchBlack,
    },
    scale: [0.30, 1.10], stretch: [0.2, 0.42], slope: [0.18, 1.7], depth: [30, 1600],
    align: 0.95, tilt: 0.5, sink: 0.05,
    colony: { size: 60, coverage: 0.46, edge: 0.6 },
    sways: false, stiffness: 1, swayStrength: 0.00, twoSided: false,
    emissive: 0, emissiveColor: [0, 0, 0],
    fluoresces: false, algalFilm: 1.00,
    colorMul: [0.94, 0.96, 0.98], translucency: 0.00, thickness: 0.0500,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 140, fadeStart: 94, maxLod: 1, maxPerChunk: 820, importance: 3,
    ore: null, collidable: false,
    note: 'Talus scree: stretch caps at 0.42 so these lie flat instead of standing on end.',
  }),
  Object.freeze({
    id: 17, key: 'pebbleField', name: 'Deep Gravel',
    generator: 'generatePebble', meshParams: { size: 1.0, irregularity: 0.85 },
    biomes: bm(SAND, TERRACE, ABYSSAL, TRENCH_FLOOR), density: 7, cells: 50, maxPerCell: 8,
    // The floor's mineral hue on the three floors this reaches: pale gold on
    // Sand Plains, indigo in the Terraces, pale warm sediment on the Abyssal
    // Plain. Trench Floor is in the mask and is deliberately untinted - see the
    // HUE table for why nothing is authored into a biome that holds 0.063% of
    // the seabed and whose depth band the world cannot reach.
    biomeTint: {
      [SAND]: HUE.sandGold, [TERRACE]: HUE.terraceIndigo, [ABYSSAL]: HUE.abyssSediment,
    },
    // NO biomeDensity. A 0.30 weight in Twilight Terraces shipped here and was
    // removed with the other two (delivered ratio 0.3016). It was the least
    // harmful of the three - deep gravel at the terraces' 287 m median depth
    // contributes little but instance count - but it is the same subtraction
    // without a replacement, and the stacked-plate read that is meant to take its
    // place is Stage 3. See the biomeDensity entry in the table header.
    scale: [0.04, 0.13], stretch: [0.45, 0.85], slope: [0, 0.42], depth: [60, 1600],
    align: 0.95, tilt: 0.7, sink: 0.06,
    colony: { size: 34, coverage: 0.5, edge: 0.65 },
    sways: false, stiffness: 1, swayStrength: 0.00, twoSided: false,
    emissive: 0, emissiveColor: [0, 0, 0],
    fluoresces: false, algalFilm: 1.00,
    colorMul: [0.30, 0.29, 0.27], translucency: 0.00, thickness: 0.0500,
    maxDetail: MESH_DETAIL.MEDIUM,
    viewDistance: 60, fadeStart: 39, maxLod: 0, maxPerChunk: 1000, importance: 1,
    ore: null, collidable: false,
    note: 'Manganese nodule fields. Patchy on purpose - the abyssal plain is not uniformly paved.',
  }),
  Object.freeze({
    id: 18, key: 'crystalShard', name: 'Crystal Shard',
    generator: 'generateCrystal', meshParams: { prisms: 5, sides: 6, height: 0.9 },
    // BREAK added: the shelf break was the one deep-ish biome with no bright
    // emitter off the water's hue at all. Its roster is coralFan and coralTube,
    // both FLUORESCENT and therefore dark below ~40 m, plus spongeGlass 0.75 and
    // oreTitanium 0.22 - and both of those are inside the water's own blue.
    biomes: bm(SPIRES, CANYON, TRENCH_WALL, TRENCH_FLOOR, BREAK), density: 2.8, cells: 40, maxPerCell: 3,
    // The ACCENT hue, against the mineral hue the rock beside it now carries:
    // violet crowns on Rock Spires' cold blue needles, a violet seam on the
    // trench wall's black-blue, violet against Canyon Wall's iron-red. Its
    // EMISSION is amethyst in all of them and is untouched - this is the
    // reflectance the lamp finds, which is where hue survives.
    biomeTint: {
      [SPIRES]: HUE.spireViolet, [CANYON]: HUE.canyonViolet,
      [TRENCH_WALL]: HUE.trenchSeam, [BREAK]: HUE.breakBlue,
    },
    scale: [0.4, 1.7], stretch: [0.8, 1.7], slope: [0, 1.6], depth: [40, 1600],
    align: 0.3, tilt: 0.4, sink: 0.22,
    colony: { size: 44, coverage: 0.4, edge: 0.55 },
    sways: false, stiffness: 1, swayStrength: 0.00, twoSided: false,
    // AMETHYST, NOT BLUE. See crystalSpire's note - the two share a lattice and
    // must share a hue, and the old [0.30, 0.62, 1.00] delivered 226 degrees at
    // 20 m of ABYSSAL_VOID against a water hue of 218-230.
    emissive: 3.4, emissiveColor: [1.00, 0.22, 0.70],
    fluoresces: false, algalFilm: 1.00,
    colorMul: [0.40, 0.42, 0.46], translucency: 0.90, thickness: 0.0600,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 200, fadeStart: 134, maxLod: 1, maxPerChunk: 540, importance: 8,
    ore: null, collidable: false,
    note: 'align 0.3: crystals grow along their own lattice, not along the ground.',
  }),
  Object.freeze({
    id: 19, key: 'crystalSpire', name: 'Crystal Spire',
    generator: 'generateCrystal', meshParams: { height: 1.6, prisms: 8, sides: 7 },
    biomes: bm(CANYON, TRENCH_WALL, TRENCH_FLOOR, SPIRES), density: 0.42, cells: 16, maxPerCell: 1,
    // Shares crystalShard's accent hue for the same reason it shares its
    // emission spectrum: the two are the same lattice at two sizes, and a
    // reviewer who sees them disagree reads it as two minerals.
    biomeTint: {
      [SPIRES]: HUE.spireViolet, [CANYON]: HUE.canyonViolet, [TRENCH_WALL]: HUE.trenchSeam,
    },
    scale: [0.7, 2.2], stretch: [1.1, 2.2], slope: [0, 1.35], depth: [200, 1600],
    align: 0.2, tilt: 0.34, sink: 0.26,
    colony: { size: 130, coverage: 0.36, edge: 0.42 },
    sways: false, stiffness: 1, swayStrength: 0.00, twoSided: false,
    // AMETHYST. THIS ROW WAS THE WORST OFFENDER IN THE TABLE: at 4.8 cd/m2 it is
    // the brightest thing in the trench, and [0.26, 0.54, 1.00] pushed through
    // 20 m of ABYSSAL_VOID delivers hue 228 - which is INSIDE the 218-230 the
    // water itself delivers at the deep anchors. The brightest object in the
    // biome was the same colour as the background it was meant to stand out
    // from. A crystal has no committed spectrum, so this is a free choice and it
    // is spent on the far side of the wheel: [1.00, 0.16, 0.62] delivers 287 deg
    // at 20 m and 258 deg at 40 m, i.e. 36-65 deg off the water over the range
    // the shard is actually read at. Violet is also already the design
    // vocabulary here - DESIGN/01 puts `ore_violet_geode` in the same biome.
    emissive: 4.8, emissiveColor: [1.00, 0.16, 0.62],
    fluoresces: false, algalFilm: 1.00,
    colorMul: [0.38, 0.40, 0.46], translucency: 1.00, thickness: 0.0800,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 300, fadeStart: 210, maxLod: 2, maxPerChunk: 140, importance: 10,
    ore: null, collidable: true,
    note: 'The brightest thing in the trench. At 4.8 cd/m2 it is visible before its geometry is.',
  }),
  Object.freeze({
    id: 20, key: 'mushroomCap', name: 'Glowcup',
    generator: 'generateMushroom',
    meshParams: { height: 0.55, capRadius: 0.42, gills: 22, gillColor: MESH_PALETTE.GLOWCUP },
    // CANYON added. It was the one deep biome whose entire bright roster sat
    // inside the water's own hue - glowPod 6.0 at 194 deg, crystalShard 3.4 and
    // crystalSpire 4.8 at 213-217, against a delivered water hue of 218-230 - and
    // its warm rows (ventChimney, ventSulphur, tubeworm) all start at 400-420 m,
    // which is the FLOOR of a biome that begins at 320. DESIGN/01 6.1 puts
    // glowcups on the floor beneath the lampcaps and the canyon is the same depth
    // band as the terrace they already carpet, so this is the roster the biome
    // should always have had rather than a new species invented for a frame.
    // DENSITY 9 RATHER THAN 4, AND THE SPEC IS ON THE RAISE'S SIDE: DESIGN/01's
    // per-biome flora density table authors `fl_glowcup` at 16.0 per 100 m^2 in
    // `sea_lampcap_forest`, so 4 was 4x UNDER its own document. It matters
    // because warm coverage is an AREA problem - a 0.55 m cup is a few pixels at
    // 20 m, and one warm speck reads as a speck however bright it is. Brightness
    // is NOT the lever down here: every deep emitter's core clips at the 25.6
    // exposure ceiling whatever it is authored at, so the hue lives in the
    // unclipped skirt and the only way to get more of it is more skirt.
    biomes: bm(TERRACE, ABYSSAL, TRENCH_FLOOR, TRENCH_WALL, CANYON), density: 9, cells: 40, maxPerCell: 6,
    // STAGE 3.1, FIRST AUTHORED WEIGHTS - and they satisfy the three conditions
    // in the table header. (1) THE REPLACEMENT SHIPS IN THIS CHANGE: abyssRib
    // 0.18 -> 0.30 and terraceShelf 1.15 -> 1.50, each biome's own exclusive
    // form, per the no-subtraction-before-its-replacement rule. (2)+(3) the
    // hue-entropy gate WAS RUN AND PASSED, 2026-08-07, as a matched
    // biomeDensityStrength 0-vs-1 pair, --only terrace,abyssal, one tree
    // (variety-output/p31-inert.json = strength 0, p31-weights.json =
    // strength 1; the arm is in the NAME because the report JSON does not
    // record the knob): terrace 1.3051 -> 1.3033 bits (flat), abyssal
    // 1.7316 -> 1.6968 (-0.035, inside that anchor's 0.045 control spread),
    // and the PNG pair was READ - the weighted abyssal frame loses the
    // forbidden glowcup-table crowd and keeps all three light families. SCOPE IS DELIBERATELY THE TWO BIOMES THE KIT
    // DOMINATES: measured on census p31-control (anchor sample, this tree),
    // the glow kit is 97.8% of Abyssal Plain's emitted flux (cap 58.4,
    // cluster 27.8, pods 11.5) against an Avoid column reading "mushroom
    // forest, dense glow pods", and 63.7% of Twilight Terraces'. Canyon
    // (29.9% vs banner 27.4%) and Trench Wall (24.6% vs spine 40.5%) already
    // hold their kit below their signatures and take no weight; Shelf Break's
    // crystalShard violation (C2) needs its own measured pass and is NOT
    // addressed by a token weight here. THE CUTS ARE DIFFERENTIATED so the
    // residual kit MIXES diverge instead of every biome dimming alike: the
    // plain keeps its pods at 1.0 (cap+cluster cut), the terraces keep the
    // 5.5 m clusters at 1.0 (cap+pods cut). Gate A is graded on DELIVERED
    // in-frustum irradiance at the arrival pose (scatterPass.lightReport),
    // per the re-derivation recorded in STATUS - raw emitted flux says -42%
    // at the plain while cap's delivered share is 0.412, so the two differ
    // by the exact margin the binding irradiance rule predicts.
    biomeDensity: { [ABYSSAL]: 0.50, [TERRACE]: 0.55 },
    // THIS ROW IS THE DEEP'S SHARED VOCABULARY AND IT IS 56-74% OF THE EMITTED
    // FLUX IN FOUR BIOMES [measured, 111 chunks], so it is the single type most
    // responsible for four different places looking like one. Its stem and cap
    // take the host biome's accent - violet in the Terraces and the Canyon,
    // ghost-white on the Abyssal Plain, violet-seam on the trench wall - while
    // the amber gills that carry the flux are untouched. This is a REFLECTANCE
    // change and nothing else: no biomeGlow is authored on any of the five,
    // because below 140 m the frame IS the emissive scatter and a cut here is a
    // subtraction of the only light in the image.
    biomeTint: {
      [TERRACE]: HUE.terraceViolet, [CANYON]: HUE.canyonViolet,
      [ABYSSAL]: HUE.abyssGhost, [TRENCH_WALL]: HUE.trenchSeam,
    },
    scale: [0.4, 1.9], stretch: [0.7, 1.6], slope: [0, 0.84], depth: [140, 1600],
    align: 0.8, tilt: 0.2, sink: 0.14,
    colony: { size: 30, coverage: 0.42, edge: 0.62 },
    sways: false, stiffness: 0.8, swayStrength: 0.00, twoSided: false,
    // AMBER, and that is the point. DESIGN/01 6.1 authors fl_glowcup at
    // sRGB(255,150,60) @ 3.1 cd/m^2 and DESIGN/01 7.8 puts it on the floor
    // BENEATH the cyan-green lampcaps as the understory. Both fungi used to emit
    // the same green, which is one colour doing the work of two.
    //
    // 7.0 RATHER THAN THE SPEC'S 3.1, BECAUSE THIS IS THE ONE TYPE THE DEEP'S
    // WARMTH CAN ACTUALLY RIDE ON. A warm emitter only survives the water over a
    // short path - ABYSSAL_VOID's red 1/e beam range is 14.4 m and the trench's
    // is shorter - so warmth has to go on something DENSE and CLOSE rather than
    // on a landmark 40 m away, and of everything in the deep this is the densest
    // and the nearest: density 9 per 100 m^2 at maxPerCell 6 in 30 m colonies,
    // drawn to 130 m. At 3.1 it was a pale peach speck; at 7.0 the understory is
    // a warm floor under the lampcaps, which is what DESIGN/01 7.8 describes and
    // is the only warm mass anywhere below 200 m. Landmark rows stay where they
    // are - raising ventChimney's 340 m draw would just deliver blue.
    emissive: 7.0, emissiveColor: [1.00, 0.305, 0.045],
    fluoresces: false, algalFilm: 0.00,
    colorMul: [0.46, 0.42, 0.36], translucency: 1.00, thickness: 0.0200,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 130, fadeStart: 86, maxLod: 0, maxPerChunk: 820, importance: 5,
    ore: null, collidable: false,
    note: 'DESIGN/01 6.1 fl_glowcup: H 0.55, R 0.45. Colonies 30 m across, because '
      + 'fungus fruits in rings and never evenly. The amber floor under the lampcaps.',
  }),
  Object.freeze({
    id: 21, key: 'mushroomCluster', name: 'Lampcap',
    // THE ONE ROW WITH A NAMED SPEC IT MISSED BY AN ORDER OF MAGNITUDE.
    // DESIGN/01 6.1 authors fl_lampcap at H 5.80 m, R 3.90 m @ 6.8 cd/m^2, and
    // DESIGN/01 7.8 describes "caps 6-8 m across on thick pale stalks". This row
    // asked generateMushroom - whose OWN defaults are height 5.8, capRadius 1.95 -
    // for 1.2 m and 0.52 m, delivering a MEASURED mean height of 2.18 m and a mean
    // cap radius of 0.53 m: 2.7x under in height and 7.4x under in radius. What
    // reached the screen was a field of lollipops.
    // capRadius 3.4 x the generator's own mean flare of 1.1 lands the mean cap
    // radius on 3.74 m against the spec's 3.90.
    generator: 'generateMushroom', meshParams: { height: 5.8, capRadius: 3.4, gills: 30 },
    biomes: bm(ABYSSAL, TRENCH_FLOOR, TERRACE), density: 0.32, cells: 10, maxPerCell: 1,
    // Stage 3.1: thinned on the PLAIN only (the kit is 97.8% of its flux and
    // its Avoid column forbids exactly this forest). The terraces keep their
    // clusters at 1.0 on purpose - the 5.5 m lampcap is the voice of the kit
    // the TERRACE retains, so the two biomes' residual mixes diverge. Ships
    // with the abyssRib raise; full reasoning at mushroomCap's weights.
    biomeDensity: { [ABYSSAL]: 0.80 },
    // The 6 m stalk and cap take the host's accent; the green gills that make it
    // a landmark do not move.
    biomeTint: { [TERRACE]: HUE.terraceViolet, [ABYSSAL]: HUE.abyssGhost },
    scale: [0.55, 1.30], stretch: [0.85, 1.20], slope: [0, 0.68], depth: [200, 1600],
    align: 0.8, tilt: 0.16, sink: 0.16,
    colony: { size: 88, coverage: 0.42, edge: 0.5 },
    sways: false, stiffness: 0.8, swayStrength: 0.00, twoSided: false,
    // GREEN, NOT CYAN-GREEN. DESIGN/01 6.1 authors sRGB(90, 255, 190), which is
    // [0.102, 1.00, 0.515] linear - and a cap this bright CLIPS, so what decides
    // the hue the player sees is not the core but the water-attenuated tail. Over
    // 20 m of ABYSSAL_VOID that authored triple delivers hue 176, i.e. cyan, and
    // the trench-floor frame was a field of cyan caps over cyan pods on blue
    // water. [0.34, 1.00, 0.12] delivers 118 deg over the same path: still a
    // green cap, and now 100 deg off the water instead of 45.
    emissive: 6.8, emissiveColor: [0.34, 1.00, 0.12],
    fluoresces: false, algalFilm: 0.00,
    colorMul: [0.44, 0.45, 0.40], translucency: 1.00, thickness: 0.0250,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 300, fadeStart: 210, maxLod: 2, maxPerChunk: 70, importance: 10,
    ore: null, collidable: true,
    note: 'A 6 m glowing tree is a landmark, so it gets a landmark view distance and '
      + 'a landmark density: 0.32 per 100 m^2 against a 44 m^2 canopy footprint.',
  }),
  Object.freeze({
    id: 22, key: 'glowPod', name: 'Glow Pod',
    generator: 'generateGlowPod', meshParams: { pods: 5, height: 1.1 },
    biomes: bm(TERRACE, ABYSSAL, TRENCH_WALL, TRENCH_FLOOR, CANYON), density: 2.8, cells: 40, maxPerCell: 3,
    // Stage 3.1: thinned on the TERRACES only. The plain keeps its pods at
    // 1.0 - they are the voice of the kit the ABYSSAL retains (cap+cluster
    // take that biome's cut instead). Ships with the terraceShelf raise;
    // full reasoning at mushroomCap's weights.
    biomeDensity: { [TERRACE]: 0.85 },
    // Second-largest share of the deep's emitted flux after mushroomCap
    // (21.9-23.6% in the Terraces, the Canyon and the Plain), and the second
    // reason four biomes look alike. Same treatment: the host's accent on the
    // pod wall, the cyan emission untouched, no biomeGlow anywhere.
    biomeTint: {
      [TERRACE]: HUE.terraceViolet, [CANYON]: HUE.canyonViolet,
      [ABYSSAL]: HUE.abyssGhost, [TRENCH_WALL]: HUE.trenchSeam,
    },
    scale: [0.5, 1.6], stretch: [0.9, 1.5], slope: [0, 0.92], depth: [110, 1600],
    align: 0.85, tilt: 0.15, sink: 0.1,
    colony: { size: 52, coverage: 0.42, edge: 0.55 },
    sways: true, stiffness: 0.22, swayStrength: 0.16, twoSided: false,
    emissive: 6.0, emissiveColor: [0.16, 0.74, 0.92],
    fluoresces: false, algalFilm: 0.00,
    colorMul: [1.00, 1.00, 1.00], translucency: 1.00, thickness: 0.0300,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 210, fadeStart: 140, maxLod: 2, maxPerChunk: 470, importance: 9,
    ore: null, collidable: false,
    note: 'Highest emissive in the table. Swaying bioluminescence is the deep signature look.',
  }),
  Object.freeze({
    id: 23, key: 'ventChimney', name: 'Vent Chimney',
    generator: 'generateVentChimney', meshParams: { height: 1.2, stacks: 5 },
    // 0.2 per 100 m^2 through a colony gate whose MEASURED E[m] was 0.0302 is a
    // realised 0.006, and over the whole 4.92 km^2 sampled that was FOURTEEN
    // chimneys - one per 590 m of seabed, for the landmark of the trench.
    biomes: bm(TRENCH_WALL, TRENCH_FLOOR, CANYON), density: 0.9, cells: 10, maxPerCell: 1,
    // Black-blue sulphide on the trench wall. CANYON is in the mask and is not
    // tinted: censused over 111 chunks it places ONE instance there, because its
    // 420 m floor sits below most of the biome, so a value would be authoring
    // colour for a prop nobody will meet.
    biomeTint: { [TRENCH_WALL]: HUE.trenchBlack },
    scale: [1.2, 5.0], stretch: [1.0, 2.6], slope: [0, 0.6], depth: [420, 1600],
    align: 0.7, tilt: 0.14, sink: 0.3,
    colony: { size: 100, coverage: 0.28, edge: 0.35 },
    sways: false, stiffness: 1, swayStrength: 0.00, twoSided: false,
    // 4.2: real black-smoker throat glow IS incandescent - 350 C fluid radiates,
    // and "vent glow" is a measured phenomenon rather than an invention - but it
    // is far dimmer than this. The raise is for the same reason the number is
    // allowed to exist at all: a chimney is the trench's landmark and the only
    // other warm mass down there is 0.55 m tall. (Until 2026-08-18 it sat
    // under the understory's 7.0 so the field read as a warm floor with a
    // stack in it; the drastic pass inverted that on purpose - the stack IS
    // the landmark the Emberthroat segment is named for.)
    // 2026-08-18 drastic pass: 4.2 -> 14, colour pushed to ember. At 4.2 the
    // Emberthroat demo segment photographed a blue lamp haze with no ember in
    // it; at 690 m there is no daylight to whiten the glow, so the throat can
    // run hot and still read saturated - the place's name is the shot.
    emissive: 14.0, emissiveColor: [1.00, 0.30, 0.04],
    fluoresces: false, algalFilm: 1.00,
    colorMul: [1.00, 1.00, 1.00], translucency: 0.00, thickness: 0.0500,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 340, fadeStart: 240, maxLod: 3, maxPerChunk: 70, importance: 10,
    ore: null, collidable: true,
    note: 'Sulphide black smoker: a dull orange throat glow, sparse and always in fields.',
  }),
  Object.freeze({
    id: 24, key: 'tubeworm', name: 'Vent Tubeworm',
    generator: 'generateCoralTube', meshParams: { attractors: 140, height: 1.6 },
    biomes: bm(TRENCH_WALL, TRENCH_FLOOR, CANYON), density: 4.2, cells: 50, maxPerCell: 3,
    // NOTES' binding Avoid for Trench Wall is "bright garden flora or WARM VENT
    // CARPET", and 2,880 offered instances over 111 chunks is a carpet. The
    // answer here is a violet-seam TUBE rather than a dimmer one: its emission
    // stays at 2.6 - the wall's warm light is not removed, which the hard
    // sequencing rule forbids before Stage 2 - while the haemoglobin-red
    // reflectance that makes it read as a vent garden goes cold. In Canyon Wall,
    // where warmth is the identity, it keeps the iron of the rock behind it.
    biomeTint: { [CANYON]: HUE.canyonIron, [TRENCH_WALL]: HUE.trenchSeam },
    scale: [0.5, 1.4], stretch: [1.0, 1.8], slope: [0, 1.05], depth: [400, 1600],
    align: 0.65, tilt: 0.26, sink: 0.16,
    colony: { size: 42, coverage: 0.40, edge: 0.5 },
    sways: true, stiffness: 0.45, swayStrength: 0.06, twoSided: false,
    // 2.6, AND THE 0.2 IT REPLACES WAS SELF-DEFEATING. A haemoglobin-red albedo
    // at 400-1600 m is lit by nothing: there is no daylight left, and red is the
    // first channel the water takes. So the one type in the game whose whole
    // identity is RED rendered black, and its 0.2 cd/m^2 through FLORA's own
    // uv.y mask was an effective 0.1 that no frame ever showed. Deep-sea
    // polychaetes do bioluminesce (Tomopteris burns yellow; the luminous scale
    // worms are the classic case), so a lit vent worm is inside the real world's
    // vocabulary as well as this game's. It is DENSE and CLOSE - 4.2 per 100 m^2,
    // 42 m colonies, drawn to 105 m - which is exactly where a warm emitter has
    // to sit to survive the 14.4 m red beam range.
    // 2026-08-18 drastic pass: 2.6 -> 7.0. Riftia plumes are the vent field's
    // warm counterpoint; at 2.6 they read black at the Emberthroat arrival
    // and the field's only visible glows were the cool crystal accents.
    emissive: 7.0, emissiveColor: [0.92, 0.24, 0.20],
    fluoresces: false, algalFilm: 0.00,
    colorMul: [0.90, 0.34, 0.34], translucency: 1.00, thickness: 0.0080,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 105, fadeStart: 70, maxLod: 0, maxPerChunk: 700, importance: 5,
    ore: null, collidable: false,
    note: 'Riftia: red plumes because they are full of haemoglobin. Clusters hug the vents.',
  }),
  Object.freeze({
    id: 25, key: 'boneRib', name: 'Bone Rib',
    generator: 'generateBoneRib', meshParams: { height: 1.5, taper: 0.30 },
    // MEASURED E[m] 0.0073 - 106x less than an ungated row - realised as TWENTY-ONE
    // ribs in the whole 4.92 km^2 census and ZERO within 96 m of any of the 14
    // biome anchors. A type that appears nowhere is not rare, it is unbuilt.
    // The colony stays tight (coverage 0.20 on a 44 m patch) and the DENSITY
    // carries the fix, because a whale fall is many ribs in ONE place.
    // OSSUARY joined the mask 2026-08-07 (P4-C): DESIGN/01 #18's bone field is
    // MADE of this vocabulary, and the mid-frequency scattered rib is the one
    // scale the biome's own exclusive rows (the 34 m colossus, the place
    // skull) do not carry. Shared-row rule: the density is untouched, so the
    // four existing carriers deliver byte-identical populations; the census
    // A/B for this change moves only the new biome's column.
    biomes: bm(SAND, ABYSSAL, TRENCH_FLOOR, TERRACE, OSSUARY), density: 1.6, cells: 16, maxPerCell: 1,
    // Section 4's read for the Abyssal Plain is "ONE large pale structure in an
    // otherwise empty frame", and at up to 6 m this is the largest thing the
    // plain has. It takes the plain's warm sediment hue rather than its cold
    // accent, so the bone is the warm object and the glowing forms around it are
    // the cold ones - which is the two-family split the HUE table exists for.
    biomeTint: {
      [SAND]: HUE.sandGold, [TERRACE]: HUE.terraceIndigo, [ABYSSAL]: HUE.abyssSediment,
      [OSSUARY]: HUE.ossuaryIvory,
    },
    scale: [1.0, 4.0], stretch: [0.8, 1.6], slope: [0, 0.72], depth: [40, 1600],
    align: 0.7, tilt: 0.26, sink: 0.3,
    colony: { size: 44, coverage: 0.20, edge: 0.34 },
    sways: false, stiffness: 1, swayStrength: 0.00, twoSided: false,
    emissive: 0, emissiveColor: [0, 0, 0],
    fluoresces: false, algalFilm: 1.00,
    colorMul: [0.42, 0.41, 0.38], translucency: 0.40, thickness: 0.0200,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 260, fadeStart: 180, maxLod: 2, maxPerChunk: 140, importance: 8,
    ore: null, collidable: true,
    note: 'Whale fall. Coverage 0.14 with a 44 m colony puts a whole ribcage in one place.',
  }),
  Object.freeze({
    id: 26, key: 'oreIron', name: 'Iron Nodule',
    generator: 'generateOreNode',
    meshParams: { size: 1.0, irregularity: 0.5, seamDensity: 1.15, attach: 7 },
    biomes: bm(BASALT, BOULDERS, SPIRES), density: 0.62, cells: 20, maxPerCell: 2,
    scale: [0.30, 0.80], stretch: [0.7, 1.2], slope: [0, 1.3], depth: [-220, 640],
    align: 0.6, tilt: 0.3, sink: 0.10,
    colony: { size: 76, coverage: 0.34, edge: 0.45 },
    sways: false, stiffness: 1, swayStrength: 0.00, twoSided: false,
    emissive: 0.15, emissiveColor: [1.00, 0.42, 0.12],
    fluoresces: false, algalFilm: 1.00,
    colorMul: [1.80, 1.65, 1.50], translucency: 0.00, thickness: 0.0400,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 150, fadeStart: 100, maxLod: 1, maxPerChunk: 170, importance: 9,
    oreAppearance: 0,
    ore: { materialId: 0, amount: [3, 9] }, collidable: true,
    note: 'Faint warm vein glow so a resource is findable by eye on a dark basalt slope.',
  }),
  Object.freeze({
    id: 27, key: 'oreCopper', name: 'Copper Seam',
    generator: 'generateOreNode',
    meshParams: { size: 1.0, irregularity: 0.55, seamDensity: 1.3, attach: 9 },
    biomes: bm(REEF, CORAL_GDN, BOULDERS, CANYON), density: 0.48, cells: 20, maxPerCell: 2,
    scale: [0.30, 0.78], stretch: [0.7, 1.2], slope: [0, 1.3], depth: [4, 760],
    align: 0.6, tilt: 0.3, sink: 0.10,
    colony: { size: 82, coverage: 0.32, edge: 0.45 },
    sways: false, stiffness: 1, swayStrength: 0.00, twoSided: false,
    emissive: 0.18, emissiveColor: [0.32, 1.00, 0.74],
    fluoresces: false, algalFilm: 1.00,
    colorMul: [0.96, 1.06, 0.94], translucency: 0.00, thickness: 0.0400,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 150, fadeStart: 100, maxLod: 1, maxPerChunk: 160, importance: 9,
    oreAppearance: 1,
    ore: { materialId: 1, amount: [3, 8] }, collidable: true,
    note: 'Malachite green rim: the oxidised copper cue every player already knows.',
  }),
  Object.freeze({
    id: 28, key: 'oreTitanium', name: 'Titanium Ore',
    generator: 'generateOreNode',
    meshParams: { size: 1.0, irregularity: 0.45, seamDensity: 1.0, attach: 6 },
    biomes: bm(BREAK, SPIRES, CANYON, TRENCH_WALL), density: 0.42, cells: 16, maxPerCell: 2,
    scale: [0.32, 0.86], stretch: [0.7, 1.2], slope: [0, 1.4], depth: [90, 1600],
    align: 0.55, tilt: 0.32, sink: 0.10,
    colony: { size: 90, coverage: 0.30, edge: 0.45 },
    sways: false, stiffness: 1, swayStrength: 0.00, twoSided: false,
    emissive: 0.22, emissiveColor: [0.72, 0.86, 1.00],
    fluoresces: false, algalFilm: 1.00,
    colorMul: [0.98, 1.00, 1.04], translucency: 0.00, thickness: 0.0400,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 160, fadeStart: 108, maxLod: 1, maxPerChunk: 160, importance: 9,
    oreAppearance: 2,
    ore: { materialId: 2, amount: [2, 6] }, collidable: true,
    note: 'The hull-upgrade resource, so it lives past the shelf break: you must go deep for it.',
  }),
  Object.freeze({
    id: 29, key: 'oreQuartz', name: 'Deep Quartz',
    generator: 'generateOreNode',
    meshParams: { size: 1.0, irregularity: 0.4, seamDensity: 1.5, attach: 11 },
    biomes: bm(TERRACE, ABYSSAL, TRENCH_WALL, TRENCH_FLOOR), density: 0.36, cells: 16, maxPerCell: 2,
    scale: [0.30, 0.82], stretch: [0.8, 1.4], slope: [0, 1.4], depth: [200, 1600],
    align: 0.5, tilt: 0.34, sink: 0.10,
    colony: { size: 96, coverage: 0.30, edge: 0.45 },
    sways: false, stiffness: 1, swayStrength: 0.00, twoSided: false,
    // CITRINE, not blue-white. Quartz takes whatever colour its trace iron gives
    // it, so this is a free choice like the crystals' - and unlike them it is a
    // RESOURCE the player has to find by eye in water where nothing else is, so
    // it is worth spending on a hue no rock and no water shares. [0.62, 0.80,
    // 1.00] delivered 214 deg, inside the water; [1.00, 0.78, 0.34] delivers
    // 47 deg at 20 m of ABYSSAL_VOID.
    emissive: 1.1, emissiveColor: [1.00, 0.78, 0.34],
    fluoresces: false, algalFilm: 1.00,
    colorMul: [0.34, 0.36, 0.40], translucency: 0.80, thickness: 0.0500,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 190, fadeStart: 128, maxLod: 2, maxPerChunk: 150, importance: 10,
    oreAppearance: 4,
    ore: { materialId: 3, amount: [2, 5] }, collidable: true,
    note: 'Bright enough (1.1 cd/m2) to be a beacon in water where nothing else is.',
  }),
  Object.freeze({
    id: 30, key: 'ventSulphur', name: 'Sulphur Crust',
    generator: 'generateOreNode',
    meshParams: { size: 1.0, irregularity: 0.62, seamDensity: 1.4, attach: 9 },
    biomes: bm(TRENCH_FLOOR, TRENCH_WALL, CANYON), density: 1.6, cells: 25, maxPerCell: 2,
    scale: [0.35, 1.00], stretch: [0.35, 0.7], slope: [0, 0.9], depth: [420, 1600],
    align: 0.9, tilt: 0.4, sink: 0.05,
    colony: { size: 56, coverage: 0.30, edge: 0.4 },
    sways: false, stiffness: 1, swayStrength: 0.00, twoSided: false,
    // 1.8: the note below already called this "the only warm colour down there"
    // and 0.45 was not enough for it to be one. A sulphur crust is flat, wide and
    // dense (1.6 per 100 m^2 in 56 m fields), which is the shape that carries a
    // warm hue over the trench's short red path better than anything vertical.
    emissive: 1.8, emissiveColor: [1.00, 0.72, 0.14],
    fluoresces: false, algalFilm: 1.00,
    colorMul: [0.38, 0.34, 0.26], translucency: 0.30, thickness: 0.0400,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 120, fadeStart: 80, maxLod: 1, maxPerChunk: 330, importance: 6,
    oreAppearance: 3,
    ore: { materialId: 4, amount: [4, 12] }, collidable: false,
    note: 'The yellow crust around a vent field. Flat, wide, and the only warm colour down there.',
  }),
  // -----------------------------------------------------------------------
  // Biome signatures
  // -----------------------------------------------------------------------
  // These are deliberately APPENDED. Type ids salt placement, index renderer
  // resources and are packed into one byte per instance; inserting them among
  // the older rows would reshuffle the whole planet. Each signature is large,
  // sparse, exclusive to one biome and clustered at landform scale. The shared
  // catalogue still supplies ecological continuity at boundaries, while these
  // rows supply the one silhouette that identifies a destination at a glance.
  Object.freeze({
    id: 31, key: 'reefPillar', name: 'Sun Pillar Coral', signatureBiome: REEF,
    generator: 'generateCoralBranching',
    meshParams: { attractors: 460, spread: 0.30, height: 4.6, color: MESH_PALETTE.CORAL_CREAM },
    biomes: bm(REEF), density: 0.22, cells: 12, maxPerCell: 1,
    scale: [0.72, 1.35], stretch: [1.0, 1.35], slope: [0, 0.82], depth: [2, 42],
    align: 0.72, tilt: 0.16, sink: 0.30,
    colony: { size: 150, coverage: 0.46, edge: 0.34 },
    sways: false, stiffness: 1, swayStrength: 0, twoSided: false,
    emissive: 4.8, emissiveColor: [1.00, 0.40, 0.12], fluoresces: true, algalFilm: 0,
    // Scalar 0.1775 keeps the amber-gold pigment response at 0.106 Rec709,
    // matching the established branching/fan/tube material level. AMBER-GOLD
    // since the P3 shallow colour pass: the old warm-carbonate response was
    // branching's own salmon on a taller mesh, so the reef's signature was
    // invisible as a family. Gold keeps a green lobe, green survives the
    // sight path, and the "sunlit columns" of the note below finally read
    // sunlit. This is Shallow Reef's carrier of the gold family that coralFan
    // brings to the four biomes the reef is not in.
    colorMul: [0.1946, 0.1946, 0.1946], translucency: 0.42, thickness: 0.030,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 210, fadeStart: 145, maxLod: 2,
    maxPerChunk: 36, importance: 11, ore: null, collidable: true,
    note: 'Tall narrow carbonate crowns repeat like sunlit columns and give Shallow Reef a skyline.',
  }),
  Object.freeze({
    id: 32, key: 'coralCrown', name: 'Crown Coral', signatureBiome: CORAL_GDN,
    generator: 'generateCoralBranching',
    meshParams: { attractors: 520, spread: 0.78, height: 4.2, color: MESH_PALETTE.CORAL_PINK },
    biomes: bm(CORAL_GDN), density: 0.18, cells: 10, maxPerCell: 1,
    scale: [0.85, 1.65], stretch: [0.78, 1.12], slope: [0, 0.78], depth: [4, 58],
    align: 0.68, tilt: 0.18, sink: 0.34,
    colony: { size: 118, coverage: 0.50, edge: 0.38 },
    sways: false, stiffness: 1, swayStrength: 0, twoSided: false,
    emissive: 6.2, emissiveColor: [1.00, 0.18, 0.42], fluoresces: true, algalFilm: 0,
    // Scalar 0.588 likewise keeps the pink-red response at 0.106 Rec709.
    colorMul: [0.588, 0.588, 0.588], translucency: 0.50, thickness: 0.028,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 220, fadeStart: 150, maxLod: 2,
    maxPerChunk: 32, importance: 11, ore: null, collidable: true,
    note: 'House-wide pink crowns form colourful groves separated by open blue lanes.',
  }),
  Object.freeze({
    id: 33, key: 'sandSail', name: 'Sand Sail', signatureBiome: SAND,
    generator: 'generateCoralFan',
    meshParams: { thickness: 0.25, height: 4.0, color: MESH_PALETTE.CORAL_ORANGE },
    biomes: bm(SAND), density: 0.28, cells: 14, maxPerCell: 1,
    scale: [0.62, 1.42], stretch: [0.85, 1.45], slope: [0, 0.34], depth: [24, 135],
    align: 0.18, tilt: 0.20, sink: 0.22,
    colony: { size: 190, coverage: 0.42, edge: 0.32 },
    sways: true, stiffness: 0.68, swayStrength: 0.10, twoSided: true,
    emissive: 0, emissiveColor: [0, 0, 0], fluoresces: false, algalFilm: 0,
    // Luma-matched re-pigment (P3 shallow colour pass): the old [0.72, 0.58,
    // 0.34] delivered a red-dominant amber (r/g 4.4 through CORAL_ORANGE),
    // and at this row's 24-135 m band the water takes the red and the sail
    // arrived pale pink - the exact washed family the pass exists to break.
    // This triple keeps delivered Rec709 luminance at the same 0.2086 while
    // lifting the green lobe +29% and cutting r/g 4.37 -> 2.67 (g/b rises
    // 3.5 -> 9.5, the only ratio that "triples"), so what survives the
    // column is a gold-olive membrane. Not fluorescent, so colorMul is its
    // only pigment.
    colorMul: [0.5675, 0.7488, 0.1576], translucency: 0.82, thickness: 0.010,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 190, fadeStart: 128, maxLod: 2,
    maxPerChunk: 44, importance: 10, ore: null, collidable: true,
    note: 'Sparse gold membrane sails stand alone on the plains and preserve broad empty horizons.',
  }),
  Object.freeze({
    id: 34, key: 'boulderShelter', name: 'Shelter Stone', signatureBiome: BOULDERS,
    generator: 'generateBoulder',
    meshParams: { size: 1.0, irregularity: 0.94, color: MESH_PALETTE.BASALT_DARK },
    biomes: bm(BOULDERS), density: 0.30, cells: 10, maxPerCell: 1,
    scale: [4.8, 9.5], stretch: [0.48, 0.82], slope: [0, 0.82], depth: [32, 175],
    align: 0.82, tilt: 0.28, sink: 0.30,
    colony: { size: 176, coverage: 0.50, edge: 0.30 },
    sways: false, stiffness: 1, swayStrength: 0, twoSided: false,
    emissive: 0, emissiveColor: [0, 0, 0], fluoresces: false, algalFilm: 1,
    colorMul: [2.15, 2.25, 2.40], translucency: 0, thickness: 0.080,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 340, fadeStart: 235, maxLod: 3,
    maxPerChunk: 18, importance: 12, ore: null, collidable: true,
    note: 'Flattened house-sized slabs create shelters and unmistakable dark negative spaces.',
  }),
  // ==========================================================================
  // THE SIX EXCLUSIVE SIGNATURES, RE-LEVELLED BY SCALE AND DENSITY.
  //
  // WHY SCALE AND NOT BRIGHTNESS, AND IT IS PROVEN INSIDE THIS TABLE. A
  // signature is supposed to be what an unlabelled screenshot of its biome is
  // OF, and measured against every other type placed in its own biome these
  // six held 6.06-48.52% of the footprint and 0.000-7.196% of the emitted flux
  // while `mushroomCap` alone held 43.6-47.4% of the flux in four of them. The
  // only two rows in the whole table that already read - boulderShelter at
  // 31.02% of Boulder Field's footprint and abyssRib at 48.52% of the Abyssal
  // Plain's - are the two with a real scale band, and the four authored around
  // 1.0 sat at 6.06-20.94%. So the lever is SIZE, and reaching for emission
  // instead is the trap the coral rows already documented: a brighter object is
  // a WHITER one, because it climbs the AgX shoulder.
  //
  // FOOTPRINT means the world-space silhouette (meshWidth * sxz) x
  // (meshHeight * sy) summed over a biome's delivered instances. It is measured
  // off the real generated mesh because meshParams carry METRES - abyssRib's
  // boneRib is authored 20 m long and shelfUrn's barrel 3.8 m - so a share
  // computed off the scale band alone is 20x wrong between two rows.
  //
  // WHAT EACH ROW IS WORTH AFTER THIS EDIT, measured over 251 chunks around the
  // seven deep anchors. Footprint share, then flux share on the authored peak,
  // then flux share once fluorescence is discounted by the blue daylight
  // surviving to the biome's own anchor depth - which is the physical quantity,
  // and only differs at Shelf Break, the last biome that still has daylight:
  //   shelfUrn         7.74 -> 12.61%    0.121 -> 0.229%  (1.32 -> 2.42%)
  //   spireCrown       6.06 -> 42.74%    7.196 -> 47.30%
  //   terraceVeil     20.94 -> 83.79%    0.352 -> 25.65%
  //   canyonBanner    19.08 -> 63.35%    1.496 -> 23.07%
  //   abyssRib        48.52 -> 48.52%    0.000 -> 1.09%
  //   trenchWallSpine  6.68 -> 43.62%    0.888 -> 36.09%
  // Twilight Terraces' and Canyon Wall's post-change shares look like a
  // monoculture and are not: they are 0.89% and 4.50% of the biome's INSTANCES,
  // against a biome whose other 95-99% is 0.2-3 m props. That is the
  // boulderShelter model exactly - 1.09% of Boulder Field's instances carrying
  // 31.02% of its silhouette. Measured nearest-neighbour p50 for the four
  // membrane-and-needle rows is 10.0-23.5 m, which is closer than
  // boulderShelter's own 13.7 m at a LARGER 18.2 m mean width, so none of them
  // crowds harder than the row this whole item is modelled on. The one row that
  // did is shelfUrn, and its comment says what was done about it.
  //
  // shelfUrn's ROW IS THE ONE FIGURE ABOVE THAT WAS RE-CUT, and its three
  // numbers are the 20.41 / 0.370 / 3.92 census SCALED by the exact silhouette-
  // area ratio of the narrower band, not a fresh census - say so rather than
  // imply a measurement that was not taken. The ratio is exact: sy = sxz *
  // stretch and stretch is untouched, so silhouette area goes as sxz^2, and
  // mean(sxz^2) over the 87 real draws around the Shelf Break anchor is 4.371 at
  // [1.55, 2.65] against 2.701 at [1.20, 2.10] - x0.618. Linearising the row's
  // own two measured points that way puts it at 12.61%; fitting a power law
  // through the same two points (7.74% at x1.0, 20.41% at x3.096) puts it at
  // 13.5%. Both clear the item's >= 10% gate, and [1.00, 1.90] - the next band
  // down that was shot - straddles it at 9.77% / 10.9%, which is what decided
  // the number.
  //
  // EVERY EMISSIVE RAISE IS TO 1.4, THE BOTTOM OF THE AUTHORISED 1.4-2.2 BAND,
  // AND TWO ROWS GET NONE. The gate on this whole item is that delivered HSV
  // saturation must not fall, so each raise is the smallest one that clears the
  // 15%-of-flux target and no more. spireCrown's scale and density alone take it
  // from 7.196% to 47.30%, and doubling its 0.85 on top would have taken Rock
  // Spires' whole emitted flux to 2.59x rather than the 1.76x it is, for a share
  // that was already passing three times over. shelfUrn's 1.4 shipped for one
  // iteration and was backed out on the evidence - see its row. abyssRib is the
  // exception in the other direction, also on its own row. Measured cost of the
  // raises that stayed: total emitted flux x1.76 Rock Spires, x1.55 Trench Wall,
  // x1.34 Twilight Terraces, x1.28 Canyon Wall, x1.01 Abyssal Plain.
  //
  // VIEW DISTANCE MOVES WITH SIZE, AND THAT IS NOT AN EXTRA. These rows grow
  // 1.75-2.17x in LINEAR size, so at their old fade a 20-40 m landmark would
  // start shrinking out while still subtending more of the frame than it did
  // before the change - a pop introduced by this edit rather than one that was
  // already there. They are set to 340/235, boulderShelter's numbers, which are
  // the table's underwater maximum, so SCATTER_MAX_VIEW_DISTANCE does not move
  // and no culling envelope changes. Cost, from the measured 1.84 terraceVeil
  // per chunk: ~41 instances inside the new radius, against a 6,144 per-chunk
  // budget that test-scatter still measures binding on zero of 200 chunks.
  // ==========================================================================
  Object.freeze({
    id: 35, key: 'shelfUrn', name: 'Shelf Urn', signatureBiome: BREAK,
    generator: 'generateSponge',
    meshParams: { form: 'barrel', height: 3.8, bore: 0.58, tubes: 7, ribs: 8,
      color: MESH_PALETTE.SPONGE_URN },
    // THE ONE ROW WHOSE DENSITY DOES NOT RISE, AND IT WAS DECIDED BY LOOKING.
    // The proposal's 0.48 against this scale band puts 13.9 m-wide OPAQUE
    // barrels 13.5 m apart (measured nearest-neighbour p50 over 25 chunks), and
    // the pulled-back frame is a continuous wall of pale slabs where the shipped
    // build had urns standing among coral fans with water between them. The
    // other five signatures are needles, membranes and ribs and survive that
    // spacing; a barrel does not, because it is the only solid closed body of
    // the six. So the SIZE stays - it is the lever the whole item rests on and
    // it alone takes this row from 7.74% of Shelf Break's footprint to 20.41%,
    // twice the target - and the COUNT stays where it shipped, which buys the
    // negative space back: measured 16.1 m apart at a 13.6 m mean width, against
    // 13.5 m apart at 13.9 m. This is the biome brief's own direction, "use larger
    // plants at lower count rather than increasing total scatter density", and
    // it is the one place in this item where it and the proposal disagree. 0.10
    // was tried and is the FLOOR this row cannot go under: test-scatter's "every
    // biome signature actually occurs in the sampled world" reports shelfUrn
    // ABSENT from its 200-chunk sample there.
    //
    // AND THEN THE SIZE CAME BACK DOWN ANYWAY, BECAUSE THE SPACING ABOVE WAS
    // MEASURED SOMEWHERE THE ARRIVAL CAMERA DOES NOT STAND. Re-measured over the
    // 87 urns within 169 chunks of the Shelf Break anchor the tour actually
    // visits, nearest-neighbour p50 is 18.4 m (p05 9.1, min 4.4) against a mean
    // width of 16.37 m at [1.55, 2.65] - 0.89x the spacing, with 37% of urns
    // WIDER THAN THEIR OWN NEAREST NEIGHBOUR, i.e. interpenetrating. That is the
    // "continuous wall of pale slabs" this comment says the count was held down
    // to avoid, arrived at through the scale band instead. At [1.20, 2.10] the
    // mean width is 12.85 m, 0.70x the spacing, and the overlapping share is 24%
    // (pre-Stage-1: 9.16 m, 0.50x, 11%). Silhouette area is still x1.91 on
    // pre-Stage-1 and linear size x1.62, so scale remains the lever.
    //
    // WHAT THIS DID NOT FIX, STATED PLAINLY SO IT IS NOT RE-LITIGATED HERE. This
    // row was blamed for the Shelf Break arrival frame being a pale wall with no
    // scale cue, and it is at most a third of the cause. Ablation at that
    // identical pose, one row at a time, whole-frame near-mass:
    //   terrain alone (both rows out)                     0.3643
    //   + shelfUrn only, at the old [1.55, 2.65]          0.6869
    //   + terraceVeil only                                0.6672
    //   + both, i.e. the delivered frame                  0.7753
    // So the single largest term is the POSE - the eye arrives 3.68 m above a
    // slope that does not fall away, where the baseline anchor sat on the lip and
    // read 0.2208 - and the two signatures are near-equal contributors that
    // mostly occlude each other. terraceVeil is TWILIGHT TERRACES' signature,
    // standing 7.4 m from the eye at 14.9 m wide, and is not this row's to cut.
    // Re-cutting this band takes shelfUrn's own contribution 0.3226 -> 0.2239
    // (-31%) but moves the DELIVERED frame only 0.7753 -> 0.7380, because the
    // veil in front of it absorbs most of the difference. Nothing in this file
    // can move the anchor that chose the pose: biome_anchors.js imports terrain
    // and biomes and never scatter.
    biomes: bm(BREAK), density: 0.16, cells: 10, maxPerCell: 1,
    // 8.0-13.9 m across and 5.6-15.3 m tall, from 4.8-11.0 x 3.4-12.0.
    scale: [1.20, 2.10], stretch: [1.0, 1.55], slope: [0.18, 1.15], depth: [70, 260],
    align: 0.54, tilt: 0.18, sink: 0.34,
    colony: { size: 126, coverage: 0.38, edge: 0.34 },
    sways: false, stiffness: 1, swayStrength: 0, twoSided: false,
    // 0.18 IS UNCHANGED, AND THIS IS THE ITEM'S OWN ESCAPE HATCH TAKEN: back the
    // emissive out and take the presence from size. 1.4 shipped for one
    // iteration and it is the raise the AgX gate was written to catch. Shelf
    // Break is the LAST biome with real daylight - p50 210 m in OCEANIC_CLEAR -
    // so the proposal's justification for the 1.4-2.2 band ("black geometry in
    // lightless water and therefore not on the shoulder") is the one place it
    // does not hold. Measured at 1.4: the pulled-back frame's scene luminance
    // went 0.0015 -> 0.0026 and the urns turned from blue-grey bodies into
    // near-white slabs, which is a brighter object being a whiter one, exactly
    // as the coral rows already record. The consequence is stated rather than
    // hidden: this row therefore reaches 2.4% of Shelf Break's delivered flux
    // against the item's 15% (it was 4.0% before the band was re-cut to
    // [1.20, 2.10]; flux scales with the same silhouette area), and it is the
    // one signature that reads by
    // SILHOUETTE alone. That is the right trade here - 89.6% of this biome's
    // authored emission is coralFan's FLUORESCENCE, which is pumped by the blue
    // daylight surviving to the instance (exp(-0.0253 * 213 m) = 4.2e-3 of the
    // surface), so "share of emitted flux" is a contest against a number that is
    // itself mostly notional.
    emissive: 0.18, emissiveColor: [0.86, 0.42, 0.20], fluoresces: false, algalFilm: 0,
    colorMul: [0.62, 0.48, 0.40], translucency: 0.48, thickness: 0.045,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 340, fadeStart: 235, maxLod: 2,
    maxPerChunk: 26, importance: 11, ore: null, collidable: true,
    note: 'Giant rust urns cling to the shelf lip and turn its drop-off into a recognisable wall garden.',
  }),
  Object.freeze({
    id: 36, key: 'spireCrown', name: 'Spire Crown', signatureBiome: SPIRES,
    generator: 'generateCrystal',
    meshParams: { height: 3.8, prisms: 9, sides: 7, color: MESH_PALETTE.AMETHYST },
    biomes: bm(SPIRES), density: 0.39, cells: 10, maxPerCell: 1,
    // 5.2-9.2 m across and 10.5-32.0 m tall, from 2.2-5.1 x 4.5-17.6. A crown
    // that repeats the tower rhythm has to be read against a 178 m tower.
    scale: [1.70, 3.00], stretch: [1.1, 1.9], slope: [0.22, 1.45], depth: [95, 430],
    align: 0.22, tilt: 0.30, sink: 0.30,
    colony: { size: 154, coverage: 0.42, edge: 0.34 },
    sways: false, stiffness: 1, swayStrength: 0, twoSided: false,
    // 0.85 IS DELIBERATELY UNCHANGED and it is the one row in this block that
    // keeps its authored emission. CRYSTAL is the second-highest emissive slot
    // gate in the table (0.85 against BONE's 0.05), so this row was never the
    // black geometry the other five were: scale and density alone take it from
    // 7.196% of Rock Spires' flux to 47.30%, three times the acceptance gate.
    // Doubling it on top would have taken the biome's TOTAL emitted flux to
    // 2.59x rather than the 1.76x it is, straight at the AgX shoulder this
    // item's gate is written against, for a share that was already passing.
    emissive: 0.85, emissiveColor: [0.92, 0.18, 0.70], fluoresces: false, algalFilm: 0.65,
    colorMul: [0.52, 0.46, 0.62], translucency: 0.88, thickness: 0.075,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 340, fadeStart: 235, maxLod: 2,
    maxPerChunk: 24, importance: 12, ore: null, collidable: true,
    note: 'Violet mineral crowns repeat the vertical terrain rhythm without carpeting the gaps.',
  }),
  Object.freeze({
    id: 37, key: 'terraceVeil', name: 'Terrace Veil', signatureBiome: TERRACE,
    generator: 'generateCoralFan',
    meshParams: { thickness: 0.20, height: 4.8, color: MESH_PALETTE.CORAL_VIOLET },
    biomes: bm(TERRACE), density: 0.88, cells: 12, maxPerCell: 1,
    // 9.2-19.0 m across and 6.7-23.9 m tall, from 3.8-9.1 x 2.8-11.4.
    scale: [1.50, 3.10], stretch: [0.9, 1.55], slope: [0.05, 0.88], depth: [150, 520],
    align: 0.26, tilt: 0.25, sink: 0.24,
    colony: { size: 112, coverage: 0.40, edge: 0.42 },
    sways: true, stiffness: 0.58, swayStrength: 0.11, twoSided: true,
    // 0.28 -> 1.4 puts this row at 25.65% of Twilight Terraces' emitted flux
    // against mushroomCap's 35.37%, which is what the biome brief's "Avoid: glowcup
    // carpet" needs to become enforceable without SUBTRACTING any light - the
    // hard sequencing rule forbids that until Stage 2 replaces it. TRANSLUCENT
    // gates at 0.20, so a 1.4 authored peak is 0.28 of delivered surface glow:
    // this is a lit membrane, not a lamp, and the biome's total emitted flux
    // rises only 1.34x.
    emissive: 1.4, emissiveColor: [0.62, 0.20, 0.82], fluoresces: false, algalFilm: 0,
    colorMul: [0.46, 0.42, 0.62], translucency: 0.90, thickness: 0.010,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 340, fadeStart: 235, maxLod: 2,
    maxPerChunk: 36, importance: 10, ore: null, collidable: true,
    note: 'Tall violet veils rise from selected terrace steps, leaving the neighbouring steps bare.',
  }),
  Object.freeze({
    id: 38, key: 'canyonBanner', name: 'Canyon Banner', signatureBiome: CANYON,
    generator: 'generateCoralFan',
    meshParams: { thickness: 0.24, height: 5.6, color: MESH_PALETTE.CORAL_ORANGE },
    biomes: bm(CANYON), density: 0.44, cells: 12, maxPerCell: 1,
    // 9.9-19.1 m across and 8.1-26.2 m tall, from 4.8-10.8 x 3.9-14.6. A banner
    // has to span a constriction to be read as projecting from its wall.
    scale: [1.40, 2.70], stretch: [1.0, 1.65], slope: [0.42, 1.75], depth: [280, 850],
    align: 0.12, tilt: 0.28, sink: 0.26,
    colony: { size: 142, coverage: 0.42, edge: 0.34 },
    sways: true, stiffness: 0.64, swayStrength: 0.09, twoSided: true,
    // 0.52 -> 1.4 is 23.07% of Canyon Wall's emitted flux, from 1.496%, for
    // 1.28x the biome's total emission. It is the smallest raise that clears the
    // gate: at the old 0.52 the scale and density alone reached 10.3%.
    emissive: 1.4, emissiveColor: [1.00, 0.20, 0.12], fluoresces: false, algalFilm: 0,
    colorMul: [0.42, 0.26, 0.22], translucency: 0.78, thickness: 0.012,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 340, fadeStart: 235, maxLod: 2,
    maxPerChunk: 30, importance: 11, ore: null, collidable: true,
    note: 'Iron-red banners span the canyon constrictions so depth is read vertically rather than as floor scatter.',
  }),
  Object.freeze({
    id: 39, key: 'abyssRib', name: 'Abyssal Rib', signatureBiome: ABYSSAL,
    generator: 'generateBoneRib',
    meshParams: { height: 20.0, taper: 0.24, ribs: 10, color: MESH_PALETTE.BONE },
    // SCALE AND DENSITY ARE DELIBERATELY UNCHANGED HERE, ALONE IN THIS BLOCK.
    // This row is not the rare-and-invisible case the other five were: it
    // already holds 48.52% of the Abyssal Plain's footprint - the highest share
    // any signature reaches, 4.9x the acceptance gate - off 0.48% of its
    // instances, because a 20 m boneRib at scale 1.85 delivers 17.3 x 39.1 m.
    // ("abyssRib has n = 0, the plain has no signature" was retracted in review:
    // an independent 121-chunk survey measured ~0.06 per chunk and this one
    // measures 149 over its own block. It is rare, not absent.) What the plain
    // asks for is ONE large pale form in an empty frame, so filling it 3x would
    // spend the identity to satisfy a criterion it already passes.
    // 0.18 -> 0.30 IS STAGE 3.1'S REPLACEMENT HALF for the plain's glow-kit
    // cut (mushroomCap 0.50, mushroomCluster 0.80). The C2 finding is the
    // whole argument: on census-output/p31-control.json this signature holds
    // 37.2% of the biome's AABB footprint (47.5% rotation-invariant) and
    // 0.74% of its peak flux (1.03% luma), so no light selection can ever
    // promote it - the form must simply be MORE PRESENT. (C2's older
    // "48.5% / 1.1%" figures were a different tree and instrument; the
    // census prints both footprint and both flux columns precisely so a
    // quote can name its definition.) Density and scale, never brightness (a rib
    // is bone; making it glow would be a different biome).
    biomes: bm(ABYSSAL), density: 0.30, cells: 10, maxPerCell: 1,
    scale: [0.82, 1.85], stretch: [0.78, 1.18], slope: [0, 0.46], depth: [520, 1200],
    align: 0.58, tilt: 0.32, sink: 0.52,
    colony: { size: 82, coverage: 0.35, edge: 0.24 },
    sways: false, stiffness: 1, swayStrength: 0, twoSided: false,
    // WHAT IT LACKED WAS LIGHT, AND 2.2 IS THE ONE ROW TAKEN TO THE TOP OF THE
    // BAND RATHER THAN THE BOTTOM, BECAUSE BONE CANNOT REACH THE SHOULDER. The
    // BONE material slot gates emission at 0.05 against CRYSTAL's 0.85, so 2.2
    // authored is 0.11 of delivered surface glow and the form reads as pale
    // rather than lit. Measured consequence, and it is stated rather than hidden:
    // that gate also means this row reaches 1.1% of the plain's emitted flux
    // where the item asks for 15%, and no value inside the authorised band can
    // change that - 15% would need an authored 30 cd/m^2. Its job is the
    // SILHOUETTE, which it already dominates; the plain's light is Stage 3.3's
    // whale fall and Stage 2.1's punctual lights, not this.
    emissive: 2.2, emissiveColor: [0.70, 0.80, 1.00], fluoresces: false, algalFilm: 0.35,
    colorMul: [0.40, 0.42, 0.46], translucency: 0.32, thickness: 0.060,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 320, fadeStart: 220, maxLod: 3,
    maxPerChunk: 14, importance: 12, ore: null, collidable: true,
    note: 'Rare leviathan-scale ribs appear as incomplete silhouettes with large fields of black between falls.',
  }),
  Object.freeze({
    id: 40, key: 'trenchWallSpine', name: 'Pressure Spine', signatureBiome: TRENCH_WALL,
    generator: 'generateCrystal',
    meshParams: { height: 4.4, prisms: 6, sides: 5, color: MESH_PALETTE.BASALT_DARK },
    biomes: bm(TRENCH_WALL), density: 0.48, cells: 10, maxPerCell: 1,
    // 4.4-7.9 m across and 14.4-40.6 m tall, from 1.9-4.2 x 6.2-23.9. The
    // narrowest of the six and the tallest: a spine, read against a black wall.
    scale: [1.90, 3.40], stretch: [1.15, 2.0], slope: [0.52, 1.8], depth: [620, 1500],
    align: 0.18, tilt: 0.36, sink: 0.38,
    colony: { size: 166, coverage: 0.35, edge: 0.30 },
    sways: false, stiffness: 1, swayStrength: 0, twoSided: false,
    // 0.24 -> 1.4 takes this row from 0.888% of Trench Wall's emitted flux to
    // 36.09%, against mushroomCap's 29.18%. It costs the biome 1.55x its total
    // emission, the largest rise in this block, which is why it stops at the
    // bottom of the band.
    //
    // maxPerChunk 20 IS LEFT ALONE AND IT NOW DOES WORK. This is the only row of
    // the six whose per-chunk cap binds after the density raise: measured over
    // the 49 chunks around the trench anchor it binds on 2 of them, worst chunk
    // offering 37, and costs 7.7% of the delivered count. That is the valve
    // doing its job - 37 spines 14-40 m tall in one 128 m chunk is a hedge, not
    // a wall of landmarks - and the thinning it applies is UNIFORM, on the
    // biomeThin-independent `thin` salt whose one-cell alias item 1.1 fixed, so
    // it removes instances without patterning them.
    emissive: 1.4, emissiveColor: [0.42, 0.14, 0.72], fluoresces: false, algalFilm: 0.85,
    colorMul: [0.72, 0.68, 0.82], translucency: 0.34, thickness: 0.090,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 340, fadeStart: 235, maxLod: 3,
    maxPerChunk: 20, importance: 12, ore: null, collidable: true,
    note: 'Near-black pressure spines jut from the trench wall, carrying violet seams that read from a distance.',
  }),
  Object.freeze({
    id: 41, key: 'ventCathedral', name: 'Vent Cathedral', signatureBiome: TRENCH_FLOOR,
    generator: 'generateVentChimney',
    meshParams: { height: 5.4, stacks: 8, color: MESH_PALETTE.VENT_CRUST,
      hotColor: MESH_PALETTE.VENT_HOT },
    biomes: bm(TRENCH_FLOOR), density: 0.12, cells: 8, maxPerCell: 1,
    scale: [1.15, 2.35], stretch: [1.0, 1.72], slope: [0, 0.52], depth: [820, 1600],
    align: 0.68, tilt: 0.12, sink: 0.48,
    colony: { size: 138, coverage: 0.30, edge: 0.26 },
    sways: false, stiffness: 1, swayStrength: 0, twoSided: false,
    emissive: 2.8, emissiveColor: [1.00, 0.28, 0.035], fluoresces: false, algalFilm: 1,
    colorMul: [0.82, 0.74, 0.68], translucency: 0, thickness: 0.080,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 340, fadeStart: 238, maxLod: 3,
    maxPerChunk: 16, importance: 12, ore: null, collidable: true,
    note: 'A few towering black smokers form isolated warm cathedrals instead of a uniform glowing garden.',
  }),
  // ==========================================================================
  // DARK OCCLUDING MASS (ids 42-45).
  //
  // WHAT THE CENSUS SAID, AND IT RETARGETED THE ITEM. Measured over
  // census-output/s3-base.json: the number of DARK (emissive < 0.5) instances
  // over 10 m within 25 m of a random seabed point is break 0.474, spires 0.136,
  // terrace 0.166, canyon 0.000, abyssal 0.000, trenchWall 0.000, against an
  // acceptance of >= 1.0. Drop the emissive term and the same count reads
  // terrace 2.363, canyon 1.783, trenchWall 1.200, spires 1.135 - so four of the
  // six ALREADY have the geometry and every bit of it emits, because Stage 1's
  // own 34c76a4 raised `abyssRib` 0 -> 2.2, `trenchWallSpine` 0.24 -> 1.4,
  // `canyonBanner` 0.52 -> 1.4 and `terraceVeil` 0.28 -> 1.4. These four rows are
  // the DARK half of that, and nothing here may emit.
  //
  // AND THE ARCH THE ITEM ASKED FOR IS NOT IN THIS TABLE, because the ground
  // will not take one. The item specifies a two-legged span at 15-45 m with a
  // LOW-slope placement filter and says to schedule it into Shelf Break and
  // Boulder Field first. Measured on the placement filter's own slope - which is
  // the max of two one-sided 4 m differences and then the max over four bilinear
  // corners, and reads 1.187x the exact `terrain.sampleSlope`:
  //
  //   biome        < 0.30    < 0.50    < 0.80    p50
  //   break          0.00%     2.01%    39.01%   0.891
  //   spires         0.00%     0.00%     0.00%   1.179
  //   boulders      21.32%    71.22%    96.38%   0.407
  //   abyssal       38.60%    94.41%    98.62%   0.331
  //
  // A `slope: [0, 0.30]` arch masked to Shelf Break delivers ZERO instances and
  // nothing would report it; Rock Spires has no sub-0.80 ground AT ALL. Boulder
  // Field and the Abyssal Plain can take one - and Boulder Field is the single
  // deep biome that already passes, at E(dark) 5.077. Worse, a 40 m span needs
  // 40 m of flat: in Boulder Field at slope < 0.30 exactly 0.0% of qualifying
  // cells carry a 40 m all-low-slope run, and a 40 m chord whose two ends both
  // sit on low-slope ground still drops a MEDIAN 6.7 m, which is a 9.5-degree
  // tilt of the whole form that one surface sample plus align/tilt cannot
  // absorb. That is the item's own Risk paragraph, measured. Its stated fallback
  // is "a one-legged cantilever, which occludes less" - and a projecting bedded
  // ledge IS that cantilever, which is what `canyonLedge` is.
  //
  // ROCK SPIRES GETS NOTHING FROM THIS ITEM AND CANNOT. No footed form can stand
  // on 0.00%-under-0.80 ground, and its binding Avoid column is "ordinary rocky
  // wall or dense floor scatter", which is what the alternative would be. Its
  // own terrain column asks for "bridges" between needles, and a scatter
  // instance anchors to ONE surface sample and cannot span two towers. It needs
  // terrain or a Stage 5 Place, which is where the backlog already puts it.
  //
  // ONE GENERATOR, THREE ROWS, and that is the item's own design: differentiated
  // by `opts.color` and a slope band. None of the three carries `signatureBiome`
  // - every underwater biome already has one, test-scatter asserts exactly
  // twelve, and the field promotes a row to a BEACON light in
  // render/passes/scatter.js, which would make a dark-mass row a light source.
  // ==========================================================================
  Object.freeze({
    id: 42, key: 'shelfStrata', name: 'Shelf Bedding',
    generator: 'generateStratumSlab',
    // Golden-brown, because the biome brief's binding palette column for Shelf Break
    // is "golden-brown beds fading into clean blue" and its terrain column is
    // "promontories, exposed strata, ledges". A black slab here is off-identity;
    // this row is the one place in the table that colour is authored FOR.
    meshParams: { size: 6.2, beds: 6, spread: 0.78, color: MESH_PALETTE.SPONGE_URN },
    biomes: bm(BREAK), density: 0.21, cells: 8, maxPerCell: 1,
    // THE SLOPE BAND IS THE MEASUREMENT, NOT A GUESS. Shelf Break's placement
    // slope is p50 0.891 with 39% under 0.80 and 2% under 0.50, so a low-slope
    // band delivers nothing and a band centred on its own median delivers the
    // bedding where the biome actually is - on the shelf edge.
    scale: [1.5, 2.6], stretch: [0.82, 1.15], slope: [0.26, 1.55], depth: [80, 320],
    // High align: bedding lies ON the slope it weathered out of. A vertical
    // stack on a 40-degree shelf edge reads as a stack of dinner plates.
    align: 0.92, tilt: 0.10, sink: 0.34,
    colony: { size: 210, coverage: 0.44, edge: 0.30 },
    sways: false, stiffness: 1, swayStrength: 0, twoSided: false,
    emissive: 0, emissiveColor: [0, 0, 0], fluoresces: false, algalFilm: 1,
    colorMul: [1.05, 0.94, 0.76], translucency: 0, thickness: 0.080,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 340, fadeStart: 235, maxLod: 3,
    maxPerChunk: 14, importance: 12, ore: null, collidable: true,
    note: 'Exposed golden-brown beds step out of the shelf edge and put a dark undercut in front of the drop.',
  }),
  Object.freeze({
    id: 43, key: 'canyonLedge', name: 'Projecting Ledge',
    generator: 'generateStratumSlab',
    meshParams: { size: 5.4, beds: 5, spread: 0.60, color: MESH_PALETTE.BASALT_DARK },
    // ONE BIOME. This shipped as ONE ROW carried by Canyon Wall AND Trench Wall,
    // separated by a `biomeTint`, and the census refused it: a tint is a COLOUR
    // and the vocabulary metric is over SHAPES, so `trenchWall x canyon` went
    // 0.0851 -> 0.4509 on the row-level footprint cosine - straight through item
    // 3.2's own acceptance of "below 0.40", caused by the item before it. Two
    // rows off one generator is the fix, and it is also the better art:
    // The biome brief gives Canyon Wall "iron-red and violet rock" and Trench Wall
    // "black-blue with thin violet mineral seams", and one row forced them to
    // share a bed count and a spread as well as a shape.
    biomes: bm(CANYON), density: 0.52, cells: 8, maxPerCell: 1,
    biomeTint: { [CANYON]: [1.34, 0.86, 0.62] },
    // Canyon Wall's placement slope is p50 0.826 and Trench Wall's 0.593, with
    // 43.7% and 73.8% under 0.80. A projecting ledge belongs on the steep part.
    scale: [1.5, 2.7], stretch: [0.78, 1.08], slope: [0.42, 2.10], depth: [110, 900],
    // FULLY ALIGNED, so the stack grows OUT of the wall rather than up from it.
    // This is the item's own fallback for the arch: a one-legged cantilever.
    align: 1.0, tilt: 0.14, sink: 0.30,
    colony: { size: 168, coverage: 0.38, edge: 0.28 },
    sways: false, stiffness: 1, swayStrength: 0, twoSided: false,
    emissive: 0, emissiveColor: [0, 0, 0], fluoresces: false, algalFilm: 1,
    colorMul: [1.72, 1.66, 1.74], translucency: 0, thickness: 0.080,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 340, fadeStart: 235, maxLod: 3,
    maxPerChunk: 16, importance: 12, ore: null, collidable: true,
    note: 'Iron-red bedded shelves project straight out of the canyon wall and pass in front of everything behind them.',
  }),
  Object.freeze({
    id: 44, key: 'terraceStep', name: 'Terrace Step',
    generator: 'generateStratumSlab',
    meshParams: { size: 5.8, beds: 8, spread: 1.30, color: MESH_PALETTE.BASALT },
    // TWILIGHT TERRACES IS NOT TERRACED AT ANY SCALE - 0.82% tread coverage
    // measured - and the plan's answer is to deliver the layered
    // read from stacked instanced plates before touching the terrain. This row
    // IS that answer: eight thin beds, wide and flat, on the flattest deep biome
    // in the world (BIOMES slope band [0, 0.46]).
    biomes: bm(TERRACE), density: 0.68, cells: 8, maxPerCell: 1,
    scale: [1.4, 2.5], stretch: [0.72, 1.02], slope: [0, 0.44], depth: [140, 460],
    align: 0.55, tilt: 0.07, sink: 0.40,
    colony: { size: 230, coverage: 0.52, edge: 0.34 },
    sways: false, stiffness: 1, swayStrength: 0, twoSided: false,
    emissive: 0, emissiveColor: [0, 0, 0], fluoresces: false, algalFilm: 1,
    colorMul: [1.24, 1.30, 1.42], translucency: 0, thickness: 0.080,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 340, fadeStart: 235, maxLod: 3,
    maxPerChunk: 18, importance: 12, ore: null, collidable: true,
    note: 'Wide low plate stacks give the terraces an actual tread to read against the veils.',
  }),
  Object.freeze({
    id: 45, key: 'whaleFall', name: 'Whale Fall',
    generator: 'generateWhaleFall',
    meshParams: { size: 26, vertebrae: 13, ribPairs: 6, color: MESH_PALETTE.BONE,
      matColor: MESH_PALETTE.CARBONATE, wormColor: MESH_PALETTE.TUBEROD },
    // The Abyssal Plain's own terrain column names it: "flat ash, WHALE FALLS,
    // extremely rare colossal forms". RARE IS THE POINT - its Avoid column is
    // "mushroom forest, dense glow pods, repeated small props" and the plan's
    // own line for the biome is that emptiness is the identity. The density here
    // is the lowest in the whole table.
    // OSSUARY joined the mask and the depth band's shallow edge came 420 ->
    // 280 WITH it (P4-C): a 285-368 m biome cannot carry a row whose band
    // starts at 420. The band move is not free for ABYSSAL and that is
    // intended sharing, stated rather than hidden: the terrace cession (see
    // biomes.js) hands Abyssal Plain the 370-430 m flats, and with the band at
    // 280 those newly-abyssal columns may carry the odd whale fall too - the
    // census A/B for this change is the record of how many (single digits;
    // density 0.30 on cells 6 is the lowest offer in the table).
    biomes: bm(ABYSSAL, OSSUARY), density: 0.30, cells: 6, maxPerCell: 1,
    // 94.4% of the plain is under placement slope 0.50, so this is the one row
    // in the item that CAN use a low-slope filter and mean it.
    scale: [0.85, 1.55], stretch: [0.92, 1.18], slope: [0, 0.42], depth: [280, 1080],
    align: 0.72, tilt: 0.09, sink: 0.10,
    // A wide, sparse colony so two carcasses are never adjacent but a diver who
    // finds one has some chance of finding the next.
    colony: { size: 420, coverage: 0.30, edge: 0.40 },
    sways: false, stiffness: 1, swayStrength: 0, twoSided: false,
    emissive: 0, emissiveColor: [0, 0, 0], fluoresces: false, algalFilm: 0,
    colorMul: [0.62, 0.60, 0.56], translucency: 0, thickness: 0.080,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 340, fadeStart: 240, maxLod: 3,
    maxPerChunk: 4, importance: 13, ore: null, collidable: true,
    note: 'One pale skeleton in an otherwise empty frame - the thing a lamp finds rather than a thing that glows.',
  }),
  // ==========================================================================
  // TWO SHAPE CLASSES THE KIT DOES NOT CONTAIN (ids 46-47). Item 3.2.
  //
  // THE PROBLEM, MEASURED. Over emitted instances, footprint-weighted, over
  // GENERATOR FAMILIES rather than rows, the deep six's most-alike pairs are
  // `terrace x canyon` 0.9668 and `spires x trenchWall` 0.9525 - exactly the
  // pairs whose signature rows share `generateCoralFan` and `generateCrystal`.
  // The same pairs measured over ROWS sit near the deep-six mean of 0.0801. Only
  // the generator-level metric sees it, and it is why no weight table can fix
  // it: `terraceVeil` IS a `coralFan` and `trenchWallSpine` IS a `crystalShard`,
  // at a different size.
  //
  // NEITHER ROW CARRIES `signatureBiome`, AND THAT IS NOT AN OVERSIGHT. All
  // twelve underwater biomes already have one, `tools/test-scatter.mjs` asserts
  // exactly twelve and rejects a second on one biome, and the field is
  // load-bearing outside placement - `render/passes/scatter.js` promotes exactly
  // those rows to BEACON lights. The mechanism for "a beacon that is not the
  // signature" already exists and is named: `RENDER.DEEP_BEACON_EXTRA`, which
  // both of these join. What makes them unmistakable is the SHAPE and the
  // one-biome mask, which is what item 3.2 is about.
  // ==========================================================================
  Object.freeze({
    id: 46, key: 'wallLattice', name: 'Silica Basket',
    generator: 'generateGlassLattice',
    // Cold white-violet. The biome brief gives Trench Wall "black-blue with thin
    // violet mineral seams" and an Avoid column of "bright garden flora or warm
    // vent carpet", so the one thing this may not be is warm.
    meshParams: { size: 2.6, rings: 5, struts: 11, color: MESH_PALETTE.CRYSTAL_CLEAR },
    biomes: bm(TRENCH_WALL), density: 1.05, cells: 10, maxPerCell: 1,
    // Trench Wall's placement slope is p50 0.593 with 73.8% under 0.80. A form
    // that hangs off the wall wants the steep part, and `align: 1.0` is what
    // makes it hang rather than stand.
    scale: [0.58, 1.55], stretch: [0.90, 1.40], slope: [0.32, 2.60], depth: [560, 1500],
    align: 1.0, tilt: 0.18, sink: 0.10,
    colony: { size: 152, coverage: 0.40, edge: 0.30 },
    sways: false, stiffness: 1, swayStrength: 0, twoSided: false,
    emissive: 0.9, emissiveColor: [0.60, 0.52, 1.00], fluoresces: false, algalFilm: 0,
    colorMul: [0.86, 0.88, 1.02], translucency: 0, thickness: 0.020,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 260, fadeStart: 180, maxLod: 2,
    maxPerChunk: 26, importance: 11, ore: null, collidable: true,
    note: 'A hollow woven basket - the only form in the game you can see through, so it cannot be mistaken for a spine.',
  }),
  Object.freeze({
    id: 47, key: 'terraceShelf', name: 'Shelf Sponge',
    generator: 'generateSpongeShelf',
    // "Layered Sponge Terraces", "pale translucent sponges", "huge sponge forms",
    // "luminous grottos beneath shelves" - four of Twilight Terraces' six
    // biome-brief columns describe this object. Its Avoid column is "glowcup
    // carpet, generic rocks, abyssal emptiness", and this is the POSITIVE
    // replacement item 3.1's glowcup cut needs: that cut removes a light, so what
    // replaces it has to be one, which is why this emits and `terraceStep` (item
    // 3.3, dark) does not.
    meshParams: { size: 3.4, plates: 5, color: MESH_PALETTE.SPONGE_PALE,
      marginColor: MESH_PALETTE.AMETHYST },
    // cells 13, not 8, and the reason is that `maxPerCell` was binding and the
    // density was doing nothing: at cells 8 the cell is 16 m and `density * 256
    // * 0.01` already exceeds 1, so every raise above ~0.39 was clipped by
    // `maxPerCell: 1` and delivered the same 97 instances. Smaller cells are the
    // lever when a type is capped rather than offered-limited.
    // 1.15 -> 1.50 IS STAGE 3.1'S REPLACEMENT HALF for the terraces' kit cut
    // (mushroomCap 0.55, glowPod 0.85): the luminous-margin shelf is the
    // biome's own exclusive emitter (4.6% of its flux at 1.15), so the light
    // removed from the wallpaper comes back on the signature form.
    // maxPerCell 1 -> 2 WITH the raise, because the census caught the raise
    // alone delivering ZERO new instances (n = 428 before AND after): at
    // density 1.15 the one-per-cell cap was already binding, exactly as the
    // cells note below records. Measured after both: n 428 -> 564 (x1.32),
    // flux share 4.62% -> 7.35%.
    biomes: bm(TERRACE), density: 1.50, cells: 13, maxPerCell: 2,
    scale: [0.80, 1.75], stretch: [0.85, 1.30], slope: [0, 0.44], depth: [140, 460],
    align: 0.40, tilt: 0.16, sink: 0.14,
    colony: { size: 186, coverage: 0.58, edge: 0.32 },
    sways: false, stiffness: 1, swayStrength: 0, twoSided: false,
    emissive: 1.1, emissiveColor: [0.72, 0.60, 1.00], fluoresces: false, algalFilm: 0,
    colorMul: [1.32, 1.30, 1.36], translucency: 0.55, thickness: 0.040,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 300, fadeStart: 205, maxLod: 3,
    maxPerChunk: 22, importance: 11, ore: null, collidable: true,
    note: 'Stacked lobed plates with luminous margins - the biome is named Layered Sponge Terraces and had no sponge.',
  }),
  Object.freeze({
    id: 48, key: 'trenchLedge', name: 'Pressure Ledge',
    generator: 'generateStratumSlab',
    // THE OTHER HALF OF THE canyonLedge SPLIT, AND THE CENSUS IS WHAT FORCED IT.
    // The ledge shipped as ONE ROW carried by Canyon Wall AND Trench Wall,
    // separated by a `biomeTint` - and a tint is a COLOUR while the vocabulary
    // cosine is over SHAPES, so it counted for nothing: `trenchWall x canyon`
    // went 0.0851 -> 0.4509 on the row-level footprint cosine, straight through
    // item 3.2's own acceptance of "below 0.40", broken by the item before it.
    // Two rows off ONE generator, differentiated by `opts.color`, bed count,
    // spread and a slope band, took it to 0.0721 - better than it began.
    //
    // It is also the better art. The biome brief gives Trench Wall "stress
    // fractures, ledges, hanging formations" in "black-blue with thin violet
    // mineral seams" against Canyon Wall's blockier "iron-red and violet rock",
    // and one row forced them to share a bed count and a spread as well as a
    // shape: this one is thinner-bedded and narrower.
    meshParams: { size: 4.6, beds: 7, spread: 0.48, color: MESH_PALETTE.BASALT_DARK },
    biomes: bm(TRENCH_WALL), density: 0.50, cells: 8, maxPerCell: 1,
    biomeTint: {
      // 1.27 and not 1.30: normalised to unit Rec709 luma this peaks at 1.585
      // against BIOME_TINT_CEIL's 1.5990, and 1.30 measured 1.615 - over the
      // ceiling, where a channel clips in silence and the bright half of the
      // variation stops existing. test-scatter section 5c is what caught it.
      [TRENCH_WALL]: [0.72, 0.78, 1.27],
    },
    scale: [1.5, 2.8], stretch: [0.84, 1.18], slope: [0.34, 2.40], depth: [540, 1560],
    align: 1.0, tilt: 0.16, sink: 0.28,
    colony: { size: 148, coverage: 0.34, edge: 0.26 },
    sways: false, stiffness: 1, swayStrength: 0, twoSided: false,
    emissive: 0, emissiveColor: [0, 0, 0], fluoresces: false, algalFilm: 1,
    colorMul: [1.58, 1.56, 1.72], translucency: 0, thickness: 0.080,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 340, fadeStart: 235, maxLod: 3,
    maxPerChunk: 16, importance: 12, ore: null, collidable: true,
    note: 'Thin black-blue shelves hang off the trench wall in front of the spines behind them.',
  }),
  // ==========================================================================
  // THE FRUITING CHAMPION (id 49). Item 3.4.
  //
  // The biome brief asks for "10-20% of mature giants carry fruit", and this row is
  // how that is authored DETERMINISTICALLY. The alternative - a per-instance hash
  // on kelpGiant deciding whether to draw fruit - cannot work: the mesh library
  // is baked per TYPE, so a per-instance decision would need two meshes under one
  // row, and the scatter pass issues one draw per (chunk x type). A separate row
  // at ~15% of the giant's density is the same statement in the system's own
  // terms, and it buys a separate scale and depth band as well.
  //
  // THE FRUIT IS BIOLUMINESCENT AND NOT FLUORESCENT (`fluoresces: false`), and
  // that is physics rather than taste: COASTAL_GREEN's blue daylight is at 1% by
  // 25.2 m, so at the 58 m this row starts at there is nothing left to pump a
  // fluorescent pigment with. A fluorescing fruit at this depth is switched off
  // by the water it lives in. Warm gold is also the ONLY warm thing in
  // COASTAL_GREEN, which is the whole reason it reads.
  // ==========================================================================
  Object.freeze({
    id: 49, key: 'kelpChampion', name: 'Fruiting Champion',
    generator: 'generateGiantKelp',
    // fruit 9 -> 18 in the 2026-08 fruit pass: at 9 the cluster was a handful
    // of pale dots at the 20-40 m a crown is seen from (measured on
    // the kelp-champion shot), and the mesh measures 1,769 vertices at
    // HIGH against the landmark band's 2,000, so the budget buys the rest of
    // the bunch. Mesh height with it is 32.93 m over 8 seeds (was 33.54 - the
    // tighter cluster radius more than paid for the extra berries), so the
    // tallest delivered plant is 32.93 x 1.22 x 1.14 = 45.8 m and depth[0] =
    // 48 still clears it.
    // 2026-08-18 emerald rebuild, round 3 sized by playtest: height 30 -> 50
    // under `surfaceCap`, blades 24, bands 5, crown 10, girth 2.0. Fruit 20
    // with fruitLo 0.68 - the playtest is explicit: "those fruits should be
    // in a cluster, closer to the top 1/3 of the plant" (an earlier draft
    // spread them from 0.45 and it read as strings of berries).
    meshParams: { blades: 24, height: 100.0, bands: 5, secondary: 2, fruit: 20,
      girth: 2.0, bladeWide: 1.3, fruitLo: 0.68, crown: 10,
      fruitColor: MESH_PALETTE.KELP_FRUIT },
    // density 0.52 and not the 0.14 that "15% of kelpGiant's density" implies,
    // because DENSITY IS NOT DELIVERED SHARE and the difference is the depth
    // band: this row starts 18 m deeper than the giant, so only the ~40% of the
    // forest past 58 m can carry it. At 0.14 it delivered 142 champions against
    // 4,958 giants - 2.9%, against the biome brief's "10-20% of mature giants carry
    // fruit". Author the delivered ratio, and check it on the census rather than
    // on the table. 0.24 -> 0.50 in the fruit pass, measured on the census:
    // 290 -> 602 champions against 1,768 giants, i.e. 16.4% -> 34% of mature
    // giants fruiting, plus 547 kelpBloom in the shallows the band cannot
    // reach (census-output/fruit-after.json against control-kelp.json, same
    // seed, 579-chunk sample). Past NOTES' 10-20% on purpose: the reference
    // frame this biome is authored against carries fruit on about every
    // second tall stalk.
    // Density 0.65 -> 0.35 in round 3: "not all plants have fruits. maybe
    // 1/3 of the plants" - the fruiting rows together now run ~1/3 of the
    // non-fruiting giant's density in every band.
    biomes: bm(KELP), density: 0.35, cells: 12, maxPerCell: 1,
    biomeTint: { [KELP]: HUE.kelpOlive },
    // THE SAME RULE AS kelpGiant, ONE BAND DEEPER - AND THE BAND WAS SET BY A
    // SCREENSHOT, NOT BY THE SPEC. It was `depth: [58, 130]` with a scale band
    // reaching 55.8 m, which satisfied every offline number and put ZERO
    // champions anywhere a diver arriving at the anchor could see: the anchor
    // floor is 43.1 m and the deepest ground within 120 m of it is 65.0 m, so a
    // 58 m band left a thin sliver and the frame had no fruit in it at all. The
    // fruit is the one thing this item exists to deliver, so the band comes up
    // to 48 m and the height comes down to match: local mesh 33.54 m against a
    // scale band topping out at 1.22 x 1.14 = 1.391 is 46.6 m, which `depth[0] =
    // 48` clears. That reaches 60.6% of the Kelp Forest's seabed and real ground
    // within a short swim of the arrival.
    //
    // THE BAND, THE HEIGHT AND THE ANCHOR MOVED IN THIS ONE COMMIT, which is the
    // rule kelpGiant's row states and the reason the 36.4% breach happened when
    // it was not followed.
    // `surfaceCap` supersedes the static breach arithmetic (see the cap
    // comment in the placement loop); the band comes up to 34 m so fruit
    // reaches the arrival bed, which is the whole reason this row exists.
    surfaceCap: 2.5,
    scale: [1.00, 1.16], stretch: [1.02, 1.14], slope: [0, 0.80], depth: [52, 190],
    align: 1.0, tilt: 0.04, sink: 0.16,
    // A wider, sparser colony than the giant's: a champion stands among giants,
    // not among other champions.
    colony: { size: 210, coverage: 0.42, edge: 0.40 },
    sways: true, stiffness: 0.05, swayStrength: 2.6, twoSided: true,
    // The fruit is bright enough to survive the green water, but not so bright
    // that the warm pigment crosses the AgX shoulder and turns white.
    // Emerald rebuild: 3.5 -> 1.6 with the bloom's cut (see its row) - the
    // new clear water stopped eating the glow, and a champion carries 22 pods.
    emissive: 1.6, emissiveColor: [1.00, 0.80, 0.24],
    fluoresces: false, algalFilm: 0.00,
    colorMul: [0.32, 0.45, 0.26], roughnessBias: 0.30, translucency: 0.30, thickness: 0.0050,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 320, fadeStart: 230, maxLod: 2, maxPerChunk: 28, importance: 9,
    ore: null, collidable: false,
    note: 'The tallest plant in the world, and the only warm light in the green.',
  }),
  // ==========================================================================
  // THE FIRST PLACE-ONLY ROW (id 50). world/places.js item "Grandmother Kelp".
  //
  // `density: 0` IS THE MECHANISM, NOT AN ERROR, and `placeOnly: true` is the
  // declaration test-scatter audits it against: the walk offers this type in
  // ZERO cells anywhere (kBase and kFrac are both 0), and every instance it
  // ever has is injected by placePropsForChunk below, seeded by the PLACE and
  // not by the camera. A place-only row with no place consuming it is dead
  // authored data and tools/test-scatter.mjs fails on exactly that.
  //
  // NO `signatureBiome`, deliberately: all twelve underwater biomes already
  // carry their signature, test-scatter asserts exactly twelve, and the field
  // is a LIGHT CLASS - it would promote this row to a BEACON. At 56 m in
  // COASTAL_GREEN (2.74 m green beam range) a 160 m beacon search is spent
  // light; the fruit rides the ordinary fill path like kelpChampion's.
  // ==========================================================================
  Object.freeze({
    id: 50, key: 'kelpColossus', name: 'Grandmother Kelp',
    generator: 'generateGiantKelp',
    // Basin phase: height 42 -> 84 (the eldest tree doubles with the forest)
    // under `surfaceCap` - the place rides the shared emission path, so the
    // static crown arithmetic this comment used to carry is superseded by
    // the per-instance clamp. Girth 2.3 / bladeWide 1.3 from the earlier
    // rounds (radius only, never height).
    meshParams: { blades: 22, height: 84.0, bands: 4, secondary: 2, fruit: 14,
      girth: 2.3, bladeWide: 1.3,
      fruitColor: MESH_PALETTE.KELP_FRUIT },
    biomes: bm(KELP), placeOnly: true, density: 0, cells: 12, maxPerCell: 1,
    surfaceCap: 2.5,
    scale: [0.98, 1.08], stretch: [1.00, 1.04], slope: [0, 0.80], depth: [40, 190],
    align: 1.0, tilt: 0.02, sink: 0.22,
    colony: null,
    sways: true, stiffness: 0.06, swayStrength: 2.8, twoSided: true,
    // 2026-08-18: colour unified with kelpBloom's deep orange (one organism,
    // one fruit) and raised 2.2 -> 3.5 - below the bloom's 5.0 because these
    // giants carry many more pods per plant.
    emissive: 2.0, emissiveColor: [1.00, 0.80, 0.24],
    fluoresces: false, algalFilm: 0.00,
    colorMul: [0.32, 0.45, 0.26], roughnessBias: 0.30, translucency: 0.30, thickness: 0.0050,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 260, fadeStart: 185, maxLod: 3, maxPerChunk: 3, importance: 13,
    ore: null, collidable: false,
    note: 'One authored elder kelp at the Grandmother Kelp place; the fruit lights a whole clearing.',
  }),
  // ==========================================================================
  // OSSUARY FLATS (ids 51-52). P4-C: the 15th biome (world/biomes.js id 14,
  // DESIGN/01 #18) and its Pale Ossuary landmark.
  //
  // THE SIGNATURE IS THE THIRTEENTH, and tools/test-scatter.mjs's exactly-N
  // assertion moved 12 -> 13 with it, in the same change. It is a BEACON by
  // the documented signatureBiome semantics (render/passes/scatter.js promotes
  // exactly the signature rows plus RENDER.DEEP_BEACON_EXTRA), and RESTRAINT
  // IS BUILT IN BY THE MATERIAL, not hoped for: the mesh is BONE/SEDIMENT,
  // whose slotEmissiveGate is 0.05, so the authored 2.0 delivers ~0.10 of
  // surface glow and a per-instance flux two orders under a crystal's - the
  // same construction as abyssRib, whose row records the measurement. At
  // 285-368 m the biome is ABOVE the aphotic edge (daylight is 1.0 to 319.8 m)
  // and the field must read as pale masses in twilight, not a lamp field.
  //
  // The rest of the biome's vocabulary is SHARED, per the brief: boneRib and
  // whaleFall gained OSSUARY in their masks at unchanged densities (their
  // rows carry the notes), so the bone family recurs from the Sand Plains'
  // dune ribs down - which DESIGN/01's landmark table authors as deliberate
  // foreshadowing ("First skeleton; foreshadows the Ossuary").
  // ==========================================================================
  Object.freeze({
    id: 51, key: 'ossuaryColossus', name: 'Ossuary Colossus', signatureBiome: OSSUARY,
    generator: 'generateWhaleFall',
    // 34 m at these parameters measures 44 x 12 x 39 m over 8 seeds (rib splay
    // and lateral bend included), 1,608 vertices at HIGH - inside the landmark
    // band. The scale band tops at 1.10 x 1.12, so a delivered ribcage spans
    // roughly 25-37 m of spine: DESIGN #18's "ribcages 30-40 m long".
    meshParams: { size: 34, vertebrae: 15, ribPairs: 8, color: MESH_PALETTE.BONE,
      matColor: MESH_PALETTE.CARBONATE, wormColor: MESH_PALETTE.TUBEROD },
    // density 0.50, raised from a first cut of 0.20 on the delivered frames:
    // at 0.20 the whole 10.5 ha biome carried ~20 skeletons and the anchor
    // frame contained NO bone at all - the biome read as canyon boundary kit
    // with an occasional rib. The biome is tiny (0.65% of terrace's former
    // area), so even at 0.50 the world total is double digits; DESIGN #18's
    // plain is DEFINED by skeletons rising out of it, and this is its only
    // exclusive carrier.
    biomes: bm(OSSUARY), density: 0.50, cells: 12, maxPerCell: 1,
    scale: [0.72, 1.10], stretch: [0.90, 1.12], slope: [0, 0.44], depth: [280, 380],
    align: 0.75, tilt: 0.08, sink: 0.12,
    // Colony 120 m at the 0.50 coverage ceiling, NOT the usual signature
    // 200-400 m: this biome is itself a set of 30-100 m basin pockets, so a
    // 260 m colony field gated whole pockets out at once (measured: the
    // anchor pocket delivered ONE skeleton at density 0.5). The negative
    // space the signature rule wants is supplied by the biome's own rarity;
    // the colony's remaining job is variation inside a pocket.
    colony: { size: 120, coverage: 0.50, edge: 0.30 },
    sways: false, stiffness: 1, swayStrength: 0, twoSided: false,
    emissive: 2.0, emissiveColor: [0.78, 0.86, 1.00],
    fluoresces: false, algalFilm: 0.35,
    colorMul: [0.60, 0.58, 0.54], translucency: 0.25, thickness: 0.080,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 320, fadeStart: 225, maxLod: 3,
    maxPerChunk: 6, importance: 12, ore: null, collidable: true,
    note: 'Articulated leviathan skeletons rise from the pale gravel; the dread is that there are so many.',
  }),
  Object.freeze({
    /**
     * THE PALE OSSUARY SKULL - place-only, consumed by world/places.js
     * ('paleOssuary' prop of the Pale Ossuary place), on the kelpColossus
     * pattern: `density: 0` is the mechanism, `placeOnly: true` is the
     * declaration test-scatter audits, and every instance is injected by
     * placePropsForChunk seeded by the PLACE.
     *
     * `twoSided: true` IS WHAT MAKES IT ENTERABLE. The cranium is one open
     * shell with the sockets and jaw arch punched through it (see
     * generateSkull); drawn with culling off, the interior is the same
     * surface back-facing, and fs_scatter's front_facing normal flip shades
     * it correctly under the lamp. A closed solid here would be a black
     * window into nothing.
     *
     * COLLISION IS AN AUTHORED CAPSULE SHELL, UNDER-BLOCKING BY DESIGN: wall,
     * roof and rostrum capsules in scatter_collision.js's PROXY_CAPSULES stop
     * a swimmer passing through the cranium sides while the sockets and the
     * jaw arch stay open. The capsules bulge ~1.5 m inside the visual shell
     * (a capsule cannot be a curved wall), which errs exactly the way that
     * file's header demands - you can graze "into" the bone visually before
     * the proxy stops you, and nothing invisible blocks the openings.
     *
     * NO `signatureBiome` - the colossus above already carries it, and
     * test-scatter rejects a second on one biome. NO emissive: DESIGN calls
     * this the central dread image of the midnight band, and it is the thing
     * the lamp FINDS.
     */
    id: 52, key: 'paleOssuary', name: 'The Pale Ossuary',
    generator: 'generateSkull',
    // 26 m at HIGH measures 26.4 x 14.5 x 26.9 m over 8 seeds, 1,409 vertices:
    // DESIGN's "26 m long, 14 m tall, enterable" to the metre.
    meshParams: { size: 26 },
    biomes: bm(OSSUARY), placeOnly: true, density: 0, cells: 8, maxPerCell: 1,
    scale: [1.00, 1.00], stretch: [1.00, 1.00], slope: [0, 0.60], depth: [200, 500],
    align: 0.30, tilt: 0.03, sink: 0.15,
    colony: null,
    sways: false, stiffness: 1, swayStrength: 0, twoSided: true,
    emissive: 0, emissiveColor: [0, 0, 0],
    fluoresces: false, algalFilm: 0.35,
    colorMul: [0.58, 0.56, 0.52], translucency: 0.30, thickness: 0.050,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 340, fadeStart: 240, maxLod: 3, maxPerChunk: 2, importance: 13,
    ore: null, collidable: true,
    note: 'The intact skull of a 90 m animal. Swim in through an eye socket; the chamber answers a lamp.',
  }),
  // ==========================================================================
  // THE BLOOM KELP (id 53). 2026-08 fruit pass, appended - ids are placement
  // salts.
  //
  // FRUIT WHERE THE GREEN WATER IS. The champion's band starts at 48 m
  // because its 45.8 m plant needs the water over it (kelpGiant's row states
  // the rule), so the 20-47 m half of the forest - the half shallow enough
  // that COASTAL GREEN wins the column and the water is the murky green the
  // biome is authored against - carried NO fruit at all: measured, zero
  // fruiting instances within 39 m of the kelp anchor (floor -43 m), and the
  // delivered shallow bed was stalks and nothing warm. This row is the same
  // organism one size down, banded to exactly the gap the champion cannot
  // enter. The mesh is 21.13 m local at these parameters (measured over 8
  // seeds, 1,202 vertices at HIGH), the scale x stretch top is 1.12 x 1.06,
  // so the tallest delivered plant is 25.1 m and depth[0] = 27 clears it -
  // the same rule as the champion's, one band up.
  //
  // NO `signatureBiome`: kelpGiant already carries KELP's, test-scatter
  // asserts exactly thirteen, and the field is a LIGHT CLASS. The fruit
  // rides the ordinary fill path like the champion's.
  // ==========================================================================
  Object.freeze({
    id: 53, key: 'kelpBloom', name: 'Bloom Kelp',
    generator: 'generateGiantKelp',
    // 2026-08-18 emerald rebuild, round 3: height 20 -> 30 under
    // `surfaceCap` (the shallow bed's fruiting plant, sized to its water by
    // the cap), blades 18, bands 4, crown 6, girth 1.6. Fruit 14 clustered
    // in the top third (fruitLo 0.68) per the playtest; density 0.35 for
    // the ~1/3-fruiting ratio (see kelpChampion's note).
    meshParams: { blades: 18, height: 55.0, bands: 4, secondary: 1, fruit: 14,
      girth: 1.6, bladeWide: 1.25, fruitLo: 0.68, crown: 6,
      fruitColor: MESH_PALETTE.KELP_FRUIT },
    biomes: bm(KELP), density: 0.35, cells: 14, maxPerCell: 1,
    biomeTint: { [KELP]: HUE.kelpOlive },
    // `surfaceCap` supersedes the static breach arithmetic (see the cap
    // comment in the placement loop).
    surfaceCap: 3.0,
    scale: [0.95, 1.12], stretch: [1.00, 1.06], slope: [0, 0.80], depth: [50, 110],
    align: 1.0, tilt: 0.06, sink: 0.12,
    // Among the stalks rather than among itself: the champion's reasoning,
    // one size down.
    colony: { size: 150, coverage: 0.45, edge: 0.40 },
    sways: true, stiffness: 0.06, swayStrength: 1.8, twoSided: true,
    // 2026-08-18 drastic pass: 2.2 amber -> 5.0 deep orange - authored
    // against the old murky COASTAL_GREEN, where at 2.2 the fruit vanished
    // into the veil. The emerald rebuild REVERSED that in the same day: in
    // the new clear KELP_EMERALD water 5.0 delivered giant white-lime
    // popcorn (the AgX shoulder - a brighter object is a whiter one), so
    // 2.0 restores the amber-orange the reference shows.
    emissive: 2.0, emissiveColor: [1.00, 0.80, 0.24],
    fluoresces: false, algalFilm: 0.00,
    colorMul: [0.42, 0.55, 0.34], roughnessBias: 0.30, translucency: 0.30, thickness: 0.0040,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 220, fadeStart: 150, maxLod: 2, maxPerChunk: 40, importance: 9,
    ore: null, collidable: false,
    note: 'Fruit in the green shallows: the warm points the 27-60 m band was missing.',
  }),
  // RARE DEEP CANOPY. The measured high-detail mesh is about 44.4 m tall;
  // the scale/stretch ceiling is 1.24 x 1.04 = 1.290, so the tallest delivered
  // crown is about 57.3 m and the 58 m shallow edge stays below the surface.
  // The low density and landmark cap keep this from replacing the ordinary
  // giant forest.
  Object.freeze({
    id: 54, key: 'kelpCanopy', name: 'Deep Canopy Kelp',
    generator: 'generateGiantKelp',
    // 2026-08-18 emerald rebuild, round 3: height 42 -> 55 under
    // `surfaceCap`, blades 20, bands 5, crown 10, girth 2.1; fruit 12 in
    // the top third (fruitLo 0.70), density 0.28 for the ~1/3-fruiting
    // ratio. The deep half of the forest is where the reference's
    // out-of-frame trunks live; at the old 0.16 the canopy was a rarity
    // rather than a ceiling.
    meshParams: { blades: 20, height: 110.0, bands: 5, secondary: 2, fruit: 12,
      girth: 2.1, bladeWide: 1.3, fruitLo: 0.70, crown: 10,
      fruitColor: MESH_PALETTE.KELP_FRUIT },
    biomes: bm(KELP), density: 0.28, cells: 10, maxPerCell: 1,
    biomeTint: { [KELP]: HUE.kelpOlive },
    // `surfaceCap` supersedes the static breach arithmetic (see the cap
    // comment in the placement loop).
    surfaceCap: 2.5,
    scale: [1.00, 1.12], stretch: [1.00, 1.04], slope: [0, 0.80], depth: [64, 190],
    align: 1.0, tilt: 0.04, sink: 0.18,
    colony: { size: 240, coverage: 0.36, edge: 0.34 },
    sways: true, stiffness: 0.05, swayStrength: 2.4, twoSided: true,
    // Emerald rebuild: colour unified with the bloom's deep orange (one
    // organism, one fruit) and 2.2 -> 1.6 with the family-wide cut.
    emissive: 1.6, emissiveColor: [1.00, 0.80, 0.24],
    fluoresces: false, algalFilm: 0.00,
    colorMul: [0.32, 0.45, 0.26], roughnessBias: 0.30, translucency: 0.30, thickness: 0.0050,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 260, fadeStart: 180, maxLod: 2, maxPerChunk: 18, importance: 10,
    ore: null, collidable: false,
    note: 'A sparse deep canopy that closes the bright water above mature kelp.',
  }),
  // ==========================================================================
  // THE CRIMSON MEADOW FAMILY (ids 55-58). Appended 2026-08-18 with biome 15 -
  // ids are placement salts, so these four go at the end whatever their biome.
  //
  // The biome is a shallow (8-28 m) daylight plain in REEF_TURQUOISE water:
  // pale sand, a crimson grass carpet, and flat-capped stone pillars rising
  // out of it. The colour strategy is the P3 coral lesson applied to a field
  // instead of a head: red survives underwater only as fluorescent
  // REFLECTANCE (fluorescentReflectance cases 56/57 cut G/B and never raise
  // R), never as brightness - a brighter object is a whiter one. The pillar
  // and the bedding are deliberately NOT part of that: they are the pale
  // mineral ground the crimson reads against.
  // ==========================================================================
  Object.freeze({
    id: 55, key: 'meadowPillar', name: 'Meadow Pillar', signatureBiome: MEADOW,
    generator: 'generateMeadowPillar',
    // 17 m with a 6.0 m cap is the reference silhouette: a narrow stem under
    // a flared flat-topped cap with a crimson crown at the rim. The scale
    // band tops at 1.7 x 1.25, so the tallest delivered pillar is ~36 m -
    // and at the FINAL siting (8-28 m water, shallower than the 12-46 m
    // band this height was first authored against) the census measures
    // 48.31% of 89 instances breaching the surface (AABB upper bound),
    // still inside the 0.5% submerged-biome waterline gate because the
    // biome total is carried by 60k+ bloodgrass. A cap standing out of the
    // lagoon as a sea stack is the reef-pillar precedent (reefPillar
    // breaches 7.4% of 583) and reads as one from the beach - but it also
    // means many caps are ABOVE the waterline seen from below. KNOWN
    // FOLLOW-UP (adversarial review, 2026-08-18): if the underwater vista
    // needs more submerged caps, the lever is height ~10 with scale
    // [0.7, 1.3] and depth floor 14, re-measured - not density.
    meshParams: { height: 17, capRadius: 6.0, beds: 4, crown: 18 },
    // Signature contract: exclusive mask, importance >= 8, viewDistance >= 180,
    // colony coverage <= 0.50 (test-scatter asserts all four). NON-EMISSIVE
    // AND NON-FLUORESCING ON PURPOSE: `signatureBiome` promotes this row to a
    // BEACON light in render/passes/scatter.js, and that promotion is INERT
    // here because the baked emitted flux peak is 0 - a shallow daylight biome
    // needs no lamp, and the fourteenth signature must not become the one
    // that lights its own noon. Do not "fix" the peak-0 beacon.
    biomes: bm(MEADOW), density: 1.0, cells: 12, maxPerCell: 1,
    scale: [0.8, 1.7], stretch: [0.9, 1.25], slope: [0, 0.30], depth: [6, 32],
    align: 0.12, tilt: 0.05, sink: 0.5,
    colony: { size: 240, coverage: 0.48, edge: 0.35 },
    sways: false, stiffness: 1, swayStrength: 0, twoSided: false,
    emissive: 0, emissiveColor: [0, 0, 0],
    fluoresces: false, algalFilm: 0.3,
    // Warm colorMul: the pale rock delivered blue-white under the column even
    // after the palette warmed - the medium halves authored warmth, so the
    // calibration pushes the ratio, not the energy (mean ~1.0).
    colorMul: [1.08, 0.99, 0.84], translucency: 0, thickness: 0.08,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 340, fadeStart: 240, maxLod: 3,
    maxPerChunk: 10, importance: 12, ore: null, collidable: true,
    note: 'Flat-capped stone pillars over the crimson carpet: the meadow skyline, lit by nothing but the day.',
  }),
  Object.freeze({
    id: 56, key: 'bloodgrass', name: 'Blood Grass',
    generator: 'generateBloodGrass',
    meshParams: { blades: 58, height: 0.5 },
    // The carpet: seagrass-class caps, one biome. The red is carried by
    // fluorescentReflectance case 56 (crimson, G/B cut) on the BLOOD_GRASS
    // palette, NOT by the emission below - see the pigment note.
    // Density 55 / coverage 0.94: the first delivered frames (34 / 0.80 with
    // 60 m colonies) put the ANCHOR itself inside a colony gap - bare sand
    // straight down and scattered wisps around, against a reference that is a
    // wall-to-wall field. The carpet is now near-continuous with soft sand
    // lanes at colony edges only.
    // slope to 0.9: the placement sampler reads 1.187x the exact slope, and
    // at 0.32 every dune flank in the plain rejected the carpet, at 0.55 the
    // dune flanks still photographed bald (a 4 m dune's flank reads 0.47-0.71
    // through the bias). The biome record's own [0, 0.60] slope band bounds
    // where the biome EXISTS; inside it, the carpet climbs everything.
    // density 82 / cap 4400, backed off from a 95 / 5000 trial: that arm
    // measured worst-case chunk generation 16.7 ms against the 14 ms gate,
    // and its boundary chunks capped hard enough (n >= 0.98 cap) to trip the
    // Z-halves imbalance guard on mask geography. 82 keeps the delivered
    // carpet the trial photographed; interior chunks still cap uniformly.
    biomes: bm(MEADOW), density: 82, cells: 50, maxPerCell: 4,
    scale: [1.0, 1.5], stretch: [0.8, 1.3], slope: [0, 0.9], depth: [4, 32],
    align: 0.95, tilt: 0.1, sink: 0.05,
    // 34 m colonies: at 90 m a 6% gap is a 60 m bald patch and the anchor sat
    // in one (photographed twice). Small colonies keep the sand lanes at the
    // reference's scale - a few metres, never a clearing.
    colony: { size: 34, coverage: 0.96, edge: 0.25 },
    sways: true, stiffness: 0.15, swayStrength: 0.30, twoSided: true,
    // EMISSIVE 0.35, NONZERO ONLY FOR THE FLUORESCENCE AUDIT: test-scatter
    // rejects `fluoresces: true` with emissive 0 ("a switch with nothing
    // behind it" - fluorescence is EXCITED light and must put SOME
    // long-wavelength energy back). Every larger value was tried and read
    // WORSE: 2.2 and 1.3 both clipped to bubble-gum pink wherever the
    // histogram exposure exceeded ~2.5 (the "a brighter object is a whiter
    // one" trap, measured at three emission levels), and 1.8 clipped at the
    // bright site too. The red is the REFLECTANCE's job
    // (fluorescentReflectance case 56); the emission is a pilot light.
    // B < G in the colour for the same reason as the palette: the column
    // amplifies delivered blue 2-5x against red. Being fluorescent also
    // keeps the row OUT of the fill-light class (that promotion takes
    // non-fluorescing emitters only).
    emissive: 0.35, emissiveColor: [1.00, 0.20, 0.01],
    fluoresces: true, algalFilm: 0,
    // translucency 0.35, not the seagrass 1.0: a fully translucent blade
    // transmits the BLUE water light and the delivered carpet read neon pink
    // (measured on the 2.2-emissive frames). The reference blades are near
    // opaque; the red must come off the front face.
    colorMul: [1.00, 1.00, 1.00], translucency: 0.35, thickness: 0.0020,
    // viewDistance 142: ring 0 ends at 160 and the pass rescans 16 m late,
    // so 144 is the ceiling for a maxLod-0 type (test-scatter derives it).
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 142, fadeStart: 96,
    maxLod: 0, maxPerChunk: 4400, importance: 2, ore: null, collidable: false,
    note: 'The crimson carpet the biome is named for. Red as pigment, not as light.',
  }),
  Object.freeze({
    id: 57, key: 'crimsonPlume', name: 'Crimson Plume',
    generator: 'generateBloodGrass',
    // Same generator, second row: taller, sparser, MAGENTA - the documented
    // two-rows-off-one-generator pattern (see canyonLedge), differentiated by
    // opts.color and by fluorescentReflectance case 57.
    meshParams: { blades: 8, height: 1.1, color: MESH_PALETTE.MEADOW_PLUME },
    biomes: bm(MEADOW), density: 0.7, cells: 25, maxPerCell: 2,
    scale: [0.8, 1.3], stretch: [0.9, 1.3], slope: [0, 0.30], depth: [4, 32],
    align: 0.95, tilt: 0.12, sink: 0.05,
    colony: { size: 40, coverage: 0.35, edge: 0.5 },
    sways: true, stiffness: 0.18, swayStrength: 0.28, twoSided: true,
    // Spec-authored 0, raised for the same switch-audit reason as bloodgrass
    // (the WHY lives on that row).
    emissive: 0.30, emissiveColor: [0.92, 0.10, 0.70],
    fluoresces: true, algalFilm: 0,
    colorMul: [1, 1, 1], translucency: 0.35, thickness: 0.0022,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 90, fadeStart: 60,
    maxLod: 0, maxPerChunk: 260, importance: 2, ore: null, collidable: false,
    note: 'Magenta accent tufts standing a head above the carpet: the meadow second hue.',
  }),
  Object.freeze({
    id: 58, key: 'meadowStrata', name: 'Meadow Bedding',
    generator: 'generateStratumSlab',
    // The stratum-slab family's fourth biome (shelf/canyon/terrace/trench own
    // the others): pale MEADOW_ROCK beds, low and half-buried, so the flats
    // between pillars carry mineral ground and not only grass.
    meshParams: { size: 5.4, beds: 5, spread: 0.70, color: MESH_PALETTE.MEADOW_ROCK },
    biomes: bm(MEADOW), density: 0.30, cells: 8, maxPerCell: 1,
    // slope band starts at 0.04: bedding weathers out where the plain
    // breaks, not on dead-flat sand. The 0.60 ceiling matches the meadow
    // record's own slope band, so the bedding follows the biome onto its
    // dune flanks.
    scale: [1.1, 2.2], stretch: [0.85, 1.1], slope: [0.04, 0.60], depth: [6, 34],
    align: 0.90, tilt: 0.08, sink: 0.40,
    colony: { size: 180, coverage: 0.40, edge: 0.30 },
    sways: false, stiffness: 1, swayStrength: 0, twoSided: false,
    emissive: 0, emissiveColor: [0, 0, 0],
    fluoresces: false, algalFilm: 1,
    colorMul: [1.08, 0.99, 0.84], translucency: 0, thickness: 0.08,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 300, fadeStart: 210, maxLod: 3,
    maxPerChunk: 10, importance: 10, ore: null, collidable: true,
    note: 'Pale low outcrop ledges: the mineral counterweight to the crimson carpet.',
  }),
  // ==========================================================================
  // THE BULB GROVE FAMILY (ids 59-61). Appended 2026-08-18 with biome 16 -
  // ids are placement salts, so these go at the end whatever their biome.
  //
  // The biome, from its art-direction reference: big spiky purple pom
  // bulbs on pale trunks over white sand in turquoise water, studded with
  // small glowing blue fruits, with teal ground poms between them. The
  // colour strategy INVERTS the meadow's problem: purple is the hue the
  // water column is kind to, so the bulbs are plain blue-dominant
  // REFLECTANCE (MESH_PALETTE.BULB_PURPLE, no fluorescence needed), and
  // only the fruit emits - ice-blue, on the EMISSIVE slot, like the giant
  // kelp's crown berries.
  // ==========================================================================
  Object.freeze({
    id: 59, key: 'bulbTree', name: 'Bulb Tree', signatureBiome: BULB,
    generator: 'generateBulbTree',
    // 11 m, 3 trunks, secondary crown: the reference silhouette is a
    // paired-crown tree 2-4 divers tall on a stem ~0.6 of the bulb's own
    // diameter. Scale x stretch tops at 1.18 x 1.08 = 14.3 m of delivered
    // tree, and depth[0] = 17 keeps the tallest fur tip 2.7 m under the
    // surface.
    meshParams: { height: 11, trunks: 3, fruit: 20, secondary: 0 },
    // Signature contract: exclusive mask, importance >= 8, viewDistance
    // >= 180, colony coverage <= 0.50 (test-scatter asserts all four). The
    // fruit flux is REAL (unlike meadowPillar's deliberate peak-0): the
    // grove's 17-36 m spans dusk-lit water, and the beacon promotion is what
    // makes the blue berries carry at night.
    biomes: bm(BULB), density: 3.6, cells: 12, maxPerCell: 1,
    scale: [0.72, 1.18], stretch: [0.95, 1.08], slope: [0, 0.40], depth: [17, 40],
    align: 0.15, tilt: 0.04, sink: 0.25,
    colony: { size: 210, coverage: 0.50, edge: 0.35 },
    // twoSided: the fur is flat-triangle needles (see generateBulbTree) and
    // culling them halves the pom from every angle.
    sways: true, stiffness: 0.55, swayStrength: 0.30, twoSided: true,
    // The emission ladder so nobody re-walks it: 5.5 clipped to white
    // hexagons (round 1), 2.8 with the berries buried at 0.92R was invisible
    // in daylight (round 2). 4.5 with the berries seated proud at 0.98R and
    // a deeper cyan albedo is the legible-but-saturated middle.
    emissive: 4.5, emissiveColor: [0.40, 0.75, 1.00],
    fluoresces: false, algalFilm: 0,
    colorMul: [1.00, 1.00, 1.00], translucency: 0, thickness: 0.05,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 300, fadeStart: 210, maxLod: 3,
    maxPerChunk: 12, importance: 12, ore: null, collidable: true,
    note: 'The spiky purple pom trees the grove is named for, berries lit ice-blue.',
  }),
  Object.freeze({
    id: 60, key: 'bulbSapling', name: 'Bulb Sapling',
    generator: 'generateBulbTree',
    // Same organism one size down, single trunk, no companion crown: the
    // mid-ground layer between the 13 m landmarks and the ground poms.
    meshParams: { height: 3.2, trunks: 1, fruit: 6, secondary: 0, spikes: 150 },
    biomes: bm(BULB), density: 2.6, cells: 18, maxPerCell: 2,
    scale: [0.80, 1.40], stretch: [0.95, 1.10], slope: [0, 0.45], depth: [15, 40],
    align: 0.30, tilt: 0.08, sink: 0.15,
    colony: { size: 120, coverage: 0.50, edge: 0.40 },
    sways: true, stiffness: 0.45, swayStrength: 0.22, twoSided: true,
    emissive: 2.2, emissiveColor: [0.40, 0.75, 1.00],
    fluoresces: false, algalFilm: 0,
    colorMul: [1.00, 1.00, 1.00], translucency: 0, thickness: 0.05,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 190, fadeStart: 130, maxLod: 2,
    maxPerChunk: 36, importance: 6, ore: null, collidable: false,
    note: 'Single-trunk bulb saplings: the grove mid-storey.',
  }),
  Object.freeze({
    id: 61, key: 'pomPuff', name: 'Pom Puff',
    generator: 'generateBulbTree',
    // The trunkless teal ground poms of the reference foreground, via the
    // generator's `ground` mode - the documented rows-off-one-generator
    // pattern, differentiated by opts colour and mode. THE COLOURS LIVE
    // HERE, in the shipped meshParams, not only in the test registry entry:
    // the first build authored them registry-only and the delivered poms
    // were BULB_PURPLE - the registry-drift trap, in the new-row direction.
    meshParams: { height: 1.1, ground: 1, fruit: 4, spikes: 130,
      color: MESH_PALETTE.POM_TEAL, deepColor: MESH_PALETTE.POM_TEAL,
      tipColor: MESH_PALETTE.POM_TEAL_TIP },
    biomes: bm(BULB), density: 5.5, cells: 25, maxPerCell: 2,
    scale: [0.70, 1.60], stretch: [0.90, 1.15], slope: [0, 0.50], depth: [13, 42],
    align: 0.80, tilt: 0.10, sink: 0.12,
    colony: { size: 60, coverage: 0.45, edge: 0.40 },
    sways: true, stiffness: 0.30, swayStrength: 0.10, twoSided: true,
    emissive: 1.5, emissiveColor: [0.40, 0.75, 1.00],
    fluoresces: false, algalFilm: 0,
    colorMul: [1.00, 1.00, 1.00], translucency: 0, thickness: 0.04,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 130, fadeStart: 85, maxLod: 1,
    maxPerChunk: 140, importance: 3, ore: null, collidable: false,
    note: 'Small teal spiky poms on the sand between the purple trees.',
  }),
  // ==========================================================================
  // THE PLATTER FOREST FAMILY (ids 62-65). Appended 2026-08-18 with biome 17 -
  // ids are placement salts, so these go at the end whatever their biome.
  //
  // The biome, from its art-direction reference: tall encrusted columns
  // carrying stacked horizontal platters in luminous emerald water, warm
  // light under the platter rims, pink ring-corals, olive tufts and rubble
  // on the sand. TWO WARM ACCENTS, TWO EMISSIVE ROWS: a row carries exactly
  // one emission colour (pass/scatter.wgsl multiplies scatter.emissive.rgb
  // by a scalar mask), so the orange rims live on the spire rows and the
  // pink glow on ringHalo - splitting the kit is the mechanism, not a
  // styling choice. Reflectances are authored for PLATTER_TEAL's emerald key
  // (green daylight ~7x blue, red ~0), which is why the family's albedos are
  // olive/sage rather than the reference's screen colours: the COLUMN is
  // part of the pigment, the BULB_PURPLE lesson one biome over.
  // ==========================================================================
  Object.freeze({
    id: 62, key: 'platterSpire', name: 'Platter Spire', signatureBiome: PLATTER,
    generator: 'generatePlatterSpire',
    // 46 m, 4 pads (2026-08-18 playtest rework: "the platters need to be
    // much bigger ... so we can drive our vessel between the big platters").
    // Crown pads run 26-31 m across before scale; vertical gaps are an even
    // ~8 m of clear water by construction (0.175 H spacing minus pad
    // thickness; see the generator), 11 m on the largest instances - the
    // vessel's ~3 m hull height flies between them. Scale x stretch tops at
    // 1.25 x 1.10 = 63 m of delivered spire on a floor no shallower than
    // 88 m, so the tallest crown still holds ~25 m of water over it.
    meshParams: { height: 46, platters: 4 },
    // Mesh-local reach for the chunk-AABB pad: crown pads span ~0.34 H
    // laterally plus rim modulation and tilt; the crown hub tops the trunk.
    boundsPad: [21, 48],
    // Signature contract: exclusive mask, importance >= 8, viewDistance
    // >= 180, colony coverage <= 0.50 (test-scatter asserts all four). The
    // rim flux is real: the beacon promotion is what keeps the forest's
    // warm underlights carrying at dusk and at the band's 100 m twilight.
    // Spacing widened with the pad size-up: pads 30 m across need stands,
    // not thickets, for the fly-through lanes to exist.
    // Density 2.6 (review: "spacing wide... reads as a mushroom meadow, not
    // a monumental forest"): overlapping canopies are the reference.
    biomes: bm(PLATTER), density: 2.6, cells: 12, maxPerCell: 1,
    scale: [0.78, 1.25], stretch: [0.95, 1.10], slope: [0, 0.50], depth: [84, 132],
    // Near-vertical always: a 34 m column at align 0.5 on a dune flank would
    // lean 15 degrees and read fallen. sink 0.9 - the trunk already starts
    // 1.5 m under its own origin, and the extra burial seats the footing on
    // the dune-scale relief.
    align: 0.08, tilt: 0.03, sink: 0.9,
    colony: { size: 180, coverage: 0.45, edge: 0.35 },
    sways: false, stiffness: 0, swayStrength: 0, twoSided: false,
    // Warm orange, the platter underside tissue. The emission ladder so
    // nobody re-walks it: 3.2 on the first frames blew every underside to
    // a white-yellow saucer (the AgX brighter-is-whiter trap, on a glow
    // area far larger than any berry); 1.1 with the band narrowed to the
    // outer 30% of the underside is the legible-but-orange middle.
    // The ladder, so nobody re-walks it: 3.2 blew the undersides to white
    // saucers; 1.1 and 0.85 STILL clipped, because a 100 m frame meters at
    // 7-10x exposure and even 0.85 lands ~20x over the scene's own
    // radiance. 0.30 is authored against the DELIVERED frame: a warm rim
    // that reads orange after the meter, day and night.
    // ...and 0.30 STILL delivered cream day and chartreuse at night
    // (adversarial review); 0.16 at a deeper hue is where the delivered rim
    // finally reads orange through the meter.
    emissive: 0.16, emissiveColor: [1.00, 0.30, 0.05],
    fluoresces: false, algalFilm: 0.10,
    colorMul: [1.00, 1.00, 1.00], translucency: 0, thickness: 0.05,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 340, fadeStart: 250, maxLod: 3,
    maxPerChunk: 6, importance: 12, ore: null, collidable: true,
    note: 'The stacked-platter columns the forest is named for, rims lit warm orange.',
  }),
  Object.freeze({
    id: 63, key: 'platterYoung', name: 'Young Platter Column',
    generator: 'generatePlatterSpire',
    // The same organism one size down: 18 m, three pads, no rim rings -
    // the mid-storey between the 46 m landmarks and the floor kit.
    meshParams: { height: 18, platters: 3 },
    boundsPad: [7, 19],
    biomes: bm(PLATTER), density: 2.2, cells: 14, maxPerCell: 1,
    scale: [0.70, 1.35], stretch: [0.92, 1.12], slope: [0, 0.55], depth: [82, 134],
    align: 0.15, tilt: 0.05, sink: 0.6,
    colony: { size: 110, coverage: 0.50, edge: 0.40 },
    sways: false, stiffness: 0, swayStrength: 0, twoSided: false,
    emissive: 0.13, emissiveColor: [1.00, 0.30, 0.05],
    fluoresces: false, algalFilm: 0.10,
    colorMul: [1.00, 1.00, 1.00], translucency: 0, thickness: 0.05,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 230, fadeStart: 160, maxLod: 2,
    maxPerChunk: 10, importance: 6, ore: null, collidable: true,
    note: 'Young platter columns: the forest mid-storey.',
  }),
  Object.freeze({
    id: 64, key: 'ringHalo', name: 'Ring Halo',
    generator: 'generateRingHalo',
    // The pink glowing rings of the reference, on their own row because the
    // spire's one emission colour is spent on orange (see the family header).
    // Height 1.2 and emission 1.2, both down from the first landing (1.6 /
    // 3.0): the delivered clusters were white balloon animals - the pink
    // must survive the glow (brighter is whiter), and the reference rings
    // are small thin hoops.
    meshParams: { height: 1.2 },
    biomes: bm(PLATTER), density: 2.4, cells: 20, maxPerCell: 2,
    scale: [0.60, 1.30], stretch: [0.92, 1.12], slope: [0, 0.50], depth: [82, 134],
    // align 0.45 / tilt 0.06 (was 0.70/0.10): the review caught a cluster
    // tipped into the ground with its stub piercing a ring.
    align: 0.45, tilt: 0.06, sink: 0.10,
    colony: { size: 70, coverage: 0.45, edge: 0.40 },
    sways: true, stiffness: 0.55, swayStrength: 0.08, twoSided: false,
    // 0.9: the review read 0.55 as matte and unlit - the rings are SMALL,
    // so a hot core is legible where the platters' acreage was not.
    emissive: 0.9, emissiveColor: [1.00, 0.35, 0.58],
    fluoresces: false, algalFilm: 0,
    colorMul: [1.00, 1.00, 1.00], translucency: 0, thickness: 0.04,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 150, fadeStart: 100, maxLod: 1,
    maxPerChunk: 40, importance: 4, ore: null, collidable: false,
    note: 'Upright pink glow-rings on the forest floor.',
  }),
  Object.freeze({
    id: 65, key: 'rustTuft', name: 'Rust Tuft',
    generator: 'generateBloodGrass',
    // The olive-brown turf patches between the columns, off the blood-grass
    // generator with the forest's own colour - the rows-off-one-generator
    // pattern, and THE COLOURS LIVE HERE in the shipped meshParams (the
    // pomPuff registry-drift lesson).
    // Height 0.45 / density 6, both cut from the first landing (0.7 / 16):
    // the delivered floor was a bright green wheat lawn that hid the sand
    // and out-shouted the columns. Patchy and SHORT is the reference.
    meshParams: { height: 0.45, blades: 24, color: MESH_PALETTE.RUST_TUFT },
    biomes: bm(PLATTER), density: 6, cells: 40, maxPerCell: 4,
    scale: [0.55, 1.05], stretch: [0.80, 1.20], slope: [0, 0.55], depth: [82, 136],
    align: 0.92, tilt: 0.10, sink: 0.05,
    colony: { size: 30, coverage: 0.40, edge: 0.50 },
    sways: true, stiffness: 0.14, swayStrength: 0.26, twoSided: true,
    emissive: 0, emissiveColor: [0, 0, 0],
    fluoresces: false, algalFilm: 0.05,
    colorMul: [1.00, 1.00, 1.00], translucency: 1.00, thickness: 0.0020,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 110, fadeStart: 70, maxLod: 1,
    maxPerChunk: 900, importance: 2, ore: null, collidable: false,
    note: 'Olive-brown turf patches on the forest sand.',
  }),
  // ==========================================================================
  // THE TITAN KELP (id 66). 2026-08-18 emerald rebuild, appended - ids are
  // placement salts.
  //
  // The deep third of the Kelp Forest (60-78 m floor) is where the reference
  // frame (a 68 m eye) actually lives, and
  // before this row its biggest resident was the 58 m-band canopy at density
  // 0.16 - the deep forest had no trunks a vessel feels small against. This
  // is the widest kelp in the game (girth 2.6 on the shared generator: a
  // ~0.9 m braided stipe before instance scale), fronded over its whole
  // length (bands 6) and fruiting from 35% of its height up (fruitLo 0.35),
  // so the deep bed carries warm lights at MANY heights the way the
  // reference does.
  //
  // Round 3 (playtest): height 62 under the per-instance `surfaceCap` -
  // the static breach arithmetic this comment used to carry is superseded
  // by the cap (see the placement loop), and depth[0] comes down to 54 so
  // the titan tier reaches most of the deep bed. Fruit 18 clustered in the
  // top third (fruitLo 0.68), crown 12.
  //
  // NO `signatureBiome` (kelpGiant carries KELP's; the field is a light
  // class); the fruit rides the ordinary fill path like the champion's.
  Object.freeze({
    id: 66, key: 'kelpTitan', name: 'Titan Kelp',
    generator: 'generateGiantKelp',
    meshParams: { blades: 26, height: 124.0, bands: 6, secondary: 2, fruit: 18,
      girth: 2.6, bladeWide: 1.35, fruitLo: 0.68, crown: 10,
      fruitColor: MESH_PALETTE.KELP_FRUIT },
    biomes: bm(KELP), density: 0.32, cells: 12, maxPerCell: 1,
    biomeTint: { [KELP]: HUE.kelpOlive },
    surfaceCap: 2.0,
    scale: [1.00, 1.10], stretch: [1.00, 1.03], slope: [0, 0.75], depth: [72, 190],
    align: 1.0, tilt: 0.03, sink: 0.20,
    colony: { size: 220, coverage: 0.40, edge: 0.36 },
    sways: true, stiffness: 0.045, swayStrength: 3.0, twoSided: true,
    // The champion's emission: a titan carries twenty pods and the per-plant
    // flux is already the largest in the biome.
    emissive: 1.6, emissiveColor: [1.00, 0.80, 0.24],
    fluoresces: false, algalFilm: 0.00,
    colorMul: [0.32, 0.45, 0.26], roughnessBias: 0.30, translucency: 0.30, thickness: 0.0060,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 360, fadeStart: 260, maxLod: 2, maxPerChunk: 14, importance: 10,
    ore: null, collidable: false,
    note: 'The deep forest pillars: 46-60 m trunks the vessel weaves between.',
  }),
  // ==========================================================================
  // THE KELP FOREST'S OWN UNDERSTORY (id 67). Emerald rebuild round 6,
  // appended - ids are placement salts.
  //
  // This REPLACES kelpStalk's KELP carriage in the same change that removes
  // it (the same-change replacement rule): the shared row could not be
  // darkened or grown without restyling Boulder Field, because colorMul,
  // translucency and meshParams are per-ROW and biomeTint is unit-luma
  // normalised (it rotates hue, it cannot darken - measured on three rounds
  // of delivered frames that never changed). Taller than the old whips and
  // surface-capped like every rebuild row, so the understory scales itself
  // to its column.
  Object.freeze({
    id: 67, key: 'kelpVine', name: 'Kelp Vine',
    generator: 'generateKelp',
    meshParams: { blades: 16, height: 30.0, bands: 3, girth: 1.9, bladeWide: 1.3 },
    biomes: bm(KELP), density: 6.0, cells: 25, maxPerCell: 3,
    biomeTint: { [KELP]: HUE.kelpOlive },
    surfaceCap: 3.0,
    scale: [0.8, 1.35], stretch: [1.0, 1.20], slope: [0, 0.90], depth: [34, 180],
    align: 1.0, tilt: 0.08, sink: 0.1,
    colony: { size: 120, coverage: 0.5, edge: 0.42 },
    sways: true, stiffness: 0.08, swayStrength: 1.2, twoSided: true,
    emissive: 0, emissiveColor: [0, 0, 0],
    fluoresces: false, algalFilm: 0.00,
    // The forest's dark understory: the same dark-olive family as the
    // trunks, half a step lighter so depth layering reads.
    colorMul: [0.26, 0.38, 0.22], roughnessBias: 0.30, translucency: 0.30, thickness: 0.0040,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 190, fadeStart: 128, maxLod: 1, maxPerChunk: 700, importance: 6,
    ore: null, collidable: false,
    note: 'The dark vine understory of the emerald forest; kelpStalk stayed on Boulder Field.',
  }),
  // ==========================================================================
  // THE SUNKEN DUNES KIT (ids 68-71, biome 18, 2026-08-19). Appended - ids
  // are placement salts. The biome is the leviathan hunting ground
  // of its art-direction reference: a vast open azure dune plateau at
  // 318-342 m whose subject is a moving animal, so the kit's whole job is
  // NEGATIVE SPACE with monumental punctuation - DESIGN/06.4.6's own unbuilt
  // dread instrument, "environmental evidence of scale (gouges, carcasses,
  // shed teeth)", built here as the bone field the resident predator implies.
  // Nothing in the kit is dense; the emptiness is authored, not unfinished
  // (the deep-zone rule: sparse zones still require a monumental
  // subject, and this biome has two - the skeletons and the animal).
  // ==========================================================================
  Object.freeze({
    // THE SIGNATURE (the SEVENTEENTH; test-scatter derives the count as
    // BIOMES.length - 2). A colossal dead-leviathan ribcage on the ossuary
    // colossus's construction, one size up: what the Sunken Dunes' resident
    // does to the things it catches, left where the light can find it.
    id: 68, key: 'duneColossus', name: 'Dune Colossus', signatureBiome: DUNES,
    generator: 'generateWhaleFall',
    // size 40 over ossuary's 34: the ossuary's dread is that there are so
    // many; this biome's is that there is one every few hundred metres and
    // something here made them. Same bone material, so the emissive 2.0
    // lands as the same faint ~0.10 surface glow (slotEmissiveGate 0.05) -
    // a pale mass the azure daylight and the beacon promotion make legible,
    // not a lamp.
    meshParams: { size: 40, vertebrae: 17, ribPairs: 9, color: MESH_PALETTE.BONE,
      matColor: MESH_PALETTE.CARBONATE, wormColor: MESH_PALETTE.TUBEROD },
    biomes: bm(DUNES), density: 0.30, cells: 12, maxPerCell: 1,
    scale: [0.90, 1.20], stretch: [0.92, 1.10], slope: [0, 0.55], depth: [326, 372],
    align: 0.75, tilt: 0.06, sink: 0.14,
    // Signature negative space at plateau scale: a 300 m colony on a 550 m
    // arena keeps skeletons in loose graveyards with long empty dune runs
    // between them, which is where the animal reads against clean water.
    colony: { size: 300, coverage: 0.35, edge: 0.30 },
    sways: false, stiffness: 1, swayStrength: 0, twoSided: false,
    emissive: 2.0, emissiveColor: [0.78, 0.86, 1.00],
    fluoresces: false, algalFilm: 0.30,
    colorMul: [0.52, 0.50, 0.45], translucency: 0.25, thickness: 0.080,
    maxDetail: MESH_DETAIL.HIGH, viewDistance: 360, fadeStart: 250, maxLod: 3,
    maxPerChunk: 3, importance: 12, ore: null, collidable: true,
    note: 'A 40 m ribcage half-buried in the dunes; the resident is why it is here.',
  }),
  Object.freeze({
    // The mid-frequency bone: lone rib pairs breaching the sand between the
    // graveyards, the Sand Plains dune-rib foreshadowing paid off at the
    // scale the fully grown predator implies. Single-biome row, so the
    // colour lives in colorMul (ivory, faintly warm), not a biomeTint.
    id: 69, key: 'duneRib', name: 'Breach Rib',
    generator: 'generateBoneRib', meshParams: { height: 20, taper: 0.26 },
    // maxPerCell 3 on a tighter colony (round 3): the round-2 review read
    // SINGLETON ribs as pale kelp blades - a rib is only bone when it has
    // a ribcage's worth of neighbours sharing a buried spine line.
    biomes: bm(DUNES), density: 0.9, cells: 16, maxPerCell: 3,
    scale: [0.75, 1.45], stretch: [0.85, 1.30], slope: [0, 0.60], depth: [326, 372],
    align: 0.65, tilt: 0.30, sink: 0.35,
    colony: { size: 64, coverage: 0.22, edge: 0.35 },
    sways: false, stiffness: 1, swayStrength: 0, twoSided: false,
    emissive: 0, emissiveColor: [0, 0, 0],
    fluoresces: false, algalFilm: 0.45,
    colorMul: [0.50, 0.48, 0.42], translucency: 0.35, thickness: 0.030,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 300, fadeStart: 200, maxLod: 2, maxPerChunk: 24, importance: 8,
    ore: null, collidable: true,
    note: 'A 10-20 m rib arch alone in open sand: the scale cue that works at silhouette range.',
  }),
  Object.freeze({
    // The warm accent: crimson gorgonians colonising the bone and the rubble,
    // the reference predator's own red echoed in the flora (the two-family
    // split - pale mineral bone, crimson living accent). NOT fluorescing:
    // test-scatter's pump gate is right that 335 m holds no blue worth
    // re-emitting, so the red is carried by the EMISSIVE rim (which owns its
    // own spectrum) and by the DUNE_AZURE Kd deviation's surviving 25% red
    // under lamps at close range.
    id: 70, key: 'duneFan', name: 'Crimson Fan',
    generator: 'generateCoralFan', meshParams: { thickness: 0.22, height: 2.6 },
    biomes: bm(DUNES), density: 1.6, cells: 24, maxPerCell: 2,
    scale: [0.70, 1.80], stretch: [0.85, 1.50], slope: [0, 0.70], depth: [326, 372],
    align: 0.45, tilt: 0.28, sink: 0.14,
    colony: { size: 70, coverage: 0.35, edge: 0.45 },
    sways: true, stiffness: 0.55, swayStrength: 0.09, twoSided: true,
    // The emission ladder, measured on delivered frames: 3.0 was a
    // white-pink LAMP (AgX shoulder, round 1); 0.35 with colorMul red was
    // ZERO delivered red - round 2 measured the fan flesh at hue 252-259
    // deg, blue 0.77 vs red 0.61, because at 348 m the illuminant has no
    // red for ANY reflectance to reflect and the translucent flesh simply
    // re-emits the blue key. So the crimson is carried by EMISSION (which
    // owns its own spectrum) at 0.55 with the red pinned hard, and the
    // flesh is DARKENED so the glow dominates it - a dark warm silhouette
    // at range, the art-direction reference's own deep-red read. White-clip gate from the
    // review: stays under 0.05% of frame (round 2 measured 0.0000% with
    // 0.35, so 0.55 has headroom).
    emissive: 0.55, emissiveColor: [1.00, 0.12, 0.08],
    fluoresces: false, algalFilm: 0.00,
    colorMul: [0.40, 0.10, 0.08], translucency: 1.00, thickness: 0.0060,
    maxDetail: MESH_DETAIL.HIGH,
    viewDistance: 180, fadeStart: 120, maxLod: 1, maxPerChunk: 90, importance: 7,
    ore: null, collidable: false,
    note: 'Blood-red fans on the bone piles: the biome wears its predator’s colour.',
  }),
  Object.freeze({
    // Near-field ground texture: pale shell-hash gravel drifted into the
    // ripple troughs, so the sand reads as a place at swim distance without
    // spending any of the arena's negative space.
    id: 71, key: 'duneShell', name: 'Shell Hash',
    generator: 'generatePebble', meshParams: { size: 0.45 },
    biomes: bm(DUNES), density: 5.0, cells: 28, maxPerCell: 4,
    scale: [0.60, 1.60], stretch: [0.75, 1.30], slope: [0, 0.55], depth: [326, 372],
    align: 0.85, tilt: 0.12, sink: 0.30,
    colony: { size: 46, coverage: 0.45, edge: 0.55 },
    sways: false, stiffness: 1, swayStrength: 0, twoSided: false,
    emissive: 0, emissiveColor: [0, 0, 0],
    fluoresces: false, algalFilm: 0.60,
    colorMul: [0.64, 0.62, 0.56], translucency: 0.15, thickness: 0.050,
    maxDetail: MESH_DETAIL.MEDIUM,
    viewDistance: 90, fadeStart: 60, maxLod: 1, maxPerChunk: 220, importance: 4,
    ore: null, collidable: false,
    note: 'Shell drifts in the ripple troughs; near-field texture only, the arena stays open.',
  }),
]);

export const SCATTER_TYPE_COUNT = SCATTER_TYPES.length;

/** key -> record, for callers that would rather not remember integers. */
export const SCATTER_BY_KEY = Object.freeze(
  SCATTER_TYPES.reduce((m, t) => { m[t.key] = t; return m; }, Object.create(null)));

/** The subset that carries an ore payload, in table order. */
export const ORE_TYPES = Object.freeze(SCATTER_TYPES.filter((t) => t.ore !== null));

/** Highest terrain LOD ring any type is generated for. */
export const SCATTER_MAX_LOD = SCATTER_TYPES.reduce((m, t) => Math.max(m, t.maxLod), 0);

/** Longest view distance in the table, metres. Drives the streaming radius. */
export const SCATTER_MAX_VIEW_DISTANCE =
  SCATTER_TYPES.reduce((m, t) => Math.max(m, t.viewDistance), 0);

/**
 * Hard per-chunk instance cap.
 *
 * The streaming radius is SCATTER_MAX_VIEW_DISTANCE (340 m), which covers
 * pi * 340^2 / 128^2 = 23 chunks, and the manager keeps a margin on top. At
 * 6144 a chunk, forty resident chunks would want 246k against
 * RENDER.MAX_SCATTER_INSTANCES of 160k - which is exactly why
 * generateScatterForChunk takes a `budget` and the manager passes it what is
 * actually left, rather than letting the instance buffer silently overflow.
 * Measured occupancy over 200 varied chunks is far below the cap; this is the
 * ceiling that makes the buffer sizing provable, not a working number.
 */
export const SCATTER_MAX_PER_CHUNK = 6144;

/**
 * Live tuning levers. MUTABLE on purpose, in the same spirit as `RENDER`: a
 * whole authored dimension has to be bisectable from the console without an
 * edit-reload cycle, and every knob here reproduces the pre-change world
 * EXACTLY at 0.
 *
 *   biomeDensityStrength  blends every `biomeDensity` weight toward 1. At 0 the
 *                         weight table is not consulted at all, no hash is
 *                         drawn, and every type emits byte-identical instances -
 *                         which is the reference arm tools/test-scatter.mjs
 *                         section 5b uses to prove the mechanism is inert where
 *                         it is unauthored.
 *   biomeAppearanceStrength  blends every `biomeTint` toward neutral white and
 *                         every `biomeGlow` toward 1. At 0 neither table is
 *                         consulted and every instance byte is what it was before
 *                         per-biome appearance existed; at 1 the authored value
 *                         is delivered EXACTLY (the blend is `v * s + (1 - s)`,
 *                         which is exact at both ends). It is separate from
 *                         biomeDensityStrength on purpose: density moves
 *                         instances and appearance does not, so the two have to
 *                         be bisectable apart or a colour regression and a
 *                         placement regression cannot be told from each other.
 *
 * Changing it mid-session does NOT rebuild resident chunks; call
 * invalidateScatterCache() and force a rescan, or set it before boot. Scatter is
 * generated on the main thread only (render/passes/scatter.js is the sole
 * caller), so there is no worker copy of this object to desynchronise.
 */
export const SCATTER_TUNING = {
  biomeDensityStrength: 1,
  biomeAppearanceStrength: 1,
};

// ===========================================================================
// Seeding
// ===========================================================================

/**
 * Salt base. Never renumber: changing it reshuffles every plant in every
 * existing world. Per-type salts are base + typeId * 16, leaving room for the
 * count / point / colony sub-salts each type needs.
 */
const SALT_BASE = 0x00050100;

let _seedSource = -1;
/**
 * Per-type derived seeds and baked per-biome tables:
 * {count, point[], colony, density, variant, thin, biomeThin, bw, bt, bg}.
 */
let _S = null;

/**
 * Bake one row's sparse `biomeDensity` map into a dense lookup, or null.
 *
 * NULL RATHER THAN AN ARRAY OF ONES is the point: walkType tests the null and
 * skips the whole branch, so an unauthored row draws no hash and takes the same
 * decisions it always did. A dense array of 1.0s would be arithmetically
 * identical and would still cost a bounds-checked load per surviving candidate
 * on all 42 types.
 *
 * Throws rather than clamping. A weight outside [0, 1] or a key that is not a
 * biome id is an authoring mistake, and silently repairing it is how a table
 * ends up with a field that nothing reads - which is the bug class this whole
 * item exists to close.
 */
function bakeBiomeWeights(type) {
  const map = type.biomeDensity;
  if (map === undefined || map === null) return null;
  const bw = new Float32Array(BIOME_COUNT).fill(1);
  let authored = 0;
  for (const key of Object.keys(map)) {
    const id = Number(key);
    if (!Number.isInteger(id) || id < 0 || id >= BIOME_COUNT) {
      throw new Error(`scatter: ${type.key}.biomeDensity has key "${key}", not a biome id 0..${BIOME_COUNT - 1}`);
    }
    if ((type.biomes & (1 << id)) === 0) {
      throw new Error(`scatter: ${type.key}.biomeDensity weights biome ${id}, which its own biome mask excludes`);
    }
    const w = map[key];
    if (!(typeof w === 'number' && w >= 0 && w <= 1)) {
      throw new Error(`scatter: ${type.key}.biomeDensity[${id}] is ${w}, outside [0, 1]`);
    }
    bw[id] = w;
    authored++;
  }
  return authored > 0 ? bw : null;
}

/**
 * Ceiling on a NORMALISED `biomeTint` channel, and it is arithmetic, not taste.
 *
 * The instance tint is written as `t * 0.5` through a unorm8 and the shader
 * doubles it back (`tint.rgb * 2.0`), so the saturate is applied to the HALVED
 * value and any pre-encode multiplier above 2.0 is clipped to 2.0 IN SILENCE -
 * the bright half of the variation simply stops existing and nothing reports it.
 * The emit path's own peak is `sh = (0.82 + 0.36 * h1) * shade`, i.e. 1.18 at
 * h1 = 1 and shade = 1, times the +/-6% warm/cool residual on red and blue:
 * 1.18 * 1.06 = 1.2508. So the largest biome tint that cannot clip on ANY
 * channel is 2 / 1.2508 = 1.5990. Green, which carries no residual, has more
 * headroom; one ceiling for all three is what makes the guard checkable.
 *
 * Keep these three in step with the `sh` / `tr` / `tb` expressions in
 * generateScatterForChunk. tools/test-scatter.mjs re-derives the ceiling from
 * the delivered bytes rather than trusting this comment.
 */
const TINT_SHADE_PEAK = 0.82 + 0.36;
const TINT_RESIDUAL_PEAK = 1.06;
const BIOME_TINT_CEIL = 2 / (TINT_SHADE_PEAK * TINT_RESIDUAL_PEAK);

/**
 * Bake one row's sparse `biomeTint` map into a dense BIOME_COUNT x 3 lookup,
 * normalised to unit Rec709 luma, or null when the row authors none.
 *
 * NORMALISATION IS THE GUARD, NOT A CONVENIENCE. renderer.js normalises
 * BIOMES[].fogTint for exactly this reason: a colour multiplier that changes
 * energy is an exposure change wearing a hue's clothes, and auto-exposure will
 * then chase it across the whole frame. Dividing by the authored triple's own
 * luma leaves a pure rotation, so the biome that gets a hue does not also get a
 * stop.
 *
 * Throws on a bad key, a non-triple, a non-positive luma, or a post-normalisation
 * channel above BIOME_TINT_CEIL. The last one is the silent-clip trap above: an
 * author who reaches for a more saturated warm hue crosses it long before the
 * colour looks wrong, and the failure mode is a tint that gets brighter up to a
 * point and then stops.
 */
function bakeBiomeTints(type) {
  const map = type.biomeTint;
  if (map === undefined || map === null) return null;
  const bt = new Float32Array(BIOME_COUNT * 3).fill(1);
  let authored = 0;
  for (const key of Object.keys(map)) {
    const id = Number(key);
    if (!Number.isInteger(id) || id < 0 || id >= BIOME_COUNT) {
      throw new Error(`scatter: ${type.key}.biomeTint has key "${key}", not a biome id 0..${BIOME_COUNT - 1}`);
    }
    if ((type.biomes & (1 << id)) === 0) {
      throw new Error(`scatter: ${type.key}.biomeTint tints biome ${id}, which its own biome mask excludes`);
    }
    const c = map[key];
    if (!Array.isArray(c) || c.length !== 3 ||
        !c.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
      throw new Error(`scatter: ${type.key}.biomeTint[${id}] is not a triple of non-negative numbers`);
    }
    const luma = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    if (!(luma > 1e-4)) {
      throw new Error(`scatter: ${type.key}.biomeTint[${id}] has Rec709 luma ${luma}, which cannot be normalised`);
    }
    const inv = 1 / luma;
    for (let k = 0; k < 3; k++) {
      const v = c[k] * inv;
      if (v > BIOME_TINT_CEIL) {
        throw new Error(
          `scatter: ${type.key}.biomeTint[${id}] channel ${k} normalises to ${v.toFixed(4)}, ` +
          `above the ${BIOME_TINT_CEIL.toFixed(4)} at which the instance tint byte clips in silence`);
      }
      bt[id * 3 + k] = v;
    }
    authored++;
  }
  return authored > 0 ? bt : null;
}

/**
 * Bake one row's sparse `biomeGlow` map into a dense lookup, or null.
 *
 * THE UPPER BOUND IS 1 AND IT IS STRUCTURAL. The per-instance emissive scale is
 * `saturate(0.55 + 0.45 * h3)`, whose top is exactly 1.0, so a scale above 1
 * would push the upper part of the hash range into the saturate and DELIVER LESS
 * variation than it started with while reading as "brighter" in the table. A row
 * that wants more light than that is asking for a higher `emissive`, which is a
 * per-type quantity and belongs in the row.
 */
function bakeBiomeGlow(type) {
  const map = type.biomeGlow;
  if (map === undefined || map === null) return null;
  const bg = new Float32Array(BIOME_COUNT).fill(1);
  let authored = 0;
  for (const key of Object.keys(map)) {
    const id = Number(key);
    if (!Number.isInteger(id) || id < 0 || id >= BIOME_COUNT) {
      throw new Error(`scatter: ${type.key}.biomeGlow has key "${key}", not a biome id 0..${BIOME_COUNT - 1}`);
    }
    if ((type.biomes & (1 << id)) === 0) {
      throw new Error(`scatter: ${type.key}.biomeGlow scales biome ${id}, which its own biome mask excludes`);
    }
    if (type.emissive <= 0) {
      throw new Error(`scatter: ${type.key}.biomeGlow scales the emission of a type whose emissive is 0`);
    }
    const g = map[key];
    if (!(typeof g === 'number' && g > 0 && g <= 1)) {
      throw new Error(`scatter: ${type.key}.biomeGlow[${id}] is ${g}, outside (0, 1]`);
    }
    bg[id] = g;
    authored++;
  }
  return authored > 0 ? bg : null;
}

/**
 * Sync the derived seeds with the world seed.
 *
 * The seed is PULLED from terrain.js rather than pushed in by main.js, and that
 * is deliberate: the dependency already runs one way (scatter -> terrain), so
 * there is no cycle, and a caller cannot forget to wire a second setSeed().
 * The comparison is one integer, so calling this per chunk costs nothing.
 */
function ensureSeeds() {
  const seed = terrain.getSeed();
  if (seed === _seedSource && _S !== null) return;
  _seedSource = seed;
  // The cave-mouth cull memo is derived from the OLD seed's graph; answering
  // one more chunk from it after a re-seed made delivered scatter depend on
  // query history (measured by the 2026-08-18 review: 1663 vs 1676 instances
  // for one chunk depending on whether the memo was primed before the seed
  // change - a direct violation of "same seed, bit-identical world").
  _mouthMemoCx = NaN; _mouthMemoCz = NaN;
  _mouthMemo = null;
  // Seeds are folded to 24 bits, because fbm2/scatterPoint add `octave * 1013`
  // internally and the sum has to stay an exactly-representable small integer.
  // Same reasoning, same shift, as terrain.js's deriveSeeds().
  _S = SCATTER_TYPES.map((t) => {
    const base = SALT_BASE + t.id * 16;
    const point = new Int32Array(t.maxPerCell);
    for (let s = 0; s < t.maxPerCell; s++) {
      point[s] = hashU32((seed ^ (base + 4 + s)) >>> 0) >>> 8;
    }
    return {
      count: hashU32((seed ^ base) >>> 0) >>> 8,
      density: hashU32((seed ^ (base + 1)) >>> 0) >>> 8,
      colony: hashU32((seed ^ (base + 2)) >>> 0) >>> 8,
      variant: hashU32((seed ^ (base + 3)) >>> 0) >>> 8,
      thin: hashU32((seed ^ (base + 12)) >>> 0) >>> 8,
      // Sub-salt 13. A DEDICATED salt, not `thin` reused: the cap decides how
      // many of a chunk's instances survive and the biome weight decides how
      // many of a BIOME's do, and sharing one stream would make the two
      // decisions perfectly correlated - every instance the biome weight kept
      // would also be one the cap kept, so a weighted type riding its cap would
      // lose nothing extra and an unweighted one sharing the chunk would lose
      // twice. Slots 4..11 are the per-sub-instance point salts (maxPerCell
      // tops out at 8), so 13 is the first free slot after `thin`.
      biomeThin: hashU32((seed ^ (base + 13)) >>> 0) >>> 8,
      bw: bakeBiomeWeights(t),
      // No salt of their own, and they need none: both are written AFTER the
      // accept decision from the biome the placement loop already resolved, so
      // they consume no randomness and move no instance. That is what lets this
      // land without re-deriving an anchor or re-shooting a shot list.
      bt: bakeBiomeTints(t),
      bg: bakeBiomeGlow(t),
      point,
    };
  });
  // The cached field grid was baked against the old seed's heightfield.
  _gridCx = Infinity;
  _gridCz = Infinity;
}

// ===========================================================================
// Per-chunk field grid
// ===========================================================================

/**
 * Grid pitch, metres. 4 m over a 128 m chunk is 33 interior nodes plus a
 * one-node border for the gradient, so 35 x 35 = 1225 samples at a measured
 * 0.58 us each - 0.71 ms, once, for a filter that would otherwise cost 19 ms.
 *
 * The gradient is taken over ONE grid step, 4 m, which is the same span
 * terrain.sampleSlope() and biomes.js measure over, so the slope limits in the
 * table mean what they say. See bakeGrid() for why it is not a central
 * difference.
 */
const GRID_PITCH = 4;
const GRID_INTERIOR = CHUNK_SIZE / GRID_PITCH + 1;      // 33
const GRID_N = GRID_INTERIOR + 2;                       // 35, with border
const GRID_ORIGIN = -GRID_PITCH;                        // node 0 sits at -4 m

/**
 * TWO SLOPES, ONE LATTICE, AND THERE IS NO BIOME LATTICE AT ALL.
 *
 * Biome is queried PER CANDIDATE rather than off a lattice of its own. Two
 * lattices were tried and both were wrong for the same reason: biomes.js scores
 * on SLOPE as well as depth, and slope varies over metres, so the biome id itself
 * varies over metres on rough ground. An 8 m lattice disagreed with a point
 * sample 15% of the time and a 16 m one 24%, and no pitch a chunk can afford
 * fixes that - the field really is that fine. biomeAt() is 0.27 us, which is
 * cheaper per candidate than the lattice was per chunk.
 *
 * The two slopes exist because the two consumers want opposite biases:
 *
 *   _gridSlope       max of the two one-sided 4 m differences. Biased STEEP, for
 *                    the scatter slope FILTER, where over-rejecting near a cliff
 *                    edge is the safe direction.
 *   _field.slopeSigned  the bilinear patch's own 4 m gradient, evaluated at the
 *                    sample point. UNBIASED, for biomes.js, where a steep bias
 *                    reclassified flat trench floor as trench WALL and put talus
 *                    scree on a sediment plain that has none. See sampleField().
 */
const _gridHeight = new Float64Array(GRID_N * GRID_N);
const _gridSlope = new Float64Array(GRID_N * GRID_N);
let _gridCx = Infinity;
let _gridCz = Infinity;
let _gridMinH = 0;
let _gridMaxH = 0;

/**
 * Bake the field grid for a chunk. Heights come from sampleHeightFast because
 * this grid only ever FILTERS; the exact sampleHeight is paid once per accepted
 * instance, where it actually plants the mesh on the visible ground.
 */
function bakeGrid(cx, cz) {
  if (cx === _gridCx && cz === _gridCz) return;
  _gridCx = cx;
  _gridCz = cz;
  const ox = cx * CHUNK_SIZE + GRID_ORIGIN;
  const oz = cz * CHUNK_SIZE + GRID_ORIGIN;

  let minH = Infinity, maxH = -Infinity;
  for (let j = 0; j < GRID_N; j++) {
    const wz = oz + j * GRID_PITCH;
    const row = j * GRID_N;
    for (let i = 0; i < GRID_N; i++) {
      const h = terrain.sampleHeightFast(ox + i * GRID_PITCH, wz);
      _gridHeight[row + i] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }
  _gridMinH = minH;
  _gridMaxH = maxH;

  // ONE-SIDED DIFFERENCES, STEEPEST SIDE, NOT A CENTRAL DIFFERENCE.
  //
  // A central difference across two nodes measures the slope over 8 m, and over
  // 8 m a bommie flank averages out: the measured 0.4 that a pebble type was
  // filtered against was a real 1.05 at the 4 m span terrain.sampleSlope() and
  // biomes.js use, so shingle was being planted on 46-degree rock. Taking the
  // steeper of the two adjacent 4 m differences puts this on the same span AND
  // biases it toward rejection, which is the safe direction for a filter.
  const inv = 1 / GRID_PITCH;
  for (let j = 0; j < GRID_N; j++) {
    const row = j * GRID_N;
    const rowN = (j > 0 ? j - 1 : j) * GRID_N;
    const rowP = (j < GRID_N - 1 ? j + 1 : j) * GRID_N;
    for (let i = 0; i < GRID_N; i++) {
      const iN = i > 0 ? i - 1 : i;
      const iP = i < GRID_N - 1 ? i + 1 : i;
      const h = _gridHeight[row + i];
      const hE = _gridHeight[row + iP], hW = _gridHeight[row + iN];
      const hS = _gridHeight[rowP + i], hN = _gridHeight[rowN + i];
      const gx = Math.max(Math.abs(hE - h), Math.abs(h - hW)) * inv;
      const gz = Math.max(Math.abs(hS - h), Math.abs(h - hN)) * inv;
      _gridSlope[row + i] = Math.sqrt(gx * gx + gz * gz);
    }
  }
}

/** Bilinear grid lookup of height and slope for a chunk-local position. */
const _field = { height: 0, slope: 0, slopeSigned: 0, nx: 0, ny: 1, nz: 0 };
function sampleField(localX, localZ) {
  const gx = (localX - GRID_ORIGIN) / GRID_PITCH;
  const gz = (localZ - GRID_ORIGIN) / GRID_PITCH;
  const i0 = clamp(Math.floor(gx), 0, GRID_N - 2);
  const j0 = clamp(Math.floor(gz), 0, GRID_N - 2);
  const fx = gx - i0;
  const fz = gz - j0;
  const r0 = j0 * GRID_N + i0;
  const r1 = r0 + GRID_N;

  const h00 = _gridHeight[r0], h10 = _gridHeight[r0 + 1];
  const h01 = _gridHeight[r1], h11 = _gridHeight[r1 + 1];
  _field.height = lerp(lerp(h00, h10, fx), lerp(h01, h11, fx), fz);

  // SLOPE TAKES THE MAX OF THE FOUR CORNERS, NOT A BILINEAR BLEND. Interpolating
  // between a flat node and a steep one hands the midpoint the average, so a
  // point 2 m from the lip of a bommie reads as half the slope it is standing on -
  // measured, that let shingle onto 36-degree rock against a 23-degree limit.
  // Taking the max makes the filter conservative near every steep feature, which
  // for scatter is the right bias: nothing grows on the edge of a cliff either.
  _field.slope = Math.max(_gridSlope[r0], _gridSlope[r0 + 1],
                          _gridSlope[r1], _gridSlope[r1 + 1]);

  // Surface normal from the same bilinear height field, which is what keeps an
  // aligned instance flush with the ground the grid describes.
  //
  // Its gradient magnitude is ALSO the unbiased slope biomes.js wants, and it is
  // the best this grid can do for the purpose: the bilinear patch's own
  // derivative spans exactly one grid step, 4 m, which is the span
  // terrain.sampleSlope() uses, and it is evaluated AT the sample point rather
  // than interpolated between two node values each measured somewhere else.
  // Storing a central difference per node instead spans 8 m, and that extra
  // smoothing was measured to reclassify 5.3% of type-runs - flat trench floor as
  // trench WALL, which put talus scree on a sediment plain that has none.
  //
  // THE RESIDUAL, MEASURED. Against biomeAt() fed terrain.sampleHeight and
  // terrain.sampleSlope, this approximation agrees on 76.6% of 3200 samples. The
  // attribution is lopsided and worth knowing: substituting the exact HEIGHT
  // recovers 0.19% and substituting the exact SLOPE recovers 23.19%. So the grid
  // height is fine and the slope is the whole story, because biomes.js scores
  // slope with feathers 0.16 to 0.30 wide and a 4 m bilinear patch cannot resolve
  // the sub-4 m relief that moves a gradient by that much.
  //
  // Removing it costs a real terrain.sampleSlope per surviving candidate - 3.2 us
  // against thousands of candidates, several times the whole 5 ms chunk budget -
  // so it is not removed. The visible consequence is that roughly one type-run in
  // twenty appears in a biome adjacent to its mask rather than inside it: a
  // boulder on a plain, scree on a floor. Both are plausible geology, which is
  // why this is an accepted approximation and not a bug. tools/test-scatter.mjs
  // bounds the rate so a regression that makes it worse is caught.
  const gxd = (lerp(h10, h11, fz) - lerp(h00, h01, fz)) / GRID_PITCH;
  const gzd = (lerp(h01, h11, fx) - lerp(h00, h10, fx)) / GRID_PITCH;
  _field.slopeSigned = Math.sqrt(gxd * gxd + gzd * gzd);
  const invLen = 1 / Math.sqrt(gxd * gxd + gzd * gzd + 1);
  _field.nx = -gxd * invLen;
  _field.ny = invLen;
  _field.nz = -gzd * invLen;
  return _field;
}

// ===========================================================================
// Density modulation
// ===========================================================================

/**
 * Wavelength of the universal density field, metres. 58 m is a patch you can
 * swim across in twenty seconds: long enough to read as terrain-scale variation
 * rather than as noise, short enough that a single chunk contains several.
 */
const DENSITY_WAVELENGTH = 58;
const DENSITY_FREQ = 1 / DENSITY_WAVELENGTH;

/**
 * THE MODULATION GRID, and why the obvious implementation is 10 ms a chunk.
 *
 * Evaluating the density and colony fields at every placement cell is what a
 * first pass does, and it was measured at 9 to 12 ms per chunk: a 1.28 m cell
 * grid is 10,000 cells, five simplex evaluations each, for two fields whose
 * shortest feature is FIFTEEN METRES. Every one of those cells is asking for a
 * number its neighbours already know.
 *
 * So the modulation is baked per type onto its own coarse lattice, at a pitch of
 * a fifth of its shortest feature, and bilinearly interpolated per cell. Nyquist
 * needs two samples per wavelength; five is generous, and the residual is a
 * colony rim that is slightly smoother than the analytic one - which reads
 * better, not worse. Measured effect: 10.2 ms -> 0.9 ms of modulation cost.
 *
 * Interpolating the FINISHED mask rather than the field it was thresholded from
 * is deliberate for the same reason.
 */
const MOD_MAX_SEGMENTS = 32;
const MOD_FEATURE_SAMPLES = 5;
const _modGrid = new Float64Array((MOD_MAX_SEGMENTS + 1) * (MOD_MAX_SEGMENTS + 1));
let _modSegments = 1;
let _modPitch = CHUNK_SIZE;
let _modStride = 2;

/**
 * Bake the density modulation for one type over one chunk.
 * Values land in [0, 1] and multiply the type's tabled density.
 */
function buildModGrid(type, cx, cz, seeds) {
  const colony = type.colony;
  const cellSize = CHUNK_SIZE / type.cells;
  const feature = colony === null
    ? DENSITY_WAVELENGTH
    : Math.min(colony.size, DENSITY_WAVELENGTH);
  const rawPitch = Math.max(cellSize, feature / MOD_FEATURE_SAMPLES);
  const segments = clamp(Math.ceil(CHUNK_SIZE / rawPitch), 1, MOD_MAX_SEGMENTS);
  _modSegments = segments;
  _modPitch = CHUNK_SIZE / segments;
  _modStride = segments + 1;

  const originX = cx * CHUNK_SIZE;
  const originZ = cz * CHUNK_SIZE;
  // THE COLONY THRESHOLD, AND WHAT `coverage` REALLY MEANS.
  //
  // A 3-octave fbm of simplex remapped to [0, 1] is NOT uniform - it piles up
  // near 0.5 - so cutting at (1 - coverage) only yields `coverage` of the area
  // when the cut is near the middle. MEASURED E[c] over a 1500 x 1500 m field
  // against the authored figure:
  //
  //   coverage  0.14   0.22   0.24   0.30   0.40   0.50   0.58   0.68   0.72
  //   E[c]      0.024  0.077  0.100  0.170  0.327  0.500  0.636  0.786  0.844
  //
  // Exact at 0.50 and a factor of SIX short at 0.14. Anything authored in the
  // tail is far rarer than it reads, which is why the landmark rows had to be
  // re-authored against this table rather than against the name.
  let lo = 0, hi = 1, cf = 0;
  if (colony !== null) {
    const half = colony.edge * 0.5;
    lo = clamp(1 - colony.coverage - half, 0, 1);
    hi = clamp(1 - colony.coverage + half, lo + 1e-3, 1);
    cf = 1 / colony.size;
  }

  for (let j = 0; j <= segments; j++) {
    const wz = originZ + j * _modPitch;
    const row = j * _modStride;
    for (let i = 0; i <= segments; i++) {
      const wx = originX + i * _modPitch;
      const broad = fbm2(simplex2, wx * DENSITY_FREQ, wz * DENSITY_FREQ, seeds.density, 2);
      let m = 0.55 + 0.45 * (0.5 + 0.5 * broad);
      if (colony !== null) {
        const n = fbm2(simplex2, wx * cf, wz * cf, seeds.colony, 3) * 0.5 + 0.5;
        // NOT SQUARED. The square was authored to make a bed thickest in the
        // middle, and a smoothstep of an fbm already does that - what the square
        // added was a second, silent thinning that fell hardest exactly where the
        // field was already thinnest. MEASURED E[c^2]/E[c]: 0.91 at coverage 0.72
        // and 0.39 at 0.14, so it cost the common ground cover 9% and the rare
        // landmarks 61%. Realised over 4.92 km^2 that was 21 bone ribs and 49 vent
        // chimneys in the entire world - one chimney per 590 m of seabed.
        m *= smoothstep(lo, hi, n);
      }
      _modGrid[row + i] = m;
    }
  }
}

/** Bilinear lookup into the modulation grid, for a chunk-local position. */
function sampleMod(localX, localZ) {
  const gx = localX / _modPitch;
  const gz = localZ / _modPitch;
  const i0 = clamp(Math.floor(gx), 0, _modSegments - 1);
  const j0 = clamp(Math.floor(gz), 0, _modSegments - 1);
  const fx = gx - i0;
  const fz = gz - j0;
  const r0 = j0 * _modStride + i0;
  const r1 = r0 + _modStride;
  return lerp(lerp(_modGrid[r0], _modGrid[r0 + 1], fx),
              lerp(_modGrid[r1], _modGrid[r1 + 1], fx), fz);
}

// ===========================================================================
// Placement
// ===========================================================================

/** Emitted point, reused. `visit()` must copy anything it wants to keep. */
const _pt = new Float64Array(4);

// Cave-mouth shaft discs per chunk, memoised for the one chunk the type loop
// is iterating (every type of a chunk asks in sequence, so a one-entry memo
// hits on all but the first). Flat [x, z, r^2, ...]; null when the chunk has
// no mouth near it, which is the answer for almost every chunk in the world
// and costs one memo compare per walkType call.
let _mouthMemoCx = NaN, _mouthMemoCz = NaN;
let _mouthMemo = null;

/**
 * Every cave-mouth SHAFT whose footprint can touch chunk (cx, cz), as a flat
 * [x, z, shaftR^2, emissiveR^2] list or null. The shaft radius (all types) is
 * the mouth capsule's top radius plus the wall perturbation's 2.9 m reach
 * plus a seating margin - NOT cave_mesh's discard-disc radius, which extends
 * over the keep-ring surface copy where props stand on real drawn ground.
 * The wider emissive radius IS the discard-disc footprint: see the comment
 * at its derivation below.
 *
 * Mouths live in the macro cell of their below-surface START point (see
 * world/caves.js), up to ~140 m below the local surface, so the scan covers
 * the Y cells that band can occupy around the chunk's own surface height.
 */
function caveMouthShafts(cx, cz) {
  if (cx === _mouthMemoCx && cz === _mouthMemoCz) return _mouthMemo;
  _mouthMemoCx = cx; _mouthMemoCz = cz;
  _mouthMemo = null;
  const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE;
  const h = terrain.sampleHeight(x0 + CHUNK_SIZE * 0.5, z0 + CHUNK_SIZE * 0.5);
  const M = CAVE_MACRO_SIZE;
  const mx0 = Math.floor((x0 - 16) / M), mx1 = Math.floor((x0 + CHUNK_SIZE + 16) / M);
  const mz0 = Math.floor((z0 - 16) / M), mz1 = Math.floor((z0 + CHUNK_SIZE + 16) / M);
  // Entrance depths reach 140 m below the surface and the chunk's own surface
  // can vary ~100 m across steep ground; the pad covers both.
  const my0 = Math.floor((h - 260) / M), my1 = Math.floor((h + 60) / M);
  for (let mz = mz0; mz <= mz1; mz++) {
    for (let my = my0; my <= my1; my++) {
      for (let mx = mx0; mx <= mx1; mx++) {
        const sk = caveSkeleton(mx, my, mz);
        for (let m = 0; m < sk.mouthCount; m++) {
          const mxp = sk.mouths[m * 3], mzp = sk.mouths[m * 3 + 2];
          const topR = sk.mouthRadius[m];
          const r = topR + 2.9 + 1.6;
          // Emissive props are culled over the WHOLE rim funnel, not just
          // the shaft: a lamp-class prop at the lip out-shines the dark
          // opening that IS the reveal (photographed at the Jellyshroom
          // arrival - a blown-white glowcup upstaging the hole). Matches
          // mouthDiscRadius's slope-stretch factor.
          const rEm = (topR + Math.min(2.9, 0.4 * topR)) * 1.6 + 0.75;
          if (mxp + rEm < x0 || mxp - rEm > x0 + CHUNK_SIZE ||
              mzp + rEm < z0 || mzp - rEm > z0 + CHUNK_SIZE) continue;
          if (_mouthMemo === null) _mouthMemo = [];
          _mouthMemo.push(mxp, mzp, r * r, rEm * rEm);
        }
      }
    }
  }
  return _mouthMemo;
}

/**
 * Walk one type's cells over one chunk and call `visit` for every point that
 * survives every filter. THE ONE PLACEMENT LOOP: the instance writer and
 * oreNodesInChunk() both go through here, so a mined node is always exactly
 * where the drawn node is.
 *
 * REJECTION ORDER IS CHEAPEST FIRST, and the order is the performance story:
 *
 *   1. cell hash        one hash2. Decides how many candidates the cell offers
 *                       at FULL density. If that is zero the cell is finished
 *                       having touched neither the modulation grid nor the
 *                       terrain, which is what happens to the overwhelming
 *                       majority of cells for the overwhelming majority of
 *                       types.
 *   2. density          a bilinear modulation lookup, then each candidate is
 *                       thinned independently against its own stable random.
 *                       Thinning by probability rather than by recomputing the
 *                       count keeps the result exactly proportional to the
 *                       modulated density.
 *   3. height/slope/depth  a bilinear field lookup, no terrain evaluation.
 *   4. biome            one biomeAt() call, then a bitmask test and - for a row
 *                       that authors `biomeDensity` - a thin against that
 *                       biome's weight. Both ride the SAME biomeAt() call the
 *                       mask already paid for, which is why a per-biome weight
 *                       is close to free: the extra hash is drawn only for
 *                       candidates that already cleared depth, slope and the
 *                       mask.
 *   5. cap thinning     one hash against `keep`, see below.
 *
 * THE CAP IS A PROBABILITY, NOT A STOPPING POINT, and the difference is the
 * whole visible result. Stopping the walk when a type reaches maxPerChunk is
 * what the first version did, and because the walk is row-major over cells it
 * truncates the chunk IN Z: the seagrass cap of 2600 was reached about halfway
 * across the reef chunk, so the northern half of every chunk in the shallows had
 * a full meadow and the southern half had bare sand, with a straight edge between
 * them on a 128 m grid. Thinning uniformly by keep = cap / count costs a second
 * walk of the cells - hashes and grid lookups only, no terrain - and spreads the
 * loss over the whole chunk where nobody can see it.
 *
 * The caller therefore walks TWICE: once to count, once to emit. Only the second
 * walk pays for terrain.sampleHeight, and only for the points that survive the
 * thinning. buildModGrid() is hoisted to the caller so the noise is baked once
 * for both walks.
 *
 * @param {object} type SCATTER_TYPES entry
 * @param {number} cx chunk X
 * @param {number} cz chunk Z
 * @param {number} keep probability in (0, 1] that a surviving point is emitted
 * @param {(localX:number, localZ:number, gridHeight:number, r0:number, r1:number,
 *          slope:number, nx:number, ny:number, nz:number, biome:number) => void} visit
 *   `gridHeight` is the FIELD GRID's height, good to a measured 0.35 m RMS.
 *   A visitor that plants geometry must call terrain.sampleHeight itself.
 */
function walkType(type, cx, cz, keep, visit) {
  const S = _S[type.id];
  const cells = type.cells;
  const cellSize = CHUNK_SIZE / cells;
  const expectedMax = type.density * cellSize * cellSize * 0.01;   // per 100 m^2
  const kBase = Math.floor(expectedMax);
  const kFrac = expectedMax - kBase;
  const maxPerCell = type.maxPerCell;
  const biomeMask = type.biomes;
  const depthMin = type.depth[0], depthMax = type.depth[1];
  const slopeMin = type.slope[0], slopeMax = type.slope[1];
  const thin = keep < 1;
  // Hoisted so an unauthored row - 39 of the 42 - pays one null test per call,
  // not per candidate. At strength 0 the table is not consulted at all, which is
  // what makes the lever byte-exact rather than merely close.
  const bwStrength = SCATTER_TUNING.biomeDensityStrength;
  const bw = bwStrength > 0 ? S.bw : null;

  const cell0X = cx * cells;
  const cell0Z = cz * cells;
  const originX = cx * CHUNK_SIZE;
  const originZ = cz * CHUNK_SIZE;
  const mouthDiscs = caveMouthShafts(cx, cz);

  for (let j = 0; j < cells; j++) {
    const cellZ = cell0Z + j;
    for (let i = 0; i < cells; i++) {
      const cellX = cell0X + i;

      // ---- 1. cell hash ------------------------------------------------
      let k = kBase;
      if (kFrac > 0 && hash2(cellX, cellZ, S.count) < kFrac) k++;
      if (k === 0) continue;
      if (k > maxPerCell) k = maxPerCell;

      // ---- 2. density --------------------------------------------------
      const mod = sampleMod((i + 0.5) * cellSize, (j + 0.5) * cellSize);
      if (mod <= 0.0005) continue;

      for (let s = 0; s < k; s++) {
        scatterPoint(_pt, cellX, cellZ, cellSize, S.point[s], 0.85);
        const px = _pt[0], pz = _pt[1];
        const r0 = _pt[2], r1 = _pt[3];
        if (r1 > mod) continue;
        // One fixed authored landmark owns its footprint. Rejecting here keeps
        // flora, rocks and ore out of rooms, foundations and the Kestrel's
        // under-deck route without changing placement anywhere else.
        if (insideHabitatClearing(px, pz)) continue;
        // No prop stands over a cave-mouth shaft. The terrain fragment inside
        // a mouth's discard disc is discarded (pass/terrain.wgsl CAVE_MOUTHS)
        // while scatter plants on sampleHeight - so anything seeded over the
        // open shaft floats over the hole, which was cave_mesh.js's stated
        // live hazard until 2026-08-18 and photographed at the Jellyshroom
        // Hollow's mouth (white corals mid-air in the shaft). The cull discs
        // are the SHAFT footprint (top radius + wall perturbation + margin),
        // not the whole discard disc - props between shaft and disc edge
        // stand on the keep-ring surface copy, which is real ground.
        if (mouthDiscs !== null) {
          let overShaft = false;
          const rIdx = type.emissive > 0 ? 3 : 2;
          for (let mi = 0; mi < mouthDiscs.length; mi += 4) {
            const mdx = px - mouthDiscs[mi], mdz = pz - mouthDiscs[mi + 1];
            if (mdx * mdx + mdz * mdz < mouthDiscs[mi + rIdx]) { overShaft = true; break; }
          }
          if (overShaft) continue;
        }
        // Keep the encounter floor mostly black. Non-emissive ribs, rocks and
        // remains survive as lamp-revealed silhouettes; uniform natural glow
        // does not compete with the Pale Herald's moving light organ.
        if (type.emissive > 0 && type.signatureBiome === undefined &&
            insideAbyssEncounterFootprint(px, pz)) continue;

        // ---- 3. height / slope / depth --------------------------------
        const localX = px - originX;
        const localZ = pz - originZ;
        const f = sampleField(localX, localZ);
        const depth = -f.height;
        if (depth < depthMin || depth > depthMax) continue;
        if (f.slope < slopeMin || f.slope > slopeMax) continue;

        // ---- 4. biome ---------------------------------------------------
        // Per candidate, not off a lattice. See the note above _gridHeight.
        const biome = biomeAt(px, pz, f.height, f.slopeSigned);
        if ((biomeMask & (1 << biome)) === 0) continue;
        if (bw !== null) {
          const w = 1 - (1 - bw[biome]) * bwStrength;
          if (w < 1 && hash3(cellX, cellZ, s, S.biomeThin) >= w) continue;
        }

        // ---- 5. cap thinning ---------------------------------------------
        // A dedicated salt, so which instances survive the cap is independent of
        // where they are, how big they are and which way they face.
        //
        // THREE INDEPENDENT COORDINATES, NOT TWO PACKED INTO ONE. This was
        // hash2(cellX * 3 + s, cellZ, S.thin), and 3*cellX + s ALIASES whenever
        // 3*dcellX = ds: with maxPerCell up to 8 (beachPebble, seagrass, cobble,
        // deep gravel) sub-instance 0 of cell N and sub-instance 3 of cell N-1
        // drew the SAME number and therefore took the same keep/drop decision.
        // Measured over 160,000 cells at keep 0.35: those two decisions agreed
        // 100.00% of the time on the old expression and 54.68% on this one,
        // against the 54.50% two independent draws give - a one-cell-period
        // correlation along X, and nothing along Z to balance it.
        // At keep close to 1 nobody could see it; on a heavily thinned
        // population - which is what any future biomeDensity weight creates, and
        // what the three withdrawn ones created while they were live - it is a
        // visible lattice. hash3 folds x and y through hash2i before the
        // third coordinate, so no (cellX, s) pair collides with another.
        if (thin && hash3(cellX, cellZ, s, S.thin) >= keep) continue;

        visit(localX, localZ, f.height, r0, r1, f.slope, f.nx, f.ny, f.nz, biome);
      }
    }
  }
}

/** Count the points a type offers in a chunk, with no thinning and no terrain. */
function countType(type, cx, cz) {
  let n = 0;
  walkType(type, cx, cz, 1, () => { n++; });
  return n;
}

/**
 * Cheap whole-type rejection for a chunk.
 *
 * The grid already knows the chunk's height extremes, and a type's depth window
 * is the most selective filter in the table - beach grass and abyssal fungus
 * share no chunk anywhere in the world. Expanding the window by the relief the
 * 4 m grid can miss keeps this conservative.
 */
const DEPTH_PREFILTER_MARGIN = 7;

function typePossibleHere(type, lod) {
  if (lod > type.maxLod) return false;
  const depthLo = -_gridMaxH - DEPTH_PREFILTER_MARGIN;
  const depthHi = -_gridMinH + DEPTH_PREFILTER_MARGIN;
  return type.depth[1] >= depthLo && type.depth[0] <= depthHi;
}

// ---------------------------------------------------------------------------
// Instance staging
// ---------------------------------------------------------------------------

const _staging = new ArrayBuffer(SCATTER_MAX_PER_CHUNK * SCATTER_STRIDE);
const _stagingF32 = new Float32Array(_staging);
const _stagingU8 = new Uint8Array(_staging);

/** Counts and offsets returned to the caller. Fresh arrays: they outlive the call. */
function newCounts() { return new Uint32Array(SCATTER_TYPE_COUNT); }

// ---------------------------------------------------------------------------
// Place-local props (world/places.js)
// ---------------------------------------------------------------------------

/**
 * Per-chunk index of authored place-prop instances:
 * 'cx,cz' -> Map(typeId -> [{lx, lz, r0, r1}, ...]).
 *
 * SEEDED BY THE PLACE, NOT BY THE CAMERA AND NOT BY THE WORLD SEED. A place is
 * authored against one seed (its seabedY is a sampled fact about that
 * terrain), so its layout is a constant of the table: hash3 over
 * (place.id, prop.salt, instance index) and nothing else. On a foreign seed
 * the props still emit deterministically - they simply stand on whatever
 * ground that seed grew, exactly as the habitat does.
 *
 * The instances ride the SAME emission path as a walked candidate: they are
 * fed to the per-type visitor with a synthesised (r0, r1), take their height
 * from the chunk's own field grid plus the one exact sampleHeight every drawn
 * instance pays, and their biome from the same biomeAt the mask uses - so
 * tint, glow, sway, flags and the census's biomeOut cannot disagree with a
 * natural instance's. They deliberately BYPASS the walk's biome mask, depth
 * band and slope band: a place is an authored exception (vent chimneys on the
 * abyssal plain are the point), and test-jump asserts each cluster fits
 * inside its place's radius instead.
 */
let _placeChunks = null;

/** Golden angle, radians: spreads a cluster without a lattice. */
const PLACE_SPIRAL = 2.399963229728653;

function bakePlaceChunks() {
  _placeChunks = new Map();
  for (const place of PLACES) {
    if (!place.props) continue;
    for (const prop of place.props) {
      const type = SCATTER_BY_KEY[prop.type];
      if (type === undefined) {
        throw new Error(`places: '${place.short}' prop '${prop.type}' is not a SCATTER_TYPES key`);
      }
      if (!(prop.maxR <= place.radius)) {
        throw new Error(`places: '${place.short}' prop '${prop.type}' reaches ${prop.maxR} m, outside the place's ${place.radius} m radius`);
      }
      const sx = place.id * 8 + prop.salt;
      for (let i = 0; i < prop.count; i++) {
        // sqrt keeps the fill area-uniform; the golden-angle walk plus a
        // hashed jitter keeps siblings apart without a visible lattice.
        const rr = prop.minR + (prop.maxR - prop.minR) * Math.sqrt((i + 0.5) / prop.count);
        const ang = i * PLACE_SPIRAL + hash3(sx, i, 0, 0x9e37) * 0.9;
        const px = place.x + Math.sin(ang) * rr;
        const pz = place.z + Math.cos(ang) * rr;
        const cx = Math.floor(px / CHUNK_SIZE);
        const cz = Math.floor(pz / CHUNK_SIZE);
        const key = cx + ',' + cz;
        let byType = _placeChunks.get(key);
        if (byType === undefined) { byType = new Map(); _placeChunks.set(key, byType); }
        let list = byType.get(type.id);
        if (list === undefined) { list = []; byType.set(type.id, list); }
        list.push({
          lx: px - cx * CHUNK_SIZE,
          lz: pz - cz * CHUNK_SIZE,
          r0: lerp(prop.r0[0], prop.r0[1], hash3(sx, i, 1, 0x51f7)),
          r1: hash3(sx, i, 2, 0x74b3),
        });
      }
    }
  }
}

/**
 * The authored place instances that fall inside one chunk, or null.
 * @param {number} cx @param {number} cz
 * @returns {Map<number, Array>|null} typeId -> instance list
 */
function placePropsFor(cx, cz) {
  if (_placeChunks === null) bakePlaceChunks();
  return _placeChunks.get(cx + ',' + cz) ?? null;
}

/** How many times the global budget has forced a type to be dropped. */
let _degradeCount = 0;
let _degradeLogged = false;

/** Diagnostics for the render pass and the test harness. */
export const scatterStats = {
  chunksGenerated: 0,
  instancesGenerated: 0,
  typesDropped: 0,
  lastGenMs: 0,
  peakGenMs: 0,
  // Times the GLOBAL budget, rather than a type's own maxPerChunk, decided how
  // many of that type survived. It must stay 0 on the shipping table, and
  // tools/test-scatter.mjs section 6 asserts it, because the budget is the one
  // coupling between types: typeCap is min(maxPerChunk, budget - count) and
  // types are emitted most-important-first, so the moment it binds, thinning a
  // high-importance type silently moves which of a LOW-importance type's
  // instances survive. Every appended row and every biomeDensity weight is safe
  // exactly while this is zero.
  budgetBound: 0,
};

/**
 * Generate every scatter instance for one chunk.
 *
 * @param {number} cx chunk X index (world X = cx * WORLD.CHUNK_SIZE)
 * @param {number} cz chunk Z index
 * @param {number} lod terrain LOD ring the chunk sits in; types whose `maxLod`
 *   is below it are not generated at all
 * @param {object} [opts]
 * @param {number} [opts.budget] instances this chunk may use. Defaults to
 *   SCATTER_MAX_PER_CHUNK. When the table would exceed it, whole types are
 *   dropped LOWEST `importance` FIRST - shingle and gravel go before boulders
 *   and crystal spires - and the drop is logged once per session.
 * @param {Uint8Array} [opts.biomeOut] optional array of at least `budget`
 *   entries - it THROWS if it is shorter, because an out-of-range TypedArray
 *   store is a silent no-op and a short array would drop the tail of the
 *   attribution and leave the caller reading zeros, i.e. attributing every one
 *   of those instances to biome 0. Entry `i` receives the biome id the PLACEMENT
 *   LOOP resolved for delivered instance `i`, in the same order the instances
 *   are emitted. Entries at and beyond the returned `count` are whatever the
 *   previous call left there, not zero.
 *
 *   IT IS HERE BECAUSE RE-CLASSIFYING AN EMITTED INSTANCE IS NOT THE SAME
 *   ANSWER. The instance record carries no biome - there is no byte spare and
 *   the shader has no use for one - so an offline census would have to call
 *   biomeAt() again on the emitted position, and that disagrees with the walk on
 *   a measured 15-20% of boundary candidates (see censusTypeByBiome's header for
 *   why: the walk's slope comes from the chunk's own 4 m field grid, and an
 *   exact terrain.sampleSlope is a different number). A per-biome share computed
 *   against a classifier that did not do the placing is contaminated by every
 *   misattributed neighbour. Absent, the whole mechanism is one null test per
 *   emitted instance and the output is byte-identical.
 *
 *   The consumer is tools/scatter-census.mjs, which is the instrument every
 *   Stage 3 acceptance criterion is graded by.
 * @param {boolean} [opts.collidableOnly] emit only rows whose `collidable` flag
 *   is set. The consumer is src/world/scatter_collision.js, which re-bakes a
 *   small ring of chunks around the player and the vessel to build collision
 *   proxies, and has no use for the ~75% of instances that are soft flora and
 *   shingle. SAFE BECAUSE TYPES ARE INDEPENDENT: each type's placement walk is
 *   seeded per (type, chunk) and never reads another type's output, so a
 *   filtered run emits byte-identical instances for the types it keeps - EXCEPT
 *   through the shared `budget`, which types consume in importance order. The
 *   budget has never bound on the shipping table (scatterStats.budgetBound is
 *   asserted 0 by tools/test-scatter.mjs section 6), so in practice the filter
 *   changes nothing about the surviving instances; if it ever binds, a filtered
 *   run may keep a low-importance collidable instance the full run dropped,
 *   which errs on the side of a proxy for a thing that is not drawn - never a
 *   drawn thing with no proxy beyond what the full run already suffers.
 * @returns {{instances: Float32Array, count: number, countsByType: Uint32Array,
 *   firstByType: Uint32Array, dropped: number[], aabb: object, genMs: number,
 *   stride: number}}
 *   `instances` is a fresh Float32Array of `count * 16` floats in the layout
 *   documented at SCATTER_STRIDE. Types are emitted in table order, so each
 *   type's instances are CONTIGUOUS and `firstByType[i]` is the first instance
 *   index of type i - which is what lets the renderer issue one draw per type
 *   with a firstInstance offset instead of one draw per instance run.
 */
export function generateScatterForChunk(cx, cz, lod = 0, opts = {}) {
  ensureSeeds();
  const t0 = performance.now();
  const budget = Math.min(SCATTER_MAX_PER_CHUNK, opts.budget ?? SCATTER_MAX_PER_CHUNK);

  bakeGrid(cx, cz);

  const countsByType = newCounts();
  const firstByType = newCounts();
  const dropped = [];
  const biomeOut = opts.biomeOut ?? null;
  if (biomeOut !== null && biomeOut.length < budget) {
    throw new Error(
      `generateScatterForChunk: opts.biomeOut holds ${biomeOut.length} entries ` +
      `against a budget of ${budget}. A TypedArray store past the end is a silent ` +
      'no-op, so a short array would drop the tail of the attribution rather than ' +
      'report it.');
  }

  // GRACEFUL DEGRADATION IS AN EMISSION ORDER, NOT A PREDICTION.
  //
  // Dropping types up front by comparing the SUM OF THE PER-TYPE CAPS against
  // the budget looked like the safe version and was measurably wrong: the caps
  // are safety valves sized well above what the density table actually produces,
  // their sum exceeds the budget in every reef chunk in the world, and the first
  // chunk generated threw away seagrass, shingle and cobble - three of the four
  // things that make the shallows look alive - to make room for instances that
  // were never going to exist.
  //
  // So nothing is predicted. Types are emitted MOST IMPORTANT FIRST and the cut
  // happens where the budget actually runs out, which in practice is nowhere:
  // measured worst case over 200 varied chunks is well under SCATTER_MAX_PER_CHUNK.
  // If it ever does bind, what it takes is shingle and gravel, and what it keeps
  // is boulders, crystal spires and ore.
  // Authored place props in this chunk, if any. A type a place injects joins
  // the candidate list even where the depth prefilter would reject it - the
  // prefilter reasons about the walk's own depth bands, which place props
  // deliberately bypass - but it still honours the LOD ceiling, so a place
  // prop pops in at exactly the ring its type's natural population would.
  const placeProps = placePropsFor(cx, cz);
  const collidableOnly = opts.collidableOnly === true;
  const candidates = [];
  for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
    const type = SCATTER_TYPES[t];
    if (collidableOnly && !type.collidable) continue;
    const placed = placeProps !== null && placeProps.has(t) && lod <= type.maxLod;
    if (!placed && !typePossibleHere(type, lod)) continue;
    candidates.push(type);
  }
  candidates.sort((a, b) => b.importance - a.importance || a.id - b.id);

  const originX = cx * CHUNK_SIZE;
  const originZ = cz * CHUNK_SIZE;
  let count = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const type of candidates) {
    const S = _S[type.id];
    firstByType[type.id] = count;
    const headroom = budget - count;
    const typeCap = Math.min(type.maxPerChunk, headroom);
    if (typeCap <= 0) { dropped.push(type.id); scatterStats.budgetBound++; continue; }

    const placed = (placeProps !== null && lod <= type.maxLod)
      ? placeProps.get(type.id) ?? null : null;
    buildModGrid(type, cx, cz, S);
    const offered = countType(type, cx, cz);
    if (offered === 0 && placed === null) continue;
    // See scatterStats.budgetBound. The budget only DECIDED anything if it was
    // both the smaller cap and actually below what the chunk offered.
    if (headroom < type.maxPerChunk && offered > headroom) scatterStats.budgetBound++;
    // Thin uniformly rather than truncating. See walkType's header.
    const keep = offered > typeCap ? typeCap / offered : 1;
    let emitted = 0;

    const sxzLo = type.scale[0], sxzHi = type.scale[1];
    const stLo = type.stretch[0], stHi = type.stretch[1];
    // The chunk AABB's per-instance pad (see the emit below). `boundsPad` is
    // an OPTIONAL row field [xz, y] in mesh-local metres at scale 1 for
    // meshes far outside the historical unit-ish envelope; the fallback
    // derives the vertical reach from the row's own authored height with a
    // 1.35 mesh-overshoot margin (kelpStalk authors 10.0 and builds 11.08).
    const padXZ = type.boundsPad ? type.boundsPad[0] : 0;
    const padY = type.boundsPad ? type.boundsPad[1]
      : (type.meshParams && type.meshParams.height ? type.meshParams.height * 1.35 : 0);
    // THE SURFACE CAP (2026-08-18 emerald rebuild). `surfaceCap: metres` on a
    // row clamps each instance's VERTICAL scale so its crown stays that many
    // metres below the waterline - which is what lets a row author a 40-60 m
    // plant with a depth floor far shallower than its own height, the way
    // real canopy kelp grows to the water it has. This REPLACES the static
    // breach rule ("the shallow edge of the depth band must clear the tallest
    // instance") for rows that carry it: the clamp is per instance, off the
    // same conservative `padY` reach the chunk AABB uses (1.35 x authored
    // height, always >= the measured mesh top), so the census's AABB-exact
    // breach audit reads ZERO by construction. sxz is deliberately NOT
    // clamped - a shallow-capped plant grows stout, not miniature - and
    // test-scatter's basis-length assertion checks sxz only.
    const capM = type.surfaceCap;
    const capDen = capM !== undefined ? Math.max(padY - type.sink, 1e-3) : 1;
    const align = type.align;
    const tilt = type.tilt;
    const sink = type.sink;
    const flags =
      (type.ore !== null ? SCATTER_FLAG.HARVESTABLE : 0) |
      (type.collidable ? SCATTER_FLAG.COLLIDABLE : 0) |
      (type.sways ? SCATTER_FLAG.SWAYS : 0) |
      (type.emissive > 0 ? SCATTER_FLAG.EMISSIVE : 0);
    const flagByte = flags & 0xff;
    const typeByte = type.id & 0xff;
    // Sway amplitude is the inverse of stiffness: a rag moves, a stick does
    // not. The per-instance jitter keeps a bed from breathing in lockstep.
    const swayBase = (1 - type.stiffness) * 1.4;
    // Hoisted for the same reason S.bw is hoisted in walkType: 35 of the 59 rows
    // author no tint and 57 author no glow, and they must pay one null test per
    // TYPE rather than one table load per instance. At strength 0 neither table
    // is read at all, which is what makes the bisect lever byte-exact rather
    // than merely close.
    const appStrength = SCATTER_TUNING.biomeAppearanceStrength;
    const bt = appStrength > 0 ? S.bt : null;
    const bg = appStrength > 0 ? S.bg : null;

    const emit = (localX, localZ, gridHeight, r0, r1, slope, nx, ny, nz, biome) => {
      // Probability thinning is a Bernoulli process, so `offered * keep` is a
      // mean and not a guarantee. This is the hard stop for the tail where it
      // overshoots, and it is reached only in the last handful of instances -
      // which is exactly where truncating is invisible.
      if (emitted >= typeCap) return;
      // The one exact heightfield evaluation in the whole pipeline, paid only
      // for a point that is definitely going to be drawn. The grid's own height
      // is 0.35 m RMS off, which floats a cobble visibly.
      const height = terrain.sampleHeight(localX + originX, localZ + originZ);
      // Two stable randoms per point are not enough for scale, stretch, yaw,
      // tilt, tint, phase and variant, so the rest are hashed off the point's
      // integer footprint - which is stable because the footprint is.
      const qx = Math.round(localX * 64) | 0;
      const qz = Math.round(localZ * 64) | 0;
      const h1 = hash2(qx, qz, S.variant);
      const h2 = hash2(qz, qx, S.variant + 977);
      const h3 = hash2(qx ^ 0x5f3a, qz, S.variant + 1861);

      const sxz = lerp(sxzLo, sxzHi, r0);
      let sy = sxz * lerp(stLo, stHi, h1);
      if (capM !== undefined) {
        // height is the floor's y (negative underwater), so -height is the
        // column. Deterministic: a pure function of the sampled height.
        const syMax = (-height - capM) / capDen;
        if (sy > syMax) sy = syMax;
        if (sy <= 0) return;
      }
      const yaw = h2 * TAU;

      // Alignment: rotate the local up from world up toward the surface normal
      // by `align`, then add a hashed tilt. Normalising the linear blend is
      // enough here - the two vectors are never more than ~76 degrees apart
      // (terrain.js's Lipschitz bound), where a lerp and a slerp differ by less
      // than a degree, and this runs per instance.
      let ux = nx * align;
      let uy = 1 - align + ny * align;
      let uz = nz * align;
      if (tilt > 0) {
        // NOT r1. r1 is the density-thinning roll, so every instance that
        // survived has r1 <= mod - typically under 0.3 - and using it here would
        // make tan(tilt * (r1*2 - 1)) negative for almost every instance in the
        // world. A whole seabed of plants leaning the same way is not a subtle
        // artefact, and it comes from reusing one random for two decisions.
        const ta = h3 * TAU;
        const tm = Math.tan(tilt * (h2 * 2 - 1));
        ux += Math.cos(ta) * tm;
        uz += Math.sin(ta) * tm;
      }
      const ulen = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
      ux /= ulen; uy /= ulen; uz /= ulen;

      // Right = up x forward(yaw), then forward = right x up. Using the yaw
      // direction as the reference means the basis is orthonormal for any up.
      const fx0 = Math.sin(yaw), fz0 = Math.cos(yaw);
      let rx = uy * fz0 - uz * 0;
      let ry = uz * fx0 - ux * fz0;
      let rz = ux * 0 - uy * fx0;
      let rlen = Math.sqrt(rx * rx + ry * ry + rz * rz);
      if (rlen < 1e-4) {
        // Up is parallel to the yaw reference. Any perpendicular will do.
        rx = 1; ry = 0; rz = 0; rlen = 1;
      }
      rx /= rlen; ry /= rlen; rz /= rlen;
      const fxv = ry * uz - rz * uy;
      const fyv = rz * ux - rx * uz;
      const fzv = rx * uy - ry * ux;

      const o = count * SCATTER_FLOATS_PER_INSTANCE;
      const y = height - sink * sy;
      _stagingF32[o + 0] = rx * sxz; _stagingF32[o + 1] = ux * sy; _stagingF32[o + 2] = fxv * sxz;
      _stagingF32[o + 3] = localX;
      _stagingF32[o + 4] = ry * sxz; _stagingF32[o + 5] = uy * sy; _stagingF32[o + 6] = fyv * sxz;
      _stagingF32[o + 7] = y;
      _stagingF32[o + 8] = rz * sxz; _stagingF32[o + 9] = uz * sy; _stagingF32[o + 10] = fzv * sxz;
      _stagingF32[o + 11] = localZ;

      // Tint: +/-18% of SHADE around unity, encoded as t/2 so the shader's
      // multiply-by-two recovers a [0,2] multiplier. Deeper instances of the
      // same type are pushed slightly darker, which is real - light-starved
      // tissue carries less pigment - and it stops a 1600 m column of one type
      // from reading as one colour.
      //
      // SHADE, NOT HUE. This used to be three INDEPENDENT hashes, one per
      // channel, which is not a brightness variation at all: it is a random hue
      // rotation of up to about +/-10 degrees plus a random saturation change,
      // applied to a family whose whole point is to read as one colour. On a
      // gorgonian at HSV saturation 0.87 that is the difference between a bed of
      // fans and a bed of assorted plastic. One hash now carries the common-mode
      // brightness and the other two are demoted to a +/-6% warm/cool residual -
      // the same variance in luminance, an eighth of it in hue.
      const shade = 1 - saturate(-height / 1600) * 0.22;
      const sh = (0.82 + 0.36 * h1) * shade;
      let tr = sh * (1 + 0.06 * (h2 * 2 - 1));
      let tg = sh;
      let tb = sh * (1 + 0.06 * (h3 * 2 - 1));
      let ta = 0.55 + 0.45 * h3;
      // THE PER-BIOME LAYER, AND IT SITS HERE BECAUSE THIS IS AFTER THE ACCEPT
      // DECISION. Everything above chose WHERE the instance is; this only
      // chooses what colour it is, off the biome walkType already resolved for
      // the mask. So positions are untouched, no anchor moves, and none of
      // test-scatter's proximity assertions can see it.
      //
      // The per-draw ScatterUniform cannot carry this. It is written once per
      // (chunk x type), and a 128 m chunk spans several biomes - below 150 m the
      // dominant biome changes 39.6-45.9 times per kilometre, median run length
      // 8-16 m - so a per-biome value routed through the uniform would be one
      // biome's colour painted over four.
      if (bt !== null) {
        const q = biome * 3;
        tr *= bt[q] * appStrength + (1 - appStrength);
        tg *= bt[q + 1] * appStrength + (1 - appStrength);
        tb *= bt[q + 2] * appStrength + (1 - appStrength);
      }
      if (bg !== null) ta *= bg[biome] * appStrength + (1 - appStrength);
      const b = (count * SCATTER_STRIDE) + 48;
      // Halved on the way in because the shader doubles on the way out: the
      // saturate must therefore be applied to the HALVED value, or a tint above
      // unity is clipped back to unity and the bright half of the variation
      // silently disappears. BIOME_TINT_CEIL is what keeps a biomeTint from
      // walking a channel into that saturate; it is enforced at bake time, so
      // the arithmetic here is the same as it always was.
      _stagingU8[b + 0] = (saturate(tr * 0.5) * 255 + 0.5) | 0;
      _stagingU8[b + 1] = (saturate(tg * 0.5) * 255 + 0.5) | 0;
      _stagingU8[b + 2] = (saturate(tb * 0.5) * 255 + 0.5) | 0;
      _stagingU8[b + 3] = (saturate(ta) * 255 + 0.5) | 0;

      _stagingF32[o + 13] = h2 * TAU;                    // sway phase
      _stagingF32[o + 14] = swayBase * (0.7 + 0.6 * h1); // sway amplitude

      _stagingU8[b + 12] = (r1 * 255 + 0.5) | 0;         // fade dither
      _stagingU8[b + 13] = typeByte;
      _stagingU8[b + 14] = (h3 * 255 + 0.5) | 0;         // variant
      _stagingU8[b + 15] = flagByte;

      // The census's exact per-instance biome. See opts.biomeOut. Written from
      // the walk's own answer, which is the only one that decided anything.
      if (biomeOut !== null) biomeOut[count] = biome;

      // AABB in ABSOLUTE world space, padded by the instance's own REACH.
      // The old pad assumed every generator normalises into a unit-ish
      // envelope and used max(sxz, sy) + sy*2 - FALSE for every tall mesh,
      // and a real vanish: the frustum test is against this box, so a
      // 46 m platter spire whose chunk box topped 2 m over the seabed
      // disappeared whole the moment the eye looked up past the ground
      // (measured at chunk (14,-2): crown y -52.4 against box top -87.7;
      // an 18 m kelp stalk had the same latent fault at smaller scale).
      // The pad is never allowed SMALLER than the historical one, so no
      // box that used to bound can stop bounding.
      const ax = localX + originX;
      const az = localZ + originZ;
      const rad = Math.max(sxz, sy, padXZ * sxz);
      const reachY = Math.max(sy * 2, padY * sy);
      if (ax - rad < minX) minX = ax - rad;
      if (ax + rad > maxX) maxX = ax + rad;
      if (az - rad < minZ) minZ = az - rad;
      if (az + rad > maxZ) maxZ = az + rad;
      if (y - rad < minY) minY = y - rad;
      if (y + reachY > maxY) maxY = y + reachY;

      count++;
      emitted++;
      countsByType[type.id] = emitted;
    };
    walkType(type, cx, cz, keep, emit);

    // Authored place instances ride the same emitter as a walked candidate,
    // AFTER the natural population so a place cannot displace it under the
    // per-type cap. Field lookups are against the chunk grid bakeGrid()
    // already built; biome is the same per-candidate biomeAt the walk uses,
    // so the census's biomeOut attribution stays one classifier.
    if (placed !== null) {
      for (let pi = 0; pi < placed.length; pi++) {
        const p = placed[pi];
        const f = sampleField(p.lx, p.lz);
        const biome = biomeAt(p.lx + originX, p.lz + originZ, f.height, f.slopeSigned);
        emit(p.lx, p.lz, f.height, p.r0, p.r1, f.slope, f.nx, f.ny, f.nz, biome);
      }
    }
  }

  if (dropped.length > 0) {
    _degradeCount += dropped.length;
    scatterStats.typesDropped = _degradeCount;
    if (!_degradeLogged) {
      _degradeLogged = true;
      console.warn(
        `[scatter] chunk (${cx}, ${cz}) exhausted its ${budget}-instance budget; ` +
        `${dropped.length} least-important type(s) dropped: ` +
        `${dropped.map((id) => SCATTER_TYPES[id].key).join(', ')}. ` +
        'Further drops are counted in scatterStats.typesDropped but not logged.');
    }
  }

  // An empty chunk still needs a valid, non-inverted box.
  if (count === 0) {
    minX = originX; maxX = originX + CHUNK_SIZE;
    minZ = originZ; maxZ = originZ + CHUNK_SIZE;
    minY = _gridMinH; maxY = _gridMaxH;
  }

  const genMs = performance.now() - t0;
  scatterStats.chunksGenerated++;
  scatterStats.instancesGenerated += count;
  scatterStats.lastGenMs = genMs;
  if (genMs > scatterStats.peakGenMs) scatterStats.peakGenMs = genMs;

  return {
    instances: _stagingF32.slice(0, count * SCATTER_FLOATS_PER_INSTANCE),
    count,
    countsByType,
    firstByType,
    dropped,
    aabb: { minX, minY, minZ, maxX, maxY, maxZ },
    genMs,
    stride: SCATTER_STRIDE,
  };
}

/**
 * Every minable node in a chunk, for the mining system.
 *
 * This goes through the SAME walkType() the renderer's instances come from, so
 * a node the player drills is exactly the node they are looking at. Only the
 * ore-bearing types are walked, and they are the sparsest in the table, so this
 * is a fraction of a full generateScatterForChunk().
 *
 * @param {number} cx chunk X index
 * @param {number} cz chunk Z index
 * @returns {Array<{position: number[], materialId: number, amount: number,
 *   typeId: number, scale: number}>} positions are ABSOLUTE world metres
 */
export function oreNodesInChunk(cx, cz) {
  ensureSeeds();
  bakeGrid(cx, cz);
  const originX = cx * CHUNK_SIZE;
  const originZ = cz * CHUNK_SIZE;
  const out = [];

  for (const type of ORE_TYPES) {
    if (!typePossibleHere(type, 0)) continue;
    const S = _S[type.id];
    const amtLo = type.ore.amount[0], amtHi = type.ore.amount[1];
    buildModGrid(type, cx, cz, S);
    // The SAME thinning the renderer applies, so a node in this list is a node
    // that is on screen. An ore type's offered count is a tenth of its cap, so
    // this is normally 1 and the second walk is the only one that runs.
    const offered = countType(type, cx, cz);
    if (offered === 0) continue;
    const keep = offered > type.maxPerChunk ? type.maxPerChunk / offered : 1;
    walkType(type, cx, cz, keep, (localX, localZ, gridHeight, r0, r1) => {
      const qx = Math.round(localX * 64) | 0;
      const qz = Math.round(localZ * 64) | 0;
      const h1 = hash2(qx, qz, S.variant);
      const sxz = lerp(type.scale[0], type.scale[1], r0);
      const sy = sxz * lerp(type.stretch[0], type.stretch[1], h1);
      const height = terrain.sampleHeight(localX + originX, localZ + originZ);
      // Amount scales with the node's size, which is the honest reading of a big
      // rock holding more ore than a small one - and it means a player who learns
      // to spot the big ones is right to.
      const size = saturate((sxz - type.scale[0]) / Math.max(type.scale[1] - type.scale[0], 1e-4));
      out.push({
        position: [originX + localX, height - type.sink * sy, originZ + localZ],
        materialId: type.ore.materialId,
        amount: Math.round(lerp(amtLo, amtHi, size)),
        typeId: type.id,
        scale: sxz,
      });
    });
  }
  return out;
}

/**
 * Count one type's OFFERED placements in a chunk, bucketed by the biome the
 * placement loop itself resolved.
 *
 * THE BUCKET IS THE FILTER'S OWN ANSWER, and that is the entire reason this
 * exists rather than a caller re-classifying finished instances with
 * biomeAt(x, z, sampleHeight, sampleSlope). walkType classifies against the 4 m
 * field grid's SIGNED slope, and a point sample of the real slope disagrees with
 * it on a measured 15-20% of boundary candidates (see the note above
 * _gridHeight, and section 5 of tools/test-scatter.mjs). Attributing a
 * per-biome density weight against a classifier that is not the one that applied
 * it turns a 0.35 into a number contaminated by every misattributed neighbour.
 *
 * OFFERED, NOT DELIVERED: it walks with keep = 1, so the per-chunk cap and the
 * global budget are excluded. That is the quantity a `biomeDensity` weight
 * multiplies, which is what makes "delivered / baseline == the authored weight"
 * a testable claim.
 *
 * @param {number} typeId SCATTER_TYPES index
 * @param {number} cx chunk X index
 * @param {number} cz chunk Z index
 * @param {Uint32Array} [out] length BIOME_COUNT, reused and zeroed if given
 * @returns {Uint32Array} counts indexed by biome id
 */
export function censusTypeByBiome(typeId, cx, cz, out) {
  ensureSeeds();
  const counts = out ?? new Uint32Array(BIOME_COUNT);
  counts.fill(0);
  const type = SCATTER_TYPES[typeId];
  bakeGrid(cx, cz);
  buildModGrid(type, cx, cz, _S[typeId]);
  walkType(type, cx, cz, 1,
    (localX, localZ, gridHeight, r0, r1, slope, nx, ny, nz, biome) => { counts[biome]++; });
  return counts;
}

/**
 * The height, slope and normal the PLACEMENT LOOP would see at one chunk-local
 * point - the chunk's own baked 4 m field grid, not an exact terrain sample.
 *
 * IT EXISTS SO A CENSUS'S NUMERATOR AND DENOMINATOR CANNOT DISAGREE. Turning a
 * per-biome instance count into an areal density needs the AREA each biome holds
 * in the same chunks, and the obvious way to get it - biomeAt() over a lattice,
 * fed terrain.sampleHeight and terrain.sampleSlope - is a DIFFERENT CLASSIFIER
 * from the one that placed the instances. sampleField()'s own header measures
 * the gap: the two agree on 76.6% of samples, and substituting the exact slope
 * alone recovers 23.19% of the disagreement. A density built from an exact-slope
 * area under a grid-slope count is biased by that whole residual, in a direction
 * that varies per biome with how much sub-4 m relief it carries - which is the
 * worst possible property for a number that is compared across biomes.
 *
 * So the census asks for the placement loop's own field and calls biomeAt with
 * `slopeSigned` exactly as walkType does. It is then measuring the world the
 * scatter was actually placed in, and the residual cancels.
 *
 * IT SHARES generateScatterForChunk's SINGLE-SLOT GRID CACHE, and that is a
 * performance cliff with no other sign on it: sampling the chunk you have just
 * generated is free, and alternating between two chunks re-bakes 1,225
 * `sampleHeightFast` samples on every call - about 770 us. Walk one chunk's
 * points together.
 *
 * @param {number} cx chunk X index
 * @param {number} cz chunk Z index
 * @param {number} localX 0..CHUNK_SIZE
 * @param {number} localZ 0..CHUNK_SIZE
 * @param {object} [out] reused; a fresh object is allocated if absent
 * @returns {{height: number, slope: number, slopeSigned: number,
 *   nx: number, ny: number, nz: number}} COPIED out of the module's shared
 *   record, so the caller may hold it across another call
 */
export function sampleChunkField(cx, cz, localX, localZ, out) {
  ensureSeeds();
  bakeGrid(cx, cz);
  const f = sampleField(localX, localZ);
  const o = out ?? { height: 0, slope: 0, slopeSigned: 0, nx: 0, ny: 1, nz: 0 };
  o.height = f.height;
  o.slope = f.slope;
  o.slopeSigned = f.slopeSigned;
  o.nx = f.nx; o.ny = f.ny; o.nz = f.nz;
  return o;
}

/**
 * LOD ring for a chunk whose NEAREST POINT is `dist` metres away.
 *
 * Nearest point, not centre. `maxLod` deletes a whole type, so the only question
 * the ring has to answer is "how close can anything in this chunk get to the
 * eye" - and a 128 m chunk's centre is up to a half-diagonal (90.5 m) further
 * off than its near corner, which is enough to delete the seagrass out of the
 * chunk the player is standing at the edge of. Measuring to the box removes that
 * slop entirely and makes WORLD.SCATTER_LOD_BASE_DISTANCE independent of
 * CHUNK_SIZE, so the ring survives a change to either one.
 *
 * That constant is deliberately not WORLD.LOD_BASE_DISTANCE: the terrain ring is
 * about triangle density and is free to move without taking the seabed's
 * vegetation with it.
 * @param {number} dist metres from the camera to the chunk's nearest point
 */
export function scatterLodFor(dist) {
  for (let l = 0; l < WORLD.LOD_RINGS; l++) {
    if (dist < WORLD.SCATTER_LOD_BASE_DISTANCE * Math.pow(2, l)) return l;
  }
  return WORLD.LOD_RINGS - 1;
}

/** Reset the degradation log, so a test can assert it fires. */
export function resetScatterStats() {
  _degradeCount = 0;
  _degradeLogged = false;
  scatterStats.chunksGenerated = 0;
  scatterStats.instancesGenerated = 0;
  scatterStats.typesDropped = 0;
  scatterStats.lastGenMs = 0;
  scatterStats.peakGenMs = 0;
  scatterStats.budgetBound = 0;
}

/** Invalidate the cached field grid. Tests that change the seed need this. */
export function invalidateScatterCache() {
  _gridCx = Infinity;
  _gridCz = Infinity;
}

/**
 * Total instances RENDER.MAX_SCATTER_INSTANCES allows, exposed so the render
 * pass and the test agree on one number.
 */
export const SCATTER_GLOBAL_CAP = RENDER.MAX_SCATTER_INSTANCES;
