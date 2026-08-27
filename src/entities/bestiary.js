/**
 * SUBWAVE bestiary - the complete species catalogue.
 *
 * Thirty-seven animals, transcribed from DESIGN/06 section 06.4. This file is
 * DATA ONLY: no behaviour, no simulation, no geometry. The AI reads it to pick
 * behaviours, the spawner reads it to decide what is legal where, the audio bed
 * reads it for call fundamentals, and src/entities/creature_mesh.js reads
 * `meshRecipe` to grow the body. Nothing here allocates, ticks or draws.
 *
 * FOUR THINGS DIVERGE FROM DESIGN/06, ALL OF THEM BECAUSE constants.js WINS:
 *
 *   1. Depth. DESIGN/06's bands run to 3,200 m; WORLD.MAX_DEPTH is 1,600 m, so
 *      every `depthRange` maximum is clamped to the trench floor this world
 *      actually has. The species that the design puts at 2,000-3,200 m are the
 *      trench species here, unchanged in every other respect. Two records -
 *      Saltwraith and Nethercoil - have a hand-scaled range rather than a
 *      clamped one, because clamping a band that starts at 1,500 m or 1,650 m
 *      leaves no habitat at all; both carry a comment saying so.
 *   2. Bones. DESIGN/06 allows 32 (48 for leviathans);
 *      RENDER.MAX_BONES_PER_CREATURE is 28 and creature_mesh clamps to it.
 *      `meshRecipe.spineBones` is already inside that budget for all 37.
 *   3. Biomes. DESIGN/06 names eighteen BIO_* zones; world/biomes.js ships
 *      fourteen. The mapping is in BIOME_ALIAS below - it is a rename, not a
 *      reinterpretation, except that BIO_PELAGIC, BIO_CAVE and BIO_VENT are not
 *      terrain biomes at all and become the three CREATURE_HABITAT pseudo-ids.
 *   4. Vertex counts. The design's per-species LOD0 counts assume a 32-bone
 *      skinned pipeline; ours is tighter (small fish < 400, leviathans < 6,000)
 *      and creature_mesh owns that budget, so no count is duplicated here.
 *
 * Units, restated because getting them wrong is silent: metres, kilograms,
 * seconds, HP, m/s, DEGREES per second for `turnRate` (the only degree quantity
 * in the file, matching the design tables), individuals per km^3 of habitable
 * water (per km^2 for land species, see `densityIsAreal`), and LINEAR RGB for
 * every colour. `depthRange` is POSITIVE DOWN: `[-140, -2]` is an animal that
 * flies between 2 m and 140 m ABOVE the sea.
 */

import { WORLD, RENDER } from '../core/constants.js';
import { BIOME_COUNT } from '../world/biomes.js';
import { clamp } from '../core/math.js';

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/**
 * Behavioural archetype. Drives the steering weights (DESIGN/06 06.1.7), the
 * animation parameters (06.3.5) and the default body plan, so it is the single
 * most load-bearing field in a record.
 *
 * These eighteen are the game's archetypes; `steering` on each record names the
 * design's ARCH_* row that supplies the blend weights, because four of ours
 * (landShore, landFlyer, caveDweller, ventSpecialist) are habitat distinctions
 * that share a locomotion model with another archetype.
 */
export const ARCHETYPE = Object.freeze({
  PLANKTON: 'plankton',
  REEFFISH: 'reeffish',
  SCHOOLING: 'schooling',
  GRAZER: 'grazer',
  SCAVENGER: 'scavenger',
  CRUSTACEAN: 'crustacean',
  JELLY: 'jelly',
  CEPHALOPOD: 'cephalopod',
  RAY: 'ray',
  AMBUSH: 'ambush',
  PACK: 'pack',
  ANGLER: 'angler',
  FILTER_GIANT: 'filterGiant',
  VENT_SPECIALIST: 'ventSpecialist',
  CAVE_DWELLER: 'caveDweller',
  LAND_SHORE: 'landShore',
  LAND_FLYER: 'landFlyer',
  LEVIATHAN: 'leviathan',
});

/** Every archetype, in declaration order. The roster must cover all of them. */
export const ARCHETYPE_LIST = Object.freeze(Object.values(ARCHETYPE));

/**
 * Swim mode, from DESIGN/06 06.3.2. The animation layer needs `lambdaB`, the
 * amplitude envelope and the active spine fraction; all three follow from the
 * mode, so the mode is what a record stores.
 */
export const SWIM_MODE = Object.freeze({
  ANGUILLIFORM: 'anguilliform',
  SUB_CARANGIFORM: 'subCarangiform',
  CARANGIFORM: 'carangiform',
  THUNNIFORM: 'thunniform',
  OSTRACIIFORM: 'ostraciiform',
  RAJIFORM: 'rajiform',
  JET: 'jet',
  WALK: 'walk',
  FLAP: 'flap',
  STATIC: 'static',
});

/**
 * Bioluminescent PATTERN, not brightness. The whole point of the field is that
 * creature_mesh turns it into a per-vertex mask so a Wisplight reads as
 * twenty-two discrete ventral dots and a Lanterngape reads as one point of
 * light in front of a face - never as a uniformly glowing animal, which is the
 * failure mode every emissive creature shader falls into.
 */
export const BIOLUM_PATTERN = Object.freeze({
  NONE: 'none',
  SPOTS: 'spots',
  STRIPES: 'stripes',
  VENTRAL_ROWS: 'ventralRows',
  BELL_RIM: 'bellRim',
  CHAIN_PULSE: 'chainPulse',
  NET: 'net',
  LURE: 'lure',
  JAW_PORES: 'jawPores',
  PIT_LIGHTS: 'pitLights',
  FLOOD_ORGAN: 'floodOrgan',
  MOUTH_GLOW: 'mouthGlow',
  SPINE_TIPS: 'spineTips',
  JOINTS: 'joints',
  ABDOMEN: 'abdomen',
  DISCHARGE_ARCS: 'dischargeArcs',
  /**
   * The whole tentacle curtain glows base to tip, with a lit bell rim over
   * it - the Starweaver's radiating-filament display
   * (the electric-blue tendril star in the Platter Forest reference). No
   * existing pattern reaches the 'tentacle' part kind at all, which is why
   * this is a new pattern rather than a reuse: BELL_RIM stops at the bell
   * and CHAIN_PULSE lights a siphonophore stem.
   */
  TENDRILS: 'tendrils',
  /**
   * A dull ember wash over the dorsal half of the trunk, the mandible horns
   * and the crest - NOT a photophore display. Built 2026-08-19 for the
   * Splitmaw, off the Sunken Dunes fan lesson (scatter id 70): at 348 m the
   * illuminant carries no red, so a red REFLECTANCE delivers blue-grey no
   * matter how it is authored, and the only spectrum an object owns is the
   * one it emits. The mask is capped at 0.5 so the material slot stays
   * SKIN (creature_mesh flips to unshaded EMISSIVE past 0.55) - the ember
   * is a glow on shaded tissue, which is what keeps a low-intensity red
   * wash reading as pigmented hide rather than as neon.
   */
  DORSAL_EMBER: 'dorsalEmber',
  FLASH_BURST: 'flashBurst',
  COUNTER_ILLUM: 'counterIllum',
  THERMAL_PATCHES: 'thermalPatches',
  /**
   * Not emissive at all: a structure that forward-scatters a lamp beam so hard
   * that it glows like a filament when lit and is invisible when not. The
   * Emberworm's haemoglobin gill plume and the Veilmote's mucous house are the
   * two, and both need the mask on the STRUCTURE rather than on the body.
   */
  SCATTER_GLOW: 'scatterGlow',
});

/** Placement mode for the spawner, DESIGN/06 06.6.3. */
export const HABITAT = Object.freeze({
  PELAGIC: 'pelagic',
  BENTHIC: 'benthic',
  CREVICE: 'crevice',
  CANOPY: 'canopy',
  WALL: 'wall',
  VENT: 'vent',
  BRINE_EDGE: 'brineEdge',
  LAND: 'land',
  AIR: 'air',
  TERRITORY: 'territory',
});

/**
 * Habitat pseudo-biomes. `biomes` on a record is a list of ids that are USUALLY
 * world/biomes.js biome ids (0..13); these three continue the numbering for the
 * habitats that are not a seabed classification at all:
 *
 *   PELAGIC  open water with no floor within 120 m
 *   CAVE     the Undervault, from world/caves.js - enclosed, any depth
 *   VENT     within 60 m of an active hydrothermal chimney
 *
 * A spawner therefore tests a candidate cell for three things (biome id, "is
 * this open water", "is this a vent field / a cave") rather than needing a
 * fifteenth, sixteenth and seventeenth terrain biome that would never classify.
 */
export const CREATURE_HABITAT = Object.freeze({
  PELAGIC: BIOME_COUNT,
  CAVE: BIOME_COUNT + 1,
  VENT: BIOME_COUNT + 2,
});

/** Total id space of `biomes` entries: 14 real biomes + 3 pseudo-habitats. */
export const HABITAT_ID_COUNT = BIOME_COUNT + 3;

/**
 * DESIGN/06 BIO_* token -> the id used in this file. Kept as data so the
 * mapping is auditable rather than folded silently into 37 records.
 */
export const BIOME_ALIAS = Object.freeze({
  BIO_STRAND: 0,          // Volcanic Beach
  BIO_ISLE: 1,            // Island Basalt
  BIO_CLIFF: 1,           // sea cliffs are basalt at a steeper slope
  BIO_REEF: 2,            // Shallow Reef
  BIO_CORAL: 3,           // Coral Garden
  BIO_FLAT: 4,            // Sand Plains (the Pale Flats)
  BIO_MEADOW: 4,          // Ribbon Meadows sit on the sand plains
  BIO_KELP: 5,            // Kelp Forest (the Amber Forest)
  BIO_RUBBLE: 6,          // Boulder Field
  BIO_STEPDOWN: 7,        // Shelf Break
  BIO_WALL: 8,            // Rock Spires / the Bathyal Wall proper
  BIO_SPONGE: 9,          // Twilight Terraces (the Sponge Terraces)
  BIO_CANYON: 10,         // Canyon Wall (Longfall Canyon)
  BIO_ASHPLAIN: 11,       // Abyssal Plain (the Ashfall Plain)
  BIO_TRENCHWALL: 12,     // Trench Wall
  BIO_TRENCH: 13,         // Trench Floor (the Nethertrench)
  BIO_BRINE: 13,          // the Still Lake sits on the trench floor
  BIO_PLATTER: 17,        // Platter Forest (2026-08-18; 14-16 have no fauna tokens yet)
  BIO_DUNES: 18,          // Sunken Dunes (2026-08-19; the Splitmaw's hunting ground)
  BIO_PELAGIC: CREATURE_HABITAT.PELAGIC,
  BIO_CAVE: CREATURE_HABITAT.CAVE,
  BIO_VENT: CREATURE_HABITAT.VENT,
});

// Short local aliases so the table below reads as prose, exactly as the scatter
// table does. Same numbering as world/biomes.js.
const STRAND = 0, ISLE = 1, REEF = 2, CORAL = 3, FLAT = 4, KELP = 5;
const RUBBLE = 6, STEPDOWN = 7, WALL = 8, SPONGE = 9, CANYON = 10;
const ASHPLAIN = 11, TRENCHWALL = 12, TRENCH = 13, PLATTER = 17, DUNES = 18;
const PELAGIC = CREATURE_HABITAT.PELAGIC;
const CAVE = CREATURE_HABITAT.CAVE;
const VENT = CREATURE_HABITAT.VENT;

/** No bioluminescence at all: shared so 14 records do not repeat it. */
const DARK = { colour: [0, 0, 0], intensity: 0, pattern: BIOLUM_PATTERN.NONE, isLure: false, hz: 0 };

// ---------------------------------------------------------------------------
// Danger tiers
// ---------------------------------------------------------------------------

/**
 * Tier semantics and the BINDING telegraph budget, DESIGN/06 06.1.4 and 06.4.1.
 *
 * `windup` is the mandatory tell: the attack animation may not begin before it
 * has elapsed and the audio cue fires at its first frame. `rearArcExtra` is
 * added when the attack comes from outside the player's 100 degree front cone,
 * which is the rule that keeps an unseen attack survivable. `recoverBonus` is
 * the extra damage the attacker takes during recovery - the counter-attack
 * window that makes every fight in the game a rhythm rather than a race.
 *
 * `respawnHalfLife` is in GAME seconds (SKY.SECONDS_PER_DAY = 1200 s per day),
 * so tier 4's twelve game-hours is 600 s of real time.
 */
export const DANGER_BY_TIER = Object.freeze([
  Object.freeze({
    tier: 0, name: 'Harmless', short: 'benign',
    description: 'Never reduces player health under any circumstance.',
    harmsPlayer: false, windup: 0, lunge: 0, recover: 0, rearArcExtra: 0,
    recoverBonus: 0, respawnHalfLife: 360, safeCharterLegal: true,
  }),
  Object.freeze({
    tier: 1, name: 'Hazard', short: 'hazard',
    description: 'Harms only on contact or under direct provocation. Never pursues.',
    harmsPlayer: true, windup: 0.35, lunge: 0.25, recover: 0.60, rearArcExtra: 0.30,
    recoverBonus: 0.35, respawnHalfLife: 1080, safeCharterLegal: false,
  }),
  Object.freeze({
    tier: 2, name: 'Provoked', short: 'provoked',
    description: 'Attacks under specific, learnable triggers. Does not hunt.',
    harmsPlayer: true, windup: 0.55, lunge: 0.35, recover: 0.80, rearArcExtra: 0.40,
    recoverBonus: 0.35, respawnHalfLife: 2700, safeCharterLegal: false,
  }),
  Object.freeze({
    tier: 3, name: 'Predator', short: 'predator',
    description: 'Actively hunts the player. Committed, telegraphed attack cycles.',
    harmsPlayer: true, windup: 0.80, lunge: 0.45, recover: 1.10, rearArcExtra: 0.60,
    recoverBonus: 0.35, respawnHalfLife: 7200, safeCharterLegal: false,
  }),
  Object.freeze({
    tier: 4, name: 'Crippler', short: 'crippler',
    description: 'Hunts the vessel and can disable it. Hard depth limits are the counterplay.',
    harmsPlayer: true, windup: 1.20, lunge: 0.70, recover: 1.90, rearArcExtra: 0.60,
    recoverBonus: 0.35, respawnHalfLife: 43200, safeCharterLegal: false,
  }),
  Object.freeze({
    tier: 5, name: 'Apex', short: 'apex',
    description: 'Destroys the vessel and kills an unprotected player in two hits. Not a fight.',
    harmsPlayer: true, windup: 1.60, lunge: 0.95, recover: 2.60, rearArcExtra: 0.60,
    recoverBonus: 0.40, respawnHalfLife: Infinity, safeCharterLegal: false,
  }),
]);

// ---------------------------------------------------------------------------
// THE ROSTER
// ---------------------------------------------------------------------------

/**
 * Every species. Field reference:
 *
 *   id                  stable string key; CREATURE_* events carry it
 *   name / latinish     display name and the scanner's binomial
 *   archetype           ARCHETYPE - behaviour family
 *   steering            DESIGN/06 06.1.7 ARCH_* row for the blend weights
 *   swimMode            SWIM_MODE - drives the travelling-wave animation
 *   habitat             HABITAT - how the spawner places it
 *   biomes              biome ids / CREATURE_HABITAT pseudo-ids it may spawn in
 *   depthRange          [min, max] POSITIVE metres below sea level; negative is
 *                       above the waterline (land and air species)
 *   length              metres, nose to tail (disc width for rays, wingspan for
 *                       flyers is in meshRecipe)
 *   mass                kg
 *   diet                what it eats, for the trophic graph
 *   dangerTier          0..5, indexes DANGER_BY_TIER
 *   aggressionTrigger   the exact condition that raises threat past T_commit
 *   damage              {player, vessel} HP per hit, plus `effect` for the
 *                       non-damage consequences (EMP, latch, drag-under)
 *   health              HP
 *   speed / burstSpeed  m/s cruise and m/s burst. burstSpeed >= speed always
 *   turnRate            DEGREES per second
 *   schoolSize          [min, max] individuals that spawn together
 *   densityPerKm3       target statistical density; per km^2 when
 *                       `densityIsAreal` is true (land species only)
 *   dayNightActivity    [day, night] multipliers in [0, 2] on spawn weight and
 *                       idle speed
 *   lightAffinity       -1 photophobic .. +1 phototactic
 *   lightFlipRadius     metres; beyond it lightAffinity keeps its sign, inside
 *                       it flips. 0 = no flip. Produces "it circled the light,
 *                       then bolted, then came back"
 *   threatTau           seconds; the threat accumulator's decay constant
 *   electroR            metres of electroreception, 0 if it has none
 *   bioluminescence     {colour linear RGB, intensity HDR, pattern, isLure, hz}
 *   audioHz             fundamental of its voice, 0 if it is silent
 *   meshRecipe          creature_mesh parameters; `plan` picks the body plan and
 *                       everything else overrides that plan's defaults
 *   note                art and behaviour direction, 2-4 sentences
 */
const ROSTER = [

  // =========================================================================
  // LAND AND SHORE  (DESIGN/06 06.4.2)
  // =========================================================================

  {
    id: 'CRT_TIDECLAW', name: 'Tideclaw', latinish: 'Litoractus pallidus',
    archetype: ARCHETYPE.LAND_SHORE, steering: 'ARCH_CRUSTACEAN', swimMode: SWIM_MODE.WALK,
    habitat: HABITAT.LAND, biomes: [STRAND, ISLE, RUBBLE], depthRange: [-4, 3],
    length: 0.34, mass: 0.9,
    diet: ['detritus', 'stranded algae', 'carrion'],
    dangerTier: 0,
    aggressionTrigger: 'none; raises the shield claw if approached inside 1.2 m',
    damage: { player: 0, vessel: 0, effect: 'pinch is a 0.3 s stagger only' },
    health: 8, speed: 0.55, burstSpeed: 2.10, turnRate: 300,
    schoolSize: [6, 40], densityPerKm3: 380, densityIsAreal: true,
    dayNightActivity: [0.5, 1.6], lightAffinity: -0.45, lightFlipRadius: 0,
    threatTau: 18, electroR: 0,
    bioluminescence: DARK, audioHz: 2200,
    meshRecipe: {
      plan: 'crustacean', spineBones: 4, girth: 0.62, depth: 0.30,
      tint: [206, 190, 164],
      legs: { count: 8, length: 0.20, radius: 0.012, splay: 1.05 },
      claws: { count: 2, length: 0.15, asymmetry: 0.42 },
      eyestalks: { count: 2, length: 0.05, radius: 0.010 },
      plates: 7, carapaceLift: 0.55,
    },
    note: 'Pale sand-coloured decapods with one oversized bleached claw held like a shield, ' +
      'carapace mottled to the exact beach material under them. They swarm the tide line at night ' +
      'in dozens and the first thing the player ever hears after the surf is a hundred of them ' +
      'clattering away from a footstep. They will steal a dropped item, drag it three metres, and ' +
      'lose interest - the tutorial for "things here react to you and nothing here wants to hurt you".',
  },

  {
    id: 'CRT_VANESKIMMER', name: 'Vaneskimmer', latinish: 'Petravolans longipennis',
    archetype: ARCHETYPE.LAND_FLYER, steering: 'ARCH_FLYER', swimMode: SWIM_MODE.FLAP,
    habitat: HABITAT.AIR, biomes: [ISLE, STRAND, REEF], depthRange: [-140, -2],
    length: 0.46, mass: 0.72,
    diet: ['small fish', 'Saltmoth', 'surface krill'],
    dangerTier: 0,
    aggressionTrigger: 'none; mobs a player within 6 m of an active nest with dives that miss by 0.4 m',
    damage: { player: 0, vessel: 0, effect: null },
    health: 14, speed: 9.5, burstSpeed: 22.0, turnRate: 190,
    schoolSize: [4, 30], densityPerKm3: 260, densityIsAreal: true,
    dayNightActivity: [1.5, 0.1], lightAffinity: -0.10, lightFlipRadius: 0,
    threatTau: 9, electroR: 0,
    bioluminescence: DARK, audioHz: 780,
    meshRecipe: {
      plan: 'flyer', spineBones: 5, girth: 0.11, depth: 0.15,
      tint: [104, 92, 80], ventral: [172, 152, 128],
      wings: { count: 4, span: 0.55, chord: 0.16, camber: 0.08, twist: -0.22, sweep: 0.10 },
      beak: { length: 0.07, hook: 0.35 },
      streamers: { count: 2, length: 0.18, radius: 0.004, taper: 0.30 },
      eyes: { radius: 0.014, at: 0.11, spread: 0.55 },
    },
    note: 'Not a bird: a leathery four-winged glider with a keeled sternum, no feathers, and a ' +
      'membrane veined in orange that lights up when the low sun is behind it. The forewings flap, ' +
      'the hindwings are fixed canards that give it an unsettling dragonfly stability. They plunge-dive ' +
      'on Coppersprat shoals from 30 m, and the sudden silence of their cliff colony is a dread cue ' +
      'the game spends exactly once.',
  },

  {
    id: 'CRT_DUNECREST', name: 'Dunecrest', latinish: 'Fossorgrazus cristatus',
    archetype: ARCHETYPE.LAND_SHORE, steering: 'ARCH_BURROWER', swimMode: SWIM_MODE.WALK,
    habitat: HABITAT.LAND, biomes: [ISLE, STRAND], depthRange: [-90, 1.8],
    length: 0.62, mass: 6.4,
    diet: ['tuber-analogs', 'salt grass', 'lichen crust'],
    dangerTier: 0,
    aggressionTrigger: 'none; freezes, then bolts for the nearest burrow mouth',
    damage: { player: 0, vessel: 0, effect: null },
    health: 34, speed: 0.8, burstSpeed: 4.6, turnRate: 260,
    schoolSize: [1, 3], densityPerKm3: 95, densityIsAreal: true,
    dayNightActivity: [0.7, 1.3], lightAffinity: -0.30, lightFlipRadius: 0,
    threatTau: 10, electroR: 0,
    bioluminescence: DARK, audioHz: 210,
    meshRecipe: {
      plan: 'walker', spineBones: 5, girth: 0.20, depth: 0.24,
      tint: [132, 118, 96],
      legs: { count: 6, length: 0.22, radius: 0.026, splay: 0.55, forelimbScale: 1.4 },
      crest: { count: 9, height: 0.13, chord: 0.05 },
      snout: { length: 0.09, taper: 0.5 },
      tail: { length: 0.14, taper: 0.25, barbs: 0 },
    },
    note: 'A barrel-bodied six-limbed grazer with spade forelimbs, a stiff keratin dorsal crest it ' +
      'raises when alarmed, and no visible eyes - just two vibrissae-ringed pits. It crops salt grass ' +
      'in slow arcs, sitting up every few seconds to sweep the air with its whiskers. Its thump-alarm ' +
      'propagates through the warren, so one startled animal makes every Dunecrest within 60 m sit up, ' +
      'which is the most alive-feeling thing on the island.',
  },

  {
    id: 'CRT_SALTMOTH', name: 'Saltmoth', latinish: 'Nocticeras halina',
    archetype: ARCHETYPE.LAND_FLYER, steering: 'ARCH_FLYER', swimMode: SWIM_MODE.FLAP,
    habitat: HABITAT.AIR, biomes: [ISLE, STRAND], depthRange: [-25, -0.5],
    length: 0.11, mass: 0.006,
    diet: ['nectar-analog from salt-scrub blooms'],
    dangerTier: 0,
    aggressionTrigger: 'none',
    damage: { player: 0, vessel: 0, effect: null },
    health: 1, speed: 1.8, burstSpeed: 4.2, turnRate: 640,
    schoolSize: [8, 120], densityPerKm3: 2400, densityIsAreal: true,
    dayNightActivity: [0.02, 1.9], lightAffinity: 0.95, lightFlipRadius: 0,
    threatTau: 4, electroR: 0,
    bioluminescence: {
      colour: [0.45, 0.62, 0.30], intensity: 0.22,
      pattern: BIOLUM_PATTERN.ABDOMEN, isLure: false, hz: 0.6,
    },
    audioHz: 46,
    meshRecipe: {
      plan: 'flyer', spineBones: 3, girth: 0.13, depth: 0.14,
      tint: [126, 132, 112],
      wings: { count: 4, span: 0.095, chord: 0.055, camber: 0.02, twist: -0.08, sweep: 0.04 },
      antennae: 2,
    },
    note: 'Dusty grey-green moth-analogs with four scalloped wings and an abdomen that glows just ' +
      'enough to read as a drifting spark. They exist for one moment: the first time the player switches ' +
      'on the vessel lamps at night on the beach, forty of them arrive within twelve seconds and orbit ' +
      'in a slow helix. It teaches what light means in the safest place in the game, so that six hours ' +
      'later, when something at 700 m does the opposite, the lesson is already learned.',
  },

  // =========================================================================
  // SUNLIT SHALLOWS  (DESIGN/06 06.4.3)
  // =========================================================================

  {
    id: 'CRT_GLIMMERKRILL', name: 'Glimmerkrill', latinish: 'Micronectes scintillans',
    archetype: ARCHETYPE.PLANKTON, steering: 'ARCH_PLANKTON', swimMode: SWIM_MODE.ANGUILLIFORM,
    // PLATTER added 2026-08-18 with biome 17: the reference frame's drifting
    // krill motes, and the Starweaver's listed prey - the food chain must
    // reach the biome its predator is locked to.
    habitat: HABITAT.PELAGIC, biomes: [PELAGIC, REEF, CORAL, FLAT, STEPDOWN, PLATTER], depthRange: [0, 480],
    length: 0.021, mass: 0.00008,
    diet: ['phytoplankton', 'marine snow'],
    dangerTier: 0,
    aggressionTrigger: 'none',
    damage: { player: 0, vessel: 0, effect: null },
    health: 1, speed: 0.09, burstSpeed: 0.55, turnRate: 900,
    schoolSize: [2000, 12000], densityPerKm3: 4.0e6,
    dayNightActivity: [1.0, 1.0], lightAffinity: -0.55, lightFlipRadius: 0,
    threatTau: 4, electroR: 0,
    bioluminescence: {
      colour: [0.35, 0.85, 1.00], intensity: 1.4,
      pattern: BIOLUM_PATTERN.FLASH_BURST, isLure: false, hz: 8.3,
    },
    audioHz: 4200,
    meshRecipe: {
      plan: 'fusiform', spineBones: 3, girth: 0.13, depth: 0.16, rings: 5, segs: 5,
      tint: [176, 206, 214], biolumCount: 5,
      caudal: { span: 0.006, chord: 0.005, camber: 0.0, fork: 0.2 },
      pleopods: 4,
    },
    note: 'The base of the whole food web and the single most important atmospheric asset in the game: ' +
      'translucent 21 mm shrimp-analogs in clouds dense enough to read as coloured fog with structure. ' +
      'Their signature is disturbance bioluminescence - swim a hand through them and a cyan flash races ' +
      'away in a ring at 14 m/s. Their full diel migration drags half the mid-water predator population ' +
      'up and down with it, which is why the twilight zone is a different place at night.',
  },

  {
    id: 'CRT_VEILMOTE', name: 'Veilmote', latinish: 'Gelatispira tenuis',
    archetype: ARCHETYPE.PLANKTON, steering: 'ARCH_DRIFTER', swimMode: SWIM_MODE.ANGUILLIFORM,
    habitat: HABITAT.PELAGIC, biomes: [PELAGIC], depthRange: [10, 620],
    length: 0.07, mass: 0.004,
    diet: ['nanoplankton (filter)'],
    dangerTier: 0,
    aggressionTrigger: 'none',
    damage: { player: 0, vessel: 0, effect: null },
    health: 1, speed: 0.03, burstSpeed: 0.06, turnRate: 40,
    schoolSize: [20, 300], densityPerKm3: 1.1e5,
    dayNightActivity: [1.0, 1.0], lightAffinity: 0.0, lightFlipRadius: 0,
    threatTau: 2, electroR: 0,
    bioluminescence: {
      colour: [0.20, 0.45, 0.95], intensity: 0.6,
      pattern: BIOLUM_PATTERN.SCATTER_GLOW, isLure: false, hz: 0.7,
    },
    audioHz: 0,
    meshRecipe: {
      plan: 'fusiform', spineBones: 3, girth: 0.16, depth: 0.18, rings: 5, segs: 6,
      tint: [190, 204, 214], biolumCount: 4,
      house: { radius: 0.21 },
      caudal: { span: 0.020, chord: 0.014, camber: 0.0, fork: 0.0 },
    },
    note: 'A larvacean-analog: a tadpole-shaped animal living inside a nearly invisible mucous house ' +
      'the size of a grapefruit that refracts light into a faint lens flare. Every few minutes one ' +
      'abandons a clogged house, which sinks at 0.028 m/s and becomes one of the white flecks that fill ' +
      'the twilight zone. Bump one with the vessel and the house crumples and glows blue as it tumbles ' +
      'away. A pure texture species that makes the water feel occupied at every depth.',
  },

  {
    id: 'CRT_COPPERSPRAT', name: 'Coppersprat', latinish: 'Sprattulus cupreus',
    archetype: ARCHETYPE.SCHOOLING, steering: 'ARCH_SHOALER', swimMode: SWIM_MODE.SUB_CARANGIFORM,
    habitat: HABITAT.PELAGIC, biomes: [REEF, CORAL, FLAT, RUBBLE], depthRange: [0, 55],
    length: 0.11, mass: 0.018,
    diet: ['zooplankton', 'Glimmerkrill'],
    dangerTier: 0,
    aggressionTrigger: 'none',
    damage: { player: 0, vessel: 0, effect: null },
    health: 3, speed: 0.9, burstSpeed: 3.4, turnRate: 420,
    schoolSize: [40, 260], densityPerKm3: 9.0e4,
    dayNightActivity: [1.3, 0.5], lightAffinity: 0.35, lightFlipRadius: 0,
    threatTau: 6, electroR: 0,
    bioluminescence: DARK, audioHz: 240,
    meshRecipe: {
      plan: 'compressed', spineBones: 7, girth: 0.13, depth: 0.31, rings: 8, segs: 8,
      // THE BELLY WAS NEAR-WHITE (226, 224, 214) AND THAT WAS THE PALE SPECK.
      // loftTrunk counter-shades with smoothstep(0.18, 0.92, ventralness), which
      // at the FLANK - ventralness 0.5, the half of the animal a diver actually
      // sees - is already 0.40 of the way to the ventral colour. A white belly
      // therefore bleaches 40% of the visible side. Measured on screen at 1.9 m
      // in the lagoon: HSV saturation 0.157, the least saturated thing in the
      // frame, against water at 0.825.
      tint: [176, 104, 52], ventral: [148, 132, 102],
      // The datasheet's own "reflective lateral stripe that catches the
      // caustics, so a whole school flashes as one plane". Roughness 0.10 inside
      // the mask against skinSurface's 0.34-0.52 outside it is what makes it a
      // FLASH: the stripe lights up when the school turns through the specular
      // lobe and goes dark again, which is the read the note asks for. Gold, not
      // white - white is what the belly used to be and it renders as nothing.
      pattern: { kind: 'stripe', colour: [212, 172, 74], duty: 0.24, roughness: 0.10 },
      dorsalFin: { span: 0.030, chord: 0.034, at: 0.42, camber: 0.03 },
      analFin: { span: 0.022, chord: 0.026, at: 0.66, camber: 0.02 },
      caudal: { span: 0.030, chord: 0.026, camber: 0.0, fork: 0.4 },
      pectoral: { span: 0.024, chord: 0.016, at: 0.30, camber: 0.04 },
      eyes: { radius: 0.006, at: 0.10, spread: 0.72 },
    },
    note: 'Small deep-bodied coppery fish with a reflective lateral stripe that catches the caustics, ' +
      'so a whole school flashes as one plane when it turns. This is the first non-plankton animal the ' +
      'player meets and the shallow reef is designed around watching a school part around your body. ' +
      'They dive into coral heads when a Vaneskimmer stoops, and inside 200 m their school is CPU-simulated ' +
      'so the player can see individual fish decide.',
  },

  {
    id: 'CRT_SUNPLATE', name: 'Sunplate', latinish: 'Discopterus solaris',
    archetype: ARCHETYPE.REEFFISH, steering: 'ARCH_REEFDART', swimMode: SWIM_MODE.SUB_CARANGIFORM,
    habitat: HABITAT.BENTHIC, biomes: [REEF, CORAL], depthRange: [1, 34],
    length: 0.24, mass: 0.31,
    diet: ['coral polyps', 'algae film'],
    dangerTier: 0,
    aggressionTrigger: 'none; bluff-charges and veers off at 0.5 m if you touch its coral head',
    damage: { player: 0, vessel: 0, effect: null },
    health: 9, speed: 0.7, burstSpeed: 4.1, turnRate: 720,
    schoolSize: [1, 4], densityPerKm3: 1.4e4,
    dayNightActivity: [1.6, 0.05], lightAffinity: 0.20, lightFlipRadius: 0,
    threatTau: 8, electroR: 0,
    bioluminescence: DARK, audioHz: 420,
    meshRecipe: {
      // Back to the original 10 x 10. The loft was briefly retuned to 15 x 8 to
      // give a VERTEX-painted band somewhere to land; the mask is evaluated per
      // FRAGMENT now, so a bar is exact at any ring count and the rings can go
      // back to describing the animal.
      plan: 'disc', spineBones: 6, girth: 0.09, depth: 0.46, rings: 10, segs: 10,
      tint: [228, 186, 58], ventral: [46, 52, 66],
      // The "vertical bands of chrome yellow and blue-black" its own note has
      // always described and its geometry has never had. Chrome yellow measures
      // as the best-separated hue in this water of anything tried: on screen at
      // 3 m it lands at hue 115 against the lagoon's own 205, where cyan lands
      // at 190 and is indistinguishable from the water behind it.
      pattern: { kind: 'bands', count: 4, colour: [22, 26, 44], duty: 0.36 },
      dorsalFin: { span: 0.075, chord: 0.115, at: 0.44, camber: 0.02 },
      analFin: { span: 0.068, chord: 0.100, at: 0.60, camber: 0.02 },
      caudal: { span: 0.048, chord: 0.038, camber: 0.0, fork: 0.0 },
      pectoral: { span: 0.045, chord: 0.030, at: 0.32, camber: 0.05 },
      snout: { length: 0.028, taper: 0.32 },
      eyes: { radius: 0.011, at: 0.13, spread: 0.70 },
    },
    note: 'A near-circular laterally flattened disc fish in vertical bands of chrome yellow and ' +
      'blue-black with a tiny picking mouth. It is the colour anchor of the shallow reef, the thing ' +
      'that makes the first ten minutes look like a holiday. Each pair defends a bommie and bluff-charges ' +
      'the player, stopping dead half a metre from the mask: the first scare in the game, guaranteed ' +
      'harmless, calibrating trust in the audio-tell system. At night it goes grey-brown and hides.',
  },

  // The three below exist because the shallow reef had no colour in it that the
  // player could actually resolve. AUDITED: every species whose depthRange
  // overlapped 0-15 m in REEF or CORAL was a 21 mm plankter, a 0.16 m snail
  // grazing at 0.035 m/s, a buried ray, a solitary octopus, the 0.11 m
  // Coppersprat, the 0.24 m Sunplate, or the Silverquill - whose tint
  // (196, 206, 216) is a saturation of 0.196, i.e. grey, and which was the only
  // schooler the lagoon got. Angular size at the QA canvas's measured 622 px/rad
  // is why the sizes below are what they are: 0.11 m is 6.8 px at 10 m and
  // 3.4 px at 20 m, 0.34 m is 21 px at 10 m, and 0.55 m is 34 px.
  //
  // THE HUES ARE CHOSEN AGAINST THE WATER AND AGAINST THE DISPLAY CHAIN, and
  // the second half of that was got wrong first time round. The photon argument
  // is right as far as it goes - the daylight reaching 6 m of the lagoon is
  // e^(-6*Kd) = (0.16, 0.65, 0.80), so red is down 84% before it ever reaches
  // the fish - and it says to put a fish's energy in green and blue. MEASURED ON
  // SCREEN, that is exactly backwards for CHROMA. The water's own veiling
  // in-scatter already pins the blue channel near the top of the tone curve
  // (lagoon water renders at hue 205, HSV value 0.913), so a fish that is also
  // bright in blue lands at hue 190-200 and reads as a slightly brighter patch
  // of water. Measured at 1.9 m, on-screen HSV saturation: Coppersprat 0.157,
  // Silverquill 0.196-ish, cyan Azuregraze 0.302, against the water behind them
  // at 0.825. The two that read as animals were the two with almost no blue
  // albedo - Sunplate 0.264 at hue 156 and Limebanner 0.276 at hue 139.
  //
  // So: the GROUND colours are yellow, lime, rose-purple and one deliberate
  // azure that survives only because it is BARRED in gold; every pigment is
  // near-black or deep gold; and no belly is white. Measured after, at 3 m: the
  // barred Azuregraze steps 192 -> 143 in hue and 0.96 -> 0.90 in value across
  // every bar, and the rose Violet Wrasse renders at hue 239 where it used to
  // render at 211, which is the water.

  {
    id: 'CRT_AZUREGRAZE', name: 'Azuregraze', latinish: 'Cyanodiscus pascens',
    archetype: ARCHETYPE.REEFFISH, steering: 'ARCH_REEFDART', swimMode: SWIM_MODE.SUB_CARANGIFORM,
    habitat: HABITAT.PELAGIC, biomes: [REEF, CORAL], depthRange: [1, 26],
    length: 0.52, mass: 2.4,
    diet: ['algae film', 'coral polyps', 'zooplankton'],
    dangerTier: 0,
    aggressionTrigger: 'none; turns broadside and holds station rather than fleeing',
    damage: { player: 0, vessel: 0, effect: null },
    health: 26, speed: 0.8, burstSpeed: 4.6, turnRate: 640,
    schoolSize: [6, 20], densityPerKm3: 8.0e3,
    dayNightActivity: [1.5, 0.15], lightAffinity: 0.25, lightFlipRadius: 0,
    threatTau: 9, electroR: 0,
    bioluminescence: DARK, audioHz: 380,
    meshRecipe: {
      plan: 'disc', spineBones: 7, girth: 0.10, depth: 0.48, rings: 14, segs: 9,
      // AZURE GROUND, CHROME-YELLOW BARS - the damselfish scheme, and the only
      // way a blue reef fish reads at all in blue water. A cyan GROUND measured
      // at hue 190 on screen against the lagoon's 205, i.e. the same colour as
      // what is behind it; the bars are what carry the animal, and they are the
      // one hue the column separates. The belly is dark teal, not the pale
      // (168, 214, 226) it was: at the flank the counter-shade is already 40% of
      // the way to it, so a pale belly bleaches the visible side of the fish.
      tint: [22, 124, 150], ventral: [26, 60, 72],
      // DEEP gold, not chrome. A bar has to be a value STEP as well as a hue
      // step or it dissolves into the shoulder of the tone curve with everything
      // else: measured on screen at 3 m, chrome (236, 190, 44) rendered at HSV
      // value 0.952 against an azure ground at 0.950 - no step at all - and its
      // own saturation was 0.13. At (190, 144, 26) the bar steps down 0.05 in
      // value at 3 m and 0.12 at 10 m, and carries saturation 0.29.
      pattern: { kind: 'bands', count: 5, colour: [190, 144, 26], duty: 0.30 },
      dorsalFin: { span: 0.150, chord: 0.230, at: 0.44, camber: 0.02 },
      analFin: { span: 0.135, chord: 0.200, at: 0.60, camber: 0.02 },
      caudal: { span: 0.120, chord: 0.085, camber: 0.0, fork: 0.18 },
      pectoral: { span: 0.100, chord: 0.062, at: 0.32, camber: 0.05 },
      snout: { length: 0.050, taper: 0.34 },
      eyes: { radius: 0.019, at: 0.13, spread: 0.68 },
    },
    note: 'A half-metre deep-azure disc crossed by five broad chrome-yellow bars, broad enough that it ' +
      'turns into a flat sheet of colour every time it banks. It grazes film off the tops of bommies in ' +
      'loose parties of a dozen and treats a diver as scenery, drifting to keep two metres and its own ' +
      'flank presented. It is the animal the shallow reef is photographed for, and the bars are the ' +
      'reason: the azure is the same colour as the water behind it and the yellow is not.',
  },

  {
    id: 'CRT_VIOLETWRASSE', name: 'Violet Wrasse', latinish: 'Labrisoma violaceum',
    archetype: ARCHETYPE.SCHOOLING, steering: 'ARCH_SHOALER', swimMode: SWIM_MODE.SUB_CARANGIFORM,
    habitat: HABITAT.PELAGIC, biomes: [REEF, CORAL, RUBBLE], depthRange: [1, 30],
    length: 0.34, mass: 0.42,
    diet: ['zooplankton', 'Glimmerkrill', 'algae film'],
    dangerTier: 0,
    aggressionTrigger: 'none',
    damage: { player: 0, vessel: 0, effect: null },
    health: 12, speed: 1.2, burstSpeed: 5.6, turnRate: 480,
    schoolSize: [40, 180], densityPerKm3: 6.0e4,
    dayNightActivity: [1.5, 0.15], lightAffinity: 0.40, lightFlipRadius: 0,
    threatTau: 6, electroR: 0,
    bioluminescence: DARK, audioHz: 300,
    meshRecipe: {
      plan: 'compressed', spineBones: 7, girth: 0.13, depth: 0.30, rings: 9, segs: 9,
      // ROYAL PURPLE PULLED TOWARD ROSE, and the belly is deep plum rather than
      // the near-lilac (206, 176, 232) it was. Purple is the one COOL hue that
      // can beat the water, but only if it is bright in RED, which is the
      // channel the column cannot supply and therefore the only one a fish can
      // own outright: at (150, 44, 180) the red is 0.287 linear against 0.434 of
      // blue and the whole animal MEASURED at hue 211 on screen, i.e. the same
      // blue as the water. Weighting it to red at the same value lands it at
      // 250-290.
      //
      // The stripe is duty 0.15, not 0.30. Duty is a share of the CIRCUMFERENCE,
      // and near the flank the trunk's ellipse advances only depth/2 metres per
      // radian - so 0.30 was a 4.7 cm band on a fish 10 cm tall, which is not a
      // line down the flank, it is half the fish.
      tint: [214, 44, 122], ventral: [66, 26, 44],
      pattern: { kind: 'stripe', colour: [214, 166, 36], duty: 0.15 },
      dorsalFin: { span: 0.055, chord: 0.090, at: 0.42, camber: 0.03 },
      analFin: { span: 0.042, chord: 0.070, at: 0.66, camber: 0.02 },
      caudal: { span: 0.078, chord: 0.055, camber: 0.0, fork: 0.30 },
      pectoral: { span: 0.062, chord: 0.038, at: 0.30, camber: 0.05 },
      eyes: { radius: 0.013, at: 0.11, spread: 0.72 },
    },
    note: 'Royal purple shot through with rose, and a single gold line from gill to tail root, shoaling ' +
      'forty to two hundred ' +
      'strong over the coral heads. They feed up into the water column in the middle of the day and ' +
      'pour back down into the reef at dusk, so the lagoon visibly empties in the ten minutes before ' +
      'the light goes. A shoal parting around a swimmer and closing behind them is the single thing ' +
      'the first ten minutes of this game is built to deliver.',
  },

  {
    id: 'CRT_LIMEBANNER', name: 'Limebanner', latinish: 'Vexillopterus citrinus',
    archetype: ARCHETYPE.REEFFISH, steering: 'ARCH_REEFDART', swimMode: SWIM_MODE.SUB_CARANGIFORM,
    habitat: HABITAT.BENTHIC, biomes: [REEF, CORAL, RUBBLE], depthRange: [2, 30],
    length: 0.55, mass: 1.9,
    diet: ['coral polyps', 'tube worms', 'algal turf'],
    dangerTier: 0,
    aggressionTrigger: 'none; raises the dorsal banner and sideslips away',
    damage: { player: 0, vessel: 0, effect: null },
    health: 30, speed: 0.65, burstSpeed: 4.2, turnRate: 700,
    // Sunplate's density, because Sunplate is its peer: both are territorial
    // pair-forming reef fish holding a bommie. At 900/km3 - Bloatspine's number,
    // for a solitary ambusher - MEASURED exactly ONE alive in the whole lagoon,
    // which is what 900/km3 honestly means over 90,000 m3 of visible water.
    schoolSize: [1, 4], densityPerKm3: 1.1e4,
    dayNightActivity: [1.6, 0.10], lightAffinity: 0.15, lightFlipRadius: 0,
    threatTau: 10, electroR: 0,
    bioluminescence: DARK, audioHz: 340,
    meshRecipe: {
      plan: 'compressed', spineBones: 7, girth: 0.11, depth: 0.52, rings: 13, segs: 9,
      tint: [180, 200, 40],
      // Counter-shading INVERTED, deliberately. Every other fish in the roster
      // is pale below to hide its silhouette against the surface; this one is
      // slate below because it is not hiding, and a hard value step down the
      // body is what still reads at 30 m after the hue has gone.
      ventral: [38, 44, 60],
      pattern: { kind: 'eyeMask', colour: [24, 28, 40], duty: 0.30 },
      dorsalFin: { span: 0.230, chord: 0.190, at: 0.38, camber: 0.02 },
      analFin: { span: 0.120, chord: 0.170, at: 0.64, camber: 0.02 },
      caudal: { span: 0.110, chord: 0.080, camber: 0.0, fork: 0.10 },
      pectoral: { span: 0.090, chord: 0.058, at: 0.32, camber: 0.05 },
      snout: { length: 0.070, taper: 0.28 },
      eyes: { radius: 0.020, at: 0.14, spread: 0.66 },
    },
    note: 'Lime-yellow above, slate below, with a black bar through the eye and a second at the tail ' +
      'root and a dorsal fin carried like a standard. Pairs patrol a fixed circuit of three or four ' +
      'coral heads and are back at the same one every game morning, which is the cheapest possible way ' +
      'to make a reef feel like a place with residents rather than a place with fish. It picks at tube ' +
      'worms with a long snout and is the only shallow animal that will follow a diver out of curiosity.',
  },

  {
    id: 'CRT_REEFCROPPER', name: 'Reefcropper', latinish: 'Rasorella reptans',
    archetype: ARCHETYPE.GRAZER, steering: 'ARCH_GRAZER', swimMode: SWIM_MODE.STATIC,
    habitat: HABITAT.BENTHIC, biomes: [REEF, CORAL, RUBBLE, FLAT], depthRange: [0, 70],
    length: 0.16, mass: 0.44,
    diet: ['algal turf', 'biofilm'],
    dangerTier: 0,
    aggressionTrigger: 'none; clamps to the substrate and takes 15% damage when threatened',
    damage: { player: 0, vessel: 0, effect: null },
    health: 18, speed: 0.035, burstSpeed: 0.06, turnRate: 25,
    schoolSize: [1, 25], densityPerKm3: 3.1e4,
    dayNightActivity: [0.6, 1.4], lightAffinity: -0.15, lightFlipRadius: 0,
    threatTau: 12, electroR: 0,
    bioluminescence: DARK, audioHz: 320,
    meshRecipe: {
      // Two bones, the minimum: every vertex of a lathed shell, its foot and its
      // eyestalks binds rigidly to bone 0, so a longer chain was four bones of
      // which three moved nothing.
      plan: 'shell', spineBones: 2, girth: 0.50, depth: 0.42, trunk: 0.55, rings: 9, segs: 12,
      tint: [104, 110, 84],
      shell: { whorls: 2.4, apex: 0.42, ribs: 9 },
      foot: { length: 0.17, width: 0.085, height: 0.026 },
      eyestalks: { count: 2, length: 0.022, radius: 0.0035 },
    },
    note: 'A big-footed gastropod-analog with a low conical shell encrusted in living turf, so it is ' +
      'half-invisible until it moves. It grazes in slow meandering trails that it literally scrapes ' +
      'clean, decrementing the terrain algae detail into pale wandering tracks that regrow at one ' +
      'percent per game-minute. That is the cheapest possible way to prove the world remembers what its ' +
      'animals do, and players notice it.',
  },

  {
    id: 'CRT_NINEARM', name: 'Ninearm Mimic', latinish: 'Enneabrachium versicolor',
    archetype: ARCHETYPE.CEPHALOPOD, steering: 'ARCH_CEPHALOPOD', swimMode: SWIM_MODE.JET,
    habitat: HABITAT.CREVICE, biomes: [REEF, CORAL, RUBBLE, FLAT], depthRange: [2, 140],
    length: 0.55, mass: 2.1,
    diet: ['Glassclaw juveniles', 'Reefcropper', 'Tideclaw'],
    dangerTier: 0,
    aggressionTrigger: 'none, ever; it flees and inks',
    damage: { player: 0, vessel: 0, effect: 'ink cloud blocks vision, including creature vision' },
    health: 26, speed: 0.4, burstSpeed: 5.8, turnRate: 540,
    schoolSize: [1, 1], densityPerKm3: 620,
    dayNightActivity: [0.5, 1.5], lightAffinity: -0.60, lightFlipRadius: 0,
    threatTau: 20, electroR: 0,
    bioluminescence: DARK, audioHz: 90,
    meshRecipe: {
      plan: 'squid', spineBones: 6, girth: 0.16, depth: 0.17,
      tint: [150, 104, 86],
      // A FALSE EYE on each side of the mantle, which is what the real
      // two-spot octopus carries and what a predator-deflection mark is for on
      // an animal whose entire strategy is "flees and inks". The pale ring comes
      // from the mask's negative half, so it is a lifted version of whatever the
      // skin is currently matching rather than a painted white ring.
      pattern: { kind: 'eyespot', colour: [26, 20, 24], strength: 0.82 },
      mantle: { length: 0.19 },
      arms: { count: 9, length: 0.36, radius: 0.016, taper: 0.14, curl: 0.55 },
      fins: { span: 0.055, chord: 0.070, camber: 0.05 },
      eyes: { radius: 0.024, at: 0.88, spread: 0.85 },
    },
    note: 'Nine arms, not eight - one is a stubby hectocotylus it keeps curled. Its skin samples the ' +
      'average albedo and roughness of the terrain within 0.8 m and lerps to match over 0.9 s, with a ' +
      'papillae displacement term that raises real bumps when it settles on rubble. Approach slowly and ' +
      'it holds, watching with a horizontal-slit pupil that counter-rotates to stay level. Approach fast ' +
      'and it jets, inks a real 6 s vision-blocking volume, and is gone into a crevice you had not seen.',
  },

  {
    id: 'CRT_SANDVEIL', name: 'Sandveil Ray', latinish: 'Psammobatis velata',
    archetype: ARCHETYPE.RAY, steering: 'ARCH_GLIDER', swimMode: SWIM_MODE.RAJIFORM,
    habitat: HABITAT.BENTHIC, biomes: [FLAT, REEF, CORAL], depthRange: [1, 95],
    length: 1.30, mass: 22,
    diet: ['buried molluscs', 'worms', 'Glassclaw larvae'],
    dangerTier: 0,
    aggressionTrigger: 'none; reacts only if the player lands on it',
    damage: { player: 0, vessel: 0, effect: 'tail spine if stood on: 4 HP + 12 s venom DoT at 0.4 HP/s' },
    health: 70, speed: 1.1, burstSpeed: 5.4, turnRate: 150,
    schoolSize: [1, 9], densityPerKm3: 45,
    dayNightActivity: [0.8, 1.2], lightAffinity: -0.25, lightFlipRadius: 0,
    threatTau: 14, electroR: 3.5,
    bioluminescence: DARK, audioHz: 180,
    meshRecipe: {
      plan: 'ray', spineBones: 6, girth: 0.50, depth: 0.045, rings: 13, segs: 16,
      tint: [194, 178, 146], ventral: [228, 224, 214],
      // "Invisible but for a faint diamond outline" is a CAMOUFLAGE claim, and a
      // flat sand-coloured disc does not make it - a uniform tint on a mottled
      // seabed is the one thing that stands out. The speckle is the disruptive
      // half: 9 dots per body length in a slightly darker sand, which is what
      // breaks the outline the note says is barely there.
      pattern: { kind: 'spots', count: 9, colour: [148, 132, 104], duty: 0.55, strength: 0.7 },
      discExponent: 0.62,
      tail: { length: 0.75, taper: 0.10, barbs: 1 },
      eyes: { radius: 0.028, at: 0.22, spread: 0.42, dorsal: true },
    },
    note: 'A broad soft-edged disc the exact colour of the Pale Flats, with two spiracles that flutter ' +
      'while it lies buried under a few centimetres of sand, invisible but for a faint diamond outline ' +
      'and two eyes. Swim over the flats and one erupts in a silt bloom and undulates away in a slow ' +
      'rajiform wave - a heart-stop moment that is always harmless, and is doing real work: teaching the ' +
      'player that the seabed can contain things, so a Frondmaw later lands correctly.',
  },

  {
    id: 'CRT_SPINECROWN', name: 'Spinecrown Urchin', latinish: 'Coronaspina rigida',
    archetype: ARCHETYPE.GRAZER, steering: 'ARCH_GRAZER', swimMode: SWIM_MODE.STATIC,
    habitat: HABITAT.BENTHIC, biomes: [REEF, CORAL, RUBBLE, KELP], depthRange: [1, 180],
    length: 0.28, mass: 1.1,
    diet: ['algal turf', 'kelp holdfasts'],
    dangerTier: 1,
    aggressionTrigger: 'contact only; spines within 40 degrees of an approach rotate to aim over 1.2 s',
    damage: { player: 6, vessel: 1, effect: '8 s DoT of 0.5 HP/s' },
    health: 22, speed: 0.004, burstSpeed: 0.004, turnRate: 0,
    schoolSize: [12, 200], densityPerKm3: 8.0e4,
    dayNightActivity: [0.8, 1.2], lightAffinity: -0.20, lightFlipRadius: 0,
    threatTau: 30, electroR: 0,
    bioluminescence: {
      colour: [0.85, 0.20, 0.35], intensity: 0.25,
      pattern: BIOLUM_PATTERN.SPINE_TIPS, isLure: false, hz: 0,
    },
    audioHz: 2600,
    meshRecipe: {
      // No `trunk`: a `test` recipe's height IS 2 * girth * oblate, and
      // creature_mesh derives it from those rather than taking a second, silently
      // redundant number that has to be kept equal to `oblate` by hand.
      plan: 'shell', spineBones: 2, girth: 0.50, depth: 0.32, rings: 8, segs: 12,
      tint: [74, 52, 96],
      test: { oblate: 0.62 },
      spines: { count: 26, length: 0.14, radius: 0.006 },
    },
    note: 'The only tier-1 hazard permitted inside the Safe Charter annulus, because it is entirely ' +
      'avoidable and entirely static. Deep-purple test, slender spines with faint red luminous tips ' +
      'just visible at 60 m, and a slow creepy tracking motion as the spines rotate to point at an ' +
      'approaching object. In the kelp it forms barrens - circular clearings up to 20 m across where it ' +
      'has eaten every holdfast, a real ecological story told with geometry alone.',
  },

  {
    id: 'CRT_BLOATSPINE', name: 'Bloatspine', latinish: 'Inflatodon horridus',
    archetype: ARCHETYPE.REEFFISH, steering: 'ARCH_REEFDART', swimMode: SWIM_MODE.OSTRACIIFORM,
    habitat: HABITAT.BENTHIC, biomes: [REEF, CORAL, KELP], depthRange: [2, 80],
    length: 0.31, mass: 1.8,
    diet: ['Reefcropper', 'Glassclaw juveniles', 'urchins'],
    dangerTier: 1,
    aggressionTrigger: 'never attacks; inflates when a threat holds inside 2.5 m for over 0.8 s',
    damage: { player: 5, vessel: 0, effect: 'contact only, and only while inflated' },
    health: 30, speed: 0.5, burstSpeed: 2.2, turnRate: 380,
    schoolSize: [1, 1], densityPerKm3: 900,
    dayNightActivity: [1.2, 0.6], lightAffinity: 0.10, lightFlipRadius: 0,
    threatTau: 15, electroR: 0,
    bioluminescence: DARK, audioHz: 140,
    meshRecipe: {
      plan: 'compressed', spineBones: 5, girth: 0.30, depth: 0.36, rings: 9, segs: 9,
      tint: [158, 132, 92], ventral: [214, 200, 168],
      // "Brindled" is a pattern, not a tint: four dark dorsal saddles.
      pattern: { kind: 'saddles', count: 4, colour: [88, 66, 38], duty: 0.38 },
      inflate: { maxScale: 1.42, bellyBias: 0.70, at: 0.42, spread: 0.34 },
      spines: { count: 20, length: 0.040, radius: 0.005 },
      beak: { length: 0.030, hook: 0.15 },
      caudal: { span: 0.045, chord: 0.040, camber: 0.0, fork: 0.0 },
      pectoral: { span: 0.035, chord: 0.026, at: 0.34, camber: 0.05 },
      eyes: { radius: 0.020, at: 0.15, spread: 0.80 },
    },
    note: 'A grumpy beak-mouthed brindled fish with permanently protruding eyes that swivel ' +
      'independently. Its whole design exists to be pushed around: nudge it and it inflates into a ' +
      'spiny ball over 0.7 s, goes neutrally buoyant, drifts, then deflates with an audible sigh. ' +
      'Grabbing an inflated one and using it as a bumper is an intended, undocumented toy, and its ' +
      'spines cost 5 HP so there is a real, gentle price for messing with the wildlife.',
  },

  // =========================================================================
  // MEADOW, KELP AND SHELFBREAK  (DESIGN/06 06.4.4)
  // =========================================================================

  {
    id: 'CRT_RIBBONWETHER', name: 'Ribbonwether', latinish: 'Herbivagus placidus',
    archetype: ARCHETYPE.GRAZER, steering: 'ARCH_GRAZER', swimMode: SWIM_MODE.CARANGIFORM,
    habitat: HABITAT.BENTHIC, biomes: [FLAT, KELP], depthRange: [18, 105],
    length: 2.40, mass: 210,
    diet: ['ribbon grass', 'kelp blades'],
    dangerTier: 0,
    aggressionTrigger: 'never',
    damage: { player: 0, vessel: 0, effect: 'a fleeing adult can body-check for 3 HP' },
    health: 340, speed: 0.7, burstSpeed: 3.1, turnRate: 70,
    schoolSize: [3, 11], densityPerKm3: 14,
    dayNightActivity: [1.2, 0.7], lightAffinity: 0.05, lightFlipRadius: 0,
    threatTau: 10, electroR: 0,
    bioluminescence: DARK, audioHz: 62,
    meshRecipe: {
      plan: 'fusiform', spineBones: 8, girth: 0.17, depth: 0.19, rings: 12, segs: 12,
      tint: [122, 112, 100], ventral: [176, 168, 156],
      fluke: { span: 0.55, chord: 0.30, camber: 0.06, horizontal: true, fork: 0.25 },
      pectoral: { span: 0.34, chord: 0.20, at: 0.28, camber: 0.12 },
      jaw: { gape: 0.28, length: 0.20, teeth: 0 },
      eyes: { radius: 0.035, at: 0.09, spread: 0.62 },
    },
    note: 'A placid sausage-shaped seal-sized grazer with a broad rasping mouth-pad, tiny useless-looking ' +
      'eyes and two paddle limbs. Pods hang nose-down in the grass, chewing, exhaling fine bubble strings, ' +
      'with calves leashed inside three metres of an adult. It is the game\'s proof that big does not mean ' +
      'dangerous - 210 kg that lets you swim up and touch it - and its low contact rumble carries 300 m ' +
      'and is the friendliest sound in the ocean, which the deep will exploit later.',
  },

  {
    id: 'CRT_SILVERQUILL', name: 'Silverquill', latinish: 'Argentopennis migrans',
    archetype: ARCHETYPE.SCHOOLING, steering: 'ARCH_SHOALER', swimMode: SWIM_MODE.CARANGIFORM,
    // PLATTER added 2026-08-18 with biome 17: the reference's small pale
    // schooling fish weaving between the platters.
    habitat: HABITAT.PELAGIC, biomes: [PELAGIC, STEPDOWN, REEF, FLAT, PLATTER], depthRange: [4, 240],
    length: 0.29, mass: 0.34,
    diet: ['Glimmerkrill', 'Veilmote', 'small fry'],
    dangerTier: 0,
    aggressionTrigger: 'none',
    damage: { player: 0, vessel: 0, effect: null },
    health: 11, speed: 1.6, burstSpeed: 7.8, turnRate: 300,
    schoolSize: [300, 2400], densityPerKm3: 3.2e4,
    dayNightActivity: [1.1, 0.9], lightAffinity: 0.45, lightFlipRadius: 0,
    threatTau: 6, electroR: 0,
    bioluminescence: {
      colour: [0.55, 0.72, 0.90], intensity: 0.35,
      pattern: BIOLUM_PATTERN.COUNTER_ILLUM, isLure: false, hz: 0,
    },
    audioHz: 320,
    meshRecipe: {
      plan: 'fusiform', spineBones: 7, girth: 0.11, depth: 0.22, rings: 9, segs: 8,
      tint: [196, 206, 216], ventral: [228, 234, 240],
      dorsalFin: { span: 0.038, chord: 0.045, at: 0.44, camber: 0.03 },
      analFin: { span: 0.028, chord: 0.032, at: 0.68, camber: 0.02 },
      caudal: { span: 0.085, chord: 0.055, camber: 0.0, fork: 0.62 },
      pectoral: { span: 0.055, chord: 0.028, at: 0.30, camber: 0.04 },
      eyes: { radius: 0.014, at: 0.10, spread: 0.74 },
    },
    note: 'The workhorse spectacle species: mirror-flanked, fork-tailed, 2,400 at a time as a single GPU ' +
      'shoal that forms sheets, tornadoes and bait-balls. Their flanks use a true mirror BRDF with a ' +
      'thin-film tint, so a shoal turning through a light shaft sends a visible flash-front across it. ' +
      'Below 60 m their ventral counter-illumination matches the downwelling light and the player can ' +
      'watch a whole shoal vanish by descending below it. A bait-ball forming at 80 m is the game\'s ' +
      'standard "something big is coming" tell.',
  },

  {
    id: 'CRT_BELLFLOWER', name: 'Bellflower Jelly', latinish: 'Campanula pelagica',
    archetype: ARCHETYPE.JELLY, steering: 'ARCH_DRIFTER', swimMode: SWIM_MODE.JET,
    habitat: HABITAT.PELAGIC, biomes: [PELAGIC], depthRange: [3, 220],
    length: 0.45, mass: 6.5,
    diet: ['Glimmerkrill', 'fry'],
    dangerTier: 1,
    aggressionTrigger: 'contact only',
    damage: { player: 3, vessel: 0, effect: '10 s DoT of 0.3 HP/s and 25% control jitter; windshield haze 12 s' },
    health: 12, speed: 0.22, burstSpeed: 0.40, turnRate: 30,
    schoolSize: [30, 400], densityPerKm3: 2200,
    dayNightActivity: [1.0, 1.0], lightAffinity: 0.15, lightFlipRadius: 0,
    threatTau: 2, electroR: 0,
    bioluminescence: {
      colour: [0.95, 0.45, 0.75], intensity: 0.9,
      pattern: BIOLUM_PATTERN.BELL_RIM, isLure: false, hz: 0.8,
    },
    audioHz: 38,
    meshRecipe: {
      plan: 'bell', spineBones: 5, girth: 0.50, depth: 0.42, rings: 9, segs: 14,
      tint: [232, 196, 208],
      bell: { radius: 0.225, height: 0.20, ribs: 8 },
      tentacles: { count: 14, length: 2.6, radius: 0.004, taper: 0.35 },
    },
    note: 'Translucent pink-white bells with eight ribbed canals and a curtain of fine tentacles, ' +
      'pulsing on a 0.55 Hz jet cycle that actually drives their motion. The world director blooms them: ' +
      'for six game-days a slab of water column becomes an aching drifting cathedral of thousands, and ' +
      'the vessel must be threaded through without touching a trail. Their radial light chase is subtle ' +
      'in daylight and mesmerising at 180 m.',
  },

  {
    id: 'CRT_GLASSCLAW', name: 'Glassclaw', latinish: 'Vitrocheles fragilis',
    archetype: ARCHETYPE.CRUSTACEAN, steering: 'ARCH_CRUSTACEAN', swimMode: SWIM_MODE.WALK,
    habitat: HABITAT.BENTHIC, biomes: [RUBBLE, STEPDOWN, KELP], depthRange: [40, 400],
    length: 0.75, mass: 8.2,
    diet: ['carrion', 'molluscs', 'Sepulcher Louse'],
    dangerTier: 1,
    aggressionTrigger: 'player inside 1.5 m for over 1.0 s, or damage taken',
    damage: { player: 9, vessel: 6, effect: 'always raises both claws and stridulates for 0.55 s first' },
    health: 90, speed: 0.45, burstSpeed: 2.6, turnRate: 200,
    schoolSize: [1, 1], densityPerKm3: 320,
    dayNightActivity: [0.4, 1.6], lightAffinity: -0.35, lightFlipRadius: 0,
    threatTau: 18, electroR: 0,
    bioluminescence: {
      colour: [0.30, 0.95, 0.60], intensity: 0.18,
      pattern: BIOLUM_PATTERN.JOINTS, isLure: false, hz: 0,
    },
    audioHz: 140,
    meshRecipe: {
      plan: 'crustacean', spineBones: 6, girth: 0.30, depth: 0.26,
      tint: [168, 164, 150],
      legs: { count: 8, length: 0.34, radius: 0.017, splay: 0.85 },
      claws: { count: 2, length: 0.40, asymmetry: 0.85 },
      antennae: 2, eyestalks: { count: 2, length: 0.055, radius: 0.008 },
      plates: 6, carapaceLift: 0.45, uropods: 2,
    },
    note: 'A translucent-shelled lobster-analog whose carapace is genuinely see-through at the shoulders, ' +
      'showing a faint green glow at the joints and a dark gut line. It is the primary mid-depth material ' +
      'source, so the player fights a lot of them, and it is designed to be fair: both claws up and a ' +
      '0.55 s stridulation before every strike. Its tail-flip escape is a real 220 N.s impulse into a ' +
      'cloud of silt, and once every forty game-days a migration column of hundreds walks the shelfbreak ' +
      'in single file, glowing faintly.',
  },

  {
    id: 'CRT_HAGLINE', name: 'Hagline', latinish: 'Myxanguilla profunda',
    archetype: ARCHETYPE.SCAVENGER, steering: 'ARCH_SCAVENGER', swimMode: SWIM_MODE.ANGUILLIFORM,
    habitat: HABITAT.BENTHIC, biomes: [FLAT, ASHPLAIN, STEPDOWN, CANYON, SPONGE], depthRange: [60, 1400],
    length: 0.95, mass: 3.1,
    diet: ['carrion (obligate)', 'burrowing worms'],
    dangerTier: 1,
    aggressionTrigger: 'only defends; slime burst when damaged',
    damage: { player: 4, vessel: 0, effect: 'slime cloud: 3.5 m sphere, 8 s, player drag x2.4, vessel intake purge' },
    health: 40, speed: 0.8, burstSpeed: 3.0, turnRate: 260,
    schoolSize: [1, 60], densityPerKm3: 1100,
    dayNightActivity: [0.9, 1.1], lightAffinity: -0.20, lightFlipRadius: 0,
    threatTau: 25, electroR: 0,
    bioluminescence: DARK, audioHz: 200,
    meshRecipe: {
      plan: 'eel', spineBones: 12, girth: 0.045, depth: 0.055, rings: 16, segs: 8,
      tint: [144, 124, 120],
      oralDisc: { radius: 0.030, rasps: 2 },
      barbels: 8,
      dorsalFin: { span: 0.016, chord: 0.60, at: 0.55, camber: 0.0, sweep: 0.05 },
    },
    note: 'Eyeless, jawless, rope-bodied scavengers with a rasping oral disc and four pairs of barbels. ' +
      'They are the ocean\'s cleanup crew and the primary consumer of the scent field: drop a kill below ' +
      '60 m and within a few minutes they arrive from up to 400 m away in visible weaving nose-down search ' +
      'patterns. Thirty of them writhing inside a Ribbonwether carcass is the most viscerally unpleasant ' +
      'sight in the shallow game and it is completely harmless, which is exactly the point.',
  },

  {
    id: 'CRT_FRONDMAW', name: 'Frondmaw', latinish: 'Phycolatens insidiosus',
    archetype: ARCHETYPE.AMBUSH, steering: 'ARCH_AMBUSHER', swimMode: SWIM_MODE.SUB_CARANGIFORM,
    habitat: HABITAT.CANOPY, biomes: [KELP], depthRange: [30, 190],
    length: 1.85, mass: 54,
    diet: ['Coppersprat', 'Silverquill', 'Sunplate', 'Bloatspine'],
    dangerTier: 2,
    aggressionTrigger: 'any target 0.2-2.5 m long passing within 4.5 m of its ambush point below 3 m/s',
    damage: { player: 18, vessel: 14, effect: 'strikes once, never pursues past 12 m' },
    health: 210, speed: 0.25, burstSpeed: 9.4, turnRate: 90,
    schoolSize: [1, 1], densityPerKm3: 26,
    dayNightActivity: [1.0, 1.0], lightAffinity: -0.15, lightFlipRadius: 0,
    threatTau: 45, electroR: 0,
    bioluminescence: {
      colour: [0.15, 0.90, 0.45], intensity: 1.1,
      pattern: BIOLUM_PATTERN.SPOTS, isLure: false, hz: 0,
    },
    audioHz: 70,
    meshRecipe: {
      plan: 'compressed', spineBones: 9, girth: 0.075, depth: 0.25, rings: 12, segs: 10,
      tint: [108, 102, 58], ventral: [148, 140, 96], biolumCount: 3,
      flaps: { count: 10, length: 0.30, chord: 0.10 },
      jaw: { gape: 0.95, length: 0.34, teeth: 14 },
      dorsalFin: { span: 0.10, chord: 0.55, at: 0.50, camber: 0.02 },
      caudal: { span: 0.26, chord: 0.18, camber: 0.0, fork: 0.2 },
      pectoral: { span: 0.16, chord: 0.10, at: 0.30, camber: 0.05 },
      eyes: { radius: 0.030, at: 0.10, spread: 0.72 },
    },
    note: 'A laterally flattened olive-and-amber ambush predator with tattered dermal flaps along its ' +
      'edges shaped and coloured like kelp blades. It hangs vertically head-down inside a stipe cluster ' +
      'with its fins swaying in phase with the kelp\'s own wind field, so it is genuinely invisible until ' +
      'it moves. Tier 2, not 3: it strikes once, hard, and does not follow - a punishment for inattentive ' +
      'swimming, not a hunter. Three dorsal photophores flare green during windup, a purely visual tell ' +
      'for deaf play.',
  },

  {
    id: 'CRT_VOLTBARB', name: 'Voltbarb', latinish: 'Electrobatis pulsans',
    archetype: ARCHETYPE.RAY, steering: 'ARCH_GLIDER', swimMode: SWIM_MODE.RAJIFORM,
    habitat: HABITAT.BENTHIC, biomes: [FLAT, STEPDOWN, SPONGE], depthRange: [55, 460],
    length: 1.60, mass: 48,
    diet: ['Hagline', 'Glassclaw', 'small shoalers'],
    dangerTier: 2,
    aggressionTrigger: 'electroreception contact with a powered vessel inside 14 m, or damage taken',
    damage: { player: 12, vessel: 0, effect: 'EMP: player HUD scramble 4 s; vessel thrust dead 2.2 s, lamps dead 5 s' },
    health: 180, speed: 0.9, burstSpeed: 4.2, turnRate: 130,
    schoolSize: [1, 3], densityPerKm3: 38,
    dayNightActivity: [0.6, 1.4], lightAffinity: -0.30, lightFlipRadius: 0,
    threatTau: 30, electroR: 18,
    bioluminescence: {
      colour: [0.55, 0.75, 1.00], intensity: 8.0,
      pattern: BIOLUM_PATTERN.DISCHARGE_ARCS, isLure: false, hz: 0,
    },
    audioHz: 900,
    meshRecipe: {
      plan: 'ray', spineBones: 6, girth: 0.52, depth: 0.070, rings: 13, segs: 18,
      tint: [92, 96, 102], ventral: [196, 196, 190],
      discExponent: 0.78,
      tail: { length: 0.85, taper: 0.14, barbs: 0 },
      organs: { count: 2, radius: 0.22, at: 0.34 },
      eyes: { radius: 0.026, at: 0.20, spread: 0.36, dorsal: true },
    },
    note: 'A slate-grey ray with two paired electric organs visible as pale kidney patches, a whip tail, ' +
      'and a face of small perpetual malice. It is the mid-game\'s most memorable non-lethal threat because ' +
      'it attacks systems, not health: an EMP at 300 m with the lights out for five seconds costs nothing ' +
      'but composure. It hunts by electroreception, so it is the first creature that finds the player ' +
      'through silt, ink and total darkness - and it ignores a powered-down vessel entirely, which is how ' +
      'the shutdown mechanic teaches itself.',
  },

  {
    id: 'CRT_CHISELFIN', name: 'Chiselfin', latinish: 'Serracaudus gregarius',
    archetype: ARCHETYPE.PACK, steering: 'ARCH_PACK', swimMode: SWIM_MODE.CARANGIFORM,
    habitat: HABITAT.PELAGIC, biomes: [STEPDOWN, PELAGIC, WALL], depthRange: [110, 500],
    length: 1.40, mass: 31,
    diet: ['Silverquill', 'Wisplight', 'Ribbonwether calves', 'anything wounded'],
    dangerTier: 3,
    aggressionTrigger: 'blood scent above 0.12; OR a lone target under 2.5 m within 45 m; OR any hull below 70%',
    damage: { player: 14, vessel: 9, effect: 'one pack member may lunge at a time (pack token)' },
    health: 130, speed: 2.4, burstSpeed: 11.5, turnRate: 340,
    schoolSize: [4, 9], densityPerKm3: 30,
    dayNightActivity: [1.3, 0.8], lightAffinity: 0.30, lightFlipRadius: 0,
    threatTau: 60, electroR: 0,
    bioluminescence: DARK, audioHz: 300,
    meshRecipe: {
      plan: 'fusiform', spineBones: 8, girth: 0.13, depth: 0.20, rings: 12, segs: 12,
      tint: [104, 112, 120], ventral: [208, 214, 218],
      hump: { at: 0.26, gain: 1.22 },
      dorsalFin: { span: 0.24, chord: 0.20, at: 0.40, camber: 0.05, sweep: 0.85 },
      analFin: { span: 0.10, chord: 0.10, at: 0.72, camber: 0.03 },
      caudal: { span: 0.42, chord: 0.24, camber: 0.0, fork: 0.55 },
      pectoral: { span: 0.30, chord: 0.13, at: 0.28, camber: 0.05, sweep: 0.80 },
      jaw: { gape: 0.55, length: 0.20, teeth: 12 },
      eyes: { radius: 0.032, at: 0.10, spread: 0.72 },
    },
    note: 'Lean high-shouldered chrome-and-charcoal pack hunters with a serrated caudal keel and ' +
      'triangular shearing teeth. The game\'s first true predator of the player and the first with real ' +
      'tactics: one HARRIER holds your attention in front, two FLANKERS take stations at plus or minus ' +
      '110 degrees, the rest hold in reserve, and only one may be committed at a time. Their ' +
      'retro-reflective flank stripes mean that at 350 m the first thing you see is six pairs of green ' +
      'sparks orbiting the edge of your lamp cone.',
  },

  {
    id: 'CRT_VEILMOUTH', name: 'Veilmouth', latinish: 'Cetobranchus placidus',
    archetype: ARCHETYPE.FILTER_GIANT, steering: 'ARCH_FILTER_GIANT', swimMode: SWIM_MODE.CARANGIFORM,
    habitat: HABITAT.PELAGIC, biomes: [PELAGIC, WALL, STEPDOWN], depthRange: [90, 700],
    length: 18.0, mass: 21000,
    diet: ['Glimmerkrill', 'Veilmote (filter)'],
    dangerTier: 1,
    aggressionTrigger: 'none, ever. It cannot be aggroed; damaging it makes it leave.',
    damage: { player: 30, vessel: 55, effect: 'collision only, from sheer mass' },
    health: 4800, speed: 1.1, burstSpeed: 3.4, turnRate: 14,
    schoolSize: [1, 4], densityPerKm3: 0.4,
    dayNightActivity: [1.0, 1.0], lightAffinity: 0.10, lightFlipRadius: 0,
    threatTau: 20, electroR: 0,
    bioluminescence: {
      colour: [0.60, 0.80, 1.00], intensity: 0.55,
      pattern: BIOLUM_PATTERN.PIT_LIGHTS, isLure: false, hz: 0.15,
    },
    audioHz: 62,
    meshRecipe: {
      plan: 'whale', spineBones: 14, girth: 0.115, depth: 0.145, rings: 20, segs: 16,
      tint: [62, 74, 88], ventral: [136, 146, 152], biolumCount: 14,
      jaw: { gape: 0.75, length: 3.2, teeth: 0, baleen: 18 },
      fluke: { span: 4.6, chord: 2.2, camber: 0.05, fork: 0.45 },
      pectoral: { span: 2.6, chord: 1.1, at: 0.24, camber: 0.09 },
      eyes: { radius: 0.10, at: 0.11, spread: 0.86 },
    },
    note: 'Eighteen metres of slow, gentle, cathedral-sized animal: a vast pleated gape held open through ' +
      'the krill layers, gill-rakers of translucent baleen-analog, tiny eyes, dark blue-grey skin scored ' +
      'with pale scars. Its three flank photophore lines read as a slow-moving constellation from 200 m in ' +
      'the dark. It is the most important dread instrument in the game, because its 62 Hz moan sits ' +
      'deliberately near the Hollowjaw\'s 41 Hz - the player learns to relax at one and panic at the other.',
  },

  // =========================================================================
  // THE DEEP  (DESIGN/06 06.4.5)
  // =========================================================================

  {
    id: 'CRT_WISPLIGHT', name: 'Wisplight', latinish: 'Lampanychthys minor',
    archetype: ARCHETYPE.SCHOOLING, steering: 'ARCH_SHOALER', swimMode: SWIM_MODE.SUB_CARANGIFORM,
    habitat: HABITAT.PELAGIC, biomes: [PELAGIC, SPONGE, WALL, CANYON], depthRange: [90, 1150],
    length: 0.13, mass: 0.028,
    diet: ['Glimmerkrill', 'copepod-analogs'],
    dangerTier: 0,
    aggressionTrigger: 'none',
    damage: { player: 0, vessel: 0, effect: null },
    health: 2, speed: 0.7, burstSpeed: 4.0, turnRate: 480,
    schoolSize: [120, 900], densityPerKm3: 6.5e4,
    dayNightActivity: [0.6, 1.6], lightAffinity: -0.70, lightFlipRadius: 0,
    threatTau: 5, electroR: 0,
    bioluminescence: {
      colour: [0.30, 0.70, 1.00], intensity: 1.6,
      pattern: BIOLUM_PATTERN.VENTRAL_ROWS, isLure: false, hz: 0,
    },
    audioHz: 1800,
    meshRecipe: {
      plan: 'fusiform', spineBones: 5, girth: 0.13, depth: 0.19, rings: 8, segs: 7,
      tint: [42, 52, 72], ventral: [64, 74, 96], biolumCount: 11,
      caudal: { span: 0.045, chord: 0.028, camber: 0.0, fork: 0.5 },
      dorsalFin: { span: 0.016, chord: 0.020, at: 0.48, camber: 0.02 },
      eyes: { radius: 0.013, at: 0.11, spread: 0.78 },
    },
    note: 'Tiny lanternfish-analogs with huge eyes and rows of blue photophores. They are the deep ocean\'s ' +
      'only ambient light and what makes the mesopelagic navigable without lamps: nine hundred of them ' +
      'through a canyon reads as a slow river of blue sparks. Their light-phobia is a core mechanic - a ' +
      'spotlight evacuates a 30 m sphere instantly and leaves a darkness emptier than before you switched ' +
      'it on. Their blackout-then-flare panic response means something else just moved through them.',
  },

  {
    id: 'CRT_CHAINLIGHT', name: 'Chainlight Siphonophore', latinish: 'Catenaphora luminis',
    archetype: ARCHETYPE.JELLY, steering: 'ARCH_DRIFTER', swimMode: SWIM_MODE.JET,
    habitat: HABITAT.PELAGIC, biomes: [PELAGIC, WALL, CANYON], depthRange: [300, 1300],
    length: 26.0, mass: 40,
    diet: ['Wisplight', 'Glimmerkrill', 'small fish'],
    dangerTier: 2,
    aggressionTrigger: 'contact only; but it fishes, hanging a 20 m curtain across the water column',
    damage: { player: 7, vessel: 0, effect: 'DoT 0.8 HP/s for 14 s, stacks to 4; sonar and scanner offline 8 s' },
    health: 60, speed: 0.15, burstSpeed: 0.45, turnRate: 20,
    schoolSize: [1, 12], densityPerKm3: 34,
    dayNightActivity: [1.0, 1.0], lightAffinity: 0.05, lightFlipRadius: 0,
    threatTau: 3, electroR: 0,
    bioluminescence: {
      colour: [0.20, 0.95, 0.85], intensity: 1.8,
      pattern: BIOLUM_PATTERN.CHAIN_PULSE, isLure: false, hz: 0.4,
    },
    audioHz: 3100,
    meshRecipe: {
      plan: 'bell', spineBones: 12, girth: 0.017, depth: 0.017, rings: 12, segs: 10,
      tint: [136, 196, 190], biolumCount: 8,
      nectophores: { count: 7, radius: 0.45, spacing: 0.42 },
      stem: { length: 22.0, radius: 0.035 },
      tentacles: { count: 12, length: 6.0, radius: 0.006, taper: 0.5 },
    },
    note: 'A 26-metre colonial animal hanging vertically in the dark like a strand of fairy lights dropped ' +
      'down a well: a stack of pulsing swimming bells above a long stem of feeding polyps and a curtain of ' +
      'near-invisible fishing tentacles. It is the deep\'s most beautiful object and one of its worst places ' +
      'to be careless, because the curtain is a real collider chain and each contact stacks a sting that ' +
      'also blurs the HUD. Cutting one in half does not kill it. It makes two, and both flare white.',
  },

  {
    id: 'CRT_GHOSTBELL', name: 'Ghostbell', latinish: 'Nubecampana pallida',
    archetype: ARCHETYPE.JELLY, steering: 'ARCH_DRIFTER', swimMode: SWIM_MODE.JET,
    habitat: HABITAT.PELAGIC, biomes: [PELAGIC, TRENCH, CANYON, TRENCHWALL], depthRange: [520, 1600],
    length: 1.90, mass: 120,
    diet: ['marine snow', 'dead Wisplight', 'Sepulcher larvae'],
    dangerTier: 1,
    aggressionTrigger: 'none',
    damage: { player: 2, vessel: 0, effect: 'a very weak contact sting' },
    health: 55, speed: 0.11, burstSpeed: 0.30, turnRate: 12,
    schoolSize: [1, 1], densityPerKm3: 12,
    dayNightActivity: [1.0, 1.0], lightAffinity: 0.0, lightFlipRadius: 0,
    threatTau: 2, electroR: 0,
    bioluminescence: DARK, audioHz: 0,
    meshRecipe: {
      plan: 'bell', spineBones: 6, girth: 0.50, depth: 0.34, rings: 11, segs: 16,
      tint: [84, 40, 48],
      bell: { radius: 0.95, height: 0.78, ribs: 6, thick: true },
      oralArms: { count: 4, length: 4.1, radius: 0.075, taper: 0.4 },
    },
    note: 'A two-metre blood-red bell with four thick ragged oral arms trailing six metres below, drifting ' +
      'alone at a tenth of a metre per second. It has no lights, and its pigment is so absorbent that in a ' +
      'lamp beam it appears as a hole cut out of the water. It is completely harmless and it is on the ' +
      'roster purely as a dread instrument: at 900 m a large silent black slowly rotating shape entering ' +
      'the edge of your light is the exact ambiguity the game is built on, and it being always harmless is ' +
      'what keeps the next silhouette terrifying rather than exhausting.',
  },

  {
    id: 'CRT_STARWEAVER', name: 'Starweaver', latinish: 'Radiofila textrix',
    archetype: ARCHETYPE.JELLY, steering: 'ARCH_DRIFTER', swimMode: SWIM_MODE.JET,
    // The Platter Forest's own big drifter (its art-direction reference shows
    // a pale ribbed body with a star of long electric-blue filaments).
    // Biome-locked on purpose - a ten-tendril glowing star is the forest's
    // signature animal the way the Hollowjaw is Rock Spires', and diluting it
    // across the shelf would spend it.
    habitat: HABITAT.PELAGIC, biomes: [PLATTER], depthRange: [55, 130],
    // 1.9 m bell (review round: "no presence... reads as a distant
    // jellyfish" at 1.3): the reference creature dominates its frame.
    length: 1.90, mass: 140,
    diet: ['Glimmerkrill', 'Coppersprat fry', 'marine snow'],
    dangerTier: 1,
    aggressionTrigger: 'contact only',
    damage: { player: 4, vessel: 0, effect: '6 s DoT of 0.4 HP/s; brief control jitter' },
    health: 60, speed: 0.30, burstSpeed: 0.85, turnRate: 18,
    // Singles and pairs, dense enough that the anchor frame usually holds
    // one: the near field draws from densityPerKm3 over a ~0.03 km^3 volume.
    schoolSize: [1, 2], densityPerKm3: 90,
    dayNightActivity: [1.0, 1.0], lightAffinity: 0.10, lightFlipRadius: 0,
    threatTau: 3, electroR: 0,
    bioluminescence: {
      // Deep saturated blue at MODERATE intensity: the review measured the
      // first draft ([0.30,0.80,1.00] x 1.6) as WHITE streamers - the
      // brighter-is-whiter trap on a creature, and hue is the lever.
      colour: [0.10, 0.55, 1.00], intensity: 1.1,
      pattern: BIOLUM_PATTERN.TENDRILS, isLure: false, hz: 0.45,
    },
    audioHz: 26,
    meshRecipe: {
      plan: 'bell', spineBones: 6, girth: 0.50, depth: 0.42, rings: 10, segs: 14,
      // Pearl-pink body: the reference's ribbed pale-rose torso reads as
      // ALBEDO; the cyan is all in the glow mask on the tendrils.
      tint: [232, 184, 200],
      bell: { radius: 0.85, height: 0.66, ribs: 8 },
      // Ten long stiffish filaments, barely curled: the radiating star.
      // Length 10 and radius 0.048 after the review: at 7.0 / 0.030 the
      // star read as short white streamers a fifth of the reference's span.
      tentacles: { count: 10, length: 10.0, radius: 0.048, taper: 0.25, curl: 0.03 },
    },
    note: 'A metre-wide pearl-rose bell trailing a ten-armed star of seven-metre filaments, every one ' +
      'alight base to tip in electric cyan. It drifts between the platter columns at reading pace, ' +
      'harmless unless touched, and at night the forest is navigable by its slow constellations alone. ' +
      'Pilots learn to thread the star rather than charge it: a filament across the canopy glass costs ' +
      'nothing but leaves a six-second smear of light.',
  },

  {
    id: 'CRT_GLOOMRAY', name: 'Gloomray', latinish: 'Umbrabatis magna',
    archetype: ARCHETYPE.RAY, steering: 'ARCH_GLIDER', swimMode: SWIM_MODE.RAJIFORM,
    habitat: HABITAT.BENTHIC, biomes: [ASHPLAIN, WALL, SPONGE, TRENCHWALL], depthRange: [380, 1500],
    length: 4.60, mass: 620,
    diet: ['Sepulcher Louse', 'Hagline', 'Scaldback', 'benthic worms'],
    dangerTier: 2,
    aggressionTrigger: 'player within 6 m of the substrate directly beneath it, or damage taken',
    damage: { player: 22, vessel: 18, effect: 'tail lash targets the windshield' },
    health: 700, speed: 1.4, burstSpeed: 6.0, turnRate: 60,
    schoolSize: [1, 2], densityPerKm3: 6,
    dayNightActivity: [1.0, 1.0], lightAffinity: 0.30, lightFlipRadius: 35,
    threatTau: 35, electroR: 9,
    bioluminescence: {
      colour: [0.10, 0.25, 0.45], intensity: 0.06,
      pattern: BIOLUM_PATTERN.NET, isLure: false, hz: 0.05,
    },
    audioHz: 22,
    meshRecipe: {
      plan: 'ray', spineBones: 8, girth: 0.50, depth: 0.055, rings: 15, segs: 22,
      tint: [36, 38, 42], ventral: [58, 60, 64],
      discExponent: 0.70,
      tail: { length: 7.3, taper: 0.08, barbs: 3 },
      cephalicLobes: { count: 2, length: 0.42, radius: 0.09 },
      eyes: { radius: 0.055, at: 0.16, spread: 0.34, dorsal: true },
    },
    note: 'Four and a half metres of slow silent black wing sliding over the ash plain twenty metres above ' +
      'the bottom, its dorsal net-pattern glowing so dimly it is only visible with your lamps off. Not a ' +
      'hunter of the player: enormous, easily provoked, and carrying a tail lash that can crack a ' +
      'windshield. Its 22 Hz wingbeat is felt in the HUD jitter and the sub-bass long before there is ' +
      'anything to see, which is the most reliable "you are not alone down here" cue in the game.',
  },

  {
    id: 'CRT_LANTERNGAPE', name: 'Lanterngape', latinish: 'Illicioceras fallax',
    archetype: ARCHETYPE.ANGLER, steering: 'ARCH_LURER', swimMode: SWIM_MODE.SUB_CARANGIFORM,
    habitat: HABITAT.WALL, biomes: [WALL, CANYON, TRENCHWALL], depthRange: [540, 1600],
    length: 1.05, mass: 34,
    diet: ['Wisplight', 'Umbral Squid juveniles', 'anything smaller', 'and it will try things larger'],
    dangerTier: 3,
    aggressionTrigger: 'any object approaching within 3.2 m of the lure tip; also blood scent above 0.10',
    damage: { player: 26, vessel: 11, effect: 'grip: 1.6 s hold, player cannot swim, 6 HP/s' },
    health: 160, speed: 0.20, burstSpeed: 8.8, turnRate: 55,
    schoolSize: [1, 1], densityPerKm3: 18,
    dayNightActivity: [1.0, 1.0], lightAffinity: 0.55, lightFlipRadius: 40,
    threatTau: 55, electroR: 0,
    bioluminescence: {
      colour: [0.55, 0.90, 0.65], intensity: 3.5,
      pattern: BIOLUM_PATTERN.LURE, isLure: true, hz: 0.91,
    },
    audioHz: 55,
    meshRecipe: {
      plan: 'globular', spineBones: 7, girth: 0.30, depth: 0.32, rings: 10, segs: 12,
      tint: [24, 24, 26], ventral: [34, 34, 36],
      jaw: { gape: 1.88, length: 0.42, teeth: 16 },
      lure: { length: 0.40, radius: 0.010, escaRadius: 0.030, segments: 5 },
      caudal: { span: 0.16, chord: 0.12, camber: 0.0, fork: 0.0 },
      pectoral: { span: 0.10, chord: 0.07, at: 0.42, camber: 0.05 },
      eyes: { radius: 0.022, at: 0.16, spread: 0.60 },
    },
    note: 'A globular loose-skinned matte-black predator with a mouth that is 40% of its body length, ' +
      'transparent teeth that read as absence rather than as white, and a single luminous nodule on a whip ' +
      'of dorsal spine held 0.4 m in front of its own face. It does not move. It hangs against the wall and ' +
      'it waits, and the only thing you see is a small green light twitching in a way deliberately identical ' +
      'to a resource nodule. It is the only creature permitted to be silent before its trigger, and legal ' +
      'only because the player must volunteer to enter the 3.2 m sphere around the lure.',
  },

  {
    id: 'CRT_UMBRALSQUID', name: 'Umbral Squid', latinish: 'Skiateuthis vorax',
    archetype: ARCHETYPE.CEPHALOPOD, steering: 'ARCH_CEPHALOPOD', swimMode: SWIM_MODE.JET,
    habitat: HABITAT.PELAGIC, biomes: [PELAGIC, CANYON, WALL, TRENCH, TRENCHWALL], depthRange: [300, 1600],
    length: 3.80, mass: 190,
    diet: ['Wisplight shoals', 'Chiselfin', 'Lanterngape', 'cannibalism'],
    dangerTier: 3,
    aggressionTrigger: 'any moving object 0.5-9 m long within 30 m; retreats if it takes over 25% health',
    damage: { player: 16, vessel: 12, effect: 'latch: drag +140%, 5 HP/s hull, shed by 2 s full reverse or 2000 lux' },
    health: 260, speed: 1.3, burstSpeed: 13.0, turnRate: 240,
    schoolSize: [1, 14], densityPerKm3: 14,
    dayNightActivity: [0.8, 1.4], lightAffinity: 0.20, lightFlipRadius: 25,
    threatTau: 20, electroR: 0,
    bioluminescence: {
      colour: [1.00, 0.15, 0.10], intensity: 2.5,
      pattern: BIOLUM_PATTERN.STRIPES, isLure: false, hz: 4.0,
    },
    audioHz: 55,
    meshRecipe: {
      plan: 'squid', spineBones: 6, girth: 0.115, depth: 0.125,
      tint: [92, 28, 26], biolumCount: 7,
      mantle: { length: 1.5 },
      arms: { count: 8, length: 2.3, radius: 0.055, taper: 0.10, curl: 0.30 },
      clubs: { count: 2, length: 3.1, radius: 0.038, taper: 0.16, padScale: 1.9 },
      fins: { span: 0.62, chord: 0.85, camber: 0.10 },
      eyes: { radius: 0.14, at: 0.88, spread: 0.90 },
    },
    note: 'Nearly four metres of red-black muscle that hangs motionless in mid-water with its arms ' +
      'trailing, then crosses eighteen metres in a second and a half. Its strobe display is the most ' +
      'aggressive visual in the game and also the most generous: when it commits, the whole animal becomes ' +
      'a barber-pole of red and white travelling head-to-tail at 4 Hz and lights the water around it. Its ' +
      'intelligence is expressed by retreat - it probes, disengages, circles at 40 m in the dark, and comes ' +
      'back from a different angle up to three times.',
  },

  {
    id: 'CRT_SEPULCHER', name: 'Sepulcher Louse', latinish: 'Necrocaris grandis',
    archetype: ARCHETYPE.CRUSTACEAN, steering: 'ARCH_CRUSTACEAN', swimMode: SWIM_MODE.WALK,
    habitat: HABITAT.BENTHIC, biomes: [ASHPLAIN, TRENCH, CANYON, TRENCHWALL], depthRange: [600, 1600],
    length: 0.68, mass: 11,
    diet: ['carrion (obligate)'],
    dangerTier: 1,
    aggressionTrigger: 'only if attacked, or if the player is under 25 HP and still for over 20 s',
    damage: { player: 6, vessel: 0, effect: 'curls into an armoured sphere under a lamp' },
    health: 120, speed: 0.25, burstSpeed: 1.4, turnRate: 120,
    schoolSize: [1, 400], densityPerKm3: 480,
    dayNightActivity: [1.0, 1.0], lightAffinity: -0.40, lightFlipRadius: 0,
    threatTau: 22, electroR: 0,
    bioluminescence: DARK, audioHz: 1100,
    meshRecipe: {
      plan: 'crustacean', spineBones: 9, girth: 0.34, depth: 0.20,
      tint: [214, 206, 188],
      legs: { count: 14, length: 0.16, radius: 0.008, splay: 1.20 },
      antennae: 2,
      eyestalks: { count: 2, length: 0.014, radius: 0.014 },
      plates: 9, carapaceLift: 0.30, uropods: 2,
    },
    note: 'A 68 cm armoured isopod-analog, bone-white, with fourteen legs and enormous compound eyes that ' +
      'have no light to see by. They are the abyss\'s undertakers and the game\'s most important ' +
      'storytelling tool: every corpse in the deep is eventually covered in them, and the state of a corpse ' +
      'tells you how long ago something died there. Two hundred of them working on a Veilmouth carcass at ' +
      '800 m, in silence, in your lamp beam, is the intended emotional preparation for meeting what killed it.',
  },

  {
    id: 'CRT_EMBERWORM', name: 'Emberworm', latinish: 'Thermovermis ignicola',
    archetype: ARCHETYPE.VENT_SPECIALIST, steering: 'ARCH_BURROWER', swimMode: SWIM_MODE.STATIC,
    habitat: HABITAT.VENT, biomes: [VENT], depthRange: [900, 1600],
    length: 2.20, mass: 4,
    diet: ['chemosynthetic symbionts (sulphide oxidation)'],
    dangerTier: 0,
    aggressionTrigger: 'none; the plume retracts into the tube in 0.25 s under a lamp',
    damage: { player: 0, vessel: 0, effect: null },
    health: 30, speed: 0, burstSpeed: 0, turnRate: 0,
    schoolSize: [60, 900], densityPerKm3: 2.4e5,
    dayNightActivity: [1.0, 1.0], lightAffinity: -0.90, lightFlipRadius: 0,
    threatTau: 30, electroR: 0,
    bioluminescence: {
      colour: [1.00, 0.25, 0.06], intensity: 0.30,
      pattern: BIOLUM_PATTERN.SCATTER_GLOW, isLure: false, hz: 0,
    },
    audioHz: 0,
    meshRecipe: {
      plan: 'tube', spineBones: 3, girth: 0.055, depth: 0.055, rings: 8, segs: 9,
      tint: [224, 220, 206], lean: 0.30,
      plume: { blades: 9, length: 0.55, chord: 0.11 },
    },
    note: 'Forests of chalk-white chitin tubes two metres tall leaning into the shimmer, each crowned with ' +
      'a plume of scarlet feathery gills. They react to everything: a lamp sweep across a colony of four ' +
      'hundred makes a wave of red plumes vanish into their tubes in sequence at the speed of the beam, and ' +
      'they re-emerge over the next several seconds once the light passes. That interaction is the entire ' +
      'reason this species exists - the darkest place in the game answering the player without a single tooth.',
  },

  {
    id: 'CRT_SCALDBACK', name: 'Scaldback', latinish: 'Pyrocheles ferox',
    archetype: ARCHETYPE.VENT_SPECIALIST, steering: 'ARCH_CRUSTACEAN', swimMode: SWIM_MODE.WALK,
    habitat: HABITAT.VENT, biomes: [VENT, ASHPLAIN], depthRange: [880, 1600],
    length: 1.15, mass: 42,
    diet: ['Emberworm plumes', 'Sepulcher Louse', 'vent shrimp', 'carrion'],
    dangerTier: 2,
    aggressionTrigger: 'intrusion within 5 m of its chimney, OR harvesting an Emberworm colony it guards',
    damage: { player: 24, vessel: 20, effect: 'immune to heat; attacks through the plume, which you cannot follow' },
    health: 340, speed: 0.5, burstSpeed: 3.2, turnRate: 170,
    schoolSize: [1, 4], densityPerKm3: 210,
    dayNightActivity: [1.0, 1.0], lightAffinity: -0.25, lightFlipRadius: 0,
    threatTau: 40, electroR: 0,
    bioluminescence: {
      colour: [1.00, 0.35, 0.10], intensity: 0.60,
      pattern: BIOLUM_PATTERN.THERMAL_PATCHES, isLure: false, hz: 0,
    },
    audioHz: 90,
    meshRecipe: {
      plan: 'crustacean', spineBones: 5, girth: 0.52, depth: 0.24,
      tint: [150, 66, 44], biolumCount: 4,
      legs: { count: 8, length: 0.52, radius: 0.030, splay: 1.0 },
      claws: { count: 2, length: 0.68, asymmetry: 0.55 },
      antennae: 2,
      plates: 11, carapaceLift: 0.62,
    },
    note: 'A blind brick-red heavily armoured vent crab the size of a large dog, with hairy setose legs, ' +
      'one massive crusher claw and one fine cutter, standing in 340 C water like it is a warm bath. It is ' +
      'the only creature that fights the player for territory rather than for food, and it is the reason ' +
      'the richest ore and biomass in the game is not free. Its heat immunity is a real mechanic: it ' +
      'repositions through the plume, which you cannot, so it attacks from an axis you cannot follow.',
  },

  {
    id: 'CRT_SALTWRAITH', name: 'Saltwraith', latinish: 'Halomurena spectralis',
    archetype: ARCHETYPE.AMBUSH, steering: 'ARCH_AMBUSHER', swimMode: SWIM_MODE.ANGUILLIFORM,
    habitat: HABITAT.BRINE_EDGE, biomes: [TRENCH, TRENCHWALL],
    // DESIGN/06 puts the Still Lake at 1,500-3,200 m. This world's floor is
    // 1,600 m, so a straight clamp would leave the Saltwraith a 100 m sliver of
    // habitat and the brine basin would have no shoreline to ambush from. The
    // band is scaled instead, keeping its relationship to the trench: the
    // deepest 400 m of water, which is exactly what it was.
    depthRange: [1200, 1600],
    length: 5.20, mass: 340,
    diet: ['anything that touches the brine surface', 'Sepulcher Louse', 'Ghostbell'],
    dangerTier: 3,
    aggressionTrigger: 'any disturbance of the brine interface within 14 m - crossing the halocline, ' +
      'dropping an object into it, or thruster wash on it',
    damage: { player: 34, vessel: 26, effect: 'drag-under: 2.4 s pull into the brine; player death, 60 HP/s hull crush' },
    health: 520, speed: 0.7, burstSpeed: 12.2, turnRate: 80,
    schoolSize: [1, 5], densityPerKm3: 4,
    dayNightActivity: [1.0, 1.0], lightAffinity: -0.65, lightFlipRadius: 0,
    threatTau: 90, electroR: 26,
    bioluminescence: {
      colour: [0.75, 0.90, 1.00], intensity: 2.2,
      pattern: BIOLUM_PATTERN.JAW_PORES, isLure: false, hz: 0,
    },
    audioHz: 60,
    meshRecipe: {
      plan: 'eel', spineBones: 16, girth: 0.055, depth: 0.075, rings: 20, segs: 10,
      tint: [196, 190, 178], ventral: [220, 216, 208], biolumCount: 9,
      jaw: { gape: 0.85, length: 0.60, teeth: 18, pharyngeal: 0.35 },
      dorsalFin: { span: 0.13, chord: 3.6, at: 0.55, camber: 0.0, sweep: 0.05 },
    },
    note: 'Five metres of pale translucent eyeless eel buried to the gills in the flocculent crust at the ' +
      'edge of a brine pool, invisible until the moment its jaw-pores light. The Still Lake is a real, ' +
      'denser fluid body with a mirror-flat surface and a shoreline of white bacterial mat, and the ' +
      'Saltwraith is why the player will stand at that shoreline and not go in. It hunts by ' +
      'electroreception and by sensing the interface, so darkness and stillness do not save you - only ' +
      'staying out of the water does. Its drag-under is the game\'s only instant kill, and it is signposted ' +
      'by a full second of a face full of lights.',
  },

  {
    id: 'CRT_PALEWANDER', name: 'Palewander', latinish: 'Cavernops caecus',
    archetype: ARCHETYPE.CAVE_DWELLER, steering: 'ARCH_SHOALER', swimMode: SWIM_MODE.SUB_CARANGIFORM,
    habitat: HABITAT.PELAGIC, biomes: [CAVE], depthRange: [0, 1400],
    length: 0.20, mass: 0.07,
    diet: ['cave detritus', 'bacterial mat', 'chemosynthetic film'],
    dangerTier: 0,
    aggressionTrigger: 'none',
    damage: { player: 0, vessel: 0, effect: null },
    health: 4, speed: 0.5, burstSpeed: 2.4, turnRate: 380,
    schoolSize: [60, 400], densityPerKm3: 3.0e4,
    dayNightActivity: [1.0, 1.0], lightAffinity: 0.0, lightFlipRadius: 0,
    threatTau: 5, electroR: 0,
    bioluminescence: DARK, audioHz: 0,
    meshRecipe: {
      plan: 'fusiform', spineBones: 6, girth: 0.10, depth: 0.14, rings: 8, segs: 8,
      tint: [210, 204, 196],
      caudal: { span: 0.050, chord: 0.036, camber: 0.0, fork: 0.25 },
      pectoral: { span: 0.070, chord: 0.020, at: 0.28, camber: 0.02 },
    },
    note: 'Blind unpigmented semi-translucent cave fish with visible spines and a slow deliberate hover, ' +
      'navigating a pitch-black flooded system perfectly by lateral line alone. Their indifference to the ' +
      'player\'s lamp is the entire design: every other creature in the game responds to light and these do ' +
      'not even know it exists, which makes the Undervault feel like a place that is not for you. They flow ' +
      'around the vessel like water around a stone, never startle at light, and startle violently at sound.',
  },

  {
    id: 'CRT_VAULTSTALKER', name: 'Vaultstalker', latinish: 'Speleovenator albus',
    archetype: ARCHETYPE.CAVE_DWELLER, steering: 'ARCH_AMBUSHER', swimMode: SWIM_MODE.SUB_CARANGIFORM,
    habitat: HABITAT.TERRITORY, biomes: [CAVE], depthRange: [400, 1400],
    length: 6.80, mass: 1150,
    diet: ['Palewander', 'Umbral Squid', 'Sepulcher Louse', 'and it is not fussy'],
    dangerTier: 4,
    aggressionTrigger: 'sustained noise: lateral-line stimulus above 2.0 for more than 3.0 cumulative ' +
      'seconds inside its 180 m territory. Not sight. Not light alone.',
    damage: { player: 46, vessel: 38, effect: 'targets the lamp array first - it is removing your light on purpose' },
    health: 1400, speed: 0.35, burstSpeed: 14.5, turnRate: 45,
    schoolSize: [1, 1], densityPerKm3: 0.8,
    dayNightActivity: [1.0, 1.0], lightAffinity: 0.40, lightFlipRadius: 30,
    threatTau: 180, electroR: 0,
    bioluminescence: DARK, audioHz: 3100,
    meshRecipe: {
      plan: 'fusiform', spineBones: 12, girth: 0.075, depth: 0.135, rings: 16, segs: 12,
      tint: [240, 238, 232], ventral: [246, 244, 238],
      ridge: { count: 18, height: 0.10, chord: 0.16 },
      jaw: { gape: 1.15, length: 0.85, teeth: 0, lobes: 5, interior: true },
      filaments: { count: 6, length: 1.20, radius: 0.020, taper: 0.3 },
      caudal: { span: 0.95, chord: 0.60, camber: 0.0, fork: 0.2 },
      pectoral: { span: 0.50, chord: 0.26, at: 0.26, camber: 0.04 },
    },
    note: 'Seven metres of blind white muscle that lives in the flooded tunnels and hunts entirely by ' +
      'sound. It presses itself flat against a ceiling in a side-passage and waits, sometimes for a real ' +
      'hour, and it is genuinely there the whole time - it does not spawn behind you. Its counterplay is ' +
      'silence: cut the thrusters, coast, and it will click past you at four metres. Not light, not speed ' +
      'and not weapons. Its echolocation clicking is audible at 200 m and never stops while it is inside ' +
      'that radius, at any audio setting.',
  },

  // =========================================================================
  // THE THREE LEVIATHANS  (DESIGN/06 06.4.6)
  // =========================================================================

  {
    id: 'LEV_HOLLOWJAW', name: 'Hollowjaw', latinish: 'Cavignathus vastus',
    archetype: ARCHETYPE.LEVIATHAN, steering: 'ARCH_LEVIATHAN', swimMode: SWIM_MODE.THUNNIFORM,
    habitat: HABITAT.TERRITORY, biomes: [WALL, CANYON, SPONGE], depthRange: [380, 980],
    length: 31.0, mass: 165000,
    diet: ['Veilmouth', 'Umbral Squid', 'Chiselfin packs', 'Gloomray'],
    dangerTier: 4,
    aggressionTrigger: 'vessel inside its 320 m territory above 40% throttle; OR any sonar ping within ' +
      '500 m; OR blood scent above 0.06',
    damage: { player: 68, vessel: 260, effect: 'ram 40/180, tail sweep 25/90; grab only below 45% hull' },
    health: 9000, speed: 2.6, burstSpeed: 15.5, turnRate: 22,
    schoolSize: [1, 1], densityPerKm3: 0.03,
    dayNightActivity: [0.9, 1.2], lightAffinity: -0.20, lightFlipRadius: 0,
    threatTau: 240, electroR: 0,
    bioluminescence: {
      colour: [0.15, 0.35, 0.55], intensity: 0.05,
      pattern: BIOLUM_PATTERN.PIT_LIGHTS, isLure: false, hz: 0,
    },
    audioHz: 41,
    meshRecipe: {
      plan: 'whale', spineBones: 16, girth: 0.115, depth: 0.155, rings: 22, segs: 18,
      tint: [96, 106, 116], ventral: [162, 170, 174], biolumCount: 12,
      occiput: { at: 0.16, gain: 1.30 },
      jaw: { gape: 1.68, length: 6.2, teeth: 20, interior: true },
      fluke: { span: 9.0, chord: 4.6, camber: 0.05, fork: 0.70 },
      pectoral: { span: 4.4, chord: 2.0, at: 0.24, camber: 0.09 },
      eyes: { radius: 0.20, at: 0.09, spread: 0.66 },
      plates: 6,
    },
    note: 'Thirty-one metres of blue-grey scar-covered blunt-headed animal built like a battering ram, ' +
      'with a jaw that unhinges to 96 degrees onto a pale ridged hollow interior that gives it its name. ' +
      'Small forward-set eyes and a genuinely stupid, incurious expression, which is worse than malevolence. ' +
      'It patrols the canyon rim in long lazy figure-eights, and its 41 Hz call sits just below the ' +
      'Veilmouth\'s 62 Hz: the player\'s first reaction is relief and the second is the realisation that ' +
      'this is not the friendly one. Hard ceiling 380 m, hard floor 980 m - vertical escape always works.',
  },

  {
    id: 'LEV_PALEHERALD', name: 'Pale Herald', latinish: 'Praeconodus albus',
    archetype: ARCHETYPE.LEVIATHAN, steering: 'ARCH_LEVIATHAN', swimMode: SWIM_MODE.THUNNIFORM,
    habitat: HABITAT.TERRITORY, biomes: [ASHPLAIN, SPONGE, TRENCHWALL], depthRange: [820, 1600],
    length: 47.0, mass: 520000,
    diet: ['Hollowjaw', 'Gloomray', 'Umbral Squid', 'Veilmouth'],
    dangerTier: 5,
    aggressionTrigger: 'any active sonar ping within 900 m - it answers pings; OR a vessel above 55% ' +
      'throttle within 400 m for over 10 s; OR blood scent above 0.04',
    damage: { player: 100, vessel: 420, effect: 'shockwave 30/140 stuns every creature within 45 m; ram 55/300' },
    health: 26000, speed: 3.1, burstSpeed: 19.0, turnRate: 15,
    schoolSize: [1, 1], densityPerKm3: 0.012,
    dayNightActivity: [1.0, 1.0], lightAffinity: 0.35, lightFlipRadius: 120,
    threatTau: 240, electroR: 0,
    bioluminescence: {
      colour: [0.85, 0.92, 1.00], intensity: 40.0,
      pattern: BIOLUM_PATTERN.FLOOD_ORGAN, isLure: false, hz: 0,
    },
    audioHz: 18,
    meshRecipe: {
      plan: 'whale', spineBones: 16, girth: 0.105, depth: 0.150, rings: 24, segs: 18,
      tint: [228, 226, 220], ventral: [238, 236, 230],
      melon: { at: 0.13, gain: 1.34 },
      inflate: { maxScale: 1.18, bellyBias: 0.0, at: 0.13, spread: 0.10 },
      jaw: { gape: 1.20, length: 15.0, teeth: 24, interior: true },
      fluke: { span: 12.0, chord: 6.0, camber: 0.05, horizontal: true, fork: 0.55 },
      pectoral: { span: 5.4, chord: 2.4, at: 0.22, camber: 0.09 },
      streamers: { count: 4, length: 6.0, radius: 0.11, taper: 0.25 },
      plates: 7,
    },
    note: 'Forty-seven metres of chalk-white slab-sided eyeless animal that navigates a lightless plain by ' +
      'sound and lights it with its own face when it wants to see. No eyes at all: a smooth blank melon and ' +
      'a jaw running a third of its body length, hung with pale parasitic streamers. Its terror is pacing, ' +
      'not speed - it is slow, patient, hears the player a kilometre away, and its click train is a ' +
      'countdown the player learns to read exactly. When the interval drops below 200 ms you have about ' +
      'four seconds. Ceiling 820 m; the Hollowjaw\'s floor is 980 m, so 820-980 m is inside both territories.',
  },

  {
    id: 'LEV_NETHERCOIL', name: 'Nethercoil', latinish: 'Abyssoserpens innumerabilis',
    archetype: ARCHETYPE.LEVIATHAN, steering: 'ARCH_LEVIATHAN', swimMode: SWIM_MODE.ANGUILLIFORM,
    habitat: HABITAT.TERRITORY, biomes: [TRENCH, TRENCHWALL],
    // DESIGN/06 gives a hard ceiling of 1,650 m, which is BELOW this world's
    // floor of 1,600 m - clamping would make it unspawnable, so the ceiling is
    // scaled to 1,300 m. The invariant that matters is preserved: its ceiling
    // sits below the Pale Herald's floor with a narrow overlap band, so there is
    // still exactly one stretch of water inside two leviathan territories.
    // MEASURED 2026-08-07 (seed 1534754449): the -1600 floor that comment
    // trusts is real terrain but lies at radius 4,103 m, past
    // WORLD.HARD_BOUNDARY 3,050; the deepest PLAYABLE water is -1055.7 m
    // (r <= 2900). Every metre of this band is therefore unreachable today,
    // and the species is deliberately deferred rather than re-scoped: see the
    // Nethercoil refutation in world/leviathan_sites.js for the measured
    // conflict between reachable deep water and the tour anchors, and the two
    // ways out (a trench boundary decision, or a scripted encounter like the
    // Herald's).
    depthRange: [1300, 1600],
    length: 96.0, mass: 1250000,
    diet: ['Pale Herald', 'Saltwraith', 'and geology, apparently'],
    dangerTier: 5,
    aggressionTrigger: 'any light source above 800 lux within 600 m; OR any sonar ping within 1,400 m; ' +
      'OR entering the trench axis below the deep line for more than 60 s',
    damage: { player: 100, vessel: 900, effect: 'bite is instant death; coil crush 70/340 per second; tail slam 60/400' },
    health: 60000, speed: 2.2, burstSpeed: 17.0, turnRate: 9,
    schoolSize: [1, 1], densityPerKm3: 0.004,
    dayNightActivity: [1.0, 1.0], lightAffinity: -1.00, lightFlipRadius: 0,
    threatTau: 900, electroR: 40,
    bioluminescence: {
      colour: [0.55, 0.05, 0.15], intensity: 1.2,
      pattern: BIOLUM_PATTERN.MOUTH_GLOW, isLure: false, hz: 0,
    },
    audioHz: 11,
    meshRecipe: {
      plan: 'segmented', spineBones: 24, girth: 0.030, depth: 0.032, rings: 26, segs: 16,
      tint: [28, 28, 30],
      plates: 24, plateLip: 0.11,
      lateralSpines: { count: 6, length: 0.95, radius: 0.13, every: 4 },
      jaw: { gape: 1.05, length: 7.5, teeth: 0, lobes: 6, interior: true },
    },
    note: 'Ninety-six metres of segmented armoured blind serpent living in a trench, with a head like a ' +
      'geological formation and a body that is never fully visible at once - you see a section pass through ' +
      'your lamp cone, and then more of it, and then more. Its scales are matte black with a dull metallic ' +
      'sheen at grazing angles. The correct player experience of it is not a fight: it is hiding in a ' +
      'crevice with everything switched off while ninety-six metres of animal goes past four metres away ' +
      'for eleven continuous seconds. There is no reward for engaging it. The reward is having left.',
  },

  {
    // THE SPLITMAW (2026-08-19): the fourth leviathan, built for biome 18's
    // Sunken Dunes and against its art-direction reference
    // frames. The design
    // brief it answers is the user's own: the earlier leviathans read as
    // faceted blimps in murk, so this one is authored to be SEEN COMING -
    // it lives in the one deep biome with 121 m sightlines, its dorsum is
    // crimson against luminous azure water, and its face is a face: four
    // mandible horns (the `mandibles` part) framing an animated two-lobe maw
    // whose gape IS the tier-5 telegraph.
    //
    // REBUILT 2026-08-21 for the showcase's monster beat, against four
    // playtest notes on the SHIFT+G recording: twice the size, an
    // anguilliform body wave instead of a rigid one, horns that fold shut
    // and flare open with the gape, and a charge that no longer stops (see
    // entities/dune_ambush.js). The first three are all on this record -
    // `length`, `swimMode` + `swimAnim`, and `mandibles.fold`.
    id: 'LEV_SPLITMAW', name: 'Splitmaw', latinish: 'Quadrimaxilla rapax',
    archetype: ARCHETYPE.LEVIATHAN, steering: 'ARCH_LEVIATHAN',
    // ANGUILLIFORM, not the CARANGIFORM it shipped as (2026-08-21). The mode
    // picks the amplitude envelope, and carangiform's uMin is 0.45 - only the
    // rear 55% of the body waves, which on a straight-line charge is a plank
    // with a flicking tail. Anguilliform's uMin is 0.05, so the wave runs from
    // just behind the skull to the fluke and the animal reads as a serpent.
    swimMode: SWIM_MODE.ANGUILLIFORM,
    habitat: HABITAT.TERRITORY, biomes: [DUNES], depthRange: [300, 430],
    // NINETY METRES (2026-08-21, doubled from 45 by user instruction for the
    // showcase's monster beat). Every ABSOLUTE dimension in meshRecipe below
    // doubled with it - the fractions (girth, depth, at, from/to, splay, fork,
    // camber, taper) did not, because they are already relative to `length`.
    // Mass goes as the cube: 310 t -> 2,480 t.
    length: 90.0, mass: 2480000,
    diet: ['Veilmouth', 'Gloomray', 'Chiselfin packs', 'anything that casts a shadow on the sand'],
    dangerTier: 5,
    aggressionTrigger: 'line of sight on a swimmer in open water inside its 300 m territory - it hunts by ' +
      'EYE, unique among the leviathans, which is why it lives in the clearest deep water in the world; ' +
      'OR a vessel above 45% throttle within 350 m; OR any sonar ping within 700 m',
    damage: { player: 90, vessel: 380, effect: 'mandible grab 60/280 then thrash; tail scythe 30/120' },
    health: 24000, speed: 3.2, burstSpeed: 21.0, turnRate: 20,
    // THE ONE PER-SPECIES WAVE OVERRIDE IN THE ROSTER, AND IT EXISTS BECAUSE
    // AMPLITUDE AND RATE ARE BOTH DRIVEN BY U = speed / bodyLength.
    //
    // ARCH_LEVIATHAN's numbers (f0 0.16, kf 0.55, fMin 0.08, A0 0.03, A1 0.09,
    // U0 0.1, U1 1.6) are sized for a 30-40 m animal. At 90 m a 19 m/s charge is
    // U = 0.21, which lands BELOW U0 - so the amplitude sits on its floor of
    // 0.03 body lengths and the beat rate on f = 0.28 Hz. One small flick every
    // three and a half seconds, which is exactly what the playtest called "right
    // as a stick". The other three leviathans are correct at their own sizes and
    // must not move, hence a per-species row rather than a retune of the shared
    // archetype (and NOT a new ARCH_* row: SPECIES_TABLE.archetype is resolved
    // from `steering`, and `steering === 'ARCH_LEVIATHAN'` is what sets
    // SPECIES_FLAG.LEVIATHAN, which three call sites in creatures.js read).
    //
    // U0/U1 are re-scaled to the band this animal actually swims in (0.02-0.25
    // body lengths/s covers the 0.4 m/s creep to the 21 m/s burst), the
    // amplitude floor is raised so a slow approach still writhes, and lambdaB
    // 0.80 puts 1.25 wavelengths along the body instead of 0.8 - more than one
    // visible S-bend is the difference between a fish and a serpent. Ap is the
    // dorsoventral fraction, hard-wired to 0 for every non-thunniform mode by
    // writeSpeciesAnim; 0.30 tilts the wave out of the pure horizontal plane.
    swimAnim: {
      f0: 0.28, kf: 1.10, fMin: 0.26, fMax: 0.85,
      A0: 0.10, A1: 0.15, U0: 0.02, U1: 0.25,
      lambdaB: 0.80, bendMax: 0.70, Ap: 0.30,
    },
    schoolSize: [1, 1], densityPerKm3: 0.02,
    dayNightActivity: [1.1, 0.9], lightAffinity: 0.15, lightFlipRadius: 0,
    threatTau: 240, electroR: 0,
    // DORSAL_EMBER carries the crimson identity, and the first delivered
    // frames are why: at 348 m under DUNE_AZURE the illuminant has no red,
    // so the original crimson SADDLES reflectance delivered nothing and the
    // pale tint bloomed into a glowing white blimp under auto-exposure.
    // Emission owns its spectrum (the biome's fan row learned the same
    // lesson); intensity 2.4 against a mask capped at 0.5 is a dull ember,
    // not a lamp.
    // Intensity 0.9 from 3.2 (creature review round 1): at 3.2 the ember
    // shouldered through AgX - the crimson washed to salmon and the whole
    // animal bloomed into a "lit balloon". A dull ember over a DARK hide
    // (tint below) is what delivers red-over-dark, the reference's actual
    // value structure: the splitmaw is the darkest object in its frame.
    // THE EMBER LADDER, closed by an ISOLATION SHOT: 0.9 rose, 1.3 salmon,
    // 1.9 brighter salmon, 0.7 salmon, 0.25 light pink - and at exactly 0
    // the horns finally delivered DARKER THAN THE WATER (dull dark khaki,
    // the value inversion three review rounds demanded). The ember was the
    // pink at every level: emission rides the AgX shoulder toward white
    // and mixes with blue in-scatter, so any radiance that registers at
    // all registers pastel (brighter-is-whiter, met a third time; the
    // darkGain also multiplies the authored number ~2.1x at 348 m). 0.12
    // is a WHISPER: a red hue bias on a dark surface whose value the
    // albedo owns - the only crimson this illuminant can deliver, and the
    // same delivered look as the biome's own crimson fans.
    bioluminescence: {
      colour: [0.62, 0.03, 0.02], intensity: 0.12,
      pattern: BIOLUM_PATTERN.DORSAL_EMBER, isLure: false, hz: 0,
    },
    audioHz: 33,
    meshRecipe: {
      // 90 m on the splitmaw plan: real skull mass at u 0.10, post-cranial
      // pinch, then the long tail. Slender against the whale leviathans -
      // girth 0.052 is a 4.7 m half-width on a 90 m animal.
      //
      // spineBones 22 (from 20): skinning blends LINEARLY between two bones, so
      // the anguilliform wave above facets at long segment lengths. 22 bones is
      // 4.1 m per segment over 90 m, against 4.5 at 20. The chain also has to
      // share the palette with the jaw bone and the four new mandible bones -
      // 22 + 1 + 4 = 27 of RENDER.MAX_BONES_PER_CREATURE's 28.
      plan: 'splitmaw', spineBones: 22, girth: 0.052, depth: 0.062, rings: 30, segs: 18,
      // Matte hide (the field's founding consumer): at the wet-skin default
      // the hull mirrored the luminous water dome and rendered WHITE at any
      // albedo - measured with a [20,20,22] diagnostic tint that still
      // delivered a pale body.
      skinRoughnessBias: 0.50,
      // THE ONE DARK THING IN LUMINOUS WATER - the tint ladder ran
      // [186,196,202] (white bloom) -> [118,128,136] (still "pastel plush",
      // creature review round 1) -> this dark rust-slate. The reference
      // splitmaw is the darkest, most saturated object in its own frame; in
      // water this bright, dark IS the monster read, and the pale half of
      // the two-tone lives on the VENTRAL only, where the reference keeps
      // it. Rust in the red channel so lamps return dried-blood, not grey.
      tint: [64, 58, 60], ventral: [72, 76, 76],
      // INVERTED saddles - pale banding over the dark hide (dark-on-dark
      // crimson measured an invisible 0.051 albedo step): the reference
      // tail carries pale bands, and on a dark animal the pale mark is
      // what breaks the silhouette into segments at range.
      pattern: { kind: 'saddles', count: 6, duty: 0.30, strength: 0.70, colour: [118, 110, 104] },
      // length 12.8 / chord 2.8: the 6.4 / 1.4 that was sized against
      // test-bestiary section 9's +/-15% axis measure, doubled with `length`.
      // splay 0.75 (round 4): at 0.55 the blade horns vanished edge-on in the
      // side profile while the tail streamers read as the hooks - the animal's
      // head and tail swapped identities at silhouette range.
      // Dark carapace base so the ember dominates (review round 2 delta 2).
      //
      // `fold` (2026-08-21) IS THE NEW ANIMATION CHANNEL AND THE MESH IS STILL
      // AUTHORED OPEN. Each horn now owns a bone (BONE_ROLE.MANDIBLE) that
      // rotates it about the axis TANGENTIAL to its own radial by
      // (1 - jawOpen) * fold, so jawOpen 1 reproduces the splayed X above
      // exactly and jawOpen 0 folds all four shut over the maw. Authoring the
      // fold rather than an unfold is what keeps three creature-review rounds
      // of silhouette work intact at the one moment the shot is about it.
      // THE ANGLE IS MEASURED, NOT TUNED, and the sweep is why 0.68 and not
      // the 0.62 first authored. Replaying the GPU's rotation over the real
      // 56-vertex horns and reporting min tip-to-tip / min horn-surface-to-horn
      // / min horn-to-jaw-plate, in metres:
      //
      //   fold   tip-tip   horn-horn   horn-jaw   tip span
      //   0.00     15.83        0.07       0.33      23.1   (as authored, open)
      //   0.50      5.55        0.21       0.22       8.5
      //   0.62      2.89        0.23       0.22       4.8
      //   0.68      1.56        0.41       0.27       2.9
      //   0.75      0.01        0.01       0.33       1.0   (tips meet)
      //   1.20      8.99        0.02       0.17      13.4   (crossed over)
      //
      // 0.75 is where the four tips MEET on the axis and past it they cross and
      // splay again inverted, so the usable range is (0, 0.75) and the number
      // wants margin under it. 0.68 shuts the cage to a 1.56 m gap - 1.7% of
      // body length, which reads as closed at any range the shot uses - and it
      // is also the local MAXIMUM of horn-surface-to-horn-surface clearance
      // (0.41 m) over that whole range, so it is the least likely angle in it
      // to interpenetrate if the horn profile is ever re-cut. Nothing is driven
      // into the jaw plates: that clearance RISES with the fold, 0.22 -> 0.27.
      // test-bestiary section 15 re-derives all three from the delivered mesh.
      mandibles: { count: 4, length: 12.8, splay: 0.75, at: 0.05, chord: 2.8,
        colour: [70, 18, 16], taper: 0.08, fold: 0.68 },
      // THE MAW (review round 2's blocking defect: "an animal named
      // Splitmaw has no visible maw"): a wider rest gape and longer, wider,
      // NEAR-BLACK jaw plates make the closed mouth a dark transverse seam
      // between the lower horn roots, with the pale tooth rows studding it.
      jaw: { gape: 1.90, length: 13.0, teeth: 28, interior: true, interiorDark: true,
        plateColour: [30, 12, 10] },
      // Forward and tight (round 5: at 0.075/0.62 the eyes sat behind the
      // skull's widest station and were invisible from dead ahead - and
      // head-on is this animal's whole read).
      eyes: { radius: 1.40, at: 0.048, spread: 0.55 },
      // ONE continuous CRIMSON sail over the skull - the side profile's
      // landmark. thickness (0.25 before the doubling) kills the box edge that
      // read as a hardware cube in the telegraph framing; taller and darker per
      // the round-2 deltas.
      crest: { count: 1, height: 12.0, chord: 15.0, from: 0.06, to: 0.34,
        colour: [120, 24, 18], thickness: 0.50 },
      // The fluke ladder (in pre-doubling metres): 7.0 out-massed the skull;
      // 5.4 at fork 0.30 still rendered as a pale BLOB that read as a whale
      // head. 4.2 at fork 0.60 is a deep-forked scythe - two thin lobes, no
      // mass, and the head's mandible X (tip-to-tip ~22 m at 90 m of animal) is
      // still the widest splay on it.
      caudal: { span: 8.4, chord: 5.2, camber: 0.04, fork: 0.60 },
      pectoral: { span: 9.2, chord: 4.2, at: 0.30, camber: 0.08 },
      // Two short streamers (round 4: four long ones at the tail tip read
      // as mandible hooks and stole the head's identity).
      streamers: { count: 2, length: 9.0, radius: 0.20, taper: 0.25 },
    },
    note: 'Ninety metres of crimson-backed pale-bellied animal that hunts the one deep place with ' +
      'clear water, because it is the one leviathan that hunts by sight. Four grasping mandible horns ' +
      'fold shut over a mouth that unhinges in two halves and spring open into a splayed X as it ' +
      'commits, and the first thing it does on noticing a diver is turn head-on, which is also the ' +
      'moment its silhouette becomes a cross. Its whole length rolls through the water behind that ' +
      'head. It patrols the bone field it has spent a century stocking. Hard ceiling 300 m - the open ' +
      'water above the shoal is always an exit, and knowing that does not help as much as it should.',
  },
];

// ---------------------------------------------------------------------------
// Normalisation and freezing
// ---------------------------------------------------------------------------

/** Recursively freeze a plain object graph. Records must not be mutable. */
function deepFreeze(o) {
  if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o;
  for (const k of Object.keys(o)) deepFreeze(o[k]);
  return Object.freeze(o);
}

/**
 * Clamp every depth range into the world this build actually has.
 *
 * DESIGN/06 was written against a 3,200 m ocean; WORLD.MAX_DEPTH is 1,600 m and
 * WORLD.MAX_TERRAIN_HEIGHT is 214 m. Doing this here, once, rather than in
 * every consumer, is why the spawner can trust `depthRange` unconditionally -
 * and why the test can assert containment without a special case per species.
 */
for (const s of ROSTER) {
  const lo = clamp(s.depthRange[0], -WORLD.MAX_TERRAIN_HEIGHT, WORLD.MAX_DEPTH);
  const hi = clamp(s.depthRange[1], -WORLD.MAX_TERRAIN_HEIGHT, WORLD.MAX_DEPTH);
  s.depthRange = [Math.min(lo, hi), Math.max(lo, hi)];
  s.meshRecipe.spineBones = Math.min(s.meshRecipe.spineBones, RENDER.MAX_BONES_PER_CREATURE);
}

/** The roster, frozen. Index order is the DESIGN/06 06.4.1 roster order. */
export const SPECIES = deepFreeze(ROSTER);

/** How many species exist. Also the exclusive upper bound on a species index. */
export const SPECIES_COUNT = SPECIES.length;

/** id string -> record. The lookup every other system wants. */
export const speciesById = Object.freeze(
  SPECIES.reduce((m, s) => { m[s.id] = s; return m; }, Object.create(null)),
);

/** id string -> index into SPECIES, for the u16 `speciesId` in the agent pool. */
export const SPECIES_INDEX = Object.freeze(
  SPECIES.reduce((m, s, i) => { m[s.id] = i; return m; }, Object.create(null)),
);

/** archetype -> the records that use it. */
export const SPECIES_BY_ARCHETYPE = Object.freeze(
  ARCHETYPE_LIST.reduce((m, a) => {
    m[a] = Object.freeze(SPECIES.filter((s) => s.archetype === a));
    return m;
  }, Object.create(null)),
);

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Memo for speciesForBiome. Keyed by biome id and an 8 m depth bucket, so the
 * key space is bounded at HABITAT_ID_COUNT * 226 entries even if the spawner
 * asks for every metre of the water column in every habitat. Values are frozen
 * arrays, shared: callers must not mutate them, and cannot.
 */
const _forBiome = new Map();
const DEPTH_BUCKET = 8;
const EMPTY = Object.freeze([]);

/**
 * Every species that may spawn in a habitat at a depth.
 *
 * Sorted by density, DESCENDING, then by roster order: a spawner walking the
 * list and stopping when its budget runs out therefore places the common
 * animals first and the rare ones only when there is room, which is the correct
 * failure mode. A leviathan is never crowded out by krill because the director
 * budgets it separately (DESIGN/06 06.6.4).
 *
 * This is a habitat filter, NOT a legality check. The Safe Charter (06.6.2),
 * the danger-tier ramp in biomes.dangerTierAt(), the per-band budgets and the
 * leviathan territory Poisson discs all still apply on top of it.
 *
 * @param {number} biomeId a world/biomes.js biome id, or a CREATURE_HABITAT
 *   pseudo-id (PELAGIC / CAVE / VENT)
 * @param {number} depth POSITIVE metres below sea level; negative above it
 * @returns {ReadonlyArray<object>} frozen, possibly empty, never null
 */
export function speciesForBiome(biomeId, depth) {
  const b = biomeId | 0;
  if (b < 0 || b >= HABITAT_ID_COUNT) return EMPTY;
  const bucket = Math.floor(depth / DEPTH_BUCKET);
  const key = b * 4096 + bucket;
  const hit = _forBiome.get(key);
  if (hit !== undefined) return hit;

  // Test the bucket's whole span, not its centre: a species whose range is
  // narrower than 8 m (there are none today, but Emberworm colonies come close)
  // must still appear for every depth it actually occupies.
  const lo = bucket * DEPTH_BUCKET;
  const hi = lo + DEPTH_BUCKET;
  const list = SPECIES.filter((s) =>
    s.biomes.includes(b) && s.depthRange[0] <= hi && s.depthRange[1] >= lo);
  list.sort((a, c) => (c.densityPerKm3 - a.densityPerKm3)
    || (SPECIES_INDEX[a.id] - SPECIES_INDEX[c.id]));
  const frozen = list.length ? Object.freeze(list) : EMPTY;
  _forBiome.set(key, frozen);
  return frozen;
}

/** Drop the speciesForBiome memo. Only a test that mutates the roster needs it. */
export function resetBestiaryCache() {
  _forBiome.clear();
}

/**
 * The deepest tier that may spawn at a position, given the biome's own tier.
 *
 * A species is legal only if its tier is at or below the ceiling, which is how
 * the Safe Charter's "nothing above tier 0" and the abyss's "anything" are the
 * same rule with a different argument.
 *
 * @param {number} biomeTier from biomes.dangerTierAt()
 * @param {object} species a SPECIES record
 */
export function speciesFitsTier(biomeTier, species) {
  return species.dangerTier <= biomeTier;
}

/**
 * Diel activity multiplier at a game hour, in [0, 2].
 *
 * Day is 06:00-18:00 with a 1 h civil-twilight crossfade at each end, matching
 * DESIGN/06 06.4.0's `band()` sampling of the clock. Returned as a plain lerp
 * because the spawner multiplies it into a weight and a hard edge at dawn would
 * make whole populations pop.
 *
 * @param {object} species a SPECIES record
 * @param {number} hour game hours, 0..24
 */
export function activityAt(species, hour) {
  const h = ((hour % 24) + 24) % 24;
  // Rises through 05:30-06:30, falls through 17:30-18:30.
  const dayness = h < 5.5 || h > 18.5 ? 0
    : h < 6.5 ? (h - 5.5)
      : h < 17.5 ? 1
        : 1 - (h - 17.5);
  const [day, night] = species.dayNightActivity;
  return night + (day - night) * clamp(dayness, 0, 1);
}

/**
 * Effective light affinity at a distance, per DESIGN/06 06.1.8(d).
 *
 * Three species (Lanterngape, Pale Herald, Vaultstalker - and Gloomray and
 * Umbral Squid, which the datasheets also mark `flip@Xm`) are attracted from
 * far away and repelled up close. That single sign flip is what produces "it
 * circled the light, then bolted, then came back", so it lives here rather than
 * being re-derived by every consumer.
 *
 * @param {object} species a SPECIES record
 * @param {number} distance metres to the lamp
 */
export function lightAffinityAt(species, distance) {
  const r = species.lightFlipRadius;
  if (r <= 0) return species.lightAffinity;
  return distance > r ? species.lightAffinity : -species.lightAffinity;
}
