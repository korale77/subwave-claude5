// SUBWAVE - cave chunks (the volumetric override's marched surfaces).
//
// One draw per resident cave chunk, the terrain pass's little sibling: same
// targets (sceneColor + velocity + aoGate + reverse-Z depth), same static
// motion vectors, same medium ownership (applyViewRayWater stands down for a
// submerged eye, applyViewRayFroxel composites the aerial volume in air), same
// SSAO gate. What differs is the vertex stream - chunk-local f32 positions off
// a 3-D chunk origin, marched normals, and a 4-byte aux channel - and one
// lighting decision stated here because no common owns it:
//
// THE SKY IS GATED PER VERTEX, NOT PER FRAME. evalAmbient()'s SH is the
// above-water sky attenuated by the water column (common/lighting.wgsl), and
// evalSun() is the refracted solar beam - both are ILLUMINATION paths with no
// idea that 40 m of basalt stands between this wall and the surface. The baked
// `skylight` channel (world/cave_mesh.js: 1.0 at the heightfield surface, 0 by
// 10 m below it) is the occlusion signal, and it multiplies the sun, the moon,
// the SH ambient AND the deep key - the deep key is the open ocean's own
// asymptotic light field, which a roof occludes exactly as it occludes
// daylight. Punctual lights (the suit lamp, the vessel floods) are NOT gated:
// a lamp is in the cave with you. Without this gate a chamber at 60 m reads as
// a brightly lit blue room; measured on the sealed-room bug this class of leak
// was 63.7% of the frame at 8 m and 100% at 900 m.
//
// GROTTO EMISSION is a surface radiance (bioluminescent film on the rock), not
// a submitted light: it composites like the scatter emitters and drives no
// cluster list. Patchy by worley colony mask so it reads as growth, not paint.

#include "../common/frame.wgsl"
#include "../common/math.wgsl"
#include "../common/noise.wgsl"
#include "../common/brdf.wgsl"
#include "../common/shadow.wgsl"
#include "../common/water.wgsl"
#include "../common/lighting.wgsl"
#include "../common/triplanar.wgsl"

struct CaveChunkUniform {
  /// xyz = chunk lattice origin in CAMERA-RELATIVE space (CPU subtracted
  /// frame.worldOrigin in f64), w = unused.
  origin : vec4f,
  /// Reserved.
  params : vec4f,
};

@group(1) @binding(0) var<uniform> chunk : CaveChunkUniform;

struct VSOut {
  @builtin(position) pos : vec4f,
  @location(0) worldPos  : vec3f,   // camera-relative
  @location(1) normal    : vec3f,
  /// x: mouth-band weight, y: baked skylight, z: grotto weight, w: spare.
  /// Separate channels on purpose - see the encode comment in
  /// world/cave_mesh.js for the interpolation trap a packed class id has.
  @location(2) aux       : vec4f,
  @location(3) curClip   : vec4f,
  @location(4) prevClip  : vec4f,
};

@vertex
fn vs_cave(
  @location(0) localPos : vec3f,
  @location(1) normal   : vec3f,
  @location(2) aux      : vec4f,
) -> VSOut {
  var out : VSOut;
  let p = chunk.origin.xyz + localPos;
  out.worldPos = p;
  out.normal = normal;
  out.aux = aux;
  out.pos = frame.viewProj * vec4f(p, 1.0);
  // Static geometry: only the camera moved, both matrices UNJITTERED, exactly
  // as vs_terrain does it.
  out.curClip = frame.viewProjUnjittered * vec4f(p, 1.0);
  out.prevClip = frame.prevViewProj * vec4f(p, 1.0);
  return out;
}

// ---------------------------------------------------------------------------
// Substrate: wet cave basalt. Deliberately far simpler than the terrain's
// geology stack - a cave wall is one lithology seen by lamplight - but not
// flat: two relief bands drive a real surface-gradient normal, and the albedo
// carries the same two bands so light and colour agree about the bumps.
// ---------------------------------------------------------------------------

const CAVE_ROCK_MID  : f32 = 0.2910;   // tiles/m, matches the terrain's rock mid
const CAVE_ROCK_FINE : f32 = 1.1300;
const FEAT_MID       : f32 = 1.70;     // metres, for bandGain
const FEAT_FINE      : f32 = 0.45;
const RELIEF_MID     : f32 = 0.30;     // metres of displacement
const RELIEF_FINE    : f32 = 0.035;
const SEED_CAVE_ROCK : u32 = 0x6c11u;

/// Base reflectance of wet basalt. Darker than the terrain's open-water rock:
/// a cave wall is water-polished, never silted, never algae-dusted. Measured
/// against the delivered frame, not guessed: at 0.052 the suit lamp plus a
/// deep frame's 24-26x auto-exposure blew every near wall to a white disc,
/// because the surrounding deep seabed albedo it is exposed against is 3-5x
/// darker than that.
const CAVE_ALBEDO : vec3f = vec3f(0.030, 0.029, 0.027);
/// The mouth band brightens only slightly toward sediment; the first cut used
/// the shallow-reef sediment tone (0.105) and the whole rim photographed as a
/// glowing white dome against Abyssal Void basalt. Matching every biome's own
/// albedo needs the biome baker plumbed into the cave bake (DESIGN/02 8.6's
/// "biome from H()" material), which this pass does not do yet.
const MOUTH_ALBEDO : vec3f = vec3f(0.040, 0.038, 0.034);

/// Grotto film emission, linear radiance at full colony coverage. Sized
/// against the deep frames it lives in (measured there, not against daylight):
/// bright enough to read as a light source on a wall the suit lamp misses,
/// small enough not to move the histogram of a frame it fills.
const GROTTO_RADIANCE : vec3f = vec3f(0.010, 0.052, 0.041);

/// Authored-site (Jellyshroom Hollow) wall treatment, driven by the aux.w
/// weight world/cave_mesh.js bakes from caves.js mesh.authored. Two halves:
/// a violet ROTATION of the basalt albedo (Rec709 luma 0.86 weighted on
/// CAVE_ALBEDO - a deliberate 14% darkening with the hue turn, the dark rock
/// the reference's black backdrop needs; the fogTint rule one scale down,
/// bent that far and no further), and a
/// patchy magenta film like the grotto's, which is what makes the reference's
/// floor read purple where the cap-lights hit it and glow faintly where they
/// do not.
// First delivered frames read INDIGO, not purple, and the film's worley
// mottling owned the whole wall: blue channel led red 1.5:1 and the colony
// threshold passed most of the surface. The reference wants near-dark rock
// with magenta-violet accents, so the film lost 2x of its energy, its red
// caught up to its blue, and the colony gate tightened.
const JELLY_WALL_TINT : vec3f = vec3f(1.75, 0.50, 1.80);
const JELLY_FILM : vec3f = vec3f(0.030, 0.006, 0.034);
/// The FLOOR pool colour: pinker than the wall film (red leads blue), after
/// the reference's bright magenta ground pools under the caps.
const JELLY_FILM_FLOOR : vec3f = vec3f(0.052, 0.010, 0.044);

/// Mikkelsen surface-gradient bump, the same formulation pass/terrain.wgsl
/// documents (scale 1.0 = relief in real metres; see perturbNormal there for
/// why any other scale is a lie about the surface).
fn caveBump(N: vec3f, P: vec3f, relief: f32) -> vec3f {
  let dpx = dpdx(P);
  let dpy = dpdy(P);
  let r1 = cross(dpy, N);
  let r2 = cross(N, dpx);
  let det = dot(dpx, r1);
  let surfGrad = sign(det) * (dpdx(relief) * r1 + dpdy(relief) * r2);
  return normalize(abs(det) * N - surfGrad);
}

struct FragOut {
  @location(0) color    : vec4f,
  @location(1) velocity : vec2f,
  @location(2) gate     : f32,
};

@fragment
fn fs_cave(in: VSOut) -> FragOut {
  let P = in.worldPos;
  let absPos = toAbsolute(P);
  let depth = seaLevel() - absPos.y;

  let toEye = frame.cameraPos.xyz - P;
  let viewDist = length(toEye);
  let V = toEye / max(viewDist, 1e-4);
  let geoN = normalize(in.normal);
  let foot = pixelFootprint(P);

  // ---- substrate ---------------------------------------------------------
  let mid = fbmCheap3(absPos * CAVE_ROCK_MID, SEED_CAVE_ROCK) * bandGain(FEAT_MID, foot);
  var fine = 0.0;
  let fineGain = bandGain(FEAT_FINE, foot);
  if (fineGain > 0.004) {
    fine = fbmCheap3(absPos * CAVE_ROCK_FINE, SEED_CAVE_ROCK + 13u) * fineGain;
  }
  let height = saturate(0.5 + mid * 0.55 + fine * 0.35);
  let relief = mid * RELIEF_MID + fine * RELIEF_FINE;

  let mouthW = in.aux.x;
  var albedo = mix(CAVE_ALBEDO, MOUTH_ALBEDO, mouthW) * (0.72 + 0.56 * height);
  var roughness = clamp(0.78 - 0.10 * height, 0.42, 1.0);

  var N = caveBump(geoN, P, relief);
  if (dot(N, geoN) < 0.05) { N = geoN; }

  // Cavity off the same height channel that made the bumps, one-sided below
  // its mean for the reason the terrain's CAVITY_STRENGTH comment gives.
  let ao = saturate(1.0 - 0.45 * saturate(1.0 - height * 2.0));

  // ---- grotto film -------------------------------------------------------
  // Colony mask: worley patches warped by the mid band, so the film pools in
  // hollows of its own and not along lattice lines.
  let grottoW = in.aux.z;
  var emissive = vec3f(0.0);
  if (grottoW > 0.002) {
    let uv = absPos.xz * 0.34 + vec2f(absPos.y * 0.21, mid * 0.8);
    let cells = worley2(uv, SEED_CAVE_ROCK + 29u, 0.95);
    let colony = smoothstep(0.42, 0.06, cells.x);
    emissive = GROTTO_RADIANCE * grottoW * colony * (0.6 + 0.4 * height);
    // The film itself is slightly cyan-reflective even unlit.
    albedo += vec3f(0.0, 0.014, 0.011) * grottoW * colony;
  }

  // ---- authored-site treatment (Jellyshroom Hollow) ----------------------
  let jellyW = in.aux.w;
  if (jellyW > 0.002) {
    albedo = mix(albedo, albedo * JELLY_WALL_TINT, jellyW);
    let uvj = absPos.xz * 0.30 + vec2f(absPos.y * 0.17, mid * 0.7);
    let cellsj = worley2(uvj, SEED_CAVE_ROCK + 41u, 0.95);
    let colonyj = smoothstep(0.38, 0.08, cellsj.x);
    // Pooling by ORIENTATION: floors carry bright pink pools (as if the cap
    // light collected there), ceilings go near-dark so the roof reads as
    // silhouetted void, which is what makes the chamber read TALL. The
    // review round measured the isotropic film flattening the cavern to its
    // nearest wall - equally bright blotches at every range and facing.
    let poolW = 0.30 + 0.70 * saturate(geoN.y * 0.9 + 0.45);
    let filmC = mix(JELLY_FILM, JELLY_FILM_FLOOR, saturate(geoN.y));
    emissive += filmC * jellyW * colonyj * poolW * (0.5 + 0.5 * height);
    // The film reflects a little of its own violet even unlit.
    albedo += vec3f(0.016, 0.004, 0.022) * jellyW * colonyj * poolW;
  }

  // ---- lighting, sky gated per vertex -------------------------------------
  let sky = in.aux.y;
  let s = makeSurface(P, N, geoN, V, albedo, roughness, 0.0, ao, vec3f(0.0), 0.0);
  let viewDepth = max(dot(-toEye, frame.cameraFwd.xyz), nearPlane());

  let amb = evalAmbient(s);
  let celestial = evalSun(s, viewDepth, 0.0) + evalMoon(s, 0.0);
  let lamps = evalPunctualLights(s, in.pos.xy, viewDepth, 0.0);
  var radiance = (amb + celestial) * sky + lamps + emissive;

  // ---- caustic ambient wiggle, only where the sky still reaches ----------
  if (depth > 0.0 && sky > 0.01) {
    let cf = causticFactor(P, N, depth);
    radiance += evalAmbientSH(N) * daylightAtDepth(depth) * surfaceDiffuse(s)
              * ((cf - vec3f(1.0)) * 0.12) * sky;
  }

  // ---- participating medium, LAST, exactly as every geometry pass --------
  radiance = applyViewRayWater(radiance, viewDist, depth, -V);
  let screenUV = in.pos.xy * frame.screen.zw;
  radiance = applyViewRayFroxel(radiance, screenUV, viewDepth);

  let aoAmb = aoAmbientThroughMedium(amb * sky, viewDist, depth, -V,
                                     screenUV, viewDepth);

  let cur = in.curClip.xy / max(in.curClip.w, 1e-6);
  let prv = in.prevClip.xy / max(in.prevClip.w, 1e-6);

  var out : FragOut;
  out.color = vec4f(radiance, 1.0);
  out.velocity = (cur - prv) * vec2f(0.5, -0.5);
  out.gate = aoGate(aoAmb, radiance);
  return out;
}

// ---------------------------------------------------------------------------
// GEODE SPAR - the calcite blade clusters world/cave_mesh.js bakes into the
// Geode band [-1050, -560]. Drawn instanced over the shared crystalSpar mesh
// library (render/passes/caves.js), one draw range per variant.
//
// LIT BY LAMPS AND BY A FAINT MINERAL FILM, AND BY NOTHING ELSE - and that is
// arithmetic, not restraint for its own sake. A spar site requires >= 12 m of
// rock overhead (SPAR_MIN_ROCK) and sits below -560 m, which is under
// TRUE_DARK_DEPTH: the baked skylight gate that fs_cave carries would be 0.0
// at every instance, so evalSun/evalMoon/evalAmbient/deep key are not even
// evaluated. What remains is exactly what a sealed chamber contains: the
// player's own light (evalPunctualLights - calcite answers a lamp with a pale
// specular flash, which is the whole reward of pointing one at it) and the
// film. The film is a surface radiance like GROTTO_RADIANCE, an eighth of its
// magnitude, and drives no cluster list - the fill-light class question does
// not even arise, because nothing here submits a light.
// ---------------------------------------------------------------------------

/// Chemosynthetic film on the calcite, linear radiance. Originally sized well
/// under GROTTO_RADIANCE (0.010, 0.052, 0.041) so the spar would read as
/// MINERAL - something a lamp discovers - not as a light fixture; see the
/// 2026-08-18 note below for where it sits now and why.
/// 2026-08-18 drastic pass: x7.5 on every channel (was 0.0016, 0.0060,
/// 0.0052). "A lamp discovers minerals" authored a chamber that photographed
/// as black with one pale spike; the demo needs the geode to read as a jewel
/// box the moment the reveal cuts. At x7.5 the film's Rec709 luma is 0.89x
/// GROTTO_RADIANCE - no longer "well under" it, deliberately: the original
/// mineral-not-fixture restraint is softened by the demo-first priority. A
/// x12.5 arm (0.020, 0.075, 0.065, luma 1.47x GROTTO) was tried and crushed
/// auto-exposure to one glowing wall; this constant is the bisect back.
const SPAR_FILM : vec3f = vec3f(0.0120, 0.0450, 0.0390);
/// Calcite reflectance scale on the mesh's authored vertex colour. Pale by
/// design: against CAVE_ALBEDO's 0.03 wet basalt, a 0.30-ish blade is a 10x
/// step a lamp cone picks out immediately.
const SPAR_ALBEDO_GAIN : f32 = 0.92;
const SPAR_ROUGHNESS : f32 = 0.26;
/// Metres the blade root is sunk along -normal (scaled by the instance), so
/// the cluster base is buried in the wall the marched surface wobbles through.
const SPAR_SINK : f32 = 0.16;

struct SparVSOut {
  @builtin(position) pos : vec4f,
  @location(0) worldPos  : vec3f,   // camera-relative
  @location(1) normal    : vec3f,
  @location(2) color     : vec4f,
  @location(3) curClip   : vec4f,
  @location(4) prevClip  : vec4f,
};

@vertex
fn vs_spar(
  @location(0) localPos : vec3f,
  @location(1) normal   : vec3f,
  @location(2) color    : vec4f,
  @location(3) ipos     : vec3f,
  @location(4) iscale   : f32,
  @location(5) inrm     : vec3f,
  @location(6) iyaw     : f32,
) -> SparVSOut {
  // Instance basis: +Y along the wall normal (a blade grows off its wall),
  // yaw spinning the cluster about it. Orthonormal by construction, uniform
  // scale, so the same basis transports the normal. RIGHT-HANDED on purpose:
  // local x maps to t0, y to up, z to b0, and the local frame satisfies
  // x cross y = z, so the basis must satisfy t0 cross up = b0 - which is
  // b0 = cross(t0, up). The first cut used cross(up, t0), a determinant -1
  // MIRROR: it flips every triangle's winding, back-face culling then keeps
  // only the inward faces, and every blade rendered as its own black
  // interior. Measured on the first chamber shot - all spar silhouettes
  // solid dark against a lamp-lit wall.
  let up = normalize(inrm);
  let refv = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(up.y) > 0.9);
  let t0 = normalize(cross(refv, up));
  let b0 = cross(t0, up);
  let cy = cos(iyaw);
  let sy = sin(iyaw);
  let t = t0 * cy + b0 * sy;
  let b = b0 * cy - t0 * sy;
  let lp = localPos * iscale;
  let p = chunk.origin.xyz + ipos
        + t * lp.x + up * (lp.y - SPAR_SINK * iscale) + b * lp.z;

  var out : SparVSOut;
  out.worldPos = p;
  out.normal = t * normal.x + up * normal.y + b * normal.z;
  out.color = color;
  out.pos = frame.viewProj * vec4f(p, 1.0);
  // Static geometry, like the cave walls: both matrices UNJITTERED.
  out.curClip = frame.viewProjUnjittered * vec4f(p, 1.0);
  out.prevClip = frame.prevViewProj * vec4f(p, 1.0);
  return out;
}

// ---------------------------------------------------------------------------
// AUTHORED-SITE PROPS - the Jellyshroom Hollow's shrooms and speleothems
// (world/cave_mesh.js CAVE PROP block), instanced over the prop library in
// render/passes/caves.js through the SAME vertex path as the spar (vs_spar).
//
// The colour ALPHA is an emissive gate the library packer folded in from the
// per-vertex mesh material (EMISSIVE 1.0, TRANSLUCENT 0.55, CRYSTAL 0.35,
// else 0), so one fragment path serves a glowing cap, a faintly luminous
// crystal body and a dark stalk. Emission is the vertex colour itself - the
// authored gradient IS the look - times PROP_EMIT.
//
// Unlike the spar, a prop's emission is real scene radiance that the caps'
// own punctual lights (submitJellyLights) then echo onto the rock: surface
// and illumination are the same authored colour by construction.
// ---------------------------------------------------------------------------

/// Peak emitted radiance at gate 1.0. Sized against the chamber it lives in:
/// the walls' JELLY_FILM peaks at ~0.03 and the cap must read as the SOURCE,
/// an order of magnitude above its floor - while staying inside what the
/// chamber's 25.6x auto-exposure can hold. 1.4 shipped first and clipped the
/// whole cap to white through the AgX shoulder (the brighter-is-whiter trap,
/// measured in the first delivered frames: cap saturation gone, gradient
/// gone); 0.4 still bloomed the core achromatic on the second round. 0.28,
/// with the pale-core zone bounded in the mesh gradient itself (pow 2.6),
/// keeps every part of the cap on the saturated side of the shoulder.
const PROP_EMIT : f32 = 0.28;
/// Reflectance scale on the authored vertex colour for the lamp response.
/// Raised 0.30 -> 0.55 in the same rebalance: the pink now lives partly in
/// REFLECTANCE (the caps answer each other's light), which is the correct
/// side of the shoulder to carry saturation.
const PROP_ALBEDO_GAIN : f32 = 0.55;
const PROP_ROUGHNESS : f32 = 0.55;

@fragment
fn fs_prop(in: SparVSOut) -> FragOut {
  let P = in.worldPos;
  let absPos = toAbsolute(P);
  let depth = seaLevel() - absPos.y;

  let toEye = frame.cameraPos.xyz - P;
  let viewDist = length(toEye);
  let V = toEye / max(viewDist, 1e-4);
  let N = normalize(in.normal);

  let albedo = in.color.rgb * PROP_ALBEDO_GAIN;
  let s = makeSurface(P, N, N, V, albedo, PROP_ROUGHNESS, 0.0, 1.0, vec3f(0.0), 0.0);
  let viewDepth = max(dot(-toEye, frame.cameraFwd.xyz), nearPlane());

  // Lamps + own emission; no sky for the same reason as the spar - every
  // instance sits under the authored site's roof, where the baked skylight
  // gate would be zero anyway.
  let lamps = evalPunctualLights(s, in.pos.xy, viewDepth, 0.0);
  var radiance = lamps + in.color.rgb * (in.color.a * PROP_EMIT);

  // Participating medium, LAST, exactly as every geometry pass.
  radiance = applyViewRayWater(radiance, viewDist, depth, -V);
  let screenUV = in.pos.xy * frame.screen.zw;
  radiance = applyViewRayFroxel(radiance, screenUV, viewDepth);

  let cur = in.curClip.xy / max(in.curClip.w, 1e-6);
  let prv = in.prevClip.xy / max(in.prevClip.w, 1e-6);

  var out : FragOut;
  out.color = vec4f(radiance, 1.0);
  out.velocity = (cur - prv) * vec2f(0.5, -0.5);
  // Emitters and lamp-lit crystal deliver no ambient share for SSAO to gate.
  out.gate = 0.0;
  return out;
}

@fragment
fn fs_spar(in: SparVSOut) -> FragOut {
  let P = in.worldPos;
  let absPos = toAbsolute(P);
  let depth = seaLevel() - absPos.y;

  let toEye = frame.cameraPos.xyz - P;
  let viewDist = length(toEye);
  let V = toEye / max(viewDist, 1e-4);
  // Facet-flat normals from the mesh (crystals are built with independent
  // per-facet quads precisely so this stays a crystal); no bump on top.
  let N = normalize(in.normal);

  let albedo = in.color.rgb * SPAR_ALBEDO_GAIN;
  let s = makeSurface(P, N, N, V, albedo, SPAR_ROUGHNESS, 0.0, 1.0, vec3f(0.0), 0.0);
  let viewDepth = max(dot(-toEye, frame.cameraFwd.xyz), nearPlane());

  // Lamps + film only; see the block comment for why there is no sky here.
  let lamps = evalPunctualLights(s, in.pos.xy, viewDepth, 0.0);
  var radiance = lamps + SPAR_FILM * in.color.a;

  // Participating medium, LAST, exactly as every geometry pass.
  radiance = applyViewRayWater(radiance, viewDist, depth, -V);
  let screenUV = in.pos.xy * frame.screen.zw;
  radiance = applyViewRayFroxel(radiance, screenUV, viewDepth);

  let cur = in.curClip.xy / max(in.curClip.w, 1e-6);
  let prv = in.prevClip.xy / max(in.prevClip.w, 1e-6);

  var out : FragOut;
  out.color = vec4f(radiance, 1.0);
  out.velocity = (cur - prv) * vec2f(0.5, -0.5);
  // No delivered ambient -> gate 0: SSAO has no ambient share to modulate on
  // a surface lit by lamps and its own film.
  out.gate = 0.0;
  return out;
}
