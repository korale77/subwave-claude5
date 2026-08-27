// SUBWAVE - the ocean surface.
//
// Geometry: a camera-centred concentric-ring CLIPMAP, not a projected grid.
//
//   A projected grid puts vertices where the screen wants them, which is
//   strictly better sampling - and it is still the wrong choice here. Its
//   parameterisation lives in SCREEN space, so the moment the surface is
//   displaced horizontally (choppiness, which this ocean has a lot of) the
//   vertices slide relative to the wave field and the normals crawl; at grazing
//   angles the silhouette tears. Worse, the projector degenerates exactly at the
//   waterline, which is where SUBWAVE's camera spends most of its time, and it
//   has to be re-derived from scratch to draw the underside.
//
//   The clipmap's vertex XZ is fixed in WORLD space (snapped per level), so
//   displacement is stable, the same mesh draws from above and below with no
//   special case, the CPU buoyancy query and the drawn surface share a
//   parameterisation, and per-block frustum culling is trivial. Its only real
//   cost is triangles, and CDLOD morphing plus a horizon ring bounds that.
//
// Shading is split at dot(N, V): positive means we are looking at the top of
// this piece of surface, negative the underside. The two branches meet
// continuously - at grazing incidence Fresnel from above tends to 1 and total
// internal reflection from below also tends to 1 - so a camera sitting exactly
// on the waterline cannot produce a seam or a flicker along the boundary, and
// no second draw with a flipped cull mode is needed.
//
// The medium between this surface and the eye is NOT applied here. Seen from
// below, the underwater composite owns it; seen from above there is no water in
// front of the surface at all. Applying it twice is the failure mode to watch
// for, not forgetting it.

#define OCEAN_GROUP 1
#define OCEAN_BINDING 0
#include "../common/ocean.wgsl"
// The sky-view LUT is parameterised in the SUN's azimuth frame with a warped
// zenith angle, and it is sampled here through the atmosphere model's own
// skyViewUV() rather than a local reimplementation: an independent copy of that
// mapping is a silent rotation of every reflection the moment either side is
// tuned. Group 2 carries the Sky uniform (group 0 is the frame, group 1 the
// ocean), plus the transmittance and multiple-scattering LUTs at bindings 1-3,
// which is what lets aerialPerspective() run here. The sky pass applies aerial
// perspective as two fullscreen blends BEFORE the ocean draws, so without this
// the sea is the one surface in the frame with no atmosphere in front of it.
#define SKY_GROUP 2
#define SKY_HAS_LUTS
#define SKY_HAS_MULTISCATTER
#include "../common/atmosphere.wgsl"
#include "../common/frame.wgsl"
#include "../common/math.wgsl"
#include "../common/water.wgsl"
#include "../common/brdf.wgsl"
// For evalAmbientSH: foam and shallow water sit in the same SH-L2 sky
// irradiance as the terrain they meet at the shoreline.
#include "../common/lighting.wgsl"
#include "../common/noise.wgsl"

#ifndef OCEAN_BLOCK_CELLS
#define OCEAN_BLOCK_CELLS 32
#endif
#ifndef OCEAN_GERSTNER
#define OCEAN_GERSTNER 0
#endif

const CASCADES : u32 = u32(OCEAN_CASCADES);
const BLOCK_CELLS : f32 = f32(OCEAN_BLOCK_CELLS);

/// Smallest GGX alpha the sun highlight may take. A perfectly glassy sea would
/// concentrate the whole solar disc into a sub-pixel highlight that moves by
/// more than a pixel per frame - a firefly TAA cannot resolve. This is a
/// sampling floor, not a claim about the water.
const OCEAN_ALPHA_FLOOR : f32 = 0.022;

/// Smallest |N.V| the shading is allowed to see, radians-ish (0.57 degrees).
///
/// Its ONLY job is to stop N.V changing sign between neighbouring pixels on the
/// horizon line, where the filtered normal is numerically noise and a sign flip
/// swaps the above-water branch for the Snell's-window one. It must stay tiny:
/// grazing incidence is exactly where water stops being water-coloured and
/// becomes a mirror, so every hundredth of N.V this steals is reflectance taken
/// off the horizon. See the guard in fs_ocean for what a wide one costs.
const OCEAN_MIN_NDOTV : f32 = 0.01;

/// A clipmap block. `level` < 0 marks the single horizon annulus, which reuses
/// the same patch mapped to polar coordinates.
struct OceanBlock {
  origin : vec2f,   // absolute world XZ of the block's corner
  scale  : f32,     // metres per grid cell
  level  : f32,
  morph  : vec2f,   // CDLOD morph start/end radii, or horizon inner/outer radius
  pad    : vec2f,
};

@group(1) @binding(1) var dispTex  : texture_2d_array<f32>;
@group(1) @binding(2) var derivTex : texture_2d_array<f32>;
@group(1) @binding(3) var foamTex  : texture_2d_array<f32>;
@group(1) @binding(4) var sceneOpaque : texture_2d<f32>;
/// Depth of the OPAQUE scene, snapshotted by copyOpaque before this pass runs.
/// Emphatically not sceneDepth: our own prepass has already replaced that with
/// the water surface, so a column measured against it is always zero.
@group(1) @binding(5) var opaqueDepth : texture_depth_2d;
@group(1) @binding(6) var<storage, read> blocks : array<OceanBlock>;
/// ANISOTROPIC, and the shared frame.linearSampler is not - which matters here
/// and almost nowhere else in the frame, because the sea's screen footprint at
/// grazing incidence is extraordinarily elongated. Measured from the spawn
/// camera (5.2 m eye, 578 rows, pixelAngle 2.079 mrad): at 571 m one clipmap
/// cell covers 0.123 px along the view ray and 13.5 px across it, so the lattice
/// coordinate's screen derivatives are ~130 m/px against ~1.2 m/px - a ratio of
/// 108:1. An isotropic sampler takes its LOD from the LONG axis, so the horizon
/// was filtered to a 130 m texel in BOTH directions (mip 6 of a 2 m cascade) and
/// every long crest line - which is exactly what a real horizon shows - was
/// averaged away. Photographed at 6x with maxAnisotropy 1, the band under the
/// horizon is a smooth grey wash with no wave structure in it at all; at 8 the
/// same band carries crest lines to the skyline. See passes/ocean.js for why 8
/// rather than 16.
@group(1) @binding(7) var oceanAniso : sampler;

struct VSOut {
  @builtin(position) @invariant pos : vec4f,
  @location(0) worldRel  : vec3f,   // camera-relative displaced position
  @location(1) latticeXZ : vec2f,   // absolute UNdisplaced XZ - the texture domain
  @location(2) params    : vec3f,   // x = distance, y = cell size, z = horizon flag
  @location(3) curClip   : vec4f,   // UNJITTERED clip position, this frame
  @location(4) prevClip  : vec4f,   // UNJITTERED clip position, last frame
};

struct FragOut {
  @location(0) color    : vec4f,
  @location(1) velocity : vec2f,
};

fn cascadeSize(c: u32) -> f32 {
  if (c == 0u) { return ocean.cascadeL.x; }
  if (c == 1u) { return ocean.cascadeL.y; }
  return ocean.cascadeL.z;
}

// ---------------------------------------------------------------------------
// Vertex
// ---------------------------------------------------------------------------

@vertex
fn vs_ocean(@location(0) grid: vec2f, @builtin(instance_index) iid: u32) -> VSOut {
  let inst = blocks[iid];
  let camAbs = frame.cameraPos.xyz + frame.worldOrigin.xyz;
  var out: VSOut;

  var worldXZ : vec2f;
  var dist : f32;
  var isHorizon = 0.0;

  if (inst.level < 0.0) {
    // Horizon annulus. The sea has to reach the true horizon - 4.7 km for an
    // eye 1.7 m up, far further from the vessel at altitude - or sky shows
    // below the skyline. Undisplaced; the cubic radial warp puts most of the
    // vertices near the inner edge, which is where the curvature is.
    isHorizon = 1.0;
    let ang = (grid.x / BLOCK_CELLS) * TAU;
    let tr = grid.y / BLOCK_CELLS;
    let r = mix(inst.morph.x, inst.morph.y, tr * tr * tr);
    worldXZ = camAbs.xz + vec2f(sin(ang), cos(ang)) * r;
    dist = r;
  } else {
    // CDLOD morph. The morph factor is evaluated from the UNMORPHED position so
    // that a vertex shared with a neighbouring block computes the same value in
    // both - that identity is the entire crack-free guarantee.
    let pre = inst.origin + grid * inst.scale;
    dist = length(pre - camAbs.xz);
    let morph = saturate((dist - inst.morph.x) / max(inst.morph.y - inst.morph.x, 1e-3));
    let snapped = floor(grid * 0.5) * 2.0;
    worldXZ = inst.origin + mix(grid, snapped, morph) * inst.scale;
  }

  var disp = vec3f(0.0);
#if OCEAN_GERSTNER
  if (isHorizon < 0.5) {
    disp = oceanGerstnerAt(worldXZ, ocean.timing.x).disp;
  }
#else
  if (isHorizon < 0.5) {
    let nRes = ocean.cascadeChop.w;
    for (var c = 0u; c < CASCADES; c = c + 1u) {
      let fade = oceanCascadeFade(c, dist);
      if (fade <= 0.001) { continue; }
      let ln = cascadeSize(c);
      // Never sample finer than the vertex spacing can carry, or the mesh
      // aliases the wave field into a static moire that swims with the camera.
      let lod = max(0.0, log2(max(inst.scale, 1e-4) * nRes / ln));
      disp += textureSampleLevel(dispTex, linearSampler, worldXZ / ln, c, lod).xyz * fade;
    }
  } else {
    // The annulus starts at 2046 m and used to be a perfectly flat plane, which
    // is invisible at sea state 2 (a 0.32 m wave subtends 0.08 px there) and a
    // hard line where the textured sea stops at sea state 6 (4.2 m, 1.0 px).
    // Cascade 0 only, at a fixed mip 3 - 16 m texels, which is the annulus's own
    // vertex density near its inner edge; the polar layout's cubic radial warp
    // makes the spacing wildly uneven further out, so a spacing-derived LOD
    // would swim. Faded out by 6 km, past which the displacement is far under a
    // pixel and the fade itself cannot be seen.
    let horizonFade = 1.0 - smoothstep(3000.0, 6000.0, dist);
    if (horizonFade > 0.001) {
      disp = textureSampleLevel(dispTex, linearSampler,
                                worldXZ / ocean.cascadeL.x, 0, 3.0).xyz * horizonFade;
    }
  }
#endif

  let worldAbs = vec3f(worldXZ.x + disp.x, seaLevel() + disp.y, worldXZ.y + disp.z);
  out.worldRel = worldAbs - frame.worldOrigin.xyz;
  out.latticeXZ = worldXZ;
  out.params = vec3f(dist, inst.scale, isHorizon);
  out.pos = frame.viewProj * vec4f(out.worldRel, 1.0);
  // Motion vector, same construction as terrain.wgsl. The surface is treated as
  // STATIC in world space: the camera's motion is the whole of the reprojection
  // error TAA can actually fix, and the wave field's own motion cannot be
  // reprojected anyway without keeping last frame's displacement cascades. What
  // matters is that water pixels stop reporting zero velocity - over sky, where
  // nothing else writes the buffer, that reads as "this pixel did not move" and
  // smears the glitter into trails on every camera turn.
  out.curClip = frame.viewProjUnjittered * vec4f(out.worldRel, 1.0);
  out.prevClip = frame.prevViewProj * vec4f(out.worldRel, 1.0);
  return out;
}

// ---------------------------------------------------------------------------
// Surface reconstruction
// ---------------------------------------------------------------------------

struct SurfaceSample {
  normal   : vec3f,
  foam     : f32,
  foamAge  : f32,
};

/// Rebuild the shading normal and the foam coverage from the derivative and
/// foam cascades.
fn sampleSurface(latticeXZ: vec2f, dist: f32) -> SurfaceSample {
  var out: SurfaceSample;
  var slope = vec2f(0.0);
  var clear = 1.0;      // product of (1 - foam_c): foam coverage is a union
  var age = 0.0;

  // Screen-space derivatives of the lattice coordinate, taken HERE in uniform
  // control flow. The cascade loop below skips faded cascades with `continue`,
  // which makes it non-uniform, and WGSL forbids implicit-derivative sampling
  // (textureSample) there. Hoisting the derivatives out and using
  // textureSampleGrad keeps correct per-cascade mip selection - which the ocean
  // genuinely needs, since dropping to mip 0 makes the far sea crawl with
  // aliased white sparkle.
  let dLatticeDx = dpdx(latticeXZ);
  let dLatticeDy = dpdy(latticeXZ);

#if OCEAN_GERSTNER
  // Half the components in the fragment stage. Waves are stored in descending
  // amplitude order, so the truncation drops exactly the ripples that a pixel
  // this far from the camera could not resolve anyway - and this is the LOW
  // tier's fill-rate-bound path.
  let g = oceanGerstnerCount(latticeXZ, ocean.timing.x, OCEAN_GERSTNER_WAVES / 2u);
  slope = g.slope;
  // No Jacobian on the Gerstner path, so foam uses a crest-and-slope proxy -
  // which is what a breaking wave looks like from the outside anyway.
  let crest = smoothstep(0.62, 0.94, g.disp.y / max(ocean.wind.w, 0.05));
  clear = 1.0 - crest * smoothstep(0.20, 0.60, length(slope));
#else
  for (var c = 0u; c < CASCADES; c = c + 1u) {
    let fade = oceanCascadeFade(c, dist);
    if (fade <= 0.001) { continue; }
    let ln = cascadeSize(c);
    let uv = latticeXZ / ln;
    let invLn = 1.0 / ln;
    let ddxUv = dLatticeDx * invLn;
    let ddyUv = dLatticeDy * invLn;
    let d = textureSampleGrad(derivTex, oceanAniso, uv, c, ddxUv, ddyUv);
    // Horizontal compression steepens the apparent slope: the height gradient
    // was measured in lattice space, and the lattice is being squeezed.
    let compress = max(1.0 + d.z * 0.5, 0.15);
    slope += (d.xy / compress) * fade;

    let f = textureSampleGrad(foamTex, oceanAniso, uv, c, ddxUv, ddyUv);
    clear *= 1.0 - saturate(f.x) * fade;
    age = max(age, f.y);
  }
#endif

  out.normal = normalize(vec3f(-slope.x, 1.0, -slope.y));
  out.foam = 1.0 - clear;
  out.foamAge = age;
  return out;
}

/// Sky radiance in a direction.
///
/// Reflected rays that point BELOW the horizon happen constantly on a rough
/// sea, and what to return for them decides how the whole sea reads. Black is
/// the biggest tell of a fake ocean. The water's own ambient - what this used
/// to return - is nearly as bad, because those rays are most common exactly at
/// grazing incidence, which is where the surface should be a MIRROR: the sea
/// then goes matte and dark precisely where it should be brightest.
///
/// So the ray is folded back above the horizon rather than clamped to it. That
/// is not a fudge: a downward ray from a wave face strikes the back of the next
/// wave, which is itself a water surface reflecting the sky at a shallow angle,
/// so sky is the physically dominant answer. Folding (rather than clamping)
/// keeps the mapping continuous, so no band appears along the fold.
fn skyRadiance(dirIn: vec3f) -> vec3f {
  var dir = dirIn;
  if (dir.y < 0.0) {
    dir = normalize(vec3f(dir.x, -dir.y * 0.4, dir.z));
  }
  // Clamped, not repeating: u folds the azimuth about the sun into [0, PI] with
  // a half-texel inset, so wrapping in u would mirror the sky at the seam.
  let r = skyGroundRadius() + max(frame.worldOrigin.y + frame.cameraPos.y, 0.0);
  return textureSampleLevel(skyLUT, linearClampSampler, skyViewUV(dir, r), 0.0).rgb;
}

/// Aerial perspective over the sea.
///
/// The sky pass applies this to everything it can see as two fullscreen blends,
/// but it runs BEFORE the ocean surface, so the water would otherwise be the
/// only thing in the frame with no air in front of it - and the sea reaches
/// 60 km, further than any terrain. That mismatch is what puts a hard band
/// where the sea meets the sky: the sky above the line is fully hazed and the
/// water below it is not hazed at all.
///
/// Same function the terrain goes through, so the two agree by construction.
fn seaAerial(colour: vec3f, viewDir: vec3f, dist: f32) -> vec3f {
  let eyeY = max(frame.worldOrigin.y + frame.cameraPos.y, 0.0);

  // The sea is drawn as a FLAT plane out to 60 km, but the world is a planet.
  // An eye h metres up can only see water within sqrt(2*Rg*h) - 4.7 km at
  // standing height, 18 km from 26 m - and everything past that is below the
  // true horizon, hidden by the bulge. The sky pass already puts its horizon
  // there, because the sky-view LUT is parameterised by the viewer's radius.
  // Drawing flat water past it is what leaves a distinct band between the sea
  // and the sky that belongs to neither.
  let horizon = sqrt(2.0 * skyGroundRadius() * max(eyeY, 0.05));

  let ap = aerialPerspective(eyeY, viewDir, min(dist, horizon));
  let hazed = colour * ap.transmittance + ap.inScatter;

  // Over the last fifth of that distance the water left above the bulge is
  // thinner than a pixel, so hand it to the sky outright. The two then meet
  // with no seam at all, because the sea's last value IS the sky's first.
  return mix(hazed, skyRadiance(viewDir), smoothstep(horizon * 0.80, horizon, dist));
}

/// Foam is a dense scattering slab, not a lambertian sheet: it needs a wrap
/// term and a strong forward transmission, which is what makes a backlit
/// breaking crest glow instead of going flat grey.
fn shadeFoam(n: vec3f, v: vec3f, age: f32) -> vec3f {
  let fresh = 1.0 - smoothstep(0.35, 2.0, age);
  let albedo = mix(vec3f(0.62, 0.68, 0.72), vec3f(0.92, 0.94, 0.95), fresh);
  let l = frame.sunDir.xyz;
  let wrap = saturate((dot(n, l) + 0.35) / 1.35);
  let through = pow(saturate(dot(v, -l)), 3.5) * 0.6;
  let direct = frame.sunIlluminance.rgb * (wrap + through) * INV_PI;
  return albedo * (direct + evalAmbientSH(n));
}

/// Camera-relative world position behind a pixel, from the OPAQUE depth buffer.
/// Reverse-Z: `ndcZ` of 0 means "no geometry", so every caller has to make that
/// test before this one - there is no position to reconstruct there.
fn worldFromOpaqueDepth(uv: vec2f, ndcZ: f32) -> vec3f {
  let ndc = vec3f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, ndcZ);
  let p = frame.invViewProj * vec4f(ndc, 1.0);
  return p.xyz / p.w;
}

/// Water-leaving radiance over a bottom of albedo `rho` under `h` metres of
/// water. THE DIFFUSE PATH - down and back up the VERTICAL column - so it is
/// governed by Kd, not by sigma_t.
///
/// This is the term that makes a lagoon turquoise and the open sea deep blue,
/// and the shader had nothing like it: the body colour was either the raw
/// sceneOpaque sample (a seabed already attenuated along the SLANT by
/// terrain.wgsl) or one constant. The beam form is worthless at any grazing
/// angle - at 3 degrees of depression a 15 m lagoon floor is 287 m of slant, and
/// exp(-0.304 * 287) is 1e-38 - so from 45 m out the whole sea had exactly one
/// colour: measured cross-sun, [1.4, 2.4, 3.3] flat from 45 m to 241 m with a
/// luminance p95/p05 of 1.217. Computed with the live frame values, this returns
/// (1.13, 3.70, 3.82) over 3 m of reef sand against the old constant's
/// (0.060, 0.257, 0.578) - 13x the luminance and a completely different hue -
/// and settles onto that same constant by 30 m, which is exactly the asymptote
/// shallowWaterColour() gives for an infinite column.
///
/// ON surfaceKd() AND NOT frame.waterKd, and this is the whole reason a reef
/// reads turquoise from the air. This `T` IS the turquoise: the water is
/// coloured by what it takes OUT of the bottom albedo on the way down and back,
/// so it needs the red-green asymmetry that the 2026-08-02 art cut removed.
/// Measured on the cut column, REEF_TURQUOISE's red Kd is 0.0791 against a
/// green 0.0725 - so `T` is very nearly grey, `mix` returns something very
/// nearly the raw carbonate sand, and the shallows came back a flat 234 deg
/// blue at saturation 0.43 where they had been 204 deg at 0.97. See the
/// waterSurfaceKd block in common/frame.wgsl.
fn oceanBodyColour(h: f32, rho: vec3f) -> vec3f {
  // Down and back up, so 2h of Kd. Multiple scattering has already flattened
  // the upwelling field by the time it leaves, hence the 1/PI.
  let T = exp(-2.0 * surfaceKd() * max(h, 0.0));
  return mix(deepWaterReflectance(), rho, T) * INV_PI * ambientAtDepth(0.0);
}

// ---------------------------------------------------------------------------
// Above the surface
// ---------------------------------------------------------------------------

fn shadeAbove(in: VSOut, n: vec3f, v: vec3f, cosI: f32, alpha: f32, a2: f32,
              mssTotal: f32, footprint: f32, surf: SurfaceSample) -> vec3f {
  // --- Fresnel --------------------------------------------------------------
  // F0 = 0.02 looking straight down, running to a near-mirror at grazing. That
  // SWING is the strongest single cue that a flat sheet is water, and it is the
  // thing that has to visibly change as the player turns.
  //
  // Slope-averaged over the sea's own Gaussian facet distribution, NOT the
  // split-sum DFG - see oceanMeanFresnel in common/ocean.wgsl for why the DFG
  // pinned this at a constant 0.285 over 95% of the frame and what that measured
  // like. sqrt(mssTotal) is the RMS slope the same Cox-Munk statistic gives the
  // roughness, so reflectance and lobe width now come from one number.
  let fresnel = oceanMeanFresnel(cosI, sqrt(mssTotal));

  let reflected = skyRadiance(reflect(-v, n));

  // --- sun glitter ----------------------------------------------------------
  // The sun is an area light. Karis' normalisation widens the lobe by the
  // source's angular radius and removes the energy that widening would add, so
  // the highlight keeps the right brightness as the sea calms.
  let l = frame.sunDir.xyz;
  let h = normalize(l + v);
  let noh = saturate(dot(n, h));
  let nol = saturate(dot(n, l));
  let alphaEff = saturate(alpha + frame.sunDir.w * 0.5);
  let k = alpha / max(alphaEff, 1e-4);
  let dTerm = D_GGX(noh, alphaEff * alphaEff);
  let visTerm = V_SmithGGXCorrelated(cosI, nol, a2);
  let glitter = frame.sunIlluminance.rgb * (dTerm * visTerm * nol * k * k * fresnel);

  // --- refraction -----------------------------------------------------------
  let uv = in.pos.xy * frame.screen.zw;
  let maxPix = vec2i(frame.screen.xy) - vec2i(1);
  let pix = clamp(vec2i(in.pos.xy), vec2i(0), maxPix);
  let surfaceLinear = linearizeDepth(in.pos.z, nearPlane());

  // The distortion is a lateral shift measured in the camera's own basis, so it
  // bends the way the surface tilts ON SCREEN rather than the way it tilts in
  // the world - which is what the eye actually reads.
  let bend = n - vec3f(0.0, 1.0, 0.0);
  let bendScreen = vec2f(dot(bend, frame.cameraRight.xyz), -dot(bend, frame.cameraUp.xyz));
  let projScale = 0.5 * frame.screen.y / max(frame.cameraFwd.w, 1e-3);

  // Reverse-Z clears to 0, so ndc == 0 means "nothing opaque here": open ocean
  // with only sky behind it. That distinction has to be made against the OPAQUE
  // depth; sceneDepth at this point is the water itself.
  let sceneNdcC = textureLoad(opaqueDepth, pix, 0);
  let hasFloor = sceneNdcC > 1e-7;
  var sceneLinearC = frame.camPlanes.w;
  if (hasFloor) { sceneLinearC = linearizeDepth(sceneNdcC, nearPlane()); }
  let columnGuess = max(sceneLinearC - surfaceLinear, 0.0);
  let strength = 0.18 * min(columnGuess, 0.60);
  let uvOff = bendScreen * (strength * projScale / max(surfaceLinear, 0.1)) * frame.screen.zw;

  // Per-channel dispersion, each independently rejected if it would pull in a
  // sample that is IN FRONT of the water. Refracting the vessel's own hull
  // through the surface it is floating on is the classic artefact here, and the
  // rejection has to be per channel or the fringe itself smears geometry.
  var refr = vec3f(0.0);
  var slantPath = 0.0;
  for (var ch = 0; ch < 3; ch = ch + 1) {
    let scale = 1.0 - 0.015 * f32(ch);
    var uvC = clamp(uv + uvOff * scale, vec2f(0.0), vec2f(1.0));
    let pc = clamp(vec2i(uvC * frame.screen.xy), vec2i(0), maxPix);
    let ndcC = textureLoad(opaqueDepth, pc, 0);
    var lin = frame.camPlanes.w;
    if (ndcC > 1e-7) { lin = linearizeDepth(ndcC, nearPlane()); }
    if (lin < surfaceLinear) {
      uvC = uv;
      lin = sceneLinearC;
    }
    refr[ch] = textureSampleLevel(sceneOpaque, linearClampSampler, uvC, 0.0)[ch];
    if (ch == 1) { slantPath = max(lin - surfaceLinear, 0.0); }
  }

  // Water column between the surface and whatever the refracted ray found.
  //
  // THE SEABED SAMPLE ALREADY CARRIES THE WATER IN FRONT OF IT. This branch is
  // only ever reached with the eye in air, and terrain.wgsl ends every submerged
  // fragment with applyViewRayWater() over the submerged length of its own view
  // ray in exactly that case, so sceneOpaque holds a seabed that is already
  // attenuated and already hazed. Running the medium over it again here is the
  // exact double-count this file's header warns about: it squares the
  // transmittance, so sand under 2 m of water fades as though it lay under 4,
  // and it adds the in-scatter twice. That is what replaced the shallows with
  // a flat sheet of cyan with no seabed in it.
  //
  // With no seabed there is nothing that could have been fogged, and the answer
  // is the medium's own asymptotic colour - NOT the unattenuated sceneOpaque
  // sample, which over open water is the sky. Getting that branch wrong paints
  // the whole ocean the colour of whatever the sky pass drew below the horizon.
  //
  // THE COLUMN IS VERTICAL AND THE BEAM PATH IS NOT. `slantPath` is what the
  // seabed sample travelled along the view ray; the diffuse upwelling term needs
  // the depth of the water standing over that point, which is angle-independent
  // and comes straight out of the depth buffer. The old proxy for it -
  // colPath * max(|v.y|, 0.15) - overestimates by the ratio of the two at
  // grazing: from a beach at 3 degrees of depression it reported 43 m of water
  // over a 15 m floor, which is why the shoreline surf never appeared from
  // anywhere but directly overhead.
  var columnDepth = 400.0;
  var body = shallowWaterColour(400.0, vec3f(0.0));
  if (hasFloor) {
    columnDepth = clamp(depthAt(worldFromOpaqueDepth(uv, sceneNdcC)), 0.0, 400.0);
    // How much of the beam actually survived to carry the seabed here, PER
    // CHANNEL. A steep, short column keeps the crisp refracted sand; a grazing
    // one has nothing left of it and gets the diffuse answer instead. Blending
    // by the beam's own loss makes the handover exact rather than double-counted
    // - what `refr` still delivers is precisely what the diffuse term must not
    // claim - and both limits agree by construction: at zero path the diffuse
    // form IS the bottom radiance, and at infinite path `refr` is only its own
    // in-scatter, which is the term that does not know there is sand down there.
    //
    // Per channel because sigma_t spans 6:1 across RGB in clear water, so a
    // scalar mean throws away seabed detail in blue - which is the channel that
    // carries it furthest and the reason a sandy bottom stays legible at all.
    // Measured over 4 m of Jerlov IA at 25 degrees: red hands over 92% to the
    // diffuse term and blue only 33%.
    //
    // THE TWO SIDES OF THIS MIX ARE ON DIFFERENT COEFFICIENT SETS ON PURPOSE,
    // AND beamLoss STAYS ON THE ART sigma_t. `refr` is a sceneOpaque sample
    // that terrain.wgsl's applyViewRayWater() already attenuated with the LIVE
    // art column; weighting it by a physical beamLoss would claim a loss that
    // sample never took, which is the same double-count the block above exists
    // to prevent. So the weight matches what produced `refr`, and only the
    // diffuse endpoint - which nothing else has touched - gets the physical red.
    // The partition-of-unity argument above stays exact in G and B and becomes
    // approximate in R; that is the whole price of the split, and it is bounded
    // by the refr weight, which is 0.38-0.44 straight down and 0.18-0.24 at the
    // 35 deg depression a flyover actually frames at.
    let beamLoss = vec3f(1.0) - exp(-frame.waterSigmaT.rgb * slantPath);
    body = mix(refr, oceanBodyColour(columnDepth, frame.waterBottom.rgb), beamLoss);
  }

  // --- shoreline surf -------------------------------------------------------
  // Iso-depth contours are shore-parallel to first order, so the water column
  // stands in for a shoreline distance field - and now that the column is
  // measured against the OPAQUE depth rather than against the water's own
  // prepass, it is a real one instead of an identically-zero one. Two bands at
  // incommensurate spacings keep the surf from looking metronomic.
  //
  // Metres, not tens of metres: surf breaks in the last few metres of water,
  // and the previous 22 m / 41 m spacings put a single band across a whole bay.
  let t = currentTime();
  let hCol = columnDepth;
  let ph1 = hCol / 2.30 - t / 6.5;
  let ph2 = hCol / 4.10 - t / 6.5 + 0.37;
  let band = pow(saturate(sin(TAU * ph1) * 0.5 + 0.5), 5.0)
           + 0.7 * pow(saturate(sin(TAU * ph2) * 0.5 + 0.5), 5.0);
  let along = 0.55 + 0.45 * to01(value2(in.latticeXZ * 0.09 + vec2f(t * 0.02), 1518u));
  // Driven mostly by WIND. Keyed to Hs ALONE the way it was, a sea state 2 day
  // (Hs = 0.32 m) fell below the 0.35 threshold and the entire shoreline had no
  // surf on it at all - which is not what a calm beach looks like. Hs comes back
  // in as a second, additive term rather than as a gate, so a raised sea state
  // does break harder on the beach instead of breaking identically: at Hs 0.32 m
  // the wave term adds 0.06 and at 4.2 m it adds the full 0.35.
  let surfGain = saturate(smoothstep(0.5, 6.0, ocean.wind.z)
                        + 0.35 * smoothstep(0.0, 4.0, ocean.wind.w));
  // The waterline itself. Without this the surface simply ends on the polygon
  // edge where the seabed rises through it - a hard, crawling, aliased line.
  // Real water always carries a band of foam and wet sheen in its last few
  // centimetres, and that band is what makes the boundary read as soft.
  //
  // 22 cm, not half a metre: a beach at 1:20 turns every centimetre of depth
  // into 20 cm of shoreline, so a band keyed to half a metre of water is ten
  // metres wide and reads as a fog bank lying on the sand rather than as surf.
  // Capped below 1 as well, so the cellular erosion below always has something
  // to bite into and the band never becomes a solid sheet.
  let edgeFoam = smoothstep(0.22, 0.02, hCol) * (0.45 + 0.55 * along) * 0.9;
  let shoreFoam = max(saturate(band * along) * smoothstep(3.0, 0.0, hCol) * surfGain,
                      edgeFoam);

  // --- foam -----------------------------------------------------------------
  // Erode the accumulator with multi-scale cellular noise so foam reads as torn
  // sheets rather than as a soft blob tracing the Jacobian exactly.
  //
  // FADED OUT WITH THE PIXEL FOOTPRINT, and that is not a refinement. The
  // erosion's largest feature is 1/1.7 = 0.59 m of world space and it is
  // evaluated at full frequency at every distance, while the threshold
  // smoothstep is only 0.28 wide - so it BINARISES an aliased sample. It never
  // showed while the Jacobian produced no foam anywhere; the moment the cascade
  // renormalisation made whitecaps real, the far sea came back as a mosaic of
  // hard-edged white rectangles that read as pack ice, which is strictly worse
  // than the flat sheet it replaced.
  //
  // Past about a metre of footprint the honest answer is simply `coverage`: a
  // pixel holding 30% whitecap is 30% white, which is exactly what the filtered
  // accumulator already says. So the torn-sheet detail is a NEAR-FIELD term and
  // it dissolves into its own area mean.
  //
  // The gate is also what makes this cheap: two worley2 calls are ~18 hashes and
  // 18 lengths, and they are now skipped for the whole distant sea and for every
  // pixel with no foam on it. Legal in non-uniform control flow because
  // worley2/value2 sample no texture, so there is no implicit-derivative hazard
  // (which is exactly why the cascade loop above uses textureSampleGrad).
  let coverage = saturate(max(surf.foam * 1.35, shoreFoam));
  let foamDetail = 1.0 - smoothstep(0.35, 1.60, footprint);
  var foamMask = coverage;
  if (coverage > 0.002 && foamDetail > 0.004) {
    let erosion = worley2(in.latticeXZ * 1.7 + vec2f(t * 0.05), 17u, 1.0).x * 0.55
                + worley2(in.latticeXZ * 6.1 + vec2f(t * 0.11), 34u, 1.0).x * 0.30
                + to01(value2(in.latticeXZ * 19.0, 51u)) * 0.15;
    foamMask = mix(coverage, smoothstep(erosion - 0.14, erosion + 0.14, coverage), foamDetail);
  }

  let water = mix(body, reflected, fresnel) + glitter;
  return mix(water, shadeFoam(n, v, surf.foamAge), foamMask);
}

// ---------------------------------------------------------------------------
// Below the surface - Snell's window
// ---------------------------------------------------------------------------

/// Every ray leaving the water bends AWAY from the normal, so the entire sky -
/// a full hemisphere - is compressed into a cone of half-angle
/// asin(1/1.339) = 48.31 degrees: a bright disc about 96.6 degrees across
/// directly overhead. Outside that cone nothing in the air can reach the eye and
/// the ceiling becomes a perfect mirror of the water below.
///
/// The reflectance ramp is not authored. Exact unpolarised Fresnel reaches 1.0
/// precisely at the critical angle on its own; Schlick, which has no total
/// internal reflection at all, would leave the underside half-transparent
/// everywhere and destroy the effect.
fn shadeBelow(n: vec3f, v: vec3f, cosI: f32, surf: SurfaceSample) -> vec3f {
  let nDown = -n;
  let incident = -v;

  let reflectance = oceanFresnelExact(cosI, OCEAN_IOR);
  let sin2T = OCEAN_IOR * OCEAN_IOR * (1.0 - cosI * cosI);

  var transmitted = vec3f(0.0);
  if (sin2T < 1.0) {
    // Chromatic dispersion: red bends least, so the rim of the window carries a
    // real prismatic fringe. Three refracted directions, three sky samples.
    for (var ch = 0; ch < 3; ch = ch + 1) {
      let e = OCEAN_IOR_RGB[ch];
      let s2 = e * e * (1.0 - cosI * cosI);
      var dir : vec3f;
      if (s2 < 1.0) {
        dir = e * incident + (e * cosI - sqrt(1.0 - s2)) * nDown;
      } else {
        dir = reflect(incident, nDown);
      }
      dir = normalize(dir);
      transmitted[ch] = skyRadiance(dir)[ch];
      // The sun itself, compressed into the window along with everything else.
      let sunCos = dot(dir, frame.sunDir.xyz);
      transmitted[ch] += frame.sunIlluminance[ch] * 12.0
                       * smoothstep(cos(frame.sunDir.w * 2.0), cos(frame.sunDir.w), sunCos);
    }
  }

  // Total internal reflection. There is no opaque geometry above to reflect, so
  // the reflected radiance is the medium's own - which is exactly right, and is
  // why the underside outside the window reads as dark, glassy and infinite.
  let depth = cameraDepth();
  let mirrored = applyWaterMedium(vec3f(0.0), 60.0, depth, reflect(incident, nDown))
               * aphoticFactor(depth);

  var colour = mix(transmitted, mirrored, reflectance);

  // Foam from below is a diffuse sheet passing about 30% of the light and
  // scattering the rest forward; a squall overhead reads as a stippled ceiling.
  let foamMask = saturate(surf.foam * 1.35);
  if (foamMask > 0.001) {
    colour = mix(colour, shadeFoam(nDown, v, surf.foamAge) * 0.30, foamMask);
  }
  return colour;
}

// ---------------------------------------------------------------------------
// Fragment
// ---------------------------------------------------------------------------

@fragment
fn fs_ocean(in: VSOut) -> FragOut {
  let toEye = frame.cameraPos.xyz - in.worldRel;
  let viewDist = max(length(toEye), 1e-4);
  let v = toEye / viewDist;

  // Metres of sea covered by one pixel at this distance and grazing angle.
  // Without the 1/|v.y| term the horizon band under-reports its own footprint
  // by two orders of magnitude, which is exactly where the foam erosion aliases.
  let pixelAngle = 2.0 * frame.cameraFwd.w * frame.screen.w;
  let footprint = viewDist * pixelAngle / max(0.05, abs(v.y));

  let surf = sampleSurface(in.latticeXZ, in.params.x);
  var n = surf.normal;

  // Grazing-angle guard, and it has to be MINIMAL: push the normal along the
  // view ray by exactly the shortfall in |N.V| and not one step further.
  //
  // Every previous version of this line was a blend toward the eye across a
  // threshold band, and both of them were far too wide. |N.V| < t means "more
  // than eyeHeight/t metres away", so a 26 m eye with t = 0.05 has the guard
  // covering everything past 520 m - most of the visible sea - and the blend
  // lifted |N.V| at the horizon itself from 0.005 to 0.48. The split-sum
  // reflectance at |N.V| = 0.48 is 0.08 against 0.23 at the true angle, so the
  // sea stopped mirroring the sky and fell back to its own near-black deep
  // colour. Measured off sceneColor at 18 m eye height: 918 m of sea came back
  // at G 0.36 under a horizon sky of G 5.83 that it is supposed to be
  // reflecting, and the step where the guard switched on was visible as a hard
  // dark band along the whole horizon.
  //
  // Signed, so the underside keeps its own sign and a camera on the waterline
  // does not flicker between the two branches.
  let nv0 = dot(n, v);
  let deficit = OCEAN_MIN_NDOTV - abs(nv0);
  if (deficit > 0.0) {
    n = normalize(n + v * select(-deficit, deficit, nv0 >= 0.0));
  }

  let ndotv = dot(n, v);
  let cosI = max(abs(ndotv), 1e-4);

  // --- roughness ------------------------------------------------------------
  // Every square metre of real sea carries the slope variance Cox & Munk
  // photographed in 1954. The cascades reproduce only the part of that variance
  // whose wavelengths they resolve - by construction OCEAN.RESOLVED_SLOPE_FRACTION
  // of it near the camera, with the rest living below the 8 cm cutoff that keeps
  // the ripple cascade from aliasing, and less than that as the pixel footprint
  // outruns the mip chain.
  //
  // That missing slope is not allowed to simply vanish: it is what the sun
  // glitters off. Handing the DEFICIT to the microfacet roughness is the exact
  // statement of "these facets are there, we just are not drawing them", and it
  // is what turns the specular into a broad sun path full of sparkle instead of
  // a single mirror-sharp dot.
  //
  //   GGX alpha^2 = 2 * (per-axis slope variance) = total mean-square slope,
  //
  // so alpha is simply sqrt of the mss we are not carrying in the normal.
  //
  // ONE ACCOUNTING OF THE MISSING SLOPE, NOT TWO. This used to add the mip
  // chain's own slope-variance channel on top of the deficit, and the two are
  // the same quantity measured twice: as the footprint grows, mssResolved falls
  // to zero and mssMissing rises to the whole Cox-Munk total, while the mip
  // channel independently rises to the whole of what the cascades carried.
  // Measured at U = 4.5: 0.0231 + 0.0106 = 0.0337 against the correct 0.0231, so
  // alpha came out 0.184 instead of 0.152 - 21% too rough, exactly at the
  // horizon where the reflectance matters most.
  let mssTotal = oceanCoxMunkSlopeVariance(ocean.wind.z);
  // Slope the cascades do carry at this pixel, from the normal we just built.
  let slope = vec2f(-n.x, -n.z) / max(n.y, 1e-3);
  let mssResolved = dot(slope, slope);
  let mssMissing = max(mssTotal - mssResolved, 0.0);
  let alpha = clamp(sqrt(mssMissing + OCEAN_ALPHA_FLOOR * OCEAN_ALPHA_FLOOR),
                    OCEAN_ALPHA_FLOOR, 0.42);

  var colour : vec3f;
  if (ndotv >= 0.0) {
    colour = shadeAbove(in, n, v, cosI, alpha, alpha * alpha, mssTotal, footprint, surf);
    // Aerial perspective, but only from ABOVE: seen from underneath the medium
    // between the eye and the surface is water, and the underwater composite
    // owns that. Applying air here as well would double-count it.
    colour = seaAerial(colour, -v, viewDist);
  } else {
    colour = shadeBelow(n, v, cosI, surf);
  }

  let cur = in.curClip.xy / max(in.curClip.w, 1e-6);
  let prv = in.prevClip.xy / max(in.prevClip.w, 1e-6);

  var out : FragOut;
  out.color = vec4f(colour, 1.0);
  // NDC -> UV: half scale, and y flips because UV runs down the screen.
  out.velocity = (cur - prv) * vec2f(0.5, -0.5);
  return out;
}
