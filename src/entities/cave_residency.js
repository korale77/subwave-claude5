/**
 * Standing cave residencies: guaranteed residents inside authored cave systems.
 *
 * The LeviathanResidencies pattern (entities/leviathan_residency.js) with one
 * structural difference: ACTIVATION IS GATED ON THE FOCUS BEING INSIDE THE
 * CAVE SYSTEM, via the volumetric field's own isInsideCave(), not on open-water
 * distance alone. That gate carries three guarantees at once: the resident can
 * never spawn while the player merely swims OVER the system; it can never
 * appear in a variety-tour frame (no tour eye is ever under a roof, and a tour
 * jump resets this manager anyway, exactly as it resets the leviathans'); and
 * the Vaultstalker never reaches the water column its datasheet has no business
 * in. This is also why the species does NOT come through the ambient spawner:
 * the near-field director's tier ceilings (NEARFIELD_MAX_TIER 1, prowler cap 3)
 * both exclude tier 4, deliberately and permanently - a sound-hunting ambush
 * apex is a PLACED fact of a specific cave, not a dice roll.
 *
 * Spawning happens at the site's home point the moment the focus is inside the
 * system and within activateR - which at the First Hollow is the mouth shaft,
 * 197 m of tunnel and rock away from the chamber, far beyond any cave water's
 * sight range, so the arrival is never witnessed IN PLAY. One deliberate
 * exception, same as the leviathan sites' dev-jump caveat: the 'hollow-in'
 * interior jump row satisfies inCave AND the distance gate with the player
 * already at the home point, so a direct chamber jump materialises the
 * resident in frame at arm's length. Dev-menu only; the swim-in from the
 * First Hollow mouth is the intended experience. Release copies the leviathan
 * manager's guards verbatim (never pop an engaged or recently-seen animal) and
 * adds a leave TIMER on top of the distance hysteresis: isInsideCave flickers
 * across the mouth plane during an exit, and a release keyed on the raw flag
 * would strobe despawn/respawn against a player loitering in the doorway.
 * The spawner's cull never touches tier >= 3, so this manager owns despawn
 * entirely, like the leviathans'. The stale-_nearFieldSlot hazard of a direct
 * sim.spawn() is covered globally by the spawner's CREATURE_SPAWN handler.
 */

import { BEHAVIOUR, speciesIndexOf } from './creatures.js';
import { isInsideCave } from '../world/caves.js';

/**
 * Authored cave residency sites. Coordinates are cave-graph facts sampled at
 * the default seed (the First Hollow scan - see the site notes on the place
 * record in world/places.js): the home point is 4 m above the chamber's
 * measured floor (-670.2), void clearance 5+ m, isInsideCave true.
 *
 * territoryR is the datasheet's own 180 m; activateR only needs to cover the
 * system's farthest entry point (the mouth is 197 m from the chamber) with
 * margin, and releaseR sits beyond it so a player circling the chamber cannot
 * strobe the spawn.
 */
export const CAVE_RESIDENCY_SITES = Object.freeze([
  Object.freeze({
    name: 'First Hollow Vaultstalker',
    short: 'hollowStalker',
    species: 'CRT_VAULTSTALKER',
    x: 1903.1, y: -666.0, z: 1349.3,
    territoryR: 180,
    activateR: 260,
    releaseR: 360,
  }),
]);

/** Seconds the focus must stay OUTSIDE the cave field before an idle, unseen
 *  resident may be released. Covers the mouth-plane flicker with margin: the
 *  flag toggles per fixed step, and 6 s is also the spawner's own
 *  DESPAWN_UNSEEN horizon. */
const LEAVE_RELEASE_SECONDS = 6.0;

export class CaveResidencies {
  /** @param {object} sim the live CreatureSim */
  constructor(sim) {
    this.sim = sim;
    this.sites = CAVE_RESIDENCY_SITES.map((s) => ({
      site: s,
      sp: speciesIndexOf(s.species),
      handle: -1,
      outsideT: 0,
    }));
  }

  /** Despawn every resident and re-arm. Called on teleport, like the others. */
  reset() {
    for (const r of this.sites) {
      if (r.handle >= 0 && this.sim.isAlive(r.handle)) this.sim.despawn(r.handle, 'despawn');
      r.handle = -1;
      r.outsideT = 0;
    }
  }

  /**
   * Maintain residents against the focus position.
   *
   * @param {number} dt seconds (the fixed step; drives the leave timer)
   * @param {ArrayLike<number>} focus absolute world position (player or vessel)
   */
  update(dt, focus) {
    if (!focus) return;
    // ONE field query per step for every site (the sites share the answer:
    // "is the focus under a roof at all"), then per-site distance tests.
    const inCave = isInsideCave(focus[0], focus[1], focus[2]);
    for (const r of this.sites) {
      if (r.sp < 0) continue;
      const s = r.site;
      const dx = focus[0] - s.x, dy = focus[1] - s.y, dz = focus[2] - s.z;
      // 3-D distance, unlike the leviathans' XZ: a cave system is a volume and
      // the vertical leg of "how far from the chamber" is real distance here.
      const d2 = dx * dx + dy * dy + dz * dz;
      const alive = r.handle >= 0 && this.sim.isAlive(r.handle);
      r.outsideT = inCave ? 0 : r.outsideT + dt;
      if (alive) {
        const leaving = d2 > s.releaseR * s.releaseR
          || r.outsideT > LEAVE_RELEASE_SECONDS;
        if (leaving) {
          // The leviathan manager's two release guards, verbatim: never pop
          // an animal the player is involved with.
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
      // ACTIVATION: inside the cave field AND within reach of the site. Both,
      // so a diver in an unrelated shallow fissure 240 m above cannot summon
      // the stalker, and a diver skimming the seabed over the chamber cannot
      // either.
      if (!inCave || d2 > s.activateR * s.activateR) continue;
      // Face back down the system, deterministic (headingFromDir of
      // site->origin, the leviathan convention): the first sighting is a pale
      // shape crossing the passage, not an animal pointed at the player.
      const heading = Math.atan2(-s.x, s.z);
      r.handle = this.sim.spawn(r.sp, s.x, s.y, s.z, {
        heading,
        homeX: s.x, homeY: s.y, homeZ: s.z,
        territoryR: s.territoryR,
        scaleJitter: 1,
      });
    }
  }
}
