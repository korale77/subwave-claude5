# SUBWAVE - DESIGN SECTION 05

# Player Character: Locomotion, Swimming, Oxygen, Survival & Tools

Status: BINDING SPEC. Version 1.0. Owner: Player Systems.

This document is normative. Every number here is a contract. Where another section
disagrees with a number in this file, this file wins for anything inside the
`player/` module tree; for anything outside it, raise a conflict rather than
silently diverging.

---

## 05.0 SCOPE, CONVENTIONS AND GLOBAL CONSTANTS

### 05.0.1 Scope

In scope: the first-person avatar, land locomotion, swimming, buoyancy, oxygen,
pressure, thermal, health, status effects, handheld tools, first-person
presentation, world interaction, death and respawn, and the player-side save
payload.

Out of scope (owned elsewhere, referenced only): terrain generation, ocean surface
and wave field, vessel flight/dive dynamics, creature AI, biome definition,
crafting recipe graph, renderer core, audio engine core.

### 05.0.2 Coordinate and unit conventions (restated, binding)

| Item | Value |
|---|---|
| Handedness | Right-handed |
| +X | East |
| +Y | Up |
| +Z | South |
| Sea level | y = 0 |
| Depth d | d = -y, positive downward, metres |
| Altitude a | a = +y above sea level, metres |
| Angles internal | radians |
| Angles in UI | degrees |
| Heading 0 deg | North = -Z |
| Heading increases | clockwise viewed from +Y looking down; East = 90 deg |
| Mass | kg |
| Force | N |
| Time | s |
| Pressure | Pa internally, bar and ata in UI |
| Temperature | degrees C |
| Sound level | dBFS on the master bus |

Heading extraction from a forward vector `f` (normalized, world space):

```js
// returns [0, 2*PI), 0 = north(-Z), PI/2 = east(+X)
function headingFromForward(f) {
  let h = Math.atan2(f.x, -f.z);
  return h < 0 ? h + Math.PI * 2 : h;
}
```

### 05.0.3 Global physical constants used by the player module

| Symbol | Name | Value | Unit | Notes |
|---|---|---|---|---|
| `G_WORLD` | Surface gravity | 9.40 | m/s^2 | Slightly sub-Earth. Used by ALL sections. |
| `RHO_SEA_0` | Seawater density at y=0 | 1031.0 | kg/m^3 | Saline, 26 C surface |
| `RHO_SEA_K` | Density gain with depth | 0.0045 | kg/m^3 per m | Compressibility + thermocline. `rho(d) = RHO_SEA_0 + RHO_SEA_K*d` |
| `RHO_AIR` | Air density at y=0 | 1.204 | kg/m^3 | |
| `P_ATM` | Surface atmospheric pressure | 101325 | Pa | |
| `M_PER_ATA` | Depth per additional atmosphere | 10.455 | m | `P_ATM / (RHO_SEA_0 * G_WORLD)` |
| `MU_WATER` | Dynamic viscosity | 0.00095 | Pa*s | Only used for micro-drag on bubbles |
| `T_SURF_WATER` | Reference surface water temp | 26.5 | deg C | Biomes offset this |

Ambient absolute pressure at depth d (metres), in atmospheres absolute:

```js
const M_PER_ATA = 10.455;
function ata(d) { return 1.0 + Math.max(0, d) / M_PER_ATA; }   // d in metres, d<=0 -> 1.0
```

Exact Pa form (used for suit crush and gas-law solving):

```js
function pressurePa(d) {                    // d metres, >=0
  // integrate rho(d)*g dd  ->  g*(RHO_SEA_0*d + 0.5*RHO_SEA_K*d*d)
  return 101325 + 9.40 * (1031.0 * d + 0.5 * 0.0045 * d * d);
}
```

At d = 1000 m this yields 1.0133e5 + 9.4*(1.031e6 + 2250) = 9.82 MPa = 97.0 ata.
The linear `ata()` approximation gives 96.7 ata. The linear form is used for
oxygen consumption (cheap, per-frame); the exact form is used for suit crush and
for the depth gauge display above 500 m.

### 05.0.4 Fixed-step integration contract

The player simulation runs at a FIXED 120 Hz substep (`DT_PLAYER = 1/120 s`),
accumulator-driven, max 4 substeps per rendered frame (i.e. it will slow down
rather than explode below 30 fps). Camera transform is interpolated between the
last two substeps by the render alpha. Never integrate player physics with the
frame delta.

```
accumulator += min(frameDt, 0.0333)
while (accumulator >= 1/120) { stepPlayer(1/120); accumulator -= 1/120 }
alpha = accumulator * 120
```

All rates in this document are per real second unless stated otherwise, and are
multiplied by the substep dt at integration time.

### 05.0.5 Player state machine

| # | State id | Description |
|---|---|---|
| 0 | `GROUNDED` | Feet on walkable ground, above water |
| 1 | `AIRBORNE` | In air, no ground contact, above water |
| 2 | `SLIDING` | On ground steeper than the walk limit |
| 3 | `WADING` | Grounded, waterline between ankle and chest |
| 4 | `TREADING` | Head at/near the surface, no ground contact |
| 5 | `SWIM_FREE` | Fully submerged, 6-DOF |
| 6 | `PILOTING` | Seated inside the vessel; player physics disabled |
| 7 | `ANCHOR_REST` | Seated/sleeping at a base anchor (save/respawn point) |
| 8 | `STUNNED` | Input locked, physics active |
| 9 | `BLACKOUT` | Dying/dead; camera detaches, physics ragdoll-free-float |

Legal transitions:

```
GROUNDED  <-> AIRBORNE, SLIDING, WADING, PILOTING, ANCHOR_REST, STUNNED, BLACKOUT
AIRBORNE  <-> GROUNDED, TREADING, SWIM_FREE, SLIDING, STUNNED, BLACKOUT
SLIDING   <-> GROUNDED, AIRBORNE, WADING, STUNNED, BLACKOUT
WADING    <-> GROUNDED, TREADING, SWIM_FREE, STUNNED, BLACKOUT
TREADING  <-> SWIM_FREE, WADING, AIRBORNE, PILOTING, STUNNED, BLACKOUT
SWIM_FREE <-> TREADING, WADING, PILOTING, STUNNED, BLACKOUT
PILOTING  <-> GROUNDED, TREADING, SWIM_FREE, WADING
ANCHOR_REST <-> GROUNDED
STUNNED   -> previous state, BLACKOUT
BLACKOUT  -> GROUNDED | TREADING (via respawn only)
```

Any transition not listed is a bug and must assert in dev builds.

---

## 05.1 THE PLAYER RIG

### 05.1.1 Collision body

The player is a vertical capsule. It never tilts on land. Underwater the capsule
is still axis-aligned vertical for COLLISION, but a separate oriented ellipsoid is
used for DRAG (see 05.3.4).

| Property | Standing | Crouched | Prone/streamline (swim only) | Unit |
|---|---|---|---|---|
| Total height | 1.80 | 1.05 | n/a (capsule stays 1.80) | m |
| Radius | 0.32 | 0.32 | 0.32 | m |
| Cylinder segment | 1.16 | 0.41 | - | m |
| Eye height above feet | 1.655 | 0.895 | - | m |
| Camera lateral offset | 0.00 | 0.00 | 0.00 | m |
| Shoulder height | 1.46 | 0.78 | - | m |
| Crouch transition time | 0.18 s down / 0.24 s up | | | s |
| Crouch blocked-uncrouch check | sphere cast r=0.31 up 0.76 m | | | |

The camera never sits exactly at the capsule top: the 0.145 m gap between eye
(1.655) and capsule apex (1.80) prevents the near plane from clipping through
ceilings the body is still colliding with.

### 05.1.2 Mass budget

| Component | Mass (kg) | Displaced volume (m^3) | Compressible |
|---|---|---|---|
| Body (soft tissue + skeleton) | 78.0 | 0.0776 | no |
| Dive skin + hood + boots (S0) | 4.2 | 0.0092 | yes (closed-cell foam) |
| Rebreather/regulator harness | 2.4 | 0.0012 | no |
| Gas cylinder T0 (charged) | 1.1 | 0.00028 | no |
| Wrist unit + lamp + belt | 1.3 | 0.0009 | no |
| Trim ballast (adjustable) | 0.0 - 6.0 | 0.0 | no |
| Inventory payload | 0.0 - 18.0 | +0.0004 per kg | no |
| **Default loadout total** | **87.0** | **0.0891** | |

Suit foam volume is `V_foam(d)`, obeying Boyle's law against the ambient pressure:

```js
const V_FOAM_0 = 0.0092;                    // m^3 at surface, S0 skin
function foamVolume(d, tier) {
  const v0 = SUIT_FOAM_V0[tier];            // see 05.4.2 table
  return v0 * (101325 / pressurePa(d));     // isothermal Boyle
}
```

Lungs do NOT compress. A diver breathing from a regulator inhales gas already at
ambient pressure, so thoracic volume stays at ~0.0035 m^3 regardless of depth.
This is a common simulation error; do not implement lung compression. (Freediving
on a held breath is not a mechanic in SUBWAVE.)

### 05.1.3 Shadow proxy

The player has no visible body, but MUST cast a shadow so land traversal reads
correctly and so the player can see themselves silhouetted by their own lamp.

- Shadow proxy: a 14-segment capsule mesh (168 tris) at the collision capsule
  transform, plus two 6-segment leg cylinders that swing procedurally with the
  step phase (amplitude +/- 24 deg, phase-locked to the footstep cycle).
- The proxy is tagged `SHADOW_ONLY`: it is submitted to the shadow-map pass and
  to nothing else. `cullMode: 'none'` in the shadow pipeline.
- Underwater the proxy is retained and additionally used for the volumetric light
  shafts occlusion pass, so the player's own lamp cones are broken by their body.

### 05.1.4 Camera

| Property | Value |
|---|---|
| Vertical FOV in air | 62.0 deg (approx 95.6 deg horizontal at 16:9) |
| Vertical FOV underwater (full refraction) | 48.6 deg |
| Underwater refraction blend (default) | 0.65 |
| Near plane | 0.045 m |
| Far plane | 6000 m (air), 900 m (underwater, fog-limited) |
| Pitch clamp on land | -87 to +87 deg |
| Pitch clamp swimming | -90 to +90 deg (no gimbal wrap; roll handles the rest) |
| Roll (land) | 0, plus head-bob roll only |
| Roll (swim) | free, manual, auto-levelling (05.3.6) |
| Mouse sensitivity default | 0.0022 rad per count |
| Mouse smoothing | none (raw). Optional 1-frame EMA at alpha 0.35 in Accessibility |

Underwater FOV derivation. A flat air/water interface in front of the eye (the
mask lens) magnifies by the refractive index ratio n_water/n_air = 1.339. The
apparent field narrows accordingly:

```js
const N_WATER = 1.339;
function fovUnderwater(fovAirRad, blend) {
  const full = 2 * Math.atan(Math.tan(fovAirRad * 0.5) / N_WATER);
  return fovAirRad + (full - fovAirRad) * blend;   // blend in [0,1]
}
// 62 deg air, blend 1.0 -> 48.63 deg ; blend 0.65 -> 53.3 deg
```

FOV crossfade on water entry/exit: 0.42 s, ease `smoothstep`, driven by the same
`submergence` scalar as the audio filter (05.4.1). Objects appear 1.339x larger
underwater, which is the correct and desirable perceptual cue: creatures loom.

---

## 05.2 LAND LOCOMOTION

### 05.2.1 Speed and acceleration

| Mode | Target speed (m/s) | Accel (m/s^2) | Decel (m/s^2) | Notes |
|---|---|---|---|---|
| Walk | 2.60 | 26.0 | 32.0 | default forward |
| Run (sprint) | 5.40 | 30.0 | 32.0 | costs stamina 6.0/s |
| Crouch-walk | 1.35 | 18.0 | 30.0 | |
| Wade (knee) | 2.05 | 20.0 | 30.0 | waterline 0.35-0.85 m |
| Wade (waist) | 1.30 | 14.0 | 26.0 | waterline 0.85-1.25 m |
| Wade (chest) | 0.85 | 10.0 | 22.0 | waterline 1.25-1.62 m |
| Airborne | 5.40 cap | 4.0 | 0.35 | air control is deliberately weak |
| Slide (on steep) | uncapped | gravity-driven | mu 0.28 | see 05.2.4 |

Directional multipliers applied to the target speed, before acceleration:

| Direction | Multiplier |
|---|---|
| Forward | 1.00 |
| Diagonal forward | 1.00 (input vector normalized, no diagonal boost) |
| Strafe | 0.86 |
| Backward | 0.72 |
| Backward while sprinting | sprint disabled; falls back to walk*0.72 |

Acceleration model (ground): velocity-target with a hard accel clamp, NOT an
impulse-add model. This keeps top speed exact and prevents bunny-hop stacking.

```js
// horizontal only; vertical handled by gravity/step
const want = inputDirWorld * targetSpeed;              // vec2 (x,z)
const delta = want - velXZ;
const maxDv = (want.lengthSq() > velXZ.lengthSq() ? accel : decel) * dt * surfaceGrip;
velXZ += delta.clampLength(maxDv);
```

`surfaceGrip` comes from the material table (05.2.7), range 0.42 - 1.00.

### 05.2.2 Gravity, jump, fall

| Property | Value | Unit |
|---|---|---|
| Gravity (land, standing) | 9.40 | m/s^2 |
| Gravity multiplier while rising and jump held | 1.00 | - |
| Gravity multiplier while rising and jump released | 2.15 | - (variable jump height) |
| Gravity multiplier while falling | 1.35 | - (snappier arc) |
| Terminal velocity in air | 58.0 | m/s |
| Jump apex height (full hold) | 1.05 | m |
| Jump initial velocity | 4.443 | m/s (`sqrt(2*9.4*1.05)`) |
| Minimum jump height (instant release) | 0.49 | m |
| Time to apex (full) | 0.473 | s |
| Jump cooldown | 0.18 | s |
| Coyote time | 0.12 | s |
| Jump input buffer | 0.15 | s |
| Ledge-grab / mantle | none (no climbing verb in SUBWAVE) | |

Fall damage on solid ground:

```js
// v = downward impact speed, m/s
const V_SAFE = 6.5;      // ~2.25 m free fall
const V_LETHAL = 20.2;
function fallDamage(v) {
  if (v <= V_SAFE) return 0;
  return Math.min(100, 7.4 * (v - V_SAFE) * (1 + 0.045 * (v - V_SAFE)));
}
// 8 m/s -> 11.6 HP | 12 m/s -> 55 HP | 16 m/s -> 100 HP (lethal from ~13.0 m)
```

Landing on a surface with `softness >= 0.6` (sand, mud, sporeturf) multiplies fall
damage by 0.55. Landing in water deeper than 1.4 m: damage only above 14.0 m/s,
using `0.9*fallDamage(v-7.5)`; below that it is a splash and a stagger.

Landing stagger: if impact speed > 9.0 m/s, apply `STUNNED` for
`0.25 + 0.035*(v-9.0)` s, capped 0.75 s, plus a camera dip of 0.16 m.

### 05.2.3 Step height and stair handling

| Property | Value |
|---|---|
| Max step-up height | 0.42 m |
| Max step-down snap | 0.55 m (only while `GROUNDED` and moving) |
| Step probe | forward sweep of a 0.31 m sphere, then downward sweep |
| Visual step smoothing | camera Y lags the capsule Y by an exponential with tau = 0.055 s, clamped to 0.42 m of lag |
| Step-up cost | none (no speed penalty below 0.25 m; 0.85x speed for 0.12 s above) |

Ground detection: a sphere cast of radius 0.30 downward from capsule centre,
distance `0.58 + 0.06` (skin). Grounded if a hit is found AND the hit normal's
`dot(n, +Y) >= cos(47 deg) = 0.682`.

### 05.2.4 Slopes

| Slope angle | Behaviour |
|---|---|
| 0 - 33 deg | Full speed |
| 33 - 47 deg | Speed scaled by `lerp(1.0, 0.62, (a-33)/14)` when ascending; full speed descending |
| 47 - 62 deg | `SLIDING`. Not walkable. Player accelerates downslope. Jump allowed (weak). |
| > 62 deg | Treated as wall. Zero traction. Slide plus wall-slide friction 0.06. |

Slide dynamics:

```js
// n = surface normal, g = 9.40
const down = normalize(vec3(0,-1,0) - n * dot(vec3(0,-1,0), n));   // downslope unit vector
const aSlide = g * (dot(vec3(0,-1,0), -n) /*cos*/ * 0 + Math.sin(slopeAngle)) - MU_SLIDE * g * Math.cos(slopeAngle);
// MU_SLIDE = 0.28 (0.16 on wet basalt, 0.40 on sporeturf)
vel += down * max(0, aSlide) * dt;
```

While `SLIDING` the player retains 0.35x steering authority (lateral accel 6 m/s^2)
so a slide is survivable, not a death sentence. Sliding into water cancels the
state immediately.

### 05.2.5 Head bob

Head bob is a camera-space offset + roll, driven by a step phase accumulator that
advances with DISTANCE TRAVELLED, not with time. This is essential: bob stays in
sync at any speed, and stops instantly when the player stops.

```js
// stride: metres of ground travel per full 2-step cycle
const STRIDE_WALK = 1.56, STRIDE_RUN = 2.12, STRIDE_CROUCH = 1.02;
phase += (horizontalSpeed * dt) / stride * Math.PI * 2;   // radians
```

| Parameter | Walk | Run | Crouch | Wade | Unit |
|---|---|---|---|---|---|
| Vertical amplitude A_y | 0.021 | 0.034 | 0.014 | 0.017 | m |
| Vertical frequency | 2 * phase | 2 * phase | 2 * phase | 2 * phase | - |
| Lateral amplitude A_x | 0.026 | 0.041 | 0.018 | 0.020 | m |
| Lateral frequency | 1 * phase | 1 * phase | 1 * phase | 1 * phase | - |
| Camera roll amplitude | 0.55 | 1.10 | 0.40 | 0.45 | deg |
| Pitch amplitude | 0.28 | 0.62 | 0.20 | 0.25 | deg |
| Weapon/tool counter-bob | 0.55x of camera, phase-shifted +0.42 rad | | | | |

```js
const bobY = A_y * Math.abs(Math.sin(phase));            // rectified: two dips per cycle
const bobX = A_x * Math.sin(phase * 0.5);
const roll = ROLL_AMP * Math.sin(phase * 0.5 + 0.35);
```

Landing impulse spring (separate from bob, additive):

```
critically-damped-ish spring on camera Y offset
k = 180 N/m-equivalent, c = 22, mass 1
impulse on land: y_offset -= min(0.14, 0.010 * impactSpeed)   // 0.09 m at 9 m/s
```

**Camera Motion toggle (accessibility, REQUIRED).** Settings slider
`cameraMotion` in [0, 100], default **70**. It scales A_y, A_x, roll, pitch,
landing dip, swim surge (05.3.7) and vessel-entry camera arcs by `cameraMotion/100`.
At 0 the camera is perfectly rigid; footstep audio and animation still play. A
second independent toggle `worldTilt` (default ON) controls whether camera ROLL is
allowed at all (some players get sick from roll but tolerate bob).

### 05.2.6 Footstep timing

One footstep event fires each time `phase` crosses a multiple of PI (i.e. twice
per stride cycle). Additional constraints:

- Minimum interval between steps: 0.20 s (prevents machine-gunning on stairs).
- No steps while `AIRBORNE`; a `LAND` event fires instead on touchdown.
- A `JUMP_SCUFF` event fires on takeoff at 0.6x the step gain.
- Sprinting adds a `BREATH_EXERT` event every 3rd step (see 05.6.6).

### 05.2.7 Surface materials, friction and footstep synthesis

All footstep audio is SYNTHESIZED. No samples. The synth is: an exciter (filtered
noise burst, optionally plus a click impulse) into a small resonator bank (2-3
biquad bandpasses in parallel with per-band decay), then a per-material EQ and the
environment reverb send.

| ID | Material | mu (grip) | Softness | Noise centre Hz | BW (Q) | Decay ms | Resonator f1/f2/f3 Hz | Gain dB | Particles |
|---|---|---|---|---|---|---|---|---|---|
| 0 | Dry sand | 0.62 | 0.85 | 2400 | 0.7 | 95 | 190 / - / - | -19 | dust puff 12 |
| 1 | Wet sand | 0.78 | 0.70 | 1500 | 0.9 | 70 | 165 / 420 / - | -17 | wet dark decal |
| 2 | Shell gravel | 0.70 | 0.45 | 4200 | 1.4 | 130 | 900 / 2100 / 3600 | -14 | shard 6 |
| 3 | Basalt (dry) | 0.92 | 0.05 | 3100 | 2.2 | 55 | 640 / 1750 / 4200 | -15 | none |
| 4 | Basalt (wet) | 0.74 | 0.05 | 2800 | 2.0 | 65 | 610 / 1700 / 4000 | -14 | droplet 4 |
| 5 | Coral rubble | 0.66 | 0.30 | 5200 | 1.6 | 150 | 1200 / 2700 / 5100 | -13 | shard 8 |
| 6 | Sporeturf (soft ground cover) | 0.84 | 0.75 | 1800 | 0.6 | 110 | 240 / 700 / - | -21 | spore 10 |
| 7 | Silt / mud | 0.55 | 0.95 | 900 | 0.5 | 180 | 120 / 300 / - | -18 | silt cloud 20 |
| 8 | Metal deck (vessel/base) | 1.00 | 0.00 | 3600 | 3.5 | 320 | 420 / 1180 / 2360 | -11 | none |
| 9 | Shallow water (<0.40 m) | 0.72 | 0.60 | 3000 | 0.4 | 210 | 300 / 850 / - | -12 | splash 24 |
| 10 | Ice / frost crust | 0.42 | 0.20 | 6000 | 2.6 | 90 | 1500 / 3400 / 6800 | -16 | frost chip 5 |
| 11 | Hot vent crust | 0.80 | 0.25 | 3400 | 1.8 | 70 | 700 / 1900 / 3900 | -15 | ember 6 + steam |

Per-step randomization (mandatory, prevents machine-gun perception):

| Parameter | Jitter |
|---|---|
| Pitch (playback rate of the whole synth) | +/- 7 % (uniform) |
| Gain | +/- 2.5 dB |
| Noise centre frequency | +/- 12 % |
| Decay | +/- 15 % |
| Left/right pan | +/- 0.18, alternating with step parity |

Speed and stance scaling: `gain_dB += 20*log10(clamp(speed/2.6, 0.35, 1.9))`, and
crouch subtracts a further 7 dB and lowpasses at 2.2 kHz.

Material is resolved from the ground raycast hit: the terrain system must expose
`materialId` (u8) per triangle/voxel-face; the vessel and base expose `materialId`
per mesh. If unavailable, default to id 3 (basalt).

### 05.2.8 Land traversal on the safe start island

Binding constraint from the client brief: the start island and the shallow reef
inside radius 260 m of the spawn anchor contain ZERO hostile entities and ZERO
environmental damage sources. Concretely, on the start island:

- No slope in the walkable playspace exceeds 47 deg without an alternate route.
- No fall exceeding 2.2 m exists inside the spawn playspace (i.e. fall damage
  cannot trigger).
- Maximum reachable water depth inside the 260 m safe radius is 9.0 m, which is
  survivable on the T0 cylinder with >60 s of margin.
- The vessel pad is within 46 m of the spawn anchor, on flat ground (< 6 deg).

---

## 05.3 SWIMMING - 6-DOF MODEL

### 05.3.1 Overview

Underwater the player is a rigid body with 3 translational DOF (full) and 3
rotational DOF (pitch and yaw from mouse, roll manual with auto-level). The body
is NOT a character controller underwater; it is force-integrated. Collision is
resolved by sweeping the vertical capsule (see 05.1.1) and applying restitution
0.05 with tangential friction 0.35.

Forces summed each substep:

```
F_total = F_gravity + F_buoyancy + F_drag + F_thrust + F_current + F_contact
a = F_total / (m + m_added)      // m_added is direction-dependent, 05.3.5
```

### 05.3.2 Buoyancy

```js
function buoyantForce(d, tier, ballastN) {
  const rho = 1031.0 + 0.0045 * Math.max(0, d);
  const V = V_BODY + foamVolume(d, tier) + V_RIGID_GEAR + V_PAYLOAD;
  return rho * 9.40 * V - massTotal * 9.40 - ballastN;   // +N = upward
}
```

| Symbol | Value | Unit |
|---|---|---|
| `V_BODY` | 0.0776 | m^3 |
| `V_RIGID_GEAR` | 0.0021 | m^3 |
| `V_PAYLOAD` | 0.0004 per kg carried | m^3 |
| `ballastN` | 0 .. 56 (adjustable, 8 N steps, 8 settings) | N downward |

Net buoyancy with the default trim (ballast = 8 N, S0 suit, empty inventory):

| Depth (m) | Foam vol (m^3) | Net buoyancy (N) | Vertical accel if unpowered (m/s^2) |
|---|---|---|---|
| 0 | 0.00920 | +44.6 | +0.51 up |
| 5 | 0.00762 | +28.7 | +0.33 up |
| 10 | 0.00650 | +17.4 | +0.20 up |
| 15 | 0.00566 | +8.9 | +0.10 up |
| 18.5 | 0.00519 | 0.0 | NEUTRAL |
| 30 | 0.00405 | -12.7 | -0.15 down |
| 60 | 0.00243 | -29.1 | -0.33 down |
| 100 | 0.00159 | -37.4 | -0.43 down |
| 200 | 0.00084 | -44.5 | -0.51 down |
| 400 | 0.00043 | -47.8 | -0.55 down |
| 1000 | 0.00017 | -49.5 | -0.57 down |

Design intent, and it is REAL: descending gets progressively easier and ascending
progressively harder as the suit foam crushes. The unpowered sink terminal
velocity at 400 m with `CdA = 0.22` (belly-down) is `sqrt(2*47.8/(1031*0.22)) =
0.65 m/s` - slow enough that you never "fall" to your death, fast enough that
losing power is genuinely frightening.

The neutral-buoyancy depth is printed on the wrist display (`TRIM 18.5`), and the
ballast setting is changeable only at a base anchor or inside the vessel - never
mid-dive. Higher suit tiers use less compressible syntactic foam (05.4.2), which
flattens the curve; the S4 suit has a neutral depth of 240 m.

### 05.3.3 Thrust

Thrust is applied along the CAMERA forward axis (view-relative swimming), with
separate world-vertical thrust from the ascend/descend keys.

| Source | Force (N) | Notes |
|---|---|---|
| Cruise stroke, forward | 92 | mean over the stroke cycle |
| Cruise stroke, lateral | 51 (0.55x) | |
| Cruise stroke, backward | 39 (0.42x) | |
| Sprint (finning burst), forward | 210 | requires stamina |
| Vertical (ascend / descend key) | 57 (0.62x) | world +Y / -Y, additive |
| Ascend assist while `TREADING` | 40 | keeps head above chop |

Fin tier multipliers (multiply forward and vertical thrust; lateral separately):

| Fin tier | Name | Fwd/Vert mult | Lateral mult | Sprint stamina mult | Mass (kg) |
|---|---|---|---|---|---|
| F0 | Bare feet (boots) | 0.78 | 1.00 | 1.25 | 0.0 |
| F1 | Standard fins | 1.00 | 1.00 | 1.00 | 1.1 |
| F2 | Long-blade fins | 1.34 | 0.86 | 0.92 | 1.6 |
| F3 | Monofin sheath | 1.62 | 0.62 | 0.84 | 2.2 |

Resulting steady-state speeds (streamlined, `CdA = 0.075`, rho 1031):

| Fin | Cruise fwd (m/s) | Sprint fwd (m/s) | Cruise lateral (m/s) |
|---|---|---|---|
| F0 | 1.36 | 2.06 | 1.06 |
| F1 | 1.54 | 2.33 | 1.15 |
| F2 | 1.79 | 2.70 | 1.24 |
| F3 | 1.96 | 2.97 | 1.06 |

`v_terminal = sqrt(2*F / (rho * CdA))`.

**Stroke pulsing.** Thrust is not constant; it pulses, and the camera surges with
it. This single detail is what makes swimming feel like swimming.

```js
// f_stroke: 0.82 Hz cruise, 1.55 Hz sprint
const s = Math.sin(2 * Math.PI * f_stroke * t);
const pulse = 0.34 + 1.62 * Math.pow(Math.max(0, s), 1.35);   // mean ~1.0, peak 1.96
const F = F_mean * pulse * finMult;
```

Camera surge (see 05.3.7) and the arm animation are phase-locked to the same `t`.

### 05.3.4 Drag

Quadratic drag with an ORIENTATION-DEPENDENT drag area. The player's drag area is
computed from the angle between the velocity vector and the body's long axis
(which underwater is the camera forward axis, because the avatar aligns with the
view).

| Posture | `CdA` (m^2) | When |
|---|---|---|
| Streamlined (velocity within 20 deg of body axis) | 0.075 | swimming forward |
| Oblique | interpolated | 20-70 deg |
| Broadside (velocity perpendicular to body axis) | 0.340 | strafing, sinking flat |
| Upright treading | 0.290 | `TREADING` |
| Surface swimming (wave-making drag added) | 0.110 | `TREADING` moving |
| Braced (crouch key underwater = flare) | 0.520 | active brake |

```js
const cosA = Math.abs(dot(normalize(vel), bodyForward));
const CdA = mix(CDA_BROAD, CDA_STREAM, smoothstep(0.34, 0.94, cosA));  // 0.34 = cos70, 0.94 = cos20
const F_drag = -normalize(vel) * 0.5 * rho * CdA * vel.lengthSq();
```

Low-speed linear drag term to avoid jitter near zero: add
`-vel * 6.0 * (m/87)` N per (m/s) when `|vel| < 0.25 m/s`.

The "flare/brake" posture (hold Crouch underwater) raises `CdA` to 0.520 and cuts
thrust to 0. From 2.33 m/s this stops the player in 1.05 s over 1.18 m. This is
the standard way to stop before a wall or to hover for scanning.

### 05.3.5 Added mass

Water accelerated with the body. Direction-dependent, applied as an effective mass
increase per axis in the body frame.

| Axis (body frame) | Added mass coefficient | Added mass (kg) at V=0.089 m^3 |
|---|---|---|
| Surge (forward/back) | 0.16 * rho * V | 14.7 |
| Sway (lateral) | 0.62 * rho * V | 56.9 |
| Heave (up/down) | 0.55 * rho * V | 50.5 |

Implementation: transform `F_total` into body frame, divide componentwise by
`(m + m_added_axis)`, transform the resulting acceleration back to world. This
makes lateral and vertical movement feel appropriately heavy compared to forward
movement without any hand-tuned fudge factors.

### 05.3.6 Rotation

| Property | Value |
|---|---|
| Yaw | direct from mouse X, no inertia (feels responsive) |
| Pitch | direct from mouse Y, clamped -90 to +90 deg |
| Roll (manual) | Q / E keys, angular accel 3.2 rad/s^2, max rate 1.9 rad/s |
| Roll auto-level rate | 1.6 rad/s toward horizon, engaged when no roll input for 0.35 s |
| Roll auto-level deadzone | 3 deg |
| Roll auto-level disable | Settings: `freeRoll` (default OFF) |
| Body-follows-camera lag | tau = 0.16 s exponential (for the shadow proxy and third-party visibility, camera itself is not lagged) |
| Roll while `TREADING` / `WADING` | forced to 0, blended over 0.5 s |

At pitch = +/-90 deg exactly, yaw becomes ill-defined. Store orientation as a
QUATERNION, not Euler angles. Mouse input applies incremental rotations about the
current body right and body up axes:

```js
q = q * quatFromAxisAngle(BODY_RIGHT, -dyaw_pitch)   // pitch about local right
q = q * quatFromAxisAngle(BODY_UP,    -dyaw)         // yaw about local up (NOT world up, underwater)
q = normalize(q)
```

On land, yaw is about WORLD up. Underwater, yaw about BODY up. The crossfade
happens over the water-entry transition (05.4.1) and is the reason 6-DOF swimming
feels free while walking stays grounded.

### 05.3.7 Camera surge and swim breathing motion

Additive camera offsets while `SWIM_FREE`, all scaled by `cameraMotion/100`:

| Effect | Amplitude | Frequency | Notes |
|---|---|---|---|
| Stroke surge (forward/back) | 0.028 m | f_stroke | phase-locked to thrust pulse |
| Stroke rise (vertical) | 0.019 m | f_stroke | 90 deg out of phase |
| Stroke roll | 0.9 deg | f_stroke * 0.5 | alternating |
| Idle breathing rise | 0.011 m | breath rate (05.5.7) | present even at zero thrust |
| Idle breathing roll | 0.35 deg | breath rate | |
| Turbulence (near vents/currents) | 0.0 - 0.045 m | 0.7-3.1 Hz noise | driven by the current field |

### 05.3.8 Stamina

Stamina is a single 0-100 pool shared by land sprint and swim sprint.

| Event | Rate | Notes |
|---|---|---|
| Swim sprint drain | 14.0 / s | multiplied by fin `sprintStaminaMult` |
| Land sprint drain | 6.0 / s | |
| Propulsion gun (held) | 0 / s | powered by battery, not stamina |
| Struggle out of entangle | 9.0 per mash | |
| Regen delay after last drain | 1.20 s | |
| Regen rate | 9.0 / s | |
| Regen rate while `TREADING` at surface | 12.0 / s | breathing freely |
| Minimum stamina to START a sprint | 12.0 | prevents stutter-sprinting |
| Exhausted state | stamina = 0 -> sprint locked until stamina >= 25 | |
| Chill penalty (05.6.3) | regen * (1 - 0.5 * chillNorm) | |
| Regen inside vessel | 22.0 / s | |

Sprint at F1 fins: 100 stamina / 14.0 = 7.14 s of continuous burst, covering
`2.33 * 7.14 = 16.6 m`. Full recovery from empty: 1.2 + 100/9 = 12.3 s. These are
the numbers the creature-chase designers must budget against.

### 05.3.9 Currents

The player is subject to the world current field `C(p, t)` (owned by the ocean
section) as a moving reference frame for drag:

```js
const relVel = vel - current;
F_drag = -normalize(relVel) * 0.5 * rho * CdA * relVel.lengthSq();
```

Current magnitudes the player systems are tuned against: 0.0-0.35 m/s ambient,
0.8-1.6 m/s in canyon channels, 2.2-3.4 m/s in vent updrafts and tidal gates.
A 3.0 m/s current exceeds sprint speed - that is intentional; those channels are
one-way doors and must be signposted with particle streamers and a rising
low-frequency rumble (28-60 Hz) 25 m before entry.

---

## 05.4 TRANSITIONS

### 05.4.1 Water entry and exit

`submergence` scalar drives every crossfade. It is the fraction of the CAPSULE
below the local water surface height `h(x,z,t)`:

```js
const feetY = pos.y - 0.90, headY = pos.y + 0.90;      // capsule half-height 0.90
const surf = oceanHeight(pos.x, pos.z, time);          // includes waves
submergence = clamp((surf - feetY) / 1.80, 0, 1);
eyeSubmerged = (surf > pos.y + 0.755);                 // eye at +0.755 from centre
```

State selection with hysteresis (0.12 m band on the eye test, 0.05 on submergence):

| Condition | State |
|---|---|
| `submergence < 0.02` and grounded | `GROUNDED` |
| `0.02 <= submergence < 0.90` and grounded | `WADING` |
| not grounded and `eyeSubmerged == false` and `submergence > 0.45` | `TREADING` |
| not grounded and `eyeSubmerged == true` | `SWIM_FREE` |
| `submergence < 0.45` and not grounded | `AIRBORNE` |

Transition effects (all times in seconds):

| Effect | Enter water | Exit water |
|---|---|---|
| FOV crossfade (62 -> 53.3 deg at blend 0.65) | 0.42 | 0.42 |
| Audio lowpass on master (20 kHz -> 900 Hz, Q 0.7) | 0.20 | 0.28 |
| Audio highpass on master (0 -> 55 Hz) | 0.20 | 0.28 |
| Reverb send to `UNDERWATER_VERB` | 0.30 | 0.35 |
| Mask vignette fade in/out | 0.35 | 0.30 |
| Screen droplets (exit only) | - | spawn 18-34, evaporate over 6.0 |
| Splash particles | 40 + 12*impactSpeed | 22 |
| Splash SFX | synthesized noise burst, 180-4800 Hz, 0.9 s tail | 0.6 s |
| Yaw reference change (world-up -> body-up) | 0.50 | 0.50 |
| Water surface shader "pierce" ring | 0.6 s expanding ring r 0.4 -> 3.2 m | same |

Entering water at speed > 6 m/s produces a plunge: 1.2 s of dense bubble curtain
(120-260 bubbles), momentum retained with `CdA = 0.20` (feet-first) so a 14 m/s
dive penetrates about 5.8 m before slowing to 1 m/s.

### 05.4.2 Suit tiers (referenced by buoyancy, thermal and pressure)

| Tier | Name | Foam V0 (m^3) | Crush depth (m) | Insulation R | Mass (kg) | Notes |
|---|---|---|---|---|---|---|
| S0 | Dive skin | 0.00920 | 120 | 0.16 | 4.2 | starting gear |
| S1 | Reinforced wetsuit | 0.01180 | 380 | 0.34 | 6.8 | |
| S2 | Composite drysuit | 0.00640 | 900 | 0.61 | 9.5 | low-compression |
| S3 | Ceramic-laminate suit | 0.00310 | 1800 | 0.78 | 13.4 | |
| S4 | Syntactic-foam hardsuit | 0.00180 | 3400 | 0.94 | 19.0 | near-incompressible |

`Insulation R` is used in 05.6.3. Foam V0 falling at higher tiers is deliberate:
better suits use syntactic foam (glass microspheres in resin) that barely
compresses, so the buoyancy curve flattens and trim becomes predictable.

### 05.4.3 Vessel entry and exit

Owned jointly with the vessel section; the player-side contract:

| Property | Value |
|---|---|
| Entry trigger volume | box 1.4 x 2.0 x 1.4 m at the hatch |
| Entry prompt range | 3.2 m (land/air), 2.6 m (underwater) |
| Entry animation | 1.15 s camera arc, bezier from current eye to seat eye, ease-in-out; skippable in Accessibility (`instantSeat`) |
| Underwater entry | additional 1.6 s airlock purge: bubbles clear from the cockpit interior, audio filter crossfades, O2 begins refilling at t=0.4 s |
| Exit while submerged | 0.9 s purge, player is placed 1.1 m outside the hatch with the vessel's velocity inherited (capped at 3.0 m/s) |
| Exit while flying | permitted above 40 m only with the "glide harness"; below that it is refused with the prompt `TOO LOW TO EGRESS` |
| Exit onto land | player placed on the nearest walkable point within 2.5 m of the hatch; if none, refused with `NO SAFE FOOTING` |
| O2 refill inside vessel | full tank in 6.0 s (see 05.5.5); player O2 does not drain while `PILOTING` |
| Player physics while `PILOTING` | frozen; capsule parented to the seat |

Anti-frustration: entry is NEVER blocked by creature proximity. There is no
"cannot board while in combat" rule. The vessel is always a refuge.

---

## 05.5 OXYGEN

### 05.5.1 Model

SUBWAVE models breathing gas physically, in LITRES OF SURFACE-EQUIVALENT FREE GAS,
not as an abstract timer. This matters because it produces the correct and
dramatic behaviour: **depth multiplies consumption**.

**Physiological justification (binding, do not "simplify" this away).** A demand
regulator delivers gas at ambient pressure. At 10.5 m the ambient pressure is 2
ata, so a 0.5 L tidal breath contains twice the gas molecules it would at the
surface. Consumption of tank gas therefore scales LINEARLY with absolute pressure.
A cylinder that lasts 100 s at the surface lasts 50 s at 10.5 m, 25 s at 31.4 m,
and 10 s at 94 m. This is exactly why real open-circuit diving is depth-limited,
and it is the single most important pressure the game puts on the player: the deep
is not reachable on foot until you change your breathing technology.

The counterpart is the closed-circuit rebreather (CCR). A CCR recirculates the
loop gas and injects only the oxygen the body METABOLISES, which is
depth-independent (roughly 0.9 L/min at rest, up to 3.0 L/min working). Switching
to CCR therefore removes the depth term entirely - a genuine, physically motivated
tech tier that transforms the game.

### 05.5.2 Consumption formula

```js
// SAC_REF = surface air consumption reference, L/min
const SAC_REF = 18.0;

function gasDrainLps(state) {
  let mult = ACTIVITY_MULT[state.activity];        // table below
  mult *= state.panic   ? 1.60 : 1.0;              // health < 35% OR damaged in last 4 s
  mult *= state.chill   ? 1.25 : 1.0;              // chill >= 40
  mult *= state.poisoned? 1.18 : 1.0;
  mult  = Math.min(mult, 3.20);                    // hard cap

  const depthTerm = state.rebreather ? 1.0 : ata(state.depth);
  return (SAC_REF / 60.0) * mult * depthTerm;      // L of surface-equivalent gas per second
}
```

| Activity | Multiplier | Effective SAC (L/min) | Applies when |
|---|---|---|---|
| Held breath / `ANCHOR_REST` | 0.00 | 0.0 | no drain |
| On land, above water | 0.00 | 0.0 | ambient air is breathable |
| Inside vessel (`PILOTING`) | 0.00 | 0.0 | vessel recycler |
| Idle submerged (no input) | 1.00 | 18.0 | |
| `TREADING` (surface, mouth clear) | 0.00 | 0.0 | refills instead, 05.5.5 |
| Swim cruise | 1.35 | 24.3 | any thrust input |
| Sprint / finning burst | 2.20 | 39.6 | |
| Propulsion gun tow | 1.10 | 19.8 | less work than finning |
| Cutting / mining (handheld) | 1.45 | 26.1 | |
| Struggling (entangled/grabbed) | 2.60 | 46.8 | |

Multipliers combine multiplicatively with the status modifiers and are then capped
at 3.20 (i.e. 57.6 L/min - a realistic maximum for a panicking working diver).

### 05.5.3 Cylinder and rebreather tiers

| ID | Name | Water vol (L) | Fill (bar) | Free gas (L) | Mass charged (kg) | Depth-dep? |
|---|---|---|---|---|---|---|
| T0 | Bail-out cylinder | 0.232 | 207 | 48 | 1.1 | YES |
| T1 | Compact cylinder | 0.630 | 207 | 130 | 2.6 | YES |
| T2 | Twin compact set | 1.550 | 207 | 320 | 6.2 | YES |
| T3 | HP composite cylinder | 2.130 | 300 | 640 | 9.4 | YES |
| T4 | HP composite twinset | 4.260 | 300 | 1280 | 18.1 | YES |
| R1 | Closed-circuit rebreather | O2 bottle 0.8 L @ 200 bar | - | 160 L O2 | 11.2 | **NO** |
| R2 | Extended-scrubber CCR | O2 bottle 1.6 L @ 200 bar | - | 320 L O2 | 15.6 | **NO** |

Free gas = `waterVol * fillBar` (ideal-gas approximation; the compressibility
correction at 300 bar is about -6%, which is applied as a flat 0.94 factor for T3
and T4 - the numbers in the table already include it).

**Rebreather specifics.** R1/R2 consume metabolic O2 only:

```js
const VO2_LPM = 0.90 * activityMult;    // 0.90 rest, 1.22 cruise, 1.98 sprint, 2.34 struggle
// depth-INDEPENDENT
```
R1 duration at cruise: 160 / 1.22 = 131 min. The real limit is the CO2 SCRUBBER:

| Rebreather | Scrubber duration | Warning at | Failure behaviour |
|---|---|---|---|
| R1 | 3600 s (60 min) of submerged time | 600 s remaining | CO2 breakthrough: see below |
| R2 | 7200 s (120 min) | 900 s remaining | same |

Scrubber time counts down only while `SWIM_FREE`/`TREADING` submerged, pauses
inside the vessel, and is replaced (free, instant) at any base anchor or in the
vessel's fabricator bay. CO2 breakthrough is a distinct, terrifying failure mode:
at 0 s remaining the player begins accumulating hypercapnia - breathing rate
doubles, screen edges pulse red at the breath rate, mouse sensitivity drifts
+/-8%, and HP drains at 3.0/s. There is no gas-gauge warning because the loop is
still full; the ONLY warning is the timer and the physiological symptoms. This is
correct and is a deliberate, signposted trade: the CCR removes depth pressure and
replaces it with a hard clock.

### 05.5.4 Endurance tables

Time to empty in seconds, from full, by activity and depth. Open circuit,
`SAC_REF = 18.0 L/min`, no status multipliers.

**T0 bail-out cylinder (48 L) - the starting tier**

| Depth (m) | ata | Idle (s) | Cruise (s) | Sprint (s) |
|---|---|---|---|---|
| 0 | 1.00 | 160 | 119 | 73 |
| 5 | 1.48 | 108 | 80 | 49 |
| 10 | 1.96 | 82 | 61 | 37 |
| 20 | 2.91 | 55 | 41 | 25 |
| 30 | 3.87 | 41 | 31 | 19 |
| 50 | 5.78 | 28 | 20 | 13 |
| 100 | 10.57 | 15 | 11 | 7 |

**T1 compact (130 L)**

| Depth (m) | Idle (s) | Cruise (s) | Sprint (s) |
|---|---|---|---|
| 0 | 433 | 321 | 197 |
| 20 | 149 | 110 | 68 |
| 50 | 75 | 56 | 34 |
| 100 | 41 | 30 | 19 |
| 200 | 21 | 16 | 10 |

**T3 HP composite (640 L)**

| Depth (m) | Idle (s) | Cruise (s) | Sprint (s) |
|---|---|---|---|
| 0 | 2133 | 1580 | 970 |
| 50 | 369 | 273 | 168 |
| 100 | 202 | 150 | 92 |
| 200 | 106 | 78 | 48 |
| 400 | 55 | 40 | 25 |

**R1 rebreather (metabolic, depth-independent)** - 131 min at cruise, capped by
the 60 min scrubber. Effective endurance: **3600 s at any depth**.

Design read: at T0 you make short hops from the vessel. At T3 you can work a
100 m wreck-free reef for 2.5 minutes at a stretch. Only the rebreather makes the
abyss walkable on foot, and it costs you a hard 60-minute clock and no bubbles.

### 05.5.5 Refill sources

| Source | Rate | Notes |
|---|---|---|
| Surface (`TREADING`, mouth above water) | 6.5 % of capacity per s | full T0 in 15.4 s, full T3 in 15.4 s (percentage-based, deliberate) |
| Inside vessel | 16.7 % / s | full in 6.0 s |
| Base anchor / habitat | 25.0 % / s | full in 4.0 s |
| Air pocket (cave) | 2.3 % / s | AND drains the pocket, see below |
| Portable tank (consumable) | instant +35 L free gas | mass 0.8 kg, stack 4 |
| Vessel-mounted umbilical (within 8 m of vessel) | 4.0 % / s | requires the `TETHER` upgrade |
| Bio-bladder (harvested from `Gasbell` flora) | instant +18 L | perishable, 900 s |

**Air pockets.** Enclosed cave volumes with trapped gas. Each pocket has a finite
`gasLitres` (typical 400-3000 L) stored in the world save. Breathing from a pocket
transfers gas at the refill rate AND decrements `gasLitres` by the same
surface-equivalent amount times `ata(depth)` (the pocket is at ambient pressure).
A depleted pocket is depleted for the rest of the run; the water level in it rises
visually as it drains. Some pockets slowly replenish from vent seepage
(0.05-0.4 L/s) - these are marked with a distinctive shimmering ceiling and
`Gasbell` growth, and are the deep game's rest stops.

While in an air pocket the player is `TREADING` with a local surface height
override; audio switches to a tight, dry, small-room reverb (RT60 0.35 s) that is
one of the game's most memorable moments.

### 05.5.6 Warning escalation

All thresholds are on **estimated time remaining at the CURRENT drain rate**,
recomputed every 0.25 s and smoothed with a 1.0 s EMA to stop it flickering when
the player alternates sprint and glide:

```js
t_rem = gasLitres / gasDrainLps(state);   // seconds
```

Displaying seconds-remaining rather than a percentage is the correct choice: at
80 m the same bar level means a quarter of the time, and the player must feel that
immediately.

| Tier | Threshold `t_rem` | UI | Audio | Post-process | Haptic/other |
|---|---|---|---|---|---|
| 0 | > 60 s | Wrist O2 arc cyan `(0.35,0.92,0.78)`, numeric seconds | normal breathing 14 br/min | none | - |
| 1 | <= 60 s | Arc turns amber `(1.00,0.72,0.18)`, numeric enlarges 1.15x | single soft chime 880 Hz, 140 ms, -22 dB | none | - |
| 2 | <= 45 s | Arc pulses at 0.5 Hz | breathing 18 br/min, +3 dB, regulator hiss louder | vignette inner radius 1.00 -> 0.92 | - |
| 3 | <= 30 s | Arc red `(1.00,0.22,0.16)`, pulse 1.0 Hz; wrist display auto-raises into view for 1.2 s | breathing 24 br/min; heartbeat begins at 62 bpm, -26 dB, 52 Hz sine + 2nd harmonic | vignette 0.92 -> 0.80; saturation 1.00 -> 0.88 | subtle 0.4 deg camera tremor at 6 Hz |
| 4 | <= 20 s | Full-screen amber edge band 12 px, 1.5 Hz | heartbeat 84 bpm, -20 dB; breathing 30 br/min and audibly strained; **tank knocking**: metallic 1.8 kHz ping every 2.0 s | vignette 0.80 -> 0.66; saturation 0.88 -> 0.66; radial blur strength 0 -> 0.15 | tremor 0.8 deg at 8 Hz |
| 5 | <= 10 s | Numeric flashes 3 Hz, all other HUD elements dim to 30 % | heartbeat 112 bpm, -14 dB; knocking every 0.9 s; breathing 38 br/min | vignette 0.66 -> 0.44; saturation 0.66 -> 0.30; blur 0.15 -> 0.34; slight barrel warp 0.02 | tremor 1.4 deg at 10 Hz; sprint disabled below 6 s |
| 6 | <= 4 s | Only the O2 numeric is drawn | heartbeat 138 bpm, -10 dB, low-passed at 400 Hz (blood-in-ears); all world audio ducked -9 dB and low-passed to 700 Hz | vignette 0.44 -> 0.22; saturation 0.30 -> 0.08; blur 0.34 -> 0.55 | tremor 2.0 deg at 12 Hz |
| 7 | = 0 s | HUD replaced by `NO GAS` in red; drowning timer bar | choking synth (see below); heartbeat 150 bpm then decelerating | vignette closes to 0.10 over the drowning window; saturation to 0.0; blur to 0.80 | - |

Colour values are linear-space RGB triplets applied to the emissive wrist display
and to the HUD overlay.

**Accessibility overrides.** `photosensitiveSafe` (default OFF) clamps all flash
rates to <= 2 Hz and removes the full-screen edge band. `reducedPostFX` caps
saturation loss at 0.60 and blur at 0.15, and compensates by strengthening the
audio cues +4 dB and adding a text banner. The escalation must be fully legible
through audio alone.

Volume of the heartbeat and breathing is on a dedicated `SURVIVAL_CUES` bus that
is NOT affected by the underwater lowpass, so it stays intelligible.

### 05.5.7 Breathing audio synthesis

Fully synthesized. Inhale and exhale are separate grains.

| Grain | Source | Filter | Envelope | Extra |
|---|---|---|---|---|
| Inhale (regulator) | pink noise + 1/f | bandpass 700 Hz Q 1.1, sweeping to 1500 Hz over the grain | A 40 ms / D 0 / S 380 ms / R 90 ms | ring modulation at 63 Hz depth 0.08 for the reed rattle |
| Exhale (open circuit) | white noise | bandpass 1600 Hz Q 0.6, sweeping down to 900 Hz | A 25 ms / S 300 ms / R 200 ms | bubble burst layer (see below) |
| Exhale (rebreather) | pink noise | lowpass 420 Hz | A 60 ms / S 420 ms / R 220 ms | no bubbles, much quieter (-9 dB) |
| Bubble burst | 12-26 short sine chirps | each 900-4200 Hz, rising 18 % over 40 ms | 40 ms each, random offsets over 260 ms | this is the classic scuba sound; get it right |
| Heartbeat | 52 Hz sine + 104 Hz at -8 dB | lowpass 220 Hz | lub 90 ms, 130 ms gap, dub 70 ms | rate from the table; slight 4 % rate jitter |
| Tank knock | 1.8 kHz + 3.4 kHz + 5.9 kHz sines | bandpass, high Q 14 | 6 ms attack, 340 ms exponential decay | detuned +/- 3 % per hit |
| Choking (t_rem = 0) | filtered noise burst + throat formant pair (620 Hz, 1180 Hz) | | 3 irregular grains per 1.6 s | never gratuitous; low-mixed, -18 dB |

Breath rate drives: bubble emission (05.7.x), the camera idle rise (05.3.7), the
wrist display refresh flicker, and the exhale-driven micro-bloom of the lamp
through the bubble field.

### 05.5.8 Drowning, blackout and the last-breath grace

At `t_rem = 0` (gasLitres exhausted) the player enters DROWNING:

1. **Last-breath grace: 3.0 s.** No damage. Sprint is disabled. All post-process
   is at Tier 6 levels. The HUD shows a countdown ring. This 3 s window exists so
   that a player who is 4 m below the surface when the tank empties always makes
   it - anti-frustration guarantee AF-3.
2. **Drowning damage** begins at t = 3.0 s:

```js
// tDrown = seconds since drowning began, minus the 3.0 s grace
function drownDps(tDrown) {
  return Math.min(26.0, 4.0 + 2.6 * Math.max(0, tDrown));
}
// integral: HP lost = 4*t + 1.3*t^2  ->  100 HP at t = 7.37 s
```

Time from tank-empty to death at full health: **3.0 + 7.37 = 10.37 s**.
Time from tank-empty to death at 50 HP: 3.0 + 4.60 = 7.60 s.

3. **Recovery.** Reaching ANY refill source before HP hits 0 immediately ends
   drowning. The player coughs (2.2 s of animation-free camera judder and heavy
   breathing at 34 br/min decaying to 14 over 12 s), post-process recovers over
   4.0 s, and HP begins regenerating normally after the standard 12 s delay. There
   is no lingering penalty. Surviving is its own reward.

4. **Blackout at HP 0** (from any cause, not just drowning):

| Phase | Duration | Content |
|---|---|---|
| Fade | 1.20 s | saturation to 0, exposure -3 EV, lowpass sweep 700 -> 180 Hz, heartbeat slows 150 -> 42 bpm |
| Black | 2.50 s | full black, one distant low tone (38 Hz, -24 dB, 2.0 s), no music |
| Respawn fade-in | 1.50 s | at the respawn anchor, exposure recovers, ambient returns |
| Total | **5.20 s** | skippable to 2.4 s after the first death via any key |

During BLACKOUT the player capsule is switched to a passive float: buoyancy and
drag still apply so the body drifts realistically (this is visible in the death
cam only for 1.2 s). No ragdoll skeleton is needed; the shadow proxy is disabled.

---

## 05.6 OTHER SURVIVAL VECTORS

### 05.6.1 Health

| Property | Value |
|---|---|
| Max HP | 100 |
| Out-of-combat regen delay | 12.0 s since last damage |
| Regen rate | 1.8 HP/s |
| Regen soft cap without treatment | 70 HP |
| Regen soft cap inside vessel / at anchor | 100 HP |
| Regen rate inside vessel | 6.5 HP/s (after 3.0 s delay) |
| Medgel (consumable) | +45 HP over 3.0 s, clears bleeding, 1.4 s use animation |
| Bandage (craftable, cheap) | +12 HP instant, clears 1 bleeding stack |
| Antitoxin | clears poison, +8 HP, 2.0 s |
| Damage direction indicator | 90 deg arc at the screen edge, 1.6 s fade |
| Invulnerability after respawn | 6.0 s |
| Invulnerability after any hit | 0.45 s (i-frames, prevents multi-hit shredding) |

The 70 HP soft cap means a hurt player is nudged back to the vessel without ever
being hard-blocked, and it makes medgel meaningful without making it mandatory.

### 05.6.2 Pressure damage

The suit has a rated crush depth (05.4.2). Below it the suit and the diver's
air-filled spaces (sinuses, mask, middle ear) begin to fail.

```js
function pressureDps(depth, suitTier) {
  const rated = SUIT_CRUSH[suitTier];
  const f = (depth - rated) / rated;         // overpressure fraction
  if (f <= 0) return 0;
  return Math.min(90.0, 3.0 + 55.0 * Math.pow(f, 1.6));
}
```

Per-band table for S0 (rated 120 m), which is what the player starts with:

| Depth (m) | f | DPS | Time to death from 100 HP |
|---|---|---|---|
| 120 | 0.00 | 0.0 | - (safe) |
| 126 | 0.05 | 3.4 | 29.4 s |
| 138 | 0.15 | 6.1 | 16.4 s |
| 156 | 0.30 | 11.1 | 9.0 s |
| 180 | 0.50 | 21.0 | 4.8 s |
| 216 | 0.80 | 41.0 | 2.4 s |
| 240 | 1.00 | 58.0 | 1.7 s |
| 300+ | 1.50 | 90.0 (cap) | 1.1 s |

Warning escalation for pressure, on `depth / rated`:

| Ratio | Cue |
|---|---|
| 0.80 | Depth numeral on the wrist display turns amber. Soft suit-creak every 6-10 s (synth: bandpassed noise 210-480 Hz, 0.7 s, pitch-bent -4 %). |
| 0.90 | Numeral red and pulsing 0.7 Hz. Creaks every 3-5 s, +5 dB. First "pop" transient (impulse into a 3-band resonator at 340/810/1500 Hz). |
| 0.97 | Rising sine sweep 40 -> 90 Hz over 2 s, repeating. Mask edges show a subtle inward warp (0.015 barrel). HUD text `CRUSH DEPTH`. |
| 1.00+ | Continuous groan bed. Screen shows radial stress cracks at the vignette edge, opacity = min(1, 2*f). Damage begins. |

The suit tier is displayed permanently on the wrist as `RATED 120M`. There is no
ambiguity about where the wall is - the player is never surprised by pressure
death, only by their own greed.

### 05.6.3 Thermal - cold

Reference water temperature profile (biome sections apply an offset `dT_biome`):

```js
function waterTempC(d, dT_biome) {
  return Math.max(1.6, 2.0 + 24.5 * Math.exp(-d / 300.0)) + dT_biome;
}
```

| Depth (m) | Base temp (deg C) |
|---|---|
| 0 | 26.5 |
| 25 | 24.6 |
| 50 | 22.8 |
| 100 | 19.6 |
| 200 | 14.6 |
| 300 | 11.0 |
| 500 | 6.6 |
| 800 | 3.7 |
| 1200 | 2.4 |
| 2000+ | 1.6 |

Chill accumulator, 0-100:

```js
// R = suit insulation (05.4.2), plus +0.22 if the vessel heater ran in the last 60 s
const T_COMFORT = 30.0;                      // deg C: water below this cools a human
const drive = Math.max(0, T_COMFORT - waterTemp) / T_COMFORT;   // 0..1
const shed  = 1.0 / (0.28 + R);              // heat loss factor
chillRate = 3.4 * drive * shed * exertionFactor;   // units per second
// exertionFactor: 0.85 sprinting (muscle heat), 1.00 cruising, 1.20 idle
warmRate  = 11.0 (in vessel) | 8.0 (at anchor) | 2.2 (above water, air > 15 C) | 0 otherwise
chill = clamp(chill + (submerged ? chillRate : -warmRate) * dt, 0, 100);
```

Worked example: S0 suit (R = 0.16) at 200 m (14.6 C), cruising:
`drive = (30-14.6)/30 = 0.513`, `shed = 1/0.44 = 2.27`,
`chillRate = 3.4*0.513*2.27*1.0 = 3.96 /s` -> chill 100 in 25 s. The S0 suit is
NOT a deep suit and the game says so loudly.
S3 suit (R = 0.78) at 800 m (3.7 C): `drive = 0.877`, `shed = 1/1.06 = 0.943`,
`chillRate = 2.81 /s` -> 36 s. S4 (R = 0.94) at the same depth: 2.55 /s.
Conclusion, and it is intended: even the best suit cannot loiter in the abyss.
The vessel is the only way to live down there.

Chill effects:

| Chill | Effect |
|---|---|
| >= 25 | Fine shiver camera tremor 0.15 deg at 9 Hz. Breath grains gain a shudder. |
| >= 40 | Stamina regen x0.50. Gas drain x1.25 (`state.chill` flag). Frost crystals begin creeping in from the mask vignette edge (procedural Voronoi growth, coverage = (chill-40)/60 * 0.55). |
| >= 60 | Stamina max reduced to 65. Tool use animation speed x0.85. Interaction range -0.4 m (clumsy hands). |
| >= 80 | HP drain 0.45 HP/s. Mouse sensitivity drifts +/-5 % at 0.2 Hz. |
| = 100 | HP drain 1.6 HP/s. Peripheral vision desaturates fully; only the centre 40 % keeps colour. |

Chill decays to 0 in 9.1 s inside the vessel from 100. Recovering is fast on
purpose; the punishment is the dive, not the aftermath.

### 05.6.4 Thermal - heat

Hydrothermal vents. The vent field owner supplies a plume volume with a temperature
field `T_plume(p, t)`.

| Zone | Water temp (deg C) | Effect |
|---|---|---|
| Outer halo (r 12-25 m of a black smoker) | 30 - 48 | Chill drains at 6.0/s. Safe. Shimmer refraction post-fx. This is a genuine rest stop. |
| Warm shell (r 5-12 m) | 48 - 90 | 0 HP/s but suit integrity warning. Camera shimmer 2x. Above 70 C: 1.2 HP/s. |
| Scald zone (r 2-5 m) | 90 - 180 | 14 HP/s + `BURN` DoT 5 HP/s for 4.0 s. Screen flashes white-orange, exposure +1.4 EV for 0.3 s. |
| Vent throat (r < 2 m) | 180 - 340 | 46 HP/s + `BURN` 8 HP/s for 6.0 s. Suit integrity permanently reduced 1 tier until repaired. |

Vent plumes are BUOYANT and move: the hazard volume is advected upward at
0.9-2.4 m/s and bent by the current field. It is legible from far away (shimmering
column, rising particulates, a 22-70 Hz rumble with a 0.4 Hz amplitude wobble) and
lethal only if you swim into it. Vents are also the primary source of several ores
and of the only reliable deep warmth - risk/reward, not a trap.

Above-water heat: the start island and equatorial deserts reach 41 C at midday.
No damage, but chill warms at 3.4/s and a heat shimmer post-fx runs. Cold-biome
surface (polar): air -18 C, chill accrues at 1.1/s even out of water.

### 05.6.5 Inert gas loading (decompression) - OPTIONAL DIFFICULTY LAYER

Present at the `Realistic` difficulty preset, OFF at `Explorer` (default).
Single-compartment, game-accelerated.

```js
const HALFTIME = 75.0;                      // seconds (real fast tissues are ~5 min; accelerated)
const k = Math.LN2 / HALFTIME;
// Pi = inert gas partial pressure in tissue (ata), Pamb = ambient (ata)
Pi += (0.79 * ata(depth) - Pi) * (1 - Math.exp(-k * dt));
const ratio = Pi / (0.79 * ata(depth));     // supersaturation ratio
```

| Condition | Effect |
|---|---|
| `ratio <= 1.60` | Safe. Wrist shows a small `N2` bar. |
| `1.60 < ratio <= 1.95` | Amber. Joint-ache audio (a dull 90 Hz throb) and 0.9 HP/s. |
| `ratio > 1.95` | Red. 2.5 HP/s, camera micro-jitter, HUD text `ASCEND SLOWLY`. |
| Active only below | 45 m. Above 45 m the term is clamped off entirely. |
| Removed by | R1/R2 rebreather running heliox (no narcotic/no significant N2 load), OR by a 25 s hold at any depth within 8 m of the current ceiling |

The HUD shows a **ceiling depth** (the shallowest depth at which `ratio <= 1.60`)
as a horizontal line on the depth ribbon. Ascending to it and waiting clears the
obligation. This must never be able to kill a player who is watching the HUD: the
maximum obligation from any single dive is capped at 55 s of hold time.

### 05.6.6 Nitrogen narcosis - always on, open circuit only

Below 32 m on open-circuit air the player experiences narcosis. This is real
(0.3-0.4 bar of nitrogen partial pressure above ambient starts to impair), it is
free atmosphere, and it is one of the best tools SUBWAVE has for making the deep
feel wrong.

```js
const narcosis = clamp((depth - 32.0) / 78.0, 0, 1);   // full at 110 m
```

| Effect | Scaling |
|---|---|
| Input latency added | `narcosis * 150 ms` (a low-pass on the input vector, NOT a dropped-frame stall) |
| Mouse sensitivity drift | `+/- narcosis * 9 %` oscillating at 0.13 Hz |
| Wrist display text jitter | characters shift +/- `narcosis * 1.4` px and occasionally render the wrong glyph for 1 frame (max 1 glyph per 2 s) |
| Audio | a slow chorus/detune on the ambient bed, depth `narcosis * 14 cents`, rate 0.21 Hz; a faint tinnitus tone at 6.2 kHz, gain `-46 + narcosis*14` dB |
| Colour | slight hue rotation `narcosis * 6 deg` and a bloom threshold drop of `narcosis * 0.25` - lights smear |
| Vignette | breathing in and out at the breath rate with amplitude `narcosis * 0.05` |
| Removed by | any rebreather (R1/R2 run trimix) - instantly, over a 2.0 s blend |

Narcosis causes NO damage and never takes control away. It degrades trust in the
instruments. That is the point.

### 05.6.7 Status effects

| ID | Name | Trigger | Duration | Stacks | Effects | Cure |
|---|---|---|---|---|---|---|
| ST_BLEED | Bleeding | Piercing/slashing damage >= 12 HP | 22.0 s per stack | up to 4 | 1.2 HP/s per stack. **Scent plume**: predator detection radius vs the player goes from 90 m to `90 + 32*stacks` m (max 218 m) and predators route to the plume. A visible red-brown particle trail follows the player for 6 s. | Bandage, medgel, or leaving water for 8 s |
| ST_STUN | Stunned | Heavy impact, electric discharge, some creature slams | 0.9 - 2.2 s | no | Input locked. Camera shake 2.6 deg at 14 Hz decaying. Audio ducked -8 dB, lowpass 900 Hz. Tools holstered. | time only |
| ST_POISON | Poisoned | Venomous spines, toxic algae blooms | 14.0 s | up to 3 (duration refreshes, DPS adds) | 2.0 HP/s per stack. Gas drain x1.18. Green-shift `(0.86,1.06,0.90)` colour grade. Slight double-vision (0.004 screen-space offset on a second sample). | Antitoxin |
| ST_BLIND | Blinded | Ink cloud, bioluminescent flash defence, vent flash | 3.5 s (ink), 1.8 s (flash) | no | Ink: an opaque screen-space cloud with a 1.2 s dissolve. Flash: exposure +4 EV then a 2.2 s eye-adaptation recovery with an afterimage (inverted, 0.35 opacity, decaying). HUD stays legible (it is on the wrist, inside the ink). | time |
| ST_ENTANGLE | Entangled | Kelp forests, siphon-weed, grabbing creatures | until escaped, max 12 s | no | Movement x0.15, rotation x0.40, thrust x0.20. Escape by alternating A/D or mashing Interact: each input contributes 9.0 stamina worth of progress, need 45. Gas drain x2.60. | struggle, cutter, or the creature releasing |
| ST_CONCUSS | Concussed | Fall stagger, heavy impact | 6.0 s | no | Depth-of-field blur 0.35 pulled to 1.2 m, audio lowpass 1.4 kHz with a 3.2 kHz ringing tone at -30 dB decaying, +8 % mouse smoothing. | time, medgel halves it |
| ST_BURN | Burned | Vent contact | 4.0 - 6.0 s | no | 5 - 8 HP/s. Orange rim on the vignette. Steam particles from the suit for 3 s after leaving. | time, medgel clears |
| ST_HYPERCAP | Hypercapnia | CCR scrubber exhausted | until surfaced/scrubber replaced | no | 3.0 HP/s, breath rate x2, red pulse at breath rate, mouse drift +/-8 % | replace scrubber / leave water |

**Bleeding is the most important status effect in the game.** It is the mechanical
link between "I got hurt" and "now the dark has teeth". Its cue set must be
unmissable: the trail, a distinctive wet low thump on the heartbeat bus, and the
wrist display flashing `BLOOD` in red. And it must be cheaply curable - bandages
are craftable from the most common flora in the game. The intended loop is
"panic, patch, keep moving", not "die because you did not have the right item".

---

## 05.7 HANDHELD TOOLS

### 05.7.1 General rules

| Rule | Value |
|---|---|
| Tool slots on the quick bar | 5 (keys 1-5), plus holster (key 6 / Q double-tap) |
| Only one tool in hand at a time | yes; the left hand may hold a secondary light source |
| Equip time | per tool, 0.28 - 0.55 s |
| Unequip time | 0.75x of equip |
| Swap while using | queued; the current use completes or is cancelled at a safe frame |
| Tools function identically in air and water | yes, except where noted (the cutter is slower in air; the propulsion gun is inert in air) |
| Battery cells | shared item type; hot-swappable in 1.6 s with a spare |
| Tool durability | none. Tools never break. (Anti-frustration AF-6.) |
| Tools are dropped on death | never. (AF-1.) |

Battery cells:

| Cell | Capacity (Wh) | Capacity (J) | Mass (kg) | Recharge |
|---|---|---|---|---|
| PC-1 (standard) | 18.0 | 64 800 | 0.42 | vessel/base charger, 90 s to full |
| PC-2 (dense) | 54.0 | 194 400 | 0.95 | 180 s to full |
| PC-3 (thermal-cell, vent-charged) | 54.0 | 194 400 | 1.10 | self-charges 4.5 W in water > 45 C |

A tool with no charge still equips, still animates, and clicks - it does not
vanish from the bar. The wrist display shows `CELL 0%`.

### 05.7.2 Tool table (summary)

| # | Tool | Power draw | Runtime on PC-1 | Range | Cooldown | Mass | Equip (s) |
|---|---|---|---|---|---|---|---|
| 1 | Scanner | 4.0 W active, 0.2 W idle | 4.5 h active | 12.0 m | 0.35 s | 0.6 | 0.32 |
| 2 | Cutter | 220 W cutting | 295 s | 1.6 m | - | 1.9 | 0.42 |
| 3 | Lamp (handheld) | 9.5 W | 1.89 h | 34 m beam | - | 0.7 | 0.28 |
| 4 | Propulsion gun | 140 W full throttle | 463 s | thrust only | - | 3.4 | 0.55 |
| 5 | Repair tool | 95 W | 682 s | 2.2 m | - | 1.5 | 0.40 |
| 6 | Beacon dispenser | 0.4 W idle | - | place at 4 m | 1.2 s | 0.5 + 0.22/beacon | 0.30 |
| 7 | Pulse emitter | 648 J per pulse | 100 pulses | 6.0 m cone | 3.2 s | 1.7 | 0.36 |

### 05.7.3 Scanner

**Purpose.** The primary knowledge verb. Scanning a creature, plant, mineral or
geological feature adds its entry to the codex, reveals its numeric properties on
the HUD, and unlocks crafting recipes derived from it. It is also how the player
finds ore veins through rock.

**Procedural model.** A flattened wedge, 0.19 x 0.11 x 0.045 m, generated by
lofting a 6-vertex rounded-rectangle profile along a 5-station spine with a slight
taper (scale 1.0 -> 0.82) and a 7 deg downward bend at station 4. Front face
carries a recessed 0.06 x 0.038 m emissive panel (the scan display, an offscreen
64x40 texture) at inset depth 0.004 m. A ring of 6 emitter lenses (icosphere r
0.005, 1 subdivision) sits around the panel. Grip: an extruded hexagonal prism
(0.032 m across flats, 0.085 m long) with 9 procedural knurl grooves cut as a
periodic radial displacement (amplitude 0.0008 m, 24 per revolution). Total: 1 240
triangles. Material: dark polymer, base colour `(0.09,0.10,0.11)`, roughness 0.55,
plus emissive `(0.20,0.85,0.72)` at 4.0 nits equivalent on the lenses.

| Property | Value |
|---|---|
| Max range | 12.0 m (surface), 9.0 m in silt/low visibility |
| Cone half-angle for target acquisition | 6 deg |
| Through-rock ore detection range | 6.5 m (a separate spherical query, always on while equipped) |
| Scan hold time (small flora) | 2.4 s |
| Scan hold time (fish, small fauna) | 3.6 s |
| Scan hold time (large fauna) | 6.5 s |
| Scan hold time (mineral outcrop) | 2.0 s |
| Scan hold time (geological feature / landmark) | 9.0 s |
| Fragments needed for a recipe unlock | 1 - 4 depending on the recipe (owned by the crafting section) |
| Power | 4.0 W while scanning, 0.2 W idle |
| Re-scan of a known target | 0.6 s, yields no new data, shows live vitals |
| Movement tolerance | target may move up to 1.8 m/s; beyond that the scan aborts with a descending 3-note motif |
| Cooldown | 0.35 s |

Scan beam VFX: a 6-strand helical line from the emitter ring to the target hit
point, radius 0.02 m, each strand a screen-facing quad strip with an animated
scrolling gradient (period 0.4 s). On completion, a wireframe overlay of the
target's silhouette (derived from its depth+normal buffer footprint via a 3-tap
edge detect) sweeps top-to-bottom over 0.55 s in `(0.25,0.95,0.80)`.

Audio: a 3.1 kHz carrier amplitude-modulated at `18 + 24*progress` Hz, gain -28 dB,
plus a per-second "tick" at 1.4 kHz. Completion: a rising major triad
(D5-F#5-A5 = 587/740/880 Hz), 0.42 s, -18 dB.

First-person animation: idle sway amplitude 0.010 m, arm raise 0.055 m over 0.32 s
on equip. While scanning, the tool rises to 0.03 m above the idle pose and a 0.6
deg tremor at 3 Hz is added (the player is holding it steady).

### 05.7.4 Cutter (handheld cutting/mining tool)

**Purpose.** Removes terrain voxels, harvests ore from outcrops, cuts entangling
flora, and opens sealed geological formations. It is a plasma-arc cutter: a short,
extremely hot, extremely short-range arc.

**HARD RULE (binding).** The cutter cannot be used on any entity tagged `FAUNA`.
If the raycast hits a fauna collider, the arc extinguishes with a distinctive
warble and the wrist display prints `SAFETY LOCK`. There is no override, no
upgrade that removes it, and no achievement that requires it. Predators in SUBWAVE
are repelled, not butchered.

**Procedural model.** A pistol-form tool. Body: a lathe of an 11-point profile
(max radius 0.036 m) over 0.21 m, with a boolean-subtracted vent slot array (5
slots, 0.008 x 0.052 m) on the upper surface. Emitter: a 12-sided truncated cone,
base r 0.028 m, tip r 0.009 m, length 0.062 m, in a lighter metal. Two 0.004 m
tungsten-analogue electrodes protrude 0.018 m from the tip, converging to 0.011 m
apart. Grip: a swept quad strip following a 3-point spline with a 22 deg rake,
cross-section a 0.028 x 0.042 m rounded rect. Trigger: a 0.018 x 0.006 x 0.030 m
box on a hinge, rotating 14 deg on use. Total: 2 180 triangles.

| Property | Value |
|---|---|
| Effective range | 1.6 m (0.9 m in air - the arc is stabilised by the water) |
| Beam radius at the hit point | 0.11 m |
| Voxel removal rate | 0.055 m^3 / s in soft rock |
| Hardness scaling | rate / hardness, where hardness: silt 0.3, sandstone 0.7, basalt 1.0, quartzite 1.8, abyssal glass 3.2, vent-cap 4.6 |
| Ore yield | ore nodes carry `yieldUnits`; the cutter releases 1 unit per `0.9 * hardness` seconds of contact |
| Power draw | 220 W while the trigger is held |
| Runtime | 295 s of cutting on PC-1, 884 s on PC-2 |
| Heat | tool heat 0-100, +18/s cutting, -26/s idle; at 100 it forcibly cools for 3.5 s (`THERMAL HOLD`) |
| Heat in water > 45 C | cooling rate halved |
| Spin-up | 0.22 s from trigger to full arc |
| Spin-down | 0.35 s |
| Gas drain while cutting | 1.45x (05.5.2) |

VFX: a 0.02 m radius arc core in `(1.00,0.93,0.72)` at 180 nits equivalent, a
0.06 m glow shell, 40-90 sparks/s ejected along the surface normal with 1.4-3.8 m/s
initial speed and 0.9 s lifetime. Underwater the sparks become a rising steam
column: 30 bubbles/s, radius 0.004-0.014 m, buoyant at 0.28 m/s. A 0.9 m radius
point light at 900 lm flickers at 40-60 Hz (band-limited noise, not white noise).

Audio: a sawtooth at 118 Hz through a resonant lowpass sweeping 400 -> 2600 Hz over
the 0.22 s spin-up, plus a noise layer bandpassed at 3.6 kHz Q 1.2. In water, add
a bubble-boil layer (18 chirps/s, 700-2400 Hz). Loop gain -16 dB. `THERMAL HOLD`
is a descending glissando over 0.6 s plus a relay click.

FP animation: 0.11 m of forward reach when the trigger is held, held for the
duration; 0.9 deg of wrist counter-rotation at 7 Hz (vibration); a 0.02 m recoil
kick on trigger release.

### 05.7.5 Lamp (handheld flashlight)

**Purpose.** Light. Below 180 m it is not optional. See section 03 for water
absorption; the lamp is the player's only portable defence against it.

**Procedural model.** A cylinder-and-cone torch. Barrel: lathe of a 9-point
profile, r 0.026 m, length 0.145 m, with 3 raised cooling ribs (r +0.004 m,
width 0.008 m). Head: a truncated cone opening from r 0.026 to r 0.041 m over
0.038 m, containing a parabolic reflector (lathe of `y = x^2 / (4*0.018)` sampled
at 14 stations, 24 radial, backface-shaded with roughness 0.06 metal) and a flat
emissive disc (r 0.036 m). Tail cap: a 0.018 m cylinder with a rubberized
0.010 m button. Lanyard loop: a 12-segment torus, r 0.011 m, tube r 0.002 m.
Total: 1 640 triangles.

| Property | Value |
|---|---|
| Luminous output | 1 900 lm (measured in-engine as a spot light of 1900 lm) |
| Beam inner cone | 11 deg half-angle |
| Beam outer cone | 27 deg half-angle |
| Falloff | inverse-square, plus the water absorption of section 03 |
| Effective reach in clear water | 34 m (the point where the beam falls below 0.05 lx) |
| Effective reach in silt (scatter 4x) | 9 m |
| Power draw | 9.5 W |
| Runtime | 6 820 s (1.89 h) on PC-1, 20 460 s on PC-2 |
| Power-save mode (half output) | 4.2 W, 950 lm, 15 400 s |
| Toggle time | 0.09 s (a real filament/LED ramp: 0 -> 100 % over 0.09 s with a 12 % overshoot at 0.05 s) |
| Volumetric shaft | yes; the lamp writes into the froxel volume, 1 sample per froxel at quality tier >= Medium |
| Underwater backscatter | the beam illuminates suspended particulates within 2.5 m of the emitter, creating the classic "snow" that reduces effective vision - the player will learn to angle the lamp |
| Head-mounted variant | unlocked at tier 2, 1 100 lm, always-on, 5.5 W, frees the hand |

Battery warning: at 10 % the beam dims to 70 % and flickers once every 22 s (a
120 ms dropout). At 3 % it drops to 40 % output and flickers every 6 s. At 0 % it
dies over 1.4 s with a slow amber decay - the correct, dread-inducing behaviour.
It never dies instantly, and there is always a fallback: the wrist display emits
1.2 lm, enough to see your own hands, and it is powered by a separate,
non-depletable cell. **The screen is never fully black. (AF-5.)**

Audio: a hard click (impulse into a 2.6 kHz resonator, Q 20, 40 ms decay) plus a
faint 15.6 kHz driver whine at -52 dB while lit (omit above quality tier Low; some
players will hear it and it is a lovely detail).

### 05.7.6 Propulsion gun

**Purpose.** Travel. It roughly doubles swim speed at the cost of battery and of
one hand.

**Procedural model.** A ducted-fan torpedo held like a scooter grip. Duct: a lathe
of an airfoil-ish profile (10 points, outer r 0.085 m, inner r 0.070 m) over
0.16 m, with 5 straightener vanes (each a twisted quad strip, 0.055 m chord,
14 deg twist) at the rear. Rotor: 7 blades on a 0.020 m hub, each blade a
4-station lofted quad strip with 22 deg root twist to 9 deg tip, r 0.066 m,
animated at `rpm = 900 + 5100 * throttle`. Grip: a 0.030 m radius, 0.13 m long
capsule below the duct on a 0.022 m strut, with a trigger. Nose: a hemisphere
r 0.070 m with a 0.028 m intake grille (18 radial bars). Total: 3 420 triangles
(the rotor is the expensive part; at quality tier Low the blade count drops to 5
and the loft stations to 3, giving 1 980).

| Property | Value |
|---|---|
| Max thrust | 210 N |
| Throttle | analogue 0-100 % on the trigger (keyboard: 0/60/100 with a 0.25 s ramp) |
| Resulting top speed (F1 fins, streamlined, thrust added to a cruise stroke) | `sqrt(2*(210+92)/(1031*0.075)) = 2.80 m/s` |
| With F2 fins and sprint | 3.42 m/s |
| Power draw | 140 W at full throttle, `140 * throttle^1.6` below |
| Runtime | 463 s at full on PC-1, 1 389 s on PC-2 |
| Inert in air | yes - a fan in air produces 0.9 N; the tool refuses to spin above water with `NO MEDIUM` |
| Steering | thrust is along the camera forward axis; the tool does NOT constrain aim |
| Spin-up / spin-down | 0.65 s / 1.10 s (rotor inertia, audible) |
| Interaction with the flare/brake posture | thrust cut to 0 while braking |
| Creature aggro | the rotor is LOUD: it raises the player's acoustic signature radius from 45 m to 140 m. Deep predators hunt by sound. This is the trade. |

Audio: a rotor tone at `bladePassFreq = rpm/60 * 7` Hz (105 Hz idle to 700 Hz
full) built from 5 harmonics with amplitudes `1, 0.55, 0.30, 0.18, 0.10`, plus a
broadband cavitation noise layer (bandpass 800-5000 Hz) whose gain rises above
80 % throttle. Doppler is applied via the standard panner. Gain -12 dB at full.

FP animation: the tool is held at 0.24 m forward, 0.13 m below the eye, tilted
8 deg. At full throttle the arm extends a further 0.05 m and a 1.6 deg tremble at
11 Hz is added. The camera gains a forward lean of 3.5 deg over 0.8 s.

### 05.7.7 Repair tool

**Purpose.** Restores hull integrity on the vessel and on base modules, seals
breaches, and re-welds damaged equipment. It is also the only tool that can be
used on the vessel from outside while it is flooding, which is a set-piece the
vessel section should exploit.

**Procedural model.** A short wand. Body: a 0.16 m lathe, r 0.024 m, with a
0.045 m long transparent section revealing an internal glowing coil (a helix of
14 turns, tube r 0.0016 m, emissive `(0.95,0.55,0.15)`). Head: 3 splayed prongs
(each a 4-segment tapered cylinder, 0.048 m, splayed 18 deg) meeting at a virtual
focus 0.05 m ahead. Grip: as the cutter but shorter (0.075 m). Total: 1 380
triangles.

| Property | Value |
|---|---|
| Range | 2.2 m |
| Repair rate | 9.5 integrity/s on hull, 14.0/s on equipment |
| Breach sealing | a breach has `sealWork` 20-140; the tool applies 12 work/s |
| Power draw | 95 W |
| Runtime | 682 s on PC-1 |
| Cone half-angle | 9 deg |
| Cannot repair | anything below 5 % integrity without a `structural frame` consumable |
| Spin-up | 0.30 s |
| Underwater penalty | none |

VFX: a fan of 3 arcs from the prongs converging on the hit point, colour
`(1.00,0.62,0.22)`, with 25-60 sparks/s. The repaired surface shows a temporary
emissive weld-line that cools from `(1.0,0.75,0.35)` to black over 4.0 s following
an approximate blackbody ramp.

Audio: a 260 Hz square through a comb filter (delay 3.1 ms, feedback 0.55) with an
amplitude flutter at 22 Hz, plus a spark layer. Gain -18 dB.

### 05.7.8 Marker beacons

**Purpose.** Navigation. There is no map that fills itself in; the player builds
their own mental and literal map with beacons. This is central to the exploration
fantasy.

**Procedural model.** A 0.28 m spike. Shaft: a 7-sided tapered prism, base flat
0.030 m, tip 0.006 m. Head: an icosphere r 0.032 m (2 subdivisions, 320 tris) with
a fresnel-emissive shell. Three fold-out fins (quads, 0.06 x 0.09 m) deploy over
0.5 s after placement, rotating from 0 to 62 deg. Total: 620 triangles.

| Property | Value |
|---|---|
| Placement range | 4.0 m (raycast to any solid surface, or free-float in water) |
| Placement time | 1.2 s |
| Max simultaneous beacons | 24 |
| HUD visibility range | infinite (rendered as a clamped-to-screen-edge marker), with distance in metres |
| World light | 60 lm point light in the player-chosen colour |
| Colours | 8 presets, each an RGB triplet: red `(1.0,0.14,0.10)`, amber `(1.0,0.62,0.12)`, yellow `(1.0,0.92,0.22)`, green `(0.20,1.0,0.35)`, cyan `(0.18,0.92,1.0)`, blue `(0.22,0.34,1.0)`, violet `(0.72,0.26,1.0)`, white `(1.0,1.0,1.0)` |
| Label | 16 characters, entered on a procedural on-screen keyboard |
| Lifetime | 400 in-game days (effectively permanent) |
| Recovery | yes, walk/swim up and hold Interact for 0.8 s; the beacon returns to inventory |
| Pulse | 1 flash per 2.4 s, 180 ms, 3x brightness - readable at 300 m in clear water |
| Sonar ping (optional per beacon) | a 2.2 kHz chirp every 6 s, audible to 180 m, ATTRACTS some deep fauna - a real trade-off |
| Power | none from the player's cells; each beacon carries its own |

### 05.7.9 Pulse emitter (defensive, non-lethal)

**Purpose.** The game's only weapon, and it does not kill. It is a combined
low-frequency pressure pulse and stroboscopic flash that triggers the startle
reflex and the flee response in marine fauna. Acoustic deterrent devices are real
technology; this is an extrapolation of one, not a gun.

**Design statement (binding).** SUBWAVE must never reward killing wildlife. There
is no damage number on the pulse emitter, no kill counter, no trophy. Creatures
that flee return later, unharmed, and the player who learns their behaviour stops
needing the emitter at all. Deterrence is a skill floor, not a solution.

**Procedural model.** A broad, blunt emitter. Housing: a lathe of a 12-point
profile, max r 0.058 m, length 0.135 m, flaring to a 0.092 m radius emitter face.
Face: a concentric arrangement of 3 rings of piezo discs (7 + 13 + 19 = 39 discs,
each a 10-sided cylinder r 0.0075 m, h 0.004 m) on a dark backing plate. Around
the rim, 6 strobe lenses (hemispheres r 0.008 m, emissive when firing). Behind the
face, a visible capacitor bank: 4 cylinders r 0.014 m, h 0.055 m, in dark blue
with printed procedural warning stripes (generated as a 128x32 texture from a
periodic step function). Grip and trigger as the cutter. A charge indicator: 5
small emissive bars on the top surface. Total: 2 940 triangles.

| Property | Value |
|---|---|
| Effect range | 6.0 m |
| Cone half-angle | 35 deg (70 deg full cone - it is a wide, forgiving panic button) |
| Damage | **0** (hard-coded; the tool has no damage field) |
| Energy per pulse | 648 J |
| Pulses per PC-1 | 100 |
| Pulses per PC-2 | 300 |
| Recharge between pulses | 3.2 s (the capacitor bank; the 5 indicator bars fill over this time) |
| Charge-up before firing | 0.45 s (a rising whine; releasing early aborts and refunds 70 % of the energy) |
| Flee duration induced | 8.0 - 14.0 s, scaled by `1 - habituation`, and by creature size: `dur = base * clamp(1.6 - mass/900, 0.35, 1.0)` |
| Stagger on the largest fauna | mass > 1 200 kg: no flee, but a 1.4 s interrupt of their current attack and a course deviation of 30-70 deg |
| **Habituation** | each individual creature accumulates `habit += 0.22` per pulse it receives; `habit` decays by 0.22 per 90 s. Effect strength is `1 - habit`, floored at 0.15. **Spamming the emitter at the same creature stops working.** |
| Effect on peaceful fauna | they scatter, which can be used to clear a feeding swarm - and it makes them wary of the player for 240 s (they keep a 12 m distance), which is a real cost if you wanted to scan them |
| Effect on the player | a 0.55 m radius bubble ring, a 1.2 deg camera kick, and 0.9 s of muffled hearing (lowpass to 1.1 kHz, recovering over 0.9 s) |
| Above water | 0.35x range and 0.5x flee duration - air is a poor medium for a pressure pulse |

VFX: an expanding low-opacity shockwave shell (a screen-space refraction ring,
radius 0 -> 6.0 m over 0.28 s, refraction strength decaying as `1/r`), a 3-flash
strobe at 14 Hz from the rim lenses (each 2 400 lm, 22 ms), and a torus of
displaced bubbles.

Audio: a 34 Hz sine burst with a 12 ms attack and 260 ms decay, plus its 68 and
102 Hz harmonics, plus a wide-band transient click. Peak -6 dB (it should be the
loudest thing the player can make). A 0.45 s charging whine sweeping 800 -> 2 900 Hz
precedes it. The recharge is 5 soft clicks at 0.64 s intervals.

FP animation: on the charge-up the tool draws back 0.04 m and the wrist rotates
6 deg; on fire it kicks back 0.09 m over 60 ms and returns over 0.38 s with a
2.4 Hz damped oscillation.

### 05.7.10 Secondary / left-hand items

| Item | Function | Notes |
|---|---|---|
| Wrist display | always present, never removable | see 05.8.5 |
| Habitat builder | places base modules | owned by the base-building section; player-side it is just another quick-bar tool with a 0.44 s equip |
| Sample container | holds live specimens | 4 slots; scanned creatures can be caught and released, never killed |
| Portable tank | +35 L free gas, instant | consumable, 1.2 s use |
| Medgel / bandage / antitoxin | see 05.6.1 | 1.4 / 0.8 / 2.0 s use |

---

## 05.8 FIRST-PERSON PRESENTATION

### 05.8.1 Philosophy

The player never sees a human face, never hears a human voice, and never reads a
human name. The only evidence that they are human is a pair of gloved hands and a
breathing rhythm. Keep the arms minimal: they are a frame for the world, not a
character.

### 05.8.2 Hands and forearms - procedural

Generated once at startup into a single vertex/index buffer, skinned by a compute
pass.

| Part | Construction | Tris |
|---|---|---|
| Forearm | Swept tube along a 5-station spline; cross-section a 7-point rounded triangle (a real forearm is not round), scaling from r 0.055 m at the elbow to 0.042 m at the wrist, with a 12 deg pronation twist | 168 |
| Wrist/cuff | A 10-sided ring band, 0.028 m tall, with a raised lip (the suit seal) | 60 |
| Palm | An 8-vertex extruded and tapered box, 0.095 x 0.082 x 0.028 m, with the leading edge beveled | 72 |
| Fingers (index, middle+ring fused, little) | 3 groups, each a 3-segment tapered tube with 5-sided cross-sections | 3 x 60 = 180 |
| Thumb | 2-segment tapered tube, 6-sided | 48 |
| **Total per hand+arm** | | **528** |

Skinning: 9 joints per arm (shoulder-proxy, elbow, wrist, 3 finger-group roots,
3 finger-group tips). 2 bone influences per vertex, weights generated at build time
from distance falloff along the spline. A single 64-float uniform holds both arms.

Materials: a dive glove. Base colour `(0.11,0.13,0.15)` with a procedural cell
noise (frequency 220, contrast 0.35) driving roughness between 0.42 and 0.72, plus
a grip pattern on the palm generated by a hexagonal Worley pattern with a height
displacement of 0.4 mm rendered into the normal. Two subtle emissive suit seam
lines run the length of the forearm in `(0.10,0.42,0.38)` at 0.6 nits - they read
as instrumentation and they help the hands stay visible in the dark.

Wetness: a `wetness` scalar (1.0 underwater, decaying to 0 over 45 s in air)
raises specular and lowers roughness by 0.28, and spawns 3-9 sliding droplet
sprites on the forearm for the first 8 s out of water.

### 05.8.3 Arm poses and procedural animation

There are NO keyframed animations. All motion is generated:

| Motion | Implementation |
|---|---|
| Idle | Sum of 3 sine terms per axis at 0.23 / 0.41 / 0.77 Hz, amplitudes 0.006 / 0.003 / 0.0015 m, phases offset per hand |
| Breathing | 0.004 m rise at the breath rate, phase-locked to the audio |
| Look sway | `swayTarget = -clamp(mouseDelta * 0.0022, +/-0.035 m)` on X/Y; spring toward it with k = 90, c = 14 |
| Movement lag | `lagTarget = -velocityLocal * 0.012 m per (m/s)`, clamped to 0.05 m; spring k = 60, c = 12 |
| Step bob | the counter-bob from 05.2.5 |
| Swim stroke | when no tool is equipped: both arms sweep through a 4-key procedural cycle (catch, pull, recover, glide) generated by evaluating a Catmull-Rom over 4 pose vectors at the stroke phase. With a tool equipped, only the free hand strokes, at 0.6x amplitude |
| Equip | position lerps from `(0.18, -0.42, 0.10)` (holstered, below frame) to the tool's hold pose, ease-out-cubic, over the tool's equip time; plus a 12 deg roll settle |
| Tool use | per-tool, described in 05.7 |
| Reach (interaction) | the free hand extends 0.16 m toward the interaction point over 0.20 s and returns over 0.28 s |

All amplitudes are multiplied by `cameraMotion/100` EXCEPT equip/use, which are
gameplay-legible and stay at full.

### 05.8.4 The mask vignette

A screen-space overlay, drawn in the post pass, present only when `eyeSubmerged`.

```wgsl
// p in [-1,1] with aspect applied so the ellipse is circular in world terms
let e = vec2f(p.x / 1.06, p.y / 0.94);        // slightly wider than tall
let r = length(e);
let mask = 1.0 - smoothstep(vignetteInner, vignetteOuter, r);
```

| Parameter | Default | Notes |
|---|---|---|
| `vignetteInner` | 0.72 | scaled by the O2 escalation (05.5.6) and by chill |
| `vignetteOuter` | 1.02 | |
| Rim colour | `(0.02,0.03,0.035)` at 0.94 opacity | the mask skirt |
| Rim chromatic aberration | radial, `0.0016 * pow(r, 2.4)` in UV, R/B split | strongest at the rim, zero at centre |
| Rim barrel distortion | `uv *= 1.0 + 0.028 * r*r` | subtle; it is the lens, not a fisheye |
| Inner reflection | a faint 0.06-opacity mirrored copy of the upper-centre framebuffer, offset (0, -0.72), on the lower rim only | the classic mask-glass reflection. Quality tier >= Medium. |
| Fog on the glass | a slowly-drifting FBM (2 octaves, scroll 0.004/s), opacity `0.0 - 0.22`, rises when `chill > 45`, clears over 3 s after a "purge" (double-tap crouch) | |
| Condensation droplets | 6-18 procedural droplets on the inner glass when out of water for < 8 s | |
| Scratch overlay | a static, generated line-noise texture (256x256, R8) at 0.035 opacity | earned wear; identical every session |

The vignette must NEVER exceed 0.55 total screen coverage from all sources
combined, except during the O2 Tier 6/7 escalation and blackout. Hard clamp.

### 05.8.5 The wrist display (free-swim HUD)

This is the entire free-swim HUD. There is no floating screen-space UI while
swimming, other than interaction prompts, damage indicators and beacon markers.
Everything else lives on a physical object attached to the left forearm.

**Geometry.** A 0.078 x 0.046 m curved panel (a 6x4 grid bent around a cylinder of
r 0.055 m to match the forearm), 240 tris, with a 0.004 m raised bezel (a swept
frame, 96 tris) and 3 physical buttons (12 tris each).

**Rendering.** A 256x128 `rgba8unorm` offscreen texture, redrawn at 10 Hz (or
immediately on any state change), sampled with a slight barrel warp and a scanline
mask (a 1-pixel-period sine at 0.12 contrast, phase-scrolled 0.4 px/s). Emissive
multiplier 8.0, base tint `(0.35,0.92,0.78)`, alert tint `(1.00,0.22,0.16)`. It
casts a real 1.2 lm point light so it faintly lights the hand.

**Text rendering.** A hand-built 5x7 bitmap font (96 printable ASCII glyphs) packed
as a `Uint8Array` constant in JS (96 * 7 = 672 bytes), blitted by a fragment shader
that samples a `r8uint` texture. Plus a 7-segment style renderer for the large
numerals (drawn as 7 quads per digit). No external font files, ever.

**Layout (256x128, origin top-left):**

| Region | Rect (x,y,w,h) | Content |
|---|---|---|
| O2 arc | (4,4,72,72) | A 240 deg arc, 8 px thick, filled by gas fraction. Colour per the escalation table. |
| O2 numeric | (14,30,52,28) | Seconds remaining, 7-seg, 3 digits. Below it in 5x7: `SEC` |
| O2 pressure | (14,60,52,10) | `172 BAR` in 5x7 |
| Depth | (84,6,84,34) | 7-seg, 4 digits, `M` suffix. Amber above 0.80 * crush, red above 0.90 |
| Rated depth | (84,42,84,10) | `RATED 120M` in 5x7 |
| Vertical speed | (84,54,84,10) | `+1.4 M/S` with an up/down chevron |
| Compass ribbon | (84,68,168,18) | A scrolling ribbon, 1 px per 0.6 deg, ticks every 5 deg, labels N/NE/E/SE/S/SW/W/NW every 45 deg, plus a fixed centre caret. Heading numeral above. |
| Health bar | (4,84,72,10) | Segmented into 10 blocks; red flash on damage |
| Stamina bar | (4,98,72,6) | Thin, dims to 30 % when full |
| Chill bar | (4,108,72,6) | Blue, hidden below chill 15 |
| Time of day | (176,4,76,20) | `14:32` 7-seg, plus a 12 px sun/moon phase icon |
| Temp | (176,26,76,10) | `14.6C` in 5x7 |
| N2 bar (Realistic only) | (176,38,76,6) | Ceiling marker as a notch |
| Status icons | (4,116,248,10) | Up to 8 icons, 10x10 each: bleed, poison, entangle, burn, chill, narcosis, low cell, scrubber |
| Alert line | (84,112,168,12) | 5x7 text: `SAFETY LOCK`, `CRUSH DEPTH`, `NO GAS`, `NO MEDIUM`, etc. Blinks 1.5 Hz. |

**Raise gesture.** The wrist naturally sits at the lower-left of the frame,
partially visible and legible at a glance for depth and O2. Holding the `Wrist` key
(default `Tab`, or automatically for 1.2 s on any Tier-3+ O2 warning) raises the
arm to fill the lower-left quadrant at 2.1x apparent size over 0.30 s, and dims the
world 12 % so it is readable. Releasing returns it over 0.38 s.

### 05.8.6 Regulator bubbles

Fully procedural GPU particles.

| Property | Value |
|---|---|
| Trigger | one burst per exhale (phase-locked to the breathing synth) |
| Count per burst | `12 + round(14 * exertion)`, so 12 at idle, 26 sprinting |
| Emitter position | 0.11 m below and 0.06 m right of the eye (the second stage), in view space |
| Initial speed | 0.9 - 1.8 m/s, direction: view-forward-right +/- 28 deg, then immediately buoyancy-dominated |
| Radius | 0.004 - 0.019 m (log-uniform); large bubbles rise faster |
| Rise speed | `v = 1.18 * sqrt(r/0.008)` m/s, capped 0.42 m/s for r < 0.006 (Stokes-ish for small, cap-bubble for large) |
| Wobble | lateral sine at `2.4 + 6/r_mm` Hz, amplitude `0.35 * r` |
| Coalescence | bubbles within 1.6 r of each other merge (volume-conserving) with probability 0.25/s |
| Expansion with depth | `r(d) = r0 * cbrt(P(d0)/P(d))` as they rise - a bubble released at 40 m nearly doubles by the surface. Implement it; it is free and it is real. |
| Lifetime | until they reach the surface or 22 s |
| Max live bubbles | 2 400 (High), 1 200 (Medium), 400 (Low) |
| Shading | a thin-film-interference approximation on a screen-facing disc: fresnel rim + a refracted sample of the scene colour behind, plus an iridescent tint from a 1D lookup on `NdotV` |
| Audio | already covered by the exhale grain |
| **Rebreather** | **NO BUBBLES.** This is a major stealth benefit: creature acoustic detection of the player drops from 45 m to 18 m, and several deep species that orient on bubble noise ignore the player entirely. |

Bubbles also emit from: the cutter (steam), the propulsion gun (cavitation), the
vessel airlock, damage impacts, and vent fields. Same system, different emitters.

### 05.8.7 Free-swim HUD vs cockpit HUD

| Aspect | Free swim (wrist) | Cockpit (windshield projection) |
|---|---|---|
| Surface | A physical 0.078 x 0.046 m panel on the forearm, in world space | Projected onto the windshield glass in the vessel's local space, parallax-correct |
| Readability | Requires a glance or the raise gesture | Always in the forward view |
| Data density | 14 fields | 30+ fields (see section 06) |
| Depth | 4 digits | 4 digits + a depth ribbon with a crush-depth line and a seafloor trace |
| Compass | 168 px ribbon | full-width ribbon with beacon bearings |
| O2 | player tank | vessel reserve, in minutes, plus the player's tank as a small secondary |
| Sonar | none | yes |
| Threat/biologic contacts | none | yes |
| Power | cell % | vessel reactor % and per-system draw |
| Colour | `(0.35,0.92,0.78)` | `(0.42,0.78,1.00)` - a deliberately different instrument colour, so the player always knows which world they are in |
| Failure | flickers when chill > 60 | flickers when hull integrity < 30 % |

The contrast is intentional and load-bearing: leaving the vessel should feel like
losing 90 % of your instruments. The wrist display tells you how to survive; the
cockpit tells you where to go.

---

## 05.9 INTERACTION

### 05.9.1 Raycast

| Property | Value |
|---|---|
| Interaction range (land/air) | 3.2 m |
| Interaction range (underwater) | 2.6 m |
| Interaction range (chill >= 60) | -0.4 m from the above |
| Cast shape | sphere cast, radius 0.06 m (forgiving; a pure ray is miserable to aim underwater) |
| Cast origin | camera position + 0.10 m forward |
| Layers | `INTERACTABLE`, `RESOURCE`, `VESSEL_HATCH`, `BASE_MODULE`, `BEACON`, `FAUNA_SCANNABLE` |
| Update rate | every frame while any interactable is within 6 m, else 10 Hz |
| Tie-break | nearest hit wins; on a tie within 0.15 m, prefer the smaller bounding volume |
| Hold-to-interact | some verbs require a hold (see the verb table); the ring fills clockwise from 12 o'clock |
| Cancel | releasing before completion cancels with no cost and a descending 2-note motif |

### 05.9.2 Highlight / outline

Implementation (WebGPU, no third-party libs):

1. During the main opaque pass, write the currently-highlighted object's id into a
   dedicated `r8uint` attachment (`highlightMask`), 1 where the object is, 0
   elsewhere. Full resolution, no MSAA (resolve to a 1x buffer first if MSAA is
   on at the current quality tier).
2. Post pass A: a separable 2-pass dilation with a 5-tap kernel at radius 2 px
   (horizontal then vertical), writing to `r8unorm`. Cost: two full-screen passes
   at 1 byte/px, ~0.09 ms at 1080p on an M-series GPU.
3. Post pass B: `outline = dilated - original`, giving a 2 px band. Composite:

```wgsl
let band = clamp(dilated - orig, 0.0, 1.0);
let pulse = 0.78 + 0.22 * sin(time * 5.4);
color = mix(color, OUTLINE_COLOR * pulse, band * OUTLINE_OPACITY);
```

| Parameter | Value |
|---|---|
| `OUTLINE_COLOR` (generic) | `(0.55,0.95,1.00)` |
| `OUTLINE_COLOR` (resource/ore) | `(1.00,0.80,0.30)` |
| `OUTLINE_COLOR` (vessel hatch) | `(0.42,0.78,1.00)` |
| `OUTLINE_COLOR` (blocked/refused) | `(1.00,0.30,0.24)` |
| `OUTLINE_OPACITY` | 0.85 |
| Band width | 2 px at 1080p, scaled with resolution (`round(2 * h/1080)`, min 1) |
| Pulse rate | 5.4 rad/s (0.86 Hz) |
| Fade in/out | 0.12 s / 0.18 s |
| Depth behaviour | the outline is NOT drawn through geometry (it uses the depth-tested mask), so an interactable behind a rock does not glow through it |
| Quality tier Low | the dilation runs at half resolution, band width 1 px |

### 05.9.3 Prompt UI

A small, screen-space, world-anchored prompt. It is the ONLY screen-space UI in
free swim besides damage arcs and beacon markers.

| Element | Spec |
|---|---|
| Anchor | projected position of the hit point, clamped to within 0.35 of the screen centre, offset +0.06 in screen Y |
| Key glyph | a rounded-rect outline, 26x26 px at 1080p, 2 px stroke, containing the bound key's label in the 5x7 font at 2x scale |
| Verb text | 5x7 font at 2x, left-aligned 8 px right of the glyph, colour `(0.92,0.96,1.00)` |
| Object name | below, 5x7 at 1x, colour `(0.60,0.68,0.74)` |
| Hold ring | for hold verbs, a 34 px diameter arc around the glyph, 3 px thick, filling clockwise |
| Backdrop | none (no panel). A 1 px dark outline on the text for legibility against bright water. |
| Fade | in 0.10 s, out 0.14 s |
| Max simultaneous | 1 |
| Refusal | the verb text is replaced by the refusal reason in `(1.00,0.30,0.24)` for 1.4 s, e.g. `NO SAFE FOOTING`, `TOO LOW TO EGRESS`, `CELL EMPTY`, `HANDS FULL`, `SAFETY LOCK` |

### 05.9.4 The verb list

| Verb | Key | Type | Target | Duration | Notes |
|---|---|---|---|---|---|
| Pick up | E | tap | loose item, ore chunk, dropped tool | instant | goes to inventory; refused if full |
| Harvest | E | hold | flora, coral, bio-node | 0.9 - 2.4 s | does not kill the organism; regrows in 300-1800 s |
| Mine | LMB w/ cutter | hold | ore outcrop | continuous | 05.7.4 |
| Scan | LMB w/ scanner | hold | anything | 2.0 - 9.0 s | 05.7.3 |
| Board vessel | E | tap | vessel hatch | 1.15 s anim | 05.4.3 |
| Exit vessel | E | tap | from `PILOTING` | 0.9 s | |
| Open / close | E | tap | hatch, locker, panel | 0.6 s | |
| Toggle | E | tap | light, switch, valve, beacon pulse | instant | |
| Place beacon | LMB w/ beacon | tap | any surface / water | 1.2 s | |
| Recover beacon | E | hold | placed beacon | 0.8 s | |
| Repair | LMB w/ repair tool | hold | damaged hull/module | continuous | |
| Refill O2 | automatic | - | surface, vessel, anchor, air pocket | continuous | no prompt; it just happens |
| Refill O2 (portable tank) | E | tap | inventory item | 1.2 s | |
| Use consumable | F | tap | medgel/bandage/antitoxin | 0.8 - 2.0 s | |
| Craft | E | tap | fabricator | opens the fabricator UI | |
| Build | RMB w/ builder | hold | valid placement | 1.8 - 4.0 s | |
| Deconstruct | RMB w/ builder | hold | own base module | 1.2 s | full refund |
| Rest / save | E | hold 1.0 s | anchor bunk | 1.0 s + fade | sets respawn anchor, advances time to a chosen hour |
| Catch specimen | E | hold | small fauna within 1.6 m | 1.4 s | goes to a sample container, released later unharmed |
| Release specimen | E | tap | from container | 0.6 s | |
| Deter | LMB w/ pulse emitter | tap (0.45 s charge) | direction | 0.45 s | 05.7.9 |
| Struggle | mash A/D or E | mash | while `ST_ENTANGLE` | until free | |
| Purge mask | double-tap Ctrl | tap | self | 0.5 s | clears mask fog, small bubble burst |
| Adjust trim | E | tap | at anchor/vessel only | instant | ballast setting |
| Raise wrist | Tab | hold | self | - | 05.8.5 |
| Toggle lamp | L | tap | self | 0.09 s | works with any tool equipped |
| Holster | Q double-tap / 6 | tap | self | 0.3 s | both hands free; enables full swim stroke |

### 05.9.5 Input map (default, rebindable)

| Action | Key / Button |
|---|---|
| Move | W A S D |
| Sprint | Left Shift (hold) |
| Jump / ascend | Space |
| Crouch / descend / flare-brake | Left Ctrl (hold) |
| Roll left / right (swim) | Q / E ... conflict: roll is on `Z` / `C` by default; `Q` is holster, `E` is interact |
| Interact | E |
| Use tool (primary) | Left Mouse |
| Use tool (secondary) | Right Mouse |
| Quick bar | 1 - 5 |
| Holster | 6 or Q (double-tap) |
| Lamp toggle | L |
| Wrist display raise | Tab (hold) |
| Consumable | F |
| Inventory | I |
| Codex | J |
| Beacon list | B |
| Purge mask | Ctrl (double-tap) |
| Pause | Esc |
| Screenshot (no HUD) | F12 |

Gamepad is supported: left stick move, right stick look, LT sprint, RT primary,
A jump/ascend, B crouch/descend, X interact, Y holster, d-pad quick bar, LB/RB roll,
click-R wrist raise. Analogue throttle on the propulsion gun uses RT travel.

---

## 05.10 DEATH AND RESPAWN

### 05.10.1 Anchors

An **anchor** is a respawn point. The player always has at least one.

| Anchor type | How it is set | Priority |
|---|---|---|
| Start island bunk | exists from the first frame, permanent, never destroyed | lowest |
| Base habitat bunk | built by the player; becomes active on first use | by recency |
| Vessel cot | present in every vessel with the `cot` module; active only if the vessel is intact (>15 % integrity) and above its crush depth | highest, if valid |

Respawn selection at death:

```
1. If the vessel is valid AND within 900 m of the death point -> respawn in the vessel cot.
2. Else, the most recently used base bunk within 2500 m of the death point.
3. Else, the most recently used base bunk anywhere.
4. Else, the start island bunk.
```

### 05.10.2 What is lost

| Category | On death |
|---|---|
| Tools | **kept**, all of them |
| Battery charge in equipped tools | reduced to `max(current, 20 %)` - i.e. topped UP if lower, never drained. Yes: you wake up with working gear. |
| Suit / cylinder / fin tier | kept |
| Crafted items and blueprints | kept |
| Codex entries | kept |
| Raw ore and harvested flora in inventory | **50 % lost**, rounded down, minimum 0. This is the only material penalty. |
| Consumables (medgel, tanks) | kept |
| Placed beacons | kept |
| Base modules | kept |
| Time | the world clock advances by 120 s during the blackout |
| Health / O2 / stamina / chill on respawn | full / full / full / 0 |

The 50 % raw-material loss is the entire death penalty, and it is capped: if the
player is carrying fewer than 4 units of anything, they lose nothing of it. A death
on the way home from a big haul stings; a death on an exploration trip costs
nothing but time.

### 05.10.3 The dive cache

The lost 50 % is not deleted - it is placed in a **dive cache** at the death
location: a small, gently glowing container (a 0.42 m ovoid, procedural, emissive
`(0.30,0.90,0.75)`, pulsing at 0.4 Hz) that is automatically marked with a
permanent beacon labelled `CACHE`. It does not despawn. Ever. Only one cache exists
at a time; a second death moves the marker and merges the contents into the newest
cache (so the player never has to do an archaeology tour of their own failures).

Recovering the cache is optional. The beacon can be dismissed. Nothing in the game
ever requires retrieving it.

### 05.10.4 Vessel recovery

The vessel must NEVER be permanently lost. This is a hard guarantee.

| Situation | Behaviour |
|---|---|
| Player dies while outside the vessel, vessel intact | The vessel stays exactly where it is. Its position is always shown on the wrist as a beacon-class marker labelled `VESSEL` with a live distance readout - this marker exists at all times and cannot be dismissed. |
| Player dies while outside, vessel below its own crush depth | The vessel's autopilot engages 12 s after the player's death: it ascends at 2.0 m/s to 40 m depth and holds station. A log entry appears. |
| Player dies while piloting | The vessel takes 25 % integrity damage (floor 15 %), surfaces automatically over 20-90 s depending on depth, and holds at y = -2 m. |
| Vessel integrity reaches 0 | It does not explode. It enters `DISABLED`: no thrust, no lights, 8 % integrity, and it slowly ascends to the surface on its emergency bladders (0.6 m/s). It can be repaired in place with the repair tool. |
| Vessel is unreachable (wedged in geometry, inside a collapsed cave) | The player may issue an **Emergency Recall** from any base anchor: after a 180 s cooldown the vessel is teleported to the nearest anchor pad with a 40 % integrity penalty and a diegetic explanation (autopilot self-extraction burn). Available at most once per 20 minutes of play. |
| Vessel is left flying with no pilot | It enters a 30 s hover, then auto-lands at the nearest flat surface or sets down on the water. |
| Vessel falls below the world floor / physics failure | Detected by a watchdog; the vessel is restored to its last known valid transform. Logged. |

### 05.10.5 Anti-frustration guarantees (binding)

These are contracts. Any feature that violates one must be redesigned.

| # | Guarantee |
|---|---|
| AF-1 | Tools are never lost, never broken, never dropped. |
| AF-2 | The vessel can never be permanently lost or destroyed. |
| AF-3 | Running out of gas grants a 3.0 s damage-free grace period, so the player who was 4 m from air always makes it. |
| AF-4 | The player is never softlocked out of the ability to breathe: the start island is always reachable and always safe, and every base anchor refills O2 for free. |
| AF-5 | The screen is never fully black while alive: the wrist display always emits at least 1.2 lm and is powered by a non-depletable cell. |
| AF-6 | No durability systems. Nothing degrades with use. |
| AF-7 | No hunger or thirst meters. Survival pressure comes from oxygen, pressure, cold and creatures - not from chores. |
| AF-8 | Death costs at most 50 % of raw materials, and even those are recoverable from a permanent, auto-marked cache. |
| AF-9 | Every lethal environmental hazard is legible at least 8 seconds before it can kill you at maximum approach speed, through at least two sensory channels (visual + audio). |
| AF-10 | Boarding the vessel is never blocked by combat, damage, or creature proximity. |
| AF-11 | No permadeath, no run resets, no lost save states. Autosave every 120 s and on every state transition to `PILOTING`, `ANCHOR_REST` or `BLACKOUT`. |
| AF-12 | The player can always determine their depth, heading, remaining gas and the direction of their vessel, in every state, without opening a menu. |
| AF-13 | Any hazard that inflicts loss of control (stun, entangle, blind) is capped at 12 s and always has a player-driven escape action. |
| AF-14 | Difficulty options (`Explorer` / `Standard` / `Realistic`) never gate content, only pressure. |

### 05.10.6 Difficulty presets

| Setting | Explorer | Standard (default) | Realistic |
|---|---|---|---|
| Gas drain multiplier | 0.70 | 1.00 | 1.15 |
| Depth term on gas | yes | yes | yes (never removed - it is the physics) |
| Pressure damage | 0.60x | 1.00x | 1.30x |
| Chill rate | 0.60x | 1.00x | 1.25x |
| Inert gas loading (05.6.5) | off | off | **on** |
| Narcosis | on (visual only, no input latency) | on | on |
| Creature aggression | reduced | normal | heightened |
| Death material penalty | 0 % | 50 % | 50 % |
| Drowning grace | 5.0 s | 3.0 s | 2.0 s |
| Fall damage | 0.5x | 1.0x | 1.0x |

---

## 05.11 PERSISTENCE (PLAYER PAYLOAD)

Stored in IndexedDB under `subwave/save/<slotId>/player`, as a single structured
clone. localStorage holds only the slot index and settings.

```js
{
  v: 1,                              // schema version
  pos:      [x, y, z],               // f64 x3, world metres
  quat:     [x, y, z, w],            // body orientation
  state:    2,                       // player state id (05.0.5)
  health:   87.4,
  stamina:  100.0,
  chill:    0.0,
  n2:       0.79,                    // tissue inert gas, ata
  gasLitres: 41.2,                   // free gas remaining, surface-equivalent L
  scrubberSeconds: 0,                // rebreather only
  tiers: { suit: 1, cylinder: 2, fins: 1, rebreather: 0 },
  ballastN: 8,
  quickBar: [1, 2, 3, 7, 0],         // tool ids, 0 = empty
  equipped: 3,                       // quick bar index
  cells:    [ {id:'PC-1', j: 41230}, {id:'PC-1', j: 64800} ],
  toolCell: [ 0, 0, 1, -1, -1, -1, 0 ],   // which cell each tool draws from, -1 = none
  status:   [ {id:'ST_BLEED', t: 8.2, stacks: 1} ],
  inventory: [ {id:'ORE_TITANIUM', n: 14}, ... ],
  anchors:  [ {id:'start', pos:[...], used: 0}, {id:'base_01', pos:[...], used: 18432.5} ],
  activeAnchor: 'base_01',
  beacons:  [ {pos:[...], color: 4, label:'CAVE MOUTH', ping: false}, ... ],
  cache:    { pos:[...], items:[...] } | null,
  codex:    Uint8Array(512),          // bitset of scanned entries
  stats:    { distanceSwum: 18422.6, deepest: 412.8, deaths: 3, timeSubmerged: 9840.2 },
  settings: { cameraMotion: 70, worldTilt: true, refractionBlend: 0.65,
              photosensitiveSafe: false, reducedPostFX: false, freeRoll: false,
              instantSeat: false, difficulty: 'standard' }
}
```

Autosave triggers: every 120 s of play; on entering `PILOTING`, `ANCHOR_REST` or
`BLACKOUT`; on any tier upgrade; on placing or recovering a beacon; on window
`beforeunload` (best-effort, synchronous localStorage marker + async IDB flush).

Save size budget: player payload < 24 KB. Codex bitset is fixed at 512 bytes
(4096 entries).

---

## 05.12 QUALITY TIERS (PLAYER-SIDE)

| Feature | Low | Medium | High | Ultra |
|---|---|---|---|---|
| Player physics substep | 120 Hz | 120 Hz | 120 Hz | 120 Hz (never reduced) |
| Max live bubbles | 400 | 1 200 | 2 400 | 2 400 |
| Bubble shading | flat + fresnel | + refraction | + thin-film iridescence | + per-bubble caustic |
| Mask inner reflection | off | on | on | on |
| Mask fog / droplets | off | on | on | on |
| Outline dilation | half-res, 1 px | full-res, 2 px | full-res, 2 px | full-res, 2 px |
| Hand mesh | 528 tris, 1 bone weight | 528, 2 weights | 528, 2 weights | 528, 2 weights + normal map |
| Shadow proxy | capsule only | capsule + legs | capsule + legs | capsule + legs |
| Lamp volumetrics | off | froxel 1 sample | froxel 2 samples | froxel 4 samples + temporal |
| Rotor blade count (propulsion gun) | 5 | 7 | 7 | 7 |
| Lamp driver whine (15.6 kHz) | off | on | on | on |
| Wrist display refresh | 5 Hz | 10 Hz | 10 Hz | 20 Hz |
| Footstep resonator bands | 1 | 2 | 3 | 3 |
| Post-process (O2 escalation) | vignette + desat only | + blur | + blur + warp | all |

Player-side frame budget at 1080p on an M-series GPU: **1.6 ms** total (physics
0.18 ms CPU, hands + tool render 0.34 ms, bubbles 0.28 ms, outline 0.09 ms, mask
post 0.21 ms, wrist display 0.05 ms amortised, volumetric contribution 0.44 ms).

---

## 05.13 ACCEPTANCE TESTS

Each must be automatable as a headless simulation test where possible.

| # | Test | Pass condition |
|---|---|---|
| T-01 | Jump from flat ground, full hold | apex height 1.05 m +/- 0.01, time to apex 0.473 s +/- 0.005 |
| T-02 | Jump with instant release | apex 0.49 m +/- 0.01 |
| T-03 | Walk into a 0.40 m step | steps up without losing more than 15 % speed |
| T-04 | Walk into a 0.45 m step | blocked, no jitter, no vertical oscillation |
| T-05 | Stand on a 46 deg slope | `GROUNDED`, can walk up |
| T-06 | Stand on a 48 deg slope | `SLIDING` within 0.1 s, slides downhill |
| T-07 | Free fall 13.0 m onto basalt | HP reaches exactly 0 (+/- 3 HP) |
| T-08 | Free fall 13.0 m into 3 m of water | HP loss 0 |
| T-09 | Sink from y=0 to y=-400 with no input, S0 suit, 8 N ballast | terminal speed converges to 0.65 m/s +/- 0.05 |
| T-10 | Swim forward, F1 fins, no current | steady speed 1.54 m/s +/- 0.03 |
| T-11 | Sprint from rest, F1 fins | reaches 2.33 m/s +/- 0.05 within 3.5 s |
| T-12 | Sprint continuously from full stamina | lasts 7.14 s +/- 0.1 |
| T-13 | Flare-brake from 2.33 m/s | stopped (<0.15 m/s) within 1.15 s, distance < 1.30 m |
| T-14 | T0 cylinder, cruise, hold at 30 m | empties in 31 s +/- 1 |
| T-15 | T0 cylinder, cruise, hold at 0 m | empties in 119 s +/- 2 |
| T-16 | R1 rebreather at 300 m, cruise | gas duration unchanged from surface duration |
| T-17 | Tank empties at 4 m depth, player ascends immediately | reaches surface and survives with HP loss 0 |
| T-18 | Tank empties, player stays submerged, full HP | death at 10.37 s +/- 0.2 |
| T-19 | Descend to 180 m with S0 suit | 21.0 HP/s +/- 0.5 |
| T-20 | Descend to 119 m with S0 suit | 0 damage |
| T-21 | O2 escalation | every tier boundary fires within 1 frame of the threshold, and no tier is skipped when the rate changes abruptly |
| T-22 | Chill at 200 m, S0, cruising | reaches 100 in 25 s +/- 1 |
| T-23 | Pulse emitter fired 5 times at one creature within 90 s | effect strength on the 5th is 0.15 (floor), and the creature does not flee |
| T-24 | Cutter aimed at any `FAUNA` collider | zero damage dealt, `SAFETY LOCK` shown, arc extinguishes within 1 frame |
| T-25 | Death with 14 ore units | 7 remain, 7 in the cache, cache beacon exists and persists across a save/load |
| T-26 | Death with 3 ore units | 3 remain (below the 4-unit floor), no cache created |
| T-27 | Death while the vessel is at 900 m with a 400 m crush rating | vessel is at 40 m +/- 2 within 200 s |
| T-28 | Save and reload mid-dive at 240 m | position, orientation, gas, chill, status effects and cell charges all match to within f32 precision |
| T-29 | `cameraMotion = 0` | camera offset from bob/surge/landing is exactly 0 in all states |
| T-30 | Water entry/exit crossed 200 times at the waterline in 10 s | no state flicker; each transition fires at most once per 0.24 s |
| T-31 | Lamp battery to 0 | output decays over 1.4 s, wrist display remains readable, screen luminance never reaches 0 |
| T-32 | Interaction sphere cast at 3.2 m on land, 2.6 m in water | prompts appear/disappear exactly at those distances +/- 0.05 m |
| T-33 | 2 400 bubbles live at 1080p | player-side GPU time stays under the 1.6 ms budget |
| T-34 | Narcosis at 110 m, open circuit | input latency exactly 150 ms; switching to R1 clears it within 2.0 s |
| T-35 | Start island sweep | no reachable point inside r=260 m of the spawn anchor produces any damage of any type over a 20-minute automated wander |

---

## 05.14 OPEN ITEMS FOR OTHER SECTIONS

1. Terrain must expose `materialId: u8` per surface sample for footsteps (05.2.7)
   and per voxel for cutter hardness (05.7.4).
2. The ocean section must expose `oceanHeight(x, z, t)` and `current(p, t)`,
   both callable at 120 Hz from the player physics step without allocation.
3. The creature section must consume: `playerAcousticRadius` (45 m base, 18 m on
   rebreather, 140 m with the propulsion gun running), `playerScentRadius`
   (90 m base, +32 m per bleed stack), the `FLEE(duration)` command from the pulse
   emitter, and the per-individual `habituation` accumulator.
4. The vessel section must expose the hatch trigger volume, seat transform,
   `integrity`, `crushDepth`, and the O2 refill rate contract (16.7 %/s).
5. The biome section must supply `dT_biome` per region for `waterTempC`.
6. The renderer must provide the `highlightMask` r8uint attachment and the froxel
   volume interface for the lamp.
7. The audio engine must provide the `SURVIVAL_CUES` bus that bypasses the
   underwater lowpass, and the `UNDERWATER_VERB` convolution-free reverb.
8. The crafting section owns fragment counts for recipe unlocks; the scanner only
   reports "fragment acquired".

--- END OF SECTION 05 ---
