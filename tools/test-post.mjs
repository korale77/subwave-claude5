#!/usr/bin/env node
/**
 * SUBWAVE post-chain numerical verification.
 *
 * The GPU work in render/passes/post.js cannot be run offline, but the maths it
 * encodes can. Two kinds of check live here:
 *
 *   - the CPU-side depth grade is imported and exercised directly
 *   - the shader maths (histogram binning, the percentile mean, the adaptation
 *     recurrence, the YCoCg transform, the bloom soft knee) is MIRRORED here
 *     line for line from the WGSL and checked against closed-form answers
 *
 * A mirror can drift from the shader, so each mirrored function names the file
 * and the function it copies. When one changes, this file must change with it -
 * that is the point: the numbers below are the contract.
 *
 * Usage:  node tools/test-post.mjs
 */

import { evaluateGrade, GRADE_KEYS, EXPOSURE_STATE_BYTES } from '../src/render/passes/post.js';
import { RENDER, DEPTH_BANDS, WORLD } from '../src/core/constants.js';

let failures = 0;
let checks = 0;

function ok(cond, label, detail = '') {
  checks++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;
function section(n) { console.log(`\n${n}`); }

// ---------------------------------------------------------------------------
// Depth grade
// ---------------------------------------------------------------------------

section('Depth-band colour grade');
{
  const at = (d) => {
    const g = evaluateGrade(d);
    return { gain: g.gain.slice(), sat: g.sat, lift: g.lift.slice(), gamma: g.gamma.slice() };
  };

  const surface = at(0);
  ok(surface.gain[0] === 1 && surface.gain[1] === 1 && surface.gain[2] === 1 &&
     surface.sat === 1 && surface.lift[0] === 0,
  'the surface grade is exactly neutral',
  `gain ${surface.gain.map((v) => v.toFixed(2)).join('/')} sat ${surface.sat.toFixed(2)}`);

  // Red must drain monotonically with depth: that is what the water does.
  let monotoneRed = true;
  let monotoneSat = true;
  let blueRises = true;
  let prev = at(0);
  for (let d = 5; d <= WORLD.MAX_DEPTH; d += 5) {
    const g = at(d);
    if (g.gain[0] > prev.gain[0] + 1e-9) monotoneRed = false;
    if (g.sat > prev.sat + 1e-9) monotoneSat = false;
    prev = g;
  }
  const deep = at(900);
  if (deep.gain[2] < surface.gain[2]) blueRises = false;
  ok(monotoneRed, 'red gain never increases with depth',
    `1.000 at 0 m -> ${at(WORLD.MAX_DEPTH).gain[0].toFixed(3)} at ${WORLD.MAX_DEPTH} m`);
  ok(monotoneSat, 'saturation never increases with depth',
    `1.000 -> ${at(WORLD.MAX_DEPTH).sat.toFixed(3)}`);
  ok(blueRises, 'blue is favoured relative to the surface in the deep',
    `blue gain ${deep.gain[2].toFixed(3)} at 900 m`);

  // Continuity: no seam as the camera hovers on a band boundary.
  let maxJump = 0;
  let jumpAt = 0;
  for (const band of DEPTH_BANDS) {
    for (const d of [band.min - 0.01, band.min, band.min + 0.01]) {
      if (d < 0) continue;
      const a = at(d - 0.05);
      const b = at(d + 0.05);
      for (let c = 0; c < 3; c++) {
        const j = Math.abs(a.gain[c] - b.gain[c]);
        if (j > maxJump) { maxJump = j; jumpAt = d; }
      }
    }
  }
  ok(maxJump < 0.01, 'the grade is continuous across every band boundary',
    `largest 0.1 m step ${maxJump.toExponential(2)} near ${jumpAt} m`);

  // The keys themselves must be reproduced exactly at their own depths.
  let keysExact = true;
  let keyDetail = '';
  for (const k of GRADE_KEYS) {
    const g = at(k.depth);
    for (let c = 0; c < 3; c++) {
      if (!near(g.gain[c], k.gain[c], 1e-6)) {
        keysExact = false;
        keyDetail = `depth ${k.depth}: ${g.gain[c]} != ${k.gain[c]}`;
      }
    }
  }
  ok(keysExact, 'every grade key is reproduced exactly at its own depth', keyDetail);

  const beyond = at(WORLD.MAX_DEPTH * 4);
  const atMax = at(WORLD.MAX_DEPTH);
  ok(near(beyond.gain[0], atMax.gain[0], 1e-9) && near(beyond.sat, atMax.sat, 1e-9),
    'depth beyond the trench floor clamps rather than extrapolating',
    `gain.r ${beyond.gain[0].toFixed(3)}`);

  const negative = at(-50);
  ok(negative.sat === 1, 'negative depth (above the surface) clamps to the neutral grade');

  let allFinite = true;
  for (let d = -100; d <= 3000; d += 7.3) {
    const g = evaluateGrade(d);
    if (![...g.gain, ...g.lift, ...g.gamma, g.sat, g.contrast].every(Number.isFinite)) {
      allFinite = false;
    }
  }
  ok(allFinite, 'no depth produces a non-finite grade term');
}

// ---------------------------------------------------------------------------
// Exposure: mirrors shaders/pass/exposure.wgsl
// ---------------------------------------------------------------------------

section('Auto exposure');

// THE BIN EDGES AND THE EXPOSURE LIMITS ARE DIFFERENT NUMBERS, un-welded
// 2026-08-04. HIST_MIN_EV is where the bins start (the 1e-5 inclusion gate);
// MIN_EV is the metering FLOOR, whose own target EV - log2(floor/key), not the
// floor itself - is the low clamp on targetEV and hence the 25.6x gain ceiling.
const MIN_EV = RENDER.EXPOSURE_MIN_EV;
const HIST_MIN_EV = RENDER.HISTOGRAM_MIN_EV;
const MAX_EV = RENDER.EXPOSURE_MAX_EV;
const FLOOR_EV = Math.log2(Math.pow(2, MIN_EV) / RENDER.EXPOSURE_KEY);
const METER_LOW = 0.45;
const METER_HIGH = 0.95;
const BINS = RENDER.HISTOGRAM_BINS;

/** Mirror of luminanceToBin() in exposure.wgsl. */
function luminanceToBin(lum) {
  if (lum < 1e-5) return 0;
  const ev = Math.log2(lum);
  const t = Math.max(0, Math.min(1, (ev - HIST_MIN_EV) / Math.max(MAX_EV - HIST_MIN_EV, 1e-3)));
  return Math.max(1, Math.min(BINS - 1, Math.floor(t * 254 + 1)));
}

/** Mirror of binToLuminance() in exposure.wgsl. */
function binToLuminance(bin) {
  const t = (bin - 1) / 254;
  return Math.pow(2, HIST_MIN_EV + (MAX_EV - HIST_MIN_EV) * t);
}

/** Mirror of the percentile-window reduction in cs_adapt(). */
function meterHistogram(bins) {
  let total = 0;
  for (let i = 1; i < BINS; i++) total += bins[i];
  if (total <= 0) return 0;
  const lo = total * METER_LOW;
  const hi = total * METER_HIGH;
  let seen = 0;
  let sumLog = 0;
  let sumW = 0;
  for (let i = 1; i < BINS; i++) {
    const c = bins[i];
    if (c > 0) {
      const a = Math.max(seen, lo);
      const b = Math.min(seen + c, hi);
      const inside = Math.max(0, b - a);
      if (inside > 0) {
        sumLog += Math.log2(Math.max(binToLuminance(i), 1e-6)) * inside;
        sumW += inside;
      }
      seen += c;
    }
  }
  return sumW > 0 ? Math.pow(2, sumLog / sumW) : 0;
}

/** Mirror of the adaptation recurrence in cs_adapt(). */
function adaptStep(prevEV, targetEV, dt) {
  const clamped = Math.max(FLOOR_EV, Math.min(MAX_EV, targetEV));
  const speed = clamped > prevEV ? RENDER.EXPOSURE_SPEED_UP : RENDER.EXPOSURE_SPEED_DOWN;
  return prevEV + (clamped - prevEV) * (1 - Math.exp(-dt * speed));
}

{
  // Binning is monotone and round-trips to within one bin.
  let monotone = true;
  let prevBin = -1;
  for (let ev = HIST_MIN_EV; ev <= MAX_EV; ev += 0.01) {
    const b = luminanceToBin(Math.pow(2, ev));
    if (b < prevBin) monotone = false;
    prevBin = b;
  }
  ok(monotone, 'log-luminance binning is monotone across the whole EV range',
    `${HIST_MIN_EV.toFixed(2)} .. ${MAX_EV} EV in ${BINS - 1} bins`);

  const quantum = (MAX_EV - HIST_MIN_EV) / 254;
  let worst = 0;
  for (let ev = HIST_MIN_EV; ev <= MAX_EV; ev += 0.037) {
    const lum = Math.pow(2, ev);
    const back = binToLuminance(luminanceToBin(lum));
    worst = Math.max(worst, Math.abs(Math.log2(back) - ev));
  }
  ok(worst <= quantum * 1.01, 'bin round-trip error is within one bin',
    `worst ${worst.toFixed(4)} EV, bin width ${quantum.toFixed(4)} EV`);

  ok(luminanceToBin(1e-9) === 0 && luminanceToBin(0) === 0,
    'true black lands in the excluded bin 0');
  ok(luminanceToBin(Math.pow(2, MAX_EV + 5)) === BINS - 1,
    'over-range luminance saturates the top bin');

  // A synthetic scene: 90% of the weight at 2^-4, 10% at 2^8. The window
  // [0.45, 0.95] therefore covers 0.45 of the dark and 0.05 of the bright, so
  // the log mean is (0.45*-4 + 0.05*8)/0.50 = -2.8 EV.
  const bins = new Float64Array(BINS);
  bins[luminanceToBin(Math.pow(2, -4))] += 900;
  bins[luminanceToBin(Math.pow(2, 8))] += 100;
  const avg = meterHistogram(bins);
  ok(near(Math.log2(avg), -2.8, quantum * 1.5),
    'the percentile window rejects the darkest 45% and the brightest 5%',
    `metered ${Math.log2(avg).toFixed(4)} EV, expected -2.8000 EV`);

  const targetEV = Math.log2(avg / 0.18);
  ok(near(targetEV, -0.326, 0.12), 'target EV maps the metered average onto 18% grey',
    `${targetEV.toFixed(4)} EV -> exposure x${Math.pow(2, -targetEV).toFixed(4)}`);

  // A frame that is entirely below the 1e-5 inclusion gate must meter as
  // nothing, so the shader holds the previous exposure rather than snapping.
  const black = new Float64Array(BINS);
  black[0] = 1e6;
  ok(meterHistogram(black) === 0, 'an all-black frame meters as "no data"');

  // Adaptation rates. 90% convergence takes ln(10)/rate seconds.
  const converge = (from, to, dt) => {
    let ev = from;
    let t = 0;
    const target = Math.max(MIN_EV, Math.min(MAX_EV, to));
    const start = Math.abs(target - from);
    while (t < 60) {
      ev = adaptStep(ev, to, dt);
      t += dt;
      if (Math.abs(target - ev) <= start * 0.1) break;
    }
    return t;
  };

  const dt = 1 / 60;
  const tDown = converge(14, -2, dt);          // surface -> abyss, slow
  const tUp = converge(-2, 14, dt);            // abyss -> surface, fast
  const expectDown = Math.log(10) / RENDER.EXPOSURE_SPEED_DOWN;
  const expectUp = Math.log(10) / RENDER.EXPOSURE_SPEED_UP;
  ok(near(tDown, expectDown, 0.06), 'dark adaptation uses EXPOSURE_SPEED_DOWN',
    `90% in ${tDown.toFixed(3)} s (closed form ${expectDown.toFixed(3)} s)`);
  ok(near(tUp, expectUp, 0.06), 'light adaptation uses EXPOSURE_SPEED_UP',
    `90% in ${tUp.toFixed(3)} s (closed form ${expectUp.toFixed(3)} s)`);
  ok(tDown > tUp * 2, 'descending into the dark adapts far slower than surfacing',
    `${(tDown / tUp).toFixed(2)}x slower`);

  // Frame-rate independence: the same wall-clock convergence at 30 and 240 Hz.
  const t30 = converge(14, -2, 1 / 30);
  const t240 = converge(14, -2, 1 / 240);
  ok(near(t30, t240, 0.05), 'adaptation is frame-rate independent',
    `${t30.toFixed(3)} s at 30 Hz vs ${t240.toFixed(3)} s at 240 Hz`);

  // Clamping.
  let ev = 0;
  for (let i = 0; i < 6000; i++) ev = adaptStep(ev, 999, dt);
  ok(near(ev, MAX_EV, 1e-6), 'EV clamps at EXPOSURE_MAX_EV', `${ev.toFixed(4)}`);
  for (let i = 0; i < 6000; i++) ev = adaptStep(ev, -999, dt);
  ok(near(ev, FLOOR_EV, 1e-6), 'EV clamps at the metering floor\'s own target EV',
    `${ev.toFixed(4)} EV = log2(2^${MIN_EV} / ${RENDER.EXPOSURE_KEY})`);

  // The un-weld (2026-08-04). These two are the whole contract: the bins reach
  // the inclusion gate, and the gain ceiling did NOT move when they did.
  ok(near(Math.pow(2, -FLOOR_EV), 25.6, 1e-9),
    'the gain ceiling is still exactly 25.6x after un-welding the bin edges',
    `x${Math.pow(2, -FLOOR_EV).toFixed(6)}`);
  ok(near(binToLuminance(1), 1e-5, 1e-12) && HIST_MIN_EV < MIN_EV,
    'bin 1 starts at the histogram\'s own 1e-5 gate, not at the metering floor',
    `binToLuminance(1) = ${binToLuminance(1).toExponential(3)}, `
    + `${(MIN_EV - HIST_MIN_EV).toFixed(2)} EV above it before the un-weld`);

  ok(EXPOSURE_STATE_BYTES === BINS * 4 + 16,
    'the exposure state buffer matches the WGSL struct',
    `${EXPOSURE_STATE_BYTES} bytes = ${BINS} u32 bins + 4 f32`);
}

// ---------------------------------------------------------------------------
// TAA colour space: mirrors shaders/pass/taa.wgsl
// ---------------------------------------------------------------------------

section('TAA');
{
  const rgbToYCoCg = (c) => [
    0.25 * c[0] + 0.5 * c[1] + 0.25 * c[2],
    0.5 * c[0] - 0.5 * c[2],
    -0.25 * c[0] + 0.5 * c[1] - 0.25 * c[2],
  ];
  const yCoCgToRgb = (c) => {
    const t = c[0] - c[2];
    return [t + c[1], c[0] + c[2], t - c[1]];
  };

  let worst = 0;
  for (let i = 0; i < 20000; i++) {
    const c = [Math.random() * 4, Math.random() * 4, Math.random() * 4];
    const back = yCoCgToRgb(rgbToYCoCg(c));
    for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(back[k] - c[k]));
  }
  ok(worst < 1e-12, 'the YCoCg transform round-trips exactly',
    `worst error ${worst.toExponential(2)} over 20000 random colours`);

  const grey = rgbToYCoCg([0.5, 0.5, 0.5]);
  ok(near(grey[0], 0.5, 1e-12) && near(grey[1], 0, 1e-12) && near(grey[2], 0, 1e-12),
    'grey has zero chroma', `Y=${grey[0]} Co=${grey[1]} Cg=${grey[2]}`);

  // The range compression used for temporal averaging must be invertible for
  // any physically possible HDR value, or bright pixels come back wrong.
  // The 1e-5 floor bounds reconstruction at 1e5; the rgba16float history clips
  // at 65504, so the transform must be exact everywhere below that.
  const compress = (c) => c / (1 + Math.max(c, 0));
  const decompress = (c) => c / Math.max(1 - c, 1e-5);
  let cWorst = 0;
  for (let ev = -12; ev <= 16; ev += 0.05) {
    const v = Math.pow(2, ev);
    cWorst = Math.max(cWorst, Math.abs(decompress(compress(v)) - v) / v);
  }
  ok(cWorst < 1e-3, 'the Karis range compression is invertible over the whole fp16 range',
    `worst relative error ${cWorst.toExponential(2)} from 2^-12 to 2^16`);

  // Feedback ramp: still frames keep TAA_FEEDBACK_MAX, fast motion falls to MIN.
  const feedback = (velPixels) => {
    const t = Math.max(0, Math.min(1, velPixels / 32));
    return RENDER.TAA_FEEDBACK_MAX +
      (RENDER.TAA_FEEDBACK_MIN - RENDER.TAA_FEEDBACK_MAX) * t;
  };
  ok(near(feedback(0), RENDER.TAA_FEEDBACK_MAX, 1e-9) &&
     near(feedback(32), RENDER.TAA_FEEDBACK_MIN, 1e-9) &&
     feedback(8) > feedback(24),
  'feedback interpolates TAA_FEEDBACK_MAX -> MIN with screen velocity',
  `${feedback(0)} at rest, ${feedback(32).toFixed(3)} at 32 px/frame`);

  // Effective history length: how many frames a still pixel takes to converge.
  const framesToConverge = (f) => Math.ceil(Math.log(0.01) / Math.log(f));
  ok(framesToConverge(RENDER.TAA_FEEDBACK_MAX) <= 160,
    'a static pixel converges within a sane number of frames',
    `${framesToConverge(RENDER.TAA_FEEDBACK_MAX)} frames at feedback ` +
    `${RENDER.TAA_FEEDBACK_MAX}, ${framesToConverge(RENDER.TAA_FEEDBACK_MIN)} at ` +
    `${RENDER.TAA_FEEDBACK_MIN}`);
}

// ---------------------------------------------------------------------------
// Bloom soft knee: mirrors thresholdSoft() in shaders/pass/bloom.wgsl
// ---------------------------------------------------------------------------

section('Bloom threshold');
{
  const BLOOM_KNEE = 0.45;
  const thresholdSoft = (br, threshold, knee) => {
    const k = Math.max(knee, 1e-4);
    const soft = Math.max(0, Math.min(br - threshold + k, 2 * k));
    return Math.max(soft * soft / (4 * k), br - threshold);
  };

  const T = RENDER.BLOOM_THRESHOLD;
  // Exactly at threshold - knee the expression evaluates to a float-error
  // residue rather than a hard zero; anything below it is exactly zero.
  ok(thresholdSoft(T - BLOOM_KNEE - 0.01, T, BLOOM_KNEE) === 0 &&
     thresholdSoft(T - BLOOM_KNEE, T, BLOOM_KNEE) < 1e-24,
  'nothing below threshold - knee contributes any bloom',
  `luminance ${(T - BLOOM_KNEE).toFixed(2)} -> ` +
  `${thresholdSoft(T - BLOOM_KNEE, T, BLOOM_KNEE).toExponential(1)}`);
  ok(thresholdSoft(0, T, BLOOM_KNEE) === 0, 'black contributes no bloom');

  let maxJump = 0;
  let prev = thresholdSoft(0, T, BLOOM_KNEE);
  for (let br = 0; br <= 8; br += 0.001) {
    const v = thresholdSoft(br, T, BLOOM_KNEE);
    maxJump = Math.max(maxJump, Math.abs(v - prev));
    prev = v;
  }
  ok(maxJump < 0.002, 'the knee is continuous - no pop as a value crosses threshold',
    `largest step ${maxJump.toExponential(2)} per 0.001 of luminance`);

  let monotone = true;
  prev = -1;
  for (let br = 0; br <= 20; br += 0.005) {
    const v = thresholdSoft(br, T, BLOOM_KNEE);
    if (v < prev - 1e-12) monotone = false;
    prev = v;
  }
  ok(monotone, 'bloom contribution is monotone in luminance');
  ok(near(thresholdSoft(10, T, BLOOM_KNEE), 10 - T, 1e-9),
    'well above threshold the knee is exactly a linear subtraction',
    `${thresholdSoft(10, T, BLOOM_KNEE).toFixed(4)} = 10 - ${T}`);

  // Karis firefly suppression: one very bright sample among four must not
  // dominate the average the way an unweighted mean would.
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const karis = (groups) => {
    let acc = [0, 0, 0];
    let wsum = 0;
    for (const g of groups) {
      const w = 1 / (1 + lum(g));
      for (let i = 0; i < 3; i++) acc[i] += g[i] * w;
      wsum += w;
    }
    return acc.map((v) => v / wsum);
  };
  const firefly = [[1, 1, 1], [1, 1, 1], [1, 1, 1], [4000, 4000, 4000]];
  const plain = firefly.reduce((a, g) => a.map((v, i) => v + g[i] / 4), [0, 0, 0]);
  const weighted = karis(firefly);
  ok(weighted[0] < plain[0] / 100, 'the Karis weight suppresses a 4000:1 firefly',
    `unweighted mean ${plain[0].toFixed(1)} vs Karis ${weighted[0].toFixed(3)}`);
  const uniform = karis([[2, 2, 2], [2, 2, 2], [2, 2, 2], [2, 2, 2]]);
  ok(near(uniform[0], 2, 1e-9), 'a uniform neighbourhood is unchanged by the weighting',
    `${uniform[0].toFixed(6)}`);
}

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? 'Post chain verified.' : `${failures} FAILURE(S)`}  ` +
  `${checks - failures}/${checks} checks passed.\n`);
process.exit(failures ? 1 : 0);
