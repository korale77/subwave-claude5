/**
 * SUBWAVE volumetric layer: caves, overhangs and swim-throughs.
 *
 * The heightfield in world/terrain.js cannot express a tunnel, a roof, an arch
 * or a crystal cavern - a function y = H(x, z) has exactly one surface per
 * column. Rather than make the whole world volumetric (10-30x the memory and
 * generation time for a feature that occupies a few percent of the volume),
 * SUBWAVE uses a SPARSE VOLUMETRIC OVERRIDE: 32 m cubes, marching-cubed, that
 * exist only where the heightfield is not enough.
 *
 * SIGN CONVENTION (binding, and the opposite of DESIGN/02's internal F):
 *
 *     caveDensity(x, y, z)  <  0   SOLID ROCK
 *                           == 0   the iso-surface
 *                           >  0   OPEN (water, air, or cave void)
 *
 * so the field behaves like a signed distance to rock and marching cubes runs
 * with the standard "negative is inside" convention. Triangle winding puts the
 * normal in the direction of INCREASING density, i.e. out of the rock.
 *
 * THE TWO SYSTEMS AGREE AT THE INTERFACE because the terrain term is built from
 * terrain.sampleHeight() itself - the identical H() the heightfield mesh is baked
 * from, including every detail layer. A cave chunk that reaches the surface
 * therefore produces a mesh that coincides with the heightfield mesh to within
 * the sampling difference (1.0 m voxel against the 1.0 m LOD-0 grid), and a cave
 * mouth is a hole in the ground rather than a floating shell.
 *
 * WATERTIGHT SEAMS. The field is sampled on a lattice in ABSOLUTE WORLD
 * COORDINATES at exactly 1 m spacing, and a chunk's lattice origin is an
 * integer. Two neighbouring chunks therefore evaluate the shared lattice plane
 * at bit-identical coordinates and get bit-identical values, so the marching
 * cubes vertices on that plane land in bit-identical positions. There is no
 * chunk-local coordinate anywhere in the field evaluation - that is the whole
 * trick, and it is why the chunk overlaps by one cell on every face rather than
 * trying to stitch afterwards.
 *
 * COORDINATES: +X east, +Y up, +Z south, metres, sea level y = 0, depth = -y.
 */

import { WORLD } from '../core/constants.js';
import { clamp, lerp, smoothstep, hashU32, vec3 } from '../core/math.js';
import { simplex2, simplex3, fbm3, worley3Edge } from './noise.js';
import { sampleHeight, getSeed } from './terrain.js';
import { biomeAt } from './biomes.js';
import { resolvedCaveSites } from './cave_sites.js';

// ===========================================================================
// Marching cubes: cube topology
// ===========================================================================

/**
 * Corner numbering, the canonical marching-cubes layout. Corner `c` of the cube
 * at lattice index (i, j, k) is the sample at (i + dx, j + dy, k + dz).
 * Bit `c` of a cube's configuration index is set when that corner is SOLID
 * (field < iso).
 */
const CORNER_OFFSET = [
  [0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1],
  [0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1],
];

/** The 12 edges, as corner pairs, in the canonical order. */
const EDGE_CORNERS = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/**
 * The 6 faces, each as four corners in cyclic order, plus that face's OUTWARD
 * normal. The cyclic order need not be consistently handed: every orientation
 * decision below is made numerically from the corner positions and the outward
 * normal, so a face listed the other way round produces the same result.
 */
const FACE_CORNERS = [
  [0, 1, 2, 3],   // -Y  bottom
  [4, 5, 6, 7],   // +Y  top
  [0, 1, 5, 4],   // -Z  north face
  [3, 2, 6, 7],   // +Z  south face
  [0, 3, 7, 4],   // -X  west face
  [1, 2, 6, 5],   // +X  east face
];
const FACE_NORMAL = [
  [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0],
];

/** FACE_EDGES[f][s] = the edge index between FACE_CORNERS[f][s] and [s+1]. */
const FACE_EDGES = FACE_CORNERS.map((corners) =>
  corners.map((c, s) => {
    const d = corners[(s + 1) & 3];
    for (let e = 0; e < 12; e++) {
      const [a, b] = EDGE_CORNERS[e];
      if ((a === c && b === d) || (a === d && b === c)) return e;
    }
    throw new Error(`no edge between corners ${c} and ${d}`);
  }));

/** Midpoint of each edge, in cube-local [0,1] coordinates. Table build only. */
const EDGE_MIDPOINT = EDGE_CORNERS.map(([a, b]) => [
  (CORNER_OFFSET[a][0] + CORNER_OFFSET[b][0]) * 0.5,
  (CORNER_OFFSET[a][1] + CORNER_OFFSET[b][1]) * 0.5,
  (CORNER_OFFSET[a][2] + CORNER_OFFSET[b][2]) * 0.5,
]);

// ===========================================================================
// Marching cubes: table construction
// ===========================================================================
//
// The 256-row triangle table is BUILT, not transcribed, and then verified. Four
// thousand hand-typed indices is four thousand chances to put a hole in the
// world, and a hole in a cave roof is not a cosmetic bug - the player falls
// through it. What is built here is the complete table: all 256 rows, up to five
// triangles each, terminated by -1. DESIGN/02 8.6 specifies exactly this
// (generate at module init, verify against a checksum literal, no data files).
//
// THE CONSTRUCTION, and why it is watertight by argument rather than by luck:
//
//   1. An edge CROSSES when its two corners have different signs. The surface
//      meets the cube's boundary only on crossing edges.
//   2. On each FACE, the crossing edges number 0, 2 or 4. Two crossings give one
//      segment; four give two segments (see the pairing rule below).
//   3. Every crossing edge is shared by exactly TWO faces, so every crossing
//      point is an endpoint of exactly two segments. The segments therefore
//      close up into disjoint cycles with no free ends - always, for all 256
//      configurations.
//   4. Each segment is oriented so the SOLID side is on its right when the
//      face's outward normal is up. That makes the cycles coherently wound and
//      their fan triangulation face out of the rock.
//   5. Two cubes sharing a face see the SAME four corner values, so they make
//      the same segment decisions and produce the same boundary curve on that
//      face - traversed in opposite directions, because their outward normals
//      are opposite. That is exactly the condition for the two surface patches
//      to join without a crack.
//
// Step 5 is the reason the ambiguous-face rule may look at the four face values
// but nothing else: a decision that used the cube's other four corners would
// differ between the two cubes and tear the mesh open.

/** Number of crossing edges per configuration, and their bitmask. */
export const MC_EDGE_TABLE = new Uint16Array(256);
/** 256 x 16 int8: triangle strips as edge indices, -1 terminated. */
export const MC_TRI_TABLE = new Int8Array(256 * 16).fill(-1);
/** Per configuration, a 6-bit mask of which faces are sign-ambiguous. */
const MC_AMBIGUOUS_FACES = new Uint8Array(256);

// Scratch for the cycle construction. Module scope because it is used both at
// table-build time and on the runtime decider path, and neither may allocate.
const _segEnd = new Int32Array(12);        // per segment: the edge it enters
const _outSegment = new Int32Array(12);    // per edge: the segment leaving it
const _loop = new Int32Array(12);
const _traced = new Uint8Array(12);
const _v3a = [0, 0, 0];
const _v3b = [0, 0, 0];

/** Is corner `c` solid in configuration `config`? */
const isSolid = (config, c) => (config & (1 << c)) !== 0;

/**
 * True when face `f` of `config` has alternating corner signs, which is the
 * configuration whose triangulation is not determined by the signs alone.
 */
function faceIsAmbiguous(config, f) {
  const c = FACE_CORNERS[f];
  const s0 = isSolid(config, c[0]);
  return s0 === isSolid(config, c[2]) && s0 !== isSolid(config, c[1]) &&
         isSolid(config, c[1]) === isSolid(config, c[3]);
}

/**
 * Orient one face segment so the solid side lies to its right, and return
 * [from, to] as edge indices. `slotA`/`slotB` are face-edge slots (0..3).
 *
 * Two cases, and they cover every possible segment because a segment joins two
 * of a face's four edges: ADJACENT slots cut off the single corner between them,
 * OPPOSITE slots split the face two-and-two.
 */
function orientSegment(config, f, slotA, slotB, out) {
  const corners = FACE_CORNERS[f];
  const edges = FACE_EDGES[f];
  const n = FACE_NORMAL[f];
  const eA = edges[slotA];
  const eB = edges[slotB];

  // Provisional direction A -> B, then decide whether to keep it.
  const pA = EDGE_MIDPOINT[eA];
  const pB = EDGE_MIDPOINT[eB];
  const tx = pB[0] - pA[0], ty = pB[1] - pA[1], tz = pB[2] - pA[2];
  // "Left of the direction of travel", in the face plane.
  const lx = n[1] * tz - n[2] * ty;
  const ly = n[2] * tx - n[0] * tz;
  const lz = n[0] * ty - n[1] * tx;

  // Direction that must end up on the LEFT: toward the open side.
  let ox = 0, oy = 0, oz = 0;
  const adjacent = ((slotA + 1) & 3) === slotB || ((slotB + 1) & 3) === slotA;
  if (adjacent) {
    // The isolated corner is the one both slots touch.
    const shared = ((slotA + 1) & 3) === slotB ? corners[slotB] : corners[slotA];
    const p = CORNER_OFFSET[shared];
    // Away from the corner if it is solid, toward it if it is open.
    const s = isSolid(config, shared) ? 1 : -1;
    ox = (0.5 - p[0]) * s;
    oy = (0.5 - p[1]) * s;
    oz = (0.5 - p[2]) * s;
  } else {
    // Opposite slots: two corners each side. Point toward the open pair.
    for (let i = 0; i < 4; i++) {
      const p = CORNER_OFFSET[corners[i]];
      const s = isSolid(config, corners[i]) ? -1 : 1;
      ox += s * (p[0] - 0.5);
      oy += s * (p[1] - 0.5);
      oz += s * (p[2] - 0.5);
    }
  }

  if (lx * ox + ly * oy + lz * oz >= 0) { out[0] = eA; out[1] = eB; }
  else { out[0] = eB; out[1] = eA; }
  return out;
}

const _seg2 = [0, 0];

/**
 * Build the triangle list for one configuration into `out` (edge indices,
 * groups of three), and return the number of indices written.
 *
 * `isolate` is a per-face override for the ambiguous case: `isolate[f]` is the
 * face-corner SLOT whose corner is cut off on its own, or -1 for the default
 * rule. The default isolates the SOLID diagonal, which is the classic marching
 * cubes convention and the one the base tables have used since 1987.
 */
function buildConfigTriangles(config, isolate, out) {
  _outSegment.fill(-1);
  let segCount = 0;

  for (let f = 0; f < 6; f++) {
    const edges = FACE_EDGES[f];
    const corners = FACE_CORNERS[f];
    // Crossing slots, in cyclic order.
    let nCross = 0;
    let s0 = -1, s1 = -1, s2 = -1, s3 = -1;
    for (let s = 0; s < 4; s++) {
      const c = corners[s], d = corners[(s + 1) & 3];
      if (isSolid(config, c) !== isSolid(config, d)) {
        if (nCross === 0) s0 = s; else if (nCross === 1) s1 = s;
        else if (nCross === 2) s2 = s; else s3 = s;
        nCross++;
      }
    }
    if (nCross === 0) continue;
    if (nCross === 2) {
      orientSegment(config, f, s0, s1, _seg2);
      _segEnd[segCount] = _seg2[1];
      _outSegment[_seg2[0]] = segCount;
      segCount++;
      continue;
    }
    // nCross === 4: alternating signs. Slots are 0,1,2,3. Pairing {0,1},{2,3}
    // isolates corners[1] and corners[3]; pairing {1,2},{3,0} isolates
    // corners[2] and corners[0].
    let cut = isolate[f];
    if (cut < 0) cut = isSolid(config, corners[0]) ? 0 : 1;
    if ((cut & 1) === 1) {
      // isolate corners[1] and corners[3]
      orientSegment(config, f, 0, 1, _seg2);
      _segEnd[segCount] = _seg2[1];
      _outSegment[_seg2[0]] = segCount; segCount++;
      orientSegment(config, f, 2, 3, _seg2);
      _segEnd[segCount] = _seg2[1];
      _outSegment[_seg2[0]] = segCount; segCount++;
    } else {
      // isolate corners[0] and corners[2]
      orientSegment(config, f, 3, 0, _seg2);
      _segEnd[segCount] = _seg2[1];
      _outSegment[_seg2[0]] = segCount; segCount++;
      orientSegment(config, f, 1, 2, _seg2);
      _segEnd[segCount] = _seg2[1];
      _outSegment[_seg2[0]] = segCount; segCount++;
    }
  }

  // Trace the cycles. Every crossing edge has exactly one segment leaving it and
  // one entering it (step 3 above), so following `_outSegment` from any edge
  // returns to that edge and each segment is consumed exactly once.
  let written = 0;
  _traced.fill(0);
  for (let e = 0; e < 12; e++) {
    if (_outSegment[e] < 0 || _traced[e]) continue;
    let len = 0;
    let cur = e;
    do {
      _loop[len++] = cur;
      _traced[cur] = 1;
      cur = _segEnd[_outSegment[cur]];
    } while (cur !== e && len < 12);
    for (let i = 1; i < len - 1; i++) {
      out[written++] = _loop[0];
      out[written++] = _loop[i];
      out[written++] = _loop[i + 1];
    }
  }
  return written;
}

/** FNV-1a over the built tables. A refactor that perturbs them fails loudly. */
function tableChecksum() {
  let h = 0x811c9dc5;
  for (let i = 0; i < 256; i++) {
    h = Math.imul(h ^ (MC_EDGE_TABLE[i] & 0xff), 0x01000193) >>> 0;
    h = Math.imul(h ^ ((MC_EDGE_TABLE[i] >>> 8) & 0xff), 0x01000193) >>> 0;
  }
  for (let i = 0; i < 256 * 16; i++) {
    h = Math.imul(h ^ (MC_TRI_TABLE[i] & 0xff), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Checksum of the generated tables. Verified at module init; a mismatch throws
 * rather than shipping a world with holes in it.
 */
export const MC_TABLE_CHECKSUM = 0x2bdf9a50;

const _buildScratch = new Int32Array(48);
const _noIsolate = new Int32Array(6).fill(-1);

(function buildTables() {
  for (let config = 0; config < 256; config++) {
    let mask = 0;
    for (let e = 0; e < 12; e++) {
      const [a, b] = EDGE_CORNERS[e];
      if (isSolid(config, a) !== isSolid(config, b)) mask |= 1 << e;
    }
    MC_EDGE_TABLE[config] = mask;

    let amb = 0;
    for (let f = 0; f < 6; f++) if (faceIsAmbiguous(config, f)) amb |= 1 << f;
    MC_AMBIGUOUS_FACES[config] = amb;

    const n = buildConfigTriangles(config, _noIsolate, _buildScratch);
    if (n > 15) {
      throw new Error(`marching cubes config ${config} needs ${n / 3} triangles; the table holds 5`);
    }
    for (let i = 0; i < n; i++) MC_TRI_TABLE[config * 16 + i] = _buildScratch[i];
    // Self-check: the empty and full configurations must be empty, and every
    // emitted index must be an edge that actually crosses.
    if ((config === 0 || config === 255) && n !== 0) {
      throw new Error(`marching cubes config ${config} must be empty`);
    }
    for (let i = 0; i < n; i++) {
      if ((mask & (1 << _buildScratch[i])) === 0) {
        throw new Error(`marching cubes config ${config} uses non-crossing edge ${_buildScratch[i]}`);
      }
    }
  }
  const sum = tableChecksum();
  if (sum !== MC_TABLE_CHECKSUM) {
    throw new Error(`marching cubes table checksum ${'0x' + sum.toString(16)} != expected ` +
                    `${'0x' + MC_TABLE_CHECKSUM.toString(16)}`);
  }
})();

// ===========================================================================
// Marching cubes: the mesher
// ===========================================================================

/**
 * Edge-keyed vertex map, as a directly-indexed array rather than a hash.
 *
 * Every marching cubes vertex lives on one LATTICE EDGE, identified by the
 * sample it starts from plus an axis, so `(sampleIndex * 3 + axis)` is a perfect
 * hash of the vertex identity - no buckets, no probing, no collisions, and the
 * weld is exact by construction rather than by tolerance. Two cubes that share
 * an edge look up the same slot and get the same vertex, which is what makes the
 * output an indexed manifold instead of a triangle soup.
 *
 * Grown on demand and reused across calls; -1 means "not yet created".
 */
let _edgeVertex = new Int32Array(0);

/** Which lattice edge (axis, and the offset of its start sample) each cube edge is. */
const CUBE_EDGE_LATTICE = [
  [0, 0, 0, 0], [2, 1, 0, 0], [0, 0, 0, 1], [2, 0, 0, 0],
  [0, 0, 1, 0], [2, 1, 1, 0], [0, 0, 1, 1], [2, 0, 1, 0],
  [1, 0, 0, 0], [1, 1, 0, 0], [1, 1, 0, 1], [1, 0, 0, 1],
];

/** Growable f32 output buffer. */
function growF32(buf, needed) {
  if (buf.length >= needed) return buf;
  let n = Math.max(1024, buf.length * 2);
  while (n < needed) n *= 2;
  const next = new Float32Array(n);
  next.set(buf);
  return next;
}

function growU32(buf, needed) {
  if (buf.length >= needed) return buf;
  let n = Math.max(1024, buf.length * 2);
  while (n < needed) n *= 2;
  const next = new Uint32Array(n);
  next.set(buf);
  return next;
}

let _outPos = new Float32Array(0);
let _outNrm = new Float32Array(0);
let _outIdx = new Uint32Array(0);

/**
 * Marching cubes over a regular scalar lattice.
 *
 * @param {Float32Array} field  nx*ny*nz samples, indexed ((k*ny)+j)*nx + i with
 *   i along +X, j along +Y, k along +Z. NEGATIVE is inside (solid).
 * @param {number[]|Int32Array} dims [nx, ny, nz] sample counts, each >= 2.
 * @param {number} cellSize metres between samples (uniform on all three axes).
 * @param {number[]|Float32Array} origin world position of sample (0,0,0).
 * @param {number} [isoLevel] the level set to extract. 0 for a signed field.
 * @returns {{positions:Float32Array, normals:Float32Array, indices:Uint32Array,
 *            vertexCount:number, indexCount:number, triangleCount:number,
 *            bounds:{min:number[], max:number[]}}|null}
 *   null when the lattice contains no iso-surface at all.
 *
 * Vertices are placed by LINEAR INTERPOLATION along the edge, `t = (iso - f0) /
 * (f1 - f0)`, never at the midpoint: a midpoint mesh quantises every surface to
 * the half-cell lattice, which on a 1 m voxel grid turns a smooth cave wall into
 * a staircase whose facets are larger than the player.
 *
 * Normals come from the lattice gradient, interpolated along the same edge with
 * the same `t`. That is deliberate rather than a compromise: sampling the field
 * function six more times per vertex would multiply the cost of the whole
 * volumetric pass by an order of magnitude, and because both cubes sharing an
 * edge compute the identical value, the welded vertex gets one normal and the
 * shading is continuous across every cube and every chunk boundary.
 */
export function marchingCubes(field, dims, cellSize, origin, isoLevel = 0) {
  const nx = dims[0] | 0, ny = dims[1] | 0, nz = dims[2] | 0;
  if (nx < 2 || ny < 2 || nz < 2) return null;
  const sampleCount = nx * ny * nz;
  if (field.length < sampleCount) {
    throw new Error(`marchingCubes: field has ${field.length} samples, needs ${sampleCount}`);
  }

  const strideY = nx;
  const strideZ = nx * ny;
  const at = (i, j, k) => field[k * strideZ + j * strideY + i];

  // Reset the weld map. fill() on a 500 KB typed array is a memset; a Map would
  // cost an allocation per vertex and a hash per lookup.
  const slots = sampleCount * 3;
  if (_edgeVertex.length < slots) _edgeVertex = new Int32Array(slots);
  _edgeVertex.fill(-1, 0, slots);

  let vertexCount = 0;
  let indexCount = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  const ox = origin[0], oy = origin[1], oz = origin[2];

  // Central-difference gradient at a lattice sample, one-sided at the border.
  // Returned in FIELD UNITS PER METRE, so the normal is the true field gradient.
  const gradient = (i, j, k, out) => {
    const i0 = i > 0 ? i - 1 : i, i1 = i < nx - 1 ? i + 1 : i;
    const j0 = j > 0 ? j - 1 : j, j1 = j < ny - 1 ? j + 1 : j;
    const k0 = k > 0 ? k - 1 : k, k1 = k < nz - 1 ? k + 1 : k;
    out[0] = (at(i1, j, k) - at(i0, j, k)) / ((i1 - i0) * cellSize);
    out[1] = (at(i, j1, k) - at(i, j0, k)) / ((j1 - j0) * cellSize);
    out[2] = (at(i, j, k1) - at(i, j, k0)) / ((k1 - k0) * cellSize);
    return out;
  };

  const cornerValue = new Float64Array(8);
  const cornerI = new Int32Array(8);
  const cornerJ = new Int32Array(8);
  const cornerK = new Int32Array(8);
  const triScratch = new Int32Array(48);
  const isolate = new Int32Array(6);

  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let config = 0;
        for (let c = 0; c < 8; c++) {
          const ci = i + CORNER_OFFSET[c][0];
          const cj = j + CORNER_OFFSET[c][1];
          const ck = k + CORNER_OFFSET[c][2];
          cornerI[c] = ci; cornerJ[c] = cj; cornerK[c] = ck;
          const v = at(ci, cj, ck) - isoLevel;
          cornerValue[c] = v;
          if (v < 0) config |= 1 << c;
        }
        if (config === 0 || config === 255) continue;

        // Triangulation. The static table covers every configuration whose
        // faces are unambiguous, which is the overwhelming majority of cubes;
        // where a face has alternating signs the ASYMPTOTIC DECIDER resolves it
        // from the four face VALUES and the same cycle construction is run
        // directly. Both cubes sharing that face see the same four values, so
        // they reach the same decision and the mesh stays closed. Resolving it
        // from the signs alone (which is all a table can see) is what leaves
        // pinholes where two tunnels graze each other.
        let triCount = 0;
        let tris = null;
        let triBase = 0;
        const amb = MC_AMBIGUOUS_FACES[config];
        if (amb === 0) {
          tris = MC_TRI_TABLE;
          triBase = config * 16;
          while (triCount < 16 && MC_TRI_TABLE[triBase + triCount] >= 0) triCount++;
        } else {
          for (let f = 0; f < 6; f++) {
            if ((amb & (1 << f)) === 0) { isolate[f] = -1; continue; }
            const fc = FACE_CORNERS[f];
            const f00 = cornerValue[fc[0]], f10 = cornerValue[fc[1]];
            const f11 = cornerValue[fc[2]], f01 = cornerValue[fc[3]];
            const den = f00 + f11 - f10 - f01;
            if (Math.abs(den) < 1e-12) { isolate[f] = -1; continue; }
            // Saddle value of the bilinear patch. When it carries the sign of
            // the (c0, c2) diagonal, that diagonal is CONNECTED through the
            // face, so the other pair is what gets cut off.
            const s = (f00 * f11 - f10 * f01) / den;
            isolate[f] = (s * f00 > 0) ? 1 : 0;
          }
          triCount = buildConfigTriangles(config, isolate, triScratch);
          tris = triScratch;
          triBase = 0;
        }

        for (let t = 0; t < triCount; t++) {
          const e = tris[triBase + t];
          const lat = CUBE_EDGE_LATTICE[e];
          const axis = lat[0];
          const si = i + lat[1], sj = j + lat[2], sk = k + lat[3];
          const slot = (sk * strideZ + sj * strideY + si) * 3 + axis;
          let vi = _edgeVertex[slot];
          if (vi < 0) {
            const [ca, cb] = EDGE_CORNERS[e];
            const v0 = cornerValue[ca], v1 = cornerValue[cb];
            // Clamped away from the endpoints: a vertex exactly on a lattice
            // sample makes degenerate triangles in the neighbouring cube, and a
            // zero-area triangle has no normal.
            const denom = v1 - v0;
            const tt = clamp(Math.abs(denom) > 1e-20 ? -v0 / denom : 0.5, 0.001, 0.999);

            const ai = cornerI[ca], aj = cornerJ[ca], ak = cornerK[ca];
            const bi = cornerI[cb], bj = cornerJ[cb], bk = cornerK[cb];
            const px = ox + (ai + (bi - ai) * tt) * cellSize;
            const py = oy + (aj + (bj - aj) * tt) * cellSize;
            const pz = oz + (ak + (bk - ak) * tt) * cellSize;

            gradient(ai, aj, ak, _v3a);
            gradient(bi, bj, bk, _v3b);
            let gx = _v3a[0] + (_v3b[0] - _v3a[0]) * tt;
            let gy = _v3a[1] + (_v3b[1] - _v3a[1]) * tt;
            let gz = _v3a[2] + (_v3b[2] - _v3a[2]) * tt;
            const gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
            if (gl > 1e-12) { gx /= gl; gy /= gl; gz /= gl; }
            else { gx = 0; gy = 1; gz = 0; }

            vi = vertexCount++;
            _outPos = growF32(_outPos, vertexCount * 3);
            _outNrm = growF32(_outNrm, vertexCount * 3);
            _outPos[vi * 3] = px; _outPos[vi * 3 + 1] = py; _outPos[vi * 3 + 2] = pz;
            // The field grows toward OPEN, so its gradient already points out
            // of the rock - no negation, and it agrees with the triangle winding.
            _outNrm[vi * 3] = gx; _outNrm[vi * 3 + 1] = gy; _outNrm[vi * 3 + 2] = gz;
            _edgeVertex[slot] = vi;

            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
            if (pz < minZ) minZ = pz;
            if (pz > maxZ) maxZ = pz;
          }
          _outIdx = growU32(_outIdx, indexCount + 1);
          _outIdx[indexCount++] = vi;
        }
      }
    }
  }

  if (vertexCount === 0 || indexCount === 0) return null;

  return {
    positions: _outPos.slice(0, vertexCount * 3),
    normals: _outNrm.slice(0, vertexCount * 3),
    indices: _outIdx.slice(0, indexCount),
    vertexCount,
    indexCount,
    triangleCount: indexCount / 3,
    bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
}

// ===========================================================================
// Cave field: tuning
// ===========================================================================

/** Volumetric chunk footprint and sample count, from the binding constants. */
export const CAVE_CHUNK_SIZE = WORLD.CAVE_CHUNK_SIZE;      // 32 m
export const CAVE_RESOLUTION = WORLD.CAVE_RESOLUTION;      // 33 samples
/** Metres between samples. Exactly 1.0, which is what keeps the lattice integral. */
export const CAVE_CELL = CAVE_CHUNK_SIZE / (CAVE_RESOLUTION - 1);
/**
 * Overlap skirt, in CELLS, on every face. The field is sampled over
 * 32 + 2 = 34 m so neighbouring chunks share a full cell of geometry rather than
 * meeting exactly at a plane: an exact plane meeting is watertight in theory and
 * shows a hairline of background through it in practice, because the two chunks
 * are rasterised with different depth-slope biases.
 */
export const CAVE_SKIRT = 1;
/** Samples along each axis of one chunk's lattice, skirt included. */
export const CAVE_LATTICE = CAVE_RESOLUTION + 2 * CAVE_SKIRT;   // 35

/** Macro cell for the tunnel graph, metres. Cubic - see REACH below. */
const MACRO = 512;
/**
 * Hard cap on how far any capsule of a macro cell's graph can get from that
 * cell, metres. Because REACH < MACRO, a query point only ever needs the 3x3x3
 * macro cells around it: a cell two steps away has its expanded box ending
 * 128 m short of the query point's own cell. The integrator enforces this by
 * truncating any walk that would leave the expanded box, so the bound is
 * structural rather than statistical.
 */
const REACH = 384;
/** Metres per integration step, and the resulting cap on capsules per walk. */
const STEP = 12;
const MAX_STEPS = Math.floor(REACH / STEP);
/** Maximum turn per step, radians, and the branch recursion depth. */
const TURN = 0.11;
const MAX_BRANCH_DEPTH = 2;
const BRANCH_PROB = 0.14;
/** Tunnels per macro cell, hard cap. */
const MAX_TUNNELS_PER_CELL = 4;

/**
 * No cave geometry at all within this radius of the world axis. The starting
 * crater is a promise (WORLD.SAFE_CRATER_RADIUS / SAFE_FALLOFF_RADIUS), and a
 * flooded tunnel opening into the lagoon is exactly the kind of thing a player
 * swims into in the first two minutes and drowns in. Enforced at graph build
 * time, on the capsule, so it costs nothing per sample.
 */
const NO_CAVE_RADIUS = 520;
/** NO_CAVE_RADIUS, exported for cheap early-outs (collision's carve gates fire
 *  on every grounded substep, and inside this radius the answer is always no). */
export const CAVE_SAFE_RADIUS = NO_CAVE_RADIUS;

/** Wall perturbation: amplitude in metres, frequency, octaves (DESIGN/02 N18). */
const DETAIL_AMP = 2.9;
const DETAIL_FREQ = 1 / 26;
const DETAIL_OCTAVES = 4;
const DETAIL_LACUNARITY = 2.11;
const DETAIL_GAIN = 0.50;
/** Fraction of the local passage radius the perturbation may consume. */
const DETAIL_FRACTION = 0.40;

/**
 * Overhang displacement (N21). The heightfield surface is pushed out along Y by
 * up to this many metres where the mask allows, which on a 40-57 degree face
 * leans the rock out by about eight metres horizontally - genuine ledges and
 * roofs. The band mask ties the displacement to the surface so it can never
 * detach into a floating island.
 */
const OVERHANG_AMP = 12.0;
const OVERHANG_FREQ = 1 / 48;
const OVERHANG_OCTAVES = 4;
const OVERHANG_SLOPE_LO = 0.85;   // tan, 40 degrees
const OVERHANG_SLOPE_HI = 1.55;   // tan, 57 degrees
const OVERHANG_BAND_LO = 9.0;
const OVERHANG_BAND_HI = 26.0;
const OVERHANG_SEED_FREQ = 1 / 310;
const OVERHANG_SEED_LO = 0.42;
const OVERHANG_SEED_HI = 0.66;

/**
 * The fissure network: joint-controlled sheet caves.
 *
 * worley3Edge is F2 - F1, which is zero on a Voronoi FACE. Faces are
 * two-dimensional sheets in three dimensions, so thresholding this carves thin
 * SHEETS rather than tubes - which is both a real cave morphology (a fissure
 * cave following a joint set) and the cheapest possible global connectivity
 * guarantee: the Voronoi face complex is connected everywhere, so any two points
 * inside the fissure network are joined by a path that stays inside it.
 */
const FISSURE_CELL = 42;
const FISSURE_HALF_WIDTH = 0.05;   // cell units, so about 2.1 m of opening
const FISSURE_MASK_FREQ = 1 / 620;
const FISSURE_MASK_LO = 0.54;
const FISSURE_MASK_HI = 0.80;
/**
 * The fissures live in a BAND below the rock surface, in metres of depth below
 * it: fading in over [LO, HI] and out over [FAR, GONE].
 *
 * Without the band the Voronoi face complex is scale-free and riddles the entire
 * rock volume: measured before this existed, the field read OPEN 1.3 km beneath
 * the seabed and a third of all samples in the cave band were void. A joint set
 * is a near-surface feature - it is opened by unloading and by circulating water,
 * neither of which reaches the deep interior - so the band is physical as well as
 * necessary.
 */
const FISSURE_DEPTH_LO = 12;
const FISSURE_DEPTH_HI = 34;
const FISSURE_DEPTH_FAR = 230;
const FISSURE_DEPTH_GONE = 330;
/** Fissures fade in over this many metres outside NO_CAVE_RADIUS. */
const FISSURE_SAFE_FADE = 140;
/**
 * What a fully masked-out fissure field is set to, metres. Gating an SDF by
 * MULTIPLYING it by a mask is wrong and silently catastrophic: at mask 0 the
 * field becomes 0 everywhere, which is the iso-surface everywhere. Adding a
 * large positive offset closes the fissure instead, which is what "not here"
 * actually means for a signed distance.
 */
const FISSURE_CLOSED = 60;

/**
 * Per-biome cave placement, indexed by biome id (see world/biomes.js). DESIGN/02
 * table 8.1 transposed onto this world's 14 biomes - the doc describes a 16 km
 * world with 16 biomes and constants.js wins on both counts.
 *
 *   tunnels   expected root tunnels per 512 m macro cell
 *   rMin/rMax capsule radius range, metres
 *   chamber   per-step probability of an ellipsoidal chamber
 *   entrance  [min, max] metres BELOW the terrain surface that a tunnel starts
 *   grotto    probability that a tunnel is a luminous grotto
 */
const CAVE_BIOME = [
  /*  0 beach       */ { tunnels: 0.20, rMin: 1.6, rMax: 3.0, chamber: 0.03, entrance: [8, 26], grotto: 0.00 },
  /*  1 basalt      */ { tunnels: 0.45, rMin: 1.8, rMax: 3.6, chamber: 0.05, entrance: [10, 40], grotto: 0.02 },
  /*  2 reef        */ { tunnels: 0.60, rMin: 2.0, rMax: 4.2, chamber: 0.05, entrance: [6, 30], grotto: 0.02 },
  /*  3 coral       */ { tunnels: 0.70, rMin: 2.2, rMax: 4.4, chamber: 0.06, entrance: [8, 34], grotto: 0.04 },
  /*  4 sand        */ { tunnels: 0.10, rMin: 1.8, rMax: 3.0, chamber: 0.02, entrance: [10, 40], grotto: 0.00 },
  /*  5 kelp        */ { tunnels: 0.85, rMin: 2.4, rMax: 5.0, chamber: 0.07, entrance: [14, 52], grotto: 0.05 },
  /*  6 boulders    */ { tunnels: 1.45, rMin: 2.8, rMax: 6.4, chamber: 0.09, entrance: [16, 70], grotto: 0.08 },
  /*  7 break       */ { tunnels: 2.10, rMin: 3.2, rMax: 7.6, chamber: 0.12, entrance: [20, 120], grotto: 0.14 },
  /*  8 spires      */ { tunnels: 1.60, rMin: 2.6, rMax: 6.0, chamber: 0.10, entrance: [18, 90], grotto: 0.10 },
  /*  9 terrace     */ { tunnels: 0.55, rMin: 2.6, rMax: 5.2, chamber: 0.06, entrance: [20, 95], grotto: 0.16 },
  /* 10 canyon      */ { tunnels: 1.70, rMin: 3.0, rMax: 6.8, chamber: 0.11, entrance: [22, 130], grotto: 0.18 },
  /* 11 abyssal     */ { tunnels: 0.15, rMin: 2.4, rMax: 4.6, chamber: 0.04, entrance: [20, 90], grotto: 0.20 },
  /* 12 trenchWall  */ { tunnels: 2.40, rMin: 3.6, rMax: 8.0, chamber: 0.16, entrance: [26, 140], grotto: 0.42 },
  /* 13 trenchFloor */ { tunnels: 0.55, rMin: 3.0, rMax: 7.0, chamber: 0.09, entrance: [24, 120], grotto: 0.48 },
];

/** Vertex material classes the cave mesher emits. */
export const CAVE_MATERIAL = {
  /** Dry-looking bare rock: the default cave wall. */
  INTERIOR: 0,
  /** Bioluminescent grotto wall or ceiling; the render pass makes these emit. */
  GROTTO: 1,
  /** Within 1.5 m of the heightfield surface, so it blends into its biome. */
  MOUTH: 2,
};

/** Salts. Never renumber: doing so changes every existing world. */
const SALT = {
  GRAPH: 0x00020001,
  DETAIL: 0x00020002,
  CHAMBER: 0x00020003,
  OVERHANG: 0x00020004,
  FISSURE: 0x00020005,
  RADIUS: 0x00020006,
};

let _seedSource = -1;
let _seedOverride = -1;
const S = {};

function deriveSeeds(seed) {
  _seedSource = seed >>> 0;
  for (const k of Object.keys(SALT)) S[k] = hashU32(_seedSource ^ SALT[k]) >>> 8;
  clearCaveCache();
  return _seedSource;
}

/**
 * Pin the cave seed, independently of the terrain's.
 *
 * Normally there is no need to call this: every public entry point checks
 * terrain.getSeed() and re-derives if it changed, so the caves always follow the
 * terrain they are cut into. Pinning exists for tests that sweep cave seeds over
 * one fixed terrain - the two are separable because the terrain term of the field
 * reads H() rather than any cave seed.
 *
 * @param {number|null} seed a u32 to pin, or null to go back to following the
 *   terrain seed.
 */
export function setCaveSeed(seed) {
  if (seed === null || seed === undefined) {
    _seedOverride = -1;
    return deriveSeeds(getSeed());
  }
  _seedOverride = seed >>> 0;
  return deriveSeeds(_seedOverride);
}

function ensureSeed() {
  const s = _seedOverride >= 0 ? _seedOverride : getSeed();
  if (s !== _seedSource) deriveSeeds(s);
}

// ===========================================================================
// The tunnel graph
// ===========================================================================
//
// CONNECTIVITY - the approach, stated explicitly because "noise that happens to
// join up" is the classic way to ship a cave system the player cannot navigate.
//
// 1. WITHIN A TUNNEL: a tunnel is an integrated WALK, emitted as a chain of
//    capsules where capsule i+1 starts exactly where capsule i ended and with
//    exactly the radius it ended at. The union of a chain of capsules sharing
//    endpoints is connected - there is no gap to fall through and no threshold
//    to tune. Connectivity is a property of the data structure, not of the noise.
//
// 2. BRANCHES: a child walk starts AT a point on its parent's walk, with the
//    parent's local radius. It is therefore connected to the parent at birth.
//    Recursion is bounded at MAX_BRANCH_DEPTH, so a tunnel tree stays a tree.
//
// 3. CHAMBERS: an ellipsoid is centred ON the walk with every semi-axis at
//    least the local tunnel radius, so it always swallows the capsule it grew
//    from and can never be a sealed bubble.
//
// 4. ENTRANCES: every ROOT tunnel is prefixed with a MOUTH capsule running from
//    just above the terrain surface down to the tunnel's first point. Because
//    the field takes max(terrain, cave), a capsule whose axis rises above H
//    opens into open water. So every tunnel tree is reachable from outside -
//    which is the property that actually matters to a player, and it is
//    guaranteed rather than hoped for.
//
// 5. BETWEEN TUNNEL TREES: deliberately NOT guaranteed. A world where every void
//    connects to every other void is a maze, not a cave system; separate systems
//    with separate mouths are what make exploration legible. What IS globally
//    connected is the fissure network (see FISSURE_CELL), whose Voronoi-face
//    topology is connected by construction wherever its mask is open - so the
//    deep biomes that switch it on get a capillary system linking their chambers
//    without the trunk routes losing their identity.

/** One macro cell's graph. Struct-of-arrays; min() over it is order-independent. */
function makeGraph() {
  return {
    capCount: 0,
    /** Capsule endpoints and radii: a[i*3..], b[i*3..], ra[i], rb[i]. */
    ca: new Float64Array(0), cb: new Float64Array(0),
    cra: new Float64Array(0), crb: new Float64Array(0),
    cflags: new Uint8Array(0),
    chamberCount: 0,
    /** Ellipsoid centres and semi-axes. */
    ec: new Float64Array(0), er: new Float64Array(0),
    eflags: new Uint8Array(0),
    /** Root tunnel MOUTHS: the first point of each accepted root walk, which the
     *  mouth capsule joins to open water. Consumed by the debug skeleton view
     *  and by the connectivity test - see the connectivity note above. */
    mouthCount: 0,
    mouths: new Float64Array(MAX_TUNNELS_PER_CELL * 3),
    /** Radius of each mouth capsule at its TOP (rBase * 0.80), metres. The
     *  streaming layer sizes the terrain suppression disc from this, so it is
     *  recorded here rather than re-derived from the capsule list. */
    mouthRadius: new Float64Array(MAX_TUNNELS_PER_CELL),
    /** AABB of everything in the cell, radii included. */
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
}

const FLAG_GROTTO = 1;
/** Primitive came from world/cave_sites.js, not a procedural walk. The mesher
 *  reads it through mesh.authored (see generateCaveChunk) rather than through
 *  this flag directly, but keeping it on the record makes the provenance
 *  greppable in a skeleton dump. */
const FLAG_AUTHORED = 2;

/** Grow a struct-of-arrays graph in place. */
function reserveCapsules(g, n) {
  if (g.ca.length >= n * 3) return;
  let cap = Math.max(64, g.ca.length / 3 || 0);
  while (cap < n) cap *= 2;
  const ca = new Float64Array(cap * 3); ca.set(g.ca); g.ca = ca;
  const cb = new Float64Array(cap * 3); cb.set(g.cb); g.cb = cb;
  const ra = new Float64Array(cap); ra.set(g.cra); g.cra = ra;
  const rb = new Float64Array(cap); rb.set(g.crb); g.crb = rb;
  const fl = new Uint8Array(cap); fl.set(g.cflags); g.cflags = fl;
}

function reserveChambers(g, n) {
  if (g.ec.length >= n * 3) return;
  let cap = Math.max(32, g.ec.length / 3 || 0);
  while (cap < n) cap *= 2;
  const ec = new Float64Array(cap * 3); ec.set(g.ec); g.ec = ec;
  const er = new Float64Array(cap * 3); er.set(g.er); g.er = er;
  const fl = new Uint8Array(cap); fl.set(g.eflags); g.eflags = fl;
}

function growBounds(g, x, y, z, r) {
  if (x - r < g.min[0]) g.min[0] = x - r;
  if (y - r < g.min[1]) g.min[1] = y - r;
  if (z - r < g.min[2]) g.min[2] = z - r;
  if (x + r > g.max[0]) g.max[0] = x + r;
  if (y + r > g.max[1]) g.max[1] = y + r;
  if (z + r > g.max[2]) g.max[2] = z + r;
}

/**
 * Closest approach of a segment to the world axis, measured in XZ. Used by the
 * safe-crater rejection, which has to be conservative about the WHOLE capsule:
 * testing only the midpoint lets a 12 m segment with an 8 m radius and a 2.9 m
 * perturbation reach 17 m past the line it was supposed to respect, and 390 of
 * 6000 probe columns under the lagoon found cave that way.
 */
function segmentAxisDistanceXZ(ax, az, bx, bz) {
  const ex = bx - ax, ez = bz - az;
  const ee = ex * ex + ez * ez;
  const t = ee > 1e-12 ? clamp(-(ax * ex + az * ez) / ee, 0, 1) : 0;
  return Math.hypot(ax + ex * t, az + ez * t);
}

/** @returns {boolean} false when the capsule was rejected by the safe crater. */
function addCapsule(g, ax, ay, az, ra, bx, by, bz, rb, flags) {
  // Start-zone suppression, before anything else touches this capsule.
  const clearance = Math.max(ra, rb) + DETAIL_AMP;
  if (segmentAxisDistanceXZ(ax, az, bx, bz) < NO_CAVE_RADIUS + clearance) return false;
  const i = g.capCount++;
  reserveCapsules(g, g.capCount);
  g.ca[i * 3] = ax; g.ca[i * 3 + 1] = ay; g.ca[i * 3 + 2] = az;
  g.cb[i * 3] = bx; g.cb[i * 3 + 1] = by; g.cb[i * 3 + 2] = bz;
  g.cra[i] = ra; g.crb[i] = rb;
  g.cflags[i] = flags;
  growBounds(g, ax, ay, az, ra + DETAIL_AMP);
  growBounds(g, bx, by, bz, rb + DETAIL_AMP);
  return true;
}

/**
 * Append a mouth record, growing the fixed-capacity arrays if needed. The
 * procedural walks never exceed MAX_TUNNELS_PER_CELL mouths, but an authored
 * site adds its mouth ON TOP of whatever the cell already carries, so the
 * makeGraph() allocation is a starting size here, not a cap.
 */
function appendMouth(g, x, y, z, topR) {
  const n = g.mouthCount;
  if ((n + 1) * 3 > g.mouths.length) {
    const m = new Float64Array((n + 1) * 3); m.set(g.mouths); g.mouths = m;
    const mr = new Float64Array(n + 1); mr.set(g.mouthRadius); g.mouthRadius = mr;
  }
  g.mouths[n * 3] = x; g.mouths[n * 3 + 1] = y; g.mouths[n * 3 + 2] = z;
  g.mouthRadius[n] = topR;
  g.mouthCount = n + 1;
}

function addChamber(g, cx, cy, cz, rx, ry, rz, flags) {
  if (Math.hypot(cx, cz) < NO_CAVE_RADIUS + Math.max(rx, rz) + DETAIL_AMP) return;
  const i = g.chamberCount++;
  reserveChambers(g, g.chamberCount);
  g.ec[i * 3] = cx; g.ec[i * 3 + 1] = cy; g.ec[i * 3 + 2] = cz;
  g.er[i * 3] = rx; g.er[i * 3 + 1] = ry; g.er[i * 3 + 2] = rz;
  g.eflags[i] = flags;
  growBounds(g, cx, cy, cz, Math.max(rx, ry, rz) + DETAIL_AMP);
}

/** Deterministic [0,1) from an integer tuple. No stateful RNG anywhere here. */
const u01 = (h) => (h >>> 0) / 4294967296;
function h3(seed, a, b, c) {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (a | 0), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (b | 0), 0xc2b2ae35) >>> 0;
  h = Math.imul(h ^ (c | 0), 0x27d4eb2f) >>> 0;
  return hashU32(h);
}

/** Uniform direction on the sphere from two hash draws. */
function hashDirection(out, h1, h2) {
  const cosPhi = u01(h1) * 2 - 1;
  const theta = u01(h2) * Math.PI * 2;
  const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
  out[0] = sinPhi * Math.cos(theta);
  out[1] = cosPhi;
  out[2] = sinPhi * Math.sin(theta);
  return out;
}

const _dir = vec3.create();
const _turn = vec3.create();
const _pos = vec3.create();

/**
 * Build the graph for one macro cell. A pure function of (seed, cell address):
 * no iteration order dependence, no neighbour state, so two workers building the
 * same cell get the same capsules.
 */
function buildMacroGraph(mx, my, mz) {
  const g = makeGraph();
  const x0 = mx * MACRO, y0 = my * MACRO, z0 = mz * MACRO;
  const seedC = h3(S.GRAPH, mx, my, mz);

  // Expanded box the walks are truncated to; this is what makes REACH structural.
  const bx0 = x0 - REACH, bx1 = x0 + MACRO + REACH;
  const by0 = y0 - REACH, by1 = y0 + MACRO + REACH;
  const bz0 = z0 - REACH, bz1 = z0 + MACRO + REACH;

  // The whole cell can be rejected when it is entirely outside the cave band.
  if (y0 + MACRO < WORLD.CAVE_MIN_Y || y0 > WORLD.CAVE_MAX_Y) return g;

  // Root tunnels. Each is anchored to the terrain: pick an XZ inside the cell,
  // then start at a biome-appropriate depth BELOW the surface there. A start
  // that lands outside this cell's Y range belongs to the macro cell that does
  // contain it, so it is skipped here - which is what keeps a tunnel owned by
  // exactly one cell however the terrain moves.
  const pending = [];
  for (let t = 0; t < MAX_TUNNELS_PER_CELL; t++) {
    const s = h3(seedC ^ 0x1000, t, 0, 0);
    const sx = x0 + u01(h3(s, 1, 0, 0)) * MACRO;
    const sz = z0 + u01(h3(s, 2, 0, 0)) * MACRO;
    const r = Math.hypot(sx, sz);
    if (r > WORLD.HARD_BOUNDARY) continue;

    const surface = sampleHeight(sx, sz);
    const biome = biomeAt(sx, sz, surface, 0);
    // Ossuary Flats (id 14, added by P4-C) has no CAVE_BIOME row, so its
    // columns take the BEACH fallback (tunnels 0.20, entrance 8-26 m) - an
    // unstated cross-track default until the P4 review named it. Kept as the
    // fallback ON PURPOSE rather than given its own row: a bone plain over
    // gentle karst is coherent, and authoring cave parameters for it belongs
    // with whoever gives the ossuary underworld a design, not with a review
    // fix. This comment is the "stated" part.
    // Crimson Meadow (id 15) likewise has no CAVE_BIOME row and takes the
    // same BEACH fallback ON PURPOSE: an 8-28 m sediment plateau over gentle
    // karst is coherent, and its identity lives in the scatter carpet and
    // pillars, not underground. Author a row only when someone designs a
    // meadow cave, and say why there.
    const cfg = CAVE_BIOME[biome] || CAVE_BIOME[0];
    // Reject the whole tunnel here, using the SAME conservative clearance
    // addCapsule() applies. Rejecting only the individual capsules would let a
    // tunnel that starts just outside the crater keep its walk while losing the
    // mouth capsule to the filter - which would silently break the one guarantee
    // this design makes about entrances.
    if (r < NO_CAVE_RADIUS + cfg.rMax + DETAIL_AMP + STEP) continue;

    // Expected tunnel count for this cell, resolved to an integer without a
    // stateful RNG: the whole part always, the fraction by one hash draw.
    const density = cfg.tunnels;
    const whole = Math.floor(density);
    const extra = u01(h3(seedC ^ 0xa5, t, 0, 0)) < (density - whole) ? 1 : 0;
    if (t >= Math.min(MAX_TUNNELS_PER_CELL, whole + extra)) continue;

    const below = lerp(cfg.entrance[0], cfg.entrance[1], u01(h3(s, 3, 0, 0)));
    const sy = surface - below;
    if (sy < y0 || sy >= y0 + MACRO) continue;
    if (sy < WORLD.CAVE_MIN_Y || sy > WORLD.CAVE_MAX_Y) continue;

    const rBase = lerp(cfg.rMin, cfg.rMax, u01(h3(s, 4, 0, 0)));
    const steps = Math.min(MAX_STEPS, Math.floor(lerp(180, REACH, u01(h3(s, 5, 0, 0))) / STEP));
    const flags = u01(h3(s, 6, 0, 0)) < cfg.grotto ? FLAG_GROTTO : 0;

    hashDirection(_dir, h3(s, 7, 0, 0), h3(s, 8, 0, 0));
    // Bias toward horizontal and slightly downward: a tunnel that dives is a
    // dead end the player cannot swim back out of on one tank of air.
    _dir[1] = _dir[1] * 0.45 - 0.12;
    vec3.normalize(_dir, _dir);

    // THE MOUTH. A short capsule from just above the surface down to the first
    // point, which is what guarantees this tunnel tree has an entrance.
    if (!addCapsule(g, sx, surface + rBase * 0.55, sz, rBase * 0.80,
                    sx, sy, sz, rBase, flags)) continue;
    g.mouths[g.mouthCount * 3] = sx;
    g.mouths[g.mouthCount * 3 + 1] = sy;
    g.mouths[g.mouthCount * 3 + 2] = sz;
    g.mouthRadius[g.mouthCount] = rBase * 0.80;
    g.mouthCount++;

    pending.push({
      x: sx, y: sy, z: sz,
      dx: _dir[0], dy: _dir[1], dz: _dir[2],
      rBase, steps, depth: 0, tunnel: t, chamber: cfg.chamber, flags,
    });
  }

  // Breadth-first over the walk queue. FIFO rather than recursive so the capsule
  // array comes out in a fixed order for a given cell - min() does not care, but
  // a determinism test that compares buffers does.
  for (let qi = 0; qi < pending.length; qi++) {
    const walk = pending[qi];
    vec3.set(_pos, walk.x, walk.y, walk.z);
    vec3.set(_dir, walk.dx, walk.dy, walk.dz);
    const wSeed = h3(seedC ^ 0x2000, walk.tunnel, walk.depth, qi);
    let radiusPrev = walk.rBase * radiusModulation(_pos[0], _pos[1], _pos[2]);

    for (let i = 0; i < walk.steps; i++) {
      const hs = h3(wSeed, i, 0, 0);
      // Turn. Capped at TURN radians per step so a tunnel reads as a passage
      // rather than as a tangle, and so its curvature is swimmable.
      hashDirection(_turn, h3(hs, 1, 0, 0), h3(hs, 2, 0, 0));
      _turn[1] *= 0.55;
      _dir[0] += _turn[0] * TURN;
      _dir[1] += _turn[1] * TURN;
      _dir[2] += _turn[2] * TURN;

      // Vertical bias: hug the band below the terrain surface, so a tunnel stays
      // in rock instead of surfacing or diving into the mantle.
      const surface = sampleHeight(_pos[0], _pos[2]);
      const targetY = surface - lerp(18, 130, u01(h3(hs, 3, 0, 0)));
      _dir[1] += clamp((targetY - _pos[1]) * 0.004, -0.09, 0.09);

      // Soft turn-back toward the cell centre once the walk nears the boundary
      // of its expanded box, so the hard truncation below almost never fires.
      const cxm = x0 + MACRO * 0.5, cym = y0 + MACRO * 0.5, czm = z0 + MACRO * 0.5;
      if (_pos[0] < bx0 + STEP * 4 || _pos[0] > bx1 - STEP * 4 ||
          _pos[1] < by0 + STEP * 4 || _pos[1] > by1 - STEP * 4 ||
          _pos[2] < bz0 + STEP * 4 || _pos[2] > bz1 - STEP * 4) {
        const tx = cxm - _pos[0], ty = cym - _pos[1], tz = czm - _pos[2];
        const tl = Math.hypot(tx, ty, tz) || 1;
        _dir[0] += 0.34 * tx / tl;
        _dir[1] += 0.34 * ty / tl;
        _dir[2] += 0.34 * tz / tl;
      }
      vec3.normalize(_dir, _dir);

      const nx = _pos[0] + _dir[0] * STEP;
      const ny = _pos[1] + _dir[1] * STEP;
      const nz = _pos[2] + _dir[2] * STEP;

      // Hard truncation. This is the guarantee REACH rests on, so it is a stop,
      // not a clamp: clamping would pile capsules up on the boundary plane.
      if (nx < bx0 || nx > bx1 || ny < by0 || ny > by1 || nz < bz0 || nz > bz1) break;
      if (ny < WORLD.CAVE_MIN_Y || ny > WORLD.CAVE_MAX_Y) break;
      if (nx * nx + nz * nz > WORLD.HARD_BOUNDARY * WORLD.HARD_BOUNDARY) break;

      const radius = walk.rBase * radiusModulation(nx, ny, nz);
      addCapsule(g, _pos[0], _pos[1], _pos[2], radiusPrev, nx, ny, nz, radius, walk.flags);

      // Chamber. Semi-axes are never smaller than the local tunnel radius, so
      // the ellipsoid always contains the capsule it grew from.
      if (u01(h3(seedC ^ 0x4000, walk.tunnel, i, walk.depth)) < walk.chamber) {
        const scale = lerp(1.0, 2.6, u01(h3(seedC ^ 0x4001, walk.tunnel, i, walk.depth)));
        const major = clamp(walk.rBase * 2.2 * scale, 14, 48);
        addChamber(g, nx, ny, nz,
                   Math.max(major, radius), Math.max(major * 0.64, radius),
                   Math.max(major, radius), walk.flags);
      }

      // Branch, from a point ON the parent walk with the parent's local radius.
      if (i > walk.steps * 0.25 && walk.depth < MAX_BRANCH_DEPTH &&
          u01(h3(seedC ^ 0x3000, walk.tunnel, i, walk.depth)) < BRANCH_PROB) {
        const bh = h3(seedC ^ 0x3001, walk.tunnel, i, walk.depth);
        hashDirection(_turn, h3(bh, 1, 0, 0), h3(bh, 2, 0, 0));
        // Rotate away from the parent by 0.5 to 1.1 rad by mixing in a random
        // axis; the mix weight is the sine of the intended angle.
        const w = Math.sin(lerp(0.5, 1.1, u01(h3(bh, 3, 0, 0))));
        const cdx = _dir[0] * (1 - w) + _turn[0] * w;
        const cdy = _dir[1] * (1 - w) + _turn[1] * w;
        const cdz = _dir[2] * (1 - w) + _turn[2] * w;
        const cl = Math.hypot(cdx, cdy, cdz) || 1;
        pending.push({
          x: nx, y: ny, z: nz,
          dx: cdx / cl, dy: cdy / cl, dz: cdz / cl,
          rBase: walk.rBase * 0.68,
          steps: Math.max(3, Math.floor(walk.steps * 0.55)),
          depth: walk.depth + 1,
          tunnel: walk.tunnel, chamber: walk.chamber, flags: walk.flags,
        });
      }

      vec3.set(_pos, nx, ny, nz);
      radiusPrev = radius;
    }
  }

  // ---- authored sites (world/cave_sites.js) -------------------------------
  // Merged AFTER the procedural walks so the capsule order - and therefore the
  // byte-identical determinism the worker is verified against - is stable.
  // Each site is owned by exactly ONE cell (its mouth start point's), the same
  // ownership rule the root walks use, and cave_sites throws at resolve time
  // if any primitive escapes REACH of that cell. addCapsule/addChamber apply
  // the same safe-crater rejection to authored geometry as to walks; a site
  // authored inside the crater simply does not exist, which is the promise
  // NO_CAVE_RADIUS makes.
  for (const r of resolvedCaveSites()) {
    if (r.cell[0] !== mx || r.cell[1] !== my || r.cell[2] !== mz) continue;
    if (!addCapsule(g, r.mouth.x, r.mouth.topY, r.mouth.z, r.mouth.topR,
                    r.mouth.x, r.mouth.y, r.mouth.z, r.mouth.r, FLAG_AUTHORED)) continue;
    appendMouth(g, r.mouth.x, r.mouth.y, r.mouth.z, r.mouth.topR);
    for (const c of r.capsules) {
      addCapsule(g, c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], FLAG_AUTHORED);
    }
    for (const e of r.chambers) {
      addChamber(g, e[0], e[1], e[2], e[3], e[4], e[5], FLAG_AUTHORED);
    }
  }
  return g;
}

/** Radius modulation along a walk: 0.60 to 1.00 of rBase, smooth in space. */
function radiusModulation(x, y, z) {
  return 0.60 + 0.40 * (0.5 + 0.5 * simplex3(x * 0.011, y * 0.011, z * 0.011, S.RADIUS));
}

// --- macro cell cache ------------------------------------------------------
//
// A cave chunk needs the graphs of the 27 macro cells around it, and a streaming
// front covers a handful of macro cells at a time, so a cache of 64 turns
// "rebuild 27 graphs per chunk" into "rebuild one graph occasionally".
//
// Eviction is FIFO, not LRU: a hit does not move the key to the back. That is a
// deliberate simplification, not an oversight - reordering costs an O(n) splice
// on the hot path, and with a capacity of 64 against the 27 to 45 cells one chunk
// touches, the working set fits with room to spare and the two policies evict the
// same things. The cache is also NOT load-bearing: test-caves.mjs asserts that a
// cold cache produces a bit-identical chunk, so a wrong eviction can only ever
// cost time.

const GRAPH_CACHE_CAPACITY = 64;
const _graphCache = new Map();
const _graphOrder = [];

function macroGraph(mx, my, mz) {
  const key = `${mx},${my},${mz}`;
  const hit = _graphCache.get(key);
  if (hit) return hit;
  const g = buildMacroGraph(mx, my, mz);
  _graphCache.set(key, g);
  _graphOrder.push(key);
  if (_graphOrder.length > GRAPH_CACHE_CAPACITY) {
    _graphCache.delete(_graphOrder.shift());
  }
  return g;
}

/**
 * The tunnel skeleton of one macro cell, for the debug overlay and for tests.
 *
 * @param {number} mx macro cell index along X (world x = mx * 512)
 * @param {number} my macro cell index along Y
 * @param {number} mz macro cell index along Z
 * @returns {{capsuleCount:number, a:Float64Array, b:Float64Array,
 *            radiusA:Float64Array, radiusB:Float64Array, grotto:Uint8Array,
 *            chamberCount:number, centre:Float64Array, radii:Float64Array,
 *            mouthCount:number, mouths:Float64Array, min:number[], max:number[]}}
 *   Views into the cached graph, NOT copies: read them, do not write them.
 */
export function caveSkeleton(mx, my, mz) {
  ensureSeed();
  const g = macroGraph(mx, my, mz);
  return {
    capsuleCount: g.capCount,
    a: g.ca, b: g.cb, radiusA: g.cra, radiusB: g.crb, grotto: g.cflags,
    chamberCount: g.chamberCount, centre: g.ec, radii: g.er,
    mouthCount: g.mouthCount, mouths: g.mouths, mouthRadius: g.mouthRadius,
    min: g.min, max: g.max,
  };
}

/** Macro cell edge length, metres. The address a caveSkeleton() query takes. */
export const CAVE_MACRO_SIZE = MACRO;

/** Clear the macro-cell cache. Exported so a memory-pressure handler can call it. */
export function clearCaveCache() {
  _graphCache.clear();
  _graphOrder.length = 0;
  // The neighbourhood memo holds graph references, so it has to go too or a
  // seed change would keep answering from the old world.
  _memoMx = NaN; _memoMy = NaN; _memoMz = NaN;
  _memoCells.length = 0;
  _column.x = NaN; _column.z = NaN;
  // The authored shroom seats are field bisections, so a seed change stales
  // them exactly as it stales the graphs.
  _shroomCache = null;
  _shroomCacheSeed = -1;
}

// ===========================================================================
// Signed distances
// ===========================================================================

/** Ellipsoid, positive outside. Scaled by the smallest semi-axis so the result
 *  is a bounded under-estimate of the true distance rather than an unbounded one. */
function sdEllipsoid(px, py, pz, cx, cy, cz, rx, ry, rz) {
  const ax = (px - cx) / rx, ay = (py - cy) / ry, az = (pz - cz) / rz;
  const k = Math.sqrt(ax * ax + ay * ay + az * az);
  return (k - 1) * Math.min(rx, ry, rz);
}

// ===========================================================================
// The field
// ===========================================================================

/**
 * Everything about the field that depends only on (x, z). Hoisting this is what
 * makes a 42875-sample chunk affordable: H() is 15 layers of noise and it is
 * constant down a column, so a chunk evaluates it 37x37 times instead of 35x35x35
 * times - a factor of 33.
 */
const _column = {
  x: NaN, z: NaN,
  height: 0,
  overhangXZ: 0,     // slope mask * seed mask, [0,1]
  fissureMask: 0,    // [0,1]
};

/**
 * Terrain slope used by the overhang mask, as |grad H| over a 1 m central
 * difference. 1 m rather than terrain.sampleSlope's 2 m because the cave lattice
 * IS 1 m: sampling the gradient on the same lattice the field lives on means the
 * chunk path can read it straight out of its height slab and get bit-identical
 * values to this function, which is what keeps generateCaveChunk() and
 * caveDensity() in exact agreement.
 */
function slopeAt(x, z) {
  const gx = (sampleHeight(x + 1, z) - sampleHeight(x - 1, z)) * 0.5;
  const gz = (sampleHeight(x, z + 1) - sampleHeight(x, z - 1)) * 0.5;
  return Math.hypot(gx, gz);
}

function overhangMaskXZ(x, z, slope) {
  const slopeMask = smoothstep(OVERHANG_SLOPE_LO, OVERHANG_SLOPE_HI, slope);
  if (slopeMask <= 0) return 0;
  const seed = 0.5 + 0.5 * simplex2(x * OVERHANG_SEED_FREQ, z * OVERHANG_SEED_FREQ, S.OVERHANG);
  return slopeMask * smoothstep(OVERHANG_SEED_LO, OVERHANG_SEED_HI, seed);
}

function fissureMaskXZ(x, z) {
  // The safe crater is excluded here rather than only on the capsules: the
  // fissure network is a noise field with no primitives to filter, so the radial
  // gate has to be part of its mask or the lagoon floor develops sheet caves.
  const r = Math.hypot(x, z);
  const safe = smoothstep(NO_CAVE_RADIUS, NO_CAVE_RADIUS + FISSURE_SAFE_FADE, r);
  if (safe <= 0) return 0;
  const m = 0.5 + 0.5 * simplex2(x * FISSURE_MASK_FREQ, z * FISSURE_MASK_FREQ, S.FISSURE);
  return safe * smoothstep(FISSURE_MASK_LO, FISSURE_MASK_HI, m);
}

function columnAt(x, z) {
  if (_column.x === x && _column.z === z) return _column;
  _column.x = x; _column.z = z;
  _column.height = sampleHeight(x, z);
  _column.overhangXZ = overhangMaskXZ(x, z, slopeAt(x, z));
  _column.fissureMask = fissureMaskXZ(x, z);
  return _column;
}

/**
 * The terrain half of the field: how far ABOVE the (possibly overhung) rock
 * surface a point is. Negative inside rock.
 */
function terrainTerm(x, y, z, height, overhangXZ) {
  let above = y - height;
  if (overhangXZ > 0) {
    // Band mask keeps the displacement tied to the surface, which is what stops
    // an overhang detaching into a floating island 40 m above the seabed.
    const band = 1 - smoothstep(OVERHANG_BAND_LO, OVERHANG_BAND_HI, Math.abs(above));
    if (band > 0) {
      const n = fbm3(simplex3, x * OVERHANG_FREQ, y * OVERHANG_FREQ, z * OVERHANG_FREQ,
                     S.OVERHANG, OVERHANG_OCTAVES, 2.06, 0.50);
      above -= OVERHANG_AMP * overhangXZ * band * n;
    }
  }
  return above;
}

/** Scratch for the capsule gather; sized for the worst observed 27-cell load. */
const _gatherCells = [];

// Memo of the 27-cell neighbourhood for the LAST macro cell queried. A ray march
// takes hundreds of samples and stays inside one or two macro cells, so without
// this every one of them would rebuild a 27-entry key string and walk the LRU.
let _memoMx = NaN, _memoMy = NaN, _memoMz = NaN;
const _memoCells = [];

/**
 * How open the tunnel graph is at a point: positive inside a void, negative in
 * rock, in metres. Reads the 3x3x3 macro cells around the point, which REACH
 * guarantees is enough (see REACH).
 */
function graphTerm(x, y, z) {
  const mx = Math.floor(x / MACRO), my = Math.floor(y / MACRO), mz = Math.floor(z / MACRO);
  if (mx !== _memoMx || my !== _memoMy || mz !== _memoMz) {
    _memoMx = mx; _memoMy = my; _memoMz = mz;
    _memoCells.length = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const g = macroGraph(mx + dx, my + dy, mz + dz);
          if (g.capCount > 0 || g.chamberCount > 0) _memoCells.push(g);
        }
      }
    }
  }
  let open = -1e9;
  let winner = 0;
  for (let c = 0; c < _memoCells.length; c++) {
    const g = _memoCells[c];
    // Cell AABB reject. The bounds already include the perturbation reach.
    if (x < g.min[0] || x > g.max[0] || y < g.min[1] || y > g.max[1] ||
        z < g.min[2] || z > g.max[2]) continue;
    const d = graphTermIn(g, x, y, z);
    if (d > open) { open = d; winner = _winnerRadius; }
  }
  _winnerRadius = winner;
  return open;
}

/**
 * Local width of the primitive that won the last graphTermIn() call, metres.
 *
 * The wall perturbation needs it (see perturbGraph), and threading it back as a
 * module scratch rather than an out-parameter keeps the inner loop free of object
 * writes. Generation is single-threaded per worker, which is the same assumption
 * the noise scratch in world/noise.js makes.
 */
let _winnerRadius = 0;

/**
 * The same query against one already-selected graph.
 *
 * The capsule term is inlined rather than factored into an sdCapsule() helper
 * because the loop needs the interpolated RADIUS as well as the distance, and
 * this is the hottest loop in the generator - 42875 samples times a dozen
 * capsules per chunk.
 *
 * CAPSULE DISTANCE IS APPROXIMATE when the two radii differ: projecting onto the
 * axis and subtracting the interpolated radius describes a linear radius sweep,
 * whereas the true surface of a round cone is its tangent cone. The error is
 * bounded by |ra - rb| / |b - a|, which for a 12 m step and a 40% radius change
 * is under 3%, and it always UNDER-estimates the distance - which is the safe
 * direction for both consumers: max() never opens rock it should not, and a
 * Lipschitz-bounded march never overshoots a wall.
 */
function graphTermIn(g, x, y, z) {
  let open = -1e9;
  let winner = 0;
  const ca = g.ca, cb = g.cb, ra = g.cra, rb = g.crb;
  for (let i = 0; i < g.capCount; i++) {
    const ax = ca[i * 3], ay = ca[i * 3 + 1], az = ca[i * 3 + 2];
    const bx = cb[i * 3], by = cb[i * 3 + 1], bz = cb[i * 3 + 2];
    const ex = bx - ax, ey = by - ay, ez = bz - az;
    const dx = x - ax, dy = y - ay, dz = z - az;
    const ee = ex * ex + ey * ey + ez * ez;
    const t = ee > 1e-12 ? clamp((dx * ex + dy * ey + dz * ez) / ee, 0, 1) : 0;
    const cx = dx - ex * t, cy = dy - ey * t, cz = dz - ez * t;
    const r = ra[i] + (rb[i] - ra[i]) * t;
    const d = r - Math.sqrt(cx * cx + cy * cy + cz * cz);
    if (d > open) { open = d; winner = r; }
  }
  const ec = g.ec, er = g.er;
  for (let i = 0; i < g.chamberCount; i++) {
    const d = -sdEllipsoid(x, y, z,
      ec[i * 3], ec[i * 3 + 1], ec[i * 3 + 2],
      er[i * 3], er[i * 3 + 1], er[i * 3 + 2]);
    if (d > open) { open = d; winner = Math.min(er[i * 3], er[i * 3 + 1], er[i * 3 + 2]); }
  }
  _winnerRadius = winner;
  return open;
}

/**
 * Openness of one RESOLVED authored site's primitives at a point - the same
 * capsule/ellipsoid arithmetic as graphTermIn, over cave_sites' array-of-array
 * records instead of a graph SoA. Used only to derive the per-vertex authored
 * weight (see generateCaveChunk), never as a field term: the site's real field
 * contribution comes from the merged graph, so render and collision cannot
 * disagree with this copy - it only shades.
 */
function authoredOpennessAt(r, x, y, z) {
  let open = -1e9;
  for (const c of r.capsules) {
    const ex = c[4] - c[0], ey = c[5] - c[1], ez = c[6] - c[2];
    const dx = x - c[0], dy = y - c[1], dz = z - c[2];
    const ee = ex * ex + ey * ey + ez * ez;
    const t = ee > 1e-12 ? clamp((dx * ex + dy * ey + dz * ez) / ee, 0, 1) : 0;
    const px = dx - ex * t, py = dy - ey * t, pz = dz - ez * t;
    const rad = c[3] + (c[7] - c[3]) * t;
    const d = rad - Math.sqrt(px * px + py * py + pz * pz);
    if (d > open) open = d;
  }
  for (const e of r.chambers) {
    const d = -sdEllipsoid(x, y, z, e[0], e[1], e[2], e[3], e[4], e[5]);
    if (d > open) open = d;
  }
  return open;
}

/**
 * Wall perturbation, applied to the graph term.
 *
 * GATED, and the gate is part of the DEFINITION of the field rather than an
 * optimisation bolted on top. Where the unperturbed void is further than the
 * perturbation can reach, adding it cannot move the iso-surface, so the field is
 * defined to skip it there. Making the gate part of the definition is what keeps
 * generateCaveChunk() and caveDensity() bit-identical: an optimisation that only
 * one of the two paths applied would put the collision surface and the render
 * surface in different places.
 */
function perturbGraph(x, y, z, open, radius) {
  // AMPLITUDE IS CAPPED AT A FRACTION OF THE PASSAGE'S OWN WIDTH, and that cap is
  // load-bearing rather than cosmetic. A flat 2.9 m offset applied to a tunnel
  // whose radius is 1.6 m - the narrowest in the biome table - pinches it shut
  // wherever the noise peaks, which severs the walk into disconnected pockets and
  // destroys the entrance guarantee. Capping the offset at DETAIL_FRACTION of the
  // local radius leaves a clear passage of at least (1 - DETAIL_FRACTION) times
  // that radius EVERYWHERE, so connectivity survives by arithmetic instead of by
  // luck. It also looks better: a cathedral chamber gets metres of wall relief
  // and a crawlway gets centimetres, which is how dissolution actually scales.
  const amp = Math.min(DETAIL_AMP, radius * DETAIL_FRACTION);
  if (amp <= 0 || open < -(amp + 2) || open > amp + 2) return open;
  const n = fbm3(simplex3, x * DETAIL_FREQ, y * DETAIL_FREQ, z * DETAIL_FREQ,
                 S.DETAIL, DETAIL_OCTAVES, DETAIL_LACUNARITY, DETAIL_GAIN);
  return open - amp * n;
}

/**
 * The fissure network's contribution: positive inside a sheet, in metres.
 * `above` is (y - H), so -above is the depth below the rock surface.
 */
function fissureTerm(x, y, z, maskXZ, above) {
  if (maskXZ <= 0) return -1e9;
  const depth = -above;
  const band = smoothstep(FISSURE_DEPTH_LO, FISSURE_DEPTH_HI, depth) *
               (1 - smoothstep(FISSURE_DEPTH_FAR, FISSURE_DEPTH_GONE, depth));
  const mask = maskXZ * band;
  // Not FISSURE_CLOSED: a term that does not participate has to drop out of the
  // max() entirely, or 1.3 km of solid rock reads as "60 m below the surface".
  if (mask <= 0) return -1e9;
  const e = worley3Edge(x / FISSURE_CELL, y / FISSURE_CELL, z / FISSURE_CELL, S.FISSURE);
  // Closed by an ADDITIVE offset as the mask falls, never by multiplication
  // (see FISSURE_CLOSED).
  return (FISSURE_HALF_WIDTH - e) * FISSURE_CELL - (1 - mask) * FISSURE_CLOSED;
}

/**
 * The authoritative volumetric density field.
 *
 * @param {number} x world east, metres
 * @param {number} y world up, metres (sea level 0)
 * @param {number} z world south, metres
 * @returns {number} NEGATIVE inside solid rock, POSITIVE in open space, in
 *   approximate metres. Zero is the rock surface.
 *
 * Composition, with the sign reasoning spelled out because it inverts easily:
 * a point is SOLID when it is both below the rock surface AND outside every
 * void. "Open" is therefore the MAXIMUM of "how far above the surface" and "how
 * far inside a void", which is the De Morgan dual of DESIGN/02's
 * `min(Fterrain, Fcave)`.
 *
 * Outside the cave band [WORLD.CAVE_MIN_Y, CAVE_MAX_Y] the volumetric terms are
 * switched off entirely and this degenerates to the heightfield, which is what
 * makes a query in the abyss cost one H() evaluation.
 *
 * NOT A TRUE SIGNED DISTANCE FIELD, and nothing here may assume it is. It is a
 * max() of terms, each of which is itself an under-estimate of a distance, so the
 * SIGN is exact everywhere and the MAGNITUDE is a lower bound on the distance to
 * the nearest surface. That is enough for marching cubes (which only reads signs
 * and interpolates), enough for a Lipschitz-bounded ray march (an under-estimate
 * shortens the step, which is the safe direction), and NOT enough for a sphere
 * trace, which is why raycastCave() does not use one.
 */
export function caveDensity(x, y, z) {
  ensureSeed();
  const col = columnAt(x, z);
  const terrain = terrainTerm(x, y, z, col.height, col.overhangXZ);
  if (y < WORLD.CAVE_MIN_Y || y > WORLD.CAVE_MAX_Y) return terrain;
  // Nothing below the surface can be opened from more than the deepest cave, and
  // nothing far above it needs a graph query at all.
  if (terrain > DETAIL_AMP + 2) return terrain;

  const graph = graphTerm(x, y, z);
  let open = perturbGraph(x, y, z, graph, _winnerRadius);
  const fis = fissureTerm(x, y, z, col.fissureMask, y - col.height);
  if (fis > open) open = fis;
  return terrain > open ? terrain : open;
}

/**
 * The CARVED-VOID half of the field alone: how far inside a tunnel, chamber or
 * fissure a point is, in approximate metres, with the terrain term left out.
 *
 * Exists for the collision gate. `caveDensity > 0` below the heightfield is
 * true of every opened pocket including the OVERHANG displacement's carve-ins,
 * and the overhang has no renderer today (its consumer needs the full DESIGN/02
 * 8.7 suppression atlas): letting a body pass the heightfield on its strength
 * would put the player inside rock the terrain pass still draws. This term is
 * exactly the geometry the cave pass DOES render - the graph and the fissures,
 * perturbed - so "may this body ignore the heightfield here" and "is there
 * something on screen here" are the same predicate by construction.
 *
 * Depenetration inside a cave still runs on caveDensity itself, because that is
 * the field the mesh is marched from; this function only decides ADMISSION.
 *
 * @returns {number} positive inside a carved void, negative (down to -1e9 for
 *   "no void anywhere near") outside one.
 */
export function caveVoidAt(x, y, z) {
  ensureSeed();
  if (y < WORLD.CAVE_MIN_Y || y > WORLD.CAVE_MAX_Y) return -1e9;
  const col = columnAt(x, z);
  const graph = graphTerm(x, y, z);
  let open = perturbGraph(x, y, z, graph, _winnerRadius);
  const fis = fissureTerm(x, y, z, col.fissureMask, y - col.height);
  if (fis > open) open = fis;
  return open;
}

/**
 * Unit surface normal of the density field, written into `out`.
 * Points OUT of the rock, i.e. along increasing density.
 *
 * `eps` is 0.25 m by default: small enough to resolve the wall perturbation's
 * finest octave (26 m / 2^3 = 3.3 m), large enough that the finite difference
 * does not amplify the field's own kinks at a max() seam into a spike.
 */
export function caveNormal(out, x, y, z, eps = 0.25) {
  const dx = caveDensity(x + eps, y, z) - caveDensity(x - eps, y, z);
  const dy = caveDensity(x, y + eps, z) - caveDensity(x, y - eps, z);
  const dz = caveDensity(x, y, z + eps) - caveDensity(x, y, z - eps);
  const l = Math.hypot(dx, dy, dz);
  if (l < 1e-12) { out[0] = 0; out[1] = 1; out[2] = 0; return out; }
  out[0] = dx / l; out[1] = dy / l; out[2] = dz / l;
  return out;
}

/**
 * Is this point inside a CAVE, as opposed to inside open water?
 *
 * Both are "not rock", and the difference is what the player's air supply, the
 * reverb bus and the creature spawner all need to know. A point counts as being
 * in a cave when the volumetric field has opened it AND the heightfield says it
 * should have been rock - i.e. it is inside the override, under a roof.
 */
export function isInsideCave(x, y, z) {
  ensureSeed();
  if (y < WORLD.CAVE_MIN_Y || y > WORLD.CAVE_MAX_Y) return false;
  const col = columnAt(x, z);
  // Under the un-overhung surface: the plain heightfield would call this rock.
  if (y >= col.height) return false;
  return caveDensity(x, y, z) > 0;
}

// ---------------------------------------------------------------------------
// Authored jellyshroom instances
// ---------------------------------------------------------------------------

let _shroomCache = null;
let _shroomCacheSeed = -1;

/**
 * The cave FLOOR under (x, z) inside a resolved site: the lowest rock->open
 * crossing of the full density field within the site's own vertical range.
 * 1 m scan up from below, then 8 bisection steps - about 60 field queries,
 * run once per authored shroom per seed.
 *
 * @returns {number|null} the crossing y, or null when the column never opens
 *   (an authored position the perturbation happened to close - the caller
 *   drops the shroom, deterministically).
 */
function caveFloorAt(x, z, r) {
  const yLo = r.aabb.minY + 0.5;
  const yHi = r.mouth.y;
  let prev = caveDensity(x, yLo, z);
  for (let y = yLo + 1; y <= yHi; y += 1) {
    const d = caveDensity(x, y, z);
    if (prev <= 0 && d > 0) {
      // Bisect [y-1, y] for the crossing.
      let a = y - 1, b = y;
      for (let i = 0; i < 8; i++) {
        const m = (a + b) * 0.5;
        if (caveDensity(x, m, z) > 0) b = m; else a = m;
      }
      return b;
    }
    prev = d;
  }
  return null;
}

/**
 * Every authored jellyshroom, resolved to a world-space instance: seated on
 * the real cave floor by field bisection, with deterministic yaw and mesh
 * variant. ONE definition consumed by BOTH the cave bake (which emits the
 * geometry, filtering to each chunk's own cube) and the render pass's light
 * submitter (which lifts each cap into a punctual light) - so the light can
 * never float away from its mesh.
 *
 * Instance scale is height / 14, the jellyshroom generator's registered
 * height (world/meshgen.js MESH_GENERATORS 'jellyshroom').
 *
 * @returns {Array<{x:number, y:number, z:number, scale:number, yaw:number,
 *   variant:number, height:number}>}
 */
export function jellyShroomInstances() {
  ensureSeed();
  if (_shroomCache && _shroomCacheSeed === _seedSource) return _shroomCache;
  const out = [];
  for (const r of resolvedCaveSites()) {
    const s = r.site;
    if (!s.shrooms) continue;
    for (let i = 0; i < s.shrooms.length; i++) {
      const [dx, dz, h] = s.shrooms[i];
      const x = s.mouth.x + dx, z = s.mouth.z + dz;
      const floorY = caveFloorAt(x, z, r);
      if (floorY === null) continue;
      const hash = h3(S.GRAPH ^ 0x9d5b, Math.round(x * 8), i, Math.round(z * 8));
      out.push({
        x, y: floorY, z,
        scale: h / 14,
        yaw: ((hash & 0xffff) / 65536) * Math.PI * 2,
        variant: (hash >>> 16) & 1,
        height: h,
      });
    }
  }
  _shroomCache = out;
  _shroomCacheSeed = _seedSource;
  return out;
}

/** @returns {object} reusable record for raycastCave(). */
export function createCaveHit() {
  return {
    hit: false,
    t: 0,
    point: vec3.create(),
    normal: vec3.create(0, 1, 0),
    steps: 0,
    /** True when the march ran out of iterations without deciding. */
    exhausted: false,
  };
}

/**
 * Assumed Lipschitz bound on the density field: |grad density| <= this.
 *
 * The vertical term has gradient exactly 1 in y, and its horizontal gradient is
 * |grad H| plus the overhang displacement's own slope; the capsule terms are
 * true distances (gradient 1) perturbed by a field whose slope is bounded by
 * DETAIL_AMP * DETAIL_FREQ summed over its octaves. 3.2 covers all of it with
 * margin, and being generous only costs steps, whereas being optimistic steps
 * straight through a cave wall.
 */
const CAVE_LIPSCHITZ = 3.2;
const CAVE_MAX_STEPS = 512;
const CAVE_MIN_STEP = 0.05;

/**
 * March a ray against the rock surface.
 *
 * A sphere trace on the field itself would be wrong: caveDensity is a max() of
 * two under-estimating distance terms plus additive noise, so it is not a valid
 * distance bound and a trace would overshoot through thin walls. Dividing by the
 * Lipschitz bound turns it back into a safe step, which is the same treatment
 * collision.js gives the heightfield.
 *
 * @param {ArrayLike<number>} origin
 * @param {ArrayLike<number>} dir MUST be unit length
 * @param {number} maxDist metres
 * @param {object} [hit] record from createCaveHit(), reused if given
 */
export function raycastCave(origin, dir, maxDist = 200, hit = createCaveHit()) {
  ensureSeed();
  hit.hit = false;
  hit.exhausted = false;
  hit.steps = 0;
  hit.t = 0;

  let t = 0;
  let prevT = 0;
  let prev = caveDensity(origin[0], origin[1], origin[2]);
  if (prev <= 0) {
    // Started inside rock. Report an immediate hit with the outward normal so a
    // caller that has been pushed into a wall can depenetrate rather than being
    // told there is nothing there.
    hit.hit = true;
    hit.t = 0;
    vec3.set(hit.point, origin[0], origin[1], origin[2]);
    caveNormal(hit.normal, origin[0], origin[1], origin[2]);
    return hit;
  }

  for (let i = 0; i < CAVE_MAX_STEPS; i++) {
    hit.steps = i + 1;
    const step = Math.max(CAVE_MIN_STEP, prev / CAVE_LIPSCHITZ);
    const nt = t + step;
    if (nt > maxDist) {
      // One last sample exactly at the limit, so a surface sitting on maxDist is
      // not missed by a fraction of a step.
      const d = caveDensity(origin[0] + dir[0] * maxDist,
                            origin[1] + dir[1] * maxDist,
                            origin[2] + dir[2] * maxDist);
      if (d <= 0) { prevT = t; t = maxDist; prev = d; break; }
      return hit;
    }
    const d = caveDensity(origin[0] + dir[0] * nt,
                          origin[1] + dir[1] * nt,
                          origin[2] + dir[2] * nt);
    if (d <= 0) { prevT = t; t = nt; prev = d; break; }
    prevT = nt;
    t = nt;
    prev = d;
    if (i === CAVE_MAX_STEPS - 1) { hit.exhausted = true; return hit; }
  }
  if (prev > 0) return hit;

  // Bisect the bracketing interval [prevT, t] where the sign changed.
  let lo = prevT, hi = t;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) * 0.5;
    const d = caveDensity(origin[0] + dir[0] * mid,
                          origin[1] + dir[1] * mid,
                          origin[2] + dir[2] * mid);
    if (d > 0) lo = mid; else hi = mid;
  }
  hit.hit = true;
  hit.t = hi;
  vec3.set(hit.point,
    origin[0] + dir[0] * hi, origin[1] + dir[1] * hi, origin[2] + dir[2] * hi);
  caveNormal(hit.normal, hit.point[0], hit.point[1], hit.point[2]);
  return hit;
}

// ===========================================================================
// Chunk generation
// ===========================================================================

/** World-space lattice origin of cave chunk (cx, cy, cz), written into `out`. */
export function caveChunkOrigin(out, cx, cy, cz) {
  out[0] = cx * CAVE_CHUNK_SIZE - CAVE_SKIRT * CAVE_CELL;
  out[1] = cy * CAVE_CHUNK_SIZE - CAVE_SKIRT * CAVE_CELL;
  out[2] = cz * CAVE_CHUNK_SIZE - CAVE_SKIRT * CAVE_CELL;
  return out;
}

/** Cave chunk address containing a world position, written into `out`. */
export function caveChunkAt(out, x, y, z) {
  out[0] = Math.floor(x / CAVE_CHUNK_SIZE);
  out[1] = Math.floor(y / CAVE_CHUNK_SIZE);
  out[2] = Math.floor(z / CAVE_CHUNK_SIZE);
  return out;
}

const _occOrigin = [0, 0, 0];

/**
 * Cheap conservative test for whether a cave chunk is worth generating.
 *
 * @returns {number} EXACTLY 0 when the chunk provably contains no iso-surface -
 *   it is entirely solid rock or entirely open - in which case
 *   generateCaveChunk() would return null and must not be called. Otherwise a
 *   positive priority in (0, 1] indicating roughly how much geometry to expect,
 *   which is what the streaming queue orders on.
 *
 * The whole point is to be cheap: 25 heightfield samples and the macro graphs
 * that are cached anyway, against the 1369 heightfield samples and 42875 field
 * evaluations of a real generation. Every rejection here is a chunk that never
 * enters the queue, and in this world only a few percent of the volume survives.
 */
export function caveOccupancy(cx, cy, cz) {
  ensureSeed();
  caveChunkOrigin(_occOrigin, cx, cy, cz);
  const span = CAVE_CHUNK_SIZE + 2 * CAVE_SKIRT * CAVE_CELL;
  const x0 = _occOrigin[0], y0 = _occOrigin[1], z0 = _occOrigin[2];
  const x1 = x0 + span, y1 = y0 + span, z1 = z0 + span;

  // Entirely outside the volumetric band, and no surface crossing either: the
  // heightfield already describes this and there is nothing to override.
  const bandOverlap = y1 > WORLD.CAVE_MIN_Y && y0 < WORLD.CAVE_MAX_Y;

  // Height range over the footprint, from a 5x5 probe. The probe can miss a
  // spike between samples, which is why the comparison below is padded by the
  // largest amplitude any single layer can add.
  let hMin = Infinity, hMax = -Infinity;
  for (let j = 0; j <= 4; j++) {
    for (let i = 0; i <= 4; i++) {
      const h = sampleHeight(x0 + (i / 4) * span, z0 + (j / 4) * span);
      if (h < hMin) hMin = h;
      if (h > hMax) hMax = h;
    }
  }
  const pad = OVERHANG_AMP + 6;
  const surfaceCrosses = hMax + pad >= y0 && hMin - pad <= y1;

  let capsules = 0;
  if (bandOverlap) {
    const mx0 = Math.floor(x0 / MACRO), mx1 = Math.floor(x1 / MACRO);
    const my0 = Math.floor(y0 / MACRO), my1 = Math.floor(y1 / MACRO);
    const mz0 = Math.floor(z0 / MACRO), mz1 = Math.floor(z1 / MACRO);
    for (let mz = mz0 - 1; mz <= mz1 + 1; mz++) {
      for (let my = my0 - 1; my <= my1 + 1; my++) {
        for (let mx = mx0 - 1; mx <= mx1 + 1; mx++) {
          const g = macroGraph(mx, my, mz);
          if (g.capCount === 0 && g.chamberCount === 0) continue;
          if (g.max[0] < x0 || g.min[0] > x1 || g.max[1] < y0 || g.min[1] > y1 ||
              g.max[2] < z0 || g.min[2] > z1) continue;
          capsules += g.capCount + g.chamberCount;
        }
      }
    }
  }

  const fissure = bandOverlap && y1 < 0
    ? Math.max(fissureMaskXZ(x0, z0), fissureMaskXZ(x1, z0),
               fissureMaskXZ(x0, z1), fissureMaskXZ(x1, z1))
    : 0;

  if (!surfaceCrosses && capsules === 0 && fissure <= 0) return 0;
  if (!bandOverlap && !surfaceCrosses) return 0;

  return Math.min(1, (surfaceCrosses ? 0.45 : 0) + Math.min(0.4, capsules * 0.01)
                   + fissure * 0.25);
}

// Chunk scratch, reused. 35^3 f32 = 171 KB, 37^2 f64 slabs = 22 KB.
const _field = new Float32Array(CAVE_LATTICE * CAVE_LATTICE * CAVE_LATTICE);
// Per-sample: 1 where the CARVED void term (graph/fissure) decided the field
// value, 0 where the terrain term did. The streaming layer's triangle cull
// reads this through the per-vertex `carved` channel below; without it the
// marched mesh re-describes the whole heightfield surface of every chunk it
// crosses, coincident with the terrain pass's own geometry.
const _carvedLat = new Uint8Array(CAVE_LATTICE * CAVE_LATTICE * CAVE_LATTICE);
const _slabN = CAVE_LATTICE + 2;
const _slabHeight = new Float64Array(_slabN * _slabN);
const _slabOverhang = new Float64Array(_slabN * _slabN);
const _slabFissure = new Float64Array(_slabN * _slabN);
const _chunkDims = Int32Array.of(CAVE_LATTICE, CAVE_LATTICE, CAVE_LATTICE);
const _chunkOrigin = [0, 0, 0];

/**
 * Generate one cave chunk.
 *
 * @param {number} cx chunk index along X (world x = cx * CAVE_CHUNK_SIZE)
 * @param {number} cy chunk index along Y
 * @param {number} cz chunk index along Z
 * @returns {object|null} the mesh from marchingCubes(), extended with
 *   `origin`, `address`, `cellSize`, `materials` (one CAVE_MATERIAL per vertex)
 *   and `grottoFraction`; or NULL when the chunk is entirely solid or entirely
 *   open and therefore has no surface in it.
 *
 * The lattice covers 34 m on a 1 m pitch with its origin one cell OUTSIDE the
 * chunk's own 32 m, so adjacent chunks overlap by a full cell and the shared
 * lattice planes are evaluated at identical integer world coordinates.
 */
export function generateCaveChunk(cx, cy, cz) {
  ensureSeed();
  if (caveOccupancy(cx, cy, cz) === 0) return null;

  caveChunkOrigin(_chunkOrigin, cx, cy, cz);
  const ox = _chunkOrigin[0], oy = _chunkOrigin[1], oz = _chunkOrigin[2];

  // --- XZ slabs ---------------------------------------------------------
  // One ring wider than the lattice, so the slope central difference at a
  // lattice border reads real neighbours rather than a clamped duplicate - which
  // would make the border's overhang mask disagree with the neighbouring
  // chunk's and reopen the seam this whole scheme exists to close.
  for (let sj = 0; sj < _slabN; sj++) {
    const z = oz + (sj - 1) * CAVE_CELL;
    for (let si = 0; si < _slabN; si++) {
      const x = ox + (si - 1) * CAVE_CELL;
      _slabHeight[sj * _slabN + si] = sampleHeight(x, z);
    }
  }
  for (let sj = 1; sj < _slabN - 1; sj++) {
    const z = oz + (sj - 1) * CAVE_CELL;
    for (let si = 1; si < _slabN - 1; si++) {
      const x = ox + (si - 1) * CAVE_CELL;
      // Same 1 m central difference slopeAt() uses, on the same lattice points,
      // so the two are bit-identical.
      const gx = (_slabHeight[sj * _slabN + si + 1] - _slabHeight[sj * _slabN + si - 1]) * 0.5;
      const gz = (_slabHeight[(sj + 1) * _slabN + si] - _slabHeight[(sj - 1) * _slabN + si]) * 0.5;
      _slabOverhang[sj * _slabN + si] = overhangMaskXZ(x, z, Math.hypot(gx, gz));
      _slabFissure[sj * _slabN + si] = fissureMaskXZ(x, z);
    }
  }

  // --- capsule gather ----------------------------------------------------
  // The 27 macro cells around the chunk, filtered to those whose bounds actually
  // touch it. Doing this once per chunk rather than once per sample is the
  // difference between a few milliseconds and a few seconds.
  _gatherCells.length = 0;
  const span = CAVE_CHUNK_SIZE + 2 * CAVE_SKIRT * CAVE_CELL;
  const x1 = ox + span, y1 = oy + span, z1 = oz + span;
  const inBand = y1 > WORLD.CAVE_MIN_Y && oy < WORLD.CAVE_MAX_Y;
  if (inBand) {
    const mx0 = Math.floor(ox / MACRO), mx1 = Math.floor(x1 / MACRO);
    const my0 = Math.floor(oy / MACRO), my1 = Math.floor(y1 / MACRO);
    const mz0 = Math.floor(oz / MACRO), mz1 = Math.floor(z1 / MACRO);
    for (let mz = mz0 - 1; mz <= mz1 + 1; mz++) {
      for (let my = my0 - 1; my <= my1 + 1; my++) {
        for (let mx = mx0 - 1; mx <= mx1 + 1; mx++) {
          const g = macroGraph(mx, my, mz);
          if (g.capCount === 0 && g.chamberCount === 0) continue;
          if (g.max[0] < ox || g.min[0] > x1 || g.max[1] < oy || g.min[1] > y1 ||
              g.max[2] < oz || g.min[2] > z1) continue;
          _gatherCells.push(g);
        }
      }
    }
  }

  // --- field -------------------------------------------------------------
  const n = CAVE_LATTICE;
  let anyNegative = false;
  let anyPositive = false;
  for (let k = 0; k < n; k++) {
    const z = oz + k * CAVE_CELL;
    for (let j = 0; j < n; j++) {
      const y = oy + j * CAVE_CELL;
      const rowBase = (k * n + j) * n;
      const inYBand = y >= WORLD.CAVE_MIN_Y && y <= WORLD.CAVE_MAX_Y;
      for (let i = 0; i < n; i++) {
        const x = ox + i * CAVE_CELL;
        const slab = (k + 1) * _slabN + (i + 1);
        const height = _slabHeight[slab];
        let v = terrainTerm(x, y, z, height, _slabOverhang[slab]);
        let carvedHere = 0;
        if (inYBand && v <= DETAIL_AMP + 2) {
          let open = -1e9;
          let winnerRadius = 0;
          for (let c = 0; c < _gatherCells.length; c++) {
            const g = _gatherCells[c];
            if (x < g.min[0] || x > g.max[0] || y < g.min[1] || y > g.max[1] ||
                z < g.min[2] || z > g.max[2]) continue;
            const d = graphTermIn(g, x, y, z);
            if (d > open) { open = d; winnerRadius = _winnerRadius; }
          }
          open = perturbGraph(x, y, z, open, winnerRadius);
          const fis = fissureTerm(x, y, z, _slabFissure[slab], y - height);
          if (fis > open) open = fis;
          if (open > v) { v = open; carvedHere = 1; }
        }
        _field[rowBase + i] = v;
        _carvedLat[rowBase + i] = carvedHere;
        if (v < 0) anyNegative = true; else anyPositive = true;
      }
    }
  }
  if (!anyNegative || !anyPositive) return null;

  const mesh = marchingCubes(_field, _chunkDims, CAVE_CELL, _chunkOrigin, 0);
  if (!mesh) return null;

  // --- per-vertex material ----------------------------------------------
  // GROTTO on walls and ceilings of a luminous system (never floors - the
  // bioluminescence is on the rock the water flows past, and a glowing floor
  // reads as a light fixture); MOUTH within 1.5 m of the heightfield surface so
  // a cave entrance blends into the biome it opens out of; INTERIOR otherwise.
  const materials = new Uint8Array(mesh.vertexCount);
  // Two channels the STREAMING layer needs and only this function can supply
  // cheaply, because the slabs and the carved lattice are already in hand:
  //   surfaceDepth  metres BELOW the heightfield surface (negative above it),
  //                 the input to the baked skylight gate - inside the override
  //                 the sky SH and the sun must not reach a wall that rock
  //                 occludes, and the renderer has no other occlusion signal.
  //   carved        1 where the void term (graph/fissure) produced this
  //                 geometry, 0 where it is the marched copy of the heightfield
  //                 surface. The triangle cull drops the un-carved copy, which
  //                 otherwise z-fights the terrain pass over the whole chunk.
  const surfaceDepth = new Float32Array(mesh.vertexCount);
  const carved = new Uint8Array(mesh.vertexCount);
  const nLat = CAVE_LATTICE;
  let grotto = 0;
  const grottoNear = _gatherCells.some((g) => {
    for (let i = 0; i < g.capCount; i++) if (g.cflags[i] & FLAG_GROTTO) return true;
    for (let i = 0; i < g.chamberCount; i++) if (g.eflags[i] & FLAG_GROTTO) return true;
    return false;
  });
  for (let v = 0; v < mesh.vertexCount; v++) {
    const px = mesh.positions[v * 3], py = mesh.positions[v * 3 + 1], pz = mesh.positions[v * 3 + 2];
    // Slab lookup by nearest lattice column; the vertex sits on a lattice edge
    // so it is at most half a cell from one.
    const si = clamp(Math.round((px - ox) / CAVE_CELL) + 1, 1, _slabN - 2);
    const sk = clamp(Math.round((pz - oz) / CAVE_CELL) + 1, 1, _slabN - 2);
    const h = _slabHeight[sk * _slabN + si];
    surfaceDepth[v] = h - py;
    // Nearest lattice sample. A marching-cubes vertex lies on a lattice edge,
    // so rounding lands on one of that edge's two endpoints; the consumer's
    // keep-if-ANY-vertex-carved rule supplies the one-cell margin that makes
    // the endpoint choice immaterial.
    const li = clamp(Math.round((px - ox) / CAVE_CELL), 0, nLat - 1);
    const lj = clamp(Math.round((py - oy) / CAVE_CELL), 0, nLat - 1);
    const lk = clamp(Math.round((pz - oz) / CAVE_CELL), 0, nLat - 1);
    carved[v] = _carvedLat[(lk * nLat + lj) * nLat + li];
    if (Math.abs(py - h) < 1.5) { materials[v] = CAVE_MATERIAL.MOUTH; continue; }
    if (grottoNear && mesh.normals[v * 3 + 1] < 0.2) {
      materials[v] = CAVE_MATERIAL.GROTTO;
      grotto++;
      continue;
    }
    materials[v] = CAVE_MATERIAL.INTERIOR;
  }

  // --- authored-site weight ----------------------------------------------
  // 0..1 per vertex: how strongly this vertex belongs to an authored cave
  // (world/cave_sites.js). The render pass drives the site's own surface
  // treatment off it, so it fades over ~8 m instead of cutting at an AABB
  // plane. Null (the common case) when no site is near the chunk; the extra
  // per-vertex query runs only inside a site's padded AABB.
  let authored = null;
  const sites = resolvedCaveSites();
  for (const r of sites) {
    const a = r.aabb;
    if (x1 < a.minX - 12 || ox > a.maxX + 12 || y1 < a.minY - 12 ||
        oy > a.maxY + 12 || z1 < a.minZ - 12 || oz > a.maxZ + 12) continue;
    if (!authored) authored = new Float32Array(mesh.vertexCount);
    for (let v = 0; v < mesh.vertexCount; v++) {
      const d = authoredOpennessAt(r, mesh.positions[v * 3],
        mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
      // A wall vertex sits within the perturbation amplitude (2.9 m) of the
      // authored surface, i.e. openness in about [-3, +3]; smoothstep from
      // -9 keeps the whole wall near 1 and lets the weight die in deep rock
      // and on far heightfield copies.
      const w = smoothstep(-9, -1, d);
      if (w > authored[v]) authored[v] = w;
    }
  }

  mesh.materials = materials;
  mesh.surfaceDepth = surfaceDepth;
  mesh.carved = carved;
  mesh.authored = authored;
  mesh.grottoFraction = mesh.vertexCount > 0 ? grotto / mesh.vertexCount : 0;
  mesh.origin = [ox, oy, oz];
  mesh.address = [cx, cy, cz];
  mesh.cellSize = CAVE_CELL;
  mesh.lattice = CAVE_LATTICE;
  return mesh;
}
