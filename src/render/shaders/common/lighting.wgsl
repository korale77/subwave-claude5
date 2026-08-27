// SUBWAVE - clustered forward+ light evaluation.
//
// One file, one job: given a SurfaceCtx, return the radiance leaving it toward
// the eye. It does NOT apply the participating medium - the caller finishes
// with applyWaterMedium()/applyFroxel(), which is the only place beam
// extinction along the VIEW ray and in-scatter are allowed to happen. What this
// file does apply is extinction along each LIGHT ray, which is a different path
// and must not be folded into the view-ray medium.
//
// Conventions:
//   `viewDepth` is the distance along the camera FORWARD axis in metres (what
//     linearizeDepth returns), not the radial distance to the eye.
//   `thickness` is the material's optical thickness in metres, used only when
//     s.translucency > 0; pass 0.0 for opaque surfaces.
//   The shaded position, shading/geometric normals, view vector and ambient
//     occlusion all come from the SurfaceCtx, so nothing here needs the
//     material layer's own uniforms.

#pragma once

#include "frame.wgsl"
#include "math.wgsl"
#include "brdf.wgsl"
#include "shadow.wgsl"
#include "water.wgsl"

/// Cluster grid depth bounds. These are NOT the camera planes: slicing from the
/// 8 cm near plane would spend a third of the slices inside the first metre.
/// The light-culling compute pass must build its cluster AABBs from the exact
/// same two numbers and the same index order, or fragments read another
/// cluster's light list.
const CLUSTER_NEAR : f32 = 0.25;
const CLUSTER_FAR_AIR : f32 = 640.0;
/// Underwater nothing is visible past a few tens of metres, so the whole grid
/// is compressed - which multiplies the effective z resolution exactly where
/// the vessel lamps live.
const CLUSTER_FAR_WATER : f32 = 140.0;

/// Sphere-light radius for punctual sources, metres. Stops the inverse square
/// from exploding when a lamp is mounted flush against the surface it lights.
const LIGHT_SOURCE_RADIUS : f32 = 0.05;

// ---------------------------------------------------------------------------
// Cluster lookup
// ---------------------------------------------------------------------------

fn clusterFarDistance() -> f32 {
  return select(CLUSTER_FAR_AIR, CLUSTER_FAR_WATER, isUnderwater());
}

/// Exponential ("Doom 2016") z slicing:
///
///   slice = floor( log(z / zn) * CLUSTER_Z / log(zf / zn) )
///
/// so the slice boundaries form the geometric series zn * (zf/zn)^(i/N).
/// Uniform slicing is unusable here: with zn = 0.25 m and zf = 640 m a uniform
/// slice would be 26.7 m deep, so the cockpit, the hull and every object the
/// lamps actually illuminate would land in slice 0 and be tested against every
/// light in the frustum, while the outer twenty slices covered empty water.
/// The exponential distribution makes each slice a constant RATIO deeper than
/// the last, which is how perspective compresses depth, and keeps cluster
/// volumes roughly cubic from 0.25 m to the far plane.
fn clusterSliceFromViewDepth(viewDepth: f32) -> u32 {
  let zn = CLUSTER_NEAR;
  let zf = clusterFarDistance();
  let z = max(viewDepth, zn);
  let slice = floor(log(z / zn) * (f32(CLUSTER_Z) / log(zf / zn)));
  return u32(clamp(slice, 0.0, f32(CLUSTER_Z) - 1.0));
}

/// Flat cluster index for a fragment. `fragCoord` is in render-target pixels
/// with the WebGPU convention (origin top-left, +y down); tiles follow that
/// convention so the culling pass and the receiver agree on which tile is 0.
fn clusterIndexFromScreen(fragCoord: vec2f, viewDepth: f32) -> u32 {
  let tile = vec2u(clamp(
    floor(fragCoord * frame.screen.zw * vec2f(f32(CLUSTER_X), f32(CLUSTER_Y))),
    vec2f(0.0),
    vec2f(f32(CLUSTER_X) - 1.0, f32(CLUSTER_Y) - 1.0)));
  let slice = clusterSliceFromViewDepth(viewDepth);
  return (slice * u32(CLUSTER_Y) + tile.y) * u32(CLUSTER_X) + tile.x;
}

// ---------------------------------------------------------------------------
// Punctual falloff
// ---------------------------------------------------------------------------

/// The distance at which a light's `shape.w` falloff mix pivots, metres.
///
/// THE MIX IS AN ART DEVIATION AND THIS IS ITS FULCRUM. A lamp underwater is
/// attenuated on the lamp path AND on the eye path, so a lit surface falls off
/// as 1/d^2 * T(d)^2 - measured on Rock Spires' rock in OCEANIC_CLEAR, the
/// returned radiance relative to 10 m is 6.8x at 4 m and 0.02x at 25 m. The pool
/// is a 6-12 m phenomenon and INTENSITY CANNOT FIX IT: raising candela to reach
/// 25 m clips the 4 m core to featureless white long before it arrives, which is
/// CLAUDE.md's "a brighter object is a whiter one" and is exactly what
/// EXPOSURE_MIN_EV's note records happening to Shelf Break's lamp cone.
///
/// So the falloff itself bends. See punctualAttenuation().
const LIGHT_FALLOFF_PIVOT : f32 = 6.0;

/// Windowed inverse-square falloff:
///
///   saturate(1 - (r/R)^4)^2 / max(r^2, rs^2) * (1 - k + k*r/PIVOT)
///
/// The window is what lets a light have a finite influence radius without a
/// visible edge - raw inverse-square is still around 1% of its peak at the cull
/// radius, so a plain cut-off stamps a hard circle on the seabed. Squaring the
/// quartic window makes both the value and its derivative reach zero exactly at
/// R. The rs clamp turns the point into a small sphere, which bounds the
/// near-field response instead of letting it diverge.
///
/// `k` (Light.shape.w) is a LINEAR BLEND FROM 1/r^2 TOWARD 1/r, normalised so
/// that r = LIGHT_FALLOFF_PIVOT is unchanged whatever k is. k = 0 is the exact
/// inverse square this function has always been, bit for bit, which is what
/// every light that does not opt in still gets and what makes the whole thing
/// bisectable against the old image. At k = 0.35 and the 6 m pivot the curve
/// reads 0.83x at 3 m - LESS near-field blowout, not more - 1.00x at 6 m, 1.53x
/// at 15 m and 2.11x at 25 m.
///
/// It is a multiply-add, not a pow: this function runs per light per fragment
/// AND per light per froxel, 160x90x64 of them, so a transcendental here is not
/// free. The quartic window still drives the result to exactly zero at R, so
/// bending the curve cannot give any light a hard edge.
fn punctualAttenuation(dist: f32, range: f32, sourceRadius: f32, falloffMix: f32) -> f32 {
  let d2 = max(dist * dist, sourceRadius * sourceRadius);
  let window = saturate(1.0 - pow(dist / max(range, 1e-3), 4.0));
  let bend = 1.0 - falloffMix + falloffMix * dist / LIGHT_FALLOFF_PIVOT;
  return window * window / d2 * bend;
}

/// The beam's angular profile: a shaped CORE plus a broad FILL lobe.
///
/// direction.w = cos(outer), spotParams.y = 1/(cos(inner) - cos(outer)),
/// shape.x = fill weight, shape.y = fill power. `toLight` points from the
/// surface to the light; `spotDir` points away from the light along its axis.
///
/// THE CORE IS SMOOTHSTEPPED, NOT SQUARED. `t*t` has a continuous derivative at
/// the OUTER edge only; at the inner edge, where it reaches 1, the derivative
/// jumps, and on a flat rock face that lands as a locatable ring around the
/// hotspot. `t*t*(3-2t)` is flat at both ends, so neither boundary can be found.
///
/// THE FILL IS A COSINE-POWER LOBE AND HAS NO ANGULAR BOUNDARY AT ALL. Its
/// half-power angle is acos(0.5^(1/p)) - p = 1.3 is 58 deg, 1.6 is 53 deg, 2.2
/// is 42 deg - so a soft, edgeless spill reaches far outside the cone without a
/// second light, a second cone angle or a second cluster entry. It is
/// identically zero past 90 deg, so it cannot leak behind the emitter, and the
/// cluster cull is sphere-only (cluster_cull.wgsl) so widening the angular reach
/// culls nothing differently.
///
/// IT IS MIXED, NOT ADDED, AND THAT IS WHAT MAKES `fill` SAFE TO TURN UP. Both
/// terms are 1.0 on the axis, so mix() leaves the axis at exactly 1.0 for any
/// weight: `fill` REDISTRIBUTES the beam into its skirt instead of brightening
/// it, in the same spirit as the mean-1 caustic rule in common/water.wgsl. Added
/// instead, it would be a DC lift of (1 + fill) on the hotspot - the one thing
/// the beam does not need. Measured shape at fill 0.08 / power 2.2 on a 17 deg
/// cone: 1.000 on axis, 0.073 at the cone edge, 0.037 at 45 deg, 0.007 at 70 deg.
///
/// This is the ONE place the profile is defined. evalPunctualLights() and
/// froxelPunctual() both call it, which is what keeps the shaft and the pool the
/// same shape by construction rather than by two tunings that agree today.
fn spotAttenuation(spotDir: vec3f, cosOuter: f32, invCosDelta: f32, toLight: vec3f,
                   fill: f32, fillPower: f32) -> f32 {
  let cosA = dot(spotDir, -toLight);
  let t = saturate((cosA - cosOuter) * invCosDelta);
  let core = t * t * (3.0 - 2.0 * t);
  if (fill <= 0.0) { return core; }
  return mix(core, pow(saturate(cosA), fillPower), fill);
}

// ---------------------------------------------------------------------------
// Punctual lights
// ---------------------------------------------------------------------------

/// Accumulate every light in this fragment's cluster.
///
/// colorIntensity.w is luminous intensity in candela, so colour * intensity *
/// attenuation is illuminance at the surface, which is what evalBRDF() expects.
/// Punctual lights are never shadow-mapped in this build (bind group 0 carries
/// only the sun cascades); Light.spotParams.w is reserved for that.
fn evalPunctualLights(s: SurfaceCtx, fragCoord: vec2f, viewDepth: f32, thickness: f32) -> vec3f {
  let cluster = clusterIndexFromScreen(fragCoord, viewDepth);
  let range = clusterRanges[cluster];
  let count = min(range.y, u32(MAX_LIGHTS_PER_CLUSTER));
  if (count == 0u) { return vec3f(0.0); }

  // Submerged surfaces attenuate every lamp along its own beam path. This is
  // the single most important line in the file for how the game feels: a
  // 42000 cd vessel flood is a wall of white at 5 m, a cold blue cone at 25 m
  // and gone by 60 m, because sigmaT is per-channel and red dies first.
  let submerged = depthAt(s.worldPos) > 0.0;
  let translucent = s.translucency > 0.0;

  var result = vec3f(0.0);
  for (var i = 0u; i < count; i++) {
    let light = lights[clusterIndices[range.x + i]];

    let delta = light.positionRange.xyz - s.worldPos;
    let dist2 = dot(delta, delta);
    let lightRange = light.positionRange.w;
    if (dist2 >= lightRange * lightRange) { continue; }

    let dist = sqrt(max(dist2, 1e-8));
    let L = delta / dist;
    // Back faces still receive transmitted light on translucent tissue, so
    // only cull them for ordinary opaque surfaces.
    if (dot(s.normal, L) <= 0.0 && !translucent) { continue; }

    var attenuation = punctualAttenuation(
      dist, lightRange, LIGHT_SOURCE_RADIUS, light.shape.w);
    if (light.spotParams.z > 0.5) {
      attenuation *= spotAttenuation(
        light.direction.xyz, light.direction.w, light.spotParams.y, L,
        light.shape.x, light.shape.y);
    }
    if (attenuation <= 0.0) { continue; }

    var illuminance = light.colorIntensity.rgb * (light.colorIntensity.w * attenuation);
    // A LAMP IN A DRY ROOM SHINES THROUGH AIR. `submerged` is depthAt() > 0,
    // which is true of every surface in a pressure hull 33 m down, so the
    // habitat's own interior lamps were being attenuated by Beer-Lambert over
    // the lamp-to-wall path: a 4 m throw lost exp(-0.1212*4) = 0.615 in red (REEF sigma_t as it was when measured; 0.0873 since 2026-08-17)
    // against 0.663 in blue, i.e. 38% of the intensity and 7.6% of the R/B
    // ratio, to water that is not in the room. That is a large part of why the
    // rooms rendered cold.
    if (submerged && s.dryInterior < 0.5) {
      illuminance *= waterTransmittance(dist);
    }

    result += evalBRDF(s, L, illuminance);
    if (translucent) {
      result += evalTranslucency(s, L, illuminance, thickness);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Sun and moon
// ---------------------------------------------------------------------------

/// Illuminance of a directional source after crossing the air/water interface
/// and reaching `depth` metres down.
///
/// Snell's law compresses every incoming direction into a 48.6 deg cone about
/// the vertical, so the slant path is only a little longer than the depth. Kd
/// (diffuse attenuation), not sigmaT, is the right coefficient: what survives
/// to depth is the forward-scattered beam plus its halo, and that is exactly
/// the quantity Kd measures. Using sigmaT here would make 40 m pitch black.
fn refractedIlluminance(illuminance: vec3f, dir: vec3f, depth: f32) -> vec3f {
  if (depth <= 0.0) { return illuminance; }
  let refracted = refractDir(-dir, vec3f(0.0, 1.0, 0.0), 1.0 / 1.333);
  let path = depth / max(-refracted.y, 0.2);
  let surfaceTransmit = 1.0 - waterFresnel(max(dir.y, 0.0));
  return illuminance * surfaceTransmit * daylightAtDepth(path);
}

/// Direct sunlight: cascaded shadow, refraction and caustics underwater.
fn evalSun(s: SurfaceCtx, viewDepth: f32, thickness: f32) -> vec3f {
  let L = frame.sunDir.xyz;
  if (L.y <= -0.05) { return vec3f(0.0); }          // below the horizon
  let translucent = s.translucency > 0.0;
  if (dot(s.normal, L) <= 0.0 && !translucent) { return vec3f(0.0); }

  // The shadow lookup is driven by the GEOMETRIC normal: a normal map that
  // tilts away from the sun would otherwise push the lookup position through
  // the surface and stipple flat ground with acne.
  let shadow = sampleShadow(s.worldPos, s.geoNormal, saturate(dot(s.geoNormal, L)), viewDepth);
  if (shadow <= 0.0) { return vec3f(0.0); }

  let depth = depthAt(s.worldPos);
  var illuminance = refractedIlluminance(frame.sunIlluminance.rgb, L, depth);
  if (depth > 0.0) {
    // Caustics are focused sun: they REDISTRIBUTE this beam, taking light out
    // of the cells and putting it in the filaments, and they add nothing.
    // causticFactor() is mean-1 over the tile and returns exactly 1 where the
    // depth fade has already killed the direct beam. frame.waterSurface.x is
    // the energy knob, applied inside it.
    illuminance *= causticFactor(s.worldPos, s.normal, depth);
  }
  illuminance *= shadow;

  var result = evalBRDF(s, L, illuminance);
  if (translucent) {
    result += evalTranslucency(s, L, illuminance, thickness);
  }
  return result;
}

/// Moonlight. Never shadow-mapped: at a quarter of a lux the shadow it casts is
/// far below the noise floor of everything else in the frame, and it would cost
/// a second set of cascades.
fn evalMoon(s: SurfaceCtx, thickness: f32) -> vec3f {
  let L = frame.moonDir.xyz;
  if (L.y <= -0.05) { return vec3f(0.0); }
  let translucent = s.translucency > 0.0;
  if (dot(s.normal, L) <= 0.0 && !translucent) { return vec3f(0.0); }

  let illuminance = refractedIlluminance(frame.moonIlluminance.rgb, L, depthAt(s.worldPos));
  var result = evalBRDF(s, L, illuminance);
  if (translucent) {
    result += evalTranslucency(s, L, illuminance, thickness);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Ambient
// ---------------------------------------------------------------------------

/// SH-L2 irradiance lookup.
///
/// Renderer.updateAmbientSH() folds the Lambertian cosine convolution and the
/// 1/PI into the coefficients but NOT the basis normalisation constants, so
/// those appear here. The result is diffuse radiance for an albedo of 1: for a
/// uniform environment of radiance L it returns exactly L.
fn evalAmbientSH(n: vec3f) -> vec3f {
  let c = frame.ambientSH;
  var r = c[0].xyz * 0.282095;
  r += c[1].xyz * (0.488603 * n.y);
  r += c[2].xyz * (0.488603 * n.z);
  r += c[3].xyz * (0.488603 * n.x);
  r += c[4].xyz * (1.092548 * n.x * n.y);
  r += c[5].xyz * (1.092548 * n.y * n.z);
  r += c[6].xyz * (0.315392 * (3.0 * n.z * n.z - 1.0));
  r += c[7].xyz * (1.092548 * n.x * n.z);
  r += c[8].xyz * (0.546274 * (n.x * n.x - n.y * n.y));
  return max(r, vec3f(0.0));
}

/// Sky-view LUT uv from Frame data alone.
///
/// This REPRODUCES atmosphere.wgsl's skyViewUV()/skyViewV()/horizonZenithAngle()
/// rather than calling them, and that is a deliberate duplication with a
/// specific cause: atmosphere.wgsl declares its uniform on SKY_GROUP, which
/// defaults to group 1, and every geometry pass owns group 1 for its own
/// per-draw block. A pass therefore cannot include atmosphere.wgsl at all, even
/// though the LUT it wants is already bound at group 0 binding 7. Frame.
/// skyGeometry carries the three numbers the parameterisation needs, written
/// from the same constants and the same altitude clamp sim/sky.js uses, so this
/// indexes the texels the LUT was actually generated for.
///
/// The texel-centre inset (0.5/n .. 1-0.5/n) is inlined for the same reason:
/// pass/ocean_surface.wgsl includes BOTH this file and atmosphere.wgsl, so a
/// helper named texCoordFromUnit here would collide with the real one there.
fn frameSkyUV(dir: vec3f) -> vec2f {
  let Rg = frame.skyGeometry.x;
  let r = Rg + max(frame.skyGeometry.z, 0.0);
  // The horizon dips below the geometric horizontal by acos(Rg/r); the LUT's
  // v = 0.5 row sits exactly on it, with sqrt density either side.
  let thetaH = HALF_PI + acos(clamp(Rg / max(r, 1.0), -1.0, 1.0));
  let theta = acos(clamp(dir.y, -1.0, 1.0));

  // u folds azimuth about the sun into [0, PI]: the atmosphere is mirror
  // symmetric about the plane through the zenith and the sun.
  let sunH = frame.sunDir.xz;
  let sunLen = length(sunH);
  let sh = select(vec2f(0.0, -1.0), sunH / max(sunLen, 1e-6), sunLen > 1e-4);
  let h = dir.xz;
  let hLen = length(h);
  var cosAz = 1.0;
  if (hLen > 1e-5) { cosAz = clamp(dot(h / hLen, sh), -1.0, 1.0); }

  var l: f32;
  if (theta < thetaH) { l = (theta - thetaH) / max(thetaH, 1e-4); }
  else { l = (theta - thetaH) / max(PI - thetaH, 1e-4); }
  let s = sign(l) * sqrt(abs(l));

  let u = acos(cosAz) * INV_PI;
  let v = 0.5 + 0.5 * s;
  return vec2f(0.5 / 256.0 + saturate(u) * (1.0 - 1.0 / 256.0),
               0.5 / 128.0 + saturate(v) * (1.0 - 1.0 / 128.0));
}

/// Environment radiance along a reflection vector, prefiltered by roughness.
///
/// The SH probe alone CANNOT be a specular environment. Its coefficients are
/// irradiance (renderer.updateAmbientSH folds the Lambertian cosine kernel and
/// 1/PI into them), so the sharpest lobe it can represent is ~90 degrees wide.
/// Measured live at the spawn framing: the whole sphere of evalAmbientSH spans
/// 2.67:1 from zenith to nadir, while the sky-view LUT it stands under spans
/// 24:1 in luminance - (0.42, 0.85, 1.87) at the zenith against (25.0, 19.3,
/// 11.9) at the sunward horizon. A roughness-0.038 canopy and a roughness-0.9
/// panel were being handed the same featureless grey, which is precisely why
/// polished metal read as painted clay.
///
/// Two blends, both toward the SH:
///   - by ROUGHNESS, because one tap of an unfiltered LUT is only correct for a
///     mirror; past roughness 0.6 the SH average is the better answer anyway.
///   - BELOW THE HORIZON, because the LUT's lower rows hold the planet's mean
///     ground albedo, whereas the SH carries the local ground colour that
///     sim/sky.js measured. The band is soft so a curved hull shows a horizon
///     in its reflection instead of a cut line.
fn envRadiance(R: vec3f, roughness: f32) -> vec3f {
  let sharp = textureSampleLevel(skyLUT, linearClampSampler, frameSkyUV(R), 0.0).rgb;
  let blend = max(smoothstep(0.10, 0.60, roughness), smoothstep(0.02, -0.16, R.y));
  return mix(sharp, evalAmbientSH(R), blend);
}

/// Jimenez' albedo-tinted multi-bounce AO fit. A crease keeps some of the
/// colour it would have picked up bouncing off its own walls; flat `ao` makes
/// bright sand read as soot. Already contains the single-bounce term, so it
/// REPLACES ao rather than multiplying it.
fn aoMultiBounce(ao: f32, albedo: vec3f) -> vec3f {
  let a = 2.0404 * albedo - vec3f(0.3324);
  let b = -4.7951 * albedo + vec3f(0.6417);
  let c = 2.7552 * albedo + vec3f(0.6903);
  return saturate(max(vec3f(ao), ((ao * a + b) * ao + c) * ao));
}

// ---------------------------------------------------------------------------
// The submerged ambient field's SHAPE - the deep key on the ILLUMINATION path
// ---------------------------------------------------------------------------

/// THE DEEP KEY LIT THE MEDIUM AND SHADED NOTHING, AND THAT IS WHY IT COST VALUE
/// STRUCTURE INSTEAD OF BUYING IT.
///
/// pass/underwater.wgsl adds deepKeyInScatter() to the water in FRONT of a
/// pixel. That paints the haze and leaves the surface behind it exactly as
/// flatly lit as it was, which raises the FLOOR of the value distribution
/// without giving anything a lit side and a dark side - measured on the
/// 14-anchor tour when the composite half shipped alone, p95/p05 FELL at five of
/// seven deep anchors (trenchWall 3.557 -> 3.097, trenchFloor 3.286 -> 3.126,
/// spires 7.860 -> 6.613, canyon 11.330 -> 10.462, abyssal 8.066 -> 7.896). A
/// source that is only ever in front of things is fog, not a key.
///
/// So the same field is put on the ILLUMINATION path here. `deepKeyRadiance` is
/// authored as the ASYMPTOTIC RADIANCE - the radiance a point deep in a
/// scattering medium is surrounded by, the fixed distribution the field relaxes
/// to once it has forgotten the sky - so a surface standing in it reflects
/// exactly that for an albedo of 1, which is the same quantity evalAmbientSH()
/// returns and drops into the same slot. That makes the magnitude a
/// CONSEQUENCE of an already-authored number rather than a new one to tune, and
/// it is why this cannot blow the exposure rail: the surface returns
/// albedo x field against a haze the composite has already put at 1.0 x field in
/// front of it, so it is strictly DARKER than its own background. Being darker
/// than the background is what a SILHOUETTE is.
///
/// IT DELIVERS WHERE THE DEEP FIELD IS WHAT LIGHTS THE SURFACE, AND IT IS
/// UNMEASURABLE ON THE VARIETY TOUR, WHOSE OWN FIXED CONDITIONS PUT A HEADLIGHT
/// ON EVERY DEEP FRAME. This block used to assert a tour recovery as a SHIPPED
/// figure - p95/p05 trenchWall 3.0966 -> 3.2617 (+5.3%), trenchFloor 3.1263 ->
/// 3.2603 (+4.3%), with break/canyon/spires/abyssal beside them - and the
/// shipped build does not reproduce it. Those columns are `s2.json` against
/// `s23-nl-final.json`, all six anchor pairs and both cosine figures matching to
/// four decimals: a comparison of two BUILDS that differ by more than this term,
/// since s23-nl-final also carries stage 2.2 and 2.3. 3.2617 is also a lone
/// reading that three committed tours of the shipped build either side of it -
/// s2 3.0966, rev-stage2 3.0919, s2-closed 3.0919 - do not reproduce.
///
/// RE-MEASURED as an A/B OF THIS TERM ALONE, on the tour at its own pose,
/// settle, day fraction and lamp policy, three runs per arm with each run's
/// control tour counted as a second reading (n = 6 per arm). The off arm zeroes
/// `keyField` below and leaves pass/underwater.wgsl's composite half running,
/// which is what the retired table claimed to be:
///
///   p95/p05  trenchWall   ON 3.0961 [3.0904, 3.1010]  OFF 3.0883 [3.0746, 3.0966]  +0.25%
///            trenchFloor  ON 3.1255 [3.1060, 3.1342]  OFF 3.1327 [3.1274, 3.1396]  -0.23%
///   shape only (formAmount forced to 0, the energy kept):
///            trenchWall   3.0947 (+0.04%)   trenchFloor 3.1198 (+0.18%)
///
/// Every pair of ranges overlaps, the sign disagrees between the two anchors,
/// and the two frames are indistinguishable side by side. The ONE quantity that
/// separates cleanly is trenchFloor's p05L - ON 0.0593420 at all six readings,
/// OFF 0.0590431-0.0590588, no overlap - i.e. the illumination half lifts that
/// floor by 0.48%, which moves p95/p05 the WRONG way, for exactly the reason the
/// composite half did.
///
/// WHY, AND IT IS NOT THAT THE TERM IS DEAD. Same-boot, same-frozen-frame knob
/// A/B at the tour's own pose, scene-linear off `sceneColor`, repeated on two
/// boots: at trenchWall the whole deep key is 5.2% / 5.4% of the delivered frame
/// with the diver's suit lamp lit and 57.6% / 57.8% of it with the lamp out,
/// because the lamp is 10.9x / 10.8x the entire rest of that frame (trenchFloor:
/// 5.1% / 4.9%, 49.9% / 50.2%, 9.9x / 9.8x). DEEP_KEY_RADIANCE x8 raises the
/// frame 37.6% / 37.8%, so the path is live and monotonic and the magnitude is
/// merely small - and written the way the rail paragraph below writes it, as a
/// lift over the off arm, that same trenchWall pair is +5.44% / +5.72% against
/// its +5.7%, so that paragraph reproduces and stands. THE TOUR LIGHTS THE SUIT
/// LAMP AT EVERY ANCHOR BELOW 150 m; it is one of its own fixed conditions. A
/// headlight sits AT THE EYE, so it has no lit side and no dark side by
/// construction, and at the trench anchors it out-delivers this key by an order
/// of magnitude. Shaping the 5% left over cannot show up in a frame the other
/// 95% has already flattened.
///
/// A LEAD FOR WHOEVER REVISITS IT: removing only the SHAPE makes those frames
/// BRIGHTER (+4.6% at trenchWall, +11.7% at trenchFloor lamp-lit, +113% at
/// trenchFloor lamp-out), so the geometry these two poses actually frame is
/// sitting on the ANTI-key side of `frame.deepKeyDir` and is being darkened on
/// average rather than keyed. The factor is mean 1 over the SPHERE of normals,
/// which says nothing about the normals a given camera sees.
///
/// So: keep it, on those terms and not on a p95/p05 recovery. It is half the
/// light in an unlit deep frame, it costs a dot product, the rail measurement
/// below is unaffected, and a composite half with no surface counterpart is fog
/// (the paragraph above this one). What would move the two trench frames is the
/// suit lamp's own shape and the biolume around it - Stage 3 content, not light
/// selection.
///
/// AND ONE THING ABOUT THE INSTRUMENT, since it is what the retired claim was
/// read off: at trenchWall p05L took exactly TWO values across all twelve
/// readings of both arms (0.0643961 and 0.0644118, 0.02% apart) and repeats
/// bit-exactly between boots, because the 5th percentile there stands on one
/// large flat plateau. With a near-constant denominator p95/p05 is reporting p95
/// and almost nothing else - which is why the ON-OFF difference in p95 (+0.25%)
/// IS the ON-OFF difference in the ratio to two decimals. The deep-seven pair
/// cosine the retired table also quoted (0.7074 -> 0.6887) came from the same
/// contaminated pair and a two-anchor tour cannot re-measure it; stage 2 closed
/// at 0.6155, below both, against s1-done's 0.6674.
///
/// WHAT IT COSTS ON THE RAIL. Same-frame A/B toggling RENDER.DEEP_KEY_RADIANCE
/// between two readbacks of one settled frame (scene-linear, off `sceneColor`):
/// +0.315% at Boulder Field (100 m) and +0.383% at Twilight Terraces (205 m),
/// both inside the half-percent this term was allowed above 320 m, and +5.7% at
/// Trench Wall - of which the composite's half was already +0.071 EV, so this
/// one is about +0.009 EV. The delivered auto-exposure gain reads its 25.6
/// ceiling in BOTH arms at every station, i.e. the rail did not unpin. The Shelf
/// Break reading (-2.2%) is below that station's own frame-to-frame spread
/// (0.066 EV = 4.6% between repeats of a single arm) and is not resolvable; it
/// is a reduction rather than a lift either way.
///
/// It is shaped by `frame.deepKeyDir` and nothing else - the same direction the
/// composite's phase lobe uses, so a near ridge and the haze behind it cannot
/// disagree about where the light is, and ONE direction for the whole submerged
/// column so the shelf and the trench are lit from the same place. NOT the sun:
/// below TRUE_DARK_DEPTH there is no sun, and a key that swung with the clock
/// would re-frame every deep screenshot with the time of day.
///
/// WHAT IS DELIBERATELY *NOT* SHAPED IS THE DAYLIGHT SH, AND THAT WAS A
/// MEASUREMENT, NOT AN OVERSIGHT. The obvious larger move is to reshape the
/// whole submerged ambient, on the sound argument that renderer.updateAmbientSH()
/// projects the ABOVE-WATER sky triple and so hands every submerged surface an
/// angular distribution spanning only 2.67:1 zenith-to-nadir (see envRadiance),
/// where the real submerged field is strongly downwelling. It was built and
/// measured that way first, both with the factor pivoted on a level seabed and
/// with it pivoted on the sphere mean, and it does not pay:
///
///   anchor      p95/p05  s2 -> level-pivot -> sphere-pivot   flat fraction
///   boulders    2.4067 -> 2.2104 -> 2.3428                   0.4658 -> 0.4553
///   break       3.3935 -> 3.3906 -> 3.3952                   0.2064 -> 0.1973
///   trenchWall  3.0966 -> 3.2825 -> 3.2690                   0.2527 -> 0.2359
///
/// The trench columns are the key doing the work (daylightAtDepth is 1e-8 there,
/// so the SH is nil and only the key is left); the two mid-depth columns are the
/// SH reshape doing all of it, and it buys 2% of flat fraction for 2.7% of
/// p95/p05 at Boulder Field while moving the frame's delivered mean by +0.9%,
/// i.e. past the half-percent this change was allowed to move any frame above
/// 320 m. Pushed to a deliberately extreme strength (3.0, ramp opened at the
/// surface) the same reshape made Boulder Field FLATTER, not less flat -
/// p95/p05 2.21 -> 1.83, flat fraction 0.483 -> 0.676, delivered mean -16% -
/// because darkening the ambient slides the seabed down into the AgX toe, which
/// is the same trap as "a brighter object is a whiter one" run backwards.
///
/// The deeper reason it cannot work is geometric and it is worth stating so the
/// next reader does not rebuild it: BOULDER FIELD IS A NEAR-HORIZONTAL SEABED
/// UNDER A NEAR-VERTICAL LIGHT. The sun at 98 m still delivers 8.6% of its blue
/// through the column and it already carries a real N.L, the key direction is
/// 59 deg up, and both of them light every horizontal facet identically. No
/// reshaping of a downwelling field can put a dark side on a flat floor - only a
/// cast shadow, a vertical face, or a local lamp can, which is items 2.1, 2.2
/// and Stage 3 and not this one.

/// The optical depth over which the field is taken to have become the asymptotic
/// one, measured in the DEEPEST-PENETRATING channel (min Kd).
///
/// Optical depth and not metres, because that is the quantity the physics turns
/// on and because it then varies with the water the way it should: tau reaches
/// the upper edge at 66 m in COASTAL_GREEN (Kd_min 0.0754/m), at 198 m in
/// OCEANIC_CLEAR (0.0253) and at 275 m in ABYSSAL_VOID (0.0182). A turbid
/// inshore column goes diffuse in tens of metres; the clear blue stays
/// ballistic for hundreds, which is per-biome variation for free and for the
/// right reason.
///
/// The MIN channel is the conservative read: the last channel to stop being
/// ballistic is the one that still has light in it at depth, and it is the one
/// whose shape the eye is looking at. Measured tau at the tour's anchors -
/// boulders 2.45, break 4.65, terrace 5.11, spires 6.64, canyon 9.15, abyssal
/// 13.79, trenchWall 17.67, trenchFloor 18.71 - against reef 0.25 and coral 0.48,
/// so the shallow half of the tour sits below the lower edge, where smoothstep
/// returns EXACTLY 0.0 and this term is bit-for-bit absent.
const DEEP_FIELD_TAU_LO : f32 = 1.0;
const DEEP_FIELD_TAU_HI : f32 = 5.0;

/// How far the shaped key swings either side of its own mean, at full amount.
///
/// IT IS A REDISTRIBUTION AND THE NORMALISATION IS WHAT PROVES IT. The factor is
/// `1 + a*(2*w - 1)` with `w = (N.K + 1)/2` the half-lambert wrap, and the mean
/// of `2w - 1 = N.K` over the sphere of normals is exactly ZERO - so the factor
/// is mean 1 over the sphere for any strength and any key direction, and it can
/// only move light from the anti-key hemisphere to the key hemisphere. This is
/// the same discipline causticFactor() keeps and for the same reason: a knob
/// that changes energy while claiming to change shape drives auto-exposure.
/// At 0.85 the factor runs 1.85 straight at the key, 1.0 across it and 0.15 away
/// from it - a 12:1 lit-to-dark ratio on a form the deep previously delivered
/// at 1:1.
///
/// Half-lambert and not clamped N.L, because clamped N.L is exactly zero over a
/// whole hemisphere: the anti-key side of every object would go to the same
/// black and stop carrying shape at all, which is the flat read this term
/// exists to remove, merely darker. The wrap is also smooth through the
/// terminator, so a rounded boulder gets a gradient rather than a locatable
/// line - the same reason spotAttenuation() smoothsteps its core.
const DEEP_FORM_STRENGTH : f32 = 0.85;

/// The amount of asymptotic character at a point: 0 above water and inside the
/// first optical depth, 1 once the field has relaxed. Gates the key's radiance
/// AND its shaping, because "asymptotic radiance" is only the radiance a point
/// sits in once the field IS asymptotic - one ramp, one justification.
fn deepFieldAmount(pointDepth: f32) -> f32 {
  if (pointDepth <= 0.0) { return 0.0; }
  let kd = frame.waterKd.rgb;
  let kdMin = min(kd.x, min(kd.y, kd.z));
  return smoothstep(DEEP_FIELD_TAU_LO, DEEP_FIELD_TAU_HI, kdMin * pointDepth);
}

/// The directional factor: mean 1 over the sphere of normals, by construction.
/// `amount` is the strength already scaled by the depth ramp and by the live
/// DEEP_KEY_DIRECTIONALITY knob; at 0 it returns exactly 1.0.
fn deepKeyForm(n: vec3f, amount: f32) -> f32 {
  if (amount <= 0.0) { return 1.0; }
  return max(0.0, 1.0 + amount * dot(n, frame.deepKeyDir.xyz));
}

/// Distant ambient: SH diffuse plus a split-sum specular lobe, both occluded by
/// s.occlusion (the caller multiplies SSAO into that field before shading).
///
/// THE COLUMN IS MEASURED FROM THE SURFACE DOWN TO THE POINT, NOT FROM THE
/// CAMERA DOWN TO THE POINT. renderer.updateAmbientSH() projects the
/// ABOVE-WATER zenith/horizon/ground triple, so these coefficients are the sky
/// as seen from the air no matter where the camera is, and the light that
/// reaches a submerged point has crossed every metre of water above it.
///
/// This used to remove only daylightAtDepth(pointDepth - cameraDepth). That is
/// the VIEW path, which is pass/underwater.wgsl's job and is applied there; the
/// ILLUMINATION path was missing entirely, so a point at the camera's own depth
/// lost nothing at all and the seabed was lit by the surface sky at any depth.
/// Measured by stubbing sky._updateAmbient and zeroing env.ambientSH, the SH
/// was 63.7% of the frame at 8 m, 94.1% at 118 m and 100.0% at 900 m, against a
/// blue Beer-Lambert survival of 0.817 / 0.0505 / 7.7e-8 - which is why the
/// trench wall at 900 m photographed as a brilliant electric blue that read
/// BRIGHTER than the 118 m twilight station.
///
/// Kd and never sigmaT, for the reason refractedIlluminance() gives: what
/// survives to depth is the forward-scattered beam plus its halo, and that is
/// the quantity Kd measures. sigmaT here would make 40 m pitch black.
///
/// The interface's own diffuse transmittance is NOT folded in. For a sky dome
/// over water it is 1 - <F> ~ 0.93, i.e. a flat 7% against an exponential that
/// spans eight decades over the playable column, and it would be a second
/// unaudited constant sitting beside WATER_SKY_SHARE (which is 0.28 for the
/// in-scatter source in common/water.wgsl - the two do not agree, and
/// reconciling them is a separate measurement).
/// A SEALED ROOM'S FILL LIGHT IS ITS OWN PAINT, NOT THE SEA.
///
/// Radiance for an albedo of 1, i.e. the same quantity evalAmbientSH returns.
/// The depth term above is correct and load-bearing, but at 33 m in reef water
/// daylightAtDepth is [0.072, 0.090, 0.296] - a 1 : 4.1 red-to-blue key - so
/// whatever magnitude survives into a pressure hull is BLUE, and no amount of
/// occlusion changes that. Measured off the delivered commons frame, the room's
/// illuminant was 1 : 0.88 : 2.21: green below red while blue sat 2.2x above it,
/// which is the definition of lavender. About 90% of the room's blue was sky and
/// about 67% of its red was the lamp, and the mid-spectrum fell in the hole
/// between a blue sky and a 1900 K bulb.
///
/// Sized as the cavity interreflection rho/(1-rho) ~ 0.28 of the direct lamp
/// illumination and coloured by the room's own mean albedo. It must NOT be
/// multiplied by columnLoss, surfaceDaylightFraction() or anything else that
/// tracks daylight: a sealed room's bounce tracks its own lamps. If it goes dark
/// at night, the room is wrong.
const HAB_ROOM_BOUNCE : vec3f = vec3f(0.85, 0.66, 0.44);
/// How much of the real column still reaches a sealed room. Deliberately not
/// zero, so the commons under its glass dome is not identical to a corridor with
/// no windows at all. One constant to bisect.
const HAB_SKY_LEAK    : f32   = 0.08;

fn evalAmbient(s: SurfaceCtx) -> vec3f {
  let pointDepth = max(depthAt(s.worldPos), 0.0);
  var columnLoss = vec3f(1.0);
  if (pointDepth > 0.0) {
    columnLoss = daylightAtDepth(pointDepth);
  }

  let ao = s.occlusion;
  let diffuseColor = surfaceDiffuse(s);

  // ---- the deep key, on the ILLUMINATION path -----------------------------
  // See the block above deepFieldAmount() for the whole derivation: this is the
  // one source that survives aphoticFactor, put on the surface instead of only
  // in the water in front of it, and shaped so that a form has a lit side and a
  // dark side.
  //
  // NOT the medium a second time. This is a surface reflectance term. The
  // composite still owns extinction and in-scatter along the view ray and still
  // applies both, exactly once, to what leaves here.
  //
  // ADDED to the daylight ambient rather than mixed with it, and it needs no
  // aphotic gate of its own because the handover is then automatic and
  // continuous: in OCEANIC_CLEAR the daylight column still delivers 8.6% of the
  // surface sky at 97 m against a key of 6.5e-4, so the key is a fraction of a
  // percent of the ambient there, while by 500 m the column is down to 1.1e-4
  // and the two have crossed over. A second smoothstep edge beside the
  // composite's would only be a second thing to drift.
  //
  // BISECT, and it is exact: `RENDER.DEEP_KEY_RADIANCE = [0, 0, 0]` makes
  // keyField the zero vector and every product below reverts, bit for bit, to
  // the build before this term - the same live off-switch that already bisects
  // the composite's half, so the deep key remains ONE knob and not two.
  // `RENDER.DEEP_KEY_DIRECTIONALITY = 0` keeps the light and removes only the
  // shape, which is the A/B that says whether the FORM or the energy is doing
  // the work.
  let fieldAmount = deepFieldAmount(pointDepth);
  let keyField = frame.deepKeyRadiance.rgb * fieldAmount;
  let formAmount = DEEP_FORM_STRENGTH * saturate(frame.deepKeyRadiance.w) * fieldAmount;
  let keyDiffuse = keyField * deepKeyForm(s.normal, formAmount);

  // envDiffuseMultiScatter hands the diffuse lobe exactly the energy the
  // multi-scatter specular lobe did not reflect, so the two below sum to <= 1.
  // The sky, or the room's own bounce - see HAB_ROOM_BOUNCE. Everything that is
  // not a sealed interior has dryInterior = 0 and takes the first branch
  // exactly as before.
  let skyDiffuse = evalAmbientSH(s.normal) * columnLoss + keyDiffuse;
  let ambDiffuse = mix(skyDiffuse,
                       HAB_ROOM_BOUNCE + HAB_SKY_LEAK * skyDiffuse, s.dryInterior);
  let diffuse = ambDiffuse
              * envDiffuseMultiScatter(s.f0, diffuseColor, s.roughness, s.NoV)
              * aoMultiBounce(ao, diffuseColor);

  let R = reflect(-s.viewDir, s.normal);
#ifdef SHARP_ENV_SPECULAR
  // The reflected lobe reads the real sky-view LUT (see envRadiance) instead of
  // the irradiance SH, so roughness finally changes WHAT is reflected and not
  // merely how much. Opted into per pass by a #define before the include: the
  // hull is the one surface in the frame whose whole material story is its
  // reflection, and it is a 256x128 bilinear tap per fragment.
  //
  // Submerged surfaces keep the SH. The camera is in a different medium from
  // the sky, and the SH is the one probe that was built for the medium the
  // camera is actually in - handing a submerged hull the above-water sky would
  // paint it with a horizon it cannot see.
  let envRad = select(envRadiance(R, s.roughness), evalAmbientSH(R),
                      depthAt(s.worldPos) > 0.0);
#else
  // There is no prefiltered environment cube in bind group 0, so the reflected
  // lobe reuses the SH evaluated along R. That is exact for fully rough
  // surfaces and too soft for polished ones - which is precisely the range SSR
  // then covers.
  let envRad = evalAmbientSH(R);
#endif
  // The key is one radiance field, so the reflected lobe samples it too - in the
  // mirror direction, which is the same split-sum approximation envRad is
  // already standing on.
  let skySpec = envRad * columnLoss + keyField * deepKeyForm(R, formAmount);
  let ambSpec = mix(skySpec, HAB_ROOM_BOUNCE + HAB_SKY_LEAK * skySpec, s.dryInterior);
  let specular = ambSpec
               * envSpecularMultiScatter(s.f0, s.roughness, s.NoV)
               * specularOcclusion(s.NoV, ao, s.roughness);

  return diffuse + specular;
}

// ---------------------------------------------------------------------------
// Everything
// ---------------------------------------------------------------------------

/// The same sum evalLighting() returns, with the AMBIENT term reported
/// separately. The SSAO gate (see aoGate() in common/water.wgsl and
/// RENDER.SSAO_* in core/constants.js) needs the ambient share of the final
/// fragment, and this is the only decomposition that does not evaluate
/// evalAmbient() twice - the SH, the deep key and the multi-scatter fits are
/// not cheap enough to run once for the total and once for the ratio.
struct LightingSplit {
  total   : vec3f,
  ambient : vec3f,
};

fn evalLightingSplitTranslucent(s: SurfaceCtx, fragCoord: vec2f, viewDepth: f32,
                                thickness: f32) -> LightingSplit {
  var r : LightingSplit;
  r.ambient = evalAmbient(s);
  r.total = evalSun(s, viewDepth, thickness)
          + evalMoon(s, thickness)
          + evalPunctualLights(s, fragCoord, viewDepth, thickness)
          + r.ambient;
  return r;
}

/// Full shading for one point, including translucency for organics.
/// The caller still owes the medium (applyWaterMedium / applyFroxel) and the
/// emissive term.
fn evalLightingTranslucent(s: SurfaceCtx, fragCoord: vec2f, viewDepth: f32, thickness: f32) -> vec3f {
  return evalLightingSplitTranslucent(s, fragCoord, viewDepth, thickness).total;
}

/// Full shading for an opaque surface.
fn evalLighting(s: SurfaceCtx, fragCoord: vec2f, viewDepth: f32) -> vec3f {
  return evalLightingTranslucent(s, fragCoord, viewDepth, 0.0);
}
