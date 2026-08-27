/**
 * Developer teleport: move whoever the player is inhabiting to an arbitrary
 * place in the world, and invalidate every piece of frame history that assumed
 * they got there by travelling.
 *
 * This lives in `entities/` rather than `core/` because it orchestrates the
 * player and the vessel and reaches the collision world, and `core/` imports
 * nothing from `world/` or `entities/` - putting it there would invert the
 * layering. It also keeps the module node-safe: `tools/test-jump.mjs` builds a
 * real CollisionWorld, Player and Vessel with no GPU and no DOM, which is what
 * lets the field-by-field state write be tested offline in milliseconds.
 *
 * Nothing here touches the world clock or the weather. A jump is a change of
 * PLACE only.
 */

import { vec3, clamp, headingFromDir } from '../core/math.js';
import { WORLD, PLAYER, VESSEL } from '../core/constants.js';
import { waterTypeAt } from '../world/biomes.js';
import { PLAYER_STATE } from './player.js';

/**
 * THE ARRIVAL IS FRAMED AGAINST THE VEIL, NOT AGAINST THE BEAM.
 *
 * The eye height and the aim distance used to be metres - a 6 m hover and a
 * 25 m aim - and one pair of metres cannot serve this ocean. Expressed in
 * optical depths of each water's beam extinction, the shipped 25 m was 1.04
 * optical depths in OCEANIC_CLEAR, 2.58 in REEF_TURQUOISE, 9.13 in
 * COASTAL_GREEN and 0.65 in ABYSSAL_VOID: a 14x spread. Measured by
 * ray-marching the real arrival pose over the real 75 deg frame at all fourteen
 * anchors, Coral Garden framed 73.6% geometry at a median 22.2 m where its
 * best-surviving channel is already down to T = 0.101, and Kelp Forest 82.5% at
 * 26.5 m with T_green = 6.3e-5. NOTHING MISSED THE GROUND. The ground was
 * behind ten optical depths of water, and both frames photographed as a flat
 * rectangle of colour.
 *
 * THE RANGE, DERIVED. A target only reads while its own attenuated radiance
 * still beats the veil the path has built up in front of it. For a mid-grey
 * target under the same ambient the signal is exp(-sigmaT*r) and the
 * single-scattered path radiance is (sigmaS/sigmaT)(1 - exp(-sigmaT*r)), so
 * they cross at
 *
 *     R = ln(1 + sigmaT/sigmaS) / sigmaT
 *
 * per channel, with NO fitted constant - which is the whole reason to prefer it
 * to a bare 1/sigmaT. It needs BOTH coefficients, and that is the point: sigmaT
 * alone cannot tell these waters apart. max(sigmaT) spans only 0.236 (abyss) to
 * 0.58 (kelp), a factor of 2.5, so a law built on it is a new global constant
 * wearing a function's clothes - built and photographed, it put every live water
 * type at eye 2.0-3.4 m and aim 8.0-8.5 m. R spans 2.29 to 44.3 m, a factor of
 * 19, which is the spread the pictures actually need.
 *
 * THE CHANNEL IS THE ONE THAT HOLDS CONTRAST LONGEST, and that is a measured
 * decision, not a preference for blue. Framing instead to the channel that dies
 * FIRST - the "so that colour survives" reading, which is red almost everywhere
 * - was built and photographed at all fourteen anchors. It fixes the daylit
 * shallows and it wrecks the deep, because in ABYSSAL_VOID the first channel to
 * die is red (sigmaT 0.236/m against blue's 0.026) and there is no red light at
 * 758 m for a red range to preserve: the hadal anchors are lit by
 * bioluminescence and a lamp. Measured on that build, median framed range fell
 * 14.1 -> 7.0 m at Abyssal Plain and 35.6 -> 14.2 m at the trench floor, and the
 * frames lost most of their emitter field - Trench Wall put a foreground boulder
 * across a quarter of the frame. The deep is monochrome because its LIGHT is
 * monochrome, and no camera placement can put colour back.
 *
 * The two fractions below are the taste half and are calibrated, not derived:
 * they are the values at which OCEANIC_CLEAR reproduces the arrival that
 * photographed best at Shallow Reef, Shelf Break and Rock Spires. Their RATIO is
 * the only thing that sets the pitch - on flat ground it is
 * -atan(EYE_FRAC/AIM_FRAC) = -20.7 deg for EVERY water type, so the water sets
 * the scale of the shot and never its angle.
 *
 * Resulting eye / aim, metres: OCEANIC_CLEAR 3.05 / 8.05, REEF_TURQUOISE
 * 2.00 / 8.00, COASTAL_GREEN 2.00 / 8.00, BRINE 2.00 / 8.00, ABYSSAL_VOID
 * 5.54 / 14.63, MURKY_PARTICULATE and VENT_SMOKE both hard against the floors.
 */
const EYE_FRAC = 0.125;
const AIM_FRAC = 0.33;
/**
 * Metres of eye above the seabed at an underwater arrival on foot.
 *
 * The floor is the diver's own body: PLAYER.EYE_HEIGHT is 1.68, so a 2.0 m
 * hover puts the fins 0.32 m clear, and `deriveY` measures that clearance from
 * `collision.footprintHeight` rather than the centre sample because the
 * footprint runs up to a measured 0.228 m above it (Rock Spires) and the
 * heightfield's underside is back-face culled - a buried eye photographs open
 * water and any test written against that frame goes green. The floor BINDS for
 * every water type but OCEANIC_CLEAR and ABYSSAL_VOID; the ceiling binds for
 * none of them (the largest is ABYSSAL_VOID's 5.54 m) and is there so that
 * authoring a water clearer than any that exists cannot park the eye halfway up
 * the column.
 */
const HOVER_EYE_MIN = 2.0;
const HOVER_EYE_MAX = 6.0;
/**
 * Metres ahead the arrival pitch aims. The floor binds for every water type but
 * ABYSSAL_VOID (14.63 m) and OCEANIC_CLEAR (8.05 m, which is barely off it):
 * inside 8 m the flat-ground pitch -atan(eye/aim) tips the view onto the
 * diver's own fins. The ceiling is the shipped 25 m and no longer binds
 * anywhere; it is kept as a guard for the same reason as HOVER_EYE_MAX.
 */
const AIM_MIN = 8.0;
const AIM_MAX = 25.0;
/**
 * Keep the eye this far under the surface at a shallow arrival. Without it a
 * shallow anchor could put the eye in the air while the water column below says
 * otherwise, and the medium latch would be honest about the wrong thing.
 */
const EYE_SUBMERGE_MARGIN = 1.0;
/** Metres of air under the skids at a land arrival, so the hull settles rather
 *  than starting interpenetrated with the 14-probe contact solver. */
const VESSEL_PARK_CLEARANCE = 2.0;
/** Submerged vessel hover: half the column, floored clear of the 2.6 m hull and
 *  ceilinged so the 12.5 m chase camera still has the seabed in frame. */
const VESSEL_HOVER_MIN = 3.0;
const VESSEL_HOVER_MAX = 14.0;

/**
 * Arrival pitch on DRY LAND, radians, positive up. Air has no beam range worth
 * the name at these distances, so a land arrival keeps a fixed shallow tilt:
 * the island's own relief is the subject and it wants the horizon in shot.
 *
 * Underwater the pitch is AIMED AT THE GROUND rather than fixed, because a
 * fixed angle only frames flat ground. A constant -0.18 rad puts the view ray
 * on a LEVEL seabed at 33 m - but the anchors are not level: Coral Garden sits
 * on slope 0.72 and Rock Spires on 0.85, and looking down-slope there means the
 * terrain FALLS AWAY from the ray. Photographed at a constant pitch, Coral
 * Garden was open blue water with the seabed just off the bottom edge of frame.
 * So `arrivalPitch` samples the height one aim-distance along the arrival
 * heading and looks at it: one extra sampleHeight, self-correcting on any
 * slope, and the aim distance is now the destination water's own (see
 * HOVER_TAU/AIM_TAU), which is what keeps the pitch and the framing consistent.
 */
const ARRIVAL_PITCH_LAND = -0.10;
/**
 * The pitch clamp. The floor BINDS at seven of the twelve underwater anchors
 * now that the aim distance is short - Coral Garden, Kelp Forest, Shelf Break,
 * Rock Spires, Canyon Wall, Trench Wall and the trench floor all want steeper
 * than -0.62 rad - and where it binds the aim distance no longer moves the
 * picture at all; the eye height alone does. That is the correct order of
 * authority: -35.5 deg is already most of the way to the diver's own fins.
 */
const ARRIVAL_PITCH_MIN = -0.62;
const ARRIVAL_PITCH_MAX = -0.05;

/**
 * How far ABOVE the sampled ground point the arrival actually looks, radians.
 *
 * `arrivalPitch` aims at the seabed one aim-distance ahead, and aiming there
 * exactly puts the ground on the frame's CENTRE line - which on any downslope
 * fills the whole frame with floor and throws away the water column, where the
 * animals and the tall flora are. Measured at the Kelp Forest anchor: the raw
 * ground pitch hit the -0.62 rad clamp, i.e. **-35.5 degrees**, with 174 agents
 * inside 20 m and **6 of them visible**; the near-field director's hero slot
 * aims its one guaranteed large animal within +/-20 degrees of the horizon, and
 * only 55% of that band was inside the frustum at that attitude.
 *
 * 0.22 rad = 12.6 degrees, which against this camera's 75 degree fovY puts the
 * sampled ground point about a third of the way up from the bottom edge - the
 * standard horizon-on-the-lower-third framing, and the same composition the
 * art-direction reference frames use. It is applied BEFORE the clamp, so a
 * genuine wall still pins at the limit.
 */
const GROUND_LINE_LIFT = 0.22;

/** Out-first scratch: a jump can be hammered from a menu, and the project's
 *  rule is that no per-call path allocates. */
const _normal = vec3.create();
const _dir = vec3.create();
const _eye = vec3.create();

/**
 * Lowest suit tier rated for a depth.
 *
 * PLAYER.SUIT_DEPTH_TIERS is [60, 200, 500, 900, 1600] m. Eight of the fourteen
 * biome anchors are deeper than the tier-0 rating, and _updatePressure saturates
 * at 90 dps - a tier-0 suit at 700 m spends all of MAX_HEALTH in 1.11 s, fires
 * _die() and respawns the player on the beach. So a jump that did not grant this
 * would simply bounce off every destination worth looking at.
 *
 * @param {number} depth metres, positive down
 * @returns {number} index into PLAYER.SUIT_DEPTH_TIERS
 */
export function suitTierForDepth(depth) {
  const tiers = PLAYER.SUIT_DEPTH_TIERS;
  for (let i = 0; i < tiers.length; i++) if (depth <= tiers[i]) return i;
  return tiers.length - 1;
}

/**
 * The largest tank, whenever the destination is deep enough to need one.
 *
 * A ONE-SHOT REFILL IS NOT ENOUGH, because oxygen is a RATE and not a threshold,
 * and this is the half of the gear grant that a crush-depth analogy misses.
 * `oxygenDepthMultiplier` saturates at 3.2, so the tier-0 90 s tank is 28 s of
 * gas anywhere below about 500 m. Measured on the real Player at the 12
 * underwater anchors with a tier-0 tank: NINE of them drown the diver, from
 * 89.0 s at Rock Spires down to 38.3 s at the trench floor - which is to say the
 * destinations this menu exists to show were a death sentence you arrived at
 * with full health.
 *
 * The top tier is 420 s, i.e. 131 s at the saturated rate. That is long enough
 * to look around, take a screenshot and jump again, which is the whole job. It
 * is deliberately not infinite: survival still runs, it just stops being the
 * thing that decides whether the tool works.
 *
 * @param {number} depth metres, positive down
 * @returns {number} index into PLAYER.OXYGEN_TIERS
 */
export function oxygenTierForDepth(depth) {
  return depth > 0 ? PLAYER.OXYGEN_TIERS.length - 1 : 0;
}

/**
 * Lowest hull tier rated for a depth.
 *
 * VESSEL.DEPTH_RATINGS is [220, 500, 900, 1300, 1650] m, and the hull is crushed
 * harder than the diver: `OVERDEPTH_DPS * ((depth - rating)/100)^1.60` is
 * 9.0 * 10.99^1.60 = 417 dps at the trench floor against MAX_HULL of 100, so a
 * tier-0 hull there is gone in 0.24 s - four times faster than the player dies.
 *
 * @param {number} depth metres, positive down
 * @returns {number} index into VESSEL.DEPTH_RATINGS
 */
export function hullTierForDepth(depth) {
  const tiers = VESSEL.DEPTH_RATINGS;
  for (let i = 0; i < tiers.length; i++) if (depth <= tiers[i]) return i;
  return tiers.length - 1;
}

/** Tokens that are unambiguously a number. */
const NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * Parse a coordinate string typed into the jump menu.
 *
 * Accepts "x z", "x, z", "x y z" and "(2456, -1319, 2160)" with any whitespace.
 * Brackets and commas are stripped rather than rejected because the two things a
 * developer actually pastes are the #stats readout and a row out of this very
 * menu.
 *
 * Every token is matched against NUMBER_RE rather than handed to Number(),
 * because Number('') is 0, Number('0x10') is 16 and Number(' ') is 0 - all three
 * would silently place the player somewhere nobody asked for.
 *
 * @param {string} text
 * @returns {{x: number, y: number|null, z: number}|null} null if unparseable
 */
export function parseCoords(text) {
  const parts = String(text ?? '').replace(/[(),[\]]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 2 && parts.length !== 3) return null;
  for (const p of parts) if (!NUMBER_RE.test(p)) return null;
  const n = parts.map(Number);
  for (const v of n) if (!Number.isFinite(v)) return null;
  return parts.length === 2
    ? { x: n[0], y: null, z: n[1] }
    : { x: n[0], y: n[1], z: n[2] };
}

/**
 * Is this somewhere the world will actually hold you?
 *
 * The playfield is a SQUARE of half-extent 3072 and the world is a DISC:
 * `collision.boundaryFactor` smoothsteps from SOFT_BOUNDARY (2900) to
 * HARD_BOUNDARY (3050) and pushes you back in over that band. Past the hard
 * radius is a rejection; inside the band is a warning, not a rejection, so that
 * "why am I being pushed back" never has to be asked.
 *
 * @param {number} x @param {number} z
 * @returns {{ok: boolean, reason: string, warn: string}}
 */
export function validateTarget(x, z) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    return { ok: false, reason: 'coordinates must be finite', warn: '' };
  }
  if (Math.abs(x) > WORLD.HALF_EXTENT || Math.abs(z) > WORLD.HALF_EXTENT) {
    return { ok: false, reason: `outside the +/-${WORLD.HALF_EXTENT} m playfield`, warn: '' };
  }
  const r = Math.hypot(x, z);
  if (r > WORLD.HARD_BOUNDARY) {
    return { ok: false, reason: `radius ${r.toFixed(0)} m is past the ${WORLD.HARD_BOUNDARY} m world edge`, warn: '' };
  }
  if (r > WORLD.SOFT_BOUNDARY) {
    return { ok: true, reason: '', warn: `radius ${r.toFixed(0)} m is inside the boundary push-back` };
  }
  return { ok: true, reason: '', warn: '' };
}

/**
 * Arrival heading: face DOWN-SLOPE.
 *
 * For a heightfield y = h(x, z) the surface normal is proportional to
 * (-dh/dx, 1, -dh/dz), so the horizontal part (n.x, n.z) already points downhill
 * - the gradient with its sign flipped by the normal's own construction. Facing
 * that way puts the relief in frame, which is what "show me this biome" means.
 *
 * Flat ground has no downhill (Abyssal Plain measures slope 0.01, so the normal
 * is (0, 1, 0) to within noise). There the fallback faces the island, which is
 * deterministic and puts the world's large-scale structure in frame instead of
 * empty water.
 *
 * @param {object} terrain the terrain module
 * @param {number} x @param {number} z
 * @returns {number} compass heading, radians
 */
function arrivalHeading(terrain, x, z) {
  terrain.sampleNormal(_normal, x, z);
  const flat = Math.hypot(_normal[0], _normal[2]);
  if (flat > 1e-3) {
    vec3.set(_dir, _normal[0], 0, _normal[2]);
  } else if (Math.hypot(x, z) > 1e-3) {
    vec3.set(_dir, -x, 0, -z);
  } else {
    // Dead centre of a perfectly flat world. Face north; anything is arbitrary
    // here and a constant is at least reproducible.
    return 0;
  }
  return headingFromDir(_dir);
}

/**
 * How far this destination's water lets the arrival frame, in metres.
 *
 * ONE call, at the arrival column, feeding BOTH the eye height and the aim
 * distance - they have to agree, because the pitch is atan(eye/aim) and sizing
 * them from different waters would tilt the view for no reason.
 *
 * The slope is NOT optional and there is no default: `waterTypeAt` throws a
 * TypeError naming `terrain.sampleSlope` if it is omitted, because forcing it
 * to 0 is the value that makes the FLAT biomes win and collapses fourteen live
 * biomes to eight. The depth handed over is the SEABED's, not the eye's - a
 * water mass is a property of the column, and the eye is about to be placed
 * relative to the answer, so keying on it would be circular.
 *
 * `terrain.sampleHeight` rather than `sampleHeightFast` (which is what
 * main.js's live water column uses, and can read up to 1.83 m shallow): checked
 * at all fourteen anchors, the two agree on the water type at every one, and
 * this way the height that places the eye is the height that classified it.
 *
 * @param {object} terrain the terrain module
 * @param {number} x @param {number} z
 * @param {number} height terrain height at (x, z), metres, negative below sea
 * @returns {{eye: number, aim: number, range: number, water: object}}
 */
function arrivalOptics(terrain, x, z, height) {
  const water = waterTypeAt(x, z, height, Math.max(0, -height), terrain.sampleSlope(x, z), terrain);
  // ln(1 + sigmaT/sigmaS)/sigmaT per channel, kept at the channel that holds
  // contrast LONGEST - see the derivation and the measurement above.
  let range = 0;
  for (let i = 0; i < 3; i++) {
    const r = Math.log(1 + water.sigmaT[i] / water.sigmaS[i]) / water.sigmaT[i];
    if (r > range) range = r;
  }
  return {
    eye: clamp(EYE_FRAC * range, HOVER_EYE_MIN, HOVER_EYE_MAX),
    aim: clamp(AIM_FRAC * range, AIM_MIN, AIM_MAX),
    range,
    water,
  };
}

/**
 * Arrival pitch for an underwater station: look at the seabed one aim-distance
 * along the heading. See ARRIVAL_PITCH_LAND for why this is not a constant, and
 * arrivalOptics for where the distance comes from.
 *
 * @param {object} terrain the terrain module
 * @param {number} x @param {number} z  eye position
 * @param {number} eyeY  absolute eye height
 * @param {number} yaw   compass heading, radians
 * @param {number} aim   metres ahead to aim at
 * @returns {number} pitch, radians, positive up
 */
function arrivalPitch(terrain, x, z, eyeY, yaw, aim) {
  // dirFromHeading's convention: +X is sin(heading), -Z is cos(heading).
  const ax = x + Math.sin(yaw) * aim;
  const az = z - Math.cos(yaw) * aim;
  const groundY = terrain.sampleHeight(ax, az);
  const pitch = Math.atan2(groundY - eyeY, aim);
  return clamp(pitch + GROUND_LINE_LIFT, ARRIVAL_PITCH_MIN, ARRIVAL_PITCH_MAX);
}

/**
 * Where the feet (on foot) or the hull origin (in the vessel) should sit.
 *
 * @param {object} game
 * @param {number} x @param {number} z
 * @param {number} height terrain height at (x, z)
 * @param {boolean} inVessel
 * @param {object|null} optics arrivalOptics() for an underwater arrival, null on land
 * @returns {number} absolute Y, metres
 */
function deriveY(game, x, z, height, inVessel, optics) {
  const { player, collision } = game;
  if (height >= 0) {
    // Dry land. footprintHeight is the MAX over the footprint, so a shoulder
    // cannot end up inside a ridge - it is the same call respawn() makes.
    const radius = inVessel ? VESSEL.BEAM * 0.5 : player.radius;
    const ground = collision.footprintHeight(x, z, radius);
    return inVessel ? ground + VESSEL_PARK_CLEARANCE : ground;
  }
  if (inVessel) {
    // The hull's own ceiling is the chase camera's 12.5 m standoff, but that
    // standoff is metres of the SAME water: hovering 14 m up in COASTAL_GREEN
    // puts 26 m of a 2.74 m beam range between the eye and the seabed. Take
    // whichever ceiling is lower. Math.max keeps the clamp bounds ordered if a
    // water type is ever authored murky enough to drive the aim under 3 m.
    const ceiling = Math.max(VESSEL_HOVER_MIN, Math.min(VESSEL_HOVER_MAX, optics.aim));
    return height + clamp(-height * 0.5, VESSEL_HOVER_MIN, ceiling);
  }
  // Measure the hover from the FOOTPRINT, not the centre sample. The eye is
  // metres off the bottom now rather than six, and the footprint runs up to a
  // measured 0.228 m above the centre at these anchors (Rock Spires); a diver
  // whose fins end up inside the heightfield photographs open water, because
  // its underside is back-face culled.
  const ground = Math.max(height, collision.footprintHeight(x, z, player.radius));
  // PLAYER.EYE_HEIGHT, not player.currentEyeHeight: the arrival always stands
  // (Player.teleport zeroes crouchBlend), so reading the live crouch here would
  // size the drop from a stance that is about to be discarded.
  const eyeY = Math.min(ground + optics.eye, -EYE_SUBMERGE_MARGIN);
  return eyeY - PLAYER.EYE_HEIGHT;
}

/**
 * @typedef {object} TeleportResult
 * @property {number} x @property {number} y @property {number} z
 * @property {number} yaw @property {number} pitch
 * @property {string} label  destination name, '' for a raw coordinate
 * @property {number} height terrain height at the destination
 * @property {number} depth  seabed depth, positive down
 * @property {boolean} inVessel  whether the vessel came too
 * @property {number} suitTier @property {number} hullTier
 * @property {boolean} snappedY  a supplied y was below the ground and was raised
 */

/**
 * Move the player - and the vessel, if they are piloting it - to (x, z).
 *
 * @param {object} game  needs `player`, `vessel`, `terrain` and `collision`.
 *   `renderer`, `spawner`, `worldClock` and `snapWaterColumn` are OPTIONAL and
 *   optional-chained, so the offline suite can call this with no GPU at all.
 * @param {number} x
 * @param {number|null} y  absolute; null derives it from the terrain
 * @param {number} z
 * @param {object} [opts]
 * @param {number} [opts.yaw]    default faces down-slope
 * @param {number} [opts.pitch]  default ARRIVAL_PITCH_LAND / _WATER
 * @param {boolean} [opts.grantGear=true] raise suit and hull tier to the depth
 * @param {string} [opts.label]  destination name, for the log line
 * @returns {TeleportResult}
 */
export function teleportTo(game, x, y, z, opts = {}) {
  const { player, vessel, terrain } = game;
  const inVessel = !!player.inVessel;
  const height = terrain.sampleHeight(x, z);
  // How far this water lets us see. Only asked underwater: on land the column
  // is zero deep and the answer would be about a water mass that is not there.
  const optics = height < 0 ? arrivalOptics(terrain, x, z, height) : null;

  const derived = deriveY(game, x, z, height, inVessel, optics);
  let finalY = derived;
  let snappedY = false;
  if (y !== null && y !== undefined && Number.isFinite(y)) {
    // A supplied y is honoured, but never INTO the heightfield: placing the eye
    // inside the ground renders the terrain's back faces, which are culled, so
    // the frame looks like open water and any test written against it goes
    // green. Raise it and say so rather than silently obeying.
    if (y < height + 0.5) { finalY = derived; snappedY = true; } else { finalY = y; }
  }

  const yaw = opts.yaw ?? arrivalHeading(terrain, x, z);
  const pitch = opts.pitch ?? (height < 0
    ? arrivalPitch(terrain, x, z, inVessel ? finalY : finalY + PLAYER.EYE_HEIGHT, yaw, optics.aim)
    : ARRIVAL_PITCH_LAND);

  // Gear is granted against the SEABED depth, not the eye's: a diver who drifts
  // down after arriving must not then be crushed by the gap.
  const seabedDepth = Math.max(0, -height);
  const suitTier = suitTierForDepth(seabedDepth);
  const hullTier = hullTierForDepth(seabedDepth);
  const oxygenTier = oxygenTierForDepth(seabedDepth);
  if (opts.grantGear !== false) {
    // Math.max, never assignment: a shallow jump must not strip an upgrade.
    player.setSuitTier(Math.max(player.suitTier, suitTier));
    // The tank matters as much as the crush rating - see oxygenTierForDepth.
    // setOxygenTier rewrites oxygenCapacity, so it must run BEFORE the refill.
    player.setOxygenTier(Math.max(player.oxygenTier, oxygenTier));
    if (inVessel) {
      vessel.hullTier = Math.max(vessel.hullTier, hullTier);
      // depthRating is DEGRADED by accumulated damage, and hullMax is
      // permanently ratcheted down by 6 once hull drops below 18 - so without
      // this a session of deep jumps would quietly lose crush depth.
      vessel.hullMax = VESSEL.MAX_HULL;
      vessel.hull = VESSEL.MAX_HULL;
    }
  }

  if (inVessel) {
    vessel.teleport(x, finalY, z, yaw, pitch);
    // The player RIDES. simulateInVessel() copies the hull transform into the
    // player - but only inside a sim STEP, and _updateCamera runs BEFORE the
    // next step on the frame the jump lands. Write the carried transform now, or
    // that first frame interpolates the diver from the old continent.
    vec3.set(player.position, x, finalY, z);
    vec3.copy(player.prevPosition, player.position);
    vec3.zero(player.velocity);
    player.submergence = 0;
    player.eyeSubmerged = false;
    player.depth = vessel.depth;
    player.state = PLAYER_STATE.PILOTING;
    player.health = PLAYER.MAX_HEALTH;
    player.oxygen = player.oxygenCapacity;
    player.stamina = PLAYER.MAX_STAMINA;
    player.alive = true;
    player.bobIntensity = 0;
    player._damageTimer = PLAYER.HEALTH_REGEN_DELAY;
    player._drownTimer = 0;
    player._oxygenWarnTier = 0;
    // `exhausted` is cleared only inside _updateStamina, which never runs while
    // piloting - so an exhausted pilot who jumped stayed exhausted until they
    // disembarked, while the on-foot branch cleared it. This is the one field
    // here that does NOT self-correct on the next simulateInVessel.
    player.exhausted = false;
  } else {
    player.teleport(x, finalY, z, yaw, pitch,
      // The wave surface is time-varying, and _sampleWater latches eyeSubmerged
      // against it with a 0.12 m hysteresis band. Sampling at t = 0 while the
      // world clock is elsewhere mis-latches by up to 0.39 m at sea state 2 and
      // 6.36 m at sea state 6 - so a surface arrival can come up on the wrong
      // side of the waterline, and eyeSubmerged drives the camera FOV.
      { time: game.worldClock?.totalSeconds ?? 0 });
    // The vessel stays exactly where it is, by design: an on-foot jump is the
    // player moving, not the fleet.
  }

  // Every history that assumed continuity. All three docstrings name the
  // teleport case explicitly; without them the arrival is a multi-second black
  // dip (exposure), a smeared frame (TAA reprojecting a 3 km delta) and two
  // seconds of the previous location's water.
  game.renderer?.camera?.resetHistory?.();
  game.renderer?.resetAdaptation?.();
  // Sample where the EYE has arrived, not where the camera still is: the camera
  // is not written until _updateCamera() on the next frame, so a snap that read
  // it would classify the place we just left. The water type is keyed on the
  // column and on eye depth, so the eye is the right point to hand it.
  vec3.set(_eye, x, inVessel ? finalY : finalY + player.currentEyeHeight, z);
  game.snapWaterColumn?.(_eye);

  // Synchronous and bounded by RENDER.MAX_CREATURES. Without it the near-field
  // director takes about ten seconds to fill, which reads as an empty ocean.
  const at = inVessel ? vessel.position : player.position;
  game.spawner?.prime?.(at, game.worldClock);

  const result = {
    x, y: finalY, z, yaw, pitch, height,
    label: opts.label ?? '',
    depth: seabedDepth, inVessel,
    suitTier: player.suitTier,
    hullTier: vessel.hullTier,
    snappedY,
  };
  console.info(
    `[jump] ${opts.label ?? 'coordinates'} -> ` +
    `(${x.toFixed(0)}, ${finalY.toFixed(1)}, ${z.toFixed(0)}) ` +
    `depth ${seabedDepth.toFixed(0)} m, suit ${result.suitTier}` +
    (inVessel ? `, hull ${result.hullTier}, with vessel` : '') +
    // The framing is data-driven now, so say which water drove it: a frame that
    // looks wrong is usually a column that classified differently than expected.
    (optics ? `, ${optics.water.name}, eye ${optics.eye.toFixed(1)} m / aim ${optics.aim.toFixed(1)} m` : '') +
    (snappedY ? ', y raised out of the terrain' : ''),
  );
  return result;
}

/**
 * Warm the scatter field at a destination.
 *
 * Kept out of teleportTo() because the teleport has to be synchronous and
 * complete - it is called from a click handler, from tools/shot.mjs setup
 * expressions and from the console - while this is a bounded async warm-up
 * nobody should have to wait for. Scatter generates from the terrain's analytic
 * samplers, so priming a place whose chunks have not meshed yet is correct.
 *
 * The caller MUST attach a .catch(): a floating rejection reaches
 * window.onunhandledrejection, which raises the fatal overlay over a perfectly
 * healthy game.
 *
 * @param {object} game
 * @param {number} x @param {number} y @param {number} z
 * @returns {Promise<void>}
 */
export function primeArrival(game, x, y, z) {
  const prime = game.scatterPass?.prime;
  if (!prime) return Promise.resolve();
  return Promise.resolve(prime.call(game.scatterPass, [x, y, z]));
}
