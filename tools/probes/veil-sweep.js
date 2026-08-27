// Live A/B sweep of the clarity-pass veil knobs at one anchor.
// Matched by construction: one process, one anchor pin, knobs are the only
// difference between arms. Reports the shallow-chroma census plus exposure.
//   node tools/probe.mjs --file tools/probes/veil-sweep.js
// Anchor and sweep come from globalThis.VEIL_SWEEP (set via --eval preamble)
// or default to coral.

const { quat } = await import('/src/core/math.js');
const { RENDER } = await import('/src/core/constants.js');

const rAF = () => new Promise((resolve) => requestAnimationFrame(resolve));

const canvas = document.querySelector('canvas');
const scratch = document.createElement('canvas');
scratch.width = canvas.width;
scratch.height = canvas.height;
const ctx = scratch.getContext('2d', { willReadFrequently: true });

function hsv(r8, g8, b8) {
  const r = r8 / 255, g = g8 / 255, b = b8 / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-8) {
    if (mx === r) h = 60 * ((((g - b) / d) % 6 + 6) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return [h, mx > 0 ? d / mx : 0, mx];
}

function census() {
  ctx.drawImage(canvas, 0, 0);
  const x = Math.round(canvas.width * 0.18);
  const y = Math.round(canvas.height * 0.08);
  const w = Math.round(canvas.width * 0.64);
  const h = Math.round(canvas.height * 0.84);
  const pixels = ctx.getImageData(x, y, w, h).data;
  let rgb = [0, 0, 0], satSum = 0, colourful = 0, warm = 0, clipped = 0;
  let lumSum = 0, lum2Sum = 0;
  const n = pixels.length / 4;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    const [hh, s, v] = hsv(r, g, b);
    rgb[0] += r; rgb[1] += g; rgb[2] += b;
    satSum += s;
    if (s >= 0.25) colourful++;
    if (s >= 0.25 && (hh <= 65 || hh >= 315)) warm++;
    if (v >= 0.985) clipped++;
    const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    lumSum += L; lum2Sum += L * L;
  }
  const meanL = lumSum / n;
  const sd = Math.sqrt(Math.max(0, lum2Sum / n - meanL * meanL));
  return {
    meanRgb: rgb.map((v) => +(v / n).toFixed(1)),
    meanSat: +(satSum / n).toFixed(4),
    colourful: +(100 * colourful / n).toFixed(2),
    warm: +(100 * warm / n).toFixed(2),
    clipped: +(100 * clipped / n).toFixed(3),
    meanL: +meanL.toFixed(4),
    contrastCV: +(sd / Math.max(meanL, 1e-4)).toFixed(4),
  };
}

function pinArrival(arrival) {
  const p = subwave.player;
  p.inVessel = false;
  p.position.set([arrival.x, arrival.y, arrival.z]);
  p.prevPosition.set(p.position);
  p.velocity.set([0, 0, 0]);
  p.yaw = arrival.yaw;
  p.pitch = arrival.pitch;
  quat.fromEuler(p.orientation, p.yaw, p.pitch, 0);
  quat.copy(p.prevOrientation, p.orientation);
  subwave.snapWaterColumn(p.position);
}

for (const id of ['lock-hint', 'jump-menu', 'jump-toast']) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}
subwave.worldClock.setDayFraction(0.32);
subwave.player.lampOn = false;
subwave.setPaused(false);

const cfg = globalThis.VEIL_SWEEP || {
  target: 'coral',
  arms: [
    { VEIL_DIFFUSE_GAIN: 1.0, VEIL_CHROMA: 0.0 },
    { VEIL_DIFFUSE_GAIN: 0.8, VEIL_CHROMA: 0.0 },
    { VEIL_DIFFUSE_GAIN: 0.65, VEIL_CHROMA: 0.0 },
    { VEIL_DIFFUSE_GAIN: 0.5, VEIL_CHROMA: 0.0 },
    { VEIL_DIFFUSE_GAIN: 0.4, VEIL_CHROMA: 0.0 },
  ],
};

const arrival = subwave.jumpTo(cfg.target);
for (let i = 0; i < 240; i++) { pinArrival(arrival); await rAF(); }

const baseline = {};
for (const k of ['VEIL_DIFFUSE_GAIN', 'VEIL_CHROMA', 'SNOW_DENSITY_SCALE',
  'SHALLOW_VEIL_REDUCTION']) baseline[k] = RENDER[k];

const out = { target: cfg.target, depth: +arrival.depth.toFixed(1), arms: [] };
for (const arm of cfg.arms) {
  Object.assign(RENDER, arm);
  subwave.renderer.resetAdaptation();
  // Exposure re-meters at EXPOSURE_SPEED ~2.2 EV/s; give it 3 s of frames.
  for (let i = 0; i < 260; i++) { pinArrival(arrival); await rAF(); }
  subwave.setPaused(true);
  for (let i = 0; i < 8; i++) await rAF();
  out.arms.push({ ...arm, ...census() });
  subwave.setPaused(false);
}
Object.assign(RENDER, baseline);
return out;
