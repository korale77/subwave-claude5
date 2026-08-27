#!/usr/bin/env node
/**
 * Deterministic gating, choreography, safety and AI-handoff checks for the
 * Splitmaw bluff-charge (entities/dune_ambush.js). The shape and the safety
 * clauses mirror tools/test-abyss-encounter.mjs, because the module mirrors
 * that encounter: what cannot be checked here is whether the maw READS as a
 * jump-scare - that is the demo capture's frames, and they have to be looked
 * at.
 */

import { WORLD } from '../src/core/constants.js';
import * as terrain from '../src/world/terrain.js';
import { biomeAt, setBiomeSeed } from '../src/world/biomes.js';
import { CreatureSim, BEHAVIOUR, speciesIndexOf } from '../src/entities/creatures.js';
import { DuneAmbush, DUNE_AMBUSH_PHASE } from '../src/entities/dune_ambush.js';
import { LEVIATHAN_SITES } from '../src/world/leviathan_sites.js';

let fails = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) fails++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label.padEnd(66)} ${detail}`);
};

terrain.setSeed(WORLD.DEFAULT_SEED);
setBiomeSeed(WORLD.DEFAULT_SEED);

const SITE = LEVIATHAN_SITES.find((s) => s.short === 'splitmaw');
const SP = speciesIndexOf('LEV_SPLITMAW');
const HOME_Y = SITE.seabedY + SITE.hoverAbove;

console.log('\n== 1. the ambush stage is the authored hunting ground ==');
{
  const h = terrain.sampleHeight(SITE.x, SITE.z);
  ok(Math.abs(h - SITE.seabedY) < 1e-6, 'recorded seabed height matches generated terrain', h.toFixed(2));
  ok(biomeAt(SITE.x, SITE.z, h, terrain.sampleSlope(SITE.x, SITE.z)) === 18,
    'the home point remains Sunken Dunes');
}

console.log('\n== 2. gating: no trigger without commitment to the plateau ==');
{
  const sim = new CreatureSim(null, { seed: WORLD.DEFAULT_SEED, capacity: 8 });
  const ambush = new DuneAmbush(sim);
  sim.spawn(SP, SITE.x, HOME_Y, SITE.z, { heading: 0 });
  const shallow = Float32Array.of(SITE.x + 100, -100, SITE.z);
  const far = Float32Array.of(SITE.x + 400, -336, SITE.z);
  for (let n = 0; n < 50; n++) { ambush.update(0.1, shallow); ambush.update(0.1, far); }
  ok(ambush.phase === DUNE_AMBUSH_PHASE.DORMANT && !ambush.completed,
    'a shallow or distant focus never arms the ambush');
}

console.log('\n== 3. choreography: prowl, turn, charge through the lens, release ==');
{
  const sim = new CreatureSim(null, { seed: WORLD.DEFAULT_SEED, capacity: 8 });
  const ambush = new DuneAmbush(sim);
  const h = sim.spawn(SP, SITE.x, HOME_Y, SITE.z, { heading: 1.0,
    homeX: SITE.x, homeY: HOME_Y, homeZ: SITE.z, territoryR: SITE.territoryR });
  const slot = sim.slotOf(h);
  // THE DEMO'S OWN GEOMETRY AT THE CLIMAX, and the height is load-bearing.
  // ~105 m out, but the eye is 30 m off the floor rather than 9: the segment's
  // third step swims the diver UP over the bone field before the charge lands
  // (script.js authors floorPoint(..., 30)), and MIN_GROUND_CLEARANCE holds the
  // posed body 22 m over the seabed. A focus at +9 is BELOW that floor, so the
  // charge physically cannot reach it and the swallow assertions below would
  // measure the clearance clamp instead of the choreography.
  const focus = Float32Array.of(SITE.x + 104, SITE.seabedY + 30, SITE.z - 14);

  const phases = new Set();
  let minDist = Infinity, maxDist = 0, maxSpeed = 0, maxTravelSpeed = 0;
  let stagedAttack = false, jawAtSwallow = 0, jawBeforeTurn = 1;
  // Heading continuity across the latch: once the body centre passes the diver
  // the centre-to-focus aim REVERSES, and a pose that kept re-aiming would spin
  // on the spot and swim back out of its own mouth. Measured as the worst
  // step-to-step direction dot over the swallow.
  let worstTurnDot = 1, prevDirX = 0, prevDirY = 0, prevDirZ = 0, havePrevDir = false;
  let distAtLatch = -1;
  let lastX = 0, lastY = 0, lastZ = 0, haveLast = false;
  // The two clauses the 2026-08-21 recut added: the maw stays SHUT until the
  // approach commits, and the posed body never ploughs the bone field.
  let jawFarField = 0, minClearance = Infinity, turnStartT = -1;
  // 50 s at 0.1 s, which has to cover the WHOLE take: TURN_T's 18 s floor, up
  // to TURN_MAX_T of wheeling out to CHARGE_RANGE, the run back in, and
  // RELEASE_T at 44. A loop sized to the old 28 s timeline reported the take as
  // never completing and every phase assertion below failed with it.
  for (let n = 0; n < 500; n++) {
    ambush.update(0.1, focus);
    phases.add(ambush.phase);
    const d = Math.hypot(sim.posX[slot] - focus[0], sim.posY[slot] - focus[1], sim.posZ[slot] - focus[2]);
    minDist = Math.min(minDist, d); maxDist = Math.max(maxDist, d);
    maxSpeed = Math.max(maxSpeed, Math.hypot(sim.velX[slot], sim.velY[slot], sim.velZ[slot]));
    if (haveLast && !ambush.completed) {
      maxTravelSpeed = Math.max(maxTravelSpeed,
        Math.hypot(sim.posX[slot] - lastX, sim.posY[slot] - lastY, sim.posZ[slot] - lastZ) / 0.1);
    }
    lastX = sim.posX[slot]; lastY = sim.posY[slot]; lastZ = sim.posZ[slot]; haveLast = true;
    const posed = ambush.phase === DUNE_AMBUSH_PHASE.TURN
      || ambush.phase === DUNE_AMBUSH_PHASE.CHARGE
      || ambush.phase === DUNE_AMBUSH_PHASE.SWALLOW;
    if (posed) {
      stagedAttack ||= sim.behaviour[slot] !== BEHAVIOUR.IDLE || sim.threat[slot] !== 0;
    }
    if (ambush.phase === DUNE_AMBUSH_PHASE.PROWL) jawBeforeTurn = Math.min(jawBeforeTurn, 1);
    if (ambush.phase === DUNE_AMBUSH_PHASE.SWALLOW) {
      jawAtSwallow = Math.max(jawAtSwallow, sim.jawOpen[slot]);
      if (distAtLatch < 0) distAtLatch = d;
      const sp = Math.hypot(sim.velX[slot], sim.velY[slot], sim.velZ[slot]);
      if (sp > 1e-6) {
        const dx = sim.velX[slot] / sp, dy = sim.velY[slot] / sp, dz = sim.velZ[slot] / sp;
        if (havePrevDir) worstTurnDot = Math.min(worstTurnDot, dx * prevDirX + dy * prevDirY + dz * prevDirZ);
        prevDirX = dx; prevDirY = dy; prevDirZ = dz; havePrevDir = true;
      }
    }
    // Everything the POSE owns, measured only there: the patrol AI before
    // TURN_T is the residency's business and may fly the animal where it likes.
    if (posed) {
      if (turnStartT < 0) turnStartT = n * 0.1;
      minClearance = Math.min(minClearance,
        sim.posY[slot] - terrain.sampleHeight(sim.posX[slot], sim.posZ[slot]));
      // 115 m clears JAW_OPEN_START (110), and only BEFORE the latch: the gape
      // is deliberately pinned at 1 through the swallow, and `d` climbs again
      // as the body streams past, so measuring it after the latch would report
      // the pin as a far-field leak.
      if (d > 115 && ambush.phase !== DUNE_AMBUSH_PHASE.SWALLOW) {
        jawFarField = Math.max(jawFarField, sim.jawOpen[slot]);
      }
    }
  }

  ok(phases.has(DUNE_AMBUSH_PHASE.PROWL) && phases.has(DUNE_AMBUSH_PHASE.TURN)
    && phases.has(DUNE_AMBUSH_PHASE.CHARGE) && phases.has(DUNE_AMBUSH_PHASE.SWALLOW),
    'sequence visits prowl, turn, charge and the swallow');
  ok(ambush.completed && ambush.phase === DUNE_AMBUSH_PHASE.RELEASED,
    'the same animal is handed back to normal AI');
  // THE CHARGE DOES NOT STOP. The latch fires SWALLOW_LEAD short of the
  // mandible tips reaching the lens - 66.5 m centre-to-focus on a 90 m animal,
  // the lead being the half second the consumer's fade needs - and the body
  // keeps going, so the centre must pass essentially THROUGH the focus. The aim
  // point is the eye plus 0.6 m and the step at 19 m/s over this 0.1 s tick is
  // 1.9 m, so a couple of metres is as close as the sampling gets.
  ok(distAtLatch > 0 && distAtLatch <= 68,
    'the swallow latches a fade-length short of the lens', `latched at ${distAtLatch.toFixed(1)} m`);
  ok(minDist <= 4.0, 'the charge carries the maw over the lens and keeps going',
    `${maxDist.toFixed(1)} -> ${minDist.toFixed(1)} m`);
  // The failure this rejects is specific: re-aiming after the centre passes the
  // diver reverses the aim vector and the animal turns round inside its own
  // swallow. A frozen heading holds the dot at 1.
  ok(worstTurnDot >= 0.999, 'the heading is ballistic through the swallow',
    `worst step-to-step dot ${worstTurnDot.toFixed(5)}`);
  ok(maxSpeed <= 19.001, 'authored motion never exceeds the shaved burst speed', `${maxSpeed.toFixed(2)} m/s`);
  ok(maxTravelSpeed <= 19.5, 'world-space path contains no hidden phase jump', `${maxTravelSpeed.toFixed(2)} m/s`);
  ok(!stagedAttack, 'the posed body never enters a damaging behaviour and carries zero threat');
  // Full gape through the whole swallow - it is what opens the mandible cage
  // too (creature.wgsl ROLE_MANDIBLE folds on this same scalar), so a gape that
  // sagged on the way out would snap four horns shut around the lens.
  ok(jawAtSwallow >= 0.95, 'the maw is fully open through the swallow', jawAtSwallow.toFixed(3));
  // 0.10 is the animator's own IDLE settle with headroom (~0.04); the point is
  // that NOTHING here writes a gape until the charge is inside JAW_OPEN_START.
  ok(jawFarField <= 0.10, 'the maw is shut until the approach commits', jawFarField.toFixed(3));
  ok(minClearance >= 21.0, 'the posed body never ploughs the bone field',
    `${minClearance.toFixed(1)} m over the seabed`);
  // The prowl covers the diver's TURN onto the bone field and nothing more. It
  // used to cover the rise as well, and that was the fault the 2026-08-21
  // playtest named: everything the patrol AI does reads as wandering, so a
  // prowl long enough to hide the climb is a prowl the camera has to watch. The
  // splitmaw commits at TURN_T and STALKS in behind the climb instead, which is
  // why the assertion is now a ceiling rather than a floor.
  ok(turnStartT >= 7.9 && turnStartT <= 9.0,
    'the prowl covers the diver\'s turn onto the bones and no more',
    `turn at t+${turnStartT.toFixed(1)}s`);
  ok(sim.threat[slot] === 0 && sim.behaviour[slot] === BEHAVIOUR.IDLE,
    'release hands back a clean, unaggroed agent');
  ok(Math.abs(sim.homeX[slot] - SITE.x) < 1e-6 && sim.territoryR[slot] === SITE.territoryR,
    'release restores the residency home and territory');
}

console.log('\n== 4. reset re-arms without touching the resident ==');
{
  const sim = new CreatureSim(null, { seed: WORLD.DEFAULT_SEED, capacity: 8 });
  const ambush = new DuneAmbush(sim);
  sim.spawn(SP, SITE.x, HOME_Y, SITE.z, { heading: 0 });
  // +9 rather than +30 on purpose: this is the TURN_DEADLINE path, a focus that
  // never rises. It must still complete, because a take that stalls forever
  // would strand the resident under the pose. 50 s, as in section 3.
  const focus = Float32Array.of(SITE.x + 104, SITE.seabedY + 9, SITE.z);
  for (let n = 0; n < 500; n++) ambush.update(0.1, focus);
  ok(ambush.completed, 'first take completes');
  ambush.reset();
  ok(!ambush.completed && ambush.phase === DUNE_AMBUSH_PHASE.DORMANT
    && sim.liveSlots().length === 1,
    'reset re-arms the take and leaves the residency\'s animal alive');
  ambush.update(0.1, focus);
  ok(ambush.phase === DUNE_AMBUSH_PHASE.PROWL, 'a repeat visit starts a fresh take');
}

console.log(`\n${fails ? `FAILED: ${fails}` : 'All dune ambush checks passed.'}`);
process.exitCode = fails ? 1 : 0;
