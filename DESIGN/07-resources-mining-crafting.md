# SUBWAVE - DESIGN SECTION 07

## Resources, Materials, Mining, Inventory, Crafting, Scanning, Home Base & Economy

Status: BINDING IMPLEMENTATION SPEC. Version 1.0.
Scope owner: systems/gameplay. Consumers: 03 (terrain), 04 (vessel), 05 (flora/fauna),
06 (survival/time/HUD), 08 (audio), 09 (persistence), 10 (rendering budgets).

---

## 07.0 PREAMBLE - CONVENTIONS, UNITS AND CROSS-SECTION CONTRACTS

### 07.0.1 Units and conventions used throughout this section

| Symbol | Meaning | Unit |
|--------|---------|------|
| d | depth below sea level, d = -y | m |
| H | material hardness index (Mohs-analogue) | 1..10 integer |
| I | node integrity (work required to break a node) | IU (integrity units) |
| P | tool cut power | IU/s |
| UI | Utility Index - abstract scarcity/value scalar used ONLY for balance math and fabricator refunds | points |
| VT | Value Tier, derived from UI (see 07.0.4) | VT0..VT5 |
| m_u | mass per unit of a material | kg |
| rho_n | node areal density | nodes per hectare (10,000 m^2) of qualifying biome floor |
| E | electrical energy | kJ |
| L | luminous flux | lm |
| nits | emissive surface radiance | cd/m^2 |

- Colours are given as 8-bit sRGB triplets `R,G,B`. Shaders convert with the standard
  sRGB EOTF; the values below are AUTHORED sRGB, not linear.
- Roughness and metallic are linear PBR scalars in [0,1] as consumed by the section-10 BRDF.
- All angles in this document are stated in degrees for human readability. Engine stores radians.
- Coordinate system per the project brief: right-handed, +X east, +Y up, +Z south, metres,
  sea level y = 0, depth d = -y, heading 0 deg = north (-Z), increasing clockwise from above.

### 07.0.2 THERE IS NO MARKET. THERE ARE NO HUMANS.

There is no currency, no trader, no vendor, no NPC, no radio, no human ruin, no readable
human artefact anywhere in SUBWAVE. `UI` is a **designer-facing balance number**, surfaced to
the player only indirectly as:

1. The fabricator's **salvage refund**: deconstructing a crafted item returns `floor(0.60 * inputs)`
   of each input material, rounded down, minimum 0.
2. The databank's **Scarcity** glyph on each material page (a 0..5 pip bar = VT).

Do not render UI as a number. Do not implement a shop. Do not implement trading.

### 07.0.3 Depth bands (BINDING - all sections must use these band ids)

| Band | Name | y range (m) | d range (m) | Ambient character |
|------|------|-------------|-------------|-------------------|
| B0 | Aerial / Littoral | y > 0 | n/a | Full sunlight, island and air |
| B1 | Sunlit Shallows | 0 .. -30 | 0 .. 30 | Caustics, full colour, safe |
| B2 | Upper Shelf | -30 .. -90 | 30 .. 90 | Blue-shifted, reds gone by 25 m |
| B3 | Lower Shelf | -90 .. -220 | 90 .. 220 | Dim blue-green, first true gloom |
| B4 | Twilight | -220 .. -480 | 220 .. 480 | 0.1 % surface irradiance, headlights mandatory |
| B5 | Aphotic | -480 .. -950 | 480 .. 950 | Zero solar photons, bioluminescence only |
| B6 | Trench | -950 .. -1700 | 950 .. 1700 | Pitch black, high pressure, hostile |
| B7 | Seam | -1700 .. -2600 | 1700 .. 2600 | Geothermal, superheated plumes, terminal band |

### 07.0.4 Value Tier mapping

| VT | UI per unit | Meaning | Pip glyph |
|----|-------------|---------|-----------|
| VT0 | 1 .. 2 | Ubiquitous bulk stock | `.` |
| VT1 | 3 .. 6 | Common, band-gated | `:` |
| VT2 | 7 .. 14 | Uncommon | `:.` |
| VT3 | 15 .. 30 | Rare | `::` |
| VT4 | 31 .. 60 | Very rare, deep-only | `::.` |
| VT5 | 61+ | Terminal-band unique | `:::` |

### 07.0.5 Cross-section contracts (ASSUMPTIONS - verify against the owning sections)

| # | Assumption | Owner |
|---|------------|-------|
| A1 | Terrain (03) exposes a per-chunk **sparse SDF edit list** with append + compaction, and chunk keys are 32-bit | 03 |
| A2 | Terrain chunks are 32 m cubes at LOD0 with 0.5 m voxels (64^3 density grid + 1 skirt) | 03 |
| A3 | Terrain gen tags each surface sample with a `biomeId:u8` and provides `surfaceNormal`, `slopeDeg` | 03 |
| A4 | The vessel EXISTS AND IS FLIGHT-CAPABLE FROM MINUTE ZERO (the brief: "board a personal vessel and depart"). All vessel recipes in 07 are UPGRADES, never the vessel itself | 04 |
| A5 | Vessel exposes exactly four upgrade slot classes: `HULL` x1, `PROP` x2, `UTIL` x3, `SENS` x2 | 04 |
| A6 | Vessel has an internal power bus with a rated draw budget of 180 kW and an onboard cell | 04 |
| A7 | One in-game day = 20 real minutes (72:1 time compression). "game-hour" = 50 real seconds | 06 |
| A8 | Player has Health, Oxygen, Hunger, Hydration, Core Temperature meters | 06 |
| A9 | Section 05 names its species; 07 lists scan SUBJECTS by archetype + proposed name. If 05 renames, keep the unlock semantics and re-point the id | 05 |
| A10 | Persistence layer (09) provides an IndexedDB object store API with typed-array blobs | 09 |
| A11 | Renderer (10) supports an instanced GPU-driven prop pass with a 48-byte instance struct and an object-id buffer for outline/highlight | 10 |
| A12 | Audio (08) provides a synthesis graph with underwater LPF/reverb busses; 07 supplies only parameters | 08 |

---

## 07.A - MATERIAL TABLE

31 raw materials. Split across four tables for terminal readability. The `id` column is the
canonical string key used in save data, recipes and shader material lookups. Never rename an id.

### 07.A.1 Identity, class and appearance

`CLS`: `MET` metallic ore, `CRY` crystal, `ORG` organic/biological, `GAS` gas, `RARE` deep exotic.
`NODE`: presentation class, see 07.B.1 (`OUT` outcrop, `VEI` vein, `GEO` geode, `FLO` flora,
`BLA` bladder, `DRI` drift/loose, `CAR` carcass/moult).

| id | Name | CLS | NODE | Albedo sRGB | Rough | Metal | Emissive sRGB | Emis nits |
|----|------|-----|------|-------------|-------|-------|----------------|-----------|
| ferrite | Ferrite Nodule | MET | OUT | 92,58,38 | 0.72 | 0.15 | - | 0 |
| cuprite | Verdigris Cuprite | MET | VEI | 44,132,110 | 0.55 | 0.35 | - | 0 |
| cassite | Cassite Sand | MET | DRI | 118,106,92 | 0.62 | 0.45 | - | 0 |
| rutile | Rutile Grit | MET | OUT | 74,44,40 | 0.38 | 0.60 | - | 0 |
| galena | Argent Galena | MET | VEI | 158,160,166 | 0.22 | 0.95 | - | 0 |
| aurics | Auric Flake | MET | VEI | 212,175,55 | 0.28 | 1.00 | - | 0 |
| siderite | Sider Pellet | MET | OUT | 62,60,58 | 0.34 | 0.85 | - | 0 |
| lithine | Lithine Crust | MET | OUT | 198,186,206 | 0.68 | 0.05 | - | 0 |
| magnesite | Magnesite Bloom | MET | OUT | 226,222,212 | 0.75 | 0.00 | - | 0 |
| wolfram | Wolfram Knot | MET | VEI | 90,92,96 | 0.30 | 0.90 | - | 0 |
| iridis | Iridic Kernel | MET | GEO | 206,208,214 | 0.18 | 1.00 | - | 0 |
| quartz | Clearquartz | CRY | OUT | 230,236,240 | 0.10 | 0.00 | - | 0 |
| fluorspar | Glowspar | CRY | GEO | 122,74,190 | 0.14 | 0.00 | 150,90,255 | 6 |
| beryl | Aquavane Beryl | CRY | GEO | 96,196,190 | 0.09 | 0.00 | - | 0 |
| corund | Sanguine Corundum | CRY | VEI | 168,26,40 | 0.08 | 0.00 | - | 0 |
| kyanite | Abyssal Kyanite | CRY | OUT | 48,96,220 | 0.16 | 0.00 | 60,120,255 | 3 |
| chasmond | Chasmond | CRY | GEO | 245,248,250 | 0.03 | 0.00 | - | 0 |
| halite | Brine Halite | CRY | DRI | 236,222,216 | 0.30 | 0.00 | - | 0 |
| bladefibre | Bladewrack Fibre | ORG | FLO | 82,96,44 | 0.85 | 0.00 | - | 0 |
| reefcalx | Reefcalx | ORG | FLO | 224,196,170 | 0.66 | 0.00 | - | 0 |
| lumigel | Lumigel Sac | ORG | FLO | 120,220,205 | 0.20 | 0.00 | 90,255,220 | 22 |
| carapace | Carapace Plate | ORG | CAR | 96,64,36 | 0.42 | 0.05 | - | 0 |
| lipid | Lipid Bladder | ORG | CAR | 226,214,150 | 0.24 | 0.00 | - | 0 |
| siphonsilk | Siphon Silk | ORG | FLO | 232,230,236 | 0.30 | 0.00 | - | 0 |
| sporecap | Sporecap Flesh | ORG | FLO | 176,150,168 | 0.78 | 0.00 | 200,150,255 | 1.5 |
| marrowstone | Marrowstone | ORG | OUT | 214,206,190 | 0.58 | 0.00 | - | 0 |
| clathrate | Methane Clathrate | GAS | OUT | 200,214,222 | 0.24 | 0.00 | - | 0 |
| sulphpod | Sulphide Pod | GAS | BLA | 220,196,72 | 0.55 | 0.00 | - | 0 |
| ventgas | Vent Helide | GAS | BLA | 170,210,220 | 0.20 | 0.00 | 120,180,220 | 1 |
| voidglass | Voidglass | RARE | VEI | 12,12,16 | 0.05 | 0.00 | - | 0 |
| nyxite | Nyxite | RARE | GEO | 28,16,44 | 0.22 | 0.10 | 190,60,255 | 65 |

Additional appearance rules:

- `quartz`, `beryl`, `chasmond`, `halite`, `clathrate`, `lumigel`, `siphonsilk` render through the
  **translucent prop pipeline** with a thickness parameter: transmission 0.72 / 0.55 / 0.86 / 0.40 /
  0.34 / 0.62 / 0.70 respectively, and IOR 1.54 / 1.58 / 2.42 / 1.54 / 1.31 / 1.36 / 1.44.
- Emissive intensity is authored at 1.0 exposure and is NOT attenuated by depth. Water absorption
  (03/10) attenuates the emitted light on its way to the eye, which is the whole point: a `nyxite`
  geode at 65 nits is visible at 90 m in B7 but the beam it casts reddens out within 4 m.
- `voidglass` is deliberately near-black albedo with roughness 0.05: it is found by SPECULAR
  GLINT off headlights, not by colour. This is a rendering-driven design decision.
- `aurics` and `iridis` use `metallic = 1.0` with a coloured F0: aurics F0 = (1.000, 0.766, 0.336),
  iridis F0 = (0.955, 0.960, 0.968).

### 07.A.2 Distribution: biomes, bands, density

Biome ids are as proposed here; section 03 owns the final biome list (see A3).

| id | Biomes | Bands | rho_n (nodes/ha) | Cluster size | Notes on placement |
|----|--------|-------|------------------|--------------|--------------------|
| ferrite | shoal_garden, kelp_palisade, ripple_barrens | B1-B3 | 34.0 | 2-5 | Loose on sand and rubble aprons; slope < 25 deg |
| cuprite | shoal_garden, basalt_spires, lightless_grotto | B1-B4 | 18.0 | 1-3 | Only on exposed basalt faces, slope > 40 deg |
| cassite | ripple_barrens, sand_flats | B2-B3 | 14.0 | 3-8 | Black-sand placer streaks in ripple troughs |
| rutile | basalt_spires, twilight_wall | B3-B5 | 9.0 | 1-3 | Embedded in dark igneous, needs cutter |
| galena | basalt_spires, lightless_grotto | B3-B5 | 7.0 | 1-2 | Cave walls; strong specular tell under torch |
| aurics | vent_field, lightless_grotto | B4-B6 | 4.0 | 1-2 | Hydrothermal quartz stringers |
| siderite | ashen_basin (impact scatter fields) | B5-B6 | 3.5 | 1-4 | Widely spaced boulders with fusion crust |
| lithine | brine_pool_margin, sand_flats | B2-B4 | 11.0 | 2-6 | Evaporitic crust rimming brine pools |
| magnesite | kelp_palisade, shoal_garden, basalt_spires | B1-B3 | 16.0 | 2-4 | Chalky rosettes on carbonate rock |
| wolfram | trench_wall, bone_chasm | B6 | 2.2 | 1 | Solitary dark knots in fault breccia |
| iridis | ONLY inside siderite boulders (secondary node) | B5-B6 | 0.8 | 1 | 22 % of siderite boulders contain 1 kernel |
| quartz | all rock biomes | B1-B5 | 20.0 | 1-4 | The universal filler; densest in basalt_spires |
| fluorspar | lightless_grotto, twilight_wall | B3-B5 | 8.0 | 1-3 | Cubic crystals in vugs; visible glow at 45 m |
| beryl | glass_forest | B5-B6 | 4.0 | 1-2 | Hexagonal prisms sprouting from silica spires |
| corund | thermal_seam margins, bone_chasm | B6-B7 | 1.6 | 1 | Red glint against black basalt |
| kyanite | ashen_basin, glass_forest | B5-B6 | 5.0 | 1-3 | Bladed blue crystals in schist boulders |
| chasmond | thermal_seam (kimberlite pipes) | B7 | 0.6 | 1 | 1-2 per pipe; pipes are 1 per ~4 ha |
| halite | brine_pool_margin, island salt pans | B0, B2-B4 | 22.0 | 4-10 | Also the ONLY B0 (dry-land) minable material |
| bladefibre | kelp_palisade | B1-B2 | 60.0 | 5-12 | Harvest by hand from live Bladewrack stipes |
| reefcalx | shoal_garden | B1-B2 | 45.0 | 3-8 | Broken coral rubble, hand-collectable |
| lumigel | twilight_wall, ashen_basin, bone_chasm | B4-B6 | 26.0 | 2-6 | Sacs on sessile flora AND on fauna corpses |
| carapace | moult piles + fauna drops | B2-B6 | 12.0 | 1-3 | Moult piles are static nodes; drops are dynamic |
| lipid | oil seeps + fauna drops | B3-B6 | 9.0 | 1-2 | Seeps bubble slowly; audible at 20 m |
| siphonsilk | siphon-worm tube fields | B3-B5 | 14.0 | 4-9 | Harvest tube lining; worm retracts, does not attack |
| sporecap | lightless_grotto, bone_chasm, thermal_seam | B5-B7 | 7.0 | 2-5 | Faint mauve glow, grows on marrowstone |
| marrowstone | bone_chasm | B6 | 6.0 | 2-4 | Mineralised skeletal accumulations, non-human |
| clathrate | sand_flats hydrate fields, trench_slope | B3-B6 | 13.0 | 3-7 | Fizzes and outgasses when cut |
| sulphpod | vent_field | B4-B6 | 10.0 | 2-5 | Yellow bladders; rupture damages 8 HP if unsuited |
| ventgas | thermal_seam black smokers | B6-B7 | 3.0 | 1-2 | Capture at plume mouth; 340 C water nearby |
| voidglass | thermal_seam obsidian flows | B7 | 2.4 | 1-3 | Only found by specular glint; near-invisible unlit |
| nyxite | thermal_seam core geodes | B7 | 0.7 | 1 | The single brightest object in the terminal band |

Placement algorithm (BINDING):

```
// Deterministic, storage-free. Only DEPLETED nodes are persisted (see 07.C.6).
// Called per terrain chunk on stream-in.
function placeNodes(chunkKey, biomeId, bandId) {
  let rng = pcg32(hash64(WORLD_SEED, chunkKey, 0x4E4F4445));   // 'NODE'
  let areaHa = CHUNK_FOOTPRINT_M2 / 10000;                     // 32*32 -> 0.1024 ha
  for (const mat of MATERIALS_FOR(biomeId, bandId)) {
    let lambda = mat.rho_n * areaHa * biomeWeight(biomeId, mat);
    let count  = poisson(rng, lambda);
    for (let i = 0; i < count; i++) {
      let anchor = poissonDiskSampleOnSurface(rng, chunk, mat.minSpacing);  // 1.8 m default
      if (!slopeOk(anchor, mat)) continue;
      let clusterN = randRange(rng, mat.clusterMin, mat.clusterMax);
      emitCluster(anchor, clusterN, mat, rng);   // members within 3.2 m of anchor
    }
  }
}
// nodeId = hash64(chunkKey, matId, sequenceIndex)  -> stable 64-bit key, never stored unless depleted.
```

### 07.A.3 Mining: hardness, integrity, time by tier

`t_break` in seconds at 100 % node integrity and >10 % power cell charge. `--` = tool cannot
engage the material (hardness gate; the tool sparks, plays the `reject` SFX, and makes no progress).
Values are computed from the formula in 07.C.3 and are the AUTHORITATIVE numbers - if the formula
and a table cell disagree, the table wins and the formula constants are to be re-fitted.

Tools: `HAND` bare hands, `T0` Kit Chisel, `T1` Pulse Cutter Mk1, `T2` Mk2, `T3` Mk3,
`V1` Vessel Bore Mk1, `V2` Vessel Bore Mk2.

| id | H | I_node (IU) | HAND | T0 | T1 | T2 | T3 | V1 | V2 |
|----|---|-------------|------|----|----|----|----|----|----|
| ferrite | 2 | 260 | -- | 5.9 | 1.9 | 0.8 | 0.41 | 0.35 | 0.35 |
| cuprite | 3 | 420 | -- | 10.5 | 3.4 | 1.4 | 0.72 | 0.35 | 0.35 |
| cassite | 3 | 380 | -- | 9.5 | 3.1 | 1.3 | 0.65 | 0.35 | 0.35 |
| rutile | 5 | 900 | -- | -- | 9.1 | 3.8 | 1.9 | 0.85 | 0.38 |
| galena | 3 | 520 | -- | 13.1 | 4.2 | 1.7 | 0.90 | 0.39 | 0.35 |
| aurics | 2 | 300 | -- | 6.8 | 2.2 | 0.9 | 0.47 | 0.35 | 0.35 |
| siderite | 6 | 2200 | -- | -- | -- | 10.6 | 5.5 | 2.4 | 1.06 |
| lithine | 3 | 460 | -- | 11.6 | 3.7 | 1.5 | 0.79 | 0.35 | 0.35 |
| magnesite | 4 | 560 | -- | -- | 5.0 | 2.1 | 1.07 | 0.47 | 0.35 |
| wolfram | 8 | 5200 | -- | -- | -- | -- | 18.3 | 8.0 | 3.6 |
| iridis | 7 | 4100 | -- | -- | -- | 23.2 | 12.0 | 5.2 | 2.3 |
| quartz | 7 | 1500 | -- | -- | -- | 8.5 | 4.4 | 1.9 | 0.85 |
| fluorspar | 4 | 700 | -- | -- | 6.3 | 2.6 | 1.34 | 0.59 | 0.35 |
| beryl | 8 | 3400 | -- | -- | -- | -- | 12.0 | 5.2 | 2.3 |
| corund | 9 | 6000 | -- | -- | -- | -- | 26.8 | -- | 7.1 |
| kyanite | 7 | 2600 | -- | -- | -- | 14.7 | 7.6 | 3.3 | 1.5 |
| chasmond | 10 | 9000 | -- | -- | -- | -- | -- | -- | 10.6 |
| halite | 2 | 180 | -- | 4.1 | 1.3 | 0.55 | 0.35 | 0.35 | 0.35 |
| bladefibre | 1 | 60 | 1.5 | 1.25 | 0.40 | 0.35 | 0.35 | -- | -- |
| reefcalx | 4 | 520 | -- | -- | 4.7 | 1.9 | 1.00 | 0.44 | 0.35 |
| lumigel | 1 | 45 | 1.1 | 0.94 | 0.35 | 0.35 | 0.35 | -- | -- |
| carapace | 5 | 850 | -- | -- | 8.6 | 3.6 | 1.8 | 0.80 | 0.36 |
| lipid | 1 | 50 | 1.25 | 1.04 | 0.35 | 0.35 | 0.35 | -- | -- |
| siphonsilk | 1 | 55 | 1.4 | 1.15 | 0.37 | 0.35 | 0.35 | -- | -- |
| sporecap | 1 | 70 | 1.75 | 1.46 | 0.47 | 0.35 | 0.35 | -- | -- |
| marrowstone | 4 | 640 | -- | -- | 5.7 | 2.4 | 1.20 | 0.54 | 0.35 |
| clathrate | 2 | 240 | -- | 5.5 | 1.7 | 0.73 | 0.37 | 0.35 | 0.35 |
| sulphpod | 1 | 40 | 3.0* | 3.0* | 3.0* | 3.0* | 3.0* | -- | -- |
| ventgas | 1 | 30 | -- | -- | 4.0* | 4.0* | 4.0* | 4.0* | 4.0* |
| voidglass | 9 | 5600 | -- | -- | -- | -- | 25.0 | -- | 6.6 |
| nyxite | 8 | 7000 | -- | -- | -- | -- | 24.7 | 10.8 | 4.8 |

`*` GAS-class materials are **capture-rate limited, not hardness limited**: the pod ruptures
instantly on any contact and the canister fills at a fixed rate. Tool tier does not accelerate it.
Vessel bores cannot capture gas (no canister port) except `ventgas`, which requires the
vessel's plume-capture nozzle.

Design intent encoded in this table:

- `chasmond` (H10) is mineable ONLY by Vessel Bore Mk2 -> a hard terminal gate, and the reason
  Chasmond recipes are strictly post-Bore-Mk2 luxuries, never on the critical path.
- `corund` (H9) and `voidglass` (H9) exceed Vessel Bore Mk1's H_max of 8 but are within the
  handheld Pulse Cutter Mk3's H_max of 9. **You must leave the vessel and hand-cut them.**
  This is the single most important tension beat in the deep game: the safest tool cannot take
  the thing you need, so you swim in the dark.
- `wolfram` (H8) is the first material that hard-requires Pulse Cutter Mk3 or a vessel bore.

### 07.A.4 Yield, stacking, mass and value

| id | Yield/node | Stack | m_u (kg) | UI/unit | VT | Grid footprint |
|----|-----------|-------|----------|---------|----|----------------|
| ferrite | 2-4 | 40 | 1.60 | 1 | VT0 | 1x1 |
| cuprite | 2-3 | 40 | 1.40 | 2 | VT0 | 1x1 |
| cassite | 2-3 | 40 | 1.30 | 2 | VT0 | 1x1 |
| rutile | 1-3 | 30 | 1.10 | 6 | VT1 | 1x1 |
| galena | 1-2 | 30 | 2.40 | 4 | VT1 | 1x1 |
| aurics | 1-2 | 25 | 2.80 | 8 | VT2 | 1x1 |
| siderite | 1-2 | 25 | 2.20 | 10 | VT2 | 1x1 |
| lithine | 2-4 | 30 | 0.70 | 5 | VT1 | 1x1 |
| magnesite | 2-4 | 40 | 0.90 | 3 | VT1 | 1x1 |
| wolfram | 1 | 15 | 3.60 | 26 | VT3 | 1x1 |
| iridis | 1 | 10 | 3.10 | 40 | VT4 | 1x1 |
| quartz | 2-4 | 30 | 1.00 | 3 | VT1 | 1x1 |
| fluorspar | 1-3 | 25 | 1.10 | 5 | VT1 | 1x1 |
| beryl | 1-2 | 20 | 0.90 | 18 | VT3 | 1x1 |
| corund | 1 | 15 | 1.00 | 34 | VT4 | 1x1 |
| kyanite | 1-2 | 20 | 1.20 | 22 | VT3 | 1x1 |
| chasmond | 1 | 10 | 0.90 | 70 | VT5 | 1x1 |
| halite | 3-6 | 50 | 0.50 | 1 | VT0 | 1x1 |
| bladefibre | 2-3 | 40 | 0.30 | 1 | VT0 | 1x1 |
| reefcalx | 2-4 | 40 | 1.20 | 2 | VT0 | 1x1 |
| lumigel | 1-2 | 30 | 0.40 | 4 | VT1 | 1x1 |
| carapace | 1-2 | 20 | 1.50 | 7 | VT2 | 1x1 |
| lipid | 1-2 | 30 | 0.60 | 3 | VT1 | 1x1 |
| siphonsilk | 1-2 | 30 | 0.20 | 6 | VT1 | 1x1 |
| sporecap | 1-3 | 25 | 0.40 | 9 | VT2 | 1x1 |
| marrowstone | 1-3 | 25 | 1.30 | 12 | VT2 | 1x1 |
| clathrate | 2-4 | 20 | 0.80 | 5 | VT1 | 1x1 |
| sulphpod | 1-2 | 15 | 0.60 | 4 | VT1 | 1x1 |
| ventgas | 1 | 10 | 0.90 | 15 | VT3 | 1x1 |
| voidglass | 1-2 | 15 | 1.80 | 45 | VT4 | 1x1 |
| nyxite | 1 | 8 | 2.60 | 90 | VT5 | 1x1 |

All raw materials are 1x1 in the spatial grid (07.D). Only crafted goods take larger footprints.
This keeps raw hauling a MASS problem, not a TETRIS problem - the packing puzzle belongs to gear.

Yield roll: `yield = yieldMin + floor(rng01()^0.72 * (yieldMax - yieldMin + 1))`, clamped.
The 0.72 exponent biases slightly toward the maximum, so a long cut feels rewarded.

### 07.A.5 Flavour lines (databank body text, 1-2 sentences each)

| id | Flavour |
|----|---------|
| ferrite | Iron oxide concretions that grow like slow fruit on the reef's rubble aprons. They crumble at a tap and are the reason anything here can be built at all. |
| cuprite | Copper carbonate that stains basalt the exact green of shallow water at noon. Older faces bleed the colour a metre downslope. |
| cassite | A heavy black placer sand that settles in the troughs of every ripple field, sorted by a hundred thousand tides. Scoop it, do not cut it. |
| rutile | Titanium dioxide locked into dark igneous rock in needle-thin crystals. It resists the drill about as stubbornly as it resists the sea. |
| galena | Lead sulphide with an unnervingly perfect mirror cleavage. In torchlight a fresh face throws your own lamp back at you like an eye opening. |
| aurics | Gold precipitated out of hydrothermal fluid, curled into flakes the size of a fingernail. It does not corrode, which down here counts as immortality. |
| siderite | Nickel-iron from something that fell a very long time ago. The fusion crust is still there, sanded smooth by nine hundred metres of quiet water. |
| lithine | A pale lilac evaporite crust that rims the brine pools and squeaks under a boot. It tastes of battery and salt; do not test this. |
| magnesite | Chalky carbonate rosettes that bloom on old reef limestone. Burns white-hot and far too eagerly. |
| wolfram | Tungstate knots in the trench's fault breccia, dense out of all proportion to their size. One fits in a palm and feels like three. |
| iridis | A platinum-group kernel found only at the heart of fallen iron. Whatever made it was not born on this world either. |
| quartz | Silica, the ocean's favourite structural material and yours. Clear enough at depth to work as glass with no more than heat. |
| fluorspar | Fluorite that answers ultraviolet with a slow violet ache of its own light. The grottoes hold whole ceilings of it, breathing. |
| beryl | Beryllium aluminate in hexagonal prisms, sprouting from the silica spires like something that grew rather than crystallised. |
| corund | Chromium-stained corundum, red as an old wound, scattered where the seam's heat has cooked the rock for a geological age. |
| kyanite | Bladed aluminosilicate that carries current at pressure with almost no loss. The abyssal plain is paved with a superconductor and nobody was ever coming to collect it. |
| chasmond | Carbon squeezed by the seam's kimberlite pipes into the hardest thing on the planet. Nothing you own could touch it until now. |
| halite | Rock salt. Boring, ubiquitous, and the difference between a functioning body and a corpse. |
| bladefibre | The tough inner stipe of Bladewrack, a kelp that grows nine metres in a season. Strip it, ret it, and it becomes rope, cloth, or a fair meal. |
| reefcalx | Aragonite rubble broken from the living reef by storms. Kiln it and it becomes the same cement the reef used in the first place. |
| lumigel | The luminous contents of a photophore sac, still glowing hours after harvest. It is a chemical scream that nothing here has ever needed to hear. |
| carapace | A shed chitin plate, laminated in some thirty microscopic layers. Stronger for its mass than anything you know how to smelt. |
| lipid | A buoyancy bladder full of wax esters. Rendered down it is fuel, resin base, and if you are desperate, food. |
| siphonsilk | Protein thread spun to line the burrow of a filter worm. It is stronger wet than dry, which is a design decision you must respect. |
| sporecap | Flesh from a lightless fungus that eats sulphide and glows faintly mauve about it. Mildly medicinal, extremely disquieting. |
| marrowstone | Mineralised skeletal chalk from the chasm's accumulations - vertebrae the size of a cabin, stacked by currents into drifts. None of them are human, and none of them ever were. |
| clathrate | Methane trapped inside a cage of water ice, stable only under cold and pressure. Bring it up too fast and it evaporates in your hand with a hiss. |
| sulphpod | A bladder of hydrogen sulphide vented by the field and caught by a patient membrane. It smells of the beginning of the world. |
| ventgas | Helium-bearing gas straight from the mantle, caught at the smoker's lip. It is older than the ocean it is escaping into. |
| voidglass | Volcanic glass quenched at two thousand metres, so dark it takes light without comment. You will find it by the one glint it gives back. |
| nyxite | A violet mineral that fluoresces at sixty-five nits with no excitation whatsoever, in a place with no light at all. It is the only thing down here that seems to be doing something on purpose. |

---

## 07.B - ORE NODE PRESENTATION

### 07.B.1 Node presentation classes

| NODE | Silhouette | Range read | Interaction verb |
|------|-----------|------------|------------------|
| OUT (outcrop) | Blobby metaball boulder, 0.4-1.6 m, sits ON the surface | Silhouette break against smooth terrain | Cut with tool |
| VEI (vein) | Flat ribbon embedded IN a rock face, protrudes 0.05-0.18 m | Colour/specular contrast on the wall | Cut with tool; leaves a terrain crater |
| GEO (geode) | Closed nodule 0.5-1.1 m; cracks open at 50 % integrity | Nothing until cracked, then emissive interior | Cut; two-stage break |
| FLO (flora) | Reuses the section-05 plant mesh | Motion (current sway) + emissive | Hold-to-harvest, no tool needed for H1 |
| BLA (bladder) | Translucent sphere/ovoid 0.25-0.7 m, pulses 0.35 Hz | Silhouette + subsurface scatter | Puncture, then hold canister |
| DRI (drift) | Scattered small pieces on sand, 0.03-0.12 m each | Sparkle/glint field | Single-press pickup, no tool, no timer |
| CAR (carcass/moult) | Chitin pile or corpse remains, 0.6-1.4 m | Silhouette + scavenger fauna nearby | Hold-to-harvest |

### 07.B.2 How a node reads at range - the four-cue system

Every node must be identifiable by class at 60 m and by material at 25 m, with headlights only,
in B5+. Four independent cues, in priority order:

1. **Silhouette (0-140 m).** Nodes never share a silhouette family with terrain. Terrain is
   low-frequency and smooth; nodes are high-frequency and lumpy or prismatic. Enforced by a
   minimum surface-curvature requirement: node meshes must have mean |curvature| >= 2.2 m^-1
   over 40 % of their surface area, terrain never exceeds 0.9 m^-1 at LOD0.
2. **Emissive veins (0-90 m).** EVERY node, including non-emissive materials, receives a faint
   procedural vein network in its emissive channel at **0.35 nits** in the material's
   `hintColour` (see table below). This is a deliberate, physically-cheated affordance: it is
   justified in-fiction as trace luminous bacteria colonising mineral surfaces, which is exactly
   what real deep-sea rock does. It reads as a whisper, not a marker.
3. **Specular glint (0-45 m, headlight-dependent).** High-metal and low-roughness materials
   return a strong lobe. This is the primary discovery channel for `voidglass`, `galena`, `iridis`.
4. **Scanner highlight (0-90 m, opt-in).** See 07.B.5.

| CLS | hintColour sRGB | Outline colour sRGB | Icon glyph |
|-----|------------------|---------------------|------------|
| MET | 255,176,96 | 255,176,64 | hexagon |
| CRY | 140,220,255 | 96,220,255 | diamond |
| ORG | 150,255,170 | 120,255,150 | leaf |
| GAS | 220,235,255 | 200,230,255 | circle-o |
| RARE | 235,120,255 | 235,90,255 | asterisk |

### 07.B.3 Procedural node mesh recipe (BINDING)

All node meshes are generated on the **CPU at chunk stream-in** into a shared vertex arena, or on
the **GPU via a compute prepass** on quality tiers HIGH+. There are exactly four generators.

**GEN-A: Metaball outcrop (`OUT`, `CAR`)**

```
seed = hash64(nodeId)
N    = randInt(seed, 3, 7)                       // blob count
for i in 0..N:
   c_i = randInInsideEllipsoid(a=0.45, b=0.28, c=0.45) * sizeScale
   r_i = randRange(0.18, 0.55) * sizeScale
field(p) = sum_i ( r_i^2 / (|p - c_i|^2 + eps) )   // classic inverse-square metaball
iso      = 1.0
// Polygonise:
grid  = 0.06 m cells over the union AABB inflated by 0.12 m
mesh  = marchingCubes(field, iso, grid)           // -> 900..2600 triangles
// Displace:
for each vertex v:
   n = normalize(gradient(field, v))
   h = 0.030 * ridgedNoise3(v * 7.0, octaves=2, lacunarity=2.1, gain=0.55)
     + 0.012 * simplex3(v * 23.0)
   v += n * h
// Vein mask (drives emissive + albedo blend):
   m = smoothstep(0.62, 0.71, worley3F2minusF1(v * 5.5))
   vertexColour.a = m                              // a=1 -> pure ore, a=0 -> host rock
recomputeNormals(angleThreshold = 48 deg)
```

Host rock albedo is the biome's rock albedo from section 03; ore albedo is 07.A.1. The shader
does `mix(hostAlbedo, oreAlbedo, vColour.a)` and `emissive = hintColour * 0.35 * vColour.a`.

**GEN-B: Crystal cluster (`CRY` OUT and GEO interiors)**

```
seed = hash64(nodeId)
K    = randInt(seed, 5, 11)                       // crystal count
axis = randUnitHemisphere(up = surfaceNormal)
for k in 0..K:
   dir   = slerp(axis, randUnit(), randRange(0.0, 1.0)) with cone half-angle randRange(12,38) deg
   sides = material.prismSides                    // 6 for quartz/beryl/corund, 4 for kyanite,
                                                  // 8 for chasmond, cube(4+cap) for fluorspar
   rb    = randRange(0.04, 0.16)
   len   = randRange(0.25, 1.10) * (0.55 + 0.45 * (1 - k/K))   // first crystals biggest
   prism = extrudeRegularPolygon(sides, rb, len)  // 2*sides + 2*sides tris
   tip   = pyramidCap(sides, rb, len * randRange(0.12, 0.30))
   crystal = weld(prism, tip)
   place at base offset randInDisc(0.10) along surface, rotate to dir
   // Facet jitter for realism:
   for each side face: rotate its 4 verts about the axis by randRange(-2.5, 2.5) deg
```

Triangle budget 340-900 per cluster. Vertex alpha = normalized distance from base, drives
the transmission ramp so tips are clearer than roots.

**GEN-C: Vein ribbon (`VEI`)**

```
// A vein is a Catmull-Rom ribbon lying ON the rock face, protruding slightly.
ctrl = 4..7 points, random walk on the face, step 0.35-0.9 m, curvature-limited to 55 deg/step
for t in 0..1 step 1/48:
   p = catmullRom(ctrl, t)
   w = 0.10 + 0.14 * sin(pi * t) * noise1(t*4.0)       // half-width, m
   h = 0.05 + 0.13 * sin(pi * t)                       // protrusion, m
   emit quad strip: p +- binormal*w, offset along faceNormal*h
// Then bevel the edges by 0.02 m and apply GEN-A's displacement at 40 % amplitude.
```

384-760 triangles. Veins are the only class that write to the terrain edit list on break (07.C.4).

**GEN-D: Bladder (`BLA`)**

```
mesh = icosphere(subdiv = 2)                       // 320 tris
scale = randRange(0.25, 0.70) non-uniform (0.85..1.15 anisotropy)
// Vertex animation in the vertex shader, not on CPU:
v += n * 0.045 * sin(TAU * 0.35 * time + v.y * 3.1 + phaseSeed)
```

Subsurface scattering: single-scatter approximation with `sigma_t = 3.4 m^-1`, phase g = 0.55.

**LOD and impostor policy**

| LOD | Distance (HIGH tier) | Representation | Tri budget |
|-----|----------------------|----------------|------------|
| LOD0 | 0-18 m | Full generated mesh | 100 % |
| LOD1 | 18-45 m | Quadric-decimated to 40 % | 40 % |
| LOD2 | 45-110 m | Quadric-decimated to 14 %, flat-shaded | 14 % |
| IMP | 110-200 m | 2-quad cross-billboard, octahedral impostor atlas | 4 |
| cull | > 200 m | Not drawn; the emissive hint is folded into the biome's far-field emissive LUT | 0 |

Impostor atlas: one 2048x2048 `rgba8unorm` array texture, 8 layers, 12 views per node archetype
(octahedral hemisphere), 170x170 px per view. Generated once at world load in a 40 ms compute+raster
pass, cached in IndexedDB keyed by `(archetypeId, WORLD_SEED_ART)`.

**Instance struct (48 bytes, matches contract A11):**

| Offset | Field | Type | Notes |
|--------|-------|------|-------|
| 0 | position | `vec3<f32>` | world metres |
| 12 | rotation | `snorm16x4` (packed) | unit quaternion |
| 20 | scale | `f16x3` | non-uniform |
| 26 | matIndex | `u16` | index into material palette SSBO |
| 28 | integrityNorm | `unorm16` | 1.0 = pristine, drives crack/erode shader |
| 30 | archetype | `u16` | selects mesh/impostor |
| 32 | tintSeed | `u32` | per-instance hash for hue/rough jitter |
| 36 | flags | `u32` | bit0 scanned, bit1 highlighted, bit2 cracked, bit3 secondary-node-present |
| 40 | nodeIdLo | `u32` | low 32 bits of the 64-bit node id (hi bits reconstructible from chunk) |
| 44 | _pad | `u32` | |

**Per-quality-tier node budgets:**

| Quality | Max live node instances | LOD0 dist | IMP dist | Cull dist | Emissive vein cue |
|---------|------------------------|-----------|----------|-----------|-------------------|
| ULTRA | 2400 | 24 m | 140 m | 260 m | on |
| HIGH | 1600 | 18 m | 110 m | 200 m | on |
| MEDIUM | 900 | 12 m | 70 m | 150 m | on |
| LOW | 450 | 8 m | 45 m | 100 m | on (mandatory - it is a readability affordance, never a quality option) |

### 07.B.4 Mining VFX

All values are for the handheld Pulse Cutter unless a vessel column is given. Water and air
behave differently and both must be implemented.

| Effect | Parameter | Underwater | In air (B0) |
|--------|-----------|------------|-------------|
| Sparks | spawn rate | 40-90 /s (scales with tool P) | 60-130 /s |
| | initial speed | 2.5-6.0 m/s | 4.0-9.0 m/s |
| | lifetime | 0.35-0.90 s | 0.55-1.40 s |
| | drag coefficient k (v' = -k*v) | 2.4 s^-1 | 0.35 s^-1 |
| | gravity | 0.6 m/s^2 (buoyancy-corrected) | 9.81 m/s^2 |
| | colour | blackbody 2400-3200 K for MET/CRY; none for ORG | same |
| | size | 0.006-0.018 m, additive, no shadow | same |
| Particulate cloud | spawn rate | 12 puffs/s | 5 puffs/s |
| | radius growth | 0.15 -> 0.90 m over 3.2 s | 0.15 -> 0.55 m over 0.9 s |
| | drift | inherits local current (03) + 0.25 m/s from cut face | falls at 1.1 m/s |
| | colour | `albedo * 0.6`, alpha 0.50 -> 0.0, ease-out cubic | same |
| | lit by | headlights + 1 nearest point light; NOT shadow-casting | sun |
| Chunks | spawn rate | 3-8 /s | 3-8 /s |
| | size | 0.03-0.09 m | same |
| | physics | simplified rigid sphere, 1.8 s then dissolve | 2.6 s then dissolve |
| | terminal velocity | 0.9 m/s (sinking) | n/a |
| Screen shake | handheld amplitude | 0.35 deg rotational | 0.42 deg |
| | handheld frequency | 18 Hz, exp decay tau 0.15 s | same |
| | vessel bore amplitude | 0.90 deg + 0.020 m positional | 1.20 deg + 0.030 m |
| | vessel bore frequency | 11 Hz | 11 Hz |
| | accessibility | fully scalable 0-100 % in options; 0 % must not disable any gameplay signal | |
| Node crack (GEO) | at 50 % integrity | 1 shell fracture, 22 shards, interior emissive fades in over 0.4 s | same |
| Node break | flash | 1 additive sprite, 0.18 s, radius 0.9 m, colour = hintColour, peak 8 nits | same |
| | debris burst | 14-26 chunks at 3-7 m/s | same |
| | terrain decal | 1 dark scorch decal r = 0.35 m, 90 s fade | same |
| Heat glow | emitter tip | ramps 0 -> (255,120,40) at 40 nits as heat 0 -> 100 | same |
| | cut point | blackbody 1900 K -> 3100 K, radius 0.08 m | same |

Water-only extras: a **cavitation ring** at the cut point (a 0.10 m torus of bubbles, 25/s,
rising at 0.28 m/s, gone in 1.4 s), and **turbidity injection** - the cut adds
`+0.06 m^-1` to the local scattering coefficient inside a 2.5 m sphere, decaying with tau = 4.0 s.
This is what makes prolonged mining literally blind you, and it is intentional: it forces
reposition-and-wait rhythm rather than hold-button-forever.

### 07.B.5 Scanner highlight / Prospect Pulse

Two distinct systems. Do not merge them.

**A. Passive highlight (always on when the Scanner is the equipped tool)**

- Renders an object-id-buffer-driven outline (1.6 px inner, 0.8 px outer glow) on nodes within
  90 m, occlusion-tested (no see-through).
- Outline colour = the CLS outline colour from 07.B.2, alpha 0.55 at 0 m, ramping to 0.18 at 90 m.
- Nodes of a material the player has NOT yet unlocked a recipe for pulse at 0.5 Hz between
  alpha*1.0 and alpha*1.6.

**B. Prospect Pulse (Scanner secondary fire, hold RMB)**

| Parameter | Mk1 | Mk2 (post Sonar Mapper, R61) |
|-----------|-----|------------------------------|
| Radius | 60 m | 110 m |
| Charge time | 0.8 s | 0.5 s |
| Reveal duration | 2.5 s | 4.5 s |
| Cooldown | 8.0 s | 5.0 s |
| Sees through terrain | no | yes, up to 14 m of rock |
| Energy | 6 kJ | 9 kJ |
| Reveals | node class silhouette only (no material id) | class + material glyph |

Visual: an expanding spherical wavefront (screen-space distance-field ring, 0.35 m thick,
propagating at 24 m/s in Mk1 / 44 m/s in Mk2). Nodes it passes flash their outline at alpha 0.9
and hold for the reveal duration, then fade over 0.6 s. Rendered in a dedicated
`highlight` pass writing to a half-res `r8unorm` mask, upsampled with a 3x3 cross bilateral filter.

Audio: a rising sine chirp 620 -> 1450 Hz over the charge, then a soft filtered-noise "wash"
whose amplitude tracks the wavefront radius. Underwater bus, LPF 1.1 kHz, reverb send 0.35.

### 07.B.6 Mining SFX (synthesis parameters - no audio files)

All parameters feed the section-08 Web Audio graph.

| Sound | Synthesis |
|-------|-----------|
| Cutter beam loop | 3 detuned sawtooth voices at f0 = 180 Hz, detune -7 / 0 / +7 cents, summed at -18 dBFS, through a 2-pole bandpass whose centre sweeps 800 -> 2400 Hz driven by `contactPressure`, Q = 3.2. Parallel white noise at -26 dBFS through a bandpass at 3.1 kHz Q 1.4 for abrasion. |
| Cutter idle hum | Single sine 96 Hz at -32 dBFS + 2nd harmonic at -44 dBFS. |
| Chip impact (per chunk) | 4 ms white-noise burst -> resonant bandpass. f0/Q by class: MET 1.8-3.6 kHz / Q 12; CRY 4.2-7.5 kHz / Q 26; ORG 300-700 Hz / Q 4; GAS none. Amplitude -22 dBFS, randomised +-3 dB. |
| Node crack (GEO) | Two-stage: 8 ms noise burst through BP 900 Hz Q 8, then a 220 ms decaying comb (delay 4.1 ms, feedback 0.72). |
| Node break | Exponentially decaying filtered noise (tau 0.28 s) + sine sub at 45 Hz, 0.40 s, -14 dBFS, both through a 0.7 s convolution reverb. |
| Hardness reject | 30 ms metallic clang: 6 inharmonic sines at 1.7 / 2.31 / 3.09 / 4.44 / 5.87 / 7.12 kHz, exp decay tau 0.05 s, -20 dBFS. Plus haptic pulse if gamepad. |
| Overheat warning | Triangle 1200 Hz, 3 pulses of 90 ms with 60 ms gaps, -24 dBFS, at heat >= 85. |
| Gas capture | Rising filtered noise, LPF cutoff 400 -> 2600 Hz over the capture, plus a bubble grain cloud (12 grains/s, each a 30 ms sine sweep 900 -> 300 Hz). |
| Vessel bore | Cutter loop transposed down 1 octave, +6 dB, plus a 28 Hz square-wave sub at -20 dBFS amplitude-modulated at 11 Hz to match the shake. |

Underwater processing (applied by 08 to all of the above when `d > 0`): one-pole LPF at
1100 Hz, a 1.4 s plate reverb at send 0.30, and a depth-dependent pitch-neutral delay
of `d / 1500` seconds for sounds originating more than 15 m away.

---

## 07.C - MINING

### 07.C.1 The handheld tool family

The tool is a **Pulse Cutter**: a resonant piezo-percussion head with a short standoff plasma
arc. Not a laser. It works by shattering, which is why hardness gates it.

| Tool | Tier | P (IU/s) | H_max | Range | Cone half-angle | Energy | Heat rise | Heat cool | Mass | Grid |
|------|------|----------|-------|-------|-----------------|--------|-----------|-----------|------|------|
| (bare hands) | - | 40 | 1 | 1.6 m | 25 deg | 0 | 0 | - | 0 | - |
| Kit Chisel | T0 | 48 | 3 | 1.8 m | 20 deg | 0 (mechanical) | 0 | - | 1.1 kg | 1x2 |
| Pulse Cutter Mk1 | T1 | 150 | 5 | 3.2 m | 8.0 deg | 0.90 kJ/s | 3.2 /s | 5.0 /s | 2.4 kg | 2x2 |
| Pulse Cutter Mk2 | T2 | 360 | 7 | 4.0 m | 6.5 deg | 2.10 kJ/s | 2.4 /s | 6.0 /s | 3.1 kg | 2x2 |
| Pulse Cutter Mk3 | T3 | 700 | 9 | 4.8 m | 5.0 deg | 4.40 kJ/s | 1.6 /s | 7.5 /s | 3.8 kg | 2x2 |

- **Heat** is a 0-100 scalar. At 100 the tool locks out for a fixed **4.0 s** vent cycle
  (irrespective of tier) and emits steam/bubbles. Mk1 therefore sustains 100/3.2 = **31.3 s**
  of continuous fire; Mk3 sustains **62.5 s**.
- Heat cooling rate is HALVED in air (B0) and MULTIPLIED BY 1.35 below d = 900 m (cold water).
  Mining in the sun on the island is genuinely worse than mining in the abyss. Say so in the tooltip.
- **Energy** comes from an inserted Power Cell (07.E, R26/R27/R28). At cell charge < 10 %,
  `P` is halved and the beam flickers. At 0 % the tool will not fire.
- **Range** is measured from the muzzle, not the camera. The cone is a *capsule sweep* test
  against node colliders; the nearest hit within the cone wins. Aim assist: if no node is inside
  the cone but one is within `coneHalfAngle + 3 deg` and within range, snap to it (this must be
  disableable in options).
- **Damage falloff**: `P_eff = P * (1 - 0.35 * clamp((dist - 0.4*range)/(0.6*range), 0, 1))`.
  Standing at point-blank is 35 % faster than at maximum range. Rewards commitment.

### 07.C.2 The vessel-mounted bore

Mounted in a `UTIL` slot (contract A5). Fires from a chin turret with limited gimbal.

| Tool | Tier | P (IU/s) | H_max | Range | Cone half-angle | Gimbal | Power draw | Heat rise | Heat cool | Slot |
|------|------|----------|-------|-------|-----------------|--------|------------|-----------|-----------|------|
| Vessel Bore Mk1 | T2 | 1600 | 8 | 9.0 m | 3.5 deg | +-22 deg yaw, -35/+8 deg pitch | 46 kW | 2.8 /s | 9.0 /s (water) | UTIL |
| Vessel Bore Mk2 | T4 | 3600 | 10 | 12.0 m | 2.5 deg | +-30 deg yaw, -45/+12 deg pitch | 105 kW | 2.2 /s | 11.0 /s (water) | UTIL |

- Bore heat cooling in AIR is 3.5 /s for both marks (water-cooled jacket, no water). Mk1 in air
  sustains only 100/(2.8-3.5<0)... precisely: net rise in air = 2.8 - 3.5 = -0.7, i.e. it does NOT
  overheat in air but P is derated to **0.55x** in air because the standoff arc destabilises without
  a conductive medium. Mining from the air is possible but slow. This is a physics-flavoured
  disincentive against hovering-and-strip-mining the island.
- Bore cannot engage `FLO`, `CAR` or `BLA` (except `ventgas` via the plume nozzle). It has no
  fine control.
- **Auto-collect**: bore output goes directly to the vessel cargo hold, bypassing personal
  inventory. If the hold is full the bore refuses to fire and posts `HOLD FULL` to the windshield HUD.
- Bore fire is disabled when vessel speed > 1.2 m/s or angular rate > 15 deg/s. You must
  actually park.

### 07.C.3 The mining formula (BINDING)

```js
// Per tick (fixed 20 Hz mining tick, dt = 0.05 s)
const HARDNESS_FALLOFF = 0.085;
const T_MIN_ENGAGE     = 0.35;   // s, floor on total break time per node

function cutRate(tool, mat, distance, cellCharge01, medium) {
  if (mat.H > tool.H_max) return 0;                       // hard gate -> reject SFX
  let f      = 1.0 - HARDNESS_FALLOFF * (mat.H - 1);      // 1.000 @H1 ... 0.235 @H10
  let P      = tool.P;
  if (cellCharge01 < 0.10) P *= 0.5;
  if (medium === 'air' && tool.isVesselBore) P *= 0.55;
  let falloff = 1.0 - 0.35 * clamp((distance - 0.4*tool.range) / (0.6*tool.range), 0, 1);
  return P * f * falloff;                                  // IU/s
}

function tickMining(node, tool, dt) {
  const r = cutRate(tool, node.mat, dist, cell.charge01, medium);
  if (r <= 0) { rejectFx(); return; }
  node.integrity -= r * dt;                                // integrity starts at mat.I_node
  node.elapsed   += dt;
  if (node.mat.NODE === 'GEO' && node.integrity <= 0.5 * node.mat.I_node && !node.cracked) {
    node.cracked = true; crackFx(node);
  }
  if (node.integrity <= 0 && node.elapsed >= T_MIN_ENGAGE) breakNode(node);
}

// Derived reference: t_break = I_node / (P * f)  at optimal range, full charge.
// This reproduces every cell of table 07.A.3 to within +-0.05 s.
```

**Interruption rule.** Releasing the trigger does NOT reset integrity. Partial progress persists
for **90 real seconds** or until the chunk unloads, whichever is first, and is stored in a
transient in-memory map (never persisted). The node's `integrityNorm` instance field drives a
progressive crack/erode shader so the player can see partial work from a distance.

### 07.C.4 Terrain deformation (contract A1)

Two sources of terrain edits. Nothing else in the game deforms terrain.

**Source 1: Vein node removal (automatic, small).** Breaking a `VEI` node emits exactly ONE
subtract-sphere edit at the vein centroid, radius `0.22 + 0.10 * nodeScale` m, smooth falloff.
This leaves a believable scar without opening a hole into a cave system.

**Source 2: Bore mode (deliberate, large).** Both handheld Pulse Cutters (Mk1+) and both Vessel
Bores have a **bore mode** (secondary fire) that cuts terrain directly.

| Mode | Sphere radius | Edit interval | Effective volume rate | Energy | Heat |
|------|---------------|---------------|-----------------------|--------|------|
| Handheld bore | 0.35 m | 0.20 s | ~0.090 m^3/s (after overlap) | 1.4x normal | 1.6x normal |
| Vessel bore | 1.40 m | 0.15 s | ~1.90 m^3/s | 1.4x normal | 1.6x normal |

Handheld bore recovers a small material yield from the excavated volume:
`units = floor(volume_m3 * biome.hostYieldPerM3)` where `hostYieldPerM3` is 0.4 for
`ferrite`-bearing sand, 0.15 for basalt (`quartz`), 0 elsewhere. Bore mining is NEVER
competitive with node mining - it is for making passages and burying/embedding deployables.

**Edit record (16 bytes, little-endian, matches contract A1):**

```
struct TerrainEdit {          // 16 B
  px : i16,                   // chunk-local X, units of 1/64 m  (+-512 m range)
  py : i16,
  pz : i16,
  radius_q : u8,              // units of 1/32 m  -> 0.03125 .. 7.97 m
  brush    : u8,              // 0 = SUB_SPHERE, 1 = SUB_CAPSULE, 2 = ADD_SPHERE
  strength : i8,              // signed density delta, -128..127 (full subtract = -128)
  falloff  : u8,              // 0 = hard, 1 = smoothstep, 2 = gaussian(sigma = r/2.5)
  seq      : u16,             // global monotonic order key (wraps at 65536, per-chunk relative)
  chunk    : u32              // chunk key; dropped in the per-chunk store, present in the stream
}
```

**Quantisation.** All edit positions quantise to 1/64 m = 0.015625 m, i.e. 1/32 of a 0.5 m LOD0
voxel. This is below the meshing error floor so quantisation is invisible.

**Budgets and compaction.**

| Limit | Value | On exceed |
|-------|-------|-----------|
| Edits per chunk before compaction | 512 | Bake into a per-chunk density delta texture |
| Density delta texture | `r8snorm`, 34x34x34 (LOD0 grid + skirt) = 39.3 KB | Replaces the edit list for that chunk |
| Global soft cap (edit records) | 250,000 (4.0 MB) | Compact the oldest-touched chunks first |
| Global hard cap (delta textures) | 400 chunks (15.7 MB) | Evict the least-recently-visited chunk's deltas and RESTORE its original terrain, with a 5 s HUD notice naming the coordinates |

**No-edit zones (refuse with `SUBSTRATE STABLE` HUD message + reject SFX + sparks):**

1. Within **30 m** (horizontal) of the Anchorage centre, and anywhere on the home island above
   y = -6 m. The starting zone is inviolable.
2. Within **6 m** of any deployed Remote Locker, Beacon, or the vessel's current resting position.
3. Any voxel flagged `STRUCTURAL` by terrain gen (03): natural arch keystones, cave roof spans
   with > 8 m unsupported length, and the thermal seam's chimney stacks.
4. Within **2.5 m** of a `nyxite` or `chasmond` node's parent geode shell (you may cut the node,
   not the rock that holds it - prevents trivially caving the terminal-band geode chambers).

**Water flood rule.** A bore cut that connects an air pocket to open water floods over
`V_pocket / 2.4` seconds (2.4 m^3/s inflow through the breach). Air pockets are the only
dry underwater spaces; see 03. There is no way to make a new air pocket.

### 07.C.5 Deposit depletion

- A node has one integrity pool. When it reaches 0 the node **breaks completely** and yields its
  full roll. There is no partial harvest.
- `GEO` nodes are two-stage: cracking at 50 % reveals the interior (visual + emissive only, no
  yield). A cracked but unbroken node persists its cracked state for the same 90 s window as
  partial integrity.
- `siderite` boulders have a **secondary node**: on break, 22 % of them spawn a single `iridis`
  kernel node in place, at the boulder's centroid, which must be mined separately (H7, 4100 IU).
  The instance flag bit3 tells the shader to draw a faint metallic glint hint at the core.
- Fauna drops (`carapace`, `lipid`, sometimes `lumigel`) are dropped as `DRI` pickups by section-05
  creatures on death and despawn after **180 real seconds** with a 30 s fade warning.

### 07.C.6 Persistence of depletion, and respawn

**Storage strategy: store only what deviates from the deterministic generator.**

```
IndexedDB store: 'depletedNodes'
key:   u64 nodeId (stored as two u32 in a Uint32Array pair, or as a string for keyRange scans)
value: { t: f64 (game-seconds when depleted), chunk: u32 }
Serialised in blocks of 4096 entries per record, keyed by chunk-region (8x8x8 chunks).
Entry cost: 16 B. Cap: 200,000 entries = 3.2 MB.
```

On eviction pressure (> 200,000), delete the OLDEST entries whose material's respawn class is
not `NEVER` - they will simply respawn, which is correct behaviour anyway.

**Respawn rules:**

| Respawn class | Materials | T_respawn (game-days) | T_respawn (real min, at 72:1) |
|---------------|-----------|------------------------|-------------------------------|
| FAST | bladefibre, reefcalx, halite, lumigel, siphonsilk, sporecap, lipid | 1.5 | 30 |
| COMMON | ferrite, cuprite, cassite, magnesite, quartz, lithine, clathrate, sulphpod, carapace | 3.0 | 60 |
| SLOW | rutile, galena, fluorspar, marrowstone, ventgas, aurics | 7.0 | 140 |
| NEVER | siderite, iridis, wolfram, beryl, corund, kyanite, chasmond, voidglass, nyxite | - | - |

Additional respawn gates, ALL of which must be satisfied:

1. `now - depletedAt >= T_respawn`.
2. Player is more than **120 m** from the node position.
3. The node is not inside the player's current view frustum (belt-and-braces; 2 usually covers it).
4. The parent chunk currently has fewer than **60 %** of its original node count for that material
   already alive-and-depleted-pending. (Prevents a fully strip-mined chunk from snapping back to
   pristine in one tick - regrowth is gradual.)
5. On respawn, the node's position is **jittered within a 25 m disc** on the same surface, keeping
   the same `matId` but taking a NEW `nodeId` derived from `hash64(oldNodeId, respawnGeneration)`.
   The world must never feel like a respawning shooting gallery: the ore comes back, but not
   in the same holes.

`NEVER`-class materials are finite. The world seed contains a known, countable quantity of
`nyxite` (see 07.H.5). This is deliberate: the terminal band's resources are a fixed budget and
the player is entitled to know that from the databank ("Occurrence: finite").

---

## 07.D - INVENTORY

### 07.D.1 Decision: SPATIAL GRID. Justification.

**Chosen: a spatial grid (Tetris-style) with per-item WxH footprints and per-material stack limits,
plus a hard mass budget layered on top.**

Rejected alternative: flat slot list. Rejected because:

1. **It makes the loadout decision physical.** A 2x2 Pulse Cutter Mk3 and a 1x2 O2 tank compete for
   the same rectangle as 6 units of ore. The player *sees* what carrying a tool costs. A slot list
   makes that cost invisible.
2. **It reads at a glance at 1920x1080.** A 7x6 grid of 64 px cells is 448x384 px - legible,
   fully mouse-and-gamepad navigable, and needs no scrolling at any tier.
3. **It composes with the mass budget** rather than duplicating it. Grid area limits *variety*,
   mass limits *quantity*. Two orthogonal pressures produce genuinely different decisions
   ("do I take the third tool, or the fourth stack of wolfram?").
4. **All raw materials are 1x1** (07.A.4), so bulk hauling never becomes a packing puzzle - the
   packing puzzle applies only to gear, which is exactly where thinking is wanted.

Auto-arrange (`R` key / gamepad Y) runs a deterministic shelf-packing pass: sort by
`(footprintArea DESC, class, UI DESC)`, place top-left-first, gear before raws. It is always
available and always succeeds if a valid packing exists for that multiset (proof by construction:
with all raws 1x1, only gear needs packing, and gear count is bounded at 14).

### 07.D.2 Personal inventory tiers

| Tier | Item | Grid | Cells | M_soft | M_hard | Recipe |
|------|------|------|-------|--------|--------|--------|
| P0 | (starting harness) | 5 x 4 | 20 | 60 kg | 90 kg | owned at start |
| P1 | Cargo Webbing | 6 x 5 | 30 | 95 kg | 140 kg | R46 |
| P2 | Composite Harness | 7 x 6 | 42 | 140 kg | 210 kg | R47 |
| P3 | Exo-Harness | 8 x 7 | 56 | 200 kg | 300 kg | R48 |

Equipment slots are SEPARATE from the grid and do not consume cells:

| Slot | Accepts | Count |
|------|---------|-------|
| TOOL | Kit Chisel, Pulse Cutter Mk1-3, Scanner, Repair Torch, Portable Fabricator | 1 active + 3 holstered (quick-swap 1-4) |
| TANK | O2 Tank Std / High-Cap / Rebreather | 1 |
| SUIT | Dive Suit Mk1-3 | 1 |
| FEET | Swim Fins / Ultra Fins | 1 |
| LINER | Thermal Liner | 1 |
| CELL | Power Cell Mk1-3 (powers the active tool) | 1 + 2 spares in grid recommended |
| LIGHT | Handlight | 1 |

Holstered tools DO occupy grid cells; only the ACTIVE tool is free. That is the ergonomic
justification and the balance lever simultaneously.

### 07.D.3 Mass and overweight

```js
M = sum(item.qty * item.m_u) + sum(equippedItem.mass);

over = clamp((M - M_soft) / (M_hard - M_soft), 0, 1);

swimSpeedMult      = 1.00 - 0.45 * over;     // 3.2 m/s -> 1.76 m/s at full over
walkSpeedMult      = 1.00 - 0.35 * over;
ascentRateMult     = 1.00 - 0.70 * over;     // you can barely climb
descentRateBonus   = 1.00 + 0.55 * over;     // you sink fast, which is sometimes useful
o2BurnMult         = 1.00 + 0.30 * over;
staminaDrainMult   = 1.00 + 0.60 * over;
turnRateMult       = 1.00 - 0.25 * over;

if (M >= M_hard) {
  // NEGATIVELY BUOYANT. Not a UI lockout - a physical state.
  netBuoyancy   = -(M - M_hard) * 9.81 * 0.06;   // N, capped at -180 N
  verticalSpeed = -0.80 m/s minimum (sinking), player cannot swim upward at all
  o2BurnMult    = 1.55
  HUD posts "NEGATIVE BUOYANCY" in amber, 1.2 Hz pulse
  // The player must drop items (Q on a stack), enter the vessel, or reach the seabed and walk.
}
```

Pickup is REFUSED (with a HUD `OVERMASS` toast and the pickup prompt greyed) when it would push
`M > M_hard`. You can never become stuck by an automatic pickup. You CAN become negatively buoyant
by manually transferring from the vessel hold while outside; that is a choice and it is allowed.

### 07.D.4 Vessel cargo hold

Separate container, only accessible when the player is inside the vessel or within 3.0 m of its
open cargo hatch (which requires the vessel to be resting: |v| < 0.5 m/s).

| Tier | Item | Grid | Cells | M_soft | M_hard | Recipe |
|------|------|------|-------|--------|--------|--------|
| V0 | (base hold) | 10 x 6 | 60 | 1200 kg | 1800 kg | fitted at start |
| V1 | Cargo Expansion I | 12 x 8 | 96 | 2200 kg | 3200 kg | R62 |
| V2 | Cargo Expansion II | 14 x 10 | 140 | 3600 kg | 5000 kg | R63 |

Vessel overweight effects (cross-reference section 04; these are the multipliers 07 requires 04
to apply - 04 owns the base numbers):

```js
vOver = clamp((M_vessel_total - M_soft_v) / (M_hard_v - M_soft_v), 0, 1);

thrustToWeightMult   = 1.00 - 0.40 * vOver;
maxClimbRateMult     = 1.00 - 0.55 * vOver;   // hover ceiling in AIR drops hard
pitchRateMult        = 1.00 - 0.30 * vOver;
yawRateMult          = 1.00 - 0.22 * vOver;
ballastTrimRangeMult = 1.00 - 0.35 * vOver;   // underwater neutral-buoyancy authority
hoverCeiling_m       = 340 * (1 - 0.75 * vOver);   // 340 m AGL empty -> 85 m AGL at soft-cap+

if (M_vessel_total >= M_hard_v) {
  // Cannot achieve positive lift in AIR at all. Underwater it can still swim but is
  // permanently negatively buoyant and drops at 1.4 m/s with thrusters off.
  HUD (windshield): "MASS LIMIT - LIFT UNAVAILABLE"
}
```

The vessel is the only way to move serious tonnage. This is the single most important economic
fact in the game and it is what turns bands 3+ from trip-limited into mining-limited (07.H).

### 07.D.5 Quick-transfer rules

| Input | Action |
|-------|--------|
| Left-click drag | Move one stack (or split with held Shift -> half, held Ctrl -> one) |
| Double-click item | Transfer whole stack to the other open container |
| Shift + click | Transfer whole stack to the other open container (same as double-click, for muscle memory) |
| `F` held 0.6 s at an open container | **STOW RAWS**: transfers every `CLS != crafted` item to the container, merging into existing partial stacks first |
| `G` held 0.6 s at an open container | **DRAW KIT**: pulls back a saved loadout (see below) |
| `R` | Auto-arrange the focused grid |
| `Q` on a hovered stack | Drop it into the world as a floating pickup (buoyancy per material; despawn 600 s) |
| Middle-click a material | Toggle "Favourite": favourited materials are EXCLUDED from STOW RAWS |

**Saved loadouts.** Up to 3 named loadouts stored in localStorage. A loadout is a list of
`(itemId, qty)`. `DRAW KIT` fills toward the loadout from the container, taking what is available,
and reports shortfalls as `2/4 POWER CELL MK2` in the toast. It never removes items you already have.

**Merge order** for all bulk transfers: fill partial stacks in the destination first (nearest to
top-left), then place new stacks into the first free cell in row-major order. Deterministic, so
the player's spatial memory is never violated.

**Cross-container reach.** The Anchorage's Storage Locker, the vessel hold, and any Remote Locker
within 8 m are all offered as transfer targets simultaneously in a tabbed panel. The Fabricator
can PULL ingredients from the personal grid + the Anchorage locker + the vessel hold if the vessel
is on the charging pad; it can never pull from a Remote Locker.

### 07.D.6 Death, drop and recovery

Player death (health reaches 0 - 06 owns the causes) resolves as follows.

**If the player was OUTSIDE the vessel:**

1. A **Salvage Cache** is instantiated at the death position, snapped to the nearest surface
   within 6 m (or left neutrally buoyant if no surface is within 6 m).
2. It contains **everything in the personal grid**. It does NOT contain equipped items
   (TOOL active, TANK, SUIT, FEET, LINER, CELL, LIGHT) - those are kept. Holstered tools in the
   grid ARE lost to the cache.
3. Cache visual: a 0.55 m irregular bundle wrapped in siphonsilk-like mesh with a 4-nit amber
   emissive pulse at 0.4 Hz. Cache audio: a slow 2-note sonar ping (740 Hz then 590 Hz) every 3.5 s,
   audible at 40 m.
4. It broadcasts a HUD beacon visible at **900 m** through terrain, labelled `CACHE` + depth.
5. The player respawns at the Anchorage bed, at the next morning (game time advanced to 06:30),
   with health 100 %, hunger/hydration at 55 %, and the same equipped gear.

**If the player was INSIDE the vessel:** no cache is created. Cargo stays in the hold, the personal
grid contents stay on the corpse-free player (nothing is lost), the vessel remains exactly where it
was with a permanent `VESSEL` beacon at 2000 m, and the player respawns at the Anchorage. Recovery
means swimming/walking back or... there is no other vessel. Getting the vessel stuck at 1600 m with
no suit for the trip is a real, recoverable-but-painful failure state, and the Beacon and
Drop Light deployables exist precisely so that competent players never face it blind.

**Cache limits:**

- Maximum **3** simultaneous caches. Creating a 4th deletes the oldest, with a 60-second
  in-game countdown shown on the HUD before the deletion, and a distinct warning chime.
- Caches persist indefinitely otherwise (no timer). They survive save/load.
- Opening a cache transfers with the normal grid rules; an emptied cache dissolves over 2.0 s.
- Caches are stored in IndexedDB store `caches`: `{ id, pos:[f32;3], items:[{id,qty}], created:f64 }`.

**Anti-frustration clauses (BINDING):**

- If the player dies within 90 real seconds of the previous death AND at greater depth, the new
  cache absorbs the previous cache's contents (they merge into the newer one). Rationale: a death
  spiral must not scatter a full hold across a trench in fragments.
- The Kit Chisel and Scanner Mk1 are **never lost**. If both are absent from the grid and the
  equipment slots after a respawn, one of each is silently re-added at the Anchorage fabricator
  free of charge. The player can never be softlocked out of the core verbs.

---

## 07.E - CRAFTING

### 07.E.1 Stations

| id | Name | Where | Unlock | Recipe classes | Power |
|----|------|-------|--------|----------------|-------|
| FAB | Anchorage Fabricator | Anchorage, fixed | owned at start | Tools, gear, deployables, consumables, base stations | 3.0 kW peak |
| KIL | Accretion Kiln | Anchorage pad 2 | R67 | Smelting, refining, ceramics, glass | 6.5 kW peak |
| CHM | Chem Bench | Anchorage pad 3 | R68 | Polymers, gels, salts, medical, food | 2.2 kW peak |
| LTH | Crystal Lathe | Anchorage pad 4 | R69 | Crystal optics, superconductors, precision contacts | 8.0 kW peak |
| VBY | Vessel Bay | Charging pad (exterior) | owned at start | Vessel modules only (HULL/PROP/UTIL/SENS) | 12 kW peak |
| PFB | Portable Fabricator | Field, TOOL slot | R44 | Subset: all T0-T1 consumables, Beacon, Drop Light, repairs, Power Cell Mk1 | 0.35 kW from cell |

The Anchorage's accretion cell supplies **4.5 kW continuous** with a **900 kJ** buffer, so two
stations can run concurrently; a third queues. Crafting draws power over the craft duration.
Power is never a fail state - a low buffer just stretches craft time by `demand/supply`, up to 3x.
The HUD shows a small power bar on the station panel. There is no separate "power management" minigame.

### 07.E.2 Tier definitions

| Tier | Gate | Materials available | Typical depth of operation |
|------|------|---------------------|----------------------------|
| T0 | Start | ferrite, cuprite, reefcalx, bladefibre, halite, quartz(surface float) | B0-B1, 0-30 m |
| T1 | Kiln + Cutter Mk1 | + cassite, magnesite, lithine, quartz(cut), fluorspar, carapace | B1-B3, 0-220 m |
| T2 | Cutter Mk2 + Suit Mk1 + Chem Bench | + rutile, galena, siphonsilk, lipid, clathrate, sulphpod, siderite | B3-B5, 90-950 m |
| T3 | Cutter Mk3 + Suit Mk2 + Lathe | + wolfram, iridis, beryl, kyanite, aurics, sporecap, marrowstone, ventgas | B5-B6, 480-1700 m |
| T4 | Suit Mk3 + Depth Hull B + Bore Mk2 path | + corund, voidglass, nyxite, chasmond | B7, 1700-2600 m |

### 07.E.3 THE FULL RECIPE TABLE

`Stn` = station. `t` = craft seconds. `E` = energy kJ. Outputs are quantity in parentheses.
"Unlock" conditions are evaluated continuously; a newly satisfied unlock plays a soft chime and
adds a `NEW` badge to the station panel.

#### Refined intermediates

| # | Output | Stn | T | Inputs | t (s) | E (kJ) | Unlock |
|---|--------|-----|---|--------|-------|--------|--------|
| R01 | Ferrite Ingot (1) | KIL | T0 | ferrite x2 | 6 | 40 | Build Kiln |
| R02 | Cupric Coil (1) | KIL | T0 | cuprite x2 | 7 | 45 | Build Kiln |
| R03 | Bronze Plate (1) | KIL | T1 | cuprite x3, cassite x1 | 12 | 90 | Possess cassite x1 |
| R04 | Titanium Plate (1) | KIL | T1 | rutile x3, magnesite x1 | 16 | 180 | Scan Rutile Outcrop x1 |
| R05 | Silica Glass (1) | KIL | T1 | quartz x2 | 10 | 120 | Possess quartz x2 |
| R06 | Lead Shield Sheet (1) | KIL | T2 | galena x3 | 14 | 150 | Reach d >= 220 m |
| R07 | Hardened Steel (1) | KIL | T2 | Ferrite Ingot x2, clathrate x1 | 18 | 200 | Scan Methane Hydrate Field x2 |
| R08 | Tungsten Carbide Bit (1) | KIL | T3 | wolfram x2, Hardened Steel x1 | 30 | 420 | Scan Wolfram Knot x2 |
| R09 | Superconductor Filament (1) | LTH | T3 | kyanite x2, aurics x1 | 26 | 500 | Scan Kyanite Spire x2 |
| R10 | Voidglass Lens (1) | LTH | T4 | voidglass x2, Silica Glass x1 | 40 | 900 | Scan Voidglass Flow x3 |
| R11 | Iridic Contact (1) | LTH | T3 | iridis x1, Cupric Coil x1 | 22 | 380 | Scan Sider Boulder x2 |
| R12 | Composite Laminate (1) | CHM | T2 | Titanium Plate x1, carapace x2, Bioresin x1 | 20 | 240 | Scan Plate Crawler x3 |

#### Chemistry, gels, salts, consumables

| # | Output | Stn | T | Inputs | t (s) | E (kJ) | Unlock |
|---|--------|-----|---|--------|-------|--------|--------|
| R13 | Synthfibre (2) | CHM | T1 | bladefibre x3 | 8 | 60 | Scan Bladewrack x2 |
| R14 | Bioresin (1) | CHM | T2 | lipid x2, sporecap x1 | 12 | 90 | Scan Oil Bladder Drifter x2 |
| R15 | Aerogel (1) | CHM | T3 | Silica Glass x1, ventgas x1 | 24 | 340 | Scan Glass Diatom Spire x4 |
| R16 | Oxygen Salt (2) | CHM | T1 | halite x3, magnesite x1 | 10 | 80 | Scan Brine Pool x2 |
| R17 | Thermal Gel (1) | CHM | T2 | lipid x2, sulphpod x1, halite x1 | 14 | 120 | Scan Vent Grazer x3 |
| R18 | Lumipaint (2) | CHM | T2 | lumigel x2, siphonsilk x1 | 9 | 70 | Scan Glowcap Anemone x2 |
| R19 | Electrolyte Paste (1) | CHM | T1 | lithine x3, halite x1 | 11 | 100 | Possess lithine x3 |
| R20 | Nutrient Block (2) | CHM | T1 | bladefibre x2, lipid x1, halite x1 | 8 | 50 | Scan Bladewrack x2 |
| R21 | Potable Water (2) | CHM | T1 | bladefibre x2 | 6 | 40 | Scan Bladewrack x2 |
| R22 | Clathrate Cell (1) | CHM | T2 | clathrate x3, Silica Glass x1 | 16 | 160 | Scan Methane Hydrate Field x2 |

#### Tools, power, light

| # | Output | Stn | T | Inputs | t (s) | E (kJ) | Unlock |
|---|--------|-----|---|--------|-------|--------|--------|
| R23 | Kit Chisel (1) | FAB | T0 | Ferrite Ingot x1, bladefibre x2 | 5 | 30 | Default (owned at start) |
| R24 | Scanner Mk1 (1) | FAB | T0 | Ferrite Ingot x1, quartz x1, Cupric Coil x1 | 8 | 60 | Default (owned at start) |
| R25 | Handlight (1) | FAB | T1 | Ferrite Ingot x1, fluorspar x1, Power Cell Mk1 x1 | 10 | 90 | Possess fluorspar x1 |
| R26 | Power Cell Mk1 (1) | FAB/PFB | T1 | Electrolyte Paste x1, Cupric Coil x1, Ferrite Ingot x1 | 12 | 110 | Craft Electrolyte Paste |
| R27 | Power Cell Mk2 (1) | FAB | T2 | Power Cell Mk1 x2, Titanium Plate x1, lithine x4 | 20 | 260 | Craft Titanium Plate |
| R28 | Power Cell Mk3 (1) | FAB | T4 | Power Cell Mk2 x2, Superconductor Filament x1, nyxite x1 | 45 | 1200 | Scan Nyxite Geode x4 |
| R29 | Pulse Cutter Mk1 (1) | FAB | T1 | Ferrite Ingot x2, Cupric Coil x2, quartz x1, Power Cell Mk1 x1 | 18 | 200 | Scan any VEI node x1 |
| R30 | Pulse Cutter Mk2 (1) | FAB | T2 | Pulse Cutter Mk1 x1, Titanium Plate x2, beryl x1, Power Cell Mk2 x1 | 26 | 420 | Possess beryl x1 |
| R31 | Pulse Cutter Mk3 (1) | FAB | T3 | Pulse Cutter Mk2 x1, Tungsten Carbide Bit x1, corund x1, Superconductor Filament x1 | 40 | 850 | Craft Tungsten Carbide Bit |
| R45 | Repair Torch (1) | FAB | T1 | Bronze Plate x1, Cupric Coil x2, Power Cell Mk1 x1 | 12 | 120 | Vessel hull integrity < 80 % once |
| R44 | Portable Fabricator (1) | FAB | T2 | Titanium Plate x2, Cupric Coil x3, Silica Glass x1, Power Cell Mk2 x1 | 28 | 400 | Craft Power Cell Mk2 |

#### Life support, mobility, suits

| # | Output | Stn | T | Inputs | t (s) | E (kJ) | Unlock |
|---|--------|-----|---|--------|-------|--------|--------|
| R32 | O2 Tank Std (75 L) (1) | FAB | T1 | Ferrite Ingot x2, Silica Glass x1 | 12 | 100 | Craft Silica Glass |
| R33 | O2 Tank High-Cap (160 L) (1) | FAB | T2 | Titanium Plate x2, Composite Laminate x1, Oxygen Salt x2 | 22 | 300 | Craft Composite Laminate |
| R34 | Rebreather (recycling, 0.55x burn) (1) | FAB | T3 | Composite Laminate x1, siphonsilk x3, Bioresin x2, Oxygen Salt x2 | 30 | 520 | Scan Siphon Worm x3 |
| R35 | Swim Fins (1) | FAB | T1 | Synthfibre x3, carapace x1 | 10 | 70 | Craft Synthfibre |
| R36 | Ultra Fins (1) | FAB | T2 | Swim Fins x1, carapace x2, Composite Laminate x1 | 18 | 220 | Craft Composite Laminate |
| R37 | Dive Suit Mk1 (crush 300 m) (1) | FAB | T1 | Synthfibre x4, carapace x3, Bronze Plate x2 | 24 | 260 | Scan Plate Crawler x3 |
| R38 | Dive Suit Mk2 (crush 750 m) (1) | FAB | T2 | Dive Suit Mk1 x1, Composite Laminate x2, Lead Shield Sheet x1, siphonsilk x4 | 32 | 480 | Reach d >= 260 m |
| R39 | Dive Suit Mk3 (crush 1800 m) (1) | FAB | T3 | Dive Suit Mk2 x1, Aerogel x2, Hardened Steel x2, beryl x2 | 48 | 900 | Reach d >= 700 m |
| R40 | Thermal Liner (1) | FAB | T3 | Thermal Gel x3, Synthfibre x3, Aerogel x1 | 26 | 400 | Take thermal damage once |
| R46 | Cargo Webbing (P1) (1) | FAB | T1 | Synthfibre x4, Bronze Plate x1 | 14 | 110 | Craft Synthfibre |
| R47 | Composite Harness (P2) (1) | FAB | T2 | Cargo Webbing x1, Composite Laminate x2, siphonsilk x3 | 22 | 280 | Craft Composite Laminate |
| R48 | Exo-Harness (P3) (1) | FAB | T3 | Composite Harness x1, Superconductor Filament x1, Titanium Plate x3, Power Cell Mk2 x1 | 34 | 620 | Craft Superconductor Filament |

#### Deployables and consumables

| # | Output | Stn | T | Inputs | t (s) | E (kJ) | Unlock |
|---|--------|-----|---|--------|-------|--------|--------|
| R41 | Beacon (1) | FAB/PFB | T1 | Ferrite Ingot x1, Cupric Coil x1, fluorspar x1 | 8 | 60 | Possess fluorspar x1 |
| R42 | Remote Locker (1) | FAB | T2 | Titanium Plate x2, Bronze Plate x2, Synthfibre x2 | 20 | 240 | Craft Titanium Plate |
| R43 | Drop Light (1) | FAB/PFB | T1 | Lumipaint x2, Ferrite Ingot x1, Power Cell Mk1 x1 | 9 | 80 | Craft Lumipaint |
| R49 | Medkit (1) | FAB/PFB | T2 | Bioresin x1, sporecap x1, Potable Water x1 | 10 | 60 | Scan Sporecap Bloom x3 |
| R50 | Stim Ampoule (1) | CHM | T3 | sporecap x2, lipid x1, Electrolyte Paste x1 | 12 | 90 | Scan Sporecap Bloom x3 |
| R51 | Flare (3) | FAB/PFB | T1 | magnesite x2, sulphpod x1 | 7 | 40 | Possess sulphpod x1 |
| R52 | Emergency Air Cartridge (2) | FAB/PFB | T1 | Oxygen Salt x2, Ferrite Ingot x1 | 8 | 60 | Craft Oxygen Salt |

#### Vessel modules (cross-reference section 04; slot classes per contract A5)

| # | Output | Slot | Stn | T | Inputs | t (s) | E (kJ) | Unlock |
|---|--------|------|-----|---|--------|-------|--------|--------|
| R53 | Vessel Bore Mk1 | UTIL | VBY | T2 | Pulse Cutter Mk2 x1, Titanium Plate x4, Hardened Steel x2, Power Cell Mk2 x2 | 60 | 1400 | Craft Pulse Cutter Mk2 |
| R54 | Vessel Bore Mk2 | UTIL | VBY | T4 | Vessel Bore Mk1 x1, Tungsten Carbide Bit x3, Voidglass Lens x1, Power Cell Mk3 x1 | 110 | 3600 | Craft Voidglass Lens |
| R55 | Depth Hull A (crush 600 m) | HULL | VBY | T2 | Titanium Plate x6, Composite Laminate x3, Bronze Plate x4 | 75 | 1600 | Vessel hull warning at d >= 180 m |
| R56 | Depth Hull B (crush 1400 m) | HULL | VBY | T3 | Depth Hull A x1, Hardened Steel x6, Aerogel x3, Lead Shield Sheet x2 | 95 | 2400 | Craft Aerogel |
| R57 | Depth Hull C (crush 2600 m) | HULL | VBY | T4 | Depth Hull B x1, wolfram x8, Voidglass Lens x2, beryl x4 | 130 | 4200 | Craft Voidglass Lens |
| R58 | Thruster Coil Mk2 | PROP | VBY | T3 | Superconductor Filament x2, Cupric Coil x8, Titanium Plate x3 | 80 | 1800 | Craft Superconductor Filament |
| R59 | Buoyancy Trim Cell | PROP | VBY | T3 | Aerogel x2, Clathrate Cell x2, Titanium Plate x2 | 55 | 1100 | Craft Clathrate Cell |
| R60 | Floodlight Array Mk2 | UTIL | VBY | T3 | beryl x2, fluorspar x6, Power Cell Mk2 x2 | 50 | 1000 | Reach d >= 480 m |
| R61 | Sonar Mapper | SENS | VBY | T3 | Iridic Contact x2, Silica Glass x3, Superconductor Filament x1 | 65 | 1500 | Craft Iridic Contact |
| R62 | Cargo Expansion I | (hold) | VBY | T2 | Titanium Plate x4, Synthfibre x6 | 45 | 700 | Craft Titanium Plate |
| R63 | Cargo Expansion II | (hold) | VBY | T3 | Cargo Expansion I x1, Composite Laminate x4, Hardened Steel x3 | 60 | 1300 | Fill V1 hold to M_hard once |
| R64 | O2 Recycler Upgrade | UTIL | VBY | T2 | Oxygen Salt x4, siphonsilk x5, Composite Laminate x2 | 50 | 800 | Craft Composite Laminate |
| R65 | Silent Hull Coating | UTIL | VBY | T3 | Bioresin x4, siphonsilk x6, Lumipaint x2 | 55 | 900 | Be detected by a B5+ apex creature 3 times |
| R66 | Nyx Resonator | SENS | VBY | T4 | nyxite x2, Superconductor Filament x2, Voidglass Lens x1 | 120 | 3000 | Scan Nyxite Geode x4 |
| R73 | Chasmond Bore Matrix | UTIL | VBY | T4 | chasmond x2, Tungsten Carbide Bit x2, Voidglass Lens x1 | 140 | 4000 | Mine chasmond x2 (post-Bore-Mk2 luxury; halves all bore times) |

#### Anchorage stations and upgrades

| # | Output | Stn | T | Inputs | t (s) | E (kJ) | Unlock |
|---|--------|-----|---|--------|-------|--------|--------|
| R67 | Accretion Kiln | FAB | T1 | ferrite x8, reefcalx x6, quartz x4 | 40 | 500 | Scan Reef Polyp Colony x3 |
| R68 | Chem Bench | FAB | T2 | Titanium Plate x3, Silica Glass x4, Cupric Coil x4 | 50 | 900 | Craft Titanium Plate |
| R69 | Crystal Lathe | FAB | T3 | Composite Laminate x2, beryl x2, Superconductor Filament x1, Hardened Steel x3 | 70 | 1800 | Possess kyanite x2 |
| R70 | Locker Expansion | FAB | T2 | Titanium Plate x3, Synthfibre x4 | 30 | 400 | Fill the base locker once |
| R71 | Charging Pad Upgrade | FAB | T3 | Superconductor Filament x2, Iridic Contact x1, Cupric Coil x6 | 60 | 1500 | Craft Iridic Contact |
| R72 | Map Table Nyx Link | FAB | T4 | nyxite x1, Silica Glass x3, Iridic Contact x1 | 55 | 1400 | Possess nyxite x1 |

**Total: 73 recipes** (R01-R73; R23 and R24 are craftable replacements for start-owned items).

### 07.E.4 Item property table for crafted goods

| Item | Grid | Mass (kg) | Stack | Key stats |
|------|------|-----------|-------|-----------|
| Ferrite Ingot | 1x1 | 2.9 | 20 | - |
| Cupric Coil | 1x1 | 2.5 | 20 | - |
| Bronze Plate | 1x1 | 3.2 | 20 | - |
| Titanium Plate | 1x1 | 2.1 | 20 | - |
| Silica Glass | 1x1 | 1.9 | 20 | - |
| Lead Shield Sheet | 1x1 | 6.4 | 10 | radiation/thermal shield 0.62 |
| Hardened Steel | 1x1 | 3.4 | 20 | - |
| Tungsten Carbide Bit | 1x1 | 5.8 | 8 | - |
| Superconductor Filament | 1x1 | 0.6 | 10 | - |
| Voidglass Lens | 1x1 | 2.2 | 8 | transmission 0.94, IOR 1.72 |
| Iridic Contact | 1x1 | 1.4 | 10 | - |
| Composite Laminate | 1x1 | 1.7 | 15 | - |
| Synthfibre | 1x1 | 0.4 | 30 | - |
| Bioresin | 1x1 | 0.9 | 20 | - |
| Aerogel | 1x1 | 0.1 | 15 | thermal R 0.94, buoyancy +0.8 N/unit |
| Oxygen Salt | 1x1 | 0.7 | 20 | 22 L O2 on decomposition |
| Thermal Gel | 1x1 | 1.1 | 20 | - |
| Lumipaint | 1x1 | 0.8 | 20 | - |
| Electrolyte Paste | 1x1 | 1.3 | 20 | - |
| Nutrient Block | 1x1 | 0.35 | 15 | +34 hunger, +2 hydration |
| Potable Water | 1x1 | 0.55 | 15 | +40 hydration |
| Clathrate Cell | 1x1 | 2.4 | 10 | 640 kJ chemical |
| Kit Chisel | 1x2 | 1.1 | 1 | see 07.C.1 |
| Scanner Mk1 | 1x2 | 0.9 | 1 | see 07.F |
| Handlight | 1x1 | 0.7 | 1 | 900 lm, 4900 K, 28 deg cone, 0.35 kJ/s |
| Power Cell Mk1 | 1x1 | 1.8 | 6 | 180 kJ |
| Power Cell Mk2 | 1x1 | 2.6 | 6 | 520 kJ |
| Power Cell Mk3 | 1x2 | 3.4 | 4 | 1600 kJ, self-recharges 0.6 kJ/s in daylight above y=-40 m |
| Pulse Cutter Mk1/2/3 | 2x2 | 2.4/3.1/3.8 | 1 | see 07.C.1 |
| Repair Torch | 1x2 | 1.6 | 1 | 8 HP/s to vessel hull, 0.7 kJ/s |
| Portable Fabricator | 2x2 | 4.2 | 1 | PFB station in the field |
| O2 Tank Std | 1x2 | 3.6 (full) | 1 | 75 L -> 225 s at rest at surface |
| O2 Tank High-Cap | 2x2 | 6.9 (full) | 1 | 160 L -> 480 s at rest at surface |
| Rebreather | 1x2 | 4.1 | 1 | 0.55x O2 burn rate multiplier, stacks with tank |
| Swim Fins | 1x2 | 1.2 | 1 | swim speed 3.2 -> 4.1 m/s |
| Ultra Fins | 1x2 | 1.6 | 1 | swim speed 3.2 -> 5.0 m/s, +18 % accel |
| Dive Suit Mk1/2/3 | 2x2 | 5.5/8.2/11.4 | 1 | crush depth 300/750/1800 m; thermal R 0.30/0.52/0.71 |
| Thermal Liner | 1x2 | 2.2 | 1 | +0.34 thermal R; survives 90 C water for 12 s |
| Cargo Webbing / Composite Harness / Exo-Harness | equipped, no cell cost | 1.9/3.1/6.8 | 1 | see 07.D.2 |
| Beacon | 1x1 | 2.1 | 8 | see 07.G.6 |
| Remote Locker | 2x2 | 14.0 | 4 | 4x4 grid, 240 kg |
| Drop Light | 1x1 | 1.4 | 10 | 900 lm, 5000 K, 22 m radius |
| Medkit | 1x1 | 0.5 | 10 | +55 HP over 4 s |
| Stim Ampoule | 1x1 | 0.3 | 10 | +45 % swim speed, -30 % O2 burn, 45 s, then -20 % speed for 30 s |
| Flare | 1x1 | 0.4 | 12 | 1400 lm, 2100 K, burns 90 s, works underwater (oxidiser-bound) |
| Emergency Air Cartridge | 1x1 | 0.8 | 8 | instant +18 L O2 |

### 07.E.5 ASCII dependency diagrams

The full graph is illegible as one picture. Five sub-graphs, each complete for its chain.
`==>` = requires the item. `-->` = requires the raw material. `[STN]` = station.

**Diagram 1: Material refinement backbone**

```
  ferrite ------> [KIL] R01 Ferrite Ingot ==============+============+
  cuprite ------> [KIL] R02 Cupric Coil ============+   |            |
  cassite -------------------------------+          |   |            |
                                         v          |   |            |
  cuprite ---------------------------> [KIL] R03 Bronze Plate        |
                                                                     |
  rutile ----+                                                       |
  magnesite -+--> [KIL] R04 Titanium Plate =========+                 |
                                                    |                 |
  quartz -------> [KIL] R05 Silica Glass =====+     |                 |
                                              |     |                 |
  galena -------> [KIL] R06 Lead Shield Sheet |     |                 |
                                              |     |                 |
  clathrate -----------------------------------------------------> [KIL] R07 Hardened Steel
                                              |     |                       ||
  wolfram ------------------------------------|-----|-----------------------++--> [KIL] R08 TC Bit
                                              |     |
  kyanite ---+                                |     |
  aurics ----+--> [LTH] R09 Supercon Filament |     |
                                              |     |
  voidglass -+--------------------------------+--> [LTH] R10 Voidglass Lens
                                                    |
  iridis ----+--> [LTH] R11 Iridic Contact          |
  (Cupric Coil)                                     |
                                                    v
  carapace --+--> [CHM] R12 Composite Laminate <----+ (Titanium Plate)
  Bioresin --+
```

**Diagram 2: Chemistry**

```
  bladefibre --+--> [CHM] R13 Synthfibre
               +--> [CHM] R20 Nutrient Block  (+ lipid, halite)
               +--> [CHM] R21 Potable Water

  lipid ---+
  sporecap-+-----> [CHM] R14 Bioresin ==========> R12 Composite Laminate, R49 Medkit, R65 Silent Coat

  Silica Glass -+
  ventgas ------+> [CHM] R15 Aerogel ==========> R39 Suit Mk3, R56 Hull B, R59 Trim Cell, R40 Liner

  halite ---+
  magnesite-+----> [CHM] R16 Oxygen Salt =====> R33 O2 HighCap, R34 Rebreather, R52 Air Cartridge, R64

  lipid + sulphpod + halite --> [CHM] R17 Thermal Gel ====> R40 Thermal Liner

  lumigel + siphonsilk ------> [CHM] R18 Lumipaint ======> R43 Drop Light, R65 Silent Hull Coating

  lithine + halite ----------> [CHM] R19 Electrolyte Paste => R26 Power Cell Mk1, R50 Stim

  clathrate + Silica Glass --> [CHM] R22 Clathrate Cell ==> R59 Buoyancy Trim Cell
```

**Diagram 3: Tool and power chain (the critical path)**

```
 T0                          T1                      T2                      T3                T4
 ---------------------------------------------------------------------------------------------------
 Kit Chisel (owned)
      |
      v
 [FAB] R67 Accretion Kiln
      |
      +--> R01/R02 ---> [FAB] R29 Pulse Cutter Mk1
                              |        ^
   R19 Electrolyte Paste      |        |
        |                     |        |
        v                     |        |
  [FAB] R26 Power Cell Mk1 ---+--------+
        |
        +---------------------------> [FAB] R27 Power Cell Mk2
                                            |        ^
   beryl (B5) ------------------------------|--------+
        |                                   |
        v                                   v
                                     [FAB] R30 Pulse Cutter Mk2
                                            |
                       R08 TC Bit ----------+
                       corund (B6/B7) ------+
                       R09 Filament --------+
                                            v
                                     [FAB] R31 Pulse Cutter Mk3 ==> the ONLY handheld that cuts
                                            |                       voidglass (H9) and corund (H9)
                                            |
   nyxite (B7) + R09 --------------> [FAB] R28 Power Cell Mk3
```

**Diagram 4: Survivability chain (what lets you go deeper)**

```
  DEPTH GATE          SUIT                  O2                    FINS            HARNESS
  ------------------------------------------------------------------------------------------
  0-300 m       R37 Dive Suit Mk1      R32 O2 Tank Std        R35 Swim Fins    R46 Cargo Webbing
                (carapace, bronze)     (ingot, glass)         (synth, cara)    (synth, bronze)
                      ||                     ||                    ||               ||
                      vv                     vv                    vv               vv
  300-750 m     R38 Dive Suit Mk2      R33 O2 High-Cap        R36 Ultra Fins   R47 Comp Harness
                (+CompLam, LeadSheet)  (+CompLam, OxySalt)    (+CompLam)       (+CompLam, silk)
                      ||                     ||                                    ||
                      vv                     vv                                    vv
  750-1800 m    R39 Dive Suit Mk3      R34 Rebreather                          R48 Exo-Harness
                (+Aerogel, HardSteel,  (+silk, Bioresin)                       (+Filament, PC2)
                 beryl)
                      ||
                      vv
  1800 m+       (vessel only - no suit survives B7 unprotected;
                 R40 Thermal Liner required within 6 m of any smoker)
```

**Diagram 5: Vessel module chain (see also section 04)**

```
   HULL:   [base] --> R55 Depth Hull A --> R56 Depth Hull B --> R57 Depth Hull C
             600 m           1400 m              2600 m
                              ^                    ^
                       (Aerogel, LeadSheet)  (wolfram x8, VoidLens x2, beryl x4)

   UTIL:   R53 Vessel Bore Mk1 --> R54 Vessel Bore Mk2 --> R73 Chasmond Bore Matrix
             (needs Cutter Mk2)      (needs VoidLens+PC3)     (needs chasmond x2)
           R60 Floodlight Array Mk2
           R64 O2 Recycler Upgrade
           R65 Silent Hull Coating

   PROP:   R58 Thruster Coil Mk2   R59 Buoyancy Trim Cell

   SENS:   R61 Sonar Mapper --> (enables Prospect Pulse Mk2)   R66 Nyx Resonator

   HOLD:   [V0 60 cells] --> R62 Cargo Expansion I (96) --> R63 Cargo Expansion II (140)
```

### 07.E.6 Crafting UX rules (BINDING)

- The station panel lists ALL recipes the player has unlocked, sorted by tier then alphabetically,
  with a filter toggle for "craftable now".
- Recipes the player has NOT unlocked are hidden entirely. There is no teasing greyed-out list -
  discovery is the reward loop and a locked list undercuts it. Exception: the **Databank** shows,
  for each scanned-but-not-fully-scanned subject, the count `2/3 SCANS` and the silhouette of the
  reward icon.
- Ingredient sourcing: the fabricator pulls from personal grid, then the Anchorage locker, then the
  vessel hold if the vessel is on the charging pad. Sources are shown as small glyphs next to each
  ingredient count.
- Crafting is INSTANT-COMMIT: ingredients are consumed at t=0. Cancelling refunds 100 %.
- A craft queue holds up to 8 jobs per station. Jobs continue while the player is away, including
  while sleeping (time compression applies).
- Deconstruction: any crafted item can be fed back into its station for `floor(0.60 * input_qty)`
  of each ingredient, taking `0.5 * craftTime`. Upgrade-chain items (e.g. Pulse Cutter Mk3)
  deconstruct one step, returning the Mk2 plus 60 % of the delta ingredients.

---

## 07.F - SCANNING AND RESEARCH

### 07.F.1 The Scanner

The Scanner Mk1 is a TOOL-slot handheld. It is owned at start (contract: the player must be able
to scan the first kelp within 90 seconds of the game beginning).

| Parameter | Scanner Mk1 | Scanner Mk1 + Sonar Mapper (R61, from inside the vessel) |
|-----------|-------------|----------------------------------------------------------|
| Range | 12.0 m | 18.0 m |
| Cone half-angle (must contain the subject's centroid) | 4.0 deg | 6.0 deg |
| Reticle tolerance (soft, for aim-assist) | 6.0 deg | 9.0 deg |
| Energy | 0.40 kJ/s | 0.40 kJ/s |
| Scan progress decay when the subject leaves the cone | 2.0x the accrual rate | 2.0x |
| Progress persistence between sessions | permanent, per-subject | permanent |

**Scan time by subject class:**

| Subject class | Example | Scan time (s) | Notes |
|---------------|---------|---------------|-------|
| Small flora | Glowcap Anemone | 2.0 | Stationary, trivial |
| Large flora | Bladewrack stipe, Glass Diatom Spire | 3.5 | Stationary |
| Mineral outcrop | Rutile Outcrop, Kyanite Spire | 2.5 | Stationary |
| Geological formation | Brine Pool, Methane Hydrate Field, Voidglass Flow | 6.0 | Large; requires standoff of 4-12 m |
| Small fauna | Lantern Shoal member | 3.0 | Moves; requires tracking |
| Medium fauna | Plate Crawler, Vent Grazer | 5.0 | Moves; may flee |
| Large fauna | Trench predators | 8.0 | Moves; dangerous |
| Apex / leviathan | B6-B7 apex archetypes | 12.0 | Extremely dangerous; scan from the vessel |
| Corpse / moult | any dead subject | 0.5x the live time | Safe alternative route; ALWAYS available |

**The corpse clause is important**: every fauna subject can be fully scanned from a carcass at half
time with no risk. This means no recipe is ever hard-locked behind a combat-shaped encounter, which
matters because SUBWAVE has no combat. Carcasses of every species spawn naturally in the world at
a rate of 1 per 6 ha per game-day in their native biome, and persist for 3 game-days.

### 07.F.2 Databank vs recipe unlock

Two separate thresholds per subject:

- **Entry threshold** (usually 1 scan): writes a databank page - name, a procedurally rendered
  turntable portrait (rendered once to a 512x512 texture and cached), depth range, behaviour notes,
  size, and a 3-5 sentence naturalist description. NO human framing, NO logs, NO "previous
  expedition" fiction. The prose is observational and first-person-neutral.
- **Unlock threshold** (2-5 scans): grants the recipe(s). Repeat scans must be of DISTINCT
  INDIVIDUALS (tracked by entity id) or, for static subjects, of instances at least 40 m apart.
  You cannot stand in front of one rock and scan it four times.

Scanning a subject already at max scans gives a small "already catalogued" chirp and no progress.

### 07.F.3 THE FULL UNLOCK MAP

| Subject id | Name | Class | Band | Entry | Unlock | Grants |
|------------|------|-------|------|-------|--------|--------|
| flo_bladewrack | Bladewrack | Large flora | B1-B2 | 1 | 2 | R13 Synthfibre, R20 Nutrient Block, R21 Potable Water |
| flo_reefpolyp | Reef Polyp Colony | Large flora | B1-B2 | 1 | 3 | R67 Accretion Kiln |
| flo_glowcap | Glowcap Anemone | Small flora | B3-B5 | 1 | 2 | R18 Lumipaint |
| flo_siphonworm | Siphon Worm (tube field) | Small fauna | B3-B5 | 1 | 3 | R34 Rebreather; enables siphonsilk harvest prompt |
| flo_sporecap | Sporecap Bloom | Small flora | B5-B7 | 1 | 3 | R49 Medkit, R50 Stim Ampoule |
| flo_glassdiatom | Glass Diatom Spire | Large flora | B5-B6 | 1 | 4 | R15 Aerogel |
| fau_platecrawler | Plate Crawler | Medium fauna | B2-B5 | 1 | 3 | R12 Composite Laminate, R37 Dive Suit Mk1 |
| fau_oildrifter | Oil Bladder Drifter | Small fauna | B3-B6 | 1 | 2 | R14 Bioresin |
| fau_lanternshoal | Lantern Shoal | Small fauna | B2-B4 | 1 | 2 | R43 Drop Light |
| fau_ventgrazer | Vent Grazer | Medium fauna | B4-B6 | 1 | 3 | R17 Thermal Gel |
| fau_trenchstalker | (B6 apex archetype A) | Apex | B6 | 1 | 2 | databank + 1/3 toward R65 |
| fau_seamdweller | (B7 apex archetype B) | Apex | B7 | 1 | 2 | databank + 1/3 toward R65 |
| fau_chasmdrifter | (B5 apex archetype C) | Large fauna | B5-B6 | 1 | 2 | databank + 1/3 toward R65 |
| geo_rutile | Rutile Outcrop | Mineral | B3-B5 | 1 | 1 | R04 Titanium Plate |
| geo_kyanite | Kyanite Spire | Mineral | B5-B6 | 1 | 2 | R09 Superconductor Filament |
| geo_wolfram | Wolfram Knot | Mineral | B6 | 1 | 2 | R08 Tungsten Carbide Bit |
| geo_sider | Sider Boulder | Mineral | B5-B6 | 1 | 2 | R11 Iridic Contact |
| geo_voidglass | Voidglass Flow | Formation | B7 | 1 | 3 | R10 Voidglass Lens |
| geo_nyxite | Nyxite Geode | Formation | B7 | 1 | 4 | R28 Power Cell Mk3, R66 Nyx Resonator |
| geo_brinepool | Brine Pool | Formation | B2-B4 | 1 | 2 | R16 Oxygen Salt |
| geo_hydrate | Methane Hydrate Field | Formation | B3-B6 | 1 | 2 | R07 Hardened Steel, R22 Clathrate Cell |
| geo_ossuary | Trench Ossuary | Formation | B6 | 1 | 2 | databank; enables marrowstone harvest prompt |
| geo_smoker | Black Smoker | Formation | B6-B7 | 1 | 2 | databank; enables the vessel plume-capture prompt for ventgas |
| geo_arch | Basalt Arch | Formation | B3-B5 | 1 | 1 | databank only |
| geo_glassforest | Glass Forest Stand | Formation | B5-B6 | 1 | 1 | databank only |

Notes:

- `R65 Silent Hull Coating` unlocks when **any 2 of the 3 apex archetypes** are fully scanned
  (2 each), OR by being detected 3 times (the alternative condition in R65). Two routes, so a
  player who refuses to approach apexes is never blocked.
- Recipes NOT gated by scanning (unlocked by possession, crafting, or depth) are exactly those
  in 07.E.3 whose Unlock column does not say "Scan". This is roughly 55 % of the tree - scanning
  is a major but not exclusive progression channel.
- The databank has a **Materials** tab (auto-populated on first acquisition of each material),
  a **Life** tab, a **Geology** tab, and a **Log** tab which records only the player's own
  waypoint annotations. There are no found documents. There is no other voice.

### 07.F.4 Scan VFX/SFX

- A pale cyan (140,220,255) wireframe progressively "paints" over the subject's mesh, driven by a
  world-space sweep plane travelling from the subject's lowest to highest point over the scan
  duration. Implemented as a `step(sweepY, worldPos.y)` mask in a dedicated forward pass.
- A ring reticle contracts from 90 px to 34 px over the scan.
- Audio: a granular sine ladder - one 60 ms sine grain every 90 ms, stepping up a whole-tone scale
  from 440 Hz, -26 dBFS. On completion, a two-note rise 880 -> 1320 Hz, 180 ms.
- On UNLOCK completion, an additional soft bell (FM: carrier 1174 Hz, modulator 1761 Hz,
  index 2.2, decay 1.6 s) and a HUD card slide-in naming the granted recipes.

---

## 07.G - THE HOME BASE: THE ANCHORAGE

### 07.G.1 In-fiction origin (BINDING; no humans, no society)

The Anchorage (internal id `A0`) is a **mineral-accretion shelter that the player themself seeded**.
On arrival the player set a seed unit on a basalt knoll on the lee side of the shallow reef and ran
a low-voltage current through the seawater; over forty days aragonite and brucite precipitated onto
a folding armature and grew a shell 0.35-0.60 m thick. This is real technology (electrolytic
mineral accretion / "biorock"), it involves no manufacturing, no supply chain, and no second person.

Constraints on the fiction (do not violate these in any asset, string, or model):

- The shell is **grown**, not built: no seams, no rivets, no panels, no printed labels, no logos,
  no signage. Interior surfaces are botryoidal carbonate with a faint pearlescent sheen.
- There is exactly one hard-fabricated object in the shelter: the seed unit itself, now the core of
  the Fabricator. It is a featureless matte-grey ovoid, 0.6 m long. It has no branding and no
  writing on it. It never speaks.
- **The player's origin is never stated.** No backstory text, no arrival cutscene narration,
  no "mission". The only thing established is that the player is alone, is the only one of
  whatever they are on this planet, and intends to remain alive. Anything more is the player's.
- No radio. No signal. No incoming transmission. No mystery-benefactor. Ever.

### 07.G.2 Siting and exterior layout (world coordinates, metres)

The home island (`isl_anchor`) is a low basalt-and-carbonate cay. All coordinates are world-space
per the project coordinate system (+X east, +Y up, +Z south, sea level y=0).

| Feature | Centre (x, y, z) | Extent | Notes |
|---------|------------------|--------|-------|
| Island footprint | (0, -, 0) | 210 m (E-W) x 165 m (N-S) at the waterline | Highest point y = +11.4 m at (-34, 11.4, -22) |
| Anchorage shell | (0, +1.60 floor, 0) | 9.4 m (E-W) x 7.6 m (N-S), apex y = +5.80 m | Floor plane at y = +1.60 m |
| Doorway | (-4.10, +1.60, -1.20) | 1.10 m wide x 2.05 m high | Faces WNW, opens to the beach path |
| Beach path | from doorway to (-16, +0.4, -6) | 1.8 m wide | Gentle 6 deg grade, crushed carbonate |
| Moonpool | (+2.10, 0.00, +2.30) | 3.40 m (E-W) x 2.60 m (N-S) opening | Water surface at y = 0; floor at y = -3.00 m |
| Moonpool exit arch | (+4.6, -1.7, +3.4) | 2.20 m wide x 1.60 m high | Opens into the lagoon at d = 1.7-3.0 m |
| Charging apron | (+9.50, +0.25, +4.00) | 7.00 m diameter disc | Accreted platform, 0.25 m above sea level |
| Apron approach lane | heading 118 deg from apron | 40 m x 14 m clear corridor | No terrain above y = +0.5 m within it |
| Salt pan (halite node field) | (-52, +0.6, +38) | 26 m x 19 m | The only B0 minable resource |
| Bladewrack shallows | (+38, -6, +52) | ~1.4 ha | First kelp, 60 nodes/ha, 40 s swim from the door |
| Reef rubble apron | ring at r = 55-90 m from island | ~2.1 ha | ferrite + reefcalx, the first mining ground |

**Safe-zone guarantee (BINDING).** Within a **220 m** radius cylinder about (0, *, 0), from
y = +40 m down to y = -45 m: no hostile fauna spawns, no ambient damage source, no thermal hazard,
no current strong enough to move the player, and no terrain edits are permitted. Section 05 must
respect this as a hard spawn exclusion volume. It is the promise the whole game rests on.

### 07.G.3 Interior layout (local frame: origin at floor centre, x east, z south, y up)

Interior floor plane 7.80 m (E-W) x 6.20 m (N-S), rounded rectangle with 1.4 m corner radii.
Ceiling 2.55 m at centre, falling to 1.90 m at the walls along a catenary rib profile.
Usable standing area (>= 2.0 m headroom): 5.9 x 4.4 m.

| Fixture | Local centre (x, z) | Footprint (m) | Height (m) | Interact radius | Anchor pad |
|---------|---------------------|---------------|------------|-----------------|------------|
| Fabricator (seed unit) | (-2.60, -1.90) | 1.10 x 0.70 | 1.90 | 1.20 m | PAD-1 (fixed) |
| Accretion Kiln | (-2.60, +0.40) | 1.30 x 0.90 | 1.60 | 1.20 m | PAD-2 |
| Chem Bench | (-2.55, +2.20) | 1.40 x 0.70 | 1.10 | 1.10 m | PAD-3 |
| Crystal Lathe | (+0.20, +2.40) | 1.20 x 1.20 | 1.40 | 1.20 m | PAD-4 |
| Storage Locker | (+2.90, -1.60) | 1.60 x 0.60 | 2.00 | 1.30 m | PAD-5 |
| Bed (save point) | (+2.60, +1.80) | 2.00 x 1.00 | 0.55 | 1.00 m | fixed |
| Map Table | (0.00, 0.00) | 2.20 x 1.40 | 0.95 | 1.60 m | fixed |
| Moonpool coaming | (+2.10, +2.30)* | 3.40 x 2.60 | 0.35 lip | - | fixed |
| Free pad | (-0.60, -2.20) | 1.40 x 1.00 | - | - | PAD-6 |

`*` the moonpool is partly outside the shell footprint; its coaming intersects the SE wall,
which is grown around it.

**Circulation check.** Minimum clear walkway width anywhere in the interior: **1.05 m**. The path
door -> Fabricator -> Map Table -> Bed -> Moonpool is a single loop with no dead ends. Player
capsule radius is 0.36 m, so this is comfortable at 1.05 m and never catches on geometry.

**Map Table.** A 2.20 x 1.40 m carbonate plinth. Above it floats a volumetric hologram
2.00 x 1.20 x 0.70 m rendering the explored world as a signed-distance heightfield with the
player's discovered biomes tinted. Rendered as 96 raymarch steps into a 256x64x256 `r8unorm`
"explored" volume that is written every 2 s from the player's position with a 240 m brush.
The hologram is emissive cyan (60,190,255), peak 40 nits, and contributes 90 lm of practical light.
Interactions: pan/zoom/rotate, place and rename up to 32 waypoints (18 chars each),
toggle beacon visibility, and read the depth under the cursor.

**Bed.** Interacting sleeps until 06:30 or for a chosen 2/4/8 game-hour block. Sleeping:
writes a full save, restores 100 % health, sets hunger/hydration floor at 45 %, advances the craft
queue, advances node respawn timers, and advances fauna cycles. The bed is the ONLY manual save;
autosave additionally fires on entering/exiting the vessel, on depth-band transitions, and every
4 real minutes.

**Storage Locker.** 12 x 8 = 96 cells base, 2400 kg. With R70 Locker Expansion: 16 x 10 = 160 cells,
4000 kg. Contents are readable by the Fabricator from anywhere in the Anchorage.

**Charging pad.** Inductive, 12 kW, air-gap tolerant to 0.4 m. Charges the vessel's cell from
0 to 100 % in **6.0 real minutes** (360 s), or 3.4 minutes with R71 Charging Pad Upgrade (22 kW).
While docked, the vessel's hold is accessible from the Fabricator and its O2 reserve refills at
40 L/s. The pad also acts as the VBY crafting station.

### 07.G.4 Lighting (exact)

All Anchorage lights are procedurally emissive carbonate photophore strips, in-fiction colonised by
the same luminous bacteria that mark the ore nodes. Nothing is a lamp; nothing is manufactured.

| Light id | Type | Position (local) | Colour | Temp | Flux | Notes |
|----------|------|------------------|--------|------|------|-------|
| A0_RIB_N | Emissive strip | rib line along z = -2.6, x in [-3.2, +3.2] | 255,214,170 | 3200 K | 180 lm/m x 6.4 m = 1152 lm | Not shadow-casting |
| A0_RIB_S | Emissive strip | rib line along z = +2.6, same span | 255,214,170 | 3200 K | 1152 lm | Not shadow-casting |
| A0_FAB | Spot | (-2.60, 1.85, -1.90), aimed -Y | 255,244,232 | 4800 K | 320 lm | 55 deg cone, SHADOW CASTING |
| A0_MAP | Emissive volume | Map Table hologram | 60,190,255 | - | ~90 lm equivalent | 40 nits peak |
| A0_BED | Point | (+2.60, 1.70, +1.80) | 255,180,120 | 2200 K | 60 lm | Dimmable 0-100 %, default 30 % |
| A0_POOL | Point (underwater) | (+2.10, -0.90, +2.30) | 190,235,255 | 6200 K | 240 lm | Caustic projector enabled |
| A0_APRON_1..4 | Point | apron rim at 0/90/180/270 deg, r = 3.2 m, y = +0.55 | 255,168,60 | 2000 K | 90 lm each | Pulse 0.25 Hz, 60-100 % |
| A0_DOOR | Point | (-4.10, 2.20, -1.20) | 255,200,150 | 2700 K | 120 lm | Only lit at night |

Shadow budget: exactly **2 shadow-casting lights** in the Anchorage (A0_FAB and the sun/moon).
Everything else is unshadowed. This holds the interior to a single 1024x1024 shadow atlas tile.

**Night visibility.** The apron lights and A0_DOOR give the Anchorage an apparent magnitude
sufficient to be seen from **600 m** at night at sea level, and from **1400 m** at 200 m altitude.
This is a hard requirement: the player must always be able to find home from the air.

### 07.G.5 What the player CAN and CANNOT modify

**CAN:**

| Action | Detail |
|--------|--------|
| Place / remove crafted stations | On any of the 6 anchor pads (PAD-1 is permanently the Fabricator). Removing returns 100 % of ingredients. |
| Upgrade the locker | R70, one-way |
| Upgrade the charging pad | R71, one-way |
| Upgrade the map table | R72, adds a "resonance overlay" that marks known B7 nyxite/chasmond sites |
| Toggle lights | Master switch, per-fixture switch, and a colour-temperature slider 2000-5500 K on the rib strips |
| Recolour the shell | With Lumipaint: 5 tints (pearl, amber, jade, violet, ink) applied to the emissive rim only |
| Store items | Locker, and freely on the floor (physics objects, up to 40 loose items before the oldest despawns) |
| Sleep | Bed, advances time |
| Annotate the map | Up to 32 named waypoints |

**CANNOT:**

| Action | Reason |
|--------|--------|
| Move, rotate, resize or delete the shell | The safe zone is a fixed promise; moving it would break the 220 m spawn exclusion and the terrain no-edit volume |
| Build rooms, corridors, hatches or additional modules | SUBWAVE is not a base-building game. Every hour spent on base building is an hour not spent on the ocean, and the art budget for procedural interiors is spent on biomes instead |
| Place stations off-pad | Bounds navmesh, lighting, and collision authoring to 6 known configurations |
| Build a second Anchorage | There is exactly one seed unit and it is the Fabricator. Remote Lockers and Beacons are the sanctioned forward-base answer |
| Damage or destroy the Anchorage | It is invulnerable to all damage sources including the vessel colliding with it |
| Terraform within 30 m | See 07.C.4 no-edit zone 1 |

### 07.G.6 Deployables (the forward-base answer)

| Deployable | Recipe | Size | Mass | Capacity / effect | Max active | Lifetime | Placement rule |
|------------|--------|------|------|-------------------|------------|----------|----------------|
| Beacon | R41 | 0.40 m ovoid | 2.1 kg | HUD marker, 18-char label, colour from 8 presets | 12 | 30 game-days (600 real min), then blinks amber for 1 day and dies | Any surface with slope < 55 deg, or free-floating (holds depth +-0.3 m) |
| Remote Locker | R42 | 0.90 x 0.70 x 1.10 m | 14.0 kg | 4 x 4 = 16 cells, 240 kg | 8 | Permanent | Surface slope < 35 deg; >= 15 m from another locker; >= 6 m no-edit halo |
| Drop Light | R43 | 0.25 m sphere | 1.4 kg | 900 lm, 5000 K, 22 m useful radius | 24 | 6 game-days (120 real min) | Free-floating, neutrally buoyant at drop depth +-0.5 m; drifts with local current at 0.25x |
| Salvage Cache | (auto) | 0.55 m bundle | - | Whatever you died with | 3 | Permanent | Death position, snapped to surface within 6 m |

- Beacons and Drop Lights can be retrieved (hold E for 1.0 s) for a 100 % refund of the item.
- Remote Lockers can be retrieved only when empty.
- All deployables are stored in IndexedDB store `deployables`:
  `{ id, kind:u8, pos:[f32;3], rot:[f32;4], label:string, colour:u8, created:f64, items:[...] }`.
- Deployables render with the same instanced prop pass as ore nodes and count against the node
  instance budget (07.B.3). At LOW quality the cap on simultaneously visible deployables is 24.
- A Beacon within 40 m of another Beacon merges into a single HUD cluster marker showing the count,
  to keep the windshield readable.

---

## 07.H - ECONOMY BALANCE

### 07.H.1 The throughput model

Two regimes, and the transition between them is the point of the whole progression.

```
// Regime 1: TRIP-LIMITED (on foot / swimming, bands B1-B2)
unitsPerTrip  = M_soft / meanUnitMass
nodesPerTrip  = unitsPerTrip / meanUnitsPerNode
cycleSeconds  = nodesPerTrip * secondsPerNode + returnTripSeconds
UI_per_hour   = 3600 * unitsPerTrip * meanUI / cycleSeconds

// Regime 2: MINING-LIMITED (vessel hold, bands B3-B7)
// The hold is large enough that the return trip amortises to a few percent.
nodesPerHour  = 3600 / secondsPerNode
UI_per_hour   = nodesPerHour * meanUnitsPerNode * meanUI * (1 - returnOverheadFraction)

// secondsPerNode = travelBetweenNodes + align + mine + pickup
// travelBetweenNodes = meanNodeSpacing / sweepSpeed
```

`meanNodeSpacing` is derived from the band's summed `rho_n` over a realistic sweep that skips
materials the player is not currently interested in:
`spacing = sqrt(10000 / rho_total) * routeInefficiency`, `routeInefficiency = 1.55`.

### 07.H.2 Income per hour by depth band (BROAD SWEEP: take everything)

Assumes the tier-appropriate tool from 07.C, the tier-appropriate harness/hold, and a competent
but not optimal player.

| Band | Gear assumed | rho_tot (nodes/ha) | Spacing (m) | Sweep spd (m/s) | Travel (s) | Mine (s) | Pickup (s) | s/node | Regime | Units/trip | Cycle (s) | Units/hr | Mean UI/unit | **UI/hr** |
|------|--------------|--------------------|-------------|-----------------|------------|----------|------------|--------|--------|------------|-----------|----------|--------------|-----------|
| B1 | Chisel/Mk1, P0 (60 kg) | 118 | 45.1 | 3.20 | 14.1 | 3.5 | 1.2 | 18.8 | trip | 46 | 388 | 427 | 1.5 | **640** |
| B2 | Mk1 + Fins, P1 (95 kg) | 96 | 50.0 | 4.10 | 12.2 | 4.2 | 1.2 | 17.6 | trip | 79 | 665 | 428 | 2.2 | **942** |
| B3 | Mk2 + Suit Mk1 + vessel V0 | 78 | 55.5 | 5.50 | 10.1 | 3.8 | 1.4 | 15.3 | mining | (hold) | - | 588 | 3.6 | **2117** |
| B4 | Mk2/Mk3 + Suit Mk2 + V0 | 58 | 64.3 | 6.00 | 10.7 | 6.0 | 1.5 | 18.2 | mining | (hold) | - | 415 | 6.4 | **2656** |
| B5 | Mk3 + Suit Mk2 + V1 hold + Bore Mk1 | 41 | 76.5 | 7.50 | 10.2 | 7.5 | 1.6 | 19.3 | mining | (hold) | - | 354 | 11.5 | **4071** |
| B6 | Mk3 + Suit Mk3 + Hull B + V1/V2 | 28 | 92.6 | 8.50 | 10.9 | 9.0 | 1.8 | 21.7 | mining | (hold) | - | 265 | 21.0 | **5565** |
| B7 | Bore Mk2 + Hull C + Suit Mk3 + Liner | 17 | 118.9 | 9.00 | 13.2 | 11.0 | 2.0 | 26.2 | mining | (hold) | - | 192 | 44.0 | **8448** |

Return-trip overhead already folded in: B3 -0.049, B4 -0.075, B5 -0.11, B6 -0.16, B7 -0.24
(the deeper you are, the longer the climb home, and B7 also costs a hull-integrity cooldown).
`Units/hr` for mining-limited bands = `3600/s_per_node * meanUnitsPerNode * (1 - overhead)`.

Sanity check on the numbers a player will feel:

- B1: a node every ~19 seconds, 46 units per swim-out, about 8 trips an hour. Correct: the shallows
  should feel abundant and slightly tedious to haul, which is exactly the pressure that sells the
  vessel and then the Cargo Webbing.
- B7: a node every 26 seconds, but each is worth 44 UI. A single `nyxite` geode (90 UI, 4.8 s with
  Bore Mk2) pays for more than a minute of B1 labour. The value gradient across the ocean's depth
  is **13.2x** from B1 to B7, against a time-per-node gradient of only **1.4x**. Depth is always
  the right answer, which is the correct incentive for an exploration game.

### 07.H.3 Income per hour: TARGETED FARM (chasing one specific material)

When a recipe needs `wolfram x8`, the player skips everything else. Effective throughput drops
because they are travelling past nodes they do not stop for.

`targetedEfficiency = rho_target / rho_tot` raised to 0.45 (route optimisation partially
compensates), floored at 0.30.

| Band | Broad UI/hr | Typical targetedEfficiency | **Targeted UI/hr** | Example target |
|------|-------------|----------------------------|--------------------|----------------|
| B1 | 640 | 0.85 | 544 | ferrite |
| B2 | 942 | 0.72 | 678 | carapace |
| B3 | 2117 | 0.62 | 1313 | rutile |
| B4 | 2656 | 0.55 | 1461 | fluorspar, sulphpod |
| B5 | 4071 | 0.42 | 1710 | kyanite, beryl |
| B6 | 5565 | 0.36 | 2003 | wolfram |
| B7 | 8448 | 0.32 | 2703 | nyxite, voidglass, corund |

### 07.H.4 Cost of the progression path

UI cost is computed by fully expanding every recipe to raw materials (deconstruction refunds and
partial crafts ignored - this is the honest gross figure).

| Tier package | Contents | Gross UI | Farm band mix | Effective UI/hr | **Hours** |
|--------------|----------|----------|---------------|-----------------|-----------|
| T0 -> T1 | Kiln, Cutter Mk1, Power Cell Mk1 x2, O2 Tank Std, Swim Fins, Dive Suit Mk1, Handlight, Cargo Webbing, Beacon x2, misc consumables | 216 | B1/B2 | 610 | **0.35** |
| T1 -> T2 | Cutter Mk2, Power Cell Mk2, O2 High-Cap, Ultra Fins, Suit Mk2, Chem Bench, Composite Harness, Portable Fabricator, Remote Locker x2, Vessel Bore Mk1, Depth Hull A, Cargo Expansion I, O2 Recycler Upg | 2052 | B2/B3 | 1000 | **2.05** |
| T2 -> T3 | Cutter Mk3, Suit Mk3, Rebreather, Thermal Liner, Exo-Harness, Crystal Lathe, Depth Hull B, Thruster Coil Mk2, Buoyancy Trim, Floodlight Mk2, Sonar Mapper, Cargo Expansion II, Silent Coating, Charging Pad Upg | 3104 | B4/B5 | 1590 | **1.95** |
| T3 -> T4 | Power Cell Mk3, Voidglass Lens x4, Vessel Bore Mk2, Depth Hull C, Nyx Resonator, Map Table Nyx Link | 3370 | B6/B7 | 2350 | **1.43** |
| T4 optional | Chasmond Bore Matrix | 358 | B7 | 2703 | 0.13 |
| **TOTAL (critical path)** | | **8742** | | | **5.78 h** |

### 07.H.5 Is the curve right?

**Pure resource-acquisition time on the critical path: 5.8 hours.**

Total expected playtime to reach T4 is much larger, because acquisition is only one of five
activities. Expected time budget for a first playthrough:

| Activity | Hours | Share |
|----------|-------|-------|
| Resource acquisition (07.H.4) | 5.8 | 28 % |
| Exploration, navigation, finding the biomes at all | 6.5 | 31 % |
| Scanning subjects for unlocks (25 subjects, mean 3.1 scans, plus travel to find them) | 2.4 | 12 % |
| Travel to/from the Anchorage and crafting downtime | 2.9 | 14 % |
| Deaths, retrieval, hazard avoidance, exploratory dead ends | 3.1 | 15 % |
| **TOTAL to T4** | **20.7 h** | |

Grindiness test (both must pass):

1. **No single tier package requires more than 2.1 hours of pure farming.** PASS - max is 2.05 h
   (T1->T2), and that package spans a change of biome, a change of tool, a change of suit and the
   acquisition of the vessel bore, so the 2 hours are spread across four visibly different goals.
2. **No single material requires more than 25 minutes of targeted farming for the whole game.**
   Check the worst offenders:

| Material | Total needed across the WHOLE critical path | Nodes needed | s/node at the relevant tier | Targeted minutes |
|----------|--------------------------------------------|--------------|------------------------------|------------------|
| wolfram | 8 (Hull C) + 6 (TC Bit x3) = 14 | 14 | 21.7 / 0.36 eff = 60.3 | 14.1 |
| voidglass | 8 (4 lenses) | 5 | 26.2 / 0.32 = 81.9 | 6.8 |
| nyxite | 4 (PC Mk3 x1, Nyx Resonator x2, Map Link x1) | 4 | 26.2 / 0.32 = 81.9 | 5.5 |
| beryl | 1 (Mk2) + 2 (Suit Mk3) + 4 (Hull C) + 2 (Lathe) = 9 | 6 | 19.3 / 0.42 = 46.0 | 4.6 |
| kyanite | 2 per Filament x 6 Filaments = 12 | 8 | 19.3 / 0.42 = 46.0 | 6.1 |
| corund | 1 (Cutter Mk3) | 1 | 26.2 / 0.32 = 81.9 | 1.4 |
| iridis | 1 (Iridic Contact) x 4 = 4 | 4 (needs ~18 siderite boulders at 22 %) | 21.7 / 0.30 = 72.3 | 21.7 |
| rutile | ~33 (Ti Plates x11) | 15 | 15.3 / 0.62 = 24.7 | 6.2 |

PASS - worst case is `iridis` at 21.7 minutes, and that is a probabilistic hunt through a
scatter field, i.e. an activity with texture, not a click-and-wait. It is under the 25 min bar.

Triviality test:

3. **No tier package is obtainable in under 15 minutes of farming.** PASS except T0->T1 at 21 min,
   which is correct - the first tier must be fast so the player is off the island inside the
   first hour.
4. **The terminal band must be worth reaching for reasons other than the last hull.** PASS:
   B7 pays 8448 UI/hr broad, has the only `nyxite` and `chasmond`, and hosts the game's only
   optional post-completion upgrade (R73).

### 07.H.6 Finite-resource budget (world seed guarantee)

`NEVER`-respawn materials are finite. The world generator MUST guarantee, over the whole
playable world volume, at least the following counts, and the generator has a post-pass that
injects additional nodes into the least-dense qualifying chunks if a count falls short:

| Material | Guaranteed minimum nodes | Guaranteed minimum units | Critical path needs | Safety factor |
|----------|--------------------------|--------------------------|---------------------|---------------|
| siderite | 900 | 1350 | ~20 | 67x |
| iridis | 198 (22 % of siderite) | 198 | 4 | 49x |
| wolfram | 260 | 260 | 14 | 18.6x |
| beryl | 420 | 630 | 9 | 70x |
| kyanite | 560 | 840 | 12 | 70x |
| corund | 170 | 170 | 1 | 170x |
| voidglass | 240 | 360 | 8 | 45x |
| nyxite | 74 | 74 | 4 | 18.5x |
| chasmond | 62 | 62 | 2 (optional only) | 31x |

The tightest safety factors are `nyxite` (18.5x) and `wolfram` (18.6x). Both are comfortably
above the 10x floor the design requires, so no reasonable amount of experimentation, waste,
or lost caches can soft-lock a player out of T4.

If a save file's remaining count for any critical material would drop below `needed - already_crafted`,
the generator's post-pass injects one replacement node per game-day in the deepest unexplored
qualifying chunk. This is a silent safety net; it is never surfaced to the player.

### 07.H.7 Persistence summary for section 09

| Store | Key | Value | Est. size | Notes |
|-------|-----|-------|-----------|-------|
| `inventory` | 'player' | grid contents, equipment slots, harness tier | 4 KB | localStorage mirror for fast boot |
| `containers` | containerId | grid contents | 2-40 KB each | Anchorage locker, vessel hold, remote lockers |
| `depletedNodes` | regionKey (8x8x8 chunks) | packed `Uint32Array` blocks of `(idLo, idHi, tQuant, chunk)` | up to 3.2 MB total | Cap 200,000, LRU-evict respawnable entries |
| `terrainEdits` | chunkKey | `Uint8Array` of 16-byte edit records | up to 4.0 MB total | Compacts to delta textures at 512 edits |
| `terrainDeltas` | chunkKey | `Int8Array` 34^3 | 39.3 KB each, max 400 chunks | 15.7 MB cap |
| `deployables` | deployableId | see 07.G.6 | < 200 KB | |
| `caches` | cacheId | see 07.D.6 | < 60 KB | Max 3 |
| `research` | 'db' | scan counts per subject, unlocked recipe id set | < 8 KB | localStorage mirror |
| `craftQueue` | stationId | queued jobs with start times | < 2 KB | |
| **Total worst case** | | | **~23 MB** | Well inside a typical 50+ MB IndexedDB quota |

---

## 07.I - OPEN QUESTIONS FOR OTHER SECTIONS

1. Section 03 must confirm the biome id list matches 07.A.2 and expose `hostYieldPerM3` per biome.
2. Section 04 must confirm the four upgrade slot classes and slot counts (contract A5) and accept
   the overweight multipliers in 07.D.4 as its inputs.
3. Section 05 must confirm the 25 scan subjects in 07.F.3 exist, with matching bands, and must
   implement the natural-carcass spawn rate of 1 per 6 ha per game-day.
4. Section 06 must confirm the 20-real-minute game day (contract A7) - all respawn and deployable
   lifetimes in this section are expressed in both units and will need a single-constant edit if it changes.
5. Section 06 owns the O2 burn base rate; 07 only supplies the tank volumes and the Rebreather's
   0.55x multiplier.
6. Section 10 must confirm the 48-byte instance struct and the per-quality node budgets in 07.B.3.

--- END OF SECTION 07 ---
