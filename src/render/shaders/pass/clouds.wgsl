// SUBWAVE - volumetric clouds.
//
// A raymarched layer between SKY.CLOUD_BOTTOM and SKY.CLOUD_TOP, marched at
// half resolution with a 2x2 Bayer temporal schedule (one half-res pixel in
// four per frame, so one full-res pixel in sixteen) and reprojected from the
// previous frame for the rest.
//
// STEP BUDGET, stated because an unbounded cloud march is how a frame budget
// dies:
//   primary       40 steps looking up -> 72 near the horizon, hard maximum 72
//   disocclusion  24 steps (a pixel whose history reprojected off screen)
//   light march   5 steps toward EACH lit body, 70 m doubling to 1120 m
//                 (2,170 m total), plus one 1,200 m sample at 4 km for the far
//                 shadow. One body by day (the sun's transmittance is exactly
//                 zero once the planet is in the way, and the moons are gated
//                 off by star visibility), up to two by night.
//   early out     view transmittance < 0.01
//   empty skip    stride doubles after 4 consecutive empty samples and halves
//                 on re-entry, so open sky costs half a march
// At 1080p that is 960x540/4 = 130k primary rays x <=72 steps. The density
// function is three octaves of discrete-gradient noise (no transcendentals),
// and the detail octaves are only evaluated where the base shape is non-zero.
//
// The layer is intersected as two SPHERICAL SHELLS, not two planes. A flat
// slab puts the horizon cloud deck at infinity, which both blows the step
// budget and draws a hard line where the deck should curve away.

#define SKY_GROUP 1
#define SKY_HAS_LUTS
#define SKY_HAS_MULTISCATTER

#include "../common/fullscreen.wgsl"
#include "../common/atmosphere.wgsl"
#include "../common/noise.wgsl"

@group(1) @binding(4) var cloudSource : texture_2d<f32>;

const CLOUD_SEED_SHAPE  : u32 = 0x51ad33u;
const CLOUD_SEED_BILLOW : u32 = 0x2e9071u;
const CLOUD_SEED_DETAIL : u32 = 0x77c1b5u;

/// Metres -> noise units. 3,200 m of base shape is the size of one cumulus
/// cluster; 260 m of detail is the size of one cauliflower lobe.
const CLOUD_BASE_SCALE   : f32 = 1.0 / 3200.0;
const CLOUD_DETAIL_SCALE : f32 = 1.0 / 260.0;

/// Coverage -> density threshold, as a cubic in u = 1 - coverage.
///
/// `coverage` is the fraction of the SKY the deck fills, and this is what makes
/// that true. perlinWorley is strongly non-uniform - measured over 1,355,200
/// samples of the layer volume, mean 0.225, p50 0.210, p90 0.485, p99 0.679,
/// max 0.898 - so the textbook remap(pw, 1 - coverage, 1, 0, 1) asks for the
/// field's 99.99th percentile at coverage 0.10. Measured with that remap: of
/// 48,400 vertical columns through the deck at coverage 0.10, ZERO reached an
/// optical depth of 0.5, and the densest column in the whole field reached 1.0.
/// The GPU agreed - cloudHistoryA came back with meanAlpha 1.0000 and 0.01% of
/// pixels holding any cloud at all.
///
/// These coefficients are a least-worst fit to the measured inverse CDF of the
/// COLUMN statistic (a column counts as cloudy at tau > 0.5, i.e. it hides a
/// third of the sky behind it), refit to minimise the coverage error rather
/// than the threshold error. Measured after: coverage 0.10 -> 0.105 of the sky,
/// 0.20 -> 0.225, 0.45 -> 0.453, 0.70 -> 0.675, 1.00 -> 0.991, worst error
/// 0.035 over the whole range. The cubic is monotone on [0,1] (its derivative
/// 1.7322 - 5.3868u + 5.0286u^2 has a negative discriminant), so more coverage
/// is always more cloud.
const CLOUD_COVER_C0 : f32 = 1.7322;
const CLOUD_COVER_C1 : f32 = -2.6934;
const CLOUD_COVER_C2 : f32 = 1.6762;
/// Edge-to-core width in perlinWorley units. 0.16 puts the mean interior
/// density at 0.55 and the mean cloudy column at tau 17 - a real cumulus. The
/// old remap left the interior at 0.17 and the column at tau 1.0, which is why
/// the clouds were uniform white cotton wool with no shadowed underside.
const CLOUD_EDGE_WIDTH : f32 = 0.16;

/// Asymmetry of the dual-lobe cloud phase function.
///
/// NOT sky.mieAbsorb.w. That is the ATMOSPHERE's aerosol asymmetry, which the
/// weather system drives from 0.80 to 0.86 with turbidity - so the clouds' own
/// silver lining used to change with the haze, for no physical reason. Cloud
/// droplets are ~10 um and their asymmetry has nothing to do with the aerosol
/// load; 0.86 is the standard Mie value for that size at visible wavelengths.
const CLOUD_PHASE_G : f32 = 0.86;

/// Range over which the detail octave is faded out, metres.
///
/// Near the horizon the shell span over 72 steps gives dt ~= 208 m against a
/// CLOUD_DETAIL_SCALE feature size of 260 m, and the empty-skip stride doubles
/// that again - so the erosion is sampled below Nyquist and turns into crawling
/// mush. Past this distance the deck is a clean silhouette instead, which is
/// also what a real cloud 18 km away looks like.
const CLOUD_DETAIL_FADE : f32 = 18000.0;

const CLOUD_MAX_DISTANCE : f32 = 55000.0;
const CLOUD_STEPS_MIN    : i32 = 40;
const CLOUD_STEPS_MAX    : i32 = 72;
const CLOUD_STEPS_REPAIR : i32 = 24;
const CLOUD_LIGHT_STEPS  : i32 = 5;
const CLOUD_MIN_STEP     : f32 = 25.0;
const CLOUD_MAX_STEP     : f32 = 900.0;
/// View transmittance at which the march gives up. See the loop for why 0.03.
const CLOUD_MIN_TRANSMITTANCE : f32 = 0.03;

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/// Piecewise-linear height profile through knots at 0, 0.07, 0.20, 0.45, 0.75
/// and 1.0 of the layer (DESIGN 03.8.8).
fn cloudProfile(h: f32, k0: f32, k1: f32, k2: f32, k3: f32, k4: f32, k5: f32) -> f32 {
  if (h < 0.07) { return mix(k0, k1, h / 0.07); }
  if (h < 0.20) { return mix(k1, k2, (h - 0.07) / 0.13); }
  if (h < 0.45) { return mix(k2, k3, (h - 0.20) / 0.25); }
  if (h < 0.75) { return mix(k3, k4, (h - 0.45) / 0.30); }
  return mix(k4, k5, (h - 0.75) / 0.25);
}

/// Vertical density envelope. cloudType runs 0 = stratus, 0.5 = cumulus,
/// 1 = cumulonimbus, and the weather system drives it.
fn cloudGradient(h: f32, cloudType: f32) -> f32 {
  let stratus = cloudProfile(h, 0.0, 1.00, 1.00, 0.55, 0.10, 0.00);
  let cumulus = cloudProfile(h, 0.0, 0.20, 0.75, 1.00, 0.85, 0.00);
  let anvil = cloudProfile(h, 0.0, 0.35, 0.85, 1.00, 1.00, 0.30);
  return mix(mix(stratus, cumulus, saturate(cloudType * 2.0)),
             anvil, saturate(cloudType * 2.0 - 1.0));
}

fn cloudHeightFraction(altitude: f32) -> f32 {
  return (altitude - sky.cloudParams.x) / max(sky.cloudParams.y - sky.cloudParams.x, 1.0);
}

/// Base shape only: three octaves of gradient noise remapped by an inverted
/// second field. That inversion is what turns Perlin's smooth blobs into the
/// billowed, cauliflower silhouette a cumulus actually has - a plain fbm
/// thresholded at any level looks like fog, never like a cloud.
///
/// `worley3F1` would be the textbook choice for the billow term and is what
/// the offline reference uses, but it costs 27 cell tests; inside a march this
/// deep that is the difference between 0.6 ms and 4 ms, and 1 - |gradient| has
/// the same first-order statistics.
fn cloudBaseDensity(worldPos: vec3f, heightFrac: f32) -> f32 {
  // cloudWind.xy is how far the deck has travelled downwind; SUBTRACTING it
  // moves the pattern with the wind rather than against it.
  let drift = vec3f(sky.cloudWind.x, 0.0, sky.cloudWind.y);
  let q = (worldPos - drift) * CLOUD_BASE_SCALE;

  let shape = to01(fbmCheap3(q, CLOUD_SEED_SHAPE));
  let billow = 1.0 - abs(gradientQuick3(q * 2.7, CLOUD_SEED_BILLOW));
  let perlinWorley = saturate(remapClamped(shape, billow * 0.55 - 0.05, 1.0, 0.0, 1.0));

  // The threshold is the field's own inverse CDF, so `coverage` is a fraction
  // of the sky rather than a quantile of a distribution nobody measured. See
  // CLOUD_COVER_C0..C2.
  let u = 1.0 - saturate(sky.cloudParams.z);
  let thresh = max(u * (CLOUD_COVER_C0 + u * (CLOUD_COVER_C1 + u * CLOUD_COVER_C2)), 0.0);
  let shaped = remapClamped(perlinWorley, thresh, thresh + CLOUD_EDGE_WIDTH, 0.0, 1.0);
  return saturate(shaped * cloudGradient(heightFrac, sky.cloudShape.x));
}

/// Full density in 1/m, including the detail erosion. Only ever called where
/// cloudBaseDensity already returned something. `detailFade` scales the erosion
/// out with distance, where the marcher can no longer resolve it.
fn cloudDensity(worldPos: vec3f, heightFrac: f32, base: f32, detailFade: f32) -> f32 {
  if (detailFade <= 0.0) { return saturate(base) * sky.cloudParams.w; }
  let drift = vec3f(sky.cloudWind.x, 0.0, sky.cloudWind.y);
  // The detail layer drifts faster than the base, which reads as the cloud
  // evolving internally instead of sliding past like a decal.
  let detailP = (worldPos - drift * 1.6) * CLOUD_DETAIL_SCALE;
  let detail = to01(fbmCheap3(detailP, CLOUD_SEED_DETAIL));
  // Inverted at the base (wispy underside) and direct at the top (billowed
  // cauliflower), which is how convective cloud actually erodes.
  let erosion = mix(1.0 - detail, detail, saturate(heightFrac * 2.0));
  let strength = sky.cloudShape.z * detailFade;
  let eroded = remapClamped(base, erosion * strength * (1.0 - heightFrac), 1.0, 0.0, 1.0);
  return saturate(eroded) * sky.cloudParams.w;
}

// ---------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------

/// Optical depth toward a light. Five exponentially growing steps cover
/// 2,170 m - about one cloud diameter - and a single long sample at 4 km
/// catches the neighbouring cell that casts the long shadow across a deck.
///
/// `L` is the direction TO the light, so the sun and each moon share one
/// march. It is a parameter rather than sky.sunDir because a moonlit deck has
/// to be self-shadowed by the moon that lights it: reusing the sun's depth
/// would put the shadowed side of every cloud on the wrong face.
fn cloudLightDepth(worldPos: vec3f, L: vec3f) -> f32 {
  var depth = 0.0;
  var t = 0.0;
  var step = 70.0;
  for (var i = 0; i < CLOUD_LIGHT_STEPS; i++) {
    let p = worldPos + L * (t + step * 0.5);
    let h = cloudHeightFraction(p.y);
    if (h > 0.0 && h < 1.0) {
      depth += cloudBaseDensity(p, h) * sky.cloudParams.w * step;
    }
    t += step;
    step *= 2.0;
  }
  let far = worldPos + L * 4000.0;
  let hFar = cloudHeightFraction(far.y);
  if (hFar > 0.0 && hFar < 1.0) {
    depth += cloudBaseDensity(far, hFar) * sky.cloudParams.w * 1200.0;
  }
  return depth;
}

/// Dual-lobe Henyey-Greenstein: a strong forward lobe for the silver lining
/// and a weak backward one for the glow of a cloud lit from behind the camera.
fn cloudPhase(mu: f32, g: f32) -> f32 {
  let forward = miePhase(mu, g);
  let backward = miePhase(mu, -g * 0.42);
  return mix(forward, backward, 0.22);
}

/// Wrenninge's multi-octave approximation to multiple scattering inside the
/// cloud: three progressively wider, dimmer, less anisotropic copies of the
/// Beer term. Without it a thick cloud is a black silhouette; with it the core
/// stays luminous, which is most of what makes clouds read as clouds.
fn cloudLightTransmittance(opticalDepth: f32, mu: f32) -> f32 {
  var total = 0.0;
  var attenuation = 1.0;   // c^o
  var contribution = 1.0;  // b^o
  for (var o = 0; o < 3; o++) {
    total += attenuation * exp(-opticalDepth * contribution)
           * cloudPhase(mu, CLOUD_PHASE_G * attenuation);
    attenuation *= 0.5;
    contribution *= 0.5;
  }
  return total;
}

/// Powder (Schneider 2015): the darkening of a cloud edge seen along the light
/// direction, caused by the low probability of a photon scattering back out of
/// a thin slab. Without it, cloud edges look inflated and plastic.
///
/// It is a function of the optical depth toward the LIGHT, never of the step
/// length: sigma * ds would make the source term quadratic in ds, so a cloud
/// would change brightness with the marcher's step size - which varies 36x
/// between a vertical and a horizon ray and doubles again whenever the empty
/// skip widens the stride.
///
/// And it is a BACKSCATTER effect - it only exists looking down-light. Applied
/// at every angle it deletes the sunlit rim, which is the one thing that makes
/// a cloud read as a cloud: a fringe with base 0.02 gives lightDepth 0.063 and
/// powder 0.118, so 88% of the sun's contribution went exactly where the silver
/// lining should be. Frostbite dropped the term entirely for this reason;
/// weighting it by the view-light angle keeps the edge darkening it is for.
fn cloudPowder(lightDepth: f32, mu: f32) -> f32 {
  return mix(1.0, 1.0 - exp(-2.0 * lightDepth), saturate(0.5 - mu * 0.5));
}

/// Beam irradiance one moon delivers at the cloud layer, per channel.
///
/// The moon has no uniform slot of its own for this: it is RECONSTRUCTED from
/// the disc parameters, exactly as moonIrradiance() in pass/sky_render.wgsl
/// does, and the two must stay in step. sim/sky.js writes
/// `color.rgb = albedo * intensity / (solidAngle * 0.5)`, so multiplying back
/// by the solid angle and the Lommel-Seeliger half returns `albedo * intensity`
/// - and going through the albedo is a feature, because the light a moon casts
/// then carries its own tint.
///
/// It differs from moonIrradiance() in ONE term, deliberately: there is no
/// `max(moonDir.y, 0)` here. That factor projects the beam onto a HORIZONTAL
/// surface, which is what the ground receives and what env.moonIntensity
/// means; a cloud is lit by the beam itself, and `sunColor` - the term this one
/// is added alongside in marchClouds - is a beam irradiance. Mixing conventions
/// inside one radiative-transfer source would make a moon at 10 deg light the
/// deck at 17% of its true strength. The horizon is instead handled where it
/// belongs, by sunTransmittance: it is the real air mass toward the moon and
/// it returns exactly zero once the planet is in the way. At zenith the two
/// forms are identical, so the calibration of SKY.MOONS[].intensity is
/// untouched.
fn cloudMoonIrradiance(moonDir: vec4f, moonColor: vec4f, r: f32) -> vec3f {
  if (moonColor.w <= 0.001) { return vec3f(0.0); }
  let solidAngle = PI * moonDir.w * moonDir.w;
  return moonColor.rgb * solidAngle * 0.5 * pow(moonColor.w, 1.35)
       * sunTransmittance(r, moonDir.y);
}

/// Moonless-night sky floor, before sky.skyParams.w (SKY.AIRGLOW) scales it.
///
/// This MUST equal NIGHT_FLOOR_HUE in pass/sky_render.wgsl: it is the same
/// emission, read once by the sky the camera sees and once by the cloud hanging
/// in that sky. tools/test-sky.mjs section 5c parses both files and fails if
/// they drift, because there is no uniform slot left to carry it in and a
/// silent divergence would show up only as a deck the wrong colour at 3 a.m.
const CLOUD_NIGHT_FLOOR_HUE : vec3f = vec3f(0.22, 0.42, 1.00);

/// Mean radiance the NIGHT SKY adds to a cloud's ambient term.
///
/// `ambient` samples the sky-view LUT, which integrates the SUN alone and is
/// therefore exactly (0,0,0) after dusk - so at night the shadowed side of a
/// cloud had no light reaching it from anywhere and went to pure black.
///
/// It has BOTH halves of what pass/sky_render.wgsl actually draws as the night
/// sky, because the cloud is inside that sky and is lit by all of it. Leaving
/// the airglow floor out would make the deck darker than its own background for
/// no physical reason: measured against the live Sky uniform and the real
/// transmittance LUT at midnight, the floor is (1.76e-5, 3.36e-5, 8.00e-5) and
/// the moon term (1.31e-5, 2.46e-5, 4.91e-5), so the floor is 58% of the
/// ambient by luminance. Both are exactly zero by day.
///
/// The moon half is the same homogeneous-slab single-scattering closure
/// moonSkyGlow() evaluates per direction, averaged over the sphere: a phase
/// function integrates to 1/(4*PI) whatever its asymmetry, which removes the
/// view direction and the relative air mass together and leaves one value
/// hoisted per ray instead of a lookup per step. tau is then the plain VERTICAL
/// optical depth, and an exponential layer of coefficient beta and scale height
/// H integrates to exactly beta * H.
///
/// The airglow half is evaluated at the ZENITH, without galacticBackground()'s
/// horizon lift: that lift is a thickening of the emitting column toward the
/// horizon, and a deck at 1400-4200 m is looking through the thin part of it.
/// The 0.12 pulse is kept so the deck breathes with the sky rather than against
/// it. The galaxy is left out - it is a narrow band with a direction, and a
/// hemispherical mean of a band that covers 7% of the sky at
/// SKY.GALAXY_STRENGTH 0.0022 is 3.4e-5 of a term already an order below the
/// floor.
fn cloudNightAmbient(r: f32) -> vec3f {
  let visibility = sky.starParams.x;
  if (visibility <= 0.002) { return vec3f(0.0); }

  let tauR = sky.rayleigh.rgb * sky.rayleigh.w;
  let tauM = sky.mieScatter.rgb * sky.mieScatter.w;
  let tauT = tauR + tauM + sky.mieAbsorb.rgb * sky.mieScatter.w
           + sky.ozone.rgb * sky.ozone.w;

  let E = cloudMoonIrradiance(sky.moon0Dir, sky.moon0Color, r)
        + cloudMoonIrradiance(sky.moon1Dir, sky.moon1Color, r);
  // (sigma_s/sigma_t) * (1 - exp(-tau)) * E / (4*PI).
  let moon = ((tauR + tauM) / tauT) * (vec3f(1.0) - exp(-tauT)) * E * (0.25 * INV_PI);

  let pulse = 1.0 + 0.12 * sin(sky.starParams.z * 0.025);
  let airglow = CLOUD_NIGHT_FLOOR_HUE * sky.skyParams.w * pulse;

  return (moon + airglow) * visibility;
}

struct CloudResult {
  scattered     : vec3f,
  transmittance : f32,
  distance      : f32,
};

/// Entry and exit distance through the cloud shell, or exit <= entry on a miss.
///
/// The ground is a CLAMP on the exit, not an early reject: from 2 km up,
/// looking down at 30 degrees, the ray crosses the whole deck before it ever
/// reaches the sea, and rejecting on "this ray hits the ground" would delete
/// the cloud layer from every downward view out of the vessel.
fn cloudShell(viewerRadius: f32, dir: vec3f) -> vec2f {
  let miss = vec2f(0.0, -1.0);
  let origin = vec3f(0.0, viewerRadius, 0.0);
  let innerR = skyGroundRadius() + sky.cloudParams.x;
  let outerR = skyGroundRadius() + sky.cloudParams.y;
  let inner = raySphere(origin, dir, vec3f(0.0), innerR);
  let outer = raySphere(origin, dir, vec3f(0.0), outerR);
  if (outer.y <= 0.0) { return miss; }

  var t0 = 0.0;
  var t1 = outer.y;
  if (viewerRadius < innerR) {
    t0 = inner.y;                                   // up through the cloud base
  } else if (viewerRadius > outerR) {
    if (outer.x <= 0.0) { return miss; }            // above the deck, looking up
    t0 = outer.x;
    if (inner.x > 0.0) { t1 = inner.x; }
  } else if (inner.x > 0.0) {
    t1 = inner.x;                                   // inside, exiting downward
  }

  var limit = CLOUD_MAX_DISTANCE;
  if (rayHitsGround(viewerRadius, dir.y)) {
    limit = min(limit, distanceToGround(viewerRadius, dir.y));
  }
  t1 = min(t1, limit);
  if (t0 >= t1) { return miss; }
  return vec2f(t0, t1);
}

/// March the layer. `worldOrigin` is the camera in ABSOLUTE world space
/// (metres), because the noise field is anchored to the world and must not
/// slide when the renderer rebases.
fn marchClouds(worldOrigin: vec3f, dir: vec3f, maxSteps: i32, jitter: f32) -> CloudResult {
  var result: CloudResult;
  result.scattered = vec3f(0.0);
  result.transmittance = 1.0;
  result.distance = 0.0;

  let Rg = skyGroundRadius();
  let viewerRadius = Rg + max(worldOrigin.y, 0.0);
  let range = cloudShell(viewerRadius, dir);
  if (range.y <= range.x) { return result; }

  let span = range.y - range.x;
  let steps = min(maxSteps, i32(mix(f32(CLOUD_STEPS_MIN), f32(CLOUD_STEPS_MAX),
                                    sqr(1.0 - abs(dir.y)))));
  let dt = clamp(span / f32(steps), CLOUD_MIN_STEP, CLOUD_MAX_STEP);

  // Lighting constants, hoisted: they do not vary along the ray.
  let midRadius = Rg + (sky.cloudParams.x + sky.cloudParams.y) * 0.5;
  let mu = clamp(dot(dir, sky.sunDir.xyz), -1.0, 1.0);
  let sunColor = sky.solarIrradiance.rgb * sunTransmittance(midRadius, sky.sunDir.y);
  let sunLit = any(sunColor > vec3f(0.0));

  // MOONLIGHT. sunColor above is exactly (0,0,0) after dusk - sunTransmittance
  // returns zero once the planet is in the way - and the sky-view LUT that
  // feeds `ambient` is zero with it, so before this the deck had no light
  // source at all at night. Measured over the top third of a midnight frame at
  // cover 0.32, after 420 frames of temporal settle: the marched radiance p50
  // was exactly (0, 0, 0) and the composited pixel (5.4e-7, 8.9e-7, 1.7e-6),
  // against a clear-sky p50 of (4.0e-5, 6.6e-5, 1.2e-4). The cloud deck was
  // 70x DARKER than the sky it hung in, with two full moons overhead lighting
  // the beach. Same frame after: cloud p50 (3.4e-5, 4.9e-5, 8.2e-5) and p90
  // (1.4e-4, 1.4e-4, 1.7e-4) - a deck whose lit tops are 2.24x the sky's own
  // luminance, against 3.62x for the day frame that is the control.
  //
  // Gated on star visibility exactly as moonSkyGlow() is, so a daylit frame
  // pays nothing and the output is bit-identical to before sunset: the moons'
  // contribution there is five orders below the sun's and the extra light
  // march would be pure waste. Measured cost of the second march at midnight:
  // none that survives the noise - the light march only runs on steps where
  // sigma > 0, which is a small fraction of the 40-72 primary steps, and
  // clouds.march normalised against the fixed-cost clouds.composite in the
  // same frames went 2.20 (noon, one body) to 2.00 (midnight, two).
  let nightGate = sky.starParams.x;
  let moon0E = cloudMoonIrradiance(sky.moon0Dir, sky.moon0Color, midRadius) * nightGate;
  let moon1E = cloudMoonIrradiance(sky.moon1Dir, sky.moon1Color, midRadius) * nightGate;
  let moon0Lit = any(moon0E > vec3f(0.0));
  let moon1Lit = any(moon1E > vec3f(0.0));
  let mu0 = clamp(dot(dir, sky.moon0Dir.xyz), -1.0, 1.0);
  let mu1 = clamp(dot(dir, sky.moon1Dir.xyz), -1.0, 1.0);

  // The night sky is added to BOTH ambient endpoints rather than sampled per
  // direction: see cloudNightAmbient. Folding it in here keeps the per-step
  // cost of the night path identical to the day path.
  let nightAmbient = cloudNightAmbient(midRadius);
  let zenithSky = textureSampleLevel(skyLUT, linearClampSampler,
                                     skyViewUV(vec3f(0.0, 1.0, 0.0), viewerRadius), 0.0).rgb
                + nightAmbient;
  let groundSky = textureSampleLevel(skyLUT, linearClampSampler,
                                     skyViewUV(normalize(vec3f(dir.x, -0.35, dir.z)), viewerRadius), 0.0).rgb
                + nightAmbient;

  var t = range.x + jitter * dt;
  var stride = 1.0;
  var emptyRun = 0;
  var weightedDistance = 0.0;
  var weightSum = 0.0;

  for (var i = 0; i < steps; i++) {
    // 0.03, not 0.01. The remap calibration took a cloudy column from tau 1.0
    // to tau 17, so a ray now reaches 3% transmittance well inside the deck and
    // every step after that is spent behind something already opaque. The 2%
    // of background it lets through is below the quantisation of the rgba16float
    // it is composited into.
    if (t >= range.y || result.transmittance < CLOUD_MIN_TRANSMITTANCE) { break; }
    let ds = dt * stride;
    let sampleT = t + ds * 0.5;
    let p = vec3f(0.0, viewerRadius, 0.0) + dir * sampleT;
    let altitude = length(p) - Rg;
    let h = cloudHeightFraction(altitude);
    if (h <= 0.0 || h >= 1.0) { t += ds; continue; }

    // World position for the noise field: curvature-corrected altitude, flat
    // horizontal offset (the world is 6 km across; its curvature in XZ is
    // under a millimetre).
    let worldPos = vec3f(worldOrigin.x + dir.x * sampleT, altitude,
                         worldOrigin.z + dir.z * sampleT);
    let base = cloudBaseDensity(worldPos, h);
    if (base <= 0.0) {
      emptyRun++;
      if (emptyRun >= 4) { stride = 2.0; }
      t += ds;
      continue;
    }
    if (stride > 1.0) {
      // Re-entered cloud on a coarse stride: back up and refine rather than
      // integrate a step that is half empty.
      t = max(t - ds * 0.5, range.x);
      stride = 1.0;
      emptyRun = 0;
      continue;
    }
    emptyRun = 0;

    let sigma = cloudDensity(worldPos, h, base, saturate(1.0 - sampleT / CLOUD_DETAIL_FADE));
    if (sigma <= 0.0) { t += ds; continue; }

    // One light march per body that is actually lighting the deck. Every
    // condition here is a function of the Sky uniform alone, so the branches
    // are wave-uniform and cost nothing beyond the marches they skip.
    var source = mix(groundSky * 0.35, zenithSky * 0.85, h);
    if (sunLit) {
      let d = cloudLightDepth(worldPos, sky.sunDir.xyz);
      source += sunColor * cloudLightTransmittance(d, mu) * cloudPowder(d, mu);
    }
    if (moon0Lit) {
      let d = cloudLightDepth(worldPos, sky.moon0Dir.xyz);
      source += moon0E * cloudLightTransmittance(d, mu0) * cloudPowder(d, mu0);
    }
    if (moon1Lit) {
      let d = cloudLightDepth(worldPos, sky.moon1Dir.xyz);
      source += moon1E * cloudLightTransmittance(d, mu1) * cloudPowder(d, mu1);
    }
    let stepT = exp(-sigma * ds);
    result.scattered += result.transmittance * source * (1.0 - stepT);

    weightedDistance += sampleT * result.transmittance * (1.0 - stepT);
    weightSum += result.transmittance * (1.0 - stepT);
    result.transmittance *= stepT;
    t += ds;
  }

  result.distance = select(range.x, weightedDistance / max(weightSum, 1e-4), weightSum > 1e-4);
  return result;
}

// ---------------------------------------------------------------------------
// Half-resolution march with temporal reuse
// ---------------------------------------------------------------------------

/// 2x2 Bayer order: which of the four frames in the cycle updates this pixel.
fn bayerPhase(pixel: vec2u) -> u32 {
  let x = pixel.x & 1u;
  let y = pixel.y & 1u;
  return select(select(3u, 1u, x == 1u), select(0u, 2u, x == 1u), y == 0u);
}

@fragment
fn fs_cloudMarch(in: FSOut) -> @location(0) vec4f {
  let pixel = fsPixelCoord(in.pos);
  let dir = fsViewRay(in.uv);
  let camAbs = frame.worldOrigin.xyz + frame.cameraPos.xyz;
  let marchThisFrame = bayerPhase(pixel) == (frameIndex() & 3u);

  // Reproject the previous frame using the layer entry point, which is a
  // stable, march-independent proxy for where the cloud is. Using the marched
  // mean distance would be more accurate but is not available before marching,
  // which is the whole point of reprojecting.
  let viewerRadius = skyGroundRadius() + max(camAbs.y, 0.0);
  let shell = cloudShell(viewerRadius, dir);
  let proxy = select(4000.0, shell.x, shell.y > shell.x);
  let clip = frame.prevViewProj * vec4f(frame.cameraPos.xyz + dir * proxy, 1.0);
  var history = vec4f(0.0, 0.0, 0.0, 1.0);
  var historyValid = false;
  if (clip.w > 1e-4) {
    let ndc = clip.xy / clip.w;
    let prevUv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    if (all(prevUv > vec2f(0.0)) && all(prevUv < vec2f(1.0))) {
      history = textureSampleLevel(cloudSource, linearClampSampler, prevUv, 0.0);
      historyValid = true;
    }
  }

  if (!marchThisFrame && historyValid) { return history; }

  let jitter = blueNoise(pixel);
  let steps = select(CLOUD_STEPS_REPAIR, CLOUD_STEPS_MAX, marchThisFrame);
  let marched = marchClouds(camAbs, dir, steps, jitter);

  // Aerial perspective over the transmittance-weighted mean cloud distance.
  // The deck runs out to 55 km, where a third of the light is scattered out of
  // the beam; without this the horizon clouds sit in front of the haze they
  // should be dissolving into, and read as a hard bright band.
  var scattered = marched.scattered;
  if (marched.transmittance < 0.999) {
    let ap = aerialPerspective(max(camAbs.y, 0.0), dir, marched.distance);
    scattered = scattered * ap.transmittance + ap.inScatter * (1.0 - marched.transmittance);
  }

  let fresh = vec4f(scattered, marched.transmittance);
  if (!historyValid) { return fresh; }

  // A quarter of the pixels are refreshed each frame, so a feedback of 0.65
  // converges in ~10 frames while still rejecting the frame-to-frame noise the
  // jittered start offset introduces.
  return mix(history, fresh, 0.35);
}

@fragment
fn fs_cloudComposite(in: FSOut) -> @location(0) vec4f {
  let c = textureSampleLevel(cloudSource, linearClampSampler, in.uv, 0.0);
  // Premultiplied: rgb is already the in-scattered radiance, alpha is opacity.
  return vec4f(c.rgb, saturate(1.0 - c.a));
}
