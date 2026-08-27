// WHAT THIS DISCRIMINATES: how many of depth band 1's slots CELL RESOLUTION
// actually holds while the eye is in the lagoon, as opposed to how many
// NEARFIELD_CELL_FLOOR reserves for it.
//
//   node tools/probe.mjs --file tools/probes/nearfield-band-occupancy.js
//
// The distinction matters because spawner.js's NEARFIELD_CELL_FLOOR comment
// sizes the expected occupancy of the empty 45-94 m annulus from the RESERVED
// number (0.22 x BAND_BUDGET[1] = 42 slots). The near field's alive population -
// the counted ball plus its wake - is charged to the same band, and if it
// crowds the cells out then the annulus expectation is a fraction of what the
// comment claims. `bandCellCount` is the spawner's own counter of the agents in
// each band that the near field did NOT seed, so it answers this directly.
//
// Measured both stationary and swimming, because the wake only exists when the
// eye moves.

const g = window.subwave;
const sp = g.spawner;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const START = [0, -8, 240];
const HZ = 10;

g.player.inVessel = false;
g.input.enabled = true;
g.input.pointerLocked = true;
g.input.keys.delete('KeyW');

const real = g.player.simulate.bind(g.player);
g.player.simulate = (dt, input, t) => {
  real(dt, input, t);
  g.player.prevPosition.set(START);
  g.player.position.set(START);
  g.player.velocity[0] = 0; g.player.velocity[1] = 0; g.player.velocity[2] = 0;
};
g.player.yaw = 0; g.player.pitch = 0;
await sleep(9000);
g.player.simulate = real;

const stat = (a) => {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return {
    n: a.length, min: s[0], max: s[s.length - 1],
    median: s[s.length >> 1],
    mean: +(a.reduce((p, c) => p + c, 0) / a.length).toFixed(2),
  };
};

async function sample(ms, moving) {
  const cell = [], total = [], near = [], nearAlive = [];
  if (moving) g.input.keys.add('KeyW'); else g.input.keys.delete('KeyW');
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    // Depth band 1 is the sunlit band the lagoon sits in; _eyeBand confirms it.
    cell.push(sp.bandCellCount[1]);
    total.push(sp.bandCount[1]);
    near.push(sp.stats.nearFieldCount);
    let alive = 0;
    const live = g.creatures.liveSlots();
    for (let k = 0; k < live.length; k++) if (sp._nearFieldSlot[live[k]] === 1) alive++;
    nearAlive.push(alive);
    await sleep(1000 / HZ);
  }
  return {
    eyeBand: sp._eyeBand,
    bandCellCount1: stat(cell),
    bandCount1: stat(total),
    nearFieldCounted: stat(near),
    nearFieldAlive: stat(nearAlive),
  };
}

const stationary = await sample(8000, false);
// Hold a heading and swim; the pitch tick keeps the diver at depth.
g.player.yaw = 0;
const tick = () => {
  const p = g.player.position;
  g.player.yaw = 0;
  g.player.pitch = Math.max(-0.5, Math.min(0.5, 0.30 * (START[1] - p[1])));
  if (g.input.keys.has('KeyW')) requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
const swimming = await sample(16000, true);
g.input.keys.delete('KeyW');

return {
  probe: 'nearfield-band-occupancy',
  bandBudget1: 192,
  cellFloorSlots: Math.round(192 * 0.22),
  stationary, swimming,
};
