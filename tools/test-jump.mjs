#!/usr/bin/env node
/**
 * SUBWAVE developer-jump verification.
 *
 * Runs offline with no GPU and no DOM. Two halves:
 *
 *  - sections 1-5 and 9 cover `world/biome_anchors.js`: that every anchor is
 *    genuinely the biome it claims, that the search is deterministic, what it
 *    costs, and - section 9 - that it is not secretly running against the
 *    `slope = 0` lie.
 *  - sections 6-8 and 10 cover `entities/teleport.js` against a REAL
 *    CollisionWorld, Player and Vessel: the field-by-field state write, which is
 *    the part of this feature most likely to lose a latch and look fine.
 *
 * What it cannot check is whether the frames look right. That is
 * `tools/shot.mjs --list tools/shots/biomes.json`, and the pictures have to be
 * looked at.
 *
 * Every assertion prints the number it measured, not a claim about it.
 */
import { WORLD, PLAYER, VESSEL, WATER_TYPES } from '../src/core/constants.js';
import { FIXED_DT } from '../src/core/time.js';
import { vec3, quat, headingFromDir, wrapAngle } from '../src/core/math.js';
import * as terrain from '../src/world/terrain.js';
import { BIOMES, BIOME_COUNT, biomeAt, biomeWeights, setBiomeSeed } from '../src/world/biomes.js';
import { events, EVENTS } from '../src/core/events.js';
import { CollisionWorld } from '../src/world/collision.js';
import { Player, PLAYER_STATE } from '../src/entities/player.js';
import { Vessel } from '../src/entities/vessel.js';
import {
  resolveBiomeAnchors, getBiomeAnchors, invalidateBiomeAnchors,
} from '../src/world/biome_anchors.js';
import {
  teleportTo, suitTierForDepth, hullTierForDepth, parseCoords, validateTarget,
} from '../src/entities/teleport.js';
import { waterTypeAt, WATER_DISC_SITES } from '../src/world/biomes.js';
import { PLACES } from '../src/world/places.js';
import { generateScatterForChunk, SCATTER_BY_KEY } from '../src/world/scatter.js';

let fails = 0;
const ok = (cond, label, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label.padEnd(58)} ${detail ?? ''}`);
};

terrain.setSeed(WORLD.DEFAULT_SEED);
setBiomeSeed(WORLD.DEFAULT_SEED);

const t0 = performance.now();
const anchors = resolveBiomeAnchors(terrain);
const resolveMs = performance.now() - t0;

// ===========================================================================

console.log('\n== 1. every biome resolves to a position where it actually wins ==');
{
  ok(anchors.length === BIOME_COUNT, 'one anchor per biome',
    `${anchors.length}/${BIOME_COUNT}`);

  let wrong = 0;
  for (const a of anchors) {
    // Re-ask the question the resolver answered, through the PUBLIC classifier
    // and from the coordinates alone. If biome_anchors.js ever starts scoring
    // against something other than what biomeAt() reports, this is what catches
    // it - the resolver's own weight vector would not.
    const h = terrain.sampleHeight(a.x, a.z);
    const s = terrain.sampleSlope(a.x, a.z);
    const got = biomeAt(a.x, a.z, h, s);
    const good = got === a.id;
    if (!good) wrong++;
    console.log(
      `       ${String(a.id).padStart(2)} ${a.name.padEnd(19)}` +
      ` (${String(Math.round(a.x)).padStart(6)},${String(Math.round(a.z)).padStart(6)})` +
      ` h=${a.height.toFixed(1).padStart(8)} slope=${a.slope.toFixed(2)}` +
      ` land=${a.landformSlope.toFixed(2)} hood=${a.neighbourhood.toFixed(3)}` +
      ` w=${a.weight.toFixed(3)}` +
      (good ? '' : `  <-- biomeAt says ${BIOMES[got].name}`),
    );
  }
  ok(wrong === 0, 'biomeAt agrees with every anchor', `${BIOME_COUNT - wrong}/${BIOME_COUNT} agree`);

  const notDominant = anchors.filter((a) => !a.dominant);
  ok(notDominant.length === 0, 'every biome is dominant somewhere',
    notDominant.length ? notDominant.map((a) => a.short).join(', ') : 'all 14');
}

console.log('\n== 1a. anchors represent the biome and stage a usable camera ==');
{
  let outsideDepth = 0, outsideSlope = 0, invalidView = 0;
  let weakestHood = 1, weakestHoodName = '';
  for (const a of anchors) {
    const b = BIOMES[a.id];
    const depth = -a.height;
    if (!(depth > b.depth[0] && depth < b.depth[1])) outsideDepth++;
    if (!(a.landformSlope > b.slope[0] && a.landformSlope < b.slope[1])) outsideSlope++;
    if (!Number.isFinite(a.yaw) || !Number.isFinite(a.viewX) || !Number.isFinite(a.viewZ) ||
        (a.viewY !== null && !Number.isFinite(a.viewY)) ||
        (a.pitch !== null && !Number.isFinite(a.pitch))) invalidView++;
    if (a.neighbourhood < weakestHood) {
      weakestHood = a.neighbourhood;
      weakestHoodName = a.name;
    }
  }
  ok(outsideDepth === 0, 'every arrival is inside its authored depth band',
    `${BIOME_COUNT - outsideDepth}/${BIOME_COUNT}`);
  ok(outsideSlope === 0, 'every arrival has its authored slope at landform scale',
    `${BIOME_COUNT - outsideSlope}/${BIOME_COUNT}, epsilon 32 m`);
  ok(weakestHood >= 0.35, 'the four-point neighbourhood is not a biome sliver',
    `${weakestHood.toFixed(3)} (${weakestHoodName})`);
  ok(invalidView === 0, 'every biome has finite curated arrival framing',
    `${BIOME_COUNT - invalidView}/${BIOME_COUNT}`);

  // A STAGED ARRIVAL STANDS IN ITS PROOF POINT'S OWN COLUMN, and the eye height
  // of a staged view is measured AT THE EYE. This replaces an assertion that
  // required the opposite - a 64 m stand-off with the eye 20 m above the ground
  // under the point it had walked AWAY from. Rock Spires met it and delivered a
  // frame with near-mass exactly 0.0000: the eye ended 62.6 m above the seabed
  // beneath it, pitched up, with no landform in shot. See `stagedView`.
  let staged = 0, offColumn = 0, badLift = 0, worstLift = '';
  for (const a of anchors) {
    if (a.viewY === null && a.pitch === null) continue;
    staged++;
    if (a.viewX !== a.x || a.viewZ !== a.z) offColumn++;
    if (a.viewY === null) continue;
    const lift = a.viewY + PLAYER.EYE_HEIGHT - terrain.sampleHeight(a.viewX, a.viewZ);
    if (!(lift > 1.5 && lift < 20)) { badLift++; worstLift = `${a.short} ${lift.toFixed(1)} m`; }
  }
  ok(staged >= 1 && offColumn === 0 && badLift === 0,
    'every staged arrival is in its own column, eye 1.5-20 m off the seabed',
    `${staged} staged, ${offColumn} off-column, ${badLift} bad lift ${worstLift}`);
}

console.log('\n== 2. anchors are inside the world ==');
{
  let outside = 0, beyondSoft = 0;
  let worstR = 0, worstName = '';
  for (const a of anchors) {
    if (Math.abs(a.x) > WORLD.HALF_EXTENT || Math.abs(a.z) > WORLD.HALF_EXTENT) outside++;
    const r = Math.hypot(a.x, a.z);
    if (r > worstR) { worstR = r; worstName = a.short; }
    if (r > WORLD.SOFT_BOUNDARY) beyondSoft++;
  }
  ok(outside === 0, 'inside +/-HALF_EXTENT', `${WORLD.HALF_EXTENT} m, ${outside} outside`);
  // THE PLAYFIELD IS A SQUARE AND THE WORLD IS A DISC. A corner of the square is
  // at radius 4344 against a HARD_BOUNDARY of 3050, so an unconstrained scan can
  // and did return a correctly-classified anchor in a place collision.boundaryFactor
  // pushes you out of - it put Trench Floor at radius 3271. SOFT_BOUNDARY, not
  // HARD, because the push-back is a smoothstep between the two and an arrival
  // should not land on the ramp at all.
  ok(beyondSoft === 0, 'inside SOFT_BOUNDARY, so nothing arrives on the push-back ramp',
    `worst radius ${worstR.toFixed(0)} m (${worstName}) of ${WORLD.SOFT_BOUNDARY}`);
}

console.log('\n== 3. dominance margin ==');
{
  const w = new Float64Array(BIOME_COUNT);
  let weakest = 1, weakestName = '';
  let mismatched = 0;
  for (const a of anchors) {
    const h = terrain.sampleHeight(a.x, a.z);
    const s = terrain.sampleSlope(a.x, a.z);
    biomeWeights(w, a.x, a.z, h, s);
    let top = -1, topId = -1;
    for (let i = 0; i < BIOME_COUNT; i++) if (w[i] > top) { top = w[i]; topId = i; }
    if (topId !== a.id) mismatched++;
    if (top < weakest) { weakest = top; weakestName = a.name; }
    if (top < 0.45) {
      // Print the runners-up, so a regression reads as a contest that was lost
      // rather than as a bare FAIL with no way in.
      const rank = Array.from(w, (v, i) => [v, i]).sort((p, q) => q[0] - p[0]).slice(0, 3);
      console.log(`       ${a.name}: ` +
        rank.map(([v, i]) => `${BIOMES[i].short} ${v.toFixed(3)}`).join(' / '));
    }
  }
  ok(mismatched === 0, 'the anchor biome is the weight argmax', `${mismatched} mismatched`);
  ok(weakest >= 0.45, 'weakest anchor holds at least 0.45 of the blend',
    `${weakest.toFixed(3)} (${weakestName})`);
}

console.log('\n== 4. determinism ==');
{
  const again = resolveBiomeAnchors(terrain);
  let identical = true;
  for (let i = 0; i < BIOME_COUNT; i++) {
    const a = anchors[i], b = again[i];
    if (a.x !== b.x || a.z !== b.z || a.height !== b.height || a.slope !== b.slope ||
        a.landformSlope !== b.landformSlope || a.neighbourhood !== b.neighbourhood ||
        a.viewX !== b.viewX || a.viewY !== b.viewY || a.viewZ !== b.viewZ ||
        a.yaw !== b.yaw || a.pitch !== b.pitch) {
      identical = false;
    }
  }
  ok(identical, 'two resolves are bit-identical',
    'landmark, neighbourhood and staged camera fields');

  // A DIFFERENT seed is a measurement, not an assertion. Another world may
  // genuinely not contain every biome, and failing the suite for that would be
  // asserting a property of the default seed while pretending to test the code.
  const altSeed = (WORLD.DEFAULT_SEED ^ 0x5bd1) >>> 0;
  terrain.setSeed(altSeed);
  setBiomeSeed(altSeed);
  const alt = resolveBiomeAnchors(terrain);
  const altDominant = alt.filter((a) => a.dominant).length;
  ok(alt.length === BIOME_COUNT, 'a different seed still returns a full table',
    `${altDominant}/${BIOME_COUNT} dominant at seed 0x${altSeed.toString(16)}`);
  terrain.setSeed(WORLD.DEFAULT_SEED);
  setBiomeSeed(WORLD.DEFAULT_SEED);
  invalidateBiomeAnchors();
}

console.log('\n== 5. cost ==');
{
  // Generous on purpose. It runs once per session behind an already-open modal,
  // and test-terrain's own bake budget documents how much a loaded machine moves
  // a timing like this.
  ok(resolveMs < 400, 'a full resolve is under 400 ms', `${resolveMs.toFixed(1)} ms`);

  invalidateBiomeAnchors();
  const c0 = performance.now();
  getBiomeAnchors(terrain);
  const cold = performance.now() - c0;
  const h0 = performance.now();
  const hot = getBiomeAnchors(terrain);
  const warm = performance.now() - h0;
  ok(warm < cold * 0.05, 'the cache actually caches',
    `cold ${cold.toFixed(1)} ms, warm ${warm.toFixed(3)} ms`);
  ok(hot === getBiomeAnchors(terrain), 'the cache returns the same frozen table', '');
}

console.log('\n== 9. the slope=0 guard ==');
{
  // The single largest trap in this codebase: biomeAt/biomeWeights default slope
  // to 0, which is the value that makes the FLAT records win, and CLAUDE.md
  // measures it disagreeing with the real-slope answer on 67.50% of the seabed.
  //
  // The resolver passes a real slope. There is no way to prove that from the
  // outside by checking that its answers are RIGHT - the only external evidence
  // is that its answers DISAGREE with what the lie would have said. If a future
  // edit drops the sampleSlope call, the disagreements go to zero and this
  // fails; nothing else in the suite would notice.
  let disagreements = 0;
  const list = [];
  for (const a of anchors) {
    const h = terrain.sampleHeight(a.x, a.z);
    const flat = biomeAt(a.x, a.z, h, 0);
    if (flat !== a.id) { disagreements++; list.push(`${a.short}->${BIOMES[flat].short}`); }
  }
  ok(disagreements > 0, 'anchors disagree with the flat-slope answer',
    `${disagreements}/${BIOME_COUNT}: ${list.join(' ')}`);
}

// ===========================================================================
// The teleport, against a REAL CollisionWorld, Player and Vessel.
// ===========================================================================

const collision = new CollisionWorld(terrain, { seed: WORLD.DEFAULT_SEED });
collision.setSeaState(2, 0.6);

/** Every action reads zero: nobody is at the controls during these runs. */
const stubInput = {
  axis: () => 0,
  isDown: () => false,
  wasPressed: () => false,
  wasReleased: () => false,
  look: (out) => { out[0] = 0; out[1] = 0; return out; },
  moveVector: (out) => { out[0] = 0; out[1] = 0; return out; },
};

/** A fresh game-shaped object with no renderer, no spawner and no GPU. */
function makeGame() {
  const player = new Player(collision);
  const vessel = new Vessel(collision);
  player.setVessel(vessel);
  return { player, vessel, terrain, collision };
}

const byShort = (s) => anchors.find((a) => a.short === s);
const TRENCH = byShort('trenchFloor');
const BEACH = byShort('beach');

console.log('\n== 6. gear tiers ==');
{
  ok(suitTierForDepth(0) === 0 && suitTierForDepth(60) === 0 && suitTierForDepth(60.1) === 1,
    'suit tier boundaries at 60 m', `0/0/1 across [60, 60.1]`);
  ok(suitTierForDepth(1600) === 4 && suitTierForDepth(9999) === 4,
    'suit tier saturates at the deepest rating',
    `${PLAYER.SUIT_DEPTH_TIERS[4]} m is tier 4`);
  ok(hullTierForDepth(220) === 0 && hullTierForDepth(220.1) === 1 && hullTierForDepth(9999) === 4,
    'hull tier boundaries at 220 m and saturation', VESSEL.DEPTH_RATINGS.join('/'));

  // The survival claim, per anchor: the granted tier must actually be rated for
  // the depth, or the jump lands you somewhere that kills you.
  let suitShort = 0, hullShort = 0, deepSuit = 0, deepHull = 0;
  for (const a of anchors) {
    const d = Math.max(0, -a.height);
    const st = suitTierForDepth(d), ht = hullTierForDepth(d);
    if (PLAYER.SUIT_DEPTH_TIERS[st] < d) suitShort++;
    if (VESSEL.DEPTH_RATINGS[ht] < d) hullShort++;
    if (st > 0) deepSuit++;
    if (ht > 0) deepHull++;
  }
  ok(suitShort === 0, 'every anchor gets a suit rated for its depth',
    `${deepSuit}/${BIOME_COUNT} need better than tier 0 (${PLAYER.SUIT_DEPTH_TIERS[0]} m)`);
  ok(hullShort === 0, 'every anchor gets a hull rated for its depth',
    `${deepHull}/${BIOME_COUNT} need better than tier 0 (${VESSEL.DEPTH_RATINGS[0]} m)`);
}

console.log('\n== 7. parseCoords ==');
{
  const accept = [
    ['0 0', 0, null, 0],
    ['-168, -648', -168, null, -648],
    ['  -168  3.0  -648 ', -168, 3, -648],
    ['(2456, -1319, 2160)', 2456, -1319, 2160],
    ['1e3 -50 2e3', 1000, -50, 2000],
    ['+5 -0.5', 5, null, -0.5],
    ['[-1888 -2120]', -1888, null, -2120],
    // "1,,2" is x=1, y omitted, z=2 - which is what an empty middle field means
    // and what the two-token form already does. Reading it any other way would
    // reject the most natural way to type "this x and z, derive the height".
    ['1,,2', 1, null, 2],
  ];
  let bad = 0;
  for (const [text, x, y, z] of accept) {
    const r = parseCoords(text);
    if (!r || r.x !== x || r.y !== y || r.z !== z) { bad++; console.log(`       rejected/wrong: ${JSON.stringify(text)} -> ${JSON.stringify(r)}`); }
  }
  ok(bad === 0, 'accepts every shape a developer actually pastes', `${accept.length} forms`);

  // Number() would take all four of these somewhere unintended.
  const reject = ['', '   ', 'a b', '1', '1 2 3 4', 'NaN 0', '0x10 0', 'Infinity 0', '- 5', '1 2 x'];
  let leaked = 0;
  for (const text of reject) {
    if (parseCoords(text) !== null) { leaked++; console.log(`       accepted: ${JSON.stringify(text)}`); }
  }
  ok(leaked === 0, 'rejects blanks, junk, hex and Infinity', `${reject.length} forms`);
}

console.log('\n== 8. validateTarget ==');
{
  const inside = validateTarget(2000, 0);
  const ramp = validateTarget(2950, 0);
  const past = validateTarget(3060, 0);
  const square = validateTarget(3100, 0);
  ok(inside.ok && !inside.warn, 'open world is accepted with no warning', 'r = 2000 m');
  ok(ramp.ok && !!ramp.warn, 'the push-back band warns but is allowed',
    `r = 2950 m: ${ramp.warn}`);
  ok(!past.ok, 'past HARD_BOUNDARY is rejected', `r = 3060 m: ${past.reason}`);
  ok(!square.ok, 'outside the square playfield is rejected', `x = 3100: ${square.reason}`);
}

console.log('\n== 10. the teleport writes every field ==');
{
  const g = makeGame();
  const p = g.player;
  const vesselBefore = vec3.clone(g.vessel.position);
  const r = teleportTo(g, TRENCH.x, null, TRENCH.z, { label: TRENCH.name });

  // THE 447.71 m BUG, as one line of offline arithmetic. A probe that wrote
  // position without prevPosition left the camera a measured MEAN 447.71 m from
  // the player (worst 670 m) permanently, because applyCamera lerps
  // prevPosition -> position and only simulate() ever refreshes it.
  ok(vec3.dist(p.prevPosition, p.position) === 0,
    'prevPosition == position (the 447.71 m camera-offset bug)',
    `dist ${vec3.dist(p.prevPosition, p.position)}`);
  // Float32 storage, so a unit quaternion dotted with itself lands within an
  // ulp of 1 rather than on it. 1e-6 is far tighter than any real divergence.
  ok(Math.abs(quat.dot(p.prevOrientation, p.orientation) - 1) < 1e-6,
    'prevOrientation == orientation', `dot ${quat.dot(p.prevOrientation, p.orientation)}`);

  // The scalars and the quaternion must already agree. Read the quaternion back
  // with forward + headingFromDir, NOT quat.toEuler - toEuler folds roll into
  // yaw and inverts pitch past 90 degrees of roll, and using it here would teach
  // the wrong habit even where it happens to work.
  const fwd = quat.forward(vec3.create(), p.orientation);
  const yawBack = headingFromDir(fwd);
  const pitchBack = Math.asin(Math.max(-1, Math.min(1, fwd[1])));
  ok(Math.abs(wrapAngle(yawBack - r.yaw)) < 1e-6,
    'the quaternion carries the commanded yaw',
    `${(r.yaw * 180 / Math.PI).toFixed(2)} deg`);
  ok(Math.abs(pitchBack - r.pitch) < 1e-6,
    'the quaternion carries the commanded pitch',
    `${(r.pitch * 180 / Math.PI).toFixed(2)} deg`);

  ok(vec3.len(p.velocity) === 0, 'velocity is zero', '');
  ok(p.eyeSubmerged === true, 'the medium latch says submerged',
    `eye at ${(p.position[1] + p.currentEyeHeight).toFixed(1)} m`);
  ok(p.state === PLAYER_STATE.SWIM_FREE, 'state is SWIM_FREE', '');
  ok(p.suitTier === suitTierForDepth(r.depth) && PLAYER.SUIT_DEPTH_TIERS[p.suitTier] >= r.depth,
    'the suit tier was granted for the depth',
    `depth ${r.depth.toFixed(0)} m, tier ${p.suitTier} rated ${PLAYER.SUIT_DEPTH_TIERS[p.suitTier]} m`);
  ok(p.position[1] > r.height, 'the diver is above the seabed, not inside it',
    `y ${p.position[1].toFixed(1)} vs ground ${r.height.toFixed(1)}`);
  ok(vec3.dist(g.vessel.position, vesselBefore) === 0,
    'an on-foot jump leaves the vessel where it was', '');

  // Two seconds catches the CRUSH: a tier-0 suit spends all of MAX_HEALTH in
  // 1.11 s at 700 m, so surviving 2 s at this depth is the suit grant working.
  for (let i = 0; i < 120; i++) p.simulate(FIXED_DT, stubInput, i * FIXED_DT);
  ok(p.alive && p.health === PLAYER.MAX_HEALTH,
    'alive at full health after 2 s at the trench floor (crush)',
    `health ${p.health.toFixed(1)}, depth ${p.depth.toFixed(0)} m`);
}

console.log('\n== 10a. every underwater anchor is SURVIVABLE, not just arrivable ==');
{
  // A 2 s window is the wrong instrument for a drowning, and the first version of
  // this suite used one and passed while the feature was broken. Oxygen is a RATE:
  // oxygenDepthMultiplier saturates at 3.2, so a tier-0 90 s tank is 28 s of gas
  // in the deep. Measured before the oxygen grant, with full health and a rated
  // suit, NINE of the twelve underwater anchors drowned the diver - 89.0 s at Rock
  // Spires down to 38.3 s at the trench floor - and _die() respawns you on the
  // beach. Ninety seconds is long enough to look, shoot and jump again.
  const HOLD = 90;
  const steps = Math.round(HOLD / FIXED_DT);
  const dead = [];
  for (const a of anchors) {
    if (a.height >= 0) continue;
    const g = makeGame();
    teleportTo(g, a.x, null, a.z, { label: a.name });
    let diedAt = -1;
    for (let i = 0; i < steps; i++) {
      g.player.simulate(FIXED_DT, stubInput, i * FIXED_DT);
      if (!g.player.alive) { diedAt = i * FIXED_DT; break; }
    }
    if (diedAt >= 0) dead.push(`${a.short} ${(-a.height).toFixed(0)}m@${diedAt.toFixed(1)}s`);
  }
  ok(dead.length === 0, `all underwater anchors survive ${HOLD} s on foot`,
    dead.length ? `DROWNED/CRUSHED: ${dead.join(' ')}` : `${anchors.filter((a) => a.height < 0).length} anchors`);
}

console.log('\n== 10b. the vessel comes too, and survives ==');
{
  const g = makeGame();
  const p = g.player, v = g.vessel;
  p.inVessel = true;
  v.piloted = true;
  const r = teleportTo(g, TRENCH.x, null, TRENCH.z, { label: TRENCH.name });

  ok(vec3.dist(v.prevPosition, v.position) === 0, 'hull prevPosition == position', '');
  ok(Math.abs(quat.dot(v.prevOrientation, v.orientation) - 1) < 1e-6,
    'hull prevOrientation == orientation', '');
  ok(v._ctxWet === true,
    'the hull medium LATCH says wet (not just beta)',
    `underwater getter = ${v.underwater}`);
  ok(v._chaseValid === false,
    'the chase spring is invalidated (else the camera flies across the jump)', '');
  ok(v.aimYaw === wrapAngle(r.yaw) && v.prevAimYaw === v.aimYaw,
    'the aim is seeded and mirrored into its history slot',
    `aimYaw ${(v.aimYaw * 180 / Math.PI).toFixed(1)} deg`);
  ok(v._dirSeeded === true && v._dirYaw === v.aimYaw,
    'the direct model starts ON the aim, so step 1 commands nothing', '');
  // Derive the expectation rather than hard-coding a tier: the anchor moves when
  // the terrain does, and a literal here would assert the world instead of the code.
  const wantHull = hullTierForDepth(r.depth);
  ok(v.hullTier === wantHull && VESSEL.DEPTH_RATINGS[v.hullTier] >= r.depth
      && v.hull === VESSEL.MAX_HULL && v.hullMax === VESSEL.MAX_HULL,
    'the hull tier was granted and the integrity restored',
    `tier ${v.hullTier} rated ${VESSEL.DEPTH_RATINGS[v.hullTier]} m vs depth ${r.depth.toFixed(0)} m`);
  ok(p.inVessel === true && vec3.dist(p.position, v.position) === 0,
    'the player rides the hull from the first frame, before any sim step', '');

  // The crush is 9.0 * ((1319-220)/100)^1.60 = 417 dps against MAX_HULL 100 -
  // a tier-0 hull here is gone in 0.24 s, four times faster than the diver dies.
  const hull0 = v.hull;
  for (let i = 0; i < 120; i++) v.simulate(FIXED_DT, stubInput, i * FIXED_DT);
  ok(v.hull === hull0, 'hull intact after 2 s at the trench floor',
    `${v.hull.toFixed(1)}/${VESSEL.MAX_HULL} at ${v.depth.toFixed(0)} m`);
}

console.log('\n== 10f. the hull carries no state across the jump ==');
{
  // Trench floor -> beach, in the vessel. Everything here was measured surviving
  // the jump before it was written.
  const g = makeGame();
  g.player.inVessel = true;
  g.vessel.piloted = true;
  teleportTo(g, TRENCH.x, null, TRENCH.z, { label: 'down' });
  for (let i = 0; i < 60; i++) g.vessel.simulate(FIXED_DT, stubInput, i * FIXED_DT);
  const wetBallast = g.vessel.ballastVolume;
  const wetBeta = g.vessel.betaControl;

  // The motion-vector history. Without the seeding call the first applyRender()
  // rolls the DEPARTURE's node matrices into prevNodeMatrices: measured 3601.3 m
  // of per-node translation delta on frame 1, which is what entity.wgsl gets as
  // prevModel. camera.resetHistory() does NOT cover it - that equalises
  // prevViewProj, and per-object motion vectors are an independent source.
  // Drive the tanks hard away from neutral, so "it is at neutral afterwards" is
  // a claim about the teleport and not about the tanks happening to be there.
  g.vessel.ballastVolume = VESSEL.BALLAST_VOLUME;
  const floodedBallast = g.vessel.ballastVolume;

  const fired = [];
  const offEnter = events.on(EVENTS.VESSEL_ENTER_WATER, () => fired.push('enterWater'));
  const offExit = events.on(EVENTS.VESSEL_EXIT_WATER, () => fired.push('exitWater'));
  teleportTo(g, BEACH.x, null, BEACH.z, { label: 'up' });
  let worstNode = 0;
  for (let i = 0; i + 3 < g.vessel.prevNodeMatrices.length; i += 16) {
    worstNode = Math.max(worstNode,
      Math.hypot(g.vessel.prevNodeMatrices[i + 12] - g.vessel.nodeMatrices[i + 12],
        g.vessel.prevNodeMatrices[i + 13] - g.vessel.nodeMatrices[i + 13],
        g.vessel.prevNodeMatrices[i + 14] - g.vessel.nodeMatrices[i + 14]));
  }
  ok(worstNode < 0.01, 'prevNodeMatrices are seeded, so frame 1 has no motion vectors',
    `worst node delta ${worstNode.toExponential(2)} m over a ${vec3.dist([TRENCH.x, 0, TRENCH.z], [BEACH.x, 0, BEACH.z]).toFixed(0)} m jump`);

  ok(g.vessel.inWater === false && g.vessel._ctxWet === false,
    'the transition block agrees with the latch on dry land',
    `inWater ${g.vessel.inWater}, _ctxWet ${g.vessel._ctxWet}`);
  ok(g.vessel.betaControl === 0,
    'betaControl does not carry submergence onto the beach', `was ${wetBeta.toFixed(3)}`);
  // The tanks are an integrator, so they carry whatever the controller last drove
  // them to. trimNeutral() is the right target, not zero: zero is "blown", and a
  // hull that arrives with empty tanks is as wrong as one that arrives flooded.
  const neutral = VESSEL.BALLAST_VOLUME * g.vessel.neutralBallastFraction();
  ok(Math.abs(g.vessel.ballastVolume - neutral) < 1e-6,
    'the ballast tanks are trimmed to neutral, not carried across',
    `flooded ${floodedBallast.toFixed(3)} -> ${g.vessel.ballastVolume.toFixed(3)} m^3 (neutral ${neutral.toFixed(3)}, was ${wetBallast.toFixed(3)} submerged)`);
  ok(g.vessel.entryTimer === Infinity && g.vessel.breachTimer === Infinity,
    'the entry and breach timers are cleared', '');

  // _updateTransition compares inWater against the new sample, so a stale true
  // fires a water-exit - with its breach spray and 0.35x thrust notch - on sand.
  g.vessel.simulate(FIXED_DT, stubInput, 0);
  offEnter(); offExit();
  ok(fired.length === 0, 'no spurious water-entry/exit event on the first step ashore',
    fired.length ? fired.join(', ') : 'none');
}

console.log('\n== 10c. a land arrival stands on the ground ==');
{
  const g = makeGame();
  const p = g.player;
  const r = teleportTo(g, BEACH.x, null, BEACH.z, { label: BEACH.name });
  ok(!p.eyeSubmerged, 'the medium latch says dry',
    `y ${p.position[1].toFixed(2)}, ground ${r.height.toFixed(2)}`);
  ok(p.state === PLAYER_STATE.GROUNDED && p.grounded, 'state is GROUNDED', '');
  ok(Math.abs(p.position[1] - r.height) < 2.0,
    'the feet are on the terrain, not floating or buried',
    `feet ${p.position[1].toFixed(2)} vs sampleHeight ${r.height.toFixed(2)}`);

  // A y below the ground must be raised, not obeyed: the heightfield's underside
  // is back-face culled, so a buried camera photographs open water and any test
  // written against that frame goes green.
  const buried = teleportTo(g, BEACH.x, r.height - 50, BEACH.z, { label: 'buried' });
  ok(buried.snappedY === true && p.position[1] > r.height - 1,
    'a y inside the terrain is raised and reported',
    `asked ${(r.height - 50).toFixed(1)}, got ${p.position[1].toFixed(2)}`);

  // A supplied y ABOVE the ground is honoured verbatim.
  // 1e-3, not 1e-9: position is a Float32Array, so a metre value near 123 is
  // stored to about 8e-6 m. Asserting float64 equality here would be asserting
  // the storage format, not the behaviour.
  const flying = teleportTo(g, BEACH.x, r.height + 120, BEACH.z, { label: 'flying' });
  ok(!flying.snappedY && Math.abs(p.position[1] - (r.height + 120)) < 1e-3,
    'a y above the terrain is honoured exactly', `y ${p.position[1].toFixed(3)}`);
}

console.log('\n== 10e. the frame-history invalidation is handed the DESTINATION ==');
{
  // A teleport runs OUTSIDE the frame loop, and renderer.camera.position is not
  // written until _updateCamera() on the NEXT frame. A snap that read the camera
  // therefore classified the place we just LEFT: measured live, one frame after a
  // spawn-to-kelp jump the green sigmaT was 0.0801 against a correct 0.3025 - a
  // 3.8x error - because the column had been snapped to the beach and was then
  // springing from there over WATER_BLEND_TAU. So the snap takes a position, and
  // this asserts it is given one, at the EYE.
  const g = makeGame();
  const seen = { history: 0, adaptation: 0, at: null };
  g.renderer = {
    camera: { resetHistory: () => { seen.history++; } },
    resetAdaptation: () => { seen.adaptation++; },
  };
  g.snapWaterColumn = (at) => { seen.at = at ? Array.from(at) : null; };

  const kelp = byShort('kelp');
  const r = teleportTo(g, kelp.x, null, kelp.z, { label: kelp.name });
  ok(seen.history === 1, 'camera.resetHistory() is called (TAA would smear the jump)', '');
  ok(seen.adaptation === 1, 'renderer.resetAdaptation() is called (else a black dip)', '');
  ok(seen.at !== null, 'snapWaterColumn is given a position, not left to read the camera',
    seen.at ? `(${seen.at.map((v) => v.toFixed(0)).join(', ')})` : 'NO POSITION');
  if (seen.at) {
    const wantEyeY = r.y + g.player.currentEyeHeight;
    ok(Math.abs(seen.at[0] - r.x) < 1e-3 && Math.abs(seen.at[2] - r.z) < 1e-3
        && Math.abs(seen.at[1] - wantEyeY) < 1e-2,
      'and the position is the arrival EYE, which is what keys the water type',
      `eye y ${seen.at[1].toFixed(2)} vs feet ${r.y.toFixed(2)}`);
  }
}

console.log('\n== 10d. gear is granted, never stripped ==');
{
  const g = makeGame();
  g.player.setSuitTier(4);
  g.vessel.hullTier = 4;
  teleportTo(g, BEACH.x, null, BEACH.z, { label: 'shallow' });
  ok(g.player.suitTier === 4, 'a shallow jump does not strip a suit upgrade',
    `tier ${g.player.suitTier}`);
  ok(g.vessel.hullTier === 4, 'a shallow jump does not strip a hull upgrade',
    `tier ${g.vessel.hullTier}`);

  const g2 = makeGame();
  teleportTo(g2, TRENCH.x, null, TRENCH.z, { grantGear: false, label: 'no gear' });
  ok(g2.player.suitTier === 0, 'grantGear:false leaves the suit alone',
    `tier ${g2.player.suitTier} at ${Math.max(0, -TRENCH.height).toFixed(0)} m`);
}

console.log('\n== 11. authored places are terrain-truthful, classified and survivable ==');
{
  // The places layer authors coordinates against the default seed, and every
  // one of its claims is re-measured here rather than trusted: the sampled
  // seabedY against the live terrain (drift guard - the world moving under a
  // place is silent everywhere else), the water override against the real
  // classifier, the prop delivery against the real placement loop, and the
  // arrival against a real Player.
  let driftBad = 0, boundsBad = 0, aimBad = 0;
  for (const p of PLACES) {
    const v = validateTarget(p.x, p.z);
    if (!v.ok || v.warn) boundsBad++;
    const h = terrain.sampleHeight(p.x, p.z);
    if (Math.abs(h - p.seabedY) > 1e-9) {
      driftBad++;
      console.log(`       ${p.short}: seabedY drifted ${p.seabedY} -> ${h}`);
    }
    // The arrival yaw was authored with the compass convention, aimed AT the
    // place centre from the arrival eye: yaw = atan2(dx, -dz).
    const wantYaw = Math.atan2(p.x - p.arrival.x, -(p.z - p.arrival.z));
    if (Math.abs(wrapAngle(p.arrival.yaw - wantYaw)) > 0.02) aimBad++;
    if (!Number.isFinite(p.arrival.pitch) || Math.abs(p.arrival.pitch) > 1.2) aimBad++;
  }
  ok(boundsBad === 0, 'every place is inside the world, clear of the push-back ramp',
    `${PLACES.length} places, worst r ${Math.max(...PLACES.map((p) => Math.hypot(p.x, p.z))).toFixed(0)} of ${WORLD.SOFT_BOUNDARY}`);
  ok(driftBad === 0, 'every sampled seabedY still matches the terrain to the bit',
    `${PLACES.length - driftBad}/${PLACES.length} at seed ${WORLD.DEFAULT_SEED}`);
  ok(aimBad === 0, 'every arrival is aimed AT its subject with the compass convention',
    `yaw = atan2(dx, -dz) within 0.02 rad`);

  // THE WATER OVERRIDE SURVIVES CLASSIFICATION, which the aphotic gate and the
  // column ceiling both had a veto over - this is the measurement, not an
  // assumption. Probed per authored disc: the LAST-listed (innermost) disc at
  // the centre, each outer disc between its own inner edge and the next disc
  // out, and the un-overridden column 40 m past the outermost radius.
  //
  // IT ITERATES `WATER_DISC_SITES`, NOT `PLACES`, and it passes `terrain` so
  // the SMOOTHED classifier runs. Both are load-bearing and Pelagos Station is
  // why: the habitat is an authored site that is not a place, and the column
  // it authors is one it loses on the unsmoothed vote by a hair and on the
  // smoothed vote outright (its 24 m ring taps land on the Boulder Field
  // slopes around the clearing, boulders 0.589 against sand 0.411). Probing
  // without the ring taps would assert on an answer no frame is ever shaded
  // with - main.js always passes the terrain - and would have called the
  // green station a pass.
  const waterBad = [];
  for (const p of WATER_DISC_SITES) {
    if (!p.water) continue;
    for (let k = 0; k < p.water.length; k++) {
      const w = p.water[k];
      const dist = k === p.water.length - 1
        ? 0 : (p.water[k + 1].radius + (w.radius - w.feather)) / 2;
      const px = p.x + dist, pz = p.z;
      const hh = terrain.sampleHeight(px, pz);
      const got = waterTypeAt(px, pz, hh, Math.max(0, -hh), terrain.sampleSlope(px, pz), terrain);
      if (got !== WATER_TYPES[w.type]) waterBad.push(`${p.short}@${dist.toFixed(0)}m ${got.name} != ${w.type}`);
    }
    const far = p.water[0].radius + 40;
    const hh = terrain.sampleHeight(p.x + far, p.z);
    const got = waterTypeAt(p.x + far, p.z, hh, Math.max(0, -hh), terrain.sampleSlope(p.x + far, p.z), terrain);
    if (got === WATER_TYPES[p.water[0].type]) waterBad.push(`${p.short} leaks ${p.water[0].type} to r=${far}`);
  }
  ok(waterBad.length === 0, 'every authored water disc classifies as authored, and no further',
    waterBad.length ? waterBad.join('; ')
      : 'VENT_SMOKE core / VENT_HAZE field / BRINE lens / PELAGOS_AQUA clearing all live');

  // THE PROPS ARE DELIVERED BY THE REAL PLACEMENT LOOP. Sum each place's prop
  // types over the chunk neighbourhood covering its radius; the injected
  // instances must at least account for the authored counts (natural
  // populations of shared rows can only add).
  const propBad = [];
  for (const p of PLACES) {
    if (!p.props) continue;
    const counts = new Map();
    const c0x = Math.floor((p.x - p.radius) / WORLD.CHUNK_SIZE);
    const c1x = Math.floor((p.x + p.radius) / WORLD.CHUNK_SIZE);
    const c0z = Math.floor((p.z - p.radius) / WORLD.CHUNK_SIZE);
    const c1z = Math.floor((p.z + p.radius) / WORLD.CHUNK_SIZE);
    for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) {
      const r = generateScatterForChunk(cx, cz, 0);
      for (const prop of p.props) {
        const id = SCATTER_BY_KEY[prop.type].id;
        counts.set(prop.type, (counts.get(prop.type) ?? 0) + r.countsByType[id]);
      }
    }
    for (const prop of p.props) {
      if ((counts.get(prop.type) ?? 0) < prop.count) {
        propBad.push(`${p.short}.${prop.type} ${counts.get(prop.type) ?? 0}/${prop.count}`);
      }
    }
  }
  ok(propBad.length === 0, 'every place prop cluster is delivered by the placement loop',
    propBad.length ? propBad.join('; ') : PLACES.map((p) => `${p.short} ${p.props?.length ?? 0} clusters`).join(', '));

  // EVERY PLACE ARRIVAL IS SURVIVABLE ON FOOT, same 90 s bar as the anchors.
  const HOLD = 90;
  const steps = Math.round(HOLD / FIXED_DT);
  const dead = [];
  for (const p of PLACES) {
    const g = makeGame();
    const a = p.arrival;
    teleportTo(g, a.x, a.y, a.z, { yaw: a.yaw, pitch: a.pitch, label: p.name });
    let diedAt = -1;
    for (let i = 0; i < steps; i++) {
      g.player.simulate(FIXED_DT, stubInput, i * FIXED_DT);
      if (!g.player.alive) { diedAt = i * FIXED_DT; break; }
    }
    if (diedAt >= 0) dead.push(`${p.short}@${diedAt.toFixed(1)}s`);
  }
  ok(dead.length === 0, `all place arrivals survive ${HOLD} s on foot`,
    dead.length ? dead.join(' ') : `${PLACES.length} places`);
}

// ===========================================================================

console.log(`\n${fails === 0 ? 'ALL PASS' : `${fails} FAILURE(S)`}\n`);
process.exit(fails === 0 ? 0 : 1);
