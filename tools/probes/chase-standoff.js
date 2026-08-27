/**
 * CHASE-CAMERA STANDOFF AT SPEED - the A/B behind VESSEL.CHASE_LAG_COMP.
 *
 * The chase spring trails a moving target by `10 * CHASE_DAMPING * v /
 * CHASE_SPRING` in the steady state, which is 1.093 m per m/s here: at a 66 m/s
 * cruise the camera sits ~85 m behind a hull authored to be seen from 12.5 m,
 * and the vessel photographs as a speck (feedback5 beat 05, the reported
 * "we only see the tip of the mountain"). This flies the SHOWCASE'S OWN chase
 * leg twice - compensation off, then on - and reports the delivered standoff
 * against the speed it was flown at, so the number is the one the audience
 * sees rather than one from a synthetic rig.
 *
 *   node tools/probe.mjs --file tools/probes/chase-standoff.js
 */
const g = subwave;
  const { VESSEL } = await import('/src/core/constants.js');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rows = [];

  const arm = async (comp) => {
    if (g.demo.active) g.demo.stop('probe');
    await sleep(600);
    VESSEL.CHASE_LAG_COMP = comp;
    // Segment 1 is board-climb: it boards, switches to chase and flies two
    // legs over the water. Starting there SKIPS the beach walk that normally
    // delivers the player to the hatch, so stage the pair by hand first - the
    // board step only fires inside canBoard().
    g.jumpTo('spawn');
    await sleep(700);
    const p0 = g.player.position;
    // Inside VESSEL.BOARD_RANGE (4.5 m) measured to the HATCH, which sits
    // ~2.8 m above the player's feet on a parked hull - so the horizontal
    // offset has to leave room for that.
    g.vessel.teleport(p0[0] + 2, g.terrain.sampleHeight(p0[0] + 2, p0[2] + 2) + 2.2,
      p0[2] + 2, g.spawn.shoreBearing, 0);
    await sleep(300);
    g.demo.start(1);
    const samples = [];
    for (let i = 0; i < 70; i++) {
      await sleep(250);
      if (!g.demo.active) break;
      if (g.vessel.cameraMode !== 'chase' || !g.player.inVessel) continue;
      const v = Math.hypot(g.vessel.velocity[0], g.vessel.velocity[1], g.vessel.velocity[2]);
      if (v < 25) continue;                 // cruise only; ignore spin-up/brake
      const cam = g.rig?.camera || g.renderer?.camera;
      if (!cam) continue;
      samples.push({
        v,
        d: Math.hypot(cam.position[0] - g.vessel.position[0],
          cam.position[1] - g.vessel.position[1],
          cam.position[2] - g.vessel.position[2]),
      });
      if (samples.length >= 18) break;
    }
    g.demo.stop('probe');
    await sleep(400);
    if (!samples.length) { rows.push({ comp, n: 0 }); return; }
    const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    rows.push({
      comp,
      n: samples.length,
      medSpeed: +med(samples.map((s) => s.v)).toFixed(1),
      medStandoff: +med(samples.map((s) => s.d)).toFixed(1),
      maxStandoff: +Math.max(...samples.map((s) => s.d)).toFixed(1),
    });
  };

await arm(0);
await arm(1);
VESSEL.CHASE_LAG_COMP = 1.0;
return {
  authoredStandoff: VESSEL.CHASE_DISTANCE,
  predictedLagPerMetrePerSecond: 10 * VESSEL.CHASE_DAMPING / VESSEL.CHASE_SPRING,
  rows,
};
