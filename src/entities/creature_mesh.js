/**
 * SUBWAVE creature geometry - every animal in the bestiary, grown from numbers.
 *
 * One entry point, buildCreatureMesh(species, seed), turns a SPECIES record
 * from bestiary.js into a SKINNED mesh: a lofted trunk, parts merged onto it,
 * a bone chain, per-vertex bone indices and weights, and a bioluminescence mask
 * that reads as spots, stripes, rows or a single lure point rather than as a
 * uniformly glowing animal.
 *
 * WHY A LOFT AND NOT A SIGNED-DISTANCE FIELD. DESIGN/06 06.4 quotes SDF_MC for
 * eight of the heads, and marching cubes over a compact SDF would give better
 * anatomy - but it also gives an unstructured triangle soup with no (u, theta)
 * parameterisation, and the parameterisation is what every other system here
 * needs: the spine coordinate u binds the skin to the bone chain, and the
 * around-the-body coordinate theta places photophores. Lofting cross-sections
 * along a spine spline gives both for free, so the whole file is one loft plus
 * two workhorses (addFin, addTube) and a placement table.
 *
 * THE FOUR CONTRACTS, matching src/world/meshgen.js:
 *
 *   1. DETERMINISM. Output is a pure function of (species, seed). No Math.random,
 *      no clock. The same seed gives byte-identical arrays forever, because the
 *      renderer caches one mesh per species and the QA harness diffs them.
 *
 *   2. SKIN WEIGHTS SUM TO ONE. Every vertex carries up to four influences in
 *      `boneIndices` / `boneWeights`; two are used in practice (the loft blends
 *      between adjacent spine bones, rigid parts bind to one bone at weight 1).
 *      A vertex whose weights do not sum to 1 collapses toward the origin the
 *      moment the animation moves, which looks like the mesh tearing.
 *
 *   3. BIOLUM MASK IN colors[i * 4 + 3]. meshgen puts a plant's sway weight
 *      there; a creature does not sway, so the same channel carries the
 *      bioluminescence mask - DESIGN/06 06.3.6's `extra.y`. `emissive` carries
 *      the HDR colour that mask multiplies, so a shader needs one fetch.
 *
 *   4. BONE BUDGET. RENDER.MAX_BONES_PER_CREATURE is 24, total, including the
 *      jaw and lure bones. DESIGN/06 asks for 32 (48 for leviathans) and does
 *      not get them; the spine count is reduced to fit rather than the parts
 *      being dropped, because a leviathan with a coarser spine wave still reads
 *      correctly and a leviathan whose jaw cannot open does not.
 *
 * Vertex budgets, by species length and body plan, enforced by
 * creatureVertexBudget() and asserted in tools/test-bestiary.mjs. Measured LOD0
 * counts sit under them with room: a Coppersprat is 308 verts against a 400
 * budget, a Hollowjaw 1,254 against 6,000, a Nethercoil 2,042, and the whole
 * 37-species roster is 24,017 verts and 33,526 triangles. They are far below the
 * design's quoted counts (21,000 for a Hollowjaw alone) because those assume
 * displacement-mapped skin and hundreds of instanced parasites; here the
 * geometry carries the silhouette and the shader carries the detail.
 *
 * Model space: -Z is FORWARD (the snout), +Y is up, +X is the animal's left.
 * Same convention as src/entities/vessel_mesh.js. Sessile species (tube worms,
 * gastropods, urchins) build along +Y instead and say so in their body plan.
 */

import {
  vec3, mat4, quat, clamp, saturate, lerp, smoothstep, TAU, PI, hash2i,
} from '../core/math.js';
import { RENDER } from '../core/constants.js';
import { simplex2, hash2 } from '../world/noise.js';
import {
  MeshBuilder, MESH_MATERIAL, uvSphere, lathe, cone, extrudeAlongSpline,
} from '../world/meshgen.js';
import { BIOLUM_PATTERN } from './bestiary.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Total bones per creature: spine chain plus the jaw and lure bones. */
export const CREATURE_MAX_BONES = RENDER.MAX_BONES_PER_CREATURE;

/** Influences stored per vertex. Two are used; four is the GPU layout. */
export const CREATURE_INFLUENCES = 4;

/**
 * Bone roles. The animation layer drives them differently: SPINE bones carry
 * the travelling wave, the JAW bone carries jawOpen(), the LURE bone carries a
 * damped-spring bob so the esca drifts, and a MANDIBLE bone folds one horn
 * about the axis TANGENTIAL to its own radial - which is what makes four of
 * them a flare rather than the shared downward scoop a single hinge gives.
 * A MANDIBLE bone carries its horn's radial angle on `radial`, and that is the
 * only role whose rest record needs a fourth number.
 */
export const BONE_ROLE = Object.freeze({ SPINE: 0, JAW: 1, LURE: 2, MANDIBLE: 3 });

/**
 * Material assignment. Reuses meshgen's three-bit slots so a creature and a
 * kelp blade can share a pipeline:
 *
 *   FLORA        opaque tissue - skin, mantle, muscle
 *   TRANSLUCENT  thin tissue lit with brdf.wgsl evalTranslucency - fins, jelly
 *                bells, baleen, membranous wings
 *   EMISSIVE     photophores and lures; almost no direct response to light
 *   BONE         carapace, teeth, shell, keratin ridges
 *   CRYSTAL      eyes; a tight specular lobe over a dark iris is what makes an
 *                eye read as wet rather than as a painted dot
 *   METAL        the Nethercoil's armour, which the design specifies as matte
 *                black with a metallic sheen at grazing angles only
 */
const M = MESH_MATERIAL;

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/**
 * IEC 61966-2-1 sRGB -> linear. Duplicated from meshgen.js, which does not
 * export it, because authoring 37 animals' albedos as linear floats by hand is
 * how you end up with a bestiary that is uniformly too bright.
 */
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** Linear RGB from an 8-bit sRGB triple. */
const rgb = (r, g, b) => Float32Array.of(srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255), 0);

/** Scratch colour handed to addVertex; never retained. */
const _col = Float32Array.of(1, 1, 1, 0);

/**
 * Counter-shading: dark dorsum, pale belly. Real fish do this and it is the
 * cheapest way to make a single-tint animal read as a volume rather than as a
 * flat shape, because it puts a value gradient across the silhouette that
 * survives the water column's channel-by-channel extinction.
 *
 * `ventralness` is 1 at the belly and 0 at the back.
 */
function shade(out, tint, ventral, ventralness) {
  const t = smoothstep(0.18, 0.92, ventralness);
  out[0] = lerp(tint[0], ventral[0], t);
  out[1] = lerp(tint[1], ventral[1], t);
  out[2] = lerp(tint[2], ventral[2], t);
  out[3] = 0;
  return out;
}

/** Default belly tint: the dorsal tint lifted toward a pale neutral. */
function ventralOf(tint) {
  return Float32Array.of(
    lerp(tint[0], 0.62, 0.55), lerp(tint[1], 0.64, 0.55), lerp(tint[2], 0.66, 0.55), 0,
  );
}

/**
 * ALBEDO pattern kinds, for `meshRecipe.pattern.kind`.
 *
 * Distinct from BIOLUM_PATTERN, which is a mask on light the animal EMITS.
 * These are pigment: bars, stripes, saddles, eye masks, spots and ocelli - the
 * marks that make a reef fish read as a reef fish. Until this existed, shade()
 * was the whole of body colour - one smoothstep from `tint` to `ventral` - so a
 * Sunplate whose own datasheet says "vertical bands of chrome yellow and
 * blue-black" rendered as a flat pale-cream disc, verified by planting one
 * 1.9 m from the camera.
 *
 * THE MASK IS EVALUATED IN THE FRAGMENT SHADER, not baked into vertex colour.
 * A bar is a hard edge, and a hard edge painted per vertex is bounded below by
 * the loft's RING SPACING: a Coppersprat's trunk is eight rings, so four bars
 * would be 0.9 rings apart and simply land between samples. The values below
 * are the CONTRACT between this file and pass/creature.wgsl's
 * `albedoPatternMask()`; the numeric ordering is what crosses the wire, and
 * tools/test-bestiary.mjs section 16 asserts the shader declares the same
 * AP_* constants with the same values.
 */
export const ALBEDO_PATTERN = Object.freeze({
  /** Vertical bars across the body: a hard edge in u. Butterflyfish, Sunplate. */
  BANDS: 'bands',
  /** One band down each flank at the widest part of the section. */
  STRIPE: 'stripe',
  /** Dorsal patches: bars gated to the back. A brindled or saddled fish. */
  SADDLES: 'saddles',
  /** A bar through the eye and a second at the tail root. */
  EYE_MASK: 'eyeMask',
  /** A jittered dot field over the flank. */
  SPOTS: 'spots',
  /** One ringed ocellus near the tail root - the pale ring is the mask's
   *  negative half. */
  EYESPOT: 'eyespot',
});

/** Every legal `pattern.kind`, for the bestiary validator. */
export const ALBEDO_PATTERN_LIST = Object.freeze(Object.values(ALBEDO_PATTERN));

/**
 * `ALBEDO_PATTERN` as the integers the shader switches on. BINDING: these are
 * the values written into the species animation block.
 */
export const ALBEDO_PATTERN_ID = Object.freeze({
  none: 0, bands: 1, stripe: 2, saddles: 3, eyeMask: 4, spots: 5, eyespot: 6,
});

/**
 * Default share of one pattern repeat that is pigment.
 *
 * A third, because a banded reef fish is more ground colour than bar - and
 * because the bar has to stay wide enough to survive fwidth-based antialiasing
 * at the range the animal is actually seen at. A 0.34 m fish at 10 m is 20 px
 * tall on a 1600 x 758 frame, so four bars at duty 0.34 are 1.7 px of pigment
 * each: that is the point where the shader's `edge()` starts folding them
 * toward the mean, which is the correct behaviour and is why the duty is not
 * smaller.
 */
const PATTERN_DUTY = 0.34;

/**
 * Ceiling on the pattern mask.
 *
 * A band is pigment layered OVER skin, not a hole cut in it, so the ground
 * colour always shows through a little - which is also what keeps every vertex
 * responsive to the datasheet tint (tools/test-bestiary.mjs section 12 asserts
 * that, and it is a real check: a pattern that fully replaced the albedo would
 * make a third of the animal deaf to its own record).
 */
const PATTERN_MAX = 0.88;

/**
 * Translate `meshRecipe.pattern` into the eight floats the species animation
 * block carries. Called once per species at mesh-library build time.
 *
 * @param {object} species a bestiary ROSTER record
 * @returns {{kind:number,count:number,duty:number,strength:number,
 *            colour:Float32Array,roughness:number}}
 */
export function albedoPatternParams(species) {
  const spec = species.meshRecipe?.pattern;
  const off = {
    kind: 0, count: 0, duty: 0, strength: 0, colour: rgb(0, 0, 0), roughness: 0.4,
  };
  if (!spec) return off;
  const kind = ALBEDO_PATTERN_ID[spec.kind];
  if (!kind) return off;
  return {
    kind,
    count: spec.count ?? 4,
    duty: clamp(spec.duty ?? PATTERN_DUTY, 0.05, 0.9),
    strength: clamp(spec.strength ?? PATTERN_MAX, 0, 1),
    colour: rgb(spec.colour[0], spec.colour[1], spec.colour[2]),
    // Wet skin is 0.34-0.52 in skinSurface(). A mirror stripe is the one thing
    // that wants to be glossier than the fish it is on: the Coppersprat's
    // datasheet read is a flash on the turn, which is a specular event.
    roughness: clamp(spec.roughness ?? 0.42, 0.04, 1),
  };
}

// ---------------------------------------------------------------------------
// Body plans
// ---------------------------------------------------------------------------

/**
 * Station tables. Each row is `[u, aShape, bShape, ycShape, n]`:
 *
 *   u       0 at the snout, 1 at the tail tip
 *   aShape  half-WIDTH as a fraction of the plan's peak, so the peak is 1.0 and
 *           `meshRecipe.girth` scales the whole curve
 *   bShape  half-HEIGHT, same normalisation against `meshRecipe.depth`
 *   ycShape vertical offset of the section centre, in units of half-height -
 *           this is the spine's own bow, and it is what makes a head sit above
 *           the tail's axis instead of the whole animal being a straight tube
 *   n       superellipse exponent: 2 is an ellipse, 3.4 is slab-sided. A high n
 *           amidships and a low n at the ends is exactly the profile that makes
 *           a leviathan read as armoured and a sprat as soft
 */
const T_FUSIFORM = [
  [0.00, 0.02, 0.03, 0.00, 2.4], [0.08, 0.42, 0.52, 0.05, 2.6],
  [0.18, 0.76, 0.86, 0.04, 2.8], [0.32, 1.00, 1.00, 0.00, 2.8],
  [0.50, 0.90, 0.90, -0.02, 2.7], [0.68, 0.62, 0.64, -0.02, 2.6],
  [0.84, 0.34, 0.38, 0.00, 2.5], [0.94, 0.16, 0.22, 0.02, 2.4],
  [1.00, 0.05, 0.09, 0.04, 2.4],
];

const T_COMPRESSED = [
  [0.00, 0.04, 0.05, 0.00, 2.4], [0.07, 0.40, 0.46, 0.10, 2.6],
  [0.16, 0.72, 0.80, 0.06, 2.8], [0.30, 0.96, 1.00, 0.00, 3.0],
  [0.46, 1.00, 0.96, -0.04, 3.0], [0.62, 0.80, 0.74, -0.04, 2.8],
  [0.78, 0.52, 0.48, -0.02, 2.6], [0.90, 0.28, 0.26, 0.00, 2.5],
  [1.00, 0.08, 0.10, 0.02, 2.4],
];

const T_DISC = [
  [0.00, 0.06, 0.06, 0.00, 2.4], [0.06, 0.34, 0.40, 0.02, 2.6],
  [0.14, 0.62, 0.72, 0.00, 2.8], [0.26, 0.86, 0.94, 0.00, 3.2],
  [0.42, 1.00, 1.00, 0.00, 3.4], [0.58, 0.96, 0.96, 0.00, 3.4],
  [0.72, 0.76, 0.78, 0.00, 3.0], [0.86, 0.44, 0.46, 0.00, 2.7],
  [0.95, 0.20, 0.22, 0.00, 2.5], [1.00, 0.07, 0.08, 0.00, 2.4],
];

const T_EEL = [
  [0.00, 0.30, 0.34, 0.00, 2.6], [0.05, 0.78, 0.82, 0.03, 2.8],
  [0.12, 1.00, 1.00, 0.02, 2.8], [0.30, 0.92, 0.96, 0.00, 2.6],
  [0.55, 0.80, 0.92, 0.00, 2.5], [0.75, 0.62, 0.84, 0.00, 2.4],
  [0.90, 0.38, 0.62, 0.00, 2.3], [1.00, 0.06, 0.22, 0.00, 2.2],
];

const T_GLOBULAR = [
  [0.00, 0.30, 0.32, 0.00, 2.6], [0.10, 0.72, 0.76, 0.00, 2.8],
  [0.26, 0.96, 1.00, 0.02, 2.9], [0.46, 1.00, 0.96, 0.00, 2.9],
  [0.66, 0.74, 0.70, -0.02, 2.7], [0.84, 0.40, 0.38, 0.00, 2.5],
  [1.00, 0.08, 0.10, 0.02, 2.4],
];

const T_WHALE = [
  [0.00, 0.24, 0.26, 0.00, 2.8], [0.06, 0.62, 0.66, 0.02, 3.0],
  [0.14, 0.88, 0.94, 0.03, 3.2], [0.26, 1.00, 1.00, 0.00, 3.2],
  [0.44, 0.94, 0.92, -0.02, 3.0], [0.62, 0.74, 0.72, -0.02, 2.8],
  [0.78, 0.52, 0.50, 0.00, 2.6], [0.90, 0.30, 0.30, 0.02, 2.5],
  [1.00, 0.06, 0.12, 0.04, 2.4],
];

const T_SEGMENTED = [
  [0.00, 0.35, 0.36, 0.00, 3.0], [0.04, 0.88, 0.90, 0.00, 3.2],
  [0.10, 1.00, 1.00, 0.00, 3.4], [0.50, 0.96, 0.96, 0.00, 3.4],
  [0.80, 0.80, 0.80, 0.00, 3.2], [0.94, 0.46, 0.46, 0.00, 3.0],
  [1.00, 0.06, 0.06, 0.00, 2.6],
];

/**
 * The splitmaw-class profile (2026-08-19, built for the Splitmaw): a real SKULL
 * MASS instead of the Gaussian bump that made every earlier leviathan read as
 * a blimp - blunt armoured head peaking at u 0.10, a genuine post-cranial
 * pinch at 0.17 so the head reads as a HEAD, a muscular chest at 0.28, and
 * then the long anguilliform taper that is more than half the animal: the
 * reference silhouette is one third predator, two thirds tail. High
 * superellipse exponents through the skull (armour), soft at the tail tip.
 */
const T_SPLITMAW = [
  // Blunt bullet nose (0.30/0.72 from a first cut at 0.18/0.58 whose long
  // solid cone hid the whole jaw assembly under the chin - head-on the
  // animal delivered a featureless white radish; the reference's head IS
  // its mouth, so the trunk must get out of the maw's way fast).
  [0.00, 0.20, 0.24, 0.10, 2.8], [0.035, 0.52, 0.60, 0.09, 3.0],
  [0.10, 0.92, 1.00, 0.07, 3.3], [0.17, 0.78, 0.86, 0.04, 3.0],
  [0.28, 1.00, 0.98, 0.00, 3.0], [0.40, 0.84, 0.86, -0.02, 2.8],
  // Tail widths: the ladder ran fat-to-thin twice. 0.60/0.40/0.24/0.12
  // vanished into the haze at 95 m; the 0.68/0.50/0.32/0.17 correction made
  // the REAR half the animal's visual mass and the creature review read it
  // tail-first ("plump pastel prey"). These sit between: the taper starts
  // at mid-body and the tail is thin but still present at silhouette range.
  [0.54, 0.60, 0.66, -0.02, 2.6], [0.70, 0.42, 0.50, 0.00, 2.5],
  [0.84, 0.26, 0.35, 0.00, 2.4], [0.94, 0.14, 0.21, 0.02, 2.3],
  [1.00, 0.05, 0.10, 0.04, 2.2],
];

const T_CRUSTACEAN = [
  [0.00, 0.62, 0.55, 0.05, 3.2], [0.16, 0.95, 0.90, 0.06, 3.4],
  [0.34, 1.00, 1.00, 0.04, 3.6], [0.52, 0.88, 0.82, 0.00, 3.2],
  [0.70, 0.62, 0.58, -0.02, 3.0], [0.86, 0.40, 0.38, -0.02, 2.8],
  [1.00, 0.16, 0.16, 0.00, 2.6],
];

const T_WALKER = [
  [0.00, 0.34, 0.32, 0.06, 2.8], [0.10, 0.66, 0.64, 0.08, 3.0],
  [0.24, 0.92, 0.92, 0.06, 3.2], [0.46, 1.00, 1.00, 0.02, 3.2],
  [0.68, 0.90, 0.88, 0.00, 3.0], [0.86, 0.62, 0.58, -0.02, 2.8],
  [1.00, 0.24, 0.22, 0.00, 2.6],
];

const T_FLYER = [
  [0.00, 0.16, 0.18, 0.02, 2.5], [0.10, 0.56, 0.62, 0.06, 2.7],
  [0.24, 0.92, 1.00, 0.04, 2.9], [0.44, 1.00, 0.94, 0.00, 2.9],
  [0.66, 0.74, 0.68, 0.00, 2.7], [0.86, 0.40, 0.36, 0.00, 2.5],
  [1.00, 0.10, 0.10, 0.00, 2.4],
];

const T_SQUID = [
  [0.00, 0.04, 0.04, 0.00, 2.4], [0.14, 0.52, 0.54, 0.00, 2.6],
  [0.34, 0.86, 0.88, 0.00, 2.8], [0.55, 1.00, 1.00, 0.00, 2.8],
  [0.74, 0.92, 0.94, 0.00, 2.7], [0.88, 0.80, 0.86, 0.00, 2.7],
  [1.00, 0.48, 0.52, 0.00, 2.6],
];

const T_TUBE = [
  [0.00, 1.00, 1.00, 0.00, 3.0], [0.30, 0.92, 0.92, 0.00, 3.0],
  [0.70, 0.84, 0.84, 0.00, 2.9], [1.00, 0.76, 0.76, 0.00, 2.8],
];

/**
 * Fallback dome for a plan whose visible geometry is a lathe but which carries
 * no lathe descriptor - today only the Chainlight, whose trunk is a stack of
 * nectophores strung on a stem. The three plans that DO carry one (bell, shell,
 * test) get a table generated from the lathe itself; see makeShape.
 */
const T_DOME = [
  [0.00, 1.00, 1.00, 0.00, 2.2], [0.30, 0.92, 0.92, 0.00, 2.2],
  [0.60, 0.72, 0.72, 0.00, 2.2], [0.85, 0.42, 0.42, 0.00, 2.2],
  [1.00, 0.06, 0.06, 0.00, 2.2],
];

/**
 * Body plans. `table` is the station table, `axis` is which way the trunk runs
 * ('z' = swimming, -Z forward; 'y' = sessile, growing up from the seabed),
 * `trunk` is the fraction of the species length the lofted trunk occupies -
 * the remainder is trailing arms or tentacles, which the bone chain still
 * covers so they whip when the spine wave travels.
 */
export const BODY_PLAN = Object.freeze({
  fusiform: { table: T_FUSIFORM, axis: 'z', trunk: 1.00 },
  compressed: { table: T_COMPRESSED, axis: 'z', trunk: 1.00 },
  disc: { table: T_DISC, axis: 'z', trunk: 1.00 },
  eel: { table: T_EEL, axis: 'z', trunk: 1.00 },
  globular: { table: T_GLOBULAR, axis: 'z', trunk: 1.00 },
  whale: { table: T_WHALE, axis: 'z', trunk: 1.00 },
  segmented: { table: T_SEGMENTED, axis: 'z', trunk: 1.00 },
  splitmaw: { table: T_SPLITMAW, axis: 'z', trunk: 1.00 },
  crustacean: { table: T_CRUSTACEAN, axis: 'z', trunk: 1.00 },
  walker: { table: T_WALKER, axis: 'z', trunk: 1.00 },
  flyer: { table: T_FLYER, axis: 'z', trunk: 1.00 },
  squid: { table: T_SQUID, axis: 'z', trunk: 0.42 },
  tube: { table: T_TUBE, axis: 'y', trunk: 1.00 },
  ray: { table: null, axis: 'z', trunk: 1.00 },     // plan generated from discExponent
  bell: { table: T_DOME, axis: 'z', trunk: 0.28 },  // visible trunk is the lathed bell
  shell: { table: T_DOME, axis: 'y', trunk: 1.00 }, // visible trunk is the lathed shell
});

/** Body plan names, for a record that wants to validate its own `plan`. */
export const BODY_PLAN_NAMES = Object.freeze(Object.keys(BODY_PLAN));

/**
 * Every key a `meshRecipe` may carry. Exported so tools/test-bestiary.mjs can
 * fail on an unknown one: a misspelled recipe field is otherwise silently
 * ignored, and a silently ignored field is a stub with good manners.
 */
export const RECIPE_KEYS = Object.freeze(new Set([
  'plan', 'spineBones', 'girth', 'depth', 'rings', 'segs', 'tint', 'ventral',
  'biolumCount', 'trunk', 'pattern',
  // fins
  'dorsalFin', 'analFin', 'caudal', 'pectoral', 'fluke', 'fins', 'wings',
  'crest', 'ridge', 'flaps', 'plume', 'pleopods', 'uropods',
  // tubes
  'arms', 'clubs', 'tentacles', 'oralArms', 'filaments', 'streamers', 'barbels',
  'antennae', 'eyestalks', 'legs', 'tail', 'stem', 'lure',
  // solids
  'jaw', 'eyes', 'claws', 'spines', 'lateralSpines', 'organs', 'cephalicLobes',
  'house', 'snout', 'beak', 'oralDisc', 'nectophores', 'bell', 'shell', 'foot',
  'test', 'mantle', 'mandibles',
  // trunk modifiers
  'hump', 'occiput', 'melon', 'plates', 'plateLip', 'carapaceLift', 'lean',
  'discExponent', 'inflate', 'skinRoughnessBias',
]));

// ---------------------------------------------------------------------------
// Resolution tiers
// ---------------------------------------------------------------------------

/**
 * Resolution and vertex budget by species length. `decimate` scales every
 * instanced sub-part count (teeth, spines, barnacle-scale detail) so a 0.28 m
 * urchin does not spend a 1.15 m animal's budget on forty spines.
 */
const SIZE_TIERS = [
  { max: 0.05, budget: 140, rings: 5, segs: 5, fin: 2, tubeSt: 3, tubeSides: 4, eye: [4, 3], tooth: 3, decimate: 0.30 },
  { max: 0.50, budget: 400, rings: 8, segs: 8, fin: 3, tubeSt: 4, tubeSides: 4, eye: [5, 4], tooth: 3, decimate: 0.50 },
  { max: 2.00, budget: 1200, rings: 11, segs: 10, fin: 4, tubeSt: 5, tubeSides: 5, eye: [6, 4], tooth: 3, decimate: 0.72 },
  { max: 6.00, budget: 2200, rings: 14, segs: 12, fin: 5, tubeSt: 6, tubeSides: 5, eye: [8, 5], tooth: 4, decimate: 0.88 },
  { max: 20.0, budget: 4000, rings: 18, segs: 16, fin: 6, tubeSt: 7, tubeSides: 6, eye: [8, 6], tooth: 4, decimate: 1.00 },
  { max: Infinity, budget: 6000, rings: 22, segs: 18, fin: 7, tubeSt: 8, tubeSides: 6, eye: [10, 6], tooth: 4, decimate: 1.00 },
];

/** The tier a length falls into. */
function tierFor(length) {
  for (const t of SIZE_TIERS) if (length < t.max) return t;
  return SIZE_TIERS[SIZE_TIERS.length - 1];
}

/**
 * Budget multiplier per body plan.
 *
 * The tier numbers above are for a FISH: a lofted trunk, five fins, two eyes.
 * A limbed animal pays for its limbs and there is no honest way around it -
 * measured, eight two-segment legs, two lathed chelae and two eyestalks are 82%
 * of a Tideclaw's 604 vertices, and the trunk is the remaining 18%. Rather than
 * pretend a decapod costs what a sprat costs, the plans that carry limbs,
 * strands or a lathed bell get a stated allowance, and everything else is held
 * to the fish number exactly.
 */
const PLAN_BUDGET_SCALE = {
  crustacean: 2.4,   // 8-14 legs, 0-2 chelae, antennae, eyestalks
  walker: 1.8,       // 6 legs and a crest
  squid: 1.6,        // 8-11 arms and clubs
  bell: 1.5,         // a lathed bell plus a tentacle curtain
  shell: 1.3,        // a lathed shell plus radiating spines
};

/**
 * LOD0 vertex budget for a species.
 *
 * @param {object} species a bestiary SPECIES record
 * @returns {number} maximum vertices buildCreatureMesh may emit
 */
export function creatureVertexBudget(species) {
  const scale = PLAN_BUDGET_SCALE[species.meshRecipe.plan] ?? 1;
  return Math.round(tierFor(species.length).budget * scale);
}

/** Scale an instanced sub-part count by the tier, never below 1 if asked for any. */
const dec = (n, tier) => (n > 0 ? Math.max(1, Math.round(n * tier.decimate)) : 0);

// ---------------------------------------------------------------------------
// Station sampling
// ---------------------------------------------------------------------------

const _st = new Float64Array(4);
const _p = vec3.create();
const _n = vec3.create();
const _q0 = vec3.create();
const _q1 = vec3.create();
const _q2 = vec3.create();
const _uv = Float32Array.of(0, 0);
const _quat = quat.create();
const _mat = mat4.create();
const _one = Float32Array.of(1, 1, 1);

/** Linear interpolation through a station table into `out` = [a, b, yc, n]. */
function sampleTable(table, u, out) {
  const last = table.length - 1;
  if (u <= table[0][0]) {
    const r = table[0];
    out[0] = r[1]; out[1] = r[2]; out[2] = r[3]; out[3] = r[4];
    return out;
  }
  if (u >= table[last][0]) {
    const r = table[last];
    out[0] = r[1]; out[1] = r[2]; out[2] = r[3]; out[3] = r[4];
    return out;
  }
  let i = 0;
  while (i < last && table[i + 1][0] < u) i++;
  const a = table[i], b = table[i + 1];
  const t = (u - a[0]) / Math.max(1e-9, b[0] - a[0]);
  out[0] = lerp(a[1], b[1], t);
  out[1] = lerp(a[2], b[2], t);
  out[2] = lerp(a[3], b[3], t);
  out[3] = lerp(a[4], b[4], t);
  return out;
}

/** Station count of a generated ray plan. 33 resolves the margins smoothly. */
const RAY_TABLE_RINGS = 33;

/**
 * A ray's plan is a superellipse across the whole disc rather than a table:
 * `|2u - 1|^(1/e) + (a)^(1/e) = 1`, which for e = 0.62 gives the Sandveil's
 * soft-shouldered diamond and for e = 0.78 the Voltbarb's rounder one. The
 * thickness profile is a separate bump, thickest a third of the way back where
 * the body actually is.
 */
function rayStations(e) {
  const table = [];
  const inv = 1 / Math.max(0.2, e);
  // A FIXED table resolution, not the caller's ring count: buildCreatureBones and
  // buildCreatureMesh both build a shape, and if the table they sample differed
  // the bones would sit a few millimetres off the surface they are binding.
  const rings = RAY_TABLE_RINGS;
  for (let i = 0; i < rings; i++) {
    const u = i / (rings - 1);
    const s = Math.abs(2 * u - 1);
    // Floored at 2% of the peak: a margin of literally zero width would put
    // coincident vertices at theta = 0 and theta = PI, and every triangle
    // touching them would be degenerate.
    const a = Math.max(0.02, Math.pow(Math.max(0, 1 - Math.pow(s, inv)), e));
    // Thickness: peak at u = 0.34, tapering to a thin trailing margin.
    const b = 0.16 + 0.84 * Math.exp(-Math.pow((u - 0.34) / 0.30, 2));
    table.push([u, a, b, 0, 2.15]);
  }
  return table;
}

/**
 * Stations of the oblate ellipsoid addTest() lathes: r = rr sin(a), and the
 * height runs hh (1 - cos a), so the station at u carries cos a = 1 - 2u.
 */
function testStations() {
  const rings = 17;
  const table = [];
  for (let i = 0; i < rings; i++) {
    const u = i / (rings - 1);
    const s = 1 - 2 * u;
    // Floored for the same reason rayStations floors its margin: a station of
    // literally zero radius has no theta direction to place a part along.
    const a = Math.max(0.02, Math.sqrt(Math.max(0, 1 - s * s)));
    table.push([u, a, a, 0, 2]);
  }
  return table;
}

/** Stations of the logarithmic-spiral profile addShell() lathes. */
function shellStations(spec) {
  const rings = 13;
  const table = [];
  const k = Math.pow(spec.apex ?? 0.42, 1 / Math.max(1, spec.whorls));
  for (let i = 0; i < rings; i++) {
    const u = i / (rings - 1);
    const a = Math.max(0.02, Math.pow(k, u * spec.whorls) * (1 - Math.pow(u, 3.2)));
    table.push([u, a, a, 0, 2]);
  }
  return table;
}

/**
 * Stations of bellProfile()'s outer wall, apex at u = 0 and rim at u = 1.
 *
 * addBell() rotates the lathe so its apex points along -Z, which maps lathe
 * height y to u = 1 - y / height - hence the reversal against bellProfile's own
 * point order.
 */
const T_BELL = [
  [0.00, 0.02, 0.02, 0.00, 2.0], [0.06, 0.30, 0.30, 0.00, 2.0],
  [0.22, 0.58, 0.58, 0.00, 2.0], [0.46, 0.80, 0.80, 0.00, 2.0],
  [0.72, 0.94, 0.94, 0.00, 2.0], [1.00, 1.00, 1.00, 0.00, 2.0],
];

/**
 * Everything the loft needs to place one section: the table, the axis frame,
 * the metre scales, and the trunk modifiers (bumps, armour lip, lean).
 */
function makeShape(plan, recipe, L) {
  let table = plan.table
    ? plan.table
    : (recipe.discExponent ? rayStations(recipe.discExponent) : T_FUSIFORM);
  // A cephalopod's trunk is its mantle plus the head: the arms make up the rest
  // of the quoted length and are built as strands, so the loft must stop where
  // the arm crown begins or the animal comes out twice as long as its datasheet.
  let trunk = recipe.trunk
    ?? (recipe.mantle ? clamp((recipe.mantle.length * 1.30) / L, 0.2, 0.8) : plan.trunk);
  // A fish's tail fin IS the last stretch of its quoted length, so the lofted
  // body has to stop short by however far the caudal reaches past it. Without
  // this a 31 m Hollowjaw measures 34 m along its own axis and every collision
  // radius derived from `length` is wrong.
  const caudal = recipe.caudal || recipe.fluke;
  if (caudal) {
    // Measured, not guessed: the rearmost caudal vertex sits at
    // (tail tip - 0.35 chord) + sweep + half a tapered chord, and the sweep is
    // chord * (0.5 + 1.5 * fork).
    const overshoot = caudal.chord * (0.32 + 1.5 * (caudal.fork ?? 0.35));
    trunk = clamp(trunk - overshoot / L, 0.55, 1);
  }
  const bumps = [];
  for (const key of ['hump', 'occiput', 'melon']) {
    const b = recipe[key];
    if (b) bumps.push({ at: b.at, gain: b.gain, sigma: key === 'hump' ? 0.16 : 0.13 });
  }
  const along = plan.axis === 'y' ? 1 : 2;      // index into a vec3
  let aScale = recipe.girth * L;
  let bScale = recipe.depth * L;
  let trunkLength = L * trunk;

  // A LATHED TRUNK IS NOT A LOFT, so for a bell, a shell or an urchin's test
  // this table is never drawn - it exists only to place the parts that attach to
  // the lathe. It therefore has to BE that lathe, not a dome that resembles one.
  // A shared dome cost real geometry: it put every one of the Spinecrown's
  // spines up to 64 mm off its own 140 mm test, all of them below the equator
  // with the whole top bare, and it hung the Bellflower's tentacle curtain on
  // the axis 12% of a body length inside the bell instead of on the rim.
  //
  // A body of revolution also has ONE radius, so bScale follows aScale here
  // rather than the recipe's `depth`: an elliptical phantom section around a
  // circular lathe is the same class of error, one axis at a time.
  if (recipe.test) {
    table = testStations();
    trunkLength = 2 * aScale * (recipe.test.oblate ?? 0.62);
    bScale = aScale;
  } else if (recipe.shell) {
    table = shellStations(recipe.shell);
    bScale = aScale;
  } else if (recipe.bell) {
    table = T_BELL;
    aScale = recipe.bell.radius;
    bScale = recipe.bell.radius;
    trunkLength = recipe.bell.height;
  }

  return {
    table, along,
    // Sessile plans grow from y = 0; swimmers are centred on the origin so the
    // camera-relative transform rotates them about their own middle.
    start: plan.axis === 'y' ? 0 : -L * 0.5,
    trunkLength,
    aScale,
    bScale,
    bumps,
    plates: recipe.plates | 0,
    plateLip: recipe.plateLip ?? 0.055,
    lift: recipe.carapaceLift ?? 0,
    lean: (recipe.lean ?? 0) * L,
  };
}

/**
 * Section geometry at (u): half-width, half-height, centre offset, exponent.
 *
 * The armour lip is a sawtooth on the radius, not extra geometry: with three or
 * more rings per plate the step reads as an overlapping tergite, and it costs
 * nothing on top of the loft the body already needs.
 */
function stationAt(shape, u, out) {
  sampleTable(shape.table, saturate(u), out);
  let a = out[0], b = out[1];
  for (const bump of shape.bumps) {
    const g = Math.exp(-Math.pow((u - bump.at) / bump.sigma, 2));
    const k = 1 + (bump.gain - 1) * g;
    a *= k; b *= k;
  }
  if (shape.plates > 0) {
    const seg = u * shape.plates;
    const lip = 1 + shape.plateLip * (seg - Math.floor(seg));
    a *= lip; b *= lip;
  }
  out[0] = a * shape.aScale;
  out[1] = b * shape.bScale;
  // A crustacean's carapace is domed, so its centre rides above the leg line.
  out[2] = out[2] * out[1] + shape.lift * out[1];
  return out;
}

/** Scratch ring schedule entry for the un-capped, un-scaled surface. */
const _unitRing = { u: 0, scale: 1, offset: 0 };

/**
 * Radial components of the last ringPoint call, in the two world directions
 * that are not the body axis, BEFORE the lean shear is added.
 *
 * The outward test needs these rather than the world position. A leaning vent
 * tube is sheared by 0.66 m across a 0.12 m radius, so the world x of every
 * vertex near the top has the same sign and "is the normal pointing away from
 * the axis" answers no for the whole far side of the tube - which inverted 142
 * triangles before this existed.
 */
const _sec = Float64Array.of(0, 0);

/**
 * Point on the trunk surface at (u, theta), written into `out`. This is where
 * every part attaches: a fin root, an eye socket, a leg hip, an arm base.
 */
function surfacePoint(shape, u, theta, out) {
  _unitRing.u = saturate(u);
  return ringPoint(shape, _unitRing, theta, out);
}

// ---------------------------------------------------------------------------
// CreatureBuilder
// ---------------------------------------------------------------------------

/**
 * MeshBuilder plus the two things a creature needs that a plant does not:
 * a record of which bone each vertex range binds to, and which biolum pattern
 * paints it.
 *
 * Binding is resolved in one pass at the end rather than per vertex, because
 * the spine polyline is not known until the trunk's own bow is known, and
 * because projecting a wingtip onto the spine is the same operation whether the
 * vertex came from the loft or from a merged fin.
 */
class CreatureBuilder {
  /**
   * @param {number} vertexGuess initial capacity
   * @param {string} pattern the species' BIOLUM_PATTERN
   * @param {number} biolumCount pattern density (rows, dots, stripes)
   */
  constructor(vertexGuess, pattern, biolumCount) {
    this.mb = new MeshBuilder(vertexGuess, vertexGuess * 3);
    this.pattern = pattern;
    this.biolumCount = biolumCount;
    /** @type {Array<{start:number,count:number,bone:number,kind:string,
     *   mode:string,value:number,count1d:number}>} */
    this.ranges = [];
  }

  get vertexCount() { return this.mb.vertexCount; }

  /**
   * Open a range. Every vertex added until close() shares its binding and its
   * bioluminescence mask, and the mask follows from the PART KIND: a caller
   * says what it is building and partMask() decides whether this species'
   * pattern paints that part.
   *
   * @param {number} bone -1 to bind by spine projection, else a bone index
   * @param {string} kind part kind, e.g. 'body', 'fin', 'esca', 'leg'
   */
  open(bone, kind) {
    const mask = partMask(this.pattern, kind, this.biolumCount);
    this.ranges.push({
      start: this.mb.vertexCount, count: 0, bone, kind,
      mode: mask.mode, value: mask.value ?? 0, count1d: mask.count ?? 8,
    });
  }

  close() {
    const r = this.ranges[this.ranges.length - 1];
    r.count = this.mb.vertexCount - r.start;
  }

  /** Merge a built meshgen result as one range. */
  mergePart(mesh, transform, bone, kind) {
    this.open(bone, kind);
    this.mb.merge(mesh, transform);
    this.close();
  }
}

/** Bridge two rings with the winding that puts the normal outward. */
function bridge(mb, aBase, bBase, segs, stride, aPoint, bPoint) {
  if (aPoint && bPoint) return;
  for (let k = 0; k < segs; k++) {
    const a0 = aBase + k, a1 = aBase + ((k + 1) % stride);
    const b0 = bBase + k, b1 = bBase + ((k + 1) % stride);
    // cross(ring tangent, along tangent) points out, so k advances before i.
    if (aPoint) mb.addTriangle(a0, b1, b0);
    else if (bPoint) mb.addTriangle(a0, a1, b1);
    else mb.addQuad(a0, a1, b1, b0);
  }
}

// ---------------------------------------------------------------------------
// The trunk
// ---------------------------------------------------------------------------

/**
 * The ring schedule for a trunk: a rounded nose cap, the station table proper,
 * a rounded tail cap.
 *
 * The caps are why they exist: without them the loft is an open tube, and an
 * open tube has a hole at the snout that the player will absolutely see when a
 * Hollowjaw fills the windshield. Collapsing the first and last station to a
 * point instead would work but would turn every blunt head in the bestiary into
 * a cone; a quarter-ellipse cap whose length is the station's own smaller
 * half-axis keeps the blunt head blunt and still closes the surface.
 *
 * Each entry is `{u, scale, offset}`: `u` is the station (and the texture and
 * pattern) coordinate, `scale` multiplies both half-axes, `offset` displaces the
 * ring along the body axis.
 */
function trunkRings(shape, rings, capRings) {
  const list = [];
  stationAt(shape, 0, _st);
  const noseR = Math.max(Math.min(_st[0], _st[1]) * 0.85, shape.trunkLength * 0.002);
  stationAt(shape, 1, _st);
  const tailR = Math.max(Math.min(_st[0], _st[1]) * 0.85, shape.trunkLength * 0.002);

  for (let k = 0; k < capRings; k++) {
    const phi = (1 - k / capRings) * (PI * 0.5);
    list.push({ u: 0, scale: Math.cos(phi), offset: -noseR * Math.sin(phi) });
  }
  for (let i = 0; i < rings; i++) list.push({ u: i / (rings - 1), scale: 1, offset: 0 });
  for (let k = 1; k <= capRings; k++) {
    const phi = (k / capRings) * (PI * 0.5);
    list.push({ u: 1, scale: Math.cos(phi), offset: tailR * Math.sin(phi) });
  }
  return list;
}

/** Surface point for one ring schedule entry at `theta`, into `out`. */
function ringPoint(shape, ring, theta, out) {
  stationAt(shape, ring.u, _st);
  const a = _st[0] * ring.scale, b = _st[1] * ring.scale, yc = _st[2], n = _st[3];
  const e = 2 / n;
  const c = Math.cos(theta), s = Math.sin(theta);
  const sx = a * Math.sign(c) * Math.pow(Math.abs(c), e);
  const sy = b * Math.sign(s) * Math.pow(Math.abs(s), e);
  const along = alongAt(shape, ring.u) + ring.offset;
  const leanX = shape.lean * ring.u * ring.u;
  if (shape.along === 1) {
    // The height axis is NEGATED for a sessile plan. (width, height, along) has
    // to be right-handed or the ring winds the wrong way round the body and the
    // whole trunk renders inside-out; with along = +Y and width = +X, that
    // means the height component runs along -Z.
    out[0] = sx + leanX; out[1] = along; out[2] = -(sy + yc);
    _sec[0] = sx; _sec[1] = -sy;
  } else {
    out[0] = sx + leanX; out[1] = sy + yc; out[2] = along;
    _sec[0] = sx; _sec[1] = sy;
  }
  return out;
}

/**
 * Bake the section of every scheduled ring: the two in-plane offsets for each
 * of the ring's theta samples, plus the along-axis coordinate.
 *
 * This exists for speed and it is worth stating why. Evaluating the superellipse
 * inside the vertex loop cost five station lookups and ten Math.pow calls per
 * vertex - once for the vertex and four more for the central differences - and
 * that put the whole bestiary at 7.5 ms to build. The theta samples are shared
 * by every ring's own differencing and by its neighbours', so baking them once
 * per ring drops the vertex loop to pure arithmetic and the ring tangent becomes
 * a difference of ADJACENT SAMPLES, which needs no extra evaluation at all.
 */
function bakeSections(shape, schedule, segs) {
  const stride = segs + 1;
  const count = schedule.length;
  const px = new Float64Array(count * stride);
  const py = new Float64Array(count * stride);
  const along = new Float64Array(count);
  const yc = new Float64Array(count);
  const lean = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const ring = schedule[i];
    stationAt(shape, ring.u, _st);
    const a = _st[0] * ring.scale, b = _st[1] * ring.scale;
    const e = 2 / _st[3];
    yc[i] = _st[2];
    along[i] = alongAt(shape, ring.u) + ring.offset;
    lean[i] = shape.lean * ring.u * ring.u;
    for (let j = 0; j <= segs; j++) {
      const th = (j / segs) * TAU;
      const c = Math.cos(th), sn = Math.sin(th);
      px[i * stride + j] = a * Math.sign(c) * Math.pow(Math.abs(c), e);
      py[i * stride + j] = b * Math.sign(sn) * Math.pow(Math.abs(sn), e);
    }
  }
  return { px, py, along, yc, lean, stride };
}

/** World position of baked ring `i`, sample `j`, into `out`. */
function bakedPoint(shape, sec, i, j, out) {
  const o = i * sec.stride + j;
  const sx = sec.px[o] + sec.lean[i];
  const sy = sec.py[o] + sec.yc[i];
  if (shape.along === 1) {
    // The height axis is NEGATED for a sessile plan; see ringPoint.
    out[0] = sx; out[1] = sec.along[i]; out[2] = -sy;
  } else {
    out[0] = sx; out[1] = sy; out[2] = sec.along[i];
  }
  return out;
}

/**
 * Loft the trunk.
 *
 * Normals are central differences of the surface itself - one sample either side
 * around the ring, one ring either side along the body - rather than averaged
 * face normals. The superellipse exponent ramps along the body, so adjacent
 * faces at a station boundary disagree by a few degrees, and averaging them lays
 * a visible ring band down the animal that no amount of shader work removes.
 */
function loftTrunk(cb, shape, rings, segs, capRings, tint, ventral) {
  const mb = cb.mb;
  mb.material = M.FLORA;
  const stride = segs + 1;
  const schedule = trunkRings(shape, rings, capRings);
  const count = schedule.length;
  const sec = bakeSections(shape, schedule, segs);
  const first = mb.vertexCount;

  cb.open(-1, 'body');
  for (let i = 0; i < count; i++) {
    const ring = schedule[i];
    const pole = ring.scale < 1e-6;
    const iPrev = Math.max(0, i - 1);
    const iNext = Math.min(count - 1, i + 1);
    for (let j = 0; j <= segs; j++) {
      bakedPoint(shape, sec, i, j, _p);
      // Section-local radial, for the outward test. The lean shear must not be
      // in it: a vent tube is sheared 0.66 m across a 0.12 m radius, and the
      // world x of every vertex up top then has the same sign.
      const o = i * stride + j;
      const secX = sec.px[o];
      const secY = shape.along === 1 ? -sec.py[o] : sec.py[o];
      if (pole) {
        // A pole has no ring tangent. Its normal is the body axis, outward.
        vec3.set(_n, 0, 0, 0);
        _n[shape.along] = ring.offset < 0 ? -1 : 1;
      } else {
        // Wrapped neighbours: sample 0 and sample `segs` are the same point, so
        // the step back from 0 is to segs - 1 and forward from segs is to 1.
        const jm = j === 0 ? segs - 1 : j - 1;
        const jp = j === segs ? 1 : j + 1;
        bakedPoint(shape, sec, i, jm, _q0);
        bakedPoint(shape, sec, i, jp, _q1);
        vec3.sub(_q0, _q1, _q0);
        bakedPoint(shape, sec, iPrev, j, _q1);
        bakedPoint(shape, sec, iNext, j, _q2);
        vec3.sub(_q1, _q2, _q1);
        // Normalise BOTH tangents before crossing. A 21 mm krill's tangents are
        // about 1e-3 m long, their cross product 1e-6, and vec3.normalize
        // returns the zero vector below EPSILON = 1e-6 - so the raw cross
        // product silently produces zero-length normals on every small species.
        vec3.normalize(_q0, _q0);
        vec3.normalize(_q1, _q1);
        vec3.cross(_n, _q0, _q1);
        if (vec3.sqrLen(_n) < 1e-12) {
          vec3.set(_n, 0, 0, 0);
          _n[shape.along] = ring.u < 0.5 ? -1 : 1;
        } else {
          vec3.normalize(_n, _n);
          const radial = shape.along === 1
            ? _n[0] * secX + _n[2] * secY : _n[0] * secX + _n[1] * secY;
          if (radial < 0 && Math.abs(secX) + Math.abs(secY) > 1e-7) vec3.scale(_n, _n, -1);
        }
      }
      const th = (j / segs) * TAU;
      const ventralness = pole ? 0.5 : saturate(0.5 - 0.5 * Math.sin(th));
      shade(_col, tint, ventral, ventralness);
      _uv[0] = j / segs; _uv[1] = ring.u;
      mb.addVertex(_p, _n, _uv, _col);
    }
  }
  cb.close();

  for (let i = 0; i < count - 1; i++) {
    bridge(mb, first + i * stride, first + (i + 1) * stride, segs, stride,
      schedule[i].scale < 1e-6, schedule[i + 1].scale < 1e-6);
  }
}

/**
 * Per-vertex inflation weight, DESIGN/06 06.3.6's `extra.x`.
 *
 * A Gaussian along the body times a belly bias, and only on the trunk: an
 * inflating Bloatspine must become a ball without its fins, eyes and beak
 * growing with it, which is exactly what a uniform scale would do.
 */
function applyInflate(cb, recipe, vc) {
  const out = new Float32Array(vc);
  const spec = recipe.inflate;
  if (!spec) return out;
  const at = spec.at ?? 0.45;
  const spread = spec.spread ?? 0.32;
  const bias = clamp(spec.bellyBias ?? 0.6, 0, 1);
  const UV = cb.mb.uvs;
  for (const r of cb.ranges) {
    // Keyed on the PART, not on the mask mode: a species with no
    // bioluminescence has a body range whose mask mode is 'const', and keying
    // on the mode silently gave the Bloatspine no inflation at all.
    if (r.kind !== 'body') continue;
    for (let i = r.start; i < r.start + r.count; i++) {
      const u = UV[i * 2 + 1];
      const ventralness = saturate(0.5 - 0.5 * Math.sin(UV[i * 2] * TAU));
      const axial = Math.exp(-Math.pow((u - at) / spread, 2));
      out[i] = saturate(axial * lerp(1 - bias, 1, ventralness));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Workhorse: fins
// ---------------------------------------------------------------------------

/**
 * A fin is a cambered lens section swept along a span line.
 *
 * extrudeAlongSpline does the sweep, so a fin, a wing, a keratin crest blade, a
 * kelp-mimicking dermal flap and a baleen plate are one function with different
 * numbers - which is the only reason this file covers 37 animals without a
 * bespoke generator per fin type.
 *
 * `sweep` bends the span backwards along +Z as `t^2`, which is what makes a
 * falcate dorsal or a lunate caudal lobe read as fast rather than as a paddle.
 */
function addFin(cb, o) {
  const stations = Math.max(2, o.stations | 0);
  const chord = Math.max(1e-4, o.chord);
  const spanLen = Math.hypot(o.span[0], o.span[1], o.span[2]);

  // A RIBBON is a fin whose chord dwarfs its span: the Hagline's continuous
  // dorsal ridge is 60 cm of chord standing 1.6 cm proud. Two things that are
  // right for a tall fin are wrong for a ribbon, and both produce folded,
  // inside-out geometry rather than a cosmetic flaw:
  //
  //   SWEEP rakes the span backwards, which tilts the path tangent, which
  //   rotates the section frame. Rotating a 60 cm chord by two degrees moves its
  //   tip 1 cm - further than the whole 1.6 cm span - so the surface travels
  //   BACKWARDS along the span at the chord tips and folds through itself.
  //
  //   TAPER shrinks the chord over a sweep 40x shorter than the chord, making the
  //   swept side a near-vertical cone whose analytic section normals are 60
  //   degrees from the geometry.
  //
  // Real continuous ridges neither sweep nor taper, so the correct fix and the
  // cheap fix are the same one.
  const ribbon = spanLen < chord * 0.35;
  const sweep = ribbon ? null : o.sweep;
  const taper = ribbon ? 1 : lerp(1, o.taper ?? 0.35, saturate(spanLen / (chord * 0.75)));

  const path = new Float32Array(stations * 3);
  for (let i = 0; i < stations; i++) {
    const t = i / (stations - 1);
    path[i * 3] = o.origin[0] + o.span[0] * t + (sweep ? sweep[0] * t * t : 0);
    path[i * 3 + 1] = o.origin[1] + o.span[1] * t + (sweep ? sweep[1] * t * t : 0);
    path[i * 3 + 2] = o.origin[2] + o.span[2] * t + (sweep ? sweep[2] * t * t : 0);
  }

  const thick = clamp((o.thickness ?? chord * 0.09) / chord, 0.02, 0.5);
  // Camber is CLAMPED to the section's own half-thickness. Past that the
  // cambered mean line carries the whole section off the origin, the section
  // stops enclosing it, and extrudeAlongSpline's radial normals - which are
  // measured from the section origin - point the wrong way on the lower
  // surface. A thin fin physically cannot carry much camber either.
  const cam = clamp(o.camber ?? 0, -thick * 0.8, thick * 0.8);
  const wide = (o.sides ?? 4) >= 6;
  // Section in half-chord units, wound COUNTER-CLOCKWISE in the (chord,
  // thickness) plane: extrudeAlongSpline derives its winding from the section's
  // handedness, and a clockwise section produces a fin that is inside-out on
  // every single triangle. Camber lifts the mean line at mid-chord.
  const profile = wide
    ? Float32Array.of(
      -1, cam * 0.2,
      -0.40, -thick * 0.85 + cam * 0.84,
      0.35, -thick + cam * 0.88,
      1, cam * 0.2,
      0.35, thick + cam * 0.88,
      -0.40, thick * 0.85 + cam * 0.84,
    )
    : Float32Array.of(
      -1, cam * 0.2,
      0, -thick + cam,
      1, cam * 0.2,
      0, thick + cam,
    );

  // THE UP HINT IS THE PLATE NORMAL, NOT THE CHORD AXIS. splineFrames builds the
  // section's u axis as cross(upHint, tangent), so handing it the chord direction
  // puts the chord along the THICKNESS and every fin in the bestiary renders as a
  // thin wire sticking out of the fish. The normal is cross(span, chord); when
  // the two are parallel there is no plane, so fall back to any perpendicular.
  vec3.set(_q0, path[(stations - 1) * 3] - path[0], path[(stations - 1) * 3 + 1] - path[1],
    path[(stations - 1) * 3 + 2] - path[2]);
  vec3.normalize(_q0, _q0);
  vec3.cross(_q1, _q0, o.chordDir);
  if (vec3.len(_q1) < 0.12) vec3.anyPerpendicular(_q1, _q0);
  else vec3.normalize(_q1, _q1);

  const mesh = extrudeAlongSpline(profile, path, o.twist ?? 0, taper, {
    radius: chord * 0.5,
    upHint: _q1,
    material: o.material ?? M.TRANSLUCENT,
    color: o.color,
    capStart: true,
    capEnd: true,
  });
  cb.mergePart(mesh, null, o.bone ?? -1, o.kind);
}

// ---------------------------------------------------------------------------
// Workhorse: tubes
// ---------------------------------------------------------------------------

const _tubeProfileCache = new Map();

/** Unit circular section with `sides` points, cached per side count. */
function circleProfile(sides) {
  let p = _tubeProfileCache.get(sides);
  if (!p) {
    p = new Float32Array(sides * 2);
    for (let i = 0; i < sides; i++) {
      const th = (i / sides) * TAU;
      p[i * 2] = Math.cos(th); p[i * 2 + 1] = Math.sin(th);
    }
    _tubeProfileCache.set(sides, p);
  }
  return p;
}

/**
 * A tapering tube along a curved path: arms, tentacles, legs, barbels,
 * antennae, whip tails, the illicium, a siphonophore's stem.
 *
 * `bulge` scales the section near the far end, which is how a squid's
 * tentacular club gets its expanded pad without a separate mesh.
 */
function addTube(cb, o) {
  const mesh = extrudeAlongSpline(circleProfile(o.sides ?? 5), o.path, 0, o.taper ?? 0.2, {
    radius: o.radius,
    material: o.material ?? M.FLORA,
    color: o.color,
    capStart: o.capStart ?? true,
    capEnd: true,
    scaleFn: o.bulge
      ? (t) => 1 + (o.bulge - 1) * smoothstep(0.62, 0.94, t)
      : null,
  });
  cb.mergePart(mesh, null, o.bone ?? -1, o.kind);
}

/**
 * A curved appendage path: from `origin`, `stations` points bending from
 * `dir` toward `curlDir` as `t^1.6`.
 *
 * The exponent matters: a linear bend makes an arm that looks hinged at the
 * base, and cephalopod arms visibly straighten near the root and curl at the
 * tip.
 */
function curvedPath(origin, dir, curlDir, length, curl, stations) {
  const path = new Float32Array(stations * 3);
  for (let i = 0; i < stations; i++) {
    const t = i / (stations - 1);
    const bend = curl * Math.pow(t, 1.6) * length;
    path[i * 3] = origin[0] + dir[0] * t * length + curlDir[0] * bend;
    path[i * 3 + 1] = origin[1] + dir[1] * t * length + curlDir[1] * bend;
    path[i * 3 + 2] = origin[2] + dir[2] * t * length + curlDir[2] * bend;
  }
  return path;
}

// ---------------------------------------------------------------------------
// Bones
// ---------------------------------------------------------------------------

/**
 * Rest-pose bone chain: the spine, then the optional jaw and lure bones.
 *
 * The spine runs the WHOLE species length even when the lofted trunk is
 * shorter, so a jelly's tentacle curtain and a squid's arm crown are covered by
 * real bones and inherit the spine wave. That is the trick that animates 24
 * trailing strands for the cost of the chain that was there anyway.
 *
 * @param {object} species a bestiary SPECIES record
 * @returns {{bones: Array<object>, spineCount: number, jaw: number, lure: number,
 *   mandibles: Array<number>, length: number, spineLength: number, axis: string}}
 *   `jaw`/`lure` are -1 when absent and `mandibles` is empty; `spineLength` is
 *   the chain's own extent, which exceeds `length` whenever strands trail behind
 *   the body
 */
export function buildCreatureBones(species) {
  const recipe = species.meshRecipe;
  const plan = BODY_PLAN[recipe.plan];
  const L = species.length;
  const wantJaw = !!recipe.jaw;
  const wantLure = !!recipe.lure;
  // THE NON-SPINE BONES ARE TAKEN OUT OF THE BUDGET FIRST, and the mandibles
  // have to be counted here or the spine silently eats their slots and the
  // horns bind to whatever the clamp left behind.
  const mandibleCount = recipe.mandibles ? (recipe.mandibles.count ?? 4) : 0;
  const extra = (wantJaw ? 1 : 0) + (wantLure ? 1 : 0) + mandibleCount;
  const spineCount = clamp(recipe.spineBones | 0, 2, CREATURE_MAX_BONES - extra);

  const shape = makeShape(plan, recipe, L);

  // THE CHAIN SPANS THE WHOLE ANIMAL, INCLUDING WHAT TRAILS BEHIND IT.
  //
  // A Bellflower's `length` is 0.45 m of bell and its tentacles trail 2.6 m; a
  // Ghostbell's oral arms hang three times its bell diameter. Sizing the chain
  // to `length` alone leaves every one of those strands bound rigidly to the
  // last bone, and a jelly whose curtain cannot move is a lampshade.
  let spineLength = L;
  for (const key of ['tentacles', 'oralArms', 'arms', 'clubs', 'streamers']) {
    const spec = recipe[key];
    if (spec) spineLength = Math.max(spineLength, shape.trunkLength + spec.length);
  }

  const bones = [];
  for (let i = 0; i < spineCount; i++) {
    const u = i / (spineCount - 1);
    // Bones follow the trunk's own vertical bow where the trunk exists, and
    // run straight through the trailing appendages beyond it.
    const trunkU = shape.trunkLength > 1e-6
      ? clamp((u * spineLength) / shape.trunkLength, 0, 1) : 0;
    stationAt(shape, trunkU, _st);
    const yc = u * spineLength <= shape.trunkLength ? _st[2] : 0;
    const along = shape.start + u * spineLength;
    // The height axis is NEGATED for a sessile plan, exactly as in ringPoint and
    // in the jaw bone below: with along = +Y and width = +X, (width, height,
    // along) is only right-handed if height runs along -Z. Every sessile station
    // table happens to carry yc = 0 today, so this is the sign the next one
    // needs rather than a visible fault in this one.
    const pos = plan.axis === 'y'
      ? [shape.lean * u * u, along, -yc]
      : [shape.lean * u * u, yc, along];
    bones.push({
      index: i, parent: i - 1, role: BONE_ROLE.SPINE, u,
      position: pos, restLength: spineLength / (spineCount - 1),
    });
  }

  let jaw = -1, lure = -1;
  if (wantJaw) {
    jaw = bones.length;
    const jl = recipe.jaw.length ?? L * 0.2;
    const uHinge = jawHingeU(shape, jl);
    stationAt(shape, uHinge, _st);
    const hingeAlong = shape.start + uHinge * shape.trunkLength;
    bones.push({
      index: jaw, parent: 0, role: BONE_ROLE.JAW, u: uHinge,
      // The hinge is where addJaw puts the mandible's root, one jaw-length back
      // from the snout. Anywhere else and the jaw scissors through the skull the
      // moment it opens.
      position: plan.axis === 'y'
        ? [0, hingeAlong, -_st[2]]
        : [0, _st[2] - _st[1] * 0.35, hingeAlong],
      restLength: jl,
    });
  }
  if (wantLure) {
    lure = bones.length;
    const b0 = bones[0].position;
    bones.push({
      index: lure, parent: 0, role: BONE_ROLE.LURE, u: 0,
      position: [b0[0], b0[1] + species.length * 0.16, b0[2]],
      restLength: recipe.lure.length,
    });
  }
  const mandibles = [];
  for (let i = 0; i < mandibleCount; i++) {
    // Parent 0: a horn is skull furniture, so it inherits the head bone's
    // pursuit lead exactly as it did when it WAS the head bone. `u` is the
    // horn's own station, which is what puts it inside the front 30% the lead
    // acts over. The pivot is the root, and `radial` is what the GPU needs to
    // rebuild the fold axis - it is the only role that uses RestBone.info.w.
    const r = mandibleRoot(shape, recipe.mandibles, i);
    mandibles.push(bones.length);
    bones.push({
      index: bones.length, parent: 0, role: BONE_ROLE.MANDIBLE,
      u: recipe.mandibles.at ?? 0.05,
      position: plan.axis === 'y' ? [r.x, r.z, -r.y] : [r.x, r.y, r.z],
      restLength: recipe.mandibles.length,
      radial: r.th,
    });
  }
  return { bones, spineCount, jaw, lure, mandibles, length: L, spineLength, axis: plan.axis };
}

/**
 * Bind every vertex to the bone chain and normalise the weights.
 *
 * Spine binding is a projection onto the chain's own polyline: the segment with
 * the nearest point wins, and the fraction along it becomes the blend between
 * that segment's two bones. This is why a ray's wingtip, which is two metres
 * from the spine, still gets the bone under it rather than the nearest bone by
 * index - a wingtip bound by index alone shears when the body bends.
 */
function bindSkin(cb, skeleton) {
  const vc = cb.mb.vertexCount;
  const idx = new Uint8Array(vc * CREATURE_INFLUENCES);
  const wgt = new Float32Array(vc * CREATURE_INFLUENCES);
  const P = cb.mb.positions;
  const spine = skeleton.bones;
  const n = skeleton.spineCount;

  for (const r of cb.ranges) {
    for (let i = r.start; i < r.start + r.count; i++) {
      const o = i * CREATURE_INFLUENCES;
      if (r.bone >= 0) {
        idx[o] = r.bone; wgt[o] = 1;
        continue;
      }
      const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2];
      let bestSeg = 0, bestT = 0, bestD = Infinity;
      for (let k = 0; k < n - 1; k++) {
        const a = spine[k].position, b = spine[k + 1].position;
        const ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2];
        const len2 = ax * ax + ay * ay + az * az;
        const t = len2 > 1e-12
          ? clamp(((px - a[0]) * ax + (py - a[1]) * ay + (pz - a[2]) * az) / len2, 0, 1) : 0;
        const cx = a[0] + ax * t - px, cy = a[1] + ay * t - py, cz = a[2] + az * t - pz;
        const d = cx * cx + cy * cy + cz * cz;
        if (d < bestD) { bestD = d; bestSeg = k; bestT = t; }
      }
      idx[o] = bestSeg; wgt[o] = 1 - bestT;
      idx[o + 1] = bestSeg + 1; wgt[o + 1] = bestT;
    }
  }

  // Exact normalisation. The blend above already sums to 1 in real arithmetic;
  // this makes it true in float32 too, which is what the shader's early-out on
  // a zero weight depends on.
  for (let i = 0; i < vc; i++) {
    const o = i * CREATURE_INFLUENCES;
    let s = 0;
    for (let k = 0; k < CREATURE_INFLUENCES; k++) s += wgt[o + k];
    if (s <= 1e-9) { idx[o] = 0; wgt[o] = 1; continue; }
    const inv = 1 / s;
    for (let k = 0; k < CREATURE_INFLUENCES; k++) wgt[o + k] *= inv;
  }
  return { boneIndices: idx, boneWeights: wgt };
}

// ---------------------------------------------------------------------------
// Bioluminescence
// ---------------------------------------------------------------------------

/**
 * Which parts a pattern paints.
 *
 * Ten of the twenty patterns live on a specific PART - the lure on the esca,
 * the mouth glow on the Nethercoil's interior shell, the joint membranes on a
 * Glassclaw's legs - and painting them onto the trunk instead is exactly how an
 * animal ends up glowing all over. Everything else is a two-dimensional pattern
 * on the trunk's own (theta, u) parameterisation.
 */
function partMask(pattern, kind, count) {
  const ZERO = { mode: 'const', value: 0 };
  switch (pattern) {
    case BIOLUM_PATTERN.NONE: return ZERO;
    case BIOLUM_PATTERN.LURE:
      return kind === 'esca' ? { mode: 'const', value: 1 } : ZERO;
    case BIOLUM_PATTERN.JAW_PORES:
      return kind === 'jaw' ? { mode: 'poreRow', count } : ZERO;
    case BIOLUM_PATTERN.MOUTH_GLOW:
      return kind === 'interior' ? { mode: 'const', value: 1 } : ZERO;
    case BIOLUM_PATTERN.SPINE_TIPS:
      return kind === 'spine' ? { mode: 'tip' } : ZERO;
    case BIOLUM_PATTERN.SCATTER_GLOW:
      return kind === 'plume' || kind === 'house' ? { mode: 'const', value: 0.85 } : ZERO;
    case BIOLUM_PATTERN.DISCHARGE_ARCS:
      return kind === 'organ' ? { mode: 'const', value: 1 } : ZERO;
    case BIOLUM_PATTERN.JOINTS:
      return kind === 'leg' || kind === 'claw' ? { mode: 'poreRow', count: 3 } : ZERO;
    case BIOLUM_PATTERN.BELL_RIM:
      return kind === 'bell' ? { mode: 'tip' } : ZERO;
    case BIOLUM_PATTERN.CHAIN_PULSE:
      if (kind === 'stem') return { mode: 'poreRow', count: count * 3 };
      if (kind === 'bell') return { mode: 'const', value: 0.55 };
      return ZERO;
    case BIOLUM_PATTERN.TENDRILS:
      // The Starweaver: the whole tentacle curtain is the display, with a
      // dimmer lit bell rim above it. No other pattern reaches 'tentacle'.
      if (kind === 'tentacle') return { mode: 'const', value: 1 };
      if (kind === 'bell') return { mode: 'tip' };
      return ZERO;
    case BIOLUM_PATTERN.DORSAL_EMBER:
      // The Splitmaw's crimson identity (see the pattern's docstring in
      // bestiary.js): dorsal trunk wash plus the mandible horns and crest.
      // The horns sit at 0.52 - past test-bestiary's "brighter than 0.5"
      // hot gate, UNDER the 0.55 emissive-material flip: as photophores
      // (0.70, one shipped round) their glossy translucent organ material
      // mirrored the azure dome and delivered CYAN horns; as carapace they
      // are matte dark bone with the ember riding on top.
      if (kind === 'mandible') return { mode: 'const', value: 0.52 };
      if (kind === 'crest') return { mode: 'const', value: 0.45 };
      return kind === 'body' ? { mode: 'body' } : ZERO;
    default:
      return kind === 'body' ? { mode: 'body' } : ZERO;
  }
}

/**
 * Dot train along a 1-D parameter: `n` dots, each about a fifth of a period.
 *
 * The half-period offset puts the first dot on the sample at t = 0 rather than
 * on the boundary between two dots. Without it a body with exactly `n` rings
 * samples every dot at its darkest point and the whole pattern evaluates to
 * zero - which is precisely what a 21 mm krill did.
 */
function dot1D(t, n) {
  const x = t * n + 0.5;
  const phase = x - Math.floor(x);
  const d = Math.min(phase, 1 - phase);
  return 1 - smoothstep(0.09, 0.24, d);
}

/** Gaussian band centred on `c` in a 0..1 wrapping coordinate. */
function band(a, c, w) {
  let d = Math.abs(a - c);
  if (d > 0.5) d = 1 - d;
  return Math.exp(-(d * d) / (w * w));
}

/**
 * The two-dimensional trunk patterns, evaluated from the loft's own uv:
 * `a` = theta / TAU (0.25 is the dorsum, 0.75 the belly) and `u` = along the
 * body. Every one of these is deliberately sparse - the failure mode being
 * designed against is an animal that glows as one shape.
 *
 * PATTERN DENSITY IS BOUNDED BY THE MESH RESOLUTION, and that is not a
 * compromise, it is the only way this works. A Wisplight carries 22 ventral
 * photophores on a body the vertex budget gives 8 rings; asking for 22 dots
 * along 8 samples aliases into two dots and a lot of nothing, which is what the
 * first version did. Rows are widened to the angular sample spacing and dot
 * trains are clamped to the ring count, so the pattern that reaches the vertices
 * is the densest one they can actually carry.
 */
function bodyPattern(pattern, a, u, count, seed, rings, segs) {
  const dorsal = saturate(0.5 + 0.5 * Math.sin(a * TAU));
  const ventral = 1 - dorsal;
  // Two samples per feature minimum, or the pattern aliases into nothing. This
  // is why a Wisplight carries five resolved photophores per row and not the
  // datasheet's twenty-two: 22 dots need 45 rings and it has a 400-vertex
  // budget. Sub-vertex photophores are the shader's problem, not the mesh's.
  const dots = clamp(count, 2, Math.max(2, (rings - 1) >> 1));
  const bw = Math.max(0.030, 0.55 / Math.max(4, segs));
  switch (pattern) {
    case BIOLUM_PATTERN.DORSAL_EMBER:
      // Dorsal wash, capped at 0.5 (the emissive-material flip is at 0.55),
      // WEIGHTED TOWARD THE SKULL (the reference's red centre of mass is the
      // head; a uniform wash read tail-heavy because the tail presents more
      // dorsal area to a level camera) and fading over the last tenth.
      return 0.5 * Math.pow(dorsal, 1.6) * (0.55 + 0.45 * (1 - u))
           * (1 - smoothstep(0.88, 1.0, u));
    case BIOLUM_PATTERN.SPOTS:
    case BIOLUM_PATTERN.THERMAL_PATCHES: {
      // Cell-based, not a distance field in continuous space: a photophore on a
      // 54-vertex animal IS one vertex, and a spot whose support is narrower
      // than the vertex spacing lands between samples and disappears. The
      // falloff spans the whole cell, so any vertex inside an accepted cell is
      // lit and the pattern still reads as discrete blobs when the mesh is fine.
      const nu = clamp(count, 2, Math.max(2, (rings - 1) >> 1));
      const na = Math.max(3, Math.min(6, segs >> 1));
      const cu = Math.floor(u * nu), caRaw = Math.floor(a * na);
      // THETA WRAPS. The loft emits theta = 0 and theta = TAU as two vertices at
      // the same point, so a = 1 must hash to the same cell as a = 0 or the seam
      // column samples a different cell from the one its own neighbour is in and
      // every spot row is cut in half down the animal's flank.
      const ca = ((caRaw % na) + na) % na;
      const h = hash2i(cu + seed, ca);
      if ((h & 0xff) < 118) return 0;                    // sparse: under half the cells
      const jx = ((h >>> 8) & 0xff) / 255, jy = ((h >>> 16) & 0xff) / 255;
      const fu = u * nu - cu - lerp(0.30, 0.70, jy);
      const fa = a * na - caRaw - lerp(0.30, 0.70, jx);
      const d = Math.hypot(fu, fa) * 1.4;
      const spot = 1 - smoothstep(0.35, 1.0, d);
      // Photophores sit on the dorsum and upper flank on a real fish, because
      // they are signalling upward; thermal patches are stripped further to the
      // back, where a vent crab's carapace actually heats.
      return pattern === BIOLUM_PATTERN.THERMAL_PATCHES
        ? spot * smoothstep(0.35, 0.85, dorsal)
        : spot * smoothstep(0.15, 0.60, dorsal);
    }
    case BIOLUM_PATTERN.STRIPES:
    case BIOLUM_PATTERN.FLASH_BURST: {
      const n = clamp(count, 2, Math.max(2, (rings - 1) >> 1));
      const x = u * n + 0.5;
      const phase = x - Math.floor(x);
      return 1 - smoothstep(0.16, 0.36, Math.abs(phase - 0.5));
    }
    case BIOLUM_PATTERN.VENTRAL_ROWS: {
      // Two ventral rows plus one lateral, which is a lanternfish's actual
      // photophore arrangement and reads as rows rather than as a stripe.
      const rows = band(a, 0.70, bw) + band(a, 0.80, bw) + 0.6 * band(a, 0.94, bw);
      return saturate(rows) * dot1D(u * 0.92 + 0.04, dots);
    }
    case BIOLUM_PATTERN.PIT_LIGHTS: {
      const rows = band(a, 0.10, bw) + band(a, 0.19, bw)
        + band(a, 0.81, bw) + band(a, 0.90, bw);
      return saturate(rows) * dot1D(u, dots);
    }
    case BIOLUM_PATTERN.COUNTER_ILLUM:
      // A continuous ventral field, not a pattern: this one IS meant to be a
      // smooth sheet, because it is hiding the animal's silhouette.
      return smoothstep(0.58, 0.96, ventral);
    case BIOLUM_PATTERN.NET: {
      // Worley-free reticulation: the zero set of a simplex field is a network
      // of closed curves, which is what a Gloomray's dorsal net actually is.
      // Sampled on a CIRCLE in theta rather than on theta itself, because
      // theta = 0 and theta = TAU are the same point on the animal and a linear
      // coordinate leaves the net visibly broken down one flank.
      const th = a * TAU;
      const v = simplex2(u * 9.0 + 2.2 * Math.cos(th), 2.2 * Math.sin(th),
        seed & 0x7fffffff);
      return (1 - smoothstep(0.0, 0.17, Math.abs(v))) * dorsal;
    }
    case BIOLUM_PATTERN.FLOOD_ORGAN:
      return (1 - smoothstep(0.06, 0.17, u)) * smoothstep(0.25, 0.75, dorsal);
    case BIOLUM_PATTERN.ABDOMEN:
      return smoothstep(0.48, 0.72, u) * smoothstep(0.3, 0.8, ventral);
    default:
      return 0;
  }
}

/**
 * The albedo patterns, on the same trunk parameterisation bodyPattern() uses:
 * `a` = uv.x = theta / TAU, where 0 and 0.5 are the two flanks, 0.25 the dorsum
 * and 0.75 the belly, and `u` = uv.y runs 0 at the snout to 1 at the tail tip.
 *
 * THIS IS THE SPEC, AND IT IS A PAIR WITH `albedoPatternMask()` IN
 * pass/creature.wgsl. The shader is what draws; this is what can be measured
 * offline, and tools/test-bestiary.mjs section 14 runs it over each patterned
 * species' REAL trunk uv set to check coverage, contrast and seam closure. Both
 * copies are ~40 lines of the same arithmetic; if one is edited the other must
 * be, and section 14's printed coverage per species is the number that shows
 * drift.
 *
 * `w` is the antialiasing half-width in (a, u) units - fwidth(uv) in the shader,
 * and 0 here, because an offline check wants the ideal pattern rather than the
 * one this pixel happens to see.
 *
 * Everything wraps correctly at the theta seam: the loft emits theta = 0 and
 * theta = TAU as two vertices at the same point, and every term is a function of
 * u, of the FOLDED distance in a, or of sin(a * TAU).
 *
 * @returns {number} SIGNED mask. Positive mixes toward the pattern colour;
 *   negative mixes toward a lifted ground colour, which is what an ocellus ring
 *   is.
 */
export function albedoPatternMask(kind, a, u, count, duty, hash = 0, w = 0) {
  const edge = (d, ww) => 1 - smoothstep(-Math.max(ww, 1e-4), Math.max(ww, 1e-4), d);
  const fract = (x) => x - Math.floor(x);
  const thetaDist = (aa, centre) => Math.abs(fract(aa - centre + 0.5) - 0.5);
  switch (kind) {
    case ALBEDO_PATTERN.BANDS: {
      const n = Math.max(count, 1);
      const phase = fract(u * n + hash * 0.37);
      return edge(Math.abs(phase - 0.5) - duty * 0.5, w * n)
        * smoothstep(0.02, 0.10, u) * (1 - smoothstep(0.88, 0.99, u));
    }
    case ALBEDO_PATTERN.STRIPE: {
      const d = Math.min(thetaDist(a, 0), thetaDist(a, 0.5));
      return edge(d - duty * 0.25, w)
        * smoothstep(0.05, 0.18, u) * (1 - smoothstep(0.82, 0.97, u));
    }
    case ALBEDO_PATTERN.SADDLES: {
      const n = Math.max(count, 1);
      const phase = fract(u * n + hash * 0.41);
      const bar = edge(Math.abs(phase - 0.5) - duty * 0.5, w * n);
      return bar * smoothstep(0.34, 0.86, 0.5 + 0.5 * Math.sin(a * TAU));
    }
    case ALBEDO_PATTERN.EYE_MASK: {
      const head = edge(Math.abs(u - 0.15) - 0.055, w);
      const tail = edge(Math.abs(u - 0.86) - 0.035, w);
      return Math.max(head, tail);
    }
    case ALBEDO_PATTERN.SPOTS: {
      const n = Math.max(count, 1);
      const th = a * TAU;
      const px = u * n * 1.7 + hash * 5.1;
      const py = (0.5 + 0.5 * Math.sin(th)) * n;
      const cx = Math.floor(px), cy = Math.floor(py);
      const jx = lerp(0.22, 0.78, hash2(cx, cy, 0x51c7));
      const jy = lerp(0.22, 0.78, hash2(cx, cy, 0x9e2b));
      const dx = (px - cx - jx), dy = (py - cy - jy) * 0.8;
      const r = 0.16 + 0.22 * duty;
      return edge(Math.hypot(dx, dy) - r, w * n * 1.7)
        * smoothstep(0.06, 0.16, u) * (1 - smoothstep(0.86, 0.98, u));
    }
    case ALBEDO_PATTERN.EYESPOT: {
      const du = (u - 0.74) / 0.10;
      const da = Math.min(thetaDist(a, 0), thetaDist(a, 0.5)) / 0.13;
      const d = Math.hypot(du, da);
      const core = edge(d - 1.0, w * 10);
      const ring = edge(d - 1.62, w * 10) - core;
      return core - 0.75 * Math.max(ring, 0);
    }
    default: return 0;
  }
}


/**
 * Write the mask into colors.w and the HDR colour into `emissive`.
 *
 * Doing this after the whole mesh exists, from the ranges, is what lets one
 * function serve every pattern: a range knows which part it is and the pattern
 * knows which parts it paints.
 */
function applyBiolum(cb, species, seed, rings, segs) {
  const vc = cb.mb.vertexCount;
  const emissive = new Float32Array(vc * 3);
  const bl = species.bioluminescence;
  const C = cb.mb.colors;
  const UV = cb.mb.uvs;
  const intensity = bl.intensity;
  const r = bl.colour[0] * intensity, g = bl.colour[1] * intensity, b = bl.colour[2] * intensity;
  const count = species.meshRecipe.biolumCount ?? 8;

  for (const range of cb.ranges) {
    for (let i = range.start; i < range.start + range.count; i++) {
      let mask = 0;
      switch (range.mode) {
        case 'const': mask = range.value; break;
        case 'tip': mask = smoothstep(0.68, 1.0, UV[i * 2 + 1]); break;
        case 'poreRow': mask = dot1D(UV[i * 2 + 1], range.count1d); break;
        case 'body':
          mask = bodyPattern(bl.pattern, UV[i * 2], UV[i * 2 + 1], count, seed, rings, segs);
          break;
        default: mask = 0; break;
      }
      mask = saturate(mask);
      C[i * 4 + 3] = mask;
      if (mask > 0 && intensity > 0) {
        emissive[i * 3] = r * mask;
        emissive[i * 3 + 1] = g * mask;
        emissive[i * 3 + 2] = b * mask;
        // A photophore is a hole in the pigment, not a light shining through
        // skin: give it the emissive material slot so lighting.wgsl stops
        // trying to shade it as tissue.
        if (mask > 0.55) cb.mb.materials[i] = M.EMISSIVE;
      }
    }
  }
  return emissive;
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/**
 * Where a jaw hinges, as a trunk parameter.
 *
 * A mandible extends FORWARD from its hinge to the snout, so the hinge sits one
 * jaw-length back from u = 0. Hinging at a fixed u and extending forward instead
 * would push the mouth out in front of the animal: the Hollowjaw's 6.2 m jaw did
 * exactly that and made a 31 m animal 40 m long.
 */
function jawHingeU(shape, jawLength) {
  return clamp(jawLength / Math.max(1e-6, shape.trunkLength), 0.03, 0.45);
}

/** Along-axis coordinate of trunk parameter u, in model space. */
function alongAt(shape, u) {
  return shape.start + saturate(u) * shape.trunkLength;
}

/** Half-width and half-height of the trunk at u, into `_st`. */
function girthAt(shape, u) {
  stationAt(shape, saturate(u), _st);
  return _st;
}

/** Place a point on the trunk surface at (u, theta) into `out`. */
function onTrunk(shape, u, theta, out) {
  return surfacePoint(shape, saturate(u), theta, out);
}

/**
 * Median fins - dorsal, anal - and the paired pectorals, from one descriptor.
 *
 * `at` is the trunk parameter of the fin root, `span` its height and `chord`
 * its base length; both are absolute metres, because a fin quoted as a fraction
 * of body length has to be re-derived for every species anyway.
 */
function addMedianFin(cb, shape, f, up, ctx, kind) {
  const th = up ? PI * 0.5 : -PI * 0.5;
  onTrunk(shape, f.at, th, _q0);
  const span = up ? [0, f.span, 0] : [0, -f.span, 0];
  addFin(cb, {
    // Sweep is measured against the SPAN: a fraction of the chord would make a
    // long low ridge sweep further backwards than it stands tall, and the path
    // direction would end up parallel to the chord axis.
    origin: _q0, span, sweep: [0, 0, f.span * (f.sweep ?? 0.35)],
    chordDir: [0, 0, 1], chord: f.chord, taper: 0.30, camber: f.camber ?? 0,
    thickness: Math.max(0.0015, f.chord * 0.07), stations: ctx.tier.fin,
    sides: ctx.tier.fin >= 5 ? 6 : 4,
    material: M.TRANSLUCENT, color: ctx.finColor, kind,
  });
}

/** Paired lateral fins: pectorals, ray cephalic wings, squid mantle fins. */
function addPairedFins(cb, shape, f, ctx, kind, dihedral = -0.25) {
  for (const side of [1, -1]) {
    onTrunk(shape, f.at, side > 0 ? 0 : PI, _q0);
    addFin(cb, {
      origin: _q0,
      span: [side * f.span, f.span * dihedral, 0],
      sweep: [0, 0, f.span * (f.sweep ?? 0.45)],
      chordDir: [0, 0, 1], chord: f.chord, taper: 0.26, camber: f.camber ?? 0,
      thickness: Math.max(0.0012, f.chord * 0.10), stations: ctx.tier.fin,
      sides: ctx.tier.fin >= 5 ? 6 : 4,
      material: M.TRANSLUCENT, color: ctx.finColor, kind,
    });
  }
}

/**
 * The tail fin. A fork or a fluke is two lobes off the tail tip; the
 * `horizontal` flag turns the pair from a fish's vertical caudal into a
 * cetacean's horizontal flukes, which is the correct silhouette for the Pale
 * Herald and the Ribbonwether and the wrong one for everything else.
 */
function addCaudal(cb, shape, f, ctx) {
  const tipU = 0.995;
  const zTip = alongAt(shape, tipU);
  const horizontal = !!f.horizontal;
  const fork = f.fork ?? 0.35;
  for (const side of [1, -1]) {
    const span = horizontal ? [side * f.span, 0, 0] : [0, side * f.span, 0];
    addFin(cb, {
      origin: [0, girthAt(shape, tipU)[2], zTip - f.chord * 0.35],
      span,
      sweep: [0, 0, f.chord * (0.5 + fork * 1.5)],
      chordDir: [0, 0, 1], chord: f.chord, taper: 0.34, camber: 0,
      thickness: Math.max(0.0015, f.chord * 0.06), stations: ctx.tier.fin + 1,
      sides: ctx.tier.fin >= 5 ? 6 : 4,
      material: M.TRANSLUCENT, color: ctx.finColor,
      kind: 'fluke',
    });
  }
}

/** A radial ring of blades: a crest, a dorsal ridge, a worm's gill plume. */
function addBladeRow(cb, shape, spec, ctx, kind, radial) {
  const n = dec(spec.count, ctx.tier);
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    if (radial) {
      // Plume: blades fan out of the tube mouth in a hemisphere.
      const th = (i / n) * TAU;
      const tilt = 0.55;
      onTrunk(shape, 0.985, th, _q0);
      addFin(cb, {
        origin: _q0,
        span: [Math.cos(th) * spec.length * tilt, spec.length, Math.sin(th) * spec.length * tilt],
        sweep: null,
        chordDir: [Math.cos(th + PI * 0.5), 0, Math.sin(th + PI * 0.5)],
        chord: spec.chord, taper: 0.22, camber: 0.05,
        thickness: Math.max(0.0012, spec.chord * 0.10), stations: ctx.tier.fin,
        sides: 4, material: M.TRANSLUCENT, color: ctx.accentColor,
        kind,
      });
    } else {
      const u = lerp(spec.from ?? 0.16, spec.to ?? 0.88, t);
      onTrunk(shape, u, PI * 0.5, _q0);
      addFin(cb, {
        origin: _q0, span: [0, spec.height, 0], sweep: [0, 0, spec.chord * 0.4],
        chordDir: [0, 0, 1], chord: spec.chord, taper: 0.18, camber: 0,
        // `thickness` override: the default 12%-of-chord slab is right for a
        // small blade row and wrong for a big single sail - the Splitmaw's
        // 7.5 m chord delivered a 0.9 m-thick BOX whose leading edge sat
        // dead-centre in the attack-telegraph framing as a hardware cube.
        thickness: Math.max(0.0012, spec.thickness ?? (spec.chord * 0.12)), stations: 2,
        sides: 4, material: kind === 'ridge' ? M.BONE : M.TRANSLUCENT,
        // `colour` overrides the tint-derived accent: a crest can be the
        // animal's display organ in a colour its skin does not carry (the
        // Splitmaw's crimson head sail, per its reference).
        color: kind === 'ridge' ? ctx.boneColor
          : (spec.colour ? rgb(spec.colour[0], spec.colour[1], spec.colour[2]) : ctx.accentColor),
        kind,
      });
    }
  }
}

/** Dermal flaps: paired, kelp-shaped, along both dorsal and ventral edges. */
function addFlaps(cb, shape, spec, ctx) {
  const n = dec(spec.count, ctx.tier);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const up = i % 2 === 0;
    const u = lerp(0.18, 0.92, t);
    const th = up ? PI * 0.5 : -PI * 0.5;
    onTrunk(shape, u, th, _q0);
    addFin(cb, {
      origin: _q0,
      span: [((i % 3) - 1) * spec.length * 0.25, up ? spec.length : -spec.length, spec.length * 0.3],
      sweep: null, chordDir: [0, 0, 1], chord: spec.chord, taper: 0.4, camber: 0,
      thickness: Math.max(0.001, spec.chord * 0.06), stations: 2, sides: 4,
      material: M.TRANSLUCENT, color: ctx.accentColor,
      kind: 'flap',
    });
  }
}

/** Wings: `count` membranes per side, swept and twisted like a real airfoil. */
function addWings(cb, shape, w, ctx) {
  const perSide = Math.max(1, (w.count / 2) | 0);
  for (let s = 0; s < perSide; s++) {
    const u = lerp(0.24, 0.52, perSide === 1 ? 0 : s / (perSide - 1));
    for (const side of [1, -1]) {
      onTrunk(shape, u, side > 0 ? 0 : PI, _q0);
      addFin(cb, {
        origin: _q0,
        span: [side * w.span, w.span * 0.10, 0],
        sweep: [0, 0, w.span * (w.sweep ?? 0.12)],
        chordDir: [0, 0, 1], chord: w.chord, taper: 0.30, camber: w.camber ?? 0.06,
        // Twist is what makes a flapping wing produce thrust rather than only
        // lift; extrudeAlongSpline applies it over the span for free.
        twist: (w.twist ?? 0) * side,
        thickness: Math.max(0.0008, w.chord * 0.05), stations: ctx.tier.fin + 1,
        sides: ctx.tier.fin >= 5 ? 6 : 4,
        material: M.TRANSLUCENT, color: ctx.finColor,
        kind: 'wing',
      });
    }
  }
}

/** Eyes: two spheres, or two dorsal spheres for a ray. */
function addEyes(cb, shape, e, ctx) {
  const mesh = uvSphere(ctx.tier.eye[0], ctx.tier.eye[1], e.radius, {
    material: M.CRYSTAL, color: ctx.eyeColor,
  });
  const th = e.dorsal ? PI * 0.5 : 0;
  girthAt(shape, e.at);
  const a = _st[0], b = _st[1], yc = _st[2];
  for (const side of [1, -1]) {
    const x = e.dorsal ? side * a * e.spread * 0.6 : side * a * e.spread;
    const y = e.dorsal ? yc + b * 0.72 : yc + b * 0.30;
    mat4.fromTranslation(_mat, [x, y, alongAt(shape, e.at)]);
    cb.mergePart(mesh, _mat, 0, 'eye');
  }
}

/**
 * Jaw: `lobes` plates around the mouth (2 = a mandible pair, 5 or 6 = the
 * radial gape of a Vaultstalker or a Nethercoil), plus teeth, plus an optional
 * emissive interior shell.
 *
 * Every plate binds rigidly to the jaw bone, so `jawOpen()` rotating that one
 * bone opens the whole mouth - which is the mandatory telegraph for every
 * predator in the game and therefore the part of this file that gameplay
 * actually depends on.
 */
function addJaw(cb, shape, j, ctx, skeleton) {
  const lobes = j.lobes ?? 2;
  const jl = j.length;
  const bone = skeleton.jaw;
  const uHinge = jawHingeU(shape, jl);
  girthAt(shape, uHinge);
  // The mouth is as wide as the head is WIDE and as tall as the head is TALL,
  // and conflating the two into one radius is how a laterally compressed fish
  // ends up with mandibles half a metre wider than its own skull.
  const mouthW = _st[0], mouthH = _st[1];
  const mouthR = Math.min(mouthW, mouthH);
  const z0 = alongAt(shape, uHinge);
  const stations = Math.max(3, ctx.tier.fin);

  // `plateColour` overrides the jaw plates' bone white: a closed mouth reads
  // as a MOUTH only if the plates are darker than the face around them, so a
  // pale-toothed dark seam survives the rest pose (the Splitmaw's review:
  // head-on there was no mouth at all - dark gum plates + pale teeth are the
  // reference's own closed-mouth read).
  const plateColor = j.plateColour
    ? rgb(j.plateColour[0], j.plateColour[1], j.plateColour[2]) : ctx.boneColor;
  for (let i = 0; i < lobes; i++) {
    // Two lobes are a top and bottom mandible; more are spaced around the bore.
    const th = lobes === 2 ? (i === 0 ? PI * 0.5 : -PI * 0.5) : (i / lobes) * TAU;
    const open = j.gape * 0.5 * (lobes === 2 ? (i === 0 ? 1 : -1) : 1);
    const dirY = Math.sin(th) * Math.sin(open * 0.5);
    const dirX = Math.cos(th) * Math.sin(open * 0.5);
    const rootX = Math.cos(th) * mouthW * 0.55;
    const rootY = Math.sin(th) * mouthH * 0.45;
    const path = new Float32Array(stations * 3);
    for (let k = 0; k < stations; k++) {
      const t = k / (stations - 1);
      path[k * 3] = rootX + dirX * jl * t * 0.8;
      path[k * 3 + 1] = rootY + dirY * jl * t * 0.8;
      path[k * 3 + 2] = z0 - jl * t;
    }
    // A wide, thin plate: a mandible is a blade, not a rod. The up hint is the
    // lobe's own radial direction, which makes the section's width tangential to
    // the bore and its thickness radial - i.e. a plate lying against the mouth
    // wall. Without it, splineFrames parallel-transports from an arbitrary
    // perpendicular and the mandibles land at random rolls.
    const w = lobes === 2 ? mouthW * 0.82 : mouthR * (1.9 / lobes);
    const profile = Float32Array.of(-1, -0.22, -0.55, -0.34, 0.55, -0.34, 1, -0.22, 0.5, 0.18, -0.5, 0.18);
    const mesh = extrudeAlongSpline(profile, path, 0, 0.42, {
      radius: w, upHint: [Math.cos(th), Math.sin(th), 0],
      material: M.BONE, color: plateColor, capStart: true, capEnd: true,
    });
    cb.mergePart(mesh, null, bone, 'jaw');
  }

  const teeth = dec(j.teeth | 0, ctx.tier);
  if (teeth > 0) {
    const th = ctx.tier.tooth;
    const tl = jl * 0.16, tr = jl * 0.045;
    const mesh = cone(tr, tl, th, { material: M.BONE, color: ctx.boneColor, cap: false });
    for (let i = 0; i < teeth; i++) {
      const t = (i + 0.5) / teeth;
      const row = i % 2 === 0 ? 1 : -1;
      const side = (i % 4) < 2 ? 1 : -1;
      const z = z0 - jl * lerp(0.12, 0.86, t);
      const x = side * mouthW * 0.62 * (1 - t * 0.4);
      const y = row * mouthH * 0.42 * (1 - t * 0.3);
      // Teeth point INTO the mouth, i.e. opposite their own jaw plate.
      quat.setAxisAngle(_quat, [0, 0, 1], row > 0 ? PI : 0);
      mat4.fromRotationTranslationScale(_mat, _quat, [x, y, z], _one);
      cb.mergePart(mesh, _mat, bone, 'tooth');
    }
  }

  if (j.interior) {
    // A mouth needs an inside. The Hollowjaw is NAMED for its pale ridged
    // interior and the Nethercoil's only visible light is the red glow inside
    // its jaw, so the interior is real geometry either way: a short inward-facing
    // cone shell behind the gape. Winding is reversed by the negative scale,
    // which is what makes it visible from in front instead of being culled.
    // `interiorDark` inverts the value read: a NEAR-BLACK gullet, for an
    // animal whose face must read as a hole ringed with pale teeth (the
    // Splitmaw; a pale interior on a pale head delivered no mouth at all
    // head-on, and head-on is the read this predator is built for).
    const glows = ctx.pattern === BIOLUM_PATTERN.MOUTH_GLOW;
    const bore = mouthR * 0.85;
    const mesh = cone(bore, jl * 0.55, Math.max(5, ctx.tier.segs >> 1), {
      material: glows ? M.EMISSIVE : M.BONE,
      color: glows ? ctx.emissiveColor : (j.interiorDark ? rgb(26, 20, 22) : ctx.boneColor),
      cap: false,
    });
    quat.setAxisAngle(_quat, [1, 0, 0], -PI * 0.5);
    mat4.fromRotationTranslationScale(_mat, _quat, [0, 0, z0 - jl * 0.05], Float32Array.of(1, 1, -1));
    cb.mergePart(mesh, _mat, bone, 'interior');
  }

  if (j.pharyngeal) {
    // The Saltwraith's second, inner jaw. It is real biology and, per the
    // design, the single most upsetting animation in the game; it needs to be
    // real geometry sitting behind the outer jaw for that to be possible.
    const inner = mouthR * 0.55;
    for (const side of [1, -1]) {
      const path = Float32Array.of(
        0, side * inner * 0.3, z0 + jl * j.pharyngeal,
        0, side * inner * 0.45, z0 + jl * j.pharyngeal * 0.4,
        0, side * inner * 0.5, z0 - jl * 0.1,
      );
      const mesh = extrudeAlongSpline(
        Float32Array.of(-1, -0.2, 0, -0.3, 1, -0.2, 0, 0.2), path, 0, 0.5,
        { radius: inner * 0.8, upHint: [0, side, 0], material: M.BONE, color: ctx.boneColor,
          capStart: true, capEnd: true },
      );
      cb.mergePart(mesh, null, bone, 'jaw');
    }
  }
  if (j.baleen) {
    // Gill rakers: thin translucent blades across the gape, which is what makes
    // an 18 m open mouth read as a filter rather than as a hole.
    const n = dec(j.baleen, ctx.tier);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const z = z0 - jl * lerp(0.25, 0.85, t);
      addFin(cb, {
        origin: [0, -mouthR * 0.2, z], span: [0, mouthR * 0.9, 0], sweep: null,
        chordDir: [1, 0, 0], chord: mouthR * 1.3, taper: 0.7, camber: 0,
        thickness: mouthR * 0.02, stations: 2, sides: 4,
        material: M.TRANSLUCENT, color: ctx.finColor, bone,
        kind: 'baleen',
      });
    }
  }
}

/**
 * Where one mandible horn is rooted on the skull, and which way it points.
 *
 * SHARED BY THE MESH AND THE SKELETON ON PURPOSE. `addMandibles` extrudes the
 * horn from this point and `buildCreatureBones` puts the horn's bone on it, and
 * the GPU pivots the fold about the bone's rest position - so if the two ever
 * computed the root differently the horn would swing about a point that is not
 * its own root and shear off the skull. One function, two callers.
 *
 * @param {object} shape from makeShape()
 * @param {object} spec the recipe's `mandibles` descriptor
 * @param {number} i horn index in [0, count)
 * @returns {{th: number, x: number, y: number, z: number}} `th` is the horn's
 *   radial angle about the body axis; xyz is the root in model space
 */
export function mandibleRoot(shape, spec, i) {
  const n = spec.count ?? 4;
  const at = spec.at ?? 0.05;
  girthAt(shape, at);
  const w = _st[0], hh = _st[1], yc = _st[2];
  const rootR = Math.min(w, hh) * 0.78;
  // X arrangement: offset half a step so four horns sit on the diagonals
  // (two upper, two lower), never straight up/down where they would fight
  // the dorsal crest and the jaw plates.
  const th = (i / n) * TAU + PI / n;
  return {
    th,
    x: Math.cos(th) * rootR,
    y: yc + Math.sin(th) * rootR,
    z: alongAt(shape, at),
  };
}

/**
 * Grasping mandible horns around the mouth: the splitmaw-class silhouette
 * (2026-08-19, built for the Splitmaw against its art-direction reference).
 *
 * ONE BONE PER HORN (BONE_ROLE.MANDIBLE), since 2026-08-21. They were rigid to
 * the head bone until then, and the reason recorded here was that the GPU jaw
 * solve is a single hinge PITCH (`creature.wgsl` `ROLE_JAW`), so four radial
 * horns bound to it would all pitch downward together - a scooping deformity,
 * not a flare. That is still true of the jaw bone; the fix was a role of their
 * own. Each horn's bone rotates it about the axis TANGENTIAL to that horn's own
 * radial, so all four open outward in their own planes, and the driver is the
 * same `jawOpen` scalar the maw between them already uses.
 *
 * THE MESH IS STILL AUTHORED IN THE OPEN POSE AND THE BONE ONLY EVER FOLDS IT
 * SHUT (`creature.wgsl` applies `-(1 - jawOpen) * fold`). That direction is
 * deliberate: `jawOpen = 1` reproduces the pre-splayed X below vertex for
 * vertex, so three creature-review rounds of silhouette work survive intact at
 * the exact moment the shot is about it, and only the at-rest pose is new.
 *
 * Each horn bows OUTWARD along its length (sin profile) with the tip still
 * proud of the snout, so head-on the four tips frame the open maw - the
 * head-on read is the one the player gets when it is coming at them.
 */
function addMandibles(cb, shape, spec, ctx, skeleton) {
  const n = spec.count ?? 4;
  const len = spec.length;
  const at = spec.at ?? 0.05;
  const colour = spec.colour ? rgb(spec.colour[0], spec.colour[1], spec.colour[2]) : ctx.tint;
  girthAt(shape, at);
  const w = _st[0], hh = _st[1], yc = _st[2];
  const z0 = alongAt(shape, at);
  const rootR = Math.min(w, hh) * 0.78;
  const stations = Math.max(4, ctx.tier.fin);
  const splay = spec.splay ?? 0.55;
  for (let i = 0; i < n; i++) {
    const th = mandibleRoot(shape, spec, i).th;
    const cx = Math.cos(th), sy = Math.sin(th);
    const path = new Float32Array(stations * 3);
    for (let k = 0; k < stations; k++) {
      const t = k / (stations - 1);
      const out = rootR + len * splay * Math.sin(t * PI * 0.62);
      path[k * 3] = cx * out;
      path[k * 3 + 1] = yc + sy * out;
      path[k * 3 + 2] = z0 - len * (0.10 + 0.90 * t);
    }
    // A horn is rounder than a jaw plate: a soft-cornered diamond section,
    // thicker radially than tangentially, tapering hard to the tip.
    const profile = Float32Array.of(-1, 0, -0.45, -0.62, 0.45, -0.62, 1, 0, 0.45, 0.62, -0.45, 0.62);
    // Hard taper to a point (review round 3: sphere tip caps read as
    // BOXING GLOVES - "a dark ball on a pink arm is a plush toy" - and any
    // knob at the end of a curved arm is mascot vocabulary; a horn earns
    // its menace by ending in nothing).
    const mesh = extrudeAlongSpline(profile, path, 0, spec.taper ?? 0.08, {
      radius: spec.chord ?? len * 0.14, upHint: [cx, sy, 0],
      material: M.BONE, color: colour, capStart: true, capEnd: true,
    });
    // The horn's OWN bone, not bone 0 - see the docstring. Falling back to the
    // head bone keeps a recipe that somehow reached here without a skeleton
    // rendering as it did before, rather than binding to slot 0 by accident.
    cb.mergePart(mesh, null, skeleton?.mandibles?.[i] ?? 0, 'mandible');
  }
}

/** The angler's illicium and esca, both rigid on the lure bone. */
function addLure(cb, shape, l, ctx, skeleton) {
  const bone = skeleton.lure;
  girthAt(shape, 0.12);
  const y0 = _st[2] + _st[1] * 0.9;
  const z0 = alongAt(shape, 0.12);
  const st = Math.max(3, l.segments | 0);
  const path = new Float32Array(st * 3);
  for (let i = 0; i < st; i++) {
    const t = i / (st - 1);
    // Arcs up and forward, so the esca hangs in front of the animal's own face.
    path[i * 3] = 0;
    path[i * 3 + 1] = y0 + Math.sin(t * PI * 0.55) * l.length * 0.55;
    path[i * 3 + 2] = z0 - t * l.length * 0.85;
  }
  addTube(cb, {
    path, radius: l.radius, taper: 0.6, sides: 4, material: M.FLORA,
    color: ctx.tint, bone, kind: 'illicium',
  });
  const esca = uvSphere(ctx.tier.eye[0], ctx.tier.eye[1], l.escaRadius, {
    material: M.EMISSIVE, color: ctx.emissiveColor,
  });
  mat4.fromTranslation(_mat, [0, path[(st - 1) * 3 + 1], path[(st - 1) * 3 + 2]]);
  cb.mergePart(esca, _mat, bone, 'esca');
}

/** Trailing appendages: arms, tentacles, oral arms, filaments, streamers. */
function addStrands(cb, shape, spec, ctx, kind, fromU, dirZ, zSpread) {
  const n = dec(spec.count, ctx.tier);
  const st = ctx.tier.tubeSt + 2;
  girthAt(shape, fromU);
  const a = _st[0], b = _st[1], yc = _st[2];
  const z0 = alongAt(shape, fromU);
  for (let i = 0; i < n; i++) {
    const th = (i / n) * TAU + 0.31;
    const ox = Math.cos(th) * a * 0.7;
    const oy = yc + Math.sin(th) * b * 0.7;
    // A siphonophore does not hang its tentacles from one point: it hangs a
    // CURTAIN down twenty metres of stem, and the curtain is the hazard the
    // player drives into. When zSpread is given the strands are distributed
    // along it instead of arranged around a single ring.
    const zStart = zSpread ? lerp(zSpread[0], zSpread[1], (i + 0.5) / n) : z0;
    const path = curvedPath(
      [ox, oy, zStart],
      [0, 0, dirZ],
      [Math.cos(th) * 0.55, Math.sin(th) * 0.55, 0],
      spec.length, spec.curl ?? 0.07, st,
    );
    addTube(cb, {
      path, radius: spec.radius, taper: spec.taper ?? 0.2,
      sides: ctx.tier.tubeSides, bulge: spec.padScale,
      material: kind === 'tentacle' ? M.TRANSLUCENT : M.FLORA,
      color: kind === 'tentacle' ? ctx.finColor : ctx.tint,
      kind,
    });
  }
}

/** Legs: two-segment limbs with a knee, alternating along the trunk. */
function addLegs(cb, shape, spec, ctx) {
  const n = Math.max(2, spec.count | 0);
  const perSide = n >> 1;
  const st = Math.max(4, ctx.tier.tubeSt);
  for (let i = 0; i < perSide; i++) {
    const f = perSide === 1 ? 0.5 : i / (perSide - 1);
    const u = lerp(0.20, 0.86, f);
    for (const side of [1, -1]) {
      const hipTh = side > 0 ? -0.35 : PI + 0.35;
      onTrunk(shape, u, hipTh, _q0);
      const fore = i === 0 && spec.forelimbScale ? spec.forelimbScale : 1;
      const len = spec.length * fore;
      const splay = spec.splay ?? 0.9;
      // Legs FAN fore-and-aft as well as outward: the front pair reaches
      // forward, the back pair trails. Without the fan every leg lies in one
      // transverse plane and a crab reads as a hovercraft on pins.
      const fan = lerp(-0.55, 0.75, f);
      const ox = Math.cos(fan) * splay, oz = Math.sin(fan) * splay;
      const path = new Float32Array(st * 3);
      for (let k = 0; k < st; k++) {
        const t = k / (st - 1);
        // Knee at t = 0.45: out and barely down, then down to the foot. A
        // straight leg reads as a spider's, and none of these are spiders.
        const outward = Math.sin(Math.min(1, t / 0.45) * PI * 0.5);
        const drop = t < 0.45 ? -0.12 * (t / 0.45) : -0.12 - 0.95 * ((t - 0.45) / 0.55);
        path[k * 3] = _q0[0] + side * ox * outward * len;
        path[k * 3 + 1] = _q0[1] + drop * len;
        path[k * 3 + 2] = _q0[2] + oz * outward * len * 0.7;
      }
      addTube(cb, {
        path, radius: spec.radius * fore, taper: 0.22, sides: 4,
        material: M.BONE, color: ctx.carapaceColor,
        kind: 'leg',
      });
    }
  }
}

/** Chelae: two lathed pincer fingers per claw, one scaled by `asymmetry`. */
function addClaws(cb, shape, spec, ctx) {
  const profile = Float32Array.of(
    0.05, 0, 0.35, 0.12, 0.50, 0.34, 0.48, 0.60, 0.30, 0.82, 0.08, 0.96, 0.0, 1.0,
  );
  // No base disc: the finger's root is inside the animal's own carapace.
  const base = lathe(profile, Math.max(5, ctx.tier.segs >> 1), {
    material: M.BONE, color: ctx.carapaceColor,
  });
  // Hinged at the carapace's front corner, not floating in front of it.
  onTrunk(shape, 0.16, -0.25, _q0);
  for (let c = 0; c < Math.max(1, spec.count | 0); c++) {
    const side = c === 0 ? 1 : -1;
    const scale = c === 0 ? 1 : (spec.asymmetry ?? 0.6);
    const len = spec.length * scale;
    for (const finger of [1, -1]) {
      // Rotate +Y (the lathe axis) onto -Z (forward), then hinge the two
      // fingers apart about X so the claw reads as open.
      quat.setAxisAngle(_quat, [1, 0, 0], -PI * 0.5 + finger * 0.34);
      mat4.fromRotationTranslationScale(_mat, _quat,
        [side * Math.abs(_q0[0]) * 0.85, _q0[1], _q0[2] - len * 0.05],
        Float32Array.of(len * 0.30, len, len * 0.24));
      cb.mergePart(base, _mat, -1, 'claw');
    }
  }
}

/** Eyestalks: a short tube with a sphere on the end. */
function addEyestalks(cb, shape, spec, ctx) {
  const eye = uvSphere(Math.max(4, ctx.tier.eye[0] - 2), Math.max(3, ctx.tier.eye[1] - 1),
    spec.radius, { material: M.CRYSTAL, color: ctx.eyeColor });
  const sides = spec.count >= 2 ? [1, -1] : [1];
  for (const side of sides) {
    onTrunk(shape, 0.12, side > 0 ? 0.6 : PI - 0.6, _q0);
    const tipY = _q0[1] + spec.length;
    addTube(cb, {
      path: Float32Array.of(_q0[0], _q0[1], _q0[2], _q0[0] * 1.1, tipY, _q0[2] - spec.length * 0.3),
      radius: spec.radius * 0.45, taper: 0.9, sides: 4, material: M.FLORA,
      color: ctx.tint, bone: 0, kind: 'eyestalk',
    });
    mat4.fromTranslation(_mat, [_q0[0] * 1.1, tipY, _q0[2] - spec.length * 0.3]);
    cb.mergePart(eye, _mat, 0, 'eye');
  }
}

/** Antennae or barbels: thin whips off the head. */
function addWhiskers(cb, shape, count, length, radius, ctx, kind) {
  const n = dec(count, ctx.tier);
  const st = Math.max(3, ctx.tier.tubeSt);
  for (let i = 0; i < n; i++) {
    const th = ((i + 0.5) / n) * TAU;
    onTrunk(shape, 0.07, th, _q0);
    const path = curvedPath(
      _q0, [0, 0, -1], [Math.cos(th) * 0.7, Math.sin(th) * 0.7, 0], length, 0.45, st,
    );
    addTube(cb, {
      path, radius, taper: 0.25, sides: 4, material: M.FLORA, color: ctx.tint,
      bone: 0, kind,
    });
  }
}

/** A whip tail off the trunk's tail tip: ray tails, and only ray tails. */
function addTail(cb, shape, spec, ctx) {
  const st = ctx.tier.tubeSt + 3;
  const z0 = alongAt(shape, 0.98);
  girthAt(shape, 0.98);
  const path = new Float32Array(st * 3);
  for (let i = 0; i < st; i++) {
    const t = i / (st - 1);
    path[i * 3] = 0;
    path[i * 3 + 1] = _st[2] + Math.sin(t * PI * 0.4) * spec.length * 0.10;
    path[i * 3 + 2] = z0 + t * spec.length;
  }
  const radius = Math.max(1e-3, _st[1] * 0.55);
  addTube(cb, {
    path, radius, taper: spec.taper ?? 0.12, sides: 4, material: M.FLORA,
    color: ctx.tint, kind: 'tail',
  });
  const barbs = dec(spec.barbs | 0, ctx.tier);
  if (barbs > 0) {
    const mesh = cone(radius * 0.6, spec.length * 0.16, ctx.tier.tooth,
      { material: M.BONE, color: ctx.boneColor, cap: false });
    for (let i = 0; i < barbs; i++) {
      const t = lerp(0.30, 0.62, barbs === 1 ? 0 : i / (barbs - 1));
      quat.setAxisAngle(_quat, [1, 0, 0], -PI * 0.5);
      mat4.fromRotationTranslationScale(_mat, _quat,
        [0, path[Math.round(t * (st - 1)) * 3 + 1] + radius * 0.4, z0 + t * spec.length], _one);
      cb.mergePart(mesh, _mat, -1, 'spine');
    }
  }
}

/**
 * Spines: cones standing off the trunk surface along its outward radial.
 *
 * Placement uses the golden angle rather than a lattice, so consecutive spines
 * land far apart and a sparse set (an urchin at LOD budget carries 13, not 40)
 * still covers the body instead of forming a visible row.
 */
function addSpines(cb, shape, spec, ctx) {
  const n = dec(spec.count, ctx.tier);
  const mesh = cone(spec.radius, spec.length, ctx.tier.tooth,
    { material: M.BONE, color: ctx.boneColor, cap: false });
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    const th = i * 2.399963;
    onTrunk(shape, u, th, _q0);
    const rx = _sec[0], ry = _sec[1];
    const rl = Math.hypot(rx, ry) || 1;
    // Rotate the cone's +Y axis onto that radial. atan2(x, y) is the angle from
    // +Y toward +X, which is what a rotation about the third axis undoes.
    if (shape.along === 1) {
      // Body axis is +Y, so the radial lies in XZ and no rotation ABOUT Y can
      // reach it. Swing +Y a quarter turn about (dz, 0, -dx) = cross(+Y, d).
      const dx = rx / rl, dz = ry / rl;
      quat.setAxisAngle(_quat, [dz, 0, -dx], PI * 0.5);
    } else {
      const angle = Math.atan2(rx / rl, ry / rl);
      quat.setAxisAngle(_quat, [0, 0, 1], -angle);
    }
    mat4.fromRotationTranslationScale(_mat, _quat, _q0, _one);
    cb.mergePart(mesh, _mat, -1, 'spine');
  }
}

/** Lateral armour spines: rings of them every `every` plates. */
function addLateralSpines(cb, shape, spec, ctx, plates) {
  const every = Math.max(1, spec.every | 0);
  const groups = Math.max(1, Math.floor(plates / every));
  const perRing = dec(spec.count, ctx.tier);
  const mesh = cone(spec.radius, spec.length, ctx.tier.tooth,
    { material: M.BONE, color: ctx.boneColor, cap: false });
  for (let g = 0; g < groups; g++) {
    const u = (g + 0.5) / groups;
    for (let i = 0; i < perRing; i++) {
      const th = (i / perRing) * TAU;
      onTrunk(shape, u, th, _q0);
      const angle = Math.atan2(Math.cos(th), Math.sin(th));
      quat.setAxisAngle(_quat, [0, 0, 1], -angle);
      mat4.fromRotationTranslationScale(_mat, _quat, _q0, _one);
      cb.mergePart(mesh, _mat, -1, 'spine');
    }
  }
}

/** Electric organs: flattened emissive lenses under the dorsal skin. */
function addOrgans(cb, shape, spec, ctx) {
  const mesh = uvSphere(Math.max(6, ctx.tier.eye[0]), Math.max(4, ctx.tier.eye[1]), spec.radius, {
    material: M.EMISSIVE, color: ctx.emissiveColor, radiusY: spec.radius * 0.22,
  });
  girthAt(shape, spec.at);
  for (let i = 0; i < Math.max(1, spec.count | 0); i++) {
    const side = i % 2 === 0 ? 1 : -1;
    mat4.fromRotationTranslationScale(_mat, quat.identity(_quat),
      [side * _st[0] * 0.34, _st[2] + _st[1] * 0.72, alongAt(shape, spec.at)],
      Float32Array.of(1, 1, 1.7));
    cb.mergePart(mesh, _mat, -1, 'organ');
  }
}

/** Cephalic lobes: the two forward horns of a devil ray. */
function addLobes(cb, shape, spec, ctx) {
  const mesh = cone(spec.radius, spec.length, Math.max(5, ctx.tier.segs >> 1),
    { material: M.FLORA, color: ctx.tint });
  girthAt(shape, 0.06);
  for (let i = 0; i < Math.max(1, spec.count | 0); i++) {
    const side = i % 2 === 0 ? 1 : -1;
    // Point them forward and slightly outward.
    quat.setAxisAngle(_quat, [1, 0, 0], -PI * 0.5);
    mat4.fromRotationTranslationScale(_mat, _quat,
      [side * _st[0] * 0.45, _st[2], alongAt(shape, 0.04)], _one);
    cb.mergePart(mesh, _mat, 0, 'lobe');
  }
}

/**
 * Snout or beak: a short tapering tube off the nose, `hook` bending it down.
 *
 * `hard` separates the two: a keratin beak (a Vaneskimmer's hook, a Bloatspine's
 * parrot beak) is pale calcite, but a fish's SNOUT is skin and takes the body's
 * own colour - a bone-white muzzle on the chrome-yellow Sunplate read as damage.
 */
function addBeak(cb, shape, spec, ctx, hard) {
  const st = Math.max(3, ctx.tier.tubeSt);
  girthAt(shape, 0.03);
  const z0 = alongAt(shape, 0.02);
  const path = new Float32Array(st * 3);
  for (let i = 0; i < st; i++) {
    const t = i / (st - 1);
    path[i * 3] = 0;
    path[i * 3 + 1] = _st[2] - (spec.hook ?? 0) * spec.length * t * t;
    path[i * 3 + 2] = z0 - t * spec.length;
  }
  addTube(cb, {
    path, radius: Math.max(_st[0], _st[1]) * 0.55, taper: spec.taper ?? 0.12,
    sides: 4, material: hard ? M.BONE : M.FLORA,
    color: hard ? ctx.boneColor : ctx.tint, bone: 0,
    kind: 'snout',
  });
}

/** A hagfish's rasping oral disc: a shallow ring plus two tooth plates. */
function addOralDisc(cb, shape, spec, ctx) {
  const profile = Float32Array.of(
    spec.radius * 0.30, 0, spec.radius * 0.80, spec.radius * 0.22,
    spec.radius, spec.radius * 0.55, spec.radius * 0.72, spec.radius * 0.78,
  );
  const mesh = lathe(profile, Math.max(6, ctx.tier.segs), {
    material: M.FLORA, color: ctx.tint,
  });
  quat.setAxisAngle(_quat, [1, 0, 0], PI * 0.5);
  mat4.fromRotationTranslationScale(_mat, _quat, [0, 0, alongAt(shape, 0.02)], _one);
  cb.mergePart(mesh, _mat, 0, 'jaw');
  const rasps = Math.max(0, spec.rasps | 0);
  const plate = cone(spec.radius * 0.30, spec.radius * 0.55, ctx.tier.tooth,
    { material: M.BONE, color: ctx.boneColor });
  for (let i = 0; i < rasps; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    quat.setAxisAngle(_quat, [1, 0, 0], -PI * 0.5);
    mat4.fromRotationTranslationScale(_mat, _quat,
      [0, side * spec.radius * 0.35, alongAt(shape, 0.02)], _one);
    cb.mergePart(plate, _mat, 0, 'tooth');
  }
}

/** Pleopods or uropods: tiny paddle fins under the tail. */
function addPaddles(cb, shape, count, ctx, kind) {
  const n = dec(count, ctx.tier);
  for (let i = 0; i < n; i++) {
    const u = lerp(0.62, 0.96, n === 1 ? 0.5 : i / (n - 1));
    girthAt(shape, u);
    const chord = Math.max(1e-3, _st[1] * 0.9);
    for (const side of [1, -1]) {
      onTrunk(shape, u, side > 0 ? -0.7 : PI + 0.7, _q0);
      addFin(cb, {
        origin: _q0, span: [side * chord * 1.1, -chord * 0.8, chord * 0.6], sweep: null,
        chordDir: [0, 0, 1], chord, taper: 0.55, camber: 0,
        thickness: chord * 0.08, stations: 2, sides: 4,
        material: M.TRANSLUCENT, color: ctx.finColor,
        kind,
      });
    }
  }
}

/** The larvacean's mucous house: a transparent shell around the animal. */
function addHouse(cb, shape, spec, ctx) {
  const mesh = uvSphere(Math.max(8, ctx.segs), Math.max(5, ctx.rings >> 1), spec.radius, {
    material: M.TRANSLUCENT, color: ctx.finColor, radiusY: spec.radius * 0.78,
  });
  mat4.fromTranslation(_mat, [0, 0, alongAt(shape, 0.35)]);
  cb.mergePart(mesh, _mat, -1, 'house');
}

// ---------------------------------------------------------------------------
// Lathed trunks: bells and shells
// ---------------------------------------------------------------------------

/**
 * A jelly bell: a dome that flares to a rim and then folds back under itself
 * into the subumbrellar cavity, in one continuous lathed surface.
 *
 * Lathe builds about +Y, so the whole thing is rotated -90 degrees about X to
 * put the apex forward along -Z, which is where a pulsing jelly's apex points
 * when it is actually going somewhere.
 */
function bellProfile(radius, height, thick) {
  const r = radius, h = height;
  // Wall thickness as a fraction of the radius. A Ghostbell is a heavy,
  // light-drinking bell and a Bellflower is a film; the difference is entirely in
  // how far the subumbrellar surface sits inside the rim.
  const w = thick ? 0.26 : 0.12;
  return Float32Array.of(
    0.00 * r, h,
    0.30 * r, 0.94 * h,
    0.58 * r, 0.78 * h,
    0.80 * r, 0.54 * h,
    0.94 * r, 0.28 * h,
    1.00 * r, 0.04 * h,
    // Back up the inside. The cavity has to reach most of the way to the apex or
    // the bell reads as a solid dome rather than as a jellyfish.
    (1 - w) * r, 0.12 * h,
    (0.80 - w) * r, 0.34 * h,
    (0.52 - w) * r, 0.52 * h,
    (0.22 - w * 0.5) * r, 0.62 * h,
    0.00 * r, 0.66 * h,
  );
}

function addBell(cb, spec, ctx, zApex, bone) {
  // ctx.segs, not ctx.tier.segs: a jelly IS its silhouette, and the recipe asks
  // for 14 or 16 sides precisely because the tier's 8 reads as an octagon.
  const segs = Math.max(6, ctx.segs);
  const ribs = Math.max(0, spec.ribs | 0);
  const mesh = lathe(bellProfile(spec.radius, spec.height, spec.thick), segs, {
    material: M.TRANSLUCENT, color: ctx.finColor,
    // Ribbed canals: a radial modulation is the cheapest way to get the eight
    // gastric canals that make a bell read as an animal and not a lampshade.
    modulate: ribs > 0 ? (t, th) => 1 + 0.045 * Math.cos(th * ribs) * smoothstep(0.05, 0.7, t) : null,
  });
  quat.setAxisAngle(_quat, [1, 0, 0], -PI * 0.5);
  mat4.fromRotationTranslationScale(_mat, _quat, [0, 0, zApex + spec.height], _one);
  cb.mergePart(mesh, _mat, bone, 'bell');
}

/**
 * A gastropod shell: a logarithmic spiral profile, ribbed.
 *
 * The spiral is in the PROFILE, not in a helical sweep: a low conical shell
 * seen from outside is a cone whose radius follows r = r0 * k^y, and a real
 * helix would cost four times the geometry for a silhouette the player sees
 * from two metres away in a kelp forest.
 */
function addShell(cb, shape, spec, ctx, bone) {
  const rings = 9;
  const profile = new Float32Array(rings * 2);
  const k = Math.pow(spec.apex ?? 0.42, 1 / Math.max(1, spec.whorls));
  // Radius from the plan's girth and height from its trunk fraction. makeShape
  // derives the attachment table from this same expression, so the eyestalks and
  // the foot sit on the surface the lathe actually emits.
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    profile[i * 2] = shape.aScale * Math.pow(k, t * spec.whorls) * (1 - Math.pow(t, 3.2));
    profile[i * 2 + 1] = shape.trunkLength * t;
  }
  const ribs = Math.max(0, spec.ribs | 0);
  const mesh = lathe(profile, Math.max(8, ctx.segs), {
    material: M.BONE, color: ctx.carapaceColor, closeBottom: true,
    modulate: ribs > 0 ? (t, th) => 1 + 0.05 * Math.cos(th * ribs) : null,
  });
  cb.mergePart(mesh, null, bone, 'shell');
}

/** An urchin's test: an oblate lathed sphere. */
function addTest(cb, shape, spec, ctx, bone) {
  const rings = 9;
  const profile = new Float32Array(rings * 2);
  // Radius from the plan's girth, height from `oblate`. makeShape sets
  // trunkLength to this lathe's own 2 * hh and its table to r = rr sin(a), so
  // the spines are placed against the ellipsoid rather than near it.
  const rr = shape.aScale, hh = rr * (spec.oblate ?? 0.62);
  for (let i = 0; i < rings; i++) {
    const a = (i / (rings - 1)) * PI;
    profile[i * 2] = rr * Math.sin(a);
    profile[i * 2 + 1] = hh * (1 - Math.cos(a));
  }
  const mesh = lathe(profile, Math.max(8, ctx.segs), {
    material: M.BONE, color: ctx.carapaceColor,
  });
  cb.mergePart(mesh, null, bone, 'test');
}

/** A gastropod's muscular foot: a squashed ellipsoid under the shell. */
function addFoot(cb, spec, ctx) {
  const mesh = uvSphere(Math.max(8, ctx.segs), Math.max(4, ctx.rings >> 1), 1, {
    material: M.FLORA, color: ctx.tint,
  });
  mat4.fromRotationTranslationScale(_mat, quat.identity(_quat),
    [0, spec.height * 0.5, 0],
    Float32Array.of(spec.width * 0.5, spec.height * 0.5, spec.length * 0.5));
  cb.mergePart(mesh, _mat, 0, 'foot');
}

/**
 * A siphonophore: a stack of swimming bells at the front and a long stem
 * carrying the fishing tentacles.
 *
 * The stack is real geometry because the player will fly a vessel through it,
 * and each bell binds to the spine bone under it so the stack pulses with a
 * phase offset travelling down the chain.
 */
function addNectophoreStack(cb, spec, ctx, L, skeleton) {
  const n = dec(spec.count, ctx.tier);
  // The recipe's own segment count with a floor, not the size tier's: the tier
  // is chosen from the 26 m COLONY and these are 0.45 m bells, so the tier
  // over-tessellates them by half while a bare floor of 10 keeps a bell the
  // vessel is threaded past from reading as a hexagon.
  const segs = Math.max(10, ctx.segs);
  const mesh = lathe(bellProfile(spec.radius, spec.radius * 1.25, false), segs, {
    material: M.TRANSLUCENT, color: ctx.finColor,
  });
  for (let i = 0; i < n; i++) {
    const z = -L * 0.5 + spec.spacing * i;
    // Nearest spine bone, so each bell is rigid and the stack articulates.
    const u = saturate((z + L * 0.5) / L);
    const bone = Math.min(skeleton.spineCount - 1, Math.round(u * (skeleton.spineCount - 1)));
    quat.setAxisAngle(_quat, [1, 0, 0], -PI * 0.5);
    mat4.fromRotationTranslationScale(_mat, _quat,
      [Math.cos(i * 2.1) * spec.radius * 0.22, Math.sin(i * 2.1) * spec.radius * 0.22, z], _one);
    cb.mergePart(mesh, _mat, bone, 'bell');
  }
}

function addStem(cb, spec, ctx, startZ) {
  const st = ctx.tier.tubeSt + 6;
  const path = new Float32Array(st * 3);
  for (let i = 0; i < st; i++) {
    const t = i / (st - 1);
    path[i * 3] = Math.sin(t * 3.1) * spec.radius * 3.0;
    path[i * 3 + 1] = Math.cos(t * 2.3) * spec.radius * 2.0;
    path[i * 3 + 2] = startZ + t * spec.length;
  }
  addTube(cb, {
    path, radius: spec.radius, taper: 0.55, sides: 4, material: M.FLORA,
    color: ctx.tint, kind: 'stem',
  });
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Build one creature.
 *
 * @param {object} species a bestiary SPECIES record
 * @param {number} [seed] changes the bioluminescent pattern's cell jitter on the
 *   three species whose mask is hashed (Frondmaw spots, Scaldback thermal
 *   patches, Gloomray net) and nothing else - positions are seed-independent so
 *   a whole school can share one vertex buffer. The renderer builds ONE mesh per
 *   species and derives this from the species index, so per-individual variety
 *   comes from the instance scale and tint, not from here.
 * @returns {{positions: Float32Array, normals: Float32Array, uvs: Float32Array,
 *   colors: Float32Array, materials: Uint8Array, tangents: Float32Array,
 *   emissive: Float32Array, inflate: Float32Array, boneIndices: Uint8Array,
 *   boneWeights: Float32Array, indices: Uint32Array, bones: Array<object>,
 *   boneCount: number, spineCount: number, jawBone: number, lureBone: number,
 *   aabb: AABB, boundingRadius: number, vertexCount: number, indexCount: number,
 *   triangleCount: number, species: string, budget: number,
 *   parts: Array<{kind: string, bone: number, start: number, count: number}>}}
 *
 *   colors      linear RGB in xyz, BIOLUMINESCENCE MASK in w (not sway)
 *   emissive    HDR linear RGB, already multiplied by the mask
 *   inflate     0..1 per-vertex inflation weight; all zero unless the species
 *               has an `inflate` recipe (the Bloatspine and the Pale Herald's
 *               melon are the two that do)
 *   boneIndices 4 per vertex, into `bones`
 *   boneWeights 4 per vertex, summing to exactly 1
 *   parts       the vertex range each anatomical part occupies, in build order,
 *               so a consumer can drop the tentacles at LOD1 or draw the
 *               emissive parts in a second pass without re-deriving anything
 */
export function buildCreatureMesh(species, seed = 0x1a7e0001) {
  const recipe = species.meshRecipe;
  const plan = BODY_PLAN[recipe.plan];
  if (!plan) throw new Error(`creature_mesh: unknown body plan '${recipe.plan}' for ${species.id}`);

  const L = species.length;
  const tier = tierFor(L);
  const rings = Math.max(4, recipe.rings ?? tier.rings);
  const segs = Math.max(4, recipe.segs ?? tier.segs);
  const skeleton = buildCreatureBones(species);
  // Rounded caps: two rings on a sprat, three on a leviathan, where the extra
  // ring is worth more than the 20 vertices it costs.
  const capRings = segs >= 14 ? 3 : 2;

  const tint = rgb(recipe.tint[0], recipe.tint[1], recipe.tint[2]);
  const ventral = recipe.ventral
    ? rgb(recipe.ventral[0], recipe.ventral[1], recipe.ventral[2])
    : ventralOf(tint);
  const bl = species.bioluminescence;

  const ctx = {
    tier, rings, segs, pattern: bl.pattern,
    count: recipe.biolumCount ?? 8,
    tint,
    // A FIN IS THE ANIMAL'S OWN COLOUR, DARKER, AND THE LIFT COMES FROM THE
    // LIGHT. It used to be lerp(tint, 0.5, 0.30) - a lerp toward mid grey, which
    // is a hue-DESTROYING operation on exactly the channel a coloured fish has
    // least of: a lime tint's 0.019 blue went to 0.163, and blue is the channel
    // the water column amplifies most. Then finSurface() lights the sheet from
    // both faces (translucency 0.72-0.96), so the fin came out BRIGHTER than the
    // body as well as greyer. MEASURED at 1.9 m in the lagoon: fin HSV
    // saturation 0.152 at value 0.975, against a body at 0.331 / 0.866 - and on
    // a 0.55 m fish whose dorsal chord is 35% of its body length that is the
    // largest single area on screen.
    //
    // Multiplicative keeps the hue exactly; 0.62 is the factor that puts the
    // doubly-lit sheet back level with the singly-lit body, and the 0.02 floor
    // is the scattering a thin membrane really does add.
    finColor: Float32Array.of(tint[0] * 0.62 + 0.02, tint[1] * 0.62 + 0.02, tint[2] * 0.62 + 0.02, 0),
    accentColor: Float32Array.of(tint[0] * 0.72, tint[1] * 0.78, tint[2] * 0.70, 0),
    // CHITIN IS NOT TOOTH ENAMEL. A crab's legs and chelae, a gastropod's shell
    // and an urchin's test are the animal's own colour; only teeth, spines,
    // barbs and rasps are the pale calcite `boneColor` stands for. Painting the
    // first group with boneColor made the Spinecrown's "deep-purple test" and
    // the Reefcropper's turf-encrusted shell uniformly bone-white - for the
    // urchin, EVERY vertex in the mesh was bone-white and its datasheet colour
    // appeared nowhere - and gave the brick-red Scaldback eight white legs.
    carapaceColor: Float32Array.of(tint[0], tint[1], tint[2], 0),
    boneColor: rgb(214, 206, 186),
    eyeColor: rgb(16, 18, 22),
    emissiveColor: Float32Array.of(bl.colour[0], bl.colour[1], bl.colour[2], 0),
  };

  // Armour and segment plating need three rings per plate or the lip reads as
  // noise instead of as an overlapping tergite.
  const plates = recipe.plates | 0;
  const bodyRings = plates > 0 ? Math.max(rings, plates * 3) : rings;
  const shape = makeShape(plan, recipe, L);

  const cb = new CreatureBuilder(Math.min(tier.budget, 4096), bl.pattern, ctx.count);
  // Where a colonial animal's stem begins: just behind its swimming-bell stack.
  const stemStartZ = -L * 0.5 + (recipe.nectophores ? recipe.nectophores.spacing * 0.5 : 0);

  // ---- trunk -------------------------------------------------------------
  if (recipe.bell) {
    addBell(cb, recipe.bell, ctx, -L * 0.5, 0);
  } else if (recipe.nectophores) {
    addNectophoreStack(cb, recipe.nectophores, ctx, L, skeleton);
    if (recipe.stem) addStem(cb, recipe.stem, ctx, stemStartZ);
  } else if (recipe.shell) {
    addShell(cb, shape, recipe.shell, ctx, 0);
  } else if (recipe.test) {
    addTest(cb, shape, recipe.test, ctx, 0);
  } else {
    loftTrunk(cb, shape, bodyRings, segs, capRings, tint, ventral);
  }
  if (recipe.foot) addFoot(cb, recipe.foot, ctx);
  if (recipe.house) addHouse(cb, shape, recipe.house, ctx);

  // ---- head --------------------------------------------------------------
  if (recipe.snout) addBeak(cb, shape, recipe.snout, ctx, false);
  if (recipe.beak) addBeak(cb, shape, recipe.beak, ctx, true);
  if (recipe.oralDisc) addOralDisc(cb, shape, recipe.oralDisc, ctx);
  if (recipe.jaw) addJaw(cb, shape, recipe.jaw, ctx, skeleton);
  if (recipe.mandibles) addMandibles(cb, shape, recipe.mandibles, ctx, skeleton);
  if (recipe.lure) addLure(cb, shape, recipe.lure, ctx, skeleton);
  if (recipe.eyes) addEyes(cb, shape, recipe.eyes, ctx);
  if (recipe.eyestalks) addEyestalks(cb, shape, recipe.eyestalks, ctx);
  if (recipe.antennae) {
    addWhiskers(cb, shape, recipe.antennae, L * 0.9, Math.max(0.002, L * 0.006), ctx, 'antenna');
  }
  if (recipe.barbels) {
    addWhiskers(cb, shape, recipe.barbels, L * 0.10, Math.max(0.0015, L * 0.004), ctx, 'barbel');
  }
  if (recipe.cephalicLobes) addLobes(cb, shape, recipe.cephalicLobes, ctx);

  // ---- fins --------------------------------------------------------------
  if (recipe.dorsalFin) addMedianFin(cb, shape, recipe.dorsalFin, true, ctx, 'fin');
  if (recipe.analFin) addMedianFin(cb, shape, recipe.analFin, false, ctx, 'fin');
  if (recipe.pectoral) addPairedFins(cb, shape, recipe.pectoral, ctx, 'fin');
  if (recipe.fins) addPairedFins(cb, shape, { ...recipe.fins, at: 0.14 }, ctx, 'fin', 0.0);
  if (recipe.caudal) addCaudal(cb, shape, recipe.caudal, ctx);
  if (recipe.fluke) addCaudal(cb, shape, recipe.fluke, ctx);
  if (recipe.wings) addWings(cb, shape, recipe.wings, ctx);
  if (recipe.crest) addBladeRow(cb, shape, recipe.crest, ctx, 'crest', false);
  if (recipe.ridge) addBladeRow(cb, shape, recipe.ridge, ctx, 'ridge', false);
  if (recipe.plume) {
    addBladeRow(cb, shape, { count: recipe.plume.blades, length: recipe.plume.length, chord: recipe.plume.chord },
      ctx, 'plume', true);
  }
  if (recipe.flaps) addFlaps(cb, shape, recipe.flaps, ctx);
  if (recipe.pleopods) addPaddles(cb, shape, recipe.pleopods, ctx, 'fin');
  if (recipe.uropods) addPaddles(cb, shape, recipe.uropods, ctx, 'fin');

  // ---- limbs and strands -------------------------------------------------
  if (recipe.legs) addLegs(cb, shape, recipe.legs, ctx);
  if (recipe.claws) addClaws(cb, shape, recipe.claws, ctx);
  if (recipe.arms) addStrands(cb, shape, recipe.arms, ctx, 'arm', 0.985, 1);
  if (recipe.clubs) addStrands(cb, shape, recipe.clubs, ctx, 'arm', 0.99, 1);
  if (recipe.tentacles) {
    const stem = recipe.stem;
    addStrands(cb, shape, recipe.tentacles, ctx, 'tentacle',
      recipe.bell || recipe.nectophores ? 0.999 : 0.985, 1,
      stem ? [stemStartZ, stemStartZ + stem.length * 0.92] : null);
  }
  if (recipe.oralArms) addStrands(cb, shape, recipe.oralArms, ctx, 'arm', 0.999, 1);
  if (recipe.filaments) addStrands(cb, shape, recipe.filaments, ctx, 'arm', 0.06, -1);
  if (recipe.streamers) addStrands(cb, shape, recipe.streamers, ctx, 'arm', 0.94, 1);
  if (recipe.tail) addTail(cb, shape, recipe.tail, ctx);

  // ---- armour and hardware ----------------------------------------------
  if (recipe.spines) addSpines(cb, shape, recipe.spines, ctx);
  if (recipe.lateralSpines) addLateralSpines(cb, shape, recipe.lateralSpines, ctx, Math.max(1, plates));
  if (recipe.organs) addOrgans(cb, shape, recipe.organs, ctx);

  // ---- finish ------------------------------------------------------------
  const emissive = applyBiolum(cb, species, seed | 0, bodyRings, segs);
  const inflateOut = applyInflate(cb, recipe, cb.vertexCount);
  const skin = bindSkin(cb, skeleton);
  cb.mb.computeTangents();
  const built = cb.mb.build();
  const vc = built.vertexCount;

  return {
    positions: built.positions,
    normals: built.normals,
    uvs: built.uvs,
    colors: built.colors,
    materials: built.materials,
    tangents: built.tangents,
    emissive: emissive.slice(0, vc * 3),
    inflate: inflateOut,
    boneIndices: skin.boneIndices.slice(0, vc * CREATURE_INFLUENCES),
    boneWeights: skin.boneWeights.slice(0, vc * CREATURE_INFLUENCES),
    indices: built.indices,
    bones: skeleton.bones,
    boneCount: skeleton.bones.length,
    spineCount: skeleton.spineCount,
    jawBone: skeleton.jaw,
    lureBone: skeleton.lure,
    aabb: built.aabb,
    boundingRadius: built.boundingRadius,
    vertexCount: vc,
    indexCount: built.indexCount,
    triangleCount: built.triangleCount,
    species: species.id,
    // creatureVertexBudget(), not tier.budget: the tier number is a FISH's
    // budget and the limbed plans carry a stated allowance on top of it, so
    // reporting the raw tier claimed a Glassclaw was 2,880 verts over a 1,200
    // budget it was never held to.
    budget: creatureVertexBudget(species),
    parts: cb.ranges.map((r) => ({ kind: r.kind, bone: r.bone, start: r.start, count: r.count })),
  };
}
