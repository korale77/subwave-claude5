/**
 * Standing station residency: the Pelagos observatory pod is ORDINARY
 * POPULATION, present whether or not anyone is watching.
 *
 * The LeviathanResidencies pattern (entities/leviathan_residency.js) with two
 * structural differences: a site is a POD (several members with authored homes,
 * not one resident), and the species is tier 0, whose ambient spawner path the
 * habitat actively fights - the spawner EVICTS ambient creatures inside the
 * station envelope and refuses placements there (spawner.js `_cull` /
 * `_placeGroup` on insideHabitatVolume), so ordinary drift can never reliably
 * dress the observatory glass. A residency outside the eviction ring is the
 * one mechanism that guarantees the window's premise in free play.
 *
 * HISTORY, and why this file exists: the pod was demo-staged - the showcase's
 * `_stepFauna` raw-spawned three Ribbonwethers for the habitat segment and
 * despawned them in stop(), so the "big fish outside the observatory glass"
 * premise existed only while the demo ran. That is the demo-owned-creatures
 * violation, resolved by moving the AUTHORED PLACEMENT -
 * coordinates, tangential headings, territory - here verbatim. The demo now
 * simply walks to the window like any player.
 *
 * Activation hysteresis is the leviathans' XZ form (the station is open water;
 * no cave gate), with one addition: a dead or released member REFILLS only
 * while the focus is beyond WITNESS_R of the pod centroid, so a fish never
 * materialises in front of the glass - activateR 170 is already ~3x any
 * shallow water's sight range, which covers the walk-in; WITNESS_R covers a
 * player who camps the window across a release/refill cycle. Release copies
 * the leviathan guards verbatim (never pop an engaged or recently-seen
 * animal). The spawner's DESPAWN_DISTANCE for tier 0 is 600 m against a
 * releaseR of 240, so this manager always releases first and owns the pod's
 * lifecycle; the stale-_nearFieldSlot hazard of a direct sim.spawn() is
 * covered globally by the spawner's CREATURE_SPAWN handler.
 */

import { BEHAVIOUR, speciesIndexOf } from './creatures.js';
import { HABITAT_SITE, insideHabitatVolume } from '../world/habitat_site.js';

/**
 * Authored station residency sites. Member coordinates and headings are the
 * demo's engineered placement, moved here unchanged: a Ribbonwether trio -
 * Sand Plains benthic grazers, depth band [18, 105] against 31 m here, tier 0,
 * and at 2.4 m the game's proof that big does not mean dangerous. Homes sit
 * ~16 m east of the observatory eye at window-band height, clear of the hull
 * envelope and the 5.4 m drum+margin eviction ring; territoryR 8 keeps the
 * wander inside the glazing's sight cone. Headings run TANGENTIAL to the
 * station (north/south), not at it: spawn() seeds 0.7 m/s along the heading,
 * and a westward seed walks the pod toward the drum's eviction ring.
 */
export const STATION_RESIDENCY_SITES = Object.freeze([
  Object.freeze({
    name: 'Pelagos observatory pod',
    short: 'stationPod',
    species: 'CRT_RIBBONWETHER',
    x: HABITAT_SITE.x + 41, z: HABITAT_SITE.z,   // pod centroid, for the gates
    members: Object.freeze([
      Object.freeze({ x: HABITAT_SITE.x + 40, y: -30.5, z: HABITAT_SITE.z - 2, heading: 0.3 }),
      Object.freeze({ x: HABITAT_SITE.x + 43, y: -29.5, z: HABITAT_SITE.z + 3, heading: Math.PI - 0.4 }),
      Object.freeze({ x: HABITAT_SITE.x + 41, y: -31.5, z: HABITAT_SITE.z + 1, heading: -0.5 }),
    ]),
    territoryR: 8,
    activateR: 170,
    releaseR: 240,
  }),
  Object.freeze({
    // The commons dome's OVERHEAD premise, the observatory pod's reasoning
    // one room over: buildCommons glazes the dome specifically so "the water
    // column overhead is visible through it... that is the whole point of
    // the room" (habitat_mesh.js), and a playtest looking up through it
    // reported exactly the gap this row fills - "can we have some big fish
    // or rays swimming so we can see them?". Sandveil Rays are the biggest
    // graceful species legal here by datasheet (rajiform gliders, FLAT zone,
    // depth band [1, 95] against ~23 m at the homes; the larger candidates
    // fail the band - Veilmouth needs >= 90 m, Gloomray >= 380 m). Homes
    // ring the dome axis at r ~5 m, 2.5-3 m ABOVE the glass apex (apex
    // y -25.03; the envelope's cheap-reject box tops at -24.65, so with the
    // loader guard's 1.0 m margin the homes clear the eviction volume by
    // ~1 m+), headings tangential for the same seed-velocity reason as the
    // observatory trio. territoryR 10 keeps the glide circling the dome
    // rather than wandering off the drum.
    name: 'Pelagos dome gliders',
    short: 'domeGliders',
    species: 'CRT_SANDVEIL',
    x: HABITAT_SITE.x, z: HABITAT_SITE.z,        // pod centroid: the dome axis
    members: Object.freeze([
      Object.freeze({ x: HABITAT_SITE.x + 5, y: -22.4, z: HABITAT_SITE.z - 1, heading: Math.PI }),
      Object.freeze({ x: HABITAT_SITE.x - 4, y: -21.9, z: HABITAT_SITE.z + 3, heading: 0.4 }),
      Object.freeze({ x: HABITAT_SITE.x - 1, y: -22.8, z: HABITAT_SITE.z - 5, heading: Math.PI * 0.5 }),
      Object.freeze({ x: HABITAT_SITE.x + 3, y: -21.6, z: HABITAT_SITE.z + 5, heading: -Math.PI * 0.5 }),
    ]),
    territoryR: 10,
    activateR: 170,
    releaseR: 240,
    // The default WITNESS_R would gate the INITIAL fill too, and the station
    // teleport arrival is only ~34 m from the dome axis - the demo (and any
    // jump) would land inside the witness ring and the pod would never
    // exist. 20 m still covers the one case witnessing exists for (a player
    // directly under the glass across a release/refill cycle); the fill on a
    // teleport arrival happens behind the jump's own adaptation/fade frames.
    witnessR: 20,
  }),
]);

/** Horizontal metres the focus must keep from the pod centroid for a member
 *  REFILL (not the initial walk-in activation, which activateR's 170 m
 *  already hides). Sized against the shallows' post-drastic 2%-contrast
 *  visibility of ~51-53 m. Per-site override: `witnessR` on the row. */
const WITNESS_R = 55;

// A member home inside the station envelope would be evicted by the spawner's
// cull on the next step, silently - the table would be authored, loaded and
// dead, this project's most repeated bug class. Refuse to load instead. The
// 1.0 m margin is the demo's own placement guard, kept as the stricter bound.
for (const s of STATION_RESIDENCY_SITES) {
  for (const m of s.members) {
    if (insideHabitatVolume(m.x, m.y, m.z, 1.0)) {
      throw new Error(`station residency '${s.short}': member home (${m.x}, ${m.y}, ${m.z}) `
        + 'is inside the habitat envelope (margin 1.0) - it would be evicted on spawn');
    }
  }
}

export class StationResidencies {
  /** @param {object} sim the live CreatureSim */
  constructor(sim) {
    this.sim = sim;
    this.sites = STATION_RESIDENCY_SITES.map((s) => ({
      site: s,
      sp: speciesIndexOf(s.species),
      handles: s.members.map(() => -1),
    }));
  }

  /** Despawn every member and re-arm. Called on teleport, like the others. */
  reset() {
    for (const r of this.sites) {
      for (let m = 0; m < r.handles.length; m++) {
        const h = r.handles[m];
        if (h >= 0 && this.sim.isAlive(h)) this.sim.despawn(h, 'despawn');
        r.handles[m] = -1;
      }
    }
  }

  /**
   * Maintain the pods against the focus position.
   *
   * @param {ArrayLike<number>} focus absolute world position (player or vessel)
   */
  update(focus) {
    if (!focus) return;
    for (const r of this.sites) {
      if (r.sp < 0) continue;
      const s = r.site;
      const dx = focus[0] - s.x, dz = focus[2] - s.z;
      const d2 = dx * dx + dz * dz;
      const inside = d2 <= s.activateR * s.activateR;
      const wr = s.witnessR ?? WITNESS_R;
      const unwitnessed = d2 > wr * wr;
      for (let m = 0; m < s.members.length; m++) {
        const alive = r.handles[m] >= 0 && this.sim.isAlive(r.handles[m]);
        if (alive) {
          if (d2 > s.releaseR * s.releaseR) {
            // The leviathan manager's two release guards, verbatim: never pop
            // an animal the player is involved with.
            const i = this.sim.slotOf(r.handles[m]);
            const b = i >= 0 ? this.sim.behaviour[i] : BEHAVIOUR.IDLE;
            const engaged = b === BEHAVIOUR.STALK || b === BEHAVIOUR.ATTACK ||
              b === BEHAVIOUR.FLEE || b === BEHAVIOUR.FEED;
            if (!engaged && (i < 0 || this.sim.unseenT[i] >= 6)) {
              this.sim.despawn(r.handles[m], 'despawn');
              r.handles[m] = -1;
            }
          }
          continue;
        }
        r.handles[m] = -1;
        if (!inside || !unwitnessed) continue;
        const home = s.members[m];
        r.handles[m] = this.sim.spawn(r.sp, home.x, home.y, home.z, {
          heading: home.heading,
          homeX: home.x, homeY: home.y, homeZ: home.z,
          territoryR: s.territoryR,
          scaleJitter: 1,
        });
      }
    }
  }
}
