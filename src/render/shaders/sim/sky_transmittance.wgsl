// SUBWAVE - transmittance LUT (256 x 64, rgba16float).
//
// T(r, mu) = exp(-integral of the extinction coefficient from radius r along
// cos-zenith mu out to the top of the atmosphere). Every other atmosphere pass
// reads this instead of re-integrating, which is the whole reason the sky is
// affordable: the sky-view march needs the sun-path transmittance at every one
// of its samples, and that is a nested integral we refuse to pay for twice.
//
// Recomputed only when turbidity changes (weather), not per frame.

#define SKY_GROUP 0

#include "../common/atmosphere.wgsl"

@group(0) @binding(1) var transmittanceOut : texture_storage_2d<rgba16float, write>;

/// Optical depth along the ray to the atmosphere boundary.
///
/// Midpoint rule on QUADRATICALLY spaced segment edges, so the steps are fine
/// where the air is dense and coarse where it is thin. That distribution is not
/// cosmetic: the aerosol scale height is 1,200 m and a vertical path is 100 km
/// long, so 40 UNIFORM steps put two samples inside the entire Mie layer and
/// overestimate the vertical optical depth by 10% (measured against a 200,000
/// step reference: 10.0% red / 5.3% green / 3.3% blue). The same 40 quadratic
/// midpoint steps hold every direction under 0.4%.
fn opticalDepth(r: f32, mu: f32) -> vec3f {
  let Rg = skyGroundRadius();
  let dist = distanceToTop(r, mu);
  var sum = vec3f(0.0);
  var prevEdge = 0.0;

  for (var i = 1; i <= SKY_TRANSMITTANCE_STEPS; i++) {
    let edge = dist * sqr(f32(i) / f32(SKY_TRANSMITTANCE_STEPS));
    let dt = edge - prevEdge;
    let t = prevEdge + dt * 0.5;
    prevEdge = edge;
    // Law of cosines along the ray: exact, and avoids building a 3D position.
    let ri = sqrt(max(t * t + 2.0 * r * mu * t + r * r, Rg * Rg));
    sum += sampleMedium(ri - Rg).extinction * dt;
  }
  return sum;
}

@compute @workgroup_size(8, 8, 1)
fn cs_transmittance(@builtin(global_invocation_id) gid: vec3u) {
  let size = vec2u(u32(SKY_TRANSMITTANCE_W), u32(SKY_TRANSMITTANCE_H));
  if (gid.x >= size.x || gid.y >= size.y) { return; }

  let uv = (vec2f(gid.xy) + vec2f(0.5)) / vec2f(size);
  let params = transmittanceParams(uv);
  let T = exp(-opticalDepth(params.x, params.y));
  textureStore(transmittanceOut, gid.xy, vec4f(T, 1.0));
}
