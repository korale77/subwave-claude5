// SUBWAVE - additive bioluminescent glow sprites.
//
// WHAT THIS PASS IS FOR. A Glimmerkrill's emissive area is 2.3e-5 m2, which is
// 0.23 px at 6 m: the rasteriser resolves it stochastically, so its delivered
// peak swings 24x with sub-pixel position and its flux falls 4000x between
// 1.5 m and 24 m against 256x for pure 1/r^2. That missing 15.6x is not an
// exposure problem and cannot be fixed by authoring a bigger number, because
// auto-exposure is PINNED at depth (see GLOW.BRIGHT_BUDGET). It is a
// reconstruction problem, and the fix is to draw the emitter at the width the
// display grid can actually carry.
//
// AND THE MEDIUM'S OWN AUREOLE IS MISSING ENTIRELY. A point source in water has
// a single-scatter point-spread function with a closed form. With the emitter at
// range r and the view ray at angle psi from it, substituting t = r - u makes
// the scattering angle theta = psi*r/t and the whole integral collapses to
//
//   L(psi) = sigma_s * I * exp(-sigma_t r) * G(psi) / (r * psi),
//   G(psi) = integral of P(theta) dtheta from psi to infinity
//
// THAT IS AN ADDITION TO THE ATTENUATED BEAM AND THE CODE BELOW ADDS IT.
// exp(-sigma_t r) has already taken the scattered-out photons out of the beam;
// single scattering is what returns a share of them, spread over 42 px instead
// of concentrated in a point. So the sprite draws coreWeight*core + h*halo with
// h = 1 - exp(-sigma_s * wet), and does NOT also multiply the core by (1-h) -
// that removed them twice and broke the exact complement with the fRes handover.
// Conservation still bounds it: exp(-sigma_t r)*(2 - exp(-sigma_s r)) is at most
// exp(-sigma_a r) for every r, because u*(2-u) = 1 - (1-u)^2 <= 1.
//
// For the forward Henyey-Greenstein lobe in the small-angle limit
// (1 + g^2 - 2 g cos theta -> (1-g)^2 + g theta^2), G is elementary, and once
// the SHAPE is normalised to integrate to 1 over solid angle every constant in
// front of it - the 0.92 lobe weight, the (1+g), the 4*PI - cancels exactly:
//
//   haloShape(psi) = [1 - psi/sqrt(th0^2 + psi^2)] / (2*PI*th0*psi),
//   th0 = (1 - g)/sqrt(g)
//
// and integral of 2*PI*psi*haloShape dpsi = [u - sqrt(1+u^2)] from 0 to inf = 1,
// EXACTLY. th0 comes straight off frame.waterSigmaS.w: 4.16 deg (42 px) in
// ABYSSAL_VOID, 8.52 deg in silt, 14.27 deg in a vent plume, and it does not
// depend on range because psi is a SCATTERING angle. There is not one fitted
// constant anywhere in the aureole.
//
// The tail is 1/psi inside th0 and 1/psi^3 outside it and is never 1/psi^2, so
// inverting the profile at a visibility floor gives R proportional to flux near
// in and to flux^(1/3) far out. A square root is the one exponent that never
// occurs; render/passes/glow.js does the real inversion.

#include "../common/frame.wgsl"
#include "../common/math.wgsl"
#include "../common/water.wgsl"

/// One sprite. 64 bytes; must match SPRITE_STRIDE in render/passes/glow.js.
struct Sprite {
  /// xyz = camera-relative position (world minus frame.worldOrigin),
  /// w = metres from the EYE (camera.position, which is not the origin).
  posDist : vec4f,
  /// rgb = E0, the emitter's irradiance at the eye BEFORE transmittance and
  /// BEFORE the pulse, i.e. radiantIntensity * darkGain / dist^2.
  /// w = coreWeight, the share of the flux the geometry pass is NOT drawing.
  emit    : vec4f,
  /// x = quad angular radius (rad), y = the source's own angular radius (rad),
  /// z = haloWeight, w = the emitter's own reach in front of its centre (m).
  geom    : vec4f,
  /// x = pulse rate (Hz, 0 = steady), y = pulse phase, z = truncated-halo
  /// renormalisation, w = length of the ray that is IN the water (m).
  anim    : vec4f,
};

@group(1) @binding(0) var<storage, read> sprites : array<Sprite>;
@group(1) @binding(1) var sceneDepthTex : texture_depth_2d;

struct VSOut {
  @builtin(position) pos : vec4f,
  /// Position on the quad, in [-1,1]^2. atan(|uv| * tanQuadRad) is the angle
  /// from the sprite's centre - the quad is a PLANE, so the mapping from its
  /// surface to solid angle is a tangent and not a scale.
  @location(0) uv : vec2f,
  @location(1) @interpolate(flat) emit   : vec3f,
  /// x = tan(rQuadRad), y = alphaEff, z = haloWeight, w = coreWeight
  @location(2) @interpolate(flat) params : vec4f,
  /// x = hz, y = phase, z = haloNorm, w = wetLen
  @location(3) @interpolate(flat) anim   : vec4f,
  /// x = dist, y = viewZ, z = selfExtent (m)
  @location(4) @interpolate(flat) misc   : vec3f,
};

/// Camera-facing quad from four vertices and no vertex buffer.
///
/// The JITTERED viewProj, deliberately: the sprite has to carry the same Halton
/// offset as the geometry it sits on or TAA resolves the two against each other.
@vertex
fn vs_glow(@builtin(vertex_index) vi: u32,
           @builtin(instance_index) ii: u32) -> VSOut {
  let s = sprites[ii];
  var out : VSOut;

  let corner = vec2f(f32(vi & 1u) * 2.0 - 1.0, f32(vi >> 1u) * 2.0 - 1.0);
  // THE QUAD IS A PLANE, SO THE OFFSET IS A TANGENT. Laying rQuadRad out
  // linearly across it made the quad's true angular half-extent atan(r) instead
  // of r: 7.3% short at half a frame height and 14.7% at the cap this camera's
  // 75 deg fovY produces. Both ends are fixed together - the quad is sized with
  // tan(rQuadRad) here and fs_glow reads the angle back with atan - so the
  // truncation radius the flux renormalisation assumes is the one that is drawn.
  let tanR = tan(clamp(s.geom.x, 0.0, 1.45));
  let rWorld = tanR * s.posDist.w;
  let world = s.posDist.xyz
            + frame.cameraRight.xyz * (rWorld * corner.x)
            + frame.cameraUp.xyz * (rWorld * corner.y);

  out.pos = frame.viewProj * vec4f(world, 1.0);
  out.uv = corner;
  out.emit = s.emit.rgb;
  out.params = vec4f(tanR, s.geom.y, s.geom.z, s.emit.w);
  out.anim = s.anim;
  out.misc = vec3f(s.posDist.w,
                   max(dot(s.posDist.xyz - frame.cameraPos.xyz, frame.cameraFwd.xyz),
                       nearPlane()),
                   s.geom.w);
  return out;
}

@fragment
fn fs_glow(in: VSOut) -> @location(0) vec4f {
  let rUv = length(in.uv);
  if (rUv > 1.0) { discard; }

  let tanR = in.params.x;
  let psi = atan(rUv * tanR);

  // Focal length in pixels: (h/2) / tan(fovY/2).
  let f = frame.screen.y * 0.5 / max(frame.cameraFwd.w, 1e-4);
  let sigA = GLOW_SIGMA_PX / f;

  // IDENTICAL TO pass/creature.wgsl's pulse, from the same hz and the same
  // phase. If these two expressions ever differ the core and the body beat
  // against each other at up to 8.3 Hz, which is the whole roster's spread.
  var pulse = 1.0;
  if (in.anim.x > 0.0) {
    pulse = 0.55 + 0.45 * sin(currentTime() * TAU * in.anim.x + in.anim.y * 1.7);
  }

  // ---- the two shapes, each normalised to integrate to 1 over solid angle --
  let core = exp(-(psi * psi) / (2.0 * sigA * sigA)) / (TAU * sigA * sigA);

  let g = clamp(frame.waterSigmaS.w, 0.05, 0.995);
  let th0 = (1.0 - g) / sqrt(g);
  // Regularise the 1/psi pole at the source's own angular size. Below that the
  // emitter is not a point and the small-angle expansion has run out anyway.
  let aEff = max(sigA, in.params.y);
  let psiR = sqrt(psi * psi + aEff * aEff);
  let halo = (1.0 - psi / sqrt(th0 * th0 + psi * psi)) / (TAU * th0 * psiR) * in.anim.z;

  // ---- THE MEDIUM, EXACTLY ONCE -------------------------------------------
  // pass/underwater.wgsl has already run for this frame and will not run again.
  // It applied transmittance, the ambient in-scatter, the deep tint, the froxel
  // volume and the marine snow to everything BEHIND this sprite. So the sprite
  // owes itself exactly one thing: its own BEAM extinction over the wet part of
  // the ray. sigma_t, NEVER Kd - Kd is the daylight-versus-DEPTH coefficient,
  // and in ABYSSAL_VOID blue it is 0.0182 against sigma_t 0.0260, a 1.63x error
  // at 60 m and 4.4x at 200 m. No ambient in-scatter is added either: the
  // composite already put the water's own haze on this pixel.
  //
  // THE FROXEL OWNERSHIP INVERTS WITH THE MEDIUM. Underwater the volume owns the
  // collimated beam and the punctual lamps, its .a is exactly 1.0, and the
  // composite has already added its .rgb - so consuming it here would double it.
  // In air .a is the real transmittance and the sprite multiplies by it and adds
  // nothing. That is why the froxel tap is in one branch only.
  //
  // Below TRUE_DARK_DEPTH the composite's aphoticFactor is 0 and it collapses to
  // scene * waterTransmittance(wet), which is identically the operation below:
  // in the abyss a sprite pixel and a creature pixel at the same range are
  // attenuated by the same factor by construction.
  var T = waterTransmittance(in.anim.w);
  if (!isUnderwater()) {
    let uv01 = in.pos.xy * frame.screen.zw;
    T = T * sampleFroxel(uv01, in.misc.y).a;
  }

  // The share of the arriving flux single scattering returns as an aureole.
  // Integrated over the WET part of the ray only - the dry part of a ray from a
  // boat looking down at an emitter scatters nothing, and crediting it with the
  // whole slant range over-weighted the halo by 3.6x in that geometry.
  let h = vec3f(1.0) - exp(-waterSightSigmaS() * max(in.anim.w, 0.0));

  let L = in.emit * T * pulse * (in.params.w * core + h * in.params.z * halo);

  // ---- soft particle -------------------------------------------------------
  // REVERSE-Z: linear view depth is near / ndc, and ndc -> 0 at infinity, so a
  // pixel with no geometry behind it reads as effectively infinite and fades
  // nothing. Without this an emitter resting on the seabed gets a hard elliptical
  // cut where its quad intersects the sand.
  //
  // THE COMPARISON IS BIASED IN FRONT OF THE EMITTER BY ITS OWN REACH, and that
  // is the whole difference between a glow and a hole. sceneDepth over an animal
  // IS the animal: its front surface is always nearer than the sprite's centre,
  // so an unbiased test evaluates to EXACTLY zero over every pixel the body
  // covers - which is precisely where the core's peak is. Measured on the
  // unbiased build, four of six pinned emitters read fade = 0 at their own peak
  // pixel and a Wisplight at 7.88 m lost 30 of the 49 pixels around its centre;
  // the survivors were the ones whose body happened to miss the depth sample,
  // i.e. the sub-pixel lottery this pass exists to remove, reintroduced.
  // Geometry in front of the EMITTER still occludes it, which is the only thing
  // the test was ever for.
  let softFade = max(0.25, tanR * in.misc.x);
  let pix = vec2i(in.pos.xy);
  let zs = linearizeDepth(textureLoad(sceneDepthTex, pix, 0), nearPlane());
  let fade = saturate((zs - (in.misc.y - in.misc.z)) / softFade);

  return vec4f(L * fade, 1.0);
}
