/**
 * SUBWAVE binding constants.
 *
 * The single source of truth for every tuned number in the game. Transcribed
 * from DESIGN/ - if a value here disagrees with a design doc, THIS FILE WINS
 * and the doc is stale.
 *
 * Units are always stated. Colours are LINEAR RGB unless the name says sRGB.
 * Coordinate system: +X east, +Y up, +Z south, metres, sea level y = 0,
 * depth d = -y.
 */

// ===========================================================================
// WORLD
// ===========================================================================

export const WORLD = {
  /** Default seed. Any u32 produces a complete, playable world. */
  DEFAULT_SEED: 0x5b7a7e91,

  /** Playable extent, metres. Square, centred on the origin. */
  EXTENT: 6144,
  HALF_EXTENT: 3072,
  /** Beyond this radius from the origin the water deepens into an impassable abyss. */
  SOFT_BOUNDARY: 2900,
  /** Hard turn-back radius: the vessel's autopilot refuses to continue. */
  HARD_BOUNDARY: 3050,

  SEA_LEVEL: 0,
  /** Highest terrain point (the island's central spire), metres above sea level. */
  MAX_TERRAIN_HEIGHT: 214,
  /** Deepest point of the hadal trench, metres below sea level. */
  MAX_DEPTH: 1600,

  /** Terrain chunk footprint, metres. */
  CHUNK_SIZE: 128,
  /** Vertices per chunk edge at LOD 0 (so 1 m between samples). */
  CHUNK_RESOLUTION: 129,
  /** Number of LOD rings around the camera. */
  LOD_RINGS: 7,
  /** Ring 0 radius, metres; each subsequent ring doubles. */
  LOD_BASE_DISTANCE: 192,
  /**
   * Ring 0 radius for SCATTER, metres; each subsequent ring doubles, exactly as
   * LOD_BASE_DISTANCE does for the terrain mesh.
   *
   * It is a SEPARATE number even though the two are the same order, because they
   * are derived from different things and must be free to diverge. The terrain
   * ring is about triangle density on a surface. This one decides whether a
   * whole scatter TYPE exists at all - `maxLod` deletes a type outright - so it
   * is pinned by the type table: ring `maxLod` must still reach that type's
   * `viewDistance`, with enough margin left over for RESCAN_DISTANCE, since the
   * resident set is only recomputed every 16 m the camera travels.
   *
   * The binding row is mushroomCap at 130 m on maxLod 0, so ring 0 has to clear
   * 146 m. 160 leaves 30 m of margin and puts ring 1 at 320 m against a
   * worst maxLod-1 view distance of 210 m. tools/test-scatter.mjs section 12
   * checks every ring against every type rather than trusting this paragraph.
   */
  SCATTER_LOD_BASE_DISTANCE: 160,

  /** Volumetric (cave) chunk footprint, metres. */
  CAVE_CHUNK_SIZE: 32,
  CAVE_RESOLUTION: 33,
  /** Caves are only generated within this vertical band. */
  CAVE_MIN_Y: -1400,
  CAVE_MAX_Y: 120,

  /** The starting crater: guaranteed danger tier 0. */
  SAFE_CRATER_CENTER: [0, 0],
  SAFE_CRATER_RADIUS: 340,
  /** Threats are suppressed with a soft falloff out to this radius. */
  SAFE_FALLOFF_RADIUS: 460,

  /**
   * NOMINAL base position only - do NOT spawn the player here.
   *
   * The terrain is procedural, so a literal spawn coordinate is a guess that
   * goes silently wrong when any layer is retuned. These values were once
   * exactly that, and they ended up in 17 m of open water: the player spawned
   * swimming, with no land in sight and no vessel in reach.
   *
   * Call terrain.findSpawnPoint() instead. It derives a real beach from the
   * generated island and is deterministic for a given seed. These constants
   * survive only as a fallback and as documentation of the intended region.
   */
  BASE_POSITION: [-241, 3.5, -383],
  VESSEL_PAD_POSITION: [-223, 0.6, -364],

  GRAVITY: 9.81,
  /** Seawater density, kg/m^3. Used by every buoyancy calculation. */
  WATER_DENSITY: 1025,
  /** Hypersaline brine density - the brine pools you can float a vessel on. */
  BRINE_DENSITY: 1198,
  AIR_DENSITY: 1.225,
  /** Speed of sound in seawater, m/s. Drives the sonar echo delay. */
  SOUND_SPEED_WATER: 1500,
  SOUND_SPEED_AIR: 343,

  /**
   * How strongly the aphotic zone relaxes `waterTypeAt`'s optical ceiling, 0..1.
   * The BISECT KNOB for that rule: at 0 the ceiling is the pre-2026-08-05 one at
   * every depth, byte for byte, and at 1 it opens fully below TRUE_DARK_DEPTH.
   * Live-mutable from the console, like the rest of the sprung-column chain.
   *
   * WHY IT IS A KNOB AND NOT A CONSTANT IN biomes.js: the whole deep-water split
   * is unmeasurable without this gate and reproduces the old image exactly with
   * it at 0, so an A/B/A on one number separates "the two new water types did
   * something" from "the ceiling rule moved". See `waterTypeAt`.
   *
   * SINCE THE PLACES LAYER (2026-08-07) THE BISECT'S BLAST RADIUS IS WIDER: at
   * 0 the raw column reading also rejects every deep PLACE water override
   * (VENT_SMOKE/VENT_HAZE at Emberthroat, BRINE at the Halocline Mirror sit
   * far above their raw ceilings), so "reproduces the old image" now includes
   * un-classifying those places. Coherent with what the knob means; just do
   * not read a places A/B with the gate at 0.
   */
  COLUMN_APHOTIC_GATE: 1.0,

  /**
   * Radius of `waterTypeAt`'s spatial weight smoothing, metres. When the
   * caller passes its terrain, the biome weights behind the water decision
   * are averaged over the centre sample plus six ring taps at this radius
   * before the per-type pooling and the ceiling race. 0 reproduces the
   * centre-only build exactly, so it is the bisect.
   *
   * WHY: a water mass is regional, but the classification inherited the
   * full high-frequency content of `sampleSlope` - measured 29.8 switches
   * per km over the kelp bed, and AFTER the per-type pooling it still left
   * blue Reef-Shallows pockets inside the green forest (36 of 625 cells on
   * a 10 m grid, incl. one 2.2 m off the kelp anchor that put kelp plants
   * and fruit in blue water). 24 m spans those pockets without moving real
   * biome boundaries enough to see: the spring at RENDER.WATER_BLEND_TAU
   * already smears the answer over ~8 m of swimming, and biome feathers
   * are 26-40 m. Cost: 6 extra sampleSlope+biomeWeights pairs per call,
   * ~25 us against the 8.83 us the header measures for the pair today.
   */
  WATER_TYPE_SMOOTH_RADIUS: 24,

  /**
   * Seconds a DIFFERING water classification must persist under the camera
   * before it becomes the sprung column's target, in
   * `main.js._updateWaterColumn`. 0 reproduces the undwelled build exactly,
   * so it is the bisect. Explicit snaps (`snapWaterColumn`, teleports, jumps)
   * bypass it and commit immediately.
   *
   * WHY: the spatial smoothing above is radius-limited, and what survives it
   * is patch-scale minority water that a MOVING eye crosses in under two
   * seconds - a temporal problem the spring downstream cannot fix, because
   * the spring smears the transition but still retargets on frame one (and
   * `w.id`, which indexes WATER_BOTTOM_ALBEDO, SNAPS with the target).
   * Measured on the dive-coral corridor (tools/probes/coral-corridor.mjs,
   * seed 1534754449): the original westward swim legs crossed Kelp Coastal
   * patches of 0.5-3.0 s at the legs' real speeds; 1.5 covers every
   * TRANSIENT crossing there with margin, while a genuine biome crossing -
   * which sustains its new answer indefinitely - commits 1.5 s late, inside
   * the ~2 s WATER_BLEND_TAU smear that follows anyway. A dwell is NOT a
   * defence against CAMPING in minority-classified water (a waypoint stop
   * outlasts any honest threshold - the probe's waypoint-camp table is the
   * evidence, and the route was re-aimed east on it); it exists for the
   * moving eye.
   * This is what replaced the showcase's `waterColumnPin`: the demo now
   * photographs the same column free play delivers, because free play stopped
   * flickering.
   */
  WATER_TYPE_DWELL: 1.5,

  /**
   * Static scatter collision master switch, 0 or 1. Live-mutable from the
   * console (`WORLD.SCATTER_COLLISION = 0`), and THE BISECT for backlog item
   * 3.5: at 0 both narrow phases in world/collision.js (the player capsule's
   * proxy pushout and the vessel hull's proxy contacts) are skipped before any
   * arithmetic, and world/scatter_collision.js unregisters every proxy on its
   * next update - so the delivered behaviour is the pre-proxy game exactly,
   * not merely approximately: the terrain paths are byte-identical code.
   * Consumers: CollisionWorld.resolveCapsule / resolveVesselHull (the gate),
   * ScatterCollision.update (the streamer).
   */
  SCATTER_COLLISION: 1,
};

/**
 * Terrain streaming: how a chunk mesh gets from the mesher to the GPU.
 *
 * The mesher runs in a module Web Worker (src/world/terrain_worker.js). One
 * LOD-0 bake is a MEASURED 17.71 ms mean / 23.32 ms p99 (Chrome, 100 varied
 * chunks) - up to four 120 Hz frames - and a bake is indivisible, so no
 * per-frame budget can cut one up. What is left on the main thread is the
 * UPLOAD: two writeBuffer calls on a transferred ArrayBuffer, measured at
 * 0.02 ms per LOD-0 chunk one-at-a-time and 0.17 ms/chunk under a 200-deep
 * back-to-back burst. That IS divisible, so it gets a time budget instead.
 *
 * The rest of the streaming tuning (LOD hysteresis, rescan distance, stream
 * lead, the inline fallback's bake budget, the depth radius steps) still lives
 * in src/world/chunks.js next to the code that reads it.
 */
export const STREAMING = {
  /**
   * Frame time spent uploading finished chunks, milliseconds.
   *
   * 2.0 ms admits at least 11 LOD-0 chunks even at the pessimistic 0.17 ms
   * burst rate - four times the whole pool's worst-case output for a frame -
   * so it can never lose a chunk, only delay one by a frame. Deferring an
   * upload costs latency, never work, which is exactly what a bake budget
   * could not promise.
   */
  UPLOAD_MS_PER_FRAME: 2.0,
  /** Hard cap on uploads per frame, so a pathological queue cannot become an
   *  unbounded loop. The same role maxBakesPerFrame plays for the fallback. */
  MAX_UPLOADS_PER_FRAME: 32,
  /**
   * Worker pool ceiling.
   *
   * THROUGHPUT needs one: flying at Vne the whole clipmap demands 113 ms of
   * bake per second of flight (2.81 LOD-0 chunks/s crossing ring 0 at 119 m/s,
   * plus the coarser rings), which is 11.3% duty on a single core. The pool
   * exists for BURSTS - a rescan leaves 325-419 jobs standing, worth 244 ms,
   * and boot enqueues 3,293 chunks worth 728 ms. Four is the knee: boot bake
   * falls 728 -> 182 ms at four workers and only to 91 ms at eight, against a
   * boot already gated on shader compilation.
   */
  WORKER_POOL_MAX: 4,
  /** Cores left to the main thread and the GPU process when sizing the pool. */
  WORKER_CORES_RESERVED: 2,
  /**
   * Milliseconds to wait for a worker's `ready` reply before retiring it.
   *
   * A module-RESOLUTION failure inside a worker does not throw: it surfaces
   * asynchronously as an `error` event whose message is empty, and sometimes as
   * nothing at all. Boot must not be able to hang on that, so the handshake
   * carries its own deadline.
   */
  WORKER_READY_TIMEOUT_MS: 2000,
  /**
   * Spare transfer buffers a worker keeps per distinct byte length.
   *
   * Chunk size is fully determined by the LOD, so there are only LOD_RINGS
   * distinct lengths in the whole system and an exact-length free list is an
   * exact fit every time - the same argument as the GPU buffer pool in
   * chunks.js. Two per size caps a four-worker pool at about 7 MB.
   */
  WORKER_FREE_LIST_PER_SIZE: 2,
};

/**
 * Depth bands. `min`/`max` are DEPTHS (positive, metres below the surface).
 *   ambient       fraction of surface daylight reaching the band's TOP at noon
 *   visibility    metres at which contrast falls below the 2% threshold
 *   pressureAtTop bar at the band's minimum depth (verify with pressureAt())
 *   danger        0..5 tier used by the spawner and the director
 */
export const DEPTH_BANDS = [
  { id: 'surface',   name: 'Surface',       min: 0,    max: 2,    ambient: 1.0000, visibility: 90, pressureAtTop: 1.0,  danger: 0 },
  { id: 'sunlit',    name: 'Sunlit Zone',   min: 2,    max: 40,   ambient: 0.5200, visibility: 75, pressureAtTop: 1.2,  danger: 1 },
  { id: 'twilight',  name: 'Twilight Zone', min: 40,   max: 150,  ambient: 0.0860, visibility: 48, pressureAtTop: 5.0,  danger: 2 },
  { id: 'midnight',  name: 'Midnight Zone', min: 150,  max: 400,  ambient: 0.0040, visibility: 32, pressureAtTop: 16.1, danger: 3 },
  { id: 'abyssal',   name: 'Abyssal Zone',  min: 400,  max: 900,  ambient: 0.0000, visibility: 24, pressureAtTop: 41.2, danger: 4 },
  { id: 'hadal',     name: 'The Trench',    min: 900,  max: 1600, ambient: 0.0000, visibility: 18, pressureAtTop: 91.5, danger: 5 },
];

/** Depth (m) below which no surface light penetrates at all. */
export const TRUE_DARK_DEPTH = 520;

/** Index into DEPTH_BANDS for a given depth in metres. */
export function depthBandIndex(depth) {
  for (let i = 0; i < DEPTH_BANDS.length; i++) {
    if (depth < DEPTH_BANDS[i].max) return i;
  }
  return DEPTH_BANDS.length - 1;
}

// ===========================================================================
// WATER OPTICS
// ===========================================================================

/**
 * Water types, from DESIGN/03. All coefficients in 1/m at band centres
 * R = 610 nm, G = 550 nm, B = 460 nm.
 *
 * TWO different coefficients, and using the wrong one is the classic way to
 * make an underwater renderer look wrong:
 *
 *   sigmaT (= sigmaA + sigmaS)  BEAM extinction. Governs LINE OF SIGHT: how
 *     fast a lamp beam, a creature, or the terrain fades with distance from
 *     the camera. Every photon leaving the straight path is a loss.
 *
 *   Kd                          DIFFUSE attenuation. Governs how AMBIENT
 *     DAYLIGHT falls off with DEPTH. It is smaller than sigmaT because
 *     forward-scattered photons keep travelling downward and still contribute.
 *
 * Use sigmaT for view-ray transmittance; use Kd for "how bright is it at
 * depth d". Mixing them up makes deep water either pitch black at 40 m or
 * implausibly bright at 200 m.
 *
 * ===========================================================================
 * THE RED COLUMN IS A DELIBERATE DEVIATION FROM JERLOV. 2026-08-02.
 * ===========================================================================
 *
 * Every `sigmaA[0]` below is roughly a quarter of the real value, and `sigmaT`
 * and `Kd` follow from it. This is the one place in the renderer where the
 * physics is knowingly wrong, it was a deliberate art-direction call, and it is
 * the reason the reef reads as coral instead of as white sticks.
 *
 * WHY. Real seawater absorbs 610 nm at 0.23-0.65 /m. Shipped, that gave a red
 * 1/e beam range of 3.3-4.2 m against arrival framings of 8-30 m, so a warm
 * object kept 7.2% of its red at 10 m and 0.14% at 25 m - and the loss is
 * TWICE, because `Kd` deletes red from the ILLUMINANT over the depth before
 * `sigmaT` deletes it again from the SIGHT PATH. Measured end to end at the
 * reef anchor, a coral 12 m away at 12 m depth kept **0.07% of its red**. No
 * albedo, no emissive and no fluorescence can climb out of that: the frames
 * measured 0.00% of pixels more than 40 degrees of hue from their own dominant,
 * at all twelve underwater anchors, against 6.6-77% for the art-direction
 * reference frames. After: **21%**, a ~300x change.
 *
 * THE REFERENCE IS NOT PHYSICALLY ACCURATE AND THAT IS THE POINT.
 * The art-direction reference is a blood-red grass field saturated across tens
 * of metres, which real seawater cannot produce at any depth. The reference
 * GRADES; it does not integrate Beer-Lambert over a 610 nm absorption band.
 * This project's brief is a demo, and DESIGN's own art direction asks for
 * "orange-pink plates", "red fingerweed" and "dense red tuberod colonies".
 *
 * WHAT IS PRESERVED, so the change is bounded rather than a free-for-all:
 *   - GREEN AND BLUE ARE UNTOUCHED. The descent still drains toward blue and
 *     the medium still reads as water; only the rate at which red goes changes.
 *   - The cut comes out of ABSORPTION (`sigmaA`), not scattering, because
 *     absorption is the wavelength-selective term. `sigmaT = sigmaA + sigmaS`
 *     still holds exactly, and `Kd` is scaled by the same absorption ratio, so
 *     the internal derivations in the per-type notes below stay consistent.
 *   - The RATIOS between water types are preserved, so the biomes stay
 *     distinguishable from each other.
 *
 * Consequence for the descent, stated plainly: OCEANIC_CLEAR's red 1% DEPTH
 * goes 18 m -> 68 m. The "colour-draining descent the game is built around"
 * still happens, over roughly four times the depth. If a future change wants
 * the original arc back, restore the `sigmaA[0]` values in the per-type notes
 * and recompute `sigmaT[0] = sigmaA[0] + sigmaS[0]` and `Kd[0]`.
 *
 * With OCEANIC_CLEAR the daylight (Kd) 1% depths are now R 68 m, G 80 m,
 * B 182 m.
 *
 * ===========================================================================
 * `surfaceSigmaA` / `surfaceKd`: THE SAME WATER WITH ITS JERLOV RED PUT BACK,
 * FOR THE ONE TERM THAT IS LOOKED AT FROM OUTSIDE THE MEDIUM. 2026-08-02.
 * ===========================================================================
 *
 * The red cut above is an art deviation that exists to keep SUBMERGED OBJECTS
 * LEGIBLE, so it belongs on the two quantities that decide legibility: the
 * SIGHT PATH (`sigmaT`, via applyViewRayWater) and the ILLUMINANT (`Kd`, via
 * daylightAtDepth). Both are about seeing a thing THROUGH water.
 *
 * The WATER-LEAVING RADIANCE - what a flyover reads looking down at the sea -
 * lights nothing and hides nothing. It is pure colour, and it is exactly the
 * term the cut destroyed. `oceanBodyColour()` is
 * `mix(deepWaterReflectance(), seabedAlbedo, exp(-2*Kd*h))`: a lagoon is
 * turquoise because 2h of red `Kd` eats the red out of bright carbonate sand.
 * At REEF_TURQUOISE's cut values red `Kd` is 0.0791 against a GREEN 0.0725 -
 * the medium is achromatic in the red-green axis, so nothing seen through it
 * can be turquoise at any depth. Measured over reef sand, hue and HSV
 * saturation: 2 m went 186 deg / 0.61 -> 245 deg / 0.06, 4 m 193 / 0.86 ->
 * 235 / 0.20, 8 m 204 / 0.97 -> 234 / 0.43. `deepWaterReflectance()` took the
 * same hit through `sigmaA`: red 0.00414 -> 0.01554, 3.75x, so the open-ocean
 * asymptote lost its blue too.
 *
 * So the surface pair is the pre-cut column and NOTHING ELSE CHANGES. Only the
 * RED entry ever differs from the live one; green and blue are byte-identical,
 * and `tools/test-terrain.mjs` section 10c asserts that rather than trusting
 * it. COASTAL_GREEN, MURKY_PARTICULATE and VENT_SMOKE are identical in all
 * three: 2ba914e re-authored COASTAL_GREEN wholesale rather than red-cutting
 * it, and left the other two alone, so there is no earlier red to restore.
 *
 * Consumed by exactly three functions, all unreachable with the eye in water:
 * `oceanBodyColour()` and `shallowWaterColour()`, and `deepWaterReflectance()`
 * which only those two call. `RENDER.SURFACE_BODY_PHYSICAL_RED` is the mix, so
 * 0 reproduces the cut build byte for byte and the whole change bisects on one
 * number. NOT used by beamLoss - see ocean_surface.wgsl for why that one has
 * to stay on the live art coefficient. The consumer set being CLOSED is what
 * makes the split safe, and `tools/test-ocean.mjs` §12 greps the shader for
 * exactly that set, so it cannot leak onto a submerged view even by accident.
 *
 * ===========================================================================
 * `snowMultiplier` AND `g` ARE ALSO THE TWO PARTICULATE-CHARACTER AXES.
 * 2026-08-05.
 * ===========================================================================
 *
 * Marine snow is the only particle-like effect in the renderer, and until this
 * change its DENSITY was the only thing about it that varied: size, spacing,
 * sink speed, albedo, clumping and shell count were WGSL compile-time
 * constants, so across the six deep stations the whole field took exactly two
 * values (0.500 and 0.275). It is now resolved per frame by `snowCharacter()`
 * in `render/shaders/common/water.wgsl`, from two numbers this table already
 * authored and the renderer already uploaded:
 *
 *   `snowMultiplier` -> HOW MUCH, and HOW MINERAL. Reaches the shader as the
 *     sprung `frame.waterBottom.w`. It stays the density scalar it always was,
 *     and it additionally darkens the mote toward grey rock flour, speeds its
 *     sink, extends the field's reach and buys the sixth shell. Normalised
 *     over three octaves from 0.5, because the authored values span 60:1 and a
 *     linear map puts all six carried types in the bottom eighth.
 *   `g` -> HOW COARSE. Reaches the shader as the sprung `frame.waterSigmaS.w`.
 *     This is not a repurposing: the Henyey-Greenstein asymmetry of a
 *     suspension IS set by particle size against wavelength, which is why
 *     marine-snow aggregates sit at g ~ 0.93-0.94 and fine mineral dust lower.
 *     Reading it here means a water cannot claim large aggregates optically and
 *     then draw fine dust. Remapped over 0.90-0.94, the band the six carried
 *     types occupy; everything below clamps to "fine" and is separated from its
 *     neighbours by load instead.
 *
 * Both are already sprung on `RENDER.WATER_BLEND_TAU` by
 * `main.js._updateWaterColumn`, so the character inherits the spring for free
 * and cannot pop at a biome edge the way the SNAPPED seabed albedo beside it
 * does. The mote's COLOUR comes from a third axis that is per BIOME rather than
 * per water type - `BIOMES[].fogTint`, fourteen authored values, applied at
 * unit Rec709 luma so it rotates colour without changing energy. That is the
 * same discipline `renderer.js` enforces on the haze, and for the same measured
 * reason: pale colour underwater is a REFLECTANCE problem, and a brighter mote
 * is only a whiter one.
 *
 * CONSEQUENCE FOR EDITING THIS TABLE: moving `g` now moves the picture in two
 * places, the phase function and the mote size. That is intended, and it is why
 * `g` was chosen over inventing a second art scalar that could then disagree
 * with the optics. Moving `snowMultiplier` likewise moves five things at once.
 * `snowCharacter()` carries the resolved ladder for all six carried types, so
 * what a change does is readable before it is measured, and
 * `SNOW_CHARACTER = 0` in that file returns the single neutral row that restores
 * every pre-2026-08-05 particulate parameter.
 *
 * AND THE FIELD THESE NUMBERS FEED IS NOT THE ONE THEY USED TO. The same change
 * found that `pass/underwater.wgsl` had been dithering each shell's sampling
 * distance per pixel, on a lattice coordinate whose sensitivity to that distance
 * is the camera's ABSOLUTE world position over the shell distance squared - so
 * the lattice moved by hundreds of cells between neighbouring pixels and no mote
 * in this project's history was ever a coherent particle. Measured over one
 * open-water crop, 517 blobs of mean area 1.53 px became 6 of mean area 339 px.
 * Anyone re-tuning `snowMultiplier` against a memory of what the old field
 * looked like will be tuning against a speckle pattern that no longer exists;
 * marineSnow()'s docstring carries the derivation and the A/B.
 */
export const WATER_TYPES = {
  OCEANIC_CLEAR: {
    id: 0, name: 'Oceanic (Jerlov IA)',
    // 2026-08-18: a sigmaS cut was tried here and REVERTED - test-ocean's
    // deepWaterReflectance docstring check failed, because the water-leaving
    // radiance of the open ocean derives its backscatter from THIS sigmaS and
    // fell to half the Jerlov clear-ocean values (0.07/0.5/2.5%). The
    // submerged veil is governed by RENDER.VEIL_DIFFUSE_GAIN instead, which
    // the above-water column never reads.
    sigmaA: [0.0664, 0.0520, 0.0165],
    sigmaS: [0.0110, 0.0160, 0.0250],
    sigmaT: [0.0774, 0.0680, 0.0415],
    Kd: [0.0674, 0.0576, 0.0253],
    surfaceSigmaA: [0.2520, 0.0520, 0.0165],
    surfaceKd: [0.2559, 0.0576, 0.0253],
    g: 0.924, ior: 1.3390, density: 1025,
    // 2026-08-17 clarity pass: deepTint saturated (was [0, 0.012, 0.070]) -
    // the open-ocean background blue the veil cut now exposes.
    deepTint: [0.000, 0.016, 0.085],
    snowMultiplier: 1.00, visibility: 94.3,
  },
  /**
   * Jerlov IB, not the Jerlov II this used to be.
   *
   * Jerlov II is turbid coastal water: sigmaT_blue 0.144/m puts 0.32% beam
   * transmittance at 40 m, and the seabed's own light equalled the veiling
   * in-scatter at 6.7 m in blue. Measured whole-frame luminance contrast at the
   * reef floor was 0.168, against 0.636 with clear oceanic water substituted -
   * which is the featureless pale gradient the shallows used to render as. Real
   * clear tropical reef water is Jerlov I/IB.
   *
   * Derivation, so it is checkable rather than tuned: the Kd targets are the
   * Austin & Petzold revision of Jerlov IB (0.037 at 460 nm, 0.073 at 550,
   * 0.274 at 610). a(460) and a(550) are Pope & Fry pure water plus CDOM;
   * b(550) = 0.062 with a lambda^-1 particle slope gives the sigmaS column;
   * b_b = 0.0184*b via this file's own waterBackscatterFraction(0.918); and
   * Kd = (a + b_b)/0.83 reproduces the target column. sigmaT is exactly
   * sigmaA + sigmaS. Contrast sighting range goes 27.2 -> 37.9 m.
   */
  /**
   * 2026-08-17 clarity pass: sigmaS cut ~45% and sigmaA rebalanced so blue
   * sigmaT lands at 0.0742 (2%-contrast visibility 37.9 -> 52.7 m) while the
   * single-scattering albedo falls (blue 0.719 -> 0.553) - i.e. the water got
   * CLEARER and its fog got DARKER at the same time, which is the
   * art-direction reference's signature. Kd untouched: the daylight-with-depth arc was
   * right; the complaint was the sight path. deepTint saturated toward
   * teal-royal for the far body colour the veil now lets through.
   *
   * NOTE ON THE OLDER DERIVATION COMMENT ABOVE: Kd was deliberately kept at
   * the pre-pass column, so the historical "Kd = (a + b_b)/0.83" fit no
   * longer reproduces this row's blue channel - with sigmaA blue at 0.0332
   * the implied b_b would be negative. The sight path is now authored
   * independently of that Jerlov fit; the fit text is retained as history of
   * where the pre-pass numbers came from, and its "27.2 -> 37.9 m" sighting
   * figure is superseded by 52.7.
   */
  REEF_TURQUOISE: {
    id: 1, name: 'Reef Shallows (Jerlov IB)',
    // 2026-08-18 drastic pass: sigmaS cut again (~33%) with sigmaA raised to
    // hold sigmaT - fade identical, veil dimmer, albedo blue 0.553 -> 0.377.
    sigmaA: [0.0673, 0.0641, 0.0462],
    sigmaS: [0.0200, 0.0230, 0.0280],
    sigmaT: [0.0873, 0.0871, 0.0742],
    Kd: [0.0791, 0.0725, 0.0366],
    surfaceSigmaA: [0.2480, 0.0641, 0.0462],
    surfaceKd: [0.3000, 0.0725, 0.0366],
    g: 0.918, ior: 1.3392, density: 1026,
    deepTint: [0.004, 0.058, 0.125],
    snowMultiplier: 0.75, visibility: 52.7,
  },
  /**
   * NO LONGER JERLOV 3C, AND THE REASON IS THAT ITS CARRIERS COULD NOT LIVE IN
   * IT. This was the contradiction CLAUDE.md recorded and could not resolve
   * without a content decision: Kelp Forest is authored `depth: [14, 78]` and
   * Boulder Field `[34, 140]`, and Jerlov 3C's green daylight is at 1% by
   * 25.2 m - so the biomes were specified across a depth range their own water
   * makes unreachable. Worse for the picture, 3C's green `sigmaT` of 0.365/m is
   * a **2.74 m** 1/e beam range: the kelp anchor photographed a flat green
   * rectangle with 174 creature agents inside 20 m and **6 of them visible**,
   * and the frame's scene contribution was measured at 0.00% of red and green
   * and 2.6e-5 % of blue - optically, it contained no kelp at all.
   *
   * Resolved in favour of the CONTENT, because the depth bands feed generation
   * and the water does not. The coefficients are now a mildly turbid green
   * coastal water rather than a Jerlov 3C estuary:
   *   - the SCATTERING column is cut ~3x, which is what made it opaque;
   *   - absorption keeps GREEN lowest, which is what makes it read green -
   *     at 20 m the transmittance ratio is G/B 1.8 and G/R 18. G/B was
   *     4.5 on the first cut and the frame read as neon rather than as water:
   *     when one channel outruns the other two the picture collapses onto it,
   *     which is the same failure the blue biomes had, in green;
   *   - green `Kd` 0.183 -> 0.0754 puts the 1% daylight depth at **61 m**
   *     against 25.2, so Kelp Forest's authored [14, 78] band is finally lit;
   *   - 2%-contrast visibility 10.7 -> **34.0 m**, i.e. a forest you can see
   *     across rather than a wall.
   *
   * NOTE THE KNOCK-ON, because it is load-bearing: `waterTypeAt`'s ceiling is
   * `COLUMN_OPTICAL_DEPTH / min(Kd)`, so this type's reach goes 35.9 m -> 87 m
   * and it now actually covers its carriers instead of being rejected off them
   * onto the open-ocean fallthrough. That was the other half of the same
   * contradiction. `tools/test-terrain.mjs` section 10b asserts three-channel
   * nesting over every pair in use and is the guard.
   */
  COASTAL_GREEN: {
    id: 2, name: 'Kelp Coastal (green inshore)',
    // 2026-08-17 clarity pass: green sigmaS 0.080 -> 0.060, so green sigmaT
    // 0.115 -> 0.095 (2%-contrast visibility 34.0 -> 41.2 m) and the green
    // veil dims with it. Absorption untouched - green stays lowest, so the
    // G/B transmittance ratio that keeps this water reading green (not neon)
    // survives. deepTint darkened toward bottle-green for the far field.
    // 2026-08-18 drastic pass: green sigmaS 0.060 -> 0.042 (green sigmaT
    // 0.077, 2%-contrast visibility 41.2 -> 50.8 m) and red/blue sigmaS
    // trimmed with sigmaA holding their sigmaT - a longer, darker, deeper
    // green. Absorption ordering unchanged: green stays lowest.
    sigmaA: [0.2100, 0.0350, 0.0750],
    sigmaS: [0.0500, 0.0420, 0.0700],
    sigmaT: [0.2600, 0.0770, 0.1450],
    Kd: [0.2310, 0.0754, 0.0900],
    // Re-authored wholesale by 2ba914e rather than red-cut: no earlier red.
    surfaceSigmaA: [0.2100, 0.0350, 0.0750],
    surfaceKd: [0.2310, 0.0754, 0.0900],
    g: 0.905, ior: 1.3395, density: 1024,
    deepTint: [0.010, 0.058, 0.030],
    snowMultiplier: 1.25, visibility: 50.8,
  },
  MURKY_PARTICULATE: {
    id: 3, name: 'Silt Basin',
    sigmaA: [0.9000, 0.5500, 0.6800],
    sigmaS: [1.6000, 1.7000, 1.7500],
    sigmaT: [2.5000, 2.2500, 2.4300],
    Kd: [1.4600, 1.1450, 1.2925],
    // Untouched by 2ba914e: no earlier red.
    surfaceSigmaA: [0.9000, 0.5500, 0.6800],
    surfaceKd: [1.4600, 1.1450, 1.2925],
    g: 0.862, ior: 1.3400, density: 1028,
    deepTint: [0.055, 0.050, 0.042],
    snowMultiplier: 6.00, visibility: 1.74,
  },
  BRINE: {
    id: 4, name: 'Hypersaline Brine',
    sigmaA: [0.1713, 0.1400, 0.0300],
    sigmaS: [0.0400, 0.0500, 0.0700],
    sigmaT: [0.2113, 0.1900, 0.1000],
    Kd: [0.1750, 0.1575, 0.0545],
    surfaceSigmaA: [0.6500, 0.1400, 0.0300],
    surfaceKd: [0.6640, 0.1575, 0.0545],
    g: 0.800, ior: 1.3900, density: 1198,
    deepTint: [0.010, 0.045, 0.055],
    snowMultiplier: 0.20, visibility: 39.1,
  },
  ABYSSAL_VOID: {
    id: 5, name: 'Abyssal Void',
    sigmaA: [0.0606, 0.0480, 0.0140],
    sigmaS: [0.0060, 0.0080, 0.0120],
    sigmaT: [0.0666, 0.0560, 0.0260],
    Kd: [0.0612, 0.0508, 0.0182],
    surfaceSigmaA: [0.2300, 0.0480, 0.0140],
    surfaceKd: [0.2321, 0.0508, 0.0182],
    g: 0.930, ior: 1.3402, density: 1032,
    deepTint: [0.000, 0.003, 0.014],
    snowMultiplier: 0.55, visibility: 150.5,
  },
  VENT_SMOKE: {
    id: 6, name: 'Vent Plume',
    sigmaA: [3.4000, 3.1000, 2.9000],
    sigmaS: [5.2000, 4.9000, 4.6000],
    sigmaT: [8.6000, 8.0000, 7.5000],
    Kd: [5.2200, 4.8150, 4.5100],
    // Untouched by 2ba914e: no earlier red.
    surfaceSigmaA: [3.4000, 3.1000, 2.9000],
    surfaceKd: [5.2200, 4.8150, 4.5100],
    g: 0.780, ior: 1.3410, density: 1010,
    deepTint: [0.090, 0.035, 0.010],
    snowMultiplier: 12.0, visibility: 0.52,
  },
  /**
   * ===========================================================================
   * THE DEEP FAMILY. ABYSSAL_VOID'S ABSORPTION, WITH A REAL PARTICLE LOAD.
   * ===========================================================================
   *
   * Three rows follow - HADAL_SUSPENSION, VENT_HAZE and NEPHELOID - and this
   * block is the argument they share. Each one has its own docstring for what
   * only it decides; what is written here is true of all three and is the reason
   * they are a family rather than three unrelated waters.
   *
   * THE LOAD IS THE ONLY VARIABLE, AND THE THREE ROWS DIFFER IN ITS SPECTRUM AS
   * WELL AS ITS AMOUNT. HADAL_SUSPENSION and VENT_HAZE add 3x and 5x
   * ABYSSAL_VOID's own molecular scattering, which is a lambda^-4.3 column and
   * therefore strongly blue; NEPHELOID adds a NEUTRAL one, because its particles
   * are mineral silt tens of times larger than the wavelength. That distinction
   * is not decoration - it is the whole reason a third row buys a different
   * picture rather than a brighter one. See NEPHELOID for the measurement.
   *
   * WHY THE DEEP NEEDED A SECOND WATER AT ALL. `ABYSSAL_VOID` is the CLEAREST
   * water in this table - sigmaS blue 0.0120 against REEF_TURQUOISE's 0.0741
   * (6.17x) and COASTAL_GREEN's 0.0950 (7.92x) - and it ran 100.000% of the
   * seabed past 260 m, measured over a 40 m grid inside r <= 2900 (16,235 wet
   * samples: 619 columns in 260-320 m, 1,154 in 320-420, 1,207 in 420-520 and
   * 5,024 past 520, every one of them ABYSSAL_VOID). In-scatter is LINEAR in
   * sigma_s, so at 0.0120 a lamp cannot build a visible beam: the suit lamp at
   * the trench wall is an unbounded soft bloom with no near edge, because there
   * is nothing in the water for it to light. Below TRUE_DARK_DEPTH the composite
   * collapses to `scene * waterTransmittance()`, so past 520 m the ONLY thing a
   * water type still decides is sigmaT on the sight path and sigmaS in the
   * froxel's lamp term - which is exactly what these two types change.
   *
   * ALL THREE START FROM ABYSSAL_VOID'S ABSORPTION COLUMN, and that is what
   * makes them a family. HADAL_SUSPENSION and VENT_HAZE keep it outright -
   * sigmaA is byte-identical in green and blue and differs only in
   * HADAL_SUSPENSION's blue (0.0144 against 0.0140, the clay's own weak blue
   * absorption). NEPHELOID adds its particles' own non-algal absorption on top,
   * which is 9x stronger in blue than in red and is derived at its own site.
   * sigmaT is sigmaA + sigmaS exactly, in every channel, as everywhere else in
   * this table.
   *
   * ---------------------------------------------------------------------------
   * LOAD-BEARING: Kd BLUE IS PINNED BIT-EQUAL TO ABYSSAL_VOID'S 0.0182 ON ALL
   * FOUR DEEP ROWS, AND THE ONLY THING HOLDING `test-terrain` SECTION 10b GREEN
   * IS THAT FLOATING-POINT TIE. DO NOT NUDGE IT.
   *
   * `tools/test-terrain.mjs:526` asserts the pin over
   * `['ABYSSAL_VOID', 'HADAL_SUSPENSION', 'VENT_HAZE']` and that list PREDATES
   * NEPHELOID, so the fourth row's blue is pinned by this comment and by nothing
   * else. Adding `'NEPHELOID'` to that array is the whole fix and it is a
   * one-word edit; it was left out of the commit that added the row only because
   * that commit was scoped to `constants.js` and `biomes.js` while another agent
   * held `test-terrain.mjs`. Do it.
   * ---------------------------------------------------------------------------
   *
   * `biomes.js:_columnCeiling` is `COLUMN_OPTICAL_DEPTH / min(Kd)`, and section
   * 10b asserts that preferring a type with a DEEPER ceiling over one with a
   * shallower one only ever BRIGHTENS - the BRINE-against-COASTAL_GREEN
   * inversion documented above is the failure it exists to catch. Its loop opens
   * with `if (ceilingOf(A) <= ceilingOf(B)) continue`, so an EQUAL ceiling exits
   * before that test in both directions. These types have equal ceilings only
   * because `min(Kd)` is blue and blue is identical to the digit; their RED
   * (0.0734, 0.0856, 0.0782 against 0.0612) and GREEN (0.0584, 0.0660, 0.0593
   * against 0.0508) are LARGER, so one ULP on the blue turns the tie into a
   * strict inequality and section 10b starts judging a crossover that does not
   * exist. If a future
   * author wants a different blue Kd here, the honest fix is to teach section
   * 10b the whole ordering, not to re-round this number.
   *
   * THE FAILURE IS ASYMMETRIC, AND ONLY ONE DIRECTION IS CAUGHT BY THE CROSSOVER
   * LOOP. The advice above stands unchanged; what follows is which half of it the
   * test actually enforces. Re-measured 2026-08-05 by re-running section 10b's
   * own algorithm with this blue nudged - all FOUR rows currently author the
   * identical bit pattern 0x3f92a305532617c2:
   *   HADAL_SUSPENSION  -1 ULP -> 33 darkening samples, section 10b RED
   *   HADAL_SUSPENSION -64 ULP -> 33 darkening samples, RED
   *   HADAL_SUSPENSION  +1 ULP ->  0 darkening samples, the loop stays GREEN
   *   HADAL_SUSPENSION +64 ULP ->  0 darkening samples, GREEN
   * DOWN is the red direction because a SMALLER blue is a DEEPER ceiling: it
   * opens a band above ABYSSAL_VOID's 361.4 m in which the rule prefers this row,
   * and this row's red and green are the larger ones. UP gives it a SHALLOWER
   * ceiling, so the pair that gets judged is ABYSSAL_VOID over HADAL_SUSPENSION -
   * and ABYSSAL_VOID is clearer in all three channels, so that crossover
   * genuinely brightens and the loop has nothing to report.
   *
   * Three consequences, which are the reason this is written down. An UPWARD
   * nudge is caught ONLY by section 10b's explicit bit-equality assertion, so
   * that assertion is not a restatement of the crossover test and deleting it
   * would leave half the pin enforced by nothing. VENT_HAZE is carried by no
   * biome, so it is not in the crossover loop's `carried` set at all: nudged
   * EITHER way it reports 0 darkening samples, and the equality assertion is the
   * only guard it has - see its own docstring below. And NEPHELOID IS carried,
   * so it is in the crossover set and inherits exactly the same asymmetric,
   * ULP-scale downward coverage measured above and nothing more; it is not in
   * the assertion's list, so the upward half is unguarded for it. That is the
   * whole reason for the "do it" above.
   *
   * The red direction's arithmetic, so 33 samples is not read as a large effect:
   * at -1 ULP the crossover band collapses onto 361.4 m and all 33 samples trip
   * the LUMA arm at x0.999929, a 0.007% deficit carried entirely by red and green
   * at 2.5e-10 and 1.1e-8 of the surface - both far under section 10b's own 1e-6
   * CHANNEL_LIVE gate, so the per-channel arm does not fire at all. It is a real
   * violation of the assertion as written and it is invisible in a frame, which is
   * exactly why the honest fix is the one above and not a re-round.
   *
   * HADAL_SUSPENSION vs OCEANIC_CLEAR IS A REAL CROSSOVER AND IT IS WHY SECTION
   * 10b IS NO LONGER A PER-CHANNEL NESTING TEST. 361.4 m against 260.0 m, so the
   * rule really does prefer this water where it would otherwise have taken the
   * open ocean, and this row's red and green Kd are LARGER. Measured across that
   * band it delivers 6.32x - 13.01x OCEANIC_CLEAR's daylight LUMA while running
   * 0.21x - 0.11x in red and 0.81x - 0.75x in green - on channels where
   * OCEANIC_CLEAR itself is already down to 2.4e-8 and 3.1e-7 of the surface at
   * the shallow end of that band. The old per-channel
   * rule would have scored those two extinct ratios as an inversion. It is now
   * judged on delivered luma plus any channel still LIVE in the loser, which
   * BRINE fails on both arms and this row passes on both.
   *
   * The pin is also defensible on its own terms, which is why it is a pin and
   * not a fudge: Kd is DIFFUSE attenuation of daylight with depth, and forward
   * scattering at g >= 0.9 keeps a scattered photon travelling down. Tripling
   * sigma_s therefore costs the blue daylight almost nothing while it triples
   * what a lamp has to scatter off. Red and green do rise, because there the
   * absorption already dominates and the extra path length is paid for.
   *
   * deepTint is the asymptotic radiance of infinitely deep water and is NOT
   * free: it is the similarity-theory diffuse reflectance of a semi-infinite
   * medium, `R = (1 - sqrt(1 - w')) / (1 + sqrt(1 - w'))` with the reduced
   * single-scattering albedo `w' = (1 - g)w / (1 - g w)` and `w = sigmaS/sigmaT`,
   * evaluated on the PHYSICAL red (`surfaceSigmaA`) rather than the art-cut one.
   * That expression reproduces ABYSSAL_VOID's authored tint to the third decimal
   * (computed 0.000 / 0.0029 / 0.0146 against authored 0.000 / 0.003 / 0.014),
   * which is what licenses using it for the rest of the family. It is NOT a
   * general formula for this table - OCEANIC_CLEAR and REEF_TURQUOISE sit about
   * 2.5x above it - so do not propagate it to the shallow types.
   *
   * `visibility` is `ln(50) / min(sigmaT)`, the 2%-contrast sighting range, and
   * reproduces every other row in this table to the printed digit.
   *
   * `snowMultiplier` IS THE SCATTERING, so it scales with it rather than being
   * picked: the marine snow and sigma_s are two descriptions of the same
   * suspended load, and `underwater.wgsl` reads this value directly as the snow
   * density (`frame.waterBottom.w`). ABYSSAL_VOID's 0.55 times the 3x and 5x
   * gives 1.65 and 2.75. That is also what the Abyssal Plain's authored palette
   * asks for - "pale sediment, marine snow" - and it is the near-field structure
   * that a lamp needs something to light.
   */
  HADAL_SUSPENSION: {
    id: 7, name: 'Hadal Suspension',
    sigmaA: [0.0606, 0.0480, 0.0144],
    sigmaS: [0.0180, 0.0240, 0.0360],
    sigmaT: [0.0786, 0.0720, 0.0504],
    Kd: [0.0734, 0.0584, 0.0182],
    // Newly authored, never red-cut - but the family's PHYSICAL red is
    // ABYSSAL_VOID's 0.2300, not this row's 0.0606, so the surface column
    // carries it. Without that the open sea read from the air over the abyssal
    // plain would be a different colour from the sea over the trench wall,
    // which is the one place the two waters must agree: they are the same
    // absorption. surfaceKd keeps this row's own Kd/sigmaA ratio (1.2112).
    surfaceSigmaA: [0.2300, 0.0480, 0.0144],
    surfaceKd: [0.2786, 0.0584, 0.0182],
    g: 0.921, ior: 1.3403, density: 1035,
    deepTint: [0.002, 0.010, 0.045],
    snowMultiplier: 1.65, visibility: 77.6,
  },
  /**
   * CARRIED BY NO BIOME, AND SINCE THE PLACES LAYER LANDED THAT NO LONGER MEANS
   * DEAD: this row's named consumer is the EMBERTHROAT place in
   * `world/places.js`, whose 90 m VENT_HAZE field (with a 12 m VENT_SMOKE core)
   * `waterTypeAt` returns through its authored-place override. The deposit
   * that used to stand here - "the commit that lands src/world/places.js MUST
   * either point the Geothermal place at this row or DELETE it and
   * WATER_BOTTOM_ALBEDO[8] in that same commit" - was paid in that commit, in
   * the first of its two permitted ways. The optics are unchanged: 5x
   * ABYSSAL_VOID's sigma_s at the same absorption is a 52.9 m sighting range
   * against 150.5 - enough for a vent cone to sit in its own haze at 40 m -
   * and NOTHING in it is warm, because a plume is grey particulate and the
   * colour comes from the emitters (Emberthroat's are the ventChimney /
   * tubeworm / ventSulphur props).
   *
   * THE PROOF CONDITIONS THE DEPOSIT NAMED, and where each stands:
   * (1) `waterTypeAt` returns VENT_HAZE on a non-zero share of columns:
   * MEASURED offline at the default seed - VENT_HAZE from r = 8 m to ~75 m of
   * the Emberthroat centre (-2104, -1680), VENT_SMOKE inside ~7 m, the
   * surrounding HADAL_SUSPENSION/ABYSSAL_VOID mix past the 60-90 m feather.
   * (2) The packed `frame.waterBottom` reads [0.06, 0.05, 0.04] rgb / 2.75 w
   * at an arrival inside the footprint - the packing that proves the id
   * reached the renderer. Measured via probe on the tree that landed places;
   * re-measure it if the packing path is ever touched.
   * (3) A lamp at 40 m shows a bounded halo at the 52.9 m sighting range -
   * a LOOKED-AT claim, standing on the places shot list
   * (`tools/shots/places.json`), not on this comment.
   *
   * THE OBVIOUS SHORTCUT WAS TAKEN AND REJECTED, WITH A REASON THAT IS NOT
   * ABOUT TASTE, and the history is kept because it still binds renames.
   * Canyon Wall needed a water of its own on 2026-08-05 and this row was the
   * standing candidate: claim it, rename it, done. Two things stopped it.
   * Optically it is the wrong medicine - 5x ABYSSAL_VOID's BLUE-weighted
   * molecular scattering is more of exactly the term that was already blowing
   * the canyon frame out, where that frame needed the same energy in a NEUTRAL
   * spectrum (see NEPHELOID). And mechanically, the key `VENT_HAZE` is
   * hard-coded in `test-terrain.mjs:526`, so renaming it from a change scoped
   * to this file would have made section 10b throw on
   * `WATER_TYPES[undefined].Kd`. It is now ALSO named by `world/places.js`, so
   * a rename has three sites to keep in step.
   *
   * The dead-data class this row nearly joined has cost the project twice - a
   * `fogTint` blended and read by nothing made every underwater frame
   * monochromatic, and `waterTypeAt` exported with no importer was a measured
   * 14.8x error in scene luminance at 118 m. MURKY_PARTICULATE remains the one
   * WATER_TYPES row with no consumer; BRINE is carried by the Halocline Mirror
   * place and VENT_SMOKE by Emberthroat's core.
   */
  VENT_HAZE: {
    id: 8, name: 'Vent Haze',
    sigmaA: [0.0606, 0.0480, 0.0140],
    sigmaS: [0.0300, 0.0400, 0.0600],
    sigmaT: [0.0906, 0.0880, 0.0740],
    // Its scattering excess over ABYSSAL_VOID is exactly 2x HADAL_SUSPENSION's,
    // so its diffuse increment is the same 2x: [0.0122, 0.0076, 0] doubled onto
    // ABYSSAL_VOID's Kd, with the blue pinned by the clause above.
    Kd: [0.0856, 0.0660, 0.0182],
    surfaceSigmaA: [0.2300, 0.0480, 0.0140],
    surfaceKd: [0.3249, 0.0660, 0.0182],
    g: 0.900, ior: 1.3405, density: 1022,
    deepTint: [0.003, 0.020, 0.089],
    snowMultiplier: 2.75, visibility: 52.9,
  },
  /**
   * CANYON WALL'S OWN WATER. A NEPHELOID LAYER: RESUSPENDED MINERAL SILT, WHOSE
   * SCATTERING IS NEUTRAL WHERE EVERY OTHER WATER IN THIS TABLE IS BLUE.
   *
   * WHY THIS ROW EXISTS, and it is a correction to the earlier water assignment
   * rather than an addition to it. That pass put Abyssal Plain AND Canyon Wall
   * in HADAL_SUSPENSION. Those two were already the second-worst confusion in
   * the 14-anchor tour and one water made it worse: measured hue x saturation
   * cosine `canyon x abyssal` 0.9772 -> 0.9868. That pass's own headline win -
   * `abyssal x trenchWall` 0.9975 -> 0.9383 - is real and is kept; it was simply
   * paid for on a different pair. Canyon Wall gets its own column here and
   * Abyssal Plain keeps HADAL_SUSPENSION, so the win stands and the bill does
   * not.
   *
   * THE IDENTITY IS AUTHORED, NOT INVENTED. `DESIGN/01` section 7.3 gives
   * `sea_sunken_canyon` a turbidity well above the plain's (tauS 3.60 against
   * 1.10) with the note "Nepheloid layer near the floor", and section 7.8
   * describes the place as "banded strata in grey and near-black ... floored by
   * a pale nepheloid haze that hides the bottom". A nepheloid layer is a real
   * oceanographic object - a bottom-hugging cloud of sediment resuspended by the
   * near-bed current - and its optics are not the marine snow of the plain.
   *
   * TWO TERMS CARRY THE DEEP FRAME AND BOTH OF THEM ARE BLUE BECAUSE OF THE
   * WATER, NOT BECAUSE OF THE ROCK. Measured off the delivered canyon frame:
   * 58.5% of its cropped pixels sit in the TOP saturation octile and 9.5% in the
   * bottom one - a saturated blue field around a blown white core, and nothing in
   * between. The plain's frame has the same two piles, which is why the two
   * scored 0.982 against each other. The piles come from
   *   (a) the lamp's in-scattered halo, `sigmaS * exp(-sigmaT * s)`, which is
   *       what `froxel_inject.wgsl` evaluates, and
   *   (b) the lamp-lit seabed, whose red/blue ratio over the there-and-back
   *       path is `exp(-2 * (sigmaT.r - sigmaT.b) * s)`.
   * BOTH are decided by this row and NEITHER is decided by the biome's albedo,
   * which is the knob the identity table reaches for first.
   *
   * IT MOVES THEM ALONG THE HUE AXIS, NOT THE SATURATION AXIS, AND THE EARLIER
   * WORDING HERE CLAIMED THE OPPOSITE. Saturation was the plan - "pale nepheloid
   * haze" asks for it - and it is unreachable from this file at these depths;
   * the measurement that killed it is in the delivered-frame clause below. What
   * this row can actually move is the CHROMATICITY of both terms, and it does:
   * the halo's hue stops walking towards blue with distance because the medium
   * has stopped having a colour.
   *
   * THE SCATTERING SPECTRUM IS FLAT, AND THAT IS TERM (a). Seawater's own
   * scattering is molecular, lambda^-4.3, and every deep row inherits
   * ABYSSAL_VOID's strongly blue [0.0060, 0.0080, 0.0120]; multiplying it, as
   * HADAL_SUSPENSION and VENT_HAZE do, keeps that blue bias and only turns it
   * up. Nepheloid particles are lithogenic silt at roughly 4-10 um, tens of
   * times the wavelength, so they are in the diffraction-dominated Mie regime
   * and their scattering is spectrally FLAT. The load is therefore added as a
   * NEUTRAL +0.0213/m in all three channels rather than as a multiplier.
   *
   * THE ABSORPTION IS 9x STRONGER IN BLUE THAN IN RED, AND THAT IS TERM (b).
   * Non-algal particulate absorption is the standard exponential
   * `a(lambda) = a(443) * exp(-0.011 * (lambda - 443))`, which over this table's
   * 650/550/450 nm gives 0.111 : 0.333 : 1.000. The load is authored by ONE
   * number, a(450), and everything else on this row follows from it: the
   * scattering increment is `0.0140 * a(450)/0.0300` because the same particles
   * scatter and absorb, so the two columns cannot be tuned apart.
   *
   * THE LOAD IS SET AT THE ACHROMATIC LANDMARK, a(450) = 0.0456/m, AND THAT IS
   * WHY IT IS THAT NUMBER AND NOT A TASTE. Water's own absorption is RED-
   * weighted and mineral silt's is BLUE-weighted, so as the load rises there is
   * exactly one concentration at which they cancel and the medium stops having a
   * colour at all. It is here: a_NAP = [0.0051, 0.0152, 0.0456] over
   * ABYSSAL_VOID's sigmaA gives `sigmaT` = [0.0930, 0.0925, 0.0929], a spread of
   * 0.0005 - 0.54% of its own mean. `sigmaT.r - sigmaT.b` goes ABYSSAL_VOID
   * 0.0406, HADAL_SUSPENSION 0.0282, this row 0.0001: a factor of 139 off the
   * first draft's 0.0139. Below the landmark the medium is blue like every other
   * water in the table; above it the ordering INVERTS and it transmits red best,
   * like a turbid coastal water. The landmark is the defensible place to stand
   * because it is the one value the arithmetic picks rather than the eye, and
   * because a colourless medium is exactly what `DESIGN/01` 7.8's "banded strata
   * in GREY and near-black" needs - the rock cannot read grey through a medium
   * that tints it. It also lands on the authored optics: `visibility` is 42.3 m
   * against `sea_sunken_canyon`'s authored 41.4, 2.2%, on both the min-channel
   * and the green-channel convention, and the scattering is 3.71x ABYSSAL_VOID's
   * against an authored `tauS` of 3.60.
   *
   * WHAT THE PAIR BUYS, computed off these coefficients against
   * HADAL_SUSPENSION's, in HSV saturation of the colour those two terms deliver
   * (the first draft's a(450) = 0.0300 column is kept beside it, because it is
   * what shows that the landmark is a different KIND of answer and not more of
   * the same one):
   *
   *          halo (a)                            lit seabed (b)
   *   s      NEPH   was    HADAL_SUS   luma      NEPH   was    HADAL_SUS
   *    3 m   0.180  0.262  0.541       x1.16     0.003  0.080  0.156
   *    8 m   0.181  0.312  0.601       x1.04     0.008  0.199  0.363
   *   15 m   0.181  0.376  0.672       x0.88     0.015  0.341  0.571
   *   30 m   0.183  0.493  0.785       x0.62     0.030  0.566  0.816
   *
   * (`luma` is this row's halo Rec709 luma as a fraction of HADAL_SUSPENSION's at
   * the same range). READ THE COLUMN, NOT THE ROW: the halo's saturation is now
   * FLAT at 0.18 over a 10x range sweep where HADAL_SUSPENSION's climbs 0.541 ->
   * 0.785, because a colourless medium cannot redden with distance. That is the
   * whole difference between the two waters and it is the one a frame shows.
   * Energy is held: 1.16x at 3 m falling to 0.62x at 30 m, so this cannot be
   * scored as a variety win bought by turning the lights up - the failure mode
   * `fogTint`'s unit-luma normalisation exists to prevent and which this table
   * has no such mechanism for.
   *
   * Kd IS THE COLUMN AND sigmaT IS THE SIGHT PATH, AND THAT DISTINCTION IS WHY
   * THIS ROW IS ADMISSIBLE AT ALL. A nepheloid layer is a floor-hugging skin of
   * order 20 m under 400-900 m of clear hadal water, and at those depths the
   * daylight is already gone - `aphoticFactor` is 0.1136 at 478 m, 0.0209 at the
   * shipped anchor's 502.8 m, 0.0001 at its seabed and 0.00 past
   * TRUE_DARK_DEPTH's 520 - so the layer attenuates no daylight that had not
   * already been attenuated. Kd is therefore ABYSSAL_VOID's Kd CHANNEL FOR
   * CHANNEL, not the family's scattering-excess increment: HADAL_SUSPENSION's
   * marine snow falls through the WHOLE column and pays for it in red and green,
   * this row's silt does not fill the column at all. That is a real difference
   * between the two loads and not a convenience - though it is also, honestly,
   * what keeps `min(Kd)` at the pinned blue. See THE CEILING below.
   *
   * THE ENGINE HAS ONE WATER MASS PER COLUMN, so "a layer" is a description of
   * where these coefficients came from and not of what the renderer does: a
   * diver at 60 m over the canyon reads the same sigmaT as one at 470 m. A
   * genuine layer needs a depth-dependent sigma_t in `common/water.wgsl`, which
   * is a shader change and is not this. Canyon Wall's own band starts at 120 m,
   * so nothing shallow is affected in practice.
   *
   * THE CEILING. `min(Kd)` is blue at 0.0182, pinned bit-equal to the rest of
   * the deep family, so this row's `_columnCeiling` is 361.4 m and ties with
   * theirs - which is what keeps `test-terrain` section 10b's crossover loop
   * exempting the whole family from a comparison there is no band to make. The
   * gated column peaks at 330.3 m, so the ceiling never binds and Canyon Wall's
   * water is reachable at every depth it occupies. Raise this blue past 0.019915
   * and the ceiling falls under that peak and the assignment becomes dead data -
   * the exact trap item 1.4 was written to avoid. That is a window of 9%, which
   * is why the clause above resolves the layer's own contribution to ZERO on the
   * aphotic argument rather than to "a small number": there is no room here for
   * a small number.
   *
   * WHICH WAY THIS PUSHES THE BLOOM: TOWARDS IT, BY 16% IN THE NEAR FIELD, AND
   * THE ANCHOR ABSORBED IT. Total scattering is 3.71x ABYSSAL_VOID's by Rec709
   * luma against HADAL_SUSPENSION's 3.00x, so the halo is 16% BRIGHTER than the
   * plain's at 3 m (and 38% dimmer at 30 m, because the extinction rises with
   * it). A nepheloid layer is MORE turbid than the plain - 42.3 m of 2%-contrast
   * sighting range against 77.6 - and is meant to be looked at from ABOVE,
   * hiding a bottom the eye is not sitting on, which is `DESIGN/01` 7.8's
   * composition exactly. Measured at the raised anchor the extra near-field
   * energy is not a problem: the Canyon Wall frame's median luminance moved
   * 0.1214 -> 0.1371, p95/p05 12.82 -> 11.36 against a floor of 4.0, and flat
   * fraction 0.1381 -> 0.1502 against a ceiling of 0.55. It would have been a
   * problem at the OLD anchor 2.7 m off the floor, and that is the constraint
   * this row has on where Canyon Wall arrives.
   *
   * WHAT IT DELIVERED, on `tools/test-variety.mjs --only canyon,abyssal,
   * trenchWall` with an in-process A/B (this row's first draft against this one,
   * same three anchors, same tour shape, 2026-08-05):
   *
   *   canyon x abyssal      0.98214 -> 0.86801     (the acceptance, target < 0.95)
   *   canyon x trenchWall   0.93357 -> 0.72495
   *   abyssal x trenchWall  0.94073 -> 0.94193     neither frame changed at all
   *   canyon hue entropy    1.9639  -> 2.0316      bits, and it must not fall
   *   canyon near-mass      0.1716  -> 0.1718      the composition is untouched
   *
   * The abyssal and trench-wall frames measure 0.99997 and 1.00000 against
   * themselves across that A/B - neither carries this water - so the +0.0012 on
   * their pair is the instrument, not this change. That pair reads 0.93997 on a
   * full 14-anchor tour and 0.940-0.942 on this subset in BOTH arms; it is a
   * knife-edge and a single reading of it is a lottery read.
   *
   * BE HONEST ABOUT WHAT MOVED, because the cosine moved far more than the frame
   * did. The tour's histogram is 32 hue bins of 11.25 deg, and the canyon's haze
   * sat 3 deg above the 213.75 deg bin edge. What this change did is push
   * 158,000 pixels of lamp-lit haze across that edge: bin 19 went 466k -> 308k
   * and bin 18 124k -> 264k, while the two bins' own mean hues barely moved
   * (217.0 -> 216.3 and 212.0 -> 211.7). Re-binning the delivered frame with an
   * artificial hue offset measures the margin directly: -2 deg 0.646, 0 deg
   * 0.871, +1 deg 0.953. So the result is REPRODUCIBLE (self-cosine 0.99999) but
   * it is not robust to a degree of hue from anywhere else in the chain, and a
   * future change that moves the deep grade will move this number without
   * touching this row.
   *
   * AND SAY WHY IT COULD NOT BE BOUGHT ON THE SATURATION AXIS, which was the
   * obvious plan and is the one "pale nepheloid haze" asks for. At 502 m the
   * depth grade (`passes/post.js` GRADE_KEYS) multiplies scene red by 0.376 and
   * then raises the display code to the power 1.245. Measured through it: taking
   * `sigmaT.r - sigmaT.b` from 0.0139 to 0.0001 - a factor of 139 in the medium's
   * red bias, i.e. the largest move this row can make - changed the delivered
   * saturation of the dominant haze bin from 0.960 to 0.969. It went the WRONG
   * WAY and by nothing. Below about 400 m the delivered chroma is the grade's,
   * not the water's, and no coefficient here can reach it.
   *
   * THE SAME ARITHMETIC EXPLAINS THE PILE THAT WILL NOT MOVE AT ALL. Evaluating
   * the grade on a scene value of ZERO at 502.8 m gives display code (1, 21, 51),
   * hue 216.0, saturation 0.980 - which is hue bin 19, saturation bin 7. At
   * 758 m it gives (3, 22, 54) and at 970.8 m (5, 22, 55): the SAME bin. 167,000
   * of the canyon frame's 466,000 pixels in that bin sit at that floor, and the
   * abyssal and trench-wall frames have their own. That is CLAUDE.md's abyss-QA
   * finding - "the depth grade's black lift on a scene value of zero, and it is a
   * CONSTANT" - showing up as a common-mode term in the variety metric itself.
   * The deep anchors will keep scoring alike against each other until something
   * puts light in their far field; it is not a water-type problem and it cannot
   * be fixed from this file.
   *
   * CHANGING THESE COEFFICIENTS RESOLVES A DIFFERENT ANCHOR, and that was NOT
   * expected - the brief for this change said coefficients "change no terrain
   * vertex byte, so there is nothing to re-shoot but the frames". They do.
   * `world/biome_anchors.js:framingView` sizes its whole landmark scan from
   * `contrastRange(waterTypeAt(...))` = max over channels of
   * `ln(1 + sigmaT/sigmaS)/sigmaT`, which sets the arrival eye height and the
   * burial and tower windows; `entities/teleport.js`'s `arrivalOptics().range` is
   * the same derivation and must stay equal to it. This row takes that range
   * 19.64 m -> 15.95 m and the Canyon Wall anchor is UNCHANGED at 502.8 m - but
   * an intermediate draft at a(450) = 0.0540 took it to 14.51 m and a DIFFERENT
   * candidate won: 380.1 m, near-mass 0.1717 -> 0.0000, hue entropy 1.96 -> 1.19,
   * i.e. the whole composition gain that raising this anchor had just bought.
   * Any future edit to this row's sigmaT or sigmaS must re-run the tour and check
   * the anchor's DEPTH and near-mass, not only its colour. `biome_anchors.js`'s
   * own docstring still quotes 19.6 m for this water and is now stale.
   *
   * `snowMultiplier` IS DELIBERATELY OFF THE SCATTERING TRACK HERE, and it is
   * the one place this row breaks the family's rule on purpose. Everywhere else
   * the value scales with sigma_s because marine snow and sigma_s are two
   * descriptions of one suspended load; ABYSSAL_VOID's 0.55 times 3.71 would be
   * 2.04, which would make the canyon snow HEAVIER than the plain's 1.65 - the
   * one thing the plain's authored palette owns outright. But this load is
   * mineral silt at 4-10 um, three orders of magnitude below the drawn flake,
   * and it reads as HAZE - which is sigma_s - and not as flakes. 0.90 is a load
   * that is present and unresolvable. It also keeps the falling-snow read as the
   * Abyssal Plain's own, which is what its authored palette asks for.
   *
   * `deepTint` is the similarity-theory diffuse reflectance the family block
   * derives, `R = (1 - sqrt(1 - w')) / (1 + sqrt(1 - w'))` with
   * `w' = (1 - g)w / (1 - g w)` and `w = sigmaS / (surfaceSigmaA + sigmaS)`,
   * evaluated on the PHYSICAL red. Computed 0.0017 / 0.0069 / 0.0082 - nearly
   * NEUTRAL, and DARKER in blue than ABYSSAL_VOID's, which is the same
   * particulate absorption showing up in the asymptote. The same expression
   * reproduces ABYSSAL_VOID's authored tint at 0.0005 / 0.0029 / 0.0146 and
   * HADAL_SUSPENSION's at 0.0015 / 0.0097 / 0.0450, which is what licenses it.
   * `visibility` is `ln(50) / min(sigmaT)` as everywhere else, and because
   * `sigmaT` is achromatic here the min-channel and the GREEN-channel convention
   * `DESIGN/01` 7.3 uses agree to the printed digit: 42.3 m on both, against its
   * authored 41.4 for `sea_sunken_canyon`. That 2.2% is the closest independent
   * check this row has, and it is a check on the LOAD - the one authored number
   * the achromatic landmark had no say in.
   *
   * `g` 0.940 is above the family's 0.900-0.930 for the same reason the
   * scattering is flat: diffraction by particles far larger than the wavelength
   * is more forward-peaked than molecular scattering. It is worth naming because
   * a head-mounted lamp is a BACKSCATTER geometry - the in-scattered halo along
   * the view ray is at cos ~ -1 - where Henyey-Greenstein falls as
   * (1 - g^2) / (1 + g)^3, so 0.921 -> 0.940 takes about 25% off the halo's
   * near-axis brightness at no cost to anything else.
   */
  NEPHELOID: {
    id: 9, name: 'Nepheloid Layer',
    // ABYSSAL_VOID's absorption plus a_NAP = [0.0051, 0.0152, 0.0456].
    sigmaA: [0.0657, 0.0632, 0.0596],
    // ABYSSAL_VOID's molecular scattering plus a NEUTRAL +0.0213/m mineral load.
    sigmaS: [0.0273, 0.0293, 0.0333],
    sigmaT: [0.0930, 0.0925, 0.0929],
    // ABYSSAL_VOID's Kd, CHANNEL FOR CHANNEL, because a bottom layer is below
    // the daylight it would otherwise attenuate. See the Kd clause above; the
    // blue is additionally PINNED and section 10b's tie depends on it.
    Kd: [0.0612, 0.0508, 0.0182],
    // The family's PHYSICAL red is ABYSSAL_VOID's 0.2300 plus this row's own
    // mineral red absorption of 0.0033 - the same particles absorb in both
    // columns. surfaceKd keeps ABYSSAL_VOID's Kd/sigmaA ratio (1.00913), which
    // is the right one to keep precisely because the live Kd is its Kd.
    surfaceSigmaA: [0.2351, 0.0632, 0.0596],
    surfaceKd: [0.2372, 0.0508, 0.0182],
    g: 0.940, ior: 1.3404, density: 1034,
    deepTint: [0.002, 0.007, 0.008],
    snowMultiplier: 0.90, visibility: 42.3,
  },
  /**
   * BULB GROVE'S OWN WATER, AND THE ONE ROW IN THIS TABLE WHOSE RED IS AN
   * ART DEVIATION ALL THE WAY DOWN. 2026-08-18, by explicit user instruction
   * ("if there's issues with coloring in the rendering pipeline we can
   * consider changing that even if physics say we lose red after a few
   * meters - it's more important to have beautiful vibrant colors").
   *
   * THE PROBLEM IT SOLVES IS ARITHMETIC, NOT TASTE. The grove's subject is a
   * purple organism (see the grove's art-direction reference) at 16-36 m, and
   * purple is R+B. Under REEF_TURQUOISE's live Kd the daylight at the 28 m
   * anchor is R 0.109 / B 0.359 of the surface - a 3.3x spread - so ANY
   * authored purple reflectance delivers R/B ~ 0.1-0.3: periwinkle blue,
   * measured on the first delivered frames. Fluorescence (the engine's one
   * red-restoring mechanism) is per-ROW, and the tree needs three separated
   * colour zones in ONE mesh (pale trunk / purple fur / ice-blue emissive
   * fruit), so the pigment path cannot carry it either. The only lever left
   * is the illuminant, which is this row: red Kd 0.0580 puts red daylight at
   * 2.4x REEF_TURQUOISE's at the 28 m anchor and red sigmaT 0.0620 keeps it
   * on the sight path - enough red for the R+B mix that purple IS. (A first
   * draft went further and crushed green as well; the coefficient comment on
   * the row records why that delivered a pink-sand monochrome and was pulled
   * back.)
   *
   * SCOPED TO ONE BIOME ON PURPOSE. REEF_TURQUOISE was not touched because
   * three other biomes carry it and their look is measured and shipped; this
   * row's only carrier is biome 16 (Bulb Grove), which is also its named
   * consumer under the dead-data rule.
   *
   * The surface pair is byte-identical to the live column ("no earlier red
   * to restore" - the row was authored wholesale, the COASTAL_GREEN
   * precedent). Consequence, stated so it is read as intent: from the air
   * this lagoon's water-leaving radiance keeps its red, so the grove reads
   * as a pale violet-tinged pool against the surrounding turquoise - the
   * one place on the map where the sea itself marks the biome under it.
   *
   * visibility is ln(50)/min(sigmaT) as everywhere else: 3.912/0.0550 =
   * 71.1 m, on the RED channel - the one water whose clearest channel is
   * red. deepTint leans violet for the same reason the fogTint does.
   */
  LAGOON_VIOLET: {
    id: 10, name: 'Bulb Lagoon (violet clear)',
    // SECOND DRAFT, judged on delivered frames. The first draft crushed
    // GREEN (Kd [0.0430, 0.0740, 0.0182]) to make the light itself violet -
    // and it worked too well: with light R/G 2.4, the biome's white sand
    // delivered PINK and the whole frame collapsed onto one lavender hue.
    // The reference is turquoise-blue WATER and WHITE sand around purple
    // TREES, so the purple has to live on the ALBEDO, not the illuminant:
    // R and G are now equal (delivered sand is neutral under them, faintly
    // blue under the surviving blue), and MESH_PALETTE.BULB_PURPLE is
    // authored magenta-heavy so the blue-shifted light delivers it at the
    // reference's violet. What this row still buys over REEF_TURQUOISE is
    // red at 2.4x its daylight and 1.8x its sight path - enough for the
    // R+B mix that purple IS, without enough R excess to stain the sand.
    // Round 3 (adversarial review: "deep navy, reads as twilight"): sigmaS
    // raised in green and blue - the reference's water is LUMINOUS cyan, and
    // luminosity is in-scatter - with sigmaA trimmed so the sight path stays
    // long. The anchor also moved 30 -> ~22 m in the same round; the two
    // together are what buy the sunlit-aquarium read.
    sigmaA: [0.0320, 0.0280, 0.0160],
    sigmaS: [0.0220, 0.0340, 0.0460],
    sigmaT: [0.0540, 0.0620, 0.0620],
    // Blue Kd is PINNED BIT-EQUAL TO THE DEEP FAMILY'S 0.0182, and the pin is
    // load-bearing the same way theirs is: min(Kd) is blue, so this row's
    // ceiling ties the deep four at exactly 361.4 m and test-terrain section
    // 10b's crossover loop exits on equality against them, while every
    // SHALLOWER-ceiling type it IS judged over (OCEANIC_CLEAR 260,
    // REEF_TURQUOISE 179.7, COASTAL_GREEN 87.2) loses to it in luma with no
    // live channel extinguished - a red-transmitting water can only ever be
    // passed over FOR, never passed over, without darkening. Two drafts
    // proved the constraint the hard way: blue 0.0360 (ceiling 182.7) had
    // OCEANIC_CLEAR extinguishing this row's live red over 182.7-260 m (81
    // darkening samples, worst x3.97), and 0.0253 (tie with OCEANIC_CLEAR at
    // 260) moved the same fault onto HADAL_SUSPENSION over 260-361.4 m (9
    // samples, worst x6.15). No real column carries this water past ~46 m -
    // the only carrier's depth band ends at 36 m - so the pin spends nothing
    // in a frame, and the extra blue daylight it implies at 20-36 m is the
    // direction the biome wants anyway.
    Kd: [0.0580, 0.0580, 0.0182],
    // Authored wholesale, never red-cut: no earlier red to restore.
    surfaceSigmaA: [0.0320, 0.0280, 0.0160],
    surfaceKd: [0.0580, 0.0580, 0.0182],
    g: 0.916, ior: 1.3392, density: 1026,
    // Cyan-teal, saturated: the far-field body colour. Review round 2 still
    // read [0.014, 0.070, 0.120] as steel-navy; the green share carries the
    // turquoise.
    deepTint: [0.008, 0.088, 0.150],
    // 0.18 after two review rounds called 0.70 a blizzard and 0.35 heavy
    // snowfall; the reference water is clean.
    snowMultiplier: 0.18, visibility: 72.4,
  },
  /**
   * PLATTER FOREST'S OWN WATER, AND THE SECOND ART-DEVIATION ROW after
   * LAGOON_VIOLET, under the same explicit 2026-08-18 user instruction
   * ("if there's issues with coloring in the rendering pipeline we can
   * consider changing that even if physics say that we lose red after a few
   * meters. it's more important to have beautiful vibrant colors").
   *
   * THE PROBLEM IT SOLVES: the biome's subject, in its art-direction
   * reference, is a SUNLIT emerald-teal hall at
   * 88-124 m - platter columns silhouetted in luminous green water. Under any
   * physical shallow water (COASTAL_GREEN Kd green 0.0754) the 97 m anchor
   * column keeps 0.07% of surface green: full twilight, and no exposure trick
   * recovers a hue that is not there. The illuminant is the only lever, so
   * this row's GREEN Kd is authored at the deep family's 0.0182 - 17.1% of
   * surface green at the anchor, a bright emerald key - with blue at 0.0240
   * so the delivered daylight sits at G/B ~ 1.8, teal rather than blue.
   *
   * THE GREEN Kd IS PINNED BIT-EQUAL TO THE DEEP FAMILY'S 0.0182, and the pin
   * is load-bearing exactly as LAGOON_VIOLET's blue pin is: min(Kd) sets the
   * classification ceiling, 0.0182 ties it to the deep four (and LAGOON) at
   * exactly 361.4 m, and test-terrain 10b's crossover loop exits on equality
   * against all of them, judging this row only against the SHALLOWER-ceiling
   * types (OCEANIC_CLEAR 260, REEF_TURQUOISE 179.7, COASTAL_GREEN 87.2) - all
   * of which it out-transmits channel for channel over their live bands, so
   * being preferred over them only ever brightens. Blue 0.0240 is UNDER
   * OCEANIC_CLEAR's 0.0253 blue on purpose: OCEANIC's blue is still LIVE
   * (>= 1e-5) through the whole 260-361.4 m crossover, and a larger blue here
   * would darken a live channel and go red in 10b.
   *
   * SCOPED TO ONE BIOME. Its only carrier is biome 17 (Platter Forest), which
   * is also its named consumer under the dead-data rule. Red is NOT kept the
   * way LAGOON_VIOLET keeps it - the reference's warm accents are the glowing
   * platter rims, which are EMISSIVE and carry their own orange - so red Kd
   * stays near-physical and the water spends its whole deviation on green.
   *
   * The surface pair is authored wholesale (no earlier red cut to restore).
   * From the air the forest reads as a deep emerald pool against the
   * surrounding blue - the second place on the map where the sea itself marks
   * the biome under it.
   *
   * visibility is ln(50)/min(sigmaT) as everywhere else: 3.912/0.0620 =
   * 63.1 m, on the GREEN channel - the one water whose clearest channel is
   * green by that margin. deepTint leans emerald for the same reason.
   */
  PLATTER_TEAL: {
    id: 11, name: 'Platter Forest (emerald hall)',
    // The scattering split is where the reference's LUMINOSITY lives: the
    // water glows green-cyan (sigmaS green/blue high) while absorption is
    // pushed onto red, so a column at 40 m is a teal silhouette in bright
    // haze rather than a grey shape in murk.
    // Round 2 (first delivered frames): red Kd 0.0560 -> 0.0280 and red
    // sigmaT 0.0920 -> 0.0780. At 0.0560 the 97 m column kept 0.4% red and
    // every rust/orange ALBEDO in the biome delivered grey-green - the
    // forest was a monochrome mint hall. 0.0280 keeps 6.6% red at the
    // anchor (R/G 0.38), which is what lets encrusted trunks read umber
    // while the water itself stays emerald. This deepens the art deviation,
    // not the mechanism: red still dies 3x faster than green.
    // Round 3: sigmaS cut ~50% at HELD sigmaT (absorption takes the
    // difference). The first frames equalised a 1.4% trunk against a 14%
    // floor into one mint wash - with 15% of surface green still alive at
    // 106 m (the deviation), even short sightlines in-scattered past every
    // albedo. Same fade, darker fog: the project's own clarity-pass move.
    // Round 4 (adversarial review): green/blue sigmaS back up ~40% at held
    // sigmaT - the round-3 cut fixed the near-field wash but flattened the
    // distance haze to a poster wall; the reference's ranks of columns step
    // back a tone lighter each. The floor-albedo cut in the same round is
    // what keeps the near field from re-milking.
    sigmaA: [0.0680, 0.0360, 0.0560],
    sigmaS: [0.0100, 0.0260, 0.0180],
    sigmaT: [0.0780, 0.0620, 0.0740],
    // Green PINNED bit-equal to the deep family's 0.0182 - see the header.
    Kd: [0.0280, 0.0182, 0.0240],
    surfaceSigmaA: [0.0680, 0.0360, 0.0560],
    surfaceKd: [0.0280, 0.0182, 0.0240],
    g: 0.912, ior: 1.3392, density: 1026,
    // Emerald-TEAL far-field body: blue went 0.078 -> 0.052 (round 2, the
    // cyan-mint frames) -> 0.072 (round 4, the review's "flat poster-green
    // wall" - the reference haze is teal, blue clearly present).
    deepTint: [0.008, 0.096, 0.072],
    // Light motes: the reference frame carries visible drifting particles and
    // small fish, but the water itself is clean.
    snowMultiplier: 0.40, visibility: 63.1,
  },
  /**
   * KELP FOREST'S OWN WATER, AND THE THIRD ART-DEVIATION ROW after
   * LAGOON_VIOLET and PLATTER_TEAL, under the same explicit vibrant-beats-
   * physics user instruction (2026-08-18, restated for this biome: "if
   * there's issues with coloring in the rendering pipeline we can consider
   * changing that even if physics say that we lose red after a few meters.
   * it's more important to have beautiful vibrant colors").
   *
   * THE PROBLEM IT SOLVES: the biome's subject, in its art-direction
   * reference, is a SUNLIT deep-emerald forest at
   * 68 m - massive dark trunks silhouetted floor-to-out-of-frame in luminous
   * green water with warm fruit lights. Under COASTAL_GREEN (Kd green
   * 0.0754) the 68 m column keeps 0.6% of surface green: twilight, and the
   * delivered forest read as grey-on-grey past 40 m of floor depth. The
   * illuminant is the only lever (the fruit's warmth is EMISSIVE and carries
   * itself), so this row's GREEN Kd is authored at the deep family's 0.0182
   * - 29% of surface green at 68 m, a bright emerald key over the whole
   * [28, 78] band - with blue at 0.0240 so the daylight sits green-of-teal.
   *
   * THE GREEN Kd IS PINNED BIT-EQUAL TO THE DEEP FAMILY'S 0.0182, exactly as
   * PLATTER_TEAL's is and for the same load-bearing reason: min(Kd) sets the
   * classification ceiling, 0.0182 ties it to the deep four (and LAGOON, and
   * PLATTER) at exactly 361.4 m, and test-terrain 10b's crossover loop exits
   * on equality against all of them, judging this row only against the
   * shallower-ceiling types (OCEANIC_CLEAR 260, REEF_TURQUOISE 179.7,
   * COASTAL_GREEN 87.2) - all of which it out-transmits channel for channel
   * over their live bands (blue 0.0240 under OCEANIC's 0.0253 for the same
   * reason PLATTER's is), so being preferred over them only ever brightens.
   *
   * THE SIGHT PATH KEEPS THE PHYSICAL RED LOSS ON PURPOSE. Red sigmaT stays
   * at COASTAL_GREEN's 0.2600, which is what test-ocean section 15 pins
   * ("without neutralising red loss") and what the reference actually shows:
   * distant trunks are pure green silhouettes, and the fruit clusters shade
   * from vivid orange near the eye to yellow-green at range. The deviation
   * is spent entirely on green DAYLIGHT, not on red sight.
   *
   * SCOPED TO ONE BIOME. Its only carrier is biome 5 (Kelp Forest), which is
   * also its named consumer under the dead-data rule. Boulder Field, the
   * other former COASTAL_GREEN forest, KEEPS COASTAL_GREEN untouched - the
   * split is the whole point: the kelp forest goes emerald without moving a
   * pixel of any other biome.
   *
   * The surface pair is authored wholesale (no earlier red cut to restore).
   * From the air the forest reads as a deep bottle-green band against the
   * blue - the third place where the sea itself marks the biome under it.
   *
   * visibility is ln(50)/min(sigmaT) as everywhere else: 3.912/0.0700 =
   * 55.9 m, on the GREEN channel.
   */
  KELP_EMERALD: {
    id: 12, name: 'Kelp Forest (emerald deep)',
    // Green is the clear channel on the sight path (silhouettes hold to
    // ~56 m), blue dies a little faster so the haze reads GREEN rather than
    // cyan. Red sigmaT 0.2600 -> 0.1600 in round 4: at 0.26 the gold fruit
    // lost its red inside 20 m and delivered LIME (playtest: "the fruits
    // should be nice glowing yellow/gold, ours is greenish"); 0.16 keeps
    // ~25% red at 20 m so a gold emitter still reads gold at cluster range,
    // while test-ocean 15's red-loss gate (T50 < 3%) still holds at 2.7%.
    // sigmaS is green-dominant: the luminous mid-water of the reference is
    // in-scattered green daylight, not a bright fog.
    // sigmaS channels are deliberately NEAR-FLAT (round 6): `chroma: 0.12`
    // collapses every vector toward its MIN channel, and the first cut's
    // sigmaS ([0.0100, 0.0300, 0.0140]) collapsed to 0.0100 - the in-scatter
    // GUTTED itself, the water went glass-clear, and the blue sky burned
    // through the 55 m upward view. With the channels close, the flattened
    // medium keeps ~80% of its scattering, and the haze's COLOUR rides the
    // biome fogTint (green) rather than the spectrum - which is the whole
    // division of labour this row's chroma deviation sets up.
    sigmaA: [0.1360, 0.0400, 0.0590],
    sigmaS: [0.0240, 0.0300, 0.0260],
    sigmaT: [0.1600, 0.0700, 0.0850],
    // Green PINNED bit-equal to the deep family's 0.0182 - see the header.
    // Red Kd is HIGH on purpose (near-physical, unlike LAGOON/PLATTER): the
    // first delivered frames at Kd red 0.0300 metered a nearly WHITE key
    // (R 22% / G 40% / B 30% of surface at 50 m) and the sand feather's
    // bright albedo read as a swimming pool. The reference's daylight is
    // green to the bone; the only warm content is the EMISSIVE fruit, which
    // carries its own red. 0.1500 puts red daylight at 0.05% by 50 m.
    // Blue sits just under OCEANIC_CLEAR's 0.0253 (the 10b crossover bound,
    // PLATTER's reasoning) - G/B ~1.6 at the 68 m reference depth, with the
    // rest of the green carried by deepTint, fogTint and the veil.
    Kd: [0.1500, 0.0182, 0.0250],
    surfaceSigmaA: [0.1360, 0.0400, 0.0590],
    surfaceKd: [0.1500, 0.0182, 0.0250],
    g: 0.905, ior: 1.3395, density: 1024,
    // Deep bottle-emerald far-field body: green carries it, blue is present
    // but clearly subordinate (the reference haze is forest green, not teal),
    // red a trace so the darkest water is not a pure primary.
    deepTint: [0.006, 0.085, 0.038],
    // MEDIUM CHROMATICITY 0.12 (round 5; the field is this row's invention,
    // sprung with the column and multiplied under RENDER.WATER_CHROMA at the
    // renderer's pack site - every other row omits it and is bit-identical).
    // Delivered evidence forced it: at full spectral chroma the sight path
    // and daylight column repainted EVERYTHING green - three rounds of
    // darker tints and gold pigment never reached the frame (the kelp-deep
    // shot's rounds 2-4 are near-identical). At 0.12 the medium is nearly
    // spectrally flat - objects keep their authored colour, gold fruit
    // photographs gold - while the emerald look rides the EXEMPT carriers:
    // deepTint, the biome fogTint x VEIL_CHROMA haze, and the plants' own
    // dark-olive tint. deepTint is exempt from the collapse by design, so
    // the water body itself stays deep green at any setting.
    // 0.12 -> 0.30 (round 9, delivered basin frames): at 0.12 the light was
    // so spectrally flat that the 114 m floor photographed bright CYAN-BLUE
    // and the water lost its green gloom; 0.30 restores a green bias to the
    // daylight while keeping enough red on the sight path that the gold
    // fruit still reads gold at cluster range (38% red at 20 m).
    chroma: 0.30,
    // The reference carries visible drifting motes in the god rays.
    snowMultiplier: 1.0, visibility: 55.9,
  },
  /**
   * SUNKEN DUNES' OWN WATER, AND THE FOURTH ART-DEVIATION ROW after
   * LAGOON_VIOLET, PLATTER_TEAL and KELP_EMERALD, under the same explicit
   * vibrant-beats-physics user instruction (2026-08-18, restated for this
   * biome: "if there's issues with coloring in the rendering pipeline we can
   * consider changing that even if physics say that we lose red after a few
   * meters. it's more important to have beautiful vibrant colors", plus
   * "make sure we have good visibility to see it coming at us").
   *
   * THE PROBLEM IT SOLVES: the biome's subject, in its art-direction
   * reference, is a leviathan HUNTING GROUND - a
   * huge red-and-pale predator visible at 60-100 m in clear, luminous
   * azure water over pale sand. The biome sits at 318-342 m, the deepest
   * vibrant biome by 2.5x, chosen exactly one step ABOVE the aphotic knee
   * (aphoticFactor is 1.0 to 319.8 m and still 0.96 at 342 m), because
   * below 520 m daylight is structurally zero in three agreeing
   * implementations and no water row can buy it back.
   *
   * THE Kd TRIPLE IS THE DEEPEST DEVIATION IN THE TABLE, AND THE FIRST
   * DRAFT PROVED THE PIN COULD NOT LIGHT IT. This row first shipped with
   * blue pinned to the deep family's 0.0182 (nearly-equal triple [0.0224,
   * 0.0203, 0.0182]) and the delivered frames were NAVY TWILIGHT: at 330 m
   * that blue keeps 0.25% of surface daylight, the auto-exposure clamped
   * at its 25.6x ceiling with scene luminance 0.0019-0.0033, and the
   * emissive fans were the only content in frame. No pin-respecting
   * spectrum can fix that - the exponential owns it. So the whole triple
   * is authored BELOW the deep family: blue 0.0054 keeps 15.3% of surface
   * blue at the 348 m floor, the same delivered key strength PLATTER_TEAL
   * gets at its 97 m anchor, with the spread still sized in ln-units
   * against the column (round 2 widened G toward B for turquoise: G/B
   * 0.61, R/B 0.23 at the floor): a luminous azure-turquoise key with
   * enough red that the leviathan's crimson dorsum reads dark-red rather
   * than black at range (its full red returns under the suit and vessel
   * lamps inside 20 m).
   *
   * WHY BREAKING THE 0.0182 PIN IS SAFE HERE, when LAGOON/PLATTER/KELP
   * each kept it: the pin's job is the crossover tie, and test-terrain
   * 10b's rule is DIRECTIONAL - a deeper-ceiling type is judged over the
   * crossover band only on whether it OUT-TRANSMITS every live channel of
   * the type it is preferred over. This row's ceiling (6.578/0.0054 =
   * 1218 m) is the largest in the table, so it is judged as the deep arm
   * of every pairing, and every channel here is strictly under every
   * carried row's corresponding channel wherever that channel is live
   * (the binding cases: blue 0.0054 < 0.0182 against the deep four and
   * LAGOON to their 632 m blue-live edge; green < PLATTER/KELP's 0.0182;
   * red < PLATTER's 0.0280 to its 411 m live edge) - preferring this
   * water can only ever brighten, which is the invariant the pin exists
   * to protect, held directly instead of by tie. The PINNED bit-equality
   * assertion covers exactly the four deep rows and is untouched.
   *
   * SIGHT PATH: the user's own acceptance test is "see it coming". Raw
   * visibility is ln(50)/min(sigmaT) = 3.912/0.052 = 75.2 m on BLUE, and
   * the biome's sightDensity 0.62 stretches the effective 2%-contrast
   * range to ~121 m - a 45 m animal becomes a legible silhouette at
   * ~100 m and resolves its two-tone colour inside ~40 m. The arena is a
   * 550 m-wide open plateau, so clarity at that range is framing, not
   * emptiness (the kelp lesson about clarity past content range does not
   * bite: the content IS the long sightline).
   *
   * SCOPED TO ONE BIOME. Its only carrier is biome 18 (Sunken Dunes),
   * which is also its named consumer under the dead-data rule. The deep
   * family, the terraces and the ossuary keep their own water untouched.
   *
   * The surface pair is authored wholesale (no earlier red cut to
   * restore). From the air the shoal reads as a pale azure disc against
   * the abyssal ink - the fourth place where the sea itself marks the
   * biome under it.
   */
  DUNE_AZURE: {
    id: 13, name: 'Sunken Dunes (azure shoal)',
    // Blue is the clear channel on the sight path; green close behind so
    // the near haze reads cyan-of-blue; red dies ~1.3x faster, enough to
    // keep the "underwater" read without executing the reference's warm
    // accents. The scattering split leans blue-green: the reference water
    // is LUMINOUS, and luminosity is in-scatter, but the sigmaS share is
    // kept modest so the 100 m sightline stays a silhouette gradient
    // rather than a bright fog (PLATTER round 3's same-fade-darker-fog
    // move, applied from the start).
    // Round 2 (delivered frames): sigmaS green/blue up ~30% at held sigmaT
    // (absorption gives back the difference) - the round-1 water read as a
    // FLAT COBALT WALL with no luminosity gradient in any direction, and
    // luminosity is in-scatter; the g 0.914 forward lobe is what turns the
    // extra sigmaS into a bright solar quarter rather than uniform milk.
    sigmaA: [0.0510, 0.0260, 0.0120],
    sigmaS: [0.0150, 0.0300, 0.0400],
    sigmaT: [0.0660, 0.0560, 0.0520],
    // Below the deep family on every channel - see the header for why the
    // 0.0182 pin could not light this biome and why breaking it is safe.
    // Round 2: green 0.0075 -> 0.0068 (G/B 0.50 -> 0.61 at the 348 m
    // floor) - the flat-cobalt review round again; the reference daylight
    // is azure-TURQUOISE and the green content is what separates them.
    Kd: [0.0096, 0.0068, 0.0054],
    surfaceSigmaA: [0.0510, 0.0260, 0.0120],
    surfaceKd: [0.0096, 0.0068, 0.0054],
    g: 0.914, ior: 1.3392, density: 1027,
    // Turquoise-leaning azure far-field body (round 2: blue 0.135 / green
    // 0.062 delivered the cobalt poster wall; the reference haze holds
    // clearly visible green). Red floor 0.030 (round 3): the round-2 open
    // water measured saturation 1.000 with red LITERALLY zero, which is
    // what a poster wall is; the reference azure is visibly desaturated a
    // few points.
    deepTint: [0.030, 0.088, 0.118],
    // 0.30 -> 0.15: the round-1 motes delivered as bright fairy lights
    // against the dark column and generated false monster-contacts.
    snowMultiplier: 0.15, visibility: 75.2,
  },
  /**
   * PELAGOS STATION'S OWN WATER, AND THE FIFTH ART-DEVIATION ROW after
   * LAGOON_VIOLET, PLATTER_TEAL, KELP_EMERALD and DUNE_AZURE, under the same
   * standing vibrant-beats-physics user instruction (2026-08-18, restated for
   * the station 2026-08-26: "we need nice vibrant colors... can you make it
   * look nice even if it's not accurate according to water physics?").
   *
   * THE FIRST ROW IN THIS FAMILY CARRIED BY A SITE RATHER THAN A BIOME. Its
   * only consumer is `HABITAT_SITE.water` in world/habitat_site.js, which is
   * also its named consumer under the dead-data rule; no BIOMES row names it
   * and none should. The disc is what scopes it - see the derivation there.
   *
   * THE PROBLEM IT SOLVES, MEASURED OFF DELIVERED FRAMES, NOT REASONED. The
   * demo's station segment (demo-output/cut11, frames 26-30) photographed as
   * one saturated green: whole-frame RGB 7.5 / 157.9 / 81.1 at HSV saturation
   * 0.953, seabed 0.1 / 129.0 / 48.1 at 0.999, the station's own hull 21.2 /
   * 175.7 / 129.1. Red was not dim, it was GONE, and with one channel dead
   * every surface in frame collapses onto the water's hue.
   *
   * THE CAUSE WAS A CLASSIFICATION THE SITE LOSES, NOT A TINT. `materialAt`
   * returns Sand Plains at raw weight 1.0000 at the station centre - the
   * clearing IS sand, and Sand Plains authors REEF_TURQUOISE. But
   * `waterTypeAt` averages the centre with six ring taps at
   * WORLD.WATER_TYPE_SMOOTH_RADIUS (24 m), and every tap lands on the Boulder
   * Field slopes ringing the 62 m clearing: smoothed weights are boulders
   * 0.589 against sand 0.411, so the COASTAL_GREEN pool takes the column.
   * COASTAL_GREEN's Kd red 0.2310 leaves 0.04% of surface red at the 33 m
   * eye (daylight [3.9e-4, 0.077, 0.047], G/B 1.64 against the frame's
   * measured 1.95 - REEF_TURQUOISE at the same depth is blue-dominant and
   * cannot produce that ratio). The smoothing is not the bug; it exists for
   * the salt-and-pepper mosaic measured at `waterTypeAt` in world/biomes.js.
   * An authored disc is the sanctioned override and this is what it carries.
   *
   * THE DEVIATION IS SPENT ON RED, AND THAT IS THE WHOLE POINT. Every other
   * row in this family spends it on the channel the water IS; this one spends
   * it on the channel the BUILDING is. The station's palette is warm by
   * authorship - PAINT_SHELL [0.72, 0.55, 0.17], PAINT_HIVIS [0.60, 0.36,
   * 0.028], the hatch marker's warmMark [1.0, 0.62, 0.32] and the interior's
   * warmRoom seen through untinted glazing - and a frame that carries a warm
   * hull against cool water has TWO hues in it. Saturation was never the
   * lever: DUNE_AZURE's round 3 records its own water measuring saturation
   * 1.000 with red literally zero, "which is what a poster wall is". Vibrant
   * here means chroma VARIETY across the frame, not chroma magnitude in it.
   *
   * BLUE Kd IS PINNED BIT-EQUAL TO THE DEEP FAMILY'S 0.0182 and the pin is
   * load-bearing exactly as LAGOON_VIOLET's is: min(Kd) sets the
   * classification ceiling, 0.0182 ties this row to the deep four (and
   * LAGOON, PLATTER, KELP) at exactly 361.4 m, and test-terrain 10b's
   * crossover loop exits on equality against all of them - so this row is
   * judged only against the SHALLOWER-ceiling types, and it sits under every
   * one of them channel for channel: red 0.0450 under OCEANIC_CLEAR's 0.0674,
   * REEF_TURQUOISE's 0.0791 and COASTAL_GREEN's 0.2310; green 0.0215 under
   * 0.0576 / 0.0725 / 0.0754; blue 0.0182 under OCEANIC's 0.0253 (the same
   * bound PLATTER and KELP respect). Being preferred over any of them can
   * only ever brighten. No real column carries this water past ~48 m - the
   * disc is 110 m wide on a 44 m seabed - so the pin spends nothing in a
   * frame, and it is the DUNE_AZURE case in reverse: that row had to break
   * the pin because 330 m of column could not be lit through it, and 44 m
   * needs no such licence.
   *
   * SCOPED TO ONE DISC. REEF_TURQUOISE was not touched (three biomes carry it
   * and their look is shipped), COASTAL_GREEN and Boulder Field were not
   * touched (KELP_EMERALD's header records leaving Boulder Field alone as the
   * point of that split), and nothing global moved - AGX_LOOK_SATURATION,
   * VEIL_CHROMA, WATER_CHROMA and the depth grade would all have paid for one
   * scene with every other scene in the showcase.
   *
   * The surface pair is authored wholesale (no earlier red cut to restore).
   * Consequence, stated as intent: from the air the station sits in a pale
   * aqua disc against the green inshore shelf - the fifth place on the map
   * where the sea itself marks what is under it.
   *
   * visibility is ln(50)/min(sigmaT) as everywhere else: 3.912/0.0470 =
   * 83.2 m, on the BLUE channel. That is the CLARITY half of the same user
   * decision ("clearer - show the whole building"): the station is 46 m wide
   * and the demo's arrival stages 34 m out, so at COASTAL_GREEN's 50.8 m the
   * far modules sat in haze. The 62 m clearing is scatter-free by
   * construction, so the long sightline shows the building rather than
   * emptiness - the trap the kelp clarity pass recorded does not bite here
   * for the same reason it did not bite DUNE_AZURE.
   */
  PELAGOS_AQUA: {
    id: 14, name: 'Pelagos Shoal (station aqua)',
    // Blue is the clear channel on the sight path with green close behind, so
    // the haze reads AQUA rather than cobalt; red dies ~1.45x faster, which
    // keeps the "underwater" read without executing the hull's warm paint -
    // and `chroma` below flattens what is left of that spread anyway.
    //
    // sigmaS IS GREEN-DOMINANT, AND THAT IS ROUND 2 CORRECTING ROUND 1 ON THE
    // DELIVERED FRAMES. Round 1 authored it blue-dominant ([0.0090, 0.0170,
    // 0.0230], albedo 0.13 / 0.33 / 0.49) on the reasoning that the sight
    // path's clearest channel should also carry the luminosity. It shipped a
    // frame at hue 197.5 deg - a clean COBALT, a good reef and not the aqua
    // the decision asked for - because the in-scatter's hue is sigmaS TIMES
    // `localWaterTint()`, and the tint here is Sand Plains' fogTint, which
    // normalises blue-of-cyan (B/G 1.19). A blue-leaning sigmaS multiplies
    // that instead of balancing it. Round 2 tilts sigmaS to G/B 1.40 (1.28
    // after the chroma collapse), which lands the delivered frame at hue
    // 189.6 deg with the open column at 183 deg - turquoise.
    //
    // The same round CUT the total by 24% at held sigmaT, absorption taking
    // the difference: round 1's broadside frame was milky, the pallor that
    // PLATTER_TEAL round 3 names ("same fade, darker fog"). Single-scattering
    // albedo is now 0.096 / 0.343 / 0.266 - luminous in green, dark in red.
    // DUNE_AZURE round 2 is the correction in the other direction if a later
    // frame comes back a flat wall with no luminosity gradient.
    sigmaA: [0.0615, 0.0335, 0.0345],
    sigmaS: [0.0065, 0.0175, 0.0125],
    sigmaT: [0.0680, 0.0510, 0.0470],
    // Blue PINNED bit-equal to the deep family's 0.0182 - see the header.
    // RED IS THE DEVIATION: 0.0450 keeps 22.7% of surface red at the 33 m eye
    // against COASTAL_GREEN's 0.04%, and LAGOON_VIOLET's 0.0580 is the
    // shipped precedent for a red-transmitting shallow row. Green sits just
    // above blue so the daylight lands aqua-of-cyan rather than the navy a
    // near-equal triple gives.
    // TWO TRIPLES REACH THE EYE AND ONLY THE SECOND IS A PICTURE: raw, these
    // give [0.227, 0.492, 0.549] at 33 m (G/B 0.90); after the `chroma` 0.55
    // collapse below - which is what the shader is actually handed - they
    // give [0.337, 0.517, 0.548] (G/B 0.94). Quote the collapsed one when
    // arguing about a delivered frame, and re-derive it after ANY chroma
    // change, because the collapse moves red four times as far as green.
    // Round 2 moved green 0.0240 -> 0.0215 with the sigmaS tilt above; on its
    // own it is worth 3 points of delivered green, and the frame's turquoise
    // came mostly from the in-scatter, not from here.
    Kd: [0.0450, 0.0215, 0.0182],
    surfaceSigmaA: [0.0615, 0.0335, 0.0345],
    surfaceKd: [0.0450, 0.0215, 0.0182],
    g: 0.916, ior: 1.3392, density: 1026,
    // Aqua-turquoise far-field body with a RED FLOOR of 0.030 - DUNE_AZURE
    // round 3's lesson, that an open water measuring saturation 1.000 with
    // red at zero is a poster wall. G/B went 0.85 -> 1.02 in round 2, the
    // same cobalt-to-turquoise correction as the sigmaS tilt above and for
    // the same reason: deepTint is EXEMPT from the `chroma` collapse below,
    // so it is the one carrier whose hue survives the flattening intact, and
    // it has to lead rather than follow. DUNE_AZURE's 0.75 is the azure end
    // of this same axis; above ~1.1 the far field starts reading green.
    deepTint: [0.030, 0.128, 0.126],
    // MEDIUM CHROMATICITY (KELP_EMERALD's field; every row that omits it is
    // bit-identical, and it is multiplied under RENDER.WATER_CHROMA at the
    // renderer's pack site and sprung with the column). THIS IS THE
    // LOAD-BEARING HALF OF "THE HULL READS WARM", because no Kd this row can
    // legally carry delivers it alone: the hull's red is the PRODUCT of the
    // red illuminant at 33 m and the red sight path at ~30 m, and both are
    // exponentials. At full chroma that product is 0.130 x 0.368 = 0.048
    // against blue's 0.244 x 0.548 = 0.134, and the gold paint delivers
    // blue-grey. At 0.55 the medium collapses toward its min channel - sight
    // [0.173, 0.229, 0.244], daylight [0.337, 0.517, 0.548] - and the same
    // paint delivers R:G:B 1.84 : 2.85 : 1.00, which is gold. The water does
    // not go neutral with it: the aqua rides the EXEMPT carriers, deepTint
    // above and the biome fogTint x VEIL_CHROMA haze (Sand Plains' [0.12,
    // 0.31, 0.34] normalises cyan), exactly the division of labour
    // KELP_EMERALD's chroma comment sets out. Its round-9 note is the guard
    // rail in the other direction: at 0.12 the medium went so spectrally flat
    // that the floor photographed cyan-blue and the water lost its colour.
    //
    // 0.45 -> 0.55 in round 2, and it is nearly free HERE in a way it is not
    // for KELP_EMERALD: this row's Kd triple is gentle (a 2.5x red/blue
    // spread against kelp's 8.2x), so a 10-point chroma lift costs the hull
    // 1.7 points of red transmittance at 30 m (0.184 -> 0.173) while giving
    // the medium back enough of its own spectrum that the water is not
    // carried by deepTint alone.
    chroma: 0.55,
    // An engineered clearing on swept carbonate sand, and motes read as noise
    // against a bright hull (DUNE_AZURE round 1 recorded them delivering as
    // fairy lights and generating false contacts).
    snowMultiplier: 0.20, visibility: 83.2,
  },
};

export const WATER_TYPE_LIST = Object.values(WATER_TYPES);

/**
 * Diffuse reflectance of the SEABED under each water type, indexed by `id`.
 *
 * This is what makes a lagoon turquoise. The water-leaving radiance over a
 * bottom is `mix(R_deep, rho, exp(-2*Kd*h))`, so `rho` is half of the answer and
 * the reef could not be told from the abyss without it - measured, the shader's
 * single constant body colour was 12.4x too dark in luminance over 3 m of sand
 * and the wrong hue as well.
 *
 * Values are visible-band diffuse albedos of the sediment each basin actually
 * has: carbonate reef sand is 0.55-0.70, terrigenous shelf sand 0.30-0.40, kelp
 * and silt floors 0.10-0.16, and abyssal clay/sulphide 0.04-0.05.
 */
export const WATER_BOTTOM_ALBEDO = [
  [0.35, 0.34, 0.32],   // 0 OCEANIC_CLEAR      - shelf sand
  [0.62, 0.60, 0.55],   // 1 REEF_TURQUOISE     - carbonate reef sand
  [0.14, 0.16, 0.12],   // 2 COASTAL_GREEN      - kelp over dark rock
  [0.10, 0.09, 0.08],   // 3 MURKY_PARTICULATE  - silt
  [0.30, 0.28, 0.25],   // 4 BRINE              - evaporite crust
  [0.05, 0.05, 0.05],   // 5 ABYSSAL_VOID       - abyssal clay
  [0.04, 0.04, 0.04],   // 6 VENT_SMOKE         - sulphide
  // Pelagic clay under a live particle rain reads PALER and slightly warmer than
  // the swept clay of a wall: it is the same sediment plus the marine snow that
  // settled on it, which is the one visible difference between an abyssal plain
  // and the trench wall above it. Still an abyssal clay, so still 6-8%.
  [0.08, 0.075, 0.065], // 7 HADAL_SUSPENSION   - pelagic clay under marine snow
  // ROW 8 IS REACHABLE NOW: `waterTypeAt`'s authored-place override returns
  // VENT_HAZE inside the Emberthroat place (world/places.js), so
  // `renderer.js`'s WATER_BOTTOM_ALBEDO[wt.id] selects this row there. The
  // deposit the old comment carried was paid by the commit that landed
  // places.js; the proof measurements are recorded at the VENT_HAZE docstring.
  [0.06, 0.05, 0.04],   // 8 VENT_HAZE          - mineral precipitate over basalt
  // The canyon floor is what has SETTLED OUT of the nepheloid layer above it:
  // locally derived silt shed from the iron-stained wall strata rather than
  // pelagic clay, so it is paler and warmer than either abyssal row and sits at
  // the top of the terrigenous band. Reachable only in principle at these
  // depths - `oceanBodyColour()` weights it exp(-2*surfaceKd*h), which is 1.3%
  // at Canyon Wall's shallowest 120 m and 5.9e-10 at 420 m - so it is authored
  // for correctness, not for a pixel anyone will see.
  [0.13, 0.12, 0.10],   // 9 NEPHELOID          - settled canyon silt
  // The grove floor is the same bright carbonate sand as the reef's, faintly
  // cool - the reference's white floor with the violet column over it.
  [0.60, 0.57, 0.58],   // 10 LAGOON_VIOLET     - pale carbonate sand
  // The forest floor is terrigenous sand under an olive tuft carpet - warmer
  // and darker than the reef carbonates, cooler than the canyon silt.
  [0.38, 0.35, 0.26],   // 11 PLATTER_TEAL      - olive-tan forest sand
  // The kelp floor is COASTAL_GREEN's dark rock one shade greener and darker:
  // holdfast-covered basalt under a permanent canopy shadow. Kept LOW on
  // purpose - the emerald of this biome lives on the water column and the
  // daylight, and a bright floor under a 29%-green key would meter the whole
  // frame down.
  [0.10, 0.13, 0.08],   // 12 KELP_EMERALD      - holdfast rock under canopy
  // The shoal is pale biogenic dune sand - carbonate-rich but 300 m down and
  // current-swept, so it sits between the reef carbonates and the shelf
  // terrigenous band. Kept a MID-tone, not reef-bright: under the azure key's
  // exposure lift a 0.6 albedo meters the frame down and crushes the water's
  // own luminosity (the Platter round-4 lesson).
  [0.34, 0.33, 0.29],   // 13 DUNE_AZURE        - pale dune sand at depth
  // The station clearing is bright carbonate shelf sand - the reef's material
  // one shade warmer, on the 44 m shelf the site was levelled into. Kept
  // REEF-BRIGHT rather than mid-toned (the DUNE_AZURE caution above) because
  // this column is 44 m and not 330: the exposure is nowhere near its lift,
  // and a bright floor is what makes shallow water read turquoise at all.
  [0.62, 0.59, 0.52],   // 14 PELAGOS_AQUA      - swept carbonate shelf sand
];

/**
 * The surface downwelling irradiance the `deepTint` values above were authored
 * under: a clear noon sun, as a luma on the renderer's illuminance scale.
 *
 * `deepTint` is a RADIANCE, so it has to scale with the light that is actually
 * falling on the sea. It did not: applyWaterMedium multiplied it only by
 * daylightAtDepth(), which is exp(-Kd*depth) and therefore exactly 1.0 at the
 * surface no matter what time it is. Over any path long enough that transmittance
 * goes to zero - which is every pixel of open water - the water asymptoted to this
 * authored constant, day or night. Measured at midnight it was 94.5% of all the
 * light below the horizon, and it compressed the sea's day/night contrast from
 * 311:1 to 14.9:1.
 *
 * The coefficient is SUN_INTENSITY_NOON reduced by the atmospheric extinction and
 * the surface Fresnel loss that ambientAtDepth() applies on top of it; the whole
 * product was measured at 97.0 against a nominal 118.
 */
export const DEEP_TINT_REFERENCE_E = 118.0 * 0.822;

// ===========================================================================
// SKY & TIME
// ===========================================================================

export const SKY = {
  /** Real seconds for one full day/night cycle. */
  SECONDS_PER_DAY: 1200,
  /** Peak solar illuminance at the surface, lux / 1000 (shader units). */
  SUN_ILLUMINANCE: [1.0, 0.965, 0.906],
  SUN_INTENSITY_NOON: 118.0,
  /** Angular radius of the sun disc, radians (real sun = 0.00465). */
  SUN_ANGULAR_RADIUS: 0.0047,

  /** Two moons. Periods in in-game days. */
  MOONS: [
    { name: 'Ker', period: 7.4, angularRadius: 0.0121, albedo: [0.82, 0.80, 0.76], intensity: 0.0032 },
    { name: 'Vail', period: 23.1, angularRadius: 0.0068, albedo: [0.64, 0.68, 0.79], intensity: 0.0009 },
  ],

  /** Rayleigh scattering coefficients at sea level, 1/m. */
  RAYLEIGH: [5.802e-6, 13.558e-6, 33.1e-6],
  RAYLEIGH_SCALE_HEIGHT: 8000,
  /** Mie scattering, 1/m, and its asymmetry. */
  MIE: 3.996e-6,
  MIE_ABSORPTION: 4.4e-6,
  MIE_SCALE_HEIGHT: 1200,
  MIE_G: 0.80,
  /** Ozone absorption, 1/m, peaking at 25 km. */
  OZONE: [0.650e-6, 1.881e-6, 0.085e-6],

  PLANET_RADIUS: 6360e3,
  ATMOSPHERE_RADIUS: 6460e3,
  GROUND_ALBEDO: [0.08, 0.09, 0.10],

  /** Cloud layer, metres above sea level. */
  CLOUD_BOTTOM: 1400,
  CLOUD_TOP: 4200,

  /**
   * Cloud extinction at full shaped density, 1/m (DESIGN 03.8.8), and the
   * multiplier it reaches at rain = 1. 0.045 over a 400 m core is tau 18,
   * which is a real cumulus; the deck was measured at tau 1.0 before the
   * coverage remap in pass/clouds.wgsl was calibrated, which is why it used to
   * have no shadowed underside.
   */
  CLOUD_DENSITY: 0.045,
  CLOUD_RAIN_DENSITY_GAIN: 1.8,
  /**
   * How deeply the detail octave eats into the base shape. Raised from 0.32
   * with the density fix: at the old mean shaped density of 0.17 an erosion of
   * 0.32 already removed half the cloud, whereas at the calibrated 0.55 it
   * only costs 6% of the optical depth and buys the cauliflower silhouette.
   */
  CLOUD_EROSION: 0.50,
  /**
   * Cloud cover over which the sun is treated as progressively hidden.
   *
   * Cover is NOT a dimmer. A scattered cumulus field at 0.45 does not remove
   * 44% of the sunlight: between the clouds the sun is at full strength and
   * behind one it is gone, and the per-pixel version of that is the cloud
   * itself. Only an unbroken deck dims everything uniformly, so the dimming is
   * keyed on how close to unbroken the deck is. Measured before: raising cover
   * to 0.45 to get a visible sky cost 38% of env.sunIntensity (73.17 -> 45.35)
   * and desaturated the ambient probe from B/R 1.80 to 1.47.
   */
  OVERCAST_BAND: [0.60, 0.95],
  /** Peak radiance of the galaxy band, renderer units. */
  GALAXY_STRENGTH: 0.0022,
  /**
   * Moonless-night sky floor, renderer units, before the hue in
   * pass/sky_render.wgsl and its horizon lift.
   *
   * This is not physical airglow - at 1 unit ~= 5100 cd/m2 it is ~1000x a real
   * airglow sky - it is the art-directed floor the whole night compression in
   * TIME_KEYS already implies. What it must NOT be is the only thing in the
   * night sky, which is what it was: the sky-view LUT integrates the sun alone
   * and is exactly zero after dusk, so the measured night sky was this
   * constant and nothing else (p50 6.0e-5, 8.9e-5, 5.4e-5 - green-dominant).
   *
   * Halved from 0.00016 now that moonSkyGlow() puts real moonlight in the sky:
   * at 0.00016 a full moon at 45 deg still only lifted the sky 20% at 90 deg
   * from itself, so the constant went on setting the colour of the night. At
   * 0.00008 the moonlit gradient across the sky is 3.4x. The darkest direction
   * of a moonlit night loses 1.07 EV against the old constant, which the
   * histogram auto-exposure absorbs - the QA night frame metered EV -2.28
   * against an EXPOSURE_MIN_EV of -6.0.
   */
  AIRGLOW: 0.00008,
  STAR_COUNT: 3800,
};

/**
 * Key times through the day, as fractions of the cycle.
 * sunColor/skyColor are LINEAR RGB; intensity is a multiplier on SUN_INTENSITY_NOON.
 */
export const TIME_KEYS = [
  { t: 0.00, name: 'midnight',  sunElev: -1.15, intensity: 0.000, sunColor: [0.00, 0.00, 0.00], skyColor: [0.0016, 0.0030, 0.0072], underwaterAmbient: [0.0004, 0.0011, 0.0026] },
  { t: 0.20, name: 'astroDawn', sunElev: -0.30, intensity: 0.002, sunColor: [0.10, 0.10, 0.22], skyColor: [0.0090, 0.0140, 0.0290], underwaterAmbient: [0.0010, 0.0040, 0.0090] },
  { t: 0.23, name: 'dawn',      sunElev: -0.09, intensity: 0.030, sunColor: [0.72, 0.36, 0.24], skyColor: [0.0900, 0.0820, 0.1300], underwaterAmbient: [0.0090, 0.0280, 0.0480] },
  { t: 0.25, name: 'sunrise',   sunElev:  0.02, intensity: 0.180, sunColor: [1.00, 0.52, 0.28], skyColor: [0.2600, 0.2200, 0.2600], underwaterAmbient: [0.0300, 0.0900, 0.1400] },
  { t: 0.33, name: 'morning',   sunElev:  0.42, intensity: 0.760, sunColor: [1.00, 0.90, 0.78], skyColor: [0.3800, 0.5000, 0.7600], underwaterAmbient: [0.1000, 0.3000, 0.4200] },
  { t: 0.50, name: 'noon',      sunElev:  1.15, intensity: 1.000, sunColor: [1.00, 0.97, 0.91], skyColor: [0.4200, 0.5600, 0.8600], underwaterAmbient: [0.1400, 0.3800, 0.5200] },
  { t: 0.67, name: 'afternoon', sunElev:  0.42, intensity: 0.760, sunColor: [1.00, 0.91, 0.76], skyColor: [0.3900, 0.5000, 0.7400], underwaterAmbient: [0.1000, 0.3000, 0.4200] },
  { t: 0.75, name: 'sunset',    sunElev:  0.02, intensity: 0.180, sunColor: [1.00, 0.44, 0.20], skyColor: [0.3000, 0.1900, 0.2000], underwaterAmbient: [0.0300, 0.0800, 0.1200] },
  { t: 0.78, name: 'dusk',      sunElev: -0.09, intensity: 0.028, sunColor: [0.62, 0.28, 0.22], skyColor: [0.0800, 0.0700, 0.1200], underwaterAmbient: [0.0080, 0.0240, 0.0420] },
  { t: 0.82, name: 'astroDusk', sunElev: -0.30, intensity: 0.002, sunColor: [0.08, 0.09, 0.20], skyColor: [0.0070, 0.0110, 0.0250], underwaterAmbient: [0.0009, 0.0035, 0.0080] },
  { t: 1.00, name: 'midnight',  sunElev: -1.15, intensity: 0.000, sunColor: [0.00, 0.00, 0.00], skyColor: [0.0016, 0.0030, 0.0072], underwaterAmbient: [0.0004, 0.0011, 0.0026] },
];

// ===========================================================================
// OCEAN
// ===========================================================================

export const OCEAN = {
  /** Cascade patch sizes, metres. Three scales kill visible tiling. */
  CASCADE_SIZES: [512, 64, 8],
  /** IFFT resolution per cascade at HIGH tier. */
  FFT_SIZE: 256,
  /** Gravity used by the dispersion relation. */
  GRAVITY: 9.81,
  /**
   * Suppress waves shorter than this, metres.
   *
   * 0.08, not the 0.12 this used to be: with the per-band renormalisation below,
   * lowering the cutoff means more of the short-wave slope comes from real
   * spectral content instead of from the band gain. Measured at sea state 2, the
   * gain needed to hit the slope target falls 1.84 -> 1.65 while cascade 2's RMS
   * height rises 0.0021 -> 0.0033 m. Do NOT go to 0.04: cascade 2's texel is
   * 8/256 = 3.125 cm, so 6.25 cm is its Nyquist wavelength and 4 cm aliases.
   * 0.08 m is 2.6 texels and safe.
   */
  MIN_WAVELENGTH: 0.08,
  /**
   * Horizontal displacement (choppiness) multiplier - the ABSOLUTE gain, before
   * OCEAN_CASCADE_CHOP's per-cascade weights.
   *
   * 1.82, not the 1.35 it read for a long time, and the sea did not change: the
   * value was being applied TWICE (weather.js published OCEAN.CHOPPINESS * a
   * sea-state ramp as `env.choppiness`, and ocean.js multiplied by
   * OCEAN.CHOPPINESS again), so the effective figure has always been
   * 1.35 * 1.35 = 1.82. sim/ocean.js now divides the published absolute back out,
   * and this constant is raised to what the sea was already drawn with.
   *
   * It is load-bearing for foam, which is why it was not simply lowered to be
   * honest: whitecap coverage is p(Jacobian < FOAM_JACOBIAN_THRESHOLD), and the
   * Jacobian excursion scales with the displacement gain. Measured at 1.35 the
   * coverage over cascade 1 is 0.000 / 0.023 / 0.082 / 0.920 % at sea states
   * 2/3/4/6 against Monahan & O'Muircheartaigh's 0.065 / 0.29 / 0.83 / 4.90 %;
   * at 1.82 it is 0.102 / 0.380 / 1.001 / 4.497 %, i.e. within 1.6x of the
   * measured ocean across the whole range.
   */
  CHOPPINESS: 1.82,
  /**
   * Foam appears where the surface Jacobian falls below this.
   *
   * 0.52 is a "the surface has genuinely folded" criterion, not a tuning knob,
   * and it stays there. Before the per-band renormalisation it produced foam
   * NOWHERE - the Jacobian's standard deviation over cascade 1 was 0.13 at sea
   * state 2, so 0.52 sat 3.6 sigma out and the measured coverage was 0.000% at
   * every sea state including 6. With the renormalisation the same threshold
   * lands within 1.6x of Monahan's whitecap coverage at every sea state (see
   * CHOPPINESS). It was the amplitude that was wrong, not the criterion.
   */
  FOAM_JACOBIAN_THRESHOLD: 0.52,
  /**
   * Share of Cox & Munk's measured total mean-square slope that the resolved
   * cascades are renormalised to carry.
   *
   * WITHOUT this the short cascades are wind-INDEPENDENT, which is arithmetic
   * rather than a coding slip: a Phillips spectrum normalised to Hs has
   * m0 proportional to L^2 = U^4/g^2 while its variance above a wavenumber
   * k0 >> 1/L is independent of L, so the Hs normalisation cancels the wind out
   * of the high-k tail exactly. Measured before: cascade 1's RMS height went
   * 0.0283 -> 0.0331 -> 0.0338 -> 0.0304 m across sea states 2/3/4/6 while
   * cascade 0's went 0.075 -> 1.05 m. Raising the sea state bought a bigger
   * swell and literally the same chop.
   *
   * 0.70 rather than 1.0 because the remaining 30% is what the specular
   * roughness represents (`mssMissing` in pass/ocean_surface.wgsl); driving the
   * geometry to the full Cox-Munk figure would leave the far-field glitter path
   * with no width at all.
   */
  RESOLVED_SLOPE_FRACTION: 0.70,
  /** Ceiling on that renormalisation gain. Binds only above sea state 7. */
  MAX_BAND_GAIN: 4.0,
  /**
   * Floor on the share of cascade 0's own variance the renormalisation may leave
   * it, since the total is re-solved to keep Hs exact.
   *
   * It only binds in a nearly flat sea: at 2 m/s of wind the peak wavelength is
   * 2.5 m, which is cascade 1's band, so cascade 0 holds 3.6% of the variance
   * and there is nothing to borrow. Without the floor the solve drives cascade 0
   * to exactly zero and Hs overshoots to 0.096 m against a sea state 1 target of
   * 0.08. At sea state 2 it caps the gain at 2.08 against a wanted 1.65, so it
   * costs nothing where it matters.
   */
  SWELL_VARIANCE_FLOOR: 0.5,
  FOAM_DECAY_RATE: 0.42,
  /** Surface mesh: radial clipmap ring count and base resolution. */
  CLIPMAP_RINGS: 7,
  CLIPMAP_RESOLUTION: 128,
  /** Fresnel F0 for a water/air interface at normal incidence. */
  FRESNEL_F0: 0.02,
  IOR: 1.333,
  /** Wave height (Hs) and wind speed per sea state (Douglas scale 0-9). */
  SEA_STATES: [
    { state: 0, wind: 0.5,  hs: 0.00 }, { state: 1, wind: 2.0,  hs: 0.08 },
    { state: 2, wind: 4.5,  hs: 0.32 }, { state: 3, wind: 7.0,  hs: 0.88 },
    { state: 4, wind: 9.5,  hs: 1.65 }, { state: 5, wind: 12.5, hs: 2.90 },
    { state: 6, wind: 16.0, hs: 4.20 }, { state: 7, wind: 20.0, hs: 6.10 },
    { state: 8, wind: 24.0, hs: 8.50 }, { state: 9, wind: 29.0, hs: 11.5 },
  ],
};

export const WEATHER = {
  CLEAR:    { id: 'clear',    seaState: 2, cloudCover: 0.10, rain: 0.0, fog: 0.00, visibilityMul: 1.00, windSpeed: 4.5 },
  BREEZY:   { id: 'breezy',   seaState: 3, cloudCover: 0.32, rain: 0.0, fog: 0.02, visibilityMul: 0.96, windSpeed: 7.0 },
  OVERCAST: { id: 'overcast', seaState: 4, cloudCover: 0.82, rain: 0.0, fog: 0.10, visibilityMul: 0.82, windSpeed: 9.5 },
  SQUALL:   { id: 'squall',   seaState: 6, cloudCover: 0.94, rain: 0.6, fog: 0.22, visibilityMul: 0.58, windSpeed: 16.0 },
  STORM:    { id: 'storm',    seaState: 8, cloudCover: 1.00, rain: 1.0, fog: 0.35, visibilityMul: 0.36, windSpeed: 24.0 },
  FOGBANK:  { id: 'fogbank',  seaState: 1, cloudCover: 0.55, rain: 0.0, fog: 0.92, visibilityMul: 0.22, windSpeed: 2.0 },
};

// ===========================================================================
// PLAYER
// ===========================================================================

export const PLAYER = {
  /** Capsule. */
  HEIGHT: 1.82,
  CROUCH_HEIGHT: 1.10,
  RADIUS: 0.34,
  EYE_HEIGHT: 1.68,
  CROUCH_EYE_HEIGHT: 0.98,
  MASS: 84,

  /**
   * On land, m/s. These land EXACTLY: _simulateLand steers the velocity toward
   * the target with a hard delta clamp, so the achieved speed is the constant.
   */
  WALK_SPEED: 5.5,
  RUN_SPEED: 9.5,
  CROUCH_SPEED: 2.4,
  GROUND_ACCEL: 42,      // reaches RUN_SPEED in 0.23 s; no need to raise it
  AIR_ACCEL: 6,
  GROUND_FRICTION: 9.5,
  JUMP_HEIGHT: 0.95,
  STEP_HEIGHT: 0.42,
  MAX_SLOPE: 0.86,       // cos of ~50 degrees
  COYOTE_TIME: 0.12,

  /**
   * Swimming, m/s. These are EXACT steady-state speeds, not approximations:
   * thrust is `targetSpeed * SWIM_DRAG` against a drag of `-v * SWIM_DRAG`, so
   * the balance sits at `v = targetSpeed` for ANY value of SWIM_DRAG.
   *
   * They were not exact before. The stroke pulse multiplied the thrust and had
   * a cycle mean of 0.807, so 2.4 delivered 1.94 m/s while the docstring claimed
   * the steady state was "EXACTLY the documented cruise speed". The pulse no
   * longer touches the thrust at all - see _simulateSwim - so the speed is now
   * exact instantaneously and not merely on average.
   */
  SWIM_SPEED: 4.0,
  SWIM_SPRINT_SPEED: 6.5,
  /**
   * Linear drag rate, 1/s. This number IS the swim controller's response time
   * and nothing else. Because the thrust is scaled by it and the buoyancy term
   * is written `drift * SWIM_DRAG` for the same reason, every steady state -
   * cruise, sprint, the buoyant drift - is independent of it; raising it only
   * shortens the time constant `1/SWIM_DRAG`, here 0.167 s.
   *
   * It was 2.35, i.e. 0.426 s, and a playtest reported free-swim as
   * unresponsive: "press and hold W to swim forward and then press S to swim
   * backward. It keeps swimming forward for a while." Measured on that build,
   * a diver holding W to steady state and then holding S for 2.5 s was still
   * travelling FORWARD at 3.40 m/s. Most of that was a separate defect (see
   * _simulateSwim on the deleted SWIM_TURN_RATE), but the drag alone took
   * 0.98 s to shed 90% of cruise speed and 0.43 s to reach 63% of it.
   *
   * Explicit Euler needs `SWIM_DRAG * dt < 2`; at the fixed 1/60 s step this is
   * 0.100, and it stays stable even at the 5-step-per-frame worst case.
   */
  SWIM_DRAG: 6.0,
  /**
   * Extra drag applied while NO direction is commanded, as a multiple of
   * SWIM_DRAG. A centred input commands a STOP, exactly as a centred vessel
   * throttle does - and physically, a diver who stops finning is no longer
   * streamlined, so 1.7x is a flare, not a hand-brake.
   *
   * The drag is integrated RELATIVE to the buoyant drift, so this multiplier
   * cannot change where an idle diver ends up in the water column, only how
   * fast they settle there. Measured: 90% of cruise shed in 0.23 s rather than
   * 0.38 s.
   */
  SWIM_STOP_DRAG_MULT: 1.7,
  /**
   * Ceiling on the total hydrodynamic acceleration - thrust plus drag - that a
   * diver's body can exchange with the water, m/s^2.
   *
   * A LINEAR drag is a small-signal fit around swim speed, and a rate tuned for
   * a 4 m/s cruise extrapolates badly: a plunge that enters the water at
   * 21.5 m/s demanded 228 m/s^2, which at the fixed 1/60 s step is a 3.81 m/s
   * jump in a single frame. That is a wall at the waterline, and
   * tools/test-entities.mjs asserts no step exceeds 1.0 m/s. 52 m/s^2 is 0.87.
   *
   * Be clear about the direction of the error: real water at 21.5 m/s would
   * decelerate a diver far HARDER than either number, so this is a ceiling on a
   * model that was already gentle, not a claim about seawater. Inside the swim
   * envelope it is nearly inert - a cruise reversal peaks at 48 and a cruise
   * stop at 41, both under it. The one manoeuvre that reaches it is the sprint
   * reversal, which demands 63; measured capped against uncapped on the same
   * code path, the zero crossing was 0.167 s BOTH times, i.e. the cap costs less
   * than one simulation step. It applies to the whole acceleration vector
   * through ONE scalar, because clipping the components separately would rotate
   * the acceleration away from the direction the diver asked for.
   */
  SWIM_MAX_ACCEL: 52,
  /** Vertical drift when neutral: slightly positive so idling floats you up. */
  SWIM_BUOYANCY: 0.55,
  /** Fins upgrade multiplies swim speed by this. */
  FINS_MULTIPLIER: 1.42,

  /** Oxygen, seconds at each tank tier. */
  OXYGEN_TIERS: [90, 135, 210, 300, 420],
  OXYGEN_RATE_IDLE: 1.0,
  OXYGEN_RATE_SWIM: 1.35,
  OXYGEN_RATE_SPRINT: 2.2,
  OXYGEN_RATE_PANIC: 1.6,
  /** Consumption scales with ambient pressure - real physiology: a diver at
   *  30 m breathes 4x the surface gas mass per breath. Capped so the deep
   *  is dangerous but not instantly lethal. */
  OXYGEN_DEPTH_FACTOR: 0.045,   // per atmosphere above 1
  OXYGEN_DEPTH_FACTOR_MAX: 3.2,
  /** Warning thresholds, seconds remaining. */
  OXYGEN_WARN: 30,
  OXYGEN_CRITICAL: 10,
  /** Refill rate at a source, fraction of the tank per second. */
  OXYGEN_REFILL_RATE: 0.55,

  MAX_HEALTH: 100,
  HEALTH_REGEN_DELAY: 12,
  HEALTH_REGEN_RATE: 2.2,
  /** Damage per second once the tank is empty. */
  DROWN_DPS: 14,

  MAX_STAMINA: 100,
  STAMINA_SPRINT_DRAIN: 18,
  STAMINA_REGEN: 12,
  STAMINA_REGEN_DELAY: 1.6,

  /** Depth (m) at which an unupgraded suit begins taking pressure damage. */
  SUIT_DEPTH_TIERS: [60, 200, 500, 900, 1600],
  PRESSURE_DPS: 6.5,

  INTERACT_RANGE: 3.2,
  SCAN_RANGE: 22,
  MINING_RANGE: 4.0,
};

// ===========================================================================
// VESSEL  -  the NAUTILUS-class hybrid aerodyne/submersible "KESTREL"
// ===========================================================================

export const VESSEL = {
  NAME: 'Kestrel',

  /** Hull dimensions, metres. */
  LENGTH: 7.4,
  BEAM: 4.2,
  HEIGHT: 2.6,
  /** Dry mass, kg. */
  MASS: 3850,
  /** Displaced volume when the ballast tanks are empty, m^3. */
  DISPLACEMENT: 4.35,
  /** Diagonal of the inertia tensor, kg*m^2. */
  INERTIA: [9200, 12400, 7600],
  /**
   * Centre of buoyancy above the centre of mass, metres. This is the vessel's
   * BALLASTING, and it is the only thing righting a hovering submersible - at neutral
   * buoyancy with no thrust there is nothing for the flight computer to vector.
   *
   * 0.55 m of BG on a 7.4 m hull is ordinary for a submersible (real ones run 0.3-1.0 m
   * by putting the batteries in the keel). It was 0.28, which left the roll mode with a
   * 5.7 s period and almost no damping: a knock at hover rolled the vessel 56 degrees
   * and it was still 25 degrees off level ten seconds later.
   */
  COB_OFFSET: [0, 0.55, 0],

  /**
   * Four vectoring nacelles. STATIC thrust per nacelle in AIR at sea level,
   * Newtons.
   *
   * This is a static figure, and the ducts are constant-shaft-power: see
   * thrustLapse() in entities/vessel.js. Shaft power follows from it as
   * P = T0^1.5 / sqrt(2 * rho_air * A_disc), which at 46 kN and a 0.62 m duct
   * throat is 5.7 MW per nacelle, 22.9 MW installed. Above about 4 m/s the
   * available thrust is P/(v + v_i), NOT this number - which is why raising this
   * constant buys speed as its CUBE ROOT and nothing like linearly.
   */
  THRUST_PER_NACELLE: 46000,
  NACELLE_COUNT: 4,
  /** Nacelle positions in body space (x right, y up, z back). */
  NACELLE_POSITIONS: [
    [ 1.85, 0.10, -1.65], [-1.85, 0.10, -1.65],
    [ 1.72, 0.05,  1.90], [-1.72, 0.05,  1.90],
  ],
  /**
   * Vectoring limits, radians. Tilt 0 is thrust straight up, -PI/2 is straight
   * forward.
   *
   * The lower limit extends well PAST -PI/2 on purpose, and how far is a
   * MEASURED requirement, not a guess.
   *
   * The mixer's tilt SCHEDULE stops at exactly -PI/2 (TILT_SCHED_MIN in
   * vessel.js) so cos(theta) can never go negative and invert the control signs.
   * But differential TILT is the primary pitch and roll effector once the ducts
   * are near horizontal, and its authority is
   * armPitch * thrust * available_travel - so the travel remaining BELOW the
   * schedule limit is what the vessel has to stabilise itself with in submerged
   * cruise.
   *
   * It needs to beat the hull's own destabilising Munk moment,
   * (m_surge - m_heave) * v_fwd * v_vert, which the added-mass asymmetry makes
   * large: 72 kN.m at only 12 m/s with 2 m/s of vertical body velocity. With
   * 0.179 rad of travel the vessel had 38 kN.m against that 72 and lost - it
   * tumbled in pitch and then vectored itself to the surface. 0.529 rad gives
   * 113 kN.m, a 3x margin at the same thrust.
   *
   * This margin matters much more than it used to because the ducts are
   * constant-power: with the correct water thrust the vessel cruises at about 10%
   * throttle instead of 45%, so there is far less differential-throttle headroom
   * and the tilt effector carries more of the load.
   */
  NACELLE_PITCH_RANGE: [-2.10, 0.52],
  NACELLE_YAW_RANGE: [-0.42, 0.42],
  NACELLE_SLEW_RATE: 2.1,   // rad/s

  /** Air performance. */
  MAX_AIRSPEED: 120,         // m/s (432 km/h). Drag-limited top is ~214 m/s,
                             // so this is held by the Vne law, not by thrust.
  MAX_CLIMB_RATE: 45,        // m/s
  SERVICE_CEILING: 2400,     // m
  AIR_DRAG_COEFF: [0.62, 1.35, 0.31],   // per body axis
  AIR_REFERENCE_AREA: [9.6, 22.4, 6.1], // m^2
  /** Modest body lift so it flies like a heavy VTOL, not a brick. */
  LIFT_COEFF: 0.42,
  GROUND_EFFECT_HEIGHT: 6.5,
  GROUND_EFFECT_GAIN: 1.28,

  /** Water performance. */
  MAX_SUBSPEED: 38,          // m/s (74 knots)
  /**
   * Drag AREA per body axis, m^2 (a Cd times a reference area, already
   * multiplied out).
   *
   * The surge figure is a DELIBERATE FICTION and the only one in this block. On
   * the hull's 10.9 m^2 frontal area 0.65 implies Cd = 0.060, against roughly
   * 0.10-0.15 for a real torpedo and 0.03-0.05 for an airship hull at similar
   * Reynolds number. The Kestrel is therefore airship-slippery, which a body of
   * L/D 1.76 has no business being.
   *
   * It is set to make MAX_SUBSPEED reachable rather than aspirational. Because
   * the ducts are constant-power, the drag-limited top speed is
   * v = (P_total / (0.5 * rho_water * CdA))^(1/3) = 41 m/s, leaving the Vne law
   * 3 m/s of margin at 38. The predecessor value of 1.42 gave a true top speed of
   * 8.8 m/s against a MAX_SUBSPEED that claimed 21 - the constant was not merely
   * unreachable, it was 2.4x out, and nothing measured it.
   */
  WATER_DRAG_COEFF: [3.85, 6.20, 0.65],
  /** Added mass (entrained water), as a fraction of dry mass per axis. */
  ADDED_MASS: [0.62, 0.94, 0.16],
  /**
   * Static thrust in water relative to air, for the same shaft power.
   *
   * DERIVED, not tuned. Momentum theory gives T0 = (2 * rho * A * P^2)^(1/3), so
   * for fixed power the ratio is exactly (rho_water / rho_air)^(1/3)
   * = (1025 / 1.225)^(1/3) = 9.424. A duct pumping a fluid 837 times denser
   * makes vastly more static thrust, and that is the whole reason a submersible
   * can use the same propulsors as an aircraft.
   *
   * The previous value of 1.34 was a made-up bonus that silently discarded 85% of
   * the available shaft power the moment the hull went under.
   */
  WATER_THRUST_EFFICIENCY: 9.424,

  /** Ballast. Tank volume in m^3, fill/blow rate in m^3/s. */
  BALLAST_VOLUME: 1.15,
  BALLAST_FILL_RATE: 0.21,
  BALLAST_BLOW_RATE: 0.34,
  /** Fraction of the tank that yields neutral buoyancy. */
  BALLAST_NEUTRAL: 0.5,

  /** Crush depth by hull tier, metres. */
  DEPTH_RATINGS: [220, 500, 900, 1300, 1650],
  /** Damage per second when past the rating, scaling with the overage. */
  OVERDEPTH_DPS: 9.0,
  /** Hull creaks begin at this fraction of the rating. */
  CREAK_THRESHOLD: 0.78,

  MAX_HULL: 100,
  /** Power cell capacity in kWh, by tier. */
  POWER_TIERS: [4.2, 7.5, 12.0, 19.5],
  /** Draw in kW. */
  POWER_DRAW_IDLE: 0.35,
  POWER_DRAW_THRUST_MAX: 14.5,
  POWER_DRAW_LIGHTS: 1.15,
  POWER_DRAW_SONAR_PING: 0.42,
  POWER_DRAW_DRILL: 6.8,
  /** Recharge at the base pad, kW. */
  POWER_RECHARGE_RATE: 22.0,

  /** Cabin oxygen reserve, seconds. Recycler extends this indefinitely while powered. */
  CABIN_OXYGEN: 5400,

  /** Enter/exit. */
  BOARD_RANGE: 4.5,
  BOARD_DURATION: 1.15,
  EXIT_DURATION: 0.95,
  /** How far you can stray before the "return to vessel" beacon appears. */
  LEASH_SOFT: 180,
  LEASH_HARD: 420,

  /** Camera. */
  COCKPIT_EYE: [0, 0.72, -0.35],
  FOV_COCKPIT: 74,
  FOV_CHASE: 66,
  CHASE_DISTANCE: 12.5,
  CHASE_HEIGHT: 3.4,
  CHASE_SPRING: 7.5,
  CHASE_DAMPING: 0.82,
  /**
   * VELOCITY FEED-FORWARD ON THE CHASE POINT, 0..1. THE SPRING TRAILS ITS OWN
   * HULL BY A DISTANCE PROPORTIONAL TO SPEED, AND AT CRUISE THAT IS MOST OF THE
   * FRAME.
   *
   * applyCamera integrates `vel += (target - pos) * CHASE_SPRING * dt` and
   * `vel *= exp(-CHASE_DAMPING * 10 * dt)`. Against a target moving at constant
   * `v` the steady state is `error = 10 * CHASE_DAMPING * v / CHASE_SPRING`,
   * i.e. 1.093 m of lag per m/s here - so a 66 m/s transit puts the camera 72 m
   * BEHIND the 12.5 m standoff it was authored for, and the vessel photographs
   * as a speck against empty sky (feedback5 beat 05, the reported
   * "we only see the tip of the mountain, the hull is tiny"). It is not a demo
   * artifact: free play flies faster.
   *
   * The fix is the textbook one - offset the ideal point by the lag the spring
   * is about to incur, `vel * 10 * CHASE_DAMPING / CHASE_SPRING`, so the error
   * cancels and the camera sits at CHASE_DISTANCE at ANY speed while keeping
   * the spring's whole response to ACCELERATION (the part that reads as weight).
   * 1 is exact cancellation; 0 reproduces the old image bit for bit and is the
   * bisect.
   *
   * MEASURED, in the running game, flying the showcase's own chase leg twice
   * (tools/probes/chase-standoff.js, 18 cruise samples per arm): at a median
   * 60 m/s the standoff is **71.3 m at 0 and 15.5 m at 1**, against the 12.5 m
   * CHASE_DISTANCE the view was authored for. The residual 3 m is the leg's own
   * acceleration, which the spring is SUPPOSED to show.
   */
  CHASE_LAG_COMP: 1.0,

  /** Water-entry transition. */
  TRANSITION_TIME: 0.5,
  ENTRY_DRAG_SPIKE: 3.4,
  /** Below this entry angle (radians from horizontal) the vessel skips. */
  SKIP_ANGLE: 0.21,
  SKIP_MIN_SPEED: 22,

  /**
   * DIRECT CONTROL. The piloted vessel is flown KINEMATICALLY: the hull points
   * where the aim points and moves along it, with one first-order lag on each.
   * See "THE CONTROL CONTRACT" in CLAUDE.md and _directControl() in
   * entities/vessel.js for why the rigid-body control cascade was taken off the
   * piloted path.
   */
  /**
   * Orientation lag, seconds. Small on purpose: it exists ONLY so a flick does
   * not snap in a single frame, which reads as a glitch rather than as
   * responsiveness. Frame-rate independent (k = 1 - exp(-dt/TAU)), and it stores
   * nothing, so it can neither lose nor replay pointer travel.
   *
   * 0.09 s puts 89% of a step in 0.2 s and 94% in 0.25 s. The rigid-body
   * cascade it replaces had a measured tau63 of 0.8-1.4 s and had delivered
   * 0.4% of a 126 degree flick at the moment the hand stopped.
   */
  DIRECT_AIM_TAU: 0.09,
  /**
   * Velocity lag, seconds. 63% of top speed in 0.25 s from rest, and the same
   * curve back to a stop when the throttle is centred - a centred throttle
   * commands a STOP, which is the one piece of the old throttle law that was
   * always right.
   */
  DIRECT_VEL_TAU: 0.25,
  /** Strafe (A/D) and fine vertical (SPACE/SHIFT) speeds, m/s. */
  DIRECT_STRAFE_SPEED: 9.0,
  DIRECT_VERT_SPEED: 9.0,
  /** Reverse (S) as a fraction of the forward limit. */
  DIRECT_REVERSE_FRAC: 0.5,
};

/**
 * How far a creature of a given body length is worth drawing, metres.
 *
 * `max(DRAW_DISTANCE_MIN, bodyLength * DRAW_DISTANCE_PER_LENGTH)`. A 0.11 m sprat
 * is a sub-pixel smear past ~90 m; a 96 m leviathan has to be visible from a
 * kilometre away or the world stops having a horizon.
 *
 * BOTH the render pass and the simulation read this, and they must agree. The
 * despawn rule keys on how long an agent has gone UNSEEN, and its visibility test
 * was a raw frustum check - against a projection with an INFINITE far plane, so a
 * fish 500 m away that is drawn by nothing and visible to nobody still counted as
 * seen and reset the timer. Measured: at the lagoon eye with the camera pointed at
 * the cluster the spawner had primed 668 m away on the beach, 189 of 189 candidate
 * agents were "in frustum", 0 were eligible for reclaim, and the near-field
 * director starved to 3 agents of a target of 150 with zero creatures drawn - while
 * the same build filled correctly at any other heading.
 */
export const CREATURE_DRAW = {
  DISTANCE_MIN: 90,
  DISTANCE_PER_LENGTH: 220,
};

/**
 * Vessel light groups. Cone angles in radians, range in metres,
 * temperature in Kelvin, draw in kW.
 *
 * INTENSITY IS IN THE RENDERER'S ILLUMINANCE UNITS, NOT CANDELA. One unit is
 * about 1017 lx, because SKY.SUN_INTENSITY_NOON = 118 stands for a ~120,000 lx
 * noon sun. These used to be quoted in raw candela and passed straight into
 * addLight, which made them ~1017x over-scale: the wide beam delivered 921 units
 * on the sand against the sun's 18.7, i.e. 49x the sun, and the vessel's own
 * lamps stopped the whole frame down by a measured 9.8% in broad daylight.
 *
 * Sized at roughly 3x physical, which is invisible against daylight (1/500 of the
 * noon sun on sand at 4 m) and still the dominant light at depth, where the
 * sun-driven ambient measures 0.0021 at 118 m.
 *
 * `cone` AND `coneInner` ARE FULL APEX ANGLES, NOT HALF-ANGLES, because
 * renderer.addLight() halves whatever it is given. DESIGN/04.6.1 quotes
 * half-angles, so every number here is twice its entry in that table, and the
 * shipped values were HALF what the design asked for - the flood's 0.30 rad is
 * an 8.6 deg outer half-angle against an authored 17 deg, i.e. 26% of the
 * intended projected area. That is what a playtest reported as "2 bright circles
 * ... the effect is not very appealing", and it was a cone width, not a power
 * budget: converted into these units the flood's authored 78,000 cd is 76.7 and
 * it already ships at 120.
 *
 * `coneInner` is AUTHORED rather than a fraction of `cone`. It used to be
 * `cone * 0.62` here, `cone * 0.55` for the player lamp and `cone * 0.7` for the
 * lens glow - three different magic numbers standing where one design quantity
 * belongs, and the lens therefore drew a core the beam did not have.
 *
 * `fill` / `fillPower` are the broad skirt, `vol` is how much of the beam
 * scatters in the water, `falloff` bends the inverse square. Each is documented
 * at the shader site that consumes it - spotAttenuation() and
 * punctualAttenuation() in shaders/common/lighting.wgsl, froxelPunctual() in
 * shaders/sim/froxel_inject.wgsl - and each has an IDENTITY value (0, 1, 1, 0)
 * that reproduces the pre-shape image exactly, so any of them can be bisected
 * live from tools/probe.mjs against the old picture.
 *
 * `vol` began as DESIGN/04.6.3's volumetric weight table (floods 1.00, work
 * 0.85), authored when the vessel was specified and read by nothing until the
 * froxel injection learned it. The 2026-08-18 drastic pass then CUT the
 * shipped weights - FLOOD 0.30, WORK 0.50 (and PLAYER_LAMP 0.35) - because at
 * the authored values a deep frame photographed the beam's own scattered
 * light instead of what the beam was pointed at.
 */
export const VESSEL_LIGHTS = {
  FLOOD:  { id: 'flood',  name: 'Forward Floods',  intensity: 120,  cone: 0.5934, coneInner: 0.3142, range: 165, kelvin: 5200, draw: 0.52, count: 2, fill: 0.08, fillPower: 2.2, vol: 0.30, falloff: 0.35 },
  WIDE:   { id: 'wide',   name: 'Wide Beams',      intensity: 40,   cone: 1.3614, coneInner: 1.1868, range: 62,  kelvin: 4400, draw: 0.31, count: 2, fill: 0.20, fillPower: 1.3, vol: 0.35, falloff: 0.25 },
  WORK:   { id: 'work',   name: 'Underside Lamp',  intensity: 26,   cone: 1.25,   coneInner: 0.9599, range: 34,  kelvin: 3600, draw: 0.19, count: 1, fill: 0.15, fillPower: 1.5, vol: 0.50, falloff: 0.20 },
  CABIN:  { id: 'cabin',  name: 'Instrument Glow', intensity: 1.2,  cone: 3.14,   coneInner: 2.198,  range: 4.5, kelvin: 2700, draw: 0.04, count: 1, fill: 0.00, fillPower: 1.0, vol: 0.00, falloff: 0.00 },
  STROBE: { id: 'strobe', name: 'Emergency Strobe',intensity: 75,   cone: 6.28,   coneInner: 4.396,  range: 90,  kelvin: 6500, draw: 0.09, count: 1, fill: 0.00, fillPower: 1.0, vol: 1.40, falloff: 0.00 },
};

/**
 * The suit lamp. Same units and the same four shape fields as VESSEL_LIGHTS.
 *
 * Here rather than in entities/player.js because constants.js is the single
 * source of truth for tuned numbers, and because RENDER and this object are read
 * fresh every frame - which is what makes every value below bisectable live from
 * tools/probe.mjs without a reload, the way SURFACE_BODY_PHYSICAL_RED is.
 *
 * DESIGN/05.7.5 authors 11 / 27 deg HALF-angles and 1,900 lm; doubled for the
 * full apex angle that is 0.3840 / 0.9425 rad, against a shipped 0.62 outer
 * (17.8 deg half). Intensity is left where it was: 1,900 lm over a 27 deg cone
 * is 2,774 cd = 2.7 in these units, so 26 is already 9.5x the authored lamp and
 * the fault was never that it was dim.
 *
 * MOUNT is the offset from the EYE, in the player's own frame (x right, y up,
 * z back). It is a HAND, not a headlamp: at the old 0.14 m the light vector and
 * the view vector agreed to within 3 deg at every useful range, so every lit
 * surface was shaded at its own N.V and the beam read as flash photography - a
 * bright decal with no form. At 0.30 m out and 0.28 m down the separation is
 * 8-9 deg at 3 m, which is enough for the terrain's real relief normals
 * (pass/terrain.wgsl's physical dh/dx) to show shape at the range where the lamp
 * is actually bright. It also moves the backscatter halo off the centre of view.
 */
export const PLAYER_LAMP = {
  /** 5,200 K on the Planckian locus, linear RGB, luminance 1. */
  color: [1.325, 0.926, 0.775],
  intensity: 26,
  range: 48,
  cone: 0.9425,
  coneInner: 0.3840,
  fill: 0.15,
  fillPower: 1.6,
  vol: 0.35,
  falloff: 0.35,
  mount: [0.30, -0.28, 0.0],
};

// ===========================================================================
// RENDERING
// ===========================================================================

export const RENDER = {
  NEAR_PLANE: 0.08,
  /** Reverse-Z + infinite far plane: no far clip, but this bounds culling. */
  MAX_VIEW_DISTANCE: 4000,
  SHADOW_FAR: 420,

  /** Camera-relative rendering: rebase the origin when the camera moves this far. */
  REBASE_RADIUS: 2048,

  /**
   * Time constant, seconds, for the optical water column to follow the biome the
   * camera is in. A biome boundary is a line on a map, but a real optical water
   * mass changes over minutes - and stepping every coefficient in a single frame
   * recolours the whole screen at a position the player can stand astride.
   */
  WATER_BLEND_TAU: 2.0,

  /**
   * How much of the PHYSICAL red the water-leaving radiance gets back, against
   * the art-cut red the sight path and the illuminant keep. 0 reproduces the
   * post-2ba914e build byte for byte, 1 is full Jerlov. See the
   * `surfaceSigmaA` / `surfaceKd` block on WATER_TYPES for the argument.
   *
   * This is the knob that decides whether a reef read from the air is turquoise
   * or grey-blue, and it is bisectable because the mix happens in the shader
   * (common/water.wgsl surfaceKd/surfaceSigmaT) off a value re-read from this
   * object every frame - so a probe can A/B it live, in one session, without
   * disturbing TAA history or exposure state.
   *
   * Measured on oceanBodyColour over REEF_TURQUOISE's own carbonate sand, hue
   * and HSV saturation, at 0 against 1: 2 m 245.1 deg / 0.057 -> 185.7 / 0.606;
   * 4 m 234.6 / 0.202 -> 192.9 / 0.858; 8 m 233.5 / 0.429 -> 203.7 / 0.972. It
   * REMOVES light rather than adding it (that band's Rec709 luma drops 18.2%),
   * which is why it does not run into the AgX shoulder the way raising an
   * emitter's brightness does.
   */
  SURFACE_BODY_PHYSICAL_RED: 1.0,

  /**
   * How far the diffuse in-scatter is pushed toward the local biome's authored
   * `fogTint` chromaticity. 0 = the old behaviour (one sky-coloured haze
   * everywhere), 1 = the in-scatter takes the biome's hue outright at unchanged
   * luminance.
   *
   * THIS IS THE LARGEST SINGLE LEVER ON WHETHER TWO BIOMES LOOK DIFFERENT, and
   * the reason is arithmetic rather than aesthetic. Measured by live A/B on the
   * float16 `sceneColor` readback, the additive in-scatter is 92-94% of the
   * pixel at the Coral Garden anchor (13 m, REEF_TURQUOISE) and 57-77% at the
   * Shallow Reef (8 m); everything else in the frame - seabed albedo, scatter
   * albedo, fluorescence - is fighting over the remaining 6-43%. Before this
   * existed the in-scatter had NO per-pixel and no per-biome input at all: its
   * source was `ambientSH[0] * WATER_SKY_SHARE * daylightAtDepth(depth)`, every
   * factor of which is a per-frame scalar, so the composite added the identical
   * colour to every pixel of the frame. Measured consequence: the frame's own
   * log2(R/B) spread was 0.303 stops and log2(G/B) 0.071 stops - every pixel the
   * same colour to within 5% in green - and the fraction of any underwater frame
   * more than 40 degrees of hue from its own dominant was 0.00%, against
   * 6.6-77% for the art-direction reference frames.
   *
   * The authored tints span 2.907 stops of R/B (Kelp Forest -1.263 to Trench
   * Floor -4.170) and 2.087 stops of G/B, i.e. roughly 10x the separation the
   * frames carried, landing on the only part of the pixel with any weight.
   *
   * NOT 1.0, because the tints are authored as absolute haze colours rather than
   * as chromaticities and a few of them are very nearly monochromatic blue; at
   * full strength the trench reads as a colour-separation error rather than as
   * water. 0.85 keeps the biome unmistakable and leaves the sky's own colour
   * faintly present, which is also what the reference frames do.
   *
   * 2026-08-18: 0.85 -> 0.95 in the drastic pass, judged on the d2-* frames.
   * The trench-monochrome concern above is muted in practice because the
   * aphotic gate collapses the composite to pure transmittance below 520 m -
   * the veil this knob tints does not exist down there; the 320-520 m
   * transition band is where to look if a colour-separation read ever comes
   * back.
   */
  WATER_FOG_TINT_STRENGTH: 0.95,

  /**
   * Maximum cut to the diffuse in-scatter veil for a submerged eye at shallow
   * depth and short/medium range. This is a contrast control, not less water:
   * the cut fades away from 12-45 m of sight distance and 35-90 m of camera
   * depth, leaving distant scale, deep atmosphere, and the collimated beam
   * untouched. Zero reproduces the previous image exactly for live A/B tests.
   */
  SHALLOW_VEIL_REDUCTION: 0.55,

  /**
   * Live gain on the diffuse in-scatter veil — multiplies the compile-time
   * WATER_DIFFUSE_SIDESCATTER (water.wgsl) for the WHOLE water column, at
   * every distance and depth, on the diffuse term only: the collimated solar
   * beam, transmittance, deep tint and deep key are untouched. This is the
   * master "milk" control the 2026-08 clarity pass added; identity 1.0
   * reproduces the pre-pass image exactly and is the bisect.
   *
   * Landed at 0.4 on 2026-08-17 from two instruments: the five-arm probe
   * sweep tools/probes/veil-sweep.js (arms 1.0/0.8/0.65/0.5/0.4, one process,
   * one Coral Garden pin) measured delivered-centre-crop contrast CV rising
   * monotonically 0.2175 -> 0.2655 over 1.0 -> 0.4 while auto-exposure held
   * meanL within 3%; the shot list tools/shots/veil-ab.json (gain arms
   * 1.0/0.5/0.35, plus chroma combos, three framings) was the looked-at
   * visual half. CUT AGAIN to 0.22 in the 2026-08-18 drastic pass after the
   * playtest reported the shallows still milky - judged on the reshot d2-*
   * frames (tools/shots/drastic-after.json) against the art-direction
   * references: the open-water band finally reads as saturated deep blue,
   * and the near field keeps its snow and distance cue - the beam,
   * transmittance and deep tint are untouched, so water still reads as water.
   */
  VEIL_DIFFUSE_GAIN: 0.22,

  /**
   * Chroma boost on the veil's fog tint: localWaterTint() raises the
   * unit-luma tint to the power (1 + VEIL_CHROMA) and renormalises to unit
   * Rec709 luma, so the haze gets more SATURATED without gaining or losing
   * energy — auto-exposure cannot see this knob. 0.0 is the exact previous
   * expression and is the bisect. The reference look keeps the distance fog
   * more saturated than the props in front of it.
   *
   * Landed at 0.7 from the same veil-ab sweep: 0.5 and 0.8 both read richer
   * than 0.0 at the coral horizon framing with no measurable energy shift
   * (the term is unit-luma by construction). Raised 0.7 -> 1.0 in the
   * 2026-08-18 drastic pass alongside WATER_FOG_TINT_STRENGTH 0.85 -> 0.95,
   * judged on the d2-* reshoot - the kelp forest's haze finally separates
   * from its blades instead of sharing one mid-green.
   */
  VEIL_CHROMA: 1.0,

  /**
   * Chromaticity of the SUBMERGED water medium itself, 0..1. 1.0 is the
   * authored spectral column exactly (the bisect, and the identity); 0.0 is
   * ACHROMATIC water - every channel of sigmaT, sigmaS and Kd collapsed to
   * the vector's own MIN channel (the least-attenuated channel carries the
   * delivered image, so brightness and sight range hold while the spectrum
   * flattens; the per-vector MEAN was tried and buried the scene 10x, see
   * the pack site) - so the medium still absorbs, scatters and darkens with
   * distance and depth, but SPECTRALLY FLAT: no red is preferentially
   * removed by the sight path or by the daylight column, and a red coral at
   * 40 m photographs red. deepTint is EXEMPT - it is the water body's own
   * colour, not a filter on objects, and collapsing it turned daylight
   * shallows grey while buying no subject accuracy (the exemption's
   * rationale is at the pack site); the sea stays blue at every setting. This is
   * the "how much colour does the WATER add" master, distinct from the two
   * haze-hue knobs (WATER_FOG_TINT_STRENGTH tints the veil by biome,
   * VEIL_CHROMA saturates that tint) - at 0 with those two also 0 the frame
   * is the closest this renderer gets to "accurate colours underwater".
   *
   * Applied at the ONE pack site in renderer.js where the sprung column
   * enters the Frame uniform, so every consumer - sight extinction, the
   * diffuse veil, the solar column, the deep tint - moves coherently and a
   * console write lands in ONE frame with no WATER_BLEND_TAU ramp. Means
   * are taken per vector, so sigmaS <= sigmaT survives channelwise and the
   * single-scattering albedo stays physical. Deliberately NOT applied to
   * the above-water surface column (surfaceSigmaA/surfaceKd - the lagoon
   * turquoise a flyover reads) or to the offline classifier, which read the
   * raw tables. Live-mutable: RENDER.WATER_CHROMA = 0 in the console.
   */
  WATER_CHROMA: 1.0,

  /**
   * Global scale on marine-snow density, multiplying marineSnowDensity()'s
   * output after the per-water-type snowMultiplier. Snow is an alpha-over
   * veil in the composite, so it eats contrast independently of the medium;
   * this knob exists so the clarity pass can cut it without re-authoring the
   * per-type rows. Identity 1.0 is the bisect.
   */
  SNOW_DENSITY_SCALE: 0.55,

  /**
   * Live gain on the froxel volume's COLLIMATED solar shaft underwater - the
   * god-ray term - injected in sim/froxel_inject.wgsl. The punctual lamps and
   * waterInScatter's analytic beam branch never carry it, so at any value
   * other than 1.0 a frame whose beam the froxel does NOT own renders its
   * shaft at 1.0x - an accepted, documented asymmetry (see the injection
   * site). Identity 1.0 is the bisect. The
   * shafts are the Subnautica sun signature; the clarity pass runs them
   * slightly hot now that the diffuse veil no longer buries them.
   */
  SOLAR_SHAFT_GAIN: 1.6,

  /**
   * Strength of BIOMES[].sightDensity on a submerged view path. Zero is
   * the previous physical-density image; one is the authored demo visibility.
   * It never changes Kd or the above-water surface column.
   */
  SUBMERGED_VISIBILITY_STRENGTH: 1.0,

  /**
   * How much of the authored marine-snow load a CAVE INTERIOR removes, 0..1.
   * 0 reproduces the open-water image exactly; 1 is snowless.
   *
   * This is the ONE optical lever the cave interior still had. The IN_CAVE
   * composite gate in pass/underwater.wgsl already drains 85% of the
   * daylight-derived in-scatter AND the deep key through its `enclosure` mix
   * (both are open-column quantities a roof occludes), and deliberately lets
   * the froxel lamps and the marine snow through in full - but the snow field
   * is authored per WATER TYPE, i.e. for the open column above the roof, and
   * a sealed chamber has neither the surface detritus rain nor the current
   * that keeps it suspended. Removing most of it is what reads as STILL.
   *
   * Applied CPU-side in main.js._updateWaterColumn as a multiplier on the
   * spring TARGET of `snowMultiplier`, gated on the same per-frame
   * `game.inCave` flag that drives FLAG_IN_CAVE - so it rides the existing
   * WATER_BLEND_TAU spring (no pop at the mouth), reaches the shader through
   * the `frame.waterBottom.w` slot that already exists, and is bisectable
   * live from the console with no shader or Frame-layout change.
   *
   * Measured at the First Hollow chamber (1903, -664, 1349), sceneColor
   * readback, suit lamp on, settled: see the P4-B report for the A/B pair
   * (knob 0 vs shipped) - the term this scales is the near-field mote layer,
   * which is most of what moves in a lamp-lit cave frame.
   */
  CAVE_SNOW_REDUCTION: 0.75,
  /**
   * How much of the open-column daylight in-scatter and deep key the
   * underwater composite drains inside a carved cave void, 0..1. Was a 0.85
   * shader literal on the raw IN_CAVE flag - the one term on the cave-medium
   * chain that was not console-bisectable, and a one-frame binary step that
   * the P4 review measured strobing the whole haze at a 16 m mouth. Now the
   * spring target in main.js._updateWaterColumn (WATER_BLEND_TAU, same
   * spring as the snow half), delivered via frame.caveMedium.x. 0 reproduces
   * the open-water image exactly.
   */
  CAVE_ENCLOSURE: 0.85,
  /**
   * How far the underwater composite neutralises the CHROMA of the sight
   * path's beam extinction inside a cave, 0..1: sigmaT is mixed toward its
   * own Rec709 luma by (enclosure x this) before the drained-branch
   * transmittance, so authored colour - the Jellyshroom Hollow's magenta
   * caps, the geode's teal film - survives chamber-scale sight lines instead
   * of arriving blue. Energy is preserved (the luma rate still extincts);
   * only the per-channel spectrum flattens. A DEMO-FIRST art deviation by
   * explicit 2026-08-18 user instruction ("more important to have beautiful
   * vibrant colors" than open-ocean red absorption), scoped to enclosed
   * voids where the open-column spectrum was never measured anyway. Rides
   * the enclosure spring (renderer.js packs the product into
   * frame.caveMedium.y), so it fades over WATER_BLEND_TAU at every mouth.
   * 0 is bit-for-bit the open-water image everywhere, cave included.
   */
  CAVE_SIGHT_NEUTRAL: 0.9,

  /**
   * The Jellyshroom Hollow cap lights (render/passes/caves.js
   * submitJellyLights): every authored shroom of height >= JELLY_LIGHT_MIN_
   * HEIGHT submits a point light at its cap centroid, intensity
   * JELLY_LIGHT_INTENSITY x scale^2, nearest JELLY_LIGHT_MAX only, volumetric
   * so the froxel volume carries the purple glow through the water (the one
   * in-scatter term the cave enclosure drain deliberately spares). The colour
   * is the cap palette's hue as a unit-peak triple, the same normalisation
   * submitLights derives for scatter beacons. INTENSITY 0 is the whole-
   * feature bisect: no lights, no froxel injection, caps reduced to their own
   * surface emission.
   */
  JELLY_LIGHT_INTENSITY: 30,
  JELLY_LIGHT_COLOR: [1.0, 0.32, 0.88],
  JELLY_LIGHT_MAX: 8,
  JELLY_LIGHT_MIN_HEIGHT: 6,

  /** Clustered forward+ light culling grid. */
  CLUSTER_X: 16, CLUSTER_Y: 9, CLUSTER_Z: 24,
  MAX_LIGHTS: 256,
  MAX_LIGHTS_PER_CLUSTER: 32,

  /**
   * The cluster grid's DEPTH bounds, mirrored out of common/lighting.wgsl:32-37.
   *
   * THESE ARE THE RECEIVER'S NUMBERS AND THE CULL PASS MUST USE THEM. They are
   * here because sim/cluster_cull.wgsl deliberately does not include frame.wgsl
   * (it claims group 0 for its own bindings), so it cannot see the receiver's
   * `const CLUSTER_NEAR` - and passes/clusters.js fed it `cam.near` (0.08) and
   * `MAX_VIEW_DISTANCE` (4000) instead, which is the wrong grid entirely. See
   * CLUSTER_CULL_UNION for the measurement of what that cost.
   *
   * If common/lighting.wgsl's three constants ever move, these move with them:
   * the cull pass and the receiver must slice z identically or a fragment reads
   * another cluster's light list.
   */
  CLUSTER_NEAR: 0.25,
  CLUSTER_FAR_AIR: 640,
  CLUSTER_FAR_WATER: 140,

  /**
   * 1 to slice the cull grid the way the RECEIVER slices it; 0 to keep the
   * shipped `cam.near`..`MAX_VIEW_DISTANCE` slicing. Compile-time (it reaches
   * sim/cluster_cull.wgsl as a preprocessor define), so a change needs a reload,
   * not a live poke - but 0 reproduces the previous image byte for byte and that
   * is what makes the fix below bisectable on its own, separately from
   * DEEP_BEACON_COUNT / DEEP_FILL_COUNT.
   *
   * THE BUG IT FIXES, IN ARITHMETIC. Both sides slice z geometrically over 24
   * slices. The receiver (common/lighting.wgsl clusterSliceFromViewDepth) uses
   * 0.25 m .. 140 m submerged, ratio 1.3017 per slice. The cull pass was handed
   * 0.08 m .. 4000 m, ratio 1.5695. They agree only at slice 0. Worked examples,
   * submerged:
   *
   *   fragment at  5 m -> reads cluster slice 11, which the cull filled from
   *                       the 11.4-17.9 m slab
   *   fragment at 20 m -> reads slice 16, filled from 108.7-170.5 m
   *   fragment at 40 m -> reads slice 19, filled from 420-659 m
   *
   * A light only survives that by being big enough for its BOUNDING SPHERE to
   * reach the mismatched slab, so the vessel's 165 m floods mostly worked and
   * everything small did not: a creature light (range <= 45 m) reaches nothing
   * past about 12 m of view depth, and a 6-14 m fill light reaches almost
   * nothing at all. It is a large part of why the punctual term has never been
   * visible in the deep, and it would have silently eaten this whole item.
   *
   * WHY A UNION AND NOT THE EXACT GRID. The receiver's far plane switches with
   * the medium (640 m in air, 140 m submerged) and the cull pass has no frame
   * uniform to read the latched flag from, so it builds each slice's AABB as the
   * UNION of the air slab and the water slab of the same index. A union is
   * CONSERVATIVE - it can only offer a cluster more lights than it needs, never
   * fewer - so the receiver's list is always a superset of the correct one, in
   * either medium. The cost is measured as cluster occupancy, not argued.
   */
  CLUSTER_CULL_UNION: 1,

  // ---- deep scatter lights (render/passes/scatter.js submitLights) ---------
  //
  // ~800 emissive props are drawn per deep chunk and every one of them is a
  // self-lit decal: a glowcup pools no light on the sediment under it, a vent
  // chimney does not light its own plume. renderer.addLight() had exactly four
  // call sites (vessel, player, habitat, creatures) against MAX_LIGHTS 256, of
  // which the deep scene used 6-12. These promote a bounded, ranked subset of
  // the emissive scatter to real punctual lights on the existing cluster path.
  //
  // BISECT: DEEP_BEACON_COUNT = 0 and DEEP_FILL_COUNT = 0 reproduce the
  // previous image exactly, live, with no reload.

  /**
   * Beacons: the LARGE, biome-defining emitters, drawn ONLY from the signature
   * rows plus DEEP_BEACON_EXTRA. They carry `volumetric: 1.0`, so they are the
   * only new lights that enter the froxel injection loop.
   *
   * RANKED BY SIGNATURE MEMBERSHIP, NOT BY FLUX, AND THAT IS THE WHOLE RULE.
   * The derivation and the per-type table are at the top of the deep-lights
   * section in render/passes/scatter.js; the short version is that the largest
   * non-fluorescing emitter four of the seven deep biomes actually carry is a
   * SHARED prop, and at two of those four it is the exact form the biome brief's
   * Avoid column names. Measured with the classes separated at four deep
   * anchors, the FILL class ON ITS OWN puts mushroomCluster (0.471 share at
   * Twilight Terraces) and mushroomCap (0.462 at Abyssal Plain) on top; the
   * beacon class carries 0.98-1.00 of its own arm; and the two together deliver
   * 0.66-1.00 of the submitted intensity to a signature form at every one of
   * the seven deep anchors, with no Avoid form above 0.065 anywhere.
   */
  DEEP_BEACON_COUNT: 10,
  /** Metres a beacon candidate may be from the eye. */
  DEEP_BEACON_SEARCH: 160,
  /**
   * Culling-radius ceiling for a beacon. See DEEP_LIGHT_CUTOFF_E for where the
   * radius itself comes from; this bounds the cluster-occupancy cost, and 40
   * rather than 50 is measured: at 50 the two most enclosed deep anchors sit at
   * p99 16 (Rock Spires) and 18 (Canyon Wall) against the < 16 gate, and 40 with
   * the fill class at 12/8 m brings them to 15 and 13.
   */
  DEEP_BEACON_RANGE_MAX: 40,

  /**
   * Scatter type KEYS that are beacon-eligible without carrying a
   * `signatureBiome`: the two landmark forms large enough to define a skyline.
   * Resolved to ids at boot, and an unknown key is a hard console error rather
   * than a silent drop, because a typo here is invisible in the frame.
   *
   * crystalSpire is Rock Spires' authored identity and Trench Wall's kept form;
   * ventChimney is Trench Wall's and Trench Floor's. ventChimney is on Canyon
   * Wall's Avoid ("trench vent garden"), and the world places exactly ONE
   * instance of it in Canyon Wall - measured over 111 chunks by
   * censusTypeByBiome, which is also why world/scatter.js carries no Canyon Wall
   * biomeTint for it.
   */
  // `wallLattice` and `terraceShelf` are here rather than carrying
  // `signatureBiome` because all twelve underwater biomes already have one and
  // test-scatter asserts exactly twelve. They are item 3.2's two exclusive
  // shapes, they emit at 0.9 and 1.1, and a beacon is what makes an emitter's
  // shaft enter the froxel injection - which for a form whose whole identity is
  // that you can see THROUGH it is most of the effect.
  DEEP_BEACON_EXTRA: ['crystalSpire', 'ventChimney', 'wallLattice', 'terraceShelf'],

  /**
   * Fill: ordinary emitters close to the eye, so a glowcup pools light on the
   * sediment it stands on. `volumetric: 0`, so fill never enters the froxel
   * loop - it is contact light, not atmosphere.
   *
   * TWELVE, NOT THE FORTY THE PLAN ASKED FOR, AND CLUSTER OCCUPANCY IS WHY.
   * Fill lights all sit inside DEEP_FILL_SEARCH of the eye, i.e. in the near
   * slices where clusters are small and a sphere covers many of them, so this is
   * the class that drives occupancy. Measured p99 lights per cluster at Canyon
   * Wall, everything else held: 40 lights at 14 m -> 27, 24 at 12 m -> 23, 16 at
   * 10 m -> 18, 12 at 8 m -> 13. At Rock Spires the same ladder reads 16 / 16 /
   * 16 / 15. The acceptance gate is p99 < 16, and it is a real gate: at 40/14 m
   * with the shorter ranges this class also drove 2,053 clusters to the
   * MAX_LIGHTS_PER_CLUSTER cap at Canyon Wall, where the cull pass truncates
   * SILENTLY and keeps the lowest-indexed lights rather than the nearest.
   */
  DEEP_FILL_COUNT: 12,
  /** Metres a fill candidate may be from the eye. */
  DEEP_FILL_SEARCH: 35,
  /** Culling-radius ceiling for a fill light. See DEEP_FILL_COUNT. */
  DEEP_FILL_RANGE_MAX: 8,
  /**
   * Most fill slots ONE type may hold. Without it the fill class collapses onto
   * whatever the brightest shared form in the biome is - measured, the fill
   * class ON ITS OWN is 47.1% mushroomCluster at Twilight Terraces and 46.2%
   * mushroomCap at Abyssal Plain - and the Avoid column is lost in the lighting
   * even after Stage 3 removes it from the geometry. Four of twelve slots caps
   * one form at a third of the class.
   */
  DEEP_FILL_PER_TYPE: 4,

  /**
   * Exclusivity exponent on the ranking score: a candidate's delivered
   * illuminance is divided by popcount(type.biomes) ^ this.
   *
   * `biomes` is shipped data, so this needs no second table and cannot rot: a
   * signature row lives in ONE biome and pays nothing, mushroomCap and glowPod
   * live in FIVE and pay 25x at exponent 2. It is a RANKING weight only and
   * never touches the light's intensity - the intensity is the mesh's own
   * radiant intensity and nothing else, for the reason creatures.js states at
   * submitLights().
   */
  DEEP_LIGHT_EXCLUSIVITY_POW: 2,

  /**
   * Irradiance, W/m^2, at which a light stops being worth a cluster slot. The
   * culling radius is sqrt(I / this), clamped to [DEEP_LIGHT_RANGE_MIN, the
   * class ceiling] - so range is DERIVED from the mesh's own flux rather than
   * authored per class, and a dim signature gets a small sphere instead of an
   * empty 30 m one.
   *
   * WHERE THE NUMBER COMES FROM, AND IT IS NOT A FUDGE: it is the cutoff the
   * shipped lamps were already authored against. PLAYER_LAMP is 26 W/sr at a
   * 48 m range, i.e. 26/48^2 = 1.13e-2 W/m^2; the vessel's work lamp reads
   * 26/34^2 = 2.2e-2 and its forward flood 120/165^2 = 4.4e-3, so the three
   * bracket this within 2.6x either way. Water transmittance, which this does
   * not model, cuts the true reach well inside the class ceiling in every water
   * type except ABYSSAL_VOID.
   *
   * A 25.6x LOWER CUTOFF WAS TRIED AND REJECTED, on the argument that the deep
   * stations run at a measured auto-exposure gain of 25.6 and a dark-adapted eye
   * therefore sees 5x further. It is not wrong about the eye and it is wrong
   * about the cost: every beacon's derived radius then saturates at the class
   * ceiling, the derivation stops discriminating, and cluster occupancy p99 goes
   * 13 -> 32 at Canyon Wall with 2,053 clusters at the truncation cap and 44 at
   * Twilight Terraces. Delivered scene luminance between the two cutoffs differs
   * by under 5% at all four anchors measured. The reach is bought and not paid
   * for.
   */
  DEEP_LIGHT_CUTOFF_E: 1.13e-2,
  /** Culling-radius floor. Below this a light is not worth submitting at all. */
  DEEP_LIGHT_RANGE_MIN: 6,

  /**
   * Fractional margin a challenger must beat an incumbent by to take its slot.
   *
   * FROXEL_HISTORY_BLEND is 0.90 with no neighbourhood clamp - about ten
   * effective frames - so a light that switches off trails for ~83 ms. Two
   * candidates trading a slot every other frame therefore reads as a flicker in
   * the volume, not as a swap. This margin is load-bearing, not polish.
   */
  DEEP_LIGHT_HYSTERESIS: 0.25,

  /**
   * Camera depth (m) at which scatter lights start, and the fade below it.
   *
   * Above this there is daylight, a cast shadow and caustics doing the same job
   * better, and the shallow biomes' emitters all FLUORESCE - they are pumped by
   * surviving blue daylight and are excluded from promotion anyway, for the
   * reason glow.js gives at its own scatter gate. Boulder Field's anchor sits at
   * 97 m, so the fade has to be complete by then or the first biome the item is
   * graded on gets a fraction of the light.
   */
  DEEP_LIGHT_MIN_DEPTH: 55,
  DEEP_LIGHT_FADE_M: 35,

  /**
   * Multiplier on the promoted light's radiant intensity. IT IS 1.0 AND IT
   * SHOULD STAY 1.0.
   *
   * The intensity is `typeEmit.flux`, the same W/sr the geometry radiates and
   * the same quantity glow.js gives the sprite, so the prop, its aureole and
   * its light cannot disagree about how bright the prop is. creatures.js
   * removed exactly such a constant (a 3.5x lure multiplier, and before that a
   * 11,700x one) and documents why. It exists as a knob only because an A/B of
   * the whole item against a REACH change is otherwise impossible; a value
   * above 1 is a bug report, not a tuning.
   */
  DEEP_LIGHT_GAIN: 1.0,

  /**
   * ===========================================================================
   * THE DEEP KEY. What the composite mixes toward once the daylight window has
   * shut, instead of nothing.
   * ===========================================================================
   *
   * Five constants follow and this block is the argument they share.
   *
   * WHAT IT REPLACES. `pass/underwater.wgsl` ends its medium branch with
   * `lit = mix(scene * waterTransmittance(wet), lit, aphoticFactor(camDepth))`,
   * and `aphoticFactor` is EXACTLY 0.0 at and below TRUE_DARK_DEPTH - measured
   * 1.0000 at 204 m, 0.1091 at 479 m, 0.0000 at 758 / 975 / 1032 m. Below that
   * the composite is a pure extinction operator: ambient, diffuse in-scatter,
   * deep tint and fog tint are all multiplied by zero, so a pixel with no lamp
   * on it delivers the depth grade's black lift on a scene value of ZERO. That
   * is ONE CONSTANT COLOUR - hue bin 19, saturation bin 7 of the variety tour's
   * 32x8 histogram, at every deep depth alike - and it held 82.2% and 88.1% of
   * the gated pixels of the Trench Wall and Trench Floor frames before item 2.1
   * and 74.1% / 86.0% after it, which is why those two frames score 0.984
   * against each other on a hue x saturation cosine. Hundreds of promoted
   * punctual lights moved that cell by 8 points; they cannot reach the far
   * field. THE KEY MOVES IT TO 46.8% / 66.3% and the pair to 0.925.
   *
   * THE DAYLIGHT WINDOW IS NOT REOPENED, AND THIS IS NOT DAYLIGHT.
   * `aphoticFactor` is untouched and every daylight-derived term still dies at
   * it; the key is a SECOND, authored source that opens on the complementary
   * gate `1 - aphoticFactor(camDepth)` - exactly 0.0 above 319.8 m, so no frame
   * shallower than that changes by a single bit, by construction rather than by
   * measurement. Physically it stands for what is actually down there once the
   * sun is gone: a whole water column of unresolved biology and mineral haze,
   * which is a real thing photographed at these depths and is not a beam.
   *
   * WHY IT IS THE ONLY TOOL THAT REACHES THE FAR FIELD. MEASURED with
   * `debugReadDepth` at the five deep anchors: `infFraction` - the share of the
   * frame with no geometry behind it at all - is 0.2085 / 0.1799 / 0.0348 /
   * 0.0000 / 0.0094 at spires / canyon / abyssal / trenchWall / trenchFloor.
   * The deep frame is NOT empty water. It is terrain, at a median of 11-40 m and
   * a p95 of 562-10,576 m, and it is unlit. A punctual lamp with a 34-60 m reach
   * cannot touch it (item 2.1 measured exactly that), and no water coefficient
   * can either, because every one of them is multiplied by the zero above. An
   * in-scatter term is the one thing that grows with the path in FRONT of a
   * surface, so it paints that relief as aerial perspective and puts a
   * silhouette wherever a near form crosses a far one.
   *
   * AUTHORED AS THE ASYMPTOTIC RADIANCE, NOT AS A SOURCE IRRADIANCE, and that
   * is a deliberate departure from how the solar beam is written. The delivered
   * chromaticity of a scattered source is `sigmaS/sigmaT` times the source's,
   * and that single-scattering albedo runs 0.090 / 0.143 / 0.462 in
   * ABYSSAL_VOID against 0.294 / 0.317 / 0.358 in NEPHELOID - so one authored
   * source colour would deliver a violet haze at the trench and an orange one at
   * the spires. `deepTint` is authored the same way, for the same reason.
   * The medium still decides how FAST the key builds up, through its own
   * per-channel sigma_t, which is what makes the near haze warmer than the far
   * haze: in ABYSSAL_VOID red builds 2.6x faster than blue and saturates 2.6x
   * lower.
   *
   * THE EXPOSURE RAIL IS THE BUDGET AND IT IS NOT WIDE. Auto-exposure sits on
   * its 25.6x ceiling at every deep station except Canyon Wall, which meters
   * 22.5-24.2 depending on framing and is therefore already live; the plan
   * allocates +0.8 EV to this item out of 2.87 EV of total headroom, and item
   * 2.1 has already spent 0.02-0.89. A key bright enough to unpin the rail does
   * not brighten the abyss, it greys it - auto-exposure takes the gain straight
   * back out.
   *
   * THE COLOUR IS VIOLET BECAUSE FOUR OTHER FAMILIES WERE MEASURED AND ALL FOUR
   * MADE IT WORSE, and the reason is the depth grade rather than taste. At
   * 971 m the grade multiplies scene red by 0.22 before AgX and then lifts the
   * black point by [0.081, 0.134, 0.226] in code space, so it funnels nearly
   * every scene colour into hue bin 19-20 - and bin 19 is exactly where the
   * black lift itself lands. Only a colour that moves the delivered pixel OFF
   * bin 19 buys anything. Matched A/B at Trench Wall and Trench Floor, hue
   * entropy at the two anchors / the cosine between them (the s23 shots,
   * everything else held, all at the shipped DEEP_KEY_G except the last):
   *
   *   key off                              0.984 / 0.555   0.98294
   *   violet  [0.55, 0.31, 1.00] x 6.5e-4  1.181 / 0.941   0.90953
   *   magenta [1.38, 0.18, 1.00] x 6.5e-4  1.180 / 1.074   0.95625
   *   teal    [0.31, 1.23, 1.00] x 6.5e-4  0.439 / 0.233   0.99969
   *   green   [0.30, 2.80, 1.00] x 5.0e-4  1.001 / 0.210   0.94801
   *   warm    [1.23, 0.69, 1.00] x 1.3e-3  0.414 / 0.224   0.99975  (g 0.55)
   *
   * Teal, green and warm all deliver INTO bin 19 and therefore reinforce the
   * black lift instead of displacing it: they put 92-97% of both frames' gated
   * pixels in that one cell, against 74-90% with no key at all, and take Trench
   * Floor's hue entropy from 0.555 down to 0.21-0.23. That is the measurement
   * behind "a brighter object is a whiter one" in a different guise - what the
   * deep needs is not more light, it is light of a colour the grade has not
   * already claimed.
   *
   * MAGNITUDE. The ladder at fixed colour ran 1x / 2x / 4x of this value and the
   * pair cosine went 0.955 / 0.976 / 0.989 (at g = 0.55): past about here BOTH
   * frames saturate to the key's own colour and become the same image again,
   * which is the same trap raising an emitter's brightness falls into. At 1x the
   * delivered median moves +7% at Trench Wall and +6% at Trench Floor - a
   * gradient the eye reads and the histogram can see, on a frame that still
   * looks like a kilometre down.
   *
   * WHAT IT COSTS ON THE RAIL, and it is a tenth of its allocation. Matched
   * same-frame A/B (`tools/probes/deepkey-budget.js` toggles the knob between
   * two readbacks of ONE settled frame, so nothing else in the scene can move):
   * scene-linear luminance rises +0.071 EV at Trench Wall and +0.049 EV at
   * Trench Floor against a control spread of +/-0.036 EV, and the delivered
   * auto-exposure gain reads its 25.6 ceiling in both arms at every station.
   * The reason it is so cheap is the reason it works: the key lands almost
   * entirely on the frame's DARKEST pixels, which contribute nearly nothing to
   * a mean.
   *
   * WHAT IT COSTS ELSEWHERE, stated because the next reader will measure it and
   * should not have to rediscover it. A SINGLE GLOBAL KEY MAKES THE DEEP LOOK
   * MORE LIKE THE MID-DEPTH. Measured on the 8-anchor tour, the pair this item
   * was aimed at falls (Trench Wall x Trench Floor 0.9841 -> 0.9249) and so do
   * Abyssal x Trench Wall (0.8905 -> 0.6375) and Canyon x Trench Wall (0.7287
   * -> 0.6119) - but Shelf Break x Trench Wall RISES 0.4601 -> 0.8391 and
   * Twilight Terraces x Trench Wall 0.8092 -> 0.9631, and the deep-seven mean
   * pairwise cosine goes 0.6725 -> 0.7076. The mechanism is not subtle: 180-200
   * m frames are lit by real daylight in-scatter, which the grade delivers into
   * the same hue bin the key does, so a trench that stops being black starts
   * resembling shallower water.
   *
   * THAT IS FIXED AND THIS CLAUSE IS KEPT AS HISTORY, because the paragraph
   * above described the shipped build for one stage and a reader who finds it in
   * the present tense will re-measure a cured fault - which has already cost
   * this file a whole tuning pass once (see the ROOM_CAVITY note in CLAUDE.md).
   * `RENDER.DEEP_KEY_PALETTE` below makes the CHROMATICITY per water column
   * while this constant keeps all of the energy, and the deep-seven mean is back
   * under its pre-key value. Read that block for what moved and what did not:
   * the trench's own row is deliberately null, and the collision was resolved by
   * moving Canyon Wall and Abyssal Plain instead.
   *
   * BISECT: `RENDER.DEEP_KEY_RADIANCE = [0, 0, 0]` reproduces the pre-key image
   * exactly, live, with no reload, AND IT STILL DOES WITH THE PALETTE IN - every
   * row is multiplied by this constant's luma, so zeroing it zeroes all of them
   * in the same frame rather than fading them out over the spring. The key is a
   * pure add and every other term is untouched. VERIFIED on the tour: at Boulder
   * Field, Shelf Break and Twilight Terraces (97-202 m, gate exactly 0) the ON
   * and OFF arms agree to four decimals on median luminance, hue entropy, flat
   * fraction and p95/p05.
   */
  // 2026-08-18: x2.2 from the measured [0.00036, 0.00020, 0.00065]. Every
  // ladder in this docstring block (the 1x/2x/4x pair-cosine run, the
  // +0.071 EV exposure-rail figure) was taken against the OLD magnitude -
  // read "this value" in those clauses as the pre-raise number. The authored
  // palette rows were rebalanced under the raise (HADAL 2.7, NEPHELOID 1.8,
  // ABYSSAL pinned at 0.4545); see each row.
  DEEP_KEY_RADIANCE: [0.00079, 0.00044, 0.00143],

  /**
   * Direction TO the key, world space, normalised on the CPU. Mirrors
   * `frame.sunDir`'s convention exactly, so the scattering cosine is
   * `dot(viewRay, keyDir)` in both and neither can pick up a sign error from the
   * other.
   *
   * MOSTLY UP, because that is the one gradient every framing gets. The
   * anchors' headings span the compass, so an azimuth-dominated key would be a
   * lottery on where the camera happens to point, while a vertical one gives
   * every deep frame the same top-lit-to-black vertical ramp regardless of
   * heading - which is also what the eye reads as "up" underwater and what
   * every deep frame in this project currently lacks. The horizontal component
   * is kept at about a third so the ramp RAKES rather than being a perfectly
   * symmetric dome, which is what separates a near ridge from the wall behind
   * it.
   *
   * FIXED IN WORLD SPACE, not slaved to the sun's azimuth. A key that swung
   * with the clock would re-frame every deep screenshot with the time of day
   * and would put daylight's signature back into the one region `aphoticFactor`
   * exists to remove it from.
   */
  DEEP_KEY_DIR: [-0.42, 0.86, 0.29],

  /**
   * Henyey-Greenstein asymmetry of the key's ANGULAR WEIGHT - not of the water,
   * which keeps its own `g` for the beam and the lamps.
   *
   * The weight is `4*PI*phaseHG(cos, g)`, which is MEAN 1 OVER THE SPHERE for
   * any g, so this redistributes the key and never changes how much of it there
   * is. That is the same discipline `causticFactor()` keeps and for the same
   * reason: a knob that changes energy while claiming to change shape drives
   * auto-exposure.
   *
   * MEASURED LADDER, matched A/B at Trench Wall and Trench Floor with everything
   * else held (the s23 shots, same boot, same radiance, hue x saturation
   * cosine between the two frames / Trench Wall p05 / Trench Wall p95/p05):
   *
   *   key off   0.98294 / 0.0551 / 5.261
   *   g = 0.35  0.96973 / 0.0740 / 3.921
   *   g = 0.55  0.95455 / 0.0695 / 4.174
   *   g = 0.75  0.90953 / 0.0644 / 4.498
   *
   * BOTH HALVES OF THAT MOVE THE SAME WAY AND THAT IS THE WHOLE ARGUMENT. A
   * flat key lifts the frame's darkest 5% - the black floor - by 34%, buys the
   * least separation, and is exactly the "grey soup" the daylight window was
   * closed to prevent. A tight one puts its light where the eye is looking and
   * leaves the anti-key hemisphere at 0.082 of the mean, so the floor moves by
   * 17% instead and the two frames stop being the same image.
   *
   * At 0.75 the weight runs 28.0 straight at the key, 0.22 across it and 0.082
   * away from it. NOTHING IN A LEVEL VIEW EVER SEES THE 28: the lobe is at half
   * maximum 13 degrees off axis, about a direction 59 degrees above the horizon,
   * so a level framing samples 0.1-1.2 of it. Looking UP does see it, and
   * deliberately: photographed at Trench Floor with the pitch at +57 degrees it
   * is a soft broad glow in the upper third with no rim and no core, which is
   * the only orientation cue the deep has ever had. At g = 0.90 the same framing
   * grows a distinct bright core and starts reading as a sun, which is why the
   * ladder stops at 0.75 even though 0.90 scores a lower pair cosine (0.855) -
   * it gets there by leaving Trench Floor almost unchanged (hue entropy 0.667
   * against 0.941 at 0.75) rather than by improving both frames.
   */
  DEEP_KEY_G: 0.75,

  /**
   * How much of the key is directional. `mix(1, weight, this)`, so 0 is a flat
   * ambient field and 1 is the lobe alone. Both ends are mean 1, so this is
   * also energy-neutral.
   *
   * 2026-08-18 drastic pass: 1.0 -> 0.55. At 1.0 a level or downward framing
   * sampled almost none of the key (the lobe sits 59 degrees up at g 0.75),
   * which is why every deep demo frame read as lightless in most directions -
   * the "nothing to see" report. 0.55 keeps the orientation cue (looking up
   * still finds the broad glow) while giving every ray a 45% ambient floor of
   * the key's own colour, so the per-place palette (ember at Emberthroat,
   * amber at the canyon, pale at the plain) actually bathes its place.
   */
  DEEP_KEY_DIRECTIONALITY: 0.55,

  /**
   * THE KEY'S COLOUR, PER PLACE. Indexed by WATER TYPE id, i.e. by the same
   * `wt.id` `WATER_BOTTOM_ALBEDO` is indexed by, and sprung in `renderer.js`
   * for the same reason that table is: `main.js` SNAPS the id and springs
   * everything else, so a table read straight off it steps in one frame at a
   * boundary the player can stand astride.
   *
   * WHY THIS EXISTS AT ALL, AND IT IS THE MEASURED FAULT OF THE SINGLE KEY
   * ABOVE. One global radiance is a COMMON-MODE term: it moved every deep frame
   * the same direction, so the frames it separated at one end of the histogram
   * collided at the other. Measured on the 14-anchor tour, before the key
   * (`variety-output/s1-done.json`) against after it (`s2.json`), the diagnostic
   * cell h19s7 and the cell its pixels landed in, h20s7:
   *
   *   Trench Wall    h19s7 0.822 -> 0.465   h20s7 0.160 -> 0.515
   *   Trench Floor   h19s7 0.881 -> 0.663   h20s7 0.096 -> 0.314
   *   Shelf Break    h19s7 0.136 -> 0.129   h20s7 0.781 -> 0.772  (gate 0)
   *   Twilight Terr. h19s7 0.331 -> 0.311   h20s7 0.389 -> 0.387  (gate 0)
   *
   * Shelf Break (180 m) and Twilight Terraces (202 m) are ABOVE the aphotic
   * gate and did not move by a bit - they already LIVED in h20s7, on real
   * daylight in-scatter. So the trench arrived in their cell and the pairs went
   * break x trenchWall 0.356 -> 0.842 and terrace x trenchWall 0.759 -> 0.962,
   * taking the deep-seven mean pairwise cosine 0.6674 -> 0.7074 - a regression
   * on the stage's own headline metric produced by three frames that each got
   * visibly better. A key that says the same thing everywhere is not a place.
   *
   * WHAT THE ROWS ACTUALLY REACH, because most of them are unreachable and
   * saying so is the difference between a palette and dead authored data. The
   * key is gated by `1 - aphoticFactor(cameraDepth)`, which is exactly 0.0 above
   * 319.8 m, so a row only paints where its water type occurs BELOW that. On the
   * tour: NEPHELOID at Rock Spires (365 m, gate 0.125) and Canyon Wall (503 m,
   * gate 0.978), HADAL_SUSPENSION at Abyssal Plain (758 m, gate 1.0),
   * ABYSSAL_VOID at Trench Wall (971 m) and Trench Floor (1028 m), both gate
   * 1.0. Every other row is a fallback for a column that has not been
   * photographed below 320 m, and `null` on it means "the master's own colour".
   *
   * AUTHORED AS A PALETTE, NOT AS PHYSICS - the same instruction `fogTint`
   * carries and for the same reason. `tint` is a CHROMATICITY: `renderer.js`
   * normalises it to unit Rec709 luma before use, exactly as it normalises
   * fogTint, so editing a row ROTATES colour and can never change energy. All
   * the energy is in `RENDER.DEEP_KEY_RADIANCE`, whose luma is the master
   * magnitude the +0.071 EV exposure-rail measurement was taken against, times
   * this row's `gain`. Setting DEEP_KEY_RADIANCE to [0, 0, 0] still reproduces
   * the pre-key image exactly, live, with no reload - the master multiplies
   * every row.
   *
   * THE COLOURS. The grade at these depths funnels nearly every scene colour
   * into hue bins 19-20, so a row only buys separation if it moves the delivered
   * pixel to a cell some other frame is not already in - which is why the
   * candidates were measured rather than picked. The measured ladder and the
   * delivered cells are recorded with the rows below.
   *
   * HOW THE LADDER FIGURES BELOW WERE TAKEN, so a later reader can reproduce
   * them and knows what they are not. `tools/shot.mjs` with a generated list:
   * one boot, `jumpTo` at the tour's own composed poses, day fraction 0.32, lamp
   * below 150 m, HUD and the DOM control legend hidden, 8 s settle, then
   * `tools/lib/frame-metrics.mjs` over the PNG under the tour's crop and gate.
   * That is a 1600x900 frame against the tour's 1600x757, so the ABSOLUTE cell
   * shares differ from `test-variety.mjs`'s by a point or two and only
   * arm-to-arm differences within one run are meaningful. The run-to-run spread
   * of the deep-seven mean on repeated identical arms is 0.013, which is the
   * noise floor every figure below should be read against. The control that
   * makes them believable is inside each run: every anchor whose water type the
   * arm did not touch repeats at a same-anchor cosine of 1.0000.
   *
   * WHAT IT DELIVERED, on the real instrument. `tools/test-variety.mjs`,
   * `variety-output/s4-perbiome.json` against `s2.json`, control passed with a
   * worst same-anchor self-cosine of 0.9933 against the 0.98 gate:
   *
   *   deep-seven mean pairwise cosine   0.7074 -> 0.6139   (0.6674 before the key)
   *   whole 14-anchor tour              0.2524 -> 0.2301   (0.2255 before the key)
   *   trenchWall x trenchFloor          0.9226 -> 0.9370
   *   underwater hue entropy, mean      1.4075 -> 1.4161
   *
   * and the diagnostic pair of cells, h19s7 / h20s7, at all seven deep anchors:
   *
   *   break        0.1290/0.7715 -> 0.1276/0.7681   (above the gate, unchanged)
   *   spires       0.2387/0.1284 -> 0.2329/0.0990
   *   terrace      0.3107/0.3869 -> 0.3094/0.3852   (above the gate, unchanged)
   *   canyon       0.4230/0.0000 -> 0.1705/0.0000
   *   abyssal      0.5237/0.0041 -> 0.4939/0.0010
   *   trenchWall   0.4649/0.5151 -> 0.4483/0.5316   (row null)
   *   trenchFloor  0.6634/0.3141 -> 0.6242/0.3532   (row null)
   *
   * THE PILE DID NOT MOVE TO A THIRD BIN, which is the thing to check and the
   * way this could have failed while scoring well. Canyon Wall's h19s7 fell by
   * 0.25 with its h20s7 still exactly 0.0000, so those pixels went to hues no
   * other frame in the tour is in rather than to the next cell along; Abyssal
   * Plain's fell 0.03 with h20s7 falling too. Attribution is in the pairs: of
   * the 0.0935 the deep-seven mean fell, 0.087 - 93% - is on the eleven pairs
   * containing Canyon Wall or Abyssal Plain, which are exactly the two anchors
   * these two rows paint.
   *
   * TWO THINGS IN THAT TABLE THIS PALETTE DID NOT DO, said plainly so the next
   * reader does not credit them to it. THE TRENCH MOVED SLIGHTLY WITH A NULL
   * ROW - trenchWall x trenchFloor 0.9226 -> 0.9370 and the four trench cells by
   * 0.017-0.039 - and it cannot be this change, because a null row packs the
   * byte-identical key the previous build packed. Both Stage 2 tours agreed on
   * 0.9226, so it is drift from work landing in the tree beside this (the branch
   * had eleven other files dirty at the time), and 0.9370 is still inside the
   * 0.95 requirement with the residual counted against it. AND THE TWO
   * INSTRUMENTS DISAGREE ON THE SIGN OF CANYON WALL'S OWN HUE ENTROPY: the shot
   * ladder reads +0.06 at gain 4 and the tour reads -0.04 (2.0415 -> 2.0006),
   * because a 1600x900 frame and a 1600x757 one at the same pose are not the
   * same picture - the taller crop takes in sky-side water the tour never sees.
   * The tour is the acceptance instrument and its -0.04 is the number to
   * believe; it is 6x the anchor's own run-to-run spread (0.0065) and it is
   * covered by Trench Floor's +0.038, which is why the 12-anchor mean still
   * rises. The shot ladder is retained above because its ARM-TO-ARM ORDERING is
   * what picked the gain, and that ordering is a within-run comparison.
   */
  DEEP_KEY_PALETTE: [
    // 0 OCEANIC_CLEAR - REACHABLE BELOW THE GATE AND UNPHOTOGRAPHED THERE.
    //   waterTypeAt's aphotic gate deliberately admits shelf water under a
    //   kilometre of ocean, and it measures 1,263 columns of it past 420 m, all
    //   Rock Spires or Twilight Terraces. Both of those anchors happen to
    //   classify otherwise on this tour (spires NEPHELOID, terrace above the
    //   gate), so there is no frame to author this row against and it keeps the
    //   master's colour until there is one.
    null,
    // 1 REEF_TURQUOISE, 2 COASTAL_GREEN, 3 MURKY_PARTICULATE - shallow-water
    //   columns. Above the gate the key is multiplied by exactly 0.0, so these
    //   rows can only ever matter if one is ever classified past 320 m.
    // 4 BRINE - REACHABLE past the gate since the Halocline Mirror place
    //   (world/places.js) put a 30 m brine lens at 641.9 m. It keeps the
    //   master colour until a frame is authored against it with the ladder
    //   discipline the rows below record; a key row is a measured decision,
    //   not a default to fill in.
    null, null, null, null,
    // 5 ABYSSAL_VOID - Trench Wall and Trench Floor. NULL, AND IT IS A REFUTED
    //   ITEM RATHER THAN AN UNTOUCHED ONE. This is the row the whole finding
    //   pointed at, and every way of moving it was measured and every one of
    //   them is worse. Matched arms, one boot, deep-seven anchors, the two
    //   trench frames' cells and their pair cosine:
    //
    //     COLOUR AT GAIN 1 BUYS NOTHING. Ladder [0.55,0.31,1] (the master) /
    //     [1.00,0.30,1] / [1.38,0.18,1] / [2.20,0.12,1]: Trench Wall h20s7
    //     0.452 / 0.459 / 0.484 / 0.489. Four-fold more red moves 3.7 points and
    //     NOTHING reaches bin 21 at any of them. The delivered hue is set by the
    //     depth grade's own black lift - [0.081, 0.134, 0.226] in code space,
    //     hue 218.1 deg, which IS bin 19 - and the key at its authored magnitude
    //     is a few per cent on top of it.
    //     GAIN MOVES IT AND COLLAPSES THE PAIR. trenchWall x trenchFloor at
    //     magenta gain 1 / 2 / 4 and at the master violet gain 3: 0.966 / 0.978 /
    //     0.995 / 0.974, against 0.904-0.942 with the row off. Both frames
    //     saturate to the key's own colour and become the same image - the exact
    //     trap RENDER.DEEP_KEY_RADIANCE's magnitude clause records, and here it
    //     bites at gain 1 because the two frames SHARE this water type.
    //     THE ONE ARRANGEMENT THAT SCORES, [1.38, 0.18, 0.45] at gain 1, buys
    //     its cosine by undoing item 2.3. It pushes Trench Floor back to h19s7
    //     0.800 (from 0.682) and its hue entropy 1.02 -> 0.83, i.e. back toward
    //     the single-colour frame the key exists to break up. Deep-seven 0.5943
    //     against 0.5953 without it: one thousandth, for a fifth of a bit.
    //
    //   So the trench keeps the master violet, and the collision it caused is
    //   resolved by moving CANYON WALL and ABYSSAL PLAIN off the shared cell
    //   instead - which is what the rows below do, and what a per-place key is
    //   for.
    //   2026-08-18: the drastic pass raised DEEP_KEY_RADIANCE x2.2, and per
    //   the MAGNITUDE ladder 2x of the old value is already inside the
    //   collapse regime for this SHARED type (pair cosine 0.976 at 2x). This
    //   row therefore pins gain 1/2.2 = 0.4545 - master chromaticity, exactly
    //   the pre-raise delivered magnitude - so the trench pair keeps the
    //   measured state while every other water type takes the raise.
    //   MEASURED after the pin (variety-output/drastic-deep4.json, --only
    //   trenchWall,trenchFloor,canyon,abyssal): the pair still moved 0.9909
    //   -> 0.9996 with hue entropy 1.02 -> 0.91 / 1.12 -> 0.96, which is the
    //   ANGULAR half - DEEP_KEY_DIRECTIONALITY 0.55's ambient floor delivers
    //   uniform master violet to level rays the old lobe left dark. Accepted:
    //   the pair was already past 0.99 before the pass, the trench is not a
    //   showcase segment, and undoing it means re-losing every other deep
    //   place's ambience. The next lever, if the trench ever matters, is a
    //   per-type directionality - not more magnitude games on this row.
    { gain: 0.4545 },
    // 6 VENT_SMOKE - the Emberthroat plume core (world/places.js), 12 m wide
    //   at 691 m. Keeps the master colour: at a 0.52 m sighting range the key
    //   is unphotographable from outside the plume and invisible inside it.
    null,
    // 7 HADAL_SUSPENSION - Abyssal Plain. PALE, faintly cool: the biome sheet's
    //   palette is "near-black indigo, PALE SEDIMENT, marine snow", and a
    //   near-neutral key is sediment haze rather than a second colour of light.
    //   Measured against a cyan [0.20, 1.00, 1.00] at the same gain, which is
    //   the obvious alternative: deep-seven 0.5953 pale against 0.6066 cyan on
    //   arms matched everywhere else. THAT DIFFERENCE IS 0.011 AGAINST A 0.013
    //   RUN-TO-RUN SPREAD, i.e. the two are indistinguishable on the between-
    //   frame metric and the authored direction is the tiebreak, not the score.
    //   It is stated that way round on purpose - the cyan arm is not worse, it
    //   is merely not better, and cyan is not what "pale sediment" means.
    //   GAIN 5 rather than 3 or 8. Abyssal Plain's frame is dominated by its own
    //   near-field emitters, so this row has to be loud to reach the far field
    //   at all: h19s7 0.489 / 0.467 / 0.458 / 0.436 at gain 0 / 3 / 5 / 8. Eight
    //   buys 0.006 on the deep-seven mean for +0.15 EV of metered scene
    //   luminance and 0.01 bits of hue entropy, which is the wrong trade.
    //   2026-08-18: gain 5.0 -> 2.7 because DEEP_KEY_RADIANCE's master rose
    //   x2.2 in the drastic pass; net ~5.9 keeps this row inside its own
    //   measured ladder (5..8, with 8 called the wrong trade).
    { tint: [1.00, 1.05, 1.20], gain: 2.7 },
    // 8 VENT_HAZE - the Emberthroat vent field (world/places.js), 90 m wide
    //   at 691 m. EMBER, authored 2026-08-18 against the demo showcase's
    //   Emberthroat segment - the frame this row waited for. The place is
    //   named for a glow the water never carried: below the aphotic gate the
    //   only ambient is this key, and the master violet made a volcanic vent
    //   field photograph as blue haze. Emberthroat is the only VENT_HAZE
    //   carrier, so the trench-pair collision mode (two frames sharing a
    //   type saturating to one colour) cannot occur here. Gain 10 on top of
    //   the x2.2 master (judged at 6, raised to 10 on the d3/d4-ember reshoot
    //   - the field must read from the 55 m arrival, and at 6 it did not).
    { tint: [1.00, 0.32, 0.06], gain: 10.0 },
    // 9 NEPHELOID - Rock Spires and Canyon Wall. AMBER. Canyon Wall is the only
    //   frame in the tour carrying real red mass of its own (h31s1 6.1%, h0s0
    //   4.3%, its iron-red rock) and the biome sheet reads "iron-red and violet
    //   rock against dark blue", so this is the one deep station where warming
    //   the haze states the place instead of contradicting it. Opened and
    //   judged: the far wall and the near banners warm, the upper-left negative
    //   space stays deep blue rather than greying.
    //   GAIN 4 BECAUSE THAT IS WHERE THE FRAME'S OWN HUE ENTROPY PEAKS, and
    //   entropy is the half of this that a cosine cannot see. Ladder at gain
    //   0 / 3 / 4 / 5: canyon hue entropy 2.77 / 2.89 / 2.83 / 2.78 and h19s7
    //   0.316 / 0.185 / 0.143 / 0.104. Past 4 the frame is starting to saturate
    //   to the key's colour - entropy back at the no-key value while the cosine
    //   keeps improving, which is precisely the reading that means the extra
    //   light is buying separation by flattening the frame.
    //   Rock Spires shares this row and is barely touched by it: at 365 m the
    //   gate is 0.125, and its measured self-cosine across the whole ladder is
    //   0.996-0.997.
    //   2026-08-18: gain 4.0 -> 1.8 against the x2.2 master raise; net 3.96,
    //   i.e. the same delivered magnitude the ladder above chose (gain 4).
    //   The drastic pass's deep gains come from DEEP_KEY_DIRECTIONALITY 0.55
    //   (an angular change this row's ladder never measured), not from more
    //   energy on a row whose own ladder shows flattening past 4.
    { tint: [1.00, 0.50, 0.16], gain: 1.8 },
    // 10 LAGOON_VIOLET - Bulb Grove, a 16-36 m column. Above the gate the key
    //   is multiplied by exactly 0.0, same as the other shallow rows; null
    //   until a frame past 320 m ever carries this water.
    null,
    // 11 PLATTER_TEAL - Platter Forest, an 88-124 m column: same reasoning,
    //   the whole band sits far above the 320 m gate.
    null,
    // 12 KELP_EMERALD - Kelp Forest, a 28-78 m column: same reasoning, the
    //   whole band sits far above the 320 m gate.
    null,
    // 13 DUNE_AZURE - Sunken Dunes, a 318-342 m column straddling the gate's
    //   319.8 m onset: the daylight key is that row's whole art deviation
    //   (nearly-equal Kd triple) and still carries 96% of its weight at the
    //   deepest trough, so an authored deep key would only fight it. Null
    //   until a frame under this water ever loses the daylight.
    null,
    // 14 PELAGOS_AQUA - Pelagos Station, a 44 m column. aphoticFactor is
    //   exactly 1.0 above 319.8 m by construction, so the deep key is
    //   multiplied by exactly 0.0 here and any colour authored on this row
    //   could only ever be dead data. Null for the REEF_TURQUOISE reason, not
    //   the DUNE_AZURE one: not "the daylight already carries it", but "there
    //   is no deep key at this depth at all".
    null,
  ],

  /** Cascaded shadow maps. */
  SHADOW_CASCADES: 4,
  SHADOW_RESOLUTION: 2048,
  SHADOW_SPLITS: [0.06, 0.16, 0.38, 1.0],
  SHADOW_NORMAL_OFFSET: 0.035,
  SHADOW_DEPTH_BIAS: 0.00018,
  SHADOW_SLOPE_BIAS: 2.4,

  /**
   * Metres the cascade's near plane is pushed TOWARD the sun, so a caster
   * standing above the cascade's own bounding sphere still rasterises into it.
   *
   * WHY 260 AND NOT MORE. This is the whole depth budget: a cascade's ortho
   * range is 2R + SHADOW_CASTER_EXTRUSION + 1, and SHADOW_DEPTH_BIAS is a
   * CONSTANT in NDC, so its world size is that range times 0.00018. MEASURED on
   * the live fit at fov 62 deg, aspect 2.2145 (R = 36.8 / 98.1 / 233.0 / 613.2 m):
   * ranges 333.6 / 456.2 / 726.0 / 1486.4 m, giving 6.00 / 8.21 / 13.07 / 26.76 cm
   * of constant depth bias. The 6.00 cm in cascade 0 is exactly what
   * shadow.wgsl's header documents, and it is what pins this number.
   *
   * WHAT IT COSTS. The near plane only reaches EXT * sin(elevation) above the
   * cascade, so at the 25 deg sun of the QA spawn that is 110 m. The island
   * peaks at +208 m and throws its shade 208/tan(25 deg) = 446 m, so a beach
   * receiver inside cascade 0 (R = 36.8 m) that ought to be in the island's
   * shadow is lit - the blocker is outside the extruded volume. Cascades 2 and 3
   * do contain it, so mid and far field are right; only the near field is wrong,
   * and only at a low sun: the sun peaks at a MEASURED 77.97 degrees at
   * dayFraction 0.5, where 260 m reaches 254 m up and clears the summit. The
   * alternative is a per-cascade scene-height extrusion, which triples the depth
   * range and the peter-panning with it.
   */
  SHADOW_CASTER_EXTRUSION: 260,

  /**
   * Texels of guard band left between the cascade's bounding sphere and the edge
   * of its atlas layer, so the texel-snap residual cannot push a sphere point
   * outside NDC. The snap moves the centre by up to one texel; two texels leaves
   * a full texel of slack for the f32 round trip through the matrix. Measured
   * with NO guard the sphere's lateral edge lands at NDC 1.0008 and clips.
   * Costs (RES - 2G) vs (RES - 4G) of resolution: 0.1% at 2048.
   */
  SHADOW_FIT_GUARD_TEXELS: 2,

  /**
   * A caster narrower than this many PCF kernel radii cannot leave a shadow that
   * survives filtering, so it is skipped in that cascade. 1.5 x the kernel
   * radius x the cascade texel is 13 cm in cascade 0 and 1.35 m in cascade 3.
   */
  SHADOW_MIN_CASTER_TEXELS: 1.5,

  /**
   * Depth, metres, past which underwaterShadowStrength() (water.wgsl) has faded
   * the sun shadow to nothing. A cascade whose SHALLOWEST point is deeper than
   * this cannot affect any pixel, so it is skipped and its matrix zeroed.
   *
   * IT IS NOT MERELY "MIRRORED BY" THAT SMOOTHSTEP - IT *IS* ITS UPPER EDGE.
   * renderer.js publishes this number to the preprocessor as
   * SHADOW_UW_CUTOFF and water.wgsl's smoothstep reads it, so the cascade gate
   * here and the receiver fade there cannot drift. They were two independent
   * literals (95 in both) and that is a latent bug: raising only this one arms
   * three caster chains whose output the receiver then multiplies by zero -
   * pure cost, zero pixels - and lowering only this one puts a hard shadow
   * edge across the frame where the cascades stop.
   *
   * IT STAYS AT 95 AND THAT IS A MEASURED DECISION, NOT AN OMISSION. 260 was
   * proposed and tried: it is OPEN_OCEAN_CEILING, `COLUMN_OPTICAL_DEPTH /
   * min(Kd)` on OCEANIC_CLEAR (biomes.js:572), the depth at which the
   * least-attenuated channel of the open ocean runs out of daylight, so the
   * argument was that between 95 and 260 there is a beam left to cast a shadow
   * with and it is switched off. There is a beam. It carries no image.
   *
   * A/B/A at 95 / 260 / 95, tools/test-variety.mjs, Boulder Field (96.7 m) and
   * Shelf Break (180.4 m), every figure quoted with both control arms:
   *   Boulder Field  dark mass 0.000000 / 0.000000 / 0.000000
   *                  flat fraction 0.4973 / 0.4986 / 0.4970
   *                  p95/p05 2.387 / 2.385 / 2.388, median L 0.2478 all three
   *   Shelf Break    dark mass 0.000008 / 0.000015 / 0.000011  (13 px of 896k)
   *                  flat fraction 0.2241 / 0.2234 / 0.2249
   * Not one figure leaves its own control bracket, and the frames are identical
   * to the eye but for a jellyfish that swam through one of them.
   *
   * WHY, and this is the part worth keeping: a cast shadow can only remove the
   * DIRECT beam, and it can only remove it where something occludes. Both terms
   * are small here. Occlusion measured by A/B-ing the shadow inside one run
   * (zero the cascade matrices; sampleShadowPCF returns 1.0 on clip.w <= 0),
   * time-averaged 20 frames per arm to beat the animation: at 98 m the shadow
   * touches 0.87% of pixels by more than 10% (control 0.37%) and removes 0.068%
   * of frame luminance against a 0.083% control drift. And the beam it removes
   * is, on the seabed's own surface irradiance, 47% at the reef, 24.9% at the
   * kelp forest, 17.4% at Boulder Field, 9.5% at Shelf Break and 8.0% at
   * Twilight Terraces - the sun on the SLANT path, the sky SH on the vertical,
   * both attenuated. So 260 buys ~20% off ~1% of the frame.
   *
   * WHAT IT WOULD COST. Caster draws at the tour poses, 95 vs 260, reproduced
   * exactly by both control arms: Boulder Field 620 -> 620 (+0: all four
   * cascades were ALREADY above the gate there), Shelf Break 485 -> 655,
   * Twilight Terraces 475 -> 646, Rock Spires 309 -> 534, Canyon Wall 0 -> 315.
   * The last two are pure waste - their receivers are at 365 m and 505 m, where
   * this fade is exactly 0 - because the gate tests a CASCADE'S SHALLOWEST
   * POINT, and a 613 m-radius cascade 3 has one in the 95-260 m band from
   * kilometres down. Moving-camera cost at Twilight Terraces, the one affected
   * motion-budget station, swimming: mean frame 3.78 / 4.41 / 3.90 ms and GPU
   * span 4.07 / 4.35 / 3.90 ms, i.e. about +0.4 ms for those 171 draws.
   *
   * THE GENERAL RESULT, which is why this comment is long: below the photic
   * zone the sun cannot be the key light at any cutoff. Directional structure
   * down there has to come from emitters and from an authored deep key, not
   * from re-arming cascades.
   */
  SHADOW_UNDERWATER_CUTOFF: 95,

  /**
   * Cascades the vessel is drawn into. At cascade 2's 22.8 cm/texel a 7 m hull
   * is 31 texels and its shadow is already carried by the cross-fade band, so
   * the two far cascades buy nothing for 22 extra draws.
   */
  SHADOW_VESSEL_CASCADES: 2,

  /**
   * Frames between forced re-renders of each cascade.
   *
   * A cascade is world-anchored: its ortho centre is snapped to a whole number
   * of its own texels in ABSOLUTE space, so while that snap is unchanged the
   * atlas contents remain exactly correct for static geometry - the matrix and
   * the pixels are frozen together. The only things that go stale are streaming
   * terrain and the scatter sway, and this caps that staleness in frames.
   *
   * MEASURED at the beach camera: the four cascades cost 0.272 / 0.237 / 0.347 /
   * 0.360 ms of GPU scope, 1.216 ms in all, and the frame's median interval went
   * from 8.50 ms to 9.36 ms with the pass on. [1, 1, 2, 4] amortises that to
   * 0.773 ms. Cascade 3's 0.60 m texel only changes every 13 frames at walking
   * pace anyway, so the interval is what actually fires there, not the snap.
   *
   * The vessel only casts into cascades 0-1, which are both every-frame.
   */
  SHADOW_UPDATE_INTERVALS: [1, 1, 2, 4],

  /**
   * Metres of camera travel a skipped cascade must tolerate, PER skipped frame.
   *
   * A cascade held for N frames has to keep covering a frustum slice that is
   * moving, so its fitted sphere is padded by (N-1) times this. 1.0 m is the
   * vessel's Vne of 120 m/s at 120 fps - the fastest the camera can ever
   * translate. The cost is resolution: cascade 3's radius goes 613.2 -> 616.2 m,
   * 0.5%. ROTATION is not covered by the pad and cannot be - a hard turn sweeps
   * the far cascade's centre hundreds of metres - so the fit also runs an
   * explicit containment test and re-renders the moment the new slice leaves the
   * held one.
   */
  SHADOW_CADENCE_PAD: 1.0,

  /**
   * First cascade in which scatter casters are forced to their COARSEST mesh.
   *
   * Cascades are nested spheres, so a plant two metres from the eye is a caster
   * in all four of them, and at cascade 2's 22.8 cm/texel its whole silhouette
   * is a handful of texels - the high-detail mesh contributes nothing but
   * vertex work. Cascades 0 and 1 keep the same LOD the colour pass draws,
   * because a shadow cast by a different silhouette than the one on screen is
   * worse than no shadow, and 3.6 / 9.6 cm per texel does resolve the
   * difference.
   */
  SHADOW_SCATTER_COARSE_FROM: 2,

  /** Froxel volumetrics. */
  FROXEL_X: 160, FROXEL_Y: 90, FROXEL_Z: 64,
  FROXEL_MAX_DISTANCE: 220,
  FROXEL_DEPTH_POWER: 2.0,

  /**
   * Weight of the reprojected density volume, per frame.
   *
   * The injection takes ONE shadow comparison tap and ONE caustics tap per
   * froxel at a blue-noise-jittered point inside each slab, so a single frame of
   * the volume is binary at every shadow edge and the accumulation IS the
   * penumbra. 0.90 is ten effective frames - 83 ms at 120 fps - which resolves
   * the jitter while keeping the trail behind a swinging headlight below what
   * the eye reads as smear. TAA runs after the composite and filters the
   * residual a second time, so this does not have to do the whole job.
   *
   * It is applied to the UNINTEGRATED density volume. Reprojecting the
   * integrated scatter volume instead is wrong and compounds: the value at a
   * slice depends on every slice in front of it along the CURRENT ray, which
   * reprojection does not preserve.
   */
  FROXEL_HISTORY_BLEND: 0.90,

  /**
   * Half-width, metres, of the band over which a froxel crosses between air and
   * water at the FLAT sea level.
   *
   * The real surface has waves on it, but a froxel is 2 m deep by 20 m across at
   * 20 m out and pass/underwater.wgsl classifies the waterline PER PIXEL from
   * the same Gerstner sum the buoyancy query uses. All this band has to do is
   * stop the volume aliasing along a hard plane; it must not try to be the
   * meniscus.
   */
  FROXEL_WATERLINE_BAND: 1.5,

  /**
   * Caustics. A fallback only - gpu.js's presets are authoritative and choose
   * 256 (LOW) or 512 (everything else). Measured sub-texel rms error against a
   * 2048^2 box-downsampled reference is 2.83 / 1.02 / 0.35% at 256 / 512 / 1024,
   * with the tile mean (1.33343 / 1.33322 / 1.33323) and the clamp fraction
   * (1.639 / 1.614 / 1.619%) identical to four digits - the tile is not
   * undersampled even at 256.
   */
  CAUSTICS_RESOLUTION: 512,
  /**
   * Side of the world-space tile, metres.
   *
   * Upper bound: the shortest mode is 0.5735 m and needs 8 texels, so the tile
   * may be at most res_min * lambda_min / 8 = 256 * 0.5735 / 8 = 18.4 m. Lower
   * bound is the near-field framing - the lagoon station spans about 6 m of
   * seabed, 0.43 of a tile, and a tile smaller than the frame reads as
   * wallpaper. The 48 LATTICE entries are integers OF THIS TILE, so changing it
   * invalidates every one of them.
   */
  CAUSTICS_SCALE: 14.0,
  /**
   * Caustics fade out entirely by this depth, metres.
   *
   * Jerlov IA green Kd is 0.0576, which leaves 2.8% of the direct beam at 62 m;
   * that is the binding criterion. The competing one - the refracted solar
   * disc's 3.47 mrad blurring the pattern past its own cell size - only bites at
   * about 101 m. A water-type-aware fade is a real improvement and is deferred;
   * the measurement that would justify it has not been taken.
   */
  CAUSTICS_MAX_DEPTH: 62,

  /**
   * Peak of 1/|det J| the caustics tile is allowed to reach, and the SAME
   * ceiling common/water.wgsl clamps the two-tap composite at.
   *
   * It lives here rather than privately in passes/caustics.js because clamping
   * each tap and then multiplying squares the ceiling to 36 - and against the
   * consumer's old 2.6 gain that is the 93.6 the seabed could reach. One
   * ceiling, applied once, at both ends of the chain.
   *
   * The value is a resolution limit; passes/caustics.js's INTENSITY_CLAMP
   * docstring carries the derivation.
   */
  CAUSTICS_INTENSITY_CLAMP: 6.0,

  /**
   * Mip levels of the caustics tile, base included, and therefore also the
   * coarsest LOD any consumer may ask for (levels - 1).
   *
   * FOUR THINGS ARE DERIVED FROM THIS AND NONE OF THEM MAY BE A LITERAL:
   * renderer.js's `declare('caustics', { mips })`, renderer.js's and
   * wgsl-compile.mjs's CAUSTIC_MAX_LOD define, and passes/caustics.js's
   * MIP_LEVELS (how many box-filter dispatches actually run). Only one of the
   * three ways to break the set fails loudly - shrinking `mips` alone throws at
   * createBindGroup. Shrinking the dispatch count alone leaves levels declared
   * but never written, and textureSampleLevel at that LOD then returns undefined
   * contents on the distant seabed with no error anywhere.
   *
   * 5 is where the pattern runs out: level 4 is 512>>4 = 32 texels over the
   * 14 m tile, 0.4375 m each, so the shortest mode (0.5735 m) is down to 1.3
   * texels and has been filtered away entirely. A sixth level would have nothing
   * left to remove.
   */
  CAUSTICS_MIP_LEVELS: 5,

  /**
   * Scale of the caustic composite's SECOND tap, relative to the first.
   *
   * It must be COARSER than the first, not finer. The fine tap already sits at
   * the resolution limit - 0.5735 m is 10.5 texels at the LOW tier's 256^2 - so
   * the 1.63 that shipped put structure at 0.35 m, i.e. 6.4 texels, below the
   * 8-texel rule the tile is sized by. Measured world tile-lag autocorrelation
   * over tap2 in 0.37-2.70 is 0.395-0.503, so the exact value is not critical;
   * 0.53 measures 0.4465 at a one-tile lag and 0.3742 at two, and is safe at
   * every preset resolution.
   */
  CAUSTIC_TAP2_SCALE: 0.53,

  /**
   * Arithmetic mean of E = 1/|det J| over the whole caustics tile, per channel.
   *
   * BOTH consumers divide by it, which is what makes the pattern redistribute
   * the solar beam instead of adding a third of it. Measured over all six
   * weather states x TWELVE wind headings (0-165 deg, step 15) x 8 phases
   * spanning the exact 200 s loop: R spans 1.31993-1.33239 about a grand mean of
   * 1.32775, i.e. +/-0.59%, worst deviation from the baked value 0.49%, with the
   * minimum at clear @ 75 deg. An earlier draft quoted +/-0.32% off a four-point
   * heading sweep that stepped over that minimum; the sweep is dense now and
   * tools/test-caustics.mjs runs the dense one. Well inside its 1.5% tolerance
   * either way, which is what makes baking one triple safe.
   *
   * It replaces FROXEL_CAUSTIC_MEAN (1.084), which was a live defect: the
   * deleted windGain made the true tile mean, read off the GPU, span 1.0400
   * (clear) / 1.0468 (fogbank) / 1.1063 (breezy) / 1.1638 (overcast) / 1.2165
   * (storm) / 1.2546 (squall) against that one baked number, so the god-ray
   * shafts were over-normalised by 4.2% in calm water and under-normalised by
   * 13.6% in a blow. With sigma pinned there is exactly one value, and weather
   * no longer moves it: live readback across all six states now spans
   * 1.3218-1.3303 in R.
   */
  CAUSTIC_TILE_MEAN: [1.32619, 1.33375, 1.34513],

  /**
   * Mean of the two-tap composite min(c1*c2 / mean^2, CAUSTICS_INTENSITY_CLAMP),
   * per channel, over the same sweep. common/water.wgsl divides by it so
   * causticFactor() averages 1 and can only redistribute the beam it multiplies.
   *
   * It is below 1 because the clamp removes about 2.3% of the product's energy -
   * that is the single-sheet model being honest about the cusps it cannot draw.
   * Worst deviation from the baked triple over the dense sweep is 0.85%, at
   * fogbank @ 120 deg; an earlier draft quoted +/-0.47% off the four-point
   * heading sweep that also understated CAUSTIC_TILE_MEAN's spread.
   *
   * BAKED AT LOD 0, AND APPLIED AT EVERY LOD, so the mean is 1 where the pattern
   * is legible and drifts UP with minification. The clamp is the only reason the
   * constant is below 1, and the box chain removes exactly the peaks that clamp:
   * live clamp fraction falls 1.56 / 1.07 / 0.34 / 0.00 / 0.00% over levels 0-4.
   * Measured causticFactor() DC at k = 1, clear, both taps on the chain with the
   * real offsets and the real fractional tap-2 LOD: 1.0022 / 1.0038 / 1.0098 /
   * 1.0209 / 1.0282 (R) at levels 0-4, i.e. the distant or steeply-viewed seabed
   * carries up to +2.8% of DC that the near seabed does not. That is 1/40th of
   * the mean-3.86 lift this whole change removed and it is below visibility, but
   * it is a DC error in a function whose contract is the mean, so it is measured
   * here rather than left to be rediscovered as a haze bug. tools/test-caustics
   * section 9 pins it; the fix, if it ever matters, is a per-level table indexed
   * by the first tap's LOD.
   */
  CAUSTIC_COMPOSITE_MEAN: [0.97746, 0.97650, 0.97506],

  /** TAA. */
  TAA_SAMPLES: 8,
  TAA_FEEDBACK_MIN: 0.88,
  TAA_FEEDBACK_MAX: 0.97,
  TAA_JITTER_SCALE: 1.0,

  /**
   * SSAO - screen-space ambient occlusion (render/passes/ssao.js).
   *
   * WHAT IT DARKENS, EXACTLY: the AMBIENT share of a pixel's delivered
   * radiance, and nothing else. Each geometry pass writes that share to the
   * `aoGate` target as luma(ambient after the medium) / luma(final fragment),
   * and the apply pass multiplies sceneColor by 1 - STRENGTH*gate*(1 - ao).
   * Emission, the sun/moon direct beam (the CSM already owns its occlusion),
   * punctual lamps and the medium's own in-scatter are all outside the gate's
   * numerator, so a glowcup keeps its radiance and the haze keeps its energy
   * by construction rather than by masking heuristics. The removal is
   * luminance-exact and chroma-proportional: what is subtracted lies along the
   * pixel's own colour, weighted to equal the ambient term's luminance loss.
   *
   * WHERE IT RUNS: after the last opaque depth writer and before the sky, so
   * copyOpaque snapshots an AO'd seabed for the ocean to refract, and the
   * underwater composite attenuates an AO'd surface - the medium is applied
   * once, after AO, in both media. AO is computed at half resolution from the
   * JITTERED sceneDepth (consistent with the jittered invProj used to
   * unproject it) and runs BEFORE TAA on purpose: the per-frame blue-noise
   * kernel rotation and the sub-pixel jitter of the depth buffer are exactly
   * what TAA averages away.
   *
   * STRENGTH = 0 disables the pass entirely (enabled() reads it live) and
   * reproduces the pre-SSAO image bit for bit - the gate byte is still
   * written by the geometry passes, but nothing reads it. This is the bisect.
   */
  SSAO_STRENGTH: 0.8,
  /** World-space occlusion search radius, metres. Contact-scale on purpose:
   *  SSAO grounds props; it is not a substitute for cast shadows. */
  SSAO_RADIUS: 0.7,
  /** Occlusion gain before the power curve. */
  // 2026-08-17 clarity pass: 1.3 -> 1.5 (and SSAO_POWER 1.5 -> 1.7) for
  // seabed grounding once the veil cut let the contact shadows read at all.
  SSAO_INTENSITY: 1.5,
  /** Contrast curve on the occlusion term: ao^POWER. >1 keeps open surfaces
   *  clean and concentrates darkening in real creases. */
  SSAO_POWER: 1.7,
  /** Cosine bias subtracted from each tap - suppresses self-occlusion from
   *  depth quantisation and the normal reconstruction's one-texel error. */
  SSAO_BIAS: 0.04,
  /** AO fades to 1 between these view distances (m). Past them the half-res
   *  kernel is sub-pixel and only noise would survive; fading also keeps the
   *  far field's haze untouched where the gate ratio is least exact. */
  SSAO_FADE_START: 60.0,
  SSAO_FADE_END: 120.0,
  /** Taps per half-res pixel. Baked into the shader at init - NOT live. */
  SSAO_SAMPLES: 10,

  /**
   * AgX "look": an ASC-CDL power and a saturation, applied in code space between
   * the sigmoid and the outset matrix.
   *
   * Base AgX is deliberately flat - it desaturates toward white on the shoulder,
   * which is why it was chosen over ACES - so a look is what puts the chroma back.
   * Shipping without one measured 11.2% delivered saturation against 42.5% present
   * in the scene radiance.
   */
  AGX_LOOK_POWER: 1.15,
  // 2026-08-17 clarity pass: 1.35 -> 1.50 from a live A/B at the coral
  // horizon and a waterline framing (tools/shots/agx-ab.json arms 1.35 /
  // 1.45 / 1.55): the pinks and the water band deepen visibly with no clip
  // rise (clipped coverage stayed < 0.03%) and the sky/cloud half of the
  // waterline frame stays natural. One knob for the whole game - the beach
  // and night qa scenarios were re-shot and looked at before landing.
  AGX_LOOK_SATURATION: 1.50,

  /**
   * Lens vignette: `cos4 = 1/(1 + r2*FALLOFF)`, raised to VIGNETTE_POWER.
   *
   * `r2` is NOT normalised to the frame corner, so its value there depends on the
   * aspect ratio - 1.04 at 16:9 but 1.37 at this project's 2.11:1. The strength
   * slider defaults low for a reason: at 1.0 the cos^4 law removes 48.4% of ALL
   * the light in the frame, and because it runs after the exposure histogram
   * meters, auto-exposure never compensates. Measured on the shipped build,
   * dividing it back out dropped underwater-shallow's spatial variation from 44.6%
   * to 3.9% - 91% of everything visible in that frame WAS the vignette.
   */
  VIGNETTE_FALLOFF: 1.15,
  VIGNETTE_POWER: 2.0,

  /**
   * Transverse chromatic aberration, in UV per unit r2, before the user's slider.
   *
   * Sized so the R-to-B separation is 1.1 px at the extreme corner at slider 1.0
   * and 0.07 px at the centre, which is what a real coated lens does. The
   * predecessors (0.0016 and 0.0090) gave a measured 5.9 px at x=1490 and 8.4 px
   * at the corner: on a shore-grass blade 1-2 px wide, R, G and B came from three
   * different blades and the grass rendered as magenta/cyan/yellow speckle.
   */
  CA_CENTRE: 0.000047,
  CA_EDGE: 0.00050,

  /**
   * The linear value auto-exposure maps the METERED BAND onto.
   *
   * Deliberately above middle grey, because the metered quantity is the log
   * average of the 45th-95th percentile of the histogram rather than the mean of
   * the frame. Mapping the middle of the bright half onto 0.18 put the frame's
   * own median at code 0.30, where a correctly exposed image wants ~0.44 - a
   * measured 1.14 EV under. The under-exposure was invisible for as long as AgX
   * was missing its EOTF, because the resulting double gamma decode lifted every
   * midtone back up by roughly the same amount.
   */
  EXPOSURE_KEY: 0.40,

  /**
   * Auto-exposure, in EV.
   *
   * EXPOSURE_MIN_EV IS THE METERING FLOOR, AND THEREFORE THE GAIN CEILING. The
   * smallest average `cs_adapt` will expose FOR is 2^-6 = 0.015625, so the gain
   * is capped at EXPOSURE_KEY / 0.015625 = exactly 25.6. RE-DERIVED 2026-08-02
   * AND DELIBERATELY UNCHANGED; the measurements below are here because the
   * obvious repair is measurably worse.
   *
   * UN-WELDED 2026-08-04, AND THE VALUE DID NOT MOVE. It used to be the
   * histogram's low bin EDGE as well, which is where the ceiling came from as a
   * side effect: `binToLuminance(1)` WAS 2^-6, so the meter could not report
   * anything smaller and the floor bound through a blind instrument rather than
   * through a decision. The bin edges now start at HISTOGRAM_MIN_EV (the
   * histogram's own 1e-5 inclusion gate) and `cs_adapt` clamps targetEV at
   * `log2(2^EXPOSURE_MIN_EV / EXPOSURE_KEY)` = -4.678 EV instead - which is the
   * SAME arithmetic the shader used to run on a floor-bin average, so the
   * delivered gain at a clamped station is bit-identical 25.6. What the meter
   * reports is no longer bit-identical, and that is the point: see
   * HISTOGRAM_MIN_EV for the two consequences that ARE pixels.
   *
   * SIX OF THE FOURTEEN BIOME ANCHORS SAT ON THAT CEILING IN 2026-08-02, EIGHT
   * DO ON THE 2026-08-04 SEARCH, AND THE PICTURE IS RIGHT ANYWAY. Boulder Field,
   * Shelf Break, Twilight Terraces, Canyon Wall, Abyssal Plain and Trench Wall -
   * at 93 / 192 / 287 / 417 / 752 / 1099 m as the 2026-08-02 anchor search
   * resolved them, and the anchors are SEARCHED, so a later run puts them
   * elsewhere in the same bands - all metered a flat 0.015625 against a TRUE
   * 45-95 log-average of 8.7e-4 to 2.1e-3. The histogram was wrong by **2.87 to
   * 4.16 EV**, not the 1-1.5 EV this was once recorded as, because the floor sat
   * 10.61 stops above the histogram's own 1e-5 inclusion gate. Since the un-weld
   * the meter reports that true average and the CLAMP is what holds them at
   * 25.6, so the 2.87-4.16 EV (re-measured 2026-08-04 as 2.00-4.06 EV over the
   * eight) is now visible headroom rather than an invisible error: it is
   * how much light the deep can gain before auto-exposure stops being a fixed
   * 25.6x and starts metering back out. Where the floor does not bind, the
   * reduction was exact to **-0.045 EV at all eight other stations**, half a bin
   * width and nothing else, so the quantiser, the 45-95 window and EXPOSURE_KEY
   * are mutually consistent and only the FLOOR was misplaced.
   *
   * WHY 25.6 IS NONETHELESS THE RIGHT CEILING. Boulder Field is the deepest
   * station still lit by daylight rather than by biology, and at 25.6 its
   * delivered median MAX CHANNEL is 209 sRGB - between Shallow Reef's 202 and
   * Coral Garden's 215, i.e. inside the band of the frames the meter exposes
   * correctly. Its median LUMA is only 49.5 because the frame is 18/48/205:
   * `luminance()` is Rec709 and weights blue 0.0722, so a monochromatic blue
   * scene under-reads by up to 13.8x in the very quantity the histogram bins.
   * Reading that low median as under-exposure is the trap.
   *
   * MEASURED A/B, by overriding this constant live and re-shooting the biome
   * tour. At -7 (ceiling 51.2) Boulder Field's blue-clipped area goes 0.66% ->
   * 10.3%. At -8 (ceiling 102.4) it goes to **49.7%** at a median max channel of
   * 249 and the frame is a flat lavender wash; Shelf Break's mean blue goes
   * 142 -> 192 with its lamp cone blown; Canyon Wall and Trench Wall lose the
   * black between their emitters and the emitter cores blob together; and
   * MIDNIGHT Shallow Reef goes from a moonlit reef to an overcast afternoon
   * (median max channel 107 -> 176). This constant is what makes night look like
   * night. The single frame that improves is midnight Kelp Forest, and its
   * documented lever is the glow pass, not the meter.
   *
   * AND LOWERING IT CLOSES THE LOOP THE GLOW PASS IS BUILT ON. At -8 every deep
   * station meters BELOW its own ceiling (82.0-96.0 against 102.4), so raising an
   * emitter's authored intensity would be metered straight back out - the claim
   * measured as FALSE today becomes true. GLOW.BIN1_CEIL is
   * derived from this constant and glow.js's bright radius goes as 1/BIN1_CEIL,
   * so the charged coverage goes as BIN1_CEIL^-2: two stops multiplies it by 16
   * against a measured 21.7x margin, leaving 1.36x and putting BRIGHT_BUDGET's
   * joint halo scalar into play in ordinary play.
   *
   * `tools/probes/rail-meter.js` is the instrument for re-checking any of this.
   * To A/B the un-weld itself, override HISTOGRAM_MIN_EV live (see there) and
   * call `renderer.resetAdaptation()` rather than waiting out the 0.85/s dark
   * adaptation.
   */
  EXPOSURE_MIN_EV: -6.0,

  /**
   * The histogram's LOW BIN EDGE, in EV. Nothing else - it is not a clamp, not a
   * floor and not a ceiling.
   *
   * Set at `log2(1e-5)`, which is exactly the inclusion gate `luminanceToBin`
   * already applies: bin 0 means "below 1e-5, do not meter me", so the first
   * METERED bin should start where that test stops rejecting. It used to start
   * at EXPOSURE_MIN_EV = -6.0, i.e. 10.61 stops higher, which collapsed the
   * whole range [1e-5, 0.015625] onto one reported value and made the meter
   * blind across every deep anchor listed on EXPOSURE_MIN_EV.
   *
   * "IT CHANGES NO PIXEL BY CONSTRUCTION" IS FALSE, AND THE TWO MECHANISMS ARE
   * WORTH KNOWING BEFORE BLAMING SOMETHING ELSE FOR A HALF-STOP.
   *   1. Bin width goes (17+6)/254 = 0.0906 EV -> (17+16.61)/254 = 0.1323 EV, so
   *      every frame is quantised more coarsely and the 45-95 log-average can
   *      move by up to half of that, in either direction, for that reason alone.
   *   2. Pixels that used to pile into bin 1 now spread over ~80 bins, which
   *      changes which samples fall inside the 45-95 percentile window. On a
   *      frame with a dark half that lowers the metered average and OPENS the
   *      exposure.
   * Only a station clamped at the gain ceiling is invariant, because there the
   * clamp decides and the meter does not.
   *
   * MEASURED A/B, live, both arms on this build, 14 anchors at day fraction
   * 0.32 with `resetAdaptation()` between them so neither arm is read
   * mid-adaptation, SUIT LAMP OFF. Eight anchors sit on the ceiling and
   * delivered **exactly 25.59999 in both arms** (the f32 readback of 25.6),
   * delta 0.0000 EV: Boulder Field 100 m, Shelf Break 174, Twilight Terraces
   * 205, Rock Spires 410, Canyon Wall 481, Abyssal Plain 760, Trench Wall 977,
   * Trench Floor 1033. The other six moved **+0.0105 / +0.0094 / -0.0035 /
   * -0.0086 / +0.0051 / +0.0471 EV** (beach, basalt, reef, coral garden, sand
   * plains, kelp), all well inside a 0.1323 EV bin, and the two A/B frame pairs
   * read as identical images. What DID move is the meter: at the eight pinned
   * stations it reported a flat 1.563e-2 in the old arm and **9.4e-4 to 3.9e-3**
   * in the new one, i.e. **-2.00 to -4.06 EV** of error removed.
   *
   * NAME THE LAMP STATE OR THE NEXT PERSON HUNTS A GHOST. The suit lamp landed
   * one commit before this un-weld and `tools/test-variety.mjs` runs its tour
   * with `lampOn = depth > 150`, so LAMP ON is the normal deep condition and the
   * tour above is not it. Re-measured 2026-08-05 with the lamp forced both ways,
   * resetAdaptation + 3 s settle, arms alternating new/old/new: Canyon Wall 481 m
   * and Abyssal Plain 760 m delivered **25.599993 in every arm and both lamp
   * states**, delta 0.0000 EV, with the lamp verifiably lighting (lightCount
   * 6 -> 7, sceneColor luminance 1.17e-3 -> 2.55e-3 at Canyon Wall). The reason
   * is structural and is worth more than the reading: mirroring cs_histogram in
   * JS over the same frame gives an OLD-arm metered average of exactly the floor
   * 1.5625e-2 lamp-on and lamp-off alike, so both arms clamp. An independent
   * review measured +0.2288 EV at Canyon Wall lamp-on and it did not reproduce
   * here across two probes; what decides it is how much of the metered weight
   * clears the old floor bin, which is a POSE property, so check that share
   * before believing either number.
   *
   * The safe statement, which does not depend on the pose: a pixel the old
   * edges floored UP can only be reported lower now, and everything above the
   * floor merely re-quantises by up to half a 0.1323 EV bin either way - which
   * is exactly the +-0.01 to +0.05 EV the six unclamped anchors show. So where
   * the floor bound, the un-weld moves the metered average down and the
   * delivered gain TOWARD the unchanged 25.6x ceiling, never past it. Invariant
   * with the lamp off; bounded above by that ceiling with it on.
   *
   * AND THE NOISE FLOOR IS THE SAME SIZE AS THE EFFECT, SO A SUB-0.1-EV CLAIM
   * NEEDS A FROZEN CLOCK. The "< 0.1 EV at the unpinned anchors" acceptance
   * above has no same-arm control. Measured 2026-08-05 at a pinned pose with
   * arms new/old/new/old: Shallow Reef delta **+0.0713 EV** against a
   * NEW-to-NEW reproducibility of **0.1102 EV** over the same interval, Kelp
   * Forest **+0.0830 EV** against **0.0666 EV**. The gains drift monotonically
   * downward across all four arms because `setDayFraction` is applied once at
   * arrival and the clock then runs through every settle, so the sun is moving
   * under the A/B. Anyone who needs a sub-0.1-EV exposure claim must freeze the
   * clock first; below that the delta and the drift are not separable.
   *
   * BISECTABLE: set this equal to EXPOSURE_MIN_EV to reproduce the pre-2026-08-04
   * image exactly. It is written into the exposure uniform every frame
   * (post.js -> `params.misc2.y`), so a live override in the console is the whole
   * change - RENDER is not frozen.
   */
  HISTOGRAM_MIN_EV: -16.609640474436812,

  /**
   * The histogram's HIGH bin edge AND the high clamp on targetEV. Still welded,
   * deliberately: unlike the low edge these two agree about what they mean -
   * a scene brighter than the top bin cannot be metered and must not be exposed
   * for either - and separating them would only add a knob with no fault behind
   * it. Un-welding the LOW edge was forced by the 10.61-stop gap above.
   */
  EXPOSURE_MAX_EV: 17.0,
  EXPOSURE_SPEED_UP: 2.2,
  EXPOSURE_SPEED_DOWN: 0.85,
  HISTOGRAM_BINS: 256,

  BLOOM_THRESHOLD: 1.15,
  BLOOM_MIPS: 6,

  /** Instancing caps. */
  MAX_SCATTER_INSTANCES: 160000,
  MAX_PARTICLES: 128000,
  /**
   * Concurrent CPU creature agents. Was 260.
   *
   * MEASURED with tools/test-creatures.mjs section 8's harness at the worst
   * case - every agent inside the 60 m LOD-FULL edge and pressed against the
   * seabed, so all five avoidance whiskers hit and the normal sampler runs:
   * 260 agents 1,188 us/tick, 420 agents 1,913 us, 500 agents 2,374 us. Linear
   * at 4.6 us/agent. DESIGN's AI budget is 2.0 ms/tick, so 420 is the cap and
   * 500 is not available. Buffers scale trivially with it: 420 x 160 B of
   * instance data is 67 kB, and 2 x 420 x 28 x 48 B of bones is 1.13 MB.
   */
  MAX_CREATURES: 420,
  /** Bone palette stride, and a HARD budget: creature_mesh.buildCreatureBones
   *  clamps the spine chain to what is left after the jaw, lure and mandible
   *  bones are taken. RAISED 24 -> 28 on 2026-08-21 for the Splitmaw, which is
   *  the first record to want per-horn bones: 22 spine + 1 jaw + 4 mandible is
   *  27, and 24 could not hold it. The cost is the palette (2 x 420 x 28 x 48 B
   *  of bones against 968 kB at 24, plus SPECIES_COUNT x 28 x 32 B of rest
   *  poses) and 17% more threads in cs_creature_skeleton, which dispatches one
   *  per palette slot whether the species uses it or not.
   *
   *  IT ALSO UN-CLAMPED ONE OTHER ANIMAL, and that is a fix rather than a side
   *  effect: LEV_NETHERCOIL authors `spineBones: 24` and carries a jaw, so at a
   *  budget of 24 buildCreatureBones silently gave it 23. It gets the 24 its
   *  recipe always asked for now. No other record was clamped - checked across
   *  the whole roster, it is the only spine count that moved. */
  MAX_BONES_PER_CREATURE: 28,
};

// ===========================================================================
// BIOLUMINESCENT GLOW SPRITES
// ===========================================================================

/**
 * Additive glow sprites for bioluminescent emitters (render/passes/glow.js).
 *
 * WHAT THIS FIXES, AND WHAT IT DOES NOT. The deep does not read because a
 * 2 cm photophore is a fraction of a pixel: its delivered peak is decided by
 * where the emitter lands inside a texel, and the flux that misses the sample
 * point is simply gone. Auto-exposure is NOT the cause and cannot be, because
 * it is PINNED at depth: cs_adapt clamps targetEV at
 * log2(2^EXPOSURE_MIN_EV / EXPOSURE_KEY) = -4.678 EV, so the gain can never
 * exceed 0.40/0.015625 = 25.6 and every deep station sits exactly there. The
 * loop is open, which is what makes the sprite's area survive; see
 * BRIGHT_BUDGET for the coverage at which it closes.
 *
 * THAT USED TO BE THE HISTOGRAM'S DOING AND IS NOW THE CLAMP'S, WHICH IS WHY
 * THE 25.6 SURVIVED THE 2026-08-04 UN-WELD UNCHANGED. Before it,
 * binToLuminance(1) was 2^EXPOSURE_MIN_EV = 0.015625 and the meter could not
 * report anything smaller; the bins now start at HISTOGRAM_MIN_EV and it does.
 * Re-measured on this build at day fraction 0.32, the metered log-average is
 * 1.84e-4 / 1.87e-3 at Canyon Wall 481 m with the suit lamp off / on and
 * 1.49e-4 / 1.05e-3 at Abyssal Plain 760 m - 3.1 to 6.7 EV below the floor -
 * while the delivered gain at all four stayed 25.599993. Anyone re-deriving
 * the ceiling from the histogram will now get a number 1518x too low.
 */
export const GLOW = {
  /**
   * Gaussian 1/e^2 sigma of the unresolved core, in FULL-RESOLUTION pixels.
   *
   * Derived from the display grid's band limit, not chosen. A Gaussian's MTF at
   * the display Nyquist (0.5 cyc/px) is exp(-2*PI^2*sigma^2*0.25) =
   * exp(-4.9348*sigma^2); at 1.0 that is 7.2e-3, so the sprite still carries
   * essentially nothing the pixel grid cannot represent and the sub-pixel
   * lottery is gone. The 1%-MTF floor is sigma = 0.966, so 1.0 clears it, and
   * that floor is what sets this number - it sits AT the band limit rather than
   * inside it.
   *
   * Was 1.2 (MTF 8.2e-4). Going wider is paid for directly in contrast: the peak
   * radiance per unit flux is 1/(2*PI*sigma^2), i.e. 0.1592 at 1.0 against
   * 0.1105 at 1.2 and 0.0398 at 2.0 - so 1.2 -> 1.0 is 1.44x, +0.53 EV, on every
   * emitter core in the frame. It is the one lever in STATUS item A that
   * BRIGHTENS, and it exists to be spent against the two that darken.
   */
  SIGMA_PX: 1.0,

  /**
   * Mean of the metabolic pulse `0.55 + 0.45*sin(...)` in pass/creature.wgsl.
   *
   * A sine has mean zero over its period, so the mean of the pulse is its
   * offset: 0.55, exactly. render/passes/glow.js carried a local 0.775 with the
   * same docstring, which is the mean of the offset and the PEAK rather than of
   * the pulse - 1.41x high. It is here rather than in either consumer because
   * the sprite pass and the cluster light both need it and a pulse that two
   * files disagree about is two animals.
   *
   * Neither consumer may use it in place of the real pulse where the pulse is
   * VISIBLE: pass/creature.wgsl beats the emissive surface and pass/glow.wgsl
   * beats the sprite, both at the animal's own phase. This is for the decisions
   * that must not flicker at that rate - the sprite's cull test, and the
   * intensity of the cluster light, which is re-injected into a temporally
   * reprojected froxel volume every frame.
   */
  PULSE_MEAN: 0.55,

  /**
   * Radiance at which a sprite's skirt stops being drawn, in EXPOSED units.
   *
   * Read against frame.exposureParams.x rather than as a scene-linear constant,
   * so the sprite's extent tracks the day/night cycle instead of ballooning at
   * night. At the deep exposure ceiling of 25.6 this is 1.56e-4 scene-linear,
   * which is 15.6x the histogram's own 1e-5 gate - so every drawn sprite pixel
   * is a METERED pixel and BRIGHT_BUDGET below accounts for all of it.
   */
  FLOOR_EXPOSED: 0.004,

  /**
   * Cull an AUREOLE-ONLY sprite whose predicted peak is below this multiple of
   * the local ambient water radiance. One binary order below the classic ~2x
   * detection threshold for a soft target against a smooth background.
   *
   * IT MUST NEVER BE APPLIED TO A CORE-BEARING SPRITE. That sprite is the other
   * half of pass/creature.wgsl's fRes split - the geometry has already stopped
   * drawing exactly this light - so culling it deletes the emitter rather than
   * hiding it. The first build did, and past 0.82 m a Glimmerkrill's fRes is
   * exactly 0: measured at the night lagoon, 42 of 42 candidates culled, the
   * delivered frame peak fell 140.7 -> 99.9 sRGB and all twelve pixels above
   * code 120 vanished. render/passes/glow.js exempts them unconditionally.
   */
  CONTRAST_MIN: 0.25,

  /**
   * Fraction of frame pixels the pass's AUREOLES are allowed to push above
   * BIN1_CEIL, enforced by one joint scalar on every halo in the frame.
   *
   * IT COUNTS THE AUREOLE AND NOTHING ELSE, because the aureole is the only
   * thing it scales. The core is a handover whose peak is 1/(2*PI*SIGMA_PX^2) =
   * 1/9.05 of what the rasteriser already put in one pixel, so it cannot lift a
   * pixel over a threshold that pixel was not already over; charging it to a
   * budget that then divided everybody's halo was incoherent.
   *
   * WHAT SETS THE NUMBER IS THE METERING WINDOW'S TOP EDGE, AND THE DENOMINATOR
   * IS THE METERED POOL AND NOT THE FRAME. cs_adapt log-averages the 45th-95th
   * percentile band of the weighted population, and that population EXCLUDES bin
   * 0 - every pixel below the 1e-5 gate - so the headroom before bright pixels
   * push the window's top edge out of the floor bin is 5% OF WHAT IS METERED.
   * That fraction is what varies by two orders of magnitude between stations,
   * and it is why two correct-looking derivations disagree by 20x. Re-run here
   * (and in tools/test-glow.mjs section 5) with the shader's own quantised
   * centre weight, area->weight 8/4.2959 = 1.8622:
   *
   *   metered pool     0.02%   0.05%   0.1%    0.2%    0.5%    1%      2%
   *   2.58% of frame   0.000   0.000   0.056   0.248   0.701   1.204   1.630 EV
   *   25% of frame     0.000   0.000   0.000   0.000   0.000   0.063   0.260 EV
   *   100% of frame    0.000   0.000   0.000   0.000   0.000   0.000   0.000 EV
   *
   * THAT LADDER PREDATES THE 2026-08-04 UN-WELD AND IS THE CONSERVATIVE ARM.
   * It was reduced with the histogram's low edge welded to EXPOSURE_MIN_EV and
   * targetEV clamped at the same value; on the shipped edges the three costs
   * tools/test-glow.mjs section 5 reports fall 0.056/0.335/1.630 ->
   * 0.031/0.303/1.564 EV, and with the dark pool where it really meters now
   * (1.8e-4 at Canyon Wall, not 0.015625) the station stays clamped and the
   * budget costs 0.000 EV. So the number below is if anything slack, never
   * tight. Re-deriving it on the live edges is its own measured pass.
   *
   * The first row is the EMPTY ABYSS, where the frame's own mean is 2.1e-6 and
   * almost nothing clears the gate; it is the binding case and it is exactly the
   * frame this pass exists for. A budget derived from a lit station (where the
   * whole frame is metered and 4.6% is free) would be 20x too slack there and
   * would close the loop by 1.63 EV - the failure the sprite exists to avoid.
   * Set at the knee of the worst row. Worst coverage measured live is 4.6e-5,
   * 21.7x under, so the joint scalar does not bind in play.
   */
  BRIGHT_BUDGET: 0.0010,

  /**
   * Scene-linear luminance above which a pixel starts moving the metered
   * average. DERIVED, NOT AUTHORED, from the METERING FLOOR: 23/254 = 0.0906 EV
   * above 2^EXPOSURE_MIN_EV. Changing either EV limit invalidates BRIGHT_BUDGET
   * above; tools/test-glow.mjs asserts the derivation.
   *
   * THE NAME IS NOW A HISTORICAL ONE AND THE DIVERGENCE IS DELIBERATE. It was
   * literally the top of histogram bin 1 until 2026-08-04, when the bin edges
   * moved to HISTOGRAM_MIN_EV; the real bin 1 today is [1e-5, 1.096e-5), 1518x
   * lower, and deriving this from it would multiply glow's bright radius by the
   * same factor (radius goes as 1/BIN1_CEIL, charged coverage as BIN1_CEIL^-2).
   * The QUANTITY glow.js needs was never the bin edge anyway - it is "how bright
   * before this halo starts arguing with the exposure", and that is set by the
   * floor the targetEV clamp is built on, which has not moved. So the formula
   * below is unchanged, the value is unchanged (0.0166), no glow radius moves,
   * and this paragraph is here because a constant that keeps asserting something
   * which stopped being true has already cost this project a whole tuning pass.
   * If EXPOSURE_MIN_EV ever moves, this moves with it, which is still correct.
   */
  BIN1_CEIL: 2 ** (RENDER.EXPOSURE_MIN_EV
    + (RENDER.EXPOSURE_MAX_EV - RENDER.EXPOSURE_MIN_EV) / 254),

  /**
   * Total clipped quad area cap, in whole frames, and the per-sprite radius cap
   * as a fraction of the frame height.
   *
   * Enforced by shrinking EVERY quad by ONE common scalar rather than by
   * dropping sprites, for the reason the vessel allocator's saturation clause
   * gives: clipping members independently rotates the delivered result away from
   * the demanded one. No emitter can lose its core.
   */
  FILL_BUDGET: 1.5,
  /** Per-sprite quad radius cap, as a fraction of the frame HEIGHT. It is a
   *  distance on the tangent plane, so glow.js takes an atan of it to get the
   *  angular cap - reading it as radians made the quad 26% wider than this says
   *  at a 75 deg fovY. */
  MAX_RADIUS_FRAC: 0.5,

  /**
   * Sprite records per frame. RENDER.MAX_CREATURES is 420; the remainder is
   * scatter head-room. 64 bytes each is 32.8 kB/frame against the creature
   * pass's 67 kB.
   */
  MAX_SPRITES: 512,

  /**
   * Scatter aureoles are drawn only when the CAMERA is deeper than this.
   *
   * DEPTH_BANDS[3].min, i.e. the top of the Midnight Zone. This is a hard gate
   * and not a contrast threshold, and that is deliberate: the scatter half adds
   * an aureole the geometry does not give back (there is no f_res handover into
   * scatter.wgsl), so its daylight protection has to be a proof rather than a
   * threshold. The cost is that the shallow reef's fluorescent corals get no
   * aureole - see the notes in render/passes/glow.js.
   */
  SCATTER_MIN_DEPTH: DEPTH_BANDS[3].min,

  /**
   * Metres BELOW SCATTER_MIN_DEPTH over which the scatter aureole ramps in.
   *
   * The ramp starts AT the gate and never above it, so the daylight proof is
   * strictly stronger than the hard switch it replaces: the contribution is
   * exactly zero at 150 m and everywhere shallower. What it buys is the pop -
   * a diver hovering on the 150 m contour bobs +/-1 m on the swim buoyancy
   * drift, and a hard gate switched every emissive instance within 120 m on and
   * off once per bob. Everything else in the renderer that keys on depth is
   * sprung for the same reason (RENDER.WATER_BLEND_TAU).
   *
   * 5 m, not the 15 first tried: the ramp is paid for out of the band it covers,
   * and 15 m held the aureole at 12.5% of full at 153 m - measured, every one of
   * 2,943 scatter candidates then fell under the contrast cull where the hard
   * gate had been drawing them. 5 m puts 153 m at 91.4% while still turning a
   * +/-1 m bob at the contour into a 0 -> 0.10 ramp instead of a 0 -> 1 step.
   */
  SCATTER_FADE_M: 5,
};

// ===========================================================================
// AUDIO
// ===========================================================================

export const AUDIO = {
  /** Bus levels in dB relative to unity. */
  BUS_DB: {
    master: 0, ambience: -6, creature: -3, vessel: -8,
    player: -10, ui: -14, music: -12,
  },
  /** Underwater low-pass cutoff, Hz: fully submerged vs at the surface. */
  SUBMERGED_LOWPASS: 780,
  SURFACE_LOWPASS: 19000,
  /** Crossfade duration when the camera crosses the waterline, seconds. */
  WATERLINE_CROSSFADE: 0.22,
  /** Reverb impulse response length, seconds, by environment. */
  IR_LENGTH: { open: 2.4, cave: 4.8, cabin: 0.35, trench: 6.5 },
  /** Sound travels further underwater; multiply the panner max distance. */
  UNDERWATER_DISTANCE_MULTIPLIER: 3.2,
  /** Leviathan calls are audible from this far, metres. */
  LEVIATHAN_AUDIBLE_RANGE: 640,
};

// ===========================================================================
// UI
// ===========================================================================

/** Instrument palette. sRGB hex, for the Canvas2D HUD layer. */
export const UI_COLORS = {
  ink: '#05080c',
  instrument: '#7fe3d4',
  instrumentDim: '#2f6d68',
  amber: '#ffb757',
  warn: '#ff5e4d',
  good: '#8bd47c',
  text: '#cfe4e6',
  textDim: '#63808a',
  glass: 'rgba(127,227,212,0.06)',
};

export const HUD = {
  /** Compass ribbon, normalized screen coords. */
  COMPASS: { x: 0.5, y: 0.085, width: 0.42, height: 0.034 },
  DEPTH_TAPE: { x: 0.895, y: 0.5, width: 0.055, height: 0.46 },
  ATTITUDE: { x: 0.5, y: 0.5, radius: 0.11 },
  SPEED: { x: 0.105, y: 0.5, width: 0.055, height: 0.46 },
  SONAR: { x: 0.5, y: 0.845, radius: 0.105 },
  ANNUNCIATORS: { x: 0.5, y: 0.955, width: 0.5, height: 0.038 },
  /**
   * Free-swim wrist unit (DESIGN/05 05.8.5), anchored by its BOTTOM-LEFT
   * corner because that is where the forearm sits in frame.
   *
   * Both margins and the height are fractions of screen HEIGHT, and ASPECT
   * derives the width from the height rather than from screen width: the wrist
   * unit is a physical 256x128 device, so a width quoted against screen width
   * would stretch it into a different object on an ultrawide display.
   */
  WRIST: { marginX: 0.030, marginY: 0.040, height: 0.175, aspect: 2.05 },
  /** Free-swim centre reticle radius, fraction of screen height. */
  RETICLE: { radius: 0.011 },
  /** Needle damping (exponential rate per second). */
  NEEDLE_DAMPING: 9.5,
  TAPE_DAMPING: 6.5,
};

// ===========================================================================
// Showcase recording (Shift+G)
// ===========================================================================

/**
 * MediaRecorder settings for the press-Shift-G capture of the demo showcase.
 *
 * **THE RECORDING IS NOT THE CANVAS BACKING STORE, AND THAT IS WHAT MAKES MP4
 * WORK.** The stream came straight off the WebGPU canvas at first, which meant
 * the backing store - `gpu.js` sizes that as the CSS rect times
 * devicePixelRatio (capped at 2), so a 1600x900 window on a HiDPI display
 * handed the encoder 3200x1800 with, worse, whatever parity the rounding left.
 * macOS hardware H.264 refused it and every take fell through to WebM. It is
 * now painted into an intermediate 2D canvas at CSS size, capped by
 * CAPTURE_MAX_* and FORCED EVEN, because H.264 requires even dimensions and an
 * odd one is rejected as flatly as an oversized one. The HUD rides along
 * because `ui/hud.js` composites its OffscreenCanvas into the frame as a GPU
 * texture, and so do the demo's fades, which is why they moved out of DOM and
 * into the lens pass.
 */
export const DEMO_RECORD = {
  /**
   * Capture frame rate, and it is 30 FOR A MEASURED REASON, not for thrift.
   *
   * Chrome's rate control only honours `videoBitsPerSecond` at 30. Same scene,
   * same 24 Mbit/s target, same 5 s, one process: a `captureStream(0)` stream
   * driven by `requestFrame()` delivered **94.5 Mbit/s**, `captureStream(60)`
   * delivered **48.2**, and `captureStream(30)` delivered **24.3**. The target
   * is a per-frame budget, so asking for more frames simply multiplies the
   * file. 30 is also right for the material - the showcase is a gliding
   * cinematic, not a shooter.
   */
  FPS: 30,
  /**
   * 16 Mbit/s, which at FPS 30 is what actually lands (see FPS - the target is
   * only honoured there). Generous for the 1080p-class frame the capture size
   * below produces, and it needs to be: the deep is a very long, very smooth
   * blue gradient and a thrifty bitrate bands it exactly where the lens pass's
   * dither was added to stop it banding.
   *
   * **A FULL 4:20 RUN IS THEREFORE ABOUT 520 MB.** That is the honest cost of a
   * four-minute high-quality capture; halve this for a file you can mail, and
   * check the deep segments for banding afterwards rather than assuming.
   */
  BITRATE: 16e6,
  /**
   * Capture size ceiling. The target is the canvas's CSS size, scaled down to
   * fit inside this box and then rounded DOWN to even on both axes.
   *
   * 1920x1080 is not timidity - it is the largest frame every H.264 encoder
   * this has been run against accepts without negotiation, and the showcase is
   * a video people watch and send, not a master. Raise it (RENDER-style, the
   * object is live and mutable) if you want a bigger file and are prepared to
   * check that your encoder still takes it; the ladder in recorder.js will fall
   * back to WebM rather than fail, which is exactly the symptom that motivated
   * the cap.
   */
  CAPTURE_MAX_WIDTH: 1920,
  CAPTURE_MAX_HEIGHT: 1080,
  /**
   * Chunk interval. Non-zero so a run that ends badly (a tab crash, a closed
   * window) still has most of its data in hand rather than one pending blob.
   */
  TIMESLICE_MS: 1000,
  /**
   * Container preference, MOST CAPABLE FIRST. MP4/H.264 is what was asked for
   * and recent Chrome encodes it directly; the WebM rows are the fallback that
   * keeps this feature working rather than failing on a browser that does not.
   *
   * **THE ORDER IS A PROFILE/LEVEL LADDER AND GETTING IT BACKWARDS SHIPS A
   * FEATURE THAT NEVER RECORDS A FRAME.** The trailing digits are the H.264
   * profile and LEVEL, and a level carries a hard resolution ceiling:
   * `42E01E` is Baseline 3.0, which tops out at 720x480 - and this stream is
   * the canvas backing store, so a 1600x900 window on a HiDPI display hands it
   * 3200x1800. That row was listed FIRST once and every run died with
   * `EncodingError: The given encoder configuration is not supported`.
   * `640034` is High 5.2 (to 4096x2304), `640028` is High 4.0, `4D4028` is
   * Main 4.0; Baseline 3.0 stays only as a last small-window resort.
   *
   * **`MediaRecorder.isTypeSupported` CANNOT DETECT THIS.** It parses the codec
   * STRING and knows nothing about the resolution it will be handed, so it
   * returns true for a row the encoder will refuse - and the refusal arrives
   * ASYNCHRONOUSLY on `onerror`, after `start()` has already returned true.
   * That is why recorder.js walks this list at runtime rather than picking one
   * row and trusting it.
   */
  MIME_CANDIDATES: [
    'video/mp4;codecs=avc1.640034',
    'video/mp4;codecs=avc1.640028',
    'video/mp4;codecs=avc1.4D4028',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/mp4;codecs=avc1.42E01E',
    'video/webm',
  ],
  /**
   * How long the first chunk gets before the encoder is declared dead and the
   * next candidate is tried. AN ENCODER THAT NEITHER ERRORS NOR PRODUCES DATA
   * IS THE FAILURE NOTHING ELSE CATCHES - it looks exactly like a healthy
   * recording until the run ends with an empty blob. Several timeslices, so a
   * merely slow first chunk is never mistaken for a dead one.
   *
   * **10 s AGAINST A MEASURED 3.4 s.** MP4 muxing is not prompt - first chunk
   * arrived at 2233 ms in one measurement and 3388 ms in another, against a
   * 1000 ms timeslice - and this watchdog TEARS DOWN the recorder when it
   * fires, so a false positive destroys a working take. It is the last resort
   * for a silent encoder, not a latency budget: err long.
   */
  FIRST_DATA_TIMEOUT_MS: 10000,
  /** Download filename stem; a UTC timestamp and the container extension follow. */
  FILENAME_PREFIX: 'subwave-showcase',
};

// ===========================================================================
// Derived helpers
// ===========================================================================

/** Hydrostatic pressure in bar at a given depth in metres. */
export const pressureAt = (depth) =>
  1 + Math.max(0, depth) * (WORLD.WATER_DENSITY * WORLD.GRAVITY) / 1e5;

/** Beer-Lambert transmittance for one RGB channel over a path length. */
export const transmittance = (sigmaT, distance) => Math.exp(-sigmaT * distance);

/** Depth at which a channel falls to `fraction` of its surface value. */
export const depthForTransmittance = (sigmaT, fraction) => -Math.log(fraction) / sigmaT;

/** Oxygen multiplier from depth, matching PLAYER.OXYGEN_DEPTH_FACTOR. */
export const oxygenDepthMultiplier = (depth) =>
  Math.min(
    PLAYER.OXYGEN_DEPTH_FACTOR_MAX,
    1 + Math.max(0, pressureAt(depth) - 1) * PLAYER.OXYGEN_DEPTH_FACTOR,
  );
