#!/usr/bin/env node
/**
 * SUBWAVE offline scatter census - what each biome is actually MADE OF.
 *
 * Every Stage 3 acceptance criterion named "an offline census over the emitted
 * instance transforms" as its instrument, and until 2026-08-06 no such tool
 * existed in this tree. Every Stage 3 figure in
 * the documentation therefore came from a throwaway script that
 * was not kept: `git log --all -S` puts "65.1", "74.8", "0.455", "0.296",
 * "0.673", "0.459", "229 deep chunks" and "225 chunks" in documentation commits
 * only, and no census over the emitted scatter instances has ever existed in
 * this tree. (Five files with "census" in the name have been added over the
 * project's life - `spire-census` measures the TERRAIN, and the four under
 * `tools/probes/` are live browser instruments.) Three mutually incomparable
 * chunk samples are quoted - 225, 229 and "251 chunks around the seven deep
 * anchors" (`src/world/scatter.js:1493`) - and NONE of them is enumerated
 * anywhere.
 *
 * SO THIS TOOL RE-BASELINES. IT DOES NOT CONTINUE A SERIES. A number it prints
 * may differ from one of those figures for four reasons that cannot be told
 * apart after the fact - a different chunk sample, a different definition, a
 * real change in the world, or a different SCOPE - and anyone quoting a
 * before/after across that boundary is measuring all four at once. Take a
 * control run on the tree you are about to change, and compare against THAT.
 *
 * ONE OF THOSE FOUR IS ALREADY IDENTIFIED AND IT IS WORTH STATING HERE. The
 * documented dark-instance figures (abyssal 0.206, trenchWall 0.094, canyon
 * 0.039) are PRE-STAGE-1. Commit `34c76a4` raised four signature rows' emission
 * - `abyssRib` 0 -> 2.2, `trenchWallSpine` 0.24 -> 1.4, `canyonBanner`
 * 0.52 -> 1.4, `terraceVeil` 0.28 -> 1.4 - and those four rows ARE the deep's
 * >= 10 m mass. So the deep's dark column went to exactly zero by an EMISSIVE
 * edit and not by any change in geometry, which is why section 2 prints the
 * emissive-free column beside it: item 3.3's gap on this tree is a CONTRAST
 * problem, not an absence of tall forms.
 *
 *   node tools/scatter-census.mjs                     # the anchor sample
 *   node tools/scatter-census.mjs --only kelp,abyssal # a subset of biomes
 *   node tools/scatter-census.mjs --full              # every type in every biome
 *   node tools/scatter-census.mjs --out base.json     # -> census-output/base.json
 *   node tools/scatter-census.mjs --sample lattice    # every chunk in the disc
 *
 * WHAT IT EMITS, and the list is the prerequisite verbatim:
 *   1. type shares by COUNT and by FOOTPRINT, plus waterline-breach fraction
 *   2. TOTAL EMITTED FLUX per biome and per type
 *   3. the pairwise VOCABULARY COSINE over type mixes, count-weighted AND
 *      footprint-weighted, with a shallow control column
 *   4. the DARK-INSTANCE EXPECTATION - expected number of instances with
 *      emissive < 0.5 and height >= 10 m within 25 m of a random seabed point
 *   5. the GENERATOR/TYPE map, and how much of each biome is shared vocabulary
 *
 * ============================================================================
 * THE DEFINITIONS ARE PINNED HERE. CHANGING ONE INVALIDATES EVERY PAST RUN.
 * ============================================================================
 *
 * DELIVERED, NOT OFFERED. Every count below comes from `generateScatterForChunk`
 * - the real emit path, after the per-cell cap, after `biomeDensity`, after the
 * per-type `maxPerChunk` and after the global budget. It is deliberately NOT
 * `censusTypeByBiome`, which walks at `keep = 1` and reports the OFFERED
 * population: that is the right quantity for verifying a weight and the wrong
 * one for asking what a biome looks like.
 *
 * THE BIOME OF AN INSTANCE IS THE PLACEMENT LOOP'S OWN ANSWER, via
 * `opts.biomeOut`. Re-classifying an emitted position with `biomeAt` disagrees
 * with the walk on a measured 15-20% of boundary candidates, because the walk's
 * slope comes from the chunk's 4 m field grid and an exact `terrain.sampleSlope`
 * is a different number (`src/world/scatter.js`, `sampleField`'s header: the two
 * agree on 76.6% of samples and the slope alone is 23.19% of the disagreement).
 *
 * AND THE AREA USES THE SAME FIELD, via `sampleChunkField`. A density is a count
 * over an area, and a count bucketed by one classifier under an area bucketed by
 * another is biased by that whole residual, per biome, by an amount that depends
 * on how much sub-4 m relief the biome carries.
 *
 * FOOTPRINT is the world-space SILHOUETTE `(meshWidth * sxz) x (meshHeight * sy)`
 * summed over a biome's delivered instances. That definition is not invented
 * here - it is written out at `src/world/scatter.js:1487-1491`, and it is a
 * SILHOUETTE (a side-on rectangle) rather than a ground footprint because what
 * is being asked is how much of the frame a form fills. It is measured off the
 * real generated mesh because `meshParams` carry METRES: `abyssRib`'s boneRib is
 * authored 20 m long and `shelfUrn`'s barrel 3.8 m, so a share computed off the
 * scale band alone is 20x wrong between two rows.
 *
 *   meshHeight  = aabb.max[1] - aabb.min[1] at unit scale.
 *   meshWidth   = 2 * max over vertices of hypot(x, z), at unit scale.
 *
 * MESHWIDTH IS A FIRST-ORDER LEVER, BOTH DEFINITIONS ARE REPORTED, AND THE
 * PRIMARY IS THE AABB ONE FOR A MEASURED REASON. The choice is worth up to HALF
 * a row's footprint, not a rounding error: over all 42 rows the AABB form
 * undershoots the rotation-invariant one by 1.6% to 53.3%, worst on
 * `alienFrond`, `kelpGiant`, `boneRib` and `abyssRib`, and it moves the deep-six
 * footprint cosine 0.0676 -> 0.0801. The theoretically better form is the
 * rotation-invariant one - every instance carries a hashed yaw about Y
 * (`scatter.js`'s `const yaw = h2 * TAU`), so an AABB extent measures whichever
 * way the mesh happened to be authored rather than what the instance presents.
 * The AABB form is reported anyway BECAUSE IT IS THE ONE THE LOST SCRIPT USED,
 * and that is measurable rather than assumed: against the six shipped shares at
 * `scatter.js:1498-1503` it lands terraceVeil 83.57 vs 83.79, canyonBanner 63.65
 * vs 63.35, trenchWallSpine 44.59 vs 43.62 and abyssRib 47.91 vs 48.52, while
 * the rotation-invariant form misses abyssRib by 9.2 points. Continuity with the
 * only before-column that exists is worth more here than the better definition,
 * and section 4c prints both so nobody is trapped by the choice.
 * `mesh.boundingRadius` is usable for NEITHER: it is a 3-D radius from the local
 * origin, so on a tall form it is dominated by height (`kelpGiant` 16.97 against
 * a true XZ half-width of 5.25).
 *
 * HEIGHT IS REPORTED TWO WAYS AND THE DARK GATE USES THE WORLD ONE.
 *   stem height  = meshHeight * sy. The length along the instance's own local Y
 *                  axis. Exact, but `align` and `tilt` rotate that axis, so on a
 *                  wall-hanging row it is not a vertical extent at all.
 *   world height = the Y extent of the TRANSFORMED AABB. What actually stands
 *                  between an eye and the background, and therefore what item
 *                  3.3's ">= 10 m" is about. It is an OVER-BOUND of the real
 *                  mesh - a box around a tilted thin form is taller than the
 *                  form - by up to about 5 m on the widest tilted rows.
 * The truth is between the two and both are printed, because they disagree by up
 * to 1.69x in the mean on the row that carries Boulder Field's occluding mass.
 *
 * WATERLINE BREACH is the maximum world Y over the transformed AABB, exactly:
 * the maximum of a linear function over a box is a three-term sum, so the exact
 * answer costs the same as `y + meshTop * sy`, which is simply wrong for any row
 * whose local up is not world up (`kelpStalk` is `align` 1.0). It inherits the
 * same AABB over-bound as world height, so a non-zero breach fraction is an
 * upper bound.
 *
 * EMITTED FLUX is radiant intensity in W/sr per instance,
 * `typeFlux * s^2 * emitScale` with `s = cbrt(sxz^2 * sy)` and `emitScale` the
 * instance's tint.a byte over 255 - the per-instance gain expression
 * `submitLights` uses. The per-type `typeFlux` comes from `bakeScatterTypeEmit`
 * in `src/render/scatter_emit.js`, WHICH IS THE RENDERER'S OWN BAKE, imported
 * and not transcribed. It was a closure inside `makeScatterPass()` until this
 * tool needed it, and that is the reason this tool could not be written before.
 *
 * TWO SCALARS ARE PRINTED AND THEY ARE NOT INTERCHANGEABLE. `flux(luma)` is the
 * Rec709 luma of the RGB triple; `flux(peak)` is `max(r, g, b)`, which is what
 * `lightMeta.peak` holds and therefore what `submitLights` RANKS lights on. They
 * differ by 1.19x-2.98x per type and 1.71x-2.50x per biome, because a
 * single-channel emitter's luma understates it. Item 3.1's gate is about light,
 * so read `flux(peak)`; the luma column is the one that reproduces the prior
 * figures at `scatter.js:1498-1503`.
 *
 * FLUORESCENCE IS NOT DISCOUNTED, AND THAT MATTERS FOR FOUR CORAL ROWS. A
 * fluorescing type is pumped by the blue daylight surviving to its own depth, so
 * its delivered emission is a per-depth quantity the CPU bake deliberately does
 * not fold in. The flux columns are therefore the AUTHORED PEAK. `noFluo` beside
 * them is the same total with fluorescing rows removed entirely, which brackets
 * the truth from below; only Shelf Break among the deep six is affected at all.
 *
 * DARK INSTANCE means `type.emissive < 0.5` AND world height >= 10 m, which is
 * item 3.3's own wording. THE EXPECTATION IS A DIRECT COUNT, not a density: for
 * every seabed sample point whose 25 m disc lies wholly inside the chunk sample,
 * the real dark instances within 25 m are counted, so clustering (colony blocks)
 * and truncation at the biome boundary are handled exactly rather than assumed
 * away. The areal-density estimate `darkCount / area * pi * 25^2` is printed
 * beside it as a cross-check and is biased UPWARD by 1.12x-1.71x precisely
 * because it assumes the whole disc is inside the biome - which is
 * anti-conservative for a `>= 1.0` gate, and is why it is not the gated number.
 * P(0) is printed with it: a mean of 4.0 over a seabed where 44% of points see
 * nothing is a different instruction than a mean of 4.0 spread evenly.
 *
 * ============================================================================
 * WHAT THIS TOOL CANNOT TELL YOU
 * ============================================================================
 *
 * It measures what is PLACED, not what is DRAWN or what is SEEN. It does not
 * know about view distance, LOD, frustum culling, occlusion, the water column,
 * or the light selection - so a type with a large footprint share can be
 * invisible at its biome's own visibility, and `scatterPass.lightReport()`'s
 * DELIVERED IN-FRUSTUM IRRADIANCE is a different quantity by two to three orders
 * of magnitude and must not be quoted beside these flux figures as if they
 * corroborated each other. For what a frame is made of, use
 * `tools/test-variety.mjs` on delivered pixels; CLAUDE.md's standing rule is
 * that an offline count is not evidence that a picture improved.
 */

import { WORLD } from '../src/core/constants.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as terrain from '../src/world/terrain.js';
import * as meshgen from '../src/world/meshgen.js';
import { biomeAt, BIOMES, BIOME_COUNT } from '../src/world/biomes.js';
import { resolveBiomeAnchors } from '../src/world/biome_anchors.js';
import { scatterGeneratorArgs, bakeScatterTypeEmit } from '../src/render/scatter_emit.js';
import {
  SCATTER_TYPES, SCATTER_TYPE_COUNT, SCATTER_STRIDE, SCATTER_FLOATS_PER_INSTANCE,
  SCATTER_MAX_PER_CHUNK, SCATTER_TUNING,
  generateScatterForChunk, sampleChunkField, scatterStats, resetScatterStats,
} from '../src/world/scatter.js';

const CHUNK = WORLD.CHUNK_SIZE;
const F = SCATTER_FLOATS_PER_INSTANCE;

/** Radius of the disc item 3.3's acceptance criterion is stated over, metres. */
const DARK_RADIUS = 25;
/** World height at or above which an instance counts as occluding mass, m. */
const DARK_HEIGHT = 10;
/** Authored emissive below which an instance counts as DARK, cd/m^2. */
const DARK_EMISSIVE = 0.5;
/** Near-field disc radii for the anchor scope, metres. See section 7. */
const NEAR_RADII = [30, 120];

/** The six deep biomes Stage 3 is written against, by BIOMES id. */
const DEEP_SIX = [7, 8, 9, 10, 11, 12];
/** Deep seven adds Trench Floor, which is what the tour's headline uses. */
const DEEP_SEVEN = [7, 8, 9, 10, 11, 12, 13];
/** The shallow control set: everything above the shelf break. */
const SHALLOW_SEVEN = [0, 1, 2, 3, 4, 5, 6];

/**
 * A biome must clear BOTH to be quoted in a cosine. The instance floor alone is
 * not enough and that is measured, not assumed: Trench Floor clears 200 at 1,375
 * instances from 29 chunks and its own split-half footprint self-cosine is
 * 0.839, against >= 0.9956 for every other biome - so its 42-element share
 * vector is two orders of magnitude noisier than the rest and the deep-seven
 * headline moves 17.6% between ring 3 and ring 5 on it alone. The self-cosine
 * below is the real gate; the two floors are the cheap pre-filter.
 */
const MIN_INSTANCES = 200;
const MIN_CHUNKS = 40;
const MIN_SELF_COSINE = 0.98;

// ---- CLI -------------------------------------------------------------------
const args = process.argv.slice(2);
const die = (msg) => { console.error(msg); process.exit(2); };
/**
 * A flag's value, or the default. A value that is MISSING or that looks like
 * another flag is treated as absent and rejected by the caller's own guard - so
 * `--out` in last position fails immediately with a message rather than throwing
 * an ERR_INVALID_ARG_TYPE inside writeFileSync after the whole walk has run.
 */
const flag = (n, d = null) => {
  const i = args.indexOf(n);
  if (i < 0) return d;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) die(`${n} needs a value`);
  return v;
};
const has = (n) => args.includes(n);

const sampleMode = flag('--sample', 'anchors');
const ring = Number(flag('--ring', '3'));
const areaStep = Number(flag('--area-step', '4'));
const lod = Number(flag('--lod', '0'));
const seed = has('--seed') ? Number(flag('--seed')) : WORLD.DEFAULT_SEED;
let outPath = flag('--out', null);
// Same normalization test-variety.mjs got on 2026-08-07: a bare `--out name`
// otherwise writes an extension-less file that every committed record and
// .gitignore re-include pattern expects to end in .json.
if (outPath && !/\.json$/i.test(outPath)) outPath += '.json';
const onlyArg = flag('--only', null);
const showFull = has('--full');
const topN = Number(flag('--top', '8'));

if (!['anchors', 'lattice', 'both'].includes(sampleMode)) die(`--sample must be anchors, lattice or both (got ${sampleMode})`);
if (!Number.isInteger(ring) || ring < 0 || ring > 16) die(`--ring must be an integer 0..16 (got ${ring})`);
if (!Number.isFinite(areaStep) || areaStep <= 0 || CHUNK % areaStep !== 0) die(`--area-step must divide ${CHUNK} exactly (got ${areaStep})`);
if (!Number.isInteger(lod) || lod < 0 || lod >= WORLD.LOD_RINGS) die(`--lod must be an integer 0..${WORLD.LOD_RINGS - 1} (got ${lod})`);
if (!Number.isFinite(seed)) die('--seed must be a number');
if (!Number.isInteger(topN) || topN < 1) die(`--top must be a positive integer (got ${topN})`);
// A bare name lands in census-output/, beside the other tools' output
// directories and covered by the same .gitignore rule.
if (outPath !== null && !outPath.includes('/')) outPath = `census-output/${outPath}`;

// ---- small helpers ---------------------------------------------------------

/** Percentile of an array. Copies before sorting - a sort in place would
 *  silently corrupt a caller that reuses the array, which is a live trap in
 *  tools/spire-census.mjs. */
const pct = (arr, p) => {
  if (arr.length === 0) return NaN;
  const s = Array.prototype.slice.call(arr).sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const f = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '  --');
const pc = (v, d = 2) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '  --');
const REC709 = (r, g, b) => r * 0.2126 + g * 0.7152 + b * 0.0722;

/** FNV-1a over the sample's own text, so two runs can PROVE they used one set. */
function digest(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ---- 0. the world ----------------------------------------------------------
terrain.setSeed(seed);
resetScatterStats();

const anchors = resolveBiomeAnchors(terrain);
const shortOf = BIOMES.map((b) => b.short);
const idOfShort = new Map(BIOMES.map((b) => [b.short, b.id]));

let onlyIds = null;
if (onlyArg !== null) {
  onlyIds = new Set();
  for (const s of onlyArg.split(',').map((x) => x.trim()).filter(Boolean)) {
    if (!idOfShort.has(s)) die(`--only: unknown biome '${s}'. Known: ${shortOf.join(', ')}`);
    onlyIds.add(idOfShort.get(s));
  }
  if (onlyIds.size === 0) die('--only: no biomes named');
}
/** Printed above every gated table when the sample is restricted. */
const ONLY_WARNING = onlyIds === null ? null :
  '  !! --only IS SET. The chunk sample was built around a SUBSET of the anchors, so a biome\n' +
  '     outside that subset appears only where a neighbouring box happened to reach it.\n' +
  '     NOTHING BELOW IS COMPARABLE WITH A FULL-SAMPLE RUN.';

// ---- 1. the chunk sample ---------------------------------------------------
//
// STATED AND ENUMERABLE, because the prerequisite this tool answers says so in
// as many words: "Print the chunk sample and the seed beside every table, or the
// after cannot be compared with the before."
//
// The anchor sample is the default and it is the honest one for a per-biome
// question: a whole-playfield lattice under-samples every biome that is not
// large, and Trench Floor holds 0.063% of the seabed. The lattice sample is
// offered for a question about the WORLD rather than about a biome, and for the
// waterline-breach gate, which needs the shallow end of a depth band that no
// deep anchor box contains.
//
// NOTE THE TRAP THIS AVOIDS. `tools/test-scatter.mjs`'s 200-entry lattice
// `((i*13)%47)-23, ((i*29)%47)-23` is a function of `i mod 47` and therefore
// visits only 47 DISTINCT chunks - 35 of them four times and 12 of them five.
// That is harmless for maxima and per-chunk timings, which is all that suite
// asks of it, and it silently weights 12 sites 25% high in any SHARE. Every
// chunk here is deduplicated by key before anything is generated.
const chunkSet = new Map();
/** key -> the anchor neighbourhoods this chunk belongs to. A chunk in two
 *  overlapping boxes is counted once in the biome tables and once per anchor in
 *  the neighbourhood table, which is what each of those questions wants. */
const chunkTags = new Map();
const addChunk = (cx, cz, tag) => {
  const k = `${cx},${cz}`;
  chunkSet.set(k, [cx, cz]);
  if (tag !== undefined) {
    let s = chunkTags.get(k);
    if (s === undefined) { s = []; chunkTags.set(k, s); }
    if (!s.includes(tag)) s.push(tag);
  }
};

const anchorChunks = [];
if (sampleMode === 'anchors' || sampleMode === 'both') {
  for (const a of anchors) {
    if (!a) continue;
    if (onlyIds !== null && !onlyIds.has(a.id)) continue;
    const acx = Math.floor(a.x / CHUNK), acz = Math.floor(a.z / CHUNK);
    for (let dz = -ring; dz <= ring; dz++) {
      for (let dx = -ring; dx <= ring; dx++) addChunk(acx + dx, acz + dz, a.short);
    }
    anchorChunks.push({ short: a.short, id: a.id, cx: acx, cz: acz, x: a.x, z: a.z });
  }
}
if (sampleMode === 'lattice' || sampleMode === 'both') {
  // EVERY CHUNK OF A 49 x 53 RECTANGLE, CLIPPED TO THE PLAYFIELD DISC - not a
  // stride. 49 and 53 are coprime, so (i % 49, i % 53) enumerates the whole
  // rectangle in 2,597 steps without repeating. 49 rather than 47 because the
  // disc is 48 chunks across at HALF_EXTENT and a 47-wide residue range leaves
  // the outermost column unreachable.
  for (let i = 0; i < 49 * 53; i++) {
    const cx = (i % 49) - 24;
    const cz = (i % 53) - 26;
    if (Math.hypot((cx + 0.5) * CHUNK, (cz + 0.5) * CHUNK) > WORLD.HALF_EXTENT) continue;
    addChunk(cx, cz);
  }
}

const chunks = [...chunkSet.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const sampleText = chunks.map(([x, z]) => `${x},${z}`).join(';');
const sampleDigest = digest(sampleText);
const chunkIndex = new Map(chunks.map(([x, z], i) => [`${x},${z}`, i]));
if (chunks.length === 0) die('the chunk sample is empty - check --only / --sample');

// ---- 2. per-type mesh metrics ----------------------------------------------
//
// Built ONCE at each row's own `maxDetail`, which is the tier the emission bake
// uses and the truest statement of the form; the same mesh is handed to
// `bakeScatterTypeEmit` rather than regenerated.
//
// `MESH_GENERATORS` / `buildMesh` in meshgen.js are NOT used and must not be:
// nothing under src/ imports them, they hard-code different size arguments from
// the ones the scatter rows author (measured: 'kelp' through that registry is
// 3.84 m against kelpStalk's real 7.05 m), and only 12 of the 42 rows have an
// entry there at all.
const typeMeta = new Array(SCATTER_TYPE_COUNT);
let meshBuildMs = 0;
{
  const t0 = performance.now();
  for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
    const type = SCATTER_TYPES[t];
    const generator = meshgen[type.generator];
    if (typeof generator !== 'function') {
      console.error(`[census] meshgen does not export ${type.generator} for ${type.key}`);
      process.exit(1);
    }
    const mesh = generator(
      ...scatterGeneratorArgs(type, { ...type.meshParams, detail: type.maxDetail }));
    const p = mesh.positions;
    let maxR2 = 0;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const x = p[i * 3], z = p[i * 3 + 2];
      const r2 = x * x + z * z;
      if (r2 > maxR2) maxR2 = r2;
    }
    const min = mesh.aabb.min, max = mesh.aabb.max;
    const emit = bakeScatterTypeEmit(type, generator, mesh);
    const flux = emit === null ? [0, 0, 0] : emit.flux;
    typeMeta[t] = {
      key: type.key,
      generator: type.generator,
      meshHeight: max[1] - min[1],
      meshWidth: 2 * Math.sqrt(maxR2),
      meshWidthAabb: Math.max(max[0] - min[0], max[2] - min[2]),
      aabb: [min[0], min[1], min[2], max[0], max[1], max[2]],
      emissive: type.emissive,
      fluoresces: !!type.fluoresces,
      signatureBiome: type.signatureBiome,
      depth: type.depth,
      // W/sr at instance scale 1 and emitScale 1, from the RENDERER's own bake.
      flux,
      fluxLuma: REC709(flux[0], flux[1], flux[2]),
      fluxPeak: Math.max(flux[0], flux[1], flux[2]),
    };
  }
  meshBuildMs = performance.now() - t0;
}

/** How far apart the two candidate meshWidth definitions are, per row. */
const widthSpread = typeMeta.map((m) => (m.meshWidth > 0 ? m.meshWidthAabb / m.meshWidth : 1));

// ---- 3. accumulators -------------------------------------------------------
const zeros = () => new Float64Array(SCATTER_TYPE_COUNT);
const per = BIOMES.map(() => ({
  count: zeros(),
  footprint: zeros(),          // PRIMARY: the AABB meshWidth
  footprintRot: zeros(),       // the rotation-invariant alternative, for 4c
  fluxLuma: zeros(),
  fluxPeak: zeros(),
  breach: zeros(),
  stemSum: zeros(),
  worldSum: zeros(),
  darkCount: zeros(),          // emissive < 0.5 AND world height >= 10 m
  tallCount: zeros(),          // world height >= 10 m, emissive irrelevant
  minDepth: new Float64Array(SCATTER_TYPE_COUNT).fill(Infinity),
  heights: new Map(),          // typeId -> number[] of world heights
  area: 0,
  areaSubmerged: 0,
  chunks: new Set(),
  // The split-half control: A is the even-indexed chunks of the sample, B the
  // odd. Nothing may be promoted to a gate without a control column.
  countA: zeros(), countB: zeros(), footA: zeros(), footB: zeros(),
}));

const instances = { total: 0, breachAll: 0, breachSubmerged: 0, submerged: 0 };
const chunkInstanceCounts = [];
/** Every dark tall instance as (x, z, biome), for the direct expectation. */
const darkPos = [];
/** Every tall instance as (x, z, biome), dark or not. */
const tallPos = [];
/** Seabed sample points, for the same. */
const pointX = [], pointZ = [], pointB = [];

/**
 * THE ANCHOR NEIGHBOURHOOD - a SECOND scope, and the two answer different
 * questions. Everything above is scoped by the instance's own BIOME. This is
 * scoped by the CHUNK BOX around an anchor, and by two DISCS inside it, whatever
 * biome each instance belongs to.
 *
 * BOTH DISC RADII ARE THERE BECAUSE THE CHUNK BOX IS NOT A FRAME. A ring-3 box
 * is 896 m across; COASTAL_GREEN's green beam extinction is 0.365/m, i.e. a
 * 2.7 m 1/e range and about 25 m of useful sight. So the box answers "what is
 * around here" and the 30 m disc answers "what is in the picture", and they can
 * disagree completely - at the kelp anchor the box is 11.9% Kelp Forest and 40%
 * Sand Plains seagrass while the 30 m disc is neither.
 */
const perAnchor = new Map();
const anchorRec = () => ({
  count: zeros(), footprint: zeros(), byBiome: new Float64Array(BIOME_COUNT), total: 0,
  near: NEAR_RADII.map(() => ({ count: zeros(), byBiome: new Float64Array(BIOME_COUNT), total: 0 })),
});

// ---- 4. the walk -----------------------------------------------------------
const biomeOut = new Uint8Array(SCATTER_MAX_PER_CHUNK);
const fieldOut = { height: 0, slope: 0, slopeSigned: 0, nx: 0, ny: 1, nz: 0 };
const areaCell = areaStep * areaStep;
const areaN = CHUNK / areaStep;

const tWalk0 = performance.now();
for (const [cx, cz] of chunks) {
  const half = chunkIndex.get(`${cx},${cz}`) % 2;
  const data = generateScatterForChunk(cx, cz, lod, { biomeOut });
  const fl = data.instances;
  const u8 = new Uint8Array(fl.buffer, fl.byteOffset, data.count * SCATTER_STRIDE);
  chunkInstanceCounts.push(data.count);
  const ox = cx * CHUNK, oz = cz * CHUNK;
  const tags = chunkTags.get(`${cx},${cz}`) ?? [];
  const tagRecs = tags.map((t) => {
    let r = perAnchor.get(t);
    if (r === undefined) { r = anchorRec(); perAnchor.set(t, r); }
    return r;
  });
  const tagAnchors = tags.map((t) => anchorChunks.find((a) => a.short === t));

  for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
    const n = data.countsByType[t];
    if (n === 0) continue;
    const first = data.firstByType[t];
    const m = typeMeta[t];
    for (let j = 0; j < n; j++) {
      const i = first + j;
      const o = i * F;
      // The scaled basis, recovered exactly as render/passes/scatter.js does.
      const sxz = Math.hypot(fl[o + 0], fl[o + 4], fl[o + 8]);
      const sy = Math.hypot(fl[o + 1], fl[o + 5], fl[o + 9]);
      const s = Math.cbrt(sxz * sxz * sy);
      const emitScale = u8[i * SCATTER_STRIDE + 51] / 255;
      const b = biomeOut[i];
      const rec = per[b];
      const wx = ox + fl[o + 3], wy = fl[o + 7], wz = oz + fl[o + 11];

      const stemH = m.meshHeight * sy;
      // PRIMARY is the AABB width; `alt` is the rotation-invariant one. See 4c
      // and the header: the AABB form is what the lost script used, so it is the
      // one that makes scatter.js:1498-1503 a usable before-column.
      const foot = (m.meshWidthAabb * sxz) * stemH;
      const footA = (m.meshWidth * sxz) * stemH;
      const fx = m.flux[0] * s * s * emitScale;
      const fy = m.flux[1] * s * s * emitScale;
      const fz = m.flux[2] * s * s * emitScale;

      // The world Y extent of the transformed AABB, exactly. Row 1 of the
      // instance basis is (Bx.y, By.y, Bz.y, absoluteY); the extremes of a
      // linear function over a box are the per-axis better and worse ends.
      const a1 = fl[o + 4], b1 = fl[o + 5], c1 = fl[o + 6];
      const A = m.aabb;
      const dxHi = Math.max(a1 * A[0], a1 * A[3]), dxLo = Math.min(a1 * A[0], a1 * A[3]);
      const dyHi = Math.max(b1 * A[1], b1 * A[4]), dyLo = Math.min(b1 * A[1], b1 * A[4]);
      const dzHi = Math.max(c1 * A[2], c1 * A[5]), dzLo = Math.min(c1 * A[2], c1 * A[5]);
      const topY = wy + dxHi + dyHi + dzHi;
      const worldH = (dxHi + dyHi + dzHi) - (dxLo + dyLo + dzLo);

      rec.count[t] += 1;
      rec.footprint[t] += foot;
      rec.footprintRot[t] += footA;
      rec.fluxLuma[t] += REC709(fx, fy, fz);
      rec.fluxPeak[t] += Math.max(fx, fy, fz);
      rec.stemSum[t] += stemH;
      rec.worldSum[t] += worldH;
      if (-wy < rec.minDepth[t]) rec.minDepth[t] = -wy;
      if (half === 0) { rec.countA[t] += 1; rec.footA[t] += foot; }
      else { rec.countB[t] += 1; rec.footB[t] += foot; }
      if (topY > 0) { rec.breach[t] += 1; instances.breachAll++; }
      if (worldH >= DARK_HEIGHT) {
        rec.tallCount[t] += 1;
        tallPos.push(wx, wz, b);
        if (m.emissive < DARK_EMISSIVE) { rec.darkCount[t] += 1; darkPos.push(wx, wz, b); }
      }
      let hs = rec.heights.get(t);
      if (hs === undefined) { hs = []; rec.heights.set(t, hs); }
      hs.push(worldH);
      instances.total++;
      rec.chunks.add(`${cx},${cz}`);

      for (let k = 0; k < tagRecs.length; k++) {
        const ar = tagRecs[k];
        ar.count[t] += 1;
        ar.footprint[t] += foot;
        ar.byBiome[b] += 1;
        ar.total += 1;
        const an = tagAnchors[k];
        if (an === undefined) continue;
        const d2 = (wx - an.x) * (wx - an.x) + (wz - an.z) * (wz - an.z);
        for (let r = 0; r < NEAR_RADII.length; r++) {
          if (d2 > NEAR_RADII[r] * NEAR_RADII[r]) continue;
          ar.near[r].count[t] += 1;
          ar.near[r].byBiome[b] += 1;
          ar.near[r].total += 1;
        }
      }
    }
  }

  // ---- area and seabed sample points, from the placement loop's own field --
  for (let j = 0; j < areaN; j++) {
    const lz = (j + 0.5) * areaStep;
    for (let i = 0; i < areaN; i++) {
      const lx = (i + 0.5) * areaStep;
      sampleChunkField(cx, cz, lx, lz, fieldOut);
      const b = biomeAt(ox + lx, oz + lz, fieldOut.height, fieldOut.slopeSigned);
      per[b].area += areaCell;
      if (fieldOut.height < 0) per[b].areaSubmerged += areaCell;
      pointX.push(ox + lx); pointZ.push(oz + lz); pointB.push(b);
    }
  }
}
const walkMs = performance.now() - tWalk0;

// ---- 5. the direct expectation ---------------------------------------------
//
// The definition, not a model of it: for every seabed sample point whose whole
// 25 m disc lies inside the chunk sample, count the real instances within 25 m.
// A point near the sample's edge would undercount - its neighbours were never
// generated - so it is excluded and the exclusion is reported.
//
// TWO COUNTS PER POINT, AND THEY ARE NOT THE SAME QUESTION. `any` counts every
// qualifying instance in the disc whatever biome it belongs to, which is what a
// diver standing there actually sees and is the reading item 3.3 is about;
// `own` counts only instances the placement loop attributed to the SAME biome as
// the point. They separate sharply at a boundary - a Sand Plains point 20 m from
// the kelp forest reads 5.88 on `any` and 0.00 on `own` - and a biome whose
// `any` is carried by its neighbour has not been given occluding mass, it is
// standing next to some.
function discCounts(posFlat) {
  const cell = DARK_RADIUS;
  const grid = new Map();
  for (let i = 0; i < posFlat.length; i += 3) {
    const k = `${Math.floor(posFlat[i] / cell)},${Math.floor(posFlat[i + 1] / cell)}`;
    let l = grid.get(k); if (l === undefined) { l = []; grid.set(k, l); } l.push(i);
  }
  const r2 = DARK_RADIUS * DARK_RADIUS;
  const any = BIOMES.map(() => []);
  const own = BIOMES.map(() => []);
  let excluded = 0;
  for (let p = 0; p < pointB.length; p++) {
    const x = pointX[p], z = pointZ[p], pb = pointB[p];
    // Interior test: every chunk the disc can touch must be in the sample, or
    // the point undercounts against neighbours that were never generated.
    let interior = true;
    for (let ddz = -1; ddz <= 1 && interior; ddz++) {
      for (let ddx = -1; ddx <= 1; ddx++) {
        const qx = Math.floor((x + ddx * DARK_RADIUS) / CHUNK);
        const qz = Math.floor((z + ddz * DARK_RADIUS) / CHUNK);
        if (!chunkSet.has(`${qx},${qz}`)) { interior = false; break; }
      }
    }
    if (!interior) { excluded++; continue; }
    let n = 0, nOwn = 0;
    const gx = Math.floor(x / cell), gz = Math.floor(z / cell);
    for (let ddz = -1; ddz <= 1; ddz++) {
      for (let ddx = -1; ddx <= 1; ddx++) {
        const l = grid.get(`${gx + ddx},${gz + ddz}`);
        if (l === undefined) continue;
        for (const i of l) {
          const dx = posFlat[i] - x, dz = posFlat[i + 1] - z;
          if (dx * dx + dz * dz > r2) continue;
          n++;
          if (posFlat[i + 2] === pb) nOwn++;
        }
      }
    }
    any[pb].push(n);
    own[pb].push(nOwn);
  }
  return { counts: any, own, excluded };
}

const tMc0 = performance.now();
const darkDisc = discCounts(darkPos);
const tallDisc = discCounts(tallPos);
const mcMs = performance.now() - tMc0;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const zeroFrac = (a) => (a.length ? a.filter((v) => v === 0).length / a.length : NaN);

// ---- 6. derived ------------------------------------------------------------
const sum = (a) => a.reduce((x, y) => x + y, 0);
const totals = BIOMES.map((_, b) => ({
  count: sum([...per[b].count]),
  footprint: sum([...per[b].footprint]),
  footprintRot: sum([...per[b].footprintRot]),
  fluxLuma: sum([...per[b].fluxLuma]),
  fluxPeak: sum([...per[b].fluxPeak]),
  dark: sum([...per[b].darkCount]),
  tall: sum([...per[b].tallCount]),
  breach: sum([...per[b].breach]),
  fluxPeakNoFluo: sum([...per[b].fluxPeak].map((v, t) => (typeMeta[t].fluoresces ? 0 : v))),
}));

/** Cosine between two per-type vectors. */
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let t = 0; t < a.length; t++) { dot += a[t] * b[t]; na += a[t] * a[t]; nb += b[t] * b[t]; }
  if (na === 0 || nb === 0) return NaN;
  return dot / Math.sqrt(na * nb);
}

/** THE CONTROL COLUMN: how much of a biome's own share vector is signal. */
const selfCosine = BIOMES.map((_, b) => ({
  count: cosine(per[b].countA, per[b].countB),
  footprint: cosine(per[b].footA, per[b].footB),
}));
// THE MEASURED CONTROL IS THE GATE, not the chunk count. A biome with 38 chunks
// and a 0.9999 self-cosine is quoting signal; one with 29 chunks and 0.917 is
// not. The chunk count is printed beside it because it is what a reader can act
// on - widen the ring - but it does not decide anything on its own.
const live = BIOMES.map((_, b) =>
  totals[b].count >= MIN_INSTANCES && selfCosine[b].footprint >= MIN_SELF_COSINE);

function matrix(ids, field) {
  const pairs = [];
  for (const i of ids) for (const j of ids) {
    if (j <= i || !live[i] || !live[j]) continue;
    pairs.push({ a: shortOf[i], b: shortOf[j], c: cosine(per[i][field], per[j][field]) });
  }
  pairs.sort((p, q) => q.c - p.c);
  return {
    pairs,
    mean: pairs.length ? pairs.reduce((s, p) => s + p.c, 0) / pairs.length : NaN,
    worst: pairs[0] ?? null,
  };
}

/** The generator/type map: 42 rows over N generators, and which are shared. */
const generatorOf = typeMeta.map((m) => m.generator);
const generatorNames = [...new Set(generatorOf)].sort();
const generatorIndex = new Map(generatorNames.map((g, i) => [g, i]));
const rowsPerGenerator = new Map();
for (const g of generatorOf) rowsPerGenerator.set(g, (rowsPerGenerator.get(g) ?? 0) + 1);
const sharedGenerators = generatorNames.filter((g) => rowsPerGenerator.get(g) > 1);

const genVec = BIOMES.map((_, b) => {
  const v = new Float64Array(generatorNames.length);
  const w = new Float64Array(generatorNames.length);
  for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
    const gi = generatorIndex.get(generatorOf[t]);
    v[gi] += per[b].count[t];
    w[gi] += per[b].footprint[t];
  }
  return { count: v, footprint: w };
});

function genMatrix(ids, field) {
  const pairs = [];
  for (const i of ids) for (const j of ids) {
    if (j <= i || !live[i] || !live[j]) continue;
    pairs.push({ a: shortOf[i], b: shortOf[j], c: cosine(genVec[i][field], genVec[j][field]) });
  }
  pairs.sort((p, q) => q.c - p.c);
  return {
    pairs,
    mean: pairs.length ? pairs.reduce((s, p) => s + p.c, 0) / pairs.length : NaN,
    worst: pairs[0] ?? null,
  };
}

const genFamilies = BIOMES.map((_, b) =>
  genVec[b].count.reduce((n, v) => n + (v > 0 ? 1 : 0), 0));

/** The areal-density cross-check. Biased UP; see the header. */
const DISC = Math.PI * DARK_RADIUS * DARK_RADIUS;
const darkDensityE = BIOMES.map((_, b) =>
  (per[b].area > 0 ? totals[b].dark / per[b].area * DISC : NaN));

// ---- 7. report -------------------------------------------------------------
const shown = BIOMES.filter((b) => onlyIds === null || onlyIds.has(b.id)).map((b) => b.id);

console.log('\n============================================================');
console.log('SUBWAVE scatter census');
console.log('============================================================');
console.log(`seed                 ${seed} (0x${(seed >>> 0).toString(16)})`);
console.log(`chunk sample         ${sampleMode}${sampleMode === 'lattice' ? '' : `, ring ${ring}`}, ` +
            `${chunks.length} distinct chunks, digest ${sampleDigest}`);
console.log(`lod                  ${lod}   chunk ${CHUNK} m   area grid ${areaStep} m ` +
            `(${(pointB.length).toLocaleString()} seabed points)`);
console.log(`tuning               biomeDensityStrength ${SCATTER_TUNING.biomeDensityStrength}, ` +
            `biomeAppearanceStrength ${SCATTER_TUNING.biomeAppearanceStrength}`);
console.log(`table                ${SCATTER_TYPE_COUNT} types, ${generatorNames.length} generators, ` +
            `${sharedGenerators.length} shared`);
console.log(`delivered            ${instances.total.toLocaleString()} instances, ` +
            `p50 ${pct(chunkInstanceCounts, 0.5).toFixed(0)}/chunk, ` +
            `max ${Math.max(...chunkInstanceCounts)}`);
console.log(`timing               meshes ${meshBuildMs.toFixed(0)} ms, walk ${walkMs.toFixed(0)} ms, ` +
            `disc counts ${mcMs.toFixed(0)} ms`);
console.log(`budgetBound          ${scatterStats.budgetBound}` +
            (scatterStats.budgetBound > 0
              ? '   <-- THE GLOBAL BUDGET DECIDED SOMETHING. Shares below are contaminated.'
              : '   (the global budget decided nothing; shares are the table\'s own)'));
console.log(`widthDefinition      aabb / rotation-invariant ratio p50 ${f(pct(widthSpread, 0.5))}, ` +
            `min ${f(Math.min(...widthSpread))}; footprint uses AABB (see 4c)`);
if (sampleMode !== 'lattice') {
  console.log(`anchors              ${anchorChunks.map((a) => `${a.short}(${a.cx},${a.cz})`).join(' ')}`);
}
if (ONLY_WARNING !== null) console.log(ONLY_WARNING);

console.log('\n== 1. per-biome totals ==');
console.log('  biome        instances  chunks   area km2   footprint m2  flux(peak)   noFluo  flux(luma)  fam');
for (const b of shown) {
  const t = totals[b];
  console.log(`  ${shortOf[b].padEnd(11)} ${String(t.count).padStart(9)} ${String(per[b].chunks.size).padStart(7)} ` +
    `${(per[b].area / 1e6).toFixed(3).padStart(10)} ${t.footprint.toFixed(0).padStart(14)} ` +
    `${t.fluxPeak.toFixed(1).padStart(11)} ${t.fluxPeakNoFluo.toFixed(1).padStart(8)} ` +
    `${t.fluxLuma.toFixed(1).padStart(11)} ${String(genFamilies[b]).padStart(4)}`);
}

console.log('\n== 2. THE DARK-INSTANCE EXPECTATION  (item 3.3, acceptance >= 1.0 in all six deep) ==');
console.log(`  E = the number of instances within ${DARK_RADIUS} m of a random seabed point of that`);
console.log('  biome, counted directly over real positions rather than modelled as a density.');
console.log(`  DARK requires emissive < ${DARK_EMISSIVE}; MASS is the same count with that dropped,`);
console.log('  and the gap between those two columns is the whole of item 3.3\'s problem on this tree.');
console.log('  E counts instances of ANY biome in the disc, which is what a diver sees; E(own) counts');
console.log('  only those the placement loop attributed to the same biome as the point. Where the two');
console.log('  differ the biome is standing NEXT TO occluding mass rather than carrying any.');
console.log(`  ${darkDisc.excluded.toLocaleString()} of ${pointB.length.toLocaleString()} points ` +
            `were within ${DARK_RADIUS} m of the sample edge and are excluded.`);
if (ONLY_WARNING !== null) console.log(ONLY_WARNING);
console.log('  biome        E(dark)  own  P0(dark)   E(mass)  own  P0(mass)  density-E   PASS');
for (const b of shown) {
  const d = darkDisc.counts[b], m = tallDisc.counts[b];
  const e = mean(d);
  console.log(`  ${shortOf[b].padEnd(11)} ${f(e, 4).padStart(8)} ${f(mean(darkDisc.own[b]), 2).padStart(5)} ` +
    `${pc(zeroFrac(d), 1).padStart(9)} ${f(mean(m), 4).padStart(9)} ` +
    `${f(mean(tallDisc.own[b]), 2).padStart(5)} ${pc(zeroFrac(m), 1).padStart(9)} ` +
    `${f(darkDensityE[b], 4).padStart(10)}   ` +
    `${DEEP_SIX.includes(b) ? (e >= 1 ? 'yes' : 'NO ') : '-'}`);
}

// A ZERO HAS TO BE LEGIBLE OR IT IS INDISTINGUISHABLE FROM A BROKEN INSTRUMENT.
console.log('\n   what qualifies, and what nearly does:');
for (const b of shown) {
  const rows = [];
  for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
    if (per[b].count[t] === 0 || typeMeta[t].emissive >= DARK_EMISSIVE) continue;
    rows.push({ t, p95: pct(per[b].heights.get(t) ?? [], 0.95), dark: per[b].darkCount[t] });
  }
  rows.sort((x, y) => y.p95 - x.p95);
  let bestEmit = null;
  for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
    if (per[b].count[t] === 0 || typeMeta[t].emissive < DARK_EMISSIVE) continue;
    const h = per[b].worldSum[t] / per[b].count[t];
    if (bestEmit === null || h > bestEmit.h) bestEmit = { t, h, n: per[b].tallCount[t] };
  }
  const top = rows.slice(0, 3).map((r) =>
    `${typeMeta[r.t].key} p95 ${f(r.p95, 1)} m${r.dark ? ` (${r.dark} qualify)` : ''}`);
  console.log(`  ${shortOf[b].padEnd(11)} dark: ${top.length ? top.join(', ') : 'none at all'}` +
    (bestEmit ? `\n              LIT:  ${typeMeta[bestEmit.t].key} mean ${f(bestEmit.h, 1)} m` +
      `${bestEmit.n ? `, ${bestEmit.n} of them over ${DARK_HEIGHT} m` : ''}` : ''));
}

console.log('\n== 3. WATERLINE BREACH  (item 3.4 regression gate: below 0.5%) ==');
console.log('  the fraction of delivered instances whose transformed AABB reaches above y = 0.');
console.log('  THE GATED NUMBER IS THE SUBMERGED ONE. Volcanic Beach and Island Basalt carry shore');
console.log('  plants and rock that are ABOVE WATER BY DESIGN, and they are 99.7% of every breach in');
console.log('  a full sample - quoting the whole-sample figure against the 0.5% gate reads as a 13x');
console.log('  failure of a gate it is not measuring.');
if (ONLY_WARNING !== null) console.log(ONLY_WARNING);
{
  const LAND = new Set([0, 1]);
  let subT = 0, subB = 0, landT = 0, landB = 0;
  for (let b = 0; b < BIOME_COUNT; b++) {
    for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
      if (LAND.has(b)) { landT += per[b].count[t]; landB += per[b].breach[t]; }
      else { subT += per[b].count[t]; subB += per[b].breach[t]; }
    }
  }
  console.log(`  SUBMERGED biomes    ${pc(subB / Math.max(subT, 1), 4)} ` +
    `(${subB} of ${subT.toLocaleString()})   ${subB / Math.max(subT, 1) < 0.005 ? 'PASS' : 'FAIL'}`);
  console.log(`  land biomes         ${pc(landB / Math.max(landT, 1), 2)} ` +
    `(${landB} of ${landT.toLocaleString()})   not gated - correct behaviour`);
  const worst = [];
  for (const b of shown) {
    for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
      if (per[b].count[t] === 0 || per[b].breach[t] === 0) continue;
      worst.push({ b, t, frac: per[b].breach[t] / per[b].count[t], n: per[b].count[t] });
    }
  }
  worst.sort((x, y) => y.frac - x.frac);
  const list = showFull ? worst : worst.filter((w) => !LAND.has(w.b)).slice(0, 10);
  if (list.length === 0) console.log('  no SUBMERGED type breaches the waterline anywhere in the sample');
  for (const w of list) {
    console.log(`  ${shortOf[w.b].padEnd(11)} ${typeMeta[w.t].key.padEnd(16)} ` +
      `${pc(w.frac, 2).padStart(8)} of ${String(w.n).padStart(6)}`);
  }
  // A 0.00% BREACH IS ONLY EVIDENCE IF THE SAMPLE REACHED THE SHALLOW END OF THE
  // ROW'S OWN DEPTH BAND. The default anchor sample does not: kelpGiant's band
  // opens at 20 m and the ring-3 kelp box holds nothing above 33 m, so its
  // 0.0000% says nothing about the 0.3% its own row records.
  const blind = [];
  for (const b of shown) {
    for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
      if (per[b].count[t] === 0) continue;
      // Only rows whose band opens NEAR THE SURFACE can breach at all, so only
      // those make a 0.00% uninformative. A trench row whose band nominally
      // opens at 40 m is never going to be sampled at 40 m and saying so every
      // run is noise.
      const band = typeMeta[t].depth;
      if (band[0] > 30) continue;
      const reach = per[b].minDepth[t] - band[0];
      if (reach > 8) blind.push({ b, t, reach, min: per[b].minDepth[t], band });
    }
  }
  blind.sort((x, y) => y.reach - x.reach);
  if (blind.length) {
    console.log('  ROWS WHOSE SHALLOW END THIS SAMPLE NEVER REACHED - a 0.00% breach for these is');
    console.log('  a property of the sample, not of the world. Use --sample lattice for the gate.');
    for (const x of blind.slice(0, showFull ? blind.length : 6)) {
      console.log(`    ${typeMeta[x.t].key.padEnd(17)} ${shortOf[x.b].padEnd(12)} ` +
        `band opens ${x.band[0]} m, shallowest sampled ${f(x.min, 1)} m`);
    }
  }
}

console.log('\n== 4. TYPE SHARES  (count / footprint / flux, per biome) ==');
for (const b of shown) {
  const t = totals[b];
  if (t.count === 0) { console.log(`\n  -- ${BIOMES[b].name} (${shortOf[b]}): NO INSTANCES IN THIS SAMPLE`); continue; }
  console.log(`\n  -- ${BIOMES[b].name} (${shortOf[b]}), ${t.count} instances over ` +
    `${per[b].chunks.size} chunks, ${genFamilies[b]} generator families`);
  console.log('     type              gen                   n   count%   foot%   flux%   stem m  world m  sig');
  const rows = [];
  for (let i = 0; i < SCATTER_TYPE_COUNT; i++) {
    if (per[b].count[i] === 0) continue;
    rows.push({
      i, n: per[b].count[i],
      cs: per[b].count[i] / t.count,
      fs: t.footprint > 0 ? per[b].footprint[i] / t.footprint : 0,
      xs: t.fluxPeak > 0 ? per[b].fluxPeak[i] / t.fluxPeak : 0,
      hs: per[b].stemSum[i] / per[b].count[i],
      hw: per[b].worldSum[i] / per[b].count[i],
    });
  }
  rows.sort((x, y) => y.fs - x.fs);
  const list = showFull ? rows : rows.slice(0, topN);
  for (const r of list) {
    const m = typeMeta[r.i];
    console.log(`     ${m.key.padEnd(17)} ${m.generator.replace('generate', '').padEnd(15)} ` +
      `${String(r.n).padStart(6)} ${pc(r.cs).padStart(7)} ${pc(r.fs).padStart(7)} ` +
      `${pc(r.xs).padStart(7)} ${f(r.hs, 2).padStart(8)} ${f(r.hw, 2).padStart(8)}  ` +
      `${m.signatureBiome === b ? 'SIG' : ''}`);
  }
  if (!showFull && rows.length > list.length) {
    console.log(`     ... and ${rows.length - list.length} more rows (--full to see them)`);
  }
}

console.log('\n== 4b. MASK vs DELIVERY - the (type, biome) pairs a weight may be authored on ==');
console.log('  A per-biome cell on a pair the mask ADMITS but the world never DELIVERS is silently');
console.log('  inert, which is this project\'s most repeated bug; a cell on a pair the mask EXCLUDES');
console.log('  THROWS at bakeBiomeWeights (world/scatter.js:1889) and takes the whole scatter system');
console.log('  with it. Those are different failures and only the first one is quiet.');
{
  const admitted = [];
  for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
    for (const b of shown) {
      if ((SCATTER_TYPES[t].biomes & (1 << b)) === 0) continue;
      admitted.push({ t, b, n: per[b].count[t] });
    }
  }
  const empty = admitted.filter((a) => a.n === 0);
  const thin = admitted.filter((a) => a.n > 0 && a.n < 20);
  console.log(`  ${admitted.length} (type, biome) pairs are admitted by a mask in the shown biomes; ` +
    `${admitted.length - empty.length} deliver at least one instance.`);
  if (empty.length) {
    console.log('  MASK ADMITS, SAMPLE DELIVERS ZERO - a weight here is inert:');
    const byType = new Map();
    for (const e of empty) { let l = byType.get(e.t); if (!l) { l = []; byType.set(e.t, l); } l.push(shortOf[e.b]); }
    for (const [t, list] of byType) console.log(`    ${typeMeta[t].key.padEnd(17)} ${list.join(', ')}`);
  }
  if (thin.length) {
    console.log('  DELIVERS FEWER THAN 20 - a weight here moves single figures, not a picture:');
    for (const a of thin) console.log(`    ${typeMeta[a.t].key.padEnd(17)} ${shortOf[a.b].padEnd(12)} ${a.n}`);
  }
  let leaks = 0;
  for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
    for (let b = 0; b < BIOME_COUNT; b++) {
      if (per[b].count[t] > 0 && (SCATTER_TYPES[t].biomes & (1 << b)) === 0) {
        leaks++;
        console.log(`    LEAK ${typeMeta[t].key} delivered ${per[b].count[t]} in ${shortOf[b]}, ` +
          'which its mask does not admit - an instrument fault, not a finding');
      }
    }
  }
  if (leaks === 0) console.log('  no instance is attributed to a biome its type\'s mask excludes (self-check).');
}

console.log('\n== 4c. THE meshWidth DEFINITION IS A FIRST-ORDER LEVER ==');
console.log('  Signature footprint share under both definitions, and the deep-six cosine under both.');
console.log('  AABB is the REPORTED one because it reproduces world/scatter.js:1498-1503; the');
console.log('  rotation-invariant form is the better definition and is printed beside it.');
console.log('  row                biome              aabb   rot-inv    shipped comment');
{
  const SHIPPED = { shelfUrn: 12.61, spireCrown: 42.74, terraceVeil: 83.79, canyonBanner: 63.35, abyssRib: 48.52, trenchWallSpine: 43.62 };
  for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
    const b = typeMeta[t].signatureBiome;
    if (b === undefined || !shown.includes(b) || totals[b].footprint === 0) continue;
    const a = per[b].footprint[t] / totals[b].footprint;          // AABB
    const c = per[b].footprintRot[t] / totals[b].footprintRot;   // rotation-invariant
    const s = SHIPPED[typeMeta[t].key];
    console.log(`  ${typeMeta[t].key.padEnd(18)} ${shortOf[b].padEnd(12)} ${pc(a).padStart(9)} ` +
      `${pc(c).padStart(9)}    ${s === undefined ? '-' : `${s.toFixed(2)}%`}`);
  }
  const alt = BIOMES.map((_, b) => per[b].footprintRot);
  const pairs = [];
  for (const i of DEEP_SIX) for (const j of DEEP_SIX) {
    if (j <= i || !live[i] || !live[j]) continue;
    pairs.push(cosine(alt[i], alt[j]));
  }
  console.log(`  deep-six footprint cosine   aabb ${f(matrix(DEEP_SIX, 'footprint').mean, 4)}   ` +
    `rot-invariant ${f(pairs.length ? pairs.reduce((s, v) => s + v, 0) / pairs.length : NaN, 4)}`);
}

console.log('\n== 5. VOCABULARY COSINE over type mixes ==');
console.log('  count-weighted and footprint-weighted, over rows; then over GENERATOR families.');
console.log('  THE CONTROL COLUMN IS THE SPLIT-HALF SELF-COSINE: the sample\'s even chunks against');
console.log(`  its odd ones, per biome. A biome below ${MIN_SELF_COSINE} is quoting noise and is excluded.`);
if (ONLY_WARNING !== null) console.log(ONLY_WARNING);
console.log('  biome        n inst  chunks  self(count)  self(foot)  quoted');
for (const b of shown) {
  console.log(`  ${shortOf[b].padEnd(11)} ${String(totals[b].count).padStart(7)} ` +
    `${String(per[b].chunks.size).padStart(7)} ${f(selfCosine[b].count, 4).padStart(12)} ` +
    `${f(selfCosine[b].footprint, 4).padStart(11)}  ${live[b] ? 'yes' : 'NO'}`);
}
for (const [label, ids] of [['deep six', DEEP_SIX], ['deep seven', DEEP_SEVEN], ['shallow seven (control)', SHALLOW_SEVEN]]) {
  const inc = ids.filter((i) => live[i]);
  const exc = ids.filter((i) => !live[i]);
  const c = matrix(ids, 'count'), fp = matrix(ids, 'footprint');
  const gc = genMatrix(ids, 'count'), gf = genMatrix(ids, 'footprint');
  console.log(`\n  [${label}] ${inc.map((i) => shortOf[i]).join(' ')}` +
    (exc.length ? `   EXCLUDED ${exc.map((i) => shortOf[i]).join(' ')}` : ''));
  console.log(`    rows count ${f(c.mean, 4)}   rows footprint ${f(fp.mean, 4)}` +
    `   generators count ${f(gc.mean, 4)}   generators footprint ${f(gf.mean, 4)}`);
  if (fp.worst) console.log(`    most alike (footprint, rows)       ${fp.worst.a} x ${fp.worst.b}  ${f(fp.worst.c, 4)}`);
  if (gf.worst) console.log(`    most alike (footprint, generators) ${gf.worst.a} x ${gf.worst.b}  ${f(gf.worst.c, 4)}`);
  if (showFull) for (const p of fp.pairs) console.log(`      ${p.a} x ${p.b}`.padEnd(38) + f(p.c, 4));
}

console.log('\n== 6. GENERATOR / TYPE MAP ==');
console.log(`  ${SCATTER_TYPE_COUNT} rows from ${generatorNames.length} generators; ` +
  `${sharedGenerators.length} generators serve more than one row.`);
for (const g of generatorNames) {
  const rows = typeMeta.filter((m) => m.generator === g).map((m) => m.key);
  if (rows.length < 2 && !showFull) continue;
  console.log(`  ${g.replace('generate', '').padEnd(16)} x${rows.length}  ${rows.join(', ')}`);
}
{
  const sig = typeMeta.filter((m) => m.signatureBiome !== undefined);
  const sigShared = sig.filter((m) => rowsPerGenerator.get(m.generator) > 1);
  console.log(`\n  SIGNATURE ROWS ON A SHARED GENERATOR - ${sigShared.length} of ${sig.length}:`);
  for (const m of sigShared) {
    const siblings = typeMeta.filter((n) => n.generator === m.generator && n.key !== m.key).map((n) => n.key);
    console.log(`    ${m.key.padEnd(17)} ${m.generator.replace('generate', '').padEnd(15)} ` +
      `shares its shape with ${siblings.join(', ')}`);
  }
}

if (perAnchor.size > 0) {
  console.log('\n== 7. ANCHOR NEIGHBOURHOODS - the OTHER scope, at three widths ==');
  console.log(`  box = the ${2 * ring + 1}x${2 * ring + 1} chunk box, ${(2 * ring + 1) * CHUNK} m across.`);
  console.log(`  ${NEAR_RADII[0]} m and ${NEAR_RADII[1]} m = discs about the anchor itself.`);
  console.log('  All three are scoped by POSITION and not by biome, so they say what is around the');
  console.log('  arrival rather than what the biome is made of. The box is far wider than any of');
  console.log('  this water is transparent, and the two readings can disagree completely - which is');
  console.log('  the category error that put "the Kelp Forest is a seagrass meadow" into the plan.');
  for (const a of anchorChunks) {
    const r = perAnchor.get(a.short);
    if (r === undefined || r.total === 0) continue;
    const line = (rec, label) => {
      if (rec.total === 0) return `    ${label.padEnd(7)} nothing placed`;
      const mix = [...rec.byBiome].map((n, b) => ({ b, n })).filter((x) => x.n > 0).sort((x, y) => y.n - x.n);
      const rows = [...rec.count].map((n, t) => ({ t, n })).filter((x) => x.n > 0).sort((x, y) => y.n - x.n).slice(0, 4);
      return `    ${label.padEnd(7)} n ${String(rec.total).padStart(6)}  own ` +
        `${pc((rec.byBiome[a.id] ?? 0) / rec.total, 1).padStart(7)}  ` +
        `${mix.slice(0, 3).map((m) => `${shortOf[m.b]} ${pc(m.n / rec.total, 0)}`).join(' ')}  |  ` +
        rows.map((x) => `${typeMeta[x.t].key} ${pc(x.n / rec.total, 0)}`).join(' ');
    };
    console.log(`\n  ${a.short} anchor (${a.x.toFixed(0)}, ${a.z.toFixed(0)})`);
    console.log(line(r, 'box'));
    for (let i = 0; i < NEAR_RADII.length; i++) console.log(line(r.near[i], `${NEAR_RADII[i]} m`));
  }
}

// ---- 8. the record ---------------------------------------------------------
if (outPath !== null) {
  const record = {
    tool: 'tools/scatter-census.mjs',
    seed,
    sample: {
      mode: sampleMode,
      ring: sampleMode === 'lattice' ? null : ring,
      lod, areaStep,
      only: onlyIds === null ? null : [...onlyIds].map((i) => shortOf[i]),
      chunks: chunks.length, digest: sampleDigest, chunkList: chunks,
      seabedPoints: pointB.length, edgeExcluded: darkDisc.excluded,
    },
    tuning: {
      biomeDensityStrength: SCATTER_TUNING.biomeDensityStrength,
      biomeAppearanceStrength: SCATTER_TUNING.biomeAppearanceStrength,
    },
    definitions: {
      footprint: '(meshWidth * sxz) * (meshHeight * sy); meshWidth = max(aabb x extent, aabb z extent)',
      footprintRot: 'the ALTERNATIVE definition: meshWidth = 2*max hypot(x,z) at unit scale',
      stemHeight: 'meshHeight * sy, along the instance local Y axis',
      worldHeight: 'the Y extent of the transformed AABB; an over-bound of the mesh',
      fluxLuma: 'Rec709 luma of bakeScatterTypeEmit(type).flux * cbrt(sxz^2*sy)^2 * emitScale',
      fluxPeak: 'max channel of the same - the scalar submitLights ranks lights on',
      dark: `emissive < ${DARK_EMISSIVE} and world height >= ${DARK_HEIGHT} m`,
      darkExpectation: `direct count within ${DARK_RADIUS} m of each interior seabed point`,
      darkDensityE: `darkCount / biomeArea * pi * ${DARK_RADIUS}^2, biased UP by disc truncation`,
      breach: 'max world Y over the transformed AABB > 0',
    },
    gates: { MIN_INSTANCES, MIN_CHUNKS, MIN_SELF_COSINE },
    budgetBound: scatterStats.budgetBound,
    instances: instances.total,
    types: typeMeta.map((m, t) => ({
      id: t, key: m.key, generator: m.generator,
      meshHeight: m.meshHeight, meshWidth: m.meshWidth, meshWidthAabb: m.meshWidthAabb,
      emissive: m.emissive, fluoresces: m.fluoresces, signatureBiome: m.signatureBiome ?? null,
      depth: m.depth, fluxLumaAtUnitScale: m.fluxLuma, fluxPeakAtUnitScale: m.fluxPeak,
    })),
    biomes: BIOMES.map((b) => {
      const i = b.id;
      return {
        id: i, short: b.short, name: b.name,
        area: per[i].area, areaSubmerged: per[i].areaSubmerged, chunks: per[i].chunks.size,
        instances: totals[i].count,
        footprint: totals[i].footprint, footprintRot: totals[i].footprintRot,
        fluxLuma: totals[i].fluxLuma, fluxPeak: totals[i].fluxPeak,
        fluxPeakNoFluo: totals[i].fluxPeakNoFluo,
        dark: totals[i].dark, tall: totals[i].tall,
        darkExpectation: mean(darkDisc.counts[i]),
        darkExpectationOwn: mean(darkDisc.own[i]),
        darkP0: zeroFrac(darkDisc.counts[i]),
        massExpectation: mean(tallDisc.counts[i]),
        massExpectationOwn: mean(tallDisc.own[i]),
        massP0: zeroFrac(tallDisc.counts[i]),
        darkDensityE: darkDensityE[i],
        breach: totals[i].breach,
        generatorFamilies: genFamilies[i],
        selfCosine: selfCosine[i],
        quoted: live[i],
        perType: [...per[i].count].map((n, t) => (n === 0 ? null : {
          key: typeMeta[t].key, n,
          footprint: per[i].footprint[t], footprintRot: per[i].footprintRot[t],
          fluxLuma: per[i].fluxLuma[t], fluxPeak: per[i].fluxPeak[t],
          breach: per[i].breach[t],
          meanStemHeight: per[i].stemSum[t] / n,
          meanWorldHeight: per[i].worldSum[t] / n,
          p95WorldHeight: pct(per[i].heights.get(t) ?? [], 0.95),
          shallowestDepth: per[i].minDepth[t],
          dark: per[i].darkCount[t], tall: per[i].tallCount[t],
        })).filter(Boolean),
      };
    }),
    cosines: {
      deepSix: {
        rowsCount: matrix(DEEP_SIX, 'count').mean,
        rowsFootprint: matrix(DEEP_SIX, 'footprint').mean,
        generatorsCount: genMatrix(DEEP_SIX, 'count').mean,
        generatorsFootprint: genMatrix(DEEP_SIX, 'footprint').mean,
        pairsFootprint: matrix(DEEP_SIX, 'footprint').pairs,
        pairsGeneratorFootprint: genMatrix(DEEP_SIX, 'footprint').pairs,
      },
      deepSeven: {
        rowsCount: matrix(DEEP_SEVEN, 'count').mean,
        rowsFootprint: matrix(DEEP_SEVEN, 'footprint').mean,
      },
      shallowSeven: {
        rowsCount: matrix(SHALLOW_SEVEN, 'count').mean,
        rowsFootprint: matrix(SHALLOW_SEVEN, 'footprint').mean,
        pairsFootprint: matrix(SHALLOW_SEVEN, 'footprint').pairs,
      },
    },
    generators: generatorNames.map((g) => ({
      name: g, rows: typeMeta.filter((m) => m.generator === g).map((m) => m.key),
    })),
    anchorNeighbourhoods: anchorChunks.map((a) => {
      const r = perAnchor.get(a.short);
      if (r === undefined) return null;
      const pack = (rec) => ({
        instances: rec.total,
        biomeMix: [...rec.byBiome].map((n, b) => ({ short: shortOf[b], n })).filter((m) => m.n > 0),
        types: [...rec.count].map((n, t) => (n === 0 ? null : { key: typeMeta[t].key, n })).filter(Boolean),
      });
      return {
        short: a.short, x: a.x, z: a.z,
        box: pack(r),
        discs: NEAR_RADII.map((rad, i) => ({ radius: rad, ...pack(r.near[i]) })),
      };
    }).filter(Boolean),
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(record, null, 2));
  console.log(`\nwrote ${outPath}`);
}

console.log('');
