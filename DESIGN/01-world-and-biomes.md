# SUBWAVE - DESIGN 01: WORLD LAYOUT, MAP, DEPTH BANDS & BIOMES

Status: BINDING. Revision 1.0.
Scope: everything that answers "where am I, how deep, how dark, what grows here, what lives here".

This document owns: world extent, the soft boundary, the bathymetric field, the named region
partition, the safe start crater, the depth-band light/pressure/visibility model, the biome
catalogue, the biome mask function, biome blending, and hand-placed landmarks.

This document does NOT own: terrain meshing/LOD implementation, creature AI and stats, vessel
physics, crafting recipes, audio synthesis DSP graphs, save format. It DECLARES ids and numeric
placement data that those sections must consume verbatim.

---

## 0. CONVENTIONS (restated, binding)

| Item | Value |
|---|---|
| Handedness | Right-handed |
| +X | East |
| +Y | Up |
| +Z | South |
| Unit | metre (m) |
| Sea level | y = 0.000 exactly |
| Depth | d = -y, positive downward, metres |
| Altitude | a = +y, positive upward, metres |
| Heading | 0 deg = north (-Z), +90 deg = east (+X), clockwise seen from above |
| Angles | radians internally; degrees only in UI strings |
| Colour | All RGB triplets in this document are sRGB 8-bit (0-255) unless suffixed `lin` |
| Linearisation | `lin = ((s/255 + 0.055)/1.055)^2.4` for s > 10.31, else `s/255/12.92` |
| Seed | `WORLD_SEED = 0x5B7A19C4` (uint32). All noise in this doc derives from it |
| Wavelength triple | R = 650 nm, G = 550 nm, B = 450 nm (used for all absorption maths) |

Terminology: **band** = horizontal depth stratum (Surface, Sunlit, ...). **region** = a named
macro-area of the map with XZ bounds. **biome** = a material/flora/fauna/audio ruleset selected
per surface point. A region contains one dominant biome plus incursions; a biome can appear in
several regions.

**HARD RULE, NO EXCEPTIONS:** there are zero human artifacts in this world. No wrecks, no ruins,
no tools, no writing, no lights other than the player's own, no signal sources. Every structure
that reads as "made" must be geology (columnar basalt, karst, evaporite, crystal) or biology
(skeletons, reefs, sponges, burrows, chimneys). Any asset request that implies a prior
civilisation is rejected at review.

---

## 1. WORLD EXTENT

### 1.1 Playable extent

| Quantity | Value |
|---|---|
| Playable footprint | 6144 m x 6144 m, axis-aligned, centred on the origin |
| X range | -3072.0 m .. +3072.0 m |
| Z range | -3072.0 m .. +3072.0 m |
| Area | 37.75 km^2 |
| Terrain minimum | y = -1605 m (floor of The Draw at its SE terminus) |
| Terrain maximum | y = +188 m (tip of the Windcut Needle) |
| Water body | Single global ocean plane at y = 0, infinite in extent for rendering |
| Vertical simulation volume | y in [-1650, +1200] |
| Soft flight ceiling | y = +900 m |
| Hard flight ceiling | y = +1100 m |
| Hard depth floor | y = -1650 m (below terrain everywhere; a safety clamp only) |

### 1.2 Why 6144 m x 6144 m

The number is chosen from four independent constraints that all land in the same place.

**(a) Heightfield memory.** 6144 m at a 2.0 m base sample pitch is a 3073 x 3073 grid.
Stored as `r16float` with a global scale/bias (`y = h16 * 0.0500 - 1650.0`, quantisation step
50 mm) that is 3073^2 * 2 B = **18.88 MB** resident, which fits comfortably beside the rest of
our VRAM budget on an 8 GB integrated part. The next power-of-two step up (12288 m) would be
75.5 MB and a 0.5 m pitch would be 302 MB; both are rejected. Sub-2 m detail is added
procedurally at meshing time from noise, so the 2 m pitch costs no visual fidelity.

**(b) Chunk grid.** 6144 / 64 = **96 x 96 = 9216 chunks** of 64 m. 96 factors as 2^5 * 3, so
chunk indices fit in 7 bits per axis and a whole-world chunk bitmask is 9216 bits = 1152 B, small
enough to keep in a uniform buffer for streaming decisions. At the coarsest LOD (5 x 5 vertices
per chunk, 16 m spacing) the entire world is 9216 * 25 = 230 400 vertices, i.e. the whole planet
surface can be drawn in a single indirect draw when the player is at 900 m altitude. This is the
decisive argument: the vessel flies, so the world must be renderable in full from the air.

**(c) Traversal time.** Vessel cruise speeds (see section 03) are 42 m/s in air and 14 m/s
submerged.

| Journey | Distance | Air time | Submerged time |
|---|---|---|---|
| Start beach to shelf break (S) | 1 700 m | 40 s | 121 s |
| Start beach to Emberfield vents | 2 200 m | 52 s | 157 s |
| Start beach to The Draw mouth | 2 400 m | 57 s | 171 s |
| Start beach to hadal terminus | 4 900 m | 117 s | 350 s |
| Full world edge to edge | 6 144 m | 146 s | 439 s |
| Full world corner to corner | 8 688 m | 207 s | 621 s |

A two-minute flight across the entire world reads as "a large island province", not "a planet",
which is exactly the intended scale. Larger and the empty water between set-pieces becomes dead
time; smaller and the 1600 m trench cannot be given a plausible run-out.

**(d) Content density.** 25 biomes and 22 landmarks over 37.75 km^2 gives one authored point of
interest every ~1.7 km^2, or roughly one every 45 s of submerged travel. That is the density we
want for exploration pacing.

### 1.3 Soft boundary - "the Verge"

The playable area is bounded by a rounded square, not a wall.

```
BOUNDARY_HALF     = 3072.0            // m, half-extent of the playable square
BOUNDARY_ROUND    = 900.0             // m, corner rounding radius
SOFT_BAND         = 256.0             // m, width of the deterrent band
HARD_OVERSHOOT    = 40.0              // m, absolute clamp beyond the boundary

// signed distance to the rounded-square boundary; negative inside
function vergeSDF(x, z) {
  let qx = abs(x) - (BOUNDARY_HALF - BOUNDARY_ROUND);
  let qz = abs(z) - (BOUNDARY_HALF - BOUNDARY_ROUND);
  let ax = max(qx, 0.0), az = max(qz, 0.0);
  return length(vec2(ax, az)) + min(max(qx, qz), 0.0) - BOUNDARY_ROUND;
}

// deterrent scalar, 0 well inside, 1 at the boundary
b = clamp((vergeSDF(x, z) + SOFT_BAND) / SOFT_BAND, 0.0, 1.0);
```

Effects, all driven by `b`:

| Effect | Formula | Cap |
|---|---|---|
| Inward acceleration on any body | `a_in = 3.00 * b^2` m/s^2 along -normalize(gradient(vergeSDF)) | 3.00 m/s^2 |
| Visibility collapse | `sigma_e *= (1.0 + 7.0 * b)` | visibility floor 9 m |
| Above-water: downdraft | `a_y = -4.5 * b^2` m/s^2 | -4.5 m/s^2 |
| Above-water: turbulence | RMS gust 1.5 + 11.0*b m/s, band 0.15-2.4 Hz | 12.5 m/s |
| Audio | `amb_verge` bed crossfades in over `b` in [0.10, 0.55] | -14 LUFS |
| HUD | "STANDING FRONT" caution glyph at b > 0.15, hard warning at b > 0.55 | - |
| Hard clamp | if `vergeSDF > HARD_OVERSHOOT`, project position to the SDF isosurface at +40 m and zero the outward velocity component | - |

**Diegetic justification (no humans, no invisible walls).** The island province sits inside a
permanent mesoscale gyre. At the Verge, a hypersaline density front meets the gyre wall: below
water this is a shimmering, particle-loaded shear layer that scatters light into an opaque
blue-grey and drags anything entering it back along the current; above water the same front
drives a standing ring of downdraft, cloud and rain. It is weather and physical oceanography, not
a fence. Players who push into it get pushed back, blinded, and buffeted - never teleported.

**Beyond the boundary (visual continuity).** The heightfield function is defined for all XZ and
continues as featureless abyssal plain at y = -1060 +/- 30 m out to the horizon, so nothing ever
reveals an edge. The rendered ocean plane extends to a 32 km radius skydome.

---

## 2. BATHYMETRIC MAP

### 2.1 Plan view - bathymetry

48 x 48 cells, 128 m per cell. North is up (-Z at top), east is right (+X). Labels give the world
coordinate of the cell's left/top edge.

```
LEGEND
  ^  land, y > +60 m        (summit, spires)
  n  land, +12 .. +60 m     (uplands, plateau)
  .  land,   0 .. +12 m     (strand, pans, swamp)
  :  sea,    0 .. -22 m     (crater shallows, reef rim)
  ~  sea,  -22 .. -70 m     (sunlit shelf)
  -  sea,  -70 .. -150 m    (shelf break, upper twilight)
  =  sea, -150 .. -400 m    (twilight terraces)
  #  sea, -400 .. -900 m    (abyssal)
  @  sea, -900 .. -1605 m   (hadal / trench)

        -3072   -2048   -1024   0       1024    2048
        |       |       |       |       |       |
 -3072 -#######=====---=====#######################@@@@@
       #######===------==####=====################@@@@@
       ######===-------=######=====################@@@@
       ######==-----~--=######=-==##################@@@
 -2560 -#####===---~~~~-=######=-=###################@@@
       #####==----~~~~-=#####=-=######====##########@@@
       #####==-~~~~~~~~-=###==~=#####==-===#########@@@
       #####==-~~~~~~~~~-===-~~-=###=---===#########@@@
 -2048 -####==--~~~~~~~~~~~~~~~~~====-~~--==#########@@@
       ####==-~~~~~~~::::::~~~~~~~~~~~~--===#########@@
       ####==-~~~~~~::::::::::::~~~~~~~---==#########@@
       ###==--~~-=~::::::::::::::~~~~~~---==#########@@
 -1536 -###==-~~~==~:::::::::::::::~~~~~--===########@@@
       ##===-~~~~~~::::::.nn::::::~~~~~~--==########@@@
       ##===-~~~~~~::::.n^^^n::::::~~~~~-===########@@@
       ##==--~~~~~~:::.n^^^^^n:::::~~~~---==########@@@
 -1024 -#===-~~~~~~::::.n^^^^^n:::::~~~~---==########@@@
       #==--~~~~~~:::nn^^^^nnn:::::~~~~---==#==#####@@@
       #==--~~~~~~::nn^^^^^...::::~~~~~---=======###@@@
       #==--~~~~~~::nn^^^^^...::::~~~~~---========##@@@
  -512 -#==--~~~~~~::.n^^nn^n..::::~~~~~---========##@@@
       #==--~~~~~~:::.n...nn.:::::~~~~~---========##@@@
       #==--~~~~~~:::::....:::::::~~~~~--========##@@@@
       #==---~~~~~:::::...:::::::~~~~~~~-==########@@@@
     0 -#==---~~~~~:::::::::::::~~~~~~~~-==#########@@@@
       #===--~~~~~~::::::::::~~~~~~~~~--=====######@@@@
       #===---~~~~~:.:::::::~~~~~~~~~--=======#####@@@@
       #===----~~~~~::::::::~~~~~~~~~-=========####@@@@
   512 -##===---~~~~~~-:::::~~~~~~~~---=========###@@@@@
       ##===---~~~~~==-::~~~~~~-----====##====##@@@@@@@
       ##===---~~~-===~~~~~~~~----====#########@@@@@@@@
       ##===----~-===-~~~~~~~----====##########@@@@@@@@
  1024 -###===----====~~~~~~~---====###########@@@@@@@@@
       ###===---====~~~~~~~---===############@@@@@@@@@@
       ###===--=====-~~~~~~--==#############@@@@@@@@@@@
       ####=====###===-~~~--==#############@@@@@@@@@@@@
  1536 -#####=########==----===#########@##@@@@@@@@@@@@@
       ###############==--===###########@@@@@@@@@@@@@@@
       ################=====###########@@@@@@@@@@@@@@@@
       ################====##########@@@@@@@@@@@@@@@@@@
  2048 -####@########################@@@@@@@@@@@@@@@@@@@
       ###@@@#######################@@@@@@@@@@@@@@@@@@@
       ##@@@@@####################@@@@@@@@@@@@@@@@@@@@@
       ##@@@@@###################@@@@@@@@@@@@@@@@@@@@@@
  2560 -##@@@@###################@@@@@@@@@@@@@@@@@@@@@@@
       ##@@@@##################@@@@@@@@@@@@@@@@@@@@@@@@
       @@@####################@@@@@@@@@@@@@@@@@@@@@@@@@
       @@#####################@@@@@@@@@@@@@@@@@@@@@@@@@
```

### 2.2 Plan view - regions

Same grid, coloured by region id (see section 3 for the key).

```
LEGEND
  I Ashcone Isle (land)      A Crater Shallows (SAFE)   R Outer Reef Rim
  c Fanstone shelf (N)       d Pale Dune shelf (E)      g Silt Meadow shelf (S)
  b Tumbled Boulder shelf    k Ribbonkelp shelf (W)     D Shelf Break Belt
  E Twilight Terraces        F Sunken Canyon            G Ossuary Flats
  H Lampcap Hollows          J Emberfield Vents         K Ashfall Basin
  L Halocline Basin          M Glass Sponge Barrens     N The Draw (hadal)
  O Abyssal Plain            P Deep Abyssal Plain

        -3072   -2048   -1024   0       1024    2048
        |       |       |       |       |       |
 -3072 -OOOOOOOEEEEEDDDEKKKKKKKOOOOOOJJJJJJJJOOOOOOPPPPP
       OOOOOOOEEEDDDDDKKKKKKKKKEEEJJJJJJJJJJOOOOOOPPPPP
       OOOOOOEEEDDDDDDKKKKKKKKKEEJJJJJJJJJJJOOOOOOOPPPP
       OOOOOOEEDDDDDcDKKKKKKKKKDJJJJJJJJJJJJOOOOOOOOPPP
 -2560 -OOOOOEEEDDDccccKKKKKKKKKJJJJJJJJJJJJOOOOOOOOOPPP
       OOOOOEEDDDDccccKKKKKKKKKJJJJJJJJJJEOOOOOOOOOOPPP
       OOOOOEEDcccccccKKKKKKKKKJJJJJJJJJEEEOOOOOOOOOPPP
       OOOOOEEDccccccccKKKKKKKcJJJJJJJDDEEEOOOOOOOOOPPP
 -2048 -OOOOEEDDccccccccRcKKKcccJJJJJJddDDEEOOOOOOOOOPPP
       OOOOEEDkkcccccRAAAAAAARcccJJJdddDDEEEOOOOOOOOOPP
       OOOOEEDkkkccRAAAAAAAAAAARRddddddDDDEEOOOOOOOOOPP
       OOOEEDDkkDEcAAAAAAAAAAAAARRdddddDDDEEOOOOOOOOOPP
 -1536 -OOOEEDkkkEEkAAAAAAAAAAAAAARRddddDDEEEOOOOOOOOPPP
       OOEEEDkkkkkAAAAAAAIIIAAAAAARdddddDDEEOOOOOOOOPPP
       OOEEEDkkkkkAAAAAIIIIIIAAAAARdddddDEEEOOOOOOOOPPP
       OOEEDDkkkkkAAAAIIIIIIIIAAAAAddddDDDEEOOOOOOOOPPP
 -1024 -OEEEDkkkkkkAAAAIIIIIIIIAAAAAddddDDDEEGGGGGGOOPPP
       OEEDDkkkkkAAAAIIIIIIIIIAAAAAddddDDDEGGGGGGGGOPPP
       OEEDDkkkkkAAAIIIIIIIIIIAAAAAddddDDDEGGGGGGGGOPPP
       OEEDDkkkkkAAAIIIIIIIIIIAAAAAddddDDDGGGGGGGGGGPPP
  -512 -OEEDDkkkkkAAAIIIIIIIIIIAAAAAddddDDDGGGGGGGGGGPPP
       OEEDDkkkkkAAAAIIIIIIIIAAAAAAddddDDDGGGGGGGGGGPPP
       OEEDDkkkkkAAAAAAIIIIAAAAAAARgdddDDEEGGGGGGGGPPPP
       OEEDDDkkkkAAAAAAIIIAAAAAAAAgggggdDEEGGGGGGGGPPPP
     0 -OEEDDDkkkkRAAAAAAAAAAAAAggggggggDEEHHGGGGGGOPPPP
       OEEEDDkkkkbRAAAAAAAAAAAggggggggDDEHHHHHHOOOOPPPP
       OEEEDDDkbbbbRIAAAAAAAAggggggggDDEEHHHHHHHOOOPPPP
       OEEEDDDDbbbbbRRAAAAAAgggggggggDEEHHHHHHHHOOOPPPP
   512 -OOEEEDDDbbbbbbDRRRRRRgggggggDDDEEHHHHHHHHOOPPPPP
       OOEEEDDDbbbbbFFDRRRgggggDDDDDEEENOHHHHHHHPPPPPPP
       OOEEEDDDbbbDFFFbbbbbgggDDDDEEEENNNNHHHHHPPPPPPPP
       OOEEEDDDDbDFFFDbbbbbggDDDDEEENNNNNNNNHOOPPPPPPPP
  1024 -OOOEEEDDDDFFFFbbbbbbgDDDEEEEONNNNNNNNNOPPPPPPPPP
       OOOEEEDDDFFFFbbbbbbbDDDEEEOOOONNNNNNNNNNPPPPPPPP
       OOOEEEDDFFFFFLLbbbbbDDEEOOOOOOONNNNNNNNNNNPPPPPP
       OOOOEEFFFFFFLLLLbbbDDEEOOOOOOOOONNNNNNNNNNNPPPPP
  1536 -OOOOOEFFFFFFLLLLLDDDEEEOOOOOOOOONNNNNNNNNNNNPPPP
       OOOOOFFFFFFLLLLLLLDEEEOOOOOOOOOOONNNNNNNNNNNNNPP
       OOOOFFFFFFLLLLLLLLEEEOOOOOOOOOOOPPNNNNNNNNNNNNNP
       OOOFFFFFFFLLLLLLLLEEOOOOOOOOOOPPPPNNNNNNNNNNNNNN
  2048 -OOOFFFFFFLLLLLLLLLMOOOOOOOOOOPPPPPPNNNNNNNNNNNNN
       OOFFFFFFFLLLLLLLLLMMOOOOOOOOOPPPPPPPNNNNNNNNNNNN
       OFFFFFFFLLLLLLLLLMMMMOOOOOOPPPPPPPPPNNNNNNNNNNNN
       OFFFFFFFLLLLLLLLLMMMMOOOOOPPPPPPPPPPPNNNNNNNNNNN
  2560 -OFFFFFFOOLLLLLLLMMMMMOOOOPPPPPPPPPPPPNNNNNNNNNNN
       OOFFFFOOOOOLLMMMMMMMMOOOPPPPPPPPPPPPPPNNNNNNNNNN
       PPPOOOOOOOOMMMMMMMMMMOOPPPPPPPPPPPPPPPNNNNNNNNNN
       PPOOOOOOOOOOMMMMMMMMOOOPPPPPPPPPPPPPPPPNNNNNNNNN
```

The Geode Hollows (crystal caverns) do not appear on a plan map: they are a carved cave volume
inside the north wall of The Draw and are listed in the region table only.

### 2.3 Cross-section

Transect from the island summit (-700, -700) to the hadal terminus (2860, 2920). Length 5077 m.
Horizontal axis is linear; vertical axis is deliberately non-linear so the shelf is legible.

```
     y(m)
   152 |
   100 |/ /
    50 |#/#/
    20 |####///
     0 |#######//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
   -10 |#########//~~~/~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
   -25 |###########///#/~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
   -40 |################//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
   -70 |##################/////////~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  -100 |###########################/~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  -150 |############################/~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  -200 |#############################/~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  -280 |##############################/~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  -400 |###############################//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  -520 |#################################///~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  -660 |####################################//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  -800 |######################################////~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  -950 |##########################################///////~~~~~~~~~~~~~~~~~~~~~~~~~~~
 -1100 |#################################################////////~~~~~~~~~~~~~~~~~~~
 -1250 |#########################################################////~~~~~~~~~~~~~~~
 -1400 |#############################################################///~~~~~~~~~~~~
 -1550 |################################################################/////~~~~~~~
 -1660 |#####################################################################///////
       +----------------------------------------------------------------------------
        0        700      1400     2100     2800     3500     4200     4900   5077 m
        |<-Isle->|<-crater->|<--shelf-->|<-break->|<--- abyssal ---->|<-- The Draw ->|
```

Sampled control points along this transect (binding reference values for terrain validation;
tolerance +/- 6 m):

| s (m) | X | Z | y (m) | Band |
|---|---|---|---|---|
| 0 | -700 | -700 | +101.9 | Land |
| 406 | -415 | -410 | +26.2 | Land |
| 609 | -273 | -266 | -5.5 | Sunlit |
| 812 | -130 | -121 | -14.0 | Sunlit |
| 1219 | 154 | 169 | -40.5 | Twilight |
| 1625 | 439 | 458 | -57.5 | Twilight |
| 1828 | 582 | 603 | -93.3 | Twilight |
| 2031 | 724 | 748 | -270.7 | Midnight |
| 2437 | 1009 | 1038 | -559.4 | Abyssal |
| 2843 | 1294 | 1327 | -841.1 | Abyssal |
| 3452 | 1721 | 1762 | -960.0 | Hadal |
| 3859 | 2006 | 2051 | -1101.8 | Hadal |
| 4468 | 2433 | 2486 | -1480.6 | Hadal |
| 5077 | 2860 | 2920 | -1603.1 | Hadal |

### 2.4 The bathymetric field (authoritative construction)

Terrain is a heightfield `H(x,z)` plus a sparse signed-distance cave layer `C(p)` for overhangs,
arches and the Geode Hollows. The heightfield is built as:

```
H(x, z) = trench( canyon( features( radial(x, z) ) ) )
```

`radial()` - anisotropic radial profile about the island centre `ISLE = (-700, -700)`:

```js
const ISLE = [-700, -700];
// piecewise-smooth radial profile, (radius m, height m)
const PROFILE = [
  [   0, 152], [ 170, 104], [ 330,  54], [ 460,  18], [ 545,   2],
  [ 575,  -3], [ 700,  -9], [ 880, -13], [1010,  -7], [1080,  -4],
  [1160, -24], [1400, -40], [1680, -58], [1950, -76], [2130,-140],
  [2300,-290], [2520,-430], [2850,-690], [3300,-870], [3900,-975],
  [6500,-1060]
];
// note the deliberate local high at r = 1010..1080: that is the reef rim,
// the physical wall that makes the start crater a crater.

function radial(x, z) {
  const dx = x - ISLE[0], dz = z - ISLE[1];
  const r  = hypot(dx, dz), th = atan2(dz, dx);
  const warp = 1.0 + 0.115*sin(2*th + 0.7)
                   + 0.070*sin(3*th - 1.2)
                   + 0.045*sin(5*th + 2.1);
  const reff = r*warp + 210.0*fbm(x, z, 11, 4, 1/1500);
  let h = smoothLerpTable(PROFILE, reff);
  let amp = 7.0 + 24.0*smoothstep(600, 2400, reff)
                + 62.0*smoothstep(2400, 4200, reff);
  amp *= 0.30 + 0.70*smoothstep(950, 1550, reff);   // keep the crater calm
  return h + amp*fbm(x, z, 3, 5, 1/520);
}
```

`features()` - additive/target-blend stamps. `blend(h, target, w) = h*(1-w) + target*w`.

| Stamp | Centre / axis | Radius (m) | Falloff (m) | Action |
|---|---|---|---|---|
| Summit crater notch | (-700, -700) | 150 | 60..150 | `h -= 34*(1-smoothstep)` |
| Quillgrass Plateau | (-560, -1010) | 420 | 230..420 | blend to `+74 + 9*fbm(1/260)` |
| Windcut Spires | (-1120, -620) | 380 | 160..380 | `h += w*(46 + 92*max(0,fbm(1/90))^2)` |
| Evaporite Pans | (-300, -620) | 300 | 150..300 | blend to `+1.6 + 1.2*fbm(1/120)` |
| Stiltwood Swamp | (-800, -215) | 330 | 170..330 | blend to `+0.9 + 1.8*fbm(1/140)` |
| Three Sisters stacks | (-1455,240) r62 h27; (-1362,320) r48 h19; (-1520,355) r40 h14 | - | 0.25r..r | additive cones |
| The Blue Eye | (-1750, -1500) | 190 | 70..165 | `h -= 235*(1-smoothstep)` |
| Ashfall Basin | (-560, -2560) | 620 | 260..620 | blend to `-505 + 16*fbm(1/340)` |
| Emberfield rift | polyline (400,-2280)->(830,-2620)->(1260,-2900) | 460 | 200..460 | blend to `-455 + 30*fbm(1/210)`, then `h += w*46*max(0,fbm(1/55))^2` (chimneys) |
| Halocline Basin | (-1520, 2000) | 760 | 300..760 | blend to `-615 + 14*fbm(1/300)` |
| Ossuary Flats | (2050, -450) | 620 | 280..620 | blend to `-315 + 12*fbm(1/300)` |
| Lampcap Hollows | (1700, 480) | 500 | 220..500 | blend to `-268 + 26*fbm(1/220)` |
| Glass Sponge Barrens | (-1050, 2620) | 660 | 320..660 | blend to `-800 + 30*fbm(1/320)` |

`canyon()` - the Sunken Canyon, polyline `(-1230,700) -> (-1620,1180) -> (-2050,1720) -> (-2520,2480)`:

```js
const [d, t] = polyDistance(x, z, CANYON);       // t in [0,1] along the axis
const hw  = 200 + 190*t;                         // half-width 200..390 m
if (d < hw) {
  const add = 155 + 215*t;                       // incision depth 155..370 m
  const u = d / hw;
  h = min(h, h - add + add*smoothstep(0.48, 1.0, u));
}
```

`trench()` - The Draw, polyline `(950,950) -> (1500,1420) -> (1980,1900) -> (2400,2360) -> (2800,2860)`:

```js
const [d, t] = polyDistance(x, z, TRENCH);
const hw = 300 + 620*t;                          // half-width 300..920 m
if (d < hw*1.02) {
  let floor = -330 - 1280*smoothstep(0,1,t) + 26*fbm(x, z, 91, 4, 1/400);
  const u = d / hw;
  h = min(h, floor + (h - floor)*smoothstep(0.42, 1.0, u));
}
```

Wall slope inside The Draw therefore averages 34-52 degrees over the outer 58% of the half-width
and is near-vertical (>72 degrees) in the noise-driven buttresses. This is where vertical
navigation and the vessel's lights matter most.

---

## 3. NAMED REGIONS

XZ bounds are conservative axis-aligned bounding boxes; the placement rule is authoritative.
"Tier" is the danger tier 0-5 (0 = guaranteed safe, 5 = lethal to an unprepared player).

| Id | Name | XZ bbox (X min,max / Z min,max) | Placement rule | Depth / height range (m) | Area (km^2) | Tier |
|---|---|---|---|---|---|---|
| R01 | Ashcone Isle | -1500,-90 / -1500,-40 | `H > 0` and `dIsle < 1000` | +0 .. +188 | 1.05 | 0 |
| R02 | Crater Shallows | -1960,560 / -1960,560 | `dIsle < 1250` and `-26 < H <= 0` | 0 .. -26 | 3.62 | 0 |
| R03 | Outer Reef Rim | -2300,900 / -2300,900 | `1050 < dIsle < 1950` and `-30 < H <= -3` | -3 .. -30 | 1.18 | 1 |
| R04 | Ribbonkelp Shelf | -2560,-900 / -1900,700 | bearing 232-315 deg, `-70 < H <= -14` | -14 .. -70 | 2.41 | 1 |
| R05 | Fanstone Shelf | -1800,700 / -2700,-1100 | bearing 315-40 deg, `-70 < H <= -4` | -4 .. -70 | 2.06 | 1 |
| R06 | Pale Dune Shelf | 100,1450 / -2100,300 | bearing 40-110 deg, `-95 < H <= -24` | -24 .. -95 | 2.63 | 1 |
| R07 | Silt Meadow Shelf | -400,1000 / -100,1000 | bearing 110-175 deg, `-70 < H <= -8` | -8 .. -70 | 1.72 | 1 |
| R08 | Tumbled Boulder Shelf | -1900,-300 / 100,1500 | bearing 175-232 deg, `-118 < H <= -30` | -30 .. -118 | 1.94 | 2 |
| R09 | Shelf Break Belt | whole map | `-165 < H <= -70` and not in a named basin | -70 .. -165 | 4.10 | 2 |
| R10 | Twilight Terraces | whole map | `-400 < H <= -165`, not canyon/basin/flats | -165 .. -400 | 5.35 | 3 |
| R11 | Sunken Canyon | -2700,-1050 / 520,2700 | within canyon corridor, `H < -150` | -150 .. -1140 | 2.02 | 3 |
| R12 | Halocline Basin | -2280,-760 / 1240,2760 | `dist((-1520,2000)) < 760` | -430 .. -620 | 1.81 | 4 |
| R13 | Glass Sponge Barrens | -1710,-390 / 1960,3280 | `dist((-1050,2620)) < 660` | -735 .. -835 | 1.37 | 4 |
| R14 | Ashfall Basin | -1180,60 / -3180,-1940 | `dist((-560,-2560)) < 620` | -380 .. -540 | 1.21 | 3 |
| R15 | Emberfield Vent Province | -60,1720 / -3360,-1820 | within 460 m of the vent polyline | -395 .. -475 | 1.62 | 4 |
| R16 | Ossuary Flats | 1430,2670 / -1070,170 | `dist((2050,-450)) < 620` | -285 .. -345 | 1.21 | 3 |
| R17 | Lampcap Hollows | 1200,2200 / -20,980 | `dist((1700,480)) < 500` | -215 .. -320 | 0.79 | 3 |
| R18 | Geode Hollows | 1950,2600 / 900,1500 | SDF cave volume in The Draw's north wall | -560 .. -1050 | 0.31 (floor) | 4 |
| R19 | The Draw | 620,3072 / 620,3072 | within trench corridor, `H < -400` | -400 .. -1605 | 4.88 | 5 |
| R20 | Abyssal Plain | whole map | `H <= -400`, none of the above | -400 .. -900 | 8.90 | 4 |
| R21 | Deep Abyssal Plain | whole map | `H <= -900`, outside The Draw | -900 .. -1160 | 3.24 | 4 |
| R22 | Open Blue | whole map | water column, floor more than 150 m below, more than 400 m from any terrain | any | volumetric | 2-5 |
| R23 | Aerosphere | whole map | `y > 0` | 0 .. +1100 | volumetric | 0-1 |

Region areas sum to more than the world footprint because volumetric regions (R22, R23) and the
cave volume (R18) overlap the seabed partition.

---

## 4. THE SAFE CRATER (START AREA)

Non-negotiable client requirement: the start zone contains no threats whatsoever.

### 4.1 Geometry

Ashcone Isle is an extinct shield volcano whose flanks continue underwater as a shallow lagoon,
ringed by a raised biogenic reef rim (the local high at r = 1010-1080 m in `PROFILE`). The rim
breaks the ocean swell, so the lagoon is calm.

| Quantity | Value |
|---|---|
| Crater centre | (-700, 0, -700) |
| Land radius (mean) | 545 m, varying 410-720 m with the anisotropy warp |
| Lagoon outer radius | 1250 m (safe-zone radius, hard) |
| Reef rim crest depth | -3.0 .. -7.5 m |
| Lagoon floor depth | -6 .. -22 m (mean -13.4 m) |
| Lagoon area | 3.62 km^2 |
| Island land area | 1.05 km^2 |
| Summit altitude | +101.9 m at (-700, -700); Ashcone Rim landmark |
| Highest point | +188 m, Windcut Needle tip at (-1120, -620) |
| Maximum swim depth in safe zone | 26 m -> 3.58 atm, well inside a bare-lungs budget |

### 4.2 Safety rules (enforced by the spawner, not by design intent)

```
SAFE_CENTRE = (-700, -700)
SAFE_RADIUS = 1250.0            // m, horizontal
SAFE_CEILING = +200.0           // m
SAFE_FLOOR   = -40.0            // m

isSafe(p) = (hypot(p.x - SAFE_CENTRE.x, p.z - SAFE_CENTRE.z) < SAFE_RADIUS)
            && (p.y > SAFE_FLOOR) && (p.y < SAFE_CEILING)
```

1. No entity with `dangerTier >= 2` may be spawned inside the safe volume, at any time of day,
   under any world state, ever. This is a hard assert in debug builds.
2. Entities with `dangerTier >= 2` whose wander path would enter the safe volume have their
   steering target reflected at the boundary with a 60 m hysteresis band (they turn away at
   r = 1310 m and are hard-clamped at r = 1250 m).
3. No environmental hazard (heat, brine, crush, toxin, current above 0.8 m/s) exists inside.
4. Weather inside the safe volume is capped: wind <= 7 m/s, wave amplitude <= 0.55 m,
   no lightning.
5. Night inside the safe volume gets a bioluminescent floor: `fl_lampweed` and `f_lanternshoal`
   raise the effective ambient so the player can always find their way back to shore
   (see section 6.3).

### 4.3 Start point

| Item | Value |
|---|---|
| Player spawn | (-640, +1.2, -160) - the south strand, facing heading 168 deg (out to sea) |
| Vessel initial berth | (-702, +0.4, -96) - bow to seaward, resting in 0.4 m of water |
| Line of sight from spawn | Summit visible at 30 deg elevation; Three Sisters stacks visible at bearing 246 deg, 1380 m |
| Sun at t=0 | Local time 07:20, sun elevation 21 deg, azimuth 96 deg |

The first thing the player sees from the spawn is the sea to the south, the vessel 65 m away, and
the reef rim breaking white 1100 m out. The trench is invisible from here; the first hint of it
is the colour change at the shelf break, seen from altitude.

---

## 5. DEPTH BANDS

### 5.1 Physical model (binding)

All underwater light and fog derives from two spectral coefficient triples at the R/G/B
wavelengths defined in section 0. Baseline values are Jerlov type IB clear ocean water.

```wgsl
// per metre, RGB = 650/550/450 nm
const SIGMA_A_BASE : vec3f = vec3f(0.3600, 0.0680, 0.0165);  // absorption
const SIGMA_S_BASE : vec3f = vec3f(0.0036, 0.0045, 0.0056);  // scattering
const SIGMA_E_BASE : vec3f = SIGMA_A_BASE + SIGMA_S_BASE;    // = (0.3636, 0.0725, 0.0221)
const K_D_BASE     : vec3f = vec3f(0.3500, 0.0630, 0.0190);  // downwelling diffuse attenuation
```

Per-biome turbidity multipliers `tauA`, `tauS`, `tauKd` (section 7.3) scale these:

```wgsl
let sigA = SIGMA_A_BASE * tauA;
let sigS = SIGMA_S_BASE * tauS;
let sigE = sigA + sigS;
let kd   = K_D_BASE * tauKd;
```

Downwelling irradiance at depth d, relative to just-below-surface:

```
E_rel(d) = exp(-kd * d)                       // per channel, vec3
```

Photopic scalar used for the HUD light meter and for spawn/behaviour gating:

```
Y(d) = 0.2126*E_rel.r + 0.7152*E_rel.g + 0.0722*E_rel.b
```

Single-scattering fog composite (the only fog model; there is no artistic distance fog):

```wgsl
let T   = exp(-sigE * s);                     // transmittance over path length s metres
let inS = (sigS / sigE) * ambientRadiance(depth) * phaseHG(cosTheta, 0.72);
color = objectRadiance * T + inS * (vec3f(1.0) - T);
```

Visibility distance is defined as the range at which green-channel transmittance reaches 2%:

```
V = ln(50) / sigE.g = 3.912 / sigE.g
```

Pressure (seawater rho = 1027 kg/m^3, g = 9.81 m/s^2, 1 atm = 101325 Pa):

```
P(d) = 1.0 + d / 10.056        [atm]
```

### 5.2 Band table - light and water

`Y` values are computed from the formula above with `tauKd = 1.0` (clear water). `L_amb` is the
post-auto-exposure ambient multiplier the renderer applies - this is the tuned playable value,
not the physical one, and is what art must match.

| Band | Id | Depth (m) | Pressure (atm) | Y at top | Y at bottom | L_amb day | L_amb night | Visibility (m) | Water tint (inscatter, sRGB) |
|---|---|---|---|---|---|---|---|---|---|
| Aerial | `band_air` | +1100 .. 0 | 1.00 | 1.000 | 1.000 | 1.000 | 0.055 | 14 000 (haze) | 168,196,214 |
| Surface | `band_surf` | 0 .. -2 | 1.00-1.20 | 1.000 | 0.806 | 0.900 | 0.048 | 52 | 120,186,190 |
| Sunlit | `band_sun` | -2 .. -40 | 1.20-4.98 | 0.806 | 0.091 | 0.640 | 0.030 | 44 | 46,142,164 |
| Twilight | `band_twi` | -40 .. -150 | 4.98-15.9 | 0.091 | 4.23e-3 | 0.150 | 6.0e-3 | 50 | 16,74,116 |
| Midnight | `band_mid` | -150 .. -400 | 15.9-40.8 | 4.23e-3 | 3.60e-5 | 0.016 | 3.5e-4 | 44 | 6,28,62 |
| Abyssal | `band_aby` | -400 .. -900 | 40.8-90.5 | 3.60e-5 | 2.70e-9 | 5.0e-4 | 1.0e-5 | 50 | 2,9,26 |
| Hadal | `band_had` | -900 .. -1605 | 90.5-160.6 | 2.70e-9 | ~0 | 0.000 | 0.000 | 53 | 0,0,0 |

The Visibility column is the **median** across the biomes occupying that band, not a per-band
constant; individual biomes range from 6 m (inside the brine layer) to 60 m (Glass Sponge
Barrens). Note that visibility does NOT fall with depth - deep ocean water is intrinsically
cleaner than the nearshore shelf, and the Sunlit band is the murkiest in the game because of
kelp exudate, seagrass silt and river-free coastal turbidity. What collapses with depth is
*ambient light*, not clarity. Below `AMBIENT_CUTOFF_DAY` the player's effective sight range is
set entirely by lamp throw and the inverse-square falloff of their own lights (typically 28-45 m),
never by the water. This distinction is load-bearing for the deep-game feel: the darkness is an
absence of light, not a fog bank.

Auxiliary physical reference points (validate the shader against these):

| Depth (m) | E_rel R | E_rel G | E_rel B | Y | Pressure (atm) |
|---|---|---|---|---|---|
| 0 | 1.000 | 1.000 | 1.000 | 1.000 | 1.00 |
| 2 | 0.4966 | 0.8816 | 0.9627 | 0.8056 | 1.20 |
| 10 | 3.02e-2 | 0.5326 | 0.8270 | 0.4462 | 1.99 |
| 20 | 9.12e-4 | 0.2837 | 0.6839 | 0.2525 | 2.99 |
| 40 | 8.32e-7 | 0.0804 | 0.4677 | 0.0913 | 4.98 |
| 80 | 6.9e-13 | 6.47e-3 | 0.2187 | 0.0204 | 8.96 |
| 150 | ~0 | 7.9e-5 | 0.0578 | 4.23e-3 | 15.92 |
| 250 | ~0 | 1.4e-7 | 8.65e-3 | 6.25e-4 | 25.86 |
| 400 | ~0 | ~0 | 5.00e-4 | 3.61e-5 | 40.77 |
| 620 | ~0 | ~0 | 7.6e-6 | 5.5e-7 | 62.65 |
| 900 | ~0 | ~0 | 3.7e-8 | 2.7e-9 | 90.50 |
| 1200 | ~0 | ~0 | 1.2e-10 | 9e-12 | 120.33 |
| 1605 | ~0 | ~0 | ~0 | 0 | 160.61 |

**Aphotic thresholds (binding).**
- `AMBIENT_CUTOFF_DAY = 620 m`. Below this, at local noon, sky ambient contributes exactly zero;
  the shader clamps to 0 to avoid denormals. The world is lit only by the vessel, the diver lamp
  and bioluminescence.
- `AMBIENT_CUTOFF_NIGHT = 190 m`. Same, for the 21:00-05:00 window.
- Between 340 m and 620 m by day the sky contributes a barely-perceptible blue-grey that is the
  single most important mood asset in the game: it is what makes the Midnight/Abyssal transition
  feel like a lid closing. Do not clamp it early.

### 5.3 Band table - sound, hazard, life

| Band | Ambient audio character | Loudness (LUFS) | Danger tier | Creature sets |
|---|---|---|---|---|
| `band_air` | Wind noise band-limited 80-2200 Hz, gust LFO 0.08-0.6 Hz; distant surf 40-400 Hz at -26 dB; bird-analog calls 900-3400 Hz, 1.2 events/min | -22 | 0-1 | `f_kitewing`, `f_ashwing`, `f_shorehopper` |
| `band_surf` | Surface break: pink noise 200-6000 Hz modulated by wave height, +6 dB transient per crest; muffled duck of -12 dB LPF 1200 Hz on submersion | -18 | 0-1 | Surface schools, `f_bladderjelly` |
| `band_sun` | Snapping-shrimp-analog crackle 2.5-9 kHz at 14-40 events/s; reef hum 120-400 Hz; light shimmer whine 3.2 kHz at -34 dB | -20 | 0-2 | Tier 0-1 reef fauna, `f_spinejaw` at the outer edge |
| `band_twi` | Crackle drops to 3 events/s; low swell 45-90 Hz; first infrasound moans 22-38 Hz at -30 dB, 0.4 events/min | -23 | 2-3 | `f_hollowdrifter`, `f_glasslancer`, `f_thornray`, `f_boulderjaw` |
| `band_mid` | Near-silence bed at -38 dB, 18-60 Hz; hull tick (thermal contraction) 1.1 events/min; distant unresolved call 30-95 Hz, 0.25/min, never localised | -26 | 3-4 | `f_dredgemaw`, `f_veildrifter`, `f_lamplure`, `f_bonecrawler` |
| `band_aby` | Sub-bass floor 12-30 Hz at -32 dB; pressure hull groan on descent rate > 4 m/s; sparse mineral tick 4-7 kHz 0.6/min | -28 | 4 | `f_palefathom`, `f_gulpermaw`, `f_glasswraith`, `f_brinewyrm` |
| `band_had` | Pure infrasound 9-19 Hz at -26 dB with 0.03 Hz amplitude drift; `f_trenchsinger` song events 17-64 Hz, 0.15/min, audible up to 2400 m; no high-frequency content above 900 Hz at all | -24 | 5 | `f_trenchsinger`, `f_hadalcoil`, `f_stonelurker`, `f_voidbloom` |

Design note on dread: the Hadal band's total lack of high-frequency content is the mechanism. The
player's ear has nothing to localise with, so every sound feels like it comes from behind. Never
add a "scare sting". Never show a creature fully in the lights on first contact.

### 5.4 Pressure gating

| Depth (m) | Pressure (atm) | Gate |
|---|---|---|
| -26 | 3.6 | Safe-zone floor; bare-lungs comfortable |
| -80 | 8.9 | Bare-lungs hard limit without a compression suit (section 04) |
| -220 | 22.9 | Vessel hull tier 1 limit |
| -520 | 52.7 | Vessel hull tier 2 limit |
| -900 | 90.5 | Vessel hull tier 3 limit |
| -1605 | 160.6 | Vessel hull tier 4 (maximum) |

Hull creak audio and windshield micro-flex shader effects begin at 78% of the current hull limit
and scale as `(P/P_limit - 0.78)/0.22` clamped to [0,1].

---

## 6. REGISTRIES

These ids are binding across all sections. Other documents own the full behavioural stats; this
document owns the ids, size classes, habitat and placement densities.

### 6.1 Flora registry

`H` = mean height (m), `R` = mean canopy/footprint radius (m), `sway` = animation class,
`emis` = emissive colour and peak luminance in cd/m^2 (0 = non-luminous).

| Id | Display name | H (m) | R (m) | Sway | Emissive (sRGB @ cd/m^2) | Notes |
|---|---|---|---|---|---|---|
| `fl_cinder_moss` | Cinder moss | 0.06 | 0.30 | none | 0 | Black-green crust on basalt |
| `fl_ashfern` | Ashfern | 0.85 | 0.55 | soft | 0 | Grey-olive frond, land, slope |
| `fl_quillgrass` | Quillgrass | 1.35 | 0.12 | grass | 0 | Blue-green stiff quills, plateau |
| `fl_glass_thistle` | Glass thistle | 0.65 | 0.40 | stiff | 0 | Translucent silica spines |
| `fl_wind_lichen` | Wind lichen | 0.03 | 0.80 | none | 0 | Orange crust on spires |
| `fl_pan_halophyte` | Pan halophyte | 0.22 | 0.25 | soft | 0 | Red succulent, salt pans |
| `fl_saltcrust` | Salt crust polygon | 0.04 | 1.60 | none | 0 | Evaporite plate, non-plant |
| `fl_stiltwood` | Stiltwood | 7.20 | 3.40 | tree | 0 | Mangrove-analog, arching prop roots |
| `fl_pipe_reed` | Pipe reed | 2.10 | 0.18 | grass | 0 | Hollow, whistles in wind |
| `fl_bulb_palm` | Bulb palm | 4.60 | 2.10 | tree | 0 | Swollen water-storing trunk |
| `fl_fanstone_coral` | Fanstone coral | 1.10 | 0.95 | none | 0 | Orange-pink plate coral |
| `fl_pillar_coral` | Pillar coral | 2.60 | 0.70 | none | 0 | Vertical, cream to violet |
| `fl_fingerweed` | Fingerweed | 0.45 | 0.30 | kelp | 0 | Red-brown branching alga |
| `fl_ribbonkelp` | Ribbonkelp | 22.0 | 1.20 | kelp | 0 | Giant stipe, surface canopy |
| `fl_bladderweed` | Bladderweed | 3.10 | 0.60 | kelp | 0 | Gas-bladder float alga |
| `fl_siltgrass` | Siltgrass | 0.70 | 0.09 | grass | 0 | Seagrass-analog meadow former |
| `fl_lampweed` | Lampweed | 0.35 | 0.20 | grass | 120,220,255 @ 2.4 | Night-only glow, safe zone |
| `fl_urn_sponge` | Urn sponge | 0.90 | 0.50 | none | 0 | Barrel sponge, boulder field |
| `fl_glass_sponge` | Glass sponge | 2.40 | 1.10 | none | 200,230,255 @ 0.35 | Silica lattice, faint refraction |
| `fl_lampcap` | Lampcap | 5.80 | 3.90 | soft | 90,255,190 @ 6.8 | Giant glowing fungal-analog cap |
| `fl_glowcup` | Glowcup | 0.55 | 0.45 | none | 255,150,60 @ 3.1 | Small amber cup, lampcap understory |
| `fl_tuberod` | Tuberod | 1.60 | 0.10 | soft | 255,60,30 @ 0.9 | Vent tubeworm-analog colony |
| `fl_brine_mat` | Brine mat | 0.10 | 2.20 | none | 190,255,140 @ 0.6 | Bacterial mat at the halocline |
| `fl_calcite_spar` | Calcite spar | 3.40 | 0.55 | none | 0 | Clear crystal blade, caverns |
| `fl_amethyst_druse` | Amethyst druse | 0.80 | 0.70 | none | 0 | Violet crystal cluster |
| `fl_bone_coral` | Bone coral | 1.40 | 0.90 | none | 0 | White coral growing on skeletons |
| `fl_veil_moss` | Veil moss | 0.25 | 1.30 | soft | 0 | Grey drifting filament mat |
| `fl_dead_fan` | Dead fan | 2.20 | 1.40 | none | 0 | Black skeletal gorgonian, abyssal |
| `fl_hadal_wisp` | Hadal wisp | 0.90 | 0.30 | soft | 40,90,255 @ 1.8 | Only living thing at -1400 m |

### 6.2 Fauna registry

Placement-relevant fields only. Full AI in section 05.

| Id | Display name | Length (m) | Habitat band | Schooling | Danger tier | Role |
|---|---|---|---|---|---|---|
| `f_glimmerfin` | Glimmerfin | 0.09 | surf/sun | 40-220 | 0 | Bait school |
| `f_reefdarter` | Reef darter | 0.22 | sun | 4-14 | 0 | Reef forager |
| `f_paddlecrab` | Paddle crab | 0.30 | surf/sun | 1 | 0 | Benthic scavenger |
| `f_bladderjelly` | Bladder jelly | 0.15 | surf | 6-30 | 0 | Passive drifter |
| `f_sandsifter` | Sand sifter | 0.45 | sun | 1-3 | 0 | Ray-analog, burrows |
| `f_tidepipe` | Tidepipe | 0.12 | surf | 1 | 0 | Sessile filter feeder |
| `f_shorehopper` | Shore hopper | 0.18 | land/surf | 3-12 | 0 | Amphibious, land |
| `f_pansnail` | Pan snail | 0.25 | land | 1-5 | 0 | Salt-pan grazer |
| `f_stiltcrab` | Stilt crab | 0.50 | land/surf | 1-4 | 0 | Mangrove climber |
| `f_kitewing` | Kitewing | 1.40 | air | 1-6 | 0 | Aerial glider, harmless |
| `f_ashwing` | Ashwing | 2.10 | air | 1-3 | 1 | Aerial, territorial near summit |
| `f_lanternshoal` | Lantern shoal | 0.14 | sun/twi | 80-400 | 0 | Night bioluminescent school |
| `f_shellback` | Shellback | 1.10 | sun | 1-4 | 0 | Armoured grazer |
| `f_kelpgrazer` | Kelp grazer | 2.60 | sun | 1-3 | 0 | Large herbivore, kelp |
| `f_ribboneel` | Ribbon eel | 1.80 | sun/twi | 1 | 1 | Crevice ambusher, defensive only |
| `f_sunwingray` | Sunwing ray | 3.20 | sun | 1-2 | 1 | Placid, startles |
| `f_spinejaw` | Spinejaw | 1.60 | sun/twi | 1-5 | 2 | First real predator |
| `f_hollowdrifter` | Hollow drifter | 4.00 | twi | 1-3 | 2 | Stinging jelly |
| `f_glasslancer` | Glass lancer | 2.40 | twi | 3-9 | 2 | Fast transparent pack hunter |
| `f_thornray` | Thornray | 5.50 | twi/mid | 1 | 3 | Patrolling predator |
| `f_boulderjaw` | Boulderjaw | 3.10 | twi | 1 | 3 | Ambusher, boulder field |
| `f_siltcrawler` | Silt crawler | 1.20 | twi/mid | 1-6 | 1 | Detritivore |
| `f_lamplure` | Lamplure | 0.80 | mid | 1 | 2 | Anglerfish-analog |
| `f_dredgemaw` | Dredgemaw | 9.00 | mid | 1 | 4 | Apex of the twilight terraces |
| `f_veildrifter` | Veil drifter | 62.0 | mid/aby | 1 | 3 | Colossal siphonophore, passive but lethal to touch |
| `f_bonecrawler` | Bone crawler | 2.80 | mid | 2-8 | 2 | Ossuary scavenger |
| `f_ventcrab` | Vent crab | 0.90 | aby | 5-30 | 1 | Chemosynthetic grazer |
| `f_ashmoth` | Ash moth | 1.10 | mid/aby | 4-20 | 1 | Drifting filter feeder |
| `f_glasswraith` | Glass wraith | 6.00 | aby | 1-2 | 4 | Near-invisible until it opens |
| `f_palefathom` | Pale fathom | 14.0 | aby | 1 | 5 | Abyssal apex |
| `f_brinewyrm` | Brine wyrm | 11.0 | aby | 1 | 4 | Lives in the halocline |
| `f_gulpermaw` | Gulpermaw | 7.00 | aby | 1 | 4 | Slow, enormous mouth |
| `f_spirecrawler` | Spire crawler | 3.40 | aby | 1-3 | 3 | Wall-climbing arthropod |
| `f_trenchsinger` | Trenchsinger | 78.0 | had | 1 | 5 | The thing that sings. Rare. |
| `f_hadalcoil` | Hadal coil | 24.0 | had | 1 | 5 | Serpentine, wall-hugging |
| `f_stonelurker` | Stone lurker | 5.00 | had | 1 | 5 | Indistinguishable from rock until it moves |
| `f_voidbloom` | Void bloom | 3.00 | had | 1-4 | 4 | Drifting predatory jelly |

### 6.3 Ore registry

`Yield` is units of raw material per fully mined node. `Hard` is mining hardness class 1-5
(gates which cutter tier is required).

| Id | Display name | Yield | Hard | Node size (m) | Visual | Primary bands |
|---|---|---|---|---|---|---|
| `ore_ferronodule` | Ferro-nodule | 4 | 1 | 0.35 | Dull brown-black lumps on sand | sun, twi, mid |
| `ore_cupric` | Cupric crust | 3 | 2 | 0.60 | Green-blue crust on basalt | sun, twi |
| `ore_titanic_sand` | Titanic sand | 6 | 1 | 1.20 | Dark placer streaks in dunes | sun |
| `ore_quartzite` | Quartzite | 3 | 2 | 0.55 | White vein in grey rock | land, sun, twi |
| `ore_violet_geode` | Violet geode | 2 | 3 | 0.90 | Cracked ball, amethyst interior | mid, aby |
| `ore_sulfur_bloom` | Sulfur bloom | 5 | 1 | 0.75 | Yellow crust, summit and vents | land, aby |
| `ore_baritine` | Baritine chimney | 3 | 3 | 1.80 | White chimney spur | aby |
| `ore_magnetite` | Magnetite | 4 | 2 | 0.45 | Black octahedra | land, twi |
| `ore_aurific` | Aurific flake | 1 | 2 | 0.25 | Gold specks in quartz | twi, mid |
| `ore_argentine` | Argentine galena | 2 | 3 | 0.50 | Grey metallic cubes | mid, aby |
| `ore_lithic_brine` | Lithic brine salt | 5 | 1 | 1.10 | White-pink crust at halocline | aby |
| `ore_clathrate` | Clathrate ice | 8 | 1 | 0.95 | Fizzing white hydrate | aby, had |
| `ore_phosphor_nodule` | Phosphor nodule | 2 | 2 | 0.30 | Faintly glowing pale-green | mid, aby |
| `ore_obsidian` | Obsidian | 3 | 3 | 0.70 | Black glass shards | land, aby |
| `ore_thermolith` | Thermolith | 2 | 4 | 0.65 | Iridescent sulphide, warm to touch | aby (vents) |
| `ore_calcite_spar_ore` | Spar crystal | 3 | 3 | 1.40 | Clear prisms | aby (caverns) |
| `ore_iridic` | Iridic pellet | 1 | 5 | 0.20 | Mirror-bright, impossibly heavy | had |

### 6.4 Ambient audio bed registry

All beds are synthesised (Web Audio API); no samples. `Base` describes the noise/oscillator bed,
`Evt` describes stochastic events.

| Id | Base layer | Evt layer | Evt rate | LUFS |
|---|---|---|---|---|
| `amb_wind_beach` | Pink noise, BP 90-2400 Hz, gust LFO 0.11 Hz depth 9 dB | Surf crest, LP 1400 Hz burst 0.8 s | 11/min | -22 |
| `amb_wind_upland` | Pink noise, BP 140-3600 Hz, gust LFO 0.19 Hz depth 13 dB | Quillgrass hiss swell 2.4 s | 7/min | -24 |
| `amb_spire_moan` | Two detuned saws 58/61 Hz through BP Q=14, wind-gated | Reed whistle 620-1750 Hz glide | 4/min | -23 |
| `amb_saltflat` | Near-silence, brown noise -46 dB | Crust tick 3-6 kHz; distant thermal crack | 3/min | -28 |
| `amb_swamp` | LP 900 Hz noise bed, water lap 60-300 Hz | Stiltcrab clatter; drip 1.2-2.8 kHz | 22/min | -21 |
| `amb_summit_fumarole` | Steam hiss 1.2-7 kHz, LFO 0.06 Hz | Gas belch 40-160 Hz, 0.4 s | 5/min | -22 |
| `amb_surface` | Wave break pink noise modulated by wave height | Splash transient | continuous | -18 |
| `amb_reef_day` | Reef hum 120-400 Hz | Snap crackle 2.5-9 kHz | 26/s | -20 |
| `amb_reef_night` | Reef hum -6 dB, added 55 Hz swell | Snap crackle 9/s, chorus rise 05:00 | 9/s | -22 |
| `amb_kelp` | Creak bed 70-260 Hz, sway LFO 0.09 Hz | Stipe groan 0.9 s | 6/min | -22 |
| `amb_dune` | Sand shear 300-1800 Hz, current-gated | Ripple rush 1.8 s | 4/min | -25 |
| `amb_meadow` | Soft hum 180-500 Hz | Blade rustle 700-2200 Hz | 14/min | -24 |
| `amb_boulder` | Cavity resonance 48/96/144 Hz | Rock knock 200-900 Hz | 3/min | -25 |
| `amb_shelfbreak` | Descending swell 45-90 Hz, LFO 0.04 Hz | Current whoosh 4 s | 2/min | -24 |
| `amb_canyon` | Wall reflection comb bed 60-240 Hz | Falling debris tick | 5/min | -25 |
| `amb_terrace` | Sub bed 30-72 Hz | Unresolved distant call 30-95 Hz | 0.25/min | -26 |
| `amb_vent` | Boil roar 200-3000 Hz, level by vent proximity | Chimney crack; steam pulse | 12/min | -19 |
| `amb_ossuary` | Hollow bone resonance 90/135/270 Hz | Bone knock, long decay 3.2 s | 2/min | -26 |
| `amb_lampcap` | Warm hum 66-190 Hz | Spore puff 2-5 kHz | 8/min | -24 |
| `amb_sponge` | Glassy shimmer 4-9 kHz at -40 dB, plus 18 Hz floor | Silica chime 6-11 kHz | 3/min | -28 |
| `amb_brine` | Two-layer: above 22-60 Hz, below (in brine) 8-24 Hz and -9 dB LPF 320 Hz | Halocline slosh on crossing | on event | -26 |
| `amb_geode` | Crystal ring bed 320/480/640 Hz at -38 dB | Spar crack 1-4 kHz | 4/min | -27 |
| `amb_draw` | Pure infrasound 9-19 Hz, drift LFO 0.03 Hz | Trenchsinger song 17-64 Hz | 0.15/min | -24 |
| `amb_abyss` | Sub floor 12-30 Hz | Mineral tick 4-7 kHz; hull groan | 0.6/min | -28 |
| `amb_openblue` | Almost nothing: 20 Hz at -42 dB | Own-breathing emphasis | - | -30 |
| `amb_verge` | Broadband shear roar 60-5000 Hz rising with b | Pressure thump 25-45 Hz | 8/min | -14 |

---

## 7. BIOME CATALOGUE

25 biomes: 7 land, 18 sea. Each biome is a complete material + population ruleset.

### 7.1 Master index

| # | Id | Display name | Placement rule | Depth / height (m) | Region(s) | Tier |
|---|---|---|---|---|---|---|
| 1 | `lnd_cinder_strand` | Cinder Strand | land, `y <= 6.0`, slope < 12 deg, within 90 m of the waterline | +0.0 .. +6.0 | R01 | 0 |
| 2 | `lnd_evaporite_pans` | Evaporite Pans | land, slope < 4 deg, `0.4 <= y <= 3.6`, `dist((-300,-620)) < 300` | +0.4 .. +3.6 | R01 | 0 |
| 3 | `lnd_stiltwood_swamp` | Stiltwood Swamp | land/intertidal, `-0.6 <= y <= 3.0`, `dist((-800,-215)) < 330` | -0.6 .. +3.0 | R01 | 0 |
| 4 | `lnd_ashfern_slope` | Ashfern Slopes | land, `6 < y <= 70`, slope 8-34 deg | +6 .. +70 | R01 | 0 |
| 5 | `lnd_quillgrass_plateau` | Quillgrass Plateau | land, `62 <= y <= 94`, slope < 11 deg | +62 .. +94 | R01 | 0 |
| 6 | `lnd_windcut_spires` | Windcut Spires | land, slope > 38 deg or spire mask > 0.35 | +40 .. +188 | R01 | 1 |
| 7 | `lnd_ashcone_summit` | Ashcone Summit | land, `y > 92`, `dist(ISLE) < 260` | +92 .. +152 | R01 | 1 |
| 8 | `sea_crater_reef` | Crater Reef Shallows | `dIsle < 1250`, `-26 < y <= 0` | 0 .. -26 | R02 | 0 |
| 9 | `sea_fanstone_gardens` | Fanstone Coral Gardens | `-48 < y <= -3`, rugosity > 0.30, bearing 300-140 deg | -3 .. -48 | R03,R05 | 1 |
| 10 | `sea_ribbonkelp` | Ribbonkelp Forest | `-68 < y <= -14`, substrate rock > 0.4, bearing 232-315 deg | -14 .. -68 | R04 | 1 |
| 11 | `sea_pale_dunes` | Pale Dunes | `-95 < y <= -24`, slope < 9 deg, substrate sand > 0.7 | -24 .. -95 | R06 | 1 |
| 12 | `sea_silt_meadow` | Silt Meadow | `-52 < y <= -8`, slope < 7 deg, exposure < 0.35 | -8 .. -52 | R07,R02 | 1 |
| 13 | `sea_tumbled_boulders` | Tumbled Boulder Field | `-118 < y <= -30`, rugosity > 0.55 | -30 .. -118 | R08 | 2 |
| 14 | `sea_shelf_break` | Shelf Break Wall | `-165 < y <= -70`, slope > 22 deg | -70 .. -165 | R09 | 2 |
| 15 | `sea_sunken_canyon` | Sunken Canyon Walls | inside canyon corridor, `y < -150` | -150 .. -1140 | R11 | 3 |
| 16 | `sea_ashfall_basin` | Ashfall Basin | `dist((-560,-2560)) < 620`, `y < -380` | -380 .. -540 | R14 | 3 |
| 17 | `sea_lampcap_forest` | Lampcap Forest | `dist((1700,480)) < 500`, `-320 < y <= -215` | -215 .. -320 | R17 | 3 |
| 18 | `sea_ossuary_flats` | Ossuary Flats | `dist((2050,-450)) < 620`, `-345 < y <= -285` | -285 .. -345 | R16 | 3 |
| 19 | `sea_emberfield_vents` | Emberfield Vents | within 460 m of the vent polyline | -395 .. -475 | R15 | 4 |
| 20 | `sea_glass_sponge` | Glass Sponge Barrens | `dist((-1050,2620)) < 660` | -735 .. -835 | R13 | 4 |
| 21 | `sea_halocline_basin` | Halocline Basin | `dist((-1520,2000)) < 760`, `y < -430` | -430 .. -620 | R12 | 4 |
| 22 | `sea_geode_hollows` | Geode Hollows | inside the cave SDF volume | -560 .. -1050 | R18 | 4 |
| 23 | `sea_hadal_draw` | The Draw | inside trench corridor, `y < -400` | -400 .. -1605 | R19 | 5 |
| 24 | `sea_abyssal_plain` | Abyssal Plain | `y <= -400`, none of the above | -400 .. -1160 | R20,R21 | 4 |
| 25 | `sea_open_blue` | Open Blue | water column, floor > 150 m below, > 400 m from terrain | any | R22 | 2-5 |

### 7.2 Terrain material palette

`Albedo A` is the dominant surface, `Albedo B` the secondary that blends in by slope or noise.
`Rough` is the perceptual roughness range (low, high). `Nrm` is the normal-map amplitude
multiplier. `Tri` is the triplanar world-space texel scale in metres per tile.

| Id | Albedo A (sRGB) | Albedo B (sRGB) | Rough lo-hi | Nrm | Tri (m) | Blend driver |
|---|---|---|---|---|---|---|
| `lnd_cinder_strand` | 42,36,33 | 96,84,72 | 0.62-0.88 | 1.00 | 2.4 | wetness by distance to waterline |
| `lnd_evaporite_pans` | 226,220,206 | 178,140,120 | 0.30-0.72 | 0.55 | 3.2 | polygon crack mask |
| `lnd_stiltwood_swamp` | 58,52,40 | 88,96,64 | 0.70-0.94 | 0.85 | 1.8 | water depth |
| `lnd_ashfern_slope` | 76,70,60 | 104,110,80 | 0.68-0.90 | 1.15 | 3.0 | slope |
| `lnd_quillgrass_plateau` | 96,116,86 | 130,140,104 | 0.72-0.92 | 0.90 | 2.6 | fbm patchiness |
| `lnd_windcut_spires` | 118,110,98 | 74,66,58 | 0.48-0.80 | 1.60 | 4.5 | stratification bands |
| `lnd_ashcone_summit` | 48,42,38 | 168,150,66 | 0.55-0.86 | 1.25 | 2.2 | sulphur mask |
| `sea_crater_reef` | 232,224,196 | 196,132,110 | 0.42-0.74 | 0.80 | 2.0 | coral coverage |
| `sea_fanstone_gardens` | 210,142,116 | 128,84,96 | 0.38-0.70 | 1.10 | 1.6 | rugosity |
| `sea_ribbonkelp` | 78,84,66 | 52,48,44 | 0.60-0.88 | 1.20 | 2.8 | holdfast density |
| `sea_pale_dunes` | 224,214,190 | 172,158,132 | 0.50-0.78 | 0.45 | 6.0 | ripple direction field |
| `sea_silt_meadow` | 138,132,104 | 88,96,70 | 0.66-0.90 | 0.55 | 2.4 | blade density |
| `sea_tumbled_boulders` | 88,84,80 | 118,124,110 | 0.52-0.86 | 1.55 | 3.6 | encrusting growth |
| `sea_shelf_break` | 96,92,88 | 62,58,56 | 0.46-0.82 | 1.45 | 4.0 | slope-driven sediment veneer |
| `sea_sunken_canyon` | 74,72,72 | 44,44,48 | 0.44-0.80 | 1.70 | 4.8 | strata banding |
| `sea_ashfall_basin` | 58,56,54 | 40,38,38 | 0.72-0.94 | 0.40 | 5.4 | ash drift thickness |
| `sea_lampcap_forest` | 62,56,48 | 84,72,58 | 0.68-0.92 | 1.05 | 2.2 | mycelial crust |
| `sea_ossuary_flats` | 176,170,156 | 120,116,108 | 0.55-0.82 | 0.60 | 3.0 | bone-fragment gravel |
| `sea_emberfield_vents` | 34,30,30 | 178,96,42 | 0.58-0.90 | 1.50 | 2.0 | heat proximity |
| `sea_glass_sponge` | 96,102,110 | 190,206,220 | 0.28-0.62 | 0.95 | 2.6 | sponge coverage |
| `sea_halocline_basin` | 108,102,86 | 208,196,168 | 0.34-0.70 | 0.50 | 3.4 | salt crust |
| `sea_geode_hollows` | 82,78,86 | 168,150,196 | 0.14-0.58 | 1.35 | 1.8 | crystal coverage |
| `sea_hadal_draw` | 30,30,34 | 54,52,58 | 0.50-0.86 | 1.85 | 5.2 | strata + talus |
| `sea_abyssal_plain` | 68,66,64 | 48,48,50 | 0.74-0.94 | 0.35 | 7.0 | nodule field mask |
| `sea_open_blue` | n/a | n/a | n/a | n/a | n/a | no terrain |

### 7.3 Water optics per biome

`tauA`, `tauS`, `tauKd` multiply the base coefficients from section 5.1. `Tint` is the inscatter
colour at the biome's mid depth, already including the depth-dependent spectral shift (art
reference; the shader computes it).

`Vis` is NOT authored independently - it is the exact result of

```
Vis = 3.912 / (0.0680*tauA + 0.0045*tauS)      [metres]
```

Changing `tauA` or `tauS` changes `Vis`; the table below is consistent to +/- 0.3 m and any edit
must recompute the column.

| Id | tauA | tauS | tauKd | Vis (m) | Inscatter tint (sRGB) | Notes |
|---|---|---|---|---|---|---|
| `sea_crater_reef` | 1.00 | 1.60 | 1.05 | 52.0 | 86,190,196 | Bright turquoise, sand-bounced |
| `sea_fanstone_gardens` | 1.02 | 1.80 | 1.07 | 50.5 | 66,172,190 | Slight coral mucus haze |
| `sea_ribbonkelp` | 1.55 | 3.70 | 1.62 | 32.1 | 44,110,96 | Green-brown, kelp exudate (CDOM) |
| `sea_pale_dunes` | 1.00 | 2.60 | 1.08 | 49.1 | 62,158,180 | Sand backscatter, very bright |
| `sea_silt_meadow` | 1.30 | 4.20 | 1.38 | 36.5 | 70,140,132 | Suspended silt |
| `sea_tumbled_boulders` | 1.05 | 2.00 | 1.10 | 48.7 | 30,102,132 | |
| `sea_shelf_break` | 0.95 | 0.92 | 0.95 | 56.9 | 18,80,124 | Cleanest water on the shelf |
| `sea_sunken_canyon` | 1.15 | 3.60 | 1.22 | 41.4 | 10,44,78 | Nepheloid layer near the floor |
| `sea_ashfall_basin` | 2.10 | 8.40 | 2.25 | 21.7 | 26,32,38 | Ash haze, grey not blue |
| `sea_lampcap_forest` | 1.40 | 3.60 | 1.48 | 35.1 | 20,54,52 | Spore load, faint green cast |
| `sea_ossuary_flats` | 1.10 | 2.90 | 1.16 | 44.5 | 14,38,58 | Bone-dust haze near the floor |
| `sea_emberfield_vents` | 1.90 | 11.00 | 2.05 | 21.9 | 44,26,18 | Shimmer + mineral plume; refractive distortion 0.9 m amplitude |
| `sea_glass_sponge` | 0.90 | 0.88 | 0.90 | 60.0 | 4,16,30 | Clearest water in the game; unnervingly far sight lines in the dark |
| `sea_halocline_basin` | 1.20 | 3.40 | 1.28 | 40.4 | 12,30,26 | Above the halocline |
| `sea_halocline_basin` (in brine) | 6.50 | 40.00 | 7.00 | 6.3 | 60,52,20 | Inside the brine layer: amber, near-opaque |
| `sea_geode_hollows` | 0.88 | 1.20 | 0.90 | 60.0 | 30,26,54 | Cave water, crystal-reflected violet |
| `sea_hadal_draw` | 1.00 | 1.30 | 1.00 | 53.0 | 0,2,6 | Clear and utterly black |
| `sea_abyssal_plain` | 0.98 | 1.10 | 0.98 | 54.6 | 2,8,20 | |
| `sea_open_blue` | 0.94 | 0.90 | 0.94 | 57.6 | depth-dependent | Nothing to occlude; the void reads as infinite |

### 7.4 Flora density

Instances per 100 m^2 of biome surface. Values are means; per-chunk Poisson-disc sampling uses
these as intensity and the minimum radius listed in the flora registry.

| Id | Flora (id : per 100 m^2) |
|---|---|
| `lnd_cinder_strand` | `fl_cinder_moss`:14.0, `fl_pan_halophyte`:1.2, `fl_bulb_palm`:0.18 |
| `lnd_evaporite_pans` | `fl_saltcrust`:6.5, `fl_pan_halophyte`:3.4 |
| `lnd_stiltwood_swamp` | `fl_stiltwood`:1.9, `fl_pipe_reed`:22.0, `fl_cinder_moss`:8.0 |
| `lnd_ashfern_slope` | `fl_ashfern`:9.5, `fl_glass_thistle`:2.1, `fl_cinder_moss`:11.0, `fl_bulb_palm`:0.35 |
| `lnd_quillgrass_plateau` | `fl_quillgrass`:64.0, `fl_glass_thistle`:3.8, `fl_ashfern`:2.4 |
| `lnd_windcut_spires` | `fl_wind_lichen`:19.0, `fl_glass_thistle`:1.1 |
| `lnd_ashcone_summit` | `fl_cinder_moss`:2.2, `fl_wind_lichen`:5.0 |
| `sea_crater_reef` | `fl_fanstone_coral`:5.4, `fl_fingerweed`:12.0, `fl_siltgrass`:26.0, `fl_lampweed`:7.5, `fl_pillar_coral`:0.9 |
| `sea_fanstone_gardens` | `fl_fanstone_coral`:18.0, `fl_pillar_coral`:6.2, `fl_fingerweed`:9.0, `fl_urn_sponge`:1.4 |
| `sea_ribbonkelp` | `fl_ribbonkelp`:2.6, `fl_bladderweed`:7.8, `fl_fingerweed`:14.0, `fl_urn_sponge`:0.7 |
| `sea_pale_dunes` | `fl_siltgrass`:1.8, `fl_fingerweed`:0.6 |
| `sea_silt_meadow` | `fl_siltgrass`:88.0, `fl_bladderweed`:1.1, `fl_lampweed`:3.2 |
| `sea_tumbled_boulders` | `fl_urn_sponge`:6.4, `fl_fingerweed`:5.0, `fl_dead_fan`:0.8 |
| `sea_shelf_break` | `fl_dead_fan`:2.6, `fl_urn_sponge`:3.1, `fl_veil_moss`:4.0 |
| `sea_sunken_canyon` | `fl_dead_fan`:3.4, `fl_veil_moss`:9.0, `fl_glass_sponge`:1.2 |
| `sea_ashfall_basin` | `fl_veil_moss`:12.0, `fl_dead_fan`:0.5 |
| `sea_lampcap_forest` | `fl_lampcap`:0.42, `fl_glowcup`:16.0, `fl_veil_moss`:6.0 |
| `sea_ossuary_flats` | `fl_bone_coral`:7.2, `fl_veil_moss`:3.4, `fl_glass_sponge`:0.9 |
| `sea_emberfield_vents` | `fl_tuberod`:34.0, `fl_brine_mat`:5.5 |
| `sea_glass_sponge` | `fl_glass_sponge`:11.5, `fl_dead_fan`:1.8, `fl_veil_moss`:2.0 |
| `sea_halocline_basin` | `fl_brine_mat`:18.0, `fl_veil_moss`:4.2 |
| `sea_geode_hollows` | `fl_calcite_spar`:9.0, `fl_amethyst_druse`:14.0, `fl_glass_sponge`:1.4 |
| `sea_hadal_draw` | `fl_hadal_wisp`:2.1, `fl_veil_moss`:0.9 |
| `sea_abyssal_plain` | `fl_dead_fan`:1.1, `fl_veil_moss`:2.8, `fl_glass_sponge`:0.4 |
| `sea_open_blue` | none |

### 7.5 Fauna density

Individuals per hectare (10 000 m^2) of biome surface, or per 10^6 m^3 for pelagic entries
(marked `[v]`). Schooling entries count individuals, not schools.

| Id | Fauna (id : per ha) |
|---|---|
| `lnd_cinder_strand` | `f_shorehopper`:22.0, `f_paddlecrab`:6.0 |
| `lnd_evaporite_pans` | `f_pansnail`:14.0, `f_shorehopper`:4.0 |
| `lnd_stiltwood_swamp` | `f_stiltcrab`:18.0, `f_shorehopper`:26.0, `f_kitewing`:0.6 |
| `lnd_ashfern_slope` | `f_kitewing`:1.4, `f_shorehopper`:5.0 |
| `lnd_quillgrass_plateau` | `f_kitewing`:2.2, `f_shorehopper`:3.0 |
| `lnd_windcut_spires` | `f_ashwing`:0.8, `f_kitewing`:1.0 |
| `lnd_ashcone_summit` | `f_ashwing`:1.6 |
| `sea_crater_reef` | `f_glimmerfin`:340.0, `f_reefdarter`:44.0, `f_paddlecrab`:12.0, `f_sandsifter`:3.2, `f_tidepipe`:9.0, `f_bladderjelly`:16.0, `f_lanternshoal`:120.0 (night only), `f_shellback`:1.8 |
| `sea_fanstone_gardens` | `f_reefdarter`:62.0, `f_glimmerfin`:180.0, `f_ribboneel`:2.4, `f_sunwingray`:0.7, `f_shellback`:2.6, `f_spinejaw`:0.35 |
| `sea_ribbonkelp` | `f_kelpgrazer`:1.1, `f_glimmerfin`:150.0, `f_ribboneel`:3.0, `f_spinejaw`:0.9, `f_shellback`:2.0 |
| `sea_pale_dunes` | `f_sandsifter`:6.8, `f_paddlecrab`:9.0, `f_sunwingray`:1.4, `f_spinejaw`:0.6 |
| `sea_silt_meadow` | `f_glimmerfin`:210.0, `f_sandsifter`:4.4, `f_shellback`:3.1, `f_siltcrawler`:5.0 |
| `sea_tumbled_boulders` | `f_boulderjaw`:0.45, `f_ribboneel`:4.2, `f_glasslancer`:3.0, `f_siltcrawler`:7.0 |
| `sea_shelf_break` | `f_glasslancer`:5.5, `f_hollowdrifter`:1.2, `f_thornray`:0.22, `f_sunwingray`:0.8 |
| `sea_sunken_canyon` | `f_glasslancer`:4.0, `f_thornray`:0.35, `f_spirecrawler`:1.8, `f_siltcrawler`:6.0, `f_hollowdrifter`:1.6 |
| `sea_ashfall_basin` | `f_ashmoth`:16.0, `f_siltcrawler`:8.0, `f_gulpermaw`:0.09 |
| `sea_lampcap_forest` | `f_lamplure`:2.8, `f_siltcrawler`:9.0, `f_bonecrawler`:1.4, `f_dredgemaw`:0.06 |
| `sea_ossuary_flats` | `f_bonecrawler`:6.5, `f_lamplure`:1.9, `f_dredgemaw`:0.11, `f_veildrifter`:0.008 |
| `sea_emberfield_vents` | `f_ventcrab`:44.0, `f_ashmoth`:7.0, `f_glasswraith`:0.14, `f_spirecrawler`:2.2 |
| `sea_glass_sponge` | `f_glasswraith`:0.28, `f_ashmoth`:5.0, `f_voidbloom`:0.9, `f_palefathom`:0.02 |
| `sea_halocline_basin` | `f_brinewyrm`:0.16, `f_ventcrab`:12.0, `f_bonecrawler`:2.0, `f_voidbloom`:1.4 |
| `sea_geode_hollows` | `f_spirecrawler`:3.6, `f_glasswraith`:0.22, `f_voidbloom`:2.1 |
| `sea_hadal_draw` | `f_stonelurker`:0.30, `f_hadalcoil`:0.05, `f_voidbloom`:1.8, `f_trenchsinger`:0.0016 |
| `sea_abyssal_plain` | `f_gulpermaw`:0.12, `f_palefathom`:0.03, `f_ashmoth`:4.0, `f_bonecrawler`:1.0 |
| `sea_open_blue` | `[v]` `f_veildrifter`:0.05, `f_hollowdrifter`:2.2, `f_glimmerfin`:400.0 (above -60 m), `f_thornray`:0.10, `f_palefathom`:0.006 |

Hard constraint restated: for any point inside the safe volume (section 4.2) every entry with
`dangerTier >= 2` is multiplied by 0. `sea_crater_reef` and `sea_silt_meadow` inside the crater
therefore contain nothing above tier 1.

### 7.6 Ore density

Nodes per hectare. Node clusters use a blue-noise mask with cluster radius 22 m and 3-9 nodes per
cluster unless noted.

| Id | Ore (id : nodes per ha) |
|---|---|
| `lnd_cinder_strand` | `ore_titanic_sand`:2.0, `ore_magnetite`:1.2 |
| `lnd_evaporite_pans` | `ore_lithic_brine`:3.4, `ore_sulfur_bloom`:1.0 |
| `lnd_stiltwood_swamp` | `ore_ferronodule`:0.8 |
| `lnd_ashfern_slope` | `ore_quartzite`:2.6, `ore_magnetite`:2.0, `ore_obsidian`:1.4 |
| `lnd_quillgrass_plateau` | `ore_quartzite`:1.4 |
| `lnd_windcut_spires` | `ore_quartzite`:3.8, `ore_obsidian`:2.2 |
| `lnd_ashcone_summit` | `ore_sulfur_bloom`:6.0, `ore_obsidian`:4.4, `ore_magnetite`:3.0 |
| `sea_crater_reef` | `ore_ferronodule`:1.6, `ore_quartzite`:1.0, `ore_titanic_sand`:1.2 |
| `sea_fanstone_gardens` | `ore_cupric`:2.2, `ore_quartzite`:1.8, `ore_ferronodule`:1.4 |
| `sea_ribbonkelp` | `ore_cupric`:3.0, `ore_ferronodule`:2.0, `ore_magnetite`:1.1 |
| `sea_pale_dunes` | `ore_titanic_sand`:7.5, `ore_ferronodule`:4.2 |
| `sea_silt_meadow` | `ore_ferronodule`:2.6 |
| `sea_tumbled_boulders` | `ore_cupric`:4.0, `ore_magnetite`:3.2, `ore_quartzite`:2.4 |
| `sea_shelf_break` | `ore_magnetite`:2.8, `ore_aurific`:0.6, `ore_quartzite`:2.0 |
| `sea_sunken_canyon` | `ore_aurific`:1.4, `ore_argentine`:1.0, `ore_violet_geode`:0.7, `ore_magnetite`:2.2 |
| `sea_ashfall_basin` | `ore_obsidian`:5.0, `ore_sulfur_bloom`:2.4, `ore_ferronodule`:3.0 |
| `sea_lampcap_forest` | `ore_phosphor_nodule`:4.6, `ore_violet_geode`:1.2 |
| `sea_ossuary_flats` | `ore_phosphor_nodule`:2.8, `ore_argentine`:1.6, `ore_ferronodule`:3.4 |
| `sea_emberfield_vents` | `ore_thermolith`:5.2, `ore_baritine`:3.8, `ore_sulfur_bloom`:6.6, `ore_cupric`:4.0 |
| `sea_glass_sponge` | `ore_baritine`:2.0, `ore_argentine`:2.4, `ore_clathrate`:1.6 |
| `sea_halocline_basin` | `ore_lithic_brine`:9.0, `ore_clathrate`:6.4, `ore_baritine`:1.8 |
| `sea_geode_hollows` | `ore_calcite_spar_ore`:8.5, `ore_violet_geode`:6.0, `ore_argentine`:2.0 |
| `sea_hadal_draw` | `ore_iridic`:1.1, `ore_clathrate`:3.2, `ore_argentine`:1.4 |
| `sea_abyssal_plain` | `ore_ferronodule`:9.5, `ore_argentine`:1.2, `ore_phosphor_nodule`:1.0 |
| `sea_open_blue` | none |

### 7.7 Audio, hazards, tier

Hazard ids are owned by the survival section; this table is the authoritative placement.

| Id | Audio bed | Hazards (id : magnitude) | Tier |
|---|---|---|---|
| `lnd_cinder_strand` | `amb_wind_beach` | none | 0 |
| `lnd_evaporite_pans` | `amb_saltflat` | `hz_heat`:+6 C midday | 0 |
| `lnd_stiltwood_swamp` | `amb_swamp` | `hz_entangle`:0.4 m/s move penalty | 0 |
| `lnd_ashfern_slope` | `amb_wind_upland` | `hz_fall`: slope > 40 deg | 0 |
| `lnd_quillgrass_plateau` | `amb_wind_upland` | none | 0 |
| `lnd_windcut_spires` | `amb_spire_moan` | `hz_fall`: drop up to 148 m; `hz_wind`:18 m/s gusts | 1 |
| `lnd_ashcone_summit` | `amb_summit_fumarole` | `hz_toxin`:SO2 0.4 units/s in vent plumes; `hz_heat`:+22 C | 1 |
| `sea_crater_reef` | `amb_reef_day` / `amb_reef_night` | none | 0 |
| `sea_fanstone_gardens` | `amb_reef_day` | `hz_sting`:coral contact 2 dmg | 1 |
| `sea_ribbonkelp` | `amb_kelp` | `hz_entangle`:0.55 speed multiplier in canopy | 1 |
| `sea_pale_dunes` | `amb_dune` | `hz_current`:0.9 m/s ripple drift | 1 |
| `sea_silt_meadow` | `amb_meadow` | `hz_silt`: visibility x0.5 when disturbed, 14 s recovery | 1 |
| `sea_tumbled_boulders` | `amb_boulder` | `hz_crush`: rockfall 4% per boulder disturb, 30 dmg | 2 |
| `sea_shelf_break` | `amb_shelfbreak` | `hz_current`:1.6 m/s downwelling | 2 |
| `sea_sunken_canyon` | `amb_canyon` | `hz_current`:2.4 m/s along-axis; `hz_rockfall` | 3 |
| `sea_ashfall_basin` | `amb_terrace` + `amb_abyss` | `hz_silt`: visibility x0.35, 40 s recovery; `hz_bury`: soft floor sink 1.4 m | 3 |
| `sea_lampcap_forest` | `amb_lampcap` | `hz_spore`: O2 consumption x1.25 inside canopy | 3 |
| `sea_ossuary_flats` | `amb_ossuary` | none (the horror is atmospheric) | 3 |
| `sea_emberfield_vents` | `amb_vent` | `hz_heat`:up to 340 C in plume, 55 dmg/s within 3.5 m of a vent mouth; `hz_toxin`:H2S 1.2 units/s | 4 |
| `sea_glass_sponge` | `amb_sponge` | `hz_laceration`:silica spicules, 6 dmg on contact | 4 |
| `sea_halocline_basin` | `amb_brine` | `hz_brine`: 8 dmg/s unsuited inside the brine layer; buoyancy inversion (see 8.4) | 4 |
| `sea_geode_hollows` | `amb_geode` | `hz_laceration`:12 dmg; `hz_confine`: no surface route, 100% O2 dependency | 4 |
| `sea_hadal_draw` | `amb_draw` | `hz_pressure`: hull tier 4 required; `hz_dark`: zero ambient | 5 |
| `sea_abyssal_plain` | `amb_abyss` | `hz_dark` | 4 |
| `sea_open_blue` | `amb_openblue` | `hz_disorient`: no horizon reference below -120 m | 2-5 |

### 7.8 Art direction

**1. Cinder Strand.** Black volcanic sand shot through with olivine green and pale coral rubble,
so the beach reads as two-tone at grazing angles. Wet sand near the waterline goes almost mirror
dark and holds a thin sheet of retreating water that catches the sky. This is the first surface
the player ever stands on: it must feel warm, safe and slightly alien, never dramatic.

**2. Evaporite Pans.** Polygonal salt crust in flat white plates 1-3 m across with raised, curled
edges, separated by brine channels the colour of weak tea. Shallow pools go pink-orange from
halophile mats and reflect the sky like broken glass. At midday the whole area is over-bright and
the horizon shimmers.

**3. Stiltwood Swamp.** Grey-brown arching prop roots in ankle-deep tannin water, canopy at 7 m
letting through dappled green light. The water surface is a dark mirror broken by reed stems, so
the player sees two versions of the canopy. Sound is close and busy; this is the noisiest place
in the game.

**4. Ashfern Slopes.** Coarse grey-brown scoria with olive-grey ferns clumped in the lee of
boulders, thinning uphill. Long low light in the morning throws hard ridge shadows across the
slope. It should feel like walking on a young volcano: crunchy, unstable, sparse.

**5. Quillgrass Plateau.** A tilted table of blue-green stiff quills 1.3 m high that move as a
single sheet in the wind, with bare pale rock showing through in wind-scoured lanes. The alien
note is the colour and the motion - the grass ripples in travelling bands rather than randomly.
Best viewed from the summit at dusk.

**6. Windcut Spires.** Stratified rock fins and needles 40-148 m tall, undercut at the base,
banded in ochre and grey, crusted orange with lichen on the windward faces. Gaps between spires
act as wind tunnels that visibly stream dust. This is the island's landmark silhouette, readable
from 3 km at sea.

**7. Ashcone Summit.** A shallow ash bowl with sulphur-yellow rims around a dozen small
fumaroles, steam ribboning downwind. Ground is warm-toned black with mineral crusts. From the rim
the whole crater lagoon is visible as a turquoise ring - the establishing shot of the game.

**8. Crater Reef Shallows.** Brilliant turquoise over white carbonate sand, patch reefs of orange
fanstone, meadows of siltgrass bending in the surge, godrays reaching the floor at 15 m. Nothing
here is dangerous and the art must say so instantly: high key, high saturation, wide open sight
lines, no dark holes. At night, lampweed and lantern shoals turn the lagoon into a faint blue
starfield.

**9. Fanstone Coral Gardens.** Dense structural coral: orange-pink plates stacked into overhangs,
cream-to-violet pillars 2-3 m tall, canyons of living rock 4-6 m deep. Colour saturation drops
with depth so the outer gardens read almost monochrome blue. Fish density peaks here; it should
feel crowded and loud.

**10. Ribbonkelp Forest.** 22 m stipes rising to a surface canopy that filters light into moving
green shafts, understory in permanent gloom. Water is noticeably greener and murkier than
anywhere else on the shelf. The forest is disorienting by design: no straight sight line exceeds
32 m and the canopy hides the sky.

**11. Pale Dunes.** Vast rippled carbonate sand in long parallel bedforms 8-14 m wavelength, near
featureless, blindingly bright. Occasional dark placer streaks of titanic sand and a scattering
of ferro-nodules give the eye something to track. The emptiness is the point: it is the first
place the player feels how big the world is.

**12. Silt Meadow.** A continuous knee-high sward of siltgrass over soft grey mud, bending in
unison with the surge, punctuated by grazing craters and burrow mounds. Disturbing the floor
raises a silt cloud that hangs and slowly settles. Warm green-grey palette, very soft lighting,
extremely calm.

**13. Tumbled Boulder Field.** House-sized angular basalt blocks piled at the foot of the
southwest slope, encrusted with urn sponges and red fingerweed, with black gaps between them that
the lights do not reach. This is the first biome where the player is afraid of a hole. Keep the
geometry genuinely occlusive; do not fake the darkness with fog.

**14. Shelf Break Wall.** A near-continuous 22-40 degree ramp of bare swept rock, sediment
cascading down it in slow rivulets, dropping from the bright shelf into blue nothing. The water
here is the clearest in the game, so the wall is visible for 57 m and the drop beyond is visible
for zero. Best single "edge of the known" composition in the world.

**15. Sunken Canyon Walls.** Banded strata in grey and near-black, walls 200-370 m apart, floored
by a pale nepheloid haze that hides the bottom. Debris cones fan out from wall notches. Sound is
combed and reflective; the canyon tells you it is a corridor before your eyes do.

**16. Ashfall Basin.** A grey, soft, snow-like plain of volcanic ash under a permanent haze that
kills contrast at 24 m. Objects loom out of it and vanish. Colour is almost fully desaturated -
this is the only biome in the game that is not blue, and the break in palette is deliberately
unsettling.

**17. Lampcap Forest.** Caps 6-8 m across on thick pale stalks, glowing cyan-green at 6.8 cd/m^2,
with amber glowcups scattered across the mycelial floor beneath. The only light source is the
biology, so everything is uplit and everything casts a moving shadow upward. Beautiful first,
wrong second: the light is too even, and the spore haze means something can be 12 m away and
invisible.

**18. Ossuary Flats.** A pale gravel plain of comminuted bone, out of which rise the articulated
skeletons of very large animals - ribcages 30-40 m long, vertebral columns, one intact skull.
White bone coral grows on the older bones. There is no explanation and there will never be one;
the flats simply are where these animals come to die.

**19. Emberfield Vents.** Black chimneys 3-14 m tall venting shimmering 340 C fluid into
near-freezing water, ringed by dense red tuberod colonies and white vent crabs. Refractive
distortion, orange bottom-lighting from the vent mouths, and mineral snow drifting sideways in
the current. Warm, violent and alive in a place that should be neither.

**20. Glass Sponge Barrens.** A silent silica forest: lattice sponges 2-3 m tall, translucent and
faintly refractive, spaced 8-12 m apart on a flat grey floor with the clearest water in the deep
ocean. The lights travel further here than anywhere else, which means the player can see
something large at the edge of the beam long before it can be identified.

**21. Halocline Basin.** A brine lake at the bottom of the sea. The hypersaline layer is 75 m
thick with a genuine, visible, reflective surface at y = -540 m over which the player's lights
skim. Brine mats fringe the shore in olive and cream. Above the surface the water is normal;
below it, visibility is 6 m of amber and everything is wrong.

**22. Geode Hollows.** Dissolution caverns in the trench wall, lined floor to ceiling with clear
calcite blades up to 3.4 m and violet amethyst druse, refracting the vessel's lights into moving
caustic fans across every surface. Tight, confined, no route to the surface. The most beautiful
place in the game and the one most likely to kill you by clock.

**23. The Draw.** A 920 m wide, 1200 m deep gash with near-vertical banded walls and a flat black
floor at -1605 m. Zero ambient light at any hour. Sparse hadal wisps mark the floor in faint
blue. The only sound is infrasound. Everything here is scaled to make the vessel feel like an
insect.

**24. Abyssal Plain.** Endless flat grey-brown ooze, dimpled with ferro-nodules laid out like
cobbles, punctuated by black skeletal dead fans. Absolutely featureless in the middle distance.
The plain exists to make the trench and the vents feel like events.

**25. Open Blue.** No terrain, no floor, no reference. Just graded blue-to-black in every
direction, occasional marine snow drifting up past the windshield as you descend, and once in a
long while a 62 m veil drifter passing at the very limit of the lights. Nothing in the game is
more frightening than this biome's total absence of content.

---

## 8. BIOME MASK FUNCTION

### 8.1 Field bundle

Every biome query is evaluated against a bundle of scalar fields computed once per surface sample
and cached in the chunk's field texture (`rgba16float` x 2, 33x33 per 64 m chunk).

| Field | Symbol | Range | Definition |
|---|---|---|---|
| Height | `h` | -1605..188 | `H(x,z)` from section 2.4 |
| Depth | `d` | -188..1605 | `-h` |
| Slope | `slope` | 0..pi/2 | `acos(dot(normal, +Y))` |
| Rugosity | `rug` | 0..1 | `clamp(length(grad2H) * 0.55, 0, 1)`, 6 m stencil |
| Substrate | `sub` | 0..1 | 0 = bare rock, 1 = fine sediment. `sub = clamp(1.15 - 2.1*slope - 0.5*rug + 0.35*fbm(x,z,201,4,1/180), 0, 1)` |
| Exposure | `exp` | 0..1 | wave/current energy. `exp = clamp(0.15 + 0.85*smoothstep(0,26,d)*(1-shelter), 0, 1)` where `shelter` is the reef-rim occlusion term |
| Nutrient | `nut` | 0..1 | `0.5 + 0.5*fbm(x,z,211,5,1/620)` biased +0.25 within 400 m of land |
| Heat | `heat` | 0..1 | `exp(-ventDist/210)` from the vent polyline |
| Salinity | `sal` | 0..1 | 0 = normal, 1 = brine. `sal = smoothstep(-520,-545,y) * insideBrineBasin` |
| Light | `lit` | 0..1 | `Y(d)` from section 5.1, clamped |
| Bearing | `bear` | 0..360 | `atan2(x-ISLE.x, -(z-ISLE.z))` in degrees, wrapped |
| Isle radius | `dIsle` | 0..6000 | `hypot(x-ISLE.x, z-ISLE.z)` |
| Region id | `reg` | enum | from section 3 placement rules, evaluated in table order |

### 8.2 Gate table

Each biome has a gate over the fields. `-` means unconstrained. Gates are soft: each numeric
range contributes `smoothstep` falloff over the `soften` width listed in the last column, so the
result is a weight in [0,1] rather than a boolean.

| Biome | h/d range | slope (deg) | rug | sub | exp | other gate | prio | soften |
|---|---|---|---|---|---|---|---|---|
| `lnd_cinder_strand` | h 0..6 | 0..12 | - | >0.55 | - | dist(waterline) < 90 m | 20 | 1.5 m |
| `lnd_evaporite_pans` | h 0.4..3.6 | 0..4 | <0.15 | >0.70 | - | stamp `pans` | 40 | 1.0 m |
| `lnd_stiltwood_swamp` | h -0.6..3.0 | 0..6 | <0.25 | >0.60 | - | stamp `swamp` | 40 | 1.2 m |
| `lnd_ashfern_slope` | h 6..70 | 8..34 | - | 0.2..0.8 | - | - | 10 | 4.0 m |
| `lnd_quillgrass_plateau` | h 62..94 | 0..11 | <0.30 | >0.45 | - | stamp `plateau` | 35 | 3.0 m |
| `lnd_windcut_spires` | h 40..188 | >38 | >0.55 | <0.25 | - | spire mask > 0.35 | 45 | 3.0 m |
| `lnd_ashcone_summit` | h >92 | - | - | - | - | dIsle < 260 | 30 | 6.0 m |
| `sea_crater_reef` | d 0..26 | 0..25 | - | - | - | dIsle < 1250 | 50 | 6.0 m |
| `sea_fanstone_gardens` | d 3..48 | - | >0.30 | <0.55 | >0.30 | bear 300..140 | 25 | 5.0 m |
| `sea_ribbonkelp` | d 14..68 | 0..40 | >0.20 | <0.60 | 0.25..0.85 | bear 232..315 | 25 | 6.0 m |
| `sea_pale_dunes` | d 24..95 | 0..9 | <0.20 | >0.70 | - | bear 40..110 | 22 | 8.0 m |
| `sea_silt_meadow` | d 8..52 | 0..7 | <0.18 | >0.65 | <0.35 | - | 22 | 5.0 m |
| `sea_tumbled_boulders` | d 30..118 | - | >0.55 | <0.40 | - | bear 175..232 | 26 | 6.0 m |
| `sea_shelf_break` | d 70..165 | >22 | - | <0.55 | - | - | 18 | 8.0 m |
| `sea_sunken_canyon` | d >150 | - | - | - | - | in canyon corridor | 60 | 24.0 m |
| `sea_ashfall_basin` | d >380 | 0..14 | <0.20 | >0.85 | - | stamp `ashfall` | 55 | 30.0 m |
| `sea_lampcap_forest` | d 215..320 | 0..28 | - | >0.40 | - | stamp `lampcap` | 55 | 20.0 m |
| `sea_ossuary_flats` | d 285..345 | 0..12 | <0.25 | >0.60 | - | stamp `ossuary` | 55 | 22.0 m |
| `sea_emberfield_vents` | d 395..475 | - | - | - | - | heat > 0.12 | 70 | 40.0 m |
| `sea_glass_sponge` | d 735..835 | 0..16 | - | >0.50 | - | stamp `sponge` | 55 | 26.0 m |
| `sea_halocline_basin` | d >430 | - | - | - | - | stamp `brine` | 65 | 30.0 m |
| `sea_geode_hollows` | d 560..1050 | - | - | - | - | inside cave SDF | 90 | 4.0 m |
| `sea_hadal_draw` | d >400 | - | - | - | - | in trench corridor | 80 | 40.0 m |
| `sea_abyssal_plain` | d >400 | 0..20 | - | - | - | fallback | 5 | 40.0 m |
| `sea_open_blue` | - | - | - | - | - | floorDist > 150 and terrainDist > 400 | 1 | 60.0 m |

### 8.3 Selection algorithm

```js
// Evaluated per terrain vertex at meshing time, and per entity at spawn time.
// Returns up to 4 (biomeId, weight) pairs with weights summing to 1.

function biomeWeights(x, z, y) {
  const F = fieldBundle(x, z, y);          // section 8.1
  const cand = [];

  for (const B of BIOMES) {                // 25 entries, static table
    // --- hard gates: any zero kills the candidate outright
    if (B.landOnly  && F.h <= 0) continue;
    if (B.seaOnly   && F.h >  0) continue;
    if (B.stamp && stampMask(B.stamp, x, z) <= 0.0) continue;
    if (B.corridor && corridorMask(B.corridor, x, z) <= 0.0) continue;

    // --- soft gates: product of smooth band memberships
    let w = 1.0;
    w *= band(F.d,     B.dMin,   B.dMax,   B.soften);
    w *= band(F.slope, B.slpMin, B.slpMax, B.soften * 0.02);
    w *= band(F.rug,   B.rugMin, B.rugMax, 0.10);
    w *= band(F.sub,   B.subMin, B.subMax, 0.12);
    w *= band(F.exp,   B.expMin, B.expMax, 0.15);
    if (B.bearMin !== undefined) w *= bandWrapped(F.bear, B.bearMin, B.bearMax, 14.0);
    if (B.heatMin !== undefined) w *= smoothstep(B.heatMin*0.5, B.heatMin, F.heat);
    if (w <= 1e-4) continue;

    // --- per-biome noise breakup so borders are not analytic curves
    //     amplitude 0.22, wavelength 90 m; this is what makes patches interleave
    w *= 0.78 + 0.44 * fbm(x, z, B.noiseSeed, 3, 1/90);

    // --- priority acts as a multiplicative dominance, NOT a hard override
    w *= exp(B.prio * 0.045);

    cand.push({ id: B.id, w });
  }

  if (cand.length === 0) return [{ id: 'sea_abyssal_plain', w: 1 }];

  cand.sort((a, b) => b.w - a.w);
  const top = cand.slice(0, 4);
  const sum = top.reduce((s, c) => s + c.w, 0);
  for (const c of top) c.w /= sum;

  // --- safe-zone override: strip anything that would place tier>=2 content
  if (isSafe({x, y, z})) markSafe(top);

  return top;
}

// smooth band membership with soften width s on both edges
function band(v, lo, hi, s) {
  if (lo === undefined && hi === undefined) return 1.0;
  const a = (lo === undefined) ? 1.0 : smoothstep(lo - s, lo + s, v);
  const b = (hi === undefined) ? 1.0 : (1.0 - smoothstep(hi - s, hi + s, v));
  return a * b;
}
```

Cost budget: 25 candidates x ~14 ops = ~350 ALU ops per vertex. At LOD0 a 64 m chunk has 4225
vertices, so 1.48 M ops per chunk, run once at chunk generation on a compute pass (workgroup
8x8), not per frame. Measured target: under 0.35 ms per chunk on an M2.

### 8.4 Special-case volumetric masks

Two biomes are volumes, not surfaces, and are evaluated per-camera-position rather than
per-vertex.

**Open Blue (`sea_open_blue`).** Active when `floorDist > 150 m` AND `terrainDist > 400 m` AND
`y < 0`. It contributes only water optics, ambient audio and pelagic spawns; it never contributes
a terrain material. Weight ramps in over 60 m of `floorDist` past the threshold.

**Brine layer (`sea_halocline_basin` sub-state).** Inside the Halocline Basin the water column is
two fluids.

| Property | Above halocline | Inside brine |
|---|---|---|
| Halocline surface | y = -540.0 m, +/- 1.2 m standing wave, period 26 s | - |
| Density | 1027 kg/m^3 | 1198 kg/m^3 |
| Buoyancy on the vessel | nominal | +16.7% net upthrust; the vessel floats on the brine unless ballast is flooded |
| Visibility | 41 m | 6 m |
| Absorption tint | 12,30,26 | 60,52,20 |
| Audio | `amb_brine` upper layer | `amb_brine` lower layer, LPF 320 Hz, -9 dB |
| Damage unsuited | 0 | `hz_brine` 8 dmg/s |
| Surface render | reflective interface with Fresnel F0 = 0.028, visible from both sides | - |

The halocline is rendered as a true surface: a horizontal plane at y = -540 with its own
reflection/refraction pass, restricted to the basin footprint and faded out over the last 40 m to
the rim. Seeing your own lights reflected off the underside of a lake that is itself underwater
is the single best image in the deep game; budget for it.

---

## 9. BIOME BLENDING RULES

| Rule | Value |
|---|---|
| Max simultaneous biomes per vertex | 4 |
| Weight storage | `rgba8unorm` biome index texture + `rgba8unorm` weight texture per chunk, 33x33 |
| Material blend | Linear in linear-light space for albedo; linear for roughness; weight-max for normal amplitude |
| Horizontal transition width (material) | 12.0 m nominal, overridden per biome by `soften` |
| Horizontal transition width (flora density) | 6.0 m - flora changes faster than ground, which reads correctly |
| Vertical (depth) transition width | equal to the biome's `soften` value in metres |
| Flora selection | Weighted lottery per Poisson-disc sample using the 4 weights; a sample is rejected entirely with probability `1 - maxWeight^0.5` inside a transition, which thins vegetation at borders |
| Fauna selection | Weighted lottery per spawn attempt; spawn budget is the weighted sum of per-biome densities |
| Ore selection | Weighted lottery, but ore clusters snap wholly to the dominant biome (no mixed clusters) |
| Water optics blend | `tauA/tauS/tauKd` blended by weight, evaluated at the camera position, smoothed with a 0.8 s time constant to prevent popping |
| Audio blend | Beds crossfade equal-power over the transition; crossfade time constant 1.4 s; maximum 3 concurrent beds, lowest weight is culled |
| Hazards | NOT blended. A hazard applies at full magnitude if its biome weight exceeds 0.35, otherwise not at all. Half-damage zones are unreadable to players |
| Danger tier | `ceil(max over biomes of tier * step(0.25, weight))` - the HUD shows the worst tier present, never an average |

**Hard-edged biomes** (transition width forced to 2.0 m regardless of `soften`, because a soft
edge would look wrong):

- `sea_geode_hollows` - cave mouths are geological, not gradual.
- `sea_halocline_basin` brine interface - it is a fluid boundary.
- `lnd_evaporite_pans` - evaporite margins are genuinely sharp.
- `sea_emberfield_vents` chimney bases - chemistry changes over centimetres.

**Forbidden adjacencies.** If the top-2 biomes are in this list, the lower-weight one is dropped
and weights renormalised; this prevents nonsense like coral growing inside a vent plume.

| A | B |
|---|---|
| `sea_emberfield_vents` | `sea_fanstone_gardens`, `sea_ribbonkelp`, `sea_silt_meadow`, `sea_crater_reef` |
| `sea_halocline_basin` (brine) | any land biome, `sea_crater_reef` |
| `sea_hadal_draw` | all `lnd_*`, `sea_crater_reef`, `sea_fanstone_gardens`, `sea_ribbonkelp` |
| `lnd_evaporite_pans` | `lnd_stiltwood_swamp` |
| `sea_geode_hollows` | all `lnd_*` |

---

## 10. LANDMARKS

22 hand-placed, uniquely authored features. Every one is geology or biology. XYZ are exact; `y`
is the anchor point (base of the feature unless noted) and has been validated against the
heightfield of section 2.4 to within 1 m.

| Id | Name | X | Y | Z | Type | Extent | Band | Purpose |
|---|---|---|---|---|---|---|---|---|
| `lm_ashcone_rim` | The Ashcone Rim | -700 | +101.9 | -700 | Volcanic crater, 12 fumaroles | 300 m dia., 34 m deep bowl | air | Establishing view of the whole crater lagoon |
| `lm_windcut_needle` | The Windcut Needle | -1120 | +95.8 | -620 | Rock spire | 92 m tall, tip at +188 m | air | Island silhouette, visible 3 km at sea |
| `lm_cinder_arch` | The Cinder Arch | -1300 | +15.8 | -430 | Natural basalt sea arch | 64 m span, 31 m clear headroom | surf | Flyable/swimmable gate; first "wow" |
| `lm_tide_mirror` | The Tide Mirror | -300 | +1.4 | -620 | Evaporite pan, permanent brine sheet | 140 m x 95 m, 0.05 m deep | surf | Perfect sky reflection at dawn |
| `lm_stiltwood_heart` | Stiltwood Heart | -800 | +1.0 | -215 | Single 19 m stiltwood, 40 m root span | 40 m dia. | surf | Largest organism on land |
| `lm_three_sisters` | The Three Sisters | -1455 | +21.1 | 240 | Three sea stacks | 27 / 19 / 14 m above water | surf | Navigation reference from the beach |
| `lm_blue_eye` | The Blue Eye | -1750 | -269.9 | -1500 | Karst blue hole | 190 m dia., lip -78 m, floor -270 m | sun-mid | First vertical descent, safe practice |
| `lm_lightfall` | Lightfall | -1980 | -46.6 | -1120 | Collapsed cave roof, single light shaft | 26 m dia. aperture | sun | One perfect god-ray column, 11:00-13:00 only |
| `lm_grandmother` | Grandmother Kelp | -2010 | -43.6 | -780 | Single ribbonkelp holdfast, 9 stipes | 44 m tall, canopy 26 m across | sun | Largest organism in the shallows |
| `lm_fanstone_crown` | The Fanstone Crown | -120 | -9.1 | -1620 | Coral bommie | 22 m dia., rises to -3 m | sun | Reef-rim signature, breaks the surface at low tide |
| `lm_dune_ribs` | The Dune Ribs | 900 | -55.3 | -330 | Half-buried ribcage of a very large animal | 38 m long, 11 m tall | sun | First skeleton; foreshadows the Ossuary |
| `lm_sunken_stair` | The Sunken Stair | -1230 | -180.1 | 700 | Canyon head, six stepped terraces | 240 m across, 175 m total drop | twi | Canyon entrance, obvious route down |
| `lm_stone_bloom` | The Stone Bloom | 1690 | -264.4 | 470 | Single lampcap, 21 m cap diameter | 24 m tall | mid | Brightest natural light source in the deep |
| `lm_pale_ossuary` | The Pale Ossuary | 2060 | -312.1 | -430 | Intact skull of a 90 m animal | 26 m long, 14 m tall, enterable | mid | Central dread image of the midnight band |
| `lm_sundered_fin` | The Sundered Fin | -2450 | -316.4 | -1900 | Fossilised dorsal structure standing upright | 58 m tall, 4 m thick | mid | Visible on sonar from 900 m; navigation anchor |
| `lm_emberthroat` | Emberthroat | 530 | -449.6 | -2400 | Bioluminescent geyser: superheated vent that ignites a 40 m column of blue-green biolum plankton every 96 s | 40 m column, 7 s duration | aby | Timed spectacle; lights the whole vent field |
| `lm_sighing_vent` | The Sighing Vent | 900 | -452.8 | -2680 | Resonant chimney, 22 m tall, emits 31 Hz tone | audible 1400 m | aby | Pure audio landmark, findable in the dark |
| `lm_brinefall` | The Brinefall | -1520 | -432.6 | 1520 | Brine cascade over a 108 m ledge into the basin | 90 m wide curtain | aby | Underwater waterfall; physically real density flow |
| `lm_halocline_mirror` | The Halocline Mirror | -1520 | -540.0 | 2000 | Surface of the brine lake | 1100 m dia. | aby | The lake under the sea |
| `lm_glass_cathedral` | The Glass Cathedral | -1060 | -785.5 | 2600 | Fused colony of glass sponges, 34 m tall vaulted lattice | 60 m dia., enterable | aby | Fragile, laceration hazard, silent |
| `lm_chandelier` | The Chandelier | 2180 | -742.0 | 1140 | Geode Hollows main chamber: 3.4 m calcite blades from a 40 m ceiling | 120 m x 80 m chamber | aby | Cave payoff; mouth at (2180, -742, 1140) on The Draw's north wall |
| `lm_draw_mouth` | The Draw Mouth | 860 | -402.4 | 880 | Trench head: a 600 m wide notch in the terrace where the floor simply stops | 600 m wide, drop to -1605 m | mid-had | The threshold. Everything before this is preparation |
| `lm_the_gape` | The Gape | 2790 | -1601.3 | 2880 | Terminal hadal cave at the trench's SE end; the deepest reachable point | 80 m mouth, 210 m deep | had | End of the world. No reward but arrival |

Landmark placement rules for the generator:

1. Landmarks are stamped into the heightfield/cave SDF BEFORE biome classification, so the
   surrounding biome adapts to them rather than the reverse.
2. Each landmark declares an `exclusionRadius` (default 60 m) within which procedural flora and
   ore are suppressed to 20% density, so the authored silhouette stays readable.
3. Each landmark declares a `discoveryRadius` (default 180 m, 400 m for `lm_draw_mouth` and
   `lm_the_gape`) which triggers the log entry and the persistent map marker.
4. No landmark may be within 240 m of another, except the Halocline Mirror / Brinefall pair which
   are intentionally 480 m apart and read as one composition.

---

## 11. DETERMINISM, SEEDS AND STREAMING

| Item | Value |
|---|---|
| World seed | `0x5B7A19C4`, fixed for the shipping world. The world is authored, not randomised |
| Noise seeds used | 3 (base detail), 11 (radial warp), 21 (plateau), 33 (spires), 41 (pans), 51 (swamp), 61 (ossuary), 71 (lampcap), 81 (sponge), 91 (trench floor), 101/111 (vents), 121 (ashfall), 131 (brine), 201 (substrate), 211 (nutrient), plus one per biome for `noiseSeed` in 8.3 (300..324) |
| Noise function | Hash-based value noise, quintic interpolation, 2D. Identical implementation in JS and WGSL, verified bit-exact to 1e-6 by a unit test over 10^6 samples |
| Chunk size | 64 m x 64 m |
| Chunk LODs | LOD0 65x65 verts (1.0 m), LOD1 33x33 (2.0 m), LOD2 17x17 (4.0 m), LOD3 9x9 (8.0 m), LOD4 5x5 (16.0 m) |
| LOD switch distances | 96 / 208 / 448 / 960 m; hysteresis 16 m |
| Underwater draw distance | 240 m (high), 180 m (medium), 120 m (low) |
| Above-water draw distance | 4800 m (high), 3200 m (medium), 2000 m (low) |
| Resident chunk budget | 320 chunks (high), 190 (medium), 110 (low) |
| Chunk generation cost target | 0.35 ms compute + 0.20 ms meshing per chunk, M2 |
| Field texture per chunk | 2 x `rgba16float` 33x33 = 8.7 KB |
| Biome index+weight per chunk | 2 x `rgba8unorm` 33x33 = 8.7 KB |
| Persistence | Only player-caused deltas are stored (mined ore nodes, harvested flora, discovered landmarks) as a sparse IndexedDB keyed by `chunkIndex` |

Terrain is fully reproducible from the seed, so nothing about the base world is ever saved.

---

## 12. INTERFACES AND OPEN QUESTIONS

### 12.1 What other sections must consume verbatim

- Coordinate system, sea level, depth sign convention (section 0).
- `SIGMA_A_BASE`, `SIGMA_S_BASE`, `K_D_BASE`, the fog composite formula and `P(d)` (section 5.1).
- Depth-band boundaries at -2 / -40 / -150 / -400 / -900 / -1605 m (section 5.2).
- `AMBIENT_CUTOFF_DAY = 620 m`, `AMBIENT_CUTOFF_NIGHT = 190 m` (section 5.2).
- Hull pressure tiers at 22.9 / 52.7 / 90.5 / 160.6 atm (section 5.4).
- Safe volume definition and the tier>=2 exclusion (section 4.2).
- All ids in section 6 (flora, fauna, ore, audio beds) and section 7.1 (biomes).
- Landmark XYZ (section 10).
- Chunk size 64 m and the LOD ladder (section 11).

### 12.2 Assumptions this section made about others

- Vessel cruise 42 m/s in air, 14 m/s submerged; these drive the extent justification in 1.2.
- Vessel hull tiers exist and gate depth as in 5.4.
- A diver oxygen budget makes 26 m depth comfortable and 80 m the unassisted limit.
- The renderer supports a second reflective water interface (the halocline) at arbitrary y.
- Terrain supports a sparse SDF cave layer for arches, overhangs and the Geode Hollows.
- Auto-exposure exists and the `L_amb` column of 5.2 is applied post-exposure.
- The spawner can evaluate `biomeWeights()` at arbitrary points, not only at terrain vertices.

### 12.3 Open questions

1. Whether the Geode Hollows should have a second exit into the Halocline Basin. It would be a
   great shortcut but the two are 3.6 km apart; probably not.
2. Whether `f_trenchsinger` should be reachable at all or should always retreat. Current density
   of 0.0016/ha means roughly 0.8 individuals in the whole trench, which is intentional.
3. Tidal range is currently unspecified. Recommend +/- 0.85 m on a 12.4 h period, which would
   make `lm_fanstone_crown` break the surface twice a day and give the Evaporite Pans a reason to
   exist. Needs sign-off from the simulation section because it moves the waterline.
4. Whether the Ashfall Basin's desaturated palette survives the colour-grade pass, or reads as a
   bug. Needs an early art test.
