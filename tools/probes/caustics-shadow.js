// HOW MUCH LIGHT DOES A CAST SHADOW STILL REMOVE UNDERWATER?
//
// A visual reviewer measured the vessel's shadow on the shallow lagoon sand
// falling from 14.0% to 3.9% darker than its surroundings across the caustics
// rework, in the DISPLAYED image, and attributed it to the direct beam having
// lost a factor of 3.86. This measures the same thing in LINEAR HDR and BEFORE
// the underwater composite, which is the only place the lighting model's own
// shadow authority is visible: sceneOpaque is a copy of the lit geometry taken
// before the ocean surface and before the fullscreen medium.
//
// Method: A/B the CASTER. Read sceneOpaque with the hull hovering over the sand
// and again with it teleported 3 km away, at the same camera, same instant of
// the wave loop. Pixels that darken are exactly the shadow; the camera looks
// down at where the shadow lands so the hull itself is out of frame.
//
//   node tools/probe.mjs --file tools/probes/caustics-shadow.js
const g = subwave;
const R = g.renderer;
const { quat, vec3 } = await import('/src/core/math.js');
const { sampleHeight } = await import('/src/world/terrain.js');
const { readTexture2D } = await import('/src/core/resources.js');
const frames = async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); };

function f16(h) {
  const s = (h & 0x8000) ? -1 : 1;
  const e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

async function grabLum(name, res) {
  const tex = R.targets.texture(name);
  const size = R.targets.size(name);
  const raw = await readTexture2D(R.gpu.device, tex, size.width, size.height, { bytesPerPixel: 8 });
  const v = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const out = new Float32Array(size.width * size.height);
  for (let i = 0; i < out.length; i++) {
    out[i] = 0.2126 * f16(v[i * 4]) + 0.7152 * f16(v[i * 4 + 1]) + 0.0722 * f16(v[i * 4 + 2]);
  }
  return { a: out, w: size.width, h: size.height };
}

g.weather.stateAtTime = () => 0;
g.weather.deserialize({ seed: g.weather.seed }, g.worldClock);
g.worldClock.setDayFraction(0.36);          // mid-morning: the shadow is offset
await frames(30);

const FLOOR_X = 303.61, FLOOR_Z = 263.21;
const floorY = sampleHeight(FLOOR_X, FLOOR_Z);
const HOVER = floorY + 4.0;
const V = [FLOOR_X, HOVER, FLOOR_Z];
const AWAY = [FLOOR_X + 3000, HOVER, FLOOR_Z];

// Where the shadow lands: back down the sun ray from the hull to the seabed.
const L = R.env.sunDir;
const drop = HOVER - floorY;
const t = drop / Math.max(L[1], 0.05);
const S = [V[0] - L[0] * t, floorY, V[2] - L[2] * t];

// Look straight down at the shadow from 3.2 m up. The eye MUST be clearly
// submerged: at the waterline the latched `underwater` flag is false, the
// fullscreen composite does not run at all, and evalAmbient's column loss is
// taken over the whole 6 m instead of the 3.2 m between eye and seabed - which
// silently changes the very ratio this is measuring.
const EYE = [S[0], floorY + 3.2, S[2]];
const place = (vesselAt) => {
  const p = g.player;
  p.inVessel = false;
  p.position.set(EYE); vec3.copy(p.prevPosition, p.position);
  p.velocity.set([0, 0, 0]);
  p.yaw = 0; p.pitch = -1.5;
  quat.fromEuler(p.orientation, p.yaw, p.pitch, 0);
  quat.copy(p.prevOrientation, p.orientation);
  const v = g.vessel;
  if (v) {
    v.piloted = false; v.unpiloted = true;
    v.position.set(vesselAt); vec3.copy(v.prevPosition, v.position);
    v.velocity.set([0, 0, 0]);
  }
};

// Freeze the wave loop so the two grabs see the SAME caustic instant - the tile
// has sd/mean 0.71 and would otherwise dominate the difference.
const T_PIN = 137.0;
const oceanUpdate = g.ocean.update.bind(g.ocean);
g.ocean.update = (...a) => { const r = oceanUpdate(...a); g.ocean.time = T_PIN; return r; };

async function shot(vesselAt) {
  const iv = setInterval(() => place(vesselAt), 30);
  place(vesselAt);
  await frames(120);
  const geo = await grabLum('sceneOpaque');
  const fin = await grabLum('sceneColor');
  clearInterval(iv);
  return { geo, fin };
}

const withHull = await shot(V);
const noHull = await shot(AWAY);

// Restrict to pixels that DARKENED. Sky and the hull itself cannot: the camera
// looks straight down at 6 m over sand, so the whole frame is seabed.
const n = withHull.geo.a.length;
let shadowPx = 0, sumRatio = 0, sumLit = 0, sumShadow = 0;
let minRatio = 1e9;
const hist = new Array(20).fill(0);
for (let i = 0; i < n; i++) {
  const b = noHull.geo.a[i], a = withHull.geo.a[i];
  if (b <= 1e-6) continue;
  const r = a / b;
  const bin = Math.min(19, Math.max(0, Math.floor(r * 20)));
  hist[bin]++;
  if (r < 0.98) {
    shadowPx++; sumRatio += r; sumLit += b; sumShadow += a;
    if (r < minRatio) minRatio = r;
  }
}

// The same station's ANALYTIC decomposition, for the prediction this tests.
const Kd = R.env.waterType.Kd;
const sun = [R.env.sunColor[0] * R.env.sunIntensity, R.env.sunColor[1] * R.env.sunIntensity,
             R.env.sunColor[2] * R.env.sunIntensity];
const eta = 1 / 1.333;
const cosI = Math.max(L[1], 0);
const ry = -Math.sqrt(Math.max(1 - eta * eta * (1 - cosI * cosI), 0));
const path = Math.max(-floorY, 0) / Math.max(-ry, 0.2);
const transmit = 1 - (0.02 + 0.98 * Math.pow(1 - cosI, 5));
const lum = (v) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
const dir = [0, 1, 2].map((i) => (sun[i] * transmit * Math.exp(-Kd[i] * path) * cosI) / Math.PI);
const c = R.env.ambientSH;
const amb = [0, 1, 2].map((ch) => Math.max(c[0 * 3 + ch] * 0.282095 + c[1 * 3 + ch] * 0.488603, 0));

return {
  station: {
    floorY: +floorY.toFixed(2), hullY: +HOVER.toFixed(2), eyeY: +EYE[1].toFixed(2),
    shadowAt: S.map((v) => +v.toFixed(2)),
    eyeSubmerged: g.player.underwater ?? (EYE[1] < 0),
  },
  sunElevDeg: +((Math.asin(L[1]) * 180) / Math.PI).toFixed(2),
  frame: `${withHull.geo.w}x${withHull.geo.h}`,
  shadowPixels: shadowPx,
  shadowPixelPct: +((100 * shadowPx) / n).toFixed(2),
  meanRatioInShadow: +(sumRatio / Math.max(shadowPx, 1)).toFixed(4),
  areaWeightedContrast: +(1 - sumShadow / Math.max(sumLit, 1e-9)).toFixed(4),
  deepestPixelContrast: +(1 - minRatio).toFixed(4),
  ratioHistogram: hist,
  afterMedium: (() => {
    // The SAME pixels, read off sceneColor - after the ocean surface and after
    // the fullscreen underwater composite, which multiplies by transmittance and
    // adds in-scatter. This is the number the eye actually sees, pre-tonemap.
    let lit = 0, sh = 0, px = 0;
    for (let i = 0; i < n; i++) {
      const b = noHull.geo.a[i];
      if (b <= 1e-6) continue;
      if (withHull.geo.a[i] / b < 0.98) { lit += noHull.fin.a[i]; sh += withHull.fin.a[i]; px++; }
    }
    return {
      pixels: px,
      areaWeightedContrast: +(1 - sh / Math.max(lit, 1e-9)).toFixed(4),
      meanLitRadiance: +(lit / Math.max(px, 1)).toExponential(4),
      dilutionFactor: +((1 - sh / Math.max(lit, 1e-9)) > 0
        ? (1 - sumShadow / Math.max(sumLit, 1e-9)) / (1 - sh / Math.max(lit, 1e-9)) : 0).toFixed(3),
    };
  })(),
  analytic: {
    directDiffuseLum: +lum(dir).toExponential(4),
    ambientDiffuseLum: +lum(amb).toExponential(4),
    predictedFullShadowContrast: +(lum(dir) / (lum(dir) + lum(amb))).toFixed(4),
  },
};
