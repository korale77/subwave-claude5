// Probe: the LARGE-ANIMAL half of "they always look away from us". The report
// names rays, and rays are the worst case in the whole bestiary.
//
//   node tools/probe.mjs --file tools/probes/ray-approach-ab.js
//
// WHY A LARGE ANIMAL NEEDS ITS OWN PROBE. rPanic is max(2 + 12L, 4 + 6L), so it
// runs 4.13 m on a Glimmerkrill and 17.6 m on a Sandveil Ray, 57.2 m on a
// Gloomray and 218 m on a Veilmouth. tools/probes/facing-normalised.js measures
// the whole population and finds the >1.0 m class at relative-bearing
// concentration 0.998 and tail-on fraction 1.000 - but on n = 15, because the
// lagoon is mostly sprats. This follows ONE identified large animal so the N is
// the sample count and not the population.
//
// TWO PHASES, because they answer different questions:
//
//   ORBIT    - "can we go round it and see its face?" Circles the animal and
//              measures where its nose points relative to the diver.
//   APPROACH - "can we get near it at all?" Swims straight at it and records the
//              closest separation achieved. This is the number the player feels
//              and no existing probe measures it for a large animal. It is also
//              what shows the stand-off SURVIVED a fix aimed at the bearing -
//              but read `hitRail` first, see APPROACH_STOP.
//
// DO NOT READ `relBearingConcentration` AS THE HEADLINE. It measures only
// whether the relative bearing is CONSTANT, and both the bug and the fix hold it
// constant - at 180 deg and at 90 deg respectively. A perfect tangential escape
// makes the animal circle the diver as the diver circles it, which pins the beam
// aspect and drives concentration to 1.0. Measured over three runs of the SAME
// fixed build, arm A came back 0.096 / 0.998 / 0.910 while the mean absolute
// relative bearing stayed at 86-93 deg. Quoting the concentration would have
// reported the fix as a regression two runs out of three.
//
// THE DISCRIMINATING STATISTICS ARE `meanAbsRelBearingDeg` AND `tailOnFrac`:
// 180 deg / 1.000 is the animal holding its tail to you, 90 deg / 0.000 is the
// flank, 0 deg is nose-on. Concentration is still reported because it separates
// "locked broadside" from "ignoring you", but it is a secondary reading.
//
// A/B/A on the SAME handle, with BEHAVIOUR_MUL's FLEE column zeroed for the
// middle arm. This is the one A/B shape STATUS's "Measurement bugs" says is
// valid: toggling a weight adds and removes no agent, so the PRNG stream is
// bit-identical in all three arms. (Contrast test-creatures.mjs section 19,
// where removing a predator shifted every other agent's wander draws and
// manufactured a flee response from 10 of 11 species that could not exist.)
//
// The A2 arm is not redundant. If A and A2 disagree, the run drifted and B
// means nothing.
//
// An orbit on its own is NOT evidence - see STATUS, the same manoeuvre against
// one unmodified build reported 12, then 1, then 0 locked animals. It is
// admissible here only because all three arms follow one identified handle, so
// the orbit lottery is held fixed instead of being sampled.

const g = window.subwave;
const { quat } = await import('/src/core/math.js');
const C = await import('/src/entities/creatures.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CENTRE = [0, -8, 240];
const FILL_MS = 10000;
const ORBIT_MS = 6000;
const APPROACH_MS = 8000;
const STEP_MS = 200;
// A plausible looking-at-it range, but capped to a fraction of the animal's own
// PLAYER panic radius. Orbiting outside that radius measures nothing: the flee
// term is identically zero there, so all three arms read the same and the run
// is uninterpretable. Learned the hard way - at a fixed 6 m against a 4.86 m
// player radius the A and A2 arms came back 0.010 and 0.967 with no force
// acting in either.
const ORBIT_R_MAX = 6;
const ORBIT_R_FRAC = 0.55;
const APPROACH_FROM = 20;     // start outside a 17.6 m ray radius
// 3.0 m/s against the swim contract's 4.0 m/s cruise. It must be fast enough
// that the window covers the whole gap: at 1.6 m/s over 6 s the diver crossed
// 9.6 m of a 20 m start and the run measured the DEADLINE, not the stand-off -
// the separation trail was still falling linearly when it stopped.
const APPROACH_SPEED = 3.0;
// How close the diver is willing to push. THIS IS A RAIL AND closestApproach
// SITS ON IT IF THE ANIMAL DOES NOT HOLD YOU OFF - at the 1.0 m it started as,
// arm A read 1.05 m and arm B 0.91 m and the difference was the instrument, not
// the stand-off. 0.25 m is below any stand-off this code can produce, and
// `hitRail` says outright whether the number is a measurement or the limit.
const APPROACH_STOP = 0.25;
const MIN_BODY = 1.0;         // the size class the report is about
const PREFER = 'CRT_SANDVEIL';

const sim = g.creatures;
const st = C.SPECIES_TABLE;
const fwd = [0, 0, 0];
const r3 = (v) => (v === null || v === undefined || !isFinite(v) ? null : +v.toFixed(3));

// The diver is teleported rather than swum, because the question is about the
// ANIMAL's response and a real swim cannot hold a controlled range.
const realSimulate = g.player.simulate.bind(g.player);
const pin = { pos: CENTRE.slice(), yaw: 0 };
// EVERY OVERRIDE BELOW IS RESTORED IN A finally. Without one, an exception
// between the two setFlee calls leaves the LIVE GAME with BEHAVIOUR_MUL's whole
// FLEE column zeroed - no animal flees anything, silently, for the rest of the
// session - and every later probe or screenshot in that browser is invalid.
const wasInVessel = g.player.inVessel;
g.player.inVessel = false;
g.player.simulate = () => {
  const p = g.player;
  p.prevPosition.set(p.position);
  quat.copy(p.prevOrientation, p.orientation);
  p.position[0] = pin.pos[0]; p.position[1] = pin.pos[1]; p.position[2] = pin.pos[2];
  p.velocity[0] = 0; p.velocity[1] = 0; p.velocity[2] = 0;
  p.yaw = pin.yaw; p.pitch = 0; p.roll = 0;
  quat.fromEuler(p.orientation, p.yaw, 0, 0);
};

await sleep(FILL_MS);

// ---- pick the target -------------------------------------------------------
// Largest body within reach, with the named ray winning ties outright so the
// run is comparable between sessions when one is present.
let best = -1, bestScore = -Infinity, bestD = Infinity;
for (const i of sim.liveSlots()) {
  const L = sim.bodyLength[i];
  if (L < MIN_BODY) continue;
  const d = Math.hypot(sim.posX[i] - CENTRE[0], sim.posY[i] - CENTRE[1],
    sim.posZ[i] - CENTRE[2]);
  if (d > 80) continue;
  const score = (st.id[sim.species[i]] === PREFER ? 1000 : 0) + L - d * 0.01;
  if (score > bestScore) { bestScore = score; best = i; bestD = d; }
}
if (best < 0) {
  g.player.simulate = realSimulate;
  g.player.inVessel = wasInVessel;
  return { error: `no animal with bodyLength >= ${MIN_BODY} m within 80 m of the lagoon ` +
    'census point. Re-run, or move CENTRE to a station that carries one.' };
}
const handle = sim.handleOf(best);
// The radius the PLAYER branch actually uses. Falls back to the predator radius
// on builds from before the split, so this probe reads both.
const rPlayer = C.playerPanicRadius
  ? C.playerPanicRadius(sim.bodyLength[best])
  : Math.max(C.PANIC_FLOOR_M + C.PANIC_BODY_LENGTHS * sim.bodyLength[best],
    C.fearFleeRadius(sim.bodyLength[best]));
const ORBIT_R = Math.min(ORBIT_R_MAX, ORBIT_R_FRAC * rPlayer);
const target = {
  handle,
  species: st.id[sim.species[best]],
  bodyLength: r3(sim.bodyLength[best]),
  tier: sim.tier[best],
  rPredator: r3(Math.max(C.PANIC_FLOOR_M + C.PANIC_BODY_LENGTHS * sim.bodyLength[best],
    C.fearFleeRadius(sim.bodyLength[best]))),
  rPlayer: r3(rPlayer),
  orbitRadius: r3(ORBIT_R),
  orbitFracOfRadius: r3(ORBIT_R / rPlayer),
  foundAtDist: r3(bestD),
};

// ---- FLEE column toggle ----------------------------------------------------
const saved = [];
for (let b = 0; b < C.BEHAVIOUR_COUNT; b++) {
  saved.push(C.BEHAVIOUR_MUL[b * C.STEER_COUNT + C.STEER.FLEE]);
}
const setFlee = (on) => {
  for (let b = 0; b < C.BEHAVIOUR_COUNT; b++) {
    C.BEHAVIOUR_MUL[b * C.STEER_COUNT + C.STEER.FLEE] = on ? saved[b] : 0;
  }
};

const relBearingTo = (j) => {
  const o = j * 4;
  quat.forward(fwd, [sim.orient[o], sim.orient[o + 1], sim.orient[o + 2], sim.orient[o + 3]]);
  const bx = pin.pos[0] - sim.posX[j], bz = pin.pos[2] - sim.posZ[j];
  const inv = 1 / Math.max(Math.hypot(bx, bz), 1e-6);
  const tx = bx * inv, tz = bz * inv;    // animal -> diver, horizontal unit
  // Signed angle from the animal's forward to the diver. 0 = nose-on,
  // +-180 = tail-on.
  return Math.atan2(fwd[0] * tz - fwd[2] * tx, fwd[0] * tx + fwd[2] * tz);
};

async function orbit(label) {
  const t0 = performance.now();
  const rel = [];
  const behaviours = new Map();
  let spd = 0, sep = 0, vesselWins = 0, lost = false;
  while (performance.now() - t0 < ORBIT_MS) {
    const j = sim.slotOf(handle);
    if (j < 0) { lost = true; break; }
    const phi = ((performance.now() - t0) / ORBIT_MS) * Math.PI * 2;
    pin.pos[0] = sim.posX[j] + Math.sin(phi) * ORBIT_R;
    pin.pos[1] = sim.posY[j];
    pin.pos[2] = sim.posZ[j] - Math.cos(phi) * ORBIT_R;
    pin.yaw = Math.atan2(sim.posX[j] - pin.pos[0], -(sim.posZ[j] - pin.pos[2]));
    await sleep(STEP_MS);
    const k = sim.slotOf(handle);
    if (k < 0) { lost = true; break; }
    rel.push(relBearingTo(k));
    // WITHOUT THESE THE ARM CANNOT BE READ. An animal that is not being pushed
    // and an animal that is being pushed tangentially both give a low
    // concentration, and the behaviour row decides which multiplier the FLEE
    // weight even had. The true separation catches an orbit that has drifted
    // outside the radius it was supposed to be testing inside.
    const bn = C.BEHAVIOUR_NAMES[sim.behaviour[k]];
    behaviours.set(bn, (behaviours.get(bn) || 0) + 1);
    spd += Math.hypot(sim.velX[k], sim.velY[k], sim.velZ[k]);
    sep += Math.hypot(sim.posX[k] - pin.pos[0], sim.posY[k] - pin.pos[1],
      sim.posZ[k] - pin.pos[2]);
    // WHICH THREAT IS WINNING. The FLEE block picks the NEAREST of the diver,
    // the sub and a predator, and only the first two get the tangential escape.
    // If the parked sub is closer than the diver, this probe is measuring the
    // vessel and saying "player"; if a predator is closer still, it is measuring
    // the radial branch and the whole run is void.
    if (sim.distToVessel[k] < sim.distToPlayer[k]) vesselWins++;
  }
  if (lost || rel.length < 10) return { phase: 'orbit', label, lost: true, samples: rel.length };
  const cs = rel.reduce((a, x) => a + Math.cos(x), 0);
  const sn = rel.reduce((a, x) => a + Math.sin(x), 0);
  return {
    phase: 'orbit', label, samples: rel.length, lost: false,
    meanSeparation: r3(sep / rel.length),
    meanSpeed: r3(spd / rel.length),
    behaviours: Object.fromEntries(behaviours),
    fracVesselNearerThanDiver: r3(vesselWins / rel.length),
    // 1.0 = the animal holds one bearing to the diver through the whole circle,
    // i.e. it rotated with us. 0 = we genuinely went round it.
    relBearingConcentration: r3(Math.hypot(cs, sn) / rel.length),
    meanAbsRelBearingDeg: r3(rel.reduce((a, x) => a + Math.abs(x), 0) / rel.length * 180 / Math.PI),
    tailOnFrac: r3(rel.filter((x) => Math.abs(x) > 2.356).length / rel.length),
    noseOnFrac: r3(rel.filter((x) => Math.abs(x) < 0.785).length / rel.length),
  };
}

async function approach(label) {
  let j = sim.slotOf(handle);
  if (j < 0) return { phase: 'approach', label, lost: true };
  // Start APPROACH_FROM out along the animal's current bearing from the centre,
  // so the diver comes in from outside even a large panic radius.
  let ax = sim.posX[j], ay = sim.posY[j], az = sim.posZ[j];
  let bx = pin.pos[0] - ax, bz = pin.pos[2] - az;
  let bl = Math.hypot(bx, bz) || 1;
  pin.pos[0] = ax + (bx / bl) * APPROACH_FROM;
  pin.pos[1] = ay;
  pin.pos[2] = az + (bz / bl) * APPROACH_FROM;

  const t0 = performance.now();
  let minD = Infinity;
  const trail = [];
  let lost = false;
  let last = performance.now();
  while (performance.now() - t0 < APPROACH_MS) {
    await sleep(STEP_MS);
    j = sim.slotOf(handle);
    if (j < 0) { lost = true; break; }
    const now = performance.now();
    const dt = (now - last) / 1000; last = now;
    ax = sim.posX[j]; ay = sim.posY[j]; az = sim.posZ[j];
    const dx = ax - pin.pos[0], dy = ay - pin.pos[1], dz = az - pin.pos[2];
    const d = Math.hypot(dx, dy, dz);
    if (d < minD) minD = d;
    trail.push(r3(d));
    // Walk toward it, but never through it: a diver stops at arm's length.
    const stepLen = Math.min(APPROACH_SPEED * dt, Math.max(0, d - APPROACH_STOP));
    if (d > 1e-3 && stepLen > 0) {
      pin.pos[0] += (dx / d) * stepLen;
      pin.pos[1] += (dy / d) * stepLen;
      pin.pos[2] += (dz / d) * stepLen;
    }
    pin.yaw = Math.atan2(dx, -dz);
  }
  if (lost) return { phase: 'approach', label, lost: true };
  return {
    phase: 'approach', label, lost: false,
    startedAt: APPROACH_FROM,
    // THE PLAYER-FACING NUMBER. How close the diver actually got, in metres,
    // while swimming straight at the animal for APPROACH_MS.
    closestApproach: r3(minD),
    // If true the diver ran out of willingness, not out of room, and
    // closestApproach is APPROACH_STOP rather than a stand-off.
    hitRail: minD <= APPROACH_STOP * 1.05,
    finalSeparation: trail.length ? trail[trail.length - 1] : null,
    // The animal outruns the diver if this never falls.
    separationTrail: trail.filter((_, k) => k % 3 === 0),
  };
}

const arms = [];
try {
  arms.push(await orbit('A: FLEE on'));
  arms.push(await approach('A: FLEE on'));
  setFlee(false);
  arms.push(await orbit('B: FLEE column zeroed'));
  arms.push(await approach('B: FLEE column zeroed'));
  setFlee(true);
  arms.push(await orbit('A2: FLEE restored'));
  arms.push(await approach('A2: FLEE restored'));
} finally {
  setFlee(true);
  g.player.simulate = realSimulate;
  g.player.inVessel = wasInVessel;
}

return {
  probe: 'ray-approach-ab',
  target,
  approach: { from: APPROACH_FROM, speed: APPROACH_SPEED, durationS: APPROACH_MS / 1000 },
  arms,
  note: 'Read meanAbsRelBearingDeg and tailOnFrac, NOT relBearingConcentration ' +
        '- a tangential escape pins the bearing at 90 deg and so maxes the ' +
        'concentration exactly as a tail-on lock pins it at 180 deg. 180 / 1.0 ' +
        'is the bug, 90 / 0.0 is the flank. A and A2 must agree or the run ' +
        'drifted and B means nothing. closestApproach is the stand-off and is ' +
        'a separate question from the bearing.',
};
