// SUBWAVE - clustered light culling.
//
// One invocation per cluster. Each builds the cluster's view-space AABB, tests
// every light's bounding sphere against it, and writes the surviving indices
// into a flat list that lighting.wgsl walks.
//
// Testing a sphere against an AABB (rather than against the six frustum planes
// of the cluster) is both cheaper and TIGHTER at the corners: plane tests
// accept spheres that sit just outside a corner but on the inner side of every
// plane, which at 24 depth slices adds up to a lot of wasted per-pixel work.

// NOTE: this pass deliberately does NOT include frame.wgsl. That header claims
// all of @group(0) for the per-frame bindings, and this compute pass wants its
// own tightly-scoped group 0 (params + lights + the two cluster buffers) so it
// can run before the frame bind group is even bound. The one Frame value it
// needs - the view matrix - is therefore passed explicitly in ClusterParams.
#include "../common/math.wgsl"

struct ClusterParams {
  view            : mat4x4f,
  near            : f32,
  far             : f32,
  logFarOverNear  : f32,
  lightCount      : f32,
  tanHalfFov      : f32,
  aspect          : f32,
  maxPerCluster   : f32,
  pad             : f32,
};

// Mirrors `struct Light` in common/frame.wgsl. Kept in sync by hand; the byte
// layout is asserted by tools/test-layout.mjs. This pass reads only
// positionRange, but the struct must still be declared in full or the stride is
// wrong and every index past the first reads the wrong light.
struct Light {
  positionRange  : vec4f,
  colorIntensity : vec4f,
  direction      : vec4f,
  spotParams     : vec4f,
  shape          : vec4f,
};

@group(0) @binding(0) var<uniform> params : ClusterParams;
@group(0) @binding(1) var<storage, read> lights : array<Light>;
@group(0) @binding(2) var<storage, read_write> clusterRanges : array<vec2u>;
@group(0) @binding(3) var<storage, read_write> clusterIndices : array<u32>;

/// View-space Z at the near edge of a slice, THE WAY THE CULL PASS WAS FED IT.
/// Kept for CLUSTER_CULL_UNION = 0, which reproduces the previous image.
fn sliceToViewZParams(slice: f32) -> f32 {
  return params.near * exp(slice * params.logFarOverNear / f32(CLUSTER_Z));
}

/// View-space Z at the near edge of a slice on the RECEIVER's grid, for one
/// medium. Inverse of clusterSliceFromViewDepth() in common/lighting.wgsl:
/// slice = log(z / CLUSTER_NEAR) * CLUSTER_Z / log(far / CLUSTER_NEAR).
///
/// THE PARAMS GRID IS NOT THAT GRID AND NEVER WAS. passes/clusters.js writes
/// `near = cam.near` (0.08 m) and `far = MAX_VIEW_DISTANCE` (4000 m); the
/// receiver slices 0.25 m .. 140 m submerged and 0.25 m .. 640 m in air. The two
/// agree only at slice 0, so a fragment reads a list built for a different slab:
/// measured, submerged, a fragment at 5 m reads the 11.4-17.9 m slab, at 20 m
/// the 108.7-170.5 m slab, at 40 m the 420-659 m slab. Only a light whose
/// bounding sphere is large enough to reach the wrong slab survives, which is
/// why the vessel's 165 m floods mostly worked and nothing small ever did. The
/// three constants below mirror common/lighting.wgsl:32-37 by hand, exactly as
/// `struct Light` above mirrors frame.wgsl, and for the same reason: this pass
/// cannot include frame.wgsl without giving up its own group 0.
fn sliceToViewZReceiver(slice: f32, far: f32) -> f32 {
  return CULL_NEAR * exp(slice * log(far / CULL_NEAR) / f32(CLUSTER_Z));
}

/// The slice's z bounds, as the UNION over both media.
///
/// The receiver's far plane switches with the LATCHED underwater flag, and this
/// pass has no frame uniform to read it from. A union is conservative in the one
/// direction that is safe: it can only offer a cluster MORE lights than it
/// needs, so the receiver's list is a superset of the correct one in either
/// medium, and a light is never missing. CULL_FAR_WATER < CULL_FAR_AIR, so the
/// water grid is the shallower of the two at every index and the union is simply
/// [water near edge, air far edge].
///
/// The three CULL_* defines come from renderer.js out of RENDER.CLUSTER_NEAR /
/// CLUSTER_FAR_AIR / CLUSTER_FAR_WATER. They are NOT named CLUSTER_NEAR and so
/// on because the preprocessor substitutes whole words across every module, and
/// a global `CLUSTER_NEAR` macro would rewrite common/lighting.wgsl's own
/// `const CLUSTER_NEAR : f32 = 0.25;` declaration into a syntax error.
fn sliceBounds(slice: f32) -> vec2f {
  if (CLUSTER_CULL_UNION == 0) {
    return vec2f(sliceToViewZParams(slice), sliceToViewZParams(slice + 1.0));
  }
  return vec2f(sliceToViewZReceiver(slice, CULL_FAR_WATER),
               sliceToViewZReceiver(slice + 1.0, CULL_FAR_AIR));
}

/// Squared distance from a point to an AABB, 0 when inside.
fn sqrDistPointAABB(p: vec3f, bmin: vec3f, bmax: vec3f) -> f32 {
  let d = max(max(bmin - p, vec3f(0.0)), p - bmax);
  return dot(d, d);
}

@compute @workgroup_size(4, 4, 4)
fn cs_cluster_cull(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= u32(CLUSTER_X) || gid.y >= u32(CLUSTER_Y) || gid.z >= u32(CLUSTER_Z)) {
    return;
  }

  let clusterIndex = (gid.z * u32(CLUSTER_Y) + gid.y) * u32(CLUSTER_X) + gid.x;
  let maxPer = u32(params.maxPerCluster);
  let base = clusterIndex * maxPer;

  // --- cluster bounds in VIEW space --------------------------------------
  // View space here is right-handed with -Z forward, so the frustum extends
  // toward negative Z. We work with positive depths and negate at the end.
  let zBounds = sliceBounds(f32(gid.z));
  let zNear = zBounds.x;
  let zFar  = zBounds.y;

  // Tile extents in NDC, then scaled to view space at each depth.
  let tileMinNdc = vec2f(
     (f32(gid.x)      / f32(CLUSTER_X)) * 2.0 - 1.0,
     (f32(gid.y)      / f32(CLUSTER_Y)) * 2.0 - 1.0);
  let tileMaxNdc = vec2f(
     (f32(gid.x + 1u) / f32(CLUSTER_X)) * 2.0 - 1.0,
     (f32(gid.y + 1u) / f32(CLUSTER_Y)) * 2.0 - 1.0);

  let scaleNear = vec2f(params.tanHalfFov * params.aspect, params.tanHalfFov) * zNear;
  let scaleFar  = vec2f(params.tanHalfFov * params.aspect, params.tanHalfFov) * zFar;

  // The cluster is a frustum slab, not a box; its AABB is the union of the
  // near and far rectangles.
  let nearMin = tileMinNdc * scaleNear;
  let nearMax = tileMaxNdc * scaleNear;
  let farMin  = tileMinNdc * scaleFar;
  let farMax  = tileMaxNdc * scaleFar;

  let bmin = vec3f(min(min(nearMin, nearMax), min(farMin, farMax)), -zFar);
  let bmax = vec3f(max(max(nearMin, nearMax), max(farMin, farMax)), -zNear);

  // --- cull ---------------------------------------------------------------
  var count = 0u;
  let n = u32(params.lightCount);

  for (var i = 0u; i < n; i = i + 1u) {
    if (count >= maxPer) { break; }

    let light = lights[i];
    let range = light.positionRange.w;
    if (range <= 0.0) { continue; }

    // Lights arrive in camera-relative WORLD space; transform to view space.
    let posView = (params.view * vec4f(light.positionRange.xyz, 1.0)).xyz;

    if (sqrDistPointAABB(posView, bmin, bmax) <= range * range) {
      clusterIndices[base + count] = i;
      count = count + 1u;
    }
  }

  clusterRanges[clusterIndex] = vec2u(base, count);
}
