// SUBWAVE - creatures.
//
// Every animal in the ocean, drawn as ONE INSTANCED SKINNED DRAW PER SPECIES,
// with the whole animation evaluated on the GPU. Nothing here is keyframed and
// nothing is authored: the pose is a closed-form function of (speed, phase,
// turn rate, behaviour timer), so a 260-strong population costs one compute
// dispatch and thirty-odd draws.
//
// THREE STRUCTURAL DECISIONS.
//
// 1. THE BONE PALETTE IS BUILT ANALYTICALLY, NOT BY WALKING A CHAIN. A skeleton
//    solver normally has to march from the root to the tip because each bone's
//    world transform depends on its parent's. The swimming curve of
//    DESIGN/06.3.2 is a closed form in the bone's own normalised arclength u,
//    so bone i's transform can be evaluated WITHOUT bone i-1 - which turns a
//    serial 24-step walk per skeleton into one thread per bone with no
//    dependency at all. cs_creature_skeleton therefore dispatches
//    instances * MAX_BONES threads, 6,240 at the population cap, and finishes
//    in a single wave per workgroup.
//
// 2. THE PALETTE IS DOUBLE-BUFFERED WITHIN ONE BUFFER, current poses in the
//    first half and PREVIOUS-FRAME poses in the second. Motion vectors from the
//    rigid transform alone are wrong for a swimming animal: a tail tip travels
//    two body-widths in a frame at burst speed while the body centre barely
//    moves, and TAA reprojecting the rigid delta smears the tail into a grey
//    comb. Solving the previous pose costs one extra store per thread.
//
// 3. FIN AND WING MOTION IS PER-VERTEX, NOT PER-BONE. A pectoral fin's flutter,
//    a ray's spanwise undulation and a flyer's wingbeat are all the SAME
//    travelling wave along the span coordinate |x|, and binding them to bones
//    would need a bone per fin ray. One formula in the vertex stage covers all
//    three, and it costs a sine.
//
// MODEL SPACE IS BINDING: the snout is at -Z, the tail at +Z, +Y up. Same
// convention as pass/entity.wgsl. entities/creature_mesh.js builds to it and
// entities/creatures.js orients to it with quat.lookRotation.

#include "../common/frame.wgsl"
#include "../common/math.wgsl"
#include "../common/noise.wgsl"
#include "../common/brdf.wgsl"
#include "../common/shadow.wgsl"
#include "../common/water.wgsl"
#include "../common/lighting.wgsl"
#include "../common/triplanar.wgsl"

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/// Palette stride, from RENDER.MAX_BONES_PER_CREATURE.
///
/// MAX_BONES is a preprocessor define the renderer injects into every shader
/// (see renderer.js's define table), so it arrives as a bare literal and cannot
/// be redeclared here. Wrapping it once gives it a type and one place to read.
const CREATURE_BONES : u32 = u32(MAX_BONES);

/// ANIM_MODE, from entities/creatures.js. These values are BINDING.
const AM_ANGUILLIFORM   : u32 = 0u;
const AM_SUBCARANGIFORM : u32 = 1u;
const AM_CARANGIFORM    : u32 = 2u;
const AM_THUNNIFORM     : u32 = 3u;
const AM_OSTRACIIFORM   : u32 = 4u;
const AM_RAJIFORM       : u32 = 5u;
const AM_JET            : u32 = 6u;
const AM_WING           : u32 = 7u;
const AM_LEG            : u32 = 8u;

/// MESH_MATERIAL slots, matching world/meshgen.js and creature_mesh.js.
const MM_ROCK        : u32 = 0u;
const MM_FLORA       : u32 = 1u;   // skin, mantle, muscle
const MM_TRANSLUCENT : u32 = 2u;   // fins, bells, membranes, baleen
const MM_EMISSIVE    : u32 = 3u;   // photophores, lures
const MM_CRYSTAL     : u32 = 4u;   // eyes
const MM_BONE        : u32 = 5u;   // carapace, teeth, keratin
const MM_SEDIMENT    : u32 = 6u;
const MM_METAL       : u32 = 7u;   // the Nethercoil's plating

/// BONE_ROLE, from entities/creature_mesh.js.
const ROLE_SPINE    : u32 = 0u;
const ROLE_JAW      : u32 = 1u;
const ROLE_LURE     : u32 = 2u;
const ROLE_MANDIBLE : u32 = 3u;

/// A 3x4 bone transform, stored ROW-major as three vec4f.
///
/// WGSL's mat3x4f is three COLUMNS of four rows, which is the transpose of what
/// a transform wants and a fertile source of silent, subtle skinning bugs.
/// Three explicit rows cost the same 48 bytes and cannot be misread.
struct Bone {
  r0 : vec4f,
  r1 : vec4f,
  r2 : vec4f,
};

/// Rest pose of one bone, from creature_mesh.buildCreatureBones().
struct RestBone {
  /// xyz = model-space rest position, w = normalised arclength u in [0,1]
  posU   : vec4f,
  /// x = parent index (-1 for the root), y = BONE_ROLE, z = rest length,
  /// w = the horn's RADIAL ANGLE about the body axis, for ROLE_MANDIBLE only.
  ///     Zero for every other role and unread there.
  info   : vec4f,
};

/// Per-instance animation state, written by render/passes/creatures.js.
struct Inst {
  /// xyz = CAMERA-RELATIVE position, w = uniform scale
  posScale    : vec4f,
  /// orientation quaternion, xyzw. Heading only: the bank travels separately so
  /// the shader can distribute it along the spine.
  orient      : vec4f,
  /// x = swim phase (radians), y = speed (m/s), z = bendTurn (rad),
  /// w = bank (rad)
  anim        : vec4f,
  /// x = jawOpen 0..1, y = startle 0..1 (C-start progress), z = pursuit angle
  /// to target (rad, signed), w = inflate 0..1
  anim2       : vec4f,
  /// rgb = tint multiplier on the mesh's vertex colour, w = emissive gain
  tint        : vec4f,
  /// x = bone base index, y = species index, z = flags, w = bone count
  ids         : vec4u,
  /// xyz = previous frame's camera-relative position, w = previous phase
  prevPos     : vec4f,
  prevOrient  : vec4f,
  /// x = previous speed, y = previous bendTurn, z = previous bank,
  /// w = previous jawOpen
  prevAnim    : vec4f,
  /// x = hurt, 1 - hp/hpMax. A wounded animal shows it, which matters because
  /// DESIGN/06.7.1 makes anything wounded preference-1.6 prey: the player has to
  /// be able to SEE what the Chiselfin pack is about to pick off.
  /// y, z, w reserved.
  misc        : vec4f,
};

/// Per-species animation parameters. Built from ARCHETYPES and SPECIES_TABLE in
/// entities/creatures.js; see the citation block above evalSpine().
struct SpeciesAnim {
  /// x = f0, y = kf, z = fMin, w = fMax   (tail-beat frequency, Hz)
  wave    : vec4f,
  /// x = A0, y = A1, z = U0, w = U1       (amplitude in body lengths)
  amp     : vec4f,
  /// x = c0, y = c1, z = c2, w = uMin     (amplitude envelope)
  env     : vec4f,
  /// x = lambdaB, y = bendMax, z = rollMax, w = body length (metres)
  shape   : vec4f,
  /// x = mFin, y = af0, z = af1, w = lambdaFin (spanwise fin wavelength)
  fin     : vec4f,
  /// rgb = bioluminescent radiance, w = pulse rate in Hz (0 = steady)
  biolum  : vec4f,
  /// x = mode, y = spine bone count, z = jaw bone (-1 as 0xffffffff),
  /// w = lure bone
  info    : vec4u,
  /// x = jawMax (rad), y = inflate scale (m), z = optical thickness (m),
  /// w = Ap, the dorsoventral amplitude as a fraction of A
  extra   : vec4f,
  /// ALBEDO PATTERN. x = kind (AP_*), y = element count, z = duty (the share of
  /// one repeat that is pigment), w = strength (peak mix toward patternCol).
  pattern : vec4f,
  /// rgb = pattern albedo, LINEAR. w = roughness inside the mask, so a
  /// Coppersprat's mirror stripe can be glossier than the skin around it.
  patternCol : vec4f,
  /// EMISSION, baked off the real mesh by bakeSpeciesEmit() in the pass.
  /// x = the emissive organ's radius of gyration in the REST POSE (m),
  /// y = its effective emissive area (m2), z = per-species skin roughness
  /// bias (meshRecipe.skinRoughnessBias; the Splitmaw's matte hide - see the
  /// writer in passes/creatures.js), w = MANDIBLE FOLD in radians
  /// (meshRecipe.mandibles.fold), the angle a ROLE_MANDIBLE bone folds its horn
  /// inward at jawOpen = 0. Zero reproduces the mesh as authored.
  emit : vec4f,
};

@group(1) @binding(0) var<storage, read> insts   : array<Inst>;
@group(1) @binding(1) var<storage, read> species : array<SpeciesAnim>;
@group(1) @binding(2) var<storage, read> bones   : array<Bone>;

// ---------------------------------------------------------------------------
// Quaternions
// ---------------------------------------------------------------------------

fn qRotate(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

// ---------------------------------------------------------------------------
// THE TRAVELLING-WAVE SWIMMING FORMULA
// ---------------------------------------------------------------------------
//
// BINDING, from DESIGN/06 06.3.2. For spine bone i at normalised arclength
// u = s/L in [0,1] (0 = snout, 1 = tail tip):
//
//   U        = speed / L                                  body lengths / second
//   f        = clamp(f0 + kf*U, fMin, fMax)                tail-beat rate, Hz
//   A        = A0 + (A1 - A0) * clamp((U-U0)/(U1-U0),0,1)  peak tail amplitude,
//                                                          in body lengths
//   env(u)   = c0 + c1*u + c2*u^2         amplitude envelope, env(1) = 1
//   theta(u) = phase - 2*PI*u/lambdaB     phase = 2*PI*f*t, accumulated on the
//                                         CPU so a changing f cannot jump
//   lat(u)   = A * env(u) * sin(theta)    lateral displacement, body lengths
//
//   dlat_du  = A * ( (c1 + 2*c2*u)*sin(theta)
//                    - (2*PI/lambdaB)*env(u)*cos(theta) )
//   yawSwim  = atan(dlat_du)
//
// WHY yawSwim IS atan(dlat_du) AND NOT THE DOC'S atan(dlat_du * L/N_spine).
// The doc's factor converts the curve's absolute tangent into the RELATIVE
// rotation of one segment with respect to its parent, which is what a chained
// solver needs. This solver is analytic - every bone's transform is built in
// model space independently - so what it needs is the ABSOLUTE tangent of the
// body curve, and that is atan(d(lat*L)/d(u*L)) = atan(dlat_du). Applying the
// doc's factor here would divide the body's curvature by the bone count and the
// animal would swim like a rigid plank.
//
// Per-archetype parameters are cited in the ARCHETYPES table in
// entities/creatures.js, which transcribes DESIGN/06 06.3.5 in full. The three
// numbers that matter most for readability, for reference:
//
//   ARCH_SHOALER     f0 1.10  kf 1.15  A0 0.06  A1 0.11  lambdaB 0.85  7 bones
//   ARCH_AMBUSHER    f0 0.50  kf 1.60  A0 0.04  A1 0.19  lambdaB 0.78  9 bones
//   ARCH_LEVIATHAN   f0 0.16  kf 0.55  A0 0.03  A1 0.09  lambdaB 1.25 16 bones
//
// A Silverquill at its 1.6 m/s cruise is U = 5.5, so f = 7.4 Hz and A = 0.10
// body lengths: a 29 mm tail sweep at seven beats a second, which is what a
// small carangiform fish actually does. A Hollowjaw at 4 m/s is U = 0.13, so
// f = 0.23 Hz and A = 0.03: one enormous beat every four seconds.

/// Swim-wave state for one bone. `lat` is in METRES, `yaw` in radians.
struct SpineWave {
  lat  : f32,
  dors : f32,
  yaw  : f32,
  pitch: f32,
};

fn evalSpine(sa: SpeciesAnim, u: f32, phase: f32, speed: f32,
             startle01: f32) -> SpineWave {
  var w : SpineWave;
  let L = max(sa.shape.w, 1e-4);
  let U = speed / L;

  // Amplitude ramps between the two quoted speeds and then holds: a fish does
  // not keep widening its tail sweep once it is at burst speed, it beats faster.
  let tAmp = saturate((U - sa.amp.z) / max(sa.amp.w - sa.amp.z, 1e-4));
  var A = sa.amp.x + (sa.amp.y - sa.amp.x) * tAmp;

  // The active spine fraction. env.w is uMin: OSTRACIIFORM only moves its
  // caudal fin (u > 0.92), an eel moves everything past its own head (u > 0.05).
  let uActive = saturate((u - sa.env.w) / max(1.0 - sa.env.w, 1e-4));

  let c0 = sa.env.x;
  let c1 = sa.env.y;
  let c2 = sa.env.z;
  let env = c0 + c1 * uActive + c2 * uActive * uActive;

  let lambdaB = max(sa.shape.x, 1e-3);
  let k = TAU / lambdaB;
  let theta = phase - k * uActive;
  let s = sin(theta);
  let c = cos(theta);

  var lat = A * env * s;
  // C-START. DESIGN/06.3.3: a single half-cycle at four times the amplitude,
  // no translation, and it is the visual tell that a shoal has been spooked.
  // The sign follows the bone's own phase so a school does not all bend the
  // same way.
  if (startle01 > 0.0) {
    lat += 4.0 * A * env * sin(PI * saturate(startle01)) * sign(s + 1e-6);
  }

  let dlat = A * ((c1 + 2.0 * c2 * uActive) * s - k * env * c);

  w.lat = lat * L;
  w.yaw = atan(dlat);

  // DORSOVENTRAL component. Ap is 0 for most fish, 0.6 for the cetacean-tailed
  // Pale Herald and 0.25 for rays; the up-down wave runs a quarter cycle behind
  // the lateral one so the tail traces a figure of eight rather than a line.
  let Ap = sa.extra.w;
  if (Ap > 0.0) {
    let sp = sin(theta - HALF_PI);
    w.dors = A * Ap * env * sp * L;
    w.pitch = atan(A * Ap * ((c1 + 2.0 * c2 * uActive) * sp
      - k * env * cos(theta - HALF_PI)));
  } else {
    w.dors = 0.0;
    w.pitch = 0.0;
  }
  return w;
}

/// Mantle / bell contraction for AM_JET.
///
/// DESIGN/06.3.2: a 0.18 s ease-in contraction followed by a 0.62 s ease-out
/// refill, i.e. a duty cycle of 0.225. Returned as a uniform SCALE so a jelly
/// bell narrows and a squid mantle shortens with one number.
fn jetPulse(phase: f32, amplitude: f32) -> f32 {
  let t = fract(phase / TAU);
  let contract = 0.18 / 0.80;
  var p : f32;
  if (t < contract) {
    p = smoothstep(0.0, 1.0, t / contract);            // squeeze
  } else {
    p = 1.0 - smoothstep(0.0, 1.0, (t - contract) / (1.0 - contract));  // refill
  }
  return 1.0 - amplitude * p;
}

// ---------------------------------------------------------------------------
// Skeleton solve (compute)
// ---------------------------------------------------------------------------

@group(2) @binding(0) var<storage, read> restBones : array<RestBone>;
@group(2) @binding(1) var<storage, read_write> boneOut : array<Bone>;

/// Number of bone slots in the current-pose half of `boneOut`. The second half
/// holds the previous pose; see the header.
struct SkinParams {
  /// x = instance count, y = palette stride (MAX_INSTANCES * CREATURE_BONES),
  /// z, w = unused
  counts : vec4u,
};
@group(2) @binding(2) var<uniform> skin : SkinParams;

/// Build a row-major 3x4 from a rotation's three rows and a translation.
fn makeBone(rx: vec3f, ry: vec3f, rz: vec3f, t: vec3f) -> Bone {
  var b : Bone;
  b.r0 = vec4f(rx, t.x);
  b.r1 = vec4f(ry, t.y);
  b.r2 = vec4f(rz, t.z);
  return b;
}

/// Three ROWS of a rotation matrix.
///
/// Not a mat3x3f: WGSL's matrix constructor takes COLUMNS and its subscript
/// returns a column, so a rotation written as rows and then indexed as columns
/// is silently transposed - which for a rotation is its inverse, and shows up as
/// a creature whose tail bends the wrong way only when it is also banking.
struct Rows {
  x : vec3f,
  y : vec3f,
  z : vec3f,
};

/// Rotation from intrinsic yaw (about +Y), pitch (about +X) and roll (about
/// +Z), composed as R = Ry(yaw) * Rx(pitch) * Rz(roll) - the ZYX order
/// DESIGN/06.3.3 specifies - and returned as rows.
fn eulerRows(yaw: f32, pitch: f32, roll: f32) -> Rows {
  let cy = cos(yaw);   let sy = sin(yaw);
  let cp = cos(pitch); let sp = sin(pitch);
  let cr = cos(roll);  let sr = sin(roll);
  var r : Rows;
  r.x = vec3f(cy * cr + sy * sp * sr,  -cy * sr + sy * sp * cr,  sy * cp);
  r.y = vec3f(cp * sr,                  cp * cr,                -sp);
  r.z = vec3f(-sy * cr + cy * sp * sr,  sy * sr + cy * sp * cr,  cy * cp);
  return r;
}

/// Rotation about an arbitrary UNIT axis by `angle`, Rodrigues, returned as
/// rows. eulerRows is ZYX about the body's own axes and cannot express this:
/// a mandible horn folds about an axis that depends on WHERE AROUND the skull
/// it sits, so each of the four rotates in a different plane.
fn axisAngleRows(axis: vec3f, angle: f32) -> Rows {
  let c = cos(angle);
  let s = sin(angle);
  let t = 1.0 - c;
  let a = axis;
  var r : Rows;
  r.x = vec3f(t * a.x * a.x + c,        t * a.x * a.y - s * a.z,  t * a.x * a.z + s * a.y);
  r.y = vec3f(t * a.x * a.y + s * a.z,  t * a.y * a.y + c,        t * a.y * a.z - s * a.x);
  r.z = vec3f(t * a.x * a.z - s * a.y,  t * a.y * a.z + s * a.x,  t * a.z * a.z + c);
  return r;
}

/// Solve one bone into a palette slot.
fn solveBone(sa: SpeciesAnim, rb: RestBone, phase: f32, speed: f32,
             bendTurn: f32, bank: f32, jawOpen: f32, startle01: f32,
             pursuit: f32, scale: f32) -> Bone {
  let u = rb.posU.w;
  let role = u32(rb.info.y + 0.5);
  let rest = rb.posU.xyz;
  let mode = sa.info.x;

  var pos = rest;
  var yaw = 0.0;
  var pitch = 0.0;
  var roll = 0.0;
  var boneScale = 1.0;

  if (role == ROLE_MANDIBLE) {
    // ONE HORN, FOLDING SHUT OVER THE MAW.
    //
    // The horn sits at radial angle `th` about the body axis, so its radial
    // direction is (cos th, sin th, 0) and it extends forward along -Z. Folding
    // it INWARD is a rotation that tips that forward axis toward the radial's
    // NEGATIVE, and the axis of that rotation is TANGENTIAL to the radial:
    // normalize(cross(-Z, radial)) = (sin th, -cos th, 0), already unit.
    //
    // That per-horn axis is the whole point. Binding four radial horns to the
    // single-hinge jaw bone pitches them all downward together - a scoop, not a
    // flare - which is the defect recorded at addMandibles() in
    // creature_mesh.js for as long as they were rigid to the skull.
    //
    // The sign is a FOLD and never an unfold: at jawOpen = 1 the angle is 0 and
    // the mesh renders exactly as authored, so the reviewed splayed-X
    // silhouette is untouched at full gape and only the closed pose is new.
    let th = rb.info.w;
    let axis = vec3f(sin(th), -cos(th), 0.0);
    let Rm = axisAngleRows(axis, -(1.0 - jawOpen) * sa.emit.w);
    // Pivot at the horn's own root, which IS this bone's rest position - the
    // same point creature_mesh's mandibleRoot() hands to the extruder.
    let kx = Rm.x * scale;
    let ky = Rm.y * scale;
    let kz = Rm.z * scale;
    return makeBone(kx, ky, kz,
      rest * scale - vec3f(dot(kx, rest), dot(ky, rest), dot(kz, rest)));
  }

  if (role == ROLE_JAW) {
    // The mandible rotates about its hinge and nothing else. Opening downward
    // is a NEGATIVE pitch in this frame (+X pitch tips the nose up).
    pitch = -jawOpen * sa.extra.x;
  } else if (role == ROLE_LURE) {
    // The esca trails on a damped spring: k = 40/s^2, c = 7/s (DESIGN/06.3.2),
    // whose damped natural frequency is sqrt(40 - 12.25) = 5.27 rad/s. Driving
    // it off the swim phase at that ratio gives the same bob for free.
    let bob = sin(phase * 0.84) * 0.22 + sin(phase * 1.63 + 1.1) * 0.08;
    yaw = bob;
    pitch = bob * 0.6;
  } else {
    let w = evalSpine(sa, u, phase, speed, startle01);

    // BODY BEND INTO A TURN. DESIGN/06.3.3 distributes it as pow(u, 1.5) toward
    // the tail. The bone must also MOVE, not merely rotate: integrating the
    // yaw along the arclength gives the lateral offset that goes with it,
    // integral of u^1.5 du = u^2.5 / 2.5, and without it the head swings while
    // the body stays straight.
    let wBend = pow(u, 1.5);
    let bendYaw = bendTurn * wBend;
    let bendLat = bendTurn * sa.shape.w * pow(u, 2.5) / 2.5;

    // PURSUIT LEAD. The single most important readability cue a predator has:
    // during an approach or a lunge the head visibly aims at the target, over
    // the front 30% of the spine only.
    var lead = 0.0;
    if (u < 0.3) { lead = 0.35 * pursuit * (1.0 - u / 0.3); }

    yaw = w.yaw + bendYaw + lead;
    pitch = w.pitch;
    // BANKING. Mostly at the shoulders: wRoll(u) = 1 - 0.6u.
    roll = bank * (1.0 - 0.6 * u);

    // Lateral and dorsoventral displacement, in the animal's own frame.
    pos.x += w.lat + bendLat;
    pos.y += w.dors;

    if (mode == AM_JET) {
      // A jet swimmer's spine does not wave; its mantle contracts. The scale is
      // strongest amidships and tapers to 1 at both ends so the tentacle crown
      // and the apex stay put.
      let amp = sa.amp.x + (sa.amp.y - sa.amp.x) * 0.5;
      let taper = sin(PI * saturate(u));
      boneScale = mix(1.0, jetPulse(phase, amp * 2.2), taper);
      // The wave terms above are damped hard for a jet swimmer - what little
      // remains is the slow drift of a bell in a current.
      pos.x = rest.x + (w.lat + bendLat) * 0.25;
      yaw = w.yaw * 0.25 + bendYaw + lead;
    } else if (mode == AM_LEG) {
      // GAIT. entities/creature_mesh.js exposes only SPINE, JAW and LURE bone
      // roles - there are no per-leg bones, so there is no leg chain to run
      // two-bone IK on, and the honest thing to animate is the body the legs
      // carry: a walking arthropod's carapace bobs twice per step cycle and
      // rolls once, on alternating tripods.
      //
      // The CPU's phase accumulator is ALREADY the step rate for these
      // archetypes. DESIGN/06.3.5 gives fStep = clamp(speed / strideLength,
      // 0.4, 4.5) Hz for a stride of ~0.55 body lengths, and ARCH_CRUSTACEAN,
      // ARCH_LANDWALKER and ARCH_BURROWER are given f0 = 0.4-0.5, kf = 1.4-1.6,
      // fMin = 0.4, fMax = 4.5 precisely so that clamp(f0 + kf*U, fMin, fMax)
      // reproduces it - so `phase` needs no rescaling here.
      pos.y += 0.045 * sa.shape.w * (1.0 - u * 0.5) * sin(phase * 2.0);
      roll += 0.10 * sin(phase);
    }
  }

  let R = eulerRows(yaw, pitch, roll);
  let k = boneScale * scale;
  let rx = R.x * k;
  let ry = R.y * k;
  let rz = R.z * k;
  // BIND. The skinning matrix must map the REST position to the animated one,
  // so the translation is pos - R * rest. Getting this wrong collapses every
  // vertex toward the model origin, which is the classic "the mesh imploded"
  // skinning bug and is indistinguishable from a bad weight sum.
  let t = pos * scale - vec3f(dot(rx, rest), dot(ry, rest), dot(rz, rest));
  return makeBone(rx, ry, rz, t);
}

/// First rest-bone index of a species. The rest palette is packed
/// species-major at MAX_BONES stride, so this is one multiply, and keeping it as
/// a named function documents the packing in exactly one place.
fn restBoneBase(speciesIndex: u32) -> u32 { return speciesIndex * CREATURE_BONES; }

@compute @workgroup_size(64)
fn cs_creature_skeleton(@builtin(global_invocation_id) gid: vec3u) {
  let slot = gid.x;
  let instanceCount = skin.counts.x;
  let stride = skin.counts.y;
  if (slot >= instanceCount * CREATURE_BONES) { return; }

  let ii = slot / CREATURE_BONES;
  let b = slot % CREATURE_BONES;
  let inst = insts[ii];
  let sa = species[inst.ids.y];

  if (b >= inst.ids.w) {
    // Unused palette slots must still be written: a mesh whose weights point at
    // a bone this species does not have would otherwise skin against whatever
    // the previous instance left there.
    let ident = makeBone(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0),
                         vec3f(0.0, 0.0, 1.0), vec3f(0.0));
    boneOut[inst.ids.x + b] = ident;
    boneOut[stride + inst.ids.x + b] = ident;
    return;
  }

  let rb = restBones[restBoneBase(inst.ids.y) + b];
  boneOut[inst.ids.x + b] = solveBone(
    sa, rb, inst.anim.x, inst.anim.y, inst.anim.z, inst.anim.w,
    inst.anim2.x, inst.anim2.y, inst.anim2.z, inst.posScale.w);
  boneOut[stride + inst.ids.x + b] = solveBone(
    sa, rb, inst.prevPos.w, inst.prevAnim.x, inst.prevAnim.y, inst.prevAnim.z,
    inst.prevAnim.w, inst.anim2.y, inst.anim2.z, inst.posScale.w);
}

// ---------------------------------------------------------------------------
// Vertex
// ---------------------------------------------------------------------------

struct VSOut {
  @builtin(position) pos : vec4f,
  @location(0) worldPos  : vec3f,   // camera-relative
  @location(1) normal    : vec3f,   // world space
  @location(2) uv        : vec2f,   // x = around the body, y = along it
  @location(3) objectPos : vec3f,   // model space, for procedural detail
  @location(4) albedo    : vec3f,
  @location(5) curClip   : vec4f,   // UNJITTERED clip position, this frame
  @location(6) prevClip  : vec4f,   // UNJITTERED clip position, last frame
  /// x = biolum mask, y = emissive gain, z = swim phase, w = hurt 0..1
  @location(7) extra     : vec4f,
  @location(8) @interpolate(flat) material : u32,
  @location(9) @interpolate(flat) speciesIndex : u32,
  /// x = trunk mask (1 on the lofted body, 0 on fins, snouts and hardware),
  /// y = per-INDIVIDUAL hash in [0,1). Both are constant across any triangle -
  /// a triangle never spans two parts and never two instances - so interpolation
  /// is free and neither needs a flat qualifier.
  @location(10) patt : vec2f,
  /// The emissive organ's radius in WORLD metres - the rest-pose radius of
  /// gyration times this instance's scale. Resolved in the vertex stage because
  /// that is where the instance record is; the fragment stage needs it for the
  /// fRes handover to render/passes/glow.js.
  @location(11) @interpolate(flat) emitRadius : f32,
};

/// FIN / WING / SPANWISE UNDULATION, per vertex.
///
/// DESIGN/06.3.4's fin flutter, 06.3.2's rajiform wave and the flyer's wingbeat
/// are one formula. The span coordinate is |x| / (0.5 * L), the amplitude grows
/// along the span (0.2 + 0.8*w, straight out of the rajiform detail), and the
/// phase retards along it so the motion is a travelling wave rather than a
/// rigid flap:
///
///   dy(w) = Af * (0.2 + 0.8*w) * sin(2*PI*fFin*t + phi - 2*PI*w/lambdaFin)
///
/// with `Af` interpolating af0 -> af1 as speed rises (fins fold back at speed,
/// DESIGN/06.3.4) and fFin = f * mFin. For AM_RAJIFORM the amplitude comes from
/// the SWIM amplitude instead, because for a ray the wing IS the propulsor.
///
/// Returns the vertical displacement in metres.
fn finWave(sa: SpeciesAnim, local: vec3f, phase: f32, speed: f32,
           material: u32) -> f32 {
  // Only thin tissue flutters. Skin, bone and eyes do not.
  if (material != MM_TRANSLUCENT) { return 0.0; }

  let L = max(sa.shape.w, 1e-4);
  let U = speed / L;
  let mode = sa.info.x;

  let span = saturate(abs(local.x) / (0.5 * L));
  if (span < 1e-3) { return 0.0; }   // a median fin has no span to wave along

  var Af : f32;
  if (mode == AM_RAJIFORM || mode == AM_WING) {
    // The wing is the engine: amplitude tracks the swim amplitude and GROWS
    // with speed rather than folding away.
    let tAmp = saturate((U - sa.amp.z) / max(sa.amp.w - sa.amp.z, 1e-4));
    Af = (sa.amp.x + (sa.amp.y - sa.amp.x) * tAmp) * L * 2.4;
  } else {
    // A pectoral fin folds back as the fish speeds up: af0 at rest, af1 at U1.
    let fold = saturate(U / max(sa.amp.w, 1e-4));
    Af = mix(sa.fin.y, sa.fin.z, fold) * L * 0.55;
  }

  let lambdaFin = max(sa.fin.w, 1e-3);
  let p = phase * sa.fin.x - TAU * span / lambdaFin;
  return Af * (0.2 + 0.8 * span) * sin(p);
}

/// Skin one vertex against a palette half.
///
/// Weights are normalised here rather than trusted: they arrive as unorm8 and
/// four values that summed to exactly 1.0 in f32 do not necessarily sum to 255
/// after rounding, and a sum of 0.996 shrinks the vertex toward the origin by
/// 0.4% - which on a 30 m leviathan is 12 cm of visible seam.
fn skinVertex(base: u32, idx: vec4u, wts: vec4f, p: vec3f, n: vec3f,
              outNormal: ptr<function, vec3f>) -> vec3f {
  let sum = wts.x + wts.y + wts.z + wts.w;
  let w = select(vec4f(1.0, 0.0, 0.0, 0.0), wts / sum, sum > 1e-5);
  var sp = vec3f(0.0);
  var sn = vec3f(0.0);
  let p4 = vec4f(p, 1.0);
  for (var k = 0u; k < 4u; k++) {
    let wk = w[k];
    if (wk <= 0.0) { continue; }
    let b = bones[base + idx[k]];
    sp += wk * vec3f(dot(b.r0, p4), dot(b.r1, p4), dot(b.r2, p4));
    sn += wk * vec3f(dot(b.r0.xyz, n), dot(b.r1.xyz, n), dot(b.r2.xyz, n));
  }
  *outNormal = sn;
  return sp;
}

@vertex
fn vs_creature(
  // ---- mesh (48 B stride) ----
  @location(0) position   : vec3f,
  @location(1) normal     : vec3f,
  @location(2) uv         : vec2f,
  @location(3) vcolor     : vec4f,   // sqrt(linear rgb), a = biolum mask
  @location(4) packed     : vec4f,   // x = material/255, y = inflate weight,
                                     // z = trunk mask
  @location(5) boneIndices: vec4u,
  @location(6) boneWeights: vec4f,
  @builtin(instance_index) ii : u32,
) -> VSOut {
  var out : VSOut;
  let inst = insts[ii];
  let sa = species[inst.ids.y];
  let material = u32(round(packed.x * 255.0)) & 7u;

  // INFLATION, blend-shape-free: push the vertex along its own normal by the
  // instance's inflate amount times the mesh's per-vertex inflate weight. Two
  // species use it - the Bloatspine puffing up and the Pale Herald's melon.
  var local = position + normal * (packed.y * inst.anim2.w * sa.extra.y);

  // Fin, wing and spanwise motion, before skinning so the spine wave carries it.
  let flutter = finWave(sa, local, inst.anim.x, inst.anim.y, material);
  let prevFlutter = finWave(sa, local, inst.prevPos.w, inst.prevAnim.x, material);

  var localCur = local;  localCur.y += flutter;
  var localPrev = local; localPrev.y += prevFlutter;

  // ---- skinning ---------------------------------------------------------
  var nCur = vec3f(0.0);
  var nPrev = vec3f(0.0);
  let skinnedCur = skinVertex(inst.ids.x, boneIndices, boneWeights,
                              localCur, normal, &nCur);
  let paletteStride = arrayLength(&bones) / 2u;
  let skinnedPrev = skinVertex(paletteStride + inst.ids.x, boneIndices,
                               boneWeights, localPrev, normal, &nPrev);

  // ---- rigid transform --------------------------------------------------
  let world = qRotate(inst.orient, skinnedCur) + inst.posScale.xyz;
  let prevWorld = qRotate(inst.prevOrient, skinnedPrev) + inst.prevPos.xyz;
  let N = normalize(qRotate(inst.orient, nCur));

  // Vertex colour is sqrt(linear) in eight bits, so squaring is the decode -
  // the same encoding pass/scatter.wgsl and pass/terrain.wgsl use, and for the
  // same reason: eight bits of LINEAR colour bands visibly across dark tissue.
  let meshAlbedo = vcolor.rgb * vcolor.rgb;

  out.worldPos = world;
  out.normal = N;
  out.uv = uv;
  out.objectPos = position;
  out.albedo = meshAlbedo * inst.tint.rgb;
  out.extra = vec4f(vcolor.a, inst.tint.w, inst.anim.x, inst.misc.x);
  out.material = material;
  out.speciesIndex = inst.ids.y;
  out.patt = vec2f(packed.z, inst.misc.y);
  out.emitRadius = sa.emit.x * inst.posScale.w;
  out.pos = frame.viewProj * vec4f(world, 1.0);
  out.curClip = frame.viewProjUnjittered * vec4f(world, 1.0);
  out.prevClip = frame.prevViewProj * vec4f(prevWorld, 1.0);
  return out;
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

struct Surface {
  albedo       : vec3f,
  roughness    : f32,
  metallic     : f32,
  ao           : f32,
  translucency : f32,
  /// Multiplies the species' bioluminescent radiance.
  glow         : f32,
};

// ---------------------------------------------------------------------------
// ALBEDO PATTERN
// ---------------------------------------------------------------------------
//
// PIGMENT, as distinct from the bioluminescence mask - which is light the animal
// EMITS and which is what `vcolor.a` and `bodyPattern()` in creature_mesh.js
// have always driven. Body COLOUR used to be one smoothstep from `tint` to
// `ventral` and nothing else, so a Sunplate whose own datasheet says "vertical
// bands of chrome yellow and blue-black" rendered as a flat pale disc.
//
// IT LIVES IN THE FRAGMENT STAGE, NOT IN THE VERTEX COLOUR. A bar is a hard edge
// and its width in vertex colour is bounded below by the RING SPACING of the
// loft: a Coppersprat's trunk is eight rings, so four bars would be 0.9 rings
// apart and land between samples. Here the bar is exact at any mesh resolution,
// costs nothing per vertex, and can be jittered per INDIVIDUAL so a shoal is not
// one animal stamped forty times.
//
// The parameterisation is the trunk's own: `a` = uv.x = theta / TAU, where 0 and
// 0.5 are the two flanks, 0.25 the dorsum and 0.75 the belly (loftTrunk derives
// ventralness as 0.5 - 0.5*sin(theta) from exactly this), and `u` = uv.y runs 0
// at the snout to 1 at the tail tip. Everything below wraps correctly at the
// theta seam - the loft emits theta = 0 and theta = TAU as two vertices at the
// same point - because every term is a function of u, of the folded distance in
// a, or of sin/cos(a * TAU).
//
// THE MASK IS SIGNED. Positive mixes toward the pattern colour; NEGATIVE mixes
// toward a lifted version of the ground colour, which is what a pale ocellus
// ring or a lateral highlight is. One channel, two pigments.

const AP_NONE    : u32 = 0u;
const AP_BANDS   : u32 = 1u;   // vertical bars across the body
const AP_STRIPE  : u32 = 2u;   // one lateral line down each flank
const AP_SADDLES : u32 = 3u;   // dorsal patches only
const AP_EYEMASK : u32 = 4u;   // a bar through the eye and one at the tail root
const AP_SPOTS   : u32 = 5u;   // a jittered dot field
const AP_EYESPOT : u32 = 6u;   // one ringed ocellus near the tail

/// Antialiased step. `w` is the half-width of the transition in the SAME units
/// as `d`, which the caller takes from fwidth(uv) - so a feature narrower than a
/// pixel dissolves toward the mask's own mean instead of aliasing into crawling
/// stripes, exactly as a mipmap would.
fn edge(d: f32, w: f32) -> f32 {
  return 1.0 - smoothstep(-w, w, d);
}

/// Folded distance around the theta seam, in units of `a` (so 0.5 is the far
/// side of the animal).
fn thetaDist(a: f32, centre: f32) -> f32 {
  let d = abs(fract(a - centre + 0.5) - 0.5);
  return d;
}

fn albedoPatternMask(kind: u32, a: f32, u: f32, count: f32, duty: f32,
                     hash: f32, w: vec2f) -> f32 {
  if (kind == AP_BANDS) {
    // Bars run around the body, so they are a function of u alone. The phase is
    // jittered per individual: a shoal of identically barred fish reads as a
    // texture, not as animals.
    let n = max(count, 1.0);
    let phase = fract(u * n + hash * 0.37);
    // Half-width of the pigmented part of one repeat, in u.
    let half = duty * 0.5;
    return edge(abs(phase - 0.5) - half, max(w.y * n, 1e-4))
         * smoothstep(0.02, 0.10, u) * (1.0 - smoothstep(0.88, 0.99, u));
  }
  if (kind == AP_STRIPE) {
    // A lateral line sits ON the flank, at theta 0 and theta 0.5, and fades at
    // both ends or it reads as two solid halves rather than as a line.
    let half = duty * 0.25;
    let d = min(thetaDist(a, 0.0), thetaDist(a, 0.5));
    return edge(d - half, max(w.x, 1e-4))
         * smoothstep(0.05, 0.18, u) * (1.0 - smoothstep(0.82, 0.97, u));
  }
  if (kind == AP_SADDLES) {
    let n = max(count, 1.0);
    let phase = fract(u * n + hash * 0.41);
    let half = duty * 0.5;
    let bar = edge(abs(phase - 0.5) - half, max(w.y * n, 1e-4));
    // sin(a*TAU) is +1 at the dorsum and -1 at the belly, and it is the same
    // quantity loftTrunk counter-shades with, so a saddle cannot cross the seam.
    let dorsal = 0.5 + 0.5 * sin(a * TAU);
    return bar * smoothstep(0.34, 0.86, dorsal);
  }
  if (kind == AP_EYEMASK) {
    // The two marks a fish can still be recognised by at a range where nothing
    // else about it resolves.
    let head = edge(abs(u - 0.15) - 0.055, max(w.y, 1e-4));
    let tail = edge(abs(u - 0.86) - 0.035, max(w.y, 1e-4));
    return max(head, tail);
  }
  if (kind == AP_SPOTS) {
    // A lattice in (theta, u) with a per-cell jitter. Sampled on the CIRCLE in
    // theta so the field is continuous across the seam - the same fix the
    // bioluminescent NET pattern needed.
    let n = max(count, 1.0);
    let th = a * TAU;
    let p = vec2f(u * n * 1.7 + hash * 5.1, (0.5 + 0.5 * sin(th)) * n);
    let cell = floor(p);
    let f = p - cell;
    let j = vec2f(latticeHash2(vec2i(cell), 0x51c7u),
                  latticeHash2(vec2i(cell), 0x9e2bu));
    let d = length((f - mix(vec2f(0.22), vec2f(0.78), j)) * vec2f(1.0, 0.8));
    let r = 0.16 + 0.22 * duty;
    return edge(d - r, max(w.y * n * 1.7, 1e-4))
         * smoothstep(0.06, 0.16, u) * (1.0 - smoothstep(0.86, 0.98, u));
  }
  if (kind == AP_EYESPOT) {
    // One ocellus, on the flank near the tail root: a dark core inside a pale
    // ring. The ring is the NEGATIVE half of the mask.
    let du = (u - 0.74) / 0.10;
    let da = min(thetaDist(a, 0.0), thetaDist(a, 0.5)) / 0.13;
    let d = sqrt(du * du + da * da);
    let core = edge(d - 1.0, max(w.y * 10.0, 1e-4));
    let ring = edge(d - 1.62, max(w.y * 10.0, 1e-4)) - core;
    return core - 0.75 * max(ring, 0.0);
  }
  return 0.0;
}

/// Skin: scales, dermal denticles, and the wet sheen that makes a fish read as
/// a fish rather than as painted plastic.
///
/// The scale field is worley noise in OBJECT space, so it does not swim across
/// the body when the animal moves, and it is gated against the pixel footprint
/// because a 3 mm scale on a 0.11 m sprat is sub-pixel past two metres and
/// carries nothing but shimmer after that.
fn skinSurface(sa: SpeciesAnim, albedo: vec3f, p: vec3f, uv: vec2f, uvw: vec2f,
               footprint: f32, bodyLength: f32, trunk: f32, hash: f32) -> Surface {
  var s : Surface;
  // Scale pitch scales with the animal: roughly 90 scales along the body,
  // whatever the body is, which is what real fish do.
  let density = 90.0 / max(bodyLength, 0.02);
  let cell = worley3(p * density, 0x2f61u, 1.0);
  let scaleEdge = (1.0 - smoothstep(0.0, 0.32, cell.y - cell.x))
                * bandGain(1.0 / density, footprint);
  let mottle = fbm3(p * (7.0 / max(bodyLength, 0.05)), 0x71c4u, 3, 2.0, 0.5) * 0.5 + 0.5;

  var a = albedo * (0.86 + 0.28 * mottle);
  // Scale margins are paler and glossier than the scale itself.
  a = mix(a, a * 1.24, scaleEdge * 0.5);

  // PIGMENT, over the scale field and under everything else. Gated on `trunk`
  // because a snout, a barbel and a tentacle are also MM_FLORA and carry a
  // sweep uv, not the trunk's (theta, u) - a bar drawn on those would land
  // somewhere arbitrary.
  var rough = 0.34 + 0.18 * mottle + scaleEdge * 0.10 + sa.emit.z;
  let kind = u32(sa.pattern.x + 0.5);
  if (kind != AP_NONE && trunk > 0.5) {
    let m = albedoPatternMask(kind, uv.x, uv.y, sa.pattern.y, sa.pattern.z,
                              hash, uvw) * sa.pattern.w;
    if (m > 0.0) {
      a = mix(a, sa.patternCol.rgb * (0.86 + 0.28 * mottle), m);
      rough = mix(rough, sa.patternCol.w, m);
    } else if (m < 0.0) {
      // The pale half: a lifted version of the GROUND colour, so an ocellus
      // ring stays the animal's own hue instead of becoming a white dot.
      a = mix(a, mix(a, vec3f(1.0), 0.55), -m);
    }
  }

  s.albedo = a;
  // Wet, mucus-coated skin is smooth. The scale edges break it up.
  s.roughness = rough;
  s.metallic = 0.0;
  // The belly sits in the animal's own shadow; uv.y runs along the body and
  // p.y is up, so the downward-facing half is the occluded one.
  s.ao = saturate(0.72 + 0.28 * (p.y / max(bodyLength * 0.25, 0.01)));
  s.translucency = 0.06;
  s.glow = 1.0;
  return s;
}

/// Fin, bell, membrane, baleen: thin tissue, lit from behind as much as in
/// front. This is what evalTranslucency exists for.
fn finSurface(albedo: vec3f, uv: vec2f, footprint: f32, bodyLength: f32) -> Surface {
  var s : Surface;
  // Fin rays: straight, evenly spaced, running along the fin's span. uv.x is
  // the across-the-body coordinate on a fin sheet.
  let rays = sin(uv.x * 120.0) * 0.5 + 0.5;
  let gate = bandGain(bodyLength * 0.008, footprint);
  let webbing = fbm3(vec3f(uv * 9.0, 0.0), 0x53a7u, 2, 2.0, 0.5) * 0.5 + 0.5;

  var a = albedo * (0.84 + 0.30 * webbing);
  a *= 1.0 + (rays - 0.5) * 0.22 * gate;
  // The trailing edge is thinner, paler and often frayed. 1.18, not the 1.35 it
  // was: a fin is already lit from both faces below, so the rim lift stacked on
  // top of that and put a white margin around every coloured fish in the reef.
  let edge = smoothstep(0.70, 1.0, uv.y);
  a = mix(a, a * 1.18, edge * 0.5);

  s.albedo = a;
  s.roughness = 0.42 - edge * 0.08;
  s.metallic = 0.0;
  s.ao = 0.68 + 0.32 * uv.y;
  // Thin tissue: high translucency, and the trailing edge is the thinnest part.
  s.translucency = 0.72 + 0.24 * edge;
  s.glow = 0.6;
  return s;
}

/// Photophore: a light organ. Almost no diffuse response - the light comes out,
/// it does not go in - and a hard, small bright core so it reads as a POINT of
/// light rather than as a glowing patch of skin.
fn photophoreSurface(albedo: vec3f) -> Surface {
  var s : Surface;
  s.albedo = albedo * 0.35;
  s.roughness = 0.22;
  s.metallic = 0.0;
  s.ao = 1.0;
  s.translucency = 0.45;
  s.glow = 1.0;
  return s;
}

/// Carapace, teeth, keratin: hard, matte, porous.
fn carapaceSurface(albedo: vec3f, p: vec3f, footprint: f32, bodyLength: f32) -> Surface {
  var s : Surface;
  let density = 60.0 / max(bodyLength, 0.02);
  let pit = fbm3(p * density, 0x8c19u, 3, 2.0, 0.5);
  let gate = bandGain(1.0 / density, footprint);
  let grain = 0.5 + 0.5 * pit * gate;
  s.albedo = albedo * (0.80 + 0.36 * grain);
  s.roughness = 0.58 + 0.22 * (1.0 - grain);
  s.metallic = 0.0;
  s.ao = saturate(0.70 + 0.30 * grain);
  s.translucency = 0.12;
  s.glow = 0.35;
  return s;
}

/// Eye: a tight specular lobe over a near-black iris. The narrow highlight is
/// the entire reason an eye reads as WET, and it is why eyes get their own
/// material slot instead of being a dark patch of skin.
fn eyeSurface(albedo: vec3f, N: vec3f, V: vec3f) -> Surface {
  var s : Surface;
  let grazing = 1.0 - saturate(abs(dot(N, V)));
  s.albedo = albedo * 0.30;
  s.roughness = 0.055;
  s.metallic = 0.0;
  // A cornea is a lens: it retro-reflects, which is exactly the eyeshine a lamp
  // picks out of the dark at fifty metres.
  s.ao = 1.0;
  s.translucency = 0.0;
  s.glow = 0.25 + 0.75 * grazing;
  return s;
}

/// Armour plate: matte black with a metallic sheen at grazing angles only,
/// which is what DESIGN/06.4 specifies for the Nethercoil.
fn armourSurface(albedo: vec3f, p: vec3f, N: vec3f, V: vec3f,
                 footprint: f32, bodyLength: f32) -> Surface {
  var s : Surface;
  let density = 24.0 / max(bodyLength, 0.05);
  let scratch = fbm3(p * density, 0x4b73u, 3, 2.0, 0.5) * bandGain(1.0 / density, footprint);
  let grazing = 1.0 - saturate(abs(dot(N, V)));
  s.albedo = albedo * (0.62 + 0.30 * (scratch * 0.5 + 0.5));
  s.roughness = mix(0.62, 0.24, grazing * grazing);
  s.metallic = 0.35 + 0.55 * grazing;
  s.ao = 0.82 + 0.18 * (scratch * 0.5 + 0.5);
  s.translucency = 0.0;
  s.glow = 0.2;
  return s;
}

// ---------------------------------------------------------------------------
// Fragment
// ---------------------------------------------------------------------------

struct FragOut {
  @location(0) color    : vec4f,
  @location(1) velocity : vec2f,
  /// The SSAO gate: this pixel's delivered ambient share. See aoGate() in
  /// common/water.wgsl. Bioluminescence is in the denominator only, so an
  /// emitter's glow is outside SSAO's reach by construction.
  @location(2) gate     : f32,
};

@fragment
fn fs_creature(in: VSOut, @builtin(front_facing) frontFacing: bool) -> FragOut {
  let sa = species[in.speciesIndex];
  let P = in.worldPos;
  let absPos = toAbsolute(P);
  let depth = seaLevel() - absPos.y;

  let toEye = frame.cameraPos.xyz - P;
  let viewDist = length(toEye);
  let V = toEye / max(viewDist, 1e-4);

  // Fins and membranes are single-sided sheets drawn with culling off, so a
  // back face has to be flipped or half of every fin in the ocean is lit from
  // inside its own surface.
  let geoN = select(-normalize(in.normal), normalize(in.normal), frontFacing);

  // Derivatives must be taken in UNIFORM control flow, outside the material
  // branch. `uvw` is the per-pixel change in the trunk's own parameterisation,
  // which is what lets a pattern edge antialias exactly rather than against a
  // guessed body circumference.
  let footprint = pixelFootprint(P);
  let uvw = max(fwidth(in.uv), vec2f(1e-5));
  let L = sa.shape.w;
  let m = in.material;

  var s : Surface;
  if (m == MM_TRANSLUCENT) {
    s = finSurface(in.albedo, in.uv, footprint, L);
  } else if (m == MM_EMISSIVE) {
    s = photophoreSurface(in.albedo);
  } else if (m == MM_CRYSTAL) {
    s = eyeSurface(in.albedo, geoN, V);
  } else if (m == MM_BONE) {
    s = carapaceSurface(in.albedo, in.objectPos, footprint, L);
  } else if (m == MM_METAL) {
    s = armourSurface(in.albedo, in.objectPos, geoN, V, footprint, L);
  } else {
    s = skinSurface(sa, in.albedo, in.objectPos, in.uv, uvw, footprint, L,
                    in.patt.x, in.patt.y);
  }

  // ---- WOUNDS ------------------------------------------------------------
  // DESIGN/06.7.1 makes anything wounded preference-1.6 prey, so the player has
  // to be able to SEE which animal a Chiselfin pack is about to pick off. This
  // is the only cue that carries that information, and without it `misc.x`
  // travels all the way from the CPU to this stage and is discarded.
  //
  // It is a LOCALISED LESION and a channel-wise ABSORPTION, and both halves of
  // that matter. Localised, because repainting a whole animal dark red reads as
  // a different species rather than as an injured one - and MEASURED, a
  // whole-body tint moved the frame's mean luminance enough that auto-exposure
  // lifted the scene by 51% and cancelled most of the cue. Absorption, because
  // haemoglobin and exposed muscle attenuate green and blue an order of
  // magnitude harder than red, so damaged tissue goes dark AND red purely by
  // removing light, and a wounded animal can never end up brighter than a
  // healthy one. Torn skin has also lost its mucus layer, which is the roughness
  // term - a dulled patch reads as a wound even in silhouette.
  //
  // Photophores and eyes are exempt: a light organ does not bleed, and a red eye
  // reads as a species trait rather than as an injury.
  if (in.extra.w > 0.0 && m != MM_EMISSIVE && m != MM_CRYSTAL) {
    // Nothing shows until a quarter of the health is gone - a scratch on a
    // 4,000 HP leviathan must not mark it.
    let bleed = smoothstep(0.25, 1.0, in.extra.w);
    // The lesion is the top of a noise field, thresholded so the fraction of the
    // surface it covers GROWS with the damage: a few spots at a third health,
    // most of the flank at death's door. `patch` is a WGSL reserved keyword,
    // hence the name.
    let torn = fbm3(in.objectPos * (14.0 / max(L, 0.05)), 0x9d31u, 3, 2.0, 0.5)
             * 0.5 + 0.5;
    let cut = 1.0 - bleed * 0.78;
    let w = smoothstep(cut, cut + 0.16, torn);
    s.albedo *= mix(vec3f(1.0), vec3f(0.60, 0.10, 0.07), w);
    s.roughness = mix(s.roughness, 0.85, w * 0.8);
  }

  // ---- bioluminescence --------------------------------------------------
  // The mask is per VERTEX (creature_mesh.js writes it into colour.w), so the
  // glow lands on the photophores the mesh actually built - twenty-two ventral
  // dots on a Wisplight, one point in front of a Lanterngape's face - rather
  // than as a uniform wash over the whole animal, which is the failure mode
  // every emissive creature shader falls into.
  //
  // The pulse is metabolic and therefore breathes. hz = 0 means a steady organ.
  let hz = sa.biolum.w;
  var pulse = 1.0;
  if (hz > 0.0) {
    // Offset by the swim phase so a school of Wisplight twinkles instead of
    // strobing in unison.
    pulse = 0.55 + 0.45 * sin(currentTime() * TAU * hz + in.extra.z * 1.7);
  }
  // THE GLOW MUST SURVIVE THE DARK. Below TRUE_DARK_DEPTH the ambient is zero
  // and the ONLY thing that can make a creature visible is this term, so it is
  // scaled up as the water goes black rather than being a constant addition
  // that the tonemapper crushes along with everything else. 2.4x by 520 m.
  let darkGain = 1.0 + 1.4 * smoothstep(60.0, 520.0, depth);

  // THE HANDOVER TO THE GLOW SPRITES, and the reason this is a SPLIT and not an
  // addition. A photophore smaller than the reconstruction filter is delivered
  // stochastically: measured on the real Glimmerkrill mesh, an emissive area of
  // 2.29e-5 m2 subtends 0.23 px at 6 m and its delivered peak swings 24x with
  // sub-pixel position. render/passes/glow.js draws the unresolved share as a
  // band-limited Gaussian instead - so the geometry keeps fRes and the sprite
  // takes 1 - fRes, and the two sum to exactly 1 at every range. Adding a blob
  // BESIDE the speck instead would be a hidden 2x at long range.
  //
  // Gated on the flag, because a frame graph in which the sprite pass is absent
  // must not quietly lose the other half: registerPasses() reads passes off the
  // game object by name and an unset field is a silently absent pass.
  var fRes = 1.0;
  if (hasFlag(FLAG_GLOW_SPRITES)) {
    let focalPx = frame.screen.y * 0.5 / max(frame.cameraFwd.w, 1e-4);
    fRes = smoothstep(GLOW_SIGMA_PX, 2.0 * GLOW_SIGMA_PX,
                      in.emitRadius * focalPx / max(viewDist, 1e-3));
  }
  let emissive = sa.biolum.rgb
               * (in.extra.x * in.extra.y * s.glow * pulse * darkGain * fRes);

  let roughness = clamp(s.roughness, MIN_PERCEPTUAL_ROUGHNESS, 1.0);
  let thickness = sa.extra.z;
  let surf = makeSurface(P, geoN, geoN, V, s.albedo, roughness, s.metallic,
                         s.ao, emissive, s.translucency);
  let viewDepth = max(dot(-toEye, frame.cameraFwd.xyz), nearPlane());

  let lit = evalLightingSplitTranslucent(surf, in.pos.xy, viewDepth, thickness);
  var radiance = lit.total + emissive;

  // Caustics play across a fish's BACK as they do across the sand under it -
  // but not across its flanks, and the difference is four-fold, not a nuance:
  // causticFactor()'s facing term is saturate(N.y*0.75 + 0.25), which is 1.0 on
  // the up-facing sand and 0.25 on a vertical flank. A reviewer looking at a
  // lagoon shoal at 3 m could not see the modulation on the animals at all, and
  // that is why - a small fish presents mostly flank. The term below is the
  // AMBIENT share only; the one that carries the pattern is evalSun's, and the
  // direct beam is a measured 71% of an up-facing submerged surface's radiance
  // at 6 m in Jerlov IA with the sun at 78 deg.
  if (depth > 0.0) {
    // MEAN ZERO: causticFactor() is a mean-1 multiplier on the direct beam, so
    // the ambient share is its DEPARTURE from 1 and cannot lift the DC. The
    // 0.38/0.42 ratio this pass has always carried against terrain's gain is
    // kept: 0.42 -> 0.12 there, so 0.38 -> 0.11 here.
    let cf = causticFactor(P, geoN, depth);
    radiance += evalAmbientSH(geoN) * daylightAtDepth(depth) * surfaceDiffuse(surf)
              * ((cf - vec3f(1.0)) * 0.11);
  }

  // ---- participating medium, LAST ---------------------------------------
  // Flyers are in air, so only the submerged part of the view ray may be
  // fogged - the same split pass/scatter.wgsl and pass/entity.wgsl make. Below
  // the waterline pass/underwater.wgsl owns the whole ray instead.
  radiance = applyViewRayWater(radiance, viewDist, depthAt(P), -V);
  // Same split for the aerial volume: applied here in air, and left to
  // pass/underwater.wgsl's fullscreen composite when the eye is submerged.
  let screenUV = in.pos.xy * frame.screen.zw;
  radiance = applyViewRayFroxel(radiance, screenUV, viewDepth);

  // ---- SSAO gate ---------------------------------------------------------
  // The delivered ambient share; see the terrain pass's gate block. The
  // mean-zero caustic wiggle above is outside the numerator on purpose.
  let aoAmb = aoAmbientThroughMedium(lit.ambient, viewDist, depthAt(P), -V,
                                     screenUV, viewDepth);

  // ---- motion vector ----------------------------------------------------
  let cur = in.curClip.xy / max(in.curClip.w, 1e-6);
  let prv = in.prevClip.xy / max(in.prevClip.w, 1e-6);
  // NDC -> UV: half scale, y flips because UV runs down the screen. Same
  // convention as pass/terrain.wgsl, which pass/taa.wgsl consumes as
  // historyUV = uv - velocity.
  let velocity = (cur - prv) * vec2f(0.5, -0.5);

  var out : FragOut;
  out.color = vec4f(radiance, 1.0);
  out.velocity = velocity;
  out.gate = aoGate(aoAmb, radiance);
  return out;
}
