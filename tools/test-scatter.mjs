#!/usr/bin/env node
/**
 * SUBWAVE scatter placement verification.
 *
 * Runs offline with no GPU. What it CANNOT check is whether the picture is right
 * - use tools/shot.mjs with tools/shots/scatter.json for that, and
 * tools/probes/scatter-cost.js for the pass's measured GPU time. What it CAN
 * check is everything the placement contract promises: determinism, that cells
 * nest inside chunks exactly, that no filter is ever violated, that the caps and
 * the budget hold, that a capped type is thinned uniformly rather than truncated
 * in space, and what a chunk actually costs.
 *
 * Every assertion prints the number it measured, not a claim about it.
 */
import { WORLD, RENDER } from '../src/core/constants.js';
import { readFileSync } from 'node:fs';
import * as terrain from '../src/world/terrain.js';
import { biomeAt, biomeWeights, BIOMES, BIOME_COUNT } from '../src/world/biomes.js';
import { hash2, hash3 } from '../src/world/noise.js';
import { resolveBiomeAnchors } from '../src/world/biome_anchors.js';
import { PLACES } from '../src/world/places.js';
import * as meshgen from '../src/world/meshgen.js';
import {
  SCATTER_TYPES, SCATTER_TYPE_COUNT, SCATTER_STRIDE, SCATTER_FLOATS_PER_INSTANCE,
  SCATTER_MAX_PER_CHUNK, SCATTER_MAX_VIEW_DISTANCE, SCATTER_MAX_LOD, SCATTER_FLAG,
  SCATTER_BY_KEY, ORE_TYPES, ORE_MATERIALS, SCATTER_GLOBAL_CAP, SCATTER_TUNING,
  generateScatterForChunk, oreNodesInChunk, scatterLodFor, scatterStats,
  resetScatterStats, invalidateScatterCache, censusTypeByBiome, sampleChunkField,
} from '../src/world/scatter.js';
// The RESIDENCY half of the LOD contract lives in the render pass, not in the
// placement module, and this suite is the only thing that can assert it without
// a GPU. The pass module has no top-level device access, so importing it here is
// free - and section 12 below drives the exact decision rescan() drives.
import { scatterLodTransition } from '../src/render/passes/scatter.js';

let fails = 0;
let skips = 0;
const ok = (cond, label, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label.padEnd(56)} ${detail ?? ''}`);
};
/**
 * A check whose SUBJECT SET IS EMPTY, printed as SKIP with the reason and
 * counted separately. It is deliberately not `ok`: `[].every()` is true and
 * `Math.abs(0 - 0) < 0.05` is true, so an assertion over nothing reports green
 * and reads exactly like an assertion over something. CLAUDE.md records a test
 * that measured a flat line of zeros through `?? 0` and passed; this is the same
 * failure with a different shape. Use it only where the empty set is a legitimate
 * state of the tree, and say in `reason` what would have to exist for the real
 * assertion to run.
 */
const skip = (label, reason) => {
  skips++;
  console.log(`  skip ${label.padEnd(56)} ${reason}`);
};

const CHUNK = WORLD.CHUNK_SIZE;
const F = SCATTER_FLOATS_PER_INSTANCE;

terrain.setSeed(WORLD.DEFAULT_SEED);

/**
 * 200 chunks spread over the whole playfield, chosen on a coprime lattice so the
 * set walks the island, the reef, the shelf break, the abyssal plain and the
 * trench rather than sampling one biome 200 times.
 */
const CHUNKS = [];
for (let i = 0; i < 200; i++) {
  CHUNKS.push([((i * 13) % 47) - 23, ((i * 29) % 47) - 23]);
}

console.log('\n== 1. table integrity ==');
{
  ok(SCATTER_TYPE_COUNT >= 26, 'at least 26 scatter types', `${SCATTER_TYPE_COUNT} types`);
  const keys = new Set(SCATTER_TYPES.map((t) => t.key));
  ok(keys.size === SCATTER_TYPE_COUNT, 'every key is unique', `${keys.size} keys`);
  let idsOk = true;
  for (let i = 0; i < SCATTER_TYPE_COUNT; i++) if (SCATTER_TYPES[i].id !== i) idsOk = false;
  ok(idsOk, 'ids are dense and match table order', '');

  let described = true;
  const missing = [];
  for (const t of SCATTER_TYPES) {
    if (typeof t.generator !== 'string' || typeof meshgen[t.generator] !== 'function') {
      described = false; missing.push(`${t.key}->${t.generator}`);
    }
    if (!Number.isInteger(t.cells) || t.cells < 1) described = false;
    // A place-only row declares density 0 ON PURPOSE: the walk offers it in
    // zero cells and every instance is injected by placePropsForChunk, seeded
    // by the place. The pairing is audited just below - a placeOnly row no
    // place consumes is dead authored data, and a density-0 row without the
    // declaration is still a mistake.
    if (t.placeOnly === true ? t.density !== 0 : !(t.density > 0)) described = false;
    if (!(t.maxPerCell >= 1)) described = false;
    if (!Array.isArray(t.scale) || !Array.isArray(t.depth) || !Array.isArray(t.slope)) described = false;
    if (typeof t.note !== 'string' || t.note.length < 20) described = false;
    if (typeof t.twoSided !== 'boolean') described = false;
    if (!(t.viewDistance > t.fadeStart)) described = false;
  }
  ok(described, 'every type names a real generator and is fully specified',
    missing.length ? missing.join(' ') : `${SCATTER_TYPE_COUNT} rows`);

  // Cells nest by construction: an integer count per chunk edge means chunk N's
  // last cell and chunk N+1's first cell are adjacent with no gap and no overlap.
  let nest = true;
  for (const t of SCATTER_TYPES) {
    if (Math.abs((CHUNK / t.cells) * t.cells - CHUNK) > 0) nest = false;
  }
  ok(nest, 'cell lattices tile the chunk exactly', 'integer cells per edge');

  // PLACE-ONLY ROWS AND PLACE PROPS ARE A CLOSED PAIRING, both directions.
  // A `placeOnly` row (density 0, walk offers nothing) that no place consumes
  // is dead authored data - this project's most repeated bug class - and a
  // place prop naming a key that is not in the table would throw at bake time
  // in a browser nobody is watching; catch it here first.
  {
    const consumed = new Set();
    const badProps = [];
    for (const p of PLACES) {
      for (const prop of p.props ?? []) {
        if (SCATTER_BY_KEY[prop.type] === undefined) badProps.push(`${p.short}->${prop.type}`);
        else consumed.add(prop.type);
        if (!(prop.maxR <= p.radius)) badProps.push(`${p.short}->${prop.type} maxR ${prop.maxR} > radius ${p.radius}`);
      }
    }
    const orphanPlaceOnly = SCATTER_TYPES
      .filter((t) => t.placeOnly === true && !consumed.has(t.key)).map((t) => t.key);
    ok(badProps.length === 0, 'every place prop names a real scatter row inside its radius',
      badProps.length ? badProps.join(' ') : `${consumed.size} keys consumed by ${PLACES.length} places`);
    ok(orphanPlaceOnly.length === 0, 'every placeOnly row is consumed by a place',
      orphanPlaceOnly.length ? orphanPlaceOnly.join(' ') : SCATTER_TYPES.filter((t) => t.placeOnly === true).map((t) => t.key).join(', ') || 'none authored');
  }

  // biomeDensity is a SPARSE map keyed by biome id, and the two ways to author
  // it wrong are both silent: a weight on a biome the type's own mask excludes
  // is dead data (this project's recurring bug class - a field authored,
  // blended and read by nothing), and a weight above 1 would be a DENSITY RAISE
  // the mechanism cannot deliver, because it can only thin. scatter.js throws on
  // both when it bakes the table; this asserts the shipping table never reaches
  // that throw.
  const badWeights = [];
  const weightedRows = [];
  for (const t of SCATTER_TYPES) {
    if (t.biomeDensity === undefined) continue;
    const entries = Object.entries(t.biomeDensity);
    if (entries.length === 0) badWeights.push(`${t.key}: empty map`);
    for (const [k, w] of entries) {
      const id = Number(k);
      if (!Number.isInteger(id) || id < 0 || id >= BIOME_COUNT) badWeights.push(`${t.key}: key ${k}`);
      else if ((t.biomes & (1 << id)) === 0) badWeights.push(`${t.key}: ${BIOMES[id].short} not in its mask`);
      if (!(typeof w === 'number' && w >= 0 && w <= 1)) badWeights.push(`${t.key}[${k}] = ${w}`);
      else weightedRows.push(`${t.key}/${BIOMES[id].short} ${w}`);
    }
  }
  if (weightedRows.length || badWeights.length) {
    ok(badWeights.length === 0, 'every biomeDensity weight is a 0..1 on a biome the type can occupy',
      badWeights.length ? badWeights.join(', ') : weightedRows.join(', '));
  } else {
    // No row authors the field, so "the shipping table never reaches that throw"
    // is true of nothing. Reported as a skip rather than as a pass: see section
    // 5b, and the `biomeDensity` entry in scatter.js's table header for why the
    // three shipped weights were withdrawn.
    skip('every biomeDensity weight is a 0..1 on a biome the type can occupy',
      'no weight is authored - the table cannot reach the bake-time throw');
  }

  // The two per-biome APPEARANCE maps, checked at the table rather than through
  // the bake, so a bad row is named here instead of throwing an import error
  // three suites away. The ceiling is re-derived from the emit path's own
  // expressions - `sh = (0.82 + 0.36 * h1) * shade` at its peak, times the +/-6%
  // warm/cool residual, against the 2.0 the halved unorm8 can carry - rather
  // than trusting the constant in scatter.js, because a comment cannot go red.
  const tintCeil = 2 / ((0.82 + 0.36) * 1.06);
  const badTints = [];
  const tintRows = [];
  for (const t of SCATTER_TYPES) {
    if (t.biomeTint === undefined) continue;
    const entries = Object.entries(t.biomeTint);
    if (entries.length === 0) badTints.push(`${t.key}: empty map`);
    for (const [k, c] of entries) {
      const id = Number(k);
      if (!Number.isInteger(id) || id < 0 || id >= BIOME_COUNT) { badTints.push(`${t.key}: key ${k}`); continue; }
      if ((t.biomes & (1 << id)) === 0) badTints.push(`${t.key}: ${BIOMES[id].short} not in its mask`);
      if (!Array.isArray(c) || c.length !== 3 || !c.every((v) => typeof v === 'number' && v >= 0)) {
        badTints.push(`${t.key}[${k}] is not an RGB triple`); continue;
      }
      const luma = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      if (!(luma > 1e-4)) { badTints.push(`${t.key}[${k}] has no luma`); continue; }
      const peak = Math.max(c[0], c[1], c[2]) / luma;
      if (peak > tintCeil) badTints.push(`${t.key}/${BIOMES[id].short} normalises to ${peak.toFixed(3)} > ${tintCeil.toFixed(3)}`);
      tintRows.push(peak);
    }
  }
  ok(badTints.length === 0,
    'every biomeTint is an RGB triple on an occupied biome, under the clip ceiling',
    badTints.length ? badTints.join(', ')
      : `${tintRows.length} tints, peak normalised channel ${Math.max(0, ...tintRows).toFixed(3)} ` +
        `vs a ceiling of ${tintCeil.toFixed(3)}`);

  const badGlow = [];
  const glowRows = [];
  for (const t of SCATTER_TYPES) {
    if (t.biomeGlow === undefined) continue;
    for (const [k, g] of Object.entries(t.biomeGlow)) {
      const id = Number(k);
      if (!Number.isInteger(id) || id < 0 || id >= BIOME_COUNT) { badGlow.push(`${t.key}: key ${k}`); continue; }
      if ((t.biomes & (1 << id)) === 0) badGlow.push(`${t.key}: ${BIOMES[id].short} not in its mask`);
      // Above 1 the base saturate(0.55 + 0.45*h3) clips its own top and the row
      // delivers LESS variation while reading as brighter; on a type with no
      // emission it is a field nothing can consume.
      if (!(typeof g === 'number' && g > 0 && g <= 1)) badGlow.push(`${t.key}[${k}] = ${g}`);
      else if (t.emissive <= 0) badGlow.push(`${t.key} has emissive 0`);
      else glowRows.push(`${t.key}/${BIOMES[id].short} ${g}`);
    }
  }
  ok(badGlow.length === 0, 'every biomeGlow is a (0, 1] on an emissive type that occupies the biome',
    badGlow.length ? badGlow.join(', ') : glowRows.join(', ') || 'no glow scales authored');

  // The HUE palette is module-private, so this is a source grep - and it earns
  // its ugliness. An authored hue that no row references is the exact bug class
  // this project keeps re-finding (a catalogue field blended and read by
  // nothing), and it is invisible to check.mjs because an unused object property
  // is legal JavaScript. Two entries were already caught this way while item 1.2
  // was being written.
  const src = readFileSync(new URL('../src/world/scatter.js', import.meta.url), 'utf8');
  const hueBlock = src.slice(src.indexOf('const HUE = Object.freeze({'));
  const declared = [...hueBlock.slice(0, hueBlock.indexOf('});'))
    .matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):\s*\[/gm)].map((m) => m[1]);
  const deadHues = declared.filter((h) => !src.includes(`HUE.${h}`));
  ok(declared.length > 0 && deadHues.length === 0,
    'every authored biome hue is referenced by at least one row',
    deadHues.length ? `unused: ${deadHues.join(', ')}` : `${declared.length} hues, all used`);

  const emissiveTypes = SCATTER_TYPES.filter((t) => t.emissive > 0);
  ok(emissiveTypes.length >= 8, 'enough emissive types to light the deep',
    `${emissiveTypes.length}: ${emissiveTypes.map((t) => t.key).join(', ')}`);
  const swayTypes = SCATTER_TYPES.filter((t) => t.sways);
  ok(swayTypes.length >= 6, 'enough types sway with the current',
    `${swayTypes.length}: ${swayTypes.map((t) => t.key).join(', ')}`);
  let swayOk = true;
  for (const t of SCATTER_TYPES) if (t.sways !== (t.swayStrength > 0)) swayOk = false;
  ok(swayOk, 'sways flag and swayStrength agree', '');
  ok(SCATTER_MAX_LOD >= 2, 'something survives to LOD 2 or beyond', `maxLod ${SCATTER_MAX_LOD}`);
  ok(ORE_TYPES.length >= 4, 'several minable ore types',
    `${ORE_TYPES.length}: ${ORE_TYPES.map((t) => t.key).join(', ')}`);
  let oreOk = true;
  for (const t of ORE_TYPES) {
    if (!ORE_MATERIALS[t.ore.materialId]) oreOk = false;
    if (!(t.ore.amount[1] >= t.ore.amount[0])) oreOk = false;
    if (!Number.isInteger(t.oreAppearance)) oreOk = false;
  }
  ok(oreOk, 'every ore type names a real material and appearance', '');

  // A shared catalogue supplies continuity at biome boundaries, but every
  // underwater destination also needs one silhouette that belongs to it alone.
  // `signatureBiome` makes that visual contract inspectable instead of leaving
  // it in prose. Existing ids are never renumbered; signatures append at 31+.
  const signatures = SCATTER_TYPES.filter((t) => Number.isInteger(t.signatureBiome));
  const sigByBiome = new Map();
  const badSignatures = [];
  // Underwater biomes are ids 2..BIOME_COUNT-1 (0 and 1 are the beach and the
  // island). Derived rather than the literal 13 it was, because the count
  // moved once already: THIRTEEN signatures since 2026-08-07, when the 15th
  // biome (Ossuary Flats, id 14) landed with its ossuaryColossus signature -
  // the count below is BIOMES.length - 2 so the next appended biome fails
  // loudly on a MISSING signature instead of on a stale total.
  const lastBiome = BIOMES.length - 1;
  for (const t of signatures) {
    if (t.biomes !== (1 << t.signatureBiome)) badSignatures.push(`${t.key}: shared mask`);
    if (t.signatureBiome < 2 || t.signatureBiome > lastBiome) badSignatures.push(`${t.key}: bad biome`);
    if (sigByBiome.has(t.signatureBiome)) badSignatures.push(`${t.key}: duplicate biome`);
    if (t.importance < 8 || t.viewDistance < 180) badSignatures.push(`${t.key}: not landmark LOD`);
    if (t.colony === null || t.colony.coverage > 0.50) badSignatures.push(`${t.key}: no negative space`);
    sigByBiome.set(t.signatureBiome, t);
  }
  const missingSignatures = [];
  for (let b = 2; b <= lastBiome; b++) if (!sigByBiome.has(b)) missingSignatures.push(BIOMES[b].short);
  ok(signatures.length === BIOMES.length - 2 && missingSignatures.length === 0,
    'every underwater biome has exactly one exclusive signature silhouette',
    missingSignatures.length ? `missing ${missingSignatures.join(', ')}`
      : signatures.map((t) => `${BIOMES[t.signatureBiome].short}:${t.key}`).join(', '));
  ok(badSignatures.length === 0,
    'signature props are sparse clustered landmarks that survive into the distance',
    badSignatures.join(', ') || `${signatures.length} exclusive clustered rows`);

  // The two per-draw shading switches. They are floats in ScatterUniform.extra
  // and the shader trusts them blindly, so a missing field would arrive as NaN
  // and take the whole draw's albedo with it.
  let switchesOk = true;
  const badSwitch = [];
  for (const t of SCATTER_TYPES) {
    if (typeof t.fluoresces !== 'boolean') { switchesOk = false; badSwitch.push(`${t.key}.fluoresces`); }
    if (!(t.algalFilm >= 0 && t.algalFilm <= 1)) { switchesOk = false; badSwitch.push(`${t.key}.algalFilm`); }
    // Fluorescence is EXCITED light. A type that claims it and emits nothing is
    // a switch with nothing behind it.
    if (t.fluoresces && !(t.emissive > 0)) { switchesOk = false; badSwitch.push(`${t.key} fluoresces with emissive 0`); }
  }
  ok(switchesOk, 'every type declares fluoresces and a 0..1 algalFilm',
    badSwitch.length ? badSwitch.join(' ') : `${SCATTER_TYPE_COUNT} rows`);

  // Fluorescence is pumped by the blue daylight that survives to the instance's
  // own depth, so a type that lives below the photic zone would declare a light
  // source that is always off. 260 m is coralFan's floor and the deepest any of
  // them reach.
  const tooDeep = SCATTER_TYPES.filter((t) => t.fluoresces && t.depth[1] > 300);
  ok(tooDeep.length === 0, 'nothing fluoresces below the blue that has to pump it',
    tooDeep.length ? tooDeep.map((t) => `${t.key} to ${t.depth[1]} m`).join(', ')
      : `${SCATTER_TYPES.filter((t) => t.fluoresces).length} fluorescent types, all above 300 m`);

  // Algal turf grows on bare mineral. A type whose mesh never reaches
  // mineralSurface can say either, but a LIVING type that does reach it and
  // still asks for the film gets 70% of its albedo replaced by (0.038, 0.058,
  // 0.030) on every upward face - which is what happened to brain coral.
  const livingCorals = SCATTER_TYPES.filter((t) =>
    t.generator.startsWith('generateCoral') && t.key !== 'tubeworm');
  const filmedCoral = livingCorals.filter((t) => t.algalFilm > 0);
  ok(filmedCoral.length === 0, 'no living coral grows algal turf on itself',
    filmedCoral.length ? filmedCoral.map((t) => t.key).join(', ')
      : `${livingCorals.length} coral types clean`);

  // Four fluorescent families must not collapse back onto one shared pale-pink
  // response. Mirror fluorescentReflectance() and prove two independent things:
  // the palette is chromatically separated, and every row is still levelled to
  // its pre-split material luminance (so this cannot become a hidden exposure
  // change). The image-level proof lives in probes/shallow-chroma.js.
  const shader = readFileSync(
    new URL('../src/render/shaders/pass/scatter.wgsl', import.meta.url), 'utf8');
  const response = {
    coralBranching: [1.00, 0.20, 0.02],
    coralBrain: [0.12, 1.00, 0.08],
    coralFan: [0.55, 1.00, 0.02],
    coralTube: [0.03, 1.00, 0.62],
    reefPillar: [1.00, 0.70, 0.03],
    coralCrown: [1.00, 0.08, 0.20],
  };
  // THE MIRROR MUST BIND THE SHADER, not merely describe it: without this
  // grep, reverting a case in fluorescentReflectance() left every check
  // below green because the arithmetic ran on this table alone (the
  // transcription-drift trap the census extraction exists to prevent). Each
  // triple must appear verbatim in the WGSL switch.
  // The shader writes two decimals, three where two would lose precision
  // (0.025, 0.035): format as toFixed(3) with one trailing zero stripped.
  const wgslNum = (v) => v.toFixed(3).replace(/0$/, '');
  for (const [key, t] of Object.entries(response)) {
    const lit = `vec3f(${t.map(wgslNum).join(', ')})`;
    ok(shader.includes(lit),
      `fluorescentReflectance carries ${key}'s mirrored triple`, lit);
  }
  const palette = {
    coralBranching: meshgen.MESH_PALETTE.CORAL_PINK,
    coralBrain: meshgen.MESH_PALETTE.CORAL_CREAM,
    coralFan: meshgen.MESH_PALETTE.CORAL_ORANGE,
    coralTube: meshgen.MESH_PALETTE.CORAL_VIOLET,
    reefPillar: meshgen.MESH_PALETTE.CORAL_CREAM,
    coralCrown: meshgen.MESH_PALETTE.CORAL_PINK,
  };
  const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const delivered = {};
  for (const key of Object.keys(response)) {
    const gain = SCATTER_BY_KEY[key].colorMul[0];
    delivered[key] = [0, 1, 2].map((i) => palette[key][i] * response[key][i] * gain);
  }
  const levels = Object.fromEntries(Object.entries(delivered).map(([k, c]) => [k, luma(c)]));
  ok(Math.abs(levels.coralBranching - 0.1061) < 0.001
    && Math.abs(levels.coralBrain - 0.0920) < 0.001
    && Math.abs(levels.coralFan - 0.1061) < 0.001
    && Math.abs(levels.coralTube - 0.1061) < 0.001
    && Math.abs(levels.reefPillar - 0.1061) < 0.001
    && Math.abs(levels.coralCrown - 0.1061) < 0.001,
  'coral and signature pigment splits are luminance-neutral',
  Object.entries(levels).map(([k, v]) => `${k.replace('coral', '')} ${v.toFixed(4)}`).join(', '));
  // P3 shallow colour pass: salmon (r-dominant), GFP green, gold (r > g >> b,
  // but NOT the old 12x red dominance - gold keeps its green lobe because
  // green is what survives the sight path), teal (g = b, no red), and an
  // amber-gold reef pillar (r > g, not the old salmon that made the reef's
  // signature the same family as branching).
  ok(delivered.coralBranching[0] > delivered.coralBranching[1] * 6
    && delivered.coralBrain[1] > Math.max(delivered.coralBrain[0], delivered.coralBrain[2]) * 6
    && delivered.coralFan[0] > delivered.coralFan[1] * 1.4
    && delivered.coralFan[0] < delivered.coralFan[1] * 4
    && delivered.coralFan[1] > delivered.coralFan[2] * 20
    && delivered.coralTube[1] > delivered.coralTube[0] * 10
    && delivered.coralTube[2] > delivered.coralTube[0] * 10
    && delivered.coralTube[1] > delivered.coralTube[2] * 0.75
    && delivered.coralTube[1] < delivered.coralTube[2] * 1.35
    && delivered.reefPillar[0] > delivered.reefPillar[1]
    && delivered.reefPillar[0] < delivered.reefPillar[1] * 3
    && delivered.reefPillar[1] > delivered.reefPillar[2] * 20
    && delivered.coralCrown[0] > delivered.coralCrown[2] * 8,
  'coral families retain salmon, green, gold, and teal signatures',
  Object.entries(delivered).map(([k, c]) =>
    `${k.replace('coral', '')} ${c.map((v) => v.toFixed(3)).join('/')}`).join(', '));
  ok(['case 7u:', 'case 8u:', 'case 9u:', 'case 10u:', 'case 31u:', 'case 32u:']
    .every((s) => shader.includes(s))
    && shader.includes('let pigment = fluorescentReflectance'),
  'scatter shader consumes all six family responses', 'type ids 7-10, 31-32');

  // The Crimson Meadow pair (ids 56/57) rides the same pigment mechanism and
  // the same binding rule: mirror the triples, grep them verbatim (the
  // transcription-drift trap again), and prove the VIBRANCY RULE - red comes
  // from cutting G/B, never from raising any channel above 1.0, because a
  // brighter object is a whiter one. They are deliberately NOT in the coral
  // luma-levelling set above: that 0.106 baseline is the reef families'
  // measured calibration, and these two rows are levelled by their own
  // MESH_PALETTE bytes at colorMul 1.
  const meadowResponse = {
    bloodgrass: [1.00, 0.28, 0.02],
    crimsonPlume: [0.92, 0.10, 0.70],
  };
  for (const [key, t] of Object.entries(meadowResponse)) {
    const lit = `vec3f(${t.map(wgslNum).join(', ')})`;
    ok(shader.includes(lit),
      `fluorescentReflectance carries ${key}'s mirrored triple`, lit);
    ok(Math.max(...t) <= 1.0,
      `${key}'s pigment cuts channels and raises none above 1.0`,
      t.map((v) => v.toFixed(2)).join('/'));
  }
  // R > G*3, not the original G*8: the 2026-08-18 pass warmed the authored
  // green to 0.28R (the delivered pixel adds untinted blue, and authored
  // green is the only channel that can pull the sum back onto true red - see
  // MESH_PALETTE.BLOOD_GRASS) and this line was not moved with it. Warm-red
  // dominance is the claim; 3.6x R/G still separates it from the plume.
  ok(meadowResponse.bloodgrass[0] > meadowResponse.bloodgrass[1] * 3
    && meadowResponse.bloodgrass[0] > meadowResponse.bloodgrass[2] * 8
    && meadowResponse.crimsonPlume[0] > meadowResponse.crimsonPlume[1] * 8
    && meadowResponse.crimsonPlume[2] > meadowResponse.crimsonPlume[1] * 5
    && meadowResponse.crimsonPlume[2] < meadowResponse.crimsonPlume[0],
  'meadow pigments separate: crimson (R-dominant) vs magenta (R > B >> G)',
  Object.entries(meadowResponse).map(([k, c]) =>
    `${k} ${c.map((v) => v.toFixed(2)).join('/')}`).join(', '));
  ok(['case 56u:', 'case 57u:'].every((s) => shader.includes(s)),
    'scatter shader consumes both meadow responses', 'type ids 56-57');
}

console.log('\n== 2. instance layout ==');
{
  ok(SCATTER_STRIDE === 64, 'instance stride is 64 bytes', `${SCATTER_STRIDE} B`);
  ok(F === 16, 'sixteen floats per instance', `${F}`);
  const r = generateScatterForChunk(0, 1, 0);
  ok(r.instances instanceof Float32Array, 'instances come back as a Float32Array', '');
  ok(r.instances.length === r.count * F, 'array length matches the count',
    `${r.instances.length} floats for ${r.count} instances`);
  ok(r.instances.byteOffset === 0 && r.instances.buffer.byteLength === r.count * SCATTER_STRIDE,
    'the buffer is an exact-size copy, safe to upload directly',
    `${r.instances.buffer.byteLength} B`);
  ok(r.countsByType.length === SCATTER_TYPE_COUNT && r.firstByType.length === SCATTER_TYPE_COUNT,
    'countsByType and firstByType cover every type', '');
}

console.log('\n== 3. determinism ==');
{
  const snapshot = (cx, cz) => {
    const r = generateScatterForChunk(cx, cz, 0);
    return { count: r.count, bytes: Buffer.from(r.instances.buffer.slice(0)).toString('base64') };
  };
  const a = [snapshot(0, 1), snapshot(-4, 7), snapshot(11, -9)];
  // Churn every piece of derived state the module could be caching.
  invalidateScatterCache();
  terrain.setSeed(0x11112222);
  generateScatterForChunk(3, 3, 0);
  oreNodesInChunk(-2, 5);
  terrain.setSeed(WORLD.DEFAULT_SEED);
  invalidateScatterCache();
  const b = [snapshot(0, 1), snapshot(-4, 7), snapshot(11, -9)];

  let identical = true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].count !== b[i].count || a[i].bytes !== b[i].bytes) identical = false;
  }
  ok(identical, 'bit-identical after a seed round trip',
    `${a.map((s) => s.count).join('/')} instances`);

  // Order independence: generating a chunk cold must equal generating it after
  // its neighbours, or a streaming order change would reshuffle the world.
  invalidateScatterCache();
  const cold = snapshot(5, -3);
  generateScatterForChunk(4, -3, 0);
  generateScatterForChunk(6, -3, 0);
  generateScatterForChunk(5, -2, 0);
  const warm = snapshot(5, -3);
  ok(cold.bytes === warm.bytes, 'a chunk is independent of its neighbours',
    `${cold.count} instances both ways`);

  // A different seed must actually produce a different world.
  terrain.setSeed(0x0badc0de);
  invalidateScatterCache();
  const other = snapshot(0, 1);
  terrain.setSeed(WORLD.DEFAULT_SEED);
  invalidateScatterCache();
  ok(other.bytes !== a[0].bytes, 'a different world seed moves the scatter',
    `${a[0].count} vs ${other.count} instances`);
}

console.log('\n== 4. filters are never violated (200 chunks) ==');
{
  const worst = { depth: null, slope: null, outside: null, scale: null };
  let checked = 0;
  let slopeExcessSum = 0, slopeExcessCount = 0, slopeExcessMax = 0;
  /**
   * The field grid is built on terrain.sampleHeightFast, which by design omits
   * the dune, talus and micro layers - about 2 m of amplitude at a 9 m
   * wavelength, i.e. up to ~0.45 of local gradient that the grid CANNOT see and
   * terrain.sampleSlope() CAN. So the filter can never be exact against a full
   * point sample; what it must not do is fail systematically, which is why the
   * mean excess is asserted as well as the maximum.
   */
  const SLOPE_TOLERANCE = 0.6;
  for (const [cx, cz] of CHUNKS) {
    const r = generateScatterForChunk(cx, cz, 0);
    for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
      const n = r.countsByType[t];
      if (n === 0) continue;
      const type = SCATTER_TYPES[t];
      for (let i = r.firstByType[t]; i < r.firstByType[t] + n; i++) {
        const o = i * F;
        const lx = r.instances[o + 3], y = r.instances[o + 7], lz = r.instances[o + 11];
        checked++;
        if (lx < 0 || lx >= CHUNK || lz < 0 || lz >= CHUNK) {
          worst.outside = `${type.key} local (${lx.toFixed(2)}, ${lz.toFixed(2)})`;
        }
        const ax = cx * CHUNK + lx, az = cz * CHUNK + lz;
        const depth = -terrain.sampleHeight(ax, az);
        // The instance origin is sunk below the ground, so allow for that.
        const margin = 1.5 + type.sink * type.scale[1] * type.stretch[1];
        if (depth < type.depth[0] - margin || depth > type.depth[1] + margin) {
          worst.depth = `${type.key} depth ${depth.toFixed(1)} outside [${type.depth}]`;
        }
        const slope = terrain.sampleSlope(ax, az);
        const excess = slope - type.slope[1];
        if (excess > 0) {
          slopeExcessSum += excess;
          slopeExcessCount++;
          slopeExcessMax = Math.max(slopeExcessMax, excess);
        }
        if (excess > SLOPE_TOLERANCE) {
          worst.slope = `${type.key} slope ${slope.toFixed(2)} > ${type.slope[1]} + ${SLOPE_TOLERANCE}`;
        }
        const sxz = Math.hypot(r.instances[o], r.instances[o + 4], r.instances[o + 8]);
        if (sxz < type.scale[0] * 0.98 || sxz > type.scale[1] * 1.02) {
          worst.scale = `${type.key} basis length ${sxz.toFixed(3)} outside [${type.scale}]`;
        }
        // Height must be at or below the ground, never floating above it.
        if (y > -depth + 0.05) {
          worst.depth = worst.depth || `${type.key} floats ${(y + depth).toFixed(2)} m above ground`;
        }
      }
    }
  }
  ok(worst.outside === null, 'every instance lands inside its own chunk',
    worst.outside ?? `${checked.toLocaleString()} instances checked`);
  ok(worst.depth === null, 'every instance is inside its depth window and on the ground',
    worst.depth ?? 'no violation');
  ok(worst.slope === null,
    `no instance exceeds its slope limit by more than ${SLOPE_TOLERANCE}`,
    worst.slope ?? `${slopeExcessCount} of ${checked} over the limit at all, worst by ${slopeExcessMax.toFixed(3)}`);
  const meanExcess = slopeExcessCount > 0 ? slopeExcessSum / checked : 0;
  ok(meanExcess < 0.02, 'the slope filter does not fail systematically',
    `mean excess over ALL instances ${meanExcess.toFixed(4)}, ` +
    `${(slopeExcessCount / checked * 100).toFixed(2)}% over the limit at all`);
  ok(worst.scale === null, 'the basis length is the scale the table asked for',
    worst.scale ?? 'no violation');
}

console.log('\n== 5. biome filter ==');
{
  // The placement filter reads the biome off an 8 m lattice whose slope comes
  // from the field grid; a point-sample with terrain.sampleSlope() can classify
  // a boundary point as the OTHER side. So the claim under test is not "the
  // point-sampled biome is in the mask" - that would be testing the lattice
  // pitch, not the filter - it is that the type's mask has REAL WEIGHT here.
  // biomes.js blends two or three biomes at every boundary, so a non-zero weight
  // means the substrate genuinely is partly what the type asked for.
  const weights = new Float64Array(BIOMES.length);
  let hard = 0, soft = 0, checked = 0;
  const checkedTypes = new Set();
  let example = null;
  for (const [cx, cz] of CHUNKS.slice(0, 60)) {
    const r = generateScatterForChunk(cx, cz, 0);
    for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
      const n = r.countsByType[t];
      if (n === 0) continue;
      checkedTypes.add(t);
      const type = SCATTER_TYPES[t];
      // Sample the middle instance of the run: the biome query is the expensive
      // one, and a systematic bug shows on any sample.
      const o = (r.firstByType[t] + (n >> 1)) * F;
      const ax = cx * CHUNK + r.instances[o + 3];
      const az = cz * CHUNK + r.instances[o + 11];
      const h = terrain.sampleHeight(ax, az);
      const slope = terrain.sampleSlope(ax, az);
      checked++;
      const dominant = biomeAt(ax, az, h, slope);
      if ((type.biomes & (1 << dominant)) !== 0) continue;
      soft++;
      biomeWeights(weights, ax, az, h, slope);
      let anyWeight = 0;
      for (let b = 0; b < BIOMES.length; b++) {
        if ((type.biomes & (1 << b)) !== 0) anyWeight = Math.max(anyWeight, weights[b]);
      }
      if (anyWeight < 0.02) {
        hard++;
        if (!example) example = `${type.key} in ${BIOMES[dominant].name}, best mask weight ${anyWeight.toFixed(3)}`;
      }
    }
  }
  // The residual is the field grid's SLOPE, and the attribution is measured in
  // scatter.js's sampleField(): the exact height recovers 0.19% of the
  // disagreement and the exact slope recovers 23.19%, because biomes.js scores
  // slope with feathers 0.16-0.30 wide and a 4 m bilinear patch cannot resolve
  // the sub-4 m relief that moves a gradient that far. Removing it costs a real
  // terrain.sampleSlope per candidate - several times the whole chunk budget.
  //
  // So these bounds are REGRESSION GUARDS on a measured, accepted approximation,
  // not a claim of exactness. If a change pushes them up, the change is wrong.
  ok(hard / checked < 0.07, 'few instances sit in a biome their mask has no weight in',
    `${hard} of ${checked} runs (${(hard / checked * 100).toFixed(2)}%)` +
    (example ? ` - e.g. ${example}` : ''));
  ok(soft / checked < 0.20, 'boundary disagreement stays a minority',
    `${soft} of ${checked} (${(soft / checked * 100).toFixed(1)}%) differ from a point sample`);
  ok(checkedTypes.size >= 24, 'nearly every type appears somewhere in the world',
    `${checkedTypes.size} of ${SCATTER_TYPE_COUNT} types placed`);
}

console.log('\n== 5a. curated arrivals contain their biome signature ==');
{
  // Existence somewhere in a 4 km world is not presentation. The jump menu is
  // the demo route, so its arrival must put the exclusive form within a 100 m
  // discovery circle. This is intentionally radial rather than a frustum test:
  // anchors own camera composition, while scatter owns whether the landmark is
  // present close enough for that composition to find at all.
  const anchors = resolveBiomeAnchors(terrain);
  const chunkCache = new Map();
  const getChunk = (cx, cz) => {
    const key = `${cx},${cz}`;
    let r = chunkCache.get(key);
    if (!r) { r = generateScatterForChunk(cx, cz, 0); chunkCache.set(key, r); }
    return r;
  };
  const R = 100;
  const report = [];
  const missing = [];
  for (let b = 2; b < BIOMES.length; b++) {
    const a = anchors[b];
    const type = SCATTER_TYPES.find((t) => t.signatureBiome === b);
    let count = 0, nearest = Infinity;
    for (let cz = Math.floor((a.z - R) / CHUNK); cz <= Math.floor((a.z + R) / CHUNK); cz++) {
      for (let cx = Math.floor((a.x - R) / CHUNK); cx <= Math.floor((a.x + R) / CHUNK); cx++) {
        const r = getChunk(cx, cz);
        const end = r.firstByType[type.id] + r.countsByType[type.id];
        for (let i = r.firstByType[type.id]; i < end; i++) {
          const o = i * F;
          const x = cx * CHUNK + r.instances[o + 3];
          const z = cz * CHUNK + r.instances[o + 11];
          const d = Math.hypot(x - a.x, z - a.z);
          if (d > R) continue;
          count++;
          nearest = Math.min(nearest, d);
        }
      }
    }
    if (count === 0) missing.push(`${a.short}:${type.key}`);
    report.push(`${a.short} ${count}@${Number.isFinite(nearest) ? nearest.toFixed(0) : '-'}m`);
  }
  ok(missing.length === 0, 'every underwater jump has its exclusive landmark within 100 m',
    missing.length ? `missing ${missing.join(', ')}` : report.join(', '));
}

console.log('\n== 5b. per-biome density weights ==');
{
  // THE MECHANISM, NOT THE CONTENT. A weight turns the biome mask's one accept/
  // reject bit into a real number, which is what makes the biome brief's binding
  // Avoid column enforceable. Three things have to be true of it and none of
  // them is visible in a screenshot.
  //
  // NO WEIGHT IS AUTHORED TODAY. Three shipped and were withdrawn because they
  // made the delivered frames poorer - Boulder Field hue entropy 0.172 -> 0.105
  // bits, Sand Plains 0.118 -> 0.072 - and the reason is written up at the
  // `biomeDensity` entry in src/world/scatter.js's table header. The (b) ratio
  // assertions below therefore have an empty subject set and SKIP; (a) and (c)
  // still run and still measure real numbers.
  const WITHDRAWN = 'no biomeDensity weight is authored (three were withdrawn - see '
    + 'scatter.js table header); nothing to measure a ratio against';

  // (a) INERT WHERE UNAUTHORED. SCATTER_TUNING.biomeDensityStrength = 0 blends
  // every weight back to 1 and is the reference arm. Anything that moves between
  // the two arms and is NOT an authored row is a leak - and the specific leak to
  // fear is the per-chunk budget, because typeCap is min(maxPerChunk, budget -
  // count) over a most-important-first emission order, so thinning an early type
  // would raise a later type's headroom and move ITS survivors.
  const weighted = new Set(SCATTER_TYPES.filter((t) => t.biomeDensity !== undefined).map((t) => t.id));
  const moved = new Set();
  let identicalRuns = 0;
  const sample = CHUNKS.slice(0, 60);
  for (const [cx, cz] of sample) {
    SCATTER_TUNING.biomeDensityStrength = 0;
    const a = generateScatterForChunk(cx, cz, 0);
    SCATTER_TUNING.biomeDensityStrength = 1;
    const b = generateScatterForChunk(cx, cz, 0);
    const ab = new Uint8Array(a.instances.buffer);
    const bb = new Uint8Array(b.instances.buffer);
    for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
      const na = a.countsByType[t], nb = b.countsByType[t];
      let same = na === nb;
      if (same && na > 0) {
        const oa = a.firstByType[t] * SCATTER_STRIDE, obb = b.firstByType[t] * SCATTER_STRIDE;
        for (let i = 0; i < na * SCATTER_STRIDE; i++) {
          if (ab[oa + i] !== bb[obb + i]) { same = false; break; }
        }
      }
      if (same) identicalRuns++; else moved.add(t);
    }
  }
  const leaks = [...moved].filter((t) => !weighted.has(t));
  // WITH NOTHING AUTHORED THIS IS THE INERT-PATH ASSERTION, and it is a real one:
  // `weighted` is empty, so `leaks` is every type that moved at all, and the
  // check becomes "the whole table is byte-identical between the two arms". That
  // is exactly the acceptance condition for a withdrawn weight set. Everything
  // below it, however, is an assertion ABOUT AUTHORED WEIGHTS, and with none
  // authored those degrade to statements about the empty set - so they skip
  // loudly rather than reporting a green they did not earn.
  ok(leaks.length === 0,
    weighted.size ? 'an unweighted type is byte-identical with the weights on'
      : 'NO type moves: the mechanism is fully inert unauthored',
    leaks.length ? `moved: ${leaks.map((t) => SCATTER_TYPES[t].key).join(', ')}`
      : `${identicalRuns} identical type-runs over ${sample.length} chunks`);
  if (weighted.size) {
    ok([...weighted].every((t) => moved.has(t)), 'every weighted type actually moves',
      `${[...moved].map((t) => SCATTER_TYPES[t].key).join(', ')}`);
  } else {
    skip('every weighted type actually moves', WITHDRAWN);
  }

  // (b) THE WEIGHT IS THE DELIVERED RATIO. Measured through
  // censusTypeByBiome, which buckets by the biome the PLACEMENT LOOP resolved:
  // re-classifying finished instances with terrain.sampleSlope disagrees with
  // the field grid on 15-20% of boundary candidates (section 5), which is larger
  // than the 5% the ratio is being held to.
  const census = new Uint32Array(BIOME_COUNT);
  const worst = { err: 0, label: 'nothing weighted' };
  const rows = [];
  let thinCorrect = true;
  // The 200-chunk lattice walks the whole playfield, so a biome that holds a
  // small share of the seabed contributes few instances and the ratio becomes a
  // lottery read: over the lattice alone, pebbleField in Twilight Terraces has
  // n = 719, whose 1 sigma is 5.70% against a 5% gate. Adding a box around the
  // weighted biome's own anchor is what makes the estimate tighter than the
  // thing it is asserting.
  //
  // AND THE BOX IS UNIONED OVER EVERY BIOME THE ROW WEIGHTS, NOT JUST THE FIRST.
  // This took `Object.keys(map)[0]`, which is correct only while every weighted
  // row names exactly one biome - true of all three shipped rows, and false the
  // moment a row weights several (the plan's mushroomCap cut spans six). The
  // biomes that were not key[0] would have fallen back to the lattice alone,
  // which is the 5.70%-against-a-5%-gate lottery read this box exists to
  // prevent, and it would have failed SILENTLY: a ratio inside the gate by luck
  // reports ok. Each row now prints its own n and 1 sigma so a reader can see
  // which estimates are actually tight.
  const censusAnchors = resolveBiomeAnchors(terrain);
  const censusChunks = (biomes) => {
    const set = new Map(CHUNKS.map(([x, z]) => [`${x},${z}`, [x, z]]));
    for (const biome of biomes) {
      const a = censusAnchors[biome];
      const ax = Math.round(a.x / CHUNK), az = Math.round(a.z / CHUNK);
      for (let dz = -10; dz <= 10; dz++) {
        for (let dx = -10; dx <= 10; dx++) set.set(`${ax + dx},${az + dz}`, [ax + dx, az + dz]);
      }
    }
    return [...set.values()];
  };

  // The union is asserted directly, because every shipped row weights exactly
  // one biome and so exercises only the single-key path - the multi-biome path
  // would otherwise ship untested and be discovered by a future row silently
  // losing its box. Set arithmetic only: no chunk is generated here.
  {
    const key = ([x, z]) => `${x},${z}`;
    const one = new Set(censusChunks([6]).map(key));
    const two = new Set(censusChunks([9]).map(key));
    const both = new Set(censusChunks([6, 9]).map(key));
    const covers = [...one, ...two].every((k) => both.has(k));
    const noExtra = [...both].every((k) => one.has(k) || two.has(k));
    ok(covers && noExtra && both.size > one.size,
      'the census box is the UNION over every weighted biome',
      `boulders ${one.size} + terrace ${two.size} -> ${both.size} chunks`);
  }

  for (const type of SCATTER_TYPES) {
    if (type.biomeDensity === undefined) continue;
    const sweep = censusChunks(Object.keys(type.biomeDensity).map(Number));
    const base = new Float64Array(BIOME_COUNT);
    const wtd = new Float64Array(BIOME_COUNT);
    for (const strength of [0, 1]) {
      SCATTER_TUNING.biomeDensityStrength = strength;
      const acc = strength === 0 ? base : wtd;
      for (const [cx, cz] of sweep) {
        censusTypeByBiome(type.id, cx, cz, census);
        for (let b = 0; b < BIOME_COUNT; b++) acc[b] += census[b];
      }
    }
    for (let b = 0; b < BIOME_COUNT; b++) {
      if (base[b] === 0) { if (wtd[b] !== 0) thinCorrect = false; continue; }
      const w = type.biomeDensity[b] ?? 1;
      const ratio = wtd[b] / base[b];
      // Bernoulli thinning, so the ratio is an estimate: 1 sigma is
      // sqrt((1-w)/(n*w)). Reported so a near-miss can be read as sampling
      // rather than as a broken weight.
      const sigma = w < 1 ? Math.sqrt((1 - w) / (base[b] * w)) : 0;
      const err = Math.abs(ratio - w) / w;
      if (err > worst.err) {
        worst.err = err;
        worst.label = `${type.key}/${BIOMES[b].short} ${base[b]} -> ${wtd[b]}, ` +
          `ratio ${ratio.toFixed(4)} vs ${w.toFixed(2)} (1 sigma ${(sigma * 100).toFixed(2)}%)`;
      }
      if (w === 1 && ratio !== 1) thinCorrect = false;
      // n and 1 sigma next to every ratio, not just next to the worst one: a
      // weighted row whose n is small is a lottery read whether or not it
      // happens to be the worst offender this run.
      rows.push(`${type.key}/${BIOMES[b].short} ${ratio.toFixed(3)}`
        + ` (n ${base[b]}, 1 sigma ${(sigma * 100).toFixed(2)}%)`);
    }
  }
  if (rows.length) {
    ok(worst.err < 0.05, 'every weighted count lands within 5% of oldCount x weight',
      `worst ${(worst.err * 100).toFixed(2)}% - ${worst.label}`);
    ok(thinCorrect, 'a weighted type is untouched in the biomes it does not weight',
      rows.join(', '));
  } else {
    // `worst.err` is 0 and `thinCorrect` is true over an empty loop, so both of
    // these would have printed ok on a table with nothing in it. That is the
    // silent pass this branch exists to refuse.
    skip('every weighted count lands within 5% of oldCount x weight', WITHDRAWN);
    skip('a weighted type is untouched in the biomes it does not weight', WITHDRAWN);
  }

  // (c) THE CAP-THINNING HASH HAS NO ONE-CELL ALIAS ALONG X. The shipped
  // expression was hash2(cellX * 3 + s, cellZ, salt): 3*cellX + s collides
  // whenever 3*dcellX = ds, so with maxPerCell up to 8 sub-instance 0 of cell N
  // and sub-instance 3 of cell N-1 drew the same number and took the same
  // keep/drop decision - a one-cell-period correlation with nothing along Z to
  // balance it. Invisible while keep is near 1; a lattice on a heavily thinned
  // population, which is exactly what (b) now creates.
  const keep = 0.35, salt = 0x123456;
  let agreeOld = 0, agreeNew = 0, n = 0;
  for (let z = -200; z < 200; z++) {
    for (let x = -200; x < 200; x++) {
      if ((hash2(x * 3 + 0, z, salt) < keep) === (hash2((x - 1) * 3 + 3, z, salt) < keep)) agreeOld++;
      if ((hash3(x, z, 0, salt) < keep) === (hash3(x - 1, z, 3, salt) < keep)) agreeNew++;
      n++;
    }
  }
  const independent = keep * keep + (1 - keep) * (1 - keep);
  ok(Math.abs(agreeNew / n - independent) < 0.01 && agreeOld / n > 0.99,
    'cell N sub 0 and cell N-1 sub 3 now decide independently',
    `old ${(agreeOld / n * 100).toFixed(2)}%, new ${(agreeNew / n * 100).toFixed(2)}%, ` +
    `independent ${(independent * 100).toFixed(2)}% over ${n} cells`);

  SCATTER_TUNING.biomeDensityStrength = 1;
}

console.log('\n== 5c. per-biome tint and emissive scale ==');
{
  // WHAT MAKES THIS ITEM SAFE IS WHERE IT SITS. The tint is written AFTER the
  // accept decision, off the biome walkType already resolved, so it consumes no
  // randomness and moves no instance. That is a byte-level claim and it is
  // testable: over an A/B on SCATTER_TUNING.biomeAppearanceStrength, the only
  // bytes allowed to differ are 48..51 - the tint word. If a transform byte ever
  // moves, every anchor, every shot list and section 5a's twelve proximity
  // assertions have quietly gone stale.
  const sample = CHUNKS.slice(0, 60);
  let moved = 0, instances = 0, outsideTint = 0, countMismatch = 0;
  const movedTypes = new Set();
  const authored = new Set(SCATTER_TYPES
    .filter((t) => t.biomeTint !== undefined || t.biomeGlow !== undefined).map((t) => t.id));
  for (const [cx, cz] of sample) {
    SCATTER_TUNING.biomeAppearanceStrength = 0;
    const a = generateScatterForChunk(cx, cz, 0);
    SCATTER_TUNING.biomeAppearanceStrength = 1;
    const b = generateScatterForChunk(cx, cz, 0);
    if (a.count !== b.count) { countMismatch++; continue; }
    const ab = new Uint8Array(a.instances.buffer);
    const bb = new Uint8Array(b.instances.buffer);
    instances += a.count;
    for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
      const n = a.countsByType[t];
      if (!n || a.firstByType[t] !== b.firstByType[t]) continue;
      const base = a.firstByType[t] * SCATTER_STRIDE;
      for (let i = 0; i < n; i++) {
        let d = false;
        for (let k = 0; k < SCATTER_STRIDE; k++) {
          if (ab[base + i * SCATTER_STRIDE + k] === bb[base + i * SCATTER_STRIDE + k]) continue;
          d = true;
          if (k < 48 || k > 51) outsideTint++;
        }
        if (d) { moved++; movedTypes.add(t); }
      }
    }
  }
  ok(countMismatch === 0 && outsideTint === 0,
    'the appearance layer moves the tint word and nothing else',
    `${outsideTint} bytes outside 48..51, ${countMismatch} count mismatches, ` +
    `over ${instances} instances`);
  ok([...movedTypes].every((t) => authored.has(t)) && movedTypes.size > 0,
    'only rows that author a tint or a glow scale move at all',
    `${movedTypes.size} of ${authored.size} authored rows moved, ` +
    `${(100 * moved / Math.max(instances, 1)).toFixed(1)}% of instances`);

  // (b) THE AUTHORED HUE IS THE DELIVERED HUE, AND ONE MESH READS TWO WAYS.
  // Bucketed with censusTypeByBiome's own placement-loop biome would be ideal,
  // but the tint lives on the emitted bytes, so this decodes the bytes and
  // re-derives the biome. The re-derivation disagrees with the placement grid on
  // 15-20% of BOUNDARY candidates (section 5), which is why the assertion is on
  // the SEPARATION between two biome means and not on either mean's exact value:
  // a 20% admixture of the other biome pulls both means together, so a
  // separation that survives it is real.
  SCATTER_TUNING.biomeAppearanceStrength = 1;
  const hueOf = (r, g, b) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d < 1e-9) return 0;
    let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60; return h < 0 ? h + 360 : h;
  };
  const CANYON = BIOMES.findIndex((b) => b.name === 'Canyon Wall');
  const TWALL = BIOMES.findIndex((b) => b.name === 'Trench Wall');
  const rock = SCATTER_BY_KEY.rockMedium.id;
  const sum = [[0, 0, 0, 0], [0, 0, 0, 0]];
  let clip = 0, channels = 0, peakByte = 0, glowCut = [0, 0], glowKeep = [0, 0];
  const sponge = SCATTER_BY_KEY.spongeGlass.id;
  const BREAK = BIOMES.findIndex((b) => b.name === 'Shelf Break');
  for (const [cx, cz] of CHUNKS) {
    const r = generateScatterForChunk(cx, cz, 0);
    const u8 = new Uint8Array(r.instances.buffer);
    const f32 = r.instances;
    for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
      const n = r.countsByType[t];
      if (!n) continue;
      const first = r.firstByType[t];
      for (let i = first; i < first + n; i++) {
        const o = i * SCATTER_STRIDE + 48;
        for (let k = 0; k < 3; k++) {
          channels++;
          if (u8[o + k] === 255) clip++;
          if (u8[o + k] > peakByte) peakByte = u8[o + k];
        }
        if (t !== rock && t !== sponge) continue;
        const x = f32[i * F + 3] + cx * CHUNK, y = f32[i * F + 7], z = f32[i * F + 11] + cz * CHUNK;
        const b = biomeAt(x, z, y, terrain.sampleSlope(x, z));
        if (t === rock && (b === CANYON || b === TWALL)) {
          const s = sum[b === CANYON ? 0 : 1];
          s[0] += u8[o] / 255 * 2; s[1] += u8[o + 1] / 255 * 2; s[2] += u8[o + 2] / 255 * 2; s[3]++;
        } else if (t === sponge) {
          const g = b === BREAK ? glowCut : glowKeep;
          g[0] += u8[o + 3] / 255; g[1]++;
        }
      }
    }
  }
  const mean = sum.map((s) => [s[0] / s[3], s[1] / s[3], s[2] / s[3], s[3]]);
  const hC = hueOf(mean[0][0], mean[0][1], mean[0][2]);
  const hT = hueOf(mean[1][0], mean[1][1], mean[1][2]);
  const sep = Math.abs(((hC - hT) % 360 + 540) % 360 - 180);
  ok(mean[0][3] > 200 && mean[1][3] > 200 && sep > 90,
    'one rockMedium mesh reads iron-red in Canyon Wall and violet in Trench Wall',
    `canyon hue ${hC.toFixed(1)} (n=${mean[0][3]}), trench wall hue ${hT.toFixed(1)} ` +
    `(n=${mean[1][3]}), separation ${sep.toFixed(1)} deg`);

  // (c) NOTHING CLIPS. The whole point of the bake-time ceiling; if the
  // authored hues ever walk past it this is what says so, on delivered bytes.
  ok(clip / channels < 0.0005, 'no tint channel is pinned at the encode ceiling',
    `${clip} of ${channels} channels at 255 (${(100 * clip / channels).toFixed(4)}%), ` +
    `peak byte ${peakByte} of 255`);

  // (d) THE GLOW SCALE IS DELIVERED, and only where it is authored.
  const cut = glowCut[0] / Math.max(glowCut[1], 1);
  const kept = glowKeep[0] / Math.max(glowKeep[1], 1);
  const want = SCATTER_BY_KEY.spongeGlass.biomeGlow[BREAK];
  ok(glowCut[1] > 100 && Math.abs(cut / kept - want) < 0.06,
    'spongeGlass delivers its authored Shelf Break glow scale and keeps it elsewhere',
    `${cut.toFixed(3)} at the break (n=${glowCut[1]}) vs ${kept.toFixed(3)} elsewhere ` +
    `(n=${glowKeep[1]}), ratio ${(cut / kept).toFixed(3)} vs authored ${want}`);
}

console.log('\n== 5d. the census hooks: opts.biomeOut and sampleChunkField ==');
{
  // THESE TWO EXPORTS EXIST FOR ONE CONSUMER, tools/scatter-census.mjs, which is
  // the instrument every Stage 3 acceptance criterion is graded by. That makes their correctness load-bearing for a whole stage of
  // work and invisible from the game: neither reaches a pixel, so nothing else
  // in this tree would ever notice them going wrong.
  //
  // The property that matters most is (b). If biomeOut were written at the wrong
  // index - one off, or before the emitted >= typeCap early return - every
  // per-biome share the census reports would be scrambled while still LOOKING
  // like a plausible distribution, which is the exact failure mode this project
  // keeps rediscovering. A scrambled attribution cannot keep instances inside
  // their own type's mask, so the mask is what pins it.
  const sample = CHUNKS.slice(0, 60);
  const biomeOut = new Uint8Array(SCATTER_MAX_PER_CHUNK);

  // (a) INERT. Passing biomeOut must not move one byte of one instance.
  let diffBytes = 0, countMismatch = 0, checked = 0;
  for (const [cx, cz] of sample) {
    const a = generateScatterForChunk(cx, cz, 0);
    const ab = new Uint8Array(a.instances.buffer.slice(0));
    const b = generateScatterForChunk(cx, cz, 0, { biomeOut });
    const bb = new Uint8Array(b.instances.buffer);
    if (a.count !== b.count) { countMismatch++; continue; }
    // Compared as BYTES on purpose: float slot 12 holds the reinterpreted unorm8
    // tint word, whose bit pattern is frequently a NaN, and NaN !== NaN would
    // report a false mismatch on a run that is in fact identical.
    for (let k = 0; k < a.count * SCATTER_STRIDE; k++) if (ab[k] !== bb[k]) diffBytes++;
    checked += a.count;
  }
  ok(countMismatch === 0 && diffBytes === 0,
    'opts.biomeOut leaves every emitted instance byte-identical',
    `${diffBytes} differing bytes, ${countMismatch} count mismatches, ` +
    `over ${checked} instances in ${sample.length} chunks`);

  // (b) ALIGNED AND ADMITTED. Every recorded biome must be one the instance's own
  // type accepts. This is what catches an index that has slipped.
  let violations = 0, attributed = 0, biomesSeen = new Set();
  for (const [cx, cz] of sample) {
    const d = generateScatterForChunk(cx, cz, 0, { biomeOut });
    for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
      const n = d.countsByType[t];
      if (!n) continue;
      const first = d.firstByType[t];
      for (let i = first; i < first + n; i++) {
        const b = biomeOut[i];
        biomesSeen.add(b);
        attributed++;
        if ((SCATTER_TYPES[t].biomes & (1 << b)) === 0) violations++;
      }
    }
  }
  ok(violations === 0 && attributed > 10000 && biomesSeen.size >= 8,
    'every biomeOut entry is admitted by its own type\'s mask',
    `${violations} violations over ${attributed} instances, ${biomesSeen.size} biomes seen`);

  // A NEGATIVE CONTROL, because (b) passing over an ARRAY OF ZEROS would look the
  // same as (b) passing over a correct one for any type whose mask contains biome
  // 0. Shifting the array by one instance must break it, or the assertion is not
  // testing what it claims to.
  {
    let shifted = 0, tested = 0;
    for (const [cx, cz] of sample) {
      const d = generateScatterForChunk(cx, cz, 0, { biomeOut });
      for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
        const n = d.countsByType[t];
        if (!n) continue;
        const first = d.firstByType[t];
        for (let i = first; i < first + n; i++) {
          const b = biomeOut[Math.min(i + 1, d.count - 1)];
          tested++;
          if ((SCATTER_TYPES[t].biomes & (1 << b)) === 0) shifted++;
        }
      }
    }
    // THE CONTROL IS DELIBERATELY THE WEAKEST SHIFT, +1, and it is worth knowing
    // that it fires on well under one per cent of instances: adjacent emissions
    // of one type are usually in the same biome, so a small slip is caught only
    // at type-run boundaries and at biome boundaries. That is enough to fail the
    // assertion above - the count is in the hundreds over 60 chunks and it has to
    // be exactly zero - but it means the check bounds a MISALIGNMENT, not a
    // subtly wrong classifier. Nothing here would notice biomeAt returning a
    // consistently wrong-but-admitted answer.
    ok(shifted > 0, 'a one-instance shift of that attribution DOES violate the mask',
      `${shifted} of ${tested} would be misattributed at +1, so the check above can fail`);
  }

  // (c) THE FIELD IS THE PLACEMENT LOOP'S OWN. bakeGrid samples
  // terrain.sampleHeightFast on a 4 m lattice, so at a lattice node the bilinear
  // read must return that node's value exactly - and the census's whole
  // numerator/denominator consistency argument rests on it being the same grid.
  {
    const [cx, cz] = sample[5];
    let worst = 0;
    for (let j = 0; j <= 8; j++) {
      for (let i = 0; i <= 8; i++) {
        const lx = i * 16, lz = j * 16;   // 16 m is a multiple of the 4 m pitch
        const f = sampleChunkField(cx, cz, lx, lz);
        const exact = terrain.sampleHeightFast(cx * CHUNK + lx, cz * CHUNK + lz);
        worst = Math.max(worst, Math.abs(f.height - exact));
      }
    }
    ok(worst < 1e-6, 'sampleChunkField reproduces the grid node it is built from',
      `worst |grid - sampleHeightFast| ${worst.toExponential(2)} m over 81 nodes`);
  }

  // (d) INTERLEAVING IS SAFE. Both this and generateScatterForChunk drive the one
  // module-level bakeGrid cache, so a census that alternates between them on
  // DIFFERENT chunks is exactly the access pattern most likely to serve a stale
  // grid. It costs a rebake, which is a performance question; it must not cost a
  // byte, which is a correctness one.
  {
    const [cx, cz] = sample[7];
    const clean = generateScatterForChunk(cx, cz, 0);
    const cb = new Uint8Array(clean.instances.buffer.slice(0));
    sampleChunkField(cx + 9, cz - 4, 40, 90);
    const after = generateScatterForChunk(cx, cz, 0);
    const ab2 = new Uint8Array(after.instances.buffer);
    let d2 = 0;
    if (clean.count === after.count) {
      for (let k = 0; k < clean.count * SCATTER_STRIDE; k++) if (cb[k] !== ab2[k]) d2++;
    } else d2 = -1;
    ok(d2 === 0, 'a sampleChunkField on another chunk does not disturb the next generate',
      `${d2} differing bytes over ${clean.count} instances`);
  }
}

console.log('\n== 6. caps and the budget ==');
{
  resetScatterStats();
  let overCap = null, overBudget = null, worstCount = 0;
  for (const [cx, cz] of CHUNKS) {
    const r = generateScatterForChunk(cx, cz, 0);
    if (r.count > worstCount) worstCount = r.count;
    if (r.count > SCATTER_MAX_PER_CHUNK) overBudget = `${cx},${cz} -> ${r.count}`;
    for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
      if (r.countsByType[t] > SCATTER_TYPES[t].maxPerChunk) {
        overCap = `${SCATTER_TYPES[t].key} ${r.countsByType[t]} > ${SCATTER_TYPES[t].maxPerChunk}`;
      }
    }
  }
  ok(overCap === null, 'no type exceeds its per-type cap', overCap ?? 'all within cap');
  ok(overBudget === null, 'no chunk exceeds SCATTER_MAX_PER_CHUNK',
    overBudget ?? `worst ${worstCount} of ${SCATTER_MAX_PER_CHUNK}`);

  // THE BUDGET IS THE ONE COUPLING BETWEEN TYPES AND IT MUST NEVER BIND.
  // typeCap is min(maxPerChunk, budget - count) and types are emitted
  // most-important-first, so the moment the budget decides a count, reducing a
  // high-importance type's population - a biomeDensity weight, an appended row,
  // a density edit - silently moves which of a LOW-importance type's instances
  // survive. The file's own comment says it binds "in practice nowhere"; this is
  // what turns that from a claim into a measurement, and it is the guard that
  // has to stay green as the table grows past 42 rows.
  ok(scatterStats.budgetBound === 0,
    'the global budget never decides a count on the shipping table',
    `${scatterStats.budgetBound} binds over ${CHUNKS.length} chunks, ` +
    `worst chunk ${worstCount} of ${SCATTER_MAX_PER_CHUNK} ` +
    `(${(worstCount / SCATTER_MAX_PER_CHUNK * 100).toFixed(1)}%)`);

  // Graceful degradation: squeeze the budget and check the SURVIVORS are the
  // important ones, not whichever the loop happened to reach first.
  //
  // THE BUDGET IS 300 AND NOT 700, AND THAT IS NOT A COSMETIC CHANGE. `dropped`
  // is only recorded when typeCap reaches 0, i.e. when the emission consumes the
  // budget EXACTLY. It frequently does not: thinning is Bernoulli, so once
  // headroom falls to 1 every remaining type is walked with keep = 1/offered
  // and almost always emits nothing, leaving count one short of the budget
  // forever. Measured on chunk (0, 1): budgets 100 / 200 / 700 / 800 / 1000 all
  // finish at headroom 1 and drop NOTHING, while 300 / 400 / 500 finish at
  // headroom 0 and drop 9 types. At 700 which side of that the chunk lands on
  // turned on a single instance - it flipped when the cap-thinning hash was
  // de-aliased (section 5b) - so the assertion was sitting on a knife edge and
  // measuring the coin, not the contract. 300 is deep enough that the budget is
  // consumed by the high-importance types alone.
  resetScatterStats();
  const squeezed = generateScatterForChunk(0, 1, 0, { budget: 300 });
  ok(squeezed.count <= 300, 'a tight budget is respected', `${squeezed.count} <= 300`);
  ok(squeezed.dropped.length > 0, 'a tight budget drops types and says so',
    `dropped ${squeezed.dropped.map((i) => SCATTER_TYPES[i].key).join(', ')}`);
  let keptMin = Infinity, droppedMax = -Infinity;
  for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
    if (squeezed.countsByType[t] > 0) keptMin = Math.min(keptMin, SCATTER_TYPES[t].importance);
  }
  for (const id of squeezed.dropped) droppedMax = Math.max(droppedMax, SCATTER_TYPES[id].importance);
  ok(droppedMax <= keptMin, 'the LEAST important types are the ones dropped',
    `dropped importance <= ${droppedMax}, kept >= ${keptMin}`);
  ok(scatterStats.typesDropped === squeezed.dropped.length, 'degradation is counted in scatterStats',
    `${scatterStats.typesDropped}`);
}

console.log('\n== 7. a capped type is thinned, not truncated ==');
{
  // The failure this guards against: the cell walk is row-major, so stopping at
  // the cap cuts the chunk in half along Z and leaves a straight 128 m edge on
  // the seabed. Uniform thinning must spread the loss over the whole chunk.
  let worstImbalance = 0, worstLabel = '';
  let cappedFound = 0;
  for (const [cx, cz] of CHUNKS.slice(0, 40)) {
    const r = generateScatterForChunk(cx, cz, 0);
    for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
      const n = r.countsByType[t];
      if (n < SCATTER_TYPES[t].maxPerChunk * 0.98 || n < 200) continue;
      cappedFound++;
      let lo = 0, hi = 0;
      for (let i = r.firstByType[t]; i < r.firstByType[t] + n; i++) {
        if (r.instances[i * F + 11] < CHUNK * 0.5) lo++; else hi++;
      }
      const imbalance = Math.abs(lo - hi) / n;
      if (imbalance > worstImbalance) {
        worstImbalance = imbalance;
        worstLabel = `${SCATTER_TYPES[t].key} in (${cx},${cz}): ${lo} vs ${hi} of ${n}`;
      }
    }
  }
  ok(cappedFound > 0, 'the test found capped types to examine', `${cappedFound} capped runs`);
  // 0.5 is generous: the underlying terrain genuinely differs between halves.
  // A truncating implementation scores 1.0 exactly.
  ok(worstImbalance < 0.5, 'a capped type fills both Z halves of its chunk',
    `worst imbalance ${(worstImbalance * 100).toFixed(1)}% - ${worstLabel}`);
}

console.log('\n== 8. clustering actually clusters ==');
{
  // A colony field must make the per-chunk count VARY. If the mask were broken
  // (or ignored) the count would be Poisson around a fixed mean, whose relative
  // spread over 200 chunks is tiny; a colony field pushes it far wider.
  const stats = new Map();
  for (const [cx, cz] of CHUNKS) {
    const r = generateScatterForChunk(cx, cz, 0);
    for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
      if (!stats.has(t)) stats.set(t, []);
      if (r.countsByType[t] > 0) stats.get(t).push(r.countsByType[t]);
    }
  }
  const report = [];
  for (const key of ['kelpStalk', 'mushroomCap', 'coralBranching', 'glowPod', 'crystalShard']) {
    const t = SCATTER_BY_KEY[key];
    const s = stats.get(t.id) ?? [];
    if (s.length < 4) { report.push(`${key}: only ${s.length} chunks`); continue; }
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
    report.push(`${key} cv ${(sd / mean).toFixed(2)}`);
    // kelpStalk's bound is 0.30, not 0.35, since the Crimson Meadow cession:
    // kelp's depth floor moved 14 -> 28, which removed the sparse shallow
    // fringe chunks from the biome - the LOW-count tail of this statistic -
    // so the deterministic cv over the sampled chunks fell 0.4x -> 0.34 with
    // the colony mechanism untouched (same row, same colony field). The
    // clustering-is-real guard below (pair correlation) is unaffected.
    const cvFloor = key === 'kelpStalk' ? 0.30 : 0.35;
    ok(sd / mean > cvFloor, `${key} count varies chunk to chunk (colonies)`,
      `mean ${mean.toFixed(0)}, sd ${sd.toFixed(0)}, cv ${(sd / mean).toFixed(2)}, ${s.length} chunks`);
  }
  console.log(`       ${report.join('   ')}`);

  // The count-per-chunk spread above is suggestive but not proof: a rare type has
  // a wide spread simply because it is rare. The real claim is SPATIAL, so measure
  // it spatially - the index of dispersion (variance / mean) of instance counts in
  // an 8 m bin grid over one chunk. A uniform (Poisson) process gives ~1; a
  // clustered one gives well above 1. Comparing a colony type against a
  // non-colony type IN THE SAME CHUNK controls for density and for the terrain.
  const dispersion = (r, typeId, bins = 16) => {
    const n = r.countsByType[typeId];
    if (n < 60) return null;
    const grid = new Uint32Array(bins * bins);
    const step = CHUNK / bins;
    for (let i = r.firstByType[typeId]; i < r.firstByType[typeId] + n; i++) {
      const bx = Math.min(bins - 1, Math.floor(r.instances[i * F + 3] / step));
      const bz = Math.min(bins - 1, Math.floor(r.instances[i * F + 11] / step));
      grid[bz * bins + bx]++;
    }
    const mean = n / grid.length;
    let v = 0;
    for (const c of grid) v += (c - mean) ** 2;
    return (v / grid.length) / mean;
  };

  // Find a chunk that carries both a colony coral and the non-colony one.
  let best = null;
  for (const [cx, cz] of CHUNKS) {
    const r = generateScatterForChunk(cx, cz, 0);
    const dBranch = dispersion(r, SCATTER_BY_KEY.coralBranching.id);
    const dBrain = dispersion(r, SCATTER_BY_KEY.coralBrain.id);
    if (dBranch !== null && dBrain !== null) { best = { cx, cz, dBranch, dBrain }; break; }
  }
  ok(best !== null && best.dBranch > best.dBrain,
    'the colony coral is spatially clumpier than the non-colony one',
    best ? `chunk (${best.cx},${best.cz}) coralBranching dispersion ${best.dBranch.toFixed(2)} > ` +
      `coralBrain ${best.dBrain.toFixed(2)} (uniform would be ~1.0)`
      : 'no chunk carried both types');
  ok(best !== null && best.dBrain < 3.0,
    'the non-colony type is close to a uniform scatter',
    best ? `dispersion ${best.dBrain.toFixed(2)}` : '');
}

console.log('\n== 9. ore nodes agree with the drawn instances ==');
{
  // The instance stream is f32 and oreNodesInChunk returns f64, so the two agree
  // to f32 precision and not to the bit. At 3 km from the origin one f32 step is
  // 0.24 mm; 2 mm is therefore a generous bound that still catches a genuine
  // divergence, which would be metres.
  const TOL = 0.002;
  let matched = 0, total = 0, worstXZ = 0, worstY = 0;
  for (const [cx, cz] of CHUNKS.slice(0, 80)) {
    const nodes = oreNodesInChunk(cx, cz);
    if (nodes.length === 0) continue;
    const r = generateScatterForChunk(cx, cz, 0);
    for (const node of nodes) {
      total++;
      const t = node.typeId;
      const n = r.countsByType[t];
      let bestD = Infinity, bestY = 0;
      for (let i = r.firstByType[t]; i < r.firstByType[t] + n; i++) {
        const o = i * F;
        const ax = cx * CHUNK + r.instances[o + 3];
        const az = cz * CHUNK + r.instances[o + 11];
        const d = Math.hypot(ax - node.position[0], az - node.position[2]);
        if (d < bestD) { bestD = d; bestY = Math.abs(r.instances[o + 7] - node.position[1]); }
      }
      if (bestD <= TOL && bestY <= TOL) matched++;
      if (bestD < Infinity) {
        worstXZ = Math.max(worstXZ, Math.min(bestD, 1e9));
        worstY = Math.max(worstY, bestY);
      }
    }
  }
  ok(total > 0, 'ore nodes exist somewhere', `${total} nodes over 80 chunks`);
  ok(matched === total, 'every ore node coincides with a drawn instance of its type',
    `${matched} of ${total} matched within ${TOL * 1000} mm`);
  ok(worstXZ <= TOL && worstY <= TOL, 'the agreement is at f32 precision, not approximate',
    `worst xz ${(worstXZ * 1000).toFixed(3)} mm, worst y ${(worstY * 1000).toFixed(3)} mm`);

  let amountsOk = true;
  for (const [cx, cz] of CHUNKS.slice(0, 80)) {
    for (const node of oreNodesInChunk(cx, cz)) {
      const t = SCATTER_TYPES[node.typeId];
      if (node.amount < t.ore.amount[0] || node.amount > t.ore.amount[1]) amountsOk = false;
      if (node.materialId !== t.ore.materialId) amountsOk = false;
    }
  }
  ok(amountsOk, 'ore amounts and material ids are in range', '');
}

console.log('\n== 10. flags and encodings ==');
{
  const r = generateScatterForChunk(0, 1, 0);
  const u8 = new Uint8Array(r.instances.buffer);
  let flagsOk = true, tintOk = true, typeOk = true;
  for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
    const n = r.countsByType[t];
    if (n === 0) continue;
    const type = SCATTER_TYPES[t];
    const want =
      (type.ore !== null ? SCATTER_FLAG.HARVESTABLE : 0) |
      (type.collidable ? SCATTER_FLAG.COLLIDABLE : 0) |
      (type.sways ? SCATTER_FLAG.SWAYS : 0) |
      (type.emissive > 0 ? SCATTER_FLAG.EMISSIVE : 0);
    for (let i = r.firstByType[t]; i < r.firstByType[t] + n; i++) {
      const b = i * SCATTER_STRIDE;
      if (u8[b + 63] !== want) flagsOk = false;
      if (u8[b + 61] !== type.id) typeOk = false;
      // Tint is stored halved so the shader's doubling recovers a [0,2]
      // multiplier; the encoded byte must therefore never be pinned at 255.
      for (let c = 0; c < 3; c++) if (u8[b + 48 + c] === 255) tintOk = false;
    }
  }
  ok(flagsOk, 'every instance carries its type flags', '');
  ok(typeOk, 'meta.y decodes back to the type id', '');
  ok(tintOk, 'the halved tint never clips at unity', '');
}

console.log('\n== 11. AABBs bound their instances ==');
{
  let bad = null;
  for (const [cx, cz] of CHUNKS.slice(0, 60)) {
    const r = generateScatterForChunk(cx, cz, 0);
    if (r.count === 0) {
      if (!(r.aabb.maxX > r.aabb.minX && r.aabb.maxZ > r.aabb.minZ)) bad = `empty chunk box inverted at ${cx},${cz}`;
      continue;
    }
    for (let i = 0; i < r.count; i++) {
      const o = i * F;
      const ax = cx * CHUNK + r.instances[o + 3];
      const ay = r.instances[o + 7];
      const az = cz * CHUNK + r.instances[o + 11];
      if (ax < r.aabb.minX || ax > r.aabb.maxX || az < r.aabb.minZ || az > r.aabb.maxZ ||
          ay < r.aabb.minY || ay > r.aabb.maxY) {
        bad = `instance ${i} outside the box of chunk ${cx},${cz}`;
        break;
      }
    }
    if (bad) break;
  }
  ok(bad === null, 'every instance origin is inside its chunk AABB', bad ?? '60 chunks');
}

console.log('\n== 12. LOD gating ==');
{
  ok(scatterLodFor(0) === 0 && scatterLodFor(200) === 1 && scatterLodFor(400) === 2,
    'scatterLodFor rings double from SCATTER_LOD_BASE_DISTANCE',
    `0m->${scatterLodFor(0)} 200m->${scatterLodFor(200)} 400m->${scatterLodFor(400)}`);

  // THE RING RADII ARE PINNED BY THE TYPE TABLE, NOT BY TASTE.
  //
  // `maxLod` does not coarsen a type, it DELETES it, so a type must still be
  // generated everywhere it is drawn: ring `maxLod` has to reach the type's own
  // viewDistance. The margin is RESCAN_DISTANCE, 16 m in render/passes/
  // scatter.js, because the resident set is only recomputed after the camera has
  // travelled that far and a chunk can therefore be one rescan late to refine.
  const RESCAN_MARGIN = 16;
  const ringEnd = (lod) => WORLD.SCATTER_LOD_BASE_DISTANCE * Math.pow(2, lod);
  const starved = [];
  let tightest = Infinity, tightestKey = '';
  for (const t of SCATTER_TYPES) {
    const slack = ringEnd(t.maxLod) - t.viewDistance - RESCAN_MARGIN;
    if (slack < 0) starved.push(`${t.key} draws to ${t.viewDistance} m but ring ${t.maxLod} ends at ${ringEnd(t.maxLod)}`);
    if (slack < tightest) { tightest = slack; tightestKey = t.key; }
  }
  ok(starved.length === 0, 'every type is generated everywhere it is drawn',
    starved.length ? starved.join('; ')
      : `tightest is ${tightestKey} with ${tightest.toFixed(0)} m of slack over ${RESCAN_MARGIN} m of rescan`);

  // ...and the reason the render pass MUST re-generate a resident chunk at a
  // finer LOD. Chunks are admitted as they cross the residency radius, so every
  // chunk that streams in during play is born at whatever ring that radius sits
  // in. If that is not ring 0 - and it is not - a chunk that is never refined
  // has no seagrass, no cobble and no tube coral for as long as it is resident.
  // A chunk is admitted when its CENTRE crosses the residency radius, so its
  // NEAREST point - the distance the LOD is chosen from - is between half an
  // edge and half a diagonal closer than that.
  const bornDist = SCATTER_MAX_VIEW_DISTANCE - CHUNK * 0.5;
  const bornLod = scatterLodFor(bornDist);
  ok(bornLod > 0, 'a chunk admitted at the residency radius is born COARSE',
    `near distance ${bornDist} m -> lod ${bornLod}, so refinement is mandatory`);
  {
    // Measured on the chunk under qa's reef-floor camera.
    const fine = generateScatterForChunk(1, 2, 0);
    const coarse = generateScatterForChunk(1, 2, bornLod);
    const lost = [];
    for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
      if (fine.countsByType[t] > 0 && coarse.countsByType[t] === 0) {
        lost.push(`${SCATTER_TYPES[t].key} ${fine.countsByType[t]}`);
      }
    }
    ok(fine.count > coarse.count * 4, 'refining a reef chunk is worth an order of magnitude',
      `lod 0 ${fine.count} vs lod ${bornLod} ${coarse.count} ` +
      `(${(100 * (1 - coarse.count / fine.count)).toFixed(1)}% missing without it)`);
    console.log(`       lost at lod ${bornLod}: ${lost.join(', ')}`);
  }

  // ...and THIS is the guard on the code that does it. Everything above measures
  // what refinement is WORTH; scatterLodTransition is what decides to do it, and
  // until this block existed the refine branch could be deleted outright with the
  // whole suite still green.
  //
  // rescan() measures to the chunk's NEAREST point, so the model below does too.
  const nearDist = (cx, cz, camX, camZ) => {
    const half = CHUNK * 0.5;
    const nx = Math.max(0, Math.abs(cx * CHUNK + half - camX) - half);
    const nz = Math.max(0, Math.abs(cz * CHUNK + half - camZ) - half);
    return Math.sqrt(nx * nx + nz * nz);
  };
  {
    const RING0 = WORLD.SCATTER_LOD_BASE_DISTANCE;          // 160 m
    const COARSEN_EDGE = 200;                               // RING0 * COARSEN_HYSTERESIS

    // The refine branch, end to end: the reef chunk (1, 2) is admitted while the
    // camera is still outside the residency radius, so it is born coarse; the
    // camera then flies into it and the chunk must come back at LOD 0 WITH the
    // types that LOD 1 deletes.
    const seagrass = SCATTER_BY_KEY.seagrass.id;
    const born = generateScatterForChunk(1, 2, bornLod);
    const insideX = 1 * CHUNK + CHUNK * 0.5, insideZ = 2 * CHUNK + CHUNK * 0.5;
    const dIn = nearDist(1, 2, insideX, insideZ);
    const verdict = scatterLodTransition(bornLod, dIn);
    // generate() re-derives the LOD from the job's distance, exactly as here.
    const refinedLod = verdict === 'refine' ? scatterLodFor(dIn) : bornLod;
    const refined = generateScatterForChunk(1, 2, refinedLod);
    ok(verdict === 'refine' && refinedLod === 0 && refined.countsByType[seagrass] > 0,
      'a chunk born at LOD 1 refines to LOD 0 from inside itself',
      `born lod ${bornLod} seagrass ${born.countsByType[seagrass]} -> ` +
      `${verdict} -> lod ${refinedLod} seagrass ${refined.countsByType[seagrass]}`);

    // The coarsen branch. A chunk at LOD 0 that has fallen past the hysteresis
    // edge must be regenerated coarser, or a player working a small area drives
    // the resident set to all-LOD-0 and the global cap starts dropping the very
    // types refinement exists to deliver.
    ok(scatterLodTransition(0, COARSEN_EDGE + 1) === 'coarsen',
      'a LOD 0 chunk past the coarsen edge coarsens',
      `${COARSEN_EDGE + 1} m -> ${scatterLodTransition(0, COARSEN_EDGE + 1)}`);

    // The hysteresis band itself: between the ring edge and the coarsen edge
    // NOTHING happens, in either direction, or a camera sitting on the boundary
    // regenerates the same chunk every rescan.
    const band = [];
    for (let d = RING0 - 8; d <= COARSEN_EDGE + 8; d += 2) {
      band.push({ d, lod0: scatterLodTransition(0, d), lod1: scatterLodTransition(1, d) });
    }
    const heldLo = band.filter((b) => b.d >= RING0 && b.d < COARSEN_EDGE);
    ok(heldLo.every((b) => b.lod0 === 'keep' && b.lod1 === 'keep'),
      'nothing moves inside the hysteresis band',
      `${RING0}-${COARSEN_EDGE} m: ${heldLo.length} samples, ` +
      `${heldLo.filter((b) => b.lod0 !== 'keep' || b.lod1 !== 'keep').length} moved`);
    // Below the band a LOD 1 chunk refines; above it a LOD 0 chunk coarsens. The
    // band is therefore exactly as wide as the two edges say it is.
    ok(band.filter((b) => b.d < RING0).every((b) => b.lod1 === 'refine')
      && band.filter((b) => b.d >= COARSEN_EDGE).every((b) => b.lod0 === 'coarsen'),
      'the band is bounded by refine below and coarsen above',
      `refine below ${RING0} m, coarsen at or past ${COARSEN_EDGE} m`);
    // 40 m of band against render/passes/scatter.js's 16 m RESCAN_DISTANCE is
    // three rescans to cross, which is what makes the boundary quiet.
    ok((COARSEN_EDGE - RING0) / RESCAN_MARGIN >= 2,
      'the band is several rescan steps wide',
      `${COARSEN_EDGE - RING0} m / ${RESCAN_MARGIN} m = ` +
      `${((COARSEN_EDGE - RING0) / RESCAN_MARGIN).toFixed(1)} rescans`);
  }
  const counts = [];
  for (let lod = 0; lod <= SCATTER_MAX_LOD + 1; lod++) {
    let n = 0, types = 0;
    for (const [cx, cz] of CHUNKS.slice(0, 40)) {
      const r = generateScatterForChunk(cx, cz, lod);
      n += r.count;
      for (let t = 0; t < SCATTER_TYPE_COUNT; t++) if (r.countsByType[t] > 0) types++;
    }
    counts.push({ lod, n, types });
  }
  for (const c of counts) console.log(`       lod ${c.lod}: ${c.n.toLocaleString()} instances, ${c.types} type-runs`);
  let monotone = true;
  for (let i = 1; i < counts.length; i++) if (counts[i].n > counts[i - 1].n) monotone = false;
  ok(monotone, 'instance count falls monotonically with LOD', '');
  ok(counts[counts.length - 1].n === 0, 'nothing is generated past SCATTER_MAX_LOD',
    `lod ${SCATTER_MAX_LOD + 1} -> ${counts[counts.length - 1].n}`);
}

console.log('\n== 13. residency fits the global instance cap ==');
{
  // The pass keeps chunks within SCATTER_MAX_VIEW_DISTANCE. Count them, multiply
  // by the measured worst case, and check it against RENDER.MAX_SCATTER_INSTANCES.
  const radius = SCATTER_MAX_VIEW_DISTANCE * 1.18;   // the pass's unload margin
  let resident = 0;
  const span = Math.ceil(radius / CHUNK) + 1;
  for (let cz = -span; cz <= span; cz++) {
    for (let cx = -span; cx <= span; cx++) {
      const dx = cx * CHUNK + CHUNK * 0.5, dz = cz * CHUNK + CHUNK * 0.5;
      if (dx * dx + dz * dz <= radius * radius) resident++;
    }
  }
  let worst = 0, sum = 0;
  for (const [cx, cz] of CHUNKS) {
    const r = generateScatterForChunk(cx, cz, 0);
    worst = Math.max(worst, r.count);
    sum += r.count;
  }
  const mean = sum / CHUNKS.length;
  ok(resident * mean < SCATTER_GLOBAL_CAP,
    'typical residency fits RENDER.MAX_SCATTER_INSTANCES',
    `${resident} chunks x ${mean.toFixed(0)} mean = ${Math.round(resident * mean).toLocaleString()} of ${SCATTER_GLOBAL_CAP.toLocaleString()}`);
  console.log(`       worst case ${resident} x ${worst} = ${(resident * worst).toLocaleString()} - ` +
    'above the cap, which is why the pass passes generateScatterForChunk a live budget');
  ok(RENDER.MAX_SCATTER_INSTANCES === SCATTER_GLOBAL_CAP, 'the cap comes from constants.js', '');
}

console.log('\n== 14. cost, over 200 chunks of varied terrain ==');
{
  resetScatterStats();
  // Warm the JIT on a chunk that is not in the measured set.
  generateScatterForChunk(99, 99, 0);
  const perChunk = [];
  const t0 = performance.now();
  let total = 0;
  const byType = new Uint32Array(SCATTER_TYPE_COUNT);
  for (const [cx, cz] of CHUNKS) {
    invalidateScatterCache();       // measure a COLD chunk, as the streamer sees it
    const r = generateScatterForChunk(cx, cz, 0);
    perChunk.push({ n: r.count, ms: r.genMs });
    total += r.count;
    for (let t = 0; t < SCATTER_TYPE_COUNT; t++) byType[t] += r.countsByType[t];
  }
  const wall = performance.now() - t0;
  perChunk.sort((a, b) => a.ms - b.ms);
  const p50 = perChunk[perChunk.length >> 1].ms;
  const p99 = perChunk[Math.floor(perChunk.length * 0.99)].ms;
  const worstMs = perChunk[perChunk.length - 1].ms;
  const counts = perChunk.map((p) => p.n).sort((a, b) => a - b);

  console.log(`       total instances        ${total.toLocaleString()} over ${CHUNKS.length} chunks`);
  console.log(`       per chunk             mean ${(total / CHUNKS.length).toFixed(0)}   ` +
    `median ${counts[counts.length >> 1]}   worst ${counts[counts.length - 1]}`);
  console.log(`       generation            mean ${(wall / CHUNKS.length).toFixed(2)} ms   ` +
    `median ${p50.toFixed(2)} ms   p99 ${p99.toFixed(2)} ms   worst ${worstMs.toFixed(2)} ms`);
  console.log('       per type (total / mean per chunk that has any):');
  for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
    const type = SCATTER_TYPES[t];
    console.log(`         ${type.key.padEnd(17)} ${String(byType[t]).padStart(7)}  ` +
      `${(byType[t] / CHUNKS.length).toFixed(1).padStart(7)} per chunk`);
  }

  ok(total > 100000, 'the world is actually populated', `${total.toLocaleString()} instances`);
  ok(worstMs < 14, 'worst-case chunk stays under the terrain bake it follows',
    `${worstMs.toFixed(2)} ms vs terrain's 9-24 ms`);
  ok(p50 < 7, 'median chunk is affordable at one per frame', `${p50.toFixed(2)} ms`);
  let placedTypes = 0;
  for (let t = 0; t < SCATTER_TYPE_COUNT; t++) if (byType[t] > 0) placedTypes++;
  ok(placedTypes >= 26, 'at least 26 types are actually placed in the world',
    `${placedTypes} of ${SCATTER_TYPE_COUNT}`);
  // A signature absent from the fixed 200-chunk pseudo-grid gets ONE appeal:
  // its own anchor's 3x3 chunk box. The grid covers ~11% of the disc, so a
  // POCKET biome can be structurally missed by it - Ossuary Flats is 10.5 ha
  // in total (measured, whole-disc census), i.e. an expected 0.7 chunks of
  // this sample, and its colossus sat in none of them while section 5a was
  // simultaneously measuring six of it within 100 m of the anchor. A
  // signature absent from BOTH samples is genuinely unbuilt and still fails.
  const absentSignatures = [];
  for (const t of SCATTER_TYPES) {
    if (!Number.isInteger(t.signatureBiome) || byType[t.id] > 0) continue;
    const a = resolveBiomeAnchors(terrain)[t.signatureBiome];
    const acx = Math.floor(a.x / CHUNK), acz = Math.floor(a.z / CHUNK);
    let n = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        n += generateScatterForChunk(acx + dx, acz + dz, 0).countsByType[t.id];
      }
    }
    if (n === 0) absentSignatures.push(t.key);
  }
  ok(absentSignatures.length === 0,
    'every biome signature occurs in the sampled world (or failing that, at its own anchor)',
    absentSignatures.length ? `absent: ${absentSignatures.join(', ')}`
      : `all ${SCATTER_TYPES.filter((t) => Number.isInteger(t.signatureBiome)).length} placed`);
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`
  + `${skips ? ` (${skips} skipped - empty subject set, reason printed above)` : ''}\n`);
process.exit(fails === 0 ? 0 : 1);
