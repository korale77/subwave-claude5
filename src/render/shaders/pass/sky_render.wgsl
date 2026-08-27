// SUBWAVE - the sky pass.
//
// Drawn AFTER opaque geometry with a depth test and no depth write, so it only
// shades pixels nothing else claimed. Three entry points share this module:
//
//   fs_sky              sky-view LUT + sun disc + two moons + stars + galaxy
//   fs_aerialExtinction the multiply half of aerial perspective (blend dst*src)
//   fs_aerialInScatter  the add half                            (blend additive)
//
// Aerial perspective is two draws because `dst*T + S` with a PER-CHANNEL T is
// not expressible in one WebGPU blend equation: the only factors that can hold
// an rgb value are `src` and `one-minus-src`, and both are already spent on the
// source colour. Two draws over the geometry-covered pixels cost less than the
// alternative (an extra full-resolution rgba16float copy of sceneColor), and
// the second draw reuses everything the first computed except the final term.

#define SKY_GROUP 1
#define SKY_HAS_LUTS
#define SKY_HAS_MULTISCATTER

#include "../common/fullscreen.wgsl"
#include "../common/atmosphere.wgsl"
#include "../common/noise.wgsl"

// One star: 32 bytes. `dirMag.w` is the apparent magnitude, kept rather than
// only the radiance because both the size and the diffraction-spike length are
// magnitude-driven and deriving m back from a radiance costs a log.
struct Star {
  dirMag     : vec4f,   // xyz = unit direction in CELESTIAL space, w = magnitude
  colorPhase : vec4f,   // rgb = linear colour, w = twinkle phase
};

@group(1) @binding(4) var<storage, read> stars     : array<Star>;
@group(1) @binding(5) var<storage, read> starCells : array<vec2u>;
@group(1) @binding(6) var sceneDepthTex            : texture_depth_2d;

// Star bucket grid. MUST match STAR_GRID_U / STAR_GRID_V in src/sim/sky.js:
// the CPU sorts stars into exactly these cells and the shader reads one cell.
const STAR_GRID_U : u32 = 96u;
const STAR_GRID_V : u32 = 48u;

/// Peak radiance of a magnitude-0 star, renderer units. Set so the brightest
/// stars sit an order of magnitude above the moonless night sky (whose zenith
/// radiance is ~0.02 in these units) and therefore bloom slightly, while a
/// magnitude-6 star lands just under it and disappears - which is exactly the
/// naked-eye limit it should have.
const STAR_PEAK_M0 : f32 = 4.0;
/// exp(-STAR_MAG_DECAY * m) == 10^(-0.4 m).
const STAR_MAG_DECAY : f32 = 0.921034037;
/// Gaussian point-spread sigma in pixels (DESIGN 03.8.6).
const STAR_PSF_SIGMA : f32 = 1.30;
/// Stars brighter than this get the 4-ray diffraction cross.
const STAR_SPIKE_MAG : f32 = 1.5;
/// Angular radius, radians, beyond which a star contributes NOTHING.
///
/// This is a hard contract with STAR_INSERT_PAD in src/sim/sky.js: the CPU
/// guarantees a star appears in every cell within that padding of it, and this
/// shader reads exactly one cell. Emitting light past it would clip the star's
/// point spread along cell boundaries. The diffraction spikes are windowed to
/// zero here rather than simply cut, because the spike of a magnitude -1.4 star
/// is still ~10% of its peak at this radius and a hard cut would draw a visible
/// circle around every bright star.
const STAR_MAX_ANGLE : f32 = 0.030;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Absolute world-space altitude of the camera, clamped at the surface: the
/// atmosphere model has no idea what to do with a negative altitude, and the
/// sky seen from just under the waterline is the sky seen from on it.
fn cameraAltitude() -> f32 {
  return max(frame.worldOrigin.y + frame.cameraPos.y, 0.0);
}

/// Radians subtended by one pixel vertically. Everything with a hard edge -
/// the sun limb, the moon limb, a star's PSF - is antialiased against this.
fn angularPixelSize() -> f32 {
  return 2.0 * frame.cameraFwd.w / max(frame.screen.y, 1.0);
}

fn sampleSkyView(dir: vec3f, r: f32) -> vec3f {
  return textureSampleLevel(skyLUT, linearClampSampler, skyViewUV(dir, r), 0.0).rgb;
}

/// Transmittance of the whole atmosphere along a view ray, for the celestial
/// bodies that sit outside it. Zero when the planet is in the way.
fn viewTransmittance(r: f32, dir: vec3f) -> vec3f {
  if (rayHitsGround(r, dir.y)) { return vec3f(0.0); }
  return sampleTransmittance(r, dir.y);
}

// ---------------------------------------------------------------------------
// Sun
// ---------------------------------------------------------------------------

/// The sun disc, added analytically rather than baked into the sky-view LUT:
/// at 256x128 the LUT's texels are 0.7 deg across and the disc is 0.54 deg, so
/// it would be a smeared blob two texels wide with a stepped edge.
///
/// Limb darkening is the standard I(r)/I(0) = 1 - u*(1 - sqrt(1-(r/R)^2)) with
/// u = 0.6, which is the visible-band value for a G star and is what stops the
/// disc reading as a flat white circle.
fn sunDisc(dir: vec3f) -> vec3f {
  let radius = sky.sunDir.w;
  let cosR = cos(radius);
  let cosTheta = dot(dir, sky.sunDir.xyz);
  if (cosTheta <= cos(radius * 2.0)) { return vec3f(0.0); }

  let theta = acos(clamp(cosTheta, -1.0, 1.0));
  let apx = angularPixelSize();
  let coverage = 1.0 - smoothstep(radius - apx, radius + apx, theta);
  if (coverage <= 0.0) { return vec3f(0.0); }

  let rNorm = saturate(theta / max(radius, 1e-6));
  let limb = 1.0 - 0.6 * (1.0 - sqrt(max(1.0 - rNorm * rNorm, 0.0)));

  // Irradiance -> radiance: divide by the disc's solid angle, 2*PI*(1-cos R).
  let solidAngle = max(TAU * (1.0 - cosR), 1e-9);
  var radiance = sky.solarIrradiance.rgb / solidAngle * limb;
  // sceneColor is rgba16float; the physical value here is ~2e6 and would be
  // Inf. Clamping is not a cheat - the bloom and tonemap chain downstream
  // cannot represent it either, and 03.0.3 mandates the clamp.
  radiance = min(radiance, vec3f(sky.solarIrradiance.w));
  return radiance * coverage;
}

// ---------------------------------------------------------------------------
// Moons
// ---------------------------------------------------------------------------

/// One moon, with a real phase terminator.
///
/// The terminator is not painted on: the point of the disc at tangential
/// offset (x, y) is a point on a unit sphere whose outward normal is
/// e1*x + e2*y - moonDir*sqrt(1-x^2-y^2), and its illumination is that normal
/// against the sun. Phase, libration-free terminator curvature and the
/// crescent's correct orientation relative to the sun all fall out for free.
///
/// Photometry is Lommel-Seeliger (mu0/(mu0+mu)), not Lambert. A Lambertian
/// moon is visibly wrong: it limb-darkens, whereas the real full moon is a
/// flat disc of near-uniform brightness, which is the single most recognisable
/// thing about it.
fn moonDisc(dir: vec3f, moonDir: vec3f, radius: f32, color: vec3f, seed: u32) -> vec3f {
  let cosTheta = dot(dir, moonDir);
  if (cosTheta <= cos(radius * 2.0)) { return vec3f(0.0); }

  let theta = acos(clamp(cosTheta, -1.0, 1.0));
  let apx = angularPixelSize();
  let coverage = 1.0 - smoothstep(radius - apx, radius + apx, theta);
  if (coverage <= 0.0) { return vec3f(0.0); }

  let basis = orthonormalBasis(moonDir);
  let tangent = dir - moonDir * cosTheta;
  let x = dot(tangent, basis[0]) / max(radius, 1e-6);
  let y = dot(tangent, basis[1]) / max(radius, 1e-6);
  let rr = min(x * x + y * y, 1.0);
  let z = sqrt(max(1.0 - rr, 0.0));

  let normal = basis[0] * x + basis[1] * y - moonDir * z;
  let mu0 = dot(normal, sky.sunDir.xyz);
  let mu = z;

  // Surface: a fbm mare mask darkening the albedo, plus a crater field. Both
  // are evaluated in the moon's own body frame, which is fixed because both
  // moons are tidally locked - the same face always points at the planet.
  let bodyP = normal * 3.4;
  let mare = smoothstep(0.10, 0.55, fbmCheap3(bodyP * 0.55, seed));
  let craters = worley3F1(bodyP * 2.6, seed + 77u, 1.0);
  let albedo = color * mix(1.0, 0.62, mare) * mix(0.82, 1.0, craters);

  var lit = vec3f(0.0);
  if (mu0 > 0.0) {
    lit = albedo * (mu0 / max(mu0 + mu, 1e-3));
  }
  // Earthshine: the unlit limb catches light reflected off the planet's own
  // ocean, so it is blue. Free environmental storytelling - the player can see
  // the colour of their own world on the moon.
  let earthshine = albedo * vec3f(0.55, 0.72, 1.00) * 0.019 * saturate(-mu0 * 0.5 + 0.5);

  return (lit + earthshine) * coverage;
}

// ---------------------------------------------------------------------------
// Moonlight in the sky
// ---------------------------------------------------------------------------

/// Largest relative airmass the closed form is evaluated at (the Kasten-Young
/// value at the geometric horizon is 38.0). Below the horizon it simply
/// saturates, which is the optically-thick limit and is continuous.
const MOON_AIRMASS_MAX : f32 = 38.0;

/// Horizontal irradiance one moon delivers, per channel, in the same renderer
/// units sim/sky.js meters env.moonIntensity in.
///
/// It is RECONSTRUCTED from the disc parameters rather than carried in its own
/// uniform slot: sim/sky.js writes `color.rgb = albedo * intensity /
/// (solidAngle * 0.5)`, so multiplying back by the solid angle and the
/// Lommel-Seeliger half returns `albedo * intensity` - and going through the
/// albedo is a feature, because the light a moon casts then carries its own
/// tint. The phase exponent and the altitude factor are exactly the ones
/// _updateEphemeris applies (E = E_full * k^1.35 * max(0, sin h)), so the sky
/// and the scene are lit by the same number.
fn moonIrradiance(moonDir: vec4f, moonColor: vec4f) -> vec3f {
  let solidAngle = PI * moonDir.w * moonDir.w;
  return moonColor.rgb * solidAngle * 0.5 * pow(moonColor.w, 1.35) * max(moonDir.y, 0.0);
}

/// Single-scattered moonlight along a view ray, in closed form.
///
/// The sky-view LUT integrates the SUN alone, so it is EXACTLY (0,0,0) after
/// dusk - measured at dayFraction 0.0, every texel zero at the zenith, the
/// middle and the horizon. The entire night sky was therefore the airglow
/// constant and nothing else, measured p50 (6.0e-5, 8.9e-5, 5.4e-5): an olive
/// with no moonlight in it at all, under two full moons.
///
/// This is the homogeneous-slab closure for single scattering rather than a
/// second march: where the scattering-to-extinction ratio is constant along the
/// ray, the integral collapses to (sigma_s/sigma_t) * P(mu) * E * T *
/// (1 - exp(-tau)). tau is the VERTICAL optical depth times the relative
/// airmass, and the vertical depth of an exponential layer is exactly beta * H
/// (the ozone tent likewise integrates to its peak times its half width). At
/// these levels - a full Ker is 2.7e-5 of the noon sun - the multiple
/// scattering term is orders below the floor and is dropped.
fn moonScatter(dir: vec3f, r: f32, moonDir: vec4f, moonColor: vec4f,
               tauR: vec3f, tauM: vec3f, tauT: vec3f, survive: vec3f) -> vec3f {
  if (moonDir.y <= 0.0 || moonColor.w <= 0.001) { return vec3f(0.0); }
  let E = moonIrradiance(moonDir, moonColor) * viewTransmittance(r, moonDir.xyz);
  let mu = clamp(dot(dir, moonDir.xyz), -1.0, 1.0);
  let phase = (tauR * rayleighPhase(mu) + tauM * miePhase(mu, sky.mieAbsorb.w)) / tauT;
  return phase * survive * E;
}

/// Both moons' contribution to the sky itself. Gated on star visibility, so a
/// daylit frame pays nothing: the moon's scatter is 5 orders below the sun's
/// there anyway.
fn moonSkyGlow(dir: vec3f, r: f32) -> vec3f {
  let visibility = sky.starParams.x;
  if (visibility <= 0.002) { return vec3f(0.0); }

  let tauR = sky.rayleigh.rgb * sky.rayleigh.w;
  let tauM = sky.mieScatter.rgb * sky.mieScatter.w;
  let tauT = tauR + tauM + sky.mieAbsorb.rgb * sky.mieScatter.w
           + sky.ozone.rgb * sky.ozone.w;

  // Kasten-Young relative airmass - the same fit twinkle() uses, so a star and
  // the sky it sits in brighten toward the horizon together.
  let sinAlt = max(dir.y, 0.0);
  let altDeg = degrees(asin(clamp(sinAlt, 0.0, 1.0)));
  let airmass = min(1.0 / max(sinAlt + 0.50572 * pow(altDeg + 6.07995, -1.6364), 1e-3),
                    MOON_AIRMASS_MAX);
  let survive = vec3f(1.0) - exp(-tauT * airmass);

  var total = moonScatter(dir, r, sky.moon0Dir, sky.moon0Color, tauR, tauM, tauT, survive);
  total += moonScatter(dir, r, sky.moon1Dir, sky.moon1Color, tauR, tauM, tauT, survive);
  return total * visibility;
}

// ---------------------------------------------------------------------------
// Stars
// ---------------------------------------------------------------------------

/// 1D value noise in [-1, 1], for scintillation.
fn noise1(x: f32) -> f32 {
  let i = floor(x);
  let f = x - i;
  let u = f * f * (3.0 - 2.0 * f);
  return mix(hash11(i), hash11(i + 1.0), u) * 2.0 - 1.0;
}

/// Atmospheric scintillation as a log-normal intensity fluctuation, which is
/// the correct statistics for scintillation (the intensity is the exponential
/// of a roughly Gaussian phase perturbation). Amplitude is driven by airmass,
/// so a star at the zenith is rock steady and one at 10 deg altitude flickers
/// hard - exactly what the eye expects.
fn twinkle(altitude: f32, phase: f32, chroma: f32) -> f32 {
  let sinAlt = max(altitude, 0.0);
  let altDeg = degrees(asin(clamp(sinAlt, 0.0, 1.0)));
  let airmass = 1.0 / max(sinAlt + 0.50572 * pow(altDeg + 6.07995, -1.6364), 1e-3);
  let amp = clamp(0.18 * pow(max(airmass - 1.0, 0.0), 0.60), 0.0, 0.55)
          * (1.0 + 1.4 * sky.starParams.y);
  let t = sky.starParams.z;
  let ph = phase + chroma;
  let s = amp * (0.55 * noise1(t * 3.5 + ph)
               + 0.30 * noise1(t * 7.1 + ph * 2.3)
               + 0.15 * noise1(t * 13.3 + ph * 5.1));
  return exp(s);
}

/// Every star in the bucket the view direction falls into.
///
/// A fullscreen shader cannot iterate 3,800 stars per pixel, so the CPU sorts
/// them into a 96x48 equal-area celestial grid (uniform in azimuth, uniform in
/// sin(declination)) and inserts each star into every cell within its point
/// spread. That makes the per-pixel cost one bucket read plus, on average,
/// 0.8 star evaluations - and it stays correct at the poles, where the
/// insertion pass simply duplicates the handful of stars there across the
/// azimuthal ring.
fn starField(dir: vec3f, cel: vec3f) -> vec3f {
  let visibility = sky.starParams.x;
  if (visibility <= 0.002 || dir.y < -0.05) { return vec3f(0.0); }

  let v = saturate(cel.y * 0.5 + 0.5);
  let az = atan2(cel.z, cel.x);
  let u = fract(az * (0.5 * INV_PI) + 0.5);
  let cu = min(u32(u * f32(STAR_GRID_U)), STAR_GRID_U - 1u);
  let cv = min(u32(v * f32(STAR_GRID_V)), STAR_GRID_V - 1u);
  let bucket = starCells[cv * STAR_GRID_U + cu];

  let apx = angularPixelSize();
  let sigma = STAR_PSF_SIGMA * apx;
  let invTwoSigmaSq = 1.0 / (2.0 * sigma * sigma);
  let right = frame.cameraRight.xyz;
  let up = frame.cameraUp.xyz;

  // The Gaussian core is dead by 8 sigma; the spikes reach the full padded
  // radius. Taking the larger of the two, capped at the contract radius, keeps
  // the inner loop cheap for the ~3,780 stars that have no spike.
  let coreReach = min(sigma * 8.0, STAR_MAX_ANGLE);
  let spikeReach = STAR_MAX_ANGLE;
  let invMaxAngle2 = 1.0 / (STAR_MAX_ANGLE * STAR_MAX_ANGLE);

  var total = vec3f(0.0);
  for (var i = 0u; i < bucket.y; i++) {
    let s = stars[bucket.x + i];
    let delta = cel - s.dirMag.xyz;
    let ang2 = dot(delta, delta);          // theta^2 to within 1e-6 at these scales
    let mag = s.dirMag.w;
    let spiked = mag < STAR_SPIKE_MAG;
    let reach = select(coreReach, spikeReach, spiked);
    if (ang2 > reach * reach) { continue; }

    let peak = STAR_PEAK_M0 * exp(-STAR_MAG_DECAY * mag);
    var intensity = peak * exp(-ang2 * invTwoSigmaSq);

    // Diffraction cross for the brightest stars: the lens the player is
    // looking through, at 22.5 deg to the screen axes.
    if (spiked) {
      // The catalogue is in CELESTIAL space and `dir` is in world space, so the
      // star has to be rotated into world space before it can be projected onto
      // the screen basis. starRotation maps world -> celestial, so the inverse
      // is the row-vector product.
      let starWorld = s.dirMag.xyz * sky.starRotation;
      let worldDelta = dir - starWorld * dot(dir, starWorld);
      let px = dot(worldDelta, right) / apx;
      let py = dot(worldDelta, up) / apx;
      let ca = 0.923880;
      let sa = 0.382683;
      let rx = px * ca - py * sa;
      let ry = px * sa + py * ca;
      let len = max((2.0 - mag) * 7.0, 1.0);
      let spike = exp(-abs(rx) / len) * exp(-ry * ry * 0.78)
                + exp(-abs(ry) / len) * exp(-rx * rx * 0.78);
      // Smooth window to exactly zero at STAR_MAX_ANGLE, with zero slope there.
      intensity += peak * spike * 0.06 * sqr(saturate(1.0 - ang2 * invMaxAngle2));
    }

    // Chromatic scintillation: shifting the red and blue phases apart is what
    // makes a low bright star flash red and blue rather than just pulse.
    let base = s.colorPhase.rgb * intensity;
    total += vec3f(base.r * twinkle(dir.y, s.colorPhase.w, 0.31),
                   base.g * twinkle(dir.y, s.colorPhase.w, 0.0),
                   base.b * twinkle(dir.y, s.colorPhase.w, -0.31));
  }

  return total * visibility;
}

/// Moonless-night sky floor, before SKY.AIRGLOW scales it.
///
/// It was vec3(0.42, 0.72, 0.55) - green-dominant, and since the sky-view LUT
/// is zero at night it WAS the night sky: the final image measured B/R 0.57 to
/// 0.92, an olive cast over everything. This is the hue of TIME_KEYS' own
/// midnight sky ([0.0016, 0.0030, 0.0072] normalised), so the floor, the
/// ambient probe and the moonlight scattering now agree on what colour night is.
///
/// MIRRORED as CLOUD_NIGHT_FLOOR_HUE in pass/clouds.wgsl, which needs it to
/// light the deck by the same sky the camera sees. There is no spare Sky
/// uniform slot to carry it in, so tools/test-sky.mjs section 5c parses both
/// files and fails if the two ever drift.
const NIGHT_FLOOR_HUE : vec3f = vec3f(0.22, 0.42, 1.00);

/// The galaxy ("the Spill") and the airglow background. A great circle
/// inclined to the celestial equator, its brightness a 3-octave fbm in a
/// band-local coordinate, gated by a Gaussian in band latitude and cut by dark
/// lanes from a second fbm.
fn galacticBackground(dir: vec3f, cel: vec3f) -> vec3f {
  let visibility = sky.starParams.x;
  if (visibility <= 0.002) { return vec3f(0.0); }

  // Band normal in celestial space: 62 deg to the equator, node at RA 34 deg.
  let bandNormal = vec3f(-0.49382, 0.46947, -0.73146);
  let bandLat = asin(clamp(dot(cel, bandNormal), -1.0, 1.0));
  let envelope = exp(-sqr(bandLat / 0.115));

  var galaxy = vec3f(0.0);
  if (envelope > 0.002) {
    let clouds = saturate(to01(fbmCheap3(cel * 5.5, 0x5b17u)) * 1.35);
    let lanes = pow(saturate(to01(fbmCheap3(cel * 11.0, 0x91c3u)) + 0.25), 2.2);
    galaxy = vec3f(0.86, 0.90, 1.00) * envelope * clouds * lanes * sky.starParams.w;
  }

  // The floor: a faint uniform emission with a horizon brightening, and a slow
  // modulation so a long look at the night sky is never completely static.
  let horizonLift = 1.0 + 0.9 * exp(-max(dir.y, 0.0) / 0.14);
  let pulse = 1.0 + 0.12 * sin(sky.starParams.z * 0.025);
  let airglow = NIGHT_FLOOR_HUE * sky.skyParams.w * horizonLift * pulse;

  return (galaxy + airglow) * visibility;
}

// ---------------------------------------------------------------------------
// Sky
// ---------------------------------------------------------------------------

@fragment
fn fs_sky(in: FSOut) -> @location(0) vec4f {
  let dir = fsViewRay(in.uv);
  let r0 = skyGroundRadius() + cameraAltitude();

  // The sky-view LUT already contains its own transmittance. Everything else
  // in this shader sits OUTSIDE the atmosphere, so it all shares one lookup -
  // which is also what makes the sun redden and the stars dim near the horizon
  // without a single hand-authored curve.
  let celestial = sky.starRotation * dir;
  let T = viewTransmittance(r0, dir);

  var beyond = sunDisc(dir);
  beyond += moonDisc(dir, sky.moon0Dir.xyz, sky.moon0Dir.w, sky.moon0Color.rgb, 0x4d31u);
  beyond += moonDisc(dir, sky.moon1Dir.xyz, sky.moon1Dir.w, sky.moon1Color.rgb, 0x9a07u);
  beyond += starField(dir, celestial);
  beyond += galacticBackground(dir, celestial);

  // The moon glow is scattered INSIDE the atmosphere, so it is added alongside
  // the sky-view LUT and not through T like everything beyond it.
  return vec4f(sampleSkyView(dir, r0) + moonSkyGlow(dir, r0) + beyond * T, 1.0);
}

// ---------------------------------------------------------------------------
// Aerial perspective
// ---------------------------------------------------------------------------

/// Distance from the camera to the surface at this pixel, and its world
/// height. Returns distance <= 0 when there is nothing to fog.
struct SurfaceHit {
  distance : f32,
  height   : f32,
};

fn surfaceHit(in: FSOut, dir: vec3f) -> SurfaceHit {
  var hit: SurfaceHit;
  hit.distance = 0.0;
  hit.height = 0.0;

  let ndcDepth = textureLoad(sceneDepthTex, fsPixelCoord(in.pos), 0);
  if (ndcDepth <= 0.0) { return hit; }        // reverse-Z: 0 is the far plane

  // linearizeDepth gives distance along the view AXIS; the ray is longer off
  // centre by exactly 1/cos, and at a 74 deg FOV that is 30% at the corners.
  let axial = linearizeDepth(ndcDepth, nearPlane());
  let cosAxis = max(dot(dir, frame.cameraFwd.xyz), 1e-3);
  hit.distance = axial / cosAxis;
  hit.height = frame.worldOrigin.y + frame.cameraPos.y + dir.y * hit.distance;
  return hit;
}

/// Aerial perspective is an AIR phenomenon. Below the waterline the medium is
/// water and common/water.wgsl owns it, so fade the term out as the shaded
/// point sinks - over 4 m, which is short enough to be invisible and long
/// enough not to alias along a shoreline.
fn aerialFor(in: FSOut) -> Aerial {
  let dir = fsViewRay(in.uv);
  let hit = surfaceHit(in, dir);
  var result: Aerial;
  result.transmittance = vec3f(1.0);
  result.inScatter = vec3f(0.0);
  if (hit.distance <= 0.0) { return result; }

  let above = saturate(hit.height / 4.0 + 1.0);
  if (above <= 0.0) { return result; }

  let ap = aerialPerspective(cameraAltitude(), dir, hit.distance);
  result.transmittance = mix(vec3f(1.0), ap.transmittance, above);
  result.inScatter = ap.inScatter * above;
  return result;
}

/// Draw 1 of 2: dst *= T. Blend.multiply, so the returned rgb IS the factor.
@fragment
fn fs_aerialExtinction(in: FSOut) -> @location(0) vec4f {
  return vec4f(aerialFor(in).transmittance, 1.0);
}

/// Draw 2 of 2: dst += S. Blend.additive.
@fragment
fn fs_aerialInScatter(in: FSOut) -> @location(0) vec4f {
  return vec4f(aerialFor(in).inScatter, 0.0);
}
