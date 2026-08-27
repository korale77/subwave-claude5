/**
 * SUBWAVE population manager.
 *
 * Owns WHERE and HOW MANY. entities/creatures.js owns what they then do.
 *
 * The world is partitioned into spawn cells of 256 x 256 m horizontally and
 * 128 m vertically (DESIGN/06.6.1). A cell is resolved once, on first entry,
 * from a hash of (worldSeed, cellKey, speciesIndex, index) - so the same cell
 * repopulates identically after a save and reload, and a reef the player
 * emptied stays empty because the depletion counter is part of the cell record
 * rather than part of the agents.
 *
 * THE SAFE CHARTER IS THE ONE INVARIANT THIS FILE EXISTS TO GUARANTEE.
 *
 * Within WORLD.SAFE_CRATER_RADIUS of the crater centre, at any depth, nothing
 * above danger tier 0 may exist. It is enforced at three independent levels,
 * exactly as DESIGN/06.6.2 requires, because a single check is a single place
 * to get it wrong:
 *
 *   1. SPAWN FILTER   charterMaxTier() gates every candidate before placement.
 *      A pure function of position with no override flag and no debug bypass.
 *   2. MOVEMENT BARRIER  the sim is handed the charter volume and applies a
 *      soft repulsion to any tier >= 1 agent whose predicted position enters
 *      it, at a 40 m margin so the animal visibly turns away rather than
 *      striking an invisible wall. ATTACK and STALK are gated off inside it.
 *   3. DAMAGE VETO    any strike whose position is inside the volume is
 *      dropped. This should never fire; if it does, levels 1 and 2 have a bug,
 *      and `stats.charterVetoes` is how you find out.
 *
 * The three levels are tested independently in tools/test-creatures.mjs: 500
 * spawn attempts inside the crater must produce zero tier > 0 agents.
 *
 * WHAT THE CHARTER DOES NOT CONSTRAIN is sound. A Veilmouth moan carries from
 * 1,200 m and is audible from the beach. That is deliberate: the safe zone has
 * to feel like the edge of something enormous.
 */

import { WORLD, DEPTH_BANDS, depthBandIndex, RENDER, SKY } from '../core/constants.js';
import { clamp, saturate, lerp, hash3i, makeRng, TAU } from '../core/math.js';
import { events, EVENTS } from '../core/events.js';
import { insideHabitatVolume } from '../world/habitat_site.js';
import * as terrain from '../world/terrain.js';
import { biomeAt, waterTypeAt, BIOMES } from '../world/biomes.js';
import { insideAbyssEncounterStage } from '../world/abyss_encounter_site.js';
import { insideSplitmawHuntingGround } from '../world/leviathan_sites.js';
import {
  SPECIES_TABLE, SPECIES_FLAG, CREATURE_LOD, BEHAVIOUR, speciesIndexOf,
} from './creatures.js';
import { speciesForBiome, DANGER_BY_TIER, CREATURE_HABITAT } from './bestiary.js';
import { isInsideCave, caveVoidAt } from '../world/caves.js';

/**
 * Which species belong to the CAVE pseudo-habitat (bestiary `biomes` carrying
 * CREATURE_HABITAT.CAVE). Precomputed because the placement loop tests it per
 * candidate. The CAVE roster is merged into the NEAR FIELD ONLY, and only
 * while the eye is inside a carved void (`_eyeInCave`): cell resolution's
 * columnar water-column tests cannot express "under a roof", so a cell either
 * rejects the interior outright (`cellTop < height`) or would place cave fish
 * in the open column - both wrong. The near-field ball centred on an
 * inside-the-cave eye, with each candidate tested against the void field
 * itself, is the placement that means what it says.
 */
const CAVE_SPECIES = (() => {
  const t = new Uint8Array(SPECIES_TABLE.count);
  for (let i = 0; i < SPECIES_TABLE.count; i++) {
    const b = SPECIES_TABLE.records[i].biomes;
    if (Array.isArray(b) && b.includes(CREATURE_HABITAT.CAVE)) t[i] = 1;
  }
  return t;
})();

/**
 * Metres of carved void a cave candidate needs around it, floored so a
 * 0.2 m Palewander is not glued to the wall the marching-cubes surface
 * wobbles through. caveVoidAt is a conservative under-estimate (see the
 * capsule-distance note in world/caves.js), so this errs toward open water.
 */
const CAVE_PLACE_CLEARANCE_MIN = 0.5;

// ===========================================================================
// The Safe Charter
// ===========================================================================

/**
 * The charter volume.
 *
 * DESIGN/06.6.2 specifies a 900 m cylinder from y = +250 to y = -60 with a
 * transition annulus out to 1,400 m. This build's WORLD.SAFE_CRATER_RADIUS is
 * 340 m and SAFE_FALLOFF_RADIUS is 460 m, and constants.js is authoritative
 * over the doc, so those are the radii used here.
 *
 * The vertical extent is deliberately UNBOUNDED, unlike the doc's cylinder.
 * The doc caps it at -60 m because at a 900 m radius the seabed inside the
 * cylinder is all shallower than that; at 340 m the crater's own floor is
 * within the radius but a cave mouth or a rift is not guaranteed to be, and a
 * tier-3 animal 70 m below the starting beach is a tier-3 animal in the
 * starting beach's water column. Making the guarantee "any depth" costs
 * nothing - there is nowhere inside 340 m of the crater a player is supposed
 * to meet a predator - and it removes the one way this invariant could be
 * satisfied on paper and violated in play.
 */
export const CHARTER = Object.freeze({
  centerX: WORLD.SAFE_CRATER_CENTER[0],
  centerZ: WORLD.SAFE_CRATER_CENTER[1],
  /** Inside this radius: tier 0 only. */
  radius: WORLD.SAFE_CRATER_RADIUS,
  /** Between radius and this: tier <= 1. */
  annulus: WORLD.SAFE_FALLOFF_RADIUS,
  /** The movement barrier begins this far outside the boundary, metres. */
  margin: 40,
  /**
   * Tier >= 3 agents within this radius are additionally driven below
   * `deepFloor`, so the deep stays deep near the start. DESIGN/06.6.2.
   */
  deepRadius: 1200,
  deepFloor: -140,
});

/**
 * Highest danger tier that may exist at a horizontal position.
 *
 * A PURE FUNCTION of position. No flags, no time dependence, no randomness,
 * no way to call it that returns anything other than the invariant. This is
 * the function the acceptance test fuzzes.
 *
 * @param {number} x world metres
 * @param {number} z world metres
 * @returns {number} 0..5
 */
export function charterMaxTier(x, z) {
  const dx = x - CHARTER.centerX;
  const dz = z - CHARTER.centerZ;
  const r2 = dx * dx + dz * dz;
  if (r2 <= CHARTER.radius * CHARTER.radius) return 0;
  if (r2 < CHARTER.annulus * CHARTER.annulus) return 1;
  return 5;
}

/**
 * True if a position is inside the charter's tier-0 core, optionally expanded
 * by a margin. Used by the movement barrier and the damage veto.
 * @param {number} x
 * @param {number} z
 * @param {number} [margin] metres of expansion
 */
export function insideCharter(x, z, margin = 0) {
  const dx = x - CHARTER.centerX;
  const dz = z - CHARTER.centerZ;
  const r = CHARTER.radius + margin;
  return dx * dx + dz * dz <= r * r;
}

// ===========================================================================
// Cells, budgets and caps
// ===========================================================================

/** Spawn cell footprint, metres. DESIGN/06.6.1. */
export const CELL_X = 256;
export const CELL_Y = 128;
export const CELL_Z = 256;

/**
 * Depths to ask the bestiary about for a cell spanning `top`..`bottom` over a
 * seabed at `floorY`. All values are DEPTHS - positive, metres below the surface.
 *
 * Stepped at 8 m because that is speciesForBiome's own DEPTH_BUCKET, so every
 * bucket the column touches is hit exactly once and every lookup is already
 * memoised: three queries for a 15 m lagoon, seventeen for a full 128 m slab.
 */
function depthSamples(top, bottom, floorY) {
  const dTop = Math.max(0, -Math.min(top, 0));
  const dBot = Math.max(dTop, -Math.max(bottom, floorY));
  const out = [];
  for (let d = dTop; d < dBot; d += 8) out.push(d);
  out.push(dBot);
  return out;
}

/**
 * Horizontal / vertical radius within which cells are instantiated, metres.
 *
 * DESIGN/06.6.1 says 1,024 m horizontal and 512 m vertical, and that is the
 * right radius for the pool it assumes: 512 L0 agents plus 1,536 L1 agents plus
 * up to 65,536 GPU boid particles. This build has 260 CPU agents and no GPU
 * boid field, and 260 animals spread over a 1,024 m radius is one creature per
 * 12,600 square metres - MEASURED on the start reef, the nearest animal to the
 * spawn beach was 72 m away and the frame drew one instance. In water whose 1%
 * contrast depth is 32 m that is an empty ocean.
 *
 * 384 m spends the same budget over a fourteenth of the area, which puts the
 * population where the player can actually see it, and the cells restream
 * continuously as they move - so nothing is lost except the ability to be
 * simulating animals a kilometre away that nobody will ever look at. The
 * despawn radii in DESIGN/06.6.4 are deliberately LARGER than this (600 m for
 * tier 0-2, 1,400 m for a leviathan) so an animal that has been met keeps
 * existing well outside the streaming radius.
 */
const CELL_ACTIVE_XZ = 384;
const CELL_ACTIVE_Y = 256;
/** Cells beyond this are retired. The gap is the hysteresis. */
const CELL_RETIRE_XZ = 576;
const CELL_RETIRE_Y = 384;

/**
 * Concurrent agent budget per depth band.
 *
 * DESIGN/06.6.4's table is written against a 512-slot L0 pool plus a 1,536-slot
 * L1 pool plus tens of thousands of GPU boid particles. This build has ONE pool
 * of RENDER.MAX_CREATURES CPU agents and no GPU boid system, so the design's
 * numbers are scaled to that total while keeping its SHAPE: the sunlit shallows
 * are the busiest water in the game and the trench is the emptiest.
 *
 * RE-SCALED FROM 260 TO 420, and the sunlit band by far more than the rest.
 * The old table gave the sunlit band 64 slots and MEASURED 183 agents living in
 * it, because the budget was looked up from the CELL CENTRE - a lagoon cell's
 * centre is at y = -64 m, which is band 2 - while every animal it placed was
 * censused into band 1. The budget was therefore never enforced where it
 * mattered. Enforcing it at 64 would have emptied the one piece of water the
 * player spends the first ten minutes in, so the fix ships with the re-scale.
 *
 * SUNLIT RAISED AGAIN, 176 -> 192, AND THIS ONE IS PURE GEOMETRY. What the
 * player sees is the near field's ball intersected with the view frustum, and
 * that intersection is a FIXED FRACTION of the ball however the ball is filled:
 * MEASURED LIVE at the lagoon after a 45 s hold on one heading, 22 drawn
 * instances against 110 agents inside the 45 m radius, i.e. 0.20 - and the
 * seeding rule biases it downward, because inside NEARFIELD_HIDE_FRAC an animal
 * may only be seeded where the camera is NOT pointed. A near-field target of 110
 * therefore cannot draw much more than 22 no matter what else is fixed. 192
 * leaves the near field 150 after NEARFIELD_CELL_FLOOR's 42, which is 30
 * instances at the measured fraction, and it is the largest sunlit budget that
 * keeps the whole table inside the pool.
 *
 * Per-tick cost MEASURED with this file's own harness (tools/test-creatures.mjs
 * section 8) at the worst case, every agent inside the 60 m LOD-FULL edge and
 * pressed against the seabed: 260 agents 1,188 us, 420 agents 1,913 us, 500
 * agents 2,374 us. DESIGN's AI budget is 2.0 ms, so 420 is the cap and 500 is
 * not available. RENDER.MAX_CREATURES still bounds the pool, so raising a band
 * cannot raise the worst case above that 1,913 us.
 *
 * Band 0 is the top TWO METRES only. It is 36 rather than the 26 it scales to
 * because a lagoon's pelagic fish are placed uniformly through a 14 m column and
 * MEASURED 35 of them in the top two of it; at 30 the band sat at 1.17x budget,
 * just past _cull's 1.15x threshold, and the surface film churned.
 *
 * The sum is 414, leaving 6 slots of headroom so a scripted encounter or a
 * leviathan promotion always has somewhere to go even with every band full at
 * once - which CELL_ACTIVE_Y's 256 m makes unreachable anyway.
 */
export const BAND_BUDGET = Int32Array.of(36, 192, 76, 50, 36, 24);

/** Maximum concurrent tier >= 3 and tier >= 4 agents per band. DESIGN/06.6.4. */
export const BAND_MAX_TIER3 = Int32Array.of(0, 0, 2, 4, 5, 3);
export const BAND_MAX_TIER4 = Int32Array.of(0, 0, 0, 0, 1, 1);

/**
 * Agents any single cell may hold. Stops one cell eating a whole band.
 *
 * Must stay above MAX_CPU_SCHOOL or no cell can ever hold one whole shoal.
 */
const CELL_AGENT_CAP = 56;

/**
 * Per-species caps by body length, from DESIGN/06.6.4's class table, again
 * scaled to the pool. `cell` is per spawn cell, `global` is across the whole
 * active radius.
 */
export const SIZE_CLASSES = [
  // PLANKTON. DESIGN/06.2.1 puts these in the GPU boid field in swarms of
  // 2,000-12,000, and this build has no GPU boid field. A 21 mm Glimmerkrill is
  // one pixel at four metres, so simulating it as a CPU agent buys almost no
  // picture - and MEASURED on the start reef it was taking 60 of the 260 slots,
  // 23% of the entire budget, for animals the player cannot resolve. Twelve of
  // them is enough to be a drift of cyan sparks at night, which is the part of
  // the effect that survives at this scale.
  { maxLength: 0.05, cell: 3, global: 12 },
  // The reef fish class. `cell` was 12, and 12 - not MAX_CPU_SCHOOL - was what
  // MEASURED every shoal in the game at exactly 12 members, because
  // resolveCell() clamps a school by the same headroom it clamps a solitary
  // animal by. A scattered dozen does not read as a shoal; forty does.
  //
  // `global` was 150 and had to rise with the near field's target. The near
  // field draws almost exclusively from this class, so at a target of 150 it
  // consumed the entire global cap and cell resolution could no longer build a
  // shoal at all: MEASURED at 150, the largest school anywhere in the primed
  // lagoon was 23 against MAX_CPU_SCHOOL's 40. 220 leaves the background 70 of
  // the class after the near field has taken its share.
  { maxLength: 1.0, cell: 40, global: 220 },
  { maxLength: 5.0, cell: 6, global: 28 },
  { maxLength: 20.0, cell: 1, global: 6 },
  { maxLength: Infinity, cell: 1, global: 2 },
];

function sizeClass(length) {
  for (let i = 0; i < SIZE_CLASSES.length; i++) {
    if (length <= SIZE_CLASSES[i].maxLength) return SIZE_CLASSES[i];
  }
  return SIZE_CLASSES[SIZE_CLASSES.length - 1];
}

/**
 * Largest CPU school this build instantiates.
 *
 * DESIGN/06.2.1 splits schooling in two: named CPU schools of up to 120, and
 * GPU boid fields of up to 65,536 for the silver curtains. This build has only
 * the CPU half, and a 120-member Silverquill shoal would be a third of the
 * entire creature budget standing in one place. 40 is what fits, and it is what
 * a shoal has to be to read as one: a 40-member 0.11 m Coppersprat ball computes
 * a schoolRadius of 0.42 * cbrt(40) * 1.0 * 3.0 = 4.31 m, i.e. a 8.6 m wide,
 * 3.9 m tall lens that subtends 40 degrees at 12 m. At the previous 16 - which
 * the size-class cap silently reduced to 12 - the same shoal was 5.9 m wide and
 * read as a scattering of individuals.
 */
export const MAX_CPU_SCHOOL = 40;

// ===========================================================================
// The near-field director
// ===========================================================================

/**
 * A SPAWN CELL CANNOT PUT AN ANIMAL IN FRAME, and no per-cell density can fix
 * that. The arithmetic: 256 x 256 m over a 15 m lagoon water column is
 * 983,000 m3 per cell, and the camera's frustum over a 30 m sightline clipped to
 * the same column encloses about 10,000 m3 - one percent. MEASURED in the
 * running game at the lagoon with every depth and biome filter already correct:
 * 200 agents alive, 0 within 30 m of the eye, 1 within 60 m, and the creature
 * pass drew ZERO instances.
 *
 * So there is a second, player-centred director. It maintains a target
 * population of harmless animals inside a radius set by the LOCAL WATER's own
 * contrast limit, seeds them in an annulus far enough out that they arrive as
 * specks in the haze, and retires them behind the player rather than waiting for
 * the 600 m despawn radius.
 *
 * CALIBRATION. An earlier note here claimed 0.46 drawn instances per near-field
 * agent, from hand-placed agents; hand placement put them in front of the
 * camera, and the real director may not. MEASURED LIVE INSTEAD, eye pinned at
 * the lagoon for 45 s on one heading: 110 agents inside the 45 m radius drew 22,
 * a ratio of 0.20. That is the frustum's share of a sphere (a 53 deg horizontal
 * half-angle over a water column the ball is wider than) minus what the
 * off-camera seeding rule biases away, and no amount of placement cleverness
 * moves it much - so the target is sized against 0.20, not against 0.46.
 *
 * ON DETERMINISM: this director draws from `this.rng`, never from Math.random,
 * so prime() is reproducible for a seed. It is NOT frame-rate reproducible once
 * play starts, and it is not meant to be - it is a function of where the player
 * went and where they were looking, like the LOD system, not part of world
 * GENERATION. Cell resolution, which is generation, still draws from its own
 * per-cell rng and is untouched by any of this.
 */
const NEARFIELD_TARGET = 160;

/**
 * Contrast at which a near-field animal is considered to have emerged from the
 * haze, and the reflectance it is computed for.
 *
 * The seeding radius is the distance at which a bright reef fish's apparent
 * contrast against the veiling in-scatter falls to this. Below about 2% nothing
 * is visible at all (that is what WATER_TYPES.visibility quotes); 12% is a faint
 * speck that grows, which is what an animal appearing must look like. Seeding
 * at a FIXED radius instead pops in clear water and wastes the budget in turbid
 * water - the same 38 m ring is 1.3% contrast in Jerlov II and 24% in Jerlov IA.
 */
const NEARFIELD_SPAWN_CONTRAST = 0.12;
const NEARFIELD_FISH_ALBEDO = 0.70;

/** Radius bounds, metres. Below the first the director cannot spread a shoal;
 *  above the second the agent budget is spread too thin to be worth spending. */
const NEARFIELD_MIN_R = 14;
const NEARFIELD_MAX_R = 45;

/**
 * The near field's centre is lifted to at least this far above the seabed.
 *
 * See `_updateNearFieldGeometry`, which used to REFUSE a near field within
 * 0.25 m of the floor and so switched it off for a diver resting on the bottom.
 * 2 m is above the disagreement between `sampleHeight` and `sampleHeightFast`
 * and above a diver's own body, and it is 14% of the smallest radius the game
 * uses and 4.4% of the largest - so wherever the old test was not binding, the
 * ball is where it always was.
 */
const NEARFIELD_FLOOR_CLEARANCE = 2.0;

/**
 * Inner edge of the seeding annulus, and the fraction of the radius inside
 * which a seed additionally has to be off camera.
 *
 * The two together are the pop rule. Beyond NEARFIELD_HIDE_FRAC the haze does
 * the hiding: at 0.85 R a 0.35 m fish is at the seeding contrast the radius was
 * solved for (12%) and is 5.7 px tall on the QA canvas's measured 622 px/rad, so
 * it arrives as a speck in the murk whichever way the player is facing. Inside
 * it the animal is unmistakable - 44% contrast at 28 m in OCEANIC_CLEAR - so it
 * may only be seeded where the camera is not pointed.
 *
 * The inner edge is deliberately CLOSE. With it at 0.62 R the director built a
 * doughnut: MEASURED 110 agents inside the radius, 38 inside 30 m and ZERO
 * inside 15 m, because a reef fish holds station near the point it was seeded at
 * and never wandered in. At 0.22 R the whole ball is seeded and the off-camera
 * rule is what keeps the close ones from being watched arriving.
 */
const NEARFIELD_INNER = 0.22;
const NEARFIELD_HIDE_FRAC = 0.85;

/**
 * Inner seeding radius, metres, while the eye is inside a sealed dry volume.
 *
 * The Pelagos Habitat's widest pressure drum is the commons at r 6.60 with a
 * dome reaching 8.4 m above the deck, so a candidate drawn inside about 9 m of a
 * player standing in it is almost certainly inside the building - and
 * _placeGroup would simply reject it against insideHabitatVolume(). Raising the
 * floor spends those attempts on water the player can actually see through the
 * glass. It is a floor and never a ceiling: rMax and the population target are
 * untouched, and it is clamped to 0.75 R so it can never invert the shell.
 */
const NEARFIELD_HULL_CLEARANCE = 9.0;

/**
 * NESTED COVERAGE QUOTAS: [shell radius as a fraction of R, share of the target
 * that must be inside it]. Innermost first; the innermost shell that is short
 * claims one group per step and that group's radius is drawn inside it.
 *
 * The near field arrives as about ten SHOALS, so a shoal is a POINT sample of
 * the annulus and the radial draw is a lottery at that sample size. Area-uniform
 * sampling is the right DENSITY but it wins the inner shell about one group in
 * six and loses it outright whenever the camera happens to be pointed at the
 * only water that group may use. MEASURED LIVE at the lagoon, eye pinned at
 * (0, -8, 240) for 45 s with the radial stratification alone: 113 agents inside
 * 45 m, 47 inside 30 m, 2 inside 20 m and ZERO inside 10 m - a hollow shell with
 * the player standing in the hole, which is exactly what "we see no fish" looks
 * like from the inside. With a single 0.45 R quota: 81 inside 20 m and still
 * zero inside 10 m, because two forced groups drawn over [5.9, 20.3] m are still
 * a lottery for the innermost few metres.
 *
 * Filling by COUNT closes the loop instead of trusting the draw. The first pass
 * used the shares of a uniform flat disc: 6% inside 0.25 R and 20% inside 0.45
 * R. Live presentation QA still found only 9 animals inside 11 m and 30 inside
 * 20 m, with a 6.35 px median apparent length. The slightly denser 10% / 32%
 * profile is intentional composition: it moves 25 agents out of the haze and
 * into readable water without raising the 160-agent budget.
 */
const NEARFIELD_SHELLS = [[0.25, 0.10], [0.45, 0.32]];

/**
 * Closest a seed may ever be to the eye: the larger of these two.
 *
 * The general annulus starts at NEARFIELD_INNER (0.22 R, 9.9 m in the lagoon)
 * because that is a sensible floor for a shell that is meant to hold most of the
 * population. It is the wrong floor for a forced quota group, whose entire job
 * is the water the player is inside - with the annulus floor, MEASURED LIVE over
 * 45 s at the lagoon: 64 agents inside 20 m, 6 inside 15 m and still ZERO inside
 * 10 m. The absolute floor keeps the same rule usable in COASTAL_GREEN, where
 * 0.13 R is 1.8 m and a fish would be inside the mask.
 */
const NEARFIELD_TOUCH_FRAC = 0.13;
const NEARFIELD_TOUCH_R = 3.0;

/**
 * The hide radius during a BULK FILL, and the fraction of the target below
 * which a fill counts as bulk.
 *
 * A bulk fill is the player crossing the waterline or a scenario teleporting
 * them: the whole population is arriving at once, there is nothing for it to pop
 * out of, and holding the full 0.85 R rule would build the population entirely
 * BEHIND the camera. MEASURED with the single rule: a camera held on one heading
 * for the whole fill ended up with 114 agents inside 45 m, 47 of them inside
 * 30 m, and the creature pass drew ZERO on that heading - every one of them had
 * been pushed out of the cone the player was looking down. In steady state the
 * seeding rate is a group or two per second and the strict rule costs nothing.
 *
 * THE FRACTION WENT 0.60 -> 0.90 BECAUSE A FILL IS NOT 60% OF THE FILL. The
 * whole population arrives in about ten groups over a fifth of a second, so at
 * 0.60 the last four of those ten were already being held to the strict rule and
 * pushed behind the camera - and a fish that is seeded behind a player who then
 * holds still STAYS there: MEASURED live, near-field agents move 3.72 m in ten
 * seconds (median 3.66, max 6.18), so nothing diffuses back into view. The
 * resulting distribution, measured by angle from the view axis with the eye
 * pinned for 30 s: 0 of 164 agents within 20 deg of where the player was
 * looking, 17 in 20-40 deg, and 83 - half the entire near field - beyond
 * 135 deg, i.e. directly behind them. 17 instances drawn out of 164 animals.
 *
 * At 0.90 only a genuine top-up, with the population already at 90% of target,
 * is held to the strict rule; the arrival everyone actually sees is the fill,
 * and during a fill the water is visibly filling anyway.
 */
const NEARFIELD_HIDE_BULK = 0.45;
const NEARFIELD_BULK_FRAC = 0.90;

/**
 * Retirement radius, as a multiple of the seeding radius. The gap is the
 * hysteresis: without it an animal at the edge would spawn and retire on
 * alternate steps as the player drifted.
 *
 * IT WENT 1.55 -> 1.25 BECAUSE THE GAP IS A WAKE NOBODY COUNTS AND EVERYBODY
 * PAYS FOR. The counted ball is R; the retirement ball is k*R; the difference
 * holds animals that are alive, charged to the band budget, and behind the
 * player. In plan view (the lagoon's column is 14.5 m against a 90 m ball, so
 * the disc is the right model) the alive-to-counted ratio is
 *
 *     [pi R^2/2 + R sqrt(k^2R^2 - R^2) + k^2 R^2 asin(1/k)] / (pi R^2)
 *
 * = 1.413 at k = 1.55 and 1.200 at k = 1.25 (as a ball, 1.531 -> 1.266).
 * MEASURED LIVE at 1.55 while swimming at 3.96 m/s: 201-203 alive for 128-130
 * counted, ratio 1.55-1.57. Holding _nearFieldTarget's 150 therefore needed
 * 212-230 alive against a BAND_BUDGET[1] of 192 - ARITHMETICALLY IMPOSSIBLE,
 * which is why the measured population sat at 121-130 and why the reclaim path
 * ran continuously and stripped the mid-distance background. At 1.25 the same
 * 150 costs 180-190: inside 192 in both models, with nothing else touched.
 *
 * The hysteresis the gap exists for is unchanged in the units that matter:
 * DESPAWN_UNSEEN is 6.0 s, so nothing can cycle faster than that whatever the
 * radius, and 11.25 m of radial margin is 30 s at the MEASURED 0.37 m/s of
 * near-field self-motion (3.5-3.7 m per 10 s). Persistence is barely touched
 * either - a leading-edge seed still traverses 42.75 + 56.25 = 99 m of player
 * travel, 25 s at 4 m/s, against 114.75 m before.
 */
const NEARFIELD_RELEASE = 1.25;

/**
 * Beyond this multiple of the retirement radius, an agent in the eye's own band
 * that the near field did NOT seed is a budget the near field can take back.
 *
 * The band budget is spent by whoever asks first, and prime() asks first: it
 * resolves 28 cells while the player is still standing on the beach, where there
 * is no eye in the water and therefore no near-field reservation to respect. The
 * player then dives into a band that is already full of animals hundreds of
 * metres away. MEASURED at the lagoon before this path existed: 176 agents in
 * band 1, of which 37 were 200-400 m out and 136 beyond 400 m, 3 within 45 m of
 * the eye against a target of 110, and the creature pass drew ZERO instances.
 *
 * 140 m is past everything the near field can ever use and past the whole of the
 * 45 m seeing distance, so nothing the player could plausibly be looking at is
 * ever taken. The unseen-for-6 s and behaviour guards in _cull still apply on
 * top, so nothing vanishes on camera either.
 *
 * IT WENT 2.0 -> 2.48 ONLY TO HOLD THAT 139.5 m FIXED. It multiplies
 * _nearRelease, so dropping NEARFIELD_RELEASE from 1.55 to 1.25 would have
 * dragged the reclaim threshold from 139.5 m to 112.5 m as a side effect,
 * quietly taking background the player can still see. 1.55 x 2.0 = 3.10 and
 * 1.25 x 2.48 = 3.10, so the threshold is the same 139.5 m to the metre.
 *
 * IT IS NOT 2.5, AND THE ONE METRE MATTERS. Cell resolution places its animals
 * around 256 m cell centres, so the eligible set is lumpy in radius rather than
 * smooth: at 2.5 the threshold moves to 140.6 m and MEASURED OFFLINE at the
 * lagoon that one metre cost 9 reclaimable agents (117 -> 108) and the near
 * field lost exactly the same 9 (127 -> 118 within 45 m). Round this constant
 * and the near field pays for it.
 */
const NEARFIELD_RECLAIM_MULT = 2.48;

/**
 * Groups seeded per sim step. A group is one solitary animal or one shoal.
 *
 * It stays at 2 with the leading-edge quota added, and the split is deliberate:
 * one slot for the innermost short shell, which is what "we see no fish"
 * looks like standing still and keeps first claim, and one for the leading
 * edge, which is what it looks like moving.
 */
const NEARFIELD_GROUPS_PER_STEP = 2;

/**
 * Share of the counted near field that must lie AHEAD of a moving eye, and the
 * geometry of the seed that gets it there.
 *
 * THE CONVEYOR STARVES ITS OWN LEADING EDGE, and this is a conservation law and
 * not a tuning accident. Work in the eye frame. A near-field animal is
 * effectively static - MEASURED self-motion 3.5-3.7 m per 10 s, i.e. 0.37 m/s,
 * against 3.96 m/s of swimming diver - so every animal drifts backwards at the
 * swim speed. The director seeds over a disc that is CO-MOVING with the eye and
 * injects nothing at the leading edge, so continuity along a streamline at
 * across-track offset y gives
 *
 *     v dn/dx = -sigma,   n = 0 at x = sqrt(R^2 - y^2)
 *     n(x, y) = (sigma/v) (sqrt(R^2 - y^2) - x)
 *
 * a ramp that is EXACTLY ZERO at the front of the ball and maximal at the back.
 * Its forward-half integral is 2R^3/3 of a total 8R^3/3, so a uniform source
 * predicts a forward share of 0.250 against 0.500 standing still, and the
 * camera's 96 deg wedge holds 11.1% against 26.7%.
 *
 * MEASURED LIVE, swimming due west at 3.96 m/s for 32 s, the share was worse
 * still: 0.17 and 0.16 over two runs (0.15 offline). The extra deficit is the
 * NEARFIELD_SHELLS quota, which is short essentially always while moving and
 * so takes 43.3% of the group slots and 58.1% of the placed seeds into the
 * inner 0.45 R - where a seed's along-track offset is at most 20 m and its
 * forward residence is ~0.06 of its total, against ~0.26 for an annulus seed.
 * A 50/50 mix of the two predicts 0.15, which is what both measurements say.
 *
 * So the drawn-instance collapse is an ANGULAR failure, not a population one:
 * MEASURED, the creature pass drew 33.0 instances standing still and 7.05/6.03
 * swimming - a factor 4.9 - while the population inside 45 m fell only from
 * 150.5 to 129.8/127.5, a factor 1.16.
 *
 * A boundary source at the leading edge makes dn/dx = 0, i.e. uniform density,
 * i.e. forward share 0.500 and the stationary wedge share back. It also
 * REDUCES churn while raising the population, because an animal that enters at
 * the front lives the whole chord instead of a fraction of it.
 *
 * The denser presentation shells later exposed the same law a second time:
 * raising them to 10% / 32% dropped the offline moving share to 0.232 when
 * their bearings still covered the whole circle. Keeping their radii close but
 * distributing moving top-ups over the forward hemisphere restored 0.337 while
 * retaining 54-55 animals inside 20 m and respecting the camera rejection rule.
 */
const NEARFIELD_FORWARD_SHARE = 0.50;

/**
 * Radius at which a leading-edge group's seed point is placed, as a fraction
 * of R.
 *
 * It must be >= NEARFIELD_HIDE_FRAC (0.85) so the haze does the hiding and the
 * pop rule is satisfied whatever the camera is doing - biasing forward and the
 * pop rule are only in tension INSIDE the hide radius, and this is outside it.
 * At 0.95 R = 42.75 m in the lagoon a 0.35 m fish is at 17.2% apparent contrast
 * and 5.1 px on the QA canvas's measured 622 px/rad, which is strictly further
 * out than the 38.25 m the existing rule already permits in frustum. Below 1.0
 * so the seed point is inside the counted ball and the group is counted the
 * step it lands. The chord left for the vertical draw is sqrt(R^2 - (0.95R)^2)
 * = 14.05 m, which is the lagoon's whole water column.
 *
 * EVERY NUMBER IN THAT PARAGRAPH IS FOR R = 45 m, AND R IS NOT ALWAYS 45.
 * nearFieldRadius() returns the water type's own 1%-contrast distance clamped to
 * [14, 45]: 45 for OCEANIC_CLEAR and ABYSSAL_VOID, 21 for REEF_TURQUOISE, 17 for
 * BRINE and the floor of 14 for COASTAL_GREEN, MURKY_PARTICULATE and VENT_SMOKE
 * (test-creatures section 16 prints the list). The fraction is what carries, not
 * the metres: the seed is at 0.95 of whatever the local 1%-contrast distance is,
 * so it is always at the same APPARENT contrast, which is the property that
 * makes it invisible. What does not carry is the chord - at R = 14 it is 4.37 m,
 * enough for a lagoon column but not for an open one - and the time to reach the
 * eye: 13.3 m ahead of a 38 m/s vessel is 0.35 s. NOT MEASURED in murky water
 * or from the vessel; a known gap.
 */
const NEARFIELD_LEAD_FRAC = 0.95;

/**
 * Below this speed the eye's travel DIRECTION is noise, m/s.
 *
 * A diver's own buoyant drift is a measured 0.43 m/s and a near-field animal's
 * self-motion 0.37 m/s. It is also what keeps prime(), the offline suites and a
 * stationary player on the existing uniform draw, where the forward half fills
 * by symmetry and needs no help.
 */
const NEARFIELD_LEAD_SPEED = 1.0;

/**
 * First-order lag on the eye's own velocity, seconds.
 *
 * It has to be stable over the ~18 s a leading-edge seed takes to cross the
 * ball and still follow a genuine turn inside the 1-2 s a diver takes to make
 * one: 63% in 0.5 s, 95% in 1.5 s. It is 3x the swim controller's own 0.167 s
 * velocity lag, so it filters nothing the player did on purpose.
 */
const NEARFIELD_LEAD_TAU = 0.5;

/**
 * Above this the finite difference is a TELEPORT, not a velocity, m/s.
 *
 * Differencing the centre over one frame cannot tell a swim from a scenario
 * load or a board(). 200 m/s is above the vessel's 120 m/s Vne in air and 30x a
 * sprinting diver, so a sample past it is discarded and the lead re-seeds from
 * the new position.
 */
const NEARFIELD_LEAD_MAX_SPEED = 200;

/**
 * Largest group the NEAR FIELD seeds, as opposed to MAX_CPU_SCHOOL, which is
 * what cell resolution may still build.
 *
 * A group is ONE independent placement however many fish it holds, so the near
 * field's coverage of its ball is a sample of size (target / group size), and
 * the camera only ever sees a 96 deg wedge of it. At 40 that is four samples for
 * the whole circle and whether the player sees anything is a coin toss: MEASURED
 * LIVE across four runs of the identical build, eye pinned at the lagoon for
 * 45 s, the creature pass drew 55, 40, 22 and 1 instances - the 1 being a run
 * whose shoals had all been seeded behind the camera. At 16 it is ten samples
 * and the measured angular histogram still came out lumpy, 47 instances in one
 * run and 16 in the next off two groups landing either side of the frustum edge.
 * Ten is fifteen samples, one every 24 deg of bearing, so the wedge holds three
 * or four groups whatever the phase.
 *
 * The cost is that a NEAR-FIELD shoal is a ten-fish ball 5.4 m across rather
 * than a forty-fish ball 8.6 m across. Cell resolution still builds the big ones
 * - MEASURED after the change, the largest school in the primed lagoon is 36 -
 * so the reef still has curtains of fish in it; they are just not the ones being
 * conjured two metres behind the player's shoulder.
 */
const NEARFIELD_GROUP_MAX = 10;

/** Slots the near field will not touch, so a leviathan always has somewhere
 *  to arrive even in a lagoon full of sprats. */
const NEARFIELD_POOL_RESERVE = 30;

/**
 * Highest danger tier the near field may conjure.
 *
 * IT WAS 0, AND AT TIER 0 THE BESTIARY HAS NOTHING TO OFFER BELOW THE REEF.
 * MEASURED offline over the fourteen biome anchors, filtering each anchor's own
 * seabed roster exactly the way `_pickNearFieldSpecies` does: Canyon Wall,
 * Abyssal Plain, Trench Wall and Trench Floor return ZERO tier-0 records, and
 * Boulder Field, Shelf Break and Twilight Terraces return exactly ONE each - a
 * 0.55 m Ninearm Mimic and, twice, a 0.13 m Wisplight. MEASURED LIVE, the
 * game's own picker refused 400 of 400 draws at seven of the fourteen anchors,
 * and the census inside 45 m of the eye was 0 at four of them. The near field is
 * the only mechanism that can put an animal within touching distance, so at
 * tier 0 half the world is empty by construction and no amount of tuning the
 * radius, the shells or the target changes it.
 *
 * TIER 1 IS SAFE TO CONJURE AND TIER 2 IS NOT, and that is a property of the
 * records rather than a judgement call. `DANGER_BY_TIER[1]` is "Harms only on
 * contact or under direct provocation. Never pursues", and every one of the
 * eight tier-1 records agrees in its own `aggressionTrigger`: Spinecrown Urchin
 * "contact only", Bloatspine "never attacks", Bellflower Jelly "contact only",
 * Glassclaw "player inside 1.5 m for over 1.0 s, or damage taken", Hagline "only
 * defends", Veilmouth "none, ever. It cannot be aggroed", Ghostbell "none",
 * Sepulcher Louse "only if attacked". None of them can close on a player who
 * leaves them alone, so none of them can be the animal "the director put 30 m
 * behind their shoulder" - that sentence was about a hunter, and tier 2 is where
 * hunting starts.
 *
 * THE SAFE CHARTER IS UNAFFECTED, and not by assumption: `DANGER_BY_TIER[1]`
 * has `safeCharterLegal: false`, `_placeGroup` re-tests `charterMaxTier(x, z)`
 * at the position of every individual, and `_pickNearFieldSpecies` now takes the
 * min of this constant and the charter's own ceiling at the eye - so inside the
 * crater the near field still draws from tier 0 alone and does not even spend a
 * group slot discovering it.
 */
const NEARFIELD_MAX_TIER = 1;

/**
 * Shortest animal worth a near-field slot, metres. A 21 mm Glimmerkrill is
 * 1.3 px tall at 10 m on the QA canvas's measured 622 px/rad; spending near
 * field slots on it buys no picture at all.
 *
 * IT WENT 0.06 -> 0.10 WHEN THE PELAGIC ROSTER BECAME REACHABLE, and the
 * threshold turns out to decide what the near field mostly IS rather than to
 * trim its tail. The weight is sqrt(density) against a datasheet density that
 * falls as L^-3, so the SMALLEST legal species carries the largest weight in
 * every roster: merging the pelagic pseudo-habitat unconditionally exposed the
 * 0.07 m Veilmote at 110,000/km3 - the highest weight in the game - and MEASURED
 * in the primed lagoon it immediately took 34 of the near field's 160 slots,
 * 21%, for an animal 4.4 px long at 10 m. The same measurement showed the
 * largest school anywhere in that lagoon falling from 33 to 21: whatever the
 * near field holds is charged to a shared budget, so 34 slots of speck cost the
 * reef its shoal.
 *
 * 0.10 m clears the Veilmote and keeps the 0.11 m Coppersprat, which is the
 * shoaling animal the shallow reef is built around. There is nothing authored
 * between 0.07 and 0.11, so the constant has 40% of slack either way.
 */
const NEARFIELD_MIN_LENGTH = 0.10;

/** Schooling species are this much more likely to be picked. A shoal is what
 *  makes water read as inhabited; four solitary fish do not. */
const NEARFIELD_SHOAL_BIAS = 2.0;

/**
 * THE HERO SLOT: the near field guarantees ONE animal big enough to recognise,
 * because the weighted draw structurally cannot supply one.
 *
 * `_pickNearFieldSpecies` weights by sqrt(density), and the datasheets' density
 * falls with body length roughly as L^-3 (Coppersprat 90,000/km3 at 0.11 m,
 * Sandveil Ray 45/km3 at 1.30 m), so the weight goes as L^-1.5: it is a monotone
 * PREFERENCE FOR THE SMALLEST ANIMAL in the roster. MEASURED over 400 draws at
 * the reef anchor with the species counters cleared, which is the state a fill
 * starts from - Violet Wrasse 124, Coppersprat 108, Silverquill 57, Azuregraze
 * 38, Limebanner 31, Sunplate 22, Reefcropper 12, Ninearm 6, SANDVEIL RAY 2. The
 * one animal in that roster a player would call a ray gets 0.5% of the draws,
 * and the measured largest animal inside the ball after a prime was a 0.61 m
 * Azuregraze.
 *
 * That is the correct ECOLOGY and the wrong PICTURE, and the two do not have to
 * be traded off against each other: the fix is not to bend the weight - which
 * would make the water read as a zoo of oddities - but to reserve exactly one of
 * the NEARFIELD_GROUPS_PER_STEP slots for the largest species that is legal
 * here, and to stop reserving it the moment one is present. A rare animal stays
 * rare; it is just no longer ABSENT.
 *
 * This constant is the SATISFACTION threshold, and it is an angular argument. At
 * the QA canvas's measured 622 px/rad an animal seeded at the near field's own
 * touch radius (3 m) is 622*L/3 px of body length, so 0.60 m is 124 px and 0.30
 * m is 62; at the 20 m a hero is typically seeded at it is 19 px against 9.
 * Below about 0.6 m nothing in this roster has a silhouette anybody could name.
 * The threshold is additionally floored by 0.82 x the largest legal length -
 * 0.82 is the bottom of CreatureSim's spawn scale jitter - so a biome whose
 * largest legal animal is smaller than the threshold satisfies the slot with one
 * of those rather than filling the water with them forever.
 */
const NEARFIELD_HERO_MIN_LENGTH = 0.60;

/**
 * A tiny supporting cast of recognisable animals in the inner coverage shell.
 *
 * The hero slot solves absence of a single silhouette, but it does not change
 * the other 159 density-weighted picks. Four animals authored at 0.28 m or
 * longer are enough to make a turn of the camera reveal fins and body plans
 * rather than only sprat pixels. This is deliberately a COUNT, not a share, so
 * it stays a supporting cast at every band budget. The ordinary ecological
 * weights and species-share cap still choose them; if a biome has no legal
 * animal this large, the quota yields to the ordinary picker.
 */
const NEARFIELD_READABLE_MIN_LENGTH = 0.28;
const NEARFIELD_READABLE_TARGET = 4;
const NEARFIELD_READABLE_SHELL = 1;

/**
 * Where a hero is seeded: in its OWN body lengths, clamped into the annulus.
 *
 * 12 lengths is 52 px of body at 622 px/rad whatever the animal is, which is the
 * scale at which a silhouette reads. The lower clamp is the pop rule and is not
 * negotiable - a hero is seeded outside the hide radius like everything else, so
 * it arrives out of the haze rather than materialising in frame. The upper clamp
 * keeps it inside the counted ball so it is charged and censused the step it
 * lands.
 */
const NEARFIELD_HERO_RANGE_LENGTHS = 12;
const NEARFIELD_HERO_MAX_FRAC = 0.80;

/**
 * THE HERO IS THE ONE SEED THAT IS AIMED AT THE CAMERA, and that is the
 * difference between the feature working and being a coin toss.
 *
 * The near field's own CALIBRATION note measures the frustum's share of the ball
 * at 0.20 - 110 agents inside 45 m drew 22. That share is fine for a population
 * of 160: the twenty the player sees are drawn from the same distribution as the
 * hundred and forty they do not. It is useless for a population of ONE. A hero
 * seeded on a uniform bearing is in frame 20% of the time, so four anchors in
 * five would still photograph as empty water and the measurement would swing
 * with the draw - the lottery read this director exists to remove.
 *
 * Nothing in the pop rule is being bent to do it. That rule is "inside
 * NEARFIELD_HIDE_FRAC of the radius a seed must be off camera; beyond it the
 * haze does the hiding", and the hero is seeded strictly beyond it. Biasing the
 * BEARING of a seed the rule already permits in frustum costs the rule nothing.
 *
 * BEARING is +/- 26 deg, the central half of the camera's 53 deg horizontal
 * half-angle (fovY 75 deg at 16:9). ELEVATION is a tangent about the
 * horizon rather than a share of the ball's chord: at 25 m the chord is +/- 37 m,
 * which is +/- 56 deg of elevation against a 37.5 deg vertical half-angle, so an
 * unconstrained vertical draw throws away most of what the bearing just bought.
 * tan 20 deg keeps the hero inside the vertical frame for any arrival pitch the
 * teleport can produce (its own clamp is -0.05 to -0.62 rad).
 */
const NEARFIELD_HERO_BEARING = 0.45;
const NEARFIELD_HERO_TAN_ELEV = 0.364;

/**
 * THE PROWLER SLOT: the near field stages at most ONE tier-2/3 predator as an
 * EVENT, because NEARFIELD_MAX_TIER's own argument is correct and stays.
 *
 * That constant's docstring establishes that tier 2 is where hunting starts and
 * that a hunter must not be conjured at touch range behind the player's
 * shoulder. What it leaves unsolved is the other half of the measurement that
 * set it: everything above tier 1 arrives only by cell resolution at datasheet
 * density, and the datasheets author hunters at 40-900/km3 - MEASURED against
 * the 0.0084 km3 cell volume that is an expectation of 0.3-7.5 per cell ROLL,
 * thinned by depletion, the band budget and the frustum's 0.20 share, so the
 * biome's own apex resident is a rumour the average session never sees. The
 * bestiary's entire threat tier - Frondmaw in the kelp, Voltbarb on the sand,
 * Chiselfin off the shelf, Umbral Squid in the canyon, Saltwraith in the
 * trench - is authored, animated, armed and effectively unreachable.
 *
 * The slot reuses the hero slot's staging EXACTLY, because that staging is the
 * answer to the tier cap's objection: seeded strictly beyond the hide radius
 * (it arrives out of the haze, never materialises in frame), aimed into the
 * camera's central wedge (an encounter, not a lottery), one individual (the
 * datasheets stay in charge of populations), and the pop rule untouched. What
 * distinguishes it from the hero is WHEN: a cooldown makes it a beat the biome
 * plays a few times an hour, not a standing population - the hero fills an
 * absence, the prowler schedules a presence.
 *
 * Legality is the biome roster itself, which already encodes place danger: a
 * tier-3 species enters the candidate set only where some sampled biome
 * carries it and the depth band fits, exactly like every other draw. The
 * Safe Charter caps it at the eye AND per-individual in _placeGroup, so the
 * lagoon can never stage one. Tier 4-5 is excluded here by
 * NEARFIELD_PROWLER_MAX_TIER: leviathans are authored encounters
 * (abyss_encounter.js), not slot machines.
 *
 * The pick is an argmax over (tier, then length) rather than a density draw:
 * the slot exists to put the biome's APEX in frame, and a density weight would
 * hand it to the smallest hunter for the same L^-3 reason the hero slot
 * documents. Deterministic for a given legal set, like the hero.
 */
const NEARFIELD_PROWLER_MAX_TIER = 3;
/** Shortest predator worth the slot; everything tier >= 2 is authored >= 1.05 m
 *  today, so this is a guard against future small hunters, not a filter. */
const NEARFIELD_PROWLER_MIN_LENGTH = 0.8;
/** Seconds between staged encounters once one has left or died. */
const NEARFIELD_PROWLER_COOLDOWN = 75;
/** Seconds after prime()/teleport before the first encounter may stage: the
 *  biome reads first, the predator is its second beat. */
const NEARFIELD_PROWLER_FIRST = 20;
/** Retry delay when the water has no legal predator, so a roster that cannot
 *  supply one is not re-scanned every step. */
const NEARFIELD_PROWLER_RETRY = 25;
/** Presence radius in units of the near-field radius. A live tier >= 2 animal
 *  anywhere inside it satisfies the slot - including one cell resolution
 *  placed - so encounters never stack. Wider than NEARFIELD_RELEASE (1.25) on
 *  purpose: a predator that has drifted just past retirement range but is
 *  still working its way back is still this encounter, not the next one. */
const NEARFIELD_PROWLER_PRESENCE = 2.2;

/**
 * Largest share of the near field one species may hold.
 *
 * The director fills in groups of up to MAX_CPU_SCHOOL, so two lucky draws put
 * eighty animals of one species in the water before anything else is considered
 * - MEASURED across three runs of the same build, 96 Silverquill, then 81
 * Coppersprat, then 65 Violet Wrasse, whichever shoaler happened to be picked
 * first. At a third of the target the near field always holds at least three
 * species, which is what a reef looks like.
 */
const NEARFIELD_SPECIES_SHARE = 0.34;

/**
 * Fraction of a band's budget cell resolution keeps even in the band the eye is
 * in, so the background never disappears entirely behind the near field.
 *
 * Lowered from 0.34 with the sunlit re-scale. What the floor buys is animals
 * BEYOND the near field's radius. It is only ever charged while the eye is IN
 * the water: _cellBandBudget returns the whole band as soon as the player
 * surfaces or boards the vessel.
 *
 * THIS PARAGRAPH USED TO JUSTIFY THE CUT WITH ITS INEQUALITY THE WRONG WAY
 * ROUND. It said the near field's radius is 45 m in the lagoon's Jerlov IA
 * against a 1% contrast distance of 94.3 m, "so the cells' share is mostly
 * stocking water the player cannot see into" - but 45 < 94.3 means the reverse:
 * the annulus the cells stock is water the player CAN see into, and the near
 * field cannot reach. What is actually in it is the real reason the cut was
 * affordable and the real cost of it: 0.22 of BAND_BUDGET[1] reserves 42 slots,
 * they are spread over the whole 384 m streaming radius, and the 45-94 m annulus
 * is 4.6% of that disc - so the expected occupancy of the annulus is about TWO
 * animals if the cells ever held their 42.
 *
 * THEY DO NOT HOLD 42, AND THE RESERVATION IS NOT THE OCCUPANCY. The near
 * field's ALIVE population - the counted ball plus the wake out to
 * NEARFIELD_RELEASE - is charged to the same band, and it crowds the cells out
 * of most of what is reserved for them. MEASURED LIVE in the lagoon
 * (tools/probes/nearfield-band-occupancy.js), bandCellCount[1]: median 19 of 42
 * standing still and median 16, mean 11.7, min 0 while swimming, against a band
 * total of 169-185 of 192. So the real annulus expectation is 0.6-0.9 animals,
 * not 2. That is a known gap; extending NEARFIELD_MAX_R
 * to cover it costs (70/45)^3 = 3.8x the volume at the same density, for animals
 * subtending 3.6 px.
 */
const NEARFIELD_CELL_FLOOR = 0.22;

/**
 * Radius at which a reef fish fades into the veiling in-scatter, metres.
 *
 * Apparent contrast of a target of reflectance `A` at range r, against the
 * water's own path radiance, is
 *
 *     C(r) = A * T / (omega * (1 - T)),      T = exp(-sigmaT * r)
 *
 * where `omega = sigmaS / sigmaT` is the single-scattering albedo - the fraction
 * of every extinguished photon that comes back as veiling rather than being
 * absorbed. Solving C(R) = NEARFIELD_SPAWN_CONTRAST for R is one logarithm.
 *
 * The GREEN channel, because it is the one that survives: at the lagoon's
 * OCEANIC_CLEAR, sigmaT is [0.2630, 0.0680, 0.0415] and red is gone at 18 m
 * whatever the fish is coloured.
 *
 * MEASURED against the shipped water types: OCEANIC_CLEAR (the lagoon) 47.8 m,
 * clamped to 45; REEF_TURQUOISE (Jerlov IB) 20.8 m; COASTAL_GREEN 5.9 m, clamped
 * up to 14. The old Jerlov II REEF_TURQUOISE gave 13.5 m, which is why fish had
 * to be nearly touching the mask to be seen at all.
 *
 * @param {object} water a WATER_TYPES entry
 * @returns {number} metres, clamped to the director's own bounds
 */
export function nearFieldRadius(water) {
  const sigmaT = water.sigmaT[1];
  const omega = clamp(water.sigmaS[1] / Math.max(1e-6, sigmaT), 1e-3, 0.999);
  const cw = NEARFIELD_SPAWN_CONTRAST * omega;
  const r = -Math.log(cw / (NEARFIELD_FISH_ALBEDO + cw)) / Math.max(1e-6, sigmaT);
  return clamp(r, NEARFIELD_MIN_R, NEARFIELD_MAX_R);
}

/**
 * Respawn half-life by danger tier, in REAL seconds.
 *
 * bestiary.js quotes `respawnHalfLife` in GAME seconds, of which there are
 * 86,400 in a game day; this build's day is SKY.SECONDS_PER_DAY = 1,200 real
 * seconds, so the conversion is a factor of 72. That puts a tier-0 shoal back
 * in five real seconds and a tier-4 hunter back in ten real minutes, which is
 * exactly DESIGN/06.6.4's "shoals refill fast, leviathans are not a resource".
 * A non-finite entry never recovers within the session, which is the tier-5
 * rule.
 */
const GAME_TO_REAL = SKY.SECONDS_PER_DAY / 86400;
const RESPAWN_HALFLIFE = Float32Array.from(DANGER_BY_TIER,
  (d) => (Number.isFinite(d.respawnHalfLife) && d.respawnHalfLife > 0
    ? d.respawnHalfLife * GAME_TO_REAL : Infinity));

/** Depletion never exceeds this: the ocean is never completely emptied. */
const MAX_DEPLETION = 0.85;

/** Despawn distance by tier, metres. DESIGN/06.6.4. */
const DESPAWN_DISTANCE = Float32Array.of(600, 600, 600, 900, 1400, 1400);
/** An agent must have been off-camera this long before it may be despawned. */
const DESPAWN_UNSEEN = 6.0;

/** Behaviours that make an agent immune to despawn. */
const DESPAWN_IMMUNE = new Set([BEHAVIOUR.ATTACK, BEHAVIOUR.FLEE, BEHAVIOUR.FEED]);

// ===========================================================================
// Placement
// ===========================================================================

/** Placement modes. Derived from the species' archetype and flags. */
export const HABITAT = { PELAGIC: 0, BENTHIC: 1, LAND: 2, AIR: 3 };

/**
 * Biomes whose open water is a PELAGIC DEAD ZONE: the drifter roster
 * (Veilmouth, Chainlight, Wisplight, Umbral Squid...) is NOT merged into
 * their cells or their near field, whatever the water column over them.
 *
 * Founding member: the Sunken Dunes (2026-08-19, by user instruction -
 * "remove the beluga/whales from that biome and focus on the scary
 * creature"). The biome is a sighted ambush predator's hunting ground with
 * 121 m sightlines; delivered frames put an 18 m pale Veilmouth and pale
 * pelagic drifters in the same frame as the Splitmaw, in the same pale
 * palette, at comparable apparent size - prey-shaped noise that both
 * diluted the monster's scale read and contradicted the ecology (nothing
 * lingers over the bone field it would join). The emptiness is the biome's
 * own warning, which is also the reference game's Dunes design. Species
 * that carry the biome EXPLICITLY (the Splitmaw) are untouched.
 */
const PELAGIC_DEAD_ZONES = new Set([BIOMES.find((b) => b.short === 'dunes').id]);

/** Poisson-disc minimum separation as a multiple of body length, per habitat. */
const SEPARATION_FACTOR = Float32Array.of(2.5, 4.0, 3.0, 5.0);

/** Rejection attempts per placement before the candidate is abandoned. */
const PLACEMENT_ATTEMPTS = 12;

/**
 * The R2 low-discrepancy sequence's two irrational strides, 1/phi3 and 1/phi3^2
 * where phi3 is the plastic number. The near field uses them to stratify a
 * group's radius and bearing together; see _placeGroup.
 */
const R2_ALPHA1 = 0.7548776662466927;
const R2_ALPHA2 = 0.5698402909980532;

/**
 * Habitat a species is placed in.
 *
 * bestiary.js's HABITAT has ten modes; four of them (crevice, canopy, wall,
 * brineEdge) differ from `benthic` only in the surface CURVATURE or the surface
 * TYPE they attach to, and this build's placement mask has no concavity or
 * attachment-point query to distinguish them with - so they all resolve to
 * BENTHIC, which puts the animal on the seabed at the right slope limit.
 * `territory` resolves to PELAGIC: a leviathan's territory anchor is a point in
 * open water, and the anchor itself is the `homePos` the sim already keeps.
 *
 * @param {number} sp species index
 * @returns {number} HABITAT
 */
export function habitatOf(sp) {
  const rec = SPECIES_TABLE.records[sp];
  switch (rec && rec.habitat) {
    case 'air': return HABITAT.AIR;
    case 'land': return HABITAT.LAND;
    case 'benthic': case 'crevice': case 'canopy': case 'wall':
    case 'vent': case 'brineEdge':
      return HABITAT.BENTHIC;
    default: return HABITAT.PELAGIC;
  }
}

// ===========================================================================
// Spawner
// ===========================================================================

/** Packed cell key. 10 bits per axis is +/-131 km, far beyond the playfield. */
function cellKey(cx, cy, cz) {
  return ((cx & 0x3ff) << 20) | ((cy & 0x3ff) << 10) | (cz & 0x3ff);
}

/**
 * Population director.
 *
 * @example
 *   const spawner = new Spawner(sim, { seed });
 *   spawner.attach();                       // installs the charter enforcement
 *   spawner.update(dt, playerPos, worldClock);
 */
export class Spawner {
  /**
   * @param {import('./creatures.js').CreatureSim} sim
   * @param {object} [opts] {seed}
   */
  constructor(sim, { seed = WORLD.DEFAULT_SEED } = {}) {
    this.sim = sim;
    this.seed = seed >>> 0;
    this.rng = makeRng(this.seed ^ 0x5eed10);

    /** @type {Map<number, object>} instantiated cells, keyed by cellKey */
    this.cells = new Map();
    /** Next school id. Wraps at 32767 to stay inside the Int16Array. */
    this._nextSchool = 0;

    /** Concurrent counts, refreshed every update from the sim. */
    this.bandCount = new Int32Array(DEPTH_BANDS.length);
    /**
     * The same count restricted to agents CELL RESOLUTION placed.
     *
     * The near field's reservation cannot be enforced against `bandCount`,
     * because the near field's own animals are in it: with 110 near-field agents
     * in a band whose cell share is 66, every cell candidate is refused and the
     * background disappears entirely. MEASURED offline with the shared counter,
     * primed at the lagoon: band 1 held 110 agents and NONE of them came from a
     * cell. The two directors get one counter each; the hard BAND_BUDGET total
     * still applies to both.
     */
    this.bandCellCount = new Int32Array(DEPTH_BANDS.length);
    this.bandTier3 = new Int32Array(DEPTH_BANDS.length);
    this.bandTier4 = new Int32Array(DEPTH_BANDS.length);
    this.speciesCount = new Int32Array(SPECIES_TABLE.count);

    /** biome id -> Set of species indices the bestiary lists for it. */
    this._biomeCache = new Map();

    this.stats = {
      cells: 0, resolved: 0, retired: 0,
      spawnAttempts: 0, spawned: 0, rejected: 0, despawned: 0,
      /** Agents deleted for having drifted inside the station's hull. */
      habitatEvicted: 0,
      budgetPressure: 0, charterBlocked: 0, charterVetoes: 0,
      nearFieldCount: 0, nearFieldInner: 0, nearFieldReadable: 0,
      nearFieldSpawned: 0, nearFieldRetired: 0,
      nearFieldRadius: 0, nearFieldReclaimed: 0,
      /** Counted agents in the half-ball the eye is moving INTO, or -1 when the
       *  eye is too slow for its direction to mean anything. */
      nearFieldForward: -1,
      /** 1 while a live tier >= 2 animal is inside the prowler presence radius. */
      prowlerPresent: 0,
      /** Staged predators seeded by the prowler slot, lifetime. */
      prowlerSeeded: 0,
      msLast: 0, msPeak: 0,
    };

    /** Scratch for the legality filter, sized once. */
    this._legal = new Int32Array(SPECIES_TABLE.count);
    this._weight = new Float32Array(SPECIES_TABLE.count);
    /** The near field runs between _cull and _resolveNearest and must not share
     *  the cell resolver's scratch, or one day the two will interleave.
     *  `_nearLegal` holds the memoised legal set for the eye; `_nearPick` is the
     *  weighted selector's own compaction of it, which changes between picks as
     *  species fill up and so must not overwrite the memo. */
    this._nearLegal = new Int32Array(SPECIES_TABLE.count);
    this._nearPick = new Int32Array(SPECIES_TABLE.count);
    this._nearWeight = new Float32Array(SPECIES_TABLE.count);
    /** Per-species census of what the DIRECTOR has alive, refilled every step by
     *  _maintainNearField. NEARFIELD_SPECIES_SHARE is charged against this and
     *  not against the world count; see _nearFieldRoom. */
    this._nearSpecies = new Int32Array(SPECIES_TABLE.count);
    /** Memo for _nearFieldLegal: the eye and radius it was computed for, and how
     *  many entries of _nearLegal are valid. A step asks for the same set two or
     *  three times (two picks and a hero nomination) and it costs five terrain
     *  samples to build. -1 is "nothing computed". */
    this._nearLegalN = -1;
    this._nearLegalX = 0;
    this._nearLegalY = 0;
    this._nearLegalZ = 0;
    this._nearLegalR = -1;

    /**
     * 1 for a slot the near-field director seeded. Written on EVERY spawn, 1 or
     * 0, so a recycled slot can never inherit the previous animal's flag.
     */
    this._nearFieldSlot = new Uint8Array(sim.capacity);
    /** Seconds until the prowler slot may stage. Ticked in update() - never in
     *  prime(), which calls _maintainNearField in a loop with no camera and
     *  must not burn the first encounter on an unaimed, unseen seed. */
    this._prowlerCooldown = NEARFIELD_PROWLER_FIRST;
    /** Last step's presence answer, read by update()'s cooldown tick. */
    this._prowlerPresent = false;
    /**
     * True while the eye is inside a sealed dry volume that sits below sea
     * level - today, the Pelagos Habitat. Owned by main.js, which reads the
     * airlock's own latch. See the note in _updateNearFieldGeometry.
     */
    this.inDryInterior = false;
    /** The near field's live geometry, refreshed once per update. */
    this._nearRadius = 0;
    // Infinity, not 0, and _updateNearFieldGeometry's three early returns put it
    // back to Infinity for the same reason. _cull reads it unconditionally, so
    // at 0 the retirement test `d > this._nearRelease` is `d > 0` and would
    // retire EVERY near-field agent at any distance. Infinity retires nothing,
    // which is the only safe reading of a radius that describes no live
    // geometry.
    this._nearRelease = Infinity;
    this._eyeBand = -1;
    /**
     * True while the EYE is inside a carved cave void, refreshed by
     * _updateNearFieldGeometry from the volumetric field itself. It is the
     * gate on everything cave-shaped in this file: the CAVE pseudo-habitat
     * merge, the cave placement branch in _placeGroup, and the
     * _columnPlaceable bypass. False everywhere the caves do not exist, so
     * every offline suite that never enters one runs byte-identical.
     */
    this._eyeInCave = false;
    this._nearRegion = {
      x: 0, y: 0, z: 0, rMin: 0, rMax: 0, rTouch: 0,
      rDrawMin: 0, rDraw: 0, hide2: 0, seq: 0, camera: null,
      leadX: 0, leadZ: 0, leadR: 0,
    };
    /** Filtered HORIZONTAL velocity of the centre update() is handed, and the
     *  unit direction and speed derived from it. There is no y lane: the lead is
     *  horizontal by construction and the only consumer of a vertical rate is
     *  the teleport guard, which uses the raw difference. Preallocated:
     *  _placeGroup and the counting loop run per step. */
    this._centrePrev = null;
    this._centreVelX = 0;
    this._centreVelZ = 0;
    this._leadDir = new Float32Array(3);
    this._leadSpeed = 0;

    this._attached = false;
    this._onMined = null;
    this._onDespawn = null;
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  /**
   * Install the charter's second and third enforcement levels on the sim, and
   * subscribe to the world events that change the population.
   *
   * @param {object} [hooks] {onPlayerDamage} forwarded to the sim
   */
  attach(hooks = {}) {
    if (this._attached) return this;
    this._attached = true;

    // LEVEL 2: the movement barrier. The sim applies this as a steering force.
    this.sim.setCharter(CHARTER);

    // LEVEL 3: the damage veto. Returns true to DROP the damage event.
    this.sim.damageVeto = (x, y, z) => {
      if (!insideCharter(x, z)) return false;
      this.stats.charterVetoes++;
      // A veto firing means level 1 or level 2 has a hole. Say so loudly: this
      // is the belt-and-braces check that should never trigger.
      console.error('[spawner] SAFE CHARTER DAMAGE VETO fired at ' +
        `(${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}) - a tier > 0 agent ` +
        'reached the crater. Levels 1 and 2 have a bug.');
      return true;
    };

    if (hooks.onPlayerDamage) this.sim.onPlayerDamage = hooks.onPlayerDamage;

    // Harvesting an organic node injects scent and locally depletes nothing,
    // but MINING a rock in a cell is how the player learns a cell is a place;
    // the depletion counter is what makes that stick.
    this._onMined = ({ position }) => {
      if (!position) return;
      const cell = this.cells.get(this._keyForPosition(position[0], position[1], position[2]));
      if (cell) cell.visited = true;
    };
    events.on(EVENTS.RESOURCE_MINED, this._onMined);

    // DEPLETION. A creature that DIES in a cell suppresses its species there
    // until the respawn half-life has run; one that merely wanders out of range
    // does not, or the ocean would empty out behind a player who never touched
    // anything. That is why the reason matters and why the sim reports it.
    this._onDespawn = ({ speciesIndex, position, reason }) => {
      if (reason !== 'killed' && reason !== 'eaten') return;
      if (position === undefined || speciesIndex === undefined) return;
      this.noteDeath(speciesIndex, position[0], position[1], position[2]);
    };
    events.on(EVENTS.CREATURE_DESPAWN, this._onDespawn);

    // EVERY spawn resets the slot's near-field flag, whoever spawned it. The
    // flag is otherwise written only by _placeGroup ("written on EVERY spawn"
    // is true only of spawns the SPAWNER makes), and CreatureSim's free list
    // is a LIFO stack dominated by near-field churn - so a direct sim.spawn()
    // (the abyss encounter, a leviathan residency) very likely recycles a slot
    // whose flag is still 1. A stale 1 put a tier-4 resident on _cull's
    // near-field retirement radius (~56 m), a six-second despawn/respawn
    // treadmill that reset its patrol forever; the tier guard at the reclaim
    // test does not cover nearOut. The event fires inside sim.spawn(), BEFORE
    // _placeGroup's own write of 1, so director spawns are order-safe.
    this._onSpawn = ({ id }) => { this._nearFieldSlot[id & 0xffff] = 0; };
    events.on(EVENTS.CREATURE_SPAWN, this._onSpawn);
    return this;
  }

  /** Remove the event subscriptions. */
  detach() {
    if (this._onMined) events.off(EVENTS.RESOURCE_MINED, this._onMined);
    if (this._onDespawn) events.off(EVENTS.CREATURE_DESPAWN, this._onDespawn);
    if (this._onSpawn) events.off(EVENTS.CREATURE_SPAWN, this._onSpawn);
    this._onMined = null;
    this._onDespawn = null;
    this._onSpawn = null;
    this._attached = false;
  }

  _keyForPosition(x, y, z) {
    return cellKey(Math.floor(x / CELL_X), Math.floor(y / CELL_Y), Math.floor(z / CELL_Z));
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  /**
   * Stream cells, retire distant ones, decay depletion and cull agents that
   * satisfy every despawn condition.
   *
   * @param {number} dt seconds
   * @param {ArrayLike<number>} playerPos absolute world position
   * @param {object} [worldClock] for the diel activity multiplier
   */
  update(dt, playerPos, worldClock = null) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._census();
    this._updateCentreVelocity(dt, playerPos);
    this._retire(playerPos);
    this._decay(dt);
    this._updateNearFieldGeometry(playerPos);
    this._cull(playerPos);
    // The prowler clock. Held at FULL while a predator is present, so the next
    // encounter is timed from the moment this one ends, whatever ends it -
    // death, retirement, or the player leaving. Reads LAST step's presence,
    // which at a 75 s timescale is the same answer. Gated on a live near
    // field so the first beat is counted in SUBMERGED time - a player who
    // sits on the surface past the cooldown must not be met by a predator on
    // their first census step underwater.
    if (this._nearRadius > 0) {
      if (this._prowlerPresent) this._prowlerCooldown = NEARFIELD_PROWLER_COOLDOWN;
      else this._prowlerCooldown -= dt;
    }
    // BEFORE _resolveNearest, and that ordering is the whole reason the near
    // field ever gets a slot: both draw on the same band budget, and a cell
    // 380 m away that spent it is a cell whose animals nobody will ever see.
    this._maintainNearField(playerPos, worldClock);
    this._resolveNearest(playerPos, worldClock);
    this.stats.cells = this.cells.size;
    const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    this.stats.msLast = ms;
    if (ms > this.stats.msPeak) this.stats.msPeak = ms;
  }

  /** Recount the live population by band, tier and species. */
  _census() {
    this.bandCount.fill(0);
    this.bandCellCount.fill(0);
    this.bandTier3.fill(0);
    this.bandTier4.fill(0);
    this.speciesCount.fill(0);
    const sim = this.sim;
    const live = sim.liveSlots();
    for (let k = 0; k < live.length; k++) {
      const i = live[k];
      const band = depthBandIndex(Math.max(0, -sim.posY[i]));
      this.bandCount[band]++;
      if (this._nearFieldSlot[i] === 0) this.bandCellCount[band]++;
      if (sim.tier[i] >= 3) this.bandTier3[band]++;
      if (sim.tier[i] >= 4) this.bandTier4[band]++;
      this.speciesCount[sim.species[i]]++;
    }
  }

  /** Retire cells outside the retirement radius. */
  _retire(playerPos) {
    if (!playerPos) return;
    for (const [key, cell] of this.cells) {
      const dx = cell.centerX - playerPos[0];
      const dy = cell.centerY - playerPos[1];
      const dz = cell.centerZ - playerPos[2];
      if (Math.hypot(dx, dz) > CELL_RETIRE_XZ || Math.abs(dy) > CELL_RETIRE_Y) {
        // The RECORD survives retirement - that is what makes depletion
        // persistent - but it stops being a candidate for resolution.
        cell.resolved = false;
        cell.retired = true;
        this.stats.retired++;
        // Only drop the record entirely if the player has never engaged with
        // the cell. A cell they fished out is worth the 40 bytes.
        if (!cell.visited && cell.killed === 0) this.cells.delete(key);
      }
    }
  }

  /** Decay every cell's depletion counters toward zero. */
  _decay(dt) {
    for (const cell of this.cells.values()) {
      const d = cell.depletion;
      if (!d) continue;
      for (let s = 0; s < d.length; s++) {
        if (d[s] <= 0) continue;
        const hl = RESPAWN_HALFLIFE[SPECIES_TABLE.tier[s]];
        if (!Number.isFinite(hl)) continue;   // tier 5 never recovers in-session
        d[s] *= Math.pow(0.5, dt / hl);
        if (d[s] < 1e-4) d[s] = 0;
      }
    }
  }

  /**
   * Despawn agents that satisfy ALL FOUR of DESIGN/06.6.4's conditions. The
   * conjunction is the point: any one of them alone would pop a creature out
   * of existence while the player was looking at it.
   */
  _cull(playerPos) {
    if (!playerPos) return;
    const sim = this.sim;
    const live = sim.liveSlots();

    // BUDGET MIGRATION toward the water the player is actually in.
    //
    // The band budget is spent by whoever asks first, and prime() asks first: it
    // resolves 28 cells while the player is still on the beach, where there is
    // no eye in the water and so no near-field reservation for _cellBandBudget
    // to apply. Everything below is a no-op unless the near field is BOTH short
    // AND unable to fit its shortfall in what is left of the band, so a band
    // with room is never disturbed. stats.nearFieldCount is last step's, which
    // is the only count that exists before _maintainNearField runs.
    const eb = this._eyeBand;
    const shortfall = eb >= 0 ? this._nearFieldTarget(eb) - this.stats.nearFieldCount : 0;
    const reclaimBeyond = this._nearRelease * NEARFIELD_RECLAIM_MULT;
    // Exactly the shortfall and no more: the far background is thin cover, but
    // it is still cover, and emptying the whole band to fill a 45 m ball would
    // trade one empty ocean for another.
    let reclaimBudget = shortfall > 0 && BAND_BUDGET[eb] - this.bandCount[eb] < shortfall
      ? shortfall - Math.max(0, BAND_BUDGET[eb] - this.bandCount[eb]) : 0;

    for (let k = 0; k < live.length; k++) {
      const i = live[k];
      const tier = sim.tier[i];
      const d = Math.hypot(sim.posX[i] - playerPos[0], sim.posY[i] - playerPos[1],
        sim.posZ[i] - playerPos[2]);
      // A near-field animal is retired at ITS OWN radius, not at 600 m: the
      // director exists to keep a fixed population inside the seeing distance,
      // and one that has fallen 70 m behind is a slot the water in front of the
      // player needs. The unseen and behaviour guards below still apply, so
      // nothing vanishes on camera and nothing mid-flight is deleted.
      // THE STATION IS SOLID TO ANIMALS. The world does not know it is there:
      // agents are streamed into world cells and steered by open-water rules, so
      // one that drifts into the hull swims straight through it and, from inside
      // the commons, drifts across the floor and the furniture. Retired
      // unconditionally - ahead of every guard below, including the unseen and
      // behaviour immunities, because "not on camera" is exactly wrong here: the
      // animal is INSIDE a room the player is standing in.
      if (insideHabitatVolume(sim.posX[i], sim.posY[i], sim.posZ[i], 0.6)) {
        const b = depthBandIndex(Math.max(0, -sim.posY[i]));
        this.stats.habitatEvicted++;
        sim.despawn(sim.handleOf(i), 'despawn');
        this.bandCount[b]--;
        if (this._nearFieldSlot[i] === 0) this.bandCellCount[b]--;
        this.speciesCount[sim.species[i]]--;
        this.stats.despawned++;
        continue;
      }
      // The Splitmaw's hunting ground evicts WANDER-INS the placement
      // rejection never saw (a drifter spawned legally past the rim swims
      // over the arena within minutes). Tier < 3 only (the cull already
      // leaves tier 3+ alone below, and the resident itself is tier 5), and
      // gated on 2 s unseen so an animal in frame fades behind the haze
      // before it vanishes - the residency's own no-pop rule, tightened
      // because unlike a release this is a boundary the animal keeps
      // crossing while it drifts deeper into the arena.
      if (sim.tier[i] < 3 && sim.unseenT[i] >= 2
          && insideSplitmawHuntingGround(sim.posX[i], sim.posY[i], sim.posZ[i])) {
        const b = depthBandIndex(Math.max(0, -sim.posY[i]));
        sim.despawn(sim.handleOf(i), 'despawn');
        this.bandCount[b]--;
        if (this._nearFieldSlot[i] === 0) this.bandCellCount[b]--;
        this.speciesCount[sim.species[i]]--;
        this.stats.despawned++;
        continue;
      }
      const nearOut = this._nearFieldSlot[i] === 1 && d > this._nearRelease;
      const band = depthBandIndex(Math.max(0, -sim.posY[i]));
      // Tier 3+ is left alone: a leviathan holds its budget wherever it is, and
      // a lagoon full of sprats must never be able to evict one.
      const reclaim = reclaimBudget > 0 && !nearOut && band === eb && tier <= 2 &&
        this._nearFieldSlot[i] === 0 && d > reclaimBeyond;
      if (!nearOut && !reclaim && d <= DESPAWN_DISTANCE[tier]) continue;
      if (sim.unseenT[i] < DESPAWN_UNSEEN) continue;
      if (DESPAWN_IMMUNE.has(sim.behaviour[i])) continue;
      const over = this.bandCount[band] > BAND_BUDGET[band] * 1.15;
      const cell = this.cells.get(this._keyForPosition(sim.posX[i], sim.posY[i], sim.posZ[i]));
      if (!nearOut && !reclaim && !over && cell && cell.resolved) continue;
      sim.despawn(sim.handleOf(i), 'despawn');
      this.bandCount[band]--;
      if (this._nearFieldSlot[i] === 0) this.bandCellCount[band]--;
      this.speciesCount[sim.species[i]]--;
      this.stats.despawned++;
      if (nearOut) this.stats.nearFieldRetired++;
      if (reclaim) { this.stats.nearFieldReclaimed++; reclaimBudget--; }
    }
  }

  /** Resolve the nearest unresolved cell inside the active radius. */
  _resolveNearest(playerPos, worldClock) {
    if (!playerPos) return;
    const c0x = Math.floor((playerPos[0] - CELL_ACTIVE_XZ) / CELL_X);
    const c1x = Math.floor((playerPos[0] + CELL_ACTIVE_XZ) / CELL_X);
    const c0z = Math.floor((playerPos[2] - CELL_ACTIVE_XZ) / CELL_Z);
    const c1z = Math.floor((playerPos[2] + CELL_ACTIVE_XZ) / CELL_Z);
    const c0y = Math.floor((playerPos[1] - CELL_ACTIVE_Y) / CELL_Y);
    const c1y = Math.floor((playerPos[1] + CELL_ACTIVE_Y) / CELL_Y);

    let bestCx = 0, bestCy = 0, bestCz = 0, bestD = Infinity;
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cz = c0z; cz <= c1z; cz++) {
        for (let cx = c0x; cx <= c1x; cx++) {
          const key = cellKey(cx, cy, cz);
          const existing = this.cells.get(key);
          if (existing && existing.resolved) continue;
          const centerX = cx * CELL_X + CELL_X * 0.5;
          const centerY = cy * CELL_Y + CELL_Y * 0.5;
          const centerZ = cz * CELL_Z + CELL_Z * 0.5;
          const d = Math.hypot(centerX - playerPos[0], centerY - playerPos[1],
            centerZ - playerPos[2]);
          if (d > CELL_ACTIVE_XZ) continue;
          if (d < bestD) { bestD = d; bestCx = cx; bestCy = cy; bestCz = cz; }
        }
      }
    }
    if (bestD === Infinity) return;
    this.resolveCell(bestCx, bestCy, bestCz, worldClock);
    this.stats.resolved++;
  }

  // -------------------------------------------------------------------------
  // Near field
  // -------------------------------------------------------------------------

  /**
   * Filter the velocity of the centre `update()` was handed, and derive the
   * horizontal travel direction the leading-edge quota seeds along.
   *
   * IT FINITE-DIFFERENCES THE CENTRE RATHER THAN READING sim._ctx.playerVel,
   * and that is deliberate: main.js passes `player.inVessel ? vessel.position :
   * player.position`, so differencing the value the ball is actually centred on
   * is the only way the lead is guaranteed to belong to the same body. It also
   * needs no signature change, no reach into the sim's context, and it
   * degrades to exactly zero in prime() and in every offline suite that calls
   * update() with a fixed eye - which is what keeps the seeding draw
   * byte-identical there.
   *
   * @param {number} dt seconds
   * @param {ArrayLike<number>} centre the same position update() was handed
   */
  _updateCentreVelocity(dt, centre) {
    if (!centre || !(dt > 0)) { this._leadSpeed = 0; return; }
    if (!this._centrePrev) {
      this._centrePrev = Float32Array.of(centre[0], centre[1], centre[2]);
      this._leadSpeed = 0;
      return;
    }
    const p = this._centrePrev;
    const vx = (centre[0] - p[0]) / dt;
    const vy = (centre[1] - p[1]) / dt;
    const vz = (centre[2] - p[2]) / dt;
    p[0] = centre[0]; p[1] = centre[1]; p[2] = centre[2];
    // A teleport is not a velocity. Written as a negated `<` so a NaN, which
    // compares false against everything, is discarded too. This is the ONLY
    // place the vertical rate is used - it belongs in the magnitude, because a
    // 400 m drop is as much a teleport as a 400 m slide.
    if (!(Math.hypot(vx, vy, vz) < NEARFIELD_LEAD_MAX_SPEED)) {
      this._centreVelX = 0; this._centreVelZ = 0;
      this._leadSpeed = 0;
      return;
    }
    // HORIZONTAL ONLY, and the vertical lane is not filtered at all rather than
    // filtered and ignored. _placeGroup's region draw is a horizontal (r, th)
    // draw whose y every habitat branch assigns for itself, so a vertical lead
    // would have to move region.y - which the pelagic branch resamples over, and
    // which is exactly how the region's vertical draw came to be dead code once
    // before. A purely vertical descent therefore gets no lead and does not need
    // one: 4 m/s crosses the lagoon's 14.5 m column in under four seconds, at
    // which point the band and the water type have changed and the field
    // re-forms anyway.
    const a = 1 - Math.exp(-dt / NEARFIELD_LEAD_TAU);
    this._centreVelX += (vx - this._centreVelX) * a;
    this._centreVelZ += (vz - this._centreVelZ) * a;
    const s = Math.hypot(this._centreVelX, this._centreVelZ);
    this._leadSpeed = s;
    if (s > 1e-6) {
      this._leadDir[0] = this._centreVelX / s;
      this._leadDir[2] = this._centreVelZ / s;
    } else {
      this._leadDir[0] = 0; this._leadDir[2] = 0;
    }
  }

  /**
   * Refresh the near field's radius, retirement radius and seeding annulus from
   * where the eye actually is. One terrain sample and one water lookup.
   *
   * The radius is a function of the LOCAL WATER, not a constant, so animals
   * always arrive at the edge of visibility whatever the optics do: raise the
   * reef's clarity and they spread out, drop it and they close in.
   */
  _updateNearFieldGeometry(playerPos) {
    // Each early return clears the WHOLE of the near field's geometry, the lead
    // and the retirement radius included. The lead so that a player who surfaces
    // or boards cannot leave a stale travel direction behind for the step after
    // they dive again; _nearRelease because _cull reads it unconditionally and
    // would otherwise go on retiring near-field agents at the LAST dive's
    // radius, which after NEARFIELD_RELEASE fell to 1.25 is 56.25 m rather than
    // the 69.75 m it used to be. Infinity means "no near field here retires
    // nothing", which is the only safe reading of a radius that describes no
    // live geometry. `reclaim` is already off in this case because it needs
    // `band === this._eyeBand` and the band is -1.
    if (!playerPos) {
      this._nearRadius = 0; this._eyeBand = -1; this.stats.nearFieldRadius = 0;
      this._nearRelease = Infinity; this._leadSpeed = 0;
      this._eyeInCave = false; return;
    }
    // A DRY VOLUME BELOW SEA LEVEL IS STILL DRY, and the heightfield cannot see
    // one. The Pelagos Habitat's rooms sit at -33 m, so every geometric test
    // below says "deep water with a floor 10 m under it" and the near-field
    // director duly seeded a ball of animals around a player standing in the
    // commons: measured, 77 near-field agents with 14 inside the counted radius,
    // rendering as fish drifting through a pressurised room. `inDryInterior` is
    // written by main.js from the airlock's own latch, which is the authority on
    // this - see the habitat clause in CLAUDE.md.
    //
    // THIS EARLY RETURN SETS `_nearRelease` TO ZERO, and it is the only one that
    // does. The others mean "there is no near field HERE", where retiring at the
    // last dive's radius would be wrong, so Infinity - retire nothing - is the
    // safe reading. This one means "the animals that are already seeded are
    // inside a building", and freezing them is exactly the bug: measured, a shot
    // list that walked the site and then cycled the airlock left 77 near-field
    // agents alive, and they rendered as fish drifting across the commons floor.
    // `d > 0` retires every one of them on the next cull.
    // NOT AN EARLY RETURN ANY MORE. It used to clear the whole near field and
    // set `_nearRelease` to zero, which retires every near-field agent on the
    // next cull - and that was right while the station's windows were opaque
    // paintings. With glass that transmits it is the wrong answer to the wrong
    // question: measured at the commons eye point, 154 animals were alive around
    // the station from outside and ALL 154 of them were the director's, because
    // the 62 m construction clearing leaves the ordinary cell-streamed
    // population with nothing to put here. Standing inside, the count was ZERO -
    // so the new windows looked onto empty water.
    //
    // What the early return was actually protecting against is animals inside
    // the ROOM, and there are already two mechanisms for that: _placeGroup
    // rejects any candidate inside insideHabitatVolume(), and _cull evicts one
    // that drifts in. The third is below - the seeding ball's inner radius is
    // pushed clear of the hull, so the director spends its attempts on water it
    // can actually use instead of having them rejected against the drum it is
    // standing in.
    const x = playerPos[0], y = playerPos[1], z = playerPos[2];
    // The eye must be IN water, with a floor under it. A vessel 400 m up has no
    // near field, and neither does a player standing on the beach.
    if (y > -0.5) {
      this._nearRadius = 0; this._eyeBand = -1; this.stats.nearFieldRadius = 0;
      this._nearRelease = Infinity; this._leadSpeed = 0;
      this._eyeInCave = false; return;
    }
    // INSIDE A CAVE THE HEIGHTFIELD IS A ROOF, NOT A FLOOR. Every geometric
    // test below reads terrain height as "the ground under the eye", and for
    // an eye inside the volumetric override that surface is 60-160 m ABOVE
    // it - so the floor lift would hoist the ball's centre out of the chamber
    // into solid rock (measured at the First Hollow chamber: eye -665.7,
    // heightfield -603, lifted centre -601). The volumetric field is the
    // authority on "is this point in open water", so ask it once per update;
    // when it says yes, the ball stays centred on the eye and every candidate
    // is tested against the void in _placeGroup instead of against a column.
    this._eyeInCave = isInsideCave(x, y, z);
    const ground = terrain.sampleHeightFast(x, z);
    // A DIVER ON THE SEABED IS IN WATER, AND THE BALL IS LIFTED RATHER THAN
    // REFUSED. This used to be `if (ground > y - 0.25) return`, and it turned
    // the whole near field off for the most ordinary thing a player does -
    // swimming down to look at the bottom. MEASURED LIVE, unpinned, after a jump
    // and 2.6 s of settling: the diver's own position ends up -0.37 to +0.20 m
    // relative to the seabed at Sand Plains, Kelp Forest, Boulder Field and the
    // Shelf Break, so FOUR of the eight anchors measured reported radius 0,
    // eyeBand -1 and nearFieldCount 0 - an ocean floor with no animals on it, at
    // exactly the range the near field exists to cover. (Two things make the
    // seabed the normal case rather than the edge one: the position handed here
    // is the FEET, and the arrival hover is a function of the water's own
    // clarity.) It is also sampled with sampleHeightFast while the caller's y
    // came from sampleHeight or from the contact solver, and the two disagree by
    // centimetres, so the old test was a coin toss within its own noise.
    //
    // The centre is therefore raised to NEARFIELD_FLOOR_CLEARANCE above the
    // floor. What the test still refuses is the case it was written for: a
    // column too thin to hold the clearance at all, which is a puddle or the
    // inside of a hill.
    const cy = this._eyeInCave ? y : Math.max(y, ground + NEARFIELD_FLOOR_CLEARANCE);
    if (cy > -0.5) {
      this._nearRadius = 0; this._eyeBand = -1; this.stats.nearFieldRadius = 0;
      this._nearRelease = Infinity; this._leadSpeed = 0; return;
    }

    const depth = Math.max(0, -cy);
    // sampleSlope, not the 0 waterTypeAt used to force: with the slope hidden
    // the kelp and boulder records could never be dominant, so the seeding
    // radius over a kelp bed was REEF_TURQUOISE's 20.8 m rather than
    // COASTAL_GREEN's 14.0 m - the director spread fish out to where the water
    // it is standing in cannot show them.
    // NO terrain argument, on purpose: the smoothed classification flips the
    // radius 45 <-> 21 m a handful of times over a 180 m swim, and every flip
    // is a retire/seed burst - measured 12.71 seeds/s against the 12/s
    // treadmill ceiling in test-creatures, against 7.42 centre-only. The
    // pooled+margin-guarded centre answer agrees with the rendered (smoothed)
    // water on ~99% of the kelp bed and 100% of the lagoon path, so the radius
    // still follows the water it is standing in.
    const R = nearFieldRadius(waterTypeAt(x, z, ground, depth, terrain.sampleSlope(x, z)));
    this._nearRadius = R;
    this._nearRelease = R * NEARFIELD_RELEASE;
    this._eyeBand = depthBandIndex(depth);
    this.stats.nearFieldRadius = R;

    const region = this._nearRegion;
    // The LIFTED centre, and everything that measures the near field reads it
    // from here so the census and the seeding can never disagree about where the
    // ball is. `_cull` is the one exception and deliberately so: it retires on
    // the raw position at 1.25 R, and the lift is at most 2 m inside a 0.25 R
    // hysteresis gap that is 3.5 m at the smallest radius in the game.
    region.x = x; region.y = cy; region.z = z;
    // Inside a pressure hull the close shells are all wall. NEARFIELD_SHELLS puts
    // 43% of the group slots inside 0.45 R, which at the station's 20.8 m is
    // 9.4 m - most of it inside the commons drum (r 6.60) or the corridors
    // leaving it. Pushing the floor out past the widest module keeps those slots
    // in open water where they can be seen through the glass, instead of feeding
    // them to _placeGroup's habitat rejection. It is a floor, never a ceiling:
    // rMax is untouched, so the population target does not move.
    const hullClear = this.inDryInterior ? NEARFIELD_HULL_CLEARANCE : 0;
    region.rMin = Math.min(Math.max(R * NEARFIELD_INNER, hullClear), R * 0.75);
    region.rMax = R;
    region.rTouch = Math.max(NEARFIELD_TOUCH_R, R * NEARFIELD_TOUCH_FRAC);
    region.rDrawMin = region.rMin;
    region.rDraw = R;
    region.leadX = this._leadDir[0];
    region.leadZ = this._leadDir[2];
    region.leadR = 0;                 // per-group; _maintainNearField sets it
    // The hero's aim, also per-group. Zero spread means "draw the bearing the
    // ordinary way", which is what every non-hero group and every offline suite
    // gets. See NEARFIELD_HERO_BEARING.
    region.aimX = 0; region.aimZ = 0;
    region.aimSpread = 0; region.aimTanElev = 0;
    // Extra headroom against BAND_BUDGET for THIS group only. Zero for every
    // ordinary draw; the prowler sets 1 around its own attempts. See the band
    // check in _placeGroup.
    region.budgetSlack = 0;
    // The region is a BALL of radius R, not a cylinder: the vertical extent a
    // candidate may use narrows to sqrt(R^2 - r^2) at horizontal radius r, and
    // _placeGroup intersects that with the species' own legal slab rather than
    // drawing a y and letting the habitat branch overwrite it. The previous
    // form drew a y here from the water column's half-height and it was DEAD
    // CODE - the pelagic branch resampled over the species' whole depth range a
    // few lines later.
    // The camera the sim was last handed. Used ONLY to refuse to seed inside the
    // frustum: in OCEANIC_CLEAR a fish appearing at 30 m is at 44% contrast and
    // would visibly pop into existence. There is no camera in the offline tests
    // and the director degrades to the annulus rule alone, which is why the
    // annulus has an inner edge at all.
    region.camera = (this.sim._ctx && this.sim._ctx.camera) || null;
  }

  /**
   * How many agents the near field maintains inside its radius, in a band.
   *
   * Capped by the band's own budget less the floor cell resolution keeps, so
   * the trench's 24 slots cannot all be spent on a swarm around the vessel.
   */
  _nearFieldTarget(band) {
    if (band < 0) return 0;
    const budget = BAND_BUDGET[band];
    return Math.min(NEARFIELD_TARGET, budget - Math.round(budget * NEARFIELD_CELL_FLOOR));
  }

  /**
   * A band's budget as CELL RESOLUTION sees it.
   *
   * The band the eye is in reserves the near field's target, because prime()
   * resolves 28 cells before the first frame ever renders and would otherwise
   * spend the whole sunlit budget on water 380 m away.
   */
  _cellBandBudget(band) {
    return band === this._eyeBand
      ? BAND_BUDGET[band] - this._nearFieldTarget(band)
      : BAND_BUDGET[band];
  }

  /**
   * Top the near field up toward its target. Returns agents spawned.
   *
   * @param {ArrayLike<number>} playerPos
   * @param {object} [worldClock]
   */
  _maintainNearField(playerPos, worldClock = null) {
    const R = this._nearRadius;
    if (!(R > 0) || !playerPos) { this.stats.nearFieldCount = 0; return 0; }
    const sim = this.sim;
    const st = SPECIES_TABLE;
    const target = this._nearFieldTarget(this._eyeBand);
    // THE BALL'S CENTRE, not the raw position: _updateNearFieldGeometry lifts it
    // clear of the seabed, and a census taken about a different point from the
    // one the seeds are drawn about would report a population that is not the
    // one being maintained.
    const px = this._nearRegion.x, py = this._nearRegion.y, pz = this._nearRegion.z;

    // Count what is ALREADY there, whatever put it there. A cell that happens to
    // have dropped a shoal at the player's feet is exactly as good as one the
    // director seeded, and double-counting it would overfill the band.
    const live = sim.liveSlots();
    const R2 = R * R;
    for (let s = 0; s < NEARFIELD_SHELLS.length; s++) {
      const rs = R * NEARFIELD_SHELLS[s][0];
      _shellR2[s] = rs * rs;
      _shellCount[s] = 0;
    }
    // The along-track half the eye is moving INTO, counted in the same pass.
    // See NEARFIELD_FORWARD_SHARE: a co-moving seed disc with no inflow at its
    // leading edge has a density ramp that is exactly zero at the front, and
    // this is the count that closes it.
    const leadOn = this._leadSpeed >= NEARFIELD_LEAD_SPEED;
    const ldx = this._leadDir[0], ldz = this._leadDir[2];
    let near = 0, forward = 0, biggest = 0, readable = 0;
    // The prowler's own census, in the same pass. ANY live tier >= 2 animal
    // inside the presence radius satisfies the slot, whoever seeded it - the
    // same whoever-put-it-there principle as `near` and `biggest`.
    const presence2 = R * R * (NEARFIELD_PROWLER_PRESENCE * NEARFIELD_PROWLER_PRESENCE);
    let prowlerHere = false;
    this._nearSpecies.fill(0);
    for (let k = 0; k < live.length; k++) {
      const i = live[k];
      if (sim.tier[i] > NEARFIELD_MAX_TIER) {
        if (sim.tier[i] >= 2 && !prowlerHere) {
          const dx = sim.posX[i] - px, dy = sim.posY[i] - py, dz = sim.posZ[i] - pz;
          if (dx * dx + dy * dy + dz * dz <= presence2) prowlerHere = true;
        }
        continue;
      }
      // THE SPECIES' LENGTH, NOT THE JITTERED BODY LENGTH, and the two must be
      // the same test the picker applies or the population overshoots. Spawn
      // scale jitter is 0.82-1.18, so a species authored at 0.11 m arrives
      // between 0.090 and 0.130: measured with the census reading bodyLength,
      // 11 of 62 Coppersprat in the primed lagoon were seeded by a picker that
      // reads `st.length` and then never counted by the census that reads
      // `bodyLength`, so the species share cap was exceeded by exactly the
      // fraction of the jitter below the threshold.
      if (st.length[sim.species[i]] < NEARFIELD_MIN_LENGTH) continue;
      // The per-species census is over everything the director has ALIVE, not
      // over the counted ball. TWO NEAR-FIELD RADII, AND ONLY ONE OF THEM IS
      // COUNTED - the wake out to NEARFIELD_RELEASE is alive and charged, and a
      // share cap measured on the ball alone is exceeded by exactly the
      // alive-to-counted ratio (measured 1.21) as animals drift out of it and
      // are replaced.
      if (this._nearFieldSlot[i] === 1) this._nearSpecies[sim.species[i]]++;
      const dx = sim.posX[i] - px, dy = sim.posY[i] - py, dz = sim.posZ[i] - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > R2) continue;
      near++;
      // The hero slot's own census, taken in the same pass. It is the LARGEST
      // animal inside the ball whatever put it there, for the same reason `near`
      // is: a shoal cell resolution happened to drop at the player's feet is
      // exactly as good as one the director seeded.
      if (sim.bodyLength[i] > biggest) biggest = sim.bodyLength[i];
      if (leadOn && dx * ldx + dz * ldz > 0) forward++;
      for (let s = 0; s < NEARFIELD_SHELLS.length; s++) {
        if (d2 <= _shellR2[s]) _shellCount[s]++;
      }
      if (d2 <= _shellR2[NEARFIELD_READABLE_SHELL] &&
          st.length[sim.species[i]] >= NEARFIELD_READABLE_MIN_LENGTH) readable++;
    }
    this.stats.nearFieldCount = near;
    this.stats.nearFieldInner = _shellCount[NEARFIELD_SHELLS.length - 1];
    this.stats.nearFieldForward = leadOn ? forward : -1;
    this.stats.nearFieldBiggest = biggest;
    this.stats.nearFieldReadable = readable;
    this._prowlerPresent = prowlerHere;
    this.stats.prowlerPresent = prowlerHere ? 1 : 0;

    const hide = R * (near < target * NEARFIELD_BULK_FRAC
      ? NEARFIELD_HIDE_BULK : NEARFIELD_HIDE_FRAC);
    this._nearRegion.hide2 = hide * hide;
    const ground = terrain.sampleHeightFast(px, pz);

    // THE PROWLER QUOTA, ahead of the fill early-outs on purpose: the steady
    // state of a healthy near field is `near >= target`, and an encounter
    // that can only stage while the ambient population is short would never
    // stage at all. It spends no ordinary group slot and is not counted
    // toward `near` (the census's tier gate excludes it), so the ambient
    // target is undisturbed. update() ticks the clock; prime() never does.
    let prowlerSpawned = 0;
    if (!prowlerHere && this._prowlerCooldown <= 0
        && sim.count <= sim.capacity - NEARFIELD_POOL_RESERVE) {
      const psp = this._pickProwlerSpecies(px, py, pz, ground);
      if (psp >= 0) {
        // The hero's staging, verbatim - far band, in-frame wedge, pop rule
        // intact. One individual: the slot is a silhouette, not a pack.
        // budgetSlack lets that one individual land in a band whose budget is
        // held, which in the hadal band is the steady state.
        this._aimHero(psp, hide);
        this._nearRegion.budgetSlack = 1;
        prowlerSpawned = this._placeGroup(null, psp, 1, false, this.rng, this._nearRegion);
        if (prowlerSpawned === 0) {
          // The aim is a bias, not a rule, and against a wall it is a bias
          // toward rock: at the trench wall anchor the camera faces a 60 deg
          // cliff and every wedge candidate 36 m down the view axis is inside
          // it - MEASURED, the picker returned Umbral Squid with the clock
          // 5 s past zero and 45 s of aimed attempts had all been refused.
          // Fall back to the ordinary stratified annulus draw in the same
          // step: still beyond the hide radius, so it still arrives out of
          // the haze - just not necessarily in frame. An encounter somewhere
          // beats a certainty of nothing.
          this._nearRegion.aimSpread = 0;
          this._nearRegion.rDraw = R;
          this._nearRegion.rDrawMin = Math.max(this._nearRegion.rMin, hide * 1.02);
          prowlerSpawned = this._placeGroup(null, psp, 1, false, this.rng, this._nearRegion);
        }
        this._nearRegion.budgetSlack = 0;
        this._nearRegion.aimSpread = 0;
        this._nearRegion.seq++;
        if (prowlerSpawned > 0) {
          this._prowlerCooldown = NEARFIELD_PROWLER_COOLDOWN;
          this.stats.prowlerSeeded++;
        }
        // A step where both forms are refused keeps the clock at <= 0 and
        // retries next step; the stratified seq advances either way, so a run
        // of refusals walks the bearing strata rather than repeating one.
      } else {
        this._prowlerCooldown = NEARFIELD_PROWLER_RETRY;
      }
    }

    if (near >= target) return prowlerSpawned;
    if (sim.count > sim.capacity - NEARFIELD_POOL_RESERVE) return prowlerSpawned;

    const diel = worldClock ? worldClock.daylight : 1;
    // The INNERMOST shell that is short claims at most one group per step. More
    // than one and a single step could put eighty fish inside 20 m; none and the
    // shell fills at the mercy of the radial draw, which is the defect being
    // closed.
    let shell = -1;
    for (let s = 0; s < NEARFIELD_SHELLS.length; s++) {
      if (_shellCount[s] < Math.round(target * NEARFIELD_SHELLS[s][1])) { shell = s; break; }
    }
    // THE LEADING-EDGE QUOTA, and it is the same mechanism as the shells one
    // axis over: the shells close a RADIAL lottery, this closes an ALONG-TRACK
    // deficit - which is not a lottery at all but a conservation law, see
    // NEARFIELD_FORWARD_SHARE. It claims at most one group per step, and it
    // sits BELOW the `near >= target` early-out on purpose: that makes it a
    // bang-bang controller, the forward edge drains, `near` dips, the quota
    // fires and the edge refills. Hoisting it above the early-out would seed
    // past the target and breach the band budget.
    let leadShort = leadOn && forward < Math.round(target * NEARFIELD_FORWARD_SHARE);
    // THE HERO QUOTA. It claims at most one group per step and it claims it
    // FIRST, ahead of the shells and the leading edge, because there is only ever
    // one of it and the two of them are per-step controllers that will still be
    // short on the next step. The nomination is deterministic and costs one
    // biome lookup; it is skipped entirely once the ball already holds an animal
    // big enough, which after the first fill is every step.
    let heroSp = -1;
    if (biggest < NEARFIELD_HERO_MIN_LENGTH) {
      heroSp = this._pickHeroSpecies(px, py, pz, ground);
      // A biome whose largest legal animal is SMALLER than the threshold can
      // never satisfy it, so the quota is re-aimed at that animal instead. 0.82
      // is the bottom of CreatureSim's spawn scale jitter, so one spawned
      // individual always clears it.
      if (heroSp >= 0 && biggest >= st.length[heroSp] * 0.82) heroSp = -1;
    }
    let spawned = 0;
    for (let g = 0; g < NEARFIELD_GROUPS_PER_STEP && near + spawned < target; g++) {
      const hero = heroSp >= 0;
      let readableGroup = !hero && readable < NEARFIELD_READABLE_TARGET;
      let sp = hero ? heroSp : this._pickNearFieldSpecies(px, py, pz, ground, diel,
        readableGroup ? NEARFIELD_READABLE_MIN_LENGTH : NEARFIELD_MIN_LENGTH);
      // Sparse/deep rosters may have no legal mid-sized tier-0/1 animal. The
      // presentation quota must not turn that into an empty near field.
      if (sp < 0 && readableGroup) {
        readableGroup = false;
        sp = this._pickNearFieldSpecies(px, py, pz, ground, diel);
      }
      if (hero) heroSp = -1;
      if (sp < 0) break;
      const headroom = Math.min(
        this._nearFieldRoom(sp),
        target - near - spawned,
        sim.capacity - NEARFIELD_POOL_RESERVE - sim.count,
      );
      if (headroom <= 0) break;
      // A hero is ONE animal even when its species schools. The slot exists to
      // put a silhouette in frame, and a ten-strong shoal of the biggest legal
      // species is a different picture from the one the datasheets describe.
      const schoolTarget = (!hero && st.schoolMin[sp] > 1)
        ? clamp(st.schoolMin[sp] + Math.floor(this.rng() * (st.schoolMax[sp] - st.schoolMin[sp] + 1)),
          1, NEARFIELD_GROUP_MAX)
        : 1;
      const n = Math.min(headroom, Math.max(1, schoolTarget));
      const forcedShell = shell >= 0 ? shell
        : (readableGroup ? NEARFIELD_READABLE_SHELL : -1);
      const forced = !hero && forcedShell >= 0;
      this._nearRegion.rDraw = forced ? R * NEARFIELD_SHELLS[forcedShell][0] : R;
      this._nearRegion.rDrawMin = forced
        ? this._nearRegion.rTouch : this._nearRegion.rMin;
      if (forced) shell = -1;
      // The shells keep first claim on the remaining slot, so the leading edge
      // takes the second one. Standing still leadShort is false and this is inert.
      const leading = !hero && !forced && leadShort;
      if (leading) leadShort = false;
      this._nearRegion.leadR = leading ? R * NEARFIELD_LEAD_FRAC : 0;
      if (hero) {
        this._aimHero(sp, hide);
      } else if (forced && leadOn) {
        // A close-shell top-up used to choose its bearing over the whole circle.
        // While swimming, half of that expensive close population therefore
        // arrived in the wake and immediately drained out of the ball. Aim the
        // shell across the forward HEMISPHERE instead. Inside the hide radius
        // _placeGroup still rejects anything the camera can see, so the accepted
        // seeds sit forward-and-aside and enter view naturally as the diver
        // turns; this changes neither the pop rule nor the radial quota.
        this._nearRegion.aimX = ldx;
        this._nearRegion.aimZ = ldz;
        this._nearRegion.aimSpread = Math.PI * 0.5;
        this._nearRegion.aimTanElev = 1.0;
      }
      const got = this._placeGroup(null, sp, n, schoolTarget > 1, this.rng, this._nearRegion);
      this._nearRegion.aimSpread = 0;
      // Advance the radius stratum whether or not the group landed, so a run of
      // refusals cannot pin every subsequent group to the same shell.
      this._nearRegion.seq++;
      if (got === 0) {
        // A FORCED QUOTA group has one reason to be refused that says nothing
        // about the rest of the water: inside the hide radius it may only be
        // seeded where the camera is not pointed, and a quota shell is entirely
        // inside the hide radius. Abandoning the step there would let a player
        // who holds one heading starve the whole near field - so only an
        // unrestricted refusal, which really does mean the band or the column is
        // out of room, ends the step. A LEADING-EDGE group is refused for its own
        // narrow reasons too - the seabed rising into the arc ahead, or a shoal
        // already sitting there - none of which say anything about the water
        // behind, so it is treated the same way. A HERO is aimed into one 90 deg
        // wedge of one shell, which is the narrowest draw the director makes, so
        // it says the least of all of them about the rest of the ball.
        if (hero || forced || leading) continue;
        break;
      }
      // The director's per-species census is refilled once per step, so the
      // second group of the same step has to be told what the first one put in
      // it or NEARFIELD_SPECIES_SHARE is only enforced between steps.
      this._nearSpecies[sp] += got;
      if (readableGroup) readable += got;
      spawned += got;
    }
    this.stats.nearFieldSpawned += spawned;
    return spawned + prowlerSpawned;
  }

  /**
   * Point the region's hero draw down the view axis and size its radius.
   *
   * Writes `aimX`/`aimZ` (the camera's forward direction, flattened and
   * normalised), `aimSpread`, `aimTanElev` and the radius band. See
   * NEARFIELD_HERO_BEARING for why the bearing may be aimed at all, and
   * NEARFIELD_HERO_RANGE_LENGTHS for the radius.
   *
   * With no camera - the offline suites and prime() before the first frame - the
   * spread stays zero and the hero takes the ordinary stratified bearing. It is
   * then a coin toss whether it is in frame, which is exactly the behaviour the
   * suites already measure and the reason this is a bias and not a rule.
   *
   * @param {number} sp species index
   * @param {number} hide the step's hide radius, metres
   */
  _aimHero(sp, hide) {
    const region = this._nearRegion;
    const R = this._nearRadius;
    const L = SPECIES_TABLE.length[sp];
    // Just outside the hide radius, never inside it: the pop rule is what makes
    // an arrival an arrival, and it is also what PERMITS the aim - beyond the
    // hide radius a seed may be in frustum. The 1.02 is a hair of margin, and
    // the max() against rMin is what keeps that true in STEADY STATE, where the
    // hide radius is 0.85 R and would otherwise be outside the hero band
    // entirely: the hero would then be aimed into the one annulus the rule
    // refuses it in and every attempt would fail. Being pushed out to 0.867 R
    // costs apparent size and is the correct trade - the fill is where the
    // picture is made, and during a fill the hide radius is 0.45 R.
    const rMin = Math.max(region.rTouch, hide * 1.02);
    const rMax = Math.max(rMin, R * NEARFIELD_HERO_MAX_FRAC);
    region.rDraw = clamp(L * NEARFIELD_HERO_RANGE_LENGTHS, rMin, rMax);
    region.rDrawMin = region.rDraw;
    region.aimTanElev = NEARFIELD_HERO_TAN_ELEV;
    const cam = region.camera;
    const f = cam && cam.forward;
    const flat = f ? Math.hypot(f[0], f[2]) : 0;
    if (flat > 1e-4) {
      region.aimX = f[0] / flat;
      region.aimZ = f[2] / flat;
      region.aimSpread = NEARFIELD_HERO_BEARING;
    } else {
      region.aimSpread = 0;
    }
  }

  /**
   * Every species the near field may seed at the eye, into `this._nearLegal`.
   *
   * FOUR THINGS IN HERE ARE NOT THE CELL DIRECTOR'S ANSWER, and each of them was
   * measured before it was changed.
   *
   * (1) THE REAL SLOPE. `biomeAt` defaults `slope` to 0, and that default is not
   * a neutral prior - it is the value that makes the FLAT records win, so five
   * biomes can never be dominant under it. MEASURED at the anchors: it reports
   * Sand Plains over the Kelp Forest and over Rock Spires, and Abyssal Plain
   * over the Canyon Wall. `_updateNearFieldGeometry` two hundred lines up has
   * been passing `terrain.sampleSlope` to `waterTypeAt` since the seeding radius
   * was found to be wrong for the same reason; this call is the other half of it,
   * and until now the director stocked the kelp bed with sand-plain fauna while
   * rendering it in the kelp bed's own water.
   *
   * (2) THE BIOME IS SAMPLED OVER THE BALL, NOT UNDER THE EYE, and restoring the
   * slope is what makes that necessary. `biomeAt` is a point classifier over a
   * field with metre-scale structure, and the ball is 45 m wide. MEASURED over
   * 2,000 area-uniform samples of the 45 m ball around the Rock Spires anchor:
   * Kelp Forest 59%, Sand Plains 40%, Boulder Field 1%, ROCK SPIRES 0% - the
   * anchor is a knife edge where the slope spikes to 0.85, and asking only the
   * point under the eye stocks the ball with the fauna of a biome that occupies
   * none of it. Rock Spires' own roster starts at 90 m against a 33 m anchor, so
   * that answer was also empty, and the hero fell from a 2.4 m Ribbonwether to a
   * 0.53 m jelly. The five sample points - centre plus the ball's radius N/E/S/W
   * - and the union are exactly what `_cellSpeciesSet` does to a cell's corners,
   * for exactly the reason its docstring gives: it is what lets the biome filter
   * be HARD without drawing a species boundary down the middle of the seabed.
   *
   * (3) THE PELAGIC PSEUDO-HABITAT IS MERGED UNCONDITIONALLY. `_legalSpecies`
   * gates it on "a floor more than 120 m below", which is the right test for a
   * 256 x 128 x 256 m CELL: it stops open-ocean drifters being the entire roster
   * of a shelf slab. It is the wrong test for the near field, whose ball is
   * centred on a diver who is IN the water column by definition, and whose
   * arrival puts the eye a few metres off the seabed - so the gate was false at
   * every anchor in the game and the pelagic roster was unreachable from here.
   * Nothing is being smuggled past a depth check by this: `speciesForBiome`
   * still applies each record's own `depthRange`, so at the reef this admits a
   * Bellflower Jelly ([3, 220] m) and still refuses a Wisplight ([90, 1150] m).
   *
   * (4) THE CHARTER CEILING. Tier is bounded by the min of NEARFIELD_MAX_TIER
   * and `charterMaxTier` at the eye. `_placeGroup` re-tests the charter at every
   * individual's own position and is what actually enforces it; this only stops
   * the picker spending a group slot on a species that will then be refused
   * everywhere inside the crater.
   *
   * The result is memoised on the eye and the radius because a step asks for it
   * two or three times and it costs five `sampleSlope` calls to build. The
   * per-species ROOM check is deliberately NOT in here: `speciesCount` moves
   * between the picks within one step, and folding it into the memo would freeze
   * a species' headroom for the whole step.
   *
   * @returns {number} how many entries of `this._nearLegal` are valid
   */
  _nearFieldLegal(x, y, z, ground) {
    if (this._nearLegalN >= 0 && this._nearLegalX === x && this._nearLegalY === y
      && this._nearLegalZ === z && this._nearLegalR === this._nearRadius) {
      return this._nearLegalN;
    }
    const st = SPECIES_TABLE;
    const depth = Math.max(0, -y);
    const maxTier = Math.min(NEARFIELD_MAX_TIER, charterMaxTier(x, z));
    const R = this._nearRadius;
    const set = new Set();
    this._mergeNearBiome(set, x, z, ground, depth);
    if (R > 0) {
      this._mergeNearBiome(set, x + R, z, null, depth);
      this._mergeNearBiome(set, x - R, z, null, depth);
      this._mergeNearBiome(set, x, z + R, null, depth);
      this._mergeNearBiome(set, x, z - R, null, depth);
    }
    // THE CAVE ROSTER, merged only while the eye is under a roof. The five
    // samples above classify the SURFACE over the cave, whose fauna cannot
    // reach the eye anyway (their legal slabs sit above the roof, and the
    // pelagic/benthic placement arithmetic self-rejects them against the
    // region - verified in the placement branch). What lives HERE is the CAVE
    // pseudo-habitat. The tier gate below still applies, which is what keeps
    // the tier-4 Vaultstalker out of this path permanently: it arrives by
    // residency (entities/cave_residency.js) or not at all. The prowler
    // picker deliberately does NOT get this merge - same reasoning, one tier
    // down: a cave apex is a placed fact, not an ambient roll.
    if (this._eyeInCave) this._addBiomeSpecies(set, CREATURE_HABITAT.CAVE, depth);
    let n = 0;
    for (const sp of set) {
      if (st.tier[sp] > maxTier) continue;
      if (st.length[sp] < NEARFIELD_MIN_LENGTH) continue;
      if (st.flags[sp] & SPECIES_FLAG.AIRBORNE) continue;
      const habitat = habitatOf(sp);
      if (habitat === HABITAT.LAND || habitat === HABITAT.AIR) continue;
      // The species' own band must reach the water the eye is in, with the same
      // slack _placeGroup will allow it when it picks a y.
      if (st.depthMin[sp] > depth + R) continue;
      if (st.depthMax[sp] < Math.max(0, depth - R)) continue;
      // AND IT MUST FIT IN THIS COLUMN, which overlapping the eye's depth band
      // does not imply. `_placeGroup` keeps a pelagic candidate 1.5 body lengths
      // clear of the seabed AND inside its own band, and for a large animal in
      // shallow water those two can be empty of each other - an 18 m Veilmouth
      // is authored [90, 700] m and the Boulder Field anchor's seabed is at
      // 96.5 m, so its legal slab is 27 m of rock. MEASURED LIVE at that anchor,
      // it was the only species with headroom left and the picker returned it on
      // 400 of 400 draws; every group was then refused, and a refused group that
      // is not a quota group ENDS THE STEP, so one unplaceable species stalled
      // the whole near field.
      if (!this._columnPlaceable(sp, y, ground, R)) continue;
      this._nearLegal[n++] = sp;
    }
    this._nearLegalN = n;
    this._nearLegalX = x; this._nearLegalY = y; this._nearLegalZ = z;
    this._nearLegalR = R;
    return n;
  }

  /**
   * Union one sample point's biome fauna, plus the pelagic roster, into `set`.
   *
   * The DEPTH is the eye's throughout, not the sample point's: the animals are
   * placed around the eye, so the eye's depth is the one their bands have to
   * contain. Only the CLASSIFICATION comes from the sample point.
   */
  _mergeNearBiome(set, x, z, height, depth) {
    const h = height === null ? terrain.sampleHeightFast(x, z) : height;
    const biome = biomeAt(x, z, h, terrain.sampleSlope(x, z));
    for (const sp of this._biomeSpeciesSet(biome, depth, true)) set.add(sp);
  }

  /**
   * Slots this species has left in the near field.
   *
   * TWO CAPS, AND THEY ARE COUNTED AGAINST DIFFERENT POPULATIONS. That was the
   * bug: the size class's `global` cap is a world budget and is rightly charged
   * the world count, but NEARFIELD_SPECIES_SHARE is - by its own docstring - the
   * "largest share of THE NEAR FIELD one species may hold", and charging it the
   * world count let cell resolution lock the near field out of a species it had
   * stocked hundreds of metres away. MEASURED LIVE at the Trench Wall anchor,
   * where the band target is 19 and the share cap is therefore ceil(19 x 0.34)
   * = 7: cell resolution held 41 Wisplight and 11 Sepulcher Louse, so both came
   * out at NEGATIVE room and the deep near field could seed neither of the two
   * animals that live there. The population sat at 0-8 of 19.
   *
   * `_nearSpecies` is the per-species census of everything the director has
   * ALIVE - flagged `_nearFieldSlot`, at any radius out to retirement - refilled
   * by `_maintainNearField` in the same pass that counts `near`.
   */
  _nearFieldRoom(sp) {
    const cls = sizeClass(SPECIES_TABLE.length[sp]);
    // THE SHARE CAP IS AN ANTI-MONOCULTURE RULE, AND A ONE-SPECIES ROSTER HAS
    // NO CULTURE TO PROTECT. Its docstring says "the largest share of the
    // near field one species may hold" - a claim about SPREADING a budget
    // across a roster. When `_nearLegal` holds exactly one species (today:
    // the Palewander inside a cave, whose CAVE pseudo-habitat roster is one
    // tier-0/1 record deep), the cap does not spread anything, it just
    // starves the ball: MEASURED at the First Hollow chamber, the fill
    // stalled at 10 of a 28 target - ceil(28 x 0.34) exactly - with 18 slots
    // of band budget going unused and nothing else legal to spend them on.
    // `_nearLegalN` is valid here: every caller runs _nearFieldLegal first.
    // GATED ON THE CAVE, not on roster size alone: the P4 review pointed out
    // that an OPEN-WATER band with one legal species would also take this
    // bypass and fill 100% of the target where it filled 34% before - an
    // unmeasured ambient change outside the feature that motivated it. No
    // such band is known today, but the cap's behaviour in open water is a
    // measured, shipped quantity and this bypass must not be able to touch
    // it. Inside a cave the one-species starvation above is the measured
    // fact; outside, the cap stands.
    const share = (this._nearLegalN === 1 && this._eyeInCave)
      ? Infinity
      : Math.ceil(this._nearFieldTarget(this._eyeBand) * NEARFIELD_SPECIES_SHARE);
    return Math.min(cls.global - this.speciesCount[sp],
      share - this._nearSpecies[sp]);
  }

  /**
   * Can this species be placed in the eye's own water column at all?
   *
   * The same two constraints `_placeGroup` applies, evaluated against the ground
   * under the eye and a vertical reach of `half`. It is an approximation - the
   * ball spans up to 45 m of terrain and the seabed moves across it - but it is
   * the conservative direction, and the alternative is drawing a species that
   * cannot be placed anywhere near the player.
   *
   * @param {number} sp species index
   * @param {number} centreY the ball's centre, metres
   * @param {number} ground seabed height under the centre
   * @param {number} half how far above and below the centre a candidate may go
   */
  _columnPlaceable(sp, centreY, ground, half) {
    const st = SPECIES_TABLE;
    const L = st.length[sp];
    // A CAVE SPECIES UNDER A ROOF HAS NO COLUMN TO TEST. `ground` here is the
    // heightfield surface, which for an eye inside the override is 60-160 m
    // ABOVE the ball - the pelagic arithmetic below reads that as "the seabed
    // is over your head" and refuses everything. The real placement question
    // ("is there carved void here") is answered per candidate against
    // caveVoidAt in _placeGroup, which is strictly stronger than anything
    // this approximation could say.
    if (this._eyeInCave && CAVE_SPECIES[sp]) return true;
    if (habitatOf(sp) === HABITAT.BENTHIC) {
      // It sits on the seabed, so the seabed has to be inside that reach.
      return Math.abs(ground + L * 0.35 - centreY) <= half;
    }
    const top = Math.min(-0.5, -st.depthMin[sp]);
    const bottom = Math.max(ground + L * 1.5, -st.depthMax[sp]);
    return bottom < top && bottom < centreY + half && top > centreY - half;
  }

  /**
   * The largest species the near field may seed at the eye, or -1.
   *
   * Deterministic: an argmax over body length with the species INDEX as the
   * tie-break, so it draws nothing from `this.rng` and the same water always
   * nominates the same animal. See NEARFIELD_HERO_MIN_LENGTH for why the slot
   * exists at all.
   *
   * A hero must also be PLACEABLE, which for a large animal is not implied by
   * its depth band overlapping the eye's. `_placeGroup`'s pelagic branch keeps a
   * candidate clear of the seabed by 1.5 body lengths and inside its own band,
   * and those two can be empty of each other: an 18 m Veilmouth is authored
   * [90, 700] m and the Boulder Field anchor's seabed is at 96.5 m, so its legal
   * slab is 27 m of rock and every attempt is refused. Nominating it would spend
   * the hero slot on a certainty of failure once per step, forever.
   */
  _pickHeroSpecies(x, y, z, ground) {
    const st = SPECIES_TABLE;
    const n = this._nearFieldLegal(x, y, z, ground);
    let best = -1, bestLen = 0;
    for (let k = 0; k < n; k++) {
      const sp = this._nearLegal[k];
      const L = st.length[sp];
      if (L <= bestLen) continue;
      if (this._nearFieldRoom(sp) <= 0) continue;
      // A hero's vertical reach is its own elevation cap, which is much tighter
      // than the ball's chord - see NEARFIELD_HERO_TAN_ELEV. The legal set has
      // already applied the loose form.
      if (!this._columnPlaceable(sp, y, ground,
        Math.max(1, this._nearRadius * NEARFIELD_HERO_MAX_FRAC) * NEARFIELD_HERO_TAN_ELEV)) {
        continue;
      }
      best = sp; bestLen = L;
    }
    return best;
  }

  /**
   * The predator the prowler slot stages at the eye, or -1.
   *
   * Deliberately NOT `_nearFieldLegal`: that set is memoised with the ordinary
   * draws' filters baked in (tier <= NEARFIELD_MAX_TIER, NEARFIELD_MIN_LENGTH),
   * and poisoning its memo with a different ceiling would hand a later
   * ordinary pick a predator. The biome union is rebuilt here with the same
   * five-point sampling for the same knife-edge reason `_nearFieldLegal` (2)
   * documents, and the same placement guards apply - the hero's tight vertical
   * reach, because the seed is aimed with the hero's own elevation cap.
   *
   * Argmax over (tier, then length): the slot stages the biome's apex, and a
   * density weight would prefer the smallest hunter (see the L^-3 note at
   * NEARFIELD_HERO_MIN_LENGTH). Deterministic, like the hero's nomination.
   */
  _pickProwlerSpecies(x, y, z, ground) {
    const st = SPECIES_TABLE;
    const depth = Math.max(0, -y);
    const maxTier = Math.min(NEARFIELD_PROWLER_MAX_TIER, charterMaxTier(x, z));
    if (maxTier < 2) return -1;
    const R = this._nearRadius;
    const set = new Set();
    this._mergeNearBiome(set, x, z, ground, depth);
    if (R > 0) {
      this._mergeNearBiome(set, x + R, z, null, depth);
      this._mergeNearBiome(set, x - R, z, null, depth);
      this._mergeNearBiome(set, x, z + R, null, depth);
      this._mergeNearBiome(set, x, z - R, null, depth);
    }
    const half = Math.max(1, R * NEARFIELD_HERO_MAX_FRAC) * NEARFIELD_HERO_TAN_ELEV;
    let best = -1, bestTier = 1, bestLen = 0;
    for (const sp of set) {
      const t = st.tier[sp];
      if (t < 2 || t > maxTier) continue;
      if (st.length[sp] < NEARFIELD_PROWLER_MIN_LENGTH) continue;
      if (st.flags[sp] & SPECIES_FLAG.AIRBORNE) continue;
      const habitat = habitatOf(sp);
      if (habitat === HABITAT.LAND || habitat === HABITAT.AIR) continue;
      if (st.depthMin[sp] > depth + R) continue;
      if (st.depthMax[sp] < Math.max(0, depth - R)) continue;
      if (!this._columnPlaceable(sp, y, ground, half)) continue;
      if (sizeClass(st.length[sp]).global - this.speciesCount[sp] <= 0) continue;
      if (t < bestTier || (t === bestTier && st.length[sp] <= bestLen)) continue;
      best = sp; bestTier = t; bestLen = st.length[sp];
    }
    return best;
  }

  /**
   * Pick one species for the near field, or -1.
   *
   * Weighted by sqrt(density) rather than by density: the datasheets span
   * 4e6/km3 for krill down to 45/km3 for a ray, and a linear weight makes the
   * near field a monoculture of whatever is commonest. The square root keeps the
   * datasheets' ORDER while letting a 900/km3 species appear at all. Schoolers
   * are biased because a shoal is what makes water read as inhabited, and the
   * remaining global headroom multiplies in so a species already at its cap
   * stops being drawn.
   *
   * It is deliberately NOT corrected for the resulting size bias - see
   * NEARFIELD_HERO_MIN_LENGTH, which reserves a slot instead. Bending this
   * weight toward the big animals would make every biome read as a parade of its
   * own rarest residents. `minLength` is only raised for the fixed four-animal
   * readable quota; within that small subset these same ecological weights hold.
   *
   * @param {number} minLength smallest authored body length this draw accepts
   */
  _pickNearFieldSpecies(x, y, z, ground, diel, minLength = NEARFIELD_MIN_LENGTH) {
    const st = SPECIES_TABLE;
    const legal = this._nearFieldLegal(x, y, z, ground);
    let n = 0, total = 0;
    for (let k = 0; k < legal; k++) {
      const sp = this._nearLegal[k];
      if (st.length[sp] < minLength) continue;
      const room = this._nearFieldRoom(sp);
      if (room <= 0) continue;
      const cls = sizeClass(st.length[sp]);
      const cap = Math.min(cls.global,
        Math.ceil(this._nearFieldTarget(this._eyeBand) * NEARFIELD_SPECIES_SHARE));
      const w = Math.sqrt(this._densityOf(sp)) * this._dielMultiplier(sp, diel)
        * (st.schoolMin[sp] > 1 ? NEARFIELD_SHOAL_BIAS : 1)
        * saturate(room / Math.max(1, cap));
      if (!(w > 0)) continue;
      this._nearWeight[sp] = w;
      this._nearPick[n++] = sp;
      total += w;
    }
    if (n === 0 || !(total > 0)) return -1;
    let r = this.rng() * total;
    for (let k = 0; k < n; k++) {
      r -= this._nearWeight[this._nearPick[k]];
      if (r <= 0) return this._nearPick[k];
    }
    return this._nearPick[n - 1];
  }

  // -------------------------------------------------------------------------
  // Cell resolution
  // -------------------------------------------------------------------------

  /**
   * Populate one spawn cell.
   *
   * @param {number} cx cell index along X
   * @param {number} cy cell index along Y
   * @param {number} cz cell index along Z
   * @param {object} [worldClock]
   * @returns {number} agents spawned
   */
  resolveCell(cx, cy, cz, worldClock = null) {
    const key = cellKey(cx, cy, cz);
    let cell = this.cells.get(key);
    if (!cell) {
      cell = {
        key, cx, cy, cz,
        centerX: cx * CELL_X + CELL_X * 0.5,
        centerY: cy * CELL_Y + CELL_Y * 0.5,
        centerZ: cz * CELL_Z + CELL_Z * 0.5,
        seed: hash3i(cx, cy, cz) ^ this.seed,
        depletion: new Float32Array(SPECIES_TABLE.count),
        population: 0,
        killed: 0,
        visited: false,
        resolved: false,
        retired: false,
      };
      this.cells.set(key, cell);
    }
    cell.resolved = true;
    cell.retired = false;

    const st = SPECIES_TABLE;
    const n = this._legalSpecies(cell);
    if (n === 0) return 0;

    // Deterministic per-cell RNG: the same cell key and world seed always draw
    // the same population, which is what DESIGN/06.6.1 requires for save/load.
    const rng = makeRng(cell.seed);
    let spawned = 0;
    const diel = worldClock ? worldClock.daylight : 1;

    // LEAST-REPRESENTED FIRST, and this ordering is load-bearing.
    //
    // The loop below stops when the cell's agent cap or the band budget runs
    // out, so whichever species is considered first gets the slots. Walking the
    // list in roster order MEASURED as 60 Reefcropper and nothing else in the
    // start reef's 144 animals: the first legal species simply ate its whole
    // global cap. Sorting by how full each species' global cap already is
    // spreads the budget across everything legal here, which is what makes the
    // reef read as a community rather than as a monoculture. Ties go to the
    // denser species, which is the datasheets' own answer to "which of these is
    // more common".
    for (let k = 0; k < n; k++) {
      const sp = this._legal[k];
      this._weight[sp] = this.speciesCount[sp] / Math.max(1, sizeClass(st.length[sp]).global)
        - 1e-6 * Math.log10(Math.max(this._densityOf(sp), 1e-6));
    }
    for (let k = 1; k < n; k++) {
      const key = this._legal[k];
      let m = k - 1;
      while (m >= 0 && this._weight[this._legal[m]] > this._weight[key]) {
        this._legal[m + 1] = this._legal[m];
        m--;
      }
      this._legal[m + 1] = key;
    }

    // The band of the cell's actual WATER COLUMN, computed once. NOT the band of
    // its centre: CELL_Y is 128 m, so the one slab that contains the 15 m lagoon
    // has its centre at y = -64 m and reported band 2 (Twilight) for a cell whose
    // every animal is censused into band 1 (Sunlit). MEASURED at boot with the
    // centre form: 117 agents in band 1 against a budget of 64, because the
    // headroom was being charged to a band that stayed near zero - while _cull
    // read the real band, saw 117 > 64 * 1.15, and started culling them again.
    const band = this._bandOfCellWater(cell);

    for (let k = 0; k < n && cell.population < CELL_AGENT_CAP; k++) {
      const sp = this._legal[k];
      const cls = sizeClass(st.length[sp]);

      // Expected count: density * cell volume * diel * biome fit * depletion.
      // The cell is 0.00839 km^3, so a 4e6/km^3 krill density asks for 33,000
      // individuals - which is exactly why the caps below, not the density, are
      // what determines the answer for small species. The density still decides
      // the ORDER OF MAGNITUDE for the mid and large classes, where it is under
      // the cap and therefore load-bearing.
      const volumeKm3 = (CELL_X * CELL_Y * CELL_Z) / 1e9;
      const dielMul = st.flags[sp] & SPECIES_FLAG.LEVIATHAN ? 1
        : this._dielMultiplier(sp, diel);
      const base = this._densityOf(sp) * volumeKm3 * dielMul
        * (1 - Math.min(MAX_DEPLETION, cell.depletion[sp]));

      // EVERY CAP THAT BOUNDS INDIVIDUALS, IN ONE PLACE, because `want` is a
      // count of GROUPS for a schooling species and the caps have to survive the
      // multiplication by the school size. Applying them to `want` alone let a
      // 16-strong Coppersprat shoal overshoot the species' global cap by up to
      // cls.cell - 1 = 11 animals: with 58 of 60 alive, `want` clamped to 2, and
      // 2 * 16 = 32 was then clamped only by cls.cell to 12, taking the species
      // to 70. The tier ceilings had the same hole and only stayed shut because
      // every tier >= 3 species in the roster happens to be solitary.
      let headroom = Math.min(cls.cell, CELL_AGENT_CAP - cell.population,
        cls.global - this.speciesCount[sp],
        BAND_BUDGET[band] - this.bandCount[band],
        this._cellBandBudget(band) - this.bandCellCount[band]);
      if (st.tier[sp] >= 4) headroom = Math.min(headroom, BAND_MAX_TIER4[band] - this.bandTier4[band]);
      if (st.tier[sp] >= 3) headroom = Math.min(headroom, BAND_MAX_TIER3[band] - this.bandTier3[band]);

      const want = Math.min(this._poisson(base, rng), headroom);
      if (want <= 0) {
        if (this.bandCellCount[band] >= this._cellBandBudget(band)) this.stats.budgetPressure++;
        continue;
      }

      // Schooling species arrive as a school; solitary ones one at a time.
      const schoolTarget = st.schoolMin[sp] > 1
        ? clamp(st.schoolMin[sp] + Math.floor(rng() * (st.schoolMax[sp] - st.schoolMin[sp] + 1)),
          1, MAX_CPU_SCHOOL)
        : 1;
      spawned += this._placeGroup(cell, sp, Math.min(want * schoolTarget, headroom),
        schoolTarget > 1, rng);
    }

    cell.population = this._countIn(cell);
    return spawned;
  }

  /**
   * Depth band index of the middle of a cell's WATER COLUMN.
   *
   * The column is the cell's own vertical span clipped to the sea surface above
   * and to the seabed below, so a 128 m slab whose bottom 113 m are inside rock
   * answers for the 15 m of water it actually has.
   */
  _bandOfCellWater(cell) {
    const top = Math.min(0, cell.centerY + CELL_Y * 0.5);
    const floor = terrain.sampleHeightFast(cell.centerX, cell.centerZ);
    const bottom = Math.min(top, Math.max(cell.centerY - CELL_Y * 0.5, floor));
    return depthBandIndex(Math.max(0, -(top + bottom) * 0.5));
  }

  /** Live agents whose position falls inside a cell. */
  _countIn(cell) {
    const sim = this.sim;
    const live = sim.liveSlots();
    let n = 0;
    for (let k = 0; k < live.length; k++) {
      const i = live[k];
      if (Math.floor(sim.posX[i] / CELL_X) === cell.cx &&
          Math.floor(sim.posY[i] / CELL_Y) === cell.cy &&
          Math.floor(sim.posZ[i] / CELL_Z) === cell.cz) n++;
    }
    return n;
  }

  /**
   * Which species may spawn in a cell, and how well each fits.
   *
   * ENFORCEMENT LEVEL 1 OF THE SAFE CHARTER IS THE FIRST TEST IN THIS LOOP.
   * The cell's whole horizontal footprint is checked, not just its centre: a
   * cell straddling the boundary is treated as if it were entirely inside,
   * because a species legal at the cell's far corner would otherwise be placed
   * by the Poisson sampler at its near one.
   *
   * @returns {number} how many entries of `this._legal` are valid
   */
  _legalSpecies(cell) {
    const st = SPECIES_TABLE;
    // The most RESTRICTIVE tier anywhere in the cell's footprint - Math.min, not
    // Math.max. A cell that so much as touches the charter is treated as if it
    // were entirely inside it, because the Poisson sampler places individuals
    // anywhere in the footprint and a species legal only at the far corner would
    // otherwise be placed at the near one. Checking the centre and the four
    // corners is exact for a convex radial constraint.
    const hx = CELL_X * 0.5, hz = CELL_Z * 0.5;
    let maxTier = charterMaxTier(cell.centerX, cell.centerZ);
    maxTier = Math.min(maxTier, charterMaxTier(cell.centerX - hx, cell.centerZ - hz));
    maxTier = Math.min(maxTier, charterMaxTier(cell.centerX + hx, cell.centerZ - hz));
    maxTier = Math.min(maxTier, charterMaxTier(cell.centerX - hx, cell.centerZ + hz));
    maxTier = Math.min(maxTier, charterMaxTier(cell.centerX + hx, cell.centerZ + hz));

    const height = terrain.sampleHeightFast(cell.centerX, cell.centerZ);
    // A cell whose floor is more than 120 m below it is open water as well as
    // whatever the seabed happens to be, so BIO_PELAGIC species are legal in
    // it too. That is bestiary.js's CREATURE_HABITAT.PELAGIC definition, and
    // without it every pelagic species in the roster would be unspawnable.
    const openWater = (cell.centerY - height) > 120;
    const biomeSet = this._cellSpeciesSet(cell, height, openWater);

    // A cell whose water column does not exist is not a habitat: the cell's
    // vertical span must overlap the interval between the seabed and the sky.
    const cellTop = cell.centerY + CELL_Y * 0.5;
    const cellBottom = cell.centerY - CELL_Y * 0.5;

    let n = 0;
    for (let sp = 0; sp < st.count; sp++) {
      if (st.tier[sp] > maxTier) { this.stats.charterBlocked++; continue; }

      const flags = st.flags[sp];
      const airborne = (flags & SPECIES_FLAG.AIRBORNE) !== 0;
      const habitat = habitatOf(sp);

      if (airborne || habitat === HABITAT.LAND) {
        // Land and air species need dry ground in the cell and a vertical span
        // that reaches it.
        if (height < 0.5) continue;
        if (cellTop < height || cellBottom > height + (airborne ? 140 : 4)) continue;
      } else {
        // Aquatic: the species' depth band must overlap the cell's span, and
        // the cell must actually hold water.
        const spTop = -st.depthMin[sp];
        const spBottom = -st.depthMax[sp];
        if (spBottom > cellTop || spTop < cellBottom) continue;
        if (cellBottom > 0) continue;             // wholly above sea level
        if (cellTop < height) continue;           // wholly inside the rock
        if (habitat === HABITAT.BENTHIC && (height > cellTop || height < cellBottom)) continue;
      }

      // BIOME FIT IS A HARD FILTER, and it has to be: with a soft fallback
      // weight a species merely became RARE outside its habitat instead of
      // absent, and MEASURED on the start reef that put nine CRT_PALEWANDER -
      // a blind cave fish - in the sunlit lagoon. The fallback's purpose was to
      // avoid a visible species boundary where a cell straddles two biomes, and
      // _cellSpeciesSet solves that properly by unioning the biome at the cell's
      // centre AND its four corners.
      if (biomeSet.size > 0 && !biomeSet.has(sp)) continue;
      this._weight[sp] = 1.0;
      this._legal[n++] = sp;
    }
    return n;
  }

  /**
   * Every species legal anywhere inside a cell's footprint, as a Set of indices.
   *
   * The biome is sampled at the cell's CENTRE AND ITS FOUR CORNERS and the
   * results are unioned, so a cell straddling the reef/sand boundary admits both
   * biomes' fauna. That is what lets the biome filter be hard without drawing a
   * visible species boundary down the middle of the seabed - the alternative,
   * admitting everything at a reduced weight, quietly puts cave fish in the
   * lagoon.
   */
  _cellSpeciesSet(cell, centreHeight, openWater) {
    const hx = CELL_X * 0.5, hz = CELL_Z * 0.5;
    // The cell's WATER COLUMN, not its centre. A cell is CELL_Y = 128 m tall, so
    // asking the bestiary what lives at the centre asked "what lives at 64 m" of
    // the one slab that contains the 15 m lagoon - which excluded every reef
    // species whose range ends above 64 m. Measured: that made Sunplate, the
    // colour anchor of the shallow reef, unspawnable ANYWHERE in the world, and
    // left Coppersprat legal only in the slab above sea level, where the pelagic
    // placement clamp then pinned every one of them to y = -0.5 m.
    const top = cell.centerY + CELL_Y * 0.5;
    const bottom = cell.centerY - CELL_Y * 0.5;
    const set = new Set();
    // Gated on EVERY sample's biome, not the centre's: with a centre-only
    // gate, a cell straddling the dead zone's rim still merged the drifter
    // roster and could place its Veilmouth anywhere in the footprint -
    // including over the arena the zone exists to keep empty. Touching the
    // zone at any corner forfeits the drifters; a border cell losing its
    // open-ocean extras errs exactly the way the biome-filter's own
    // docstring demands (hard, not blended).
    let touchesDeadZone = false;
    touchesDeadZone = PELAGIC_DEAD_ZONES.has(
      this._mergeBiomeAt(set, cell.centerX, cell.centerZ, centreHeight, top, bottom)) || touchesDeadZone;
    touchesDeadZone = PELAGIC_DEAD_ZONES.has(
      this._mergeBiomeAt(set, cell.centerX - hx, cell.centerZ - hz, null, top, bottom)) || touchesDeadZone;
    touchesDeadZone = PELAGIC_DEAD_ZONES.has(
      this._mergeBiomeAt(set, cell.centerX + hx, cell.centerZ - hz, null, top, bottom)) || touchesDeadZone;
    touchesDeadZone = PELAGIC_DEAD_ZONES.has(
      this._mergeBiomeAt(set, cell.centerX - hx, cell.centerZ + hz, null, top, bottom)) || touchesDeadZone;
    touchesDeadZone = PELAGIC_DEAD_ZONES.has(
      this._mergeBiomeAt(set, cell.centerX + hx, cell.centerZ + hz, null, top, bottom)) || touchesDeadZone;
    if (openWater && !touchesDeadZone) {
      for (const d of depthSamples(top, bottom, bottom)) {
        this._addBiomeSpecies(set, CREATURE_HABITAT.PELAGIC, d);
      }
    }
    return set;
  }

  /**
   * Union one sample point's biome fauna into `set`, over the whole depth range
   * the cell spans at that point.
   *
   * THE SLOPE IS SAMPLED, NOT DEFAULTED. `biomeAt`'s `slope = 0` default is the
   * value that makes the FLAT records win - Basalt, Shelf Break, Rock Spires,
   * Canyon Wall and Trench Wall all have `slopeMin - featherSlope >= 0.14`, so
   * their slope term is exactly zero under it and they can never be dominant.
   * MEASURED at the biome anchors, the default reported Sand Plains over both
   * the Kelp Forest and Rock Spires and Abyssal Plain over the Canyon Wall, so
   * cell resolution stocked five biomes with another biome's fauna. Five samples
   * per cell at ~3.8 us each is 19 us on a call that already costs a
   * `speciesForBiome` walk per depth sample.
   */
  _mergeBiomeAt(set, x, z, height, top, bottom) {
    const h = height === null ? terrain.sampleHeightFast(x, z) : height;
    const biome = biomeAt(x, z, h, terrain.sampleSlope(x, z));
    for (const d of depthSamples(top, bottom, h)) {
      for (const sp of this._biomeSpeciesSet(biome, d, false)) set.add(sp);
    }
    // Returned so _cellSpeciesSet can test EVERY sample against
    // PELAGIC_DEAD_ZONES, not only the centre: a 256 m cell straddling the
    // shoal's rim (centre just off-plateau) merged the drifter roster and
    // placed an 18 m Veilmouth OVER the arena - reported from play twice.
    return biome;
  }

  /**
   * The bestiary's species list for a biome and depth, as a Set of species
   * indices.
   *
   * Cached on (biome, open-water flag, 8 m depth bucket) - the same bucket
   * width speciesForBiome memoises on, so this cache never splits an entry
   * that one shares.
   */
  _biomeSpeciesSet(biome, depth, openWater) {
    const bucket = Math.floor(depth / 8);
    const key = (biome * 4096 + bucket) * 2 + (openWater ? 1 : 0);
    const hit = this._biomeCache.get(key);
    if (hit) return hit;
    const set = new Set();
    this._addBiomeSpecies(set, biome, depth);
    // The dead-zone gate (see PELAGIC_DEAD_ZONES): the near field over the
    // Sunken Dunes stays empty of drifters no matter how open the column is.
    if (openWater && !PELAGIC_DEAD_ZONES.has(biome)) {
      this._addBiomeSpecies(set, CREATURE_HABITAT.PELAGIC, depth);
    }
    this._biomeCache.set(key, set);
    return set;
  }

  /** Merge speciesForBiome's records into `set` as indices. */
  _addBiomeSpecies(set, biome, depth) {
    const list = speciesForBiome(biome, depth);
    if (!Array.isArray(list)) return;
    for (let k = 0; k < list.length; k++) {
      const i = speciesIndexOf(list[k].id);
      if (i >= 0) set.add(i);
    }
  }

  /** Target density in individuals per km^3, from the datasheet. */
  _densityOf(sp) {
    const d = SPECIES_TABLE.records[sp].densityPerKm3;
    return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : 0;
  }

  /**
   * Diel activity multiplier: `dayNightActivity` is `[day, night]` and is
   * interpolated on the world clock's daylight rather than switched on it,
   * because a hard switch at dawn makes an entire band's population change
   * over inside one cell resolution.
   */
  _dielMultiplier(sp, daylight) {
    const act = SPECIES_TABLE.records[sp].dayNightActivity;
    if (!Array.isArray(act) || act.length < 2) return 1;
    return clamp(act[1] + (act[0] - act[1]) * saturate(daylight), 0, 2);
  }

  /**
   * Poisson draw with a deterministic uniform source.
   *
   * Knuth's product method. Its cost is O(lambda), which is why lambda is
   * clamped: an unclamped 33,000-individual krill density would spin 33,000
   * multiplies to produce a number the caps immediately reduce to 12.
   */
  _poisson(lambda, rng) {
    const lam = clamp(lambda, 0, 24);
    if (lam <= 0) return 0;
    const limit = Math.exp(-lam);
    let k = 0, p = 1;
    do { k++; p *= rng(); } while (p > limit && k < 64);
    return k - 1;
  }

  /**
   * Place `count` agents of one species, rejecting candidates that fail the
   * charter, the habitat mask, the band budget or the Poisson-disc separation.
   *
   * ONE function serves both directors, because the four filters above are
   * exactly the ones that must not diverge between them. The only difference is
   * where the independent draw comes from: a cell's box, or `region`'s annulus
   * around the eye.
   *
   * @param {object|null} cell the spawn cell, or null for a near-field group
   * @param {number} sp species index
   * @param {number} count individuals
   * @param {boolean} isSchool seed one point and cluster the rest around it
   * @param {function(): number} rng
   * @param {object} [region] {x, y, z, rMin, rMax, rDraw, rDrawMin, hide2, seq,
   *   camera, leadX, leadZ, leadR, aimX, aimZ, aimSpread, aimTanElev} - the
   *   near-field ball. `rDraw` is the outer radius of THIS group's radial draw,
   *   which the director narrows to a NEARFIELD_SHELLS radius when that shell is
   *   short of its quota, and `rDrawMin` is its inner edge. `leadR` non-zero
   *   replaces that draw entirely with the leading-edge draw along (`leadX`,
   *   `leadZ`). `aimSpread` non-zero instead replaces the BEARING with a draw
   *   within that many radians of (`aimX`, `aimZ`) and caps the vertical extent
   *   at `aimTanElev` times the radius. The hero uses a central wedge; a moving
   *   close-shell top-up uses the forward hemisphere. Presence of this object
   *   is also what marks the resulting agents for
   *   near-field retirement.
   * @returns {number} how many were actually spawned
   */
  _placeGroup(cell, sp, count, isSchool, rng, region = null) {
    if (count <= 0) return 0;
    const st = SPECIES_TABLE;
    const sim = this.sim;
    const habitat = habitatOf(sp);
    const sep = SEPARATION_FACTOR[habitat] * st.length[sp];
    const schoolId = isSchool ? (this._nextSchool = (this._nextSchool + 1) & 0x7fff) : -1;

    // A school is one seed point plus members on a sphere of radius
    // 0.42 * n^(1/3) * spacing, DESIGN/06.6.3. Solitary animals get an
    // independent draw each.
    let seedX = 0, seedY = 0, seedZ = 0, haveSeed = false;
    const schoolRadius = 0.42 * Math.cbrt(Math.max(count, 1)) * Math.max(sep, 1.0) * 3.0;

    let spawned = 0;
    // Set when a candidate was refused because its depth band is full. A full
    // band will refuse every remaining member too, so the group is abandoned
    // rather than run to `count` x PLACEMENT_ATTEMPTS - MEASURED at 154,648
    // placement attempts over fifteen seconds of standing still in a lagoon
    // whose sunlit band was at its budget, against 316 actual spawns.
    let bandBlocked = false;
    for (let m = 0; m < count; m++) {
      let placed = false;
      for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS && !placed; attempt++) {
        let x, y, z;
        // Vertical half-extent this candidate may use and still be inside the
        // near-field BALL. The region draw below narrows it to the chord at its
        // own horizontal radius; a school member keeps the full radius because
        // its seed is already inside the ball and the members sit within
        // `schoolRadius` of it.
        let regHalfY = region ? region.rMax : 0;
        if (isSchool && haveSeed) {
          // Uniform in a ball: cbrt of the radial uniform, so the members do
          // not pile up at the centre.
          const u = rng(), v = rng(), w = rng();
          const r = schoolRadius * Math.cbrt(u);
          const theta = v * TAU;
          const cosPhi = 2 * w - 1;
          const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
          x = seedX + r * sinPhi * Math.cos(theta);
          y = seedY + r * cosPhi * 0.45;    // schools are wider than they are tall
          z = seedZ + r * sinPhi * Math.sin(theta);
        } else if (region && region.leadR > 0) {
          // THE LEADING EDGE OF THE BALL, which is the only place a seed can
          // enter a field the player is sweeping through.
          //
          // In the eye frame the animals drift backwards at the swim speed
          // (MEASURED self-motion 3.5-3.7 m per 10 s against 3.96 m/s of diver),
          // so a source spread over the whole co-moving disc leaves the FRONT of
          // the ball at exactly zero density - MEASURED, 33.0 drawn instances
          // standing still against 7.05 and 6.03 swimming, with the population
          // inside 45 m down only 16%, and an along-track forward share of 0.17
          // and 0.16 against 0.50 by symmetry. See NEARFIELD_FORWARD_SHARE.
          //
          // `b` is the ACROSS-TRACK offset and is drawn over the full width,
          // because the flux entering the ball is uniform in it; the along-track
          // leg is then the chord that puts the seed at exactly
          // NEARFIELD_LEAD_FRAC * R, beyond the hide radius at every bearing, so
          // the pop rule below is satisfied without being consulted.
          //
          // VECTORS, NOT HEADINGS. This is the one direction-coupled term in the
          // whole seeding path, and it must not go through the (sin, cos) pair
          // in the branch below, whose th = 0 points SOUTH rather than north -
          // harmless while that draw is uniform, fatal the moment a direction
          // means something.
          const ul = ((region.seq * R2_ALPHA1) + attempt * 0.17 + rng() * 0.10) % 1;
          const b = (2 * ul - 1) * region.leadR;
          const alongLeg = Math.sqrt(Math.max(0, region.leadR * region.leadR - b * b));
          x = region.x + region.leadX * alongLeg - region.leadZ * b;
          z = region.z + region.leadZ * alongLeg + region.leadX * b;
          // The chord of the ball at the leading radius, not at |b|: the seed
          // sits at exactly region.leadR from the centre whatever b is.
          regHalfY = Math.sqrt(Math.max(0,
            region.rMax * region.rMax - region.leadR * region.leadR));
        } else if (region) {
          // RADIUS AND BEARING ARE BOTH STRATIFIED ACROSS GROUPS, never drawn
          // independently.
          //
          // The near field arrives as ten SHOALS, not as 150 independent
          // animals, so the annulus is being sampled with ten points however
          // many fish they contain - and ten independent draws cover neither
          // axis. On the radius: six independent area-uniform draws leave the
          // inner 16% of the ring empty 42% of the time, MEASURED as 110 agents
          // inside 45 m, 29 inside 30 m and ZERO inside 20 m. On the BEARING it
          // is worse, because the camera only ever sees one 96 deg wedge of the
          // circle: ten independent draws put nothing at all in that wedge 5% of
          // the time and one group in it 30% of the time, which is exactly the
          // MEASURED spread of 2, 10, 17 and 39 drawn instances across four runs
          // of one identical build.
          //
          // R2 is the 2-D low-discrepancy sequence built from the plastic
          // number; it costs two multiplies, has no period, and its successive
          // points are spread over BOTH axes at once, so fifteen groups cover
          // the circle to within 24 deg and the view wedge always holds three or
          // four of them.
          //
          // The bearing additionally steps 0.2 of a turn per placement ATTEMPT,
          // so a group the camera rule refuses looks 72 deg away rather than
          // re-rolling the same bearing twelve times and being abandoned.
          const u = ((region.seq * R2_ALPHA1) + rng() * 0.10) % 1;
          const th = TAU * (((region.seq * R2_ALPHA2) + attempt * 0.2
            + rng() * 0.03) % 1);
          const rLo = region.rDrawMin;
          const rHi = Math.max(rLo, region.rDraw);
          // The general annulus maps u BY AREA - that is the flat density law,
          // and it is what the sqrt does. A FORCED QUOTA group maps it LINEARLY
          // in radius instead, because inside a quota shell the area law
          // re-creates the very lottery the quota exists to remove: over
          // [5.9, 20.3] m it puts only 17% of the draw inside 10 m, and a fill
          // contains two or three forced groups in total. MEASURED live at the
          // lagoon with the area law inside the shell: 0 agents inside 10 m and
          // 31 piled into 10-15 m. Linear puts 29% inside 10 m, and since u
          // walks the R2 sequence consecutive forced groups take opposite ends
          // of the shell rather than both landing in the middle.
          const r = region.rDraw < region.rMax
            ? lerp(rLo, rHi, u)
            : Math.sqrt(lerp(rLo * rLo, rHi * rHi, u));
          if (region.aimSpread > 0) {
            // THE HERO'S BEARING, rotated off the view axis rather than drawn on
            // a compass. VECTORS, NOT HEADINGS, for the same reason the
            // leading-edge branch above says so: `th` here has 0 pointing SOUTH,
            // which is harmless while the draw is uniform and wrong the moment a
            // direction means something. The offset still walks the R2 sequence
            // and still steps with `attempt`, so consecutive refusals look
            // elsewhere in the wedge instead of re-rolling the same point.
            const a = (2 * (((region.seq * R2_ALPHA2) + attempt * 0.37
              + rng() * 0.08) % 1) - 1) * region.aimSpread;
            const ca = Math.cos(a), sa = Math.sin(a);
            x = region.x + r * (region.aimX * ca - region.aimZ * sa);
            z = region.z + r * (region.aimZ * ca + region.aimX * sa);
          } else {
            x = region.x + r * Math.sin(th);
            z = region.z + r * Math.cos(th);
          }
          // The chord of the ball at this radius. Drawn here and INTERSECTED
          // into the habitat branch below rather than written into `y`: the
          // pelagic branch resamples y over the species' whole legal depth range
          // a few lines down, so a y assigned here was dead code. MEASURED with
          // it dead, eye at y = -200 over a seabed at -410.6 m: 0 agents inside
          // the radius, 140 seeded and 73 retired in 8 s, 7,005 placement
          // attempts - a permanent spawn/retire treadmill hundreds of metres
          // from the player. `y` is deliberately left unassigned here; every
          // habitat branch below assigns it, and assigning it twice is how the
          // draw came to be dead in the first place.
          regHalfY = Math.sqrt(Math.max(0, region.rMax * region.rMax - r * r));
          // A HERO'S vertical extent is an ELEVATION, not the ball's chord. At
          // 25 m the chord is +/- 37 m, which is +/- 56 deg against the camera's
          // 37.5 deg vertical half-angle, so leaving it alone would throw away
          // most of what aiming the bearing just bought. See
          // NEARFIELD_HERO_TAN_ELEV.
          if (region.aimSpread > 0) {
            regHalfY = Math.min(regHalfY, r * region.aimTanElev);
          }
        } else {
          x = cell.centerX + (rng() * 2 - 1) * CELL_X * 0.5;
          y = cell.centerY + (rng() * 2 - 1) * CELL_Y * 0.5;
          z = cell.centerZ + (rng() * 2 - 1) * CELL_Z * 0.5;
        }

        this.stats.spawnAttempts++;

        // ---- ENFORCEMENT LEVEL 1, again, at the exact point ------------
        // The cell filter already excluded this species if the cell touches
        // the charter, but a school seeded near a cell edge can scatter a
        // member across it, so the position itself is re-checked. This is the
        // test that makes the invariant hold for every individual rather than
        // for every cell.
        if (st.tier[sp] > charterMaxTier(x, z)) {
          this.stats.charterBlocked++;
          continue;
        }
        const ground = terrain.sampleHeightFast(x, z);
        if (region && this._eyeInCave && CAVE_SPECIES[sp]) {
          // CAVE placement: the candidate is accepted or refused by the
          // volumetric field itself, never by the column - the heightfield
          // over a chamber is a roof, and both the benthic and pelagic
          // branches below would read it as a seabed above the eye and
          // refuse everything (or worse, place against it). A school member
          // keeps the y its seed-ball draw gave it; an independent candidate
          // draws y over the ball's chord at its radius. The clearance floor
          // keeps a fish out of the wall the marched surface wobbles through;
          // caveVoidAt is the same admission gate the collision world uses,
          // so "spawnable here" and "swimmable here" are one predicate.
          if (!(isSchool && haveSeed)) {
            y = region.y + (rng() * 2 - 1) * regHalfY;
          }
          const clear = Math.max(CAVE_PLACE_CLEARANCE_MIN, st.length[sp] * 0.8);
          if (caveVoidAt(x, y, z) < clear) { this.stats.rejected++; continue; }
        } else if (habitat === HABITAT.BENTHIC) {
          // Sit on the seabed, and refuse a slope steeper than 38 degrees
          // (tan 38 deg = 0.781), DESIGN/06.6.3.
          if (terrain.sampleSlope(x, z) > 0.781) { this.stats.rejected++; continue; }
          y = ground + st.length[sp] * 0.35;
          if (y > -0.5) { this.stats.rejected++; continue; }
          // A benthic near-field candidate is only worth a slot if the SEABED
          // itself is inside the ball. Over deep water it never is, and without
          // this test the director put bottom-dwellers 200 m below the eye,
          // never counted them inside R, and spawned and retired them forever.
          if (region && Math.abs(y - region.y) > regHalfY) {
            this.stats.rejected++;
            continue;
          }
        } else if (habitat === HABITAT.LAND) {
          if (ground < 0.5 || terrain.sampleSlope(x, z) > 0.9) { this.stats.rejected++; continue; }
          y = ground + st.length[sp] * 0.25;
        } else if (habitat === HABITAT.AIR) {
          if (ground < 0.5) { this.stats.rejected++; continue; }
          y = Math.max(ground + 6, ground + rng() * 120);
        } else {
          // PELAGIC: inside the water column, inside the species' depth band,
          // and clear of the seabed by a body length.
          let top = Math.min(-0.5, -st.depthMin[sp]);
          let bottom = Math.max(ground + st.length[sp] * 1.5, -st.depthMax[sp]);
          // ...and, for the near field, inside the BALL as well. The species'
          // legal slab is hundreds of metres tall in open water; resampling over
          // all of it is what threw the region's own vertical extent away.
          if (region) {
            top = Math.min(top, region.y + regHalfY);
            bottom = Math.max(bottom, region.y - regHalfY);
          }
          if (bottom >= top) { this.stats.rejected++; continue; }
          // RESAMPLE, do not clamp. The draw above spans 128 m of cell while the
          // habitable slice is often 14 m of it, so clamping collapsed 87.5% of
          // every draw onto one boundary - and for a species whose only legal
          // cells were the slab from y = 0 to y = +128 m, EVERY draw was above
          // `top` and every fish landed at exactly y = -0.5 m. MEASURED live:
          // Coppersprat n = 35, median y -1.3 m, max -0.5 m, pressed into the
          // surface film where a diver at 6 m never sees them. School members
          // still clamp, because they must stay with their seed.
          y = (isSchool && haveSeed) ? clamp(y, bottom, top)
            : bottom + rng() * (top - bottom);
        }

        // The authored Pale Herald reveal owns this one volume. It is not a
        // safe zone: the staged leviathan is dangerous after its reveal, but
        // ambient population would erase the black negative space beforehand.
        if (insideAbyssEncounterStage(x, y, z)) {
          this.stats.rejected++;
          continue;
        }

        // The Splitmaw's hunting ground: same construction, standing. Only
        // the leviathan tier is exempt - see the predicate's docstring for
        // why the cell-level dead-zone gate could not close this alone.
        if (st.tier[sp] < 4 && insideSplitmawHuntingGround(x, y, z)) {
          this.stats.rejected++;
          continue;
        }

        // The station's pressure hull is solid. Rejected here as well as culled
        // in _cull, because placing an animal inside a room and deleting it a
        // step later is a visible pop; see insideHabitatVolume().
        if (insideHabitatVolume(x, y, z, 0.6)) {
          this.stats.rejected++;
          continue;
        }

        // The band budget, charged where the animal ACTUALLY LANDS. The cell
        // level check is a coarse pre-filter on the column's middle; this is the
        // one that holds, and it is what stops a cell straddling two bands from
        // emptying the shallow budget into the deep one or the reverse.
        //
        // AND THE NEAR FIELD'S RESERVATION IS HELD HERE, not only in
        // resolveCell's headroom. That headroom is computed for the band of the
        // cell's own water column, so it only ever defends the ONE band
        // _bandOfCellWater reports - MEASURED at the lagoon, 3 of 28 resolved
        // cells reported the eye's band, and the other 25 charged their animals
        // to it against the full 176. Band 1 reached 176 before the player was
        // in the water, _placeGroup then refused every near-field seed, and the
        // lagoon drew ZERO instances with 215 agents alive.
        const band = depthBandIndex(Math.max(0, -y));
        // `budgetSlack` is the prowler's one extra slot, the band-budget form
        // of NEARFIELD_POOL_RESERVE's reasoning: the deepest bands' budgets are
        // 24-36 and are typically HELD in steady state, so a rule with no
        // slack makes the staged predator structurally impossible exactly
        // where the danger tiers say it belongs - MEASURED at the trench wall
        // anchor, the picker returned Umbral Squid with the clock expired and
        // every placement was refused here, band 5 at 24 of 24.
        const bandCap = BAND_BUDGET[band] + (region ? (region.budgetSlack | 0) : 0);
        if (this.bandCount[band] >= bandCap ||
            (!region && this.bandCellCount[band] >= this._cellBandBudget(band))) {
          this.stats.budgetPressure++;
          bandBlocked = true;
          continue;
        }

        // Poisson-disc: no candidate within `sep` of an existing agent.
        if (this._tooClose(x, y, z, sep)) { this.stats.rejected++; continue; }

        // POP CONTROL. Inside NEARFIELD_HIDE_FRAC of the radius a near-field
        // animal may only be seeded where the camera is not looking; outside it
        // the water does the hiding, which is the whole point of deriving the
        // radius from the water's own contrast limit. Refusing the WHOLE annulus
        // on camera instead piled the entire population behind the player -
        // MEASURED, 78 instances drawn on the heading opposite the one the
        // director had been filling against and 0 on two of the other seven.
        if (region && region.camera && region.camera.isSphereVisible) {
          const dx = x - region.x, dz = z - region.z, dy = y - region.y;
          if (dx * dx + dy * dy + dz * dz < region.hide2) {
            _visPoint[0] = x; _visPoint[1] = y; _visPoint[2] = z;
            if (region.camera.isSphereVisible(_visPoint, st.length[sp] * 0.6)) {
              this.stats.rejected++;
              continue;
            }
          }
        }

        const handle = sim.spawn(sp, x, y, z, {
          schoolId,
          heading: rng() * TAU,
          homeX: isSchool && haveSeed ? seedX : x,
          homeY: isSchool && haveSeed ? seedY : y,
          homeZ: isSchool && haveSeed ? seedZ : z,
        });
        if (handle < 0) return spawned;          // pool full: stop trying

        // Written on EVERY spawn, both values, so a recycled slot cannot inherit
        // the previous animal's retirement rule.
        this._nearFieldSlot[handle & 0xffff] = region ? 1 : 0;

        if (isSchool && !haveSeed) { seedX = x; seedY = y; seedZ = z; haveSeed = true; }
        this.bandCount[band]++;
        if (!region) this.bandCellCount[band]++;
        if (st.tier[sp] >= 3) this.bandTier3[band]++;
        if (st.tier[sp] >= 4) this.bandTier4[band]++;
        this.speciesCount[sp]++;
        if (cell) cell.population++;
        spawned++;
        this.stats.spawned++;
        placed = true;
      }
      // Twelve independent draws all refused by a full depth band means the band
      // is full, not that this member was unlucky. Abandon the group.
      if (!placed && bandBlocked) break;
    }
    return spawned;
  }

  /** True if any live agent is within `sep` of the point. */
  _tooClose(x, y, z, sep) {
    if (!(sep > 0)) return false;
    return this.sim.hash.nearest(x, y, z, sep, _nearScratch) >= 0;
  }

  // -------------------------------------------------------------------------
  // Depletion
  // -------------------------------------------------------------------------

  /**
   * Record that a creature died, so its cell stops producing that species for
   * a while. Call this from whatever kills things - the sim emits
   * CREATURE_DESPAWN with a reason, and 'killed'/'eaten' are the two that
   * deplete.
   *
   * @param {number} speciesIndex
   * @param {number} x @param {number} y @param {number} z
   */
  noteDeath(speciesIndex, x, y, z) {
    const cell = this.cells.get(this._keyForPosition(x, y, z));
    if (!cell) return;
    const expected = Math.max(1, sizeClass(SPECIES_TABLE.length[speciesIndex]).cell);
    cell.depletion[speciesIndex] = Math.min(MAX_DEPLETION,
      cell.depletion[speciesIndex] + 1 / expected);
    cell.killed++;
    cell.visited = true;
  }

  /**
   * Fill the population around a point before the first frame. Used at boot so
   * the player does not watch the ocean fill up.
   *
   * @param {ArrayLike<number>} position
   * @param {object} [worldClock]
   * @param {number} [radius] metres; defaults to the active cell radius
   * @returns {number} agents spawned
   */
  prime(position, worldClock = null, radius = CELL_ACTIVE_XZ) {
    this._census();
    // Every prime is an arrival, and the predator is the SECOND beat of one:
    // re-arm the first-encounter delay so a teleport reads the biome before
    // the biome's apex reads the player.
    this._prowlerCooldown = NEARFIELD_PROWLER_FIRST;
    this._prowlerPresent = false;
    // The near field FIRST, and it is filled here rather than left to the first
    // few updates for the same reason prime() exists at all: the alternative is
    // a player who watches the water around them fill up. There is no camera
    // yet, so nothing can be seen arriving anyway.
    this._updateNearFieldGeometry(position);
    let nearTotal = 0;
    for (let guard = 0; guard < NEARFIELD_TARGET; guard++) {
      const got = this._maintainNearField(position, worldClock);
      if (got === 0) break;
      nearTotal += got;
      this._census();
    }

    const c0x = Math.floor((position[0] - radius) / CELL_X);
    const c1x = Math.floor((position[0] + radius) / CELL_X);
    const c0z = Math.floor((position[2] - radius) / CELL_Z);
    const c1z = Math.floor((position[2] + radius) / CELL_Z);
    const c0y = Math.floor((position[1] - CELL_ACTIVE_Y) / CELL_Y);
    const c1y = Math.floor((position[1] + CELL_ACTIVE_Y) / CELL_Y);

    // Nearest first: the water the player is standing in must be populated
    // before the water 900 m away, because the budget will run out.
    const jobs = [];
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cz = c0z; cz <= c1z; cz++) {
        for (let cx = c0x; cx <= c1x; cx++) {
          const centerX = cx * CELL_X + CELL_X * 0.5;
          const centerY = cy * CELL_Y + CELL_Y * 0.5;
          const centerZ = cz * CELL_Z + CELL_Z * 0.5;
          const d = Math.hypot(centerX - position[0], centerY - position[1],
            centerZ - position[2]);
          if (d > radius) continue;
          jobs.push({ cx, cy, cz, d });
        }
      }
    }
    jobs.sort((a, b) => a.d - b.d);
    let total = nearTotal;
    for (const job of jobs) {
      if (this.sim.count >= this.sim.capacity) break;
      total += this.resolveCell(job.cx, job.cy, job.cz, worldClock);
      this._census();
    }
    return total;
  }

  /**
   * Diagnostic: how many live agents of tier > `tier` are inside the charter.
   * MUST be zero. Exposed so the acceptance test and the debug overlay can
   * both assert it.
   */
  charterViolations(tier = 0) {
    const sim = this.sim;
    const live = sim.liveSlots();
    let n = 0;
    for (let k = 0; k < live.length; k++) {
      const i = live[k];
      if (sim.tier[i] <= tier) continue;
      if (sim.tier[i] <= charterMaxTier(sim.posX[i], sim.posZ[i])) continue;
      n++;
    }
    return n;
  }
}

/** Scratch for the Poisson-disc nearest test. Never allocated per placement. */
const _nearScratch = new Int32Array(RENDER.MAX_CREATURES);

/** Scratch point for the near field's frustum test. Never allocated per attempt. */
const _visPoint = new Float64Array(3);

/** Scratch for the near field's nested shell census. Never allocated per step. */
const _shellR2 = new Float64Array(NEARFIELD_SHELLS.length);
const _shellCount = new Int32Array(NEARFIELD_SHELLS.length);

/** Re-exported so callers do not need two imports to read a creature's LOD. */
export { CREATURE_LOD };
