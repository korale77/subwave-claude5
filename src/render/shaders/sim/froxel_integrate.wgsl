// SUBWAVE - volumetric integration (stage 2 of 2).
//
// One thread per screen column, marching all FROXEL_Z slices from the eye
// outward and writing the running integral into `froxelScatter`.
//
// ===========================================================================
// THE ENCODING CONTRACT, which common/water.wgsl already states from the
// consumer side and which this file has to honour exactly:
//
//   rgb = in-scattered radiance accumulated FROM THE EYE to this slice's
//         CENTRE, monotonically non-decreasing in w.
//   a   = transmittance of the medium THE FROXEL OWNS, to this slice.
//
//   applyFroxel(radiance, uv, viewDepth) = radiance * a + rgb
//
// The marine-snow loop in pass/underwater.wgsl differences two samples of rgb
// to recover the light present at one distance, so "pre-integrated from the
// eye" is not a style choice - a per-froxel (unintegrated) encoding could not
// produce that difference at all.
//
// ===========================================================================
// WHO OWNS WHAT, and why `a` is exactly 1.0
//
// CLAUDE.md's rule is that the medium is applied exactly ONCE per pixel. This
// volume is 160x90 froxels against a 1600x757 frame, so it must never be given
// a term that is already computed per pixel and analytically:
//
//   UNDERWATER        THE FROXEL OWNS the collimated solar beam's in-scatter (the
//                     god rays) and the punctual lamps' in-scatter, which the
//                     analytic model does not have at all. THE COMPOSITE KEEPS
//                     the per-pixel transmittance, the diffuse in-scatter and the
//                     deep tint (pass/underwater.wgsl). So the froxel owns no
//                     extinction here and `a` is exactly 1.0.
//   IN AIR            THE FROXEL OWNS THE WHOLE AERIAL MEDIUM for its four
//                     geometry consumers - terrain, entity, scatter, creature -
//                     because none of them applies any other air medium.
//                     aerialPerspective() lives on ocean_surface, sky_render and
//                     clouds, and those three deliberately do NOT consume this
//                     volume. So here `a` is the real accumulated transmittance.
//
// Writing 1.0 in air was a real bug and not a subtle one: in-scatter arrives with
// nothing to attenuate it, and at the shipped FOGBANK density (airFogSigma 4.1e-2
// against CLEAR's 1.4e-4, a 293x range) the beach blew out to flat white, +36.8%
// frame luminance, while the sea and sky beside it fogged correctly. FOGBANK is
// an ordinary weather state and the beach is where the player spawns.
//
// The invariant is written into the DATA rather than special-cased in the
// consumer, so `applyFroxel` stays branchless and a readback can check it:
// submerged, every slice must report a = 1.000000 exactly.
//
// The march still tracks the FULL local extinction internally, and it has to:
// in-scatter produced 30 m out is dimmed by the 30 m of water in front of it,
// and at REEF_TURQUOISE's sigma_t as then authored, [0.3039, 0.1210, 0.1031]
// (the 2026-08-17 clarity pass cut the row to [0.0873, 0.0871, 0.0742]; the
// argument is unchanged), that is a factor
// of 1.1e-4 in red against 4.6e-2 in blue over the same path. Dropping it would
// paint the far half of the volume onto the near half in the wrong colour.
//
// The single place the beam is REMOVED from the analytic model is the `source`
// line in waterInScatter() (common/water.wgsl), guarded by froxelOwnsBeam().

#include "../common/frame.wgsl"
#include "../common/math.wgsl"
#include "../common/water.wgsl"

@group(1) @binding(0) var densityIn  : texture_3d<f32>;
@group(1) @binding(1) var scatterOut : texture_storage_3d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn cs_froxel_integrate(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= u32(FROXEL_X) || gid.y >= u32(FROXEL_Y)) { return; }

  let dims = vec2f(f32(FROXEL_X), f32(FROXEL_Y));
  let uv = (vec2f(gid.xy) + 0.5) / dims;
  let travel = viewRayFromUV(uv, frame.cameraFwd.xyz, frame.cameraRight.xyz,
                             frame.cameraUp.xyz, frame.cameraFwd.w, frame.cameraRight.w);
  // Slab boundaries are in view DEPTH; the path length through a slab is longer
  // by 1/cos, up to 1.577x at the frame corner.
  let invCos = 1.0 / max(dot(travel, frame.cameraFwd.xyz), 1e-3);

  // The base extinction the stored density fraction scales. Per channel, and
  // this is sigma_t (beam extinction) - never Kd, which is the DEPTH
  // coefficient and would make everything crisp to the horizon.
  let baseSigma = select(vec3f(frame.fogParams.x), waterSightSigmaT(), isUnderwater());

  let invZ = 1.0 / f32(FROXEL_Z);
  var accum = vec3f(0.0);
  var throughput = vec3f(1.0);
  // TWO throughputs, because "how much light survives to here" and "how much of
  // that is the FROXEL'S to charge for" are different questions.
  //
  // `throughput` carries the FULL local extinction and weights every in-scatter
  // contribution, so haze 30 m out is still correctly dimmed by the medium in
  // front of it. `owned` carries only the extinction of the medium THIS VOLUME
  // OWNS, and it is what goes to .a.
  //
  // Underwater the froxel owns no extinction at all - the composite's
  // waterTransmittance() already applies the full path - so owned stays exactly
  // 1.0 and applyFroxel degenerates to `radiance + rgb`. In AIR it owns the whole
  // aerial medium for its four geometry consumers, because terrain, entity,
  // scatter and creature apply no other air medium (aerialPerspective lives on
  // ocean_surface, sky_render and clouds, which deliberately do not consume this
  // volume). Writing 1.0 there adds in-scatter with nothing to attenuate it:
  // measured at the shipped FOGBANK density the beach blew out to flat white,
  // +36.8% frame luminance, while the sea and sky beside it fogged correctly.
  //
  // Scalar, because fog is grey: over the volume's whole 220 m the clear-air
  // channel spread is 0.6%, and a fog bank thick enough for the spread to matter
  // has already swallowed the geometry.
  var owned = 1.0;
  let ownsExtinction = !isUnderwater();
  var dPrev = 0.0;

  for (var i = 0u; i < u32(FROXEL_Z); i++) {
    let s = textureLoad(densityIn, vec3u(gid.xy, i), 0);
    // The clamped sigma is used in BOTH the exponential and the divide below.
    // Clamping only the divisor is a real bug and not a small one: at a true
    // sigma of 1e-9 against a floor of 1e-6 the step integral would come out
    // 1000x short, which is most of the volume on a clear-air frame.
    let sigma = max(s.a * baseSigma, vec3f(1e-6));
    // The owned extinction is grey (see `owned`), so it takes the mean rather
    // than a channel - a channel would tint the fog.
    let sigmaScalar = (sigma.r + sigma.g + sigma.b) * (1.0 / 3.0);

    // The sample sits at the slice CENTRE, because that is where the consumer's
    // trilinear filter reads it. Integrating the whole slab and then storing
    // would report the far face's value at the centre's coordinate and push the
    // whole volume half a slab toward the eye.
    let dCentre = froxelWToDepth((f32(i) + 0.5) * invZ);
    let dFar = froxelWToDepth(f32(i + 1u) * invZ);

    // Analytic step integral of J * exp(-sigma * x) over the sub-step - the
    // same closed form aerialPerspective() uses, and energy-correct even when a
    // step is optically thick, which the outer slices of a silt basin are.
    let dtNear = max(dCentre - dPrev, 0.0) * invCos;
    let tNear = exp(-sigma * dtNear);
    accum += throughput * s.rgb * (vec3f(1.0) - tNear) / sigma;
    throughput *= tNear;
    if (ownsExtinction) { owned *= exp(-sigmaScalar * dtNear); }

    textureStore(scatterOut, vec3u(gid.xy, i), vec4f(accum, owned));

    let dtFar = max(dFar - dCentre, 0.0) * invCos;
    let tFar = exp(-sigma * dtFar);
    accum += throughput * s.rgb * (vec3f(1.0) - tFar) / sigma;
    throughput *= tFar;
    if (ownsExtinction) { owned *= exp(-sigmaScalar * dtFar); }
    dPrev = dFar;
  }
}
