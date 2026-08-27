#!/usr/bin/env node
/**
 * SUBWAVE terrain / biome / chunk verification.
 *
 * Runs offline with no GPU: the ChunkManager section drives the real streaming
 * loop against a stub device that only counts allocations, which is enough to
 * verify the budget, the pool and the load/unload lifecycle. What it CANNOT
 * verify is anything the GPU does - pipeline creation, the shader itself, and
 * whether the picture is right. Use tools/wgsl-compile.mjs for the shader.
 *
 * Every assertion prints the number it measured, not a claim about it.
 */
import { WORLD, WATER_TYPES, TRUE_DARK_DEPTH } from '../src/core/constants.js';
import { readFileSync } from 'node:fs';
import * as terrain from '../src/world/terrain.js';
import * as biomes from '../src/world/biomes.js';
import { ChunkManager } from '../src/world/chunks.js';

let fails = 0;
const ok = (cond, label, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label.padEnd(52)} ${detail ?? ''}`);
};

// Deterministic PRNG so the run itself is reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

terrain.setSeed(WORLD.DEFAULT_SEED);

console.log('\n== 1. world height range (100k samples over the playfield) ==');
{
  const r = rng(0xC0FFEE);
  let lo = Infinity, hi = -Infinity, loP = null, hiP = null;
  for (let i = 0; i < 100000; i++) {
    const x = (r() * 2 - 1) * WORLD.HALF_EXTENT;
    const z = (r() * 2 - 1) * WORLD.HALF_EXTENT;
    const h = terrain.sampleHeight(x, z);
    if (h < lo) { lo = h; loP = [x, z]; }
    if (h > hi) { hi = h; hiP = [x, z]; }
  }
  ok(lo >= -1650 && hi <= 220, 'all 100k samples within [-1650, 220]',
    `min ${lo.toFixed(2)} @ (${loP[0].toFixed(0)},${loP[1].toFixed(0)})  max ${hi.toFixed(2)} @ (${hiP[0].toFixed(0)},${hiP[1].toFixed(0)})`);
  ok(lo < -1400, 'the trench reaches below -1400 m somewhere', `deepest ${lo.toFixed(2)} m`);
  ok(hi > 150, 'the island rises well above sea level', `highest ${hi.toFixed(2)} m`);
}

console.log('\n== 2. summit reaches MAX_TERRAIN_HEIGHT ==');
{
  let hi = -Infinity, p = null;
  for (let x = -560; x <= -420; x += 0.5) {
    for (let z = -730; z <= -580; z += 0.5) {
      const h = terrain.sampleHeight(x, z);
      if (h > hi) { hi = h; p = [x, z]; }
    }
  }
  ok(hi > 205 && hi <= WORLD.MAX_TERRAIN_HEIGHT, 'summit within 10 m of the 214 m cap',
    `${hi.toFixed(2)} m at (${p[0]},${p[1]})`);
}

console.log('\n== 3. the safe crater (2000 samples inside r = 340 m) ==');
{
  const r = rng(0xBEEF);
  let lo = Infinity, hi = -Infinity, sum = 0;
  for (let i = 0; i < 2000; i++) {
    const a = r() * Math.PI * 2;
    const rr = Math.sqrt(r()) * WORLD.SAFE_CRATER_RADIUS;
    const h = terrain.sampleHeight(
      WORLD.SAFE_CRATER_CENTER[0] + Math.cos(a) * rr,
      WORLD.SAFE_CRATER_CENTER[1] + Math.sin(a) * rr);
    lo = Math.min(lo, h); hi = Math.max(hi, h); sum += h;
  }
  ok(lo >= -20 && hi <= -2, 'every crater sample in [-20, -2] m',
    `min ${lo.toFixed(2)}  max ${hi.toFixed(2)}  mean ${(sum / 2000).toFixed(2)}`);
}

console.log('\n== 3a. Rock Spires are landmarks, not another noise band ==');
{
  // Prominence against a symmetric 96 m ring cancels the shelf's first-order
  // radial gradient and leaves formations that rise above their local ground.
  // Coverage is asserted at BOTH ends: no landmarks is the original bug, while
  // covering the whole annulus would turn spires into another uniform texture
  // and erase the navigable negative space between clusters.
  //
  // THE SUMMITS ARE REFINED RATHER THAN SAMPLED, AND THAT IS THE WHOLE POINT.
  // A grid reads a tower's height only when it happens to land on one, so a
  // grid measure of tower HEIGHT is silently also a measure of tower WIDTH.
  // The spire profile division narrowed the towers to 25.2 m at half
  // prominence without shortening them, and this section - which scanned at
  // 32 m - went red on it. Measured on DEFAULT_SEED at 32 / 16 / 8 / 4 m,
  // after the division: peak 157.8 / 182.7 / 188.0 / 200.6 m, 5 / 32 / 114 /
  // 482 samples over 120 m; before it: 184.6 / 184.6 / 202.6 / 203.8 m and
  // 43 / 170 / 655 / 2611. The grid moved by 27 m of peak and 8.6x of count
  // through a change that did not cost the towers a metre.
  //
  // Hill-climbing each candidate to 0.25 m answers the question that was
  // actually being asked. It reads 204.3 m and 60 summits over 120 m here
  // against 205.0 m and 57 before the division - the same mountains, which is
  // the truth - and it cannot be defeated by narrowing them again. It is also
  // the cheaper of the two repairs: 2.5x less than the 8 m grid that would be
  // needed just to SEE the summits, measured 0.38 / 0.51-0.55 s against
  // 0.98 / 1.31-1.32 s idle and under load. Quote the ratio, not the seconds -
  // this machine's wall clock is a documented lottery (see CLAUDE.md).
  const prominenceAt = (x, z) => {
    const ring = (terrain.sampleHeight(x + 96, z) + terrain.sampleHeight(x - 96, z)
                + terrain.sampleHeight(x, z + 96) + terrain.sampleHeight(x, z - 96)) * 0.25;
    return terrain.sampleHeight(x, z) - ring;
  };

  // Deterministic 8-neighbour pattern search, halving the step from 16 m (half
  // the scan grid, so the basins tile) down to 0.25 m. No PRNG and no
  // iteration-order dependence: same seed, same summits, to the digit.
  const climb = (x0, z0) => {
    let x = x0, z = z0, best = prominenceAt(x, z);
    for (let s = 16; s >= 0.25; s *= 0.5) {
      for (let guard = 0; guard < 64; guard++) {
        let bx = x, bz = z;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            const p = prominenceAt(x + dx * s, z + dz * s);
            if (p > best) { best = p; bx = x + dx * s; bz = z + dz * s; }
          }
        }
        if (bx === x && bz === z) break;
        x = bx; z = bz;
      }
    }
    return { prominence: best, x, z };
  };

  let samples = 0, prominent = 0;
  const candidates = [];
  for (let x = -2800; x <= 2800; x += 32) {
    for (let z = -2800; z <= 2800; z += 32) {
      const radius = Math.hypot(x, z);
      if (radius < 1750 || radius > 2700) continue;
      const prominence = prominenceAt(x, z);
      samples++;
      if (prominence > 40) prominent++;
      // A candidate bar of 20 m, well under the 40 m coverage threshold,
      // because a 32 m scan only guarantees a sample within 22.6 m of a summit
      // and it is the FLANK reading there that has to clear the bar. At 40 m
      // this build offers 156 candidates and resolves 57 major towers; at 20 m
      // it offers 1064 and resolves 60. The lower bar buys roughly one more
      // halving of tower width before the scan goes blind again.
      if (prominence > 20) candidates.push([x, z, prominence]);
    }
  }
  const coverage = prominent / samples;

  // Strongest candidate first, so the 40 m skip can only ever discard one that
  // is already walking up a tower whose summit is resolved. The x/z tiebreaks
  // keep the order total rather than leaving it to sort stability.
  candidates.sort((a, b) => (b[2] - a[2]) || (a[0] - b[0]) || (a[1] - b[1]));
  const summits = [];
  for (const [x, z] of candidates) {
    if (summits.some((s) => Math.hypot(s.x - x, s.z - z) < 40)) continue;
    const found = climb(x, z);
    // 48 m merge: two climbs that land this close are the same tower, not two.
    // Insensitive by measurement - 24 / 32 / 48 / 64 / 96 m all resolve 60,
    // 60, 60, 58, 57 major towers, so nothing here balances on the radius.
    const same = summits.find((s) => Math.hypot(s.x - found.x, s.z - found.z) < 48);
    if (!same) summits.push(found);
    else if (found.prominence > same.prominence) Object.assign(same, found);
  }
  summits.sort((a, b) => b.prominence - a.prominence);
  const major = summits.filter((s) => s.prominence > 120).length;
  const peak = summits[0];

  ok(peak.prominence > 170 && major >= 20, 'tower clusters rise over 170 m above local ground',
    `peak ${peak.prominence.toFixed(1)} m @ (${peak.x.toFixed(2)},${peak.z.toFixed(2)}), `
    + `${major} of ${summits.length} refined summits over 120 m`);

  // THE COVERAGE BAND MOVED ON 2026-08-05, DELIBERATELY. A needle field paves
  // less of the annulus than the cone field it replaced - 3.75% before the
  // spire profile division, 1.20% after - and the old [1%, 8%] band was left
  // with 0.14 points of margin below, which is a coincidence rather than a
  // check. [0.6%, 3%] restores a real margin on both sides (2.0x down, 2.5x
  // up) and still catches an annulus paved with towers.
  //
  // Unlike the summit height above, coverage is an area fraction that has
  // already CONVERGED on the coarse grid and needs no refining: 1.20 / 1.16 /
  // 1.14 / 1.15% at 32 / 16 / 8 / 4 m. That is also why the 32 m scan stays -
  // it is exact for the thing it is still being asked.
  ok(coverage > 0.006 && coverage < 0.03, 'spire fields stay sparse enough for negative space',
    `${(coverage * 100).toFixed(2)}% prominent coverage (${prominent}/${samples})`);
}

console.log('\n== 3b. folded trench centreline cannot tear the rim ==');
{
  // This window contains the old nearest-segment switch: at x=2182, z=1783.8
  // the chosen floor jumped -944.6 -> -1153.3 and H tore by 175.1 m in 5 cm.
  // Width/floor now follow radial progress, while the folded polyline supplies
  // only distance. Keep a fine step so this cannot regress into a one-quad
  // staircase while still passing a coarse continuity scan.
  let worst = 0, worstAt = null;
  for (let x = 2140; x <= 2220; x += 2) {
    for (let z = 1740; z <= 1820; z += 0.25) {
      const jump = Math.abs(terrain.sampleHeightFast(x, z + 0.25) - terrain.sampleHeightFast(x, z));
      if (jump > worst) { worst = jump; worstAt = [x, z]; }
    }
  }
  ok(worst < 3, 'trench rim has no sub-quad vertical tear',
    `max ${worst.toFixed(3)} m / 0.25 m at (${worstAt[0]},${worstAt[1].toFixed(2)})`);
}

console.log('\n== 4. determinism ==');
{
  const r = rng(0x1234);
  const pts = [];
  for (let i = 0; i < 4000; i++) pts.push([(r() * 2 - 1) * 3000, (r() * 2 - 1) * 3000]);
  const a = pts.map(([x, z]) => terrain.sampleHeight(x, z));
  terrain.setSeed(0x11112222);            // churn the derived state
  terrain.sampleHeight(17, 23);
  terrain.setSeed(WORLD.DEFAULT_SEED);    // and back
  const b = pts.map(([x, z]) => terrain.sampleHeight(x, z));
  let same = true, worst = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) { same = false; worst = Math.max(worst, Math.abs(a[i] - b[i])); }
  }
  ok(same, 'same seed twice -> bit-identical heights', `4000 samples, max delta ${worst}`);

  // Order independence: evaluating in a shuffled order must not change anything.
  const idx = pts.map((_, i) => i).sort(() => (r() - 0.5));
  let orderSame = true;
  for (const i of idx) if (terrain.sampleHeight(pts[i][0], pts[i][1]) !== a[i]) orderSame = false;
  ok(orderSame, 'evaluation order does not affect the result', '4000 samples shuffled');

  // A different seed must actually produce a different world.
  terrain.setSeed(0x77777777);
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (terrain.sampleHeight(pts[i][0], pts[i][1]) !== a[i]) diff++;
  ok(diff > a.length * 0.9, 'a different seed produces a different world',
    `${diff}/${a.length} samples changed`);
  terrain.setSeed(WORLD.DEFAULT_SEED);
}

console.log('\n== 5. seamlessness at chunk boundaries (500 coords) ==');
{
  const r = rng(0x5EA);
  let worst = 0, worstAt = null;
  for (let i = 0; i < 500; i++) {
    const border = (Math.floor(r() * 47) - 23) * WORLD.CHUNK_SIZE;
    const along = (r() * 2 - 1) * 3000;
    const alongX = r() < 0.5;
    const x0 = alongX ? along : border;
    const z0 = alongX ? border : along;
    const x1 = alongX ? along : border + 0.001;
    const z1 = alongX ? border + 0.001 : along;
    const d = Math.abs(terrain.sampleHeight(x0, z0) - terrain.sampleHeight(x1, z1));
    if (d > worst) { worst = d; worstAt = [x0, z0]; }
  }
  ok(worst < 0.05, '|h(x) - h(x+0.001)| < 0.05 across chunk borders',
    `max ${worst.toExponential(3)} m at (${worstAt[0].toFixed(0)},${worstAt[1].toFixed(0)})`);
}

console.log('\n== 6. chunk-edge vertex agreement (the thing seams actually depend on) ==');
{
  // Every vertex on a shared edge must be bit-identical in both chunks,
  // including its normal, or a lit crack appears even with no gap.
  const a = terrain.bakeChunk(3, -2, 0);
  const b = terrain.bakeChunk(4, -2, 0);
  const res = a.resolution;
  let maxPos = 0, maxNrm = 0;
  for (let j = 0; j < res; j++) {
    const ia = j * res + (res - 1);   // east edge of a
    const ib = j * res + 0;           // west edge of b
    maxPos = Math.max(maxPos, Math.abs(a.positions[ia * 3 + 1] - b.positions[ib * 3 + 1]));
    for (let c = 0; c < 3; c++) {
      maxNrm = Math.max(maxNrm, Math.abs(a.normals[ia * 3 + c] - b.normals[ib * 3 + c]));
    }
  }
  ok(maxPos === 0 && maxNrm === 0, 'shared LOD-0 edge is bit-identical in both chunks',
    `max |dy| ${maxPos}  max |dn| ${maxNrm}`);
}

console.log('\n== 7. bakeChunk timing (129x129 LOD 0) ==');
{
  const cases = [[0, 0, 'crater'], [-4, -5, 'island'], [12, 12, 'trench'],
                 [20, 6, 'abyssal'], [8, 2, 'shelf break'], [-2, 3, 'reef'], [-6, -8, 'summit']];
  for (let i = 0; i < 4; i++) terrain.bakeChunk(0, 0, 0);   // warm up
  let worst = 0, worstName = '';
  for (const [cx, cz, name] of cases) {
    let best = Infinity, sum = 0;
    const N = 6;
    for (let i = 0; i < N; i++) { const c = terrain.bakeChunk(cx, cz, 0); best = Math.min(best, c.bakeMs); sum += c.bakeMs; }
    if (best > worst) { worst = best; worstName = name; }
    console.log(`       ${name.padEnd(12)} best ${best.toFixed(1)} ms   mean ${(sum / N).toFixed(1)} ms`);
  }
  const c0 = terrain.bakeChunk(0, 0, 0);
  console.log(`       LOD0 mesh: ${c0.vertexCount} vertices, ${c0.triangleCount} triangles, ${c0.resolution}x${c0.resolution} grid`);
  ok(worst < 25, 'worst-case LOD-0 bake under 25 ms', `${worst.toFixed(1)} ms (${worstName})`);

  for (let lod = 0; lod < WORLD.LOD_RINGS; lod++) {
    const c = terrain.bakeChunk(1, 1, lod);
    console.log(`       lod ${lod}: res ${String(c.resolution).padStart(3)}  step ${String(c.step).padStart(3)} m  ` +
      `verts ${String(c.vertexCount).padStart(6)}  tris ${String(c.triangleCount).padStart(6)}  ${c.bakeMs.toFixed(2)} ms`);
  }
}

console.log('\n== 8. sampleHeightFast agreement and speed ==');
{
  const r = rng(0x9911);
  let worst = 0;
  const N = 80000;
  for (let i = 0; i < N; i++) {
    const x = (r() * 2 - 1) * 3072, z = (r() * 2 - 1) * 3072;
    worst = Math.max(worst, Math.abs(terrain.sampleHeight(x, z) - terrain.sampleHeightFast(x, z)));
  }
  ok(worst < 4, 'fast path within 4 m of the authoritative height', `max deviation ${worst.toFixed(2)} m`);

  const M = 300000;
  let acc = 0;
  let t = performance.now();
  for (let i = 0; i < M; i++) acc += terrain.sampleHeight((i * 7.13) % 3000, (i * 3.71) % 3000);
  const full = performance.now() - t;
  t = performance.now();
  for (let i = 0; i < M; i++) acc += terrain.sampleHeightFast((i * 7.13) % 3000, (i * 3.71) % 3000);
  const fast = performance.now() - t;
  console.log(`       sampleHeight ${(full * 1000 / M).toFixed(3)} us   sampleHeightFast ${(fast * 1000 / M).toFixed(3)} us   speedup ${(full / fast).toFixed(2)}x  (acc ${acc.toFixed(0)})`);
}

console.log('\n== 9. normals, slope, distanceToShore ==');
{
  const n = new Float64Array(3);
  const r = rng(0x4242);
  let unit = true, sloped = 0;
  for (let i = 0; i < 3000; i++) {
    const x = (r() * 2 - 1) * 3000, z = (r() * 2 - 1) * 3000;
    terrain.sampleNormal(n, x, z);
    const l = Math.hypot(n[0], n[1], n[2]);
    if (Math.abs(l - 1) > 1e-9) unit = false;
    if (n[1] <= 0) sloped++;
  }
  ok(unit && sloped === 0, 'sampleNormal returns unit, upward normals', '3000 samples');

  // The shoreline estimate must change sign where the height does.
  let agree = 0, total = 0;
  for (let i = 0; i < 20000; i++) {
    const x = -492 + (r() * 2 - 1) * 700;
    const z = -656 + (r() * 2 - 1) * 700;
    const d = terrain.distanceToShore(x, z);
    if (Math.abs(d) < 8) continue;         // inside the band where relief dominates
    const h = terrain.sampleHeight(x, z);
    total++;
    if ((d < 0) === (h > 0)) agree++;
  }
  ok(agree / total > 0.93, 'distanceToShore sign agrees with the waterline',
    `${(100 * agree / total).toFixed(1)}% of ${total} samples outside the +/-8 m band`);
}

console.log('\n== 10. biomes ==');
{
  ok(biomes.BIOME_COUNT >= 12, 'at least 12 biome records', `${biomes.BIOME_COUNT} records`);
  const required = ['depth', 'slope', 'radius', 'albedo', 'roughness', 'waterType', 'fogTint', 'macroStyle', 'sightDensity', 'dangerTier'];
  let shaped = true;
  for (const b of biomes.BIOMES) for (const k of required) if (b[k] === undefined) shaped = false;
  ok(shaped, 'every record carries the full field set', required.join(', '));

  const w = new Float64Array(biomes.BIOME_COUNT);
  const r = rng(0x7777);
  const seen = new Set();
  let badSum = 0, maxActive = 0;
  for (let i = 0; i < 60000; i++) {
    const x = (r() * 2 - 1) * 3072, z = (r() * 2 - 1) * 3072;
    const h = terrain.sampleHeight(x, z);
    const s = terrain.sampleSlope(x, z);
    biomes.biomeWeights(w, x, z, h, s);
    let sum = 0, active = 0;
    for (let k = 0; k < w.length; k++) { sum += w[k]; if (w[k] > 0) active++; }
    if (Math.abs(sum - 1) > 1e-9) badSum++;
    maxActive = Math.max(maxActive, active);
    seen.add(biomes.biomeAt(x, z, h, s));
  }
  ok(badSum === 0, 'biomeWeights always sums to 1 (full domain coverage)', `${badSum} failures in 60000`);
  ok(seen.size === biomes.BIOME_COUNT, 'every biome is actually reachable in the world',
    `${seen.size}/${biomes.BIOME_COUNT} seen, max ${maxActive} blending at once`);

  // Blend CONTINUITY, tested the only way that means anything: the material
  // delta over a step must shrink in proportion to the step. A discontinuity
  // (a hard biome partition) would keep the same delta at any step size. The
  // absolute delta alone proves nothing - on the trench wall/floor contact the
  // rock fraction legitimately runs 0.67 to 0.02 in 10 cm, which is a real
  // geological boundary, not a seam.
  const worstAt = (step) => {
    const rr = rng(0x2468);
    let worst = 0;
    for (let i = 0; i < 12000; i++) {
      const x = (rr() * 2 - 1) * 3000, z = (rr() * 2 - 1) * 3000;
      const m0 = biomes.materialAt(x, z, terrain.sampleHeight(x, z), terrain.sampleSlope(x, z));
      const a0 = [m0.albedo[0], m0.albedo[1], m0.albedo[2], m0.roughness,
        m0.rockiness, m0.macroStyle];
      const m1 = biomes.materialAt(x + step, z,
        terrain.sampleHeight(x + step, z), terrain.sampleSlope(x + step, z));
      let jump = 0;
      for (let k = 0; k < 3; k++) jump = Math.max(jump, Math.abs(a0[k] - m1.albedo[k]));
      jump = Math.max(jump, Math.abs(a0[3] - m1.roughness),
        Math.abs(a0[4] - m1.rockiness), Math.abs(a0[5] - m1.macroStyle));
      worst = Math.max(worst, jump);
    }
    return worst;
  };
  const j10 = worstAt(0.01);
  const j1 = worstAt(0.001);
  ok(j1 < j10 * 0.25, 'material delta shrinks with the step (no discontinuity)',
    `1 cm -> ${j10.toExponential(2)}, 1 mm -> ${j1.toExponential(2)}, ratio ${(j1 / j10).toFixed(3)}`);

  // The start crater must be tier 0.
  let maxTier = 0;
  for (let i = 0; i < 4000; i++) {
    const a = r() * Math.PI * 2, rr = Math.sqrt(r()) * WORLD.SAFE_CRATER_RADIUS;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    maxTier = Math.max(maxTier, biomes.dangerTierAt(x, z, terrain.sampleHeight(x, z), terrain.sampleSlope(x, z)));
  }
  ok(maxTier === 0, 'danger tier is 0 everywhere in the safe crater', `max tier ${maxTier}`);

  const styles = biomes.BIOMES.map((b) => b.macroStyle);
  ok(styles.every((v) => Number.isFinite(v) && v >= 0 && v <= 1),
    'every macro-material style is a valid blend coordinate',
    `${Math.min(...styles).toFixed(2)}..${Math.max(...styles).toFixed(2)}`);
  // Ids 2..13 were authored shallow-to-deep IN TABLE ORDER, so for them table
  // order and geology order are the same assertion. Ids are placement salts
  // and append-only, so a biome added later (14, Ossuary Flats, a 284-368 m
  // plain between the terraces and the canyon) can never rejoin that order -
  // its geology coordinate is instead asserted to sit BETWEEN its actual
  // geological neighbours, which is the property terrain.wgsl's blended macro
  // families actually depend on.
  ok(styles.slice(2, 14).every((v, i) => v > styles[i + 1]),
    'the underwater geology sequence (ids 2-13) is strictly ordered',
    styles.slice(2, 14).map((v) => v.toFixed(2)).join(' < '));
  ok(styles[14] > styles[9] && styles[14] < styles[10],
    'Ossuary Flats\' macro style sits between the terraces and the canyon',
    `${styles[9].toFixed(2)} < ${styles[14].toFixed(2)} < ${styles[10].toFixed(2)}`);
}

console.log('\n== 10b. the water column rule ==');
{
  // waterTypeAt() rejects a water mass whose Kd is too large for the DAYLIGHT
  // column it would have to fill, and hands the column to the next biome in the
  // blend or to the open ocean. The invariant that makes that safe is that
  // rejecting a type is only ever a BRIGHTENING, and it is asserted here rather
  // than asserted-in-a-comment because BRINE breaks it: min(Kd) 0.0545 buys it a
  // 120.7 m ceiling against COASTAL_GREEN's 87.2, while at 87.3 m its delivered
  // daylight luma is 0.61x COASTAL_GREEN's and its GREEN is 0.001x - so the day
  // a biome carries BRINE, preferring it over COASTAL_GREEN turns the lights
  // off. That pair is the regression this section exists to catch.
  //
  // WHY THIS IS NO LONGER A PER-CHANNEL NESTING TEST, and why the replacement is
  // stronger rather than weaker. The old rule was "a deeper ceiling implies a
  // smaller Kd in EVERY channel", which is sufficient but not necessary, and it
  // is measuring noise at the depths it now has to judge: HADAL_SUSPENSION is
  // allowed to 361.4 m against OCEANIC_CLEAR's 260, and over that crossover it
  // delivers 6.32x - 13.01x OCEANIC_CLEAR's daylight LUMA while running
  // 0.21x - 0.11x in red and 0.81x - 0.75x in green - on channels where
  // OCEANIC_CLEAR itself is down to 2.4e-8 and 3.1e-7 of the surface at the
  // shallow end of that band. Ratios of two extinct channels are not a
  // picture. So the rule is now applied WHERE THE SUBSTITUTION ACTUALLY HAPPENS
  // (across the crossover band, at its worst point) and against what a frame can
  // see: the delivered luma may not fall, and no channel that is still LIVE in
  // the type being passed over may fall either. BRINE fails both arms; the
  // shipped catalogue passes both.
  const COD = 260 * Math.min(...WATER_TYPES.OCEANIC_CLEAR.Kd);
  const ceilingOf = (t) => COD / Math.min(...t.Kd);
  // A channel is LIVE while the type being passed over still delivers this much
  // of the surface: it separates "a colour a frame can carry" from "a number
  // that has already gone to zero".
  //
  // THE TWO ENDS ARE NOT SYMMETRIC AND THE ADMISSIBLE BAND IS ONLY 356x WIDE.
  // Swept through this section's own algorithm, both ends are the SAME KIND OF
  // number - the green channel of the type being passed over, at an end of a
  // crossover band - which is why they crowd:
  //   DOWN, this goes red on the shipped catalogue at 3.133e-7, which is
  //   exactly OCEANIC_CLEAR's green at 260 m. Below that, HADAL_SUSPENSION over
  //   OCEANIC_CLEAR is called a darkening on a channel that is 3e-7 of the
  //   surface while its delivered LUMA is 6.32x. Measured: 0 darkening samples
  //   at 3.16e-7, 1 at 3.0e-7, 7 at 1e-7, 19 at 1e-8.
  //   UP, BRINE - the regression this section exists to catch - keeps all 33 of
  //   its per-channel samples only to 1.116e-4, which is exactly COASTAL_GREEN's
  //   green at 120.7 m, the deep end of the BRINE crossover. Past that the
  //   channel arm decays (5 samples at 1e-3, 0 at 1e-2) and only the LUMA arm
  //   is left holding it, which it does alone all the way past 1e+1 at 0.61x.
  //
  // 1e-6 was the authored value and the comment beside it claimed a wide margin
  // at both ends; it had 3.19x below and its stated "1.12e-3 .. 1.39e-3" for
  // COASTAL_GREEN's green over the crossover was the top of that range with a
  // misplaced exponent - the true range is 1.116e-4 .. 1.395e-3. 1e-5 is the
  // round decade nearest the band's geometric centre (5.9e-6): 31.9x of margin
  // against the false positive below and 11.2x against losing the channel arm
  // above, with the shipped catalogue still at 0 and BRINE still failing BOTH
  // arms (33 samples, worst BRINE over COASTAL_GREEN at 87.2 m, luma x0.609).
  const CHANNEL_LIVE = 1e-5;
  const REC709 = [0.2126, 0.7152, 0.0722];
  const dayLuma = (t, d) =>
    REC709.reduce((a, k, i) => a + k * Math.exp(-t.Kd[i] * d), 0);
  const carried = [...new Set(biomes.BIOMES.map((b) => b.waterType))];
  let darkenings = 0, worstPair = '', worstRatio = Infinity;
  for (const a of carried) for (const b of carried) {
    if (a === b) continue;
    const A = WATER_TYPES[a], B = WATER_TYPES[b];
    // A is allowed deeper than B, so somewhere in (ceil(B), ceil(A)] the rule
    // prefers A where it would otherwise have taken B. Equal ceilings mean the
    // rule never prefers one over the other and there is nothing to judge - see
    // the Kd-blue pin asserted below, which is what makes the three deep types
    // tie on purpose.
    if (ceilingOf(A) <= ceilingOf(B)) continue;
    for (let k = 0; k <= 32; k++) {
      const d = ceilingOf(B) + (ceilingOf(A) - ceilingOf(B)) * (k / 32);
      const ratio = dayLuma(A, d) / dayLuma(B, d);
      let bad = ratio < 1;
      for (let c = 0; c < 3; c++) {
        const loser = Math.exp(-B.Kd[c] * d);
        if (loser >= CHANNEL_LIVE && Math.exp(-A.Kd[c] * d) < loser) bad = true;
      }
      if (bad) darkenings++;
      if (bad && ratio < worstRatio) {
        worstRatio = ratio;
        worstPair = `${a} over ${b} at ${d.toFixed(1)} m, luma x${ratio.toFixed(3)}`;
      }
    }
  }
  ok(darkenings === 0, 'passing a type over for a deeper one only ever brightens',
    `${carried.length} types carried (${carried.join(', ')}), `
    + `${darkenings} darkening samples${worstPair ? ' worst ' + worstPair : ''}`);

  // THE Kd-BLUE PIN. All FOUR rows of the deep family - ABYSSAL_VOID,
  // HADAL_SUSPENSION, VENT_HAZE and NEPHELOID - author blue Kd BIT-EQUAL to
  // 0.0182, which is what gives all four the same 361.4 m ceiling and exempts
  // every pair among them from the crossover test above: that loop opens with
  // `if (ceilingOf(A) <= ceilingOf(B)) continue`, and an EXACT tie exits it in
  // BOTH directions, so there is no crossover band left to judge. The constraint
  // is documented in WATER_TYPES; this is the assertion, and NEPHELOID (added
  // with Canyon Wall's own column) is in it because that docstring asks for it
  // twice by name.
  //
  // IT IS ASSERTED IN TWO PARTS, BECAUSE EQUALITY ALONE DOES NOT SAY WHY IT
  // MATTERS and a reader who breaks it will be looking at a colour tweak rather
  // than at a ceiling. First the blues share one bit pattern - reported as a
  // per-row ULP OFFSET, so a red names the row that moved and by how much, which
  // is the only form of this number a colour edit can be connected to. Then the
  // consequence: the crossover loop above judged ZERO ordered pairs inside the
  // family. A one-ULP nudge breaks the second even where it survives the first's
  // wording, and the pair count the loop judges among the 6 carried types steps
  // 12 -> 14 the moment any tie breaks.
  //
  // THE CROSSOVER LOOP DOES NOT COVER THE PIN, AND WHICH DIRECTION IT MISSES
  // REVERSES BETWEEN ROWS. Measured 2026-08-05 by re-running that loop verbatim
  // with one blue nudged and everything else shipped:
  //   HADAL_SUSPENSION  -1 / -64 ULP -> 66 darkening samples (red anyway)
  //   HADAL_SUSPENSION  +1 / +64 ULP ->  0 samples, the loop is SILENT
  //   NEPHELOID         +1 / +64 ULP -> 33 darkening samples (red anyway)
  //   NEPHELOID         -1 / -64 ULP ->  0 samples, the loop is SILENT
  //   ABYSSAL_VOID      +1 / +64 ULP -> 33 samples;  -1 / -64 ULP -> 0, SILENT
  //   VENT_HAZE         any direction ->  0 samples - no biome carries it, so it
  //                                       is not in `carried` and never judged
  // The asymmetry inverts because NEPHELOID's red and green are ABYSSAL_VOID's
  // CHANNEL FOR CHANNEL while HADAL_SUSPENSION's are larger, so the pair that
  // ends up being judged is a brightening for one row and a darkening for the
  // other. There is therefore no safe direction to leave unguarded, and this
  // assertion is the only guard that covers all four rows both ways.
  // (WATER_TYPES' docstring predicts HADAL_SUSPENSION's downward-only coverage
  // for NEPHELOID too; for that row it is the UPWARD half that the loop catches.)
  const PINNED = ['ABYSSAL_VOID', 'HADAL_SUSPENSION', 'VENT_HAZE', 'NEPHELOID'];
  const kdBits = new DataView(new ArrayBuffer(8));
  const bitsOf = (v) => { kdBits.setFloat64(0, v); return kdBits.getBigUint64(0); };
  const pinBits = bitsOf(WATER_TYPES.ABYSSAL_VOID.Kd[2]);
  const ulpOff = PINNED.map((n) => bitsOf(WATER_TYPES[n].Kd[2]) - pinBits);
  ok(ulpOff.every((d) => d === 0n) && PINNED.every((n) =>
    Math.min(...WATER_TYPES[n].Kd) === WATER_TYPES[n].Kd[2]),
  'the deep family pins blue Kd bit-equal, and blue is every row min',
  `0x${pinBits.toString(16)} = ${WATER_TYPES.ABYSSAL_VOID.Kd[2]}, `
    + `${PINNED.map((n, i) => `${n} ${ulpOff[i] >= 0n ? '+' : ''}${ulpOff[i]} ULP`).join(', ')}`);

  // The consequence of the pin, measured through the crossover loop's own
  // predicate rather than inferred from the equality above - this is the clause
  // that makes a broken pin legible as "the loop started judging pairs it used
  // to skip" instead of as an opaque bit mismatch.
  let familyJudged = 0;
  const familyPairs = [];
  for (const a of PINNED) for (const b of PINNED) {
    if (a === b) continue;
    if (ceilingOf(WATER_TYPES[a]) > ceilingOf(WATER_TYPES[b])) {
      familyJudged++;
      familyPairs.push(`${a} over ${b}`);
    }
  }
  ok(familyJudged === 0,
    'the pinned ceilings tie, so no pair inside the family is judged',
    `${new Set(PINNED.map((n) => ceilingOf(WATER_TYPES[n]))).size} distinct ceiling(s) over `
    + `${PINNED.length} rows at ${ceilingOf(WATER_TYPES.ABYSSAL_VOID).toFixed(1)} m `
    + `(${PINNED.filter((n) => carried.includes(n)).length} carried), `
    + `${familyJudged} intra-family crossovers`
    + `${familyPairs.length ? ' - ' + familyPairs.join(', ') : ''}`);

  // THE APHOTIC GATE. The ceiling protects DAYLIGHT, and past TRUE_DARK_DEPTH
  // the composite has already multiplied ambient, in-scatter and deep tint by
  // zero - so the ceiling is scaled by the surviving daylight rather than taken
  // raw, or every deep biome's authored water is dead data (measured before the
  // gate: ABYSSAL_VOID on 100.000% of the seabed past 260 m).
  //
  // The gate must be bit-identical to common/ocean.wgsl's aphoticFactor(), and
  // the shape of `column * gate(column)` is what decides whether it can disturb
  // anything shallow: it is the identity below 319.8 m, so no column shallower
  // than that can change classification at all.
  const smoothstep3 = (e0, e1, x) => {
    const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
    return t * t * (3 - 2 * t);
  };
  const gate = (d) => 1 - smoothstep3(TRUE_DARK_DEPTH * 0.615, TRUE_DARK_DEPTH, d);
  ok(gate(0) === 1 && gate(319) === 1 && gate(TRUE_DARK_DEPTH * 0.615) === 1
    && gate(TRUE_DARK_DEPTH) === 0 && gate(1600) === 0,
  'the classifier gate is the composite aphoticFactor, to the digit',
  `f(0)=${gate(0)}, f(319)=${gate(319)}, f(400)=${gate(400).toFixed(4)}, `
    + `f(${TRUE_DARK_DEPTH})=${gate(TRUE_DARK_DEPTH)}`);

  let peak = 0, peakAt = 0;
  for (let d = 0; d <= 1600; d += 0.05) {
    const p = d * gate(d);
    if (p > peak) { peak = p; peakAt = d; }
  }
  const hadalCeiling = ceilingOf(WATER_TYPES.ABYSSAL_VOID);
  ok(peak < hadalCeiling, 'the gated column never rejects a deep water type',
    `peak gated column ${peak.toFixed(1)} m at ${peakAt.toFixed(1)} m `
    + `against the ${hadalCeiling.toFixed(1)} m deep ceiling`);

  // A water mass is a property of the COLUMN, so the answer at (x, z) must not
  // depend on how deep the eye is in it. Keyed on the eye instead, a diver
  // descending past 35.9 m over a kelp bed changed water type mid-swim.
  const rr = rng(0x51ce);
  let eyeDependent = 0, bedTested = 0, inadmissible = 0, shallowMoved = 0;
  // Ties included: three types share the smallest min(Kd), and picking one of
  // them by iteration order would make the exemption below depend on the order
  // BIOMES happens to list its records in.
  const minKd = Math.min(...carried.map((c) => Math.min(...WATER_TYPES[c].Kd)));
  const terminal = new Set(carried
    .filter((c) => Math.min(...WATER_TYPES[c].Kd) === minKd)
    .map((c) => WATER_TYPES[c].id));
  for (let i = 0; i < 20000; i++) {
    const x = (rr() * 2 - 1) * 3072, z = (rr() * 2 - 1) * 3072;
    const h = terrain.sampleHeight(x, z);
    if (h >= 0) continue;
    bedTested++;
    const s = terrain.sampleSlope(x, z), d = -h;
    const surface = biomes.waterTypeAt(x, z, h, 0, s);
    const mid = biomes.waterTypeAt(x, z, h, d * 0.5, s);
    const bottom = biomes.waterTypeAt(x, z, h, d, s);
    if (surface.id !== mid.id || mid.id !== bottom.id) eyeDependent++;
    // Whatever comes back must itself be able to hold light over the DAYLIGHT
    // it still has - the same gated quantity waterTypeAt admits on - unless it
    // is the clearest water there is and there is nothing left to fall to.
    if (d * gate(d) > ceilingOf(bottom) && !terminal.has(bottom.id)) inadmissible++;
    // The gate cannot reach a shallow column. Asserted directly rather than
    // inferred from its shape, because this is the invariant the whole deep
    // water split had to be measured against: 0 of the 8,808 wet columns
    // shallower than 320 m on a 40 m grid changed classification when the gate
    // landed, and it must stay 0.
    if (d < TRUE_DARK_DEPTH * 0.615 && gate(d) !== 1) shallowMoved++;
  }
  ok(eyeDependent === 0, 'the water type is a property of the column, not the eye',
    `${eyeDependent}/${bedTested} columns answer differently from the surface, mid-water and bottom`);
  ok(inadmissible === 0, 'the returned water can always hold light at its own depth',
    `${inadmissible}/${bedTested} outside their own gated ceiling `
    + `(terminal types ${[...terminal].join(',')})`);
  ok(shallowMoved === 0, 'the aphotic gate is the identity above 319.8 m',
    `${shallowMoved}/${bedTested} sampled columns saw a gate other than 1 while shallow`);

  let threw = false;
  try { biomes.waterTypeAt(0, 0, -10, 10); } catch (e) { threw = e instanceof TypeError; }
  ok(threw, 'waterTypeAt refuses to run without a real slope', 'TypeError naming sampleSlope');

  // Spatial smoothing is an explicit render-time policy, not a replacement for
  // the centre-only offline classifier. The kelp bed is the regression fixture:
  // pooled centre weights leave blue pockets, while the live six-tap water mass
  // stays green over everything kelp still claims. A radius of zero must
  // remain a byte-for-byte bisect of the old path.
  //
  // "EVERYTHING KELP STILL CLAIMS" IS NO LONGER THE WHOLE SQUARE, AND THE SIX
  // EXCEPTIONS ARE AUTHORED, NOT A SMOOTHING REGRESSION. The Crimson Meadow
  // cession (2026-08-18) raised kelp's slope floor 0.10 -> 0.20 so kelp cannot
  // inherit the meadow's flat annulus by tie, and the FEATHER moved with the
  // floor: at slope ~0.01 kelp's pooled weight fell 0.68 -> 0.12, so six
  // sand-dominant flat pockets at 50-61 m inside this square (a ~40 m patch
  // near (-523,1581) plus two single cells) now vote sand's own
  // REEF_TURQUOISE. A/B on one tree, this fixture the instrument: reverting
  // ONLY the kelp floor restores 625/625; reverting only the sand cession
  // changes nothing (619/625 either way). Patch-scale minority water is what
  // WORLD.WATER_TYPE_DWELL exists for. The guard keeps its teeth: the centre
  // path must still leave pockets, the live path must still remove them
  // (539 -> 619 here, 585 -> 625 before the cession), and only the measured
  // handful of sand/meadow pockets may go non-green. RE-MEASURED after the
  // meadow's final siting (kelp depth[0] 14 -> 28, coral radius[1] -> 950):
  // 548 -> 618, one further pocket cell at the same flat 50-61 m ground -
  // the depth floor, not the smoothing, moved it. Tolerance 8.
  const oldSmoothRadius = WORLD.WATER_TYPE_SMOOTH_RADIUS;
  // RE-SITED INTO THE KELP BASIN with the emerald rebuild's terrain phase:
  // the old box at (-408, 1496) sits at r ~1550, OUTSIDE the carved wedge
  // (rIn 1150 / rOut 1480), so after the biome moved onto the basin the box
  // stopped instrumenting a kelp bed at all. (-770, 1010) is basin
  // interior; measured on the re-sited box: centre 586/625, live 616/625,
  // 9 stragglers (6 coastal-green rim cells, 1 reef, 2 oceanic).
  const kelpX = -770, kelpZ = 1010;
  let centreGreen = 0, liveGreen = 0, centreCells = 0, liveCells = 0;
  for (let z = kelpZ - 120; z <= kelpZ + 120; z += 10) {
    for (let x = kelpX - 120; x <= kelpX + 120; x += 10) {
      const h = terrain.sampleHeightFast(x, z);
      const s = terrain.sampleSlope(x, z);
      const centre = biomes.waterTypeAt(x, z, h, Math.max(0, -h), s);
      const live = biomes.waterTypeAt(x, z, h, Math.max(0, -h), s, terrain);
      // KELP_EMERALD since the 2026-08-18 emerald rebuild moved Kelp Forest
      // off COASTAL_GREEN; the fixture tracks "the kelp biome's own water",
      // whatever row that is, and the pocket mechanics are unchanged.
      if (centre.name === WATER_TYPES.KELP_EMERALD.name) centreGreen++;
      if (live.name === WATER_TYPES.KELP_EMERALD.name) liveGreen++;
      centreCells++; liveCells++;
    }
  }
  ok(centreGreen < centreCells && liveGreen > centreGreen && liveCells - liveGreen <= 12,
    'smoothed Kelp Forest water removes blue pockets',
    `centre ${centreGreen}/${centreCells}, live ${liveGreen}/${liveCells} `
    + '(the <= 12 non-green are basin-rim coastal/reef cells, see the box note above)');
  WORLD.WATER_TYPE_SMOOTH_RADIUS = 0;
  let bisect = 0;
  for (let z = kelpZ - 120; z <= kelpZ + 120; z += 20) {
    for (let x = kelpX - 120; x <= kelpX + 120; x += 20) {
      const h = terrain.sampleHeightFast(x, z);
      const s = terrain.sampleSlope(x, z);
      const a = biomes.waterTypeAt(x, z, h, Math.max(0, -h), s);
      const b = biomes.waterTypeAt(x, z, h, Math.max(0, -h), s, terrain);
      if (a.id !== b.id) bisect++;
    }
  }
  WORLD.WATER_TYPE_SMOOTH_RADIUS = oldSmoothRadius;
  ok(bisect === 0, 'zero water smoothing is an exact centre-only bisect', `${bisect} mismatches`);
}

console.log('\n== 10c. the surface optical column ==');
{
  // WATER_TYPES carries a SECOND column - surfaceSigmaA / surfaceKd - with the
  // Jerlov red the 2026-08-02 art cut took out, for the water-leaving radiance
  // that a flyover reads. It differs from the live column in RED ONLY, and
  // green/blue are authored twice, so this section exists to make that
  // duplication safe: edit Kd[1] without editing surfaceKd[1] and it fails here
  // rather than silently desaturating the sea two commits later.
  //
  // This proves AUTHORSHIP, not liveness. The live proof is the measured hue on
  // a real above-water frame; test-ocean section 16 pins both ends of the knob.
  const types = Object.entries(WATER_TYPES);
  let missing = 0, badChannel = 0, notRedOnly = 0, weakerRed = 0, details = '';
  for (const [name, t] of types) {
    if (!Array.isArray(t.surfaceSigmaA) || !Array.isArray(t.surfaceKd)
      || t.surfaceSigmaA.length !== 3 || t.surfaceKd.length !== 3) { missing++; continue; }
    for (const v of [...t.surfaceSigmaA, ...t.surfaceKd]) {
      if (!Number.isFinite(v) || v <= 0) badChannel++;
    }
    // Green and blue must be byte-identical to the live column: the cut came out
    // of the RED absorption alone, and sigmaS is shared between the two sets, so
    // any other difference is a typo rather than a decision.
    for (let c = 1; c < 3; c++) {
      if (t.surfaceSigmaA[c] !== t.sigmaA[c] || t.surfaceKd[c] !== t.Kd[c]) {
        notRedOnly++; details = `${name} ch${c}`;
      }
    }
    // The surface column is the PRE-cut one, so its red can only be larger or
    // equal (equal for the three types 2ba914e never cut).
    if (t.surfaceSigmaA[0] < t.sigmaA[0] || t.surfaceKd[0] < t.Kd[0]) {
      weakerRed++; details = name;
    }
  }
  ok(missing === 0, 'every water type authors a surface column',
    `${types.length} types, ${missing} missing surfaceSigmaA/surfaceKd`);
  ok(badChannel === 0, 'every surface channel is finite and positive', `${badChannel} bad`);
  ok(notRedOnly === 0, 'the surface column differs from the live one in RED ONLY',
    `${notRedOnly} green/blue divergences ${details}`);
  ok(weakerRed === 0, 'the surface red is never weaker than the art red',
    `${weakerRed} inverted ${details}`);

  // sigmaS is COMMON to both sets, so the surface sigma_t the renderer uploads
  // is exactly surfaceSigmaA + sigmaS. Assert the identity the renderer relies
  // on rather than letting a third array appear.
  let sumMismatch = 0;
  for (const [, t] of types) {
    for (let c = 0; c < 3; c++) {
      const live = t.sigmaA[c] + t.sigmaS[c];
      if (Math.abs(live - t.sigmaT[c]) > 1e-9) sumMismatch++;
    }
  }
  ok(sumMismatch === 0, 'sigmaT is exactly sigmaA + sigmaS, so the surface sum is too',
    `${sumMismatch} channels off`);
}

console.log('\n== 11. baked chunk integrity ==');
{
  const c = terrain.bakeChunk(-4, -5, 0);
  let badIdx = 0;
  for (let i = 0; i < c.indices.length; i++) if (c.indices[i] >= c.vertexCount) badIdx++;
  ok(badIdx === 0, 'every index is in range', `${c.vertexCount} vertices, ${c.indexCount} indices`);
  ok(c.vertexCount <= 65535, 'vertex count fits uint16 indices', `${c.vertexCount}`);

  // Winding: the surface triangles must face up.
  let down = 0;
  const surfTris = (c.resolution - 1) * (c.resolution - 1) * 2;
  for (let t = 0; t < surfTris; t++) {
    const i0 = c.indices[t * 3], i1 = c.indices[t * 3 + 1], i2 = c.indices[t * 3 + 2];
    const ax = c.positions[i1 * 3] - c.positions[i0 * 3], az = c.positions[i1 * 3 + 2] - c.positions[i0 * 3 + 2];
    const bx = c.positions[i2 * 3] - c.positions[i0 * 3], bz = c.positions[i2 * 3 + 2] - c.positions[i0 * 3 + 2];
    if (az * bx - ax * bz <= 0) down++;   // y component of cross(e1, e2)
  }
  ok(down === 0, 'all surface triangles wind counter-clockwise from above', `${surfTris} triangles`);

  // Skirt: outward-facing.
  let inward = 0;
  const half = WORLD.CHUNK_SIZE * 0.5;
  for (let t = surfTris; t < c.indexCount / 3; t++) {
    const i0 = c.indices[t * 3], i1 = c.indices[t * 3 + 1], i2 = c.indices[t * 3 + 2];
    const p0 = [c.positions[i0 * 3], c.positions[i0 * 3 + 1], c.positions[i0 * 3 + 2]];
    const e1 = [c.positions[i1 * 3] - p0[0], c.positions[i1 * 3 + 1] - p0[1], c.positions[i1 * 3 + 2] - p0[2]];
    const e2 = [c.positions[i2 * 3] - p0[0], c.positions[i2 * 3 + 1] - p0[1], c.positions[i2 * 3 + 2] - p0[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    // Outward is away from the chunk centre in XZ.
    const ox = p0[0] - half, oz = p0[2] - half;
    if (n[0] * ox + n[2] * oz <= 0) inward++;
  }
  ok(inward === 0, 'all skirt triangles face outward', `${c.indexCount / 3 - surfTris} triangles, depth ${c.skirtDepth.toFixed(1)} m`);

  // The AABB must contain every vertex.
  let outside = 0;
  const ox = c.cx * WORLD.CHUNK_SIZE, oz = c.cz * WORLD.CHUNK_SIZE;
  for (let v = 0; v < c.vertexCount; v++) {
    const x = ox + c.positions[v * 3], y = c.positions[v * 3 + 1], z = oz + c.positions[v * 3 + 2];
    if (x < c.aabb.minX - 1e-4 || x > c.aabb.maxX + 1e-4 ||
        y < c.aabb.minY - 1e-4 || y > c.aabb.maxY + 1e-4 ||
        z < c.aabb.minZ - 1e-4 || z > c.aabb.maxZ + 1e-4) outside++;
  }
  ok(outside === 0, 'the AABB contains every vertex including the skirt', `${c.vertexCount} vertices`);

  // Interleaving round-trip.
  const buf = new ArrayBuffer(c.vertexCount * terrain.VERTEX_STRIDE);
  terrain.interleaveChunk(c, new Float32Array(buf), new Uint8Array(buf));
  const f = new Float32Array(buf), u = new Uint8Array(buf);
  let mismatch = 0;
  for (let v = 0; v < c.vertexCount; v += 37) {
    const o = v * 10;
    if (f[o] !== c.positions[v * 3] || f[o + 4] !== c.normals[v * 3 + 1] || f[o + 7] !== c.uvs[v * 2 + 1]) mismatch++;
    if (u[v * 40 + 32] !== c.material[v * 4]
        || u[v * 40 + 38] !== c.surface[v * 4 + 2]
        || u[v * 40 + 39] !== c.surface[v * 4 + 3]) mismatch++;
  }
  ok(mismatch === 0, 'interleaveChunk round-trips every channel', `stride ${terrain.VERTEX_STRIDE} B`);
}

console.log('\n== 12. ChunkManager streaming (stub GPU device) ==');
{
  let created = 0, destroyed = 0, written = 0, liveBytes = 0;
  const device = {
    createBuffer({ size }) {
      created++; liveBytes += size;
      return { size, destroy() { destroyed++; liveBytes -= size; } };
    },
    queue: { writeBuffer(buf, off, src, srcOff, len) { written += len ?? 0; } },
  };
  const camera = {
    position: new Float64Array([0, 4, 0]),
    worldOrigin: new Float64Array([0, 0, 0]),
    isBoxVisible: () => true,
  };

  const cm = new ChunkManager(device, camera, terrain);
  let loaded = 0, unloaded = 0;
  const { events, EVENTS } = await import('../src/core/events.js');
  events.on(EVENTS.CHUNK_LOADED, () => loaded++);
  events.on(EVENTS.CHUNK_UNLOADED, () => unloaded++);

  // Drive it like a frame loop until the queue drains.
  let frames = 0;
  const t0 = performance.now();
  cm.update(camera.position);
  while (cm.stats.queued > 0 && frames < 4000) { cm.update(camera.position); frames++; }
  const fillMs = performance.now() - t0;

  console.log(`       filled in ${frames} frames / ${fillMs.toFixed(0)} ms   loaded ${cm.loadedCount} chunks`);
  console.log(`       triangles ${cm.stats.triangles.toLocaleString()}   gpu ${(cm.stats.gpuBytes / 1048576).toFixed(1)} MB   buffers ${created}`);
  console.log(`       bake mean ${cm.stats.bakeMsAvg.toFixed(2)} ms   peak ${cm.stats.bakeMsPeak.toFixed(1)} ms`);
  ok(cm.stats.queued === 0, 'streaming queue drains', `${frames} frames`);
  ok(loaded === cm.loadedCount, 'CHUNK_LOADED fired once per resident chunk', `${loaded} events`);

  // LOD distribution.
  const byLod = new Array(WORLD.LOD_RINGS).fill(0);
  for (const c of cm.chunks.values()) byLod[c.lod]++;
  // Ring k covers out to LOD_BASE_DISTANCE * 2^k; the streaming radius is
  // capped at RENDER.MAX_VIEW_DISTANCE, so only the rings whose inner boundary
  // falls inside that radius can be occupied.
  const usableRings = 1 + Math.max(0, Math.min(WORLD.LOD_RINGS - 1,
    Math.ceil(Math.log2(cm.viewRadius / WORLD.LOD_BASE_DISTANCE))));
  console.log(`       chunks per ring: ${byLod.join(' / ')}   (view radius ${cm.viewRadius} m -> ${usableRings} usable rings)`);
  let populated = true;
  for (let i = 0; i < usableRings; i++) if (byLod[i] === 0) populated = false;
  ok(populated, 'every reachable ring is populated', byLod.slice(0, usableRings).join('/'));

  // Frame budget: with a full ring 0 already resident, a single frame must
  // never bake more than two LOD-0-equivalents.
  const before = created;
  camera.position[0] = 900; camera.position[2] = 900;
  cm.update(camera.position);
  let cost = 0;
  for (let i = 0; i < 1; i++) cost += cm.stats.bakesThisFrame;
  console.log(`       after a 1273 m jump: ${cm.stats.bakesThisFrame} bakes in the first frame, ${cm.stats.queued} queued, ${created - before} new buffers`);
  ok(cm.stats.bakesThisFrame <= cm.maxBakesPerFrame, 'per-frame bake cap respected',
    `${cm.stats.bakesThisFrame} <= ${cm.maxBakesPerFrame}`);

  // Drain again, then check buffer reuse and unloading.
  frames = 0;
  while (cm.stats.queued > 0 && frames < 4000) { cm.update(camera.position); frames++; }
  console.log(`       after move: loaded ${cm.loadedCount}, unloaded events ${unloaded}, pooled buffers ${cm.stats.pooledBuffers}`);
  ok(unloaded > 0, 'chunks outside the radius are unloaded', `${unloaded} events`);
  ok(cm.stats.pooledBuffers > 0, 'freed buffers are pooled for reuse', `${cm.stats.pooledBuffers} pooled`);

  const reuseBefore = created;
  camera.position[0] = 0; camera.position[2] = 0;
  frames = 0;
  cm.update(camera.position);
  while (cm.stats.queued > 0 && frames < 4000) { cm.update(camera.position); frames++; }
  console.log(`       returning to the origin created ${created - reuseBefore} new buffers (pool absorbed the rest)`);

  const vis = cm.visibleChunks(camera);
  ok(vis.length === cm.loadedCount, 'visibleChunks returns every chunk when nothing culls',
    `${vis.length} visible, ${cm.stats.visibleTriangles.toLocaleString()} triangles`);
  let sorted = true;
  for (let i = 1; i < vis.length; i++) if (vis[i].sortKey < vis[i - 1].sortKey) sorted = false;
  ok(sorted, 'visible chunks are sorted front to back', `${vis.length} entries`);

  cm.destroy();
  ok(liveBytes === 0, 'destroy() releases every GPU buffer', `${destroyed} destroyed, ${liveBytes} bytes live`);
  console.log(`       peak resident GPU bytes written: ${(written / 1048576).toFixed(1)} MB total uploads`);
}

console.log('\n== 13. layer registry ==');
{
  ok(Array.isArray(terrain.TERRAIN_LAYERS) && terrain.TERRAIN_LAYERS.length >= 12,
    'TERRAIN_LAYERS is introspectable', `${terrain.TERRAIN_LAYERS.length} layers`);
  let described = true;
  for (const l of terrain.TERRAIN_LAYERS) {
    if (typeof l.amplitude !== 'number' || typeof l.frequency !== 'number' || !l.note) described = false;
  }
  ok(described, 'every layer states amplitude (m), frequency (1/m) and rationale', '');
  for (const l of terrain.TERRAIN_LAYERS) {
    const f = l.frequency === 0 ? 'analytic' : `1/${(1 / l.frequency).toFixed(0)} m`;
    console.log(`       L${String(l.id).padStart(2)} ${l.name.padEnd(14)} ${String(l.amplitude).padStart(6)} m   ${f.padEnd(12)} oct ${l.octaves}`);
  }
}

console.log('\n== 14. deep-biome separation survives the water column ==');
{
  // Below about 90 m only BLUE gets back to the eye - measured transmittance at
  // the twilight camera (455, -120, 1926) is R 7.7e-14, G 1.1e-3, B 5.1e-2 - so
  // two deep biomes separated only by hue arrive at the display identical. The
  // header note in biomes.js used to assert the exact opposite and the catalogue
  // was authored on it; this guards the correction.
  //
  // The six BARE-ROCK records the header note is about. Coral Garden and Kelp
  // Forest are rocky by `rockiness` but their albedo is living cover, not rock,
  // and coral legitimately reflects 16%.
  const ROCK = ['basalt', 'boulders', 'break', 'spires', 'canyon', 'trenchWall'];
  let worst = null;
  for (const s of ROCK) {
    const b = biomes.BIOMES.find((r) => r.short === s);
    const lum = 0.2126 * b.albedo[0] + 0.7152 * b.albedo[1] + 0.0722 * b.albedo[2];
    if (lum < 0.02 || lum > 0.09) worst = `${b.short} reflects ${(100 * lum).toFixed(2)}%`;
  }
  ok(worst === null, 'every bare-rock biome still reflects between 2% and 9%',
    worst ?? ROCK.join(', '));

  // Boulder Field and Shelf Break are the pair that actually dominates the
  // twilight camera (71% / 25% of the blend over an 80 m radius), so they are
  // the pair that has to stay apart in the only channel that reaches it.
  const blue = (s) => biomes.BIOME_BY_ID[biomes.BIOMES.find((b) => b.short === s).id].albedo[2];
  const sep = blue('boulders') / blue('break');
  ok(sep > 1.8, 'boulders/break blue separation is at least 1.8x',
    `${blue('boulders')} / ${blue('break')} = ${sep.toFixed(2)}x`);
}

console.log('\n== 14b. biome macro-material contract ==');
{
  const shader = readFileSync(
    new URL('../src/render/shaders/pass/terrain.wgsl', import.meta.url), 'utf8');
  const baker = readFileSync(new URL('../src/world/terrain.js', import.meta.url), 'utf8');
  ok(baker.includes('saturate(mat.macroStyle) * 255')
      && shader.includes('let macroStyle = in.surface.w;'),
    'the spare terrain byte carries blended macroStyle',
    'CPU unorm8 writer -> interpolated WGSL input');
  ok(shader.includes('fn geologyMacro(')
      && ['carbonate', 'kelpStone', 'blockRock', 'shelfBeds', 'spireFlute', 'terraceBeds', 'pressure']
        .every((token) => shader.includes(token)),
    'all seven macro-geology families remain live',
    'carbonate, pitted, block, shelf, flute, strata, pressure');
  ok(shader.includes('mix(vec3f(1.0), geology.tint, bw.x)')
      && shader.includes('geology.relief * bw.x')
      && shader.includes('geology.rough * bw.x'),
    'macro geology is masked by exposed-rock coverage',
    'tint, physical relief, and roughness share bw.x');
  ok(shader.includes('bandGain(12.0, foot)')
      && shader.includes('dominantPlaneUV(absPos, geoN, 1.0 / 18.0)'),
    'macro relief is footprint-filtered and world-stable',
    '12 m filter over 18 m cells');
}

console.log('\n== 15. the bedding sequence terrain.wgsl builds on terrace() ==');
{
  // pass/terrain.wgsl authors its strata as terrace(0.5 + 0.5*sin(y*TAU/6.4), 3,
  // softness) and now crossfades that back to the bare sine with pixel
  // footprint, on two claims: that terrace() emits SIX risers per period no
  // matter how soft it is told to be, and that the crossfade is mean-preserving.
  // world/noise.js carries the identical formula, so both are checkable offline
  // and neither is allowed to drift.
  const { terrace } = await import('../src/world/noise.js');
  const P = 6.4, TAU = Math.PI * 2;
  const seq = (y, soft) => terrace(0.5 + 0.5 * Math.sin(y * (TAU / P)), 3.0, soft);

  for (const soft of [0.38, 1.0]) {
    const M = 20000, d = new Float64Array(M);
    let maxSlope = 0;
    for (let i = 0; i < M; i++) {
      const y = i * P / M;
      d[i] = (seq(y + 1e-4, soft) - seq(y - 1e-4, soft)) / 2e-4;
      maxSlope = Math.max(maxSlope, Math.abs(d[i]));
    }
    // Local maxima of |slope|, cyclically, so the riser at y = 0 is not lost off
    // the end of the scan the way a naive count loses it.
    let risers = 0;
    for (let i = 0; i < M; i++) {
      const a = Math.abs(d[(i - 1 + M) % M]), b = Math.abs(d[i]), c = Math.abs(d[(i + 1) % M]);
      if (b > a && b >= c && b > 0.1 * maxSlope) risers++;
    }
    ok(risers === 6, `softness ${soft}: six risers per 6.4 m period`,
      `${risers} risers, peak gradient ${maxSlope.toFixed(2)} /m, mean spacing ${(P / risers).toFixed(2)} m`);
  }

  // Mean preservation: terrace() is odd-symmetric about 0.5 and the sine's own
  // distribution is symmetric about 0.5, so both limbs of the crossfade have the
  // same mean and fading the risers out cannot slide a distant cliff half a bed
  // lighter or darker.
  const N = 400000;
  let ms = 0, mt = 0;
  for (let i = 0; i < N; i++) {
    const y = i * P / N, sv = 0.5 + 0.5 * Math.sin(y * (TAU / P));
    ms += sv; mt += terrace(sv, 3.0, 1.0);
  }
  ok(Math.abs(ms / N - mt / N) < 1e-5, 'terrace(sine) and sine have the same mean',
    `sine ${(ms / N).toFixed(6)}  terraced ${(mt / N).toFixed(6)}`);
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}\n`);
process.exit(fails === 0 ? 0 : 1);
