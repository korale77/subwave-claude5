// SUBWAVE - post-IFFT assembly: displacement, derivatives, Jacobian foam, mips.
//
// cs_assemble unpacks the four complex transform results into the two sampled
// textures the surface shader reads, and folds the surface Jacobian into the
// persistent foam accumulator.
//
// cs_mipReduce builds the mip chain. It is not a plain box filter: alongside the
// mean it carries the SECOND MOMENT of the slope, i.e. the slope variance that
// each reduction destroys. That channel is what lets the surface shader widen
// its specular lobe by exactly the roughness the missing detail represented,
// instead of letting distant water sparkle into aliased white noise. Energy that
// leaves the normal has to arrive somewhere.

#define OCEAN_GROUP 0
#define OCEAN_BINDING 0
#include "../common/ocean.wgsl"

@group(0) @binding(1) var<storage, read> hkt : array<vec2f>;
@group(0) @binding(2) var dispWrite  : texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var derivWrite : texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(4) var foamWrite  : texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(5) var foamPrev   : texture_2d_array<f32>;

// Mip reduction uses its own bind group; these bindings are declared here so the
// reducer can live in the same module as the pass that produces mip 0.
@group(0) @binding(6) var mipSrc : texture_2d_array<f32>;
@group(0) @binding(7) var mipDst : texture_storage_2d_array<rgba16float, write>;

fn hktIndex(field: u32, cascade: u32, m: u32, n: u32) -> u32 {
  let nn = ocean.counts.x;
  return ((field * ocean.counts.z + cascade) * nn + m) * nn + n;
}

@compute @workgroup_size(8, 8, 1)
fn cs_assemble(@builtin(global_invocation_id) gid: vec3u) {
  let nn = ocean.counts.x;
  if (gid.x >= nn || gid.y >= nn) { return; }
  let n = gid.x;
  let m = gid.y;
  let c = gid.z;

  // The spectrum lattice is centred on k = 0, which is a half-period shift in
  // the transform domain: exactly a (-1)^(n+m) chequerboard.
  var sgn = 1.0;
  if (((n + m) & 1u) == 1u) { sgn = -1.0; }

  let f0 = hkt[hktIndex(0u, c, m, n)] * sgn;   // (Dx,        Dz)
  let f1 = hkt[hktIndex(1u, c, m, n)] * sgn;   // (Dy,        dDy/dx)
  let f2 = hkt[hktIndex(2u, c, m, n)] * sgn;   // (dDy/dz,    dDx/dx)
  let f3 = hkt[hktIndex(3u, c, m, n)] * sgn;   // (dDz/dz,    dDx/dz)

  textureStore(dispWrite, vec2u(n, m), c, vec4f(f0.x, f1.x, f0.y, 0.0));
  // w = 0: mip 0 has, by definition, no unresolved slope variance. The reducer
  // accumulates into this channel from there.
  textureStore(derivWrite, vec2u(n, m), c, vec4f(f1.y, f2.x, f2.y + f3.x, 0.0));

  // Jacobian of the horizontal displacement map. The choppiness gain is already
  // folded into the spectral fields, so these are the finished derivatives.
  //   J < 0  =>  the surface has folded over itself: a breaking crest.
  let jxx = 1.0 + f2.y;
  let jzz = 1.0 + f3.x;
  let jxz = f3.y;
  let jac = jxx * jzz - jxz * jxz;

  let prev = textureLoad(foamPrev, vec2u(n, m), c, 0);
  let inject = saturate((ocean.timing.w - jac) * ocean.shading.x);
  let decayed = prev.x * exp(-ocean.timing.z * ocean.timing.y);
  let foam = max(decayed, inject);

  // Foam is stored in LATTICE space and sampled with the same UV as the
  // displacement, so it is carried along by the displacement automatically -
  // an Eulerian advection step would be double-counting the motion the
  // parameterisation already has.
  var age = prev.y + ocean.timing.y;
  if (inject > decayed) { age = 0.0; }

  textureStore(foamWrite, vec2u(n, m), c, vec4f(foam, min(age, 12.0), jac, 0.0));
}

// ---------------------------------------------------------------------------

@compute @workgroup_size(8, 8, 1)
fn cs_mipReduce(@builtin(global_invocation_id) gid: vec3u) {
  let dstSize = textureDimensions(mipDst);
  if (gid.x >= dstSize.x || gid.y >= dstSize.y) { return; }
  let layer = gid.z;
  let p = vec2u(gid.x * 2u, gid.y * 2u);

  let s00 = textureLoad(mipSrc, p, layer, 0);
  let s10 = textureLoad(mipSrc, p + vec2u(1u, 0u), layer, 0);
  let s01 = textureLoad(mipSrc, p + vec2u(0u, 1u), layer, 0);
  let s11 = textureLoad(mipSrc, p + vec2u(1u, 1u), layer, 0);

  let mean = (s00 + s10 + s01 + s11) * 0.25;
  // E[x^2 + z^2] over the four children, plus the variance they had already
  // accumulated, minus the square of the mean we are about to keep.
  let secondMoment = 0.25 * (
      s00.x * s00.x + s00.y * s00.y + s00.w
    + s10.x * s10.x + s10.y * s10.y + s10.w
    + s01.x * s01.x + s01.y * s01.y + s01.w
    + s11.x * s11.x + s11.y * s11.y + s11.w);
  let variance = secondMoment - (mean.x * mean.x + mean.y * mean.y);

  textureStore(mipDst, vec2u(gid.xy), layer, vec4f(mean.xyz, max(variance, 0.0)));
}
