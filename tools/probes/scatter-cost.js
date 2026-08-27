// Probe: the GPU cost of the scatter pass, measured by turning it off.
//
//   node tools/probe.mjs --file tools/probes/scatter-cost.js
//
// fps alone cannot answer this: the display is vsync-capped at 120 Hz, so a pass
// that costs 3 ms and a pass that costs zero both read 120 fps.
//
// IT USED TO READ `prof.gpuTotal`, WHICH NOW REFUSES rather than summing scopes
// that overlap - and the A/B above is exactly where the old sum inverted its own
// sign, reading +18.4% for REMOVING 1.66 ms of real work, because a vsync-idle
// frame's idle is billed to every scope and taking one out gives the survivors
// more of it. The whole-frame figure here is `gpuFrameSpan`, which is measured
// on the GPU timeline; the refusal string is reported so the missing total reads
// as a withdrawal and not as a gap. Run under `--no-vsync` if the span itself is
// to mean anything: with headroom the frame is idle-padded either way.

const g = window.subwave;
const prof = (await import('/src/core/profiler.js')).profiler;
const pass = g.scatterPass;
if (!pass) return 'scatterPass is not on the game object';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SITES = [
  { name: 'reef 8 m', pos: [0, -8, 240], yaw: 1.2, pitch: -0.55 },
  { name: 'reef 14 m down', pos: [0, -14, 244], yaw: 1.2, pitch: -0.85 },
  { name: 'twilight 120 m', pos: [455, -120, 1926], yaw: 1.0, pitch: -0.45 },
  { name: 'beach', pos: null, yaw: null, pitch: -0.22 },
];

// The frame graph consults pass.enabled() every frame, so overriding it is a
// clean A/B: no rebuild, no pipeline churn, nothing else in the frame moves.
let forceOff = false;
const realEnabled = pass.enabled.bind(pass);
pass.enabled = () => (forceOff ? false : realEnabled());

const out = [];
for (const site of SITES) {
  g.setPaused(false);
  const p = site.pos ?? [g.spawn.position[0], g.spawn.position[1] + 1.6, g.spawn.position[2]];
  g.player.inVessel = false;
  g.player.position.set(p);
  g.renderer.camera.setEuler(site.yaw ?? g.spawn.shoreBearing, site.pitch, 0);
  await sleep(6000);

  const sample = async () => {
    prof.reset();
    await sleep(2500);
    const map = Object.fromEntries(prof.gpuBreakdown(40));
    return { span: prof.gpuFrameSpan, refusal: prof.gpuTotalRefusal(),
      scatter: map.scatter ?? 0, terrain: map.terrain ?? 0 };
  };

  forceOff = false;
  const withScatter = await sample();
  const s = { ...pass.stats };
  forceOff = true;
  const without = await sample();
  forceOff = false;

  out.push({
    site: site.name,
    draws: s.draws,
    visibleInstances: s.visibleInstances,
    trianglesSubmitted: s.triangles,
    scatterPassMs: +withScatter.scatter.toFixed(3),
    gpuSpanWith: Number.isFinite(withScatter.span) ? +withScatter.span.toFixed(2) : null,
    gpuSpanWithout: Number.isFinite(without.span) ? +without.span.toFixed(2) : null,
    deltaMs: Number.isFinite(withScatter.span) && Number.isFinite(without.span)
      ? +(withScatter.span - without.span).toFixed(2) : null,
    gpuTotalRefusal: withScatter.refusal,
    terrainMs: +withScatter.terrain.toFixed(2),
    fps: +g.clock.fps.toFixed(1),
    frameMs: +(g.clock.smoothedDt * 1000).toFixed(2),
    p99Ms: +g.clock.percentile(0.99).toFixed(2),
  });
}
return out;
