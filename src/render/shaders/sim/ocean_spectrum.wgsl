// SUBWAVE - ocean spectrum: h0 bake and per-frame time evolution.
//
// Two entry points:
//   cs_bakeSpectrum  writes the time-independent h0(k) and conj(h0(-k)) pair.
//                    Rare - only when the wind, fetch or sea state changes.
//   cs_evolve        every frame: h(k,t), then the seven derived spectral fields
//                    packed into four complex signals for the IFFT.
//
// The Hermitian packing is the whole trick. h(k,t) is Hermitian (h(-k) = conj(h(k)))
// because it is the spectrum of a REAL height field, and so is every field
// derived from it by multiplication by i*k or by a real even function of k.
// Two Hermitian spectra A and B can therefore ride one complex IFFT as A + i*B,
// and come out as the real and imaginary parts of the result. Four complex
// transforms carry all eight real fields instead of eight - a 2x saving on the
// most expensive pass in the ocean.

#define OCEAN_GROUP 0
#define OCEAN_BINDING 0
#include "../common/ocean.wgsl"

@group(0) @binding(1) var h0Write : texture_storage_2d_array<rgba32float, write>;
@group(0) @binding(2) var h0Read  : texture_2d_array<f32>;
@group(0) @binding(3) var<storage, read_write> hkt : array<vec2f>;

/// Wavevector for lattice site (n, m) of a cascade of tile size L.
/// The lattice is centred: n = N/2 is k = 0, so the transform's DC bin sits in
/// the middle and the sign correction in the assemble pass is the usual
/// (-1)^(n+m) chequerboard.
fn oceanWavevector(n: u32, m: u32, ln: f32) -> vec2f {
  let half = f32(ocean.counts.x) * 0.5;
  return vec2f(f32(n) - half, f32(m) - half) * (TAU / ln);
}

fn cascadeSize(c: u32) -> f32 {
  if (c == 0u) { return ocean.cascadeL.x; }
  if (c == 1u) { return ocean.cascadeL.y; }
  return ocean.cascadeL.z;
}

fn cascadeChop(c: u32) -> f32 {
  if (c == 0u) { return ocean.cascadeChop.x; }
  if (c == 1u) { return ocean.cascadeChop.y; }
  return ocean.cascadeChop.z;
}

/// Flat index into the transform scratch buffer.
/// Layout: [field][cascade][row m][col n], so a row of one field of one cascade
/// is contiguous and the row FFT pass reads it with stride 1.
fn hktIndex(field: u32, cascade: u32, m: u32, n: u32) -> u32 {
  let nn = ocean.counts.x;
  return ((field * ocean.counts.z + cascade) * nn + m) * nn + n;
}

// ---------------------------------------------------------------------------
// Bake
// ---------------------------------------------------------------------------

@compute @workgroup_size(8, 8, 1)
fn cs_bakeSpectrum(@builtin(global_invocation_id) gid: vec3u) {
  let nn = ocean.counts.x;
  if (gid.x >= nn || gid.y >= nn) { return; }
  let c = gid.z;
  let ln = cascadeSize(c);

  let k = oceanWavevector(gid.x, gid.y, ln);
  let kmag = length(k);
  let h0 = oceanH0(k, kmag, gid.x, gid.y, c);

  // The mirrored site. (N - i) mod N is the lattice index of -k; the two edge
  // rows have no exact partner but carry no energy worth the special case.
  let mn = (nn - gid.x) % nn;
  let mm = (nn - gid.y) % nn;
  let km = oceanWavevector(mn, mm, ln);
  let h0m = oceanH0(km, length(km), mn, mm, c);

  textureStore(h0Write, vec2u(gid.xy), c, vec4f(h0.x, h0.y, h0m.x, -h0m.y));
}

// ---------------------------------------------------------------------------
// Time evolution
// ---------------------------------------------------------------------------

/// Complex multiply.
fn cmul(a: vec2f, b: vec2f) -> vec2f {
  return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

/// Pack two Hermitian spectra as p + i*q so one complex IFFT carries both.
fn cpack(p: vec2f, q: vec2f) -> vec2f {
  return vec2f(p.x - q.y, p.y + q.x);
}

@compute @workgroup_size(8, 8, 1)
fn cs_evolve(@builtin(global_invocation_id) gid: vec3u) {
  let nn = ocean.counts.x;
  if (gid.x >= nn || gid.y >= nn) { return; }
  let c = gid.z;
  let ln = cascadeSize(c);
  let lam = cascadeChop(c);

  let k = oceanWavevector(gid.x, gid.y, ln);
  let kmag = length(k);

  let t = textureLoad(h0Read, vec2u(gid.xy), c, 0);
  let w = oceanOmega(kmag);
  let phase = w * ocean.timing.x;
  let e = vec2f(cos(phase), sin(phase));

  //   h(k,t) = h0(k) e^{i w t} + conj(h0(-k)) e^{-i w t}
  // The stored zw channels are ALREADY conjugated, so this is one multiply by
  // e and one by its conjugate.
  let h = cmul(t.xy, e) + cmul(t.zw, vec2f(e.x, -e.y));

  // Unit wavevector, guarded at k = 0 where the horizontal displacement of a
  // flat mode is undefined (and zero).
  var kn = vec2f(0.0);
  if (kmag > 1e-6) { kn = k / kmag; }

  // +i * h, the 90-degree phase shift every derived field carries.
  //
  // The SIGN here is load-bearing and inverts silently. With +i the horizontal
  // term is D = -k/|k| * A * sin(phase), which moves material points TOWARD the
  // crest: crests sharpen, troughs flatten, which is the whole point of the
  // Gerstner displacement. With -i the surface comes out with pointed troughs
  // and flat crests, the Jacobian below (which is the x-derivative of this very
  // field) disagrees with it, and the CPU query in src/sim/ocean.js - which uses
  // the +i convention - puts the vessel in the wrong place on the wave.
  let ih = vec2f(-h.y, h.x);

  let dx = ih * (kn.x * lam);           // choppy horizontal displacement
  let dz = ih * (kn.y * lam);
  let dy = h;                           // height
  let dydx = ih * k.x;                  // height gradient -> shading normal
  let dydz = ih * k.y;
  let dxdx = h * (-(k.x * kn.x) * lam); // displacement gradient -> Jacobian
  let dzdz = h * (-(k.y * kn.y) * lam);
  let dxdz = h * (-(k.x * kn.y) * lam);

  hkt[hktIndex(0u, c, gid.y, gid.x)] = cpack(dx, dz);
  hkt[hktIndex(1u, c, gid.y, gid.x)] = cpack(dy, dydx);
  hkt[hktIndex(2u, c, gid.y, gid.x)] = cpack(dydz, dxdx);
  hkt[hktIndex(3u, c, gid.y, gid.x)] = cpack(dzdz, dxdz);
}
