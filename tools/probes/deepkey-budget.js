// Probe (item 2.3): WHAT DOES THE DEEP KEY COST ON THE EXPOSURE RAIL?
//
//   node tools/probe.mjs --file tools/probes/deepkey-budget.js
//
// The key is a live Frame field read off RENDER every frame, so both arms of
// this A/B are the SAME settled frame at the same station with the same PRNG
// stream - the only thing that changes between the two readbacks is the
// authored radiance. That is the one comparison this project's own notes say is
// worth believing: an A/B that adds or removes an agent changes the stream for
// every other agent, and toggling a knob does not.
//
// Reports scene-linear luminance off `sceneColor` (post-composite, pre-AgX) in
// both arms, the EV cost, and the delivered auto-exposure gain - the plan
// allocates +0.8 EV to this item against 2.87 EV of measured headroom, and the
// gain must still read its 25.6 ceiling afterwards or auto-exposure is taking
// the light straight back out.

const g = window.subwave;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { RENDER } = await import('/src/core/constants.js');

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const authored = RENDER.DEEP_KEY_RADIANCE.slice();
const anchors = ['break', 'terrace', 'spires', 'canyon', 'abyssal', 'trenchWall', 'trenchFloor'];
const out = [];

g.hud.visible = false;
g.worldClock.setDayFraction(0.32);

async function read() {
  // Two frames, so the uniform written this frame is the one that was shaded.
  await new Promise((r) => requestAnimationFrame(r));
  await new Promise((r) => requestAnimationFrame(r));
  const s = await g.renderer.debugReadback('sceneColor', 96);
  return { lum: s.luminance, exposure: g.renderer.exposure };
}

for (const short of anchors) {
  const r = g.jumpTo(short);
  if (r && r.error) { out.push({ short, error: r.error }); continue; }
  g.player.lampOn = Math.max(0, -g.player.position[1]) > 150;
  await sleep(7000);

  RENDER.DEEP_KEY_RADIANCE = [0, 0, 0];
  const off = await read();
  RENDER.DEEP_KEY_RADIANCE = authored.slice();
  const on = await read();
  RENDER.DEEP_KEY_RADIANCE = [0, 0, 0];
  const off2 = await read();
  RENDER.DEEP_KEY_RADIANCE = authored.slice();

  out.push({
    short,
    depth: +(-g.player.position[1]).toFixed(1),
    // The gate is 1 - aphoticFactor(cameraDepth), reproduced here so the EV
    // column can be read against how much key the station is even entitled to.
    gate: +smoothstep(319.8, 520, Math.max(0, -g.player.position[1])).toFixed(4),
    offLum: +off.lum.toFixed(6),
    onLum: +on.lum.toFixed(6),
    controlLum: +off2.lum.toFixed(6),
    deltaEV: +Math.log2(on.lum / off.lum).toFixed(3),
    controlEV: +Math.log2(off2.lum / off.lum).toFixed(3),
    exposureOff: +off.exposure.toFixed(3),
    exposureOn: +on.exposure.toFixed(3),
  });
}


return out;
