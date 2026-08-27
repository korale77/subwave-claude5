/**
 * SUBWAVE bioluminescent glow pass - the `particlesPass` slot.
 *
 * Runs AFTER pass/underwater.wgsl and before the post chain, which is what
 * decides everything about its radiometry: the composite has already applied the
 * medium to every pixel in the frame and will not run again, so a sprite drawn
 * here is NOT covered by it and owes itself exactly one thing - its own beam
 * extinction over the wet part of the ray. Not Kd, not the ambient in-scatter,
 * not the deep tint, and not the froxel volume unless the eye is in air. See the
 * comment block in shaders/pass/glow.wgsl.
 *
 * WHY IT EXISTS. Three separate measurements, all recorded in CLAUDE.md:
 *
 *  - A 21 mm Glimmerkrill's emissive area is 0.23 px at 6 m, so the rasteriser
 *    delivers its flux stochastically: peak varies 24x with sub-pixel position
 *    and falls 4000x from 1.5 m to 24 m against 256x for pure 1/r^2.
 *  - Auto-exposure is NOT the cause and cannot take the fix back. The gain is
 *    capped at exactly 25.6 and every deep station sits there, so raising an
 *    emitter is not metered back out. The loop is OPEN; GLOW.BRIGHT_BUDGET is
 *    the coverage at which it would close.
 *
 *    THE MECHANISM CHANGED UNDER THIS CLAUSE ON 2026-08-04 AND THE NUMBER DID
 *    NOT. It used to be the histogram's blindness: binToLuminance(1) was
 *    2^EXPOSURE_MIN_EV = 0.015625, so the metered log-average could not report
 *    anything smaller. Since the un-weld the bins start at HISTOGRAM_MIN_EV and
 *    the meter DOES go lower - measured here on this build, sceneColor, day
 *    fraction 0.32: Canyon Wall 481 m reports 1.84e-4 with the suit lamp off and
 *    1.87e-3 with it on, Abyssal Plain 760 m 1.49e-4 and 1.05e-3, i.e. 3.1 to
 *    6.7 EV BELOW the floor. What holds the gain at 25.6 is now cs_adapt's
 *    targetEV clamp at log2(2^EXPOSURE_MIN_EV / EXPOSURE_KEY) = -4.678 EV, and
 *    the delivered gain measured at all four of those stations is 25.599993.
 *  - Nothing in the renderer draws the medium's own aureole around a point
 *    source except the eight animals that win a MAX_CREATURE_LIGHTS slot. That
 *    aureole carries 1 - exp(-sigma_s * wet) of the arriving flux, which in
 *    ABYSSAL_VOID blue is 6.9% at 6 m and 51.3% at 60 m. It is an ADDITION on
 *    top of the attenuated beam, not a share taken out of it - transmittance has
 *    already removed those photons from the beam, and single scattering is what
 *    puts some of them back.
 *
 * TWO HALVES, WITH DIFFERENT GUARANTEES, AND THE ASYMMETRY IS DELIBERATE.
 *
 *   CREATURES get a core AND an aureole, and the core is a HANDOVER, not an
 *   addition: pass/creature.wgsl multiplies its emissive by
 *   fRes = smoothstep(sigma, 2*sigma, r_emit*f/d) and the sprite carries
 *   1 - fRes, so the total is exactly 1 at every range.
 *
 *   **A CORE-BEARING SPRITE IS THEREFORE NEVER CULLED BY BRIGHTNESS.** The first
 *   build did contrast-cull it, and that turned a redistribution into a
 *   DELETION: `fRes` is gated on FLAG_GLOW_SPRITES, which is set from whether
 *   the PASS is running, and nothing told the shader which emitters actually got
 *   a sprite. Past 0.82 m a Glimmerkrill's fRes is exactly 0, so a culled sprite
 *   removed 100% of its light. Measured on that build: 42 of 42 candidates culled
 *   at the night lagoon, the delivered frame peak fell 140.7 -> 99.9 sRGB and all
 *   twelve pixels above code 120 disappeared. The only culls a core-bearing
 *   sprite may take are the frustum (it is off screen, so is its body) and the
 *   MAX_SPRITES budget, and the budget's eviction skips them.
 *
 *   SCATTER gets the aureole ONLY - never a core - because there is no fRes
 *   handover in pass/scatter.wgsl and reconciling one would mean re-measuring
 *   eighteen emissive types through its gate chain. AND A SCATTER BEACON GETS
 *   NOTHING AT ALL: see the ownership paragraph below. An added aureole with
 *   nothing subtracted is a real change to a sunlit frame (a coral fan's halo is
 *   roughly 11% of its own radiance at 6 m in reef water), so the scatter half
 *   is GATED at GLOW.SCATTER_MIN_DEPTH = 150 m of camera depth and ramps in over
 *   GLOW.SCATTER_FADE_M below that. The ramp starts AT the gate, never above it,
 *   so the daylight proof is strictly stronger than the hard switch it replaced
 *   and a diver bobbing on the 150 m contour no longer pops the whole seabed.
 *   The cost is that the shallow reef's fluorescent corals get no aureole, which
 *   is a look the game arguably wants and is a separate change with its own
 *   measurement.
 *
 * WHY NOT creatures.js's lightSlots. That array is MAX_CREATURE_LIGHTS = 8,
 * gated at sum(rgb) >= 0.25 and 90 m, and exists to spend 8 of the renderer's
 * 256 cluster slots. Sprites need hundreds. It IS used here for one thing: those
 * eight already get an aureole out of sim/froxel_inject.wgsl, so their
 * haloWeight is zeroed and they keep exactly one - but ONLY when the volumetrics
 * pass is actually running. `volumetricLight` is a user setting, and with it off
 * sampleFroxel() returns (0,0,0,1) and the injection draws nothing, so zeroing
 * unconditionally left the eight BRIGHTEST emitters in frame as the only ones in
 * the game with no aureole at all.
 *
 * WHO OWNS A BEACON'S AUREOLE. The same rule as the eight creature lights, one
 * class down and for the same physical reason: an emissive scatter instance that
 * scatter.js promoted to a BEACON light carries `volumetric: 1`, so
 * sim/froxel_inject.wgsl injects it and the volume already draws its aureole.
 * A sprite aureole on top of that is the SECOND copy of one shaft.
 * `scatterPass.lightSlotSet()` was written, exported and documented for this and
 * had no consumer at all - the classic dead-authored-data failure - so every
 * beacon shipped with both halves.
 *
 * WHAT THE SECOND COPY WAS ACTUALLY COSTING, and it is NOT what it looks like.
 * Measured at three deep anchors with the SIM FROZEN, so nothing but this term
 * moves between the two arms (`beaconHaloDouble` is the switch):
 *
 *  - THE DELIVERED FRAME DOES NOT MOVE. At Rock Spires the per-pixel |dL|
 *    between the arms is 0.00258 against 0.00254 between two captures of the
 *    SAME arm, and fully-clipped pixels read 0.0201% / 0.0199% against a
 *    same-arm control of 0.0196%. Abyssal Plain measures 0.00278 against a
 *    control of 0.00404. The second aureole was BELOW the temporal noise floor,
 *    so anyone A/B-ing this on the picture alone will measure nothing.
 *  - IT WAS EATING THE JOINT BRIGHT BUDGET INSTEAD. `haloGain` is ONE scalar
 *    over every sprite in frame (see the budget block below), and at Rock Spires
 *    ten beacon aureoles were 98.6% of the predicted bright coverage -
 *    brightFrac 0.1516 -> 0.00218 - which held the gain at 0.0066 and so scaled
 *    the aureole of all 50 OTHER emitters, the ones with no froxel shaft of
 *    their own, to two thirds of one per cent. Removing them returns the gain to
 *    0.4587: 69.5x. Twilight Terraces: 86.0% of the coverage, 0.00282 -> 0.02018.
 *    Abyssal Plain, where the beacons are 114-146 m out and their halo peaks sit
 *    below BIN1_CEIL: no budget change at all, four fewer sprites.
 *  - AND IT WAS FILL. Sprite overdraw at Rock Spires fell from 0.844 to 0.174
 *    frames: ten quads were 79% of the pass's whole fill.
 *  - NOTHING VANISHED AT RANGE, which is the failure to watch for, because a
 *    sprite is what makes an emitter visible before its geometry resolves. Local
 *    mean radiance over a 24 px disc on each beacon moved LESS between the arms
 *    than between two captures of one arm, at 17.4 / 32.1 / 69.8 / 107.6 m
 *    (Rock Spires) and at every beacon from 114.2 to 145.7 m (Abyssal Plain).
 *    The froxel volume reaches 220 m and the beacon search only 160, so a
 *    promoted beacon is inside the volume by construction and the suppression
 *    needs no distance term.
 *
 * ONLY THE BEACON CLASS. `lightSlotSet()` is beacons AND fill together, and a
 * FILL light carries `volumetric: 0`, which froxel_inject.wgsl rejects on
 * `shape.z <= 0` before it does any arithmetic. A fill light therefore injects
 * NOTHING and its sprite aureole is the only one it has; suppressing on the
 * whole set would delete the near field's glow instead of de-duplicating it.
 * Measured live at Rock Spires: `lightSlotSet().size` is 15 and
 * `haloSuppressedScatter` is 10, which is `scatterPass.stats.beacons` exactly.
 * With `volumetricLight` off it is 0 and the 56 sprites come back, which is the
 * same guarantee the creature half carries and for the same reason.
 *
 * A SUPPRESSED SCATTER SPRITE IS NOT DRAWN AT ALL, which is why it is skipped
 * before consider() rather than passed haloW = 0. A creature keeps its core, so
 * a zeroed halo still leaves a sprite worth drawing; a scatter sprite is the
 * aureole and nothing else, so haloW = 0 makes peak exactly 0, which is below
 * `cullPeak` at every exposure and every depth (floorScene > 0 always). Skipping
 * is therefore byte-identical to zeroing, one contrast cull cheaper, and
 * countable - `stats.haloSuppressedScatter` is the beacon count and
 * `stats.haloSuppressed` stays what it always was, the DRAWN creature sprites
 * with the aureole off.
 *
 * NO VELOCITY WRITE. The sprite is additive and the background shows through it,
 * so writing sprite velocity would corrupt the reprojection of the terrain and
 * scatter UNDERNEATH - high-frequency content that ghosts far worse than a
 * smooth blob loses amplitude.
 */

import {
  colorAttachment, Blend, GROUP, STAGE,
} from '../../core/pipelines.js';
import { FORMATS } from '../../core/gpu.js';
import { BufferUsage, createBuffer } from '../../core/resources.js';
import { profiler } from '../../core/profiler.js';
import { clamp, smoothstep, vec3 } from '../../core/math.js';
import {
  GLOW, RENDER, WORLD, DEEP_TINT_REFERENCE_E, TRUE_DARK_DEPTH,
} from '../../core/constants.js';

/** Bytes per sprite record. Must match `struct Sprite` in pass/glow.wgsl. */
export const SPRITE_STRIDE = 64;
const SPRITE_FLOATS = SPRITE_STRIDE / 4;

/** Share of the sky dome's irradiance that reaches the water. Mirrors
 *  WATER_SKY_SHARE in shaders/common/water.wgsl. */
const WATER_SKY_SHARE = 0.28;

/** Mean of the metabolic pulse 0.55 + 0.45*sin(...). Used for CULL decisions
 *  only, so a sprite cannot flash in and out of existence at its own rate.
 *  Was a local 0.775, which is the mean of the offset and the PEAK and not of
 *  the pulse; see GLOW.PULSE_MEAN, which the cluster light shares. */
const PULSE_MEAN = GLOW.PULSE_MEAN;

/**
 * Build the bioluminescent glow pass.
 *
 * @param {import('../renderer.js').Renderer} renderer
 * @param {object} game the Game instance; needs `creatures`, `creaturePass` and
 *   `scatterPass`
 * @returns {object} a FrameGraph pass, with `.stats` for the acceptance probes
 */
export function makeGlowPass(renderer, game) {
  let device = null;
  let pipeline = null;
  let layout = null;
  let bindGroup = null;
  let spriteBuffer = null;

  const MAX = GLOW.MAX_SPRITES;
  const data = new Float32Array(MAX * SPRITE_FLOATS);

  /** Candidate staging. One allocation each, reused every frame. */
  const cndPos = new Float64Array(MAX * 3);
  const cndDist = new Float32Array(MAX);
  const cndE0 = new Float32Array(MAX * 3);
  const cndCore = new Float32Array(MAX);
  const cndAlpha = new Float32Array(MAX);
  const cndHalo = new Float32Array(MAX);
  const cndHz = new Float32Array(MAX);
  const cndPhase = new Float32Array(MAX);
  const cndWet = new Float32Array(MAX);
  const cndRad = new Float32Array(MAX);
  const cndPeak = new Float32Array(MAX);
  const cndBright = new Float32Array(MAX);
  const cndSelf = new Float32Array(MAX);
  /** See `scatterBeaconIds`. Rebuilt in place every frame, never reallocated. */
  const scatterBeacons = new Set();
  const _absScratch = new Float32Array(3);
  const _centroid = new Float32Array(3);
  const _quatScratch = new Float32Array(4);

  const stats = {
    candidates: 0,
    drawn: 0,
    creatures: 0,
    scatter: 0,
    culledContrast: 0,
    culledFrustum: 0,
    culledCount: 0,
    /** Core-bearing sprites lost to the MAX_SPRITES budget. MUST stay 0: every
     *  one of them is an emitter whose geometry has already given its light up
     *  and has nothing drawing it back. The acceptance probe asserts it. */
    culledCore: 0,
    brightPx: 0,
    brightFrac: 0,
    fillFrames: 0,
    haloGain: 1,
    radiusGain: 1,
    peakExposed: 0,
    scatterGain: 0,
    /** CREATURE sprites, DRAWN, whose aureole was zeroed because
     *  sim/froxel_inject.wgsl is already drawing one for that emitter. It must
     *  fall to 0 when the volumetrics pass is off, or the eight brightest
     *  animals in frame are the only ones in the game with no aureole at all. */
    haloSuppressed: 0,
    /** SCATTER beacons skipped outright for the same reason. Counted separately
     *  because they are not drawn at all - see the ownership paragraph in the
     *  class comment - so they cannot be counted at pack time the way the
     *  creature half is. Falls to 0 with volumetrics off, and above the deep
     *  light gate, where there are no beacons to own anything. */
    haloSuppressedScatter: 0,
  };

  function resetStats() {
    stats.candidates = 0; stats.drawn = 0; stats.creatures = 0; stats.scatter = 0;
    stats.culledContrast = 0; stats.culledFrustum = 0; stats.culledCount = 0;
    stats.culledCore = 0; stats.brightPx = 0; stats.brightFrac = 0;
    stats.fillFrames = 0; stats.haloGain = 1; stats.radiusGain = 1;
    stats.peakExposed = 0; stats.scatterGain = 0; stats.haloSuppressed = 0;
    stats.haloSuppressedScatter = 0;
  }

  /**
   * The BEACON-class subset of `scatterPass.lightSlotSet()`, rebuilt in place.
   *
   * Reused across frames and never reallocated: the abyssal floor offers 7,150
   * emissive candidates and this runs inside the per-frame walk of all of them.
   *
   * WHY A PREFIX IS THE EXACT ANSWER AND NOT A GUESS. `lightSlotSet()` is the
   * beacon class and the fill class in ONE set, and only the beacon class is
   * volumetric (see the ownership paragraph in the class comment). scatter.js's
   * submitLights() clears the set, runs `emitSelection(beaconSel, ...)` first and
   * `emitSelection(fillSel, ...)` second, and adds an id only when
   * renderer.addLight() actually took the light - which is exactly what
   * `stats.beacons` counts. A JS Set iterates in INSERTION order by
   * specification, so the first `stats.beacons` ids ARE the beacon class, with no
   * tolerance and no heuristic. Both are same-frame: submitLights() is registered
   * with renderer.addLightSubmitter() and runs at the top of Renderer.render(),
   * and this pass executes later in that same frame.
   *
   * @param {object} sp the scatter pass
   * @returns {Set<number>} instance ids, `chunk.key * 65536 + index`
   */
  function scatterBeaconIds(sp) {
    scatterBeacons.clear();
    const all = typeof sp.lightSlotSet === 'function' ? sp.lightSlotSet() : null;
    const want = sp.stats ? Math.max(0, sp.stats.beacons | 0) : 0;
    if (!all || want === 0) return scatterBeacons;
    let i = 0;
    for (const id of all) {
      if (i++ >= want) break;
      scatterBeacons.add(id);
    }
    return scatterBeacons;
  }

  // -------------------------------------------------------------------------
  // Environment, evaluated on the CPU exactly as common/water.wgsl does it
  // -------------------------------------------------------------------------

  const _amb = new Float32Array(3);
  const _sig = { sigmaT: null, sigmaS: null, Kd: null, g: 0.9, deepTint: null };

  /** 1 - fresnelSchlick(sinElev, 0.02): the share of the sun that gets in. */
  function surfaceTransmit(sinElev) {
    const m = 1 - clamp(sinElev, 0, 1);
    return 1 - (0.02 + 0.98 * m * m * m * m * m);
  }

  /**
   * Total downwelling irradiance at `depth`, per channel, into `_amb`.
   * The literal counterpart of ambientAtDepth() in common/water.wgsl - if the
   * two disagree the contrast cull is measuring a different ocean than the one
   * on screen.
   */
  function ambientAtDepth(depth) {
    const env = renderer.env;
    const sinElev = Math.max(env.sunDir[1], 0);
    const t = surfaceTransmit(sinElev) * sinElev * env.sunIntensity;
    const sh = env.ambientSH;
    for (let c = 0; c < 3; c++) {
      const above = env.sunColor[c] * t + sh[c] * WATER_SKY_SHARE;
      _amb[c] = above * Math.exp(-_sig.Kd[c] * Math.max(depth, 0));
    }
    return _amb;
  }

  const lum = (r, g, b) => r * 0.2126 + g * 0.7152 + b * 0.0722;

  /**
   * The radiance of the empty water the camera is sitting in, which is what a
   * glow has to be seen AGAINST.
   *
   * Reproduces the terms pass/underwater.wgsl actually delivers for a pixel with
   * nothing behind it: the isotropic diffuse in-scatter sigma_s/sigma_t * E/PI
   * plus the deep tint, both closed by aphoticFactor. Below TRUE_DARK_DEPTH that
   * is identically zero, which is correct and is why the caller floors it at the
   * absolute visibility floor - in total darkness the only test that means
   * anything is "can the eye see this at all".
   */
  function waterRadiance(depth) {
    // aphoticFactor() in common/ocean.wgsl, to the digit: the two have to agree
    // about where the daylight window closes or the cull is measuring a
    // different ocean than the composite draws.
    const ap = 1 - smoothstep(TRUE_DARK_DEPTH * 0.615, TRUE_DARK_DEPTH, depth);
    if (ap <= 0) return 0;
    // `_amb` is deliberately NOT read below - the loop rebuilds the sky term
    // inline because it needs the per-channel split, not the sum. The only live
    // call is the surface one, and it must be the last write to `_amb` or the
    // aliasing bites: e0 IS _amb.
    const e0 = ambientAtDepth(0);
    const surfFrac = clamp(lum(e0[0], e0[1], e0[2]) / DEEP_TINT_REFERENCE_E, 0, 1);
    let acc = 0;
    for (let c = 0; c < 3; c++) {
      const sky = renderer.env.ambientSH[c] * WATER_SKY_SHARE
        * Math.exp(-_sig.Kd[c] * Math.max(depth, 0));
      // The 2026-08-17 clarity pass scales the composite's diffuse veil by
      // the live RENDER.VEIL_DIFFUSE_GAIN (frame.veilTune.x in water.wgsl),
      // so the background this cull predicts must carry the same factor or a
      // glow the dimmer ocean now reveals would still be culled against the
      // old, brighter one. VEIL_CHROMA is not mirrored: localWaterTint() is
      // unit-Rec709-luma by construction and this accumulator is a luma sum.
      // (Pre-existing and deliberately untouched: this term has never carried
      // WATER_DIFFUSE_SIDESCATTER itself - re-deriving that calibration is a
      // separate measured change, not a rider on the veil knob.)
      const scatterTerm = (_sig.sigmaS[c] / Math.max(_sig.sigmaT[c], 1e-6)) * sky / Math.PI
        * Math.max(RENDER.VEIL_DIFFUSE_GAIN, 0);
      const tint = _sig.deepTint[c] * Math.exp(-_sig.Kd[c] * Math.max(depth, 0)) * surfFrac;
      acc += (scatterTerm + tint) * (c === 0 ? 0.2126 : c === 1 ? 0.7152 : 0.0722);
    }
    return acc * ap;
  }

  // -------------------------------------------------------------------------
  // Sizing
  // -------------------------------------------------------------------------

  /**
   * Truncated-halo renormalisation: 1 / C(k), C(k) = k - sqrt(1+k^2) + 1, which
   * is the fraction of the aureole's flux inside k = R/theta0. C(6) = 0.9172.
   * Without it a quad that the fill budget shrank would quietly lose flux.
   */
  function haloNormFor(k) {
    const c = k - Math.sqrt(1 + k * k) + 1;
    return 1 / Math.max(c, 1e-3);
  }

  /**
   * Solve haloShape(psi) * flux = floor for psi, in units of theta0.
   *
   * THE PROFILE IS 1/psi INSIDE theta0 AND 1/psi^3 OUTSIDE, NEVER 1/psi^2, so
   * inverting it gives R proportional to flux near in and to flux^(1/3) far out.
   * The proposed sqrt(I/L_min) is exactly the exponent that never occurs.
   *
   * The exact equation is [1 - k/sqrt(1+k^2)]/k = y, whose left side is strictly
   * DECREASING, so a bright emitter (small y) gets a large k and a dim one a
   * small k. Its two asymptotes are k = 1/(y+1) near in and k = (1/2y)^(1/3) far
   * out, and they cross exactly where k = 1, i.e. at y = 1 - 1/sqrt(2). The
   * selector has to be that comparison and NOT max(): max() picks the far branch
   * for every dim emitter, and at y = 1e6 that is 9,127x the true root - a quad
   * pinned at the radius cap around something that should have been three pixels
   * across.
   *
   * The 1.30 is the safety factor. Both branches are ~22% short exactly AT the
   * crossover, which is where the two asymptotes are least valid, so anything
   * below 1.29 clips the skirt there. Measured against a bisected root over ten
   * decades of y: never short, and never more than 1.48x long.
   */
  const HALO_K_CROSSOVER = 1 - Math.SQRT1_2;
  function haloRadiusK(y) {
    if (!(y > 0) || !Number.isFinite(y)) return 0;
    return 1.30 * (y > HALO_K_CROSSOVER ? 1 / (y + 1) : Math.cbrt(1 / (2 * y)));
  }

  // -------------------------------------------------------------------------
  // Candidate gathering
  // -------------------------------------------------------------------------

  /**
   * Build this frame's sprite list.
   *
   * @returns {number} sprites written into `data`
   */
  function packSprites(camera) {
    resetStats();

    // A DRY ROOM UNDER THE SEA HAS NO GLOW SPRITES IN IT, and this pass cannot
    // discover that for itself. Every emitter it knows about is outside the
    // hull, but a glow sprite is an additive camera-facing quad whose only
    // occlusion is a soft-particle fade that is DELIBERATELY biased in front of
    // its own source - so a body cannot erase its own core - and that bias is
    // exactly enough for an emitter a few metres beyond a wall to bleed through
    // it. Photographed from the habitat's commons, the room was speckled with
    // bioluminescent blobs drifting across the walls, the floor and the
    // furniture; disabling this pass removed every one of them.
    //
    // Its radiometry is wrong from in here too: pass/glow.wgsl attenuates each
    // sprite over the WET part of the ray, and from a pressurised room that
    // length is not the distance to the emitter.
    if (camera.dryInterior) return 0;

    const wt = renderer.env.waterType;
    if (!wt) return 0;
    _sig.sigmaT = wt.sigmaT; _sig.sigmaS = wt.sigmaS; _sig.Kd = wt.Kd;
    _sig.deepTint = wt.deepTint;
    _sig.g = clamp(wt.g, 0.05, 0.995);

    const screenW = renderer.gpu.renderWidth;
    const screenH = renderer.gpu.renderHeight;
    const framePx = screenW * screenH;
    const focal = screenH * 0.5 / Math.tan(camera.fov * 0.5);
    const sigA = GLOW.SIGMA_PX / focal;
    const th0 = (1 - _sig.g) / Math.sqrt(_sig.g);
    // MAX_RADIUS_FRAC is a fraction of the frame HEIGHT, which is a distance on
    // the tangent plane and not an angle: half the frame height is 0.767 tangent
    // units at a 75 deg fovY but only atan(0.767) = 0.654 rad. Reading the
    // fraction as radians made the cap 26% wider than the constant says, on top
    // of a quad whose linear uv mapping was 14.7% short in angle at that radius.
    // Both are gone: the cap is an angle, and vs_glow/fs_glow map through tan.
    const maxRad = Math.atan(GLOW.MAX_RADIUS_FRAC * screenH / focal);

    const exposure = Math.max(renderer.exposure, 1e-6);
    const floorScene = GLOW.FLOOR_EXPOSED / exposure;
    const camDepth = WORLD.SEA_LEVEL - camera.position[1];
    const eyeAbove = Math.max(-camDepth, 0);
    const underwater = camera.isUnderwater;
    // The sprite must clear BOTH the absolute visibility floor and a contrast
    // threshold against the water it is seen against. In the abyss the second is
    // zero and the first is the whole test; in the sunlit zone it is the other
    // way round.
    const cullPeak = Math.max(floorScene,
      GLOW.CONTRAST_MIN * waterRadiance(Math.max(camDepth, 0)));

    const camX = camera.position[0], camY = camera.position[1], camZ = camera.position[2];
    let n = 0;
    // Cached minimum over the EVICTABLE (halo-only) slots, so the over-budget
    // path rejects in O(1) instead of scanning 512 entries per candidate. The
    // abyssal floor offers 7,150 candidates against 512 slots.
    let worstPeak = Infinity;

    /**
     * Accept one emitter.
     *
     * @param {number} x world position
     * @param {number} y world position
     * @param {number} z world position
     * @param {number} fluxR radiant intensity, W/sr, carrying every instance gain
     * @param {number} fluxG radiant intensity, W/sr
     * @param {number} fluxB radiant intensity, W/sr
     * @param {number} emitRadius the emissive organ's own radius, m
     * @param {number} hz pulse rate, 0 for steady
     * @param {number} phase pulse phase
     * @param {number} wantCore 1 if pass/creature.wgsl handed its unresolved
     *   share over for this emitter, 0 for an aureole-only sprite
     * @param {number} haloW 0 to suppress the aureole (the froxel already draws
     *   one for this emitter), 1 otherwise
     * @param {number} selfExtent how far the emitter's OWN geometry can reach in
     *   front of the sprite centre, m - the soft-particle bias
     */
    const consider = (x, y, z, fluxR, fluxG, fluxB, emitRadius, hz, phase,
      wantCore, haloW, selfExtent) => {
      const dx = x - camX, dy = y - camY, dz = z - camZ;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 0.05 || dist > RENDER.MAX_VIEW_DISTANCE) return;
      stats.candidates++;

      // ---- the medium, on the CPU, over the WET part of the ray only -------
      // Same split applyViewRayWater() makes: with the eye submerged the whole
      // geometric ray inside the water counts, and with it in air only the part
      // below the surface does.
      let wet;
      if (underwater) {
        const dirY = dy / dist;
        wet = dirY > 1e-4 ? Math.min(dist, Math.max(camDepth, 0) / dirY) : dist;
      } else {
        const fragDepth = WORLD.SEA_LEVEL - y;
        wet = fragDepth <= 0 ? 0 : dist * clamp(fragDepth / (eyeAbove + fragDepth), 0, 1);
      }

      const inv = 1 / (dist * dist);
      const pulseMean = hz > 0 ? PULSE_MEAN : 1;
      // fRes: the share of the flux the GEOMETRY is drawing, because it resolves
      // the organ. The sprite takes the rest, so the two sum to exactly 1.
      const fRes = wantCore
        ? smoothstep(GLOW.SIGMA_PX, 2 * GLOW.SIGMA_PX, emitRadius * focal / dist)
        : 1;
      const coreWeight = 1 - fRes;

      let e0r = 0, e0g = 0, e0b = 0;
      let lumCore = 0, lumHalo = 0;

      // Per-channel E0, then a luminance summary for every scalar decision.
      //
      // THE CORE IS NOT MULTIPLIED BY (1 - h), AND THE AUREOLE IS AN ADDITION.
      // T = exp(-sigma_t * wet) has ALREADY removed the scattered-out photons
      // from the beam; single scattering is what puts a share of them back, in a
      // 42 px halo instead of a point. Taking (1-h) off the core as well - which
      // the first build did - removed them twice and broke the exact complement
      // with pass/creature.wgsl's fRes, which is the whole guarantee. The total
      // is bounded by conservation: exp(-sigma_t r)*(2 - exp(-sigma_s r)) is at
      // most exp(-sigma_a r), with equality nowhere.
      //
      // And h integrates over `wet`, not `dist`: the dry part of a ray from a
      // boat looking down scatters nothing. At 40 m slant with 5 m of air over a
      // 2 m emitter that is 11.4 m against 40, i.e. 3.6x the scattering path
      // that exists.
      const eR = fluxR * inv, eG = fluxG * inv, eB = fluxB * inv;
      e0r = eR; e0g = eG; e0b = eB;
      for (let c = 0; c < 3; c++) {
        const e = c === 0 ? eR : c === 1 ? eG : eB;
        const T = Math.exp(-_sig.sigmaT[c] * wet);
        const h = 1 - Math.exp(-_sig.sigmaS[c] * wet);
        const w = c === 0 ? 0.2126 : c === 1 ? 0.7152 : 0.0722;
        lumCore += e * T * w;
        lumHalo += e * T * h * w;
      }
      lumCore *= pulseMean * coreWeight;
      lumHalo *= pulseMean * haloW;

      const alphaEff = Math.max(sigA, emitRadius / Math.max(dist, 1e-3));
      const corePeak = lumCore / (2 * Math.PI * sigA * sigA);

      // ---- quad radius, from the real profile ------------------------------
      let quadRad = 0;
      if (lumHalo > 0) {
        const y0 = floorScene * 2 * Math.PI * th0 * th0 / lumHalo;
        quadRad = haloRadiusK(y0) * th0;
      }
      quadRad = clamp(Math.max(quadRad, 4 * sigA), 4 * sigA, maxRad);
      const hNorm = haloNormFor(quadRad / th0);
      const haloPeak = lumHalo * hNorm / (2 * Math.PI * th0 * alphaEff);
      const peak = corePeak + haloPeak;

      // ---- the contrast cull, and the ONE thing it may not touch ------------
      // A core-bearing sprite is the other half of a split: pass/creature.wgsl
      // has already stopped drawing exactly this light, so culling it deletes
      // the emitter instead of hiding it. It is exempt, unconditionally. An
      // aureole-only sprite adds light and is culled normally.
      if (coreWeight <= 0 && peak < cullPeak) { stats.culledContrast++; return; }

      // ---- frustum, against the SPRITE's radius ----------------------------
      // Not the body's alone: a leviathan's halo can be on screen when its hull
      // is not. But never SMALLER than the body either, or a fish straddling the
      // frame edge keeps its geometry (which culls on bodyLength*0.6) and loses
      // the sprite that carries the rest of its light.
      _absScratch[0] = x; _absScratch[1] = y; _absScratch[2] = z;
      const cullR = Math.max(Math.tan(quadRad) * dist, selfExtent);
      if (!camera.isSphereVisible(_absScratch, cullR)) { stats.culledFrustum++; return; }

      // ---- predicted bright coverage, in pixels ----------------------------
      // GLOW.BIN1_CEIL is one old bin width (0.0906 EV) above the METERING
      // FLOOR, 2^EXPOSURE_MIN_EV - it stopped being a histogram bin edge in the
      // 2026-08-04 un-weld and its docstring says why the formula stayed. What
      // it still marks is the level at which a halo pixel starts arguing with
      // the exposure, because the floor the targetEV clamp is built on has not
      // moved. The skirt below it is free.
      //
      // ONLY THE AUREOLE IS COUNTED, because only the aureole is what
      // BRIGHT_BUDGET scales. The core is a handover whose peak is 1/9.05 of
      // what the rasteriser already delivered into one pixel, so it cannot push
      // a pixel over a threshold that pixel was not already over; charging it to
      // a budget that then divides everybody's HALO was incoherent.
      const ceil = GLOW.BIN1_CEIL;
      let rBright = 0;
      if (haloPeak > ceil) {
        // Inside theta0 the aureole is A/(2*PI*th0*psi), so its bright radius is
        // A/(2*PI*th0*ceil) - solved directly rather than inverted numerically.
        const rHaloRad = lumHalo * hNorm / (2 * Math.PI * th0 * ceil);
        rBright = Math.min(rHaloRad, quadRad) * focal;
      }
      const brightPx = Math.PI * rBright * rBright;

      if (n >= MAX) {
        if (peak <= worstPeak) {
          stats.culledCount++;
          if (coreWeight > 0) stats.culledCore++;
          return;
        }
        // Bounded selection: replace the weakest EVICTABLE candidate. A
        // core-bearing sprite is never evictable - see the class comment.
        let worst = -1, wp = Infinity;
        for (let k = 0; k < MAX; k++) {
          if (cndCore[k] > 0) continue;
          if (cndPeak[k] < wp) { wp = cndPeak[k]; worst = k; }
        }
        if (worst < 0 || peak <= wp) {
          worstPeak = worst < 0 ? Infinity : wp;
          stats.culledCount++;
          if (coreWeight > 0) stats.culledCore++;
          return;
        }
        stats.culledCount++;
        writeCandidate(worst, x, y, z, dist, e0r, e0g, e0b, coreWeight, alphaEff,
          haloW, hz, phase, wet, quadRad, peak, brightPx, selfExtent);
        // The evicted slot held the minimum, so the new minimum has to be found
        // again. Every other candidate rejects against `worstPeak` in O(1).
        worstPeak = Infinity;
        for (let k = 0; k < MAX; k++) {
          if (cndCore[k] <= 0 && cndPeak[k] < worstPeak) worstPeak = cndPeak[k];
        }
        return;
      }
      writeCandidate(n, x, y, z, dist, e0r, e0g, e0b, coreWeight, alphaEff,
        haloW, hz, phase, wet, quadRad, peak, brightPx, selfExtent);
      n++;
      if (n === MAX) {
        worstPeak = Infinity;
        for (let k = 0; k < MAX; k++) {
          if (cndCore[k] <= 0 && cndPeak[k] < worstPeak) worstPeak = cndPeak[k];
        }
      }
    };

    function writeCandidate(k, x, y, z, dist, er, eg, eb, coreW, alphaEff, haloW,
      hz, phase, wet, quadRad, peak, brightPx, selfExtent) {
      cndPos[k * 3] = x; cndPos[k * 3 + 1] = y; cndPos[k * 3 + 2] = z;
      cndDist[k] = dist;
      cndE0[k * 3] = er; cndE0[k * 3 + 1] = eg; cndE0[k * 3 + 2] = eb;
      cndCore[k] = coreW;
      cndAlpha[k] = alphaEff;
      cndHalo[k] = haloW;
      cndHz[k] = hz;
      cndPhase[k] = phase;
      cndWet[k] = wet;
      cndRad[k] = quadRad;
      cndPeak[k] = peak;
      cndBright[k] = brightPx;
      cndSelf[k] = selfExtent;
    }

    // Zeroing the halo of a froxel-lit emitter is only right when the injection
    // is actually running. `volumetricLight` is a user setting and
    // volumetrics.enabled() reads it, so a player who turns it off must get the
    // sprite's aureole back instead of losing both. Hoisted out of the creature
    // block because the scatter half below asks the same question of the same
    // pass, and two copies of it could answer differently.
    const vol = game.volumetricsPass;
    const froxelLive = !!(vol && typeof vol.enabled === 'function' && vol.enabled());

    // ---- creatures --------------------------------------------------------
    const sim = game.creatures;
    const cp = game.creaturePass;
    const emit = cp?.speciesEmit;
    if (sim && emit) {
      const live = sim.liveSlots();
      const lightSet = (froxelLive && cp.lightSlotSet) ? cp.lightSlotSet() : null;
      const before = n;
      for (let a = 0; a < live.length; a++) {
        const i = live[a];
        const sp = sim.species[i];
        const f3 = sp * 3;
        const fr = emit.flux[f3], fg = emit.flux[f3 + 1], fb = emit.flux[f3 + 2];
        if (fr <= 0 && fg <= 0 && fb <= 0) continue;

        const s = sim.scale[i];
        const s2 = s * s;
        const depth = WORLD.SEA_LEVEL - sim.posY[i];
        // Both gains come from pass/creature.wgsl and have to be byte-for-byte
        // the same expression or the sprite and the body disagree in brightness.
        const darkGain = 1 + 1.4 * smoothstep(60, 520, depth);
        const arousal = 1 + 1.6 * clamp(sim.fear[i] / 1.3, 0, 1);
        const k = s2 * darkGain * arousal;

        // THE SPRITE SITS ON THE EMISSIVE CENTROID, NOT ON THE ROOT. A
        // Lanterngape's esca is a point at the end of a 1.4 m fish, so a sprite
        // at the root draws its lure 0.7 m away from where the light is - and
        // the root is also deeper inside the body than the organ, which is the
        // worst possible place to put the soft-particle reference. The centroid
        // comes out of the same bake as the flux and is rotated by the instance
        // quaternion; the bone deform is not applied, so this is the rest pose
        // swung into world space and it is exact only for a straight body.
        const c3 = sp * 3;
        _centroid[0] = emit.centroid[c3] * s;
        _centroid[1] = emit.centroid[c3 + 1] * s;
        _centroid[2] = emit.centroid[c3 + 2] * s;
        _quatScratch[0] = sim.orient[i * 4]; _quatScratch[1] = sim.orient[i * 4 + 1];
        _quatScratch[2] = sim.orient[i * 4 + 2]; _quatScratch[3] = sim.orient[i * 4 + 3];
        vec3.transformQuat(_centroid, _centroid, _quatScratch);

        // How far the animal's OWN surface can sit in front of the sprite
        // centre. The soft-particle test is a depth compare against sceneDepth,
        // and sceneDepth over a fish IS the fish - measured, four of six pinned
        // emitters read fade = 0 at their own peak pixel and a Wisplight at
        // 7.88 m lost 30 of the 49 pixels around its centre.
        const selfExtent = sim.bodyLength[i] * 0.6
          + Math.hypot(_centroid[0], _centroid[1], _centroid[2]);

        const haloW = (lightSet && lightSet.has(i)) ? 0 : 1;
        consider(sim.posX[i] + _centroid[0], sim.posY[i] + _centroid[1],
          sim.posZ[i] + _centroid[2],
          fr * k, fg * k, fb * k, emit.radius[sp] * s,
          emit.hz[sp], sim.phase[i], 1, haloW, selfExtent);
      }
      stats.creatures = n - before;
    }

    // ---- emissive scatter -------------------------------------------------
    // The daylight theorem for this half: a hard depth gate, not a threshold.
    const sp2 = game.scatterPass;
    // A RAMP THAT STARTS AT THE GATE, never above it: zero at exactly
    // SCATTER_MIN_DEPTH, full SCATTER_FADE_M below. The hard switch it replaces
    // put every emissive instance within 120 m on and off once per bob for a
    // diver hovering on the 150 m contour, and everything else in the renderer
    // that keys on depth is sprung for exactly that reason.
    const scatterGain = smoothstep(GLOW.SCATTER_MIN_DEPTH,
      GLOW.SCATTER_MIN_DEPTH + GLOW.SCATTER_FADE_M, camDepth);
    stats.scatterGain = scatterGain;
    if (scatterGain > 0 && sp2?.emissiveInstances && sp2.typeEmit) {
      const before = n;
      const chunks = sp2.emissiveInstances();
      const te = sp2.typeEmit;
      // The ownership test, once per frame. Empty above the deep light gate,
      // empty with volumetrics off, and empty when `beaconHaloDouble` asks for
      // the pre-fix image back. Collapsed to null when it is empty so the walk
      // below - up to 7,150 instances on the abyssal floor - does not pay for a
      // lookup that cannot hit.
      const ids = (froxelLive && !beaconHaloDouble) ? scatterBeaconIds(sp2) : null;
      const beacons = ids && ids.size > 0 ? ids : null;
      // FLUORESCENCE IS RE-EMITTED LIGHT, so it must carry the same pump
      // pass/scatter.wgsl applies: the surviving BLUE daylight and nothing else.
      // Below SCATTER_MIN_DEPTH that is essentially zero, which is exactly why a
      // fluorescing coral must not be given a self-powered sprite.
      const e0 = ambientAtDepth(0);
      const surfFrac = clamp(lum(e0[0], e0[1], e0[2]) / DEEP_TINT_REFERENCE_E, 0, 1);
      for (let c = 0; c < chunks.length; c++) {
        const ch = chunks[c];
        for (let j = 0; j < ch.count; j++) {
          const t = ch.type[j];
          const t3 = t * 3;
          if (te.flux[t3] <= 0 && te.flux[t3 + 1] <= 0 && te.flux[t3 + 2] <= 0) continue;
          // THE FROXEL ALREADY DREW THIS ONE. Same id scatter.js ranks by:
          // chunk key in the high half, instance index in the low half.
          if (beacons !== null && beacons.has(ch.key * 65536 + j)) {
            stats.haloSuppressedScatter++;
            continue;
          }
          const x = ch.pos[j * 3], y = ch.pos[j * 3 + 1], z = ch.pos[j * 3 + 2];
          const s = ch.scale[j];
          let k = s * s * ch.emitScale[j] * scatterGain;
          if (te.fluoresces[t]) {
            const d = Math.max(WORLD.SEA_LEVEL - y, 0);
            k *= surfFrac * Math.exp(-_sig.Kd[2] * d);
          }
          if (k <= 0) continue;
          // wantCore 0: scatter gets the AUREOLE ONLY, so it cannot
          // double-count the geometry's own emissive under any circumstance.
          // selfExtent is the instance's own reach - a 2 m crystal spire's front
          // face is metres in front of its centroid.
          consider(x, y, z, te.flux[t3] * k, te.flux[t3 + 1] * k, te.flux[t3 + 2] * k,
            te.radius[t] * s, 0, 0, 0, 1, te.radius[t] * s + s);
        }
      }
      stats.scatter = n - before;
    }

    if (n === 0) return 0;

    // ---- the two budgets, each ONE joint scalar ---------------------------
    // Never by dropping a sprite: clipping members independently rotates the
    // delivered result away from the demanded one, which is the same discipline
    // the vessel's thrust allocator states for its saturation scalar.
    let brightSum = 0, areaSum = 0;
    for (let k = 0; k < n; k++) {
      brightSum += cndBright[k];
      const rpx = Math.tan(cndRad[k]) * focal;
      areaSum += Math.PI * rpx * rpx;
    }
    const haloGain = brightSum > 0
      ? Math.min(1, GLOW.BRIGHT_BUDGET * framePx / brightSum) : 1;
    const radiusGain = areaSum > 0
      ? Math.min(1, Math.sqrt(GLOW.FILL_BUDGET * framePx / areaSum)) : 1;
    stats.haloGain = haloGain;
    stats.radiusGain = radiusGain;
    stats.brightPx = brightSum;
    stats.brightFrac = brightSum / framePx;
    stats.fillFrames = areaSum / framePx;

    for (let k = 0; k < n; k++) {
      const o = k * SPRITE_FLOATS;
      const dist = cndDist[k];
      // Camera-relative, the same convention the creature pass packs with:
      // world minus camera.worldOrigin, which is NOT the eye.
      data[o + 0] = cndPos[k * 3] - camera.worldOrigin[0];
      data[o + 1] = cndPos[k * 3 + 1] - camera.worldOrigin[1];
      data[o + 2] = cndPos[k * 3 + 2] - camera.worldOrigin[2];
      data[o + 3] = dist;
      data[o + 4] = cndE0[k * 3];
      data[o + 5] = cndE0[k * 3 + 1];
      data[o + 6] = cndE0[k * 3 + 2];
      data[o + 7] = cndCore[k];
      const rad = Math.max(cndRad[k] * radiusGain, 4 * sigA);
      data[o + 8] = rad;
      data[o + 9] = cndAlpha[k];
      data[o + 10] = cndHalo[k] * haloGain;
      // Counted here rather than at the call site, so it is a count of sprites
      // actually DRAWN with the aureole suppressed and not of candidates offered.
      if (cndHalo[k] === 0) stats.haloSuppressed++;
      // The soft-particle fade LENGTH is derived in the shader from this same
      // radius and range, so the slot carries the emitter's own reach instead -
      // the bias that stops an animal's body from erasing its own glow.
      data[o + 11] = cndSelf[k];
      data[o + 12] = cndHz[k];
      data[o + 13] = cndPhase[k];
      data[o + 14] = haloNormFor(rad / th0);
      data[o + 15] = cndWet[k];
      if (cndPeak[k] * exposure > stats.peakExposed) {
        stats.peakExposed = cndPeak[k] * exposure;
      }
    }
    stats.drawn = n;
    return n;
  }

  // -------------------------------------------------------------------------
  // Pass
  // -------------------------------------------------------------------------

  let suppressed = false;
  let beaconHaloDouble = false;

  return {
    name: 'glow',
    type: 'render',
    reads: ['sceneDepth'],
    writes: ['sceneColor'],
    stats,

    /**
     * A/B switch for the acceptance probes, and the ONLY honest way to turn this
     * pass off. Setting it clears FLAG_GLOW_SPRITES, so pass/creature.wgsl stops
     * handing its unresolved share over and the geometry goes back to carrying
     * all of it - which is what makes an on/off comparison measure the sprite
     * rather than measuring a hole where the handover used to be.
     *
     * Setting it also ZEROES `stats`. A suppressed pass never reaches execute(),
     * so the numbers would otherwise be the previous arm's and every A/B probe
     * that read them in the OFF arm would be reading the ON arm.
     */
    get suppress() { return suppressed; },
    set suppress(v) { suppressed = !!v; if (suppressed) resetStats(); },

    /**
     * BISECT: `true` gives a scatter beacon its sprite aureole back on top of
     * the froxel's, which is the image every build before 2026-08-05 delivered.
     * Nothing else changes - the creature half keeps its own suppression either
     * way, so the two arms differ in exactly one term and an A/B run in ONE
     * process measures the double and nothing else. It is a knob for probes, in
     * the same spirit as `RENDER`'s live-mutable bisect constants; the game
     * never writes it.
     */
    get beaconHaloDouble() { return beaconHaloDouble; },
    set beaconHaloDouble(v) { beaconHaloDouble = !!v; },

    enabled() {
      return pipeline !== null && !suppressed;
    },

    init(ctx) {
      device = ctx.device;
      const module = ctx.shaders.module('pass/glow.wgsl', {
        GLOW_SIGMA_PX: GLOW.SIGMA_PX.toFixed(3),
      }, 'glow');

      spriteBuffer = createBuffer(device, {
        label: 'glow.sprites',
        size: MAX * SPRITE_STRIDE,
        usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
      });

      // sceneDepth binds as a TEXTURE and the pass has no depth attachment, so
      // the same texture is never TEXTURE_BINDING and RENDER_ATTACHMENT inside
      // one synchronisation scope - and an additive glow structurally cannot
      // write depth.
      layout = ctx.pipelines.bindGroupLayout('glow.bgl', [
        { binding: 0, visibility: STAGE.VF, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: STAGE.F, texture: { sampleType: 'depth' } },
      ]);

      pipeline = ctx.pipelines.renderPipeline({
        label: 'glow',
        layout: ctx.pipelines.pipelineLayout('glow.pl', [renderer.frameLayout, layout]),
        vertex: { module, entryPoint: 'vs_glow' },
        fragment: {
          module,
          entryPoint: 'fs_glow',
          targets: [{ format: FORMATS.hdr, blend: Blend.additiveAlpha }],
        },
        // A LOCAL primitive state, not Primitive.strip: that preset carries
        // cullMode 'back', which would cull half of every quad, and a
        // stripIndexFormat, which is for indexed draws and this is not one.
        primitive: { topology: 'triangle-strip', cullMode: 'none', frontFace: 'ccw' },
      });

      rebuild(ctx);
    },

    resize(ctx) { rebuild(ctx); },

    execute(ctx, encoder) {
      if (!pipeline) return;
      const count = packSprites(ctx.camera);
      // RETURN BEFORE OPENING A RENDER PASS. With no sprites the frame is
      // byte-identical to not having this pass at all and costs no GPU scope,
      // which is the mechanical form of the daylight guarantee.
      if (count === 0) return;

      device.queue.writeBuffer(spriteBuffer, 0, data.buffer, 0, count * SPRITE_STRIDE);

      const pass = encoder.beginRenderPass(profiler.gpuPass({
        label: 'glow',
        colorAttachments: [colorAttachment(ctx.targets.view('sceneColor'), { loadOp: 'load' })],
      }, 'glow'));
      pass.setPipeline(pipeline);
      pass.setBindGroup(GROUP.FRAME, ctx.frameBindGroup);
      pass.setBindGroup(GROUP.PASS, bindGroup);
      pass.draw(4, count);
      pass.end();
    },

    destroy() {
      spriteBuffer?.destroy();
      spriteBuffer = null;
      pipeline = null;
    },
  };

  function rebuild(ctx) {
    if (!layout) return;
    bindGroup = ctx.device.createBindGroup({
      label: 'glow.bg',
      layout,
      entries: [
        { binding: 0, resource: { buffer: spriteBuffer } },
        { binding: 1, resource: ctx.targets.view('sceneDepth') },
      ],
    });
  }
}
