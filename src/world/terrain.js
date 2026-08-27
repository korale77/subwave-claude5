/**
 * SUBWAVE terrain.
 *
 * The authoritative heightfield H(x, z) -> y, plus the chunk baker that turns
 * it into meshes. Everything here is a PURE function of (x, z) and the world
 * seed: no evaluation order, no neighbour state, no per-chunk RNG. That is what
 * makes chunk seams exact rather than approximately exact, lets collision and
 * rendering agree to the last bit, and lets a chunk be rebaked in isolation (or
 * in a worker) at any time.
 *
 * The world is a drowned volcanic caldera.
 *
 *   r = 0     .. 340 m   the SAFE CRATER: a calm reef lagoon, -4 to -18 m.
 *                        The player starts here. It is analytically guaranteed
 *                        shallow (see LAYER 12) - never left to noise chance.
 *   r = 340   .. 470 m   biogenic reef rim, crest at -4 m, which is what breaks
 *                        the swell and makes the lagoon a lagoon.
 *   r = 430   .. 1330 m  ASHCONE ISLE, offset to the north-west, summit +214 m.
 *   r = 470   .. 1860 m  continental shelf, -12 to -128 m, sand and kelp.
 *   r = 1860  .. 2600 m  the SHELF BREAK: a 36-degree wall down to -650 m.
 *   r = 2600  .. 4400 m  abyssal plain, settling at -1040 m.
 *   corridor            THE DRAW: a hadal graben on bearing 132 deg reaching
 *                        -1600 m, cut as a hard minimum so it is always there.
 *   corridor            THE SPILL: a submarine canyon on bearing ~292 deg, the
 *                        intended descent route from the reef to the basin.
 *
 * COORDINATES: +X east, +Y up, +Z south, metres, sea level y = 0, depth = -y.
 *
 * Where DESIGN/01 and DESIGN/02 disagree with core/constants.js (they describe
 * a 16 km world; ours is 6144 m), constants.js wins and the layout above is the
 * transposition of the same geology onto the smaller playfield.
 *
 * THIS MODULE IS WORKER-SAFE AND MUST STAY THAT WAY. src/world/terrain_worker.js
 * imports it into a module Web Worker, so nothing reachable from here may touch
 * the DOM, the GPU or `window` - not in this file and not in anything it imports
 * (constants, math, noise, biomes, and entities/vessel_mesh.js for one constant).
 * The failure mode is silent: a module-resolution failure inside a worker
 * surfaces as an `error` event with an EMPTY message, and chunks.js would simply
 * warn once and fall back to baking on the frame. Every worker also gets its own
 * private copy of the scratch state below (_seed/S/_canyon/_trench/_warp/_prof/
 * _corr), which is exactly why baking off-thread is bit-identical: verified on
 * chunk (7, 11, 0) at 0 differing bytes of 686,120 vertex and 202,752 index.
 */

import { WORLD } from '../core/constants.js';
import { clamp, saturate, lerp, smoothstep, hashU32, hash3i } from '../core/math.js';
import {
  simplex2, value2, fbm2, ridged2, billow2, worley2, worley2Edge,
  domainWarp2, smin, smax,
} from './noise.js';
import { materialAt, setBiomeSeed } from './biomes.js';
// findSpawnPoint() has to park the Kestrel ON its skids, and only the mesh knows
// how far below the origin they reach. Importing the number beats copying it:
// a copy is a second source of truth that goes stale the first time the skids
// are redesigned, and the failure it produces is a vessel quietly hovering.
import { VESSEL_SKID_DROP } from '../entities/vessel_mesh.js';
import { HABITAT_SITE } from './habitat_site.js';

// ===========================================================================
// Layer registry
// ===========================================================================

/**
 * The octave stack, in evaluation order. This is introspectable data, not
 * documentation: the debug overlay renders it and the verification script
 * asserts the amplitudes it quotes.
 *
 * `amplitude` is peak contribution in METRES, `frequency` in 1/m (cycles per
 * metre of the FIRST octave). A frequency of 0 marks an analytic layer whose
 * shape comes from a control-point table rather than from noise.
 */
export const TERRAIN_LAYERS = Object.freeze([
  Object.freeze({ id: 0,  name: 'CONTINENTAL',  kind: 'analytic', amplitude: 1600, frequency: 0,       octaves: 0, mask: null,
    note: 'Monotone-Hermite radial bathymetry about the crater centre, sampled at a domain-warped radius.' }),
  Object.freeze({ id: 1,  name: 'MACRO_WARP',   kind: 'warp',     amplitude: 190,  frequency: 1 / 2600, octaves: 1, mask: 'outsideCrater',
    note: 'Lateral domain warp in metres. Zero inside the safe crater so the lagoon stays exactly where it is promised to be.' }),
  Object.freeze({ id: 2,  name: 'ISLAND',       kind: 'analytic', amplitude: 214,  frequency: 1 / 238,  octaves: 2, mask: 'island',
    note: 'Second Hermite profile about the island centre, merged with smax(); its radius is jittered to break the circular coastline.' }),
  Object.freeze({ id: 3,  name: 'BROAD_RELIEF', kind: 'fbm',      amplitude: 30,   frequency: 1 / 760,  octaves: 4, mask: 'notCrater',
    note: 'Basin and shelf undulation. The only layer that runs everywhere.' }),
  Object.freeze({ id: 4,  name: 'RIDGE_SPURS',  kind: 'ridged',   amplitude: 54,   frequency: 1 / 560,  octaves: 3, mask: 'slope',
    note: 'Buttresses and gullies on anything steeper than ~17 deg. This is what makes the shelf break read as rock, not as a ramp.' }),
  Object.freeze({ id: 5,  name: 'ROCK_SPIRES',  kind: 'profile',  amplitude: 178,  frequency: 1 / 280,  octaves: 0, mask: 'shelfPatches',
    note: 'Sparse authored pinnacles with separate foot, wall and crown profiles. Clustered across the twilight shelf rather than spread as another noise octave.' }),
  Object.freeze({ id: 6,  name: 'MID_DETAIL',   kind: 'fbm',      amplitude: 4.5,  frequency: 1 / 44,   octaves: 4, mask: 'notCrater',
    note: 'Value-noise fill between the 760 m and 9 m scales; value rather than simplex because it is four times cheaper and this band is slope-damped anyway.' }),
  Object.freeze({ id: 7,  name: 'ISLAND_RELIEF',kind: 'ridged',   amplitude: 32,   frequency: 1 / 170,  octaves: 3, mask: 'island',
    note: 'Ridged spurs plus a fine value-fbm: the volcano\'s radial ravines.' }),
  Object.freeze({ id: 8,  name: 'CANYON',       kind: 'corridor', amplitude: 205,  frequency: 0,       octaves: 0, mask: 'canyon',
    note: 'Subtractive carve along a jittered Catmull-Rom centreline.' }),
  Object.freeze({ id: 9,  name: 'TRENCH',       kind: 'corridor', amplitude: 1600, frequency: 0,       octaves: 0, mask: 'trench',
    note: 'Hard min() against a quintic wall profile, so the trench floor is absolute and the rim it cuts survives right up to the lip.' }),
  Object.freeze({ id: 10, name: 'BOMMIES',      kind: 'worley',   amplitude: 5.5,  frequency: 1 / 26,   octaves: 1, mask: 'reef',
    note: 'Inverted Worley F1 mounds: coral heads on the reef flat.' }),
  Object.freeze({ id: 11, name: 'DUNES',        kind: 'billow',   amplitude: 1.9,  frequency: 1 / 48,   octaves: 3, mask: 'sediment',
    note: 'Anisotropic 3.4:1 billow on a domain-warped plane. Sand ripples on flat sediment only.' }),
  Object.freeze({ id: 12, name: 'TALUS',        kind: 'worley',   amplitude: 1.4,  frequency: 1 / 8.5,  octaves: 1, mask: 'slope',
    note: 'Worley edge scree on steep rock.' }),
  Object.freeze({ id: 13, name: 'SHORE_FLATTEN',kind: 'shaping',  amplitude: 9,    frequency: 0,       octaves: 0, mask: 'shore',
    note: 'Compresses the island profile through the waterline so the beach is walkable and free of noise spikes.' }),
  Object.freeze({ id: 14, name: 'MICRO',        kind: 'fbm',      amplitude: 0.55, frequency: 1 / 9,    octaves: 3, mask: null,
    note: 'Sub-metre relief. Below the LOD-0 sample pitch it only shows in the normals.' }),
  Object.freeze({ id: 15, name: 'CRATER_GUARD', kind: 'clamp',    amplitude: 0,    frequency: 0,       octaves: 0, mask: 'crater',
    note: 'Soft C1 clamp to [-18.5, -3.4] inside SAFE_CRATER_RADIUS. The safety net that makes the start zone a promise instead of a hope.' }),
  Object.freeze({ id: 16, name: 'WORLD_CLAMP',  kind: 'clamp',    amplitude: 0,    frequency: 0,       octaves: 0, mask: null,
    note: 'clamp(h, -MAX_DEPTH, MAX_TERRAIN_HEIGHT).' }),
]);

// ===========================================================================
// Geometry constants
// ===========================================================================

const CRATER_X = WORLD.SAFE_CRATER_CENTER[0];
const CRATER_Z = WORLD.SAFE_CRATER_CENTER[1];
const CRATER_R = WORLD.SAFE_CRATER_RADIUS;          // 340 m

/** Guaranteed lagoon depth envelope, metres of y. */
const CRATER_FLOOR_Y = -18.5;
const CRATER_CEIL_Y = -3.4;
/** The guard is full strength across the whole promised disc, then released. */
const CRATER_GUARD_OUT = WORLD.SAFE_FALLOFF_RADIUS; // 460 m

/**
 * Ashcone Isle. Placed 820 m from the crater centre so that its waterline
 * (island radius 375 m, jittered +/-14 m) lands at 431..459 m from the origin -
 * outside the promised lagoon with 90 m of margin, and a two-minute swim from
 * the start point.
 */
const ISLAND_X = -492;
const ISLAND_Z = -656;
const ISLAND_SHORE_R = 375;
/** Radial jitter of the coastline, metres. Deliberately much smaller than the
 *  55 m strand so the beach can never degenerate into a cliff. */
const ISLAND_JITTER_AMP = 14;
/** Softness of the smax() that merges the island into the seabed, metres. */
const ISLAND_BLEND_K = 6;

const MAX_H = WORLD.MAX_TERRAIN_HEIGHT;             // +214 m
const MIN_H = -WORLD.MAX_DEPTH;                     // -1600 m

/**
 * A masked layer is skipped where it would contribute less than this many
 * metres. The bound has to be expressed against each layer's AMPLITUDE, not as
 * a flat mask threshold: skipping the 54 m ridge layer wherever its mask drops
 * below 0.01 puts a 0.37 m step along the mask's contour, and a step in a
 * heightfield is a dead-straight hairline ridge running for kilometres - the
 * single most recognisable way procedural terrain betrays itself. 1 mm is a
 * thousandth of the LOD-0 sample pitch, so the contour cannot be resolved by
 * any mesh or normal the world will ever build.
 */
const LAYER_EPSILON = 1e-3;

/** Domain-warp amplitudes (metres) and their onset radius. */
const WARP_AMP = 190;
const WARP_FREQ = 1 / 2600;
const WARP_ONSET_IN = 320;
const WARP_ONSET_OUT = 1500;

// ---------------------------------------------------------------------------
// Radial bathymetry, metres. (radius from the crater centre, y)
// The local high at r = 385 is the reef rim: the physical wall that makes the
// start lagoon a lagoon. The 1860 -> 2600 run is the shelf break, laid out so
// its mean slope is 36 deg - steep enough to read as an edge of the world,
// shallow enough for a diving vessel to follow without colliding.
// ---------------------------------------------------------------------------
const OCEAN_POINTS = [
  [0, -15.5], [110, -17.5], [230, -15.0], [300, -12.0], [340, -9.5],
  [385, -5.2], [440, -6.4], [520, -12.0], [650, -19.0], [820, -26.0],
  [1050, -35.0], [1300, -46.0], [1550, -62.0], [1720, -86.0], [1860, -128.0],
  [2000, -232.0], [2180, -372.0], [2380, -520.0], [2600, -652.0], [2900, -782.0],
  [3250, -890.0], [3700, -958.0], [4400, -1018.0], [6000, -1040.0],
];

// ---------------------------------------------------------------------------
// Island profile, metres from the island centre. Summit +214 m at r = 0 - the
// exact WORLD.MAX_TERRAIN_HEIGHT, reached rather than clipped because the
// island relief layer is tapered to nothing inside r = 60.
//
// The strand runs from r = 345 (+5 m) through the waterline at 375 to r = 400
// (-3.2 m): a 55 m band at gradients of 0.17 and 0.13, i.e. 7 to 9.5 deg. That
// is the walkable beach, and it is four times wider than the coastline jitter
// so it can never degenerate into a cliff.
//
// Past r = 610 the profile dives below the surrounding seabed, which is how
// smax() hands the terrain smoothly back to the ocean profile.
// ---------------------------------------------------------------------------
const ISLAND_POINTS = [
  [0, 214.0], [30, 190.0], [70, 156.0], [115, 120.0], [160, 90.0],
  [205, 64.0], [250, 42.0], [285, 24.0], [315, 12.0], [345, 5.0],
  [375, 0.0], [400, -3.2], [435, -6.5], [480, -11.0], [540, -20.0],
  [610, -34.0], [690, -56.0], [780, -95.0], [900, -190.0], [1100, -700.0],
  [1350, -1600.0],
];

// ---------------------------------------------------------------------------
// Corridors. Polar control points (radius m, azimuth deg, halfWidth m, value).
// Azimuth follows the game convention: 0 = north (-Z), clockwise from above.
// ---------------------------------------------------------------------------

/** The Spill: subtractive canyon. `value` is the carve depth below local terrain. */
const CANYON_POINTS = [
  [900, 296, 50, 14], [1250, 300, 85, 40], [1650, 292, 120, 78],
  [2100, 285, 155, 130], [2650, 281, 175, 178], [3300, 278, 180, 205],
];

/** The Draw: hadal graben. `value` is the ABSOLUTE floor y. */
const TRENCH_POINTS = [
  [1600, 128, 190, -170], [2000, 131, 300, -430], [2450, 134, 430, -770],
  [2950, 133, 560, -1120], [3450, 131, 660, -1420], [4100, 130, 720, -1600],
];

// Radial floor progression has an authored landing between 2.75 and 2.88 km.
// Besides giving the descent a readable scale break, this is the genuinely
// low-slope ground the Trench Floor biome promises inside the playable radius.
// The steep steps either side keep the final hadal depth unchanged.
const TRENCH_FLOOR_POINTS = [
  [1600, -170], [2000, -430], [2450, -770], [2650, -1010],
  [2750, -1040], [2875, -1052.5], [3000, -1080], [3200, -1240],
  [3450, -1420], [4100, -1600],
];

// ===========================================================================
// Seeding
// ===========================================================================

/**
 * Layer salts. Never renumber: changing one changes every existing world.
 * Seeds are folded to 24 bits so the `seed + octave * 1013` that fbm2 applies
 * internally stays an exactly-representable small integer.
 */
const SALT = {
  WARP: 0x00010001, BROAD: 0x00010002, RIDGE: 0x00010003, MID: 0x00010004,
  ISLAND_R: 0x00010005, ISLAND_E: 0x00010006, ISLAND_JITTER: 0x00010007,
  CANYON: 0x00010008, TRENCH: 0x00010009, TERRACE: 0x0001000a,
  BOMMIE: 0x0001000b, DUNE: 0x0001000c, TALUS: 0x0001000d, MICRO: 0x0001000e,
  DUNE_DIR: 0x0001000f, SPIRE: 0x00010010, SPIRE_PATCH: 0x00010011,
  KELP_BASIN: 0x00010012,
  SPLITMAW_SHOAL: 0x00010013, SPLITMAW_DUNE: 0x00010014, SPLITMAW_RIPPLE: 0x00010015,
};

let _seed = WORLD.DEFAULT_SEED >>> 0;
/** @type {Record<string, number>} derived per-layer seeds */
const S = {};
/** @type {object} */ let _canyon = null;
/** @type {object} */ let _trench = null;

function deriveSeeds() {
  for (const k of Object.keys(SALT)) S[k] = hashU32(_seed ^ SALT[k]) >>> 8;
  _canyon = buildCorridor(CANYON_POINTS, S.CANYON, 110);
  _trench = buildCorridor(TRENCH_POINTS, S.TRENCH, 160);
  setBiomeSeed(_seed);
}

/** Set the world seed. Rebuilds the derived seeds and the corridor splines. */
export function setSeed(seed) {
  _seed = seed >>> 0;
  deriveSeeds();
  return _seed;
}

export function getSeed() { return _seed; }

// ===========================================================================
// Monotone cubic Hermite profiles (Fritsch-Carlson)
// ===========================================================================

/**
 * Build a shape-preserving cubic spline through the control points. Ordinary
 * Catmull-Rom overshoots between a steep segment and a flat one, which here
 * would put a hump above sea level in the middle of the shelf break; the
 * Fritsch-Carlson tangent limiter makes overshoot impossible.
 */
function makeProfile(points) {
  const n = points.length;
  const r = new Float64Array(n);
  const y = new Float64Array(n);
  const m = new Float64Array(n);
  for (let i = 0; i < n; i++) { r[i] = points[i][0]; y[i] = points[i][1]; }

  const d = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) d[i] = (y[i + 1] - y[i]) / (r[i + 1] - r[i]);

  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) * 0.5;
  }
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return { r, y, m, n };
}

const OCEAN_PROFILE = makeProfile(OCEAN_POINTS);
const ISLAND_PROFILE = makeProfile(ISLAND_POINTS);
// The trench centreline may meander close to itself. Distance still comes from
// that line, but progression-dependent properties must not come from whichever
// segment happens to be a centimetre nearer: two non-adjacent segments can
// carry floor values hundreds of metres apart. Radius is monotone along the
// authored route, so these profiles make width and floor globally continuous.
const TRENCH_WIDTH_PROFILE = makeProfile(TRENCH_POINTS.map((p) => [p[0], p[2]]));
const TRENCH_FLOOR_PROFILE = makeProfile(TRENCH_FLOOR_POINTS);

/**
 * Height and radial derivative of a profile. The derivative is free here and
 * is what every slope mask uses, which is why no layer ever needs a finite
 * difference of the full stack.
 */
const _prof = { y: 0, dy: 0 };
function evalProfile(p, x) {
  const { r, y, m, n } = p;
  if (x <= r[0]) { _prof.y = y[0] + (x - r[0]) * m[0]; _prof.dy = m[0]; return _prof; }
  if (x >= r[n - 1]) { _prof.y = y[n - 1]; _prof.dy = 0; return _prof; }

  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (r[mid] <= x) lo = mid; else hi = mid;
  }
  const h = r[hi] - r[lo];
  const t = (x - r[lo]) / h;
  const t2 = t * t, t3 = t2 * t;
  _prof.y = (2 * t3 - 3 * t2 + 1) * y[lo] + (t3 - 2 * t2 + t) * h * m[lo]
          + (-2 * t3 + 3 * t2) * y[hi] + (t3 - t2) * h * m[hi];
  _prof.dy = ((6 * t2 - 6 * t) * y[lo] + (-6 * t2 + 6 * t) * y[hi]) / h
           + (3 * t2 - 4 * t + 1) * m[lo] + (3 * t2 - 2 * t) * m[hi];
  return _prof;
}

// ===========================================================================
// Corridors (canyon + trench)
// ===========================================================================

const CORRIDOR_SEGMENTS_PER_SPAN = 9;
const CORRIDOR_CELL = 192;

/**
 * Resample a polar control polygon into a jittered polyline plus a uniform
 * grid over its segments.
 *
 * The grid matters: without it every one of the 17 689 samples in a LOD-0 bake
 * would test all 46 segments of both corridors.
 *
 * Every segment is rasterised with the SAME global reach rather than with its
 * own, which costs a slightly longer candidate list and buys the only property
 * that matters: the candidate set of a cell contains the true nearest segment
 * for every point in that cell, so `corridorQuery` returns the same nearest
 * point no matter which cell the sample lands in. Rasterising each segment with
 * its own (narrower) reach lets a cell omit a segment that is nonetheless the
 * nearest, and then the carve depth jumps by up to 0.10 m across a cell
 * boundary - a hairline ridge running dead straight for kilometres, which is
 * exactly what a procedural world must never contain.
 */
function buildCorridor(points, seed, jitterAmp) {
  const cn = points.length;
  const cx = new Float64Array(cn);
  const cz = new Float64Array(cn);
  for (let i = 0; i < cn; i++) {
    const r = points[i][0];
    const a = points[i][1] * Math.PI / 180;
    cx[i] = Math.sin(a) * r;
    cz[i] = -Math.cos(a) * r;
  }

  const n = (cn - 1) * CORRIDOR_SEGMENTS_PER_SPAN + 1;
  const px = new Float64Array(n);
  const pz = new Float64Array(n);
  const pw = new Float64Array(n);
  const pv = new Float64Array(n);

  for (let k = 0; k < n; k++) {
    const u = (k / (n - 1)) * (cn - 1);
    const i = Math.min(cn - 2, Math.floor(u));
    const t = u - i;
    const i0 = Math.max(0, i - 1), i1 = i, i2 = i + 1, i3 = Math.min(cn - 1, i + 2);
    // Catmull-Rom, tension 0.5.
    const t2 = t * t, t3 = t2 * t;
    const b0 = -0.5 * t3 + t2 - 0.5 * t;
    const b1 = 1.5 * t3 - 2.5 * t2 + 1;
    const b2 = -1.5 * t3 + 2 * t2 + 0.5 * t;
    const b3 = 0.5 * t3 - 0.5 * t2;
    px[k] = b0 * cx[i0] + b1 * cx[i1] + b2 * cx[i2] + b3 * cx[i3];
    pz[k] = b0 * cz[i0] + b1 * cz[i1] + b2 * cz[i2] + b3 * cz[i3];
    pw[k] = lerp(points[i1][2], points[i2][2], t);
    pv[k] = lerp(points[i1][3], points[i2][3], t);
  }

  // Lateral jitter, applied along the local normal so the corridor meanders
  // without ever changing its length or self-intersecting at these amplitudes.
  const jx = new Float64Array(n);
  const jz = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k - 1), b = Math.min(n - 1, k + 1);
    let tx = px[b] - px[a], tz = pz[b] - pz[a];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    const u = k / (n - 1);
    // Taper to zero at both ends so the mouth stays where the table put it.
    const taper = Math.sin(Math.PI * u);
    const j = fbm2(simplex2, u * 5.5, 0.37, seed, 3) * jitterAmp * taper;
    jx[k] = px[k] + -tz * j;
    jz[k] = pz[k] + tx * j;
  }

  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  let maxHalf = 0;
  for (let k = 0; k < n; k++) {
    if (jx[k] < minX) minX = jx[k];
    if (jx[k] > maxX) maxX = jx[k];
    if (jz[k] < minZ) minZ = jz[k];
    if (jz[k] > maxZ) maxZ = jz[k];
    if (pw[k] > maxHalf) maxHalf = pw[k];
  }
  const reach = maxHalf * 1.25 + 24;
  const gx0 = minX - reach, gz0 = minZ - reach;
  const gw = Math.max(1, Math.ceil((maxX + reach - gx0) / CORRIDOR_CELL));
  const gh = Math.max(1, Math.ceil((maxZ + reach - gz0) / CORRIDOR_CELL));

  // CSR build: count, prefix-sum, fill.
  const counts = new Int32Array(gw * gh);
  const bounds = new Int32Array((n - 1) * 4);
  const rr = reach;
  for (let k = 0; k < n - 1; k++) {
    const bx0 = Math.max(0, Math.floor((Math.min(jx[k], jx[k + 1]) - rr - gx0) / CORRIDOR_CELL));
    const bx1 = Math.min(gw - 1, Math.floor((Math.max(jx[k], jx[k + 1]) + rr - gx0) / CORRIDOR_CELL));
    const bz0 = Math.max(0, Math.floor((Math.min(jz[k], jz[k + 1]) - rr - gz0) / CORRIDOR_CELL));
    const bz1 = Math.min(gh - 1, Math.floor((Math.max(jz[k], jz[k + 1]) + rr - gz0) / CORRIDOR_CELL));
    bounds[k * 4] = bx0; bounds[k * 4 + 1] = bx1; bounds[k * 4 + 2] = bz0; bounds[k * 4 + 3] = bz1;
    for (let gz = bz0; gz <= bz1; gz++) {
      for (let gxi = bx0; gxi <= bx1; gxi++) counts[gz * gw + gxi]++;
    }
  }
  const start = new Int32Array(gw * gh + 1);
  for (let i = 0; i < gw * gh; i++) start[i + 1] = start[i] + counts[i];
  const items = new Int32Array(start[gw * gh]);
  const cursor = start.slice(0, gw * gh);
  for (let k = 0; k < n - 1; k++) {
    const bx0 = bounds[k * 4], bx1 = bounds[k * 4 + 1];
    const bz0 = bounds[k * 4 + 2], bz1 = bounds[k * 4 + 3];
    for (let gz = bz0; gz <= bz1; gz++) {
      for (let gxi = bx0; gxi <= bx1; gxi++) items[cursor[gz * gw + gxi]++] = k;
    }
  }

  return { n, x: jx, z: jz, w: pw, v: pv, reach2: reach * reach, gx0, gz0, gw, gh, start, items };
}

/**
 * Nearest point on a corridor. Writes into a module scratch (no allocation in
 * the bake loop) and returns false when the sample is outside every segment's
 * influence, which is the common case and costs one grid lookup.
 */
const _corr = { d: 0, w: 0, v: 0 };
function corridorQuery(c, x, z) {
  const gxi = Math.floor((x - c.gx0) / CORRIDOR_CELL);
  const gzi = Math.floor((z - c.gz0) / CORRIDOR_CELL);
  if (gxi < 0 || gzi < 0 || gxi >= c.gw || gzi >= c.gh) return false;
  const cell = gzi * c.gw + gxi;
  const lo = c.start[cell], hi = c.start[cell + 1];
  if (lo === hi) return false;

  let bestD2 = Infinity, bestK = -1, bestT = 0;
  for (let i = lo; i < hi; i++) {
    const k = c.items[i];
    const ax = c.x[k], az = c.z[k];
    const bx = c.x[k + 1], bz = c.z[k + 1];
    const ex = bx - ax, ez = bz - az;
    const len2 = ex * ex + ez * ez;
    let t = len2 > 0 ? ((x - ax) * ex + (z - az) * ez) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - (ax + ex * t);
    const dz = z - (az + ez * t);
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; bestK = k; bestT = t; }
  }
  if (bestK < 0 || bestD2 > c.reach2) return false;

  _corr.d = Math.sqrt(bestD2);
  _corr.w = lerp(c.w[bestK], c.w[bestK + 1], bestT);
  _corr.v = lerp(c.v[bestK], c.v[bestK + 1], bestT);
  return true;
}

// ===========================================================================
// The heightfield
// ===========================================================================

const _warp = new Float64Array(2);

// Eight exact-ish unit directions, selected by cell hash. The diagonals use a
// fixed literal rather than trigonometry because this is authoritative terrain.
const SPIRE_DIRECTIONS = Object.freeze([
  Object.freeze([1, 0]), Object.freeze([0.7071067811865476, 0.7071067811865476]),
  Object.freeze([0, 1]), Object.freeze([-0.7071067811865476, 0.7071067811865476]),
  Object.freeze([-1, 0]), Object.freeze([-0.7071067811865476, -0.7071067811865476]),
  Object.freeze([0, -1]), Object.freeze([0.7071067811865476, -0.7071067811865476]),
]);
const _spireDistances = { primary: 0, satellite: 0 };

// Outer radius of the spire foot, in units of the 280 m spire cell - the point
// at which the profile reaches exactly zero. LAYER 5's acceptance gate, its
// profile AND the cell-pruning bound below MUST agree on this number: a wider
// gate pays for samples that add nothing, and a narrower one clips the rubble
// apron off at a cliff.
const SPIRE_FOOT_OUT = 0.190;
const SPIRE_SAT_FOOT_OUT = 0.122;
const SPIRE_FOOT_OUT2 = SPIRE_FOOT_OUT * SPIRE_FOOT_OUT;
const SPIRE_SAT_FOOT_OUT2 = SPIRE_SAT_FOOT_OUT * SPIRE_SAT_FOOT_OUT;

// The cluster's cell-space geometry, named once so the distance search and the
// pruning bound that skips cells cannot drift apart. A site sits within
// +-SPIRE_SITE_REACH of its cell centre on each axis; the longest companion arm
// displaces a needle by at most SPIRE_ARM_MAIN more on either axis (the second
// companion's per-axis extent is 0.215 at dir = (0, +-1) and 0.184 on the
// diagonals, both inside 0.255), so no part of a cell's cluster can lie further
// than SPIRE_SAT_REACH from the cell centre along either axis.
const SPIRE_JITTER = 0.78;
const SPIRE_SITE_REACH = SPIRE_JITTER * 0.5;
const SPIRE_ARM_MAIN = 0.255;
const SPIRE_SAT_REACH = SPIRE_SITE_REACH + SPIRE_ARM_MAIN;

// The spire band's own support, so the four smoothsteps that compute it are
// skipped outright everywhere they would return zero. Both edges of each
// smoothstep are exact saturate() clamps, so the guard is bit-identical.
const SPIRE_BAND_R_IN = 1680, SPIRE_BAND_R_OUT = 2860;
const SPIRE_BAND_D_IN = 105, SPIRE_BAND_D_OUT = 810;

/**
 * Distance to a cellular tower and to either of its two companion needles.
 *
 * This deliberately performs one 3x3 cell search for all three shapes. Calling
 * worley2 three times would repeat the hashes and make the most expensive LOD-0
 * shelf chunk miss its frame budget. Squared distances are compared in the
 * loop and square-rooted only for the two winners.
 *
 * CELLS THAT CANNOT REACH EITHER ACCEPTANCE RADIUS ARE SKIPPED BEFORE THEY ARE
 * HASHED, and the returned distances stay exact wherever LAYER 5 can use them.
 * The bound is the axis-separated distance from the sample to the cell's jitter
 * box (SPIRE_SITE_REACH) and to its companion box (SPIRE_SAT_REACH); a cell is
 * dropped only when BOTH bounds already exceed the widest gate LAYER 5 can
 * open, which is SPIRE_FOOT_OUT / SPIRE_SAT_FOOT_OUT at siteMask = 1. So for
 * every sample either the reported distance is the true minimum, or it is at
 * least the foot radius - in which case the gate rejects and the profile is
 * exactly zero either way. Measured over 967,326 cluster calls across the whole
 * annulus: 6.66 of 9 cells skipped on average (2.34 hashed), and every one of
 * 2,395,499 heights bit-identical to the unpruned search.
 */
function spireClusterDistances(x, z, seed) {
  const xi = Math.floor(x), zi = Math.floor(z);
  let primary2 = Infinity, satellite2 = Infinity;
  for (let dz = -1; dz <= 1; dz++) {
    const cz = zi + dz;
    const ez = Math.abs(cz + 0.5 - z);
    const lpz = Math.max(0, ez - SPIRE_SITE_REACH);
    const lsz = Math.max(0, ez - SPIRE_SAT_REACH);
    const lpz2 = lpz * lpz, lsz2 = lsz * lsz;
    if (lpz2 >= SPIRE_FOOT_OUT2 && lsz2 >= SPIRE_SAT_FOOT_OUT2) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx;
      const ex = Math.abs(cx + 0.5 - x);
      const lpx = Math.max(0, ex - SPIRE_SITE_REACH);
      const lsx = Math.max(0, ex - SPIRE_SAT_REACH);
      if (lpx * lpx + lpz2 >= SPIRE_FOOT_OUT2 && lsx * lsx + lsz2 >= SPIRE_SAT_FOOT_OUT2) continue;

      const h = hash3i(cx, cz, seed);
      const px = cx + 0.5 + (((h & 0xffff) / 65535) - 0.5) * SPIRE_JITTER;
      const pz = cz + 0.5 + ((((h >>> 16) & 0xffff) / 65535) - 0.5) * SPIRE_JITTER;
      const qx = px - x, qz = pz - z;
      const p2 = qx * qx + qz * qz;
      if (p2 < primary2) primary2 = p2;

      const dir = SPIRE_DIRECTIONS[(h >>> 29) & 7];
      // Unequal, non-mirrored offsets stop the group reading as a trident. The
      // companions overlap the dominant tower only at their rubble feet.
      const ax = qx + dir[0] * SPIRE_ARM_MAIN;
      const az = qz + dir[1] * SPIRE_ARM_MAIN;
      const bx = qx - dir[1] * 0.215 - dir[0] * 0.045;
      const bz = qz + dir[0] * 0.215 - dir[1] * 0.045;
      const a2 = ax * ax + az * az;
      const b2 = bx * bx + bz * bz;
      if (a2 < satellite2) satellite2 = a2;
      if (b2 < satellite2) satellite2 = b2;
    }
  }
  _spireDistances.primary = Math.sqrt(primary2);
  _spireDistances.satellite = Math.sqrt(satellite2);
  return _spireDistances;
}

/**
 * H(x, z). `full` selects the complete stack; the fast path drops the layers
 * whose amplitude is below the collision tolerance (dunes, talus, micro) and
 * keeps everything a body can actually stand on or crash into.
 */
function heightAt(x, z, full) {
  const dxC = x - CRATER_X;
  const dzC = z - CRATER_Z;
  const r0 = Math.sqrt(dxC * dxC + dzC * dzC);

  // ---- LAYER 1: macro domain warp -------------------------------------
  // Amplitude ramps in outside the crater so the lagoon stays exactly circular
  // and exactly where WORLD.SAFE_CRATER_CENTER promises it is.
  const warpGain = smoothstep(WARP_ONSET_IN, WARP_ONSET_OUT, r0);
  let wx = x, wz = z;
  if (warpGain > 0.002) {
    domainWarp2(_warp, x * WARP_FREQ, z * WARP_FREQ, S.WARP, WARP_AMP * WARP_FREQ * warpGain, 1, 1);
    wx = _warp[0] / WARP_FREQ;
    wz = _warp[1] / WARP_FREQ;
  }

  // ---- LAYER 0: continental radial profile -----------------------------
  const dxW = wx - CRATER_X;
  const dzW = wz - CRATER_Z;
  const rw = Math.sqrt(dxW * dxW + dzW * dzW);
  let p = evalProfile(OCEAN_PROFILE, rw);
  let h = p.y;
  // Radial slope, in metres per metre. Free, exact, and the input to every
  // slope-driven mask below - no finite difference of the stack is ever needed.
  let slopeR = Math.abs(p.dy);

  // ---- LAYER 2: the island --------------------------------------------
  const dxI = wx - ISLAND_X;
  const dzI = wz - ISLAND_Z;
  let rIsle = Math.sqrt(dxI * dxI + dzI * dzI);
  let islandMask = 0;
  if (rIsle < 900) {
    // Radial jitter breaks the circular coastline. Evaluated on the world
    // plane, not on the azimuth, so it costs no trigonometry and cannot pinch
    // at the centre. Clamped at 0 so the profile is never extrapolated past its
    // first control point, which would put the summit above the world ceiling.
    rIsle = Math.max(0, rIsle - ISLAND_JITTER_AMP * fbm2(simplex2, x * 0.0042, z * 0.0042, S.ISLAND_JITTER, 2));
    p = evalProfile(ISLAND_PROFILE, rIsle);
    const hIsland = p.y;
    // The island's mask is how much the island actually WON the smax, not how
    // close the sample is to its centre. The two differ by 500 m of lagoon: the
    // island profile is still defined out there, far below the seabed, and
    // masking on radius alone would drape the volcano's ravines across the
    // start lagoon floor.
    islandMask = (1 - smoothstep(620, 860, rIsle)) * smoothstep(-8, 8, hIsland - h);
    h = smax(h, hIsland, ISLAND_BLEND_K);
    slopeR = Math.max(slopeR, Math.abs(p.dy) * islandMask);
  }

  // ---- masks -----------------------------------------------------------
  // Everything below is driven by (depth so far, radial slope, radius), all of
  // which are already in hand.
  const depth = -h;
  const craterCalm = 1 - smoothstep(300, CRATER_GUARD_OUT, r0);
  const outside = 1 - craterCalm;
  const slopeMask = smoothstep(0.30, 0.68, slopeR);
  const flatMask = 1 - smoothstep(0.09, 0.24, slopeR);

  // ---- LAYER 3: broad relief -------------------------------------------
  if (outside > LAYER_EPSILON / 30) {
    const amp = 30 * outside * (0.35 + 0.65 * smoothstep(200, 1400, r0));
    h += amp * fbm2(simplex2, x / 760, z / 760, S.BROAD, 4);
  }

  // ---- LAYER 4: ridged spurs -------------------------------------------
  if (slopeMask * outside > LAYER_EPSILON / 54) {
    const n = ridged2(x / 560, z / 560, S.RIDGE, 3, 2.07, 0.5);
    h += 54 * (n - 0.32) * slopeMask * outside;
  }

  // ---- LAYER 5: rock spires --------------------------------------------
  // A heightfield cannot make an overhang, but it can make a strong vertical
  // landmark. These are authored as three nested profiles rather than as an
  // octave: a broad rubble foot, a near-vertical shaft, and a narrow irregular
  // crown. The broad patch field groups several towers into recognisable
  // skylines and leaves equally large stretches of shelf open, so "spires" is
  // a destination instead of the texture of an entire depth band.
  //
  // All masks are taken from the terrain BEFORE the towers are raised. That is
  // load-bearing: masking on the resulting depth would make the top erase its
  // own base, and iterative collision samples would no longer describe one
  // mathematical surface.
  //
  // THE SITE MASK DIVIDES THE PROFILE'S RADIUS AS WELL AS SCALING ITS HEIGHT,
  // AND THAT DIVISION IS THE WHOLE SHAPE OF THIS LAYER. Multiplying the height
  // alone leaves the footprint at full width, so a half-strength site is a
  // half-height tower of full girth and the delivered aspect ratio is
  // proportional to the mask. Measured on the shipped profile: intrinsic aspect
  // 2.657 at mask 1 (prominence 178 m, width at half prominence 67.0 m), 1.59
  // at mask 0.6, 0.93 at mask 0.35 - and a census of the real seabed read p50
  // 1.63 with a maximum of 2.22, which are exactly the mask-0.6 and mask-0.84
  // values. The field was not short of towers, it was short of tall ones.
  // Dividing f by m makes the profile SELF-SIMILAR, so aspect is 5.275 at every
  // mask and a weak site is a small spire instead of a mound.
  //
  // THE BAND'S SUPPORT IS TESTED BEFORE THE BAND IS BUILT. spireBand's four
  // smoothsteps were the only terms in the whole stack that every sample in the
  // world paid for and that most samples can never use: measured, 40.2% of a
  // 300,000-sample world scatter and 28.6% of the 123,823 samples in
  // test-terrain's seven timing chunks are inside the band, and its "shelf
  // break" chunk (r 1055-1214 m) contains exactly ZERO yet was evaluating all
  // four for all 17,689 of its samples. Each edge is an exact saturate() clamp,
  // so the guard admits precisely the samples that could return non-zero.
  if (rw > SPIRE_BAND_R_IN && rw < SPIRE_BAND_R_OUT
      && depth > SPIRE_BAND_D_IN && depth < SPIRE_BAND_D_OUT) {
    // The four outer edges are the SAME constants the guard tests, not copies of
    // them: a literal here that drifted from the guard would silently clip the
    // band's feather off at a step.
    const spireBand = smoothstep(SPIRE_BAND_R_IN, 1920, rw) * (1 - smoothstep(2640, SPIRE_BAND_R_OUT, rw))
                    * smoothstep(SPIRE_BAND_D_IN, 205, depth) * (1 - smoothstep(670, SPIRE_BAND_D_OUT, depth));
    if (spireBand > LAYER_EPSILON / 178) {
      const patchNoise = simplex2(x / 1040, z / 1040, S.SPIRE_PATCH);
      const patchMask = smoothstep(-0.18, 0.34, patchNoise);
      const siteMask = patchMask * spireBand;
      if (siteMask > LAYER_EPSILON / 178) {
        // f1 is distance to a jittered cellular site in 280 m cells. Every part
        // of the profile reaches zero before the usual Voronoi boundary, keeping
        // neighbouring towers separated by navigable negative space.
        const cluster = spireClusterDistances(x / 280, z / 280, S.SPIRE);
        const f1 = cluster.primary;
        const fs = cluster.satellite;
        // The gate tests against siteMask rather than the full mask so that
        // `stature` stays INSIDE the accepted branch. stature is at most 1.0, so
        // siteMask bounds the true mask from above and this admits a superset of
        // the samples that can produce a non-zero profile - identical geometry,
        // without paying for a simplex octave on the ~2/3 of band samples that
        // are rejected here. It is also strictly tighter than the old constant
        // gate, which is why this pass makes the layer cheaper rather than
        // dearer: the accepted disc shrinks from radius 0.32 to 0.190 * siteMask.
        if (f1 < SPIRE_FOOT_OUT * siteMask || fs < SPIRE_SAT_FOOT_OUT * siteMask) {
          // Local broad noise varies tower height without changing its profile.
          // The factor is positive and bounded, so every accepted site remains
          // a tower rather than occasionally turning into a crater.
          const stature = 0.82 + 0.18 * (simplex2(x / 430, z / 430, S.SPIRE) * 0.5 + 0.5);
          const m = siteMask * stature;
          const inv = 1 / m;
          const u = f1 * inv;
          const v = fs * inv;
          // EACH HALF OF THE CLUSTER IS BUILT ONLY WHERE IT IS NON-ZERO, and the
          // gate above admits a sample when EITHER half opens, so the other half
          // is usually dead weight. Both tests are exact rather than
          // conservative: past its outer radius every one of the three
          // smoothsteps is saturated at 1, so the profile is 0 to the bit and
          // Math.max degenerates to the surviving half. Measured over 105,290
          // accepted annulus samples, 80.7% build one half instead of two.
          let tower = 0;
          if (u < SPIRE_FOOT_OUT) {
            // Crown-weighted against the old 28/105/45: the shaft still carries
            // the silhouette but the apron drops 28 -> 18 m so it stops reading
            // as a hill with a bump on it, and the crown rises 45 -> 60 m so the
            // top stays narrow for the last third of the climb.
            const foot = 1 - smoothstep(0.078, SPIRE_FOOT_OUT, u);
            const shaft = 1 - smoothstep(0.030, 0.115, u);
            const crown = 1 - smoothstep(0.0, 0.038, u);
            tower = 18 * foot + 100 * shaft + 60 * crown;
          }
          if (v < SPIRE_SAT_FOOT_OUT) {
            const satelliteFoot = 1 - smoothstep(0.050, SPIRE_SAT_FOOT_OUT, v);
            const satelliteShaft = 1 - smoothstep(0.020, 0.075, v);
            const satelliteCrown = 1 - smoothstep(0.0, 0.026, v);
            const satellite = 12 * satelliteFoot + 64 * satelliteShaft + 40 * satelliteCrown;
            if (satellite > tower) tower = satellite;
          }
          h += tower * m;
        }
      }
    }
  }

  // ---- LAYER 6: mid detail ---------------------------------------------
  if (outside > LAYER_EPSILON / 4.5) {
    // Slope-damped: fluvial and mass-wasting processes plane off steep faces
    // and pile the debris in the hollows, so the busy band belongs on the
    // gentle ground, not on the cliffs.
    const damp = 1 / (1 + slopeR * slopeR * 1.6);
    h += 4.5 * outside * damp * fbm2(value2, x / 44, z / 44, S.MID, 4);
  }

  // ---- LAYER 7: island relief ------------------------------------------
  if (islandMask > LAYER_EPSILON / 39) {
    // Rolled off near the shore so the beach cannot grow a cliff, and inside
    // r = 60 m so the summit reaches exactly MAX_TERRAIN_HEIGHT instead of
    // overshooting into the world clamp and going flat on top.
    const k = islandMask * smoothstep(0, 26, Math.abs(h)) * smoothstep(0, 60, rIsle);
    h += 32 * (ridged2(x / 170, z / 170, S.ISLAND_R, 3, 2.05, 0.5) - 0.30) * k;
    h += 6.5 * fbm2(value2, x / 60, z / 60, S.ISLAND_E, 4) * k;
  }

  // ---- LAYER 8: canyon --------------------------------------------------
  if (corridorQuery(_canyon, x, z)) {
    const u = saturate(_corr.d / _corr.w);
    const profile = 1 - smoothstep(0, 1, u);
    const floorFlat = smoothstep(0.34, 0, u);
    h -= _corr.v * (0.78 * profile + 0.22 * floorFlat);
  }

  // ---- LAYER 9: trench --------------------------------------------------
  if (corridorQuery(_trench, x, z)) {
    const trenchWidth = evalProfile(TRENCH_WIDTH_PROFILE, r0).y;
    const floorY = evalProfile(TRENCH_FLOOR_PROFILE, r0).y;
    const u = saturate(_corr.d / trenchWidth);
    // Quintic wall: near-vertical through the middle of the band, with a talus
    // toe at the floor and a rounded lip at the rim.
    const s = u * u * u * (u * (u * 6 - 15) + 10);
    // Terraces cut into the wall - the bedding planes that make a 500 m drop
    // readable as a drop rather than as a wall of fog. They are in the FAST
    // path too: at 26 m they are the largest thing a vessel can hit down there,
    // and a collision proxy that omitted them would let it fly through ledges.
    const band = smoothstep(0.10, 0.26, u) * (1 - smoothstep(0.84, 0.99, u));
    const wall = floorY + (h - floorY) * s
               - 26 * ridged2(x / 160, z / 160, S.TERRACE, 3, 2.0, 0.5) * band;
    if (wall < h) h = wall;
  }

  // ---- LAYER 9.5: the kelp basin ---------------------------------------
  // The Kelp Forest's sunken home (2026-08-18 emerald rebuild): an annular
  // wedge of the shelf, x < 0 / z > 0, r 1150-1850, dropped to DOUBLE its
  // depth so the biome's 84-124 m plants have the water they need, with
  // CLIFF walls at the rim by explicit user instruction ("terrain can just
  // be a cliff... doesn't need to be smooth gradual descent"): the carve is
  // depth-proportional (h * (1 + mask)), so a 60 m shelf falls 60 m across
  // the ~70 m rim feather - a wall, wobbled organic by one low-frequency
  // noise sample so the cliff line is not a compass arc.
  //
  // ORDERING IS LOAD-BEARING: after the corridors (whose carves are
  // absolute and disjoint from this wedge) and BEFORE every layer that
  // reads `d2 = -h` (bommies, dunes), so depth-gated detail sees the
  // carved floor. The sign tests are the fast path: three of four world
  // quadrants exit on the first line and never pay the atan2 or the noise.
  // rOut 1480 with wobble +/-40 tops out at 1520, STRICTLY below Platter
  // Forest's r >= 1540 record floor: an earlier 1850 rim manufactured
  // 88-110 m flats at r >= 1540 inside the wedge and Platter's record
  // claimed 42 of the fixture's 625 cells - the basin must not be able to
  // mint another biome's ground.
  if (x < 0 && z > 0) {
    const rb2 = x * x + z * z;
    if (rb2 > 1010 * 1010 && rb2 < 1620 * 1620) {
      const rb = Math.sqrt(rb2);
      const wob = simplex2(x * 0.0035, z * 0.0035, S.KELP_BASIN);
      const rIn = 1150 + wob * 40, rOut = 1480 + wob * 40;
      const mR = smoothstep(rIn - 28, rIn + 28, rb) * (1 - smoothstep(rOut - 28, rOut + 28, rb));
      if (mR > LAYER_EPSILON) {
        // Angular band with a fixed ~64 m ARC feather (60/r radians), so the
        // inner and outer cliff corners are equally sharp.
        const ab = Math.atan2(x, z) + wob * 0.035;
        const aF = 60 / rb;
        const mA = smoothstep(-0.75, -0.75 + aF, ab) * (1 - smoothstep(-0.10 - aF, -0.10, ab));
        let m = mR * mA;
        if (m > LAYER_EPSILON) {
          // The Pelagos Habitat (authored at the basin's outer rim, r 1485,
          // seabedY baked at -43.98) must keep its original shelf: the carve
          // fades to zero within 140 m of the station and the cliff starts
          // beyond 210, leaving it on a promontory overlooking the basin.
          const hdx = x - HABITAT_SITE.x, hdz = z - HABITAT_SITE.z;
          m *= smoothstep(140, 210, Math.sqrt(hdx * hdx + hdz * hdz));
          if (m > LAYER_EPSILON && h < 0) h *= 1 + m;
        }
      }
    }
  }

  // ---- LAYER 9.6: the Splitmaw Shoal ---------------------------------------
  // The Sunken Dunes' manufactured ground (2026-08-19, biome 18): an annular
  // wedge of the SSW abyssal ramp, x < 0 / z > 0, r 2430-2940, bearing
  // -46..-14 deg, RAISED to a rolling dune plateau at 318-342 m - the
  // manufactured-ground method the kelp basin established, inverted. The
  // natural seabed here is 469-865 m down (measured over 5,934 wedge samples
  // at the default seed) and belongs to no record's full-fit, so the mesa
  // mints ground only the Sunken Dunes record can claim.
  //
  // FORM IS MIX-TO-TARGET, RAISE-ONLY. `h += (hT - h) * m` pulls the ramp up
  // to an authored dune field; the `hT > h` guard means the layer can never
  // deepen anything, so the kelp carve's minting worry runs one way only:
  // the plateau tops out at -317.6 (dunes + ripples + micro), inside the
  // record's [312, 348] band, and no flat ground shallower than 312 is ever
  // created (Terraces' 292 ceiling stays 20 m clear).
  //
  // THE EDGE PROFILE IS SIZED AGAINST ROCK SPIRES' RECORD, NOT AGAINST
  // TASTE, and asymmetrically. Any manufactured slope in 0.85-4.3 at depth
  // 40-800 inside r 600-3000 is spires-first ground by the catalogue's own
  // tie rules, and the first two shapes of this layer proved it: the spires
  // anchor migrated 850 m onto the rim (once onto the outer wall at the
  // 60/110 m feathers' slope-2-4 profile, once onto the inner wall whose
  // 60-140 m drop cannot exceed 4.3 across any plausible feather), landing
  // 337 m from the Hollowjaw warden site with no spireCrown inside 100 m.
  // So: the OUTER wall and the two ANGULAR walls, where the drop is
  // 200-500 m, are QUADRUPLE-sharpened over tight feathers - near-vertical,
  // past the spires band, leaving only metres-wide lip/toe ribbons - and
  // the INNER edge, whose drop to the natural 390-470 m ground is too small
  // to wall, is instead a LONG GLACIS at slope <= ~0.5, UNDER the spires
  // band's 0.55 feather onset: it reads as the shoal's sand skirt draining
  // into the Ossuary approach, and it classifies ossuary/abyssal, never
  // spires. The toe of the outer walls meets natural ground at 700-865 m,
  // past spires' 800 m depth rejection, so the walls themselves classify
  // Canyon Wall / Trench Wall - dark rims around a sunlit shoal.
  //
  // The dune ridges are anisotropic in a FIXED rotated frame (-22.5 deg),
  // not a spatially varying one - LAYER 11's domain-warp comment records why
  // a position-dependent rotation angle amplifies gradients by |p|*da/dx;
  // a constant angle has no such term. Ridges run roughly across the radial
  // approach so an arriving diver crosses them broadside.
  if (x < 0 && z > 0) {
    const rs2 = x * x + z * z;
    if (rs2 > 2100 * 2100 && rs2 < 3040 * 3040) {
      const rs = Math.sqrt(rs2);
      const wob = simplex2(x * 0.0021, z * 0.0021, S.SPLITMAW_SHOAL);
      const rIn = 2470 + wob * 40, rOut = 2940 + wob * 40;
      // Inner glacis: a 300 m linear-in-r apron from full plateau at rIn
      // down to zero influence at rIn - 300, so the manufactured surface
      // descends at <= ~0.5 including the target's own fall (below).
      const mGlacis = smoothstep(rIn - 300, rIn, rs);
      // Outer wall: tight feather, sharpened to near-vertical further down.
      const mWall = 1 - smoothstep(rOut - 26, rOut + 26, rs);
      if (mGlacis > LAYER_EPSILON && mWall > LAYER_EPSILON) {
        const ab = Math.atan2(x, z) + wob * 0.03;
        // Angular feather: tight (52 m arc) where the wedge is a wall, wide
        // (240 m arc) on the glacis so the apron's SIDES also stay under
        // the spires slope onset; blended in r so the mask stays C1.
        const aFm = lerp(240, 52, smoothstep(rIn - 260, rIn + 40, rs));
        const aF = aFm / rs;
        const mA = smoothstep(-0.8029, -0.8029 + aF, ab) * (1 - smoothstep(-0.2443 - aF, -0.2443, ab));
        // Sharpen ONLY the wall-and-side component: two more smoothstep
        // applications on top of the base pair steepen the outer/angular
        // drops to slope ~5-13 while the glacis keeps its linear ramp.
        let mW = mWall * mA;
        mW = mW * mW * (3 - 2 * mW);
        mW = mW * mW * (3 - 2 * mW);
        const m = mGlacis * mW;
        if (m > LAYER_EPSILON) {
          const ca = 0.9238795, sa = -0.3826834;
          const du = x * ca + z * sa, dv = -x * sa + z * ca;
          // Amplitudes sized against the record's slope band: 8 m over a
          // 210 m cross-ridge wavelength plus 0.9 m ripples at 34 m keep the
          // exact-slope field under ~0.45 on the crests (measured 55.8%
          // under 0.42 at amp 10/lambda 130 with 1.8 m ripples at 21 m -
          // canyon's record was winning the flanks of every dune).
          // Base -348, NOT -330: at -330 the +/-11% classification jitter
          // reached up into Twilight Terraces' [.., 292] band and down into
          // Abyssal Plain's feather, and the resulting minority pockets
          // (9.8% terrace + 4.6% abyssal inside the arena) carried their
          // OWN scatter kits - the round-1 adversarial review flagged green
          // glowing mushroom caps and terrace pancake slabs as the most
          // salient objects in an azure/crimson/bone biome. At -348 the
          // whole jittered depth range [302, 396] fits inside the record's
          // [300, 398] band, which overlaps no other record's full-fit, so
          // the pockets are gone by construction rather than by tuning.
          let hT = -348 + 8 * (billow2(du / 480, dv / 210, S.SPLITMAW_DUNE, 2, 2.3, 0.5) * 2 - 1);
          // The glacis' own fall: the target sinks toward the natural
          // ground inboard of rIn at 0.30 m/m, so the apron's delivered
          // slope is the mask ramp and this term together, still under the
          // 0.55 onset (the dunes fade with the same ramp).
          if (rs < rIn) hT -= (rIn - rs) * 0.30;
          if (full) hT += 1.3 * (billow2(du / 90, dv / 40, S.SPLITMAW_RIPPLE, 2, 2.2, 0.45) * 2 - 1);
          if (hT > h) h += (hT - h) * m;
        }
      }
    }
  }

  // ---- LAYER 10: reef bommies ------------------------------------------
  const d2 = -h;
  // Damped inside the lagoon: coral heads breaking the surface in the start
  // zone would be a hazard the player cannot see from a boat.
  const reefMask = smoothstep(2, 7, d2) * (1 - smoothstep(30, 62, d2)) * flatMask * (0.6 + 0.4 * outside);
  if (reefMask > LAYER_EPSILON / 5.5) {
    const f1 = worley2(x / 26, z / 26, S.BOMMIE, 0.92).f1;
    const mound = saturate(1 - f1 / 0.62);
    h += 5.5 * mound * mound * Math.sqrt(mound) * reefMask;
  }

  if (full) {
    // ---- LAYER 11: dunes ------------------------------------------------
    const sedMask = flatMask * smoothstep(26, 70, d2) * (1 - smoothstep(900, 1300, d2));
    if (sedMask > LAYER_EPSILON / 1.9) {
      // Anisotropy 3.4:1, made to curve like a real bedform by DOMAIN WARPING
      // the sample point - NOT by rotating the coordinate frame through an
      // angle a(x, z). That rotation is the seductive way to write this and it
      // is wrong: d/dx of (x cos a + z sin a) contains |p| * da/dx, so the
      // gradient is amplified by the sample's DISTANCE FROM THE ORIGIN. At
      // r = 4 km with a 900 m direction field that factor is ~80, which
      // collapses the 48 m ripple into sub-metre hash the 1 m LOD-0 grid
      // cannot sample - measured mean slope 2.93 (71 deg) on a plain whose
      // ripples are 1.9 m tall. A warp's gradient is bounded by
      // strength * |grad noise| wherever the sample happens to be.
      domainWarp2(_warp, x, z, S.DUNE_DIR, 34, 1 / 900, 2);
      const ux = _warp[0] / 48;
      const uz = _warp[1] / 48 * 3.4;
      h += 1.9 * (billow2(ux, uz, S.DUNE, 3, 2.3, 0.42) * 2 - 1) * sedMask;
    }
    // ---- LAYER 12: talus ------------------------------------------------
    if (slopeMask > LAYER_EPSILON / 1.4) {
      h -= 1.4 * (1 - saturate(worley2Edge(x / 8.5, z / 8.5, S.TALUS) * 3.4)) * slopeMask;
    }
  }

  // ---- LAYER 13: shore flattening --------------------------------------
  if (islandMask > LAYER_EPSILON / 4.4 && h > -9 && h < 9) {
    // Pull the profile toward a 0.34x compressed version of itself through the
    // waterline. Result: a 2.6 to 6.3 deg strand about 26 m wide with no noise
    // spikes for the player to get stuck on.
    let t = 1 - saturate(Math.abs(h) / 9);
    t = t * t * (3 - 2 * t);
    h += (h * 0.34 - h) * 0.72 * t * islandMask;
  }

  // ---- LAYER 14: micro relief ------------------------------------------
  if (full) {
    h += 0.55 * fbm2(value2, x / 9, z / 9, S.MICRO, 3);
  }

  // ---- LAYER 15: crater guard ------------------------------------------
  // The lagoon is a promise, not an emergent property. Inside the promised disc
  // the height is folded into [-18.5, -3.4] with C1 smooth-min/max so no slope
  // discontinuity appears where the guard engages; in practice the natural
  // profile already sits inside the envelope and the guard is inert.
  const guard = 1 - smoothstep(CRATER_R, CRATER_GUARD_OUT, r0);
  if (guard > 0) {
    const held = smin(smax(h, CRATER_FLOOR_Y, 1.5), CRATER_CEIL_Y, 1.5);
    h = lerp(h, held, guard);
  }

  // ---- LAYER 16: world clamp -------------------------------------------
  return h < MIN_H ? MIN_H : h > MAX_H ? MAX_H : h;
}

/** Authoritative terrain height in metres at a world XZ position. */
export function sampleHeight(x, z) { return heightAt(x, z, true); }

/**
 * Cheaper height for AI, audio and collision broad-phase. Drops the dune,
 * talus and micro layers - everything under ~2 m of amplitude - and is about
 * 1.5x faster. Measured maximum deviation from sampleHeight is under 3 m,
 * which is inside the collision skin.
 */
export function sampleHeightFast(x, z) { return heightAt(x, z, false); }

/**
 * Unit surface normal at a world XZ position, written into `out` (length 3).
 * The 0.6 m epsilon is half the LOD-0 sample pitch: small enough to resolve
 * bommies, large enough that the micro layer does not turn the normal to hash.
 */
export function sampleNormal(out, x, z, eps = 0.6) {
  const hL = heightAt(x - eps, z, true);
  const hR = heightAt(x + eps, z, true);
  const hD = heightAt(x, z - eps, true);
  const hU = heightAt(x, z + eps, true);
  const nx = hL - hR;
  const nz = hD - hU;
  const ny = 2 * eps;
  const inv = 1 / Math.hypot(nx, ny, nz);
  out[0] = nx * inv;
  out[1] = ny * inv;
  out[2] = nz * inv;
  return out;
}

/**
 * Gradient magnitude (metres per metre, i.e. the tangent of the slope angle).
 *
 * The 2 m default is not arbitrary: it is the same 4 m span bakeChunk measures
 * the BIOME CLASSIFIER's slope over, on the same full heightfield, so a CPU
 * consumer that classifies a position with this gets the biome the mesh was
 * actually baked with. Measuring at the LOD sample pitch instead would let the
 * spawner and the renderer disagree about what the ground is made of.
 */
export function sampleSlope(x, z, eps = 2.0) {
  const gx = (heightAt(x + eps, z, true) - heightAt(x - eps, z, true)) / (2 * eps);
  const gz = (heightAt(x, z + eps, true) - heightAt(x, z - eps, true)) / (2 * eps);
  return Math.hypot(gx, gz);
}

/** Radius either side of the analytic estimate that the shoreline search
 *  covers, and its march step. 220 m bounds the 158 m worst case the broad
 *  relief layer can move the waterline by; 11 m is under half the narrowest
 *  strand, so a crossing cannot be stepped over. */
const SHORE_SEARCH = 220;
const SHORE_STEP = 11;
const SHORE_BISECTIONS = 16;

/**
 * Signed horizontal distance to the island shoreline, metres. NEGATIVE inland,
 * positive at sea.
 *
 * This IS a root-find along the ray from the island centre, and it has to be.
 * The analytic shoreline - the radius at which the ISLAND PROFILE alone crosses
 * y = 0 - is wrong by a measured mean of 53 m and a worst case of 158 m,
 * because the 30 m broad-relief and 4.5 m mid-detail layers sit on top of the
 * profile and a 7-degree strand converts every metre of them into eight metres
 * of radius. The profile is only the bracket.
 *
 * The search runs on sampleHeightFast, so the answer follows everything down to
 * the mid-detail band and deliberately ignores the sub-metre micro layer, whose
 * +/-0.55 m at a 9 m wavelength would otherwise make the waterline a ragged
 * band several metres wide and the result jitter under a walking player.
 *
 * Cost is up to 40 marches plus 16 bisections of sampleHeightFast, about 45 us.
 * That is a query for surf audio, foam, beach scatter and amphibious spawning -
 * a handful of calls a frame - NOT something to put in a per-vertex loop.
 */
export function distanceToShore(x, z) {
  const dxC = x - CRATER_X;
  const dzC = z - CRATER_Z;
  const r0 = Math.sqrt(dxC * dxC + dzC * dzC);
  const warpGain = smoothstep(WARP_ONSET_IN, WARP_ONSET_OUT, r0);
  let wx = x, wz = z;
  if (warpGain > 0.002) {
    // Octave count must match heightAt's warp exactly; one octave here and two
    // there puts the two functions on different islands.
    domainWarp2(_warp, x * WARP_FREQ, z * WARP_FREQ, S.WARP, WARP_AMP * WARP_FREQ * warpGain, 1, 1);
    wx = _warp[0] / WARP_FREQ;
    wz = _warp[1] / WARP_FREQ;
  }
  const dxI = wx - ISLAND_X;
  const dzI = wz - ISLAND_Z;
  const rIsle = Math.sqrt(dxI * dxI + dzI * dzI)
              - ISLAND_JITTER_AMP * fbm2(simplex2, x * 0.0042, z * 0.0042, S.ISLAND_JITTER, 2);
  const analytic = rIsle - ISLAND_SHORE_R;

  // Ray from the island centre through the sample, in UNWARPED world space -
  // the space the answer is quoted in.
  const rx = x - ISLAND_X;
  const rz = z - ISLAND_Z;
  const rw = Math.sqrt(rx * rx + rz * rz);
  // Dead on the summit there is no ray. The whole island is inland from here.
  if (rw < 1e-6) return -ISLAND_SHORE_R;
  // Far from the island the profile is metres below the seabed, no crossing
  // exists, and nothing that consumes this needs better than the estimate.
  if (analytic > SHORE_SEARCH || analytic < -SHORE_SEARCH) return analytic;

  const ux = rx / rw, uz = rz / rw;
  const tGuess = rw - analytic;
  const tLo = Math.max(1, tGuess - SHORE_SEARCH);
  const tHi = tGuess + SHORE_SEARCH;

  // March outward and keep the sign change whose midpoint is nearest the
  // sample: the shoreline it is standing on, not the far side of the island.
  let a = tLo;
  let ha = heightAt(ISLAND_X + ux * a, ISLAND_Z + uz * a, false);
  let bestA = 0, bestB = 0, bestD = Infinity;
  for (let t = tLo + SHORE_STEP; t <= tHi; t += SHORE_STEP) {
    const hb = heightAt(ISLAND_X + ux * t, ISLAND_Z + uz * t, false);
    if ((ha > 0) !== (hb > 0)) {
      const d = Math.abs((a + t) * 0.5 - rw);
      if (d < bestD) { bestD = d; bestA = a; bestB = t; }
    }
    a = t; ha = hb;
  }
  if (bestD === Infinity) return analytic;

  // Bisect. 220 m of window over 16 halvings resolves the crossing to 0.2 mm,
  // far below the metre the consumers care about.
  let lo = bestA, hi = bestB;
  let hLo = heightAt(ISLAND_X + ux * lo, ISLAND_Z + uz * lo, false);
  for (let i = 0; i < SHORE_BISECTIONS; i++) {
    const mid = (lo + hi) * 0.5;
    const hm = heightAt(ISLAND_X + ux * mid, ISLAND_Z + uz * mid, false);
    if ((hLo > 0) === (hm > 0)) { lo = mid; hLo = hm; } else { hi = mid; }
  }
  return rw - (lo + hi) * 0.5;
}

// ===========================================================================
// Chunk baking
// ===========================================================================

const CHUNK_SIZE = WORLD.CHUNK_SIZE;                 // 128 m
const BASE_QUADS = WORLD.CHUNK_RESOLUTION - 1;       // 128 quads at LOD 0
/** One vertex ring outside the chunk on every side, so edge normals and the
 *  concavity AO match the neighbour's exactly and seams are invisible. */
const APRON = 2;

/** Vertices per edge at a given LOD. LOD n halves the sample rate. */
export function lodResolution(lod) {
  return Math.max(2, BASE_QUADS >> lod) + 1;
}

/** Metres between samples at a given LOD. */
export function lodStep(lod) {
  return CHUNK_SIZE / Math.max(2, BASE_QUADS >> lod);
}

/** Bytes per vertex in the interleaved layout the renderer consumes. */
export const VERTEX_STRIDE = 40;

/**
 * Bake one chunk into typed arrays.
 *
 * Positions are CHUNK-LOCAL in X and Z (0 .. CHUNK_SIZE) and ABSOLUTE in Y.
 * Keeping XZ local is what preserves float32 precision 3 km from the origin:
 * the draw supplies the chunk origin, and the vertex shader adds it after
 * subtracting the camera-relative world origin, so the large numbers never meet
 * float32.
 *
 * SKIRTS, not stitching. A chunk is a pure function of (cx, cz, lod) and
 * nothing else - that is what lets it be baked out of order, in a worker, and
 * cached. Index-time stitching to a coarser neighbour would make the mesh a
 * function of the neighbourhood too, forcing a rebake every time a neighbour
 * changed ring, exactly when the streaming budget is already under load. The
 * skirt is a vertical rim hung from the chunk boundary, deep enough to cover
 * the worst-case gap a one-level-coarser neighbour can open. It is shaded with
 * the edge vertex's own normal, so on the rare pixel where it is visible it
 * reads as the same rock rather than as a black band.
 *
 * @param {number} cx chunk index along X (world x = cx * CHUNK_SIZE)
 * @param {number} cz chunk index along Z
 * @param {number} lod 0 = full resolution
 */
export function bakeChunk(cx, cz, lod) {
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();

  const res = lodResolution(lod);
  const step = lodStep(lod);
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;

  // --- height field with apron -----------------------------------------
  const gres = res + APRON * 2;
  const grid = new Float64Array(gres * gres);
  for (let j = 0; j < gres; j++) {
    const wz = oz + (j - APRON) * step;
    for (let i = 0; i < gres; i++) {
      grid[j * gres + i] = heightAt(ox + (i - APRON) * step, wz, true);
    }
  }
  const gh = (i, j) => grid[(j + APRON) * gres + (i + APRON)];

  // --- surface vertices -------------------------------------------------
  const surfaceCount = res * res;
  const perimeter = 4 * (res - 1);
  const vertexCount = surfaceCount + perimeter;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const material = new Uint8Array(vertexCount * 4);
  const surface = new Uint8Array(vertexCount * 4);

  const invRes = 1 / (res - 1);
  const inv2Step = 1 / (2 * step);
  let minY = Infinity, maxY = -Infinity;

  // The biome classifier votes on slope, so if it is handed the LOD's own
  // sample pitch the same ground classifies differently in every ring and the
  // substrate changes the instant a chunk swaps LOD - measured at up to 250/255
  // of rockiness on the abyssal plain, i.e. sand turning to bare rock. It gets a
  // gradient measured over a FIXED span in metres instead. Two apron rings give
  // 4 m at LOD 0 and LOD 1 alike, which is the transition the player stands
  // closest to, and every sample it needs is already in the grid.
  const matK = Math.max(1, Math.min(APRON, Math.round(2 / step)));
  const invMatSpan = 1 / (2 * matK * step);

  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const v = j * res + i;
      const h = gh(i, j);
      const wx = ox + i * step;
      const wz = oz + j * step;

      // Central differences on the apron grid. Because the apron is sampled
      // from the same H(), a vertex on a chunk edge produces bit-identical
      // normals in both chunks.
      const gx = (gh(i - 1, j) - gh(i + 1, j)) * inv2Step;
      const gz = (gh(i, j - 1) - gh(i, j + 1)) * inv2Step;
      const inv = 1 / Math.sqrt(gx * gx + gz * gz + 1);
      const nx = gx * inv, ny = inv, nz = gz * inv;

      positions[v * 3] = i * step;
      positions[v * 3 + 1] = h;
      positions[v * 3 + 2] = j * step;
      // Read the height back out of the f32 store rather than tracking the f64
      // `h`: the bounds have to contain the vertices the GPU will actually see,
      // and rounding to f32 can push one 1 ulp past an f64 extremum.
      const hq = positions[v * 3 + 1];
      normals[v * 3] = nx;
      normals[v * 3 + 1] = ny;
      normals[v * 3 + 2] = nz;
      uvs[v * 2] = i * invRes;
      uvs[v * 2 + 1] = j * invRes;

      if (hq < minY) minY = hq;
      if (hq > maxY) maxY = hq;

      // Concavity ambient occlusion at two radii. A pit sits below the mean of
      // its neighbours and darkens; a crest sits above and stays open. Free,
      // because every sample it needs is already in the apron grid.
      const mean1 = (gh(i - 1, j) + gh(i + 1, j) + gh(i, j - 1) + gh(i, j + 1)
                   + gh(i - 1, j - 1) + gh(i + 1, j - 1) + gh(i - 1, j + 1) + gh(i + 1, j + 1)) * 0.125;
      const mean2 = (gh(i - 2, j) + gh(i + 2, j) + gh(i, j - 2) + gh(i, j + 2)) * 0.25;
      const c1 = (mean1 - h) / step;
      const c2 = (mean2 - h) / (2 * step);
      const ao = saturate(1 - (c1 * 0.85 + c2 * 0.55));

      // materialAt returns a module scratch, which is safe because everything
      // is copied out before the next call.
      const mgx = (gh(i - matK, j) - gh(i + matK, j)) * invMatSpan;
      const mgz = (gh(i, j - matK) - gh(i, j + matK)) * invMatSpan;
      const mat = materialAt(wx, wz, h, Math.hypot(mgx, mgz));

      // sqrt-encoded albedo: 8 bits of linear would band visibly on basalt at
      // 0.02 reflectance, and one square in the shader buys back four stops.
      material[v * 4] = Math.round(Math.sqrt(saturate(mat.albedo[0])) * 255);
      material[v * 4 + 1] = Math.round(Math.sqrt(saturate(mat.albedo[1])) * 255);
      material[v * 4 + 2] = Math.round(Math.sqrt(saturate(mat.albedo[2])) * 255);
      material[v * 4 + 3] = Math.round(saturate(mat.roughness) * 255);
      surface[v * 4] = Math.round(saturate(mat.sediment) * 255);
      surface[v * 4 + 1] = Math.round(saturate(mat.rockiness) * 255);
      surface[v * 4 + 2] = Math.round(ao * 255);
      // Smooth geology coordinate, not the categorical biome id. The shader
      // uses it to morph macro-material families across a biome boundary.
      surface[v * 4 + 3] = Math.round(saturate(mat.macroStyle) * 255);
    }
  }

  // --- skirt depth ------------------------------------------------------
  // The worst gap a one-level-coarser neighbour can open is bounded by the
  // height the fine edge travels between two of the coarse edge's samples.
  let maxEdgeDelta = 0;
  for (let i = 0; i < res - 1; i++) {
    const e0 = Math.abs(gh(i, 0) - gh(i + 1, 0));
    const e1 = Math.abs(gh(i, res - 1) - gh(i + 1, res - 1));
    const e2 = Math.abs(gh(0, i) - gh(0, i + 1));
    const e3 = Math.abs(gh(res - 1, i) - gh(res - 1, i + 1));
    maxEdgeDelta = Math.max(maxEdgeDelta, e0, e1, e2, e3);
  }
  const skirtDepth = clamp(maxEdgeDelta * 4, 1.0, 64);

  // --- skirt vertices, walked once around the perimeter -----------------
  // Order: north edge east-bound, east edge south-bound, south edge west-bound,
  // west edge north-bound. Traversed this way, (T_i, T_i+1, S_i+1) always winds
  // counter-clockwise as seen from outside the chunk, so the skirt survives
  // back-face culling with no per-edge special cases.
  const ring = new Int32Array(perimeter);
  let rp = 0;
  for (let i = 0; i < res - 1; i++) ring[rp++] = 0 * res + i;
  for (let j = 0; j < res - 1; j++) ring[rp++] = j * res + (res - 1);
  for (let i = res - 1; i > 0; i--) ring[rp++] = (res - 1) * res + i;
  for (let j = res - 1; j > 0; j--) ring[rp++] = j * res + 0;

  let skirtMinY = minY;
  for (let k = 0; k < perimeter; k++) {
    const src = ring[k];
    const dst = surfaceCount + k;
    positions[dst * 3] = positions[src * 3];
    positions[dst * 3 + 1] = positions[src * 3 + 1] - skirtDepth;
    positions[dst * 3 + 2] = positions[src * 3 + 2];
    if (positions[dst * 3 + 1] < skirtMinY) skirtMinY = positions[dst * 3 + 1];
    normals[dst * 3] = normals[src * 3];
    normals[dst * 3 + 1] = normals[src * 3 + 1];
    normals[dst * 3 + 2] = normals[src * 3 + 2];
    uvs[dst * 2] = uvs[src * 2];
    uvs[dst * 2 + 1] = uvs[src * 2 + 1];
    for (let c = 0; c < 4; c++) {
      material[dst * 4 + c] = material[src * 4 + c];
      surface[dst * 4 + c] = surface[src * 4 + c];
    }
  }

  // --- indices ----------------------------------------------------------
  const quads = (res - 1) * (res - 1);
  const indexCount = quads * 6 + perimeter * 6;
  const indices = new Uint16Array(indexCount);
  let w = 0;
  for (let j = 0; j < res - 1; j++) {
    for (let i = 0; i < res - 1; i++) {
      const v00 = j * res + i;
      const v10 = v00 + 1;
      const v01 = v00 + res;
      const v11 = v01 + 1;
      // Alternating diagonal. A fixed diagonal makes every ridge lean the same
      // way, which reads as a herringbone across an entire hillside.
      if (((i + j) & 1) === 0) {
        indices[w++] = v00; indices[w++] = v01; indices[w++] = v11;
        indices[w++] = v00; indices[w++] = v11; indices[w++] = v10;
      } else {
        indices[w++] = v00; indices[w++] = v01; indices[w++] = v10;
        indices[w++] = v10; indices[w++] = v01; indices[w++] = v11;
      }
    }
  }
  for (let k = 0; k < perimeter; k++) {
    const kn = (k + 1) % perimeter;
    const t0i = ring[k], t1i = ring[kn];
    const s0i = surfaceCount + k, s1i = surfaceCount + kn;
    indices[w++] = t0i; indices[w++] = t1i; indices[w++] = s1i;
    indices[w++] = t0i; indices[w++] = s1i; indices[w++] = s0i;
  }

  const t1 = (typeof performance !== 'undefined' ? performance : Date).now();

  return {
    cx, cz, lod, step, resolution: res,
    positions, normals, uvs, material, surface, indices,
    vertexCount, indexCount, surfaceCount, skirtDepth,
    triangleCount: indexCount / 3,
    aabb: {
      minX: ox, minY: skirtMinY, minZ: oz,
      maxX: ox + CHUNK_SIZE, maxY: maxY, maxZ: oz + CHUNK_SIZE,
    },
    bakeMs: t1 - t0,
  };
}

/**
 * Pack a baked chunk's separate arrays into the interleaved vertex layout the
 * pipeline consumes. `f32` and `u8` must be views over the SAME ArrayBuffer of
 * at least vertexCount * VERTEX_STRIDE bytes - the caller keeps one such
 * scratch for the whole session, so no chunk upload allocates.
 *
 * Layout, 40 bytes: pos f32x3 | normal f32x3 | uv f32x2 | material u8x4 |
 * surface u8x4.
 */
export function interleaveChunk(chunk, f32, u8) {
  const { positions, normals, uvs, material, surface, vertexCount } = chunk;
  const floatsPerVertex = VERTEX_STRIDE / 4;
  for (let v = 0; v < vertexCount; v++) {
    const o = v * floatsPerVertex;
    f32[o] = positions[v * 3];
    f32[o + 1] = positions[v * 3 + 1];
    f32[o + 2] = positions[v * 3 + 2];
    f32[o + 3] = normals[v * 3];
    f32[o + 4] = normals[v * 3 + 1];
    f32[o + 5] = normals[v * 3 + 2];
    f32[o + 6] = uvs[v * 2];
    f32[o + 7] = uvs[v * 2 + 1];
    const b = v * VERTEX_STRIDE + 32;
    u8[b] = material[v * 4]; u8[b + 1] = material[v * 4 + 1];
    u8[b + 2] = material[v * 4 + 2]; u8[b + 3] = material[v * 4 + 3];
    u8[b + 4] = surface[v * 4]; u8[b + 5] = surface[v * 4 + 1];
    u8[b + 6] = surface[v * 4 + 2]; u8[b + 7] = surface[v * 4 + 3];
  }
}

deriveSeeds();

// ---------------------------------------------------------------------------
// Spawn placement
// ---------------------------------------------------------------------------

/**
 * Find the beach the player starts on.
 *
 * The start point CANNOT be a hard-coded constant. The terrain is procedural,
 * so a literal coordinate is a guess that silently becomes wrong the moment a
 * layer amplitude changes - and the failure mode is the worst possible one:
 * the player spawns in open water with no land in sight, no vessel in reach,
 * and no way to tell that anything is broken. That is exactly what happened
 * with the original hard-coded BASE_POSITION, which sat in 17 m of water.
 *
 * So we derive it. The search walks outward along the island's shore on the
 * bearing that faces the safe lagoon, and takes the first spot that is
 * genuinely dry, genuinely walkable, and close enough to the water that the
 * vessel can sit beside it.
 *
 * Deterministic: same seed, same beach.
 *
 * @returns {{position: number[], vesselPad: number[], shoreBearing: number,
 *            height: number, slope: number}}
 */
export function findSpawnPoint() {
  // Bearing from the island's summit toward the crater, so the player walks
  // out of their base looking at the lagoon they are meant to explore.
  const len = Math.hypot(ISLAND_X, ISLAND_Z) || 1;
  const ux = -ISLAND_X / len;
  const uz = -ISLAND_Z / len;

  const MIN_DRY = 2.2;    // metres above sea level: clear of any wave
  const MAX_DRY = 12.0;   // not partway up the volcano
  const MAX_SLOPE = 0.30; // walkable, and flat enough to stand a vessel on

  let best = null;
  let bestScore = -Infinity;

  // Sweep a fan of bearings so a locally bad patch on the primary bearing
  // does not push the spawn somewhere absurd.
  for (let dAng = -0.5; dAng <= 0.5001; dAng += 0.05) {
    const c = Math.cos(dAng), s = Math.sin(dAng);
    const bx = ux * c - uz * s;
    const bz = ux * s + uz * c;

    for (let r = ISLAND_SHORE_R - 60; r <= ISLAND_SHORE_R + 10; r += 2) {
      const x = ISLAND_X + bx * r;
      const z = ISLAND_Z + bz * r;
      const h = sampleHeight(x, z);
      if (h < MIN_DRY || h > MAX_DRY) continue;
      const slope = sampleSlope(x, z);
      if (slope > MAX_SLOPE) continue;

      // Prefer flat ground, close to the waterline, on the primary bearing.
      const score = -slope * 10 - Math.abs(h - 4.0) * 0.6 - Math.abs(dAng) * 2.0;
      if (score > bestScore) {
        bestScore = score;
        best = { x, z, h, slope, bx, bz };
      }
    }
  }

  // The island profile guarantees a strand, so this should never fire; if the
  // terrain is ever retuned past that guarantee, fail loudly rather than
  // dropping the player into the sea.
  if (!best) {
    console.error('[terrain] findSpawnPoint found no walkable beach - ' +
                  'the island profile no longer guarantees a strand.');
    return {
      position: [ISLAND_X + ux * ISLAND_SHORE_R, 4, ISLAND_Z + uz * ISLAND_SHORE_R],
      vesselPad: [ISLAND_X + ux * (ISLAND_SHORE_R + 14), 2, ISLAND_Z + uz * (ISLAND_SHORE_R + 14)],
      shoreBearing: Math.atan2(ux, -uz),
      height: 4, slope: 0,
    };
  }

  // Park the vessel on DRY, FLAT ground a short walk seaward of the base.
  //
  // Two constraints that are easy to get wrong and both produce a vessel the
  // player can never use:
  //   - It must be above the waterline. Sitting it at sea level looks tidy and
  //     leaves it half-submerged, drifting off on the swell.
  //   - Its ORIGIN must clear the ground by EXACTLY the drop to the bottom of
  //     its skids. Placing the origin at terrain level spawns the hull
  //     intersecting the terrain and the collision resolver ejects it - the
  //     Kestrel was being launched 20 m into the air on the first frame - but
  //     the clearance is not free to be generous either. It is measured from the
  //     mesh (VESSEL_SKID_DROP = 1.175 m: skid centreline 1.10 m below the
  //     origin plus a 75 mm tube radius), and the 1.8 m guess it replaces left
  //     the Kestrel hovering 62 cm over the sand with daylight under its feet.
  let pad = null;
  let padScore = -Infinity;
  for (let d = 12; d <= 30; d += 1.5) {
    const x = best.x + best.bx * d;
    const z = best.z + best.bz * d;
    const h = sampleHeight(x, z);
    if (h < 1.6) continue;                 // dry land only
    const slope = sampleSlope(x, z);
    if (slope > 0.22) continue;            // it must rest level
    // Prefer flat, close to the base, and low on the beach (near the water).
    const score = -slope * 14 - h * 0.25 - d * 0.05;
    if (score > padScore) { padScore = score; pad = [x, h + VESSEL_SKID_DROP, z]; }
  }
  if (!pad) {
    // Fall back to standing it beside the player rather than in the sea.
    const x = best.x + best.bx * 12;
    const z = best.z + best.bz * 12;
    pad = [x, Math.max(sampleHeight(x, z), best.h) + VESSEL_SKID_DROP, z];
  }

  return {
    position: [best.x, best.h, best.z],
    vesselPad: pad,
    // Heading that looks from the base out over the water toward the lagoon.
    shoreBearing: Math.atan2(best.bx, -best.bz),
    height: best.h,
    slope: best.slope,
  };
}
