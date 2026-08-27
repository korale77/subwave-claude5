// SUBWAVE - volumetric injection (stage 1 of 2).
//
// Writes the UNINTEGRATED source and density of one froxel:
//
//   rgb = sigma_s * J  - the light scattered INTO the view ray per metre at
//         this point, in the renderer's scene-linear pre-exposure units, with
//         the local density factor already folded in.
//   a   = the local density fraction in [0,1]. Stage 2 multiplies it by the
//         frame's per-channel base extinction, which is why a scalar is enough:
//         the medium is homogeneous per frame (one water type, one fog density)
//         and only its PRESENCE varies from froxel to froxel. Storing a scalar
//         sigma_t instead would throw away the per-channel colour that makes
//         red die first, and there is no fourth channel to put it in.
//
// WHAT THIS VOLUME OWNS, and it is deliberately not everything (the full rule
// is at the top of froxel_integrate.wgsl):
//
//   the COLLIMATED solar beam - the only term that carries god rays - and the
//   PUNCTUAL lamps, which the analytic model in common/water.wgsl does not have
//   at all. The diffuse field, the transmittance and the deep tint stay
//   per-pixel and analytic where they already are.
//
// ONE MEDIUM PER FRAME, chosen by the LATCHED isUnderwater() flag, never by
// depthAt() alone. With the eye submerged the volume carries water and injects
// nothing above the waterline; with the eye in air it carries the aerial fog
// and injects nothing BELOW it, because applyViewRayWater() still owns the wet
// segment of every geometry ray in that case. The two halves are disjoint by
// construction, which is what makes double application impossible rather than
// merely unlikely.

#include "../common/frame.wgsl"
#include "../common/math.wgsl"
#include "../common/water.wgsl"
#include "../common/lighting.wgsl"

struct FroxelParams {
  /// x = history blend (0 = no history), y = reserved (the caustic normaliser
  /// is the per-channel CAUSTIC_TILE_MEAN_* defines now), z = 1 when the eye is
  /// submerged, w = waterline half-band (m)
  cfg : vec4f,
};

@group(1) @binding(0) var<uniform> vol : FroxelParams;
@group(1) @binding(1) var densityOut  : texture_storage_3d<rgba16float, write>;
@group(1) @binding(2) var densityPrev : texture_3d<f32>;

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

/// Sun visibility for a point in the VOLUME - one shadow tap, not the receiver's
/// Vogel disk.
///
/// sampleShadow() takes SHADOW_PCF_TAPS taps and up to two cascades, which at
/// the HIGH tier is 16 taps; against 921,600 froxels that is 29 million
/// comparison lookups a frame for a quantity with no surface to acne against
/// and no silhouette to resolve. One tap plus the temporal accumulation in this
/// pass (RENDER.FROXEL_HISTORY_BLEND, ten effective frames) is the right trade
/// for a volume - the penumbra a PCF kernel would buy is smaller than a single
/// froxel almost everywhere in the grid.
///
/// The bias, the cascade selection and the underwater fade are the receiver's
/// own, from common/shadow.wgsl, so a shaft in the volume and the shadow on the
/// ground under it are cast by the same cascade with the same offset.
fn froxelSunVisibility(worldPos: vec3f, viewDepth: f32) -> f32 {
  let shadowFar = frame.camPlanes.y;
  if (viewDepth >= shadowFar) { return 1.0; }

  let cascade = selectCascade(viewDepth);
  let clip = shadowMatrices[cascade] * vec4f(worldPos, 1.0);
  // A zeroed matrix is the documented "this cascade is off" state.
  if (clip.w <= 0.0) { return 1.0; }
  let ndc = clip.xyz / clip.w;
  let uv = ndc.xy * vec2f(0.5, -0.5) + vec2f(0.5);
  if (ndc.z <= 0.0 || any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return 1.0; }

  // NoL = 1: a volume has no normal, and at normal incidence applyNormalOffset()
  // and the slope term both vanish, leaving exactly the constant texel bias.
  let reference = ndc.z + shadowDepthBias(1.0, cascade);
  var vis = textureSampleCompareLevel(
    shadowAtlas, shadowSampler, uv, cascade, reference);

  // Fade to lit over the last tenth of the shadow range, so the volume does not
  // step from shadowed to lit on a plane across the middle of the frame.
  vis = mix(1.0, vis, saturate((shadowFar - viewDepth) / (shadowFar * 0.1)));

  // Deep light has been scattered so many times that it arrives from
  // everywhere; the authored fade is the same one every receiver uses.
  let depth = depthAt(worldPos);
  if (depth > 0.0) {
    vis = mix(1.0, vis, underwaterShadowStrength(depth));
  }
  return vis;
}

/// Irradiance ratio of the refracted solar beam at a point IN the water column.
///
/// THIS IS WHAT MAKES A SHAFT A SHAFT. It is the same projection causticFactor()
/// uses - back up the refracted sun direction to the surface patch this beam
/// entered through - so a bright filament in the volume lands on exactly the
/// patch of seabed it illuminates, and the two move together as the sun and the
/// waves do. No `facing` term: a volume has no surface normal.
///
/// MEAN-PRESERVING. sim/caustics.wgsl produces E = 1/|det J|, which is unity on
/// a flat sea by construction - but the |det| floor and the clamp add energy at
/// the folds, and the tile measures a mean of 1.32619/1.33375/1.34513 RGB
/// rather than 1.000. Dividing by that measured mean (RENDER.CAUSTIC_TILE_MEAN)
/// makes the modulation redistribute the beam without brightening it. That
/// constant is now weather- and heading-independent to +/-0.32%, where the
/// deleted windGain made the true mean span 1.046 in a fogbank to 1.341 in a
/// storm against ONE baked 1.084. There is deliberately NO contrast knob on
/// top: the honest ratio spans 0.20x to 4.50x of its own mean, far more
/// modulation than the eye needs to read a shaft.
///
/// ONE TAP, deliberately. The surface consumer takes two to break the 14 m
/// repeat, but a shaft is read THROUGH a volume where a repeat is not legible,
/// and a second tap would double the fetches over 921,600 froxels.
///
/// All three channels, not `.r` three times: caustics.wgsl evaluates the true
/// seawater indices at 610/550/460 nm, so the cusps land in slightly different
/// places per wavelength and the shaft edges carry a faint colour fringe.
fn froxelCausticVisibility(worldPos: vec3f, depth: f32) -> vec3f {
  if (!hasFlag(FLAG_CAUSTICS_ON) || depth <= 0.0) { return vec3f(1.0); }
  let fade = 1.0 - smoothstep(0.0, CAUSTICS_MAX_DEPTH, depth);
  if (fade <= 0.001) { return vec3f(1.0); }
  let sunElev = max(frame.sunDir.y, 0.0);
  if (sunElev <= 0.01) { return vec3f(1.0); }

  let refracted = refractDir(-frame.sunDir.xyz, vec3f(0.0, 1.0, 0.0), 1.0 / 1.333);
  // MINUS, for the same reason causticFactor() gives: the entry point is back
  // UP the refracted ray. Adding mirrors the parallax and the shafts slide the
  // wrong way across the column as the sun moves.
  let projected = toAbsolute(worldPos) - refracted * (depth / max(-refracted.y, 0.15));

  // A froxel is 0.17 m across at 10 m and 0.42 m at 25 m; the pattern is
  // 0.5735 m at its finest. Past about 25 m the grid is at the pattern's
  // Nyquist and an unfiltered tap becomes noise that FROXEL_HISTORY_BLEND would
  // patiently average into something stable and wrong. Sized by the froxel
  // grid, not the pixel, because that is what samples this.
  let viewDist = max(length(frame.cameraPos.xyz - worldPos), 0.01);
  let foot = viewDist * 2.0 * (frame.cameraFwd.w * frame.cameraRight.w) / f32(FROXEL_X);
  let lod = clamp(log2(max(foot * f32(CAUSTICS_RESOLUTION) / CAUSTICS_SCALE, 1e-6)),
                  0.0, CAUSTIC_MAX_LOD);

  let e = textureSampleLevel(
    causticsTex, linearSampler, projected.xz / CAUSTICS_SCALE, lod).rgb;
  let m = vec3f(CAUSTIC_TILE_MEAN_R, CAUSTIC_TILE_MEAN_G, CAUSTIC_TILE_MEAN_B);
  return mix(vec3f(1.0), e / m, fade * frame.waterSurface.x);
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/// In-scattered radiance from every lamp whose cluster covers this froxel.
///
/// THE TERM THAT HAS NEVER EXISTED. Nothing in the analytic model carries a
/// punctual source - waterInScatter() knows only about the sun and the sky - so
/// a vessel headlight has never lit the water it shines through, only the
/// surfaces at the end of it, and the marine-snow loop's "local" light (which
/// reads this volume) has been identically zero for the life of the project.
///
/// `travel` is the direction the light travels ALONG THE VIEW RAY, away from
/// the eye, which is the convention applyWaterMedium() uses. Radiance headed for
/// the eye travels along -travel, so forward scattering off a lamp in direction
/// L peaks at dot(travel, L) = 1 - the same sign as the sun's cosTheta.
fn froxelPunctual(p: vec3f, travel: vec3f, uv: vec2f, viewDepth: f32,
                  g: f32, submerged: bool) -> vec3f {
  let cluster = clusterIndexFromScreen(uv * frame.screen.xy, viewDepth);
  let range = clusterRanges[cluster];
  let count = min(range.y, u32(MAX_LIGHTS_PER_CLUSTER));
  var sum = vec3f(0.0);
  for (var i = 0u; i < count; i++) {
    let light = lights[clusterIndices[range.x + i]];
    let delta = light.positionRange.xyz - p;
    let dist2 = dot(delta, delta);
    let lightRange = light.positionRange.w;
    if (dist2 >= lightRange * lightRange) { continue; }

    // THE TWO WHOLE-LIGHT REJECTS COME FIRST, ahead of the arithmetic they
    // would otherwise throw away. Both were below punctualAttenuation() and
    // spotAttenuation(); with the deep scatter FILL class (RENDER.DEEP_FILL_COUNT
    // lights carrying shape.z = 0 precisely so they never scatter) that is up to
    // 40 lights per cluster paying for a divide, a pow and a spot profile to
    // reach a guaranteed zero. Neither test reads anything the arithmetic
    // produces, so hoisting them is exact.
    //
    // LIGHT_INTERIOR (frame.wgsl): sealed inside a dry hull, so it lights the
    // cabin and scatters in nothing. The froxel's own medium test is
    // depthAt(p) > 0, which is true of every point below the waterline
    // INCLUDING the cockpit and the habitat rooms - submitted as an ordinary
    // point light, the cabin lamp contributed a measured 4.8x what BOTH
    // external floodlights did at 120 m and drove auto-exposure. This skip is
    // the only thing that removes it; it still illuminates geometry normally.
    if (light.spotParams.z > 1.5) { continue; }
    // HOW MUCH THIS LAMP SCATTERS, AS OPPOSED TO HOW MUCH IT LIGHTS. Widening a
    // beam widens its shaft by the same solid angle, and a headlight whose cone
    // quadrupled in area also quadrupled the water it lit up on the way - which
    // reads as fog, not as reach. DESIGN/04.6.3 authored a volumetric weight
    // per group for exactly this and nothing had ever read it; the shipped
    // weights now live at VESSEL_LIGHTS / PLAYER_LAMP in core/constants.js
    // (cut hard by the 2026-08-18 drastic pass - floods 0.30, work 0.50,
    // suit 0.35 - so a beam lights its subject, not the water column).
    // shape.z defaults to 1.0, so a light that does not opt in scatters
    // exactly as it always did.
    if (light.shape.z <= 0.0) { continue; }

    let dist = sqrt(max(dist2, 1e-8));
    let L = delta / dist;
    var attenuation = punctualAttenuation(
      dist, lightRange, LIGHT_SOURCE_RADIUS, light.shape.w);
    if (light.spotParams.z > 0.5) {
      attenuation *= spotAttenuation(
        light.direction.xyz, light.direction.w, light.spotParams.y, L,
        light.shape.x, light.shape.y);
    }
    attenuation *= light.shape.z;
    if (attenuation <= 0.0) { continue; }

    var irradiance = light.colorIntensity.rgb * (light.colorIntensity.w * attenuation);
    // The lamp's own beam path through the water, per channel - the same line
    // evalPunctualLights() applies to a surface, and the reason a flood reads
    // as a wall of white at 5 m and a cold blue cone at 25 m.
    let cosScatter = dot(travel, L);
    if (submerged) {
      irradiance *= waterTransmittance(dist);
      // phaseOcean, not phaseHG: seawater's small backward lobe is precisely
      // what makes a lamp pointed AT the eye read differently from one pointed
      // away, and a headlight cone is the case that difference exists for.
      sum += irradiance * phaseOcean(cosScatter, g);
    } else {
      sum += irradiance * phaseHG(cosScatter, g);
    }
  }
  return sum;
}

// ---------------------------------------------------------------------------

@compute @workgroup_size(8, 8, 1)
fn cs_froxel_inject(@builtin(global_invocation_id) gid: vec3u) {
  // FROXEL_Y is 90 and the group is 8 deep, so 12 groups cover 96 rows and 6.7%
  // of the threads are out of range. textureStore out of bounds is undefined,
  // so this test is mandatory, not tidiness.
  if (gid.x >= u32(FROXEL_X) || gid.y >= u32(FROXEL_Y)) { return; }

  let dims = vec2f(f32(FROXEL_X), f32(FROXEL_Y));
  let uv = (vec2f(gid.xy) + 0.5) / dims;

  // Jitter the EVALUATION POINT inside the slab, never the slab boundaries -
  // stage 2 integrates against the nominal boundaries and the step lengths have
  // to keep summing to the ray length. Blue noise rather than a hash of the
  // coordinate, per the warning on blueNoise(): a structured hash turns into
  // crawling static the moment TAA gets hold of it. The golden-ratio offset in
  // z decorrelates the 64 slices from one another.
  let jitter = fract(blueNoise(gid.xy) + f32(gid.z) * 0.6180339887);
  let w = (f32(gid.z) + jitter) / f32(FROXEL_Z);
  let viewDepth = froxelWToDepth(w);

  let travel = viewRayFromUV(uv, frame.cameraFwd.xyz, frame.cameraRight.xyz,
                             frame.cameraUp.xyz, frame.cameraFwd.w, frame.cameraRight.w);
  // viewDepth is measured along the camera FORWARD axis; the distance travelled
  // along this ray to reach it is longer by 1/cos. At the shipped tanHalfFov
  // 0.5003 and aspect 2.2145 the corner ray is 1.577x longer than its forward
  // depth, so omitting this puts the corner froxels 58% too close to the eye.
  let t = viewDepth / max(dot(travel, frame.cameraFwd.xyz), 1e-3);
  let p = frame.cameraPos.xyz + travel * t;
  let depth = depthAt(p);

  let submerged = vol.cfg.z > 0.5;
  // A soft band around the FLAT sea level. The drawn surface has waves on it,
  // but a froxel is metres across in the mid field and the composite classifies
  // the waterline per pixel anyway - all this has to do is not alias.
  let band = vol.cfg.w;
  let wet = smoothstep(-band, band, depth);

  var source = vec3f(0.0);
  var density = 0.0;

  if (submerged) {
    if (wet > 0.001) {
      let sigmaS = waterSightSigmaS();
      let g = frame.waterSigmaS.w;
      let d = max(depth, 0.0);

      // THE COLLIMATED BEAM, marched rather than folded into the Kd exponent.
      // solarBeamAtDepth() is the honest sigma_t slant; waterInScatter() has to
      // approximate it with Kd because differencing two exponentials overflows
      // f32 on a ray rising through 500 m of water, and a forward march never
      // differences them. No aphoticFactor() guard is needed here and none is
      // applied: the beam decays with sigma_t, so even in ABYSSAL_VOID (the
      // clearest water in the catalogue, sigma_t blue 0.026) it is 1.4e-6 of the
      // surface value at TRUE_DARK_DEPTH. aphoticFactor() exists for the ambient
      // and deep-tint terms, which decay with Kd and which this volume does not
      // carry.
      // frame.veilTune.w = RENDER.SOLAR_SHAFT_GAIN (identity 1.0): a live gain
      // on the COLLIMATED shaft, applied HERE only - the punctual lamps below
      // and waterInScatter's analytic beam branch never carry it. Note the
      // asymmetry that buys: a frame whose beam the froxel does NOT own
      // (froxelOwnsBeam() false) runs the analytic beam at 1.0x, so at any
      // gain other than 1.0 the two owners genuinely differ. That is the
      // accepted cost of never touching the analytic path; the caustic stays
      // a mean-1 redistribution either way.
      let beam = solarBeamAtDepth(d)
               * froxelCausticVisibility(p, d)
               * froxelSunVisibility(p, viewDepth)
               * max(frame.veilTune.w, 0.0);
      source = sigmaS * (beam * phaseOcean(dot(travel, frame.sunDir.xyz), g)
                       + froxelPunctual(p, travel, uv, viewDepth, g, true));
      source *= wet;
      density = wet;
    }
  } else {
    let dry = 1.0 - wet;
    if (dry > 0.001) {
      // Fog: treated as pure scattering, which is what fogColour's use
      // everywhere else in the renderer already assumes. The height falloff is
      // measured from sea level, so -depth is the altitude.
      let heightFactor = exp(-max(-depth, 0.0) * frame.fogParams.y) * dry;
      let g = frame.fogColour.w;
      let beam = frame.sunIlluminance.rgb * froxelSunVisibility(p, viewDepth);
      // The sky's own contribution, isotropic: the field above has been
      // scattered enough times to have no angular structure left, so it goes in
      // as a radiance (E/PI) with no phase function - exactly the split
      // waterInScatter() documents for the diffuse term underwater.
      let ambient = frame.ambientSH[0].rgb * INV_PI;
      source = frame.fogParams.x * heightFactor
             * (beam * phaseHG(dot(travel, frame.sunDir.xyz), g)
              + ambient
              + froxelPunctual(p, travel, uv, viewDepth, g, false));
      density = heightFactor;
    }
  }

  // ---- temporal accumulation --------------------------------------------
  // Reproject THIS froxel's centre into the previous frame's DENSITY volume.
  // Never into the scatter volume: an integrated value at a slice depends on
  // everything in front of it along the CURRENT ray, which reprojection does
  // not preserve, and the error compounds every frame into a smear that never
  // converges.
  //
  // prevViewProj is documented as "previous frame, UNJITTERED, current origin",
  // so no rebase fixup is needed and clip.w is the previous frame's view depth
  // for exactly this point.
  let blend = vol.cfg.x;
  if (blend > 0.0) {
    let clipPrev = frame.prevViewProj * vec4f(p, 1.0);
    if (clipPrev.w > 1e-4) {
      let uvPrev = clipPrev.xy / clipPrev.w * vec2f(0.5, -0.5) + vec2f(0.5);
      let wPrev = froxelDepthToW(clipPrev.w);
      if (all(uvPrev > vec2f(0.0)) && all(uvPrev < vec2f(1.0))
          && wPrev > 0.0 && wPrev < 1.0) {
        let hist = textureSampleLevel(
          densityPrev, linearClampSampler, vec3f(uvPrev, wPrev), 0.0);
        // NO NEIGHBOURHOOD CLAMP, and that is deliberate. The usual
        // min(history, k * current) anti-ghost rail assumes the current sample
        // is an unbiased estimate, and here it is not: froxelSunVisibility()
        // takes ONE comparison tap, so at a shadow edge the current value is
        // binary 0 or 1 and the accumulation IS the penumbra. Clamping the
        // history against a frame in which the tap happened to read zero throws
        // away exactly the filtering the single tap is paying for. mix() is a
        // contraction toward the current source, so nothing can run away; the
        // cost is that a light switched off trails for ~10 frames (83 ms).
        source = mix(source, hist.rgb, blend);
        density = mix(density, hist.a, blend);
      }
    }
  }

  textureStore(densityOut, gid, vec4f(source, density));
}
