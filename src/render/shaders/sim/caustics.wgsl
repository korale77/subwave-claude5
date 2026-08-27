// SUBWAVE - caustics.
//
// METHOD: analytic wave caustics from the divergence of the refracted ray
// field, on an exactly periodic wave sum.
//
// The obvious alternative is GPU photon splatting from the real ocean surface,
// and it is the better technique in the abstract - it produces true cusps and
// folds by construction. It is not usable here, and the reason is a hard
// contract rather than a performance argument: common/water.wgsl consumes this
// texture as a TILING world-space pattern, sampling it at
// `worldXZ / CAUSTICS_SCALE` with a repeating sampler. A splat from the ocean
// field is anchored to a camera-centred patch and does not tile; the seams
// would be visible on every seabed in the game.
//
// So the pattern is synthesised from a wave sum whose wavevectors lie on the
// integer lattice of the tile - which makes it exactly periodic to the last bit
// - with amplitudes and frequencies taken from the live wind spectrum, so it
// still animates with the weather rather than being a canned loop.
//
// The intensity is not a noise function dressed up to look like caustics. A
// vertical sun ray striking a surface of height h is deflected horizontally by
//   delta(x) = d * (1 - 1/n) * grad h(x)
// so the map from surface point to seabed point is  M(x) = x + c * grad h(x),
// c = d * (1 - 1/n). Energy conservation gives the irradiance directly as
//   E = 1 / |det(J)|,  J = I + c * Hessian(h)
// which is the same construction a photon splat converges to, evaluated in
// closed form. Where det J passes through zero the surface has focused to a
// line: that is a real caustic cusp, and it is why the filaments have sharp
// bright edges instead of soft blobs.
//
// The three channels use the true refractive indices of seawater at 610/550/460
// nm, so the cusps land in slightly different places per wavelength and the
// filament edges carry a faint colour fringe. That is what the rgba16float
// format note in gpu.js is reserving the extra channels for.

#include "../common/math.wgsl"

/// Wavevectors on the tile's integer lattice, on seven logarithmic rings from
/// |n| = 1 to 24 - wavelengths 14.0 m down to 0.5735 m, which is the band that
/// actually focuses sunlight in the shallows. MUST equal CAUSTIC_WAVES in
/// render/passes/caustics.js, which packs the uniform; tools/test-caustics.mjs
/// reads this line out of the shader text and compares the two.
const CAUSTIC_WAVES : u32 = 48u;

struct CausticsParams {
  // x = time (s), y = tile size (m), z = intensity clamp, w = receiver depth (m)
  config : vec4f,
  // xyz = (1 - 1/n) per channel, w = output resolution
  ior    : vec4f,
  // [2i] = (kx, kz, amplitude, omega), [2i+1] = (phase, 0, 0, 0)
  waves  : array<vec4f, 96>,
};

@group(0) @binding(0) var<uniform> caustics : CausticsParams;
@group(0) @binding(1) var causticsOut : texture_storage_2d<rgba16float, write>;

/// Height gradient and Hessian of the periodic wave sum at a tile position.
/// Returns (dh/dx, dh/dz, d2h/dx2, d2h/dz2) and the mixed second derivative
/// separately, because WGSL has no tuple return.
struct WaveJet {
  grad : vec2f,
  hxx  : f32,
  hzz  : f32,
  hxz  : f32,
};

fn waveJet(p: vec2f, t: f32) -> WaveJet {
  var out: WaveJet;
  out.grad = vec2f(0.0);
  out.hxx = 0.0;
  out.hzz = 0.0;
  out.hxz = 0.0;
  for (var i = 0u; i < CAUSTIC_WAVES; i = i + 1u) {
    let a = caustics.waves[i * 2u];
    let b = caustics.waves[i * 2u + 1u];
    let amp = a.z;
    if (amp <= 0.0) { continue; }
    let theta = a.x * p.x + a.y * p.y - a.w * t + b.x;
    let s = sin(theta);
    let c = cos(theta);
    // h = A cos(theta); grad = -A k sin(theta); H = -A k(x)k sin' = -A k k cos
    out.grad += vec2f(a.x, a.y) * (-amp * s);
    out.hxx -= amp * a.x * a.x * c;
    out.hzz -= amp * a.y * a.y * c;
    out.hxz -= amp * a.x * a.y * c;
  }
  return out;
}

@compute @workgroup_size(8, 8, 1)
fn cs_caustics(@builtin(global_invocation_id) gid: vec3u) {
  let res = u32(caustics.ior.w);
  if (gid.x >= res || gid.y >= res) { return; }

  let tile = caustics.config.y;
  let uv = (vec2f(vec2u(gid.xy)) + 0.5) / f32(res);
  let p = uv * tile;
  let jet = waveJet(p, caustics.config.x);

  var rgb = vec3f(0.0);
  for (var ch = 0; ch < 3; ch = ch + 1) {
    // c = depth * (1 - 1/n) for this wavelength. Red bends least, so its cusps
    // sit fractionally further out than blue's.
    let c = caustics.config.w * caustics.ior[ch];
    let jxx = 1.0 + c * jet.hxx;
    let jzz = 1.0 + c * jet.hzz;
    let jxz = c * jet.hxz;
    let det = jxx * jzz - jxz * jxz;
    // 1/|det| diverges exactly on the fold. Clamping is not a fudge: a real
    // caustic's peak irradiance is finite because the sun is not a point and
    // the water is not perfectly coherent, and this is where that limit lives.
    rgb[ch] = min(1.0 / max(abs(det), 1e-3), caustics.config.z);
  }

  // No further normalisation HERE. det = 1 on a flat sea, so 1/|det| is
  // unity-referenced on a flat sea only: the |det| floor and the clamp above
  // put energy into the folds, and the tile's true arithmetic mean is 1.3262 /
  // 1.3338 / 1.3451 RGB. Both consumers - common/water.wgsl's causticFactor()
  // and sim/froxel_inject.wgsl's froxelCausticVisibility() - divide by that
  // measured mean (RENDER.CAUSTIC_TILE_MEAN) so the pattern REDISTRIBUTES the
  // beam rather than adding a third of it. Change sigma and the mean moves;
  // tools/test-caustics.mjs section 6 is what forces the constant to follow.
  textureStore(causticsOut, vec2u(gid.xy), vec4f(rgb, 1.0));
}
