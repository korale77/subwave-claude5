/**
 * SUBWAVE creature simulation.
 *
 * The five-layer agent stack of DESIGN/06.1, implemented as one flat pass over
 * structure-of-arrays storage. There is no Creature object anywhere in this
 * file: an agent is an index, its fields are typed arrays, and the whole sim is
 * a handful of loops over primitives.
 *
 *   L4  utility select   scores the eligible behaviours, picks one, applies
 *                        inertia + cooldown            (4 Hz / 1 Hz / 0.25 Hz)
 *   L3  HFSM             the chosen behaviour's small state machine
 *   L2  steering         nine weighted forces, blended, smoothed, clamped
 *   L1  locomotion       force -> acceleration with drag, buoyancy, turn limit
 *   L0  animation        phase advance only; the wave itself is on the GPU
 *
 * WHY SoA AND NOT OBJECTS. 260 agents is small, but the sim runs at 60 Hz and
 * shares a 2 ms CPU budget with the vessel and the player. An array of objects
 * puts every agent's position three pointer hops from its velocity, and the
 * steering loop touches nine fields per agent per force. Flat Float32Arrays
 * keep the whole working set - 260 * 4 B * 40 fields = 42 KB - inside L2, and
 * they are also what the render pass wants to read when it packs instances.
 *
 * ZERO ALLOCATION PER FRAME is a hard requirement, not an aspiration: a
 * 120 fps target leaves 8.3 ms, and a young-generation collection costs more
 * than that. Every vector this file needs is a module-scope scratch allocated
 * once at load. tools/test-creatures.mjs measures heap delta across 10,000
 * ticks and fails if it moves.
 *
 * LOD-AI. Three classes, promoted on the band edge and demoted at 1.12x it so
 * an agent hovering at 60 m does not thrash:
 *
 *   FULL         0 - 60 m     ticks every 2nd sim step  = 30 Hz
 *   REDUCED     60 - 200 m    ticks every 6th sim step  = 10 Hz
 *   STATISTICAL   > 200 m     ticks every 60th sim step =  1 Hz
 *
 * The tick rate IS the integration rate: an agent that ticks at 10 Hz
 * integrates with dt = 0.1 s, so its trajectory is the same shape as a 30 Hz
 * agent's, just coarser. Perception and behaviour selection run on their own,
 * slower staggers on top of that (see PERCEPTION_PERIOD / SELECT_PERIOD).
 *
 * OBSTACLE AVOIDANCE IS FIVE HEIGHT PROBES, NOT FIVE RAYCASTS. DESIGN/06.1.5
 * specifies a sphere-traced SDF whisker per direction, which is the right
 * answer for a triangle-soup world. This world is a heightfield, so
 * "is there ground within lookAhead along d" reduces to comparing the probe
 * point's y against terrain height at its xz - one sample instead of the 40-500
 * steps CollisionWorld.raycast() takes. At 130 agents a frame that is the
 * difference between 0.1 ms and 40 ms.
 *
 * COORDINATES. Absolute world metres throughout, +Y up, depth d = -y. Model
 * space for every creature mesh is BINDING: the snout is at -Z, the tail at
 * +Z, +Y up, +X starboard, so an orientation quaternion from
 * quat.lookRotation(q, swimDirection) points the animal where it is going. The
 * vessel mesh uses the same convention.
 */

import {
  vec3, quat, clamp, saturate, smoothstep, TAU, PI, makeRng, hashU32, wrapAngle,
} from '../core/math.js';
import { WORLD, RENDER, WATER_TYPES, CREATURE_DRAW } from '../core/constants.js';
import { events, EVENTS } from '../core/events.js';
import { Staggered } from '../core/time.js';
import { SpatialHash } from '../world/collision.js';
import { SPECIES, DANGER_BY_TIER } from './bestiary.js';

/**
 * Vector length, without Math.hypot.
 *
 * Math.hypot is the correct function in general - it rescales so that a vector
 * whose components overflow when squared still measures correctly - and it is
 * the wrong function here. This file calls it about fifteen times per agent per
 * tick, and MEASURED against Math.sqrt of the dot product over 20 million
 * calls it is 188 ms against 56 ms (3.4x slower) and allocates 0.0365 B per
 * call against 0.0004 (V8's variadic builtin), which at 130 agents a tick is
 * 8 B of garbage per tick for nothing.
 *
 * The overflow protection buys nothing at this scale: every component is a
 * world coordinate or a velocity, bounded by WORLD.HALF_EXTENT = 3072 and by
 * the fastest burst speed in the roster, so the largest square this ever forms
 * is 9.4e6 - fourteen orders of magnitude below where f64 squaring loses
 * anything.
 */
const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
const len2 = (x, y) => Math.sqrt(x * x + y * y);

// ===========================================================================
// Archetypes
// ===========================================================================

/**
 * Swimming modes, from DESIGN/06.3.2. The id is uploaded to the GPU and
 * switched on in shaders/pass/creature.wgsl, so these values are BINDING and
 * must match the `AM_*` constants there.
 */
export const ANIM_MODE = {
  ANGUILLIFORM: 0,   // eel: whole body waves, short wavelength
  SUBCARANGIFORM: 1, // most fish: rear two thirds
  CARANGIFORM: 2,    // fast cruisers: rear half
  THUNNIFORM: 3,     // tuna/cetacean: tail only, stiff body
  OSTRACIIFORM: 4,   // boxfish: caudal fin only, rigid body
  RAJIFORM: 5,       // ray: wave along the pectoral span
  JET: 6,            // squid/jelly: mantle or bell contraction
  WING: 7,           // flyer: wingbeat
  LEG: 8,            // walker/crustacean: gait, body barely moves
};

/**
 * Per-mode amplitude envelope `env(u) = c0 + c1*u + c2*u^2` and the spine
 * fraction the wave is active over, straight out of DESIGN/06.3.2's mode
 * table. env(1) = c0 + c1 + c2 is normalised to 1 by construction, which is
 * what makes `A` mean "peak tail amplitude in body lengths".
 *
 * Uploaded to the GPU as part of the archetype block.
 */
export const ANIM_MODE_ENV = Object.freeze([
  { c0: 0.10, c1: 0.20, c2: 0.70, uMin: 0.05 },   // ANGUILLIFORM
  { c0: 0.06, c1: -0.13, c2: 1.07, uMin: 0.25 },  // SUBCARANGIFORM
  { c0: 0.02, c1: -0.28, c2: 1.26, uMin: 0.45 },  // CARANGIFORM
  { c0: 0.01, c1: -0.35, c2: 1.34, uMin: 0.70 },  // THUNNIFORM
  { c0: 0.00, c1: 0.00, c2: 1.00, uMin: 0.92 },   // OSTRACIIFORM
  { c0: 0.00, c1: 0.30, c2: 0.70, uMin: 0.10 },   // RAJIFORM (u is span, not length)
  { c0: 0.05, c1: 0.25, c2: 0.70, uMin: 0.00 },   // JET (mantle contraction envelope)
  { c0: 0.00, c1: 0.10, c2: 0.90, uMin: 0.15 },   // WING
  { c0: 0.20, c1: 0.40, c2: 0.40, uMin: 0.30 },   // LEG (a slow body sway only)
]);

/**
 * Field order of SPECIES_TABLE.swimAnim. BINDING - it indexes a flat array read
 * by `_animate` here and by `writeSpeciesAnim` in render/passes/creatures.js.
 * Every name matches the ARCHETYPES column it defaults from.
 */
export const SWIM_ANIM = Object.freeze({
  f0: 0, kf: 1, fMin: 2, fMax: 3,
  A0: 4, A1: 5, U0: 6, U1: 7,
  lambdaB: 8, bendMax: 9, Ap: 10,
});
export const SWIM_ANIM_STRIDE = 11;

/** Steering force slots. The order is BINDING: it indexes every weight row. */
export const STEER = {
  SEEK: 0, FLEE: 1, WANDER: 2, ARRIVE: 3,
  SEPARATION: 4, ALIGNMENT: 5, COHESION: 6, OBSTACLE: 7, DEPTH: 8,
};
export const STEER_COUNT = 9;

/** Archetype ids. Index into ARCHETYPES. */
export const ARCHETYPE = {
  PLANKTON: 0, SHOALER: 1, REEFDART: 2, GRAZER: 3, SCAVENGER: 4,
  CRUSTACEAN: 5, DRIFTER: 6, CEPHALOPOD: 7, GLIDER: 8, AMBUSHER: 9,
  PACK: 10, LURER: 11, FILTER_GIANT: 12, LEVIATHAN: 13, LANDWALKER: 14,
  FLYER: 15, BURROWER: 16,
};

/**
 * Drag coefficient by body plan, DESIGN/06.1.6. Used by the dynamic locomotion
 * model; `Aref = 0.72 * width * height` and width/height are derived from
 * length by the archetype's `aspect`.
 */
const CD = {
  fusiform: 0.055, compressed: 0.11, anguilliform: 0.075, discoid: 0.16,
  gelatinous: 0.42, boxy: 0.85,
};

/**
 * THE ARCHETYPE TABLE. Steering weights and path-smoothing from
 * DESIGN/06.1.7; animation parameters from DESIGN/06.3.5. Every number here is
 * transcribed from those two tables - if one disagrees with the doc, this file
 * wins and the doc is stale.
 *
 *   w         the nine steering blend weights, indexed by STEER
 *   tau       path-smoothing time constant, seconds
 *   aMax      maximum steering acceleration, m/s^2
 *   la        [kLA, lookMin, lookMax] obstacle look-ahead, metres
 *   rSep/rAli/rCoh   boids radii, metres
 *   nSpine    spine bone count (capped by RENDER.MAX_BONES_PER_CREATURE)
 *   mode      ANIM_MODE
 *   f0/kf     tail-beat frequency = clamp(f0 + kf*U, fMin, fMax) Hz, U in
 *             body-lengths per second
 *   A0/A1     peak tail amplitude in body lengths, at U0 and U1
 *   lambdaB   body wavelength in body lengths
 *   bendMax   maximum turn-induced body bend, radians
 *   rollMax   maximum bank angle, radians
 *   tStartle  C-start duration, seconds
 *   mFin      pectoral beat rate as a multiple of the tail beat
 *   af0/af1   pectoral flutter amplitude at rest / at speed, radians
 *   cd        drag coefficient
 *   aspect    [width, height] as fractions of length, for Aref
 *   buoy      buoyancy ratio; < 1 sinks, > 1 floats
 */
export const ARCHETYPES = Object.freeze([
  {
    id: ARCHETYPE.PLANKTON, name: 'ARCH_PLANKTON',
    w: [0.00, 0.20, 1.00, 0.00, 0.30, 0.10, 0.60, 0.40, 1.20],
    tau: 0.90, aMax: 0.40, la: [1.0, 1.0, 3.0], rSep: 0.25, rAli: 0.6, rCoh: 1.4,
    nSpine: 3, mode: ANIM_MODE.ANGUILLIFORM,
    f0: 3.2, kf: 1.4, fMin: 2.0, fMax: 9.0, A0: 0.09, A1: 0.16, U0: 0.5, U1: 4.0,
    lambdaB: 0.60, bendMax: 0.349, rollMax: 0.087, tStartle: 0.06,
    mFin: 2.0, af0: 0.384, af1: 0.140,
    cd: CD.anguilliform, aspect: [0.30, 0.30], buoy: 1.002,
  },
  {
    id: ARCHETYPE.SHOALER, name: 'ARCH_SHOALER',
    w: [0.40, 2.20, 0.35, 0.30, 1.60, 1.10, 0.90, 2.00, 0.50],
    tau: 0.12, aMax: 9.0, la: [1.5, 2.0, 8.0], rSep: 0.9, rAli: 3.2, rCoh: 5.0,
    nSpine: 7, mode: ANIM_MODE.SUBCARANGIFORM,
    f0: 1.1, kf: 1.15, fMin: 0.8, fMax: 8.5, A0: 0.06, A1: 0.11, U0: 0.8, U1: 7.0,
    lambdaB: 0.85, bendMax: 0.593, rollMax: 0.454, tStartle: 0.12,
    mFin: 1.0, af0: 0.524, af1: 0.157,
    cd: CD.compressed, aspect: [0.16, 0.32], buoy: 1.000,
  },
  {
    id: ARCHETYPE.REEFDART, name: 'ARCH_REEFDART',
    w: [0.70, 2.40, 0.80, 0.60, 0.60, 0.15, 0.20, 2.20, 0.70],
    tau: 0.10, aMax: 12.0, la: [1.4, 1.5, 6.0], rSep: 1.1, rAli: 2.0, rCoh: 3.0,
    nSpine: 6, mode: ANIM_MODE.SUBCARANGIFORM,
    f0: 1.4, kf: 1.05, fMin: 0.9, fMax: 8.0, A0: 0.05, A1: 0.12, U0: 0.6, U1: 6.5,
    lambdaB: 0.82, bendMax: 0.733, rollMax: 0.593, tStartle: 0.10,
    mFin: 2.0, af0: 0.733, af1: 0.244,
    cd: CD.compressed, aspect: [0.18, 0.42], buoy: 1.000,
  },
  {
    id: ARCHETYPE.GRAZER, name: 'ARCH_GRAZER',
    w: [0.50, 1.30, 0.60, 0.90, 0.70, 0.05, 0.35, 1.60, 1.40],
    tau: 0.35, aMax: 3.0, la: [1.6, 2.0, 6.0], rSep: 1.8, rAli: 4.0, rCoh: 7.0,
    nSpine: 8, mode: ANIM_MODE.CARANGIFORM,
    f0: 0.7, kf: 0.90, fMin: 0.4, fMax: 4.5, A0: 0.05, A1: 0.09, U0: 0.4, U1: 3.0,
    lambdaB: 0.95, bendMax: 0.454, rollMax: 0.244, tStartle: 0.20,
    mFin: 1.0, af0: 0.454, af1: 0.209,
    cd: CD.compressed, aspect: [0.20, 0.34], buoy: 0.998,
  },
  {
    id: ARCHETYPE.SCAVENGER, name: 'ARCH_SCAVENGER',
    w: [1.10, 1.00, 0.55, 0.80, 0.50, 0.05, 0.15, 1.50, 0.60],
    tau: 0.30, aMax: 4.0, la: [1.6, 2.0, 8.0], rSep: 1.2, rAli: 2.5, rCoh: 4.0,
    nSpine: 12, mode: ANIM_MODE.ANGUILLIFORM,
    f0: 0.9, kf: 1.00, fMin: 0.5, fMax: 5.5, A0: 0.11, A1: 0.19, U0: 0.4, U1: 3.5,
    lambdaB: 0.65, bendMax: 1.047, rollMax: 0.140, tStartle: 0.16,
    mFin: 1.0, af0: 0.244, af1: 0.105,
    cd: CD.anguilliform, aspect: [0.09, 0.11], buoy: 0.996,
  },
  {
    id: ARCHETYPE.CRUSTACEAN, name: 'ARCH_CRUSTACEAN',
    w: [0.60, 1.60, 0.45, 1.00, 0.80, 0.00, 0.10, 2.40, 2.00],
    tau: 0.25, aMax: 5.0, la: [1.2, 1.0, 4.0], rSep: 0.8, rAli: 0.0, rCoh: 2.0,
    nSpine: 4, mode: ANIM_MODE.LEG,
    // A crustacean's body barely flexes: the visible motion is the gait, whose
    // frequency is speed / stride and whose amplitude is fixed. f0/kf therefore
    // describe the STEP rate, and A stays tiny so the carapace stays rigid.
    f0: 0.4, kf: 1.60, fMin: 0.4, fMax: 4.5, A0: 0.010, A1: 0.022, U0: 0.2, U1: 3.0,
    lambdaB: 1.60, bendMax: 0.209, rollMax: 0.105, tStartle: 0.09,
    mFin: 3.2, af0: 0.140, af1: 0.070,
    cd: CD.boxy, aspect: [0.62, 0.34], buoy: 0.940,
  },
  {
    id: ARCHETYPE.DRIFTER, name: 'ARCH_DRIFTER',
    w: [0.05, 0.10, 0.25, 0.00, 0.40, 0.00, 0.10, 0.30, 1.60],
    tau: 1.60, aMax: 0.25, la: [1.0, 1.0, 3.0], rSep: 2.5, rAli: 0.0, rCoh: 6.0,
    nSpine: 5, mode: ANIM_MODE.JET,
    f0: 0.35, kf: 0.25, fMin: 0.2, fMax: 1.1, A0: 0.14, A1: 0.22, U0: 0.1, U1: 0.8,
    lambdaB: 1.00, bendMax: 0.140, rollMax: 0.052, tStartle: 0.50,
    mFin: 1.0, af0: 0.262, af1: 0.175,
    cd: CD.gelatinous, aspect: [0.90, 0.90], buoy: 1.001,
  },
  {
    id: ARCHETYPE.CEPHALOPOD, name: 'ARCH_CEPHALOPOD',
    w: [0.90, 2.60, 0.50, 0.70, 0.60, 0.00, 0.05, 2.00, 0.80],
    tau: 0.08, aMax: 14.0, la: [1.3, 1.5, 7.0], rSep: 1.5, rAli: 0.0, rCoh: 0.0,
    nSpine: 6, mode: ANIM_MODE.JET,
    f0: 0.9, kf: 0.6, fMin: 0.4, fMax: 3.0, A0: 0.08, A1: 0.13, U0: 0.3, U1: 5.0,
    lambdaB: 1.00, bendMax: 0.524, rollMax: 0.698, tStartle: 0.07,
    mFin: 1.5, af0: 0.349, af1: 0.175,
    cd: CD.fusiform, aspect: [0.28, 0.28], buoy: 1.000,
  },
  {
    id: ARCHETYPE.GLIDER, name: 'ARCH_GLIDER',
    w: [0.55, 1.20, 0.70, 0.50, 0.45, 0.20, 0.25, 1.80, 1.10],
    tau: 0.45, aMax: 4.0, la: [1.8, 3.0, 12.0], rSep: 2.2, rAli: 6.0, rCoh: 9.0,
    nSpine: 6, mode: ANIM_MODE.RAJIFORM,
    f0: 0.45, kf: 0.75, fMin: 0.25, fMax: 3.2, A0: 0.10, A1: 0.20, U0: 0.3, U1: 3.0,
    lambdaB: 1.40, bendMax: 0.384, rollMax: 0.524, tStartle: 0.22,
    mFin: 1.0, af0: 0.000, af1: 0.000,
    cd: CD.discoid, aspect: [1.10, 0.14], buoy: 0.994,
  },
  {
    id: ARCHETYPE.AMBUSHER, name: 'ARCH_AMBUSHER',
    w: [1.40, 0.60, 0.15, 1.20, 0.30, 0.00, 0.00, 1.70, 1.30],
    tau: 0.06, aMax: 18.0, la: [1.1, 1.5, 5.0], rSep: 2.0, rAli: 0.0, rCoh: 0.0,
    nSpine: 9, mode: ANIM_MODE.SUBCARANGIFORM,
    f0: 0.5, kf: 1.60, fMin: 0.2, fMax: 9.5, A0: 0.04, A1: 0.19, U0: 0.2, U1: 9.0,
    lambdaB: 0.78, bendMax: 0.960, rollMax: 0.384, tStartle: 0.07,
    mFin: 1.0, af0: 0.593, af1: 0.175,
    cd: CD.fusiform, aspect: [0.19, 0.26], buoy: 0.999,
  },
  {
    id: ARCHETYPE.PACK, name: 'ARCH_PACK',
    w: [1.30, 0.80, 0.40, 0.90, 1.20, 0.80, 0.70, 1.90, 0.70],
    tau: 0.10, aMax: 11.0, la: [1.6, 2.0, 10.0], rSep: 2.6, rAli: 8.0, rCoh: 14.0,
    nSpine: 8, mode: ANIM_MODE.CARANGIFORM,
    f0: 1.2, kf: 1.10, fMin: 0.8, fMax: 7.5, A0: 0.05, A1: 0.11, U0: 0.8, U1: 8.0,
    lambdaB: 1.00, bendMax: 0.698, rollMax: 0.663, tStartle: 0.09,
    mFin: 1.0, af0: 0.489, af1: 0.140,
    cd: CD.fusiform, aspect: [0.17, 0.24], buoy: 1.000,
  },
  {
    id: ARCHETYPE.LURER, name: 'ARCH_LURER',
    w: [1.20, 0.40, 0.10, 1.30, 0.25, 0.00, 0.00, 1.20, 1.50],
    tau: 0.05, aMax: 16.0, la: [1.0, 1.0, 4.0], rSep: 3.0, rAli: 0.0, rCoh: 0.0,
    nSpine: 7, mode: ANIM_MODE.SUBCARANGIFORM,
    f0: 0.30, kf: 1.90, fMin: 0.15, fMax: 8.0, A0: 0.05, A1: 0.21, U0: 0.1, U1: 7.0,
    lambdaB: 0.80, bendMax: 0.838, rollMax: 0.209, tStartle: 0.08,
    mFin: 1.0, af0: 0.524, af1: 0.209,
    cd: CD.compressed, aspect: [0.34, 0.44], buoy: 0.999,
  },
  {
    id: ARCHETYPE.FILTER_GIANT, name: 'ARCH_FILTER_GIANT',
    w: [0.60, 0.30, 0.45, 0.70, 0.30, 0.10, 0.20, 2.60, 1.00],
    tau: 1.10, aMax: 1.20, la: [2.4, 12.0, 50.0], rSep: 14.0, rAli: 30.0, rCoh: 55.0,
    nSpine: 14, mode: ANIM_MODE.CARANGIFORM,
    f0: 0.22, kf: 0.45, fMin: 0.12, fMax: 0.95, A0: 0.03, A1: 0.07, U0: 0.15, U1: 1.2,
    lambdaB: 1.10, bendMax: 0.279, rollMax: 0.209, tStartle: 0.90,
    mFin: 1.0, af0: 0.314, af1: 0.175,
    cd: CD.fusiform, aspect: [0.22, 0.30], buoy: 1.000,
  },
  {
    id: ARCHETYPE.LEVIATHAN, name: 'ARCH_LEVIATHAN',
    w: [1.00, 0.10, 0.35, 0.85, 0.20, 0.00, 0.00, 3.00, 0.90],
    tau: 0.55, aMax: 3.50, la: [2.6, 16.0, 70.0], rSep: 20.0, rAli: 0.0, rCoh: 0.0,
    nSpine: 16, mode: ANIM_MODE.THUNNIFORM,
    f0: 0.16, kf: 0.55, fMin: 0.08, fMax: 1.30, A0: 0.03, A1: 0.09, U0: 0.1, U1: 1.6,
    lambdaB: 1.25, bendMax: 0.524, rollMax: 0.349, tStartle: 0.60,
    mFin: 1.0, af0: 0.349, af1: 0.175,
    cd: CD.fusiform, aspect: [0.18, 0.26], buoy: 1.000,
  },
  {
    id: ARCHETYPE.LANDWALKER, name: 'ARCH_LANDWALKER',
    // DEPTH is 0 for a land animal: DESIGN/06.1.7 replaces it with a
    // ground-clamp, which _groundClamp() applies after integration.
    w: [0.80, 1.90, 0.65, 1.00, 0.90, 0.10, 0.40, 2.60, 0.00],
    tau: 0.20, aMax: 7.0, la: [1.2, 1.0, 4.0], rSep: 1.0, rAli: 2.0, rCoh: 4.0,
    nSpine: 5, mode: ANIM_MODE.LEG,
    f0: 0.5, kf: 1.40, fMin: 0.4, fMax: 4.5, A0: 0.012, A1: 0.030, U0: 0.2, U1: 4.0,
    lambdaB: 1.60, bendMax: 0.314, rollMax: 0.175, tStartle: 0.10,
    mFin: 2.0, af0: 0.175, af1: 0.087,
    cd: CD.boxy, aspect: [0.30, 0.34], buoy: 0.930,
  },
  {
    id: ARCHETYPE.FLYER, name: 'ARCH_FLYER',
    w: [0.85, 1.70, 0.90, 0.60, 1.10, 0.70, 0.80, 2.20, 1.00],
    tau: 0.25, aMax: 8.0, la: [2.0, 6.0, 24.0], rSep: 2.4, rAli: 7.0, rCoh: 12.0,
    nSpine: 5, mode: ANIM_MODE.WING,
    f0: 2.4, kf: 0.35, fMin: 0.8, fMax: 5.5, A0: 0.30, A1: 0.45, U0: 0.5, U1: 12.0,
    lambdaB: 1.00, bendMax: 0.419, rollMax: 0.960, tStartle: 0.12,
    mFin: 1.0, af0: 1.082, af1: 0.663,
    cd: CD.fusiform, aspect: [0.90, 0.20], buoy: 0.001,
  },
  {
    id: ARCHETYPE.BURROWER, name: 'ARCH_BURROWER',
    w: [0.70, 2.00, 0.50, 1.10, 0.60, 0.00, 0.20, 2.00, 1.80],
    tau: 0.18, aMax: 6.0, la: [1.0, 1.0, 3.0], rSep: 1.4, rAli: 0.0, rCoh: 3.0,
    nSpine: 6, mode: ANIM_MODE.LEG,
    f0: 0.5, kf: 1.50, fMin: 0.4, fMax: 4.5, A0: 0.014, A1: 0.034, U0: 0.2, U1: 4.0,
    lambdaB: 1.60, bendMax: 0.384, rollMax: 0.209, tStartle: 0.08,
    mFin: 2.0, af0: 0.209, af1: 0.105,
    cd: CD.boxy, aspect: [0.34, 0.36], buoy: 0.930,
  },
]);

export const ARCHETYPE_COUNT = ARCHETYPES.length;

/** name -> archetype id, so a bestiary record can name its archetype. */
export const ARCHETYPE_BY_NAME = Object.freeze(
  ARCHETYPES.reduce((m, a) => { m[a.name] = a.id; return m; }, Object.create(null)));

/** True for archetypes that live in air rather than water. */
const IS_AIRBORNE = ARCHETYPES.map((a) => a.id === ARCHETYPE.FLYER);
/** True for archetypes that walk on the ground rather than swim. */
const IS_GROUNDED = ARCHETYPES.map(
  (a) => a.id === ARCHETYPE.LANDWALKER || a.id === ARCHETYPE.BURROWER);

// ===========================================================================
// Behaviours
// ===========================================================================

/**
 * The behaviour set. A ten-entry subset of DESIGN/06.1.3's twenty-three,
 * chosen because these are the ten that produce visibly distinct motion at the
 * densities this game actually runs: the rest (LURE, BURROW, JET_ESCAPE,
 * SURFACE_BREATHE...) are per-species flourishes on top of FLEE and
 * AMBUSH_WAIT and would add rows to the weight matrix that no archetype in the
 * roster enables. PATROL replaces DEFEND_TERRITORY, which is what
 * DEFEND_TERRITORY does when no intruder is present.
 */
export const BEHAVIOUR = {
  IDLE: 0, SCHOOL: 1, PATROL: 2, FORAGE: 3, INVESTIGATE: 4,
  STALK: 5, ATTACK: 6, FEED: 7, FLEE: 8, REST: 9,
};
export const BEHAVIOUR_COUNT = 10;
export const BEHAVIOUR_NAMES = Object.freeze([
  'idle', 'school', 'patrol', 'forage', 'investigate',
  'stalk', 'attack', 'feed', 'flee', 'rest',
]);

/**
 * Per-behaviour multipliers on the archetype weight row, from
 * DESIGN/06.1.7's second table. Flat Float32Array, row-major
 * [behaviour * STEER_COUNT + slot], because it is read nine times per agent
 * per tick and an array of arrays costs a pointer chase for each.
 *
 * INVESTIGATE'S FLEE STAYS AT 0.6, AND A 2026-08-02 CHANGE TO 0.15 WAS REVERTED
 * AFTER REVIEW. The argument for cutting it was that a curious animal could not
 * approach: `_resolveSteerTarget` makes the player its SEEK target, but on
 * ARCH_SHOALER that is SEEK 0.40 and ARRIVE 0.39 against FLEE 2.20 * 0.6 = 1.32.
 * That arithmetic describes the world before the flee steer went tangential.
 * With `_escapeDirection` in place FLEE only opposes SEEK by its RADIAL share,
 * 0.2425, so the radial balance point is fall = 0.40/(1.32*0.2425) = 1.25 > 1:
 * SEEK already wins at every range, at 0.6. MEASURED over a 30 s approach from
 * 8 m with INVESTIGATE pinned, 0.15 against 0.6: Coppersprat, Sandveil and
 * Sunplate trajectories BIT-IDENTICAL, and the one species that moved
 * (Azuregraze) closed from 0.45 m to 0.20 m, i.e. inside the camera. It bought
 * nothing and it cost something - this column also scales the escape from a
 * genuine PREDATOR, so 0.15 quietly weakened that 4x for any animal in
 * INVESTIGATE, which neither section 19 nor section 20 covers because both pin
 * BEHAVIOUR.IDLE.
 */
export const BEHAVIOUR_MUL = Float32Array.of(
  // SEEK FLEE WAND  ARR  SEP  ALI  COH OBST DEPTH
  0.0, 1.0, 1.6, 0.0, 1.0, 1.0, 1.0, 1.0, 1.2,   // IDLE
  0.3, 1.0, 0.6, 0.0, 1.3, 1.5, 1.4, 1.0, 1.0,   // SCHOOL
  0.9, 0.8, 0.5, 1.1, 0.9, 0.4, 0.4, 1.0, 1.0,   // PATROL
  1.2, 1.0, 0.9, 1.1, 1.0, 0.6, 0.6, 1.1, 1.0,   // FORAGE
  1.0, 0.6, 0.5, 1.3, 1.0, 0.5, 0.5, 1.1, 0.9,   // INVESTIGATE
  1.1, 0.3, 0.2, 1.5, 0.8, 0.6, 0.4, 1.2, 0.8,   // STALK
  1.8, 0.0, 0.0, 1.6, 0.5, 0.4, 0.2, 0.6, 0.4,   // ATTACK
  0.4, 0.5, 0.1, 1.6, 1.4, 0.0, 0.0, 1.4, 1.0,   // FEED
  0.0, 2.4, 0.4, 0.0, 1.6, 1.2, 0.8, 1.6, 0.5,   // FLEE
  0.0, 1.2, 0.15, 0.6, 0.8, 0.4, 0.6, 1.2, 1.5,  // REST
);

/** Cooldown applied on LEAVING a behaviour, seconds. DESIGN/06.1.3. */
const BEHAVIOUR_COOLDOWN = Float32Array.of(0, 0, 4, 3, 8, 10, 2.5, 12, 5, 30);

/** Utility bonus for staying in the current behaviour. DESIGN/06.1.3. */
const INERTIA_BONUS = 1.18;

/** Threat/fear thresholds, shared by every species. DESIGN/06.1.9. */
export const T_NOTICE = 0.20;
export const T_INVESTIGATE = 0.55;
export const T_COMMIT = 1.10;
export const T_FRENZY = 2.20;
export const F_FLINCH = 0.45;
export const F_PANIC = 1.30;

/**
 * Body-scaled part of the FLEE steer's PREDATOR panic radius, which is
 * `max(PANIC_FLOOR_M + PANIC_BODY_LENGTHS * length, fearFleeRadius(length))`.
 *
 * THIS IS NO LONGER THE RADIUS THE PLAYER OR THE VESSEL USE - see
 * playerPanicRadius, which is capped and does not take the fear floor. The
 * history below is about the shared radius they all used to share and is kept
 * because the reasoning still holds of the predator branch.
 *
 * THE FLOOR WENT 8 -> 2 m. It is NOT true that the 8 was undocumented, and an
 * earlier draft of this comment said so: DESIGN/06.2 step 8 specifies
 * `R_panic_t` = 14 m for the player and 26 m for the vessel, and `8 + 12 * L`
 * reproduces the 14 m EXACTLY at a 0.5 m reference animal, with 26/14 = 1.86
 * being where VESSEL_PANIC_MULT's 1.9 came from. What is wrong with it is that
 * DESIGN wrote a CONSTANT and the code made it scale with the animal, so the
 * constant survived as a floor that dwarfs every lagoon fish: for a 0.11 m
 * Coppersprat the whole 9.32 m radius is 85 body lengths and the 8 m floor
 * alone is 73 of them.
 *
 * That is what made the reported bug, because the term had no falloff either
 * and so ran at FULL strength out to that radius. MEASURED by a POOLED probe -
 * every animal within 20 m at 20 Hz over a 100 m real swim, 15,165 observations,
 * `tools/probes/rev-facing.js` - at 6-8 m the mean absolute relative bearing was
 * 157 deg, 88.1% of animals had their tail within 45 deg of the diver, the mean
 * radial velocity was +0.625 m/s AWAY, and not one observation of 212 animals
 * existed inside 5 m. Use that probe and not an orbit around one animal: an
 * orbit scores whichever handful of animals lies on the circle and its headline
 * moved from "12 locked" to "0 circled" across three runs of ONE build. It
 * reached the same conclusion here (concentration 0.972 at 6 m around an
 * identified Sunplate) but it did not establish it.
 *
 * A diver is ~1.8 m of body plus a 0.4 m collision radius, so ~2 m is the hull
 * no animal may swim into; that is the only part of the old floor with a
 * physical derivation of its own, and DESIGN/06.2's 14 m is superseded there
 * and here in the same change. Whole radii, old -> new, after the fear floor:
 * Glimmerkrill 8.25 -> 4.13, Coppersprat 9.32 -> 4.66, Sunplate 10.88 -> 5.44,
 * Azuregraze 14.24 -> 8.24 m.
 */
export const PANIC_FLOOR_M = 2.0;

/** Body lengths of panic radius above PANIC_FLOOR_M. Unchanged at 12 on
 *  purpose, so the 2026-07-31 change is isolated to the floor and the falloff. */
export const PANIC_BODY_LENGTHS = 12;

/**
 * The vessel's panic radius as a multiple of the animal's own: 7.4 m of hull
 * with lights on, not a diver.
 *
 * Unchanged at 1.9, but it multiplies `playerPanicRadius` now rather than the
 * predator radius, so the vessel stand-off is 4.2 m on a Coppersprat, 8.7 m on a
 * Sandveil Ray and 15.2 m at the cap - against a 7.4 m hull, which is the right
 * order for the first time. It used to be 9 m on the sprat and 33 m on the ray,
 * and 414 m on a Veilmouth.
 */
export const VESSEL_PANIC_MULT = 1.9;

/**
 * Radius at which an animal FEELS a predator, `4 + 6 * length` metres.
 *
 * It is used twice, and the second use is the point. _accumulate integrates
 * fear over it, which is what puts the animal into BEHAVIOUR.FLEE; the FLEE
 * steer then takes it as a FLOOR under its own panic radius, and sizes its
 * predator query with the result.
 *
 * THE TWO MUST NOT INVERT. Dropping PANIC_FLOOR_M to 2 m on its own put
 * `4 + 6L` above `2 + 12L` for every animal shorter than 1/3 m - MEASURED over
 * the whole species table, 11 of 40 species, against 0 of 40 before. Inside
 * that annulus the animal is in BEHAVIOUR.FLEE with a FLEE force of exactly
 * zero, while BEHAVIOUR_MUL's FLEE row multiplies SEEK and ARRIVE by 0.0:
 * nothing but WANDER 0.4 and separation would move it, i.e. a fish frightened
 * into paralysis. Worst cases were Glimmerkrill 2.25 against 4.13, Veilmote
 * 2.84 against 4.42, Coppersprat and Saltmoth 3.32 against 4.66. The floor also
 * keeps `_queryNeighbours` wide enough for the animal to SEE the predator it is
 * afraid of - at 2 + 12L a Coppersprat could not have found one beyond 3.32 m.
 */
export const FEAR_FLEE_BASE_M = 4.0;

/** Body lengths of fear radius above FEAR_FLEE_BASE_M. DESIGN/06.1.9. */
export const FEAR_FLEE_BODY_LENGTHS = 6;

/**
 * The fear/flee radius for one body length, metres. See FEAR_FLEE_BASE_M.
 * @param {number} bodyLength metres
 * @returns {number} metres
 */
export function fearFleeRadius(bodyLength) {
  return FEAR_FLEE_BASE_M + FEAR_FLEE_BODY_LENGTHS * bodyLength;
}

/**
 * THE DIVER AND THE SUB GET THEIR OWN PANIC RADIUS, AND IT DOES NOT RUN AWAY
 * WITH THE ANIMAL. `PANIC_FLOOR_M + PANIC_BODY_LENGTHS * L` stays as it is for
 * a genuine PREDATOR; these three constants replace it for the player and the
 * vessel only.
 *
 * WHY IT HAD TO BE SPLIT. `max(2 + 12L, 4 + 6L)` is 4.66 m on a 0.11 m
 * Coppersprat and the 2026-07-31 change was measured on exactly that. Evaluated
 * over the rest of the bestiary it is 17.6 m on a 1.30 m Sandveil Ray, 30.8 m on
 * a Ribbonwether, 57.2 m on a Gloomray, 218 m on an 18 m Veilmouth and 1154 m on
 * a Nethercoil - with the vessel at 1.9x all of those. DESIGN/06's own art
 * direction for the Veilmouth is that following one for eight minutes is an
 * intended optional experience; at 218 m of player panic radius it is
 * unreachable by construction. The slope is the defect: DESIGN/06.2 step 8 wrote
 * `R_panic_t` as a CONSTANT (14 m player, 26 m vessel) and the code made it
 * scale, and the 2026-07-31 fix cut the FLOOR (8 -> 2) while leaving the slope
 * at 12, so it helped small fish and did nothing at all for large ones.
 *
 * A diver's threat footprint does not grow with the animal looking at it. What
 * legitimately scales is the animal's own room to manoeuvre, which is a couple
 * of body lengths and not twelve, and the cap is what keeps a leviathan
 * approachable.
 *
 * `fearFleeRadius` is deliberately NOT a floor here. That max is load-bearing
 * for predators - see FEAR_FLEE_BASE_M, 11 of 40 species otherwise get an
 * annulus in which they are frightened into paralysis, and the same radius sizes
 * the predator query - but it is an argument about being able to escape the
 * thing that frightens you. The player frightens nothing: `fear` measures
 * 0.0000 mean and max over 21,727 tier-0 observations, and
 * the player branch does no neighbour query. Applying the fear floor here would
 * put the radius straight back to 11.8 m on a ray.
 */
export const PLAYER_PANIC_FLOOR_M = 2.0;

/** Body lengths of player panic radius above the floor. See PLAYER_PANIC_FLOOR_M. */
export const PLAYER_PANIC_BODY_LENGTHS = 2.0;

/**
 * Hard cap on the player's panic radius, metres. This is the constant that makes
 * a Gloomray and a Veilmouth approachable at all; without it the body-length
 * term alone reaches 38 m on an 18 m animal.
 */
export const PLAYER_PANIC_MAX_M = 8.0;

/**
 * The panic radius an animal keeps from the DIVER, metres. The vessel's is this
 * times VESSEL_PANIC_MULT. See PLAYER_PANIC_FLOOR_M for why this is not the
 * predator radius.
 * @param {number} bodyLength metres
 * @returns {number} metres
 */
export function playerPanicRadius(bodyLength) {
  return Math.min(PLAYER_PANIC_MAX_M,
    PLAYER_PANIC_FLOOR_M + PLAYER_PANIC_BODY_LENGTHS * bodyLength);
}

/**
 * How much of the escape direction is mixed BACK toward straight-away before
 * renormalising, the rest being tangential. 0 is a pure sideways slip, 1 is the
 * old radial shove. It governs the player, the VESSEL and the photophobe's
 * reflected seek - every threat that is not a predator.
 *
 * THE DELIVERED RADIAL COMPONENT IS 0.2425, NOT 0.2. The mix of two unit
 * vectors is not unit (`hypot(0.8, 0.2)` = 0.8246) and the renormalisation
 * divides it back up. 0.2 is the authored knob; 0.2425 is what arrives, and it
 * is what `test-creatures.mjs` section 20b pins.
 *
 * THIS IS THE FIX FOR "THEY ALWAYS FACE AWAY AND ROTATE SO WE CANNOT GO ROUND
 * THEM", AND THE RADIUS ALONE IS NOT. Heading in this engine is
 * `quat.lookRotation` on the velocity, and `_integrate` then re-projects the
 * velocity back onto that heading because fish do not slide sideways - so ANY
 * radial away-force is necessarily a turn-away, at any strength, and "displace
 * without steering the heading" is not expressible here. The only free variable
 * left is the DIRECTION.
 *
 * MEASURED on a Sandveil Ray, A/B/A with BEHAVIOUR_MUL's FLEE column zeroed for
 * the middle arm (`tools/probes/ray-approach-ab.js`), orbiting a full circle
 * inside the animal's own radius. Arm A, mean |relative bearing| and tail-on
 * fraction: BEFORE **144.6-163.8 deg / 0.833-1.000** over two runs, AFTER
 * **64-96 deg / 0.000-0.300** over four. 180 deg with tail-on 1.0 is the animal
 * keeping its tail to you through every sample; ~90 deg is the flank.
 * Run-to-run spread on one animal is 30 deg, so quote the range and not a
 * figure. DO NOT quote `relBearingConcentration`: a tangential escape makes the
 * animal circle the diver as the diver circles it, which pins the bearing at
 * 90 deg and maxes the concentration exactly as the bug maxed it at 180 - it
 * read 0.096 / 0.998 / 0.910 over three runs of this build.
 *
 * THERE IS NO STAND-OFF AGAINST A DETERMINED DIVER, BEFORE OR AFTER, and an
 * earlier draft of this comment claimed one. A diver swimming straight in at
 * 3 m/s reaches the probe's own stop distance on both builds; the "1.05 m with
 * the term on against 0.91 m with it off" that used to be quoted here was the
 * instrument's 1.0 m rail measuring itself. The radial share is 0.2425 of a
 * force that also falls off linearly, and that does not outrun a swimmer. What
 * the term does is set the BEARING, which is what was reported.
 *
 * A tangential target keeps the animal moving at the same speed but sends it
 * PAST rather than AWAY, so it presents its flank. That is also what a real reef
 * fish does, and a flank is the most readable view of an animal whose whole
 * silhouette is lateral.
 */
export const PLAYER_FLEE_RADIAL_FRAC = 0.2;

/**
 * Below this length a candidate tangent is treated as degenerate and the next
 * fallback is taken. `sin(theta)` for the angle between heading and radial, so
 * 1e-3 is 0.057 degrees - tight enough that the fallback is genuinely rare and
 * loose enough that dividing by it cannot blow up the direction.
 */
const TANGENT_MIN = 1e-3;

/** ATTACK sub-states, DESIGN/06.1.4. */
export const ATTACK_STATE = {
  APPROACH: 0, WINDUP: 1, LUNGE: 2, CONTACT: 3, RECOVER: 4, REPOSITION: 5,
};

/**
 * Attack timing by danger tier, taken from bestiary.js's DANGER_BY_TIER rather
 * than transcribed again here: two copies of the telegraph budget is two
 * numbers to keep in sync and one of them will eventually be wrong.
 *
 * THE WINDUP IS THE TELEGRAPH and it is the whole reason the combat is fair:
 * nothing in this game may damage the player without first spending T_WINDUP
 * visibly and audibly announcing it. Tier 0's zeroes are harmless because tier
 * 0 never enters ATTACK - its damage is forced to zero when the species table
 * is built.
 */
const T_WINDUP = Float32Array.from(DANGER_BY_TIER, (d) => d.windup);
const T_LUNGE = Float32Array.from(DANGER_BY_TIER, (d) => d.lunge);
const T_RECOVER = Float32Array.from(DANGER_BY_TIER, (d) => d.recover);
/** Extra windup when the attack comes from outside the player's front cone. */
const T_REAR_EXTRA = Float32Array.from(DANGER_BY_TIER, (d) => d.rearArcExtra);
/** Fractional extra damage an attacker takes during AT_RECOVER. */
export const RECOVER_DAMAGE_BONUS = Float32Array.from(DANGER_BY_TIER, (d) => d.recoverBonus);
/** Contact resolution window: one damage application, then straight to RECOVER. */
const T_CONTACT = 0.08;

/** FLEE sub-states, DESIGN/06.1.4. */
export const FLEE_STATE = { STARTLE: 0, BURST: 1, SUSTAIN: 2, SETTLE: 3 };

// ===========================================================================
// LOD and scheduling
// ===========================================================================

export const CREATURE_LOD = { FULL: 0, REDUCED: 1, STATISTICAL: 2 };

/** Promotion edges in metres from the camera. DESIGN/06.1.10. */
export const LOD_RANGE = Float32Array.of(60, 200);
/** Demotion uses edge * this, so an agent on the boundary does not thrash. */
const LOD_HYSTERESIS = 1.12;

/**
 * Sim steps between ticks for each LOD class. The sim runs at 60 Hz, so these
 * are 30 Hz, 10 Hz and 1 Hz respectively - exactly DESIGN/06.1.10's table.
 */
export const TICK_PERIOD = Int32Array.of(2, 6, 60);
/**
 * Perception and behaviour-reselection staggers, in SIM STEPS.
 *
 * BOTH PERIODS MUST BE MULTIPLES OF TICK_PERIOD, and that is not a style rule.
 * The test is nested inside the tick test - an agent only reaches it on the
 * steps where `i % TICK === tick % TICK` already held - so it fires once every
 * lcm(TICK, SELECT) steps, not every SELECT steps. The obvious 60/4 = 15 for
 * the FULL class is ODD, and against TICK_PERIOD[0] = 2 that lcm is 30:
 * MEASURED at 2.000 Hz against the 4 Hz this table claimed, i.e. exactly half,
 * and on the closest and most visible animals in the world. 14 is the nearest
 * multiple of 2 and gives 60/14 = 4.29 Hz, erring on the responsive side.
 *
 * Perception: 15 Hz for FULL, 2 Hz for REDUCED, never for STATISTICAL.
 * Selection: 4.29 Hz, 1 Hz, 0.25 Hz.
 * tools/test-creatures.mjs asserts both the divisibility and the rates.
 */
export const PERCEPTION_PERIOD = Int32Array.of(4, 30, 0);
export const SELECT_PERIOD = Int32Array.of(14, 60, 240);

/** Longest dt any agent integrates with, seconds. Guards a resumed tab. */
const MAX_AGENT_DT = 0.25;

// ===========================================================================
// Target encoding
// ===========================================================================

/** Target kinds. Matches DESIGN/06.1.2's targetId encoding. */
export const TARGET = { NONE: 0, CREATURE: 1, PLAYER: 2, VESSEL: 3, POINT: 4 };

// ===========================================================================
// Perception tuning
// ===========================================================================

/** Lateral-line reference distance, metres. DESIGN/06.1.8(b). */
const LATERAL_R0 = 6.0;
/** Lateral-line saturation for the x_vib input. */
const VIB_SAT = 3.0;
/** Incident lamp lux that saturates the x_lightOn input. */
const LUX_SAT = 400.0;

/**
 * Peak surface illuminance, lux. Ambient at depth is
 * `SURFACE_LUX * daylight * exp(-Kd_green * d)`; the green channel is the one
 * that survives longest in the water types the shallows use, and it is what a
 * photopic eye is most sensitive to. Compare DESIGN/06.0.2's band table: this
 * gives 8,250 lux at 45 m (band B1 quotes 900-20,000) and 3.6 lux at 180 m
 * (band B3 quotes 2.0-140), so the model is inside the design envelope without
 * needing a per-band lookup.
 */
const SURFACE_LUX = 110000;
const KD_PHOTOPIC = WATER_TYPES.OCEANIC_CLEAR.Kd[1];
/** Photopic beam extinction, 1/m, for the sight-line transmittance term. */
const SIGMA_PHOTOPIC = WATER_TYPES.OCEANIC_CLEAR.sigmaT[1];

/** Ambient scalar irradiance in lux at a depth, given 0..1 daylight. */
export function ambientLuxAt(depth, daylight) {
  // Moonlight floor: 0.15 lux at the surface on a clear night with both moons
  // up. Without it every deep-sea vision cone collapses to zero at night and
  // the abyss stops reacting to anything at all.
  const surface = SURFACE_LUX * daylight + 0.15;
  return surface * Math.exp(-KD_PHOTOPIC * Math.max(depth, 0));
}

// ===========================================================================
// Boids neighbourhood
// ===========================================================================

/**
 * Spatial hash cell size, metres.
 *
 * DESIGN/06.2.3 sets the cell at 1.15 * R_n so a 3x3x3 neighbourhood always
 * covers the search sphere, and quotes 6.0 m for the mid shoal whose R_n is
 * 5.0 m. 8.0 m is 1.15 * 7.0 m, and 7.0 m is the cohesion radius of
 * ARCH_GRAZER - the median across the six archetypes in this roster that have
 * a non-zero COHESION weight (SHOALER 5.0, REEFDART 3.0, GRAZER 7.0,
 * SCAVENGER 4.0, GLIDER 9.0, PACK 14.0). One hash serves every archetype
 * because there are only 260 agents in a 6 km world: mean occupancy is 3e-6
 * per cell, so an oversized cell costs nothing and an undersized one would
 * make ARCH_PACK scan 125 cells instead of 27.
 */
export const NEIGHBOUR_CELL_SIZE = 8.0;

/**
 * Hard cap on the neighbour search radius, metres.
 *
 * ARCH_FILTER_GIANT asks for a 55 m cohesion radius, which at an 8 m cell is
 * 15^3 = 3,375 cells scanned for a species that never has more than six
 * individuals alive. Clamping to 18 m bounds the worst case at 6^3 = 216 cells
 * and still covers ARCH_PACK's 14 m cohesion in full; a Veilmouth's schooling
 * with another Veilmouth 40 m away is not something the player can perceive.
 */
export const NEIGHBOUR_MAX_RADIUS = 18.0;

/** Neighbours accepted per agent per tick. DESIGN/06.2.4's cap. */
const MAX_NEIGHBOURS = 24;

/**
 * School proxy slots. DESIGN/06.2.1 allows 24 named schools; 64 is the next
 * power of two, so a school id maps to a slot with a mask instead of a modulo
 * and two schools colliding in a slot is a cosmetic error (they orbit one
 * shared centroid) rather than a correctness one.
 *
 * THE PROXY IS WHAT MAKES COHESION WORK AT ALL. A school seeded 13 m apart has
 * NO neighbour inside ARCH_SHOALER's 5 m cohesion radius, so pure Reynolds
 * cohesion has nothing to pull on and the school never forms - it only
 * MAINTAINS one that already exists. The centroid is the target the SCHOOL
 * behaviour's SEEK weight aims at, which is also exactly the "ALI/COH via
 * school proxy" that DESIGN/06.1.10 gives to LOD 1 and 2.
 */
const MAX_SCHOOLS = 64;
const SCHOOL_MASK = MAX_SCHOOLS - 1;

// ===========================================================================
// Species table
// ===========================================================================

/**
 * Flattened, cache-friendly view of the bestiary.
 *
 * entities/bestiary.js owns the 37 species records. This turns them into
 * parallel typed arrays indexed by species INDEX - a dense 0..36 slot, which is
 * also what the u16 `species` column of the agent pool stores - because the sim
 * reads eight species fields per agent per tick and an object property load per
 * field is the most expensive thing in the whole loop.
 *
 * FIELD MAPPING. Every value below is READ, never guessed: the record shape is
 * bestiary.js's, and the only transformations are unit conversions that are
 * called out where they happen. A record missing a field is a bug in the
 * bestiary, and `SPECIES_TABLE_PROBLEMS` names it rather than papering over it.
 *
 * `steering` rather than `archetype` selects the row: bestiary.js has eighteen
 * archetypes because four of them are habitat distinctions (landShore,
 * landFlyer, caveDweller, ventSpecialist) that share a locomotion model with
 * another, and `steering` is the field that names the ARCH_* row supplying the
 * blend weights. Reading `archetype` here would need a second mapping table
 * that says the same thing less directly.
 */

/** Every problem found while flattening the roster. Empty means a clean read. */
export const SPECIES_TABLE_PROBLEMS = [];

/** bestiary SWIM_MODE string -> ANIM_MODE id. */
const SWIM_MODE_TO_ANIM = Object.freeze({
  anguilliform: ANIM_MODE.ANGUILLIFORM,
  subCarangiform: ANIM_MODE.SUBCARANGIFORM,
  carangiform: ANIM_MODE.CARANGIFORM,
  thunniform: ANIM_MODE.THUNNIFORM,
  ostraciiform: ANIM_MODE.OSTRACIIFORM,
  rajiform: ANIM_MODE.RAJIFORM,
  jet: ANIM_MODE.JET,
  flap: ANIM_MODE.WING,
  walk: ANIM_MODE.LEG,
  // A `static` animal - Emberworm, Spinecrown - has no locomotion at all, but
  // it is not motionless: a tube worm's plume waves and an urchin's spines
  // sweep. OSTRACIIFORM puts all of the motion in the last 8% of the spine,
  // which is exactly the plume, and the zero body speed keeps the amplitude at
  // A0. That is the correct animation, not a fallback.
  static: ANIM_MODE.OSTRACIIFORM,
});

/**
 * Vessel hull damage is quoted by DESIGN/06.7.3 and by bestiary.js against a
 * 1,200 HP hull. This build's VESSEL.MAX_HULL is 100, so every value is scaled
 * by 100/1200. A Nethercoil's 900 becomes 75: still a bite that takes a healthy
 * hull to a quarter, which is the intended reading of "it is not a fight".
 */
const HULL_SCALE = 100 / 1200;

function buildSpeciesTable() {
  const list = SPECIES;
  const n = list.length;
  const t = {
    count: n,
    records: list,
    id: new Array(n),
    name: new Array(n),
    indexById: Object.create(null),
    archetype: new Uint8Array(n),
    animMode: new Uint8Array(n),
    tier: new Uint8Array(n),
    length: new Float32Array(n),
    mass: new Float32Array(n),
    health: new Float32Array(n),
    damage: new Float32Array(n),
    hullDamage: new Float32Array(n),
    speedBase: new Float32Array(n),
    speedBurst: new Float32Array(n),
    turnRate: new Float32Array(n),      // rad/s
    depthMin: new Float32Array(n),      // positive metres below sea level
    depthMax: new Float32Array(n),
    schoolMin: new Uint16Array(n),
    schoolMax: new Uint16Array(n),
    lightAffinity: new Float32Array(n),
    lightFlipRange: new Float32Array(n),  // 0 = the affinity does not flip
    tauThreat: new Float32Array(n),
    tauFear: new Float32Array(n),
    aggression: new Float32Array(n),
    electroRange: new Float32Array(n),
    visionRange: new Float32Array(n),
    visionHalfAngle: new Float32Array(n),
    vibThreshold: new Float32Array(n),
    /** rgb radiance premultiplied by intensity, plus the pulse rate in Hz. */
    biolum: new Float32Array(n * 4),
    /** Spine bone count from the mesh recipe, clamped to the GPU palette. */
    spineBones: new Uint8Array(n),
    /** Optical thickness for evalTranslucency, metres. */
    thickness: new Float32Array(n),
    /** Bit 0 predator, 1 carrion, 2 airborne, 3 benthic, 4 leviathan, 5 lure. */
    flags: new Uint8Array(n),
    /**
     * THE SWIM-WAVE PARAMETERS, PER SPECIES, defaulted from the archetype.
     *
     * Eleven floats per species in SWIM_ANIM order. Every one of them lives on
     * ARCHETYPES and every species but one takes the archetype's value
     * unchanged, so this array is a copy of the archetype table until a record
     * carries a `swimAnim` object - which exactly one does, and its reasoning
     * is on the LEV_SPLITMAW row in bestiary.js.
     *
     * IT IS AN ARRAY AND NOT AN OBJECT LOOKUP BECAUSE OF WHERE IT IS READ:
     * `_animate` runs once per live agent per fixed step. The two consumers
     * split by side - the beat RATE is accumulated on the CPU (f0/kf/fMin/fMax,
     * plus bendMax for the turn bend) and the AMPLITUDE is evaluated on the GPU
     * (A0/A1/U0/U1/lambdaB/Ap, uploaded by passes/creatures.js's
     * writeSpeciesAnim) - so both halves must read one resolved source or they
     * describe different animals.
     */
    swimAnim: new Float32Array(n * SWIM_ANIM_STRIDE),
  };

  const problem = (i, msg) =>
    SPECIES_TABLE_PROBLEMS.push(`${list[i] && list[i].id ? list[i].id : i}: ${msg}`);
  const num = (i, v, fallback, field) => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    problem(i, `${field} is ${v}; using ${fallback}`);
    return fallback;
  };

  for (let i = 0; i < n; i++) {
    const r = list[i];
    t.id[i] = r.id;
    t.name[i] = r.name;
    t.indexById[r.id] = i;

    const archId = ARCHETYPE_BY_NAME[r.steering];
    if (archId === undefined) {
      problem(i, `steering '${r.steering}' is not an ARCH_* row; using ARCH_SHOALER`);
      t.archetype[i] = ARCHETYPE.SHOALER;
    } else {
      t.archetype[i] = archId;
    }
    const a = ARCHETYPES[t.archetype[i]];

    const mode = SWIM_MODE_TO_ANIM[r.swimMode];
    if (mode === undefined) {
      problem(i, `swimMode '${r.swimMode}' is unknown; using the archetype's`);
      t.animMode[i] = a.mode;
    } else {
      t.animMode[i] = mode;
    }

    // SWIM WAVE. Default every field from the archetype, then let an optional
    // per-species `swimAnim` override name any subset of them. Ap is the one
    // that does not come from the archetype at all - DESIGN/06.3.3 derives the
    // dorsoventral amplitude fraction from the MODE (0.6 for the cetacean-tailed
    // thunniform, 0.25 for rays, 0 for everything else), which is what
    // writeSpeciesAnim used to hard-code inline.
    {
      const so = i * SWIM_ANIM_STRIDE;
      const am = t.animMode[i];
      t.swimAnim[so + SWIM_ANIM.f0] = a.f0;
      t.swimAnim[so + SWIM_ANIM.kf] = a.kf;
      t.swimAnim[so + SWIM_ANIM.fMin] = a.fMin;
      t.swimAnim[so + SWIM_ANIM.fMax] = a.fMax;
      t.swimAnim[so + SWIM_ANIM.A0] = a.A0;
      t.swimAnim[so + SWIM_ANIM.A1] = a.A1;
      t.swimAnim[so + SWIM_ANIM.U0] = a.U0;
      t.swimAnim[so + SWIM_ANIM.U1] = a.U1;
      t.swimAnim[so + SWIM_ANIM.lambdaB] = a.lambdaB;
      t.swimAnim[so + SWIM_ANIM.bendMax] = a.bendMax;
      t.swimAnim[so + SWIM_ANIM.Ap] = am === ANIM_MODE.THUNNIFORM ? 0.6
        : am === ANIM_MODE.RAJIFORM ? 0.25 : 0.0;
      if (r.swimAnim) {
        for (const k of Object.keys(r.swimAnim)) {
          if (!(k in SWIM_ANIM)) { problem(i, `swimAnim key '${k}' is not a wave field`); continue; }
          t.swimAnim[so + SWIM_ANIM[k]] = num(i, r.swimAnim[k], t.swimAnim[so + SWIM_ANIM[k]], `swimAnim.${k}`);
        }
      }
    }

    t.tier[i] = clamp(Math.round(num(i, r.dangerTier, 0, 'dangerTier')), 0, 5);
    t.length[i] = Math.max(0.02, num(i, r.length, 0.4, 'length'));
    t.mass[i] = Math.max(1e-5, num(i, r.mass, 1, 'mass'));
    t.health[i] = Math.max(1, num(i, r.health, 10, 'health'));

    // Tier 0 is BY CHARTER incapable of reducing player health, so its damage
    // is forced to zero here rather than trusted to be zero in the roster.
    // This is the cheapest of the three enforcement levels and it is free.
    const dmg = r.damage || {};
    t.damage[i] = t.tier[i] === 0 ? 0 : Math.max(0, num(i, dmg.player, 0, 'damage.player'));
    t.hullDamage[i] = Math.max(0, num(i, dmg.vessel, 0, 'damage.vessel')) * HULL_SCALE;

    t.speedBase[i] = Math.max(0.02, num(i, r.speed, 1, 'speed'));
    t.speedBurst[i] = Math.max(t.speedBase[i], num(i, r.burstSpeed, t.speedBase[i] * 3, 'burstSpeed'));
    // The datasheets quote turn rate in deg/s; everything here is rad/s.
    t.turnRate[i] = num(i, r.turnRate, 240, 'turnRate') * PI / 180;

    const dr = Array.isArray(r.depthRange) ? r.depthRange : [0, 120];
    t.depthMin[i] = Math.min(dr[0], dr[1]);
    t.depthMax[i] = Math.max(dr[0], dr[1]);

    const ss = Array.isArray(r.schoolSize) ? r.schoolSize : [1, 1];
    t.schoolMin[i] = clamp(Math.round(ss[0]), 1, 65535);
    t.schoolMax[i] = clamp(Math.round(Math.max(ss[1], ss[0])), 1, 65535);

    t.lightAffinity[i] = clamp(num(i, r.lightAffinity, 0, 'lightAffinity'), -1, 1);
    t.lightFlipRange[i] = Math.max(0, num(i, r.lightFlipRadius, 0, 'lightFlipRadius'));

    t.tauThreat[i] = Math.max(0.5, num(i, r.threatTau, 8, 'threatTau'));
    // The datasheets tune tauThreat only; DESIGN/06.4.0 says the fear tau
    // follows the archetype default. Fear must clear FASTER than threat or a
    // startled shoal never regroups, so it is a third of it with a 3 s floor.
    t.tauFear[i] = Math.max(3.0, t.tauThreat[i] * 0.34);

    // Aggression scales the threat stimulus weights. Derived from the tier,
    // which is what the tier MEANS: tier 0 never commits, tier 5 always does.
    t.aggression[i] = 0.25 + 0.35 * t.tier[i];
    t.electroRange[i] = Math.max(0, num(i, r.electroR, 0, 'electroR'));

    // Vision range in clear water at the 300 lux reference of DESIGN/06.1.8(a),
    // before the light and contrast gains. Scales with the square root of body
    // length (eye diameter does, and acuity follows it) and is extended for
    // predators, which have the forward-facing binocular arrangement the same
    // section gives a 1.6x range bonus to.
    const L = t.length[i];
    t.visionRange[i] = (6 + 14 * Math.sqrt(L)) * (t.tier[i] >= 2 ? 1.7 : 1.0);
    // Prey have laterally-placed eyes and a nearly panoramic monocular field;
    // predators have a narrow, long binocular cone. Half-angles in radians.
    t.visionHalfAngle[i] = t.tier[i] >= 2 ? 0.95 : 1.75;
    // Lateral-line detection threshold. A predator listening for a struggling
    // fish is an order of magnitude more sensitive than a grazer.
    t.vibThreshold[i] = t.tier[i] >= 2 ? 0.08 : 0.20;

    const bl = r.bioluminescence || null;
    const colour = bl && (bl.colour || bl.color);
    const inten = bl && typeof bl.intensity === 'number' ? bl.intensity : 0;
    if (Array.isArray(colour) && colour.length >= 3) {
      t.biolum[i * 4] = colour[0] * inten;
      t.biolum[i * 4 + 1] = colour[1] * inten;
      t.biolum[i * 4 + 2] = colour[2] * inten;
    }
    // hz 0 on a light-producing organ means a STEADY glow, not an absent one.
    t.biolum[i * 4 + 3] = bl && typeof bl.hz === 'number' ? bl.hz : 0;

    const recipe = r.meshRecipe || {};
    t.spineBones[i] = clamp(
      Math.round(typeof recipe.spineBones === 'number' ? recipe.spineBones : a.nSpine),
      2, RENDER.MAX_BONES_PER_CREATURE);

    // Optical thickness for the translucency term: the smaller of the body's
    // girth and depth, halved, because light crosses the thinnest axis. The
    // recipe quotes both as fractions of length.
    const girth = typeof recipe.girth === 'number' ? recipe.girth : 0.18;
    const bodyDepth = typeof recipe.depth === 'number' ? recipe.depth : 0.24;
    t.thickness[i] = clamp(L * Math.min(girth, bodyDepth) * 0.5, 0.002, 1.5);

    let flags = 0;
    // A predator is anything that hunts: tier >= 2 by definition, plus the
    // tier-0 and tier-1 animals whose diet names another animal.
    const diet = Array.isArray(r.diet) ? r.diet.join(' ').toLowerCase() : '';
    const eatsMeat = /krill|fish|sprat|quill|wisp|squid|worm|claw|louse|juv|carrion|prey/.test(diet);
    if (t.tier[i] >= 2 || eatsMeat) flags |= 1;
    if (/carrion|detritus|corpse/.test(diet)) flags |= 2;
    if (r.habitat === 'air') flags |= 4;
    if (r.habitat === 'benthic' || r.habitat === 'crevice' || r.habitat === 'vent' ||
        r.habitat === 'brineEdge') flags |= 8;
    if (r.steering === 'ARCH_LEVIATHAN') flags |= 16;
    if (bl && bl.isLure === true) flags |= 32;
    t.flags[i] = flags;
  }

  if (SPECIES_TABLE_PROBLEMS.length > 0) {
    console.error(`[creatures] bestiary flattening found ${SPECIES_TABLE_PROBLEMS.length} ` +
      `problem(s):\n  ${SPECIES_TABLE_PROBLEMS.join('\n  ')}`);
  }
  return t;
}

/** The flattened bestiary. Built once at module load. */
export const SPECIES_TABLE = buildSpeciesTable();

/** Species flag bits, for readability at the call sites. */
export const SPECIES_FLAG = {
  PREDATOR: 1, CARRION: 2, AIRBORNE: 4, BENTHIC: 8, LEVIATHAN: 16, LURE: 32,
};

/** Index of a species string id, or -1. */
export function speciesIndexOf(id) {
  const i = SPECIES_TABLE.indexById[id];
  return i === undefined ? -1 : i;
}

// ===========================================================================
// Module scratch
// ===========================================================================
//
// Every vector the sim needs, allocated once. Nothing in simulate() may
// allocate; tools/test-creatures.mjs asserts that with process.memoryUsage().

const _pos = vec3.create();
const _fwd = vec3.create();
const _dir = vec3.create();
const _tmp = vec3.create();
const _target = vec3.create();
const _normal = vec3.create();
const _sep = vec3.create();
const _ali = vec3.create();
const _coh = vec3.create();
const _quat = quat.create();
const _neighbours = new Int32Array(MAX_NEIGHBOURS * 4);
const _blend = new Float32Array(STEER_COUNT * 3);
const _weights = new Float32Array(STEER_COUNT);
const _scores = new Float32Array(BEHAVIOUR_COUNT);

/** Whisker directions, as (yaw, pitch) offsets from forward. DESIGN/06.1.5. */
const WHISKER_YAW = Float32Array.of(0, 0.436, -0.436, 0, 0);
const WHISKER_PITCH = Float32Array.of(0, 0, 0, 0.384, -0.384);
const WHISKER_GAIN = Float32Array.of(1.8, 1.0, 1.0, 1.0, 1.0);

/** Depth-band spring, DESIGN/06.1.5 item 9. */
const K_DEPTH = 0.9;
const C_DEPTH = 1.4;
const DEPTH_HARD_MARGIN = 12.0;

/** Terrain clearance below which the hard push-out fires, in body lengths. */
const CLEARANCE_BODY_LENGTHS = 0.85;
/** Minimum absolute clearance, metres - a 2 cm krill still needs 0.4 m. */
const CLEARANCE_MIN = 0.4;

/** World containment. Absolute limits every agent is clamped inside. */
const Y_CEILING = 260;
const Y_FLOOR = -(WORLD.MAX_DEPTH + 60);
const XZ_LIMIT = WORLD.HALF_EXTENT - 8;
/** Radius at which the soft turn-back force begins. */
const BOUNDARY_SOFT = WORLD.SOFT_BOUNDARY;

// ===========================================================================
// CreatureSim
// ===========================================================================

/**
 * The population. One instance owns every living creature in the world.
 *
 * @example
 *   const sim = new CreatureSim(collision, { seed });
 *   const h = sim.spawn(speciesIndexOf('CRT_COPPERSPRAT'), 0, -6, 240);
 *   sim.simulate(FIXED_DT, { playerPos, vessel, camera, daylight });
 */
export class CreatureSim {
  /**
   * @param {import('../world/collision.js').CollisionWorld} collision
   * @param {object} [opts] {seed, capacity}
   */
  constructor(collision, { seed = WORLD.DEFAULT_SEED, capacity = RENDER.MAX_CREATURES } = {}) {
    this.collision = collision;
    this.capacity = capacity;
    this.count = 0;
    this.seed = seed >>> 0;
    this.rng = makeRng(this.seed ^ 0x00c0ffee);

    const n = capacity;

    // ---- kinematics ------------------------------------------------------
    this.posX = new Float32Array(n);
    this.posY = new Float32Array(n);
    this.posZ = new Float32Array(n);
    this.velX = new Float32Array(n);
    this.velY = new Float32Array(n);
    this.velZ = new Float32Array(n);
    /** Orientation quaternion, xyzw, four per agent. */
    this.orient = new Float32Array(n * 4);
    /** Smoothed steering output, for DESIGN/06.1.5 item 10's path smoothing. */
    this.steerX = new Float32Array(n);
    this.steerY = new Float32Array(n);
    this.steerZ = new Float32Array(n);
    /** Signed yaw rate, rad/s, drives the body bend and the bank. */
    this.yawRate = new Float32Array(n);

    // ---- identity --------------------------------------------------------
    this.species = new Uint16Array(n);
    this.archetype = new Uint8Array(n);
    this.tier = new Uint8Array(n);
    this.generation = new Uint16Array(n);
    this.alive = new Uint8Array(n);
    /** Per-individual size jitter, 0.82..1.18. */
    this.scale = new Float32Array(n);
    /** Body length in metres including the size jitter. */
    this.bodyLength = new Float32Array(n);

    // ---- state -----------------------------------------------------------
    this.behaviour = new Uint8Array(n);
    this.state = new Uint8Array(n);
    this.stateT = new Float32Array(n);
    this.hp = new Float32Array(n);
    this.hpMax = new Float32Array(n);
    this.threat = new Float32Array(n);
    this.fear = new Float32Array(n);
    this.energy = new Float32Array(n);
    this.flags = new Uint16Array(n);
    this.cooldown = new Float32Array(n * BEHAVIOUR_COUNT);

    // ---- targeting -------------------------------------------------------
    this.targetKind = new Uint8Array(n);
    this.targetId = new Int32Array(n);
    this.targetX = new Float32Array(n);
    this.targetY = new Float32Array(n);
    this.targetZ = new Float32Array(n);
    this.homeX = new Float32Array(n);
    this.homeY = new Float32Array(n);
    this.homeZ = new Float32Array(n);
    this.territoryR = new Float32Array(n);
    this.schoolId = new Int16Array(n);

    // ---- wander / animation ---------------------------------------------
    this.wanderYaw = new Float32Array(n);
    this.wanderPitch = new Float32Array(n);
    this.phase = new Float32Array(n);
    this.bendTurn = new Float32Array(n);
    this.bank = new Float32Array(n);
    this.jawOpen = new Float32Array(n);
    this.startleT = new Float32Array(n);

    // ---- perception cache ------------------------------------------------
    this.distToPlayer = new Float32Array(n).fill(Infinity);
    this.distToVessel = new Float32Array(n).fill(Infinity);
    /** Distance to the nearest valid prey creature, and its slot (-1 = none). */
    this.distToPrey = new Float32Array(n).fill(Infinity);
    this.preySlot = new Int32Array(n).fill(-1);
    this.lightLux = new Float32Array(n);
    this.vib = new Float32Array(n);
    this.sawPlayer = new Uint8Array(n);

    // ---- school proxies --------------------------------------------------
    this.schoolCount = new Int32Array(MAX_SCHOOLS);
    this.schoolX = new Float32Array(MAX_SCHOOLS);
    this.schoolY = new Float32Array(MAX_SCHOOLS);
    this.schoolZ = new Float32Array(MAX_SCHOOLS);
    this.schoolVX = new Float32Array(MAX_SCHOOLS);
    this.schoolVY = new Float32Array(MAX_SCHOOLS);
    this.schoolVZ = new Float32Array(MAX_SCHOOLS);

    // ---- scheduling ------------------------------------------------------
    this.lod = new Uint8Array(n);
    this.lastTick = new Float32Array(n);
    this.age = new Float32Array(n);
    /** Seconds since this agent was last inside the camera frustum. */
    this.unseenT = new Float32Array(n);
    this.distToCamera = new Float32Array(n).fill(Infinity);

    /** Free-slot stack. Slots are handed out LIFO so hot slots stay hot. */
    this._free = new Int32Array(n);
    for (let i = 0; i < n; i++) this._free[i] = n - 1 - i;
    this._freeCount = n;

    /** Dense list of live slots, rebuilt whenever the population changes. */
    this._live = new Int32Array(n);
    this._liveCount = -1;
    this._liveView = null;
    this._liveDirty = true;

    this.hash = new SpatialHash(n, NEIGHBOUR_CELL_SIZE, 2048);

    this._stagger = [new Staggered(TICK_PERIOD[0]), new Staggered(TICK_PERIOD[1]),
      new Staggered(TICK_PERIOD[2])];
    this._tick = 0;
    this.time = 0;

    /** Live per-tick statistics, read by the HUD and the tests. */
    this.stats = {
      alive: 0, ticked: 0, lod0: 0, lod1: 0, lod2: 0,
      spawned: 0, despawned: 0, killed: 0,
      attacks: 0, predations: 0, vesselBites: 0,
      neighbourQueries: 0, neighboursFound: 0,
      msLast: 0, msPeak: 0,
    };

    /**
     * Safe Charter volume, installed by the spawner via setCharter().
     * radius 0 disables the barrier entirely, which is the state an offline
     * test that only exercises steering wants.
     */
    this._charter = {
      centerX: 0, centerZ: 0, radius: 0, margin: 40,
      deepRadius: 0, deepFloor: -140,
    };

    /** Per-frame world context, refreshed by simulate(). */
    this._ctx = {
      playerPos: null, playerVel: null, playerAlive: false, playerNoise: 0,
      vessel: null, vesselPos: null, vesselNoise: 0, vesselLightLux: 0,
      vesselLightRange: 0, cameraPos: null, cameraFwd: null, camera: null,
      playerFwd: null, daylight: 1, playerInVessel: false,
    };
  }

  /**
   * Install the Safe Charter volume. ENFORCEMENT LEVEL 2: any tier >= 1 agent
   * whose predicted position enters the volume gets a repulsion force of
   * 2.5 * aMax pushing it radially out, and has ATTACK and STALK gated off.
   *
   * The barrier is a FORCE, not a wall, and it acts from `margin` metres
   * outside the boundary, so a Frondmaw drifting toward the lagoon visibly
   * turns and leaves instead of sliding along an invisible surface. That is
   * the whole difference between an invariant the player never notices and one
   * they can see.
   *
   * @param {{centerX:number,centerZ:number,radius:number,margin?:number,
   *          deepRadius?:number,deepFloor?:number}} charter
   */
  setCharter(charter) {
    const c = this._charter;
    c.centerX = charter.centerX || 0;
    c.centerZ = charter.centerZ || 0;
    c.radius = Math.max(0, charter.radius || 0);
    c.margin = charter.margin !== undefined ? charter.margin : 40;
    c.deepRadius = charter.deepRadius || 0;
    c.deepFloor = charter.deepFloor !== undefined ? charter.deepFloor : -140;
    return this;
  }

  // -------------------------------------------------------------------------
  // Handles
  // -------------------------------------------------------------------------

  /**
   * Pack a slot into a stable handle. The generation counter is what makes a
   * stale handle detectable: slot 7 reused four times is four different
   * animals, and a predator holding `targetId` across those reuses must not
   * silently start hunting the replacement.
   * @param {number} slot
   * @returns {number} handle, or -1 if the slot is empty
   */
  handleOf(slot) {
    if (slot < 0 || slot >= this.capacity || !this.alive[slot]) return -1;
    return ((this.generation[slot] & 0xffff) << 16) | (slot & 0xffff);
  }

  /** Slot for a handle, or -1 if the handle is stale. */
  slotOf(handle) {
    if (handle < 0) return -1;
    const slot = handle & 0xffff;
    if (slot >= this.capacity || !this.alive[slot]) return -1;
    if (this.generation[slot] !== ((handle >>> 16) & 0xffff)) return -1;
    return slot;
  }

  /** True if a handle still refers to the animal it was minted for. */
  isAlive(handle) { return this.slotOf(handle) >= 0; }

  /**
   * Dense array of live slots. Valid until the next spawn or despawn.
   *
   * The returned view is CACHED, not minted per call. `subarray` allocates, and
   * this is called two to four times per sim step: at 60 Hz that is 240 short
   * lived typed-array views a second for a value that changes only when the
   * population does, and it is exactly the kind of leak that turns a
   * "zero allocation" claim into a young-generation collection every few
   * seconds.
   */
  liveSlots() {
    if (this._liveDirty) {
      let k = 0;
      for (let i = 0; i < this.capacity; i++) if (this.alive[i]) this._live[k++] = i;
      if (k !== this._liveCount || this._liveView === null) {
        this._liveCount = k;
        this._liveView = this._live.subarray(0, k);
      }
      this._liveDirty = false;
    }
    return this._liveView;
  }

  // -------------------------------------------------------------------------
  // Spawn / despawn
  // -------------------------------------------------------------------------

  /**
   * Create one creature.
   *
   * @param {number} speciesIndex dense index into SPECIES_TABLE
   * @param {number} x world metres
   * @param {number} y world metres, +Y up
   * @param {number} z world metres
   * @param {object} [opts]
   *   schoolId    -1 for solitary; members of a school share it
   *   heading     compass heading in radians, random if omitted
   *   homeX/Y/Z   territory anchor, defaults to the spawn point
   *   territoryR  territory radius in metres
   *   scaleJitter override the 0.82..1.18 size jitter
   * @returns {number} handle, or -1 if the pool is full
   */
  spawn(speciesIndex, x, y, z, opts = {}) {
    if (this._freeCount === 0) return -1;
    if (speciesIndex < 0 || speciesIndex >= SPECIES_TABLE.count) return -1;

    const i = this._free[--this._freeCount];
    const st = SPECIES_TABLE;
    const arch = st.archetype[speciesIndex];
    const a = ARCHETYPES[arch];

    this.alive[i] = 1;
    this.generation[i] = (this.generation[i] + 1) & 0xffff;
    this.count++;
    this._liveDirty = true;

    this.species[i] = speciesIndex;
    this.archetype[i] = arch;
    this.tier[i] = st.tier[speciesIndex];

    const jitter = opts.scaleJitter !== undefined
      ? opts.scaleJitter : 0.82 + this.rng() * 0.36;
    this.scale[i] = jitter;
    this.bodyLength[i] = st.length[speciesIndex] * jitter;

    this.posX[i] = x; this.posY[i] = y; this.posZ[i] = z;

    const heading = opts.heading !== undefined ? opts.heading : this.rng() * TAU;
    const base = st.speedBase[speciesIndex];
    // dirFromHeading's convention: heading 0 is north (-Z), clockwise positive.
    const sx = Math.sin(heading), sz = -Math.cos(heading);
    this.velX[i] = sx * base; this.velY[i] = 0; this.velZ[i] = sz * base;

    quat.lookRotation(_quat, vec3.set(_dir, sx, 0, sz));
    this.orient[i * 4] = _quat[0]; this.orient[i * 4 + 1] = _quat[1];
    this.orient[i * 4 + 2] = _quat[2]; this.orient[i * 4 + 3] = _quat[3];

    this.steerX[i] = 0; this.steerY[i] = 0; this.steerZ[i] = 0;
    this.yawRate[i] = 0;

    this.behaviour[i] = opts.schoolId >= 0 && a.w[STEER.COHESION] > 0
      ? BEHAVIOUR.SCHOOL : BEHAVIOUR.IDLE;
    this.state[i] = 0;
    this.stateT[i] = 0;
    this.hpMax[i] = st.health[speciesIndex];
    this.hp[i] = this.hpMax[i];
    this.threat[i] = 0;
    this.fear[i] = 0;
    // Not full: an animal that starts sated never forages, and a whole cell
    // spawning at energy 1 means nothing moves for the first two minutes.
    this.energy[i] = 0.45 + this.rng() * 0.4;
    this.flags[i] = 0;
    this.cooldown.fill(0, i * BEHAVIOUR_COUNT, (i + 1) * BEHAVIOUR_COUNT);

    this.targetKind[i] = TARGET.NONE;
    this.targetId[i] = -1;
    this.targetX[i] = x; this.targetY[i] = y; this.targetZ[i] = z;
    this.homeX[i] = opts.homeX !== undefined ? opts.homeX : x;
    this.homeY[i] = opts.homeY !== undefined ? opts.homeY : y;
    this.homeZ[i] = opts.homeZ !== undefined ? opts.homeZ : z;
    this.territoryR[i] = opts.territoryR !== undefined
      ? opts.territoryR : 18 + 26 * this.bodyLength[i];
    this.schoolId[i] = opts.schoolId !== undefined ? opts.schoolId : -1;

    this.wanderYaw[i] = this.rng() * TAU;
    this.wanderPitch[i] = 0;
    // Phase from the slot hash, not from a counter: a school spawned in one
    // loop must not swim in lockstep. DESIGN/06.1.10's anti-pop rule.
    this.phase[i] = (hashU32(this.seed ^ (i * 2654435761)) / 4294967296) * TAU;
    this.bendTurn[i] = 0;
    this.bank[i] = 0;
    this.jawOpen[i] = 0.04;
    this.startleT[i] = 0;

    this.distToPlayer[i] = Infinity;
    this.distToVessel[i] = Infinity;
    this.distToPrey[i] = Infinity;
    this.preySlot[i] = -1;
    this.distToCamera[i] = Infinity;
    this.lightLux[i] = 0;
    this.vib[i] = 0;
    this.sawPlayer[i] = 0;

    this.lod[i] = CREATURE_LOD.STATISTICAL;
    this.lastTick[i] = this.time;
    this.age[i] = 0;
    this.unseenT[i] = 0;

    this.hash.insert(i, x, y, z);
    this.stats.spawned++;

    events.emit(EVENTS.CREATURE_SPAWN, {
      id: this.handleOf(i), species: st.id[speciesIndex], position: this._pointOf(i),
    });
    return this.handleOf(i);
  }

  /**
   * Remove a creature.
   * @param {number} handle
   * @param {string} [reason] 'despawn' | 'killed' | 'eaten' | 'cull'
   */
  despawn(handle, reason = 'despawn') {
    const i = this.slotOf(handle);
    if (i < 0) return false;
    // The payload carries the POSITION and the species INDEX as well as the id,
    // because the spawner's depletion counter needs both and by the time a
    // listener runs the slot is gone. Emitting before the removal is what makes
    // that possible.
    events.emit(EVENTS.CREATURE_DESPAWN, {
      id: handle, species: SPECIES_TABLE.id[this.species[i]],
      speciesIndex: this.species[i], position: this._pointOf(i), reason,
    });
    this.alive[i] = 0;
    this.hash.remove(i);
    this._free[this._freeCount++] = i;
    this.count--;
    this._liveDirty = true;
    this.stats.despawned++;
    return true;
  }

  /** Remove every creature. Used by the spawner on a teleport or a load. */
  clear() {
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i]) this.despawn(this.handleOf(i), 'cull');
    }
  }

  /** Reusable vec3 of a slot's position. Do not retain the returned array. */
  _pointOf(i) {
    return vec3.set(_pos, this.posX[i], this.posY[i], this.posZ[i]);
  }

  // -------------------------------------------------------------------------
  // Damage
  // -------------------------------------------------------------------------

  /**
   * Apply damage to a creature.
   *
   * @param {number} handle
   * @param {number} amount HP
   * @param {string} source 'player' | 'creature' | 'environment'
   * @returns {boolean} true if this killed it
   */
  damage(handle, amount, source = 'player') {
    const i = this.slotOf(handle);
    if (i < 0 || !(amount > 0)) return false;
    // THE COUNTER-ATTACK WINDOW. An animal in AT_RECOVER has committed and
    // missed, and it takes extra damage for exactly as long as that lasts.
    // This is what makes every fight a rhythm rather than a race: the tell
    // tells you when to move, and the recovery tells you when to hit back.
    if (this.behaviour[i] === BEHAVIOUR.ATTACK && this.state[i] === ATTACK_STATE.RECOVER) {
      amount *= 1 + RECOVER_DAMAGE_BONUS[this.tier[i]];
    }
    this.hp[i] -= amount;
    const frac = amount / Math.max(1e-3, this.hpMax[i]);
    // DESIGN/06.1.9: damage is an impulse into BOTH accumulators. A wounded
    // animal is simultaneously angrier and more frightened, and which one wins
    // is what makes a cornered Glassclaw fight and a Coppersprat run.
    if (source === 'player') this.threat[i] = Math.min(3, this.threat[i] + 2.4 * frac);
    this.fear[i] = Math.min(3, this.fear[i] + 3.0 * frac);
    if (this.hp[i] < 0.6 * this.hpMax[i]) this.flags[i] |= 1;   // wounded

    if (this.hp[i] <= 0) {
      this.stats.killed++;
      // An ally dying is a 0.70 threat impulse to everyone of the same species
      // within 40 m. This is what turns a single shot into a reef that has
      // noticed you.
      this._alertKin(i, 40, 0.70);
      this.despawn(handle, source === 'creature' ? 'eaten' : 'killed');
      return true;
    }
    // Forced re-evaluation on damage. DESIGN/06.1.3.
    this.cooldown.fill(0, i * BEHAVIOUR_COUNT, (i + 1) * BEHAVIOUR_COUNT);
    this._select(i);
    return false;
  }

  /** Threat impulse to every same-species agent within `radius` of slot `i`. */
  _alertKin(i, radius, impulse) {
    const n = this.hash.queryRadius(this.posX[i], this.posY[i], this.posZ[i],
      Math.min(radius, 64), _neighbours);
    const sp = this.species[i];
    for (let k = 0; k < n; k++) {
      const j = _neighbours[k];
      if (j === i || !this.alive[j] || this.species[j] !== sp) continue;
      this.threat[j] = Math.min(3, this.threat[j] + impulse);
      this.fear[j] = Math.min(3, this.fear[j] + impulse * 0.6);
    }
  }

  /**
   * A sonar ping: the loudest event in the game. +0.90 threat to every
   * creature within `range`, and a one-frame flash-expansion impulse.
   * DESIGN/06.1.8(b) and 06.2.2's flash expansion.
   * @param {ArrayLike<number>} origin
   * @param {number} range metres
   */
  sonarPing(origin, range = 400) {
    const live = this.liveSlots();
    for (let k = 0; k < live.length; k++) {
      const i = live[k];
      const dx = this.posX[i] - origin[0];
      const dy = this.posY[i] - origin[1];
      const dz = this.posZ[i] - origin[2];
      const d = len3(dx, dy, dz);
      if (d > range) continue;
      this.threat[i] = Math.min(3, this.threat[i] + 0.90);
      this.fear[i] = Math.min(3, this.fear[i] + 0.40);
      if (d < 12 && d > 1e-3) {
        const vMax = SPECIES_TABLE.speedBurst[this.species[i]] * 0.8;
        const s = vMax / d;
        this.velX[i] += dx * s; this.velY[i] += dy * s; this.velZ[i] += dz * s;
      }
      this.cooldown.fill(0, i * BEHAVIOUR_COUNT, (i + 1) * BEHAVIOUR_COUNT);
    }
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  /**
   * Advance the population by one fixed step.
   *
   * @param {number} dt seconds, normally FIXED_DT
   * @param {object} world
   *   playerPos      ArrayLike<number> absolute
   *   playerVel      ArrayLike<number>
   *   playerAlive    boolean
   *   playerInVessel boolean
   *   playerNoise    lateral-line A_src for the player, 0.05..2.2
   *   vessel         the Vessel, for lights and hull damage; may be null
   *   camera         the Camera, for LOD and frustum tests; may be null
   *   daylight       0..1
   */
  simulate(dt, world) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.time += dt;
    this._tick++;
    this._stagger[0].tick();
    this._stagger[1].tick();
    this._stagger[2].tick();

    this._readWorld(world);
    const live = this.liveSlots();
    this._updateSchoolProxies(live);
    const stats = this.stats;
    stats.alive = live.length;
    stats.ticked = 0;
    stats.lod0 = 0; stats.lod1 = 0; stats.lod2 = 0;
    stats.neighbourQueries = 0;
    stats.neighboursFound = 0;

    const camPos = this._ctx.cameraPos;
    const camera = this._ctx.camera;

    for (let k = 0; k < live.length; k++) {
      const i = live[k];
      // A predation earlier in THIS loop can have eaten an agent the snapshot
      // still lists. Skipping it is cheaper and safer than rebuilding the list.
      if (!this.alive[i]) continue;
      this.age[i] += dt;

      // ---- LOD classification, every step. 260 distance tests is nothing
      // and a stale class is what makes a promoted school pop.
      let d = Infinity;
      if (camPos) {
        const dx = this.posX[i] - camPos[0];
        const dy = this.posY[i] - camPos[1];
        const dz = this.posZ[i] - camPos[2];
        d = len3(dx, dy, dz);
      }
      this.distToCamera[i] = d;
      const lod = this.lod[i];
      let next = lod;
      if (d <= LOD_RANGE[0]) next = CREATURE_LOD.FULL;
      else if (d <= LOD_RANGE[1]) next = CREATURE_LOD.REDUCED;
      else next = CREATURE_LOD.STATISTICAL;
      // Hysteresis: only DEMOTE past edge * 1.12. Promotion uses the edge.
      if (next > lod) {
        const edge = LOD_RANGE[Math.min(lod, 1)] * LOD_HYSTERESIS;
        if (d <= edge) next = lod;
      }
      // A leviathan inside 900 m never drops to statistical: that is what lets
      // it be heard long before it is seen. DESIGN/06.1.10's exception.
      if ((SPECIES_TABLE.flags[this.species[i]] & SPECIES_FLAG.LEVIATHAN) &&
          d < 900 && next === CREATURE_LOD.STATISTICAL) {
        next = CREATURE_LOD.REDUCED;
      }
      this.lod[i] = next;
      if (next === 0) stats.lod0++; else if (next === 1) stats.lod1++; else stats.lod2++;

      // ---- visibility bookkeeping, for the despawn rule ------------------
      // RANGE-LIMITED, not a bare frustum test. The projection has an infinite
      // far plane, so isSphereVisible alone answers "is it inside the four side
      // planes", which a fish half a kilometre away satisfies while being drawn
      // by nothing and seen by no one. That kept unseenT pinned at 0 for the
      // whole background population whenever the camera happened to face it, and
      // since every despawn path is gated on unseenT, it switched off despawning
      // and budget reclaim together - deterministically, for about a quarter of
      // all headings. Measured at the lagoon eye facing the primed beach cluster:
      // 189 of 189 agents "visible", 0 reclaimable, the near-field director
      // starved to 3 of a target of 150, and zero creatures drawn.
      const seenRange = Math.max(CREATURE_DRAW.DISTANCE_MIN,
        this.bodyLength[i] * CREATURE_DRAW.DISTANCE_PER_LENGTH);
      if (d <= seenRange && camera && camera.isSphereVisible &&
          camera.isSphereVisible(this._pointOf(i), this.bodyLength[i] * 0.6)) {
        this.unseenT[i] = 0;
      } else {
        this.unseenT[i] += dt;
      }

      // ---- is this agent's bucket due? ----------------------------------
      if (!this._stagger[next].due(i)) continue;

      let adt = this.time - this.lastTick[i];
      if (!(adt > 0)) adt = dt;
      if (adt > MAX_AGENT_DT) adt = MAX_AGENT_DT;
      this.lastTick[i] = this.time;

      if (PERCEPTION_PERIOD[next] > 0 && (this._tick % PERCEPTION_PERIOD[next]) === (i % PERCEPTION_PERIOD[next])) {
        this._perceive(i, adt);
      }
      this._accumulate(i, adt);
      if ((this._tick % SELECT_PERIOD[next]) === (i % SELECT_PERIOD[next])) {
        this._select(i);
      }
      this._advanceFsm(i, adt);
      this._steer(i, adt, next);
      this._locomote(i, adt, next);
      this._animate(i, adt);
      stats.ticked++;
    }

    // Interactions run once per step over the whole population rather than
    // per agent, because they are pairwise and doing them inside the agent
    // loop resolves each pair twice.
    this._resolveInteractions(dt);

    const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    stats.msLast = ms;
    if (ms > stats.msPeak) stats.msPeak = ms;
  }

  /**
   * Recompute every school's centroid and mean velocity.
   *
   * One pass over the live list per sim step - 260 adds and 64 divides, which
   * is under a microsecond and is what lets cohesion work at any separation and
   * lets a REDUCED-LOD agent align with its school without a neighbour query.
   */
  _updateSchoolProxies(live) {
    this.schoolCount.fill(0);
    this.schoolX.fill(0); this.schoolY.fill(0); this.schoolZ.fill(0);
    this.schoolVX.fill(0); this.schoolVY.fill(0); this.schoolVZ.fill(0);
    for (let k = 0; k < live.length; k++) {
      const i = live[k];
      const s = this.schoolId[i];
      if (s < 0) continue;
      const b = s & SCHOOL_MASK;
      this.schoolCount[b]++;
      this.schoolX[b] += this.posX[i]; this.schoolY[b] += this.posY[i];
      this.schoolZ[b] += this.posZ[i];
      this.schoolVX[b] += this.velX[i]; this.schoolVY[b] += this.velY[i];
      this.schoolVZ[b] += this.velZ[i];
    }
    for (let b = 0; b < MAX_SCHOOLS; b++) {
      const c = this.schoolCount[b];
      if (c === 0) continue;
      const inv = 1 / c;
      this.schoolX[b] *= inv; this.schoolY[b] *= inv; this.schoolZ[b] *= inv;
      this.schoolVX[b] *= inv; this.schoolVY[b] *= inv; this.schoolVZ[b] *= inv;
    }
  }

  /** Cache the frame's world state so the agent loop never touches objects. */
  _readWorld(world) {
    const c = this._ctx;
    c.playerPos = world.playerPos || null;
    c.playerVel = world.playerVel || null;
    c.playerAlive = world.playerAlive !== false;
    c.playerInVessel = !!world.playerInVessel;
    c.playerNoise = world.playerNoise !== undefined ? world.playerNoise : 0.40;
    c.vessel = world.vessel || null;
    c.camera = world.camera || null;
    c.cameraPos = world.camera ? world.camera.position : (world.playerPos || null);
    c.cameraFwd = world.camera ? world.camera.forward : null;
    // The rear-arc penalty needs where the PLAYER is looking, which is the
    // camera forward whenever the player is the one holding the camera.
    c.playerFwd = world.playerFwd || (c.playerInVessel ? null : c.cameraFwd);
    c.daylight = world.daylight !== undefined ? world.daylight : 1;

    const v = c.vessel;
    if (v) {
      c.vesselPos = v.position;
      // Lateral-line source strength, DESIGN/06.1.8(b): 0.9 idle, 6.5 at
      // cruise, 11.0 at full throttle. Interpolated on speed rather than on
      // the throttle input so a coasting vessel is genuinely quiet.
      const spd = v.speed || 0;
      c.vesselNoise = spd < 0.5 ? (v.piloted ? 1.60 : 0.90)
        : 0.9 + Math.min(1, spd / 14) * 5.6 + Math.max(0, spd - 14) / 7 * 4.5;
      // Strongest lamp group that is on, as (intensity, range).
      let lux = 0, range = 0;
      if (v.lights) {
        if (v.lights.flood) { lux = 42000; range = 165; }
        else if (v.lights.wide) { lux = 14000; range = 62; }
        else if (v.lights.work) { lux = 9500; range = 34; }
        else if (v.lights.strobe) { lux = 26000; range = 90; }
      }
      c.vesselLightLux = lux;
      c.vesselLightRange = range;
    } else {
      c.vesselPos = null;
      c.vesselNoise = 0;
      c.vesselLightLux = 0;
      c.vesselLightRange = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Perception (DESIGN/06.1.8)
  // -------------------------------------------------------------------------

  /**
   * Refresh the perception cache for one agent: distances, whether the player
   * or vessel is actually SEEN, the incident lamp lux, and the lateral-line
   * stimulus.
   */
  _perceive(i, dt) {
    const c = this._ctx;
    const sp = this.species[i];
    const st = SPECIES_TABLE;
    const x = this.posX[i], y = this.posY[i], z = this.posZ[i];
    const depth = Math.max(0, -y);

    // ---- vision range, DESIGN/06.1.8(a) --------------------------------
    // R_eff = R_base * lightGain * contrastGain. Deep species are dark-adapted
    // and saturating (gammaV 0.14, floor 0.35); surface species are not
    // (gammaV 0.35, floor 0.05). Which one an animal is follows from where it
    // lives, so it is derived from its depth band rather than hand-authored.
    const deepAdapted = st.depthMin[sp] > 240;
    const gammaV = deepAdapted ? 0.14 : 0.35;
    const floorV = deepAdapted ? 0.35 : 0.05;
    const lamb = ambientLuxAt(depth, c.daylight);
    const lightGain = clamp(Math.pow(lamb / 300, gammaV), floorV, 1.6);

    let px = 0, py = 0, pz = 0, pd = Infinity;
    this.sawPlayer[i] = 0;
    if (c.playerPos && !c.playerInVessel && c.playerAlive) {
      px = c.playerPos[0]; py = c.playerPos[1]; pz = c.playerPos[2];
      pd = len3(px - x, py - y, pz - z);
    }
    this.distToPlayer[i] = pd;

    let vd = Infinity;
    if (c.vesselPos) {
      vd = len3(c.vesselPos[0] - x, c.vesselPos[1] - y, c.vesselPos[2] - z);
    }
    this.distToVessel[i] = vd;

    // ---- incident lamp lux ---------------------------------------------
    // Inverse-square from the lamp plus beam extinction through the water.
    // The +1 in the denominator keeps a point source finite at zero range.
    let lux = 0;
    if (c.vesselLightLux > 0 && vd < c.vesselLightRange) {
      lux = c.vesselLightLux / (1 + vd * vd) * Math.exp(-SIGMA_PHOTOPIC * vd);
    }
    this.lightLux[i] = lux;

    // ---- lateral line, DESIGN/06.1.8(b) --------------------------------
    // S = SUM A_src / (1 + (r/r0)^2). Omnidirectional, light-independent, and
    // blocked by nothing - which is why powering the vessel down is the only
    // real way to stop being noticed.
    let s = 0;
    if (pd < 200) {
      const rr = pd / LATERAL_R0;
      s += c.playerNoise / (1 + rr * rr);
    }
    if (vd < 400) {
      const rr = vd / LATERAL_R0;
      s += c.vesselNoise / (1 + rr * rr);
    }
    this.vib[i] = s;

    // ---- nearest prey --------------------------------------------------
    // Only predators pay for this, and only at their own perception rate. The
    // result is what makes STALK and ATTACK eligible against another CREATURE:
    // without it a predator's commitment score is a function of the player's
    // distance alone and a Chiselfin pack ignores a shoal of Wisplight two
    // metres in front of it.
    this.distToPrey[i] = Infinity;
    this.preySlot[i] = -1;
    if (st.flags[sp] & SPECIES_FLAG.PREDATOR) {
      const reach = Math.min(this.bodyLength[i] * 14 + 6, NEIGHBOUR_MAX_RADIUS);
      const nn = this._queryNeighbours(i, reach);
      let bestD = Infinity, bestJ = -1;
      for (let k = 0; k < nn; k++) {
        const j = _neighbours[k];
        if (j === i || this.species[j] === sp) continue;
        if (this.tier[j] > this.tier[i]) continue;
        // DESIGN/06.7.1's maxPreySizeRatio, expressed as a length ratio: a
        // predator will not commit to something it cannot get its jaws round.
        if (this.bodyLength[j] > this.bodyLength[i] * 0.85) continue;
        const d = this._distBetween(i, j);
        // A wounded animal is preference 1.6, i.e. scored as if it were nearer.
        const eff = (this.flags[j] & 1) ? d / 1.6 : d;
        if (eff < bestD) { bestD = eff; bestJ = j; }
      }
      if (bestJ >= 0) {
        this.distToPrey[i] = this._distBetween(i, bestJ);
        this.preySlot[i] = bestJ;
      }
    }

    // ---- the vision cone -----------------------------------------------
    if (pd < Infinity) {
      const contrast = 0.55;   // an unlit diver against open water
      const rEff = st.visionRange[sp] * lightGain * (0.6 + 0.4 * contrast);
      if (pd < rEff) {
        this._forwardOf(i, _fwd);
        const inv = 1 / Math.max(pd, 1e-4);
        const dot = _fwd[0] * (px - x) * inv + _fwd[1] * (py - y) * inv + _fwd[2] * (pz - z) * inv;
        if (dot > Math.cos(st.visionHalfAngle[sp])) {
          // P_see: beam transmittance along the sight line times a soft
          // range roll-off. Motion helps a lot: a still diver is genuinely
          // hard to see, which is a real mechanic and not a nicety.
          const relSpeed = c.playerVel
            ? len3(c.playerVel[0], c.playerVel[1], c.playerVel[2]) : 0;
          const motionBonus = 1 + 0.9 * saturate(relSpeed / 4);
          const pSee = Math.exp(-SIGMA_PHOTOPIC * pd)
            * (1 - smoothstep(0.55 * rEff, rEff, pd)) * motionBonus;
          if (this.rng() < pSee) this.sawPlayer[i] = 1;
        }
      }
    }
  }

  /** Unit forward vector of slot `i`, written into `out`. */
  _forwardOf(i, out) {
    const o = i * 4;
    // Model -Z is forward; transformQuat of (0,0,-1) reduces to this.
    const qx = this.orient[o], qy = this.orient[o + 1];
    const qz = this.orient[o + 2], qw = this.orient[o + 3];
    out[0] = -2 * (qx * qz + qw * qy);
    out[1] = -2 * (qy * qz - qw * qx);
    out[2] = -(1 - 2 * (qx * qx + qy * qy));
    return out;
  }

  /**
   * The direction slot `i` escapes a NON-PREDATOR threat in: mostly tangential,
   * so the animal slips past rather than turning its tail. Unit length always.
   *
   * See PLAYER_FLEE_RADIAL_FRAC for why this exists and what it measured. The
   * short version: heading is `lookRotation` on the velocity and `_integrate`
   * re-projects the velocity back onto the heading, so a radial away-force is
   * necessarily a turn-away and the direction is the only free variable left.
   *
   * Two consumers - the FLEE steer's player and vessel branches, and the
   * photophobe's reflected seek - because both were radial and either one alone
   * reproduces the whole reported bug.
   *
   * @param {number} i slot
   * @param {number} ax unit x, threat -> animal
   * @param {number} ay unit y
   * @param {number} az unit z
   * @param {Float32Array} out written with the unit escape direction
   * @returns {Float32Array} `out`
   */
  _escapeDirection(i, ax, ay, az, out) {
    this._forwardOf(i, _fwd);
    // Gram-Schmidt: the animal's own heading with the radial part removed.
    // Using its CURRENT heading rather than a fixed axis is what makes this a
    // sidestep - away from the degenerate case it carries on roughly where it
    // was already going, and it is the minimum-angle unit vector carrying that
    // radial share. NOT near the degenerate case: when the heading is almost
    // along the radial the tangent is set by an infinitesimal perpendicular
    // component, and the result is a ~102 degree turn from the current heading.
    const along = _fwd[0] * ax + _fwd[1] * ay + _fwd[2] * az;
    let tgx = _fwd[0] - along * ax;
    let tgy = _fwd[1] - along * ay;
    let tgz = _fwd[2] - along * az;
    let tl = len3(tgx, tgy, tgz);
    if (tl < TANGENT_MIN) {
      // Forward is parallel to the radial - the animal is already swimming
      // straight at the threat or straight away from it. There is no "cheapest"
      // tangent left, so take the horizontal one, up x away, which turns the
      // animal across the threat rather than over it.
      //
      // THIS IS A DISCONTINUITY AND THERE IS NO HYSTERESIS. The fallback's SIGN
      // is unrelated to the Gram-Schmidt result it replaces, so crossing
      // TANGENT_MIN can flip the escape end-for-end in the tangential plane:
      // measured, forward (1, 0, eps) against away (1, 0, 0) gives
      // (0.2425, 0, +0.9701) at eps = 1e-2 and (0.2425, 0, -0.9701) at 1e-3.
      // It is 0.057 degrees of heading wide, and `a.tau` (0.10-0.55 s) filters
      // what gets through, so it has never been seen. Left alone deliberately:
      // choosing the fallback sign to match the incoming tangent would need the
      // pre-degenerate heading, which is exactly the quantity that has vanished.
      tgx = az; tgy = 0; tgz = -ax;
      tl = len3(tgx, tgy, tgz);
      if (tl < TANGENT_MIN) {
        // ...and the threat is directly overhead or underneath, so even that is
        // degenerate. Every horizontal direction is equally tangential now and
        // +X is as good as any. This is the arm a normalised-lerp-toward-the-
        // negation bug hides in: see the SWIM CONTRACT's SWIM_TURN_RATE, which
        // was collinear at pi and so never turned the diver round at all.
        tgx = 1; tgy = 0; tgz = 0; tl = 1;
      }
    }
    const it = 1 / tl;
    const k = PLAYER_FLEE_RADIAL_FRAC, kt = 1 - k;
    let fx = tgx * it * kt + ax * k;
    let fy = tgy * it * kt + ay * k;
    let fz = tgz * it * kt + az * k;
    // The mix of two unit vectors is not unit - at k = 0.2 with an exactly
    // perpendicular tangent it is 0.825 - and an unnormalised direction would
    // weaken the force precisely where the two terms disagree most.
    const invF = 1 / (len3(fx, fy, fz) || 1);
    out[0] = fx * invF; out[1] = fy * invF; out[2] = fz * invF;
    return out;
  }

  /**
   * Advance the threat and fear accumulators.
   *
   * Both are first-order with an exponential decay and an additive stimulus
   * term, exactly DESIGN/06.1.9. The reason they are separate accumulators
   * rather than one signed "arousal" is that an animal can be both: a Glassclaw
   * that has been shot is at threat 1.4 AND fear 1.8, and which one clears
   * first decides whether it turns to fight or keeps running.
   */
  _accumulate(i, dt) {
    const c = this._ctx;
    const sp = this.species[i];
    const st = SPECIES_TABLE;
    const aggro = st.aggression[sp];

    let dThreat = 0;
    let dFear = 0;

    const notice = st.visionRange[sp] * 1.5;
    const pd = this.distToPlayer[i];
    const vd = this.distToVessel[i];

    // Presence. Only counts if the animal has actually perceived something -
    // seeing it, or feeling it on the lateral line above threshold.
    const sensed = this.sawPlayer[i] || this.vib[i] > st.vibThreshold[sp];
    if (sensed) {
      const near = Math.min(pd, vd);
      dThreat += 0.05 * saturate(1 - near / notice);
    }
    // Vessel engine noise above cruise irritates everything within 90 m.
    if (vd < 90 && c.vesselNoise > 6.0) dThreat += 0.30 * saturate(1 - vd / 90);

    // Lamp on the body. Photophobes hate it; phototropes are calmed by it.
    const xL = saturate(this.lightLux[i] / LUX_SAT);
    const affinity = this._effectiveLightAffinity(i);
    if (xL > 0) {
      if (affinity < 0) dThreat += 0.22 * -affinity * xL;
      else dThreat -= 0.10 * xL;
    }

    // Fear from predators: anything two tiers above within three body lengths,
    // plus anything of a higher tier inside the flee radius. Derived from the
    // tier ladder rather than a hand-written FEARS table - DESIGN/06.7.1's
    // "no hand-authored fear tables".
    const myTier = this.tier[i];
    const fleeR = fearFleeRadius(this.bodyLength[i]);
    const n = this._queryNeighbours(i, Math.min(fleeR, NEIGHBOUR_MAX_RADIUS));
    for (let k = 0; k < n; k++) {
      const j = _neighbours[k];
      if (j === i) continue;
      const tj = this.tier[j];
      if (tj >= myTier + 2) {
        const d = this._distBetween(i, j);
        dFear += 1.30 * saturate(1 - d / fleeR);
        // A predator mid-lunge is a 2.60 impulse: this is the signal that
        // propagates a startle wave through a shoal.
        if (this.behaviour[j] === BEHAVIOUR.ATTACK &&
            this.state[j] === ATTACK_STATE.LUNGE) {
          dFear += 2.60 * saturate(1 - d / (fleeR * 1.5));
        }
      }
      // Startle contagion inside a school: DESIGN/06.1.9's 0.85 impulse.
      if (this.schoolId[i] >= 0 && this.schoolId[j] === this.schoolId[i] &&
          this.behaviour[j] === BEHAVIOUR.FLEE && this.state[j] === FLEE_STATE.STARTLE) {
        dFear += 0.85;
      }
    }

    const th = this.threat[i] * Math.exp(-dt / st.tauThreat[sp]) + dt * dThreat * aggro;
    const fe = this.fear[i] * Math.exp(-dt / st.tauFear[sp]) + dt * dFear;
    const wasAggro = this.threat[i] >= T_COMMIT;
    this.threat[i] = clamp(th, 0, 3);
    this.fear[i] = clamp(fe, 0, 3);

    // Hunger. Energy drains faster the harder the animal is working, which is
    // what stops a fleeing shoal from fleeing forever.
    const speed = len3(this.velX[i], this.velY[i], this.velZ[i]);
    const drain = 0.006 + 0.02 * saturate(speed / Math.max(0.1, st.speedBurst[sp]));
    this.energy[i] = clamp(this.energy[i] - drain * dt, 0, 1);

    // Aggro / calm edges, for audio and the HUD threat arc.
    const isAggro = this.threat[i] >= T_COMMIT;
    if (isAggro && !wasAggro && this.tier[i] >= 2) {
      const targetIsVessel = vd < pd;
      events.emit(EVENTS.CREATURE_AGGRO, {
        id: this.handleOf(i), species: st.id[sp],
        target: targetIsVessel ? 'vessel' : 'player',
        distance: Math.min(pd, vd),
      });
      if (SPECIES_TABLE.flags[sp] & SPECIES_FLAG.LEVIATHAN) {
        events.emit(EVENTS.LEVIATHAN_ROAR, {
          species: st.id[sp], distance: Math.min(pd, vd), position: this._pointOf(i),
        });
      }
    } else if (!isAggro && wasAggro) {
      events.emit(EVENTS.CREATURE_CALM, { id: this.handleOf(i), species: st.id[sp] });
    }

    // Leviathan proximity warning. AUDIO.LEVIATHAN_AUDIBLE_RANGE is 640 m and
    // the audio bus wants a bearing to pan the call, so this fires on a 4 s
    // stagger (240 sim steps) rather than every tick - the HUD threat arc
    // interpolates between them.
    if ((SPECIES_TABLE.flags[sp] & SPECIES_FLAG.LEVIATHAN) &&
        this.distToCamera[i] < 640 && (this._tick % 240) === (i % 240)) {
      const cx = c.cameraPos ? c.cameraPos[0] : 0;
      const cz = c.cameraPos ? c.cameraPos[2] : 0;
      events.emit(EVENTS.LEVIATHAN_NEARBY, {
        species: st.id[sp], distance: this.distToCamera[i],
        bearing: Math.atan2(this.posX[i] - cx, -(this.posZ[i] - cz)),
      });
    }
  }

  /**
   * The species' light affinity at this agent's current lamp distance.
   *
   * Three species in DESIGN/06.1.8(d) flip sign with range - attracted beyond
   * the flip radius because they come to look, repelled inside it because they
   * hate being spotlit. That single rule is what produces the "it circled the
   * light, then bolted, then came back" pattern, and it is worth the branch.
   */
  _effectiveLightAffinity(i) {
    const sp = this.species[i];
    const base = SPECIES_TABLE.lightAffinity[sp];
    const flip = SPECIES_TABLE.lightFlipRange[sp];
    if (flip <= 0) return base;
    return this.distToVessel[i] > flip ? base : -base;
  }

  // -------------------------------------------------------------------------
  // L4 utility selection (DESIGN/06.1.3)
  // -------------------------------------------------------------------------

  /**
   * Score every eligible behaviour and commit to the winner.
   *
   * score = weight * gate * clamp(sum of curved inputs, 0, 1)
   *       * inertiaBonus * cooldownGate
   *
   * Ties go to the lowest behaviour id so the choice is deterministic and a
   * save/load reproduces it.
   */
  _select(i) {
    const st = SPECIES_TABLE;
    const sp = this.species[i];
    const a = ARCHETYPES[this.archetype[i]];
    const cur = this.behaviour[i];
    const cdBase = i * BEHAVIOUR_COUNT;

    const xThreat = this.threat[i] / 3;
    const xFear = this.fear[i] / 3;
    const xHunger = 1 - this.energy[i];
    const xHp = this.hp[i] / Math.max(1e-3, this.hpMax[i]);
    const notice = st.visionRange[sp] * 1.5;
    const near = Math.min(this.distToPlayer[i], this.distToVessel[i]);
    const xNear = 1 - saturate(near / notice);
    const strikeR = this.bodyLength[i] * 1.4 + 1.0;

    const depth = Math.max(0, -this.posY[i]);
    const inBand = depth >= st.depthMin[sp] - 12 && depth <= st.depthMax[sp] + 12;

    const dHome = len3(this.posX[i] - this.homeX[i],
      this.posY[i] - this.homeY[i], this.posZ[i] - this.homeZ[i]);
    const xHome = saturate(dHome / Math.max(1, this.territoryR[i]));

    _scores.fill(0);

    // IDLE_WANDER is always eligible and always scores something, so there is
    // never a frame with no behaviour selected.
    _scores[BEHAVIOUR.IDLE] = 0.20 + 0.15 * (1 - xHunger);

    // SCHOOL: only for an agent in a school whose archetype actually coheres.
    if (this.schoolId[i] >= 0 && a.w[STEER.COHESION] > 0) {
      _scores[BEHAVIOUR.SCHOOL] = 0.85 * (1 - 0.5 * xHunger);
    }

    // PATROL: a territorial animal outside its territory comes home. sqrt of
    // the distance so the pull is strong immediately and does not need the
    // animal to be halfway across the map before it notices.
    if (a.w[STEER.ARRIVE] > 0.5) {
      _scores[BEHAVIOUR.PATROL] = 0.45 * Math.sqrt(xHome);
    }

    // FORAGE: gate at hunger > 0.25, urgency as sqrt(hunger).
    if (xHunger > 0.25) {
      _scores[BEHAVIOUR.FORAGE] = 0.75 * Math.sqrt(xHunger) * (inBand ? 1 : 0.6);
    }

    // INVESTIGATE: the curiosity window. Below T_notice nothing happens; above
    // T_investigate the animal commits to something stronger.
    if (xThreat * 3 >= T_NOTICE && xThreat * 3 < T_INVESTIGATE + 0.3) {
      _scores[BEHAVIOUR.INVESTIGATE] = 0.70 * xNear * (1 - xFear);
    }

    // STALK and ATTACK: predators only. `hunt` is the distance to the nearest
    // thing worth attacking, which is the nearest of the player, the vessel and
    // the nearest valid prey creature - the last is what makes the food web
    // turn over when the player is nowhere near.
    if ((st.flags[sp] & SPECIES_FLAG.PREDATOR) && this.tier[i] >= 1) {
      const hunt = Math.min(near, this.distToPrey[i]);
      if (this.threat[i] > T_INVESTIGATE && hunt < strikeR * 14) {
        _scores[BEHAVIOUR.STALK] = 0.80 * xThreat * xThreat * (1 - 0.5 * xFear);
      }
      if (this.threat[i] > T_COMMIT && hunt < strikeR * 8) {
        // quad curve on threat: commitment should be reluctant at 1.1 and
        // total at 2.2, not linear between them.
        _scores[BEHAVIOUR.ATTACK] = 1.15 * xThreat * xThreat * saturate(1 - hunt / (strikeR * 8));
      }
    }

    // FEED: a fed animal chews. `flags` bit 1 is set by the predation solver.
    if (this.flags[i] & 2) _scores[BEHAVIOUR.FEED] = 1.30;

    // FLEE: eligible at F_flinch, forced at F_panic.
    if (this.fear[i] > F_FLINCH) {
      _scores[BEHAVIOUR.FLEE] = 1.05 * xFear;
      if (this.fear[i] > F_PANIC && this.threat[i] < T_FRENZY) _scores[BEHAVIOUR.FLEE] = 3.0;
    }

    // RETREAT_HEAL folds into FLEE: a badly hurt animal flees harder.
    if (xHp < 0.30) _scores[BEHAVIOUR.FLEE] += 0.6 * (1 - xHp / 0.30);

    // REST: sated, unbothered, and in the right water.
    if (xHunger < 0.20 && this.threat[i] < T_NOTICE && this.fear[i] < F_FLINCH) {
      _scores[BEHAVIOUR.REST] = 0.55 * (1 - xHunger / 0.20) * (inBand ? 1 : 0.3);
    }

    let best = -1, bestScore = 0;
    for (let b = 0; b < BEHAVIOUR_COUNT; b++) {
      let s = _scores[b];
      if (s <= 0) continue;
      if (this.cooldown[cdBase + b] > 0 && b !== cur) continue;
      if (b === cur) s *= INERTIA_BONUS;
      if (s > bestScore) { bestScore = s; best = b; }
    }
    if (best < 0) best = BEHAVIOUR.IDLE;
    if (best !== cur) {
      this.cooldown[cdBase + cur] = BEHAVIOUR_COOLDOWN[cur];
      this.behaviour[i] = best;
      this.state[i] = 0;
      this.stateT[i] = 0;
      if (best === BEHAVIOUR.FLEE) this.startleT[i] = ARCHETYPES[this.archetype[i]].tStartle;
      // STALK needs a target as much as ATTACK does: without one it steers at
      // its own home and reads as an animal that lost interest halfway.
      if (best === BEHAVIOUR.ATTACK || best === BEHAVIOUR.STALK) this._pickAttackTarget(i);
    }
  }

  /** Choose what an attacking agent is attacking, and cache its position. */
  _pickAttackTarget(i) {
    const pd = this.distToPlayer[i];
    const vd = this.distToVessel[i];
    const c = this._ctx;

    // Prey first: creature-vs-creature predation is what the player watches to
    // learn the telegraph before it is aimed at them. The candidate was already
    // found by perception, so this is a cache read rather than a second search.
    const bestJ = this.preySlot[i];
    const bestD = bestJ >= 0 && this.alive[bestJ] ? this.distToPrey[i] : Infinity;

    if (bestJ >= 0 && this.alive[bestJ] && bestD < Math.min(pd, vd)) {
      this.targetKind[i] = TARGET.CREATURE;
      this.targetId[i] = this.handleOf(bestJ);
      return;
    }
    if (vd < pd && c.vesselPos && this.tier[i] >= 3) {
      this.targetKind[i] = TARGET.VESSEL;
      this.targetId[i] = -1;
      return;
    }
    if (pd < Infinity && this.tier[i] >= 2) {
      this.targetKind[i] = TARGET.PLAYER;
      this.targetId[i] = -1;
      return;
    }
    this.targetKind[i] = TARGET.NONE;
    this.targetId[i] = -1;
    // Nothing to attack: drop out of ATTACK immediately rather than lunging
    // at empty water.
    this.behaviour[i] = BEHAVIOUR.IDLE;
  }

  // -------------------------------------------------------------------------
  // L3 HFSM (DESIGN/06.1.4)
  // -------------------------------------------------------------------------

  /** Advance the current behaviour's state machine. */
  _advanceFsm(i, dt) {
    this.stateT[i] += dt;
    const b = this.behaviour[i];
    if (b === BEHAVIOUR.ATTACK) this._fsmAttack(i);
    else if (b === BEHAVIOUR.FLEE) this._fsmFlee(i, dt);
    else if (b === BEHAVIOUR.FEED) {
      // FEED is a fixed 6 s of chewing, then the flag clears and the selector
      // moves on. The rhythm is in _animate's jaw term.
      if (this.stateT[i] > 6) { this.flags[i] &= ~2; this.energy[i] = Math.min(1, this.energy[i] + 0.35); }
    }
    if (this.startleT[i] > 0) this.startleT[i] = Math.max(0, this.startleT[i] - dt);
  }

  /** The six-state attack cycle. The WINDUP is the mandatory telegraph. */
  _fsmAttack(i) {
    const tier = this.tier[i];
    const frenzy = this.threat[i] > T_FRENZY;
    const strikeR = this.bodyLength[i] * 1.4 + 1.0;
    const t = this.stateT[i];
    const dist = this._targetDistance(i);

    switch (this.state[i]) {
      case ATTACK_STATE.APPROACH:
        if (dist < strikeR * 2.2 || t > 8.0) this._setAttackState(i, ATTACK_STATE.WINDUP);
        break;
      case ATTACK_STATE.WINDUP: {
        // Frenzy shortens the windup to 0.80x, but never below 0.60 s for
        // tier 4-5. That floor is a fairness invariant, not a tuning number.
        let w = T_WINDUP[tier] * (frenzy ? 0.80 : 1.0);
        if (tier >= 4) w = Math.max(w, 0.60);
        // REAR-ARC PENALTY. An attack the player cannot see coming gets a
        // LONGER telegraph, not a shorter one, so an unseen strike is still
        // survivable by sound alone. DESIGN/06.1.4's rear-arc column.
        if (this.targetKind[i] === TARGET.PLAYER && this._attackingFromRear(i)) {
          w += T_REAR_EXTRA[tier];
        }
        if (t >= w) this._setAttackState(i, ATTACK_STATE.LUNGE);
        break;
      }
      case ATTACK_STATE.LUNGE:
        if (t >= T_LUNGE[tier] || dist < strikeR * 0.6) {
          this._setAttackState(i, ATTACK_STATE.CONTACT);
        }
        break;
      case ATTACK_STATE.CONTACT:
        if (t >= T_CONTACT) this._setAttackState(i, ATTACK_STATE.RECOVER);
        break;
      case ATTACK_STATE.RECOVER:
        if (t >= T_RECOVER[tier]) this._setAttackState(i, ATTACK_STATE.REPOSITION);
        break;
      default:
        // REPOSITION loops back only while the threat is still committed;
        // otherwise the selector takes over and the animal disengages.
        if (t >= 1.2 + this.rng() * 2.8) {
          if (this.threat[i] > 0.9) this._setAttackState(i, ATTACK_STATE.APPROACH);
          else { this.behaviour[i] = BEHAVIOUR.IDLE; this.state[i] = 0; this.stateT[i] = 0; }
        }
        break;
    }
  }

  /**
   * True if this agent sits outside the player's 100 degree front cone, i.e.
   * cos(50 deg) = 0.643 against the player's view direction.
   */
  _attackingFromRear(i) {
    const c = this._ctx;
    if (!c.playerPos || !c.playerFwd) return false;
    const dx = this.posX[i] - c.playerPos[0];
    const dy = this.posY[i] - c.playerPos[1];
    const dz = this.posZ[i] - c.playerPos[2];
    const d = len3(dx, dy, dz);
    if (d < 1e-3) return false;
    const dot = (c.playerFwd[0] * dx + c.playerFwd[1] * dy + c.playerFwd[2] * dz) / d;
    return dot < 0.643;
  }

  _setAttackState(i, s) {
    this.state[i] = s;
    this.stateT[i] = 0;
    if (s === ATTACK_STATE.WINDUP) {
      // THE AUDIO TELL. Fired at state ENTRY, before any damage can land, so
      // the time between the cue and the hit is exactly T_WINDUP.
      events.emit(EVENTS.CREATURE_VOCALIZE, {
        id: this.handleOf(i), species: SPECIES_TABLE.id[this.species[i]],
        position: this._pointOf(i), distance: this.distToCamera[i], kind: 'windup',
      });
      this.stats.attacks++;
    } else if (s === ATTACK_STATE.CONTACT) {
      this._resolveStrike(i);
    }
  }

  /** The four-state flee cycle. */
  _fsmFlee(i, dt) {
    const t = this.stateT[i];
    const a = ARCHETYPES[this.archetype[i]];
    switch (this.state[i]) {
      case FLEE_STATE.STARTLE:
        if (t >= a.tStartle) { this.state[i] = FLEE_STATE.BURST; this.stateT[i] = 0; }
        break;
      case FLEE_STATE.BURST:
        // A burst is anaerobic and it costs: 0.22 energy per second, which is
        // what bounds a flee to four seconds and then forces the animal to
        // forage. Without the drain a startled shoal sprints forever.
        this.energy[i] = Math.max(0, this.energy[i] - 0.22 * dt);
        if (t >= Math.min(4.0, 1.5 + 2.0 * this.fear[i])) {
          this.state[i] = FLEE_STATE.SUSTAIN; this.stateT[i] = 0;
        }
        break;
      case FLEE_STATE.SUSTAIN:
        if (this.fear[i] < 0.25 || t > 20) { this.state[i] = FLEE_STATE.SETTLE; this.stateT[i] = 0; }
        break;
      default:
        if (t >= 3.0) { this.behaviour[i] = BEHAVIOUR.IDLE; this.state[i] = 0; this.stateT[i] = 0; }
        break;
    }
  }

  /** Distance from slot `i` to whatever it is targeting. */
  _targetDistance(i) {
    switch (this.targetKind[i]) {
      case TARGET.PLAYER: return this.distToPlayer[i];
      case TARGET.VESSEL: return this.distToVessel[i];
      case TARGET.CREATURE: {
        const j = this.slotOf(this.targetId[i]);
        if (j < 0) return Infinity;
        return this._distBetween(i, j);
      }
      case TARGET.POINT:
        return len3(this.targetX[i] - this.posX[i],
          this.targetY[i] - this.posY[i], this.targetZ[i] - this.posZ[i]);
      default: return Infinity;
    }
  }

  /** Position of slot `i`'s target, written into `out`. False if there is none. */
  _targetPosition(i, out) {
    const c = this._ctx;
    switch (this.targetKind[i]) {
      case TARGET.PLAYER:
        if (!c.playerPos) return false;
        vec3.copy(out, c.playerPos); return true;
      case TARGET.VESSEL:
        if (!c.vesselPos) return false;
        vec3.copy(out, c.vesselPos); return true;
      case TARGET.CREATURE: {
        const j = this.slotOf(this.targetId[i]);
        if (j < 0) return false;
        vec3.set(out, this.posX[j], this.posY[j], this.posZ[j]); return true;
      }
      case TARGET.POINT:
        vec3.set(out, this.targetX[i], this.targetY[i], this.targetZ[i]); return true;
      default: return false;
    }
  }

  // -------------------------------------------------------------------------
  // L2 steering (DESIGN/06.1.5)
  // -------------------------------------------------------------------------

  /**
   * Blend the nine steering forces and write the smoothed, clamped result into
   * steerX/Y/Z.
   *
   * Every force is written into the `_blend` scratch as a velocity-relative
   * desired-change (`desiredVelocity - currentVelocity`), except OBSTACLE,
   * which is absolute: an avoidance force that is velocity-relative gets
   * cancelled by the very velocity that is about to hit the rock.
   */
  _steer(i, dt, lodClass) {
    const st = SPECIES_TABLE;
    const sp = this.species[i];
    const a = ARCHETYPES[this.archetype[i]];
    const b = this.behaviour[i];
    const mulBase = b * STEER_COUNT;

    // ---- effective weights ---------------------------------------------
    for (let s = 0; s < STEER_COUNT; s++) {
      _weights[s] = a.w[s] * BEHAVIOUR_MUL[mulBase + s];
    }
    _blend.fill(0);

    const x = this.posX[i], y = this.posY[i], z = this.posZ[i];
    const vx = this.velX[i], vy = this.velY[i], vz = this.velZ[i];
    const speed = len3(vx, vy, vz);
    const vMax = this._maxSpeed(i);

    // ---- 1/3. SEEK and ARRIVE -----------------------------------------
    let haveTarget = false;
    if (_weights[STEER.SEEK] > 0 || _weights[STEER.ARRIVE] > 0) {
      haveTarget = this._resolveSteerTarget(i, _target);
      if (haveTarget) {
        const dx = _target[0] - x, dy = _target[1] - y, dz = _target[2] - z;
        const d = len3(dx, dy, dz);
        if (d > 1e-4) {
          const inv = 1 / d;
          if (_weights[STEER.SEEK] > 0) {
            const o = STEER.SEEK * 3;
            _blend[o] = dx * inv * vMax - vx;
            _blend[o + 1] = dy * inv * vMax - vy;
            _blend[o + 2] = dz * inv * vMax - vz;
          }
          if (_weights[STEER.ARRIVE] > 0) {
            // Slowing radius scales with the animal: a 30 m leviathan needs
            // 60 m to stop, a 10 cm sprat needs 20 cm.
            const rSlow = Math.max(1.5, this.bodyLength[i] * 2.0);
            const sT = vMax * Math.min(1, d / rSlow);
            const o = STEER.ARRIVE * 3;
            _blend[o] = dx * inv * sT - vx;
            _blend[o + 1] = dy * inv * sT - vy;
            _blend[o + 2] = dz * inv * sT - vz;
          }
        }
      }
    }

    // ---- 2. FLEE -------------------------------------------------------
    if (_weights[STEER.FLEE] > 0) {
      // THE FEAR RADIUS IS A FLOOR UNDER THE STEER RADIUS, never the other way
      // round: an animal must be able to steer away from every threat that can
      // frighten it, and this query is also how it finds one. See
      // FEAR_FLEE_BASE_M for the 11-of-40 inversion this closes.
      const bl = this.bodyLength[i];
      const rPanic = Math.max(PANIC_FLOOR_M + PANIC_BODY_LENGTHS * bl,
        fearFleeRadius(bl));
      // THE PLAYER AND THE VESSEL ARE NOT PREDATORS AND DO NOT GET THE PREDATOR
      // RADIUS. See PLAYER_PANIC_FLOOR_M: `2 + 12L` is 4.66 m on a sprat and
      // 218 m on a Veilmouth, and a diver's threat footprint does not grow with
      // the animal looking at it.
      const rPlayer = playerPanicRadius(bl);
      // The radius the CHOSEN threat was accepted under, carried alongside the
      // distance so the falloff below is against the right one - the vessel's
      // is nearly twice the player's, and a predator's is different again.
      // `soft` records whether the winner steers TANGENTIALLY (see below).
      let tx = 0, ty = 0, tz = 0, best = Infinity, bestR = rPanic, soft = false;
      const c = this._ctx;
      if (this.distToPlayer[i] < best && this.distToPlayer[i] < rPlayer && c.playerPos) {
        best = this.distToPlayer[i]; bestR = rPlayer; soft = true;
        tx = c.playerPos[0]; ty = c.playerPos[1]; tz = c.playerPos[2];
      }
      // The vessel's panic radius is nearly twice the player's: it is 7.4 m of
      // hull with lights on, not a diver.
      const rVessel = rPlayer * VESSEL_PANIC_MULT;
      if (this.distToVessel[i] < best && this.distToVessel[i] < rVessel && c.vesselPos) {
        best = this.distToVessel[i]; bestR = rVessel; soft = true;
        tx = c.vesselPos[0]; ty = c.vesselPos[1]; tz = c.vesselPos[2];
      }
      // Plus the nearest genuine predator, which usually wins - and which keeps
      // the full radial escape, because being eaten is not a photo opportunity.
      const n = this._queryNeighbours(i, Math.min(rPanic, NEIGHBOUR_MAX_RADIUS));
      for (let k = 0; k < n; k++) {
        const j = _neighbours[k];
        if (j === i || this.tier[j] < this.tier[i] + 2) continue;
        const d = this._distBetween(i, j);
        if (d < best) {
          best = d; bestR = rPanic; soft = false;
          tx = this.posX[j]; ty = this.posY[j]; tz = this.posZ[j];
        }
      }
      if (best < Infinity) {
        const dx = x - tx, dy = y - ty, dz = z - tz;
        const d = len3(dx, dy, dz);
        if (d > 1e-4) {
          // LINEAR FALLOFF TO ZERO AT THE PANIC RADIUS, DESIGN/06.2 step 8.
          //
          // DESIGN states this one quantity twice and the two disagree: 06.1.5
          // cuts hard at R_panic, 06.2 writes saturate(1 - d / R_panic). The
          // hard cut is what shipped, and a hard-edged repulsion with no falloff
          // is a full-strength field pinned to the diver - MEASURED, it
          // delivered 1.00 m/s2 against a net steering resultant of 0.18 m/s2,
          // 5.5x the vector sum of everything else, at 26 body lengths from a
          // Sunplate. It is also the LARGEST weight these animals ever have:
          // BEHAVIOUR_MUL's FLEE column is 1.0 in IDLE, SCHOOL and FORAGE, the
          // only behaviours a lagoon fish is ever in, against REEFDART's 2.40.
          // The measurement settles the disagreement in favour of 06.2.
          //
          // The WHOLE term is scaled, the `- v` part included: scaling only the
          // target-velocity half would leave a bare `-v` at the radius, which is
          // a brake, i.e. a different artefact rather than none.
          //
          // IT IS SCALED BY `d`, NOT BY `best`. `best` is the PERCEIVED distance
          // and only the predator branch writes it live; distToPlayer and
          // distToVessel are refreshed on PERCEPTION_PERIOD, 4 sim steps at
          // LOD0, so at a 4 m/s closing speed they are up to 0.27 m stale
          // against a Coppersprat's 4.66 m radius - 6% of the falloff. `d` is
          // the real separation and is already in hand. `best` still decides
          // WHICH threat wins, because that is the comparison the acceptance
          // tests were made under.
          //
          // f(0) = 1, so the repulsion is unchanged only in the limit; at every
          // finite range it is weaker by fall(d) on a radius that itself fell.
          // The stand-off is therefore a measurement and not a guarantee - there
          // is no hard floor anywhere in this code. MEASURED over two 100 m
          // swims past 178 and 211 animals: closest approach 2.551 and 2.613 m,
          // NOTHING inside 2 m, 2 and 3 animals inside 3 m, against a hard
          // 5.690 m exclusion zone before the change (0 of 212 observations
          // inside 5 m). Cutting the floor without the fear-radius max above
          // gave 1.340 m and 5 animals inside 2 m on the same probe.
          //
          // ALL FIVE OF THOSE FIGURES ARE PRE-2026-08-02 and describe a build
          // where the diver shared this radius. A Coppersprat's player radius is
          // 2.22 m now, not 4.66, and the escape is tangential - so the numbers
          // are kept as the history of the FLOOR argument and are NOT current.
          // The pooled swim that produced them cannot re-measure them either:
          // see STATUS item C, it collects 10-40 observations inside the new
          // radius against 15,000 outside it.
          const fall = saturate(1 - d / bestR);
          const invD = 1 / d;
          // The away direction, unit. For a PREDATOR this is the whole answer
          // and the three lines below are ALGEBRAICALLY identical to what they
          // replaced - `dx*(1/d) * (vMax*fall)` against `dx * ((vMax*fall)/d)`,
          // which differ only in rounding order and are within one f32 ULP
          // (f64 results differ on 41% of random draws; the f32 store differs
          // on roughly 2^-27 of them). NOT bit-identical, as this comment used
          // to claim. Section 19 needs no new baseline, but note that section 19
          // asserts only the SIGN of the away-component - it would pass under
          // any positive rescale or a rotation up to 89 degrees off the radial.
          // The real guard on predator radiality is section 20c's last check.
          const ax = dx * invD, ay = dy * invD, az = dz * invD;
          let fx = ax, fy = ay, fz = az;

          if (soft) {
            // A DIVER GETS A SIDESTEP, NOT A ROUT. The animal keeps its
            // distance but slips PAST rather than away, so it shows its flank
            // instead of its tail. See _escapeDirection and
            // PLAYER_FLEE_RADIAL_FRAC.
            this._escapeDirection(i, ax, ay, az, _dir);
            fx = _dir[0]; fy = _dir[1]; fz = _dir[2];
          }

          const g = vMax * fall;
          const o = STEER.FLEE * 3;
          _blend[o] = fx * g - vx * fall;
          _blend[o + 1] = fy * g - vy * fall;
          _blend[o + 2] = fz * g - vz * fall;
        }
      }
    }

    // ---- 4. WANDER -----------------------------------------------------
    if (_weights[STEER.WANDER] > 0) {
      // Jitter scales with agility: a reefdart's wander target skitters, a
      // leviathan's drifts. 1.4 rad/s at aMax 12, 0.2 at aMax 1.2.
      const jitter = 0.35 + 0.09 * a.aMax;
      this.wanderYaw[i] = wrapAngle(this.wanderYaw[i] + (this.rng() * 2 - 1) * jitter * dt);
      this.wanderPitch[i] = clamp(
        this.wanderPitch[i] + (this.rng() * 2 - 1) * jitter * 0.45 * dt, -0.7, 0.7);
      this._forwardOf(i, _fwd);
      // THE PROJECTION SPHERE, and it has to be a projection sphere.
      // DESIGN/06.1.5 item 4 puts the wander target on a sphere of radius rW
      // centred dW AHEAD of the agent, so the steered direction can never
      // deviate from forward by more than atan(rW/dW) = 29 degrees. Rotating
      // the heading by the wander angle DIRECTLY instead - which is the obvious
      // shortcut - lets a wanderYaw near pi aim the target backwards, and the
      // resulting force is a brake: a measured school decelerated from
      // 1.6 m/s to 0.03 m/s and then had no motion left to school with.
      const dW = Math.max(2, this.bodyLength[i] * 5);
      const rW = dW * 0.55;
      const cy = Math.cos(this.wanderYaw[i]), sy = Math.sin(this.wanderYaw[i]);
      const dxz = len2(_fwd[0], _fwd[2]) || 1e-4;
      const rx = -_fwd[2] / dxz, rz = _fwd[0] / dxz;
      const cp = Math.cos(this.wanderPitch[i]), spp = Math.sin(this.wanderPitch[i]);
      // A unit vector: forward rotated by wanderYaw about world up and by
      // wanderPitch about the agent's right axis.
      const ox = (_fwd[0] * cy + rx * sy) * cp;
      const oz = (_fwd[2] * cy + rz * sy) * cp;
      const oy = _fwd[1] * cp + spp;
      const tx = _fwd[0] * dW + ox * rW;
      const ty = _fwd[1] * dW + oy * rW;
      const tz = _fwd[2] * dW + oz * rW;
      const tl = len3(tx, ty, tz) || 1;
      const o = STEER.WANDER * 3;
      _blend[o] = tx / tl * vMax - vx;
      _blend[o + 1] = ty / tl * vMax - vy;
      _blend[o + 2] = tz / tl * vMax - vz;
    }

    // ---- 5/6/7. BOIDS --------------------------------------------------
    // REDUCED and STATISTICAL agents route alignment and cohesion through the
    // school proxy instead of a neighbour query, which is DESIGN/06.1.10's LOD
    // rule: at 60 m a shoal's internal structure is below a pixel of angular
    // size, but its BULK motion is not, and dropping the terms entirely lets a
    // distant school visibly disperse.
    const schoolSlot = this.schoolId[i] >= 0 ? (this.schoolId[i] & SCHOOL_MASK) : -1;
    const proxied = lodClass > 0 && schoolSlot >= 0 && this.schoolCount[schoolSlot] > 1;
    if (proxied) {
      if (_weights[STEER.ALIGNMENT] > 0) {
        const mx = this.schoolVX[schoolSlot], my = this.schoolVY[schoolSlot];
        const mz = this.schoolVZ[schoolSlot];
        const ml = len3(mx, my, mz);
        if (ml > 1e-4) {
          const s = vMax / ml;
          const o = STEER.ALIGNMENT * 3;
          _blend[o] = mx * s - vx;
          _blend[o + 1] = my * s - vy;
          _blend[o + 2] = mz * s - vz;
        }
      }
      if (_weights[STEER.COHESION] > 0) {
        const cx2 = this.schoolX[schoolSlot] - x;
        const cy3 = this.schoolY[schoolSlot] - y;
        const cz2 = this.schoolZ[schoolSlot] - z;
        const d = len3(cx2, cy3, cz2);
        if (d > 1e-4) {
          const s = vMax / d;
          const o = STEER.COHESION * 3;
          _blend[o] = cx2 * s - vx;
          _blend[o + 1] = cy3 * s - vy;
          _blend[o + 2] = cz2 * s - vz;
        }
      }
      // Separation is NOT proxied: two fish inside each other looks wrong at
      // any distance, and it is the one boids term that a centroid cannot
      // approximate.
    }

    const wantsBoids = _weights[STEER.SEPARATION] > 0 ||
      (!proxied && (_weights[STEER.ALIGNMENT] > 0 || _weights[STEER.COHESION] > 0));
    if (wantsBoids) {
      const rMax = Math.min(
        proxied ? a.rSep : Math.max(a.rSep, a.rAli, a.rCoh), NEIGHBOUR_MAX_RADIUS);
      const n = this._queryNeighbours(i, rMax);
      vec3.zero(_sep); vec3.zero(_ali); vec3.zero(_coh);
      let nSep = 0, nAli = 0, nCoh = 0;
      const rSep2 = a.rSep * a.rSep, rAli2 = a.rAli * a.rAli, rCoh2 = a.rCoh * a.rCoh;
      const school = this.schoolId[i];
      for (let k = 0; k < n; k++) {
        const j = _neighbours[k];
        if (j === i) continue;
        const dx = x - this.posX[j], dy = y - this.posY[j], dz = z - this.posZ[j];
        const d2 = dx * dx + dy * dy + dz * dz;
        // SEPARATION applies to EVERY neighbour of any species: nothing swims
        // through anything else. The inverse-square weight with a 0.04 floor
        // is DESIGN/06.1.5 item 5 - the floor is what stops two coincident
        // agents producing an infinite force.
        if (d2 < rSep2) {
          const inv = 1 / Math.max(d2, 0.04);
          _sep[0] += dx * inv; _sep[1] += dy * inv; _sep[2] += dz * inv;
          nSep++;
        }
        // ALIGNMENT and COHESION only apply within the same school. A
        // Coppersprat does not take formation cues from a Bloatspine.
        if (proxied || school < 0 || this.schoolId[j] !== school) continue;
        if (d2 < rAli2) {
          _ali[0] += this.velX[j]; _ali[1] += this.velY[j]; _ali[2] += this.velZ[j];
          nAli++;
        }
        if (d2 < rCoh2) {
          _coh[0] += this.posX[j]; _coh[1] += this.posY[j]; _coh[2] += this.posZ[j];
          nCoh++;
        }
      }
      if (nSep > 0) {
        vec3.normalize(_sep, _sep);
        const o = STEER.SEPARATION * 3;
        _blend[o] = _sep[0] * vMax - vx;
        _blend[o + 1] = _sep[1] * vMax - vy;
        _blend[o + 2] = _sep[2] * vMax - vz;
      }
      if (nAli > 0) {
        vec3.scale(_ali, _ali, 1 / nAli);
        vec3.normalize(_ali, _ali);
        const o = STEER.ALIGNMENT * 3;
        _blend[o] = _ali[0] * vMax - vx;
        _blend[o + 1] = _ali[1] * vMax - vy;
        _blend[o + 2] = _ali[2] * vMax - vz;
      }
      if (nCoh > 0) {
        const inv = 1 / nCoh;
        const cx = _coh[0] * inv - x, cy2 = _coh[1] * inv - y, cz = _coh[2] * inv - z;
        const d = len3(cx, cy2, cz);
        if (d > 1e-4) {
          const s = vMax / d;
          const o = STEER.COHESION * 3;
          _blend[o] = cx * s - vx;
          _blend[o + 1] = cy2 * s - vy;
          _blend[o + 2] = cz * s - vz;
        }
      }
    }

    // ---- 8. OBSTACLE AVOIDANCE ----------------------------------------
    if (_weights[STEER.OBSTACLE] > 0) {
      this._avoid(i, speed, vMax, lodClass);
    }

    // ---- 9. DEPTH-BAND KEEPING ----------------------------------------
    if (_weights[STEER.DEPTH] > 0) {
      const yHi = -st.depthMin[sp];      // shallow limit (larger y)
      const yLo = -st.depthMax[sp];      // deep limit (smaller y)
      let err = 0;
      if (y > yHi) err = y - yHi;
      else if (y < yLo) err = y - yLo;
      let fy = -K_DEPTH * err - C_DEPTH * vy;
      if (Math.abs(err) > DEPTH_HARD_MARGIN) fy *= 6.0;
      _blend[STEER.DEPTH * 3 + 1] = fy;
    }

    // ---- blend, smooth, clamp -----------------------------------------
    let fx = 0, fy = 0, fz = 0;
    for (let s = 0; s < STEER_COUNT; s++) {
      const w = _weights[s];
      if (w === 0) continue;
      const o = s * 3;
      fx += _blend[o] * w; fy += _blend[o + 1] * w; fz += _blend[o + 2] * w;
    }

    // Airborne and grounded archetypes get an altitude/ground term instead of
    // depth keeping. DESIGN/06.1.7's two footnotes.
    if (IS_AIRBORNE[this.archetype[i]]) {
      const ground = this.collision ? this.collision.heightAt(x, z) : 0;
      const agl = y - Math.max(ground, 0);
      let err = 0;
      if (agl > 140) err = agl - 140;
      else if (agl < 6) err = agl - 6;
      fy += -K_DEPTH * 2.2 * err - C_DEPTH * vy;
    }

    // Boundary turn-back. A soft, growing force from SOFT_BOUNDARY outward, so
    // an animal visibly turns rather than hitting a wall.
    const r = len2(x, z);
    if (r > BOUNDARY_SOFT) {
      const over = (r - BOUNDARY_SOFT) / 120;
      const s = -a.aMax * Math.min(3, over) / Math.max(r, 1e-3);
      fx += x * s; fz += z * s;
    }

    // ---- SAFE CHARTER, ENFORCEMENT LEVEL 2 -----------------------------
    const ch = this._charter;
    if (ch.radius > 0 && this.tier[i] >= 1) {
      // The PREDICTED position one second out, not the current one: a fish at
      // 9 m/s covers the 40 m margin in four and a half seconds, and reacting
      // to where it is rather than where it is going is how an agent ends up
      // inside the volume for the frame it takes the force to bite.
      const cdx = (x + vx) - ch.centerX;
      const cdz = (z + vz) - ch.centerZ;
      const cr = len2(cdx, cdz);
      const edge = ch.radius + ch.margin;
      if (cr < edge) {
        // Radially out, at 2.5 * aMax. Strong enough to beat any combination
        // of the other eight forces, since the blend is clamped to aMax.
        const push = a.aMax * 2.5 * (1 - cr / Math.max(edge, 1e-3));
        if (cr > 1e-3) { fx += cdx / cr * push; fz += cdz / cr * push; }
        else { fx += push; }        // dead centre: any direction will do
        // Gate the two behaviours that could reach the player. The selector
        // will re-score next time it runs; this is the immediate stop.
        if (b === BEHAVIOUR.ATTACK || b === BEHAVIOUR.STALK) {
          this.behaviour[i] = BEHAVIOUR.IDLE;
          this.state[i] = 0;
          this.targetKind[i] = TARGET.NONE;
        }
      }
      // Tier >= 3 near the crater is additionally driven below deepFloor, so
      // the first thing a player meets on leaving the lagoon is above them.
      if (this.tier[i] >= 3 && ch.deepRadius > 0) {
        const dr = len2(x - ch.centerX, z - ch.centerZ);
        if (dr < ch.deepRadius && y > ch.deepFloor) {
          fy -= a.aMax * 1.5 * saturate((y - ch.deepFloor) / 60);
        }
      }
    }

    // Path smoothing: a first-order lag with the archetype's tau. This is what
    // separates a leviathan (tau 0.55) from a reefdart (tau 0.10) far more
    // than their accelerations do.
    const alpha = 1 - Math.exp(-dt / Math.max(a.tau, 1e-3));
    fx = this.steerX[i] + (fx - this.steerX[i]) * alpha;
    fy = this.steerY[i] + (fy - this.steerY[i]) * alpha;
    fz = this.steerZ[i] + (fz - this.steerZ[i]) * alpha;

    const fl = len3(fx, fy, fz);
    if (fl > a.aMax && fl > 1e-6) {
      const s = a.aMax / fl;
      fx *= s; fy *= s; fz *= s;
    }
    // NaN barrier. A single NaN steering force propagates into the position
    // and from there into the render instance, where it becomes a triangle
    // stretched across the whole screen. Catching it here costs three
    // comparisons per agent per tick.
    if (!(Number.isFinite(fx) && Number.isFinite(fy) && Number.isFinite(fz))) {
      fx = 0; fy = 0; fz = 0;
    }
    this.steerX[i] = fx; this.steerY[i] = fy; this.steerZ[i] = fz;
  }

  /** Where SEEK/ARRIVE should aim, given the behaviour. */
  _resolveSteerTarget(i, out) {
    const b = this.behaviour[i];
    if (b === BEHAVIOUR.ATTACK || b === BEHAVIOUR.STALK || b === BEHAVIOUR.FEED) {
      if (this._targetPosition(i, out)) {
        if (b === BEHAVIOUR.STALK) {
          // Stalking aims at a point off the target's flank, not at the target:
          // a predator that beelines reads as a homing missile.
          const dx = out[0] - this.posX[i], dz = out[2] - this.posZ[i];
          const d = len2(dx, dz) || 1;
          const off = this.bodyLength[i] * 2.5;
          out[0] += -dz / d * off;
          out[2] += dx / d * off;
        }
        return true;
      }
      return false;
    }
    if (b === BEHAVIOUR.SCHOOL) {
      // The school's centroid, at any distance. This is what the SCHOOL
      // behaviour's 0.3 SEEK multiplier is FOR: cohesion has a 5 m radius and
      // cannot gather a school that has come apart, and a fish that has lost
      // its school swims back to it rather than forgetting it existed.
      const s = this.schoolId[i] >= 0 ? (this.schoolId[i] & SCHOOL_MASK) : -1;
      if (s >= 0 && this.schoolCount[s] > 1) {
        vec3.set(out, this.schoolX[s], this.schoolY[s], this.schoolZ[s]);
        return true;
      }
    }
    if (b === BEHAVIOUR.INVESTIGATE) {
      const c = this._ctx;
      if (this.distToVessel[i] < this.distToPlayer[i] && c.vesselPos) {
        vec3.copy(out, c.vesselPos); return true;
      }
      if (c.playerPos) { vec3.copy(out, c.playerPos); return true; }
      return false;
    }
    // FOLLOW_LIGHT folds into the phototropes' FORAGE and IDLE: a positive
    // light affinity with a lamp in range pulls the animal toward the lamp.
    const aff = this._effectiveLightAffinity(i);
    if (aff > 0 && this.lightLux[i] > LUX_SAT * 0.02 && this._ctx.vesselPos) {
      vec3.copy(out, this._ctx.vesselPos);
      return true;
    }
    if (aff < 0 && this.lightLux[i] > LUX_SAT * 0.05 && this._ctx.vesselPos) {
      // Photophobes seek AWAY: the target is the animal's own position pushed
      // one lamp-distance along an escape direction, which is a seek that
      // behaves as a flee without needing the FLEE weight to be non-zero.
      //
      // IT IS THE SAME TANGENTIAL ESCAPE AS THE FLEE STEER'S PLAYER BRANCH, AND
      // FOR THE SAME REASON. This used to be the reflection of the lamp through
      // the agent, `2 * pos - vesselPos`, which is exactly radially away - so it
      // pinned a photophobe's tail to the sub independently of the FLEE term and
      // out to c.vesselLightRange, up to 165 m with the flood on. Fixing only
      // the FLEE block would have left the whole bug intact the moment the
      // player boarded. See PLAYER_FLEE_RADIAL_FRAC.
      const dx = this.posX[i] - this._ctx.vesselPos[0];
      const dy = this.posY[i] - this._ctx.vesselPos[1];
      const dz = this.posZ[i] - this._ctx.vesselPos[2];
      const d = len3(dx, dy, dz);
      if (d > 1e-4) {
        const invD = 1 / d;
        const ax = dx * invD, ay = dy * invD, az = dz * invD;
        this._escapeDirection(i, ax, ay, az, _dir);
        out[0] = this.posX[i] + _dir[0] * d;
        out[1] = this.posY[i] + _dir[1] * d;
        out[2] = this.posZ[i] + _dir[2] * d;
      } else {
        // Coincident with the lamp, which needs the hull to be inside the
        // animal. There is no away direction to compute, so pick one: a metre
        // of +X is a valid seek target and an unchanged position is not.
        out[0] = this.posX[i] + 1; out[1] = this.posY[i]; out[2] = this.posZ[i];
      }
      return true;
    }
    // Everything else arrives at home, which for a shoaling fish is the
    // school's spawn anchor and for a territorial one is its territory.
    vec3.set(out, this.homeX[i], this.homeY[i], this.homeZ[i]);
    return true;
  }

  /**
   * Obstacle avoidance: five forward probes against the heightfield plus a
   * hard push-out when the animal is already too close to the ground.
   *
   * The probe is `y_probe < terrainHeight(x_probe, z_probe) + clearance`,
   * which for a heightfield answers exactly the question the design's
   * sphere-traced whisker answers, in one sample. The urgency is squared so a
   * distant wall barely deflects and a close one dominates.
   */
  _avoid(i, speed, vMax, lodClass) {
    const col = this.collision;
    if (!col) return;
    const a = ARCHETYPES[this.archetype[i]];
    const x = this.posX[i], y = this.posY[i], z = this.posZ[i];
    const clearance = Math.max(CLEARANCE_MIN, this.bodyLength[i] * CLEARANCE_BODY_LENGTHS);
    const look = clamp(a.la[0] * speed, a.la[1], a.la[2]);
    this._forwardOf(i, _fwd);

    let ax = 0, ay = 0, az = 0;
    // REDUCED and STATISTICAL agents use the centre whisker only: four extra
    // height samples per agent is the single biggest cost in this function and
    // a fish 150 m away that clips a rock for one frame is invisible.
    const whiskers = lodClass === CREATURE_LOD.FULL ? 5 : 1;
    const dxz = len2(_fwd[0], _fwd[2]) || 1e-4;
    const rx = -_fwd[2] / dxz, rz = _fwd[0] / dxz;

    // A CAVE INTERIOR IS BELOW THE HEIGHTFIELD ON PURPOSE, and the heightfield
    // arithmetic below cannot know it. An agent inside a carved void reads as
    // 60-160 m "buried": every whisker fires (py < h + clearance always) and
    // the hard push-out saturates, so the whole steering blend becomes one
    // permanent shove along the SURFACE normal - straight into the cave roof.
    // When the collision world carries the cave field (col.caves, wired by
    // main.js setCaveField; null in every offline suite that never set it, so
    // those run byte-identical), an agent under the surface but inside a void
    // switches to probing the volumetric field instead: caveDensity is signed
    // metres to rock, so `d < clearance` is the same question the heightfield
    // gap asks. Whisker deflection is along the REVERSED whisker rather than
    // a field normal - caveNormal costs six field evaluations per call, and
    // "back away from the rock you are pointed at" is what a whisker means.
    // Cost: only agents below the heightfield ever pay the void query, i.e.
    // exactly the cave population (a few dozen at most).
    const hHere = col.heightAt(x, z);
    const caves = col.caves || null;
    const inCave = caves !== null && y < hHere && caves.caveVoidAt(x, y, z) > 0;
    if (inCave) {
      for (let k = 0; k < whiskers; k++) {
        const cy = Math.cos(WHISKER_YAW[k]), sy = Math.sin(WHISKER_YAW[k]);
        const cp = Math.cos(WHISKER_PITCH[k]), sp = Math.sin(WHISKER_PITCH[k]);
        const dx = (_fwd[0] * cy + rx * sy) * cp;
        const dz = (_fwd[2] * cy + rz * sy) * cp;
        const dy = _fwd[1] * cp + sp;
        const reach = Math.min(look * (k === 0 ? 1.0 : 0.72), 12);
        const d = caves.caveDensity(x + dx * reach, y + dy * reach, z + dz * reach);
        if (d >= clearance) continue;
        const urgency = saturate(1 - Math.max(d, 0) / clearance);
        const g = urgency * urgency * WHISKER_GAIN[k];
        ax -= dx * g; ay -= dy * g; az -= dz * g;
      }
      // Hard push-out along the field's own outward normal when the body is
      // already against the wall - the one place the normal is worth its six
      // samples, because there is no whisker direction to reverse.
      const d0 = caves.caveDensity(x, y, z);
      if (d0 < clearance) {
        caves.caveNormal(_normal, x, y, z);
        const g = 3.0 * saturate((clearance - d0) / Math.max(clearance, 0.1));
        ax += _normal[0] * g; ay += _normal[1] * g; az += _normal[2] * g;
      }
      if (ax !== 0 || ay !== 0 || az !== 0) {
        const o = STEER.OBSTACLE * 3;
        _blend[o] = ax * vMax;
        _blend[o + 1] = ay * vMax;
        _blend[o + 2] = az * vMax;
      }
      return;
    }

    for (let k = 0; k < whiskers; k++) {
      const cy = Math.cos(WHISKER_YAW[k]), sy = Math.sin(WHISKER_YAW[k]);
      const cp = Math.cos(WHISKER_PITCH[k]), sp = Math.sin(WHISKER_PITCH[k]);
      const dx = (_fwd[0] * cy + rx * sy) * cp;
      const dz = (_fwd[2] * cy + rz * sy) * cp;
      const dy = _fwd[1] * cp + sp;
      const reach = look * (k === 0 ? 1.0 : 0.72);
      const px = x + dx * reach, py = y + dy * reach, pz = z + dz * reach;
      const h = col.heightAt(px, pz);
      const gap = py - h - clearance;
      if (gap >= 0) continue;
      // t: how far along the whisker the surface was met. Derived from the
      // gap rather than measured, because a heightfield probe has no hit
      // distance - and the linear estimate is exact for a planar slope.
      const urgency = saturate(1 - Math.max(0, gap + clearance) / Math.max(reach, 1e-3));
      col.normalAt(_normal, px, pz);
      const g = urgency * urgency * WHISKER_GAIN[k];
      ax += _normal[0] * g; ay += _normal[1] * g; az += _normal[2] * g;
    }

    // Hard push-out. An agent inside the clearance envelope gets a force three
    // times the whisker gain regardless of where it is looking - this is what
    // stops a spawn on a steep wall from tunnelling into the rock.
    // (hHere was sampled above, ahead of the cave branch.)
    const gapHere = y - hHere - clearance;
    if (gapHere < 0) {
      col.normalAt(_normal, x, z);
      const g = 3.0 * saturate(-gapHere / Math.max(clearance, 0.1));
      ax += _normal[0] * g; ay += _normal[1] * g; az += _normal[2] * g;
    }

    // The surface is an obstacle too, for anything that is not airborne: a
    // 30 m leviathan must not breach through the ceiling of its own band.
    if (!IS_AIRBORNE[this.archetype[i]]) {
      const sub = -y - clearance;
      if (sub < 0) ay -= 3.0 * saturate(-sub / Math.max(clearance, 0.1));
    }

    if (ax !== 0 || ay !== 0 || az !== 0) {
      const o = STEER.OBSTACLE * 3;
      // NOT velocity-relative: this force must dominate the blend, and
      // subtracting the velocity is exactly what would let the velocity that
      // is about to hit the rock cancel the force that avoids it.
      _blend[o] = ax * vMax;
      _blend[o + 1] = ay * vMax;
      _blend[o + 2] = az * vMax;
    }
  }

  /**
   * How hard the animal is currently propelling itself, 0..1. Scales the
   * thrust that cancels drag, so a value below 1 means the animal is coasting.
   */
  _swimEffort(i) {
    // The C-start is a pure body bend with no translation: DESIGN/06.1.4's
    // FL_STARTLE is a visual tell, and an animal that lurched forward during it
    // would give the player no warning at all.
    if (this.behaviour[i] === BEHAVIOUR.FLEE && this.state[i] === FLEE_STATE.STARTLE) return 0;
    // A resting animal holds station, nothing more.
    if (this.behaviour[i] === BEHAVIOUR.REST) return 0.15;
    // Jellies and siphonophores pulse and then coast, which is exactly why they
    // bob rather than glide. Partial thrust reproduces that from the drag term
    // alone, with no per-pulse state.
    if (this.archetype[i] === ARCHETYPE.DRIFTER) return 0.35;
    return 1;
  }

  /** Speed cap for the current behaviour and state. */
  _maxSpeed(i) {
    const sp = this.species[i];
    const base = SPECIES_TABLE.speedBase[sp];
    const burst = SPECIES_TABLE.speedBurst[sp];
    const b = this.behaviour[i];
    if (b === BEHAVIOUR.ATTACK) {
      switch (this.state[i]) {
        case ATTACK_STATE.APPROACH: return 0.72 * burst;
        case ATTACK_STATE.WINDUP: return 0.25 * burst;
        case ATTACK_STATE.LUNGE: return burst;
        case ATTACK_STATE.CONTACT: return burst * 0.5;
        case ATTACK_STATE.RECOVER: return base * 1.1;
        default: return base * 1.4;
      }
    }
    if (b === BEHAVIOUR.FLEE) {
      switch (this.state[i]) {
        case FLEE_STATE.STARTLE: return base * 0.1;   // the C-start does not translate
        case FLEE_STATE.BURST: return burst;
        case FLEE_STATE.SUSTAIN: return base * 1.25;
        default: return base;
      }
    }
    if (b === BEHAVIOUR.REST) return base * 0.25;
    if (b === BEHAVIOUR.STALK) return base * 0.8;
    if (b === BEHAVIOUR.FEED) return base * 0.3;
    // A hungry animal cruises faster. Energy 0 -> 1.15x base, energy 1 -> 0.9x.
    return base * (0.90 + 0.25 * (1 - this.energy[i]));
  }

  // -------------------------------------------------------------------------
  // L1 locomotion (DESIGN/06.1.6)
  // -------------------------------------------------------------------------

  /**
   * Integrate one agent.
   *
   * FULL agents get the dynamic model - steering plus quadratic drag plus
   * buoyancy - because it is what makes a large animal coast and a small one
   * stop dead. REDUCED and STATISTICAL agents get the kinematic model, which
   * is the same trajectory without the drag term and costs a third as much.
   *
   * The turn-rate limit is applied to the HEADING, and the speed is then
   * re-projected onto it: fish do not slide sideways, and letting them is the
   * single most obvious way for steered agents to read as physics props.
   */
  _locomote(i, dt, lodClass) {
    const sp = this.species[i];
    const st = SPECIES_TABLE;
    const a = ARCHETYPES[this.archetype[i]];
    const vMax = this._maxSpeed(i);

    let ax = this.steerX[i], ay = this.steerY[i], az = this.steerZ[i];

    if (lodClass === CREATURE_LOD.FULL) {
      const vx = this.velX[i], vy = this.velY[i], vz = this.velZ[i];
      const speed = len3(vx, vy, vz);
      const L = this.bodyLength[i];
      const mass = st.mass[sp] * this.scale[i] * this.scale[i] * this.scale[i];
      // Aref = 0.72 * width * height, both derived from the archetype aspect.
      const aref = 0.72 * (L * a.aspect[0]) * (L * a.aspect[1]);
      const airborne = IS_AIRBORNE[this.archetype[i]] || this.posY[i] > 0;
      const rho = airborne ? WORLD.AIR_DENSITY : WORLD.WATER_DENSITY;
      // F_drag = -0.5 rho Cd Aref |v| v / m. Written as a scalar coefficient
      // times the velocity so it is three multiplies rather than a normalise.
      const k = 0.5 * rho * a.cd * aref * speed / Math.max(mass, 1e-4);
      ax -= vx * k; ay -= vy * k; az -= vz * k;

      // THRUST. A swimming animal is not a projectile: its propulsion is what
      // holds it at cruise, and at STEADY cruise thrust exactly equals drag.
      // Applying drag without that thrust is the single easiest way to get this
      // model wrong, and it was wrong: a 0.29 m Silverquill at 1.6 m/s has a
      // drag deceleration of 1.8 m/s^2 against the 0.2 m/s^2 its schooling
      // forces produce, so a measured school decayed from 1.60 m/s to 0.03 m/s
      // in fifteen seconds and stopped schooling because nothing was moving.
      //
      // Thrust therefore acts along the HEADING with the same magnitude as
      // drag, scaled by `effort`. What survives is exactly the part of drag
      // that should: the LATERAL component, so a hard turn costs speed, and
      // the full drag of an animal that has stopped swimming.
      const effort = this._swimEffort(i);
      if (effort > 0 && speed > 1e-4) {
        this._forwardOf(i, _tmp);
        const thrust = k * speed * effort;
        ax += _tmp[0] * thrust; ay += _tmp[1] * thrust; az += _tmp[2] * thrust;
      }

      // Buoyancy: (buoyRatio - 1) * -g. A ratio below 1 sinks, above 1 rises.
      // Out of the water there is no buoyancy, only weight.
      ay += airborne && !IS_AIRBORNE[this.archetype[i]]
        ? -WORLD.GRAVITY
        : (a.buoy - 1) * -WORLD.GRAVITY;
    }

    let vx = this.velX[i] + ax * dt;
    let vy = this.velY[i] + ay * dt;
    let vz = this.velZ[i] + az * dt;
    let speed = len3(vx, vy, vz);
    if (speed > vMax && speed > 1e-6) {
      const s = vMax / speed; vx *= s; vy *= s; vz *= s; speed = vMax;
    }

    // ---- heading, turn-rate limited ------------------------------------
    this._forwardOf(i, _fwd);
    let yawRate = 0;
    if (speed > 1e-4) {
      vec3.set(_dir, vx / speed, vy / speed, vz / speed);
      const dot = clamp(vec3.dot(_fwd, _dir), -1, 1);
      const ang = Math.acos(dot);
      const maxAng = st.turnRate[sp] * dt;
      if (ang > maxAng && ang > 1e-5) {
        // Rotate forward toward the desired direction by maxAng only.
        const t = maxAng / ang;
        vec3.lerp(_tmp, _fwd, _dir, t);
        vec3.normalize(_dir, _tmp);
      }
      // Signed yaw rate about world up, for the body bend and the bank.
      const h0 = Math.atan2(_fwd[0], -_fwd[2]);
      const h1 = Math.atan2(_dir[0], -_dir[2]);
      yawRate = wrapAngle(h1 - h0) / Math.max(dt, 1e-4);
      // Fish do not slide sideways: the velocity is re-projected onto the
      // (turn-limited) heading, so a hard turn costs speed exactly as it does
      // for a real animal.
      vx = _dir[0] * speed; vy = _dir[1] * speed; vz = _dir[2] * speed;
      quat.lookRotation(_quat, _dir);
    } else {
      // Stationary: keep the current orientation. Indexed rather than
      // subarray'd because subarray allocates and this runs per agent per tick.
      const o = i * 4;
      _quat[0] = this.orient[o]; _quat[1] = this.orient[o + 1];
      _quat[2] = this.orient[o + 2]; _quat[3] = this.orient[o + 3];
    }

    // ---- bank into the turn --------------------------------------------
    // bank = atan2(v * omega, g), the coordinated-turn relation: the roll that
    // puts the resultant of gravity and centripetal acceleration through the
    // animal's own vertical. Clamped to the archetype's rollMax.
    const bankTarget = clamp(Math.atan2(speed * yawRate, WORLD.GRAVITY), -a.rollMax, a.rollMax);
    this.bank[i] += (bankTarget - this.bank[i]) * (1 - Math.exp(-6 * dt));
    // The visible roll is applied on the GPU, so the stored quaternion stays
    // the pure heading and the bank travels as a scalar. That keeps the
    // orientation usable for AI (forward is forward) and lets the shader
    // distribute the roll along the spine rather than rotating the whole body.
    this.orient[i * 4] = _quat[0]; this.orient[i * 4 + 1] = _quat[1];
    this.orient[i * 4 + 2] = _quat[2]; this.orient[i * 4 + 3] = _quat[3];
    this.yawRate[i] = yawRate;

    // ---- integrate position --------------------------------------------
    let x = this.posX[i] + vx * dt;
    let y = this.posY[i] + vy * dt;
    let z = this.posZ[i] + vz * dt;

    // NaN barrier before the clamp, so a non-finite value is replaced rather
    // than clamped into a legal-looking corner of the world.
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) {
      x = this.homeX[i]; y = this.homeY[i]; z = this.homeZ[i];
      vx = 0; vy = 0; vz = 0;
    }
    if (!(Number.isFinite(vx) && Number.isFinite(vy) && Number.isFinite(vz))) {
      vx = 0; vy = 0; vz = 0;
    }

    // ---- hard containment ----------------------------------------------
    // The soft boundary force turns an agent around; this is the guarantee.
    // It exists because the soft force is a FORCE: a leviathan at 3.5 m/s^2
    // aMax being flung out of the world by a separation impulse from another
    // leviathan is a real, reachable state, and one escaped agent is a
    // creature that never comes back and a hash bucket that never clears.
    if (x < -XZ_LIMIT) { x = -XZ_LIMIT; if (vx < 0) vx = -vx * 0.3; }
    else if (x > XZ_LIMIT) { x = XZ_LIMIT; if (vx > 0) vx = -vx * 0.3; }
    if (z < -XZ_LIMIT) { z = -XZ_LIMIT; if (vz < 0) vz = -vz * 0.3; }
    else if (z > XZ_LIMIT) { z = XZ_LIMIT; if (vz > 0) vz = -vz * 0.3; }
    if (y < Y_FLOOR) { y = Y_FLOOR; if (vy < 0) vy = 0; }
    else if (y > Y_CEILING) { y = Y_CEILING; if (vy > 0) vy = 0; }

    // Grounded archetypes are clamped to the surface, DESIGN/06.1.7 footnote.
    if (IS_GROUNDED[this.archetype[i]] && this.collision) {
      const h = this.collision.heightAt(x, z);
      const foot = this.bodyLength[i] * 0.22;
      if (y < h + foot) { y = h + foot; if (vy < 0) vy = 0; }
    }

    this.posX[i] = x; this.posY[i] = y; this.posZ[i] = z;
    this.velX[i] = vx; this.velY[i] = vy; this.velZ[i] = vz;
    this.hash.insert(i, x, y, z);
  }

  // -------------------------------------------------------------------------
  // L0 animation state (the wave itself lives in creature.wgsl)
  // -------------------------------------------------------------------------

  /**
   * Advance the swim phase and the scalar animation channels the vertex
   * shader consumes.
   *
   * The phase is integrated rather than derived from absolute time because the
   * FREQUENCY changes: `phase = 2*pi*f*t` with a varying f produces a visible
   * jump every time f moves, while `phase += 2*pi*f*dt` is continuous. This is
   * the classic phase-accumulator argument and it matters here because f
   * triples between cruise and burst.
   */
  _animate(i, dt) {
    // The wave parameters are the SPECIES' resolved row, not the archetype's:
    // SPECIES_TABLE.swimAnim defaults from the archetype and one record
    // overrides it (see the field's docstring, and LEV_SPLITMAW in bestiary.js).
    const sa = SPECIES_TABLE.swimAnim;
    const so = this.species[i] * SWIM_ANIM_STRIDE;
    const L = Math.max(this.bodyLength[i], 1e-3);
    const speed = len3(this.velX[i], this.velY[i], this.velZ[i]);
    const U = speed / L;                                  // body lengths per second
    const f = clamp(sa[so + SWIM_ANIM.f0] + sa[so + SWIM_ANIM.kf] * U,
      sa[so + SWIM_ANIM.fMin], sa[so + SWIM_ANIM.fMax]);   // Hz
    this.phase[i] = (this.phase[i] + TAU * f * dt) % TAU;

    // Body bend into the turn. Negative because a right turn (positive yaw
    // rate in a clockwise-positive heading convention) bends the body left.
    const bendMax = sa[so + SWIM_ANIM.bendMax];
    const bendTarget = clamp(-this.yawRate[i] * 0.35, -bendMax, bendMax);
    this.bendTurn[i] += (bendTarget - this.bendTurn[i]) * (1 - Math.exp(-9 * dt));

    // Jaw. DESIGN/06.3.4's J(tau) schedule, evaluated on the CPU because it is
    // one scalar per agent and the shader would need the whole FSM to do it.
    let jaw = 0.04 + 0.03 * Math.sin(this.phase[i] * 0.25);
    const b = this.behaviour[i];
    if (b === BEHAVIOUR.ATTACK) {
      const t = this.stateT[i];
      const tier = this.tier[i];
      switch (this.state[i]) {
        case ATTACK_STATE.WINDUP:
          jaw = smoothstep(0, 1, t / Math.max(T_WINDUP[tier], 1e-3)) * 0.30;
          break;
        case ATTACK_STATE.LUNGE:
          jaw = 0.30 + 0.70 * smoothstep(0, 1, t / Math.max(0.55 * T_LUNGE[tier], 1e-3));
          break;
        case ATTACK_STATE.CONTACT:
          jaw = 1.0 - smoothstep(0, 1, t / 0.06);
          break;
        default:
          jaw = 0.12;
          break;
      }
    } else if (b === BEHAVIOUR.FEED) {
      jaw = 0.45 + 0.25 * Math.sin(this.phase[i] * 1.6);
    }
    this.jawOpen[i] += (jaw - this.jawOpen[i]) * (1 - Math.exp(-14 * dt));
  }

  // -------------------------------------------------------------------------
  // Interactions
  // -------------------------------------------------------------------------

  /** Cooldowns tick down, and predator-vs-predator standoffs resolve. */
  _resolveInteractions(dt) {
    const live = this.liveSlots();
    for (let k = 0; k < live.length; k++) {
      const i = live[k];
      const base = i * BEHAVIOUR_COUNT;
      for (let b = 0; b < BEHAVIOUR_COUNT; b++) {
        const c = this.cooldown[base + b];
        if (c > 0) this.cooldown[base + b] = Math.max(0, c - dt);
      }
    }
  }

  /**
   * Resolve one strike at AT_CONTACT. Exactly one damage application per
   * attack cycle, which is what makes the telegraph contract meaningful.
   */
  _resolveStrike(i) {
    const sp = this.species[i];
    const st = SPECIES_TABLE;
    const strikeR = this.bodyLength[i] * 1.4 + 1.0;
    const dist = this._targetDistance(i);
    if (dist > strikeR * 1.6) return;    // the lunge missed

    const kind = this.targetKind[i];
    if (kind === TARGET.CREATURE) {
      const j = this.slotOf(this.targetId[i]);
      if (j < 0) return;
      // DESIGN/06.7.2's hit probability. Schooling really does confuse a
      // predator, and a surprised animal really is easier to catch.
      const predSpeed = len3(this.velX[i], this.velY[i], this.velZ[i]);
      const preySpeed = len3(this.velX[j], this.velY[j], this.velZ[j]);
      const surprised = this.threat[j] < T_NOTICE ? 1 : 0;
      const schooling = this.schoolId[j] >= 0 ? 1 : 0;
      const pHit = clamp(0.55
        + 0.30 * (predSpeed / Math.max(predSpeed + preySpeed, 1e-3))
        + 0.20 * surprised
        - 0.25 * schooling, 0.05, 0.95);
      if (this.rng() >= pHit) return;
      // Creature-vs-creature damage is doubled: a predation attempt that took
      // a full telegraphed cycle should usually finish the job, or the food
      // web never turns over.
      const dmg = Math.max(1, st.damage[sp] * 2.0 + this.hpMax[j] * 0.35);
      const preyMass = st.mass[this.species[j]];
      const predMass = st.mass[sp];
      const killed = this.damage(this.handleOf(j), dmg, 'creature');
      this.stats.predations++;
      if (killed) {
        this.energy[i] = Math.min(1, this.energy[i] + saturate(preyMass / predMass) * 4);
        this.flags[i] |= 2;    // fed: the selector will move to FEED
      }
      events.emit(EVENTS.CREATURE_ATTACK, {
        id: this.handleOf(i), species: st.id[sp], target: 'creature',
        damage: dmg, position: this._pointOf(i),
      });
      return;
    }

    if (kind === TARGET.VESSEL) {
      const v = this._ctx.vessel;
      if (!v || !v.damageHull) return;
      const amount = st.hullDamage[sp];
      if (amount > 0) {
        v.damageHull(amount, st.id[sp]);
        this.stats.vesselBites++;
      }
      events.emit(EVENTS.CREATURE_ATTACK, {
        id: this.handleOf(i), species: st.id[sp], target: 'vessel',
        damage: amount, position: this._pointOf(i),
      });
      return;
    }

    if (kind === TARGET.PLAYER) {
      // ENFORCEMENT LEVEL 3 of the Safe Charter lives in the spawner, which
      // owns the volume definition; the sim asks it. With no spawner attached
      // (offline tests) the veto defaults to allowing damage, because the
      // spawner is also the only thing that could have put a tier > 0 animal
      // near the player in the first place.
      if (this.damageVeto && this.damageVeto(this.posX[i], this.posY[i], this.posZ[i])) return;
      const amount = st.damage[sp];
      if (amount <= 0) return;
      const onDamage = this.onPlayerDamage;
      if (onDamage) {
        this._forwardOf(i, _fwd);
        onDamage(amount, st.id[sp], _fwd);
      }
      events.emit(EVENTS.CREATURE_ATTACK, {
        id: this.handleOf(i), species: st.id[sp], target: 'player',
        damage: amount, position: this._pointOf(i),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Neighbours of slot `i` within `radius`, into `_neighbours`. */
  _queryNeighbours(i, radius) {
    const r = Math.min(radius, NEIGHBOUR_MAX_RADIUS);
    if (!(r > 0)) return 0;
    const n = this.hash.queryRadius(this.posX[i], this.posY[i], this.posZ[i], r,
      _neighbours, MAX_NEIGHBOURS);
    this.stats.neighbourQueries++;
    this.stats.neighboursFound += n;
    return n;
  }

  _distBetween(i, j) {
    return len3(this.posX[i] - this.posX[j],
      this.posY[i] - this.posY[j], this.posZ[i] - this.posZ[j]);
  }

  /**
   * Mean distance from each agent to its nearest same-school neighbour, in
   * metres. The schooling metric the test measures before and after.
   * @returns {number} NaN when fewer than two agents share a school
   */
  meanNeighbourDistance() {
    const live = this.liveSlots();
    let sum = 0, n = 0;
    for (let k = 0; k < live.length; k++) {
      const i = live[k];
      if (this.schoolId[i] < 0) continue;
      let best = Infinity;
      for (let m = 0; m < live.length; m++) {
        const j = live[m];
        if (j === i || this.schoolId[j] !== this.schoolId[i]) continue;
        const d = this._distBetween(i, j);
        if (d < best) best = d;
      }
      if (best < Infinity) { sum += best; n++; }
    }
    return n > 0 ? sum / n : NaN;
  }

  /** True if any stored float is non-finite. Used by the test harness. */
  hasNaN() {
    const live = this.liveSlots();
    for (let k = 0; k < live.length; k++) {
      const i = live[k];
      if (!Number.isFinite(this.posX[i]) || !Number.isFinite(this.posY[i]) ||
          !Number.isFinite(this.posZ[i]) || !Number.isFinite(this.velX[i]) ||
          !Number.isFinite(this.velY[i]) || !Number.isFinite(this.velZ[i]) ||
          !Number.isFinite(this.phase[i]) || !Number.isFinite(this.threat[i]) ||
          !Number.isFinite(this.fear[i]) || !Number.isFinite(this.orient[i * 4 + 3])) {
        return true;
      }
    }
    return false;
  }

  /** Slots outside the world containment box. Should always be empty. */
  outOfBounds() {
    const live = this.liveSlots();
    let n = 0;
    for (let k = 0; k < live.length; k++) {
      const i = live[k];
      if (Math.abs(this.posX[i]) > XZ_LIMIT + 0.01 ||
          Math.abs(this.posZ[i]) > XZ_LIMIT + 0.01 ||
          this.posY[i] < Y_FLOOR - 0.01 || this.posY[i] > Y_CEILING + 0.01) n++;
    }
    return n;
  }

  /**
   * Optional hook: the spawner installs this so AT_CONTACT can ask whether
   * the strike position is inside the Safe Charter. Returns true to VETO.
   * @type {((x:number,y:number,z:number)=>boolean)|null}
   */
  damageVeto = null;

  /**
   * Optional hook: main.js installs this so a strike reaches Player.damage()
   * without creatures.js importing the player.
   * @type {((amount:number, source:string, direction:ArrayLike<number>)=>void)|null}
   */
  onPlayerDamage = null;
}

/** World containment box, exported so the spawner and the tests agree on it. */
export const CREATURE_BOUNDS = Object.freeze({
  xzLimit: XZ_LIMIT, yFloor: Y_FLOOR, yCeiling: Y_CEILING,
});
