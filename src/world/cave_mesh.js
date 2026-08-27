/**
 * SUBWAVE cave chunk bake: field mesh -> culled, packed GPU vertex stream.
 *
 * DEVICE-FREE ON PURPOSE, like render/scatter_emit.js and for the same reason:
 * this exact arithmetic must run in three places - the cave worker, the inline
 * fallback the offline suites take (`typeof Worker === 'undefined'` in Node),
 * and any future census - and a transcription drifts. Nothing here may touch
 * the GPU, the DOM or `window`.
 *
 * WHAT THE CULL REMOVES, and why it is not optional. generateCaveChunk()
 * marches the WHOLE field, and the field's terrain term crosses zero wherever
 * the heightfield surface passes through the chunk - so the raw mesh contains a
 * duplicate copy of every square metre of seabed the chunk touches, coincident
 * with the terrain pass's own geometry to within the sampling difference.
 * Drawn as-is it z-fights the terrain over 32 m patches. A triangle survives
 * the cull when:
 *
 *   - any of its vertices is CARVED (the void term produced it: tunnel wall,
 *     chamber, fissure, mouth shaft), which keeps every surface the volumetric
 *     layer actually adds plus a one-triangle fringe into the coincident copy
 *     (`carved` is sampled at the nearest lattice point, so the fringe is the
 *     margin that makes that rounding immaterial); or
 *   - it lies within the KEEP RING of a cave mouth and near the heightfield
 *     surface. The terrain pass discards its own fragments inside a disc over
 *     each mouth (see the CAVE_MOUTHS block in pass/terrain.wgsl), and this
 *     ring is what backs that disc: behind every discarded terrain fragment
 *     there is a cave-mesh copy of the same surface, so an over-generous disc
 *     shows the copy rather than a hole in the world.
 *
 * The kept near-surface copy is SUNK 4 cm along -normal at encode time
 * (MOUTH_SINK). Where the terrain is NOT discarded the two surfaces would
 * otherwise be coincident within millimetres and shimmer; 4 cm loses the tie
 * cleanly to the terrain everywhere the terrain still draws, and is invisible
 * where it does not.
 *
 * The OVERHANG displacement produces no carved samples (it lives inside the
 * terrain term), so its geometry is dropped by this cull and it remains
 * UNCONSUMED, exactly as world/caves.js documents. Its consumer needs the full
 * DESIGN/02 8.7 suppression atlas; do not try to keep its triangles here -
 * they disagree with the heightfield mesh by up to 12 m and the terrain pass
 * draws over them from most angles while leaving see-through backfaces from
 * the rest.
 */

import { generateCaveChunk, caveSkeleton, CAVE_MACRO_SIZE, CAVE_CHUNK_SIZE,
         CAVE_SKIRT, CAVE_CELL, CAVE_MATERIAL, caveVoidAt,
         jellyShroomInstances } from './caves.js';
import { sampleHeight } from './terrain.js';
import { hashU32 } from '../core/math.js';

/** Bytes per packed cave vertex: pos f32x3, normal f32x3, aux unorm8x4. */
export const CAVE_VERTEX_STRIDE = 28;

// ---------------------------------------------------------------------------
// GEODE SPAR INSTANCES
//
// The Geode Hollows (DESIGN/01 biome #22) is a VOLUME identity - "inside the
// cave SDF volume, -560..-1050" - and the columnar scatter placement loop
// cannot express it: sampleField classifies COLUMNS, and every point of a cave
// interior shares its column with the seabed 60-160 m above it. So the spar
// dressing is emitted HERE, by the cave bake itself, as deterministic
// instances riding the same transferable buffer as the geometry: a kept,
// CARVED, interior-facing vertex is by construction a point on the real cave
// wall the renderer will draw, so an instance seated on one can never float
// or bury. render/passes/caves.js draws them instanced with the registered
// `crystalSpar` mesh (world/meshgen.js - the 3.4 m calcite blade cluster,
// which is what test-meshgen measures; per-instance scale 0.25-1.0 delivers
// the 0.8-3.4 m band DESIGN quotes).
//
// DETERMINISM: everything below is a pure function of the kept mesh (itself a
// pure function of address and seed) and of integer-quantised WORLD
// coordinates - no RNG state, no iteration-order dependence beyond the mesh's
// own deterministic vertex order. tools/probes/cave-spar.js bakes twice and
// byte-compares. OWNERSHIP: only vertices inside the chunk's own 32 m cube
// (skirt excluded) may seed an instance, so a wall shared by two chunks
// cannot emit the same cluster twice.
// ---------------------------------------------------------------------------

/** Bytes per spar instance: pos f32x3 (lattice-origin-relative, like the cave
 *  vertices), scale f32, wall normal f32x3, yaw f32. */
export const SPAR_INSTANCE_STRIDE = 32;

/** The Geode band, absolute metres (DESIGN/01 #22: -560..-1050). Outside it a
 *  cave is the plain Undervault and gets no spar. */
const SPAR_BAND_TOP = -560;
const SPAR_BAND_BOTTOM = -1050;
/** Metres of rock overhead a spar site needs (surfaceDepth). Keeps calcite off
 *  mouth rims and shafts, where the MOUTH material band and daylight live. */
const SPAR_MIN_ROCK = 12;
/** Dedup grid pitch, metres: at most one cluster seed per 3 m cell. */
const SPAR_CELL = 3;
/** Acceptance per first-eligible-vertex-in-cell: floors carry the clusters,
 *  walls a sparser scatter of blades. */
// 2026-08-18 drastic pass: floor 0.30 -> 0.40, wall 0.08 -> 0.12, cap 96 ->
// 128 (0.50/0.22/160 was tried and crushed auto-exposure to one glowing wall). The geode chamber photographed as bare navy walls with three spars;
// the place's whole identity is the crystals, so the reveal needs a field of
// them, not a sample.
const SPAR_P_FLOOR = 0.40;
const SPAR_P_WALL = 0.12;
const SPAR_FLOOR_NY = 0.55;
const SPAR_WALL_NY = -0.15;
/**
 * Void-thickness gate: the probe distance along the wall normal and the
 * openness still required there. A candidate only qualifies when
 * caveVoidAt(seed + normal * PROBE) > OPEN, which a FISSURE cannot satisfy -
 * the joint sheets are ~2.1 m wide, so 2.5 m along the normal is already
 * inside the far wall - while a graph tunnel (diameter 5.2 m at the
 * narrowest biome rMin the geode band carries) or a chamber clears it
 * easily. Without this gate the sheets took most of the budget: measured on
 * the First Hollow neighbourhood, 1,151 instances over 39 chunks with whole
 * fissure walls crusted in calcite, against the CHAMBER identity the geode
 * band is for.
 */
const SPAR_PROBE_ALONG_NORMAL = 2.5;
const SPAR_PROBE_MIN_OPEN = 1.0;
/** Hard cap per chunk; typical delivery is well under it. */
const SPAR_MAX_PER_CHUNK = 128;
/** Mesh variants the pass builds (seeds of the ONE registered crystalSpar
 *  parameterisation). Kept here because the bake sorts instances by variant
 *  so the pass can draw each as one instanced range. */
export const SPAR_VARIANTS = 4;

// ---------------------------------------------------------------------------
// AUTHORED-SITE PROPS (Jellyshroom Hollow, world/cave_sites.js)
//
// Same emission machinery as the spar above - deterministic instances packed
// after the geometry, positions lattice-origin-relative, sorted by variant -
// but gated on mesh.authored (the per-vertex authored-site weight) instead of
// the Geode depth band. Two prop classes share the four variants:
//   0..1  jellyshroom (variant = the authored instance's own, see
//         caves.js jellyShroomInstances - placement is AUTHORED, not sampled)
//   2..3  speleothem clusters, sampled on the site's ceilings and floors the
//         way spar samples the Geode's floors and walls.
// ---------------------------------------------------------------------------

/** Variants the prop library builds: [shroomA, shroomB, spelA, spelB]. */
export const CAVE_PROP_VARIANTS = 4;
/** First speleothem variant index. */
export const CAVE_PROP_SPEL_BASE = 2;
/** Per-vertex authored weight below which no prop may seed. */
const PROP_AUTHORED_MIN = 0.6;
/** Ceiling / floor acceptance and the normal-y bands that define them. The
 *  reference image hangs its crystals from the roof, so ceilings dominate. */
// First delivered frames: 0.50/0.15 carpeted every surface of the corridor
// and chamber in small crystals and the frame read as noise, not as rock
// with crystal ACCENTS. Second review round: even sparser-but-uniform read
// as confetti - the reference hangs CHANDELIER CLUSTERS with black rock
// between them. So acceptance is now two-stage: a coarse 12 m cluster cell
// keeps only SPEL_CLUSTER_KEEP of the ceiling, and INSIDE a kept cluster
// the per-site probability is high and the dedup pitch tight.
const SPEL_P_CEILING = 0.55;
const SPEL_P_FLOOR = 0.14;
const SPEL_CLUSTER_CELL = 12;
const SPEL_CLUSTER_KEEP = 0.34;
const SPEL_CEILING_NY = -0.35;
const SPEL_FLOOR_NY = 0.55;
/** Dedup pitch, metres, INSIDE a kept cluster cell. */
const SPEL_CELL = 3;
/** Metres of rock overhead a speleothem needs - keeps them off the mouth rim
 *  where the MOUTH band and the terrain discard disc live. */
const SPEL_MIN_ROCK = 8;
/** Combined per-chunk prop cap (shrooms are authored and few; this bounds the
 *  sampled speleothems). */
const PROP_MAX_PER_CHUNK = 160;

/** Deterministic u32 from integer-quantised world coordinates. */
function sparHash(qx, qy, qz) {
  let h = 0x9e3779b9 ^ Math.imul(qx | 0, 0x85ebca6b);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h ^ (qy | 0), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h ^ (qz | 0), 0x27d4eb2f) >>> 0;
  return hashU32(h);
}

/**
 * Baked skylight ramp, metres BELOW the heightfield surface. 1.0 at the
 * surface (mouth rims take full sky and sun), 0 by GONE. The renderer has no
 * per-pixel occlusion test against rock, so this baked gate is the only thing
 * stopping the sky-ambient SH and the solar beam lighting a wall that sits
 * under 100 m of basalt. GONE is a daylight-penetration claim about a shaft a
 * few metres wide, not a tuning knob: past about three shaft diameters the
 * direct sky solid angle is gone.
 */
const SKYLIGHT_FULL_DEPTH = 0.75;
const SKYLIGHT_GONE_DEPTH = 10.0;

/** Metres a kept near-surface (MOUTH-band) vertex is sunk along -normal. */
const MOUTH_SINK = 0.04;

/** Half-width of the near-surface band eligible for the mouth keep ring. */
const KEEP_BAND = 2.0;

/**
 * Terrain-discard disc radius for a mouth of top radius r, metres.
 *
 * The hole the mouth capsule actually carves in the surface is r plus the wall
 * perturbation's local amplitude (min(2.9, 0.4 r)), stretched where the
 * surface is steep because a vertical shaft meets a slope in an ellipse. 1.6
 * covers the stretch to a 51 degree face with margin; over-covering is SAFE
 * (the keep ring backs the disc with the cave mesh's own surface copy) while
 * under-covering leaves an annulus of terrain roofing the hole.
 */
export function mouthDiscRadius(r) {
  return (r + Math.min(2.9, 0.4 * r)) * 1.6 + 0.75;
}

/** The keep ring extends this far past the discard disc. */
const MOUTH_KEEP_MARGIN = 2.5;

const _s01 = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Every mouth whose keep ring can touch cave chunk (cx, cy, cz), as flat
 * [x, z, surfaceY, keepRadius] tuples. Reads the 3x3 macro-cell column around
 * the chunk across the full vertical band, because a mouth lives in the macro
 * cell of its below-surface START point, which can be several cells below the
 * surface it opens.
 */
function gatherMouths(cx, cy, cz, minY, maxY) {
  const out = [];
  const x0 = cx * CAVE_CHUNK_SIZE, z0 = cz * CAVE_CHUNK_SIZE;
  const mx0 = Math.floor(x0 / CAVE_MACRO_SIZE), mz0 = Math.floor(z0 / CAVE_MACRO_SIZE);
  const my0 = Math.floor(minY / CAVE_MACRO_SIZE), my1 = Math.floor(maxY / CAVE_MACRO_SIZE);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let my = my0; my <= my1; my++) {
        const sk = caveSkeleton(mx0 + dx, my, mz0 + dz);
        for (let m = 0; m < sk.mouthCount; m++) {
          const mxp = sk.mouths[m * 3], mzp = sk.mouths[m * 3 + 2];
          const keepR = mouthDiscRadius(sk.mouthRadius[m]) + MOUTH_KEEP_MARGIN;
          // Cheap chunk-overlap reject in XZ.
          if (mxp + keepR < x0 - CAVE_CELL || mxp - keepR > x0 + CAVE_CHUNK_SIZE + CAVE_CELL ||
              mzp + keepR < z0 - CAVE_CELL || mzp - keepR > z0 + CAVE_CHUNK_SIZE + CAVE_CELL) continue;
          out.push(mxp, mzp, sampleHeight(mxp, mzp), keepR);
        }
      }
    }
  }
  return out;
}

// Compaction scratch, reused across bakes (single-threaded per worker, the
// same assumption world/noise.js makes).
let _remap = new Int32Array(0);
let _keepTri = new Uint8Array(0);

/**
 * Bake one cave chunk into a single packed transferable buffer.
 *
 * Layout: [0, vbBytes) packed vertices at CAVE_VERTEX_STRIDE, then
 * [vbBytes, vbBytes + ibBytes) Uint32 indices. Same one-buffer shape as the
 * terrain worker's, for the same free-list reasons.
 *
 * @param {number} cx @param {number} cy @param {number} cz chunk address
 * @param {(bytes: number) => ArrayBuffer} [take] buffer allocator (the worker
 *   passes its free-list; the inline path defaults to plain allocation)
 * @returns {object|null} null when the chunk holds no renderable cave geometry.
 */
export function bakeCaveChunk(cx, cy, cz, take = (n) => new ArrayBuffer(n)) {
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
  const mesh = generateCaveChunk(cx, cy, cz);
  if (!mesh) return null;

  const minY = cy * CAVE_CHUNK_SIZE - CAVE_SKIRT * CAVE_CELL;
  const maxY = minY + CAVE_CHUNK_SIZE + 2 * CAVE_SKIRT * CAVE_CELL;
  const mouths = gatherMouths(cx, cy, cz, minY - CAVE_MACRO_SIZE * 3, maxY);

  const vc = mesh.vertexCount;
  const pos = mesh.positions, nrm = mesh.normals, idx = mesh.indices;
  const carved = mesh.carved, sd = mesh.surfaceDepth, mat = mesh.materials;

  // Per-vertex keep eligibility: carved, or near-surface inside a mouth ring.
  if (_remap.length < vc) _remap = new Int32Array(vc * 2);
  const eligible = _remap; // reused as scratch before the remap pass
  for (let v = 0; v < vc; v++) {
    let e = carved[v];
    if (!e && Math.abs(sd[v]) < KEEP_BAND && mouths.length > 0) {
      const px = pos[v * 3], pz = pos[v * 3 + 2];
      for (let m = 0; m < mouths.length; m += 4) {
        const dx = px - mouths[m], dz = pz - mouths[m + 1];
        const r = mouths[m + 3];
        if (dx * dx + dz * dz < r * r) { e = 1; break; }
      }
    }
    eligible[v] = e;
  }

  // Triangle cull: keep when any vertex is eligible.
  const triCount = mesh.triangleCount;
  if (_keepTri.length < triCount) _keepTri = new Uint8Array(triCount * 2);
  let keptTris = 0;
  for (let t = 0; t < triCount; t++) {
    const k = (eligible[idx[t * 3]] | eligible[idx[t * 3 + 1]] | eligible[idx[t * 3 + 2]]) & 1;
    _keepTri[t] = k;
    keptTris += k;
  }
  if (keptTris === 0) return null;

  // Vertex compaction. `eligible` is consumed above, so `_remap` can be
  // rebuilt in place: -1 until a kept triangle references the vertex.
  const remap = _remap;
  for (let v = 0; v < vc; v++) remap[v] = -1;
  let keptVerts = 0;
  for (let t = 0; t < triCount; t++) {
    if (!_keepTri[t]) continue;
    for (let c = 0; c < 3; c++) {
      const v = idx[t * 3 + c];
      if (remap[v] < 0) remap[v] = keptVerts++;
    }
  }

  // --- geode spar selection -------------------------------------------------
  // Over KEPT vertices only (remap >= 0), so every seed is on geometry that
  // will actually draw. See the SPAR block at the top of this file.
  const spar = [];
  const sparCounts = [0, 0, 0, 0];
  const cx0 = cx * CAVE_CHUNK_SIZE, cy0 = cy * CAVE_CHUNK_SIZE, cz0 = cz * CAVE_CHUNK_SIZE;
  if (cy0 < SPAR_BAND_TOP && cy0 + CAVE_CHUNK_SIZE > SPAR_BAND_BOTTOM) {
    const seen = new Set();
    for (let v = 0; v < vc && spar.length < SPAR_MAX_PER_CHUNK; v++) {
      if (remap[v] < 0 || !carved[v]) continue;
      if (mat[v] !== CAVE_MATERIAL.INTERIOR) continue;
      const py = pos[v * 3 + 1];
      if (py > SPAR_BAND_TOP || py < SPAR_BAND_BOTTOM) continue;
      if (sd[v] < SPAR_MIN_ROCK) continue;
      const px = pos[v * 3], pz = pos[v * 3 + 2];
      // Ownership: the chunk's own cube, skirt excluded (no cross-chunk dupes).
      if (px < cx0 || px >= cx0 + CAVE_CHUNK_SIZE ||
          py < cy0 || py >= cy0 + CAVE_CHUNK_SIZE ||
          pz < cz0 || pz >= cz0 + CAVE_CHUNK_SIZE) continue;
      const ny = nrm[v * 3 + 1];
      if (ny <= SPAR_WALL_NY) continue;                 // never on ceilings
      const p = ny > SPAR_FLOOR_NY ? SPAR_P_FLOOR : SPAR_P_WALL;
      // One seed per 3 m cell, first eligible vertex wins (deterministic:
      // the marched vertex order is a pure function of the field).
      const cellKey = `${Math.floor(px / SPAR_CELL)},${Math.floor(py / SPAR_CELL)},${Math.floor(pz / SPAR_CELL)}`;
      if (seen.has(cellKey)) continue;
      seen.add(cellKey);
      const h = sparHash(Math.round(px * 4), Math.round(py * 4), Math.round(pz * 4));
      if ((h >>> 8) / 16777216 >= p) continue;
      // The void-thickness gate LAST, because it is the expensive test (one
      // full field query) and the hash has already rejected 70-92%.
      const nx = nrm[v * 3], nz = nrm[v * 3 + 2];
      if (caveVoidAt(px + nx * SPAR_PROBE_ALONG_NORMAL,
                     py + ny * SPAR_PROBE_ALONG_NORMAL,
                     pz + nz * SPAR_PROBE_ALONG_NORMAL) < SPAR_PROBE_MIN_OPEN) continue;
      const h2 = hashU32(h ^ 0x5bd1e995);
      const u2 = (h2 >>> 8) / 16777216;
      spar.push({
        x: px, y: py, z: pz,
        // 0.25-1.0 of the 3.4 m mesh, biased small: 0.85-3.4 m delivered.
        scale: 0.25 + 0.75 * u2 * u2,
        nx, ny, nz,
        yaw: ((h2 & 0xff) / 255) * Math.PI * 2,
        variant: (h >>> 4) & 3,
      });
    }
    // Sorted by variant so the pass draws each variant as ONE instanced
    // range with a firstInstance offset. Stable within a variant because
    // Array.prototype.sort is stable and the emit order is deterministic.
    spar.sort((a, b) => a.variant - b.variant);
    for (const s of spar) sparCounts[s.variant]++;
  }
  const sparBytes = spar.length * SPAR_INSTANCE_STRIDE;

  // --- authored-site props --------------------------------------------------
  // See the CAVE PROP block at the top of this file. Same record layout and
  // determinism argument as the spar; `props` stays empty for every chunk that
  // does not touch an authored site (mesh.authored is null there).
  const props = [];
  const propCounts = [0, 0, 0, 0];
  let propReach = 0;
  const authored = mesh.authored;
  if (authored) {
    // Jellyshrooms: AUTHORED instances, owned by the chunk whose cube holds
    // the seated base point. The seat is a field bisection (caves.js), so the
    // same instance resolves identically from every candidate chunk and the
    // own-cube filter makes exactly one emit it.
    for (const s of jellyShroomInstances()) {
      if (s.x < cx0 || s.x >= cx0 + CAVE_CHUNK_SIZE ||
          s.y < cy0 || s.y >= cy0 + CAVE_CHUNK_SIZE ||
          s.z < cz0 || s.z >= cz0 + CAVE_CHUNK_SIZE) continue;
      props.push({ x: s.x, y: s.y, z: s.z, scale: s.scale,
                   nx: 0, ny: 1, nz: 0, yaw: s.yaw, variant: s.variant });
      // Registered mesh is ~14 m tall with a ~6.5 m cap radius; 16 covers the
      // lean and the cap for the cull pad.
      propReach = Math.max(propReach, s.scale * 16);
    }
    // Speleothems: sampled on the site's ceilings and floors over kept,
    // carved, interior vertices - the spar loop's shape with the authored
    // weight standing in for the depth band.
    const seenSpel = new Set();
    for (let v = 0; v < vc && props.length < PROP_MAX_PER_CHUNK; v++) {
      if (remap[v] < 0 || !carved[v]) continue;
      if (mat[v] !== CAVE_MATERIAL.INTERIOR) continue;
      if (authored[v] < PROP_AUTHORED_MIN) continue;
      if (sd[v] < SPEL_MIN_ROCK) continue;
      const px = pos[v * 3], py = pos[v * 3 + 1], pz = pos[v * 3 + 2];
      if (px < cx0 || px >= cx0 + CAVE_CHUNK_SIZE ||
          py < cy0 || py >= cy0 + CAVE_CHUNK_SIZE ||
          pz < cz0 || pz >= cz0 + CAVE_CHUNK_SIZE) continue;
      const ny = nrm[v * 3 + 1];
      let p;
      if (ny <= SPEL_CEILING_NY) p = SPEL_P_CEILING;
      else if (ny >= SPEL_FLOOR_NY) p = SPEL_P_FLOOR;
      else continue;
      // Cluster gate FIRST: whole 12 m cells opt in or out, so the growth
      // arrives in chandelier patches with bare rock between.
      const ch = sparHash(Math.floor(px / SPEL_CLUSTER_CELL) ^ 0x77a1,
                         Math.floor(py / SPEL_CLUSTER_CELL),
                         Math.floor(pz / SPEL_CLUSTER_CELL));
      if ((ch >>> 8) / 16777216 >= SPEL_CLUSTER_KEEP) continue;
      const cellKey = `${Math.floor(px / SPEL_CELL)},${Math.floor(py / SPEL_CELL)},${Math.floor(pz / SPEL_CELL)}`;
      if (seenSpel.has(cellKey)) continue;
      seenSpel.add(cellKey);
      const h = sparHash(Math.round(px * 4) ^ 0x51e11, Math.round(py * 4), Math.round(pz * 4));
      if ((h >>> 8) / 16777216 >= p) continue;
      // Void-thickness gate, exactly the spar's: no crystals on fissure sheets.
      const nx = nrm[v * 3], nz = nrm[v * 3 + 2];
      if (caveVoidAt(px + nx * SPAR_PROBE_ALONG_NORMAL,
                     py + ny * SPAR_PROBE_ALONG_NORMAL,
                     pz + nz * SPAR_PROBE_ALONG_NORMAL) < SPAR_PROBE_MIN_OPEN) continue;
      const h2 = hashU32(h ^ 0x2b7e1519);
      const u2 = (h2 >>> 8) / 16777216;
      let scale = 0.7 + 1.1 * u2 * u2;
      // A long spike needs a big void. The probe distance must clear the FAR
      // WALL of a small passage, not merely reach open water: a first cut
      // probed 7 m, which is at most the AXIS of the corridor's ~15 m tube -
      // openness there is the tube radius, the gate never fired, and the
      // shot round photographed full-size clusters filling the swim line
      // nose-to-nose. At 15 m the probe lands inside rock for the corridor
      // (closed -> capped at 0.75 and halved in count) and still well inside
      // the hall's 44-88 m spans (open -> full chandelier scale).
      if (caveVoidAt(px + nx * 15, py + ny * 15, pz + nz * 15) < 1.0) {
        if (hashU32(h2 ^ 0x9e3779b9) & 1) continue;
        scale = Math.min(scale, 0.75);
      }
      props.push({
        x: px, y: py, z: pz, scale,
        nx, ny, nz,
        yaw: ((h2 & 0xff) / 255) * Math.PI * 2,
        variant: CAVE_PROP_SPEL_BASE + ((h >>> 4) & 1),
      });
      propReach = Math.max(propReach, scale * 6.5);
    }
    props.sort((a, b) => a.variant - b.variant);
    for (const s of props) propCounts[s.variant]++;
  }
  const propBytes = props.length * SPAR_INSTANCE_STRIDE;

  const vbBytes = keptVerts * CAVE_VERTEX_STRIDE;
  const ibBytes = keptTris * 3 * 4;
  const buf = take(vbBytes + ibBytes + sparBytes + propBytes);
  const f32 = new Float32Array(buf, 0, vbBytes >> 2);
  const u8 = new Uint8Array(buf, 0, vbBytes);
  const ib = new Uint32Array(buf, vbBytes, keptTris * 3);

  const ox = mesh.origin[0], oy = mesh.origin[1], oz = mesh.origin[2];
  let minX = Infinity, minYb = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxYb = -Infinity, maxZ = -Infinity;
  let grottoKept = 0;

  const strideF = CAVE_VERTEX_STRIDE >> 2;
  for (let v = 0; v < vc; v++) {
    const o = remap[v];
    if (o < 0) continue;
    let px = pos[v * 3], py = pos[v * 3 + 1], pz = pos[v * 3 + 2];
    const nx = nrm[v * 3], ny = nrm[v * 3 + 1], nz = nrm[v * 3 + 2];
    const m = mat[v];
    if (m === CAVE_MATERIAL.MOUTH) {
      px -= nx * MOUTH_SINK; py -= ny * MOUTH_SINK; pz -= nz * MOUTH_SINK;
    }
    const base = o * strideF;
    f32[base] = px - ox;
    f32[base + 1] = py - oy;
    f32[base + 2] = pz - oz;
    f32[base + 3] = nx;
    f32[base + 4] = ny;
    f32[base + 5] = nz;
    // aux: SEPARATE unorm channels per material class - mouth weight, baked
    // skylight, grotto weight, spare. One packed class id would interpolate
    // THROUGH the other classes across a triangle (a mouth/interior edge would
    // pass through the grotto value at its midpoint and paint a bioluminescent
    // stripe on bare rock).
    const ab = o * CAVE_VERTEX_STRIDE + 24;
    u8[ab] = m === CAVE_MATERIAL.MOUTH ? 255 : 0;
    u8[ab + 1] = Math.round(255 * (1 - _s01(SKYLIGHT_FULL_DEPTH, SKYLIGHT_GONE_DEPTH, sd[v])));
    u8[ab + 2] = m === CAVE_MATERIAL.GROTTO ? 255 : 0;
    // The authored-site weight (caves.js mesh.authored): pass/cave.wgsl drives
    // the site's own wall treatment off it. 0 everywhere outside a site.
    u8[ab + 3] = authored ? Math.round(255 * Math.min(1, Math.max(0, authored[v]))) : 0;
    if (m === CAVE_MATERIAL.GROTTO) grottoKept++;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minYb) minYb = py;
    if (py > maxYb) maxYb = py;
    if (pz < minZ) minZ = pz;
    if (pz > maxZ) maxZ = pz;
  }

  let w = 0;
  for (let t = 0; t < triCount; t++) {
    if (!_keepTri[t]) continue;
    ib[w++] = remap[idx[t * 3]];
    ib[w++] = remap[idx[t * 3 + 1]];
    ib[w++] = remap[idx[t * 3 + 2]];
  }

  // Spar instances, packed after the indices, positions relative to the SAME
  // lattice origin as the vertices so the pass's per-chunk uniform serves both.
  if (sparBytes > 0) {
    const sf = new Float32Array(buf, vbBytes + ibBytes, spar.length * (SPAR_INSTANCE_STRIDE >> 2));
    for (let i = 0; i < spar.length; i++) {
      const s = spar[i], o = i * 8;
      sf[o] = s.x - ox; sf[o + 1] = s.y - oy; sf[o + 2] = s.z - oz;
      sf[o + 3] = s.scale;
      sf[o + 4] = s.nx; sf[o + 5] = s.ny; sf[o + 6] = s.nz;
      sf[o + 7] = s.yaw;
    }
  }

  // Authored-site props, same record shape, packed after the spar.
  if (propBytes > 0) {
    const pf = new Float32Array(buf, vbBytes + ibBytes + sparBytes,
                                props.length * (SPAR_INSTANCE_STRIDE >> 2));
    for (let i = 0; i < props.length; i++) {
      const s = props[i], o = i * 8;
      pf[o] = s.x - ox; pf[o + 1] = s.y - oy; pf[o + 2] = s.z - oz;
      pf[o + 3] = s.scale;
      pf[o + 4] = s.nx; pf[o + 5] = s.ny; pf[o + 6] = s.nz;
      pf[o + 7] = s.yaw;
    }
  }

  // The chunk's cull AABB must contain the spar blades too: a 3.4 m cluster
  // seeded on a boundary wall would otherwise pop at the frustum edge. Props
  // extend it further - a 16 m jellyshroom seeded on the floor cell of one
  // chunk reaches well into its neighbours' frusta.
  const sparPad = Math.max(spar.length > 0 ? 3.5 : 0, propReach);

  const t1 = (typeof performance !== 'undefined' ? performance : Date).now();
  return {
    buf, vbBytes, ibBytes,
    vertexCount: keptVerts,
    indexCount: keptTris * 3,
    triangleCount: keptTris,
    // Absolute-coordinate bounds of the KEPT geometry, for frustum culling.
    aabb: { minX: minX - sparPad, minY: minYb - sparPad, minZ: minZ - sparPad,
            maxX: maxX + sparPad, maxY: maxYb + sparPad, maxZ: maxZ + sparPad },
    grottoFraction: keptVerts > 0 ? grottoKept / keptVerts : 0,
    culledTriangles: triCount - keptTris,
    sparCount: spar.length,
    sparCounts,
    sparBytes,
    propCount: props.length,
    propCounts,
    propBytes,
    bakeMs: t1 - t0,
  };
}
