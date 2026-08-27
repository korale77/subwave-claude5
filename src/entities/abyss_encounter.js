/** Authored, visual-only Pale Herald reveal in the deep Abyssal Plain. */

import { clamp, lerp, quat, vec3 } from '../core/math.js';
import {
  ABYSS_ENCOUNTER_SITE, insideAbyssEncounterStage,
} from '../world/abyss_encounter_site.js';
import {
  BEHAVIOUR, TARGET, speciesIndexOf,
} from './creatures.js';

const PALE_HERALD = speciesIndexOf('LEV_PALEHERALD');
const TRIGGER_RADIUS = 70;
const ABORT_RADIUS = 330;
const SCRIPT_SECONDS = 24;

export const ABYSS_ENCOUNTER_PHASE = Object.freeze({
  DORMANT: 0,
  OMEN: 1,
  DISTANT_CROSSING: 2,
  CLOSE_CROSSING: 3,
  RELEASED: 4,
});

const _dir = vec3.create();
const _q = quat.create();

/**
 * One guaranteed visual encounter, not a cutscene and not a second AI system.
 * The director owns the Herald only through its reveal, then hands the same
 * live CreatureSim agent back to normal territorial behaviour.
 */
export class AbyssEncounter {
  constructor(sim) {
    this.sim = sim;
    this.site = ABYSS_ENCOUNTER_SITE;
    this.phase = ABYSS_ENCOUNTER_PHASE.DORMANT;
    this.elapsed = 0;
    this.handle = -1;
    this.completed = false;
    this._owned = false;
    this._lastX = 0;
    this._lastY = 0;
    this._lastZ = 0;
    this._haveLast = false;
  }

  /** Re-arm the authored reveal for repeatable demo jumps. */
  reset() {
    if (this._owned && this.sim.isAlive(this.handle)) this.sim.despawn(this.handle, 'despawn');
    this.phase = ABYSS_ENCOUNTER_PHASE.DORMANT;
    this.elapsed = 0;
    this.handle = -1;
    this.completed = false;
    this._owned = false;
    this._haveLast = false;
  }

  /** True when the focus is inside the intentionally staged deep-water volume. */
  shouldTrigger(focus) {
    const dx = focus[0] - this.site.x, dz = focus[2] - this.site.z;
    return dx*dx + dz*dz <= TRIGGER_RADIUS*TRIGGER_RADIUS && focus[1] <= -820;
  }

  update(dt, focus) {
    if (this.completed) return;
    if (this.phase === ABYSS_ENCOUNTER_PHASE.DORMANT) {
      if (!this.shouldTrigger(focus)) return;
      if (!this._activate()) return;
    }

    const dx = focus[0] - this.site.x, dz = focus[2] - this.site.z;
    if (dx*dx + dz*dz > ABORT_RADIUS*ABORT_RADIUS) {
      this._release();
      return;
    }

    this.elapsed = Math.min(SCRIPT_SECONDS, this.elapsed + Math.max(0, dt));
    const slot = this.sim.slotOf(this.handle);
    if (slot < 0) { this.completed = true; return; }
    this._pose(slot, Math.max(dt, 1/240));
    if (this.elapsed >= SCRIPT_SECONDS) this._release();
  }

  _activate() {
    this._clearStage();
    const existing = this._findNearbyHerald();
    if (existing >= 0) {
      this.handle = this.sim.handleOf(existing);
      this._owned = false;
    } else {
      this.handle = this.sim.spawn(PALE_HERALD, this.site.x, this.site.y - 8, this.site.z - 150, {
        heading: this.site.yaw,
        homeX: this.site.x, homeY: this.site.y - 8, homeZ: this.site.z,
        territoryR: 260,
        scaleJitter: 1,
      });
      this._owned = this.handle >= 0;
    }
    if (this.handle < 0) return false;
    this.phase = ABYSS_ENCOUNTER_PHASE.OMEN;
    this.elapsed = 0;
    this._haveLast = false;
    return true;
  }

  /** Remove ambient population from the shot without recording deaths/depletion. */
  _clearStage() {
    const live=Array.from(this.sim.liveSlots());
    for (const i of live) {
      if (this.sim.species[i]===PALE_HERALD) continue;
      if (!insideAbyssEncounterStage(this.sim.posX[i],this.sim.posY[i],this.sim.posZ[i])) continue;
      this.sim.despawn(this.sim.handleOf(i),'despawn');
    }
  }

  _findNearbyHerald() {
    const live = this.sim.liveSlots();
    for (let k = 0; k < live.length; k++) {
      const i = live[k];
      if (this.sim.species[i] !== PALE_HERALD) continue;
      const dx = this.sim.posX[i]-this.site.x, dz = this.sim.posZ[i]-this.site.z;
      if (dx*dx + dz*dz < 360*360) return i;
    }
    return -1;
  }

  /** Position on one of two crossings in the arrival camera's horizontal frame. */
  _path(t) {
    let forward, right;
    if (t < 6) {
      this.phase = ABYSS_ENCOUNTER_PHASE.OMEN;
      const u = clamp(t / 6,0,1);
      forward=lerp(118,120,u);
      right=lerp(115,70,u);
    } else if (t < 14) {
      this.phase = ABYSS_ENCOUNTER_PHASE.DISTANT_CROSSING;
      const u=clamp((t-6)/8,0,1);
      forward=120;
      right=lerp(70,-70,u);
    } else {
      this.phase = ABYSS_ENCOUNTER_PHASE.CLOSE_CROSSING;
      const u=clamp((t-14)/10,0,1);
      if(u<0.5){
        const v=u*2;
        forward=lerp(120,58,v);
        right=lerp(-70,0,v);
      }else{
        const v=(u-0.5)*2;
        forward=lerp(58,75,v);
        right=lerp(0,60,v);
      }
    }
    const fx = Math.sin(this.site.yaw), fz = -Math.cos(this.site.yaw);
    const rx = Math.cos(this.site.yaw), rz = Math.sin(this.site.yaw);
    return {
      x: this.site.x + fx*forward + rx*right,
      y: this.site.y - 9 + Math.sin(t*0.42)*5,
      z: this.site.z + fz*forward + rz*right,
    };
  }

  _pose(i, dt) {
    const p = this._path(this.elapsed);
    let vx, vy, vz;
    if (this._haveLast) {
      vx = (p.x-this._lastX)/dt; vy = (p.y-this._lastY)/dt; vz = (p.z-this._lastZ)/dt;
      const speed = Math.hypot(vx,vy,vz);
      if (speed > 19) { const q = 19/speed; vx*=q; vy*=q; vz*=q; }
    } else {
      vx = Math.sin(this.site.yaw)*3.1; vy = 0; vz = -Math.cos(this.site.yaw)*3.1;
      this._haveLast = true;
    }
    this._lastX=p.x; this._lastY=p.y; this._lastZ=p.z;

    const sim = this.sim;
    sim.posX[i]=p.x; sim.posY[i]=p.y; sim.posZ[i]=p.z;
    sim.hash.move(i,p.x,p.y,p.z);
    sim.velX[i]=vx; sim.velY[i]=vy; sim.velZ[i]=vz;
    sim.homeX[i]=this.site.x; sim.homeY[i]=this.site.y-9; sim.homeZ[i]=this.site.z;
    sim.territoryR[i]=260;
    sim.behaviour[i]=BEHAVIOUR.IDLE; sim.state[i]=0; sim.stateT[i]=0;
    sim.targetKind[i]=TARGET.NONE; sim.targetId[i]=-1;
    sim.threat[i]=0; sim.fear[i]=0; sim.unseenT[i]=0;
    vec3.set(_dir, vx, vy, vz);
    if (vec3.len(_dir) > 1e-4) {
      quat.lookRotation(_q, _dir);
      const o=i*4;
      sim.orient[o]=_q[0]; sim.orient[o+1]=_q[1]; sim.orient[o+2]=_q[2]; sim.orient[o+3]=_q[3];
    }
  }

  _release() {
    const i = this.sim.slotOf(this.handle);
    if (i >= 0) {
      this.sim.behaviour[i]=BEHAVIOUR.IDLE;
      this.sim.state[i]=0;
      this.sim.targetKind[i]=TARGET.NONE;
      this.sim.threat[i]=0;
      this.sim.homeX[i]=this.site.x;
      this.sim.homeY[i]=this.site.y-9;
      this.sim.homeZ[i]=this.site.z;
      this.sim.territoryR[i]=260;
    }
    this.phase=ABYSS_ENCOUNTER_PHASE.RELEASED;
    this.completed=true;
  }
}
