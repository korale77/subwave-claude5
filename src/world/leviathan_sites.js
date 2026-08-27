/**
 * Authored leviathan residencies: where the world's apex animals LIVE.
 *
 * The bestiary's three leviathans are complete - data, mesh, territorial AI,
 * damage - and, before these sites, effectively unreachable: they spawn only
 * through cell resolution at datasheet densities of 0.004-0.06/km3, an
 * expectation of 1e-4 to 3.4e-5 per 0.0084 km3 cell roll. The one authored
 * exception is the Pale Herald's scripted reveal (abyss_encounter.js). A
 * residency is the standing-population form of the same idea: a fixed site
 * where one named individual is guaranteed to exist whenever the player is
 * near enough to ever meet it, owned by the ordinary territorial AI the whole
 * time - no script, no second behaviour system.
 *
 * EVERY COORDINATE HERE WAS SAMPLED FROM THE GENERATED TERRAIN at the default
 * seed 1534754449 (node, sampleHeightFast), not invented - the
 * WORLD.BASE_POSITION lesson. seabedY is the measured ground; the resident
 * hovers hoverAbove metres over it, inside its own authored depth band.
 *
 * SITES ARE DELIBERATELY OFF THE TOUR ANCHORS. A wandering creature across the
 * lens VOIDS a variety-tour run by itself (see CLAUDE.md). Measured: the
 * warden site is 499.9 m from the spires anchor with a 320 m territory
 * (patrol edge >= 179.9 m clear), the gorge site 600.4 m from the canyon
 * anchor with 340 m (edge >= 260.4 m clear). The stronger tour guarantee is
 * behavioural: every tour visit is a jumpTo, which RESETS residencies and
 * respawns the resident AT ITS HOME POINT, so at capture (14 s settle, sim
 * then paused) it has covered at most ~36 m from home at base speed.
 *
 * activateR/releaseR are a hysteresis pair around the near-field pop rule's
 * logic one scale up: activation happens 700 m out, far beyond sight in any
 * of this world's waters, so a resident never pops into an occupied frame
 * DURING PLAY; release is farther still, so a player circling the boundary
 * does not strobe the spawn, and the manager refuses to release an animal
 * that is engaged or was seen in the last 6 s. One deliberate exception to
 * the no-pop rule: a DEV-MENU JUMP that lands inside activateR materialises
 * the resident at arrival, possibly in frame - acceptable for an instrument
 * (tools/shots/encounters.json exploits it), impossible in ordinary play.
 */
export const LEVIATHAN_SITES = Object.freeze([
  {
    name: 'Spire Warden',
    short: 'warden',
    species: 'LEV_HOLLOWJAW',
    x: -1799, z: 1435,
    seabedY: -529.4373523591344,
    hoverAbove: 70,
    territoryR: 320,
    activateR: 700,
    releaseR: 1000,
  },
  {
    name: 'Canyon Hollowjaw',
    short: 'gorge',
    species: 'LEV_HOLLOWJAW',
    x: 2427, z: -1316,
    seabedY: -748.3682632588049,
    hoverAbove: 90,
    territoryR: 340,
    activateR: 700,
    releaseR: 1000,
  },
  {
    // THE SUNKEN DUNES RESIDENT (2026-08-19, biome 18). Home is 104.9 m
    // from the dunes tour anchor - INSIDE the water's own 121 m effective
    // visibility, BY EXPLICIT USER INSTRUCTION after two playtests ("make
    // sure that the location we jump to has the scary monster circling
    // around, easily visible"): a J-menu arrival materialises the resident
    // already in frame as a patrolling silhouette. This is the sites-file
    // exception documented above, exercised on purpose - a DEV-MENU jump
    // may materialise the resident at arrival, and the J menu is the dev
    // menu; a swimmer arriving in ordinary play still meets the 700 m
    // activation hysteresis and no pop. The site ladder is measured: 399 m
    // (anchor 79 m OUTSIDE the 320 m territory - the patrol only grazed
    // the sightline and a playtest read it as "some white whale thing" in
    // the haze), then 228 m (inside the patrol but a 75 s probe still
    // measured the resident at 230 m, past visibility), now 105 m.
    // KNOWN COST, accepted: the dunes variety-tour anchor now has a 45 m
    // animal inside its capture radius, so the biome's tour frames will
    // sometimes contain it; the jump-reset guarantee keeps the two VOID
    // passes near-identical, and if a tour ever voids here the documented
    // remedy is re-siting the ANCHOR, not this home.
    // Spacing: 1,332 m to the Spire Warden's home against DESIGN/06.4.6's
    // 1,500 m guidance - accepted as a deviation because the line crosses
    // the shoal's own rim wall and the abyssal gap (neither territory can
    // reach the other), and the binding runtime cap (max 2 simulated
    // leviathans) is untouched.
    // hoverAbove 24: the Splitmaw hunts by SIGHT over open sand - it
    // patrols low, in the player's own horizontal band, where the biome's
    // long sightlines make it a silhouette instead of a ceiling shadow.
    name: 'Dune Splitmaw',
    short: 'splitmaw',
    species: 'LEV_SPLITMAW',
    x: -1040, z: 2530,
    // Re-measured 2026-08-19 (tools/test-dune-ambush.mjs asserts the match):
    // the value recorded at the site's landing had drifted 9.9 cm from the
    // generated terrain - stale from before the dune pass's last relief
    // tweak, and pre-existing on the unmodified tree.
    seabedY: -344.48760588760314,
    hoverAbove: 24,
    territoryR: 320,
    activateR: 700,
    releaseR: 1000,
  },
]);

/**
 * The Splitmaw's hunting ground as a KEEP-OUT VOLUME for ambient fauna - the
 * `insideAbyssEncounterStage` pattern, standing instead of staged.
 *
 * WHY A POSITIONAL TEST AND NOT A SPAWN-SOURCE GATE. The Sunken Dunes'
 * pelagic dead zone (spawner.js PELAGIC_DEAD_ZONES) gates which CELLS merge
 * the drifter roster, and two playtests showed that is not sufficient: the
 * classifier hands dune CRESTS to Canyon Wall (slope > 0.66 beats the dunes
 * record), whose near-field samples re-admit the drifters beside the player,
 * and cells fully beyond the rim legally spawn an 18 m Veilmouth that is
 * then visible from the arena floor at 150-250 m ("there is 1 Splitmaw and
 * 2 white whales"). A volume test rejects the animal by where it would
 * STAND, whichever path rolled it.
 *
 * Cylinder around the residency home, radius 480 m (covers the anchor, the
 * whole patrol and the east rim sightline), vertical slab from 60 m below
 * the home seabed to 170 m above it - past the water's own 121 m effective
 * visibility, so nothing legal above the slab can read from the floor.
 *
 * @param {number} x @param {number} y @param {number} z
 * @returns {boolean}
 */
export function insideSplitmawHuntingGround(x, y, z) {
  const s = LEVIATHAN_SITES[2];
  const dx = x - s.x, dz = z - s.z;
  if (dx * dx + dz * dz > 480 * 480) return false;
  return y > s.seabedY - 60 && y < s.seabedY + 170;
}

/**
 * THERE IS DELIBERATELY NO NETHERCOIL SITE, and the refutation is measured.
 *
 * Its authored band [1300, 1600] exists only PAST the world boundary: the
 * trench descends to -1600 at (3144, 2636), radius 4,103 m, against
 * WORLD.HARD_BOUNDARY 3,050 - a first site was authored out there at
 * (2580, 2226), radius 3,408 m, and the jump was refused before the shot
 * framed anything. Inside the playable disc the floor is -1055.7 m
 * (grid-searched at r <= 2900, seed 1534754449, 2026-08-07), and EVERY
 * point deeper than 1,000 m lies within ~250 m of the trenchWall or
 * trenchFloor tour anchor - closer than the water's own 150 m visibility
 * plus settle drift, so a resident respawned at home by a tour jump could
 * reach frame and VOID the run. A reachable Nethercoil therefore needs
 * either a boundary decision (extend HARD_BOUNDARY along the trench
 * corridor, a Places-stage world decision) or its own scripted encounter
 * like the Pale Herald's - and the trench is the one region that already
 * HAS a guaranteed apex beat, the Herald reveal. Do not re-add a site here
 * without settling that; the residency manager needs no change either way.
 */
