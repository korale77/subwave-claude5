# SUBWAVE -- DESIGN 00

## Vision, Design Pillars, Player Experience & Difficulty Curve

Document ID: `DESIGN/00-vision-and-pillars.md`
Status: BINDING
Revision: 1.0
Owner: Creative Direction
Applies to: every other document in `DESIGN/` and every module in `src/`

---

### 0.1 Authority of this document

This document is **normative**. Where any number, rule, name, or constraint in this
document conflicts with another `DESIGN/` document, **this document wins**, unless the
conflicting document is explicitly named here as the owner of that quantity (see
section 0.3, Ownership Map).

This document defines:

* The product vision and its non-negotiable pillars.
* The **global constants** (`GC-xx`) that all other sections must obey.
* The **depth band taxonomy** (`B0`..`B6`) that all other sections index into.
* The **threat class ladder** (`T0`..`T5`) that the bestiary must respect.
* The **Safety Charter** (`S-xx`), the **Anti-Frustration Rules** (`AF-xx`), the
  **Softlock Invariants** (`SL-xx`), and the **Accessibility Commitments** (`AX-xx`).
* The **glossary** of every game-specific term used across the whole spec.

Other sections may add detail, add rows to tables, and add derived constants. They may
not silently change a `GC-xx`, a band boundary, a threat cap, an `S-xx`, an `AF-xx`, an
`SL-xx`, or an `AX-xx`. Changing one of those requires a revision of this file and a
sweep of all downstream documents.

### 0.2 How to read this document

* All quantities carry units. Distances are metres (`m`), speeds `m/s`, accelerations
  `m/s^2`, masses `kg`, forces `N`, pressures `bar` or `atm`, times `s` unless a
  suffix says otherwise (`min` real-time minutes, `gh` game-hours).
* `d` always means **depth**, defined as `d = -y`, positive downwards. `y` is the world
  vertical axis, `+Y` up, sea level `y = 0`.
* "real seconds" = wall-clock. "game seconds" = in-fiction time (see `GC-05`).
* Audio levels are `dBFS` relative to digital full scale, measured as RMS over 400 ms
  unless stated.
* Illuminance is `lux`; radiance ratios are dimensionless fractions of surface value.
* Tables are ASCII-only by mandate. `->` means "becomes", `x` means "times",
  `deg` means degrees, `<=` and `>=` are the obvious comparisons.
* Requirement IDs are stable. Never renumber them; retire them instead
  (mark `WITHDRAWN`, keep the row).

### 0.3 Ownership map

Each quantity has exactly one owning document. If you need a number that this table
assigns elsewhere, **cite it, do not redefine it**.

```
+------------------------------------------+----------------------------+
| Quantity / decision                      | Owning document            |
+------------------------------------------+----------------------------+
| Vision, pillars, arc, dread curve        | 00 (this doc)              |
| Depth bands, threat classes, safety      | 00 (this doc)              |
| Global constants GC-xx                   | 00 (this doc)              |
| Accessibility & anti-frustration rules   | 00 (this doc)              |
| Glossary                                 | 00 (this doc)              |
| Biome list, biome extents, biome look    | 01                         |
| Heightfield/SDF/voxel algorithms, caves  | 02                         |
| Water surface, absorption coefficients,  | 03                         |
|   scattering, sky, weather, moons        |                            |
| Vessel geometry, mass, thrust, buoyancy, | 04                         |
|   crush-depth damage curve, lamps        |                            |
| Player locomotion, O2 model, suit tiers  | 05                         |
| Creature stats, AI state machines        | 06                         |
| Ore tables, tools, recipes, fabricator   | 07                         |
| Beat-by-beat progression, gates, ending  | 08                         |
| Render graph, passes, WGSL, formats      | 09                         |
| Synth graph, DSP, mixing, ducking        | 10                         |
| HUD layout, windshield projection, menus | 11                         |
| Keybinds, gamepad, dead zones            | 12                         |
| Quality tiers, budgets, LOD policy       | 13                         |
| IndexedDB schema, save/load, migrations  | 14                         |
| Full content manifest / asset registry   | 15                         |
+------------------------------------------+----------------------------+
```

---

## 1. The pitch

### 1.1 One sentence

**SUBWAVE is a lonely, physically honest exploration game about a single surveyor on an
ocean world, flying a hybrid aircraft-submarine off a safe island reef and down through
seven bands of progressively darker, stranger, more frightening water until the light
runs out entirely -- rendered entirely in hand-written WebGPU with no third-party code
and no authored art.**

### 1.2 One paragraph

You wake on **Shoalcrown**, a warm, shin-deep reef island with a shelter you built
yourself. The water around it is turquoise, 42 m deep at most, full of harmless
grazers, and **guaranteed never to hurt you**. Fifty metres from the shelter door, in a
lagoon slip, sits the **Gannet**: a one-seat hybrid vessel that flies through air on
ducted lift and dives through water on the same thrusters, transitioning through the
surface without a loading screen, a cut, or a mode prompt. You climb in. The canopy
seals. Instruments draw themselves directly onto the inside of the windshield glass --
compass ribbon, depth ladder, hull integrity, oxygen reserve, trim, sonar. You take off,
bank south over the reef, and put the nose down into the water. The turquoise turns
green, then teal, then a deep flat blue. At 25 m all reds are gone. At 80 m the
photosynthetic life stops. At 180 m the last of the kelp analogue thins into open blue
water with nothing in it. At 400 m you are flying beside a wall you cannot see the top or
bottom of. At 780 m sunlight is mathematically indistinguishable from zero and the only
photons in the world are the ones you brought and the ones that living things make. Below
that there is a trench, and below the trench there is something with a mouth. There are no
other people here. There never were. Everything you will ever learn, you will learn from
rock, from animals, and from light.

### 1.3 One page: what the player actually does

1. **Live on the surface.** Walk on the island, gather surface-tier resources, refill
   the vessel's oxygen recycler, cook, sleep to skip to dawn, expand a small shelter.
   This is the emotional floor: whenever the game becomes too much, this place is here
   and it is always safe.
2. **Fly.** The Gannet is a genuine aircraft above water: airspeed, angle of attack,
   ground effect, stall. Flight is the fast-travel system. There is no map teleport.
3. **Dive.** The same vessel with the same controls becomes a submersible below `y = 0`.
   Buoyancy, ballast trim, hull pressure, thermoclines. Descent is slow, deliberate, and
   the primary source of tension.
4. **Get out.** At any time, anywhere -- on land, floating at the surface, or at 600 m
   on a ledge -- the player can egress. Outside, oxygen is finite and pressure-scaled.
   Inside, oxygen is effectively unlimited. This binary is the core risk dial.
5. **Mine and craft.** Ores are embedded in terrain and must be cut out with a handheld
   corer, on foot, outside the vessel, in the dark, on a timer. Every upgrade is bought
   with time spent outside the vessel.
6. **Upgrade downward.** Each tier of hull and suit unlocks exactly one more depth band.
   Depth is the only progression axis that matters.
7. **Be alone with it.** No quest giver, no voice, no text log written by another hand.
   The only narration is: what glows, what fossilised, what eats what, and what is
   too big to see all at once.

### 1.4 Genre, mode, audience, platform

```
+------------------+------------------------------------------------------------+
| Field            | Value                                                      |
+------------------+------------------------------------------------------------+
| Genre            | First-person exploration / survival / vehicular sim         |
| Sub-genre        | Thalassophobic descent; "cosy start, dreadful end"          |
| Mode             | Single player only. No multiplayer, ever. No network.       |
| Session model    | 30-60 min sessions, save anywhere, resume anywhere          |
| Full playthrough | 15 gh median (see GC-30..GC-33)                            |
| Audience         | 16+. Adults who like Subnautica, Outer Wilds, Return of the |
|                  | Obra Dinn's "solve it yourself" respect for the player.     |
| Content rating   | No gore, no blood spray, no dismemberment, no human death.  |
|                  | Fear is spatial and sonic, never visceral.                  |
| Platform         | Google Chrome (latest stable), desktop, WebGPU only.        |
| Input            | Keyboard+mouse primary; gamepad full parity (see 12)        |
| Perf target      | 1920x1080 @ 60 fps on Apple M2 / RTX 3060-class             |
| Perf floor       | 1600x900 @ 30 fps on Intel Iris Xe-class (Tier LOW)         |
| Dependencies     | ZERO. No npm, no CDN, no model files, no textures, no audio |
|                  | files. Plain ES modules, hand-written WGSL, Web Audio synth.|
| Persistence      | IndexedDB (world/save) + localStorage (settings). No server.|
+------------------+------------------------------------------------------------+
```

### 1.5 Anti-goals (things this game deliberately is not)

```
+----+--------------------------------------+-------------------------------------+
| ID | Anti-goal                            | Why                                 |
+----+--------------------------------------+-------------------------------------+
| AG1| Not a combat game                    | The player has no weapon that kills |
|    |                                      | anything. Only deterrents.          |
| AG2| Not a base-building sim              | Shelter is 6 modules, not 200. Base |
|    |                                      | is a comfort object, not a project. |
| AG3| Not a story game with human lore     | Client mandate. No ruins, no logs,  |
|    |                                      | no radio, no glyphs, no other crew. |
| AG4| Not an open-ended sandbox            | There is a bottom. Reaching it ends |
|    |                                      | the arc. Freeform play is post-game.|
| AG5| Not a horror game with jump scares   | Dread is sustained and ambient.     |
|    |                                      | See section 5.5 forbidden list.     |
| AG6| Not a crafting-tree grinder          | <= 34 recipes total. Every recipe   |
|    |                                      | changes what depth you can survive. |
| AG7| Not a photorealism benchmark         | Physical honesty > pixel count. We  |
|    |                                      | ship correct absorption before we   |
|    |                                      | ship a fourth cascade of shadows.   |
| AG8| Not a roguelike                      | No permadeath, no run resets, no    |
|    |                                      | procedural difficulty spikes.       |
+----+--------------------------------------+-------------------------------------+
```

---

## 2. The five design pillars

Each pillar has: a statement, a **we will / we will not** pair, and a **falsifiable
test** that a build either passes or fails. If a build fails a pillar test, that is a
release blocker, not a bug.

---

### PILLAR 1 -- "One vessel, two oceans, no seam."

**Statement.** The Gannet is a single machine with a single control scheme that is a
credible aircraft in air and a credible submersible in water, and the transition through
`y = 0` is continuous in every observable: position, velocity, camera, audio, lighting,
HUD. There is never a mode prompt, a loading pause, a cut, or a discontinuity in any
physical quantity.

**We will:**

* Model one rigid body with one integrator. Air and water are the same fluid solver with
  different `rho`, `mu`, and added-mass tensors, blended across the surface transition
  band `y in [-2.0, +2.0] m` by the fraction of hull volume submerged
  (`GC-40`, `GC-41`).
* Crossfade the audio submix over the same 4.0 m band, with the transition driven by
  the **listener's** ear position, not the vessel origin.
* Keep every HUD element on the windshield in both media; only the *content* of the
  instrument changes (altimeter ribbon -> depth ladder, cross-fading over the same band).
* Allow ingress and egress at any depth, on land, and at the surface, with the same
  input and the same 1.4 s animation, using a physical airlock volume that floods/drains.

**We will not:**

* Not use separate "flight mode" and "sub mode" state machines with a switch.
* Not teleport, snap, or clamp the vessel at the water plane.
* Not fade to black, show a splash transition card, or hitch for streaming at the
  surface. The surface is the most-crossed boundary in the game; it must be free.
* Not disable egress anywhere. If a place is reachable, you can get out there.

**Test (P1-T):** Fly a scripted trajectory that crosses `y = 0` at 14 entry angles
(from 5 deg to 90 deg) and 6 speeds (4, 10, 20, 35, 55, 80 m/s), 84 runs.
Pass if for all runs: (a) no frame exceeds 22.0 ms, (b) `|dv/dt|` never exceeds
40 m/s^2 from the transition term alone, (c) camera angular velocity from the transition
never exceeds 0.8 rad/s, (d) audio submix crossfade produces no sample discontinuity
> -60 dBFS click, (e) no HUD element pops in or out (all cross-fade over >= 0.35 s).

---

### PILLAR 2 -- "The dark is earned, and it is real."

**Statement.** Darkness in SUBWAVE is not an artistic filter. It is Beer-Lambert
absorption of a real spectral distribution through real seawater, and the player can
*feel* the maths: red dies first, then orange, then green, and the world becomes a
narrowing blue cone until at `d = 780 m` the sun contributes literally nothing and the
only light in the universe is yours or alive.

**We will:**

* Use per-channel extinction coefficients grounded in Jerlov Type I/IB clear ocean
  water, applied as `exp(-k * pathLength)` over the true camera-to-fragment path
  including the sun-to-fragment path (`GC-20`..`GC-23`, coefficients owned by 03).
* Make the loss of red at 20-30 m a *perceptible narrative event*: the player's own hand,
  the vessel's orange trim, and warm bioluminescence go grey within the first 60 s of
  the first dive.
* Compute `Photic Zero` from physics, not from taste: `-780 m`, the depth at which noon
  ambient falls below `1.0e-5 lux` (`GC-24`).
* Budget bioluminescence as a *lighting resource*: below `-400 m`, living light is
  the primary source of environment illumination and must be authored as such
  (`GC-25`, table 3.6).
* Make lamps physically costed: they draw power, they attract creatures, they reveal
  the player, and they have finite cones (04 owns beam parameters).

**We will not:**

* Not use a flat "underwater fog colour" lerp.
* Not apply a global brightness lift so players "can see something" at depth. If it is
  black, it is black. Accessibility is served by the **Lantern** modifier (`AX-42`),
  which is opt-in, explicit, and clamped.
* Not let bioluminescence be decorative-only. Every emissive creature or plant with
  radiant flux `>= 8 lm` must contribute to the lighting solution, not just to bloom.
* Not fake "eye adaptation" as a way to make dark scenes readable. Exposure adaptation
  is modelled with a real time constant (`GC-26`) and it is *slow*, because slow is
  scary.

**Test (P2-T):** Sample the rendered radiance of a calibrated 18% grey 1 m card lit only
by the sun, at depths 0, 5, 10, 20, 30, 50, 80, 120, 180, 260, 400, 600, 780 m at
solar noon, quality tier HIGH. Pass if measured per-channel values match
`exp(-k_c * (d / cos(theta_s) + d))` within +/-8% relative for all channels above
`1e-6` of surface, and if the R:B ratio at 25 m is `<= 0.02`.

---

### PILLAR 3 -- "Safety is a contract, not a difficulty setting."

**Statement.** There exists a region of the world in which the game promises, in writing,
that nothing will ever hurt the player. That promise is absolute, is never broken for
drama, is legible from inside the fiction, and is the emotional anchor that makes the
deep bearable.

**We will:**

* Hard-enforce the **Sanctuary Volume** (`S-01`..`S-09`, section 6) at spawn, AI, and
  pathfinding level -- not by careful placement, but by a runtime assertion.
* Teach the safety signal *diegetically*: **hearthmoss** (`Calidocrusta`), a warm-amber
  encrusting lichen analogue, grows only where the local threat cap is `T0`. The player
  learns this in the first ten minutes without being told, and can then read it anywhere
  in the world.
* Provide the same guarantee at every player-built shelter and inside the vessel, so the
  player can always manufacture a bubble of safety.
* Signal danger *before* it can hurt: every `T2`+ creature has a mandatory telegraph
  window (`S-20`..`S-24`) before any damage is possible.

**We will not:**

* Not "surprise" the player with a threat in the Sanctuary as a late-game twist, an
  invasion event, a scripted moment, or an endgame escalation. Not once. Not ever.
* Not place a `T3`+ creature in a band whose cap forbids it, even for a cinematic
  fly-by, even at extreme range, even if it "cannot reach the player".
* Not use fake-outs where a safety signal is present but the area is hostile. Hearthmoss
  never lies. If the AI system would ever spawn a hostile in hearthmoss-lit water, the
  spawn is rejected, not the moss.
* Not gate the Sanctuary behind resources, weather, time of day, or story progress.

**Test (P3-T):** Automated 72 gh soak: run 400 headless simulation-only sessions with
randomised seeds and a bot that idles inside the Sanctuary Volume. Pass if the number of
damage events applied to the player, the number of `T1`+ entities whose AABB intersects
the Sanctuary Volume, and the number of pathfinding queries that return a path entering
the Sanctuary Volume are all exactly **zero**. Any non-zero result is a P0 blocker.

---

### PILLAR 4 -- "Everything is generated, and generation is the art direction."

**Statement.** Zero authored assets is a creative constraint, not a limitation to hide.
The game's identity -- its silhouettes, its palettes, its creature motion, its sound --
comes from being *grown by code*. Procedural is the aesthetic, not the compromise.

**We will:**

* Generate all meshes at runtime or load-time from parametric surfaces, SDF fields,
  marching cubes / surface nets, lathes, L-systems, and procedural skinning.
* Generate all textures on the GPU from noise basis functions into
  `rgba8unorm` / `bc`-free formats, at load time, into a texture atlas
  (formats owned by 09).
* Synthesise all audio with Web Audio API graphs: physical-modelling for creature
  vocalisation, granular for ambience, subtractive for machinery
  (synthesis owned by 10).
* Derive creature *behaviour* from the same procedural parameters that derive their
  *body*, so a long thin body swims like a long thin body without hand-tuning.
* Ship a deterministic, seeded generator: the same seed produces a bit-identical world
  on the same build (`GC-50`).

**We will not:**

* Not ship a single `.png`, `.jpg`, `.glb`, `.obj`, `.fbx`, `.wav`, `.mp3`, `.ogg`,
  `.ttf`, or base64 blob thereof. Fonts are vector-generated or SDF-generated in code.
* Not import Three.js, Babylon.js, gl-matrix, tweakpane, dat.gui, howler, tone.js, or
  any other library, at build time or runtime, in any form.
* Not use a bundler, transpiler, minifier, or TypeScript. The files served are the files
  written.
* Not let "procedural" mean "same rock 4000 times". Every generator must expose at least
  6 orthogonal parameters and demonstrate 20 visually distinct outputs.

**Test (P4-T):** (a) Static scan of the shipped directory: fail if any file extension is
outside `{.html, .js, .wgsl, .md, .json}` and fail if any `import` statement resolves
outside the project root. (b) Network panel capture during a full 20-minute play session:
fail if any request leaves the origin. (c) Determinism: generate seed `0x5EED1E` twice on
the same build; fail if any chunk hash differs.

---

### PILLAR 5 -- "Alone means alone."

**Statement.** There are no other humans. There have never been other humans. Every
question the player has is answered by geology, biology, or light -- or is not answered.
Loneliness is the emotional substrate that makes the safe island warm and the trench
unbearable.

**We will:**

* Tell the entire story through: strata and unconformities, fossil beds, food webs,
  bioluminescent signalling, migration behaviour, chemosynthetic vents, and the
  architecture of the trench itself.
* Give creatures readable *intent* -- curiosity, territoriality, courtship, fear,
  hunger -- so the world feels populated without a single line of dialogue.
* Let the player *name and catalogue* what they scan. The player's survey log is the
  only text authored by a person, and that person is the player.
* Use the player's own equipment (breathing, servo whine, hull tick, lamp relay) as the
  only "human" sound in the game.

**We will not:**

* Not include: NPC humans, human corpses, human ruins, wreckage of other craft, radio
  transmissions, distress beacons, recorded logs, alien-but-clearly-civilised
  architecture, written glyphs of any kind, tools not made by the player, or any
  rectilinear artificial structure not built by the player.
* Not have a narrator, an AI companion with a personality, a mission-control voice, or a
  "PDA" that talks. The vessel's computer emits **tones and glyphs only** (11 owns the
  language of the instrument set).
* Not resolve the ending with an explanation delivered in words.
* Not add a pet, a companion creature that follows the player as a friend, or any
  entity that removes the solitude.

**Test (P5-T):** Content audit of `15-content-manifest.md` and the shipped generators.
Fail on any manifest entry tagged `humanoid`, `ruin`, `wreck`, `text-in-world`,
`speech`, or `structure:artificial:non-player`. Fail if any audio graph in `10` contains
a formant filter bank configured for human vowel space (`F1 in [270,860] Hz` AND
`F2 in [840,2790] Hz`) outside the player's own breathing model.

---

## 3. Canonical global constants (`GC-xx`) -- BINDING

### 3.1 Coordinate system and units (restated, binding)

```
+-------+--------------------------------------------------------------------+
| GC-01 | Right-handed. +X = east, +Y = up, +Z = south. Unit = 1 metre.       |
| GC-02 | Sea level is exactly y = 0.000 m. Underwater is y < 0.              |
| GC-03 | Depth d = -y, positive downwards, metres.                           |
| GC-04 | Heading 0 deg = north (-Z), increasing clockwise viewed from +Y      |
|       | looking down. East = 90 deg, south = 180 deg, west = 270 deg.       |
|       | Internally radians in [0, 2*pi); degrees only in UI strings.        |
| GC-05 | Pitch positive = nose up. Roll positive = right wing down.          |
|       | Euler order for display only: yaw(Y) -> pitch(X) -> roll(Z).        |
|       | Internal orientation is a unit quaternion, never Euler.             |
+-------+--------------------------------------------------------------------+
```

### 3.2 Time

```
+-------+--------------------------------------------------------------------+
| GC-06 | One full day/night cycle = 1200.0 real seconds (20.0 min).          |
| GC-07 | Game-time scale = 72.0x real time (86400 game s / 1200 real s).     |
| GC-08 | t_norm in [0,1): 0.00 = midnight, 0.25 = sunrise, 0.50 = solar      |
|       | noon, 0.75 = sunset. Day and night are each 600 real s.             |
| GC-09 | Civil twilight half-width = 0.030 t_norm = 36.0 real s each side.   |
| GC-10 | Solar declination is fixed (no seasons). Max solar elevation at     |
|       | the island = 78.0 deg. Min = -78.0 deg.                             |
| GC-11 | Two moons. Moon A "Vail": synodic period 47.0 real min. Moon B     |
|       | "Corm": synodic period 313.0 real min. Combined night ground        |
|       | illuminance range 0.05 lux (both new) .. 0.90 lux (both full).      |
| GC-12 | Sleeping in a bunk advances t_norm to 0.26 and costs 0 real s       |
|       | beyond a 3.0 s fade. Sleep is allowed only in a T0 volume.          |
| GC-13 | Fixed simulation timestep = 1/120 s for rigid bodies and fluids.    |
|       | Max 4 substeps per frame; surplus time is discarded (no spiral).    |
+-------+--------------------------------------------------------------------+
```

Rationale for `GC-06`: 20 minutes is long enough that a dive can occur entirely within
one lighting condition (so the player can *plan* around light), and short enough that a
45-minute session contains 2.25 full cycles and therefore always shows the player both a
sunrise and a sunset.

### 3.3 World extents

```
+-------+--------------------------------------------------------------------+
| GC-14 | Playable disc: radius R_play = 5000.0 m centred on (0, *, 0).       |
| GC-15 | Soft boundary annulus: 4600.0 m .. 5000.0 m. A current of up to     |
|       | 6.0 m/s inward is applied, ramping linearly with (r - 4600)/400.    |
| GC-16 | Hard boundary: r = 5200.0 m. Vessel control is overridden by a      |
|       | 12 s auto-return. No wall, no invisible barrier, no damage.         |
| GC-17 | Vertical extents: flight ceiling y = +900.0 m (thin-air stall);     |
|       | deepest seabed y = -1650.0 m. Total vertical span 2550 m.           |
| GC-18 | Starting island "Shoalcrown": above-water footprint approx          |
|       | 182 m (E-W) x 141 m (N-S), peak +34.2 m at (-40, +34.2, +22).      |
| GC-19 | Player spawn: position (2.50, +5.20, -3.00), heading 172 deg,       |
|       | pitch -6 deg. Shelter deck. Vessel slip centre (0.0, +0.4, +26.0),  |
|       | slip water depth 3.2 m.                                             |
+-------+--------------------------------------------------------------------+
```

### 3.4 Light, visibility, and the depth axis

```
+-------+--------------------------------------------------------------------+
| GC-20 | Surface illuminance at solar noon, clear sky = 110000 lux.          |
| GC-21 | Just-below-surface illuminance at noon = 90000 lux (Fresnel and     |
|       | surface-scatter losses folded in).                                  |
| GC-22 | Broadband diffuse attenuation K_d(d), piecewise, per metre:         |
|       |   d in [0,30)    : 0.075                                            |
|       |   d in [30,100)  : 0.045                                            |
|       |   d in [100,300) : 0.030                                            |
|       |   d >= 300       : 0.024                                            |
|       | (Spectral per-channel k_r/k_g/k_b are owned by DESIGN 03 and must   |
|       |  integrate to within 10% of this broadband curve.)                  |
| GC-23 | Red-death depth: R:B radiance ratio <= 0.02 at d = 25 m.            |
| GC-24 | PHOTIC ZERO = d = 780.0 m. Below this, the sun term is clamped to   |
|       | exactly 0.0 in the shading model. Ambient there is < 1.0e-5 lux.    |
| GC-25 | Below d = 400 m, >= 60% of scene illuminance not produced by the    |
|       | player must come from bioluminescent emitters.                      |
| GC-26 | Auto-exposure time constant: 2.60 s dark-adapting, 0.55 s           |
|       | light-adapting. EV range clamp [-6.0, +16.0].                       |
| GC-27 | Horizontal visibility V(band) = contrast-limited sighting range of  |
|       | a 2.0 m neutral (18% albedo) target. See table 3.5.                 |
+-------+--------------------------------------------------------------------+
```

Worked reference values from `GC-21` + `GC-22` (these are the numbers art and
rendering must reproduce; they are not a suggestion):

```
+---------+-------------------+---------------------------+
| Depth m | Noon ambient lux  | Fraction of surface       |
+---------+-------------------+---------------------------+
|       0 | 9.00e+4           | 1.00                      |
|       5 | 6.19e+4           | 6.88e-1                   |
|      10 | 4.25e+4           | 4.72e-1                   |
|      25 | 1.38e+4           | 1.53e-1                   |
|      30 | 9.49e+3           | 1.05e-1                   |
|      50 | 3.86e+3           | 4.29e-2                   |
|      80 | 1.00e+3           | 1.11e-2                   |
|     100 | 4.07e+2           | 4.52e-3                   |
|     180 | 3.69e+1           | 4.10e-4                   |
|     300 | 1.01e+0           | 1.12e-5                   |
|     400 | 9.16e-2           | 1.02e-6                   |
|     600 | 7.56e-4           | 8.40e-9                   |
|     780 | 1.00e-5           | 1.11e-10                  |
|    1180 | 6.8e-10           | 7.6e-15                   |
|    1650 | ~0 (clamped)      | 0                         |
+---------+-------------------+---------------------------+
```

Human reference points for calibration: overcast starlight `~1e-4 lux`; scotopic
detection threshold for an extended source `~1e-6 lux`; full moon `~0.25 lux`.
Photic Zero at 780 m is therefore honest: below it, an unaided human eye sees nothing
from the sun, forever.

### 3.5 THE DEPTH BAND TABLE (binding, indexed by every other document)

This is the spine of the entire game. Every biome, creature, ore, sound, shader tier,
and progression gate is indexed against a band ID.

```
+----+---------------+---------+---------+--------+-------+--------+-------+---------+
| ID | Name          | y_top m | y_bot m | Vis m  | Dread | Threat | Lumen | Colour  |
|    |               |         |         | (GC-27)| target| cap    | share | anchor  |
+----+---------------+---------+---------+--------+-------+--------+-------+---------+
| B0 | Sunwash       |   0.0   |  -25.0  |  55    |  0-5  |  T0*   |  0.00 | 168,222,205 |
| B1 | Reef Terrace  | -25.0   |  -80.0  |  45    |  8-15 |  T1    |  0.02 | 84,176,178  |
| B2 | Kelpfall Slope| -80.0   | -180.0  |  38    | 20-30 |  T2    |  0.08 | 46,120,142  |
| B3 | Bluewater     |-180.0   | -400.0  |  30    | 35-48 |  T3    |  0.22 | 22,71,112   |
| B4 | The Ledge     |-400.0   | -780.0  |  24    | 50-65 |  T3    |  0.48 | 10,36,72    |
| B5 | Sable Trench  |-780.0   |-1180.0  |  18    | 68-82 |  T4    |  0.78 | 4,12,30     |
| B6 | The Throat    |-1180.0  |-1650.0  |  12    | 85-100|  T5    |  0.95 | 1,3,9       |
+----+---------------+---------+---------+--------+-------+--------+-------+---------+
```

`*` B0 is `T0` **only inside the Sanctuary Volume and its Approach Margin**. Outside
`r = 1200 m`, B0 inherits the `T1` cap. See section 6.

Column definitions:

* **Vis m** -- `GC-27` sighting range with ambient light only, at solar noon, tier HIGH.
  Below Photic Zero this value becomes the *lamp-limited* ceiling:
  `V_effective = min(V_band, lampUsefulRange)`.
* **Dread target** -- the Dread Index (section 5.1) that the band must produce at its
  midpoint, at `t_norm = 0.5`, with player lights ON, no enclosure. Measured, not felt.
* **Threat cap** -- the highest threat class permitted to exist in the band. See 3.7.
* **Lumen share** -- fraction of non-player scene illuminance that must come from
  bioluminescence (`GC-25` is the floor for B4+).
* **Colour anchor** -- sRGB 8-bit triplet of the band's characteristic in-scattered
  water colour at 15 m path length, ambient-lit, for art/QA reference only. Rendering
  must produce this from physics, not from this constant.

Derived band facts every document may rely on:

```
+----+----------+-----------+------------+-----------+---------------+------------+
| ID | Span (m) | Seabed %  | Max static | Max fauna | First-visit   | Session    |
|    |          | coverage  | silhouette | length m  | target (gh)   | share      |
+----+----------+-----------+------------+-----------+---------------+------------+
| B0 |    25    |   14 %    |    38 m    |    0.4    |   0:00        |  22 %      |
| B1 |    55    |   21 %    |    64 m    |    1.6    |   0:04        |  18 %      |
| B2 |   100    |   17 %    |   120 m    |    3.5    |   0:35        |  15 %      |
| B3 |   220    |   16 %    |    80 m    |    9.0    |   1:30        |  14 %      |
| B4 |   380    |   14 %    |   195 m    |   22.0    |   3:15        |  13 %      |
| B5 |   400    |   11 %    |   520 m    |   48.0    |   6:30        |  11 %      |
| B6 |   470    |    7 %    |  1280 m    |  120.0    |  11:00        |   7 %      |
+----+----------+-----------+------------+-----------+---------------+------------+
```

"Seabed % coverage" = fraction of the playable disc's horizontal area whose seabed `y`
falls inside that band. Sums to 100%. Owned jointly with `02-terrain-generation`, which
must hit these within +/-3 percentage points across 200 random seeds.

"Session share" = target fraction of total playthrough wall-clock spent in the band.
Owned jointly with `08-progression-and-narrative`.

### 3.6 Bioluminescence budget

```
+----+------------------+-----------------+-------------------+----------------------+
| ID | Emitters per     | Median emitter  | Peak emitter      | Dominant hue          |
|    | 1000 m^3         | flux (lm)       | flux (lm)         | (peak nm)             |
+----+------------------+-----------------+-------------------+----------------------+
| B0 |   0.0            |   -             |   -               | -                     |
| B1 |   0.4            |   1.2           |   6               | 495 (cyan)            |
| B2 |   2.1            |   3.5           |  22               | 488 (cyan-blue)       |
| B3 |   7.8            |   6.0           |  90               | 478 (blue)            |
| B4 |  19.4            |  11.0           | 420               | 470 (blue) + 618 (red)|
| B5 |  33.0            |  17.5           | 1900              | 462 (deep blue)       |
| B6 |  41.0            |  24.0           | 9000              | 455 + 700 (far red)   |
+----+------------------+-----------------+-------------------+----------------------+
```

Design notes binding on `06-bestiary-and-ai` and `09-rendering-architecture`:

* **Red bioluminescence appears at B4 and below only.** It is the single most alien
  visual beat in the game, because red is the one colour the water has already killed.
  A creature emitting at 618 nm at 500 m is visible to *nothing* except itself and the
  player's camera -- a private channel. This should be discovered, not explained.
* Emitter counts above are *lighting-contributing* emitters. Purely decorative
  sub-8-lumen motes are unlimited and are handled as particles (13 owns the cap).
* Max simultaneous lighting-contributing bioluminescent emitters in the shading pass:
  128 (tier HIGH), 48 (MED), 16 (LOW). Selection by screen-space importance.

### 3.7 THE THREAT CLASS LADDER (binding)

```
+----+---------------+------------------------------------------------+---------------+
| ID | Name          | Definition                                     | Can damage    |
+----+---------------+------------------------------------------------+---------------+
| T0 | Inert         | Cannot damage the player or vessel by any      | Nothing       |
|    |               | mechanism. Flees or ignores. No contact dmg.   |               |
| T1 | Defensive     | Damages only if the PLAYER initiates contact   | Player only   |
|    |               | or attacks. Never approaches with intent.      | (<= 4 HP)     |
| T2 | Territorial   | Defends a fixed volume. Telegraphs, then       | Player, vessel|
|    |               | charges once, then disengages. Will not chase  | (<= 12 HP)    |
|    |               | beyond its territory radius.                   |               |
| T3 | Predator      | Actively hunts the PLAYER when out of vessel.  | Player, vessel|
|    |               | Will harass but not destroy the vessel.        | (<= 30 HP)    |
| T4 | Apex          | Hunts the vessel. Can force a hull breach.     | Both, heavy   |
|    |               | Territorial over a large volume.               | (<= 65 HP)    |
| T5 | Leviathan     | Region denial. Presence alone is the threat.   | Both, extreme |
|    |               | Mostly unseen. At most 3 exist in the world.   | (<= 140 HP)   |
+----+---------------+------------------------------------------------+---------------+
```

Binding constraints on `06-bestiary-and-ai`:

* A creature's class is a property of the *creature*, not the *encounter*. There is no
  "enraged" promotion across classes.
* No band may contain a creature above its cap (table 3.5), including transiently,
  including during migration, including at any time of day.
* Every `T2`+ creature must satisfy the telegraph contract `S-20`..`S-24`.
* `T5` count in the world: exactly 3, all resident in B5/B6, minimum separation
  1800 m horizontal.
* The player never has a lethal weapon. `T3`+ creatures cannot be killed by any player
  action. They can be **deterred** (see 07: pulse emitter, hull thump, lamp strobe).
  This is an intentional, permanent design decision.

### 3.8 Pressure, depth gating, and the progression ladder

Ambient pressure: `P(d) = 1.000 + d / 10.06` atm (seawater `rho = 1027 kg/m^3`,
`g = 9.81 m/s^2`). At 780 m, `P = 78.5 atm`. At 1650 m, `P = 165.0 atm`.

```
+-------+--------------------------------------------------------------------+
| GC-28 | Vessel crush depths by hull tier (metres, depth):                   |
|       |   H0 (start) 220 | H1 520 | H2 900 | H3 1350 | H4 1700             |
| GC-29 | Suit crush depths by suit tier (metres, depth, player outside):     |
|       |   S0 (start)  40 | S1 120 | S2 300 | S3 650  | S4 1700             |
+-------+--------------------------------------------------------------------+
```

Crush behaviour (curve owned by 04/05, shape binding here):

* At `0.90 * d_crush`: amber warning glyph + a 0.5 Hz hull tick, no damage.
* At `1.00 * d_crush`: red glyph + continuous groan, damage begins.
* Damage rate: `dps = 0.6 * (d - d_crush)^1.20`, so at 20 m over: 22.1 HP/s.
  Lethal margin at H0 is roughly 8 seconds of ignoring a screaming instrument.
* Damage is to hull/suit integrity, which regenerates at the Roost or in the vessel's
  repair cycle (07 owns). **Crush damage never destroys the vessel permanently**
  (`AF-20`).

Band -> required tier matrix. This is the entire progression curve in one table:

```
+----+---------+---------+---------+-----------------------------------------------+
| ID | Vessel  | Suit    | Suit    | Gating notes                                  |
|    | tier    | tier    | dwell*  |                                               |
+----+---------+---------+---------+-----------------------------------------------+
| B0 | H0      | S0      | 168 s   | Free. No gate.                                |
| B1 | H0      | S0      |  92 s   | Free. Bottom of B1 (-80) exceeds S0; player   |
|    |         |         |         | must use vessel below -40.                    |
| B2 | H0      | S1      |  74 s   | S1 is the first true gate. Craft from B1 ore. |
| B3 | H1      | S2      |  58 s   | H1 required: B3 bottom (-400) < H0 crush.     |
| B4 | H2      | S3      |  41 s   | H2 + S3. First band below suit-only tolerance |
|    |         |         |         | for its full span.                            |
| B5 | H3      | S4      |  33 s   | H3 + S4. Photic Zero is above this band.      |
| B6 | H4      | S4      |  24 s   | Terminal tier. Nothing further to unlock.     |
+----+---------+---------+---------+-----------------------------------------------+
```

`*` **Suit dwell** = seconds of oxygen at the *band midpoint* with the *band-appropriate
suit tier*, at "working" activity level (mining), with default difficulty modifiers.
This is the single most important tension number in the game and `05-player-and-survival`
must hit each of these within +/-6%.

Derivation (binding formula; `05` owns tank capacities that satisfy it):

```
// Oxygen consumption, realistic-flavoured:
//   Denser breathing gas at depth costs more per breath.
//   p = 0.65 tempers the pure-physics exponent (1.0) for playability.
const P     = 1.0 + d / 10.06;              // atm
const p     = 0.65;                         // GC-30
const act   = { rest:1.00, swim:1.55, sprint:2.40, mine:1.85 }[activity];
const rate  = BASE_RATE * pow(P, p) * act * diffO2;  // units/s
// Dwell = tankCapacity / rate
```

```
+-------+--------------------------------------------------------------------+
| GC-30 | Oxygen pressure exponent p = 0.65 (default). Exposed to players     |
|       | only indirectly, via the Oxygen Drain difficulty modifier AX-40.    |
| GC-31 | Activity multipliers: rest 1.00, swim 1.55, sprint 2.40, mine 1.85. |
| GC-32 | Inside the vessel with canopy sealed: consumption = 0. The vessel   |
|       | recycler is unlimited in normal operation. It can only fail as a    |
|       | consequence of hull breach, and even then gives >= 180 s reserve.   |
| GC-33 | Surfacing to y > -0.3 m with head above water refills at 22 units/s |
|       | (full tank in <= 9.0 s at every tier).                              |
+-------+--------------------------------------------------------------------+
```

### 3.9 Playthrough length constants

```
+-------+--------------------------------------------------------------------+
| GC-34 | Median critical-path completion: 15.0 gh (game-hours of wall clock).|
| GC-35 | Fast completion (informed player, no exploration): 4.5 h.           |
| GC-36 | Completionist (all 61 species scanned, all 14 ore types, all        |
|       | 9 landmark sites, all 34 recipes): 31 h.                            |
| GC-37 | Target first-session length: 55 min. Target median session: 42 min. |
| GC-38 | Max time the player may be REQUIRED to spend before the first dive: |
|       | 6.0 min. Hard cap enforced by the first-run flow (section 4.2).     |
| GC-39 | Max unbroken time in a "high dread" state (Dread >= 68) before the  |
|       | pacing system must offer a relief beat: 9.0 min. See 5.4.           |
+-------+--------------------------------------------------------------------+
```

### 3.10 Transition and simulation constants referenced by pillar tests

```
+-------+--------------------------------------------------------------------+
| GC-40 | Surface transition band: y in [-2.0, +2.0] m. Fluid properties are  |
|       | blended by submerged-volume fraction f = clamp((2 - y)/4, 0, 1).    |
| GC-41 | Blend applies to: density rho (1.225 -> 1027 kg/m^3), dynamic       |
|       | viscosity, added-mass tensor, drag coefficients, buoyancy, audio    |
|       | submix gain, post-process chain, HUD instrument crossfade.          |
| GC-42 | Ingress/egress animation: 1.40 s, uninterruptible, camera on a      |
|       | spline, player invulnerable for its duration.                       |
| GC-43 | Airlock flood/drain: 2.2 s. Runs concurrently with GC-42 when       |
|       | crossing a water boundary; never adds to it.                        |
| GC-44 | Default vertical FOV 75 deg; slider 60..110 deg (AX-20).            |
| GC-45 | Vessel reference length L_v = 6.40 m (nose to thruster plane).      |
|       | Used by all "scale contrast" multiples in section 5.3.5.            |
+-------+--------------------------------------------------------------------+
```

---

## 4. Player experience: the emotional arc

### 4.1 The shape

```
  emotional
  intensity
     ^
     |                                                        .-'''-.
     |                                              _.-''''''`       `.
     |                                     _..--''''                   `.
     |                        _....---''''''                             |
     |              __..---'''                                           |
     |   __..--'''''                                                     |
     |--'                                                                 \
     +--------+--------+---------+----------+-----------+-----------+------> time
      0-5min   1st hr    mid       late      endgame     descent     bottom
      WARM     CURIOUS   COMPETENT  UNEASY    AFRAID      RESOLVED    AWE
```

The curve never fully drops after it rises, **except** at the Roost. Every return to the
island resets the player to WARM for as long as they stay. That reset is the mechanism
that makes the next descent survivable, and it is why Pillar 3 is non-negotiable.

Named arc phases and their contracts:

```
+---------------+-------------+-----------+-------------------------------------------+
| Phase         | Wall clock  | Bands     | Emotional contract                        |
+---------------+-------------+-----------+-------------------------------------------+
| ONBOARDING    | 0:00-0:06   | B0        | Warmth, safety, zero threat, zero UI noise|
| FIRST FLIGHT  | 0:06-0:20   | B0-B1     | Delight. Mastery of a toy.                |
| FIRST DIVE    | 0:20-0:40   | B0-B1     | Wonder + the first loss of red.           |
| COMPETENCE    | 0:40-1:30   | B1-B2     | "I have a job and I am good at it."       |
| THE SLOPE     | 1:30-3:15   | B2-B3     | First real unease. The seabed disappears. |
| OPEN BLUE     | 3:15-6:30   | B3-B4     | Agoraphobia. Nothing to hold on to.       |
| THE LEDGE     | 6:30-11:00  | B4-B5     | Claustro + agora at once. Real dread.     |
| THE TRENCH    | 11:00-14:00 | B5-B6     | Sustained fear. Ghost contacts peak.      |
| THE THROAT    | 14:00-15:00 | B6        | Awe. Fear resolves into scale.            |
| POST-ARC      | 15:00+      | any       | Free play. All gates open. Dread damped.  |
+---------------+-------------+-----------+-------------------------------------------+
```

### 4.2 The first five minutes (beat sheet, second-accurate)

Hard requirements: no tutorial text box larger than 3 words; no modal; no cutscene the
player cannot move during after `0:12`; player has control of the camera at `0:04`.

```
+-------+------------------------------------+------------------------+--------------+
| t     | Beat                               | System introduced      | Target       |
|       |                                    |                        | emotion      |
+-------+------------------------------------+------------------------+--------------+
| 0:00  | Black. One low sine at 52 Hz,      | audio bed              | stillness    |
|       | -34 dBFS, 4 s fade in.             |                        |              |
| 0:04  | Fade from black over 3.0 s. First  | camera, look input     | orientation  |
|       | person, standing on shelter deck,  |                        |              |
|       | t_norm = 0.27 (12 min after        |                        |              |
|       | sunrise). Sun low and warm to the  |                        |              |
|       | east. Camera free immediately.     |                        |              |
| 0:08  | Ambient reveals: surf at 14 m,     | ambience, wind         | warmth       |
|       | wind through low scrub, a single   |                        |              |
|       | flyer call every ~9 s.             |                        |              |
| 0:12  | Movement unlocked. No prompt.      | locomotion             | agency       |
|       | If no input for 6 s, a soft glyph  |                        |              |
|       | for "move" fades in at 25% alpha.  |                        |              |
| 0:18  | Vitals ring fades in bottom-left   | O2, health HUD         | competence   |
|       | over 1.2 s (oxygen at 100%,        |                        |              |
|       | greyed because we are in air).     |                        |              |
| 0:26  | Compass ribbon fades in at top.    | heading                | orientation  |
| 0:34  | A single amber waypoint glyph on   | objective language     | direction    |
|       | the horizon, over the vessel slip. |                        |              |
|       | It is a shape, not a word.         |                        |              |
| 0:40  | Player walks. The path downhill is | level readability      | invitation   |
|       | lit by hearthmoss (amber lichen)   |                        |              |
|       | on the rocks: the SAFETY SIGNAL,   |                        |              |
|       | taught here without a word.        |                        |              |
| 1:10  | Player reaches shallow water. Foot | water contact, ripples | play         |
|       | steps change. Ankle-deep, sunlit,  |                        |              |
|       | small silver grazers scatter (T0). |                        |              |
| 1:40  | The Gannet is visible in the slip. | vessel silhouette      | desire       |
|       | 6.4 m, matte, folded lift ducts.   |                        |              |
| 2:05  | Interact -> ingress. 1.4 s canopy  | GC-42, cockpit         | possession   |
|       | animation. Cockpit interior lights |                        |              |
|       | wake in sequence over 2.0 s.       |                        |              |
| 2:20  | Windshield HUD draws itself onto   | WINDSHIELD HUD         | awe (small)  |
|       | the glass: horizon line, then      |                        |              |
|       | compass ribbon, then altimeter,    |                        |              |
|       | then the depth ladder (dormant,    |                        |              |
|       | greyed, hinting at the whole game).|                        |              |
| 2:38  | Throttle responds. Ducts unfold    | flight model           | power        |
|       | (1.1 s). Vessel lifts on ground    |                        |              |
|       | effect at 0.4 m.                   |                        |              |
| 2:50  | Free flight. No boundary, no       | flight                 | JOY          |
|       | instruction. The island is small   |                        |              |
|       | and the ocean is enormous.         |                        |              |
| 3:30  | First unprompted low pass over     | ocean surface, caustics| curiosity    |
|       | water. Reef visible through it.    |                        |              |
| 4:10  | Depth ladder on the windshield     | affordance             | temptation   |
|       | brightens from grey to live as the |                        |              |
|       | vessel descends below 6 m altitude |                        |              |
|       | over water. Pure affordance.       |                        |              |
| 4:40  | Player noses into the water.       | THE TRANSITION         | wonder       |
|       | Surface crossing: audio ducks      |                        |              |
|       | 9 dB and low-passes to 780 Hz over |                        |              |
|       | 0.35 s; a bubble sheet rolls off   |                        |              |
|       | the canopy; the horizon line on    |                        |              |
|       | the glass becomes a trim bubble.   |                        |              |
| 5:00  | Neutral buoyancy at -8 m over the  | dive control           | mastery      |
|       | reef. Fish. Colour. Light shafts.  |                        |              |
|       | END OF ONBOARDING.                 |                        |              |
+-------+------------------------------------+------------------------+--------------+
```

`GC-38` enforcement: if the player has not reached the "in the water in the vessel"
state by `6:00`, the amber waypoint glyph increases in alpha from 25% to 60% and gains a
0.25 Hz pulse. That is the *entire* nudge system. No text, no voice, no forced camera.

### 4.3 The first hour

```
+-------------+----------------------------------------+------------------------------+
| Window      | What happens                           | What the player learns       |
+-------------+----------------------------------------+------------------------------+
| 0:05-0:12   | Free reef exploration in vessel. B0.    | The vessel is a joy. Water   |
|             | 8-12 T0 species visible.                | is safe. Nothing hunts here. |
| 0:12-0:18   | First EGRESS underwater, at ~-6 m,      | Oxygen exists. The vessel is |
|             | prompted only by a resource glint.      | oxygen. Outside is a timer.  |
| 0:18-0:26   | First mining: surface-tier ore nodule   | Corer tool. Inventory.       |
|             | on the reef floor at -9 m. 14 s of      | The mine/breathe rhythm.     |
|             | cutting, well inside S0 dwell.          |                              |
| 0:26-0:34   | Return to Roost. First fabrication:     | Fabricator. Recipes are      |
|             | the O2 tank T1 (S0 -> S1).              | depth, not damage.           |
| 0:34-0:42   | First NIGHT falls (t_norm crosses 0.75  | Day/night matters. The moons.|
|             | at ~13:20 of play if started at 0.27).  | Bioluminescence begins.      |
|             | Reef bioluminescence at B1 wakes.       |                              |
| 0:42-0:52   | Night dive to B1 bottom (-80 m).        | Vessel lamps. Light draws    |
|             | Vessel lamps become essential.          | curiosity from T0/T1 fauna.  |
| 0:52-1:05   | The SLOPE is found: reef terrace edge   | The world has an edge and it |
|             | at r ~ 1150-1400 m where the seabed     | goes DOWN. First vertigo.    |
|             | drops from -80 to -180 in <90 m         |                              |
|             | horizontal. First real "oh."            |                              |
| 1:05-1:20   | H0 crush warning at -198 m. Amber       | The game has a ceiling and   |
|             | glyph, hull tick. Player retreats.      | it is made of pressure.      |
| 1:20-1:30   | Return, sleep, dawn. Session 1 ends     | The loop: descend, gather,   |
|             | around here for most players.           | ascend, upgrade, descend.    |
+-------------+----------------------------------------+------------------------------+
```

**First-hour acceptance criteria** (see also section 9):

* `>= 80%` of first-time testers are in the vessel and in the water by `6:00`.
* `>= 70%` have egressed underwater at least once by `20:00`.
* `>= 90%` have seen the Slope by `70:00`.
* `0%` have been damaged by a creature.
* `<= 5%` report being "lost" (no idea where to go) at any point.

### 4.4 Mid game (1:30 -- 6:30)

Bands B2-B3. The game's *systems* phase. The player is competent, the world is still
mostly beautiful, and unease arrives by subtraction rather than addition.

Beats owned here (details in 08):

1. **The kelpfall.** B2's defining structure: 60-110 m tall kelp analogue stalks rooted
   at -180 and reaching to -80. Flying the vessel through them is the game's best pure
   *movement* experience. They also block sonar, which is the first time the instruments
   lie to the player by omission.
2. **The seabed leaves.** Crossing from B2 into B3, the terrain falls away past sonar
   range. For the first time the down-looking sonar reads `---`. This single UI state
   is the mid-game's emotional payload. It should be silent and unremarked.
3. **The first T2.** A territorial grazer-defender in the kelpfall. It telegraphs for
   1.8 s (posture + a 62 Hz pulse), charges once, and leaves. It cannot kill. Its job is
   to teach the *telegraph grammar* that will later save the player's life in B5.
4. **The first thermocline.** At -210 m +/- 18 m, a 6-9 m thick shear layer where
   temperature drops 7.5 C, density changes, visibility haze spikes, and the vessel's
   trim must be re-balanced. Physical, legible, and it makes the ocean feel layered.
5. **Suit S2 and the long swim.** B3 mining requires 58 s dwell. This is the first time
   the oxygen timer is genuinely tight, and the first time the player deliberately parks
   the vessel as a *safe room* rather than a *car*.

Mid-game session shape (target 42 min):

```
 0-4 min   : Roost. Fabricate, plan, refill. Dread 0.
 4-9 min   : Flight out. Dread 0-8. Music/ambience at its most open.
 9-22 min  : Descent + work. Dread rises 8 -> 45.
22-30 min  : The "one more ledge" temptation. Dread 45 -> 60.
30-36 min  : Ascent with cargo. Dread falls 60 -> 15. Decompression of tension.
36-42 min  : Roost. Fabricate. Dread 0. Natural save-and-quit point.
```

The pacing system must *offer* (never force) the ascent beat: at `>= 82%` cargo capacity
or `<= 25%` power, a soft cyan glyph appears on the windshield. That is the game's way of
saying "you can stop now" and it is an anti-frustration feature as much as a pacing one.

### 4.5 Late game (6:30 -- 11:00)

Bands B4-B5. The dread phase. Systems stop being introduced; the game now spends the
vocabulary it has built.

* **Light becomes a resource, not a setting.** In B4 the player's lamps are the only
  wide-spectrum light. Lamp power draw is now a real constraint (04 owns numbers, target:
  high beam costs 4.5% of cell per minute). Running dark to save power is a *viable and
  terrifying* strategy, and the game must reward it: several B5 creatures only display
  their full bioluminescent behaviour when no artificial light is within 60 m.
* **The Ledge.** B4's defining structure: a continuous near-vertical wall, 195 m of
  visible face at any time, running 3.1 km around the trench rim. You fly along it with
  rock on one side and *nothing* on the other. Agoraphobia and claustrophobia in the
  same frame. This is the single most important environment in the game.
* **Ghost contacts begin in earnest** (5.3.3). At B4, 0.25/min. At B5, 0.45/min.
* **Photic Zero is crossed at 780 m** and the game marks it with *nothing*. No fanfare,
  no glyph, no achievement. The player notices that the depth ladder's ambient-light
  bar has been at zero for a while. That is the whole beat.
* **First T4 encounter.** Sable Trench. Hunts the vessel. Cannot be killed. Can be
  deterred for 40-70 s with the pulse emitter. Teaches: you do not win, you leave.
* **Session length shortens naturally** to 30-36 min here. That is intended and must not
  be fought; high-dread play is more tiring. The save system must make short sessions
  frictionless (`AF-30`).

### 4.6 Endgame (11:00 -- 15:00)

Band B6, The Throat.

* A single vertical shaft, mouth diameter 1280 m at `y = -1180`, narrowing to 210 m at
  `y = -1650`. Its walls are the largest static silhouette in the game (`GC-45` x 200).
* Sunlight: exactly zero, and has been for 400 m of descent.
* Ambient bed: `-42 dBFS`. This is the quietest the game ever is, and the silence is the
  point (5.3.1).
* The three `T5` leviathans are resident here and in B5. They are *mostly not visible*.
  Across an entire playthrough, the target is:
  * 11-16 **audio-only** leviathan events (call heard, nothing seen)
  * 4-7 **sonar-only** events (a contact 180-400 m out, moving, never resolved)
  * 3-5 **partial silhouette** events (an edge of a body crossing a lamp cone or a
    bioluminescent field; never the whole animal)
  * **1-2 full-body reveals** in the entire game, both in B6, both at the arc's climax.
* The ending is a *place*, not a cutscene: the bottom of the Throat, a chemosynthetic
  basin, the densest bioluminescence in the world (41 emitters / 1000 m^3, peak flux
  9000 lm), and a biological structure whose scale re-frames everything the player has
  seen. Fear resolves into awe. Nobody speaks. Nothing is explained.
  `08-progression-and-narrative` owns the specifics; this document owns the *rule* that
  the resolution contains **zero words**.

### 4.7 Post-arc

* All gates remain open. The world persists.
* Dread modifiers damp to 0.75x globally (the world is *known* now; that is honest, and
  it prevents the free-play tail from being exhausting).
* Remaining content: 61-species scan completion, 9 landmark sites, deep-cave systems,
  a photo/survey mode (11 owns).
* No new-game-plus, no escalation, no invasion. Post-arc is a *pasture*, not a treadmill.

### 4.8 Pacing rules (binding on 06, 08, 10)

```
+--------+---------------------------------------------------------------------------+
| PC-01  | No two "first encounter" beats (new species class, new structure type,     |
|        | new hazard) may occur within 90 real seconds of each other.               |
| PC-02  | After any encounter with Dread >= 70, the next 120 s must contain no      |
|        | scheduled dread event (see 5.4 cooldown).                                 |
| PC-03  | Every band must contain at least one WONDER beat (beauty, not fear) that  |
|        | is unmissable on the critical path. Fear without beauty is just tax.      |
| PC-04  | The player must be able to reach a T0 volume from any point in the world  |
|        | in <= 6.0 min at that point's minimum required vessel tier.               |
| PC-05  | Ascent must always be faster than descent for the same distance (vessel   |
|        | positive-buoyancy assist). Escaping is never slower than committing.      |
| PC-06  | No band may introduce more than 2 new mechanics. B5 and B6 introduce 0.   |
| PC-07  | The critical path must never require the player to be outside the vessel  |
|        | for more than 60% of the band's suit dwell (table 3.8) in a single trip.  |
+--------+---------------------------------------------------------------------------+
```

---

## 5. The dread curve

Fear in SUBWAVE is **engineered, measured, and budgeted**. It is not left to vibes.

### 5.1 The Dread Index

A scalar `D in [0,100]` computed per frame, smoothed, used to drive audio mix, ambience
selection, ghost-contact scheduling, creature spawn weighting, post-process vignette
strength, and the music system's harmonic tension parameter.

```js
// Dread Index -- binding formula. Inputs are all in [0,1] except d.
// d           : depth in metres, positive down
// bandBias    : from the table below
// night       : 1 at solar midnight, 0 at solar noon, smoothstepped over twilight
// enclosure   : fraction of a 32-ray hemisphere hitting solid within 40 m
// lightSafety : 0..1, saturating measure of usable light around the player
// contactHeat : 0..1, decays 1/8 s, +0.35 per sonar contact, +0.6 per creature call
// sanctuary   : 1 inside any T0 volume, else 0

function dreadIndex(d, bandBias, night, enclosure, lightSafety, contactHeat, sanctuary) {
  if (sanctuary === 1) return 0.0;                  // S-05: hard clamp
  const depthTerm  = 38.0 * Math.log10(1.0 + d / 25.0);
  const raw = depthTerm
            + bandBias
            + 12.0 * night
            + 18.0 * enclosure
            + 22.0 * contactHeat
            - 25.0 * lightSafety;
  return Math.min(100, Math.max(0, raw));
}

// lightSafety: how protected the player feels by light they control or trust
//   L = (lampLumensWithin30m + 0.25 * bioLumensWithin30m + ambientLux) / 900
//   lightSafety = 1 - exp(-L)          // saturating, never exactly 1
```

Band bias values (binding):

```
+----+-----------+----------------+--------------+---------------+---------------+
| ID | bandBias  | depthTerm at   | D at mid,    | D at mid,     | D at mid,     |
|    |           | band midpoint  | day, lit     | night, lit    | night, dark,  |
|    |           |                |              |               | enclosed      |
+----+-----------+----------------+--------------+---------------+---------------+
| B0 |   -8.0    |      6.7       |     0        |      1.9      |      19.9     |
| B1 |   -4.0    |     18.7       |     6.2      |     18.2      |      36.2     |
| B2 |   -2.0    |     30.1       |    19.6      |     31.6      |      49.6     |
| B3 |    0.0    |     41.8       |    33.3      |     45.3      |      63.3     |
| B4 |   +4.0    |     52.9       |    48.4      |     60.4      |      78.4     |
| B5 |  +12.0    |     61.0       |    64.5      |     76.5      |      94.5     |
| B6 |  +20.0    |     66.9       |    78.4      |     90.4      |     100.0     |
+----+-----------+----------------+--------------+---------------+---------------+
```

Columns 4-6 assume `lightSafety = 0.5` ("lit", lamps on), `lightSafety = 0.5` at night,
and `lightSafety = 0.1` + `enclosure = 1.0` for the final column. `contactHeat = 0`
throughout. These are the values QA measures against table 3.5's Dread targets. Note
that B0 in daylight is exactly 0 and B6 at night in a cave is exactly 100: the scale is
calibrated end to end.

Note: `night` has no effect below Photic Zero in reality, but it *does* in the formula.
This is deliberate and honest: the player knows what time it is from the depth ladder's
clock, and knowing it is 03:00 outside makes 900 m worse. Fear is psychological.
`03-ocean-and-atmosphere` must NOT apply a night term to the *light* below `GC-24`; only
`D` carries it.

### 5.2 Dread budget per band

```
+----+------------+-----------+-----------+-----------+------------+---------------+
| ID | Ambient bed| Silence   | LF rumble | Ghost     | Creature   | Vignette /    |
|    | RMS dBFS   | windows   | band Hz / | contacts  | call rate  | desat at D    |
|    |            | per 10min | dBFS      | per min   | per min    | (max)         |
+----+------------+-----------+-----------+-----------+------------+---------------+
| B0 |   -22      |    0      |   none    |   0.00    |   2.4      |  0% /  0%     |
| B1 |   -24      |    0      |   none    |   0.00    |   1.9      |  0% /  0%     |
| B2 |   -27      |    1      | 34-52 /-36|   0.00    |   1.4      |  4% /  3%     |
| B3 |   -31      |    2      | 28-45 /-30|   0.10    |   0.9      | 10% /  8%     |
| B4 |   -34      |    3      | 22-40 /-26|   0.25    |   0.6      | 16% / 14%     |
| B5 |   -38      |    5      | 18-34 /-22|   0.45    |   0.35     | 22% / 20%     |
| B6 |   -42      |    7      | 14-28 /-18|   0.70    |   0.18     | 26% / 24%     |
+----+------------+-----------+-----------+-----------+------------+---------------+
```

Read this table as the **dread curve made of numbers**. Note what happens as you descend:
the ambient bed gets *quieter*, the creature calls get *rarer*, and the rumble gets
*lower and louder*. The world is emptying out and something large is left in it.

Vignette and desaturation maxima are the *ceiling* at `D = 100`; actual applied value is
`ceiling * (D/100)^1.4`, and both are scaled by `AX-23` (Reduced Vignette) and can be
driven to 0 by the player.

### 5.3 The seven techniques

#### 5.3.1 Silence

A **silence window** is a scheduled event where the ambient bed and all non-diegetic
layers duck by `18 dB` over `1.2 s`, hold for `T_hold`, and restore over `3.5 s`. The
player's own sounds (breathing, hull, servos) are *not* ducked -- they become the entire
soundscape, which is the point.

```
+----+-----------------+------------+-------------------+------------------------+
| ID | Windows/10 min  | T_hold (s) | Min gap (s)       | Trigger bias           |
+----+-----------------+------------+-------------------+------------------------+
| B2 |       1         |  8 - 14    |      240          | on entering open water |
| B3 |       2         | 10 - 20    |      180          | on losing seabed sonar |
| B4 |       3         | 12 - 26    |      140          | on wall proximity < 25m|
| B5 |       5         | 14 - 34    |      100          | random + on descent    |
| B6 |       7         | 18 - 45    |       70          | random                 |
+----+-----------------+------------+-------------------+------------------------+
```

Rules:
* A silence window may **never** be immediately followed (within 6 s of restore) by a
  loud event. That is a jump scare and it is forbidden (5.5).
* A silence window that is interrupted by a real creature encounter restores over
  `0.8 s` instead of `3.5 s`, but still never spikes above the band's normal bed.
* Silence windows are suppressed entirely when `AX-44` (Reduced Dread Audio) is at 0.

#### 5.3.2 Low-frequency rumble

Band-limited noise plus 2-3 detuned sine partials, shaped by a slow envelope. Represents
distant geology (the honest explanation) and is never attributed to a creature unless a
creature is actually there.

```
+----+-----------+-----------+----------+----------+---------------------------------+
| ID | Freq band | Level     | Period   | Duration | Notes                           |
|    | (Hz)      | (dBFS)    | (s)      | (s)      |                                 |
+----+-----------+-----------+----------+----------+---------------------------------+
| B2 |  34 - 52  |  -36      | 150-300  |  4 - 10  | Occasional, almost subliminal   |
| B3 |  28 - 45  |  -30      |  90-180  |  6 - 14  | First conscious notice          |
| B4 |  22 - 40  |  -26      |  60-140  |  8 - 20  | Felt in the chest on good rigs  |
| B5 |  18 - 34  |  -22      |  45-110  | 10 - 26  | Continuous-ish, with gaps       |
| B6 |  14 - 28  |  -18      |  30- 70  | 12 - 40  | Near-continuous, 12 s min gap   |
+----+-----------+-----------+----------+----------+---------------------------------+
```

Binding on `10-audio`: because most players are on laptop speakers that roll off below
`~180 Hz`, every rumble event must also render a **harmonic reinforcement** layer at
`2f` and `3f`, at `-14 dB` and `-20 dB` relative to the fundamental, so the event is
*perceptible* (via the missing-fundamental effect) without being *loud*. On a system with
subwoofer output the reinforcement is attenuated a further 8 dB.

Also binding: rumble is **directional** below B4. It arrives from a world-space bearing,
and the bearing is stable for the duration of the event. Players will turn to look. There
will be nothing there. That is correct.

#### 5.3.3 Sonar contacts with no visual ("ghost contacts")

The single most efficient dread mechanism per byte of implementation.

```
+----+-----------+------------+-----------+-----------+---------+-------------------+
| ID | Rate /min | Range (m)  | Lifetime  | Speed m/s | Max     | Min gap between   |
|    |           |            | (s)       |           | active  | contacts (s)      |
+----+-----------+------------+-----------+-----------+---------+-------------------+
| B3 |   0.10    |  90 - 160  |  4 -  9   | 1.0 - 3.0 |    1    |       90          |
| B4 |   0.25    |  70 - 150  |  5 - 12   | 1.0 - 4.0 |    1    |       60          |
| B5 |   0.45    |  55 - 140  |  6 - 16   | 1.5 - 5.5 |    2    |       40          |
| B6 |   0.70    |  40 - 120  |  6 - 22   | 1.5 - 7.0 |    2    |       28          |
+----+-----------+------------+-----------+-----------+---------+-------------------+
```

**The honesty rule (`DR-01`, binding).** A ghost contact is never a lie. Every ghost
contact is backed by an actual simulated object in the world, drawn from:

```
+----------------------------+--------+-------------------------------------------+
| Source                     | Share  | Resolves to a visual if pursued?          |
+----------------------------+--------+-------------------------------------------+
| Real creature out of visual| 34 %   | Yes, but it flees at 1.3x player speed    |
| Gas plume / seep column    | 22 %   | Yes: a rising bubble column, harmless     |
| Thermal shimmer layer      | 16 %   | Yes: a visible density shear, harmless    |
| Rockfall / slump debris    | 14 %   | Yes: settling sediment cloud              |
| Salp/siphonophore chain    |  9 %   | Yes: a 20-40 m gelatinous chain, T0       |
| Whalefall-analogue mass    |  5 %   | Yes: a chemosynthetic carcass site        |
+----------------------------+--------+-------------------------------------------+
```

The player *can* always resolve a ghost contact by investigating. Most will not.
The 34% that flee are the reason the other 66% remain frightening. This is the design:
**the game never fakes; the player's imagination does the faking, and the game is
technically innocent.**

Additional binding rules:
* A ghost contact must never spawn within 45 m of the player.
* A ghost contact must never be scheduled within 20 s of a *real* `T3`+ contact
  (otherwise players learn to dismiss the sonar, which destroys the mechanic and gets
  someone eaten).
* Ghost contacts are suppressed inside any `T0` volume.
* Ghost contact display uses the **same** sonar glyph as a real contact. There is no
  visual tell. (Accessibility: `AX-45` "Contact Confidence" adds a certainty ring for
  players who need it, off by default.)

#### 5.3.4 Visibility falloff

Fear scales with the ratio of *what could be there* to *what you can see*. Formally, the
game tracks:

```
unknownRatio = 1 - (visibleVolume / relevantVolume)
visibleVolume  = (2/3) * pi * V^3 * (fovSolidAngle / (4*pi))   // lit sphere sector
relevantVolume = (2/3) * pi * (V_ref)^3,  V_ref = 55 m (B0 baseline)
```

Because `V` falls from 55 m (B0) to 12 m (B6), the visible volume falls by a factor of
`(55/12)^3 = 96x`. The player is, at the bottom, seeing roughly **1%** of the world they
could see at the top. No shader trick required; the number does the work.

Binding on `03` and `09`:

* Visibility falls off as a *product* of absorption and scattering, with a Henyey-
  Greenstein phase `g = 0.72` for marine particulates. Backscatter from the player's own
  lamps must be modelled (the "driving in fog with high beams" effect) -- it is the
  mechanic that makes lamps a *tradeoff* rather than a free upgrade.
* Particulate density by band (particles/m^3 contributing to scattering):
  B0 0.9, B1 1.4, B2 3.1, B3 1.8, B4 1.2, B5 2.6, B6 5.4. Note B5/B6 rise again
  (resuspended sediment, marine snow) -- the deep is *murkier*, not just darker.
* **Marine snow** is mandatory from B3 down: 40-260 particles in view, drifting down at
  0.02-0.08 m/s, catching the lamp. It is the single strongest "this is a real ocean"
  cue and it doubles as a speed reference in featureless blue water.

#### 5.3.5 Scale contrast

Fear of scale requires a *reference*, and the reference is always the vessel
(`L_v = 6.40 m`, `GC-45`).

Every band from B3 down must contain, on the critical path, a static feature whose
silhouette the player can see filling the frame without seeing its extent:

```
+----+---------------------------+-------------+---------------------------------+
| ID | Required scale anchor     | Multiple of | Realisation                     |
|    |                           | L_v = 6.4 m |                                 |
+----+---------------------------+-------------+---------------------------------+
| B2 | Kelpfall stalk grove      |   12.5x     |  80 m tall stalks               |
| B3 | Pinnacle / seamount spire |   12.5x     |  80 m spire from the dark       |
| B4 | The Ledge wall face       |   30.5x     | 195 m of visible vertical face  |
| B5 | Trench wall               |   81.3x     | 520 m wall, top and bottom      |
|    |                           |             | both out of sight               |
| B6 | The Throat mouth          |  200.0x     | 1280 m diameter shaft           |
+----+---------------------------+-------------+---------------------------------+
```

Creature scale contrast (binding on 06): the *largest* animal in each band, by body
length:

```
B0 0.4 m | B1 1.6 m | B2 3.5 m | B3 9.0 m | B4 22 m | B5 48 m | B6 120 m
```

Rule `DR-02`: a creature over 20 m must **never** be fully framed on first encounter.
The first three encounters with any creature over 20 m must show at most 45% of its
body length within the frustum. The player assembles the animal in their head before
they ever see it whole. When the whole animal is finally shown (once, maybe twice, in
B6), it lands.

Rule `DR-03`: scale must be *earned by parallax*, not by fog. Every scale anchor must
be legible with the vignette off, the FOV at 110 deg, and all accessibility comfort
options at maximum. If the only reason something feels big is that we hid its edges, it
is not big.

#### 5.3.6 Light starvation

The progressive removal of the player's ability to see is a *mechanic*, not a setting.

* B0-B2: ambient sufficient. Lamps optional and mostly cosmetic in daylight.
* B3: ambient marginal below -300 m; lamps become default-on.
* B4: ambient irrelevant. Lamps mandatory. Power draw becomes a planning constraint.
* B5-B6: lamps are the world. Two consequences, both binding:
  1. **Lamps attract.** Any `T2`+ creature within `2.2 x lampUsefulRange` gains a
     `+0.35` weight toward investigating the player. Running dark is a real strategy.
  2. **Lamps blind.** Backscatter reduces effective sighting range of small,
     low-contrast objects by 35% at high beam vs. running dark with dark-adapted eyes.
     Players who learn to run dark see *more* bioluminescence, not less.
* The **Failing Lamp** beat (once per playthrough, B5, scripted, `08` owns): the vessel's
  primary lamp browns out for 3-6 s on a low-power cell. It must never occur when a
  `T3`+ creature is within 120 m. Tension without unfairness.

#### 5.3.7 Biological wrongness

The last technique and the most restrained. As depth increases, creature morphology and
behaviour must drift measurably away from surface intuition, on axes an ordinary player
can feel without knowing why:

```
+----+---------------------+---------------------+---------------------+------------+
| ID | Body-plan symmetry  | Motion smoothness   | Eye presence        | Colour     |
|    | (bilateral share)   | (jerk, m/s^3, p95)  |                     | saturation |
+----+---------------------+---------------------+---------------------+------------+
| B0 |       100 %         |        1.2          | Large, obvious      |  0.70      |
| B1 |        96 %         |        1.5          | Large               |  0.62      |
| B2 |        88 %         |        2.0          | Present, reduced    |  0.48      |
| B3 |        74 %         |        1.4          | Enlarged, tubular   |  0.33      |
| B4 |        58 %         |        0.9          | Vestigial or absent |  0.18      |
| B5 |        41 %         |        0.6          | Absent; lateral line|  0.09      |
| B6 |        22 %         |        0.4          | Absent              |  0.04      |
+----+---------------------+---------------------+---------------------+------------+
```

Note the *inversion* at B3: deep creatures move **more smoothly and more slowly**, not
more frantically. Low jerk in a large body is profoundly unsettling, and it is also
biologically correct for low-metabolism deep fauna. Frantic = shallow = safe.
Slow = deep = wrong.

Radial and pentaradial body plans, and creatures whose bilateral symmetry is *broken*
(one enlarged side), appear only from B4 down. `06-bestiary-and-ai` owns the species.

### 5.4 Dread scheduling and anti-fatigue

Sustained fear becomes tedium. The scheduler is binding.

```
+--------+-------------------------------------------------------------------------+
| DS-01  | A global DreadScheduler owns all dread events (silence windows, rumble,  |
|        | ghost contacts, scripted beats, T3+ spawn approvals).                    |
| DS-02  | Cooldown after any event with intensity >= 0.7: 120 s of no scheduled    |
|        | events of any type. Organic (creature-AI-driven) events are exempt.      |
| DS-03  | If D >= 68 continuously for 9.0 min (GC-39), the scheduler must inject   |
|        | a RELIEF beat within the next 60 s: a bioluminescent bloom, a passive    |
|        | megafauna passage, a vent field, or an open chamber. Beauty, not safety. |
| DS-04  | Dread events are suppressed for 45 s after the player egresses the       |
|        | vessel. The player is already maximally tense; do not stack.             |
| DS-05  | Dread events are suppressed for 30 s after a load / resume, so the       |
|        | player can re-orient before being frightened.                            |
| DS-06  | Per-session novelty: no dread event TYPE may fire more than 6 times in   |
|        | any 10-minute window, regardless of band rates.                          |
| DS-07  | Post-arc global dread multiplier = 0.75 (see 4.7).                       |
| DS-08  | All schedulers read AX-44 (Dread Intensity, 0-100%, default 100%) as a   |
|        | linear scale on rate AND intensity. At 0% the game is still complete and |
|        | still winnable; it is simply not frightening.                            |
+--------+-------------------------------------------------------------------------+
```

### 5.5 Forbidden techniques (binding, no exceptions)

```
+--------+-------------------------------------------------------------------------+
| FB-01  | No jump scares. Definition: any event that raises instantaneous SPL by   |
|        | > 12 dB in < 120 ms while an entity enters the frustum within 8 m.       |
|        | Automatically detectable; add it to CI.                                  |
| FB-02  | No gore, blood, viscera, dismemberment, or death animation of the player.|
| FB-03  | No creature may damage the player without a telegraph (S-20..S-24).      |
| FB-04  | No screen-obscuring damage effects that exceed 30% of screen area.       |
| FB-05  | No fourth-wall breaks, fake crashes, fake UI corruption, fake OS dialogs.|
| FB-06  | No sudden camera seizure of control for a scare. Camera control is the   |
|        | player's, always, except during GC-42 ingress/egress.                    |
| FB-07  | No infrasound below 12 Hz at any level (nausea/discomfort risk, and it   |
|        | is inaudible on target hardware anyway).                                 |
| FB-08  | No strobing that violates AX-01..AX-04.                                  |
| FB-09  | No threat inside a T0 volume (S-01). Not as a dream, hallucination,      |
|        | vision, jumpscare, or "it was just a fish" fake-out.                     |
| FB-10  | No sound cue that indicates a threat when no threat exists (see DR-01;   |
|        | ghost contacts are visual sonar contacts, not predator vocalisations).   |
+--------+-------------------------------------------------------------------------+
```

---

## 6. The Safety Contract

### 6.1 The Sanctuary Volume

```
Sanctuary Volume := { (x,y,z) : sqrt(x^2 + z^2) <= 900.0 m  AND  y >= -60.0 m }
```

Additional terrain constraint (binding on `02-terrain-generation`):

```
+-------+--------------------------------------------------------------------------+
| S-00  | Within r <= 900.0 m, the seabed elevation must satisfy y_bed >= -42.0 m   |
|       | everywhere, for every seed, with no caves, overhangs, or voids that       |
|       | reach below -60.0 m. Verified by a generator assertion, not by review.    |
+-------+--------------------------------------------------------------------------+
```

The **Approach Margin** is the annulus `900.0 m < r <= 1200.0 m`, `y >= -60.0 m`.
It exists so that the safety boundary is a *gradient*, not a cliff.

### 6.2 The guarantees (`S-xx`)

```
+-------+--------------------------------------------------------------------------+
| S-01  | No entity of class T1 or above may EXIST inside the Sanctuary Volume at   |
|       | any time, for any reason. Spawning is rejected; pathing into it is        |
|       | rejected; fleeing into it is rejected (fleers deflect tangentially).      |
| S-02  | Inside the Approach Margin, the cap is T1. No T2+ entity may exist there. |
| S-03  | The player takes ZERO damage from any source inside the Sanctuary Volume, |
|       | including fall damage, drowning, cold, pressure, and terrain.             |
|       | Oxygen still depletes when submerged, but reaching 0 there causes only a  |
|       | forced surface-swim, not a Blackout.                                      |
| S-04  | The Gannet takes ZERO hull damage inside the Sanctuary Volume.            |
| S-05  | Dread Index is hard-clamped to 0.0 inside the Sanctuary Volume, and       |
|       | scaled by clamp((r - 900)/300, 0, 1) inside the Approach Margin.          |
| S-06  | No dread audio technique (5.3.1, 5.3.2, 5.3.3) may fire inside the        |
|       | Sanctuary Volume or the Approach Margin.                                  |
| S-07  | Weather may never become hazardous inside the Sanctuary Volume. Max wind  |
|       | 9.0 m/s, max significant wave height 0.85 m, no lightning ever.           |
| S-08  | The Sanctuary Volume is available from t = 0 and is never gated, closed,  |
|       | flooded, invaded, corrupted, destroyed, or made conditional.              |
| S-09  | These guarantees hold on ALL difficulty modifier settings, including the  |
|       | most punishing. Difficulty modifies the deep, never the Sanctuary.        |
+-------+--------------------------------------------------------------------------+
```

**Enforcement, not discipline.** `S-01`/`S-02` are implemented as a runtime predicate in
the entity spawn path and the navigation query path:

```js
// Binding: this check runs in the spawn path, not in content review.
function spawnAllowed(entity, pos) {
  const r = Math.hypot(pos.x, pos.z);
  if (r <= 900.0 && pos.y >= -60.0)   return entity.threatClass === 0;      // S-01
  if (r <= 1200.0 && pos.y >= -60.0)  return entity.threatClass <= 1;       // S-02
  return entity.threatClass <= BAND_THREAT_CAP[bandOf(pos.y)];             // table 3.5
}
```

In development builds a violation is a thrown assertion. In release builds it is a
silent rejection plus a telemetry-free local counter shown in the debug overlay. It must
never be possible to ship a build where the counter is non-zero after a soak run (P3-T).

### 6.3 How safety is signalled

Four redundant channels, so that no single accessibility need can hide the signal.

```
+----+-------------+------------------------------------------------------------+
| Ch | Modality    | Signal                                                     |
+----+-------------+------------------------------------------------------------+
| 1  | Diegetic    | HEARTHMOSS (Calidocrusta): warm amber (255,178,92) encrust- |
|    | visual      | ing lichen analogue. Grows ONLY where the local threat cap  |
|    |             | is T0. Coverage 4-9% of rock surfaces. Emits 0.4-1.1 lm per |
|    |             | patch at night. It is the safety signal and IT NEVER LIES.  |
| 2  | Water look  | Sanctuary water: visibility 55 m, turquoise (168,222,205),  |
|    |             | strong caustics, high particulate sparkle in sun shafts.    |
|    |             | Visually distinct from every other water body in the game.  |
| 3  | Audio       | The "Sunwash bed": surf at 0.12-0.4 Hz, wind in scrub,      |
|    |             | a snapping-shrimp-analogue crackle at 2.6-4.8 kHz, flyer    |
|    |             | calls every 8-11 s. Warm, busy, ALIVE. The deep is silent;  |
|    |             | the Sanctuary is noisy, and noise means neighbours.         |
| 4  | HUD         | The vitals ring closes into a SOLID unbroken circle inside  |
|    |             | a T0 volume, and is BROKEN (dashed, 6 segments) outside it. |
|    |             | Shape-coded, not colour-coded (AX-10). Also rendered as a   |
|    |             | 1-glyph state on the windshield HUD.                        |
+----+-------------+------------------------------------------------------------+
```

Teaching order (all inside the first 5 minutes, all wordless):

1. `0:40` -- Hearthmoss lines the path from the shelter to the slip. It is the
   brightest, warmest thing on screen. The player follows it because it is pretty.
2. `1:10` -- Hearthmoss continues *into* the shallow water. Association: moss = the
   place I have been safe.
3. `2:20` -- The windshield HUD's ring is drawn SOLID on first boot, in the slip.
4. Much later, `~1:35` -- The player crosses `r = 900` for the first time and the ring
   breaks into 6 dashes with a 0.4 s soft tone. Nothing else happens. The player will
   remember it.

Hearthmoss recurs at exactly four other places in the world (`08` owns which), each of
which is a genuine `T0` pocket in a hostile band. Finding amber light at 900 m and
knowing, without being told, that you can take your helmet off there, is the single best
payoff in the game and it is bought entirely with consistency.

### 6.4 Secondary safe volumes

```
+-------+--------------------------------------------------------------------------+
| S-10  | The interior of the Gannet with the canopy sealed is a T0 volume with      |
|       | unlimited oxygen (GC-32). Hull damage still applies to the VESSEL, but no |
|       | creature can damage the PLAYER inside it above 0 HP/s.                    |
| S-11  | Any player-built shelter with a sealed hull is a T0 volume, at any depth. |
| S-12  | The four deep hearthmoss pockets are T0 volumes with a 30 m radius        |
|       | sphere each. T2+ entities cannot enter them. They are the deep game's     |
|       | rest stops and the reason long expeditions are possible.                  |
| S-13  | Every T0 volume must be signalled by at least 3 of the 4 channels in 6.3. |
+-------+--------------------------------------------------------------------------+
```

### 6.5 The telegraph contract (outside safety)

Danger is fair. A player who is paying attention is never surprised into damage.

```
+-------+--------------------------------------------------------------------------+
| S-20  | Every T2+ creature has a TELEGRAPH state that must run to completion      |
|       | before any damage-capable state can be entered.                           |
| S-21  | Minimum telegraph durations by class:                                     |
|       |   T2: 1.60 s  |  T3: 1.40 s  |  T4: 2.20 s  |  T5: 3.50 s                |
| S-22  | Every telegraph is signalled on >= 3 channels: (a) a posture/animation    |
|       | change readable in silhouette, (b) a directional audio cue with a         |
|       | distinct spectral signature per species, (c) a bioluminescent or albedo   |
|       | change, and (d) optionally a sonar contact state change.                  |
| S-23  | Telegraphs are visible/audible at >= 1.35 x the creature's maximum        |
|       | closing distance during its attack, so the player always has time to      |
|       | react even at the worst engagement range.                                 |
| S-24  | If a creature's telegraph would be invisible due to darkness (below       |
|       | Photic Zero, lamps off), the AUDIO channel gains +6 dB and the            |
|       | bioluminescent channel is mandatory. Running dark must never remove the   |
|       | player's ability to be warned.                                            |
| S-25  | First contact with any T3+ species is ALWAYS a non-damaging pass: the     |
|       | creature approaches, telegraphs, and disengages without attacking.        |
|       | Introductions are free. Second contact is not.                            |
+-------+--------------------------------------------------------------------------+
```

---

## 7. Anti-frustration rules (`AF-xx`)

The design philosophy: **the game may take your time, your light, and your nerve.
It may never take your stuff, your progress, or your way home.**

### 7.1 Failure state: Blackout, not death

There is no death in SUBWAVE. There is **Blackout**.

```
+-------+--------------------------------------------------------------------------+
| AF-01 | When player health OR oxygen reaches 0, the player BLACKS OUT.            |
|       | Screen desaturates to 0 over 1.8 s, audio low-passes to 300 Hz and ducks  |
|       | 20 dB, then a 2.5 s black hold, then wake-up at the Rest Anchor.          |
| AF-02 | Wake location = the most recent REST ANCHOR (see glossary): the Roost     |
|       | bunk, any player shelter bunk, or the Gannet's seat, whichever was last   |
|       | occupied. If the Gannet is itself Dormant, the Roost bunk is used.        |
| AF-03 | ITEM LOSS ON BLACKOUT: ZERO. Not one unit of one resource. Ever.          |
| AF-04 | Blackout costs: (a) game time advances by 20 game-minutes (16.7 real s    |
|       | at GC-07 -- i.e. narratively meaningful, mechanically cheap);             |
|       | (b) a STRAIN debuff: max oxygen -20% for 180 real s, visible as a         |
|       | hatched segment on the vitals ring. That is the entire penalty.           |
| AF-05 | Blackout cannot occur inside a T0 volume (S-03).                          |
| AF-06 | Blackout cannot chain: the player is invulnerable for 15.0 s after wake,  |
|       | and no dread event may fire for 30 s (DS-05).                             |
| AF-07 | The blackout sequence never shows the creature that caused it. No death   |
|       | camera, no ragdoll, no "you were eaten" shot. The screen simply goes.     |
+-------+--------------------------------------------------------------------------+
```

Rationale: the entire tension model depends on the player being willing to go deeper.
A punishing failure state would make the correct strategy *not going*. Blackout costs
travel time and nothing else, so the player's fear stays *emotional* rather than
*economic* -- which is exactly the fear this game wants.

### 7.2 Item and inventory policy

```
+-------+--------------------------------------------------------------------------+
| AF-10 | Items are never lost on Blackout (AF-03), on load, on quality-tier        |
|       | change, on window resize, or on save migration.                          |
| AF-11 | Items are lost ONLY by explicit player action: dropping, consuming, or    |
|       | crafting. All three require a confirmed input.                           |
| AF-12 | Dropped items persist in the world indefinitely (no despawn timer) and    |
|       | are marked on the HUD within 120 m.                                       |
| AF-13 | Inventory overflow never destroys items. If cargo is full, pickup is      |
|       | refused with a soft glyph. Nothing vanishes.                              |
| AF-14 | Crafting is reversible for 30 s (an UNDO on the fabricator) at 100%       |
|       | material return.                                                          |
| AF-15 | There is no weight-based movement penalty and no encumbrance stun.        |
|       | Cargo capacity is a hard slot count (07 owns), so the player is never     |
|       | slowly and mysteriously worse.                                            |
+-------+--------------------------------------------------------------------------+
```

### 7.3 Vessel loss and recovery

The Gannet is the player's body. Losing it permanently would end the game.

```
+-------+--------------------------------------------------------------------------+
| AF-20 | The Gannet CANNOT BE DESTROYED. At hull integrity 0 it enters DORMANT    |
|       | state: thrusters offline, lamps offline, canopy sealed and airtight,     |
|       | O2 recycler on emergency reserve (>= 900 s), negative buoyancy 0.6 m/s.  |
| AF-21 | A Dormant Gannet sinks to the nearest seabed rest position and STAYS     |
|       | THERE FOREVER. It is never removed, despawned, or garbage-collected.     |
| AF-22 | A Dormant Gannet emits a locator ping visible on the player's HUD from   |
|       | ANY distance and ANY depth, permanently, with bearing and range. There   |
|       | is no scenario in which the player does not know where it is.            |
| AF-23 | If the player was inside when hull hit 0, they are NOT blacked out. The  |
|       | vessel goes dormant around them and the emergency reserve begins. This   |
|       | is a tense, survivable, memorable moment -- not a failure.               |
| AF-24 | REVIVAL: 1 unit of a TIER-1 ore (the most common resource class in the   |
|       | game, obtainable at -9 m in the Sanctuary) restores the Gannet to 30%    |
|       | hull. Revival can be performed from inside or outside.                   |
| AF-25 | If the player has zero Tier-1 ore AND is stranded with a Dormant Gannet, |
|       | the RECALL beacon at the Roost teleports the Gannet (not the player) to  |
|       | the Roost slip at 30% hull, once per 10 real minutes, free. This is the  |
|       | absolute floor of the anti-softlock system and it always works.          |
| AF-26 | A Dormant Gannet below the player's current suit crush depth is still    |
|       | recoverable via AF-25. The player is never required to swim to a depth   |
|       | they cannot survive.                                                     |
| AF-27 | Hull integrity regenerates passively at 0.8 HP/s inside the Sanctuary    |
|       | Volume and at any player shelter, with no resource cost.                 |
+-------+--------------------------------------------------------------------------+
```

### 7.4 Softlock prevention invariants (`SL-xx`)

A softlock is any world state from which the player cannot progress. These invariants
are checked by an automated seed audit over >= 2000 seeds before ship.

```
+-------+--------------------------------------------------------------------------+
| SL-01 | RESOURCE REACHABILITY: every resource required by any recipe on the      |
|       | critical path must exist in at least 3 spatially separated deposits at   |
|       | a depth reachable with the tier the recipe unlocks-from. Formally: a     |
|       | recipe that upgrades H(n)->H(n+1) may only require ores found above      |
|       | crushDepth(H(n)) - 20 m.                                                 |
| SL-02 | TRANSMUTER FALLBACK: the Fabricator can always convert 4 units of any    |
|       | Tier-1 ore into 1 unit of any other Tier-1 ore, and 6 units of any       |
|       | Tier-2 ore into 1 of any other Tier-2 ore. Rate is bad on purpose; it    |
|       | exists so that no seed and no play pattern can starve the player.        |
| SL-03 | RESPAWNING DEPOSITS: all Tier-1 and Tier-2 ore deposits regenerate on a  |
|       | per-chunk timer of 18-32 game-hours. Tier-3+ do not (they are finite     |
|       | and abundant: >= 4x the total quantity required by all recipes).         |
| SL-04 | NO ONE-WAY GEOMETRY: no passage may be traversable in one direction and  |
|       | not the other. Every cave has >= 2 mouths, each >= 9.0 m in minimum      |
|       | cross-section (vessel diameter 3.9 m + 130% clearance).                  |
| SL-05 | NO GEOMETRY TRAPS: the collision system must guarantee that the player   |
|       | and the vessel can never become embedded. On overlap resolution failure, |
|       | the entity is pushed along the shortest exit vector; if that fails for   |
|       | 3.0 s, the entity is moved to the nearest known-free position within     |
|       | 40 m with no penalty.                                                    |
| SL-06 | UNSTICK: the player may hold a key for 3.0 s to be moved to the nearest  |
|       | free position within 60 m (or, in the vessel, to be surfaced). This is   |
|       | always available and never disabled.                                     |
| SL-07 | NO PROGRESS-BLOCKING CONSUMABLES: no critical-path recipe may consume an |
|       | item that cannot be re-obtained.                                         |
| SL-08 | SAVE INTEGRITY: 3 rolling autosaves + 1 manual slot + 1 "session start"  |
|       | snapshot. Autosave every 240 s and on every band transition, egress,     |
|       | ingress, and fabrication. A corrupt save falls back to the previous slot |
|       | automatically with a single non-modal notice.                            |
| SL-09 | BOUNDARY SAFETY: the world boundary (GC-15/GC-16) never traps. It pushes.|
| SL-10 | TIER MONOTONICITY: acquiring a higher tier never removes access to a     |
|       | lower one. There is no "point of no return" anywhere in the game.        |
| SL-11 | THE ENDGAME IS REVERSIBLE: the player can leave the Throat at any point  |
|       | before, during, and after the final beat, and return later.              |
| SL-12 | SEED AUDIT: an automated headless pass over 2000 seeds must verify       |
|       | SL-01, SL-04, S-00, and the band coverage percentages in 3.5. Any seed   |
|       | that fails is rejected at generation time and re-rolled with seed+1.     |
+-------+--------------------------------------------------------------------------+
```

### 7.5 Never-lost navigation

```
+-------+--------------------------------------------------------------------------+
| AF-30 | The Roost's position is always shown on the compass ribbon as a distinct |
|       | shape-coded marker, from any depth, any distance, permanently.           |
| AF-31 | The Dormant Gannet locator (AF-22) uses a second distinct shape.        |
| AF-32 | The player may place up to 8 personal markers. They persist in the save. |
| AF-33 | There is NO map screen. Navigation is compass + depth + landmarks +      |
|       | markers. This is a design choice for atmosphere, so the compass MUST be  |
|       | excellent: heading to 1 deg, range to 1 m under 100 m, bearing arrows    |
|       | that work off-screen, and a "return heading" that is always correct.     |
| AF-34 | If the player has not moved more than 40 m in 4 real minutes while below |
|       | -180 m and outside the vessel, the vessel's position marker gains a      |
|       | pulse. Soft, once, never repeated within 10 min.                         |
+-------+--------------------------------------------------------------------------+
```

### 7.6 Grind ceilings

```
+-------+--------------------------------------------------------------------------+
| AF-40 | No critical-path upgrade may require more than 9.0 real minutes of       |
|       | gathering at median player efficiency.                                   |
| AF-41 | Total critical-path gathering time across the whole game: <= 3.2 h of    |
|       | the 15.0 h median (21%).                                                 |
| AF-42 | Mining a node takes 6-22 s depending on ore tier. No node takes longer   |
|       | than one third of the band's suit dwell (table 3.8).                     |
| AF-43 | No timed event, no daily, no decay, no hunger death, no thirst death.    |
|       | Food and water (if present) modulate stamina, never survival.            |
+-------+--------------------------------------------------------------------------+
```

---

## 8. Accessibility commitments (`AX-xx`)

All settings live in a single **Comfort & Access** menu, reachable from the title screen
and from pause, changeable at any time including mid-dive, applied instantly, persisted
to `localStorage`, and **never gated behind progression**. No setting in this section
disables saving, achievements-equivalents, or any content.

### 8.1 Photosensitivity

```
+-------+--------------------------------------------------------------------------+
| AX-01 | HARD LIMIT, always on, not a setting: no full-screen luminance change    |
|       | exceeding 10% of peak white may occur more than 3 times per second, over |
|       | more than 25% of the display area. (WCAG 2.3.1 aligned.)                 |
| AX-02 | HARD LIMIT: no red flash where the transition crosses into the           |
|       | "saturated red" zone (per WCAG general flash & red flash thresholds).    |
| AX-03 | REDUCED FLASHING mode (default OFF, but auto-suggested on first boot):   |
|       | clamps to 2 flashes/s and 5% luminance delta; replaces all strobing      |
|       | lamp and creature effects with steady-state equivalents at the mean      |
|       | luminance; removes lightning flicker entirely.                           |
| AX-04 | The pre-launch screen offers Reduced Flashing BEFORE any content is      |
|       | shown, in a static, non-animated, high-contrast layout.                  |
| AX-05 | Bioluminescent pulsing is capped at 2.5 Hz globally and 1.0 Hz under     |
|       | AX-03. No creature may have a strobing display above these caps.         |
| AX-06 | Lamp brownout (5.3.6 Failing Lamp) is a smooth ramp, never a flicker,    |
|       | and is replaced by a steady dimming under AX-03.                         |
+-------+--------------------------------------------------------------------------+
```

### 8.2 Colour vision

```
+-------+--------------------------------------------------------------------------+
| AX-10 | NO CRITICAL INFORMATION IS ENCODED IN HUE ALONE, anywhere, ever.         |
|       | Every state that matters is carried by at least two of: hue, SHAPE,      |
|       | POSITION, MOTION, TEXT/NUMBER. Enforced by a UI review checklist and by  |
|       | a greyscale screenshot audit of every HUD state.                         |
| AX-11 | Colour vision modes: OFF (default), PROTANOPIA, DEUTERANOPIA,            |
|       | TRITANOPIA, MONOCHROME. Implemented as an LMS-space correction applied   |
|       | to UI and, optionally (separate toggle), to the world.                   |
| AX-12 | Minimum contrast ratio for any HUD text or glyph against its worst-case  |
|       | background: 4.5:1. The windshield HUD must therefore carry a per-element |
|       | adaptive backing plate whose opacity is driven by measured local scene   |
|       | luminance (11 owns the implementation).                                  |
| AX-13 | Hazard indication uses a distinct SHAPE per severity: circle (nominal),  |
|       | triangle (caution), hexagon (critical), plus a distinct audio signature. |
| AX-14 | The T0-safety ring (6.3 ch.4) is solid vs dashed -- shape, not colour.   |
| AX-15 | Ore types are distinguished by silhouette and by scan glyph, not only by |
|       | colour. Verified by a monochrome legibility test on all 14 ore types.    |
+-------+--------------------------------------------------------------------------+
```

### 8.3 Motion comfort

The game is first-person, underwater, six-degree-of-freedom, and in a vehicle. It is a
worst-case motion-sickness scenario. These are not optional.

```
+-------+---------------------------+---------+---------+--------+------------------+
| ID    | Setting                   | Min     | Max     | Default| Notes            |
+-------+---------------------------+---------+---------+--------+------------------+
| AX-20 | Vertical FOV              |  60 deg | 110 deg | 75 deg | Also affects      |
|       |                           |         |         |        | cockpit framing   |
| AX-21 | Head bob amplitude        |   0 %   | 100 %   |  60 %  | 0 = fully static  |
| AX-22 | Camera roll (vessel)      |   0 %   | 100 %   |  85 %  | 0 = horizon lock  |
| AX-23 | Speed vignette strength   |   0 %   | 100 %   |  35 %  | Also scales the   |
|       |                           |         |         |        | dread vignette    |
| AX-24 | Screen shake              |   0 %   | 100 %   |  70 %  |                   |
| AX-25 | Motion blur               |   0 %   | 100 %   |   0 %  | OFF by default    |
| AX-26 | Depth of field            |  off    | on      |  off   | OFF by default    |
| AX-27 | Camera lag / spring       |   0 %   | 100 %   |  40 %  | 0 = 1:1 rigid     |
| AX-28 | Water surface distortion  |   0 %   | 100 %   | 100 %  | Refraction wobble |
| AX-29 | Underwater caustic motion |   0 %   | 100 %   | 100 %  |                   |
+-------+---------------------------+---------+---------+--------+------------------+
```

```
+-------+--------------------------------------------------------------------------+
| AX-30 | STATIC HORIZON option: renders a fixed, thin, always-level reference line |
|       | on the windshield and (optionally) a fixed cockpit frame that does not    |
|       | move relative to the screen. Strongly effective against simulator         |
|       | sickness; costs almost nothing to implement.                             |
| AX-31 | COMFORT VIGNETTE option (independent of AX-23): applies a 22% vignette    |
|       | ONLY while angular or linear acceleration exceeds a threshold, fading in  |
|       | over 0.25 s and out over 0.6 s.                                          |
| AX-32 | SNAP TURN option for on-foot camera: 15/30/45 deg increments, off by      |
|       | default.                                                                 |
| AX-33 | REDUCED MOTION master preset: sets AX-21=0, AX-22=0, AX-23=0, AX-24=0,    |
|       | AX-25=0, AX-27=0, AX-28=30, AX-30=on, AX-31=on. One click.              |
| AX-34 | The game respects `prefers-reduced-motion` on first boot by pre-selecting |
|       | AX-33 (the player may decline).                                          |
| AX-35 | No forced camera movement outside GC-42 (ingress/egress), and that       |
|       | animation may be reduced to a 0.4 s cross-fade under AX-33.              |
+-------+--------------------------------------------------------------------------+
```

### 8.4 Audio, subtitles, and creature cues

Because dread is delivered primarily through sound, a deaf or hard-of-hearing player
would otherwise lose the game's core signal AND its core safety warning (`S-22`). This
is therefore a correctness requirement, not a courtesy.

```
+-------+--------------------------------------------------------------------------+
| AX-40 | CREATURE AUDIO SUBTITLES (default ON for accessibility profiles, OFF     |
|       | otherwise): every creature vocalisation, every telegraph cue, every      |
|       | environmental hazard sound, and every mechanical alert produces a caption|
|       | line. Format:                                                            |
|       |   [ <- 40-80 m ]  Kelpfall grazer -- warning pulse                       |
|       | Components: (a) directional arrow (8-way + up/down), (b) distance BUCKET |
|       | (0-15, 15-40, 40-80, 80-160, 160+ m), (c) source name (species name once |
|       | scanned; otherwise a descriptive placeholder like "large, unseen"),      |
|       | (d) event descriptor.                                                    |
| AX-41 | VISUAL SOUND RADAR (default OFF): a thin arc on the HUD edge that        |
|       | brightens in the direction of any sound event above -40 dBFS, with       |
|       | thickness proportional to loudness and hue-free encoding (brightness +   |
|       | thickness only, per AX-10).                                              |
| AX-42 | Caption presentation: font size 16-40 px, background opacity 0-100%,     |
|       | max 4 concurrent lines, 3.5 s dwell, high-contrast (>= 7:1), positioned  |
|       | bottom-centre or bottom-left (player choice). Never on the windshield    |
|       | (it must remain readable when the cockpit is dark).                      |
| AX-43 | Independent volume sliders (0-100%, default): Master 80, Ambience 85,    |
|       | Creatures 90, Vessel 75, UI 70, Music/Tension bed 65, LF Rumble 100.     |
|       | The LF Rumble slider exists separately because it is the single most     |
|       | physically uncomfortable channel for some players.                       |
| AX-44 | DREAD INTENSITY 0-100% (default 100). Linearly scales silence-window     |
|       | rate, rumble level and rate, ghost-contact rate, and the vignette/desat  |
|       | response to D. At 0% the game is fully playable and fully completable.   |
| AX-45 | CONTACT CONFIDENCE (default OFF): sonar contacts gain a certainty ring   |
|       | distinguishing "confirmed biological" from "unresolved". Removes the     |
|       | ambiguity that powers 5.3.3, and that is a legitimate player choice.     |
| AX-46 | MONO DOWNMIX option, and a HEADPHONE / SPEAKER / LAPTOP output profile   |
|       | that adjusts the LF reinforcement (5.3.2) and dynamic range.             |
| AX-47 | DYNAMIC RANGE COMPRESSION option (Night Mode): compresses 42 dB of range |
|       | into 18 dB. Silence windows become 6 dB ducks instead of 18 dB.          |
+-------+--------------------------------------------------------------------------+
```

### 8.5 Input accessibility

```
+-------+--------------------------------------------------------------------------+
| AX-50 | Every action fully rebindable, including modifiers. No unbindable key.   |
| AX-51 | HOLD -> TOGGLE conversion available for every hold action (sprint,       |
|       | crouch, aim, lamp, throttle-hold, mining).                               |
| AX-52 | No quick-time events, no rapid repeated presses, no button mashing, ever.|
| AX-53 | All timed interactions (mining, ingress, unstick) have a configurable    |
|       | duration multiplier 0.5x - 2.0x under a single "Interaction Time" slider,|
|       | which does NOT affect oxygen or difficulty.                              |
| AX-54 | Full one-handed keyboard layout preset and full gamepad parity (12 owns).|
| AX-55 | Mouse sensitivity separate for X and Y, 0.05-5.00, with optional         |
|       | acceleration OFF by default; gamepad dead zones fully exposed.           |
| AX-56 | AUTO-SWIM / AUTO-THROTTLE cruise toggle so the player is never required  |
|       | to hold an input for more than 5 s continuously.                         |
+-------+--------------------------------------------------------------------------+
```

### 8.6 Legibility and cognitive load

```
+-------+--------------------------------------------------------------------------+
| AX-60 | UI scale 75% - 200%, affecting every HUD element including the           |
|       | windshield projection.                                                   |
| AX-61 | All fonts are procedurally generated but must satisfy: x-height >= 55%   |
|       | of cap height, distinct 0/O, 1/l/I, 5/S, 6/8, and no ligatures.          |
| AX-62 | Numbers on instruments are always shown as numerals, not only as         |
|       | analogue needles. Depth, heading, O2, hull, power: always numeric.       |
| AX-63 | A persistent, optional OBJECTIVE GLYPH (never text) may be pinned. It    |
|       | shows direction and distance only.                                       |
| AX-64 | No time-limited menu, no auto-advancing screen, no input during fades.   |
| AX-65 | Pause works everywhere, including mid-encounter, and fully stops the     |
|       | simulation. There is no online component to prevent this.                |
+-------+--------------------------------------------------------------------------+
```

### 8.7 Difficulty modifiers

Independent sliders, not presets. Changeable at any time. **No content, ending,
progression, or completion tracking is gated on any of them** (`AX-70`).

```
+-------+--------------------------+-------+-------+---------+-----------------------+
| ID    | Modifier                 | Min   | Max   | Default | Affects               |
+-------+--------------------------+-------+-------+---------+-----------------------+
| AX-71 | Oxygen drain             | 0.25x | 2.00x |  1.00x  | GC-30 rate multiplier |
| AX-72 | Creature aggression      | 0.00x | 1.50x |  1.00x  | Detection radius,     |
|       |                          |       |       |         | pursuit duration,     |
|       |                          |       |       |         | attack frequency      |
| AX-73 | Damage taken (player)    | 0.00x | 2.00x |  1.00x  | All player damage     |
| AX-74 | Damage taken (vessel)    | 0.00x | 2.00x |  1.00x  | All hull damage       |
| AX-75 | Resource abundance       | 0.50x | 3.00x |  1.00x  | Node density, yield   |
| AX-76 | Mining speed             | 0.50x | 3.00x |  1.00x  | Corer rate            |
| AX-77 | Crush depth tolerance    | 1.00x | 1.50x |  1.00x  | GC-28/GC-29 margins   |
| AX-78 | Day length               | 0.50x | 3.00x |  1.00x  | GC-06 (600-3600 s)    |
| AX-79 | Dread intensity          |   0 % | 100 % |   100 % | = AX-44               |
| AX-80 | Vessel speed             | 0.75x | 1.50x |  1.00x  | Flight + dive speeds  |
+-------+--------------------------+-------+-------+---------+-----------------------+
```

Named presets (each simply writes the slider set; the sliders remain editable):

```
+---------------+--------------------------------------------------------------+
| PEACEFUL      | AX-72 = 0.00x, AX-73 = 0.00x, AX-74 = 0.25x, AX-79 = 40%.    |
|               | Nothing in the world can hurt the player. All content, all    |
|               | bands, and the full ending remain available.                  |
| RELAXED       | AX-71 0.6x, AX-72 0.6x, AX-73 0.5x, AX-75 1.6x, AX-79 70%.   |
| SURVEY        | All defaults. The intended experience.                        |
| DEEP WATER    | AX-71 1.4x, AX-72 1.3x, AX-73 1.5x, AX-75 0.7x, AX-79 100%.  |
| BENTHIC       | AX-71 2.0x, AX-72 1.5x, AX-73 2.0x, AX-74 2.0x, AX-75 0.5x.  |
+---------------+--------------------------------------------------------------+
```

Note that even BENTHIC does not touch the Sanctuary (`S-09`) and does not enable
permadeath, item loss, or vessel destruction (`AF-01`, `AF-03`, `AF-20`). Those are
architectural, not difficulty.

### 8.8 Pre-ship accessibility checklist

```
[ ] Greyscale audit of all 41 HUD states passes AX-10.
[ ] Flash analyser over a 60-minute scripted play capture reports 0 violations
    of AX-01 and AX-02, on both default and Reduced Flashing.
[ ] Every S-22 telegraph is verified reachable through captions alone (AX-40),
    with audio muted, by a scripted test that measures player reaction window.
[ ] AX-33 Reduced Motion preset play-tested for 30 min by 3 motion-sensitive testers.
[ ] All 34 recipes completable with AX-53 at 2.0x and AX-51 all-toggle.
[ ] PEACEFUL preset completes the full critical path in an automated run.
[ ] Keyboard-only, mouse-only, and gamepad-only completions of the first hour.
[ ] Caption coverage audit: 100% of creature and hazard audio events have captions.
```

---

## 9. Playtest acceptance metrics

These are the numbers a build must hit. They are measured with local instrumentation
only (no network; results are read off the debug overlay or an exported local JSON).

```
+--------+-------------------------------------------------+-----------+------------+
| KPI    | Metric                                          | Target    | Blocker if |
+--------+-------------------------------------------------+-----------+------------+
| K-01   | First-time players in the water, in vessel       | >= 80 %   | < 60 %     |
|        | by 6:00                                          |           |            |
| K-02   | First-time players who egress underwater by 20:00| >= 70 %   | < 50 %     |
| K-03   | Players damaged by a creature in the first hour  |    0 %    | > 0 %      |
| K-04   | Players reporting "I didn't know where to go"    | <= 5 %    | > 15 %     |
| K-05   | Session 1 length (median)                        | 45-70 min | < 25 min   |
| K-06   | Players who describe B4+ as "scary" or stronger  | >= 75 %   | < 50 %     |
| K-07   | Players who describe the Sanctuary as "safe"     | >= 95 %   | < 85 %     |
| K-08   | Players who quit during a high-dread state       | <= 10 %   | > 30 %     |
| K-09   | Median frames over 16.7 ms at tier HIGH, M2      | <= 1.5 %  | > 5 %      |
| K-10   | Softlock reports per 100 hours of play           |    0      | > 0        |
| K-11   | Item-loss reports per 100 hours                  |    0      | > 0        |
| K-12   | Players who found the vessel after Dormant       |   100 %   | < 100 %    |
| K-13   | Median time from "want to quit" to "quit safely" | <= 25 s   | > 60 s     |
| K-14   | Motion discomfort reports at default settings    | <= 12 %   | > 25 %     |
| K-15   | Motion discomfort reports with AX-33 enabled     | <= 3 %    | > 8 %      |
| K-16   | Players who correctly infer "amber moss = safe"  | >= 65 %   | < 40 %     |
|        | without being told, by 1:30                      |           |            |
| K-17   | Players who reach B6 in a 15 h playthrough       | >= 70 %   | < 45 %     |
| K-18   | Full-body leviathan reveals per playthrough      |   1 - 2   | > 3        |
+--------+-------------------------------------------------+-----------+------------+
```

---

## 10. Glossary

Every term used across all `DESIGN/` documents. If a term is not here, it is not a
game-specific term and should be used with its ordinary meaning. Additions require an
edit to this table.

```
+------------------------+----+-----------------------------------------------------+
| Term                   | Own| Definition                                          |
+------------------------+----+-----------------------------------------------------+
| Ambient bed            | 10 | The continuously running synthesised soundscape of  |
|                        |    | a band. Levels in table 5.2.                        |
| Anchor (Rest Anchor)   | 00 | A location the player wakes at after a Blackout: a  |
|                        |    | bunk in the Roost or a shelter, or the Gannet seat. |
| Approach Margin        | 00 | Annulus 900 m < r <= 1200 m, y >= -60 m. Threat cap |
|                        |    | T1. The gradient at the edge of the Sanctuary.      |
| Band (B0..B6)          | 00 | A horizontal slab of the world defined by a depth   |
|                        |    | range. THE primary index of the whole spec. Tbl 3.5 |
| Bioluminescence        | 03 | Light emitted by living things. Below B4 it is the  |
|                        | 06 | primary non-player light source (GC-25).            |
| Blackout               | 00 | The player's failure state. Not death. No item loss.|
|                        |    | AF-01..AF-07.                                       |
| Canopy                 | 04 | The Gannet's transparent forward shell, on whose    |
|                        |    | inner surface the Windshield HUD is projected.      |
| Cargo                  | 07 | Vessel-side storage, slot-based. Distinct from the  |
|                        |    | player's on-person Kit.                             |
| Cay                    | 01 | A small low island. Shoalcrown is technically a cay.|
| Chunk                  | 02 | The terrain streaming unit. 128 m x 128 m footprint,|
|                        |    | full vertical extent, LOD-paged.                    |
| Contact                | 11 | A sonar return. May be real or a Ghost Contact.     |
| Contact heat           | 00 | A 0..1 decaying scalar feeding the Dread Index,     |
|                        |    | raised by contacts and creature calls.              |
| Corer                  | 07 | The handheld mining tool. Cuts ore from terrain.    |
|                        |    | Requires being outside the vessel.                  |
| Crush depth            | 00 | The depth at which a hull or suit tier begins to    |
|                        | 04 | take pressure damage. GC-28, GC-29.                 |
| Deterrent              | 07 | A tool that repels but never kills a creature. The  |
|                        |    | player has no lethal weapon (3.7).                  |
| Dormant                | 00 | The Gannet's zero-hull state. Sealed, sinking,      |
|                        |    | permanently locatable, always revivable. AF-20..27. |
| Dread Index (D)        | 00 | 0-100 scalar measuring engineered fear. Section 5.1.|
| DreadScheduler         | 00 | The system owning all scheduled dread events and    |
|                        | 10 | their cooldowns. DS-01..DS-08.                      |
| Dwell (suit dwell)     | 00 | Seconds of oxygen available at a band midpoint at   |
|                        | 05 | the band's suit tier, working. Table 3.8.           |
| Egress / Ingress       | 04 | Leaving / entering the Gannet. 1.40 s, available    |
|                        |    | anywhere. GC-42, GC-43.                             |
| Enclosure              | 00 | 0..1 fraction of a 32-ray hemisphere hitting solid  |
|                        |    | within 40 m. Feeds the Dread Index.                 |
| Fabricator             | 07 | The Roost's crafting device. Also the Transmuter    |
|                        |    | fallback (SL-02) and the 30 s craft undo (AF-14).   |
| Gannet                 | 04 | The player's vessel. A 6.40 m hybrid aerodyne /     |
|                        |    | submersible. Named for a plunge-diving seabird.     |
| Ghost Contact          | 00 | A sonar contact the player will probably never      |
|                        |    | resolve visually. Always backed by a real object    |
|                        |    | (DR-01). Table in 5.3.3.                            |
| Hearthmoss             | 00 | Calidocrusta. Warm amber encrusting lichen analogue |
|                        | 01 | that grows ONLY in T0 volumes. THE safety signal.   |
|                        |    | It never lies.                                      |
| Hull integrity         | 04 | The Gannet's damage pool. At 0 -> Dormant, never    |
|                        |    | destroyed.                                          |
| Kelpfall               | 01 | B2's defining structure: 60-110 m stalks rooted at  |
|                        |    | -180 m. Blocks sonar. Best movement space in game.  |
| Kit                    | 07 | The player's on-person inventory, slot-based.       |
| Lamp                   | 04 | Any artificial light source. Costs power, attracts  |
|                        |    | creatures, causes backscatter. 5.3.6.               |
| Landmark site          | 01 | One of 9 named, hand-parameterised world features   |
|                        | 08 | guaranteed to exist in every seed.                  |
| Ledge, The             | 01 | B4's defining structure: a 3.1 km near-vertical     |
|                        |    | wall with 195 m of visible face. The key dread      |
|                        |    | environment of the late game.                       |
| Leviathan              | 06 | A T5 creature. Exactly 3 exist. Mostly unseen.      |
| Lumen share            | 00 | Fraction of a band's non-player illuminance that    |
|                        |    | must come from bioluminescence. Table 3.5.          |
| Marine snow            | 03 | Drifting organic particulate, mandatory from B3     |
|                        |    | down. Speed reference and realism cue. 5.3.4.       |
| Photic Zero            | 00 | d = 780.0 m. Below it the sun term is exactly zero. |
|                        |    | GC-24.                                              |
| Ping (locator)         | 11 | The permanent HUD marker for a Dormant Gannet or    |
|                        |    | the Roost. AF-22, AF-30.                            |
| Pulse emitter          | 07 | The primary deterrent. Repels T3/T4 for 40-70 s.    |
| Quality tier           | 13 | LOW / MED / HIGH / ULTRA render presets.            |
| Recall beacon          | 00 | The Roost device that returns a Dormant Gannet to   |
|                        | 07 | the slip at 30% hull. The anti-softlock floor.      |
|                        |    | AF-25.                                              |
| Relief beat            | 00 | A scheduled beauty (not safety) event injected when |
|                        | 08 | dread has been sustained too long. DS-03.           |
| Roost, The             | 01 | The player's shelter on Shoalcrown. Bunk,           |
|                        |    | fabricator, recall beacon, storage. Always T0.      |
| Sanctuary Volume       | 00 | r <= 900 m, y >= -60 m. Guaranteed threat-free,     |
|                        |    | forever, on all settings. S-01..S-09.               |
| Scale anchor           | 00 | A static feature whose silhouette exceeds a         |
|                        | 01 | required multiple of the vessel length. 5.3.5.      |
| Scan                   | 07 | The act of cataloguing a species or mineral. Adds   |
|                        | 11 | it to the Survey Log and unlocks its caption name.  |
| Seed                   | 02 | The 32-bit world generation seed. Deterministic per |
|                        |    | build. GC-50 (see 02).                              |
| Shoalcrown             | 01 | The starting island. 182 m x 141 m, peak +34.2 m.   |
| Silence window         | 00 | A scheduled 18 dB duck of the ambient bed. 5.3.1.   |
| Slip                   | 01 | The shallow lagoon berth where the Gannet starts,   |
|                        |    | at (0, +0.4, +26), water depth 3.2 m.               |
| Softlock invariant     | 00 | One of SL-01..SL-12. Machine-verified over 2000     |
|                        |    | seeds.                                              |
| Sonar                  | 11 | The vessel's active/passive contact display. It is  |
|                        |    | never a lie, but it is often incomplete.            |
| Strain                 | 00 | The post-Blackout debuff: max O2 -20% for 180 s.    |
| Sunwash                | 00 | Band B0, 0 to -25 m. Also the name of its ambient   |
|                        | 01 | bed.                                                |
| Survey Log             | 11 | The player's own catalogue. The ONLY text in the    |
|                        |    | game authored by a person, and that person is the   |
|                        |    | player.                                             |
| T0 volume              | 00 | Any region with threat cap T0: the Sanctuary, the   |
|                        |    | sealed Gannet, player shelters, the 4 deep          |
|                        |    | hearthmoss pockets. S-10..S-13.                     |
| Telegraph              | 00 | The mandatory pre-attack signal every T2+ creature  |
|                        | 06 | must complete. S-20..S-25.                          |
| Thermocline            | 03 | A 6-9 m shear layer with a sharp temperature and    |
|                        |    | density change. First at -210 +/- 18 m.             |
| Threat class (T0..T5)  | 00 | The creature danger ladder. Table 3.7.              |
| Throat, The            | 01 | Band B6's defining structure and the game's         |
|                        |    | destination. A shaft 1280 m wide at its mouth.      |
| Tier (hull H0..H4,     | 00 | Upgrade levels. Each unlocks exactly one band.      |
|   suit S0..S4)         | 04 | GC-28, GC-29, table 3.8.                            |
| Transmuter fallback    | 00 | The 4:1 / 6:1 ore conversion that makes resource    |
|                        | 07 | starvation impossible. SL-02.                       |
| Trim                   | 04 | Vessel ballast balance. Displayed as a bubble on    |
|                        |    | the Windshield HUD below the surface.               |
| Unstick                | 00 | The always-available 3.0 s hold that relocates a    |
|                        |    | stuck player or vessel. SL-06.                      |
| Unresolved contact     | 00 | See Ghost Contact.                                  |
| Vitals ring            | 11 | The bottom-left HUD element. Solid = inside a T0    |
|                        |    | volume; dashed (6 segments) = outside. AX-14.       |
| Windshield HUD         | 11 | Instruments projected onto the inner surface of the |
|                        |    | canopy glass, with parallax, in world space.        |
| Wonder beat            | 00 | A mandatory per-band beauty moment on the critical  |
|                        | 08 | path. PC-03.                                        |
+------------------------+----+-----------------------------------------------------+
```

Naming conventions for all documents:

* Places, creatures, plants, and minerals get **naturalistic, descriptive,
  non-human-derived** names: `Kelpfall`, `The Ledge`, `Sable Trench`, `hearthmoss`.
* Player-made objects may carry manufactured names (`Gannet`, `Roost`, `Corer`), since
  the player made them and the player is a person.
* No name may imply another intelligence, a civilisation, a myth, or a prior visitor.
* Binomial-style Latinate names (`Calidocrusta`) are permitted **only** in the Survey
  Log, because the player is the one assigning them.

---

## 11. The DESIGN folder

Complete table of contents. Every file listed is required to ship.

```
+------+--------------------------------+-------------------------------------------+
| File | Title                          | Owns                                      |
+------+--------------------------------+-------------------------------------------+
| 00   | Vision, Design Pillars,        | Pitch, 5 pillars, GC-xx global constants, |
|      | Player Experience & Difficulty | depth bands B0-B6, threat classes T0-T5,  |
|      | Curve                          | emotional arc, dread curve, Safety        |
|      |   00-vision-and-pillars.md     | Charter S-xx, anti-frustration AF-xx,     |
|      |                                | softlock invariants SL-xx, accessibility  |
|      |                                | AX-xx, KPIs, glossary, this TOC.          |
+------+--------------------------------+-------------------------------------------+
| 01   | World & Biomes                 | The macro world layout, the biome list    |
|      |   01-world-and-biomes.md       | with per-biome numeric fields, biome       |
|      |                                | placement rules, the 9 landmark sites,    |
|      |                                | Shoalcrown, the Kelpfall, the Ledge, the  |
|      |                                | Sable Trench, the Throat, flora, water    |
|      |                                | colour/turbidity per biome, hearthmoss    |
|      |                                | placement rules.                          |
+------+--------------------------------+-------------------------------------------+
| 02   | Terrain Generation             | Noise stack, heightfield + 3D SDF hybrid, |
|      |   02-terrain-generation.md     | marching cubes / surface nets, caves,     |
|      |                                | overhangs, erosion, strata & fossil beds, |
|      |                                | chunk scheme, LOD, streaming, collision   |
|      |                                | meshes, seed determinism, the S-00 and    |
|      |                                | SL-01/SL-04 generator assertions.         |
+------+--------------------------------+-------------------------------------------+
| 03   | Ocean & Atmosphere             | Water surface (spectral/FFT or Gerstner), |
|      |   03-ocean-and-atmosphere.md   | per-channel absorption & scattering       |
|      |                                | coefficients, caustics, foam, sky model,  |
|      |                                | two moons, weather, wind, thermoclines,   |
|      |                                | currents, marine snow, the surface        |
|      |                                | transition band (GC-40/41).               |
+------+--------------------------------+-------------------------------------------+
| 04   | Vessel                         | The Gannet: geometry generation, mass and |
|      |   04-vessel.md                 | inertia tensor, ducted-fan aero model,    |
|      |                                | hydro model, added mass, buoyancy and     |
|      |                                | ballast, control surfaces, thrust curves, |
|      |                                | hull integrity and crush damage curve,    |
|      |                                | lamps (beam angles, lumens, power draw),  |
|      |                                | O2 recycler, Dormant state, ingress /     |
|      |                                | egress, airlock, cockpit interior.        |
+------+--------------------------------+-------------------------------------------+
| 05   | Player & Survival              | On-foot and swimming locomotion, stamina, |
|      |   05-player-and-survival.md    | the oxygen model (GC-30..GC-33 and the    |
|      |                                | dwell table 3.8), suit tiers, temperature,|
|      |                                | pressure, Blackout implementation, Strain,|
|      |                                | first-person body, hands, tool holstering.|
+------+--------------------------------+-------------------------------------------+
| 06   | Bestiary & AI                  | All 61 species with full numeric stat     |
|      |   06-bestiary-and-ai.md        | rows, procedural body-plan parameters,    |
|      |                                | swim gaits, boids/flocking, predation and |
|      |                                | food webs, day/night behaviour, threat     |
|      |                                | class assignment, telegraph definitions   |
|      |                                | (S-20..S-25), leviathan behaviour, the    |
|      |                                | spawn predicate enforcing S-01/S-02.      |
+------+--------------------------------+-------------------------------------------+
| 07   | Resources, Mining & Crafting   | 14 ore types with depth/biome/yield/       |
|      |   07-resources-mining-         | hardness rows, deposit generation, the     |
|      |   crafting.md                  | Corer, 34 recipes with exact costs, the   |
|      |                                | Fabricator, the Transmuter fallback,      |
|      |                                | deterrents, cargo/kit slot economy,       |
|      |                                | the Recall beacon, shelter modules.       |
+------+--------------------------------+-------------------------------------------+
| 08   | Progression & Narrative        | The gate ladder, beat-by-beat critical    |
|      |   08-progression-and-          | path with timestamps, the wonder beats,   |
|      |   narrative.md                 | the relief beats, the Failing Lamp beat,  |
|      |                                | the 4 deep hearthmoss pockets, the ending |
|      |                                | at the bottom of the Throat, environmental|
|      |                                | storytelling rules (no words, ever).      |
+------+--------------------------------+-------------------------------------------+
| 09   | Rendering Architecture         | WebGPU device setup, the render graph and |
|      |   09-rendering-architecture.md | every pass, WGSL module inventory, buffer |
|      |                                | and bind group layouts, texture formats,  |
|      |                                | volumetric water shading implementing     |
|      |                                | GC-20..GC-27, clustered lighting for      |
|      |                                | bioluminescence, shadows, exposure,       |
|      |                                | post-process chain, procedural texture    |
|      |                                | generation, mesh generation pipeline.     |
+------+--------------------------------+-------------------------------------------+
| 10   | Audio                          | The Web Audio graph, synthesis method per |
|      |   10-audio.md                  | sound class, the ambient beds (table 5.2),|
|      |                                | LF rumble with harmonic reinforcement,    |
|      |                                | silence windows, creature vocalisation    |
|      |                                | synthesis, underwater filtering, the      |
|      |                                | surface crossfade, spatialisation, mixing |
|      |                                | and ducking, the tension bed, AX-43..47.  |
+------+--------------------------------+-------------------------------------------+
| 11   | UI, HUD & UX                   | The Windshield HUD (projection maths,     |
|      |   11-ui-hud-ux.md              | parallax, adaptive backing plates), the   |
|      |                                | on-foot HUD, the vitals ring, compass     |
|      |                                | ribbon, depth ladder, sonar display,      |
|      |                                | Survey Log, fabricator UI, the glyph      |
|      |                                | language, procedural font, menus, the     |
|      |                                | Comfort & Access menu, captions (AX-40).  |
+------+--------------------------------+-------------------------------------------+
| 12   | Controls & Input               | Full keybind table (KB+M and gamepad),    |
|      |   12-controls-and-input.md     | the unified vessel control scheme across  |
|      |                                | air and water, dead zones, sensitivity,   |
|      |                                | rebinding, AX-50..AX-56, pointer lock,    |
|      |                                | input buffering, the Unstick hold.        |
+------+--------------------------------+-------------------------------------------+
| 13   | Performance & Scalability      | Frame budget breakdown in ms per pass,    |
|      |   13-performance-and-          | the 4 quality tiers with every knob,      |
|      |   scalability.md               | LOD policy, culling, instancing, GPU      |
|      |                                | memory budget, streaming budget, entity   |
|      |                                | caps per band, particle caps, the         |
|      |                                | degradation ladder to 30 fps, profiling.  |
+------+--------------------------------+-------------------------------------------+
| 14   | Data Schemas & Save            | IndexedDB object stores, the save schema, |
|      |   14-data-schemas-and-save.md  | localStorage settings schema, chunk delta |
|      |                                | encoding, versioning and migration,       |
|      |                                | autosave policy (SL-08), corruption       |
|      |                                | recovery, export/import.                  |
+------+--------------------------------+-------------------------------------------+
| 15   | Content Manifest               | The complete registry: every biome, every |
|      |   15-content-manifest.md       | species, every ore, every recipe, every   |
|      |                                | sound, every shader, every landmark, with |
|      |                                | IDs, owning document, and status. The     |
|      |                                | single source of truth for "what exists". |
|      |                                | Also the P4-T and P5-T audit tables.      |
+------+--------------------------------+-------------------------------------------+
```

---

## 12. Change control

```
+--------+-------------------------------------------------------------------------+
| CC-01  | Any change to a GC-xx, a band boundary, a threat cap, an S-xx, an       |
|        | AF-xx, an SL-xx, or an AX-xx requires: (a) a revision bump on this      |
|        | file, (b) a listed rationale, (c) a sweep of every document that cites  |
|        | the changed ID.                                                         |
| CC-02  | Requirement IDs are permanent. Retire with WITHDRAWN, never renumber.   |
| CC-03  | Any document that needs a number this file does not provide must add it |
|        | locally AND propose it here if another document will need it.           |
| CC-04  | The five pillar tests (P1-T .. P5-T) run in CI. A failing pillar test   |
|        | blocks release regardless of schedule.                                  |
| CC-05  | The Safety Charter (S-01..S-13) is the one section that may never be    |
|        | relaxed for schedule, scope, or performance reasons. If it cannot be    |
|        | met, the feature that threatens it is cut, not the charter.             |
+--------+-------------------------------------------------------------------------+
```

**End of DESIGN 00.**
