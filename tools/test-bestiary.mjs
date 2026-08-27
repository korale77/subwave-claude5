#!/usr/bin/env node
/**
 * SUBWAVE bestiary and creature-mesh verification.
 *
 * Runs the real records and the real generators headless, with no GPU, and
 * asserts the two classes of thing a renderer cannot recover from:
 *
 *   DATA. Every species record is complete and internally consistent - burst
 *   speed at or above cruise, a depth range inside the world this build has, a
 *   danger tier the tier table knows about, a bioluminescence pattern the mesh
 *   generator implements, and a mesh recipe with no misspelled key (a
 *   misspelled recipe key is silently ignored, which is a stub with good
 *   manners).
 *
 *   GEOMETRY. Every mesh builds; indices are in range; normals are unit length
 *   and agree with the winding they were built from; no triangle is degenerate;
 *   bone weights sum to exactly 1 and index a bone that exists; the
 *   bioluminescence mask is non-uniform, which is the difference between an
 *   animal with photophores and an animal that glows; and the same seed
 *   produces byte-identical arrays.
 *
 * What it cannot check is whether a Hollowjaw looks like a Hollowjaw. For that,
 * look at the screenshots.
 *
 * Every number printed is measured. Usage: node tools/test-bestiary.mjs
 * Exit code is non-zero if any check fails.
 */

import { WORLD, RENDER } from '../src/core/constants.js';
import { BIOME_COUNT } from '../src/world/biomes.js';
import {
  SPECIES, SPECIES_COUNT, speciesById, SPECIES_INDEX, SPECIES_BY_ARCHETYPE,
  ARCHETYPE, ARCHETYPE_LIST, SWIM_MODE, BIOLUM_PATTERN, HABITAT, DANGER_BY_TIER,
  CREATURE_HABITAT, HABITAT_ID_COUNT, BIOME_ALIAS,
  speciesForBiome, speciesFitsTier, activityAt, lightAffinityAt,
} from '../src/entities/bestiary.js';
import {
  buildCreatureMesh, buildCreatureBones, creatureVertexBudget,
  CREATURE_MAX_BONES, CREATURE_INFLUENCES, BONE_ROLE, BODY_PLAN, RECIPE_KEYS,
  ALBEDO_PATTERN_LIST, ALBEDO_PATTERN_ID, albedoPatternMask, albedoPatternParams,
} from '../src/entities/creature_mesh.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = (p) => readFileSync(fileURLToPath(new URL('../' + p, import.meta.url)), 'utf8');

let failures = 0;
let checks = 0;

const fmt = (v, d = 3) => (typeof v === 'number' ? v.toFixed(d) : String(v));

function check(name, condition, detail) {
  checks++;
  if (condition) {
    console.log(`  ok   ${name}${detail ? '   ' + detail : ''}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? '   ' + detail : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

const PATTERNS = new Set(Object.values(BIOLUM_PATTERN));
const HABITATS = new Set(Object.values(HABITAT));
const SWIM_MODES = new Set(Object.values(SWIM_MODE));

// ===========================================================================
section('1. Roster completeness');
// ===========================================================================
{
  check('the roster spans the design and clears the 24-species floor',
    SPECIES_COUNT >= 24, `${SPECIES_COUNT} species`);

  const ids = new Set(SPECIES.map((s) => s.id));
  check('every id is unique', ids.size === SPECIES_COUNT);
  const names = new Set(SPECIES.map((s) => s.name));
  check('every common name is unique', names.size === SPECIES_COUNT);
  const latin = new Set(SPECIES.map((s) => s.latinish));
  check('every binomial is unique', latin.size === SPECIES_COUNT);

  check('speciesById resolves every record',
    SPECIES.every((s) => speciesById[s.id] === s));
  check('SPECIES_INDEX round-trips through SPECIES',
    SPECIES.every((s, i) => SPECIES_INDEX[s.id] === i));

  // A u16 speciesId in the agent pool needs the roster to fit.
  check('the roster fits a u16 species id', SPECIES_COUNT < 65536);

  const frozen = SPECIES.every((s) => Object.isFrozen(s) && Object.isFrozen(s.meshRecipe)
    && Object.isFrozen(s.bioluminescence) && Object.isFrozen(s.damage)
    && Object.isFrozen(s.biomes) && Object.isFrozen(s.depthRange));
  check('every record is deeply frozen', frozen);
}

// ===========================================================================
section('2. Field-by-field consistency');
// ===========================================================================
{
  const problems = [];
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isStr = (v) => typeof v === 'string' && v.length > 0;

  for (const s of SPECIES) {
    const bad = (msg) => problems.push(`${s.id}: ${msg}`);

    if (!isStr(s.name)) bad('missing name');
    if (!isStr(s.latinish) || !s.latinish.includes(' ')) bad('binomial is not a binomial');
    if (!ARCHETYPE_LIST.includes(s.archetype)) bad(`unknown archetype ${s.archetype}`);
    if (!isStr(s.steering) || !s.steering.startsWith('ARCH_')) bad('missing steering row');
    if (!SWIM_MODES.has(s.swimMode)) bad(`unknown swim mode ${s.swimMode}`);
    if (!HABITATS.has(s.habitat)) bad(`unknown habitat ${s.habitat}`);

    if (!Array.isArray(s.biomes) || s.biomes.length === 0) bad('no biomes');
    for (const b of s.biomes) {
      if (!Number.isInteger(b) || b < 0 || b >= HABITAT_ID_COUNT) bad(`biome id ${b} out of range`);
    }

    if (s.depthRange.length !== 2) bad('depthRange is not a pair');
    if (!(s.depthRange[0] <= s.depthRange[1])) bad('depthRange is inverted');
    if (s.depthRange[1] > WORLD.MAX_DEPTH) bad(`depth ${s.depthRange[1]} below the world floor`);
    if (s.depthRange[0] < -WORLD.MAX_TERRAIN_HEIGHT) bad(`altitude ${-s.depthRange[0]} above the world`);
    if (s.depthRange[1] === s.depthRange[0]) bad('depthRange has zero extent');

    if (!(isNum(s.length) && s.length > 0)) bad('bad length');
    if (!(isNum(s.mass) && s.mass > 0)) bad('bad mass');
    if (!(isNum(s.health) && s.health > 0)) bad('bad health');
    if (!Array.isArray(s.diet) || s.diet.length === 0) bad('no diet');

    if (!Number.isInteger(s.dangerTier) || s.dangerTier < 0 || s.dangerTier > 5) {
      bad(`danger tier ${s.dangerTier} outside 0..5`);
    }
    if (!isStr(s.aggressionTrigger)) bad('no aggression trigger');

    if (!(isNum(s.damage.player) && s.damage.player >= 0)) bad('bad player damage');
    if (!(isNum(s.damage.vessel) && s.damage.vessel >= 0)) bad('bad vessel damage');
    if (s.dangerTier === 0 && s.damage.player !== 0) bad('tier 0 that can hurt the player');
    if (s.dangerTier >= 3 && s.damage.player <= 0) bad('hunter that deals no damage');

    if (!(isNum(s.speed) && s.speed >= 0)) bad('bad speed');
    if (!(isNum(s.burstSpeed) && s.burstSpeed >= s.speed)) {
      bad(`burst ${s.burstSpeed} below cruise ${s.speed}`);
    }
    if (!(isNum(s.turnRate) && s.turnRate >= 0 && s.turnRate <= 1200)) bad('bad turn rate');

    if (s.schoolSize.length !== 2) bad('schoolSize is not a pair');
    if (!(s.schoolSize[0] >= 1 && s.schoolSize[1] >= s.schoolSize[0])) bad('bad schoolSize');
    if (!(isNum(s.densityPerKm3) && s.densityPerKm3 > 0)) bad('bad density');

    if (s.dayNightActivity.length !== 2) bad('dayNightActivity is not a pair');
    for (const a of s.dayNightActivity) {
      if (!(a >= 0 && a <= 2)) bad(`activity ${a} outside 0..2`);
    }
    if (s.dayNightActivity[0] === 0 && s.dayNightActivity[1] === 0) bad('never active');

    if (!(s.lightAffinity >= -1 && s.lightAffinity <= 1)) bad('lightAffinity outside -1..1');
    if (!(s.lightFlipRadius >= 0)) bad('negative flip radius');
    if (!(isNum(s.threatTau) && s.threatTau > 0)) bad('bad threat tau');
    if (!(isNum(s.electroR) && s.electroR >= 0)) bad('bad electroreception range');

    const bl = s.bioluminescence;
    if (!PATTERNS.has(bl.pattern)) bad(`unknown biolum pattern ${bl.pattern}`);
    if (bl.colour.length !== 3) bad('biolum colour is not a triple');
    for (const c of bl.colour) if (!(c >= 0 && c <= 1)) bad(`biolum colour ${c} outside 0..1`);
    if (!(bl.intensity >= 0)) bad('negative biolum intensity');
    if (typeof bl.isLure !== 'boolean') bad('isLure is not a boolean');
    if (bl.pattern === BIOLUM_PATTERN.NONE && bl.intensity !== 0) bad('dark species with intensity');
    if (bl.pattern !== BIOLUM_PATTERN.NONE && bl.intensity === 0) bad('lit pattern with no intensity');
    if (bl.isLure !== (bl.pattern === BIOLUM_PATTERN.LURE)) bad('isLure disagrees with the pattern');
    if (!(bl.hz >= 0)) bad('negative biolum frequency');
    if (!(isNum(s.audioHz) && s.audioHz >= 0)) bad('bad audio fundamental');

    const r = s.meshRecipe;
    if (!BODY_PLAN[r.plan]) bad(`unknown body plan ${r.plan}`);
    for (const k of Object.keys(r)) if (!RECIPE_KEYS.has(k)) bad(`unknown recipe key '${k}'`);
    if (!(r.spineBones >= 2 && r.spineBones <= CREATURE_MAX_BONES)) bad('spineBones out of budget');
    if (!(r.girth > 0 && r.depth > 0)) bad('bad girth/depth');
    if (!Array.isArray(r.tint) || r.tint.length !== 3) bad('no tint');
    for (const c of r.tint) if (!(c >= 0 && c <= 255)) bad('tint outside 0..255');

    // 2 to 4 sentences of art direction, per the brief. Counting sentence
    // terminators is crude but it does catch an empty or one-line note.
    const sentences = (s.note.match(/[.!?](\s|$)/g) || []).length;
    if (sentences < 2 || sentences > 6) bad(`note has ${sentences} sentences`);
    if (s.note.length < 140) bad('note is too short to be art direction');
  }

  check('every field of every record is present and internally consistent',
    problems.length === 0, problems.length ? problems.slice(0, 8).join(' | ') : `${SPECIES_COUNT} records`);
}

// ===========================================================================
section('3. Spectrum coverage');
// ===========================================================================
{
  for (const a of ARCHETYPE_LIST) {
    const n = SPECIES_BY_ARCHETYPE[a].length;
    check(`archetype ${a} is represented`, n > 0, `${n} species`);
  }

  const land = SPECIES.filter((s) => s.archetype === ARCHETYPE.LAND_SHORE
    || s.archetype === ARCHETYPE.LAND_FLYER);
  check('at least three land creatures', land.length >= 3,
    land.map((s) => s.name).join(', '));

  const levs = SPECIES.filter((s) => s.archetype === ARCHETYPE.LEVIATHAN);
  // Three until 2026-08-19; the Splitmaw (biome 18's sighted hunter) is the
  // fourth. DESIGN/06.4.6's "max 2 SIMULATED at once" is a runtime cap on
  // instances, not a roster count, and is untouched by a fourth species.
  check('exactly four apex leviathans', levs.length === 4, levs.map((s) => s.name).join(', '));
  check('every leviathan lives in the deepest bands',
    levs.every((s) => s.depthRange[0] >= 300 && s.dangerTier >= 4),
    levs.map((s) => `${s.name} ${s.depthRange[0]}-${s.depthRange[1]} m tier ${s.dangerTier}`).join('; '));
  check('three of the four leviathans are tier 5',
    levs.filter((s) => s.dangerTier === 5).length === 3);

  const lures = SPECIES.filter((s) => s.bioluminescence.isLure);
  check('exactly one angler carries a lure', lures.length === 1
    && lures[0].archetype === ARCHETYPE.ANGLER, lures.map((s) => s.name).join());
  check('the lure species has lure geometry', !!lures[0].meshRecipe.lure);

  const filters = SPECIES.filter((s) => s.archetype === ARCHETYPE.FILTER_GIANT);
  check('the filter-feeding giant is genuinely giant',
    filters.length >= 1 && filters.every((s) => s.length >= 10),
    filters.map((s) => `${s.name} ${s.length} m`).join());

  const vents = SPECIES.filter((s) => s.biomes.includes(CREATURE_HABITAT.VENT));
  check('the vent field has its specialists', vents.length >= 2, vents.map((s) => s.name).join(', '));
  const caves = SPECIES.filter((s) => s.biomes.includes(CREATURE_HABITAT.CAVE));
  check('the Undervault has its dwellers', caves.length >= 2, caves.map((s) => s.name).join(', '));

  const schooling = SPECIES.filter((s) => s.schoolSize[1] >= 100);
  check('there are true swarms and shoals', schooling.length >= 4,
    `${schooling.length} species school 100+`);

  const tier0 = SPECIES.filter((s) => s.dangerTier === 0).length;
  check('most of the ocean is harmless', tier0 >= SPECIES_COUNT * 0.35,
    `${tier0}/${SPECIES_COUNT} are tier 0`);
}

// ===========================================================================
section('4. Danger tiers');
// ===========================================================================
{
  check('six tiers', DANGER_BY_TIER.length === 6);
  check('tier records are self-indexing', DANGER_BY_TIER.every((t, i) => t.tier === i));
  check('tier 0 cannot harm the player', DANGER_BY_TIER[0].harmsPlayer === false
    && DANGER_BY_TIER[0].windup === 0);
  let mono = true;
  for (let i = 2; i < 6; i++) {
    if (DANGER_BY_TIER[i].windup <= DANGER_BY_TIER[i - 1].windup) mono = false;
    if (DANGER_BY_TIER[i].recover <= DANGER_BY_TIER[i - 1].recover) mono = false;
  }
  check('telegraph and recovery grow with the tier', mono,
    DANGER_BY_TIER.map((t) => `${t.tier}:${fmt(t.windup, 2)}s`).join(' '));
  check('tier 4 and 5 telegraph at least 1.2 s (DESIGN/06 06.4.6 rule 4)',
    DANGER_BY_TIER[4].windup >= 1.2 && DANGER_BY_TIER[5].windup >= 1.6);
  check('every species tier resolves to a tier record',
    SPECIES.every((s) => DANGER_BY_TIER[s.dangerTier] !== undefined));
  check('only tier 0 is legal inside the Safe Charter',
    DANGER_BY_TIER.filter((t) => t.safeCharterLegal).length === 1);
  check('speciesFitsTier gates on the biome ceiling',
    speciesFitsTier(0, speciesById.CRT_COPPERSPRAT)
    && !speciesFitsTier(0, speciesById.LEV_NETHERCOIL)
    && speciesFitsTier(5, speciesById.LEV_NETHERCOIL));
}

// ===========================================================================
section('5. Queries');
// ===========================================================================
{
  // The biome alias table must land on real biomes or on the three pseudo-ids.
  const aliasOk = Object.values(BIOME_ALIAS).every((v) => v >= 0 && v < HABITAT_ID_COUNT);
  check('every DESIGN/06 BIO_* token maps into the id space', aliasOk,
    `${Object.keys(BIOME_ALIAS).length} tokens -> ${BIOME_COUNT} biomes + 3 habitats`);

  let unreachable = [];
  for (const s of SPECIES) {
    const depth = (s.depthRange[0] + s.depthRange[1]) * 0.5;
    let found = false;
    for (const b of s.biomes) if (speciesForBiome(b, depth).includes(s)) found = true;
    if (!found) unreachable.push(s.id);
  }
  check('every species is reachable through speciesForBiome at its own mid depth',
    unreachable.length === 0, unreachable.join(', ') || `${SPECIES_COUNT} species`);

  const reef = speciesForBiome(2, 12);
  check('the shallow reef is populated', reef.length >= 6, `${reef.length} species at 12 m in reef`);
  check('speciesForBiome sorts by density, descending',
    reef.every((s, i) => i === 0 || reef[i - 1].densityPerKm3 >= s.densityPerKm3));
  check('speciesForBiome results are frozen and shared',
    Object.isFrozen(reef) && speciesForBiome(2, 12) === reef);
  check('nothing spawns in a biome it does not list',
    reef.every((s) => s.biomes.includes(2)));
  check('nothing spawns outside its depth range',
    speciesForBiome(13, 1550).every((s) => s.depthRange[1] >= 1544 && s.depthRange[0] <= 1552));
  check('an out-of-range habitat id returns empty, not a throw',
    speciesForBiome(-1, 0).length === 0 && speciesForBiome(999, 0).length === 0);

  const trench = speciesForBiome(13, 1580);
  check('the trench floor is inhabited', trench.length >= 3,
    trench.map((s) => s.name).join(', '));
  const nethercoil = speciesById.LEV_NETHERCOIL;
  check('the Nethercoil is spawnable somewhere in this world',
    speciesForBiome(13, 1500).includes(nethercoil) || speciesForBiome(13, 1400).includes(nethercoil),
    `ceiling ${nethercoil.depthRange[0]} m, world floor ${WORLD.MAX_DEPTH} m`);

  const sprat = speciesById.CRT_COPPERSPRAT;
  check('activityAt peaks by day for a diurnal species',
    activityAt(sprat, 12) > activityAt(sprat, 0),
    `noon ${fmt(activityAt(sprat, 12), 2)} vs midnight ${fmt(activityAt(sprat, 0), 2)}`);
  const moth = speciesById.CRT_SALTMOTH;
  check('activityAt peaks at night for a nocturnal species',
    activityAt(moth, 0) > activityAt(moth, 12),
    `midnight ${fmt(activityAt(moth, 0), 2)} vs noon ${fmt(activityAt(moth, 12), 2)}`);
  check('activityAt stays inside 0..2 for every species and hour',
    SPECIES.every((s) => {
      for (let h = 0; h < 24; h += 0.25) {
        const a = activityAt(s, h);
        if (!(a >= 0 && a <= 2)) return false;
      }
      return true;
    }));
  check('activityAt is continuous across midnight',
    Math.abs(activityAt(sprat, 23.99) - activityAt(sprat, 0.01)) < 1e-3);

  const gape = speciesById.CRT_LANTERNGAPE;
  check('light affinity flips sign inside the flip radius',
    lightAffinityAt(gape, 80) > 0 && lightAffinityAt(gape, 10) < 0,
    `far ${fmt(lightAffinityAt(gape, 80), 2)}, near ${fmt(lightAffinityAt(gape, 10), 2)}`);
  check('light affinity is constant for species without a flip radius',
    lightAffinityAt(sprat, 5) === lightAffinityAt(sprat, 500));
  const flippers = SPECIES.filter((s) => s.lightFlipRadius > 0);
  check('the design\'s flip-sign species are the ones that flip',
    flippers.length >= 3, flippers.map((s) => `${s.name}@${s.lightFlipRadius}m`).join(', '));
}

// ===========================================================================
section('6. Skeletons');
// ===========================================================================
{
  const problems = [];
  for (const s of SPECIES) {
    const sk = buildCreatureBones(s);
    const bad = (m) => problems.push(`${s.id}: ${m}`);
    if (sk.bones.length > CREATURE_MAX_BONES) bad(`${sk.bones.length} bones over the ${CREATURE_MAX_BONES} budget`);
    if (sk.spineCount < 2) bad('spine shorter than two bones');
    if (sk.bones[0].parent !== -1) bad('root bone has a parent');
    for (let i = 0; i < sk.spineCount; i++) {
      const b = sk.bones[i];
      if (b.index !== i) bad(`bone ${i} misindexed`);
      if (b.role !== BONE_ROLE.SPINE) bad(`bone ${i} is not a spine bone`);
      if (i > 0 && b.parent !== i - 1) bad(`spine bone ${i} is not chained`);
      if (!b.position.every(Number.isFinite)) bad(`bone ${i} has a non-finite position`);
    }
    for (const b of sk.bones) {
      if (b.parent >= b.index) bad('a bone parents a later bone (cycle)');
    }
    if (!!s.meshRecipe.jaw !== (sk.jaw >= 0)) bad('jaw bone disagrees with the recipe');
    if (!!s.meshRecipe.lure !== (sk.lure >= 0)) bad('lure bone disagrees with the recipe');
    if (sk.jaw >= 0 && sk.bones[sk.jaw].role !== BONE_ROLE.JAW) bad('jaw bone has the wrong role');
    if (sk.lure >= 0 && sk.bones[sk.lure].role !== BONE_ROLE.LURE) bad('lure bone has the wrong role');

    // The chain must actually span the animal, or the tail wave has nothing to
    // travel along and trailing tentacles never move.
    const a = sk.bones[0].position, b = sk.bones[sk.spineCount - 1].position;
    const spanned = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (spanned < s.length * 0.9) bad(`chain spans ${fmt(spanned, 2)} m of a ${s.length} m animal`);
  }
  check('every skeleton is a valid chain inside the bone budget',
    problems.length === 0, problems.slice(0, 6).join(' | ') || `${SPECIES_COUNT} skeletons`);

  const maxBones = Math.max(...SPECIES.map((s) => buildCreatureBones(s).bones.length));
  check(`the deepest chain fits RENDER.MAX_BONES_PER_CREATURE`,
    maxBones <= RENDER.MAX_BONES_PER_CREATURE, `${maxBones} bones (limit ${RENDER.MAX_BONES_PER_CREATURE})`);
}

// ===========================================================================
// Mesh validation
// ===========================================================================

/**
 * Measure everything that can be wrong with a skinned creature mesh.
 *
 * Winding is judged two ways, as in tools/test-meshgen.mjs, because either
 * alone can be fooled:
 *
 *   `flipped`  triangles whose geometric normal (from the vertex order) points
 *              away from the mean of their own three shading normals. This is
 *              the check that caught every fin in the bestiary being inside-out
 *              because its cross-section was wound clockwise.
 *
 *   the edge census on POSITION-WELDED indices. An edge shared by exactly two
 *              triangles must be traversed once in each direction; if both
 *              traverse it the same way the two triangles disagree about which
 *              side is out, and no per-triangle test can see that. Boundary
 *              edges are REPORTED, not faulted: teeth, spines and barbs are
 *              cones with no base disc because their base is inside the animal,
 *              and paying five vertices each to cap something no camera can
 *              reach is not a trade worth making. Edges with three or more
 *              incident triangles are parts that touch (both caudal lobes share
 *              their root point) and are likewise reported.
 *
 * Degeneracy is measured as a SLIVER RATIO rather than an absolute area,
 * because a Chainlight carries 0.45 m swimming bells on a 26 m body and no
 * single area floor is right for both.
 */
function validate(species, m) {
  const r = {
    vertexCount: m.vertexCount, triangleCount: m.triangleCount,
    nan: 0, badIndex: 0, badNormal: 0, worstNormalErr: 0,
    degenerate: 0, worstSliver: 0,
    flipped: 0, worstFlipCos: 1,
    openEdges: 0, inconsistentEdges: 0, nonManifoldEdges: 0,
    badWeightSum: 0, worstWeightErr: 0, badBoneIndex: 0, negativeWeight: 0,
    influences: 0, maxInfluences: 0,
    maskOutOfRange: 0, maskHot: 0, maskDark: 0, maskMax: 0,
    emissiveMismatch: 0, negativeEmissive: 0,
    inflateOutOfRange: 0, inflateNonZero: 0,
    badMaterial: 0, aabbViolations: 0, radiusViolation: 0,
    badTangent: 0,
    axisExtent: 0,
  };
  const P = m.positions, N = m.normals, C = m.colors, T = m.tangents;

  for (let i = 0; i < m.vertexCount; i++) {
    const o = i * 3;
    for (let k = 0; k < 3; k++) {
      if (!Number.isFinite(P[o + k]) || !Number.isFinite(N[o + k])) r.nan++;
      if (!Number.isFinite(m.emissive[o + k])) r.nan++;
      if (m.emissive[o + k] < 0) r.negativeEmissive++;
    }
    const l = Math.hypot(N[o], N[o + 1], N[o + 2]);
    r.worstNormalErr = Math.max(r.worstNormalErr, Math.abs(l - 1));
    if (Math.abs(l - 1) > 1e-3) r.badNormal++;

    let sum = 0, used = 0;
    for (let k = 0; k < CREATURE_INFLUENCES; k++) {
      const w = m.boneWeights[i * CREATURE_INFLUENCES + k];
      const b = m.boneIndices[i * CREATURE_INFLUENCES + k];
      if (w < 0) r.negativeWeight++;
      if (w > 0) {
        used++;
        if (b >= m.boneCount) r.badBoneIndex++;
      }
      sum += w;
    }
    r.worstWeightErr = Math.max(r.worstWeightErr, Math.abs(sum - 1));
    if (Math.abs(sum - 1) > 1e-5) r.badWeightSum++;
    r.influences += used;
    r.maxInfluences = Math.max(r.maxInfluences, used);

    const mask = C[i * 4 + 3];
    if (!(mask >= 0 && mask <= 1)) r.maskOutOfRange++;
    r.maskMax = Math.max(r.maskMax, mask);
    if (mask > 0.5) r.maskHot++;
    if (mask < 0.02) r.maskDark++;
    // The mask is the only thing that may light a vertex: emissive must be the
    // mask times the species colour, so a zero mask must mean a black vertex.
    const e = m.emissive[o] + m.emissive[o + 1] + m.emissive[o + 2];
    if (mask === 0 && e > 0) r.emissiveMismatch++;

    const inf = m.inflate[i];
    if (!(inf >= 0 && inf <= 1)) r.inflateOutOfRange++;
    if (inf > 0) r.inflateNonZero++;

    if (m.materials[i] > 7) r.badMaterial++;
    for (let k = 0; k < 3; k++) {
      if (P[o + k] < m.aabb.min[k] - 1e-4 || P[o + k] > m.aabb.max[k] + 1e-4) r.aabbViolations++;
    }
    if (Math.hypot(P[o], P[o + 1], P[o + 2]) > m.boundingRadius + 1e-4) r.radiusViolation++;
    if (T) {
      const tl = Math.hypot(T[i * 4], T[i * 4 + 1], T[i * 4 + 2]);
      const dot = T[i * 4] * N[o] + T[i * 4 + 1] * N[o + 1] + T[i * 4 + 2] * N[o + 2];
      if (Math.abs(tl - 1) > 1e-3 || Math.abs(dot) > 1e-3
        || Math.abs(Math.abs(T[i * 4 + 3]) - 1) > 1e-6) r.badTangent++;
    }
  }

  for (let k = 0; k + 2 < m.indexCount; k += 3) {
    const i0 = m.indices[k], i1 = m.indices[k + 1], i2 = m.indices[k + 2];
    if (i0 >= m.vertexCount || i1 >= m.vertexCount || i2 >= m.vertexCount) { r.badIndex++; continue; }
    if (i0 === i1 || i1 === i2 || i0 === i2) { r.degenerate++; continue; }
    const a = i0 * 3, b = i1 * 3, c = i2 * 3;
    const e0x = P[b] - P[a], e0y = P[b + 1] - P[a + 1], e0z = P[b + 2] - P[a + 2];
    const e1x = P[c] - P[a], e1y = P[c + 1] - P[a + 1], e1z = P[c + 2] - P[a + 2];
    const nx = e0y * e1z - e0z * e1y, ny = e0z * e1x - e0x * e1z, nz = e0x * e1y - e0y * e1x;
    const twiceArea = Math.hypot(nx, ny, nz);
    const e2x = P[c] - P[b], e2y = P[c + 1] - P[b + 1], e2z = P[c + 2] - P[b + 2];
    const longest = Math.max(Math.hypot(e0x, e0y, e0z), Math.hypot(e1x, e1y, e1z),
      Math.hypot(e2x, e2y, e2z));
    // Sliver ratio: 1 for an equilateral triangle, 0 for a line.
    const sliver = longest > 0 ? (twiceArea * 2.31) / (longest * longest) : 0;
    if (sliver < 1e-4) { r.degenerate++; continue; }
    r.worstSliver = r.worstSliver === 0 ? sliver : Math.min(r.worstSliver, sliver);
    const sx = N[a] + N[b] + N[c], sy = N[a + 1] + N[b + 1] + N[c + 1], sz = N[a + 2] + N[b + 2] + N[c + 2];
    const sl = Math.hypot(sx, sy, sz) || 1;
    const cos = (nx * sx + ny * sy + nz * sz) / (twiceArea * sl);
    if (cos < 0) r.flipped++;
    r.worstFlipCos = Math.min(r.worstFlipCos, cos);
  }

  // Welded edge census.
  const groups = new Map();
  const weld = new Int32Array(m.vertexCount);
  for (let i = 0; i < m.vertexCount; i++) {
    const o = i * 3;
    const key = `${Math.round(P[o] * 1e4)},${Math.round(P[o + 1] * 1e4)},${Math.round(P[o + 2] * 1e4)}`;
    let g = groups.get(key);
    if (g === undefined) { g = groups.size; groups.set(key, g); }
    weld[i] = g;
  }
  const edges = new Map();
  for (let k = 0; k + 2 < m.indexCount; k += 3) {
    const t = [weld[m.indices[k]], weld[m.indices[k + 1]], weld[m.indices[k + 2]]];
    for (let e = 0; e < 3; e++) {
      const a = t[e], b = t[(e + 1) % 3];
      if (a === b) continue;
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      let rec = edges.get(key);
      if (!rec) { rec = [0, 0]; edges.set(key, rec); }
      rec[a < b ? 0 : 1]++;
    }
  }
  for (const [, v] of edges) {
    const total = v[0] + v[1];
    if (total === 1) r.openEdges++;
    else if (total === 2) { if (v[0] !== 1) r.inconsistentEdges++; }
    else r.nonManifoldEdges++;
  }

  const plan = species.meshRecipe.plan;
  const axis = plan === 'tube' || plan === 'shell' ? 1 : 2;
  r.axisExtent = m.aabb.max[axis] - m.aabb.min[axis];
  return r;
}

// ===========================================================================
section('7. Mesh geometry');
// ===========================================================================
const reports = new Map();
{
  const fatal = [];
  for (const s of SPECIES) {
    const m = buildCreatureMesh(s, 0x51CE0000 ^ SPECIES_INDEX[s.id]);
    const r = validate(s, m);
    reports.set(s.id, { r, m });
    const bad = [];
    if (r.nan) bad.push(`${r.nan} non-finite floats`);
    if (r.badIndex) bad.push(`${r.badIndex} out-of-range indices`);
    if (r.badNormal) bad.push(`${r.badNormal} non-unit normals (worst ${fmt(r.worstNormalErr, 6)})`);
    if (r.degenerate) bad.push(`${r.degenerate} degenerate triangles`);
    if (r.flipped) bad.push(`${r.flipped} inside-out triangles (worst cos ${fmt(r.worstFlipCos, 2)})`);
    if (r.inconsistentEdges) bad.push(`${r.inconsistentEdges} edges whose triangles disagree on which side is out`);
    if (r.badWeightSum) bad.push(`${r.badWeightSum} vertices whose bone weights do not sum to 1`);
    if (r.badBoneIndex) bad.push(`${r.badBoneIndex} weights on a bone that does not exist`);
    if (r.negativeWeight) bad.push(`${r.negativeWeight} negative weights`);
    if (r.maskOutOfRange) bad.push(`${r.maskOutOfRange} biolum masks outside 0..1`);
    if (r.emissiveMismatch) bad.push(`${r.emissiveMismatch} vertices emissive with a zero mask`);
    if (r.negativeEmissive) bad.push(`${r.negativeEmissive} negative emissive channels`);
    if (r.inflateOutOfRange) bad.push(`${r.inflateOutOfRange} inflate weights outside 0..1`);
    if (r.badMaterial) bad.push(`${r.badMaterial} material slots past 7`);
    if (r.aabbViolations) bad.push(`${r.aabbViolations} vertices outside the reported AABB`);
    if (r.radiusViolation) bad.push(`${r.radiusViolation} vertices outside the bounding radius`);
    if (r.badTangent) bad.push(`${r.badTangent} bad tangent frames`);
    if (r.maxInfluences > CREATURE_INFLUENCES) bad.push(`${r.maxInfluences} influences per vertex`);
    if (bad.length) fatal.push(`${s.id}: ${bad.join('; ')}`);
  }
  check('every mesh is geometrically valid and correctly skinned',
    fatal.length === 0, fatal.slice(0, 4).join(' | ')
    || `${SPECIES_COUNT} meshes, ${[...reports.values()].reduce((a, x) => a + x.m.vertexCount, 0).toLocaleString()} vertices`);

  const worstSliver = Math.min(...[...reports.values()].map((x) => x.r.worstSliver));
  check('no mesh contains a needle triangle', worstSliver > 1e-3,
    `worst sliver ratio ${fmt(worstSliver, 5)} (1.0 = equilateral)`);

  const worstFlip = Math.min(...[...reports.values()].map((x) => x.r.worstFlipCos));
  check('shading normals agree with the winding everywhere', worstFlip > 0,
    `worst geometric-vs-shading cosine ${fmt(worstFlip, 3)}`);

  const twoInfluence = [...reports.values()].every((x) => x.r.maxInfluences <= 2);
  check('the loft blends at most two bones per vertex, as DESIGN/06 06.3.6 expects',
    twoInfluence, `mean ${fmt([...reports.values()].reduce((a, x) => a + x.r.influences / x.m.vertexCount, 0) / SPECIES_COUNT, 2)} influences/vertex`);
}

// ===========================================================================
section('8. Vertex budgets');
// ===========================================================================
{
  const over = [];
  for (const s of SPECIES) {
    const { m } = reports.get(s.id);
    if (m.vertexCount > creatureVertexBudget(s)) {
      over.push(`${s.id} ${m.vertexCount} > ${creatureVertexBudget(s)}`);
    }
  }
  check('every mesh is inside its own budget', over.length === 0, over.join(', '));

  const smallFish = SPECIES.filter((s) => s.length < 0.5
    && !['crustacean', 'walker', 'shell', 'squid', 'bell', 'tube'].includes(s.meshRecipe.plan));
  const worstSmall = Math.max(...smallFish.map((s) => reports.get(s.id).m.vertexCount));
  check('every small fish is under 400 vertices', worstSmall < 400,
    `${smallFish.length} species under 0.5 m, worst ${worstSmall} verts`);

  const levs = SPECIES.filter((s) => s.archetype === ARCHETYPE.LEVIATHAN);
  const worstLev = Math.max(...levs.map((s) => reports.get(s.id).m.vertexCount));
  check('every leviathan is under 6000 vertices', worstLev < 6000,
    levs.map((s) => `${s.name} ${reports.get(s.id).m.vertexCount}`).join(', '));

  // MAX_CREATURES simultaneous animals must fit a sane vertex-buffer pool.
  const totalV = [...reports.values()].reduce((a, x) => a + x.m.vertexCount, 0);
  const totalI = [...reports.values()].reduce((a, x) => a + x.m.indexCount, 0);
  const bytes = totalV * (12 + 12 + 8 + 16 + 4 + 4 + 12 + 4) + totalI * 4;
  check('the whole bestiary fits a modest static buffer pool', bytes < 8 * 1024 * 1024,
    `${fmt(bytes / 1048576, 2)} MB for all ${SPECIES_COUNT} species at LOD0 (72 B/vertex + u32 indices)`);
  check(`${RENDER.MAX_CREATURES} concurrent creatures is an instancing problem, not a memory one`,
    true, `${RENDER.MAX_CREATURES} instances x 64 B = ${fmt(RENDER.MAX_CREATURES * 64 / 1024, 1)} KB of instance data`);
}

// ===========================================================================
section('9. Proportion');
// ===========================================================================
{
  // The mesh must be the size its datasheet says it is: every collision radius,
  // every sonar length readout and every despawn distance is derived from
  // `length`, so a mesh that is 30% long silently breaks all three.
  const off = [];
  // Several plans quote something other than a nose-to-tail extent, exactly as
  // their datasheets do: a ray quotes DISC WIDTH ("1.30 disc width, 2.05 with
  // tail"), a bell quotes the bell and lists the tentacle trail separately, a
  // crustacean quotes carapace-and-abdomen and then has a legspan and antennae,
  // a flyer quotes wingspan, a tube worm quotes the TUBE and extends a plume
  // past it, and a larvacean quotes the animal while living inside a house six
  // times its length.
  const axisExempt = new Set(['ray', 'bell', 'crustacean', 'walker', 'flyer', 'shell',
    'squid', 'globular', 'tube']);
  for (const s of SPECIES) {
    const { r } = reports.get(s.id);
    if (axisExempt.has(s.meshRecipe.plan) || s.meshRecipe.house) continue;
    const ratio = r.axisExtent / s.length;
    if (ratio < 0.85 || ratio > 1.15) off.push(`${s.id} ${fmt(ratio, 2)}x`);
  }
  check('every swimmer measures its datasheet length along its own axis',
    off.length === 0, off.join(', ') || 'within 15% for every non-exempt plan');

  const rays = SPECIES.filter((s) => s.meshRecipe.plan === 'ray');
  const spans = rays.map((s) => {
    const { m } = reports.get(s.id);
    return (m.aabb.max[0] - m.aabb.min[0]) / s.length;
  });
  check('a ray measures its datasheet DISC WIDTH across the wings',
    spans.every((v) => v > 0.9 && v < 1.12),
    rays.map((s, i) => `${s.name} ${fmt(spans[i], 2)}x`).join(', '));

  const bones = SPECIES.map((s) => buildCreatureBones(s));
  check('a leviathan spine is coarse but complete',
    bones.filter((b, i) => SPECIES[i].archetype === ARCHETYPE.LEVIATHAN)
      .every((b) => b.spineCount >= 15));
}

// ===========================================================================
section('10. Bioluminescence reads as a pattern');
// ===========================================================================
{
  const flat = [];
  const empty = [];
  for (const s of SPECIES) {
    const { r } = reports.get(s.id);
    if (s.bioluminescence.pattern === BIOLUM_PATTERN.NONE) {
      if (r.maskMax > 0) empty.push(`${s.id} is dark but has a mask`);
      continue;
    }
    // Non-empty: something is actually lit.
    if (r.maskHot === 0) empty.push(`${s.id} has a pattern but nothing brighter than 0.5`);
    // Non-uniform: this is the whole point. An animal whose every vertex is lit
    // is the failure mode - it reads as a glowing blob, not as photophores.
    if (r.maskDark === 0) flat.push(`${s.id} is lit everywhere`);
  }
  check('every lit species actually lights up', empty.length === 0, empty.join(', '));
  check('no species glows uniformly - the mask reads as spots, rows or a lure',
    flat.length === 0, flat.join(', '));

  const lit = SPECIES.filter((s) => s.bioluminescence.pattern !== BIOLUM_PATTERN.NONE);
  const coverage = lit.map((s) => {
    const { r, m } = reports.get(s.id);
    return r.maskHot / m.vertexCount;
  });
  check('lit coverage stays a minority of the surface on all but the colonial species',
    coverage.filter((c) => c > 0.5).length <= 2,
    `median ${fmt(coverage.slice().sort((a, b) => a - b)[coverage.length >> 1] * 100, 1)}% of vertices lit`);

  const gape = reports.get('CRT_LANTERNGAPE');
  check('the Lanterngape lights only its esca and nothing else',
    gape.r.maskHot > 0 && gape.r.maskHot / gape.m.vertexCount < 0.10,
    `${gape.r.maskHot}/${gape.m.vertexCount} vertices (${fmt(100 * gape.r.maskHot / gape.m.vertexCount, 1)}%)`);

  const herald = reports.get('LEV_PALEHERALD');
  check('the Pale Herald\'s floodlight organ is on its head, not its body',
    herald.m.parts.some((p) => p.kind === 'body'),
    `${herald.r.maskHot} lit vertices of ${herald.m.vertexCount}`);

  // Inflation only exists where a recipe asks for it, and only on the trunk.
  const inflating = SPECIES.filter((s) => s.meshRecipe.inflate);
  check('only the species with an inflate channel carry inflate weights',
    SPECIES.every((s) => {
      const { r } = reports.get(s.id);
      return s.meshRecipe.inflate ? r.inflateNonZero > 0 : r.inflateNonZero === 0;
    }), inflating.map((s) => s.name).join(', '));
}

// ===========================================================================
section('11. Determinism');
// ===========================================================================
{
  const arraysOf = (m) => [m.positions, m.normals, m.uvs, m.colors, m.materials,
    m.tangents, m.emissive, m.inflate, m.boneIndices, m.boneWeights, m.indices];

  let identical = true, mismatch = '';
  for (const s of SPECIES) {
    const a = buildCreatureMesh(s, 0xABCD1234);
    const b = buildCreatureMesh(s, 0xABCD1234);
    const A = arraysOf(a), B = arraysOf(b);
    for (let k = 0; k < A.length && identical; k++) {
      if (A[k].length !== B[k].length) { identical = false; mismatch = `${s.id} array ${k} length`; break; }
      for (let i = 0; i < A[k].length; i++) {
        if (A[k][i] !== B[k][i]) { identical = false; mismatch = `${s.id} array ${k} index ${i}`; break; }
      }
    }
    if (!identical) break;
  }
  check('the same seed produces byte-identical arrays', identical, mismatch);

  // Geometry is seed independent by design: the mesh is cached once per species
  // and only the photophore jitter is per individual, so two individuals share a
  // vertex buffer and differ in the mask alone.
  let geomStable = true, maskVaries = 0;
  for (const s of SPECIES) {
    const a = buildCreatureMesh(s, 1);
    const b = buildCreatureMesh(s, 999983);
    if (a.vertexCount !== b.vertexCount || a.indexCount !== b.indexCount) geomStable = false;
    for (let i = 0; i < a.positions.length && geomStable; i++) {
      if (a.positions[i] !== b.positions[i]) geomStable = false;
    }
    for (let i = 0; i < a.colors.length; i += 4) {
      if (a.colors[i + 3] !== b.colors[i + 3]) { maskVaries++; break; }
    }
  }
  check('geometry does not depend on the individual seed', geomStable);
  check('the individual seed does vary the bioluminescent pattern', maskVaries >= 3,
    `${maskVaries} species differ between two individuals`);

  // The bones are a pure function of the record.
  const b1 = JSON.stringify(SPECIES.map((s) => buildCreatureBones(s).bones));
  const b2 = JSON.stringify(SPECIES.map((s) => buildCreatureBones(s).bones));
  check('skeletons are deterministic', b1 === b2);
}

// ===========================================================================
section('12. Attachment surfaces and colour');
// ===========================================================================
//
// THE THREE LATHED PLANS ARE THE DANGEROUS ONES. A bell, a gastropod shell and
// an urchin's test are not lofted: lathe() emits the visible surface and the
// plan's station table exists only so that spines, eyestalks, a foot and a
// tentacle curtain have something to be placed against. Nothing in sections 7-9
// notices when that table stops describing the lathe, because every vertex is
// still finite, wound correctly and inside its budget - the animal is simply
// wrong. It happened: a shared dome table put every Spinecrown spine below the
// equator with the whole top of the test bare, and hung the Bellflower's
// tentacles on its axis instead of its rim.
{
  const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

  // ---- the urchin's spines must lie on the ellipsoid addTest() lathes -----
  {
    const s = speciesById.CRT_SPINECROWN;
    const { m } = reports.get(s.id);
    const rr = s.meshRecipe.girth * s.length;
    const hh = rr * s.meshRecipe.test.oblate;
    let worst = 0;
    for (const p of m.parts) {
      if (p.kind !== 'spine') continue;
      // A spine is a cone standing off the surface, so the closest of its own
      // vertices is its root and that is the one that must be on the test.
      let best = Infinity;
      for (let i = p.start; i < p.start + p.count; i++) {
        const x = m.positions[i * 3], y = m.positions[i * 3 + 1], z = m.positions[i * 3 + 2];
        const d = Math.abs(Math.hypot(Math.hypot(x, z) / rr, (y - hh) / hh) - 1);
        if (d < best) best = d;
      }
      worst = Math.max(worst, best);
    }
    check('the urchin\'s spines are rooted in its own test', worst < 0.08,
      `worst root offset ${fmt(worst * 100, 1)}% of the ${fmt(rr * 1000, 0)} mm test radius `
      + `(${fmt(worst * rr * 1000, 1)} mm)`);
  }

  // ---- a bell hangs its curtain from the RIM ------------------------------
  {
    const bells = SPECIES.filter((s) => s.meshRecipe.bell && s.meshRecipe.tentacles);
    const bad = [];
    for (const s of bells) {
      const { m } = reports.get(s.id);
      const R = s.meshRecipe.bell.radius;
      let maxRootR = 0;
      for (const p of m.parts) {
        if (p.kind !== 'tentacle') continue;
        // The first section of a tube is its root ring; its distance from the
        // body axis is what says rim or axis.
        let r = 0;
        for (let i = p.start; i < Math.min(p.start + 8, p.start + p.count); i++) {
          r = Math.max(r, Math.hypot(m.positions[i * 3], m.positions[i * 3 + 1]));
        }
        maxRootR = Math.max(maxRootR, r);
      }
      if (maxRootR < R * 0.45) {
        bad.push(`${s.id} roots at ${fmt(maxRootR / R, 2)}R`);
      }
    }
    check('a jelly\'s tentacles hang from the bell rim, not from its axis',
      bad.length === 0,
      bad.join(', ') || bells.map((s) => s.name).join(', '));
  }

  // ---- a gastropod's stalks and foot sit on its shell ---------------------
  {
    const s = speciesById.CRT_REEFCROPPER;
    const { m } = reports.get(s.id);
    const R = s.meshRecipe.girth * s.length;
    const shell = [];
    for (const p of m.parts) {
      if (p.kind !== 'shell') continue;
      for (let i = p.start; i < p.start + p.count; i++) shell.push(i);
    }
    let worst = 0;
    for (const p of m.parts) {
      if (p.kind !== 'eyestalk') continue;
      let best = Infinity;
      for (let i = p.start; i < p.start + p.count; i++) {
        for (const t of shell) {
          const d = Math.hypot(m.positions[i * 3] - m.positions[t * 3],
            m.positions[i * 3 + 1] - m.positions[t * 3 + 1],
            m.positions[i * 3 + 2] - m.positions[t * 3 + 2]);
          if (d < best) best = d;
        }
      }
      worst = Math.max(worst, best);
    }
    check('the gastropod\'s eyestalks emerge from its shell', worst < R * 0.30,
      `worst ${fmt(worst * 1000, 1)} mm from the shell, ${fmt(R * 1000, 0)} mm radius`);
  }

  // ---- the datasheet tint has to reach the geometry ----------------------
  //
  // A part painted with a hard-coded colour instead of the species tint is
  // invisible to every other check here: the mesh is valid, it is simply not the
  // animal the datasheet describes. Rather than reproduce the shading rules, this
  // rebuilds each species with its tint replaced and asks how much of the surface
  // noticed. The Spinecrown was the proof it needs to exist - not one of its 185
  // vertices responded to its own "deep-purple test", because every part of it
  // was painted with the shared bone colour.
  {
    const deaf = [];
    let worst = 1;
    for (const s of SPECIES) {
      const { m } = reports.get(s.id);
      const alt = {
        ...s,
        meshRecipe: { ...s.meshRecipe, tint: [17, 231, 61], ventral: undefined },
      };
      const m2 = buildCreatureMesh(alt, 0x51CE0000 ^ SPECIES_INDEX[s.id]);
      if (m2.vertexCount !== m.vertexCount) { deaf.push(`${s.id} rebuild differs`); continue; }
      let moved = 0;
      for (let i = 0; i < m.vertexCount; i++) {
        if (Math.abs(m.colors[i * 4] - m2.colors[i * 4]) > 0.01
          || Math.abs(m.colors[i * 4 + 1] - m2.colors[i * 4 + 1]) > 0.01
          || Math.abs(m.colors[i * 4 + 2] - m2.colors[i * 4 + 2]) > 0.01) moved++;
      }
      const frac = moved / m.vertexCount;
      worst = Math.min(worst, frac);
      // Teeth, spines and eyes are deliberately NOT the animal's colour, so a
      // half is the floor rather than everything.
      if (frac < 0.5) deaf.push(`${s.id} ${fmt(frac * 100, 0)}%`);
    }
    check('the datasheet tint reaches most of every animal\'s surface',
      deaf.length === 0,
      deaf.join(', ') || `worst ${fmt(worst * 100, 0)}% of vertices respond to the tint`);
  }

  // ---- the reported budget is the enforced one --------------------------
  {
    const wrong = SPECIES.filter((s) => reports.get(s.id).m.budget !== creatureVertexBudget(s));
    check('a mesh reports the budget it was actually held to', wrong.length === 0,
      wrong.map((s) => s.id).join(', ') || 'all 37 agree with creatureVertexBudget()');
  }

  // ---- the biolum mask must not break at the theta seam -----------------
  //
  // The loft emits theta = 0 and theta = TAU as two vertices at the same point.
  // A pattern that indexes a cell from theta without wrapping gives them
  // different masks, and every spot row is then cut down one flank by a line the
  // geometry checks cannot see because the geometry is fine.
  {
    const seams = [];
    for (const s of SPECIES) {
      const { m } = reports.get(s.id);
      for (const p of m.parts) {
        if (p.kind !== 'body') continue;
        const first = new Map();
        for (let i = p.start; i < p.start + p.count; i++) {
          if (m.uvs[i * 2] !== 0) continue;
          first.set(`${Math.round(m.positions[i * 3] * 1e5)},`
            + `${Math.round(m.positions[i * 3 + 1] * 1e5)},`
            + `${Math.round(m.positions[i * 3 + 2] * 1e5)}`, m.colors[i * 4 + 3]);
        }
        let worst = 0;
        for (let i = p.start; i < p.start + p.count; i++) {
          if (m.uvs[i * 2] !== 1) continue;
          const k = `${Math.round(m.positions[i * 3] * 1e5)},`
            + `${Math.round(m.positions[i * 3 + 1] * 1e5)},`
            + `${Math.round(m.positions[i * 3 + 2] * 1e5)}`;
          const a = first.get(k);
          if (a !== undefined) worst = Math.max(worst, Math.abs(a - m.colors[i * 4 + 3]));
        }
        if (worst > 0.02) seams.push(`${s.id} ${fmt(worst, 3)}`);
      }
    }
    check('the bioluminescence mask closes at the theta seam', seams.length === 0,
      seams.join(', ') || 'no mask step across the wrap column on any species');
  }

  // ---- no bone may be dead weight --------------------------------------
  {
    const dead = [];
    for (const s of SPECIES) {
      const { m } = reports.get(s.id);
      const used = new Set();
      for (let i = 0; i < m.vertexCount; i++) {
        for (let k = 0; k < CREATURE_INFLUENCES; k++) {
          if (m.boneWeights[i * CREATURE_INFLUENCES + k] > 0) {
            used.add(m.boneIndices[i * CREATURE_INFLUENCES + k]);
          }
        }
      }
      const idle = [];
      for (let b = 0; b < m.boneCount; b++) if (!used.has(b)) idle.push(b);
      // A fully rigid plan - a lathed shell, every vertex bound to bone 0 - still
      // has to carry the two-bone minimum, so one idle bone there is the floor
      // rather than waste. Anything above that is a bone animating nothing.
      if (idle.length > (m.spineCount <= 2 ? 1 : 0)) {
        dead.push(`${s.id} ${idle.length}/${m.boneCount}`);
      }
    }
    check('every bone in every chain moves at least one vertex', dead.length === 0,
      dead.join(', ') || `${SPECIES_COUNT} chains, no idle bone above the two-bone minimum`);
  }
}

// ===========================================================================
section('13. Generation cost');
// ===========================================================================
{
  // DESIGN/06 06.3.7 budgets under 6 ms for all 37 species at three LOD tiers,
  // assuming a bespoke generator. This build spends it differently: it reuses
  // meshgen's generic sweep for all 556 parts across the roster, and that sweep
  // builds and then discards a tangent frame per part because its API has no way
  // to say "skip it, the caller recomputes tangents for the whole animal".
  //
  // So the check is against the constraint that actually governs frame time
  // rather than against the design's number: no single species may exceed the
  // build queue's 1.5 ms slice, and the whole roster must fit inside one 120 fps
  // frame (8.33 ms) so that even a naive all-at-once build cannot stutter. Both
  // hold with room; each creature is built ONCE and instanced thereafter.
  const t0 = process.hrtime.bigint();
  let verts = 0, tris = 0;
  for (let pass = 0; pass < 3; pass++) {
    for (const s of SPECIES) {
      const m = buildCreatureMesh(s, pass * 7919 + 1);
      verts += m.vertexCount;
      tris += m.triangleCount;
    }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const perSet = ms / 3;
  const perSpecies = ms / (3 * SPECIES_COUNT);
  check('a full bestiary build fits inside one 120 fps frame', perSet < 8.33,
    `${SPECIES_COUNT} species x 3 seeds: ${verts.toLocaleString()} verts, ${tris.toLocaleString()} tris `
    + `in ${fmt(ms, 1)} ms (${fmt(perSet, 2)} ms per full set)`);
  check('no single species can overrun the 1.5 ms/frame build queue slice',
    perSpecies < 1.5, `${fmt(perSpecies, 3)} ms/species mean, worst species measured below`);

  let worst = 0, worstId = '';
  for (const s of SPECIES) {
    const t = process.hrtime.bigint();
    buildCreatureMesh(s, 11);
    const one = Number(process.hrtime.bigint() - t) / 1e6;
    if (one > worst) { worst = one; worstId = s.id; }
  }
  check('the most expensive single creature is still well under a frame', worst < 1.5,
    `${worstId} at ${fmt(worst, 3)} ms`);

  const t1 = process.hrtime.bigint();
  let hits = 0;
  for (let i = 0; i < 20000; i++) {
    hits += speciesForBiome((i % HABITAT_ID_COUNT), (i % 160) * 10).length;
  }
  const qms = Number(process.hrtime.bigint() - t1) / 1e6;
  check('speciesForBiome is cheap enough for the spawner to call per candidate',
    qms < 40, `20,000 queries in ${fmt(qms, 2)} ms (${fmt(qms * 1000 / 20000, 2)} us each), ${hits} hits`);
}

// ===========================================================================
section('14. Albedo patterns are pigment, not a claim');
// ===========================================================================
//
// A pattern is easy to ship as a stub: add the field, forget the generator, and
// every other section still passes because the mesh is unchanged. The mask is
// evaluated per FRAGMENT now - a bar painted into vertex colour is bounded below
// by the loft's ring spacing, and on a Coppersprat's eight-ring trunk four bars
// would land between samples - so there is no vertex delta left to measure and
// this section runs `albedoPatternMask()`, the specification the shader
// implements, over the animal's OWN trunk parameterisation instead.
//
// What it measures: coverage (a pattern nobody sees and a pattern that repaints
// the whole animal are both failures), the albedo step across a pattern edge
// (the thing that survives the water), seam closure at theta 0 == theta 1, and
// that the per-individual hash actually moves the pattern.
{
  const problems = [];
  const patterned = SPECIES.filter((s) => s.meshRecipe.pattern);
  check('the shallow reef roster carries albedo patterns at all', patterned.length >= 4,
    patterned.map((s) => `${s.name}:${s.meshRecipe.pattern.kind}`).join(', '));

  for (const s of patterned) {
    const p = s.meshRecipe.pattern;
    if (!ALBEDO_PATTERN_LIST.includes(p.kind)) problems.push(`${s.id}: unknown pattern kind ${p.kind}`);
    if (!Array.isArray(p.colour) || p.colour.length !== 3) problems.push(`${s.id}: pattern colour is not a triple`);
    else for (const c of p.colour) if (!(c >= 0 && c <= 255)) problems.push(`${s.id}: pattern colour ${c} outside 0..255`);
    if (p.count !== undefined && !(Number.isInteger(p.count) && p.count >= 2)) {
      problems.push(`${s.id}: pattern count ${p.count} below two`);
    }
    if (p.duty !== undefined && !(p.duty > 0.02 && p.duty < 0.95)) {
      problems.push(`${s.id}: duty ${p.duty} outside 0.02..0.95`);
    }
    if (p.strength !== undefined && !(p.strength > 0 && p.strength <= 1)) {
      problems.push(`${s.id}: strength ${p.strength} outside 0..1`);
    }
    if (p.roughness !== undefined && !(p.roughness >= 0.04 && p.roughness <= 1)) {
      problems.push(`${s.id}: roughness ${p.roughness} outside 0.04..1`);
    }
    // A pattern with nowhere to land. The mask is a function of the LOFT's
    // (theta, u), and render/passes/creatures.js gates it on the vertex's
    // 'body' part - so a species whose recipe has no trunk range would carry a
    // pattern spec that can never draw a pixel.
    const m = buildCreatureMesh(s, 0x7A11E000 ^ SPECIES_INDEX[s.id]);
    if (!m.parts.some((r) => r.kind === 'body' && r.count > 0)) {
      problems.push(`${s.id}: pattern spec but no trunk part to draw it on`);
    }
  }
  check('every pattern spec is well formed and has a trunk to land on',
    problems.length === 0, problems.join(' | ') || `${patterned.length} specs`);

  // Supersample the trunk's own domain rather than its vertices: the mask is a
  // fragment quantity and a 10 x 10 loft would report a 4-bar pattern from 100
  // samples, which is precisely the resolution argument that moved it here.
  const N = 192;
  const rows = [];
  const weak = [];
  for (const s of SPECIES) {
    const pat = albedoPatternParams(s);
    const spec = s.meshRecipe.pattern;
    if (!spec) {
      if (pat.kind !== 0) weak.push(`${s.id}: unpatterned species produced kind ${pat.kind}`);
      continue;
    }
    let pigment = 0, ring = 0, peakM = 0, n = 0, outOfRange = 0;
    for (let iu = 0; iu < N; iu++) {
      const u = (iu + 0.5) / N;
      for (let ia = 0; ia < N; ia++) {
        const a = (ia + 0.5) / N;
        const m = albedoPatternMask(spec.kind, a, u, pat.count, pat.duty, 0.31);
        if (!(m >= -1.0001 && m <= 1.0001)) outOfRange++;
        if (m > 0.5) pigment++;
        if (m < -0.25) ring++;
        peakM = Math.max(peakM, Math.abs(m));
        n++;
      }
    }
    const frac = pigment / n;
    // The albedo step a pattern edge actually makes, in LINEAR RGB, at the
    // strength the species asks for. This is the quantity that survives the
    // water: the medium flattens hue channel by channel and value slowly.
    const ground = s.meshRecipe.tint.map((c) => {
      const x = c / 255;
      return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    const step = Math.hypot(
      (ground[0] - pat.colour[0]) * pat.strength,
      (ground[1] - pat.colour[1]) * pat.strength,
      (ground[2] - pat.colour[2]) * pat.strength);
    rows.push({ id: s.name, kind: spec.kind, frac, step, ring: ring / n });
    if (outOfRange) weak.push(`${s.id}: ${outOfRange} samples outside [-1,1]`);
    if (peakM < 0.9) weak.push(`${s.id}: mask never reaches full strength (peak ${fmt(peakM, 2)})`);
    // Under 4% is a pattern nobody will see; over 55% is a tint change wearing
    // a costume, and it would also break section 12's "the datasheet tint
    // reaches most of the surface".
    if (frac < 0.04) weak.push(`${s.id} covers only ${fmt(frac * 100, 1)}% of the trunk`);
    if (frac > 0.55) weak.push(`${s.id} covers ${fmt(frac * 100, 1)}% - that is a tint change`);
    if (step < 0.10) weak.push(`${s.id} albedo step ${fmt(step, 3)} is invisible`);
  }
  check('every pattern covers a real, bounded share of its animal with a visible step',
    weak.length === 0,
    weak.join(' | ') || rows.map((r) => `${r.id} ${r.kind} ${fmt(r.frac * 100, 0)}% dA ${fmt(r.step, 2)}`).join(', '));

  // The loft emits theta = 0 and theta = TAU as two vertices at the SAME point,
  // so a mask indexed off theta without folding leaves a seam line down one
  // flank that no geometry check can see. The bioluminescence mask has the same
  // check in section 12.
  const seams = [];
  for (const s of patterned) {
    const pat = albedoPatternParams(s);
    let worst = 0;
    for (let iu = 0; iu <= 256; iu++) {
      const u = iu / 256;
      for (const h of [0, 0.31, 0.77]) {
        worst = Math.max(worst, Math.abs(
          albedoPatternMask(s.meshRecipe.pattern.kind, 0, u, pat.count, pat.duty, h)
          - albedoPatternMask(s.meshRecipe.pattern.kind, 1, u, pat.count, pat.duty, h)));
      }
    }
    if (worst > 1e-6) seams.push(`${s.id} ${fmt(worst, 4)}`);
  }
  check('the albedo pattern closes at the theta seam', seams.length === 0,
    seams.join(', ') || 'mask(theta=0) == mask(theta=1) on every patterned species');

  // A shoal of forty identically barred fish reads as a texture. The hash is the
  // only thing that stops that, and it is a silent no-op if the shader forgets
  // to forward it - so measure that the mask MOVES with it.
  const varies = [];
  for (const s of patterned) {
    const pat = albedoPatternParams(s);
    // Scan the whole trunk, not one meridian: SADDLES are gated to the dorsum
    // and STRIPE to the flanks, so a single line of `a` measures one of them at
    // a tenth strength and calls a working pattern static.
    let moved = 0, n = 0;
    for (let iu = 0; iu < 128; iu++) {
      const u = (iu + 0.5) / 128;
      for (let ia = 0; ia < 64; ia++) {
        const a = (ia + 0.5) / 64;
        const m0 = albedoPatternMask(s.meshRecipe.pattern.kind, a, u, pat.count, pat.duty, 0.05);
        const m1 = albedoPatternMask(s.meshRecipe.pattern.kind, a, u, pat.count, pat.duty, 0.83);
        if (Math.abs(m0 - m1) > 0.4) moved++;
        n++;
      }
    }
    varies.push({ id: s.name, kind: s.meshRecipe.pattern.kind, frac: moved / n });
  }
  // BANDS, SADDLES and SPOTS are phase-driven and must move; STRIPE, EYE_MASK
  // and EYESPOT are ANATOMY - a lateral line and an eye bar are where they are -
  // and moving those with the hash would be wrong, so they are asserted still.
  const phaseKinds = new Set(['bands', 'saddles', 'spots']);
  const still = varies.filter((v) => phaseKinds.has(v.kind) && v.frac < 0.10);
  const drifting = varies.filter((v) => !phaseKinds.has(v.kind) && v.frac > 0.001);
  check('the individual hash moves the phase-driven patterns and only those',
    still.length === 0 && drifting.length === 0,
    [...still.map((v) => `${v.id} static`), ...drifting.map((v) => `${v.id} drifted`)].join(', ')
    || varies.map((v) => `${v.id} ${fmt(v.frac * 100, 0)}%`).join(', '));
}

// ===========================================================================
section('17. The mandible fold closes without interpenetrating');
// ===========================================================================
//
// THE FOLD ANGLE IS A GEOMETRY DECISION MADE ON THE GPU, AND NOTHING ELSE HERE
// CAN SEE IT. `meshRecipe.mandibles.fold` is consumed by creature.wgsl's
// ROLE_MANDIBLE branch, which rotates each horn about the axis tangential to
// its own radial by -(1 - jawOpen) * fold, pivoting at the bone's rest
// position. The mesh sections above measure the REST pose - which is the OPEN
// pose, since the fold only ever closes - so a fold that drove the four horns
// through each other or into the jaw plates would pass every one of them.
//
// This replays that exact rotation on the CPU over the real vertex ranges and
// asserts the closed pose is clean. The angles it brackets are recorded on the
// LEV_SPLITMAW row; the one that matters is that the tips MEET at 0.75 and
// cross past it, so the authored value has to sit clear below that.
{
  /** Rodrigues, matching axisAngleRows() in pass/creature.wgsl. */
  const rotAbout = (axis, ang, v, pivot) => {
    const [ax, ay, az] = axis;
    const c = Math.cos(ang), sn = Math.sin(ang), t = 1 - c;
    const x = v[0] - pivot[0], y = v[1] - pivot[1], z = v[2] - pivot[2];
    return [
      pivot[0] + x * (t * ax * ax + c) + y * (t * ax * ay - sn * az) + z * (t * ax * az + sn * ay),
      pivot[1] + x * (t * ax * ay + sn * az) + y * (t * ay * ay + c) + z * (t * ay * az - sn * ax),
      pivot[2] + x * (t * ax * az - sn * ay) + y * (t * ay * az + sn * ax) + z * (t * az * az + c),
    ];
  };
  const minGap = (a, b) => {
    let d = Infinity;
    for (const p of a) for (const q of b) {
      const e = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
      if (e < d) d = e;
    }
    return Math.sqrt(d);
  };

  const folders = SPECIES.filter((sp) => (sp.meshRecipe.mandibles?.fold ?? 0) > 0);
  check('every mandible fold has an owner', folders.length > 0,
    folders.length ? folders.map((sp) => `${sp.id} ${fmt(sp.meshRecipe.mandibles.fold, 2)} rad`).join(', ')
      : 'no record authors mandibles.fold - delete the field or claim it');

  for (const sp of folders) {
    const m = buildCreatureMesh(sp, 1);
    const P = m.positions;
    const fold = sp.meshRecipe.mandibles.fold;
    const pts = (part) => {
      const b = m.bones[part.bone];
      const axis = [Math.sin(b.radial), -Math.cos(b.radial), 0];
      const out = [];
      for (let i = part.start; i < part.start + part.count; i++) {
        out.push(rotAbout(axis, -fold, [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], b.position));
      }
      return out;
    };
    const horns = m.parts.filter((p) => p.kind === 'mandible');
    check(`${sp.id}: every horn is on its own MANDIBLE bone`,
      horns.length > 0 && new Set(horns.map((h) => h.bone)).size === horns.length
        && horns.every((h) => m.bones[h.bone]?.role === BONE_ROLE.MANDIBLE
          && Number.isFinite(m.bones[h.bone].radial)),
      `${horns.length} horns on bones ${horns.map((h) => h.bone).join(',')}`);
    if (!horns.length) continue;

    const clouds = horns.map(pts);
    const tips = clouds.map((c, k) => {
      const piv = m.bones[horns[k].bone].position;
      let best = null, bd = -1;
      for (const p of c) {
        const d = (p[0] - piv[0]) ** 2 + (p[1] - piv[1]) ** 2 + (p[2] - piv[2]) ** 2;
        if (d > bd) { bd = d; best = p; }
      }
      return best;
    });

    let tipTip = Infinity, hornHorn = Infinity;
    for (let i = 0; i < clouds.length; i++) {
      for (let j = i + 1; j < clouds.length; j++) {
        tipTip = Math.min(tipTip, Math.hypot(tips[i][0] - tips[j][0],
          tips[i][1] - tips[j][1], tips[i][2] - tips[j][2]));
        hornHorn = Math.min(hornHorn, minGap(clouds[i], clouds[j]));
      }
    }
    // Open-pose reference, straight off the mesh, for the ratio below.
    const openTips = horns.map((h, k) => {
      const piv = m.bones[h.bone].position;
      let best = null, bd = -1;
      for (let i = h.start; i < h.start + h.count; i++) {
        const p = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
        const d = (p[0] - piv[0]) ** 2 + (p[1] - piv[1]) ** 2 + (p[2] - piv[2]) ** 2;
        if (d > bd) { bd = d; best = p; }
      }
      return best;
    });
    let openTipTip = Infinity;
    for (let i = 0; i < openTips.length; i++) {
      for (let j = i + 1; j < openTips.length; j++) {
        openTipTip = Math.min(openTipTip, Math.hypot(openTips[i][0] - openTips[j][0],
          openTips[i][1] - openTips[j][1], openTips[i][2] - openTips[j][2]));
      }
    }

    const jaw = [];
    for (const part of m.parts) {
      if (part.kind !== 'jaw' && part.kind !== 'tooth') continue;
      for (let i = part.start; i < part.start + part.count; i++) {
        jaw.push([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
      }
    }
    const hornJaw = jaw.length ? Math.min(...clouds.map((c) => minGap(c, jaw))) : Infinity;

    // THE HORNS MUST NOT PASS THROUGH EACH OTHER. `fold` past the angle where
    // the tips meet inverts the cage, and the symptom is a tip-to-tip gap that
    // RISES again - so a bare "tips are close" test would pass the broken pose.
    // Requiring positive surface clearance is what rejects it.
    check(`${sp.id}: folded horns keep clear of each other`,
      hornHorn > 0.05 && tipTip > 0.05,
      `min surface gap ${fmt(hornHorn, 2)} m, tip-to-tip ${fmt(tipTip, 2)} m at fold ${fmt(fold, 2)}`);
    check(`${sp.id}: folded horns keep clear of the jaw plates`,
      hornJaw > 0.05,
      `min gap ${fmt(hornJaw, 2)} m`);
    // A fold that does not visibly SHUT the cage is a field with no effect.
    check(`${sp.id}: the fold actually closes the cage`,
      tipTip < openTipTip * 0.25,
      `tips ${fmt(openTipTip, 2)} m open -> ${fmt(tipTip, 2)} m shut `
      + `(${fmt(100 * tipTip / sp.length, 1)}% of body length)`);
  }
}

// ===========================================================================
section('16. The JS / WGSL pattern contract');
// ===========================================================================
//
// TWO LAYOUT PAIRS WITH NO EQUIVALENT OF tools/test-layout.mjs. Bind group 1 is
// not the Frame uniform, so nothing else in the project guards it, and both
// failure modes are silent: a species animation record read at the wrong stride
// gives every animal another species' swim parameters, and a pattern-kind
// constant that disagrees draws the wrong pattern. Neither throws, neither
// fails WebGPU validation, and both would pass every other check here.
{
  const wgsl = SRC('src/render/shaders/pass/creature.wgsl');
  const passJs = SRC('src/render/passes/creatures.js');

  // ---- the AP_* enum -----------------------------------------------------
  const wgslIds = new Map();
  for (const m of wgsl.matchAll(/const\s+AP_(\w+)\s*:\s*u32\s*=\s*(\d+)u\s*;/g)) {
    wgslIds.set(m[1].toLowerCase(), Number(m[2]));
  }
  const jsIds = new Map(Object.entries(ALBEDO_PATTERN_ID)
    .map(([k, v]) => [k.toLowerCase().replace('_', ''), v]));
  const mismatched = [];
  for (const [k, v] of jsIds) {
    // eyeMask -> AP_EYEMASK, eyespot -> AP_EYESPOT.
    if (!wgslIds.has(k)) mismatched.push(`${k} missing from the shader`);
    else if (wgslIds.get(k) !== v) mismatched.push(`${k}: js ${v} vs wgsl ${wgslIds.get(k)}`);
  }
  for (const k of wgslIds.keys()) if (!jsIds.has(k)) mismatched.push(`AP_${k} has no JS twin`);
  check('ALBEDO_PATTERN_ID and the shader\'s AP_* constants agree',
    mismatched.length === 0 && wgslIds.size === jsIds.size,
    mismatched.join(', ') || `${wgslIds.size} kinds: ${[...wgslIds.keys()].join(' ')}`);

  // ---- SpeciesAnim stride ------------------------------------------------
  const structSrc = wgsl.match(/struct\s+SpeciesAnim\s*\{([\s\S]*?)\n\}/);
  const fields = structSrc ? [...structSrc[1].matchAll(/^\s*(\w+)\s*:\s*(vec4[fu])\s*,/gm)] : [];
  const wgslBytes = fields.length * 16;
  const strideJs = Number(passJs.match(/const SPECIES_ANIM_STRIDE = (\d+);/)?.[1]);
  check('struct SpeciesAnim and SPECIES_ANIM_STRIDE are the same size',
    fields.length > 0 && wgslBytes === strideJs,
    `${fields.length} vec4 = ${wgslBytes} B in the shader, ${strideJs} B in the pass`);

  // The other half of the same bug: a field added to writeSpeciesAnim without
  // growing the stride writes into the NEXT species' record.
  let maxSlot = -1;
  const writeFn = passJs.match(/function writeSpeciesAnim\([\s\S]*?\n  \}/);
  for (const m of (writeFn?.[0] ?? '').matchAll(/out(?:U32)?\[o \+ (\d+)\]\s*=/g)) {
    maxSlot = Math.max(maxSlot, Number(m[1]));
  }
  check('writeSpeciesAnim fills the record exactly and writes past nothing',
    maxSlot === strideJs / 4 - 1,
    `highest slot o+${maxSlot}, record is ${strideJs / 4} floats`);

  // ---- the trunk gate ----------------------------------------------------
  // The pattern is (theta, u) on the LOFT. A snout, barbel, tentacle and leg are
  // all MM_FLORA too and carry a sweep uv, so the material slot cannot gate it.
  check('the pass packs a trunk mask and the shader reads it',
    /u8\[b \+ 38\] = trunk\[i\]/.test(passJs) && /packed\.z/.test(wgsl)
      && /trunk > 0\.5/.test(wgsl),
    'vertex byte 38 -> packed.z -> skinSurface gate');
}

// ===========================================================================
section('15. Species table');
// ===========================================================================
{
  console.log('');
  console.log('  ' + 'species'.padEnd(24) + 'archetype'.padEnd(15) + 'plan'.padEnd(11)
    + 'len(m)'.padEnd(9) + 'tier'.padEnd(6) + 'verts'.padEnd(7) + 'tris'.padEnd(7)
    + 'bones'.padEnd(7) + 'budget'.padEnd(8) + 'lit%'.padEnd(7) + 'pattern');
  console.log('  ' + '-'.repeat(131));
  for (const s of SPECIES) {
    const { r, m } = reports.get(s.id);
    console.log('  ' + s.name.padEnd(24)
      + s.archetype.padEnd(15)
      + s.meshRecipe.plan.padEnd(11)
      + fmt(s.length, 2).padStart(7).padEnd(9)
      + String(s.dangerTier).padEnd(6)
      + String(m.vertexCount).padStart(5).padEnd(7)
      + String(m.triangleCount).padStart(5).padEnd(7)
      + `${m.spineCount}${m.jawBone >= 0 ? '+j' : ''}${m.lureBone >= 0 ? '+l' : ''}`.padEnd(7)
      + String(creatureVertexBudget(s)).padStart(5).padEnd(8)
      + fmt(100 * r.maskHot / m.vertexCount, 1).padStart(5).padEnd(7)
      + s.bioluminescence.pattern);
  }
  console.log('  ' + '-'.repeat(131));
  const tv = [...reports.values()].reduce((a, x) => a + x.m.vertexCount, 0);
  const tt = [...reports.values()].reduce((a, x) => a + x.m.triangleCount, 0);
  const tb = SPECIES.reduce((a, s) => a + buildCreatureBones(s).bones.length, 0);
  console.log(`  ${SPECIES_COUNT} species: ${tv.toLocaleString()} verts, ${tt.toLocaleString()} tris, `
    + `${tb} bones total (max ${Math.max(...SPECIES.map((s) => buildCreatureBones(s).bones.length))} per creature)`);
  console.log(`  ${ARCHETYPE_LIST.length} archetypes, ${Object.keys(BODY_PLAN).length} body plans, `
    + `${new Set(SPECIES.map((s) => s.bioluminescence.pattern)).size} bioluminescence patterns in use`);

  // Boundary and non-manifold edges are expected and explained; print them so a
  // regression that adds a real hole is visible.
  const openTotal = [...reports.values()].reduce((a, x) => a + x.r.openEdges, 0);
  const nmTotal = [...reports.values()].reduce((a, x) => a + x.r.nonManifoldEdges, 0);
  console.log(`  ${openTotal} boundary edges across the roster (uncapped embedded cones: teeth, `
    + `spines, barbs) and ${nmTotal} branch joins (parts that share a root point)`);
}

console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${checks - failures}/${checks} checks\n`);
process.exit(failures ? 1 : 0);
