# SUBWAVE — DESIGN SECTION 06

# Bestiary, Behaviour, AI Architecture & Dread Engineering

**Status:** BINDING IMPLEMENTATION SPEC. Engineers implement exactly these numbers.
**Owns:** all non-player living entities, their simulation, animation, spawning, and the fear model.
**Does not own:** terrain generation (03), water/light transport (04), vessel systems (05), player survival stats (07), the audio synthesis engine itself (08), HUD (09).

---

## 06.0 CONVENTIONS, UNITS AND CROSS-SECTION CONTRACT

### 06.0.1 Units and axes (restated, binding)

| Quantity | Unit | Note |
|---|---|---|
| Position | metres, right-handed, +X east, +Y up, +Z south | sea level `y = 0` |
| Depth `d` | metres, `d = -y` | positive going down |
| Heading | radians internally; `0 = north (-Z)`, increasing clockwise from above | degrees only in UI |
| Linear speed | m/s | |
| Acceleration | m/s^2 | |
| Angular rate | rad/s internally, deg/s in all tables below | |
| Mass | kg | |
| Force | N | |
| Health / damage | HP | player = 100 HP max, vessel hull = 1200 HP max (assumed, see 06.0.4) |
| Frequency | Hz | audio and tail-beat both |
| Density | individuals per km^3 | land species use individuals per km^2 |
| Colour | linear sRGB triplet `(r,g,b)` in `[0,1]` unless marked HDR | emissive values may exceed 1 |

### 06.0.2 Depth bands (binding for this section)

All creature depth ranges, spawn budgets and dread rules key off these bands. Band edges overlap by design; a creature may straddle bands.

| Band | Name | Depth range (m) | Ambient scalar irradiance at noon (lux) | Colour cast |
|---|---|---|---|---|
| B0 | Emergent / Shore | `d < 0` (land) and `0 <= d < 3` | 20000 - 110000 | full spectrum |
| B1 | Sunlit Shallows | `0 <= d < 45` | 900 - 20000 | cyan-green |
| B2 | Meadow & Kelp Shelf | `30 <= d < 110` | 90 - 1400 | green-teal |
| B3 | Shelfbreak Twilight | `90 <= d < 260` | 2.0 - 140 | blue |
| B4 | Mesopelagic Drift | `240 <= d < 520` | 0.01 - 3.0 | deep blue, near-monochrome |
| B5 | Bathyal Wall | `500 <= d < 900` | 1e-5 - 0.02 | black + biolum only |
| B6 | Abyssal Plain & Vent Fields | `850 <= d < 1600` | < 1e-6 | absolute dark |
| B7 | Nethertrench & Brine Basin | `1500 <= d <= 3200` | 0 | absolute dark |
| BX | Undervault (cave network) | any depth, enclosed | 0 unless player-lit | absolute dark |

### 06.0.3 Biome ids referenced by datasheets

`BIO_ISLE` (island land), `BIO_STRAND` (beach/intertidal), `BIO_CLIFF` (sea cliffs/stacks),
`BIO_REEF` (Sunglass Reef), `BIO_MEADOW` (Ribbon Meadows seagrass), `BIO_KELP` (Amber Forest),
`BIO_FLAT` (Pale Flats sand), `BIO_RUBBLE` (boulder aprons), `BIO_STEPDOWN` (shelfbreak terraces),
`BIO_SPONGE` (Sponge Terraces), `BIO_WALL` (Bathyal Wall), `BIO_CANYON` (Longfall Canyon),
`BIO_ASHPLAIN` (Ashfall Plain), `BIO_VENT` (Emberfield hydrothermal), `BIO_BRINE` (Still Lake brine pool),
`BIO_TRENCH` (Nethertrench), `BIO_CAVE` (Undervault), `BIO_PELAGIC` (open blue water, no floor within 120 m).

### 06.0.4 Assumptions this section makes about other sections

These are **dependencies**, not decisions. If another section contradicts one, that section wins and this one is patched.

1. Player max health = 100 HP; player swim speed 1.4 m/s cruise / 2.8 m/s sprint; player O2 baseline 90 s at `d < 100`.
2. Vessel ("the *Marlin*" placeholder) hull integrity = 1200 HP; hull thickness class 3; length 7.4 m; mass 4200 kg; cruise 14 m/s submerged, 42 m/s airborne.
3. A day is 1440 s of real time (24 min). Game clock hours 0..24. Sunrise 06:00, sunset 18:00, civil twilight +-30 min.
4. Section 04 exposes, per world position, `ambientIrradiance(y, time)` in lux, `currentVelocity(p, t)` in m/s, and per-band extinction coefficients.
5. Section 03 exposes a signed-distance query `terrainSDF(p)` and gradient, plus a 2 m-resolution navigation occupancy volume for cave interiors.
6. Section 02 provides a GPU spatial-hash utility, a 4-pass LSD radix sort over u32 keys, and indirect-draw instancing.
7. Section 08 provides the synth graph primitives named in audio signatures (`osc`, `noise`, `bp`, `lp`, `fm`, `formant`, `granular`, `conv_reverb`) and a 3D panner with distance-dependent lowpass.
8. Section 09 provides windshield HUD channels: `sonarContacts[]`, `threatArc`, `depthTape`, and a proximity chime bus.
9. Section 07 defines player bleeding state (`bleed_rate` HP/s) which feeds the scent field.

---

## 06.1 AI ARCHITECTURE

### 06.1.1 Layer stack

Five layers, evaluated top-down each agent tick. Every layer is data-driven from a per-species `SpeciesDef` record; no per-species code branches are permitted outside `SpeciesDef`.

```
L5  DIRECTOR        world-level: spawn budgets, dread pacing, leviathan territory state   (1 Hz, global)
L4  UTILITY SELECT  scores 6-14 candidate Behaviours, picks one, applies inertia+cooldown  (4 Hz L0 / 1 Hz L1)
L3  HFSM            the chosen Behaviour is a small state machine of Actions with timings  (agent tick rate)
L2  STEERING        Actions emit weighted steering forces; blended, smoothed, clamped      (agent tick rate)
L1  LOCOMOTION      converts force -> acceleration with drag/buoyancy/turn-rate limits     (agent tick rate)
L0  ANIMATION       spine wave, fins, jaw, bend; skinning matrices                          (render rate)
```

Perception is a sibling service feeding L4 and L3; it runs on its own stagger schedule (06.1.7).

### 06.1.2 Agent record (CPU-side, Structure-of-Arrays)

One `AgentPool` per LOD class. SoA arrays, all `Float32Array`/`Int32Array`, capacity fixed at boot.

| Array | Type | Elements/agent | Notes |
|---|---|---|---|
| `pos` | f32 | 3 | world metres |
| `vel` | f32 | 3 | m/s |
| `orient` | f32 | 4 | quaternion xyzw |
| `angVel` | f32 | 3 | rad/s |
| `steerPrev` | f32 | 3 | for path smoothing |
| `speciesId` | u16 | 1 | index into `SpeciesDef[]` |
| `behaviour` | u8 | 1 | L4 output |
| `state` | u8 | 1 | L3 HFSM state |
| `stateT` | f32 | 1 | seconds in current state |
| `hp` | f32 | 1 | |
| `threat` | f32 | 1 | aggro accumulator, 0..3 |
| `fear` | f32 | 1 | flee accumulator, 0..3 |
| `energy` | f32 | 1 | 0..1, drives FORAGE/REST |
| `targetId` | i32 | 1 | -1 = none; encodes player as -2, vessel as -3 |
| `targetPos` | f32 | 3 | cached |
| `homePos` | f32 | 3 | territory anchor / burrow |
| `schoolId` | i32 | 1 | -1 = solitary |
| `wanderTheta` | f32 | 2 | yaw, pitch of wander target on projection sphere |
| `swimPhase` | f32 | 1 | animation phase, wraps at 2*pi |
| `lodClass` | u8 | 1 | 0/1/2 |
| `tickBucket` | u8 | 1 | round-robin scheduling slot |
| `flags` | u16 | 1 | bit 0 wounded, 1 fed, 2 lured, 3 dazzled, 4 grappling, 5 sleeping, 6 burrowed, 7 inked |

Total ~136 bytes/agent. L0 pool capacity 512, L1 pool 2048, L2 group pool 512.

### 06.1.3 Utility scoring (L4)

For each candidate behaviour `b` in the species' behaviour set:

```js
// inputs are normalized to [0,1] before curves
score(b) = w_b
         * gate_b                                     // 0 or 1 hard precondition
         * clamp( SUM_k ( a_bk * curve_bk( x_k ) ), 0, 1 )
         * inertiaBonus(b)                            // 1.18 if b === current behaviour, else 1.0
         * cooldownGate(b);                           // 0 while b is on cooldown, else 1
chosen = argmax_b score(b);                            // ties -> lowest behaviour id (deterministic)
```

Response curves (`x` in `[0,1]`):

| Curve | Formula | Used for |
|---|---|---|
| `lin` | `x` | generic |
| `inv` | `1 - x` | "closer is better" |
| `quad` | `x*x` | threat commitment |
| `sqrt` | `sqrt(x)` | hunger urgency |
| `logi(k,m)` | `1 / (1 + exp(-k*(x-m)))` | threshold-ish decisions, default `k=12, m=0.5` |
| `band(lo,hi)` | `smoothstep(lo-0.08,lo,x) * (1-smoothstep(hi,hi+0.08,x))` | depth-band preference, diel window |
| `step(t)` | `x >= t ? 1 : 0` | hard gates |

Normalized inputs available to every species (`SENSE` block):

| Input | Definition | Normalization |
|---|---|---|
| `x_threat` | threat accumulator | `T / 3.0` |
| `x_fear` | fear accumulator | `F / 3.0` |
| `x_hunger` | `1 - energy` | direct |
| `x_hp` | `hp / hpMax` | direct |
| `x_preyNear` | nearest valid prey distance | `1 - clamp(dist / R_hunt, 0, 1)` |
| `x_predNear` | nearest valid predator distance | `1 - clamp(dist / R_flee, 0, 1)` |
| `x_playerNear` | player or vessel distance | `1 - clamp(dist / R_notice, 0, 1)` |
| `x_lightOn` | player/vessel light beam incident on agent | `clamp(lux_incident / 400, 0, 1)` |
| `x_scent` | scent field sample at agent pos | `clamp(C / C_sat, 0, 1)`, `C_sat = 0.35` |
| `x_vib` | lateral-line stimulus | `clamp(S / S_sat, 0, 1)`, `S_sat = 3.0` |
| `x_night` | darkness of local ambient | `1 - clamp(log10(max(L,1e-6)/1e-6) / 11, 0, 1)` |
| `x_depthFit` | how well current depth sits in preferred band | `band(dPrefLo, dPrefHi)(d)` |
| `x_home` | distance from `homePos` | `clamp(dist / territoryR, 0, 1)` |
| `x_crowd` | neighbour count within 6 m | `clamp(n / 12, 0, 1)` |

Behaviour set (union across species; each species enables a subset):

| id | Behaviour | Typical gate | Cooldown after exit (s) |
|---|---|---|---|
| 0 | `IDLE_WANDER` | always | 0 |
| 1 | `SCHOOL` | `schoolId >= 0` | 0 |
| 2 | `FORAGE` | `x_hunger > 0.25` | 3 |
| 3 | `GRAZE` | on/near substrate | 4 |
| 4 | `SCAVENGE` | `x_scent > 0.08` | 6 |
| 5 | `INVESTIGATE` | `x_threat in [0.20, 0.55]` | 8 |
| 6 | `STALK` | `x_threat > 0.55 && hasTarget` | 10 |
| 7 | `ATTACK` | `x_threat > 1.10 && dist < R_strike*3` | 2.5 (per-species `attackCooldown`) |
| 8 | `FEED` | target dead & within 3 m | 12 |
| 9 | `FLEE` | `x_fear > 0.45` | 5 |
| 10 | `HIDE` | cover within 25 m | 9 |
| 11 | `AMBUSH_WAIT` | concealed & `x_hunger > 0.3` | 15 |
| 12 | `LURE` | `x_night > 0.85` or `d > 500` | 20 |
| 13 | `DEFEND_TERRITORY` | intruder within `territoryR` | 12 |
| 14 | `DIEL_MIGRATE` | clock in migration window | 300 |
| 15 | `REST` | `x_hunger < 0.2 && !threat` | 30 |
| 16 | `RETREAT_HEAL` | `x_hp < 0.30` | 45 |
| 17 | `JET_ESCAPE` | cephalopods only, `x_fear > 0.85` | 6 |
| 18 | `SURFACE_BREATHE` | air-breathers only, `airTimer > 0.8*airMax` | 20 |
| 19 | `NEST` | flyers only, dusk window | 120 |
| 20 | `BURROW` | burrowers only, `x_fear > 0.5` or clock | 20 |
| 21 | `FOLLOW_LIGHT` | `lightAffinity > 0 && x_lightOn > 0.15` | 6 |
| 22 | `SWARM_PULSE` | plankton only | 0 |

Re-evaluation cadence: **L0 = every 250 ms**, **L1 = every 1000 ms**, **L2 = every 4000 ms**. Forced immediate re-evaluation on: damage taken, target death, `FLEE` gate crossing, sonar ping, entering/leaving a leviathan territory.

### 06.1.4 Hierarchical FSM (L3)

Each behaviour expands to a small FSM. States carry timings, exit conditions and steering-set selections. The three combat-relevant machines are binding.

**ATTACK (all predators)** — one full cycle. `TIER` is danger tier 0..5.

| State | Duration (s) | Steering set | Notes |
|---|---|---|---|
| `AT_APPROACH` | until `dist < R_strike * 2.2` or 8.0 s | seek + obst | speed = `0.72 * burst` |
| `AT_WINDUP` | `T_windup` (table below) | arrive at strike point, no lateral | **MANDATORY TELEGRAPH**: audio cue fires at state entry (see 06.5.6) |
| `AT_LUNGE` | `T_lunge` | ballistic; steering disabled except 1 obstacle whisker | speed ramps `0.72*burst -> burst` |
| `AT_CONTACT` | 0.08 | none | hit resolution; single damage application |
| `AT_RECOVER` | `T_recover` | flee-from-contact-point, weight 0.6 | agent is vulnerable: +35% incoming damage |
| `AT_REPOSITION` | 1.2 - 4.0 (species) | wander + arrive on flank | loops to `AT_APPROACH` if threat still > 0.9 |

| Tier | `T_windup` (s) | `T_lunge` (s) | `T_recover` (s) | Extra windup if approach is from outside the player's 100 deg front cone (s) |
|---|---|---|---|---|
| 1 | 0.35 | 0.25 | 0.60 | +0.30 |
| 2 | 0.55 | 0.35 | 0.80 | +0.40 |
| 3 | 0.80 | 0.45 | 1.10 | +0.60 |
| 4 | 1.20 | 0.70 | 1.90 | +0.60 |
| 5 | 1.60 | 0.95 | 2.60 | +0.60 |

**FLEE**

| State | Duration | Notes |
|---|---|---|
| `FL_STARTLE` | 0.12 - 0.30 | C-start: body bends to a C over `T_startle`, no translation; visual tell |
| `FL_BURST` | `min(4.0, 1.5 + 2.0*fear)` | speed = `burst`, energy drains 0.22/s |
| `FL_SUSTAIN` | until `x_fear < 0.25` or 20 s | speed = `1.25 * base` |
| `FL_SETTLE` | 3.0 | speed decays to `base`; re-evaluate |

**AMBUSH_WAIT**

| State | Duration | Notes |
|---|---|---|
| `AM_SETTLE` | 1.5 | burrow/tuck into cover; opacity/dither blends to concealed material |
| `AM_HOLD` | up to 240 | near-zero motion; only gill + eye animation; lateral line at 2.0x sensitivity |
| `AM_TRIGGER` | `T_windup` | substrate puff / frond shiver + audio tell |
| -> `AT_LUNGE` | | inherits ATTACK machine |

### 06.1.5 Steering behaviours (L2) — exact formulas

All return a force vector in newtons-per-kilogram (i.e. an acceleration contribution), pre-weight.

```js
const clampLen = (v, m) => (len(v) > m ? scale(v, m/len(v)) : v);

// 1. SEEK
F_seek   = sub(scale(norm(sub(target, pos)), vMax), vel);

// 2. FLEE  (panic radius R_panic; ROLLS OFF LINEARLY to zero at it)
//
// THE RADIUS AND THE DIRECTION BOTH DEPEND ON WHAT THE THREAT IS.
//
// PREDATOR: R_panic = max(PANIC_FLOOR_M + 12 * bodyLength, R_fear), and the
//   escape is RADIAL. PANIC_FLOOR_M = 2 m, R_fear = 4 + 6 * bodyLength
//   (06.1.9's own predator radius). The max is not optional - see the note
//   below step 8.
// PLAYER: R_panic = min(2 + 2 * bodyLength, 8 m), and the escape is mostly
//   TANGENTIAL. The 2 m floor is the diver: ~1.8 m of body plus a 0.4 m
//   collision radius, and that hull is the only part with a physical
//   derivation. VESSEL: 1.9x the player's, same direction.
//
// escapeDir(u) for a predator is just u. For the diver it is the animal's own
// heading with the radial part removed, mixed back toward u by
// PLAYER_FLEE_RADIAL_FRAC = 0.2 and renormalised - 75.96 deg off the radial,
// so the animal slips PAST rather than turning its tail. See the note below.
fall     = saturate(1 - dist / R_panic);
F_flee   = scale(sub(scale(escapeDir(norm(sub(pos, threatPos))), vMax), vel), fall);

// 3. ARRIVE (slowing radius R_slow)
speedT   = vMax * min(1, dist / R_slow);
F_arrive = sub(scale(norm(sub(target,pos)), speedT), vel);

// 4. WANDER (projected sphere, distance dW ahead, radius rW, jitter j rad/s)
wanderTheta += (rand()*2-1) * j * dt;            // yaw
wanderPhi   += (rand()*2-1) * j * 0.45 * dt;     // pitch, damped
wanderPhi    = clamp(wanderPhi, -0.7, 0.7);
centre   = add(pos, scale(fwd, dW));
offset   = rotate(fwd, wanderTheta, wanderPhi) * rW;
F_wander = sub(scale(norm(sub(add(centre,offset), pos)), vMax), vel);

// 5. SEPARATION (neighbours within rSep)
acc = 0; for (n of N_sep) { dv = sub(pos, n.pos); acc += scale(dv, 1/max(dot(dv,dv), 0.04)); }
F_sep = n>0 ? sub(scale(norm(acc), vMax), vel) : 0;

// 6. ALIGNMENT (neighbours within rAli)
F_ali = n>0 ? sub(scale(norm(meanVel), vMax), vel) : 0;

// 7. COHESION (neighbours within rCoh)
F_coh = n>0 ? F_seek(meanPos) : 0;

// 8. OBSTACLE AVOIDANCE — 5 whiskers + SDF gradient fallback
lookAhead = clamp(kLA * len(vel), lookMin, lookMax);
dirs = [fwd, yaw(fwd,+25deg), yaw(fwd,-25deg), pitch(fwd,+22deg), pitch(fwd,-22deg)];
acc = 0;
for (i,d of dirs) {
  h = raymarchSDF(pos, d, lookAhead * (i===0?1.0:0.72));   // 12 steps max
  if (h.hit) {
    urgency = 1 - h.t / lookAhead;                          // 0..1
    acc += scale(h.normal, urgency*urgency * (i===0 ? 1.8 : 1.0));
  }
}
if (terrainSDF(pos) < clearanceMin) acc += scale(gradSDF(pos), 3.0);  // hard push-out
F_obst = scale(acc, vMax) ;   // NOT velocity-relative: this must dominate

// 9. DEPTH-BAND KEEPING (soft spring to [yLo, yHi], hard wall outside +-margin)
err = (pos.y > yHi) ? (pos.y - yHi) : (pos.y < yLo ? (pos.y - yLo) : 0);
F_depth = vec3(0, -kDepth * err - cDepth * vel.y, 0);       // kDepth 0.9 /s^2/m, cDepth 1.4 /s
if (abs(err) > depthHardMargin) F_depth.y *= 6.0;

// 10. PATH SMOOTHING (applied to the blended result, tau per archetype)
alpha    = 1 - exp(-dt / tauSmooth);
F_out    = lerp(steerPrev, F_blend, alpha);
steerPrev = F_out;
```

Blend and clamp:

```js
F_blend = SUM_i ( w_i * F_i );
F_out   = pathSmooth(F_blend);
F_out   = clampLen(F_out, aMax);            // aMax = archetype max acceleration, m/s^2
```

**On F_flee's falloff (2026-07-31).** This section used to specify a HARD CUT at
`R_panic` while 06.2 step 8 specified `saturate(1 - d/R_panic)` for the same
physical quantity on the GPU path. The two disagreed, the CPU shipped the hard
cut, and it was measured to make a lagoon fish a compass needle with the diver
as the magnet: over a full 360 deg orbit at 6 m around one identified Sunplate,
the animal's world heading tracked the diver's bearing with **slope 1.038,
r2 0.983 and relative-bearing concentration 0.972**, and the FLEE term delivered
**1.00 m/s2 against a net steering resultant of 0.18 m/s2**. Reported from play
as *"we can't go on their side"*. Both sections now roll off, and the whole
velocity-relative term is scaled so that it reaches exactly zero at `R_panic`
rather than degenerating to a brake.

**On R_panic's floor (2026-07-31), and what 06.2 step 8 used to say.** The floor
was 8 m and this document's own step 8 was where it came from: `R_panic_t` was
specified as **14 m for the player and 26 m for the vessel**, and `8 + 12 * L`
reproduces the 14 m exactly at a 0.5 m reference animal, with 26/14 = 1.86 being
the origin of the code's `VESSEL_PANIC_MULT` 1.9. The defect is that step 8 wrote
a CONSTANT and the implementation made it scale with the animal, so the constant
survived as a floor that dwarfs every lagoon fish: for a 0.11 m Coppersprat the
whole 9.32 m radius is 85 body lengths and the floor alone is 73 of them. **The
14 m and 26 m figures are superseded**, here and at step 8, by
`max(2 + 12 * L, R_fear)` and `1.9 x` that. Measured effect, independent pooled
probe over a 100 m swim, 15,165 observations before and 15,237 after: at 6-8 m
the relative-bearing concentration fell **0.864 -> 0.299**, the fraction of
animals presenting their tail within 45 deg of the diver **0.881 -> 0.143**, and
the mean radial velocity **+0.625 m/s away -> -0.120 m/s**, with the hard 5.69 m
exclusion zone becoming a 1.34 m minimum approach.

**The max against `R_fear` is not optional.** 06.1.9 integrates fear over its own
predator radius `4 + 6 * L`, and `2 + 12 * L` falls below that for every animal
shorter than 1/3 m — measured over the whole species table, **11 of 40 species**.
Inside that annulus the animal is in `FLEE` with a flee force of exactly zero
while 06.1.7's FLEE row multiplies SEEK and ARRIVE by 0.0, i.e. frightened into
paralysis; and because the same radius sizes the steer's predator query, it could
not have found the predator either. `tools/test-creatures.mjs` section 19 is the
guard: it measures the extra away-acceleration at 0.55, 0.85 and 0.98 of `R_fear`
for all eleven species against a control with the predator parked at 3x, and the
control differences are 0.000000 exactly.

**On R_panic and the escape DIRECTION (2026-08-02), superseding both paragraphs
above for the player and the vessel.** The same complaint came back from play a
third time — *"they always look away from us, and if we strafe around them they
rotate so we can never look at them"*, now naming **rays as well as fish**, which
is what broke the case open. A ray is `ARCH_GLIDER` with ALIGNMENT 0.20 and
COHESION 0.25, so the school-amplification hypothesis that had been carried for
a day could not explain it. Two independent defects, both above.

**(a) THE RADIUS RAN AWAY WITH THE ANIMAL.** Everything measured on this rule had
been measured on a 0.11 m Coppersprat, whose `max(2 + 12L, 4 + 6L)` is 4.66 m.
Evaluated over the rest of the roster it is **17.6 m on a 1.30 m Sandveil Ray,
30.8 m on a Ribbonwether, 57.2 m on a Gloomray, 218 m on the 18 m Veilmouth and
1154 m on a Nethercoil**, with the vessel at 1.9x all of them — 414 m and 2193 m
for the last two. This document's own art direction says following a Veilmouth
for eight minutes is an intended optional experience; at 218 m it is unreachable
by construction. The 2026-07-31 change cut the FLOOR and left the SLOPE, which is
why it fixed sprats and nothing else. The player's radius is now
`min(2 + 2 * L, 8)`, capped and split from the predator's, and it does NOT take
the `R_fear` max — that max is an argument about escaping what frightens you, and
the player frightens nothing (fear measures 0.0000 mean and max over 21,727
tier-0 observations). Worst shrink over the table: **144.3x**.

**(b) THE ESCAPE WAS RADIAL, AND THAT ALONE IS THE REPORTED SYMPTOM.** Heading is
`lookRotation` on the velocity and 06.1.6's own locomotion step re-projects the
velocity onto the heading — *"fish do not slide sideways"* — so a push straight
away from the diver **is** a turn-away, at any strength. There is no weight at
which a radial repulsion stops pointing the tail at you, and "displace without
steering the heading" is not expressible in this integrator. Only the direction
is free. MEASURED live on a 1.48 m Sandveil Ray, A/B/A with the FLEE column
zeroed for the middle arm (`tools/probes/ray-approach-ab.js`), orbiting a full
circle inside its own radius, arm A:

| | mean \|relative bearing\| | tail-on fraction |
|---|---|---|
| before, two runs | 144.6-163.8 deg | 0.833-1.000 |
| after, four runs | **80.5-92.9 deg** | **0.000-0.267** |

180 deg with tail-on 1.0 is the animal holding its tail to you through the whole
circle; ~90 deg is the flank. Quote the RANGE: run-to-run spread on one animal
is ~30 deg. **Do not quote the circular concentration here** — it measures only
whether the bearing is CONSTANT, and a perfect tangential escape pins it at
90 deg exactly as the bug pinned it at 180, so it read 0.096 / 0.998 / 0.910
over three runs of the same fixed build.

**There is no stand-off against a determined diver, before or after.** One at
3 m/s reaches the probe's own stop distance on both builds; a "1.05 m against
0.91 m" quoted here in an earlier draft was that stop distance measuring itself.
The radial share is 0.2425 of a force that also falls off linearly, and it does
not outrun a swimmer. This change is about the BEARING only.
`tools/test-creatures.mjs` **section 20** is the
guard, and it measures the delivered escape over **120 species x diver
geometry at 55.8-83.2 deg off the radial, with each geometry's mean within
1 deg of the 75.96 deg closed form** for `PLAYER_FLEE_RADIAL_FRAC = 0.2`, and
the radial component positive for every one of them. Three geometries, and each
species at its OWN depth-band midpoint, are both load-bearing: the first cut
pinned all 40 at one depth, which put 25 out of band and saturated `aMax` for 31
with the steer 99.9-100% vertical, and it read a clean 75.9 deg only because the
diver happened to be exactly horizontal. Tilted, that fixture reported 89 deg. It also pins the
predator branch at **3.6 deg off the radial** — a predator is still fled in a
straight line, because being eaten is not a photo opportunity.

Two traps that cost real time here. **Pin the ORIENTATION as well as the position
and the velocity** when measuring a steer direction offline: velocity is zeroed
at the top of each step but `_integrate` still writes a heading from it within
the step, WANDER is built from that heading, and the two arms drift apart — the
uncontrolled version read the escape angle as 41.8 deg mean with a 0.2 deg worst
case, all of it wander noise. And **do not A/B by moving the player**:
`_perceive`'s vision cone draws from the shared PRNG inside `if (pd < rEff)`, so
moving the diver changes the number of draws, exactly as removing a predator does
in section 19. Zero the weight instead.

**Also fixed in the same change, because either one alone reproduces the whole
bug.** The photophobe's reflected seek, `2 * pos - vesselPos`, is exactly
radially away and fires out to 165 m with the sub's flood on, independently of
the FLEE weight; it takes the same tangential escape now.

**And one change that was made and then REVERTED after review:** 06.1.7's
INVESTIGATE FLEE, 0.6 -> 0.15 -> 0.6. The argument was that 2.20 x 0.6 = 1.32
beats SEEK 0.40 + ARRIVE 0.39 on `ARCH_SHOALER`, so a curious animal could never
close. That is the pre-tangential world: FLEE now opposes SEEK only by its
radial share 0.2425, so SEEK already won at 0.6. Measured, three of four species
gave BIT-IDENTICAL approach trajectories at the two values and the fourth closed
to 0.20 m, inside the camera - and the column also scales the escape from a real
predator, which 0.15 weakened 4x for anything in INVESTIGATE.

### 06.1.6 Locomotion (L1)

Two modes. **Kinematic** for L1/L2 agents and all GPU boids (cheap). **Dynamic** for L0 agents.

```js
// DYNAMIC (L0)
F_drag  = scale(vel, -0.5 * rhoWater * Cd * Aref * len(vel) / mass);   // rhoWater = 1027 kg/m^3
F_buoy  = vec3(0, (buoyRatio - 1) * -9.81, 0);                        // buoyRatio 0.985..1.02
a       = add(add(F_out, F_drag), F_buoy);
vel     = clampLen(add(vel, scale(a, dt)), vMaxCurrent);
// turn-rate limit: rotate heading toward vel by at most turnRate*dt
heading = rotateToward(heading, norm(vel), turnRateRad * dt);
vel     = scale(heading, len(vel));          // fish do not slide sideways
pos     = add(pos, scale(vel, dt));

// KINEMATIC (L1/L2/GPU)
vel = clampLen(add(vel, scale(F_out, dt)), vMaxCurrent);
vel = rotateToward(vel, vel, turnRateRad*dt);  // applied as a directional clamp
pos = add(pos, scale(vel, dt));
```

`Cd` per body plan: fusiform 0.055, laterally-compressed 0.11, anguilliform 0.075, discoid/ray 0.16, gelatinous 0.42, boxy/crustacean 0.85. `Aref = 0.72 * width * height` (m^2).

Air-breathing / flying land fauna use a separate `LOCO_AIR` model: lift `L = 0.5*rhoAir*Cl*S*v^2` with `rhoAir = 1.20 kg/m^3`, `Cl` 0.9 cruise / 1.5 flare, wing area `S` from datasheet; stall at `v < vStall`.

### 06.1.7 Steering weights per archetype (BINDING)

`SEEK/FLEE/WAND/ARR/SEP/ALI/COH/OBST/DEPTH` are the blend weights `w_i`. `tau` is path-smoothing time constant (s). `aMax` m/s^2. `LA` = `[kLA, lookMin, lookMax]` for obstacle look-ahead. `rSep/rAli/rCoh` in metres.

| Archetype | SEEK | FLEE | WAND | ARR | SEP | ALI | COH | OBST | DEPTH | tau | aMax | LA (kLA/min/max) | rSep | rAli | rCoh |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `ARCH_PLANKTON` | 0.00 | 0.20 | 1.00 | 0.00 | 0.30 | 0.10 | 0.60 | 0.40 | 1.20 | 0.90 | 0.40 | 1.0/1.0/3.0 | 0.25 | 0.6 | 1.4 |
| `ARCH_SHOALER` | 0.40 | 2.20 | 0.35 | 0.30 | 1.60 | 1.10 | 0.90 | 2.00 | 0.50 | 0.12 | 9.0 | 1.5/2.0/8.0 | 0.9 | 3.2 | 5.0 |
| `ARCH_REEFDART` | 0.70 | 2.40 | 0.80 | 0.60 | 0.60 | 0.15 | 0.20 | 2.20 | 0.70 | 0.10 | 12.0 | 1.4/1.5/6.0 | 1.1 | 2.0 | 3.0 |
| `ARCH_GRAZER` | 0.50 | 1.30 | 0.60 | 0.90 | 0.70 | 0.05 | 0.35 | 1.60 | 1.40 | 0.35 | 3.0 | 1.6/2.0/6.0 | 1.8 | 4.0 | 7.0 |
| `ARCH_SCAVENGER` | 1.10 | 1.00 | 0.55 | 0.80 | 0.50 | 0.05 | 0.15 | 1.50 | 0.60 | 0.30 | 4.0 | 1.6/2.0/8.0 | 1.2 | 2.5 | 4.0 |
| `ARCH_CRUSTACEAN` | 0.60 | 1.60 | 0.45 | 1.00 | 0.80 | 0.00 | 0.10 | 2.40 | 2.00 | 0.25 | 5.0 | 1.2/1.0/4.0 | 0.8 | 0.0 | 2.0 |
| `ARCH_DRIFTER` | 0.05 | 0.10 | 0.25 | 0.00 | 0.40 | 0.00 | 0.10 | 0.30 | 1.60 | 1.60 | 0.25 | 1.0/1.0/3.0 | 2.5 | 0.0 | 6.0 |
| `ARCH_CEPHALOPOD` | 0.90 | 2.60 | 0.50 | 0.70 | 0.60 | 0.00 | 0.05 | 2.00 | 0.80 | 0.08 | 14.0 | 1.3/1.5/7.0 | 1.5 | 0.0 | 0.0 |
| `ARCH_GLIDER` | 0.55 | 1.20 | 0.70 | 0.50 | 0.45 | 0.20 | 0.25 | 1.80 | 1.10 | 0.45 | 4.0 | 1.8/3.0/12.0 | 2.2 | 6.0 | 9.0 |
| `ARCH_AMBUSHER` | 1.40 | 0.60 | 0.15 | 1.20 | 0.30 | 0.00 | 0.00 | 1.70 | 1.30 | 0.06 | 18.0 | 1.1/1.5/5.0 | 2.0 | 0.0 | 0.0 |
| `ARCH_PACK` | 1.30 | 0.80 | 0.40 | 0.90 | 1.20 | 0.80 | 0.70 | 1.90 | 0.70 | 0.10 | 11.0 | 1.6/2.0/10.0 | 2.6 | 8.0 | 14.0 |
| `ARCH_LURER` | 1.20 | 0.40 | 0.10 | 1.30 | 0.25 | 0.00 | 0.00 | 1.20 | 1.50 | 0.05 | 16.0 | 1.0/1.0/4.0 | 3.0 | 0.0 | 0.0 |
| `ARCH_FILTER_GIANT` | 0.60 | 0.30 | 0.45 | 0.70 | 0.30 | 0.10 | 0.20 | 2.60 | 1.00 | 1.10 | 1.20 | 2.4/12.0/50.0 | 14.0 | 30.0 | 55.0 |
| `ARCH_LEVIATHAN` | 1.00 | 0.10 | 0.35 | 0.85 | 0.20 | 0.00 | 0.00 | 3.00 | 0.90 | 0.55 | 3.50 | 2.6/16.0/70.0 | 20.0 | 0.0 | 0.0 |
| `ARCH_LANDWALKER` | 0.80 | 1.90 | 0.65 | 1.00 | 0.90 | 0.10 | 0.40 | 2.60 | 0.00* | 0.20 | 7.0 | 1.2/1.0/4.0 | 1.0 | 2.0 | 4.0 |
| `ARCH_FLYER` | 0.85 | 1.70 | 0.90 | 0.60 | 1.10 | 0.70 | 0.80 | 2.20 | 1.00** | 0.25 | 8.0 | 2.0/6.0/24.0 | 2.4 | 7.0 | 12.0 |
| `ARCH_BURROWER` | 0.70 | 2.00 | 0.50 | 1.10 | 0.60 | 0.00 | 0.20 | 2.00 | 1.80 | 0.18 | 6.0 | 1.0/1.0/3.0 | 1.4 | 0.0 | 3.0 |

`*` `ARCH_LANDWALKER` replaces DEPTH with a ground-clamp constraint: `pos.y = terrainHeight(x,z) + legOffset`, slope limit 42 deg.
`**` `ARCH_FLYER` DEPTH becomes altitude-band keeping against `terrainHeight`, band `[+6, +140] m` AGL.

**Per-behaviour weight multipliers.** Multiply the archetype row element-wise.
`INVESTIGATE`'s FLEE stays at **0.6**; a 2026-08-02 change to 0.15 was reverted
after review, and the reasoning is under 06.1.5 - the short form is that the
arithmetic which motivated it stopped applying once the escape went tangential,
and this column also scales the escape from a real predator.

| Behaviour | SEEK | FLEE | WAND | ARR | SEP | ALI | COH | OBST | DEPTH |
|---|---|---|---|---|---|---|---|---|---|
| `IDLE_WANDER` | 0.0 | 1.0 | 1.6 | 0.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.2 |
| `SCHOOL` | 0.3 | 1.0 | 0.6 | 0.0 | 1.3 | 1.5 | 1.4 | 1.0 | 1.0 |
| `FORAGE` | 1.2 | 1.0 | 0.9 | 1.1 | 1.0 | 0.6 | 0.6 | 1.1 | 1.0 |
| `GRAZE` | 0.6 | 1.0 | 0.4 | 1.4 | 1.1 | 0.3 | 0.5 | 1.3 | 1.6 |
| `SCAVENGE` | 1.5 | 0.8 | 0.3 | 1.2 | 0.9 | 0.2 | 0.3 | 1.0 | 0.8 |
| `INVESTIGATE` | 1.0 | 0.6 | 0.5 | 1.3 | 1.0 | 0.5 | 0.5 | 1.1 | 0.9 |
| `STALK` | 1.1 | 0.3 | 0.2 | 1.5 | 0.8 | 0.6 | 0.4 | 1.2 | 0.8 |
| `ATTACK` | 1.8 | 0.0 | 0.0 | 1.6 | 0.5 | 0.4 | 0.2 | 0.6 | 0.4 |
| `FEED` | 0.4 | 0.5 | 0.1 | 1.6 | 1.4 | 0.0 | 0.0 | 1.4 | 1.0 |
| `FLEE` | 0.0 | 2.4 | 0.4 | 0.0 | 1.6 | 1.2 | 0.8 | 1.6 | 0.5 |
| `HIDE` | 1.4 | 0.8 | 0.1 | 1.8 | 0.6 | 0.0 | 0.0 | 1.5 | 1.4 |
| `AMBUSH_WAIT` | 0.0 | 0.0 | 0.05 | 1.0 | 0.3 | 0.0 | 0.0 | 1.0 | 1.6 |
| `LURE` | 0.0 | 0.0 | 0.08 | 0.4 | 0.3 | 0.0 | 0.0 | 1.0 | 1.8 |
| `DEFEND_TERRITORY` | 1.5 | 0.0 | 0.2 | 1.2 | 0.7 | 0.3 | 0.2 | 1.0 | 0.9 |
| `DIEL_MIGRATE` | 0.2 | 0.6 | 0.3 | 0.4 | 1.0 | 1.3 | 1.2 | 1.0 | 2.6 |
| `REST` | 0.0 | 1.2 | 0.15 | 0.6 | 0.8 | 0.4 | 0.6 | 1.2 | 1.5 |
| `RETREAT_HEAL` | 0.8 | 1.6 | 0.2 | 1.4 | 0.9 | 0.0 | 0.0 | 1.3 | 1.2 |
| `JET_ESCAPE` | 0.0 | 3.2 | 0.0 | 0.0 | 0.8 | 0.0 | 0.0 | 1.9 | 0.3 |
| `FOLLOW_LIGHT` | 1.3 | 0.4 | 0.6 | 1.1 | 1.2 | 0.8 | 0.9 | 1.2 | 0.7 |
| `SWARM_PULSE` | 0.0 | 1.0 | 2.2 | 0.0 | 1.6 | 0.6 | 1.8 | 1.0 | 1.4 |

### 06.1.8 Perception model

Perception runs per agent on a stagger: L0 every 4th frame (15 Hz at 60 fps), L1 every 30th frame (2 Hz), L2 never (statistical only). Each agent's stagger offset = `agentId % staggerPeriod`.

**(a) Vision cone.** Two nested cones: a wide monocular cone and a narrow binocular cone with 1.6x effective range.

```js
// L_amb from Section 04 at agent depth+time; plus contribution from player/vessel lamps
lightGain    = clamp(pow(L_amb / 300.0, gammaV), lightFloor, 1.6);   // L_ref = 300 lux
contrastGain = 0.6 + 0.4 * targetContrast;                           // targetContrast in [0,1]
R_eff        = R_base * lightGain * contrastGain;
// attenuation through water on the sight line (Section 04 per-band c_ext)
P_see(dist)  = exp(-c_ext_photopic * dist) * (1 - smoothstep(0.55*R_eff, R_eff, dist));
inCone       = dot(fwd, norm(target - pos)) > cos(halfAngle);
detected     = inCone && rand() < P_see(dist) * motionBonus;
motionBonus  = 1.0 + 0.9 * clamp(relSpeed / 4.0, 0, 1);   // still targets are much harder to see
```

`gammaV` = 0.35 for surface species, 0.14 for deep species (dark-adapted, saturating). `lightFloor` = 0.05 surface, 0.35 deep. Deep species with `lightFloor >= 0.35` are **dazzled** by lamp lux > 2500 for 1.8 s (`flags` bit 3): `R_eff *= 0.25` and turn rate `*= 0.6`.

**(b) Lateral line / vibration sense.** Omnidirectional, unaffected by light, blocked by nothing.

```
S = SUM_over_sources ( A_src / (1 + (r / r0)^2) )      // r0 = 6.0 m reference
detected if S > S_thresh(archetype)
```

| Source | `A_src` | Notes |
|---|---|---|
| Player floating still | 0.05 | |
| Player swimming (1.4 m/s) | 0.40 | |
| Player sprint-swimming | 1.05 | |
| Player firing propulsion/tool | 2.20 | |
| Vessel idle, lights off | 0.90 | |
| Vessel idle, systems on | 1.60 | |
| Vessel cruising (14 m/s) | 6.50 | |
| Vessel full throttle | 11.0 | |
| Vessel active sonar ping | 40.0 | 1.2 s burst, `r0` extended to 40 m |
| Mining laser on rock | 6.00 | |
| Hull impact / collision | 14.0 | 0.4 s burst |
| Creature burst-swim | `0.06 * mass^(1/3) * speed` | |
| Creature death throes | `0.35 * mass^(1/3)` | 6 s decay |

**(c) Olfaction: the scent/blood diffusion field.** One shared GPU field, sampled by CPU agents through a readback ring buffer (2-frame latency, acceptable).

| Property | Value |
|---|---|
| Texture | `r16float`, 3D, 96 x 48 x 96 texels |
| World coverage | 3072 m (X) x 1536 m (Y) x 3072 m (Z), centred on player, snapped to 32 m |
| Cell size | 32 m x 32 m x 32 m |
| Update rate | 4 Hz (compute pass, 12 x 6 x 12 workgroups of 8x8x8) |
| Memory | 96*48*96*2 B = 884 KB x2 (ping-pong) |

```wgsl
// one step, dt = 0.25 s
let lap = (C[x+1]+C[x-1]+C[y+1]+C[y-1]+C[z+1]+C[z-1] - 6.0*C0) / (h*h);
let adv = dot(u, gradC);                       // u = currentVelocity(), m/s
Cn = C0 + dt * (D * lap - adv - lambda * C0) + S * dt;
// D = 6.0 m^2/s (turbulent eddy diffusivity), lambda = ln(2)/45 s^-1 (45 s half-life)
// scroll: when the player crosses a 32 m boundary the volume is shifted by whole texels, new slab = 0
```

Scent source strengths `S` (units/s injected into the containing cell):

| Event | `S` | Duration |
|---|---|---|
| Player bleeding | `0.9 * bleed_rate` | while bleeding |
| Wounded creature | `0.010 * mass^0.75` | while `hp < 0.6*hpMax` |
| Fresh corpse | `0.030 * mass^0.75 * exp(-t/180)` | 900 s |
| Harvested organic node | 0.35 | 20 s burst |
| Vessel bilge purge (player action) | 1.20 | 8 s — deliberate bait mechanic |
| Cracked ore (no scent) | 0.0 | |

Chemotaxis: when `x_scent > thresh`, add `F_seek` along `normalize(gradC)` with weight 1.5, plus a 12 deg random cone jitter (fish do not follow gradients perfectly). Below `2e-3` the field reads as zero.

**(d) Light attraction / repulsion.** Per-species `lightAffinity` in `[-1, +1]`.

```js
lux_inc  = incidentLampLux(agentPos);           // from Section 05 lamp cones, inverse-square + water extinction
xL       = clamp(lux_inc / 400, 0, 1);
if (lightAffinity > 0) {                        // phototaxis
   F += lightAffinity * 1.3 * xL * F_seek(nearestLampPos);
   threatDelta -= 0.10 * xL * dt;               // lights calm them
} else {                                        // photophobia
   F += (-lightAffinity) * 1.8 * xL * F_flee(nearestLampPos);
   threatDelta += 0.22 * (-lightAffinity) * xL * dt;   // lights irritate them
}
```

Three species (`CRT_LANTERNGAPE`, `LEV_PALEHERALD`, `CRT_VAULTSTALKER`) have `lightAffinity` that **flips sign with distance**: attracted beyond 40 m (they come to look), repelled inside 12 m (they hate being spotlit) — implemented as `lightAffinity_eff = lightAffinity * (dist > 40 ? 1 : -1)`. This produces the classic "it circled the light, then bolted, then came back" pattern.

**(e) Electroreception.** Only `ARCH_GLIDER`, `CRT_VOLTBARB`, `CRT_SALTWRAITH`, `LEV_NETHERCOIL`. Detects buried/hidden targets and powered vessel systems within `electroR` regardless of line of sight and light. Stimulus `E = P_electric / (1 + (r/2)^3)`; player = 0.15, powered vessel = 4.0, vessel with shields/scanner active = 9.0.

### 06.1.9 Threat and fear accumulators

Two identical first-order accumulators per agent.

```js
threat = threat * exp(-dt / tauThreat) + dt * SUM_j ( s_j * w_j * prox_j );
fear   = fear   * exp(-dt / tauFear)   + dt * SUM_k ( s_k * v_k * prox_k );
prox   = clamp(1 - dist / R_stim, 0, 1);
threat = clamp(threat, 0, 3.0);  fear = clamp(fear, 0, 3.0);
```

Thresholds (shared across all species; species tune only `tau` and weights):

| Threshold | Value | Effect |
|---|---|---|
| `T_notice` | 0.20 | head/eye tracks target; no behaviour change |
| `T_investigate` | 0.55 | `INVESTIGATE` becomes eligible |
| `T_commit` | 1.10 | `STALK` -> `ATTACK` eligible |
| `T_frenzy` | 2.20 | attack cooldown x0.55, windup x0.80 (never below 0.60 s for tier 4-5), ignores `FLEE` |
| `F_flinch` | 0.45 | `FLEE` eligible |
| `F_panic` | 1.30 | `FLEE` forced, `JET_ESCAPE` eligible, school fragments |

Threat stimulus weights `w_j` (per unit second, multiplied by species `aggressionScale`):

| Stimulus | `w_j` | `R_stim` (m) |
|---|---|---|
| Player/vessel simply present | 0.05 | `R_notice` |
| Player looking directly at agent (< 12 deg) | 0.06 | 30 |
| Lamp beam on agent body | 0.22 * `-min(lightAffinity,0)` | lamp range |
| Active sonar ping hitting agent | 0.90 (impulse, applied once) | 400 |
| Mining laser within 25 m | 0.35 | 25 |
| Vessel engine above 60% throttle | 0.30 | 90 |
| Damage taken from player | `2.4 * dmg / hpMax` (impulse) | n/a |
| Ally of same species killed within 40 m | 0.70 (impulse) | 40 |
| Blood in water (any) | 0.45 * `x_scent` | field |
| Player inside territory | 0.55 | `territoryR` |
| Player touching / colliding with agent | 1.10 (impulse) | n/a |

Fear stimulus weights `v_k`:

| Stimulus | `v_k` |
|---|---|
| Predator (higher tier, valid predator-of relation) within `R_flee` | 1.30 |
| Predator in `AT_LUNGE` | 2.60 (impulse) |
| Damage taken | `3.0 * dmg / hpMax` (impulse) |
| Neighbour in school entering `FL_STARTLE` | 0.85 (impulse, propagates the wave) |
| Sudden lamp appearance (delta lux > 800 in one tick) | 0.90 (impulse) for `lightAffinity < 0` |
| Sonar ping | 0.40 (impulse) |
| Vessel within 2 body lengths | 0.75 |

`tauThreat` / `tauFear` per archetype (seconds):

| Archetype | `tauThreat` | `tauFear` | `aggressionScale` |
|---|---|---|---|
| `ARCH_PLANKTON` | 4 | 3 | 0.0 |
| `ARCH_SHOALER` | 6 | 9 | 0.0 |
| `ARCH_REEFDART` | 8 | 11 | 0.1 |
| `ARCH_GRAZER` | 10 | 14 | 0.15 |
| `ARCH_SCAVENGER` | 25 | 12 | 0.35 |
| `ARCH_CRUSTACEAN` | 18 | 16 | 0.5 |
| `ARCH_DRIFTER` | 2 | 2 | 0.0 |
| `ARCH_CEPHALOPOD` | 20 | 8 | 0.6 |
| `ARCH_GLIDER` | 14 | 13 | 0.3 |
| `ARCH_AMBUSHER` | 45 | 7 | 1.0 |
| `ARCH_PACK` | 60 | 10 | 1.15 |
| `ARCH_LURER` | 55 | 6 | 0.9 |
| `ARCH_FILTER_GIANT` | 20 | 25 | 0.05 |
| `ARCH_LEVIATHAN` | 240 | 90 | 1.35 |
| `ARCH_LANDWALKER` | 12 | 10 | 0.25 |
| `ARCH_FLYER` | 9 | 8 | 0.2 |
| `ARCH_BURROWER` | 10 | 6 | 0.1 |

**Grudge memory (leviathans only).** A leviathan writes a `Grudge` record when the player damages it: `{ speciesId, lastSeenPos, decayT = 900 s, intensity }`. While a grudge is live, `threat` floor = `0.6 * intensity`, and the leviathan biases `IDLE_WANDER` targets toward `lastSeenPos` with weight 0.5. Grudges persist to IndexedDB (Section 11).

### 06.1.10 LOD-AI scheme

| Class | Range from camera | Tick rate | Steering | Perception | Animation | Rendering | Pool cap |
|---|---|---|---|---|---|---|---|
| **L0 full** | `0 - 60 m` | 30 Hz (every 2nd frame) | all 10 behaviours, dynamic locomotion, 5 obstacle whiskers | full: vision + lateral + scent + light + electro, 15 Hz | full skeleton, 8-32 bones, jaw/fin/bend | LOD0 mesh, per-instance skinning | 512 |
| **L1 reduced** | `60 - 200 m` | 10 Hz | SEEK/FLEE/WAND/ARR/SEP/OBST/DEPTH only (ALI/COH via school proxy), kinematic | vision cone + lateral line only, 2 Hz; scent read from proxy | 6-bone spine, no fins/jaw | LOD1 mesh (25% verts) | 2048 |
| **L2 statistical** | `200 - 600 m` | 0.25 Hz | none per-agent; the **group proxy** moves via a single steering agent, members are procedurally offset on a Poisson disc that rigidly follows the proxy | none | 2-bone sway, or none | LOD2 mesh (8% verts) or camera-facing impostor card | 512 groups |
| **L3 abstract** | `> 600 m` or occluded region | on region tick (1 Hz) | none | none | none | none | region population counters only |

Hysteresis: promotion uses the band edge, demotion uses `edge * 1.12` (e.g. L1->L0 at 60 m, L0->L1 at 67.2 m). Prevents thrash at the boundary.

**Promotion fidelity rule (anti-pop).** When an agent is promoted L2->L1 or L1->L0, its state is *reconstructed*, not reset: position from the proxy offset, velocity from proxy velocity + per-member deterministic noise `hash(agentId, floor(t))`, behaviour re-derived from the group's aggregate behaviour, `threat`/`fear` seeded from the group aggregate. Animation phase seeded as `hash(agentId) * 2*pi` so a promoted school does not visibly sync up.

**Leviathan exception.** Danger tier 4-5 agents never drop below L1 while inside their territory and within 900 m of the player, regardless of distance rules; they are budgeted separately (max 2 simultaneously simulated leviathans). This is what allows a leviathan to be *heard* long before it is seen.

**Tick budget.** Total AI CPU budget 2.0 ms/frame at quality tier HIGH, 1.1 ms at MEDIUM, 0.6 ms at LOW. Round-robin: `tickBucket = agentId % B`, with `B = 2` for L0, `B = 6` for L1, `B = 240` for L2. If the frame's AI time exceeds budget, the scheduler defers remaining buckets to the next frame (agents then integrate with a larger `dt`, capped at 0.25 s).

**Quality tier caps.**

| Tier | L0 cap | L1 cap | GPU boids | Scent field | Max leviathans |
|---|---|---|---|---|---|
| ULTRA | 512 | 2048 | 65536 | 96x48x96 | 2 |
| HIGH | 384 | 1536 | 49152 | 96x48x96 | 2 |
| MEDIUM | 224 | 768 | 24576 | 64x32x64 | 1 |
| LOW | 128 | 320 | 8192 | 48x24x48 | 1 |

---

## 06.2 BOIDS / SCHOOLING

### 06.2.1 Two-tier schooling

- **Named schools (CPU, L0/L1).** Up to 24 schools, up to 120 members each, simulated as real agents with the full steering stack. Used within 200 m so the player can watch individual fish react.
- **GPU boid fields (all distances).** Up to 65536 particles across up to 96 *shoals*. Used for the huge silver curtains, krill clouds and deep wisp shoals. GPU boids never take damage individually; the shoal has aggregate HP and thins visibly when predated.

A GPU shoal within 60 m of the camera is **not** promoted; instead the renderer switches its per-particle mesh to LOD0 and the CPU spawns 0-6 "hero" L0 agents that are visually identical and *do* interact (harvestable, edible, scannable). This keeps the interactive-object count bounded while the visual density stays enormous.

### 06.2.2 Boids algorithm (exact)

Per particle, per step (`dt` = 1/30 s fixed for GPU boids, sub-stepped if the frame is longer):

```
1. gather neighbours j within R_n = 5.0 m via spatial hash (max 24 sampled, see 06.2.4)
2. sep_i  = SUM_j  (p_i - p_j) / max(|p_i - p_j|^2, 0.04)              (only |d| < R_sep = 1.1 m)
3. ali_i  = mean_j(v_j) - v_i                                          (|d| < R_ali = 3.2 m)
4. coh_i  = mean_j(p_j) - p_i                                          (|d| < R_coh = 5.0 m)
5. wan_i  = curlNoise(p_i * 0.06, t * 0.25) * 1.0                      (divergence-free, no jitter state)
6. avo_i  = -gradSDF(p_i) * pow(saturate(1 - sdf(p_i)/C_clear), 2) * 4  (C_clear = 2.5 m)
7. dep_i  = (0, -kD * depthErr(p_i.y) - cD * v_i.y, 0)
8. thr_i  = SUM_threats ( escapeDir(i, t) ) * saturate(1 - |p_i-q_t|/R_panic_t)
   // escapeDir is the RADIAL u = (p_i - q_t)/|p_i - q_t| for a PREDATOR, and
   // mostly TANGENTIAL for the player and the vessel - see below.
9. lgt_i  = lightAffinity * saturate(lux(p_i)/400) * normalize(lampPos - p_i)
10. a_i   = W_sep*norm3(sep) + W_ali*ali + W_coh*coh + W_wan*wan
          + W_avo*avo + W_dep*dep + W_thr*thr + W_lgt*lgt
11. a_i   = clampLen(a_i, aMax)
12. v_i   = clampLen(v_i + a_i*dt, vMax)
13. v_i   = slerpDir(v_i, turnRate*dt)                                  (heading rate limit)
14. p_i  += v_i*dt
15. phase_i += 2*pi * f(|v_i|) * dt                                     (animation, 06.3)
```

`norm3(v)` = `v / max(|v|, 1e-4)`. Weights are the archetype row from 06.1.7 with the `SCHOOL` behaviour multiplier pre-applied and packed into the shoal's uniform block.

**Predator response (step 8).** Up to 8 threat points per shoal are uploaded per frame: the player, the vessel, and up to 6 nearby predators. `R_panic_t` = `min(2 + 2 * L, 8)` for the player and 1.9x that for the vessel, where `L` is the FLEEING animal's body length, and `max(2 + 12 * L, 4 + 6 * L)` for a predator. **This supersedes BOTH the 14 m / 26 m this line originally gave AND the `max(2 + 12 * L, 4 + 6 * L)` that replaced them for the player**; see the R_panic note under 06.1.5. When any `|p_i - q_t| < 0.55 * R_panic_t`, the shoal enters **bait-ball mode** for 6 s: `W_coh *= 2.4`, `W_sep *= 0.7`, `W_ali *= 1.6`, `vMax *= 1.35`. This produces the classic torus/bait-ball with a hole punched where the predator is.

**Flash expansion.** On a `sonar ping` or a lunge event, a one-frame impulse `v_i += norm3(p_i - q)*vMax*0.8` is applied to all particles within 12 m. Cost: one extra uniform, no state.

### 06.2.3 School sizes and cell sizes

| Shoal class | Members | `R_n` (m) | Hash cell (m) | Typical species |
|---|---|---|---|---|
| Micro-swarm (plankton) | 2000 - 12000 | 1.2 | 1.5 | `CRT_GLIMMERKRILL`, `CRT_VEILMOTE` |
| Small reef shoal | 40 - 260 | 3.0 | 3.5 | `CRT_COPPERSPRAT`, `CRT_SUNPLATE` |
| Mid shoal | 300 - 2400 | 5.0 | 6.0 | `CRT_SILVERQUILL` |
| Deep wisp shoal | 120 - 900 | 6.5 | 7.5 | `CRT_WISPLIGHT`, `CRT_PALEWANDER` |
| Pack (CPU only) | 4 - 9 | 14.0 | 16.0 | `CRT_CHISELFIN` |

Hash cell size is chosen as `1.15 * R_n` so a 3x3x3 cell neighbourhood always covers the search sphere.

### 06.2.4 GPU implementation

**Buffers** (all `storage`, `read_write` unless noted):

| Binding | Name | Type | Size (at 65536 particles) | Layout |
|---|---|---|---|---|
| 0 | `boidsIn` | `array<Boid>` | 65536 * 48 B = 3.0 MB | see below |
| 1 | `boidsOut` | `array<Boid>` | 3.0 MB | ping-pong |
| 2 | `cellKeys` | `array<u32>` | 256 KB | 30-bit Morton cell id + 2 bits shoal-class |
| 3 | `cellVals` | `array<u32>` | 256 KB | particle index |
| 4 | `cellStart` | `array<u32>` | 2^20 * 4 B = 4 MB | start offset per bucket, `0xFFFFFFFF` = empty |
| 5 | `cellCount` | `array<u32>` | 4 MB | count per bucket |
| 6 | `shoalParams` | `array<Shoal>` uniform-ish storage | 96 * 96 B = 9 KB | per-shoal weights, bounds, threats |
| 7 | `radixHist` | `array<atomic<u32>>` | 256 * numWG * 4 B | sort scratch |
| 8 | `boneOut` | `array<mat3x4f>` | see 06.3.6 | animation output for instanced skinning |
| 9 | `drawArgs` | `array<u32>` (indirect) | 96 * 20 B | per-shoal indirect draw counts |

```wgsl
struct Boid {              // 48 bytes, std430-compatible, 16-byte aligned members avoided by hand-packing
  pos      : vec3<f32>,    //  0..11
  phase    : f32,          // 12..15   swim animation phase, radians
  vel      : vec3<f32>,    // 16..27
  scale    : f32,          // 28..31   per-individual size jitter 0.82..1.18
  shoalId  : u32,          // 32..35
  flags    : u32,          // 36..39   bit0 alive, bit1 panicked, bit2 lit, bit3 eaten-this-frame
  seed     : u32,          // 40..43   hash seed for per-individual variation
  energy   : f32,          // 44..47
};

struct Shoal {             // 96 bytes
  centre     : vec3<f32>,  aabbR : f32,
  wSep : f32, wAli : f32, wCoh : f32, wWan : f32,
  wAvo : f32, wDep : f32, wThr : f32, wLgt : f32,
  vMax : f32, aMax : f32, turnRate : f32, cellSize : f32,
  yLo  : f32, yHi  : f32, baitTimer : f32, speciesId : u32,
  threatPos : array<vec4<f32>, 2>,   // xyz = pos, w = panic radius; 8 threats packed across 2 shoals' slots
};
```

**Pass sequence (per frame, one command encoder):**

| # | Pass | Kernel | Workgroup | Dispatch (N = 65536) | Cost target |
|---|---|---|---|---|---|
| 1 | `boidKeyGen` | compute cell key from `pos`, write `cellKeys`/`cellVals` | 64 | `ceil(N/64) = 1024` | 0.05 ms |
| 2 | `radixSort` x4 | 8-bit LSD radix over the 32-bit key (4 passes: histogram + scan + scatter) | 256 | `4 * (256 + 1024)` | 0.55 ms |
| 3 | `cellTableBuild` | clear + fill `cellStart`/`cellCount` from sorted keys | 64 | `ceil(N/64) = 1024` (+ clear `ceil(2^20/256)=4096`) | 0.12 ms |
| 4 | `boidStep` | the 15-step algorithm above | 64 | `1024` | 0.45 ms |
| 5 | `boidAnim` | write skinning matrices / instance transforms | 64 | `1024` | 0.18 ms |
| 6 | `boidCull` | frustum + distance cull, compact into per-shoal draw lists, write `drawArgs` | 64 | `1024` | 0.10 ms |

Total GPU boid budget: **1.45 ms** at ULTRA. On MEDIUM/LOW, the radix sort is replaced by a *rebuild-every-4-frames* cached hash (particles move < 0.4 m per frame at 3 m/s; the 15% stale-neighbour error is invisible), cutting pass 2 to 0.14 ms amortised.

**Neighbour gather in `boidStep`:**

```wgsl
let base = cellCoord(pos, S.cellSize);
var n = 0u; var sep = vec3f(0); var aliV = vec3f(0); var cohP = vec3f(0);
for (var dz = -1; dz <= 1; dz++) {
for (var dy = -1; dy <= 1; dy++) {
for (var dx = -1; dx <= 1; dx++) {
  let h = hashCell(base + vec3i(dx,dy,dz));            // 20-bit table
  let s = cellStart[h]; if (s == 0xFFFFFFFFu) { continue; }
  let c = min(cellCount[h], 8u);                        // hard cap 8 per cell => <= 216 candidates
  for (var k = 0u; k < c; k++) {
    let j = cellVals[s + k]; if (j == gid) { continue; }
    ... accumulate, break out of everything once n >= 24u ...
  }
}}}
```

Hard caps: **8 candidates per cell, 24 accepted neighbours per particle.** Deterministic (sorted order), so the simulation is reproducible from a seed — required for the save system.

**Aggregate predation.** When a predator's mouth AABB overlaps a shoal cell, a small compute pass marks up to `biteCapacity` particles' `flags` bit 3; a subsequent compaction removes them and decrements the shoal's `population` counter. A shoal below 15% of its spawn population is despawned and its species' regional budget is credited back over 300 s (06.6.4).

---

## 06.3 PROCEDURAL ANIMATION

No keyframes exist anywhere in SUBWAVE. All motion is computed from state.

### 06.3.1 Skeleton topology

Every creature has one **spine chain** plus optional **appendage chains**.

| Chain | Bones | Notes |
|---|---|---|
| Spine | 4 - 16 (`N_spine`) | root at head or at centre-of-mass depending on `spineRootMode` |
| Pectoral L/R | 1 - 3 each | fins, wings, flippers, claws |
| Pelvic/anal | 0 - 2 | |
| Caudal | 1 - 2 | tail fin, often driven directly by spine tip |
| Jaw | 0 - 2 | lower jaw + optional pharyngeal |
| Tentacle | 0 - 10 chains of 4 - 8 | cephalopods, siphonophores |
| Illicium (lure) | 0 - 1 chain of 3 | anglerfish-analog |

Hard limits: `MAX_BONES_PER_SKELETON = 32`, `MAX_SKINNED_INSTANCES = 384` (ULTRA). Leviathans get a dedicated exemption to 48 bones with `MAX_LEVIATHAN_INSTANCES = 2`.

### 06.3.2 The travelling-wave swimming formula (BINDING)

For spine bone `i` with normalized arclength `u_i = s_i / L` in `[0,1]` (0 = snout, 1 = tail tip):

```js
U      = speed / L;                                         // body-lengths per second
f      = clamp(f0 + kf * U, fMin, fMax);                    // tail-beat frequency, Hz
A      = A0 + (A1 - A0) * clamp((U - U0) / (U1 - U0), 0, 1); // peak tail amplitude, body lengths
env(u) = c0 + c1*u + c2*u*u;                                // amplitude envelope, normalized env(1) = 1
phase  = 2*PI * f * t  -  2*PI * u_i / lambdaB  +  psi;     // lambdaB = body wavelength, body lengths
lat(u) = A * env(u) * sin(phase);                           // lateral displacement, body lengths

// Bone yaw is the local slope of the body curve, i.e. d(lat)/du scaled by segment length:
dlat_du = A * ( (c1 + 2*c2*u) * sin(phase) - (2*PI/lambdaB) * env(u) * cos(phase) );
yawSwim_i = atan( dlat_du * (L / N_spine) ) * kYaw;         // kYaw = per-species gain, default 1.0
```

The three classic swim modes fall out of `lambdaB`, `env` and which bones are enabled:

| Mode | `lambdaB` (body lengths) | `c0, c1, c2` | Active spine fraction | Species examples |
|---|---|---|---|---|
| Anguilliform (eel) | 0.65 | `0.10, 0.20, 0.70` | `u > 0.05` | Hagline, Saltwraith, Nethercoil |
| Sub-carangiform | 0.85 | `0.06, -0.13, 1.07` | `u > 0.25` | Coppersprat, Chiselfin |
| Carangiform | 1.00 | `0.02, -0.28, 1.26` | `u > 0.45` | Silverquill, Hollowjaw |
| Thunniform | 1.25 | `0.01, -0.35, 1.34` | `u > 0.70` | Pale Herald, Gloomray (partial) |
| Ostraciiform (fin-only) | n/a | `0,0,1` on caudal bone only | `u > 0.92` | Bloatspine, Tideclaw swimming |
| Rajiform (wave along fin) | 1.40 (across span, not length) | `0.00, 0.30, 0.70` | pectoral strips | Sandveil Ray, Gloomray |
| Jet (pulsed) | n/a | mantle contraction envelope | mantle bones | Ninearm, Umbral Squid, jellies |

Rajiform detail: the wave travels along the **span** coordinate `w` in `[0,1]` from body to wingtip and along the **chord** coordinate for the actual undulation:
`zFin(w, c) = Afin * (0.2 + 0.8*w) * sin(2*PI*fFin*t - 2*PI*c/lambdaFin)` with `lambdaFin` = 0.9 chord lengths, `fFin` = `0.6 + 1.1*U` Hz.

Jet detail: mantle scale `m(t) = 1 - Ajet * pulse(t)` where `pulse` is a 0.18 s ease-in contraction followed by a 0.62 s ease-out refill; thrust impulse `J = mJet * Ajet * 3.2` N.s applied at contraction start. Tentacles trail with a damped-spring chain (`k = 40 /s^2`, `c = 7 /s`) so they whip believably.

### 06.3.3 Turning, banking and startle

```js
// body bend into a turn (yaw rate omegaY in rad/s, positive = turning right)
bendTurn = clamp(-omegaY * kBend, -bendMax, bendMax);         // radians, total across chain
wBend(u) = pow(u, 1.5);                                       // distributed toward the tail
// banking roll (fish and rays roll into turns, leviathans roll slowly)
bank     = clamp(atan2(speed * omegaY, 9.81), -rollMax, rollMax) * kRoll;
wRoll(u) = 1 - 0.6*u;                                         // mostly at the shoulders
// C-start startle (FL_STARTLE): a single half-cycle at 4x amplitude
startle(u,tau) = 4.0 * A * env(u) * sin(PI * clamp(tau/T_startle,0,1)) * sgn;
```

Final per-bone local Euler (applied in ZYX order, in bone-local space):

```js
yaw_i   = yawSwim_i + bendTurn * wBend(u_i) + startle_i + pursuitLead_i;
pitch_i = Ap * envP(u_i) * sin(2*PI*fp*t - 2*PI*u_i/lambdaP) + climbBend * wBend(u_i);
roll_i  = bank * wRoll(u_i) + spiralRoll_i;
```

`pursuitLead_i`: during `AT_APPROACH`/`AT_LUNGE`, bones `u < 0.3` get an extra `0.35 * angleToTarget * (1 - u/0.3)` so the head visibly aims at the player. This is the single most important readability cue for predators.

`Ap` (dorsoventral amplitude) is 0 for most fish, `0.6 * A` for `LEV_PALEHERALD` (up-down tail like a cetacean), and `0.25 * A` for rays.

### 06.3.4 Fins, jaw, gills, eyes

```js
// FIN FLUTTER (pectorals, pelvics)
Af   = Af0 + (Af1 - Af0) * clamp(U / U1, 0, 1);       // amplitude shrinks at speed (fins fold back)
ff   = f * mFin;                                       // mFin: 1.0 (synced) or 2.0 (double-beat)
finAngle = Af * sin(2*PI*ff*t + phiFin) + trimFin;
trimFin  = kFinTurn * omegaY * (side === LEFT ? +1 : -1) + kFinPitch * omegaP;
// braking: during AT_RECOVER and FL_SETTLE, trimFin += 0.9 rad (fins flare forward)

// JAW
jawOpen(t) = jawMax * J(tau);
J: AT_WINDUP  -> smoothstep(0, 1, tau/T_windup) * 0.30
   AT_LUNGE   -> 0.30 + 0.70 * smoothstep(0, 1, tau/(0.55*T_lunge))
   AT_CONTACT -> 1.0 - smoothstep(0, 1, tau/0.06)          // snap shut in 60 ms
   FEED       -> 0.45 + 0.25*sin(2*PI*1.6*t)                // rhythmic chewing
   idle       -> 0.04 + 0.03*sin(2*PI*0.25*t + seed)        // gentle respiration

// GILL FLUTTER (opercula)
gill = 0.5 + 0.5*sin(2*PI*(0.55 + 0.9*U + 1.4*stress)*t + seed);   // stress = clamp(fear,0,1)

// EYES (2 quads or 2 bones)
eyeYaw = clamp(angleTo(interestTarget), -0.55, 0.55) rad, slewed at 3.5 rad/s
blink: Poisson, mean interval 4.2 s, duration 0.12 s (species with eyelids only)
```

### 06.3.5 Per-archetype animation parameters (BINDING)

`f0/kf` in Hz, `fMin/fMax` Hz, `A0/A1` in body lengths, `U0/U1` in body-lengths/s, `lambdaB` body lengths, `bendMax`/`rollMax` in degrees, `T_startle` s.

| Archetype | `N_spine` | Mode | `f0` | `kf` | `fMin` | `fMax` | `A0` | `A1` | `U0` | `U1` | `lambdaB` | `bendMax` | `rollMax` | `T_startle` | `mFin` | `Af0/Af1` (deg) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `ARCH_PLANKTON` | 3 | anguilliform | 3.2 | 1.4 | 2.0 | 9.0 | 0.09 | 0.16 | 0.5 | 4.0 | 0.60 | 20 | 5 | 0.06 | 2.0 | 22/8 |
| `ARCH_SHOALER` | 7 | sub-carangiform | 1.1 | 1.15 | 0.8 | 8.5 | 0.06 | 0.11 | 0.8 | 7.0 | 0.85 | 34 | 26 | 0.12 | 1.0 | 30/9 |
| `ARCH_REEFDART` | 6 | sub-carangiform | 1.4 | 1.05 | 0.9 | 8.0 | 0.05 | 0.12 | 0.6 | 6.5 | 0.82 | 42 | 34 | 0.10 | 2.0 | 42/14 |
| `ARCH_GRAZER` | 8 | carangiform | 0.7 | 0.90 | 0.4 | 4.5 | 0.05 | 0.09 | 0.4 | 3.0 | 0.95 | 26 | 14 | 0.20 | 1.0 | 26/12 |
| `ARCH_SCAVENGER` | 12 | anguilliform | 0.9 | 1.00 | 0.5 | 5.5 | 0.11 | 0.19 | 0.4 | 3.5 | 0.65 | 60 | 8 | 0.16 | 1.0 | 14/6 |
| `ARCH_CRUSTACEAN` | 4 | ostraciiform + legs | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | - | - | - | 12 | 6 | 0.09 | 3.2 | - |
| `ARCH_DRIFTER` | 5 | jet (bell pulse) | 0.35 | 0.25 | 0.2 | 1.1 | 0.14 | 0.22 | 0.1 | 0.8 | - | 8 | 3 | 0.5 | 1.0 | - |
| `ARCH_CEPHALOPOD` | 6 | jet + fin ripple | 0.9 | 0.6 | 0.4 | 3.0 | 0.08 | 0.13 | 0.3 | 5.0 | - | 30 | 40 | 0.07 | 1.5 | 20/10 |
| `ARCH_GLIDER` | 6 | rajiform | 0.45 | 0.75 | 0.25 | 3.2 | 0.10 | 0.20 | 0.3 | 3.0 | 1.40 | 22 | 30 | 0.22 | 1.0 | - |
| `ARCH_AMBUSHER` | 9 | sub-carangiform | 0.5 | 1.60 | 0.2 | 9.5 | 0.04 | 0.19 | 0.2 | 9.0 | 0.78 | 55 | 22 | 0.07 | 1.0 | 34/10 |
| `ARCH_PACK` | 8 | carangiform | 1.2 | 1.10 | 0.8 | 7.5 | 0.05 | 0.11 | 0.8 | 8.0 | 1.00 | 40 | 38 | 0.09 | 1.0 | 28/8 |
| `ARCH_LURER` | 7 | sub-carangiform | 0.30 | 1.90 | 0.15 | 8.0 | 0.05 | 0.21 | 0.1 | 7.0 | 0.80 | 48 | 12 | 0.08 | 1.0 | 30/12 |
| `ARCH_FILTER_GIANT` | 14 | carangiform | 0.22 | 0.45 | 0.12 | 0.95 | 0.03 | 0.07 | 0.15 | 1.2 | 1.10 | 16 | 12 | 0.9 | 1.0 | 18/10 |
| `ARCH_LEVIATHAN` | 16 (48 for coil) | thunniform / anguilliform | 0.16 | 0.55 | 0.08 | 1.30 | 0.03 | 0.09 | 0.1 | 1.6 | 1.25 | 30 | 20 | 0.6 | 1.0 | 20/10 |
| `ARCH_LANDWALKER` | 5 | leg-gait | - | - | - | - | - | - | - | - | - | 18 | 10 | 0.10 | - | - |
| `ARCH_FLYER` | 5 | wing-beat | 2.4 | 0.35 | 0.0 | 5.5 | 0.30 | 0.45 | 0.5 | 12.0 | - | 24 | 55 | 0.12 | 1.0 | 62/38 |
| `ARCH_BURROWER` | 6 | leg-gait + dig | - | - | - | - | - | - | - | - | - | 22 | 12 | 0.08 | - | - |

**Leg gaits** (`ARCH_LANDWALKER`, `ARCH_CRUSTACEAN`, `ARCH_BURROWER`): procedural IK, `nLegs` 4/6/8/10, alternating-tripod or trot phase offsets `phi_leg = 2*PI * legIndex / nLegs + (gaitOffset)`. Step cycle frequency `fStep = clamp(speed / strideLength, 0.4, 4.5)` Hz; foot target = ray-cast to terrain at `hipPos + fwd*strideLength*0.5`; foot lifts on a parabola of height `0.22 * strideLength`. Two-bone analytic IK per leg (law of cosines), 0.03 ms for 40 legs.

### 06.3.6 Skinning in the vertex shader

**Vertex layout** (interleaved, 32 B stride):

| Offset | Attribute | Format | Notes |
|---|---|---|---|
| 0 | `position` | `float32x3` | model space, metres |
| 12 | `normal` | `snorm16x2` | octahedral-encoded |
| 16 | `uv` | `unorm16x2` | 0..1 |
| 20 | `boneIndices` | `uint8x4` | into the instance's bone palette |
| 24 | `boneWeights` | `unorm8x4` | normalized to sum 255 at bake time |
| 28 | `extra` | `unorm8x4` | x = inflate weight, y = biolum mask, z = fin-ripple phase offset, w = wear/detail mask |

**Bone palette buffer:** `array<mat3x4<f32>>` — 48 bytes per bone, row-major 3x4 (rotation+translation; no non-uniform scale except a per-bone uniform scale packed in `w` of row 0, used by jelly bells and the Bloatspine inflation).

Palette size = `MAX_SKINNED_INSTANCES * MAX_BONES_PER_SKELETON * 48 B` = `384 * 32 * 48` = **589,824 B (576 KB)**. Leviathan palette is a separate buffer: `2 * 48 * 48` = 4,608 B.

```wgsl
struct Inst { boneBase: u32, tint: u32, biolumPhase: f32, inflate: f32,
              modelRow0: vec4f, modelRow1: vec4f, modelRow2: vec4f };  // 64 B

@vertex fn vs(v: VIn, @builtin(instance_index) ii: u32) -> VOut {
  let inst = insts[ii];
  var p = v.position + v.normal * (inst.inflate * v.extra.x * inflateScale);  // blend-shape-free inflation
  var skinned = vec3f(0.0);
  var nrm     = vec3f(0.0);
  for (var k = 0u; k < 4u; k++) {
    let w = v.boneWeights[k];
    if (w == 0.0) { break; }                       // early-out: most verts use 2
    let m = bones[inst.boneBase + v.boneIndices[k]];
    skinned += w * (m * vec4f(p, 1.0));
    nrm     += w * (mat3x3f(m[0].xyz, m[1].xyz, m[2].xyz) * v.normal);
  }
  ...
}
```

Influence limits: **4 per vertex maximum**, 2 for LOD1, 1 for LOD2. Weight normalization enforced at mesh-generation time.

**Bone matrix computation is done on the GPU**, not the CPU: a `skeletonSolve` compute pass, one workgroup of 64 threads handling 64 skeletons (thread `n` walks its own 32-bone chain serially — chains are short and the branch is coherent within a species). Input: `array<AnimState>` (48 B: pos, quat, speed, phase, behaviour, stateT, bendTurn, bank, jawOpen, fearLevel). Dispatch `ceil(instanceCount/64)`. Cost 0.09 ms for 384 instances.

**Vertex counts** are per LOD0 and are given per species in 06.4. LOD1 = 25%, LOD2 = 8%, generated by a deterministic edge-collapse at mesh-build time (Section 02 utility). Impostors: 8-angle octahedral atlas baked once at first spawn into a `1024x1024 rgba8` array texture slice, 0.6 ms one-off.

### 06.3.7 Procedural mesh generation primitives (referenced by every datasheet)

| Recipe token | Meaning | Typical cost |
|---|---|---|
| `LATHE(profile[], segs)` | revolve a 2D profile of `n` control points around +X, `segs` radial | verts = `n * segs` |
| `LOFT(rings[], segs)` | sweep a varying ellipse along the spine; each ring `(y, z, radiusY, radiusZ, roll)` | verts = `rings * segs` |
| `SDF_MC(sdf, res, box)` | marching cubes over a compact SDF at `res^3` | verts ~ `0.12 * res^2 * faces` |
| `FIN(strip, chordFn, camber)` | ruled surface fin, `strip` spanwise samples x 2 chord rows, thickened | verts = `strip * 6` |
| `TUBECHAIN(pts[], segs, rFn)` | tube around a polyline (tentacles, worms) | verts = `pts * segs` |
| `SHELLPLATE(n, ...)` | convex-hulled carapace plates for crustaceans | verts ~ `n * 40` |
| `BELL(profile, segs, frills)` | jellyfish bell + tentacle emitters | verts = `profile*segs + frills*8` |
| `NOISE_DISP(mesh, oct, amp, freq)` | displace along normal by fBm; `amp` in metres | 0 extra verts |
| `SYM(x)` | mirror across the YZ plane | doubles verts |

All meshes are generated once per species at first spawn, cached in a `GPUBuffer` pool, and instanced. Budget: **< 6 ms total** for all 37 species' LOD0+LOD1+LOD2, generated lazily on region entry, spread across frames by a build queue with a 1.5 ms/frame cap.

---

## 06.4 THE BESTIARY

### 06.4.0 How to read a datasheet

- **Depth** is `d = -y` in metres. Land species use altitude AGL.
- **Density** is the *target statistical density* used by the spawn director (06.6), in individuals per km^3 of habitable volume inside the species' biome+band intersection. Instantiated counts are hard-capped separately.
- **Activity** gives the diel multiplier applied to spawn weight and to `IDLE_WANDER` speed: `day / night` as two scalars in `[0,2]`. Values are sampled with `band()` over the game clock.
- **Light affinity** is `lightAffinity` in `[-1,+1]` per 06.1.8(d). `+/-` prefixed values that flip with distance are marked `flip@Xm`.
- **Damage/hit** is applied to the player (100 HP) or, in brackets, to the vessel hull (1200 HP).
- **Threat tau** is `tauThreat` in seconds; the fear tau follows the archetype default unless stated.
- **Audio** gives the fundamental and the synthesis character. All sounds are Web Audio graphs, no samples.
- Every creature is edible/harvestable unless stated; nutrition and material yields are Section 10's problem, not this one.

### 06.4.1 Roster index

| # | id | Common name | Tier | Bands | Primary biomes | Length (m) | Archetype |
|---|---|---|---|---|---|---|---|
| 1 | `CRT_TIDECLAW` | Tideclaw | 0 | B0 | BIO_STRAND, BIO_ISLE | 0.34 | ARCH_CRUSTACEAN |
| 2 | `CRT_VANESKIMMER` | Vaneskimmer | 0 | B0 air | BIO_CLIFF, BIO_ISLE | 1.10 wingspan | ARCH_FLYER |
| 3 | `CRT_DUNECREST` | Dunecrest | 0 | B0 | BIO_ISLE | 0.62 | ARCH_BURROWER |
| 4 | `CRT_SALTMOTH` | Saltmoth | 0 | B0 air | BIO_ISLE, BIO_CLIFF | 0.19 wingspan | ARCH_FLYER |
| 5 | `CRT_GLIMMERKRILL` | Glimmerkrill | 0 | B1-B4 | all pelagic | 0.021 | ARCH_PLANKTON |
| 6 | `CRT_VEILMOTE` | Veilmote | 0 | B1-B5 | BIO_PELAGIC | 0.07 | ARCH_DRIFTER |
| 7 | `CRT_COPPERSPRAT` | Coppersprat | 0 | B1-B2 | BIO_REEF, BIO_MEADOW | 0.11 | ARCH_SHOALER |
| 8 | `CRT_SUNPLATE` | Sunplate | 0 | B1 | BIO_REEF | 0.24 | ARCH_REEFDART |
| 9 | `CRT_REEFCROPPER` | Reefcropper | 0 | B1-B2 | BIO_REEF, BIO_RUBBLE | 0.16 | ARCH_GRAZER |
| 10 | `CRT_NINEARM` | Ninearm Mimic | 0 | B1-B3 | BIO_REEF, BIO_RUBBLE | 0.55 | ARCH_CEPHALOPOD |
| 11 | `CRT_SANDVEIL` | Sandveil Ray | 0 | B1-B2 | BIO_FLAT, BIO_MEADOW | 1.30 | ARCH_GLIDER |
| 12 | `CRT_SPINECROWN` | Spinecrown Urchin | 1 | B1-B3 | BIO_REEF, BIO_RUBBLE | 0.28 | static hazard |
| 13 | `CRT_BLOATSPINE` | Bloatspine | 1 | B1-B2 | BIO_REEF | 0.31 | ARCH_REEFDART |
| 14 | `CRT_RIBBONWETHER` | Ribbonwether | 0 | B2 | BIO_MEADOW | 2.40 | ARCH_GRAZER |
| 15 | `CRT_SILVERQUILL` | Silverquill | 0 | B1-B3 | BIO_PELAGIC, BIO_STEPDOWN | 0.29 | ARCH_SHOALER |
| 16 | `CRT_BELLFLOWER` | Bellflower Jelly | 1 | B1-B3 | BIO_PELAGIC | 0.45 | ARCH_DRIFTER |
| 17 | `CRT_GLASSCLAW` | Glassclaw | 1 | B2-B4 | BIO_RUBBLE, BIO_STEPDOWN | 0.75 | ARCH_CRUSTACEAN |
| 18 | `CRT_HAGLINE` | Hagline | 1 | B2-B6 | BIO_FLAT, BIO_ASHPLAIN | 0.95 | ARCH_SCAVENGER |
| 19 | `CRT_FRONDMAW` | Frondmaw | 2 | B2-B3 | BIO_KELP | 1.85 | ARCH_AMBUSHER |
| 20 | `CRT_VOLTBARB` | Voltbarb | 2 | B2-B4 | BIO_FLAT, BIO_STEPDOWN | 1.60 | ARCH_GLIDER |
| 21 | `CRT_CHISELFIN` | Chiselfin | 3 | B3-B4 | BIO_STEPDOWN, BIO_PELAGIC | 1.40 | ARCH_PACK |
| 22 | `CRT_VEILMOUTH` | Veilmouth | 1 | B3-B5 | BIO_PELAGIC, BIO_WALL | 18.0 | ARCH_FILTER_GIANT |
| 23 | `CRT_WISPLIGHT` | Wisplight | 0 | B4-B6 | BIO_PELAGIC, BIO_SPONGE | 0.13 | ARCH_SHOALER |
| 24 | `CRT_CHAINLIGHT` | Chainlight Siphonophore | 2 | B4-B6 | BIO_PELAGIC, BIO_WALL | 26.0 | ARCH_DRIFTER |
| 25 | `CRT_GHOSTBELL` | Ghostbell | 1 | B5-B7 | BIO_PELAGIC, BIO_TRENCH | 1.90 | ARCH_DRIFTER |
| 26 | `CRT_GLOOMRAY` | Gloomray | 2 | B4-B6 | BIO_ASHPLAIN, BIO_WALL | 4.60 | ARCH_GLIDER |
| 27 | `CRT_LANTERNGAPE` | Lanterngape | 3 | B5-B7 | BIO_WALL, BIO_CANYON | 1.05 | ARCH_LURER |
| 28 | `CRT_UMBRALSQUID` | Umbral Squid | 3 | B4-B7 | BIO_PELAGIC, BIO_CANYON | 3.80 | ARCH_CEPHALOPOD |
| 29 | `CRT_SEPULCHER` | Sepulcher Louse | 1 | B5-B7 | BIO_ASHPLAIN, BIO_TRENCH | 0.68 | ARCH_CRUSTACEAN |
| 30 | `CRT_EMBERWORM` | Emberworm | 0 | B6 | BIO_VENT | 2.20 | static |
| 31 | `CRT_SCALDBACK` | Scaldback | 2 | B6 | BIO_VENT | 1.15 | ARCH_CRUSTACEAN |
| 32 | `CRT_SALTWRAITH` | Saltwraith | 3 | B7 | BIO_BRINE | 5.20 | ARCH_AMBUSHER |
| 33 | `CRT_PALEWANDER` | Palewander | 0 | BX | BIO_CAVE | 0.20 | ARCH_SHOALER |
| 34 | `CRT_VAULTSTALKER` | Vaultstalker | 4 | BX | BIO_CAVE | 6.80 | ARCH_AMBUSHER |
| 35 | `LEV_HOLLOWJAW` | Hollowjaw | 4 | B4-B5 | BIO_WALL, BIO_CANYON | 31.0 | ARCH_LEVIATHAN |
| 36 | `LEV_PALEHERALD` | Pale Herald | 5 | B6 | BIO_ASHPLAIN, BIO_SPONGE-deep | 47.0 | ARCH_LEVIATHAN |
| 37 | `LEV_NETHERCOIL` | Nethercoil | 5 | B7 | BIO_TRENCH, BIO_BRINE | 96.0 | ARCH_LEVIATHAN |

Tier semantics: **0** never harms the player; **1** harms only on contact/provocation; **2** attacks under specific triggers; **3** actively hunts the player; **4** hunts the vessel and can cripple it; **5** can destroy the vessel and kill an unprotected player in two hits.

---

### 06.4.2 LAND AND SHORE FAUNA

#### 1. `CRT_TIDECLAW` — Tideclaw
*Litoractus pallidus* | `ARCH_CRUSTACEAN` | tier 0 | B0

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_STRAND, BIO_ISLE, BIO_RUBBLE | Depth / altitude | +4 m to -3 m |
| Length (m) | 0.34 (carapace 0.19) | Mass (kg) | 0.9 |
| Diet | detritus, stranded algae, carrion | Danger tier | 0 |
| Health (HP) | 8 | Damage/hit (HP) | 0 (pinch is a 0.3 s stagger only) |
| Speed base/burst (m/s) | 0.55 / 2.10 (sideways) | Turn rate (deg/s) | 300 |
| School size | 1 (loose aggregations 6-40) | Density | 380 / km^2 |
| Activity | 0.5 day / 1.6 night | Light affinity | -0.45 (scatters from lamps) |
| Aggro trigger | none; raises claws if approached < 1.2 m | Threat tau (s) | 18 |
| Biolum | none | Lure | no |
| Audio | 2.2 kHz dry chitin clicks; 8-tick shell rattle | Verts LOD0 | 1,240 |

**Behaviour & art direction.** Pale sand-coloured decapods with one oversized bleached claw held like a shield and a carapace mottled to match the exact beach material under it (tint sampled from the terrain splat at spawn). They swarm the tide line at night in dozens, and the first thing the player ever hears on this planet after the surf is a hundred of them clattering away from a footstep. During the day they wedge under rocks with just the claw showing. They will investigate a dropped item within 8 m, drag it up to 3 m, then lose interest — a harmless, charming little theft mechanic. They are the tutorial for "things here react to you and nothing here wants to hurt you."

**Mesh recipe.** `SHELLPLATE(7)` carapace from a squashed superellipsoid (`e1=0.4, e2=0.7`), `NOISE_DISP(oct=3, amp=0.004 m, freq=40)` for pitting; 8 legs as 3-segment `TUBECHAIN(4, 6)` with analytic 2-bone IK; big claw = two `LATHE` halves hinged, small claw scaled 0.42; eyestalks 2x `TUBECHAIN(3,5)` with sphere caps. 16 bones.

#### 2. `CRT_VANESKIMMER` — Vaneskimmer
*Petravolans longipennis* | `ARCH_FLYER` | tier 0 | B0 air

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_CLIFF (nesting), BIO_ISLE, over BIO_REEF | Altitude | +2 to +140 m AGL |
| Length (m) | 0.46 body, 1.10 wingspan | Mass (kg) | 0.72 |
| Diet | small fish, Saltmoths, surface krill | Danger tier | 0 |
| Health (HP) | 14 | Damage/hit (HP) | 0 |
| Speed base/burst (m/s) | 9.5 / 22.0 (stoop 31.0) | Turn rate (deg/s) | 190 |
| School size | 4 - 30 (colony 60 - 200 on cliff) | Density | 260 / km^2 |
| Activity | 1.5 day / 0.1 night (roosts at dusk) | Light affinity | -0.10 |
| Aggro trigger | none; mobs the player within 6 m of an active nest with dives that miss by 0.4 m | Threat tau (s) | 9 |
| Biolum | none | Lure | no |
| Audio | fundamental 780 Hz, two-tone descending keen 780->520 Hz over 0.35 s; wing whoosh = filtered noise 120-900 Hz at wingbeat rate | Verts LOD0 | 980 |

**Behaviour & art direction.** Not a bird — a leathery four-winged glider with a keeled sternum, no feathers, and a translucent membrane veined in orange that glows when the low sun is behind it. The forewings do the flapping; the hindwings are fixed canards that give it an unsettling, dragonfly-like stability. They nest in guano-white streaks on the sea stacks, wheel in thermals over the island all day, and *plunge-dive* on Coppersprat shoals from 30 m, hitting the water with a real splash particle burst and a lateral-line stimulus of 1.4. Their colony is the loudest sound on the island and its sudden silence is a scripted dread cue used exactly once (06.5.7).

**Mesh recipe.** Body `LOFT(9 rings, 10 segs)` fusiform; head with a hooked keratin beak from `LATHE(5, 8)`; wings = `FIN(strip=7, chordFn=elliptical, camber=0.08)` with a 3-bone chain each, membrane thickness 6 mm, `SYM`; tail = 2 trailing streamers `TUBECHAIN(4,4)`. 18 bones. Wingbeat drives a spanwise twist of `-0.22 rad` at the tip for realistic thrust.

#### 3. `CRT_DUNECREST` — Dunecrest
*Fossorgrazus cristatus* | `ARCH_BURROWER` | tier 0 | B0

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_ISLE (grass/scrub), dune faces | Altitude | +1 to +90 m AGL, burrows to -1.8 m |
| Length (m) | 0.62 | Mass (kg) | 6.4 |
| Diet | tuber-analogs, salt grass, lichen crust | Danger tier | 0 |
| Health (HP) | 34 | Damage/hit (HP) | 0 |
| Speed base/burst (m/s) | 0.8 / 4.6 (dash to burrow) | Turn rate (deg/s) | 260 |
| School size | 1-3, warren of 8-20 sharing tunnels | Density | 95 / km^2 |
| Activity | 0.7 day / 1.3 night (crepuscular peaks 05:30 and 18:30) | Light affinity | -0.30 |
| Aggro trigger | none; freezes, then bolts for the nearest burrow mouth | Threat tau (s) | 10 |
| Biolum | none | Lure | no |
| Audio | 210 Hz nasal chirrup, 3-note descending; alarm = single 950 Hz whistle + a substrate thump at 55 Hz | Verts LOD0 | 1,420 |

**Behaviour & art direction.** A barrel-bodied six-limbed grazer with spade-shaped forelimbs, a stiff dorsal crest of keratin blades that it raises when alarmed, and no visible eyes — just two vibrissae-ringed pits. It crops the salt grass in slow arcs, sitting up on its hind pair every 4-9 s to sweep the air with its whiskers. A network of real burrow entrances is baked into the island terrain at generation time (Section 03 exposes `burrowMouths[]`), and a fleeing Dunecrest genuinely pathfinds to the nearest one and vanishes with a puff of sand for 30-90 s. Their thump-alarm propagates through the warren: one thump makes every Dunecrest within 60 m sit up, which is the most alive-feeling thing on the whole island.

**Mesh recipe.** Body `LOFT(11 rings, 12 segs)` with a strong dorsal ridge; `NOISE_DISP(oct=4, amp=0.012, freq=9)` for fur-less pebbled hide; 6 legs `TUBECHAIN(4,6)` with 2-bone IK, forelimbs 1.4x thicker; crest = 9 `FIN(strip=3)` blades on a driven bone that lerps 0 -> 0.9 rad on alarm; whisker pits as a shader detail only. 20 bones.

#### 4. `CRT_SALTMOTH` — Saltmoth
*Nocticeras halina* | `ARCH_FLYER` | tier 0 | B0 air

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_ISLE, BIO_CLIFF, 0-30 m offshore | Altitude | +0.5 to +25 m AGL |
| Length (m) | 0.11 body, 0.19 wingspan | Mass (kg) | 0.006 |
| Diet | nectar-analog from salt-scrub blooms | Danger tier | 0 |
| Health (HP) | 1 | Damage/hit (HP) | 0 |
| Speed base/burst (m/s) | 1.8 / 4.2 | Turn rate (deg/s) | 640 |
| School size | 8 - 120 around a light source | Density | 2,400 / km^2 |
| Activity | 0.02 day / 1.9 night | Light affinity | **+0.95** (strongest in game) |
| Aggro trigger | none | Threat tau (s) | 4 |
| Biolum | faint abdominal glow `(0.45,0.62,0.30)`, 0.6 Hz slow pulse, not a lure | Lure | no |
| Audio | 46 Hz wingbeat thrum, granular; a cloud of 60 produces a beating 3-6 Hz chorus | Verts LOD0 | 180 |

**Behaviour & art direction.** Dusty grey-green moth-analogs with four scalloped wings and a body that glows just enough to be seen as a drifting spark. They exist for exactly one purpose: the moment the player first switches on the vessel's exterior lamps at night on the beach, forty of them arrive within 12 s and orbit the lamp in a slow helix. It teaches the light-affinity mechanic in the safest possible place, so that six hours later, when something in the dark at 700 m does the *opposite*, the player already knows what light means. They never enter the water and they never follow the vessel past 40 m from shore.

**Mesh recipe.** Four `FIN(strip=4, camber=0.02)` wings with a scalloped trailing edge from a sine cut; body `LATHE(4, 6)`; 2 antennae `TUBECHAIN(3,3)`. 8 bones. Wings driven at 46 Hz — animation is done entirely in the vertex shader from `phase`, no bone update above 12 Hz (the wings alias deliberately into a blur, which is correct).

---

### 06.4.3 SUNLIT SHALLOWS — THE SAFE ZONE (tier 0 - 1)

Everything in this subsection is spawn-legal inside the Safe Charter volume (06.6.2). Nothing here can reduce player health.

#### 5. `CRT_GLIMMERKRILL` — Glimmerkrill
*Micronectes scintillans* | `ARCH_PLANKTON` | tier 0 | B1-B4

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | all pelagic + BIO_REEF, BIO_MEADOW | Depth (m) | 0 - 480 (diel, see below) |
| Length (m) | 0.021 | Mass (kg) | 0.00008 |
| Diet | phytoplankton, marine snow | Danger tier | 0 |
| Health (HP) | n/a (swarm HP 400) | Damage/hit (HP) | 0 |
| Speed base/burst (m/s) | 0.09 / 0.55 | Turn rate (deg/s) | 900 |
| School size | 2,000 - 12,000 (GPU swarm) | Density | 4.0e6 / km^3 |
| Activity | 1.0 day / 1.0 night (migrates rather than sleeps) | Light affinity | -0.55 by day, +0.25 at night |
| Aggro trigger | none | Threat tau (s) | 4 |
| Biolum | `(0.35,0.85,1.00)` cyan; **stress-triggered flash**: a 0.12 s bloom propagating outward at 14 m/s when disturbed | Lure | no |
| Audio | none individually; a swarm emits a 4.2 kHz shimmer (filtered noise, amplitude tied to local density) | Verts LOD0 | 46 (impostor beyond 8 m) |

**Behaviour & art direction.** The base of the entire food web and the single most important atmospheric asset in the game. Translucent shrimp-analogs, 21 mm long, forming clouds so dense they read as coloured fog with structure. Their signature is **disturbance bioluminescence**: swim a hand through them and a cyan flash races away from you in a ring; drive the vessel through a swarm at night and you leave a glowing wake 40 m long that persists for 2.6 s. They perform a full diel vertical migration — centre of mass at 12 m depth at 01:00, sinking to 420 m by 13:00 — which physically drags half the mid-water predator population up and down with it, and is the reason the twilight zone is a completely different place at night.

**Mesh recipe.** Single `LATHE(5, 5)` capsule with a `NOISE_DISP` almost-flat, plus 4 tiny pleopod quads. Rendered as GPU boids with LOD0 mesh inside 8 m and a 2-triangle emissive card beyond. Flash implemented as a `flashTime` per-particle f32 written by a 12-thread propagation kernel, not by CPU.

#### 6. `CRT_VEILMOTE` — Veilmote
*Gelatispira tenuis* | `ARCH_DRIFTER` | tier 0 | B1-B5

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_PELAGIC | Depth (m) | 10 - 620 |
| Length (m) | 0.07 (mucous house 0.42 across) | Mass (kg) | 0.004 |
| Diet | filter-feeds on nanoplankton | Danger tier | 0 |
| Health (HP) | 1 | Damage/hit (HP) | 0 |
| Speed base/burst (m/s) | 0.03 / 0.06 | Turn rate (deg/s) | 40 |
| School size | 20 - 300 loose | Density | 1.1e5 / km^3 |
| Activity | 1.0 / 1.0 | Light affinity | 0.0 |
| Aggro trigger | none | Threat tau (s) | 2 |
| Biolum | house glows `(0.20,0.45,0.95)` when touched, 1.4 s decay | Lure | no |
| Audio | none | Verts LOD0 | 96 |

**Behaviour & art direction.** A larvacean-analog: a tiny tadpole-shaped animal living inside a transparent, nearly invisible mucous "house" the size of a grapefruit that refracts light into a faint lens flare. They drift in slow galaxies through the water column and are the primary source of *marine snow* — every 90-240 s a Veilmote abandons a clogged house, which then sinks at 0.028 m/s, becoming one of the drifting white flecks that fill the twilight zone. Bump one with the vessel and the house crumples and glows blue as it tumbles away. They are a pure texture species and they make the water feel occupied at every depth.

**Mesh recipe.** House = `SDF_MC` of a rounded, dented ellipsoid at `res=20`, material fully transparent with strong roughness-0 refraction; animal = 6-vert `LOFT` capsule with a beating tail on 3 bones. Marine-snow shedding uses the shared particle system with a `sinkRate` of 0.028 m/s.

#### 7. `CRT_COPPERSPRAT` — Coppersprat
*Sprattulus cupreus* | `ARCH_SHOALER` | tier 0 | B1-B2

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_REEF, BIO_MEADOW, BIO_RUBBLE | Depth (m) | 0 - 55 |
| Length (m) | 0.11 | Mass (kg) | 0.018 |
| Diet | zooplankton, Glimmerkrill | Danger tier | 0 |
| Health (HP) | 3 | Damage/hit (HP) | 0 |
| Speed base/burst (m/s) | 0.9 / 3.4 | Turn rate (deg/s) | 420 |
| School size | 40 - 260 | Density | 9.0e4 / km^3 |
| Activity | 1.3 day / 0.5 night (disperses into rubble at night) | Light affinity | +0.35 |
| Aggro trigger | none | Threat tau (s) | 6 |
| Biolum | none | Lure | no |
| Audio | school-level: a 240 Hz flicker-rustle from filtered noise gated by aggregate turn rate; individual startle = 1.1 kHz tick | Verts LOD0 | 420 |

**Behaviour & art direction.** Small, deep-bodied, coppery-flanked fish with a bright reflective lateral stripe that catches the caustics and makes a whole school flash *as one plane* when it turns. This is the first non-plankton animal the player meets and the entire shallow reef is designed around watching a school of them part around the player's body. They dive into coral heads when a Vaneskimmer stoops. Their school is a CPU-simulated named school within 200 m so the player can see individual fish decide.

**Mesh recipe.** `LOFT(9 rings, 10 segs)` laterally compressed (`rZ = 0.42*rY`); dorsal + anal + caudal `FIN(strip=5)`; pectorals `FIN(strip=3)` on 1 bone each; 7 spine bones. Scale sheen is a shader anisotropy term keyed to `uv.y`, no texture fetch.

#### 8. `CRT_SUNPLATE` — Sunplate
*Discopterus solaris* | `ARCH_REEFDART` | tier 0 | B1

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_REEF | Depth (m) | 1 - 34 |
| Length (m) | 0.24 | Mass (kg) | 0.31 |
| Diet | coral polyps, algae film | Danger tier | 0 |
| Health (HP) | 9 | Damage/hit (HP) | 0 |
| Speed base/burst (m/s) | 0.7 / 4.1 | Turn rate (deg/s) | 720 |
| School size | 1 - 4 (pairs are territorial) | Density | 1.4e4 / km^3 |
| Activity | 1.6 day / 0.05 night (wedges into a crevice and pales) | Light affinity | +0.20 |
| Aggro trigger | none; charges and veers off at 0.5 m if you touch its coral head | Threat tau (s) | 8 |
| Biolum | none | Lure | no |
| Audio | 420 Hz grunt on charge (FM, index 3, 90 ms); coral-nipping = 6 kHz click at 2.2 Hz | Verts LOD0 | 610 |

**Behaviour & art direction.** A near-circular, laterally flattened disc fish in vertical bands of chrome yellow and blue-black, with a tiny protruding mouth built for picking. It is the colour anchor of the shallow reef, the thing that makes the first ten minutes look like a holiday. Each pair defends a coral bommie of radius 4-7 m and will *bluff-charge* the player, stopping dead 0.5 m from the mask — a jump scare that is guaranteed harmless and is deliberately the first "scare" in the game, calibrating the player to trust the audio-tell system. At night they go grey-brown and hide, which is the shallow reef's first hint that darkness changes everything here.

**Mesh recipe.** Disc from `LOFT(13 rings, 14 segs)` with `rY` following a circle and `rZ = 0.16*rY`; snout `LATHE(4,8)`; tall dorsal/anal `FIN(strip=9)` merged into the body silhouette; caudal `FIN(strip=6)` truncate. Banding is a procedural stripe function of `uv.x`, jittered per individual by `seed`. 6 spine bones + 2 jaw + 2 pectoral.

#### 9. `CRT_REEFCROPPER` — Reefcropper
*Rasorella reptans* | `ARCH_GRAZER` | tier 0 | B1-B2

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_REEF, BIO_RUBBLE, BIO_MEADOW | Depth (m) | 0 - 70 |
| Length (m) | 0.16 shell | Mass (kg) | 0.44 |
| Diet | algal turf, biofilm | Danger tier | 0 |
| Health (HP) | 18 (shell reduces damage 60%) | Damage/hit (HP) | 0 |
| Speed base/burst (m/s) | 0.035 / 0.06 | Turn rate (deg/s) | 25 |
| School size | 1 (aggregations of 5-25 on good turf) | Density | 3.1e4 / km^3 |
| Activity | 0.6 day / 1.4 night | Light affinity | -0.15 |
| Aggro trigger | none; clamps to substrate (damage x0.15) when threatened | Threat tau (s) | 12 |
| Biolum | none; shell interior is nacreous and iridescent (harvestable) | Lure | no |
| Audio | 320 Hz rasping scrape at 1.8 Hz while grazing; a whole aggregation is a soft continuous rasp | Verts LOD0 | 540 |

**Behaviour & art direction.** A big-footed gastropod-analog with a low conical shell encrusted in living turf, so it is half-invisible until it moves. It grazes in slow, visible meandering trails that it literally *scrapes clean* — the terrain's algae detail texture is decremented in a small write-back buffer, leaving pale wandering tracks across the reef that persist and slowly regrow at 1% per game-minute. This is the cheapest possible way to prove the world remembers what its animals do, and players notice it.

**Mesh recipe.** Shell `LATHE(9 pts, 16 segs)` with a logarithmic-spiral profile and `NOISE_DISP(oct=5, amp=0.006)`; foot `LOFT(7,10)` soft-body with 4 bones doing a travelling pedal wave `sin(2*pi*1.4*t - 6*u)` visible from below; 2 retractable eyestalks. Turf encrustation is instanced 40x on the shell as tiny alpha-tested fronds.

#### 10. `CRT_NINEARM` — Ninearm Mimic
*Enneabrachium versicolor* | `ARCH_CEPHALOPOD` | tier 0 | B1-B3

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_REEF, BIO_RUBBLE, BIO_MEADOW | Depth (m) | 2 - 140 |
| Length (m) | 0.55 (mantle 0.19, arms 0.36) | Mass (kg) | 2.1 |
| Diet | Glassclaw juveniles, Reefcroppers, Tideclaws | Danger tier | 0 |
| Health (HP) | 26 | Damage/hit (HP) | 0 |
| Speed base/burst (m/s) | 0.4 crawl / 5.8 jet | Turn rate (deg/s) | 540 |
| School size | 1 | Density | 620 / km^3 |
| Activity | 0.5 day / 1.5 night | Light affinity | -0.60 |
| Aggro trigger | none, ever; flees | Threat tau (s) | 20 |
| Biolum | none; **active chromatophores** instead | Lure | no |
| Audio | jet = 90 Hz water-slap thump + 1.6 kHz noise burst, 0.25 s; ink = 140 Hz muffled whump | Verts LOD0 | 2,240 |

**Behaviour & art direction.** Nine arms, not eight — one is a stubby specialised hectocotylus it keeps curled. This animal is the shallow reef's magic trick: a real-time skin shader that samples the average albedo and roughness of the terrain within 0.8 m and lerps its own surface to match over 0.9 s, plus a papillae displacement term that raises 3D bumps when it settles on rubble. Approach slowly and it holds, watching with a horizontal-slit pupil that counter-rotates to stay level as it moves. Approach fast and it fires: a 5.8 m/s jet, a 1.1 m ink cloud (a real 6 s density volume that blocks vision and *blocks creature vision too*, usable by the player as a stealth resource if harvested), and it is gone into a crevice you did not know was there.

**Mesh recipe.** Mantle `LATHE(7, 14)` with a jet-driven uniform scale on bone 0; head + eye bulges `SDF_MC(res=32)`; 9 arms `TUBECHAIN(7 pts, 7 segs)` with damped-spring chains (k=40, c=7) and a per-arm suction-cup instanced strip; two lateral fins `FIN(strip=4)`. 30 bones (9 arms x 3 + mantle 3). Chromatophore match is a single-pass screen-independent shader using a 4-tap terrain albedo probe updated at 4 Hz.

#### 11. `CRT_SANDVEIL` — Sandveil Ray
*Psammobatis velata* | `ARCH_GLIDER` | tier 0 | B1-B2

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_FLAT, BIO_MEADOW, BIO_REEF margins | Depth (m) | 1 - 95 |
| Length (m) | 1.30 disc width (2.05 with tail) | Mass (kg) | 22 |
| Diet | buried molluscs, worms, Glassclaw larvae | Danger tier | 0 |
| Health (HP) | 70 | Damage/hit (HP) | 0 (tail spine only if stood on: 4 HP + 12 s venom DoT of 0.4 HP/s) |
| Speed base/burst (m/s) | 1.1 / 5.4 | Turn rate (deg/s) | 150 |
| School size | 1-2, resting groups of up to 9 buried in one patch | Density | 45 / km^3 |
| Activity | 0.8 day / 1.2 night | Light affinity | -0.25 |
| Aggro trigger | none; only reacts if the player lands on it | Threat tau (s) | 14 |
| Biolum | none | Lure | no |
| Audio | almost silent; burial = 180 Hz sand hiss over 1.1 s; startle = a single 60 Hz whumpf | Verts LOD0 | 1,680 |

**Behaviour & art direction.** A broad, soft-edged disc the exact colour of the Pale Flats, with two spiracles on top that flutter while it lies buried under 2-4 cm of sand, invisible except for a faint diamond outline and two eyes. Swim over the flats and one will erupt in a silt bloom and undulate away in a slow, beautiful rajiform wave — it is a small heart-stop moment that is *always harmless*, and it is doing real work: teaching the player that the seabed can contain things, so that a Frondmaw or a Saltwraith later lands correctly. Uses electroreception (`electroR` = 3.5 m) to find buried prey, and you can watch it stop, hover, and dig.

**Mesh recipe.** Disc from a 2D superellipse (`e=0.62`) lofted into `LOFT(15 rings, 22 segs)` with thickness `0.09*width` at centre tapering to 4 mm at the margin; tail `TUBECHAIN(9,6)` with a barb; rajiform wave on 6 pectoral strip bones per side. `NOISE_DISP(oct=3, amp=0.008)` dermal denticles. 22 bones. Burial is a vertex-shader sink: `pos.y -= burialDepth * v.extra.w` plus a terrain-blend alpha.

#### 12. `CRT_SPINECROWN` — Spinecrown Urchin
*Coronaspina rigida* | static hazard | tier 1 | B1-B3

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_REEF, BIO_RUBBLE, BIO_KELP | Depth (m) | 1 - 180 |
| Length (m) | 0.28 across (spines 0.14) | Mass (kg) | 1.1 |
| Diet | algal turf, kelp holdfasts | Danger tier | 1 |
| Health (HP) | 22 | Damage/hit (HP) | 6 on contact + 8 s DoT of 0.5 HP/s |
| Speed base/burst (m/s) | 0.004 / 0.004 | Turn rate (deg/s) | 0 |
| School size | beds of 12 - 200 | Density | 8.0e4 / km^3 |
| Activity | 0.8 / 1.2 | Light affinity | -0.20 (spines lean away from a lamp) |
| Aggro trigger | contact only | Threat tau (s) | n/a |
| Biolum | spine tips `(0.85,0.20,0.35)` dim red, steady, brightening 3x on contact | Lure | no |
| Audio | contact = 2.6 kHz brittle snap + a wet 300 Hz thud | Verts LOD0 | 780 |

**Behaviour & art direction.** The only tier-1 hazard permitted inside the Safe Charter, because it is *entirely avoidable and entirely static*. Deep-purple test, 40 slender spines with faint red luminous tips that are just visible at 60 m depth, and a slow, creepy tracking motion: spines within 40 deg of an approaching object rotate to point at it over 1.2 s. It teaches "the world can hurt you if you are careless" without ever chasing. In BIO_KELP they form barrens — circular clearings 8-20 m across where they have eaten every holdfast, which is a real, readable ecological story told with geometry alone.

**Mesh recipe.** Test = `LATHE(8, 16)` oblate sphere; 40 spines instanced `TUBECHAIN(3,4)` tapered, each on its own bone with a 2-DOF aim constraint (aim rate 0.6 rad/s). Tube feet as 60 tiny animated quads, vertex-animated only. 42 bones — exempted from the 32-bone rule by using **rigid instancing** for spines instead of skinning (each spine is its own instance sharing a transform buffer).

#### 13. `CRT_BLOATSPINE` — Bloatspine
*Inflatodon horridus* | `ARCH_REEFDART` | tier 1 | B1-B2

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_REEF, BIO_KELP margins | Depth (m) | 2 - 80 |
| Length (m) | 0.31 (0.44 inflated) | Mass (kg) | 1.8 |
| Diet | Reefcroppers, Glassclaw juveniles, urchins | Danger tier | 1 |
| Health (HP) | 30 (x0.25 damage while inflated) | Damage/hit (HP) | 5 contact-only while inflated |
| Speed base/burst (m/s) | 0.5 / 2.2 (0.15 inflated) | Turn rate (deg/s) | 380 (60 inflated) |
| School size | 1 | Density | 900 / km^3 |
| Activity | 1.2 day / 0.6 night | Light affinity | +0.10 |
| Aggro trigger | never attacks; inflates when a threat is within 2.5 m for > 0.8 s | Threat tau (s) | 15 |
| Biolum | none | Lure | no |
| Audio | inflation = a 0.7 s rising 140->260 Hz gulp with a noise swell; deflation = a long 90 Hz sigh | Verts LOD0 | 900 |

**Behaviour & art direction.** A grumpy, beak-mouthed, brindled fish with permanently protruding eyes that swivel independently. Its whole design exists to be *pushed around by the player*: nudge it and it inflates into a spiny ball over 0.7 s using the vertex-shader `inflate` channel, becomes almost neutrally buoyant and drifts, then deflates 6-14 s later with an audible sigh. Grabbing an inflated one and using it as a bumper is an intended, undocumented toy. Its spines do 5 HP on contact so there is a real, gentle cost to messing with it.

**Mesh recipe.** `LOFT(11, 12)` short and deep; `extra.x` (inflate weight) is `smoothstep(0.1, 0.9, u)` shaped so the belly expands most; 90 spines instanced on the hull, rotating from flush (0.02 rad) to erect (1.5 rad) with inflation; beak from 2 `LATHE(3,7)` plates; small ostraciiform caudal. 12 bones. Inflation drives `inst.inflate` 0 -> 1 and `Cd` 0.11 -> 0.55, `buoyRatio` 0.99 -> 1.004.

---

### 06.4.4 MEADOW, KELP AND SHELFBREAK (B2-B3)

#### 14. `CRT_RIBBONWETHER` — Ribbonwether
*Herbivagus placidus* | `ARCH_GRAZER` | tier 0 | B2

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_MEADOW, BIO_KELP edges | Depth (m) | 18 - 105 |
| Length (m) | 2.40 | Mass (kg) | 210 |
| Diet | ribbon grass, kelp blades | Danger tier | 0 |
| Health (HP) | 340 | Damage/hit (HP) | 0 (a fleeing one can body-check for 3 HP) |
| Speed base/burst (m/s) | 0.7 / 3.1 | Turn rate (deg/s) | 70 |
| School size | 3 - 11 (family pods) | Density | 14 / km^3 |
| Activity | 1.2 day / 0.7 night (sleeps on the bottom, eyes open) | Light affinity | +0.05 |
| Aggro trigger | never | Threat tau (s) | 10 |
| Biolum | none | Lure | no |
| Audio | 62 Hz contact rumble (sine + 2nd harmonic, slow AM at 0.7 Hz); grazing tear = 400 Hz filtered noise, 0.4 s | Verts LOD0 | 3,100 |

**Behaviour & art direction.** A placid, sausage-shaped, seal-sized grazer with a broad rasping mouth-pad, tiny useless-looking eyes and two paddle limbs. It is a manatee-analog and it exists to make the Ribbon Meadows feel *pastoral*: pods of them hang nose-down in the grass, chewing, exhaling fine bubble strings, while calves stay within 3 m of an adult with a hard leash constraint. They are the game's proof that big does not mean dangerous — a 210 kg animal that lets the player swim right up and touch it. Their low contact rumble carries 300 m and is the friendliest sound in the ocean; you learn to feel safe when you hear it, which the deep will exploit later (06.5.4).

**Mesh recipe.** `LOFT(15 rings, 16 segs)` gently fusiform with a blunt head and a horizontal fluke; `NOISE_DISP(oct=4, amp=0.02, freq=3)` for wrinkled hide, plus 30 instanced barnacle-analogs on the back; 2 paddle limbs `FIN(strip=5, camber=0.12)` on 2 bones each; mouth-pad on 2 jaw bones with a rasping cycle. 16 bones. Calves are a 0.42 uniform scale with `A` amplitude x1.25 (they swim scruffily).

#### 15. `CRT_SILVERQUILL` — Silverquill
*Argentopennis migrans* | `ARCH_SHOALER` | tier 0 | B1-B3

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_PELAGIC, BIO_STEPDOWN, over BIO_REEF | Depth (m) | 4 - 240 |
| Length (m) | 0.29 | Mass (kg) | 0.34 |
| Diet | Glimmerkrill, Veilmotes, small fry | Danger tier | 0 |
| Health (HP) | 11 | Damage/hit (HP) | 0 |
| Speed base/burst (m/s) | 1.6 / 7.8 | Turn rate (deg/s) | 300 |
| School size | 300 - 2,400 (GPU shoal) | Density | 3.2e4 / km^3 |
| Activity | 1.1 day / 0.9 night | Light affinity | +0.45 |
| Aggro trigger | none | Threat tau (s) | 6 |
| Biolum | ventral counter-illumination `(0.55,0.72,0.90)`, brightness auto-matched to downwelling light (see below) | Lure | no |
| Audio | shoal shimmer 320 Hz + a 1.4 kHz "sheet-metal" rush when the shoal flash-expands | Verts LOD0 | 480 |

**Behaviour & art direction.** The workhorse spectacle species: mirror-flanked, fork-tailed, and rendered 2,400 at a time as a single GPU shoal that forms sheets, tornadoes and bait-balls. Their flanks use a true mirror BRDF with a thin-film tint, so a shoal turning through a shaft of light produces a visible flash-front travelling across it. Below 60 m their **counter-illumination** kicks in: a ventral emissive term set to `0.6 * downwellingRadiance(depth)` so that from beneath they vanish against the surface — the player can literally watch a shoal disappear by descending below it. Predators (Chiselfin, Voltbarb, Vaneskimmer, Hollowjaw) all hunt them, and a bait-ball forming 80 m away is the game's standard "something big is coming" tell.

**Mesh recipe.** `LOFT(11, 10)` slender fusiform, `rZ = 0.38*rY`; deeply forked caudal `FIN(strip=7)`; small dorsal/anal/pelvic fins; 7 spine bones, GPU-skinned via the boid path. Counter-illumination is a single emissive multiply on the ventral 40% of `uv.y`.

#### 16. `CRT_BELLFLOWER` — Bellflower Jelly
*Campanula pelagica* | `ARCH_DRIFTER` | tier 1 | B1-B3

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_PELAGIC | Depth (m) | 3 - 220 |
| Length (m) | 0.45 bell, 2.6 tentacle trail | Mass (kg) | 6.5 |
| Diet | Glimmerkrill, fry | Danger tier | 1 |
| Health (HP) | 12 | Damage/hit (HP) | 3 on tentacle contact + 10 s DoT of 0.3 HP/s + 25% control-jitter |
| Speed base/burst (m/s) | 0.22 / 0.40 | Turn rate (deg/s) | 30 |
| School size | blooms of 30 - 400 | Density | 2,200 / km^3 (bloom events x40 for 6 game-days) |
| Activity | 1.0 / 1.0 | Light affinity | +0.15 |
| Aggro trigger | contact only | Threat tau (s) | 2 |
| Biolum | bell rim `(0.95,0.45,0.75)` pink, radial chase pattern at 0.8 Hz, brighter at night | Lure | no |
| Audio | none; a bloom adds a 0.4 Hz sub-bass swell at 38 Hz for pressure, felt not heard | Verts LOD0 | 1,150 |

**Behaviour & art direction.** Translucent pink-white bells with eight ribbed canals and a curtain of fine tentacles, pulsing on a 0.55 Hz jet cycle that actually drives their motion. They form seasonal blooms scripted by the world director: for six game-days a section of the water column becomes an aching, drifting cathedral of thousands of them, and the player must thread the vessel through without contacting the trails (each contact costs 3 HP and jitters the controls, so blooms make otherwise-safe water into a slow, tense navigation puzzle). Their radial light chase is subtle in daylight and mesmerising at 180 m.

**Mesh recipe.** `BELL(profile=9 pts, segs=20, frills=8)`; bell scale driven by a jet contraction on 1 bone with 8 radial rib bones for the pulse ripple; tentacles = 24 `TUBECHAIN(6,3)` damped-spring chains (k=18, c=4) with a per-strand phase offset. Subsurface-scattering material with `thickness` from `uv.y`. 14 bones.

#### 17. `CRT_GLASSCLAW` — Glassclaw
*Vitrocheles fragilis* | `ARCH_CRUSTACEAN` | tier 1 | B2-B4

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_RUBBLE, BIO_STEPDOWN, BIO_KELP floor | Depth (m) | 40 - 400 |
| Length (m) | 0.75 (claw span 0.9) | Mass (kg) | 8.2 |
| Diet | carrion, molluscs, Sepulcher Louse | Danger tier | 1 |
| Health (HP) | 90 (carapace: 65% damage reduction from the front) | Damage/hit (HP) | 9 |
| Speed base/burst (m/s) | 0.45 / 2.6 (tail-flip escape 4.8) | Turn rate (deg/s) | 200 |
| School size | 1 (migration columns of 40-300, rare event) | Density | 320 / km^3 |
| Activity | 0.4 day / 1.6 night | Light affinity | -0.35 |
| Aggro trigger | player within 1.5 m for > 1.0 s, or attacking it | Threat tau (s) | 18 |
| Biolum | joint membranes `(0.30,0.95,0.60)` faint green, steady | Lure | no |
| Audio | 140 Hz claw clack (2 impulses 40 ms apart); walking = 900 Hz chitin taps at stride rate; threat display = a 55 Hz stridulation buzz | Verts LOD0 | 2,900 |

**Behaviour & art direction.** A translucent-shelled lobster-analog whose carapace is genuinely see-through in the shoulders, showing a faint green internal glow at the joints and a dark gut line. It is the primary mid-depth material source (chitin, and the harvestable `nacre` from its gut stones), so the player will fight a lot of them, and it is designed to be *fair*: it always raises both claws and stridulates for 0.55 s before striking. Its tail-flip escape is a genuine physics impulse of 220 N.s that sends it backwards in a cloud of silt. Once per 40 game-days a mass migration column crosses the shelfbreak at night — hundreds of them walking in single file, glowing faintly, one of the game's best free spectacles.

**Mesh recipe.** `SHELLPLATE(11)` carapace + 6 abdominal segments as separate rigid plates on a 6-bone chain (real segmented sliding); 2 chelae from paired `LATHE(6,10)` halves on 3 bones each; 8 walking legs `TUBECHAIN(4,5)` with tripod-gait IK; 2 antennae `TUBECHAIN(8,4)` at 1.3x body length, damped-spring. 30 bones.

#### 18. `CRT_HAGLINE` — Hagline
*Myxanguilla profunda* | `ARCH_SCAVENGER` | tier 1 | B2-B6

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_FLAT, BIO_ASHPLAIN, BIO_STEPDOWN, BIO_CANYON | Depth (m) | 60 - 1,400 |
| Length (m) | 0.95 | Mass (kg) | 3.1 |
| Diet | carrion (obligate), burrowing worms | Danger tier | 1 |
| Health (HP) | 40 | Damage/hit (HP) | 4 (rasp) |
| Speed base/burst (m/s) | 0.8 / 3.0 | Turn rate (deg/s) | 260 |
| School size | 1; 8-60 converge on a corpse | Density | 1,100 / km^3 |
| Activity | 0.9 / 1.1 | Light affinity | -0.20 |
| Aggro trigger | only defends; **slime burst** when damaged | Threat tau (s) | 25 |
| Biolum | none | Lure | no |
| Audio | near-silent; slime burst = 200 Hz wet gout, 0.9 s; a feeding knot produces a horrible 500 Hz wet rasping chorus | Verts LOD0 | 1,050 |

**Behaviour & art direction.** Eyeless, jawless, rope-bodied scavengers with a rasping oral disc and four pairs of barbels. They are the ocean's cleanup crew and the primary consumer of the scent field: drop a kill anywhere below 60 m and within 90-240 s they arrive from up to 400 m away, following the gradient in visible, weaving, nose-down search patterns. A knot of thirty of them writhing inside a Ribbonwether carcass is the most viscerally unpleasant sight in the shallow game and it is *completely harmless* — which is exactly the point. When damaged they release a slime cloud: a 3.5 m sphere lasting 8 s that raises local water viscosity (player drag x2.4, vessel drag x1.6) and clogs the vessel's intake, forcing a 6 s purge.

**Mesh recipe.** `TUBECHAIN(24 pts, 9 segs)` with a slight lateral compression toward the tail; oral disc from `LATHE(5,12)` with 2 rasping tooth-plate bones; 8 barbels `TUBECHAIN(4,3)`. 12 spine bones (anguilliform, `lambdaB = 0.65`). Slime is a screen-space refraction volume + a viscosity field write, not particles.

#### 19. `CRT_FRONDMAW` — Frondmaw
*Phycolatens insidiosus* | `ARCH_AMBUSHER` | tier 2 | B2-B3

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_KELP | Depth (m) | 30 - 190 |
| Length (m) | 1.85 | Mass (kg) | 54 |
| Diet | Coppersprat, Silverquill, Sunplate, Bloatspine | Danger tier | 2 |
| Health (HP) | 210 | Damage/hit (HP) | 18 (player) / 14 (vessel hull) |
| Speed base/burst (m/s) | 0.25 / 9.4 (lunge, 0.9 s only) | Turn rate (deg/s) | 90 (420 during lunge windup) |
| School size | 1 | Density | 26 / km^3 |
| Activity | 1.0 / 1.0 (ambush is light-independent) | Light affinity | -0.15 |
| Aggro trigger | any target of length 0.2-2.5 m passing within 4.5 m of its ambush point, moving < 3 m/s | Threat tau (s) | 45 |
| Biolum | none; 3 dorsal photophore dots `(0.15,0.90,0.45)` used only in `AM_TRIGGER` as the tell | Lure | no |
| Audio | **tell**: 0.55 s before the lunge, a rising 70->190 Hz body-groan + a kelp-rustle transient at 1.2 kHz. Lunge itself = a 45 Hz water thud | Verts LOD0 | 2,600 |

**Behaviour & art direction.** A laterally flattened, olive-and-amber ambush predator with tattered dermal flaps along its dorsal and ventral edges that are shaped and coloured like kelp blades. It hangs vertically, head-down, inside a kelp stipe cluster with its fins doing a slow sway *matched to the kelp's own wind-field animation phase*, so it is genuinely invisible until it moves. Its danger tier is 2, not 3: it strikes once, hard, and then does not pursue beyond 12 m; it is a punishment for inattentive swimming through the Amber Forest, not a hunter. Its tell is mandatory and unmissable at any audio setting, and its three dorsal dots flare green during windup, giving a purely visual tell for deaf play.

**Mesh recipe.** `LOFT(13, 12)` heavily compressed (`rZ = 0.30*rY`); 14 dermal flaps `FIN(strip=4)` with independent noise-driven sway bones (shared 3-bone rig, phase-offset); large hinged jaw `LATHE(5,9)` x2 with 26 instanced recurved teeth; 9 spine bones tuned to `lambdaB = 0.78`, `A1 = 0.19`. 22 bones. Camouflage uses the same terrain-probe shader as `CRT_NINEARM` but samples the kelp material instead.

#### 20. `CRT_VOLTBARB` — Voltbarb
*Electrobatis pulsans* | `ARCH_GLIDER` | tier 2 | B2-B4

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_FLAT, BIO_STEPDOWN, BIO_SPONGE | Depth (m) | 55 - 460 |
| Length (m) | 1.60 disc | Mass (kg) | 48 |
| Diet | Hagline, Glassclaw, small shoalers | Danger tier | 2 |
| Health (HP) | 180 | Damage/hit (HP) | 12 + **EMP**: player HUD scramble 4 s, O2 readout lost; vessel loses thrust for 2.2 s and lights for 5 s |
| Speed base/burst (m/s) | 0.9 / 4.2 | Turn rate (deg/s) | 130 |
| School size | 1 - 3 | Density | 38 / km^3 |
| Activity | 0.6 day / 1.4 night | Light affinity | -0.30 |
| Aggro trigger | electroreception contact with a powered vessel within 14 m, or damage taken | Threat tau (s) | 30 |
| Biolum | discharge arcs `(0.55,0.75,1.00)` HDR 8.0, 0.15 s, branching | Lure | no |
| Audio | **tell**: a 0.8 s rising electrical whine 900->2,400 Hz with growing AM buzz. Discharge = 60 Hz crack + 5 kHz noise burst, 90 ms, and a real 0.4 s convolution tail | Verts LOD0 | 1,900 |

**Behaviour & art direction.** A slate-grey ray with two paired electric organs visible as pale kidney-shaped patches, a whip tail, and a face of small perpetual malice. It is the mid-game's most memorable non-lethal threat because it attacks *systems*, not health: an EMP hit at 300 m with the lights out for five seconds is a genuine adrenaline event that costs nothing but composure. It hunts by electroreception (`electroR` = 18 m) and is therefore the first creature that finds the player through silt, ink and total darkness — establishing, cheaply and early, that hiding is not always enough. It is *specifically* attracted to a running vessel and specifically ignores a powered-down one, which teaches the shutdown mechanic.

**Mesh recipe.** Rounder disc than Sandveil (`e=0.78`), `LOFT(15, 22)`, thickness `0.14*width`; electric organs are a separate emissive sub-mesh under a translucent skin layer; tail `TUBECHAIN(11,6)`. Discharge is a procedural lightning polyline (recursive midpoint displacement, 4 levels, 3 branches) drawn as camera-facing ribbons, 0.15 s life, plus a full-screen chromatic-aberration + scanline post pulse. 24 bones.

#### 21. `CRT_CHISELFIN` — Chiselfin
*Serracaudus gregarius* | `ARCH_PACK` | tier 3 | B3-B4

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_STEPDOWN, BIO_PELAGIC, BIO_WALL upper | Depth (m) | 110 - 500 |
| Length (m) | 1.40 | Mass (kg) | 31 |
| Diet | Silverquill, Wisplight, Ribbonwether calves, wounded anything | Danger tier | 3 |
| Health (HP) | 130 | Damage/hit (HP) | 14 (player) / 9 (vessel hull) |
| Speed base/burst (m/s) | 2.4 / 11.5 | Turn rate (deg/s) | 340 |
| School size | **pack of 4 - 9** (CPU, L0/L1 only) | Density | 30 / km^3 |
| Activity | 1.3 day / 0.8 night | Light affinity | +0.30 (investigates lights, this is a trap for the player) |
| Aggro trigger | blood scent `x_scent > 0.12`; OR a lone target of length < 2.5 m within 45 m; OR any damaged vessel (hull < 70%) | Threat tau (s) | 60 |
| Biolum | none; flank stripe is retro-reflective and returns lamp light as a bright green-white eyeshine at up to 90 m | Lure | no |
| Audio | **tell**: pack coordination call, a 3-pulse 300 Hz click-grunt train, 0.28 s apart, spatialised so the player can count how many. Attack windup = a rising 180->340 Hz snarl-buzz over 0.8 s | Verts LOD0 | 2,150 |

**Behaviour & art direction.** Lean, high-shouldered, chrome-and-charcoal pack hunters with a serrated caudal keel and a mouth of triangular shearing teeth. They are the game's first true predator of the player and the first creature with genuine tactics: the pack maintains a **role assignment** refreshed every 2.5 s — one `HARRIER` circles at 8-14 m to hold the target's attention, up to two `FLANKERS` take positions at +/-110 deg from the target's facing, and the remainder hold as `RESERVE` at 25-35 m. Only one Chiselfin is permitted in `AT_LUNGE` at a time (pack token), so the player is never gang-lunged. Their retro-reflective stripes mean that at 350 m the very first thing you see is six pairs of green sparks orbiting at the edge of your lamp cone, and that image is doing more work than any monster reveal.

**Pack coordination (binding).**

| Role | Count | Standoff (m) | Bearing to target facing (deg) | Speed |
|---|---|---|---|---|
| `HARRIER` | 1 | 8 - 14 | 0 +/- 35 (stays in front, visible) | 0.55 * burst |
| `FLANKER` | 0 - 2 | 6 - 11 | +/- 110 +/- 20 | 0.70 * burst |
| `RESERVE` | rest | 25 - 35 | any | 0.35 * burst |
| `COMMITTED` | max 1 | - | - | burst |

Token rules: the `COMMITTED` token is granted to the pack member with the highest `dot(fwd, toTarget)` whose threat > 1.10, held for one full ATTACK cycle, then a 1.8 s pack-wide cooldown before regrant. If the target's health drops below 30%, cooldown falls to 0.6 s and two tokens are issued (the frenzy), which is the pack's real teeth and is always preceded by an audible change in the call rate (0.28 s -> 0.14 s spacing).

**Mesh recipe.** `LOFT(13, 12)` fusiform with a pronounced nuchal hump; falcate dorsal + pectoral `FIN(strip=6, camber=0.05)`; lunate caudal `FIN(strip=8)` on 2 bones; jaw 2 bones with 34 instanced teeth; 8 spine bones, carangiform. 20 bones. Flank stripe uses a high-`F0` (0.7) retroreflective BRDF lobe aligned to `-viewDir`.

#### 22. `CRT_VEILMOUTH` — Veilmouth
*Cetobranchus placidus* | `ARCH_FILTER_GIANT` | tier 1 | B3-B5

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_PELAGIC, BIO_WALL, BIO_STEPDOWN | Depth (m) | 90 - 700 (follows the krill layer) |
| Length (m) | 18.0 | Mass (kg) | 21,000 |
| Diet | Glimmerkrill, Veilmote (filter) | Danger tier | 1 |
| Health (HP) | 4,800 | Damage/hit (HP) | 0 intentional; **collision** 30 (player) / 55 (vessel) from sheer mass |
| Speed base/burst (m/s) | 1.1 / 3.4 | Turn rate (deg/s) | 14 |
| School size | 1 - 4 | Density | 0.4 / km^3 |
| Activity | 1.0 / 1.0 (tracks the krill migration) | Light affinity | +0.10 |
| Aggro trigger | none, ever. Cannot be aggroed. Damaging it makes it leave. | Threat tau (s) | 20 |
| Biolum | rows of pale `(0.60,0.80,1.00)` photophores along the flank in 3 lines, slow 0.15 Hz travelling pulse toward the tail | Lure | no |
| Audio | **62 Hz fundamental moan with harmonics at 124/186 Hz**, 6-11 s long, audible at 1,200 m, repeated every 40-90 s. Filter-feeding = a continuous 30 Hz rush | Verts LOD0 | 9,400 |

**Behaviour & art direction.** Eighteen metres of slow, gentle, cathedral-sized animal: a vast pleated gape held open while it cruises through krill layers, gill-rakers of translucent baleen-analog, tiny eyes, and a skin of dark blue-grey scored with pale scars. Its flank photophore lines make it visible as a slow-moving constellation from 200 m in the dark, and it is the *single most important dread instrument in the game* — because its 62 Hz moan is deliberately in the same register as `LEV_HOLLOWJAW`'s 41 Hz call, and the player will learn to relax at one and panic at the other. It is also, unavoidably, the first thing that ever fills the player's entire windshield. Following one down through the twilight zone as it feeds is an intended, unmarked, entirely optional 8-minute experience.

**Mesh recipe.** `LOFT(21 rings, 20 segs)`, gape opened by 3 jaw bones plus 40 pleat bones on the ventral grooves (rigid-instanced, not skinned); baleen as 120 alpha-tested instanced strips with a flow-driven ripple; caudal `FIN(strip=11)`; `NOISE_DISP(oct=6, amp=0.06, freq=1.2)` plus a decal layer of 30 procedural scar strokes seeded per individual. 26 bones (exempt tier: filter giants and leviathans use the 48-bone leviathan palette). Uses `ARCH_FILTER_GIANT` steering with `lookMax = 50 m` so it never clips the wall.

---

### 06.4.5 THE DEEP (B4-B7)

#### 23. `CRT_WISPLIGHT` — Wisplight
*Lampanychthys minor* | `ARCH_SHOALER` | tier 0 | B4-B6

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_PELAGIC, BIO_SPONGE, BIO_WALL | Depth (m) | 260 - 1,150 (rises to 90 m at night) |
| Length (m) | 0.13 | Mass (kg) | 0.028 |
| Diet | Glimmerkrill, copepod-analogs | Danger tier | 0 |
| Health (HP) | 2 | Damage/hit (HP) | 0 |
| Speed base/burst (m/s) | 0.7 / 4.0 | Turn rate (deg/s) | 480 |
| School size | 120 - 900 (GPU shoal) | Density | 6.5e4 / km^3 |
| Activity | 0.6 day / 1.6 night | Light affinity | **-0.70** (bolts from lamps) |
| Aggro trigger | none | Threat tau (s) | 5 |
| Biolum | 22 ventral + 6 lateral photophores `(0.30,0.70,1.00)`; **coordinated shoal flash**: on panic the whole shoal blacks out for 0.4 s then flares at 3x for 0.2 s | Lure | no |
| Audio | none individually; a shoal of 600 produces a faint 1.8 kHz sparkle keyed to flash events | Verts LOD0 | 320 |

**Behaviour & art direction.** Tiny lanternfish-analogs with huge eyes and rows of blue photophores. They are the deep ocean's only *ambient* light and they are what makes the mesopelagic navigable without lamps: 900 of them drifting through a canyon reads as a slow river of blue sparks. Their light-phobia is a core mechanic — switching on the vessel's spotlight in a Wisplight cloud instantly evacuates a 30 m sphere and plunges you into a darkness that is now *emptier than before you turned the light on*. The blackout-then-flare panic response is the game's best cheap scare: it means something *else* just moved through them, and you have about 3 seconds.

**Mesh recipe.** `LOFT(9, 8)` small fusiform, huge spherical eyes `LATHE(4,8)` at 0.22 body length; 28 photophores as emissive vertex-coloured dots baked into the mesh (`extra.y` biolum mask), no extra geometry; forked caudal. 5 bones, GPU-skinned. Blackout is a per-shoal uniform multiply, zero cost.

#### 24. `CRT_CHAINLIGHT` — Chainlight Siphonophore
*Catenaphora luminis* | `ARCH_DRIFTER` | tier 2 | B4-B6

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_PELAGIC, BIO_WALL, BIO_CANYON | Depth (m) | 300 - 1,300 |
| Length (m) | 26.0 (colony), 0.9 nectophore stack diameter | Mass (kg) | 40 |
| Diet | Wisplight, Glimmerkrill, small fish | Danger tier | 2 |
| Health (HP) | 60 (colony; severing it into 2 halves creates 2 live colonies) | Damage/hit (HP) | 7 per tentacle contact, DoT 0.8 HP/s for 14 s, stacks to 4 |
| Speed base/burst (m/s) | 0.15 / 0.45 | Turn rate (deg/s) | 20 |
| School size | 1 (aggregations of 3-12 in a current shear) | Density | 34 / km^3 |
| Activity | 1.0 / 1.0 | Light affinity | +0.05 |
| Aggro trigger | contact only; but it **fishes**, hanging a 20 m curtain across the water column | Threat tau (s) | 3 |
| Biolum | full-body `(0.20,0.95,0.85)` teal, a travelling pulse down the chain at 3.2 m/s; on contact the struck section flares white `(1.0,1.0,1.0)` HDR 6.0 for 0.8 s | Lure | no |
| Audio | silent. Contact = a 3.1 kHz crystalline sting sting + a 40 Hz sub-thud on the vessel hull | Verts LOD0 | 4,300 |

**Behaviour & art direction.** A 26-metre colonial animal hanging vertically in the dark like a strand of fairy lights dropped down a well. The top is a stack of pulsing swimming bells, below which runs a long stem carrying hundreds of tiny feeding polyps and a curtain of near-invisible fishing tentacles. It is the deep's most beautiful object and one of its most dangerous places to be careless: the tentacle curtain is a real capsule collider chain that the player will drive into, and each contact stacks a stinging DoT that also blurs the windshield HUD. Cutting one in half with the vessel does not kill it — it makes two, both of which flare white with pain, and that is a genuinely horrible thing to have learned.

**Mesh recipe.** Nectophore stack: 9 `BELL(profile=6, segs=12)` on a 9-bone chain, each pulsing with a phase offset of `0.16*2*pi`; stem `TUBECHAIN(48 pts, 5 segs)` on a 16-bone chain with a damped-spring (k=6, c=3) so it drapes with the current; 140 instanced polyp sprigs; 30 tentacles `TUBECHAIN(10,3)` at 0.5 mm radius rendered as emissive lines below 20 m distance. 26 bones. Splitting is implemented as an entity split at the nearest bone with mass and length redistributed.

#### 25. `CRT_GHOSTBELL` — Ghostbell
*Nubecampana pallida* | `ARCH_DRIFTER` | tier 1 | B5-B7

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_PELAGIC, BIO_TRENCH, BIO_CANYON | Depth (m) | 520 - 2,900 |
| Length (m) | 1.90 bell diameter, 6.0 with oral arms | Mass (kg) | 120 |
| Diet | marine snow, dead Wisplight, Sepulcher larvae | Danger tier | 1 |
| Health (HP) | 55 | Damage/hit (HP) | 2 contact (very weak sting) |
| Speed base/burst (m/s) | 0.11 / 0.30 | Turn rate (deg/s) | 12 |
| School size | 1 | Density | 12 / km^3 |
| Activity | 1.0 / 1.0 | Light affinity | 0.0 |
| Aggro trigger | none | Threat tau (s) | 2 |
| Biolum | **none of its own**. It is a deep, matte, light-drinking maroon `(0.09,0.02,0.03)` that reads as a black hole in the lamp beam | Lure | no |
| Audio | silent. Its only sound is the vessel's proximity chime | Verts LOD0 | 2,050 |

**Behaviour & art direction.** A two-metre blood-red bell with four thick, ragged oral arms trailing six metres below, drifting alone through the deepest water at a tenth of a metre per second. It has no lights, and its pigment is so absorbent that in a lamp beam it appears as a hole cut out of the water. It is entirely harmless. It is on this list purely as a **dread instrument**: at 900 m, a large, silent, black, slowly rotating shape entering the edge of your light is the exact silhouette-ambiguity the game is built on, and the fact that it is always harmless is what keeps the *next* silhouette terrifying rather than exhausting. Ghostbell encounters are budgeted by the dread director at a 3:1 ratio against genuine threats (06.5.3).

**Mesh recipe.** `BELL(profile=11, segs=18, frills=0)` with a thick, heavy bell; 4 oral arms `TUBECHAIN(14,7)` with ruffled edges from a sine-perturbed radius, damped-spring (k=9, c=5); slow 0.18 Hz pulse on 1 bone + 6 radial ribs. 18 bones. Material: albedo 0.02, roughness 0.55, subsurface 0.0 — the "light drinker" look is achieved by refusing all specular except a very tight 0.02-intensity coat.

#### 26. `CRT_GLOOMRAY` — Gloomray
*Umbrabatis magna* | `ARCH_GLIDER` | tier 2 | B4-B6

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_ASHPLAIN, BIO_WALL, BIO_SPONGE | Depth (m) | 380 - 1,500 |
| Length (m) | 4.60 disc | Mass (kg) | 620 |
| Diet | Sepulcher Louse, Hagline, Scaldback, benthic worms | Danger tier | 2 |
| Health (HP) | 700 | Damage/hit (HP) | 22 (tail lash) / 18 (vessel) |
| Speed base/burst (m/s) | 1.4 / 6.0 | Turn rate (deg/s) | 60 |
| School size | 1 - 2 | Density | 6 / km^3 |
| Activity | 1.0 / 1.0 | Light affinity | flip@35m: +0.30 far, -0.55 near |
| Aggro trigger | player within 6 m of the substrate directly beneath it, OR damage taken | Threat tau (s) | 35 |
| Biolum | dorsal surface has a faint `(0.10,0.25,0.45)` reticulated net pattern, 0.05 Hz breathing pulse; ventral is unlit | Lure | no |
| Audio | **wingbeat pressure wave: a 22 Hz infrasound thump every 1.4 s**, felt as HUD vibration before it is heard. Tail lash windup = 130 Hz whip-up over 0.6 s | Verts LOD0 | 5,600 |

**Behaviour & art direction.** Four and a half metres of slow, silent, black wing sliding over the ash plain twenty metres above the bottom, its dorsal net-pattern glowing so dimly that it is only visible when you have your lamps *off*. It is the abyss's ambassador: not a hunter of the player, but enormous, easily provoked, and equipped with a tail lash that can crack a windshield. Its 22 Hz wingbeat is a genuine infrasound design choice — the player feels it in the HUD jitter and the sub-bass long before there is anything to see, which is the single most reliable "you are not alone down here" cue in the game. Watching one detect a buried Sepulcher Louse, stop, hover, and pin it with its disc is one of the best things in the deep.

**Mesh recipe.** `LOFT(19 rings, 26 segs)` broad disc, `e=0.70` superellipse plan, thickness `0.11*width`; cephalic lobes as 2 `LATHE(4,7)` horns; tail `TUBECHAIN(15,7)` at 1.6x disc width with 3 barbs; rajiform wave on 8 strip bones per side, `lambdaFin = 1.4`, `fFin = 0.35 + 0.9*U`. `NOISE_DISP(oct=5, amp=0.03)` for a leathery, pitted dorsum. 30 bones. The net pattern is a procedural Worley-cell emissive at 0.008 HDR.

#### 27. `CRT_LANTERNGAPE` — Lanterngape
*Illicioceras fallax* | `ARCH_LURER` | tier 3 | B5-B7

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_WALL, BIO_CANYON, BIO_TRENCH upper | Depth (m) | 540 - 2,100 |
| Length (m) | 1.05 (female; males 0.09 and harmless) | Mass (kg) | 34 |
| Diet | Wisplight, Umbral Squid juveniles, anything smaller than itself, and it will try things larger | Danger tier | 3 |
| Health (HP) | 160 | Damage/hit (HP) | 26 (player) / 11 (vessel) + **grip**: 1.6 s hold, player cannot swim, 6 HP/s |
| Speed base/burst (m/s) | 0.20 / 8.8 (0.85 s only) | Turn rate (deg/s) | 55 (500 during windup) |
| School size | 1 | Density | 18 / km^3 |
| Activity | 1.0 / 1.0 | Light affinity | flip@40m: +0.55 far, -0.75 near |
| Aggro trigger | **any object approaching within 3.2 m of the lure tip**; also `x_scent > 0.10` | Threat tau (s) | 55 |
| Biolum | **the lure**: a single point `(0.55,0.90,0.65)` at HDR 3.5, pulsing on a 1.1 s period with a 0.35 s "twitch" that mimics the exact flicker signature of a `RES_LUMEN_NODULE` collectible. Body: 6 faint `(0.10,0.30,0.35)` gill-arch dots, HDR 0.02 | **YES — see 06.5.5** |
| Audio | **the lure is silent — this is the game's one permitted silent approach, and it is legal because the player must approach IT.** Once triggered: a 0.80 s windup of a wet, rising 55->150 Hz gape-groan + a 2.8 kHz tooth-scrape. Bite = a 70 Hz crunch | Verts LOD0 | 2,750 |

**Behaviour & art direction.** A globular, loose-skinned, matte-black predator with a mouth that is 40% of its body length, teeth that are transparent (so they read as absence rather than as white), and a single luminous nodule on a whip of dorsal spine held 0.4 m in front of its own face. It does not move. It hangs against the wall, lamps-invisible, and it *waits*. The only thing you see is a small green light in the dark, drifting slightly, twitching in a way that is genuinely, deliberately identical to a resource nodule — and the game's entire risk economy runs through that one deception. When it fires, its jaw hyper-extends over 0.8 s of loud, unmistakable windup, so the player who was paying attention always escapes and the player who was greedy never does.

**Fairness contract.** The Lanterngape is the *only* creature in SUBWAVE permitted to be silent before its trigger, and it is permitted precisely because it never closes distance: the trigger volume is a 3.2 m sphere centred on the lure tip and the player must voluntarily enter it. Trigger volume is rendered (invisibly) with a stable, non-shrinking radius, and the lure never moves toward the player faster than 0.20 m/s. Once triggered, all normal tier-3 telegraph rules apply in full.

**Mesh recipe.** Body `SDF_MC(res=48)` of a union of 3 spheres, then `NOISE_DISP(oct=5, amp=0.018, freq=6)` for loose slack skin; jaw = 2 huge `LATHE(6,11)` plates on 2 bones with a 108 deg gape and a distensible ventral pouch driven by the `inflate` channel; 44 transparent teeth instanced; illicium `TUBECHAIN(4 pts, 4 segs)` on a 3-bone chain with a damped-spring so the lure bobs; esca = a 1-vert emissive point + a 0.06 m billboard. 18 bones.

#### 28. `CRT_UMBRALSQUID` — Umbral Squid
*Skiateuthis vorax* | `ARCH_CEPHALOPOD` | tier 3 | B4-B7

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_PELAGIC, BIO_CANYON, BIO_WALL, BIO_TRENCH | Depth (m) | 300 - 2,400 |
| Length (m) | 3.80 (mantle 1.5, arms 2.3) | Mass (kg) | 190 |
| Diet | Wisplight shoals, Chiselfin, Lanterngape, cannibalism | Danger tier | 3 |
| Health (HP) | 260 | Damage/hit (HP) | 16 per tentacle strike (up to 2/s) / 12 (vessel) + **latch**: attaches to the hull, drag +140%, 5 HP/s hull, shed by a 2.0 s full-reverse burn or a spotlight at > 2000 lux |
| Speed base/burst (m/s) | 1.3 / 13.0 (jet, 1.4 s) | Turn rate (deg/s) | 240 (instant 180 deg flip via mantle reversal) |
| School size | 1 - 3 (hunting associations of up to 14 on a big shoal) | Density | 14 / km^3 |
| Activity | 0.8 day / 1.4 night (follows the krill layer up) | Light affinity | flip@25m: +0.20 far, -0.85 near |
| Aggro trigger | any moving object 0.5-9 m long within 30 m; retreats immediately if it takes > 25% health | Threat tau (s) | 20 |
| Biolum | full-surface **chromatophore + photophore hybrid**: base state matte black; aggressive display = red-white strobing bands `(1.0,0.15,0.10)`/`(1.0,0.95,0.90)` travelling head-to-tail at 4 Hz, HDR 2.5 | Lure | no |
| Audio | jet = a 55 Hz cavitation thump + 2.2 kHz water shear, 0.4 s. **Tell**: 0.7 s before a strike, arms snap into a cone and it emits a 900 Hz -> 320 Hz descending "reel-in" whine (this is the arm-crown drag, physically motivated) | Verts LOD0 | 6,900 |

**Behaviour & art direction.** Nearly four metres of red-black muscle that hangs motionless in mid-water with its arms trailing, then crosses eighteen metres in a second and a half. Its strobe display is the most aggressive visual in the game: when it commits, the entire animal becomes a strobing barber-pole of red and white that lights the water around it, which is both terrifying and *generous* — you cannot miss it. Its intelligence is expressed by retreat: it probes, takes damage, disengages, circles at 40 m in the dark, and comes back from a different angle up to three times before giving up entirely. Killing one is a real fight; being latched onto by one at 1,100 m while your hull integrity drops is the mid-game's signature panic.

**Mesh recipe.** Mantle `LATHE(9, 16)` with a jet scale bone; two large terminal fins `FIN(strip=6, camber=0.10)`; 8 arms `TUBECHAIN(9,7)` + 2 long tentacular clubs `TUBECHAIN(14,6)` with expanded club pads, all damped-spring (k=55, c=9) with a `pursuitLead` term so the club tips genuinely aim; 340 instanced hooked suckers on `extra.w` mask. 36 bones — uses the leviathan palette allocation. Chromatophore strobe is a single 1D travelling-wave function of `uv.x` with a per-instance phase, zero texture cost.

#### 29. `CRT_SEPULCHER` — Sepulcher Louse
*Necrocaris grandis* | `ARCH_CRUSTACEAN` | tier 1 | B5-B7

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_ASHPLAIN, BIO_TRENCH, BIO_CANYON floor | Depth (m) | 600 - 3,200 |
| Length (m) | 0.68 | Mass (kg) | 11 |
| Diet | carrion (obligate); can fast for 180 game-days | Danger tier | 1 |
| Health (HP) | 120 (carapace 70% reduction dorsally) | Damage/hit (HP) | 6 |
| Speed base/burst (m/s) | 0.25 / 1.4 | Turn rate (deg/s) | 120 |
| School size | 1; **40 - 400** converge on a large corpse | Density | 480 / km^3 |
| Activity | 1.0 / 1.0 (no light to have a day) | Light affinity | -0.40 (curls into a ball under a lamp) |
| Aggro trigger | only if attacked, or if the player is at < 25 HP and stationary for > 20 s (it will test you) | Threat tau (s) | 22 |
| Biolum | none. Carapace has a faint dielectric iridescence under lamp light — the only pretty thing about it | Lure | no |
| Audio | mass feeding = a dry, ghastly 1.1 kHz chitin-on-bone rasp chorus with a 90 Hz undertone; individual movement = discrete 700 Hz taps | Verts LOD0 | 1,850 |

**Behaviour & art direction.** A 68 cm armoured isopod-analog, bone-white, with 14 legs and enormous compound eyes that have no light to see by. They are the abyss's undertakers and the game's most important storytelling tool: **every corpse in the deep is eventually covered in them**, and the state of a corpse tells you how long ago something died there. Finding a Veilmouth carcass at 800 m with two hundred Sepulcher Louse still working on it, in silence, in your lamp beam, is the intended emotional preparation for meeting the thing that killed it. They curl into perfect armoured spheres when lit and roll slightly, which is both accurate and deeply unpleasant.

**Mesh recipe.** 9 overlapping `SHELLPLATE(6)` tergites on a 9-bone chain enabling a real curl (chain flexes to a 320 deg arc); 14 legs `TUBECHAIN(4,5)` with metachronal wave gait (`phi_leg = 2*pi*legIndex/14`); 2 uropod fans; 2 compound eyes as hex-tiled emissive-zero spheres with a strong retro-reflective lobe (they eyeshine dull orange, which is horrible). 26 bones.

#### 30. `CRT_EMBERWORM` — Emberworm
*Thermovermis ignicola* | static colony | tier 0 | B6

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_VENT (within 12 m of an active chimney) | Depth (m) | 900 - 1,600 |
| Length (m) | 2.20 tube, 0.55 plume extension | Mass (kg) | 4 |
| Diet | chemosynthetic symbionts (sulphide oxidation) | Danger tier | 0 |
| Health (HP) | 30 (tube 200) | Damage/hit (HP) | 0 |
| Speed base/burst (m/s) | 0 | Turn rate (deg/s) | 0 |
| School size | colonies of 60 - 900 tubes | Density | 2.4e5 / km^3 within vent fields only |
| Activity | 1.0 / 1.0 | Light affinity | -0.90 (plume retracts into the tube in 0.25 s under a lamp) |
| Aggro trigger | none | Threat tau (s) | n/a |
| Biolum | plume `(1.00,0.25,0.06)` deep red haemoglobin-analog, not emissive but **strongly forward-scattering** — it glows orange in a lamp beam like a filament | Lure | no |
| Audio | none. The vent itself carries a 28 Hz roar + 3.5 kHz hiss (Section 08 owns the vent bed) | Verts LOD0 | 340 per tube |

**Behaviour & art direction.** Forests of chalk-white chitin tubes two metres tall, leaning into the shimmer, each crowned with a plume of scarlet feathery gills. They react to *everything*: a lamp sweep across a colony of 400 makes a wave of red plumes vanish into their tubes in sequence at the speed of the beam, and they re-emerge over 4-9 s once the light passes. That single interaction is the entire reason this species exists — it is the deepest, darkest, most alien place in the game answering the player's presence, without threat, without a single tooth. The vent fields are also the safest place below 900 m, which is a deliberate and load-bearing lie the game tells.

**Mesh recipe.** Tube `LATHE(7, 9)` slightly bent, `NOISE_DISP(oct=4, amp=0.01)`; plume = 9 `FIN(strip=5)` feather blades on a single retract bone with a uniform scale + a translate of `-0.5 m` into the tube; per-tube seed drives height (1.1-2.2 m), lean (0-22 deg) and plume colour jitter. 3 bones. Rendered as one instanced draw per colony, retraction state packed in a per-instance f32 updated by a 1 kHz-cheap CPU sweep test against lamp cones.

#### 31. `CRT_SCALDBACK` — Scaldback
*Pyrocheles ferox* | `ARCH_CRUSTACEAN` | tier 2 | B6

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_VENT and 60 m around it | Depth (m) | 880 - 1,600 |
| Length (m) | 1.15 (claw span 1.5) | Mass (kg) | 42 |
| Diet | Emberworm plumes, Sepulcher Louse, vent shrimp, carrion | Danger tier | 2 |
| Health (HP) | 340 (carapace 75% frontal reduction; **immune to heat damage**) | Damage/hit (HP) | 24 (player) / 20 (vessel) |
| Speed base/burst (m/s) | 0.5 / 3.2 | Turn rate (deg/s) | 170 |
| School size | 1 - 4 | Density | 210 / km^3 within vent fields |
| Activity | 1.0 / 1.0 | Light affinity | -0.25 |
| Aggro trigger | intrusion within 5 m of its chimney, OR harvesting an Emberworm colony it is guarding (it *guards*) | Threat tau (s) | 40 |
| Biolum | carapace has hot patches `(1.0,0.35,0.10)` at HDR 0.6 — genuinely thermal, brightest right after it has been in the plume; visible on the vessel's thermal overlay at 120 m | Lure | no |
| Audio | **tell**: a 0.6 s stridulation buzz sweeping 90->260 Hz plus a metallic 1.8 kHz claw ring. Charge = heavy 45 Hz substrate thuds at 3.1 Hz | Verts LOD0 | 3,400 |

**Behaviour & art direction.** A blind, brick-red, heavily armoured vent crab the size of a large dog, with hairy setose legs, one massive crusher claw and one fine cutter, standing in 340 C water like it is a warm bath. It is the only creature that will fight the player *for territory* rather than food, and it is the reason harvesting the richest ore and biomass in the game is not free. Its heat immunity is a real mechanic: it will happily reposition through the vent plume, which damages the player for 14 HP/s and the vessel for 9 HP/s, so it can attack from an axis the player cannot follow. Counterplay is patience and lateral movement, not damage.

**Mesh recipe.** `SHELLPLATE(13)` broad carapace with a deep frontal notch, `NOISE_DISP(oct=6, amp=0.014)`; 2 asymmetric chelae `LATHE(7,12)` x2 halves on 3 bones each; 8 legs `TUBECHAIN(5,6)` with 900 instanced setae as alpha strips; thermal patches are an emissive mask blended by an internal `heatCharge` float (0-1) that charges at 0.25/s in a plume and decays at 0.04/s. 28 bones.

#### 32. `CRT_SALTWRAITH` — Saltwraith
*Halomurena spectralis* | `ARCH_AMBUSHER` | tier 3 | B7

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_BRINE (the Still Lake and its shoreline), BIO_TRENCH margin | Depth (m) | 1,500 - 3,200 |
| Length (m) | 5.20 | Mass (kg) | 340 |
| Diet | anything that touches the brine surface; Sepulcher Louse; Ghostbell | Danger tier | 3 |
| Health (HP) | 520 | Damage/hit (HP) | 34 (player) / 26 (vessel) + **drag-under**: 2.4 s pull toward the brine pool, which is instant-death-by-density for the player and a 60 HP/s hull crush for the vessel |
| Speed base/burst (m/s) | 0.7 / 12.2 (strike, 0.9 s) | Turn rate (deg/s) | 80 (600 during strike) |
| School size | 1 (up to 5 ring a large pool, evenly spaced by mutual `separation` at 22 m) | Density | 4 / km^3 in BIO_BRINE only |
| Activity | 1.0 / 1.0 | Light affinity | -0.65 |
| Aggro trigger | **any disturbance of the brine interface within 14 m**, i.e. crossing the halocline, dropping an object into it, or thruster wash on it | Threat tau (s) | 90 |
| Biolum | none on the body. A row of 9 `(0.75,0.90,1.00)` cold-white pores along each jaw that only illuminate during the 1.0 s strike windup — so it lights its own face 1.0 s before it kills you | Lure | no |
| Audio | **tell**: 1.0 s windup, a wet suction-slide of 60->40 Hz descending plus a 240 Hz throat rattle. Ambient: it is silent, but the brine pool itself has a 19 Hz standing-wave hum, and the hum's amplitude *modulates* when a Saltwraith moves through it — a genuinely diegetic proximity sensor | Verts LOD0 | 4,200 |

**Behaviour & art direction.** Five metres of pale, translucent, eyeless eel buried to the gills in the flocculent crust at the edge of a brine pool, invisible until the moment its jaw-pores light. The Still Lake is a real, physically distinct fluid body (Section 04): denser than seawater, with a mirror-flat surface and its own shoreline of white bacterial mat, and the Saltwraith is the reason the player will stand at that shoreline and *not* go in. It hunts by electroreception (`electroR` = 26 m) and by sensing the interface directly, so darkness and stillness do not save you — only staying out of the water does. Its drag-under is the game's only instant-kill and it is signposted by a full second of a face full of lights.

**Mesh recipe.** `TUBECHAIN(30 pts, 11 segs)` anguilliform, laterally compressed toward the tail with a continuous dorsal `FIN(strip=22)`; head `SDF_MC(res=40)` with a distensible pharyngeal jaw on 3 bones (it has a second, inner jaw that comes forward 0.35 m on the bite — this is real biology and it is the single most upsetting animation in the game); 18 jaw-pore emitters. 16 spine bones + 6 head/jaw. Burial uses the same vertex sink as Sandveil, with a brine-crust decal that shatters into 40 debris instances on emergence.

#### 33. `CRT_PALEWANDER` — Palewander
*Cavernops caecus* | `ARCH_SHOALER` | tier 0 | BX

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_CAVE (all Undervault branches) | Depth (m) | any, enclosed | 
| Length (m) | 0.20 | Mass (kg) | 0.07 |
| Diet | cave detritus, bacterial mat, chemosynthetic film | Danger tier | 0 |
| Health (HP) | 4 | Damage/hit (HP) | 0 |
| Speed base/burst (m/s) | 0.5 / 2.4 | Turn rate (deg/s) | 380 |
| School size | 60 - 400 (GPU shoal) | Density | 3.0e4 / km^3 in cave volume |
| Activity | 1.0 / 1.0 | Light affinity | **0.0 — completely indifferent, because it has no eyes** |
| Aggro trigger | none | Threat tau (s) | 5 |
| Biolum | none | Lure | no |
| Audio | none. Their shoal produces only a lateral-line-scale water disturbance — the vessel's flow sensor registers them as a soft 40 Hz whisper | Verts LOD0 | 380 |

**Behaviour & art direction.** Blind, unpigmented, semi-translucent cave fish with visible spines and a slow, deliberate hover, navigating a pitch-black flooded cave system perfectly by lateral line alone. Their indifference to the player's lamp is the entire design: every other creature in the game responds to light, and these ones do not even know it exists, which makes the Undervault feel like a place that is not *for* you. They flow around the vessel like water around a stone, never startle at light, and startle violently at sound — so a player running silent can drift through a hundred of them and a player on thrusters cannot. They are the Undervault's only friendly face.

**Mesh recipe.** `LOFT(9, 8)` slender; skull is a thin translucent dome with a visible brain and a shader-side subsurface term (thickness 0.004 m); no eyes — two shallow dimples; elongated pectoral rays `FIN(strip=4)` used as feelers with a slow independent sway; 6 spine bones. GPU-skinned. Material uses a strong forward-scattering phase function so a shoal in a lamp beam reads as a cloud of pale commas.

#### 34. `CRT_VAULTSTALKER` — Vaultstalker
*Speleovenator albus* | `ARCH_AMBUSHER` | tier 4 | BX

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_CAVE (branches deeper than 400 m only) | Depth (m) | 400 - 3,000, enclosed |
| Length (m) | 6.80 | Mass (kg) | 1,150 |
| Diet | Palewander, Umbral Squid, Sepulcher Louse, and it is not fussy | Danger tier | 4 |
| Health (HP) | 1,400 | Damage/hit (HP) | 46 (player) / 38 (vessel) |
| Speed base/burst (m/s) | 0.35 / 14.5 (2.0 s) | Turn rate (deg/s) | 45 cruising (380 in a strike) |
| School size | 1 (territories never overlap; enforced by a 600 m Poisson-disc constraint) | Density | 0.8 / km^3 of cave volume |
| Activity | 1.0 / 1.0 | Light affinity | flip@30m: +0.40 far, -0.80 near |
| Aggro trigger | sustained noise: `S_lateral > 2.0` for more than 3.0 cumulative seconds within its 180 m territory. **Not** sight. **Not** light alone | Threat tau (s) | 180 |
| Biolum | none whatsoever. Its skin is a chalk-white non-emissive `(0.86,0.84,0.80)` that is brilliantly, horribly visible in a lamp beam and utterly invisible without one | Lure | no |
| Audio | **ambient tell (always on within 200 m): a slow, dry, arrhythmic clicking, 3.1 kHz, 1-4 clicks every 6-20 s** — echolocation, and its rate rises to 2 Hz when it has a fix on you. **Strike tell: 1.2 s** of a low 48 Hz suction inhale + a rising 300->700 Hz scrape as its dorsal ridge drags the cave ceiling | Verts LOD0 | 7,800 |

**Behaviour & art direction.** Seven metres of blind white muscle that lives in the flooded tunnels and hunts entirely by sound. It presses itself flat against a ceiling or a wall in a side-passage and waits, sometimes for a real hour, and it *is genuinely there the whole time* — it does not spawn behind you. Its counterplay is silence: cut the thrusters, coast, and it will click past you at four metres. Its counterplay is not light, not speed and not weapons. This is the game's purest expression of "the deep does not care about your equipment", and it is placed in caves so that the player has always volunteered to be there.

**Fairness contract.** The Vaultstalker's echolocation clicking is audible at 200 m and *never* stops while it is within that radius, at any audio setting, including with music at 100%. Its click bus is routed pre-fader on a dedicated send. If the player has been within 200 m of a Vaultstalker for less than 8 s, its threat is hard-clamped to 0.9 (below `T_commit`) — it cannot attack a player who has just arrived and has not had time to hear it.

**Mesh recipe.** `LOFT(17 rings, 14 segs)` with a flattened cross-section (`rZ = 0.55*rY`) and a serrated dorsal ridge of 24 keratin blades; head `SDF_MC(res=56)` — broad, blunt, jawless-looking until it opens into a radial 5-lobed gape (5 jaw bones, each `LATHE(4,6)`); 6 long tactile filaments `TUBECHAIN(12,4)` sweeping constantly at 0.4 Hz; skin `NOISE_DISP(oct=6, amp=0.02, freq=2.5)` with visible subdermal vasculature via a thin translucency layer. 12 spine + 5 jaw + 6 filament root + 9 = 32 bones exactly.

---

### 06.4.6 THE THREE LEVIATHANS

Design rules common to all three:

1. A leviathan is **never** spawned within 250 m of the player. It is spawned at the far edge of its territory and it *arrives*.
2. A leviathan is always at LOD1 or better whenever it is within 900 m, so that its audio, its sonar return and its silhouette are all correct at long range.
3. Every leviathan has a **hard depth ceiling and floor**. It will not cross them. Ever. Under any provocation. The player can always escape vertically, and learning where each ceiling is *is the counterplay*.
4. Every leviathan attack has a telegraph of at least 1.2 s (tier 4) or 1.6 s (tier 5), plus 0.6 s if it approaches from outside the player's 100 deg front cone.
5. Leviathans have no health bar in the UI. They have health, and they can be driven off, but nothing tells the player how close they are — the *behavioural* change (disengage distance grows, calls change register) is the only feedback.
6. Only 2 leviathans may be simulated at once (1 on MEDIUM/LOW). The director will not place two territories within 1,500 m.

---

#### 35. `LEV_HOLLOWJAW` — Hollowjaw
*Cavignathus vastus* | `ARCH_LEVIATHAN` | **tier 4** | B4-B5

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_WALL, BIO_CANYON (Longfall Canyon and the upper Bathyal Wall) | Depth (m) | **380 - 980** (hard ceiling 380, hard floor 980) |
| Length (m) | 31.0 | Mass (kg) | 165,000 |
| Diet | Veilmouth, Umbral Squid, Chiselfin packs, Gloomray | Danger tier | 4 |
| Health (HP) | 9,000 (disengages permanently below 3,600) | Damage/hit (HP) | **bite 68 (player, lethal at low HP) / 260 (vessel hull)**; ram 40 / 180; tail sweep 25 / 90 |
| Speed base/burst (m/s) | 2.6 / 15.5 (charge, 3.5 s) | Turn rate (deg/s) | 22 (48 during a charge commit) |
| School size | 1 (territories 1,400 m apart minimum) | Density | 0.03 / km^3 in BIO_WALL/BIO_CANYON |
| Activity | 0.9 day / 1.2 night | Light affinity | -0.20 (does not care; it found you by sound) |
| Aggro trigger | vessel within its 320 m territory sphere at > 40% throttle; OR any sonar ping within 500 m; OR blood scent `x_scent > 0.06` | Threat tau (s) | 240 (it remembers) |
| Biolum | 4 rows of `(0.15,0.35,0.55)` dim blue pit-lights along the flank at HDR 0.05 — you cannot see them until it is inside 60 m, and by then it is far too late for them to be information | Lure | no |
| Audio | **41 Hz fundamental**, a descending moan 41->28 Hz over 7 s with harmonics at 82/123 Hz and a 3 Hz tremolo. Range 1,800 m. Repeats every 55-140 s. Charge windup = a 1.2 s rising 90->240 Hz throat rumble + a 6 kHz water-shear hiss | Verts LOD0 | 21,000 |

**Behaviour & art direction.** Thirty-one metres of blue-grey, scar-covered, blunt-headed animal built like a battering ram with a jaw that unhinges to 96 degrees, revealing a pale, ridged, hollow interior that gives it its name. It has small, forward-set eyes and a genuinely stupid, incurious expression, which is worse than malevolence. It patrols the canyon rim in long, slow, lazy figure-eights, and its 41 Hz call is designed to sit *just* below the Veilmouth's 62 Hz — the player's first reaction on hearing it will be relief, and the second will be the realisation that this is not the friendly one.

**ENCOUNTER DESIGN — HOLLOWJAW**

| Stage | Trigger | Content |
|---|---|---|
| **1. The sound** | Player first descends past 300 m anywhere in BIO_WALL or BIO_CANYON | The 41 Hz call plays at a simulated 1,400 m range: heavily lowpassed (LP 90 Hz, 2-pole), long reverb tail, no direction lock (the HUD threat arc shows a 60 deg ambiguity wedge). It is not repeated for at least 4 minutes. |
| **2. The evidence** | Player explores the canyon rim between 420-700 m | Three placed environmental facts, all generated, none scripted as cutscene: (a) **gouges** — parallel 0.4 m-wide furrow triplets raked across the canyon wall over spans of 12-30 m, cut into the terrain SDF at worldgen with a `scarField` layer; (b) a **Veilmouth carcass**, 60% consumed, draped over a ledge with 200 Sepulcher Louse on it and a 90 m-wide scent plume; (c) a **shed tooth**, 0.34 m, a real harvestable item, which is the first hard number the player gets about scale. |
| **3. The contact** | Player uses active sonar anywhere in the territory | The ping returns a single contact at 240-380 m with a **hull-length readout of 31 m**, moving at 2.6 m/s, and nothing visible in that direction at all. The ping also raises the Hollowjaw's threat by 0.9 and gives it the player's exact position. Using sonar is how most players meet it. |
| **4. The reveal** | Threat > 1.10 | It arrives from below and behind the *canyon*, not the player — it comes up the canyon axis, so it is silhouetted against the faint downwelling light for 3-4 s at 90-140 m before it is close. This is the money shot and it is always at a survivable distance. |

**Attack patterns.**

| Pattern | Range band | Windup | Execution | Recovery | Counterplay |
|---|---|---|---|---|---|
| `HJ_CHARGE` | 60 - 180 m | **1.2 s** rising throat rumble; head aims via `pursuitLead`; body straightens visibly | 3.5 s at 15.5 m/s along a **fixed** committed line (no homing after commit) | 2.6 s wide turn at 22 deg/s | Move laterally >= 9 m during the windup. It cannot re-aim. |
| `HJ_BITE` | 0 - 14 m | 1.2 s jaw opens over 0.8 s, +0.6 s if from the rear arc | 0.7 s closure | 1.9 s, jaw hangs open, +35% damage taken | Full reverse, or ascend — its ceiling is 380 m |
| `HJ_SWEEP` | 0 - 22 m, lateral | 0.9 s (tail cocks visibly, whole body S-bends) | 0.5 s tail arc, 90 deg | 1.4 s | Be above or below its body plane; the sweep is planar |
| `HJ_GRAB` | 0 - 9 m, vessel only, only if hull < 45% | 1.6 s | Latches, 4.0 s of 55 HP/s, drags the vessel 40 m *downward* toward its floor | 3.0 s | Full reverse + emergency ballast blow. Never a grab on a healthy hull. |

**Depth limits and counterplay (BINDING).** Ceiling **380 m**, floor **980 m**. Above 380 m it turns away within 2 s and emits a frustrated 34 Hz bark. Below 980 m it will not follow (this is the Pale Herald's territory and they do not overlap). Its charge is the entire fight: it is a game of lateral dodges with a 1.2 s window, in a canyon that punishes lateral movement with walls. Disengage: it breaks off at 3,600 HP, or if the player leaves the 320 m territory sphere for 45 continuous seconds, or if the player is powered down (`S_lateral < 0.5`) for 30 s.

**Mesh recipe.** `LOFT(29 rings, 22 segs)`, blunt anterior with a massive occipital mass; jaw = 2 `SDF_MC(res=64)` mandible halves on 3 bones each, gape 96 deg, 60 instanced conical teeth 0.30-0.40 m; pectoral `FIN(strip=9, camber=0.09)` on 3 bones each; lunate caudal `FIN(strip=13)` on 3 bones; 16 spine bones (thunniform, `lambdaB = 1.25`, `A1 = 0.09`). Skin: `NOISE_DISP(oct=7, amp=0.08, freq=0.9)` + 60 procedural scar strokes + 200 instanced parasite-analogs on the leading edges. 48 bones (leviathan palette). LOD1 at 5,200 verts, LOD2 at 1,700.

---

#### 36. `LEV_PALEHERALD` — Pale Herald
*Praeconodus albus* | `ARCH_LEVIATHAN` | **tier 5** | B6

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_ASHPLAIN, deep BIO_SPONGE, BIO_WALL base | Depth (m) | **820 - 1,750** (hard ceiling 820, hard floor 1,750) |
| Length (m) | 47.0 | Mass (kg) | 520,000 |
| Diet | Hollowjaw, Gloomray, Umbral Squid, Veilmouth | Danger tier | 5 |
| Health (HP) | 26,000 (disengages below 40%, i.e. 10,400) | Damage/hit (HP) | **bite 100 (player, always lethal) / 420 (vessel)**; shockwave 30 / 140 (AoE); ram 55 / 300 |
| Speed base/burst (m/s) | 3.1 / 19.0 (charge, 4.5 s) | Turn rate (deg/s) | 15 (36 committed) |
| School size | 1 | Density | 0.012 / km^3 |
| Activity | 1.0 / 1.0 | Light affinity | flip@120m: +0.35 far (it comes to look at your lights), -0.60 near |
| Aggro trigger | **any active sonar ping within 900 m** (it answers pings); OR a vessel above 55% throttle within 400 m for > 10 s; OR blood `x_scent > 0.04` | Threat tau (s) | 240, with a persistent grudge (06.1.9) |
| Biolum | its head carries a broad `(0.85,0.92,1.00)` cold-white **bioluminescent floodlight organ**, HDR 40, a 28 deg cone, that it switches on for 2-4 s at a time to search. Being lit by it is the game's single most frightening moment | Lure | no (but the flood *finds* lures) |
| Audio | **echolocation: a 9.4 kHz click train**, inter-click interval falling from 900 ms (searching) to 90 ms (fixed on you) to a 12 ms **buzz** in the final 1.6 s before a bite. Plus a **contact call: an 18 Hz infrasound groan**, 9 s long, range 2,600 m, that visibly vibrates the windshield HUD (a 0.7 px sinusoidal UV wobble at 18 Hz) | Verts LOD0 | 27,500 |

**Behaviour & art direction.** Forty-seven metres of chalk-white, slab-sided, eyeless animal that navigates a lightless plain by sound and lights it with its own face when it wants to see. Its skin is dead white with grey blotching, deeply wrinkled at the joints, hung with pale parasitic streamers; it has no eyes at all, only a smooth, blank melon and a jaw that runs a third of its body length. Its terror is a *pacing* terror rather than a speed terror: it is slow, it is patient, it can hear the player's heartbeat as far as a kilometre away, and its click train is a countdown the player learns to read with total precision. When the interval drops below 200 ms, you have about four seconds.

**ENCOUNTER DESIGN — PALE HERALD**

| Stage | Trigger | Content |
|---|---|---|
| **1. The answer** | Player pings active sonar anywhere below 800 m | Nothing returns for 4.5 s. Then, from a random bearing, **an identical ping comes back** — a 9.4 kHz click at the player's own ping frequency, at a range that reads as 2,100 m. The HUD logs a contact with **no size readout** (the return is too large for the classifier: it displays `--` where a length should be). The player did this to themselves and they know it. |
| **2. The infrasound** | Within 15 minutes of stage 1, when the player is below 850 m | The 18 Hz groan, at 1,800 m. The windshield HUD physically wobbles. There is nothing to see in any direction. Repeats every 3-8 minutes thereafter whenever the player is in B6. |
| **3. The corpse** | Player crosses the Ashfall Plain | A **Hollowjaw carcass** — 31 m of the previous leviathan, bitten cleanly in two, the anterior half missing, the severed surface a smooth 9 m arc that is exactly the radius of something's jaw. 400 Sepulcher Louse. A scent plume 300 m across. This is the only piece of environmental storytelling in SUBWAVE that is allowed to be this blunt, and it is worth it. |
| **4. The light** | Threat > 0.9 | Somewhere in the black, at 200-400 m, **its floodlight switches on for 3 s** and sweeps. If it catches the vessel, the beam holds and the click interval drops to 300 ms. If it misses, it switches off and the player has 20-40 s to leave. This is the fairest scare in the game: total information, total dread. |
| **5. The commit** | Threat > 1.10 | Buzz phase. Click interval 90 ms falling to 12 ms. It does not charge from range; it arrives, floods you, and bites. |

**Attack patterns.**

| Pattern | Range band | Windup | Execution | Recovery | Counterplay |
|---|---|---|---|---|---|
| `PH_SEARCHLIGHT` | 120 - 500 m | n/a (not an attack) | 3.0 s cone sweep at 14 deg/s | 20-40 s off | Power down. Lit-vessel detection is 4x. |
| `PH_APPROACH_BUZZ` | 40 - 200 m | click interval 90 -> 12 ms over 6 s | closes at 8 m/s | n/a | The entire 6 s is the window. Ascend to 820 m. |
| `PH_BITE` | 0 - 26 m | **1.6 s** (+0.6 rear arc): jaw opens over 1.1 s, flood snaps to full, buzz saturates | 0.95 s closure across a 26 m arc | 2.6 s, +40% damage taken | Vertical: it bites in a horizontal plane. Dive or climb 12 m. |
| `PH_RAM` | 80 - 300 m | 1.6 s, body straightens, flood locks forward | 4.5 s at 19 m/s, **committed line, no homing** | 3.4 s wide turn | Lateral 14 m during windup |
| `PH_SHOCKWAVE` | 0 - 45 m radial | 1.4 s: it inflates its melon (visible, `inflate` channel) and the ambient 18 Hz swells | a single 45 m radial pressure pulse, 30/140 damage, and **it stuns every other creature in radius**, which is a spectacular thing to witness | 5.0 s | Get outside 45 m; or accept it, it is not lethal |

**Depth limits and counterplay (BINDING).** Ceiling **820 m**, floor **1,750 m**. It will not follow above 820 m — and the Hollowjaw's floor is 980 m, so there is a 160 m band (820-980 m) where the player is inside *both* territories and safe from *neither*, which is the most tense navigable water in the game and is entirely intentional. Counterplay: total silence. Powered down (`S_lateral < 0.5`, lights off, no sonar) the Pale Herald's detection range collapses from 900 m to 55 m, and it will click straight past. Never, ever use active sonar below 800 m — the game teaches this by making sonar genuinely essential above 800 m.

**Mesh recipe.** `LOFT(35 rings, 24 segs)` with a huge squared melon and a long, low jaw; mandible on 4 bones with 72 instanced peg teeth 0.5 m; melon inflation on the `inflate` channel with a 1.18x max scale; 4 pale parasitic streamer clusters `TUBECHAIN(16,4)` trailing 6 m; pectorals `FIN(strip=11)`; flukes `FIN(strip=15)` horizontal (thunniform, dorsoventral beat, `Ap = 0.6*A`). Skin: `NOISE_DISP(oct=7, amp=0.14, freq=0.55)` deep wrinkle bands at the joints + 90 scar strokes + a blotch mask from 3-octave Worley. Floodlight is a real spot light in the renderer with a 28 deg cone, 40 HDR intensity, volumetric shafts enabled, and it casts real shadows from the terrain. 48 bones.

---

#### 37. `LEV_NETHERCOIL` — Nethercoil
*Abyssoserpens innumerabilis* | `ARCH_LEVIATHAN` | **tier 5 (apex)** | B7

| Field | Value | Field | Value |
|---|---|---|---|
| Biomes | BIO_TRENCH, BIO_BRINE basin | Depth (m) | **1,650 - 3,200** (hard ceiling 1,650; no floor — the trench is its floor) |
| Length (m) | 96.0 | Mass (kg) | 1,250,000 |
| Diet | Pale Herald, Saltwraith, and geology, apparently | Danger tier | 5 |
| Health (HP) | 60,000 (**cannot be killed in the base game**; disengages at 30%, regenerates 1% per game-day) | Damage/hit (HP) | **bite: instant death (player) / 900 (vessel)**; coil-crush 70 / 340 per second; tail slam 60 / 400 |
| Speed base/burst (m/s) | 2.2 / 17.0 (surge, 6.0 s) | Turn rate (deg/s) | 9 body / 40 head (the head moves independently on a 30 m neck) |
| School size | 1. There is exactly one. | Density | 1 per world |
| Activity | 1.0 / 1.0 | Light affinity | **-1.00 at any range.** It hates light. Lights are how you make it come. |
| Aggro trigger | any light source above 800 lux within 600 m; OR any sonar ping within 1,400 m; OR entering the trench axis below 2,200 m for more than 60 s | Threat tau (s) | **900** (it does not forget within a session) |
| Biolum | **the interior of its mouth only**: a deep `(0.55,0.05,0.15)` red glow, HDR 1.2, visible only when the jaw is open, which means the only time you see its light is the moment before it closes | Lure | no |
| Audio | **11 Hz infrasound**, below the threshold of hearing, delivered as: a 0.9 px HUD wobble, a 3 Hz amplitude modulation of *every other sound in the mix*, and a genuine 11 Hz sub through the LFE. Range: **the entire trench**. Plus a 220 Hz scale-drag rasp when it moves along the trench wall, and a 5-second 34 Hz->14 Hz descending roar on commit | Verts LOD0 | 34,000 (48 spine segments) |

**Behaviour & art direction.** Ninety-six metres of segmented, armoured, blind serpent living in a trench three kilometres down, with a head like a geological formation and a body that is never fully visible at once — you see a section of it pass through your lamp cone, and then more of it, and then more. Its scales are matte black with a dull metallic sheen at grazing angles. It moves in slow horizontal coils along the trench axis, and the correct player experience of it is not a fight, it is **hiding in a crevice with everything switched off while ninety-six metres of animal goes past four metres away for eleven continuous seconds.** It is not a boss. There is no reward for engaging it. The reward is having seen it and having left.

**ENCOUNTER DESIGN — NETHERCOIL**

| Stage | Trigger | Content |
|---|---|---|
| **1. The pressure** | Player descends below 1,500 m for the first time | No sound, no contact. Instead: the ambient mix gains a 3 Hz amplitude modulation, and the windshield HUD develops a slow 0.9 px wobble that the player cannot attribute to anything. Nothing else happens for a long time. This is the most effective thing in the entire audio design and it costs one LFO. |
| **2. The scale** | Player finds the trench wall between 1,900-2,400 m | Embedded in the trench wall: **a single shed scale, 4.2 m across**, a harvestable object that yields the game's best hull material. It is convex, ridged, and unmistakably part of an animal. The player can stand a 7.4 m vessel next to it. |
| **3. The corpse** | Player reaches the Still Lake brine basin | **A Pale Herald carcass**, 47 m, intact, with a single 9 m puncture through the melon and a body wrapped in a spiral pattern of crushed, flattened tissue with a **28 m pitch**. The player can read the diameter of what did this directly off the geometry. There is no text. There does not need to be. |
| **4. The passage** | Player is in the trench axis with any light on, or after 60 s below 2,200 m | The 11 Hz modulation deepens. The 220 Hz scale-drag rasp begins, from a bearing, and gets closer over 40-90 s. Then it passes: a body section fills the entire windshield at 4-30 m for 9-14 s. **On the first passage it does not attack, regardless of threat.** It is scripted-safe exactly once, so that the player learns what it is before they learn what it does. |
| **5. The hunt** | Any subsequent trigger | Full aggression. See patterns below. |

**Attack patterns.**

| Pattern | Range band | Windup | Execution | Recovery | Counterplay |
|---|---|---|---|---|---|
| `NC_SURGE` | 150 - 600 m | **1.6 s**: the 34->14 Hz roar; the head rears and the mouth opens (the only red light you will ever see from it) | 6.0 s at 17 m/s along a committed line with a 40 deg/s head-only correction | 5.0 s | Kill all lights within the windup. Detection collapses instantly (see below). |
| `NC_BITE` | 0 - 34 m | 1.6 s (+0.6 rear) | 1.1 s, jaw arc 34 m | 3.2 s | Vertical, into a crevice narrower than 6 m. It cannot enter. |
| `NC_COIL` | 0 - 45 m, vessel only | 2.2 s: the body forms a visible arc around the vessel | 4.0 s crush at 340 HP/s to the hull | 6.0 s | Emergency ballast blow + full vertical. Escaping a coil is the game's hardest skill check. |
| `NC_TAILSLAM` | 0 - 60 m | 1.4 s: the tail cocks against the trench wall, dislodging a visible rockfall | 0.8 s, 60 deg arc, 400 hull damage, **plus a real terrain-deforming impact** that opens or closes trench side-passages | 4.0 s | Be inside 12 m of the trench wall on the opposite side |

**Depth limits and counterplay (BINDING).** Ceiling **1,650 m**. It will not, cannot and does not follow above it. The Pale Herald's floor is 1,750 m, so between 1,650 m and 1,750 m the player is in the only water in the game that is inside *two* leviathan territories. Primary counterplay is **darkness**: with all lights off and no sonar, the Nethercoil's detection radius drops from 600 m to **18 m**, and it navigates by feel; it will pass a dark, drifting vessel without noticing. Secondary counterplay is **geometry**: it cannot enter any passage narrower than 6 m, and the trench walls are riddled with them; the game teaches the player to read a crevice for width at a glance. Tertiary counterplay is **stillness**: a vessel with thrusters off and zero relative velocity to the current is undetectable at any range.

**Mesh recipe.** 48 body segments, each a `LATHE(9, 18)` armoured ring with an overlapping tergite lip and 6 lateral spines, on a **48-bone anguilliform chain** (`lambdaB = 0.65`, `A1 = 0.06`, `f0 = 0.06`, `fMax = 0.35`) — the wave takes 14 s to travel the body, which is the correct and horrifying number. Head `SDF_MC(res=96)` of a fused union of 5 armoured plates with a radially-opening 6-lobed jaw on 6 bones; interior mouth geometry is a separate emissive shell. Skin: `NOISE_DISP(oct=8, amp=0.22, freq=0.3)` + 200 procedural gouges + an anisotropic sheen at grazing angles only. Rendering: the body is drawn as 48 instanced ring meshes with per-instance bone transforms rather than a single skinned mesh, so vertex cost is `48 * 700 = 33,600` and the 32-bone skinning limit is bypassed entirely. This is the only creature in SUBWAVE with a bespoke render path, and it is worth it.

---

## 06.5 DREAD ENGINEERING

Dread in SUBWAVE is produced by **information asymmetry that always resolves in the player's favour if they pay attention**. Every rule below exists to keep that sentence true. There is no gore, no jump-scare stinger sting, and no music cue that tells the player something is coming. The ocean tells them.

### 06.5.1 The five dread instruments

| # | Instrument | Mechanism | Species | Cost |
|---|---|---|---|---|
| 1 | **Long-range low-frequency vocalization** | A sound with a source you cannot see, at a range you cannot judge, in a register your body reads as "large" | Veilmouth 62 Hz, Hollowjaw 41 Hz, Gloomray 22 Hz, Pale Herald 18 Hz, Nethercoil 11 Hz | 1 osc + 2 harmonics + LP + conv reverb |
| 2 | **Sonar contact with no visual** | A confirmed object, a confirmed range, a confirmed size, and nothing there | Hollowjaw (31 m readout), Pale Herald (`--` readout) | HUD only |
| 3 | **Silhouette at the edge of light** | A shape resolved at 0.7-1.0x lamp range, ambiguous for 2-6 s, then resolved as harmless 3 times out of 4 | Ghostbell, Veilmouth, Chainlight, Gloomray, and 1-in-4 a real threat | rendering only |
| 4 | **Lure lights that mimic collectibles** | A light that is 92% identical to a resource nodule | Lanterngape | shader match |
| 5 | **Environmental evidence of scale** | Gouges, carcasses, shed teeth and scales that let the player *measure* what is out there before meeting it | all three leviathans | worldgen `scarField` |

### 06.5.2 The low-frequency ladder (BINDING)

The five deep vocalizations are deliberately laid out as a descending ladder, so the player's fear response is *trained* rather than assumed. Each is one octave-ish below the last, and each is introduced in an order that makes the previous one feel safe in retrospect.

| Order met | Species | Fundamental | Duration | Interval | Audible range | Emotional function |
|---|---|---|---|---|---|---|
| 1st | Ribbonwether | 62 Hz contact rumble (short, warm) | 1.2 s | 8-20 s | 300 m | teaches "low = big = calm" |
| 2nd | Veilmouth | 62 Hz moan (long, harmonic-rich) | 6-11 s | 40-90 s | 1,200 m | teaches "very low = very big = still calm" |
| 3rd | Hollowjaw | 41 Hz descending moan | 7 s | 55-140 s | 1,800 m | **breaks the rule.** Same register, wrong animal. |
| 4th | Gloomray | 22 Hz wingbeat thump | 0.2 s | 1.4 s | 200 m | teaches "felt, not heard" |
| 5th | Pale Herald | 18 Hz groan + 9.4 kHz clicks | 9 s | 3-8 min | 2,600 m | the click train becomes a countdown |
| 6th | Nethercoil | 11 Hz (inaudible) | continuous | continuous | whole trench | not a sound at all — a modulation of everything else |

**Implementation of "felt not heard".** Below 25 Hz, the synth output is duplicated onto three non-audio channels:
1. HUD UV wobble: `uv += vec2(sin(2*PI*f*t), 0) * amp_px / resolution`, `amp_px` 0.4-0.9.
2. A global sidechain: every other audio bus gets `gain *= 1 - 0.18*(0.5+0.5*sin(2*PI*f*t))`.
3. Vessel camera shake: positional noise of amplitude `0.004 m * intensity` at the same frequency.

### 06.5.3 Silhouette ambiguity budget

The dread director maintains, per player session, a rolling ratio of **ambiguous silhouette encounters that resolve as harmless : as hostile**, targeted at **3:1** with a hard floor of 2:1 and a hard ceiling of 5:1 measured over the last 12 encounters. When the ratio drifts below 2:1 the director suppresses hostile spawns at silhouette range for the next two encounters; above 5:1 it permits one.

A **silhouette encounter** is defined precisely as: an agent of length >= 1.5 m entering the interval `[0.70 * R_lamp, 1.05 * R_lamp]` from the camera, at an angle within 55 deg of the view axis, with `P_see > 0.25`, for >= 1.2 continuous seconds, while ambient irradiance < 0.02 lux. `R_lamp` is the vessel lamp's effective range at the current depth (Section 05).

Ambiguity is **rendered**, not faked: at silhouette range the creature is drawn with its LOD1 mesh, unlit except by rim-scatter from the lamp's outer cone, so the shape is legible and the identity is not. No fog cheat, no fake dark material, no despawn-when-approached. **If the player closes on a silhouette, the thing that was there is still there.**

### 06.5.4 The safety-sound betrayal (used exactly twice)

Two scripted-but-emergent moments are permitted per playthrough, each fired once, each requiring a specific safe context to have been established first.

| # | Setup | Betrayal | Rule |
|---|---|---|---|
| 1 | Player has heard the Vaneskimmer colony every time they have been on the island (>= 6 visits) | On the first night they return to the island **after** first descending past 500 m, the colony is silent. Nothing happens. Nothing is there. It is silent for 90 s and then resumes. | Fires once, ever. No creature is spawned. The dread is entirely the absence. |
| 2 | Player has learned the Veilmouth 62 Hz moan as safe (>= 4 exposures logged) | On a specific descent into BIO_CANYON, the moan they hear is a Veilmouth **being killed by a Hollowjaw**: the 62 Hz call breaks off mid-phrase at 3.1 s with a 90 Hz crunch transient, followed by 6 s of silence, followed by the 41 Hz call at 400 m. | Fires once. The Veilmouth carcass then exists at that location permanently and is the stage-2 evidence for the Hollowjaw encounter (06.4.6). |

Both events are persisted to IndexedDB with a fired flag. Neither is ever repeated. This is the total budget for scripted dread in SUBWAVE.

### 06.5.5 Lure mimicry (the Lanterngape contract)

The Lanterngape's esca must be *nearly* indistinguishable from a `RES_LUMEN_NODULE` resource light — but nearly, not exactly. The differences are the player's reward for learning them.

| Property | `RES_LUMEN_NODULE` | Lanterngape esca | Detectable how? |
|---|---|---|---|
| Colour | `(0.52,0.92,0.62)` | `(0.55,0.90,0.65)` | not reliably by eye |
| Intensity | HDR 3.2, steady +/- 4% | HDR 3.5, pulsing 1.1 s period +/- 22% | **yes, if you watch for 2 s** |
| Motion | fixed to terrain, zero velocity | drifts <= 0.20 m/s, and **it drifts against the local current direction** | **yes, if you know the current** |
| Twitch | none | a 0.35 s lateral twitch of 0.06 m every 3-9 s | **yes** — this is the primary tell |
| Attachment | sits on a visible mineral cluster | hangs in open water or 0.4 m off a wall face | **yes** — check what it is attached to |
| Scanner | classifies as `MINERAL` at 25 m | classifies as `ORGANIC / UNKNOWN` at 25 m | **yes**, and the scanner is the reliable answer |

The vessel scanner (Section 05/09) resolves the ambiguity at 25 m, which is outside the 3.2 m trigger sphere by a factor of 7.8. **The player always has a free, reliable, non-lethal way to check.** The trap only ever catches impatience, and that is the correct thing for a trap to catch.

No other creature in SUBWAVE is permitted to mimic a collectible, a HUD element, a waypoint, or another creature's audio signature.

### 06.5.6 THE AUDIO TELL LAW (BINDING, NON-NEGOTIABLE)

> **No creature may apply damage to the player or the vessel without a preceding, spatialised, audible telegraph originating from the attacker's position.**

The full contract:

1. **Minimum telegraph duration** is `T_windup` from 06.1.4, floor 0.35 s (tier 1) to 1.6 s (tier 5).
2. **Rear-arc penalty.** If, at the moment `AT_WINDUP` begins, the attacker's bearing lies outside the player's 100 deg front cone (i.e. `|azimuth| > 50 deg`), `T_windup` is extended by **+0.30 s (tier 1-2) / +0.60 s (tier 3-5)**. There is no exception for frenzy, grudge, pack tokens, or difficulty.
3. **Loudness floor.** Every telegraph is mixed at **>= -18 dBFS at the listener** regardless of distance-attenuation, routed on a pre-fader `TELL` bus that is not affected by the music, ambience or master creature-volume sliders. A player with music at 100% and SFX at 20% still hears every tell at full strength.
4. **Spatial correctness.** The telegraph is panned from the attacker's true world position with correct HRTF-ish azimuth and the standard distance lowpass, so the player can turn toward it. It is **never** played 2D.
5. **Visual redundancy.** Every telegraph is accompanied by at least one non-audio cue: a pose change (jaw, coil, cocked tail, spread arms), a light change (Saltwraith jaw pores, Umbral Squid strobe, Pale Herald flood), or a particle event (Frondmaw kelp shiver, Scaldback substrate puff). The game is fully playable deaf.
6. **HUD redundancy.** The windshield `threatArc` (Section 09) displays a directional wedge at the attacker's bearing for the duration of any tier >= 3 telegraph, with an angular uncertainty of 20 deg at range > 60 m narrowing to 4 deg inside 20 m.
7. **No spawn-and-strike.** An agent may not enter `AT_WINDUP` within **3.0 s** of being spawned or promoted from L2/L3. Enforced by a per-agent `spawnGraceT`.
8. **No off-screen first contact for tier 4-5.** A leviathan's *first* attack in an encounter must begin while the attacker is within the player's 140 deg front cone or has been continuously audible for >= 8 s. Subsequent attacks in the same encounter have no such restriction (by then the player knows).
9. **Grace on damage.** After the player takes any hit, all other agents' `T_windup` is multiplied by 1.35 for 2.5 s. Prevents telegraph stacking into an unreadable mess.
10. **Auditability.** A debug overlay (`~dread`) logs every damage event with `{ attacker, tellStartTime, damageTime, delta, azimuthAtTellStart, tellPeakDbfs }`. Any entry with `delta < T_windup_required` or `tellPeakDbfs < -18` is a **release-blocking bug**.

### 06.5.7 "Things that move when you are not looking" — the fair implementation

This is the most abusable trick in horror design, so it is tightly constrained. Exactly **three** species are permitted **Unwatched Repositioning** (`URP`): `CRT_VAULTSTALKER`, `LEV_PALEHERALD`, `CRT_LANTERNGAPE` (the last only to re-anchor its lure, never its body).

`URP` is allowed only when **all** of the following hold, evaluated every tick:

| # | Condition | Value |
|---|---|---|
| 1 | The agent is outside the camera frustum, **or** its screen-space angle from the view centre exceeds | 45 deg |
| 2 | The agent's distance from the player exceeds | `0.60 * R_eff_player` (the player's own effective visual range) |
| 3 | The agent has not been within the frustum in the last | 2.5 s |
| 4 | The move is executed at no more than the agent's **normal cruise speed** — never a teleport, never a burst | `<= base speed` |
| 5 | The path of the move does not pass within | 14 m of the player |
| 6 | The destination is not closer to the player than the origin by more than | 25% of the origin distance |
| 7 | The destination is never inside | 30 m of the player |
| 8 | The agent emits its normal locomotion audio throughout the move at full `TELL`-bus strength | mandatory |
| 9 | The move is fully simulated in world space and is visible if the player turns to look mid-move | mandatory |
| 10 | Cooldown between `URP` moves for a given agent | 25 s |

In other words: **it is not teleporting, it is walking, and you can hear it walk, and if you turn around you will see it walking.** The dread comes from the fact that it moved *deliberately* while you were not looking, not from the fact that it cheated. If a player pans the camera back and the creature is somewhere impossible, that is a bug.

The `~dread` overlay logs every `URP` with origin, destination, duration and whether the player had line of sight at any point.

### 06.5.8 Prohibited techniques (explicit blacklist)

The following are **forbidden** and any implementation of them is a bug:

- Spawning any agent within 250 m of the player at tier >= 3, or within 60 m at any tier.
- Despawning a creature the player is looking at, or has looked at within 6 s.
- Any damage without a telegraph (06.5.6).
- Any audio stinger, musical or otherwise, that plays *before* a creature is detectable by the player's own senses.
- Fake sonar contacts, phantom silhouettes, or any entity that does not exist in the simulation.
- Camera control removal, forced look-at, or any cutscene during an encounter.
- Difficulty-scaling that shortens telegraphs.
- Instant-kill from any source except the Saltwraith drag-under and the Nethercoil bite, both of which have >= 1.0 s and >= 1.6 s telegraphs respectively and are confined to `d > 1,500 m`.
- Gore. Creature death is a limp, a sink, a settling, and eventually Sepulcher Louse.

---

## 06.6 THE SPAWN MANAGER

### 06.6.1 Architecture

The world is partitioned into **spawn cells** of `256 x 256 x 128 m` (X, Z, Y). A cell's key is `(floor(x/256), floor(y/128), floor(z/256))` packed into a u64. Cells are instantiated lazily within a 1,024 m horizontal / 512 m vertical radius of the player and retired outside 1,536 m / 768 m.

Per cell the director stores a `CellPop` record: `{ key, biomeMask, bandId, seed, speciesCounts[32], lastVisitTime, corpseList[], depletion }`. `CellPop` records are persisted to IndexedDB and restored on load, so a reef the player fished out stays fished out.

Spawn resolution per cell, on first instantiation:

```js
for (species of speciesLegalIn(cell.biomeMask, cell.bandId)) {
  volumeKm3   = 256*256*128 / 1e9;                       // = 0.00839 km^3
  base        = species.densityPerKm3 * volumeKm3;
  n           = base
              * dielMultiplier(species, clock)           // Activity column
              * biomeFit(species, cell.biomeMask)        // 0..1, how much of the cell is right
              * (1 - cell.depletion[species.id])         // player predation memory
              * dreadDirectorScale(species.tier)         // 06.6.5
              * qualityTierScale;                        // 06.1.10
  n           = poisson(n, hash(cell.seed, species.id)); // deterministic Poisson draw
  n           = min(n, species.cellCap);
  placeN(species, n, cell);                              // Poisson-disc + habitat mask, see 06.6.3
}
```

All randomness is derived from `hash(worldSeed, cellKey, speciesId, index)`. A cell repopulates identically after a save/load if no state changed. This is required.

### 06.6.2 THE SAFE CHARTER (BINDING)

> The starting zone contains nothing that can reduce player health. This is a hard invariant enforced at three independent levels.

**Volume definition.** The Safe Charter is a vertical cylinder:
- Centre: the start island's spawn beacon `(x0, z0)`.
- Radius: **900 m**.
- Vertical extent: from `y = +250 m` to `y = -60 m`.
- Plus a **transition annulus** from 900 m to 1,400 m radius and down to `y = -110 m`, where tier <= 1 is permitted.

**Enforcement level 1 — spawn filter.** `speciesLegalIn()` returns nothing above tier 0 for any cell whose AABB intersects the Charter volume. Tier 1 is permitted in the annulus only. There is no override flag, no debug bypass in release builds, and the check is a pure function of position that is unit-tested.

**Enforcement level 2 — movement barrier.** Any agent of tier >= 1 whose steering would carry it into the Charter volume receives an additional repulsion force:
```js
if (tier >= 1 && insideCharter(predictedPos, 40 /*m margin*/)) {
  F += normalize(pos - charterCentreAtSameY) * aMax * 2.5;
  behaviourGate[ATTACK] = 0;  behaviourGate[STALK] = 0;
}
```
The barrier is soft (a force, not a wall) so it never looks like an invisible wall, and it is applied at a 40 m margin so an agent visibly turns away before the boundary. Tier >= 3 additionally has its `DEPTH` weight overridden to drive it below `y = -140 m` when within 1,200 m of the Charter centre.

**Enforcement level 3 — damage veto.** Any damage event whose *victim* is the player and whose *position* is inside the Charter volume is dropped, and logged as a release-blocking assertion. This is a belt-and-braces check that should never fire.

**What the Charter contains.** Tideclaw, Vaneskimmer, Dunecrest, Saltmoth, Glimmerkrill, Veilmote, Coppersprat, Sunplate, Reefcropper, Ninearm, Sandveil, Ribbonwether (edge), Silverquill, and — in the annulus only — Bellflower and Spinecrown. Total: 15 species, of which 13 are tier 0.

**What the player can still hear.** The Charter constrains *spawning and movement*, not sound. A Veilmouth moan at 1,200 m is audible from the beach. This is deliberate: the safe zone must feel like the edge of something enormous.

### 06.6.3 Placement

Within a cell, candidate positions are drawn from a **habitat mask** and then filtered by Poisson-disc.

| Habitat mode | Sampling | Min separation |
|---|---|---|
| `PELAGIC` | uniform in the cell's water volume, weighted by `x_depthFit` | `2.5 * length` |
| `BENTHIC` | on the terrain surface (`terrainSDF ~ 0`), slope < 38 deg | `4.0 * length` |
| `CREVICE` | within 1.5 m of a surface with local concavity > 0.4 (from the SDF Laplacian) | `6.0 * length` |
| `CANOPY` | attached to kelp stipes / sponge structures (Section 03 exposes attachment points) | `3.0 * length` |
| `WALL` | within 4 m of a surface with slope > 65 deg | `8.0 * length` |
| `VENT` | within 12 m of a vent emitter | `2.0 * length` |
| `BRINE_EDGE` | within 6 m of the brine halocline surface | `22 m` (Saltwraith spacing) |
| `LAND` | terrain surface above `y = 0`, slope < 42 deg | `3.0 * length` |
| `AIR` | `[+6, +140] m` AGL | `5.0 * length` |
| `TERRITORY` | one point per `territoryR`-radius Poisson disc across the whole biome (leviathans, Vaultstalker) | `territoryR * 2` |

Schools are placed as a single seed point plus `n` members on a spherical Poisson distribution of radius `0.42 * n^(1/3) * spacing`.

### 06.6.4 Budgets, caps, respawn and despawn

**Per-band instantiated budgets** (concurrent, within the active cell radius, at quality tier HIGH):

| Band | GPU boid particles | L0 agents | L1 agents | L2 groups | Max tier >= 3 | Max tier >= 4 |
|---|---|---|---|---|---|---|
| B0 land | 1,200 | 40 | 90 | 12 | 0 | 0 |
| B1 | 18,000 | 120 | 380 | 60 | 0 | 0 |
| B2 | 14,000 | 100 | 320 | 55 | 2 | 0 |
| B3 | 12,000 | 90 | 280 | 50 | 4 | 0 |
| B4 | 9,000 | 70 | 220 | 40 | 5 | 1 |
| B5 | 6,000 | 55 | 170 | 32 | 5 | 1 |
| B6 | 4,000 | 45 | 140 | 26 | 4 | 1 |
| B7 | 2,400 | 32 | 90 | 18 | 3 | 1 |
| BX cave | 3,000 | 30 | 80 | 14 | 2 | 1 |

If a budget is exceeded, the director refuses new spawns (it does not despawn existing ones) and logs pressure. Persistent pressure > 4 s reduces the cell's `dreadDirectorScale` for subsequent cells.

**Population caps per species** are `min(cellCap, globalCap)`:

| Class | `cellCap` | `globalCap` (within active radius) |
|---|---|---|
| Plankton swarm | 2 swarms | 6 swarms |
| Small shoal | 3 shoals | 9 shoals |
| Solitary small (< 1 m) | 12 | 90 |
| Solitary mid (1-5 m) | 4 | 26 |
| Large (5-20 m) | 1 | 6 |
| Leviathan | 1 per territory | 2 (1 on MEDIUM/LOW) |

**Respawn timers.** A species killed in a cell increments `cell.depletion[speciesId]` by `1/expectedPop` and decays it back to 0 at the rate below. Depletion is capped at 0.85 — the ocean never becomes completely empty.

| Tier | Respawn half-life | Notes |
|---|---|---|
| 0 | 6 game-minutes | shoals refill fast |
| 1 | 18 game-minutes | |
| 2 | 45 game-minutes | |
| 3 | 2 game-hours | |
| 4 | 12 game-hours | and only when the player is > 800 m away |
| 5 | **never within a session**; a driven-off leviathan returns after 1 in-game day at 100% health | leviathans are not a resource |

**Despawn rules.** An agent is despawned when **all** of:
1. Distance from the player > 600 m (tier 0-2) / 900 m (tier 3) / 1,400 m (tier 4-5), **and**
2. It has not been within the camera frustum for >= 6.0 s, **and**
3. It is not currently in `ATTACK`, `FLEE`, `FEED` or any leviathan encounter state, **and**
4. Its containing cell is being retired, or the band budget is over by > 15%.

Corpses are exempt from rule 4 and persist for **900 s** of game time (or until fully consumed), then leave a `boneMark` decal on the terrain that persists permanently in the cell record. Leviathan carcasses (the two placed ones) never despawn.

### 06.6.5 The dread director (L5)

A single global object, ticked at 1 Hz, that shapes the *pacing* of threat rather than its content.

| Signal | Window | Effect |
|---|---|---|
| `timeSinceLastThreatEncounter` | rolling | `dreadDirectorScale(tier>=3) = clamp(0.35 + t/240, 0.35, 1.4)` — the ocean gets quieter after an encounter and slowly reloads |
| `playerHealthFrac` | instant | below 0.35, tier >= 3 spawn scale x0.5 and pack frenzy tokens are withheld |
| `vesselHullFrac` | instant | below 0.30, tier >= 4 aggro triggers require an additional 12 s of continuous qualification |
| `silhouetteRatio` | last 12 | 06.5.3 |
| `oxygenFrac` (player outside vessel) | instant | below 0.25, **no new tier >= 2 agents may enter `INVESTIGATE` toward the player.** The game will not kill a player who is already drowning. |
| `sessionDepthRecord` | session | first descent into each band grants a 90 s "arrival grace" during which tier >= 3 threat accumulators are halved |
| `deathsInLast10Min` | rolling | >= 2 deaths: tier >= 3 spawn scale x0.6 for 10 minutes, silently. Never announced. |

The director may only ever make the world *less* dangerous than the static tables. It has no authority to increase spawn rates, shorten telegraphs, or raise damage. Its ceiling is 1.4x on spawn *count* only.

---

## 06.7 CREATURE-VS-CREATURE AND CREATURE-VS-VESSEL

### 06.7.1 The trophic graph

Predation is a data table, not code. `PREYS_ON[predatorId] -> [{ preyId, preference, maxPreySizeRatio }]`. An agent will only hunt prey satisfying `preyLength <= maxPreySizeRatio * ownLength` and will prefer higher `preference` at equal distance.

| Predator | Prey (preference) | Max size ratio |
|---|---|---|
| `CRT_VANESKIMMER` | Coppersprat 1.0, Silverquill 0.8, Saltmoth 0.6 | 0.7 |
| `CRT_NINEARM` | Glassclaw-juv 1.0, Reefcropper 0.7, Tideclaw 0.6 | 0.5 |
| `CRT_SANDVEIL` | benthic worms 1.0, Glassclaw-juv 0.5 | 0.25 |
| `CRT_BLOATSPINE` | Reefcropper 1.0, Spinecrown 0.9 | 0.6 |
| `CRT_FRONDMAW` | Coppersprat 0.9, Silverquill 1.0, Sunplate 0.8, Bloatspine 0.4 | 1.3 |
| `CRT_VOLTBARB` | Hagline 1.0, Glassclaw 0.9, Silverquill 0.5 | 0.7 |
| `CRT_CHISELFIN` | Silverquill 1.0, Wisplight 0.8, Ribbonwether-calf 0.9, **anything wounded 1.6** | 2.2 (pack) |
| `CRT_GLOOMRAY` | Sepulcher 1.0, Hagline 0.8, Scaldback 0.5 | 0.35 |
| `CRT_LANTERNGAPE` | Wisplight 1.0, Umbral-juv 0.7, **anything that touches the lure 2.0** | 1.4 |
| `CRT_UMBRALSQUID` | Wisplight 1.0, Chiselfin 0.9, Lanterngape 0.8, Umbral Squid 0.3 | 1.1 |
| `CRT_SCALDBACK` | Emberworm 1.0, Sepulcher 0.8 | 0.7 |
| `CRT_SALTWRAITH` | Sepulcher 0.8, Ghostbell 0.6, **anything crossing the halocline 2.0** | 1.6 |
| `CRT_VAULTSTALKER` | Palewander 0.7, Umbral Squid 1.0, Sepulcher 0.6 | 1.0 |
| `LEV_HOLLOWJAW` | Veilmouth 1.0, Umbral Squid 0.9, Chiselfin-pack 0.7, Gloomray 0.8 | 0.65 |
| `LEV_PALEHERALD` | Hollowjaw 1.0, Gloomray 0.8, Umbral Squid 0.6, Veilmouth 0.9 | 0.70 |
| `LEV_NETHERCOIL` | Pale Herald 1.0, Saltwraith 0.7 | 0.55 |
| `CRT_HAGLINE`, `CRT_SEPULCHER`, `CRT_GLASSCLAW` | **carrion only** — no live prey | n/a |

**Fear inheritance.** `FEARS[preyId]` is derived automatically as the transpose of `PREYS_ON`, plus every species fears anything of tier >= its own tier + 2 within 3x its length. No hand-authored fear tables.

### 06.7.2 Creature-vs-creature resolution

A predation attempt is a full ATTACK FSM cycle against a creature target, with the same telegraphs (they are for the player's benefit as an observer — watching a Chiselfin pack telegraph on a Silverquill shoal is how the player *learns* the telegraph before it is aimed at them).

```js
// hit resolution, creature vs creature
P_hit  = clamp(0.55
       + 0.30 * (predSpeed / (predSpeed + preySpeed))
       + 0.20 * (preyIsSurprised ? 1 : 0)          // prey threat < T_notice at windup start
       - 0.25 * (preyIsSchooling ? 1 : 0)          // the confusion effect is real
       , 0.05, 0.95);
if (rand() < P_hit) {
  prey.hp -= pred.damagePerHit * 2.0;              // creature-vs-creature damage is doubled
  if (prey.hp <= 0) { pred.energy = min(1, pred.energy + preyMass/predMass * 4); spawnCorpse(prey); }
  else { prey.flags |= WOUNDED; scentField.inject(prey.pos, 0.010*pow(prey.mass,0.75)); }
}
```

Consequences that the player can observe and exploit:

| Event | World effect |
|---|---|
| A kill | corpse entity, scent injection `0.030 * mass^0.75`, 900 s persistence, attracts Hagline / Sepulcher / Glassclaw / Chiselfin within 400 m |
| A wound | persistent scent source; the wounded animal's `flee` weight x1.4 and speed x0.75; it becomes preference-1.6 prey for Chiselfin |
| A bait ball | Silverquill shoal enters bait-ball mode; visible from 300 m; attracts up to 3 additional predator species over 60 s — **a genuine emergent food chain the player can watch or hijack** |
| GPU shoal predation | see 06.2.4; shoal population visibly thins, and a shoal below 15% despawns |
| Leviathan kill | a leviathan feeding on a Veilmouth is a 40-90 s event that renders it completely non-hostile to the player and is the safest possible window to cross its territory. This is intended and unmarked. |

**Predator-vs-predator.** If two predators of tier difference >= 2 come within `3 * larger.length`, the smaller enters `FLEE` with `fear += 1.4`. Equal-tier predators of different species perform a **standoff**: both raise threat, both display (Umbral Squid strobes, Chiselfin call rate rises, Scaldback stridulates), neither commits for 6-12 s, and then the one with lower `hp/hpMax` disengages. Same-species standoffs at breeding density are permitted for Sunplate, Scaldback and Glassclaw only.

### 06.7.3 Creature-vs-vessel

The vessel is a valid target with its own perception profile. It is `targetId = -3`.

**How creatures see the vessel:**

| Sense | Vessel signature |
|---|---|
| Vision | length 7.4 m, `targetContrast` 0.85 with lights on, 0.30 with lights off and hull unlit, 0.12 with the hull's low-albedo coating deployed (Section 05 upgrade) |
| Lateral line | `A_src` 0.9 idle / 6.5 cruise / 11.0 full throttle (06.1.8b) |
| Electroreception | `P_electric` 4.0 powered / 9.0 with scanner or sonar active / 0.05 fully powered down |
| Scent | zero, unless the bilge purge is used (`S = 1.20`) or the player is carrying > 8 units of raw organics in the external bay (`S = 0.25`) |
| Sonar | an active ping is the loudest event in the game: `A_src = 40`, threat impulse +0.90 to every creature within 400 m, and it grants those creatures the player's exact position for 20 s |

**Damage to the hull.** Hull integrity 1200 HP. Damage is applied to one of 6 **hit zones**, each with its own subsystem consequence:

| Zone | HP share | Consequence at zone < 40% | Consequence at zone = 0 |
|---|---|---|---|
| Windshield | 180 | HUD cracks (procedural crack decal, real refraction), 12% FOV obscured | Flooding: cockpit fills in 22 s, O2 switches to suit reserve |
| Port thruster | 200 | thrust asymmetry, 8 deg/s yaw drift | Port thrust 0, max speed x0.55 |
| Starboard thruster | 200 | as above, mirrored | as above |
| Ballast/trim | 180 | vertical control lag +0.8 s | Cannot hold depth; sinks at 0.9 m/s |
| Lamp array | 120 | exterior lamp flicker at 3 Hz, range x0.6 | Exterior lights dead; interior only |
| Main hull | 320 | slow flood, 0.4 HP/s ongoing | Vessel destroyed |

**Per-species vessel interaction table:**

| Species | Can damage hull? | Damage/hit | Special |
|---|---|---|---|
| `CRT_SPINECROWN` | scrape only | 1 | scraping a bed costs paint, not HP |
| `CRT_BELLFLOWER` | no | 0 | tentacle contact adds windshield haze for 12 s |
| `CRT_CHAINLIGHT` | no | 0 | stings sensors: sonar and scanner offline 8 s per contact |
| `CRT_GLASSCLAW` | yes | 6 | only if the vessel lands on its territory |
| `CRT_FRONDMAW` | yes | 14 | single strike, never pursues past 12 m |
| `CRT_VOLTBARB` | **systems** | 0 HP | **EMP**: thrust dead 2.2 s, lamps dead 5 s, HUD scrambled 4 s |
| `CRT_CHISELFIN` | yes | 9 per bite, pack | targets the thruster zones preferentially (weight 2.0) |
| `CRT_VEILMOUTH` | collision only | 55 | it does not know you are there |
| `CRT_GLOOMRAY` | yes | 18 | tail lash targets the windshield (weight 1.8) |
| `CRT_LANTERNGAPE` | yes | 11 | bites once, cannot hold a 7.4 m vessel |
| `CRT_UMBRALSQUID` | yes | 12 + **latch** | latch: +140% drag, 5 HP/s to main hull, shed by 2.0 s full reverse or > 2000 lux spotlight |
| `CRT_SCALDBACK` | yes | 20 | targets landing gear / ballast (weight 1.6) |
| `CRT_SALTWRAITH` | yes | 26 + **drag** | drag-under: 2.4 s pull toward the brine, 60 HP/s crush while submerged in it |
| `CRT_VAULTSTALKER` | yes | 38 | targets the lamp array first (weight 2.4) — it is removing your light on purpose |
| `LEV_HOLLOWJAW` | yes | 260 bite / 180 ram / 90 sweep | `HJ_GRAB` only below 45% hull |
| `LEV_PALEHERALD` | yes | 420 bite / 300 ram / 140 shockwave | shockwave also stuns all other creatures in 45 m |
| `LEV_NETHERCOIL` | yes | 900 bite / 340-per-s coil / 400 slam | a single bite from full health leaves the vessel at 300 HP. It is not a fight. |

**Light-based vessel interactions (summary):**

| Behaviour | Species |
|---|---|
| Attracted at all ranges | Saltmoth (+0.95), Silverquill (+0.45), Coppersprat (+0.35), Chiselfin (+0.30 — a trap) |
| Repelled at all ranges | Wisplight (-0.70), Emberworm (-0.90), Saltwraith (-0.65), Sepulcher (-0.40), **Nethercoil (-1.00)** |
| Attracted far, repelled near | Lanterngape (flip@40 m), Umbral Squid (flip@25 m), Gloomray (flip@35 m), Vaultstalker (flip@30 m), Pale Herald (flip@120 m) |
| Indifferent | Palewander (blind), Vaultstalker's hunting (sound-only), Veilmouth |

The strategic consequence is exact and learnable: **lights make the shallows friendly and the deep hostile.** Every species that lights attract above 200 m is harmless. Every species that lights attract below 500 m is not. Nobody ever says this out loud.

**Powered-down profile.** With engines off, lamps off, sonar off and scanner off, the vessel's detection signature is: vision `targetContrast` 0.30, lateral line 0.0, electro 0.05, scent 0. Detection ranges collapse to: Hollowjaw 90 m, Pale Herald 55 m, Nethercoil 18 m, Vaultstalker 40 m. Drifting silent through a leviathan territory is a legitimate, deliberate, and extremely tense traversal strategy, and it is the correct answer to every tier-5 encounter in the game.

---

## 06.8 IMPLEMENTATION CHECKLIST AND ACCEPTANCE TESTS

| # | Test | Pass criterion |
|---|---|---|
| 1 | Charter invariant | 10,000 randomised agent spawns inside the Charter AABB: zero of tier >= 1 (tier 1 permitted in annulus only) |
| 2 | Damage veto | Fuzz 100,000 damage events; zero applied to the player inside the Charter |
| 3 | Audio tell law | 4-hour automated play recording: every player-damage event has `damageTime - tellStartTime >= T_windup_required` and `tellPeakDbfs >= -18` |
| 4 | Rear-arc penalty | Scripted rear attacks at every tier: measured windup >= base + 0.30/0.60 |
| 5 | URP fairness | 500 forced `URP` events: zero violate any of the 10 conditions in 06.5.7 |
| 6 | Determinism | Same seed + same cell key + same clock -> identical spawn set, byte-for-byte, after save/load |
| 7 | Boid budget | 65,536 particles, 6 passes, <= 1.45 ms GPU on the reference M-series device |
| 8 | AI CPU budget | 512 L0 + 2048 L1 agents, <= 2.0 ms/frame CPU at HIGH |
| 9 | Leviathan depth limits | 200 provoked pursuits per leviathan: zero crossings of the stated ceiling/floor |
| 10 | LOD promotion | No visible pop: promoted agents' position error < 0.5 m, animation phase decorrelated |
| 11 | Silhouette ratio | Over 12 encounters, harmless:hostile stays within [2:1, 5:1] |
| 12 | Skinning limits | No mesh exceeds 4 influences/vertex, 32 bones/skeleton (48 for the 3 leviathan-palette species) |
| 13 | Species completeness | All 37 `SpeciesDef` records present, every numeric field non-null, every mesh recipe generating within budget |
| 14 | Zero dependencies | No creature asset loaded from disk or network. All meshes, textures and sounds generated at runtime. |

