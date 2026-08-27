/**
 * Authored landmark places.
 *
 * A place is a DESTINATION: a terrain-truthful site plus an optional water
 * override, place-local props, a jump-menu row and a curated arrival framing.
 * It is the layer four systems already waited for; the first live consequence is that VENT_HAZE, BRINE and
 * VENT_SMOKE stop being dead authored data (see the VENT_HAZE docstring in
 * `core/constants.js`, whose deposit named this file as its due date).
 *
 * EVERY COORDINATE AND EVERY `seabedY` BELOW WAS SAMPLED FROM THE GENERATED
 * TERRAIN at WORLD.DEFAULT_SEED = 1534754449 (terrain.sampleHeight at the
 * stated x/z; the scan and refinement scripts sampled slope, disc relief and
 * biome dominance around each candidate before it was accepted). Nothing here
 * is invented, and `tools/test-jump.mjs` re-samples the terrain and fails if a
 * seabedY drifts. Sites were chosen inside r <= 2700 (the push-back ramp
 * starts at WORLD.SOFT_BOUNDARY 2900) and at least 500 m from every biome
 * anchor and anchor view position of this seed, so no variety-tour frame can
 * photograph a place by accident.
 *
 * THIS MODULE IMPORTS NOTHING FROM world/. `biomes.js` consumes it for the
 * water override and `terrain.js` imports `biomes.js`, so an import of
 * terrain here would be a cycle - which is why the terrain samples are baked
 * in rather than taken live, exactly as `habitat_site.js` does.
 *
 * Field consumers, because a field with no reader is this project's most
 * repeated bug class:
 *   name/short   ui/jump-menu.js rows, main.js jumpTo keys, tools/test-jump.mjs
 *   x/z/radius   world/scatter.js place-prop placement (radius is the
 *                chunk-intersection cull disc; scatter's bake throws if a
 *                prop cluster exceeds it, and the module-load check at the
 *                bottom of THIS file throws if a water disc does)
 *   seabedY      the terrain-drift guard in tools/test-jump.mjs, and the
 *                sample the arrival y below was derived from
 *   water        world/biomes.js waterTypeAt override (feathered)
 *   props        world/scatter.js placePropsForChunk
 *   arrival      main.js jumpTo -> entities/teleport.js, tools/shots/places.json
 *   caveArrival  OPTIONAL second jump row ('<short>-in'): main.js jumpTo
 *                re-seats the player at this authored interior point AFTER
 *                teleportTo, because the heightfield teleport refuses any y
 *                below the terrain surface and a cave interior is below it by
 *                definition. ui/jump-menu.js renders the row.
 *
 * CINDER ARCH IS DEFERRED, NOT FORGOTTEN. The v1 sketch wanted an authored
 * basalt arch entity on the island coast with a >= 25 m vessel-flyable span.
 * That is a new mesh module on the habitat_mesh.js pattern plus a pass
 * registration, with no collision story - and unlike the four places below it
 * unlocks no dead authored data. It is the one place in the first wave whose
 * cost is a new renderer entity rather than a registry row, so it ships when
 * an arch mesh exists to ship, not as a stub here. What is missing: the mesh
 * generator, its entity/pass wiring, and a coast site sampled for a clear
 * flight line.
 */

/**
 * @typedef {object} PlaceWater
 * @property {string} type WATER_TYPES key. Validated (throws) in biomes.js.
 * @property {number} radius metres; the override is full strength inside
 *   radius - feather and fades to nothing at radius.
 * @property {number} feather metres of smoothstep edge INSIDE the radius.
 *
 * @typedef {object} PlaceProp
 * @property {string} type SCATTER_TYPES key. Validated (throws) in scatter.js.
 * @property {number} count instances
 * @property {number} minR @property {number} maxR metres from the place centre
 * @property {number[]} r0 [lo, hi] window on the type's own scale band: the
 *   emitted instance draws its scale rand from this range, so a place can ask
 *   for the large end of a shared prop without a new row.
 * @property {number} salt decorrelates sibling clusters of one place
 */

export const PLACES = Object.freeze([
  Object.freeze({
    /**
     * EMBERTHROAT - a geothermal vent field on the south-west abyssal plain.
     *
     * Site: 691 m down, centre slope 0.233, mean slope 0.246 over a 50 m disc
     * (relief 21 m), abyssal-plain dominant, 924.4 m clear of the nearest tour
     * anchor (measured over all 14 anchors, their view positions and the
     * p0-base tour eyes), r = 2691 from origin. The surrounding column classifies
     * HADAL_SUSPENSION, so the VENT_HAZE override is a measurable change of
     * medium (sighting range 77.6 -> 52.9 m, snow 1.65 -> 2.75), and the
     * VENT_SMOKE core is a 0.52 m-visibility plume throat. Both pass the
     * column ceiling here because at 691 m the aphotic gate has already taken
     * the daylight to zero (lit = 0; see waterTypeAt).
     *
     * The warm light is the existing ventChimney row, which is already on
     * RENDER.DEEP_BEACON_EXTRA - no new light class, no signatureBiome.
     */
    id: 0,
    name: 'Emberthroat', short: 'ember',
    x: -2104, z: -1680,
    seabedY: -690.9606744346496,
    radius: 110,
    water: Object.freeze([
      Object.freeze({ type: 'VENT_HAZE', radius: 90, feather: 30 }),
      // The plume core sits INSIDE the haze field and is listed after it:
      // biomes.js resolves overlapping discs latest-wins at equal weight, so
      // the core owns its 12 m and the field owns the rest.
      Object.freeze({ type: 'VENT_SMOKE', radius: 12, feather: 5 }),
    ]),
    props: Object.freeze([
      Object.freeze({ type: 'ventChimney', count: 12, minR: 3, maxR: 42, r0: [0.35, 0.85], salt: 0 }),
      Object.freeze({ type: 'tubeworm', count: 48, minR: 2, maxR: 34, r0: [0.30, 1.00], salt: 1 }),
      Object.freeze({ type: 'ventSulphur', count: 30, minR: 2, maxR: 48, r0: [0.40, 1.00], salt: 2 }),
    ]),
    // 55.2 m out to the south-east, above the sulphur apron, aimed at the
    // stack field (target 14 m above the vents' base). Outside the smoke core,
    // inside the DELIVERED haze: the first arrival sat at r = 73.5 m, inside
    // the water disc but past the feathered handover (measured: Vent Haze
    // through r = 70, Abyssal Void at 73.5 on this diagonal), so the player
    // arrived in 150 m-visibility void water looking at a 52.9 m-haze place.
    // The disc is not the delivered override; the arrival must sit where the
    // override actually WINS classification.
    arrival: Object.freeze({ x: -2065, y: -665.81, z: -1641, yaw: -0.7854, pitch: -0.1995 }),
  }),
  Object.freeze({
    /**
     * HALOCLINE MIRROR - a brine pool on the flattest basin of the plain.
     *
     * Site: 641.9 m down, centre slope 0.194, relief 8.6 m over a 26 m disc -
     * the flattest deep basin the 32 m scan found inside the keep-out rules -
     * 1374.6 m clear of the nearest anchor. BRINE's ceiling is 120.7 m and the
     * lit column here is 0 (aphotic gate), so the lens survives
     * classification. v1 is the water override plus rim dressing: a ring of
     * bone ribs (a brine pool pickles what wanders in) and one crystal spire
     * as the evaporite beacon - crystalSpire is already on
     * RENDER.DEEP_BEACON_EXTRA. The reflective interface is NOT in scope and
     * nothing here pretends to be one.
     */
    id: 1,
    name: 'Halocline Mirror', short: 'brine',
    x: -2464, z: -656,
    seabedY: -641.8774318452473,
    radius: 60,
    water: Object.freeze([
      // 30 m against a rib ring at 24-34: the override competes with an
      // abyssal biome weight of ~0.9 out there, so the delivered crossover
      // sits at ~23.5 m (measured offline: BRINE at r<=23, HADAL past it)
      // and the pool edge lands just inside the ring.
      Object.freeze({ type: 'BRINE', radius: 30, feather: 8 }),
    ]),
    props: Object.freeze([
      Object.freeze({ type: 'boneRib', count: 9, minR: 24, maxR: 34, r0: [0.55, 1.00], salt: 0 }),
      Object.freeze({ type: 'crystalSpire', count: 1, minR: 30, maxR: 30, r0: [0.85, 0.85], salt: 1 }),
    ]),
    // 45.9 m out to the north, 6 m off the floor, aimed across the pool.
    arrival: Object.freeze({ x: -2458, y: -629.89, z: -700, yaw: -3.0061, pitch: -0.2531 }),
  }),
  Object.freeze({
    /**
     * LIGHTFALL - a twilight hollow under the terrace rim.
     *
     * Site: 280.2 m down in a genuine bowl (centre 8.9 m below the 40/70 m
     * ring means, rim 31 m above the floor at 40 m, 60.6 m at 70 m), terrace
     * dominant, 1246.7 m clear of the nearest anchor. A ring of glow pods and
     * glowcups floors it - fill lights, no beacon, no new machinery.
     *
     * NO WATER OVERRIDE, AND THAT IS A REFUTATION, NOT AN OMISSION. The v1
     * sketch asked for an OCEANIC_CLEAR column here so a clearer shaft would
     * read against murkier surroundings, and the catalogue refuses it both
     * ways. Measured on the 40 m disc scan at this seed: every column in
     * 150-260 m is ALREADY OCEANIC_CLEAR (zero non-clear hits over the whole
     * r <= 2650 disc), so the override is the identity exactly where its own
     * 260 m ceiling admits it; and past 260 m the waters it would replace -
     * ABYSSAL_VOID here (Kd blue 0.0182, visibility 150.5 m) or NEPHELOID -
     * hold MORE blue daylight and MORE sighting range than OCEANIC_CLEAR
     * (0.0253, 94.3 m), so at this site the "clearer" shaft delivers 0.137x
     * the floor's blue daylight (exp(-(0.0253-0.0182)*280)) through a murkier
     * sight path. In this table the deep family is the clear water, and a
     * place cannot author its way brighter by swapping to shelf water. The
     * hollow ships on its relief and its emitter ring.
     */
    id: 2,
    name: 'Lightfall', short: 'lightfall',
    x: -2084, z: -380,
    seabedY: -280.16447672069273,
    radius: 70,
    water: null,
    props: Object.freeze([
      Object.freeze({ type: 'glowPod', count: 26, minR: 6, maxR: 26, r0: [0.55, 1.00], salt: 0 }),
      Object.freeze({ type: 'mushroomCap', count: 12, minR: 10, maxR: 30, r0: [0.60, 1.00], salt: 1 }),
    ]),
    // 74.7 m out on the south-east rim, 10 m up, aimed into the bowl.
    arrival: Object.freeze({ x: -2040, y: -225.32, z: -346, yaw: -0.9129, pitch: -0.7308 }),
  }),
  Object.freeze({
    /**
     * GRANDMOTHER KELP - one colossal kelp at the heart of the deep forest.
     *
     * RE-SITED INTO THE KELP BASIN with the 2026-08-18 emerald rebuild's
     * terrain phase: the old site at (1616, -104) was 55.8 m of shelf that
     * stopped classifying Kelp Forest when the biome moved onto the carved
     * basin (record depth [56, 170]), and a place-only landmark standing
     * outside its own biome is the dead-data pattern.
     *
     * New site: 102.1 m down, relief 2.94 m over a 26 m disc (the flattest
     * deep disc the basin offers on this seed's scan), Kelp Forest dominant,
     * 745 m clear of the re-derived kelp anchor at (-856, 968) so the
     * variety tour cannot photograph it. The colossus is the place-only
     * `kelpColossus` row, now an 84 m parameterisation under `surfaceCap`
     * (the cap rides the shared emission path, so the crown clears the
     * surface arithmetic by construction). Four fruiting champions stand
     * attendance so the giant reads as the eldest of a family.
     */
    id: 3,
    name: 'Grandmother Kelp', short: 'grandmother',
    x: -220.6, z: 1212.1,
    seabedY: -102.07617168253677,
    radius: 50,
    water: null,
    props: Object.freeze([
      Object.freeze({ type: 'kelpColossus', count: 1, minR: 0, maxR: 0, r0: [0.60, 0.60], salt: 0 }),
      Object.freeze({ type: 'kelpChampion', count: 4, minR: 16, maxR: 30, r0: [0.40, 0.90], salt: 1 }),
    ]),
    // 45 m out to the south, 10 m off the floor, aimed up the trunk (target
    // 40 m above the holdfast): yaw 0 faces north back toward the place.
    arrival: Object.freeze({ x: -220.6, y: -92.08, z: 1257.1, yaw: 0, pitch: 0.5880 }),
  }),
  Object.freeze({
    /**
     * THE PALE OSSUARY - the intact skull of a 90 m animal, enterable
     * (DESIGN/01's lm_pale_ossuary: 26 m long, 14 m tall, mid band).
     *
     * Site: 340.7 m down in the SOUTH-WEST bone field of Ossuary Flats (biome
     * 14, this change), centre slope 0.063, the flattest 14 m disc the biome
     * offers at this seed (relief 6.05 m; the skull's buried skirt is sized
     * against exactly that number - see generateSkull). 878 m clear of the
     * nearest anchor (boulders) and >= 836 m from every anchor and view of
     * the 15-anchor table, so no tour frame can photograph it. DESIGN sites
     * the landmark in the EAST disc at (2060, -430); the delivered world's
     * eastern basins all lie within 250 m of the resolved ossuary or canyon
     * anchors, so the landmark takes the south-west field instead - the same
     * "site it from the real terrain" rule every place here follows.
     *
     * NO WATER OVERRIDE: the column already classifies NEPHELOID from the
     * biome itself (verified at the centre), and the bone-dust haze IS the
     * biome's water. The centrepiece is the place-only `paleOssuary` scatter
     * row; two colossus skeletons stand attendance at 46-66 m so the skull
     * reads as the largest of a field, not a one-off; scattered ribs carry
     * the mid scale between them.
     */
    id: 4,
    name: 'The Pale Ossuary', short: 'skull',
    x: -868, z: -2100,
    seabedY: -340.7082263378258,
    radius: 80,
    water: null,
    props: Object.freeze([
      Object.freeze({ type: 'paleOssuary', count: 1, minR: 0, maxR: 0, r0: [0.50, 0.50], salt: 0 }),
      Object.freeze({ type: 'ossuaryColossus', count: 2, minR: 46, maxR: 66, r0: [0.35, 0.75], salt: 1 }),
      Object.freeze({ type: 'boneRib', count: 16, minR: 14, maxR: 60, r0: [0.45, 1.00], salt: 2 }),
    ]),
    // 22 m out, 26 degrees east of the bearing the delivered skull FACES (the
    // instance's local +Z leaves the walk pointing (0.47, 0.88) - measured by
    // baking the chunk). NOT dead on the facing: the on-axis corridor carries
    // a canyonBanner and a sponge thicket at 24-31 m that fill the frame (the
    // first authored arrival was a pink banner and no skull at all), and this
    // bearing was chosen by scanning every 0.1 rad x {22,26,30} m pose for
    // the largest clear distance to any tall instance on the sightline
    // (9 m here) with terrain LOS clearance 3.6+ m. 22 m against NEPHELOID's
    // 42.1 m sighting range, eye 2.5 m up - LOW, because from a raised eye
    // the pale dome sits against the pale seabed and vanishes into the veil;
    // from swimmer height it stands against the haze with both sockets
    // reading. Compass convention: yaw = atan2(dx, -dz) at these coordinates.
    arrival: Object.freeze({ x: -850.1, y: -332.73, z: -2087.2, yaw: -0.9496, pitch: -0.048 }),
  }),
  Object.freeze({
    /**
     * FIRST HOLLOW - an enterable cave mouth on the Rock Spires slope, and the
     * geode chamber 197 m inside it. The first authored doorway into the
     * volumetric layer, and the destination the Geode Hollows identity
     * (DESIGN/01 biome #22) is experienced through.
     *
     * GEODE HOLLOWS IS A VOLUME IDENTITY, NOT A BIOMES ROW; the columnar
     * classifier cannot express it. `biomeAt` answers for a COLUMN and a cave
     * interior is a point BELOW the column's one surface, so the identity is
     * delivered entirely through cave-side mechanisms: the IN_CAVE composite
     * gate + RENDER.CAVE_SNOW_REDUCTION (the still, mineral water), the spar
     * instances baked by world/cave_mesh.js (the dressing), and the CAVE
     * pseudo-habitat fauna (entities/spawner.js, entities/cave_residency.js).
     * Consequently there is no water override here and no signatureBiome
     * anywhere in this change - the 13-signature assertion stands.
     *
     * SITE: scanned from the real cave graph at the default seed (every mouth
     * of every macro cell within r 2870), not authored by hand. The scan's
     * gates: mouth surface below -300 m, shaft radius >= 2.2 m, a chamber
     * with rMin >= 5 m inside the Geode band [-1050, -560], union-find
     * connectivity from the mouth's own capsule tree, and a roof probe
     * demanding real rock between chamber and surface. TWO systems qualify in
     * the whole playable disc; this one wins on roof (58 m of rock against
     * 16), on depth (surface -591.4, below TRUE_DARK, so the reveal is
     * lamp-lit), and on avoiding the canyon system whose near chamber
     * breaches. The P4-A handoff's verified R18 mouth (-1315, -2741) was
     * refuted as a PLACE by the world boundary: it sits at r = 3039, past
     * SOFT_BOUNDARY 2900, where the place-layer keep-out (and this file's own
     * convention) forbids a centre. Mouth: shaft radius 2.71 m, discard disc
     * 6.8 m. Chamber: (1903.1, -661.7, 1349.3), rMin 9 m, floor at -670.2,
     * MOUTH 603.8 m clear of its nearest anchor (Trench Wall); the CHAMBER's
     * nearest is Trench FLOOR at 480.2 m - re-measured against the final
     * 15-anchor set by the P4 review after this comment's first draft
     * attributed the mouth's figure to the chamber. The chamber is under
     * 58 m of rock and cannot be photographed by any tour framing, so the
     * 480 m figure carries no VOID risk; the mouth's 603.8 m is the one
     * that matters and it clears.
     *
     * THE ARRIVAL IS OUTSIDE, AIMED AT THE HOLE - the reveal is the dark
     * opening in the seabed, not the inside. 30.0 m out on the down-slope
     * east bearing (the ring scan's most open sightline, terrain LOS
     * clearance 2.6 m), feet 2 m above the mouth's own surface plane, pitch
     * on the disc. `caveArrival` is the second row (jump key 'hollow-in'):
     * main.js jumpTo re-seats the player there AFTER teleportTo, because the
     * heightfield teleport refuses any y below the terrain surface and a cave
     * interior is below it by definition.
     */
    id: 5,
    name: 'First Hollow', short: 'hollow',
    x: 2039.2, z: 1209.2,
    seabedY: -591.4258719620219,
    radius: 40,
    water: null,
    props: null,
    // Feet 8 m above the mouth's surface plane, not 2: photographed at 2 m the
    // disc is edge-on and reads as nothing - a hole is only a hole from above
    // its plane. Pitch re-aimed at the disc centre from the raised eye (LOS
    // clearance 3.0 m along the whole sightline).
    arrival: Object.freeze({ x: 2068.7, y: -583.43, z: 1214.4, yaw: -1.3963, pitch: -0.3276 }),
    // Feet on the chamber's lower half: void clearance 5.0 m at the feet,
    // isInsideCave true from -661.7 down to the floor at -670.2. Yaw faces
    // back up the passage toward the mouth (atan2(dx, -dz) of chamber->mouth).
    caveArrival: Object.freeze({ x: 1903.1, y: -665.7, z: 1349.3, yaw: 0.771, pitch: 0.05 }),
  }),
  Object.freeze({
    /**
     * GLOW CAVE - the first AUTHORED cave (world/cave_sites.js JELLY_SITE,
     * merged into the tunnel graph at macro-graph build). Named "jellyshroom"
     * EVERYWHERE IN CODE - the short key, the mesh asset, the cave-prop
     * variants and tools/shots/jelly.json all still say jelly; only the
     * player-facing name is Glow Cave. It is a seabed mouth at -153 m on the
     * Twilight Terraces shelf, a 170 m descending corridor, and a
     * ~90 x 40 x 76 m cavern near -250 m holding
     * fourteen giant emissive jellyshrooms, purple speleothems and the
     * violet wall treatment - the reference-image biome the site exists for.
     *
     * Like First Hollow, this is a VOLUME identity, not a BIOMES row, and
     * for the same columnar-classifier reason. Unlike First Hollow its
     * geometry is authored, so the chamber's composition (corridor reveal,
     * shroom stands, roof height) is design, not scan luck. No water
     * override: at 250 m the veil is enclosure-drained anyway, and the
     * purple is carried by the cap LIGHTS (render/passes/caves.js
     * submitJellyLights, froxel-injected), the prop emission and the aux.w
     * wall treatment - the three channels that survive both the enclosure
     * drain and the Kd red kill. No signatureBiome anywhere in this change.
     *
     * SITE: scanned (40 m grid, r 700-2600, mouth seabed [-175, -115],
     * slope <= 0.45, >= 500 m from every anchor, >= 450 m from every place/
     * station, chamber overburden >= 18 m over a 5x5 probe). Winner on roof
     * (98.5 m: the shelf RISES northward over the chamber while the corridor
     * descends) and on mouth framing (slope 0.06). Nearest anchor: Coral
     * Garden, 1330.7 m. No procedural cave system's AABB touches the
     * mouth-to-chamber volume at the default seed - verified by skeleton
     * scan, so the space is exactly what cave_sites authors.
     *
     * THE ARRIVAL IS OUTSIDE, AIMED AT THE HOLE, First Hollow's convention:
     * 32 m south (the down-slope side - the seabed falls away southward, so
     * the raised eye looks DOWN onto the disc against the rising shelf
     * behind it), feet 9 m above the mouth's surface plane, LOS clearance
     * 3.7-25 m along the whole sightline. yaw atan2(0, 32) = 0 exactly.
     * `caveArrival` (jump key 'jelly-in') seats 4.8 m above the chamber
     * floor at the hall's south edge, void clearance 3.3 m, facing north
     * into the shroom stand with the 16 m giant 22 m ahead.
     */
    id: 6,
    name: 'Glow Cave', short: 'jelly',
    x: 0, z: 2000,
    seabedY: -153.1398099113785,
    radius: 40,
    water: null,
    props: null,
    // Re-framed twice against delivered frames: due south the sightline is
    // crowded by a stratum-slab stand on the rim, so the arrival comes in
    // from the ESE quadrant (the top-down survey's open side). Pushed out to
    // 38.2 m / 12 m up when the mouth went vessel-scale (discard disc r 22 -
    // the old 25.6 m stand sat ON the funnel lip). yaw/pitch aimed at the
    // disc centre.
    arrival: Object.freeze({ x: 28, y: -141.1, z: 2026, yaw: -0.8224, pitch: -0.34 }),
    caveArrival: Object.freeze({ x: 0, y: -245.0, z: 1846, yaw: 0, pitch: 0.10 }),
  }),
]);

/** Lookup by the short key the jump menu and jumpTo use. */
export const PLACE_BY_SHORT = Object.freeze(
  PLACES.reduce((m, p) => { m[p.short] = p; return m; }, Object.create(null)));

// Bake-time envelope check, named above: every water disc must sit inside the
// place radius, or the scatter cull disc and the classification footprint
// disagree about where the place ends. Module-load throw, so a bad row can
// never reach a frame. (Prop clusters have the same check in scatter's bake.)
for (const p of PLACES) {
  if (!p.water) continue;
  for (const w of p.water) {
    if (w.radius > p.radius) {
      throw new Error(
        `[places] ${p.short}: water disc ${w.type} radius ${w.radius} exceeds place radius ${p.radius}`);
    }
  }
}
