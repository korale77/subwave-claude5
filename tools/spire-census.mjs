#!/usr/bin/env node
/**
 * SUBWAVE Rock Spires tower census.
 *
 * Measures the SHAPE of the spire field the way a diver reads it: how tall each
 * tower stands above the ground it sits on, how wide it is halfway up, and how
 * much open water separates it from the next one. It runs entirely offline
 * against the real `terrain.sampleHeightFast`, so it measures the shipped
 * heightfield rather than a model of it.
 *
 *   node tools/spire-census.mjs                 # census + spire-chunk bake timing
 *   node tools/spire-census.mjs --no-bake       # census only, ~4x faster
 *   node tools/spire-census.mjs --out f.json    # also write the raw record
 *
 * WHY THESE DEFINITIONS. "Aspect ratio" has no canonical meaning on a
 * heightfield, so the three that matter are pinned here and must not drift
 * between runs or the before/after comparison is meaningless:
 *
 *   base       median height over the 16 rays at RING_R = 120 m, which is
 *              outside the widest authored foot (0.32 x 280 = 89.6 m before
 *              this pass, 53 m after) in both builds, so the same ring measures
 *              the same "ground the tower stands on" either side of a change.
 *              A median, not a minimum: a tower on a slope has one ray running
 *              downhill forever and one running into its neighbour.
 *   prominence peak height - base. This is what "178 m tower" means.
 *   width      2 x the mean radius at which the surface first falls below
 *              base + prominence/2, over the same 16 rays. Width at HALF
 *              prominence is the standard silhouette measure and it is the one
 *              the LAYER 5 profile was authored against.
 *   aspect     prominence / width. A cone at 45 deg scores 0.5; a needle scores
 *              high.
 *
 * PEAK_WIN = 7 cells = 56 m of separation. Chosen, not assumed: the LAYER 5
 * cluster puts two companion needles 61 m and 71 m from their parent, so a
 * smaller window counts a cluster as three towers and a much larger one merges
 * neighbouring clusters. At 56 m this census finds exactly 91 towers on the
 * pre-change build, which is the count the 2026-08 spire audit reported - an
 * independent instrument reproducing that number is the reason these
 * conventions are pinned rather than tuned per run.
 *
 * THE ASPECT SCALE IS NOT THE AUDIT'S. On that same build this census reads
 * p50 2.17 where the audit read 1.63, a systematic 1.33x, because the audit
 * measured the LAYER 5 profile in isolation and this measures the delivered
 * surface - and a tower sitting on a slope crosses half prominence sooner on
 * its downhill side. Compare census runs to census runs. The audit's own
 * closed-form figures (intrinsic aspect 2.65 at full mask) are profile
 * arithmetic and are quoted in terrain.js at the site.
 *
 * PEAK DETECTION uses `sampleHeightFast`, which drops the dune, talus and micro
 * layers. That is deliberate: those are sub-2 m and would put a spurious local
 * maximum on every square metre of seabed. Everything a tower is made of
 * survives the fast path.
 */
import { WORLD } from '../src/core/constants.js';
import * as terrain from '../src/world/terrain.js';
import { writeFileSync } from 'node:fs';

// ---- census parameters (pinned; changing one invalidates every past run) ----
// The LAYER 5 band is rw in [1680, 2860] after the domain warp; the warp moves
// a sample by up to WARP_AMP, so the census window is opened either side of it.
const R_INNER = 1560;
const R_OUTER = 2980;
const GRID = 8;          // m. Towers are 20-70 m wide, so 8 m resolves them.
const PEAK_WIN = 7;      // cells. A peak must dominate a 56 m radius.
const PROM_MIN = 40;     // m. Below this it is relief, not a tower.
const RAYS = 16;
const RAY_STEP = 4;      // m
const RAY_MAX = 240;     // m. Beyond the widest authored foot.
const RING_R = 120;      // m. Base ring, outside the foot in both builds.

const args = process.argv.slice(2);
const doBake = !args.includes('--no-bake');
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : null;

terrain.setSeed(WORLD.DEFAULT_SEED);

const pct = (sorted, p) => {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

// ---- 1. rasterise the annulus ---------------------------------------------
const N = Math.ceil((R_OUTER * 2) / GRID) + 1;
const H = new Float32Array(N * N).fill(-Infinity);
const t0 = performance.now();
let sampled = 0;
for (let j = 0; j < N; j++) {
  const z = -R_OUTER + j * GRID;
  for (let i = 0; i < N; i++) {
    const x = -R_OUTER + i * GRID;
    const r = Math.hypot(x, z);
    if (r < R_INNER || r > R_OUTER) continue;
    H[j * N + i] = terrain.sampleHeightFast(x, z);
    sampled++;
  }
}
const rasterMs = performance.now() - t0;

// ---- 2. local maxima --------------------------------------------------------
const peaks = [];
for (let j = PEAK_WIN; j < N - PEAK_WIN; j++) {
  for (let i = PEAK_WIN; i < N - PEAK_WIN; i++) {
    const h = H[j * N + i];
    if (!isFinite(h)) continue;
    let isPeak = true;
    for (let dj = -PEAK_WIN; dj <= PEAK_WIN && isPeak; dj++) {
      for (let di = -PEAK_WIN; di <= PEAK_WIN; di++) {
        if (di === 0 && dj === 0) continue;
        const o = H[(j + dj) * N + i + di];
        if (!isFinite(o)) continue;
        // Strict >, with index order breaking exact plateaux, so a flat top
        // yields one peak rather than a cluster of them.
        if (o > h || (o === h && (dj < 0 || (dj === 0 && di < 0)))) { isPeak = false; break; }
      }
    }
    if (isPeak) peaks.push({ x: -R_OUTER + i * GRID, z: -R_OUTER + j * GRID, h });
  }
}

// ---- 3. prominence, width, aspect ------------------------------------------
const towers = [];
for (const p of peaks) {
  const samples = [];
  const ring = [];
  for (let k = 0; k < RAYS; k++) {
    const a = (k / RAYS) * Math.PI * 2;
    const ux = Math.cos(a), uz = Math.sin(a);
    const row = [];
    for (let r = RAY_STEP; r <= RAY_MAX; r += RAY_STEP) {
      const h = terrain.sampleHeightFast(p.x + ux * r, p.z + uz * r);
      row.push(h);
      if (Math.abs(r - RING_R) < RAY_STEP * 0.5) ring.push(h);
    }
    samples.push(row);
  }
  const base = pct(ring.sort((a, b) => a - b), 0.5);
  const prom = p.h - base;
  if (prom < PROM_MIN) continue;

  const half = base + prom * 0.5;
  let widthSum = 0, widthN = 0;
  for (let k = 0; k < RAYS; k++) {
    const row = samples[k];
    let prev = p.h, hit = -1;
    for (let s = 0; s < row.length; s++) {
      const h = row[s];
      if (h < half) {
        const r1 = (s + 1) * RAY_STEP;
        // Linear crossing between the last sample above half and this one.
        const t = (prev - half) / (prev - h);
        hit = r1 - RAY_STEP * (1 - t);
        break;
      }
      prev = h;
    }
    if (hit > 0) { widthSum += hit; widthN++; }
  }
  // A tower whose rays mostly never cross half prominence inside RAY_MAX is a
  // massif, not a spire; recording it with a fabricated width would flatter the
  // aspect statistic.
  if (widthN < RAYS * 0.75) continue;
  const width = 2 * (widthSum / widthN);
  towers.push({ x: p.x, z: p.z, y: p.h, base, prom, width, aspect: prom / width });
}

// ---- 4. nearest-neighbour spacing ------------------------------------------
const nn = [];
for (let a = 0; a < towers.length; a++) {
  let best = Infinity;
  for (let b = 0; b < towers.length; b++) {
    if (a === b) continue;
    const d = Math.hypot(towers[a].x - towers[b].x, towers[a].z - towers[b].z);
    if (d < best) best = d;
  }
  if (isFinite(best)) nn.push(best);
}

const aspects = towers.map(t => t.aspect).sort((a, b) => a - b);
const proms = towers.map(t => t.prom).sort((a, b) => a - b);
const widths = towers.map(t => t.width).sort((a, b) => a - b);
const nnSorted = nn.slice().sort((a, b) => a - b);
const frac = (arr, v) => arr.filter(a => a >= v).length / (arr.length || 1);

const record = {
  seed: WORLD.DEFAULT_SEED,
  region: { rInner: R_INNER, rOuter: R_OUTER, grid: GRID, promMin: PROM_MIN },
  sampled, rasterMs: +rasterMs.toFixed(1), peaks: peaks.length,
  towerCount: towers.length,
  aspect: {
    p10: +pct(aspects, 0.1).toFixed(3), p50: +pct(aspects, 0.5).toFixed(3),
    p90: +pct(aspects, 0.9).toFixed(3), max: +(aspects[aspects.length - 1] ?? NaN).toFixed(3),
    fracGE3: +frac(aspects, 3).toFixed(4), fracGE4: +frac(aspects, 4).toFixed(4),
  },
  prominence: { p10: +pct(proms, 0.1).toFixed(1), p50: +pct(proms, 0.5).toFixed(1), max: +(proms[proms.length - 1] ?? NaN).toFixed(1) },
  width: { p10: +pct(widths, 0.1).toFixed(1), p50: +pct(widths, 0.5).toFixed(1), max: +(widths[widths.length - 1] ?? NaN).toFixed(1) },
  nnSpacing: { p10: +pct(nnSorted, 0.1).toFixed(1), p50: +pct(nnSorted, 0.5).toFixed(1), p90: +pct(nnSorted, 0.9).toFixed(1) },
  towers: towers.map(t => ({
    x: Math.round(t.x), z: Math.round(t.z), y: +t.y.toFixed(1),
    prom: +t.prom.toFixed(1), width: +t.width.toFixed(1), aspect: +t.aspect.toFixed(2),
  })).sort((a, b) => b.aspect - a.aspect),
};

console.log('\n== Rock Spires tower census ==');
console.log(`  region        annulus r [${R_INNER}, ${R_OUTER}] m, ${GRID} m grid, ${sampled} samples in ${rasterMs.toFixed(0)} ms`);
console.log(`  peaks         ${peaks.length} local maxima -> ${towers.length} towers at prominence >= ${PROM_MIN} m`);
console.log(`  aspect        p10 ${record.aspect.p10}  p50 ${record.aspect.p50}  p90 ${record.aspect.p90}  max ${record.aspect.max}`);
console.log(`                >= 3.0: ${(record.aspect.fracGE3 * 100).toFixed(1)}%   >= 4.0: ${(record.aspect.fracGE4 * 100).toFixed(1)}%`);
console.log(`  prominence m  p10 ${record.prominence.p10}  p50 ${record.prominence.p50}  max ${record.prominence.max}`);
console.log(`  width m       p10 ${record.width.p10}  p50 ${record.width.p50}  max ${record.width.max}`);
console.log(`  nn spacing m  p10 ${record.nnSpacing.p10}  p50 ${record.nnSpacing.p50}  p90 ${record.nnSpacing.p90}`);
console.log('  tallest 6 by aspect:');
for (const t of record.towers.slice(0, 6)) {
  console.log(`    (${String(t.x).padStart(6)},${String(t.z).padStart(6)})  y ${String(t.y).padStart(8)}  prom ${String(t.prom).padStart(6)}  width ${String(t.width).padStart(6)}  aspect ${t.aspect}`);
}

// ---- 5. bake cost, measured on chunks that actually contain spires ---------
// test-terrain's section 7 samples the whole world; LAYER 5 only executes
// inside the band, so a change there can hide inside that average. These four
// chunk coordinates are inside the annulus and inside the 105-670 m depth gate.
if (doBake) {
  const cases = [[13, 0], [12, 12], [0, 15], [20, 6], [-14, -9], [16, -11]];
  console.log('\n== LOD-0 bake, spire-band chunks (best of 6) ==');
  for (let i = 0; i < 4; i++) terrain.bakeChunk(13, 0, 0);
  const bakes = [];
  for (const [cx, cz] of cases) {
    let best = Infinity, sum = 0;
    for (let i = 0; i < 6; i++) { const c = terrain.bakeChunk(cx, cz, 0); best = Math.min(best, c.bakeMs); sum += c.bakeMs; }
    const cxm = (cx + 0.5) * WORLD.CHUNK_SIZE, czm = (cz + 0.5) * WORLD.CHUNK_SIZE;
    const d = -terrain.sampleHeightFast(cxm, czm);
    bakes.push({ cx, cz, r: Math.round(Math.hypot(cxm, czm)), depth: +d.toFixed(0), best: +best.toFixed(2), mean: +(sum / 6).toFixed(2) });
    console.log(`  (${String(cx).padStart(3)},${String(cz).padStart(3)})  r ${String(Math.round(Math.hypot(cxm, czm))).padStart(4)} m  depth ${String(d.toFixed(0)).padStart(4)} m   best ${best.toFixed(2)} ms   mean ${(sum / 6).toFixed(2)} ms`);
  }
  record.bakes = bakes;
  console.log(`  worst best-of-6: ${Math.max(...bakes.map(b => b.best)).toFixed(2)} ms`);
}

if (outPath) {
  writeFileSync(outPath, JSON.stringify(record, null, 2));
  console.log(`\n  wrote ${outPath}`);
}
