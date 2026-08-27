// SUBWAVE - physically based surface shading.
//
// Cook-Torrance specular (GGX NDF, Smith height-correlated visibility, Schlick
// Fresnel) with Kulla-Conty/Fdez-Aguera multiple-scattering energy
// compensation, plus a translucency model for the organics that carry this
// game's look: kelp blades, jellyfish bells, fish fins, glass sponges.
//
// Two conventions used throughout, both worth stating once:
//   - `roughness` on the SurfaceCtx is PERCEPTUAL. The GGX parameter is
//     alpha = roughness^2. Everything named `a2` is alpha^2.
//   - All direction vectors point AWAY from the surface: viewDir -> eye,
//     lightDir -> light. Never the direction of propagation.
//
// No frame.wgsl dependency: this header is pure material maths so it can be
// used from compute passes (probe prefiltering, imposter baking) that do not
// want bind group 0.

#pragma once

#include "math.wgsl"

/// Dielectric normal-incidence reflectance. 0.04 is the ~1.5 IOR of most
/// non-metals; water-soaked organics sit nearer 0.02 (handled via f90 below).
const F0_DIELECTRIC : f32 = 0.04;

/// Perceptual roughness floor. Below this a single sun sample aliases into
/// fireflies that TAA cannot remove, because the highlight is smaller than a
/// pixel and moves by more than a pixel per frame.
const MIN_PERCEPTUAL_ROUGHNESS : f32 = 0.045;

// Translucency tuning. Chosen so the useful thickness range - a 3 mm kelp
// blade up to an 8 cm jellyfish bell - spans most of the transmission curve
// instead of clustering at one end.
const TRANSLUCENCY_EXTINCTION : f32 = 34.0;   // 1/m, scaled by (1 - albedo)
const TRANSLUCENCY_FLOOR      : f32 = 2.0;    // 1/m, absorption even for white tissue
const TRANSLUCENCY_DISTORTION : f32 = 0.22;   // bends the exit lobe toward -N

// ---------------------------------------------------------------------------
// Surface context
// ---------------------------------------------------------------------------

struct SurfaceCtx {
  worldPos     : vec3f,   // camera-relative world position
  normal       : vec3f,   // shading normal (normal-mapped), unit
  geoNormal    : vec3f,   // geometric normal, unit - used to reject light leaks
  viewDir      : vec3f,   // surface -> eye, unit
  albedo       : vec3f,   // linear base colour
  roughness    : f32,     // perceptual, already clamped to the floor
  metallic     : f32,
  occlusion    : f32,     // ambient occlusion; AMBIENT ONLY, never direct light
  emissive     : vec3f,   // linear, added by the caller after all lighting
  f0           : vec3f,   // normal-incidence specular reflectance
  NoV          : f32,
  translucency : f32,     // 0 opaque, 1 fully light-transmitting tissue
  /**
   * 1 for a surface sealed inside a dry pressure volume, 0 otherwise.
   *
   * BELOW SEA LEVEL IS NOT THE SAME AS IN THE WATER, and two lighting terms had
   * no way to tell the difference. depthAt(worldPos) is greater than zero for
   * every surface in a room 33 m down, so evalPunctualLights attenuated its own
   * interior lamps by Beer-Lambert over the lamp-to-wall path - a 4 m throw lost
   * 38% of its intensity and cooled 7.6% in R/B to water that is not in the
   * room - and evalAmbient handed the same wall the blue sky SH for its fill.
   *
   * Set by pass/entity.wgsl from its own dryInteriorSurface flag; everything
   * else leaves it at the default 0 and behaves exactly as before.
   */
  dryInterior  : f32,
};

/// Build the shading context. Everything derived lives here so the per-light
/// loop only touches lightDir.
fn makeSurface(
    worldPos: vec3f, normal: vec3f, geoNormal: vec3f, viewDir: vec3f,
    albedo: vec3f, roughness: f32, metallic: f32,
    occlusion: f32, emissive: vec3f, translucency: f32) -> SurfaceCtx {
  var s: SurfaceCtx;
  s.worldPos     = worldPos;
  s.normal       = normal;
  s.geoNormal    = geoNormal;
  s.viewDir      = viewDir;
  s.albedo       = max(albedo, vec3f(0.0));
  s.roughness    = clamp(roughness, MIN_PERCEPTUAL_ROUGHNESS, 1.0);
  s.metallic     = saturate(metallic);
  s.occlusion    = saturate(occlusion);
  s.emissive     = max(emissive, vec3f(0.0));
  s.f0           = mix(vec3f(F0_DIELECTRIC), s.albedo, s.metallic);
  // The epsilon floor is not cosmetic: at NoV = 0 the Smith visibility
  // denominator and the specular-occlusion power both collapse, and a single
  // silhouette pixel of NaN propagates through TAA into a permanent hole.
  s.NoV          = max(saturate(dot(normal, viewDir)), 1e-4);
  s.translucency = saturate(translucency);
  // Opt-in: a caller that knows it is shading a sealed room sets it afterwards.
  s.dryInterior  = 0.0;
  return s;
}

/// GGX alpha for a surface. Kept as a function rather than a cached field so
/// callers may filter roughness per-pixel (geometric specular AA) first.
fn surfaceAlpha(s: SurfaceCtx) -> f32 { return s.roughness * s.roughness; }

/// Diffuse albedo: metals have none, all their reflectance is in f0.
fn surfaceDiffuse(s: SurfaceCtx) -> vec3f { return s.albedo * (1.0 - s.metallic); }

// ---------------------------------------------------------------------------
// Microfacet terms
// ---------------------------------------------------------------------------

/// GGX / Trowbridge-Reitz normal distribution.
/// Written in Karis' rearranged form: computing `(NoH*a2 - NoH)*NoH + 1` keeps
/// the subtraction between similar magnitudes, which fp32 handles, whereas the
/// textbook `NoH*NoH*(a2-1)+1` cancels catastrophically as a2 -> 0.
fn D_GGX(NoH: f32, a2: f32) -> f32 {
  let d = (NoH * a2 - NoH) * NoH + 1.0;
  return a2 / max(PI * d * d, 1e-9);
}

/// Smith height-correlated visibility (Heitz 2014), already divided by the
/// 4*NoL*NoV of the Cook-Torrance denominator - so the specular lobe is
/// simply D * V * F. Height correlation matters at grazing angles, where the
/// separable form loses a visible amount of energy.
fn V_SmithGGXCorrelated(NoV: f32, NoL: f32, a2: f32) -> f32 {
  let lambdaV = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  let lambdaL = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(lambdaV + lambdaL, 1e-7);
}

/// Schlick Fresnel with an explicit f90, so low-f0 materials (wet organics,
/// f0 ~ 0.02) can be stopped from turning pure white at the silhouette.
fn F_Schlick(f0: vec3f, f90: f32, u: f32) -> vec3f {
  return f0 + (vec3f(f90) - f0) * pow5(saturate(1.0 - u));
}

fn F_SchlickScalar(f0: f32, f90: f32, u: f32) -> f32 {
  return f0 + (f90 - f0) * pow5(saturate(1.0 - u));
}

/// Reflectance-derived f90 (Frostbite, "Moving Frostbite to PBR", s.4.6).
/// f0 >= 0.02 gives f90 = 1; below that the grazing response is scaled down,
/// which is what keeps sodden kelp from glowing white at the edges.
fn f90FromF0(f0: vec3f) -> f32 {
  return saturate(dot(f0, vec3f(50.0 / 3.0)));
}

// ---------------------------------------------------------------------------
// Diffuse
// ---------------------------------------------------------------------------

fn Fd_Lambert() -> f32 { return INV_PI; }

/// Disney/Burley diffuse (Burley 2012), renormalised. Adds the retroreflective
/// grazing brightening that rough dielectrics genuinely show - sand, silt,
/// unpolished hull ceramic - and which Lambert misses entirely.
fn Fd_Burley(NoV: f32, NoL: f32, LoH: f32, roughness: f32) -> f32 {
  let f90 = 0.5 + 2.0 * roughness * LoH * LoH;
  let lightScatter = F_SchlickScalar(1.0, f90, NoL);
  let viewScatter  = F_SchlickScalar(1.0, f90, NoV);
  return lightScatter * viewScatter * INV_PI;
}

// ---------------------------------------------------------------------------
// Split-sum environment BRDF and multiple scattering
// ---------------------------------------------------------------------------

/// Analytic fit to the split-sum DFG term (Karis, "Mobile Approximation").
/// Returns (scale, bias) such that the environment specular for a given f0 is
/// `f0 * scale + bias`. This avoids a DFG LUT texture entirely, which matters
/// because the project ships no image assets.
///
/// The final max() is not in Karis' original: the fitted bias dips to about
/// -7.6e-4 around roughness 0.8 at normal incidence, and a negative bias is
/// negative radiance - it would make an f0 = 0 surface subtract light and push
/// the multi-scatter diffuse share above unity. The true DFG terms are both
/// non-negative everywhere, so clamping only ever repairs fit error.
fn envBRDFApprox(roughness: f32, NoV: f32) -> vec2f {
  let c0 = vec4f(-1.0, -0.0275, -0.572,  0.022);
  let c1 = vec4f( 1.0,  0.0425,  1.040, -0.040);
  let r  = vec4f(roughness) * c0 + c1;
  let a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  return max(vec2f(-1.04, 1.04) * a004 + r.zw, vec2f(0.0));
}

/// Kulla-Conty energy compensation for the DIRECT specular lobe.
///
/// A single-scattering microfacet model discards every ray that bounces more
/// than once inside the microsurface, so a rough metal loses up to ~40% of its
/// reflectance and reads as dull grey. Ess is the directional albedo of the
/// single-scatter lobe; scaling by 1 + f0*(1/Ess - 1) puts the lost energy back
/// with the correct saturation (each extra bounce multiplies by F again).
fn brdfEnergyCompensation(f0: vec3f, roughness: f32, NoV: f32) -> vec3f {
  let ab = envBRDFApprox(roughness, NoV);
  let Ess = max(ab.x + ab.y, 1e-3);
  return vec3f(1.0) + f0 * (1.0 / Ess - 1.0);
}

/// Multiple-scattering environment specular (Fdez-Aguera 2019). Multiply the
/// prefiltered radiance by this. Unlike the direct-lobe compensation above it
/// also returns the correct energy SPLIT, so the matching diffuse term below
/// receives exactly what the specular lobe did not take.
fn envSpecularMultiScatter(f0: vec3f, roughness: f32, NoV: f32) -> vec3f {
  let ab = envBRDFApprox(roughness, NoV);
  let FssEss = f0 * ab.x + vec3f(ab.y);
  let Ess = ab.x + ab.y;
  let Ems = max(1.0 - Ess, 0.0);              // energy lost by single scattering
  // Average Fresnel over the hemisphere for a Schlick lobe; the 1/21 is the
  // exact integral of the Schlick term against the cosine.
  let Favg = f0 + (vec3f(1.0) - f0) * (1.0 / 21.0);
  let Fms = FssEss * Favg / max(vec3f(1.0) - Ems * Favg, vec3f(1e-4));
  return FssEss + Fms * Ems;
}

/// The diffuse partner of envSpecularMultiScatter: whatever energy the full
/// multi-scatter specular did not reflect is available to the diffuse lobe.
/// Multiply by the irradiance (SH) to get ambient diffuse.
fn envDiffuseMultiScatter(f0: vec3f, diffuseColor: vec3f, roughness: f32, NoV: f32) -> vec3f {
  let spec = envSpecularMultiScatter(f0, roughness, NoV);
  return diffuseColor * max(vec3f(1.0) - spec, vec3f(0.0));
}

/// Specular occlusion from a diffuse AO term (Lagarde & de Rousiers,
/// "Moving Frostbite to PBR", listing 26).
///
/// As roughness rises the exponent collapses to 0, pow() goes to 1 and the
/// result becomes plain `ao` - a rough specular lobe covers the same cone the
/// AO was computed for. As roughness falls the exponent rises to 1/2 and a
/// grazing view with low AO is occluded HARDER than `ao`, because a narrow
/// mirror lobe seen at a grazing angle is very likely to strike the very
/// occluder that produced the AO.
fn specularOcclusion(NoV: f32, ao: f32, roughness: f32) -> f32 {
  let alpha = roughness * roughness;
  return saturate(pow(NoV + ao, exp2(-16.0 * alpha - 1.0)) - 1.0 + ao);
}

// ---------------------------------------------------------------------------
// Direct evaluation
// ---------------------------------------------------------------------------

/// Full direct contribution from one light. `lightDir` is surface -> light
/// (unit); `lightColor` must already include intensity, distance attenuation,
/// spot falloff and shadowing. NoL is folded in here.
fn evalBRDF(s: SurfaceCtx, lightDir: vec3f, lightColor: vec3f) -> vec3f {
  let NoL = saturate(dot(s.normal, lightDir));
  if (NoL <= 0.0) { return vec3f(0.0); }

  // A normal map can tilt a pixel toward a light that the actual triangle
  // faces away from, lighting the dark side of a mesh. Fade over the last few
  // degrees of the geometric terminator rather than clipping, which would put
  // a hard seam straight down the middle of a smooth surface.
  let geoMask = saturate(dot(s.geoNormal, lightDir) * 8.0);
  if (geoMask <= 0.0) { return vec3f(0.0); }

  let alpha = surfaceAlpha(s);
  let a2 = alpha * alpha;

  let H = normalize(s.viewDir + lightDir);
  let NoH = saturate(dot(s.normal, H));
  let LoH = saturate(dot(lightDir, H));

  let D = D_GGX(NoH, a2);
  let Vis = V_SmithGGXCorrelated(s.NoV, NoL, a2);
  let F = F_Schlick(s.f0, f90FromF0(s.f0), LoH);
  let Fr = (D * Vis) * F * brdfEnergyCompensation(s.f0, s.roughness, s.NoV);

  // Energy conservation: the diffuse lobe only gets what the specular lobe
  // let through. Using F at the half-angle (not at N) is what keeps a wet
  // surface from being simultaneously mirror-bright and fully diffuse.
  let kD = vec3f(1.0) - F;
#if DIFFUSE_BURLEY
  let Fd = surfaceDiffuse(s) * Fd_Burley(s.NoV, NoL, LoH, s.roughness) * kD;
#else
  let Fd = surfaceDiffuse(s) * Fd_Lambert() * kD;
#endif

  return (Fr + Fd) * (NoL * geoMask) * lightColor;
}

// ---------------------------------------------------------------------------
// Translucency
// ---------------------------------------------------------------------------

/// Schlick's phase approximation (Schlick 1994), parametrised so cosTheta = 1
/// is pure forward scattering. Squares its denominator where Henyey-Greenstein
/// raises it to 3/2, and integrates to 1 over the sphere for any g in (-1,1),
/// which is what lets the transmission below be treated as a real BTDF.
fn phaseSchlick(cosTheta: f32, g: f32) -> f32 {
  let k = 1.55 * g - 0.55 * g * g * g;
  let d = 1.0 - k * cosTheta;
  return (1.0 - k * k) / (4.0 * PI * max(d * d, 1e-4));
}

/// Light that enters the far side of a thin structure and leaves toward the
/// eye. ADDITIVE to evalBRDF - it deliberately contains no reflected energy.
///
/// `lightColor` is illuminance, exactly as for evalBRDF, but it must NOT carry
/// the shadow term: a backlit frond shadows its own front face, so a shadowed
/// light kills precisely the configuration this function exists to render.
/// Callers pass the unshadowed light and let `thickness` do the attenuating.
///
/// `thickness` is the real distance through the material in metres (distance
/// to the medial axis * 2 for a generated mesh). Three effects combine:
///
///   1. Beer-Lambert absorption across `thickness`, tinted by (1 - albedo), so
///      the emerging light is both dimmer and more saturated than the front
///      face - a backlit kelp blade goes deep green, not pale green.
///   2. Wrapped diffuse for the near-terminator wrap-around. Only the EXCESS
///      over the Lambert cosine is added, because evalBRDF already paid for
///      the cosine part; adding the whole wrap would double-count the lit side.
///   3. A forward-scattering phase lobe for the hot rim you get looking almost
///      straight into a light through a frond or a jellyfish bell.
fn evalTranslucency(s: SurfaceCtx, lightDir: vec3f, lightColor: vec3f, thickness: f32) -> vec3f {
  if (s.translucency <= 0.0) { return vec3f(0.0); }

  // (1) Transmission through the sheet. Tissue that reflects a wavelength also
  // fails to absorb it, hence extinction proportional to (1 - albedo).
  let sigma = TRANSLUCENCY_EXTINCTION * (vec3f(1.0) - saturate(s.albedo))
            + vec3f(TRANSLUCENCY_FLOOR);
  let transmit = exp(-sigma * max(thickness, 0.0));

  // (2) Wrapped diffuse (Frostbite's normalised wrap). Dividing by (1+w)^2
  // holds the integral over the WHOLE sphere at PI - the same energy plain
  // Lambert puts into its hemisphere - so widening the wrap moves light around
  // the terminator instead of creating it.
  let w = mix(0.15, 1.0, s.translucency);
  let NoL = dot(s.normal, lightDir);
  let wrapped = saturate((NoL + w) / ((1.0 + w) * (1.0 + w)));
  let leak = max(wrapped - saturate(NoL), 0.0);

  // (3) Exit lobe. The light propagates along -lightDir; bending it toward -N
  // by TRANSLUCENCY_DISTORTION makes the glow track the surface shape instead
  // of being a pure function of the light-eye angle. Both terms are unit
  // vectors and the distortion is < 1, so the sum can never be degenerate.
  let exitDir = normalize(-lightDir - s.normal * TRANSLUCENCY_DISTORTION);
  // EMERGENT anisotropy, not the single-scattering g of the tissue. Mesophyll
  // and mesoglea scatter at g ~ 0.9, but light crossing even a 3 mm blade
  // scatters many times and the exit distribution is far broader than that;
  // feeding 0.9 in here gives a frond a peak radiance ~30x a Lambertian's,
  // which reads as a bug rather than as backlight.
  let g = mix(0.35, 0.78, s.translucency);
  let lobe = phaseSchlick(dot(s.viewDir, exitDir), g);

  return lightColor * transmit * s.albedo * s.translucency * (leak * INV_PI + lobe);
}
