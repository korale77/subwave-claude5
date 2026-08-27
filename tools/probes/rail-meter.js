// RE-DERIVING THE AUTO-EXPOSURE RAIL: what the meter actually sees at the
// fourteen biome anchors, and how much light the deep can still gain before the
// gain ceiling stops being a fixed 25.6x.
//
//   node tools/probe.mjs --file tools/probes/rail-meter.js
//
// Edit FROM/TO near the bottom to split the fourteen anchors across two runs;
// the whole tour does not fit inside probe.mjs's 90 s CDP deadline.
//
// REWRITTEN 2026-08-04 FOR THE UN-WELD, AND THE DEFECT THIS PROBE WAS BUILT TO
// EXPOSE IS THE ONE THAT GOT FIXED. It modelled the histogram with its low bin
// edge at EXPOSURE_MIN_EV, so `meteredAvgLum` could not represent anything
// below 2^-6 = 0.015625 and printed that one constant at every deep station.
// The shipped shader now bins over [HISTOGRAM_MIN_EV, EXPOSURE_MAX_EV] and this
// mirror follows it. Left alone, this file would have gone on printing 0.015625
// against a shader that had stopped producing it - which is precisely the
// failure CLAUDE.md records as having cost a whole tuning pass.
//
// THE RULE, and it is the whole point of the un-weld: BIN EDGES come from
// HISTOGRAM_MIN_EV (= log2(1e-5), the histogram's own inclusion gate); the
// targetEV CLAMP, and hence the 25.6x gain ceiling, comes from EXPOSURE_MIN_EV
// as log2(2^EXPOSURE_MIN_EV / EXPOSURE_KEY). tools/test-post.mjs's mirror is
// the reference implementation; copy it rather than re-deriving this.
//
// To A/B a candidate rail against the real image rather than against this
// model, prepend this to each setup in a copy of tools/shots/biome-tour.json
// and re-shoot - RENDER is not frozen, and post.js writes BOTH constants into
// the exposure uniform every frame, so a live override is the whole change:
//
//   (async()=>{const{RENDER}=await import('/src/core/constants.js');
//    RENDER.EXPOSURE_MIN_EV=-8;})();
//
// Note what that does NOT move: GLOW.BIN1_CEIL is evaluated at module load, so
// an override isolates the exposure loop from the glow budget. Both have to move
// together in a real change. Overriding HISTOGRAM_MIN_EV instead A/Bs the
// un-weld itself, and setting it equal to EXPOSURE_MIN_EV reproduces the
// pre-2026-08-04 image exactly. Call renderer.resetAdaptation() after either
// rather than waiting out the 0.85/s dark adaptation.
//
// WHAT IS BEING SEPARATED. There are three different "the exposure is stuck"
// claims and they need different repairs:
//
//   (a) the METER disagrees with the frame. What survives of that is the bin
//       QUANTISER, now (17+16.61)/254 = 0.1323 EV wide against 0.0906 before -
//       coarser, because the range grew. `meterErrorEV` below is that residual
//       and it should sit inside half a bin; anything larger is a real defect,
//       not quantisation.
//   (b) the CLAMP is holding it. targetEV is pinned at
//       log2(2^EXPOSURE_MIN_EV / EXPOSURE_KEY) = -4.678, i.e. gain exactly 25.6,
//       and that is a DECISION rather than a blind instrument. `clampHeadroomEV`
//       is how many stops the scene must gain before the meter takes over again.
//   (c) the SCENE is dark and the picture is right. Then the delivered
//       percentile ladder is the evidence, not the exposure number.
//
// So this probe reports, per station: the shipped metered average and the same
// reduction with the bin quantisation removed; the weighted share the 1e-5 gate
// discards and therefore the EFFECTIVE frame-percentile window (CLAUDE.md's
// EXPOSURE_KEY contract assumes 45-95 of the FRAME and it is not); the frame's
// own luminance percentiles; and the delivered sRGB code at each percentile
// under the shipped gain and four candidate ceilings, so "what does more gain
// buy" is answered in display codes rather than in stops.

const g = window.subwave;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { RENDER, DEPTH_BANDS, WORLD } = await import('/src/core/constants.js');
const { readTexture2D } = await import('/src/core/resources.js');
const { settings } = await import('/src/core/settings.js');

// MIN_EV is the metering FLOOR and nothing else; HIST_MIN_EV is where the bins
// start. FLOOR_EV is the floor's own target EV, which is what cs_adapt clamps
// targetEV at - see the header.
const MIN_EV = RENDER.EXPOSURE_MIN_EV, MAX_EV = RENDER.EXPOSURE_MAX_EV;
const HIST_MIN_EV = RENDER.HISTOGRAM_MIN_EV;
const KEY = RENDER.EXPOSURE_KEY, LOW = 0.45, HIGH = 0.95;
const FLOOR_EV = Math.log2(2 ** MIN_EV / KEY);
const GATE = 1e-5;
const cl = (x, a, b) => Math.min(b, Math.max(a, x));
const sat01 = (x) => cl(x, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = sat01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const lumOf = (c) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
const binToLum = (i) => 2 ** (HIST_MIN_EV + (MAX_EV - HIST_MIN_EV) * ((i - 1) / 254));
function lumToBin(l) {
  if (l < GATE) return 0;
  const t = sat01((Math.log2(l) - HIST_MIN_EV) / (MAX_EV - HIST_MIN_EV));
  return cl(Math.floor(t * 254 + 1), 1, 255);
}
function f16(h) {
  const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 5.9604644775390625e-8;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (m + 1024) * (2 ** (e - 25));
}

// ---- tonemap.wgsl + math.wgsl + post.js GRADE_KEYS, mirrored ---------------
const M1 = [[0.842479, 0.078360, 0.079160], [0.042328, 0.878468, 0.079200], [0.042376, 0.078845, 0.878780]];
const M2 = [[1.196881, -0.098020, -0.099121], [-0.052909, 1.151824, -0.098844], [-0.052374, -0.100603, 1.153010]];
const mul3 = (M, v) => [
  M[0][0] * v[0] + M[1][0] * v[1] + M[2][0] * v[2],
  M[0][1] * v[0] + M[1][1] * v[1] + M[2][1] * v[2],
  M[0][2] * v[0] + M[1][2] * v[1] + M[2][2] * v[2]];
function agxEncode(c0) {
  const c = mul3(M1, c0.map((x) => Math.max(x, 0)));
  const t = c.map((x) => sat01((Math.log2(Math.max(x, 1e-10)) + 12.47393) / 16.5));
  const sig = t.map((x) => {
    const x2 = x * x, x3 = x2 * x;
    return 15.5 * x3 * x3 - 40.14 * x3 * x2 + 31.96 * x2 * x2 - 6.868 * x3 + 0.4298 * x2 + 0.1191 * x - 0.00232;
  });
  const L = lumOf(sig);
  const look = sig.map((x) => Math.max(L + RENDER.AGX_LOOK_SATURATION * (Math.pow(Math.max(x, 0), RENDER.AGX_LOOK_POWER) - L), 0));
  return mul3(M2, look).map((x) => Math.max(x, 0));
}
const GK = [
  { d: DEPTH_BANDS[0].min, gain: [1, 1, 1], lift: [0, 0, 0], gamma: [1, 1, 1], k: 0.14 },
  { d: DEPTH_BANDS[1].min, gain: [0.98, 1, 1.02], lift: [0, 0.059, 0.090], gamma: [1, 1, 0.99], k: 0.14 },
  { d: DEPTH_BANDS[2].min, gain: [0.86, 0.99, 1.06], lift: [0, 0.081, 0.134], gamma: [1.04, 1, 0.97], k: 0.16 },
  { d: DEPTH_BANDS[3].min, gain: [0.62, 0.92, 1.10], lift: [0, 0.098, 0.169], gamma: [1.12, 1.02, 0.95], k: 0.18 },
  { d: DEPTH_BANDS[4].min, gain: [0.40, 0.80, 1.12], lift: [0, 0.111, 0.197], gamma: [1.24, 1.05, 0.93], k: 0.20 },
  { d: DEPTH_BANDS[5].min, gain: [0.28, 0.66, 1.10], lift: [0.059, 0.123, 0.215], gamma: [1.34, 1.08, 0.92], k: 0.22 },
  { d: WORLD.MAX_DEPTH, gain: [0.22, 0.56, 1.06], lift: [0.081, 0.134, 0.226], gamma: [1.42, 1.10, 0.90], k: 0.24 },
];
function grade(depth) {
  const d = cl(depth, 0, WORLD.MAX_DEPTH);
  let i = 0; while (i < GK.length - 2 && d >= GK[i + 1].d) i++;
  const a = GK[i], b = GK[i + 1], t = sstep(a.d, b.d, d);
  return {
    gain: [0, 1, 2].map((c) => lerp(a.gain[c], b.gain[c], t)),
    lift: [0, 1, 2].map((c) => lerp(a.lift[c], b.lift[c], t)),
    gamma: [0, 1, 2].map((c) => lerp(a.gamma[c], b.gamma[c], t)),
    k: lerp(a.k, b.k, t),
  };
}
function toCode(rgb, exposure, gr) {
  const hdr = rgb.map((x, c) => Math.max(x, 0) * exposure * gr.gain[c]);
  let m = agxEncode(hdr);
  m = m.map((x, c) => x + gr.lift[c] * (1 - x));
  m = m.map((x, c) => Math.pow(Math.max(x, 0), gr.gamma[c]));
  m = m.map((x) => Math.max(x + (x - 0.5) * gr.k * (1 - Math.abs(x - 0.5) * 2), 0));
  return m.map((x) => Math.pow(x, 2.2))
    .map((x) => Math.round(255 * sat01(x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)));
}
const codeLuma = (c) => +(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]).toFixed(1);

// ---- metering ---------------------------------------------------------------
/** cs_adapt, exactly: bin-quantised log-average of the 45-95 window. */
function reduceBins(bins) {
  let total = 0;
  for (let i = 1; i < 256; i++) total += bins[i];
  if (total <= 0) return 0;
  const lo = total * LOW, hi = total * HIGH;
  let seen = 0, sumLog = 0, sumW = 0;
  for (let i = 1; i < 256; i++) {
    const c = bins[i];
    if (c <= 0) continue;
    const a = Math.max(seen, lo), b = Math.min(seen + c, hi);
    const inside = Math.max(0, b - a);
    if (inside > 0) { sumLog += Math.log2(Math.max(binToLum(i), 1e-6)) * inside; sumW += inside; }
    seen += c;
  }
  return sumW > 0 ? 2 ** (sumLog / sumW) : 0;
}

/**
 * The SAME reduction with the histogram removed: the weighted log-average of
 * the [lo, hi] window of the above-gate population, over the real pixel
 * luminances. This is what cs_adapt is trying to measure and cannot.
 */
function reduceExact(samples, low, high) {
  // samples: [{ lum, w }] sorted ascending by lum, above the gate only.
  let total = 0;
  for (const s of samples) total += s.w;
  if (total <= 0) return 0;
  const lo = total * low, hi = total * high;
  let seen = 0, sumLog = 0, sumW = 0;
  for (const s of samples) {
    const a = Math.max(seen, lo), b = Math.min(seen + s.w, hi);
    const inside = Math.max(0, b - a);
    if (inside > 0) { sumLog += Math.log2(Math.max(s.lum, 1e-30)) * inside; sumW += inside; }
    seen += s.w;
  }
  return sumW > 0 ? 2 ** (sumLog / sumW) : 0;
}

// ABSOLUTE candidate gain ceilings, so the ladders are comparable between
// stations: EXPOSURE_KEY / 2^MIN_EV for MIN_EV = -6, -7, -8, -9. That is the
// ceiling the targetEV clamp delivers, which since the un-weld is the ONLY
// thing setting it - it is no longer an emergent property of the bottom bin.
const CEILINGS = [25.6, 51.2, 102.4, 204.8];

async function measure(depth, shippedExposure) {
  const t = g.renderer.targets;
  const size = t.size('sceneColor');
  const raw = await readTexture2D(g.renderer.gpu.device, t.texture('sceneColor'),
    size.width, size.height, { bytesPerPixel: 8 });
  const v = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const stride = g.renderer.gpu.tier === 0 ? 3 : 2;
  const gw = Math.max(1, Math.floor(size.width / stride));
  const gh = Math.max(1, Math.floor(size.height / stride));

  const bins = new Float64Array(256);
  const n = gw * gh;
  const lums = new Float64Array(n);
  const wts = new Float64Array(n);
  const rgbAt = new Float64Array(n * 3);
  let k = 0, wBelowGate = 0, wTotal = 0, sumL = 0, maxL = 0;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = ((y * stride) * size.width + x * stride) * 4;
      const r = Math.max(0, f16(v[i])), gg = Math.max(0, f16(v[i + 1])), b = Math.max(0, f16(v[i + 2]));
      const L = r * 0.2126 + gg * 0.7152 + b * 0.0722;
      const u = (x + 0.5) / gw, w2 = (y + 0.5) / gh;
      const dx = (u - 0.5) * 2, dy = (w2 - 0.5) * 2;
      const wt = Math.floor(1 + 7 * sat01(1 - (dx * dx + dy * dy) * 0.7));
      const bin = lumToBin(L);
      bins[bin] += wt; wTotal += wt;
      if (bin === 0) wBelowGate += wt;
      lums[k] = L; wts[k] = wt;
      rgbAt[k * 3] = r; rgbAt[k * 3 + 1] = gg; rgbAt[k * 3 + 2] = b;
      sumL += L; if (L > maxL) maxL = L;
      k++;
    }
  }

  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => lums[a] - lums[b]);
  const above = [];
  for (const i of order) if (lums[i] >= GATE) above.push({ lum: lums[i], w: wts[i] });

  // cs_adapt's own black-frame fallback is `max(state.avgLum, 1e-5)`, i.e. hold
  // the previous average; with nothing to hold, the gate is the honest floor.
  // It used to read `|| 2 ** MIN_EV`, which was the pre-un-weld bottom bin.
  const meteredAvgLum = reduceBins(bins) || GATE;
  const trueAvgLum = reduceExact(above, LOW, HIGH);
  // Two alternative windows on the same pool, for question 3: does the window
  // still make sense when the pool is a bright minority?
  const trueAvg2080 = reduceExact(above, 0.20, 0.80);
  const trueAvg5090 = reduceExact(above, 0.50, 0.90);

  const gr = grade(depth);
  const P = [0.05, 0.25, 0.5, 0.75, 0.95, 0.999];
  const ladder = P.map((p) => {
    const i = order[Math.min(n - 1, Math.floor(p * n))];
    return { p, lum: +lums[i].toPrecision(4), rgb: [rgbAt[i * 3], rgbAt[i * 3 + 1], rgbAt[i * 3 + 2]] };
  });

  const codes = {};
  const blown = {};
  const median = {};
  // The census is strided: agxEncode is ~40 transcendental flops per sample and
  // four ceilings over 300k samples is a minute of JS. 1-in-6 is 50k samples,
  // which resolves a 0.1% blown fraction to about +/-0.014%.
  const cStride = 6;
  for (const E of CEILINGS) {
    codes[`g${E}`] = ladder.map((row) => codeLuma(toCode(row.rgb, E, gr)));
    let cnt = 0, m = 0;
    const all = [];
    for (let i = 0; i < n; i += cStride) {
      const c = toCode([rgbAt[i * 3], rgbAt[i * 3 + 1], rgbAt[i * 3 + 2]], E, gr);
      const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      // "Blown" is any channel at the top of the range, because these frames are
      // blue-dominant and an emitter core saturates B and G long before R.
      if (Math.max(c[0], c[1], c[2]) >= 250) cnt++;
      all.push(L); m++;
    }
    all.sort((a, b) => a - b);
    blown[`g${E}`] = +(cnt / m).toPrecision(3);
    median[`g${E}`] = +all[Math.floor(m * 0.5)].toFixed(1);
  }
  const clipFrac = blown;

  const excluded = wBelowGate / wTotal;
  return {
    depth: +depth.toFixed(1),
    gpuExposure: +shippedExposure.toPrecision(6),
    pinned: shippedExposure >= 25.59,
    meteredAvgLum: +meteredAvgLum.toPrecision(5),
    trueAvgLum_4595: +trueAvgLum.toPrecision(5),
    meterErrorEV: +Math.log2(meteredAvgLum / Math.max(trueAvgLum, 1e-30)).toFixed(3),
    // Stops of scene gain before targetEV lifts off the clamp and the meter
    // takes the exposure back. Negative means the meter is already in charge.
    clampHeadroomEV: +(FLOOR_EV - Math.log2(meteredAvgLum / KEY)).toFixed(3),
    wantedExposure_4595: +(KEY / Math.max(trueAvgLum, 1e-30)).toPrecision(5),
    wantedExposure_2080: +(KEY / Math.max(trueAvg2080, 1e-30)).toPrecision(5),
    wantedExposure_5090: +(KEY / Math.max(trueAvg5090, 1e-30)).toPrecision(5),
    fracBelowGate: +excluded.toPrecision(4),
    effectiveFrameWindow: [+((excluded + (1 - excluded) * LOW) * 100).toPrecision(4),
      +((excluded + (1 - excluded) * HIGH) * 100).toPrecision(4)],
    sceneMeanLum: +(sumL / n).toPrecision(4),
    sceneMaxLum: +maxL.toPrecision(4),
    percentileLum: ladder.map((r) => r.lum),
    deliveredCodeLuma: codes,
    blownFracAnyChannel: blown,
    deliveredMedianCode: median,
  };
}

const NAMES = ['beach', 'basalt', 'reef', 'coral', 'sand', 'kelp', 'boulders',
  'break', 'spires', 'terrace', 'canyon', 'abyssal', 'trenchwall', 'trenchfloor'];
const FROM = 0, TO = 7;

const out = {
  config: {
    tier: g.renderer.gpu.tier,
    taa: !!settings.get('taa') && !!g.renderer.gpu.preset.taa,
    bloom: settings.get('bloom'),
    EXPOSURE_MIN_EV: MIN_EV, HISTOGRAM_MIN_EV: HIST_MIN_EV, EXPOSURE_KEY: KEY,
    bin1SceneLinear: binToLum(1),
    histogramGate: GATE,
    evPerBin: +((MAX_EV - HIST_MIN_EV) / 254).toFixed(4),
    // 10.607 before the un-weld, 0.000 after: the first metered bin now starts
    // exactly where the inclusion gate stops rejecting. If this drifts off zero
    // the two constants have come apart again and every deep number is suspect.
    binEdgeAboveGateEV: +Math.log2(binToLum(1) / GATE).toFixed(3),
    meteringFloorLinear: 2 ** MIN_EV,
    clampFloorEV: +FLOOR_EV.toFixed(4),
    gainCeiling: +(2 ** -FLOOR_EV).toPrecision(6),
  },
};

for (let i = FROM; i < TO; i++) {
  g.worldClock.setDayFraction(0.32);
  const r = g.jumpTo(i);
  g.player.lampOn = r.depth > 150;
  // The tour pins the swimmer's altitude for the whole settle; mirror it so the
  // measurement and tools/shots/biome-tour.json photograph the same frame.
  let stop = false;
  (function pin() {
    if (stop) return;
    const p = g.player;
    if (!p.inVessel) { p.position[1] = r.y; p.prevPosition[1] = r.y; p.velocity[1] = 0; p.oxygen = p.oxygenCapacity; }
    requestAnimationFrame(pin);
  })();
  await sleep(2600);
  // The grade is evaluated at the CAMERA's depth, and only when the eye is
  // actually submerged - post.js passes 0 above the surface.
  const cam = g.renderer.camera;
  const d = cam.isUnderwater ? cam.depth : 0;
  out[`${String(i).padStart(2, '0')}-${NAMES[i]}`] = await measure(d, g.renderer.exposure);
  stop = true;
}

// A compact table so the interesting numbers survive the JSON dump.
out.TABLE = ['station         depth  expo    meteredAvg  trueAvg    errEV  wantEx  <gate  headEV '
  + '| delivered MEDIAN code at gain 25.6/51.2/102.4/204.8 | frame p95 code | blown (any channel >=250) %'];
for (const k of Object.keys(out)) {
  const r = out[k];
  if (!r || r.depth === undefined) continue;
  const c = r.deliveredCodeLuma;
  const K = ['g25.6', 'g51.2', 'g102.4', 'g204.8'];
  out.TABLE.push([k.padEnd(15), String(r.depth).padEnd(6), String(r.gpuExposure).padEnd(7),
    r.meteredAvgLum.toExponential(3).padEnd(11), r.trueAvgLum_4595.toExponential(3).padEnd(10),
    String(r.meterErrorEV).padEnd(6), String(r.wantedExposure_4595).padEnd(7),
    r.fracBelowGate.toFixed(3).padEnd(6), String(r.clampHeadroomEV).padEnd(6),
    '| med ' + K.map((q) => String(r.deliveredMedianCode[q]).padStart(5)).join(''),
    ' | p95 ' + K.map((q) => String(c[q][4]).padStart(6)).join(''),
    ' | blown% ' + K.map((q) => (r.blownFracAnyChannel[q] * 100).toFixed(2).padStart(6)).join(''),
  ].join(' '));
}
return out;
