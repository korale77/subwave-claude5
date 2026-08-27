# SUBWAVE — DESIGN SECTION 08

# Progression, Goals, Environmental Narrative & The Ending

Status: BINDING. Engineers implement exactly what is written here.
Coordinate system: right-handed, +X east, +Y up, +Z south, metres, sea level y = 0, depth `d = -y`.
Heading: `heading_deg = (degrees(atan2(dx, -dz)) + 360) mod 360`, 0 = north, 90 = east.
All angles stored in radians; degrees appear only in UI strings.

---

## 08.0 SCOPE, AXIOMS AND BINDING DECISIONS

### 08.0.1 Narrative axioms (non-negotiable)

| # | Axiom | Enforcement |
|---|-------|-------------|
| A1 | No humans exist on this planet other than the player. | Content review gate: zero human-made props, zero human remains, zero voices, zero language artefacts outside the player's own equipment. |
| A2 | No human ruins, wreckage, machinery, signage, or artificial structures of any origin. | Asset generators must not emit right-angle-dominant meshes below y = 0 except the player's own vessel/base/beacons. |
| A3 | No spacecraft, no alien technology, no "precursors". | The final reveal is an organism. See 08.7. |
| A4 | Every narrative beat is delivered by geology, biology, bioluminescence, acoustics, or the player's own field notes. | No cutscene may contain non-diegetic speech. Zero voice lines in the entire product. |
| A5 | The only written language in the game is the player's own handwriting in the Databank, plus instrument readouts. | Font/UI section must not render any other text source in world space. |
| A6 | Dread, never gore. No blood, no corpses of the player's kind, no body horror rendered explicitly. Fear comes from scale, darkness, silence, and time. | Damage feedback is pressure/structural, not visceral. |
| A7 | The planet does not care about the player. Nothing in the world was made for them, addressed to them, or waiting for them. | No object may be positioned as a "message". |

### 08.0.2 Names used in this section

| Term | Meaning | First shown to player |
|------|---------|-----------------------|
| The Slate | The player's wrist databank/PDA. Diegetic name in all UI. | 0:00 |
| The Metronome | Player's field name for the periodic infrasound source. | 0:03 (auto entry SIG-01) |
| A Root | One of 6 calcite spires that carry the signal, at increasing depth. | 0:40 (R1) |
| The Throat | The 940 m vertical calcite shaft leading into the trench floor chamber. | ~9:00 |
| The Chamber | The trench-floor cavity, 4.2 km across. | ~9:20 |
| The Holdfast | The organism. Name only appears in the final entries. | ~9:40 |
| The Bloom | The terminal spawning event = the ending. | ~9:55 |
| Aphotic Rift | The trench. Named in GEO entries. | 2:30 |

### 08.0.3 World anchors this section fixes (other sections MUST honour these)

| Anchor | World position (x, y, z) | Notes |
|--------|--------------------------|-------|
| Home island centre | (0, +11.4, 0) | Safe start. Zero hostile spawns inside radius 900 m of this point at all depths. |
| Placer beach (anti-softlock keystone) | (+68, +0.8, +142) | See 08.3.7. |
| Root R1 | (+128, -85, +690) | |
| Root R2 | (+402, -260, +1980) | |
| Root R3 | (+707, -640, +3610) | |
| Root R4 | (+981, -1320, +5340) | |
| Root R5 | (+1214, -2480, +7180) | |
| Root R6 | (+1388, -3550, +8720) | |
| Signal source (Holdfast core) | (+1450, -4180, +9260) | Straight-line range from origin 9370 m. True bearing from origin 171.1 deg. |
| Throat mouth (top of shaft) | (+1444, -3240, +9210) | Shaft axis near-vertical, mean inclination 4.1 deg. |

The Roots lie on a monotone descending chain heading approximately 171 deg from the island. Successive Root-to-Root ranges: R1-R2 1.32 km, R2-R3 1.66 km, R3-R4 1.75 km, R4-R5 1.86 km, R5-R6 1.55 km, R6-Core 0.56 km. World generation must guarantee a navigable water column (no sealed rock) along that chain.

---

## 08.1 (A) THE HOOK — WHY THE PLAYER DESCENDS

### 08.1.1 The one-minute hook

The player wakes at the base on the home shoal. The vessel is docked. There is no emergency, no countdown, no distress call. The hook is a **measurement**.

Cold-open sequence, exact timing from first frame of player control:

| t (s) | Event | Implementation trigger |
|-------|-------|------------------------|
| 0 | Player control granted, standing on the beach deck. Dawn, sun elevation +4.2 deg. Ambient: surf, wind 3.1 m/s, three bird-analogue calls. | `state.stage = S0` |
| 0-40 | Free movement. Base hydrophone buoy is visible 22 m offshore, blinking amber at 0.5 Hz. It is the only man-made light in view. | Passive |
| 44 | If the player has not approached the buoy by t=44 s, the buoy's amber blink changes to 2.0 Hz and its low-frequency emitter audibly clicks once. Soft attractor only, no marker, no text. | `if !buoy_visited && t>44` |
| on approach (<6 m) | Buoy readout: `PERIODIC SOURCE // 7.1 Hz // REPEAT 41.60 s // BRG 171 +/- 4` | Proximity trigger |
| +2.0 s after readout | **First pulse the player hears.** Heterodyned x8 to 56.8 Hz, 3.1 s envelope, peak -14 dBFS. On land it is felt in the deck plating (screen translation 0.9 mm at 2.4 Hz for 1.1 s). | Pulse scheduler, see 08.2 |
| +2.2 s | Slate auto-writes SIG-01 (full text in 08.5). No fanfare: a single soft pen-scratch sound, 0.6 s. | `unlock('SIG-01')` |
| +41.6 s | Second pulse. Identical to 0.02 s. This is the hook: **it is exactly periodic.** | Pulse scheduler |

The hook is: *a natural ocean does not keep time to two decimal places.* Nothing threatens the player. Nothing asks for help. Something 9.4 km away is counting, and it has been counting since before the player arrived.

### 08.1.2 Why the hook escalates instead of decaying

A static mystery goes stale in 40 minutes. This one has a **derivative**:

- The interval is not constant over the campaign. It shortens. (08.2.2)
- The shortening is not noticeable at first. It becomes undeniable at hour 3.
- Every bioluminescent organism in the ocean flashes at an integer subdivision of the current interval. The player discovers this by accident, from their own scan data, not from being told. (08.4.5)

So the hook mutates from "what is that noise" -> "that noise is alive" -> "everything alive is listening to it" -> "it is counting down" -> "to what".

### 08.1.3 Secondary motivations (all non-human, all optional)

| Motivation | Delivery | Player type served |
|------------|----------|--------------------|
| Survive | O2, pressure, energy. | Everyone. |
| See | Biomes get more beautiful with depth, monotonically. Bioluminescent density rises from 0.02 emitters/m^3 at -100 m to 4.1 emitters/m^3 at -2600 m. | Explorer |
| Catalogue | 118 specimen entries with completion tiers. (08.8.4) | Completionist |
| Build | Base modules, vessel upgrades. | Engineer |
| Localise | Triangulate the source. Pure instrument play. (08.4.4) | Simulation player |

---

## 08.2 THE METRONOME — EXACT ACOUSTIC AND STATE SPECIFICATION

### 08.2.1 Signal physics

```js
// Source parameters (fixed)
const PULSE_F0        = 7.1;      // Hz, fundamental (infrasound)
const PULSE_HARMONICS = [1, 3, 5, 7];          // odd only; near-square glottal-like envelope
const PULSE_HARM_GAIN = [1.0, 0.62, 0.28, 0.11];
const PULSE_SL        = 214.0;    // dB re 1 uPa @ 1 m, source level
const PULSE_ENV_MS    = 3100;     // ms, 120 ms attack, 2600 ms body, 380 ms release
const HETERODYNE_MUL  = 8;        // hydrophone shifts to 56.8 Hz so it is audible
const ALPHA_7HZ       = 4.0e-5;   // dB/m absorption at 7 Hz in seawater (near-lossless)
```

Received level at slant range R metres:

```
RL_dB = PULSE_SL - 20*log10(max(R,1)) - ALPHA_7HZ*R - OCCL(R)
OCCL  = 0.009 dB per metre of solid rock chord along the ray (raymarched, 32 samples max)
```

Perceptual thresholds:

| Threshold | RL (dB re 1 uPa) | Range from core | Effect |
|-----------|------------------|-----------------|--------|
| Detection (hydrophone) | 92 | 39.8 km | Bearing readable |
| Audible in cockpit without hydrophone | 138 | 6.31 km | Low hull moan |
| Felt in body / hull (haptic + camera) | 155 | 891 m | Camera translation, hull rattle |
| Vision distortion (chromatic + vertical smear) | 172 | 126 m | Finale only |
| Structural (hull integrity -0.4%/pulse) | 186 | 25 m | Finale only, non-lethal, capped at 40% |

Roots emit a phase-locked local repeat at `SL = 178 dB re 1 uPa @ 1 m`, so a Root is *felt* within 14.1 m and *audible in cockpit* within 79 m, but is not detectable on the hydrophone beyond 2.0 km. This is why Roots must be found by proximity/vision, not triangulation, while the core must be found by triangulation.

### 08.2.2 The interval schedule (the countdown)

Base tick `T0 = 4.16 s`. All periods are integer multiples of `T0`.

```js
const T0 = 4.16;
const STAGE_PERIOD = { S0:10*T0, S1:9*T0, S2:8*T0, S3:6*T0, S4:4*T0, S5:3*T0, S6:2*T0, FINALE:1*T0 };
// = { S0:41.60, S1:37.44, S2:33.28, S3:24.96, S4:16.64, S5:12.48, S6:8.32, FINALE:4.16 }

const DAY_REAL_SECONDS = 1200;    // 1 in-world day = 20 real minutes (see section 05)

function pulsePeriod(state, worldTimeSeconds) {
  const days     = worldTimeSeconds / DAY_REAL_SECONDS;
  const pClock   = clamp(41.60 * Math.pow(0.5, days / 9.0), 12.48, 41.60);
  const pStage   = STAGE_PERIOD[state.stage];
  return Math.min(pClock, pStage);       // whichever is further along wins
}
```

Consequences, all intentional:

- `pClock` halves every 9 in-world days = 3 real hours. It bottoms out at 12.48 s (the S5 value) after ~10 real hours.
- A player who never progresses still experiences escalating dread from the clock alone, but the clock **cannot** reach 8.32 s or 4.16 s. The last two accelerations require R6 and the Chamber. The finale can never be spent by idling.
- A fast player drives the acceleration with the Roots. The world feels responsive to them without ever being *about* them.
- There is **no fail timer anywhere in the game.** The countdown ends in an event, not a death.

Pulse phase is globally deterministic and save-persisted:

```js
// Absolute pulse index is integrated, not derived, so period changes never skip or double a pulse.
state.pulsePhase += dt / pulsePeriod(state, worldTime);
while (state.pulsePhase >= 1.0) { state.pulsePhase -= 1.0; state.pulseIndex++; emitPulse(); }
```

### 08.2.3 The silence before the pulse (primary dread instrument)

Below `d = 600 m`, ambient bioacoustics duck **before** each pulse:

```
gap_s = clamp(0.9 + 0.0016 * d, 0.9, 6.0)     // 1.9 s at 600 m, 6.0 s at 3200 m+
ambientBioGain = (timeToNextPulse < gap_s) ? lerp(1.0, 0.02, 1 - timeToNextPulse/gap_s) : 1.0
```

Everything living stops making noise before it arrives. Below -2400 m the silence lasts 4.7 s and the only remaining sound is the player's own regulator and hull. This costs nothing to implement and is the single most effective fear tool in the game. Do not cut it.

### 08.2.4 Story stage machine

| Stage | Enter condition (exact flag) | Period | Typical hour | Max depth player is expected to hold |
|-------|------------------------------|--------|--------------|--------------------------------------|
| S0 | New game | 41.60 s | 0.0 | 60 m |
| S1 | `scanned.has('ROOT_1')` | 37.44 s | 0.7 | 220 m |
| S2 | `scanned.has('ROOT_2')` | 33.28 s | 2.1 | 520 m |
| S3 | `scanned.has('ROOT_3')` | 24.96 s | 3.6 | 1150 m |
| S4 | `scanned.has('ROOT_4')` | 16.64 s | 5.4 | 2200 m |
| S5 | `scanned.has('ROOT_5')` | 12.48 s | 7.2 | 3600 m |
| S6 | `scanned.has('ROOT_6')` | 8.32 s | 9.0 | 4600 m |
| FINALE | `enteredChamber === true` | 4.16 s -> 0 | 9.4 | 4600 m |
| EPILOGUE | `bloomComplete === true` | none (silent forever) | 10.2 | 4600 m |

Stage is monotone. It never decreases. Loading an old save restores the recorded stage.

---

## 08.3 (B) GATING — DEPTH, LIGHT, OXYGEN, HARDNESS

### 08.3.1 Depth bands

| Band | Name | Depth range (m) | Ambient irradiance at top/bottom (relative to surface) | Hostile pressure | Biome refs (section 03) |
|------|------|-----------------|--------------------------------------------------------|------------------|--------------------------|
| B0 | Home Shoal | 0 to 40 | 1.00 / 0.32 | none | Reef flat, lagoon, sand shelf, island |
| B1 | Kelp Shelf | 40 to 150 | 0.32 / 0.028 | none | Kelp forest, boulder garden, rubble apron |
| B2 | Drift Slope | 150 to 400 | 0.028 / 4.4e-4 | low | Glass sponge terrace, sediment fans, first canyons |
| B3 | Twilight Fall | 400 to 900 | 4.4e-4 / 1.1e-6 | low | Wall of the shelf break, brine pools, coilworm fields |
| B4 | The Long Dark | 900 to 1800 | 1.1e-6 / ~0 | medium | Abyssal plain, nodule fields, clathrate pingos |
| B5 | Rift Walls | 1800 to 3400 | 0 | high | Trench walls, black smoker fields, serpentinite towers |
| B6 | Rift Floor | 3400 to 4400 | 0 | extreme | Trenchglass talus, the Throat, the Chamber |

Photic reference (section 04 owns absorption; this section only depends on it): below 1100 m ambient contributes < 1e-7 of surface irradiance and is clamped to exactly zero in the renderer. Below that depth, all light in frame is the player's, or is alive.

### 08.3.2 Vessel hull classes

Vessel name: the **Kite** (hybrid flight/dive craft, see section 06).

| Class | Name | Crush depth (m) | Mass added (kg) | Craft cost | Deepest input material depth (m) | Previous class crush (m) | Margin (m) |
|-------|------|-----------------|-----------------|------------|-----------------------------------|--------------------------|------------|
| H0 | Shoal Hull (start) | 60 | 0 | n/a | n/a | n/a | n/a |
| H1 | Braced Hull | 220 | 210 | RUT x8, LIM x12, CU x6 | 44 (RUT), 0 (placer) | 60 | +16 |
| H2 | Laminate Hull | 520 | 340 | PYR x10, BAR x6, RUT x14 | 168 (PYR) | 220 | +52 |
| H3 | Sintered Hull | 1150 | 520 | ARG x8, MNN x16, PYR x12 | 431 (ARG) | 520 | +89 |
| H4 | Isostatic Hull | 2200 | 760 | COB x12, PHO x10, ARG x10 | 942 (COB) | 1150 | +208 |
| H5 | Deep Frame | 3600 | 1040 | CLA x14, PHO x18, MNN x24 | 1210 (CLA) | 2200 | +990 |
| H6 | Rift Frame | 4600 | 1380 | AWA x14, TGL x8, DIA x4, COB x16 | 1960 (AWA) | 3600 | +1640 |

**Crush behaviour** (no instant death): at `d > crush`, hull integrity drains at
`rate = 0.55 %/s * (1 + (d - crush)/180)`. At integrity 0 the SCUTTLE PROTECT routine fires (08.3.8). Warning tones begin at `d > 0.94 * crush`. The windshield HUD depth readout turns amber at 0.94 and red at 1.00 (see section 07).

### 08.3.3 Dive suit classes (out-of-vessel)

| Class | Name | Suit crush (m) | Base O2 (L) | Thermal floor (deg C) | Craft cost | Deepest input (m) | Prev crush (m) | Margin |
|-------|------|----------------|-------------|-----------------------|------------|-------------------|----------------|--------|
| S0 | Dive Skin (start) | 45 | 22 | 9 | n/a | n/a | n/a | n/a |
| S1 | Reinforced Skin | 240 | 30 | 4 | KFB x10, RUT x4, CU x4 | 52 (KFB) | 45 | +7 |
| S2 | Pressure Shell | 950 | 44 | 1 | CHT x8, BAR x6, PYR x8 | 288 (CHT) | 240 | +48 |
| S3 | Hadal Carapace | 4600 | 60 | -1 | AWA x6, CHT x14, TGL x4 | 1960 (AWA) | 950 | +1010 |

Suit crush failure is a hard fail (blackout, respawn) because it must be. Warning at 0.92 of suit crush. **The vessel is always the safe container**; a player who never leaves the Kite can reach the bottom with suit S1 alone, at the cost of never mining anything below 240 m. That path softlocks at H4 and is prevented by the tutorialised excursion loop (08.9 hour 1-3).

### 08.3.4 Oxygen — the physically-motivated gate

This is the most important gate in the game and it is real physics.

Open-circuit gas consumption scales with absolute pressure:

```js
const P_SURF_ATA   = 1.0;
const ATA_PER_M    = 1 / 10.06;              // seawater, rho = 1027 kg/m3
const SAC_REST     = 12.0;                   // L/min surface-equivalent, resting
const SAC_SWIM     = 21.0;                   // L/min, normal swim
const SAC_SPRINT   = 42.0;                   // L/min, sprint or mining

// Open circuit (tanks Mk1..Mk2)
function drainOpen(depth_m, activity) {
  return SAC[activity] * (P_SURF_ATA + depth_m * ATA_PER_M);   // L/min of stored gas
}
// Closed circuit (rebreather Mk1+): metabolic only, DEPTH INDEPENDENT
function drainClosed(activity) { return MET[activity]; }       // MET = {rest:0.9, swim:1.6, sprint:3.1} L/min
```

Consequence: at 200 m an open-circuit swim burns `21 * (1 + 19.88) = 438 L/min`. A 30 L tank lasts **4.1 seconds**. Open circuit is therefore *physically* useless below ~90 m. The rebreather is not a stat upgrade, it is a change of category. Players feel the difference as a cliff, and the field note that unlocks with it (BIO-09) explains why: the scrubber uses a hemocyanin-derived CO2 binder harvested from a deep crustacean.

| Tier | Item | Type | Capacity | Endurance @ 40 m swim | Endurance @ 800 m swim | Craft cost | Deepest input (m) |
|------|------|------|----------|------------------------|-------------------------|------------|--------------------|
| O1 | Tank Mk1 (start) | open | 22 L | 0:23 | 0:00 (impossible) | n/a | n/a |
| O2 | Tank Mk2 | open | 30 L | 0:32 | 0:00 | LIM x8, CU x4 | 0 |
| O3 | Rebreather Mk1 | closed | 210 min scrubber | 3:30:00 (scrubber-limited) | 3:30:00 | HCY x6, KFB x12, CU x8 | 118 (HCY) |
| O4 | Rebreather Mk2 | closed | 420 min scrubber, +O2 bail-out 40 L | 7:00:00 | 7:00:00 | HCY x10, CHT x10, BAR x6 | 302 (CHT) |

Effective out-of-vessel excursion budget is therefore governed by the **scrubber timer**, which drains only while the helmet seal is closed, and refills to 100% instantly on entering the Kite or the base airlock. Design intent: excursions are 4-14 minutes, not 40 seconds; the tension is depth and dark, not a suffocation stopwatch.

Emergency: at scrubber 0 or tank 0, the player gets a 25 s bail-out reserve (Rebreather Mk2 only: 95 s), heartbeat mix rises +6 dB, vignette closes to 0.42 screen radius. Blackout at 0. Respawn at base with all inventory retained (08.3.8).

### 08.3.5 Light tiers

Ambient is zero below 1100 m. Below that, *seeing* is an equipment problem.

| Tier | Item | Luminous flux (lm) | Beam half-angle (deg) | Useful range in clear water (m) | Useful range in marine snow (m) | Power draw (W) | Craft cost | Deepest input (m) |
|------|------|--------------------|------------------------|----------------------------------|----------------------------------|----------------|------------|--------------------|
| L1 | Helmet Lamp (start) | 900 | 22 | 19 | 11 | 9 | n/a | n/a |
| L2 | Kite Floods Mk1 | 3400 | 34 | 44 | 24 | 46 | RUT x6, LIM x10 | 44 |
| L3 | Kite Floods Mk2 | 12500 | 30 | 92 | 47 | 155 | PYR x8, ARG x4, BAR x6 | 431 |
| L4 | Arc Floods | 41000 | 26 | 168 | 78 | 470 | COB x10, TGL x6, PHO x8 | 2140 (TGL) |
| L5 | Photophore Bar (bio) | 2600 diffuse, 486 nm | omni | 30 omni | 26 omni | 4 | PHS x12, CHT x6 | 1480 (PHS) |

Two important rules:

1. **Light does not gate survival, it gates comprehension.** You can physically fly the Kite to 3000 m with L2 floods and H5. You will see 24 m of a 1600 m wall. The game does not stop you; it simply becomes an act of faith. Several playtest-favourite moments live here.
2. **L5 Photophore Bar is a stealth tool.** Its 486 nm spectrum matches native bioluminescence; creatures with `lightAversion > 0` do not flee from it and `lightAttraction` predators do not home on it. It is the only way to observe 6 of the 118 catalogue species (08.8.4). It is optional, and finding that out is a reward.

### 08.3.6 Cutter tiers (mineral hardness gate)

| Tier | Item | Max Mohs | Cut rate (cm3/s) | Power (W) | Craft cost | Deepest input (m) |
|------|------|----------|-------------------|-----------|------------|--------------------|
| C1 | Hand Cutter (start) | 4.0 | 3.1 | 22 | n/a | n/a |
| C2 | Braced Cutter | 6.5 | 7.4 | 68 | RUT x6, CU x8 | 44 |
| C3 | Sintered Cutter | 9.5 | 15.2 | 190 | ARG x6, PYR x10, MNN x8 | 431 |

Diamond (Mohs 10) is never cut. It occurs only as loose kimberlite float on the Rift Walls talus and is hand-collected.

### 08.3.7 Material master table

Codes are the canonical IDs used by all other sections.

| Code | Name | Class | Band | Shallowest reliable spawn (m) | Deepest (m) | Mohs | Nodes/km2 | Yield/node | Respawn (min) | Used by |
|------|------|-------|------|-------------------------------|-------------|------|-----------|------------|---------------|---------|
| LIM | Limestone nodule | mineral | B0 | 2 | 140 | 3.0 | 1900 | 3 | 12 | H1, L2, O2, base |
| CU | Native copper | mineral | B0 | 6 | 190 | 3.0 | 640 | 2 | 14 | H1, S1, O2, O3, C2 |
| SIL | Silica sand | mineral | B0 | 0 (beach) | 90 | 6.5 | infinite (beach) | 4 / 8 s sieve | n/a | glass, base, scanner |
| RUT | Rutile-ilmenite | mineral | B0/B1 | **0 (placer beach) / 44 (vein)** | 340 | 6.0 vein / 0 placer | 410 | 3 | 18 | H1, H2, S1, L2, C2 |
| KFB | Kelp fibre | organic | B1 | 52 | 160 | n/a | harvest | 2 | 8 | S1, O3 |
| HCY | Blue-blood crawler haemolymph | organic | B1/B2 | 118 | 520 | n/a | creature | 1 | creature respawn | O3, O4 |
| BAR | Barite rosette | mineral | B2 | 176 | 610 | 3.3 | 380 | 2 | 20 | H2, O4, L3, S2 |
| PYR | Pyrrhite (Ni-Fe sulphide) | mineral | B2 | 168 | 720 | 4.2 | 300 | 3 | 20 | H2, H3, S2, L3, C3 |
| CHT | Chitin plate | organic | B2/B3 | 288 | 1400 | n/a | creature | 2 | creature respawn | S2, S3, O4, L5 |
| MNN | Manganese nodule | mineral | B3 | 452 | 1900 | 2.6 | 5200 | 1 | 9 | H3, H5, C3 |
| ARG | Argent nodule | mineral | B3 | 431 | 1240 | 2.8 | 190 | 2 | 26 | H3, H4, L3, C3 |
| PHS | Photophore sac | organic | B3/B4 | 1480 | 3400 | n/a | creature | 1 | creature respawn | L5 |
| COB | Cobalt crust | mineral | B4 | 942 | 2600 | 3.6 | 720 | 2 | 24 | H4, H6, L4 |
| PHO | Rare-earth phosphorite | mineral | B4 | 1060 | 2900 | 5.0 | 260 | 2 | 26 | H4, H5, L4 |
| CLA | Methane clathrate | mineral | B4 | 1210 | 2400 | 1.5 | 340 | 3 | 22 | H5, energy |
| AWA | Awaruite (bright iron) | mineral | B5 | 1960 | 3900 | 5.0 | 210 | 2 | 30 | H6, S3 |
| TGL | Trenchglass | mineral | B5 | 2140 | 4200 | 5.6 | 290 | 2 | 30 | H6, S3, L4 |
| DIA | Kimberlite diamond float | mineral | B5 | 2380 | 4100 | 10 | 44 | 1 | 45 | H6 |
| PTB | Pearl-tube fragment | organic | B6 | 3480 | 4400 | 3.0 | 110 | 1 | never | catalogue only |

**RUT placer beach is the anti-softlock keystone.** At (+68, +0.8, +142) there is a 340 m^2 black-sand placer above sea level. Hand-sieving yields 1 RUT per 12.0 s with no tool, no power, no depth, and **no cap and no respawn timer**. Every hard gate in the game traces back through RUT. As long as the player can walk, they can rebuild.

### 08.3.8 The no-loss guarantees (softlock prevention)

| # | Guarantee | Implementation |
|---|-----------|----------------|
| G1 | The Kite can never be permanently lost. | At hull integrity 0: SCUTTLE PROTECT. Ballast vents, craft ascends at 1.4 m/s to y = -1.0 m, all systems offline 300 s, then integrity restored to 25%. Player is force-ejected only if inside and suit-rated for local depth; otherwise they ride it up. |
| G2 | Death never destroys inventory or upgrades. | On blackout: respawn at base bed. Inventory retained 100%. Installed upgrades are permanent and are not items. Cost of death = travel time only. |
| G3 | Crafted upgrades are never consumed, downgraded, or damaged. | Upgrade state is a bitfield, not durability. |
| G4 | Power can always be regenerated for free. | Base solar array outputs 1.8 kW peak / 0 at night with 42 kWh buffer. The Kite recharges at 11 kW docked, and at 4.2 kW at any hydrothermal vent (thermoelectric skin, `dT > 40 K`). Vents exist in every band from B2 down. |
| G5 | Every tier-N recipe's deepest input is strictly shallower than tier-(N-1) crush depth. | Verified in 08.3.9. |
| G6 | Consumable-only progression does not exist. There is no fuel, no ammo, no food spoilage that can strand the player. | Hunger/thirst are OFF by design; there is no farming loop. Survival pressure is O2, pressure, dark, cold. |
| G7 | All mineral nodes respawn on the chunk timers in 08.3.7 with a 60% per-chunk regeneration cap (no infinite farm, no exhaustion). | Chunk resource ledger in IndexedDB. |
| G8 | The Roots and the Chamber cannot be destroyed, blocked, or missed permanently. | They are static world geometry with no destructible flag. |
| G9 | No timed content. Nothing expires. The Bloom waits for the player forever (see 08.2.2 clock floor). | Stage floor clamp. |

### 08.3.9 Closure proof (no softlock)

Define `Dmax(k)` = the greatest depth the player can reach and survive indefinitely after acquiring upgrade set at tier k = min(hull crush, and for on-foot mining, suit crush).

Claim: for every tier k >= 1, every material required to craft tier k is obtainable at depth <= `Dmax(k-1)`.

| Tier k | Needed for | Recipe inputs | Deepest required acquisition depth (m) | `Dmax(k-1)` vessel (m) | Vessel margin | `Dmax(k-1)` suit (m) | Suit-reachable? |
|--------|-----------|---------------|----------------------------------------|------------------------|---------------|-----------------------|------------------|
| 1 | H1 | RUT, LIM, CU | 6 (CU); RUT from surface placer | 60 | +54 | 45 | YES |
| 1 | S1 | KFB, RUT, CU | 52 (KFB) | 60 | +8 | 45 | Requires vessel-assisted excursion, 7 m dive from hovering Kite; verified reachable with S0 45 m crush. YES |
| 1 | O2 tank Mk2 | LIM, CU | 6 | 60 | +54 | 45 | YES |
| 2 | H2 | PYR, BAR, RUT | 176 (BAR) | 220 | +44 | 240 (S1) | YES |
| 2 | O3 rebreather | HCY, KFB, CU | 118 (HCY) | 220 | +102 | 240 (S1) | YES |
| 2 | C2 cutter | RUT, CU | 6 | 60 | +54 | 45 | YES |
| 2 | L2 floods | RUT, LIM | 44 | 60 | +16 | 45 | placer RUT: YES at 0 m |
| 3 | H3 | ARG, MNN, PYR | 452 (MNN) | 520 | +68 | 240 (S1) -> **needs S2** | S2 inputs are 288 max, reachable? see next row |
| 3 | S2 suit | CHT, BAR, PYR | 288 (CHT) | 520 (H2) | +232 | 240 (S1) | CHT creature is scannable/harvestable from inside the Kite via the arm-mounted collector (section 06.7). YES without leaving the vessel. |
| 3 | L3 floods | PYR, ARG, BAR | 431 (ARG) | 520 | +89 | 950 (S2) | YES |
| 3 | C3 cutter | ARG, PYR, MNN | 452 | 520 | +68 | 950 (S2) | YES |
| 4 | H4 | COB, PHO, ARG | 1060 (PHO) | 1150 | +90 | 950 (S2) | Vessel-assisted: collector arm reaches 1060 with H3. YES |
| 4 | O4 rebreather | HCY, CHT, BAR | 302 (CHT) | 1150 | +848 | 950 | YES |
| 5 | H5 | CLA, PHO, MNN | 1210 (CLA) | 2200 | +990 | 950 | YES (vessel or S2 not needed; collector arm) |
| 5 | L4 floods | COB, TGL, PHO | 2140 (TGL) | 2200 | +60 | 950 -> **needs S3**? | Collector arm from Kite at 2140 with H4 (crush 2200). YES without S3. |
| 6 | S3 suit | AWA, CHT, TGL | 2140 (TGL) | 2200 (H4) | +60 | n/a | YES via collector arm |
| 6 | H6 | AWA, TGL, DIA, COB | 2380 (DIA) | 3600 (H5) | +1220 | 4600 (S3) | YES |
| 6 | L5 photophore bar | PHS, CHT | 1480 (PHS) | 2200 | +720 | 950 | YES |

**Critical dependency this section imposes on section 06 (vessel):** the Kite must carry a **collector arm** with 4.0 m reach and a 12-slot buffer, operable from the pilot seat, capable of cutting (inherits equipped cutter tier) and of harvesting organics from stunned/docile creatures. Without it, tiers 4-6 would require the suit to lead the hull, and the loop would not close. This is a hard requirement.

Second closure check — **the collector arm chain**: the arm requires RUT x4 + CU x6 + KFB x4 (deepest 52 m), craftable at tier 1. It is delivered as a starting blueprint and can be built in the first 20 minutes. It is never lost (G3).

Therefore: for all k, `deepest_required(k) < Dmax(k-1)` with strictly positive margin. Combined with G1-G9, no reachable game state prevents crafting the next tier. **The loop is closed.**

### 08.3.10 Gate summary table (the one an engineer prints and pins up)

| To reach band | Depth (m) | Required | Strongly advised | Materials come from |
|---------------|-----------|----------|------------------|----------------------|
| B0 Home Shoal | 0-40 | nothing | nothing | - |
| B1 Kelp Shelf | 40-150 | H1 | S1, O2 tank, L2 | B0 + placer beach |
| B2 Drift Slope | 150-400 | H2 | O3 rebreather, C2 | B1 (44-160 m) |
| B3 Twilight Fall | 400-900 | H3 | S2, L3, C3 | B2 (168-330 m) |
| B4 The Long Dark | 900-1800 | H4 | O4, L3 | B3 (431-900 m) |
| B5 Rift Walls | 1800-3400 | H5 | L4, S3 | B4 (942-1500 m) |
| B6 Rift Floor | 3400-4400 | H6 | L4 + L5, S3 | B5 (1960-2600 m) |

---

## 08.4 (C) THE OBJECTIVE SYSTEM

### 08.4.1 The Slate

Diegetic wrist device. Rendered as a world-space quad 0.19 m x 0.13 m at 0.42 m from the eye when raised (key `TAB`), and as a windshield-projected panel when piloting (section 07 owns the glass HUD). 4 tabs:

| Tab | Key | Contents |
|-----|-----|----------|
| THREADS | 1 | Soft objective list. Max 6 shown. |
| DATABANK | 2 | 40 entries + 118 catalogue specimens, filterable BIO / GEO / SIG. |
| CHART | 3 | Bathymetric chart, bearings, fixes, beacons. |
| BUILD | 4 | Blueprints and material counts. |

Slate render cost budget: single 512x384 R8G8B8A8 texture, redrawn on change only, <= 0.30 ms CPU per redraw. It is never redrawn per frame.

### 08.4.2 THREADS — the soft objective list

**Rule: there is no hard quest marker anywhere in SUBWAVE, ever, except one the player pins themselves.**

A Thread is one line of the player's own handwriting plus an optional bearing hint. Format:

```
[ ] Rutile veins start around 44 m on the shelf edge.        BRG ~ 118   ~0.4 km
[ ] The interval was 41.60 s. It is now 33.28 s.             --
[ ] Something at 260 m carries the same beat as the first spire.  BRG 171 +/- 9
```

Thread generation rules:

| Trigger | Thread text template | Bearing hint | Auto-closes when |
|---------|----------------------|--------------|------------------|
| Blueprint known, material missing | "Need {N}x {material}. Found at {depth_lo}-{depth_hi} m in {biome}." | biome centroid bearing, +/- 12 deg | material count satisfied |
| Root scanned | "The next one is deeper. Bearing holds at {brg}." | rolling triangulated bearing | next Root scanned |
| Hull crush warning survived | "The Kite complained at {d} m. It needs {next_hull}." | none | hull crafted |
| 5 phase-locked species recorded | "Everything down here is counting the same number." | none | never (permanent note) |
| Fix quality improves to GOOD | "Fix at {x},{z}, +/- {r} m. That is 3 km past anything I can survive." | fix bearing | H-tier reached |

Threads are advisory. Closing a thread gives no reward, plays a 0.4 s pen-scratch, and strikes the line through. Threads never blink, never pulse, never sit on screen during flight.

### 08.4.3 Optional pinning (the only marker in the game)

The player may pin exactly one Thread or one Beacon. A pin renders as:

- A 1.2 deg-wide chevron on the compass ribbon (windshield HUD), opacity 0.55.
- Range text in metres, 1 decimal below 100 m.
- **No world-space icon. No through-geometry outline. No arrow in 3D space.** The chevron lives on the ribbon only.

Pinning is off by default. A settings toggle `assist.pins` defaults to ON for accessibility, and the game does not comment on it either way.

### 08.4.4 Hydrophone triangulation (the core navigation mechanic)

Hardware: 4-element hull array, element spacing 0.42 m, sampling the pulse's 7.1 Hz fundamental. Bearing is resolved from inter-element phase; range is **not** resolvable from a single position. This is real and it is the whole mechanic.

**Taking a bearing:**

| Requirement | Value | Reason |
|-------------|-------|--------|
| Ground speed | < 1.5 m/s | Flow noise |
| Thrusters | idle (< 4% throttle) | Self-noise |
| Hold time | 4.0 s continuous | Coherent integration |
| Player action | hold `H` | |
| Cost | 0 | |

**Bearing error model:**

```js
function bearingSigmaDeg(rangeM, rockChordM) {
  const snr = 46.0 - 20*Math.log10(Math.max(rangeM,1)/1000) - 4.0e-5*rangeM - 0.009*rockChordM;
  return clamp(2.5 + 12.0/Math.max(snr, 0.5), 1.2, 22.0);
}
// Example: R = 9370 m, no rock -> snr = 26.2 dB -> sigma = 2.96 deg
// Example: R = 9370 m, 1400 m of rock chord -> snr = 13.6 dB -> sigma = 3.38 deg  (plus bias, below)
```

Occlusion also introduces a **bias**, not just noise — the ray bends around the shelf break. This is why early bearings taken from the island are systematically 6-9 deg off, and why the fix tightens dramatically once the player is past the shelf break at -400 m. The player discovers this themselves.

```js
biasDeg = sign(cross) * min(9.0, 0.0042 * rockChordM);   // deterministic per position, not random
```

**Taking a fix:** two or more stored bearings are least-squares intersected.

```js
// Each bearing i: origin p_i (x,z), unit direction u_i, weight w_i = 1/sigma_i^2
// Minimise sum_i w_i * dist(point, line_i)^2  -> closed-form 2x2 solve
// Error ellipse from the inverse Hessian, scaled by chi2(0.95, 2) = 5.991
```

| Fix quality | Semi-major axis (m) | Requirements typically met by | Chart display |
|-------------|---------------------|------------------------------|---------------|
| NONE | - | 0 or 1 bearing | single dashed ray |
| COARSE | > 1200 | 2 bearings, baseline < 800 m or cut angle < 20 deg | grey ellipse |
| FAIR | 300 - 1200 | 2 bearings, baseline >= 800 m, cut >= 25 deg | amber ellipse |
| GOOD | 80 - 300 | 3+ bearings, or 2 with baseline >= 2500 m | white ellipse |
| EXACT | < 80 | 4+ bearings from >= 2 depth bands | white cross + coords |

Geometry rules the player will learn without being told:
- Two bearings taken 40 m apart are worthless (baseline too short).
- Two bearings taken along the same line to the source are worthless (cut angle ~0).
- The best fix comes from a wide **lateral** baseline, perpendicular to the source bearing.

The Chart tab draws stored bearings as rays with a shaded +/- sigma wedge, and the current fix ellipse. Max 12 stored bearings, FIFO. Manual delete supported.

**Root sub-signals:** each Root emits at 178 dB SL, which the hydrophone can only bearing-resolve within 2.0 km. Inside 2.0 km the Slate shows a second, thinner ray labelled with the local repeat count (e.g. `x3` if the Root ticks 3 times per master pulse). This gives close-range homing while keeping the master source a long-baseline triangulation problem for the entire campaign.

### 08.4.5 The phase-lock discovery (automatic, no quest)

Every bioluminescent species has a `flashPeriod` field. On scanning, the Slate records it. All flash periods are `P_current / k` for integer `k` in [1..8], and they re-derive live when the master period changes (this is observable and is the point).

```js
// Automatic unlock, no prompt, no marker
if (scannedBiolumSpecies.size >= 5 && allPeriodsAreIntegerSubdivisions()) unlock('SIG-04');
```

Expected trigger time: hour 2.4 +/- 0.6. The entry (SIG-04, full text in 08.5) is the moment the mystery stops being acoustic and becomes biological.

### 08.4.6 Beacons

| Property | Value |
|----------|-------|
| Craft cost | RUT x1, CU x1 |
| Max deployed | 12 |
| Deploy | anywhere, sticks to terrain within 3 m or free-floats with neutral buoyancy |
| Rename | 24 characters, ASCII |
| Colour | 6 presets: white, amber, cyan, magenta, green, red |
| Visible range (compass ribbon) | 4000 m |
| Visible range (world-space point light) | 340 m, 40 lm, 1.1 Hz blink |
| Recovery | swim/fly within 3 m, hold `E` for 0.8 s, refunds 100% |
| Persistence | IndexedDB `subwave.beacons`, per-save |

Beacons are the player's only permitted permanent mark on the world. They are also the only human-made object visible below 400 m. Their blink, seen from 300 m away in total darkness after a two-hour excursion, is the game's one deliberate note of comfort. Do not add more.

---

## 08.5 (D) THE DATABANK

40 narrative entries. Unlock is by scanning, by depth-first-reach, or by automatic derivation. All text is the player's own field notes: terse, dated, present-tense, occasionally slipping.

**Voice rules (binding for any additional writing):**
- Metric, specific, numerals not words. Measurement first, feeling second, never the reverse.
- Never address a reader. Never say "you". The notes are for no one.
- Loneliness is shown by arithmetic, not by adjectives: things counted, things checked twice, things nobody will verify.
- Maximum 6 sentences. Minimum 3 for the 16 full entries.
- No exclamation marks. No questions except rhetorical ones the player answers themselves.
- No sci-fi vocabulary. No "energy signature", "anomaly", "readings are off the charts".

### 08.5.1 Entry index

| ID | Title | Cat | Unlock condition | Depth of subject (m) | Stage available | Full text below |
|----|-------|-----|------------------|----------------------|-----------------|-----------------|
| BIO-01 | Reefgrass Meadow | BIO | scan flora `reefgrass` | 1-14 | S0 | - |
| BIO-02 | Shoal Lanternfry | BIO | scan `lanternfry` | 3-40 | S0 | YES |
| BIO-03 | Plate Crawler | BIO | scan `plate_crawler` | 4-60 | S0 | - |
| BIO-04 | Ribbon Kelp | BIO | scan flora `ribbon_kelp` | 40-160 | S0 | - |
| BIO-05 | Sail-Ray | BIO | scan `sail_ray` | 20-180 | S0 | YES |
| BIO-06 | Glass Sponge Thicket | BIO | scan `glass_sponge` | 150-420 | S1 | - |
| BIO-07 | Drift Bell | BIO | scan `drift_bell` | 180-900 | S2 | YES |
| BIO-08 | Coilworm Field | BIO | scan `coilworm` | 420-1100 | S2 | - |
| BIO-09 | Blue-Blood Crawler | BIO | scan `bb_crawler` | 118-520 | S1 | YES |
| BIO-10 | Pale Gulper | BIO | scan `pale_gulper` | 700-2100 | S3 | - |
| BIO-11 | Lantern-Hunter | BIO | scan `lantern_hunter` | 1400-3200 | S4 | YES |
| BIO-12 | The Drifter | BIO | scan `drifter` (41 m long) | 900-2600 | S4 | YES |
| BIO-13 | Wall-Eyes | BIO | scan `wall_eye_colony` | 2200-3900 | S5 | YES |
| BIO-14 | Pearl-Tube Forest | BIO | scan `pearl_tube` | 3400-4400 | S6 | - |
| GEO-01 | Home Shoal Basalt | GEO | first scan of terrain | 0-40 | S0 | - |
| GEO-02 | The Placer Beach | GEO | sieve 1x RUT | +0.8 | S0 | YES |
| GEO-03 | Ilmenite Veins | GEO | mine 1x RUT vein | 44-340 | S0 | - |
| GEO-04 | The Shelf Break | GEO | reach d > 150 | 150 | S1 | - |
| GEO-05 | Clathrate Pingos | GEO | scan `pingo` | 1210-2400 | S4 | YES |
| GEO-06 | Nodule Plain | GEO | reach d > 900 | 900-1800 | S3 | - |
| GEO-07 | Black Smokers | GEO | scan `smoker_vent` | 1800-3400 | S5 | - |
| GEO-08 | The White Towers | GEO | scan `serpentinite_tower` | 2400-3400 | S5 | YES |
| GEO-09 | Trenchglass Talus | GEO | mine 1x TGL | 2140-4200 | S5 | - |
| GEO-10 | The Throat | GEO | enter shaft, d > 3300 | 3240-4180 | S6 | YES |
| SIG-01 | First Contact | SIG | automatic, t = 0:03 | - | S0 | YES |
| SIG-02 | Bearing Discipline | SIG | take 2nd hydrophone bearing | - | S0 | - |
| SIG-03 | The First Spire | SIG | scan ROOT_1 | -85 | S0 -> S1 | YES |
| SIG-04 | Phase | SIG | 5 biolum species w/ integer subdivisions | - | S1+ | YES |
| SIG-05 | The Second Spire | SIG | scan ROOT_2 | -260 | S1 -> S2 | - |
| SIG-06 | Not Tectonic | SIG | 6 bearings stored, fix >= FAIR | - | S2 | YES |
| SIG-07 | The Third Spire | SIG | scan ROOT_3 | -640 | S2 -> S3 | - |
| SIG-08 | Entrainment | SIG | scan 14 biolum species | - | S3 | YES |
| SIG-09 | The Fourth Spire | SIG | scan ROOT_4 | -1320 | S3 -> S4 | - |
| SIG-10 | The Interval Is Shortening | SIG | period reaches <= 16.64 s | - | S4 | YES |
| SIG-11 | The Fifth Spire | SIG | scan ROOT_5 | -2480 | S4 -> S5 | - |
| SIG-12 | The Sixth Spire | SIG | scan ROOT_6 | -3550 | S5 -> S6 | YES |
| END-01 | The Chamber | SIG | enter Chamber volume | -4180 | FINALE | - |
| END-02 | The Core | SIG | complete 45 s core scan | -4180 | FINALE | YES |
| END-03 | The Bloom | SIG | reach y > -50 during ascent | - | FINALE | - |
| END-04 | Silence | SIG | 300 s after bloomComplete | - | EPILOGUE | YES |

Count: 14 BIO + 10 GEO + 16 SIG/END = **40 entries**. Full flavour text written below for **16**.

### 08.5.2 Full flavour text

---

**BIO-02 — SHOAL LANTERNFRY**
*Scanned d = 11 m. Schools of 60-140.*

Standard length 41 mm, ventral photophores only, no dorsal emission. The light points down, into the water beneath them, which means it is not for me and never was. They flash once every 20.8 seconds, which is a strange number for a fish to choose. Counted a school at dusk and lost the thread somewhere past three hundred. Started again. There is no one to check the arithmetic, so I checked it twice.

---

**BIO-05 — SAIL-RAY**
*Scanned d = 34 m. Disc width 1.9 m.*

Pectoral fins fused into a single dorsal sail, 0.8 m tall, held vertical in the current so the animal is towed rather than swimming. Metabolic cost of transport measured indirectly: it moves 1400 m in a day and beats its fins fewer than 200 times. It is the laziest large animal I have ever met and it has outlived every design I could have drawn for it. Followed one for forty minutes because the current was going my way too.

---

**BIO-07 — DRIFT BELL**
*Scanned d = 340 m. Colony length 8.6 m.*

Not one animal. Between 900 and 1200 zooids, each a specialist: some only swim, some only eat, some only reproduce, and none of them can survive being separated from the rest by more than about an hour. The colony flashes blue-green at 486 nm every 6.93 seconds, all zooids at once, with a synchronisation error under 40 milliseconds along its whole length. Nothing in it is in charge. I have watched three hundred separate creatures agree on when to shine, without a single one of them knowing that it is doing so.

---

**BIO-09 — BLUE-BLOOD CRAWLER**
*Scanned d = 210 m. Carapace 0.4 m.*

Haemocyanin, not haemoglobin: copper-based, so the haemolymph is colourless when deoxygenated and turns blue in air. Oxygen affinity is 4.1x higher than mine at 4 degrees and 20 atmospheres, which is the entire reason this animal can be here and I cannot. Extracted 40 mL from a moulted individual - the moult was already dead, I want that written down - and ran it through the scrubber column. It works. I am going to go deeper on borrowed chemistry from an animal that has never needed to go up.

---

**BIO-11 — LANTERN-HUNTER**
*Scanned d = 2100 m. Length 3.4 m.*

Illicium bears a single photophore, 4200 lumens, emitted in 0.4 s bursts every 4.16 seconds. That is the shortest interval I have measured in any organism and it is exactly one quarter of the current beat, which was one sixth of it a week ago. It hunts by looking like a small honest thing in an ocean where nothing else is small or honest. It came within 9 m of the canopy and matched my flood lamps in colour temperature within about 200 kelvin, which I would like to believe was a coincidence. I turned my lights off. It waited eleven minutes.

---

**BIO-12 — THE DRIFTER**
*Scanned d = 1680 m. Total length 41.2 m.*

Filter-feeding, no teeth, no eyes worth the name - two pale spots that resolve light and nothing else. It passed above me at 30 m and I lost the sky. Not metaphorically: the animal was wide enough that my lamps found no edge in any direction for eleven seconds, and I sat in its shadow at 1680 m and could not tell whether I was looking at an animal or at the ceiling of the world. It hums at 14.2 Hz, and once in every four beats of the big signal it hums back. I do not think it is answering. I think it is keeping time, the way I hum when I am counting.

---

**BIO-13 — WALL-EYES**
*Scanned d = 2900 m. Colony, indeterminate extent.*

Sessile, epilithic, 8-11 mm apertures spaced 40-60 mm across the rock. Under my lamps they open. Not toward me - all of them open at once, across every square metre the beam touches, and they close again 1.9 seconds after the light moves on. Swept the wall for 200 m and the wall opened and closed behind me like a page turning. They are almost certainly photoreceptive filter organs with a light-triggered feeding response and there is a perfectly ordinary paper in this. I flew back to the Kite anyway.

---

**GEO-02 — THE PLACER BEACH**
*Surveyed. 340 m^2, above sea level.*

Black sand, heavy minerals concentrated by wave action: ilmenite, rutile, a little zircon. The waves have been doing my ore processing for an unknown number of centuries and asking nothing. Sieved 1.1 kg by hand in twenty minutes and got enough titanium to brace a hull. It is the only place on this planet where the thing I need is simply lying on the ground, and I have decided not to take that for granted.

---

**GEO-05 — CLATHRATE PINGOS**
*Scanned d = 1410 m. Mound height 22 m, diameter 90 m.*

Methane hydrate: gas locked in a cage of water ice, stable only because it is cold and deep. The mounds bleed slowly - a stream of bubbles from the flank, each one expanding as it rises, most of them dissolving before 600 m. Cut a 40 cm core and it fizzed in my hand at 4 degrees. This is a thing that is only solid because of where it is, and the moment it is anywhere else it stops being itself, which is a sentence I should probably not have written down.

---

**GEO-08 — THE WHITE TOWERS**
*Scanned d = 2740 m. Tallest measured 61 m.*

Not volcanic. Seawater reacts with mantle rock, serpentinisation, and the fluid comes out at 78 degrees, pH 10.9, alkaline instead of acid, and precipitates carbonate towers the colour of bone. No magma anywhere near this. The rock is making the chemistry, and the chemistry is making hydrogen and methane, and things are eating it - I counted eleven species on one tower and nine of them were new. There is life here that has never once used the sun, does not know the sun exists, and would not care. It is the least lonely place I have found and there is nothing here that has a face.

---

**GEO-10 — THE THROAT**
*Entered at d = 3240 m. Shaft depth 940 m, mean bore 210 m.*

A vertical shaft in the trench floor, walls of banded calcite in growth layers 3-8 mm thick, like an ice core or a tree. Counted 4,100 bands in the first 30 m of wall. If each band is a year that is a hundred and twenty thousand years of something breathing in the same place, and if each band is a beat it is nothing at all. Albedo measured at 0.03: it eats my lamps. Forty-one thousand lumens go in and the wall gives me back a grey suggestion of itself at 20 m, and beneath me the shaft goes down further than my lights can go down.

---

**SIG-01 — FIRST CONTACT**
*Buoy hydrophone, 04:12 local, day 1.*

Infrasound. Fundamental 7.1 Hz, odd harmonics to the seventh, envelope 3.1 seconds. Repeat interval 41.60 seconds, and the error across eleven repeats is 0.02 seconds. Bearing 171 degrees, plus or minus four. Tectonic sources do not keep time to two decimal places. I have listened to it for four hours and I have written *not tectonic* six times in this file.

---

**SIG-03 — THE FIRST SPIRE**
*Scanned d = 85 m. Height 31 m, basal diameter 8.4 m.*

Calcite. Growing out of ordinary shelf basalt with no vent under it, no fluid supply I can find, no reason. It is warm - 14.2 degrees against 11.6 ambient - and warmth without a heat source is a claim I would not put in a paper. It ticks. Three ticks for every one that comes up the bearing from the south, phase-locked to within a tenth of a second. I put my glove flat against it and felt the beat go up my arm and stop at the elbow, which is where the suit ends and I begin.

---

**SIG-04 — PHASE**
*Derived from 5 species. No new observation required.*

The lanternfry flash every 20.8 seconds. The drift bells every 6.93. The shelf urchins every 41.6, the coilworms every 13.87, the small red squid every 5.94. I did not notice for two days because I was recording them in different files. Every one of those numbers is the master interval divided by a whole number: two, six, one, three, seven. Nothing down here has agreed on a colour, a body plan, or a way of eating, and all of it has agreed on when.

---

**SIG-06 — NOT TECTONIC**
*Six bearings. Fix FAIR, semi-major 640 m.*

The rays cross at 9.4 kilometres on a heading of 171, in the middle of a trench with a charted floor at 4180 metres. My hull is rated for 520. Ran the elimination properly this time: not tidal (wrong period, and it ignores the moon), not volcanic (no thermal, no seismic, no gas), not ice (there is no ice), not tectonic (tectonics do not have a standard deviation of 0.02 seconds). What is left is that something with a body is doing this on purpose or as a consequence of being alive, and I do not know which of those is worse.

---

**SIG-08 — ENTRAINMENT**
*14 species. All phase-locked.*

Fourteen out of fourteen. Every luminous organism I have catalogued, from three metres to two thousand eight hundred, across six phyla that have not shared an ancestor in half a billion years, flashing on integer subdivisions of a signal that comes from a hole in the seafloor. On my planet the tides entrain the reefs and the sun entrains everything else. Here the sun gets the top hundred metres and something else gets the rest. I have stopped writing *the signal* in these notes. I have started writing *it*, and I noticed, and I have not gone back to correct it.

---

**SIG-10 — THE INTERVAL IS SHORTENING**
*Master period now 16.64 s. Was 41.60 s on day 1.*

I assumed drift. I assumed my clock. I replaced the clock, checked it against the star transits, and the star transits are fine. Over eleven days the interval has gone from 41.60 to 16.64 seconds, and every value it has passed through has been an exact multiple of 4.16. It is not slowing down or wandering. It is stepping down a ladder, and there are only three rungs left below where it is now. Something that has kept the same beat for as long as this rock has had banded walls has started counting faster, and I am nine kilometres away in a hull rated for a fifth of the depth.

---

**SIG-12 — THE SIXTH SPIRE**
*Scanned d = 3550 m. Height 240 m.*

Same calcite, same growth banding, same 8.4 metre ratio of height to base, scaled up eight times. I went back through the scans of all six tonight and ran the isotope ratios side by side. They are not six organisms. They are six places where one organism comes up through the floor to touch the water, spaced 1.5 to 1.9 kilometres apart along a line that runs from the shelf where I found the first one to the hole where the signal comes from. I have been climbing down the arm of something for eleven days, taking careful notes on the fingers.

---

**END-02 — THE CORE**
*Scan complete, 45 s hold, d = 4180 m.*

Twenty-two square kilometres of pearl-tube, one continuous tissue, one genome, no edge that I can find in any direction my lamps reach. It is not a brain and there is nothing in it that could think. It is a colony with a chemistry that runs on hydrogen from the rock, and the beat is a contraction - the whole mass squeezes and the water moves and the sound goes out to sea and up my spine. The growth bands say it has been doing this at 41.6 seconds for a hundred and twenty thousand years. It is doing it now at 4.16, and the tubes are swollen, and every one of them is full.

---

**END-04 — SILENCE**
*Day 14. Surface. 300 s after.*

The hydrophone is clean. No fundamental at 7.1, no harmonics, nothing above the noise floor at any bearing, and I have swept all 360 degrees twice at 0.5 degree steps. It went out at 03:41 and it has not come back. The whole ocean is lit from below to the horizon and there are juveniles in the reefgrass outside the window that were not in any of my counts. I have been alone here since the first day and I did not feel it until the noise stopped. Whatever comes back to that trench to start counting again, it will be a very long time from now, and there will be no one here to write it down.

---

### 08.5.3 Databank presentation rules

| Rule | Value |
|------|-------|
| Reveal animation | Handwriting draw-on, 34 chars/s, skippable with any key |
| Audio on unlock | Pen scratch, 0.6 s, -22 dBFS. Nothing else. No sting, no chime, no music cue. |
| Notification | Single line, bottom-left, 3.2 s, 0.40 opacity: `NOTE FILED - SIG-04` |
| Entries during flight | Never auto-open. Queued and filed silently. |
| Re-read | Always available, always identical. Notes are never rewritten or expanded retroactively except END-04. |
| Localisation | ASCII only in v1. |

---

## 08.6 (E) THE DREAD ESCALATION SCHEDULE

Dread is engineered on four independent axes so it never reads as one trick:

| Axis | Instrument | Ramp |
|------|-----------|------|
| ACOUSTIC | Pre-pulse silence gap (08.2.3) | 0 s at 600 m -> 6.0 s at 3200 m |
| OPTICAL | Ambient irradiance and lamp reach vs. void size | full sun -> zero, room-scale -> 1600 m walls |
| SCALE | Largest object in frame | 1.9 m sail-ray -> 41 m Drifter -> 22 km^2 organism |
| SOCIAL | Number of things that are aware of you | 0 -> ambiguous -> a wall that opens |

**Non-negotiable dread rules:**
- No jump scare uses a loud transient alone. Every scare has a 2-5 s approach the player can notice.
- Nothing may attack the player from directly behind without a prior audio cue in the same 8 s window.
- Predator encounters are survivable by retreat 100% of the time. Retreat is always geometrically possible.
- There are exactly **2** creatures in the game that can kill the player (Pale Gulper, Lantern-Hunter). Everything else is dread without teeth, which is stronger.
- Zero music during the first hostile encounter of any species. Silence, then the animal.

### 08.6.1 Beat sheet

| Hour | Depth | Beat | Kind | Mechanic | Audio |
|------|-------|------|------|----------|-------|
| 0:03 | 0 | First pulse felt through the deck. | wonder | haptic + camera 0.9 mm | 56.8 Hz heterodyne, -14 dBFS |
| 0:20 | -18 | Realising the reef is completely safe. Nothing chases. | relief | zero hostile spawn radius 900 m | full reef bioacoustics, dawn birds |
| 0:41 | -85 | R1 found. It is warm. It ticks 3:1. | wonder | proximity 14 m -> haptic | Root local tick, 178 dB SL |
| 1:10 | -120 | First night dive. Ambient drops to 0.014. Lamps become the world. | isolation | day/night, L2 required | wind gone, only regulator |
| 1:40 | -150 | The shelf break. Terrain simply ends and the floor is 900 m below. | vertigo | no floor within lamp range | low-frequency wall reverb, RT60 3.1 s |
| 2:10 | -260 | R2. It is bigger. Same ratio. | pattern | scan | tick x2 |
| 2:24 | any | SIG-04 PHASE files itself while the player is doing something else entirely. | dawning | automatic | pen scratch only |
| 2:50 | -300 | First pre-pulse silence noticed (gap 1.4 s). Everything stops. Then the beat. | dread | 08.2.3 | ambient duck to 0.02 |
| 3:20 | -420 | First Drift Bell colony, 8.6 m, 900 zooids flashing as one. | awe | scan | 486 nm, 6.93 s |
| 3:40 | -640 | R3. Fix improves to GOOD past the shelf break; the ellipse collapses onto the trench. | resolve | triangulation | - |
| 4:10 | -700 | **Pale Gulper, first hostile.** Telegraph: 4.2 s of jaw-click at 1.1 Hz before any approach. | fear | damage 22 HP/bite, retreat always possible | no music |
| 4:40 | -900 | Ambient hits zero. The HUD ambient bar reads 0.00 for the first time and stays there for the rest of the game. | threshold | renderer clamp | hull tick, 0.4 Hz |
| 5:20 | -1320 | R4. 96 m tall. The player can no longer light the whole thing. | scale | - | tick x1 (parity with master) |
| 5:50 | -1500 | Marine snow density peaks at 1.4 particles/L. Lamp range halves. Claustrophobia inside infinite space. | oppression | scattering | soft hiss |
| 6:20 | -1680 | **THE DRIFTER.** 41 m. Passes overhead, occludes everything, 11 s of no edge in any direction. Non-hostile. Never attacks. | awe/terror | scripted first pass, then free roam | 14.2 Hz hum, sub only |
| 6:50 | -1800 | The Rift Walls. Two walls 4.4 km apart, floor not visible. The player's chart shows a hole. | vertigo | - | - |
| 7:10 | -2100 | **Lantern-Hunter.** It matches your flood colour temperature within 200 K. If you kill your lights it waits. | fear | AI: lure state 11 min, patience | one 0.4 s burst per 4.16 s |
| 7:30 | -2480 | R5. 160 m. | - | - | - |
| 7:50 | -2740 | The White Towers. 61 m of bone-coloured carbonate, alkaline, 11 species, 9 new. Beautiful, safe, no threat at all. | relief | - | fluid hiss, 78 C plume |
| 8:20 | -2900 | **WALL-EYES.** The rock opens where your beam lands, closes 1.9 s behind you, for 200 m. | pure dread | shader + sim, zero damage | no sound at all |
| 8:50 | -3200 | Pre-pulse silence is now 6.0 s. Six seconds of nothing but your own breathing, every 8.32 seconds. | attrition | 08.2.3 | - |
| 9:00 | -3550 | R6. 240 m. SIG-12: it is one organism and you have been climbing down its arm. | revelation | - | tick x1 |
| 9:20 | -3240 | The Throat. Albedo 0.03. 41,000 lumens return a grey suggestion. | commitment | - | RT60 8.4 s |
| 9:35 | -4180 | The Chamber. | see 08.7 | | |

### 08.6.2 Anti-fatigue governor

Dread saturates. The schedule enforces recovery:

```js
// A "relief window" must occur within 14 minutes of any dread beat of weight >= 3.
// Relief = safe biome, upward light, no hostiles, distinct ambient.
DREAD_WEIGHT = { wonder:0, relief:-2, vertigo:2, dread:3, fear:4, awe:1, oppression:3 };
if (rollingDread(14*60) > 9) forceReliefBiomeInNextChunk();
```

Guaranteed relief locations by band: B1 kelp light shafts; B2 glass sponge terrace (bright, white, cathedral); B3 brine pool surface (a lake at the bottom of the sea, mirror ceiling); B4 clathrate pingo bubble curtain; B5 the White Towers; B6 the pearl-tube forest.

---

## 08.7 (F) THE ENDING

### 08.7.1 What is at the bottom

**THE HOLDFAST.** A single chemolithoautotrophic colonial organism occupying 22.4 km^2 of the Aphotic Rift floor between -3980 m and -4260 m. One genome, one continuous tissue. Its body is a forest of aragonite-sheathed tubes ("pearl-tube") 4-40 m tall, rooted in serpentinite. It runs on hydrogen and methane produced abiotically by the rock itself (see GEO-08); it has never used sunlight and contains no organ that could be called a brain.

It is not a monster, not a god, not intelligent, and it does not know the player exists.

**The pulse is a contraction.** The whole mass squeezes on a cycle, displacing roughly 3.1e6 m^3 of water per beat and radiating 7.1 Hz infrasound at 214 dB re 1 uPa @ 1 m. That contraction has run at 41.60 s for approximately 120,000 years — the growth bands in the Throat wall record it.

**The Roots are its rhizoids.** Six places where the same organism surfaces through the crust between the shelf and the trench, from -85 m to -3550 m. Same genome, same isotope signature, same 3.69 height-to-base ratio at every scale.

**The countdown is a spawning.** The Holdfast reproduces once per approximately 700 years. In the terminal phase the contraction accelerates by halving steps; the tubes fill with buoyant propagules; and then the whole 22.4 km^2 releases at once. The entire ocean's bioluminescent life is entrained to the beat (SIG-08) because their own reproductive and feeding cycles evolved on top of it — the Holdfast is the ocean's clock, and the clock is about to ring.

The player arrived in the last two weeks of a 700-year cycle. Nothing arranged this. That is the point.

### 08.7.2 The finale — playable beat structure

Total runtime 19-24 minutes. Fully playable throughout; **zero non-interactive cutscenes**. Camera is never taken from the player. There is one 3.0 s control-damping moment (F4-b) and nothing else.

| Act | Name | Duration | Player verb | Fail state |
|-----|------|----------|-------------|------------|
| F1 | The Throat | 3-5 min | Pilot a 940 m vertical shaft, 210 m bore | Hull damage only, no death |
| F2 | The Chamber | 2-3 min | Free flight, look, descend 700 m | none |
| F3 | The Core Scan | 45 s + approach | Hold scan within 30 m | none (scan restarts) |
| F4 | Terminal Phase | 90 s | Retreat 400 m, survive pressure pulses | none (integrity floors at 40%) |
| F5 | The Column | 11-13 min | Ascend 4180 m riding an upwelling | none |
| F6 | Surface | 2-4 min | Free flight at night over a lit ocean | none |
| EP | Epilogue | persistent | anything | none |

**There is no fail state in the entire finale.** The Holdfast is not hostile; it is not aware. Turning the ending into a boss fight would betray axioms A6 and A7. The tension is scale, dark, and irreversibility.

#### F1 — THE THROAT

| Trigger | `depth > 3300 && insideShaftVolume` |
|---------|--------------------------------------|

- Shaft: 940 m deep, mean bore 210 m, walls banded calcite, albedo 0.03, mean inclination 4.1 deg.
- Three constrictions at -3520 m (bore 96 m), -3810 m (bore 64 m), -4020 m (bore 41 m). Kite max dimension 6.8 m — always passable, never a puzzle, always tight enough to feel it.
- Master period is 8.32 s (S6). Every pulse: camera translation 2.4 mm at 2.4 Hz, hull integrity -0.4% capped at a 40% floor, and 340 kg of calcite flour shakes off the walls (particle burst, 4200 particles, 6 s lifetime) — the shaft *smokes* on the beat.
- HUD: only depth, integrity, and O2 remain readable; the compass ribbon is suppressed below -3400 m (`magnetic reference lost` — serpentinite is strongly magnetic, this is real). **The player loses their compass for the rest of the descent.**
- Audio: RT60 8.4 s. Every lamp click, every thruster burst, comes back 8 seconds later from below.
- On entering: unlocks GEO-10.

#### F2 — THE CHAMBER

| Trigger | `depth > 4020 && exitedShaftBottom` -> sets `enteredChamber = true`, `stage = FINALE`, period -> 4.16 s |
|---------|------------------------------------------------------------------------------------------------------|

- The shaft opens into a cavity 4.2 km across, roof at -3960 m, floor at -4260 m. It is not a room; it is the sky, inverted.
- **First light is not the player's.** On entry, the floor's ambient emission ramps from 0.000 to 0.021 cd/m^2 over 40 s, 486 nm. The player's 41,000 lumen floods become irrelevant. Turning them off is the natural instinct and the correct one. There is no prompt.
- Visible extent at that luminance: approximately 900 m of pearl-tube forest in every direction, receding into blue.
- **The chamber breathes.** On every 4.16 s beat, a vertex displacement wave crosses the floor: amplitude 1.2% of local tube height, phase velocity 340 m/s radial from the core, visible as a light-ripple because the emission is strain-coupled (`emission *= 1 + 0.6*strain`).
- The player descends 700 m to the floor at their own pace. No timer. No marker. The core is found by following the light gradient, which increases monotonically toward (+1450, -4180, +9260).
- On entry: unlocks END-01.

#### F3 — THE CORE SCAN

| Trigger | Player within 30.0 m of core centre, scanner held, 45.0 s cumulative (resets if range > 40 m for > 3 s) |
|---------|---------------------------------------------------------------------------------------------------------|

- The core is a 340 m diameter dome of fused tube, emission 0.34 cd/m^2, surface visibly translucent with propagule mass moving inside it (screen-space subsurface scattering, 3 octaves of flow noise, 0.06 m/s drift).
- During the 45 s hold, exactly 10.8 pulses occur. The scan progress bar and the pulse are deliberately not synchronised — the player will notice they are drifting against each other, which is uncomfortable and correct.
- Hull integrity drains 0.4% per pulse to the 40% floor. Warning tone plays. **It cannot kill.** A player who does not know that will be terrified, which is the design.
- At 45.0 s: scan completes. **END-02 files itself.** The player reads it while sitting inside the thing it describes.
- 6.0 s after END-02 is filed, F4 begins automatically.

#### F4 — TERMINAL PHASE

| Trigger | `end02Filed && t + 6.0 s` |
|---------|----------------------------|

Exact beat sequence, times relative to F4 start:

| t (s) | Event | Numbers |
|-------|-------|---------|
| 0.0 | Period halves to 2.08 s. | `pulsePeriod` override, stage FINALE-B |
| 8.3 | Period halves to 1.04 s. Individual pulses stop being events and become a rhythm. | |
| 16.6 | Period 0.52 s. The infrasound fundamental and the pulse rate begin to merge perceptually. | |
| 20.8 | **Fusion.** Discrete pulses become a continuous 1.92 Hz tremor with the 7.1 Hz carrier fully exposed. Heterodyne is switched off - the player hears the true infrasound as a body sensation and near-silence. | |
| 20.8 - 24.0 | (F4-b) The only control-damping in the game: pilot input authority scales 1.0 -> 0.35 -> 1.0 over 3.0 s as the pressure wave passes. Player is never locked out. | |
| 24.0 | Emission across the whole chamber rises 0.021 -> 1.9 cd/m^2 over 22 s. The floor becomes brighter than the player's floods by a factor of 40. | |
| 46.0 | **Release.** Every tube in 22.4 km^2 opens. Propagule cloud: 1.1e6 GPU particles, 486 nm + 512 nm, initial vertical velocity 3.1 m/s, buoyancy-driven acceleration 0.04 m/s^2 to terminal 6.2 m/s. | |
| 46.0 | Upwelling field switches on: `v_up(r) = 6.2 * exp(-r/1800) m/s` centred on the core, extending to the surface as a 3.6 km diameter column. | |
| 52.0 | Sound: the tremor stops. Replaced by broadband hiss at 42 dB SPL - a billion tubes venting. It is the loudest the game ever gets and it is soft. | |
| 60.0 | HUD writes one line, unprompted, in the player's handwriting: `ASCEND.` It is the only imperative in the entire game. | |
| 90.0 | F5 begins (F5 is not gated; the player may already be ascending). | |

Design note: the player is a witness, never a cause. Nothing the player did triggered the spawning. If the player had never come, this happens anyway, at the same second, and nothing records it.

#### F5 — THE COLUMN

The emotional payload of the entire game: an 11-13 minute ascent back through every biome, all of them transformed.

| Property | Value |
|----------|-------|
| Distance | 4180 m |
| Upwelling assist | `6.2 * exp(-r/1800)` m/s where r = horizontal distance from column axis |
| Kite max ascent with assist | 14.6 m/s |
| Bloom front rise rate | 6.2 m/s |
| Player-vs-front | Player is faster. Staying *in* the front is a choice; outrunning it is a choice. Neither is punished. |
| Hull | Integrity restores at 1.1%/s once above -3400 m (the Kite is rated for shallower water; this is just crush relief) |
| Compass | Returns at -3400 m with a 4.1 s re-lock animation |

**Per-band transformation on the way up** (each band the player passes is permanently rewritten in the save):

| Band | Depth | What the ascent shows |
|------|-------|------------------------|
| B6 | 4180-3400 | The Throat is a chimney of light, 940 m of rising propagules. The banded walls are lit from inside the column. |
| B5 | 3400-1800 | The Wall-Eyes are **all open**, every one, for kilometres, and they do not close. The White Towers glow from base to tip. |
| B4 | 1800-900 | **The Drifters.** Between 4 and 7 of them, 41 m each, rising inside the column with mouths open, feeding. The player flies through a herd of the animal that terrified them at hour 6. |
| B3 | 900-400 | Coilworm fields have released too - a second, smaller bloom, red-shifted 620 nm, mixing with the blue. |
| B2 | 400-150 | The glass sponge terraces refract the column into caustics across 300 m of wall. |
| B1 | 150-40 | Every lanternfry school in the shelf is flashing at 4.16 s - they have re-entrained to the new interval within minutes. Millions of them. |
| B0 | 40-0 | The reef at home, from below, backlit. |

On crossing `y > -50`: **END-03 files itself.**

#### F6 — SURFACE

| Trigger | `y > 0 && verticalSpeed > 0` |
|---------|------------------------------|

- Forced world time: the game sets local time to 02:10 (night) at the start of F4 so the breach happens in darkness. This is the only time the clock is ever set by script; it is done 12 minutes early so the transition is imperceptible.
- The ocean is lit to the horizon from below. Sea surface emission 0.9 cd/m^2, falling to 0.2 over the following 20 in-world minutes.
- Propagules leave the water: a fine aerosol of buoyant gas-vesicle spores rising to ~40 m, giving the air itself a faint glow. The Kite flies through it.
- Free flight. No timer, no marker, no prompt. The player may fly for as long as they want, land anywhere, or return to base.
- `bloomComplete = true` is set on breach.
- **The pulse does not return.** From this second, `pulsePeriod` returns `Infinity`. The hydrophone reads noise floor at every bearing, forever, in this save.

#### EPILOGUE

| Trigger | `bloomComplete && (t_since_breach > 300 s)` |
|---------|---------------------------------------------|

- **END-04 SILENCE** files itself. Full text in 08.5.2. It is the last thing written in the game.
- No credits roll is forced. The credits are available from the pause menu at all times, before and after, as a Slate tab. A player who wants to keep flying is never interrupted.
- Autosave to a distinct slot `<save>_post_bloom`, so the pre-ending state is preserved if the player wants it.

### 08.7.3 Permanent post-bloom world state

The ending changes the world in the save file. This is the reward for finishing, and it is the reason free-roam has value.

| Change | Value | Persisted key |
|--------|-------|---------------|
| Hydrophone signal | absent, all bearings, forever | `world.pulseSilenced = true` |
| Sea surface glow | 0.20 cd/m^2 permanent (down from 0.9 at breach) | `world.surfaceGlow` |
| Juvenile fauna | +1 juvenile variant per species for 14 of 78 species, spawning in B0-B2 at 0.4x adult density | `world.juvenilesActive` |
| Plankton bioluminescence | wake-triggered surface bioluminescence: swimming or flying low leaves a glowing trail, 4.2 s decay | `world.planktonBloom` |
| Pearl-tube forest | tubes now spent and translucent, emission 0.08 cd/m^2, still standing | `world.holdfastSpent` |
| Wall-Eyes | remain permanently open. The wall no longer closes behind you. | `world.walleyesOpen` |
| Roots | still warm (14.2 C), now silent | - |
| BIO-14 variant | new catalogue entries for 14 juveniles (catalogue max rises 118 -> 132) | `catalogue.maxEntries` |
| Databank | END-04 present; all entries readable | - |

---

## 08.8 (G) OPTIONAL CONTENT

### 08.8.1 Secrets

None of these are required, hinted by a Thread, or marked on the chart. All are found by looking.

| ID | Name | Location | Depth (m) | Discovery condition | Reward |
|----|------|----------|-----------|---------------------|--------|
| SEC-01 | The Mirror Lake | Brine pool, B3 | -680 | Fly the Kite *into* the brine pool (density 1180 kg/m^3, the Kite floats on it) | Catalogue: brine-pool chemosynthetic mat. A lake with a ceiling. |
| SEC-02 | The Nursery | Sealed lava tube, B2 | -310 | Cut a 1.4 m calcite plug (Mohs 3, C1 works) | 1400 juvenile sail-rays, no adults. Photo-mode showpiece. |
| SEC-03 | The Fossil Reef | Uplifted block, B4 | -1140 | Scan any of 6 exposed sections | GEO bonus entry: this reef grew in sunlight 40 My ago and is now 1.1 km down |
| SEC-04 | The Quiet Circle | Abyssal plain, B4 | -1620 | Radius 90 m where no creature enters and no snow falls | Never explained. No entry. No reward. It is just there. |
| SEC-05 | Root Zero | Home shoal | -4 | Scan the "rock" the base is built on | It is calcite. Height 6 m, ratio 3.69. **The base was built on a seventh Root.** Files a special entry, no gameplay effect. |
| SEC-06 | The Long Fall | Rift wall, B5 | -1800 to -3400 | Descend 1600 m without touching wall or floor, continuously | Achievement + a catalogue photo slot |
| SEC-07 | The Chorus | Any 3 Roots within 90 s | varies | Physically impossible without H5 and full throttle | All three ticks audible at once, phase-beating. Audio-only reward. |

SEC-05 deserves emphasis: the safe home base sits on a Root the whole time. The player passes it every session for ten hours. It is scannable from hour zero. Almost nobody scans it.

### 08.8.2 Rare creature sightings

Ambient, unmarked, non-repeating within a session.

| Species | Band | Sighting probability | Window | Duration | Notes |
|---------|------|----------------------|--------|----------|-------|
| Pale Drifter (albino, 47 m) | B4 | 0.018 per hour in band | night only | 220 s | Catalogue variant |
| Spiral Bloom (siphonophore, 118 m chain) | B3 | 0.031 per hour | any | 480 s | Longest organism in the game |
| Ghost Ray (transparent sail-ray) | B1 | 0.044 per hour | dawn/dusk | 160 s | Only visible against lit water |
| The Rasp (unseen, audio only) | B5 | 0.012 per hour | any | 40 s | Never rendered. Never explained. No catalogue entry exists for it, and the Slate shows an empty slot at index 79. |
| Vent Swarm (2400 shrimp analogues) | B5 | 0.090 per hour near smokers | any | 300 s | |
| Falling Star (dying jelly, 4.1 m, sinks glowing) | B2-B4 | 0.026 per hour | night | 900 s | Sinks 0.9 m/s, can be followed all the way down |

Empty catalogue slot 79 for The Rasp is deliberate and is never filled by any means. Do not add a way to fill it.

### 08.8.3 Photo mode

| Property | Value |
|----------|-------|
| Key | `P` |
| Availability | Everywhere including the finale and while dead-drifting |
| Camera | Free, tethered to a 25.0 m sphere around the player |
| Time | Paused (`timeScale = 0`), except pulse light animation continues at 0.15x for framing |
| Controls | FOV 18-95 deg, roll +/- 45 deg, focus distance 0.4-800 m, aperture f/1.2-f/22 |
| Effects | Physical DOF (bokeh, 6-blade), exposure -4..+4 EV, film grain 0-0.6, vignette 0-0.8, chromatic 0-1.0 |
| Grid overlays | none / thirds / golden / horizon-level |
| Hide | HUD, vessel, player, particles, individually toggleable |
| Resolution | Render at 3840x2160 regardless of window size, via a dedicated offscreen pass |
| Format | PNG via `canvas.toBlob`, quality 1.0, ~2.4 MB typical |
| Storage | IndexedDB store `subwave.photos`, cap 200 images / 600 MB, FIFO with pin-protect |
| Metadata embedded | depth (m), heading (deg), local time, biome ID, species in frame, save seed |
| Gallery | Slate tab 5, unlocked after first photo |
| Perf | Photo mode may drop to 12 fps while composing at 4K; acceptable, it is paused |

Catalogue integration: 44 of the 118 species have a **portrait slot** filled by the player's own best photo of that species. Auto-selection: highest score by `(pixels_covered * sharpness * centrality)`, overridable manually.

### 08.8.4 Specimen catalogue

| Category | Count (pre-bloom) | Count (post-bloom) |
|----------|-------------------|--------------------|
| Fauna | 78 (slot 79 permanently empty) | 92 |
| Flora / sessile | 22 | 22 |
| Minerals | 18 | 18 |
| **Total** | **118** | **132** |

Per-entry fields recorded on scan: binomial (player-coined, procedurally assembled from a Latin-root table so it is stable per seed), standard length, mass estimate, depth range observed, first-seen timestamp, flash period if bioluminescent, behaviour tags, and the portrait photo.

Completion tiers (cosmetic only, no gameplay gates):

| Tier | Threshold | Reward |
|------|-----------|--------|
| Surveyor | 30 entries | Slate frame changes from plain to brass |
| Naturalist | 60 entries | Chart tab gains species-density overlay |
| Cartographer | 90 entries | Bathymetric chart auto-fills within 400 m of any visited point |
| Complete Record | 117/118 (79 is empty) | Slate cover records a single line: `117. There is one I only ever heard.` |

There is no 118/118. Do not implement one.

### 08.8.5 Free roam and NG+

**Free roam (post-ending, same save):** default. World state per 08.7.3. All upgrades retained. All beacons retained. Photos retained. No content is removed. The trench remains open and the Chamber is enterable forever.

**NG+ — "SECOND DESCENT":**

| Property | Value |
|----------|-------|
| Carried over | Databank text (marked as *previous descent*), catalogue completion, photo gallery, discovered species names |
| Reset | All upgrades to tier 0, all materials, all beacons, all threads |
| World | New seed. New island position, new biome layout, new Root positions, new trench bearing. |
| Signal | Starts at S0 period 41.60 s but the clock ramp is 1.4x faster (halves every 6.4 in-world days) |
| New | 4 additional rare sightings, 2 additional secrets, and the Roots number **seven** instead of six |
| Modifier: Quiet Run | Optional. Hydrophone disabled entirely. The player must find the trench by bathymetry and by watching which way the fish are counting. |
| Modifier: Long Night | Optional. Day length 4x (80 real min), so night dives dominate. |
| Modifier: Fragile | Optional. All hull crush depths x0.75. No other change. |
| Modifiers are independent | Any combination. No achievement is gated on them. |

---

## 08.9 (H) PACING TABLE

| Hours | Depth worked | What the player is DOING | What the player is FEELING | What unlocks | Threads open | Entries filed |
|-------|--------------|--------------------------|----------------------------|--------------|--------------|---------------|
| 0-1 | 0 to -85 | Walk the island. Find the placer beach and sieve rutile by hand. Board the Kite. Fly it (it flies!). Dive it (it dives!). Cross the surface. Learn that nothing here wants to hurt them. Hear the pulse three times. Find R1 by following the bearing 3 km south. | Safety, then curiosity, then the first small cold feeling when the second pulse arrives exactly on time. Delight at the vessel - the flight-to-dive transition is the mechanical hook and it must land in the first 10 minutes. | Collector arm, Beacon, Tank Mk2, H1 Braced Hull (220 m), L2 Floods, C2 Cutter, S1 Reinforced Skin | 3-4 | 6-9 (BIO-01/02/03, GEO-01/02/03, SIG-01/02/03) |
| 1-3 | -85 to -400 | First night dive. Cross the shelf break and see the floor disappear. Farm barite and pyrrhite on the drift slope. Build the rebreather and discover that depth stops mattering for oxygen. Take bearings from two widely separated points and get a FAIR fix that lands in a trench 4180 m deep. | Competence, then unease. The shelf break is the first vertigo. SIG-04 PHASE files itself around 2:24 while they are doing something mundane, and the game changes character without raising its voice. | H2 Laminate (520 m), O3 Rebreather, L3 Floods, S2 Pressure Shell, C3 Cutter | 4-6 | 14-18 |
| 3-6 | -400 to -1320 | Long excursions. Cross the twilight into permanent dark at -900. First hostile (Pale Gulper) at ~4:10. Establish a forward beacon network. Mine manganese and cobalt on the nodule plain. Reach R3 and R4. Watch the fix ellipse collapse from 640 m to 190 m. | The transition from *exploring* to *committing*. This is where the game stops being pretty and starts being far from home. First real fear at 4:10, first real awe at 6:20 when the Drifter blots out everything. | H3 Sintered (1150 m), H4 Isostatic (2200 m), O4 Rebreather Mk2, Photophore Bar | 5-6 | 24-28 |
| 6-10 | -1320 to -3550 | Deep logistics. Every trip is 25-40 minutes round trip. Rift walls, black smokers, the White Towers. Lantern-Hunter at 7:10. Wall-Eyes at 8:20. Build the Deep Frame and then the Rift Frame from awaruite and trenchglass and four diamonds picked up off a talus slope by hand. Reach R5, then R6, and read SIG-12. | Attrition and dread, punctuated by the most beautiful places in the game. The White Towers at 7:50 are deliberately placed as relief between two of the worst dread beats. SIG-12 at 9:00 recontextualises the entire ten hours: they have been climbing down an arm. | H5 Deep Frame (3600 m), S3 Hadal Carapace, L4 Arc Floods, H6 Rift Frame (4600 m) | 3-4 | 32-37 |
| 10-10.5 | -3550 to -4260 to 0 | THE FINALE. The Throat, the Chamber, the Core Scan, the Terminal Phase, the Column, the surface. | Commitment, then terror that turns out to be misplaced, then awe, then a long quiet ascent through everything they were ever afraid of, all of it lit and rising with them. Then silence. | END-01..04, post-bloom world | 0 | 40 |
| 10.5+ | anywhere | Free roam. Catalogue completion. Photo mode. Secrets. The juveniles in the reefgrass. The empty slot at 79. NG+. | Custodianship. The loneliness resolves not into company but into having been the only witness. | Cosmetic completion tiers | player-authored | 40 + 14 juveniles |

### 08.9.1 Session-length assumptions

| Assumption | Value | Why it matters |
|------------|-------|----------------|
| Median session | 52 min | Autosave cadence, thread persistence |
| Median depth gain per session (hours 1-9) | 380 m | Gate spacing calibrated to ~1.3 sessions per hull tier |
| Round trip to deepest frontier at hour 8 | 34 min | Beacon network is mandatory design, not optional |
| Time-to-first-"whoa" | 9 min (first flight-to-dive transition) | Hard requirement |
| Time-to-first-dread | 2 h 50 min (first pre-pulse silence) | Hard requirement |
| Time-to-first-fear | 4 h 10 min (Pale Gulper) | Hard requirement |
| Total critical path | 9.6 - 11.4 h | |
| Total with 100% catalogue | 22 - 27 h | |

---

## 08.10 PERSISTENCE SCHEMA (this section's keys)

IndexedDB database `subwave`, version 1.

| Store | Key | Value shape | Approx size |
|-------|-----|-------------|-------------|
| `progress` | saveId | `{stage, pulseIndex, pulsePhase, worldTimeSeconds, bloomComplete, enteredChamber, end02Filed}` | < 1 KB |
| `databank` | saveId | `{unlocked: Set<string>, firstSeenAt: {id: seconds}}` | < 4 KB |
| `catalogue` | saveId | `{scanned: {speciesId: {n, firstDepth, bestPhotoId, flashPeriod}}, maxEntries}` | < 40 KB |
| `beacons` | saveId | `[{id, x, y, z, name, colour}]` x <= 12 | < 2 KB |
| `bearings` | saveId | `[{x, z, brgRad, sigmaRad, takenAt}]` x <= 12 | < 1 KB |
| `chunkLedger` | saveId+chunk | `{minedNodes: [id], regenAt: [t]}` | ~120 KB total |
| `photos` | photoId | `Blob` PNG + metadata | <= 600 MB |
| `worldState` | saveId | post-bloom flags per 08.7.3 | < 1 KB |

localStorage (small, synchronous, settings-scope only):

| Key | Value |
|-----|-------|
| `subwave.activeSave` | save id string |
| `subwave.assist.pins` | bool, default true |
| `subwave.assist.threadHints` | bool, default true |
| `subwave.ngPlus.modifiers` | `{quietRun, longNight, fragile}` |
| `subwave.qualityTier` | 0-3 |

Autosave: every 120 s of play, on stage change, on entry unlock, on docking, and on quit. Save write budget: < 8 ms, off the render thread via a worker where the store allows it.

---

## 08.11 FAILURE-MODE AUDIT

| Risk | Mitigation |
|------|------------|
| Player never finds R1 and wanders | The bearing from the buoy is 171 deg and R1 is at bearing 169.5 deg / 702 m from the island edge. Any dive along the initial bearing intersects it. Its local tick is audible in-cockpit within 79 m. |
| Player triangulates the core at hour 1 and beelines | They will. Their hull crushes at 60 m. The fix is *information*, not access. Knowing where it is at hour 1 and not being able to go there is a designed feeling. |
| Player misses the phase-lock discovery | It is automatic at 5 scanned bioluminescent species and there are 11 in B0-B2 alone. |
| Player skips all Roots and dives straight down at hour 9 with H6 | Possible and permitted. `enteredChamber` still fires the finale. The stage floor means they experienced the clock-driven acceleration instead. They will have missed SIG-03..12; those entries remain unlockable by returning to the Roots afterwards, including post-bloom. |
| Player finishes with an incomplete catalogue | Intended. Free roam retains everything. |
| Dread saturation / player quits at hour 7 | 08.6.2 governor plus the mandated relief biomes. The White Towers exist for exactly this reason. |
| Player loses the Kite at -3000 m | G1 SCUTTLE PROTECT. They ride it to the surface in 36 minutes of real time, which is a story they will tell. |
| Finale feels like a boss fight players expect to lose | 08.7.2: no fail state. Warning tones fire but integrity floors at 40%. Playtest note: some players will flee the Core Scan the first time. They can come back. The scan resets, never fails. |
| Ending reads as anticlimactic ("it's just a plant") | The counter is scale and duration: 22.4 km^2, 120,000 years of growth bands, and an 11-minute ascent through a re-lit ocean. The awe is in the ascent, not in the object. Budget the F5 sequence accordingly - it is the single most expensive scripted set-piece in the game. |
| Any content drifts toward implying other humans | Axioms A1-A7 are a review gate on every asset, string, and audio cue. |

---

## 08.12 CROSS-SECTION DEPENDENCIES (assumed, must be verified)

1. **Section 03 (world/biomes)** must place the Roots and the Throat at the exact anchors in 08.0.3, and guarantee a navigable water column along the Root chain.
2. **Section 03** must implement the seven biomes named in 08.3.1 with the stated depth ranges.
3. **Section 04 (rendering/water)** owns absorption; this section only requires that ambient irradiance is clamped to exactly zero below 1100 m.
4. **Section 05 (day/night)** must use `DAY_REAL_SECONDS = 1200`. If it differs, the 9.0-day halving constant in 08.2.2 must be rescaled so the clock reaches its 12.48 s floor at ~10 real hours.
5. **Section 06 (vessel)** must provide: the collector arm (4.0 m reach, 12 slots, inherits cutter tier, operable from the seat) — **hard requirement for closure**; the 4-element hydrophone array; SCUTTLE PROTECT; docking recharge at 11 kW; vent thermoelectric recharge at 4.2 kW.
6. **Section 07 (HUD/windshield)** must render: depth, hull integrity, O2/scrubber, compass ribbon with pin chevron, hydrophone bearing wedge, and must suppress the compass below -3400 m.
7. **Section 09 (audio)** must implement the heterodyne, the pre-pulse ambient duck (08.2.3), RT60 of 8.4 s in the Throat, and the 42 dB SPL release hiss.
8. **Section 10 (creatures)** must supply: Pale Gulper and Lantern-Hunter as the only two lethal species; the Drifter at 41 m non-hostile; Wall-Eyes as a sim/shader effect; and `flashPeriod` on every bioluminescent species as an integer subdivision of the live master period.
9. **Section 11 (materials/crafting)** must adopt the material codes and depths in 08.3.7 verbatim, especially the RUT placer beach.
10. **Section 12 (performance)** must budget for F5: 1.1e6 particles, a 3.6 km column, and 4-7 simultaneous 41 m creatures at 60 fps on the target GPU, degrading particle count to 2.4e5 on tier 0.
