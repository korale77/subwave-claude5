// SUBWAVE - the atmosphere model, shared by the sky LUT compute passes, the
// sky render pass and the volumetric clouds.
//
// MODEL: a physically parameterised Rayleigh + Mie + ozone medium evaluated
// into LUTs (Bruneton's parameterisation, Hillaire's multiple-scattering
// closed form). NOT Preetham, NOT Hosek-Wilkie. The reasons are specific:
//
//   - Preetham is undefined and Hosek-Wilkie is clamped below the horizon.
//     SUBWAVE's dusk dive is a core mood beat, so twilight and deep night have
//     to be continuous, not extrapolated.
//   - Both fit sky LUMINANCE only. The underwater optics in common/water.wgsl
//     need per-channel downwelling IRRADIANCE; deriving that from a luminance
//     fit means inventing the spectral split, whereas a physical medium gives
//     it for free and by construction agrees with the aerial perspective on
//     the distant island.
//   - Hosek-Wilkie needs ~1080 embedded coefficients; this needs the twelve
//     numbers already in constants.js SKY.
//
// The whole file works in METRES and in PLANET-CENTRED radius `r`, never in
// world-space y. Converting once at the entry points keeps every intersection
// test exact at 6,360 km.

#pragma once

#include "math.wgsl"

// Which bind group carries the Sky uniform. The LUT compute passes cannot bind
// group 0 - it holds the very LUTs they write, and WebGPU forbids a texture
// being writable-storage and sampled inside one usage scope - so they set this
// to 0 and own their whole group. The render passes leave it at 1 and keep
// group 0 as the shared frame group.
#ifndef SKY_GROUP
#define SKY_GROUP 1
#endif

// ---------------------------------------------------------------------------
// LUT dimensions. These are duplicated in sim/sky.js; both sides index the same
// texels, so a mismatch would silently shift the horizon by half a texel.
// ---------------------------------------------------------------------------

const SKY_TRANSMITTANCE_W : f32 = 256.0;
const SKY_TRANSMITTANCE_H : f32 = 64.0;
const SKY_VIEW_W          : f32 = 256.0;
const SKY_VIEW_H          : f32 = 128.0;
const SKY_MS_SIZE         : f32 = 32.0;

/// Steps used by each LUT march. Bounded and stated; nothing here is adaptive.
const SKY_TRANSMITTANCE_STEPS : i32 = 40;
const SKY_MS_STEPS            : i32 = 20;
const SKY_MS_DIRECTIONS       : i32 = 8;    // 8x8 = 64 directions per texel
const SKY_VIEW_STEPS_MIN      : i32 = 32;
const SKY_VIEW_STEPS_MAX      : i32 = 48;
const SKY_AERIAL_STEPS        : i32 = 8;

// ---------------------------------------------------------------------------
// Uniform
// ---------------------------------------------------------------------------

struct Sky {
  sunDir          : vec4f,   // xyz = direction TO the sun, w = angular radius (rad)
  solarIrradiance : vec4f,   // rgb = top-of-atmosphere irradiance (renderer units), w = disc clamp
  moon0Dir        : vec4f,   // xyz = direction TO moon 0, w = angular radius
  moon0Color      : vec4f,   // rgb = albedo * intensity, w = illuminated fraction 0..1
  moon1Dir        : vec4f,
  moon1Color      : vec4f,
  rayleigh        : vec4f,   // rgb = scattering at r=Rg (1/m), w = scale height (m)
  mieScatter      : vec4f,   // rgb = scattering at r=Rg (1/m, turbidity scaled), w = scale height
  mieAbsorb       : vec4f,   // rgb = absorption at r=Rg (1/m), w = asymmetry g
  ozone           : vec4f,   // rgb = absorption at the tent peak (1/m), w = tent half width (m)
  ground          : vec4f,   // rgb = ground albedo, w = ozone tent centre altitude (m)
  radii           : vec4f,   // x = Rg, y = Rt, z = viewer altitude (m), w = H = sqrt(Rt^2-Rg^2)
  starParams      : vec4f,   // x = visibility 0..1, y = turbidity 0..1, z = world time (s), w = galaxy strength
  skyParams       : vec4f,   // x = turbidity, y = night factor, z = aerial strength, w = airglow
  cloudParams     : vec4f,   // x = layer bottom (m), y = layer top (m), z = coverage 0..1, w = density scale (1/m)
  cloudShape      : vec4f,   // x = type 0..1 (stratus->cumulonimbus), y = precipitation, z = erosion, w = anvil
  cloudWind       : vec4f,   // xy = layer drift offset (m), zw = wind direction (unit, XZ)
  // World -> celestial rotation for the star field: the diurnal spin about the
  // celestial pole, which sits at altitude = latitude in the northern sky.
  starRotation    : mat3x3f,
};

@group(SKY_GROUP) @binding(0) var<uniform> sky : Sky;

#ifdef SKY_HAS_LUTS
@group(SKY_GROUP) @binding(1) var skyLutSampler        : sampler;
@group(SKY_GROUP) @binding(2) var skyTransmittanceLUT  : texture_2d<f32>;
#endif
#ifdef SKY_HAS_MULTISCATTER
@group(SKY_GROUP) @binding(3) var skyMultiScatterLUT   : texture_2d<f32>;
#endif

fn skyGroundRadius() -> f32 { return sky.radii.x; }
fn skyTopRadius() -> f32 { return sky.radii.y; }
fn skyViewerRadius() -> f32 { return sky.radii.x + sky.radii.z; }
/// sqrt(Rt^2 - Rg^2): the horizontal distance from the ground to the top of the
/// atmosphere. Bruneton's parameterisation is built entirely out of it.
fn skyH() -> f32 { return sky.radii.w; }

// ---------------------------------------------------------------------------
// Medium
// ---------------------------------------------------------------------------

struct Medium {
  scatterR   : vec3f,
  scatterM   : vec3f,
  extinction : vec3f,
};

/// Densities and coefficients at an altitude above mean sea level.
/// Rayleigh and Mie fall off exponentially; ozone is a tent centred at 25 km,
/// which is what puts the magenta into the zenith at civil twilight - an
/// exponential ozone profile does not produce it.
fn sampleMedium(altitude: f32) -> Medium {
  let h = max(altitude, 0.0);
  let densityR = exp(-h / sky.rayleigh.w);
  let densityM = exp(-h / sky.mieScatter.w);
  let densityO = max(0.0, 1.0 - abs(h - sky.ground.w) / sky.ozone.w);

  var m: Medium;
  m.scatterR = sky.rayleigh.rgb * densityR;
  m.scatterM = sky.mieScatter.rgb * densityM;
  m.extinction = m.scatterR + m.scatterM
               + sky.mieAbsorb.rgb * densityM
               + sky.ozone.rgb * densityO;
  return m;
}

/// Rayleigh phase. Exact for dipole scattering, no fit involved.
fn rayleighPhase(mu: f32) -> f32 {
  return (3.0 / (16.0 * PI)) * (1.0 + mu * mu);
}

/// Cornette-Shanks Mie phase - Henyey-Greenstein with the Rayleigh limit
/// restored, so haze at g -> 0 degrades to something physical instead of
/// isotropic.
fn miePhase(mu: f32, g: f32) -> f32 {
  let g2 = g * g;
  let denom = 1.0 + g2 - 2.0 * g * mu;
  return (3.0 / (8.0 * PI)) * ((1.0 - g2) * (1.0 + mu * mu))
       / ((2.0 + g2) * denom * sqrt(max(denom, 1e-4)));
}

// ---------------------------------------------------------------------------
// Ray/shell geometry
// ---------------------------------------------------------------------------

/// Distance from (r, mu) to the top of the atmosphere. Always finite: every
/// ray leaves eventually, even one aimed at the ground (it exits after the
/// planet, which is why callers must test rayHitsGround first).
fn distanceToTop(r: f32, mu: f32) -> f32 {
  let disc = r * r * (mu * mu - 1.0) + skyTopRadius() * skyTopRadius();
  return max(-r * mu + sqrt(max(disc, 0.0)), 0.0);
}

fn distanceToGround(r: f32, mu: f32) -> f32 {
  let disc = r * r * (mu * mu - 1.0) + skyGroundRadius() * skyGroundRadius();
  return max(-r * mu - sqrt(max(disc, 0.0)), 0.0);
}

fn rayHitsGround(r: f32, mu: f32) -> bool {
  return mu < 0.0 && (r * r * (mu * mu - 1.0) + skyGroundRadius() * skyGroundRadius()) >= 0.0;
}

// ---------------------------------------------------------------------------
// LUT parameterisations
//
// Texel centres, not texel edges. `texCoordFromUnit` maps a unit-range value
// onto [0.5/n, 1-0.5/n] so that a lookup at unit 0 lands exactly on the first
// texel's centre. Skipping this is the classic source of a bright seam at the
// horizon and of a sky that does not quite match its own transmittance.
// ---------------------------------------------------------------------------

fn texCoordFromUnit(x: f32, n: f32) -> f32 { return 0.5 / n + saturate(x) * (1.0 - 1.0 / n); }
fn unitFromTexCoord(u: f32, n: f32) -> f32 { return saturate((u - 0.5 / n) / (1.0 - 1.0 / n)); }

/// (r, mu) -> transmittance LUT uv.
fn transmittanceUV(r: f32, mu: f32) -> vec2f {
  let Rg = skyGroundRadius();
  let H = skyH();
  let rho = sqrt(max(r * r - Rg * Rg, 0.0));
  let d = distanceToTop(r, mu);
  let dMin = skyTopRadius() - r;
  let dMax = rho + H;
  let xMu = (d - dMin) / max(dMax - dMin, 1.0);
  let xR = rho / max(H, 1.0);
  return vec2f(texCoordFromUnit(xMu, SKY_TRANSMITTANCE_W),
               texCoordFromUnit(xR, SKY_TRANSMITTANCE_H));
}

/// transmittance LUT uv -> (r, mu). Exact inverse of transmittanceUV.
fn transmittanceParams(uv: vec2f) -> vec2f {
  let Rg = skyGroundRadius();
  let Rt = skyTopRadius();
  let H = skyH();
  let xMu = unitFromTexCoord(uv.x, SKY_TRANSMITTANCE_W);
  let xR = unitFromTexCoord(uv.y, SKY_TRANSMITTANCE_H);
  let rho = H * xR;
  let r = sqrt(rho * rho + Rg * Rg);
  let dMin = Rt - r;
  let dMax = rho + H;
  let d = dMin + xMu * (dMax - dMin);
  var mu = 1.0;
  if (d > 0.0) { mu = (H * H - rho * rho - d * d) / (2.0 * r * d); }
  return vec2f(r, clamp(mu, -1.0, 1.0));
}

/// (r, cos sun zenith) -> multiple-scattering LUT uv. Linear in both, because
/// the second-order term is smooth everywhere including through the horizon.
fn multiScatterUV(r: f32, muS: f32) -> vec2f {
  let alt = (r - skyGroundRadius()) / max(skyTopRadius() - skyGroundRadius(), 1.0);
  return vec2f(texCoordFromUnit(muS * 0.5 + 0.5, SKY_MS_SIZE),
               texCoordFromUnit(alt, SKY_MS_SIZE));
}

/// Zenith angle of the horizon seen from radius r. Above the ground the
/// horizon dips below the geometric horizontal by acos(Rg/r), which is the one
/// place the sky-view LUT must be exact - a metre of error there is a visible
/// bright line under the sea.
fn horizonZenithAngle(r: f32) -> f32 {
  return HALF_PI + acos(clamp(skyGroundRadius() / max(r, 1.0), -1.0, 1.0));
}

/// Zenith angle -> sky-view LUT v, with sqrt density piled up at the horizon
/// (DESIGN 03.8.3: v = 0.5 + 0.5*sign(l)*sqrt(|l|)). Half the rows cover the
/// sky, half the sea, and the shared edge is exactly v = 0.5.
fn skyViewV(theta: f32, thetaHorizon: f32) -> f32 {
  var l: f32;
  if (theta < thetaHorizon) { l = (theta - thetaHorizon) / max(thetaHorizon, 1e-4); }
  else { l = (theta - thetaHorizon) / max(PI - thetaHorizon, 1e-4); }
  let s = sign(l) * sqrt(abs(l));
  return texCoordFromUnit(0.5 + 0.5 * s, SKY_VIEW_H);
}

fn skyViewTheta(v: f32, thetaHorizon: f32) -> f32 {
  let s = (unitFromTexCoord(v, SKY_VIEW_H) - 0.5) * 2.0;
  let l = sign(s) * s * s;
  if (l < 0.0) { return thetaHorizon + l * thetaHorizon; }
  return thetaHorizon + l * (PI - thetaHorizon);
}

/// Unit horizontal vector pointing along the sun's azimuth. Degenerate only
/// when the sun is exactly overhead, where azimuth is meaningless anyway.
fn sunAzimuthBasis() -> vec2f {
  let h = sky.sunDir.xz;
  let len = length(h);
  return select(vec2f(0.0, -1.0), h / len, len > 1e-4);
}

/// World direction -> sky-view LUT uv.
///
/// u spans HALF the azimuth circle: the atmosphere is exactly mirror-symmetric
/// about the plane containing the zenith and the sun, so folding |azimuth|
/// doubles the effective resolution and lets the LUT be sampled with a clamped
/// sampler instead of needing wrap in u and clamp in v.
fn skyViewUV(dir: vec3f, r: f32) -> vec2f {
  let theta = acos(clamp(dir.y, -1.0, 1.0));
  let sh = sunAzimuthBasis();
  let h = dir.xz;
  let hlen = length(h);
  var cosAz = 1.0;
  if (hlen > 1e-5) { cosAz = clamp(dot(h / hlen, sh), -1.0, 1.0); }
  let azimuth = acos(cosAz);   // [0, PI]
  return vec2f(texCoordFromUnit(azimuth * INV_PI, SKY_VIEW_W),
               skyViewV(theta, horizonZenithAngle(r)));
}

/// sky-view LUT uv -> world direction. Exact inverse of skyViewUV.
fn skyViewDir(uv: vec2f, r: f32) -> vec3f {
  let azimuth = unitFromTexCoord(uv.x, SKY_VIEW_W) * PI;
  let theta = skyViewTheta(uv.y, horizonZenithAngle(r));
  let sh = sunAzimuthBasis();
  let perp = vec2f(-sh.y, sh.x);
  let h = sh * cos(azimuth) + perp * sin(azimuth);
  let st = sin(theta);
  return vec3f(h.x * st, cos(theta), h.y * st);
}

// ---------------------------------------------------------------------------
// LUT sampling
// ---------------------------------------------------------------------------

#ifdef SKY_HAS_LUTS
/// Transmittance from radius r along cos-zenith mu to the top of the
/// atmosphere. Undefined for rays that hit the ground; test rayHitsGround.
fn sampleTransmittance(r: f32, mu: f32) -> vec3f {
  return textureSampleLevel(skyTransmittanceLUT, skyLutSampler, transmittanceUV(r, mu), 0.0).rgb;
}

/// Transmittance toward the sun at a point, zero where the planet is in the
/// way. This is the only shadowing the atmosphere itself does.
fn sunTransmittance(r: f32, muS: f32) -> vec3f {
  if (rayHitsGround(r, muS)) { return vec3f(0.0); }
  return sampleTransmittance(r, muS);
}

/// Transmittance between two points on the same ray, by the ratio of their
/// transmittances to the top of the atmosphere. Cheaper and better conditioned
/// than integrating the segment, and exact for a spherically symmetric medium.
fn transmittanceSegment(r0: f32, mu0: f32, d: f32) -> vec3f {
  let r1 = clamp(sqrt(d * d + 2.0 * r0 * mu0 * d + r0 * r0), skyGroundRadius(), skyTopRadius());
  let mu1 = clamp((r0 * mu0 + d) / r1, -1.0, 1.0);
  return clamp(sampleTransmittance(r1, mu1) / max(sampleTransmittance(r0, mu0), vec3f(1e-6)),
               vec3f(0.0), vec3f(1.0));
}
#endif

#ifdef SKY_HAS_MULTISCATTER
/// Isotropic multiple-scattering radiance already divided by (1 - f_ms), so
/// the caller multiplies it by the local scattering coefficient and is done.
fn sampleMultiScatter(r: f32, muS: f32) -> vec3f {
  return textureSampleLevel(skyMultiScatterLUT, skyLutSampler, multiScatterUV(r, muS), 0.0).rgb;
}
#endif

// ---------------------------------------------------------------------------
// Aerial perspective
// ---------------------------------------------------------------------------

struct Aerial {
  transmittance : vec3f,
  inScatter     : vec3f,
};

#if defined(SKY_HAS_LUTS) && defined(SKY_HAS_MULTISCATTER)
/// Single + multiple scattering over a bounded segment, for surfaces the sky
/// pass can see. SUBWAVE's world is 6 km across, so this is a small correction
/// rather than the whole image - but it is the correction that makes the
/// island read as far away instead of as a painted backdrop.
///
/// `originY` is world-space metres above mean sea level; the segment is
/// `dist` metres along `dir`. SKY_AERIAL_STEPS steps, uniform: the segment is
/// short enough relative to the scale heights that a non-uniform distribution
/// buys nothing.
fn aerialPerspective(originY: f32, dir: vec3f, dist: f32) -> Aerial {
  var out: Aerial;
  out.transmittance = vec3f(1.0);
  out.inScatter = vec3f(0.0);
  if (dist <= 0.0) { return out; }

  let Rg = skyGroundRadius();
  // Planet-centred position of the viewer, in a frame whose +y is the local up.
  let origin = vec3f(0.0, Rg + max(originY, 0.0), 0.0);
  let muSun = clamp(dot(dir, sky.sunDir.xyz), -1.0, 1.0);
  let phaseR = rayleighPhase(muSun);
  let phaseM = miePhase(muSun, sky.mieAbsorb.w);

  let dt = dist / f32(SKY_AERIAL_STEPS);
  var throughput = vec3f(1.0);
  var scattered = vec3f(0.0);

  for (var i = 0; i < SKY_AERIAL_STEPS; i++) {
    let p = origin + dir * ((f32(i) + 0.5) * dt);
    let r = max(length(p), Rg);
    let m = sampleMedium(r - Rg);
    let muS = clamp(dot(p / r, sky.sunDir.xyz), -1.0, 1.0);
    let Tsun = sunTransmittance(r, muS);
    let ms = sampleMultiScatter(r, muS);

    let single = (m.scatterR * phaseR + m.scatterM * phaseM) * Tsun * sky.solarIrradiance.rgb;
    let multi = (m.scatterR + m.scatterM) * ms;
    let source = single + multi;

    let stepT = exp(-m.extinction * dt);
    // Analytic integral of source*exp(-sigma*s) over the step: energy-correct
    // even when the step is optically thick, unlike source*dt.
    let integrated = (source - source * stepT) / max(m.extinction, vec3f(1e-9));
    scattered += throughput * integrated;
    throughput *= stepT;
  }

  out.transmittance = throughput;
  out.inScatter = scattered * sky.skyParams.z;
  return out;
}
#endif
