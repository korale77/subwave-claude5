// SUBWAVE - per-frame uniform and the whole of bind group 0.
//
// BINDING CONTRACT. The JS side writes this struct byte-for-byte via
// StructWriter; the offsets in the comments are authoritative. If you add a
// field, add it at the END, bump FRAME_BYTES in js, and keep 16-byte alignment.
//
// Everything in "world" space here is CAMERA-RELATIVE world space: the true
// world position minus Frame.worldOrigin. This keeps float32 precise across a
// 6 km x 1.6 km world - at absolute coordinates a vertex 3 km out has ~0.25 mm
// of precision left, which is fine, but the DEPTH maths and the wave cascades
// need much better than that near the camera.

#pragma once

struct Frame {
  // ---- Matrices ------------------------------------ offset  size ----
  view                : mat4x4f,   //    0    64
  proj                : mat4x4f,   //   64    64   reverse-Z, infinite far, JITTERED
  viewProj            : mat4x4f,   //  128    64
  invView             : mat4x4f,   //  192    64
  invProj             : mat4x4f,   //  256    64
  invViewProj         : mat4x4f,   //  320    64
  prevViewProj        : mat4x4f,   //  384    64   previous frame, UNJITTERED, current origin
  viewProjUnjittered  : mat4x4f,   //  448    64   velocity + culling maths

  // ---- Camera --------------------------------------------------------
  cameraPos           : vec4f,     //  512    16   xyz = camera-relative pos (~0), w = 1
  cameraFwd           : vec4f,     //  528    16   xyz = forward,  w = tan(fovY*0.5)
  cameraRight         : vec4f,     //  544    16   xyz = right,    w = aspect
  cameraUp            : vec4f,     //  560    16   xyz = up,       w = fovY (rad)
  prevCameraPos       : vec4f,     //  576    16   xyz, w = speed (m/s)
  worldOrigin         : vec4f,     //  592    16   xyz = origin of camera-relative space
  camPlanes           : vec4f,     //  608    16   x=near y=shadowFar z=1/near w=maxViewDist

  // ---- Sun / moon ----------------------------------------------------
  sunDir              : vec4f,     //  624    16   xyz = direction TO sun, w = angular radius
  sunIlluminance      : vec4f,     //  640    16   rgb linear, w = elevation (rad)
  moonDir             : vec4f,     //  656    16   xyz = direction TO moon, w = angular radius
  moonIlluminance     : vec4f,     //  672    16   rgb, w = phase 0..1

  // ---- Ambient (SH-L2, pre-convolved for irradiance) -----------------
  ambientSH           : array<vec4f, 9>,  // 688  144   rgb in xyz

  // ---- Water medium --------------------------------------------------
  waterSigmaT         : vec4f,     //  832    16   rgb = beam extinction /m, w = sea level y
  waterSigmaS         : vec4f,     //  848    16   rgb = scattering /m,      w = phase g
  waterKd             : vec4f,     //  864    16   rgb = diffuse attenuation /m, w = water type id
  waterDeepTint       : vec4f,     //  880    16   rgb = asymptotic deep colour, w = turbidity
  waterSurface        : vec4f,     //  896    16   x=causticStrength y=foamCoverage z=choppiness w=seaState
  camWater            : vec4f,     //  912    16   x=depth below surface (m) y=submergedFrac
                                   //                z=underwater flag w=signed dist to surface

  // ---- Air medium ----------------------------------------------------
  fogParams           : vec4f,     //  928    16   x=density y=heightFalloff z=start w=maxOpacity
  fogColour           : vec4f,     //  944    16   rgb, w = anisotropy g

  // ---- Screen / TAA --------------------------------------------------
  screen              : vec4f,     //  960    16   x=w y=h z=1/w w=1/h  (render resolution)
  outputSize          : vec4f,     //  976    16   x=outW y=outH z=renderScale w=1/renderScale
  taaJitter           : vec4f,     //  992    16   xy = current jitter (NDC), zw = previous

  // ---- Exposure / time -----------------------------------------------
  exposureParams      : vec4f,     // 1008    16   x=exposure y=prevExposure z=bloomIntensity w=EV comp
  timeParams          : vec4f,     // 1024    16   x=time(s) y=dt z=dayFraction w=frameIndex

  // ---- Weather -------------------------------------------------------
  weather             : vec4f,     // 1040    16   x=cloudCover y=rain z=windSpeed w=lightningFlash
  windDir             : vec4f,     // 1056    16   xy = wind direction (unit, XZ), z=gustPhase w=fogAmount

  // ---- Counts / flags ------------------------------------------------
  counts              : vec4u,     // 1072    16   x=lightCount y=cascadeCount z=froxelZ w=flags

  // ---- Seabed --------------------------------------------------------
  // rgb = diffuse albedo of the seabed under the current water type,
  // w = exact sprung marine-snow / suspended-matter multiplier. It is half of
  // the water-leaving radiance
  // mix(R_deep, rho, exp(-2*Kd*h)) that makes shallows turquoise and the open
  // sea deep blue - see oceanBodyColour in pass/ocean_surface.wgsl. Sourced
  // from WATER_BOTTOM_ALBEDO in core/constants.js, indexed by water type id.
  waterBottom         : vec4f,     // 1088    16

  // ---- Sky geometry --------------------------------------------------
  // x = planet radius Rg (m), y = atmosphere top radius Rt (m),
  // z = viewer altitude above sea level (m), w = submerged sight density.
  //
  // These three numbers are the whole of the sky-view LUT's parameterisation,
  // and they live here so that ANY pass on bind group 0 can look up the sky it
  // is standing under. atmosphere.wgsl already carries them in the Sky uniform,
  // but that uniform sits on the SKY_GROUP, which the geometry passes own for
  // their own per-draw block - so a pass that wants an environment reflection
  // cannot include atmosphere.wgsl at all. Written by renderer.js from the same
  // SKY constants and the same viewer-altitude clamp sim/sky.js uses, so
  // frameSkyUV() in common/lighting.wgsl indexes exactly the texels the LUT was
  // generated for.
  skyGeometry         : vec4f,     // 1104    16

  // ---- Local water chroma ---------------------------------------------
  // rgb = the LUMINANCE-NORMALISED chromaticity the diffuse in-scatter is
  // pushed toward here, w = how much of it to apply (0 = neutral).
  //
  // This is BIOMES[].fogTint, which biomes.js has always authored on all
  // fourteen records and documented as "linear RGB the in-scatter is pushed
  // toward locally", and which nothing in src/ read until now - the identical
  // shape of bug to waterTypeAt(), one file over. It matters because the
  // diffuse in-scatter is 57-94% of every shallow and mid-water pixel, so it
  // is the ONE term with enough weight to separate two biomes by colour; the
  // seabed albedo it was previously hoped would do that job arrives as 1.6-6%
  // of the pixel at the ranges the game is actually framed at.
  //
  // NORMALISED BY LUMINANCE, and that is not optional: the authored tints span
  // 2.9 stops of R/B but also 1.6 decades of BRIGHTNESS, so applying them raw
  // would be a gain knob that drives auto-exposure and fights the radiometry
  // everywhere. Divided by their own Rec709 luma they are pure chromaticity and
  // the in-scatter's energy is untouched.
  //
  // Sprung in main.js on RENDER.WATER_BLEND_TAU with the rest of the column,
  // because biome classification is a high-frequency quantity once the real
  // slope is passed (29-34 boundary flips per km) and a hard switch pops.
  waterFogTint        : vec4f,     // 1120    16

  // ---- The same water with its Jerlov red restored --------------------
  // For the WATER-LEAVING RADIANCE only: what an eye OUTSIDE the medium reads
  // looking down at the sea. Consumed by exactly three functions, all in the
  // above-water path - oceanBodyColour(), shallowWaterColour() and
  // deepWaterReflectance(), which only those two call. shadeBelow() and
  // pass/underwater.wgsl reach none of them, so this cannot leak onto a
  // submerged view even by accident.
  //
  // WHY THERE ARE TWO SETS. The 2026-08-02 red cut is an art deviation that
  // exists to keep SUBMERGED OBJECTS LEGIBLE - a coral 12 m away kept 0.07% of
  // its red - so it belongs on the SIGHT PATH (waterSigmaT, applyViewRayWater)
  // and the ILLUMINANT (waterKd, daylightAtDepth). Both are about seeing a
  // thing THROUGH water. This term hides nothing and lights nothing; it is pure
  // colour, and it is the one the cut destroyed. oceanBodyColour() is
  // mix(deepWaterReflectance(), seabedAlbedo, exp(-2*Kd*h)), so a lagoon is
  // turquoise only because 2h of RED Kd eats the red out of bright carbonate
  // sand - and at the cut values REEF_TURQUOISE's red Kd is 0.0791 against a
  // GREEN 0.0725. Achromatic in the red-green axis: nothing seen through it can
  // be turquoise at any depth. Measured over reef sand, hue / HSV saturation:
  // 2 m went 186 deg / 0.61 -> 245 / 0.06, 8 m 204 / 0.97 -> 234 / 0.43.
  //
  // .w on the FIRST of the two is RENDER.SURFACE_BODY_PHYSICAL_RED, and it
  // drives BOTH accessors in common/water.wgsl - the second's .w is unused
  // padding. Mixed in the shader rather than on the CPU so the knob is live.
  waterSurfaceKd      : vec4f,     // 1136    16   rgb = physical-red Kd,
                                   //                w = mix strength (0 = art)
  waterSurfaceSigmaT  : vec4f,     // 1152    16   rgb = physical-red sigma_t
                                   //                (= surfaceSigmaA + sigmaS),
                                   //                w = shallow veil reduction

  // ---- The deep key ---------------------------------------------------
  // The one source that SURVIVES aphoticFactor. Below TRUE_DARK_DEPTH the
  // composite's daylight mix collapses to pure extinction and every
  // daylight-derived term - ambient, diffuse in-scatter, deep tint, fog tint -
  // is multiplied by exactly zero; what a pixel with no lamp on it then
  // delivers is the depth grade's black lift on a scene value of ZERO, one
  // constant colour holding 82-88% of the gated pixels of the two deepest
  // frames. These two vec4s are what the composite mixes toward instead.
  //
  // Consumed ONLY by pass/underwater.wgsl (deepKeyInScatter, and the marine
  // snow's local illumination). It is not injected into the froxel volume and
  // must not be: the volume owns the collimated beam and the punctual lamps
  // underwater, the composite owns the diffuse medium, and this is the diffuse
  // medium. Adding it in both places is the double application that turned 2 m
  // of clear reef water into a white-out.
  //
  // deepKeyDir.xyz is the direction TO the key, the same convention as sunDir,
  // so the scattering cosine is dot(viewRay, dir) in both. deepKeyRadiance.rgb
  // is the ASYMPTOTIC radiance the key delivers over an infinite path, not a
  // source irradiance - see RENDER.DEEP_KEY_RADIANCE for why the two are not
  // interchangeable across the deep water types. At rgb = 0 every term below is
  // multiplied by zero and the frame is bit-identical to a build without it.
  deepKeyDir          : vec4f,     // 1168    16   xyz = direction TO the key
                                   //                (unit), w = phase g
  deepKeyRadiance     : vec4f,     // 1184    16   rgb = asymptotic radiance,
                                   //                w = directionality 0..1

  // ---- Cave interior medium -------------------------------------------
  // x = SPRUNG enclosure 0..1: how much of the open-column daylight
  // in-scatter and deep key the underwater composite drains because the eye
  // is inside a carved cave void. Sprung CPU-side on WATER_BLEND_TAU toward
  // (inCave ? RENDER.CAVE_ENCLOSURE : 0) in main.js._updateWaterColumn -
  // the review measured the previous FLAG-driven binary step collapsing the
  // analytic in-scatter mix to 0.15 IN ONE FRAME at a 16 m mouth, the whole
  // haze strobing with the mouth-plane flag flicker the cave residency
  // already defends against with a 6 s timer. The snow half of the cave
  // medium always rode this spring (waterBottom.w); now both halves do.
  // y: enclosure x RENDER.CAVE_SIGHT_NEUTRAL - the cave sight-chroma
  //    neutralisation weight (pass/underwater.wgsl); rides the same spring.
  // zw reserved.
  caveMedium          : vec4f,     // 1200    16

  // Live veil tuning for the underwater medium (the 2026-08 clarity pass).
  // x: diffuse-sidescatter gain — multiplies WATER_DIFFUSE_SIDESCATTER on the
  //    diffuse in-scatter veil ONLY (never the collimated beam, never
  //    transmittance). Identity 1.0 reproduces the pre-pass image exactly.
  // y: veil chroma boost — exponent offset on the unit-luma fog tint in
  //    localWaterTint(); 0.0 is the exact old expression.
  // z: marine-snow global density scale; identity 1.0.
  // w: gain on the froxel's collimated solar shaft (RENDER.SOLAR_SHAFT_GAIN);
  //    identity 1.0. Underwater god rays only - lamps and the analytic beam
  //    branch never read it.
  veilTune            : vec4f,     // 1216    16

  // total = 1232 bytes
};

// Frame.counts.w bit flags
const FLAG_UNDERWATER      : u32 = 1u;
const FLAG_IN_VESSEL       : u32 = 2u;
const FLAG_CAUSTICS_ON     : u32 = 4u;
const FLAG_VOLUMETRICS_ON  : u32 = 8u;
const FLAG_SSR_ON          : u32 = 16u;
const FLAG_NIGHT           : u32 = 32u;
const FLAG_IN_CAVE         : u32 = 64u;
const FLAG_REDUCE_FLASHING : u32 = 128u;
/// The bioluminescent glow pass ran this frame, so pass/creature.wgsl may hand
/// the unresolved share of its emission over to it. Set from the frame graph, at
/// uniform-write time, exactly as FLAG_VOLUMETRICS_ON is - a field the pass set
/// inside execute() would always be one frame late. Without it a build in which
/// `game.particlesPass` was never constructed would silently lose the sprite's
/// half of every emitter with nothing to say so.
const FLAG_GLOW_SPRITES    : u32 = 256u;
/// THE EYE is sealed in a pressurised volume below sea level - today, the
/// habitat's rooms.
///
/// FLAG_UNDERWATER IS STILL SET when this one is. The camera is in the water; it
/// merely has air immediately around it. Conflating the two - which is what
/// Camera.isUnderwater used to do - disabled the fullscreen composite, handed
/// the medium back to applyViewRayWater() at an eye height of ZERO (i.e. full
/// surface irradiance at 33 m), returned the raw sight density instead of the
/// biome's, counted the collimated sun beam twice, and made waterPathLength()
/// return 0 for every upward ray. Five contracts, one getter.
///
/// The dry BUBBLE is per pixel and lives in the dryPath target. Read THIS only
/// for things that are genuinely properties of the eye: the depth grade, the
/// composite's own vignette, and which side of a pane the medium lives on.
const FLAG_DRY_INTERIOR    : u32 = 512u;

// ---------------------------------------------------------------------------
// Punctual lights (clustered forward+)
// ---------------------------------------------------------------------------

// 80 bytes (5 x vec4f). Packed tightly because we upload up to MAX_LIGHTS of
// these per frame. LIGHT_BYTES in render/renderer.js is the JS half of the pair,
// tools/test-layout.mjs asserts the two agree, and sim/cluster_cull.wgsl carries
// a hand-kept copy of this struct that must be updated with it.
struct Light {
  positionRange : vec4f,   // xyz = camera-relative position, w = range (m)
  colorIntensity: vec4f,   // rgb = linear colour, w = intensity (candela)
  direction     : vec4f,   // xyz = spot direction (unit), w = cos(outerAngle)
  spotParams    : vec4f,   // x = cos(innerAngle), y = 1/(cosInner-cosOuter),
                           // z = type (0 point, 1 spot), w = shadow index (-1 = none)
  // The beam's SHAPE, as opposed to its extent. Every field's identity value is
  // what addLight() writes when a caller does not supply it, and the four
  // identities together reproduce the pre-shape build exactly.
  shape         : vec4f,   // x = fill weight        (0 = core only)
                           // y = fill lobe power    (1 = plain cosine)
                           // z = volumetric weight  (1 = scatters as it lights)
                           // w = falloff mix        (0 = pure inverse square)
};

const LIGHT_POINT : f32 = 0.0;
const LIGHT_SPOT  : f32 = 1.0;
/// A light sealed inside a DRY interior - the cockpit's instrument glow. Shaded
/// exactly like a point light, but skipped by the volumetric injection: it sits
/// inside a pressure hull, so it has no medium to scatter in, and the froxel's
/// medium test is `depthAt(p) > 0`, which is true of every point below the
/// waterline INCLUDING the cabin. Measured at 120 m with the vessel boarded, the
/// cabin lamp alone contributed 4.8x what both external floodlights contributed
/// and was driving auto-exposure.
const LIGHT_INTERIOR : f32 = 2.0;

// ---------------------------------------------------------------------------
// Bind group 0 - identical for EVERY pass. Never rebind during a frame.
// ---------------------------------------------------------------------------

@group(0) @binding(0)  var<uniform> frame        : Frame;
@group(0) @binding(1)  var<storage, read> lights : array<Light>;
// Cluster grid: one u32 offset + count pair per cluster, then a flat index list.
@group(0) @binding(2)  var<storage, read> clusterRanges : array<vec2u>;
@group(0) @binding(3)  var<storage, read> clusterIndices: array<u32>;

@group(0) @binding(4)  var shadowAtlas   : texture_depth_2d_array;
@group(0) @binding(5)  var shadowSampler : sampler_comparison;
@group(0) @binding(6)  var<storage, read> shadowMatrices : array<mat4x4f>;

// Environment / lookup textures.
@group(0) @binding(7)  var skyLUT        : texture_2d<f32>;   // sky radiance by (azimuth, elevation)
@group(0) @binding(8)  var transmittanceLUT : texture_2d<f32>;
@group(0) @binding(9)  var causticsTex   : texture_2d<f32>;
@group(0) @binding(10) var froxelScatter : texture_3d<f32>;   // rgb = inscatter, a = transmittance
@group(0) @binding(11) var blueNoiseTex  : texture_2d<f32>;

@group(0) @binding(12) var linearSampler : sampler;
@group(0) @binding(13) var linearClampSampler : sampler;
@group(0) @binding(14) var pointClampSampler : sampler;

// ---------------------------------------------------------------------------
// Convenience accessors
// ---------------------------------------------------------------------------

fn hasFlag(f: u32) -> bool { return (frame.counts.w & f) != 0u; }

fn frameIndex() -> u32 { return u32(frame.timeParams.w); }

fn cameraDepth() -> f32 { return frame.camWater.x; }
fn isUnderwater() -> bool { return frame.camWater.z > 0.5; }
/// See FLAG_DRY_INTERIOR. True with isUnderwater() also true, never instead.
fn eyeIsDry() -> bool { return hasFlag(FLAG_DRY_INTERIOR); }
fn seaLevel() -> f32 { return frame.waterSigmaT.w; }
fn currentTime() -> f32 { return frame.timeParams.x; }
fn deltaTime() -> f32 { return frame.timeParams.y; }
fn exposure() -> f32 { return frame.exposureParams.x; }
fn nearPlane() -> f32 { return frame.camPlanes.x; }

/// Depth below the sea surface for a camera-relative world position.
/// Positive underwater, negative in air.
///
/// seaLevel() is an ABSOLUTE height, so the origin's Y has to be added back
/// before the subtraction. Omitting it is not a rare edge case: camera.js
/// rebases all three axes together the moment ANY of them passes the rebase
/// radius, so a purely horizontal excursion past 2 km stamps the camera's
/// current Y into worldOrigin.y. Measured in the shipped `abyss` QA scenario -
/// camera (2394, -698, -1388), worldOrigin (2394, -698, -1388) - this returned
/// 0.6 m instead of 698 m, which handed the abyssal seabed full unattenuated
/// noon sun and full caustics through evalSun().
fn depthAt(worldPos: vec3f) -> f32 { return seaLevel() - (worldPos.y + frame.worldOrigin.y); }

/// Absolute world position, for anything that must be origin-stable
/// (noise lookups, biome queries, procedural texturing).
fn toAbsolute(worldPos: vec3f) -> vec3f { return worldPos + frame.worldOrigin.xyz; }

/// A per-pixel, per-frame blue-noise value in [0,1). Use for dithering,
/// stochastic sampling and volumetric jitter - never a hash of gl_FragCoord,
/// which produces visible structured noise once TAA gets hold of it.
fn blueNoise(pixel: vec2u) -> f32 {
  let dims = textureDimensions(blueNoiseTex, 0);
  let uv = vec2u(pixel.x % dims.x, pixel.y % dims.y);
  let base = textureLoad(blueNoiseTex, uv, 0).r;
  // Golden-ratio temporal offset keeps the sequence low-discrepancy over time,
  // which is exactly what TAA wants to average away cleanly.
  return fract(base + f32(frameIndex() & 0xffu) * 0.6180339887);
}
