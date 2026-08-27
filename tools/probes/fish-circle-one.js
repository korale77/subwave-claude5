// Probe: pick ONE fish, keep it by handle, and walk the eye around it.
//
//   node tools/probe.mjs --file tools/probes/fish-circle-one.js
//
// This is the reported complaint stated as an experiment: "even if we try to
// swim around them we can't go on their side". Churn cannot confound it,
// because the same HANDLE is followed for the whole sweep and the run is
// rejected if the handle dies.
//
// The eye is placed at (fish + R * [sin(phi), 0, -cos(phi)]) with phi swept a
// full turn, so the PLAYER's bearing from the fish is a controlled input. The
// measured output is the fish's WORLD heading.
//
//   slope d(fishHeading)/d(playerBearing) ~ 1  the animal re-points with you.
//                                              There is no side to get on.
//   slope ~ 0                                  the animal holds a world
//                                              heading; you can circle it.
//
// THREE radii, and the point of the set is that the panic radius moved:
//   3 m   inside rPanic for every tier-0 lagoon species under BOTH the old
//         floor (8 m) and the new one (2 m). The fish must still yield here -
//         nothing may swim through the camera - it just must not lock on.
//   6 m   inside rPanic under the old floor (8.25-14.60 m) and OUTSIDE it for a
//         small fish under the new one (Sunplate 4.72 m). This is the radius
//         the reported complaint is about.
//   20 m  outside every rPanic before and after. The control: whatever it
//         reads, it must read the same either way.
//
// It also decomposes the steering force, recomputing the FLEE term exactly as
// `_steer` does - falloff included - so the claim "the repulsion dominates" is
// a number and not an adjective. The panic radius is IMPORTED rather than
// retyped, because a probe that hardcodes the formula measures the formula it
// was written against and not the one that is running.

const g = window.subwave;
const { quat } = await import('/src/core/math.js');
const C = await import('/src/entities/creatures.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CENTRE = [0, -8, 240];
const RADII = [3, 6, 20];
const SWEEP_MS = 15000;
const STEP_MS = 250;
const panicRadius = (bodyLength) => C.PANIC_FLOOR_M + C.PANIC_BODY_LENGTHS * bodyLength;

const sim = g.creatures;
const st = C.SPECIES_TABLE;
const fwd = [0, 0, 0];

const realSimulate = g.player.simulate.bind(g.player);
const pin = { pos: CENTRE.slice(), yaw: 0 };
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

await sleep(12000);

function pickTarget() {
  let best = -1, bd = Infinity;
  for (const i of sim.liveSlots()) {
    if (sim.tier[i] > 0) continue;
    if (st.speedBase[sim.species[i]] < 0.3) continue;    // not a sessile cropper
    const d = Math.hypot(sim.posX[i] - CENTRE[0], sim.posY[i] - CENTRE[1],
      sim.posZ[i] - CENTRE[2]);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

function unwrapSlope(xs, ys) {
  const un = (a) => { const o = [a[0]]; for (let k = 1; k < a.length; k++) {
    let d = a[k] - a[k - 1]; while (d > 180) d -= 360; while (d < -180) d += 360;
    o.push(o[k - 1] + d); } return o; };
  const x = un(xs), y = un(ys);
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let k = 0; k < n; k++) {
    sxy += (x[k] - mx) * (y[k] - my); sxx += (x[k] - mx) ** 2; syy += (y[k] - my) ** 2;
  }
  return {
    slope: sxx > 1e-6 ? +(sxy / sxx).toFixed(3) : null,
    r2: sxx > 1e-6 && syy > 1e-6 ? +((sxy * sxy) / (sxx * syy)).toFixed(3) : null,
    playerBearingSweptDeg: +(Math.max(...x) - Math.min(...x)).toFixed(0),
    fishHeadingSweptDeg: +(Math.max(...y) - Math.min(...y)).toFixed(0),
  };
}

async function sweep(handle, R) {
  const t0 = performance.now();
  const playerBearing = [], fishHeading = [], rel = [], dist = [];
  const fleeFrac = [], steerMag = [];
  let lost = false;
  while (performance.now() - t0 < SWEEP_MS) {
    const i = sim.slotOf(handle);
    if (i < 0) { lost = true; break; }
    const phi = ((performance.now() - t0) / SWEEP_MS) * Math.PI * 2;
    // Place the eye on a circle around the animal's CURRENT position, so the
    // controlled variable really is the bearing and not a stale one.
    pin.pos[0] = sim.posX[i] + Math.sin(phi) * R;
    pin.pos[1] = sim.posY[i];
    pin.pos[2] = sim.posZ[i] - Math.cos(phi) * R;
    // Look at the animal.
    pin.yaw = Math.atan2(sim.posX[i] - pin.pos[0], -(sim.posZ[i] - pin.pos[2]));
    await sleep(STEP_MS);

    const j = sim.slotOf(handle);
    if (j < 0) { lost = true; break; }
    const o = j * 4;
    quat.forward(fwd, [sim.orient[o], sim.orient[o + 1], sim.orient[o + 2], sim.orient[o + 3]]);
    const h = Math.atan2(fwd[0], -fwd[2]) * 180 / Math.PI;
    // Bearing of the PLAYER as seen from the fish, same convention.
    const bx = pin.pos[0] - sim.posX[j], bz = pin.pos[2] - sim.posZ[j];
    const bearing = Math.atan2(bx, -bz) * 180 / Math.PI;
    const d = Math.hypot(bx, sim.posY[j] - pin.pos[1], bz);
    // Relative bearing: 0 = tail toward the eye.
    const inv = 1 / Math.max(d, 1e-6);
    const tx = -bx * inv, tz = -bz * inv;      // eye -> fish
    const rb = Math.atan2(fwd[0] * tz - fwd[2] * tx, fwd[0] * tx + fwd[2] * tz) * 180 / Math.PI;

    playerBearing.push(bearing); fishHeading.push(h); rel.push(rb); dist.push(d);

    // ---- force decomposition, recomputed exactly as _steer does -----------
    const a = C.ARCHETYPES[sim.archetype[j]];
    const b = sim.behaviour[j];
    const wFlee = a.w[C.STEER.FLEE] * C.BEHAVIOUR_MUL[b * C.STEER_COUNT + C.STEER.FLEE];
    const rPanic = panicRadius(sim.bodyLength[j]);
    let mag = 0;
    if (wFlee > 0 && sim.distToPlayer[j] < rPanic) {
      // _maxSpeed for a non-FLEE, non-ATTACK behaviour.
      const vMax = st.speedBase[sim.species[j]] * (0.90 + 0.25 * (1 - sim.energy[j]));
      const dx = sim.posX[j] - pin.pos[0];
      const dy = sim.posY[j] - pin.pos[1];
      const dz = sim.posZ[j] - pin.pos[2];
      const dd = Math.hypot(dx, dy, dz) || 1;
      const s = vMax / dd;
      // The falloff, exactly as _steer applies it: the WHOLE velocity-relative
      // term is scaled, not only the target-velocity half.
      const fall = Math.max(0, Math.min(1, 1 - sim.distToPlayer[j] / rPanic));
      mag = wFlee * fall * Math.hypot(dx * s - sim.velX[j], dy * s - sim.velY[j],
        dz * s - sim.velZ[j]);
    }
    fleeFrac.push(mag / a.aMax);
    steerMag.push(Math.hypot(sim.steerX[j], sim.steerY[j], sim.steerZ[j]) / a.aMax);
  }
  if (lost || playerBearing.length < 20) {
    return { radius: R, lost: true, samples: playerBearing.length };
  }
  const fit = unwrapSlope(playerBearing, fishHeading);
  const mean = (a) => +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3);
  return {
    radius: R, samples: playerBearing.length, lost: false,
    slopeFishHeadingVsPlayerBearing: fit.slope, r2: fit.r2,
    playerBearingSweptDeg: fit.playerBearingSweptDeg,
    fishHeadingSweptDeg: fit.fishHeadingSweptDeg,
    meanAbsRelBearingDeg: +(rel.reduce((a, x) => a + Math.abs(x), 0) / rel.length).toFixed(1),
    relBearingConcentration: +(Math.hypot(
      rel.reduce((a, x) => a + Math.cos(x * Math.PI / 180), 0),
      rel.reduce((a, x) => a + Math.sin(x * Math.PI / 180), 0)) / rel.length).toFixed(3),
    meanDist: mean(dist), minDist: +Math.min(...dist).toFixed(2),
    meanFleeTermAsFractionOfAMax: mean(fleeFrac),
    maxFleeTermAsFractionOfAMax: +Math.max(...fleeFrac).toFixed(3),
    meanDeliveredSteerAsFractionOfAMax: mean(steerMag),
  };
}

const slot = pickTarget();
const handle = slot >= 0 ? sim.handleOf(slot) : -1;
const info = slot >= 0 ? {
  handle, species: st.id[sim.species[slot]],
  archetype: C.ARCHETYPES[sim.archetype[slot]].name,
  bodyLength: +sim.bodyLength[slot].toFixed(3),
  rPanic: +panicRadius(sim.bodyLength[slot]).toFixed(2),
  panicFloorM: C.PANIC_FLOOR_M,
  panicBodyLengths: C.PANIC_BODY_LENGTHS,
  speedBase: +st.speedBase[sim.species[slot]].toFixed(2),
  aMax: C.ARCHETYPES[sim.archetype[slot]].aMax,
} : null;

// Effective steering weights for this animal in each behaviour it can be in,
// so "the FLEE term is the largest weight in the row" is checkable.
const weightRows = {};
if (slot >= 0) {
  const a = C.ARCHETYPES[sim.archetype[slot]];
  for (const bName of ['IDLE', 'SCHOOL', 'FORAGE']) {
    const b = C.BEHAVIOUR[bName];
    const row = {};
    for (const [k, s] of Object.entries(C.STEER)) {
      row[k] = +(a.w[s] * C.BEHAVIOUR_MUL[b * C.STEER_COUNT + s]).toFixed(3);
    }
    weightRows[bName.toLowerCase()] = row;
  }
}

const sweeps = [];
for (const R of RADII) {
  if (slot < 0) break;
  sweeps.push(await sweep(handle, R));
}

g.player.simulate = realSimulate;

return {
  target: info,
  effectiveSteerWeights: weightRows,
  sweeps,
  note: 'slope 1 = the animal turns with the diver (no side to get on); ' +
        'slope 0 = the animal holds a world heading. relative bearing 0 deg = ' +
        'tail toward the eye. CONFOUND, recorded once already: the slope is ' +
        'only admissible when the animal is not already turning at a steady ' +
        'rate of its own - check fishHeadingSweptDeg against ' +
        'playerBearingSweptDeg before quoting it. The concentration R is not ' +
        'confounded that way and is the statistic to lead with.',
};
