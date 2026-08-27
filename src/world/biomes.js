/**
 * SUBWAVE biomes.
 *
 * A biome is the answer to "what is the ground made of here, what colour is the
 * water above it, and how frightened should I be". Every function in this file
 * is a pure, deterministic function of world position, so the CPU (scatter,
 * audio, spawning) and the GPU (per-vertex material) never disagree.
 *
 * CLASSIFICATION is a scored vote, not a partition. Each biome declares a
 * preferred depth band, slope band and radius band; the score is a weighted sum
 * of three C1 plateau fits. That gives smooth, blendable boundaries for free -
 * a hard partition would put a visible contour line across the seabed wherever
 * two rulesets met.
 *
 * BOUNDARY JITTER perturbs the INPUTS (depth and slope), not the scores. One
 * three-octave noise evaluation makes every boundary in the world wander
 * organically; jittering each biome's score separately would cost fourteen
 * evaluations per vertex for a visually identical result.
 *
 * Depths are POSITIVE metres below sea level, so land has negative depth.
 * Albedos are LINEAR RGB. `waterType` names a key of WATER_TYPES.
 *
 * ALBEDOS ARE SEPARATED BY HUE, NOT BY BRIGHTNESS - IN AIR. Six of the fourteen
 * biomes are some kind of rock and their reflectances all live between 2.5% and
 * 8%, because that is what rock reflects; there is no room down there to tell
 * them apart by value, and trying makes the dark ones read as holes. What does
 * the work above water is chroma at constant luminance - island basalt oxidised
 * warm, spires and trench wall wave-scoured cool, shelf break buff under its
 * pelagic drape, boulders greened by algal film, canyon iron-stained.
 *
 * UNDERWATER THE OPPOSITE IS TRUE, and this file used to assert otherwise: that
 * "the water column multiplies every channel by a different exponential and
 * flattens value differences long before it flattens hue ones". A per-channel
 * exponential does exactly the reverse. It PRESERVES ratios of value - an albedo
 * twice as bright stays twice as bright in every channel at every depth - and it
 * destroys chromaticity, because it drags every colour toward whichever channel
 * is least attenuated. In OCEANIC_CLEAR the G-to-B compression is
 * exp(-(0.0576 - 0.0253) * d): 0.275 at 40 m, 0.054 at 90 m, 0.022 at 118 m.
 * Measured at the twilight camera (455, -120, 1926) the transmittances are
 * R 7.7e-14, G 1.1e-3, B 5.1e-2, so the surviving G/B ratio of all eight deep
 * biomes falls inside 0.018-0.027 and a 50% hue difference between any two of
 * them arrives as about 1% of the blue channel - under the 8-bit floor.
 *
 * Below roughly 90 m the separation therefore has to be carried by something
 * that is NOT the albedo. Do not re-hue the catalogue to fix it: 2.5-8% is a
 * real reflectance range and there is nowhere for a hue to go.
 *
 * This paragraph used to name the shader's macro albedo bands
 * (MACRO_FREQ_CHROMA in render/shaders/pass/terrain.wgsl) as the replacement,
 * and that was arithmetically incapable of the job. terrain.wgsl's own
 * docstring measures MACRO_CHROMA at 2% of displayed B/G *in air*; underwater
 * it multiplies a seabed albedo which is itself 1.6-6% of the pixel at the
 * ranges the game is actually framed at, so it delivers about 0.1% - roughly
 * 30x below the 8-bit floor. The separation is carried by `fogTint`.
 *
 * ===========================================================================
 * THE FOG TINT PALETTE - the biome's colour, and why it lives on the HAZE
 * ===========================================================================
 *
 * `fogTint` is the chromaticity the diffuse in-scatter is pushed toward. It is
 * sampled by `main.js._updateWaterColumn` (sprung on RENDER.WATER_BLEND_TAU
 * with the rest of the optical column), normalised to unit Rec709 luma in
 * `renderer.js`, and applied in `common/water.wgsl`'s `waterInScatter`.
 *
 * IT IS THE ONLY KNOB IN THE ENGINE WITH ENOUGH WEIGHT TO SEPARATE TWO BIOMES.
 * The diffuse in-scatter is a measured 92-94% of the pixel at the Coral Garden
 * anchor and 57-77% at the Shallow Reef; every albedo term in the frame is
 * fighting over what is left. And until 2026-08-01 this field was DEAD -
 * authored on all fourteen records, blended per terrain vertex by materialAt(),
 * and read by nothing under src/. That is the identical bug to `waterTypeAt()`
 * one file over, and it cost the same kind of thing: every underwater frame in
 * the game was monochromatic. Measured before: 0.00% of any underwater frame
 * lay more than 40 degrees of hue from its own dominant, against 6.6-77% for
 * the reference material.
 *
 * AUTHOR THESE AS A PALETTE, NOT AS PHYSICS. The physics of the column is
 * already carried, correctly and separately, by WATER_TYPES' sigmaT/sigmaS/Kd.
 * What this field decides is what the place LOOKS like, and the original values
 * failed at that because they were all descriptions of the same blue-green
 * water: normalised to unit luma they spanned 155-222 degrees of hue, of which
 * almost nothing survived multiplication into an already-blue field - measured,
 * making the field live with those values moved the biome-to-biome spread of
 * delivered dominant hue from 50.7 to 51.9 degrees, i.e. not at all.
 *
 * The progression below is deliberate, shallow to deep: warm turquoise
 * shallows, green mid-shelf, clean blue at the break, cold blue-teal through
 * the twilight, indigo in the abyss, and the two trench records pushed toward
 * violet so the deepest water is not merely a darker copy of the water above
 * it. Only the RATIOS matter - the absolute brightness is divided out - but
 * they are kept on roughly the original scale so the numbers stay readable
 * next to each other.
 *
 * ONE CONSTANT CONTROLS HOW FAR THIS GOES: RENDER.WATER_FOG_TINT_STRENGTH. Set
 * it to 0 to recover the pre-2026-08-01 look exactly, which is what makes the
 * change bisectable. It is not 1.0 because at full strength a strongly authored
 * tint reads as a colour-separation fault rather than as water: measured, a
 * kelp tint of [0.06, 0.30, 0.07] at strength 0.85 produced a flat neon green.
 */

import { WATER_TYPES, WORLD, TRUE_DARK_DEPTH } from '../core/constants.js';
import { smoothstep, clamp, hashU32 } from '../core/math.js';
import { simplex2, fbm2 } from './noise.js';
import { PLACES } from './places.js';
import { HABITAT_SITE } from './habitat_site.js';

// ===========================================================================
// Catalogue
// ===========================================================================

/**
 * The biome records.
 *
 *   depth        [min, max] metres below sea level; negative is above water
 *   slope        [min, max] gradient magnitude (tangent of the surface angle)
 *   radius       [min, max] metres from the world origin
 *   albedo       linear RGB of the dominant substrate
 *   roughness    perceptual roughness of that substrate
 *   rockiness    0 = pure sediment, 1 = bare rock. Drives the shader's
 *                rock/sand height blend on top of the slope term.
 *   sediment     0..1 loose material depth, drives dune ripples and footsteps
 *   macroStyle   0..1 ordered geology coordinate consumed by terrain.wgsl.
 *                It is blended, not categorical, so biome boundaries morph
 *                between macro-material families without a triangle seam.
 *   waterType    key of WATER_TYPES for the column directly above
 *   fogTint      linear RGB the in-scatter is pushed toward locally. LIVE since
 *                2026-08-01 and the single largest lever on whether two biomes
 *                look different - see the FOG TINT PALETTE note below.
 *   sightDensity submerged view-path density, 0..1. Multiplies sigma_t and
 *                sigma_s together; 1 keeps the raw water column.
 *   dangerTier   0..5, consumed by the spawner and the director
 *
 * THE DEEP CARRIES THREE WATERS AND EVERY SPLIT IS DELIBERATE. Canyon Wall
 * carries NEPHELOID, Abyssal Plain HADAL_SUSPENSION, Trench Wall and Trench
 * Floor ABYSSAL_VOID. Before any of it, `waterTypeAt` returned ABYSSAL_VOID on
 * 100.000% of the seabed past 260 m (measured, 40 m grid inside r <= 2900,
 * 8,053 of 16,235 wet samples) - half the world through one sigma_t,
 * one deep tint and one seabed albedo. ABYSSAL_VOID is the CLEAREST water in
 * the table, so keeping it on the trench is what buys the contrast: the trench
 * wall stays a 150.5 m sighting range against the plain's 77.6, and the lamp
 * that produced an unbounded structureless bloom in ABYSSAL_VOID's 0.0120 blue
 * sigma_s gets 3x as much to scatter off over the plain. All three had to be
 * ONE absorption column or the sea read from the air would change colour across
 * the boundary - see the family block in constants.js.
 *
 * CANYON WALL AND ABYSSAL PLAIN SHARED HADAL_SUSPENSION FOR ONE BUILD AND THAT
 * WAS A MISTAKE, MEASURED. An earlier pass assigned it to both;
 * they were already the second-worst confusion in the 14-anchor variety tour and
 * one water made it worse - hue x saturation cosine `canyon x abyssal` 0.9772 ->
 * 0.9868 - while that pass's real win, `abyssal x trenchWall` 0.9975 -> 0.9383,
 * came from the plain alone and is untouched by splitting them. NEPHELOID is not
 * a third multiple of the same blue scattering: its mineral load is set at the
 * concentration where the silt's blue-weighted absorption cancels water's
 * red-weighted one, so the medium is ACHROMATIC - 3 m halo R:G:B 0.820 : 0.881 :
 * 1.000 against HADAL_SUSPENSION's 0.459 : 0.625 : 1.000, and a halo saturation
 * that stays 0.18 from 3 m to 30 m where the plain's climbs 0.541 -> 0.785. The
 * derivation, the delivered A/B and the authored source (DESIGN/01 7.3 and 7.8)
 * are on the row itself.
 *
 * MEASURED AFTER THE SPLIT, one in-process A/B over three anchors: `canyon x
 * abyssal` 0.98214 -> 0.86801, `canyon x trenchWall` 0.93357 -> 0.72495, canyon
 * hue entropy 1.9639 -> 2.0316 bits, and `abyssal x trenchWall` 0.94073 ->
 * 0.94193 on two frames that are 0.99997 and 1.00000 identical to themselves
 * across the pair - neither carries this water, so that last figure is the
 * instrument. THE COEFFICIENTS ALSO MOVE THE ANCHOR, via
 * `biome_anchors.js:framingView`'s `contrastRange`; the row's docstring records
 * the draft that shifted Canyon Wall 502.8 m -> 380.1 m and what it cost.
 *
 * NONE OF THIS REACHES A PIXEL WITHOUT THE APHOTIC GATE in `waterTypeAt`:
 * Canyon Wall's own band mid-depth is 417-478 m, past every ceiling in the
 * table, so ungated the column falls through to the default and the assignment
 * above is dead data. Ship the two together or neither measures anything.
 */
export const BIOMES = Object.freeze([
  Object.freeze({
    id: 0, name: 'Volcanic Beach', short: 'beach',
    depth: [-9, 3], slope: [0, 0.30], radius: [340, 1360],
    albedo: [0.116, 0.102, 0.083], roughness: 0.74, rockiness: 0.10, sediment: 0.95,
    waterType: 'OCEANIC_CLEAR', fogTint: [0.11, 0.33, 0.31], macroStyle: 0.02, sightDensity: 1.00, dangerTier: 0,
    feather: { depth: 7, slope: 0.22, radius: 320 },
  }),
  Object.freeze({
    id: 1, name: 'Island Basalt', short: 'basalt',
    depth: [-230, 2], slope: [0.34, 3.0], radius: [200, 1400],
    albedo: [0.050, 0.041, 0.037], roughness: 0.86, rockiness: 0.96, sediment: 0.04,
    waterType: 'OCEANIC_CLEAR', fogTint: [0.12, 0.30, 0.30], macroStyle: 0.02, sightDensity: 1.00, dangerTier: 0,
    feather: { depth: 16, slope: 0.20, radius: 320 },
  }),
  Object.freeze({
    id: 2, name: 'Shallow Reef', short: 'reef',
    depth: [1.5, 26], slope: [0, 0.55], radius: [0, 700],
    albedo: [0.196, 0.183, 0.138], roughness: 0.66, rockiness: 0.45, sediment: 0.42,
    waterType: 'OCEANIC_CLEAR', fogTint: [0.11, 0.40, 0.33], macroStyle: 0.16, sightDensity: 1.00, dangerTier: 0,
    feather: { depth: 9, slope: 0.26, radius: 260 },
  }),
  Object.freeze({
    id: 3, name: 'Coral Garden', short: 'coral',
    // radius[1] 1250 -> 950: CORAL CEDES ITS OUTER RING TO THE CRIMSON
    // MEADOW (id 15) - the full siting story and supply table are on that
    // record. Coral keeps the belt its anchor and the dive-coral demo route
    // live in: the anchor resolves at r 879 and the demo's east-swim legs
    // run INWARD, 71+ m from the new boundary; both biomes carry
    // REEF_TURQUOISE, so the boundary cannot flip the demo's water either.
    depth: [6, 44], slope: [0, 0.75], radius: [300, 950],
    albedo: [0.221, 0.146, 0.121], roughness: 0.58, rockiness: 0.62, sediment: 0.22,
    waterType: 'REEF_TURQUOISE', fogTint: [0.08, 0.32, 0.40], macroStyle: 0.22, sightDensity: 0.32, dangerTier: 1,
    feather: { depth: 15, slope: 0.28, radius: 380 },
  }),
  Object.freeze({
    id: 4, name: 'Sand Plains', short: 'sand',
    // depth[0] 10 -> 44: SAND CEDES ITS SUB-44 m SHALLOWS TO CRIMSON MEADOW
    // (id 15), and the cession costs sand almost nothing because sand never
    // WON much of that ground. Inside r <= 1250 Coral Garden (id 3, depth
    // [6,44] x slope [0,0.75] x radius [300,1250]) full-fits every flat
    // sub-44 m sample sand does, both score 1.0, and biomeAt breaks ties
    // toward the LOWER id - so coral already owned the inner shallows and
    // sand's only delivered sub-44 territory was the OUTER annulus
    // (r > 1250). The meadow first took that annulus and then moved to
    // coral's ceded 950-1250 ring (see its record); the cession here STAYS,
    // because the meadow's new cell is still inside sand's old one and sand
    // would tie-and-beat it there. The orphaned outer shallows (r 1250-2000,
    // 12-44 m) fall to feathered competition - measured: Boulder Field
    // 44.6%, sand feather 25.7%, kelp 15.6%, meadow feather 14.1% of 377
    // flat samples. Sand keeps
    // every 44-90 m flat, which is where its real clusters live anyway
    // (measured at seed 0x5b7a7e91, 16 m grid: the five largest
    // sand-dominant clusters all lie at 40-98 m depth). The feather (30) is
    // unchanged: sand still blends up to ~14 m, it just no longer WINS
    // above the 44 m crossover.
    depth: [44, 90], slope: [0, 0.20], radius: [400, 2000],
    albedo: [0.246, 0.222, 0.171], roughness: 0.63, rockiness: 0.03, sediment: 1.00,
    waterType: 'REEF_TURQUOISE', fogTint: [0.12, 0.31, 0.34], macroStyle: 0.30, sightDensity: 0.30, dangerTier: 1,
    feather: { depth: 30, slope: 0.16, radius: 620 },
  }),
  Object.freeze({
    id: 5, name: 'Kelp Forest', short: 'kelp',
    // slope[0] 0.10 -> 0.20: PART OF THE CRIMSON MEADOW (id 15) CESSION
    // PACKAGE, and costless today by the same tie rule that makes it
    // necessary. Costless: kelp's cell at slope <= 0.20 ([14,78] x
    // [0.10,0.20] x [500,1900]) lies strictly inside Sand Plains' OLD
    // full-fit cell ([10,90] x [0,0.20] x [400,2000]), so sand (id 4 < 5)
    // tied-and-beat kelp on every sub-0.20 sample - kelp never won that
    // ground on today's map. Necessary: with sand's shallows ceded, kelp
    // would have full-fit the 12-44 m flat annulus at slope 0.10-0.20 and
    // inherited it by the same tie (kelp id 5 < 15), turning the meadow
    // into dead data over exactly the ground it was authored for. Raising
    // the floor removes kelp from the tie without moving any delivered
    // win. The feather (0.24) is unchanged, so kelp still blends onto
    // gentle ground - it just cannot WIN it.
    //
    // depth[0] 14 -> 28: THE SECOND HALF OF THE MEADOW SEPARATION. A slope
    // split between kelp and the meadow was tried twice and refuted on
    // delivered frames - the terrain's slope field fluctuates 0.05-0.35 at
    // 10-30 m scale, so any slope boundary interleaves the two biomes at
    // dune scale; depth does not oscillate at that scale, so the boundary
    // is a depth floor. Measured cost at the 26 m draft (20 m grid, whole
    // disc): kelp is 4,750 classified cells and exactly 93 of them - 2.0% -
    // are shallower, every one on the contested outer plateaus, and kelp
    // takes back those plateaus' deeper flats in the same change. The full
    // siting story with the supply table is on the Crimson Meadow record.
    // 2026-08-18 EMERALD REBUILD, PHASE 2 (explicit user instruction: "make
    // that biome even deeper? 2 times as deep with kelp 2 times as tall...
    // feel free to just make the terrain of kelp 2 times lower"): terrain.js
    // LAYER 9.5 carves the kelp basin (the x<0/z>0 wedge of the r 1150-1850
    // shelf, depth DOUBLED, cliff rim), and this record re-sites the biome
    // onto deep ground: depth [28,78] -> [56,170] (basin floors measure
    // p05 56 / p50 95 / p95 194), slope top 0.62 -> 2.2 so the biome owns
    // its own cliff walls, radius tightened to the deep shelf ring. The
    // slope FLOOR stays 0.20 (the meadow-cession tie rule): the basin's
    // flattest floors tie-and-lose to Sand Plains below 90 m as pale sand
    // clearings between the kelp stands - deliberate negative space.
    // KNOWN CONSEQUENCE, accepted with the instruction: kelp now beats
    // Boulder Field on the 56-140 m ground of the r 1050-1950 ring (lower
    // id wins the interleave), so Boulder Field shrinks to its shallower
    // and inner ground and its anchor re-derives.
    depth: [56, 170], slope: [0.20, 2.2], radius: [1050, 1950],
    // Albedo darkened with the emerald rebuild (was [0.077, 0.093, 0.058]):
    // the reference floor is holdfast rock in canopy shadow, and under the
    // new bright-green key the old albedo delivered a pale mint slope.
    albedo: [0.052, 0.070, 0.040], roughness: 0.71, rockiness: 0.52, sediment: 0.34,
    // waterType COASTAL_GREEN -> KELP_EMERALD, 2026-08-18 emerald rebuild
    // (ref SCR-20260801-gooy): the third art-deviation water, scoped to this
    // biome alone so Boulder Field's COASTAL_GREEN look is untouched. The
    // fogTint follows it - deep forest green, blue subordinate (renderer
    // normalises to unit luma, so this only ROTATES the haze hue).
    // sightDensity 0.28 -> 0.45, judged on delivered frames: at 0.28 the
    // effective visibility was ~180 m, the SURFACE burned bright blue into a
    // 55 m frame and distant trunks never became silhouettes. 0.45 is the
    // maximum test-ocean section 15's kelp gate admits with this water's
    // sigmaT (green T50 0.207 > 0.19, blue 0.148 > 0.12, red 0.003 < 0.03).
    waterType: 'KELP_EMERALD', fogTint: [0.045, 0.30, 0.10], macroStyle: 0.38, sightDensity: 0.45, dangerTier: 1,
    // Radius feather 560 -> 140 with the re-siting: the old wide feather was
    // sized for a 500-1900 home; on the new tight ring it would smear kelp
    // weight across half of Boulder Field's remaining ground.
    feather: { depth: 24, slope: 0.30, radius: 140 },
  }),
  Object.freeze({
    id: 6, name: 'Boulder Field', short: 'boulders',
    depth: [34, 140], slope: [0.16, 0.72], radius: [700, 2100],
    // Boulders and Shelf Break are the pair the player actually meets at depth
    // (measured over an 80 m radius at the twilight camera: boulders 71%, break
    // 25%), and blue is the only channel that survives to get there. Their blue
    // spread was 0.062 / 0.043 = 1.44x, which blends to one tone; 0.072 / 0.034
    // is 2.12x. Both stay inside the 2.5-8% band - 6.4% and 5.5% by Rec709.
    albedo: [0.056, 0.065, 0.072], roughness: 0.80, rockiness: 0.84, sediment: 0.20,
    waterType: 'COASTAL_GREEN', fogTint: [0.035, 0.16, 0.14], macroStyle: 0.48, sightDensity: 0.45, dangerTier: 2,
    feather: { depth: 40, slope: 0.24, radius: 620 },
  }),
  Object.freeze({
    id: 7, name: 'Shelf Break', short: 'break',
    depth: [90, 300], slope: [0.42, 2.4], radius: [1550, 2450],
    // Blue pushed down against Boulder Field's; see the note on that record.
    albedo: [0.062, 0.055, 0.034], roughness: 0.83, rockiness: 0.92, sediment: 0.08,
    waterType: 'OCEANIC_CLEAR', fogTint: [0.03, 0.13, 0.26], macroStyle: 0.58, sightDensity: 0.40, dangerTier: 2,
    feather: { depth: 70, slope: 0.28, radius: 520 },
  }),
  Object.freeze({
    id: 8, name: 'Rock Spires', short: 'spires',
    depth: [40, 620], slope: [0.85, 4.0], radius: [600, 3000],
    albedo: [0.041, 0.046, 0.056], roughness: 0.88, rockiness: 0.98, sediment: 0.02,
    waterType: 'OCEANIC_CLEAR', fogTint: [0.03, 0.11, 0.22], macroStyle: 0.68, sightDensity: 1.00, dangerTier: 3,
    feather: { depth: 180, slope: 0.30, radius: 900 },
  }),
  Object.freeze({
    id: 9, name: 'Twilight Terraces', short: 'terrace',
    // depth[1] 430 -> 292: THE TERRACES CEDE THEIR DEEP END TO OSSUARY FLATS
    // (id 14), AND THE CESSION IS THE ONLY WAY A 15TH BIOME AT 284-352 m CAN
    // EXIST AT ALL. The classifier is a scored vote over (depth, slope, radius)
    // plateau fits, and inside another record's full-fit cell the best a new
    // record can do is TIE at 1.0 - and biomeAt breaks ties toward the LOWER id,
    // so a record authored strictly inside this one's [150,430] x [0,0.46] x
    // [1700,3000] cell is dead data by construction (measured: every flat
    // 275-365 m sample in the world - 171 on a 16 m grid - lay inside that cell,
    // 46/46 flat band samples terrace-dominant). DESIGN/01 authors the same
    // split positionally: R10 Twilight Terraces is "whole map ... not
    // canyon/basin/FLATS" and R16 Ossuary Flats is the carve-out at -285..-345.
    // This engine has no azimuth coordinate, so the carve is by depth. The
    // feather (110) is unchanged: terrace still blends to ~400 m, it just no
    // longer WINS below the low-292 crossover. Flat ground past the ossuary
    // band's own fade (~370-430 m) now falls to Abyssal Plain instead of
    // terrace - measured on a 32 m grid, see the ossuary record below.
    depth: [150, 292], slope: [0, 0.46], radius: [1700, 3000],
    albedo: [0.112, 0.099, 0.081], roughness: 0.72, rockiness: 0.34, sediment: 0.68,
    waterType: 'OCEANIC_CLEAR', fogTint: [0.015, 0.080, 0.150], macroStyle: 0.76, sightDensity: 1.00, dangerTier: 3,
    feather: { depth: 110, slope: 0.24, radius: 700 },
  }),
  Object.freeze({
    id: 10, name: 'Canyon Wall', short: 'canyon',
    depth: [120, 900], slope: [0.60, 3.2], radius: [850, 3400],
    albedo: [0.048, 0.036, 0.030], roughness: 0.87, rockiness: 0.95, sediment: 0.05,
    waterType: 'NEPHELOID', fogTint: [0.022, 0.060, 0.115], macroStyle: 0.84, sightDensity: 1.00, dangerTier: 3,
    feather: { depth: 220, slope: 0.30, radius: 800 },
  }),
  Object.freeze({
    id: 11, name: 'Abyssal Plain', short: 'abyssal',
    depth: [420, 1080], slope: [0, 0.22], radius: [2400, 5000],
    albedo: [0.087, 0.080, 0.070], roughness: 0.69, rockiness: 0.04, sediment: 1.00,
    waterType: 'HADAL_SUSPENSION', fogTint: [0.005, 0.022, 0.068], macroStyle: 0.88, sightDensity: 1.00, dangerTier: 4,
    feather: { depth: 240, slope: 0.18, radius: 1000 },
  }),
  Object.freeze({
    id: 12, name: 'Trench Wall', short: 'trenchWall',
    depth: [560, 1650], slope: [0.55, 4.0], radius: [1500, 5000],
    albedo: [0.023, 0.025, 0.031], roughness: 0.90, rockiness: 0.99, sediment: 0.02,
    waterType: 'ABYSSAL_VOID', fogTint: [0.0035, 0.0090, 0.0400], macroStyle: 0.96, sightDensity: 1.00, dangerTier: 5,
    feather: { depth: 260, slope: 0.28, radius: 1200 },
  }),
  Object.freeze({
    id: 13, name: 'Trench Floor', short: 'trenchFloor',
    depth: [1000, 1700], slope: [0, 0.26], radius: [1900, 5000],
    albedo: [0.036, 0.029, 0.024], roughness: 0.66, rockiness: 0.02, sediment: 1.00,
    waterType: 'ABYSSAL_VOID', fogTint: [0.0030, 0.0055, 0.0320], macroStyle: 1.00, sightDensity: 1.00, dangerTier: 5,
    feather: { depth: 240, slope: 0.20, radius: 1400 },
  }),
  Object.freeze({
    /**
     * OSSUARY FLATS - DESIGN/01 #18: a pale gravel plain of comminuted bone,
     * out of which rise the articulated skeletons of very large animals. The
     * 15th biome, APPENDED (ids are placement salts; never insert).
     *
     * THE DEPTH BAND IS A CESSION FROM TWILIGHT TERRACES, whose depth[1] went
     * 430 -> 292 in the same change - see the comment on that record for why a
     * new record strictly inside an existing full-fit cell can only ever tie
     * and lose. The bands below were sized against the REAL terrain at seed
     * 1534754449: every flat (slope <= 0.28) 275-365 m basin found on a 16 m
     * grid lies at r 2007-2285 (clusters at (2120,-618) 341.6 m, (2037,-786)
     * 345.3 m, (1784,-1165) 301.0 m, (-861,-2084) 330.2 m, (-1186,1818)
     * 360.2 m), so the radius band brackets that annulus and the depth band
     * brackets DESIGN's authored -285..-345 with the basins' own spread.
     *
     * THE SLOPE BAND IS 0.40, NOT THE 0.30 THE NAME SUGGESTS, AND THE 0.30
     * DRAFT WAS MEASURED DEAD. This terrain's 285-350 m "flats" are basin
     * pockets inside rolling relief: exhaustively, over every 16 m sample in
     * the annulus that is ossuary-DOMINANT with weight >= 0.45 and a healthy
     * 40 m ring (246 candidates), the FLATTEST 32 m landform slope among the
     * in-band survivors is 0.37 - so with hi 0.30 the anchor resolver's
     * slope-centredness floor rejected every candidate in the world and the
     * biome fell to bestWeightFallback (`dominant: false`, test-jump red).
     * hi 0.40 admits the real basins ((-888,-2088) depth 342.2, landform
     * 0.37, weight 1.00, ring 0.50) while staying under Shelf Break's 0.42
     * slope floor and Twilight Terraces' 0.46 hi. Measured crossovers:
     * ossuary beats terrace from ~296 m down (terrace depth fit 0.784 at
     * 320 m x 0.44 = a 0.095 margin), beats canyon below local slope ~0.45,
     * and cedes to abyssal past ~370 m where its own depth feather has faded.
     *
     * WATER IS NEPHELOID, NOT HADAL_SUSPENSION, AND THE CHOICE IS ABOUT THE
     * NEAREST CONFUSABLE NEIGHBOUR. Both deep-family rows pass the aphotic
     * gate over this whole band (ceiling 361.4 m; lit = column x gate peaks
     * at 330.3 m, and at 352 m lit = 338.5). But Abyssal Plain - the OTHER
     * pale flat sediment plain with bone ribs and whale falls - carries
     * HADAL_SUSPENSION, and giving this biome the same water would hand the
     * most confusable pair in the catalogue one sigma_s, one snow density and
     * one deep key as well. NEPHELOID's mineral load is ACHROMATIC (3 m halo
     * R:G:B 0.820:0.881:1.000 against HADAL's 0.459:0.625:1.000), which is
     * also the right physics for a plain whose suspended load is bone dust,
     * not clay. Canyon Wall shares the row, and nothing else about a black
     * 500 m wall and a pale 300 m plain can be confused. DESIGN 6.4 gives
     * sea_ossuary_flats "bone-dust haze near the floor".
     *
     * The fogTint is the palest, least saturated tint in the deep half of the
     * table ON PURPOSE - the haze carries the biome's colour, and this
     * biome's colour is pallor. Ratios (only ratios matter, renderer.js
     * normalises to unit luma): r/g 0.79, b/g 1.17, against terrace's 0.19 /
     * 1.88 and canyon's 0.37 / 1.92 - a grey rather than another blue.
     *
     * The albedo is the brightest seabed in the game (Rec709 luma ~0.29
     * against Sand Plains' 0.23) because DESIGN 8.5 authors bone-fragment
     * gravel at sRGB 176,170,156; it is deliberately NOT taken all the way to
     * that row's 0.43 linear because a 43% floor under a histogram-metered
     * exposure would re-expose every frame that contains it.
     *
     * dangerTier 4: DESIGN 8.44 says 3, the brief for this biome says dread.
     * No bestiary species lists biome 14 (none names the ossuary), so the
     * tier currently gates nothing but the director's escalation - the horror
     * is atmospheric, which is DESIGN 9.2's own line for this biome
     * ("hostiles: none").
     */
    id: 14, name: 'Ossuary Flats', short: 'ossuary',
    depth: [284, 368], slope: [0, 0.40], radius: [1940, 2360],
    albedo: [0.300, 0.285, 0.252], roughness: 0.68, rockiness: 0.08, sediment: 0.92,
    waterType: 'NEPHELOID', fogTint: [0.055, 0.070, 0.082], macroStyle: 0.80, sightDensity: 1.00, dangerTier: 4,
    feather: { depth: 36, slope: 0.16, radius: 300 },
  }),
  Object.freeze({
    /**
     * CRIMSON MEADOW - a carpet of blood-red grass on pale flat shallows,
     * broken by flared flat-topped stone pillars (the reference frame the
     * 2026-08-02 red-column cut was authored against). The 16th biome, APPENDED (ids are placement salts;
     * never insert). The pillars come from scatter, not the heightfield:
     * macroStyle stays at Sand Plains' 0.30 - smooth sediment, no macro
     * pulse.
     *
     * THE CELL IS CORAL GARDEN'S CEDED OUTER RING, and the siting was
     * MEASURED, twice the wrong way first. The classifier is a scored vote
     * over (depth, slope, radius) plateau fits with ties broken toward the
     * LOWER id, so this record wins only where no older record fully fits.
     * Flat (slope <= 0.45) supply at seed 0x5b7a7e91, 12 m grid, cells x
     * 144 m^2, radius ring x depth band:
     *
     *     ring        4-12   12-20   20-28   28-36   36-44
     *     700-950      304    1713    2142    1454     639
     *     950-1250     117     378    2038    2791    2369
     *     1250-1500     36      22     557    1133    2193
     *     1500-1800      0       0       0      34     301
     *
     * The biome FIRST shipped at r 1250-2000 (Sand Plains' ceded shallows)
     * and was REFUTED on delivered frames two ways: (1) the outer plateaus
     * are mostly 26-42 m deep, where the away-sun frames metered 0.08, the
     * histogram exposure lifted 3-3.4x, and the carpet's red crossed the
     * AgX shoulder to pastel pink (sun-facing frames at exposure 1.6 read
     * dark crimson - same water, same grass; depth was the lever, nothing
     * else moved the pink); (2) the terrain's slope field fluctuates
     * 0.05-0.35 at 10-30 m scale out there, so every slope split against
     * Kelp Forest interleaved the two biomes at dune scale, and the pooled
     * COASTAL_GREEN water vote (see waterTypeAt) painted the meadow's own
     * plateaus 90% green. The 950-1250 ring at 8-28 m is the fix the table
     * shows: ~35 ha of flat bright ground, REEF_TURQUOISE neighbours on
     * every side, and depth - which does not oscillate at dune scale - as
     * the kelp boundary.
     *
     * THE CESSION PACKAGE, three records, one change set: Coral Garden
     * radius[1] 1250 -> 950 (the meadow's whole cell; coral's anchor sits
     * at r 879 with its demo route running INWARD); Sand Plains depth[0]
     * 10 -> 44 (else sand ties-and-beats the meadow across its whole cell);
     * Kelp Forest depth[0] 14 -> 28 (else kelp full-fits the 28-78 m band
     * and, with sand gone, inherits every deeper flat by tie; measured
     * cost 2.0% of kelp's classified cells at the 26 m draft, all of them
     * on the contested outer plateaus kelp now keeps anyway). Within
     * [8,28] x [0,0.60] x [950,1250] nothing ties: reef ends at r 700,
     * coral at 950, kelp starts at 28 m depth, boulders at 34, sand at 44,
     * spires at slope 0.85.
     *
     * WATER IS REEF_TURQUOISE, REUSED - no WATER_TYPES, albedo-table or
     * palette rows change, and inside the coral belt the pooled green vote
     * cannot reach the meadow. The colour shift against coral is the
     * fogTint's job (only ratios matter; renderer.js normalises to unit
     * luma): the blue-cyan haze is what makes the crimson carpet read as
     * crimson instead of dressing the whole frame red.
     */
    id: 15, name: 'Crimson Meadow', short: 'meadow',
    depth: [8, 28], slope: [0, 0.60], radius: [950, 1250],
    // albedo darkened from the first pass's [0.270, 0.252, 0.208] and the
    // fogTint rotated cyan from [0.07, 0.28, 0.42]: the delivered frames read
    // indigo-on-white (the haze was the bluest of the shallow family and the
    // brightest seabed under it re-exposed to a snowfield). Ratios only on the
    // tint - the renderer normalises it to unit luma.
    // Darkened twice more (0.252 -> 0.215 -> 0.188): the carpet's blades are
    // sub-pixel past a few metres, so every pixel averages blade against
    // ground - red over white-blue sand delivers PINK, red over warm tan
    // delivers crimson. The reference's carpet is optically thick over warm
    // ground. KNOWN RESIDUAL (adversarial review): bare sand still reads
    // cool blue-white on delivered frames; the next lever is the RATIO
    // (r/b ~2.0, e.g. [0.200, 0.158, 0.096]) at held luma, not more darkness.
    albedo: [0.188, 0.166, 0.124], roughness: 0.62, rockiness: 0.05, sediment: 0.95,
    waterType: 'REEF_TURQUOISE', fogTint: [0.11, 0.38, 0.36], macroStyle: 0.30, sightDensity: 0.30, dangerTier: 1,
    // feather.radius 180, not the 380 the first siting used: this cell is a
    // 300 m ring, and a 380 m feather would blur it into its donors.
    feather: { depth: 12, slope: 0.20, radius: 180 },
  }),
  Object.freeze({
    /**
     * BULB GROVE - big spiky purple pom bulbs on pale trunks over white sand
     * in turquoise water, small glowing blue fruits nested in the fur
     * (its art-direction reference). The 17th biome, APPENDED (ids are
     * placement salts; never insert).
     *
     * THE CELL IS GROUND NO EXISTING RECORD FULL-FITS - the first biome added
     * with ZERO cessions. The classifier is a scored vote with ties broken
     * toward the LOWER id, so a new record wins only where no older record
     * scores 1.0. Measured at seed 1534754449 (12 m grid, slope <= 0.45,
     * unjittered fits, scratch site-probe 2026-08-18): the annulus
     * r 1250-1500 holds open flats - no existing full fit - of 405 cells at
     * 20-28 m, 326 at 28-36 m and 21 at 12-20 m (cells x 144 m^2, ~11 ha),
     * exactly the "orphaned outer shallows" the Crimson Meadow record notes
     * as falling to feathered competition (Boulder Field 44.6%, sand feather
     * 25.7%, kelp 15.6%). Largest contiguous open patch: 96 x 16 m cells
     * (2.5 ha) centred (102, 1367), r 1268-1516, depth 17-33 m, mean slope
     * 0.18 - the natural anchor basin.
     *
     * WHERE OLDER RECORDS STILL WIN INSIDE THIS BOX, THEY KEEP IT: Kelp
     * Forest full-fits depth 28-36 x slope 0.20-0.45 here (ties toward id
     * 5), and Boulder Field the 34-36 x 0.16+ corner - so the grove's
     * delivered ground is the sub-0.20-slope flats plus everything 16-28 m,
     * with kelp interleaving on the deep sloped fringe. That interleaving is
     * accepted: it is the same dune-scale slope oscillation that refuted the
     * meadow/kelp slope split, and here it lands BETWEEN two biomes that are
     * both allowed to exist rather than inside one that is not.
     *
     * WATER IS LAGOON_VIOLET, AUTHORED FOR THIS BIOME (the first delivered
     * frames on REEF_TURQUOISE measured the purple bulbs as periwinkle blue:
     * R/B daylight is 0.30 at the 28 m anchor and no reflectance can climb
     * it - the whole argument is on the WATER_TYPES row). Ceiling 361.4 m
     * (blue Kd pinned bit-equal to the deep family's - see the row) >> the
     * 36 m band. The grove is NOT inside a turquoise belt the way the
     * meadow is - its neighbours carry COASTAL_GREEN - so the pooled green
     * vote in waterTypeAt can reach its fringe; the core classifies its own
     * water (test-jump prints the arrival column). If a delivered frame
     * shows green water at the anchor, re-measure the pool before touching
     * the record.
     *
     * The albedo is pale sand just under Ossuary Flats' (the brightest), the
     * reference's white floor. The fogTint is the most cyan of the shallow
     * family (only ratios matter, renderer.js normalises to unit luma): the
     * purple bulbs read against a blue-cyan haze in the reference, and the
     * complementary push is what keeps them purple rather than part of the
     * water.
     */
    // depth [14, 30], pulled up from a first landing at [16, 36] on the
    // adversarial review of the delivered frames: the resolved anchor sat at
    // 30.5 m, where (a) the daylight metered as twilight against a reference
    // that is a sunlit shallow, and (b) the whole 28-36 m half of the box is
    // kelp-contested ground (Kelp Forest's floor is 28), so the anchor
    // frames were half wheat-green kelp interleave. With the band topping at
    // 30 the contested strip is 2 m instead of 8 and the anchor resolves in
    // the sunlit half. The 30-36 m flats this cedes go back to the feathered
    // competition they came from.
    id: 16, name: 'Bulb Grove', short: 'bulb',
    // slope hi 0.55 (was 0.45): the terrain's slope field oscillates
    // 0.05-0.35 at dune scale (the meadow record's own measurement), and at
    // 0.45 every dune flank inside the grove fell to kelp's partial fit -
    // review round 2 found wheat-green kelp stalks CENTRE-FRAME at the
    // anchor. At 0.55 the grove full-fits its own flanks; kelp keeps only
    // the 28-30 m x 0.20+ corner where it genuinely ties and wins.
    depth: [14, 30], slope: [0, 0.55], radius: [1250, 1520],
    // Albedo warmed off the first [0.262, 0.252, 0.226] and roughness up
    // 0.62 -> 0.72: review round 2 read the floor as snowfield and the big
    // dunes as glacier shell - the blue-white cast plus a glassy specular.
    // macroStyle 0.34, off Sand Plains' 0.30: 0.30 sits inside the
    // carbonate-slab style pulse (terrain.wgsl stylePulse 0.20 +- 0.15),
    // which suppresses the shared micro-detail the dunes need.
    albedo: [0.272, 0.250, 0.206], roughness: 0.72, rockiness: 0.05, sediment: 0.95,
    waterType: 'LAGOON_VIOLET', fogTint: [0.075, 0.38, 0.44], macroStyle: 0.34, sightDensity: 0.30, dangerTier: 1,
    // A 270 m ring: the meadow's tight-feather reasoning (a wide radius
    // feather would blur a narrow annulus into its donors).
    feather: { depth: 10, slope: 0.18, radius: 160 },
  }),
  Object.freeze({
    /**
     * PLATTER FOREST - tall encrusted rock columns carrying stacked
     * horizontal platters, orange growth on the trunks, glowing rims, big
     * tendril-drifters and small fish in luminous emerald-teal water
     * (its art-direction reference). The 18th biome, APPENDED (ids are
     * placement salts; never insert). Sited DEEP on purpose - the columns are
     * 25-40 m tall and the record's whole band keeps their crowns well under
     * the surface, with vessel-width lanes between the trunks.
     *
     * THE CELL IS GROUND NO EXISTING RECORD FULL-FITS - the second zero-
     * cession landing after the Bulb Grove, measured the same way (site
     * probe, 16/12 m grids, unjittered fits, seed 0x5b7a7e91, scratch
     * site-probe 2026-08-18): the r 1600-1900 annulus holds an orphaned belt
     * of 90-110 m FLATS - too flat for Boulder Field (slope floor 0.16), too
     * deep for Sand Plains (ends 90), far too flat for Shelf Break (floor
     * 0.42) and 40+ m above Twilight Terraces (starts 150). ~850 unowned
     * 16 m cells (~22 ha); simulated against this record the candidate wins
     * 1,592 12 m cells (22.9 ha) in an east-side arc of ~1 ha patches -
     * largest 76 cells centred (1658, 478), r 1725, depth 93.8-103.8, mean
     * slope 0.10 - with Boulder Field keeping every 0.16+ dune flank it
     * already full-fits. That interleave is accepted, Bulb-Grove-style: a
     * boulder-strewn fringe between platter stands is the reference's own
     * floor.
     *
     * WATER IS PLATTER_TEAL, AUTHORED FOR THIS BIOME (WATER_TYPES row 11 has
     * the whole argument): green Kd pinned to the deep family's 0.0182 so a
     * 97 m column still delivers a bright emerald key, ceiling 361.4 m >> the
     * 124 m band. Neighbours carry COASTAL_GREEN (Boulder Field) and
     * OCEANIC_CLEAR (Shelf Break), so the pooled vote reaches the fringe; the
     * core classifies its own water (test-jump prints the arrival column).
     *
     * The fogTint is emerald-cyan - the reference's haze IS the biome's
     * colour (the haze bullet in CLAUDE.md), and the warm accents live on the
     * EMISSIVE platter rims, not in the water.
     */
    id: 17, name: 'Platter Forest', short: 'platter',
    // depth [88, 124]: the floor of the orphaned belt. 88 keeps a 2 m step
    // under Sand Plains' 90 m floor so the sand feather, not this record,
    // owns the transition shelf; 124 is where the belt's flats run out
    // (deeper flats at this radius are already Shelf Break feather ground).
    // slope hi 0.45 with a 0.16 feather: the grove keeps the dune-scale
    // oscillation the meadow record measured (0.05-0.35) inside its own
    // full-fit, and cedes genuinely steep ground to Boulder Field/Shelf
    // Break at exactly the slopes where their records begin to full-fit.
    depth: [88, 124], slope: [0, 0.45], radius: [1540, 1960],
    // scoreBias 0.01: the zero-cession probe above measured the belt's FLATS
    // (mean slope 0.10) and missed that the band's own 0.20-0.45 undulations
    // sit inside KELP FOREST's full-fit cell (depth 56-170, slope 0.20-2.2,
    // radius 1050-1950 all strictly contain this record's band there), where
    // both records score exactly 1.0 and biomeAt's strict argmax hands the
    // tie to the LOWER id - so the "boulder-strewn fringe" the landing
    // accepted was actually delivering kelp stalks between the platter
    // stands (playtest-reported: "why is there a bunch of kelp among the
    // platters?"). Measured at the platter anchor (1632, 480), seed
    // 1534754449, real slope, 8 m grid, r<=80: platter 54.9%, KELP 23.0%,
    // boulders 14.2% before the bias. The bias only moves near-ties: 0.01
    // against W_SLOPE 0.30 puts the kelp boundary at kelp slope-fit 0.967,
    // i.e. slope ~0.194 - the edge of kelp's own plateau - and is 6% of
    // BLEND_WINDOW, so material/water blends move imperceptibly. Zero
    // effect anywhere this record's fit is 0 (everywhere outside its own
    // cell + feathers). After the bias the anchor search RE-SITES to
    // (1880, -176) (purity 96.5% at r<=80) - any route aimed at the old
    // anchor needs re-probing. Matched pair (--only kelp,platter, control
    // worktree at be6dd0d): the KELP anchor is bit-identical (hue entropy
    // 1.3406 -> 1.3405, meanL 0.4844 -> 0.4845); the platter anchor's
    // entropy falls 1.57 -> 0.75 BECAUSE the kelp wall leaves the frame -
    // both PNGs were opened, and the after-frame is a full platter stand,
    // not emptiness (the subtraction rule's real test).
    scoreBias: 0.01,
    // Olive-tan sand under an encrusted-rock vocabulary: darker than the
    // reef carbonates (this is a twilight floor lit by an authored key, and
    // a bright albedo under a green key reads as snowfield - the Bulb
    // Grove's round-2 lesson), warmer than the canyon silt. rockiness 0.30:
    // the reference floor carries real rubble between the tuft patches.
    // Darkened from [0.196, 0.180, 0.132] on the first delivered frames: at
    // the emerald key's 5-6x exposure the floor read bright cyan and the
    // columns lost their silhouette contrast against it.
    // Warmed R-heavy in round 3: a neutral grey under the emerald key
    // delivered cyan-mint sand; the reference floor is green-TAN, and only
    // an R/G > 1 albedo can pull the delivered hue off cyan.
    // ...and halved again in round 4: the review measured the floor
    // metering to near-white and crushing the whole frame's exposure - the
    // reference sand is a TAN mid-tone, and the auto-exposure returns the
    // brightness this albedo gives up.
    albedo: [0.120, 0.096, 0.055], roughness: 0.78, rockiness: 0.30, sediment: 0.72,
    waterType: 'PLATTER_TEAL', fogTint: [0.085, 0.40, 0.37], macroStyle: 0.46, sightDensity: 0.35, dangerTier: 2,
    // A 420 m annulus: tighter than the deep biomes' 180 m ring feathers in
    // radius for the meadow/bulb reason (a wide feather blurs a narrow
    // annulus into its donors), and slope feather 0.16 mirrors the band
    // reasoning above.
    feather: { depth: 10, slope: 0.16, radius: 150 },
  }),
  Object.freeze({
    // =========================================================================
    // SUNKEN DUNES (2026-08-19): the leviathan hunting ground - a pale dune
    // plateau raised out of the abyssal ramp by terrain LAYER 9.6 (the Splitmaw
    // Shoal, world/terrain.js), rimmed by its own 150-500 m cliffs, under the
    // DUNE_AZURE art-deviation water (constants.js carries the whole colour
    // derivation). Its art-direction reference is a huge red-and-pale
    // predator seen coming through clear azure water.
    //
    // SITED BY THE MANUFACTURED-GROUND METHOD (the Kelp rebuild's, not the
    // orphan-annulus method): the natural seabed in the wedge (r 2430-2940,
    // bearing -46..-14 deg, SSW) is 469-865 m down and belongs to nobody's
    // full-fit - the site probe measured the region's 660-940 m mid-slope
    // ramp as the largest unowned mass in the world - so the plateau the
    // layer raises to 318-342 m mints ground only this record full-fits:
    // Terraces end at 292 (depth fit 0.65 at 335, score ~0.85, at the blend
    // cutoff), Ossuary's radius full-fit ends at 2360, Abyssal starts at 420.
    // The rim cliffs (slope 1.5-4) classify Canyon Wall / Trench Wall, which
    // is coherent: dark walls around a sunlit shoal.
    id: 18, name: 'Sunken Dunes', short: 'dunes',
    // depth [300, 398]: sized against the CLASSIFIER'S JITTER, not the raw
    // ground. The dune field rolls -338..-358 (base -348, large dunes
    // +/-8, ripples +/-1.3, micro +/-0.55) and scoreAll jitters depth by
    // +/-11% BEFORE the fit, so the band must hold [302, 396] or the
    // jitter tails fall to neighbouring records - at the first cut's
    // [312, 348] band over a -330 plateau the arena was 9.8% terrace and
    // 4.6% abyssal pockets, whose kits delivered green glowing caps into
    // an azure/crimson/bone biome (round-1 review, MAJOR). 300 stays
    // ABOVE Terraces' 292 ceiling and 398 BELOW Abyssal's 420 floor, so
    // the widened band still overlaps no other record's full-fit.
    // slope hi 0.50 with a 0.16 feather: the Bulb Grove's own lesson one
    // scale up - the dune field's exact-slope oscillation rides 0.05-0.45
    // at crest scale, and at 0.42 the canyon record was winning the flank
    // of every dune (measured: 29.9% canyon inside the plateau core).
    depth: [300, 398], slope: [0, 0.50], radius: [2470, 2900],
    // Pale biogenic dune sand, a MID-tone (the Platter round-4 exposure
    // lesson: a bright albedo under a saturated key meters the frame down
    // and crushes the water's own luminosity). Faintly warm (R/G > 1) so the
    // delivered hue under the blue key sits pale-azure rather than pure
    // blue. rockiness 0.06 and macroStyle 0.35 (round 2: at 0.12/0.62 the
    // mid-range floor delivered a high-contrast two-tone mottle that read
    // as camouflage noise, masked any pale silhouette against the ground,
    // and buried the geometry ripples the biome is named for).
    albedo: [0.235, 0.225, 0.190], roughness: 0.82, rockiness: 0.06, sediment: 0.88,
    // fogTint: azure-TURQUOISE haze (round 2: [0.06, 0.28, 0.42] delivered
    // a flat cobalt wall in every frame - the reference's identity is blue
    // WITH green content; ratios only, renderer normalises to unit luma).
    // sightDensity 0.62: effective 2%-contrast visibility ~121 m - the
    // user's own acceptance test for this biome is "see it coming".
    waterType: 'DUNE_AZURE', fogTint: [0.060, 0.340, 0.380], macroStyle: 0.35, sightDensity: 0.62, dangerTier: 4,
    // Tight ring feather on a 430 m annulus (the meadow/bulb/platter
    // reasoning); depth feather 18 reaches the rim-top transition without
    // letting the record leak down the cliffs.
    feather: { depth: 18, slope: 0.16, radius: 150 },
  }),
]);

export const BIOME_COUNT = BIOMES.length;

/** id -> record, for the O(1) lookups every consumer wants. */
export const BIOME_BY_ID = Object.freeze(BIOMES.reduce((m, b) => { m[b.id] = b; return m; }, {}));

/** Score weights. Depth dominates because it is what the player perceives. */
const W_DEPTH = 0.44;
const W_SLOPE = 0.30;
const W_RADIUS = 0.26;

/** Boundary-jitter field: 340 m features, +/-11% of depth and +/-0.07 of slope.
 *  Two octaves, because this runs once per baked vertex and the third octave of
 *  a 340 m field moves a boundary by less than the sample pitch. */
const JITTER_OCTAVES = 2;
const JITTER_FREQ = 1 / 340;
const JITTER_DEPTH = 0.11;
const JITTER_SLOPE = 0.07;

/**
 * Width of the blending window below the winning score. Biomes within this
 * much of the leader all contribute; the weight falls off quadratically so the
 * transition has a continuous derivative and no visible contour.
 */
const BLEND_WINDOW = 0.16;

// ===========================================================================
// Scoring
// ===========================================================================

/**
 * C1 plateau fit: 1 inside [lo, hi], falling smoothly to 0 over `feather`.
 * Ranges are authored to overlap so that every (depth, slope, radius) triple in
 * the world is claimed by at least one biome; `biomeWeights` asserts this by
 * falling back to the nearest-depth record if it ever is not.
 */
function fit(v, lo, hi, feather) {
  return smoothstep(lo - feather, lo, v) * (1 - smoothstep(hi, hi + feather, v));
}

const _scores = new Float64Array(BIOME_COUNT);

/** [index, bias] for every record carrying a scoreBias, precomputed once so
 *  the hot scoring loop pays nothing for the mechanism (see the tie-break
 *  block in scoreAll for the measurement that forced this shape). */
const _BIASED = [];
for (let i = 0; i < BIOME_COUNT; i++) {
  if (BIOMES[i].scoreBias) _BIASED.push([i, BIOMES[i].scoreBias]);
}

/**
 * Boundary-jitter seed. terrain.setSeed() pushes the world seed in here rather
 * than this module pulling it back out of terrain.js: the dependency runs one
 * way (terrain -> biomes) so there is no import cycle, and a bake worker can
 * seed the two modules with one call.
 */
let _jitterSeed = hashU32(WORLD.DEFAULT_SEED ^ 0x00050001) >>> 8;

export function setBiomeSeed(seed) {
  _jitterSeed = hashU32((seed >>> 0) ^ 0x00050001) >>> 8;
  return _jitterSeed;
}

function scoreAll(x, z, height, slope) {
  const j = fbm2(simplex2, x * JITTER_FREQ, z * JITTER_FREQ, _jitterSeed, JITTER_OCTAVES);
  const depth = -height * (1 + JITTER_DEPTH * j);
  const slopeJ = Math.max(0, slope + JITTER_SLOPE * j);
  const r = Math.sqrt(x * x + z * z);

  for (let i = 0; i < BIOME_COUNT; i++) {
    const b = BIOMES[i];
    const f = b.feather;
    _scores[i] = W_DEPTH * fit(depth, b.depth[0], b.depth[1], f.depth)
               + W_SLOPE * fit(slopeJ, b.slope[0], b.slope[1], f.slope)
               + W_RADIUS * fit(r, b.radius[0], b.radius[1], f.radius);
  }
  // scoreBias: a SPECIFICITY tie-break, not a density weight. The argmax in
  // biomeAt breaks exact ties to the lower array index, so a late, narrow
  // record whose cell sits entirely inside an older record's full-fit
  // plateau can NEVER win its own ground (both score exactly 1.0). A record
  // carrying scoreBias wins those plateau ties and nothing else - the bias
  // must stay far below BLEND_WINDOW (0.16) and below any single fit term,
  // or it stops being a tie-break. Gated on score > 0 so a biased record
  // stays exactly 0 outside its own cell + feathers and nearestByDepth is
  // untouched. Applied OUTSIDE the scoring loop from a precomputed carrier
  // list: an in-loop `b.scoreBias ?? 0` measured 3.8-4.0% of biomeAt
  // (interleaved 10-round A/B) - ~21 ns of the bake's ~58 ns/sample budget,
  // paid on all 19 records for a mechanism one record uses. Sole carrier
  // today: Platter Forest (see its row for the measurement).
  for (let k = 0; k < _BIASED.length; k++) {
    const e = _BIASED[k];
    if (_scores[e[0]] > 0) _scores[e[0]] += e[1];
  }
  return _scores;
}

/** Nearest-depth fallback. Only reachable if the catalogue stops covering the
 *  domain, which the verification script checks for explicitly. */
function nearestByDepth(depth) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < BIOME_COUNT; i++) {
    const b = BIOMES[i];
    const c = (b.depth[0] + b.depth[1]) * 0.5;
    const d = Math.abs(depth - c);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// ===========================================================================
// Public queries
// ===========================================================================

/**
 * Dominant biome id at a position.
 *
 * THE `slope = 0` DEFAULT IS A HAZARD, NOT A NEUTRAL PRIOR, and it is defaulted
 * here only because removing it would change generation. It does not mean
 * "classify this depth without regard to the ground" - it is the value that
 * makes the FLAT records win. Five of the fourteen have
 * `slopeMin - featherSlope >= 0.14`, so their slope term is exactly 0.0000 at
 * slope 0 and they can never be dominant (Island Basalt, Shelf Break, Rock
 * Spires, Canyon Wall, Trench Wall); Kelp Forest and Boulder Field do score
 * there, 0.62-0.96 and 0.26-0.68, and lose every contest to a flat neighbour
 * anyway. Measured over 14,377 seabed samples on a 40 m grid at the default
 * seed: the default turns fourteen live biomes into eight and puts 81.8% of the
 * seabed into three (abyssal 29.1 + terrace 27.2 + sand 25.5, against a true
 * 4.7 / 3.2 / 7.9). `biomeAt` itself disagrees with the real-slope answer on
 * 67.5% of the seabed. See `waterTypeAt`, which no longer defaults it and
 * throws instead, for the full measurement and for what the default cost the
 * ocean while it was there.
 *
 * @param {number} height terrain height in metres (pass sampleHeight's result)
 * @param {number} [slope] gradient magnitude. PASS terrain.sampleSlope(x, z),
 *   or the gradient you already computed for the normal, from anywhere that can
 *   reach one. Callers that genuinely only know a position (audio beds, map
 *   labels) get the flat-biome answer described above and should expect it.
 */
export function biomeAt(x, z, height, slope = 0) {
  const s = scoreAll(x, z, height, slope);
  let best = -1, bestScore = 0;
  for (let i = 0; i < BIOME_COUNT; i++) {
    if (s[i] > bestScore) { bestScore = s[i]; best = i; }
  }
  return BIOMES[best < 0 ? nearestByDepth(-height) : best].id;
}

/**
 * Normalised blend weights for every biome, written into `out`
 * (length BIOME_COUNT). Typically two or three entries are non-zero.
 *
 * `slope` carries the same hazard as `biomeAt`'s - at 0, five records score
 * exactly zero and two more always lose. Pass terrain.sampleSlope(x, z).
 */
export function biomeWeights(out, x, z, height, slope = 0) {
  const s = scoreAll(x, z, height, slope);
  let top = 0;
  for (let i = 0; i < BIOME_COUNT; i++) if (s[i] > top) top = s[i];

  if (top <= 0) {
    out.fill(0);
    out[nearestByDepth(-height)] = 1;
    return out;
  }

  const cutoff = top - BLEND_WINDOW;
  let sum = 0;
  for (let i = 0; i < BIOME_COUNT; i++) {
    const e = s[i] - cutoff;
    const w = e > 0 ? e * e : 0;
    out[i] = w;
    sum += w;
  }
  const inv = 1 / sum;
  for (let i = 0; i < BIOME_COUNT; i++) out[i] *= inv;
  return out;
}

const _weights = new Float64Array(BIOME_COUNT);
const _material = {
  albedo: new Float64Array(3),
  roughness: 0.8,
  rockiness: 0.5,
  sediment: 0.5,
  macroStyle: 0,
  biome: 0,
  waterType: 'OCEANIC_CLEAR',
  fogTint: new Float64Array(3),
  dangerTier: 0,
};

/**
 * Blended surface material at a position.
 *
 * Scalars and colours are averaged across the blend weights, which is what
 * gives a smooth substrate transition; the categorical fields (waterType,
 * dangerTier, biome id) take the dominant biome's value, because averaging a
 * water type or a danger tier is meaningless.
 *
 * `slope` carries the same hazard as `biomeAt`'s and the same instruction: pass
 * terrain.sampleSlope(x, z), or the gradient the normal already needed, which
 * is what the bake does (terrain.js hands it `Math.hypot(mgx, mgz)`).
 *
 * @param {object} [out] reused output object; a module scratch by default, so
 *   callers in a bake loop allocate nothing. Copy what you need before the
 *   next call.
 */
export function materialAt(x, z, height, slope = 0, out = _material) {
  biomeWeights(_weights, x, z, height, slope);

  let ar = 0, ag = 0, ab = 0, rough = 0, rock = 0, sed = 0, macro = 0;
  let fr = 0, fg = 0, fb = 0;
  let dom = 0, domW = -1;
  for (let i = 0; i < BIOME_COUNT; i++) {
    const w = _weights[i];
    if (w <= 0) continue;
    const b = BIOMES[i];
    ar += b.albedo[0] * w; ag += b.albedo[1] * w; ab += b.albedo[2] * w;
    fr += b.fogTint[0] * w; fg += b.fogTint[1] * w; fb += b.fogTint[2] * w;
    rough += b.roughness * w;
    rock += b.rockiness * w;
    sed += b.sediment * w;
    macro += b.macroStyle * w;
    if (w > domW) { domW = w; dom = i; }
  }

  out.albedo[0] = ar; out.albedo[1] = ag; out.albedo[2] = ab;
  out.fogTint[0] = fr; out.fogTint[1] = fg; out.fogTint[2] = fb;
  out.roughness = rough;
  out.rockiness = rock;
  out.sediment = sed;
  out.macroStyle = macro;
  const b = BIOMES[dom];
  out.biome = b.id;
  out.waterType = b.waterType;
  out.dangerTier = b.dangerTier;
  return out;
}

/**
 * How many optical depths of the least-attenuated channel a water mass may be
 * seen through before the local seabed stops describing the column.
 *
 * This is a NEW rule, calibrated so that OCEANIC_CLEAR reproduces the shipped
 * `depth > 260` exactly, and provably identical to the old rule at every depth
 * past 260 m. Both halves of that sentence are checkable and the second one is
 * the whole reason the constant is written this way: past 260 m no
 * non-ABYSSAL_VOID biome is admissible and a rejected ABYSSAL_VOID falls
 * through to the ABYSSAL_VOID default, so the two rules cannot disagree there.
 *
 * The unit is optical depth rather than metres because the twilight zone is a
 * LIGHT boundary and 260 m is only its depth in the water it was measured in:
 * OCEANIC_CLEAR, whose least-attenuated channel is blue at Kd 0.0253. Note the
 * dependence this gives is the OPPOSITE of the old sentence's - a murkier water
 * type is allowed LESS depth than a clear one, where the old rule said only
 * that the local seabed stops describing the column past the twilight zone.
 * That inversion is deliberate and it is what stops the fix being a blackout
 * (see waterTypeAt), but it is a new claim and not a restatement.
 */
const COLUMN_OPTICAL_DEPTH = 260 * Math.min(...WATER_TYPES.OCEANIC_CLEAR.Kd);

/**
 * Per-biome depth ceiling in metres, from the water type each one carries.
 * Baked once: `Math.min(...Kd)` in a per-frame query is a spread allocation for
 * a number that cannot change.
 *
 * Measured, re-read off the table 2026-08-05: ABYSSAL_VOID / HADAL_SUSPENSION /
 * VENT_HAZE / NEPHELOID 361.4 m, OCEANIC_CLEAR 260.0, REEF_TURQUOISE 179.7, BRINE 120.7,
 * COASTAL_GREEN 87.2, MURKY_PARTICULATE 5.7, VENT_SMOKE 1.5. COASTAL_GREEN read
 * 35.9 here until 2ba914e re-authored that type and this line was not updated
 * with it; 87.2 is what `test-terrain` measures.
 *
 * THE 361.4 m CEILINGS NOW BIND, and the sentence that used to stand here -
 * "which never binds, because past 260 m the fallthrough is ABYSSAL_VOID
 * anyway" - is why the deep had one water. It was true only while every deep
 * biome ALSO carried ABYSSAL_VOID, so being rejected and falling through gave
 * the same answer as being admitted. Two of them now carry HADAL_SUSPENSION and
 * NEPHELOID, so the difference between admitted and rejected is the whole
 * change, and it is the aphotic gate below that lets a 400-900 m column reach
 * any of the three.
 *
 * REJECTING A TYPE IS ONLY EVER A BRIGHTENING BECAUSE OF WHAT THE CATALOGUE
 * HAPPENS TO CARRY, not because of how the rule is built. Ordering candidates
 * by `min(Kd)` coincides with per-channel clarity only while the types in play
 * are nested in ALL THREE channels, which the four `BIOMES` uses are: red
 * 0.2321 < 0.2559 < 0.300 < 0.437, green 0.0508 < 0.0576 < 0.0725 < 0.183,
 * blue 0.0182 < 0.0253 < 0.0366 < 0.252 for ABYSSAL_VOID / OCEANIC_CLEAR /
 * REEF_TURQUOISE / COASTAL_GREEN. BRINE breaks it and is the reason this is
 * written down: min(Kd) 0.0545 buys it a 120.7 m ceiling, deeper than
 * COASTAL_GREEN's 87.2, while at 87.3 m it delivers 0.61x COASTAL_GREEN's
 * daylight LUMA and 0.001x its GREEN - so the day a biome carries BRINE,
 * passing over COASTAL_GREEN in its favour turns the lights off.
 * `tools/test-terrain.mjs` section 10b measures exactly that, over the band
 * where each crossover actually happens, so this is enforced rather than hoped
 * for. It is no longer a per-channel NESTING test: HADAL_SUSPENSION's 361.4 m
 * against OCEANIC_CLEAR's 260.0 is a real crossover whose red and green ratios
 * are below 1 on channels the loser has already lost (2.4e-8 and 3.1e-7 of the
 * surface), while its delivered luma is 6.3x - 13.0x. See the test.
 *
 * HADAL_SUSPENSION, VENT_HAZE AND NEPHELOID ALL MEASURE 361.4 m, IDENTICALLY TO
 * ABYSSAL_VOID, AND THAT TIE IS LOAD-BEARING. `min(Kd)` is the blue channel for
 * all four and all four author it as exactly 0.0182. That is what keeps
 * `test-terrain` section 10b's exemption legal, because its loop opens
 * `if (ceilingOf(A) <= ceilingOf(B)) continue` and an equal ceiling exits before
 * the crossover test - there is no band in which the rule prefers one of the
 * four over another, so there is nothing to judge. Break the tie and section
 * 10b starts judging a crossover that does not exist. The pin is documented at
 * the site that can violate it, in `WATER_TYPES`; this comment exists so the
 * ceiling half of the pair says so too. NOTE that section 10b's explicit
 * bit-equality assertion still lists only the first three names, so NEPHELOID's
 * blue is pinned by documentation alone until that array gains it.
 */
const _columnCeiling = Float64Array.from(BIOMES,
  // KELP_EMERALD's own 361.4 m ceiling is LIVE here since the basin phase of
  // the emerald rebuild: the kelp record now spans [56, 170] and the basin's
  // deepest floors reach ~194 m, all of which need admission past
  // COASTAL_GREEN's 87.2 m. (A one-day interim capped this row at
  // COASTAL_GREEN's ceiling to keep the then-shallow biome from flipping
  // 87-104 m feather slivers; the re-siting made that cap wrong.)
  (b) => COLUMN_OPTICAL_DEPTH / Math.min(...WATER_TYPES[b.waterType].Kd));

/**
 * The depth past which even the open ocean stops being lit like the open ocean.
 * Identically 260 m, and derived rather than written so that a change to
 * OCEANIC_CLEAR's Kd moves the fallthrough and the per-biome ceilings together.
 */
const OPEN_OCEAN_CEILING = COLUMN_OPTICAL_DEPTH / Math.min(...WATER_TYPES.OCEANIC_CLEAR.Kd);

/**
 * How much DAYLIGHT is left in a column of this depth, 1 above 319.8 m and 0 at
 * and below TRUE_DARK_DEPTH.
 *
 * Bit-for-bit the `aphoticFactor()` the composite applies
 * (`common/ocean.wgsl:401`, reproduced offline in `passes/glow.js:230` and in
 * `test-ocean.mjs` section 6): same smoothstep, same two edges. It has to be, or
 * the classifier admits a water mass on the strength of daylight the renderer
 * has already multiplied by zero.
 *
 * @param {number} column depth of the water column, positive metres
 * @returns {number} surviving daylight fraction, 0..1
 */
function aphoticFactor(column) {
  return 1 - smoothstep(TRUE_DARK_DEPTH * 0.615, TRUE_DARK_DEPTH, column);
}

/**
 * Every authored site that may override the water column: the PLACES, plus the
 * Pelagos habitat.
 *
 * IT IS A LIST AND NOT JUST `PLACES` BECAUSE THE HABITAT IS A SITE, NOT A
 * PLACE - no jump row of its own, no scatter cull radius, no props table - and
 * it still has to author its water, against a classification it LOSES: the
 * clearing is Sand Plains at raw weight 1.0000, while `waterTypeAt`'s 24 m
 * ring taps land on the Boulder Field slopes around it (boulders 0.589 against
 * sand 0.411) and hand the column to COASTAL_GREEN. The station photographed
 * as one saturated green for it; PELAGOS_AQUA's docstring in
 * `core/constants.js` carries the measurements.
 *
 * IT EXISTS SO TWO READERS CANNOT DISAGREE. `PLACE_WATER` below bakes from it
 * and `tools/test-jump.mjs` audits from it, so a site that authors water is
 * classified by the first and checked by the second - and a `water` field
 * cannot become the dead authored data this project keeps re-shipping. Adding
 * a site here is the whole wiring; nothing downstream knows the difference.
 *
 * The habitat is deliberately NOT subject to `places.js`'s module-load
 * envelope check (a water disc must fit inside the place radius): that radius
 * is a scatter CULL disc, while `clearRadius` is the opposite kind - the
 * volume scatter is removed FROM - and the station's water is wider than its
 * clearing on purpose, so the handover lands on open seabed.
 */
export const WATER_DISC_SITES = Object.freeze([...PLACES, HABITAT_SITE]);

/**
 * Authored site water, baked flat from `WATER_DISC_SITES` so `waterTypeAt`
 * pays two multiplies per site per call and a sqrt only inside a disc.
 *
 * Validation THROWS at module load rather than degrading: a place naming a
 * water key that does not exist is exactly the dead-authored-data bug the
 * places layer was built to kill, and it must not survive to a frame.
 *
 * `ceiling` is the same COLUMN_OPTICAL_DEPTH / min(Kd) rule the per-biome
 * ceilings use, so the invariant "waterTypeAt never returns a water whose lit
 * column exceeds its ceiling" survives the override. All shipped overrides
 * are deep enough that the aphotic gate has already taken `lit` to 0 (691 m
 * and 641.9 m against TRUE_DARK_DEPTH 520), so the test never binds today -
 * but the day someone authors shelf water into a 400 m place, this is what
 * refuses it instead of blacking the column out. tools/test-jump.mjs
 * measures each override surviving classification at its own centre.
 *
 * OVERLAPS RESOLVE LATEST-WINS AT EQUAL WEIGHT (the `>=` below): Emberthroat
 * lists its VENT_SMOKE core after its VENT_HAZE field, both are at weight 1
 * inside the core, and the core must own its 12 m.
 */
const PLACE_WATER = (() => {
  const out = [];
  for (const p of WATER_DISC_SITES) {
    if (!p.water) continue;
    for (const w of p.water) {
      const wt = WATER_TYPES[w.type];
      if (!wt) {
        throw new Error(`places: '${p.short}' names water '${w.type}', which is not a WATER_TYPES key`);
      }
      if (!(w.feather >= 0 && w.feather < w.radius)) {
        throw new Error(`places: '${p.short}' water '${w.type}' feather ${w.feather} must be inside its ${w.radius} m radius`);
      }
      out.push({
        x: p.x, z: p.z, water: wt,
        inner: w.radius - w.feather, outer: w.radius, outer2: w.radius * w.radius,
        ceiling: COLUMN_OPTICAL_DEPTH / Math.min(...wt.Kd),
      });
    }
  }
  return out;
})();

const _wtWeights = new Float64Array(BIOME_COUNT);

/** Scratch for the ring taps of waterTypeAt's spatial smoothing. */
const _wtTap = new Float64Array(BIOME_COUNT);

/**
 * The water type a swimmer at this position is looking through.
 *
 * Distinct from `materialAt().waterType` in two ways, both about the COLUMN
 * rather than the ground: the answer is depth-aware, and a water mass that
 * cannot exist in this column is passed over - in favour of the next biome in
 * the blend if one of them can hold water here, and of the open ocean if none
 * of them can.
 *
 * `slope` IS REQUIRED AND IS NOT DEFAULTED, and that is the point of this
 * signature. This function used to call `materialAt(x, z, height, 0)` while its
 * own docstring claimed it differed from `materialAt` only in being depth-aware.
 * A slope of 0 is not a neutral prior - it is the value that makes the FLAT
 * biomes win. Five records have `slopeMin - featherSlope >= 0.14`, so their
 * slope term is exactly 0.0000 there and they can never be dominant (basalt,
 * break, spires, canyon, trenchWall), and kelp and boulders do score on it but
 * lose every contest to a flat neighbour. Measured over 14,377 seabed samples
 * on a 40 m grid at the default seed: the dominant biome collapsed from
 * fourteen live records to eight, with abyssal 29.1% + terrace 27.2% + sand
 * 25.5% taking 81.8% of the world against a true 4.7 / 3.2 / 7.9%; and the
 * water type disagreed with the biome the terrain is SHADED as on 50.1% of the
 * seabed. COASTAL_GREEN went 20.8% -> 0.19%: an authored Jerlov 3C water type,
 * with its own bottom albedo and 10.7 m visibility, absent from the game.
 *
 * BE HONEST ABOUT WHAT THE LANDED RULE DOES TO THAT MOTIVATING NUMBER, because
 * it is the one figure that shows the objective changed. Same grid, same
 * definition (returned type vs the type the dominant biome at the REAL slope
 * carries, which is what `terrain.wgsl` shades with): shipped 50.07% disagree,
 * the slope alone 28.39%, and as it stands 48.18%. The ceiling hands back 19.8
 * of the 21.7 points the slope recovered, and it does that on purpose. The rule
 * is no longer "the column matches the ground it stands on" - it is "the column
 * matches the ground WHERE THE GROUND IS STILL LIT LIKE THAT GROUND, and is the
 * open ocean where it is not". That is a defensible trade only because the
 * alternative is measured below; it is not a better score.
 *
 * `biomes.js` deliberately does not import `terrain.js` - the dependency
 * runs terrain -> biomes so there is no cycle, which is why `setBiomeSeed` is
 * pushed in rather than pulled - so the slope has to arrive from the caller.
 * Pass `terrain.sampleSlope(x, z)`: its 2 m epsilon is the same 4 m span the
 * bake measures the classifier's slope over, so a CPU consumer gets the biome
 * the mesh was actually built with. Measured offline over 200k calls on a 2 km
 * spiral: `sampleSlope` 3.83 us and this function 0.59 us, so 8.83 us across
 * both live call sites (`main.js` per rendered frame, `spawner.js` per
 * unpaused frame) - 0.106% of an 8.333 ms frame. `qa.mjs` reports 120.0 fps and
 * an unchanged 9.2-9.3 ms p99 across all eleven scenarios after the change. Do
 * not optimise it, and in particular do not substitute a slope built from
 * `sampleHeightFast`: that is 37% cheaper and disagrees with the baked biome,
 * which is the whole fault this docstring is about.
 *
 * THE CEILING HAS TO LAND WITH THE SLOPE OR THE FIX IS A REGRESSION. Restoring
 * the real slope alone hands the deep seabed to biomes carrying coastal water:
 * Kelp Forest is authored `depth: [14, 78]` and Boulder Field `[34, 140]`, both
 * COASTAL_GREEN, whose green daylight is down to 1% of the surface at 25.2 m.
 * Measured over the same grid, the slope fix ALONE makes 18.86% of the seabed
 * more than 100x darker than shipped, worst case 6.09e-9; at the QA
 * `underwater-deep` station (455, -120, 1926), which flips to COASTAL_GREEN on
 * a boulders weight of 0.60, surviving green daylight goes 9.96e-4 -> 2.90e-10.
 * With the ceiling nothing anywhere gets more than 53x darker (worst ratio
 * 1.89e-2, on 1.22% of the seabed, all of it shallow kelp finally getting the
 * water it was authored for), 10.41% gets BRIGHTER and 11.63% changes type.
 * Rejecting a candidate is only ever a brightening here, but that is a property
 * of the four types this catalogue carries and not of the rule - see
 * `_columnCeiling`, which names the pair (BRINE against COASTAL_GREEN) that
 * would break it and points at the offline assertion that guards it.
 *
 * THE CEILING IS KEYED ON THE COLUMN, NOT ON THE EYE, and that is the second
 * half of getting it right. Keyed on the eye it puts a hard classification
 * switch INSIDE the swimmable column: measured at (-1720, -120), a kelp/boulder
 * slope with a floor at -69.8 m, an eye descending from 35.9 m to 36.0 m went
 * COASTAL_GREEN -> the fallthrough in one 0.1 m step, taking visibility 10.7 ->
 * 150.5 m, the marine snow 1.6 -> 0.55 and the bottom albedo with them - inside
 * one kelp bed, over ten metres of swimming. The same column read one type from
 * a diver and a different one from the air above it. `max(depth, -height)` is
 * therefore the quantity: a water mass is a property of the COLUMN, so the
 * answer at (x, z) is the same whether it is asked from the surface, from
 * mid-water or from the seabed, and the only reason the eye's depth appears at
 * all is that `sampleHeightFast` drops the dune and talus layers and can read up
 * to 1.83 m shallow.
 *
 * THE FALLTHROUGH IS THE OPEN OCEAN, WHICH IS OCEANIC_CLEAR AND NOT
 * ABYSSAL_VOID. When every weighted biome is rejected there is no next biome in
 * the blend to fall to, and returning the hadal type there is wrong in the
 * shallows: measured, that branch fires on 47.4% of the seabed but 4.18% of it
 * is SHALLOWER than 260 m, from 36.9 m down, 92% of that is kelp-dominant and it
 * is a third of all kelp-dominant seabed - which would have handed 601 of 14,377
 * samples the clearest water in the table (150.5 m visibility against
 * OCEANIC_CLEAR's 94.3), a fifth of the deep tint and a twelfth of the bottom
 * albedo. Past OPEN_OCEAN_CEILING the open ocean is itself out of light and the
 * answer is ABYSSAL_VOID, which is exactly what the shipped `depth > 260` said.
 * With this, ABYSSAL_VOID's share of the seabed is 43.24%: identical to shipped,
 * to the digit.
 *
 * WHAT THIS DOES NOT FIX, stated so it is not read as settled. COASTAL_GREEN
 * survives on 0.99% of the seabed rather than the 20.8% its carriers claim, and
 * only between 23 and 36 m, because the catalogue and the coefficients
 * disagree: kelp does not photosynthesise at 78 m in Jerlov 3C water, so either
 * those depth bands come up or those two biomes want a clearer water type.
 * Both are DESIGN/04 content decisions, and neither is a one-line change -
 * the depth bands feed generation. And THE ANSWER IS NOW A HIGH-FREQUENCY
 * QUANTITY, because slope is: measured on 4 km transects at a 4 m step, the
 * returned type changes 29.8 times per km over the kelp bed and 34.0 over the
 * lagoon, against 0.5 and 1.3 when the slope was forced to 0. The colour is
 * sprung at RENDER.WATER_BLEND_TAU, so a 4 m/s swimmer crosses a boundary about
 * every 8 s and the column is in transit a good part of the time; anything else
 * that keys off this answer wants a lag or a hysteresis of its own, and
 * `spawner.js`'s near-field radius currently has neither.
 *
 * @param {number} x world east
 * @param {number} z world south
 * @param {number} height terrain height at (x, z), metres; negative below sea
 * @param {number} depth the EYE's depth, positive metres below sea level. Only
 *   ever raises the column depth above the seabed's - see the clause above.
 * @param {number} slope gradient magnitude at (x, z). REQUIRED.
 * @param {object} [terrain] the live terrain. When passed (and
 *   WORLD.WATER_TYPE_SMOOTH_RADIUS > 0), the biome weights behind the
 *   decision are averaged over the centre plus six ring taps at that radius,
 *   each with its own sampleHeightFast/sampleSlope - a water mass is a
 *   regional thing, and the unsmoothed answer inherited the full
 *   high-frequency content of the slope field: 29.8 switches per km over
 *   the kelp bed, and blue Reef-Shallows pockets inside the green forest
 *   that survived even the per-type pooling (one 2.2 m off the kelp anchor
 *   put fruiting kelp in blue water; measured on the same 240x240 m, 10 m
 *   grid the smoothed answer is COASTAL_GREEN on 625 of 625 cells, against
 *   585 pooled-only and 437 at argmax-by-biome; and a 6.1 km lawnmower
 *   inside the bed at a 4 m step switches type 20.3 times per km
 *   centre-only against 0.0 smoothed). The ceiling below still keys on the
 *   CENTRE column - the daylight being protected is the water over the
 *   camera. Offline callers without a terrain get the centre-only answer,
 *   which is also what WORLD.WATER_TYPE_SMOOTH_RADIUS = 0 reproduces.
 * @returns {object} a WATER_TYPES entry
 */
export function waterTypeAt(x, z, height, depth, slope, terrain = null) {
  if (!Number.isFinite(slope)) {
    throw new TypeError('waterTypeAt needs a real slope - pass terrain.sampleSlope(x, z). '
      + 'Defaulting it to 0 collapses fourteen biomes to eight; see the docstring.');
  }
  // The COLUMN's depth, not the eye's: one water mass per (x, z), whether it is
  // asked from the surface or from the bottom.
  const column = Math.max(depth, -height);
  const smoothR = WORLD.WATER_TYPE_SMOOTH_RADIUS;
  if (terrain && smoothR > 0) {
    _wtWeights.fill(0);
    biomeWeights(_wtWeights, x, z, height, slope);
    for (let k = 0; k < 6; k++) {
      const a = k * (Math.PI / 3);
      const tx = x + Math.cos(a) * smoothR, tz = z + Math.sin(a) * smoothR;
      biomeWeights(_wtTap, tx, tz,
        terrain.sampleHeightFast(tx, tz), terrain.sampleSlope(tx, tz));
      for (let i = 0; i < BIOME_COUNT; i++) _wtWeights[i] += _wtTap[i];
    }
    for (let i = 0; i < BIOME_COUNT; i++) _wtWeights[i] *= 1 / 7;
  } else {
    biomeWeights(_wtWeights, x, z, height, slope);
  }

  // THE CEILING IS WEIGHTED BY THE DAYLIGHT IT IS PROTECTING. The ceiling
  // rejects an authored water because filling this column with it would leave
  // the DAYLIGHT implausibly dark - `COLUMN_OPTICAL_DEPTH` is 260 m of the open
  // ocean's clearest channel and nothing else. Past TRUE_DARK_DEPTH there is no
  // daylight left to protect: the composite's own `aphoticFactor` has already
  // multiplied ambient, in-scatter and deep tint by zero, and all a water type
  // still decides is sigma_t on the sight path and sigma_s in the lamp's
  // in-scatter, neither of which the ceiling has any opinion about. So the
  // accumulated optical depth is scaled by the surviving daylight rather than
  // taken raw.
  //
  // WITHOUT THIS, THE DEEP WATER TYPES ARE DEAD DATA. Canyon Wall's own band
  // mid-depth is 417-478 m against every ceiling in the table (the deepest is
  // 361.4 m), so every deep column was rejected outright and fell through to the
  // default - measured, ABYSSAL_VOID on 100.000% of the seabed past 260 m.
  //
  // IT CANNOT MOVE A COLUMN SHALLOWER THAN 319.8 m, BY CONSTRUCTION, and that is
  // the invariant to protect: aphoticFactor is exactly 1.0 there, so the product
  // is the raw column and the comparison is the shipped one, bit for bit.
  // Measured as a same-process A/B over 16,235 wet samples on a 40 m grid, gate
  // on against gate off with the water assignments held fixed: 0 of the 8,808
  // columns shallower than 320 m change type, against 22.2% of 320-420 m, 93.2%
  // of 420-520 m and 46.8% past 520 m. `WORLD.COLUMN_APHOTIC_GATE` is that A/B
  // and the bisect: 0 reproduces the old rule at every depth. The product peaks
  // at 330.3 m near a column of 341 m, which is under the 361.4 m hadal ceiling
  // - i.e. the deep types are admissible everywhere once the gate opens, which
  // is the entire point.
  //
  // AND IT LETS THE BIOME BRANCH PUT OCEANIC_CLEAR UNDER 900 m OF WATER. That is
  // the same shape as the symptom the fallthrough clause at the bottom of this
  // function warns about, reached by a different route, and it is AUTHORED INTENT
  // rather than an oversight: OCEANIC_CLEAR is assigned to Rock Spires and
  // Twilight Terraces on purpose. It is written down HERE
  // because that clause describes the trap for the TERMINAL choice only, and a
  // reader who finds shelf water 900 m down will read it, find the asymmetry
  // apparently reasoned about once, and assume this branch cannot do it.
  //
  // Measured on the same 16,235-column grid, gate on against gate off:
  // OCEANIC_CLEAR wins 702 samples in 420-520 m and 561 past 520 m where gate-off
  // gives ZERO in both bands, and all 1,263 of them are Rock Spires (1,191) or
  // Twilight Terraces (72).
  //
  // WHAT THAT ACTUALLY DELIVERS, because the obvious worry does not survive the
  // arithmetic and a half-true note here is worse than none. `WATER_BOTTOM_ALBEDO`
  // row 0 is [0.35, 0.34, 0.32] against ABYSSAL_VOID's [0.05, 0.05, 0.05], but its
  // ONLY consumer is `oceanBodyColour()`, which weights it `exp(-2*surfaceKd*h)` -
  // 5.9e-10 in blue at 420 m and 1.7e-20 at 900 m - so that 7x seabed is
  // unreachable on these columns. deepTint's 5x blue lift (0.070 against 0.014) is
  // alive only inside 420-520 m, where `aphoticFactor` runs 0.499 -> 0.000. What
  // IS delivered at every depth is the sight path and the lamp: 2%-contrast
  // visibility 150.5 -> 94.3 m, blue sigma_s 0.012 -> 0.025 (2.08x, so a lamp
  // beam bounds instead of blooming) and snowMultiplier 0.55 -> 1.00. Those three
  // are exactly what a water type still decides below TRUE_DARK_DEPTH, and they
  // are what to re-measure if this assignment is ever revisited.
  const gate = 1 - WORLD.COLUMN_APHOTIC_GATE * (1 - aphoticFactor(column));
  const lit = column * gate;

  // AUTHORED PLACE WATER (world/places.js). The override is a WEIGHT, not a
  // hard disc, and it competes against the biome blend below on the same
  // scale: biomeWeights sums to 1, so a place at full strength (weight 1)
  // always wins its own centre, and toward the rim it hands over exactly
  // where its feathered weight falls below the local biome's share - the
  // same kind of contour every biome boundary already has, rather than a
  // hard circle. main.js's sprung column then smooths the crossing in time
  // as it does every other classification change. The ceiling term keeps
  // the daylight-plausibility invariant; see PLACE_WATER above.
  let placeBest = null, placeW = 0;
  for (let i = 0; i < PLACE_WATER.length; i++) {
    const p = PLACE_WATER[i];
    const dx = x - p.x, dz = z - p.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= p.outer2 || lit > p.ceiling) continue;
    const w = 1 - smoothstep(p.inner, p.outer, Math.sqrt(d2));
    // >= so a core disc listed after its field wins the tie at weight 1.
    if (w > 0 && w >= placeW) { placeW = w; placeBest = p.water; }
  }

  // Highest-weighted admissible biome, PLUS ONE SCOPED POOL: the two
  // COASTAL_GREEN carriers (Kelp Forest and Boulder Field) are one water
  // mass - interleaved slopes of the same coastal shelf, both authored the
  // same Jerlov 3C type - and argmax-by-biome let a third biome beat them
  // on a split vote. Measured on a 10 m grid over 240x240 m of the kelp
  // anchor bed, argmax returned REEF_TURQUOISE on 184 of 625 cells in a
  // salt-and-pepper mosaic flipping every 10-20 m, and on 148 of those the
  // pooled green weight (0.61-0.67) beat the winning sand weight
  // (0.33-0.37): kelp and boulders each lost to sand alone and won
  // together. The delivered symptom was kelp plants growing in blue water
  // 7 m from a green-water anchor, with the fruit's warm spectrum switched
  // off by the water over it.
  //
  // THE POOL IS SCOPED TO COASTAL_GREEN ON PURPOSE. The generic version
  // (pool every shared type) flipped the spawn lagoon: sand+coral pool
  // 0.43-0.63 against reef 0.34-0.52 along the test-creatures treadmill
  // path turned OCEANIC_CLEAR into REEF_TURQUOISE, taking the spawner's
  // near-field radius 45 -> 21 m and its churn to 21.7 seeds/s against the
  // 12/s ceiling; and no margin separates the two cases (kelp needs 1.65x,
  // the lagoon reaches 1.7x on weak-reef cells). Everywhere else the rule
  // is the old argmax, bit for bit. Ties keep the old semantics - strictly
  // greater wins, earliest biome in BIOMES order.
  // 2026-08-18 emerald rebuild: Kelp Forest moved off COASTAL_GREEN onto its
  // own KELP_EMERALD, which would have dissolved this coalition - measured on
  // the old shared-shelf fixture, splitting the pool put REEF_TURQUOISE back
  // on 571 of 625 cells, the exact salt-and-pepper takeover the pool exists
  // to prevent. So the POOL survives (the two biomes still outvote sand
  // together wherever they interleave) and the member share decides WHICH
  // green it delivers. Since the basin phase re-sited kelp onto [56, 170]
  // deep ground, the two records separate by DEPTH BY CONSTRUCTION - kelp
  // weight is zero on Boulder Field's shallow home and dominant on the deep
  // ring - so a simple share test is exact: emerald where kelp is a real
  // member of the vote (>= 0.25 of the pool; a trace of feather does not
  // flip a boulder shelf), COASTAL_GREEN otherwise. Delivering the member's
  // own water keeps the admissibility invariant, because only ADMISSIBLE
  // weights were pooled and kelp's water is the one admitted deepest.
  let best = null, bestW = 0, greenPool = 0, kelpW = 0;
  for (let i = 0; i < BIOME_COUNT; i++) {
    const w = _wtWeights[i];
    if (w <= 0 || lit > _columnCeiling[i]) continue;
    const wt = WATER_TYPES[BIOMES[i].waterType];
    if (wt === WATER_TYPES.COASTAL_GREEN || wt === WATER_TYPES.KELP_EMERALD) {
      greenPool += w;
      if (wt === WATER_TYPES.KELP_EMERALD) kelpW += w;
    }
    if (w > bestW) { bestW = w; best = wt; }
  }
  if (greenPool > bestW) {
    best = kelpW >= 0.25 * greenPool
      ? WATER_TYPES.KELP_EMERALD : WATER_TYPES.COASTAL_GREEN;
    bestW = greenPool;
  }
  if (placeBest !== null && placeW >= bestW) return placeBest;
  if (best) return best;
  // Nothing in the blend can hold water here, so this is open ocean - and the
  // open ocean runs out of light at its own ceiling, which is the shipped 260 m.
  //
  // RAW `column` HERE, NOT `lit`, AND THE DIFFERENCE IS NOT AN OVERSIGHT. The
  // gate above relaxes a REJECTION - it says an authored water is admissible in
  // the dark. This line is a CHOICE OF TERMINAL TYPE, and gating it would invert
  // it: at 700 m the gate is 0, `lit` is 0, and the open abyss would come back
  // as OCEANIC_CLEAR - 94.3 m of shelf water with a 0.35 sand albedo under it,
  // where the whole rule exists to say the deep is the hadal type. The two
  // clauses answer different questions and only one of them is about daylight.
  //
  // THE SYMPTOM IS NOT EXCLUSIVE TO THIS CLAUSE, and reading it as if it were is
  // how the next author gets it wrong: since the aphotic gate landed, the BIOME
  // branch above returns OCEANIC_CLEAR on 1,263 measured columns past 420 m, all
  // of them Rock Spires or Twilight Terraces. That is deliberate and it is
  // reasoned about at the gate comment; this clause is only about the TERMINAL
  // answer when every weighted biome has been rejected.
  return column > OPEN_OCEAN_CEILING ? WATER_TYPES.ABYSSAL_VOID : WATER_TYPES.OCEANIC_CLEAR;
}

/**
 * Danger tier a spawner may use here, 0..5.
 *
 * The start crater is tier 0 by fiat, and the suppression is a ramp rather than
 * a step so a player leaving the lagoon meets escalation instead of a wall.
 */
export function dangerTierAt(x, z, height, slope = 0) {
  const id = biomeAt(x, z, height, slope);
  const r = Math.sqrt(x * x + z * z);
  const release = smoothstep(WORLD.SAFE_CRATER_RADIUS, WORLD.SAFE_FALLOFF_RADIUS, r);
  return Math.round(clamp(BIOME_BY_ID[id].dangerTier * release, 0, 5));
}
