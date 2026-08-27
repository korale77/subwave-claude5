// Probe: do fish hold a fixed bearing RELATIVE TO THE PLAYER?
//
//   node tools/probe.mjs --file tools/probes/fish-facing.js
//
// Reported from play: "the fish seem to always look in the same direction
// relative to us, so even if we try to swim around them to see all around, they
// turn with us so we can't go on their side."
//
// Three hypotheses, and they need different fixes, so the point of this probe is
// to tell them apart rather than to confirm the symptom:
//
//   BILLBOARD  the render orientation is built in view space. Ruled out by
//              reading creatures.js - it uses quat.lookRotation on the swim
//              direction, which is world space - but measured here anyway,
//              because "I read the code" is not evidence.
//   FLEE       the animals genuinely swim away from the player, so the tail is
//              always toward the eye. Real behaviour, wrong intensity.
//   CHURN      the near-field director retires whatever the player swims past
//              and re-seeds ahead, so you never circle the SAME fish. That
//              would read identically and is not an orientation bug at all.
//
// The discriminator is agent IDENTITY. Track individual slots by handle: if the
// same handle keeps a fixed relative bearing while its WORLD heading changes,
// that is FLEE. If world headings are stable and the handles keep changing, it
// is CHURN. If relative bearing is pinned regardless of anything, it is a
// billboard.
//
// ---------------------------------------------------------------------------
// 2026-07-31: THIS PROBE WAS BROKEN TWICE OVER, AND ITS OUTPUT WAS THE SOLE
// EVIDENCE FOR A "CHURN" DIAGNOSIS THAT WAS WRONG.
//
//  1. The Player.simulate override wrote `position` but never `prevPosition`,
//     and never called the real simulate. Player.applyCamera is
//     vec3.lerp(out, prevPosition, position, alpha), so the camera was
//     interpolated between the BEACH SPAWN and the lagoon every frame: MEASURED
//     mean 447.71 m from the player (min 330.54, max 670.40). The probe then
//     counted fish within 30 m OF THE CAMERA - 2.1 against 39.7 actually within
//     30 m of the player, an 18.9x undercount. "17 handles, zero survivors" is
//     that artefact and nothing else.
//  2. The relative-bearing sign was inverted against the comment below it, so
//     the reported "144-146 deg, therefore a flee component on top" read the
//     number backwards.
//
// Both are fixed here, and a HARD SELF-TEST now aborts the run if the camera
// ever separates from the player, because that failure is silent and produces
// stable, plausible numbers. Anything quoted from this probe before that date
// should be re-measured.
// ---------------------------------------------------------------------------

const g = window.subwave;
const { vec3, quat } = await import('/src/core/math.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EYE = [0, -8, 240];
const ORBIT_R = 14;          // swim a circle of this radius around the census point
const SAMPLES = 14;
const CAMERA_SEP_MAX = 3.0;  // metres; the eye offset is ~1.7 m, so 3 is slack

// Pin the player onto an orbit so the "swim around them" case is reproduced
// exactly, rather than approximated by teleporting. The REAL simulate still
// runs, so the waterline, the orientation model and the creature perception
// context are the ones the game actually uses, and prevPosition is written
// because applyCamera lerps between it and position.
let theta = 0;
const realSimulate = g.player.simulate.bind(g.player);
g.player.simulate = (dt, input, t) => {
  const p = g.player;
  realSimulate(dt, input, t);
  p.prevPosition[0] = EYE[0] + Math.cos(theta) * ORBIT_R;
  p.prevPosition[1] = EYE[1];
  p.prevPosition[2] = EYE[2] + Math.sin(theta) * ORBIT_R;
  p.position.set(p.prevPosition);
  p.velocity[0] = 0; p.velocity[1] = 0; p.velocity[2] = 0;
};

g.player.inVessel = false;
g.player.position.set(EYE);
await sleep(15000);   // let the near-field director fill

const fwd = vec3.create();
const track = new Map();     // handle -> samples
const perSample = [];

let sepMax = 0;
for (let s = 0; s < SAMPLES; s++) {
  theta = (s / SAMPLES) * Math.PI * 2;
  await sleep(900);

  const sim = g.creatures;
  const cam = g.renderer.camera.position;
  // HARD SELF-TEST. A camera that is not where the player is turns every count
  // below into a measurement of empty water somewhere else, and it does it
  // silently. Abort rather than report.
  const pp = g.player.position;
  const sep = Math.hypot(cam[0] - pp[0], cam[1] - pp[1], cam[2] - pp[2]);
  if (sep > sepMax) sepMax = sep;
  if (!(sep <= CAMERA_SEP_MAX)) {
    g.player.simulate = realSimulate;
    throw new Error(`[fish-facing] camera is ${sep.toFixed(2)} m from the player ` +
      `(limit ${CAMERA_SEP_MAX} m). Every census below would be of the wrong water. ` +
      'This is the fault that produced the churn diagnosis.');
  }
  let n = 0, relSum = 0;
  const handles = [];

  for (const i of sim.liveSlots()) {
    const dx = sim.posX[i] - cam[0], dy = sim.posY[i] - cam[1], dz = sim.posZ[i] - cam[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > 900) continue;                 // within 30 m
    const o = i * 4;
    quat.forward(fwd, [sim.orient[o], sim.orient[o + 1], sim.orient[o + 2], sim.orient[o + 3]]);

    // World heading of the animal, and its bearing relative to the eye->animal
    // direction. `toFish` points EYE -> FISH, so rel = 0 means the animal's
    // nose is pointing further away from the eye, i.e. it is swimming AWAY and
    // showing its tail; rel = 180 means it is swimming straight AT the eye.
    // This comment used to say the opposite and was quoted that way.
    const worldHeading = Math.atan2(fwd[0], -fwd[2]) * 180 / Math.PI;
    const inv = 1 / Math.sqrt(d2);
    const toFishX = dx * inv, toFishZ = dz * inv;
    const rel = Math.atan2(
      fwd[0] * toFishZ - fwd[2] * toFishX,
      fwd[0] * toFishX + fwd[2] * toFishZ) * 180 / Math.PI;

    const h = sim.handleOf(i);
    handles.push(h);
    if (!track.has(h)) track.set(h, []);
    track.get(h).push({ s, worldHeading: +worldHeading.toFixed(1), rel: +rel.toFixed(1) });
    relSum += Math.abs(rel); n++;
  }
  perSample.push({ s, orbitDeg: Math.round(theta * 180 / Math.PI), near30: n,
                   meanAbsRel: n ? +(relSum / n).toFixed(1) : null,
                   handles: handles.length });
}

g.player.simulate = realSimulate;

// Survivors: agents present for most of the orbit are the ones the "swim around
// them" complaint is actually about.
const survivors = [...track.entries()]
  .filter(([, v]) => v.length >= SAMPLES * 0.6)
  .map(([h, v]) => {
    const spread = (a) => {
      const s = a.slice().sort((x, y) => x - y);
      return +(s[s.length - 1] - s[0]).toFixed(1);
    };
    return {
      handle: h, seen: v.length,
      worldHeadingSpread: spread(v.map((x) => x.worldHeading)),
      relBearingSpread: spread(v.map((x) => x.rel)),
      meanAbsRel: +(v.reduce((a, x) => a + Math.abs(x.rel), 0) / v.length).toFixed(1),
    };
  });

return {
  perSample,
  maxCameraToPlayerSeparationM: +sepMax.toFixed(2),
  totalDistinctHandles: track.size,
  survivorsAcrossOrbit: survivors.length,
  survivors: survivors.slice(0, 12),
  note: 'CHURN if totalDistinctHandles >> survivorsAcrossOrbit. FLEE if survivors ' +
        'have a LARGE worldHeadingSpread and a SMALL relBearingSpread with meanAbsRel ' +
        'near 0 (tail toward the eye). BILLBOARD if relBearingSpread is near 0 for ' +
        'everything. NOTE that "zero survivors" is ALSO what a sparse near field ' +
        'looks like, since a handle is only recorded while it is within 30 m - use ' +
        'tools/probes/fish-circle-one.js, which follows one handle, to separate them.',
};
