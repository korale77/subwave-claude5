// SUBWAVE - ocean wave field: parameters, spectrum, dispersion, Gerstner query.
//
// Binding-free except for the OceanParams uniform itself, whose group/binding
// the includer chooses (the simulation passes own group 0; render passes reserve
// group 0 for the Frame and put the ocean in group 1):
//
//   #define OCEAN_GROUP 1
//   #define OCEAN_BINDING 0
//   #include "../common/ocean.wgsl"
//
// The spectral model here is mirrored EXACTLY by src/sim/ocean.js. The CPU needs
// the same wave field for buoyancy and the waterline, and "exactly" means the
// same integer hash, the same Box-Muller, the same band weights - not merely the
// same formulae. Any divergence shows up as a vessel that floats a few
// centimetres above or below the water it is drawn against.

#pragma once

#include "math.wgsl"

#ifndef OCEAN_GROUP
#error "define OCEAN_GROUP and OCEAN_BINDING before including common/ocean.wgsl"
#endif

// Overridden per compile from constants.js TRUE_DARK_DEPTH. The fallback keeps
// the file preprocessable by the offline checker, which has no game constants.
#ifndef TRUE_DARK_DEPTH
#define TRUE_DARK_DEPTH 520.0
#endif

// Reverse energy travelling upwind. Real seas carry 3-8% of their energy against
// the wind; at zero the back of every wave is a dead-flat facet that reads as a
// polygon rather than as water.
const OCEAN_UPWIND_LEAK : f32 = 0.055;

// Shelf depth for the dispersion relation. tanh(k * 400) differs from 1 by less
// than 1e-6 for every wavenumber above the longest swell, where the shoaling it
// introduces is the physically correct behaviour over a 400 m shelf.
const OCEAN_SHELF_DEPTH : f32 = 400.0;

// Argument at which tanh is clamped. Not a tolerance - a hard f32 limit.
// tanh is commonly evaluated as (e^2x - 1)/(e^2x + 1), and e^2x overflows f32 at
// x > 44.36, which returns inf/inf = NaN (or inf). k*400 passes 44.36 at
// k = 0.111, i.e. at wavelengths under 57 m - which is nearly the WHOLE
// spectrum. tanh(20) rounds to exactly 1.0 in f32, so clamping here changes no
// representable result by a single ulp.
const OCEAN_TANH_MAX : f32 = 20.0;

// Third-octave taper for the band-split crossfade between cascades. A hard cut
// puts a shelf in the slope statistics and rings around the boundary wavelength.
const OCEAN_BAND_TAPER : f32 = 1.26;

// Refractive index of seawater at the three band centres (610/550/460 nm).
// Water is dispersive; this is what fringes the rim of Snell's window and the
// edges of caustic filaments.
const OCEAN_IOR_RGB : vec3f = vec3f(1.3305, 1.3345, 1.3405);
const OCEAN_IOR : f32 = 1.339;

/// Components in the Gerstner surrogate. 32 is the point where the CPU query
/// costs about 2 us and adding more stops changing the answer: the spectrum's
/// energy is spread over tens of thousands of modes, so mode count buys
/// statistics, not pointwise fidelity. See src/sim/ocean.js for the numbers.
const OCEAN_GERSTNER_WAVES : u32 = 32u;

struct OceanParams {
  // xyz = tile size L per cascade (m), w = 1/N
  cascadeL    : vec4f,
  // xyz = horizontal displacement gain per cascade (lambda_c * chopScale), w = N
  cascadeChop : vec4f,
  // xy = unit wind direction (XZ plane), z = U10 (m/s), w = significant height Hs (m)
  wind        : vec4f,
  // x = h0 amplitude scale for CASCADE 0, y = min wavelength (m), z = gravity,
  // w = h0 amplitude scale for CASCADE 1. The scales are per band because a
  // single one gives the sea a wind-independent chop - see the note on
  // OCEAN.RESOLVED_SLOPE_FRACTION in constants.js. x used to be the Phillips
  // constant, which the Hs normalisation cancelled exactly.
  spectrum    : vec4f,
  // x = time (s), y = dt (s), z = foam decay rate (1/s), w = Jacobian foam threshold
  timing      : vec4f,
  // x = foam gain, y = h0 amplitude scale for CASCADE 2, z = loop period (s).
  // w carries the Cox-Munk slope variance but NOTHING READS IT HERE: the
  // surface shader derives it through oceanCoxMunkSlopeVariance() so the
  // Gerstner path has it too. It is kept populated rather than removed because
  // the struct is a fixed vec4 layout that tools/test-ocean.mjs checks byte for
  // byte.
  shading     : vec4f,
  // x = N, y = log2(N), z = cascade count, w = world seed
  counts      : vec4u,
  // Gerstner waves: [2i] = (kx, kz, amplitude, omega), [2i+1] = (phase, 1/|k|, steepness, 0)
  waves       : array<vec4f, 64>,
};

@group(OCEAN_GROUP) @binding(OCEAN_BINDING) var<uniform> ocean : OceanParams;

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/// triple32 - a bias-free 32-bit integer hash. Chosen over the usual
/// wang/xxhash mixes because its avalanche is exact enough that the Gaussians
/// built from it pass a chi-square test at N=256, which matters: a biased h0
/// gives the sea a visible directional grain that no amount of tuning removes.
fn oceanHashU32(xIn: u32) -> u32 {
  var x = xIn;
  x ^= x >> 17u; x *= 0xed5ad4bbu;
  x ^= x >> 11u; x *= 0xac4c1b51u;
  x ^= x >> 15u; x *= 0x31848babu;
  x ^= x >> 14u;
  return x;
}

fn oceanHashCell(n: u32, m: u32, cascade: u32, seed: u32) -> u32 {
  return oceanHashU32(n * 0x9e3779b1u + m * 0x85ebca6bu + cascade * 0xc2b2ae35u + seed);
}

/// Two independent standard normals by Box-Muller. The +0.5 keeps u1 strictly
/// positive so log() can never produce an infinity for the one texel whose hash
/// happens to be zero.
fn oceanGauss2(n: u32, m: u32, cascade: u32, seed: u32) -> vec2f {
  let h0 = oceanHashCell(n, m, cascade, seed);
  let h1 = oceanHashU32(h0 ^ 0x68bc21ebu);
  let u1 = (f32(h0) + 0.5) * 2.3283064365386963e-10;
  let u2 = (f32(h1) + 0.5) * 2.3283064365386963e-10;
  let r = sqrt(-2.0 * log(u1));
  let theta = TAU * u2;
  return vec2f(r * cos(theta), r * sin(theta));
}

// ---------------------------------------------------------------------------
// Spectrum
// ---------------------------------------------------------------------------

/// Tessendorf's Phillips spectrum, SHAPE ONLY.
///
///   P(k) = exp(-1/(k*L)^2) / k^4 * dir(k) * exp(-(k*l)^2)
///
/// L = U^2/g is the wavelength of the largest wave a wind of U can raise;
/// the exp(-1/(kL)^2) factor is what makes the otherwise divergent k -> 0 tail
/// integrable. exp(-(k*l)^2) suppresses everything below MIN_WAVELENGTH, which
/// is not cosmetic - unresolved ripples alias into the FFT as a static grid
/// pattern rather than as chop.
///
/// There is deliberately no amplitude constant. src/sim/ocean.js normalises the
/// field to the sea state's Hs, so any constant here cancels exactly: measured,
/// A x10 and A/10 produced cascade RMS heights of 0.07466 and 0.07468 m against
/// 0.07464, with only the h0 scale moving.
fn oceanPhillips(k: vec2f, kmag: f32) -> f32 {
  if (kmag < 1e-6) { return 0.0; }
  let g = ocean.spectrum.z;
  let u10 = max(ocean.wind.z, 0.05);
  let bigL = u10 * u10 / g;
  let k2 = kmag * kmag;
  let k4 = k2 * k2;

  let c = dot(k / kmag, ocean.wind.xy);
  var dir = c * c;                                  // cos^2 directional spreading
  if (c < 0.0) { dir *= OCEAN_UPWIND_LEAK; }

  let l = ocean.spectrum.y;
  return exp(-1.0 / (k2 * bigL * bigL)) / k4 * dir * exp(-k2 * l * l);
}

/// h0 amplitude scale for one cascade. Cascade 0 is solved so the TOTAL surface
/// variance is exactly Hs^2/16; cascades 1 and 2 share the band gain that puts
/// the resolved slope on Cox & Munk's curve. src/sim/ocean.js computes all
/// three in `bake()` and this must read them back in the same order.
fn oceanH0Scale(c: u32) -> f32 {
  if (c == 0u) { return ocean.spectrum.x; }
  if (c == 1u) { return ocean.spectrum.w; }
  return ocean.shading.y;
}

/// Tile size L of a cascade, metres. Several includers keep a local copy of
/// this for their own use; the spectrum needs one HERE because the discrete
/// mode amplitude depends on the cascade's spectral bin area.
fn oceanCascadeSize(c: u32) -> f32 {
  if (c == 0u) { return ocean.cascadeL.x; }
  if (c == 1u) { return ocean.cascadeL.y; }
  return ocean.cascadeL.z;
}

/// Area of one spectral bin, (2*PI/L)^2.
///
/// THIS IS THE FACTOR THAT MAKES A MULTI-CASCADE OCEAN HAVE CHOP.
///
/// The synthesised surface has variance sum_k E|h(k)|^2, a SUM over lattice
/// sites, while the Phillips spectrum is a DENSITY whose integral over d2k is
/// the variance. The two agree only if each mode carries P(k) * dk^2. A
/// single-patch ocean can drop it - it is a constant that the Phillips A
/// absorbs - but three patches have three different dk, and dropping it
/// under-weights the 64 m cascade by (512/64)^2 = 64x and the 8 m ripple
/// cascade by 4096x. Measured on the GPU before this was here: the 64 m
/// cascade carried 1/46th of the slope variance the spectrum asks for and the
/// 8 m cascade carried none at all, which is a sea with a swell and no
/// surface - no chop, no capillary detail, and so no sun glitter, because
/// glitter IS the short-wave slope distribution.
fn oceanBinArea(c: u32) -> f32 {
  let dk = TAU / oceanCascadeSize(c);
  return dk * dk;
}

/// Partition of unity across the cascades. Each cascade owns the band from its
/// predecessor's Nyquist up to its own, with a third-octave crossfade so the
/// three tiles hand energy over smoothly instead of stepping.
///
/// The weights sum to 1 for every k, so total energy is preserved exactly; the
/// AMPLITUDE is scaled by sqrt(W) because energy goes as amplitude squared.
fn oceanBandWeight(kmag: f32, cascade: u32) -> f32 {
  let n = ocean.cascadeChop.w;
  let count = ocean.counts.z;
  // Boundary c/c+1 sits a taper below cascade c's Nyquist, so cascade c can
  // still represent the whole upper skirt of its own crossfade.
  let k01 = (PI * n / ocean.cascadeL.x) / OCEAN_BAND_TAPER;
  let k12 = (PI * n / ocean.cascadeL.y) / OCEAN_BAND_TAPER;
  let w01 = smoothstep(k01 / OCEAN_BAND_TAPER, k01 * OCEAN_BAND_TAPER, kmag);
  let w12 = smoothstep(k12 / OCEAN_BAND_TAPER, k12 * OCEAN_BAND_TAPER, kmag);

  if (count < 2u) { return 1.0; }
  if (count < 3u) {
    if (cascade == 0u) { return 1.0 - w01; }
    return w01;
  }
  if (cascade == 0u) { return 1.0 - w01; }
  if (cascade == 1u) { return w01 * (1.0 - w12); }
  return w12;
}

/// Deep-water dispersion, quantised so the whole field is exactly periodic with
/// the loop period. Quantisation costs nothing visually (the worst phase error
/// is half a bin over a full loop) and buys exact state save/restore, a
/// deterministic replay, and a sea that never drifts out of sync with the CPU
/// buoyancy query after hours of play.
fn oceanOmega(kmag: f32) -> f32 {
  let g = ocean.spectrum.z;
  // See OCEAN_TANH_MAX: unclamped, this returns inf for every wave shorter than
  // 57 m, cos(inf) comes back as 0, and the entire synthesised field collapses
  // to a dead flat sea. Measured on the real GPU, not inferred.
  let w = sqrt(g * kmag * tanh(min(kmag * OCEAN_SHELF_DEPTH, OCEAN_TANH_MAX)));
  let w0 = TAU / ocean.shading.z;
  return floor(w / w0 + 0.5) * w0;
}

/// The complex h0(k) for one lattice site, before the Hs normalisation scale.
/// Returned as (re, im).
fn oceanH0(k: vec2f, kmag: f32, n: u32, m: u32, cascade: u32) -> vec2f {
  // The n = 0 and m = 0 lattice edges have no partner under k -> -k (their
  // mirror is themselves), so leaving them populated puts an unpaired,
  // non-Hermitian mode in the spectrum and the "height" field comes out with a
  // small imaginary part. They sit at the Nyquist limit and carry no energy
  // worth keeping, so zero them and the surface is exactly real.
  if (n == 0u || m == 0u) { return vec2f(0.0); }
  let p = oceanPhillips(k, kmag) * oceanBandWeight(kmag, cascade) * oceanBinArea(cascade);
  if (p <= 0.0) { return vec2f(0.0); }
  let xi = oceanGauss2(n, m, cascade, ocean.counts.w);
  return xi * sqrt(0.5 * p) * oceanH0Scale(cascade);
}

// ---------------------------------------------------------------------------
// Gerstner query - the CPU-authoritative surface, mirrored on the GPU
// ---------------------------------------------------------------------------

/// Result of a Gerstner surface evaluation.
///   disp   - full 3D displacement of the lattice point (x and z are the choppy
///            horizontal terms, y is the height)
///   slope  - d(height)/dx, d(height)/dz at the lattice point
struct OceanGerstner {
  disp  : vec3f,
  slope : vec2f,
};

/// Sum the first `count` importance-sampled waves, of OCEAN_GERSTNER_WAVES
/// available. This is the field the vessel floats on
/// and the waterline is classified against, so the surface pass evaluates the
/// SAME function for its half-submerged mask: a spectral surface that disagrees
/// with the buoyancy surface by even 10 cm produces a vessel that visibly rides
/// inside its own wake.
fn oceanGerstnerCount(p: vec2f, t: f32, count: u32) -> OceanGerstner {
  var disp = vec3f(0.0);
  var slope = vec2f(0.0);
  for (var i = 0u; i < count; i = i + 1u) {
    let a = ocean.waves[i * 2u];
    let b = ocean.waves[i * 2u + 1u];
    let amp = a.z;
    if (amp <= 0.0) { continue; }
    let phase = a.x * p.x + a.y * p.y - a.w * t + b.x;
    let s = sin(phase);
    let c = cos(phase);
    disp.y += amp * c;
    // Horizontal Gerstner term: crests sharpen, troughs flatten. b.y = 1/|k|,
    // b.z = steepness (already bounded so the surface cannot self-intersect).
    let q = amp * b.z * b.y * s;
    disp.x -= a.x * q;
    disp.z -= a.y * q;
    slope.x -= a.x * amp * s;
    slope.y -= a.y * amp * s;
  }
  var out: OceanGerstner;
  out.disp = disp;
  out.slope = slope;
  return out;
}

/// The full sum. Waves are stored in descending amplitude order, so a truncated
/// count is always the best available approximation for its cost - which is why
/// the per-pixel waterline probe can afford to stop at eight.
fn oceanGerstnerAt(p: vec2f, t: f32) -> OceanGerstner {
  return oceanGerstnerCount(p, t, OCEAN_GERSTNER_WAVES);
}

/// Height of the surface AT a given (x, z), rather than at the lattice point
/// that maps there. Gerstner displacement makes those different; three
/// fixed-point iterations of p = xz - D_xz(p) converge to well under a
/// centimetre for the steepness bounds we ship (the map is a contraction with
/// modulus = total steepness < 1).
fn oceanHeightAt(xz: vec2f, t: f32) -> f32 {
  var p = xz;
  for (var i = 0; i < 3; i = i + 1) {
    let g = oceanGerstnerAt(p, t);
    p = xz - g.disp.xz;
  }
  return oceanGerstnerAt(p, t).disp.y;
}

// ---------------------------------------------------------------------------
// Shared shading helpers
// ---------------------------------------------------------------------------

/// Per-cascade distance fade. Cascade 2 carries sub-metre ripples that alias
/// badly past a few tens of metres; the energy it drops is handed to the
/// specular roughness instead, so the lobe widens rather than the normal map
/// sparkling.
fn oceanCascadeFade(cascade: u32, dist: f32) -> f32 {
  if (cascade == 2u) { return 1.0 - smoothstep(24.0, 60.0, dist); }
  if (cascade == 1u) { return 1.0 - smoothstep(400.0, 900.0, dist); }
  return 1.0;
}

/// Cox-Munk total mean-square surface slope for a wind of U10 m/s (1954, the
/// classic sun-glitter photogrammetry result). Used as the analytic floor for
/// the filtered roughness once the pixel footprint outruns the last mip.
fn oceanCoxMunkSlopeVariance(u10: f32) -> f32 {
  return 0.003 + 0.00512 * u10;
}

/// Normal-incidence reflectance of an air/water interface. Not a tuning value:
/// ((1.333 - 1) / (1.333 + 1))^2 = 0.0204.
const OCEAN_F0 : f32 = 0.02;

/// Fresnel of a sea whose facet slopes are Gaussian with RMS `sigma`, averaged
/// over that distribution (Bruneton, Neyret & Holzschuch 2010) - the exact
/// surface statistic this ocean already computes.
///
/// NOT the split-sum DFG, and the difference is the whole look of the far sea.
/// `envBRDFApprox` fits the GGX environment integral, whose Smith masking
/// assumes the occluded facets are BLACK; on a sea they are the backs of the
/// next waves, which are water mirroring the same sky. The fit's
/// min(r.x*r.x, exp2(-9.28*NoV)) term also saturates: at the roughness this
/// surface runs (alpha ~ 0.15) it is constant for every |N.V| below 0.152, so
/// the reflectance was a flat 0.252 for ALL water past 37 m from a 5.2 m eye -
/// 95% of the frame. Measured against sceneColor at the spawn camera: 1048 m of
/// sea returned G 1.74 under a horizon sky of G 4.32 it is supposed to be
/// mirroring, and the luminance p95/p05 across a 90-140 m band was 1.217. The
/// sea was one number.
///
/// This form returns 0.428 at cosI 0.005 and 0.364 at 0.05 against 0.285, lands
/// on the physical 0.0204 at normal incidence so nothing steep moves, and - the
/// point - takes `sigma` from the same Cox-Munk statistic the roughness uses, so
/// the sea gets MORE reflective as the wind rises, which is what a real one does
/// and what the split-sum model cannot express at all.
fn oceanMeanFresnel(cosThetaV: f32, sigma: f32) -> f32 {
  let s = max(sigma, 1e-3);
  let m = pow(1.0 - cosThetaV, 5.0 * exp(-2.69 * s)) / (1.0 + 22.7 * pow(s, 1.5));
  return OCEAN_F0 + (1.0 - OCEAN_F0) * saturate(m);
}

/// Exact unpolarised Fresnel reflectance at a dielectric interface, eta = n1/n2.
///
/// Schlick is fine going air -> water but WRONG going water -> air: it has no
/// total internal reflection, so the underside of the sea would stay
/// half-transparent past the critical angle instead of turning into a mirror.
/// This form gives R = 1 exactly at the critical angle, which is what draws the
/// hard rim of Snell's window.
fn oceanFresnelExact(cosI: f32, eta: f32) -> f32 {
  let c = saturate(cosI);
  let sin2T = eta * eta * (1.0 - c * c);
  if (sin2T >= 1.0) { return 1.0; }
  let cosT = sqrt(1.0 - sin2T);
  let rs = (eta * c - cosT) / (eta * c + cosT);
  let rp = (eta * cosT - c) / (eta * cosT + c);
  return saturate(0.5 * (rs * rs + rp * rp));
}

/// Daylight window. `daylightAtDepth()` in water.wgsl is pure Beer-Lambert and
/// never reaches zero - at 520 m the clearest water still passes 8e-5 of the
/// surface irradiance, which auto-exposure will happily lift into a grey soup.
/// This is the numerical statement of the design's hard guarantee: below
/// TRUE_DARK_DEPTH the only DAYLIGHT in the world is gone. smoothstep returns
/// exactly 1.0 at and beyond its upper edge, so the product is exactly 0.0, not
/// merely small.
///
/// WHAT SURVIVES IT IS NO LONGER ONLY LAMPS AND BIOLUMINESCENCE, and this
/// docstring said so for a long time after it stopped being the whole truth.
/// pass/underwater.wgsl now opens a second, authored source - the DEEP KEY - on
/// the exactly complementary gate `1 - aphoticFactor(camDepth)`, so the two hand
/// over and never overlap. THIS FUNCTION IS UNCHANGED and must stay that way:
/// every one of its callers is draining a daylight-derived term, and the
/// measured reason the deep is one flat image is not that this returns zero, it
/// is that nothing took over the job. At Canyon Wall (478 m) it still returns
/// 0.109, so 11% of the deep tint passes and the measured frame delta from that
/// tint is 0.62% - moving this curve alone changes nothing anyone can see.
fn aphoticFactor(depth: f32) -> f32 {
  return 1.0 - smoothstep(TRUE_DARK_DEPTH * 0.615, TRUE_DARK_DEPTH, depth);
}
