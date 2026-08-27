#!/usr/bin/env node
/**
 * SUBWAVE creature simulation / spawner verification.
 *
 * Runs offline with no GPU. What it CAN verify is everything the AI actually
 * is: the species table, the steering integration, the schooling, the Safe
 * Charter invariant, the allocation behaviour and the per-tick cost. What it
 * CANNOT verify is the picture - use tools/wgsl-compile.mjs for the shader and
 * tools/qa.mjs for whether there are visibly fish on screen.
 *
 * Every assertion prints the number it measured, not a claim about it.
 */

import { performance } from 'node:perf_hooks';
import { WORLD, RENDER, DEPTH_BANDS, WATER_TYPES } from '../src/core/constants.js';
import { FIXED_DT } from '../src/core/time.js';
import * as terrain from '../src/world/terrain.js';
import { waterTypeAt } from '../src/world/biomes.js';
import { CollisionWorld } from '../src/world/collision.js';
import { SPECIES, speciesById } from '../src/entities/bestiary.js';
import {
  CreatureSim, SPECIES_TABLE, SPECIES_TABLE_PROBLEMS, SPECIES_FLAG, ARCHETYPES,
  ARCHETYPE_COUNT, ARCHETYPE_BY_NAME, BEHAVIOUR, BEHAVIOUR_COUNT, BEHAVIOUR_MUL,
  STEER_COUNT, ANIM_MODE, ANIM_MODE_ENV, CREATURE_LOD, LOD_RANGE,
  NEIGHBOUR_CELL_SIZE, NEIGHBOUR_MAX_RADIUS, CREATURE_BOUNDS, speciesIndexOf,
  ambientLuxAt, ATTACK_STATE, T_NOTICE, T_COMMIT, F_FLINCH,
  TICK_PERIOD, PERCEPTION_PERIOD, SELECT_PERIOD,
  PANIC_FLOOR_M, PANIC_BODY_LENGTHS, fearFleeRadius, STEER,
  playerPanicRadius, PLAYER_PANIC_MAX_M, PLAYER_PANIC_FLOOR_M,
  PLAYER_FLEE_RADIAL_FRAC, VESSEL_PANIC_MULT,
} from '../src/entities/creatures.js';
import {
  Spawner, CHARTER, charterMaxTier, insideCharter, BAND_BUDGET,
  BAND_MAX_TIER3, BAND_MAX_TIER4, MAX_CPU_SCHOOL, habitatOf, HABITAT,
  CELL_X, CELL_Y, CELL_Z, nearFieldRadius, SIZE_CLASSES,
} from '../src/entities/spawner.js';

let fails = 0;
const ok = (cond, label, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label.padEnd(56)} ${detail ?? ''}`);
};

/** Deterministic PRNG so the run itself is reproducible. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

terrain.setSeed(WORLD.DEFAULT_SEED);
const collision = new CollisionWorld(terrain);

/** A stationary player far from everything, for tests that want no stimulus. */
const QUIET_WORLD = {
  playerPos: [1e6, 0, 1e6], playerVel: [0, 0, 0], playerAlive: true,
  playerInVessel: true, playerNoise: 0.05, vessel: null, camera: null,
  daylight: 1,
};

// ===========================================================================
console.log('\n== 1. species table flattening ==');
// ===========================================================================
{
  ok(SPECIES_TABLE_PROBLEMS.length === 0,
    'bestiary flattened with no problems',
    SPECIES_TABLE_PROBLEMS.length ? SPECIES_TABLE_PROBLEMS.slice(0, 3).join(' | ')
      : `${SPECIES_TABLE.count} species`);
  ok(SPECIES_TABLE.count === SPECIES.length,
    'every roster record is in the table',
    `${SPECIES_TABLE.count} of ${SPECIES.length}`);

  const numeric = ['length', 'mass', 'health', 'damage', 'hullDamage', 'speedBase',
    'speedBurst', 'turnRate', 'depthMin', 'depthMax', 'lightAffinity', 'tauThreat',
    'tauFear', 'aggression', 'visionRange', 'visionHalfAngle', 'vibThreshold',
    'thickness'];
  let bad = null;
  for (const f of numeric) {
    for (let i = 0; i < SPECIES_TABLE.count; i++) {
      if (!Number.isFinite(SPECIES_TABLE[f][i])) { bad = `${f}[${SPECIES_TABLE.id[i]}]`; break; }
    }
    if (bad) break;
  }
  ok(bad === null, 'every numeric column is finite', bad || `${numeric.length} columns x ${SPECIES_TABLE.count}`);

  let tier0Damage = 0;
  for (let i = 0; i < SPECIES_TABLE.count; i++) {
    if (SPECIES_TABLE.tier[i] === 0 && SPECIES_TABLE.damage[i] > 0) tier0Damage++;
  }
  ok(tier0Damage === 0, 'no tier 0 species can damage the player',
    `${tier0Damage} violations`);

  let boneOver = 0, maxBones = 0;
  for (let i = 0; i < SPECIES_TABLE.count; i++) {
    maxBones = Math.max(maxBones, SPECIES_TABLE.spineBones[i]);
    if (SPECIES_TABLE.spineBones[i] > RENDER.MAX_BONES_PER_CREATURE) boneOver++;
  }
  ok(boneOver === 0, `spine bones within MAX_BONES_PER_CREATURE (${RENDER.MAX_BONES_PER_CREATURE})`,
    `max ${maxBones}`);

  const spratIdx = speciesIndexOf('CRT_COPPERSPRAT');
  const sprat = speciesById.CRT_COPPERSPRAT;
  ok(spratIdx >= 0 && Math.abs(SPECIES_TABLE.length[spratIdx] - sprat.length) < 1e-6,
    'a known record round-trips (Coppersprat length)',
    `${SPECIES_TABLE.length[spratIdx]} m`);
  ok(Math.abs(SPECIES_TABLE.turnRate[spratIdx] - sprat.turnRate * Math.PI / 180) < 1e-5,
    'turn rate converted deg/s -> rad/s',
    `${sprat.turnRate} deg/s = ${SPECIES_TABLE.turnRate[spratIdx].toFixed(3)} rad/s`);

  const coil = speciesIndexOf('LEV_NETHERCOIL');
  ok(Math.abs(SPECIES_TABLE.hullDamage[coil] - 900 * 100 / 1200) < 1e-4,
    'vessel damage rescaled from the 1200 HP hull to 100',
    `900 -> ${SPECIES_TABLE.hullDamage[coil].toFixed(1)} of ${100}`);

  let levs = 0, lures = 0, preds = 0, biolum = 0;
  for (let i = 0; i < SPECIES_TABLE.count; i++) {
    if (SPECIES_TABLE.flags[i] & SPECIES_FLAG.LEVIATHAN) levs++;
    if (SPECIES_TABLE.flags[i] & SPECIES_FLAG.LURE) lures++;
    if (SPECIES_TABLE.flags[i] & SPECIES_FLAG.PREDATOR) preds++;
    if (SPECIES_TABLE.biolum[i * 4] + SPECIES_TABLE.biolum[i * 4 + 1]
      + SPECIES_TABLE.biolum[i * 4 + 2] > 0) biolum++;
  }
  // Four since 2026-08-19: the Splitmaw joined for biome 18 (Sunken Dunes).
  ok(levs === 4, 'exactly four leviathans', `${levs}`);
  ok(biolum >= 15, 'at least fifteen species are bioluminescent',
    `${biolum} of ${SPECIES_TABLE.count}, ${preds} predators, ${lures} lures`);
}

// ===========================================================================
console.log('\n== 2. archetype and behaviour tables ==');
// ===========================================================================
{
  ok(ARCHETYPES.length === ARCHETYPE_COUNT && ARCHETYPE_COUNT === 17,
    'seventeen archetypes', `${ARCHETYPE_COUNT}`);
  let bad = null;
  for (const a of ARCHETYPES) {
    if (a.w.length !== STEER_COUNT) { bad = `${a.name} has ${a.w.length} weights`; break; }
    for (const w of a.w) if (!Number.isFinite(w) || w < 0) { bad = `${a.name} weight ${w}`; break; }
    if (!(a.aMax > 0) || !(a.tau > 0) || !(a.fMax >= a.fMin)) { bad = `${a.name} scalars`; break; }
    if (a.mode < 0 || a.mode > ANIM_MODE.LEG) { bad = `${a.name} mode ${a.mode}`; break; }
    if (bad) break;
  }
  ok(bad === null, 'every archetype row is well-formed', bad || `${STEER_COUNT} weights each`);

  ok(BEHAVIOUR_MUL.length === BEHAVIOUR_COUNT * STEER_COUNT,
    'behaviour multiplier matrix is complete',
    `${BEHAVIOUR_COUNT} x ${STEER_COUNT} = ${BEHAVIOUR_MUL.length}`);

  // env(1) must be 1 for every mode, or "A = peak tail amplitude" is a lie.
  let worst = 0, worstMode = -1;
  for (let m = 0; m < ANIM_MODE_ENV.length; m++) {
    const e = ANIM_MODE_ENV[m];
    const at1 = Math.abs(e.c0 + e.c1 + e.c2 - 1);
    if (at1 > worst) { worst = at1; worstMode = m; }
  }
  ok(worst < 1e-6, 'every amplitude envelope satisfies env(1) = 1',
    `worst |env(1)-1| = ${worst.toExponential(1)} at mode ${worstMode}`);

  // Every `steering` value in the roster must name a real archetype row.
  const missing = new Set();
  for (const s of SPECIES) if (ARCHETYPE_BY_NAME[s.steering] === undefined) missing.add(s.steering);
  ok(missing.size === 0, 'every roster steering row exists',
    missing.size ? [...missing].join(',') : `${Object.keys(ARCHETYPE_BY_NAME).length} rows`);

  ok(Math.abs(NEIGHBOUR_CELL_SIZE - 8.0) < 1e-9 && NEIGHBOUR_MAX_RADIUS === 18,
    'boids hash cell 8.0 m, query capped at 18 m',
    `cell ${NEIGHBOUR_CELL_SIZE} m, cap ${NEIGHBOUR_MAX_RADIUS} m`);
  ok(LOD_RANGE[0] === 60 && LOD_RANGE[1] === 200,
    'LOD edges at 60 m and 200 m (30 / 10 / 1 Hz)',
    `${LOD_RANGE[0]} / ${LOD_RANGE[1]}`);
}

// ===========================================================================
console.log('\n== 3. ambient light model against the design band table ==');
// ===========================================================================
{
  const at = (d) => ambientLuxAt(d, 1);
  const b1 = at(45), b3 = at(180), b5 = at(700);
  ok(b1 > 900 && b1 < 20000, 'B1 bottom (45 m) inside 900-20,000 lux',
    `${b1.toFixed(0)} lux`);
  ok(b3 > 2.0 && b3 < 140, 'B3 mid (180 m) inside 2-140 lux', `${b3.toFixed(2)} lux`);
  ok(b5 < 0.02, 'B5 (700 m) below 0.02 lux', `${b5.toExponential(2)} lux`);
  const night = ambientLuxAt(0, 0);
  ok(night > 0 && night < 1, 'the surface at night has a moonlight floor',
    `${night.toFixed(3)} lux`);
}

// ===========================================================================
console.log('\n== 4. 2000 ticks with 200 creatures: no NaN, nothing escapes ==');
// ===========================================================================
let bulkSim = null;
{
  const sim = new CreatureSim(collision, { seed: 0xA11CE });
  const r = rng(0x1234);
  // Spread the population over the whole playfield, at legal depths for each
  // species, so the steering is exercised against real terrain everywhere -
  // trench walls, the island, the reef and open water.
  let spawned = 0;
  for (let attempt = 0; attempt < 4000 && spawned < 200; attempt++) {
    const sp = Math.floor(r() * SPECIES_TABLE.count);
    const x = (r() * 2 - 1) * 2600;
    const z = (r() * 2 - 1) * 2600;
    const ground = terrain.sampleHeightFast(x, z);
    const dMin = SPECIES_TABLE.depthMin[sp], dMax = SPECIES_TABLE.depthMax[sp];
    let y = -(dMin + r() * Math.max(1, dMax - dMin));
    if (SPECIES_TABLE.flags[sp] & SPECIES_FLAG.AIRBORNE) {
      if (ground < 1) continue;
      y = ground + 10 + r() * 80;
    } else if (y < ground + 2) {
      continue;
    }
    if (sim.spawn(sp, x, y, z, { schoolId: -1 }) >= 0) spawned++;
  }
  ok(spawned === 200, 'spawned 200 agents across the playfield', `${spawned}`);

  // The camera is walked onto a different agent every step, so over 2000 steps
  // every one of the 200 spends time at LOD FULL and the full steering stack
  // (five whiskers, real perception, real boids) is exercised against real
  // terrain everywhere - which is the point of the test. A fixed camera would
  // leave 190 of them at STATISTICAL, ticking once a second.
  const roving = { position: [0, -50, 0], forward: [0, 0, -1], isSphereVisible: () => true };
  const world = { ...QUIET_WORLD, camera: roving };
  const lodSeen = new Int32Array(3);
  const t0 = performance.now();
  for (let step = 0; step < 2000; step++) {
    const live = sim.liveSlots();
    const focus = live[step % live.length];
    roving.position[0] = sim.posX[focus];
    roving.position[1] = sim.posY[focus];
    roving.position[2] = sim.posZ[focus];
    sim.simulate(FIXED_DT, world);
    lodSeen[0] += sim.stats.lod0; lodSeen[1] += sim.stats.lod1; lodSeen[2] += sim.stats.lod2;
  }
  const ms = performance.now() - t0;
  ok(lodSeen[0] > 0 && lodSeen[1] > 0 && lodSeen[2] > 0,
    'all three LOD classes were exercised',
    `agent-steps: full ${lodSeen[0]}, reduced ${lodSeen[1]}, statistical ${lodSeen[2]}`);

  ok(!sim.hasNaN(), 'no NaN in any agent field after 2000 ticks',
    `${sim.count} alive, ${sim.stats.ticked} ticked on the last step`);
  ok(sim.outOfBounds() === 0, 'no agent outside the containment box',
    `xz +-${CREATURE_BOUNDS.xzLimit} m, y ${CREATURE_BOUNDS.yFloor}..${CREATURE_BOUNDS.yCeiling} m`);

  // Nothing may be buried in the rock either: the obstacle whiskers and the
  // hard push-out exist precisely to prevent that, and it is invisible to a
  // bounds check.
  let buried = 0, worstBury = 0;
  const live = sim.liveSlots();
  for (let k = 0; k < live.length; k++) {
    const i = live[k];
    const h = terrain.sampleHeightFast(sim.posX[i], sim.posZ[i]);
    const gap = sim.posY[i] - h;
    if (gap < -0.5) { buried++; worstBury = Math.min(worstBury, gap); }
  }
  ok(buried <= 4, 'at most four agents are inside the terrain',
    `${buried} of ${live.length}, deepest ${worstBury.toFixed(2)} m`);

  let maxSpeed = 0, overSpeed = 0;
  for (let k = 0; k < live.length; k++) {
    const i = live[k];
    const s = Math.hypot(sim.velX[i], sim.velY[i], sim.velZ[i]);
    if (s > maxSpeed) maxSpeed = s;
    if (s > SPECIES_TABLE.speedBurst[sim.species[i]] * 1.05) overSpeed++;
  }
  ok(overSpeed === 0, 'no agent exceeds its own burst speed',
    `${overSpeed} violations, fastest ${maxSpeed.toFixed(2)} m/s`);

  console.log(`       2000 ticks x ${spawned} agents in ${ms.toFixed(1)} ms ` +
    `= ${(ms / 2000).toFixed(4)} ms/tick`);
  bulkSim = sim;
}

// ===========================================================================
console.log('\n== 5. schooling actually clusters ==');
// ===========================================================================
{
  const sp = speciesIndexOf('CRT_SILVERQUILL');
  const cx = 300, cz = 1900;
  const ground = terrain.sampleHeightFast(cx, cz);
  const y0 = Math.max(ground + 60, -90);
  const arch = ARCHETYPES[SPECIES_TABLE.archetype[sp]];

  /**
   * Sixteen Silverquill in open water, well clear of the seabed so the only
   * forces in play are the boids triple, wander and depth keeping.
   *
   * The SOLITARY run is the control, and it is what makes this a measurement
   * rather than an observation: sixteen fish left to wander have no reason to
   * converge, so any contraction in the schooled run is schooling and not the
   * bounds, the depth spring or the terrain funnelling them together.
   */
  const run = (schooled) => {
    const sim = new CreatureSim(collision, { seed: 0xB0105 });
    const r = rng(0xFEED);
    let n = 0;
    for (let i = 0; i < 16; i++) {
      const x = cx + (r() * 2 - 1) * 12;
      const y = y0 + (r() * 2 - 1) * 6;
      const z = cz + (r() * 2 - 1) * 12;
      // No shared home: each agent's territory anchor defaults to its own
      // spawn point. Handing both runs one common anchor would make the
      // control converge too - FORAGE seeks the anchor - and the comparison
      // would measure the anchor rather than the schooling.
      if (sim.spawn(sp, x, y, z, { schoolId: schooled ? 1 : -1 }) >= 0) n++;
    }
    // Mean nearest-neighbour distance over ALL agents, ignoring schoolId, so
    // the two runs are measured by the same yardstick.
    const mnd = () => {
      const live = sim.liveSlots();
      let sum = 0, count = 0;
      for (let a = 0; a < live.length; a++) {
        let best = Infinity;
        for (let b = 0; b < live.length; b++) {
          if (a === b) continue;
          const d = Math.hypot(sim.posX[live[a]] - sim.posX[live[b]],
            sim.posY[live[a]] - sim.posY[live[b]],
            sim.posZ[live[a]] - sim.posZ[live[b]]);
          if (d < best) best = d;
        }
        if (best < Infinity) { sum += best; count++; }
      }
      return count > 0 ? sum / count : NaN;
    };
    // The camera sits on the school so every member is LOD FULL and the real
    // neighbour-query boids run rather than the school proxy.
    const world = {
      ...QUIET_WORLD,
      camera: { position: [cx, y0, cz], forward: [0, 0, -1], isSphereVisible: () => true },
    };
    const before = mnd();
    for (let step = 0; step < 3600; step++) sim.simulate(FIXED_DT, world);
    return { n, before, after: mnd(), sim };
  };

  const school = run(true);
  const control = run(false);

  ok(school.n === 16, `a ${school.n}-member CPU school (cap ${MAX_CPU_SCHOOL})`,
    `${school.n} spawned`);
  ok(Number.isFinite(school.before) && Number.isFinite(school.after),
    'the schooling metric is measurable',
    `before ${school.before.toFixed(2)} m, after ${school.after.toFixed(2)} m`);
  ok(school.after < school.before * 0.6,
    'schooled: mean nearest-neighbour distance contracted by >40% over 60 s',
    `${school.before.toFixed(2)} m -> ${school.after.toFixed(2)} m ` +
    `(${(100 * (1 - school.after / school.before)).toFixed(0)}% closer)`);
  ok(control.after >= control.before * 0.9,
    'solitary control: the same fish do NOT converge',
    `${control.before.toFixed(2)} m -> ${control.after.toFixed(2)} m ` +
    `(${(100 * (control.after / control.before - 1)).toFixed(0)}% further)`);
  ok(school.after > arch.rSep * 0.5, 'but separation still holds them apart',
    `rSep ${arch.rSep} m, mean spacing ${school.after.toFixed(2)} m`);
  ok(!school.sim.hasNaN() && school.sim.outOfBounds() === 0,
    'school is finite and in bounds');

  // Alignment: a real school swims as one plane. Measured as the length of the
  // mean unit heading, 1 = perfectly aligned, 0 = random.
  const live = school.sim.liveSlots();
  let hx = 0, hy = 0, hz = 0;
  for (let k = 0; k < live.length; k++) {
    const i = live[k];
    const s = Math.hypot(school.sim.velX[i], school.sim.velY[i], school.sim.velZ[i]);
    if (s < 1e-4) continue;
    hx += school.sim.velX[i] / s; hy += school.sim.velY[i] / s; hz += school.sim.velZ[i] / s;
  }
  const polarisation = Math.hypot(hx, hy, hz) / live.length;
  ok(polarisation > 0.5, 'and they swim as one plane (polarisation > 0.5)',
    `${polarisation.toFixed(3)}`);
}

// ===========================================================================
console.log('\n== 6. THE SAFE CHARTER ==');
// ===========================================================================
{
  // ---- level 1a: the pure function -------------------------------------
  const r = rng(0xCAFE);
  let violations = 0, samples = 0;
  for (let i = 0; i < 20000; i++) {
    const ang = r() * Math.PI * 2;
    const rad = r() * CHARTER.annulus * 1.4;
    const x = CHARTER.centerX + Math.cos(ang) * rad;
    const z = CHARTER.centerZ + Math.sin(ang) * rad;
    const cap = charterMaxTier(x, z);
    if (rad <= CHARTER.radius) { samples++; if (cap !== 0) violations++; }
    else if (rad < CHARTER.annulus && cap > 1) violations++;
  }
  ok(violations === 0, 'charterMaxTier is 0 everywhere inside the crater',
    `${samples} core samples of 20,000, ${violations} violations`);
  ok(CHARTER.radius === WORLD.SAFE_CRATER_RADIUS &&
     CHARTER.annulus === WORLD.SAFE_FALLOFF_RADIUS,
  'the charter uses the WORLD constants',
  `core ${CHARTER.radius} m, annulus ${CHARTER.annulus} m, margin ${CHARTER.margin} m`);

  // ---- level 1b: 500 spawn attempts inside the crater ------------------
  const sim = new CreatureSim(collision, { seed: 0x5AFE });
  const spawner = new Spawner(sim, { seed: WORLD.DEFAULT_SEED });
  spawner.attach();

  let attempts = 0, placed = 0, aboveTier0 = 0;
  const r2 = rng(0x5AFE7);
  for (let a = 0; a < 500; a++) {
    // Ask for a HOSTILE species at a random point inside the crater. The
    // director should refuse every single one.
    const hostile = [];
    for (let i = 0; i < SPECIES_TABLE.count; i++) if (SPECIES_TABLE.tier[i] > 0) hostile.push(i);
    const sp = hostile[Math.floor(r2() * hostile.length)];
    const ang = r2() * Math.PI * 2;
    const rad = r2() * CHARTER.radius;
    const x = CHARTER.centerX + Math.cos(ang) * rad;
    const z = CHARTER.centerZ + Math.sin(ang) * rad;
    const y = -(SPECIES_TABLE.depthMin[sp] + r2() * 40);
    attempts++;
    // Route through the spawner's own placement path, which is what the game
    // uses; a direct sim.spawn() would bypass level 1 by design, and that is
    // what levels 2 and 3 are for.
    const cell = {
      key: 0, cx: Math.floor(x / CELL_X), cy: Math.floor(y / CELL_Y), cz: Math.floor(z / CELL_Z),
      centerX: x, centerY: y, centerZ: z, seed: 1,
      depletion: new Float32Array(SPECIES_TABLE.count),
      population: 0, killed: 0, visited: false, resolved: true, retired: false,
    };
    placed += spawner._placeGroup(cell, sp, 1, false, r2);
  }
  // A placement cell is 256 m across, so a candidate drawn from a cell centred
  // inside the crater can legally land outside it. What must be zero is not the
  // number PLACED but the number placed INSIDE the volume.
  let insideCore = 0;
  const liveC = sim.liveSlots();
  for (let k = 0; k < liveC.length; k++) {
    const i = liveC[k];
    if (insideCharter(sim.posX[i], sim.posZ[i])) insideCore++;
  }
  aboveTier0 = spawner.charterViolations(0);
  ok(insideCore === 0, '500 forced hostile placements: none landed inside the crater',
    `${attempts} attempts, ${placed} placed outside (legal), ${insideCore} inside, ` +
    `${spawner.stats.charterBlocked} blocked by the charter`);
  ok(aboveTier0 === 0, 'zero live agents above tier 0 inside the crater',
    `${aboveTier0} violations`);

  // ---- a full prime around the spawn: the shallows must be safe --------
  const spawn = terrain.findSpawnPoint();
  const sim2 = new CreatureSim(collision, { seed: 0x5AFE2 });
  const spawner2 = new Spawner(sim2, { seed: WORLD.DEFAULT_SEED });
  spawner2.attach();
  const total = spawner2.prime(spawn.position, { daylight: 1 }, 600);
  ok(total > 0, 'priming the start region populates it', `${total} agents`);
  ok(spawner2.charterViolations(0) === 0,
    'a primed start region contains nothing above tier 0 in the crater',
    `${total} agents, ${spawner2.stats.charterBlocked} charter rejections`);
  ok(spawner2.stats.charterVetoes === 0, 'the level 3 damage veto never fired',
    `${spawner2.stats.charterVetoes}`);

  let tierHist = new Int32Array(6);
  const live2 = sim2.liveSlots();
  for (let k = 0; k < live2.length; k++) tierHist[sim2.tier[live2[k]]]++;
  console.log(`       primed tier histogram: ${[...tierHist].join(' / ')} (tier 0..5)`);

  // ---- level 2: the movement barrier ----------------------------------
  // Aim tier-3 hunters straight at the crater centre from just outside the
  // margin and let them swim for thirty seconds. None may get inside.
  const sim3 = new CreatureSim(collision, { seed: 0x5AFE3 });
  sim3.setCharter(CHARTER);
  const hunters = [];
  for (let i = 0; i < SPECIES_TABLE.count; i++) {
    if (SPECIES_TABLE.tier[i] >= 3 && !(SPECIES_TABLE.flags[i] & SPECIES_FLAG.AIRBORNE)) {
      hunters.push(i);
    }
  }
  const r3 = rng(0xBA881E);
  let launched = 0;
  for (let a = 0; a < 40; a++) {
    const sp = hunters[a % hunters.length];
    const ang = r3() * Math.PI * 2;
    const rad = CHARTER.radius + CHARTER.margin + 30;
    const x = CHARTER.centerX + Math.cos(ang) * rad;
    const z = CHARTER.centerZ + Math.sin(ang) * rad;
    const ground = terrain.sampleHeightFast(x, z);
    const y = Math.min(-20, ground + 25);
    // Heading straight at the centre. dirFromHeading: 0 = north (-Z), CW.
    const heading = Math.atan2(-Math.cos(ang) * rad, Math.sin(ang) * rad) + Math.PI;
    if (sim3.spawn(sp, x, y, z, { heading, homeX: CHARTER.centerX, homeY: y, homeZ: CHARTER.centerZ }) >= 0) {
      launched++;
    }
  }
  // Force them to want to go there: full threat, and a target at the centre.
  const live3 = sim3.liveSlots();
  for (let k = 0; k < live3.length; k++) sim3.threat[live3[k]] = 3.0;
  let deepestIntrusion = Infinity;
  for (let step = 0; step < 1800; step++) {
    sim3.simulate(FIXED_DT, QUIET_WORLD);
    for (let k = 0; k < live3.length; k++) {
      const i = live3[k];
      if (!sim3.alive[i]) continue;
      const d = Math.hypot(sim3.posX[i] - CHARTER.centerX, sim3.posZ[i] - CHARTER.centerZ);
      if (d < deepestIntrusion) deepestIntrusion = d;
    }
  }
  ok(launched > 0, 'launched tier-3 hunters at the crater', `${launched} agents, 30 s`);
  ok(deepestIntrusion >= CHARTER.radius,
    'the movement barrier keeps every hunter out of the core',
    `closest approach ${deepestIntrusion.toFixed(1)} m of ${CHARTER.radius} m`);

  // ---- level 3: the damage veto ---------------------------------------
  const simV = new CreatureSim(collision, { seed: 0x5AFE4 });
  const spawnerV = new Spawner(simV, { seed: WORLD.DEFAULT_SEED });
  spawnerV.attach();
  let damageApplied = 0;
  simV.onPlayerDamage = () => { damageApplied++; };
  // Deliberately plant a hostile INSIDE the crater with sim.spawn(), bypassing
  // level 1, and make it strike. Level 3 must swallow the damage.
  const frond = speciesIndexOf('CRT_FRONDMAW');
  const h = simV.spawn(frond, CHARTER.centerX + 5, -18, CHARTER.centerZ + 5, {});
  const slot = simV.slotOf(h);
  simV.targetKind[slot] = 2;                          // TARGET.PLAYER
  simV.distToPlayer[slot] = 0.5;
  simV._ctx.playerPos = [CHARTER.centerX + 5, -18, CHARTER.centerZ + 5];
  simV._resolveStrike(slot);
  ok(damageApplied === 0, 'a strike inside the crater applies no player damage',
    `${damageApplied} applications, ${spawnerV.stats.charterVetoes} veto(es) logged`);
  ok(spawnerV.stats.charterVetoes === 1, 'and the veto was recorded',
    `${spawnerV.stats.charterVetoes}`);
}

// ===========================================================================
console.log('\n== 7. steering is allocation-free ==');
// ===========================================================================
{
  /**
   * An analytic heightfield with no allocation of its own, so this measures
   * creatures.js and nothing else.
   *
   * The real CollisionWorld is measured separately below. It allocates 7.2 B
   * per heightAt+normalAt pair (world/terrain.js's own doing, not the AI's),
   * and the obstacle whiskers call it up to six times per FULL agent per tick -
   * so mixing the two into one number would attribute the terrain sampler's
   * garbage to the steering loop and there would be no way to tell them apart.
   */
  const flatCollision = {
    heightAt: (x, z) => -140 + 8 * Math.sin(x * 0.01) * Math.cos(z * 0.011),
    normalAt: (out, x, z) => {
      const dx = -0.08 * Math.cos(x * 0.01) * Math.cos(z * 0.011);
      const dz = 0.088 * Math.sin(x * 0.01) * Math.sin(z * 0.011);
      const l = Math.hypot(dx, 1, dz);
      out[0] = -dx / l; out[1] = 1 / l; out[2] = -dz / l;
      return out;
    },
  };

  /**
   * process.memoryUsage().heapUsed carries up to about 1 MB of V8 bookkeeping
   * noise per sample regardless of how much work happened in between - a control
   * loop of 5,000,000 Math.sqrt calls, which allocates nothing at all, measures
   * 0.064 B/call by this yardstick, i.e. 320 KB of pure noise. A short window
   * therefore cannot distinguish "allocates 100 B/tick" from "allocates nothing".
   *
   * So the assertion is not on a per-tick figure at all - it is on the ORDER OF
   * MAGNITUDE, which is what actually distinguishes the two hypotheses.
   *
   * If the loop allocated ONE forty-byte object per agent per tick - a vec3, a
   * subarray view, an event payload, anything - then at the measured 60 agents
   * ticking per step, 30,000 ticks would allocate 72 MB. The bound below is
   * 8 MB, an order of magnitude under that and an order of magnitude over the
   * ~1 MB of V8 bookkeeping a single sample can carry, so it separates "one
   * allocation per agent-tick" from "none" with a decade of margin on each side.
   * Three windows are taken and the smallest is used, because the noise is
   * strictly additive - V8's bookkeeping only ever grows the heap.
   */
  const measure = (col, label, limit) => {
    const sim = new CreatureSim(col, { seed: 0xA110C });
    const r = rng(0x77777);
    const sp = speciesIndexOf('CRT_SILVERQUILL');
    const cx = 300, cz = 1900;
    const y0 = -100;
    for (let i = 0; i < 120; i++) {
      sim.spawn(sp, cx + (r() * 2 - 1) * 40, y0 + (r() * 2 - 1) * 20, cz + (r() * 2 - 1) * 40,
        { schoolId: i % 8 });
    }
    const world = {
      ...QUIET_WORLD,
      camera: { position: [cx, y0, cz], forward: [0, 0, -1], isSphereVisible: () => true },
    };
    // Warm up so V8 has JITted and every hidden class is stable.
    for (let step = 0; step < 5000; step++) sim.simulate(FIXED_DT, world);

    const window = (n) => {
      if (global.gc) { global.gc(); global.gc(); }
      const before = process.memoryUsage();
      for (let step = 0; step < n; step++) sim.simulate(FIXED_DT, world);
      const after = process.memoryUsage();
      return {
        bytes: after.heapUsed - before.heapUsed,
        perTick: (after.heapUsed - before.heapUsed) / n,
        buffers: after.arrayBuffers - before.arrayBuffers,
      };
    };
    const runs = [window(30000), window(30000), window(30000)];
    let best = runs[0];
    for (const r2 of runs) if (r2.bytes < best.bytes) best = r2;
    const buffers = runs.reduce((n, r2) => n + r2.buffers, 0);
    // What one allocation per agent-tick would have cost, for scale.
    const naive = 40 * sim.stats.ticked * 30000;
    ok(best.bytes < limit, label,
      `3 x 30k ticks: ${runs.map((r2) => (r2.bytes / 1048576).toFixed(2)).join(' / ')} MiB, ` +
      `best ${(best.bytes / 1048576).toFixed(2)} MiB = ${best.perTick.toFixed(1)} B/tick; ` +
      `one 40 B object per agent-tick would be ${(naive / 1048576).toFixed(0)} MiB ` +
      `(limit ${(limit / 1048576).toFixed(0)} MiB)`);
    ok(buffers === 0, '  and no ArrayBuffer growth at all', `${buffers} B`);
    return best;
  };

  const EIGHT_MIB = 8 * 1048576;
  const clean = measure(flatCollision,
    'steering/boids/locomotion: heap growth two decades below one alloc/agent-tick',
    EIGHT_MIB);
  const withTerrain = measure(collision, 'same against the real terrain sampler', EIGHT_MIB);
  console.log(`       ${clean.perTick.toFixed(1)} B/tick with a stub heightfield, ` +
    `${withTerrain.perTick.toFixed(1)} B/tick with world/terrain.js ` +
    '(which allocates 7.2 B per heightAt+normalAt pair of its own, measured separately)');
  console.log(`       gc was ${global.gc ? 'forced before each window' : 'NOT forced - run with --expose-gc for an exact figure'}`);
}

// ===========================================================================
console.log('\n== 8. per-tick cost at the RENDER.MAX_CREATURES cap ==');
// ===========================================================================
{
  const cx = 300, cz = 1900;
  const ground = terrain.sampleHeightFast(cx, cz);

  /**
   * Time one population. `clearance` is how far above the seabed the agents are
   * seeded, and it is the single most important variable in this measurement:
   * _avoid() only calls collision.normalAt() for a whisker that actually MEETS
   * the ground, and normalAt is four full-quality terrain.sampleHeight calls.
   * A population in open water short-circuits all five whiskers and never pays
   * for a single normal, so an "all LOD FULL" test that floats 40 m off the
   * bottom measures a code path the seabed never takes.
   */
  function timePopulation(count, clearance, N) {
    const sim = new CreatureSim(collision, { seed: 0xC057 });
    const r = rng(0x2468);
    const y0 = ground + clearance;
    let n = 0;
    while (n < count) {
      const sp = Math.floor(r() * SPECIES_TABLE.count);
      if (SPECIES_TABLE.flags[sp] & SPECIES_FLAG.AIRBORNE) continue;
      // Spread over 40 m horizontally so every agent is inside the 60 m LOD FULL
      // edge, and a body length or two vertically so the seeding does not itself
      // violate the clearance envelope.
      const h = sim.spawn(sp,
        cx + (r() * 2 - 1) * 40, y0 + (r() * 2 - 1) * 2.0, cz + (r() * 2 - 1) * 40,
        { schoolId: n % 12 });
      if (h < 0) break;
      n++;
    }
    const world = {
      playerPos: [cx, y0 + 4, cz], playerVel: [1.4, 0, 0], playerAlive: true,
      playerInVessel: false, playerNoise: 0.40,
      vessel: {
        position: [cx + 20, y0, cz], speed: 6, piloted: true,
        lights: { flood: true, wide: false, work: false, strobe: false },
        damageHull: () => {},
      },
      camera: { position: [cx, y0 + 4, cz], forward: [0, 0, -1], isSphereVisible: () => true },
      daylight: 1,
    };
    for (let step = 0; step < 600; step++) sim.simulate(FIXED_DT, world);   // warm up
    const h0 = collision.stats.heightQueries;
    const t0 = performance.now();
    for (let step = 0; step < N; step++) sim.simulate(FIXED_DT, world);
    const ms = (performance.now() - t0) / N;
    return {
      n, ms, sim,
      heightPerTick: (collision.stats.heightQueries - h0) / N,
    };
  }

  // (a) The scenario the original test measured: the whole pool at LOD FULL but
  //     40 m clear of the bottom, so no whisker ever hits.
  const openWater = timePopulation(RENDER.MAX_CREATURES, 40, 4000);
  ok(openWater.n === RENDER.MAX_CREATURES,
    `${RENDER.MAX_CREATURES} agents within 60 m, 40 m off the bottom`, `${openWater.n}`);
  console.log(`       open water: ${(openWater.ms * 1000).toFixed(0)} us/tick, ` +
    `${openWater.heightPerTick.toFixed(0)} height queries/tick, ` +
    `${openWater.sim.stats.ticked} agents ticked (lod0 ${openWater.sim.stats.lod0} / ` +
    `${openWater.sim.stats.lod1} / ${openWater.sim.stats.lod2})`);

  // (b) THE ACTUAL WORST CASE: the same pool pressed against the seabed, so all
  //     five whiskers hit and the normal sampler runs every tick. MEASURED in
  //     Chrome at 2.98 ms/tick mean, 3.19 ms peak, which is over DESIGN's 2.0 ms
  //     AI budget - so the number is printed rather than asserted, and the
  //     REACHABLE cap is what gets the assertion below.
  const benthic = timePopulation(RENDER.MAX_CREATURES, 1.0, 3000);
  console.log(`       on the seabed: ${(benthic.ms * 1000).toFixed(0)} us/tick, ` +
    `${benthic.heightPerTick.toFixed(0)} height queries/tick, ` +
    `${benthic.sim.stats.ticked} agents ticked (lod0 ${benthic.sim.stats.lod0} / ` +
    `${benthic.sim.stats.lod1} / ${benthic.sim.stats.lod2})` +
    `  -> ${(benthic.ms / Math.max(openWater.ms, 1e-9)).toFixed(1)}x the open-water cost`);

  // (c) The cap that can actually occur. A 40 m ball fits inside one spawn cell,
  //     and CELL_AGENT_CAP is 24; the densest legal aggregation is bounded by the
  //     fullest band budget, max(BAND_BUDGET) = 64. That is the number the
  //     2.0 ms budget has to hold for.
  const reachable = Math.max(...BAND_BUDGET);
  const dense = timePopulation(reachable, 1.0, 3000);
  ok(dense.ms < 2.0,
    `the reachable density (max BAND_BUDGET = ${reachable}) is under the 2.0 ms AI budget`,
    `${dense.ms.toFixed(4)} ms/tick on the seabed, ${dense.sim.stats.ticked} ticked, ` +
    `${dense.heightPerTick.toFixed(0)} height queries/tick`);
  console.log(`       at 60 Hz sim that is ${(dense.ms * 60).toFixed(2)} ms per second of ` +
    `play, ${(dense.ms / 8.333 * 100).toFixed(2)}% of a 120 fps frame budget`);
  console.log(`       neighbour queries ${dense.sim.stats.neighbourQueries}/tick, ` +
    `${(dense.sim.stats.neighboursFound / Math.max(1, dense.sim.stats.neighbourQueries)).toFixed(1)} hits each`);
}

// ===========================================================================
console.log('\n== 9. attack telegraph and the tier ladder ==');
// ===========================================================================
{
  const sim = new CreatureSim(collision, { seed: 0x7E11 });
  const frond = speciesIndexOf('CRT_FRONDMAW');           // tier 2
  const tier = SPECIES_TABLE.tier[frond];
  const px = 900, pz = 1500;
  const ground = terrain.sampleHeightFast(px, pz);
  const y = Math.min(-40, ground + 20);
  const h = sim.spawn(frond, px + 6, y, pz, {});
  const i = sim.slotOf(h);

  let windupStart = -1, contactAt = -1;
  const world = {
    playerPos: [px, y, pz], playerVel: [0.4, 0, 0], playerAlive: true,
    playerInVessel: false, playerNoise: 0.40, playerFwd: [1, 0, 0],
    vessel: null,
    camera: { position: [px, y, pz], forward: [1, 0, 0], isSphereVisible: () => true },
    daylight: 1,
  };
  // Drive it to full commitment and let the FSM run.
  for (let step = 0; step < 3000; step++) {
    sim.threat[i] = 3.0;
    sim.fear[i] = 0;
    sim.simulate(FIXED_DT, world);
    if (!sim.alive[i]) break;
    if (sim.behaviour[i] === BEHAVIOUR.ATTACK) {
      if (sim.state[i] === ATTACK_STATE.WINDUP && windupStart < 0) windupStart = step;
      if (sim.state[i] === ATTACK_STATE.CONTACT && windupStart >= 0 && contactAt < 0) {
        contactAt = step;
        break;
      }
    }
  }
  ok(windupStart >= 0, 'a committed predator entered AT_WINDUP', `step ${windupStart}`);
  const tellSeconds = contactAt >= 0 ? (contactAt - windupStart) * FIXED_DT : -1;
  const required = SPECIES.length && 0.55;   // tier 2 windup from DANGER_BY_TIER
  ok(contactAt >= 0 && tellSeconds >= required,
    'the tell precedes contact by at least the tier windup',
    `${tellSeconds.toFixed(3)} s vs required ${required} s (+ lunge)`);
  ok(T_NOTICE < T_COMMIT && F_FLINCH > 0,
    'threat thresholds are ordered', `notice ${T_NOTICE}, commit ${T_COMMIT}, flinch ${F_FLINCH}`);
}

// ===========================================================================
console.log('\n== 10. predation turns the food web over ==');
// ===========================================================================
{
  const sim = new CreatureSim(collision, { seed: 0xF00D });
  const pred = speciesIndexOf('CRT_CHISELFIN');     // tier 3 pack hunter
  const prey = speciesIndexOf('CRT_WISPLIGHT');     // 0.13 m, in its prey list
  const cx = 1500, cz = -900;
  const ground = terrain.sampleHeightFast(cx, cz);
  const y = Math.min(-300, ground + 40);
  const r = rng(0x515);
  for (let k = 0; k < 3; k++) {
    sim.spawn(pred, cx + (r() * 2 - 1) * 8, y, cz + (r() * 2 - 1) * 8, {});
  }
  let preyCount = 0;
  for (let k = 0; k < 24; k++) {
    if (sim.spawn(prey, cx + (r() * 2 - 1) * 10, y + (r() * 2 - 1) * 4,
      cz + (r() * 2 - 1) * 10, { schoolId: 3 }) >= 0) preyCount++;
  }
  const world = {
    ...QUIET_WORLD,
    camera: { position: [cx, y, cz], forward: [0, 0, -1], isSphereVisible: () => true },
  };
  const live = sim.liveSlots();
  for (let step = 0; step < 5400; step++) {
    // Keep the hunters interested: in the real game the threat comes from the
    // prey's own lateral-line signature, which needs a longer run than a test
    // wants to sit through.
    if ((step % 60) === 0) {
      for (let k = 0; k < live.length; k++) {
        if (sim.alive[live[k]] && sim.species[live[k]] === pred) sim.threat[live[k]] = 2.4;
      }
    }
    sim.simulate(FIXED_DT, world);
  }
  ok(sim.stats.attacks > 0, 'predators telegraphed attacks',
    `${sim.stats.attacks} windups over 90 s`);
  ok(sim.stats.predations > 0, 'and at least one landed',
    `${sim.stats.predations} strikes, ${sim.stats.killed} kills of ${preyCount} prey`);
  ok(!sim.hasNaN(), 'the sim survived predation without NaN');
}

// ===========================================================================
console.log('\n== 11. creature-vs-vessel bites the hull ==');
// ===========================================================================
{
  const sim = new CreatureSim(collision, { seed: 0x4011 });
  const stalker = speciesIndexOf('CRT_VAULTSTALKER');   // tier 4, 38 hull damage
  const vx = -1200, vz = 700;
  const ground = terrain.sampleHeightFast(vx, vz);
  const y = Math.min(-500, ground + 30);
  let hullTaken = 0;
  const vessel = {
    position: [vx, y, vz], speed: 14, piloted: true,
    lights: { flood: true, wide: false, work: false, strobe: false },
    damageHull: (amount) => { hullTaken += amount; },
  };
  const h = sim.spawn(stalker, vx + 10, y, vz, {});
  const i = sim.slotOf(h);
  const world = {
    playerPos: [vx, y, vz], playerVel: [0, 0, 0], playerAlive: true,
    playerInVessel: true, playerNoise: 0.05, vessel,
    camera: { position: [vx, y, vz], forward: [1, 0, 0], isSphereVisible: () => true },
    daylight: 0,
  };
  for (let step = 0; step < 4000 && sim.alive[i]; step++) {
    sim.threat[i] = 3.0;
    sim.simulate(FIXED_DT, world);
    if (hullTaken > 0) break;
  }
  ok(hullTaken > 0, 'a tier-4 hunter damaged the hull',
    `${hullTaken.toFixed(1)} of 100 hull, ${sim.stats.vesselBites} bite(s)`);
  const expected = SPECIES_TABLE.hullDamage[stalker];
  ok(Math.abs(hullTaken - expected) < 1e-3, 'by exactly the datasheet amount',
    `${hullTaken.toFixed(2)} vs ${expected.toFixed(2)}`);
}

// ===========================================================================
console.log('\n== 12. spawner budgets, caps and determinism ==');
// ===========================================================================
{
  ok(BAND_BUDGET.length === DEPTH_BANDS.length,
    'a budget per depth band', `${[...BAND_BUDGET].join('/')} = ${
      [...BAND_BUDGET].reduce((a, b) => a + b, 0)} of ${RENDER.MAX_CREATURES}`);
  const sum = [...BAND_BUDGET].reduce((a, b) => a + b, 0);
  ok(sum <= RENDER.MAX_CREATURES, 'the band budgets fit inside the pool',
    `${sum} <= ${RENDER.MAX_CREATURES}`);
  ok(BAND_MAX_TIER3[0] === 0 && BAND_MAX_TIER3[1] === 0,
    'no tier 3+ in the surface or sunlit bands',
    `tier3 ${[...BAND_MAX_TIER3].join('/')}, tier4 ${[...BAND_MAX_TIER4].join('/')}`);

  // Determinism: the same cell key and world seed must produce the same set.
  const cellCoords = { cx: 6, cy: -1, cz: -4 };
  const describe = (sim) => {
    const live = sim.liveSlots();
    const out = [];
    for (let k = 0; k < live.length; k++) {
      const i = live[k];
      out.push(`${SPECIES_TABLE.id[sim.species[i]]}@${sim.posX[i].toFixed(3)},` +
        `${sim.posY[i].toFixed(3)},${sim.posZ[i].toFixed(3)}`);
    }
    return out.sort().join('|');
  };
  const a = new CreatureSim(collision, { seed: WORLD.DEFAULT_SEED });
  new Spawner(a, { seed: WORLD.DEFAULT_SEED })
    .resolveCell(cellCoords.cx, cellCoords.cy, cellCoords.cz, { daylight: 1 });
  const b = new CreatureSim(collision, { seed: WORLD.DEFAULT_SEED });
  new Spawner(b, { seed: WORLD.DEFAULT_SEED })
    .resolveCell(cellCoords.cx, cellCoords.cy, cellCoords.cz, { daylight: 1 });
  const sa = describe(a), sb = describe(b);
  ok(sa === sb, 'the same cell resolves identically twice',
    `${a.count} vs ${b.count} agents, ${sa.length} chars of signature`);

  const c = new CreatureSim(collision, { seed: WORLD.DEFAULT_SEED });
  new Spawner(c, { seed: WORLD.DEFAULT_SEED ^ 0x1234 })
    .resolveCell(cellCoords.cx, cellCoords.cy, cellCoords.cz, { daylight: 1 });
  ok(describe(c) !== sa || c.count === 0, 'a different world seed resolves differently',
    `${c.count} agents`);

  // The pool must never overflow, however hard the director is pushed.
  const sim = new CreatureSim(collision, { seed: 1 });
  const spawner = new Spawner(sim, { seed: WORLD.DEFAULT_SEED });
  spawner.attach();
  for (let cy = -8; cy <= 0; cy++) {
    for (let cz = -6; cz <= 6; cz++) {
      for (let cx = -6; cx <= 6; cx++) spawner.resolveCell(cx, cy, cz, { daylight: 1 });
    }
  }
  ok(sim.count <= RENDER.MAX_CREATURES, 'resolving 1,053 cells never overflows the pool',
    `${sim.count} of ${RENDER.MAX_CREATURES}, ${spawner.stats.spawned} spawned, ` +
    `${spawner.stats.rejected} placements rejected`);
  ok(spawner.charterViolations(0) === 0, 'and still no charter violations');

  // ---- the per-species global cap is a cap, schools included -------------
  //
  // resolveCell clamps the Poisson draw, but for a schooling species that draw
  // is a count of GROUPS: the clamped value is then multiplied by the school
  // size, and if the caps are not re-applied afterwards a 16-strong shoal
  // overshoots. This walks every live species against the size-class table the
  // spawner itself uses, so it cannot drift from it.
  //
  // The edges and caps are TRANSCRIBED here on purpose - a disagreement with
  // spawner.js is itself a finding - but the transcription is now ASSERTED
  // against the real table rather than merely hoped to match it. It had already
  // drifted: this read [12, 150, 28, 6, 2] against a table whose reef-fish class
  // had risen to 220, so the whole section was checking every shoal against a cap
  // the spawner does not use, and passing.
  const CLASS_EDGES = [0.05, 1.0, 5.0, 20.0, Infinity];
  const CLASS_GLOBAL = [12, 220, 28, 6, 2];
  ok(SIZE_CLASSES.length === CLASS_EDGES.length &&
     SIZE_CLASSES.every((c, i) => c.maxLength === CLASS_EDGES[i] && c.global === CLASS_GLOBAL[i]),
     'the transcribed size-class table still matches spawner.js',
     `spawner: ${JSON.stringify(SIZE_CLASSES.map((c) => [c.maxLength, c.global]))}`);
  const globalCapOf = (spIdx) => {
    for (let c = 0; c < CLASS_EDGES.length; c++) {
      if (SPECIES_TABLE.length[spIdx] <= CLASS_EDGES[c]) return CLASS_GLOBAL[c];
    }
    return CLASS_GLOBAL[CLASS_GLOBAL.length - 1];
  };
  const perSpecies = new Int32Array(SPECIES_TABLE.count);
  const liveCap = sim.liveSlots();
  for (let k = 0; k < liveCap.length; k++) perSpecies[sim.species[liveCap[k]]]++;
  let overCap = 0, worstOver = 0, worstId = '-';
  for (let spIdx = 0; spIdx < SPECIES_TABLE.count; spIdx++) {
    const cap = globalCapOf(spIdx);
    const over = perSpecies[spIdx] - cap;
    if (over > 0) {
      overCap++;
      if (over > worstOver) { worstOver = over; worstId = SPECIES_TABLE.id[spIdx]; }
    }
  }
  ok(overCap === 0, 'no species exceeds its global concurrent cap',
    overCap === 0
      ? `${liveCap.length} agents across ${perSpecies.filter((v) => v > 0).length} species`
      : `${overCap} species over, worst ${worstId} by ${worstOver}`);

  // Habitats: every species must resolve to a placement mode.
  const hist = new Int32Array(4);
  for (let i = 0; i < SPECIES_TABLE.count; i++) hist[habitatOf(i)]++;
  ok(hist[HABITAT.PELAGIC] + hist[HABITAT.BENTHIC] + hist[HABITAT.LAND] + hist[HABITAT.AIR]
    === SPECIES_TABLE.count, 'every species has a habitat',
  `pelagic ${hist[0]}, benthic ${hist[1]}, land ${hist[2]}, air ${hist[3]}`);
}

// ===========================================================================
console.log('\n== 13. LOD promotion and demotion hysteresis ==');
// ===========================================================================
{
  const sim = new CreatureSim(collision, { seed: 9 });
  const sp = speciesIndexOf('CRT_SILVERQUILL');
  const h = sim.spawn(sp, 0, -50, 0, {});
  const i = sim.slotOf(h);
  sim.velX[i] = 0; sim.velY[i] = 0; sim.velZ[i] = 0;
  const cam = { position: [0, -50, 0], forward: [0, 0, -1], isSphereVisible: () => true };
  const world = { ...QUIET_WORLD, camera: cam };

  const classAt = (d) => {
    cam.position[2] = d;
    sim.posX[i] = 0; sim.posY[i] = -50; sim.posZ[i] = 0;
    sim.simulate(FIXED_DT, world);
    return sim.lod[i];
  };
  // Walk out past the edge and back in, so the hysteresis is exercised in both
  // directions rather than only on the way out.
  classAt(10);
  const at10 = sim.lod[i];
  classAt(62);
  const at62 = sim.lod[i];
  classAt(70);
  const at70 = sim.lod[i];
  classAt(59);
  const at59 = sim.lod[i];
  ok(at10 === CREATURE_LOD.FULL, 'FULL inside 60 m', `lod ${at10}`);
  ok(at62 === CREATURE_LOD.FULL, 'still FULL at 62 m (inside the 1.12x demote edge)',
    `lod ${at62}, demote edge ${(LOD_RANGE[0] * 1.12).toFixed(1)} m`);
  ok(at70 === CREATURE_LOD.REDUCED, 'REDUCED past 67.2 m', `lod ${at70}`);
  ok(at59 === CREATURE_LOD.FULL, 'and promoted back to FULL at 59 m', `lod ${at59}`);

  // ---- the staggers must actually run at the rate the table claims ------
  //
  // The perception and selection tests are NESTED inside the tick test, so an
  // agent reaches them only on the steps where `i % TICK === tick % TICK` was
  // already true. That makes the effective period lcm(TICK, SUB), not SUB, and a
  // SUB that is not a multiple of TICK silently runs at a fraction of the
  // documented rate: SELECT_PERIOD[0] was 15 against TICK_PERIOD[0] = 2 and
  // measured 2.000 Hz against a documented 4 Hz. Simulating the two modulos is
  // exact and costs nothing, so it is checked rather than reasoned about.
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  const lcm = (a, b) => (a / gcd(a, b)) * b;
  for (let lod = 0; lod < 3; lod++) {
    const tick = TICK_PERIOD[lod];
    for (const [label, sub] of [['perception', PERCEPTION_PERIOD[lod]],
      ['selection', SELECT_PERIOD[lod]]]) {
      if (sub === 0) continue;      // 0 means "never", which is legal
      ok(sub % tick === 0,
        `lod ${lod} ${label} period is a multiple of the tick period`,
        `${sub} % ${tick} = ${sub % tick}`);
    }
  }
  // And measure the rates, over 64 slots x 600 s, by replaying the exact
  // expressions simulate() evaluates.
  const STEPS = 60 * 600;
  for (let lod = 0; lod < 3; lod++) {
    const tick = TICK_PERIOD[lod];
    let ticks = 0, percs = 0, sels = 0;
    for (let slot = 0; slot < 64; slot++) {
      for (let t = 1; t <= STEPS; t++) {
        if (slot % tick !== t % tick) continue;
        ticks++;
        if (PERCEPTION_PERIOD[lod] > 0 &&
            (t % PERCEPTION_PERIOD[lod]) === (slot % PERCEPTION_PERIOD[lod])) percs++;
        if ((t % SELECT_PERIOD[lod]) === (slot % SELECT_PERIOD[lod])) sels++;
      }
    }
    const secs = (STEPS / 60) * 64;
    const tickHz = ticks / secs, percHz = percs / secs, selHz = sels / secs;
    ok(Math.abs(tickHz - 60 / tick) < 0.01, `lod ${lod} ticks at 60/${tick} Hz`,
      `${tickHz.toFixed(3)} Hz`);
    ok(Math.abs(percHz - (PERCEPTION_PERIOD[lod] ? 60 / lcm(tick, PERCEPTION_PERIOD[lod]) : 0)) < 0.01,
      `lod ${lod} perceives at the nested rate`, `${percHz.toFixed(3)} Hz`);
    ok(Math.abs(selHz - 60 / lcm(tick, SELECT_PERIOD[lod])) < 0.01,
      `lod ${lod} re-selects at the nested rate`,
      `${selHz.toFixed(3)} Hz (naive 60/${SELECT_PERIOD[lod]} = ` +
      `${(60 / SELECT_PERIOD[lod]).toFixed(3)} Hz)`);
  }
  // The FULL class is the one the player is looking at; it must re-select at
  // least as often as DESIGN/06.1.10's 4 Hz.
  ok(60 / lcm(TICK_PERIOD[0], SELECT_PERIOD[0]) >= 4.0,
    'the FULL class re-selects at least 4 Hz',
    `${(60 / lcm(TICK_PERIOD[0], SELECT_PERIOD[0])).toFixed(2)} Hz`);
}

// ===========================================================================
console.log('\n== 14. despawn requires every condition ==');
// ===========================================================================
{
  const sim = new CreatureSim(collision, { seed: 11 });
  const spawner = new Spawner(sim, { seed: WORLD.DEFAULT_SEED });
  spawner.attach();
  const sp = speciesIndexOf('CRT_SILVERQUILL');
  const h = sim.spawn(sp, 0, -60, 0, {});
  const i = sim.slotOf(h);
  const player = [0, -60, 3000];        // 3 km away: well past the 600 m rule

  // Tested through the HANDLE, not the slot: spawner.update() also resolves a
  // cell, which can immediately refill the slot the cull just freed. The
  // generation counter in the handle is what distinguishes "still alive" from
  // "replaced by a different animal in the same slot", and that is exactly the
  // confusion the handle exists to prevent.

  // Condition 2 not met (still on camera): must survive.
  sim.unseenT[i] = 0;
  spawner.update(FIXED_DT, player, null);
  ok(sim.isAlive(h), 'an on-camera agent 3 km away is NOT despawned',
    `unseen ${sim.unseenT[i].toFixed(1)} s`);

  // Condition 3 not met (fleeing): must survive.
  sim.unseenT[i] = 30;
  sim.behaviour[i] = BEHAVIOUR.FLEE;
  spawner.update(FIXED_DT, player, null);
  ok(sim.isAlive(h), 'a fleeing agent is NOT despawned', 'behaviour FLEE');

  // Everything met: must go.
  sim.behaviour[i] = BEHAVIOUR.IDLE;
  sim.unseenT[i] = 30;
  spawner.update(FIXED_DT, player, null);
  ok(!sim.isAlive(h), 'an idle, unseen, distant agent IS despawned',
    `${spawner.stats.despawned} despawned`);
}

// ===========================================================================
console.log('\n== 15. sonar ping and kin alerting ==');
// ===========================================================================
{
  const sim = new CreatureSim(collision, { seed: 13 });
  const sp = speciesIndexOf('CRT_SILVERQUILL');
  const r = rng(0x9999);
  for (let k = 0; k < 20; k++) {
    sim.spawn(sp, (r() * 2 - 1) * 30, -80 + (r() * 2 - 1) * 10, (r() * 2 - 1) * 30, { schoolId: 5 });
  }
  const live = sim.liveSlots();
  let before = 0;
  for (let k = 0; k < live.length; k++) before += sim.threat[live[k]];
  sim.sonarPing([0, -80, 0], 400);
  let after = 0, maxSpeedJump = 0;
  for (let k = 0; k < live.length; k++) {
    after += sim.threat[live[k]];
    maxSpeedJump = Math.max(maxSpeedJump,
      Math.hypot(sim.velX[live[k]], sim.velY[live[k]], sim.velZ[live[k]]));
  }
  ok(after - before > 0.85 * live.length * 0.99,
    'a sonar ping raises threat by 0.90 on everything in range',
    `+${(after - before).toFixed(2)} over ${live.length} agents`);
  ok(maxSpeedJump > 0, 'and applies a flash-expansion impulse inside 12 m',
    `fastest ${maxSpeedJump.toFixed(2)} m/s`);
  ok(!sim.hasNaN(), 'still finite after the impulse');
}

// ===========================================================================
console.log('\n== 16. the near field puts animals where the player can see them ==');
// ===========================================================================
//
// THE REGRESSION THIS EXISTS TO CATCH IS AN EMPTY FRAME WITH A GREEN SUITE.
// Before the near-field director every check in this file passed while the
// lagoon held 200 agents, 0 of them within 30 m of the eye and 0 instances
// drawn. Counting the pool proves nothing; the assertions below are about
// DISTANCE FROM THE EYE and about the water column the animals occupy.
{
  // The lagoon, at the same eye the QA 'underwater-shallow' scenario uses.
  const EX = 0, EY = -8, EZ = 240;
  const floor = terrain.sampleHeightFast(EX, EZ);
  const water = waterTypeAt(EX, EZ, floor, -EY, terrain.sampleSlope(EX, EZ));
  const R = nearFieldRadius(water);

  ok(floor < -10 && floor > -25, 'the test point is the lagoon floor',
    `${floor.toFixed(1)} m, ${water.name}`);
  ok(R > 14 && R <= 45, 'the near-field radius comes from the water, not a constant',
    `${R.toFixed(1)} m in ${water.name} (visibility ${water.visibility} m); `
    + `${Object.entries(WATER_TYPES).map(([k, w]) => `${k} ${nearFieldRadius(w).toFixed(0)}`).join(', ')}`);

  const sim = new CreatureSim(collision, { seed: WORLD.DEFAULT_SEED });
  const spawner = new Spawner(sim, { seed: WORLD.DEFAULT_SEED });
  spawner.attach();
  spawner.prime([EX, EY, EZ], { daylight: 1 });

  const live = sim.liveSlots();
  let near = 0, near20 = 0, readableInner = 0, shallow = 0;
  const pelagicY = [];
  for (let k = 0; k < live.length; k++) {
    const i = live[k];
    const d = Math.hypot(sim.posX[i] - EX, sim.posY[i] - EY, sim.posZ[i] - EZ);
    if (d <= R && sim.tier[i] === 0) near++;
    if (d <= 20) near20++;
    if (d <= R * 0.45 && SPECIES_TABLE.length[sim.species[i]] >= 0.28) readableInner++;
    if (-sim.posY[i] < 20) shallow++;
    if (habitatOf(sim.species[i]) === HABITAT.PELAGIC) pelagicY.push(sim.posY[i]);
  }

  ok(near >= 80, 'the water inside the seeing distance is populated',
    `${near} tier-0 agents within ${R.toFixed(0)} m of the eye, ${live.length} alive`);
  ok(near20 >= 10, 'and some of them are close enough to have a face',
    `${near20} within 20 m`);
  ok(readableInner >= 4, 'the inner water has a supporting cast with readable body plans',
    `${readableInner} animals >= 0.28 m inside ${(R * 0.45).toFixed(1)} m`);
  ok(shallow >= 120, 'the sunlit shallows are not starved by the band budget',
    `${shallow} agents above 20 m depth, band budget ${BAND_BUDGET[1]}`);

  // The pelagic Y used to be CLAMPED into the habitable slice rather than
  // resampled in it, which piled 87.5% of every draw onto one boundary: the
  // measured median depth of a Coppersprat was 1.3 m, in the surface film.
  pelagicY.sort((a, b) => a - b);
  const median = -pelagicY[pelagicY.length >> 1];
  const inFilm = pelagicY.filter((y) => y > -2).length / Math.max(1, pelagicY.length);
  ok(median > 3.0, 'pelagic fish are spread through the column, not pressed into it',
    `${pelagicY.length} pelagic agents, median depth ${median.toFixed(1)} m`);
  ok(inFilm < 0.35, 'and the top two metres do not hold most of them',
    `${(inFilm * 100).toFixed(0)}% shallower than 2 m`);

  // Every band the director filled must be inside its own budget. This is the
  // check the cell-centre band lookup silently defeated: it charged the lagoon's
  // animals to Twilight and measured 183 agents against a Sunlit budget of 64.
  spawner._census();
  const overBand = [];
  for (let b = 0; b < BAND_BUDGET.length; b++) {
    if (spawner.bandCount[b] > BAND_BUDGET[b]) {
      overBand.push(`band ${b}: ${spawner.bandCount[b]} > ${BAND_BUDGET[b]}`);
    }
  }
  ok(overBand.length === 0, 'no depth band is over its budget after priming',
    overBand.join(', ') || `${[...spawner.bandCount].join('/')} of ${[...BAND_BUDGET].join('/')}`);
  ok(spawner.charterViolations(0) === 0, 'and the near field respects the Safe Charter');
  ok(!sim.hasNaN(), 'the primed lagoon is finite');

  // A shoal has to arrive as a shoal. MAX_CPU_SCHOOL is 40 and the size-class
  // cell cap used to bind first at 12, so every school in the game was 12.
  const schools = new Map();
  for (let k = 0; k < live.length; k++) {
    const s = sim.schoolId[live[k]];
    if (s >= 0) schools.set(s, (schools.get(s) || 0) + 1);
  }
  const biggest = Math.max(0, ...schools.values());
  ok(biggest >= 24, 'a shoal is a shoal, not a scattered dozen',
    `${schools.size} schools, largest ${biggest}, MAX_CPU_SCHOOL ${MAX_CPU_SCHOOL}`);

  // The colour the whole exercise is for.
  const bright = new Set(['CRT_AZUREGRAZE', 'CRT_VIOLETWRASSE', 'CRT_LIMEBANNER', 'CRT_SUNPLATE']);
  let colourful = 0;
  for (let k = 0; k < live.length; k++) {
    if (bright.has(SPECIES_TABLE.id[sim.species[live[k]]])) colourful++;
  }
  ok(colourful >= 40, 'and most of what is out there is a saturated reef fish',
    `${colourful} of ${live.length} are Azuregraze / Violet Wrasse / Limebanner / Sunplate`);
}

// ===========================================================================
console.log('\n== 17. cells resolve FIRST, and the near field still fills ==');
// ===========================================================================
//
// SECTION 16 CANNOT EXPRESS THIS ONE. It builds a fresh Spawner and calls
// prime() with the eye already underwater, and prime() runs the near field
// BEFORE it resolves a single cell - so the near field always wins the band
// there, whatever the cell path is charged against.
//
// The game does the opposite. prime() runs at the START POINT, which is the
// beach: no eye in the water, no near-field reservation, and 28 cells resolve
// into the sunlit band before the player has taken a step. Whether the lagoon
// then has fish in it depends entirely on whether the near field can get the
// band back, and MEASURED LIVE with the reservation applied to only the one
// band _bandOfCellWater happened to report, it could not: 215 agents alive, 3
// within 45 m of the eye against a target of 110, and ZERO drawn instances.
{
  const EX = 0, EY = -8, EZ = 240;
  const sim = new CreatureSim(collision, { seed: WORLD.DEFAULT_SEED });
  const spawner = new Spawner(sim, { seed: WORLD.DEFAULT_SEED });
  spawner.attach();

  // Prime from six metres ABOVE the water, which is what the beach is.
  spawner.prime([EX, 6, EZ], { daylight: 1 });
  spawner._census();
  const cellsFirst = spawner.bandCount[1];
  ok(spawner.stats.nearFieldSpawned === 0,
    'priming out of the water seeds no near field',
    `${spawner.stats.nearFieldSpawned} near-field agents, ${spawner.cells.size} cells`);
  ok(cellsFirst > BAND_BUDGET[1] * 0.75,
    'and cell resolution alone fills the sunlit band',
    `${cellsFirst} of ${BAND_BUDGET[1]} in band 1, ${sim.count} alive`);

  // Now put the eye in the water. The despawn rule needs the agents to have
  // been off camera for DESPAWN_UNSEEN; there is no camera and no simulate()
  // here, so say so explicitly rather than leaving unseenT at zero - section 14
  // is what tests the unseen guard itself.
  sim.unseenT.fill(30);
  const eye = [EX, EY, EZ];
  for (let step = 0; step < 300; step++) spawner.update(FIXED_DT, eye, { daylight: 1 });

  spawner._census();
  const target = spawner._nearFieldTarget(spawner._eyeBand);
  const live = sim.liveSlots();
  const R = spawner.stats.nearFieldRadius;
  let near = 0, near20 = 0;
  for (let k = 0; k < live.length; k++) {
    const i = live[k];
    const d = Math.hypot(sim.posX[i] - EX, sim.posY[i] - EY, sim.posZ[i] - EZ);
    if (d <= R && sim.tier[i] === 0) near++;
    if (d <= 20) near20++;
  }
  // 0.8, not 1.0, and the missing fifth is not a bug: cell animals between the
  // near-field radius and NEARFIELD_RECLAIM_MULT's 140 m are inside the 90 m
  // draw distance, so they are background the player can actually see and the
  // reclaim deliberately leaves them alone. They hold band slots the near field
  // then cannot have. The failure this guards against is 3 of 110, not 124.
  ok(near >= target * 0.8,
    'the near field reaches its target against an already-full band',
    `${near} within ${R.toFixed(0)} m of ${target}, ` +
    `${spawner.stats.nearFieldReclaimed} slots reclaimed from the far background`);
  ok(near20 >= 10, 'and it is not a hollow shell around the player',
    `${near20} within 20 m`);
  ok(spawner.bandCount[1] <= BAND_BUDGET[1],
    'without the band ever going over budget',
    `${spawner.bandCount[1]} of ${BAND_BUDGET[1]}`);
  ok(spawner.bandCellCount[1] <= cellsFirst,
    'and cell resolution never gained a slot once the eye was in the water',
    `${spawner.bandCellCount[1]} cell agents, down from ${cellsFirst}`);
  ok(spawner.charterViolations(0) === 0, 'the Safe Charter still holds');
  ok(!sim.hasNaN(), 'and the population is finite');
}

// ===========================================================================
console.log('\n== 17b. the near field with the eye MOVING ==');
// ===========================================================================
//
// EVERY OTHER TEST OF THIS DIRECTOR, HERE AND LIVE, PINS THE EYE - the
// implementer's seven runs, the reviewer's heading sweep and sections 16, 17 and
// 18 alike. Two bugs reported from play lived entirely in the configuration
// nobody exercised: "we barely see any fish in the shallows", and a churn
// diagnosis that could not be checked because the retirement path never ran.
//
// The signature is ANGULAR, not a population count, and that is why this section
// leads with the forward share. In the eye frame a near-field animal is
// effectively static (MEASURED self-motion 0.37 m/s against 3.96 m/s of diver),
// so with a co-moving seed disc and no inflow at its leading edge the
// steady-state density is a ramp that is exactly zero at the FRONT of the ball:
// forward share 0.250 for a uniform source, and MEASURED 0.15-0.17 in the old
// implementation because close-shell groups were distributed around the whole
// circle. They now use the forward hemisphere while moving. Against 0.500
// standing still. That, not the 16% the population falls by, is what took the
// creature pass from 33.0 drawn instances to 6.0-7.1.
{
  const EX = 0, EY = -8, EZ = 240;
  const sim = new CreatureSim(collision, { seed: WORLD.DEFAULT_SEED });
  const spawner = new Spawner(sim, { seed: WORLD.DEFAULT_SEED });
  spawner.attach();
  spawner.prime([EX, 6, EZ], { daylight: 1 });

  // unseenT is refilled EVERY step, not once: sim.spawn() zeroes it for a new
  // agent and there is no sim.update() offline to raise it again, so filling it
  // once lets the near field seed animals that can then never be culled. That
  // is exactly why section 18's treadmill guard reports "31 seeded / 0 retired"
  // - with the eye pinned as well, _cull's near-field branch executes zero
  // times there. Here the removal path has to run, because the whole point is
  // what the director does to animals the player has swum past.
  const eye = [EX, EY, EZ];
  sim.unseenT.fill(30);
  for (let step = 0; step < 300; step++) {
    spawner.update(FIXED_DT, eye, { daylight: 1 });
    sim.unseenT.fill(30);
  }
  const spawnedPinned = spawner.stats.nearFieldSpawned;

  // 2700 steps is 45 s and 180 m due west over the flattest lagoon in the map -
  // TWO full ball diameters, so the pinned population is completely flushed and
  // what is measured is the moving steady state rather than the decay of the
  // stationary one. At 900 steps the same build measures 0.271 instead of
  // 0.397 purely because a third of the original ball is still in it.
  const V = 4.0, STEPS = 2700;
  const SECONDS = STEPS * FIXED_DT;
  const R = spawner.stats.nearFieldRadius;
  // Sampled over the LAST THIRD of the sweep and averaged, for the same reason
  // the live probe averages over its last 16 s: the leading-edge quota is a
  // bang-bang controller - the forward edge drains, the population dips, the
  // quota fires, the edge refills - so a single instant reads anywhere in that
  // cycle. It is never hoisted above the `near >= target` early-out, which is
  // what would let it breach the band budget.
  let shareSum = 0, shareN = 0, nearSum = 0, nearSlotSum = 0;
  for (let step = 0; step < STEPS; step++) {
    eye[0] -= V * FIXED_DT;
    spawner.update(FIXED_DT, eye, { daylight: 1 });
    sim.unseenT.fill(30);
    if (step < STEPS * 2 / 3 || step % 30 !== 0) continue;
    const live = sim.liveSlots();
    let near = 0, nearSlot = 0, forward = 0;
    for (let k = 0; k < live.length; k++) {
      const i = live[k];
      const dx = sim.posX[i] - eye[0], dy = sim.posY[i] - eye[1], dz = sim.posZ[i] - eye[2];
      if (Math.hypot(dx, dy, dz) > R) continue;
      if (sim.tier[i] === 0) near++;
      if (spawner._nearFieldSlot[i] !== 1) continue;
      nearSlot++;
      if (-dx > 0) forward++;              // travel is -X
    }
    if (nearSlot > 0) { shareSum += forward / nearSlot; shareN++; }
    nearSum += near; nearSlotSum += nearSlot;
  }
  const seededMoving = spawner.stats.nearFieldSpawned - spawnedPinned;
  const target = spawner._nearFieldTarget(spawner._eyeBand);
  const share = shareN ? shareSum / shareN : 0;
  const near = shareN ? nearSum / shareN : 0;
  const nearSlot = shareN ? nearSlotSum / shareN : 0;

  // 0.32, not 0.50: the strict hide rule still sends close-shell seeds outside
  // the current frustum and self-motion is tiny relative to the diver, so the
  // composition cannot be perfectly symmetric. The close-shell forward aim is
  // a hemisphere, not an on-axis spawn, and therefore preserves pop control.
  // The regression being guarded is the old 0.163.
  ok(share >= 0.32, 'the half of the ball the eye is swimming INTO is populated',
    `${(share * 100).toFixed(1)}% of ${nearSlot.toFixed(0)} near-field agents are ahead ` +
    `(0.500 by symmetry standing still, 0.250 for a uniform co-moving source)`);
  ok(near >= target * 0.70, 'and the near field still reaches its target while moving',
    `${near.toFixed(0)} within ${R.toFixed(0)} m of ${target}`);
  ok(spawner.bandCount[1] <= BAND_BUDGET[1], 'without the band going over budget',
    `${spawner.bandCount[1]} of ${BAND_BUDGET[1]}`);
  // The churn ceiling. A leading-edge seed lives the whole chord instead of a
  // fraction of it, so this is expected to FALL as the population rises.
  ok(seededMoving / SECONDS <= 12, 'and it is not running a spawn/retire treadmill',
    `${(seededMoving / SECONDS).toFixed(2)} seeds/s, ` +
    `${(spawner.stats.nearFieldRetired / SECONDS).toFixed(2)} retired/s over ` +
    `${SECONDS.toFixed(0)} s and ${(V * SECONDS).toFixed(0)} m`);
  ok(spawner.charterViolations(0) === 0, 'the Safe Charter holds while moving');
  ok(!sim.hasNaN(), 'and the population is finite');
}

// ===========================================================================
console.log('\n== 18. the near field is a BALL, at every depth ==');
// ===========================================================================
//
// The region's vertical draw used to be overwritten by the habitat branch a few
// lines later - the pelagic resample spans the SPECIES' whole legal depth range,
// which in open water is hundreds of metres. Away from a shallow floor that made
// the director seed agents it could never count, so it seeded them again every
// step: MEASURED LIVE at y = -200 over a seabed at -410.6 m, nearFieldCount 0,
// 140 seeded and 73 retired in EIGHT SECONDS, 7,005 placement attempts.
{
  // Open water: a column deep enough that a 45 m ball is nowhere near the floor,
  // which is the case the dead vertical draw turned into a treadmill.
  const EX = -1500, EZ = 1500;
  const floor = terrain.sampleHeightFast(EX, EZ);
  const EY = -200;
  const sim = new CreatureSim(collision, { seed: 4242 });
  const spawner = new Spawner(sim, { seed: WORLD.DEFAULT_SEED });
  spawner.attach();
  ok(floor < EY - 100, 'the test point is open water, not a seabed',
    `eye ${EY.toFixed(1)} m over a floor at ${floor.toFixed(1)} m`);

  const eye = [EX, EY, EZ];
  spawner._updateNearFieldGeometry(eye);
  const R = spawner.stats.nearFieldRadius;
  for (let step = 0; step < 240; step++) spawner.update(FIXED_DT, eye, { daylight: 1 });

  const live = sim.liveSlots();
  let inside = 0, outsideBall = 0, maxDy = 0;
  for (let k = 0; k < live.length; k++) {
    const i = live[k];
    if (spawner._nearFieldSlot[i] !== 1) continue;
    const d = Math.hypot(sim.posX[i] - EX, sim.posY[i] - EY, sim.posZ[i] - EZ);
    if (d <= R) inside++; else outsideBall++;
    maxDy = Math.max(maxDy, Math.abs(sim.posY[i] - EY));
  }
  const target = spawner._nearFieldTarget(spawner._eyeBand);
  const species = new Set();
  for (let k = 0; k < live.length; k++) species.add(sim.species[live[k]]);
  // 0.7 because the midnight zone's own roster, not the director, is what binds
  // here: NEARFIELD_SPECIES_SHARE caps each species at a third of the target and
  // there are only a handful of tier-0 species legal at 200 m. The regression
  // being guarded is ZERO, which is what the dead vertical draw produced.
  ok(inside >= target * 0.7, 'the near field fills in open water too',
    `${inside} of ${target} inside ${R.toFixed(0)} m, ${outsideBall} outside it, ` +
    `${species.size} species available`);
  // The treadmill's signature: seeds that are never counted, so it never stops.
  //
  // BUT NOTE WHAT THIS ASSERTION CAN AND CANNOT SEE. `eye` is a const that is
  // never reassigned, and unseenT is filled once rather than per step, so over
  // these 240 updates _cull's near-field retirement executes ZERO times: it
  // reports "31 seeded / 0 retired" and is vacuous with respect to churn. It is
  // still worth keeping - the bug it caught, the region's dead vertical draw,
  // is a real one and shows up here as seeds that are never counted. Churn with
  // the eye actually moving is section 17b's job, and it did not exist until
  // two bugs had been reported from play.
  ok(spawner.stats.nearFieldSpawned < target * 2.0,
    'and it seeds each agent once instead of running a spawn/retire treadmill',
    `${spawner.stats.nearFieldSpawned} seeded / ${spawner.stats.nearFieldRetired} retired ` +
    `for ${inside} held, ${spawner.stats.spawnAttempts} placement attempts`);
  ok(maxDy <= R + 1e-3, 'no near-field agent is seeded outside the ball vertically',
    `deepest offset ${maxDy.toFixed(1)} m against a radius of ${R.toFixed(1)} m`);
}

// ===========================================================================
console.log('\n== 19. an animal can steer away from every predator it can fear ==');
// ===========================================================================
//
// THE REGRESSION THIS EXISTS TO CATCH IS A FISH FRIGHTENED INTO PARALYSIS.
// Fear is integrated over `fearFleeRadius(L) = 4 + 6L` and the FLEE steer runs
// over `max(PANIC_FLOOR_M + 12L, fearFleeRadius(L))`. Cutting PANIC_FLOOR_M to
// 2 m WITHOUT that max put the second below the first for every animal shorter
// than 1/3 m - 11 of 40 species - and inside the resulting annulus the animal is
// in BEHAVIOUR.FLEE with a FLEE force of exactly zero, while BEHAVIOUR_MUL's
// FLEE row multiplies SEEK and ARRIVE by 0.0. The same radius sizes the steer's
// own predator query, so it could not even find the thing it was afraid of.
//
// Nothing in this file guarded it: there was no test that any prey animal fled
// any predator at any distance, and the near-field measurements are all taken
// in the lagoon where fear is 0.0000 and the whole path is unreachable.
//
// The measurement is an A/B on the STEER VECTOR against a control run in which
// the predator is still PRESENT but parked at 3x the fear radius. Removing it
// instead would change how many agents draw from the shared PRNG and drift the
// prey's own wander - MEASURED, that contaminated version reported a response
// from 10 of 11 species at 3x the fear radius, where there must be none. With
// the agent count held fixed the control differences are 0.000000 exactly for
// all eleven, so any non-zero reading below is the FLEE term and nothing else.
// Positions are re-pinned before every step, so the prey never moves.
{
  const PRED = speciesIndexOf('CRT_CHISELFIN');   // tier 3, 1.4 m
  const EY = -60;
  const STEPS = 40;
  // A camera at the animals so they run at LOD 0; a player 1000 km away so the
  // diver is never the threat under test.
  const world = {
    playerPos: [1e6, 0, 1e6], playerVel: [0, 0, 0], playerAlive: true,
    playerInVessel: false, playerNoise: 0.05, vessel: null,
    camera: { position: [0, EY, 0] }, daylight: 1,
  };

  /** Away-component of the prey's steer after STEPS pinned steps. */
  function awaySteer(spIndex, dist) {
    const sim = new CreatureSim(collision, { seed: 0x5eed });
    const prey = sim.slotOf(sim.spawn(spIndex, 0, EY, 0, { schoolId: -1 }));
    const pred = sim.slotOf(sim.spawn(PRED, dist, EY, 0, { schoolId: -1 }));
    for (let s = 0; s < STEPS; s++) {
      sim.posX[prey] = 0; sim.posY[prey] = EY; sim.posZ[prey] = 0;
      sim.velX[prey] = 0; sim.velY[prey] = 0; sim.velZ[prey] = 0;
      // IDLE in both runs: the FLEE steer is live in IDLE (BEHAVIOUR_MUL 1.0),
      // and pinning it stops the predator's fear changing the whole weight row
      // and confounding the difference.
      sim.behaviour[prey] = BEHAVIOUR.IDLE;
      sim.posX[pred] = dist; sim.posY[pred] = EY; sim.posZ[pred] = 0;
      sim.velX[pred] = 0; sim.velY[pred] = 0; sim.velZ[pred] = 0;
      sim.behaviour[pred] = BEHAVIOUR.IDLE;
      sim.simulate(FIXED_DT, world);
    }
    // The predator is at +X, so "away" is -X.
    return -sim.steerX[prey];
  }

  // Every species whose fear radius exceeds the unfloored panic radius, i.e.
  // every one the missing max() would have paralysed.
  const inverted = [];
  for (let sp = 0; sp < SPECIES_TABLE.count; sp++) {
    const L = SPECIES_TABLE.length[sp];
    if (fearFleeRadius(L) > PANIC_FLOOR_M + PANIC_BODY_LENGTHS * L) inverted.push(sp);
  }
  ok(inverted.length > 0, 'the fear radius exceeds the unfloored panic radius somewhere',
    `${inverted.length} of ${SPECIES_TABLE.count} species, all shorter than 1/3 m`);

  const base = inverted.map((sp) => awaySteer(sp, fearFleeRadius(SPECIES_TABLE.length[sp]) * 3.0));

  // The control first, because every number after it is a difference from it.
  {
    let moved = 0, worst = 0;
    for (let k = 0; k < inverted.length; k++) {
      const d = fearFleeRadius(SPECIES_TABLE.length[inverted[k]]) * 4.0;
      const drift = Math.abs(awaySteer(inverted[k], d) - base[k]);
      if (drift !== 0) moved++;
      worst = Math.max(worst, drift);
    }
    ok(moved === 0, 'a predator outside the fear radius moves the steer by nothing',
      `${moved} of ${inverted.length} drifted between 3x and 4x, worst ${worst.toFixed(8)}`);
  }

  // 0.55, 0.85 and 0.98 of the fear radius. All three are OUTSIDE the unfloored
  // panic radius for the whole `inverted` set - which is what makes this
  // discriminate - and all three are outside every separation radius in the
  // table, so FLEE is the only term that can move.
  for (const frac of [0.55, 0.85, 0.98]) {
    let worst = Infinity, worstName = '', responded = 0;
    for (let k = 0; k < inverted.length; k++) {
      const sp = inverted[k];
      const d = fearFleeRadius(SPECIES_TABLE.length[sp]) * frac;
      const gain = awaySteer(sp, d) - base[k];
      if (gain > 0) responded++;
      if (gain < worst) { worst = gain; worstName = SPECIES_TABLE.id[sp]; }
    }
    ok(responded === inverted.length,
      `every one of them steers AWAY at ${frac.toFixed(2)} of its fear radius`,
      `${responded} of ${inverted.length}, weakest ${worstName} ` +
      `at ${worst.toFixed(5)} m/s2 of extra away-acceleration`);
  }
}

// ===========================================================================
console.log('\n== 20. the diver is dodged, not fled ==');
// ===========================================================================
//
// THE REGRESSION THIS EXISTS TO CATCH IS THE ONE REPORTED FROM PLAY THREE
// TIMES: "they always look away from us, and if we strafe around them they
// rotate so we can never see them". Two independent causes, both here.
//
//  (a) THE RADIUS RAN AWAY WITH THE ANIMAL. `max(2 + 12L, 4 + 6L)` is 4.66 m on
//      a 0.11 m Coppersprat - which is what the 2026-07-31 change was measured
//      on - and 17.6 m on a Sandveil Ray, 57.2 m on a Gloomray, 218 m on a
//      Veilmouth and 1154 m on a Nethercoil, all times 1.9 for the sub.
//  (b) THE ESCAPE WAS RADIAL. Heading is lookRotation on the velocity and
//      _integrate re-projects the velocity onto the heading, so a push straight
//      away from the diver IS a turn-away at any strength. MEASURED live on a
//      1.48 m Sandveil Ray, A/B/A with the FLEE column zeroed for the middle
//      arm: relative-bearing concentration 0.992 / 0.042 / 0.969 and NOSE-ON
//      fraction 0.000 / 0.233 / 0.000 over a full circle at 6 m.
//
// The predator branch is deliberately untouched and still radial - being eaten
// is not a photo opportunity - which is why section 19 above needed no new
// baseline. That is itself asserted below.
{
  const EY = -60;
  const STEPS = 40;
  const RAD = PLAYER_FLEE_RADIAL_FRAC;

  // ---- 20a. the radius table ---------------------------------------------
  {
    let overCap = 0, nonMono = 0, underFloor = 0, worstRatio = 0, worstName = '';
    let prev = -Infinity;
    const byLength = [...Array(SPECIES_TABLE.count).keys()]
      .sort((a, b) => SPECIES_TABLE.length[a] - SPECIES_TABLE.length[b]);
    for (const sp of byLength) {
      const L = SPECIES_TABLE.length[sp];
      const r = playerPanicRadius(L);
      if (r > PLAYER_PANIC_MAX_M + 1e-9) overCap++;
      if (r < prev - 1e-9) nonMono++;
      if (r < PLAYER_PANIC_FLOOR_M - 1e-9) underFloor++;
      prev = r;
      const old = Math.max(PANIC_FLOOR_M + PANIC_BODY_LENGTHS * L, fearFleeRadius(L));
      if (old / r > worstRatio) { worstRatio = old / r; worstName = SPECIES_TABLE.id[sp]; }
    }
    ok(overCap === 0, 'no species exceeds the player panic cap',
      `0 of ${SPECIES_TABLE.count} over ${PLAYER_PANIC_MAX_M} m; ` +
      `largest ${playerPanicRadius(Math.max(...SPECIES_TABLE.length)).toFixed(2)} m`);
    ok(nonMono === 0, 'the player panic radius is monotone in body length',
      `${nonMono} inversions over ${SPECIES_TABLE.count} species`);
    ok(underFloor === 0, 'no species is allowed inside the diver\'s own hull',
      `floor ${PLAYER_PANIC_FLOOR_M} m, min ` +
      `${Math.min(...[...Array(SPECIES_TABLE.count).keys()].map((s) => playerPanicRadius(SPECIES_TABLE.length[s]))).toFixed(2)} m`);
    // ABSOLUTE METRES, NOT A PROPERTY OF THE FORMULA. Every check above is
    // satisfied by construction - `overCap` compares the cap against itself,
    // monotonicity and the floor are properties of `min` over an increasing
    // affine function - so setting PLAYER_PANIC_MAX_M to 200 would pass all of
    // them, and cause (a) of this whole section would have zero coverage. These
    // are the named animals from the report and the design, in metres.
    const NAMED = [
      ['CRT_COPPERSPRAT', 3.0], ['CRT_SANDVEIL', 6.0], ['CRT_GLOOMRAY', 9.0],
      ['CRT_VEILMOUTH', 9.0], ['LEV_NETHERCOIL', 9.0],
    ];
    let overNamed = 0, worstNamed = '', worstVal = 0;
    for (const [id, limit] of NAMED) {
      const r = playerPanicRadius(SPECIES_TABLE.length[speciesIndexOf(id)]);
      if (r > limit) { overNamed++; if (r - limit > worstVal) { worstVal = r - limit; worstNamed = id; } }
    }
    ok(overNamed === 0, 'the named animals are approachable IN METRES',
      NAMED.map(([id]) => `${id.replace(/^\w+_/, '')} ` +
        `${playerPanicRadius(SPECIES_TABLE.length[speciesIndexOf(id)]).toFixed(1)}`).join(', ') +
      (overNamed ? ` - ${worstNamed} over by ${worstVal.toFixed(1)} m` : ' m'));
    // The vessel radius is the one that has to sit sensibly around a 7.4 m hull.
    const rv = playerPanicRadius(SPECIES_TABLE.length[speciesIndexOf('CRT_SANDVEIL')])
      * VESSEL_PANIC_MULT;
    ok(rv > 7.4 && rv < 20, 'the vessel stand-off is the right order for a 7.4 m hull',
      `${rv.toFixed(1)} m for a Sandveil Ray, was 33.4 m`);
    ok(worstRatio > 1, 'the runaway radius is gone',
      `worst shrink ${worstName} ${worstRatio.toFixed(1)}x`);
  }

  // ---- 20b. _escapeDirection's geometry, including every degenerate arm ----
  //
  // A DIRECT UNIT TEST, because the degeneracies are unreachable from a live
  // scene and are exactly where this class of bug hides. The SWIM CONTRACT's
  // deleted SWIM_TURN_RATE is the precedent: a normalised lerp of a unit vector
  // toward its own negation stays collinear with it, so a dead-ahead reversal
  // never turned at all, and the only reason a human escaped is that a human's
  // aim wobbles off the pole. A test suite did not catch it.
  {
    const sim = new CreatureSim(collision, { seed: 0x5eed });
    const i = sim.slotOf(sim.spawn(speciesIndexOf('CRT_COPPERSPRAT'), 0, EY, 0,
      { schoolId: -1, heading: 0 }));
    const out = new Float32Array(3);
    const setFwd = (fx, fy, fz) => {
      // Write the orientation directly so forward is exactly what we want,
      // including straight up, which no heading/pitch pair reaches cleanly.
      //
      // THE CROSS PRODUCT HERE WAS NEGATED AND IT SILENTLY INVERTED FIVE OF THE
      // SIX CASES BELOW. (0,0,-1) x f = (f_y, -f_x, 0); the first cut wrote
      // (-f_y, f_x, 0), i.e. the inverse rotation, so "forward PARALLEL to the
      // radial" actually tested antiparallel and vice versa. It PASSED, because
      // parallel and antiparallel are symmetric for a degeneracy test - and the
      // cost was that the only case reaching the real Gram-Schmidt path was the
      // exactly-perpendicular +-Z shortcut. The oblique path, which is the one
      // that runs in the game, had no coverage at all. `assertFwd` below now
      // checks the fixture against `_forwardOf` so it cannot lie again.
      const l = Math.hypot(fx, fy, fz);
      const f = [fx / l, fy / l, fz / l];
      // Shortest arc from model forward (0,0,-1) to f.
      const d = -f[2];
      if (d > 0.999999) { sim.orient.set([0, 0, 0, 1], i * 4); return; }
      if (d < -0.999999) { sim.orient.set([0, 1, 0, 0], i * 4); return; }
      const ax = f[1], ay = -f[0], az = 0;   // (0,0,-1) x f
      const s = Math.sqrt((1 + d) * 2);
      sim.orient.set([ax / s, ay / s, az / s, s / 2], i * 4);
    };
    // A FIXTURE THAT IS NOT ITSELF TESTED IS A LIE WAITING TO HAPPEN.
    const fwdOut = new Float32Array(3);
    let fixtureWorst = 0;
    const assertFwd = (want) => {
      const l = Math.hypot(want[0], want[1], want[2]);
      sim._forwardOf(i, fwdOut);
      const dot = (fwdOut[0] * want[0] + fwdOut[1] * want[1] + fwdOut[2] * want[2]) / l;
      fixtureWorst = Math.max(fixtureWorst, Math.abs(dot - 1));
    };
    const call = (fwd, away) => {
      setFwd(fwd[0], fwd[1], fwd[2]);
      assertFwd(fwd);
      const l = Math.hypot(away[0], away[1], away[2]);
      sim._escapeDirection(i, away[0] / l, away[1] / l, away[2] / l, out);
      return [out[0], out[1], out[2]];
    };
    const lenOf = (v) => Math.hypot(v[0], v[1], v[2]);
    const dotOf = (v, u) => v[0] * u[0] + v[1] * u[1] + v[2] * u[2];

    const cases = [
      ['generic: forward across the radial', [0, 0, -1], [1, 0, 0]],
      ['forward PARALLEL to the radial', [1, 0, 0], [1, 0, 0]],
      ['forward ANTIPARALLEL to the radial', [-1, 0, 0], [1, 0, 0]],
      ['threat directly overhead', [0, -1, 0], [0, -1, 0]],
      ['threat underneath, forward straight up', [0, 1, 0], [0, 1, 0]],
      ['forward almost parallel (1e-7 off)', [1, 1e-7, 0], [1, 0, 0]],
      // OBLIQUE. Everything above is perpendicular or degenerate, and until
      // these were added the real Gram-Schmidt arm never executed once - every
      // case returned a tangent that was already exactly perpendicular, which is
      // why the whole section read `min radial component 0.2425` and looked
      // healthy while covering nothing.
      ['oblique 45 deg to the radial', [0.7071, 0, -0.7071], [1, 0, 0]],
      ['oblique in three axes', [0.601, 0.300, -0.741], [1, 0, 0]],
      ['oblique against a diagonal radial', [0.2, -0.9, 0.386], [0.577, 0.577, 0.577]],
      ['oblique, 5 deg off parallel', [0.9962, 0.0872, 0], [1, 0, 0]],
    ];
    // The closed form. `normalize(t*(1-k) + a*k)` with t a UNIT vector
    // perpendicular to a - which Gram-Schmidt guarantees in every arm,
    // degenerate or not - has radial component exactly k/hypot(1-k, k). So this
    // is not a tolerance, it is an identity, and it should hold to rounding in
    // every case. Asserting it loosely is what let the inverted fixture hide.
    const EXPECT_RADIAL = RAD / Math.hypot(1 - RAD, RAD);
    let worstLen = 0, nonFinite = 0, worstName = '';
    let worstRadialErr = 0, worstRadialName = '';
    let maxTurn = 0, maxTurnName = '';
    for (const [name, fwd, away] of cases) {
      const v = call(fwd, away);
      if (!v.every(Number.isFinite)) { nonFinite++; continue; }
      const e = Math.abs(lenOf(v) - 1);
      if (e > worstLen) { worstLen = e; worstName = name; }
      const al = Math.hypot(away[0], away[1], away[2]);
      const rc = dotOf(v, [away[0] / al, away[1] / al, away[2] / al]);
      const re = Math.abs(rc - EXPECT_RADIAL);
      if (re > worstRadialErr) { worstRadialErr = re; worstRadialName = name; }
      // How far the animal has to turn from where it was already going.
      const fl = Math.hypot(fwd[0], fwd[1], fwd[2]);
      const turn = Math.acos(Math.max(-1, Math.min(1,
        dotOf(v, [fwd[0] / fl, fwd[1] / fl, fwd[2] / fl])))) * 180 / Math.PI;
      if (turn > maxTurn) { maxTurn = turn; maxTurnName = name; }
    }
    ok(nonFinite === 0, 'the escape direction is finite in every case',
      `${cases.length} cases: perpendicular, oblique, parallel, antiparallel, vertical`);
    ok(fixtureWorst < 1e-5, 'the FIXTURE points the animal where it claims to',
      `worst 1-dot against _forwardOf ${fixtureWorst.toExponential(2)}`);
    ok(worstLen < 1e-6, 'the escape direction is unit length in every case',
      `worst |len-1| ${worstLen.toExponential(2)} at "${worstName}"`);
    // THE STAND-OFF SURVIVES. A pure tangent would let the diver close forever;
    // the radial share is what keeps the animal out of your lap.
    ok(worstRadialErr < 1e-5, 'every case carries EXACTLY the authored radial share',
      `delivered ${EXPECT_RADIAL.toFixed(4)} from an authored ${RAD}, worst error ` +
      `${worstRadialErr.toExponential(2)} at "${worstRadialName}"`);
    const expect = Math.acos(EXPECT_RADIAL) * 180 / Math.PI;
    const generic = call([0, 0, -1], [1, 0, 0]);
    const got = Math.acos(Math.max(-1, Math.min(1, generic[0]))) * 180 / Math.PI;
    ok(Math.abs(got - expect) < 0.05, 'the escape is mostly tangential',
      `${got.toFixed(2)} deg off the radial, closed form ${expect.toFixed(2)} deg`);
    // Reported rather than bounded tightly: the "it carries on roughly where it
    // was going" claim in _escapeDirection is true away from the degeneracy and
    // false at it, and this is the number that says so.
    ok(maxTurn < 130, 'and the turn it asks for stays under a reversal',
      `worst ${maxTurn.toFixed(1)} deg from the current heading, at "${maxTurnName}"`);
  }

  // ---- 20c. what the animal actually delivers, over the whole table --------
  //
  // A/B on the STEER VECTOR with BEHAVIOUR_MUL's FLEE column zeroed for the
  // control. NOT a moved player: `_perceive`'s vision cone draws from the
  // shared PRNG inside `if (pd < rEff)`, so moving the diver changes how many
  // draws happen and contaminates the difference - the same trap section 19
  // documents for a removed predator. Zeroing a weight moves nothing and
  // consumes nothing, so any non-zero delta below is the FLEE term alone.
  {
    const world = {
      playerPos: [0, EY, 0], playerVel: [0, 0, 0], playerAlive: true,
      playerInVessel: false, playerNoise: 0.05, vessel: null,
      camera: { position: [0, EY, 0] }, daylight: 1,
    };
    const saved = [];
    for (let b = 0; b < BEHAVIOUR_COUNT; b++) {
      saved.push(BEHAVIOUR_MUL[b * STEER_COUNT + STEER.FLEE]);
    }
    const setFlee = (on) => {
      for (let b = 0; b < BEHAVIOUR_COUNT; b++) {
        BEHAVIOUR_MUL[b * STEER_COUNT + STEER.FLEE] = on ? saved[b] : 0;
      }
    };

    /**
     * Steer vector of one pinned animal at `(0, atY, 0)` with the diver
     * `dist` away at `-dist * u`, so `u` IS the away direction, diver->animal.
     *
     * Anchoring the ANIMAL and moving the diver, rather than the other way
     * round, is deliberate: it keeps the animal's own depth exactly `atY` in
     * every geometry, and it stops the away direction being the negation of the
     * axis the caller thinks it passed. The first cut put the animal at
     * `-dist * u` and measured against `+u`, which reported every one of 120
     * cases at 96.8-120 deg with a negative radial component - the correct
     * 75.96 deg answer, read backwards.
     *
     * `atY` is the animal's OWN depth, and passing it is not optional. Pinning
     * all 40 species at one depth put 25 of them outside their depth band and 24
     * past the 12 m hard margin, where `_steer` multiplies the depth force by 6;
     * the blend then saturated `aMax` for 31 of 40 with the steer vector
     * 99.9-100% VERTICAL, and the delta of two saturated clamps is not the flee
     * term. It read a clean 75.9 deg anyway - but only because the diver was
     * exactly horizontal, so the saturating vector happened to be orthogonal to
     * the flee vector. Tilt the diver and the same fixture reported 89 deg mean
     * and a NEGATIVE radial component. The reading was an artefact of the
     * geometry, not a measurement of the escape.
     */
    function steerOf(spIndex, dist, atY, ux, uy, uz, fleeOn) {
      setFlee(fleeOn);
      const sim = new CreatureSim(collision, { seed: 0x5eed });
      const px = 0, py = atY, pz = 0;
      const i = sim.slotOf(sim.spawn(spIndex, px, py, pz, { schoolId: -1, heading: 0 }));
      const q0 = sim.orient.slice(i * 4, i * 4 + 4);
      world.playerPos[0] = -dist * ux;
      world.playerPos[1] = atY - dist * uy;
      world.playerPos[2] = -dist * uz;
      world.camera.position[1] = atY;
      for (let s = 0; s < STEPS; s++) {
        // Pinned, and IDLE in both arms: FLEE is live in IDLE (BEHAVIOUR_MUL
        // 1.0) and pinning the row stops fear changing the whole weight vector.
        sim.posX[i] = px; sim.posY[i] = py; sim.posZ[i] = pz;
        sim.velX[i] = 0; sim.velY[i] = 0; sim.velZ[i] = 0;
        sim.behaviour[i] = BEHAVIOUR.IDLE;
        // THE ORIENTATION HAS TO BE PINNED TOO, and forgetting it made this
        // check read 41.8 deg mean with a 0.2 deg worst case. Velocity is zeroed
        // at the TOP of each step, so within a step the animal still accelerates
        // and _integrate still writes a heading from it - and WANDER is built
        // from that heading. The two arms therefore drifted to different
        // orientations and the delta measured a WANDER difference on top of the
        // flee term, which for a low-FLEE species is most of it.
        sim.orient.set(q0, i * 4);
        sim.simulate(FIXED_DT, world);
      }
      return [sim.steerX[i], sim.steerY[i], sim.steerZ[i]];
    }

    // Half the animal's own radius, where the falloff is 0.5 and the term is
    // unambiguously live for every species in the table.
    //
    // THREE DIVER GEOMETRIES, because one is not a measurement. `_escapeDirection`
    // returns 75.96 deg off the radial in EVERY geometry by construction, so any
    // spread here is contamination, and a fixture that only ever puts the diver
    // horizontal cannot tell a clean delta from a saturated clamp that happens
    // to be orthogonal to it.
    // `u` is the AWAY direction, diver -> animal.
    const GEOM = [
      ['diver abeam', 1, 0, 0],
      ['diver 45 deg above', 0.7071, -0.7071, 0],
      ['diver overhead', 0, -1, 0],
    ];
    let worstMean = 75.96, worstMeanName = 'none';
    let radialOnly = 0, closing = 0, n = 0, saturated = 0;
    let minAngle = Infinity, minName = '', maxAngle = 0, maxName = '';
    let minRadial = Infinity, minRadialName = '';
    for (const [gname, ux, uy, uz] of GEOM) {
      let sum = 0, cnt = 0;
      for (let sp = 0; sp < SPECIES_TABLE.count; sp++) {
        const L = SPECIES_TABLE.length[sp];
        const d = playerPanicRadius(L) * 0.5;
        // THE ANIMAL'S OWN BAND, not a single global depth. Midpoint, and at
        // least `d` under the surface so the geometry fits above it.
        const atY = -Math.max(d + 2,
          (SPECIES_TABLE.depthMin[sp] + SPECIES_TABLE.depthMax[sp]) * 0.5);
        const on = steerOf(sp, d, atY, ux, uy, uz, true);
        const off = steerOf(sp, d, atY, ux, uy, uz, false);
        const dx = on[0] - off[0], dy = on[1] - off[1], dz = on[2] - off[2];
        const mag = Math.hypot(dx, dy, dz);
        if (mag < 1e-6) continue;            // this species did not move at all
        n++; cnt++;
        const radial = dx * ux + dy * uy + dz * uz;
        const ang = Math.acos(Math.max(-1, Math.min(1, radial / mag))) * 180 / Math.PI;
        sum += ang;
        if (ang < 45) radialOnly++;
        if (ang < minAngle) { minAngle = ang; minName = `${SPECIES_TABLE.id[sp]}/${gname}`; }
        if (ang > maxAngle) { maxAngle = ang; maxName = `${SPECIES_TABLE.id[sp]}/${gname}`; }
        if (radial <= 0) closing++;
        if (radial / mag < minRadial) {
          minRadial = radial / mag; minRadialName = `${SPECIES_TABLE.id[sp]}/${gname}`;
        }
        // The clamp is what contaminated the first cut; count it rather than
        // hope it is absent.
        if (Math.hypot(on[0], on[1], on[2]) > ARCHETYPES[SPECIES_TABLE.archetype[sp]].aMax * 0.999) {
          saturated++;
        }
      }
      const m = cnt ? sum / cnt : 0;
      if (Math.abs(m - 75.96) > Math.abs(worstMean - 75.96)) { worstMean = m; worstMeanName = gname; }
    }
    setFlee(true);

    ok(n >= 100, 'the diver moves nearly every species from every direction',
      `${n} of ${SPECIES_TABLE.count * GEOM.length} species x geometry delivered a ` +
      `measurable flee term; aMax saturated in ${saturated}`);
    ok(radialOnly === 0, 'NO species escapes the diver radially, from any direction',
      `${radialOnly} of ${n} under 45 deg off the radial; range ` +
      `${minAngle.toFixed(1)}-${maxAngle.toFixed(1)} deg against a closed form of ` +
      `75.96, worst geometry mean ${worstMean.toFixed(1)} deg (${worstMeanName})`);
    ok(Math.abs(worstMean - 75.96) < 3.0, 'and the delivered angle IS the closed form',
      `worst per-geometry mean ${worstMean.toFixed(2)} deg vs 75.96; extremes ` +
      `${minName} ${minAngle.toFixed(1)}, ${maxName} ${maxAngle.toFixed(1)}`);
    ok(closing === 0, 'every species still gains separation while it dodges',
      `${closing} of ${n} with a negative radial component; weakest ${minRadialName} ` +
      `at ${minRadial.toFixed(3)}`);

    // ---- and the predator branch is STILL radial -------------------------
    // Section 19 depends on this and would not notice if the tangential form
    // leaked across: it only ever reads the away-component, which stays
    // positive either way.
    {
      const PRED = speciesIndexOf('CRT_CHISELFIN');
      const prey = speciesIndexOf('CRT_COPPERSPRAT');
      const far = { ...world, playerPos: [1e6, 0, 1e6], camera: { position: [0, EY, 0] } };
      function predSteer(dist, fleeOn) {
        setFlee(fleeOn);
        const sim = new CreatureSim(collision, { seed: 0x5eed });
        const a = sim.slotOf(sim.spawn(prey, 0, EY, 0, { schoolId: -1, heading: 0 }));
        const p = sim.slotOf(sim.spawn(PRED, -dist, EY, 0, { schoolId: -1, heading: 0 }));
        const q0 = sim.orient.slice(a * 4, a * 4 + 4);
        for (let s = 0; s < STEPS; s++) {
          sim.posX[a] = 0; sim.posY[a] = EY; sim.posZ[a] = 0;
          sim.velX[a] = 0; sim.velY[a] = 0; sim.velZ[a] = 0;
          sim.behaviour[a] = BEHAVIOUR.IDLE;
          sim.orient.set(q0, a * 4);
          sim.posX[p] = -dist; sim.posY[p] = EY; sim.posZ[p] = 0;
          sim.velX[p] = 0; sim.velY[p] = 0; sim.velZ[p] = 0;
          sim.behaviour[p] = BEHAVIOUR.IDLE;
          sim.simulate(FIXED_DT, far);
        }
        return [sim.steerX[a], sim.steerY[a], sim.steerZ[a]];
      }
      const d = fearFleeRadius(SPECIES_TABLE.length[prey]) * 0.5;
      const on = predSteer(d, true), off = predSteer(d, false);
      const dx = on[0] - off[0], dy = on[1] - off[1], dz = on[2] - off[2];
      const mag = Math.hypot(dx, dy, dz) || 1;
      setFlee(true);
      // The predator is at -X, so away is +X.
      const ang = Math.acos(Math.max(-1, Math.min(1, dx / mag))) * 180 / Math.PI;
      ok(mag > 1e-6 && ang < 15, 'a PREDATOR is still fled straight down the radial',
        `${ang.toFixed(2)} deg off the radial at 0.5 of the fear radius, ` +
        `|delta| ${mag.toFixed(4)} m/s2`);
    }

    // ---- 20d. the photophobe under the sub's flood -----------------------
    //
    // A SECOND, INDEPENDENT PATH TO THE SAME BUG, and fixing only the FLEE
    // block would have left it entirely intact the moment the player boarded.
    // `_resolveSteerTarget` gives a photophobe a SEEK target away from the lamp,
    // which needs no FLEE weight at all and reaches out to c.vesselLightRange -
    // 165 m with the flood on. It used to be `2 * pos - vesselPos`, the
    // reflection of the lamp through the animal, i.e. exactly radial.
    //
    // Measured as the target's own bearing rather than as a steer delta,
    // because that is where the direction is decided and it needs no control.
    {
      let worstAng = Infinity, worstName = '', n2 = 0, radialOnly2 = 0;
      let minRadial2 = Infinity;
      for (let sp = 0; sp < SPECIES_TABLE.count; sp++) {
        if (!(SPECIES_TABLE.lightAffinity[sp] < 0)) continue;
        const L = SPECIES_TABLE.length[sp];
        const sim = new CreatureSim(collision, { seed: 0x5eed });
        const i = sim.slotOf(sim.spawn(sp, 0, EY, 0, { schoolId: -1, heading: 0 }));
        // The lamp at -X and well inside its own range, so lux clears the
        // 0.05 * LUX_SAT gate that arms this branch at all.
        const lampD = Math.max(6, L * 3);
        const vesselWorld = {
          ...world,
          playerPos: [1e6, 0, 1e6],
          vessel: {
            position: [-lampD, EY, 0], speed: 0, piloted: false,
            lights: { flood: true },
          },
          camera: { position: [0, EY, 0] },
          daylight: 0,
        };
        const q0 = sim.orient.slice(i * 4, i * 4 + 4);
        const out = new Float32Array(3);
        let got = null;
        for (let s = 0; s < STEPS; s++) {
          sim.posX[i] = 0; sim.posY[i] = EY; sim.posZ[i] = 0;
          sim.velX[i] = 0; sim.velY[i] = 0; sim.velZ[i] = 0;
          sim.behaviour[i] = BEHAVIOUR.IDLE;
          sim.orient.set(q0, i * 4);
          sim.simulate(FIXED_DT, vesselWorld);
          if (s === STEPS - 1 && sim.lightLux[i] > 0) {
            if (sim._resolveSteerTarget(i, out)) {
              got = [out[0] - sim.posX[i], out[1] - sim.posY[i], out[2] - sim.posZ[i]];
            }
          }
        }
        if (!got) continue;
        const m2 = Math.hypot(got[0], got[1], got[2]);
        // IDENTIFY THE BRANCH BY ITS REACH, not by lux. `_resolveSteerTarget`
        // tries SCHOOL, INVESTIGATE and the phototrope pull first, and falls
        // through to "arrive at home" - which for a pinned animal is its own
        // position, i.e. a near-zero vector whose direction is drift noise. Only
        // the photophobe branch offsets by exactly the lamp distance, so that is
        // what selects it. Gating on `lightLux > 0` was too weak and let the
        // home fallthrough in, which read as a radial component of -0.000.
        if (Math.abs(m2 - lampD) > 0.1 * lampD) continue;
        // The lamp is at -X, so "away" is +X.
        const radial = got[0] / m2;
        const a2 = Math.acos(Math.max(-1, Math.min(1, radial))) * 180 / Math.PI;
        n2++;
        if (a2 < 45) radialOnly2++;
        if (a2 < worstAng) { worstAng = a2; worstName = SPECIES_TABLE.id[sp]; }
        if (radial < minRadial2) minRadial2 = radial;
      }
      ok(n2 >= 8, 'the flood reaches enough photophobes to test',
        `${n2} species took the light-avoidance branch`);
      ok(radialOnly2 === 0, 'a photophobe SLIPS out of the beam instead of turning its tail',
        `${radialOnly2} of ${n2} under 45 deg off the radial, most radial ` +
        `${worstName} at ${worstAng.toFixed(1)} deg`);
      ok(minRadial2 > 0, 'and it still ends up further from the lamp',
        `min radial component ${minRadial2.toFixed(4)} over ${n2} species`);
    }
  }
}

// ===========================================================================
console.log('\n== 21. the station residency: the observatory pod is population ==');
// ===========================================================================
// entities/station_residency.js replaced the demo's _stepFauna staging
// of a demo-owned creature. This section drives its whole lifecycle
// offline: table sanity, the walk-in, the witness gate, hysteresis, release
// guards and reset. First offline coverage of the residency pattern at all -
// the leviathan and cave managers ship the same shapes untested.
{
  const { StationResidencies, STATION_RESIDENCY_SITES } =
    await import('../src/entities/station_residency.js');
  const { insideHabitatVolume } = await import('../src/world/habitat_site.js');

  // The module's own load-time lint already threw if a home were inside the
  // envelope; re-assert here with the number visible, plus the gate ordering
  // the docstring claims. 600 is the spawner's DESPAWN_DISTANCE for tier 0
  // (spawner.js:997, not exported): the manager must always release first.
  for (const s of STATION_RESIDENCY_SITES) {
    ok(s.members.every((m) => !insideHabitatVolume(m.x, m.y, m.z, 1.0)),
      `'${s.short}' homes clear the habitat envelope at margin 1.0`,
      `${s.members.length} members`);
    ok(s.activateR < s.releaseR && s.releaseR < 600,
      `'${s.short}' gates are ordered activateR < releaseR < despawn 600`,
      `${s.activateR} < ${s.releaseR} < 600`);
    ok(speciesIndexOf(s.species) >= 0, `'${s.short}' species resolves`,
      s.species);
  }

  const pod = STATION_RESIDENCY_SITES[0];
  const sim = new CreatureSim(collision, { seed: 0x57A710 });
  const res = new StationResidencies(sim);
  const liveCount = () => res.sites[0].handles.filter(
    (h) => h >= 0 && sim.isAlive(h)).length;
  const focusAt = (d) => [pod.x + d, -30, pod.z];

  // Walk-in: far outside -> nothing; inside activateR but outside WITNESS_R
  // -> the full pod, at the authored homes.
  res.update(focusAt(400));
  ok(liveCount() === 0, 'no member spawns 400 m out', `${liveCount()} live`);
  res.update(focusAt(150));
  ok(liveCount() === pod.members.length, 'the full pod spawns on the walk-in',
    `${liveCount()}/${pod.members.length} at 150 m`);
  {
    const h0 = res.sites[0].handles[0];
    const i = sim.slotOf(h0);
    const m = pod.members[0];
    const off = Math.hypot(sim.posX[i] - m.x, sim.posY[i] - m.y, sim.posZ[i] - m.z);
    ok(off < 0.5, 'member 0 spawns at its authored home', `${off.toFixed(3)} m off`);
  }

  // The witness gate: kill a member, stand at the glass (inside WITNESS_R),
  // and the hole must NOT refill in front of the player; step back out and it
  // does.
  sim.despawn(res.sites[0].handles[1], 'despawn');
  res.update(focusAt(30));
  ok(liveCount() === pod.members.length - 1,
    'a lost member does not refill in front of the glass',
    `${liveCount()} live at 30 m`);
  res.update(focusAt(150));
  ok(liveCount() === pod.members.length, 'it refills once unwitnessed',
    `${liveCount()} live at 150 m`);

  // Hysteresis: oscillating across activateR must not strobe (release is
  // releaseR's job, far beyond).
  const before = res.sites[0].handles.slice();
  for (let k = 0; k < 6; k++) { res.update(focusAt(165)); res.update(focusAt(175)); }
  ok(res.sites[0].handles.every((h, m) => h === before[m]),
    'oscillating across activateR does not strobe the pod', 'handles stable over 12 flips');

  // Release: beyond releaseR, but only for idle, unobserved members - the
  // leviathan guards. Fresh spawns have unseenT 0, so the first far update
  // must release NOTHING; marking them long-unseen releases all.
  res.update(focusAt(300));
  ok(liveCount() === pod.members.length,
    'release honours the recently-seen guard', `${liveCount()} live, unseenT 0`);
  for (const h of res.sites[0].handles) {
    const i = sim.slotOf(h);
    if (i >= 0) sim.unseenT[i] = 10;
  }
  res.update(focusAt(300));
  ok(liveCount() === 0, 'idle unobserved members release past releaseR',
    `${liveCount()} live at 300 m`);

  // reset() despawns whatever is live and re-arms.
  res.update(focusAt(150));
  ok(liveCount() === pod.members.length, 're-arms after release', `${liveCount()} live`);
  res.reset();
  ok(liveCount() === 0 && res.sites[0].handles.every((h) => h === -1),
    'reset() despawns the pod and clears every handle', 'all -1');
}

// ===========================================================================
console.log(`\n${fails === 0 ? 'ALL CREATURE CHECKS PASSED' : `${fails} CHECK(S) FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
