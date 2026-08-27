// Fixed-camera shallow-biome colour census.
//
// Measures the delivered display image, not authored albedo. The whole failure
// this guards lives after lighting, water transport, exposure, and tonemapping:
// a warm coral can still arrive as a pale blue-white pixel. Centre crop excludes
// both HUD panels and the outer vignette. Run with:
//   node tools/probe.mjs --file tools/probes/shallow-chroma.js

const { quat } = await import('/src/core/math.js');

const rAF = () => new Promise((resolve) => requestAnimationFrame(resolve));
const settle = async (frames) => { for (let i = 0; i < frames; i++) await rAF(); };

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

const hueDistance = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

function census() {
  ctx.drawImage(canvas, 0, 0);
  const x = Math.round(canvas.width * 0.18);
  const y = Math.round(canvas.height * 0.08);
  const w = Math.round(canvas.width * 0.64);
  const h = Math.round(canvas.height * 0.84);
  const pixels = ctx.getImageData(x, y, w, h).data;
  const hues = new Uint32Array(36);
  const rows = [];
  let rgb = [0, 0, 0], satSum = 0, colourful = 0, warm = 0, clipped = 0;

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    const [hh, s, v] = hsv(r, g, b);
    rows.push([hh, s, v]);
    rgb[0] += r; rgb[1] += g; rgb[2] += b;
    satSum += s;
    if (s >= 0.20) hues[Math.floor(hh / 10) % 36]++;
    if (s >= 0.25) colourful++;
    if (s >= 0.25 && (hh <= 65 || hh >= 315)) warm++;
    if (v >= 0.985) clipped++;
  }

  let peak = 0;
  for (let i = 1; i < hues.length; i++) if (hues[i] > hues[peak]) peak = i;
  const dominantHue = peak * 10 + 5;
  let offHue = 0;
  for (const [hh, s] of rows) if (s >= 0.20 && hueDistance(hh, dominantHue) >= 40) offHue++;

  rows.sort((a, b) => a[2] - b[2]);
  const top = rows.slice(Math.floor(rows.length * 0.97));
  let sx = 0, sy = 0, topSat = 0;
  for (const [hh, s] of top) {
    sx += Math.cos(hh * Math.PI / 180) * s;
    sy += Math.sin(hh * Math.PI / 180) * s;
    topSat += s;
  }
  const topHue = (Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360;
  const n = rows.length;
  return {
    meanRgb: rgb.map((v) => +(v / n).toFixed(2)),
    dominantHue: +dominantHue.toFixed(1),
    meanSaturation: +(satSum / n).toFixed(4),
    colourfulCoverage: +(100 * colourful / n).toFixed(3),
    warmCoverage: +(100 * warm / n).toFixed(3),
    offHueCoverage: +(100 * offHue / n).toFixed(3),
    brightest3Hue: +topHue.toFixed(1),
    brightest3Saturation: +(topSat / top.length).toFixed(4),
    clippedCoverage: +(100 * clipped / n).toFixed(3),
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
  subwave.renderer.camera.resetHistory();
  subwave.renderer.resetAdaptation();
}

for (const id of ['lock-hint', 'jump-menu', 'jump-toast']) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}
subwave.worldClock.setDayFraction(0.32);
subwave.player.lampOn = false;
subwave.setPaused(false);

const stations = [
  ['Shallow Reef', 'reef'],
  ['Coral Garden', 'coral'],
];
const result = {};
for (const [name, target] of stations) {
  const arrival = subwave.jumpTo(target);
  for (let i = 0; i < 300; i++) {
    pinArrival(arrival);
    await rAF();
  }
  subwave.setPaused(true);
  await settle(8);
  result[name] = { depth: +arrival.depth.toFixed(1), ...census() };
  subwave.setPaused(false);
}

return result;
