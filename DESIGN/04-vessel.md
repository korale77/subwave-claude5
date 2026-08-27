# SUBWAVE - DESIGN SECTION 04

# THE VESSEL: "SULA"

## Hybrid Aerodyne-Submersible - Form, Flight, Dive, Systems, Cockpit, Upgrades

Status: BINDING IMPLEMENTATION SPEC. Version 1.0.
Coordinate system: right-handed, +X east, +Y up, +Z south, metres, sea level y = 0, depth d = -y.
Vessel local frame: +Xl = starboard, +Yl = up (dorsal), -Zl = forward (nose). Origin at the
design reference point (DRP), 3.60 m aft of the nose tip on the hull spine.
All angles in radians internally. Degrees appear only in this document and in UI.

---

## 4.0 NAMING, ROLE, DESIGN PILLARS

### 4.0.1 Name

The vessel is named **SULA**. `Sula` is the genus of gannets and boobies: seabirds that soar
at altitude, fold, and plunge-dive through the surface at speed to hunt underwater. The name is
naturalistic, non-human-derived, two syllables, reads cleanly at 12 px on a HUD, and is the
only proper noun the player will hear for the entire game.

Canonical strings (exact, case-sensitive, used in UI and save data):

| Context | String |
|---|---|
| HUD boot banner | `SULA` |
| HUD subtitle line | `AERODYNE-SUBMERSIBLE` |
| Annunciator prefix | `SULA` |
| Save-data key | `subwave.vessel.sula` |
| Hull serial (cosmetic, etched on canopy sill) | `S-0001` |
| Voice/text personality | NONE. The Sula never speaks. It has tones, lights and needles only. |

Design rule (non-negotiable): the Sula has **no voice, no personality text, no AI assistant**.
The brief forbids human presence; a talking vessel would violate the loneliness pillar. All
communication is instrumental: tones, annunciator words (max 3 words), needles, lights.

### 4.0.2 Role in the fantasy

The Sula is the player's only companion, only shelter, only light source at depth, and only
means of crossing the world. Every design decision below is subordinate to five pillars:

| # | Pillar | Concrete consequence in this spec |
|---|---|---|
| P1 | Seamless air<->water | One rigid body, one integrator, one blend parameter `beta`. No teleport, no loading, no mode gate. See 4.4. |
| P2 | Flying is expensive, diving is cheap | Air hover = 874 kW and heats up; submerged cruise = 12-96 kW and self-cools. See 4.5.1, 4.5.4. |
| P3 | Physically motivated | Real Archimedes, real added mass, real quadratic drag, real momentum-theory thrust, real cavitation, real hydrostatic pressure. No fudge constants without a stated physical reason. |
| P4 | The cockpit is the game's face | The windshield HUD (4.7) is the single highest-fidelity asset in SUBWAVE. It is the frame around every scary thing the player will ever see. |
| P5 | Dread, not gore | Sonar contacts with no visual. Creaking. Lights that attract things. Silent running. |

### 4.0.3 Summary card

| Quantity | Value |
|---|---|
| Overall length (nose tip to tail cap) | 6.400 m |
| Overall width (duct rim to duct rim) | 4.120 m |
| Overall height, skids retracted, mast stowed | 1.950 m |
| Overall height, skids extended, mast raised | 3.150 m |
| Hull max beam | 2.200 m |
| Hull max height (excl. canopy) | 1.400 m |
| Dry mass | 1,850 kg |
| Pilot + dive suit | 92 kg |
| Cargo capacity (base) | 240 kg / 18 slots |
| Nominal operating mass (pilot + half cargo) | 2,060 kg |
| Watertight displaced volume, skids retracted, MBT blown | 2.190 m3 |
| Free-flood volume (buoyancy-neutral submerged) | 0.041 m3 |
| Buoyant force at 2.190 m3 in seawater (1027 kg/m3) | 22,065 N (2,249 kgf) |
| Reserve buoyancy at nominal mass, tanks blown | +189 kgf (+1,854 N) |
| Total variable ballast | 0.386 m3 / 396 kg |
| Max negative buoyancy, tanks flooded | -207 kgf (-2,031 N) |
| Max static thrust, 4 nacelles, sea level air | 32,800 N (T/W = 1.62) |
| Max thrust, 4 nacelles, submerged below 25 m | 25,600 N |
| Max level airspeed (sea level) | 62 m/s (223 km/h) |
| Never-exceed airspeed Vne | 78 m/s |
| Max submerged speed | 9.2 m/s (33.1 km/h) |
| Service ceiling | 4,200 m |
| Crush depth, base hull rating | 320 m |
| Crush depth, max hull rating (Tier 6) | 4,000 m |
| Core continuous electrical output | 1,100 kW |
| Buffer cell capacity (base) | 34.0 kWh |
| Crew | 1 |

---

## 4.1 (A) FORM - PROCEDURAL GEOMETRY SPECIFICATION

Everything below is generated at runtime by `vessel/geometry.js` into interleaved vertex
buffers. No model files. The generator is deterministic: seeded by the constant integer
`0x5541_0001` so the mesh is byte-identical across sessions and machines.

Vertex format (all vessel parts share it), 48 bytes, stride 48, `vertex_buffer_layout`:

| Offset | Attr | Format | Meaning |
|---|---|---|---|
| 0 | position | float32x3 | local metres |
| 12 | normal | float32x3 | unit |
| 24 | tangent | float32x4 | xyz unit, w = bitangent sign |
| 40 | uv | float32x2 | 0..1, per-part atlas region |

Index format: `uint32`. Parts are packed into one vertex buffer + one index buffer with a
per-part `{firstIndex, indexCount, baseVertex, materialId, boneId}` descriptor table so the
whole vessel draws in <= 9 draw calls (opaque hull, glass, emissive, rotors instanced,
arm, skids, mast, interior, decals).

### 4.1.1 Hull - lofted superellipse along a spline

The hull is a **loft**: a superellipse cross-section swept along a monotone cubic spine, with
per-station half-width `a`, half-height `b`, vertical offset `yc`, and superellipse exponent
`n`. `n` controls "boxiness": n = 2 is an ellipse, n = 4 is a rounded rectangle (gives the
Sula its slab-sided, load-bearing look), n < 3 near nose and tail rounds them off.

Signed-power parametric superellipse (avoids the pow-of-negative problem):

```js
// t in [0, 2*PI). n = exponent (>=2). a,b = half-extents in metres.
function superellipsePoint(t, a, b, n) {
  const ct = Math.cos(t), st = Math.sin(t);
  const e  = 2.0 / n;
  return [
    a * Math.sign(ct) * Math.pow(Math.abs(ct), e),
    b * Math.sign(st) * Math.pow(Math.abs(st), e)
  ];
}
```

**Station keyframe table** (13 keyframes; the generator resamples to `N_STATION` stations with
a monotone cubic Hermite (Fritsch-Carlson) interpolant on each of `a`, `b`, `yc`, `n` so no
overshoot / no waviness):

| k | s | z_local (m) | a half-beam (m) | b half-height (m) | yc offset (m) | n exponent |
|---|---|---|---|---|---|---|
| 0 | 0.000 | -3.600 | 0.020 | 0.020 | -0.050 | 2.60 |
| 1 | 0.050 | -3.280 | 0.260 | 0.200 | -0.060 | 3.00 |
| 2 | 0.120 | -2.832 | 0.550 | 0.380 | -0.060 | 3.40 |
| 3 | 0.220 | -2.192 | 0.860 | 0.550 | -0.040 | 3.80 |
| 4 | 0.340 | -1.424 | 1.060 | 0.660 | -0.010 | 4.20 |
| 5 | 0.450 | -0.720 | 1.100 | 0.700 |  0.000 | 4.40 |
| 6 | 0.550 | -0.080 | 1.080 | 0.700 |  0.010 | 4.40 |
| 7 | 0.660 |  0.624 | 0.980 | 0.660 |  0.020 | 4.20 |
| 8 | 0.760 |  1.264 | 0.840 | 0.580 |  0.030 | 3.80 |
| 9 | 0.850 |  1.840 | 0.660 | 0.470 |  0.040 | 3.40 |
| 10 | 0.920 |  2.288 | 0.480 | 0.360 |  0.050 | 3.00 |
| 11 | 0.970 |  2.608 | 0.300 | 0.240 |  0.060 | 2.80 |
| 12 | 1.000 |  2.800 | 0.100 | 0.100 |  0.060 | 2.60 |

`z_local(s)` is exactly `-3.600 + 6.400 * s` for all keyframes (uniform spine); the spine is a
straight line in Z with a gentle vertical bow given entirely by `yc`. This keeps the loft
cheap and the wetted-area integration in 4.3.2 analytic per station.

Ring parameterisation and seam:

```
for i in 0..N_STATION-1:
  s = i / (N_STATION - 1)
  (a,b,yc,n) = hermite(keyframes, s)
  z = -3.600 + 6.400 * s
  for j in 0..N_RING:            // N_RING+1 verts: j=N_RING duplicates j=0 for the UV seam
    t = 2*PI * j / N_RING
    (x,y) = superellipsePoint(t, a, b, n)
    pos = (x, y + yc, z)
    uv  = (j / N_RING, s)
```

Normals: analytic. The superellipse gradient is
`dP/dt = (-a*e*sign(ct)*|ct|^(e-1)*st , b*e*sign(st)*|st|^(e-1)*ct)`; the spine tangent is
`(0,0,1)` plus `dyc/ds` in Y. Cross those two, normalise. Clamp `|ct|,|st| >= 1e-4` before the
pow to avoid NaN at the four superellipse corners; those four columns get the average of their
neighbours.

Nose and tail are closed with a **triangle fan** to a single apex vertex at
`(0, yc(0), -3.600)` and `(0, yc(1), +2.800)` respectively (the k=0 and k=12 rings are small
enough - 0.020 m - that the fan is invisible).

Surface detail (no textures from disk): the hull material samples 3 procedural layers in the
fragment shader, all generated at boot into a single `rgba8unorm` 1024x1024 array texture by a
compute pass:

| Layer | Content | Generator |
|---|---|---|
| 0 | Panel lines + fastener rings | Worley F1 cellular, 22 cells/m2, ridged, width 1.6 mm; fasteners = disk field on cell centroids, radius 4 mm, spacing 0.11 m along seams |
| 1 | Brushed anisotropic microstructure | 6-octave stretched value noise, anisotropy 12:1 along Z, amplitude 0.04 roughness |
| 2 | Wear / oxide / biofouling | fBm 5 octaves, thresholded by cavity AO and by `wearAccum` (see 4.5.6); tint drifts 0 -> RGB(0.22, 0.28, 0.19) |

### 4.1.2 Canopy bubble

A truncated, forward-raked ellipsoid blended into the hull crown with a smooth union.

| Property | Value |
|---|---|
| Semi-axis X | 0.780 m |
| Semi-axis Y | 0.620 m |
| Semi-axis Z | 1.340 m |
| Centre, local | (0.000, +0.440, -2.050) m |
| Forward rake (rotation about Xl) | -9.0 deg (nose-down, so it sheds spray) |
| Clip plane | keep only `y_local > yc(s) + 0.55 * b(s)` |
| Blend to hull | smooth-min, k = 0.085 m, applied as a post-loft vertex snap over a 0.14 m band |
| Glass thickness | 34 mm laminated (12 mm outer / 3 mm interlayer / 8 mm core / 3 mm interlayer / 8 mm inner) |
| Frame | 0.042 m wide extruded rim, 4 struts: 1 centreline forward, 2 quarter, 1 aft arch |
| Optical | see 4.7.2 |

Grid: 32 azimuthal x 20 polar = 640 verts, 1,178 triangles. Drawn in the transparent pass with
`depth_write = false`, sorted after all water/volumetric work.

### 4.1.3 Nacelles (4x) - tilting ducted fans / pump-jets

The same duct works in both media. In air it is a ducted fan (high RPM, low pitch). In water it
is a pump-jet (low RPM, coarse pitch); the blade pitch actuator is part of the hub.

| Property | Value |
|---|---|
| Count | 4 |
| Pivot positions, local | FL (-1.300, +0.020, -1.600), FR (+1.300, +0.020, -1.600), RL (-1.300, +0.020, +1.600), RR (+1.300, +0.020, +1.600) |
| Duct outer diameter | 1.520 m |
| Duct throat (rotor) diameter | 1.520 m; rotor disc area A_disc = 1.815 m2 |
| Duct chord (length along thrust axis) | 0.620 m |
| Duct wall thickness | 0.048 m |
| Duct lip radius | 0.062 m (rounded inlet, worth +26% static thrust vs open rotor) |
| Blades | 7 per rotor, NACA 4412-derived, root chord 0.185 m, tip chord 0.092 m, twist -14 deg root to tip |
| Stator vanes | 9 per duct, fixed, downstream, cancel swirl torque |
| Pylon | superellipse extrusion, 0.34 m x 0.16 m section, n = 3.2, length 0.46 m from hull to pivot |
| Nacelle dry mass (each) | 78 kg |
| Pylon + tilt actuator mass (each) | 19 kg |
| Rotor visual RPM (air) | 0 - 2,850 rpm (tip speed 227 m/s max, Mach 0.66) |
| Rotor visual RPM (water) | 0 - 276 rpm (tip speed 22 m/s max, cavitation-limited) |

Procedural recipe per nacelle:

```
duct     = lathe(profile2d = 14 pts NACA-like annulus section,
                 axis = local thrust axis, segments = 40)     ->  40*15  = 600 verts
inner_shroud = lathe(inner surface, segments = 40, rings = 8) ->  40*9   = 360 verts
stator   = 9 x extrudeAirfoil(spanwise 6, chordwise 8)        ->  9*48   = 432 verts
hub      = lathe(bullet profile, 20 seg, 9 rings)             ->  20*10  = 200 verts
blade    = loft(NACA4412 resampled to 10 chordwise pts,
                12 spanwise stations with twist+taper)        ->  120 verts
rotor    = 7 x blade, instanced with per-blade transform      ->  120 verts + 7 instances
pylon    = extrudeSuperellipse(n=3.2, 16 ring, 6 stations)    ->  16*7   = 112 verts
fairing  = smoothUnion(pylon, hull) skirt band                ->  96 verts
```

Static per-nacelle unique verts: 600 + 360 + 432 + 200 + 120 + 112 + 96 = **1,920**.
Blades are drawn instanced (7 instances/nacelle, 28 total) so blade geometry is stored once.

**Tilt kinematics.** Each nacelle has two actuated DOF plus rotor RPM:

| DOF | Axis (nacelle local) | Range | Rate | Actuator | Note |
|---|---|---|---|---|---|
| Tilt `theta` | Xl (lateral), positive = thrust rotates aft | -20.0 deg to +100.0 deg | 70 deg/s | 2.1 kW peak | theta=0 -> thrust straight up (hover); theta=90 -> thrust straight aft (forward flight) |
| Vector `phi` | Zl (longitudinal), differential | -12.0 deg to +12.0 deg | 90 deg/s | 0.8 kW peak | lateral force, yaw authority, roll trim |
| RPM | - | 0 - 100% | see 4.2.4 | - | first-order lag |

Thrust direction in vessel local frame for nacelle i:

```
dir_local = Rx(theta_i) * Rz(phi_i) * (0, 1, 0)
          = ( sin(phi_i),
              cos(theta_i)*cos(phi_i),
             -sin(theta_i)*cos(phi_i) )   // -Z is forward, so +theta pushes the ship forward
F_i = T_i * dir_local            applied at the duct exit plane centre r_i
```

Duct exit plane centre `r_i = pivot_i + Rx(theta_i)*Rz(phi_i) * (0, -0.310, 0)` (half a chord
below the pivot along the thrust axis).

### 4.1.4 Landing skids (retractable)

Two skids, each on a 4-bar linkage retracting into a ventral well.

| Property | Value |
|---|---|
| Skid tube length | 1.900 m |
| Skid tube radius | 0.075 m |
| Track (skid centre to skid centre) | 2.360 m |
| Ground clearance under keel, extended | 0.420 m |
| Extension time | 1.60 s (0.80 s emergency, hydraulic dump) |
| Power to cycle | 3.4 kW peak, 5.4 kJ per cycle |
| Mass, both, incl. retraction | 66 kg |
| Added V_disp when extended | +0.028 m3 sealed, +0.012 m3 free-flood |
| Drag penalty when extended | CD0 0.085 -> 0.128 (air); axial Cd 0.19 -> 0.27 (water) |
| Contact model | 3 spheres per skid (r = 0.075 m) at z = -1.30, -0.10, +1.10; spring k = 180 kN/m, damper c = 24 kN.s/m, static friction mu_s = 0.72, kinetic mu_k = 0.55 |

Procedural recipe per skid: sweep a circle (10 radial) along a 48-point polyline (a straight run
with two upswept ends, radius-of-curvature 0.34 m) = 480 verts; 3 legs, each an extruded
superellipse (n = 3.0, 8 ring x 10 stations) = 240 verts; total **720 verts per skid**,
1,440 both.

### 4.1.5 Dorsal sensor mast (retractable)

| Property | Value |
|---|---|
| Stowed | flush, top at y = +0.760 m |
| Deployed | +0.600 m of extension, top at y = +1.360 m; dome apex y = +1.470 m |
| Mast section | tapered cylinder, r 0.090 m (base) -> 0.050 m (top), 16 radial x 10 stations = 160 verts |
| Sonar dome | sphere r = 0.110 m, 16 x 8 = 128 verts, rotates 360 deg / 3.20 s when active sonar is on |
| Strobe rod | 0.340 m, r 0.018 m, 8 x 4 = 32 verts, carries the upper emergency strobe |
| Deploy time | 1.10 s |
| Mass | 22 kg |
| Function | active sonar transducer, magnetometer (ore contacts), the upward-looking depth sounder, and the beacon transmitter for RECALL (4.8.6) |
| Constraint | Must be stowed above 46 m/s airspeed and below -900 m (pressure). Auto-stows with a `MAST STOW` advisory. |

### 4.1.6 Ventral manipulator / drill arm

Stows in a ventral bay at `z = -0.550`, doors 0.62 m x 0.34 m, open in 0.9 s.

| Segment | Length (m) | Joint | Range | Max rate | Verts |
|---|---|---|---|---|---|
| Shoulder yoke | 0.280 | yaw about Yl | -95 to +95 deg | 55 deg/s | 180 |
| Upper arm | 0.780 | pitch about Xl | -20 to +130 deg | 60 deg/s | 240 |
| Forearm | 0.860 | pitch about Xl | -145 to +10 deg | 70 deg/s | 240 |
| Wrist / drill head | 0.420 | roll about arm axis | continuous | 180 deg/s | 420 |

Max reach from DRP: 2.300 m. Drill bit: cone, base radius 0.110 m, half-angle 34 deg, 3 helical
flutes (pitch 0.180 m/turn, depth 0.024 m), generated by boolean-subtracting 3 swept helices
from the cone in the generator (evaluated as an SDF and marched at 0.004 m resolution into the
420-vert cap). Drill RPM 0 - 620. Mass 84 kg. Drill draw and yields are in section 07 (ores);
the arm's mechanical envelope, power draw (11.5 kW drilling, 1.2 kW positioning) and the IK
solver (2-link analytic + wrist) live here.

IK: analytic 2-link (law of cosines) in the shoulder-yaw plane, wrist aligned to the surface
normal of the target sample point, with a 0.06 m standoff. Solve time budget: 12 us/frame.

### 4.1.7 Running lights and emissive geometry

12 emitters, each an icosphere subdiv-1 (42 verts) with an emissive material and a matching
punctual light (4.6).

| ID | Position local (m) | Colour | Function |
|---|---|---|---|
| NAV-P | (-1.640, +0.060, -1.600) | 640 nm red | port navigation |
| NAV-S | (+1.640, +0.060, -1.600) | 525 nm green | starboard navigation |
| NAV-T | (0.000, +0.180, +2.740) | 6,000 K white | tail |
| STB-U | (0.000, +1.420, 0.000) | 6,500 K white | upper strobe (on mast) |
| STB-L | (0.000, -0.680, +0.400) | 6,500 K white | lower strobe |
| FLD-P / FLD-S | (-0.560 / +0.560, -0.180, -3.180) | 5,200 K | forward floods |
| LOW-1..4 | (+/-0.900, -0.240, -2.600 / -1.100) | 4,300 K | wide low beams |
| WRK-V | (0.000, -0.640, -0.900) | 5,600 K | underside work lamp |

### 4.1.8 Interior (cockpit shell)

Only drawn when the camera is inside. Simple, dark, functional: no clutter, no decals with
writing beyond system labels.

| Part | Verts | Note |
|---|---|---|
| Cockpit tub (inner loft, offset -0.055 m from hull inner) | 980 | matte, roughness 0.72, albedo RGB(0.055, 0.058, 0.062) |
| Seat + headrest + 5-point restraint | 560 | lathe + loft |
| Coaming / glareshield | 240 | shades the HUD reflection |
| Side consoles (L/R) with switch banks | 320 | switches are instanced boxes, 26 total |
| Control inceptors (right sidestick, left collective/ballast lever) | 220 | animated |
| Pedals | 80 | animated |
| **Interior total** | **2,400** | |

### 4.1.9 Vertex / triangle budget by quality tier

| Part | High | Medium | Low |
|---|---|---|---|
| Hull loft (stations x ring) | 48 x 40 = 1,968 | 32 x 28 = 957 | 24 x 20 = 525 |
| Canopy | 640 | 384 | 208 |
| Nacelles (4 x unique) | 7,680 | 4,240 | 2,160 |
| Rotor blades (instanced) | 120 x 28 inst | 84 x 28 inst | 48 x 28 inst |
| Skids | 1,440 | 780 | 360 |
| Mast | 320 | 180 | 96 |
| Arm | 1,080 | 620 | 300 |
| Emissives | 504 | 288 | 144 |
| Interior | 2,400 | 1,500 | 900 |
| **Total unique verts** | **16,032** | **8,949** | **4,693** |
| **Total triangles (exterior only)** | ~19,400 | ~10,600 | ~5,300 |

LOD switch distances (exterior, chase cam): High < 28 m, Medium 28-90 m, Low > 90 m, impostor
billboard > 340 m. Interior is always High (it is inches from the camera).

### 4.1.10 Mass breakdown, CoM, CoB, inertia

| Item | Mass (kg) | CoM local (x, y, z) m |
|---|---|---|
| Pressure hull shell (Ti-6Al-4V equiv., 14 mm) | 430 | (0.000, -0.060, +0.050) |
| Outer fairing / free-flood shell | 120 | (0.000, -0.020, +0.120) |
| Canopy assembly (glass + frame) | 88 | (0.000, +0.430, -2.050) |
| Nacelles 4 x 78 | 312 | (0.000, +0.020, 0.000) |
| Pylons + tilt actuators 4 x 19 | 76 | (0.000, +0.020, 0.000) |
| Core (radiothermal lattice + shielding) | 240 | (0.000, -0.250, +1.180) |
| Buffer cell, 34 kWh | 96 | (0.000, -0.320, +0.520) |
| Ballast system (pumps, 220 bar air flask, valves) | 102 | (0.000, -0.300, -0.150) |
| Manipulator / drill arm | 84 | (0.000, -0.520, -0.550) |
| Landing skids + retraction | 66 | (0.000, -0.560, -0.100) |
| Sensor mast + sonar head | 22 | (0.000, +0.850, +0.100) |
| Avionics, flight computer, HUD projector | 15 | (0.000, +0.050, -2.400) |
| Life support (electrolyser, scrubber, O2 flask) | 40 | (0.000, -0.180, +0.780) |
| Seat, interior, restraint | 33 | (0.000, -0.050, -1.500) |
| Lights + harness | 18 | (0.000, -0.150, -1.900) |
| Thermal loop (pumps, radiator plate) | 26 | (0.000, -0.100, +1.600) |
| Structure, fasteners, misc | 82 | (0.000, -0.060, +0.100) |
| **Dry total** | **1,850** | **(0.000, -0.098, +0.058)** |

| Configuration | Mass (kg) | CoM local (m) |
|---|---|---|
| Dry | 1,850 | (0.000, -0.098, +0.058) |
| + pilot (92 kg at (0.000, -0.020, -1.560)) | 1,942 | (0.000, -0.094, -0.019) |
| Nominal (pilot + 120 kg cargo at (0.000, -0.360, +0.900)) | 2,060 | (0.000, -0.109, +0.034) |
| Max cargo (pilot + 240 kg) | 2,182 | (0.000, -0.123, +0.084) |
| Nominal + ballast full (396 kg at (0.000, -0.330, +0.020)) | 2,456 | (0.000, -0.145, +0.032) |

Centre of buoyancy (watertight envelope, fully submerged, skids retracted):
**CoB = (0.000, +0.145, -0.060) m**.

Metacentric separation BG (nominal, tanks at neutral fill) = 0.145 - (-0.109) = **0.254 m**.
This is deliberately large: the Sula is pendulum-stable in water and self-rights from any
attitude with no control input. Righting moment `M = W_sub * BG * sin(heel)`.

**Inertia tensor** about the nominal CoM, vessel local axes, kg.m2:

```
        [ 8420      0     42 ]     Ixx = 8420   pitch axis (lateral Xl)
I_dry = [    0   9240      0 ]     Iyy = 9240   yaw   axis (vertical Yl)
        [   42      0   1880 ]     Izz = 1880   roll  axis (longitudinal Zl)
```

Off-diagonal `Ixz = 42 kg.m2` is 0.5% of Ixx; the simulation treats the tensor as **diagonal**
`diag(8420, 9240, 1880)` and the omitted coupling is folded into the rate-loop integrator.
Roll is the light axis by design (Izz/Ixx = 0.22): the Sula rolls crisply and pitches
deliberately, which is how a heavy VTOL should feel.

Ballast water changes inertia; the sim recomputes the diagonal each time total ballast changes
by more than 0.010 m3, using the parallel axis theorem on four point masses at the tank
centroids (Table 4.3.3).

### 4.1.11 Hatch and boarding reference

| Property | Value |
|---|---|
| Hatch centre, local | (0.000, +0.620, -0.350) m |
| Hatch aperture | 0.640 m x 0.520 m, rounded rect r = 0.11 m |
| Hinge | aft edge, opens up-and-back to 78 deg |
| Cycle time | 1.10 s open, 1.30 s close+seal (seal has a 0.20 s dwell) |
| Seal state | binary; must be SEALED before `beta > 0.05` or a leak begins (4.5.6) |
| Interaction reference point (IRP) | (0.000, +0.900, -0.350) m, used for the prompt in 4.8.1 |

---

## 4.2 (B) FLIGHT MODEL (AIR)

### 4.2.1 Model choice

**Vectored thrust + modest body lift.** The Sula is NOT a wing. It is a 2-tonne quadrotor
tiltrotor with a lifting-body hull that contributes real but secondary lift above ~30 m/s.
Rationale: (a) it must hover to land on a reef and to hold station over a dive site; (b) it must
be able to fly nose-down into the water without stalling into a spin; (c) a lifting body needs
no wings, which would be structurally absurd on a 4,000 m-rated pressure hull.

Handling target: "heavy VTOL". Deliberate, momentum-heavy, with strong attitude hold. The
player should feel 2 tonnes.

### 4.2.2 Atmosphere

```
rho_air(y) = 1.225 * exp(-y / 8200.0)      // kg/m3, y in metres, y >= 0
T_air(y)   = 288.15 - 0.0065 * y           // K, clamped >= 216.65
p_air(y)   = 101325 * exp(-y / 8434.0)     // Pa
```

Below y = 0 (i.e. underwater) the air model is not evaluated; `beta` (4.4) selects the medium.

### 4.2.3 Thrust

Momentum theory with a duct augmentation factor and an overall efficiency:

```
// Static (hover) thrust available per nacelle at electrical power P_e:
//   v_i = sqrt( T / (2 * rho * A_disc) )         induced velocity
//   P_ideal = T * v_i  =  sqrt( T^3 / (2 * rho * A_disc) )
//   P_e     = P_ideal / eta_total
// Inverted:
T_from_power(P_e, rho) = cbrt( 2 * rho * A_disc * (eta_total * P_e)^2 )
```

| Constant | Air | Water |
|---|---|---|
| A_disc | 1.815 m2 | 1.815 m2 |
| eta_total (incl. duct gain, FM, motor, inverter) | 0.780 | 0.700 |
| T_max per nacelle (sea level / d >= 25 m) | 8,200 N | 6,400 N |
| P_e at T_max | 451 kW | 14.2 kW |
| P_e at hover (5,052 N per nacelle, nominal mass) | 218 kW | n/a |
| Total hover power, air, nominal mass | **874 kW** | n/a |
| Total power at max thrust, air | **1,806 kW** | 57 kW |
| Induced (downwash) velocity at hover, air | 33.7 m/s | - |
| Spool time constant tau (first order) | 0.180 s | 0.340 s |
| Command slew limit | 250 %/s | 160 %/s |

Air-density scaling of max thrust (blade-element correction to pure momentum theory):

```
T_max(y) = 8200 * (rho_air(y) / 1.225)^0.85          // N per nacelle
```

Hover ceiling (where 4 * T_max = W at nominal mass): `(rho/rho0)^0.85 = 0.616` ->
`rho/rho0 = 0.5656` -> **y = 4,672 m absolute ceiling**. Declared limits:

| Limit | Altitude | Behaviour |
|---|---|---|
| Best-climb band | 0 - 1,800 m | full performance |
| Advisory `THIN AIR` | 3,000 m | amber annunciator, thrust margin < 25% |
| Service ceiling (ROC = 0.5 m/s) | 4,200 m | red annunciator `CEILING` |
| Absolute ceiling | 4,672 m | cannot climb |
| Hard sim ceiling | 5,000 m | invisible barrier, 4,000 N downward force ramp over 200 m; the world's skybox and atmosphere LUT are only authored to 5 km |

### 4.2.4 Body lift and drag

```
alpha = atan2(-v_body.y, -v_body.z)             // angle of attack, rad; -Z is forward
beta_s = asin( v_body.x / max(|v|, 0.1) )       // sideslip, rad
q = 0.5 * rho_air * |v|^2                       // dynamic pressure, Pa

S_ref = 7.40 m2      // hull planform
b_ref = 2.20 m       // reference span (hull beam)
AR_eff = 1.05        // effective aspect ratio incl. duct endplating
e_osw  = 0.72

// Lift coefficient: linear then blended to flat-plate past soft stall
CL_lin  = 2.40 * alpha
CL_plate= 2.00 * sin(alpha) * cos(alpha)
w       = smoothstep(0.175, 0.280, |alpha|)     // 10 deg -> 16 deg
CL      = mix(CL_lin, CL_plate, w)
CL      = clamp(CL, -0.62, 0.62)                // CL_max 0.55 at 14 deg + 12% dynamic overshoot

CD0     = skids_extended ? 0.128 : 0.085
k       = 1.0 / (PI * AR_eff * e_osw)           // = 0.421
CD      = CD0 + k * CL^2 + 0.140 * |beta_s|     // sideslip penalty
CY      = -1.90 * beta_s                        // side force
```

Forces in wind axes, applied at the aerodynamic centre `AC = (0, -0.020, -0.740) m` (0.72 m
ahead of the CoM -> the bare hull is longitudinally UNSTABLE; the stability assist in 4.2.7 is
what makes it flyable, exactly like a real fly-by-wire tiltrotor). Static margin = -11.3% of
`L_ref = 6.40 m`.

Aerodynamic damping moments (independent of the assist, always present):

| Axis | Coefficient | Moment |
|---|---|---|
| Pitch damping Cmq | -6.80 | `M = q * S_ref * L_ref * Cmq * (q_body * L_ref / (2|v|))` |
| Roll damping Clp | -0.42 | `L = q * S_ref * b_ref * Clp * (p_body * b_ref / (2|v|))` |
| Yaw damping Cnr | -0.95 | `N = q * S_ref * L_ref * Cnr * (r_body * L_ref / (2|v|))` |
| Weathervane Cn_beta | +0.24 | `N = q * S_ref * L_ref * Cn_beta * beta_s` (stabilising in yaw) |

Guard: when `|v| < 3 m/s`, the `/(2|v|)` terms are clamped by substituting `max(|v|, 3.0)` to
avoid a singularity in hover.

### 4.2.5 Ground effect

Ducted-fan thrust augmentation near a solid or liquid surface:

```
h  = height of the duct exit plane above the surface, metres
D  = 1.520                                      // duct diameter
k_ge = 1.0 + 0.28 * exp(-2.40 * h / D)
T_eff = T * k_ge                                // effective to h ~ 2.5 D = 3.80 m
```

| h (m) | h/D | k_ge | Thrust bonus |
|---|---|---|---|
| 0.20 | 0.13 | 1.164 | +16.4% |
| 0.40 | 0.26 | 1.150 | +15.0% |
| 0.76 | 0.50 | 1.084 | +8.4% |
| 1.52 | 1.00 | 1.025 | +2.5% |
| 3.04 | 2.00 | 1.002 | +0.2% |

Ground effect over water is reduced to `k_ge_water = 1.0 + 0.16 * exp(-2.40 * h/D)` (the surface
deforms and absorbs the jet), and it drives VFX:

| h above water (m) | Effect |
|---|---|
| < 3.00 | 4 annular spray rings, one per duct, radius `0.9 + 1.6*(1 - h/3)` m, 40-260 particles each |
| < 1.60 | surface depression decal, depth `0.22 * (1 - h/1.6)` m, radius 1.4 m, fed into the ocean displacement buffer |
| < 0.90 | continuous mist sheet, opacity `0.65*(1 - h/0.9)`, plus a 220 Hz low-frequency rumble at -14 dBFS |
| < 2.20 over sand/dust | dust plume, 4 rings, colour sampled from the terrain albedo |

### 4.2.6 Control mapping (air)

Player inputs, normalised to [-1, +1] or [0, 1]:

| Input | Key / axis | Symbol | Range |
|---|---|---|---|
| Pitch | W / S (or mouse Y when `MOUSE FLY` on) | `u_pitch` | -1 .. +1 (positive = nose up) |
| Roll | A / D (or mouse X) | `u_roll` | -1 .. +1 (positive = right roll) |
| Yaw | Q / E | `u_yaw` | -1 .. +1 (positive = nose right) |
| Collective / vertical | Space (up) / Ctrl (down) | `u_coll` | -1 .. +1 |
| Translate forward/aft | Shift (fwd) / X (aft), or mouse wheel sets a cruise detent | `u_trans` | -1 .. +1 |
| Master throttle detent | 1..0 keys, or wheel | `u_throt` | 0 .. 1 |
| Ballast (water only) | R (flood) / F (blow) | `u_ball` | -1 .. +1 |
| Skids | G | toggle | - |
| Mast | M | toggle | - |
| Lights | L cycles group; Shift+L opens the light panel | - | - |
| Silent running | Z | toggle | - |
| Autotrim / hover hold | H | toggle | - |
| Sonar ping | Tab | momentary | - |
| Arm / drill | RMB deploy, LMB drill | - | - |

**Mixer.** The commanded body-frame wrench:

```
// 1. Desired attitude (attitude-command / velocity-hold law)
pitch_cmd = -u_pitch * 0.436                      // +/- 25 deg
roll_cmd  =  u_roll  * 0.611                      // +/- 35 deg
yawrate_cmd = u_yaw * 1.047                       // +/- 60 deg/s

// 2. Vertical channel: collective maps to vertical acceleration, not raw thrust
az_cmd = u_coll * 4.20                            // m/s2, +up
if (u_coll == 0 && autotrim) az_cmd = alt_hold_PID()
T_vert_total = m * (9.81 + az_cmd) / max(cos(tilt_eff), 0.35)

// 3. Longitudinal channel: nacelle tilt is scheduled by demanded forward accel
ax_cmd = u_trans * 3.60                           // m/s2 forward
theta_sched = clamp( atan2(m * ax_cmd + D_est, T_vert_total), -0.349, 1.745 )   // -20..+100 deg
theta_cmd_i = theta_sched + pitch_trim_i          // per-nacelle differential from 4.2.7
```

Cruise scheduling table (what the tilt does as speed builds, with `u_trans = 1`):

| Airspeed (m/s) | theta (deg) | Pitch attitude (deg) | Notes |
|---|---|---|---|
| 0 | 0 | 0 | hover |
| 6 | 12 | -2 | translation |
| 14 | 26 | -4 | |
| 24 | 42 | -6 | body lift begins to matter (CL 0.25, L = 1.6 kN) |
| 36 | 61 | -7 | |
| 48 | 76 | -8 | |
| 62 | 88 | -9 | Vmax level: thrust-limited, body lift carries 5.9 kN of the 20.2 kN weight |

### 4.2.7 Stability assist (cascaded PID)

Two nested loops, both running at the fixed physics rate (see 4.2.9). This is the "fly-by-wire"
that makes an unstable lifting body flyable.

**Outer loop (attitude -> rate):**

```
att_err   = shortestAngle(att_cmd, att_actual)                 // per axis, rad
rate_cmd  = clamp(Kp_att * att_err, -rate_max, +rate_max)      // rad/s
```

| Axis | Kp_att (1/s) | rate_max (rad/s) | rate_max (deg/s) |
|---|---|---|---|
| Pitch | 4.50 | 1.396 | 80 |
| Roll | 5.40 | 2.094 | 120 |
| Yaw | 3.20 | 1.047 | 60 |

**Inner loop (rate -> angular acceleration -> torque):**

```
e     = rate_cmd - rate_actual
I_e  += e * dt;  I_e = clamp(I_e, -0.80, +0.80)                // rad/s * s
d_e   = (e - e_prev) / dt;  d_e = lowpass(d_e, fc = 12 Hz)
alpha_cmd = Kp_r * e + Ki_r * I_e + Kd_r * d_e                 // rad/s2
tau_cmd   = I_axis * alpha_cmd                                 // N.m
```

| Axis | Kp_r (1/s) | Ki_r (1/s2) | Kd_r (-) | I_axis (kg.m2) | Max torque available (N.m) | Max alpha (rad/s2) |
|---|---|---|---|---|---|---|
| Pitch | 9.00 | 3.00 | 0.35 | 8,420 | 9,184 | 1.09 |
| Roll | 11.50 | 3.80 | 0.30 | 1,880 | 7,462 | 3.97 |
| Yaw | 7.20 | 2.40 | 0.42 | 9,240 | 5,965 | 0.65 |

Torque sources:
- Pitch: differential thrust fore/aft, arm 1.600 m, `dT_max = +/-2,870 N` per nacelle
  (35% of T_max). `tau = 2 * dT * 1.600`.
- Roll: differential thrust port/starboard, arm 1.300 m. `tau = 2 * dT * 1.300`.
- Yaw: lateral vectoring `phi` (arm 1.300 m) + rotor reaction torque (counter-rotating pairs;
  differential RPM gives an extra 340 N.m). `tau = 4 * T_i * sin(phi_i) * 1.300 + tau_react`.

**Anti-windup:** if the mixer saturates any nacelle command (`T_i` clipped to [0.05, 1.0] of
`T_max`), the integrators for all axes are frozen and back-calculated:
`I_e -= (tau_cmd - tau_achieved) / (Ki_r * I_axis) * 0.6`.

**Mixer saturation priority** (when total demand exceeds available thrust): roll > pitch >
yaw > vertical > translation. Attitude keeps flying the ship; altitude is allowed to sag first.

**Assist modes** (cycle with `H`, shown on the HUD mode field):

| Mode | Behaviour |
|---|---|
| `ASSIST` (default) | Full cascade above. Stick centred = wings level, altitude hold, velocity bleed to zero. |
| `RATE` | Outer loop bypassed; sticks command body rates directly. No self-levelling. For expert flying and for tight cave work. |
| `HOVER` | ASSIST + position hold: a PID on horizontal ground velocity (`Kp = 0.85 1/s`, `Kd = 0.30`) drives `pitch_cmd`/`roll_cmd` to null drift. Holds within a 0.9 m radius in still air, 2.4 m in 12 m/s wind. |
| `MANUAL` | Everything off. Raw thrust and raw tilt. Almost unflyable; exists as a damage state (4.5.6) and as an achievement. |

### 4.2.8 Wind and turbulence

Wind is authored by the weather system (section 03); the vessel consumes it as a world-space
velocity field sample at the CoM:

```
v_rel = v_vessel - v_wind(pos, t)         // all aero uses v_rel, not v_vessel
```

Turbulence adds a Dryden-style gust: three band-limited noise channels at 0.4 / 1.7 / 5.2 Hz,
amplitude scaled by `0.16 * |v_wind|`, injected as force at the AC and torque about the CoM.
Above 2,000 m altitude turbulence intensity is multiplied by 0.35 (smooth air).

### 4.2.9 Integration

| Property | Value |
|---|---|
| Physics rate | fixed 120 Hz (`dt = 1/120 s`), max 4 substeps per rendered frame |
| Integrator | semi-implicit Euler for translation; exponential-map quaternion update for rotation |
| Quaternion renormalise | every step, `q /= |q|` |
| Angular velocity clamp | 6.0 rad/s any axis |
| Linear velocity clamp | 120 m/s |
| Contact solver | sequential impulse, 6 iterations, Baumgarte 0.18, slop 0.004 m |
| CCD | swept-sphere for the hull bounding capsule when `|v| * dt > 0.18 m` |
| Interpolation to render | linear position, slerp rotation, using the fractional accumulator |

---
## 4.3 (C) DIVE MODEL (WATER)

### 4.3.1 Water properties

```
// Density: reference + compressibility + thermal expansion + salinity delta
rho_w(d, T, S) = 1027.0 + 0.00451 * d - 0.200 * (T - 10.0) + 0.760 * (S - 35.0)
// d = depth in metres, T = degrees C from the thermocline profile (section 03),
// S = practical salinity (35.0 open ocean, 28.0 in the freshwater-lens caves).
```

| Depth (m) | T (deg C), reference profile | rho_w (kg/m3) | Absolute pressure (MPa) | Pressure (bar) |
|---|---|---|---|---|
| 0 | 26.0 | 1023.8 | 0.101 | 1.01 |
| 25 | 25.6 | 1024.0 | 0.353 | 3.53 |
| 60 | 22.1 | 1024.8 | 0.706 | 7.06 |
| 120 | 15.4 | 1026.5 | 1.310 | 13.10 |
| 200 | 11.2 | 1027.7 | 2.117 | 21.17 |
| 320 | 8.4 | 1028.8 | 3.325 | 33.25 |
| 600 | 5.1 | 1030.7 | 6.146 | 61.46 |
| 1,000 | 3.6 | 1032.8 | 10.234 | 102.34 |
| 1,600 | 2.4 | 1036.0 | 16.373 | 163.73 |
| 2,400 | 1.9 | 1040.4 | 24.564 | 245.64 |
| 4,000 | 1.6 | 1049.7 | 40.930 | 409.30 |

Pressure: `p(d) = 101325 + integral(rho_w * g) dd`, evaluated with the closed form
`p(d) = 101325 + g * (1027.0 * d + 0.002255 * d^2)` for the reference profile
(g = 9.81 m/s2). This is the value the HUD shows and the value the damage model uses.

### 4.3.2 Buoyancy and partial submergence

Buoyant force is `F_b = rho_w * g * V_sub`, applied at the centroid of the submerged volume.

**Wetted-volume integration.** Because the hull is a station loft, submerged volume is computed
by slicing: for each of the `N_STATION` stations (48 high / 32 med / 24 low), compute the area
of the superellipse below the local water plane, then integrate along Z with the trapezoid rule.

```
V_sub = 0; M1 = vec3(0)                       // first moment for the centroid
for i in 0 .. N_STATION-1:
  P_world  = vesselToWorld(0, yc_i, z_i)      // station centre
  h_free   = oceanHeight(P_world.xz, t)       // includes waves; section 03
  // signed height of the water plane in the station's local vertical frame:
  yw = worldToStationLocalY(h_free, P_world, orientation)
  A_i = superellipseAreaBelow(a_i, b_i, n_i, yw - yc_i)
  yb_i = superellipseCentroidBelow(a_i, b_i, n_i, yw - yc_i)
  ...trapezoid accumulate A_i * dz, and (0, yb_i, z_i) * A_i * dz
V_sub  = accumulated
C_sub  = M1 / V_sub                            // centre of buoyancy this frame
```

`superellipseAreaBelow` uses a 12-point Gauss-Legendre quadrature in the vertical direction
(exactly integrates the signed-power profile to < 0.15% error). Precompute the 12 abscissae and
weights once. Cost: 48 stations x 12 samples = 576 evaluations per frame, ~9 us. Acceptable.

Fast path: if the hull bounding capsule is entirely above the local wave surface,
`V_sub = 0, beta = 0`, skip. If entirely below (`d > 2.4 m` at any attitude),
`V_sub = V_disp + V_skids, C_sub = CoB`, skip.

**Wetted fraction** `w = V_sub / V_disp`, clamped to [0,1]. This drives everything in 4.4.

Buoyancy including ballast: the MBTs and trim tanks are *inside* the watertight envelope, so
flooding them does not change `V_disp`; it adds mass:

```
m_total = m_dry + m_pilot + m_cargo + rho_w * (V_mbt_filled + V_trim_filled)
F_net_vertical = rho_w * g * V_sub  -  m_total * g
```

| Condition (nominal 2,060 kg dry+pilot+cargo) | Ballast fill | Net vertical force |
|---|---|---|
| Tanks blown, fully submerged | 0.000 m3 | +1,854 N (rises at 0.72 m/s terminal) |
| Neutral | 0.184 m3 (47.7%) | 0 N |
| Half flooded | 0.193 m3 | -87 N |
| Fully flooded | 0.386 m3 | -2,031 N (sinks at 0.75 m/s terminal) |
| Empty cargo, tanks blown | 0.000 m3 | +3,012 N |
| Max cargo, tanks blown | 0.000 m3 | +657 N |

Neutral-fill fraction as a function of load: `f_neutral = (rho_w * V_disp - m_load) / 396`.
Range across the whole cargo/ballast envelope: 0.169 (max cargo) to 0.775 (empty). The autotrim
in 4.3.4 must therefore have full-range authority, which it does.

### 4.3.3 Variable ballast system

| Tank | Volume (m3) | Centroid local (m) | Type | Flood rate (m3/s) | Blow/pump rate (m3/s) |
|---|---|---|---|---|---|
| MBT-P (port main) | 0.145 | (-0.560, -0.330, +0.060) | free-flood + HP air blow | 0.052 | 0.038 |
| MBT-S (starboard main) | 0.145 | (+0.560, -0.330, +0.060) | free-flood + HP air blow | 0.052 | 0.038 |
| VT-F (forward trim) | 0.048 | (0.000, -0.290, -1.520) | pumped, reversible | 0.011 | 0.011 |
| VT-A (aft trim) | 0.048 | (0.000, -0.290, +1.680) | pumped, reversible | 0.011 | 0.011 |
| **Total** | **0.386** | | | **0.126** | **0.098** |

| Property | Value |
|---|---|
| Full flood, both MBTs, from blown | 2.79 s |
| Full blow, both MBTs, at surface | 3.82 s |
| Full trim tank transfer F->A | 4.36 s |
| HP air flask | 0.048 m3 at 22.0 MPa (220 bar), 10.6 m3 free air |
| Compressor recharge | 1.10 kW, 0.0021 m3 free air/s -> full flask in 84 min; only runs when total draw < 60% of core |
| Power: flooding | 0 kW (vents open, sea does the work) |
| Power: blowing | 4.20 kW (valve heaters + control) |
| Power: trim pumps | 1.80 kW each while running |

**Depth-dependent blow authority.** Blowing needs air at above ambient pressure:

```
blow_rate(d) = blow_rate_0 * clamp(1.0 - d / d_blow_max, 0.0, 1.0)
d_blow_max   = 1400 m (base flask, 220 bar)      // upgrades in 4.9
```

| Depth (m) | Blow rate multiplier | Time to blow both MBTs (s) |
|---|---|---|
| 0 | 1.000 | 3.82 |
| 200 | 0.857 | 4.46 |
| 600 | 0.571 | 6.69 |
| 1,000 | 0.286 | 13.36 |
| 1,300 | 0.071 | 53.8 |
| >= 1,400 | 0.000 | never - **thrusters only** |

This is a real and deliberate dread mechanic: below ~1,200 m you cannot blow your way to the
surface. If the thrusters fail deep, you are dead. The HUD ballast gauge shows a hatched
"NO BLOW" band above the current-depth blow limit.

**Emergency blow (`Shift+F`, 1.0 s hold):** dumps the flask. 0.145 m3/s per MBT, both empty in
2.00 s, consumes 60% of the flask, 9.0 s lockout, effective only above 900 m. Produces a huge
bubble plume, a 118 dB roar, and a `EMER BLOW` red annunciator. Ascent rate after emergency
blow from neutral: peaks at 1.86 m/s.

### 4.3.4 Neutral-buoyancy trim assist ("AUTOTRIM")

Two-timescale controller: ballast handles the steady-state (slow, free, silent), thrusters
handle the transient (fast, costly, noisy).

```
// ---- slow loop, 6 Hz update, bandwidth 0.15 Hz ----
F_resid   = m_total * g - rho_w * g * V_sub            // N, positive = heavy
F_resid_f = lowpass(F_resid, fc = 0.15 Hz)
dV_err    = -F_resid_f / (rho_w * g)                   // m3 of ballast change wanted
if |dV_err| > 0.0025:
    command MBT flood/blow at rate proportional to |dV_err|, capped by 4.3.3 rates
    prefer VT tanks if |dV_err| < 0.020 (quieter, no air used)

// ---- fast loop, 120 Hz, bandwidth 2.5 Hz ----
err_d  = d_target - d
v_cmd  = clamp(0.55 * err_d, -1.20, +1.20)             // m/s, positive = descend
a_cmd  = 0.90 * (v_cmd - v_down) - 0.12 * a_down_meas  // m/s2
F_thr  = (m_total + m_added_y) * a_cmd + F_drag_est - F_resid
   -> distributed to the four nacelles as vertical thrust
```

| Autotrim property | Value |
|---|---|
| Depth hold accuracy, still water | +/- 0.14 m |
| Depth hold accuracy, 1.5 m/s current | +/- 0.42 m |
| Settling time after a 5 m step | 8.6 s |
| Overshoot | < 6% |
| Steady-state thruster draw once ballast has converged | 0.4 - 2.1 kW |
| Time to converge ballast from worst case (0.775 -> 0.169 fill) | 19.4 s |
| Ballast deadband | +/- 0.0025 m3 (prevents pump hunting) |
| Disabled when | `SILENT RUNNING` is on and `v_down` is within +/- 0.15 m/s (silent drift) |

`d_target` is set by: (a) the depth the player was at when they released the collective;
(b) the `DEPTH HOLD` bug the player can drag on the HUD depth tape; (c) `STATION KEEP` when the
player exits (4.8.4).

### 4.3.5 Added mass

The Sula displaces 2.19 m3 of water; accelerating it accelerates a comparable mass of water.
Values from an equivalent 6.40 x 2.20 x 1.55 m ellipsoid with duct corrections. `m_disp` =
`rho_w * V_disp` = 2,249 kg at the surface.

| Axis | Coefficient | Added mass / inertia | Effective total (nominal 2,456 kg wet) |
|---|---|---|---|
| Surge (Zl, fore-aft) | 0.110 * m_disp | 250 kg | 2,706 kg |
| Sway (Xl, lateral) | 0.912 * m_disp | 2,050 kg | 4,506 kg |
| Heave (Yl, vertical) | 1.334 * m_disp | 3,000 kg | 5,456 kg |
| Roll (about Zl) | - | 480 kg.m2 | 2,360 kg.m2 |
| Pitch (about Xl) | - | 5,900 kg.m2 | 14,320 kg.m2 |
| Yaw (about Yl) | - | 6,400 kg.m2 | 15,640 kg.m2 |

Implementation: added mass is applied as a **diagonal mass matrix in the body frame**. The
translation update becomes
`dv_body = M_eff^-1 * (R^T * F_world) * dt` with `M_eff = diag(m+250 for Zl ...)` and the
rotation update uses `I_eff = I + I_added`. Added mass is scaled by `beta` so it fades in over
the surface transition (4.4). Cross-coupling (Munk moment) is added explicitly:

```
M_munk = (m_a_z - m_a_x) * v_z * v_x   about Yl        // destabilising in yaw
M_munk = (m_a_z - m_a_y) * v_z * v_y   about Xl        // destabilising in pitch
```

The Munk moment is what makes a submerged body want to broach sideways; the assist counters it,
and it is one of the things that goes wrong when the flight computer is damaged (4.5.6).

### 4.3.6 Hydrodynamic drag

Quadratic (form) plus linear (skin/creeping) per body axis, in the body frame:

```
F_axis = -( B_lin * v_axis  +  0.5 * rho_w * Cd_axis * A_axis * |v_axis| * v_axis )
```

| Axis | Cd | A (m2) | 0.5*rho*Cd*A (N/(m/s)2) at surface | B_lin (N/(m/s)) |
|---|---|---|---|---|
| Surge Zl (skids retracted) | 0.190 | 3.10 | 302.5 | 60 |
| Surge Zl (skids extended) | 0.270 | 3.34 | 463.1 | 82 |
| Sway Xl | 1.050 | 6.90 | 3,720 | 900 |
| Heave Yl | 0.950 | 7.40 | 3,610 | 1,400 |

| Rotational axis | K_quad (N.m/(rad/s)2) | B_ang (N.m/(rad/s)) |
|---|---|---|
| Roll (Zl) | 620 | 380 |
| Pitch (Xl) | 5,400 | 2,600 |
| Yaw (Yl) | 6,100 | 2,900 |

Consequences (the numbers the player will feel):

| Manoeuvre | Result |
|---|---|
| Max forward speed, 25,600 N, skids in | `v = sqrt(25600 / 302.5)` = **9.20 m/s** |
| Max forward speed, skids out | 7.44 m/s |
| Max forward speed at the surface (cavitation-capped 16,800 N) | 7.45 m/s |
| Free-sink at max negative buoyancy (2,031 N) | `sqrt(2031/3610)` = **0.75 m/s** |
| Free-rise at max positive buoyancy (1,854 N) | 0.72 m/s |
| Powered vertical descent, nacelles vertical (25,600 N + 2,031 N) | `sqrt(27631/3610)` = 2.77 m/s |
| **Powered dive, nose-down 90 deg** (uses the surge axis) | **9.20 m/s** |
| Lateral translation, full lateral vector (5,320 N) | 1.20 m/s |
| Time to 1,000 m nose-down at full thrust | 109 s |
| Time to 1,000 m free-sinking, silent | 22 min 13 s |

This asymmetry is the intended play: to go deep fast you **point the nose down and fly**,
exactly like the bird the vessel is named for. To go deep *unseen*, you flood and fall in
silence for twenty minutes with your lights off.

### 4.3.7 Thruster behaviour in water

```
T_max_water(d) = 4200 + 2200 * clamp(d / 25.0, 0.0, 1.0)      // N per nacelle
```

Physical reason: cavitation. Cavitation number
`sigma = (p_amb - p_vapour) / (0.5 * rho_w * v_tip^2)`. At the surface with a 0.76 m radius
rotor at the RPM needed for 6,400 N, `sigma ~ 0.40` and the blade tips cavitate; by 25 m depth
`sigma ~ 1.4` and they do not.

| Depth (m) | T_max/nacelle (N) | Total (N) | Max speed (m/s) | Cavitation noise |
|---|---|---|---|---|
| 0 | 4,200 | 16,800 | 7.45 | loud, broadband 2-14 kHz, +18 dB detectability |
| 10 | 5,080 | 20,320 | 8.20 | moderate |
| 25 | 6,400 | 25,600 | 9.20 | none |
| >= 25 | 6,400 | 25,600 | 9.20 | none |

Additional water-specific thruster behaviour:

| Property | Value |
|---|---|
| Spool time constant | 0.340 s (water inertia in the duct) |
| Reverse thrust | 62% of forward (stator vanes are asymmetric) |
| Thrust loss when a duct is fouled (kelp, section 06) | -35% per fouled duct until cleared (reverse for 2.0 s clears it) |
| Duct blockage by silt near the seabed (< 1.2 m AGL) | -12% and a silt plume VFX |
| Efficiency vs forward speed | `eta = 0.700 * (1 - 0.028 * v)`, so at 9 m/s eta = 0.524 |
| Motor thermal limit | continuous 18 kW/nacelle; 26 kW for 120 s then derate to 12 kW |

### 4.3.8 Depth rating, creaking, pressure damage

| Hull tier | Name | Rating d_rate (m) | Test depth | Shell thickness | Mass delta | Unlock |
|---|---|---|---|---|---|---|
| 1 | Factory | 320 | 384 | 14 mm | 0 | start |
| 2 | Reinforced | 600 | 720 | 19 mm | +64 kg | 4.9 U-01 T1 |
| 3 | Deep | 1,000 | 1,200 | 25 mm | +148 kg | 4.9 U-01 T2 |
| 4 | Abyssal | 1,600 | 1,920 | 32 mm | +262 kg | 4.9 U-01 T3 |
| 5 | Hadal | 2,400 | 2,880 | 40 mm | +396 kg | 4.9 U-01 T4 |
| 6 | Trench | 4,000 | 4,800 | 52 mm | +604 kg | 4.9 U-01 T5 |

Mass delta is added to dry mass. `V_disp` is unchanged (the extra steel goes inward), so each
tier reduces reserve buoyancy - a real and welcome tradeoff: **the deeper your hull is rated,
the worse it flies.** Tier 6 dry mass is 2,454 kg; nominal operating mass 2,664 kg; T/W drops
from 1.62 to 1.26 and hover power rises from 874 kW to 1,196 kW (which exceeds continuous core
output - a Tier-6 Sula can only hover for 4.8 minutes on buffer). Players are expected to keep a
mid hull for exploration and swap to Tier 6 only for trench runs. Hull swap is done at the base
fabricator, 90 s.

**Creaking.** Below `0.72 * d_rate` the hull begins to talk.

```
stress = clamp( (d / d_rate - 0.72) / 0.28, 0.0, 1.0 )    // 0 at 72%, 1 at 100% of rating
creak_rate_hz = 1.40 * stress                              // Poisson process
creak_gain_dB = -30 + 26 * stress
```

Creak sound: synthesised, not sampled. A 3-mode resonant bank (78 / 214 / 561 Hz, Q = 26/18/11)
excited by a 4 ms exponentially-decaying noise burst, plus a pitch-swept "tick" (1.2 -> 0.6 kHz
over 90 ms). Each creak also fires a 0.008 m camera shake impulse and a 0.6 s flicker on one
random cabin light. At `stress > 0.85` the creaks come in groups of 2-4.

**Pressure damage.**

```
if d > d_rate:
    over = d - d_rate
    hull_dmg_rate = 0.85 * pow(over / 100.0, 1.60)         // percent of hull integrity per second
```

| Overshoot (m) | Damage rate (%/s) | Time from 100% to 0% |
|---|---|---|
| 10 | 0.021 | 79 min |
| 25 | 0.084 | 20 min |
| 50 | 0.280 | 5 min 57 s |
| 100 | 0.850 | 1 min 58 s |
| 200 | 2.577 | 39 s |
| 400 | 7.812 | 13 s |

Additional pressure effects, applied progressively as `d/d_rate` exceeds 1.0:

| d / d_rate | Effect |
|---|---|
| 1.00 | `DEPTH` amber annunciator, tone (4.7.9), creaking becomes continuous |
| 1.05 | Canopy micro-crack layer 1 appears (4.7.3). Permanent until repaired. |
| 1.12 | One random non-critical subsystem takes 8% damage (light, mast, arm) |
| 1.20 | `DEPTH` goes red, master warning, HUD desaturates 25% and vignettes |
| 1.30 | Canopy crack layer 2; a pinhole leak starts (0.4 L/s into the cabin) |
| 1.45 | Canopy crack layer 3; leak 2.1 L/s; cabin lighting fails |
| 1.60 | Catastrophic implosion: hull integrity forced to 0, see 4.5.7 |

The implosion is not a fade-to-black. It is: 40 ms of silence, a 132 dB impulse, the canopy
shattering inward as 340 procedurally-fractured shards (Voronoi on the canopy UV, 340 cells),
the camera dropped to a free rigid body inside a collapsing cavity, 1.8 s of bubble roar, then
the respawn handoff to section 09.

---

## 4.4 (D) THE TRANSITION - PUNCHING THE SURFACE

This is pillar P1. There is **one rigid body and one integrator**. The medium is a continuous
blend parameter. Nothing is ever teleported, reparented, or reset.

### 4.4.1 The blend parameter

```
w    = V_sub / V_disp                                     // wetted fraction, 4.3.2
beta = smoothstep(0.05, 0.95, w)                          // 0 = air, 1 = water
beta_ctrl = lowpass(beta, tau = 0.35 s)                   // control-law blend, lags to stop chatter
```

Two separate blends on purpose: the **physics** blend `beta` is instantaneous (forces must be
right the moment the hull touches water), the **control** blend `beta_ctrl` lags by 0.35 s so
the PID gains do not oscillate when a wave slaps the hull.

| Quantity | Air value | Water value | Blend |
|---|---|---|---|
| Buoyancy | 0 | `rho_w*g*V_sub` | inherent in V_sub, no beta needed |
| Aero forces (lift/drag/side) | full | 0 | `* (1 - beta)` |
| Hydro drag | 0 | full | `* beta` |
| Added mass | 0 | full | `* beta` |
| Aero damping moments | full | 0 | `* (1 - beta)` |
| Hydro damping moments | 0 | full | `* beta` |
| Munk moment | 0 | full | `* beta` |
| Max thrust per nacelle | 8,200 N | `T_max_water(d)` | see 4.4.2 |
| Spool tau | 0.180 s | 0.340 s | `mix(0.18, 0.34, beta)` |
| Attitude gains | air set | water set | `mix(..., beta_ctrl)` |
| Audio LPF cutoff | 18,000 Hz | 900 Hz | see 4.4.6 |

Water-mode PID gain set (replaces 4.2.7 values at `beta_ctrl = 1`):

| Axis | Kp_att | Kp_r | Ki_r | Kd_r | rate_max (deg/s) |
|---|---|---|---|---|---|
| Pitch | 2.80 | 5.40 | 1.60 | 0.55 | 42 |
| Roll | 3.60 | 7.20 | 2.10 | 0.48 | 70 |
| Yaw | 2.20 | 4.60 | 1.40 | 0.60 | 34 |

(Lower and softer: water is thick, the added mass is huge, and overdriving the gains would
make the vessel buzz.)

### 4.4.2 Thruster aeration dip

A duct that is half in air and half in water produces almost nothing. This is real and it is
the single most important feel element of the transition.

```
T_mult_medium = mix(1.0, T_max_water(d)/8200.0, beta)
aeration      = 1.0 - 0.45 * (4.0 * beta * (1.0 - beta))       // parabola, min 0.55 at beta=0.5
T_available   = 8200.0 * T_mult_medium * aeration
```

| beta | T_mult_medium (at d=0) | aeration | T_available (N/nacelle) | % of air max |
|---|---|---|---|---|
| 0.00 | 1.000 | 1.000 | 8,200 | 100% |
| 0.15 | 0.906 | 0.771 | 5,728 | 70% |
| 0.35 | 0.780 | 0.590 | 3,774 | 46% |
| 0.50 | 0.719 | 0.550 | 3,243 | **40%** |
| 0.65 | 0.658 | 0.590 | 3,183 | 39% |
| 0.85 | 0.567 | 0.771 | 3,585 | 44% |
| 1.00 | 0.512 | 1.000 | 4,200 | 51% |

The dip means **you cannot hover half-in the water**. Trying to hold the surface with thrust
alone results in a slow porpoise; the correct technique is to use ballast. This is taught in the
first 10 minutes of play by the shallow reef at the starting island.

Aeration also produces sound: a 0.8 - 3.5 kHz gargle, amplitude `0.9 * 4*beta*(1-beta)`, plus a
visible foam ring around each duct.

### 4.4.3 Entry: air -> water

Trigger: `w` crosses 0.05 upward with `v_normal < 0` (v_normal = component of velocity along the
water-surface normal, negative = into the water).

**Phase timeline** (t = 0 at first contact; the whole event is nominally 0.50 s):

| t (ms) | Phase | What happens |
|---|---|---|
| 0 | CONTACT | slam force begins; foam decal spawned; camera shake impulse; audio impact burst starts |
| 0-40 | SLAM PEAK | `Cs` at maximum, wetted area ramping; peak deceleration; crown splash spawns |
| 40-180 | IMMERSION | `A_wet` reaches full; buoyancy ramping in; cavity forms behind the hull |
| 120-260 | AERATION | thrust drops through the 40% notch; gargle audio; duct foam rings |
| 180-420 | CAVITY COLLAPSE | air pocket pinches off at t+340 ms, emits a re-entrant jet and a bubble cloud |
| 260-500 | SETTLE | `beta -> 1`; added mass fully engaged; control blend completes at t+850 ms |
| 500-2400 | DRAIN | 42 kg of free-flood water fills the fairing spaces; canopy sheet drains (this is the *upward* case only - see 4.4.5) |

**Slam force** (von Karman / Wagner water-entry with an exponentially decaying coefficient):

```
Cs(t)   = 4.80 * exp(-t / 0.085) + 0.90               // t in seconds since contact
A_wet(t)= 2.36 * smoothstep(0.0, 0.180, t)            // m2, ramps to full frontal area
F_slam  = -0.5 * rho_w * Cs(t) * A_wet(t) * v_n * |v_n|     // along the surface normal
```

applied at the instantaneous centre of the wetted area (roughly the lowest point of the hull),
which produces a strong **nose-up pitching moment** on a nose-down entry. That moment is real
and is the reason a badly-flown entry tumbles.

**Deceleration clamp.** To keep the simulation stable and the game playable, the solver clamps
the resulting linear deceleration to **45 m/s2 (4.6 g)** and the angular acceleration to
**9 rad/s2**. The clipped energy is not discarded - it is converted into hull damage and camera
shake, so a bad entry still hurts, it just does not launch the rigid body into a NaN.

**Entry damage:**

```
if |v_n| > 18.0:
    hull_damage_pct = 0.42 * pow(|v_n| - 18.0, 1.45)
```

| Entry speed |v_n| (m/s) | Damage (%) | Player-facing description |
|---|---|---|---|
| <= 18 | 0 | clean entry, the good sound |
| 22 | 3.4 | a thump, one creak, `HULL` amber flickers |
| 25 | 7.4 | hard, master caution, a light may fail |
| 30 | 17.7 | very hard, guaranteed subsystem damage, canopy crack layer 1 |
| 40 | 51.7 | near fatal |
| 48 | 87.4 | hull destroyed on impact |

`v_n = 18 m/s` is a **gannet-speed** entry: fast, committed, survivable, and the game rewards
learning to hit exactly that.

**Attitude bonus.** Entering nose-first (angle between the -Z axis and `v` < 20 deg) multiplies
the slam coefficient by 0.42 - a clean dive. Entering flat (belly-first, angle > 65 deg)
multiplies it by 1.65 - a belly-flop. Formula:

```
align = dot(normalize(-forward), normalize(v))         // 1 = perfect nose-first
Cs_scale = mix(1.65, 0.42, smoothstep(0.42, 0.94, align))
```

### 4.4.4 Skip off the water

At a shallow entry angle and high speed the Sula ricochets, exactly like a skipped stone or a
seaplane on a bad landing. This is a deliberate skill/failure behaviour, not a bug.

Conditions evaluated at the moment `w` crosses 0.05:

```
gamma   = asin( -v_n / |v| )                    // flight path angle below the surface, rad
v_h     = |horizontal component of v|
skip = (degrees(gamma) < 14.0) && (v_h > 26.0) && (v_n > -9.0) && (skip_count < 5)
```

If `skip`:

```
g_deg = degrees(gamma)                                    // 0 .. 14
e_n   = 0.62 - 0.020 * g_deg                              // normal restitution: 0.62 .. 0.34
e_t   = 0.88 - 0.006 * g_deg                              // tangential retention: 0.88 .. 0.80
v_n' = -v_n * e_n
v_t' =  v_t * e_t
omega_pitch += 0.55 rad/s          (nose up)
skip_count += 1
hull_damage += 0.09 * v_h          (light: 2.3% at 26 m/s, 5.6% at 62 m/s)
```

| Skip # | Typical entry v_h (m/s) | Bounce height (m) | Airborne time (s) |
|---|---|---|---|
| 1 | 48 | 2.9 | 1.54 |
| 2 | 42 | 1.6 | 1.14 |
| 3 | 37 | 0.9 | 0.85 |
| 4 | 33 | 0.5 | 0.64 |
| 5 | 29 | 0.2 | 0.41 |
| 6 | - | forced full entry (`skip_count` cap) | - |

VFX per skip: a long, flat rooster tail - 620 particles ejected in a 24 deg fan aft, initial
speed `0.55 * v_h`, lifetime 1.1-2.4 s; a 9.0 m x 1.8 m foam streak decal that fades over 8 s;
and a "shhk" transient (filtered noise, 400 Hz-6 kHz, 140 ms, -9 dBFS).
Camera: a 0.055 m vertical shake impulse plus a 2.2 deg pitch kick.
`skip_count` resets after 3.0 s with no surface contact.

To defeat skipping deliberately, the player must either steepen past 14 deg or slow below
26 m/s - which is exactly the flare-and-drop technique the game wants to teach.

### 4.4.5 Exit: water -> air

Trigger: `w` crosses 0.95 downward with `v_normal > 0`.

| t (ms) | Phase | What happens |
|---|---|---|
| 0 | BREACH | canopy is instantly sheeted with water; audio LPF begins opening; buoyancy begins falling |
| 0-220 | AERATION | ducts are full of water and must clear; thrust multiplier ramps 0.35 -> 1.0 over 300 ms with a cubic ease |
| 0-340 | DOME | a rising water dome and curtain VFX around the hull |
| 100-2400 | DRAIN (free-flood) | 42 kg of trapped water exits: `m(t) = 42 * exp(-t/0.70)` kg |
| 0-1800 | DRAIN (canopy) | sheet -> rivulets -> droplets on the glass (4.7.4) |
| 0-300 | AUDIO | LPF 900 -> 18,000 Hz, reverb wet 0.46 -> 0.12, plus a 0.9 s water-drain hiss |

Thrust recovery on breach:

```
t_since_breach in [0, 0.30]
clear = smoothstep(0.0, 0.30, t_since_breach)
T_mult_breach = 0.35 + 0.65 * clear * clear * (3.0 - 2.0 * clear)      // smootherstep-ish
```

**Ballast on breach.** The MBTs do NOT auto-blow. If the player surfaces with tanks flooded,
they are carrying 396 kg of water into the air (mass 2,456 kg, T/W 1.36). The HUD shows a
`WET` flag next to the ballast gauge, and the autotrim will blow tanks automatically only if
`AUTOTRIM` is on and `beta < 0.2` for more than 1.5 s. This teaches the player to blow before
they climb, which is the correct submarine reflex.

Breach ballistics: a Sula at full submerged thrust straight up from 20 m depth breaches at
2.77 m/s and leaves the water entirely (peak +1.9 m of air under the keel) before the thrusters
recover. The 220 ms of thrust-less ballistic flight at the top of a breach is the vessel's
signature move and should be filmed for the trailer.

### 4.4.6 Transition VFX budget

| Effect | High | Medium | Low | Lifetime | Notes |
|---|---|---|---|---|---|
| Crown splash particles | 1,400 | 620 | 260 | 0.9-2.2 s | radial cone 62 deg, v0 = 0.35*|v_n| |
| Rooster tail (skip) | 620 | 300 | 120 | 1.1-2.4 s | fan 24 deg aft |
| Cavity mesh | full (ellipsoid, 24x16 verts, animated) | simplified | none | 0.34 s to pinch | depth `1.8 * |v_n| / 10` m |
| Re-entrant jet | 180 particles | 80 | 0 | 0.7 s | fires at cavity pinch, upward, v0 = 1.4*|v_n| |
| Bubble cloud (underwater) | 300 | 140 | 60 | 4-11 s | r 3-28 mm, rise 0.18-0.32 m/s, refractive billboards |
| Foam surface decal | r = `1.2 + 0.09*|v_n|` m | same | same | 6.5 s fade | written into the ocean foam buffer |
| Duct foam rings (aeration) | 4 x 90 | 4 x 40 | 4 x 16 | 0.6 s | while `0.1 < beta < 0.9` |
| Canopy sheet -> droplets | full sim (4.7.4) | 96 droplets | static blur | 1.8 s | |
| Water dome (exit) | mesh 32x12 | 20x8 | billboard | 0.34 s | |

Total transition VFX budget: **2.1 ms GPU at High, 0.9 ms Medium, 0.35 ms Low**, on the target
GPU. If the frame budget is already blown, the cavity mesh and re-entrant jet drop first.

### 4.4.7 Transition audio

All synthesised (Web Audio). Bus: `vessel/transition`, ducks `ambient` by -8 dB for 600 ms.

| Event | Synthesis | Duration | Level |
|---|---|---|---|
| Impact burst (entry) | white noise -> 3-band shaper (60/700/4000 Hz), env A 2 ms / D 220 ms, gain `clamp(|v_n|/25, 0.2, 1.0)` | 220 ms | -4 dBFS at 25 m/s |
| Sub-impact thud | 42 Hz sine, pitch-down to 26 Hz, D 380 ms | 380 ms | -8 dBFS |
| Muffle sweep (entry) | biquad LPF on the master bus, 18,000 -> 900 Hz, exponential over 420 ms; reverb wet 0.12 -> 0.46 | 420 ms | - |
| Aeration gargle | band-passed noise 0.8-3.5 kHz, amplitude-modulated by a 14 Hz LFO, gain `0.9*4*beta*(1-beta)` | while blended | -16 dBFS peak |
| Cavity pinch | 180 Hz -> 900 Hz sine sweep in 60 ms + a 30 ms noise transient | 90 ms | -10 dBFS |
| Bubble stream | 40 grains/s, each a 6-14 ms sine chirp 700-2,600 Hz with a fast up-pitch | 4-11 s | -22 dBFS |
| Skip "shhk" | filtered noise 400 Hz-6 kHz, D 140 ms, HP-swept | 140 ms | -9 dBFS |
| Breach hiss (exit) | pink noise, HP 1.2 kHz, decaying over 900 ms | 900 ms | -14 dBFS |
| Un-muffle (exit) | LPF 900 -> 18,000 Hz over 300 ms; reverb 0.46 -> 0.12 | 300 ms | - |
| Master dip | -6 dB over 90 ms, recover over 400 ms (both directions) | 490 ms | - |

The muffle sweep is applied to **everything except the cockpit interior bus** - inside a sealed
canopy you still hear your own instruments clearly. That contrast (crisp instruments, drowned
world) is the core audio identity of SUBWAVE.

### 4.4.8 Camera shake at the transition

```
A_pos = clamp(0.0022 * pow(|v_n|, 1.70), 0.0, 0.160)    // metres
A_rot = 0.85 * A_pos                                     // radians
```

| |v_n| (m/s) | A_pos (m) | A_rot (deg) | Decay tau (s) |
|---|---|---|---|---|
| 5 | 0.031 | 1.51 | 0.28 |
| 12 | 0.146 | 7.11 | 0.42 |
| 18 | 0.160 (clamped) | 7.79 | 0.52 |
| 30 | 0.160 (clamped) | 7.79 | 0.74 |

Shake waveform: sum of 3 Perlin-noise octaves at 24 / 9 / 3.5 Hz, weights 0.5 / 0.32 / 0.18,
multiplied by `exp(-t / tau)`. Applied to the camera **only** (never to the rigid body). A
separate 1-frame chromatic-aberration pulse of 0.0035 screen-units accompanies any shake with
`A_pos > 0.09 m`.

---
## 4.5 (E) SYSTEMS

### 4.5.1 Power architecture

Two sources, one bus, one buffer.

| Element | Spec |
|---|---|
| Primary: **the Core** (sealed radiothermal lattice) | 1,100 kW continuous electrical; 1,450 kW burst for <= 90 s, then thermal derate to 780 kW until `T_core < 120 C`; no fuel consumable, no refuelling chore |
| Buffer: **energy cell** | 34.0 kWh (122.4 MJ) base; charge accept 260 kW max; discharge 900 kW max; round-trip efficiency 0.94; usable window 4% - 100% (below 4% the bus browns out) |
| Bus | 900 V DC, 88% end-to-end conversion efficiency (the missing 12% is the heat in 4.5.4) |
| Core spin-up from cold | 42 s (only after a full shutdown; the Core is otherwise always hot) |

Net cell rate: `dE/dt = min(P_core_available, 260 kW) - P_draw`, i.e. the cell only drains when
draw exceeds what the Core can supply.

**Draw table** (kW). "Typical" is the value used for the endurance estimates.

| System | Idle | Typical | Peak | Notes |
|---|---|---|---|---|
| Propulsion, air hover (nominal mass) | - | 874 | 1,806 | dominant term; see 4.2.3 |
| Propulsion, air cruise 40 m/s | - | 620 | - | |
| Propulsion, submerged cruise 3 m/s | - | 12 | - | |
| Propulsion, submerged cruise 6 m/s | - | 96 | - | |
| Propulsion, submerged max 9.2 m/s | - | 245 | 245 | drag-limited |
| Propulsion, station keep (autotrim converged) | 0.4 | 1.2 | 2.1 | |
| Avionics + flight computer | 0.9 | 0.9 | 1.2 | never sheddable |
| HUD projector + canopy layer | 0.4 | 0.4 | 0.6 | |
| Life support: O2 electrolyser | - | 1.9 | 2.4 | submerged only |
| Life support: CO2 scrubber | 0.35 | 0.35 | 0.5 | always |
| Cabin climate + defog | 0.2 | 0.6 | 1.4 | |
| Lights, all groups on | - | 1.34 | 1.61 | see 4.6 |
| Active sonar (per ping) | - | 0.9 avg | 14.0 during 40 ms burst | |
| Passive sonar / hydrophone | 0.08 | 0.08 | 0.08 | |
| Scanner | - | 2.2 | 3.1 | while scanning |
| Drill | - | 11.5 | 14.8 | while cutting |
| Arm positioning | - | 1.2 | 2.6 | |
| Ballast: MBT blow | - | 4.2 | 4.2 | while blowing |
| Ballast: trim pumps | - | 1.8 ea | 3.6 | |
| Air compressor | - | 1.1 | 1.1 | opportunistic |
| Skid actuation | - | - | 3.4 | 5.4 kJ per cycle |
| Mast actuation | - | - | 1.1 | 1.2 kJ per cycle |
| Nacelle tilt actuators | 0.1 | 0.4 | 8.4 | 4 x 2.1 kW peak |
| Thermal loop pumps | 0.3 | 0.9 | 2.2 | scales with heat rejection |
| Recall autopilot transit | - | 1.4 | 2.8 | plus propulsion |
| **Hotel load (everything but propulsion)** | **2.3** | **9.8** | **~44** | |

**Endurance** (cell only, i.e. after the Core is saturated):

| Regime | Net drain (kW) | Cell endurance from 100% |
|---|---|---|
| Submerged, everything on, cruising 6 m/s | 0 (Core covers it, charging at 994 kW) | infinite |
| Air hover, nominal | 0 (Core covers 874 kW, charging at 226 kW) | infinite |
| Air hover, Tier-6 hull (1,196 kW) | 96 | 21 min 15 s |
| Air, full thrust | 706 (core burst 1,450, then 1,026 after derate) | 2 min 53 s at burst, then 1 min 59 s |
| Air, full thrust, thermally derated core (780 kW) | 1,026 | 1 min 59 s |
| Air cruise 40 m/s | 0 | infinite |

Design intent: **you cannot run out of power by exploring. You can run out of power by
climbing.** Fuel is not a chore; altitude is a resource.

**Load shedding.** When `cell < 12%` OR `P_draw > 0.98 * P_available`, systems are shed in this
order, one per 0.5 s, each with a HUD advisory:

```
1  Drill / arm            5  Cabin climate (not defog)
2  Scanner                6  Wide low beams
3  Active sonar           7  Underside work lamp
4  Compressor             8  Forward floods (last light to go)
--- never shed: avionics, HUD, scrubber, ballast, propulsion, one cabin lamp ---
```

At `cell < 4%`: `RESERVE` red annunciator; propulsion capped at 40%; a 90 s countdown on the
HUD; at zero the Sula goes dark except for a 0.4 W emergency lamp and the depth tape, and it
drifts on whatever buoyancy it has. If it is negatively buoyant at that moment, that is a death.

### 4.5.2 Cabin oxygen

The cabin is sealed and pressurised at 1 atm regardless of depth.

| Property | Value |
|---|---|
| Free cabin air volume | 1.35 m3 |
| Cabin pressure | 101.3 kPa, 20.9% O2, held to +/- 1.5 kPa |
| Pilot O2 consumption | 0.40 L/min at rest, 0.72 L/min while operating the drill/arm |
| CO2 scrubber (regenerative amine) | 0.35 kW, removes 0.68 L/min CO2, efficiency 0.86 |
| **O2 generator (seawater electrolysis)** | 1.90 kW, produces **1.40 L/min O2** when `beta > 0.6` |
| Stored O2 reserve | 2,400 L STP in a 0.012 m3 flask at 20 MPa |
| Net O2 balance, submerged, generator running | **+1.00 L/min - the reserve refills.** Endurance: unlimited. |
| Net O2 balance, in air, generator idle | -0.40 L/min from reserve; endurance 100.0 h |
| Net O2 balance, generator FAILED or unpowered | -0.40 L/min; **reserve gives 100 h** |
| Net O2 balance, generator failed AND flask ruptured (see 4.5.6) | cabin volume only: 1.35 m3 x 0.209 = 282 L O2, usable to 16% O2 -> **46 min 12 s** |

So the brief's "unlimited O2 inside the vessel" is satisfied and *physically motivated*: the
Sula makes oxygen from the ocean. The failure state (`O2 GEN` + `O2 FLASK` both red) converts
the cockpit into a 46-minute coffin, and that is the scariest number in the game. The HUD O2
readout changes from a percentage to a **countdown in mm:ss** the moment net balance goes
negative with less than 2 h remaining.

Cabin gas detail (for the HUD and for the fogging model in 4.7.4):

| Reading | Nominal | Caution | Warning |
|---|---|---|---|
| O2 partial pressure | 20.9% | < 18.5% | < 16.0% |
| CO2 partial pressure | < 0.35% | > 0.80% | > 2.00% (headache VFX, vignette, breathing SFX) |
| Cabin temperature | 18-24 C | < 8 or > 32 C | < 2 or > 42 C |
| Relative humidity | 38-62% | > 78% (fogging begins) | > 92% |

### 4.5.3 Hull integrity

Single scalar `hull` in [0, 100] %. Sources of loss:

| Source | Rate / amount | Reference |
|---|---|---|
| Over-depth pressure | `0.85*(over/100)^1.60` %/s | 4.3.8 |
| Water entry slam | `0.42*(|v_n|-18)^1.45` % | 4.4.3 |
| Skip | `0.09 * v_h` % | 4.4.4 |
| Terrain collision | `0.30 * (v_impact - 4.0)^1.30` % for `v > 4 m/s` | contact solver |
| Creature strike | per-species, 1.5 - 22 % per hit | section 06 |
| Overspeed (air, above Vne 78 m/s) | `0.80 * (v - 78)` %/s | 4.2 |
| Overheat above 168 C | 0.90 %/s | 4.5.4 |
| Implosion | -> 0 instantly | 4.3.8 |

Integrity thresholds:

| hull | State | Consequences |
|---|---|---|
| 100-80 | NOMINAL | none |
| 80-55 | SCARRED | cosmetic dents (procedural displacement decals), 1 scratch layer on canopy |
| 55-35 | DAMAGED | canopy crack layer 1; `d_rate` effectively multiplied by 0.85; one subsystem forced to DEGRADED |
| 35-18 | CRITICAL | crack layer 2; `d_rate * 0.65`; slow leak 0.4 L/s; master warning latched |
| 18-1 | FAILING | crack layer 3; `d_rate * 0.40`; leak 2.1 L/s; cabin lighting fails; assist drops to RATE |
| 0 | DESTROYED | see 4.5.7 |

Effective depth rating: `d_eff = d_rate * hullRatingMultiplier(hull)` with the multipliers above,
smoothstep-interpolated between thresholds. The HUD redline on the depth tape moves in real time
and that movement is one of the game's best silent horror beats.

Repair: see 4.5.6.

### 4.5.4 Thermal model

One lumped thermal node for the vessel, one for the core, one for the cabin.

```
P_waste = P_draw * (1.0 - 0.88)                                   // 12% of everything is heat
Q_out   = h_eff * A_rad * (T_hull - T_env)
dT_hull/dt = (P_waste + P_core_waste - Q_out) / C_thermal
```

| Constant | Value |
|---|---|
| `A_rad` (radiator + wetted skin) | 38.0 m2 |
| `C_thermal` (vessel lumped) | 4.80e5 J/K |
| `C_core` | 1.10e5 J/K |
| `h_eff` in air | `12.0 + 2.40 * |v|` W/(m2.K) |
| `h_eff` in water | `1150.0 + 95.0 * |v|` W/(m2.K) |
| `T_env` | air: `T_air(y)`; water: `T_water(d)` from the thermocline profile |
| `P_core_waste` | `0.06 * P_core_output` (the lattice is 94% efficient) |

Blend: `h_eff = mix(h_air, h_water, beta)`.

Consequences:

| Regime | P_waste (kW) | dT/dt initial (K/s) | Time from 20 C to 145 C DERATE |
|---|---|---|---|
| Air hover, nominal (874 kW) | 105 + 53 = 158 | 0.329 | **6 min 20 s** |
| Air full thrust (1,806 kW) | 217 + 87 = 304 | 0.633 | **3 min 17 s** |
| Air cruise 40 m/s (620 kW), h_eff = 108 | 75 + 37 = 112 | 0.163 | 30 min 41 s (equilibrium at 47 C - never overheats) |
| Submerged cruise 6 m/s (96 kW), h_eff = 1,720 | 12 + 6 = 18 | 0.000 | equilibrium at `T_water + 0.28 K`. **Never.** |
| Submerged max (245 kW) | 29 + 15 = 44 | 0.000 | equilibrium at `T_water + 0.55 K`. Never. |

Thresholds and effects:

| T_hull | State | Effect |
|---|---|---|
| < 95 C | NOMINAL | - |
| 95-125 C | CAUTION | amber `HEAT`, thermal loop pumps to 2.2 kW, cabin warms 0.04 K/s |
| 125-145 C | WARNING | red `HEAT`, master caution tone every 6 s, cabin 28 C+, condensation risk on the canopy inverted (outside fogging) |
| 145 C | DERATE | thrust hard-capped to 62%; if hovering, the Sula begins to sink. Annunciator `THRUST DERATE`. |
| 168 C | CRITICAL | 0.90 %/s hull damage, cabin 42 C, HUD heat-haze shimmer applied to the whole frame at 0.004 UV amplitude |
| 185 C | SHUTDOWN | Core scrams to 180 kW for 60 s. Propulsion at 16%. **You will fall.** |

Cooling: **dive**. Entering water at 145 C drops the hull to 30 C in 11 s (a violent hiss, a
1.4 s steam plume, 400 particles, and a distinct pitched-down "quench" sound). This is a real
tactical loop: fly hard, get hot, dive to cool. Players will discover it in the first hour.

Cabin thermal (drives fogging and the temperature readout):

```
dT_cabin/dt = ( 0.018 * (T_hull - T_cabin) + P_climate_heat - 0.026 * (T_cabin - T_env) + 110 W_pilot ) / 2.1e4
```

### 4.5.5 Subsystem list

Twelve tracked subsystems, each with an independent health scalar in [0,100] and three states:
`OK` (>= 60), `DEGRADED` (20-59), `FAILED` (< 20).

| # | Subsystem | ID | OK | DEGRADED effect | FAILED effect |
|---|---|---|---|---|---|
| 1 | Nacelle FL | `THR-FL` | 8,200 N | max thrust 55%, +0.2 s spool, vibration | 0 N. See 4.5.6 asymmetry handling. |
| 2 | Nacelle FR | `THR-FR` | " | " | " |
| 3 | Nacelle RL | `THR-RL` | " | " | " |
| 4 | Nacelle RR | `THR-RR` | " | " | " |
| 5 | Flight computer | `FCS` | ASSIST/HOVER available | HOVER lost, gains at 60%, Munk moment uncompensated | assist -> MANUAL; the Sula becomes genuinely hard to fly |
| 6 | Ballast system | `BAL` | full | blow rate 45%, one MBT locked | ballast frozen at current fill; you fly it or you don't move vertically |
| 7 | Life support | `LSS` | O2 gen + scrubber | generator 40% (net -0.16 L/min), scrubber 60% | generator off, scrubber off: CO2 rises 0.68 L/min -> caution in 14 min |
| 8 | Power bus | `PWR` | 1,100 kW | core limited to 620 kW, cell accept 90 kW | core isolated; **cell only**; at 34 kWh and hotel load 9.8 kW that is 3 h 28 m of drifting |
| 9 | Lighting | `LGT` | all groups | 2 random groups dead, flicker on the rest | all exterior lights dead. In the abyss this is a death sentence unless you have a flare. |
| 10 | Sonar / mast | `SNR` | active + passive | range 40%, contacts jitter +/- 12 m, 1-in-4 contacts are **false** | no sonar. Blind. |
| 11 | Canopy | `CPY` | clear | crack layers, refraction distortion, HUD legibility -18% | crack layer 3 + leak; at hull < 18% the canopy fails outright |
| 12 | Manipulator / drill | `ARM` | full | 60% drill rate, joint 3 frozen | stowed and locked |

**Deliberately evil detail:** a `DEGRADED` sonar producing false contacts is the single most
effective dread mechanic in the design. The player cannot tell whether the blip at 140 m is a
ghost or a leviathan. Do not remove it.

### 4.5.6 Damage, failure and repair

**Damage assignment.** When the vessel takes a damage event of magnitude `D` (in hull %), the
subsystems also take damage:

```
subsystem_damage = D * severityFactor(source) * proximityWeight(subsystem, impactPoint)
```

| Source | severityFactor | Bias |
|---|---|---|
| Over-depth pressure | 0.35 | biased to CPY, BAL, LSS |
| Water slam | 0.60 | biased to nearest nacelle + CPY |
| Terrain collision | 0.90 | nearest subsystem by position |
| Creature strike | 1.10 | nearest subsystem by position |
| Overheat | 0.50 | biased to PWR, THR-* |
| Overspeed | 0.40 | biased to CPY, mast |

`proximityWeight` = `exp(-|p_sub - p_impact|^2 / (2 * 1.15^2))`, normalised over subsystems.

**Thruster-out handling.** Losing one nacelle is survivable but changes the vessel completely.
The mixer detects `T_available_i < 0.15 * T_max` and reconfigures:

| Failure | Air behaviour | Water behaviour |
|---|---|---|
| 1 nacelle out | Remaining 3 re-mixed; max hover mass drops to 1,845 kg (**you must dump cargo or you cannot hover**); a permanent 6-9 deg roll/pitch bias; yaw authority halved; `T/W = 1.19` | Fully controllable. Max speed 8.0 m/s. Slight yaw bias trimmed out by `phi`. |
| 2 out, diagonal | Cannot hover (T/W 0.81). Controlled descent only, 2.2 m/s sink, limited translation. | Controllable. Max speed 6.5 m/s. |
| 2 out, same side | Uncontrollable in air: roll authority gone. Immediate `LAND NOW`. | Marginal: 4.1 m/s, heavy sideslip, must use ballast for depth. |
| 3 or 4 out | Ballistic in air. In water: ballast only. This is the "drift home in the dark" scenario the game should engineer once, deliberately, at the end of Act 2. |

**Leaks.** A leak is a volumetric water ingress into the sealed cabin.

| Leak level | Rate | Trigger | Effects |
|---|---|---|---|
| Pinhole | 0.4 L/s | `d/d_eff > 1.30`, or CPY DEGRADED, or hull < 35% | water plane rises 0.30 m/min in the footwell; hiss SFX at 3.2 kHz; mass +0.4 kg/s (buoyancy loss!); a visible jet VFX from a specific hull point with a light-refracting cone |
| Fracture | 2.1 L/s | hull < 18%, or CPY FAILED | 1.55 m/min; the cabin floods in 10.3 min; the HUD gets water occlusion at the bottom; electrical faults begin at 24 L |
| Breach | 9.0 L/s | canopy structural failure | 6.7 min to full flood; forced ejection prompt |

Flooding water is added to `m_total` and to the free-flood inventory - **a leaking Sula gets
heavy and stops being able to ascend**, which is far more frightening than a health bar. At
120 L the vessel is 120 kg heavier: reserve buoyancy +189 kgf becomes +69 kgf. At 189 L the
vessel can no longer float at all.

Electrical fault cascade: at 24 L of cabin water, 1 random subsystem takes 15 damage every 45 s.

**Repair.** Two mechanisms:

| Method | Availability | Rate | Cost |
|---|---|---|---|
| Handheld repair tool (EVA, section 05) | anywhere, player outside the vessel | hull +2.4 %/s, subsystem +3.0 %/s on the panel you are pointing at | 0.8 kJ/s of tool cell |
| Internal patch kit | inside the cockpit, seals leaks only | leak level down one step per 8.0 s of holding `E` | 1 patch kit per step |
| Base repair bay | at the starting island / any built beacon | hull +100% and all subsystems to 100 | 90 s + resource cost from 4.9 (repair is free below 40% total damage) |
| `NANOLATTICE` upgrade (4.9 U-10) | passive | hull +0.06 %/s while `hull > 12%` and draw < 60% | 2.0 kW |

Repairs cannot exceed the cap set by the worst structural event: a hull that has been below 18%
carries a permanent `-6%` max-integrity scar until a full base rebuild. Track `hull_max` in the
save data.

**Wear.** `wearAccum` increments 0.0004 per minute of operation, +0.02 per damage event; it
drives the oxide/biofouling texture layer and, above 0.7, adds a permanent 4% drag penalty and
a 3% thrust penalty until serviced at base (60 s, free).

### 4.5.7 Destruction

When `hull` reaches 0:

| t (s) | Event |
|---|---|
| 0.00 | Audio: 40 ms of total silence (all buses ducked to -inf). This is the loudest silence in the game. |
| 0.04 | 132 dB impulse (in water: a 28 Hz thump + 4 kHz crack; in air: a metallic rupture). Screen white-flash 0.06 s, then black-crush. |
| 0.04 | Canopy fractures into 340 Voronoi shards (seeded from the canopy UV, cell centroids Poisson-disk sampled at r = 0.06 UV). Shards get rigid bodies for 6 s, then despawn. |
| 0.10 | Camera detaches: becomes a free rigid body with the pilot's mass, tumbling, 0.9 restitution off shards. |
| 0.10-1.80 | Underwater: implosion cavity collapse + bubble roar, 900 bubbles, cavity radius `3.2 m -> 0` over 0.34 s, re-entrant jet. Air: fireless structural break-up, 6 large fragments on ballistic arcs. |
| 1.80-4.00 | Sink/fall. Ambient returns filtered at 400 Hz. |
| 4.00 | Handoff to the death/respawn flow (section 09). The wreck persists in the world as a lootable site at the impact coordinates for the rest of the save. |

The wreck is recoverable: a new Sula is fabricated at base (cost in 4.9), and the wreck site
holds 60% of the cargo that was aboard plus the installed upgrade modules, salvageable by EVA.

---

## 4.6 (F) LIGHTS

Six independently toggleable groups. All are physically-based punctual/spot lights feeding both
the direct lighting pass and (selectively) the volumetric pass.

### 4.6.1 Light group table

| ID | Name | Units | Luminous flux each | Peak intensity | Cone (inner/outer, half-angle deg) | CCT (K) | Spectrum notes | Effective range, clear water (m) | Effective range, coastal water (m) | Power draw each (W) | Default |
|---|---|---|---|---|---|---|---|---|---|---|---|
| L1 | Forward floods | 2 | 26,000 lm | 78,000 cd | 9 / 17 | 5,200 | broad, slight cyan bias to punch through water | 95 | 22 | 340 | ON |
| L2 | Wide low beams | 4 | 9,000 lm | 6,400 cd | 34 / 39 | 4,300 | warm-neutral, fills the near field | 34 | 12 | 140 | ON |
| L3 | Underside work lamp | 1 | 14,000 lm | 17,800 cd | 22 / 27.5, aimed 40 deg forward-down | 5,600 | high-CRI for ore identification | 40 | 15 | 200 | OFF |
| L4 | Cabin / instrument | 3 zones | 320 lm total | - | omni, shielded | 2,700 (selectable 2,200 / 2,700 / 4,000, plus a 640 nm RED night mode) | warm, low, never in the pilot's eyeline | 2 | 2 | 20 total | ON (dim) |
| L5 | Emergency strobe | 2 | - | 220,000 cd peak | 60 / 90 | 6,500 | xenon-like, very short | 400 (visible), 0 (useful) | 120 | 90 avg (2.2 kW during the 1.2 ms flash) | OFF |
| L6 | Navigation / running | 3 | 90 lm each | 40 cd | 112.5 (port/stbd sectors), 67.5 (stern) | 640 nm red / 525 nm green / 6,000 K white | narrowband LEDs | 60 (visible) | 20 | 10 total | ON |

Total with everything on: **1,610 W**. Typical (L1+L2+L4+L6): 1,250 W.

### 4.6.2 Attenuation and water absorption

Lights are rendered with inverse-square falloff **plus** the physically-correct Beer-Lambert
absorption of the water body along the light path AND the eye path (double attenuation - this is
why underwater lights have a hard, short reach and why the beam is visible but the lit surface
is not).

```
// per light, per shaded fragment, in the fragment shader:
dL = distance(lightPos, fragPos)          // light -> surface
dE = distance(eyePos,   fragPos)          // surface -> eye
sigma = sigma_a(biome, lambda) + sigma_s(biome, lambda)      // per-metre, RGB triplet
attn  = exp(-sigma * (dL + dE))
E     = I_light * spotFalloff / (dL*dL) * attn
```

Reference extinction coefficients `sigma` (1/m), RGB, supplied by section 03 (biomes); the
values the light budget above was computed against:

| Water type | sigma_R | sigma_G | sigma_B | 1/e depth for white light |
|---|---|---|---|---|
| Clear oceanic (Type I) | 0.400 | 0.062 | 0.028 | 16 m (blue) |
| Shelf / starting reef | 0.480 | 0.108 | 0.078 | 9 m |
| Coastal / turbid | 0.720 | 0.310 | 0.410 | 2.4 m |
| Kelp / green | 0.560 | 0.085 | 0.290 | 3.4 m (green-dominant) |
| Abyssal (no organics) | 0.360 | 0.048 | 0.019 | 21 m |
| Hydrothermal plume | 1.900 | 1.740 | 1.660 | 0.6 m |

Effective range in the table in 4.6.1 is defined as the distance at which the lit surface
reaches 0.5 cd/m2 for a 0.35-albedo Lambertian target.

**Colour temperature to RGB.** The generator converts CCT to a linear-sRGB triplet at boot using
the Planckian locus (Kang et al. approximation), normalised to luminance 1:

| CCT (K) | Linear RGB (normalised) |
|---|---|
| 2,200 | (1.000, 0.478, 0.145) |
| 2,700 | (1.000, 0.560, 0.276) |
| 4,000 | (1.000, 0.751, 0.588) |
| 4,300 | (1.000, 0.780, 0.639) |
| 5,200 | (1.000, 0.855, 0.789) |
| 5,600 | (1.000, 0.884, 0.847) |
| 6,000 | (1.000, 0.911, 0.902) |
| 6,500 | (1.000, 0.941, 0.973) |

### 4.6.3 Volumetric interaction

The renderer's froxel volume (section 02) can afford a limited number of scattering lights.

| Group | Volumetric weight | Injects into froxels? |
|---|---|---|
| L1 forward floods | 1.00 | **Yes, always.** These are the beams the player steers by. Both units. |
| L3 work lamp | 0.85 | Yes at High/Medium; analytic-only at Low |
| L2 wide low beams | 0.35 | High only; treated as a single merged volumetric source at the hull centroid |
| L5 strobe | 1.40 during the flash | Yes; a single-frame high-intensity injection (this is what makes the strobe terrifying in fog) |
| L4 cabin | 0.10 | Never (interior only; contributes to canopy glare, 4.7.2) |
| L6 nav | 0.00 | Never (emissive sprite + tiny point light only) |

Hard cap: **3 volumetric light injections per frame** at High, 2 at Medium, 1 at Low. Priority
order: strobe (if flashing) > flood L > flood R > work lamp > merged low beams.

Beam shaft rendering: the froxel volume is 160x88x64 at High (view-frustum-aligned, exponential
Z distribution to 220 m), 112x64x48 Medium, 80x44x32 Low. Anisotropic Henyey-Greenstein phase
function with `g = 0.72` in water and `g = 0.42` in air (marine snow forward-scatters hard).
Temporal reprojection with a 0.92 blend factor, jittered by a 16-frame Halton sequence.

Marine snow interacts with the beams: 4,200 GPU-simulated particles within 24 m of the camera,
each rendered as a 4-8 mm sprite lit only by the vessel lights, drifting at 0.02-0.09 m/s. The
sight of your own floods full of snow, revealing nothing, is the mood target.

### 4.6.4 Lights and creature aggro

Every light contributes an **illumination stimulus** to the creature perception system
(section 06). This is the single most important reason to turn your lights off.

```
// per creature, per light, evaluated at 6 Hz (not per frame)
cosSpot = clamp( dot(lightDir, normalize(creaturePos - lightPos)), 0, 1 )
spotAtt = smoothstep(cos(outerAngle), cos(innerAngle), cosSpot)
r       = distance(lightPos, creaturePos)
S_light = (flux_lm / 1000.0) * spotAtt * exp(-sigma_lum * r) / (1.0 + 0.04 * r * r)

S_total = sum over active lights of (S_light * groupAggroWeight)
```

| Group | groupAggroWeight | Rationale |
|---|---|---|
| L1 forward floods | 1.00 | bright, directional, unmistakable |
| L2 wide low beams | 0.70 | broad but dimmer |
| L3 work lamp | 0.85 | pointed at the seabed where things live |
| L4 cabin (through the canopy) | 0.12 | dim, but **never zero** - a lit cockpit is a lure |
| L5 strobe | **2.60** | the strongest stimulus in the game |
| L6 nav lights | 0.06 | tiny, but a red/green pair is a recognisable silhouette |

Creature response classes (species assignment lives in section 06):

| Class | Behaviour vs `S_total` | Example threshold |
|---|---|---|
| PHOTOTACTIC | approaches; swarm density scales with S | attracts above S = 0.8; peak crowding at S = 14 |
| PHOTOPHOBIC | flees; deep-water default | flees above S = 0.4 |
| AGGRO-TRIGGER | ignores until `S > threshold`, then investigates, then charges | investigate at S = 2.5, charge at S = 9.0 |
| INDIFFERENT | no response | - |
| STARTLE | brief flash response only; `dS/dt > 40 /s` (i.e. a strobe or a light switching on) causes a 1.2 s panic | - |

**Silent running** (`Z`): kills L1, L2, L3, L5, L6 instantly, dims L4 to the 640 nm red mode at
28 lm, caps thrust to 22% (below cavitation and below the motor-noise threshold), disables
active sonar, and stops the ballast pumps. `S_total` drops to <= 0.004. Acoustic signature drops
by 34 dB. Power draw falls to 3.1 kW. In silent running the player descends by flooding (already
done) and drifting at 0.75 m/s in near-total darkness with only the depth tape lit. It is the
scariest and most beautiful state in the game. Design intent: **make players choose between
seeing and being seen.**

### 4.6.5 Light control UI

| Key | Action |
|---|---|
| `L` | Toggle L1 (forward floods) - the primary, most-used toggle |
| `Shift+L` | Cycle: L1 -> L1+L2 -> L1+L2+L3 -> all off -> L1 ... |
| `Ctrl+L` | Toggle L3 work lamp alone |
| `K` | Cycle cabin lighting L4: bright -> dim -> red -> off |
| `Shift+K` | Toggle L5 emergency strobe |
| `Alt+L` | Toggle L6 nav lights |
| `Z` | Silent running master (overrides everything) |

Each light group has a **dimmer**: hold the toggle key and scroll to set 10-100% in 10% steps.
Flux, power draw and aggro weight all scale linearly with the dimmer. Beam colour shifts warmer
as the dimmer drops (filament-like): `CCT_eff = CCT * (0.72 + 0.28 * dim)`.

Every light also has a 0.14 s turn-on ramp (`smoothstep`) and a 0.34 s turn-off decay with a
0.06 s phosphor tail, plus a per-unit random 1-3% flicker when the subsystem `LGT` is DEGRADED
and a 0.9 Hz brown-out flicker when `cell < 8%`.

### 4.6.6 Strobe timing

| Property | Value |
|---|---|
| Pattern | double flash: 1.2 ms on, 48 ms off, 1.2 ms on, then 1,060 ms off |
| Repetition | 0.90 Hz |
| Peak intensity | 220,000 cd |
| Average power | 90 W (2.2 kW during each flash) |
| Colour | 6,500 K, slight violet tail on decay (xenon signature) |
| Volumetric | full-strength single-frame injection; in fog or a plume this lights the entire volume for one frame |
| Purpose | (a) find your vessel from 400 m away underwater; (b) marker for a dive site; (c) a terrible idea near anything large |

---
<!--SENTINEL-C-->


