// SUBWAVE - sky-view LUT (256 x 128, rgba16float), rebuilt every frame.
//
// Radiance of the sky for every direction, in a frame anchored to the sun's
// azimuth: u folds |azimuth - sunAzimuth| into [0, PI] (the atmosphere is
// mirror-symmetric about the sun/zenith plane), v is the sqrt-warped zenith
// angle from DESIGN 03.8.3 that piles resolution onto the horizon.
//
// 256x128 texels x <=48 steps is ~1.5 M samples: cheaper than raymarching the
// atmosphere per pixel by two orders of magnitude, and the field is smooth
// enough that the interpolation error is invisible next to the sun disc, which
// is drawn analytically and never comes from here.

#define SKY_GROUP 0
#define SKY_HAS_LUTS
#define SKY_HAS_MULTISCATTER

#include "../common/atmosphere.wgsl"

@group(0) @binding(4) var skyViewOut : texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn cs_skyview(@builtin(global_invocation_id) gid: vec3u) {
  let size = vec2u(u32(SKY_VIEW_W), u32(SKY_VIEW_H));
  if (gid.x >= size.x || gid.y >= size.y) { return; }

  let uv = (vec2f(gid.xy) + vec2f(0.5)) / vec2f(size);
  let Rg = skyGroundRadius();
  let r0 = skyViewerRadius();
  let dir = skyViewDir(uv, r0);
  let sunDir = sky.sunDir.xyz;

  let mu = clamp(dir.y, -1.0, 1.0);
  let hitsGround = rayHitsGround(r0, mu);
  let tMax = select(distanceToTop(r0, mu), distanceToGround(r0, mu), hitsGround);

  // More steps within a few degrees of the horizon, where the path length
  // through the dense lower atmosphere changes fastest with angle.
  let horizonWeight = saturate(1.0 - abs(mu) * 8.0);
  let steps = i32(mix(f32(SKY_VIEW_STEPS_MIN), f32(SKY_VIEW_STEPS_MAX), horizonWeight));

  let muSun = clamp(dot(dir, sunDir), -1.0, 1.0);
  let phaseR = rayleighPhase(muSun);
  let phaseM = miePhase(muSun, sky.mieAbsorb.w);

  let origin = vec3f(0.0, r0, 0.0);
  var throughput = vec3f(1.0);
  var radiance = vec3f(0.0);
  var prevEdge = 0.0;

  for (var i = 0; i < steps; i++) {
    // Quadratic step edges: fine near the camera, coarse far away. For an
    // upward ray that tracks the exponential density; for a near-horizontal
    // one it tracks the fact that the far half of a 600 km path sits in air
    // three scale heights thinner than the near half.
    let edge = tMax * sqr(f32(i + 1) / f32(steps));
    let dt = edge - prevEdge;
    let p = origin + dir * (prevEdge + dt * 0.5);
    prevEdge = edge;

    let ri = max(length(p), Rg);
    let m = sampleMedium(ri - Rg);
    let muS = clamp(dot(p / ri, sunDir), -1.0, 1.0);

    let single = (m.scatterR * phaseR + m.scatterM * phaseM)
               * sunTransmittance(ri, muS) * sky.solarIrradiance.rgb;
    let multi = (m.scatterR + m.scatterM) * sampleMultiScatter(ri, muS);
    let source = single + multi;

    let stepT = exp(-m.extinction * dt);
    radiance += throughput * (source - source * stepT) / max(m.extinction, vec3f(1e-9));
    throughput *= stepT;
  }

  if (hitsGround) {
    // The "ground" here is open ocean, whose albedo is in SKY.GROUND_ALBEDO.
    // Without it the sea-facing half of the LUT is pure black and any pixel
    // the ocean mesh does not cover reads as a hole.
    let p = origin + dir * tMax;
    let up = p / max(length(p), Rg);
    let muS = clamp(dot(up, sunDir), -1.0, 1.0);
    radiance += throughput * sky.ground.rgb * INV_PI * max(muS, 0.0)
              * sunTransmittance(Rg, muS) * sky.solarIrradiance.rgb;
  }

  textureStore(skyViewOut, gid.xy, vec4f(radiance, 1.0));
}
