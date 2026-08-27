#!/usr/bin/env node
/**
 * Sky, day/night and weather verification.
 *
 * Runs entirely offline. It exercises the parts of src/sim/sky.js and
 * src/sim/weather.js that do not need a GPU - which is all of the ephemeris,
 * the key-frame interpolation, the SH ambient probe, the star catalogue and
 * the whole weather state machine - and asserts real numeric properties
 * rather than "it did not throw".
 *
 * Run:  node tools/test-sky.mjs
 */

import { readFileSync } from 'node:fs';
import { Renderer } from '../src/render/renderer.js';
import { WorldClock, SECONDS_PER_DAY } from '../src/core/time.js';
import { SkySystem, SKY_UNIFORM_BYTES } from '../src/sim/sky.js';
import { WeatherSystem, STATE_IDS } from '../src/sim/weather.js';
import { TIME_KEYS, SKY, WORLD, WATER_TYPES } from '../src/core/constants.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? '   ' + detail : ''}`);
  if (!ok) failures++;
};
const finite = (v) => Number.isFinite(v);
const allFinite = (a) => Array.from(a).every(finite);

// ---------------------------------------------------------------------------
// Setup: a real Renderer, never initialised. Its constructor allocates only
// typed arrays, so env and updateAmbientSH are the genuine implementations.
// ---------------------------------------------------------------------------

const renderer = new Renderer();
const clock = new WorldClock(0);
const sky = new SkySystem(null, null, null, clock);

// The day/night curve is specified for a CLEAR sky (DESIGN 03.9.3), so the
// cloud coupling is switched off for the sweep and tested separately below.
renderer.env.cloudCover = 0;

const STEPS = 96;
const samples = [];

for (let i = 0; i < STEPS; i++) {
  const f = i / STEPS;
  clock.setDayFraction(f);
  clock.moonPhases[0] = ((clock.totalSeconds / SECONDS_PER_DAY) / SKY.MOONS[0].period) % 1;
  clock.moonPhases[1] = ((clock.totalSeconds / SECONDS_PER_DAY) / SKY.MOONS[1].period) % 1;
  sky.update(clock, renderer, SECONDS_PER_DAY / STEPS);

  const sh = renderer.env.ambientSH;
  samples.push({
    f,
    elevation: Math.asin(Math.max(-1, Math.min(1, sky.sunDir[1]))),
    sunY: sky.sunDir[1],
    intensity: renderer.env.sunIntensity,
    moonIntensity: renderer.env.moonIntensity,
    moonPhase: renderer.env.moonPhase,
    stars: sky.starVisibility,
    shDC: [sh[0], sh[1], sh[2]],
    zenith: Array.from(sky.zenithColor),
    horizon: Array.from(sky.horizonColor),
    ground: Array.from(sky.groundColor),
  });
}

// ---------------------------------------------------------------------------
// 1. No NaN anywhere.
// ---------------------------------------------------------------------------

let nanCount = 0;
for (const s of samples) {
  if (!finite(s.elevation) || !finite(s.intensity) || !finite(s.moonIntensity) ||
      !finite(s.moonPhase) || !finite(s.stars)) nanCount++;
  if (!allFinite(s.shDC) || !allFinite(s.zenith) || !allFinite(s.horizon) ||
      !allFinite(s.ground)) nanCount++;
}
const uniformFinite = allFinite(sky.uniformF32);
check('no NaN/Inf in 96 sampled frames', nanCount === 0, `${nanCount} bad samples`);
check('no NaN/Inf in the Sky uniform', uniformFinite);
check(`Sky uniform is exactly ${SKY_UNIFORM_BYTES} bytes`,
  sky.uniformF32.byteLength === SKY_UNIFORM_BYTES);

// ---------------------------------------------------------------------------
// 2. Sun elevation: smooth, continuous, peaking near dayFraction 0.5.
// ---------------------------------------------------------------------------

let peak = 0;
for (let i = 1; i < samples.length; i++) {
  if (samples[i].elevation > samples[peak].elevation) peak = i;
}
const peakF = samples[peak].f;
check('sun elevation peaks near dayFraction 0.5',
  Math.abs(peakF - 0.5) <= 1 / STEPS + 1e-9,
  `peak at ${peakF.toFixed(4)}, elevation ${(samples[peak].elevation * 57.2958).toFixed(2)} deg`);

// Continuity: the largest step between adjacent samples, including the
// midnight wrap, must be far below the 2*PI/STEPS a discontinuity would show.
let maxStep = 0;
for (let i = 0; i < samples.length; i++) {
  const a = samples[i].elevation;
  const b = samples[(i + 1) % samples.length].elevation;
  maxStep = Math.max(maxStep, Math.abs(b - a));
}
check('sun elevation is continuous across the whole cycle including the wrap',
  maxStep < 0.12, `max adjacent step ${(maxStep * 57.2958).toFixed(3)} deg`);

// Smoothness: the second difference is bounded, i.e. the curve has no kink.
let maxCurvature = 0;
for (let i = 0; i < samples.length; i++) {
  const a = samples[(i - 1 + samples.length) % samples.length].elevation;
  const b = samples[i].elevation;
  const c = samples[(i + 1) % samples.length].elevation;
  maxCurvature = Math.max(maxCurvature, Math.abs(c - 2 * b + a));
}
check('sun elevation is smooth (bounded second difference)',
  maxCurvature < 0.02, `max |d2| ${maxCurvature.toExponential(3)}`);

// Monotone rise from midnight to noon, monotone fall from noon to midnight.
let riseViolations = 0;
let fallViolations = 0;
for (let i = 0; i < samples.length - 1; i++) {
  const rising = samples[i].f < 0.5;
  const d = samples[i + 1].elevation - samples[i].elevation;
  if (rising && d < -1e-6) riseViolations++;
  if (!rising && d > 1e-6) fallViolations++;
}
check('sun rises monotonically to noon and falls monotonically after',
  riseViolations === 0 && fallViolations === 0,
  `${riseViolations} rise / ${fallViolations} fall violations`);

// ---------------------------------------------------------------------------
// 3. Sun intensity: zero at night, maximal at noon.
// ---------------------------------------------------------------------------

const noon = samples.find((s) => Math.abs(s.f - 0.5) < 1e-9);
let maxIntensity = 0;
for (const s of samples) maxIntensity = Math.max(maxIntensity, s.intensity);
check('sunIntensity is maximal at solar noon',
  Math.abs(noon.intensity - maxIntensity) < 1e-6,
  `noon ${noon.intensity.toFixed(3)} of max ${maxIntensity.toFixed(3)}`);
check('sunIntensity at noon equals SKY.SUN_INTENSITY_NOON',
  Math.abs(noon.intensity - SKY.SUN_INTENSITY_NOON) < 1e-3,
  `${noon.intensity.toFixed(3)} vs ${SKY.SUN_INTENSITY_NOON}`);

// "Night" here is every sample whose sun is below the horizon: the direct sun
// term must be exactly zero, not merely small, or a shaded surface picks up
// key light from under the sea.
const nightSamples = samples.filter((s) => s.sunY < -0.05);
const maxNight = nightSamples.reduce((m, s) => Math.max(m, s.intensity), 0);
check(`sunIntensity is exactly zero for all ${nightSamples.length} below-horizon samples`,
  maxNight === 0, `max ${maxNight}`);

let negative = 0;
for (const s of samples) if (s.intensity < 0) negative++;
check('sunIntensity is never negative', negative === 0);

// ---------------------------------------------------------------------------
// 4. Ambient SH: DC term non-negative for every channel at every time.
// ---------------------------------------------------------------------------

let dcViolations = 0;
let minDC = Infinity;
for (const s of samples) {
  for (const c of s.shDC) {
    if (c < 0) dcViolations++;
    minDC = Math.min(minDC, c);
  }
}
check('ambient SH DC term is non-negative at all 96 times',
  dcViolations === 0, `min DC ${minDC.toExponential(3)}`);

// The DC term is 3.5449 * mean sky radiance, and evalAmbientSH() divides that
// back out, so DC/3.5449 is the radiance a flat surface receives. At noon it
// should be about 0.22 of the sun's illuminance, per DESIGN 03.9.3.
const noonDC = (noon.shDC[0] + noon.shDC[1] + noon.shDC[2]) / 3;
const noonAmbientIrradiance = Math.PI * (noonDC / 3.5449077);
const ratio = noonAmbientIrradiance / noon.intensity;
check('noon sky/sun irradiance ratio is near the 0.22 in DESIGN 03.9.3',
  ratio > 0.15 && ratio < 0.32, `ratio ${ratio.toFixed(4)}`);

// Ambient must be monotone-ish: brightest at noon, darkest at midnight.
const midnightDC = (samples[0].shDC[0] + samples[0].shDC[1] + samples[0].shDC[2]) / 3;
check('ambient at midnight is far below ambient at noon',
  midnightDC < noonDC * 0.02,
  `midnight ${midnightDC.toExponential(3)} vs noon ${noonDC.toExponential(3)}`);

// Overcast redistribution (DESIGN 03.9.3): the direct sun goes away and the
// sky carries 22% of what the two used to deliver together, so at noon the sky
// gets BRIGHTER while the scene as a whole loses most of its light.
clock.setDayFraction(0.5);
renderer.env.cloudCover = 0;
sky.update(clock, renderer, 0);
const clearSun = renderer.env.sunIntensity;
const clearSky = renderer.env.ambientSH[1];
renderer.env.cloudCover = 1;
sky.update(clock, renderer, 0);
const overcastSun = renderer.env.sunIntensity;
const overcastSky = renderer.env.ambientSH[1];
check('full overcast removes the direct sun', overcastSun < clearSun * 0.03,
  `${overcastSun.toFixed(3)} vs ${clearSun.toFixed(3)}`);
check('full overcast brightens the sky while darkening the scene',
  overcastSky > clearSky && overcastSky < clearSky * 1.6,
  `sky DC ${clearSky.toFixed(2)} -> ${overcastSky.toFixed(2)}`);
const clearTotal = clearSun + Math.PI * clearSky / 3.5449077;
const overcastTotal = overcastSun + Math.PI * overcastSky / 3.5449077;
check('overcast total illuminance is near the 22% in DESIGN 03.9.3',
  overcastTotal / clearTotal > 0.15 && overcastTotal / clearTotal < 0.30,
  `${(100 * overcastTotal / clearTotal).toFixed(1)}%`);

// SCATTERED cloud must not dim anything. Cover is not an opacity: at 0.45 the
// sun is either out or behind a cloud, never permanently at 56%, and the
// per-pixel version of that is the cloud render itself. Keying the dim on cover
// cost 38% of env.sunIntensity at 0.45 (73.17 -> 45.35) and desaturated the
// zenith probe from B/R 1.80 to 1.47, so every fix to the empty sky made the
// lit world worse. SKY.OVERCAST_BAND is the whole of the difference.
{
  const sweep = [];
  for (const cover of [0, 0.10, 0.32, 0.45, 0.55, 0.70, 0.82, 0.94, 1.0]) {
    renderer.env.cloudCover = cover;
    sky.update(clock, renderer, 0);
    const sh = renderer.env.ambientSH;
    sweep.push({ cover, sun: renderer.env.sunIntensity, br: sh[2] / Math.max(sh[0], 1e-9) });
  }
  const at = (c) => sweep.find((s) => Math.abs(s.cover - c) < 1e-9);
  check('a scattered cumulus field does not dim the sun',
    at(0.45).sun === at(0).sun && at(0.32).sun === at(0).sun,
    `cover 0.32 -> ${at(0.32).sun.toFixed(2)}, 0.45 -> ${at(0.45).sun.toFixed(2)}, ` +
    `clear ${at(0).sun.toFixed(2)}`);
  check('a scattered cumulus field does not desaturate the ambient probe',
    Math.abs(at(0.45).br - at(0).br) < 1e-6,
    `zenith B/R ${at(0).br.toFixed(3)} -> ${at(0.45).br.toFixed(3)}`);
  check('an unbroken deck still kills the sun',
    at(0.94).sun < 0.05 * at(0).sun && at(0.82).sun < 0.45 * at(0).sun,
    `0.82 -> ${(100 * at(0.82).sun / at(0).sun).toFixed(1)}%, ` +
    `0.94 -> ${(100 * at(0.94).sun / at(0).sun).toFixed(1)}%`);
  let monotone = true;
  for (let i = 1; i < sweep.length; i++) if (sweep[i].sun > sweep[i - 1].sun + 1e-9) monotone = false;
  check('sunlight is monotonically non-increasing in cloud cover', monotone);
}
renderer.env.cloudCover = 0;

// ---------------------------------------------------------------------------
// 4b. The ambient SH's DEPTH TERM, pinned at source level.
//
// updateAmbientSH() above builds the probe from the ABOVE-WATER zenith/horizon/
// ground triple, so the coefficients are the sky as seen from the air no matter
// where the camera is. Everything that keeps a submerged frame honest therefore
// lives in one line of common/lighting.wgsl's evalAmbient(), and that line
// shipped wrong once: it removed only daylightAtDepth(pointDepth - cameraDepth),
// which is the VIEW path (pass/underwater.wgsl's job), so the ILLUMINATION path
// from the surface down to the point was missing entirely and a point at the
// camera's own depth lost NOTHING. Measured on that build the SH was 63.7% of
// the frame at 8 m, 94.1% at 118 m and 100.0% at 900 m, and the trench wall
// photographed as a brilliant electric blue brighter than the 118 m twilight
// station. Fixed in 238fab9.
//
// The decision lives in a shader that needs a GPU, so it is pinned by parsing
// the source - the same idiom as test-glow section 7 and test-ocean section 12.
// The numbers printed below are what the term is worth: it is not a small
// correction, it spans eight decades over the playable column, which is why
// omitting it was invisible in arithmetic and catastrophic in a photograph.
// ---------------------------------------------------------------------------

{
  const lightingSrc = readFileSync(
    new URL('../src/render/shaders/common/lighting.wgsl', import.meta.url), 'utf8');

  // Just evalAmbient's body: the file has other daylightAtDepth callers (the
  // punctual path at :193) whose argument is legitimately a path length.
  const start = lightingSrc.indexOf('fn evalAmbient(');
  const rest = start < 0 ? '' : lightingSrc.slice(start + 1);
  const end = rest.indexOf('\nfn ');
  const body = start < 0 ? '' : (end < 0 ? rest : rest.slice(0, end));
  check('common/lighting.wgsl still declares evalAmbient()', start >= 0);

  // THE fix. A literal ')' after pointDepth is what makes this fail against the
  // pre-238fab9 form, which subtracted the camera's depth inside the call.
  check('evalAmbient attenuates by daylightAtDepth(pointDepth) - the column from '
    + 'the SURFACE, not from the camera',
    /columnLoss\s*=\s*daylightAtDepth\(\s*pointDepth\s*\)/.test(body));
  check('...and nothing in evalAmbient references the camera\'s own depth',
    !/cameraDepth/.test(body) && !/daylightAtDepth\([^)]*-/.test(body));

  // Computing the term and then failing to apply it to a lobe is the same bug
  // with an extra step, and the specular lobe is the one easy to forget.
  const lineWith = (decl) => (body.split('\n').find((l) => l.includes(decl)) ?? '');
  const diffuseLine = lineWith('let skyDiffuse');
  const specLine = lineWith('let skySpec');
  check('both ambient lobes multiply by columnLoss (diffuse)',
    /columnLoss/.test(diffuseLine), diffuseLine.trim());
  check('both ambient lobes multiply by columnLoss (specular)',
    /columnLoss/.test(specLine), specLine.trim());

  // What the term is worth, from the shipped Kd columns. daylightAtDepth is
  // exp(-Kd * depth) and Kd, never sigmaT - see the water contract in CLAUDE.md.
  const survive = (Kd, d) => Kd.map((k) => Math.exp(-k * d));
  const reefBlue = survive(WATER_TYPES.REEF_TURQUOISE.Kd, 33)[2];
  const voidBlue = survive(WATER_TYPES.ABYSSAL_VOID.Kd, 900)[2];
  check('the term is not a rounding correction: it spans many decades',
    reefBlue < 0.45 && voidBlue < 1e-6,
    `blue survival: REEF_TURQUOISE at 33 m ${reefBlue.toFixed(4)}, `
    + `ABYSSAL_VOID at 900 m ${voidBlue.toExponential(2)}`);
}

// ---------------------------------------------------------------------------
// 5. Moons and stars.
// ---------------------------------------------------------------------------

let moonBad = 0;
for (const s of samples) {
  if (s.moonIntensity < 0) moonBad++;
  if (s.moonPhase < 0 || s.moonPhase > 1) moonBad++;
}
check('moon intensity >= 0 and phase in [0,1] at all times', moonBad === 0);

// The illuminated fraction the scene lighting uses and the terminator
// moonDisc() draws in pass/sky_render.wgsl must be the SAME number. The shader
// takes the disc-centre normal as -moonDir, so its cosine to the sun is
// -dot(moonDir, sunDir); getting the sign backwards here lights the world by a
// new moon and blacks out a full one, and nothing else in the frame notices.
{
  const probe = new WorldClock(0);
  const probeSky = new SkySystem(null, null, null, probe);
  let worstPhase = 0;
  let fullestMoon = 0;
  let peakMoonlight = 0;
  for (let i = 0; i < 4000; i++) {
    probe.advance(SECONDS_PER_DAY * 40 / 4000);
    probeSky.update(probe, renderer, 0.02);
    for (const m of probeSky.moons) {
      const cos = m.dir[0] * probeSky.sunDir[0] + m.dir[1] * probeSky.sunDir[1]
                + m.dir[2] * probeSky.sunDir[2];
      worstPhase = Math.max(worstPhase, Math.abs(0.5 * (1 - cos) - m.illumination));
      fullestMoon = Math.max(fullestMoon, m.illumination);
    }
    if (probeSky.sunDir[1] < -0.2) peakMoonlight = Math.max(peakMoonlight, renderer.env.moonIntensity);
  }
  check('moon illumination equals the shader terminator at the disc centre',
    worstPhase < 1e-6, `max disagreement ${worstPhase.toExponential(2)}`);
  check('a full moon occurs within 40 days', fullestMoon > 0.95,
    `peak illuminated fraction ${fullestMoon.toFixed(4)}`);
  check('peak night moonlight reaches the tabulated full-moon intensity',
    peakMoonlight > 0.5 * SKY.MOONS[0].intensity,
    `${peakMoonlight.toExponential(3)} vs table ${SKY.MOONS[0].intensity}`);
}

// ---------------------------------------------------------------------------
// 5b. The night sky.
//
// The sky-view LUT integrates the SUN alone, so it is exactly (0,0,0) after
// dusk and the night sky is whatever pass/sky_render.wgsl adds on top. That
// used to be the airglow constant and nothing else - measured p50 sky pixel
// (6.0e-5, 8.9e-5, 5.4e-5), green-dominant, with two full moons overhead
// contributing literally nothing. moonSkyGlow() is the fix, and its closed form
// is mirrored here because the shader is never executed without a GPU.
// ---------------------------------------------------------------------------

{
  // The shader has no uniform slot of its own for the moon's irradiance: it
  // reconstructs it from the DISC parameters sim/sky.js writes. If that
  // reconstruction and _updateEphemeris ever disagree, the sky is lit by one
  // number and the scene by another and nothing else in the frame notices.
  clock.setDayFraction(0.0);
  sky.update(clock, renderer, 0);
  const u = sky.uniformF32;
  let worstMoon = 0;
  for (let i = 0; i < 2; i++) {
    const dirOff = 8 + i * 8;        // moon{i}Dir  = vec4 #2 and #4
    const colOff = 12 + i * 8;       // moon{i}Color
    const radius = u[dirOff + 3];
    const solidAngle = Math.PI * radius * radius;
    const illum = u[colOff + 3];
    const altitude = Math.max(u[dirOff + 1], 0);
    const shape = solidAngle * 0.5 * Math.pow(illum, 1.35) * altitude;
    for (let c = 0; c < 3; c++) {
      const shaderE = u[colOff + c] * shape;
      const jsE = SKY.MOONS[i].albedo[c] * sky.moons[i].intensity;
      worstMoon = Math.max(worstMoon, Math.abs(shaderE - jsE) / Math.max(jsE, 1e-12));
    }
  }
  check('the shader reconstructs each moon\'s irradiance from its disc exactly',
    worstMoon < 1e-5, `max relative error ${worstMoon.toExponential(2)}`);

  // moonSkyGlow()'s closed form: where sigma_s/sigma_t is constant along the
  // ray the single-scattering integral collapses to
  // (sigma_s/sigma_t) * P(mu) * E * T * (1 - exp(-tau)), with tau the VERTICAL
  // optical depth times the relative airmass. An exponential layer of
  // coefficient beta and scale height H integrates to exactly beta * H.
  const TURB = 2.2;
  const tauR = SKY.RAYLEIGH.map((b) => b * SKY.RAYLEIGH_SCALE_HEIGHT);
  const tauM = [0, 1, 2].map(() => SKY.MIE * TURB * SKY.MIE_SCALE_HEIGHT);
  const tauT = [0, 1, 2].map((c) => tauR[c] + tauM[c]
    + SKY.MIE_ABSORPTION * TURB * SKY.MIE_SCALE_HEIGHT + SKY.OZONE[c] * 15000);
  const rayleighPhase = (mu) => (3 / (16 * Math.PI)) * (1 + mu * mu);
  const miePhase = (mu, g) => {
    const g2 = g * g;
    const d = 1 + g2 - 2 * g * mu;
    return (3 / (8 * Math.PI)) * ((1 - g2) * (1 + mu * mu)) / ((2 + g2) * d * Math.sqrt(d));
  };
  const glow = (mu, sinAlt, E) => {
    const altDeg = Math.asin(Math.min(1, Math.max(0, sinAlt))) * 57.29578;
    const airmass = Math.min(38,
      1 / Math.max(sinAlt + 0.50572 * Math.pow(altDeg + 6.07995, -1.6364), 1e-3));
    return [0, 1, 2].map((c) =>
      ((tauR[c] * rayleighPhase(mu) + tauM[c] * miePhase(mu, SKY.MIE_G)) / tauT[c])
      * (1 - Math.exp(-tauT[c] * airmass)) * E[c]);
  };
  // NIGHT_FLOOR_HUE in pass/sky_render.wgsl, and its 0.12 pulse amplitude.
  const floorHue = [0.22, 0.42, 1.00];
  const floorAtZenith = floorHue.map((h) => h * SKY.AIRGLOW);
  const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

  // A full moon at 45 deg, looking 90 deg away from it - the darkest part of a
  // moonlit sky, and the fair comparison against the moonless floor.
  const full = SKY.MOONS[0];
  const E = full.albedo.map((a) => a * full.intensity * Math.SQRT1_2);
  const away = glow(0, Math.SQRT1_2, E);
  check('moonlight shapes a moonlit night rather than perturbing it',
    luma(away) > 0.35 * luma(floorAtZenith),
    `moon (${away.map((v) => v.toExponential(1)).join(', ')}) vs floor ` +
    `(${floorAtZenith.map((v) => v.toExponential(1)).join(', ')})`);
  check('the moonlit sky is blue, not olive',
    away[2] / away[0] > 3 && floorAtZenith[2] / floorAtZenith[0] > 3,
    `moon B/R ${(away[2] / away[0]).toFixed(2)}, floor B/R ` +
    `${(floorAtZenith[2] / floorAtZenith[0]).toFixed(2)}`);
  // The old constant delivered luminance 1.03e-4 everywhere. The darkest
  // direction of a moonlit sky must stay within about an EV of that: falling
  // far under it is how a night frame turns into a black one, and the QA night
  // scenario's black-fraction bound would only catch that after the fact.
  const nightY = luma(floorAtZenith) + luma(away);
  check('the darkest direction of a moonlit night stays within an EV of 1.03e-4',
    nightY > 0.4e-4 && nightY < 3e-4, `zenith luminance ${nightY.toExponential(3)}`);
  // Looking AT the moon the Mie lobe makes an aureole; it must stay an aureole
  // and not a second sun.
  const towards = glow(1, Math.SQRT1_2, E);
  check('the moon aureole stays within an order of magnitude of the sky',
    luma(towards) / luma(away) > 1.5 && luma(towards) / luma(away) < 12,
    `${(luma(towards) / luma(away)).toFixed(2)}x`);
}

// ---------------------------------------------------------------------------
// 5c. The night CLOUD deck.
//
// marchClouds() used to have exactly two light sources: sunColor, which
// sunTransmittance drives to (0,0,0) once the planet is in the way, and an
// ambient sampled from the sky-view LUT, which integrates the sun alone and is
// therefore also zero after dusk. So the deck was lit by nothing at all.
// Measured on the GPU at midnight, cover 0.32, after 420 frames of temporal
// settle: the marched radiance p50 over the top third of the frame was exactly
// (0, 0, 0) and the composited pixel (5.4e-7, 8.9e-7, 1.7e-6), against a
// clear-sky p50 of (4.0e-5, 6.6e-5, 1.2e-4) - a deck 70x darker than the sky it
// hung in under two full moons. Nothing offline could see it, because the whole
// of it lives in a shader.
//
// So the closures pass/clouds.wgsl uses are mirrored here, as section 5b does
// for the sky's own moon glow, and the two shader files are parsed for the one
// constant they are forced to share.
// ---------------------------------------------------------------------------

{
  const shaderDir = new URL('../src/render/shaders/pass/', import.meta.url);
  const cloudsSrc = readFileSync(new URL('clouds.wgsl', shaderDir), 'utf8');
  const skySrc = readFileSync(new URL('sky_render.wgsl', shaderDir), 'utf8');

  // The night-sky floor is emission the SKY draws and the CLOUD hanging in that
  // sky is lit by, and there is no spare Sky uniform slot to carry it in - so it
  // is written out twice and this is what stops the two drifting.
  const hueOf = (src, name) => {
    const m = src.match(new RegExp(`const\\s+${name}\\s*:\\s*vec3f\\s*=\\s*vec3f\\(([^)]*)\\)`));
    return m ? m[1].split(',').map((s) => Number(s.trim())) : null;
  };
  const skyHue = hueOf(skySrc, 'NIGHT_FLOOR_HUE');
  const cloudHue = hueOf(cloudsSrc, 'CLOUD_NIGHT_FLOOR_HUE');
  check('both shaders declare the night-sky floor hue',
    !!skyHue && !!cloudHue && skyHue.length === 3 && skyHue.every(finite),
    `sky ${JSON.stringify(skyHue)}, clouds ${JSON.stringify(cloudHue)}`);
  check('the sky and the clouds agree on what colour the night floor is',
    !!skyHue && !!cloudHue && skyHue.every((v, i) => v === cloudHue[i]),
    `sky ${JSON.stringify(skyHue)} vs clouds ${JSON.stringify(cloudHue)}`);
  const PULSE = 'let pulse = 1.0 + 0.12 * sin(sky.starParams.z * 0.025);';
  check('the sky and the clouds breathe on the same airglow pulse',
    skySrc.includes(PULSE) && cloudsSrc.includes(PULSE));

  // A moon's self-shadowing has to be marched toward THAT moon. Reusing the
  // sun's optical depth would put the shadowed face of every cloud on the side
  // away from a light that is not shining on it.
  const lights = new Set(
    [...cloudsSrc.matchAll(/cloudLightDepth\(worldPos,\s*sky\.(\w+)\.xyz\)/g)].map((m) => m[1]));
  check('the deck is self-shadowed against every body that lights it',
    lights.has('sunDir') && lights.has('moon0Dir') && lights.has('moon1Dir'),
    `light marches toward: ${[...lights].join(', ') || 'none'}`);

  // --- the numbers -------------------------------------------------------
  clock.setDayFraction(0.0);
  sky.update(clock, renderer, 0);
  const u = sky.uniformF32;
  const TURB = renderer.env.airTurbidity != null ? renderer.env.airTurbidity : 2.2;
  const tauR = SKY.RAYLEIGH.map((b) => b * SKY.RAYLEIGH_SCALE_HEIGHT);
  const tauM = [0, 1, 2].map(() => SKY.MIE * TURB * SKY.MIE_SCALE_HEIGHT);
  const tauT = [0, 1, 2].map((c) => tauR[c] + tauM[c]
    + SKY.MIE_ABSORPTION * TURB * SKY.MIE_SCALE_HEIGHT + SKY.OZONE[c] * 15000);
  const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

  /**
   * cloudMoonIrradiance(): the disc parameters read back as a BEAM irradiance.
   * The one term it drops relative to moonIrradiance() in sky_render.wgsl is
   * max(moonDir.y, 0), which projects onto a horizontal surface - the ground's
   * convention, not a cloud's. `sunTransmittance` stands in for the LUT here
   * exactly as section 5b's glow() does.
   */
  const beamAtLayer = (i) => {
    const dirOff = 8 + i * 8, colOff = 12 + i * 8;
    const radius = u[dirOff + 3];
    const illum = u[colOff + 3];
    if (illum <= 0.001 || u[dirOff + 1] <= 0) return [0, 0, 0];
    const solidAngle = Math.PI * radius * radius;
    const sinAlt = u[dirOff + 1];
    const altDeg = Math.asin(Math.min(1, sinAlt)) * 57.29578;
    const airmass = Math.min(38,
      1 / Math.max(sinAlt + 0.50572 * Math.pow(altDeg + 6.07995, -1.6364), 1e-3));
    return [0, 1, 2].map((c) =>
      u[colOff + c] * solidAngle * 0.5 * Math.pow(illum, 1.35) * Math.exp(-tauT[c] * airmass));
  };

  // One calibration, two conventions: the beam form times sin(altitude) must be
  // exactly the horizontal illuminance _updateEphemeris publishes to the scene.
  let worstBeam = 0;
  for (let i = 0; i < 2; i++) {
    const dirOff = 8 + i * 8, colOff = 12 + i * 8;
    const solidAngle = Math.PI * u[dirOff + 3] * u[dirOff + 3];
    const shape = solidAngle * 0.5 * Math.pow(u[colOff + 3], 1.35);
    for (let c = 0; c < 3; c++) {
      const beam = u[colOff + c] * shape;                       // no altitude term
      const horizontal = SKY.MOONS[i].albedo[c] * sky.moons[i].intensity;
      worstBeam = Math.max(worstBeam,
        Math.abs(beam * Math.max(u[dirOff + 1], 0) - horizontal) / Math.max(horizontal, 1e-12));
    }
  }
  check('the cloud beam irradiance and the scene\'s horizontal one share a calibration',
    worstBeam < 1e-5, `max relative error ${worstBeam.toExponential(2)}`);

  /** cloudNightAmbient(): hemispherical mean of the moon glow, plus the floor. */
  const E = [0, 1, 2].map((c) => beamAtLayer(0)[c] + beamAtLayer(1)[c]);
  const moonAmbient = [0, 1, 2].map((c) =>
    ((tauR[c] + tauM[c]) / tauT[c]) * (1 - Math.exp(-tauT[c])) * E[c] * (0.25 / Math.PI));
  const floorAmbient = (cloudHue || [0, 0, 0]).map((h) => h * SKY.AIRGLOW);
  const ambient = [0, 1, 2].map((c) => moonAmbient[c] + floorAmbient[c]);

  check('the cloud deck has light on it at midnight',
    ambient.every((v) => v > 0) && luma(E) > 0,
    `beam ${E.map((v) => v.toExponential(2)).join(', ')}, ` +
    `ambient ${ambient.map((v) => v.toExponential(2)).join(', ')}`);
  // Both halves matter: the moon alone leaves the shadowed side of a cloud
  // darker than the sky behind it, and the floor alone is a flat grey deck with
  // no modelling at all. Measured on the GPU, the floor is 58% of the ambient.
  const floorShare = luma(floorAmbient) / luma(ambient);
  check('the night ambient is a real mix of moonlight and the sky floor',
    floorShare > 0.25 && floorShare < 0.85, `floor is ${(100 * floorShare).toFixed(0)}%`);
  // A cloud lit only by the ambient would have no modelling; the direct beam has
  // to dominate what a lit top receives, or the deck is a flat card.
  check('the direct beam is far stronger than the ambient it sits on',
    luma(E) / luma(ambient) > 20, `${(luma(E) / luma(ambient)).toFixed(0)}x`);

  // The whole night path is gated on star visibility, which is exactly 0 in
  // daylight - so the day frame is bit-identical to before the moons existed.
  clock.setDayFraction(0.5);
  sky.update(clock, renderer, 0);
  check('the night cloud path is exactly off in daylight',
    sky.starVisibility === 0, `starVisibility ${sky.starVisibility}`);
}

const dayStars = samples.filter((s) => Math.abs(s.f - 0.5) < 0.1)
  .reduce((m, s) => Math.max(m, s.stars), 0);
const nightStars = samples.filter((s) => s.f < 0.05 || s.f > 0.95)
  .reduce((m, s) => Math.min(m, s.stars), 1);
check('stars are fully hidden at midday and fully visible at midnight',
  dayStars === 0 && nightStars === 1, `day ${dayStars}, night ${nightStars}`);

// ---------------------------------------------------------------------------
// 6. Star catalogue.
// ---------------------------------------------------------------------------

const built = sky._buildStarField();
const cellCount = built.cells.length / 2;
let totalRefs = 0;
let maxBucket = 0;
let emptyCells = 0;
for (let c = 0; c < cellCount; c++) {
  const n = built.cells[c * 2 + 1];
  totalRefs += n;
  maxBucket = Math.max(maxBucket, n);
  if (n === 0) emptyCells++;
}
check('every star reference lies inside the entry array',
  totalRefs === built.total && built.entries.length === built.total * 8,
  `${built.total} entries for ${SKY.STAR_COUNT} stars`);

let unitOk = true;
let magMin = Infinity;
let magMax = -Infinity;
for (let i = 0; i < built.total; i++) {
  const o = i * 8;
  const len = Math.hypot(built.entries[o], built.entries[o + 1], built.entries[o + 2]);
  if (Math.abs(len - 1) > 1e-5) unitOk = false;
  magMin = Math.min(magMin, built.entries[o + 3]);
  magMax = Math.max(magMax, built.entries[o + 3]);
}
check('all star directions are unit vectors', unitOk);
check('star magnitudes lie in the sampled range [-1.4, 6.8]',
  magMin >= -1.4001 && magMax <= 6.8001,
  `[${magMin.toFixed(2)}, ${magMax.toFixed(2)}]`);

// The magnitude distribution must follow the stated law N(<m) ~ 10^(0.42 m).
// (DESIGN 03.8.6 also quotes "~14 brighter than 1.5, ~48 brighter than 2.5"
// for 8,192 stars; those two counts are not consistent with each other under
// that law - the first implies a different normalisation - so the LAW is what
// is tested here, being the thing the code implements.)
const cat = sky.starCatalogue;
const brighter = (m) => cat.mags.reduce((n, v) => n + (v < m ? 1 : 0), 0);
const cdf = (m) => (Math.pow(10, 0.42 * m) - Math.pow(10, 0.42 * -1.4)) /
                   (Math.pow(10, 0.42 * 6.8) - Math.pow(10, 0.42 * -1.4));
const expect15 = cdf(1.5) * SKY.STAR_COUNT;
const expect25 = cdf(2.5) * SKY.STAR_COUNT;
const expect50 = cdf(5.0) * SKY.STAR_COUNT;
check('star magnitude distribution matches the 10^(0.42 m) law within 40%',
  Math.abs(brighter(1.5) - expect15) < 0.4 * expect15 &&
  Math.abs(brighter(2.5) - expect25) < 0.4 * expect25 &&
  Math.abs(brighter(5.0) - expect50) < 0.4 * expect50,
  `m<1.5: ${brighter(1.5)} (CDF ${expect15.toFixed(1)}), ` +
  `m<2.5: ${brighter(2.5)} (CDF ${expect25.toFixed(1)}), ` +
  `m<5.0: ${brighter(5.0)} (CDF ${expect50.toFixed(0)})`);
check('the star grid has no pathological bucket',
  maxBucket < 128, `max bucket ${maxBucket}, empty cells ${emptyCells}/${cellCount}`);

// The fragment shader reads exactly ONE cell, so every direction from which a
// star can still be seen must land in a cell that star was inserted into. This
// walks the full-reach circle around every star and looks it up the way the
// shader does. STAR_MAX_ANGLE in pass/sky_render.wgsl is the contract.
{
  const STAR_MAX_ANGLE = 0.030;
  const GRID_U = 96, GRID_V = 48;
  const TAU = Math.PI * 2;
  let missing = 0;
  let probes = 0;
  for (let i = 0; i < cat.count; i++) {
    const d = [cat.dirs[i * 3], cat.dirs[i * 3 + 1], cat.dirs[i * 3 + 2]];
    const a = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const t = [d[1] * a[2] - d[2] * a[1], d[2] * a[0] - d[0] * a[2], d[0] * a[1] - d[1] * a[0]];
    const tl = Math.hypot(t[0], t[1], t[2]);
    const b = [(d[1] * t[2] - d[2] * t[1]) / tl, (d[2] * t[0] - d[0] * t[2]) / tl,
               (d[0] * t[1] - d[1] * t[0]) / tl];
    for (let k = 0; k < 16; k++) {
      const ang = (k / 16) * TAU;
      const cx = Math.cos(ang) * STAR_MAX_ANGLE / tl;
      const cy = Math.sin(ang) * STAR_MAX_ANGLE;
      const p = [d[0] + t[0] * cx + b[0] * cy, d[1] + t[1] * cx + b[1] * cy,
                 d[2] + t[2] * cx + b[2] * cy];
      const pl = Math.hypot(p[0], p[1], p[2]);
      const v = Math.min(Math.max(p[1] / pl * 0.5 + 0.5, 0), 1);
      let u = (Math.atan2(p[2] / pl, p[0] / pl) / TAU + 0.5) % 1;
      if (u < 0) u += 1;
      const cell = Math.min(Math.floor(v * GRID_V), GRID_V - 1) * GRID_U
                 + Math.min(Math.floor(u * GRID_U), GRID_U - 1);
      const off = built.cells[cell * 2];
      const cnt = built.cells[cell * 2 + 1];
      let found = false;
      for (let e = 0; e < cnt && !found; e++) {
        const o = (off + e) * 8;
        found = Math.abs(built.entries[o] - d[0]) < 1e-6
             && Math.abs(built.entries[o + 1] - d[1]) < 1e-6
             && Math.abs(built.entries[o + 2] - d[2]) < 1e-6;
      }
      probes++;
      if (!found) missing++;
    }
  }
  check(`every direction within ${STAR_MAX_ANGLE} rad of a star reads a cell holding it`,
    missing === 0, `${missing} misses of ${probes} probes`);
}

// The star field must turn the same way the sun does. The catalogue is static
// and starRotation carries the whole diurnal spin, so a sign error there sends
// the stars round backwards - rising in the west - which no other test sees.
{
  const wc = new WorldClock(0);
  const R = new Float32Array(9);
  const mulT = (m, v) => [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
  let orthoErr = 0;
  wc.totalSeconds = 0;
  sky._celestialRotation(wc, R);
  for (let a = 0; a < 3; a++) {
    for (let b = 0; b < 3; b++) {
      const dot = R[a * 3] * R[b * 3] + R[a * 3 + 1] * R[b * 3 + 1] + R[a * 3 + 2] * R[b * 3 + 2];
      orthoErr = Math.max(orthoErr, Math.abs(dot - (a === b ? 1 : 0)));
    }
  }
  check('starRotation is orthonormal', orthoErr < 1e-5, `max err ${orthoErr.toExponential(2)}`);

  // The world direction of a catalogue star is R^T times its catalogue vector.
  let riseX = 0;
  let prevY = 0;
  for (let i = 0; i <= 256; i++) {
    wc.totalSeconds = (i / 256) * SKY.SECONDS_PER_DAY;
    sky._celestialRotation(wc, R);
    const w = mulT(R, [1, 0, 0]);
    if (i > 0 && prevY <= 0 && w[1] > 0) { riseX = w[0]; break; }
    prevY = w[1];
  }
  const sd = new Float32Array(3);
  let sunRiseX = 0;
  prevY = 0;
  for (let i = 0; i <= 1024; i++) {
    wc.setDayFraction(i / 1024);
    wc.sunDirection(sd);
    if (i > 0 && prevY <= 0 && sd[1] > 0) { sunRiseX = sd[0]; break; }
    prevY = sd[1];
  }
  check('stars and the sun both rise in the east (+X)', riseX > 0.5 && sunRiseX > 0.5,
    `star x ${riseX.toFixed(3)}, sun x ${sunRiseX.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// 7. Atmosphere maths.
//
// The LUT shaders compile but are never EXECUTED without a GPU, so the three
// expressions whose correctness the whole model rests on are mirrored here in
// JS: the transmittance parameterisation (which must round-trip exactly, or the
// LUT is sampled off its own texels), the quadrature that fills it, and the
// SUN_TOA_SCALE calibration that ties the analytically drawn sun disc to the
// TIME_KEYS sunlight the rest of the frame is lit by.
// ---------------------------------------------------------------------------

{
  const Rg = SKY.PLANET_RADIUS;
  const Rt = SKY.ATMOSPHERE_RADIUS;
  const Hatm = Math.sqrt(Rt * Rt - Rg * Rg);
  const TURB = 2.2;                // TURBIDITY_DEFAULT in src/sim/sky.js
  const LUT_W = 256, LUT_H = 64;
  const sat01 = (x) => Math.min(1, Math.max(0, x));
  const texCoord = (x, n) => 0.5 / n + sat01(x) * (1 - 1 / n);
  const unitCoord = (u, n) => sat01((u - 0.5 / n) / (1 - 1 / n));
  const distanceToTop = (r, mu) =>
    Math.max(-r * mu + Math.sqrt(Math.max(r * r * (mu * mu - 1) + Rt * Rt, 0)), 0);

  const toUV = (r, mu) => {
    const rho = Math.sqrt(Math.max(r * r - Rg * Rg, 0));
    return [texCoord((distanceToTop(r, mu) - (Rt - r)) / Math.max(rho + Hatm - (Rt - r), 1), LUT_W),
            texCoord(rho / Math.max(Hatm, 1), LUT_H)];
  };
  const fromUV = (uv) => {
    const rho = Hatm * unitCoord(uv[1], LUT_H);
    const r = Math.sqrt(rho * rho + Rg * Rg);
    const d = (Rt - r) + unitCoord(uv[0], LUT_W) * (rho + Hatm - (Rt - r));
    const mu = d > 0 ? (Hatm * Hatm - rho * rho - d * d) / (2 * r * d) : 1;
    return [r, Math.min(1, Math.max(-1, mu))];
  };
  const extinction = (alt) => {
    const h = Math.max(alt, 0);
    const dR = Math.exp(-h / SKY.RAYLEIGH_SCALE_HEIGHT);
    const dM = Math.exp(-h / SKY.MIE_SCALE_HEIGHT);
    const dO = Math.max(0, 1 - Math.abs(h - 25000) / 15000);
    return SKY.RAYLEIGH.map((c, i) => c * dR
      + (SKY.MIE + SKY.MIE_ABSORPTION) * TURB * dM + SKY.OZONE[i] * dO);
  };
  // Quadratic edges, midpoint sample - exactly sim/sky_transmittance.wgsl.
  const opticalDepth = (r, mu, steps) => {
    const dist = distanceToTop(r, mu);
    const sum = [0, 0, 0];
    let prev = 0;
    for (let i = 1; i <= steps; i++) {
      const edge = dist * (i / steps) ** 2;
      const dt = edge - prev;
      const t = prev + dt * 0.5;
      prev = edge;
      const ri = Math.sqrt(Math.max(t * t + 2 * r * mu * t + r * r, Rg * Rg));
      const e = extinction(ri - Rg);
      for (let c = 0; c < 3; c++) sum[c] += e[c] * dt;
    }
    return sum;
  };

  let maxDU = 0;
  let outside = 0;
  for (let y = 0; y < LUT_H; y++) {
    for (let x = 0; x < LUT_W; x++) {
      const uv = [(x + 0.5) / LUT_W, (y + 0.5) / LUT_H];
      const [r, mu] = fromUV(uv);
      const back = toUV(r, mu);
      maxDU = Math.max(maxDU, Math.abs(back[0] - uv[0]), Math.abs(back[1] - uv[1]));
      if (r < Rg - 1 || r > Rt + 1) outside++;
    }
  }
  check('every transmittance LUT texel maps inside the atmosphere shell', outside === 0);
  check('transmittanceUV inverts transmittanceParams over all 16384 texels',
    maxDU < 1e-5, `max |duv| ${maxDU.toExponential(2)}`);

  // Vertical is the worst case for the quadrature: 100 km of path against a
  // 1,200 m aerosol scale height. The analytic answer is closed form.
  const analytic = SKY.RAYLEIGH.map((c, i) => c * SKY.RAYLEIGH_SCALE_HEIGHT
    + (SKY.MIE + SKY.MIE_ABSORPTION) * TURB * SKY.MIE_SCALE_HEIGHT + SKY.OZONE[i] * 15000);
  const numeric = opticalDepth(Rg, 1, 40);   // SKY_TRANSMITTANCE_STEPS
  const quadErr = Math.max(...numeric.map((v, i) => Math.abs(v - analytic[i]) / analytic[i]));
  check('40 quadrature steps reproduce the analytic vertical optical depth',
    quadErr < 0.01, `max relative error ${(quadErr * 100).toFixed(3)}%`);
  const vertT = numeric.map((t) => Math.exp(-t));
  check('vertical transmittance is physical', vertT.every((v) => v > 0.7 && v < 0.96),
    `(${vertT.map((v) => v.toFixed(3)).join(', ')})`);

  // SUN_TOA_SCALE divides by 0.90 to undo one vertical air path. The disc the
  // sky shader draws must therefore land on the key table's noon sunlight.
  const noonMu = Math.sin(samples.reduce((m, s) => Math.max(m, s.elevation), 0));
  const Tnoon = opticalDepth(Rg, noonMu, 400).map((t) => Math.exp(-t));
  const noonKey = TIME_KEYS.find((k) => k.name === 'noon');
  const lutSun = SKY.SUN_ILLUMINANCE.map((c, i) => c * (SKY.SUN_INTENSITY_NOON / 0.90) * Tnoon[i]);
  const keySun = noonKey.sunColor.map((c, i) => c * SKY.SUN_ILLUMINANCE[i] * SKY.SUN_INTENSITY_NOON);
  const sunErr = Math.max(...lutSun.map((v, i) => Math.abs(v - keySun[i]) / keySun[i]));
  check('the analytic sun disc matches the key-table sunlight at noon',
    sunErr < 0.15,
    `LUT (${lutSun.map((v) => v.toFixed(1)).join(', ')}) vs key ` +
    `(${keySun.map((v) => v.toFixed(1)).join(', ')}), max ${(sunErr * 100).toFixed(1)}%`);
}

// ---------------------------------------------------------------------------
// 8. Weather: determinism, continuity, bounds.
// ---------------------------------------------------------------------------

const runWeather = (seconds, dt) => {
  const wc = new WorldClock(0);
  const r = new Renderer();
  const w = new WeatherSystem(WORLD.DEFAULT_SEED);
  const trace = [];
  let t = 0;
  while (t < seconds) {
    wc.advance(dt);
    w.update(dt, wc, r);
    trace.push({
      t: wc.totalSeconds,
      id: w.state.id,
      wind: w.windSpeed,
      gust: w.gustSpeed,
      cloud: w.cloudCover,
      sea: w.seaState,
      rain: w.rain,
      pressure: w.pressure,
      fogDensity: r.env.fogDensity,
      visibility: w.visibility,
    });
    t += dt;
  }
  return { weather: w, trace };
};

const runA = runWeather(3600, 1 / 30);
const runB = runWeather(3600, 1 / 30);
let mismatch = 0;
for (let i = 0; i < runA.trace.length; i++) {
  if (runA.trace[i].id !== runB.trace[i].id) mismatch++;
  if (Math.abs(runA.trace[i].wind - runB.trace[i].wind) > 1e-9) mismatch++;
}
check('weather is bit-identical across two runs of the same seed', mismatch === 0);

// The state SEQUENCE must not depend on the frame rate, because it is a pure
// function of the world clock.
const runC = runWeather(3600, 1 / 8);
const seqA = [...new Set(runA.trace.map((s) => s.id))].join(',');
const seqC = [...new Set(runC.trace.map((s) => s.id))].join(',');
check('weather state sequence is frame-rate independent', seqA === seqC,
  `30 Hz: ${seqA}  |  8 Hz: ${seqC}`);

// A save that stores only the seed must reload into the same weather. The
// comparison must be made at the SAME instant runA's last update was: the
// schedule is a step function of the game hour (50 real seconds), so a reload
// a frame early lands in the previous hour and compares two different states
// whenever a transition falls in between - which it does at t = 3600 for the
// default seed.
const reloaded = new WeatherSystem(WORLD.DEFAULT_SEED);
const wcLate = new WorldClock(0);
wcLate.advance(3600);
reloaded.deserialize(reloaded.serialize(), wcLate);
check('a reloaded save lands on the same weather state',
  reloaded.state.id === runA.weather.state.id,
  `${reloaded.state.id} vs ${runA.weather.state.id}`);

// Never snap: with a 55 s spring the wind cannot move more than a fraction of
// a m/s in a 1/30 s frame, whatever the state machine does.
let maxWindJump = 0;
let maxCloudJump = 0;
let boundsBad = 0;
for (let i = 1; i < runA.trace.length; i++) {
  maxWindJump = Math.max(maxWindJump, Math.abs(runA.trace[i].wind - runA.trace[i - 1].wind));
  maxCloudJump = Math.max(maxCloudJump, Math.abs(runA.trace[i].cloud - runA.trace[i - 1].cloud));
  const s = runA.trace[i];
  if (!(finite(s.wind) && finite(s.cloud) && finite(s.sea) && finite(s.rain) && finite(s.pressure))) boundsBad++;
  if (s.cloud < 0 || s.cloud > 1 || s.rain < 0 || s.rain > 1) boundsBad++;
  if (s.wind < 0 || s.sea < 0 || s.sea > 9.5) boundsBad++;
}
check('weather never snaps: wind moves < 0.05 m/s per 1/30 s frame',
  maxWindJump < 0.05, `max ${maxWindJump.toFixed(5)} m/s`);
check('weather never snaps: cloud cover moves < 0.01 per frame',
  maxCloudJump < 0.01, `max ${maxCloudJump.toFixed(6)}`);
check('every published weather value stays finite and in range', boundsBad === 0);

// Air extinction spans 293x across the state table, so it is the value most
// likely to be published raw and snap on a transition. It drives both the
// atmospheric fog and the HUD's visibility readout.
{
  const long = runWeather(SECONDS_PER_DAY * 6, 1 / 30);
  let maxFogStep = 0;
  let maxVisStep = 0;
  for (let i = 1; i < long.trace.length; i++) {
    const a = long.trace[i - 1];
    const b = long.trace[i];
    maxFogStep = Math.max(maxFogStep, Math.abs(b.fogDensity - a.fogDensity) / Math.max(a.fogDensity, 1e-9));
    maxVisStep = Math.max(maxVisStep, Math.abs(b.visibility - a.visibility) / Math.max(a.visibility, 1e-9));
  }
  check('weather never snaps: air extinction moves < 1% per 1/30 s frame',
    maxFogStep < 0.01, `max ${(maxFogStep * 100).toFixed(4)}%`);
  check('weather never snaps: visibility moves < 1% per 1/30 s frame',
    maxVisStep < 0.01, `max ${(maxVisStep * 100).toFixed(4)}%`);
}

// The safe start must hold for the first 40 real minutes.
const safe = runWeather(SECONDS_PER_DAY * 2, 1);
const unsafeEarly = safe.trace.filter((s) => s.t < 40 * 60 && s.id !== 'clear' && s.id !== 'breezy');
check('the first 40 real minutes only ever see CLEAR or BREEZY',
  unsafeEarly.length === 0, `${unsafeEarly.length} violations`);

// Every state has to be reachable, or the table has a typo in it. 60 game days,
// not 40: FOGBANK is the rarest state (weight 0.01-0.04 out of every row, and
// zero out of SQUALL and STORM) and on the default seed its first occurrence is
// at game day 42.6. Walking the SCHEDULE rather than the spring outputs, so the
// horizon costs nothing.
const reachability = new WeatherSystem(WORLD.DEFAULT_SEED);
const seen = new Set();
for (let h = 0; h < 60 * 24; h++) seen.add(STATE_IDS[reachability.stateAtTime(h * SECONDS_PER_DAY / 24)]);
check('every weather state occurs over 60 game days',
  STATE_IDS.every((id) => seen.has(id)), [...seen].join(', '));

// The state a new world opens in decides what every demo session and every QA
// screenshot sees, because the safe-start filter pins the first 40 real minutes
// to {CLEAR, BREEZY}. It must not be an empty sky.
{
  const fresh = new WeatherSystem(WORLD.DEFAULT_SEED);
  check('a new world opens on a sky with visible cloud',
    fresh.cloudCover >= 0.25 && fresh.cloudType > 0.25,
    `${fresh.state.id}, cover ${fresh.cloudCover.toFixed(2)}, type ${fresh.cloudType.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// 9. The cloud coverage remap.
//
// `cloudCover` is the fraction of the SKY the deck fills, and pass/clouds.wgsl
// only makes that true because its threshold is the measured inverse CDF of its
// own noise field. That calibration is invisible to every other test: with the
// textbook remap(pw, 1 - coverage, 1, 0, 1) the whole suite was green while the
// pass marched 46,000 rays a frame and produced NOTHING - measured on the GPU,
// cloudHistoryA meanAlpha 1.0000 and 0.01% of pixels holding any cloud.
//
// So the density field is mirrored here, bit-exactly, from
// shaders/common/noise.wgsl and shaders/pass/clouds.wgsl - the same tactic
// section 7 uses for the atmosphere - and the coverage is MEASURED.
// ---------------------------------------------------------------------------

{
  const u32 = (x) => x >>> 0;
  const hash3i = (x, y, z) => {
    let h = u32(Math.imul(u32(x), 0x8da6b343) ^ Math.imul(u32(y), 0xd8163841)
                ^ Math.imul(u32(z), 0xcb1ab31f));
    h = u32(Math.imul(u32(h ^ (h >>> 15)), 0x2c1b3c6d));
    h = u32(Math.imul(u32(h ^ (h >>> 12)), 0x297a2d39));
    return u32(h ^ (h >>> 15));
  };
  const grad = new Float64Array(3);
  const quickGrad3 = (cx, cy, cz, seed) => {
    const h = hash3i(cx, cy, u32(cz ^ seed));
    const sa = (h & 4) === 0 ? 0.70710678 : -0.70710678;
    const sb = (h & 8) === 0 ? 0.70710678 : -0.70710678;
    const axis = (h >>> 4) % 3;
    grad[0] = axis === 0 ? 0 : sa;
    grad[1] = axis === 1 ? 0 : (axis === 0 ? sa : sb);
    grad[2] = axis === 2 ? 0 : sb;
  };
  const fade = (f) => f * f * f * (f * (f * 6 - 15) + 10);
  const mix = (a, b, t) => a + (b - a) * t;
  const gradientQuick3 = (px, py, pz, seed) => {
    const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
    const fx = px - ix, fy = py - iy, fz = pz - iz;
    const ux = fade(fx), uy = fade(fy), uz = fade(fz);
    const d = (dx, dy, dz) => {
      quickGrad3(ix + dx, iy + dy, iz + dz, seed);
      return grad[0] * (fx - dx) + grad[1] * (fy - dy) + grad[2] * (fz - dz);
    };
    const x00 = mix(d(0, 0, 0), d(1, 0, 0), ux);
    const x10 = mix(d(0, 1, 0), d(1, 1, 0), ux);
    const x01 = mix(d(0, 0, 1), d(1, 0, 1), ux);
    const x11 = mix(d(0, 1, 1), d(1, 1, 1), ux);
    return mix(mix(x00, x10, uy), mix(x01, x11, uy), uz) * 1.547;
  };
  const OCTAVE_SEED = 1013;
  const fbmCheap3 = (px, py, pz, seed) => {
    let n = gradientQuick3(px, py, pz, seed);
    n += gradientQuick3(px * 2, py * 2, pz * 2, u32(seed + OCTAVE_SEED)) * 0.5;
    n += gradientQuick3(px * 4, py * 4, pz * 4, u32(seed + 2 * OCTAVE_SEED)) * 0.25;
    return n * (1.3220 / 1.75);
  };
  const sat01 = (x) => Math.min(1, Math.max(0, x));
  const remapC = (x, a0, a1) => sat01((x - a0) / Math.max(a1 - a0, 1e-6));
  const BASE_SCALE = 1 / 3200;                 // CLOUD_BASE_SCALE
  const perlinWorley = (x, y, z) => {
    const qx = x * BASE_SCALE, qy = y * BASE_SCALE, qz = z * BASE_SCALE;
    const shape = fbmCheap3(qx, qy, qz, 0x51ad33) * 0.5 + 0.5;
    const billow = 1 - Math.abs(gradientQuick3(qx * 2.7, qy * 2.7, qz * 2.7, 0x2e9071));
    return sat01(remapC(shape, billow * 0.55 - 0.05, 1.0));
  };
  const profile = (h, k) => {
    if (h < 0.07) return mix(k[0], k[1], h / 0.07);
    if (h < 0.20) return mix(k[1], k[2], (h - 0.07) / 0.13);
    if (h < 0.45) return mix(k[2], k[3], (h - 0.20) / 0.25);
    if (h < 0.75) return mix(k[3], k[4], (h - 0.45) / 0.30);
    return mix(k[4], k[5], (h - 0.75) / 0.25);
  };
  // cloudType 0.5 - the cumulus profile CLEAR and BREEZY both carry.
  const cumulus = (h) => profile(h, [0, 0.20, 0.75, 1.00, 0.85, 0]);

  // CLOUD_COVER_C0..C2 and CLOUD_EDGE_WIDTH in shaders/pass/clouds.wgsl.
  const C = [1.7322, -2.6934, 1.6762];
  const EDGE = 0.16;
  const threshold = (cover) => {
    const v = 1 - sat01(cover);
    return Math.max(0, v * (C[0] + v * (C[1] + v * C[2])));
  };

  // 96x96 columns over 40 km (well inside one 3,200 m base feature per 8
  // samples) x 16 layers. Matched against a 220x220x28 run: every coverage
  // agrees to within 0.005, at a fortieth of the cost.
  const NXZ = 96, NY = 16, SPAN = 40000;
  const thickness = SKY.CLOUD_TOP - SKY.CLOUD_BOTTOM;
  const ds = thickness / NY;
  const gradient = new Float64Array(NY);
  for (let i = 0; i < NY; i++) gradient[i] = cumulus((i + 0.5) / NY);
  const pw = new Float32Array(NXZ * NXZ * NY);
  for (let ix = 0; ix < NXZ; ix++) {
    const x = ((ix + 0.5) / NXZ - 0.5) * SPAN;
    for (let iz = 0; iz < NXZ; iz++) {
      const z = ((iz + 0.5) / NXZ - 0.5) * SPAN;
      for (let iy = 0; iy < NY; iy++) {
        pw[(ix * NXZ + iz) * NY + iy] =
          perlinWorley(x, SKY.CLOUD_BOTTOM + ((iy + 0.5) / NY) * thickness, z);
      }
    }
  }

  /**
   * Fraction of vertical columns that hide a third of the sky behind them
   * (tau > 0.5), and the mean shaped density inside the cloud - the two
   * quantities the remap has to get right.
   */
  const measure = (thresh) => {
    let cloudy = 0, interior = 0, interiorN = 0, tauCloudy = 0;
    for (let ix = 0; ix < NXZ; ix++) {
      for (let iz = 0; iz < NXZ; iz++) {
        const o = (ix * NXZ + iz) * NY;
        let tau = 0;
        for (let iy = 0; iy < NY; iy++) {
          const shaped = remapC(pw[o + iy], thresh, thresh + EDGE);
          if (shaped <= 0) continue;
          tau += sat01(shaped * gradient[iy]) * SKY.CLOUD_DENSITY * ds;
          interior += shaped; interiorN++;
        }
        if (tau > 0.5) { cloudy++; tauCloudy += tau; }
      }
    }
    return {
      cover: cloudy / (NXZ * NXZ),
      interior: interiorN ? interior / interiorN : 0,
      tau: cloudy ? tauCloudy / cloudy : 0,
    };
  };

  const asked = [0.05, 0.10, 0.20, 0.32, 0.45, 0.60, 0.82, 0.94, 1.00];
  const got = asked.map((c) => measure(threshold(c)));
  let worst = 0;
  let monotone = true;
  for (let i = 0; i < asked.length; i++) {
    worst = Math.max(worst, Math.abs(got[i].cover - asked[i]));
    if (i > 0 && got[i].cover < got[i - 1].cover - 1e-9) monotone = false;
  }
  check('cloudCover is the fraction of the sky it says it is, within 0.06',
    worst < 0.06,
    asked.map((c, i) => `${c.toFixed(2)}->${got[i].cover.toFixed(3)}`).join(' '));
  check('cloud cover is monotone in the coverage parameter', monotone);

  // The same defect made the deck five times too thin to have a shadowed
  // underside: with the old remap the surviving density averaged 0.17 at EVERY
  // coverage (the threshold only ever just cleared), so a cloudy column ran to
  // tau 1.0 where a real cumulus is 15-40.
  const mid = got[asked.indexOf(0.45)];
  check('a cloudy column reaches the optical depth of a real cumulus',
    mid.tau > 12 && mid.tau < 45, `tau ${mid.tau.toFixed(1)} at cover 0.45`);
  check('the cloud interior is opaque, not a sliver above the threshold',
    mid.interior > 0.45, `mean shaped density ${mid.interior.toFixed(3)}`);

  const old = measure(1 - 0.10);   // the shipped remap at WEATHER.CLEAR
  check('the old coverage remap really did clear nothing at cover 0.10',
    old.cover === 0, `${(100 * old.cover).toFixed(3)}% of columns`);

  console.log('\nCloud coverage (cumulus profile, 9,216 columns through the deck):');
  console.log('  asked   measured   mean tau of a cloudy column');
  for (let i = 0; i < asked.length; i++) {
    console.log(`  ${asked[i].toFixed(2)}    ${got[i].cover.toFixed(3)}      ${got[i].tau.toFixed(1)}`);
  }
}

// ---------------------------------------------------------------------------
// Reported curve: the eight named TIME_KEYS.
// ---------------------------------------------------------------------------

console.log('\nSun / sky curve at the TIME_KEYS (world clock driven, seed default):\n');
console.log('  key          t      elev(deg)  sunI      sky DC (r,g,b)                stars  moonI');
const reported = new Set();
for (const key of TIME_KEYS) {
  if (reported.has(key.name)) continue;
  reported.add(key.name);
  clock.setDayFraction(key.t);
  sky.update(clock, renderer, 0);
  const sh = renderer.env.ambientSH;
  const elev = Math.asin(Math.max(-1, Math.min(1, sky.sunDir[1]))) * 57.29578;
  console.log(
    `  ${key.name.padEnd(11)} ${key.t.toFixed(2)}  ` +
    `${elev.toFixed(2).padStart(8)}  ` +
    `${renderer.env.sunIntensity.toFixed(3).padStart(8)}  ` +
    `(${sh[0].toExponential(2)}, ${sh[1].toExponential(2)}, ${sh[2].toExponential(2)})  ` +
    `${sky.starVisibility.toFixed(2)}   ${renderer.env.moonIntensity.toExponential(2)}`);
}

console.log(`\n${failures === 0 ? 'All sky/weather checks passed.' : `${failures} FAILURES.`}\n`);
process.exit(failures ? 1 : 0);
