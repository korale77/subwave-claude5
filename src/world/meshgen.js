/**
 * SUBWAVE procedural meshes - every piece of geometry in the world except the
 * vessel (src/entities/vessel_mesh.js owns that one).
 *
 * Nothing here is loaded from a file. A rock is an icosphere pushed around by
 * three noise fields, a kelp stipe is a circle swept along a leaning helix, a
 * branching coral is a space-colonisation skeleton lofted into generalised
 * cylinders. The numbers come from DESIGN/02 section 10, and the shapes they
 * describe come from DESIGN/01 section 6.1.
 *
 * THREE CONTRACTS every generator here honours:
 *
 *   1. DETERMINISM. Output is a pure function of the arguments. Same seed ->
 *      byte-identical arrays, on every machine, forever. Scatter placement
 *      hashes a world cell to a seed and expects the mesh back without having
 *      to store it, so a generator that consulted Math.random or Date.now
 *      would desynchronise the world from itself.
 *
 *   2. SWAY WEIGHT. Every vertex carries an animation stiffness in
 *      `colors[i*4 + 3]`: 0 where the plant is anchored, 1 at the tip. The
 *      vertex shader bends the whole ocean's flora with that single channel
 *      (DESIGN/02 10.2). Swept forms ALSO write the same 0..1 parameter into
 *      `uvs[i*2 + 1]` so a shader can texture along the stalk. Rigid geometry
 *      (rock, crystal, bone, chimney) leaves sway at 0 and therefore never
 *      moves.
 *
 *   3. MATERIAL SLOT. `materials[i]` is one of MESH_MATERIAL, 0..7, which is
 *      exactly the 3-bit material field of the 20-byte packed scatter vertex.
 *      It is how a single draw can light a mushroom's stem with evalLighting
 *      and its gills with an emissive term, or a coral fan with
 *      evalTranslucency - without a second mesh, a second draw, or a texture.
 *
 * Output is STRUCTURE-OF-ARRAYS, not the vessel's interleaved buffer: the
 * scatter system packs these into its own 20-byte quantised format and the
 * imposter baker wants full-precision positions. Handing out separate arrays
 * lets both take what they need without unpacking a stride.
 *
 * Winding is counter-clockwise = front facing, matching every pipeline in the
 * renderer. Normals point OUT of solid geometry.
 */

import {
  vec3, mat3, clamp, saturate, lerp, smoothstep, TAU, PI,
  makeRng, hash2i, AABB, radicalInverse, EPSILON,
} from '../core/math.js';
import { simplex2, simplex3, worley3F1, smax } from './noise.js';

// ---------------------------------------------------------------------------
// Vertex semantics
// ---------------------------------------------------------------------------

/**
 * Per-vertex material slot. Three bits, so eight slots and no more; the packed
 * scatter vertex has no room for a ninth and adding one would cost 2 bytes on
 * every vertex of every instance in the world.
 */
export const MESH_MATERIAL = {
  /** Mineral. Dielectric, mid roughness, triplanar detail. */
  ROCK: 0,
  /** Opaque plant/animal tissue. Diffuse-dominant. */
  FLORA: 1,
  /** Thin tissue lit with brdf.wgsl evalTranslucency: fins, blades, fans. */
  TRANSLUCENT: 2,
  /** Bioluminescent. Emits; receives almost no direct light. */
  EMISSIVE: 3,
  /** Crystal. High specular, fake internal scattering. */
  CRYSTAL: 4,
  /** Weathered bone/carbonate. Bright, porous, slightly translucent at edges. */
  BONE: 5,
  /** Encrusting sediment, mats and crusts. Very rough, no specular to speak of. */
  SEDIMENT: 6,
  /** Metallic sulphide / ore. Conductor. */
  METAL: 7,
};

export const MESH_MATERIAL_NAMES = [
  'rock', 'flora', 'translucent', 'emissive', 'crystal', 'bone', 'sediment', 'metal',
];

/**
 * Resolution tier. HIGH is LOD0 (the vertex counts quoted in every JSDoc
 * below), MEDIUM is LOD1, LOW is LOD2. Beyond LOD2 the scatter system swaps to
 * an octahedral imposter and stops asking for geometry at all.
 */
export const MESH_DETAIL = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/** Pick one of three values by detail tier. */
const byDetail = (detail, low, medium, high) =>
  (detail <= MESH_DETAIL.LOW ? low : detail === MESH_DETAIL.MEDIUM ? medium : high);

/**
 * Asset ids, used only to salt the per-generator RNG. Matches DESIGN/02's
 * SALT_ASSET_BASE scheme: two generators handed the same seed must not produce
 * correlated shapes, which is what happens if they share an RNG stream.
 */
export const MESH_ASSET = {
  ROCK: 0, BOULDER: 1, PEBBLE: 2, CRYSTAL: 3,
  KELP: 4, SEAGRASS: 5, GIANT_KELP: 6,
  CORAL_BRAIN: 7, CORAL_BRANCH: 8, CORAL_FAN: 9, CORAL_TUBE: 10, SPONGE: 11,
  MUSHROOM: 12, GLOW_POD: 13, VENT_CHIMNEY: 14, BONE_RIB: 15, ORE_NODE: 16,
  SHORE_GRASS: 17, ALIEN_FROND: 18, STRATUM_SLAB: 19, WHALE_FALL: 20,
  GLASS_LATTICE: 21, SPONGE_SHELF: 22, SKULL: 23,
  BLOOD_GRASS: 24, MEADOW_PILLAR: 25, JELLYSHROOM: 26, BULB_TREE: 27,
  PLATTER_SPIRE: 28, RING_HALO: 29,
};

const SALT_ASSET_BASE = 0x00070000;

/** Deterministic per-asset RNG. */
const assetRng = (seed, asset) => makeRng(hash2i(seed | 0, SALT_ASSET_BASE + asset));
/** Deterministic per-asset noise seed, independent of the RNG stream. */
const assetNoiseSeed = (seed, asset) => hash2i(SALT_ASSET_BASE + asset, seed | 0) & 0x7fffffff;

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/** IEC 61966-2-1 sRGB -> linear, per channel. */
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** Build a linear-RGB + sway colour from an 8-bit sRGB triple. */
const rgb = (r, g, b) => Float32Array.of(srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255), 0);

/**
 * Vertex-colour palette, LINEAR RGB, transcribed from the flora registry and
 * the biome colour table in DESIGN/01. These are base tints only: the scatter
 * instance record multiplies a per-instance tint on top, so two rocks from the
 * same mesh never read as clones.
 */
export const MESH_PALETTE = {
  BASALT: rgb(88, 84, 80),
  BASALT_DARK: rgb(34, 30, 30),
  PALE_ROCK: rgb(176, 170, 156),
  CARBONATE: rgb(232, 224, 196),
  CORAL_ORANGE: rgb(226, 128, 92),
  CORAL_PINK: rgb(224, 148, 158),
  CORAL_CREAM: rgb(236, 222, 196),
  CORAL_VIOLET: rgb(168, 150, 196),
  KELP_BROWN: rgb(78, 84, 66),
  /** The fruiting body at a kelp champion's crown. Warm gold, and it is the ONLY
   *  warm thing in COASTAL_GREEN - which is the whole reason it reads. */
  // A warmer orange-gold source survives the green water without turning the
  // larger fruit clusters into pale white discs after the display grade.
  // Gold, not orange, since the 2026-08-18 emerald rebuild's round 3: the
  // playtest asked for "nice glowing yellow/gold", and in the green-keyed
  // KELP_EMERALD water an orange pigment lost its red on the sight path and
  // delivered GREENISH - a G-heavy gold survives that water as gold.
  KELP_FRUIT: rgb(255, 208, 66),
  KELP_DARK: rgb(52, 48, 44),
  KELP_BLADE: rgb(92, 116, 64),
  SEAGRASS: rgb(96, 132, 84),
  SPONGE_PALE: rgb(190, 206, 220),
  SPONGE_URN: rgb(176, 146, 120),
  FUNGUS_STALK: rgb(210, 214, 196),
  FUNGUS_GLOW: rgb(90, 255, 190),
  GLOWCUP: rgb(255, 150, 60),
  TUBEROD: rgb(255, 60, 30),
  CRYSTAL_CLEAR: rgb(200, 214, 224),
  AMETHYST: rgb(168, 150, 196),
  BONE: rgb(226, 218, 198),
  VENT_CRUST: rgb(44, 34, 30),
  VENT_HOT: rgb(178, 96, 42),
  FROND_OLIVE: rgb(122, 124, 88),
  SHORE_GRASS: rgb(108, 128, 96),
  GLOW_POD: rgb(120, 220, 255),
  /** The Crimson Meadow carpet. Saturation comes from CUTTING green and blue
   *  reflectance, never from emission - a brighter object is a whiter one past
   *  the AgX shoulder, so this stays a reflectance colour. */
  // sRGB 120, not the first pass's 185: at the meadow's 14-20 m the scene
  // meters near exposure 1 and a 0.49-linear red clips and whitens to rose.
  // The reference's blood red is a LOW-VALUE red; darkness is the saturation.
  // And the authored hue must be a WARM red (G ~0.29 of R, B near zero):
  // the delivered pixel adds untinted blue from specular and the veil, and a
  // pure authored red therefore DELIVERS magenta - measured 38 degrees off
  // the reference with authored G at 0.07R, and the authored green is the
  // only channel that can pull the sum back onto true red.
  BLOOD_GRASS: rgb(140, 40, 8),
  /** Warm tan pillar rock for the meadow's mushroom stacks. Darker and warmer
   *  than the first pass's 172/160/140, which delivered blue-white under the
   *  water column - the warmth has to be authored strong because the medium
   *  halves it before the eye. */
  MEADOW_ROCK: rgb(150, 124, 88),
  /** Magenta accent tuft, same vibrancy rule as BLOOD_GRASS. */
  MEADOW_PLUME: rgb(168, 40, 150),
  /**
   * The Jellyshroom Hollow family (world/cave_sites.js). These are EMISSION
   * colours, not reflectances - the cave props' fragment path multiplies them
   * by an emissive gate, so the brighter-is-whiter AgX trap applies to the
   * pass's gain constant, not to the hue authored here. The cap gradient runs
   * UNDER (underside) -> CAP (rim) -> CAP_CORE (apex), matching the
   * reference's bright-cored translucent dome.
   */
  // Review round 2 (delivered-frame findings): the core was clipping white
  // through the AgX shoulder - CORE is now bounded pale PINK, never white;
  // the underside dropped to a deep saturated magenta so the three-zone
  // gradient (under -> rim -> core) reads from below as well as above.
  JELLY_CAP: rgb(255, 92, 214),
  JELLY_CAP_CORE: rgb(255, 170, 228),
  JELLY_UNDER: rgb(190, 30, 150),
  /** Dark slate-blue stalk: the caps read because the stalks do not glow. */
  JELLY_STALK: rgb(58, 60, 86),
  /** The tiered frill shelves at a stalk's base, and their glow specks. */
  JELLY_FRILL: rgb(64, 72, 104),
  JELLY_FRILL_DOT: rgb(255, 210, 240),
  /** Speleothem crystal body and its emissive veins. Review round 2: pulled
   *  off indigo toward the wall violet - the crystals were the one hue
   *  family in the chamber still reading BLUE. */
  JELLY_CRYSTAL: rgb(152, 68, 178),
  JELLY_GLOW: rgb(238, 142, 246),
  /**
   * The Bulb Grove family, from its art-direction reference: big spiky
   * purple pom bulbs on pale trunks, studded with small glowing blue fruits.
   * The purple is a REFLECTANCE, and it is authored MAGENTA-HEAVY - well
   * PAST the target hue - because LAGOON_VIOLET's light still delivers
   * blue at ~3x red at the grove's depths, and it is the product that has
   * to land on violet: a blue-dominant authored purple (first pass,
   * rgb(120, 62, 205)) delivered periwinkle. Same lesson as BLOOD_GRASS
   * authoring warm red against a blue-amplifying column, one hue over.
   */
  // Rotated off the first magenta draft rgb(196, 56, 178): adversarial
  // review measured the delivered fur as cotton-candy pink; the reference is
  // 270-280 deg violet, so B goes back above R and the violet-supporting
  // light (LAGOON_VIOLET keeps red at 2.4x REEF) carries the rest.
  BULB_PURPLE: rgb(128, 38, 192),
  /** Bulb core and spike roots: the dark ground the pale tips read against. */
  BULB_PURPLE_DEEP: rgb(92, 22, 88),
  /** Spike tips: pale lavender, the fur highlight of the reference. */
  BULB_TIP: rgb(168, 112, 236),
  /** Pale silver trunks, like the reference's birch-smooth stems. */
  BULB_TRUNK: rgb(205, 200, 212),
  /** Ice-blue fruit body; the glow colour is the scatter row's emissiveColor.
   *  Deepened from rgb(148, 216, 255): review read the berries as white
   *  foam - the saturation must survive the emission on top of it. */
  BULB_FRUIT: rgb(70, 180, 255),
  /** The teal ground-pom variant (the small green-blue mounds on the sand). */
  POM_TEAL: rgb(52, 168, 148),
  POM_TEAL_TIP: rgb(150, 232, 205),
  /**
   * The Platter Forest family, from its art-direction reference: tall
   * encrusted rock columns carrying stacked horizontal platters, orange
   * growth climbing the trunks, glowing rims, pink ring-corals. The trunks
   * and platter tops are REFLECTANCE under PLATTER_TEAL's emerald key (green
   * daylight ~7x blue at the 97 m anchor, so olive/sage albedos deliver the
   * reference's sea-green); the warm accents are EMISSIVE - the water spends
   * its whole art deviation on green and keeps almost no red, so orange can
   * only be self-lit, which is also how the reference's rims read.
   */
  /** Encrusted column stone: dark grey-green, the tone between the orange
   *  patches. Darkened from rgb(66,76,68) on the first delivered frames -
   *  under the emerald key at 5-6x exposure a mid-grey delivered pale mint,
   *  and the reference trunks are near-silhouette. */
  PLATTER_ROCK: rgb(32, 34, 30),
  /** The rust-orange encrusting growth on the trunks. An albedo, not a glow:
   *  it needs the water's kept red (PLATTER_TEAL red Kd 0.0280, cut from
   *  0.0560 in the same round) to deliver as umber rather than grey. */
  PLATTER_RUST: rgb(140, 66, 26),
  /** Platter top mats: dark moss-teal turf. Darkened from rgb(92,126,98) -
   *  the first frames delivered cream tabletops; the reference pads are
   *  darker than the water behind them. */
  PLATTER_TOP: rgb(38, 70, 44),
  /** Platter underside/rim tissue, under the EMISSIVE slot: the row's orange
   *  emission carries the glow, this albedo keeps the lit tissue warm. */
  PLATTER_RIM: rgb(200, 92, 30),
  /** Ring-coral tissue: deepened from rgb(240,152,190) - the pale draft plus
   *  emission 3.0 clipped to white; saturation must survive the glow. */
  HALO_PINK: rgb(232, 120, 170),
  /** The olive-brown floor tufts between the columns. Darkened and browned
   *  from rgb(104,84,38): the green column re-greens any olive, so the
   *  authored colour leans further brown than the reference reads. */
  RUST_TUFT: rgb(96, 48, 14),
  RUST_TUFT_TIP: rgb(150, 128, 62),
};

const WHITE = Float32Array.of(1, 1, 1, 0);

// ---------------------------------------------------------------------------
// Module scratch. These generators run at load time in a worker, single
// threaded, so module-level scratch is safe and keeps the inner loops
// allocation free.
// ---------------------------------------------------------------------------

const _p = vec3.create();
const _n = vec3.create();
const _u = vec3.create();
const _v = vec3.create();
const _d = vec3.create();
const _t0 = vec3.create();
const _t1 = vec3.create();
const _e0 = vec3.create();
const _e1 = vec3.create();
const _uv = Float32Array.of(0, 0);
const _col = Float32Array.of(1, 1, 1, 0);
const _nmat = mat3.create();

// ===========================================================================
// MeshBuilder
// ===========================================================================

/**
 * Growable structure-of-arrays mesh accumulator.
 *
 * Arrays double when they fill, so a generator that guesses its size badly
 * costs a few copies rather than a fixed worst-case allocation. The internal
 * field names match build()'s output on purpose: merge() accepts either a
 * MeshBuilder or an already-built mesh with no adapter.
 */
export class MeshBuilder {
  /**
   * @param {number} [vertexGuess] initial vertex capacity
   * @param {number} [indexGuess] initial index capacity
   */
  constructor(vertexGuess = 256, indexGuess = 768) {
    const vc = Math.max(4, vertexGuess | 0);
    const ic = Math.max(6, indexGuess | 0);
    this.positions = new Float32Array(vc * 3);
    this.normals = new Float32Array(vc * 3);
    this.uvs = new Float32Array(vc * 2);
    this.colors = new Float32Array(vc * 4);
    this.materials = new Uint8Array(vc);
    this.indices = new Uint32Array(ic);
    this.tangents = null;
    this.vertexCount = 0;
    this.indexCount = 0;
    /** Material slot stamped onto every vertex addVertex() creates. */
    this.material = MESH_MATERIAL.ROCK;
  }

  /** Vertex capacity in vertices. */
  get vertexCapacity() { return this.materials.length; }

  _reserveVertices(extra) {
    const need = this.vertexCount + extra;
    let cap = this.materials.length;
    if (need <= cap) return;
    while (cap < need) cap *= 2;
    const p = new Float32Array(cap * 3); p.set(this.positions); this.positions = p;
    const n = new Float32Array(cap * 3); n.set(this.normals); this.normals = n;
    const u = new Float32Array(cap * 2); u.set(this.uvs); this.uvs = u;
    const c = new Float32Array(cap * 4); c.set(this.colors); this.colors = c;
    const m = new Uint8Array(cap); m.set(this.materials); this.materials = m;
    if (this.tangents) { const t = new Float32Array(cap * 4); t.set(this.tangents); this.tangents = t; }
  }

  _reserveIndices(extra) {
    const need = this.indexCount + extra;
    let cap = this.indices.length;
    if (need <= cap) return;
    while (cap < need) cap *= 2;
    const a = new Uint32Array(cap); a.set(this.indices); this.indices = a;
  }

  /**
   * Append one vertex.
   *
   * @param {ArrayLike<number>} pos xyz
   * @param {ArrayLike<number>} normal xyz, expected unit length
   * @param {ArrayLike<number>} [uv] uv; swept forms put the 0..1 stalk
   *   parameter in v
   * @param {ArrayLike<number>} [color] linear rgb + sway weight in w
   * @returns {number} the new vertex index
   */
  addVertex(pos, normal, uv, color) {
    this._reserveVertices(1);
    const i = this.vertexCount++;
    const p3 = i * 3;
    this.positions[p3] = pos[0]; this.positions[p3 + 1] = pos[1]; this.positions[p3 + 2] = pos[2];
    this.normals[p3] = normal[0]; this.normals[p3 + 1] = normal[1]; this.normals[p3 + 2] = normal[2];
    const p2 = i * 2;
    if (uv) { this.uvs[p2] = uv[0]; this.uvs[p2 + 1] = uv[1]; }
    const p4 = i * 4;
    if (color) {
      this.colors[p4] = color[0]; this.colors[p4 + 1] = color[1];
      this.colors[p4 + 2] = color[2]; this.colors[p4 + 3] = color.length > 3 ? color[3] : 0;
    } else {
      this.colors[p4] = 1; this.colors[p4 + 1] = 1; this.colors[p4 + 2] = 1; this.colors[p4 + 3] = 0;
    }
    this.materials[i] = this.material;
    return i;
  }

  /** Counter-clockwise triangle. */
  addTriangle(a, b, c) {
    this._reserveIndices(3);
    this.indices[this.indexCount++] = a;
    this.indices[this.indexCount++] = b;
    this.indices[this.indexCount++] = c;
  }

  /** Counter-clockwise quad, split a-b-c / a-c-d. */
  addQuad(a, b, c, d) {
    this.addTriangle(a, b, c);
    this.addTriangle(a, c, d);
  }

  /** Overwrite the sway weight (colour w) of a vertex range. */
  setSwayRange(start, count, value) {
    for (let i = start; i < start + count; i++) this.colors[i * 4 + 3] = value;
  }

  /**
   * Append another mesh, optionally transformed.
   *
   * Normals go through the inverse-transpose so non-uniform scale does not
   * shear them off the surface, and a mirroring transform (negative
   * determinant) reverses the winding of the copied triangles - without that,
   * every mirrored part renders inside-out.
   *
   * @param {MeshBuilder|object} other a MeshBuilder or a build() result
   * @param {Float32Array} [transform] column-major mat4
   */
  merge(other, transform) {
    const vc = other.vertexCount;
    const ic = other.indexCount;
    const base = this.vertexCount;
    this._reserveVertices(vc);
    this._reserveIndices(ic);

    let mirrored = false;
    if (transform) {
      mat3.normalFromMat4(_nmat, transform);
      // det of the upper-left 3x3.
      const m = transform;
      const det = m[0] * (m[5] * m[10] - m[6] * m[9])
                - m[4] * (m[1] * m[10] - m[2] * m[9])
                + m[8] * (m[1] * m[6] - m[2] * m[5]);
      mirrored = det < 0;
    }

    const op = other.positions, on = other.normals;
    for (let i = 0; i < vc; i++) {
      const s = i * 3;
      if (transform) {
        vec3.set(_p, op[s], op[s + 1], op[s + 2]);
        vec3.transformMat4(_p, _p, transform);
        vec3.set(_n, on[s], on[s + 1], on[s + 2]);
        vec3.transformMat3(_n, _n, _nmat);
        vec3.normalize(_n, _n);
      } else {
        vec3.set(_p, op[s], op[s + 1], op[s + 2]);
        vec3.set(_n, on[s], on[s + 1], on[s + 2]);
      }
      const d3 = (base + i) * 3;
      this.positions[d3] = _p[0]; this.positions[d3 + 1] = _p[1]; this.positions[d3 + 2] = _p[2];
      this.normals[d3] = _n[0]; this.normals[d3 + 1] = _n[1]; this.normals[d3 + 2] = _n[2];
      const d2 = (base + i) * 2, s2 = i * 2;
      this.uvs[d2] = other.uvs[s2]; this.uvs[d2 + 1] = other.uvs[s2 + 1];
      const d4 = (base + i) * 4, s4 = i * 4;
      this.colors[d4] = other.colors[s4]; this.colors[d4 + 1] = other.colors[s4 + 1];
      this.colors[d4 + 2] = other.colors[s4 + 2]; this.colors[d4 + 3] = other.colors[s4 + 3];
      this.materials[base + i] = other.materials[i];
    }
    this.vertexCount += vc;

    const oi = other.indices;
    if (mirrored) {
      for (let k = 0; k + 2 < ic; k += 3) {
        this.indices[this.indexCount++] = oi[k] + base;
        this.indices[this.indexCount++] = oi[k + 2] + base;
        this.indices[this.indexCount++] = oi[k + 1] + base;
      }
    } else {
      for (let k = 0; k < ic; k++) this.indices[this.indexCount++] = oi[k] + base;
    }
    return this;
  }

  /**
   * Transform this mesh in place. Same normal and winding handling as merge().
   * @param {Float32Array} m column-major mat4
   */
  transform(m) {
    mat3.normalFromMat4(_nmat, m);
    const det = m[0] * (m[5] * m[10] - m[6] * m[9])
              - m[4] * (m[1] * m[10] - m[2] * m[9])
              + m[8] * (m[1] * m[6] - m[2] * m[5]);
    for (let i = 0; i < this.vertexCount; i++) {
      const s = i * 3;
      vec3.set(_p, this.positions[s], this.positions[s + 1], this.positions[s + 2]);
      vec3.transformMat4(_p, _p, m);
      this.positions[s] = _p[0]; this.positions[s + 1] = _p[1]; this.positions[s + 2] = _p[2];
      vec3.set(_n, this.normals[s], this.normals[s + 1], this.normals[s + 2]);
      vec3.transformMat3(_n, _n, _nmat);
      vec3.normalize(_n, _n);
      this.normals[s] = _n[0]; this.normals[s + 1] = _n[1]; this.normals[s + 2] = _n[2];
    }
    if (det < 0) {
      for (let k = 0; k + 2 < this.indexCount; k += 3) {
        const t = this.indices[k + 1];
        this.indices[k + 1] = this.indices[k + 2];
        this.indices[k + 2] = t;
      }
    }
    return this;
  }

  /**
   * Recompute normals by area-weighted face-normal accumulation.
   *
   * Area weighting (rather than normalising each face first) is what keeps a
   * heavily displaced icosphere from developing shading spikes wherever one
   * sliver triangle out-votes its large neighbours.
   *
   * @param {number} [vertexStart] first vertex to rewrite
   * @param {number} [indexStart] first index to accumulate from; lets a
   *   generator recompute one appended part without touching parts that
   *   already carry analytic normals
   */
  computeNormals(vertexStart = 0, indexStart = 0) {
    const P = this.positions, N = this.normals;
    for (let i = vertexStart; i < this.vertexCount; i++) {
      N[i * 3] = 0; N[i * 3 + 1] = 0; N[i * 3 + 2] = 0;
    }
    for (let k = indexStart; k + 2 < this.indexCount; k += 3) {
      const a = this.indices[k] * 3, b = this.indices[k + 1] * 3, c = this.indices[k + 2] * 3;
      const e0x = P[b] - P[a], e0y = P[b + 1] - P[a + 1], e0z = P[b + 2] - P[a + 2];
      const e1x = P[c] - P[a], e1y = P[c + 1] - P[a + 1], e1z = P[c + 2] - P[a + 2];
      // Unnormalised cross product: its length is twice the triangle area, so
      // accumulating it raw IS the area weighting.
      const nx = e0y * e1z - e0z * e1y;
      const ny = e0z * e1x - e0x * e1z;
      const nz = e0x * e1y - e0y * e1x;
      N[a] += nx; N[a + 1] += ny; N[a + 2] += nz;
      N[b] += nx; N[b + 1] += ny; N[b + 2] += nz;
      N[c] += nx; N[c + 1] += ny; N[c + 2] += nz;
    }
    for (let i = vertexStart; i < this.vertexCount; i++) {
      const o = i * 3;
      const l = Math.hypot(N[o], N[o + 1], N[o + 2]);
      if (l > 1e-12) { N[o] /= l; N[o + 1] /= l; N[o + 2] /= l; }
      else {
        // Fully degenerate neighbourhood: fall back to the radial direction,
        // which is right for every closed shape here and harmless otherwise.
        const px = P[o], py = P[o + 1], pz = P[o + 2];
        const pl = Math.hypot(px, py, pz);
        if (pl > 1e-9) { N[o] = px / pl; N[o + 1] = py / pl; N[o + 2] = pz / pl; }
        else { N[o] = 0; N[o + 1] = 1; N[o + 2] = 0; }
      }
    }
    return this;
  }

  /**
   * Crease-preserving normals: smooth across COINCIDENT vertices whose faces
   * agree to within `angleThreshold`, keep the crease where they do not.
   *
   * This deliberately does NOT split vertices. Every generator in this file
   * already duplicates vertices at each intended hard edge (that is how a
   * lathe seam or a crystal facet stays sharp), so splitting could only ever
   * duplicate work that construction already did. What is missing is the
   * opposite operation: welding the SEAMS that duplication left behind, e.g.
   * the u = 0 / u = 1 column of a lathe, which otherwise shades as a visible
   * stripe down the side of every sponge.
   *
   * @param {number} [angleThreshold] radians; faces further apart than this
   *   stay separate
   */
  computeSmoothNormals(angleThreshold = 1.05) {
    const vc = this.vertexCount;
    if (vc === 0) return this;
    this.computeNormals();
    const P = this.positions, N = this.normals;
    const cosLimit = Math.cos(clamp(angleThreshold, 0, PI));

    // Weld by quantised position. 1e-4 m is far below any feature these meshes
    // have and far above float32 round-off on a 30 m bone.
    const groups = new Map();
    const groupOf = new Int32Array(vc);
    const scale = 10000;
    for (let i = 0; i < vc; i++) {
      const o = i * 3;
      const key = `${Math.round(P[o] * scale)},${Math.round(P[o + 1] * scale)},${Math.round(P[o + 2] * scale)}`;
      let g = groups.get(key);
      if (g === undefined) { g = groups.size; groups.set(key, g); }
      groupOf[i] = g;
    }
    const groupCount = groups.size;
    if (groupCount === vc) return this;   // nothing coincident: already done

    // Bucket vertices by group (counting sort, so the order is deterministic).
    const start = new Int32Array(groupCount + 1);
    for (let i = 0; i < vc; i++) start[groupOf[i] + 1]++;
    for (let g = 0; g < groupCount; g++) start[g + 1] += start[g];
    const members = new Int32Array(vc);
    const cursor = start.slice(0, groupCount);
    for (let i = 0; i < vc; i++) members[cursor[groupOf[i]]++] = i;

    const out = new Float32Array(vc * 3);
    for (let g = 0; g < groupCount; g++) {
      const lo = start[g], hi = start[g + 1];
      if (hi - lo === 1) {
        const i = members[lo] * 3;
        out[i] = N[i]; out[i + 1] = N[i + 1]; out[i + 2] = N[i + 2];
        continue;
      }
      for (let a = lo; a < hi; a++) {
        const ia = members[a], oa = ia * 3;
        let sx = 0, sy = 0, sz = 0;
        for (let b = lo; b < hi; b++) {
          const ob = members[b] * 3;
          const dot = N[oa] * N[ob] + N[oa + 1] * N[ob + 1] + N[oa + 2] * N[ob + 2];
          if (dot >= cosLimit) { sx += N[ob]; sy += N[ob + 1]; sz += N[ob + 2]; }
        }
        const l = Math.hypot(sx, sy, sz);
        if (l > 1e-12) { out[oa] = sx / l; out[oa + 1] = sy / l; out[oa + 2] = sz / l; }
        else { out[oa] = N[oa]; out[oa + 1] = N[oa + 1]; out[oa + 2] = N[oa + 2]; }
      }
    }
    N.set(out.subarray(0, vc * 3));
    return this;
  }

  /**
   * Per-vertex tangent frame from the UV parameterisation, Gram-Schmidt
   * orthogonalised against the normal, with the bitangent handedness in w.
   *
   * Where the UV mapping is degenerate (a collapsed pole ring, a zero-area UV
   * triangle) there is no defined tangent, so an arbitrary perpendicular is
   * used - correct for isotropic materials and stable frame to frame, which is
   * what actually matters for TAA.
   */
  computeTangents() {
    const vc = this.vertexCount;
    this.tangents = new Float32Array(this.materials.length * 4);
    const tan = new Float32Array(vc * 3);
    const bit = new Float32Array(vc * 3);
    const P = this.positions, UV = this.uvs, N = this.normals;

    for (let k = 0; k + 2 < this.indexCount; k += 3) {
      const i0 = this.indices[k], i1 = this.indices[k + 1], i2 = this.indices[k + 2];
      const a = i0 * 3, b = i1 * 3, c = i2 * 3;
      const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
      const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
      const au = i0 * 2, bu = i1 * 2, cu = i2 * 2;
      const du1 = UV[bu] - UV[au], dv1 = UV[bu + 1] - UV[au + 1];
      const du2 = UV[cu] - UV[au], dv2 = UV[cu + 1] - UV[au + 1];
      const det = du1 * dv2 - du2 * dv1;
      if (Math.abs(det) < 1e-12) continue;
      const r = 1 / det;
      const tx = (e1x * dv2 - e2x * dv1) * r;
      const ty = (e1y * dv2 - e2y * dv1) * r;
      const tz = (e1z * dv2 - e2z * dv1) * r;
      const bx = (e2x * du1 - e1x * du2) * r;
      const by = (e2y * du1 - e1y * du2) * r;
      const bz = (e2z * du1 - e1z * du2) * r;
      for (const i of [a, b, c]) {
        tan[i] += tx; tan[i + 1] += ty; tan[i + 2] += tz;
        bit[i] += bx; bit[i + 1] += by; bit[i + 2] += bz;
      }
    }

    for (let i = 0; i < vc; i++) {
      const o = i * 3, o4 = i * 4;
      vec3.set(_n, N[o], N[o + 1], N[o + 2]);
      vec3.set(_t0, tan[o], tan[o + 1], tan[o + 2]);
      // Gram-Schmidt: remove the normal component.
      const d = vec3.dot(_t0, _n);
      _t0[0] -= _n[0] * d; _t0[1] -= _n[1] * d; _t0[2] -= _n[2] * d;
      if (vec3.sqrLen(_t0) < 1e-16) vec3.anyPerpendicular(_t0, _n);
      else vec3.normalize(_t0, _t0);
      vec3.cross(_t1, _n, _t0);
      const sign = (_t1[0] * bit[o] + _t1[1] * bit[o + 1] + _t1[2] * bit[o + 2]) < 0 ? -1 : 1;
      this.tangents[o4] = _t0[0];
      this.tangents[o4 + 1] = _t0[1];
      this.tangents[o4 + 2] = _t0[2];
      this.tangents[o4 + 3] = sign;
    }
    return this;
  }

  /**
   * Axis-aligned bounds of the current vertices.
   * @returns {AABB} empty (min > max) when there are no vertices
   */
  bounds() {
    const box = new AABB();
    for (let i = 0; i < this.vertexCount; i++) {
      const o = i * 3;
      box.expandPoint(this.positions[o], this.positions[o + 1], this.positions[o + 2]);
    }
    return box;
  }

  /**
   * Snapshot into compact arrays.
   *
   * `boundingRadius` is measured from the LOCAL ORIGIN, not from the AABB
   * centre, because scatter instances are placed and rotated about the origin:
   * a radius about the centroid under-bounds a rotated kelp stipe by most of
   * its height.
   *
   * @returns {{positions: Float32Array, normals: Float32Array, uvs:
   *   Float32Array, colors: Float32Array, materials: Uint8Array, tangents:
   *   (Float32Array|null), indices: Uint32Array, aabb: AABB, boundingRadius:
   *   number, vertexCount: number, indexCount: number, triangleCount: number}}
   */
  build() {
    const vc = this.vertexCount, ic = this.indexCount;
    const aabb = this.bounds();
    let r2 = 0;
    for (let i = 0; i < vc; i++) {
      const o = i * 3;
      const d = this.positions[o] * this.positions[o]
              + this.positions[o + 1] * this.positions[o + 1]
              + this.positions[o + 2] * this.positions[o + 2];
      if (d > r2) r2 = d;
    }
    return {
      positions: this.positions.slice(0, vc * 3),
      normals: this.normals.slice(0, vc * 3),
      uvs: this.uvs.slice(0, vc * 2),
      colors: this.colors.slice(0, vc * 4),
      materials: this.materials.slice(0, vc),
      tangents: this.tangents ? this.tangents.slice(0, vc * 4) : null,
      indices: this.indices.slice(0, ic),
      aabb,
      boundingRadius: Math.sqrt(r2),
      vertexCount: vc,
      indexCount: ic,
      triangleCount: (ic / 3) | 0,
    };
  }
}

/** Finish a mesh: tangents from the UVs, then snapshot. */
function finish(mb) {
  mb.computeTangents();
  return mb.build();
}

// ===========================================================================
// Shared construction helpers
// ===========================================================================

/**
 * Connect two consecutive rings into a band.
 *
 * `stride` is how many vertices each ring actually stores: `segments` for a
 * wrapped ring (seam vertices shared, cheapest) or `segments + 1` for a
 * duplicated seam (needed whenever u must run 0..1 without a wrap artifact).
 *
 * `flip` selects the winding, and which one is correct depends on the
 * handedness of the ring parameterisation against the sweep direction. The
 * outward normal is (along-sweep) x (around-ring) for a lathe ring - theta
 * running from +X toward +Z about a +Y axis, which is LEFT handed against that
 * axis - and (around-ring) x (along-sweep) for a tube ring built on the right
 * handed frame (u, v = cross(dir, u), dir). Getting it backwards turns the
 * whole part inside out, so it is one flag in one place instead of a winding
 * decision repeated at every call site.
 *
 * `aPoint`/`bPoint` mark a ring collapsed to a single position (a pole, an
 * apex, a lathe profile touching r = 0). The quad there has two coincident
 * corners, so only the surviving triangle is emitted - that is where degenerate
 * triangles come from otherwise.
 */
function bridgeRings(mb, aBase, bBase, segments, stride, flip, aPoint = false, bPoint = false) {
  if (aPoint && bPoint) return;
  for (let k = 0; k < segments; k++) {
    const k1 = (k + 1) % stride;
    const a0 = aBase + k, a1 = aBase + k1;
    const b0 = bBase + k, b1 = bBase + k1;
    if (aPoint) {
      if (flip) mb.addTriangle(a0, b0, b1); else mb.addTriangle(a0, b1, b0);
    } else if (bPoint) {
      if (flip) mb.addTriangle(a0, b0, a1); else mb.addTriangle(a0, a1, b0);
    } else if (flip) {
      mb.addQuad(a0, b0, b1, a1);
    } else {
      mb.addQuad(a0, a1, b1, b0);
    }
  }
}

/**
 * Catmull-Rom through a flat control array, duplicating the end points so the
 * curve passes through the first and last control point instead of stopping
 * one segment short.
 *
 * @param {ArrayLike<number>} ctrl flat [c0a, c0b, c1a, c1b, ...]
 * @param {number} t 0..1 along the whole curve
 * @param {Float32Array} out receives the 2 interpolated components
 */
function catmullRom2(ctrl, t, out) {
  const n = ctrl.length / 2;
  if (n === 1) { out[0] = ctrl[0]; out[1] = ctrl[1]; return out; }
  const s = saturate(t) * (n - 1);
  let i = Math.min(n - 2, Math.floor(s));
  const f = s - i;
  const i0 = Math.max(0, i - 1), i1 = i, i2 = i + 1, i3 = Math.min(n - 1, i + 2);
  const f2 = f * f, f3 = f2 * f;
  const w0 = -0.5 * f3 + f2 - 0.5 * f;
  const w1 = 1.5 * f3 - 2.5 * f2 + 1;
  const w2 = -1.5 * f3 + 2 * f2 + 0.5 * f;
  const w3 = 0.5 * f3 - 0.5 * f2;
  out[0] = w0 * ctrl[i0 * 2] + w1 * ctrl[i1 * 2] + w2 * ctrl[i2 * 2] + w3 * ctrl[i3 * 2];
  out[1] = w0 * ctrl[i0 * 2 + 1] + w1 * ctrl[i1 * 2 + 1] + w2 * ctrl[i2 * 2 + 1] + w3 * ctrl[i3 * 2 + 1];
  return out;
}

/**
 * Rotation-minimising frames along a polyline, by parallel transport.
 *
 * A naive "up cross tangent" frame flips whenever the tangent passes near up,
 * which puts a visible 180-degree twist in the middle of a leaning kelp stipe.
 * Transporting the previous frame's reference vector through the smallest
 * rotation that maps the previous tangent onto the current one has no such
 * singularity.
 *
 * @param {ArrayLike<number>} path flat xyz polyline, at least 2 points
 * @param {ArrayLike<number>} [upHint] when given, the reference axis is
 *   re-derived from it at every station instead of transported: use this when
 *   a part must stay in a fixed plane (a coral fan) rather than follow the
 *   curve's own torsion
 * @returns {{tangents: Float32Array, refs: Float32Array, count: number,
 *   arc: Float32Array, length: number}}
 */
function splineFrames(path, upHint) {
  const count = (path.length / 3) | 0;
  const tangents = new Float32Array(count * 3);
  const refs = new Float32Array(count * 3);
  const arc = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(count - 1, i + 1);
    vec3.set(_d,
      path[i1 * 3] - path[i0 * 3],
      path[i1 * 3 + 1] - path[i0 * 3 + 1],
      path[i1 * 3 + 2] - path[i0 * 3 + 2]);
    if (vec3.sqrLen(_d) < 1e-20) vec3.set(_d, 0, 1, 0);
    vec3.normalize(_d, _d);
    tangents[i * 3] = _d[0]; tangents[i * 3 + 1] = _d[1]; tangents[i * 3 + 2] = _d[2];
    if (i > 0) {
      const px = path[i * 3] - path[(i - 1) * 3];
      const py = path[i * 3 + 1] - path[(i - 1) * 3 + 1];
      const pz = path[i * 3 + 2] - path[(i - 1) * 3 + 2];
      arc[i] = arc[i - 1] + Math.hypot(px, py, pz);
    }
  }

  for (let i = 0; i < count; i++) {
    vec3.set(_d, tangents[i * 3], tangents[i * 3 + 1], tangents[i * 3 + 2]);
    if (upHint) {
      vec3.cross(_u, upHint, _d);
      if (vec3.sqrLen(_u) < 1e-12) vec3.anyPerpendicular(_u, _d);
      vec3.normalize(_u, _u);
    } else if (i === 0) {
      vec3.anyPerpendicular(_u, _d);
    } else {
      vec3.set(_u, refs[(i - 1) * 3], refs[(i - 1) * 3 + 1], refs[(i - 1) * 3 + 2]);
      // Project the previous reference onto the plane perpendicular to the new
      // tangent. That IS the parallel transport for an infinitesimal step and
      // it needs no quaternion.
      const d = vec3.dot(_u, _d);
      _u[0] -= _d[0] * d; _u[1] -= _d[1] * d; _u[2] -= _d[2] * d;
      if (vec3.sqrLen(_u) < 1e-12) vec3.anyPerpendicular(_u, _d);
      else vec3.normalize(_u, _u);
    }
    refs[i * 3] = _u[0]; refs[i * 3 + 1] = _u[1]; refs[i * 3 + 2] = _u[2];
  }

  return { tangents, refs, count, arc, length: arc[count - 1] };
}

/** Unit circle cross-section of `n` points, as flat [u, v] pairs. */
function circleSection(n) {
  const s = new Float32Array(n * 2);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * TAU;
    s[k * 2] = Math.cos(a);
    s[k * 2 + 1] = Math.sin(a);
  }
  return s;
}

/**
 * Thin lens cross-section: full width in u, `thickness` of that in v, with the
 * thick point on the centreline so the ribbon reads as a veined blade from
 * either side rather than as a piece of paper.
 */
function lensSection(thickness) {
  return Float32Array.of(1, 0, 0, thickness, -1, 0, 0, -thickness);
}

const SECTION_CIRCLE = [null, null, null,
  circleSection(3), circleSection(4), circleSection(5), circleSection(6),
  circleSection(7), circleSection(8)];

/** Cached unit circle section, or a fresh one for unusual segment counts. */
const unitCircle = (n) => (SECTION_CIRCLE[n] || circleSection(n));

// ===========================================================================
// Primitives
//
// Every primitive is an exact function of its arguments: no RNG at all, which
// is a stronger determinism guarantee than seeding one. They all return the
// same build() struct, and all accept the same trailing options:
//   { color, material, uScale, vScale }
// ===========================================================================

function optColor(opts) {
  if (!opts || !opts.color) return WHITE;
  const c = opts.color;
  _col[0] = c[0]; _col[1] = c[1]; _col[2] = c[2];
  _col[3] = c.length > 3 ? c[3] : 0;
  return _col;
}

// Unit icosphere cache. Generators call these repeatedly (a scatter tile can
// want 40 rock variants) and the base topology never changes, so subdividing
// once per level and copying is worth the few kilobytes.
const ICO_CACHE = new Map();

/**
 * Unit-radius icosphere topology, subdivided `subdiv` times.
 * Counts: 12/20, 42/80, 162/320, 642/1280, 2562/5120.
 * @returns {{positions: Float32Array, indices: Uint32Array}}
 */
function icosphereUnit(subdiv) {
  const level = clamp(subdiv | 0, 0, 4);
  const hit = ICO_CACHE.get(level);
  if (hit) return hit;

  const t = (1 + Math.sqrt(5)) * 0.5;
  let verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  });
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  for (let s = 0; s < level; s++) {
    const mid = new Map();
    const next = [];
    const midpoint = (a, b) => {
      const key = a < b ? a * 100000 + b : b * 100000 + a;
      let m = mid.get(key);
      if (m !== undefined) return m;
      const va = verts[a], vb = verts[b];
      const x = va[0] + vb[0], y = va[1] + vb[1], z = va[2] + vb[2];
      const l = Math.hypot(x, y, z);
      m = verts.length;
      verts.push([x / l, y / l, z / l]);
      mid.set(key, m);
      return m;
    };
    for (const f of faces) {
      const a = midpoint(f[0], f[1]), b = midpoint(f[1], f[2]), c = midpoint(f[2], f[0]);
      next.push([f[0], a, c], [f[1], b, a], [f[2], c, b], [a, b, c]);
    }
    faces = next;
  }

  const positions = new Float32Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) {
    positions[i * 3] = verts[i][0];
    positions[i * 3 + 1] = verts[i][1];
    positions[i * 3 + 2] = verts[i][2];
  }
  const indices = new Uint32Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) {
    indices[i * 3] = faces[i][0];
    indices[i * 3 + 1] = faces[i][1];
    indices[i * 3 + 2] = faces[i][2];
  }
  const entry = { positions, indices };
  ICO_CACHE.set(level, entry);
  return entry;
}

/**
 * Geodesic sphere. Nearly uniform triangle size, which is why every deformed
 * rock in the game starts here instead of on a UV sphere (whose pole triangles
 * would collapse under displacement).
 *
 * UVs are spherical, so there is a one-column seam where u wraps. That is the
 * standard trade for a welded geodesic mesh and the reason DESIGN/02 10.1
 * specifies "tangents from the icosphere's spherical UV": rock materials are
 * triplanar, so the seam never shows.
 *
 * Vertex/triangle count by subdivision: 12/20, 42/80, 162/320, 642/1280,
 * 2562/5120.
 *
 * @param {number} [subdivisions] 0..4
 * @param {number} [radius] metres
 * @param {object} [opts] {color, material}
 */
export function icosphere(subdivisions = 2, radius = 1, opts = {}) {
  const unit = icosphereUnit(subdivisions);
  const vc = unit.positions.length / 3;
  const mb = new MeshBuilder(vc, unit.indices.length);
  mb.material = opts.material ?? MESH_MATERIAL.ROCK;
  const color = optColor(opts);
  for (let i = 0; i < vc; i++) {
    const o = i * 3;
    vec3.set(_n, unit.positions[o], unit.positions[o + 1], unit.positions[o + 2]);
    vec3.scale(_p, _n, radius);
    _uv[0] = Math.atan2(_n[2], _n[0]) / TAU + 0.5;
    _uv[1] = Math.acos(clamp(_n[1], -1, 1)) / PI;
    mb.addVertex(_p, _n, _uv, color);
  }
  for (let k = 0; k < unit.indices.length; k += 3) {
    mb.addTriangle(unit.indices[k], unit.indices[k + 1], unit.indices[k + 2]);
  }
  return finish(mb);
}

/**
 * Latitude/longitude sphere. Use when you want a clean u,v grid (bladders,
 * pods, brain-coral bases); use icosphere() when you want to displace it.
 *
 * Typical: 16x10 -> 187 verts / 320 tris; 24x14 -> 375 / 672.
 *
 * @param {number} [segments] longitudinal divisions
 * @param {number} [rings] latitudinal divisions
 * @param {number} [radius] metres
 * @param {object} [opts] {color, material, radiusY} radiusY squashes the
 *   sphere into a bladder without a separate transform
 */
export function uvSphere(segments = 16, rings = 10, radius = 1, opts = {}) {
  const seg = Math.max(3, segments | 0);
  const rin = Math.max(2, rings | 0);
  const stride = seg + 1;
  const ry = opts.radiusY ?? radius;
  const mb = new MeshBuilder(stride * (rin + 1), seg * rin * 6);
  mb.material = opts.material ?? MESH_MATERIAL.FLORA;
  const color = optColor(opts);

  for (let i = 0; i <= rin; i++) {
    const v = i / rin;
    const phi = v * PI;                       // 0 at +Y
    const cy = Math.cos(phi), sy = Math.sin(phi);
    for (let j = 0; j <= seg; j++) {
      const uu = j / seg;
      const th = uu * TAU;
      const ct = Math.cos(th), st = Math.sin(th);
      _p[0] = radius * sy * ct; _p[1] = ry * cy; _p[2] = radius * sy * st;
      // Gradient of the implicit ellipsoid, not the position: with radiusY the
      // two are not parallel.
      _n[0] = (sy * ct) / radius; _n[1] = cy / ry; _n[2] = (sy * st) / radius;
      vec3.normalize(_n, _n);
      _uv[0] = uu; _uv[1] = v;
      mb.addVertex(_p, _n, _uv, color);
    }
  }
  for (let i = 0; i < rin; i++) {
    // Rings DESCEND from the +Y pole, so the sweep direction is the reverse of
    // a lathe's and the winding is the tube handedness (flip = false). The pole
    // rings are collapsed: bridgeRings drops the degenerate triangle.
    bridgeRings(mb, i * stride, (i + 1) * stride, seg, stride, false, i === 0, i === rin - 1);
  }
  return finish(mb);
}

/**
 * Tapered cylinder about +Y, base at y = 0.
 *
 * Side normals are analytic from the cone slope, so a strongly tapered
 * cylinder shades like a cone rather than like a tube.
 *
 * Typical: 16 segments, both caps -> 70 verts / 92 tris.
 *
 * @param {number} radiusBottom
 * @param {number} radiusTop
 * @param {number} height
 * @param {number} [segments]
 * @param {object} [opts] {color, material, capBottom, capTop}
 */
export function cylinder(radiusBottom, radiusTop, height, segments = 16, opts = {}) {
  const seg = Math.max(3, segments | 0);
  const stride = seg + 1;
  const capBottom = opts.capBottom !== false;
  const capTop = opts.capTop !== false;
  const mb = new MeshBuilder(stride * 2 + (seg + 1) * 2 + 2, seg * 12);
  mb.material = opts.material ?? MESH_MATERIAL.ROCK;
  const color = optColor(opts);

  // Slope of the side surface: the normal tilts by (rb - rt) / height.
  const slope = (radiusBottom - radiusTop) / Math.max(height, 1e-6);
  const nl = Math.hypot(1, slope);

  const base = mb.vertexCount;
  for (let i = 0; i <= 1; i++) {
    const r = i === 0 ? radiusBottom : radiusTop;
    const y = i === 0 ? 0 : height;
    for (let j = 0; j <= seg; j++) {
      const uu = j / seg;
      const th = uu * TAU;
      const ct = Math.cos(th), st = Math.sin(th);
      _p[0] = r * ct; _p[1] = y; _p[2] = r * st;
      _n[0] = ct / nl; _n[1] = slope / nl; _n[2] = st / nl;
      _uv[0] = uu; _uv[1] = i;
      mb.addVertex(_p, _n, _uv, color);
    }
  }
  bridgeRings(mb, base, base + stride, seg, stride, true,
    radiusBottom < 1e-6, radiusTop < 1e-6);

  if (capBottom && radiusBottom > 1e-6) addDisc(mb, radiusBottom, 0, -1, seg, color);
  if (capTop && radiusTop > 1e-6) addDisc(mb, radiusTop, height, 1, seg, color);
  return finish(mb);
}

/** Flat disc fan at height y, facing `dir` (+1 up, -1 down). */
function addDisc(mb, radius, y, dir, seg, color) {
  vec3.set(_n, 0, dir, 0);
  vec3.set(_p, 0, y, 0);
  _uv[0] = 0.5; _uv[1] = 0.5;
  const centre = mb.addVertex(_p, _n, _uv, color);
  const rim = mb.vertexCount;
  for (let j = 0; j <= seg; j++) {
    const th = (j / seg) * TAU;
    const ct = Math.cos(th), st = Math.sin(th);
    _p[0] = radius * ct; _p[1] = y; _p[2] = radius * st;
    _uv[0] = 0.5 + 0.5 * ct; _uv[1] = 0.5 + 0.5 * st;
    mb.addVertex(_p, _n, _uv, color);
  }
  // theta runs +X toward +Z, which is clockwise seen from +Y, so an up-facing
  // fan has to be wound backwards and a down-facing one forwards.
  for (let j = 0; j < seg; j++) {
    if (dir > 0) mb.addTriangle(centre, rim + j + 1, rim + j);
    else mb.addTriangle(centre, rim + j, rim + j + 1);
  }
}

/**
 * Box faces: outward normal, then the four corners in signed half-extents,
 * listed counter-clockwise AS SEEN FROM OUTSIDE the box. Written out rather
 * than derived from an axis permutation because the sign of the second in-plane
 * axis depends on the parity of the permutation, and getting one face's parity
 * wrong makes exactly one side of every box invisible.
 */
const BOX_FACES = [
  [1, 0, 0, [1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]],
  [-1, 0, 0, [-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]],
  [0, 1, 0, [-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]],
  [0, -1, 0, [-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]],
  [0, 0, 1, [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
  [0, 0, -1, [1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]],
];

/**
 * Axis-aligned box centred on the origin, with hard edges (24 verts, one per
 * face corner) so the faces shade flat.
 *
 * 24 verts / 12 tris.
 *
 * @param {number} hx half extent in x
 * @param {number} hy half extent in y
 * @param {number} hz half extent in z
 * @param {object} [opts] {color, material}
 */
export function box(hx, hy, hz, opts = {}) {
  const mb = new MeshBuilder(24, 36);
  mb.material = opts.material ?? MESH_MATERIAL.ROCK;
  const color = optColor(opts);
  for (const face of BOX_FACES) {
    const start = mb.vertexCount;
    vec3.set(_n, face[0], face[1], face[2]);
    for (let k = 0; k < 4; k++) {
      const c = face[3 + k];
      _p[0] = c[0] * hx; _p[1] = c[1] * hy; _p[2] = c[2] * hz;
      _uv[0] = (k === 0 || k === 3) ? 0 : 1;
      _uv[1] = k < 2 ? 0 : 1;
      mb.addVertex(_p, _n, _uv, color);
    }
    mb.addQuad(start, start + 1, start + 2, start + 3);
  }
  return finish(mb);
}

/**
 * Cone about +Y, base at y = 0. The apex is a ring of coincident vertices with
 * per-azimuth normals, so the tip shades as a cone instead of pinching to one
 * averaged normal.
 *
 * Typical: 16 segments -> 51 verts / 32 tris.
 *
 * @param {number} radius
 * @param {number} height
 * @param {number} [segments]
 * @param {object} [opts] {color, material, cap}
 */
export function cone(radius, height, segments = 16, opts = {}) {
  const seg = Math.max(3, segments | 0);
  const stride = seg + 1;
  const mb = new MeshBuilder(stride * 2 + seg + 2, seg * 6);
  mb.material = opts.material ?? MESH_MATERIAL.ROCK;
  const color = optColor(opts);
  const slope = radius / Math.max(height, 1e-6);
  const nl = Math.hypot(1, slope);

  const base = mb.vertexCount;
  for (let i = 0; i <= 1; i++) {
    for (let j = 0; j <= seg; j++) {
      const uu = j / seg;
      const th = uu * TAU;
      const ct = Math.cos(th), st = Math.sin(th);
      const r = i === 0 ? radius : 0;
      _p[0] = r * ct; _p[1] = i === 0 ? 0 : height; _p[2] = r * st;
      _n[0] = ct / nl; _n[1] = slope / nl; _n[2] = st / nl;
      _uv[0] = uu; _uv[1] = i;
      mb.addVertex(_p, _n, _uv, color);
    }
  }
  bridgeRings(mb, base, base + stride, seg, stride, true, false, true);
  if (opts.cap !== false) addDisc(mb, radius, 0, -1, seg, color);
  return finish(mb);
}

/**
 * Capsule about +Y: a cylinder of length `height` between two hemispherical
 * caps of `radius`, so the total extent is height + 2 * radius, centred on the
 * origin. Normals are analytic everywhere, including across the cap/barrel
 * join.
 *
 * Typical: 16 segments, 5 cap rings -> 221 verts / 384 tris.
 *
 * @param {number} radius
 * @param {number} height cylindrical length between the cap centres
 * @param {number} [segments]
 * @param {number} [capRings] rings per hemisphere
 * @param {object} [opts] {color, material}
 */
export function capsule(radius, height, segments = 16, capRings = 5, opts = {}) {
  const seg = Math.max(3, segments | 0);
  const cr = Math.max(1, capRings | 0);
  const stride = seg + 1;
  const rings = cr * 2 + 1;
  const mb = new MeshBuilder(stride * (rings + 1), seg * rings * 6);
  mb.material = opts.material ?? MESH_MATERIAL.FLORA;
  const color = optColor(opts);
  const halfH = height * 0.5;

  // Ring list: top cap (pole -> equator), the barrel, bottom cap.
  const ringY = new Float32Array(rings + 1);
  const ringR = new Float32Array(rings + 1);
  const ringNy = new Float32Array(rings + 1);
  let idx = 0;
  for (let i = 0; i <= cr; i++) {
    const a = (i / cr) * (PI * 0.5);            // 0 at the pole
    ringR[idx] = radius * Math.sin(a);
    ringY[idx] = halfH + radius * Math.cos(a);
    ringNy[idx] = Math.cos(a);
    idx++;
  }
  for (let i = cr; i >= 0; i--) {
    const a = (i / cr) * (PI * 0.5);
    ringR[idx] = radius * Math.sin(a);
    ringY[idx] = -halfH - radius * Math.cos(a);
    ringNy[idx] = -Math.cos(a);
    idx++;
  }

  const base = mb.vertexCount;
  for (let i = 0; i <= rings; i++) {
    const nr = Math.sqrt(Math.max(0, 1 - ringNy[i] * ringNy[i]));
    for (let j = 0; j <= seg; j++) {
      const uu = j / seg;
      const th = uu * TAU;
      const ct = Math.cos(th), st = Math.sin(th);
      _p[0] = ringR[i] * ct; _p[1] = ringY[i]; _p[2] = ringR[i] * st;
      _n[0] = nr * ct; _n[1] = ringNy[i]; _n[2] = nr * st;
      vec3.normalize(_n, _n);
      _uv[0] = uu; _uv[1] = i / rings;
      mb.addVertex(_p, _n, _uv, color);
    }
  }
  for (let i = 0; i < rings; i++) {
    // Rings descend from the +Y pole, as in uvSphere: flip = false.
    bridgeRings(mb, base + i * stride, base + (i + 1) * stride, seg, stride, false,
      ringR[i] < 1e-6, ringR[i + 1] < 1e-6);
  }
  return finish(mb);
}

/**
 * Torus in the XZ plane about +Y.
 *
 * Typical: 24x10 -> 275 verts / 480 tris.
 *
 * @param {number} majorRadius ring radius
 * @param {number} minorRadius tube radius
 * @param {number} [majorSegments]
 * @param {number} [minorSegments]
 * @param {object} [opts] {color, material}
 */
export function torus(majorRadius, minorRadius, majorSegments = 24, minorSegments = 10, opts = {}) {
  const ms = Math.max(3, majorSegments | 0);
  const ns = Math.max(3, minorSegments | 0);
  const stride = ns + 1;
  const mb = new MeshBuilder((ms + 1) * stride, ms * ns * 6);
  mb.material = opts.material ?? MESH_MATERIAL.ROCK;
  const color = optColor(opts);

  const base = mb.vertexCount;
  for (let i = 0; i <= ms; i++) {
    const uu = i / ms;
    const th = uu * TAU;
    const ct = Math.cos(th), st = Math.sin(th);
    for (let j = 0; j <= ns; j++) {
      const vv = j / ns;
      const ph = vv * TAU;
      const cp = Math.cos(ph), sp = Math.sin(ph);
      const r = majorRadius + minorRadius * cp;
      _p[0] = r * ct; _p[1] = minorRadius * sp; _p[2] = r * st;
      _n[0] = cp * ct; _n[1] = sp; _n[2] = cp * st;
      _uv[0] = uu; _uv[1] = vv;
      mb.addVertex(_p, _n, _uv, color);
    }
  }
  // Around-the-tube (+j) crossed with around-the-ring (+i) points outward, the
  // same handedness as a swept tube, so no flip.
  for (let i = 0; i < ms; i++) {
    bridgeRings(mb, base + i * stride, base + (i + 1) * stride, ns, stride, false);
  }
  return finish(mb);
}

/**
 * Revolve a 2D profile about +Y.
 *
 * The profile is a FLAT array of (r, y) pairs, in order; it may fold back on
 * itself, which is how a sponge or a vent chimney gets a hollow bore out of one
 * continuous surface with no seam and no boolean. Normals come from central
 * differences on the profile, so the surface stays smooth through the fold.
 *
 * Typical: 14 profile points x 16 segments -> 238 verts / 416 tris.
 *
 * @param {ArrayLike<number>} profile flat [r0, y0, r1, y1, ...]
 * @param {number} [segments] revolution segments
 * @param {object} [opts] {color, material, closeBottom, closeTop, uScale,
 *   modulate} - `modulate(ringT, theta, r, y)` returns a multiplier on r,
 *   which is how ribs, gills and pitting are added; when present, normals are
 *   recomputed from the deformed surface instead of from the profile
 */
export function lathe(profile, segments = 16, opts = {}) {
  const rings = (profile.length / 2) | 0;
  const seg = Math.max(3, segments | 0);
  const stride = seg + 1;
  const uScale = opts.uScale ?? 1;
  const modulate = opts.modulate || null;
  const mb = new MeshBuilder(rings * stride + seg * 2 + 4, rings * seg * 6);
  mb.material = opts.material ?? MESH_MATERIAL.ROCK;
  const color = optColor(opts);

  const base = mb.vertexCount;
  const radii = new Float32Array(rings);
  for (let i = 0; i < rings; i++) {
    const r = profile[i * 2], y = profile[i * 2 + 1];
    radii[i] = r;
    const ip = Math.max(0, i - 1), inx = Math.min(rings - 1, i + 1);
    const dr = profile[inx * 2] - profile[ip * 2];
    const dy = profile[inx * 2 + 1] - profile[ip * 2 + 1];
    const pl = Math.hypot(dr, dy) || 1;
    // (r, y) tangent rotated a quarter turn gives the profile normal; see the
    // derivation in bridgeRings for why this pairs with flip = true.
    const nr = dy / pl, ny = -dr / pl;
    const ringT = rings > 1 ? i / (rings - 1) : 0;

    for (let j = 0; j <= seg; j++) {
      const uu = j / seg;
      const th = uu * TAU;
      const ct = Math.cos(th), st = Math.sin(th);
      const rr = modulate ? r * modulate(ringT, th, r, y) : r;
      _p[0] = rr * ct; _p[1] = y; _p[2] = rr * st;
      _n[0] = nr * ct; _n[1] = ny; _n[2] = nr * st;
      vec3.normalize(_n, _n);
      _uv[0] = uu * uScale; _uv[1] = ringT;
      mb.addVertex(_p, _n, _uv, color);
    }
  }
  for (let i = 0; i < rings - 1; i++) {
    bridgeRings(mb, base + i * stride, base + (i + 1) * stride, seg, stride, true,
      radii[i] < 1e-6, radii[i + 1] < 1e-6);
  }
  // A modulated radius makes the profile normal wrong, so re-derive it from the
  // faces. computeSmoothNormals rather than computeNormals because the u = 0 and
  // u = 1 columns are distinct vertices at the same position: welding them is
  // the difference between a smooth sponge and one with a seam down its side.
  if (modulate) mb.computeSmoothNormals(1.1);

  // Cap from the ring vertices that were actually emitted, not from the profile
  // radius. With `modulate` on, the two differ by the rib amplitude, and a cap
  // built from the nominal radius leaves a hairline crack all the way around the
  // base of every sponge and vent chimney.
  if (opts.closeBottom && radii[0] > 1e-6) {
    addRingCap(mb, base, seg, profile[1], -1, color);
  }
  if (opts.closeTop && radii[rings - 1] > 1e-6) {
    addRingCap(mb, base + (rings - 1) * stride, seg, profile[(rings - 1) * 2 + 1], 1, color);
  }

  return finish(mb);
}

/**
 * Cap an emitted lathe ring by duplicating its vertices with the cap's own
 * normal and fanning them to a centre point at height `y`.
 *
 * The ring is stored with a duplicated seam (stride = seg + 1), so the fan walks
 * j and j + 1 without wrapping.
 */
function addRingCap(mb, ringBase, seg, y, dir, color) {
  vec3.set(_n, 0, dir, 0);
  const dup = mb.vertexCount;
  for (let j = 0; j <= seg; j++) {
    const src = (ringBase + j) * 3;
    vec3.set(_p, mb.positions[src], y, mb.positions[src + 2]);
    const th = (j / seg) * TAU;
    _uv[0] = 0.5 + 0.5 * Math.cos(th);
    _uv[1] = 0.5 + 0.5 * Math.sin(th);
    mb.addVertex(_p, _n, _uv, color);
  }
  vec3.set(_p, 0, y, 0);
  _uv[0] = 0.5; _uv[1] = 0.5;
  const centre = mb.addVertex(_p, _n, _uv, color);
  // theta runs +X toward +Z, which is clockwise seen from +Y, so an up-facing fan
  // has to be wound backwards and a down-facing one forwards.
  for (let j = 0; j < seg; j++) {
    if (dir > 0) mb.addTriangle(centre, dup + j + 1, dup + j);
    else mb.addTriangle(centre, dup + j, dup + j + 1);
  }
}

/**
 * Sweep a closed 2D cross-section along a polyline, with optional twist and
 * taper. This is the workhorse behind every stalk, stipe, frond and rib.
 *
 * The section is given in units of the local frame (u, v): u is the
 * rotation-minimising reference axis, v = cross(dir, u). Frames are parallel
 * transported (see splineFrames) so a leaning, coiling stipe has no twist
 * artifact where its tangent passes through vertical.
 *
 * uv.y and colour.w both carry the 0..1 arc-length parameter, so the vertex
 * shader gets the sway weight and the material gets a "how far up the stalk"
 * coordinate from the same sweep.
 *
 * Typical: 4-point section x 20 stations -> 80 verts / 152 tris.
 *
 * @param {ArrayLike<number>} profile flat [u0, v0, u1, v1, ...] closed section
 * @param {ArrayLike<number>} spline flat xyz polyline
 * @param {number} [twist] total radians of section rotation over the sweep
 * @param {number} [taper] section scale at the far end (1 = none)
 * @param {object} [opts] {color, material, radius, scaleFn, upHint, capStart,
 *   capEnd, swayExponent} - scaleFn(t) multiplies the section scale per station
 */
export function extrudeAlongSpline(profile, spline, twist = 0, taper = 1, opts = {}) {
  const sec = (profile.length / 2) | 0;
  const frames = splineFrames(spline, opts.upHint);
  const stations = frames.count;
  const radius = opts.radius ?? 1;
  const scaleFn = opts.scaleFn || null;
  const swayExp = opts.swayExponent ?? 1;
  const mb = new MeshBuilder(sec * stations + sec * 2, sec * stations * 6);
  mb.material = opts.material ?? MESH_MATERIAL.FLORA;
  const color = optColor(opts);
  const baseColor = Float32Array.of(color[0], color[1], color[2], 0);
  const invLen = frames.length > 1e-6 ? 1 / frames.length : 0;

  const base = mb.vertexCount;
  for (let i = 0; i < stations; i++) {
    const t = frames.arc[i] * invLen;
    vec3.set(_d, frames.tangents[i * 3], frames.tangents[i * 3 + 1], frames.tangents[i * 3 + 2]);
    vec3.set(_u, frames.refs[i * 3], frames.refs[i * 3 + 1], frames.refs[i * 3 + 2]);
    vec3.cross(_v, _d, _u);
    const tw = twist * t;
    const cw = Math.cos(tw), sw = Math.sin(tw);
    const scale = radius * lerp(1, taper, t) * (scaleFn ? scaleFn(t) : 1);
    // Smoothstep sway: a linear ramp lets the anchored base slide, which reads
    // as the whole plant skating across the seabed.
    const sway = Math.pow(smoothstep(0, 1, t), swayExp);
    baseColor[3] = sway;
    for (let k = 0; k < sec; k++) {
      // Rotate the section by the accumulated twist, then place it in the frame.
      const su = profile[k * 2] * cw - profile[k * 2 + 1] * sw;
      const sv = profile[k * 2] * sw + profile[k * 2 + 1] * cw;
      _p[0] = spline[i * 3] + (_u[0] * su + _v[0] * sv) * scale;
      _p[1] = spline[i * 3 + 1] + (_u[1] * su + _v[1] * sv) * scale;
      _p[2] = spline[i * 3 + 2] + (_u[2] * su + _v[2] * sv) * scale;
      // Section-outline normal: the outward in-plane direction, which for a
      // convex section is the section point itself rotated into the frame.
      const l = Math.hypot(su, sv) || 1;
      _n[0] = (_u[0] * su + _v[0] * sv) / l;
      _n[1] = (_u[1] * su + _v[1] * sv) / l;
      _n[2] = (_u[2] * su + _v[2] * sv) / l;
      _uv[0] = k / sec;
      _uv[1] = t;
      mb.addVertex(_p, _n, _uv, baseColor);
    }
  }
  for (let i = 0; i < stations - 1; i++) {
    bridgeRings(mb, base + i * sec, base + (i + 1) * sec, sec, sec, false);
  }
  // Taper toward a point still leaves an open ring; cap it so backface culling
  // does not put a hole through the tip.
  // Section normals are analytic and stay analytic: for a tapered sweep they
  // are off by the taper half-angle, which for every plant in the game is under
  // 5 degrees. Recomputing them from the faces instead would let the flat end
  // cap out-vote the side bands at the last ring and tip those normals past 90
  // degrees from their own surface.
  if (opts.capEnd !== false) capSectionRing(mb, base + (stations - 1) * sec, sec, spline, stations - 1, frames, 1, baseColor);
  if (opts.capStart) capSectionRing(mb, base, sec, spline, 0, frames, -1, baseColor);
  return finish(mb);
}

/**
 * Fan-cap an open section ring at spline station `i`, facing `dir` along the
 * tangent.
 *
 * The ring is DUPLICATED with the cap's own normal rather than reusing the
 * sweep's ring: sharing it would shade the cap with radial normals, which makes
 * the end of every blade and every stalk read as a torn edge.
 */
function capSectionRing(mb, ringBase, sec, spline, i, frames, dir, color) {
  vec3.set(_d, frames.tangents[i * 3], frames.tangents[i * 3 + 1], frames.tangents[i * 3 + 2]);
  vec3.scale(_n, _d, dir);
  const v = frames.length > 1e-6 ? frames.arc[i] / frames.length : 0;
  const dup = mb.vertexCount;
  for (let k = 0; k < sec; k++) {
    const src = (ringBase + k) * 3;
    vec3.set(_p, mb.positions[src], mb.positions[src + 1], mb.positions[src + 2]);
    _col[0] = color[0]; _col[1] = color[1]; _col[2] = color[2];
    _col[3] = mb.colors[(ringBase + k) * 4 + 3];
    _uv[0] = k / sec; _uv[1] = v;
    mb.addVertex(_p, _n, _uv, _col);
  }
  vec3.set(_p, spline[i * 3], spline[i * 3 + 1], spline[i * 3 + 2]);
  _uv[0] = 0.5; _uv[1] = v;
  const centre = mb.addVertex(_p, _n, _uv, _col);
  for (let k = 0; k < sec; k++) {
    const a = dup + k, b = dup + ((k + 1) % sec);
    if (dir > 0) mb.addTriangle(centre, a, b);
    else mb.addTriangle(centre, b, a);
  }
}

// ===========================================================================
// Deformed-icosphere rocks
// ===========================================================================

/**
 * Rock displacement knobs, DESIGN/02 Table 10.1.
 *   AL/fL  amplitude and frequency of the large lumps
 *   AM/fM  medium erosion
 *   AC/fC  worley chipping, which is what makes an angular fracture face
 *   base   how flat the underside is clamped, in unit-sphere units
 */
const ROCK_KNOBS = [
  { name: 'rounded', AL: 0.22, fL: 1.3, AM: 0.09, fM: 3.4, AC: 0.05, fC: 2.0, axisLo: 0.80, axisHi: 1.25, base: -0.78 },
  { name: 'blocky', AL: 0.14, fL: 1.1, AM: 0.07, fM: 2.8, AC: 0.26, fC: 1.5, axisLo: 0.70, axisHi: 1.35, base: -0.74 },
  { name: 'spiky', AL: 0.34, fL: 2.2, AM: 0.16, fM: 5.5, AC: 0.30, fC: 3.1, axisLo: 0.75, axisHi: 1.30, base: -0.82 },
  { name: 'slab', AL: 0.18, fL: 1.6, AM: 0.10, fM: 4.1, AC: 0.14, fC: 2.4, axisLo: 0.72, axisHi: 1.40, base: -0.55 },
];

/**
 * Width of the worley chip smoothstep. DESIGN/02 Table 10.1 implies 0.35, but
 * that assumes a resolution the mesh does not have: at subdivision 3 the vertex
 * spacing is 0.13 unit-sphere units, and a chip edge resolving in fewer than
 * three vertices makes a cusp whose averaged shading normals end up facing away
 * from their own facets.
 */
const CHIP_WINDOW = 0.46;

/**
 * Radial-slope budget for the displacement stack, in unit-sphere units.
 *
 * A radial displacement can never fold the surface (it stays star-shaped about
 * the origin), so the failure mode is not geometric but SHADING: past a total
 * slope of about 2 the area-weighted vertex normals at a ridge cusp tip more
 * than 90 degrees away from the facets that produced them, and those facets
 * light as if they were back-facing. 1.6 leaves margin at every subdivision
 * level and every axis anisotropy the variant table allows.
 *
 * The design's rounded and blocky knobs already sit under this; only the
 * spikiest end of the range gets scaled, and it gets scaled smoothly, so
 * `angularity` stays continuous.
 */
const SLOPE_BUDGET = 1.15;

/** Total radial slope the three displacement octaves can produce together. */
function knobSlope(k) {
  // max|d/dw smoothstep(0, W, w)| = 1.5 / W.
  return k.AL * k.fL + k.AM * k.fM + k.AC * (1.5 / CHIP_WINDOW) * k.fC;
}

/** Blend two knob sets. */
function blendKnobs(a, b, t) {
  return {
    AL: lerp(a.AL, b.AL, t), fL: lerp(a.fL, b.fL, t),
    AM: lerp(a.AM, b.AM, t), fM: lerp(a.fM, b.fM, t),
    AC: lerp(a.AC, b.AC, t), fC: lerp(a.fC, b.fC, t),
    axisLo: lerp(a.axisLo, b.axisLo, t), axisHi: lerp(a.axisHi, b.axisHi, t),
    base: lerp(a.base, b.base, t),
  };
}

/**
 * Emit a deformed icosphere into `mb`. Shared by every rock-like generator.
 *
 * The flat base is not cosmetic: scatter places these by dropping them onto the
 * terrain height, and an un-flattened sphere either floats on one contact point
 * or has to be sunk so far that half the silhouette is lost.
 *
 * @returns {{first: number, count: number, axis: Float32Array}}
 */
function emitDeformedIcosphere(mb, subdiv, radius, knobs, noiseSeed, rng, color, squashY = 1) {
  const unit = icosphereUnit(subdiv);
  // Scale the whole displacement stack down to the slope budget, preserving the
  // ratios between octaves so the variant still reads as its own kind of rock.
  const gain = Math.min(1, SLOPE_BUDGET / Math.max(knobSlope(knobs), 1e-6));
  const AL = knobs.AL * gain, AM = knobs.AM * gain, AC = knobs.AC * gain;
  const vc = unit.positions.length / 3;
  const first = mb.vertexCount;
  const axis = Float32Array.of(
    lerp(knobs.axisLo, knobs.axisHi, rng()),
    lerp(knobs.axisLo, knobs.axisHi, rng()) * squashY,
    lerp(knobs.axisLo, knobs.axisHi, rng()));

  for (let i = 0; i < vc; i++) {
    const o = i * 3;
    let x = unit.positions[o] * axis[0];
    let y = unit.positions[o + 1] * axis[1];
    let z = unit.positions[o + 2] * axis[2];

    let r = 1 + AL * simplex3(x * knobs.fL, y * knobs.fL, z * knobs.fL, noiseSeed);
    r += AM * simplex3(x * knobs.fM, y * knobs.fM, z * knobs.fM, noiseSeed ^ 1);
    // Worley F1 is small near a cell centre and large at the boundary; taking
    // it away from the radius carves flat facets whose edges are the cell
    // boundaries. That is what reads as fracture rather than as lumpiness.
    const w = worley3F1(x * knobs.fC, y * knobs.fC, z * knobs.fC, noiseSeed ^ 2, 1.0);
    r -= AC * smoothstep(0, CHIP_WINDOW, w);

    // Flat base, blended rather than clamped. A hard max() leaves a knife-edge
    // crease around the whole underside, and the shading normals of the
    // triangles that straddle it end up more than 90 degrees from their own
    // faces. smax rounds the transition over 0.09 units, which is also what a
    // water-worn rock resting in sediment actually looks like.
    y = smax(y, knobs.base + 0.10 * simplex3(x * 2.1, y * 2.1, z * 2.1, noiseSeed ^ 3), 0.09);

    _p[0] = x * r * radius; _p[1] = y * r * radius; _p[2] = z * r * radius;
    vec3.set(_n, unit.positions[o], unit.positions[o + 1], unit.positions[o + 2]);
    _uv[0] = Math.atan2(_n[2], _n[0]) / TAU + 0.5;
    _uv[1] = Math.acos(clamp(_n[1], -1, 1)) / PI;
    mb.addVertex(_p, _n, _uv, color);
  }
  const firstIndex = mb.indexCount;
  for (let k = 0; k < unit.indices.length; k += 3) {
    mb.addTriangle(first + unit.indices[k], first + unit.indices[k + 1], first + unit.indices[k + 2]);
  }
  mb.computeNormals(first, firstIndex);
  return { first, count: vc, axis };
}

/**
 * A seabed rock.
 *
 * `angularity` walks the knob table from water-worn cobble (0) through
 * fractured basalt (0.5) to pinnacle (1), so one generator covers the whole
 * range the biomes ask for instead of six near-duplicates.
 *
 * Vertices: 642 (detail HIGH), 162 (MEDIUM), 42 (LOW). Triangles 1280/320/80.
 *
 * @param {number} seed
 * @param {number} [size] bounding radius in metres
 * @param {number} [angularity] 0 rounded .. 1 spiky
 * @param {object} [opts] {detail, color}
 */
export function generateRock(seed, size = 1, angularity = 0.5, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, MESH_ASSET.ROCK);
  const ns = assetNoiseSeed(seed, MESH_ASSET.ROCK);
  const a = saturate(angularity) * 2;
  const knobs = a <= 1
    ? blendKnobs(ROCK_KNOBS[0], ROCK_KNOBS[1], a)
    : blendKnobs(ROCK_KNOBS[1], ROCK_KNOBS[2], a - 1);
  const subdiv = byDetail(detail, 1, 2, 3);
  const mb = new MeshBuilder(byDetail(detail, 42, 162, 642), byDetail(detail, 240, 960, 3840));
  mb.material = MESH_MATERIAL.ROCK;
  const color = optColor({ color: opts.color || MESH_PALETTE.BASALT });
  emitDeformedIcosphere(mb, subdiv, size, knobs, ns, rng, color);
  return finish(mb);
}

/**
 * A house-sized angular block for the Tumbled Boulder Field: blockier knobs, a
 * flatter and wider base, and enough anisotropy that a pile of them reads as
 * fractured basalt rather than as a heap of potatoes.
 *
 * Vertices: 642 / 162 / 42. Triangles 1280 / 320 / 80.
 *
 * @param {number} seed
 * @param {number} [size] bounding radius in metres
 * @param {object} [opts] {detail, color, irregularity}
 */
export function generateBoulder(seed, size = 4, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, MESH_ASSET.BOULDER);
  const ns = assetNoiseSeed(seed, MESH_ASSET.BOULDER);
  // `irregularity` walks the same knob blend generateRock's `angularity` does,
  // so a boulder field can be authored blocky or water-worn per type instead of
  // every boulder in the world sharing one hard-coded 0.35-0.75 band.
  const knobs = blendKnobs(ROCK_KNOBS[1], ROCK_KNOBS[3],
    saturate(opts.irregularity ?? 0.58) * lerp(0.6, 1.05, rng()));
  const mb = new MeshBuilder(byDetail(detail, 42, 162, 642), byDetail(detail, 240, 960, 3840));
  mb.material = MESH_MATERIAL.ROCK;
  const color = optColor({ color: opts.color || MESH_PALETTE.BASALT_DARK });
  emitDeformedIcosphere(mb, byDetail(detail, 1, 2, 3), size, knobs, ns, rng, color, 0.78);
  return finish(mb);
}

/**
 * A pebble or cobble: the same displacement at a subdivision the eye will never
 * count, because these are placed by the thousand and their whole job is to
 * break up flat sand.
 *
 * Vertices: 162 / 42 / 12. Triangles 320 / 80 / 20.
 *
 * @param {number} seed
 * @param {number} [size] bounding radius in metres
 * @param {object} [opts] {detail, color, irregularity}
 */
export function generatePebble(seed, size = 0.22, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, MESH_ASSET.PEBBLE);
  const ns = assetNoiseSeed(seed, MESH_ASSET.PEBBLE);
  // Water-worn shingle and angular deep gravel are the same generator at two
  // ends of this blend, and they are the whole difference between a swash zone
  // and a manganese nodule field.
  const knobs = blendKnobs(ROCK_KNOBS[0], ROCK_KNOBS[3],
    saturate(opts.irregularity ?? 0.5) * lerp(0.6, 1.0, rng()));
  const mb = new MeshBuilder(byDetail(detail, 12, 42, 162), byDetail(detail, 60, 240, 960));
  mb.material = MESH_MATERIAL.ROCK;
  const color = optColor({ color: opts.color || MESH_PALETTE.PALE_ROCK });
  emitDeformedIcosphere(mb, byDetail(detail, 0, 1, 2), size, knobs, ns, rng, color, 0.62);
  return finish(mb);
}

// ===========================================================================
// Crystals
// ===========================================================================

/**
 * One convex crystal prism in local space (+Y up, base at y = 0), with every
 * facet flat-shaded and a geometric emissive vein up two or three of its
 * vertical edges.
 *
 * Facets are built as independent quads with their own face normal. Sharing
 * vertices between them would average the normals and turn a crystal into a
 * lumpy cylinder, which defeats the only thing crystals are for.
 */
function emitPrism(mb, sides, radii, height, taper, apexRatio, veinCount, color, veinColor, veinMaterial) {
  const mat = mb.material;
  const apexH = height * apexRatio;
  const ring = new Float32Array(sides * 2);
  for (let k = 0; k < sides; k++) {
    const a = (k / sides) * TAU;
    ring[k * 2] = Math.cos(a) * radii[k];
    ring[k * 2 + 1] = Math.sin(a) * radii[k];
  }

  // Side facets.
  for (let k = 0; k < sides; k++) {
    const k1 = (k + 1) % sides;
    const b0x = ring[k * 2], b0z = ring[k * 2 + 1];
    const b1x = ring[k1 * 2], b1z = ring[k1 * 2 + 1];
    const t0x = b0x * taper, t0z = b0z * taper;
    const t1x = b1x * taper, t1z = b1z * taper;
    // Face normal from the two facet edges. The base ring runs from +X toward +Z,
    // which is CLOCKWISE seen from above, so it is (up x alongBase) that points
    // out of the prism - the other order points into it, and the facet quads have
    // to be wound to match.
    vec3.set(_e0, b1x - b0x, 0, b1z - b0z);
    vec3.set(_e1, t0x - b0x, height, t0z - b0z);
    vec3.cross(_n, _e1, _e0);
    if (vec3.sqrLen(_n) < 1e-16) vec3.set(_n, b0x, 0, b0z);
    vec3.normalize(_n, _n);
    const start = mb.vertexCount;
    const quad = [[b0x, 0, b0z, 0, 0], [b1x, 0, b1z, 1, 0], [t1x, height, t1z, 1, 1], [t0x, height, t0z, 0, 1]];
    for (const q of quad) {
      vec3.set(_p, q[0], q[1], q[2]);
      _uv[0] = q[3]; _uv[1] = q[4];
      mb.addVertex(_p, _n, _uv, color);
    }
    // Reversed: base -> top -> top+1 -> base+1 is the order whose geometric
    // normal is (up x alongBase).
    mb.addQuad(start, start + 3, start + 2, start + 1);
  }

  // Pyramid cap: one triangle per facet, again with its own normal.
  for (let k = 0; k < sides; k++) {
    const k1 = (k + 1) % sides;
    const t0x = ring[k * 2] * taper, t0z = ring[k * 2 + 1] * taper;
    const t1x = ring[k1 * 2] * taper, t1z = ring[k1 * 2 + 1] * taper;
    vec3.set(_e0, t1x - t0x, 0, t1z - t0z);
    vec3.set(_e1, -t0x, apexH, -t0z);
    vec3.cross(_n, _e1, _e0);
    if (vec3.sqrLen(_n) < 1e-16) vec3.set(_n, 0, 1, 0);
    vec3.normalize(_n, _n);
    const start = mb.vertexCount;
    vec3.set(_p, t0x, height, t0z); _uv[0] = 0; _uv[1] = 1; mb.addVertex(_p, _n, _uv, color);
    vec3.set(_p, t1x, height, t1z); _uv[0] = 1; _uv[1] = 1; mb.addVertex(_p, _n, _uv, color);
    vec3.set(_p, 0, height + apexH, 0); _uv[0] = 0.5; _uv[1] = 1; mb.addVertex(_p, _n, _uv, color);
    mb.addTriangle(start, start + 2, start + 1);
  }

  // Base, so the prism is closed even where it does not quite meet the rock.
  vec3.set(_n, 0, -1, 0);
  vec3.set(_p, 0, 0, 0);
  _uv[0] = 0.5; _uv[1] = 0.5;
  const centre = mb.addVertex(_p, _n, _uv, color);
  const rimBase = mb.vertexCount;
  for (let k = 0; k < sides; k++) {
    vec3.set(_p, ring[k * 2], 0, ring[k * 2 + 1]);
    _uv[0] = 0.5 + 0.5 * Math.cos((k / sides) * TAU);
    _uv[1] = 0.5 + 0.5 * Math.sin((k / sides) * TAU);
    mb.addVertex(_p, _n, _uv, color);
  }
  for (let k = 0; k < sides; k++) {
    mb.addTriangle(centre, rimBase + k, rimBase + ((k + 1) % sides));
  }

  // Emissive veins along vertical edges: a narrow ribbon lifted off the edge in
  // the bisector direction of the two facets that meet there. Geometry, not a
  // texture, so it survives at any texel density and lights the water around it.
  mb.material = veinMaterial;
  const lift = 0.012;
  for (let s = 0; s < veinCount; s++) {
    const k = Math.floor((s * sides) / Math.max(1, veinCount)) % sides;
    const ex = ring[k * 2], ez = ring[k * 2 + 1];
    const el = Math.hypot(ex, ez) || 1;
    const ox = (ex / el), oz = (ez / el);
    const halfW = 0.055 * el;
    // Ribbon perpendicular: rotate the outward direction a quarter turn in XZ.
    const px = -oz * halfW, pz = ox * halfW;
    const start = mb.vertexCount;
    vec3.set(_n, ox, 0, oz);
    const yTop = height * 0.94;
    const tScale = lerp(1, taper, 0.94);
    const pts = [
      [ex + ox * lift - px, height * 0.06, ez + oz * lift - pz, 0, 0],
      [ex + ox * lift + px, height * 0.06, ez + oz * lift + pz, 1, 0],
      [ex * tScale + ox * lift + px, yTop, ez * tScale + oz * lift + pz, 1, 1],
      [ex * tScale + ox * lift - px, yTop, ez * tScale + oz * lift - pz, 0, 1],
    ];
    for (const q of pts) {
      vec3.set(_p, q[0], q[1], q[2]);
      _uv[0] = q[3]; _uv[1] = q[4];
      mb.addVertex(_p, _n, _uv, veinColor);
    }
    // Wound backwards: the ribbon's perpendicular is the outward direction
    // rotated a quarter turn in XZ, and (perp x up) points INTO the crystal.
    mb.addQuad(start, start + 3, start + 2, start + 1);
  }
  mb.material = mat;
}

/**
 * A crystal cluster: 3-7 convex prisms sharing a base, spread in azimuth and
 * tilted off vertical, each with a pyramidal termination and geometric emissive
 * veins up its edges. Calcite spar, amethyst druse and voidglass shard are all
 * this generator with different colours and heights.
 *
 * Vertices: 300-620 (HIGH), 190-400 (MEDIUM), 120-260 (LOW).
 *
 * @param {number} seed
 * @param {number} [height] metres, the primary prism
 * @param {number} [facets] 5..8 sides per prism
 * @param {object} [opts] {detail, color, veinColor, emissive, prisms} - emissive false
 *   makes the veins a non-glowing mineral streak (voidglass glows, spar does not)
 */
export function generateCrystal(seed, height = 1.2, facets = 6, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, MESH_ASSET.CRYSTAL);
  const sides = clamp(facets | 0, 3, 8);
  // The HIGH range starts at the MEDIUM count so the LOD vertex counts never
  // invert: a tier that can produce fewer vertices than the tier below it
  // breaks the scatter system's assumption that LOD selection only ever saves.
  // `prisms` is the authored cluster size; the tier scales it rather than
  // replacing it, so a crystal SPIRE (8 prisms) is visibly a bigger cluster than
  // a crystal SHARD (5) at every LOD instead of both drawing the same 4.
  const prisms = opts.prisms ?? (4 + rng.int(0, 3));
  const count = clamp(Math.round(prisms * byDetail(detail, 0.45, 0.7, 1)), 1, 12);
  const mb = new MeshBuilder(count * (sides * 8 + 20), count * (sides * 24 + 30));
  mb.material = MESH_MATERIAL.CRYSTAL;
  const color = optColor({ color: opts.color || MESH_PALETTE.CRYSTAL_CLEAR });
  const bodyColor = Float32Array.of(color[0], color[1], color[2], 0);
  const vc = opts.veinColor || MESH_PALETTE.AMETHYST;
  const veinColor = Float32Array.of(vc[0], vc[1], vc[2], 0);
  const veinMaterial = opts.emissive === false ? MESH_MATERIAL.CRYSTAL : MESH_MATERIAL.EMISSIVE;

  const radii = new Float32Array(sides);
  const q = Float32Array.of(0, 0, 0, 1);
  const axis = vec3.create();
  const trans = vec3.create();
  const scale = vec3.create(1, 1, 1);
  const xf = new Float32Array(16);

  for (let c = 0; c < count; c++) {
    const primary = c === 0;
    const h = height * (primary ? 1 : lerp(0.35, 1.0, rng()));
    const R = h * lerp(0.07, 0.20, rng());
    for (let k = 0; k < sides; k++) radii[k] = R * (0.72 + 0.28 * rng());
    const taper = lerp(0.05, 0.55, rng());
    const apexRatio = lerp(0.18, 0.55, rng());
    const veins = byDetail(detail, 1, 2, 2 + (rng() < 0.5 ? 1 : 0));

    const sub = new MeshBuilder(sides * 8 + 20, sides * 24 + 30);
    sub.material = MESH_MATERIAL.CRYSTAL;
    emitPrism(sub, sides, radii, h, taper, apexRatio, veins, bodyColor, veinColor, veinMaterial);

    // Tilt about a horizontal axis, then push the base out so the prisms fan
    // from a shared root instead of intersecting at the origin.
    const az = primary ? 0 : (c / count) * TAU + rng() * 0.9;
    const tilt = primary ? lerp(0.0, 0.12, rng()) : lerp(0.15, 0.55, rng());
    vec3.set(axis, -Math.sin(az), 0, Math.cos(az));
    const s = Math.sin(tilt * 0.5);
    q[0] = axis[0] * s; q[1] = axis[1] * s; q[2] = axis[2] * s; q[3] = Math.cos(tilt * 0.5);
    const off = primary ? 0 : R * lerp(0.8, 2.4, rng());
    vec3.set(trans, Math.cos(az) * off, -h * 0.04, Math.sin(az) * off);
    buildTRS(xf, q, trans, scale);
    mb.merge(sub, xf);
  }
  return finish(mb);
}

/** Compose T * R * S into `out` without importing mat4's whole namespace cost. */
function buildTRS(out, q, t, s) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = (1 - (yy + zz)) * s[0]; out[1] = (xy + wz) * s[0]; out[2] = (xz - wy) * s[0]; out[3] = 0;
  out[4] = (xy - wz) * s[1]; out[5] = (1 - (xx + zz)) * s[1]; out[6] = (yz + wx) * s[1]; out[7] = 0;
  out[8] = (xz + wy) * s[2]; out[9] = (yz - wx) * s[2]; out[10] = (1 - (xx + yy)) * s[2]; out[11] = 0;
  out[12] = t[0]; out[13] = t[1]; out[14] = t[2]; out[15] = 1;
  return out;
}

// ===========================================================================
// Space colonisation - the skeleton behind branching corals, tube corals,
// glass-sponge lattices and coral fans
// ===========================================================================

/**
 * Grow a branching skeleton toward a cloud of attractors (Runions et al.
 * space colonisation).
 *
 * Determinism comes from three things: the attractor cloud is a Halton
 * sequence with a per-seed offset, nodes are appended in a fixed order and
 * never reordered, and the nearest-node search is INCREMENTAL - each attractor
 * remembers its best node and is only ever compared against nodes added since
 * the last iteration. That last point is also what makes this affordable:
 * O(attractors * nodes) total instead of per iteration.
 *
 * @param {object} p
 * @param {Float32Array} p.attractors flat xyz
 * @param {number} p.influence attractors further than this ignore a node
 * @param {number} p.kill attractors closer than this to any node are consumed
 * @param {number} p.step node spacing
 * @param {number} p.maxNodes hard cap; the growth stops cleanly when reached
 * @param {number} [p.maxIterations]
 * @param {ArrayLike<number>} [p.root]
 * @param {ArrayLike<number>} [p.initialDir]
 * @param {number} [p.initialSteps] straight stem before branching begins
 * @param {number} [p.jitter] radians of hash jitter per growth step
 * @param {number} [p.maxTurn] radians a child may deviate from its parent's own
 *   direction. Without this a branch can be told to grow back down the trunk,
 *   and the band lofted between the two rings then folds through itself
 * @param {Function} [p.rng]
 * @returns {{pos: Float32Array, parent: Int32Array, count: number,
 *   rootDir: Float32Array}}
 */
function growSkeleton(p) {
  const maxNodes = Math.max(2, p.maxNodes | 0);
  const pos = new Float32Array(maxNodes * 3);
  const parent = new Int32Array(maxNodes).fill(-1);
  const rootDir = vec3.clone(p.initialDir || Float32Array.of(0, 1, 0));
  vec3.normalize(rootDir, rootDir);
  let count = 0;

  const root = p.root || Float32Array.of(0, 0, 0);
  pos[0] = root[0]; pos[1] = root[1]; pos[2] = root[2];
  count = 1;
  const initialSteps = p.initialSteps ?? 2;
  for (let i = 0; i < initialSteps && count < maxNodes; i++) {
    const prev = (count - 1) * 3;
    pos[count * 3] = pos[prev] + rootDir[0] * p.step;
    pos[count * 3 + 1] = pos[prev + 1] + rootDir[1] * p.step;
    pos[count * 3 + 2] = pos[prev + 2] + rootDir[2] * p.step;
    parent[count] = count - 1;
    count++;
  }

  const m = (p.attractors.length / 3) | 0;
  const alive = new Uint8Array(m).fill(1);
  const bestNode = new Int32Array(m).fill(-1);
  const bestDist = new Float32Array(m).fill(Infinity);
  const accX = new Float32Array(maxNodes);
  const accY = new Float32Array(maxNodes);
  const accZ = new Float32Array(maxNodes);
  const accN = new Int32Array(maxNodes);
  const kill2 = p.kill * p.kill;
  const infl2 = p.influence * p.influence;
  const jitter = p.jitter ?? 0;
  const rng = p.rng;
  const maxTurn = p.maxTurn ?? 1.2;
  const cosMaxTurn = Math.cos(maxTurn);
  const sinMaxTurn = Math.sin(maxTurn);
  const dir = new Float32Array(maxNodes * 3);
  for (let i = 0; i < count; i++) {
    if (i === 0) {
      dir[0] = rootDir[0]; dir[1] = rootDir[1]; dir[2] = rootDir[2];
    } else {
      const q = parent[i];
      let dx = pos[i * 3] - pos[q * 3], dy = pos[i * 3 + 1] - pos[q * 3 + 1], dz = pos[i * 3 + 2] - pos[q * 3 + 2];
      const l = Math.hypot(dx, dy, dz) || 1;
      dir[i * 3] = dx / l; dir[i * 3 + 1] = dy / l; dir[i * 3 + 2] = dz / l;
    }
  }

  let newStart = 0;
  const maxIterations = p.maxIterations ?? 200;
  for (let iter = 0; iter < maxIterations && count < maxNodes; iter++) {
    // Update each live attractor's nearest node against the nodes added last
    // round only.
    for (let a = 0; a < m; a++) {
      if (!alive[a]) continue;
      const ax = p.attractors[a * 3], ay = p.attractors[a * 3 + 1], az = p.attractors[a * 3 + 2];
      let bd = bestDist[a], bn = bestNode[a];
      for (let n = newStart; n < count; n++) {
        const dx = ax - pos[n * 3], dy = ay - pos[n * 3 + 1], dz = az - pos[n * 3 + 2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bd) { bd = d; bn = n; }
      }
      bestDist[a] = bd; bestNode[a] = bn;
      if (bd < kill2) alive[a] = 0;
    }

    accX.fill(0, 0, count); accY.fill(0, 0, count); accZ.fill(0, 0, count); accN.fill(0, 0, count);
    let pulls = 0;
    for (let a = 0; a < m; a++) {
      if (!alive[a] || bestDist[a] > infl2) continue;
      const n = bestNode[a];
      if (n < 0) continue;
      let dx = p.attractors[a * 3] - pos[n * 3];
      let dy = p.attractors[a * 3 + 1] - pos[n * 3 + 1];
      let dz = p.attractors[a * 3 + 2] - pos[n * 3 + 2];
      const l = Math.hypot(dx, dy, dz) || 1;
      accX[n] += dx / l; accY[n] += dy / l; accZ[n] += dz / l;
      accN[n]++;
      pulls++;
    }
    if (pulls === 0) break;

    newStart = count;
    for (let n = 0; n < newStart && count < maxNodes; n++) {
      if (accN[n] === 0) continue;
      let dx = accX[n], dy = accY[n], dz = accZ[n];
      if (jitter > 0 && rng) {
        dx += (rng() - 0.5) * jitter;
        dy += (rng() - 0.5) * jitter;
        dz += (rng() - 0.5) * jitter;
      }
      const l = Math.hypot(dx, dy, dz);
      if (l < 1e-6) continue;
      dx /= l; dy /= l; dz /= l;
      // Limit the turn: project onto the cone of half-angle maxTurn about the
      // parent's direction.
      const pdx = dir[n * 3], pdy = dir[n * 3 + 1], pdz = dir[n * 3 + 2];
      const c = dx * pdx + dy * pdy + dz * pdz;
      if (c < cosMaxTurn) {
        let ex = dx - pdx * c, ey = dy - pdy * c, ez = dz - pdz * c;
        const el = Math.hypot(ex, ey, ez);
        if (el < 1e-6) { ex = pdx; ey = pdy; ez = pdz; }
        else { ex /= el; ey /= el; ez /= el; }
        dx = pdx * cosMaxTurn + ex * sinMaxTurn;
        dy = pdy * cosMaxTurn + ey * sinMaxTurn;
        dz = pdz * cosMaxTurn + ez * sinMaxTurn;
      }
      pos[count * 3] = pos[n * 3] + dx * p.step;
      pos[count * 3 + 1] = pos[n * 3 + 1] + dy * p.step;
      pos[count * 3 + 2] = pos[n * 3 + 2] + dz * p.step;
      dir[count * 3] = dx; dir[count * 3 + 1] = dy; dir[count * 3 + 2] = dz;
      parent[count] = n;
      count++;
    }
    if (count === newStart) break;
  }

  return { pos, parent, count, rootDir };
}

/**
 * Branch radii by Murray's law: a parent carries the cross-section of all its
 * children, which for a thickness exponent of about 2.4 gives
 * r = rLeaf * leafCount^0.42. Anything simpler (constant radius, or a linear
 * taper with depth) reads as wire rather than as a living skeleton, because
 * real branch thickness is set by transport, not by age.
 */
function skeletonRadii(skel, rLeaf, exponent = 0.42, rMax = Infinity) {
  const n = skel.count;
  const leaves = new Float32Array(n);
  const childCount = new Int32Array(n);
  for (let i = 1; i < n; i++) childCount[skel.parent[i]]++;
  for (let i = n - 1; i >= 0; i--) {
    if (childCount[i] === 0) leaves[i] = 1;
    if (skel.parent[i] >= 0) leaves[skel.parent[i]] += leaves[i];
  }
  const radius = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    radius[i] = Math.min(rMax, rLeaf * Math.pow(leaves[i], exponent));
  }
  return { radius, childCount, leaves };
}

/**
 * Loft a skeleton into generalised cylinders.
 *
 * Both children of a bifurcation are lofted from the SAME parent ring, which is
 * what makes the join smooth with no boolean and no gap: the fork is just two
 * bands sharing a base ring. Frames are parallel transported from parent to
 * child so a long branch does not corkscrew.
 *
 * @param {MeshBuilder} mb
 * @param {object} skel from growSkeleton
 * @param {Float32Array} radius per node
 * @param {object} opts {section, segments, upHint, tip, color, material,
 *   swayScale, swayHeight, boreInset, tipMaterial, tipColor}
 */
function meshSkeleton(mb, skel, radius, opts) {
  const n = skel.count;
  const section = opts.section || unitCircle(opts.segments || 5);
  const sec = (section.length / 2) | 0;
  const upHint = opts.upHint || null;
  const tip = opts.tip || 'apex';
  const color = opts.color || WHITE;
  const swayScale = opts.swayScale ?? 0;
  const mat = opts.material ?? MESH_MATERIAL.FLORA;
  mb.material = mat;

  let maxH = 1e-6;
  for (let i = 0; i < n; i++) maxH = Math.max(maxH, skel.pos[i * 3 + 1]);
  const swayHeight = opts.swayHeight ?? maxH;

  const dirs = new Float32Array(n * 3);
  const refs = new Float32Array(n * 3);
  const ringBase = new Int32Array(n);
  const childCount = new Int32Array(n);
  for (let i = 1; i < n; i++) childCount[skel.parent[i]]++;

  const vColor = Float32Array.of(color[0], color[1], color[2], 0);

  for (let i = 0; i < n; i++) {
    const par = skel.parent[i];
    if (par < 0) {
      vec3.copy(_d, skel.rootDir);
    } else {
      vec3.set(_d,
        skel.pos[i * 3] - skel.pos[par * 3],
        skel.pos[i * 3 + 1] - skel.pos[par * 3 + 1],
        skel.pos[i * 3 + 2] - skel.pos[par * 3 + 2]);
      if (vec3.sqrLen(_d) < 1e-18) vec3.set(_d, dirs[par * 3], dirs[par * 3 + 1], dirs[par * 3 + 2]);
      vec3.normalize(_d, _d);
    }
    dirs[i * 3] = _d[0]; dirs[i * 3 + 1] = _d[1]; dirs[i * 3 + 2] = _d[2];

    if (upHint) {
      vec3.cross(_u, upHint, _d);
      if (vec3.sqrLen(_u) < 1e-12) vec3.anyPerpendicular(_u, _d);
      vec3.normalize(_u, _u);
    } else if (par < 0) {
      vec3.anyPerpendicular(_u, _d);
    } else {
      vec3.set(_u, refs[par * 3], refs[par * 3 + 1], refs[par * 3 + 2]);
      const dp = vec3.dot(_u, _d);
      _u[0] -= _d[0] * dp; _u[1] -= _d[1] * dp; _u[2] -= _d[2] * dp;
      if (vec3.sqrLen(_u) < 1e-12) vec3.anyPerpendicular(_u, _d);
      else vec3.normalize(_u, _u);
    }
    refs[i * 3] = _u[0]; refs[i * 3 + 1] = _u[1]; refs[i * 3 + 2] = _u[2];
    vec3.cross(_v, _d, _u);

    const h = saturate(skel.pos[i * 3 + 1] / swayHeight);
    vColor[3] = swayScale * smoothstep(0, 1, h);
    ringBase[i] = mb.vertexCount;
    for (let k = 0; k < sec; k++) {
      const su = section[k * 2] * radius[i];
      const sv = section[k * 2 + 1] * radius[i];
      _p[0] = skel.pos[i * 3] + _u[0] * su + _v[0] * sv;
      _p[1] = skel.pos[i * 3 + 1] + _u[1] * su + _v[1] * sv;
      _p[2] = skel.pos[i * 3 + 2] + _u[2] * su + _v[2] * sv;
      const l = Math.hypot(su, sv) || 1;
      _n[0] = (_u[0] * su + _v[0] * sv) / l;
      _n[1] = (_u[1] * su + _v[1] * sv) / l;
      _n[2] = (_u[2] * su + _v[2] * sv) / l;
      _uv[0] = k / sec;
      _uv[1] = h;
      mb.addVertex(_p, _n, _uv, vColor);
    }
  }

  for (let i = 1; i < n; i++) {
    bridgeRings(mb, ringBase[skel.parent[i]], ringBase[i], sec, sec, false);
  }

  // Root disc, so the base is closed where it meets the substrate.
  {
    vec3.set(_d, dirs[0], dirs[1], dirs[2]);
    vec3.negate(_n, _d);
    vec3.set(_p, skel.pos[0], skel.pos[1], skel.pos[2]);
    _uv[0] = 0.5; _uv[1] = 0;
    vColor[3] = 0;
    const centre = mb.addVertex(_p, _n, _uv, vColor);
    for (let k = 0; k < sec; k++) {
      mb.addTriangle(centre, ringBase[0] + ((k + 1) % sec), ringBase[0] + k);
    }
  }

  if (tip === 'none') return;
  const inset = opts.boreInset ?? 0.06;
  // Tips can carry their own material and colour: a tuberod colony's glow lives
  // in the tube mouths, not along the tubes.
  if (opts.tipMaterial !== undefined) mb.material = opts.tipMaterial;
  if (opts.tipColor) {
    vColor[0] = opts.tipColor[0]; vColor[1] = opts.tipColor[1]; vColor[2] = opts.tipColor[2];
  }
  const tipColor = opts.tipColor || color;
  for (let i = 0; i < n; i++) {
    if (childCount[i] !== 0) continue;
    vec3.set(_d, dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2]);
    vec3.set(_u, refs[i * 3], refs[i * 3 + 1], refs[i * 3 + 2]);
    vec3.cross(_v, _d, _u);
    const h = saturate(skel.pos[i * 3 + 1] / swayHeight);
    vColor[0] = tipColor[0]; vColor[1] = tipColor[1]; vColor[2] = tipColor[2];
    vColor[3] = swayScale * smoothstep(0, 1, h);

    if (tip === 'apex') {
      _p[0] = skel.pos[i * 3] + _d[0] * radius[i];
      _p[1] = skel.pos[i * 3 + 1] + _d[1] * radius[i];
      _p[2] = skel.pos[i * 3 + 2] + _d[2] * radius[i];
      _uv[0] = 0.5; _uv[1] = h;
      const apex = mb.addVertex(_p, _d, _uv, vColor);
      for (let k = 0; k < sec; k++) {
        mb.addTriangle(ringBase[i] + k, ringBase[i] + ((k + 1) % sec), apex);
      }
    } else {
      // Open mouth: an annular rim folded back into a short bore with a floor.
      const rimBase = mb.vertexCount;
      for (let k = 0; k < sec; k++) {
        const su = section[k * 2] * radius[i] * 0.58;
        const sv = section[k * 2 + 1] * radius[i] * 0.58;
        _p[0] = skel.pos[i * 3] + _u[0] * su + _v[0] * sv;
        _p[1] = skel.pos[i * 3 + 1] + _u[1] * su + _v[1] * sv;
        _p[2] = skel.pos[i * 3 + 2] + _u[2] * su + _v[2] * sv;
        _n[0] = _d[0]; _n[1] = _d[1]; _n[2] = _d[2];
        _uv[0] = k / sec; _uv[1] = h;
        mb.addVertex(_p, _n, _uv, vColor);
      }
      const floorBase = mb.vertexCount;
      for (let k = 0; k < sec; k++) {
        const su = section[k * 2] * radius[i] * 0.52;
        const sv = section[k * 2 + 1] * radius[i] * 0.52;
        _p[0] = skel.pos[i * 3] + _u[0] * su + _v[0] * sv - _d[0] * inset;
        _p[1] = skel.pos[i * 3 + 1] + _u[1] * su + _v[1] * sv - _d[1] * inset;
        _p[2] = skel.pos[i * 3 + 2] + _u[2] * su + _v[2] * sv - _d[2] * inset;
        const l = Math.hypot(su, sv) || 1;
        _n[0] = -(_u[0] * su + _v[0] * sv) / l;
        _n[1] = -(_u[1] * su + _v[1] * sv) / l;
        _n[2] = -(_u[2] * su + _v[2] * sv) / l;
        _uv[0] = k / sec; _uv[1] = h;
        mb.addVertex(_p, _n, _uv, vColor);
      }
      // The rim annulus sweeps radially INWARD at a constant axial position, so
      // its winding is the ordinary tube handedness and it faces +dir; the bore
      // wall then sweeps backwards along -dir, and the same handedness turns its
      // normals inward, which is what an interior wall needs.
      bridgeRings(mb, ringBase[i], rimBase, sec, sec, false);
      bridgeRings(mb, rimBase, floorBase, sec, sec, false);
      _p[0] = skel.pos[i * 3] - _d[0] * inset;
      _p[1] = skel.pos[i * 3 + 1] - _d[1] * inset;
      _p[2] = skel.pos[i * 3 + 2] - _d[2] * inset;
      _uv[0] = 0.5; _uv[1] = h;
      const floorCentre = mb.addVertex(_p, _d, _uv, vColor);
      for (let k = 0; k < sec; k++) {
        mb.addTriangle(floorCentre, floorBase + k, floorBase + ((k + 1) % sec));
      }
    }
  }

  // The ring normals above are exact for a straight member, but at a fork both
  // children are lofted from the parent's ring, so the band leaves that ring at
  // an angle the parent's radial normal knows nothing about. Re-deriving from
  // the faces is what stops the shading turning inside out on the first
  // centimetre of every branch.
  if (opts.recomputeNormals !== false) mb.computeSmoothNormals(1.45);
}

/**
 * Halton attractor cloud in a squashed hemisphere (y >= yMin), radius 1.
 * The Cranley-Patterson rotation by three per-seed offsets keeps the low
 * discrepancy of the sequence while making every seed a different cloud.
 */
function hemisphereAttractors(count, squashY, yMin, rng) {
  const out = new Float32Array(count * 3);
  const ox = rng(), oy = rng(), oz = rng();
  let written = 0;
  for (let i = 1; written < count && i < count * 40; i++) {
    const a = (radicalInverse(i, 2) + ox) % 1;
    const b = (radicalInverse(i, 3) + oy) % 1;
    const c = (radicalInverse(i, 5) + oz) % 1;
    const x = a * 2 - 1, y = b, z = c * 2 - 1;
    const ys = y / squashY;
    if (x * x + ys * ys + z * z > 1 || y < yMin) continue;
    out[written * 3] = x; out[written * 3 + 1] = y; out[written * 3 + 2] = z;
    written++;
  }
  return written === count ? out : out.subarray(0, written * 3);
}

/** Halton attractor cloud in a cylinder of radius 1 and height 1. */
function cylinderAttractors(count, rng) {
  const out = new Float32Array(count * 3);
  const ox = rng(), oy = rng(), oz = rng();
  let written = 0;
  for (let i = 1; written < count && i < count * 40; i++) {
    const a = (radicalInverse(i, 2) + ox) % 1;
    const b = (radicalInverse(i, 3) + oy) % 1;
    const c = (radicalInverse(i, 5) + oz) % 1;
    const x = a * 2 - 1, z = c * 2 - 1;
    if (x * x + z * z > 1) continue;
    out[written * 3] = x; out[written * 3 + 1] = 0.12 + b * 0.88; out[written * 3 + 2] = z;
    written++;
  }
  return written === count ? out : out.subarray(0, written * 3);
}

// ===========================================================================
// Swept flora - kelp, grass, fronds
// ===========================================================================

/**
 * Rescale a built mesh's sway weights into [lo, hi].
 *
 * A blade grafted onto a stipe cannot start from sway 0: its root moves with
 * whatever part of the stem it hangs from, and starting it at 0 pins the blade
 * root in place while the stem swings out from under it.
 */
function remapSway(mesh, lo, hi) {
  for (let i = 0; i < mesh.vertexCount; i++) {
    const o = i * 4 + 3;
    mesh.colors[o] = lo + (hi - lo) * mesh.colors[o];
  }
  return mesh;
}

/**
 * Fill a blade/stem polyline that starts at (ox, oy, oz) pointing up and
 * rotates toward the horizontal by `curl` radians along its length, on the
 * azimuth `az`. Integrating a unit tangent means the polyline's arc length is
 * exactly `length` whatever the curl, so a blade never shrinks as it bends.
 */
function fillCurvedSpline(path, stations, ox, oy, oz, az, length, curl, wobble, noiseSeed) {
  const ca = Math.cos(az), sa = Math.sin(az);
  const step = length / (stations - 1);
  let x = ox, y = oy, z = oz;
  path[0] = x; path[1] = y; path[2] = z;
  for (let i = 1; i < stations; i++) {
    const t = (i - 0.5) / (stations - 1);
    // t^1.3 keeps the base near-vertical and puts the bend in the outer half,
    // which is how a blade anchored in sediment actually loads.
    const ang = curl * Math.pow(t, 1.3);
    const s = Math.sin(ang), c = Math.cos(ang);
    const w = wobble > 0 ? simplex2(t * 3.1, noiseSeed * 0.017, noiseSeed) * wobble : 0;
    x += (s * ca - sa * w) * step;
    y += c * step;
    z += (s * sa + ca * w) * step;
    path[i * 3] = x; path[i * 3 + 1] = y; path[i * 3 + 2] = z;
  }
  return path;
}

/**
 * Ribbonkelp-class stipe with strap blades.
 *
 * The stipe is a circle swept along a leaning helix; the blades are thin lens
 * sections swept along curls that trail off it. Every vertex carries the 0..1
 * height along the stalk in BOTH uv.y and colour.w, which is what
 * DESIGN/02 10.2's vertex animation bends with the current - so this mesh sways
 * without a bone, a texture or a second draw.
 *
 * Float bladders are a local bulge in the stipe radius rather than merged
 * spheres: at the distance kelp is ever seen the silhouette is identical and it
 * costs zero extra vertices.
 *
 * Vertices: about 800 (HIGH), 340 (MEDIUM), 120 (LOW).
 *
 * @param {number} seed
 * @param {number} [height] stipe length in metres
 * @param {number} [blades] strap blade count
 * @param {object} [opts] {detail, color, bladeColor}
 */
export function generateKelp(seed, height = 9.5, blades = 18, opts = {}) {
  return buildKelp(seed, height, blades, opts, MESH_ASSET.KELP, {
    stations: [8, 14, 22], section: [4, 5, 6], bladeStations: [5, 7, 9],
    baseRadius: 0.075, leanAmp: 0.9, twistTurns: 0.55,
    bladeLength: 0.26, bladeWidth: 0.26, bladderSpacing: 0.55, bladderAmp: 0.28,
    canopy: 0,
  });
}

/**
 * Giant ribbonkelp: the 22 m stipes of biome 10, whose top few metres bend over
 * into a floating surface canopy. The canopy is geometry, not a trick - it is
 * the reason the forest hides the sky, and a vertical stipe with a flat top
 * cannot do that.
 *
 * Vertices: about 1130 (HIGH), 470 (MEDIUM), 160 (LOW).
 *
 * @param {number} seed
 * @param {number} [height] stipe length in metres
 * @param {number} [blades]
 * @param {object} [opts] {detail, color, bladeColor}
 */
export function generateGiantKelp(seed, height = 22, blades = 24, opts = {}) {
  return buildKelp(seed, height, blades, opts, MESH_ASSET.GIANT_KELP, {
    stations: [10, 18, 30], section: [4, 5, 6], bladeStations: [5, 7, 9],
    // The old 11 cm / 13.5 cm ribbon was a smooth green pole at range. These
    // proportions make the stipe read as a braided organism and give the crown
    // enough blade area to form a ceiling, without changing the generator's
    // world-space height contract.
    baseRadius: 0.18, leanAmp: 1.6, twistTurns: 0.85,
    bladeLength: 0.21, bladeWidth: 0.58, bladderSpacing: 0.9, bladderAmp: 0.34,
    canopy: 0.14,
  });
}

/**
 * Shared kelp construction. See generateKelp / generateGiantKelp for the API.
 *
 * Four opts landed with the 2026-08-18 emerald rebuild (ref
 * SCR-20260801-gooy), all defaulting to the historical values so an
 * unauthored row emits byte-identical geometry:
 *   girth     multiplies the stipe/branch radius AND the fruit berry size
 *             (the berry is authored in stipe units on purpose - a thick
 *             trunk carries melon fruit, a whip carries grapes);
 *   bladeLen  multiplies k.bladeLength - longer fronds;
 *   bladeWide multiplies k.bladeWidth - fuller fronds;
 *   fruitLo   the bottom of the fruit band as a stipe fraction (0.72
 *             historical: crown-only). The reference stalks carry clusters
 *             at MULTIPLE heights, which is what lowering it buys.
 *   crown     EXTRA blades gathered at t 0.78-0.98, 1.35x length, droopier
 *             than the spiral blades (0 historical). The reference plants
 *             are heaviest at the TIP - a rich drooping head - and the band
 *             weighting alone leaves the head readable as "a stick with a
 *             few stems" (playtest wording). Consumes rng only when > 0, so
 *             an unauthored row stays byte-identical.
 */
function buildKelp(seed, height, bladeCount, opts, asset, k) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const girth = opts.girth ?? 1;
  const bladeLen = opts.bladeLen ?? 1;
  const bladeWide = opts.bladeWide ?? 1;
  const fruitLo = opts.fruitLo ?? 0.72;
  const crown = opts.crown ?? 0;
  const rng = assetRng(seed, asset);
  const ns = assetNoiseSeed(seed, asset);
  const stations = byDetail(detail, k.stations[0], k.stations[1], k.stations[2]);
  const sectionN = byDetail(detail, k.section[0], k.section[1], k.section[2]);
  const bladeStations = byDetail(detail, k.bladeStations[0], k.bladeStations[1], k.bladeStations[2]);
  const nBlades = Math.max(1, Math.round(bladeCount * byDetail(detail, 0.25, 0.55, 1)));
  const phase = rng() * TAU;
  const leanAmp = k.leanAmp * lerp(0.7, 1.3, rng());
  const twist = k.twistTurns * TAU * lerp(0.7, 1.3, rng());

  const stemColor = opts.color || MESH_PALETTE.KELP_BROWN;
  const bladeColor = opts.bladeColor || MESH_PALETTE.KELP_BLADE;

  // Stipe path. The canopy fraction bends the top toward the horizontal so the
  // last metres lie along the surface instead of spearing through it.
  const path = new Float32Array(stations * 3);
  for (let i = 0; i < stations; i++) {
    const t = i / (stations - 1);
    const lean = leanAmp * t * t;
    const th = twist * t + phase;
    let y = t * height;
    if (k.canopy > 0 && t > 1 - k.canopy) {
      const ct = (t - (1 - k.canopy)) / k.canopy;
      // Trade vertical progress for horizontal reach across the canopy band.
      y = (1 - k.canopy) * height + k.canopy * height * (1 - ct * ct) * 0.35;
    }
    path[i * 3] = Math.cos(th) * lean;
    path[i * 3 + 1] = y;
    path[i * 3 + 2] = Math.sin(th) * lean;
  }
  if (k.canopy > 0) {
    // Push the canopy stations outward along their own azimuth so the bend has
    // somewhere to go.
    for (let i = 0; i < stations; i++) {
      const t = i / (stations - 1);
      if (t <= 1 - k.canopy) continue;
      const ct = (t - (1 - k.canopy)) / k.canopy;
      const th = twist * t + phase;
      const reach = k.canopy * height * ct * 1.6;
      path[i * 3] += Math.cos(th) * reach;
      path[i * 3 + 2] += Math.sin(th) * reach;
    }
  }

  const bladderPeriod = Math.max(0.2, k.bladderSpacing) / Math.max(height, 1e-3);
  const stem = extrudeAlongSpline(unitCircle(sectionN), path, twist * 0.35, 0.28, {
    radius: k.baseRadius * girth,
    color: stemColor,
    material: MESH_MATERIAL.FLORA,
    scaleFn: (t) => {
      const base = (1 - 0.72 * t) * (1 + 0.18 * simplex2(t * 9, 0, ns));
      // Pneumatocysts: a narrow gaussian bump at each spacing interval.
      const ph = (t / bladderPeriod) % 1;
      const d = Math.min(ph, 1 - ph) / 0.22;
      const bladder = k.bladderAmp * Math.exp(-d * d * 2.2);
      return base * (1 + bladder);
    },
  });

  const mb = new MeshBuilder(stem.vertexCount + nBlades * bladeStations * 4 + 64,
    stem.indexCount + nBlades * bladeStations * 24);
  mb.merge(stem);

  // ---- BANDS, SECONDARY STIPES AND FRUIT ---------------------------------
  // The three knobs item 3.4 adds, all optional and all off by default, so an
  // unauthored row emits byte-identical geometry. They exist because the
  // reference frame this biome is authored against is not a uniform spiral of
  // blades on a bare pole: it is a braided stalk running past the top of the
  // frame with a DROOPING CROWN of blades at its head, glowing fruit clustered
  // at that crown, and one or two branch stipes leaving the main one.
  const bands = opts.bands ?? k.bands ?? 0;
  const secondary = opts.secondary ?? k.secondary ?? 0;
  const fruit = opts.fruit ?? k.fruit ?? 0;

  const bladePath = new Float32Array(bladeStations * 3);
  const bladeSection = lensSection(0.16);
  for (let b = 0; b < nBlades; b++) {
    // Blades start above the holdfast and spiral up the stipe - unless `bands`
    // is set, in which case they gather into that many clusters with the TOP one
    // weighted heaviest. `u^0.42` is what puts roughly half the blades in the
    // upper third: a uniform spiral gives an evenly furred pole, and what the
    // reference shows is a bare braided stalk under a crown.
    const u = (b + 0.5) / nBlades;
    let t;
    if (bands > 0) {
      const band = Math.min(bands - 1, Math.floor(Math.pow(u, 0.42) * bands));
      const within = (b % 3) / 3;
      t = lerp(0.20, 0.98, (band + 0.15 + within * 0.7) / bands);
    } else {
      t = lerp(0.18, 0.99, u);
    }
    const si = clamp(Math.round(t * (stations - 1)), 0, stations - 1);
    const az = (b / nBlades) * TAU * 2.4 + phase;
    const attachSway = smoothstep(0, 1, t);
    const len = height * k.bladeLength * bladeLen * lerp(0.7, 1.25, rng());
    // Strap blades stream nearly horizontally in any current, so the curl is
    // large; the highest blades curl least because they are in the canopy.
    // A heavier, droopier crown: the outer half turns farther toward the
    // horizontal than the old narrow ribbons, while the top remains readable
    // as a head rather than a second straight stipe.
    const curl = lerp(1.50, 0.95, t) * lerp(0.85, 1.2, rng());
    fillCurvedSpline(bladePath, bladeStations,
      path[si * 3], path[si * 3 + 1], path[si * 3 + 2],
      az, len, curl, 0.10, ns + b);
    const blade = extrudeAlongSpline(bladeSection, bladePath, 0.35, 0.35, {
      radius: k.bladeWidth * bladeWide * 0.5 * lerp(0.8, 1.2, rng()),
      color: bladeColor,
      material: MESH_MATERIAL.TRANSLUCENT,
      upHint: null,
    });
    mb.merge(remapSway(blade, attachSway, 1));
  }

  // ---- crown blades ------------------------------------------------------
  // Extra blades gathered at the head - see the opts note above. Longer and
  // droopier than the spiral blades: the head reads as a heavy frond mop
  // rather than a tip that simply runs out of stipe.
  if (crown > 0) {
    const crownN = Math.max(1, Math.round(crown * byDetail(detail, 0.25, 0.55, 1)));
    for (let b = 0; b < crownN; b++) {
      const t = lerp(0.78, 0.98, (b + 0.5) / crownN);
      const si = clamp(Math.round(t * (stations - 1)), 0, stations - 1);
      const az = phase + 1.7 + b * 2.399963;
      const len = height * k.bladeLength * bladeLen * 1.35 * lerp(0.85, 1.2, rng());
      // High curl: the head's blades turn well past horizontal and hang.
      const curl = lerp(1.35, 1.75, rng());
      fillCurvedSpline(bladePath, bladeStations,
        path[si * 3], path[si * 3 + 1], path[si * 3 + 2],
        az, len, curl, 0.12, ns + 517 + b);
      const blade = extrudeAlongSpline(bladeSection, bladePath, 0.35, 0.35, {
        radius: k.bladeWidth * bladeWide * 0.55 * lerp(0.85, 1.2, rng()),
        color: bladeColor,
        material: MESH_MATERIAL.TRANSLUCENT,
        upHint: null,
      });
      mb.merge(remapSway(blade, smoothstep(0, 1, t), 1));
    }
  }

  // ---- secondary stipes --------------------------------------------------
  // A branch that leaves the main stipe and carries its own short crown. It is
  // a real fork rather than a second plant merged nearby, so the silhouette
  // reads as ONE organism with two heads - which is what stops a dense bed
  // looking like a field of identical poles.
  for (let s2 = 0; s2 < secondary; s2++) {
    const t0 = lerp(0.34, 0.66, (s2 + 0.5) / Math.max(secondary, 1));
    const si = clamp(Math.round(t0 * (stations - 1)), 0, stations - 1);
    const az = phase + s2 * 2.399963 + rng() * 0.8;
    const len = height * lerp(0.30, 0.52, rng());
    const branchStations = Math.max(4, Math.round(stations * 0.55));
    const bpath = new Float32Array(branchStations * 3);
    // The branch leans away and then straightens: `curl` is the lean, and it is
    // smaller than a blade's because a stipe is stiff.
    fillCurvedSpline(bpath, branchStations,
      path[si * 3], path[si * 3 + 1], path[si * 3 + 2],
      az, len, lerp(0.35, 0.70, rng()), 0.06, ns + 71 + s2);
    const branch = extrudeAlongSpline(unitCircle(sectionN), bpath, twist * 0.2, 0.30, {
      radius: k.baseRadius * girth * lerp(0.42, 0.62, rng()),
      color: stemColor,
      material: MESH_MATERIAL.FLORA,
    });
    mb.merge(remapSway(branch, smoothstep(0, 1, t0), 1));

    // 0.15 and not 0.22, and the constraint is real rather than cosmetic:
    // kelpGiant's `maxPerChunk` is 190, so its vertex count is the one in the
    // whole flora band that a chunk can actually multiply out - 190 x 1,485 is
    // 282,000 vertices from one row. A branch carries a token crown, not a
    // second full one.
    const perBranch = Math.max(1, Math.round(nBlades * 0.15));
    for (let b = 0; b < perBranch; b++) {
      const bt = lerp(0.45, 0.98, (b + 0.5) / perBranch);
      const bi = clamp(Math.round(bt * (branchStations - 1)), 0, branchStations - 1);
      fillCurvedSpline(bladePath, bladeStations,
        bpath[bi * 3], bpath[bi * 3 + 1], bpath[bi * 3 + 2],
        az + b * 2.399963, height * k.bladeLength * bladeLen * lerp(0.55, 0.95, rng()),
        lerp(1.0, 0.7, bt), 0.10, ns + 131 + s2 * 8 + b);
      const blade = extrudeAlongSpline(bladeSection, bladePath, 0.35, 0.35, {
        radius: k.bladeWidth * bladeWide * 0.42 * lerp(0.8, 1.2, rng()),
        color: bladeColor,
        material: MESH_MATERIAL.TRANSLUCENT,
        upHint: null,
      });
      mb.merge(remapSway(blade, smoothstep(0, 1, t0 + bt * 0.2), 1));
    }
  }

  // ---- fruit -------------------------------------------------------------
  // Clustered at the CROWN, because that is where the reference puts them and
  // because a light source at the top of a 30 m plant is what makes a forest
  // read as having a ceiling. BIOLUMINESCENT, NOT FLUORESCENT: COASTAL_GREEN's
  // blue daylight is at 1% by 25 m and cannot pump anything at the depths this
  // grows at, so the row that carries fruit must author `fluoresces: false` or
  // the glow is switched off by the water it lives in.
  if (fruit > 0) {
    // icosphere(0) - 12 vertices - at EVERY tier. Subdivision 1 costs 42 and
    // buys a silhouette nothing at kelp range can resolve, and ten of them is
    // the difference between a champion fitting its budget band and not. The
    // radius went 1.5 -> 1.9 x baseRadius (2026-08 fruit pass): at 1.5 the
    // biggest berry was 53 cm across and the cluster read as pale dots at the
    // 20-40 m a crown is seen from; the reference's fruit bunches are melons.
    const berry = icosphere(0, k.baseRadius * girth * 1.9, {
      color: opts.fruitColor || MESH_PALETTE.KELP_FRUIT,
      material: MESH_MATERIAL.EMISSIVE,
    });
    const q = Float32Array.of(0, 0, 0, 1);
    const trans = vec3.create();
    const sc = vec3.create();
    const xf = new Float32Array(16);
    const n = Math.max(2, Math.round(fruit * byDetail(detail, 0.4, 0.7, 1)));
    for (let f = 0; f < n; f++) {
      const t = lerp(fruitLo, 0.99, (f + 0.5) / n);
      const si = clamp(Math.round(t * (stations - 1)), 0, stations - 1);
      const az = phase + f * 2.399963;
      // Tighter to the stipe than the first cut (2.2-5.5): the reference
      // cluster is a bunch AROUND the stalk, not a spray of single berries.
      const rad = k.baseRadius * girth * lerp(1.8, 4.4, rng());
      vec3.set(trans,
        path[si * 3] + Math.cos(az) * rad,
        path[si * 3 + 1] + (rng() - 0.5) * height * 0.03,
        path[si * 3 + 2] + Math.sin(az) * rad);
      const s = lerp(0.95, 1.8, rng());
      vec3.set(sc, s, s * 0.86, s);
      buildTRS(xf, q, trans, sc);
      const before = mb.vertexCount;
      mb.merge(berry, xf);
      // Fruit hangs at the crown, so it sways with the crown rather than with
      // the holdfast; without this it is the one part of the plant that stands
      // still while everything around it moves.
      mb.setSwayRange(before, mb.vertexCount - before, smoothstep(0, 1, t));
    }
  }
  return finish(mb);
}

/**
 * A tuft of crossed ribbon blades from a shared root: the shape behind
 * siltgrass meadows, quillgrass and shore grass.
 *
 * @param {number} seed
 * @param {number} height metres
 * @param {number} bladeCount
 * @param {number} asset MESH_ASSET id, for the RNG salt
 * @param {object} k {stations, width, curl, curlJitter, thickness, spread,
 *   heightJitter, material, color, swayExponent}
 * @param {object} opts {detail, color}
 */
function buildTuft(seed, height, bladeCount, asset, k, opts) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, asset);
  const ns = assetNoiseSeed(seed, asset);
  const stations = byDetail(detail, 3, 4, k.stations);
  const n = Math.max(1, Math.round(bladeCount * byDetail(detail, 0.45, 0.7, 1)));
  const color = opts.color || k.color;
  const section = lensSection(k.thickness);
  const path = new Float32Array(stations * 3);
  const mb = new MeshBuilder(n * stations * 4 + n * 2, n * stations * 24);

  for (let b = 0; b < n; b++) {
    // Golden-angle azimuth: a tuft of 7 blades placed on a uniform grid reads
    // as a fan, and one placed at random has visible clumps.
    const az = b * 2.399963 + rng() * 0.5;
    const r = k.spread * Math.sqrt((b + 0.4) / n);
    const len = height * lerp(1 - k.heightJitter, 1 + k.heightJitter, rng());
    const curl = k.curl * lerp(1 - k.curlJitter, 1 + k.curlJitter, rng());
    fillCurvedSpline(path, stations,
      Math.cos(az) * r, 0, Math.sin(az) * r,
      az, len, curl, 0.08, ns + b * 7);
    const blade = extrudeAlongSpline(section, path, 0.25, 0.18, {
      radius: k.width * 0.5,
      color,
      material: k.material,
      swayExponent: k.swayExponent ?? 1,
    });
    mb.merge(blade);
  }
  return finish(mb);
}

/**
 * Siltgrass-class seagrass tuft: soft, wide-curling blades that bend in unison
 * with the surge.
 *
 * Vertices: about 190 (HIGH), 120 (MEDIUM), 65 (LOW).
 *
 * @param {number} seed
 * @param {number} [height] metres
 * @param {number} [blades]
 * @param {object} [opts] {detail, color}
 */
export function generateSeagrass(seed, height = 0.7, blades = 7, opts = {}) {
  return buildTuft(seed, height, blades, MESH_ASSET.SEAGRASS, {
    stations: 6, width: 0.030, curl: 1.05, curlJitter: 0.45, thickness: 0.14,
    spread: 0.045, heightJitter: 0.35, material: MESH_MATERIAL.TRANSLUCENT,
    color: MESH_PALETTE.SEAGRASS, swayExponent: 0.85,
  }, opts);
}

/**
 * Quillgrass-class shore grass: stiff, narrow, nearly upright quills for the
 * island's plateau and beach fringe. Stiffer means a smaller curl and a
 * squared sway exponent, so wind moves the tips and leaves the base alone.
 *
 * Vertices: about 230 (HIGH), 150 (MEDIUM), 80 (LOW).
 *
 * @param {number} seed
 * @param {number} [height] metres
 * @param {number} [blades]
 * @param {object} [opts] {detail, color}
 */
export function generateShoreGrass(seed, height = 1.35, blades = 9, opts = {}) {
  return buildTuft(seed, height, blades, MESH_ASSET.SHORE_GRASS, {
    stations: 6, width: 0.022, curl: 0.42, curlJitter: 0.6, thickness: 0.35,
    spread: 0.075, heightJitter: 0.4, material: MESH_MATERIAL.FLORA,
    color: MESH_PALETTE.SHORE_GRASS, swayExponent: 2,
  }, opts);
}

/**
 * Bloodgrass-class meadow tuft: the crimson carpet of the Crimson Meadow, and
 * the crown growth on its rock pillars via the plume row's colour override.
 *
 * Broader and softer than siltgrass - wider blades, a thicker lens section and
 * a lower sway exponent, so the carpet rolls with the surge instead of
 * flickering. The colour does all the biome's work and it is a REFLECTANCE:
 * vibrancy comes from cutting green/blue, never from emission (AgX shoulder:
 * brighter = whiter) and never from raising red above 1.
 *
 * Vertices: about 350 (HIGH), 170 (MEDIUM), 85 (LOW).
 *
 * @param {number} seed
 * @param {number} [height] metres
 * @param {number} [blades]
 * @param {object} [opts] {detail, color}
 */
export function generateBloodGrass(seed, height = 0.5, blades = 58, opts = {}) {
  // One instance is a PATCH, not a point tuft: the roots scatter over a
  // 0.62 m radius so ~3,600 instances per chunk close into a continuous
  // field (58 blades: 21 verts each puts 60 at 1,260, ten over the flora
  // band ceiling of 1,250). The delivered carpet read pink until this changed - sub-pixel
  // blades average against whatever is behind them, and only
  // grass-behind-grass reads red. The 0.5 m / 60-blade turf replaced a
  // 0.7 m / 40-blade one whose frames read as long thin strands over
  // >= 50% bare ground; the reference is short dense layered turf.
  // Stations 4 pays for the blade count: the budget is verts times
  // instances, and this row ships thousands per chunk.
  return buildTuft(seed, height, blades, MESH_ASSET.BLOOD_GRASS, {
    // FLORA, not TRANSLUCENT: the translucent slot is glossier (roughness
    // 0.62 vs 0.70) and passes 85% of the backlight, and both read as hot
    // pink glints on a crimson carpet under a blue column. The reference
    // blades are matte and near opaque.
    stations: 4, width: 0.030, curl: 0.85, curlJitter: 0.45, thickness: 0.16,
    spread: 0.62, heightJitter: 0.5, material: MESH_MATERIAL.FLORA,
    color: MESH_PALETTE.BLOOD_GRASS, swayExponent: 0.9,
  }, opts);
}

/**
 * Ashfern-class frond: an arching stem carrying paired leaflets down its upper
 * length. Used on the island for ashfern and on the seabed for veil moss
 * fringes, with different colours.
 *
 * Vertices: about 330 (HIGH), 180 (MEDIUM), 90 (LOW).
 *
 * @param {number} seed
 * @param {number} [height] metres
 * @param {object} [opts] {detail, color, leafColor, leaflets|fronds}
 */
export function generateAlienFrond(seed, height = 0.85, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, MESH_ASSET.ALIEN_FROND);
  const ns = assetNoiseSeed(seed, MESH_ASSET.ALIEN_FROND);
  const stations = byDetail(detail, 5, 8, 11);
  const pairs = Math.max(1, Math.round(
    (opts.leaflets ?? opts.fronds ?? 6) * byDetail(detail, 0.4, 0.7, 1)));
  const leafStations = byDetail(detail, 3, 4, 5);
  const az = rng() * TAU;

  const stemPath = new Float32Array(stations * 3);
  fillCurvedSpline(stemPath, stations, 0, 0, 0, az, height, lerp(0.55, 1.0, rng()), 0.05, ns);
  const stem = extrudeAlongSpline(unitCircle(4), stemPath, 0, 0.25, {
    radius: height * 0.022,
    color: opts.color || MESH_PALETTE.FROND_OLIVE,
    material: MESH_MATERIAL.FLORA,
  });

  const mb = new MeshBuilder(stem.vertexCount + pairs * 2 * leafStations * 4 + 32,
    stem.indexCount + pairs * 2 * leafStations * 24);
  mb.merge(stem);

  const leafPath = new Float32Array(leafStations * 3);
  const leafSection = lensSection(0.20);
  const leafColor = opts.leafColor || MESH_PALETTE.FROND_OLIVE;
  for (let i = 0; i < pairs; i++) {
    const t = lerp(0.24, 0.96, (i + 0.5) / pairs);
    const si = clamp(Math.round(t * (stations - 1)), 0, stations - 1);
    // Leaflets shorten toward the tip, which is what makes a frond read as a
    // frond rather than as a bottle brush.
    const len = height * lerp(0.34, 0.10, t) * lerp(0.85, 1.15, rng());
    for (let side = -1; side <= 1; side += 2) {
      // Perpendicular to the stem's own azimuth, angled up and forward.
      const lAz = az + side * (PI * 0.5) * lerp(0.7, 1.0, rng());
      fillCurvedSpline(leafPath, leafStations,
        stemPath[si * 3], stemPath[si * 3 + 1], stemPath[si * 3 + 2],
        lAz, len, lerp(1.0, 1.5, rng()), 0.06, ns + i * 13 + (side + 1));
      const leaf = extrudeAlongSpline(leafSection, leafPath, 0.2, 0.12, {
        radius: len * 0.30,
        color: leafColor,
        material: MESH_MATERIAL.TRANSLUCENT,
      });
      mb.merge(remapSway(leaf, smoothstep(0, 1, t), 1));
    }
  }
  return finish(mb);
}

// ===========================================================================
// Corals and sponges
// ===========================================================================

/**
 * 3D Worley F2 - F1: bright cell borders, in [0, ~1].
 *
 * noise.js exports the 2D edge function and the 3D F1, but not this. It is
 * needed here rather than the 2D version because DESIGN/02 10.3's groove field
 * is quoted on a SPHERICAL UV, and a 2D lattice sampled on spherical uv has a
 * visible seam down the u wrap and a pinch at both poles. Evaluating the same
 * cellular field in 3D on the surface direction has neither.
 */
function worley3Edge(x, y, z, seed, jitter = 1) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let f1 = Infinity, f2 = Infinity;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx, cy = yi + dy, cz = zi + dz;
        // Same feature-point hash as worley3F1 in noise.js, so the two agree.
        const h = hash2i(hash2i(cx, cy), cz ^ seed);
        const h2 = hash2i(hash2i(cz, cx), seed);
        const px = cx + 0.5 + (((h & 0x3ff) / 1023) - 0.5) * jitter;
        const py = cy + 0.5 + ((((h >>> 10) & 0x3ff) / 1023) - 0.5) * jitter;
        const pz = cz + 0.5 + (((h2 & 0x3ff) / 1023) - 0.5) * jitter;
        const ddx = px - x, ddy = py - y, ddz = pz - z;
        const d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
      }
    }
  }
  return saturate(f2 - f1);
}

/**
 * Brain / plate coral: a squashed dome whose radius is pushed out on the ridges
 * of a cellular field and pulled in along its cell borders, which is what makes
 * the meandering groove pattern. Undercut past the equator so it reads as a
 * boulder of living rock sitting on the seabed rather than as half a ball.
 *
 * Vertices: 630 (HIGH), 250 (MEDIUM), 100 (LOW).
 * Triangles: 1120 / 432 / 160.
 *
 * @param {number} seed
 * @param {number} [radius] metres
 * @param {object} [opts] {detail, color, grooveFrequency|folds, grooveDepth}
 */
export function generateCoralBrain(seed, radius = 0.55, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, MESH_ASSET.CORAL_BRAIN);
  const ns = assetNoiseSeed(seed, MESH_ASSET.CORAL_BRAIN);
  const seg = byDetail(detail, 12, 20, 40);
  const rings = byDetail(detail, 6, 10, 20);
  const stride = seg + 1;
  const squashY = lerp(0.52, 0.74, rng());
  // The groove frequency is bounded by the tessellation, not by taste: at 40
  // segments the ring spacing is 0.157 rad, and a cell narrower than four
  // vertices produces aliased speckle instead of a valley. 5.5 puts roughly five
  // vertices across each groove.
  // `folds` is the scatter table's name for the same quantity - how many
  // convolutions run across the dome - and it is what makes one brain coral
  // record differ from another. It was a dead key in the type table for as long
  // as the table has existed.
  const freq = opts.grooveFrequency ?? opts.folds ?? lerp(4.8, 6.2, rng());
  // 0.11 is the deepest groove that never cusps: swept over 40 seeds x 3 tiers x
  // frequencies 3.5 to 5.5, 0.13 produced the occasional back-facing lip and 0.16
  // produced them at every frequency.
  const depth = opts.grooveDepth ?? 0.11;
  // Past 90 degrees the dome tucks back under itself, giving the overhang lip
  // that catches light along the base.
  const sweep = PI * 0.56;

  const mb = new MeshBuilder(stride * (rings + 1) + seg + 2, seg * rings * 6 + seg * 3);
  mb.material = MESH_MATERIAL.ROCK;
  const color = optColor({ color: opts.color || MESH_PALETTE.CORAL_CREAM });

  const base = mb.vertexCount;
  for (let i = 0; i <= rings; i++) {
    const v = i / rings;
    const phi = v * sweep;
    const cy = Math.cos(phi), sy = Math.sin(phi);
    for (let j = 0; j <= seg; j++) {
      const uu = j / seg;
      const th = uu * TAU;
      const dx = sy * Math.cos(th), dy = cy, dz = sy * Math.sin(th);
      // A LINEAR ramp on the cell-edge distance, not DESIGN/02 10.3's
      // smoothstep(0.02, 0.16). The groove depth divided by the width of its wall
      // IS the surface slope, and past a slope of about 1.2 the averaged shading
      // normals at the groove lip face away from the walls that made them. The
      // smoothstep compresses the wall into a seventh of the field's natural
      // half-cell width and multiplies that slope by five.
      const groove = saturate(worley3Edge(dx * freq, dy * freq, dz * freq, ns, 1.0) * 2.4);
      let r = 1 + depth * (groove - 0.55);
      r += 0.05 * simplex3(dx * 2.2, dy * 2.2, dz * 2.2, ns ^ 1);
      _p[0] = dx * r * radius;
      _p[1] = dy * r * radius * squashY;
      _p[2] = dz * r * radius;
      vec3.set(_n, dx, dy, dz);
      _uv[0] = uu; _uv[1] = v;
      mb.addVertex(_p, _n, _uv, color);
    }
  }
  for (let i = 0; i < rings; i++) {
    // Rings descend from the +Y pole: tube handedness, flip = false.
    bridgeRings(mb, base + i * stride, base + (i + 1) * stride, seg, stride, false,
      i === 0, false);
  }
  mb.computeSmoothNormals(1.2);
  // Close the underside with a flat disc at the lowest ring's mean height, so
  // the coral is a solid even where the seabed does not quite meet it.
  {
    let ySum = 0;
    for (let j = 0; j < seg; j++) ySum += mb.positions[(base + rings * stride + j) * 3 + 1];
    const y = ySum / seg;
    vec3.set(_n, 0, -1, 0);
    vec3.set(_p, 0, y, 0);
    _uv[0] = 0.5; _uv[1] = 1;
    const centre = mb.addVertex(_p, _n, _uv, color);
    const rim = mb.vertexCount;
    for (let j = 0; j < seg; j++) {
      const src = (base + rings * stride + j) * 3;
      vec3.set(_p, mb.positions[src], y, mb.positions[src + 2]);
      _uv[0] = 0.5 + 0.5 * Math.cos((j / seg) * TAU);
      _uv[1] = 0.5 + 0.5 * Math.sin((j / seg) * TAU);
      mb.addVertex(_p, _n, _uv, color);
    }
    for (let j = 0; j < seg; j++) {
      mb.addTriangle(centre, rim + j, rim + ((j + 1) % seg));
    }
  }
  return finish(mb);
}

/**
 * Branching coral (staghorn / pillar form) by space colonisation.
 *
 * The skeleton grows toward a squashed hemisphere of attractors, so it fills a
 * volume the way a real colony competing for flow does, and the branch radii
 * follow Murray's law. Both children of a fork are lofted from the same parent
 * ring, so the joins are smooth with no boolean.
 *
 * Vertices: 1300-1750 (HIGH), 700-900 (MEDIUM), 350-450 (LOW).
 *
 * @param {number} seed
 * @param {number} [height] metres to the top of the colony
 * @param {object} [opts] {detail, color, attractors, spread} - spread is the
 *   colony's half-width as a fraction of its height; 0.5 is a pillar, 1.0 the
 *   wide dome of a staghorn thicket
 */
export function generateCoralBranching(seed, height = 1.4, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, MESH_ASSET.CORAL_BRANCH);
  const scale = height;
  // DESIGN/02 10.3 puts the attractors in a hemisphere of radius 1 squashed to
  // y * 0.85 - a volume WIDER than it is tall. Grown to a 2.6 m pillar coral
  // that gives a 6 m sprawl lying on the seabed, which is not what biome 9's
  // "vertical, cream to violet, 2-3 m tall" describes. The height and the
  // half-width are therefore separate knobs.
  const spread = opts.spread ?? 0.48;
  const attractorCount = Math.round((opts.attractors ?? 420) * byDetail(detail, 0.35, 0.6, 1));
  const attractors = hemisphereAttractors(attractorCount, 0.85, 0.24, rng);
  for (let i = 0; i + 2 < attractors.length; i += 3) {
    attractors[i] *= scale * spread;
    attractors[i + 1] *= scale / 0.85;
    attractors[i + 2] *= scale * spread;
  }

  // Node spacing IS the LOD knob here. Capping maxNodes instead does not work:
  // the attractor cloud, not the cap, decides how many nodes grow, so the coarse
  // tiers came out barely cheaper than the fine one. The influence and kill radii
  // ride along at the design's ratios to the step (6.2 and 2.2), because a kill
  // radius that does not shrink with the step leaves the finer tier nothing left
  // to grow toward.
  const step = byDetail(detail, 0.115, 0.078, 0.056) * scale;
  const skel = growSkeleton({
    attractors,
    influence: 6.2 * step,
    kill: 2.2 * step,
    step,
    maxNodes: byDetail(detail, 90, 190, 340),
    maxIterations: 220,
    initialDir: Float32Array.of(0, 1, 0),
    initialSteps: 3,
    jitter: 0.22,
    maxTurn: 0.72,
    rng,
  });
  // The radius cap is tied to the node SPACING, not to the colony size. Murray's
  // law on 250 leaves wants a 19 cm trunk, and a ring whose radius exceeds
  // step / sin(maxTurn) folds through the next ring at a bend.
  const { radius } = skeletonRadii(skel, 0.018 * scale, 0.42, Math.min(0.14 * scale, step * 0.9));
  const segments = byDetail(detail, 4, 5, 5);
  const mb = new MeshBuilder(skel.count * segments + 128, skel.count * segments * 8);
  meshSkeleton(mb, skel, radius, {
    segments,
    tip: 'apex',
    color: opts.color || MESH_PALETTE.CORAL_PINK,
    material: MESH_MATERIAL.FLORA,
    swayScale: 0.06,
    swayHeight: height,
  });
  return finish(mb);
}

/**
 * Tube / organ-pipe coral: the same space colonisation in a cylindrical volume,
 * with thicker members and an OPEN mouth at every tip. The mouths are real
 * geometry - a rim folded back into a short bore with a floor - because a tube
 * coral whose tubes are capped is just a bundle of sticks.
 *
 * Vertices: 900-1200 (HIGH), 520-680 (MEDIUM), 280-360 (LOW).
 *
 * @param {number} seed
 * @param {number} [height] metres
 * @param {object} [opts] {detail, color, attractors, mouthColor} - mouthColor
 *   tags the tube mouths emissive, which is what turns this generator from an
 *   organ-pipe coral into a vent tuberod colony
 */
export function generateCoralTube(seed, height = 1.2, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, MESH_ASSET.CORAL_TUBE);
  const attractorCount = Math.round((opts.attractors ?? 180) * byDetail(detail, 0.4, 0.65, 1));
  const attractors = cylinderAttractors(attractorCount, rng);
  // Design volume: cylinder r = 0.55, h = 1.2, scaled to the asked-for height.
  const scale = height / 1.2;
  for (let i = 0; i < attractorCount * 3 && i < attractors.length; i += 3) {
    attractors[i] *= 0.55 * scale;
    attractors[i + 1] *= 1.2 * scale;
    attractors[i + 2] *= 0.55 * scale;
  }

  const skel = growSkeleton({
    attractors,
    influence: 0.42 * scale,
    kill: 0.16 * scale,
    step: 0.075 * scale,
    maxNodes: byDetail(detail, 40, 70, 110),
    maxIterations: 110,
    initialDir: Float32Array.of(0, 1, 0),
    initialSteps: 2,
    jitter: 0.12,
    maxTurn: 0.62,
    rng,
  });
  const { radius } = skeletonRadii(skel, 0.026 * scale, 0.34, Math.min(0.10 * scale, 0.075 * scale * 0.9));
  const segments = byDetail(detail, 4, 5, 6);
  const mb = new MeshBuilder(skel.count * segments * 2 + 128, skel.count * segments * 12);
  meshSkeleton(mb, skel, radius, {
    segments,
    tip: 'open',
    // Deeper than the tube is wide, so the mouth reads as an opening rather than
    // as a bright disc stuck on the end.
    boreInset: 0.075 * scale,
    color: opts.color || MESH_PALETTE.CORAL_VIOLET,
    material: MESH_MATERIAL.FLORA,
    tipMaterial: opts.mouthColor ? MESH_MATERIAL.EMISSIVE : MESH_MATERIAL.FLORA,
    tipColor: opts.mouthColor || null,
    swayScale: 0.03,
    swayHeight: height,
  });
  return finish(mb);
}

/**
 * Gorgonian sea fan: a planar branching skeleton lofted with a thin LENS
 * cross-section, so every branch is a flat blade with a raised rib down its
 * centreline. That rib is the vein - actual geometry, so it catches a specular
 * highlight and shows through when the fan is backlit, which a painted vein
 * cannot do.
 *
 * The fan is single-plane and thin on purpose: it is lit with
 * brdf.wgsl evalTranslucency, and thickness is what kills that effect.
 *
 * Growth is breadth-first with a node budget rather than a literal five
 * iterations of the design's L-system: `F -> F[+F][-F]F` quadruples the string
 * every pass, so five iterations is 1024 segments - four times the whole vertex
 * budget for the asset. Breadth-first spends the budget evenly and keeps the fan
 * symmetric instead of growing one enormous first branch.
 *
 * Vertices: 480-620 (HIGH), 260-330 (MEDIUM), 140-180 (LOW).
 *
 * @param {number} seed
 * @param {number} [size] fan height in metres
 * @param {object} [opts] {detail, color, material, thickness}
 */
export function generateCoralFan(seed, size = 1.4, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, MESH_ASSET.CORAL_FAN);
  const ns = assetNoiseSeed(seed, MESH_ASSET.CORAL_FAN);
  const budget = byDetail(detail, 34, 66, 124);
  const maxGen = byDetail(detail, 5, 7, 9);
  const angle = 24 * (PI / 180);

  const pos = new Float32Array(budget * 3);
  const parent = new Int32Array(budget).fill(-1);
  let count = 1;
  let seg = 0.16;
  // Frontier entries are (nodeIndex, x, y, angle, length).
  let frontier = [[0, 0, 0, 0, seg]];
  for (let gen = 0; gen < maxGen && count < budget; gen++) {
    const next = [];
    for (const f of frontier) {
      if (count >= budget) break;
      const [pi, px, py, pa, plen] = f;
      // Rule choice, weighted toward branching early and toward continuing
      // late, which is what gives a fan a dense skirt and a fine margin.
      const twoWay = rng() < lerp(0.62, 0.18, gen / maxGen);
      const offsets = twoWay
        ? [-1, 1]
        : [rng() < 0.5 ? -1 : 1, 0];
      for (const s of offsets) {
        if (count >= budget) break;
        const a = pa + s * angle * lerp(0.71, 1.29, rng());
        const len = plen * 0.78;
        const nx = px + Math.sin(a) * len;
        const ny = py + Math.cos(a) * len;
        // A few centimetres out of plane: a mathematically flat fan looks like
        // cut paper.
        const nz = 0.035 * simplex2(nx * 3.1, ny * 3.1, ns);
        pos[count * 3] = nx; pos[count * 3 + 1] = ny; pos[count * 3 + 2] = nz;
        parent[count] = pi;
        next.push([count, nx, ny, a, len]);
        count++;
      }
    }
    if (next.length === 0) break;
    frontier = next;
    seg *= 0.78;
  }

  // Normalise to the requested height. Growing to an exact height directly
  // would need the segment-length series solved for a branch count that is
  // itself random.
  let maxY = 1e-6;
  for (let i = 0; i < count; i++) maxY = Math.max(maxY, pos[i * 3 + 1]);
  const norm = size / maxY;
  for (let i = 0; i < count * 3; i++) pos[i] *= norm;

  const skel = { pos, parent, count, rootDir: Float32Array.of(0, 1, 0) };
  const { radius } = skeletonRadii(skel, 0.016 * norm, 0.34, 0.042 * norm);
  const mb = new MeshBuilder(count * 4 + 96, count * 30);
  meshSkeleton(mb, skel, radius, {
    section: lensSection(opts.thickness ?? 0.20),
    // Pin the frame to the fan's own normal so the blade stays in plane instead
    // of rolling along the branch's torsion.
    upHint: Float32Array.of(0, 0, 1),
    tip: 'apex',
    // Keep the analytic lens normals. Re-deriving them from the faces averages
    // the raised centre rib into its own flanks - which is the vein, the whole
    // reason the section is a lens - and on a blade this thin the averaged normal
    // can tip past 90 degrees from the band it came from. The fan's members are
    // near-straight, so the analytic normals are already correct.
    recomputeNormals: false,
    color: opts.color || MESH_PALETTE.CORAL_ORANGE,
    material: opts.material ?? MESH_MATERIAL.TRANSLUCENT,
    swayScale: 0.22,
    swayHeight: size,
  });
  return finish(mb);
}

/**
 * Sponge cross-sections, in (r, y) normalised to a unit height and traversed
 * COUNTER-CLOCKWISE - up the outside, inward over the rim, down the bore. That
 * traversal direction is what makes the lathe's profile normal point out of the
 * solid everywhere on the surface, including the inside of the bore.
 *
 * `r` is a fraction of `rOut`; a negative value means "this station is on the
 * bore wall" and its magnitude is a fraction of the bore radius instead. Keeping
 * the two families of station in one table is what lets `bore` be a real knob:
 * the outer wall does not move when the interior does.
 *
 * `boreRef` is the outer-radius fraction the bore is measured against, and it is
 * NOT 1. The bore has to fit inside the NARROWEST wall it passes through, which
 * for the vase is its waisted neck at 0.50 of rOut - measured against rOut
 * instead, a bore of 0.62 would be wider than the neck containing it and the
 * lathe would turn inside out at mid-height.
 *
 * TWO FORMS, AND THEY MUST NOT LOOK ALIKE. `barrel` is Xestospongia: squat,
 * widest at mid-height, a thick rim and a wide mouth. `tube` is a hexactinellid
 * vase: half the girth for its height, a waisted neck and a trumpet lip. The
 * predecessor had ONE profile for both, so a glass sponge and a barrel sponge
 * were the same capsule at two scales - and between them they were 27-34% of
 * the silhouette area of five biomes.
 */
const SPONGE_FORMS = {
  barrel: {
    rOut: 0.56, boreRef: 0.95, bore: 0.62, ribs: 4, tubesLo: 3, tubesSpan: 2,
    ctrl: Float32Array.of(
      0.62, 0.00, 0.84, 0.09, 0.96, 0.30, 1.00, 0.58, 0.96, 0.84, 0.88, 0.97,
      -1.18, 1.000,
      -1.02, 0.955, -1.00, 0.68, -0.93, 0.34, -0.88, 0.12, -0.92, 0.06),
  },
  tube: {
    rOut: 0.30, boreRef: 0.52, bore: 0.66, ribs: 3, tubesLo: 4, tubesSpan: 2,
    ctrl: Float32Array.of(
      0.78, 0.00, 0.60, 0.10, 0.50, 0.32, 0.54, 0.56, 0.68, 0.80, 0.94, 0.94,
      1.00, 1.000,
      -1.62, 0.972, -1.10, 0.80, -1.00, 0.50, -0.94, 0.16, -0.98, 0.08),
  },
};

/**
 * Retag the INSIDE of a sponge - bore wall, bore floor and rim lip - to a
 * darker tint, by the one criterion that survives an arbitrary profile: an
 * interior surface's outward normal does not point away from the axis.
 *
 * Keyed on geometry rather than on the lathe's uv.y, because `addRingCap` writes
 * disc coordinates over the bore floor rather than the ring parameter, so a
 * uv.y threshold splits that floor in half and leaves a two-tone disc at the
 * bottom of every mouth.
 */
function retagSpongeBore(mesh, color) {
  for (let i = 0; i < mesh.vertexCount; i++) {
    const o = i * 3;
    const x = mesh.positions[o], z = mesh.positions[o + 2];
    const rl = Math.hypot(x, z);
    // The bottom cap faces straight down and is the one exterior surface with no
    // radial component at all, so it has to be excluded explicitly.
    if (mesh.normals[o + 1] < -0.5) continue;
    if (rl > 1e-5) {
      const radial = (mesh.normals[o] * x + mesh.normals[o + 2] * z) / rl;
      if (radial > 0.1) continue;
    }
    mesh.colors[i * 4] = color[0];
    mesh.colors[i * 4 + 1] = color[1];
    mesh.colors[i * 4 + 2] = color[2];
  }
  return mesh;
}

/**
 * Radial samples a rib period must get before it is geometry rather than
 * aliasing. Four is the smallest count that puts a sample near each crest AND
 * each trough of a sine.
 *
 * THIS CONSTANT EXISTS BECAUSE THE RIB USED TO BE EXACTLY ZERO. `ribs` was
 * drawn as `9 + rng.int(0, 8)` against a segment count of `byDetail(10, 14, 24)`,
 * and at the shipped seeds the glass sponge drew ribs = 14 against seg = 14:
 * `sin(theta * ribs)` sampled at `theta = 2*pi*j/seg` is then `sin(2*pi*j)`,
 * IDENTICALLY ZERO at every vertex. The barrel drew ribs = 12 at seg = 24,
 * exactly seg/2, which alternates +/-sin(pi*j) = 0 as well. So the sponge's only
 * surface feature was not aliased, it was absent, and both types rendered as
 * smooth capsules. Clamping the harmonic to the tessellation is the fix that
 * cannot regress: tools/test-meshgen.mjs takes the DFT of radius(theta) and
 * asserts the bin.
 */
const SPONGE_RIB_SAMPLES = 4;

/**
 * Sponge cluster: three to six merged tubes of varied height, girth and lean on
 * one base, each a continuous lathe that runs up the outside, over the rim and
 * back down into a real hollow bore.
 *
 * The bore interior is retagged to a darkened tint, because at the ranges a
 * sponge is actually seen the OPENING is the read - an unshaded bore of the same
 * colour as the flank is what turned the predecessor into a capsule even once
 * its ribs worked.
 *
 * Vertices: 1500-2200 (HIGH), 700-1000 (MEDIUM), 300-450 (LOW).
 *
 * @param {number} seed
 * @param {number} [height] metres, the tallest tube
 * @param {object} [opts] {detail, color, boreColor, form, ribs, rings, radial,
 *   bore, tubes} - `form` is 'barrel' (default) or 'tube'; `bore` is the bore
 *   radius as a fraction of the wall it sits inside; `tubes` overrides the
 *   cluster count
 */
export function generateSponge(seed, height = 0.9, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, MESH_ASSET.SPONGE);
  const ns = assetNoiseSeed(seed, MESH_ASSET.SPONGE);
  const form = SPONGE_FORMS[opts.form] || SPONGE_FORMS.barrel;
  const seg = clamp(opts.radial ?? byDetail(detail, 11, 16, 24), 5, 48);
  const samples = clamp(opts.rings ?? byDetail(detail, 9, 12, 14), 6, 40);
  const bore = clamp(opts.bore ?? form.bore, 0.15, 0.85);
  // Drawn before the clamp so the RNG stream - and therefore the whole cluster -
  // is identical at every detail tier.
  const ribsWanted = opts.ribs ?? (form.ribs + rng.int(0, 3));
  const ribs = clamp(ribsWanted, 2, Math.max(2, Math.floor(seg / SPONGE_RIB_SAMPLES)));
  const tubes = clamp(
    Math.round(opts.tubes ?? (form.tubesLo + rng.int(0, form.tubesSpan))),
    1, byDetail(detail, 3, 4, 5));

  const bodyColor = opts.color || MESH_PALETTE.SPONGE_URN;
  const boreColor = opts.boreColor
    || Float32Array.of(bodyColor[0] * 0.40, bodyColor[1] * 0.42, bodyColor[2] * 0.46, 0);

  const profile = new Float32Array(samples * 2);
  const ctrl = new Float32Array(form.ctrl.length);
  const tmp = Float32Array.of(0, 0);
  const q = Float32Array.of(0, 0, 0, 1);
  const axis = vec3.create();
  const trans = vec3.create();
  const scale = vec3.create(1, 1, 1);
  const xf = new Float32Array(16);
  const mb = new MeshBuilder(tubes * (samples + 3) * (seg + 1), tubes * samples * seg * 6);
  mb.material = MESH_MATERIAL.FLORA;

  for (let t = 0; t < tubes; t++) {
    const primary = t === 0;
    const h = height * (primary ? 1 : lerp(0.40, 0.86, rng()));
    // Girth is drawn independently of height, or a cluster reads as one form
    // photocopied at several scales.
    const rOut = h * form.rOut * lerp(0.82, 1.22, rng());
    const rIn = rOut * form.boreRef * bore;
    for (let i = 0; i < ctrl.length; i += 2) {
      const c = form.ctrl[i];
      ctrl[i] = c < 0 ? -c * rIn : c * rOut;
      ctrl[i + 1] = form.ctrl[i + 1] * h;
    }
    for (let i = 0; i < samples; i++) {
      catmullRom2(ctrl, i / (samples - 1), tmp);
      profile[i * 2] = Math.max(0, tmp[0]);
      profile[i * 2 + 1] = tmp[1];
    }

    const ribPhase = rng() * TAU;
    const tube = lathe(profile, seg, {
      color: bodyColor,
      material: MESH_MATERIAL.FLORA,
      closeBottom: true,
      // The last profile station is the BORE FLOOR, so the "top" cap is the
      // disc you see when you look down the mouth. Without it the bore is a
      // hole straight through the solid and you see its own back faces.
      closeTop: true,
      modulate: (ringT, theta, r, y) => {
        // Ribs live on the outside only; smoothstep off before the rim so the
        // bore stays smooth and the rib crests do not fight the fold.
        const outside = 1 - smoothstep(0.40, 0.54, ringT);
        const rib = 0.11 * Math.sin(theta * ribs + ribPhase) * outside;
        // The pit is deliberately WEAKER and COARSER than the rib. At the
        // predecessor's 0.03 against a rib of exactly zero it was the only
        // surface variation there was; at parity it wins the DFT often enough
        // that the fluting stops reading as fluting.
        const pit = 0.028 * simplex3(
          Math.cos(theta) * r * 6 / height, y * 6 / height,
          Math.sin(theta) * r * 6 / height, ns + t);
        return 1 + rib + pit;
      },
    });
    retagSpongeBore(tube, boreColor);

    if (primary) {
      mb.merge(tube);
      continue;
    }
    // Satellites lean away from the cluster centre. A ROTATION about the base,
    // not a shear: merge() carries normals through the inverse transpose, so a
    // rotated tube needs no normal repair, while a shear would silently leave
    // every satellite lit as though it were upright.
    const az = t * 2.399963 + rng() * 0.7;
    const tilt = lerp(0.12, 0.40, rng());
    vec3.set(axis, -Math.sin(az), 0, Math.cos(az));
    const s = Math.sin(tilt * 0.5);
    q[0] = axis[0] * s; q[1] = axis[1] * s; q[2] = axis[2] * s; q[3] = Math.cos(tilt * 0.5);
    const off = rOut * lerp(0.85, 1.9, rng());
    // Sunk by the amount the tilt lifts the base ring, so a leaning tube is
    // still planted rather than balanced on one edge.
    vec3.set(trans, Math.cos(az) * off, -rOut * Math.sin(tilt) - h * 0.03, Math.sin(az) * off);
    buildTRS(xf, q, trans, scale);
    mb.merge(tube, xf);
  }
  return finish(mb);
}

// ===========================================================================
// Fungi, bioluminescence, vents, bone
// ===========================================================================

/**
 * Lean a mesh by displacing x/z with (y / height)^power, in place.
 *
 * Used instead of a rotation because a rotated stalk lifts its own base off the
 * ground; a shear keeps y = 0 exactly where it was, which is where the scatter
 * system has already decided the seabed is.
 */
function shearMesh(mesh, dx, dz, height, power = 2) {
  const inv = 1 / Math.max(height, 1e-6);
  for (let i = 0; i < mesh.vertexCount; i++) {
    const o = i * 3;
    const t = Math.pow(saturate(mesh.positions[o + 1] * inv), power);
    mesh.positions[o] += dx * t;
    mesh.positions[o + 2] += dz * t;
  }
  return mesh;
}

/** Retag a built mesh's vertices by uv.y band: material slot and colour. */
function retagByV(mesh, vMax, material, color) {
  for (let i = 0; i < mesh.vertexCount; i++) {
    if (mesh.uvs[i * 2 + 1] > vMax) continue;
    mesh.materials[i] = material;
    mesh.colors[i * 4] = color[0];
    mesh.colors[i * 4 + 1] = color[1];
    mesh.colors[i * 4 + 2] = color[2];
  }
  return mesh;
}

/** As retagByV, but for the band ABOVE vMin. */
function retagAboveV(mesh, vMin, material, color) {
  for (let i = 0; i < mesh.vertexCount; i++) {
    if (mesh.uvs[i * 2 + 1] < vMin) continue;
    mesh.materials[i] = material;
    mesh.colors[i * 4] = color[0];
    mesh.colors[i * 4 + 1] = color[1];
    mesh.colors[i * 4 + 2] = color[2];
  }
  return mesh;
}

/**
 * Lampcap-class glowing fungus: a bulged lathed stem under a lathed cap whose
 * UNDERSIDE carries radial gill grooves tagged MESH_MATERIAL.EMISSIVE.
 *
 * Tagging the gills rather than the whole cap is the entire lighting read of
 * the Lampcap Forest: the cap top is a dull pale shell, the gills glow, and
 * everything underneath is uplit and casts its shadow upward.
 *
 * Vertices: 640 (HIGH), 380 (MEDIUM), 190 (LOW).
 *
 * @param {number} seed
 * @param {number} [height] total metres
 * @param {number} [capRadius] metres
 * @param {object} [opts] {detail, color, gillColor, gills}
 */
export function generateMushroom(seed, height = 5.8, capRadius = 1.95, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, MESH_ASSET.MUSHROOM);
  const ns = assetNoiseSeed(seed, MESH_ASSET.MUSHROOM);
  const seg = byDetail(detail, 8, 11, 16);
  const stemSamples = byDetail(detail, 6, 8, 11);
  const capSamples = byDetail(detail, 7, 10, 13);
  const gills = opts.gills ?? (18 + rng.int(0, 24));
  const bulge = lerp(0.9, 1.7, rng());
  const flare = lerp(0.6, 1.6, rng());
  const capThick = height * lerp(0.22, 0.34, rng());
  const stemTop = height - capThick;
  const stemR = capRadius * 0.14 * lerp(0.85, 1.2, rng());
  const stemColor = opts.color || MESH_PALETTE.FUNGUS_STALK;
  const gillColor = opts.gillColor || MESH_PALETTE.FUNGUS_GLOW;

  // Stem, counter-clockwise in (r, y): out along the base, up the side, in at
  // the top where the cap takes over.
  const stemCtrl = Float32Array.of(
    0.00, 0.000, 0.55, 0.004, 0.62 * bulge, 0.05, 0.42, 0.20,
    0.34, 0.45, 0.33, 0.70, 0.38, 0.90, 0.00, 1.000);
  const stemProfile = new Float32Array(stemSamples * 2);
  const tmp = Float32Array.of(0, 0);
  for (let i = 0; i < stemSamples; i++) {
    catmullRom2(stemCtrl, i / (stemSamples - 1), tmp);
    stemProfile[i * 2] = Math.max(0, tmp[0]) * stemR * 2;
    stemProfile[i * 2 + 1] = tmp[1] * stemTop;
  }
  const stem = lathe(stemProfile, seg, {
    color: stemColor,
    material: MESH_MATERIAL.FLORA,
    modulate: (ringT, theta, r, y) => 1 + 0.035 * simplex3(
      Math.cos(theta) * r * 4, y * 4, Math.sin(theta) * r * 4, ns),
  });

  // Cap, also counter-clockwise: outward across the gill underside, up over the
  // lip, then inward across the top to the apex. The lip fraction is where the
  // gills stop, and it is the same number the retag below uses.
  const LIP_V = 4 / 9;
  const capCtrl = Float32Array.of(
    0.00, -0.02, 0.30 * flare, 0.01, 0.62 * flare, 0.03, 0.86 * flare, 0.06,
    1.00 * flare, 0.10,
    0.96 * flare, 0.16, 0.82 * flare, 0.21, 0.58 * flare, 0.25, 0.30 * flare, 0.275,
    0.00, 0.28);
  const capProfile = new Float32Array(capSamples * 2);
  for (let i = 0; i < capSamples; i++) {
    catmullRom2(capCtrl, i / (capSamples - 1), tmp);
    capProfile[i * 2] = Math.max(0, tmp[0]) * capRadius;
    capProfile[i * 2 + 1] = stemTop + (tmp[1] / 0.28) * capThick;
  }
  const cap = lathe(capProfile, seg, {
    color: stemColor,
    material: MESH_MATERIAL.FLORA,
    modulate: (ringT, theta) => {
      // Gills only on the underside; smoothstep off before the lip so the
      // grooves do not carve into the rim.
      const under = 1 - smoothstep(LIP_V * 0.75, LIP_V, ringT);
      return 1 + 0.05 * Math.sin(theta * gills) * under;
    },
  });
  retagByV(cap, LIP_V * 0.92, MESH_MATERIAL.EMISSIVE, gillColor);

  const mb = new MeshBuilder(stem.vertexCount + cap.vertexCount, stem.indexCount + cap.indexCount);
  mb.merge(stem);
  mb.merge(cap);
  const lean = lerp(0, 0.28, rng());
  const leanAz = rng() * TAU;
  shearMesh(mb, Math.cos(leanAz) * lean * height * 0.5, Math.sin(leanAz) * lean * height * 0.5, height);
  // The shear tilts the surface, so re-derive the shading. The threshold keeps
  // the gill lip as a crease while welding the lathe's u seam.
  mb.computeSmoothNormals(1.0);
  return finish(mb);
}

/**
 * Giant jellyshroom: the Jellyshroom Hollow's landmark prop (world/
 * cave_sites.js), placed by the cave bake rather than by any scatter row. A
 * huge translucent-reading dome cap on a dark stalk, after the reference's
 * jellyfish-mushrooms: the WHOLE cap is tagged EMISSIVE and carries a colour
 * gradient (deep magenta underside, pink rim, near-white core) so the
 * translucency is painted by emission rather than modelled - the cave prop
 * fragment path has no transmission term, and a lit-from-within gradient is
 * what a backlit membrane actually looks like.
 *
 * Rigid: sway weight 0 everywhere. A 16 m cap on a cave floor does not wave,
 * and the cave prop pipeline treats instances as static geometry.
 *
 * Vertices: ~700 (HIGH), within the landmark band; placed at most 14 times
 * in the world, all by one authored site.
 *
 * @param {number} seed
 * @param {number} [height] metres; the registered parameterisation is 14 and
 *   cave_sites' per-shroom heights become instance scales against it
 * @param {object} [opts] {detail, capColor, coreColor, underColor, stalkColor}
 */
export function generateJellyshroom(seed, height = 14, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, MESH_ASSET.JELLYSHROOM);
  const ns = assetNoiseSeed(seed, MESH_ASSET.JELLYSHROOM);
  // 32 segments at HIGH: the first cut's 24 delivered 8-10 visibly straight
  // silhouette edges on a frame-filling 16 m cap.
  const seg = byDetail(detail, 14, 20, 32);
  const stalkSamples = byDetail(detail, 6, 8, 10);
  const capSamples = byDetail(detail, 9, 13, 19);
  const capR = height * lerp(0.42, 0.50, rng());
  const capSquash = lerp(0.9, 1.1, rng());

  const capColor = opts.capColor || MESH_PALETTE.JELLY_CAP;
  const coreColor = opts.coreColor || MESH_PALETTE.JELLY_CAP_CORE;
  const underColor = opts.underColor || MESH_PALETTE.JELLY_UNDER;
  const stalkColor = opts.stalkColor || MESH_PALETTE.JELLY_STALK;

  // Stalk: a gentle waisted column, base flared and sunk 0.045 H below y = 0
  // so the instance never hovers on the marched floor's wobble. The top ring
  // vanishes INSIDE the cap so no rim is ever visible.
  const tmp = Float32Array.of(0, 0);
  // Radii sized against the reference's stout stalks (~1/4 of cap width);
  // the first cut at ~0.075 H read as a pole under a 6.5 m dome.
  const stalkCtrl = Float32Array.of(
    0.000, -0.045, 0.165, -0.040, 0.175, 0.020, 0.128, 0.180,
    0.106, 0.420, 0.100, 0.600, 0.112, 0.700, 0.000, 0.740);
  const stalkProfile = new Float32Array(stalkSamples * 2);
  for (let i = 0; i < stalkSamples; i++) {
    catmullRom2(stalkCtrl, i / (stalkSamples - 1), tmp);
    stalkProfile[i * 2] = Math.max(0, tmp[0]) * height;
    stalkProfile[i * 2 + 1] = tmp[1] * height;
  }
  const stalk = lathe(stalkProfile, seg, {
    color: stalkColor,
    material: MESH_MATERIAL.FLORA,
    modulate: (ringT, theta, r, y) => 1
      + 0.05 * Math.sin(theta * 7 + ringT * 2.1)
      + 0.05 * simplex3(Math.cos(theta) * 2.2, y * 0.5, Math.sin(theta) * 2.2, ns),
  });

  // Cap: underside from the stalk out to the rim, then over the lip and in
  // across the dome to the apex. Same counter-clockwise (r, y) convention as
  // generateMushroom's cap. Flatter and wider than the first cut, with a
  // rolled-under rim - the reference dome is a squashed lens, not a hemisphere.
  // The rim turn is gentle on purpose: a sharper rolled-under tuck (1.005 at
  // the lip against 1.00 above it) folded the lathe through itself at one
  // ring and shipped a back-facing triangle - test-meshgen section 3 caught
  // it. Monotone r up to the lip, then monotone down over the dome.
  const capCtrl = Float32Array.of(
    0.05, 0.715, 0.28, 0.700, 0.55, 0.702, 0.80, 0.718, 0.96, 0.740,
    1.00, 0.765,
    0.985, 0.802,
    0.94, 0.845, 0.80, 0.895, 0.55, 0.935, 0.28, 0.955, 0.00, 0.962);
  const capProfile = new Float32Array(capSamples * 2);
  let rimI = 0, rimR = 0;
  for (let i = 0; i < capSamples; i++) {
    catmullRom2(capCtrl, i / (capSamples - 1), tmp);
    const r = Math.max(0, tmp[0]) * capR;
    capProfile[i * 2] = r;
    capProfile[i * 2 + 1] = (0.7 + (tmp[1] - 0.7) * capSquash) * height;
    if (r > rimR) { rimR = r; rimI = i; }
  }
  const lipT = rimI / (capSamples - 1);
  const cap = lathe(capProfile, seg, {
    color: capColor,
    material: MESH_MATERIAL.EMISSIVE,
    modulate: (ringT, theta) => 1
      + 0.030 * simplex3(Math.cos(theta) * 2.5, ringT * 4, Math.sin(theta) * 2.5, ns)
      + 0.015 * Math.sin(theta * 9) * (1 - smoothstep(lipT * 0.7, lipT, ringT)),
  });
  // Paint the emission gradient by ring: underside, rim, then core. The lathe
  // wrote uv.y = ringT, so the profile parameter survives into the mesh.
  // The core zone is BOUNDED (pow 2.6 keeps the pale centre to the inner
  // fifth of the dome) - the first cut's 1.4 let the whole top drift toward
  // the core colour, which then clipped white through the AgX shoulder.
  for (let i = 0; i < cap.vertexCount; i++) {
    const t = cap.uvs[i * 2 + 1];
    let c;
    if (t <= lipT) {
      const u = smoothstep(lipT * 0.55, lipT, t);
      c = [lerp(underColor[0], capColor[0], u), lerp(underColor[1], capColor[1], u),
           lerp(underColor[2], capColor[2], u)];
    } else {
      const u = Math.pow(smoothstep(lipT, 1, t), 2.6);
      c = [lerp(capColor[0], coreColor[0], u), lerp(capColor[1], coreColor[1], u),
           lerp(capColor[2], coreColor[2], u)];
    }
    cap.colors[i * 4] = c[0]; cap.colors[i * 4 + 1] = c[1]; cap.colors[i * 4 + 2] = c[2];
  }

  // Tiered frill shelves at the base - the reference's grounding element:
  // every stalk rises out of a stack of dark scalloped shelves studded with
  // pale glow specks. Each tier is a thin three-ring lathe whose rim ring
  // (ringT 0.5) carries sparse EMISSIVE dot vertices.
  const frillColor = opts.frillColor || MESH_PALETTE.JELLY_FRILL;
  const dotColor = opts.dotColor || MESH_PALETTE.JELLY_FRILL_DOT;
  const tiers = byDetail(detail, 2, 3, 4);
  const frills = [];
  for (let ti = 0; ti < tiers; ti++) {
    const ty = height * (0.015 + 0.075 * ti);
    const tr = height * (0.32 - 0.058 * ti) * lerp(0.9, 1.1, rng());
    const th = height * 0.022;
    const lobes = 7 + ((seed + ti) % 4);
    const phase = rng() * TAU;
    // NOT a fold-back profile: the return leg stays at 0.90 of the rim, so
    // the surface never turns under itself - a full fold-back is the exact
    // lathe trap test-meshgen's back-facing check exists for (the sponge
    // shelf shipped it once; see CLAUDE.md's meshgen bullet).
    // FOUR rings, and the scallop modulates every one of them - both halves
    // measured, not guessed. Three rings gave the single rim ring a
    // central-difference normal spanning inner-bottom to inner-top, i.e.
    // biased DOWN, and every top-band triangle then read back-facing (32 of
    // 128 on the bare shelf, test-meshgen's own check and a local rewind
    // both). Two rim rings give the bottom and top edges their own normals.
    // A rim-only scallop was the second trap: at each lobe minimum the rim
    // dipped inside the top ring's return radius and the band folded - the
    // sponge-shelf fold-back the meshgen bullet in CLAUDE.md records.
    const shelf = lathe(Float32Array.of(
      tr * 0.40, ty,
      tr, ty + th * 0.5,
      tr * 0.985, ty + th * 1.05,
      tr * 0.86, ty + th * 1.4), seg, {
      color: frillColor,
      material: MESH_MATERIAL.FLORA,
      modulate: (ringT, theta) => 1 + 0.12 * Math.sin(theta * lobes + phase),
    });
    // Glow specks on the rim ring: every fifth rim vertex, offset per tier.
    for (let i = 0; i < shelf.vertexCount; i++) {
      if (Math.abs(shelf.uvs[i * 2 + 1] - 0.5) > 0.01) continue;
      if ((i + ti * 2) % 5 !== 0) continue;
      shelf.materials[i] = MESH_MATERIAL.EMISSIVE;
      shelf.colors[i * 4] = dotColor[0];
      shelf.colors[i * 4 + 1] = dotColor[1];
      shelf.colors[i * 4 + 2] = dotColor[2];
    }
    frills.push(shelf);
  }

  let fv = 0, fi = 0;
  for (const f of frills) { fv += f.vertexCount; fi += f.indexCount; }
  const mb = new MeshBuilder(stalk.vertexCount + cap.vertexCount + fv,
                             stalk.indexCount + cap.indexCount + fi);
  mb.merge(stalk);
  mb.merge(cap);
  for (const f of frills) mb.merge(f);
  const lean = lerp(0, 0.10, rng());
  const leanAz = rng() * TAU;
  shearMesh(mb, Math.cos(leanAz) * lean * height * 0.5,
            Math.sin(leanAz) * lean * height * 0.5, height);
  mb.computeSmoothNormals(1.0);
  return finish(mb);
}

/**
 * Bioluminescent bladder pod: a slender stalk carrying swollen gas bladders,
 * every bladder tagged emissive. This is lampweed, glowcup and the hadal wisp,
 * separated only by colour, height and bladder count.
 *
 * The bladders are squashed spheres rather than a single blob because the pod
 * has to read as several discrete light sources - at range the scatter system
 * turns it into one point light, and a single blob makes that lie obvious.
 *
 * Vertices: 330 (HIGH), 180 (MEDIUM), 90 (LOW).
 *
 * @param {number} seed
 * @param {number} [height] metres
 * @param {object} [opts] {detail, color, glowColor, bladders|pods}
 */
export function generateGlowPod(seed, height = 0.55, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, MESH_ASSET.GLOW_POD);
  const ns = assetNoiseSeed(seed, MESH_ASSET.GLOW_POD);
  const stations = byDetail(detail, 4, 6, 8);
  const bladders = Math.max(1, Math.round(
    (opts.bladders ?? opts.pods ?? (3 + rng.int(0, 2))) * byDetail(detail, 0.45, 0.7, 1)));
  const sphereSeg = byDetail(detail, 5, 6, 8);
  const sphereRings = byDetail(detail, 3, 4, 5);
  const az = rng() * TAU;

  const path = new Float32Array(stations * 3);
  fillCurvedSpline(path, stations, 0, 0, 0, az, height, lerp(0.25, 0.75, rng()), 0.06, ns);
  const stalk = extrudeAlongSpline(unitCircle(5), path, 0, 0.45, {
    radius: height * 0.035,
    color: opts.color || MESH_PALETTE.KELP_DARK,
    material: MESH_MATERIAL.FLORA,
  });

  const mb = new MeshBuilder(stalk.vertexCount + bladders * 60, stalk.indexCount + bladders * 200);
  mb.merge(stalk);

  const glow = opts.glowColor || MESH_PALETTE.GLOW_POD;
  const q = Float32Array.of(0, 0, 0, 1);
  const trans = vec3.create();
  const scale = vec3.create(1, 1, 1);
  const xf = new Float32Array(16);
  for (let b = 0; b < bladders; b++) {
    // Spread over most of the stalk and kept smaller than half the spacing, or
    // the bladders merge into one lump and the pod stops reading as a chain of
    // separate lights.
    const t = lerp(0.30, 1.0, (b + 0.5) / bladders);
    const si = clamp(Math.round(t * (stations - 1)), 0, stations - 1);
    const r = height * lerp(0.075, 0.115, rng()) * lerp(0.8, 1.0, 1 - t);
    const bladder = uvSphere(sphereSeg, sphereRings, r, {
      radiusY: r * lerp(1.15, 1.55, rng()),
      color: glow,
      material: MESH_MATERIAL.EMISSIVE,
    });
    // Sway with the stalk: the bladder is rigidly attached at its station.
    const sway = smoothstep(0, 1, t);
    for (let i = 0; i < bladder.vertexCount; i++) bladder.colors[i * 4 + 3] = sway;
    const spread = height * 0.06;
    const ba = az + b * 2.399963;
    vec3.set(trans,
      path[si * 3] + Math.cos(ba) * spread,
      path[si * 3 + 1] + r * 0.3,
      path[si * 3 + 2] + Math.sin(ba) * spread);
    buildTRS(xf, q, trans, scale);
    mb.merge(bladder, xf);
  }
  return finish(mb);
}

/**
 * Black smoker chimney: a lathe whose exterior radius is a stack of flared
 * cones, crusted with mineral accretion noise, hollowed by a real bore whose
 * inner wall is tagged emissive so the vent mouth throws the orange
 * bottom-lighting the Emberfield needs.
 *
 * Vertices: 640 (HIGH), 380 (MEDIUM), 180 (LOW).
 *
 * @param {number} seed
 * @param {number} [height] metres
 * @param {object} [opts] {detail, color, hotColor, stacks}
 */
export function generateVentChimney(seed, height = 6, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, MESH_ASSET.VENT_CHIMNEY);
  const ns = assetNoiseSeed(seed, MESH_ASSET.VENT_CHIMNEY);
  const seg = byDetail(detail, 9, 13, 20);
  const extSamples = byDetail(detail, 7, 11, 16);
  const boreSamples = byDetail(detail, 3, 4, 6);
  const stacks = clamp(opts.stacks ?? (4 + rng.int(0, 5)), 2, 9);
  const rBase = height * lerp(0.16, 0.26, rng());
  const flareRate = lerp(0.48, 0.66, rng());
  const boreRatio = lerp(0.32, 0.48, rng());

  const rings = extSamples + 1 + boreSamples;
  const profile = new Float32Array(rings * 2);
  let w = 0;
  for (let i = 0; i < extSamples; i++) {
    const t = i / (extSamples - 1);
    // Sawtooth flare: each accreted stack is widest where it was deposited and
    // necks in before the next one starts. Squaring it makes the step read as a
    // lip rather than as a ripple.
    const frac = (t * stacks) % 1;
    const pulse = 0.22 * (1 - frac) * (1 - frac);
    profile[w * 2] = rBase * (1 - flareRate * t) * (1 + pulse);
    profile[w * 2 + 1] = t * height;
    w++;
  }
  const rTop = profile[(w - 1) * 2];
  // Rim, then down the bore. The bore stops well short of the base: a chimney
  // is a plumbing system, not a pipe, and a bore that reached the floor would be
  // visible straight through from below.
  profile[w * 2] = rTop * boreRatio * 1.25;
  profile[w * 2 + 1] = height * 1.002;
  w++;
  for (let i = 0; i < boreSamples; i++) {
    const t = i / (boreSamples - 1);
    profile[w * 2] = rTop * boreRatio * lerp(1.0, 0.72, t);
    profile[w * 2 + 1] = lerp(height * 0.96, height * 0.55, t);
    w++;
  }

  const mesh = lathe(profile, seg, {
    color: opts.color || MESH_PALETTE.VENT_CRUST,
    material: MESH_MATERIAL.SEDIMENT,
    closeBottom: true,
    closeTop: true,
    modulate: (ringT, theta, r, y) => {
      // Crust on the outside only: the bore is scoured smooth by the flow.
      const outside = 1 - smoothstep(0.72, 0.80, ringT);
      const x = Math.cos(theta) * r, z = Math.sin(theta) * r;
      const f = 2.6 / Math.max(rBase, 0.05);
      const lumps = 0.075 * simplex3(x * f, y * f * 0.6, z * f, ns);
      const accretion = 0.055 * (1 - worley3Edge(x * f * 1.7, y * f * 1.1, z * f * 1.7, ns ^ 5, 1.0));
      return 1 + (lumps + accretion) * outside;
    },
  });
  const boreStart = (extSamples + 0.5) / (rings - 1);
  retagAboveV(mesh, boreStart, MESH_MATERIAL.EMISSIVE, opts.hotColor || MESH_PALETTE.VENT_HOT);
  return mesh;
}

/**
 * A weathered rib from something enormous: an elliptical section swept along an
 * arc, ribbed by a periodic radius modulation, with an articular head at the
 * proximal end.
 *
 * Sway is forced to zero. Bone does not move, and extrudeAlongSpline writes a
 * sway ramp by default because almost everything else that uses it does.
 *
 * Vertices: 300 (HIGH), 190 (MEDIUM), 100 (LOW).
 *
 * @param {number} seed
 * @param {number} [length] metres along the arc
 * @param {object} [opts] {detail, color, ribs, taper}
 */
export function generateBoneRib(seed, length = 12, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, MESH_ASSET.BONE_RIB);
  const ns = assetNoiseSeed(seed, MESH_ASSET.BONE_RIB);
  const stations = byDetail(detail, 8, 14, 22);
  const sec = byDetail(detail, 5, 6, 8);
  const ribs = opts.ribs ?? (6 + rng.int(0, 8));
  const curvature = lerp(0.85, 1.55, rng());
  const color = opts.color || MESH_PALETTE.BONE;

  const path = new Float32Array(stations * 3);
  fillCurvedSpline(path, stations, 0, 0, 0, rng() * TAU, length, curvature, 0.04, ns);

  // Elliptical section: a rib is flattened in the plane of the ribcage.
  const section = new Float32Array(sec * 2);
  for (let k = 0; k < sec; k++) {
    const a = (k / sec) * TAU;
    section[k * 2] = Math.cos(a);
    section[k * 2 + 1] = Math.sin(a) * 0.55;
  }

  const shaft = extrudeAlongSpline(section, path, 0.5, clamp(opts.taper ?? 0.34, 0.05, 1), {
    radius: length * 0.030,
    color,
    material: MESH_MATERIAL.BONE,
    capStart: true,
    scaleFn: (t) => (1 + 0.06 * Math.sin(t * ribs * TAU))
      * (1 + 0.05 * simplex2(t * 7, 0, ns))
      // Weathering: the distal third is thinned and pitted where it has been
      // lying in the current longest.
      * (1 - 0.10 * smoothstep(0.62, 1, t)),
  });
  remapSway(shaft, 0, 0);

  const mb = new MeshBuilder(shaft.vertexCount + 64, shaft.indexCount + 200);
  mb.merge(shaft);

  const head = icosphere(byDetail(detail, 0, 1, 1), length * 0.052, {
    color, material: MESH_MATERIAL.BONE,
  });
  const q = Float32Array.of(0, 0, 0, 1);
  const trans = vec3.create(0, length * 0.012, 0);
  const scale = vec3.create(1.35, 0.9, 1);
  const xf = new Float32Array(16);
  buildTRS(xf, q, trans, scale);
  mb.merge(head, xf);
  return finish(mb);
}

// ===========================================================================
// Two shape classes the rest of the kit does not contain
// ===========================================================================

/**
 * A hollow silica basket: rings threaded by helical struts, with NO SOLID WALL.
 *
 * IT IS THE ONLY OBJECT IN THE GAME YOU CAN SEE THROUGH, and that is the entire
 * point of it. The finding it answers is that 19 generators produce 42 rows and 13 of those generators are shared, so a biome's
 * "exclusive" landmark is routinely the same SHAPE as three other biomes' props
 * - measured, over generator families and footprint-weighted, the deep six's
 * most-alike pairs are `terrace x canyon` 0.9668 and `spires x trenchWall`
 * 0.9525, exactly the pairs whose signatures share `generateCoralFan` and
 * `generateCrystal`. No weight table can separate two biomes whose landmarks
 * come out of one generator. A form with a hole through it cannot be confused
 * with a needle, a fan or a chimney at any distance.
 *
 * THE RINGS ARE REAL TORI AND THE STRUTS ARE REAL SWEEPS. A cylinder with a
 * lattice painted on it would read identically from the front and lose the whole
 * effect the moment anything passed behind it, which at Trench Wall is a lamp.
 *
 * Vertices: about 700 (HIGH), 330 (MEDIUM), 150 (LOW).
 *
 * @param {number} seed
 * @param {number} [size] height in metres
 * @param {object} [opts] {detail, color, rings, struts}
 */
export function generateGlassLattice(seed, size = 2.6, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, MESH_ASSET.GLASS_LATTICE);
  const ns = assetNoiseSeed(seed, MESH_ASSET.GLASS_LATTICE);
  const rings = byDetail(detail, 3, 4, clamp(opts.rings ?? (4 + rng.int(0, 4)), 3, 7));
  const struts = byDetail(detail, 5, 6, clamp(opts.struts ?? (8 + rng.int(0, 7)), 5, 14));
  const majorSeg = byDetail(detail, 7, 10, 13);
  const minorSeg = byDetail(detail, 3, 4, 5);
  const strutSec = byDetail(detail, 3, 4, 4);
  const strutStations = byDetail(detail, 5, 8, 11);
  const color = opts.color || MESH_PALETTE.SPONGE_PALE;
  const wire = size * lerp(0.026, 0.042, rng());

  // A basket profile: narrow foot, widest a little above the middle, an open
  // rim slightly drawn in. `radiusAt` is shared by the rings and the struts so
  // they touch instead of interpenetrating, which is what makes it read as one
  // woven object rather than as hoops and wires in the same place.
  const flare = lerp(0.30, 0.46, rng());
  const lean = lerp(0.05, 0.20, rng());
  const leanAz = rng() * TAU;
  const radiusAt = (t) => size * flare
    * (0.34 + 0.66 * Math.sin(Math.PI * Math.pow(clamp(t, 0, 1), 0.78)))
    * (1 + 0.10 * simplex2(t * 3.3, 0, ns));

  const mb = new MeshBuilder(900, 2700);
  const q = Float32Array.of(0, 0, 0, 1);
  const trans = vec3.create();
  const scale = vec3.create(1, 1, 1);
  const xf = new Float32Array(16);

  for (let i = 0; i < rings; i++) {
    const t = rings > 1 ? i / (rings - 1) : 0.5;
    const y = size * (0.06 + 0.92 * t);
    const r = radiusAt(t);
    const ring = torus(r, wire, majorSeg, minorSeg, {
      color, material: MESH_MATERIAL.CRYSTAL,
    });
    vec3.set(trans, 0, y, 0);
    vec3.set(scale, 1, 1, 1);
    buildTRS(xf, q, trans, scale);
    mb.merge(ring, xf);
  }

  // Helical struts, alternating handedness so the weave crosses itself. A single
  // handedness is a barber's pole and reads as a twisted cylinder.
  const section = new Float32Array(strutSec * 2);
  for (let k = 0; k < strutSec; k++) {
    const a = (k / strutSec) * TAU;
    section[k * 2] = Math.cos(a);
    section[k * 2 + 1] = Math.sin(a);
  }
  const path = new Float32Array(strutStations * 3);
  for (let s = 0; s < struts; s++) {
    const hand = (s & 1) ? 1 : -1;
    const a0 = (s / struts) * TAU;
    const turns = lerp(0.22, 0.42, ((simplex2(s * 1.9, 4, ns) + 1) * 0.5)) * hand;
    for (let i = 0; i < strutStations; i++) {
      const t = i / (strutStations - 1);
      const y = size * (0.04 + 0.96 * t);
      const r = radiusAt(t);
      const a = a0 + turns * TAU * t;
      path[i * 3] = Math.cos(a) * r;
      path[i * 3 + 1] = y;
      path[i * 3 + 2] = Math.sin(a) * r;
    }
    const strut = extrudeAlongSpline(section, path, 0, 0.72, {
      radius: wire * 0.92,
      color,
      material: MESH_MATERIAL.CRYSTAL,
      capStart: true,
    });
    remapSway(strut, 0, 0);
    mb.merge(strut);
  }

  // A wall-hanging basket leans off its attachment. Sheared rather than rotated
  // so the foot stays where the instance anchored it - and sheared on the
  // BUILDER, before finish(), because `finish` is what computes the aabb and the
  // boundingRadius. Shearing the built mesh left 18 vertices outside its own
  // reported box and 27 outside its radius, which is a culling bug rather than a
  // cosmetic one: the scatter pass culls on `boundingRadius`. test-meshgen is
  // what caught it.
  shearMesh(mb, Math.cos(leanAz) * lean * size, Math.sin(leanAz) * lean * size, size, 1.6);
  return finish(mb);
}

/**
 * Stacked lobed plates on one vertical attachment: a shelf sponge.
 *
 * The other half of item 3.2, and the positive replacement item 3.1's Twilight
 * Terraces cut needs - the glowcup carpet that cut removes is a LIGHT source, so
 * its replacement has to be one too, which is why this row emits and
 * `terraceStep` (item 3.3, dark) does not.
 *
 * Each plate is a lathe of a shallow dish profile, lobed by `modulate` and then
 * SHEARED so it droops away from the attachment. The outer margin of every plate
 * is retagged `MESH_MATERIAL.TRANSLUCENT`, which is a 0.20 emissive gate against
 * FLORA's 0.05: the plate body is a dull pale shelf and its RIM carries the
 * light, which is how a real shelf sponge reads when it is lit from behind and
 * is the same device `generateMushroom` uses for its gills.
 *
 * Vertices: about 660 (HIGH), 320 (MEDIUM), 160 (LOW).
 *
 * @param {number} seed
 * @param {number} [size] total height in metres
 * @param {object} [opts] {detail, color, marginColor, plates}
 */
export function generateSpongeShelf(seed, size = 3.4, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, MESH_ASSET.SPONGE_SHELF);
  const ns = assetNoiseSeed(seed, MESH_ASSET.SPONGE_SHELF);
  // Resolution is set by the biome this exists for, not by economy: the biome brief
  // gives Twilight Terraces "huge sponge forms" as its identity, and the first
  // cut delivered 296-518 vertices - under the `coral` band's own 400 floor, and
  // visibly faceted on a 5 m plate.
  const plates = byDetail(detail, 3, 4, clamp(opts.plates ?? (4 + rng.int(0, 4)), 4, 7));
  const seg = byDetail(detail, 9, 14, 24);
  const color = opts.color || MESH_PALETTE.SPONGE_PALE;
  const marginColor = opts.marginColor || MESH_PALETTE.FUNGUS_GLOW;

  const mb = new MeshBuilder(800, 2400);
  const q = Float32Array.of(0, 0, 0, 1);
  const trans = vec3.create();
  const scale = vec3.create(1, 1, 1);
  const xf = new Float32Array(16);

  // The attachment: a short tapered column the plates grow out of, off-centre
  // so the stack is not radially symmetric about its own anchor.
  {
    const stalkR = size * 0.085;
    const stalk = lathe(Float32Array.of(
      stalkR * 1.25, 0,
      stalkR, size * 0.30,
      stalkR * 0.82, size * 0.72,
      stalkR * 0.60, size * 1.0,
    ), byDetail(detail, 6, 8, 11), {
      color, material: MESH_MATERIAL.FLORA, closeBottom: true, closeTop: true,
    });
    remapSway(stalk, 0, 0);
    mb.merge(stalk);
  }

  // THE PLATE IS A DEFORMED CYLINDER AND NOT A FOLD-BACK LATHE, and that is a
  // correctness constraint. A disc built as a lathe has to run out along its
  // underside and back along its top, and `lathe` derives its profile normal
  // from a CENTRAL DIFFERENCE - which at the turning point straddles the fold
  // and points inward. Measured on the fold-back version: 555-629 back-facing
  // triangles over 8 seeds, and it moved by under 15% when the lobes, the droop
  // and the thickness were each removed in turn, which is what said the shape of
  // the profile was the cause rather than any term on it. A cylinder with caps
  // has clean topology, and everything below is a HEIGHT-FIELD-LIKE deformation
  // of it - lobes scale x and z, the droop lowers y with radius - so no vertex
  // can pass through another.
  const scratch = new MeshBuilder(320, 960);
  for (let p = 0; p < plates; p++) {
    const t = plates > 1 ? p / (plates - 1) : 0;
    const y = size * (0.16 + 0.76 * t);
    // Plates get smaller upward and alternate which side they favour, which is
    // what a bracket sponge does and what stops the stack reading as a lamp.
    const r = size * lerp(0.62, 0.34, t) * (1 + 0.12 * simplex2(p * 2.3, 1, ns));
    const thick = size * lerp(0.055, 0.032, t);
    const lobes = 3 + (p % 3);
    const phase = p * 1.7;

    scratch.vertexCount = 0;
    scratch.indexCount = 0;
    scratch.material = MESH_MATERIAL.FLORA;
    // Slightly conical: the top face is narrower, so the rim is a visible lip
    // rather than a square edge.
    scratch.merge(cylinder(r * 0.93, r, thick, seg, {
      color, material: MESH_MATERIAL.FLORA, capBottom: true, capTop: true,
    }));
    const droop = thick * 3.4;
    for (let i = 0; i < scratch.vertexCount; i++) {
      const o = i * 3;
      const x = scratch.positions[o], z = scratch.positions[o + 2];
      const rad = Math.hypot(x, z);
      const u = rad / r;
      if (rad > 1e-5) {
        const th = Math.atan2(z, x);
        const k = 1 + 0.16 * Math.sin(th * lobes + phase)
          + 0.09 * simplex2(Math.cos(th) * 2.1 + p * 3.1, Math.sin(th) * 2.1, ns);
        scratch.positions[o] = x * k;
        scratch.positions[o + 2] = z * k;
      }
      scratch.positions[o + 1] -= droop * u * u;
      // uv.y is what retagAboveV bands on, and `cylinder` writes its own; make
      // it the RADIAL parameter so "the margin" is a radius and not a height.
      scratch.uvs[i * 2 + 1] = u;
    }
    scratch.computeSmoothNormals(1.1);
    const plate = scratch.build();
    // The MARGIN, and only the margin. Above 0.72 of the plate's own radius is
    // the lip - seen from above and below, and the part light comes through.
    // TRANSLUCENT is a 0.20 emissive gate against FLORA's 0.05, so the body
    // stays a dull pale shelf and the rim carries the glow.
    retagAboveV(plate, 0.72, MESH_MATERIAL.TRANSLUCENT, marginColor);
    remapSway(plate, 0, 0);
    // The asymmetry a bracket sponge has comes from OFFSETTING each plate off
    // the stalk in a rotating direction. 2.399963 rad is the golden angle, so
    // consecutive plates never stack over each other.
    const droopAz = p * 2.399963 + rng() * 0.6;
    vec3.set(trans, Math.cos(droopAz) * r * 0.34, y, Math.sin(droopAz) * r * 0.34);
    vec3.set(scale, 1, 1, 1);
    buildTRS(xf, q, trans, scale);
    mb.merge(plate, xf);
  }

  return finish(mb);
}

// ===========================================================================
// Dark occluding mass - bedded rock and a whale fall
// ===========================================================================

/**
 * A stack of bedding planes with weathered undercuts: sedimentary rock that
 * reads as LAYERS rather than as one lump.
 *
 * IT IS A LATHE, AND THAT IS THE WHOLE TRICK. A bedding stack is a sequence of
 * horizontal plates of differing radius, which is exactly what a lathe profile
 * that steps sideways and then vertically produces - and a bed NARROWER than
 * the one above it is a real geometric overhang, not a shading one, so the
 * undercut casts and occludes for free. `modulate` then breaks the circular
 * plan into an irregular outline per bed, which is what stops it reading as a
 * wedding cake: the plan noise is offset by the bed index, so consecutive beds
 * break in different places the way real jointing does.
 *
 * ONE GENERATOR, THREE ROWS, DIFFERENTIATED BY `opts.color` AND A SLOPE BAND.
 * `shelfStrata` beds nearly flat on the Shelf Break in golden-brown,
 * `canyonLedge` projects from the Canyon and Trench walls at `align: 1.0` in
 * iron-red, and `terraceStep` lies flat in Twilight Terraces as the tread that
 * biome is named for and measures 0.82% of. The three differ by a colour and a
 * placement band and nothing else, which is deliberate: `opts.color` is already
 * plumbed through every generator here and is the cheapest axis of variation in
 * the file.
 *
 * NOTHING HERE MAY EMIT. This is the one form in the table whose whole job is
 * to be DARK - `MESH_MATERIAL.ROCK` and `SEDIMENT` both carry a
 * `slotEmissiveGate` of 0.05, and the CRYSTAL, METAL and EMISSIVE slots do not.
 * A slab that glows is the problem it was built to solve.
 *
 * Vertices: about 700 (HIGH), 340 (MEDIUM), 150 (LOW).
 *
 * @param {number} seed
 * @param {number} [size] total stack height in metres
 * @param {object} [opts] {detail, color, beds, spread}
 *   `beds` 3..10 bedding planes; `spread` the plan radius as a multiple of the
 *   height, default 1.5-2.2 - a bedded ledge is much wider than it is tall, and
 *   that ratio is what makes it read as strata rather than as a tower.
 */
export function generateStratumSlab(seed, size = 7, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, MESH_ASSET.STRATUM_SLAB);
  const ns = assetNoiseSeed(seed, MESH_ASSET.STRATUM_SLAB);
  const seg = byDetail(detail, 10, 16, 26);
  const beds = clamp(opts.beds ?? (4 + rng.int(0, 6)), 3, 10);
  // Radius as a multiple of HEIGHT. A bedded outcrop is wider than it is tall
  // and not by very much: 0.85-1.35 puts a 7 m stack at 12-19 m across, which
  // reads as strata. The 1.5-2.2 this started at made a 32 m pancake.
  const spread = opts.spread ?? lerp(0.85, 1.35, rng());
  const rBase = size * spread;
  const color = opts.color || MESH_PALETTE.BASALT_DARK;

  // Two rings per bed - the bed's own top and bottom - plus a closing ring, so
  // the profile alternates a vertical face and a horizontal shelf. The RADIUS
  // sequence is what decides where the overhangs are, and it is deliberately
  // NOT monotonic: a strictly narrowing stack is a cone and occludes nothing
  // from below.
  const rings = beds * 2 + 1;
  const profile = new Float32Array(rings * 2);
  const bedR = new Float32Array(beds);
  let widest = 0;
  for (let b = 0; b < beds; b++) {
    const t = b / Math.max(beds - 1, 1);
    // A general taper with a per-bed excursion. The excursion is what puts a
    // resistant bed proud of the one under it, which is the undercut.
    const taper = lerp(1.0, 0.46, t * t);
    const jut = 1 + 0.30 * Math.sin((b + 0.5) * 2.399963) + 0.12 * simplex2(b * 1.7, 0, ns);
    bedR[b] = rBase * taper * clamp(jut, 0.55, 1.35);
    if (bedR[b] > widest) widest = bedR[b];
  }
  // UNEVEN BED THICKNESSES, because that is where the per-bed variety has to
  // live. See the modulate note below for why it cannot live in the plan.
  const thick = new Float32Array(beds);
  let thickSum = 0;
  for (let b = 0; b < beds; b++) {
    thick[b] = lerp(0.55, 1.6, (simplex2(b * 2.9, 7, ns) + 1) * 0.5);
    thickSum += thick[b];
  }
  let w = 0, y = 0;
  for (let b = 0; b < beds; b++) {
    const y0 = y;
    y += (thick[b] / thickSum) * size;
    profile[w * 2] = bedR[b]; profile[w * 2 + 1] = y0; w++;
    profile[w * 2] = bedR[b]; profile[w * 2 + 1] = y; w++;
  }
  // Close to a small crown rather than to a point: a bedded ledge is truncated,
  // not peaked, and a zero radius here would make the top ring a fan of slivers.
  profile[w * 2] = bedR[beds - 1] * 0.34; profile[w * 2 + 1] = size * 1.02; w++;

  const mesh = lathe(profile, seg, {
    color,
    material: MESH_MATERIAL.ROCK,
    closeBottom: true,
    closeTop: true,
    // ONE PLAN OUTLINE, SHARED BY EVERY BED, AND THAT IS A CORRECTNESS
    // CONSTRAINT RATHER THAN A STYLE CHOICE. Two rings of a bedding SHELF sit at
    // the same y with different radii; if their angular outlines are allowed to
    // differ, the two curves cross wherever the noise closes the radius gap and
    // the annulus between them folds through itself. Measured on the first
    // version, which offset the plan noise per bed: 8 back-facing triangles at
    // the shipped seed, and tools/test-meshgen.mjs is what caught it. With one
    // shared outline every ring radius is `bedR[b] * O(theta)`, strictly
    // proportional, so two rings cross only where bedR itself is equal - and it
    // never is. The variety that offsetting was supposed to buy lives in the
    // uneven bed thicknesses and in the non-monotonic bedR sequence instead,
    // which is also the more honest model: jointing is a property of the
    // outcrop, not of each bed separately.
    modulate: (ringT, theta) => {
      const plan = simplex2(Math.cos(theta) * 1.9, Math.sin(theta) * 1.9, ns);
      const grain = simplex2(Math.cos(theta) * 7.3, Math.sin(theta) * 7.3, ns ^ 21);
      return 1 + 0.19 * plan + 0.055 * grain;
    },
  });
  return mesh;
}

/**
 * Crimson Meadow rock pillar: a narrow stratified stem rising to a wide flared
 * flat-topped cap with a rounded overhanging lip, crowned by a tuft of crimson
 * grass blades on the cap top near the rim. Some seeds grow a smaller
 * secondary tier part-way up, under the main cap.
 *
 * ONE lathe with ONE plan outline shared by every ring, the generateStratumSlab
 * correctness constraint: two rings of a bedding shelf sit at the same y with
 * different radii, and per-ring plan noise lets their outlines cross and folds
 * the annulus through itself (8 back-facing triangles on the slab's first
 * version; tools/test-meshgen.mjs is what caught it). With one shared outline
 * every ring is `r * O(theta)`, strictly proportional, so shelves never fold.
 * The overhangs therefore live entirely in the PROFILE: a non-monotonic bed
 * radius sequence on the stem, and a concave trumpet flare whose widest ring is
 * the lip, well above the underside it shades.
 *
 * The banding is vertex colour, not geometry: recessed beds and the cap
 * underside are darkened (AO-ish), classified by POSITION y rather than uv,
 * because the lathe's cap fans carry radial uvs that would misclassify.
 *
 * The lean is shearMesh on the BUILDER, BEFORE finish(): finish() computes the
 * aabb and the boundingRadius the scatter pass culls on, and shearing after it
 * is the 2026-08-06 lattice bug (vertices outside their own bounds).
 *
 * Vertices: about 740 (HIGH), 490 (MEDIUM), 320 (LOW).
 *
 * @param {number} seed
 * @param {number} [height] total metres
 * @param {object} [opts] {detail, capRadius, beds, color, crownColor, crown}
 *   `capRadius` default height * 0.36; `beds` 3..5 stem strata; `crown` blade
 *   count on the cap top (thinned at lower tiers).
 */
export function generateMeadowPillar(seed, height = 17, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, MESH_ASSET.MEADOW_PILLAR);
  const ns = assetNoiseSeed(seed, MESH_ASSET.MEADOW_PILLAR);
  const seg = byDetail(detail, 9, 13, 18);
  const cap = opts.capRadius ?? height * 0.36;
  const beds = clamp(opts.beds ?? (3 + rng.int(0, 2)), 3, 5);
  const crown = Math.max(0, Math.round((opts.crown ?? 12) * byDetail(detail, 0.4, 0.7, 1)));
  // The reference silhouette's whole read is the stem-to-cap ratio: the stem is
  // NARROW, about 0.19 of the cap radius, so the cap genuinely overhangs.
  // (0.15 shipped first and read as a wine glass on delivered frames - the
  // stem was a straw; 0.19 keeps the overhang while the strata stay legible.)
  const stemR = cap * 0.19 * lerp(0.9, 1.15, rng());
  const color = opts.color || MESH_PALETTE.MEADOW_ROCK;
  const crownColor = opts.crownColor || MESH_PALETTE.BLOOD_GRASS;

  // Stem strata: a non-monotonic radius sequence (the overhangs) with uneven
  // thicknesses, both stratumSlab's model - jointing is a property of the
  // outcrop, not of each bed.
  const jut = new Float32Array(beds);
  for (let b = 0; b < beds; b++) {
    jut[b] = clamp(1 + 0.22 * Math.sin((b + 0.7) * 2.399963)
      + 0.10 * simplex2(b * 1.9, 3, ns), 0.72, 1.32);
  }
  // Adjacent beds must differ by a REAL step. A near-equal pair leaves a
  // sliver shelf whose vertical geometric normal loses the flipped-triangle
  // vote to its own face-averaged vertex normals: measured, 16 back-facing
  // triangles at cos -0.01..-0.04 on the first seed this shipped against.
  // The range is 0.60 wide, so one of the two directions always fits.
  for (let b = 1; b < beds; b++) {
    const d = jut[b] - jut[b - 1];
    if (Math.abs(d) < 0.12) {
      const up = jut[b - 1] + 0.12, down = jut[b - 1] - 0.12;
      jut[b] = d >= 0 ? (up <= 1.32 ? up : down) : (down >= 0.72 ? down : up);
    }
  }
  const thick = new Float32Array(beds);
  let thickSum = 0;
  for (let b = 0; b < beds; b++) {
    thick[b] = lerp(0.6, 1.5, (simplex2(b * 2.7, 9, ns) + 1) * 0.5);
    thickSum += thick[b];
  }

  const skirtTop = height * 0.04;
  // The profile's y must only ever advance: on tier seeds the beds stop short
  // of the tier shelf (0.55h), on the rest they climb to 0.74h so the strata
  // stay legible up the whole stem. (A tier pushed below bedsY1 reverses y and
  // folds the lathe - measured, 30 back-facing triangles.)
  const tier = rng() < 0.45;
  const bedsY0 = height * 0.055, bedsY1 = height * (tier ? 0.52 : 0.74);
  const rimY = height * 0.925;
  const rings = 2 + beds * 2 + (tier ? 2 : 0) + 9;
  const profile = new Float32Array(rings * 2);
  const bedY = new Float32Array(beds + 1);
  let w = 0;
  const push = (r, y) => { profile[w * 2] = r; profile[w * 2 + 1] = y; w++; };
  // Pedestal skirt: the pillars rise out of sediment mounds in the reference.
  push(stemR * 2.6, 0);
  push(stemR * 1.7, skirtTop);
  let y = bedsY0;
  bedY[0] = bedsY0;
  // Each bed stops a small chamfer short of the next, so the ledge between
  // them is a ~45 degree weathered step rather than a flat annulus. The slope
  // is a flipped-triangle margin, not a style choice: it moves the ledge's
  // geometric normal toward the crease-averaged vertex normals.
  const chamfer = height * 0.009;
  for (let b = 0; b < beds; b++) {
    const y0 = y;
    y += (thick[b] / thickSum) * (bedsY1 - bedsY0);
    push(stemR * jut[b], y0);
    push(stemR * jut[b], y - chamfer);
    bedY[b + 1] = y;
  }
  // Optional secondary tier: a small overhanging shelf part-way up the stem,
  // with the stem re-narrowing above it (0.40 -> stem beds again).
  if (tier) {
    push(cap * 0.40, height * 0.55);
    push(cap * 0.40, height * 0.585);
  }
  // The cap is a THICK DISC, not a funnel: the first delivered frames read as
  // wine glasses because the flare occupied the top third of the pillar. The
  // underside now flares fast over ~13% of the height, then a tall vertical
  // rim, a rounded lip and the flat top, closed to a small crown ring.
  push(cap * 0.26, height * 0.775);
  push(cap * 0.46, height * 0.825);
  push(cap * 0.78, height * 0.875);
  push(cap * 0.96, height * 0.905);
  push(cap * 1.00, rimY);
  push(cap * 1.00, height * 0.965);
  push(cap * 0.955, height * 0.985);
  push(cap * 0.78, height * 0.996);
  push(cap * 0.34, height);

  const stem = lathe(profile, seg, {
    color,
    material: MESH_MATERIAL.ROCK,
    closeBottom: true,
    closeTop: true,
    uScale: 3,
    // Theta-only, shared by every ring: see the fold constraint in the JSDoc.
    modulate: (ringT, theta) => {
      const plan = simplex2(Math.cos(theta) * 1.7, Math.sin(theta) * 1.7, ns);
      const grain = simplex2(Math.cos(theta) * 6.9, Math.sin(theta) * 6.9, ns ^ 21);
      return 1 + 0.14 * plan + 0.045 * grain;
    },
  });

  // Vertex-colour banding, classified by y (see JSDoc for why not uv): recessed
  // beds darker in proportion to how far they sit inside the proudest bed, the
  // cap underside darkened toward its deepest shade at the stem.
  const flareA = height * 0.775;
  for (let i = 0; i < stem.vertexCount; i++) {
    const vy = stem.positions[i * 3 + 1];
    let s = 1;
    if (vy <= skirtTop + 1e-4) s = 0.94;
    else if (vy < bedsY1) {
      let b = 0;
      while (b < beds - 1 && vy > bedY[b + 1]) b++;
      // 0.78 floor: the first frames washed the banding out to near-white
      // under the blue column, so the recessed beds darken harder.
      s = 0.78 + 0.22 * ((jut[b] - 0.72) / 0.60);
    } else if (vy < rimY) {
      s = lerp(0.78, 0.98, saturate((vy - flareA) / (rimY - flareA)));
    }
    stem.colors[i * 4] *= s;
    stem.colors[i * 4 + 1] *= s;
    stem.colors[i * 4 + 2] *= s;
  }

  const mb = new MeshBuilder(stem.vertexCount + crown * 32, stem.indexCount + crown * 96);
  mb.merge(stem);

  // Slight whole-mesh lean; shear rather than rotate so y = 0 stays planted.
  // Drawn BEFORE the crown loop, whose iteration count varies with detail -
  // drawn after it, the lean direction would change across the LOD chain and
  // the pillar would visibly snap sideways at every LOD swap.
  const lean = lerp(0.01, 0.055, rng());
  const leanAz = rng() * TAU;
  const leanX = Math.cos(leanAz) * lean * height;
  const leanZ = Math.sin(leanAz) * lean * height;
  // The shear tilts the STEM surface, so re-derive its shading here, before
  // the blades arrive: extrudeAlongSpline's section normals are analytic and
  // must STAY analytic (see capSectionRing) - running the recompute over the
  // merged mesh let the blade end caps out-vote their side bands, measured as
  // 48 back-facing triangles, one fan per crown blade. Welding keeps the
  // lathe's u seam smooth while the bed ledges stay creased.
  shearMesh(mb, leanX, leanZ, height);
  mb.computeSmoothNormals(1.0);

  // Crown: crimson blades rooted through the cap top near the rim. Bases sit
  // 0.032 * height BELOW the plateau so every root is embedded whatever the
  // plan outline does locally; sqrt biases the radial spread toward the rim.
  // Roots take the shear displacement of their own y instead of being sheared,
  // which keeps the blade geometry (and its analytic normals) rigid.
  const stations = byDetail(detail, 3, 4, 5);
  const section = lensSection(0.18);
  const path = new Float32Array(stations * 3);
  // Rim-biased: the crown must silhouette OVER the lip when seen from below
  // (the reference's red fringe); blades buried in the middle of a 6 m cap
  // 17 m up were invisible in every first-pass frame.
  const topR = cap * 0.86;
  const rootY = height * 0.972;
  const shearT = Math.pow(rootY / height, 2);
  for (let b = 0; b < crown; b++) {
    const az = b * 2.399963 + rng() * 0.6;
    const rr = topR * (0.62 + 0.38 * Math.sqrt(rng()));
    const len = cap * 0.34 * lerp(0.7, 1.3, rng());
    const curl = lerp(0.5, 1.0, rng());
    fillCurvedSpline(path, stations,
      Math.cos(az) * rr + leanX * shearT, rootY, Math.sin(az) * rr + leanZ * shearT,
      rng() * TAU, len, curl, 0.08, ns + b * 13);
    const blade = extrudeAlongSpline(section, path, 0.25, 0.18, {
      radius: len * 0.045,
      color: crownColor,
      material: MESH_MATERIAL.FLORA,
      swayExponent: 0.9,
    });
    mb.merge(blade);
  }
  return finish(mb);
}

const _xfBulb = new Float32Array(16);

/**
 * A bulb tree: a large spherical bulb densely furred with radial spikes,
 * carried on a cluster of pale smooth trunks, studded with small glowing
 * fruits nested between the spikes. The Bulb Grove's whole skyline
 * (its art-direction reference's big purple pom trees with blue berries),
 * and the small teal ground poms of the same reference via
 * `opts.ground`.
 *
 * THE FUR IS REAL GEOMETRY, NOT DISPLACEMENT. A noise-displaced sphere was
 * considered and rejected on the reference read: the silhouette the image is
 * about is individual spikes CROSSING the water behind the bulb, and a
 * displaced sphere's silhouette is a wobbly circle. Each spike is 4 vertices
 * (3-vertex base ring + tip, 3 side triangles, no base cap - the open base
 * sits against the core sphere and cannot be seen). Spike count scales with
 * bulb AREA (SPIKES_PER_M2) so the fur density reads the same on a 3 m crown
 * and a 0.7 m pom.
 *
 * COLOUR IS A GRADIENT ACROSS ONE SPIKE: base ring takes the bulb colour,
 * tip takes the pale tip colour - that per-spike value ramp is what makes
 * the bulb read as lit fur rather than a purple ball at every distance the
 * grove is framed at. The fruits are MESH_MATERIAL.EMISSIVE (slot gate 1.0)
 * against the spikes' FLORA (gate 0.05), so the scatter row's emissive
 * drives the berries at full strength while the tissue stays dark - same
 * split as the giant kelp's crown fruit.
 *
 * Vertices at HIGH, tree defaults (measured over 8 seeds by test-meshgen's
 * registry entry): about 1,900 with the secondary bulb, inside the landmark
 * band. Sapling (height 3.2, trunks 1, no secondary): about 500. Ground pom
 * (height 1.1): about 350.
 *
 * @param {number} seed
 * @param {number} [height] total height, metres (ground mode: pom diameter-ish)
 * @param {object} [opts] {detail, bulbRadius, trunks, fruit, spikes,
 *   secondary, ground, color, deepColor, tipColor, trunkColor, fruitColor}
 */
export function generateBulbTree(seed, height = 9.5, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, MESH_ASSET.BULB_TREE);
  const ns = assetNoiseSeed(seed, MESH_ASSET.BULB_TREE);
  const ground = !!opts.ground;
  const color = opts.color || MESH_PALETTE.BULB_PURPLE;
  const deepColor = opts.deepColor || MESH_PALETTE.BULB_PURPLE_DEEP;
  const tipColor = opts.tipColor || MESH_PALETTE.BULB_TIP;
  const trunkColor = opts.trunkColor || MESH_PALETTE.BULB_TRUNK;
  const fruitColor = opts.fruitColor || MESH_PALETTE.BULB_FRUIT;

  // 0.24, walked down from 0.34 across three review rounds: a smaller crown
  // is the other half of fur density - the needle budget covers a 2.6 m
  // sphere at reference nap spacing where it left a 3.2 m one bald. The
  // trunk's visible run also grows with it (the reference's is ~0.6 of the
  // bulb diameter).
  const r = opts.bulbRadius ?? height * (ground ? 0.46 : 0.24);
  // 0.44: fewer, longer, fatter spikes is the naval-mine direction; the
  // reference is short dense nap.
  const spikeLen = r * 0.44;
  // Tree: bulb centre placed so tip-of-fur ~= height. Ground pom: partially
  // settled into the sand (the row's sink buries the rest).
  const yc = ground ? r * 0.78 : height - r - spikeLen;

  const mb = new MeshBuilder(2048, 6144);
  // PER BULB, NOT PER SQUARE METRE, and the unit is the finding. The first
  // pass built 4-vertex open cones at 1.75/m^2 and the delivered bulbs read
  // as naval mines; the second kept the areal rule with crossed needles and
  // the TREES filled in while every SAPLING and ground pom stayed a bald
  // ball with ~15 spikes - constant fur per m^2 is constant NOTHING per
  // bulb once the bulb is small, and the reference's small poms are exactly
  // as furry as its crowns. Count therefore scales with the bulb's RADIUS
  // RATIO to the primary (linear), spike length/width already scale with R,
  // and `opts.spikes` overrides the base for the flora-band variants (the
  // sapling/pom rows author it; 400 needles on a sapling blows flora's
  // 1,250-vertex band). 400, up from 250, together with the smaller crown
  // and the dedicated `fur` vertex band in test-meshgen: review round 2
  // measured the 250-needle crown as "sparse hard blades on a bald core",
  // and the fix is genuinely more needles, not wider ones.
  const SPIKES_PER_BULB = 400;
  const detailMul = byDetail(detail, 0.35, 0.65, 1);
  const fruitBase = opts.fruit ?? (ground ? 4 : 22);

  const _dir = vec3.create();
  const _t = vec3.create();
  const _b = vec3.create();
  const _bp = vec3.create();
  const _tp = vec3.create();
  const _sn = vec3.create();

  /**
   * One 6-vertex CROSSED needle: two flat triangles at 90 degrees about the
   * spike axis, sharing a tip direction. A single flat triangle was tried
   * first and the camera-facing half of every bulb read BALD - a triangle
   * whose plane contains the radial axis has zero projected area seen along
   * that axis, so the fur existed only on the silhouette. The cross is the
   * grass-card answer: at least one blade of every pair is visible from any
   * direction. The row must author `twoSided: true` or half of each blade
   * vanishes seen from behind. All normals are each triangle's own geometric
   * normal, which keeps test-meshgen's flipped-triangle vote at cos = 1
   * exactly (a radial "fur" normal sits at ~0 and loses it).
   */
  const emitSpike = (cx, cy, cz, R, dx, dy, dz, len, rb, sway) => {
    mb.material = MESH_MATERIAL.FLORA;
    vec3.set(_dir, dx, dy, dz);
    // Random tangent frame, so needle planes vary and the fur never reads as
    // a geodesic pattern.
    if (Math.abs(dy) < 0.9) vec3.set(_t, 0, 1, 0); else vec3.set(_t, 1, 0, 0);
    vec3.cross(_b, _dir, _t); vec3.normalize(_b, _b);
    vec3.cross(_t, _b, _dir);
    const ba = rng() * TAU;
    const bx = cx + dx * R, by = cy + dy * R, bz = cz + dz * R;
    // One shared, laterally drifted tip position for both blades, so the
    // cross stays a single needle rather than two.
    const driftA = rb * lerp(-1.2, 1.2, rng());
    const driftB = rb * lerp(-1.2, 1.2, rng());
    for (let half = 0; half < 2; half++) {
      const a = ba + half * (Math.PI / 2);
      const ca = Math.cos(a), sa = Math.sin(a);
      vec3.set(_sn,
        _t[0] * ca + _b[0] * sa,
        _t[1] * ca + _b[1] * sa,
        _t[2] * ca + _b[2] * sa);
      const base = mb.vertexCount;
      vec3.set(_bp, bx - _sn[0] * rb, by - _sn[1] * rb, bz - _sn[2] * rb);
      vec3.set(_tp, bx + _sn[0] * rb, by + _sn[1] * rb, bz + _sn[2] * rb);
      vec3.set(_t0,
        bx + dx * len + _t[0] * driftA + _b[0] * driftB,
        by + dy * len + _t[1] * driftA + _b[1] * driftB,
        bz + dz * len + _t[2] * driftA + _b[2] * driftB);
      // Geometric normal of (bp, tp, tip): cross(tp - bp, tip - bp).
      vec3.sub(_t1, _tp, _bp);
      vec3.sub(_d, _t0, _bp);
      vec3.cross(_n, _t1, _d);
      vec3.normalize(_n, _n);
      _uv[0] = 0; _uv[1] = 0;
      _col[0] = color[0]; _col[1] = color[1]; _col[2] = color[2]; _col[3] = sway;
      mb.addVertex(_bp, _n, _uv, _col);
      _uv[0] = 1;
      mb.addVertex(_tp, _n, _uv, _col);
      _uv[0] = 0.5; _uv[1] = 1;
      _col[0] = tipColor[0]; _col[1] = tipColor[1]; _col[2] = tipColor[2];
      // The tip carries a little extra sway so the fur shimmers before the
      // bulb itself moves.
      _col[3] = Math.min(1, sway * 1.5);
      mb.addVertex(_t0, _n, _uv, _col);
      mb.addTriangle(base, base + 1, base + 2);
    }
  };

  /** One furred bulb with its fruit, centred at (cx, cy, cz). */
  const emitBulb = (cx, cy, cz, R, fruitCount, sway) => {
    // Core: what shows between the spikes - IN THE FUR COLOUR, not the deep
    // shade. With a dark core the review read every bulb as "a navy ball
    // with spikes on it"; matched to the fur, the gaps disappear and the
    // bulb reads as one furred volume. deepColor survives as the pom
    // variant's override channel.
    const core = icosphere(byDetail(detail, 1, 1, 2), R * 0.93, {
      color, material: MESH_MATERIAL.FLORA,
    });
    const q = Float32Array.of(0, 0, 0, 1);
    vec3.set(_t0, cx, cy, cz);
    vec3.set(_t1, 1, 1, 1);
    buildTRS(_xfBulb, q, _t0, _t1);
    let start = mb.vertexCount;
    mb.merge(core, _xfBulb);
    mb.setSwayRange(start, mb.vertexCount - start, sway);

    const n = Math.max(30, Math.round(
      (opts.spikes ?? SPIKES_PER_BULB) * (R / r) * detailMul));
    // Needle half-width: fine nap, not fat cones.
    const rb = Math.max(0.018, R * 0.050);
    // Fibonacci sphere: even fur with no poles or seams.
    const ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + 0.5)) / n;
      const rad = Math.sqrt(Math.max(0, 1 - y * y));
      const az = i * ga + rng() * 0.22;
      const dx = Math.cos(az) * rad, dz = Math.sin(az) * rad;
      // Ground poms keep a bald underside (it is in the sand); trees keep
      // only a small trunk-socket bald spot - the crown's underside is what
      // a swimmer beneath it actually sees, and at the first -0.8 threshold
      // it read as a smooth purple umbrella from below.
      if (y < (ground ? -0.55 : -0.97)) continue;
      // Direction jitter off pure radial, and length jitter, so the fur is
      // hair rather than a geodesic dome.
      const jx = dx + (rng() - 0.5) * 0.28;
      const jy = y + (rng() - 0.5) * 0.28;
      const jz = dz + (rng() - 0.5) * 0.28;
      const inv = 1 / Math.hypot(jx, jy, jz);
      // TWO NAP LAYERS from one loop: every third needle is a short underfur
      // stub. The long layer draws the silhouette; the stubs fill the gaps
      // between the long roots so the core reads as fur depth, not membrane.
      const under = (i % 3) === 2;
      const len = spikeLen * (R / r)
        * (under ? lerp(0.30, 0.45, rng()) : lerp(0.70, 1.12, rng()));
      emitSpike(cx, cy, cz, R * 0.95, jx * inv, jy * inv, jz * inv, len, rb,
        Math.min(1, sway + 0.1));
    }

    // Fruit: seated at the fur roots (0.98R - round 1 had them perched at
    // 1.03R as foam blobs, round 2 buried them at 0.92R and they vanished
    // entirely; at 0.98R the berry's outer half stands proud of the core
    // between the needles), upper-biased the way berries catch light in the
    // reference. EMISSIVE slot - the row's emissive drives them. 0.085R:
    // large enough to be legible at 10-15 m in daylight, still well under
    // the round-1 melons.
    const fr = Math.max(2, Math.round(fruitCount * byDetail(detail, 0.4, 0.7, 1)));
    const berry = icosphere(0, R * 0.085, {
      color: fruitColor, material: MESH_MATERIAL.EMISSIVE,
    });
    for (let f = 0; f < fr; f++) {
      const y = 1 - 1.55 * (f + 0.5) / fr;   // upper ~78% of the sphere
      const rad = Math.sqrt(Math.max(0, 1 - y * y));
      const az = f * ga * 2.7 + rng() * TAU * 0.2;
      vec3.set(_t0,
        cx + Math.cos(az) * rad * R * 0.98,
        cy + y * R * 0.98,
        cz + Math.sin(az) * rad * R * 0.98);
      const s = lerp(0.8, 1.2, rng());
      vec3.set(_t1, s, s, s);
      buildTRS(_xfBulb, q, _t0, _t1);
      start = mb.vertexCount;
      mb.merge(berry, _xfBulb);
      mb.setSwayRange(start, mb.vertexCount - start, sway);
    }
  };

  // ---- trunks --------------------------------------------------------------
  if (!ground) {
    const trunks = Math.max(1, opts.trunks ?? 3);
    const stations = byDetail(detail, 3, 4, 5);
    const seg = byDetail(detail, 5, 6, 8);
    const path = new Float32Array(stations * 3);
    const trunkTopY = yc - r * 0.35;
    for (let t = 0; t < trunks; t++) {
      const az = (t / trunks) * TAU + rng() * 0.9;
      const spread = r * lerp(0.35, 0.62, rng());
      const bx = Math.cos(az) * spread, bz = Math.sin(az) * spread;
      // Quadratic bow: out at the base, converging into the bulb underside.
      // Ends INSIDE the core sphere so the junction is never visible.
      // 1.25-1.9: review round 2 read straight trunks as ice pillars; the
      // reference stems are sinuous.
      const midBow = lerp(1.25, 1.9, rng());
      for (let s = 0; s < stations; s++) {
        const u = s / (stations - 1);
        const bow = 1 + (midBow - 1) * 4 * u * (1 - u);
        path[s * 3] = lerp(bx * bow, bx * 0.18, u * u);
        path[s * 3 + 1] = -0.25 + (trunkTopY + 0.25) * u;
        path[s * 3 + 2] = lerp(bz * bow, bz * 0.18, u * u);
      }
      const trunk = extrudeAlongSpline(unitCircle(seg), path, 0.0, 0.55, {
        // Slimmed 0.13-0.17 -> 0.095-0.125 r on the underside review: three
        // 0.5 m columns under a 3 m crown read as marble pillars.
        radius: r * lerp(0.095, 0.125, rng()),
        color: trunkColor,
        // FLORA, not BONE: boneSurface's porous speckle read as dirty marble
        // on a 4 m column at arm's length; the reference stems are smooth.
        material: MESH_MATERIAL.FLORA,
        swayExponent: 1.6,
      });
      // Trunks are the stiff part: their sway tops out where the bulb's begins.
      remapSway(trunk, 0, 0.35);
      mb.merge(trunk);
    }
  }

  // ---- bulbs ---------------------------------------------------------------
  emitBulb(0, yc, 0, r, fruitBase, ground ? 0.25 : 0.4);
  if (!ground && (opts.secondary ?? (height > 6)) && rng() < 0.85) {
    // A smaller companion bulb on its own leaning trunk, the reference's
    // paired-crown silhouette.
    const az2 = rng() * TAU;
    const r2 = r * lerp(0.48, 0.58, rng());
    const cx2 = Math.cos(az2) * r * 1.45;
    const cz2 = Math.sin(az2) * r * 1.45;
    const yc2 = yc * lerp(0.5, 0.62, rng());
    const stations = byDetail(detail, 3, 4, 5);
    const path = new Float32Array(stations * 3);
    for (let s = 0; s < stations; s++) {
      const u = s / (stations - 1);
      path[s * 3] = cx2 * (0.25 + 0.75 * u);
      path[s * 3 + 1] = -0.25 + (yc2 - r2 * 0.2 + 0.25) * u;
      path[s * 3 + 2] = cz2 * (0.25 + 0.75 * u);
    }
    const trunk = extrudeAlongSpline(unitCircle(byDetail(detail, 5, 6, 8)), path,
      0.0, 0.6, {
        radius: r2 * 0.22,
        color: trunkColor,
        material: MESH_MATERIAL.BONE,
        swayExponent: 1.6,
      });
    remapSway(trunk, 0, 0.3);
    mb.merge(trunk);
    emitBulb(cx2, yc2, cz2, r2, Math.round(fruitBase * 0.35), 0.35);
  }

  return finish(mb);
}

const _xfPlatter = new Float32Array(16);
const _qPlatter = Float32Array.of(0, 0, 0, 1);

/**
 * A platter spire: a tall encrusted rock column carrying a stack of broad
 * horizontal platters - the Platter Forest's whole skyline
 * (its art-direction reference: trunks like drowned redwoods, each
 * ringed by lily-pad shelves, orange growth on the bark, warm light under
 * the platter rims, pink ring-corals perched on the tops).
 *
 * EACH PLATTER IS ONE CONTINUOUS LATHE from the top centre, over a domed
 * top, around a ROUNDED rim into the underside, ending at a small inner
 * radius buried inside the trunk. The rounded rim carries four profile
 * stations across its curvature on purpose: lathe() takes its normals from
 * central differences on the profile, and the sponge-shelf fold-back bug
 * (555-629 back-facing triangles, see the shipped sponge plate) was a SHARP
 * fold that made those differences straddle the turn. Kept smooth, the same
 * mechanism gives a correct rim normal for free; test-meshgen's
 * flipped-triangle vote is the regression guard.
 *
 * COLOUR AND MATERIAL ARE ZONED AFTER THE FACT: the platter is lathed in one
 * colour, then its vertex arrays are rewritten by zone (domed top -> sage
 * turf SEDIMENT, underside rim band -> warm-orange EMISSIVE tissue, inner
 * underside -> rust SEDIMENT) before the merge copies them. The EMISSIVE
 * band is the row's orange glow, and it lands on downward-facing rim tissue
 * exactly where glowSurface()'s `under` term boosts it - the reference's
 * lit-from-within platter rims, self-powered because PLATTER_TEAL keeps
 * almost no red daylight to reflect. The trunk gets the same treatment with
 * simplex3 patches of PLATTER_RUST over PLATTER_ROCK, so the encrustation
 * follows world-stable noise rather than uv seams.
 *
 * Vertices at HIGH, tree defaults (measured over 8 seeds by test-meshgen's
 * registry entry): about 1,800 - inside the landmark band. The young
 * variant (height 14, platters 3) is about 800, inside `structure`.
 *
 * @param {number} seed
 * @param {number} [height] total height, metres
 * @param {object} [opts] {detail, platters, baseRadius, rockColor,
 *   rustColor, topColor, rimColor}
 */
export function generatePlatterSpire(seed, height = 46, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, MESH_ASSET.PLATTER_SPIRE);
  const ns = assetNoiseSeed(seed, MESH_ASSET.PLATTER_SPIRE);
  const rockColor = opts.rockColor || MESH_PALETTE.PLATTER_ROCK;
  const rustColor = opts.rustColor || MESH_PALETTE.PLATTER_RUST;
  const topColor = opts.topColor || MESH_PALETTE.PLATTER_TOP;
  const rimColor = opts.rimColor || MESH_PALETTE.PLATTER_RIM;

  const mb = new MeshBuilder(2048, 6144);
  // Pad segments 18 at HIGH: the 2026-08-18 playtest asked for MUCH bigger
  // platters ("so we can drive our vessel between the big platters"), and a
  // 30 m pad at 14 segments reads as a nut. The count went 8 -> 5 in the
  // same rework, which is what pays for the segments AND opens the vertical
  // gaps the vessel flies through.
  // Segments scale with the pad size they have to carry: 24 at HIGH on the
  // 46 m landmark's 26-31 m crown (the review read 18 as "hexagonal
  // plates"), stepped down on the young column whose pads are 4-5 m - the
  // same arc length per segment, and what keeps the young row inside the
  // structure vertex band.
  const seg = height < 24 ? byDetail(detail, 10, 12, 16) : byDetail(detail, 14, 18, 24);
  const trunkSeg = byDetail(detail, 8, 10, 12);

  // ---- trunk ---------------------------------------------------------------
  // A gently bowing column: enough drift that two spires never read as
  // extrusions of one prototype, little enough that a 46 m trunk still
  // reads structural. Base radius ~H/15: the vessel-scale rework raised the
  // height, and a 0.078 ratio at 46 m made a 3.6 m pillar that crowded the
  // fly-through lanes.
  // 0.085, up from 0.062 on the adversarial review: "sapling-thin relative
  // to their height" - the reference trunks are massive.
  const baseR = opts.baseRadius ?? height * 0.085;
  const stations = byDetail(detail, 7, 9, 12);
  const leanAz = rng() * TAU;
  const lean = height * lerp(0.02, 0.07, rng());
  // Small rng-drawn noise-domain offsets: putting the raw uint32 seed into a
  // simplex coordinate costs float precision at ~1e8 and correlates streams.
  const no1 = rng() * 64, no2 = rng() * 64;
  const path = new Float32Array(stations * 3);
  for (let s = 0; s < stations; s++) {
    const u = s / (stations - 1);
    // Quadratic lean plus a low-frequency wander; starts 1.5 m under the
    // seabed so a sloped footing never shows an open ring.
    const wobble = simplex2(u * 2.1, no1, ns) * height * 0.02;
    path[s * 3] = Math.cos(leanAz) * lean * u * u + wobble;
    path[s * 3 + 1] = -1.5 + (height + 1.5) * u;
    path[s * 3 + 2] = Math.sin(leanAz) * lean * u * u - wobble * 0.6;
  }
  const trunk = extrudeAlongSpline(unitCircle(trunkSeg), path, 0.0, 0.55, {
    radius: baseR,
    color: rockColor,
    // SEDIMENT, not ROCK: the review measured the delivered trunks as a pale
    // smooth sheen LIGHTER than the water behind them, on a 1.4% albedo -
    // the specular term on a broad smooth cylinder, not the diffuse. The
    // sediment slot is "very rough, no specular to speak of", which is what
    // a crusted column is.
    material: MESH_MATERIAL.SEDIMENT,
    // Bark relief: the section swells and pinches along the run, so the
    // silhouette is a weathered column rather than a cone.
    scaleFn: (t) => 1 + 0.14 * simplex2(t * 3.3, no2, ns ^ 1),
  });
  // Rock does not sway.
  remapSway(trunk, 0, 0);
  let start = mb.vertexCount;
  mb.merge(trunk);
  // Encrustation: world-stable simplex patches of rust over the stone, with
  // a second octave breaking the patch edges. Painted on the merged range so
  // the noise samples the trunk's real object-space positions.
  for (let i = start; i < mb.vertexCount; i++) {
    const p3 = i * 3;
    const px = mb.positions[p3], py = mb.positions[p3 + 1], pz = mb.positions[p3 + 2];
    let n = simplex3(px * 0.42, py * 0.42, pz * 0.42, ns ^ 2)
      + 0.5 * simplex3(px * 1.7, py * 1.7, pz * 1.7, ns ^ 3);
    // Threshold widened 0.28/0.62 -> 0.14/0.50 on the first frames: the
    // reference trunks are MOSTLY encrusted, stone showing between patches.
    const rust = smoothstep(0.08, 0.42, n * 0.667);
    const c4 = i * 4;
    mb.colors[c4] = lerp(rockColor[0], rustColor[0], rust);
    mb.colors[c4 + 1] = lerp(rockColor[1], rustColor[1], rust);
    mb.colors[c4 + 2] = lerp(rockColor[2], rustColor[2], rust);
    // Rust patches are mats, not stone.
    if (rust > 0.55) mb.materials[i] = MESH_MATERIAL.SEDIMENT;
  }

  // ---- platters ------------------------------------------------------------
  const platterCount = Math.max(1, opts.platters ?? 4);
  // Heights: crowded toward the crown the way the reference stacks them,
  // jittered so no two spires share a floor plan. The top platter sits at
  // the very crown and is the largest - the canopy read.
  for (let k = 0; k < platterCount; k++) {
    const crown = k === platterCount - 1;
    // The crown sits at u = 1 EXACTLY so its hub swallows the trunk's end
    // cap - at the first lerp(0.96, 1.0) jitter the trunk tip poked through
    // and ended in a visible flat cut above the top platter.
    // EVEN vertical spacing with only a whisper of jitter: the pads start
    // at 0.30 H and the gap between consecutive pads is ~0.175 H (~8 m at
    // the shipped 46 m) - a lane the vessel's 3 m hull height flies through
    // with room, which is the 2026-08-18 playtest's ask. The old
    // crown-crowded power distribution collapsed gaps to 2-3 m.
    const u = crown ? 1
      : 0.30 + 0.70 * (k + 1) / platterCount + (rng() - 0.5) * 0.03;
    const py = -1.5 + (height + 1.5) * Math.min(1, u);
    // Radius: mid pads 0.16-0.26 H, the crown 0.28-0.34 H - 15-31 m
    // diameters at the shipped 46 m, the playtest's "much bigger platters".
    const R = height * (crown ? lerp(0.28, 0.34, rng()) : lerp(0.20, 0.30, rng()));
    // 0.07, thinned again with the size-up: a wide pad carries its own
    // thickness visually, and a thick 25 m disc reads as a millstone.
    const t = Math.max(0.30, R * 0.07);      // half-thickness at the hub
    // Trunk radius at this height, from the same taper the extrusion used.
    const trunkR = baseR * lerp(1, 0.42, Math.min(1, u));

    // Profile: top centre -> domed top -> rounded rim -> underside -> buried
    // inner ring. r runs 0 -> R -> trunkR*0.7; the rim roundover carries four
    // stations (see the header).
    const prof = Float32Array.of(
      0.001, t,
      R * 0.30, t * 0.88,
      R * 0.62, t * 0.55,
      R * 0.86, t * 0.22,
      R * 0.97, 0,
      R, -t * 0.35,
      R * 0.94, -t * 0.62,
      R * 0.78, -t * 0.80,
      R * 0.52, -t * 0.92,
      R * 0.24, -t,
      Math.min(trunkR * 0.7, R * 0.12), -t,
    );
    const wavePhase = rng() * TAU;
    const waveN = 5 + ((rng() * 3) | 0);
    const platter = lathe(prof, seg, {
      color: topColor,
      material: MESH_MATERIAL.SEDIMENT,
      // Rim waviness plus a broad lobing, both radial-only so the top stays
      // a walkable surface: the reference platters are irregular pads, not
      // turned tabletops.
      modulate: (ringT, theta, r, y) => {
        const rimness = saturate((r / R - 0.45) * 1.8);
        return 1 + rimness * (0.07 * Math.sin(theta * waveN + wavePhase)
          + 0.12 * simplex2(Math.cos(theta) * 1.4 + k * 3.1,
                            Math.sin(theta) * 1.4 - k * 1.7, ns ^ 4));
      },
    });
    // Zone the vertex arrays before merge (see the header). Radial distance
    // is measured in the platter's own frame, so the zones follow the
    // modulated rim rather than the authored R.
    for (let i = 0; i < platter.vertexCount; i++) {
      const p3 = i * 3, c4 = i * 4;
      const r = Math.hypot(platter.positions[p3], platter.positions[p3 + 2]);
      const nY = platter.normals[p3 + 1];
      const rr = r / R;
      if (nY < -0.10 && rr > 0.80) {
        // Underside rim band: the glowing tissue. Narrowed twice (0.45 ->
        // 0.70 -> 0.80): every pad in a ground-level frame is seen from
        // BELOW, so the underside is the pad's whole delivered face and any
        // wide emissive band turns the forest into cream saucers. The
        // reference's warmth is a thin lit rim under a dark pad.
        platter.materials[i] = MESH_MATERIAL.EMISSIVE;
        platter.colors[c4] = rimColor[0];
        platter.colors[c4 + 1] = rimColor[1];
        platter.colors[c4 + 2] = rimColor[2];
      } else if (nY < 0.15 && rr > 0.92) {
        // The rim edge itself warms toward the glow band, gently.
        platter.colors[c4] = lerp(topColor[0], rimColor[0], 0.35);
        platter.colors[c4 + 1] = lerp(topColor[1], rimColor[1], 0.35);
        platter.colors[c4 + 2] = lerp(topColor[2], rimColor[2], 0.35);
      } else if (nY < -0.15) {
        // Inner underside: rust shadow, dark - it is most of what a diver
        // under the canopy sees.
        platter.colors[c4] = rustColor[0] * 0.45;
        platter.colors[c4 + 1] = rustColor[1] * 0.45;
        platter.colors[c4 + 2] = rustColor[2] * 0.45;
      } else {
        // Top: sage turf, mottled darker toward the hub.
        const mottle = 0.55 + 0.45 * saturate(rr + 0.2)
          + 0.16 * simplex2(platter.positions[p3] * 0.9,
                            platter.positions[p3 + 2] * 0.9, ns ^ 5);
        platter.colors[c4] = topColor[0] * mottle;
        platter.colors[c4 + 1] = topColor[1] * mottle;
        platter.colors[c4 + 2] = topColor[2] * mottle;
      }
    }
    // Seat on the trunk path at this height, with a small tilt: dead-level
    // stacks read machined.
    const si = Math.min(stations - 1, Math.floor(Math.min(1, u) * (stations - 1)));
    const tiltAz = rng() * TAU;
    // Gentler than the small-pad draft's 0.09: a 30 m disc at 5 degrees
    // already sheds 2.6 m across its span.
    const tilt = lerp(0.01, 0.05, rng());
    const st = Math.sin(tilt * 0.5), ct = Math.cos(tilt * 0.5);
    _qPlatter[0] = Math.cos(tiltAz) * st;
    _qPlatter[1] = 0;
    _qPlatter[2] = Math.sin(tiltAz) * st;
    _qPlatter[3] = ct;
    vec3.set(_t0, path[si * 3], py, path[si * 3 + 2]);
    vec3.set(_t1, 1, lerp(0.9, 1.1, rng()), 1);
    buildTRS(_xfPlatter, _qPlatter, _t0, _t1);
    start = mb.vertexCount;
    mb.merge(platter, _xfPlatter);
    mb.setSwayRange(start, mb.vertexCount - start, 0);

    // (The pad-top ring-coral accents that stood here were REMOVED on the
    // 2026-08-18 playtest: they delivered as white hoops sitting on the
    // platters and read as debris. The pink rings live on the ground
    // ringHalo row only.)
  }

  return finish(mb);
}

/**
 * A ring halo: a small cluster of upright glowing rings on short stubs - the
 * pink ring-corals scattered across the Platter Forest floor
 * (the pink circles of the forest's art-direction reference). The whole torus is
 * EMISSIVE: unlike the spire, whose one emission colour is spent on the
 * orange rims, this row's own emissiveColor is pink, so the two warm accents
 * of the reference each get their true hue by living on separate rows - the
 * documented one-emission-colour-per-row constraint, resolved by splitting
 * the kit rather than by blending both hues to salmon.
 *
 * @param {number} seed
 * @param {number} [height] cluster height, metres
 * @param {object} [opts] {detail, rings, color}
 */
export function generateRingHalo(seed, height = 1.6, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, MESH_ASSET.RING_HALO);
  const color = opts.color || MESH_PALETTE.HALO_PINK;
  const stubColor = MESH_PALETTE.PLATTER_RUST;
  const mb = new MeshBuilder(512, 1536);
  const n = Math.max(1, opts.rings ?? (2 + ((rng() * 2) | 0)));
  for (let i = 0; i < n; i++) {
    const R = height * lerp(0.28, 0.45, rng()) * (i === 0 ? 1 : lerp(0.55, 0.85, rng()));
    const stub = R * lerp(0.4, 0.9, rng());
    const az = rng() * TAU;
    const dist = i === 0 ? 0 : height * lerp(0.25, 0.55, rng());
    const cx = Math.cos(az) * dist, cz = Math.sin(az) * dist;
    // Stub: a short tapering post the ring stands on.
    const post = cylinder(R * 0.14, R * 0.09, stub, byDetail(detail, 5, 6, 8), {
      color: stubColor, material: MESH_MATERIAL.FLORA, capBottom: false,
    });
    vec3.set(_t0, cx, -0.05, cz);
    vec3.set(_t1, 1, 1, 1);
    _qPlatter[0] = 0; _qPlatter[1] = 0; _qPlatter[2] = 0; _qPlatter[3] = 1;
    buildTRS(_xfPlatter, _qPlatter, _t0, _t1);
    let start = mb.vertexCount;
    mb.merge(post, _xfPlatter);
    mb.setSwayRange(start, mb.vertexCount - start, 0.05);
    // The ring, upright with jitter, yawed at random: q = qy * qx as in the
    // spire's rim rings.
    const a = PI * 0.5 + (rng() - 0.5) * 0.2, b = rng() * TAU;
    const sx = Math.sin(a / 2), cxq = Math.cos(a / 2);
    const sy = Math.sin(b / 2), cy = Math.cos(b / 2);
    _qPlatter[0] = cy * sx; _qPlatter[1] = sy * cxq;
    _qPlatter[2] = -sy * sx; _qPlatter[3] = cy * cxq;
    // Minor radius thinned 0.13-0.18 -> 0.09-0.13: the reference rings are
    // thin hoops, and a fat glowing torus read as a balloon.
    const ring = torus(R, R * lerp(0.09, 0.13, rng()), byDetail(detail, 8, 10, 12), 6, {
      color, material: MESH_MATERIAL.EMISSIVE,
    });
    vec3.set(_t0, cx, stub + R * 0.9, cz);
    // _t1 is a module temp and the torus's own finish() clobbers it - re-set
    // the unit scale here or the ring merges at ~1e-16 and every triangle
    // lands degenerate (found by test-meshgen on the first build).
    vec3.set(_t1, 1, 1, 1);
    buildTRS(_xfPlatter, _qPlatter, _t0, _t1);
    start = mb.vertexCount;
    mb.merge(ring, _xfPlatter);
    mb.setSwayRange(start, mb.vertexCount - start, 0.10);
  }
  return finish(mb);
}

/**
 * A whale fall: an articulated vertebral column with fanned ribs, a bacterial
 * mat and worm tufts. The Abyssal Plain's own terrain column names it.
 *
 * THE COLUMN IS ONE SWEEP WITH A PULSED RADIUS, NOT N MERGED CENTRA, and that
 * is a deliberate substitution. Nine to fifteen separately lathed drums is the
 * same silhouette at every distance this is ever seen from, costs fifteen
 * merges and fifteen transforms, and gives up watertightness at every joint;
 * `scaleFn` on a single `extrudeAlongSpline` delivers the spool-waisted
 * articulation in one mesh. `generateBoneRib`'s own ribbing uses the same
 * device at a smaller amplitude. What is NOT substituted is the ribs: they are
 * real merged `generateBoneRib` instances, because a rib fans AWAY from the
 * spine and no radius function can do that.
 *
 * IT IS DARK BY CONSTRUCTION. BONE, SEDIMENT and FLORA all carry a
 * `slotEmissiveGate` of 0.05. The mat is pale, not emissive - a whale fall on
 * the abyssal plain is meant to be the thing a lamp FINDS, and the biome's
 * binding Avoid column is "mushroom forest, dense glow pods".
 *
 * Vertices: 1250-1550 (HIGH), 700-850 (MEDIUM), 330-380 (LOW), over 24 seeds.
 *
 * @param {number} seed
 * @param {number} [length] nose-to-tail metres along the spine
 * @param {object} [opts] {detail, color, matColor, wormColor, vertebrae, ribPairs}
 */
export function generateWhaleFall(seed, length = 20, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, MESH_ASSET.WHALE_FALL);
  const ns = assetNoiseSeed(seed, MESH_ASSET.WHALE_FALL);
  const stations = byDetail(detail, 14, 22, 34);
  const sec = byDetail(detail, 5, 6, 8);
  const vertebrae = clamp(opts.vertebrae ?? (9 + rng.int(0, 7)), 6, 18);
  const ribPairs = byDetail(detail, 3, 4, clamp(opts.ribPairs ?? (5 + rng.int(0, 3)), 3, 8));
  const color = opts.color || MESH_PALETTE.BONE;

  // The spine LIES DOWN. Everything else in this file that sweeps a spline is a
  // plant and climbs, so fillCurvedSpline is the wrong tool: it writes
  // `y += cos(ang) * step` and would stand the skeleton on its tail. This is a
  // shallow S in the XZ plane with a little settle in Y, which is what a carcass
  // that has been on the sediment for years looks like.
  const az = rng() * TAU;
  const ca = Math.cos(az), sa = Math.sin(az);
  const bend = lerp(0.10, 0.34, rng());
  const spine = new Float32Array(stations * 3);
  for (let i = 0; i < stations; i++) {
    const t = i / (stations - 1);
    const u = (t - 0.5) * length;
    // Lateral S, and a spine that dips at the middle where the ribcage has
    // collapsed and rises slightly at both ends.
    const lat = Math.sin(t * Math.PI * 1.6) * bend * length * 0.18
      + simplex2(t * 2.6, 0, ns) * length * 0.02;
    const rise = length * (0.030 + 0.022 * Math.cos(t * TAU * 0.9))
      + simplex2(t * 3.4, 11, ns) * length * 0.006;
    spine[i * 3] = u * ca - lat * sa;
    spine[i * 3 + 1] = rise;
    spine[i * 3 + 2] = u * sa + lat * ca;
  }

  const section = new Float32Array(sec * 2);
  for (let k = 0; k < sec; k++) {
    const a = (k / sec) * TAU;
    section[k * 2] = Math.cos(a);
    section[k * 2 + 1] = Math.sin(a) * 0.86;
  }

  const column = extrudeAlongSpline(section, spine, 0, 0.34, {
    radius: length * 0.036,
    color,
    material: MESH_MATERIAL.BONE,
    capStart: true,
    upHint: Float32Array.of(0, 1, 0),
    // The spool waist. 0.34 of amplitude is deep enough that each centrum reads
    // as a separate drum in silhouette and shallow enough that the sweep stays
    // convex, which is what keeps the section normals honest.
    scaleFn: (t) => (1 - 0.34 * Math.abs(Math.sin(t * vertebrae * Math.PI)))
      // The chest is the widest part of a whale and the tail is a whip.
      * (1 + 0.55 * Math.exp(-Math.pow((t - 0.32) * 3.1, 2)))
      * (1 + 0.06 * simplex2(t * 9, 3, ns)),
  });
  remapSway(column, 0, 0);

  const mb = new MeshBuilder(column.vertexCount + 1400, column.indexCount + 4200);
  mb.merge(column);

  // ---- ribs -------------------------------------------------------------
  // Merged for real, because a rib leaves the spine and a radius function
  // cannot. Each pair is mirrored by a negative Z scale; merge() reverses the
  // winding when the transform's determinant is negative, so the mirrored rib
  // is not inside out.
  // THE RIB IS BUILT AT LOW AT EVERY TIER, and it is where this form's whole
  // vertex budget was going. A rib is a smooth 6 m curve 0.2 m thick: at LOW it
  // is 64 vertices and at MEDIUM 140, and sixteen of them is the difference
  // between 1,024 and 2,240 - more than the rest of the carcass put together -
  // for a silhouette change nothing at whale-fall range can resolve. The
  // articulated COLUMN keeps its detail tier, because that is the part with a
  // profile.
  const rib = generateBoneRib(seed ^ 0x2f13, length * 0.30, {
    detail: MESH_DETAIL.LOW,
    color,
    ribs: 5,
    taper: 0.22,
  });
  const q = Float32Array.of(0, 0, 0, 1);
  const trans = vec3.create();
  const scale = vec3.create();
  const xf = new Float32Array(16);
  for (let r = 0; r < ribPairs; r++) {
    // Ribs occupy the front 55% of the column - a whale's abdomen has none -
    // and shorten toward the tail.
    const t = 0.10 + (r / Math.max(ribPairs - 1, 1)) * 0.45;
    const si = Math.min(stations - 1, Math.max(0, Math.round(t * (stations - 1))));
    const len = lerp(1.05, 0.52, Math.pow(r / Math.max(ribPairs - 1, 1), 0.8));
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1;
      // A rib grows out of the spine and curls back under: roll it away from
      // vertical about the spine's own axis. The quaternion is built by hand
      // from an axis and an angle - the axis is the local spine direction, so
      // the rib fans in the plane perpendicular to it.
      const roll = (sgn * lerp(0.62, 1.02, r / Math.max(ribPairs - 1, 1)))
        + simplex2(r * 2.2, side, ns) * 0.10;
      const ha = roll * 0.5;
      const s = Math.sin(ha);
      q[0] = ca * s; q[1] = 0; q[2] = sa * s; q[3] = Math.cos(ha);
      vec3.set(trans, spine[si * 3], spine[si * 3 + 1], spine[si * 3 + 2]);
      vec3.set(scale, len, len, len * sgn);
      buildTRS(xf, q, trans, scale);
      mb.merge(rib, xf);
    }
  }

  // ---- skull ------------------------------------------------------------
  {
    const skull = icosphere(byDetail(detail, 0, 1, 1), length * 0.075, {
      color, material: MESH_MATERIAL.BONE,
    });
    q[0] = 0; q[1] = 0; q[2] = 0; q[3] = 1;
    vec3.set(trans, spine[0], spine[1] + length * 0.010, spine[2]);
    vec3.set(scale, 2.35, 0.92, 1.05);
    buildTRS(xf, q, trans, scale);
    mb.merge(skull, xf);
  }

  // ---- bacterial mat ----------------------------------------------------
  // A low pale halo on the sediment. It is the reason a whale fall is legible
  // at all in a lamp beam: the bone is thin in silhouette and the mat is what
  // gives the form a footprint on the ground.
  {
    const matR = length * 0.30;
    const matProfile = Float32Array.of(
      0, 0.0,
      matR * 0.55, length * 0.006,
      matR * 0.88, length * 0.010,
      matR, length * 0.004,
    );
    const mat = lathe(matProfile, byDetail(detail, 8, 12, 18), {
      color: opts.matColor || MESH_PALETTE.CARBONATE,
      material: MESH_MATERIAL.SEDIMENT,
      closeBottom: false,
      closeTop: false,
      modulate: (ringT, theta) => 1 + 0.26 * simplex2(Math.cos(theta) * 2.2,
        Math.sin(theta) * 2.2, ns ^ 7) * ringT,
    });
    q[0] = 0; q[1] = 0; q[2] = 0; q[3] = 1;
    vec3.set(trans, 0, 0, 0);
    vec3.set(scale, 1.7, 1, 1);
    buildTRS(xf, q, trans, scale);
    mb.merge(mat, xf);
  }

  // ---- worm tufts -------------------------------------------------------
  // Osedax. Small, warm, and NON-EMISSIVE on purpose: the plain's binding Avoid
  // column is "mushroom forest, dense glow pods", and the point of this form is
  // that it is the thing the diver's lamp finds rather than a thing that glows
  // on its own.
  {
    const tufts = byDetail(detail, 3, 5, 8);
    const tuft = cone(length * 0.010, length * 0.030, byDetail(detail, 4, 5, 6), {
      color: opts.wormColor || MESH_PALETTE.TUBEROD,
      material: MESH_MATERIAL.FLORA,
      cap: true,
    });
    for (let i = 0; i < tufts; i++) {
      const t = 0.08 + (i / Math.max(tufts - 1, 1)) * 0.78;
      const si = Math.min(stations - 1, Math.round(t * (stations - 1)));
      const off = (simplex2(i * 3.1, 5, ns)) * length * 0.10;
      const lean = simplex2(i * 1.7, 9, ns) * 0.25;
      const ha = lean * 0.5;
      const s = Math.sin(ha);
      q[0] = ca * s; q[1] = 0; q[2] = sa * s; q[3] = Math.cos(ha);
      vec3.set(trans,
        spine[si * 3] - off * sa,
        Math.max(0, spine[si * 3 + 1] - length * 0.020),
        spine[si * 3 + 2] + off * ca);
      const sc = lerp(0.7, 1.5, (simplex2(i * 5.3, 2, ns) + 1) * 0.5);
      vec3.set(scale, sc, sc, sc);
      buildTRS(xf, q, trans, scale);
      mb.merge(tuft, xf);
    }
  }

  return finish(mb);
}

/**
 * A colossal cetacean-like skull: a hollow cranium dome with two eye sockets
 * and a nasal/jaw arch punched through it, a tapering rostrum, two brow
 * arches and a splayed pair of mandible bones on the sediment. The Pale
 * Ossuary landmark (DESIGN/01's `lm_pale_ossuary`, "intact skull of a 90 m
 * animal - 26 m long, 14 m tall, enterable") and, at a small
 * parameterisation, the half-buried skulls of the Ossuary Flats.
 *
 * IT IS ENTERABLE, AND THE MECHANISM IS ONE OPEN SHELL DRAWN TWO-SIDED, NOT A
 * DOUBLE WALL. The cranium is a single theta x phi ellipsoid grid whose
 * bottom rim dips below the sediment, with the sockets and the jaw arch made
 * by SKIPPING QUADS - so the mesh has real boundary edges (it is not closed,
 * deliberately) and a swimmer passes through a hole into the same surface
 * seen from behind. The scatter rows that carry it set `twoSided: true`,
 * which draws with culling off, and `fs_scatter` flips the normal on
 * back-facing fragments - the identical mechanism every kelp blade already
 * uses - so the interior shades correctly under a lamp with zero extra
 * geometry. Stored normals stay OUTWARD and winding stays consistent, which
 * is what keeps test-meshgen's flipped-triangle and inconsistent-edge counts
 * at zero on a mesh that is 40% hole by design.
 *
 * The noise displacement wraps in theta (it is fed cos/sin of the azimuth,
 * not the azimuth itself) so the duplicated seam column displaces
 * identically and computeSmoothNormals welds it without a crease.
 *
 * Vertices: 1,409 (HIGH), 778 (MEDIUM), 464 (LOW) measured at the shipped
 * row seed, inside the landmark band's 2,000.
 *
 * @param {number} seed
 * @param {number} [length] nose-to-crown metres, rostrum included
 * @param {object} [opts] {detail, color, sockets} - sockets=false skips the
 *   holes for a fully buried variant (unused today; the holes are the point)
 */
export function generateSkull(seed, length = 26, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const rng = assetRng(seed, MESH_ASSET.SKULL);
  const ns = assetNoiseSeed(seed, MESH_ASSET.SKULL);
  // 40 x 24 at HIGH, because the sockets and the arch are QUAD-SKIP holes and
  // their edges step at the grid pitch: at 28 x 16 the socket rim stepped in
  // ~1.5 m teeth that read as machine cuts in the delivered frame.
  const T = byDetail(detail, 14, 26, 40);       // azimuth segments
  const P = byDetail(detail, 9, 15, 24);        // phi rings below the pole cap
  const color = opts.color || MESH_PALETTE.BONE;
  const L = length;

  // Cranium half-axes and centre height. Dome top = cy + ry = 0.535 L (13.9 m
  // at 26), width 0.52 L; the rim at phi1 sits ~0.014 L BELOW y = 0 so the
  // shell meets the sediment instead of hovering on a dark slit.
  const rx = L * 0.26, ry = L * 0.30, rz = L * 0.30;
  const cy = L * 0.235;
  const phi0 = 0.16, phi1 = 2.62;
  // Buried skirt: one extra ring pushed straight down from the rim. The
  // flattest 14 m disc the Ossuary Flats offer still carries ~6 m of relief
  // (measured at seed 1534754449), so a rim that only dips 0.65 m would hover
  // on the downhill side and leak light under the shell; the skirt takes the
  // wall to ~-4.1 m so the ground meets bone at every azimuth the site can
  // realistically deliver.
  const skirtDrop = L * 0.13, skirtPull = 0.96;

  // Socket and arch windows, in (theta, phi) parameter space. theta 0 faces
  // +Z (the rostrum side). The socket ellipse spans ~4.8 x 4.4 m at L = 26 and
  // the jaw arch ~5.7 m wide from y ~5.1 down to the rim - both comfortably
  // swimmable for a 1 m capsule.
  const sockTh = 0.66, sockPhi = 1.22, sockW = 0.36, sockH = 0.30;
  const archTh = 0.40, archPhi = 1.70;
  const holes = opts.sockets !== false;
  const inHole = (th, phi) => {
    if (!holes) return false;
    if (Math.abs(th) < archTh && phi > archPhi) return true;
    for (const s of [-sockTh, sockTh]) {
      const dt = (th - s) * Math.sin(sockPhi) / sockW;
      const dp = (phi - sockPhi) / sockH;
      if (dt * dt + dp * dp < 1) return true;
    }
    return false;
  };

  const mb = new MeshBuilder(1400, 4600);
  mb.material = MESH_MATERIAL.BONE;

  // ---- cranium shell ------------------------------------------------------
  // Rings of duplicated-seam columns; the pole is a fan. Radius carries a
  // weathering displacement plus a brow bulge over the sockets.
  const stride = T + 1;
  const shellBase = mb.vertexCount;
  const bulge = (th, phi) => {
    let b = 1 + 0.05 * simplex2(Math.cos(th) * 1.7, Math.sin(th) * 1.7 + phi * 2.1, ns);
    for (const s of [-sockTh, sockTh]) {
      const dt = (th - s) * Math.sin(sockPhi) / (sockW * 1.9);
      const dp = (phi - (sockPhi - 0.32)) / (sockH * 1.4);
      const d2 = dt * dt + dp * dp;
      if (d2 < 1) b += 0.10 * (1 - d2);              // brow ridge above the socket
    }
    return b;
  };
  for (let i = 0; i <= P; i++) {
    const phi = phi0 + (phi1 - phi0) * (i / P);
    const sp = Math.sin(phi), cp = Math.cos(phi);
    for (let j = 0; j <= T; j++) {
      const th = (j / T) * TAU - Math.PI;             // -PI..PI, 0 faces +Z
      const st = Math.sin(th), ct = Math.cos(th);
      const b = bulge(th, phi);
      _p[0] = rx * b * sp * st;
      _p[1] = cy + ry * b * cp;
      _p[2] = rz * b * sp * ct;
      // Analytic ellipsoid normal; computeSmoothNormals refines it after the
      // displacement, welding the seam column.
      _n[0] = (sp * st) / rx; _n[1] = cp / ry; _n[2] = (sp * ct) / rz;
      vec3.normalize(_n, _n);
      _uv[0] = j / T; _uv[1] = i / P;
      _col[0] = color[0]; _col[1] = color[1]; _col[2] = color[2]; _col[3] = 0;
      mb.addVertex(_p, _n, _uv, _col);
    }
  }
  for (let i = 0; i < P; i++) {
    const phiA = phi0 + (phi1 - phi0) * (i / P);
    const phiB = phi0 + (phi1 - phi0) * ((i + 1) / P);
    for (let j = 0; j < T; j++) {
      const thA = (j / T) * TAU - Math.PI;
      const thB = ((j + 1) / T) * TAU - Math.PI;
      const a0 = shellBase + i * stride + j;
      const b0 = shellBase + (i + 1) * stride + j;
      // Outward = +radial; with theta increasing counter-clockwise seen from
      // +Y and phi increasing downward, (a0, a0+1, b0+1, b0) winds outward.
      // The hole test runs PER TRIANGLE, not per quad: the socket rim steps
      // at the pitch of whatever cell the test removes, and a triangle is
      // half a quad, so the teeth halve for free.
      const c1 = !inHole((thA * 2 + thB) / 3, (phiA + phiB * 2) / 3);
      const c2 = !inHole((thA + thB * 2) / 3, (phiA * 2 + phiB) / 3);
      if (c1) mb.addTriangle(a0, b0 + 1, b0);
      if (c2) mb.addTriangle(a0, a0 + 1, b0 + 1);
    }
  }
  // Skirt ring: rim positions pulled slightly inward and dropped below the
  // sediment. The arch window keeps its doorway all the way down; sockets are
  // higher and cannot reach this band.
  const skirtBase = mb.vertexCount;
  {
    const sp = Math.sin(phi1), cp = Math.cos(phi1);
    for (let j = 0; j <= T; j++) {
      const th = (j / T) * TAU - Math.PI;
      const st = Math.sin(th), ct = Math.cos(th);
      const b = bulge(th, phi1) * skirtPull;
      _p[0] = rx * b * sp * st;
      _p[1] = cy + ry * b * cp - skirtDrop;
      _p[2] = rz * b * sp * ct;
      _n[0] = sp * st; _n[1] = 0; _n[2] = sp * ct;
      vec3.normalize(_n, _n);
      _uv[0] = j / T; _uv[1] = 1;
      _col[0] = color[0]; _col[1] = color[1]; _col[2] = color[2]; _col[3] = 0;
      mb.addVertex(_p, _n, _uv, _col);
    }
    const rimBase = shellBase + P * stride;
    for (let j = 0; j < T; j++) {
      const thC = ((j + 0.5) / T) * TAU - Math.PI;
      if (inHole(thC, phi1)) continue;
      mb.addQuad(rimBase + j, rimBase + j + 1, skirtBase + j + 1, skirtBase + j);
    }
  }
  // Pole cap fan.
  const pole = mb.vertexCount;
  vec3.set(_p, 0, cy + ry * bulge(0, 0), 0);
  vec3.set(_n, 0, 1, 0);
  _uv[0] = 0.5; _uv[1] = 0;
  mb.addVertex(_p, _n, _uv, _col);
  for (let j = 0; j < T; j++) {
    mb.addTriangle(pole, shellBase + j + 1, shellBase + j);
  }
  mb.computeSmoothNormals(1.1);

  // ---- rostrum ------------------------------------------------------------
  // A flattened tapering sweep from inside the front shell to the nose tip.
  // It PIERCES the shell on purpose: the join is hidden inside the cranium
  // and a welded join would cost a stitched ring for nothing visible.
  {
    const stations = byDetail(detail, 6, 8, 10);
    const secN = byDetail(detail, 5, 6, 7);
    const rost = new Float32Array(stations * 3);
    const z0 = rz * 0.55, z1 = rz * 0.55 + L * 0.55;
    for (let i = 0; i < stations; i++) {
      const t = i / (stations - 1);
      rost[i * 3] = simplex2(t * 3.1, 7, ns) * L * 0.012;
      rost[i * 3 + 1] = L * (0.135 - 0.095 * t);      // settles toward the tip
      rost[i * 3 + 2] = z0 + (z1 - z0) * t;
    }
    const section = new Float32Array(secN * 2);
    for (let k = 0; k < secN; k++) {
      const a = (k / secN) * TAU;
      section[k * 2] = Math.cos(a);
      section[k * 2 + 1] = Math.sin(a) * 0.46;
    }
    const beak = extrudeAlongSpline(section, rost, 0, 0.24, {
      radius: L * 0.115,
      color,
      material: MESH_MATERIAL.BONE,
      capStart: true,
      upHint: Float32Array.of(0, 1, 0),
      scaleFn: (t) => 1 + 0.05 * simplex2(t * 6.2, 3, ns),
    });
    remapSway(beak, 0, 0);
    mb.merge(beak);
  }

  // ---- brow arches and mandibles ------------------------------------------
  // Real merged boneRib instances, exactly as the whale fall fans its ribs:
  // a rib curves AWAY from its base and no radius function can do that. The
  // mandible pair is mirrored by a negative X scale; merge() reverses the
  // winding under a negative determinant.
  {
    const rib = generateBoneRib(seed ^ 0x51c7, L * 0.30, {
      detail: MESH_DETAIL.LOW, color, ribs: 4, taper: 0.30,
    });
    // 0.50 L and a 0.55 rad splay (was 0.62 L at 0.22): a boneRib CURLS, and
    // once pitched flat that curl lifts the distal end back up - at 0.62 L
    // the tip rose ~7 m directly across the delivered face view and read as
    // a stray column in front of the sockets. Shorter and wider-splayed, the
    // pair reads as an opened jaw beside the rostrum instead.
    const jaw = generateBoneRib(seed ^ 0x3e2b, L * 0.50, {
      detail: MESH_DETAIL.LOW, color, ribs: 5, taper: 0.42,
    });
    const q = Float32Array.of(0, 0, 0, 1);
    const trans = vec3.create();
    const scale = vec3.create();
    const xf = new Float32Array(16);
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1;
      // Brow arch: leans outboard over the socket, rolled about Z.
      let ha = sgn * lerp(1.05, 1.25, rng()) * 0.5;
      q[0] = 0; q[1] = 0; q[2] = Math.sin(ha); q[3] = Math.cos(ha);
      vec3.set(trans, sgn * rx * 0.62, cy + ry * 0.28, rz * 0.52);
      vec3.set(scale, 1, 1, 1);
      buildTRS(xf, q, trans, scale);
      mb.merge(rib, xf);
      // Mandible: lies along the ground beside the rostrum, splayed out and
      // pitched nearly flat (rotated about X so its curve hugs the sediment).
      ha = (Math.PI * 0.5 - 0.12) * 0.5;
      const sy = Math.sin(sgn * 0.55 * 0.5), cyq = Math.cos(sgn * 0.55 * 0.5);
      // yaw(sgn*0.55) * pitch(-~90deg about X), composed by hand.
      const px = Math.sin(ha), pw = Math.cos(ha);
      q[0] = pw * 0 + px * cyq; q[1] = sy * pw; q[2] = -sy * px; q[3] = cyq * pw;
      const ql = Math.hypot(q[0], q[1], q[2], q[3]);
      q[0] /= ql; q[1] /= ql; q[2] /= ql; q[3] /= ql;
      vec3.set(trans, sgn * rx * 0.55, L * 0.035, rz * 0.40);
      vec3.set(scale, 1, 1, sgn);
      buildTRS(xf, q, trans, scale);
      mb.merge(jaw, xf);
    }
  }

  return finish(mb);
}

// ===========================================================================
// Ore nodes
// ===========================================================================

/**
 * Ore appearance, one entry per ore id in DESIGN/02 Table 9.5.
 *   rock      host rock tint
 *   vein      mineral tint for the seam geometry and the attachments
 *   emissive  0 = the seam is a dull mineral streak, > 0 = it glows
 *   style     what grows out of the crack: nodule, prism, needle or crust
 *   attach    how many attachments at full detail
 */
export const ORE_APPEARANCE = [
  { id: 0, name: 'ferrite', rock: MESH_PALETTE.BASALT_DARK, vein: rgb(150, 110, 72), emissive: 0, style: 'nodule', attach: 7 },
  { id: 1, name: 'cupric', rock: MESH_PALETTE.BASALT, vein: rgb(70, 190, 170), emissive: 0, style: 'crust', attach: 9 },
  { id: 2, name: 'titanite', rock: MESH_PALETTE.BASALT, vein: rgb(190, 196, 206), emissive: 0, style: 'prism', attach: 6 },
  { id: 3, name: 'aurelite', rock: MESH_PALETTE.PALE_ROCK, vein: rgb(228, 190, 96), emissive: 0, style: 'crust', attach: 11 },
  { id: 4, name: 'lithion', rock: MESH_PALETTE.PALE_ROCK, vein: rgb(236, 236, 220), emissive: 0.4, style: 'crust', attach: 9 },
  { id: 5, name: 'argent', rock: MESH_PALETTE.BASALT, vein: rgb(210, 220, 226), emissive: 0, style: 'needle', attach: 8 },
  { id: 6, name: 'magnetite', rock: MESH_PALETTE.BASALT_DARK, vein: rgb(56, 58, 66), emissive: 0, style: 'nodule', attach: 7 },
  { id: 7, name: 'voidglass', rock: MESH_PALETTE.BASALT_DARK, vein: rgb(150, 90, 255), emissive: 7.5, style: 'prism', attach: 5 },
];

/**
 * A minable ore node: a host rock whose crack network carries GEOMETRIC mineral
 * seams, plus mineral bodies growing out of the cracks.
 *
 * The seams are real ribbons of geometry lifted off the rock along the surface
 * normal and laid along the mesh edges whose midpoints fall on a cellular cell
 * BOUNDARY - so the seam network is the rock's own fracture pattern rather than
 * an unrelated overlay, and it survives at any distance the geometry does. A
 * texture could not do that: the scatter vertex format has no second UV set and
 * no per-instance texture, and an emissive mask painted into the albedo would
 * light the whole facet instead of the seam.
 *
 * Seams are lifted 0.6% of the node radius and are 3% of it wide. A fully
 * inlaid prism would triple the seam cost to hide a 6 mm silhouette that never
 * resolves on screen.
 *
 * Vertices: 620-780 (HIGH), 300-380 (MEDIUM), 130-170 (LOW).
 *
 * @param {number} seed
 * @param {number} [materialId] index into ORE_APPEARANCE, 0..7
 * @param {number} [size] bounding radius in metres
 * @param {object} [opts] {detail, seamDensity, attach, irregularity}
 */
export function generateOreNode(seed, materialId = 0, size = 0.5, opts = {}) {
  const detail = opts.detail ?? MESH_DETAIL.HIGH;
  const ore = ORE_APPEARANCE[clamp(materialId | 0, 0, ORE_APPEARANCE.length - 1)];
  const rng = assetRng(seed, MESH_ASSET.ORE_NODE);
  const ns = assetNoiseSeed(seed, MESH_ASSET.ORE_NODE);
  const subdiv = byDetail(detail, 1, 1, 2);
  const knobs = blendKnobs(ROCK_KNOBS[1], ROCK_KNOBS[2], saturate(opts.irregularity ?? 0.25));

  const mb = new MeshBuilder(byDetail(detail, 160, 380, 900), byDetail(detail, 600, 1500, 4200));
  mb.material = MESH_MATERIAL.ROCK;
  const rockColor = optColor({ color: ore.rock });
  const part = emitDeformedIcosphere(mb, subdiv, size, knobs, ns, rng, rockColor);
  const rockIndexEnd = mb.indexCount;

  const veinColor = Float32Array.of(ore.vein[0], ore.vein[1], ore.vein[2], 0);
  const veinMaterial = ore.emissive > 0 ? MESH_MATERIAL.EMISSIVE : MESH_MATERIAL.METAL;
  // Cell frequency in unit-sphere space: about 5 cells across the node, which is
  // the density at which a seam network reads as fracture rather than as craquelure.
  const crackFreq = 4.6;
  const threshold = 0.052 * (opts.seamDensity ?? 1);
  const lift = size * 0.006;
  const halfW = size * 0.015;
  const seen = new Set();
  mb.material = veinMaterial;

  for (let k = 0; k < rockIndexEnd; k += 3) {
    for (let e = 0; e < 3; e++) {
      const ia = mb.indices[k + e];
      const ib = mb.indices[k + ((e + 1) % 3)];
      const key = ia < ib ? ia * 100000 + ib : ib * 100000 + ia;
      if (seen.has(key)) continue;
      seen.add(key);
      const oa = ia * 3, ob = ib * 3;
      const mx = (mb.positions[oa] + mb.positions[ob]) * 0.5;
      const my = (mb.positions[oa + 1] + mb.positions[ob + 1]) * 0.5;
      const mz = (mb.positions[oa + 2] + mb.positions[ob + 2]) * 0.5;
      const inv = 1 / Math.max(size, 1e-6);
      const edgeVal = worley3Edge(mx * inv * crackFreq, my * inv * crackFreq, mz * inv * crackFreq, ns ^ 9, 1.0);
      if (edgeVal > threshold) continue;

      vec3.set(_e0, mb.positions[ob] - mb.positions[oa],
        mb.positions[ob + 1] - mb.positions[oa + 1],
        mb.positions[ob + 2] - mb.positions[oa + 2]);
      if (vec3.sqrLen(_e0) < 1e-12) continue;
      vec3.normalize(_e0, _e0);
      vec3.set(_n, mb.normals[oa] + mb.normals[ob],
        mb.normals[oa + 1] + mb.normals[ob + 1],
        mb.normals[oa + 2] + mb.normals[ob + 2]);
      if (vec3.sqrLen(_n) < 1e-12) continue;
      vec3.normalize(_n, _n);
      vec3.cross(_e1, _e0, _n);
      if (vec3.sqrLen(_e1) < 1e-12) continue;
      vec3.normalize(_e1, _e1);

      const start = mb.vertexCount;
      for (let c = 0; c < 4; c++) {
        const along = (c === 0 || c === 1) ? 0 : 1;
        const side = (c === 0 || c === 3) ? -1 : 1;
        const px = lerp(mb.positions[oa], mb.positions[ob], along);
        const py = lerp(mb.positions[oa + 1], mb.positions[ob + 1], along);
        const pz = lerp(mb.positions[oa + 2], mb.positions[ob + 2], along);
        _p[0] = px + _n[0] * lift + _e1[0] * side * halfW;
        _p[1] = py + _n[1] * lift + _e1[1] * side * halfW;
        _p[2] = pz + _n[2] * lift + _e1[2] * side * halfW;
        _uv[0] = side * 0.5 + 0.5; _uv[1] = along;
        mb.addVertex(_p, _n, _uv, veinColor);
      }
      // The corner order runs +side then +along, and
      // cross(_e1, _e0) = cross(cross(_e0, _n), _e0) = _n, so the natural order
      // already faces out of the rock.
      mb.addQuad(start, start + 1, start + 2, start + 3);
    }
  }

  // Mineral bodies growing out of the seams. Attachment sites are rock vertices
  // that sit ON a crack, so the crystals emerge from the fracture rather than
  // sprouting from an unbroken facet.
  const wanted = Math.max(2, Math.round(
    (opts.attach ?? ore.attach) * byDetail(detail, 0.4, 0.7, 1)));
  const sites = [];
  for (let i = part.first; i < part.first + part.count; i++) {
    const o = i * 3;
    const inv = 1 / Math.max(size, 1e-6);
    const edgeVal = worley3Edge(mb.positions[o] * inv * crackFreq, mb.positions[o + 1] * inv * crackFreq,
      mb.positions[o + 2] * inv * crackFreq, ns ^ 9, 1.0);
    // Only the upper hemisphere: a crystal on the underside is buried.
    if (edgeVal < threshold * 2.2 && mb.normals[o + 1] > -0.1) sites.push(i);
  }
  const q = Float32Array.of(0, 0, 0, 1);
  const trans = vec3.create();
  const scale = vec3.create(1, 1, 1);
  const xf = new Float32Array(16);
  const radii = new Float32Array(5);
  const stepSites = Math.max(1, Math.floor(sites.length / wanted));
  for (let s = 0, placed = 0; s < sites.length && placed < wanted; s += stepSites, placed++) {
    const i = sites[s];
    const o = i * 3;
    vec3.set(_n, mb.normals[o], mb.normals[o + 1], mb.normals[o + 2]);
    vec3.set(trans, mb.positions[o], mb.positions[o + 1], mb.positions[o + 2]);
    // Align +Y with the rock normal.
    const dot = _n[1];
    if (dot > 0.9999) { q[0] = 0; q[1] = 0; q[2] = 0; q[3] = 1; }
    else if (dot < -0.9999) { q[0] = 1; q[1] = 0; q[2] = 0; q[3] = 0; }
    else {
      // Shortest-arc quaternion from +Y to the normal.
      q[0] = _n[2]; q[1] = 0; q[2] = -_n[0]; q[3] = 1 + dot;
      const ql = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
      q[0] /= ql; q[1] /= ql; q[2] /= ql; q[3] /= ql;
    }

    let body;
    if (ore.style === 'nodule') {
      const r = size * lerp(0.10, 0.22, rng());
      body = icosphere(byDetail(detail, 0, 0, 1), r, { color: ore.vein, material: veinMaterial });
      vec3.set(scale, 1, lerp(0.55, 0.85, rng()), 1);
    } else if (ore.style === 'crust') {
      const r = size * lerp(0.16, 0.30, rng());
      body = icosphere(0, r, { color: ore.vein, material: veinMaterial });
      // A crust is a plate, not a lump: flatten it hard against the rock.
      vec3.set(scale, 1, lerp(0.12, 0.24, rng()), 1);
    } else {
      const sides = ore.style === 'needle' ? 4 : 5;
      const h = size * (ore.style === 'needle' ? lerp(0.30, 0.62, rng()) : lerp(0.18, 0.38, rng()));
      const R = h * (ore.style === 'needle' ? 0.10 : 0.26);
      for (let kk = 0; kk < sides; kk++) radii[kk] = R * (0.72 + 0.28 * rng());
      const sub = new MeshBuilder(sides * 8 + 20, sides * 24 + 30);
      sub.material = veinMaterial;
      emitPrism(sub, sides, radii, h, lerp(0.10, 0.45, rng()), lerp(0.25, 0.6, rng()), 0,
        veinColor, veinColor, veinMaterial);
      body = sub.build();
      vec3.set(scale, 1, 1, 1);
    }
    buildTRS(xf, q, trans, scale);
    mb.merge(body, xf);
  }
  return finish(mb);
}

// ===========================================================================
// Registry
// ===========================================================================

/**
 * Every content generator, with the representative arguments the flora and ore
 * registries in DESIGN/01 6.1 and DESIGN/02 9.5 actually ask for.
 *
 * The scatter system, the imposter baker and tools/test-meshgen.mjs all walk
 * this list, so a generator added here is automatically placed, baked and
 * tested. `kind` groups them for the vertex-budget checks: rocks, flora and
 * structure have different sane ranges.
 *
 * `flora` names the DESIGN/01 registry ids this generator covers, which is how
 * the placement tables map a biome's flora weights onto geometry.
 *
 * @type {Array<{name: string, asset: number, kind: string, flora: string[],
 *   build: (seed: number, detail: number) => object}>}
 */
export const MESH_GENERATORS = [
  { name: 'rock', asset: MESH_ASSET.ROCK, kind: 'rock', flora: [],
    build: (s, d) => generateRock(s, 1.0, 0.5, { detail: d }) },
  { name: 'rockAngular', asset: MESH_ASSET.ROCK, kind: 'rock', flora: [],
    build: (s, d) => generateRock(s, 0.8, 1.0, { detail: d }) },
  { name: 'boulder', asset: MESH_ASSET.BOULDER, kind: 'rock', flora: [],
    build: (s, d) => generateBoulder(s, 4.0, { detail: d }) },
  { name: 'pebble', asset: MESH_ASSET.PEBBLE, kind: 'rock', flora: [],
    build: (s, d) => generatePebble(s, 0.22, { detail: d }) },
  { name: 'crystalSpar', asset: MESH_ASSET.CRYSTAL, kind: 'structure', flora: ['fl_calcite_spar'],
    build: (s, d) => generateCrystal(s, 3.4, 6, { detail: d, emissive: false }) },
  { name: 'crystalDruse', asset: MESH_ASSET.CRYSTAL, kind: 'structure', flora: ['fl_amethyst_druse'],
    build: (s, d) => generateCrystal(s, 0.8, 7, { detail: d, color: MESH_PALETTE.AMETHYST }) },
  { name: 'kelp', asset: MESH_ASSET.KELP, kind: 'flora', flora: ['fl_bladderweed', 'fl_fingerweed'],
    build: (s, d) => generateKelp(s, 3.1, 12, { detail: d }) },
  // THE SHIPPED ROW'S PARAMETERS: the `kelpVine` row (world/scatter.js
  // id 67, the emerald forest's own understory).
  { name: 'kelpVine', asset: MESH_ASSET.KELP, kind: 'flora', flora: ['fl_bladderweed'],
    build: (s, d) => generateKelp(s, 30, 16, { detail: d, bands: 3, girth: 1.9, bladeWide: 1.3 }) },
  // THE SHIPPED ROW'S OWN PARAMETERS, not the generator's defaults. This entry
  // read (22, 24) while the row authored (16, 18) and now authors (24, 24), so
  // what test-meshgen measured was a mesh that ships nowhere - the same drift
  // that has 'kelp' here at 3.84 m against kelpStalk's real 11.08.
  // `forest` kind (see test-meshgen's BUDGET): 1,799 verts at HIGH against
  // the row's maxPerChunk of 150, i.e. a 269,850-vertex worst chunk - below
  // the 282,150 the pre-rebuild giant shipped at 190 x 1,485.
  { name: 'giantKelp', asset: MESH_ASSET.GIANT_KELP, kind: 'forest', flora: ['fl_ribbonkelp'],
    build: (s, d) => generateGiantKelp(s, 84, 26, { detail: d, bands: 5, secondary: 2,
      girth: 1.75, bladeWide: 1.35, bladeLen: 1.1, crown: 10 }) },
  // The champion is `landmark` for the reason that band states: its maxPerChunk
  // is 28 against seagrass's thousands, it is the tallest plant in the world at
  // 42-56 m delivered, and 1,769 vertices of crown, branches and fruit is what
  // that costs (fruit 9 -> 18 in the 2026-08 fruit pass, measured over 8 seeds;
  // the tighter cluster radius paid for the extra berries). Inside the band.
  { name: 'kelpChampion', asset: MESH_ASSET.GIANT_KELP, kind: 'forest', flora: ['fl_ribbonkelp'],
    build: (s, d) => generateGiantKelp(s, 100, 24, { detail: d, bands: 5, secondary: 2, fruit: 20,
      girth: 2.0, bladeWide: 1.3, fruitLo: 0.68, crown: 10 }) },
  // THE SHIPPED ROW'S PARAMETERS, same rule as the champion above: the
  // `kelpBloom` row (world/scatter.js id 53) authors (20, 16, bands 3,
  // secondary 1, fruit 14), measured 1,202 vertices at HIGH over 8 seeds and
  // a 21.13 m local height, which its depth band [27, 60] clears at 25.1 m of
  // delivered plant against a scale x stretch top of 1.12 x 1.06.
  { name: 'kelpBloom', asset: MESH_ASSET.GIANT_KELP, kind: 'forest', flora: ['fl_ribbonkelp'],
    build: (s, d) => generateGiantKelp(s, 55, 18, { detail: d, bands: 4, secondary: 1, fruit: 14,
      girth: 1.6, bladeWide: 1.25, fruitLo: 0.68, crown: 6 }) },
  // THE SHIPPED ROW'S PARAMETERS, same rule as the two entries above: the
  // place-only `kelpColossus` row (world/scatter.js id 50, consumed by the
  // Grandmother Kelp place) authors (42, 22, fruit 14), measured 1,721
  // vertices at HIGH over 24 seeds against the landmark band's 2,000, mesh
  // height 47.14 m. `landmark` on the same justification as the champion: it
  // is placed ONCE, by a place, with maxPerChunk 3 as the safety valve.
  { name: 'kelpColossus', asset: MESH_ASSET.GIANT_KELP, kind: 'landmark', flora: ['fl_ribbonkelp'],
    build: (s, d) => generateGiantKelp(s, 84, 22, { detail: d, bands: 4, secondary: 2, fruit: 14,
      girth: 2.3, bladeWide: 1.3 }) },
  // RARE DEEP CANOPY. This is intentionally a separate row: the ordinary
  // giant's [40, 130] band already fills the middle forest, while this row
  // starts at 58 m so its measured ~45 m mesh can be scaled to a crown that
  // stops below the surface and still reaches the upper half of deep beds.
  { name: 'kelpCanopy', asset: MESH_ASSET.GIANT_KELP, kind: 'forest', flora: ['fl_ribbonkelp'],
    build: (s, d) => generateGiantKelp(s, 110, 20, {
      detail: d, bands: 5, secondary: 2, fruit: 12,
      girth: 2.1, bladeWide: 1.3, fruitLo: 0.70, crown: 10,
    }) },
  // THE SHIPPED ROW'S PARAMETERS, same rule as every kelp entry above: the
  // `kelpTitan` row (world/scatter.js id 66, the emerald rebuild's deep
  // pillars) authors (46, 24, bands 6, secondary 2, fruit 20, girth 2.6).
  // 1,957 vertices at HIGH, inside the landmark band; 56.54 m worst-case
  // local height over 12 seeds is the number its depth[0] = 60 is derived
  // from.
  { name: 'kelpTitan', asset: MESH_ASSET.GIANT_KELP, kind: 'forest', flora: ['fl_ribbonkelp'],
    build: (s, d) => generateGiantKelp(s, 124, 26, {
      detail: d, bands: 6, secondary: 2, fruit: 18,
      girth: 2.6, bladeWide: 1.35, fruitLo: 0.68, crown: 10,
    }) },
  { name: 'seagrass', asset: MESH_ASSET.SEAGRASS, kind: 'flora', flora: ['fl_siltgrass'],
    build: (s, d) => generateSeagrass(s, 0.7, 7, { detail: d }) },
  { name: 'shoreGrass', asset: MESH_ASSET.SHORE_GRASS, kind: 'flora', flora: ['fl_quillgrass', 'fl_pipe_reed'],
    build: (s, d) => generateShoreGrass(s, 1.35, 9, { detail: d }) },
  { name: 'alienFrond', asset: MESH_ASSET.ALIEN_FROND, kind: 'flora', flora: ['fl_ashfern', 'fl_veil_moss'],
    build: (s, d) => generateAlienFrond(s, 0.85, { detail: d }) },
  { name: 'coralBrain', asset: MESH_ASSET.CORAL_BRAIN, kind: 'coral', flora: ['fl_fanstone_coral'],
    build: (s, d) => generateCoralBrain(s, 0.95, { detail: d }) },
  { name: 'coralBranching', asset: MESH_ASSET.CORAL_BRANCH, kind: 'coral', flora: ['fl_pillar_coral', 'fl_bone_coral'],
    build: (s, d) => generateCoralBranching(s, 2.6, { detail: d }) },
  { name: 'coralFan', asset: MESH_ASSET.CORAL_FAN, kind: 'coral', flora: ['fl_dead_fan'],
    build: (s, d) => generateCoralFan(s, 2.2, { detail: d }) },
  { name: 'coralTube', asset: MESH_ASSET.CORAL_TUBE, kind: 'coral', flora: ['fl_tuberod'],
    build: (s, d) => generateCoralTube(s, 1.6, {
      detail: d, color: MESH_PALETTE.CORAL_CREAM, mouthColor: MESH_PALETTE.TUBEROD }) },
  { name: 'spongeUrn', asset: MESH_ASSET.SPONGE, kind: 'coral', flora: ['fl_urn_sponge'],
    build: (s, d) => generateSponge(s, 0.9, { detail: d }) },
  { name: 'spongeGlass', asset: MESH_ASSET.SPONGE, kind: 'coral', flora: ['fl_glass_sponge'],
    build: (s, d) => generateSponge(s, 2.4, {
      detail: d, form: 'tube', color: MESH_PALETTE.SPONGE_PALE }) },
  { name: 'mushroom', asset: MESH_ASSET.MUSHROOM, kind: 'structure', flora: ['fl_lampcap'],
    build: (s, d) => generateMushroom(s, 5.8, 1.95, { detail: d }) },
  { name: 'glowPod', asset: MESH_ASSET.GLOW_POD, kind: 'flora', flora: ['fl_lampweed', 'fl_glowcup', 'fl_hadal_wisp'],
    build: (s, d) => generateGlowPod(s, 0.55, { detail: d }) },
  { name: 'ventChimney', asset: MESH_ASSET.VENT_CHIMNEY, kind: 'structure', flora: [],
    build: (s, d) => generateVentChimney(s, 6, { detail: d }) },
  { name: 'boneRib', asset: MESH_ASSET.BONE_RIB, kind: 'structure', flora: [],
    build: (s, d) => generateBoneRib(s, 12, { detail: d }) },
  { name: 'oreFerrite', asset: MESH_ASSET.ORE_NODE, kind: 'ore', flora: [],
    build: (s, d) => generateOreNode(s, 0, 0.5, { detail: d }) },
  { name: 'oreCupric', asset: MESH_ASSET.ORE_NODE, kind: 'ore', flora: [],
    build: (s, d) => generateOreNode(s, 1, 0.45, { detail: d }) },
  { name: 'oreTitanite', asset: MESH_ASSET.ORE_NODE, kind: 'ore', flora: [],
    build: (s, d) => generateOreNode(s, 2, 0.5, { detail: d }) },
  { name: 'oreAurelite', asset: MESH_ASSET.ORE_NODE, kind: 'ore', flora: [],
    build: (s, d) => generateOreNode(s, 3, 0.4, { detail: d }) },
  { name: 'oreLithion', asset: MESH_ASSET.ORE_NODE, kind: 'ore', flora: [],
    build: (s, d) => generateOreNode(s, 4, 0.45, { detail: d }) },
  { name: 'oreArgent', asset: MESH_ASSET.ORE_NODE, kind: 'ore', flora: [],
    build: (s, d) => generateOreNode(s, 5, 0.4, { detail: d }) },
  { name: 'oreMagnetite', asset: MESH_ASSET.ORE_NODE, kind: 'ore', flora: [],
    build: (s, d) => generateOreNode(s, 6, 0.55, { detail: d }) },
  { name: 'oreVoidglass', asset: MESH_ASSET.ORE_NODE, kind: 'ore', flora: [],
    build: (s, d) => generateOreNode(s, 7, 0.5, { detail: d }) },
  // The two dark-mass forms. Their sizes here are the MIDPOINT of what the
  // scatter rows ask for, so what tools/test-meshgen.mjs measures is close to
  // what ships - the registry's own defaults are otherwise free to drift from
  // the table, and on `kelp` they already have by 1.8x.
  { name: 'stratumSlab', asset: MESH_ASSET.STRATUM_SLAB, kind: 'structure', flora: [],
    build: (s, d) => generateStratumSlab(s, 7.0, { detail: d }) },
  { name: 'whaleFall', asset: MESH_ASSET.WHALE_FALL, kind: 'landmark', flora: [],
    build: (s, d) => generateWhaleFall(s, 20, { detail: d }) },
  // THE SHIPPED ROW'S PARAMETERS (scatter id 51, the Ossuary Flats signature):
  // the 34 m articulated skeleton, not the generator's 20 m default - the same
  // drift rule the giantKelp entry above records.
  { name: 'ossuaryColossus', asset: MESH_ASSET.WHALE_FALL, kind: 'landmark', flora: [],
    build: (s, d) => generateWhaleFall(s, 34, { detail: d, vertebrae: 15, ribPairs: 8 }) },
  // THE SHIPPED ROW'S PARAMETERS (scatter id 52, place-only, consumed by the
  // Pale Ossuary place). `landmark` on the kelpColossus justification: placed
  // ONCE by a place, maxPerChunk in single figures.
  { name: 'paleOssuary', asset: MESH_ASSET.SKULL, kind: 'landmark', flora: [],
    build: (s, d) => generateSkull(s, 26, { detail: d }) },
  // `coral` and not `structure`, and this is a family classification rather than
  // band-shopping: a glass lattice is a SPONGE, `spongeUrn` and `spongeGlass` are
  // both `coral` in this registry already, and its 876-1,344 vertices sit mid-band
  // in 400-2,500 where `structure`'s 180-900 would force a lattice so coarse it
  // stops being one. The band that would have been wrong for it is `landmark`.
  { name: 'glassLattice', asset: MESH_ASSET.GLASS_LATTICE, kind: 'coral', flora: [],
    build: (s, d) => generateGlassLattice(s, 2.6, { detail: d }) },
  { name: 'spongeShelf', asset: MESH_ASSET.SPONGE_SHELF, kind: 'coral', flora: [],
    build: (s, d) => generateSpongeShelf(s, 3.4, { detail: d }) },
  // THE SHIPPED ROW'S PARAMETERS (scatter id 55, the Crimson Meadow signature):
  // height 17, capRadius 6.0, beds 4, crown 18 - the drift rule the giantKelp
  // entry above records. `landmark` on the whale-fall justification: the row
  // authors maxPerChunk 8 (single figures) against the carpet's thousands.
  { name: 'meadowPillar', asset: MESH_ASSET.MEADOW_PILLAR, kind: 'landmark', flora: [],
    build: (s, d) => generateMeadowPillar(s, 17, { detail: d, capRadius: 6.0, beds: 4, crown: 18 }) },
  // THE SHIPPED ROW'S PARAMETERS (scatter id 56, the meadow carpet): height
  // 1.0, blades 16. The plume row (id 57) is the same generator recoloured.
  { name: 'bloodGrass', asset: MESH_ASSET.BLOOD_GRASS, kind: 'flora', flora: [],
    build: (s, d) => generateBloodGrass(s, 0.5, 58, { detail: d }) },
  // The plume row (id 57) ships a DIFFERENT mesh off the same generator
  // (1.1 m, 7 blades, MEADOW_PLUME) - it gets its own entry per the
  // row-parameters rule, or test-meshgen never builds what ships.
  { name: 'crimsonPlume', asset: MESH_ASSET.BLOOD_GRASS, kind: 'flora', flora: [],
    build: (s, d) => generateBloodGrass(s, 1.1, 8, { detail: d, color: MESH_PALETTE.MEADOW_PLUME }) },
  // THE SHIPPED ROW'S PARAMETERS (scatter id 59, the Bulb Grove signature):
  // height 9.5, 3 trunks, secondary crown on. `landmark` on the meadowPillar
  // justification - the row authors maxPerChunk in single figures against the
  // grove floor's hundreds.
  // `fur` band (test-meshgen): dense-needle crown, maxPerChunk 12; the
  // landmark band's 2,000 is what kept the fur sparse for two review rounds.
  { name: 'bulbTree', asset: MESH_ASSET.BULB_TREE, kind: 'fur', flora: [],
    build: (s, d) => generateBulbTree(s, 11, { detail: d, trunks: 3, fruit: 20, secondary: 0 }) },
  // THE SHIPPED ROW'S PARAMETERS (scatter id 60): the single-trunk sapling.
  { name: 'bulbSapling', asset: MESH_ASSET.BULB_TREE, kind: 'flora', flora: [],
    build: (s, d) => generateBulbTree(s, 3.2, { detail: d, trunks: 1, fruit: 6, secondary: 0, spikes: 150 }) },
  // THE SHIPPED ROW'S PARAMETERS (scatter id 61): the trunkless teal ground pom.
  { name: 'pomPuff', asset: MESH_ASSET.BULB_TREE, kind: 'flora', flora: [],
    build: (s, d) => generateBulbTree(s, 1.1, {
      detail: d, ground: true, fruit: 4, spikes: 130,
      color: MESH_PALETTE.POM_TEAL, deepColor: MESH_PALETTE.POM_TEAL,
      tipColor: MESH_PALETTE.POM_TEAL_TIP }) },
  // THE SHIPPED ROW'S PARAMETERS (scatter id 62, the Platter Forest
  // signature): height 34, 6 platters. `landmark` band on the meadowPillar /
  // bulbTree justification - the row authors maxPerChunk in single figures.
  { name: 'platterSpire', asset: MESH_ASSET.PLATTER_SPIRE, kind: 'landmark', flora: [],
    build: (s, d) => generatePlatterSpire(s, 46, { detail: d, platters: 4 }) },
  // THE SHIPPED ROW'S PARAMETERS (scatter id 63): the young three-platter
  // column.
  { name: 'platterYoung', asset: MESH_ASSET.PLATTER_SPIRE, kind: 'structure', flora: [],
    build: (s, d) => generatePlatterSpire(s, 18, { detail: d, platters: 3 }) },
  // THE SHIPPED ROW'S PARAMETERS (scatter id 64): the pink ground rings.
  { name: 'ringHalo', asset: MESH_ASSET.RING_HALO, kind: 'flora', flora: [],
    build: (s, d) => generateRingHalo(s, 1.6, { detail: d }) },
  // THE SHIPPED ROW'S PARAMETERS (scatter id 65): the olive floor tufts, off
  // the blood-grass turf generator with the forest's own colour - the
  // rows-off-one-generator pattern.
  { name: 'rustTuft', asset: MESH_ASSET.BLOOD_GRASS, kind: 'flora', flora: [],
    build: (s, d) => generateBloodGrass(s, 0.7, 30, {
      detail: d, color: MESH_PALETTE.RUST_TUFT }) },
  // THE SHIPPED PARAMETERISATION of the Jellyshroom Hollow's landmark prop
  // (world/cave_sites.js): height 14, which cave_sites' per-shroom heights
  // scale against. `landmark` on the kelpColossus justification - placed at
  // most 14 times in the world, all by one authored cave site, never by a
  // scatter row.
  { name: 'jellyshroom', asset: MESH_ASSET.JELLYSHROOM, kind: 'landmark', flora: [],
    build: (s, d) => generateJellyshroom(s, 14, { detail: d }) },
  // The Hollow's ceiling/floor speleothems: generateCrystal re-parameterised
  // purple, exactly as crystalDruse re-parameterises it amethyst. Own entry
  // per the row-parameters rule: the cave prop library builds THIS shape
  // (4.2 m, 6 facets, 4 prisms), and an entry at the generator's defaults
  // would measure a mesh that ships nowhere.
  { name: 'jellySpeleothem', asset: MESH_ASSET.CRYSTAL, kind: 'structure', flora: [],
    build: (s, d) => generateCrystal(s, 4.2, 6, {
      detail: d, prisms: 4,
      color: MESH_PALETTE.JELLY_CRYSTAL, veinColor: MESH_PALETTE.JELLY_GLOW }) },
  // THE SHIPPED ROW'S PARAMETERS (scatter id 68, the Sunken Dunes signature):
  // the 40 m dead-leviathan ribcage, one size up from the ossuary's 34 m -
  // the drift rule again.
  { name: 'duneColossus', asset: MESH_ASSET.WHALE_FALL, kind: 'landmark', flora: [],
    build: (s, d) => generateWhaleFall(s, 40, { detail: d, vertebrae: 17, ribPairs: 9 }) },
  // THE SHIPPED ROW'S PARAMETERS (scatter id 69): the 20 m lone breach rib -
  // NOT the 1.5 m boneRib row's mesh, so it gets its own entry.
  { name: 'duneRib', asset: MESH_ASSET.BONE_RIB, kind: 'structure', flora: [],
    build: (s, d) => generateBoneRib(s, 20, { detail: d, taper: 0.26 }) },
  // THE SHIPPED ROW'S PARAMETERS (scatter id 70): the 2.6 m crimson fan.
  { name: 'duneFan', asset: MESH_ASSET.CORAL_FAN, kind: 'coral', flora: [],
    build: (s, d) => generateCoralFan(s, 2.6, { detail: d, thickness: 0.22 }) },
  // THE SHIPPED ROW'S PARAMETERS (scatter id 71): the 0.45 m shell hash.
  { name: 'duneShell', asset: MESH_ASSET.PEBBLE, kind: 'rock', flora: [],
    build: (s, d) => generatePebble(s, 0.45, { detail: d }) },
];

/**
 * Build one registry entry by name.
 *
 * @param {string} name a MESH_GENERATORS name
 * @param {number} seed
 * @param {number} [detail] MESH_DETAIL tier
 * @returns {object} the build() struct
 * @throws {Error} if the name is not in the registry
 */
export function buildMesh(name, seed, detail = MESH_DETAIL.HIGH) {
  const entry = MESH_GENERATORS.find((g) => g.name === name);
  if (!entry) throw new Error(`meshgen: no generator named '${name}'`);
  return entry.build(seed, detail);
}
