// SUBWAVE - underwater optics.
//
// This is THE file that makes the game look like the ocean rather than like
// fog with a blue tint. Everything here is physically motivated.
//
// The radiative transfer we solve, for a view ray of length s through water:
//
//   L(s) = L_surface * T(s)  +  integral(0..s) [ sigma_s * P(theta) * L_in(t) * T(t) ] dt
//          \_______________/    \_____________________________________________________/
//            transmitted             in-scattered ("airlight" - the haze itself)
//
//   T(s) = exp(-sigma_t * s)          Beer-Lambert, PER RGB CHANNEL
//
// Two different coefficients, and confusing them is the classic mistake:
//
//   sigma_t  BEAM extinction. How fast a thing you are LOOKING AT fades with
//            distance. Every photon leaving the straight path is a loss.
//   Kd       DIFFUSE attenuation. How fast AMBIENT DAYLIGHT dims with DEPTH.
//            Smaller than sigma_t, because forward-scattered photons keep
//            going down and still light the scene.
//
// Using sigma_t for depth makes 40 m pitch black. Using Kd for distance makes
// everything crisp to the horizon. We use each for its own job.

#pragma once

#include "frame.wgsl"
#include "math.wgsl"

// ---------------------------------------------------------------------------
// Phase function
// ---------------------------------------------------------------------------

/// Henyey-Greenstein. g in [0,1); ocean water is strongly forward-scattering
/// (g ~ 0.92), which is why a lamp beam has a bright halo around its axis
/// rather than glowing uniformly.
fn phaseHG(cosTheta: f32, g: f32) -> f32 {
  let g2 = g * g;
  let denom = 1.0 + g2 - 2.0 * g * cosTheta;
  return (1.0 - g2) / (4.0 * PI * max(denom, 1e-4) * sqrt(max(denom, 1e-4)));
}

/// Two-lobe phase: a strong forward lobe plus a weak backward lobe. Real
/// seawater has a small backscatter peak that makes a lamp pointed AT you
/// read very differently from one pointed away.
fn phaseOcean(cosTheta: f32, g: f32) -> f32 {
  let fwd  = phaseHG(cosTheta,  g);
  let back = phaseHG(cosTheta, -0.35 * g);
  return mix(fwd, back, 0.08);
}

// ---------------------------------------------------------------------------
// Transmittance
// ---------------------------------------------------------------------------

/// Art-directed density of the SUBMERGED sight path. The physical coefficients
/// remain in Frame for daylight, solar slant, and above-water water-leaving
/// radiance; this scales sigma_t and sigma_s together only when the eye is in
/// the medium, preserving spectral ratios and single-scattering albedo.
fn waterSightDensity() -> f32 {
  return select(1.0, clamp(frame.skyGeometry.w, 0.05, 1.0), isUnderwater());
}

fn waterSightSigmaT() -> vec3f { return frame.waterSigmaT.rgb * waterSightDensity(); }
fn waterSightSigmaS() -> vec3f { return frame.waterSigmaS.rgb * waterSightDensity(); }

/// Beam transmittance over a path of `dist` metres. The core of everything.
///
/// CAVE SIGHT-CHROMA NEUTRALISATION: frame.caveMedium.y (the sprung cave
/// enclosure times RENDER.CAVE_SIGHT_NEUTRAL) mixes the per-channel spectrum
/// toward its own Rec709 luma - energy preserved, chroma flattened. Applied
/// HERE, in the one function every beam path shares (the composite's drained
/// branch, evalPunctualLights' lamp-to-surface leg, froxel_inject's
/// lamp-to-froxel leg), because the first Jellyshroom Hollow frames showed
/// the failure is not one site's: authored magenta arrived indigo through
/// EVERY leg at once, each stripping red at the open ocean's rate over a
/// 20-80 m chamber. A sealed void's water is not the column that spectrum
/// was authored for, and the demo-first call (2026-08-18, explicit user
/// instruction) is that authored colour survives cave sight lines. The
/// weight is an EYE property, sprung on WATER_BLEND_TAU, and exactly 0.0
/// outside caves - where this returns the open-water spectrum bit for bit.
fn waterTransmittance(dist: f32) -> vec3f {
  var sigma = waterSightSigmaT();
  let neutral = clamp(frame.caveMedium.y, 0.0, 1.0);
  if (neutral > 0.001) {
    sigma = mix(sigma, vec3f(dot(sigma, vec3f(0.2126, 0.7152, 0.0722))), neutral);
  }
  return exp(-sigma * max(dist, 0.0));
}

fn waterTransmittanceSigma(sigmaT: vec3f, dist: f32) -> vec3f {
  return exp(-sigmaT * max(dist, 0.0));
}

/// Fraction of surface daylight surviving to `depth` metres down.
/// Uses Kd, NOT sigma_t. This is the function that turns the world dark as you
/// descend, and its shape is the whole emotional arc of the game.
fn daylightAtDepth(depth: f32) -> vec3f {
  return exp(-frame.waterKd.rgb * max(depth, 0.0));
}

/// Ambient light reaching a point: surface irradiance attenuated by depth,
/// modulated by sun elevation (a low sun refracts poorly and reflects more).
/// Share of the sky dome's irradiance that reaches the water. The sky still
/// lights the sea when the sun is low, which is what keeps dawn from going
/// black underwater.
const WATER_SKY_SHARE : f32 = 0.28;

/// How much of the DIFFUSE downwelling field a horizontally-looking eye
/// actually receives as in-scatter, as a fraction of the isotropic assumption.
///
/// `waterInScatter` writes the diffuse source as `E * INV_PI`, which is exact
/// for a field that is isotropic over the whole sphere. The field at depth is
/// not: it is DOWNWELLING and forward-peaked, and a horizontal view samples it
/// at roughly 90 degrees of scattering angle - the shallowest part of any ocean
/// phase function. Using the total `sigmaS` with an isotropic 1/PI therefore
/// over-weights the haze by the ratio of isotropic to side-scatter.
///
/// TWO PHYSICAL BRACKETS, both from this codebase's own numbers:
///   - single scattering at the shipped Henyey-Greenstein g = 0.918:
///     P(90 deg) / (1/4PI) = (1-g^2) / (1+g^2)^1.5 = 0.0628, a 16x cut;
///   - the backscatter fraction b_b/b, which REEF_TURQUOISE's own comment in
///     core/constants.js already derives as 0.0184, a 54x cut.
/// Both UNDER-predict, because real water refills the side directions by
/// multiple scattering and a single-scatter model cannot. The independent check
/// is remote-sensing reflectance: this model's asymptotic path radiance is
/// (sigmaS/sigmaT) * 0.1006 * E_d, which in Jerlov IB green is 0.051 * E_d
/// against a measured ocean R_rs = L_w/E_d of 0.005-0.010. That is 5-10x high,
/// and it is what this constant is set against.
///
/// WHY IT EXISTS, measured. Restoring the sky ambient's depth term in
/// `evalAmbient` removed the e^(+Kd*d) over-lighting that had been the only
/// thing holding the seabed above this veil, and exposed it: the veil's share
/// of a seabed pixel at 12 m of range became 0.435 / 0.453 / 0.497 at the
/// 17 / 50 / 93 m stations - essentially DEPTH-INDEPENDENT within one water
/// type, which is the signature of a self-consistent model whose single free
/// parameter is too high. The 20-100 m band became a fog bank: seabed contrast
/// CV fell 0.330 -> 0.087 at Sand Plains and 0.504 -> 0.136 at Boulder Field.
///
/// APPLIES TO THE DIFFUSE TERM ONLY. The collimated solar beam already carries
/// the real phase function and must not be scaled by this - that is the whole
/// point of the two-sources split below, and multiplying both would delete the
/// forward-scatter halo a second time.
const WATER_DIFFUSE_SIDESCATTER : f32 = 0.15;

/// Fraction of the downwelling sun that gets through the interface at all.
/// At grazing sun angles most of it reflects off the surface instead.
fn waterSurfaceTransmit(sinElev: f32) -> f32 {
  return 1.0 - fresnelSchlick(sinElev, 0.02);
}

/// TOTAL downwelling irradiance at depth - what a diffuse surface down there is
/// lit by. Governed by Kd, because forward-scattered photons have left the beam
/// but are still heading down and still land on the seabed.
fn ambientAtDepth(depth: f32) -> vec3f {
  let sinElev = max(sin(frame.sunIlluminance.w), 0.0);
  let above = frame.sunIlluminance.rgb * waterSurfaceTransmit(sinElev) * sinElev
            + frame.ambientSH[0].rgb * WATER_SKY_SHARE;
  return above * daylightAtDepth(depth);
}

/// How much daylight is reaching the sea surface right now, as a fraction of the
/// clear-noon value the WATER_TYPES deep tints were authored under.
///
/// Zero at night, 1.0 at noon. Anything authored as a radiance under full daylight
/// has to be scaled by this or it becomes a floor that does not go down with the
/// sun. Luma rather than per-channel, so it changes magnitude and never hue.
fn surfaceDaylightFraction() -> f32 {
  return saturate(luminance(ambientAtDepth(0.0)) / DEEP_TINT_REFERENCE_E);
}

/// The part of the downwelling light that is still a COLLIMATED SOLAR BEAM.
///
/// This is the one quantity down here that attenuates with sigma_t rather than
/// with Kd, and the reason is the whole point of the two coefficients: Kd is
/// smaller than sigma_t precisely because it counts forward-scattered photons
/// that keep travelling downward - and those photons, by definition, are no
/// longer in the beam. A beam is a line-of-sight quantity, so it loses every
/// photon that leaves the straight path.
///
/// The path is the SLANT through the water, depth / sin(elevation), not the
/// depth: a low sun drives its beam through several times as much water.
fn solarBeamAtDepth(depth: f32) -> vec3f {
  let sinElev = max(sin(frame.sunIlluminance.w), 0.0);
  let slant = max(depth, 0.0) / max(sinElev, 0.15);
  return frame.sunIlluminance.rgb * waterSurfaceTransmit(sinElev) * sinElev
       * waterTransmittanceSigma(frame.waterSigmaT.rgb, slant);
}

// ---------------------------------------------------------------------------
// In-scattering
// ---------------------------------------------------------------------------

/// Length of the part of a ray that is actually IN the water, metres.
///
/// A ray with an upward component leaves the medium where it crosses the
/// surface, and past that crossing there is nothing left to attenuate it or to
/// scatter into it. Integrating to the geometric ray length instead is what
/// closes Snell's window: the sky seen from 2 m down gets fogged over the whole
/// draw distance and comes back the colour of the abyss.
///
/// `depth` is the depth at the START of the ray and `dirY` the vertical
/// component of the direction it TRAVELS in.
fn waterPathLength(dist: f32, depth: f32, dirY: f32) -> f32 {
  let ascent = max(dirY, 0.0);
  if (ascent <= 1e-4) { return max(dist, 0.0); }
  return min(max(dist, 0.0), max(depth, 0.0) / ascent);
}

/// Does the FROXEL VOLUME own the collimated beam's in-scatter along the eye's
/// own view ray this frame?
///
/// FLAG_VOLUMETRICS_ON means exactly one thing - "froxelScatter holds this
/// frame's volume" - and render/passes/volumetrics.js selects its medium from
/// the same latched isUnderwater() flag this reads. So the two conditions
/// together are precisely "the volume ran AND it is carrying water", which is
/// the only situation in which the beam is added back somewhere else.
///
/// With the eye in AIR the volume carries the aerial medium and injects nothing
/// below the waterline, so applyViewRayWater()'s wet segment still owes itself
/// the beam and this returns false. That asymmetry is the whole reason this is
/// a function and not a flag test written inline.
fn froxelOwnsBeam() -> bool {
  return hasFlag(FLAG_VOLUMETRICS_ON) && isUnderwater();
}

/// Analytic single-scattering along a view ray whose DEPTH CHANGES as it goes.
///
/// The light field down here is stratified, not uniform: every daylight-derived
/// source term carries exp(-Kd * depth). So along a ray that starts at `depth`
/// and descends at `descent` = -dir.y metres per metre travelled, the source is
///
///   J(t) = J(depth) * exp(-Kd * descent * t)
///
/// and the in-scattered radiance the eye receives is
///
///   I = integral(0..s) sigma_s * J(t) * exp(-sigma_t * t) dt
///     = sigma_s * J(depth) * (1 - exp(-k s)) / k,     k = sigma_t + Kd*descent
///
/// which for descent = 0 collapses exactly to the familiar airlight form
/// (sigma_s/sigma_t) * J * (1 - exp(-sigma_t s)). Kd is strictly smaller than
/// sigma_t for every water type in the catalogue, so k >= sigma_t - Kd > 0 and
/// the quotient can never blow up.
///
/// WHY THIS IS NOT A REFINEMENT. What it replaces evaluated the source at ONE
/// depth - the midpoint of the ray - and treated it as constant. That is fine
/// over a few metres and catastrophic over a long one, because the in-scatter
/// integral is dominated by the first 1/sigma_t metres in FRONT OF THE EYE while
/// the midpoint of a 3 km ray is kilometres away. A pixel with no geometry
/// behind it takes the whole draw distance, so a view that slopes even slightly
/// downward over open water had its background evaluated as if it were abyssal:
/// measured at 2.3 m depth in reef water, the empty water just above the far
/// seabed came back at 0.048 in blue against 1.37 for the seabed itself, a 28x
/// step that drew a hard sawtooth line along the terrain's silhouette.
///
/// The solar beam is folded into the same exponent rather than its own
/// sigma_t/sin(elev) slant decay. That understates how fast the forward halo
/// dies with depth by the ratio Kd/sigma_t, and it is worth it: the honest
/// version differences two exponentials whose ratio is bounded but whose factors
/// are not, and it overflows f32 on a ray rising through 500 m of water.
///
/// `beamWeight` is the ONLY place the collimated term is ever removed from this
/// model, and it exists so the froxel volume can own it instead - a forward
/// march never differences the two exponentials, so it can afford the honest
/// slant, and it can modulate the beam by the caustic irradiance ratio and by
/// the sun cascades, which is what turns a halo into shafts. Adding the term in
/// both places is the double application CLAUDE.md records: 2 m of clear reef
/// water came out a milky white-out.
/// The local biome's haze chromaticity, as a unit-luma multiplier.
///
/// `frame.waterFogTint.rgb` is already normalised to unit Rec709 luma on the
/// CPU (renderer.js), so this ROTATES a colour and never changes its energy -
/// which is what lets it be applied to two different terms without either one
/// gaining or losing light, and what stops it driving auto-exposure. `.w` is
/// RENDER.WATER_FOG_TINT_STRENGTH; at 0 this returns exactly vec3(1) and every
/// call site reduces to the expression it replaced.
///
/// APPLIED TO THE DIFFUSE IN-SCATTER AND NOWHERE ELSE. That is the term with
/// the weight: measured share of the delivered pixel, the diffuse in-scatter is
/// 92-94% at the Coral Garden anchor (13 m) and 57-77% at the Shallow Reef
/// (8 m). It is NOT applied to the deep tint - see the comment at that term for
/// the measurement that rejected it - and it must not be applied to the beam,
/// which is a direct source whose colour is the sun's.
///
/// This separates the SHALLOW and MID biomes and does not separate the deep
/// ones, because the deep is lit by the surface sky rather than by the medium.
/// That is a known and separately-tracked defect (STATUS item A1), not a
/// shortcoming of this function.
fn localWaterTint() -> vec3f {
  let t = mix(vec3f(1.0), frame.waterFogTint.rgb, frame.waterFogTint.w);
  // frame.veilTune.y = RENDER.VEIL_CHROMA: sharpen the tint's chroma by raising
  // it to the power (1 + y), then renormalise to unit Rec709 luma so the veil
  // gains SATURATION and not energy — the "rotate colour, never change energy"
  // invariant survives and auto-exposure cannot see this knob. y = 0 is the
  // exact previous expression (pow by 1 of a unit-luma mix, renormalised).
  let boosted = pow(max(t, vec3f(1e-4)), vec3f(1.0 + max(frame.veilTune.y, 0.0)));
  let luma = dot(boosted, vec3f(0.2126, 0.7152, 0.0722));
  return boosted / max(luma, 1e-4);
}

/// Keep nearby shallow scenery crisp without deleting the distance cue that
/// makes an ocean feel large. This scales the diffuse additive veil only: the
/// real extinction, deep-water colour, solar forward-scatter, lamps, and
/// volumetric shafts are separate terms and remain untouched.
///
/// The two smooth windows are intentionally broad. A hard range boundary moves
/// with the camera and reads as a fog wall; a global cut makes the abyss feel
/// like air. `waterSurfaceSigmaT.w` is RENDER.SHALLOW_VEIL_REDUCTION, with zero
/// reproducing the previous image exactly for a live A/B.
fn shallowDiffuseVeilScale(dist: f32, depth: f32) -> f32 {
  if (!isUnderwater()) { return 1.0; }
  let nearWeight = 1.0 - smoothstep(12.0, 45.0, max(dist, 0.0));
  let shallowWeight = 1.0 - smoothstep(35.0, 90.0, max(depth, 0.0));
  return 1.0 - saturate(frame.waterSurfaceSigmaT.w) * nearWeight * shallowWeight;
}

fn waterInScatter(dist: f32, depth: f32, descent: f32, cosTheta: f32,
                  beamWeight: f32) -> vec3f {
  let sigmaT = waterSightSigmaT();
  let sigmaS = waterSightSigmaS();
  // waterSigmaS.w is the phase asymmetry; waterSigmaT.w is the SEA LEVEL. They
  // are one letter apart in the struct and reading the wrong one silently sets
  // g = 0, which is an isotropic phase function - it deletes the entire forward
  // scattering halo the ocean is built around and leaves no error to notice.
  let g      = frame.waterSigmaS.w;

  let k = max(sigmaT + frame.waterKd.rgb * descent, vec3f(1e-5));
  let reach = (vec3f(1.0) - exp(-k * max(dist, 0.0))) / k;

  // TWO SOURCES, AND THEY MUST NOT SHARE A PHASE FUNCTION.
  //
  // The phase function describes how a beam of KNOWN direction redistributes.
  // The diffuse field at depth has already been scattered many times over; its
  // angular structure is gone, and it in-scatters isotropically. Only the
  // still-collimated solar beam carries the Henyey-Greenstein lobe.
  //
  // What this replaces multiplied the ENTIRE downwelling field - sky dome
  // included - by that lobe, which for seawater peaks at 262x isotropic. The
  // consequence was not a subtle one: at 8 m in reef water the haze in front of
  // the seabed was ~3.5x what single scattering actually delivers, so near-field
  // contrast was gone and every underwater view was a flat wash of one colour.
  // Splitting the terms keeps the forward-scatter halo where it belongs - a
  // real, dramatic effect around the sun and around every lamp - while the
  // background haze settles back to the modest isotropic thing it is.
  // THE DIFFUSE TERM CARRIES THE BIOME'S OWN COLOUR, and it is the only term in
  // the frame with enough weight to do so. Everything on the right-hand side
  // below except the tint is a per-FRAME scalar - the sky SH, a global share
  // constant, the water type's Kd - so before the tint existed this expression
  // added one identical colour to every pixel of the screen. Since it is 57-94%
  // of a shallow or mid-water pixel, that made every underwater frame in the
  // game monochromatic: measured log2(G/B) spread across a whole frame was 0.071
  // stops, and 0.00% of any frame was more than 40 degrees of hue off its own
  // dominant, against 6.6-77% in the reference material.
  //
  // frame.waterFogTint.rgb is already normalised to unit Rec709 luma on the CPU
  // (renderer.js), so this rotates the haze's chromaticity and leaves its ENERGY
  // alone - it must not become a brightness knob, or it drives auto-exposure and
  // fights the radiometry in every other term. .w is the strength; at 0 this is
  // exactly the expression it replaced, which is what makes the change bisectable.
  let diffuse = frame.ambientSH[0].rgb * WATER_SKY_SHARE * daylightAtDepth(depth) * localWaterTint();
  let beam = solarBeamAtDepth(depth);

  // BOTH TERMS ARRIVE AS IRRADIANCE AND THE SOURCE FUNCTION IS A RADIANCE.
  //
  // ambientSH[0] is on the illuminance scale by construction (see
  // SKY_RADIANCE_SCALE in sim/sky.js), and solarBeamAtDepth returns the beam's
  // irradiance. The in-scattered source is
  //
  //   J(w) = integral of P(w'->w) * L(w') dw'
  //
  // so the diffuse field, whose downwelling irradiance is E = PI * L for a
  // hemisphere, contributes E/PI, and the collimated beam contributes
  // P(theta) * E_beam - P alone, because phaseHG already integrates to 1 over
  // the sphere and is therefore already in 1/sr.
  //
  // What this replaces multiplied the beam by a further 4*PI and left the
  // diffuse field as a raw irradiance, so the haze ran 3x too bright away from
  // the sun and 12.6x too bright along it. Measured: a submerged reef seen
  // from 14 m up came back at 38.1 in blue against a sky of 4.29 - the water
  // was NINE TIMES brighter than the light falling on it, which is the flat
  // milky wash the seabed used to disappear into.
  // The diffuse term additionally carries WATER_DIFFUSE_SIDESCATTER, because
  // INV_PI assumes an isotropic field and the field at depth is downwelling.
  // The BEAM does not: it already has the real phase function. See the constant.
  // frame.veilTune.x is the live RENDER.VEIL_DIFFUSE_GAIN master gain on this
  // diffuse term only (identity 1.0); the beam branch below must never carry it.
  let diffuseVeil = WATER_DIFFUSE_SIDESCATTER * frame.veilTune.x
                  * shallowDiffuseVeilScale(dist, depth);
  let source = diffuse * (INV_PI * diffuseVeil)
             + beam * (phaseOcean(cosTheta, g) * beamWeight);
  return sigmaS * source * reach;
}

/// Apply the full medium over `dist` metres of water, to radiance arriving from
/// the far end of that path.
///
///   colour = surfaceRadiance * T + inScatter
///
/// The path is parameterised FROM THE EYE OUTWARD: `viewDir` points away from
/// the eye and `depth` is the depth where the path begins - the eye's own depth
/// for a submerged camera, or zero for the wet part of a ray that entered the
/// water at the surface. It is emphatically not the midpoint and not the far
/// end: waterInScatter integrates the stratification along the path itself, and
/// the exp(-sigma_t t) weight that makes that integral converge is measured from
/// the eye, so any other choice of origin puts the haze at the wrong depth.
fn waterMediumWeighted(radiance: vec3f, dist: f32, depth: f32, viewDir: vec3f,
                       beamWeight: f32) -> vec3f {
  let dir = normalize(viewDir);
  // Only the wet part of the path participates.
  let s = waterPathLength(dist, depth, dir.y);
  let cosTheta = dot(dir, frame.sunDir.xyz);
  let T = waterTransmittance(s);
  let inScatter = waterInScatter(s, depth, -dir.y, cosTheta, beamWeight);
  // The deep tint is the asymptotic colour the eye reads as "the abyss" - and it
  // is a RADIANCE, so it scales with the light actually reaching the sea. It used
  // to be multiplied only by daylightAtDepth(), which is exp(-Kd*depth) and hence
  // exactly 1.0 at the surface at every hour, so the authored constant survived
  // midnight untouched and the sea glowed. A luma scalar rather than a per-channel
  // ratio, so the authored hue is preserved exactly.
  // NOT tinted by localWaterTint(), and that was measured rather than assumed.
  // Routing the biome colour through this term as well is the obvious next
  // step and it delivers NOTHING: at the arrival framings the deep anchors now
  // use, transmittance is 0.59 at 20 m in ABYSSAL_VOID, so the lit seabed - not
  // this term - is the frame, and the five deep biomes' delivered hue spread
  // moved 10.9 -> 9.4 degrees, i.e. slightly the wrong way. In genuinely open
  // water at those depths the frame sits ON the auto-exposure rail (metered
  // scene luminance 0.0003-0.0031, gain pinned at 25.6) and all three test
  // stations read 229-231 degrees whether the term is tinted or not.
  //
  // The deep does not separate on the medium because it is not lit by the
  // medium. The reason given here used to be that `evalAmbient` removed only
  // daylightAtDepth(pointDepth - cameraDepth), so a point at the camera's own
  // depth lost nothing - that WAS true and was fixed in 238fab9; the illumination
  // path is attenuated now. The observation still holds for its own reason: at
  // these depths the frame sits on the auto-exposure rail, so what the tint would
  // rotate is already clipped. Do not re-add this line without re-measuring both
  // cases; it looks right and does nothing.
  let deep = frame.waterDeepTint.rgb * daylightAtDepth(depth) * surfaceDaylightFraction();
  return radiance * T + inScatter + deep * (vec3f(1.0) - T);
}

/// The full medium with the beam intact. This is the entry point for any path
/// that is NOT the eye's own view ray - the total-internal-reflection mirror on
/// the underside of the ocean surface, for one - because the froxel volume is
/// parameterised by the view frustum and has nothing to say about a reflected
/// direction. Behaviour here is unchanged by the volumetrics pass.
fn applyWaterMedium(radiance: vec3f, dist: f32, depth: f32, viewDir: vec3f) -> vec3f {
  return waterMediumWeighted(radiance, dist, depth, viewDir, 1.0);
}

/// The medium along THE EYE'S OWN VIEW RAY, which is the one path the froxel
/// volume also integrates. Identical to applyWaterMedium() except that the
/// collimated beam is left to the volume on the frames the volume ran; see
/// froxelOwnsBeam() for why that condition is not simply the flag.
fn applyViewRayMedium(radiance: vec3f, dist: f32, depth: f32, viewDir: vec3f) -> vec3f {
  return waterMediumWeighted(radiance, dist, depth, viewDir,
                             select(1.0, 0.0, froxelOwnsBeam()));
}

/// WHO OWNS THE WATER MEDIUM, and the answer is exactly one of two places.
///
/// pass/underwater.wgsl is a fullscreen composite that reconstructs the world
/// position behind every pixel and applies the medium over the whole view ray.
/// It only runs when the eye is at or below the waterline, though - above that
/// there is nothing for it to do to a sky pixel, and the pass is disabled - so
/// the geometry shaders have to fog their own submerged fragments for the view
/// down into a reef from a boat. That case is not optional either: the ocean
/// surface refracts sceneOpaque, which is a snapshot taken BEFORE the composite
/// runs, so a seabed that has not fogged itself refracts through the shallows
/// unattenuated.
///
/// Both halves were being done at once, and the measurement that caught it is
/// tools/probes/underwater-double-fog.js: at 2.3 m over reef sand the near seabed
/// read 0.117/0.734/1.058 with the composite DISABLED - already fully hazed,
/// straight out of the terrain pass - and 0.087/0.685/1.166 with it enabled, so
/// the composite was squaring the transmittance and adding the in-scatter twice.
/// Whole-frame scene radiance fell from 1.43 to 1.04 doing it, which auto-exposure
/// then lifted back to the same brightness with the contrast gone. Turning the
/// composite off on its own put sand ripples, pebbles and kelp back into a frame
/// that had been a flat milky wash - that was the proof, before any code moved.
///
/// So: this function is the geometry shaders' entry point, and it stands down
/// when the eye is submerged because the composite has the frame then.
fn applyViewRayWater(radiance: vec3f, viewDist: f32, fragDepth: f32,
                     travelDir: vec3f) -> vec3f {
  if (isUnderwater()) { return radiance; }
  if (fragDepth <= 0.0) { return radiance; }
  // camWater.w is the eye's height above the sea SURFACE, and fragDepth is the
  // fragment's depth below it, so the two are already in the same frame and no
  // absolute Y ever enters - which is what keeps the waterline in the right
  // place if WORLD.SEA_LEVEL ever stops being zero.
  let eyeAbove = max(frame.camWater.w, 0.0);
  let submerged = fragDepth / max(eyeAbove + fragDepth, 1e-4);
  // The wet segment BEGINS at the surface: the dry part in front of it neither
  // attenuates nor scatters, so t = 0 belongs at the waterline and the depth
  // there is zero. waterInScatter descends from there on its own.
  return applyWaterMedium(radiance, viewDist * saturate(submerged), 0.0, travelDir);
}

/// Cheaper variant for particles and other high-count, low-importance work.
/// Drops the phase function - so no forward halo - but must stay on the SAME
/// radiometric footing as waterInScatter, or a cloud of marine snow sits in a
/// haze PI times brighter than the water it is drifting through.
fn applyWaterMediumFast(radiance: vec3f, dist: f32, depth: f32) -> vec3f {
  let T = waterTransmittance(dist);
  let albedo = waterSightSigmaS() / max(waterSightSigmaT(), vec3f(1e-5));
  let inScatter = albedo * ambientAtDepth(depth) * INV_PI * (vec3f(1.0) - T);
  return radiance * T + inScatter;
}

// ---------------------------------------------------------------------------
// Refraction at the surface
// ---------------------------------------------------------------------------

/// Snell's law. Returns the refracted direction, or the reflected one on
/// total internal reflection (looking up from below at a shallow angle -
/// which produces Snell's window, the bright circle overhead).
fn refractDir(incident: vec3f, normal: vec3f, eta: f32) -> vec3f {
  let cosI = -dot(normal, incident);
  let sin2T = eta * eta * (1.0 - cosI * cosI);
  if (sin2T > 1.0) {
    return reflect(incident, normal);          // total internal reflection
  }
  return eta * incident + (eta * cosI - sqrt(1.0 - sin2T)) * normal;
}

/// Schlick Fresnel for the air/water interface (F0 = 0.02).
fn waterFresnel(cosTheta: f32) -> f32 {
  return fresnelSchlick(cosTheta, 0.02);
}

/// Half-angle of Snell's window seen from underwater, radians (~48.6 deg).
const SNELL_WINDOW_ANGLE : f32 = 0.8481;

// ---------------------------------------------------------------------------
// Caustics
// ---------------------------------------------------------------------------

/// Irradiance MULTIPLIER for the direct solar beam on a submerged surface.
///
/// MEAN 1 OVER THE TILE - exactly at LOD 0, +2.8% by LOD 4 (measured; the clamp
/// deficit CAUSTIC_COMPOSITE_MEAN corrects for stops firing as the box chain
/// removes the peaks, and that constant's docstring carries the per-level
/// numbers). refractedIlluminance() has already done the
/// radiometry - Fresnel transmit, daylightAtDepth - so a caustic can only
/// REDISTRIBUTE that beam, never add to it. The predecessor returned
/// c1*c2*2.6, whose mean is 3.856 once the 1 is folded in, and lighting.wgsl
/// applied it as `illuminance *= 1 + caustic`: measured, the direct sun on
/// every underwater surface was 3.86x the light physically available, and its
/// ceiling was 1 + 6*6*2.6 = 94.6. That is a +5.9 dB error auto-exposure had
/// been silently absorbing, and it is why the shallow seabed read as light
/// through frosted glass - the term was 74% constant. Its MINIMUM was 2.04, so
/// it could only brighten, and a caustic's defining feature is that the light
/// between the filaments is taken away.
///
/// Returns exactly 1.0 wherever caustics are off, faded out or the sun is
/// down, so `illuminance *= causticFactor(...)` is a no-op there and a VERTICAL
/// WALL sees the unmodulated beam rather than darkness.
///
/// All three channels, not `.r` three times: sim/caustics.wgsl evaluates the
/// true seawater indices at 610/550/460 nm, so the cusps land in slightly
/// different places per wavelength and the filament edges carry a colour fringe.
fn causticFactor(worldPos: vec3f, normal: vec3f, depth: f32) -> vec3f {
  if (!hasFlag(FLAG_CAUSTICS_ON) || depth <= 0.0) { return vec3f(1.0); }

  // Physically, caustics need direct sun and enough water above to focus it.
  let depthFade = 1.0 - smoothstep(0.0, CAUSTICS_MAX_DEPTH, depth);
  if (depthFade <= 0.001) { return vec3f(1.0); }

  let sunElev = max(frame.sunDir.y, 0.0);
  if (sunElev <= 0.01) { return vec3f(1.0); }

  // Project along the refracted sun direction so caustics slide correctly
  // across sloped terrain instead of looking like a decal.
  let refracted = refractDir(-frame.sunDir.xyz, vec3f(0.0, 1.0, 0.0), 1.0 / 1.333);
  let travel = depth / max(-refracted.y, 0.15);
  // MINUS: we want the point on the SURFACE that this sunbeam entered through,
  // which is back UP the refracted ray. Adding pushes another `depth` metres
  // further DOWN, which mirrors the parallax - the caustics then slide the
  // wrong way across a slope and against the sun as it moves.
  let projected = toAbsolute(worldPos) - refracted * travel;
  let uv = projected.xz / CAUSTICS_SCALE;

  // ANALYTIC LOD. No derivatives are available here - this function returns
  // early on per-pixel conditions, so it is not uniform control flow and WGSL
  // forbids implicit derivatives - and the pattern is now 0.5735 m at its
  // finest, which subtends under a pixel past about 30 m at grazing incidence.
  // TAA cannot clean that up: the caustic moves independently of the motion
  // vectors, so history rejection fires exactly where the crawl is.
  let toEye = frame.cameraPos.xyz - worldPos;
  let viewDist = max(length(toEye), 0.01);
  let V = toEye / viewDist;
  let radPerPixel = 2.0 * frame.cameraFwd.w * frame.screen.w;   // 2*tan(fovY/2)/h
  let foot = viewDist * radPerPixel / max(abs(dot(normal, V)), 0.25);
  let lodBase = log2(max(foot * f32(CAUSTICS_RESOLUTION) / CAUSTICS_SCALE, 1e-6));
  let lod1 = clamp(lodBase, 0.0, CAUSTIC_MAX_LOD);
  let lod2 = clamp(lodBase + CAUSTIC_TAP2_LOD, 0.0, CAUSTIC_MAX_LOD);

  let t = currentTime();
  let m = vec3f(CAUSTIC_TILE_MEAN_R, CAUSTIC_TILE_MEAN_G, CAUSTIC_TILE_MEAN_B);
  let c1 = textureSampleLevel(causticsTex, linearSampler,
             uv + vec2f( 0.014, -0.011) * t, lod1).rgb;
  let c2 = textureSampleLevel(causticsTex, linearSampler,
             uv * CAUSTIC_TAP2_SCALE + vec2f(-0.019, 0.008) * t, lod2).rgb;

  // A PRODUCT of two independent lensing events, clamped ONCE at the same
  // ceiling a single tap already carries. Clamping each tap and then
  // multiplying squares the ceiling to 36; times the old 2.6 gain that is the
  // 94.6 the seabed used to be able to reach. The product is also what breaks
  // the tile: measured world tile-lag autocorrelation is 0.4465 for the product
  // against exactly 1.000 for one tap - a single tap is an exact 14 m repeat on
  // every flat seabed in the game.
  let cm = vec3f(CAUSTIC_COMPOSITE_MEAN_R, CAUSTIC_COMPOSITE_MEAN_G,
                 CAUSTIC_COMPOSITE_MEAN_B);
  let e = min(c1 * c2 / (m * m), vec3f(CAUSTIC_PEAK)) / cm;

  // Every weakening term is a CONTRAST MIX TOWARD 1, not a multiplier on an
  // additive term. That is what turns the depth fade into a PATTERN fade: it
  // lerps toward the flat unfocused beam with no brightness change at all,
  // where `1 + caustic*fade` was a disguised 3.86x-to-1x brightness ramp over
  // the depth range. Upward-facing surfaces catch caustics; vertical walls
  // barely do, and now see the plain beam rather than a shadow.
  let k = depthFade * saturate(normal.y * 0.75 + 0.25) * sunElev * frame.waterSurface.x;
  return mix(vec3f(1.0), e, k);
}

// ---------------------------------------------------------------------------
// Volumetric froxel lookup
// ---------------------------------------------------------------------------

/// Convert a view-space depth to the froxel volume's W coordinate.
/// The distribution is exponential so froxels are dense near the camera where
/// the eye can resolve them, and coarse far away where it cannot.
fn froxelDepthToW(viewDepth: f32) -> f32 {
  let maxD = FROXEL_MAX_DISTANCE;
  return pow(saturate(viewDepth / maxD), 1.0 / FROXEL_DEPTH_POWER);
}

fn froxelWToDepth(w: f32) -> f32 {
  return pow(saturate(w), FROXEL_DEPTH_POWER) * FROXEL_MAX_DISTANCE;
}

/// Sample the pre-integrated volumetric buffer.
/// Returns rgb = accumulated in-scattered light, a = transmittance to here.
fn sampleFroxel(uv: vec2f, viewDepth: f32) -> vec4f {
  if (!hasFlag(FLAG_VOLUMETRICS_ON)) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let w = froxelDepthToW(viewDepth);
  return textureSampleLevel(froxelScatter, linearClampSampler, vec3f(uv, w), 0.0);
}

/// The volume's in-scatter over ONE SEGMENT of the view ray, [near, far] in view
/// depth, rather than over the whole ray from the eye.
///
/// VALID UNDERWATER ONLY, and that is not a caveat - it is the reason it works.
/// With the eye submerged the volume owns the collimated beam and the punctual
/// lamps while the composite keeps the transmittance, so `.a` is exactly 1.0
/// (see froxelOwnsBeam() and the ownership block in sim/froxel_integrate.wgsl)
/// and the `.rgb` it carries is a plain running integral from the eye. The
/// difference of two taps is then exactly the segment's contribution. IN AIR
/// `.a` is the real transmittance, the accumulation is not additive, and
/// subtracting two taps means nothing.
///
/// It exists for the habitat. A single sampleFroxel() integrates from the EYE,
/// which inside a pressure hull starts several metres of room air too early -
/// the volume's medium test is `depthAt(p) > 0`, which is true of every froxel
/// in a room 33 m down.
fn froxelSegment(uv: vec2f, nearDepth: f32, farDepth: f32) -> vec3f {
  let far = sampleFroxel(uv, farDepth).rgb;
  if (nearDepth <= 1e-3) { return far; }
  return max(far - sampleFroxel(uv, nearDepth).rgb, vec3f(0.0));
}

/// Composite volumetrics over already-shaded radiance.
fn applyFroxel(radiance: vec3f, uv: vec2f, viewDepth: f32) -> vec3f {
  let vol = sampleFroxel(uv, viewDepth);
  return radiance * vol.a + vol.rgb;
}

/// The GEOMETRY shaders' entry point for the volume, and the counterpart of
/// applyViewRayWater() - the same ownership split, for the same reason.
///
/// It stands down when the eye is submerged, because pass/underwater.wgsl is
/// then a fullscreen composite that adds the volume once for every pixel in the
/// frame; applying it here as well would add the in-scatter twice to exactly
/// the pixels that have geometry behind them.
///
/// THE CONSUMER LIST IS CLOSED. In air this is called by pass/terrain.wgsl,
/// pass/entity.wgsl, pass/scatter.wgsl and pass/creature.wgsl - the four passes
/// that apply no aerial medium of their own. It must NOT be called by
/// pass/ocean_surface.wgsl, pass/sky_render.wgsl or pass/clouds.wgsl: all three
/// already call aerialPerspective(), which carries its own in-scatter over the
/// same path, and adding this on top would double it.
fn applyViewRayFroxel(radiance: vec3f, uv: vec2f, viewDepth: f32) -> vec3f {
  if (isUnderwater()) { return radiance; }
  return applyFroxel(radiance, uv, viewDepth);
}

// ---------------------------------------------------------------------------
// SSAO gate - the ambient share of a delivered fragment
// ---------------------------------------------------------------------------

/// What is left of a fragment's AMBIENT term once the geometry pass's own
/// medium chain has run - the numerator of the SSAO gate.
///
/// The medium is AFFINE per channel (x -> x*T + inScatter), so the ambient
/// term's survival through applyViewRayWater() + applyViewRayFroxel() is
/// exactly ambient * T with the in-scatter belonging to the medium, not to the
/// surface. This mirrors the two functions' own stand-down rules and their T:
/// underwater both are identity (pass/underwater.wgsl owns the ray, and the
/// gate is then correctly PRE-medium - the composite attenuates surface and
/// applies AO'd radiance in one place); in air the wet segment is the same
/// waterPathLength over the same submerged fraction applyViewRayWater() uses,
/// and the aerial T is the froxel's own .a. If either of those functions
/// changes its T, this must change with it - it is a GATE (a ratio steering a
/// few percent of darkening), but there is no reason to let it drift.
///
/// The second sampleFroxel() tap has the same coordinates as the one inside
/// applyViewRayFroxel(), air-only, and is the whole marginal cost of the gate.
fn aoAmbientThroughMedium(ambient: vec3f, viewDist: f32, fragDepth: f32,
                          travelDir: vec3f, uv: vec2f, viewDepth: f32) -> vec3f {
  if (isUnderwater()) { return ambient; }
  var a = ambient;
  if (fragDepth > 0.0) {
    let eyeAbove = max(frame.camWater.w, 0.0);
    let submerged = fragDepth / max(eyeAbove + fragDepth, 1e-4);
    let dir = normalize(travelDir);
    a *= waterTransmittance(
      waterPathLength(viewDist * saturate(submerged), 0.0, dir.y));
  }
  return a * sampleFroxel(uv, viewDepth).a;
}

/// The gate itself: luma(delivered ambient) / luma(delivered fragment), the
/// fraction of this pixel's radiance that screen-space AO may remove.
///
/// LUMA RATIO, NOT A PER-CHANNEL ONE, because the apply pass multiplies the
/// whole pixel by one scalar: the subtraction lies along the pixel's own
/// colour, sized so the LUMINANCE removed equals the ambient term's share.
/// Emission, direct sun/moon (the CSM owns that occlusion) and punctual lamps
/// are all in the denominator only, so they are protected by construction -
/// a glowcup's gate tends to 0 as its emission dominates. Rec709 weights, the
/// same convention every normalised tint in this file uses.
fn aoGate(ambientDelivered: vec3f, finalRadiance: vec3f) -> f32 {
  let lumaW = vec3f(0.2126, 0.7152, 0.0722);
  return clamp(dot(ambientDelivered, lumaW) / max(dot(finalRadiance, lumaW), 1e-6),
               0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Surface appearance helpers
// ---------------------------------------------------------------------------

/// Fraction of scattered light that turns round and goes BACKWARD, for the
/// Henyey-Greenstein phase function the medium already carries.
///
///   b_b/b = integral of P over the backward hemisphere
///         = (1 - g^2)/(2g) * ( 1/sqrt(1+g^2) - 1/(1+g) )
///
/// This is the difference between two quantities that are constantly confused:
/// sigma_s says how much light the water scatters, b_b says how much of it
/// comes back out through the surface. At g = 0.924 they differ by a factor of
/// 59 - b_b/b is 1.7% - and that ratio is the whole reason the open ocean is
/// dark blue rather than the colour of a lit swimming pool.
fn waterBackscatterFraction(g: f32) -> f32 {
  let gg = clamp(abs(g), 0.0, 0.99);
  if (gg < 1e-3) { return 0.5; }            // isotropic: half of it goes back
  return (1.0 - gg * gg) / (2.0 * gg)
       * (inverseSqrt(1.0 + gg * gg) - 1.0 / (1.0 + gg));
}

/// THE COEFFICIENTS THE WATER-LEAVING RADIANCE USES, which are NOT the ones the
/// sight path uses. See the waterSurfaceKd block in common/frame.wgsl for the
/// argument; the short form is that the art red cut exists to keep SUBMERGED
/// objects legible and this term is looked at from OUTSIDE the medium.
///
/// The strength for both lives in waterSurfaceKd.w. waterSurfaceSigmaT.w is
/// unrelated and carries the shallow diffuse-veil reduction. At 0 these return
/// the live art column exactly, which is what makes
/// RENDER.SURFACE_BODY_PHYSICAL_RED bisectable.
///
/// USE THESE ONLY from the three above-water functions. Anything reached with
/// the eye in water wants frame.waterKd / frame.waterSigmaT.
fn surfaceKd() -> vec3f {
  return mix(frame.waterKd.rgb, frame.waterSurfaceKd.rgb, frame.waterSurfaceKd.w);
}

fn surfaceSigmaT() -> vec3f {
  return mix(frame.waterSigmaT.rgb, frame.waterSurfaceSigmaT.rgb, frame.waterSurfaceKd.w);
}

/// Irradiance reflectance of an optically deep water body, R = b_b/(a + b_b).
/// For OCEANIC_CLEAR that is 0.07% / 0.5% / 2.5% across RGB - the measured
/// reflectance of clear open ocean, and the reason it reads blue rather than
/// black. Multiple scattering is already inside this form; the pure
/// single-scattering estimate b_b/(Kd + sigma_t) comes out about 4x lower.
///
/// THIS DOCSTRING WAS FALSE FROM 2026-08-02 UNTIL THE SURFACE COLUMN EXISTED,
/// and that is the cleanest evidence the split is cut along the right axis. The
/// art red cut reaches this function through `sigmaA = sigmaT - sigmaS`, and on
/// the cut column it returns 0.281% / 0.520% / 2.510% - red 3.8x the number the
/// comment above asserts, i.e. an open ocean measurably less blue than the
/// physics it cites. On surfaceSigmaT() it returns 0.074% / 0.520% / 2.510%.
///
/// Called only from oceanBodyColour() and shallowWaterColour(), both above
/// water. Keep it that way: a submerged caller would be reading the physical
/// red into a path the whole cut was made for.
fn deepWaterReflectance() -> vec3f {
  let sigmaS = frame.waterSigmaS.rgb;
  let bb = sigmaS * waterBackscatterFraction(frame.waterSigmaS.w);
  let sigmaA = max(surfaceSigmaT() - sigmaS, vec3f(0.0));
  return bb / max(sigmaA + bb, vec3f(1e-6));
}

/// Colour the eye reads looking DOWN into a water column of `columnHeight`
/// metres standing over a bottom of the given radiance.
///
/// TWO THINGS HERE ARE EASY TO GET WRONG AND BOTH MAKE THE SEA GLOW.
///
///   The light that comes back up is BACKSCATTER. sigma_s/sigma_t is the share
///   of extinction that is scattering at all - and for seawater 98% of that is
///   forward, straight on down. Using it here claims every scattered photon
///   returns to the eye.
///
///   ambientAtDepth() is an IRRADIANCE. What the eye reads is a RADIANCE. The
///   upwelling field has been scattered enough times to be near-Lambertian by
///   the time it leaves, so the conversion is the usual 1/PI.
///
/// Both errors push the same way, and together they were worth about two
/// orders of magnitude. Measured before this was right: looking straight down
/// at open water from 14 m, the sea came back at 38.1 in blue against a sky of
/// 4.29 - nine times brighter than the sky lighting it.
///
/// ABOVE-WATER ONLY, so it is on the surface column throughout - see
/// surfaceKd() above. Its one call site is ocean_surface.wgsl's no-floor branch
/// at (400.0, vec3f(0.0)), where `T` is exp(-sigma_t * 800) = 0 and `reach` is
/// 1: both terms are INERT there and only deepWaterReflectance() moves a pixel.
/// They are on the surface column anyway so the function stays general, but do
/// not "optimise away" the sigma_t - it is load-bearing through that call.
fn shallowWaterColour(columnHeight: f32, bottomRadiance: vec3f) -> vec3f {
  let sigmaT = surfaceSigmaT();
  // Light travels down and back up, so the path is twice the column height.
  let path = max(columnHeight, 0.0) * 2.0;
  let T = exp(-sigmaT * path);

  // The backscatter that escapes comes from the TOP of the column: the source
  // falls off as exp(-Kd z) going down and what it sends back is attenuated
  // again by exp(-sigma_t z) coming up, so the integral saturates within a few
  // attenuation lengths. A 400 m column is no brighter than a 40 m one, which
  // is why the surface irradiance is the right one to feed it.
  let reach = vec3f(1.0) - exp(-(surfaceKd() + sigmaT) * path);
  return bottomRadiance * T
       + deepWaterReflectance() * INV_PI * ambientAtDepth(0.0) * reach;
}

/// Marine snow density multiplier at a given depth. The top few metres stay
/// almost postcard-clear, then organic detritus builds through the productive
/// column. It persists into deep water as isolated falling aggregates instead
/// of turning the abyss into a uniform screen-space haze.
fn marineSnowDensity(depth: f32) -> f32 {
  let productiveColumn = smoothstep(2.0, 45.0, depth);
  let deepFade = 1.0 - smoothstep(1050.0, 1600.0, depth);
  return mix(0.025, 0.50, productiveColumn) * deepFade;
}

// ---------------------------------------------------------------------------
// The particulate CHARACTER of the water column
// ---------------------------------------------------------------------------

/// Everything about a marine-snow mote except how many of them there are.
///
/// Density was the only thing that varied for the life of the project: every
/// other property was a WGSL compile-time constant in pass/underwater.wgsl, so
/// across the six deep stations the whole particulate field took exactly two
/// values (0.500 and 0.275, a 1.8:1 spread on ONE scalar). A biome could not
/// have its own suspended load look like its own suspended load.
struct SnowCharacter {
  /// Diffuse reflectance of a mote. Rotated toward the local haze
  /// chromaticity; see snowCharacter() for why that cannot change its energy.
  albedo     : vec3f,
  /// Sink speed, m/s. Real aggregates fall at 6-18 mm/s; mineral floc is
  /// denser and faster, fluffy organic floc slower.
  sink       : f32,
  /// Lattice spacing at SNOW_CELL_REF metres, as a fraction of that range; the
  /// growth with range is SNOW_PERSPECTIVE's job and is shared by every water.
  /// Bigger cells mean fewer, larger flocs at the same screen coverage.
  cellScale  : f32,
  /// Mote radius as a fraction of its cell. Must stay below 0.2, the margin the
  /// centre offset leaves at the cell wall, or a mote straddles a boundary and
  /// pops as the sample crosses it; 0.22 is the hard ceiling and no row is
  /// authored above it.
  radius     : f32,
  /// Where inside `radius` the mote becomes opaque, as a fraction of it. This
  /// is the HARD/SOFT axis and it is what "fine" has to mean once mote size is
  /// resolution-limited: a fine mineral suspension cannot be drawn as a smaller
  /// disc without becoming sensor noise, so it is drawn as a disc of the same
  /// order with almost no core and a wide gradient, which reads as dust. A
  /// coarse aggregate keeps a crisp opaque middle.
  coreFrac   : f32,
  /// Per-shell occupancy scale. Compensated by 1/radius^2 so that changing the
  /// mote SIZE trades count against area at constant screen coverage; without
  /// that, every size knob is also a density knob and the two cannot be judged
  /// apart.
  occupancy  : f32,
  /// Geometric decay of occupancy per shell - how far out the field reaches.
  shellDecay : f32,
  /// Mote size at the FARTHEST shell as a fraction of the nearest one.
  taper      : f32,
  /// How many of the SNOW_LAYERS shells to march. A shell costs a froxel tap
  /// and a hash per pixel, so this is the frame-cost knob as well as a reach
  /// knob.
  layers     : f32,
}

/// The neutral row: EXACTLY the six compile-time constants this system
/// replaced, so `SNOW_CHARACTER = 0` restores the shipped particulate PARAMETERS
/// for every water in the game.
///
/// IT DOES NOT ON ITS OWN RESTORE THE SHIPPED IMAGE, and saying which knob does
/// what is the point of writing the row down. Two other things changed in the
/// same item and each reverts on its own named constant, in pass/underwater.wgsl:
/// `SNOW_PERSPECTIVE = 1.0` restores the fixed-angle lattice, and the per-pixel
/// range dither is a DELETION - to get it back, multiply `tk` by
/// `(1.0 + 0.13 * blueNoise(vec2u(pix)))` again, which is the one line that made
/// every mote in this project's history a 1-px dither pattern instead of a
/// particle. Read marineSnow()'s docstring before doing that.
///
/// What these numbers delivered: a mote whose opaque core was
/// `radius * 0.25 * cellScale` = 0.00220 rad and whose outer edge was 0.00880
/// rad, at EVERY range, i.e. a 1.2 px core in a 4.8 px skirt on the 1600 px tour
/// frame. Every authored row below is larger than that at the reference shell
/// and larger again at the near ones.
fn snowCharacterNeutral() -> SnowCharacter {
  var c : SnowCharacter;
  c.albedo = vec3f(0.86, 0.88, 0.82);
  c.sink = 0.011;
  c.cellScale = 0.055;
  c.radius = 0.16;
  c.coreFrac = 0.25;
  c.occupancy = 0.55;
  c.shellDecay = 0.50;
  c.taper = 0.72;
  c.layers = 6.0;
  return c;
}

/// Master gate on the whole character system. 0 returns the neutral row above
/// for every water in the game - see that row for the two other constants a full
/// revert also needs. 1 is shipped.
///
/// Compile-time rather than a live RENDER knob, and that is a scope limit rather
/// than a preference: publishing a live knob means either a Frame field or a
/// shader define, and both live in files this item does not own. Every INPUT the
/// function reads is already in the Frame and already sprung, which is why the
/// feature itself needed neither.
const SNOW_CHARACTER : f32 = 1.0;

/// How much of the local haze chromaticity a mote picks up. See snowCharacter().
const SNOW_CHROMA : f32 = 0.55;

/// Per-shell occupancy at the neutral row's mote size, before the 1/radius^2
/// size compensation and before density.
///
/// 2.3x the neutral row's 0.55, AND THAT IS NOT A BRIGHTNESS INCREASE - it is
/// the re-tune the coherence fix in marineSnow() forced. Once the per-pixel range
/// dither came out, the same delivered coverage stopped arriving as hundreds of
/// 1-px dots and started arriving as a handful of large discs, and a handful is
/// not a snowfall: measured over an 800 x 230 open-water crop at the Boulder
/// Field anchor, 517 blobs of mean area 1.53 px became 6 of mean area 339 px.
/// This is what buys the count back. It multiplies a per-shell occupancy that is
/// then multiplied by density and by shellDecay^k, so it does not saturate the
/// far shells - at Boulder Field the near shell reaches 0.70 and the fourth
/// 0.09. In DAYLIGHT water it is additionally scaled by SNOW_PHOTIC_LOAD below,
/// which takes those two to 0.49 and 0.06.
const SNOW_OCCUPANCY : f32 = 1.25;

// ---------------------------------------------------------------------------
// The photic correction: a mote in daylight water is not the same picture
// ---------------------------------------------------------------------------

/// How much of a mote's light here is DAYLIGHT rather than the deep key.
///
/// THE FOUR ANCHORS THE NEAR FIELD BROKE AT ARE EXACTLY THE FOUR THAT ARE STILL
/// IN THE SUN, and the split is not a judgement call - it is an eleven-fold step
/// in the measurement. luminance(ambientAtDepth(cameraDepth())) at the fourteen
/// anchors, on the tour's own poses: reef (11.6 m) 19.46, coral (14.1 m) 14.62,
/// sand (51.1 m) 1.308, kelp (43.0 m) 1.234, boulders (100.1 m) 0.335 - and then
/// Shelf Break (183.8 m) at 0.029, Rock Spires 0.0038, Canyon Wall 0.0003 and
/// exactly 0.0000 at Abyssal Plain and below. Nothing sits between 0.335 and
/// 0.029. The five above that step are the five frames whose motes are lit by
/// the sun; everything below it is lit by the deep key, whose own gain
/// (SNOW_DEEP_KEY_GAIN, in pass/underwater.wgsl) was authored against the key's
/// asymptote and delivers a mote DARKER than the far haze rather than brighter.
///
/// So this curve exists to leave the deep alone, and it does so exactly:
/// smoothstep returns 0.0, not merely a small number, at and below its lower
/// edge, so at Rock Spires and everything deeper the four factors below are
/// mix(1.0, x, 0.0) = 1.0 and the character is bit-identical to the shipped one.
/// Shelf Break gets 0.2% of the correction. VERIFIED IN THE FRAME as well as in
/// the arithmetic: the 14-anchor tour's `spires` frame is unchanged apart from
/// fauna, and every deep anchor's hue entropy moved by less than the tour's own
/// pass-to-pass spread.
fn snowPhoticShare() -> f32 {
  return smoothstep(0.02, 0.35, luminance(ambientAtDepth(cameraDepth())));
}

/// LATTICE PITCH in daylight water, and this is the knob that carried the fix.
///
/// A mote's angular outer radius is `radius * cellScale * (tk/2.08)^-0.38`, so
/// at the 0.45 m shell the shipped character delivered 13 px of RADIUS at Sand
/// Plains on the 1600 px tour frame, and 19 px in the coarsest water - a 26 to
/// 39 px disc, opaque in the middle, at a range where the only real-world object
/// that size is on the lens. Sand Plains carried about 25 of them over an
/// otherwise clean plain and Kelp Forest about 40, and both were reported as
/// dirt on the glass rather than as anything in the water.
///
/// CUTTING cellScale IS THE ONE SIZE CHANGE THAT IS NOT ALSO A DENSITY CHANGE.
/// Motes per steradian go as (tk/cell)^2 and each one covers (radius*cell/tk)^2,
/// so halving the pitch quarters the area of a mote and quadruples the count and
/// the per-shell COVERAGE is untouched - it is the file's documented "few large
/// or many small" control and nothing else moves. Measured in isolation
/// (candidate B, 0.55 with every other factor at 1.0), at Sand Plains: count
/// 40 -> 99.5, mean blob area 154 -> 56, coverage 0.503% -> 0.457%.
///
/// 0.50 puts Sand Plains' near shell at 6.5 px of radius and its 9.6 m shell at
/// 2.0 px, which is where the floor is: below about 2 px a mote stops being a
/// particle and comes back as the speckle item 2.4 exists to remove. That floor
/// is why the pitch cannot simply be cut until the discs are gone, and it is
/// also why the fix is not a pure size cut - see SNOW_PHOTIC_LOAD.
const SNOW_PHOTIC_CELL : f32 = 0.50;

/// MOTE REFLECTANCE in daylight water.
///
/// NOT THE FIX, AND MEASURED NOT TO BE: candidate C halved it with the size and
/// the count left alone, and the Boulder Field frame still read as fifteen soft
/// discs against the open blue - a big dim circle is still a big circle. What it
/// does earn is the last of the hard white cores. At one fixed size and load
/// (candidates E vs F) the softening pair below took delivered blob area at
/// Boulder Field 0.612% -> 0.423% and blobs over 200 px 8.5 -> 5, purely by
/// lowering contrast against the haze.
///
/// A uniform scale, so it cannot rotate the mote's colour: the fourteen
/// fogTint albedos and the load ramp above keep their whole spread.
const SNOW_PHOTIC_ALBEDO : f32 = 0.75;

/// OPAQUE-CORE FRACTION in daylight water - the HARD/SOFT axis, softened.
/// See SNOW_PHOTIC_ALBEDO for the pair's measured effect; this is the half that
/// widens the gradient rather than dimming the whole disc.
const SNOW_PHOTIC_CORE : f32 = 0.65;

/// PER-SHELL OCCUPANCY in daylight water.
///
/// The pitch cut above trades count against size at constant coverage, and a
/// clean plain does not want the same coverage in smaller pieces - Sand Plains'
/// brief is "broad exposure and empty horizons". This is the only factor of the
/// four that removes stuff. 0.70 was chosen against 0.50 (candidate D) because
/// D read correctly but thin: the Sand Plains frame fell to about twenty flakes
/// and Shallow Reef to six, and Shallow Reef's density is already the lowest in
/// the game.
const SNOW_PHOTIC_LOAD : f32 = 0.70;

/// The particulate character of the water the eye is standing in.
///
/// TWO AUTHORED AXES, BOTH ALREADY SPRUNG AND BOTH ALREADY IN THE FRAME. This
/// deliberately adds no Frame field: the two numbers that decide what a
/// suspended load looks like are already uploaded per frame, are already
/// authored per water type in core/constants.js, and are already sprung on
/// RENDER.WATER_BLEND_TAU by main.js._updateWaterColumn, so the character
/// inherits the spring for free and cannot pop at a biome edge the way the
/// SNAPPED seabed albedo beside it does.
///
///   LOAD  = frame.waterBottom.w, the sprung `snowMultiplier`. How much stuff
///           is in the water. It also decides how MINERAL that stuff is: a
///           heavy resuspended load is grey rock flour, a light one is pale
///           organic aggregate, so albedo darkens and sink speed rises with it.
///   COARSE = frame.waterSigmaS.w, the sprung phase asymmetry `g`. This is the
///           PARTICLE SIZE axis and it is not a proxy - the Henyey-Greenstein
///           asymmetry of a suspension is set by particle size against
///           wavelength, which is exactly why marine-snow aggregates (>100 um)
///           sit at g ~ 0.93-0.94 and fine mineral dust and molecular
///           scattering sit lower. Reading it here means a water cannot claim
///           big flocs optically and draw small ones.
///
/// The six water types any BIOMES record actually carries land on six clearly
/// separated points of that plane (load, g -> loadNorm, coarse):
///   ABYSSAL_VOID     0.55, 0.930 -> 0.046, 0.750   sparse coarse pale flocs
///   REEF_TURQUOISE   0.75, 0.918 -> 0.195, 0.450   fine bright detritus
///   NEPHELOID        0.90, 0.940 -> 0.283, 1.000   the coarsest silt in the game
///   OCEANIC_CLEAR    1.00, 0.924 -> 0.333, 0.600   the open-shelf default
///   COASTAL_GREEN    1.25, 0.905 -> 0.441, 0.125   many fine green particles
///   HADAL_SUSPENSION 1.65, 0.921 -> 0.575, 0.525   the only 6-shell field left
/// The four uncarried types (BRINE 0.20/0.800, MURKY_PARTICULATE 6.0/0.862,
/// VENT_SMOKE 12.0/0.780, VENT_HAZE 2.75/0.900) all clamp to coarse = 0 and
/// spread across the whole of loadNorm, which is the sparse-bright-fine to
/// dense-dark-fine diagonal the plane is missing today.
///
/// THE THIRD AXIS IS PER BIOME, NOT PER WATER TYPE. `frame.waterFogTint.rgb` is
/// BIOMES[].fogTint, fourteen authored values, normalised to unit Rec709 luma
/// on the CPU and sprung with the rest of the column. It is rescaled by its own
/// PEAK channel before it touches a mote, because what it tints here is a
/// reflectance rather than an in-scatter - see the albedo block below, which
/// carries the measurement. It is what gives the six biomes that share
/// OCEANIC_CLEAR six different-looking snowfields.
///
/// AND A FOURTH AXIS THAT IS PER PLACE RATHER THAN PER WATER: how much DAYLIGHT
/// is left where the eye is standing. It is not another authored character -
/// every water keeps its own row and the whole (loadNorm, coarse) spread - it is
/// a correction applied on top of that row wherever a mote is lit by the sun
/// rather than by the deep key. snowPhoticShare() has the derivation and the
/// measured eleven-fold step that separates the two populations.
fn snowCharacter() -> SnowCharacter {
  let neutral = snowCharacterNeutral();
  if (SNOW_CHARACTER <= 0.0) { return neutral; }

  // Three octaves from 0.5, because the authored loads span 60:1 (0.20 to
  // 12.0) and a linear normalisation would put all six carried types in the
  // bottom eighth of the range.
  let loadNorm = saturate(log2(max(frame.waterBottom.w, 1e-3) / 0.5) / 3.0);
  // The carried types occupy g 0.905-0.940 and nothing else does, so the
  // remap is centred on that band. Everything below 0.90 is fine dust and
  // clamps together on purpose - brine, silt and vent smoke differ from each
  // other on LOAD, which is the axis that actually separates them.
  let coarse = saturate((frame.waterSigmaS.w - 0.90) / 0.04);

  // The photic correction. Every one of these is exactly 1.0 wherever
  // snowPhoticShare() is 0, which is Rock Spires and everything below it, so the
  // deep character is untouched rather than merely nearly untouched.
  let photic = snowPhoticShare();
  let pCell = mix(1.0, SNOW_PHOTIC_CELL, photic);
  let pCore = mix(1.0, SNOW_PHOTIC_CORE, photic);
  let pLoad = mix(1.0, SNOW_PHOTIC_LOAD, photic);
  let pAlbedo = mix(1.0, SNOW_PHOTIC_ALBEDO, photic);

  var c : SnowCharacter;
  // Mote pitch and size, and the FINE END IS FLOORED, not free. `radius *
  // cellScale` is the angular outer radius at SNOW_CELL_REF (2.08 m), which
  // SNOW_PERSPECTIVE then multiplies by 1.79 at the near shell and 0.55 at the
  // 9.6 m one. On the 1600 px tour frame that is 4.9 px at the reference and
  // 8.8 / 2.7 px at those two for the FINE character, and 10.8 / 19.3 / 6.0 px
  // for the COARSE one, against the neutral row's flat 4.8 px. Nothing is
  // authored small enough to put the near shells back near a pixel: that is
  // where the pre-2.4 field lived and what it delivered was speckle. Fine water
  // therefore differs by being SOFT and numerous, not by being small.
  //
  // THOSE FIGURES ARE THE APHOTIC ONES. In daylight water SNOW_PHOTIC_CELL
  // halves all of them - the near shell goes to 4.4 / 9.7 px and the 9.6 m shell
  // to 1.4 / 3.0 px - because a 19 px near-shell radius in a bright clear column
  // is a lens artefact and was reported as one. The floor argument above is what
  // stops the cut going further; see that constant.
  c.cellScale = mix(0.058, 0.090, coarse) * pCell;
  c.radius = mix(0.155, 0.22, coarse);
  c.coreFrac = mix(0.16, 0.42, coarse) * pCore;
  // Constant screen coverage under a size change. Each shell contributes one
  // lattice cell per pixel, so the number of distinct motes per steradian goes
  // as occupancy*(tk/cell)^2 and each one covers (radius*cell/tk)^2 - the
  // product is occupancy*radius^2, with both cellScale and the perspective
  // exponent dropping out. Compensating by 1/radius^2 therefore trades count
  // against area exactly, and cellScale is left as a clean "few large or many
  // small" control. Without this every size knob would silently also be a
  // density knob and the two could not be judged apart.
  c.occupancy = SNOW_OCCUPANCY * pLoad * (neutral.radius * neutral.radius)
              / max(c.radius * c.radius, 1e-6);
  // Mineral floc is dense and sinks; fluffy organic aggregate is close to
  // neutrally buoyant. Both terms are needed - a vent's ash is small AND fast,
  // which one axis cannot say.
  c.sink = mix(0.006, 0.024, loadNorm) * mix(1.30, 0.72, coarse);
  // How far out the field is worth drawing. Clear water gets a near-field
  // sparkle and empty distance; a loaded column carries all the way out.
  c.shellDecay = mix(0.50, 0.72, loadNorm);
  // The neutral row SHRANK far motes (0.72), which is the wrong direction when
  // the far shells are the ones already below a pixel. Coarse waters hold
  // their angular size out to the last shell instead.
  c.taper = mix(0.72, 1.00, coarse);
  // Only a genuinely loaded column pays for the sixth shell. That shell sits
  // at ~20.7 m and is the single largest contributor to the open-water speckle,
  // so dropping it in clear water is a picture fix and a cost cut at once.
  c.layers = clamp(floor(mix(4.8, 6.2, loadNorm) + 0.5), 3.0, 6.0);
  // Pale organic aggregate at a light load, grey rock flour at a heavy one,
  // then tinted toward the local haze's HUE.
  //
  // A REFLECTANCE, WHICH IS WHY THE HAZE CHROMATICITY IS RESCALED BY ITS PEAK
  // AND NOT USED RAW. waterFogTint.rgb is normalised to unit LUMA, which is
  // right for the in-scatter it was built for but leaves a single channel as
  // high as 3.97 (Trench Wall). Any meaningful rotation of an albedo toward
  // that puts a mote's blue reflectance at 2.07 - a particle that emits more
  // than it receives. Dividing by the peak instead gives a selective ABSORBER:
  // every channel is <= 1, so the tint can only ever remove light, which is
  // also the direction that measured RIGHT for saturation on this project - a
  // brighter object is a whiter one (x3 emission took a delivered coral from
  // 0.128 to 0.093) and the turquoise restoration gained its colour by taking
  // light away. The cost is real and is not hidden: at the most saturated tint
  // in the table it removes 35% of a mote's luma, and at the near-neutral
  // shallow tints about 10%.
  //
  // `pAlbedo` is a flat scale on top of all of that and so cannot rotate any of
  // it - see SNOW_PHOTIC_ALBEDO, and note that it was measured NOT to be the fix
  // on its own.
  let base = mix(vec3f(0.93, 0.93, 0.89), vec3f(0.44, 0.42, 0.38), loadNorm);
  let tint = frame.waterFogTint.rgb;
  let peak = max(max(tint.r, tint.g), max(tint.b, 1e-4));
  let amt = saturate(frame.waterFogTint.w) * SNOW_CHROMA;
  c.albedo = base * mix(vec3f(1.0), tint / peak, amt) * pAlbedo;
  return c;
}

/// How strongly shadows should register underwater. Deep light is almost
/// entirely diffuse, so hard shadows there would look wrong.
///
/// THE UPPER EDGE IS NOT A LITERAL. It is RENDER.SHADOW_UNDERWATER_CUTOFF,
/// published by renderer.js, because shadows.js gates a whole cascade on the
/// same number: two literals that must agree, and one of them living here in
/// WGSL where nobody editing constants.js can see it, is how you arm three
/// caster chains whose output the receiver then multiplies by zero.
///
/// The LOWER edge stays 15 m and is a separate decision: it is where the beam
/// stops being collimated enough for a hard edge to read as geometry rather
/// than as dirt on the texture. Raising the cutoff therefore STRETCHES this
/// curve rather than sliding it, and deepens the shadow through the whole
/// 15 m - cutoff band, not only past the old edge: at 260 the strength at the
/// 41 m Kelp Forest anchor would go 0.797 -> 0.988. MEASURED, that is not
/// visible either - the A/B/A is in SHADOW_UNDERWATER_CUTOFF's docstring.
fn underwaterShadowStrength(depth: f32) -> f32 {
  return 1.0 - smoothstep(15.0, SHADOW_UW_CUTOFF, depth);
}
