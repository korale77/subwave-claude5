/** Standing leviathan residencies: guaranteed apex residents at authored sites. */

import { LEVIATHAN_SITES } from '../world/leviathan_sites.js';
import { BEHAVIOUR, speciesIndexOf } from './creatures.js';

/**
 * The population half of what abyss_encounter.js does for drama: each site
 * guarantees ONE live resident of its species whenever the player is inside
 * its activation radius, and hands it to the ordinary territorial AI from the
 * moment it spawns. There is no script and no pose control here - the
 * resident patrols, stalks and attacks by its own datasheet, which is the
 * point: the reveal is authored once (the Herald), the POPULATION is a
 * standing fact of the world.
 *
 * Spawning happens at the site's home point while the player is 700-800 m
 * away - beyond sight in every water type this world carries - so arrival is
 * never witnessed (the near-field pop rule, one scale up). Release is by
 * hysteresis at releaseR, and the manager owns despawn entirely: the
 * spawner's cull deliberately never touches tier >= 3 ("a leviathan holds
 * its budget wherever it is"), so without the release test a toured world
 * would accumulate every resident it ever activated.
 */
export class LeviathanResidencies {
  /** @param {object} sim the live CreatureSim */
  constructor(sim) {
    this.sim = sim;
    this.sites = LEVIATHAN_SITES.map((s) => ({
      site: s,
      sp: speciesIndexOf(s.species),
      handle: -1,
    }));
  }

  /** Despawn every resident and re-arm. Called on teleport, like the encounter. */
  reset() {
    for (const r of this.sites) {
      if (r.handle >= 0 && this.sim.isAlive(r.handle)) this.sim.despawn(r.handle, 'despawn');
      r.handle = -1;
    }
  }

  /**
   * Maintain residents against the focus position.
   * @param {ArrayLike<number>} focus absolute world position (player or vessel)
   */
  update(focus) {
    if (!focus) return;
    for (const r of this.sites) {
      if (r.sp < 0) continue;
      const s = r.site;
      const dx = focus[0] - s.x, dz = focus[2] - s.z;
      const d2 = dx * dx + dz * dz;
      const alive = r.handle >= 0 && this.sim.isAlive(r.handle);
      if (alive) {
        if (d2 > s.releaseR * s.releaseR) {
          // Never pop an animal the player is involved with: a vessel at
          // 38 m/s can drag a pursuit past releaseR while looking straight
          // back at it. The spawner's own cull despawns nothing that is
          // engaged or was seen in the last 6 s (DESPAWN_UNSEEN), and this
          // release applies the same two guards - the resident is dropped on
          // the first far step where it is idle and unobserved.
          const i = this.sim.slotOf(r.handle);
          const b = i >= 0 ? this.sim.behaviour[i] : BEHAVIOUR.IDLE;
          const engaged = b === BEHAVIOUR.STALK || b === BEHAVIOUR.ATTACK ||
            b === BEHAVIOUR.FLEE || b === BEHAVIOUR.FEED;
          if (!engaged && (i < 0 || this.sim.unseenT[i] >= 6)) {
            this.sim.despawn(r.handle, 'despawn');
            r.handle = -1;
          }
        }
        continue;
      }
      r.handle = -1;
      if (d2 > s.activateR * s.activateR) continue;
      const homeY = s.seabedY + s.hoverAbove;
      // Face the WORLD ORIGIN (headingFromDir of the site->origin direction):
      // deterministic, and never aimed at the player, so the first sighting
      // is a patrol silhouette rather than an animal already pointed at you.
      const heading = Math.atan2(-s.x, s.z);
      r.handle = this.sim.spawn(r.sp, s.x, homeY, s.z, {
        heading,
        homeX: s.x, homeY, homeZ: s.z,
        territoryR: s.territoryR,
        scaleJitter: 1,
      });
    }
  }
}
