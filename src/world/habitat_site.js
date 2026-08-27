/**
 * The fixed Sand Plains demonstration habitat.
 *
 * This is authored against WORLD.DEFAULT_SEED. It is intentionally a landmark,
 * not procedural scatter and not a construction system: one stable place lets
 * the opening route, collision, lighting and interior transition be composed.
 */
/** Walkable local-XZ pressure volumes. Overlaps are intentional door portals. */
export const HABITAT_INTERIOR_SPACES = Object.freeze([
  Object.freeze({ name: 'airlock', minX: -1.55, maxX: 1.55, minZ: -9.35, maxZ: -3.60 }),
  Object.freeze({ name: 'commons', minX: -4.50, maxX: 4.50, minZ: -4.50, maxZ: 4.50 }),
  Object.freeze({ name: 'east hall', minX: 3.60, maxX: 12.60, minZ: -1.40, maxZ: 1.40 }),
  Object.freeze({ name: 'laboratory', minX: 11.85, maxX: 18.55, minZ: -2.95, maxZ: 3.75 }),
  Object.freeze({ name: 'observatory hall', minX: 17.80, maxX: 23.30, minZ: -1.25, maxZ: 1.55 }),
  Object.freeze({ name: 'observatory', minX: 22.60, maxX: 29.00, minZ: -2.80, maxZ: 3.60 }),
  Object.freeze({ name: 'west hall', minX: -11.60, maxX: -3.60, minZ: 0.55, maxZ: 3.15 }),
  Object.freeze({ name: 'crew room', minX: -17.10, maxX: -10.80, minZ: -0.95, maxZ: 5.35 }),
]);

export const HABITAT_SITE = Object.freeze({
  name: 'Pelagos Habitat',
  short: 'station',
  x: -312,
  z: 1452,
  seabedY: -43.979226473449856,
  deckY: -33.25,
  yaw: 0,
  /** Scatter-free construction and vehicle-approach disc. */
  clearRadius: 62,
  /**
   * AUTHORED WATER OVER THE CLEARING, in the shape world/places.js uses; the
   * bake and the ceiling check are shared with it (`PLACE_WATER` in
   * world/biomes.js reads PLACES and this site from one list). This field is
   * PELAGOS_AQUA's only consumer, and PELAGOS_AQUA's docstring in
   * core/constants.js is where the whole argument lives - read it before
   * touching either.
   *
   * WHY THE SITE HAS TO AUTHOR ITS WATER AT ALL. `materialAt` returns Sand
   * Plains at raw weight 1.0000 here - the clearing IS sand, and Sand Plains
   * authors REEF_TURQUOISE - but `waterTypeAt` averages the centre with six
   * ring taps at WORLD.WATER_TYPE_SMOOTH_RADIUS (24 m), and every tap lands
   * on the Boulder Field slopes ringing the clearing. Smoothed weights are
   * boulders 0.589 against sand 0.411, so the COASTAL_GREEN pool takes the
   * column and the station photographed as one saturated green (delivered
   * frame RGB 7.5 / 157.9 / 81.1, red at 0.04% of surface). The site loses a
   * vote it should never have been in; this is the sanctioned override.
   *
   * THE GEOMETRY IS DERIVED, NOT PICKED. `inner = radius - feather = 62` is
   * exactly `clearRadius`, so the engineered clearing sits at full weight and
   * the handover runs over the next 48 m, where the surrounding shelf's own
   * blend weight takes it back - the same feathered contour every biome
   * boundary has, with main.js's sprung column smoothing the crossing in
   * time. It covers the whole demo route with margin (the arrival stages 34 m
   * out, the observatory eye is 26 m off centre, the exit dwell a few metres)
   * and test-jump's leak probe at radius + 40 = 150 m is outside `outer`
   * entirely, so the disc cannot reach the kelp basin or the bulb lagoon.
   */
  water: Object.freeze([
    Object.freeze({ type: 'PELAGOS_AQUA', radius: 110, feather: 48 }),
  ]),
  /** Camera staging point north of the habitat, looking south at the airlock. */
  arrival: Object.freeze({ x: -312, y: -35.2, z: 1418, yaw: Math.PI, pitch: 0.05 }),
  /**
   * Exterior airlock interaction point and dry-side arrival, feet positions.
   *
   * The exterior point is 1.5 m clear of the hatch face, NOT on it. It used to
   * be local z -9.35, which is 0.55 m INSIDE a trunk that is now both sealed by
   * a door plate and solid to swimmers - a diver standing on the interaction
   * point would be pushed straight back out of it.
   */
  exteriorDoor: Object.freeze([-312, -32.70, 1440.60]),
  interiorDoor: Object.freeze([-312, -33.05, 1444.20]),
  /**
   * Connected pressure volumes, axis-aligned because the authored yaw is zero.
   *
   * `ceilingY` is the head clamp for the WHOLE union and it is deliberately
   * generous. The rooms are round drums whose interior crowns run from 3.72 m
   * above the floor in the crew module to the commons dome's 8.02 m, and
   * resolvePlayer has one flat value for all of them, so the clamp sits above
   * every one rather than at any one of them: -26.05 is 7.00 m over the -33.05
   * floor. Nothing can reach it - a diver stands 1.82 m and jumps 0.95, so a
   * head tops out 2.77 m above the floor. LOWERING this is what would be felt.
   */
  interior: Object.freeze({
    minX: -329.10, maxX: -283.00, minZ: 1442.65, maxZ: 1457.35,
    floorY: -33.05, ceilingY: -26.05,
    spaces: HABITAT_INTERIOR_SPACES,
  }),
});

/** True inside the authored construction clearing. */
export function insideHabitatClearing(x, z, margin = 0) {
  const r = HABITAT_SITE.clearRadius + margin;
  const dx = x - HABITAT_SITE.x, dz = z - HABITAT_SITE.z;
  return dx * dx + dz * dz < r * r;
}

/**
 * The station's solid envelope, as pressure drums and corridor tubes in local
 * XZ about the deck plane: [x, z, radius, yLow, yHigh] for a drum, and
 * ['x'|'z', fixedCoordinate, from, to, radius] for a tube.
 *
 * TIGHT, not generous. It is not the collision model - habitat.js owns that -
 * it is the volume nothing else in the world may occupy, and the eviction it
 * drives is UNCONDITIONAL: it runs ahead of the unseen guard and the behaviour
 * immunities, because "not on camera" is exactly wrong when the animal is inside
 * a room the player is standing in. That means every metre of slack is a metre
 * of open water in which a fish vanishes in plain sight, framed by the glazing.
 * At a first cut of 7.2 m + 0.6 margin against a 6.40 m drum, the commons alone
 * deleted animals 1.4 m clear of its own skin.
 */
const HULL_DRUMS = Object.freeze([
  Object.freeze([0, 0, 6.60, -0.5, 4.70]),        // commons drum
  Object.freeze([0, 0, 5.00, 4.70, 8.40]),        // and its dome, which tapers
  Object.freeze([15.20, 0.40, 5.00, -0.5, 5.40]),
  Object.freeze([-13.95, 2.20, 4.70, -0.5, 5.20]),
  Object.freeze([25.80, 0.40, 4.80, -0.5, 5.30]),
]);
/**
 * Bolted collars, as short cylinders about their corridor's axis:
 * [axis, fixedCoordinate, crossing, radius, halfLength].
 *
 * They are a third of a metre wider than the tubes they sit on and they are real
 * geometry, so leaving them out of the envelope leaves 724 of the station's own
 * interior faces sitting outside it. The crossings are computed the same way
 * habitat_mesh.js computes them - a corridor meets a drum where its axis does,
 * and three of the five do not run through their module's centre.
 */
const HULL_COLLARS = Object.freeze([
  Object.freeze(['x', 0.00, 6.400, 3.05, 1.10]),    // commons -> east hall
  Object.freeze(['x', 0.00, 10.417, 3.05, 1.10]),   // east hall -> laboratory
  Object.freeze(['x', 0.15, 19.993, 3.05, 1.10]),   // laboratory -> obs hall
  Object.freeze(['x', 0.15, 21.207, 3.05, 1.10]),   // obs hall -> observatory
  Object.freeze(['x', 1.85, -9.464, 3.05, 1.10]),   // crew room -> west hall
  Object.freeze(['x', 1.85, -6.127, 3.05, 1.10]),   // west hall -> commons
  Object.freeze(['z', 0.00, -6.400, 3.15, 1.20]),   // commons -> airlock trunk
]);

const HULL_TUBES = Object.freeze([
  Object.freeze(['x', 0.00, 4.10, 12.60, 2.35]),
  Object.freeze(['x', 0.15, 17.80, 23.30, 2.35]),
  Object.freeze(['x', 1.85, -11.60, -3.60, 2.35]),
  Object.freeze(['z', 0.00, -10.30, -5.40, 2.45]),
]);

/**
 * True inside the station's solid volume - a pressure module, a corridor or the
 * deck slab.
 *
 * WHY THIS EXISTS: the world has no idea the station is there. Creature agents
 * are streamed into world cells and steered by open-water rules, so with nothing
 * to stop them they swim straight through the hull; photographed from the
 * commons with the airlock cycled, the room was full of fish drifting across the
 * floor and the furniture, and disabling the creature pass removed every one of
 * them. It is checked at spawn and again on cull, because an agent that swims in
 * after it was placed is the same picture as one placed inside.
 *
 * @param {number} x absolute world x
 * @param {number} y absolute world y
 * @param {number} z absolute world z
 * @param {number} [margin] extra metres of standoff
 */
export function insideHabitatVolume(x, y, z, margin = 0) {
  const lx = x - HABITAT_SITE.x, lz = z - HABITAT_SITE.z;
  const ly = y - HABITAT_SITE.deckY;
  // One cheap reject first: everything below is inside this box. The floor is
  // -1.35 rather than the deck's -0.48 because a 2.84 m collar about an axis
  // 1.70 m up reaches 1.14 m below the deck plane, and its underside is real
  // geometry hanging under the platform.
  if (lx < -21 - margin || lx > 34 + margin || lz < -12 - margin || lz > 9 + margin
      || ly < -1.35 - margin || ly > 8.6 + margin) return false;
  for (const [dx, dz, r, y0, y1] of HULL_DRUMS) {
    if (ly < y0 - margin || ly > y1 + margin) continue;
    const ex = lx - dx, ez = lz - dz, rr = r + margin;
    if (ex * ex + ez * ez < rr * rr) return true;
  }
  for (const [axis, fixed, from, to, r] of HULL_TUBES) {
    const along = axis === 'x' ? lx : lz;
    if (along < from - margin || along > to + margin) continue;
    const ds = (axis === 'x' ? lz : lx) - fixed;
    const dy = ly - 1.70, rr = r + margin;
    if (ds * ds + dy * dy < rr * rr) return true;
  }
  for (const [axis, fixed, cross, r, half] of HULL_COLLARS) {
    const along = axis === 'x' ? lx : lz;
    if (along < cross - half - margin || along > cross + half + margin) continue;
    const ds = (axis === 'x' ? lz : lx) - fixed;
    const dy = ly - 1.70, rr = r + margin;
    if (ds * ds + dy * dy < rr * rr) return true;
  }
  // The deck slab, matching the collision box in habitat.js.
  return lx > -19.8 - margin && lx < 32.2 + margin
    && lz > -6.6 - margin && lz < 7.4 + margin
    && ly > -0.50 - margin && ly < 0.04 + margin;
}
