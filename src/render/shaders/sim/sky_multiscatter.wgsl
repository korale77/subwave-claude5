// SUBWAVE - multiple-scattering LUT (32 x 32, rgba16float).
//
// Single scattering alone gives a sky that is far too dark near the horizon at
// sunset and a completely black one under overcast turbidity, because most of
// the light reaching the eye from a thick air path has bounced more than once.
// Bruneton's original scheme stores four orders in a 4D table; Hillaire's
// observation is that from the second order on, the light field is close
// enough to isotropic that one 2D table plus the geometric series
//
//     L_ms_total = L_2nd * 1 / (1 - f_ms)
//
// captures the rest to within a few percent. f_ms is the fraction of light
// scattered at a point that finds its way back to that point after one more
// bounce, so the series is exactly the "every further bounce keeps f_ms of the
// energy" argument.
//
// Parameterised by (cos sun-zenith, altitude) only - NOT by view direction,
// because the term is isotropic by construction. It therefore does not change
// as the sun moves and is rebuilt only when turbidity changes.

#define SKY_GROUP 0
#define SKY_HAS_LUTS

#include "../common/atmosphere.wgsl"

@group(0) @binding(3) var multiScatterOut : texture_storage_2d<rgba16float, write>;

/// 1/(4 PI): the phase function of an isotropic scatterer, which is what the
/// second-order field is approximated as.
const UNIFORM_PHASE : f32 = 0.0795774715;

struct Gathered {
  luminance : vec3f,   // second-order in-scattered radiance along this ray
  transfer  : vec3f,   // f_ms integrand: scattering that will bounce again
};

/// March one direction from a point at radius `r` on the local +y axis.
fn gatherDirection(r: f32, sunDir: vec3f, dir: vec3f) -> Gathered {
  let Rg = skyGroundRadius();
  let origin = vec3f(0.0, r, 0.0);
  let mu = dir.y;

  let hitsGround = rayHitsGround(r, mu);
  let tMax = select(distanceToTop(r, mu), distanceToGround(r, mu), hitsGround);
  let dt = tMax / f32(SKY_MS_STEPS);

  var throughput = vec3f(1.0);
  var luminance = vec3f(0.0);
  var transfer = vec3f(0.0);

  for (var i = 0; i < SKY_MS_STEPS; i++) {
    let p = origin + dir * ((f32(i) + 0.5) * dt);
    let ri = max(length(p), Rg);
    let m = sampleMedium(ri - Rg);
    let up = p / ri;
    let muS = clamp(dot(up, sunDir), -1.0, 1.0);

    let stepT = exp(-m.extinction * dt);
    let invSigma = 1.0 / max(m.extinction, vec3f(1e-9));

    // Second order: sunlight scattered once at this sample, isotropically.
    let scattering = m.scatterR + m.scatterM;
    let source = scattering * UNIFORM_PHASE * sunTransmittance(ri, muS) * sky.solarIrradiance.rgb;
    luminance += throughput * (source - source * stepT) * invSigma;

    // Transfer: the same integral with the sun term removed. Dimensionless.
    transfer += throughput * (scattering - scattering * stepT) * invSigma;

    throughput *= stepT;
  }

  if (hitsGround) {
    let p = origin + dir * tMax;
    let up = p / max(length(p), Rg);
    let muS = clamp(dot(up, sunDir), -1.0, 1.0);
    // Lambertian ground, so albedo/PI, and the cosine at the ground point.
    luminance += throughput * sky.ground.rgb * INV_PI * max(muS, 0.0)
               * sunTransmittance(Rg, muS) * sky.solarIrradiance.rgb;
  }

  var g: Gathered;
  g.luminance = luminance;
  g.transfer = transfer;
  return g;
}

@compute @workgroup_size(8, 8, 1)
fn cs_multiscatter(@builtin(global_invocation_id) gid: vec3u) {
  let size = u32(SKY_MS_SIZE);
  if (gid.x >= size || gid.y >= size) { return; }

  let uv = (vec2f(gid.xy) + vec2f(0.5)) / vec2f(f32(size));
  let muS = clamp(unitFromTexCoord(uv.x, SKY_MS_SIZE) * 2.0 - 1.0, -1.0, 1.0);
  let alt = unitFromTexCoord(uv.y, SKY_MS_SIZE) * (skyTopRadius() - skyGroundRadius());
  let r = skyGroundRadius() + alt;
  // Local frame: up is +y, and the sun is placed in the xy plane at the
  // requested zenith angle. Azimuth is irrelevant to an isotropic quantity.
  let sunDir = vec3f(sqrt(max(1.0 - muS * muS, 0.0)), muS, 0.0);

  var luminance = vec3f(0.0);
  var transfer = vec3f(0.0);

  // Uniform directions on the sphere: theta uniform in [0,2PI), cos(phi)
  // uniform in [-1,1]. Stratified 8x8 rather than random, so the LUT is
  // deterministic and free of the low-frequency blotching a random set gives
  // at only 64 samples.
  for (var i = 0; i < SKY_MS_DIRECTIONS; i++) {
    for (var j = 0; j < SKY_MS_DIRECTIONS; j++) {
      let randA = (f32(i) + 0.5) / f32(SKY_MS_DIRECTIONS);
      let randB = (f32(j) + 0.5) / f32(SKY_MS_DIRECTIONS);
      let theta = TAU * randA;
      let phi = acos(1.0 - 2.0 * randB);
      let sp = sin(phi);
      let dir = vec3f(cos(theta) * sp, cos(phi), sin(theta) * sp);

      let g = gatherDirection(r, sunDir, dir);
      luminance += g.luminance;
      transfer += g.transfer;
    }
  }

  let invCount = 1.0 / f32(SKY_MS_DIRECTIONS * SKY_MS_DIRECTIONS);
  let secondOrder = luminance * invCount;
  let fms = transfer * invCount;

  // Geometric series for every further bounce. fms is physically < 1; the
  // clamp only guards against a pathological turbidity making it round up.
  let psi = secondOrder / max(vec3f(1.0) - min(fms, vec3f(0.98)), vec3f(0.02));
  textureStore(multiScatterOut, gid.xy, vec4f(psi, 1.0));
}
