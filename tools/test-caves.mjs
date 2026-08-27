#!/usr/bin/env node
/**
 * SUBWAVE volumetric layer verification.
 *
 * Runs offline with no GPU. Two halves:
 *
 *   1. MARCHING CUBES AS A BLACK BOX. An analytic sphere SDF is marched and the
 *      result is proved CLOSED - every edge shared by exactly two triangles,
 *      every triangle wound outward - plus checks that the surface actually sits
 *      on the sphere. A mesher can look right in a screenshot and still leak;
 *      the edge-parity test is the only thing that catches it.
 *
 *   2. THE REAL FIELD. Twenty real chunks from the shipped seed, asserted finite,
 *      in range, indexed correctly, watertight across chunk seams, and
 *      bit-identical on a second generation.
 *
 * Every assertion prints the number it measured, not a claim about it.
 */
import { WORLD } from '../src/core/constants.js';
import * as terrain from '../src/world/terrain.js';
import * as caves from '../src/world/caves.js';

let fails = 0;
const ok = (cond, label, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label.padEnd(56)} ${detail ?? ''}`);
};

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

terrain.setSeed(WORLD.DEFAULT_SEED);
caves.setCaveSeed(WORLD.DEFAULT_SEED);

// ---------------------------------------------------------------------------

/**
 * Closed-mesh audit.
 *
 * A watertight indexed mesh has every DIRECTED edge (a,b) matched by exactly one
 * (b,a) somewhere else. That single condition catches all three ways a mesher
 * fails: a missing triangle (an edge with one use), a duplicated or inconsistent
 * one (an edge with three), and a flipped one (two uses in the SAME direction).
 */
function auditClosed(mesh) {
  const seen = new Map();
  let degenerate = 0;
  for (let t = 0; t < mesh.indexCount; t += 3) {
    const a = mesh.indices[t], b = mesh.indices[t + 1], c = mesh.indices[t + 2];
    if (a === b || b === c || a === c) { degenerate++; continue; }
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = p * 4294967296 + q;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
  }
  let unmatched = 0, overused = 0, sameDirection = 0;
  for (const [key, count] of seen) {
    if (count > 1) { sameDirection++; continue; }
    const p = Math.floor(key / 4294967296);
    const q = key - p * 4294967296;
    const back = seen.get(q * 4294967296 + p) || 0;
    if (back === 0) unmatched++;
    else if (back > 1) overused++;
  }
  return { unmatched, overused, sameDirection, degenerate, directedEdges: seen.size };
}

// ===========================================================================
console.log('\n== 1. marching cubes tables ==');
// ===========================================================================
{
  ok(caves.MC_EDGE_TABLE.length === 256, 'edge table has 256 entries',
    `${caves.MC_EDGE_TABLE.length}`);
  ok(caves.MC_TRI_TABLE.length === 256 * 16, 'triangle table is 256 x 16',
    `${caves.MC_TRI_TABLE.length} entries`);
  ok(caves.MC_EDGE_TABLE[0] === 0 && caves.MC_EDGE_TABLE[255] === 0,
    'empty and full cubes cross no edges',
    `${caves.MC_EDGE_TABLE[0]}, ${caves.MC_EDGE_TABLE[255]}`);

  // Every row's edges must be crossing edges of that configuration, and the row
  // must hold a whole number of triangles.
  let badEdge = 0, badCount = 0, populated = 0, maxTris = 0;
  const histogram = new Array(6).fill(0);
  for (let c = 0; c < 256; c++) {
    let n = 0;
    while (n < 16 && caves.MC_TRI_TABLE[c * 16 + n] >= 0) n++;
    if (n % 3 !== 0) badCount++;
    if (n > 0) populated++;
    const tris = n / 3;
    if (tris > maxTris) maxTris = tris;
    if (tris < 6) histogram[tris]++;
    for (let i = 0; i < n; i++) {
      const e = caves.MC_TRI_TABLE[c * 16 + i];
      if ((caves.MC_EDGE_TABLE[c] & (1 << e)) === 0) badEdge++;
    }
  }
  ok(badEdge === 0, 'no row uses a non-crossing edge', `${badEdge} violations`);
  ok(badCount === 0, 'every row is a whole number of triangles', `${badCount} violations`);
  ok(populated === 254, '254 of 256 configurations emit geometry', `${populated}`);
  ok(maxTris <= 5, 'no configuration needs more than 5 triangles', `max ${maxTris}`);
  console.log(`       triangles per configuration: ${histogram.map((v, i) => `${i}:${v}`).join('  ')}`);

  // Complement behaviour. Flipping every sign is the same surface seen from the
  // other side, so an UNAMBIGUOUS configuration must produce the same triangle
  // count as its complement. An ambiguous one need not, and does not: the
  // sign-only convention this table uses isolates the SOLID corners of an
  // ambiguous face, and complementing swaps which corners those are. That
  // asymmetry is a property of every classic marching cubes table, it is exactly
  // what the asymptotic decider replaces at march time, and it is watertight
  // either way - so what is asserted here is that it happens ONLY where a face
  // is ambiguous.
  const ambiguousFace = (c) => {
    const faces = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4],
                   [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5]];
    return faces.some((f) => {
      const s = f.map((k) => (c & (1 << k)) !== 0);
      return s[0] === s[2] && s[1] === s[3] && s[0] !== s[1];
    });
  };
  let asym = 0, asymUnambiguous = 0;
  for (let c = 0; c < 256; c++) {
    let n = 0, m = 0;
    while (n < 16 && caves.MC_TRI_TABLE[c * 16 + n] >= 0) n++;
    const d = (~c) & 0xff;
    while (m < 16 && caves.MC_TRI_TABLE[d * 16 + m] >= 0) m++;
    if (n !== m) {
      asym++;
      if (!ambiguousFace(c)) asymUnambiguous++;
    }
  }
  ok(asymUnambiguous === 0,
    'complement-symmetric wherever no face is ambiguous',
    `${asym} asymmetric rows, ${asymUnambiguous} of them unambiguous`);
}

// ===========================================================================
console.log('\n== 2. analytic sphere: closed, outward, on the surface ==');
// ===========================================================================
{
  // 33^3 lattice at 1 m over a sphere of radius 11.37 m, centred off-lattice so
  // no sample lands exactly on the surface and every one of the ambiguous face
  // cases gets exercised somewhere on the sphere.
  const N = 33;
  const CELL = 1.0;
  const R = 11.37;
  const C = [16.5 + 0.31, 16.5 - 0.17, 16.5 + 0.09];
  const field = new Float32Array(N * N * N);
  for (let k = 0; k < N; k++) {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const dx = i * CELL - C[0], dy = j * CELL - C[1], dz = k * CELL - C[2];
        // NEGATIVE inside, matching caveDensity's convention.
        field[(k * N + j) * N + i] = Math.sqrt(dx * dx + dy * dy + dz * dz) - R;
      }
    }
  }
  const mesh = caves.marchingCubes(field, [N, N, N], CELL, [0, 0, 0], 0);
  ok(mesh !== null, 'sphere produced a mesh', mesh ? `${mesh.vertexCount} verts, ${mesh.triangleCount} tris` : 'null');

  const audit = auditClosed(mesh);
  ok(audit.degenerate === 0, 'no degenerate triangles', `${audit.degenerate}`);
  ok(audit.sameDirection === 0, 'no directed edge used twice the same way',
    `${audit.sameDirection}`);
  ok(audit.unmatched === 0 && audit.overused === 0,
    'CLOSED: every edge shared by exactly 2 triangles',
    `${audit.directedEdges} directed edges, ${audit.unmatched} unmatched, ${audit.overused} over-used`);

  // Outward winding: the geometric normal of every triangle must point away from
  // the sphere centre.
  let inward = 0, worstDot = 1;
  for (let t = 0; t < mesh.indexCount; t += 3) {
    const a = mesh.indices[t] * 3, b = mesh.indices[t + 1] * 3, c = mesh.indices[t + 2] * 3;
    const p = mesh.positions;
    const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2],
               e1[0] * e2[1] - e1[1] * e2[0]];
    const cxx = (p[a] + p[b] + p[c]) / 3 - C[0];
    const cyy = (p[a + 1] + p[b + 1] + p[c + 1]) / 3 - C[1];
    const czz = (p[a + 2] + p[b + 2] + p[c + 2]) / 3 - C[2];
    const nl = Math.hypot(n[0], n[1], n[2]);
    const cl = Math.hypot(cxx, cyy, czz);
    const d = nl > 0 && cl > 0 ? (n[0] * cxx + n[1] * cyy + n[2] * czz) / (nl * cl) : 1;
    if (d <= 0) inward++;
    if (d < worstDot) worstDot = d;
  }
  ok(inward === 0, 'every triangle wound OUTWARD (normal . radial > 0)',
    `${inward} inward, worst cos ${worstDot.toFixed(4)}`);

  // Vertex normals must agree with the analytic radial direction.
  let worstNormal = 1, sumNormal = 0;
  for (let v = 0; v < mesh.vertexCount; v++) {
    const rx = mesh.positions[v * 3] - C[0];
    const ry = mesh.positions[v * 3 + 1] - C[1];
    const rz = mesh.positions[v * 3 + 2] - C[2];
    const rl = Math.hypot(rx, ry, rz);
    const d = (mesh.normals[v * 3] * rx + mesh.normals[v * 3 + 1] * ry +
               mesh.normals[v * 3 + 2] * rz) / rl;
    sumNormal += d;
    if (d < worstNormal) worstNormal = d;
  }
  ok(worstNormal > 0.90, 'vertex normals point radially outward',
    `mean cos ${(sumNormal / mesh.vertexCount).toFixed(5)}, worst ${worstNormal.toFixed(4)}`);

  // Interpolated (not midpoint) placement: the radial distance of every vertex
  // must be within a small fraction of a cell of R. A midpoint mesher would
  // scatter these over +-0.5 m.
  let maxErr = 0, sumErr = 0;
  for (let v = 0; v < mesh.vertexCount; v++) {
    const rx = mesh.positions[v * 3] - C[0];
    const ry = mesh.positions[v * 3 + 1] - C[1];
    const rz = mesh.positions[v * 3 + 2] - C[2];
    const e = Math.abs(Math.hypot(rx, ry, rz) - R);
    sumErr += e;
    if (e > maxErr) maxErr = e;
  }
  ok(maxErr < 0.09, 'vertices lie on the sphere (edge interpolation, not midpoint)',
    `max error ${maxErr.toFixed(4)} m, mean ${(sumErr / mesh.vertexCount).toFixed(5)} m`);

  // Surface area against 4*pi*R^2. A leaking or doubled mesh fails this even
  // when the parity audit passes.
  let area = 0;
  for (let t = 0; t < mesh.indexCount; t += 3) {
    const a = mesh.indices[t] * 3, b = mesh.indices[t + 1] * 3, c = mesh.indices[t + 2] * 3;
    const p = mesh.positions;
    const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2],
               e1[0] * e2[1] - e1[1] * e2[0]];
    area += 0.5 * Math.hypot(n[0], n[1], n[2]);
  }
  const exact = 4 * Math.PI * R * R;
  ok(Math.abs(area / exact - 1) < 0.02, 'surface area within 2% of 4*pi*R^2',
    `${area.toFixed(1)} m^2 vs ${exact.toFixed(1)} m^2 (${((area / exact - 1) * 100).toFixed(2)}%)`);

  // Euler characteristic of a sphere is 2. V - E + F, with E = 3F/2 for a closed
  // triangle mesh, is the strongest single statement about topology available.
  const F = mesh.triangleCount;
  const E = (3 * F) / 2;
  const chi = mesh.vertexCount - E + F;
  ok(chi === 2, 'Euler characteristic V - E + F = 2 (one sphere, no holes)',
    `V ${mesh.vertexCount} E ${E} F ${F} chi ${chi}`);
}

// ===========================================================================
console.log('\n== 3. two nested shells: multi-component and inverted surfaces ==');
// ===========================================================================
{
  // A spherical SHELL: solid between r = 6 and r = 12. Its iso-surface has two
  // components with OPPOSITE orientations, which is where a mesher that decides
  // winding from a global heuristic falls over.
  const N = 33, CELL = 1.0;
  const C = [16.5 + 0.23, 16.5 + 0.11, 16.5 - 0.37];
  const field = new Float32Array(N * N * N);
  for (let k = 0; k < N; k++) {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const r = Math.hypot(i - C[0], j - C[1], k - C[2]);
        // Negative (solid) only inside the shell.
        field[(k * N + j) * N + i] = Math.max(6.0 - r, r - 12.0);
      }
    }
  }
  const mesh = caves.marchingCubes(field, [N, N, N], CELL, [0, 0, 0], 0);
  const audit = auditClosed(mesh);
  ok(audit.unmatched === 0 && audit.overused === 0 && audit.sameDirection === 0,
    'shell is CLOSED', `${mesh.triangleCount} tris, ${audit.unmatched} unmatched`);
  const chi = mesh.vertexCount - (3 * mesh.triangleCount) / 2 + mesh.triangleCount;
  ok(chi === 4, 'Euler characteristic 4 (two closed spheres)', `chi ${chi}`);

  // The inner surface must be wound INWARD in world terms, because its solid is
  // on the outside: normal . radial < 0 there.
  let innerOut = 0, outerIn = 0;
  for (let v = 0; v < mesh.vertexCount; v++) {
    const rx = mesh.positions[v * 3] - C[0];
    const ry = mesh.positions[v * 3 + 1] - C[1];
    const rz = mesh.positions[v * 3 + 2] - C[2];
    const rl = Math.hypot(rx, ry, rz);
    const d = (mesh.normals[v * 3] * rx + mesh.normals[v * 3 + 1] * ry +
               mesh.normals[v * 3 + 2] * rz) / rl;
    if (rl < 9 && d > 0) innerOut++;
    if (rl >= 9 && d < 0) outerIn++;
  }
  ok(innerOut === 0 && outerIn === 0,
    'normals point out of the SOLID on both surfaces',
    `${innerOut} wrong inner, ${outerIn} wrong outer`);
}

// ===========================================================================
console.log('\n== 4. field sanity ==');
// ===========================================================================
{
  const r = rng(0x1EAF);
  let nan = 0, samples = 0, open = 0, solid = 0;
  let minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < 20000; i++) {
    const x = (r() * 2 - 1) * 2600;
    const z = (r() * 2 - 1) * 2600;
    const y = WORLD.CAVE_MIN_Y + r() * (WORLD.CAVE_MAX_Y - WORLD.CAVE_MIN_Y);
    const d = caves.caveDensity(x, y, z);
    samples++;
    if (!Number.isFinite(d)) nan++;
    if (d > 0) open++; else solid++;
    if (d < minV) minV = d;
    if (d > maxV) maxV = d;
  }
  ok(nan === 0, 'no NaN or Infinity in 20k field samples', `${nan} of ${samples}`);
  ok(open > 0 && solid > 0, 'the field has both open and solid regions',
    `${((open / samples) * 100).toFixed(1)}% open, ${((solid / samples) * 100).toFixed(1)}% solid`);
  console.log(`       range [${minV.toFixed(1)}, ${maxV.toFixed(1)}] m`);

  // Well above the terrain the field must equal the plain height difference, or
  // the caves and the heightfield disagree about where the ground is.
  let maxDelta = 0;
  for (let i = 0; i < 400; i++) {
    const x = (r() * 2 - 1) * 2400;
    const z = (r() * 2 - 1) * 2400;
    const h = terrain.sampleHeight(x, z);
    const y = h + 40;
    if (y > WORLD.CAVE_MAX_Y) continue;
    maxDelta = Math.max(maxDelta, Math.abs(caves.caveDensity(x, y, z) - 40));
  }
  ok(maxDelta < 1e-9, '40 m above the seabed the field IS the height difference',
    `max deviation ${maxDelta.toExponential(2)} m`);

  // The safe crater must contain no cave geometry whatsoever.
  let craterCaves = 0;
  for (let i = 0; i < 6000; i++) {
    const a = r() * Math.PI * 2;
    const rr = Math.sqrt(r()) * WORLD.SAFE_FALLOFF_RADIUS;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    const h = terrain.sampleHeight(x, z);
    for (let d = 2; d < 60; d += 6) {
      if (caves.isInsideCave(x, h - d, z)) { craterCaves++; break; }
    }
  }
  ok(craterCaves === 0, 'no cave anywhere under the safe crater',
    `${craterCaves} of 6000 columns`);
}

// ===========================================================================
console.log('\n== 5. isInsideCave / raycastCave ==');
// ===========================================================================
{
  // Find a real cave void by scanning columns in a cave-rich band, then verify
  // the point queries and the ray marcher agree about it.
  const r = rng(0xCA7E);
  let found = null;
  for (let i = 0; i < 4000 && !found; i++) {
    const a = r() * Math.PI * 2;
    const rr = 900 + r() * 1500;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    const h = terrain.sampleHeight(x, z);
    for (let d = 8; d < 150; d += 2) {
      const y = h - d;
      if (y < WORLD.CAVE_MIN_Y) break;
      if (caves.isInsideCave(x, y, z)) { found = [x, y, z]; break; }
    }
  }
  ok(found !== null, 'found a real cave void by column scan',
    found ? `(${found[0].toFixed(1)}, ${found[1].toFixed(1)}, ${found[2].toFixed(1)})` : 'none in 4000 columns');

  if (found) {
    const [x, y, z] = found;
    ok(caves.caveDensity(x, y, z) > 0, 'the void sample reads OPEN',
      `${caves.caveDensity(x, y, z).toFixed(3)} m`);
    ok(!caves.isInsideCave(x, terrain.sampleHeight(x, z) + 5, z),
      'open water above the seabed is NOT "inside a cave"');

    // Cast in the six axis directions. From inside a void every ray must hit
    // rock within a plausible distance, and the hit normal must face the ray.
    const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    let hits = 0, badNormal = 0, maxT = 0;
    const hit = caves.createCaveHit();
    for (const d of dirs) {
      caves.raycastCave([x, y, z], d, 400, hit);
      if (hit.hit) {
        hits++;
        maxT = Math.max(maxT, hit.t);
        // The surface normal points out of the rock, so it opposes the ray.
        if (hit.normal[0] * d[0] + hit.normal[1] * d[1] + hit.normal[2] * d[2] > 0.02) badNormal++;
        const dAt = caves.caveDensity(hit.point[0], hit.point[1], hit.point[2]);
        if (Math.abs(dAt) > 0.05) badNormal++;
      }
    }
    ok(hits === 6, 'all six axis rays from inside the void hit rock', `${hits}/6, max t ${maxT.toFixed(1)} m`);
    ok(badNormal === 0, 'hit points sit on the surface with normals facing the ray',
      `${badNormal} bad`);

    // A ray that starts in rock reports an immediate hit rather than silence.
    // 400 m below the seabed is past the fissure band and outside any tunnel, so
    // it is unambiguously solid.
    const deepY = terrain.sampleHeight(x, z) - 400;
    const density = caves.caveDensity(x, deepY, z);
    caves.raycastCave([x, deepY, z], [0, 1, 0], 50, hit);
    ok(density < 0, '400 m below the seabed is solid', `density ${density.toFixed(1)} m`);
    ok(hit.hit && hit.t === 0, 'a ray starting inside rock reports t = 0',
      `hit ${hit.hit}, t ${hit.t}`);
  }
}

// ===========================================================================
console.log('\n== 6. twenty real chunks ==');
// ===========================================================================
const generated = [];
{
  const r = rng(0xDEC0DE);
  let tried = 0, produced = 0, rejected = 0;
  let nanCount = 0, badIndex = 0, outOfBounds = 0, notClosedAtInterior = 0;
  let caveBearing = 0;
  let totalVerts = 0, totalTris = 0;
  let worstAudit = null;
  const t0 = process.hrtime.bigint();

  while (produced < 20 && tried < 3000) {
    tried++;
    // Bias the search into the cave-rich mid slopes rather than the open plain.
    const a = r() * Math.PI * 2;
    const rr = 700 + r() * 1800;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    const h = terrain.sampleHeight(x, z);
    const y = h - 6 - r() * 80;
    const cx = Math.floor(x / caves.CAVE_CHUNK_SIZE);
    const cy = Math.floor(y / caves.CAVE_CHUNK_SIZE);
    const cz = Math.floor(z / caves.CAVE_CHUNK_SIZE);
    if (generated.some((g) => g.address[0] === cx && g.address[1] === cy && g.address[2] === cz)) continue;

    if (caves.caveOccupancy(cx, cy, cz) === 0) {
      // Contract: occupancy 0 means generateCaveChunk MUST return null.
      if (caves.generateCaveChunk(cx, cy, cz) !== null) rejected++;
      continue;
    }
    const mesh = caves.generateCaveChunk(cx, cy, cz);
    if (!mesh) continue;
    produced++;
    generated.push(mesh);
    totalVerts += mesh.vertexCount;
    totalTris += mesh.triangleCount;

    for (let i = 0; i < mesh.positions.length; i++) {
      if (!Number.isFinite(mesh.positions[i])) nanCount++;
    }
    for (let i = 0; i < mesh.normals.length; i++) {
      if (!Number.isFinite(mesh.normals[i])) nanCount++;
    }
    for (let i = 0; i < mesh.indexCount; i++) {
      if (mesh.indices[i] >= mesh.vertexCount) badIndex++;
    }
    // Every vertex inside the sampled lattice box, with a hair of tolerance.
    const span = caves.CAVE_CHUNK_SIZE + 2 * caves.CAVE_SKIRT * caves.CAVE_CELL;
    for (let v = 0; v < mesh.vertexCount; v++) {
      for (let c = 0; c < 3; c++) {
        const p = mesh.positions[v * 3 + c];
        if (p < mesh.origin[c] - 1e-4 || p > mesh.origin[c] + span + 1e-4) outOfBounds++;
      }
    }
    // Unit normals.
    for (let v = 0; v < mesh.vertexCount; v++) {
      const l = Math.hypot(mesh.normals[v * 3], mesh.normals[v * 3 + 1], mesh.normals[v * 3 + 2]);
      if (Math.abs(l - 1) > 1e-3) nanCount++;
    }

    // A chunk's mesh is a surface with a boundary where it meets the lattice
    // box, so it is NOT closed. What must hold is that every edge NOT on that
    // boundary is shared by exactly two triangles - an interior hole is a bug,
    // an open rim is the design.
    // A chunk carries real VOLUMETRIC geometry when some of its vertices are not
    // cave mouths: a MOUTH vertex sits on the heightfield surface and would exist
    // without the volumetric layer, an INTERIOR or GROTTO one would not.
    let volumetric = false;
    for (let v = 0; v < mesh.vertexCount; v++) {
      if (mesh.materials[v] !== caves.CAVE_MATERIAL.MOUTH) { volumetric = true; break; }
    }
    if (volumetric) caveBearing++;
    mesh.volumetric = volumetric;

    const audit = auditInteriorClosed(mesh, span);
    if (audit.interiorUnmatched > 0 || audit.sameDirection > 0) {
      notClosedAtInterior++;
      if (!worstAudit) worstAudit = { address: mesh.address, ...audit };
    }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  ok(produced === 20, 'generated 20 non-empty cave chunks',
    `${produced} from ${tried} probes, ${ms.toFixed(0)} ms total, ${(ms / Math.max(1, produced)).toFixed(1)} ms each`);
  ok(rejected === 0, 'occupancy 0 always means an empty chunk', `${rejected} contract breaks`);
  ok(nanCount === 0, 'no NaN and every normal unit length', `${nanCount} bad floats`);
  ok(badIndex === 0, 'every index inside the vertex range', `${badIndex} out of range`);
  ok(outOfBounds === 0, 'every vertex inside its lattice box', `${outOfBounds} outside`);
  ok(caveBearing > 0, 'some chunks carry real volumetric geometry',
    `${caveBearing} of ${produced} have non-mouth vertices`);
  ok(notClosedAtInterior === 0, 'no interior hole in any chunk',
    worstAudit ? `chunk ${worstAudit.address} has ${worstAudit.interiorUnmatched} unmatched` : '0 chunks with holes');
  console.log(`       ${totalVerts} vertices, ${totalTris} triangles, ` +
              `mean ${(totalVerts / Math.max(1, produced)).toFixed(0)} verts / ` +
              `${(totalTris / Math.max(1, produced)).toFixed(0)} tris per chunk`);
}

/** Edge parity, ignoring edges that lie on the lattice box (the open rim). */
function auditInteriorClosed(mesh, span) {
  const onBoundary = new Uint8Array(mesh.vertexCount);
  for (let v = 0; v < mesh.vertexCount; v++) {
    for (let c = 0; c < 3; c++) {
      const p = mesh.positions[v * 3 + c] - mesh.origin[c];
      // A vertex within a hundredth of a cell of a box face is on the rim. MC
      // clamps edge parameters to [0.001, 0.999], so a rim vertex is never
      // exactly on the plane.
      if (p < 0.02 || p > span - 0.02) onBoundary[v] = 1;
    }
  }
  const seen = new Map();
  for (let t = 0; t < mesh.indexCount; t += 3) {
    const a = mesh.indices[t], b = mesh.indices[t + 1], c = mesh.indices[t + 2];
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = p * 4294967296 + q;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
  }
  let interiorUnmatched = 0, sameDirection = 0;
  for (const [key, count] of seen) {
    if (count > 1) { sameDirection++; continue; }
    const p = Math.floor(key / 4294967296);
    const q = key - p * 4294967296;
    if ((seen.get(q * 4294967296 + p) || 0) === 0) {
      if (!onBoundary[p] || !onBoundary[q]) interiorUnmatched++;
    }
  }
  return { interiorUnmatched, sameDirection };
}

// ===========================================================================
console.log('\n== 7. determinism ==');
// ===========================================================================
{
  let mismatch = 0, checked = 0;
  for (const first of generated.slice(0, 8)) {
    const again = caves.generateCaveChunk(first.address[0], first.address[1], first.address[2]);
    checked++;
    if (!again || again.vertexCount !== first.vertexCount || again.indexCount !== first.indexCount) {
      mismatch++;
      continue;
    }
    for (let i = 0; i < first.positions.length; i++) {
      if (first.positions[i] !== again.positions[i]) { mismatch++; break; }
    }
    for (let i = 0; i < first.indexCount; i++) {
      if (first.indices[i] !== again.indices[i]) { mismatch++; break; }
    }
  }
  ok(mismatch === 0, 'regenerating a chunk gives bit-identical buffers',
    `${checked} chunks, ${mismatch} mismatches`);

  // The cache must not be load-bearing: clearing it has to change nothing.
  const target = generated[0];
  caves.clearCaveCache();
  const cold = caves.generateCaveChunk(target.address[0], target.address[1], target.address[2]);
  let coldDelta = 0;
  if (!cold || cold.vertexCount !== target.vertexCount) coldDelta = -1;
  else {
    for (let i = 0; i < target.positions.length; i++) {
      if (target.positions[i] !== cold.positions[i]) coldDelta++;
    }
  }
  ok(coldDelta === 0, 'a cold macro-cell cache produces the identical chunk',
    `${coldDelta} differing floats`);

  // A different cave seed must produce a different world. Checked over all the
  // chunks rather than one, because a chunk whose only surface is the heightfield
  // is legitimately seed-independent - the terrain seed did not change.
  caves.setCaveSeed(0x13579bdf);
  let differing = 0, volumetric = 0, volumetricSame = 0;
  for (const g of generated) {
    const other = caves.generateCaveChunk(g.address[0], g.address[1], g.address[2]);
    const same = other && other.vertexCount === g.vertexCount &&
      !other.positions.some((v, i) => v !== g.positions[i]);
    if (!same) differing++;
    if (g.volumetric) { volumetric++; if (same) volumetricSame++; }
  }
  ok(volumetricSame === 0,
    'a different cave seed changes every chunk that HAS caves in it',
    `${differing} of ${generated.length} changed; ${volumetric} volumetric, ${volumetricSame} unchanged`);
  caves.setCaveSeed(null);
  ok(caves.setCaveSeed(null) === WORLD.DEFAULT_SEED,
    'clearing the pin returns to the terrain seed', `${WORLD.DEFAULT_SEED}`);
}

// ===========================================================================
console.log('\n== 8. chunk seams are watertight ==');
// ===========================================================================
{
  // Two chunks sharing a face must evaluate the shared lattice plane at
  // bit-identical world coordinates and therefore produce bit-identical
  // vertices on it. That, plus each chunk being interior-closed, is what makes
  // the union of the chunks a closed surface.
  let pairs = 0, matched = 0, missing = 0, positionMismatch = 0;
  for (const mesh of generated.slice(0, 6)) {
    const [cx, cy, cz] = mesh.address;
    for (const [dx, dy, dz] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
      const nb = caves.generateCaveChunk(cx + dx, cy + dy, cz + dz);
      if (!nb) continue;
      pairs++;
      // The shared lattice plane: the low chunk's core face at the neighbour's
      // origin edge. Collect vertices of each mesh that lie exactly on it.
      const axis = dx ? 0 : dy ? 1 : 2;
      const plane = (dx ? (cx + 1) : dy ? (cy + 1) : (cz + 1)) * caves.CAVE_CHUNK_SIZE;
      const keyOf = (m, v) => {
        const p = [m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]];
        return `${p[0].toFixed(6)},${p[1].toFixed(6)},${p[2].toFixed(6)}`;
      };
      const onPlane = (m, v) => Math.abs(m.positions[v * 3 + axis] - plane) < 1e-6;
      const own = new Set();
      for (let v = 0; v < mesh.vertexCount; v++) if (onPlane(mesh, v)) own.add(keyOf(mesh, v));
      let nbOnPlane = 0;
      for (let v = 0; v < nb.vertexCount; v++) {
        if (!onPlane(nb, v)) continue;
        nbOnPlane++;
        if (own.has(keyOf(nb, v))) matched++;
        else missing++;
      }
      if (nbOnPlane > 0 && own.size !== nbOnPlane) positionMismatch++;
    }
  }
  ok(pairs > 0, 'found neighbouring chunk pairs to compare', `${pairs} pairs`);
  ok(missing === 0, 'every vertex on a shared plane exists in BOTH chunks',
    `${matched} matched, ${missing} missing`);
  ok(positionMismatch === 0, 'the two chunks agree on the plane vertex COUNT',
    `${positionMismatch} disagreements`);
}

// ===========================================================================
console.log('\n== 9. mesh agrees with the field ==');
// ===========================================================================
{
  // Every vertex the mesher emitted must sit on the iso-surface of the
  // authoritative field. This is the assertion that catches a generateCaveChunk
  // that hoisted something the point query does not, which would put collision
  // and rendering in different places.
  let worst = 0, worstAt = null, checked = 0;
  const r = rng(0x5EAF);
  for (const mesh of generated) {
    for (let s = 0; s < 60; s++) {
      const v = Math.floor(r() * mesh.vertexCount);
      const x = mesh.positions[v * 3], y = mesh.positions[v * 3 + 1], z = mesh.positions[v * 3 + 2];
      const d = caves.caveDensity(x, y, z);
      checked++;
      if (Math.abs(d) > worst) { worst = Math.abs(d); worstAt = [x, y, z]; }
    }
  }
  // The tolerance is the linear-interpolation error over one cell. The mesher
  // places a vertex by linear interpolation between two samples 1 m apart, and
  // the true field is not linear over that metre - it is a max() of noisy terms,
  // so it has kinks. Two metres bounds the observed error with margin; anything
  // tighter would need the cell sub-sampled, which is the wrong trade at 1 m
  // voxels because the geometry is already smaller than the error is.
  ok(worst < 2.0, 'every sampled vertex is within 2 m of the field zero',
    `worst |density| ${worst.toFixed(4)} m over ${checked} vertices` +
    (worstAt ? ` at (${worstAt.map((v) => v.toFixed(1)).join(', ')})` : ''));
}

// ===========================================================================
console.log('\n== 10. cave mouths and navigable connectivity ==');
// ===========================================================================
{
  // (a) MOUTHS EXIST. caves.js claims every root tunnel is prefixed with a
  // capsule that rises above the terrain surface, so its void is contiguous with
  // open water. A mouth is therefore a column where the void reaches within a
  // metre or two of the seabed: count them.
  const r = rng(0x60D5);
  let columns = 0, surfaceOpenings = 0;
  for (let i = 0; i < 30000; i++) {
    const a = r() * Math.PI * 2;
    const rr = 700 + r() * 1900;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    const h = terrain.sampleHeight(x, z);
    if (h > -6 || h < WORLD.CAVE_MIN_Y) continue;
    columns++;
    if (caves.caveDensity(x, h - 1.5, z) > 0) surfaceOpenings++;
  }
  ok(surfaceOpenings > 0, 'cave mouths break the seabed surface',
    `${surfaceOpenings} of ${columns} probe columns ` +
    `(${((surfaceOpenings / columns) * 100).toFixed(2)}%)`);
  ok(surfaceOpenings / columns < 0.25, 'and the seabed is not mostly holes',
    `${((surfaceOpenings / columns) * 100).toFixed(2)}% open at the surface`);

  // (b) NAVIGABLE CONNECTIVITY, by flood fill. From a void seed, fill through
  // open space on a 2 m grid inside a 100 m box (small enough to run offline,
  // 2 m because the narrowest tunnel radius in the biome table is 1.6 m and a
  // coarser grid would fail to squeeze through its own passages). The fill
  // ESCAPES if it reaches a cell above the local seabed, i.e. open water.
  // 1.5 m cells with FACE-AND-EDGE adjacency, which is a fair proxy for a
  // swimmer: the player capsule is 0.68 m across, the narrowest tunnel in the
  // biome table is 3.2 m across, and a 1.5 m grid that allows edge-diagonal moves
  // squeezes through a passage of about that width without leaking through a
  // corner contact the way full 26-adjacency would.
  const GRID = 1.5;
  const HALF = 24;                       // cells each way, so a 72 m box
  const SIDE = HALF * 2 + 1;
  // The 18 face and edge neighbours of a cell.
  const NEIGHBOURS = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const m = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
        if (m === 1 || m === 2) NEIGHBOURS.push(dx, dy, dz);
      }
    }
  }
  const NEIGHBOUR_COUNT = NEIGHBOURS.length / 3;
  const open = new Uint8Array(SIDE * SIDE * SIDE);
  const seen = new Uint8Array(SIDE * SIDE * SIDE);
  const queue = new Int32Array(SIDE * SIDE * SIDE);

  const floodEscapes = (sx, sy, sz) => {
    open.fill(0);
    seen.fill(0);
    for (let k = 0; k < SIDE; k++) {
      const z = sz + (k - HALF) * GRID;
      for (let i = 0; i < SIDE; i++) {
        const x = sx + (i - HALF) * GRID;
        const h = terrain.sampleHeight(x, z);
        for (let j = 0; j < SIDE; j++) {
          const y = sy + (j - HALF) * GRID;
          // 2 marks "open water", 1 marks "open cave".
          if (caves.caveDensity(x, y, z) <= 0) continue;
          open[(k * SIDE + j) * SIDE + i] = y > h ? 2 : 1;
        }
      }
    }
    let head = 0, tail = 0;
    const seed = ((HALF * SIDE) + HALF) * SIDE + HALF;
    if (!open[seed]) return null;
    queue[tail++] = seed;
    seen[seed] = 1;
    let cells = 0;
    while (head < tail) {
      const cur = queue[head++];
      cells++;
      if (open[cur] === 2) return { escaped: true, cells };
      const i = cur % SIDE;
      const j = ((cur - i) / SIDE) % SIDE;
      const k = (cur - i - j * SIDE) / (SIDE * SIDE);
      for (let d = 0; d < NEIGHBOUR_COUNT; d++) {
        const ni = i + NEIGHBOURS[d * 3];
        const nj = j + NEIGHBOURS[d * 3 + 1];
        const nk = k + NEIGHBOURS[d * 3 + 2];
        if (ni < 0 || ni >= SIDE || nj < 0 || nj >= SIDE || nk < 0 || nk >= SIDE) continue;
        const n = (nk * SIDE + nj) * SIDE + ni;
        if (seen[n] || !open[n]) continue;
        seen[n] = 1;
        queue[tail++] = n;
      }
    }
    return { escaped: false, cells };
  };

  // Collect every root-tunnel mouth the generator recorded across a slab of macro
  // cells. This is the exact object the connectivity guarantee is about: caves.js
  // prefixes every root walk with a capsule from above the terrain surface down to
  // the walk's first point, and caveSkeleton() reports that point. Seeding on a
  // column probe instead would sample overhang voids and isolated fissure pockets,
  // neither of which the design claims is reachable, and would test nothing.
  const mouths = [];
  let xzCells = 0;
  for (let mz = -4; mz <= 4; mz++) {
    for (let mx = -4; mx <= 4; mx++) {
      // A tunnel is owned by whichever Y cell its start lands in, so the whole
      // vertical stack has to be visited to count one XZ column's tunnels.
      const cxm = (mx + 0.5) * caves.CAVE_MACRO_SIZE;
      const czm = (mz + 0.5) * caves.CAVE_MACRO_SIZE;
      if (Math.hypot(cxm, czm) > 2600) continue;
      xzCells++;
      for (let my = 1; my >= -3; my--) {
        const sk = caves.caveSkeleton(mx, my, mz);
        for (let m = 0; m < sk.mouthCount; m++) {
          mouths.push([sk.mouths[m * 3], sk.mouths[m * 3 + 1], sk.mouths[m * 3 + 2]]);
        }
      }
    }
  }
  // The biome table quotes 0.10 to 2.40 root tunnels per 512 m cell; the playable
  // area is mostly the low end of that (sand, reef, kelp), so the mean over this
  // region belongs between those bounds and nearer the bottom.
  ok(mouths.length > 15, 'the graph has root tunnels to test',
    `${mouths.length} mouths over ${xzCells} XZ macro cells ` +
    `= ${(mouths.length / xzCells).toFixed(2)} per cell`);

  // (b) THE MOUTH SHAFT IS NEVER PINCHED SHUT. The mouth capsule is a vertical
  // segment from the tunnel's first point up past the terrain surface, so the
  // route out is literally the line x = const, z = const. Walking it at 0.25 m and
  // asserting the field stays OPEN is a direct test of the guarantee, and it is
  // what caught the wall perturbation closing narrow tunnels: a flat 2.9 m offset
  // against a 1.6 m radius severed one mouth in eight.
  let shafts = 0, pinched = 0, worstPinch = 0;
  for (const [x, y, z] of mouths) {
    const h = terrain.sampleHeight(x, z);
    if (h < y) continue;
    shafts++;
    let minD = Infinity;
    for (let yy = y; yy <= h + 0.5; yy += 0.25) {
      minD = Math.min(minD, caves.caveDensity(x, yy, z));
    }
    if (minD <= 0) { pinched++; if (minD < worstPinch) worstPinch = minD; }
  }
  ok(pinched === 0, 'every mouth shaft is OPEN from the tunnel to the seabed',
    `${shafts} shafts walked at 0.25 m, ${pinched} pinched` +
    (pinched ? `, worst ${worstPinch.toFixed(2)} m` : ''));

  // (c) NAVIGABLE BY FLOOD FILL. Restricted to mouths within reach of the test
  // box - a 72 m box cannot prove anything about a tunnel that starts 130 m below
  // the seabed, and inflating the box to cover those would cost half a million
  // more field evaluations per fill for no extra information.
  let tested = 0, escaped = 0, totalCells = 0;
  const t0 = process.hrtime.bigint();
  for (const [x, y, z] of mouths) {
    if (tested >= 8) break;
    const h = terrain.sampleHeight(x, z);
    if (h - y > HALF * GRID - 6) continue;
    if (caves.caveDensity(x, y, z) <= 0) continue;
    const res = floodEscapes(x, y, z);
    if (!res) continue;
    tested++;
    totalCells += res.cells;
    if (res.escaped) escaped++;
  }
  const floodMs = Number(process.hrtime.bigint() - t0) / 1e6;
  ok(tested >= 6, 'flood-filled real root-tunnel interiors',
    `${tested} tunnels, ${(totalCells / Math.max(1, tested)).toFixed(0)} cells reached on average, ${floodMs.toFixed(0)} ms`);
  ok(escaped === tested,
    'EVERY reachable-box root tunnel reaches open water by a connected path',
    `${escaped} of ${tested} escaped`);
}

// ===========================================================================
console.log('\n== 11. cost ==');
// ===========================================================================
{
  const target = generated[0].address;
  caves.clearCaveCache();
  let t = process.hrtime.bigint();
  caves.generateCaveChunk(target[0], target[1], target[2]);
  const cold = Number(process.hrtime.bigint() - t) / 1e6;
  t = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) caves.generateCaveChunk(target[0], target[1], target[2]);
  const warm = Number(process.hrtime.bigint() - t) / 1e6 / 5;
  ok(warm < 60, 'a warm chunk generates in under 60 ms',
    `cold ${cold.toFixed(1)} ms, warm ${warm.toFixed(1)} ms`);

  t = process.hrtime.bigint();
  let n = 0;
  for (let i = 0; i < 20000; i++) { caves.caveDensity(400 + i * 0.01, -60, 900); n++; }
  const perSample = Number(process.hrtime.bigint() - t) / n / 1000;
  ok(perSample < 20, 'a point query costs under 20 us', `${perSample.toFixed(3)} us`);

  t = process.hrtime.bigint();
  let rejects = 0;
  for (let i = 0; i < 400; i++) {
    if (caves.caveOccupancy(i - 200, -3, 40) === 0) rejects++;
  }
  const perOcc = Number(process.hrtime.bigint() - t) / 400 / 1000;
  ok(perOcc < 2000, 'occupancy rejects cheaply',
    `${perOcc.toFixed(1)} us per call, ${rejects}/400 rejected`);
}

// ===========================================================================
console.log(`\n${fails === 0 ? 'ALL CAVE TESTS PASSED' : `${fails} CAVE TEST(S) FAILED`}\n`);
process.exit(fails === 0 ? 0 : 1);
