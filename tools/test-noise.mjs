#!/usr/bin/env node
/**
 * Noise library verification.
 *
 * Guards the properties the world generator depends on:
 *   - every basis function stays inside its documented range
 *   - the mean is ~0 (no DC bias that would shift the whole seafloor)
 *   - the same seed gives bit-identical results (the determinism contract)
 *   - tileable variants wrap exactly
 *   - the hot paths are fast enough to generate chunks inside a frame budget
 *
 * Run:  node tools/test-noise.mjs
 */

import * as N from '../src/world/noise.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

function survey(fn, n = 400000) {
  let mn = Infinity, mx = -Infinity, sum = 0;
  for (let i = 0; i < n; i++) {
    const v = fn(i);
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    sum += v;
  }
  return { mn, mx, mean: sum / n };
}

// Well-spread sample coordinates that avoid landing on lattice points.
const cx = (i) => (i * 0.6180339887) % 997 * 3.1 - 500;
const cy = (i) => (i * 0.4142135623) % 991 * 2.7 - 500;
const cz = (i) => (i * 0.7320508075) % 983 * 1.9 - 500;

console.log('\nRange and bias\n');

const bipolar = [
  ['value2', (i) => N.value2(cx(i), cy(i), 1234)],
  ['value3', (i) => N.value3(cx(i), cy(i), cz(i), 1234)],
  ['perlin2', (i) => N.perlin2(cx(i), cy(i), 1234)],
  ['perlin3', (i) => N.perlin3(cx(i), cy(i), cz(i), 1234)],
  ['simplex2', (i) => N.simplex2(cx(i), cy(i), 1234)],
  ['simplex3', (i) => N.simplex3(cx(i), cy(i), cz(i), 1234)],
  ['fbm2/simplex2', (i) => N.fbm2(N.simplex2, cx(i) * 0.1, cy(i) * 0.1, 42, 6)],
  ['fbm3/simplex3', (i) => N.fbm3(N.simplex3, cx(i) * 0.1, cy(i) * 0.1, cz(i) * 0.1, 42, 5)],
];

for (const [name, fn] of bipolar) {
  const s = survey(fn);
  check(`${name} within [-1.05, 1.05]`, s.mn >= -1.05 && s.mx <= 1.05,
    `min=${s.mn.toFixed(3)} max=${s.mx.toFixed(3)}`);
  check(`${name} mean near 0`, Math.abs(s.mean) < 0.02, `mean=${s.mean.toFixed(4)}`);
  // A basis whose observed peak never approaches 1 wastes dynamic range and
  // makes amplitudes-in-metres a lie, so require it to actually get there.
  if (!name.startsWith('fbm')) {
    check(`${name} uses its range`, Math.max(-s.mn, s.mx) > 0.75,
      `peak=${Math.max(-s.mn, s.mx).toFixed(3)}`);
  }
}

const unipolar = [
  ['ridged2', (i) => N.ridged2(cx(i) * 0.03, cy(i) * 0.03, 99)],
  ['billow2', (i) => N.billow2(cx(i) * 0.03, cy(i) * 0.03, 99)],
  ['turbulence3', (i) => N.turbulence3(cx(i) * 0.03, cy(i) * 0.03, cz(i) * 0.03, 99)],
  ['worley2F1', (i) => N.worley2F1(cx(i) * 0.07, cy(i) * 0.07, 5)],
  ['worley3F1', (i) => N.worley3F1(cx(i) * 0.07, cy(i) * 0.07, cz(i) * 0.07, 5)],
  ['worley2Edge', (i) => N.worley2Edge(cx(i) * 0.07, cy(i) * 0.07, 5)],
];

for (const [name, fn] of unipolar) {
  const s = survey(fn, 200000);
  check(`${name} within [0, 1]`, s.mn >= -1e-6 && s.mx <= 1 + 1e-6,
    `min=${s.mn.toFixed(3)} max=${s.mx.toFixed(3)}`);
}

console.log('\nDeterminism\n');

{
  const probes = [
    () => N.simplex2(12.34, -5.678, 777),
    () => N.simplex3(12.34, -5.678, 9.01, 777),
    () => N.perlin3(-3.5, 88.25, 0.125, 31337),
    () => N.ridged2(4.5, -9.25, 8),
    () => N.worley2F1(1.5, 2.5, 3),
    () => N.fbm2(N.simplex2, 0.75, -0.25, 11, 7),
  ];
  let stable = true;
  for (const p of probes) {
    const a = p(), b = p(), c = p();
    if (!(a === b && b === c)) stable = false;
  }
  check('repeated calls are bit-identical', stable);

  // Different seeds must actually decorrelate.
  let same = 0;
  for (let i = 0; i < 5000; i++) {
    if (N.simplex2(cx(i), cy(i), 1) === N.simplex2(cx(i), cy(i), 2)) same++;
  }
  check('different seeds decorrelate', same < 10, `${same}/5000 collisions`);
}

console.log('\nTiling\n');

for (const period of [32, 64, 128]) {
  let maxErr = 0;
  for (let i = 0; i < 2000; i++) {
    const x = (i * 7.31) % period, y = (i * 11.17) % period;
    maxErr = Math.max(
      maxErr,
      Math.abs(N.tileableFbm2(x, y, period, 3, 4) - N.tileableFbm2(x + period, y, period, 3, 4)),
      Math.abs(N.tileableFbm2(x, y, period, 3, 4) - N.tileableFbm2(x, y + period, period, 3, 4)),
    );
  }
  check(`tileableFbm2 wraps at period ${period}`, maxErr < 1e-9, `maxErr=${maxErr.toExponential(2)}`);
}

console.log('\nScatter\n');

{
  const out = new Float64Array(4);
  N.scatterPoint(out, 5, -3, 8, 1234);
  const x1 = out[0], z1 = out[1];
  N.scatterPoint(out, 5, -3, 8, 1234);
  check('scatterPoint is stable per cell', out[0] === x1 && out[1] === z1);
  check('scatterPoint stays inside its cell',
    x1 >= 5 * 8 && x1 <= 6 * 8 && z1 >= -3 * 8 && z1 <= -2 * 8,
    `x=${x1.toFixed(2)} z=${z1.toFixed(2)}`);

  const pts = N.poissonDisk(200, 200, 10, 42);
  let minDist = Infinity;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      minDist = Math.min(minDist, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
    }
  }
  check('poissonDisk respects min distance', minDist >= 10 - 1e-9,
    `${pts.length} points, min separation ${minDist.toFixed(3)}`);
  const pts2 = N.poissonDisk(200, 200, 10, 42);
  check('poissonDisk is deterministic', JSON.stringify(pts) === JSON.stringify(pts2));
}

console.log('\nShaping\n');

{
  check('smin blends below both inputs', N.smin(3, 5, 1) <= 3);
  check('smin degenerates to min for k=0', Math.abs(N.smin(3, 5, 1e-9) - 3) < 1e-6);
  check('smax degenerates to max for k=0', Math.abs(N.smax(3, 5, 1e-9) - 5) < 1e-6);
  check('terrace is monotonic', (() => {
    let prev = -Infinity;
    for (let v = 0; v <= 1.0001; v += 0.005) {
      const t = N.terrace(v, 6, 0.3);
      if (t < prev - 1e-9) return false;
      prev = t;
    }
    return true;
  })());

  const nrm = new Float64Array(3);
  N.normalFromHeight(nrm, () => 10, 0, 0, 0.5);
  check('normalFromHeight on flat ground is +Y',
    Math.abs(nrm[0]) < 1e-9 && Math.abs(nrm[1] - 1) < 1e-9 && Math.abs(nrm[2]) < 1e-9);

  // curl3 is analytically divergence-free; what remains is finite-difference
  // truncation error. Measure divergence at the SAME eps used to build the
  // curl, and compare it against the field's own magnitude - an absolute
  // threshold is meaningless because both scale together.
  const a = new Float64Array(3), b = new Float64Array(3), v = new Float64Array(3);
  const e = 0.01;
  let maxRatio = 0, maxMag = 0;
  for (let i = 0; i < 200; i++) {
    const x = cx(i) * 0.01, y = cy(i) * 0.01, z = cz(i) * 0.01;
    N.curl3(a, x + e, y, z, 7, e); N.curl3(b, x - e, y, z, 7, e);
    let div = (a[0] - b[0]) / (2 * e);
    N.curl3(a, x, y + e, z, 7, e); N.curl3(b, x, y - e, z, 7, e);
    div += (a[1] - b[1]) / (2 * e);
    N.curl3(a, x, y, z + e, 7, e); N.curl3(b, x, y, z - e, 7, e);
    div += (a[2] - b[2]) / (2 * e);

    N.curl3(v, x, y, z, 7, e);
    const mag = Math.hypot(v[0], v[1], v[2]);
    maxMag = Math.max(maxMag, mag);
    // Divergence has units of field/length, so normalise by mag/eps.
    if (mag > 1e-6) maxRatio = Math.max(maxRatio, Math.abs(div) * e / mag);
  }
  check('curl3 is divergence-free to truncation error', maxRatio < 0.05,
    `relative divergence=${maxRatio.toFixed(4)}, peak |v|=${maxMag.toFixed(3)}`);
  check('curl3 produces a usable field', maxMag > 0.05, `peak |v|=${maxMag.toFixed(3)}`);
}

console.log('\nThroughput\n');

const bench = (label, fn, n) => {
  fn(0); // warm up
  const t0 = performance.now();
  let acc = 0;
  for (let i = 0; i < n; i++) acc += fn(i);
  const ms = performance.now() - t0;
  console.log(`  ${label.padEnd(28)} ${((n / ms) / 1000).toFixed(1).padStart(7)} M samples/s   (${ms.toFixed(0)} ms for ${(n / 1e6).toFixed(1)}M)`);
  return acc;
};

bench('simplex2', (i) => N.simplex2(i * 0.01, i * 0.007, 1), 2000000);
bench('simplex3', (i) => N.simplex3(i * 0.01, i * 0.007, i * 0.013, 1), 1000000);
bench('fbm2 x6 octaves', (i) => N.fbm2(N.simplex2, i * 0.01, i * 0.007, 1, 6), 500000);
bench('ridged2 x5 octaves', (i) => N.ridged2(i * 0.01, i * 0.007, 1, 5), 500000);
bench('worley2F1', (i) => N.worley2F1(i * 0.01, i * 0.007, 1), 500000);

// A 129x129 heightfield chunk with a 6-octave stack is the real workload.
{
  const t0 = performance.now();
  let acc = 0;
  for (let z = 0; z < 129; z++) {
    for (let x = 0; x < 129; x++) {
      acc += N.warpedFbm2(x * 0.5, z * 0.5, 1234, { octaves: 6 });
    }
  }
  const ms = performance.now() - t0;
  console.log(`  ${'129x129 warped chunk'.padEnd(28)} ${ms.toFixed(1).padStart(7)} ms`);
  check('chunk generation under 40 ms', ms < 40, `${ms.toFixed(1)} ms`);
}

console.log(`\n${failures === 0 ? 'All noise checks passed.' : `${failures} CHECK(S) FAILED.`}\n`);
process.exit(failures ? 1 : 0);
