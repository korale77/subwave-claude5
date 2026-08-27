/**
 * Authored, visual-only Splitmaw bluff-charge on the Sunken Dunes plateau.
 *
 * The AbyssEncounter pattern (entities/abyss_encounter.js), aimed the other
 * way: the Herald CROSSES the frame and never acknowledges the diver; the
 * Splitmaw's whole bestiary identity is that it hunts by EYE over open sand -
 * "you see it coming" - and the delivered scene never cashed that in. Five
 * demo captures photographed a patrol silhouette at 80-124 m that neither
 * noticed the camera nor approached it (director-cut8 beats 35-39). This
 * module makes the resident SEE the diver: it patrols on its own AI, turns in,
 * runs one pose-driven charge straight at the focus with the jaw opening over
 * the last metres, and then SWALLOWS THE LENS - it does not stop. The demo's
 * segment fade lands inside the mouth; a free-play diver watches ninety metres
 * of animal pass through them and away, and the territorial AI gets the same
 * live agent back on the far side.
 *
 * IT USED TO STOP. `HOLD_DIST` parked the snout 7.5 m off the lens for a slow
 * menacing creep, and the playtest asked for the opposite: "he comes at us,
 * opens mouth, once we are in his mouth that scene ends." A charge that halts
 * at arm's length is a bluff, and the shot is not about a bluff.
 *
 * WHY POSE-DRIVEN AND NOT REAL AGGRO: forcing `behaviour = ATTACK` runs the
 * real HFSM - WINDUP telegraph, LUNGE, CONTACT - and CONTACT is 90 of the
 * player's 100 HP (bestiary damage row), on a director that never evades and
 * never stops on death (script.js's own safety note). A pose with
 * `behaviour = IDLE`, `targetKind = NONE`, `threat = 0` can never deal
 * damage, exactly as the Herald's crossings cannot, while the charge itself
 * reads identically. The residual difference - no lunge acceleration spike -
 * is invisible behind a speed ramp to the species' own burstSpeed.
 *
 * THE JAW: `sim.jawOpen[i]` is re-derived every tick by `_animate`
 * (creatures.js) from behaviour/state, which for IDLE settles at ~0.04
 * through a ~70 ms exponential. This module runs AFTER `creatures.simulate`
 * in main.js's fixed step, so writing jawOpen here each tick lands after that
 * pull and holds; the renderer reads it later the same frame. Stop writing
 * and the jaw closes itself in a tenth of a second - which is also the
 * release path's cleanup for free.
 *
 * GEOMETRY: model space puts the origin at the BODY CENTRE with the snout at
 * local -length/2 (creature_mesh.js "Model space" note), so the maw of the 90 m
 * splitmaw rides ~45 m ahead of sim.posX/Y/Z. Every distance below is authored
 * centre-to-focus; subtract SNOUT_AHEAD to reason about the gap the lens
 * actually sees.
 *
 * PASSING THROUGH THE DIVER CANNOT HURT THEM, and that is structural rather
 * than lucky. There is no creature-vs-player collision anywhere in the sim - no
 * push-out, no contact volume - and the pose below forces `behaviour = IDLE`,
 * `targetKind = NONE`, `threat = 0` every tick, so the real ATTACK HFSM never
 * runs and its CONTACT state (90 of the player's 100 HP, bestiary damage row)
 * is unreachable. The same argument the Herald's crossings stand on.
 */

import { clamp, lerp, quat, vec3, smoothstep } from '../core/math.js';
import { LEVIATHAN_SITES } from '../world/leviathan_sites.js';
import { sampleHeight } from '../world/terrain.js';
import { BEHAVIOUR, TARGET, speciesIndexOf } from './creatures.js';

const SPLITMAW = speciesIndexOf('LEV_SPLITMAW');
const SITE = LEVIATHAN_SITES.find((s) => s.short === 'splitmaw');

/** Focus must be inside this XZ radius of the residency HOME (not the biome
 *  anchor) and below TRIGGER_DEPTH_Y for the ambush to arm - the same
 *  volume-gate shape as the abyss reveal's. 260 m covers the demo anchor
 *  (104.9 m out) and any free-play approach that has already committed to
 *  the plateau; the plateau floor runs 318-344 m down. */
const TRIGGER_RADIUS = 260;
const TRIGGER_DEPTH_Y = -280;
const ABORT_RADIUS = 500;

/** Phase timeline, seconds from arming. PROWL leaves the agent entirely to its
 *  own patrol AI - the pose only takes over at TURN_T, from wherever the patrol
 *  actually put it, so there is no takeover snap.
 *
 *  KEEP THE PROWL SHORT. Everything the patrol AI does looks like wandering,
 *  because it is: territorial boids around a home point. Playtest, 2026-08-21:
 *  "the leviathan spends too much time going in random directions. when we move
 *  towards him, he should notice us immediately and come eat us."
 *
 *  8 s is where the demo's diver finishes turning onto the bone field and starts
 *  the rise - and that leg's gaze is already down the splitmaw's own bearing, so
 *  it is ON CAMERA from about a second later. From here it is coming: nose on
 *  the lens, closing, for the whole climb. Nothing in front of the beat. */
const TURN_T = 8.0;

/** Seconds allowed to swing the nose onto the diver before the alignment gate
 *  is forced. It is a ceiling and not a duration: the run starts the moment the
 *  nose is actually on the lens (CHARGE_ALIGN), which off a patrol heading is
 *  usually about a second and a half. */
const TURN_MAX_T = 4.0;
const RELEASE_T = 34.0;

/** Metres of clear water under the focus before the splitmaw will commit, and a
 *  deadline that fires the take anyway.
 *
 *  A STOPWATCH ALONE COULD NOT KEEP THE CHARGE INSIDE THE SHOT. The demo's
 *  rise step is a `swimTo` with `maxT`, so how long the diver takes to get over
 *  the bone field depends on where the previous steps left them - measured, it
 *  ran the full 11 s and still timed out 20.4 m short - and a fixed TURN_T tuned
 *  against one run had the entire turn-in, charge and swallow happen DURING that
 *  rise, before the segment's own `watchFauna` had started. The delivered
 *  capture photographed the aftermath: 'tracking tier-5 at 18.1 m' and the
 *  climax already over.
 *
 *  So the trigger is the thing the scene is actually about - the diver leaving
 *  the seabed - with TURN_T as a floor under it and TURN_DEADLINE as a ceiling
 *  over it, because a take that never happens is worse than one that happens
 *  early. Free play gets the same behaviour for free: a diver who stays on the
 *  sand is not yet in open water, which is this animal's whole hunting premise.
 *
 *  IT IS ALSO NOT NEGOTIABLE FOR THE STRIKE TO LAND AT ALL. MIN_GROUND_CLEARANCE
 *  floors the posed body 22 m over the terrain, so the maw cannot reach a diver
 *  below that: at a delivered 12 m of clearance it passed TEN METRES OVERHEAD.
 *  Anything that lowers this has to lower that with it. */
const TURN_ALTITUDE = 18;
const TURN_DEADLINE = 26.0;

/** How fast the posed heading chases its aim, 1/s of a first-order lag.
 *
 *  IT USED TO BE A PER-TICK LERP OF 0.5, WHICH IS A SNAP AND NOT A TURN. At the
 *  120 Hz fixed step that reversed the heading in about forty milliseconds, and
 *  the wheel below makes the animal reverse: it comes off the outward bearing
 *  and has to point back down the same line. Forty milliseconds of that on a
 *  ninety-metre body is a cut, not a manoeuvre. 2.2/s puts the 180 through in
 *  roughly a second, while the charge's own speed ramp still has it slow, and
 *  it is frame-rate independent where the old constant was not. It is still far
 *  quicker than the datasheet's 20 deg/s - this is a pose, not the rigid body -
 *  but the aim converges long before SWALLOW_DIST either way, which is all the
 *  re-aim was ever for. */
const AIM_RATE = 2.2;

/** Run speed, m/s: the species' authored burstSpeed (21) shaved a hair so the
 *  pose never claims motion the datasheet says is impossible. */
const CHARGE_SPEED = 19.0;

/** Metres per second the splitmaw holds while it swings its nose onto the diver,
 *  and how aligned it has to be before the run starts.
 *
 *  THE STRIKE HAS TO BE HEAD-ON. The pose takes over from a patrol heading that
 *  points anywhere, the aim is a first-order lag (AIM_RATE), and the run only
 *  has 50-odd metres before SWALLOW_DIST - so accelerating straight out of the
 *  takeover spent the whole run turning, and one delivered fade landed on a
 *  FLANK filling the left of frame with the head off-camera.
 *
 *  So the speed is gated on the ALIGNMENT rather than on a clock: it idles
 *  through the turn, barely closing, and the ramp does not start until the nose
 *  is actually pointed at the lens. TURN_MAX_T is only a backstop.
 *
 *  A BROADSIDE CROSS USED TO SIT BETWEEN THE TWO AND IT IS GONE. It held a
 *  tangential heading for six seconds to show the camera the whole body in
 *  profile - the one framing that reads the anguilliform wave - and it did that
 *  well, but from the seat it is six seconds of an animal that has seen you and
 *  is not coming. The playtest called it "going in random directions". A wheel
 *  straight AWAY was tried before that and was worse: this water only carries
 *  the silhouette to about 110 m, so at 152 m the animal left the shot
 *  altogether. The display is not worth the delay; the wave still reads on the
 *  turn-in, which is oblique. */
const CHARGE_ENTRY = 3.0;
const CHARGE_ALIGN = 0.985;

/** The approach before the run: metres per second while the diver is still
 *  climbing, and the range it will not close inside until they are up.
 *
 *  THE STRIKE CANNOT LAND ON A DIVER WHO IS STILL ON THE SEABED (see
 *  TURN_ALTITUDE), but WAITING for them is what put a prowl back in the shot.
 *  So it does not wait, it STALKS: squared up, nose on the lens, closing at a
 *  sixth of its burst - which is the same information as a charge, delivered
 *  over the seven seconds the climb takes instead of after them.
 *
 *  STALK_HOLD is the floor under that, and it is not a comfort margin - it is
 *  the RUN'S RUNWAY. Everything inside SWALLOW_DIST (66.5 m) is already inside
 *  the mouth, so a stalk that closes to 80 m leaves thirteen metres to charge
 *  down and the strike is over in a second. Measured that way once: the swallow
 *  landed 0.4 s before the camera even reached the beat. At 100 the run has
 *  33.5 m, about two and a half seconds, and 100 is still inside this water's
 *  ~110 m silhouette range so the hold is spent legible.
 *
 *  RUN_T is a FLOOR under the release, in phase-clock seconds. The run is
 *  released by the diver clearing the bones, and the diver clears them while
 *  the demo's climb step is still running - so without a floor the strike can
 *  land before the shot that is meant to hold it has started. It is a floor and
 *  not a wait: the splitmaw is squared up and closing throughout. */
const STALK_SPEED = 6.0;
const STALK_HOLD = 100;
const RUN_T = 15.0;

/** Snout offset from the body centre: length/2 of a 90 m animal. Doubled with
 *  the record on 2026-08-21. */
const SNOUT_AHEAD = 45;

/** Centre-to-focus distance at which the lens is INSIDE THE MOUTH, and the
 *  point the segment cuts on.
 *
 *  The mandible horns reach `mandibles.length * 0.9` ahead of the snout station
 *  (addMandibles extrudes each one to `z0 - len * (0.10 + 0.90 * t)`), so the
 *  four tips cross the eye at 45 + 11.5 m centre-to-focus and everything closer
 *  than that is jaw. There is no stop here - the charge runs straight on
 *  through and out the far side. This is a LATCH, not a ring.
 *
 *  PLUS TEN METRES OF LEAD, BECAUSE THE CONSUMER OF THIS LATCH IS A FADE. The
 *  demo cuts on it and its fade takes half a second, in which the body covers
 *  another 9.5 m - so latching exactly at the tips left the last SEEN frames
 *  taken from inside the horn cage, which is the "solid featureless body ...
 *  read as an abstract wall" the earlier round already rejected once. With the
 *  lead, black lands as the tips reach the lens and the last legible frame is
 *  the open maw filling the screen. The swallow itself still happens; it just
 *  happens behind the fade, which is the only place it can look like anything. */
const SWALLOW_LEAD = 10;
const SWALLOW_DIST = SNOUT_AHEAD + 11.5 + SWALLOW_LEAD;

/** Jaw begins opening this many metres (centre-to-focus) out and reaches the
 *  full 1.0 as the horn tips reach the lens.
 *
 *  THE MAW IS SHUT UNTIL IT IS COMMITTED, AND THAT IS THE WHOLE BEAT. It used
 *  to carry a hunting 0.12 from the moment the pose took over and start opening
 *  at 75 m, so every delivered frame from acquisition onward already showed
 *  splayed mandibles (feedback5 beats 41 and 43) and the playtest read the
 *  arrival and the strike as one continuous state: "the mouth should initially
 *  be closed and as it gets closer to us, it opens up as to swallow us". Zero
 *  upstream (the animator's own IDLE settle, ~0.04, is a closed jaw and the
 *  Math.max write below keeps it for free) and a 55 m smoothstep makes the
 *  opening an ACT rather than a state.
 *
 *  110 m, doubled with the animal (2026-08-21). The window has to scale with
 *  BOTH the size and the distances: at 19 m/s this is 55 m of approach after
 *  subtracting SWALLOW_DIST, so the gape still runs over roughly the last three
 *  seconds, which is what made it read as an act at 45 m of animal.
 *
 *  IT NOW DRIVES THE HORNS TOO. `jawOpen` is what creature.wgsl's ROLE_MANDIBLE
 *  branch folds the four mandible bones on, so this one smoothstep opens the
 *  maw and springs the cage at the same time - which is exactly the beat the
 *  playtest asked for, and is why the horns needed bones rather than a second
 *  scalar that would have to be kept in sync with this one. */
const JAW_OPEN_START = 110;

/** Minimum clearance the posed body keeps over the heightfield, metres.
 *
 *  The charge is a straight line from wherever the patrol was to wherever the
 *  diver is, and on the dune plateau that line ran THROUGH the bone field: the
 *  splitmaw ploughed the duneColossus ribcage on the way in
 *  (feedback5 beat 41, the reported clipping). The diver's own rise
 *  lifts the line most of the way, but a focus that stays low - free play, or a
 *  demo step that times out short - must not put the animal back in the sand.
 *  22 m clears the tallest authored bone arch with margin and is below the
 *  site's own 24 m hover, so an untriggered patrol is unaffected. */
const MIN_GROUND_CLEARANCE = 22;

export const DUNE_AMBUSH_PHASE = Object.freeze({
  DORMANT: 0,
  PROWL: 1,
  TURN: 2,
  CHARGE: 3,
  /** The lens is inside the maw. Latched - the charge does not slow for it -
   *  and the demo's `watchFauna until:` predicate cuts the segment on it. */
  SWALLOW: 4,
  RELEASED: 5,
});

const _dir = vec3.create();
const _q = quat.create();

export class DuneAmbush {
  /** @param {object} sim the live CreatureSim */
  constructor(sim) {
    this.sim = sim;
    this.phase = DUNE_AMBUSH_PHASE.DORMANT;
    this.elapsed = 0;
    this.handle = -1;
    this.completed = false;
    // Pose integration state: the charge integrates its own position from
    // the takeover point rather than evaluating an authored path, because
    // the takeover point is wherever the live patrol happened to be.
    this._px = 0; this._py = 0; this._pz = 0;
    this._hx = 0; this._hy = 0; this._hz = 0;   // heading unit vector
    this._posed = false;
    /** Set once the prowl's two gates are satisfied; `_commitT` re-bases the
     *  phase clock so TURN and CHARGE keep their durations. */
    this._committed = false;
    this._commitT = 0;
    /** Latched when the wheel has made room (or run out of time); from here the
     *  pose is the run itself. `_chargeT` is the phase clock at the latch. */
    /** Phase clock at the moment the nose came onto the lens; the speed ramp
     *  is measured from it. */
    this._chargeT = 0;
    /** Set once the nose is on the lens; until then the pose idles round. */
    this._aligned = false;
    /** Set once the diver is clear of the seabed and the run is released. */
    this._running = false;
  }

  /** Re-arm for the next visit. Called from jumpTo like the residencies;
   *  never despawns - the animal is the residency's, not this module's. */
  reset() {
    this.phase = DUNE_AMBUSH_PHASE.DORMANT;
    this.elapsed = 0;
    this.handle = -1;
    this.completed = false;
    this._posed = false;
    this._committed = false;
    this._commitT = 0;
    this._chargeT = 0;
    this._aligned = false;
    this._running = false;
  }

  _findResident() {
    const live = this.sim.liveSlots();
    for (let k = 0; k < live.length; k++) {
      const i = live[k];
      if (this.sim.species[i] !== SPLITMAW) continue;
      const dx = this.sim.posX[i] - SITE.x, dz = this.sim.posZ[i] - SITE.z;
      if (dx * dx + dz * dz < 400 * 400) return i;
    }
    return -1;
  }

  /**
   * @param {number} dt fixed sim step
   * @param {ArrayLike<number>} focus player or vessel absolute position
   */
  update(dt, focus) {
    if (this.completed || !SITE || SPLITMAW < 0 || !focus) return;

    if (this.phase === DUNE_AMBUSH_PHASE.DORMANT) {
      const dx = focus[0] - SITE.x, dz = focus[2] - SITE.z;
      if (dx * dx + dz * dz > TRIGGER_RADIUS * TRIGGER_RADIUS) return;
      if (focus[1] > TRIGGER_DEPTH_Y) return;
      const slot = this._findResident();
      if (slot < 0) return;               // residency hasn't spawned it yet; retry
      this.handle = this.sim.handleOf(slot);
      this.phase = DUNE_AMBUSH_PHASE.PROWL;
      this.elapsed = 0;
    }

    const slot = this.sim.slotOf(this.handle);
    if (slot < 0 || !this.sim.isAlive(this.handle)) { this.completed = true; return; }

    // A focus that leaves the plateau mid-take gets the animal back on AI
    // immediately - same abort the abyss reveal carries.
    {
      const dx = focus[0] - SITE.x, dz = focus[2] - SITE.z;
      if (dx * dx + dz * dz > ABORT_RADIUS * ABORT_RADIUS) { this._release(slot); return; }
    }

    this.elapsed += Math.max(0, dt);
    const t = this.elapsed;

    // Clear of the seabed? This is what RELEASES THE RUN, not what starts the
    // approach - the splitmaw squares up and stalks in regardless (see
    // STALK_SPEED), because waiting for the climb is what put a prowl back in
    // the shot. The deadline is the never-stall: a diver who stays on the sand
    // gets the run anyway rather than an animal holding station forever.
    const risen = focus[1] - sampleHeight(focus[0], focus[2]) >= TURN_ALTITUDE
      || t >= TURN_DEADLINE;

    // PROWL: the patrol AI owns the body. Nothing to write.
    if (!this._committed) {
      if (t < TURN_T) {
        this.phase = DUNE_AMBUSH_PHASE.PROWL;
        return;
      }
      // Re-base the phase clock on the commit so what follows keeps its
      // authored durations however long the prowl ran.
      this._committed = true;
      this._commitT = t;
    }
    const tp = TURN_T + (t - this._commitT);

    if (!this._posed) {
      // Takeover: adopt the live position and the live swim direction.
      this._px = this.sim.posX[slot]; this._py = this.sim.posY[slot]; this._pz = this.sim.posZ[slot];
      vec3.set(_dir, this.sim.velX[slot], this.sim.velY[slot], this.sim.velZ[slot]);
      if (vec3.len(_dir) < 0.5) vec3.set(_dir, Math.sin(SITE.yaw ?? 0), 0, -Math.cos(SITE.yaw ?? 0));
      vec3.normalize(_dir, _dir);
      this._hx = _dir[0]; this._hy = _dir[1]; this._hz = _dir[2];
      this._posed = true;
    }

    // Where the maw should aim: the lens, a shade above the focus origin.
    const tx = focus[0], ty = focus[1] + 0.6, tz = focus[2];
    let ax = tx - this._px, ay = ty - this._py, az = tz - this._pz;
    const dist = Math.hypot(ax, ay, az);
    if (dist > 1e-4) { ax /= dist; ay /= dist; az /= dist; }

    // ONE MOVE, THREE SPEEDS, AND NO WAITING ANYWHERE IN IT: square up, stalk in
    // while the diver climbs, then run. The pose aims at the LIVE focus from the
    // first tick - there is no phase between noticing and coming - and what
    // separates the three is the state of the body and of the diver, never a
    // beat on a clock.
    //
    // ONCE THE PHASE LATCHES TO SWALLOW THE HEADING FREEZES, and it has to. The
    // aim vector is centre-to-focus, so the instant the body centre passes the
    // diver that vector REVERSES - a re-aimed pose would spin the animal on the
    // spot and swim it back out of its own mouth. From the latch on it is
    // ballistic: same heading, same speed, ninety metres of animal streaming
    // past the lens until RELEASE_T hands it back.
    const swallowing = dist <= SWALLOW_DIST || this.phase === DUNE_AMBUSH_PHASE.SWALLOW;
    if (!swallowing) this._aim(ax, ay, az, AIM_RATE, dt);

    let speed;
    if (swallowing) {
      this.phase = DUNE_AMBUSH_PHASE.SWALLOW;
      speed = CHARGE_SPEED;
    } else if (!this._aligned) {
      // Squaring up - see CHARGE_ENTRY. It idles here, barely closing.
      this.phase = DUNE_AMBUSH_PHASE.TURN;
      if (this._hx * ax + this._hy * ay + this._hz * az >= CHARGE_ALIGN
          || tp - TURN_T >= TURN_MAX_T) this._aligned = true;
      speed = CHARGE_ENTRY;
    } else if (!this._running) {
      // Stalking in behind the climb - see STALK_SPEED. The run is released the
      // moment the diver is off the seabed, and the ramp's clock starts there,
      // so its timing does not depend on how long the climb took.
      this.phase = DUNE_AMBUSH_PHASE.TURN;
      if (risen && tp >= RUN_T) { this._running = true; this._chargeT = tp; }
      speed = dist <= STALK_HOLD ? 0.6 : STALK_SPEED;
    } else {
      this.phase = DUNE_AMBUSH_PHASE.CHARGE;
      const u = clamp((tp - this._chargeT) / 2.0, 0, 1);
      speed = lerp(STALK_SPEED, CHARGE_SPEED, u * (2 - u));
    }
    if (t >= RELEASE_T) { this._release(slot); return; }

    const nl = Math.hypot(this._hx, this._hy, this._hz);
    if (nl > 1e-4) { this._hx /= nl; this._hy /= nl; this._hz /= nl; }
    // Integrate, then lift the step clear of the bone field - see
    // MIN_GROUND_CLEARANCE. The lift is applied to the STEP and the step is
    // re-clamped to the same `speed * dt` budget, NEVER to the position
    // directly: snapping the altitude would teleport the body a few metres in
    // one tick, which is both a visible pop and a real burst-speed violation
    // (tools/test-dune-ambush.mjs section 3 measures exactly that). So a body
    // that starts the charge too low climbs out over a few ticks at its own
    // speed, and the heading is re-derived from the motion that actually
    // happened so the orientation can never point into the sand.
    let sx = this._hx * speed * dt;
    let sy = this._hy * speed * dt;
    let sz = this._hz * speed * dt;
    const floorY = sampleHeight(this._px + sx, this._pz + sz) + MIN_GROUND_CLEARANCE;
    if (this._py + sy < floorY) {
      sy = floorY - this._py;
      const sl = Math.hypot(sx, sy, sz);
      const budget = speed * dt;
      if (sl > budget && sl > 1e-6) { const k = budget / sl; sx *= k; sy *= k; sz *= k; }
      const ml = Math.hypot(sx, sy, sz);
      if (ml > 1e-6) { this._hx = sx / ml; this._hy = sy / ml; this._hz = sz / ml; }
    }
    this._px += sx;
    this._py += sy;
    this._pz += sz;

    const sim = this.sim;
    sim.posX[slot] = this._px; sim.posY[slot] = this._py; sim.posZ[slot] = this._pz;
    sim.hash.move(slot, this._px, this._py, this._pz);
    sim.velX[slot] = this._hx * speed; sim.velY[slot] = this._hy * speed; sim.velZ[slot] = this._hz * speed;
    sim.behaviour[slot] = BEHAVIOUR.IDLE; sim.state[slot] = 0; sim.stateT[slot] = 0;
    sim.targetKind[slot] = TARGET.NONE; sim.targetId[slot] = -1;
    sim.threat[slot] = 0; sim.fear[slot] = 0; sim.unseenT[slot] = 0;
    vec3.set(_dir, this._hx, this._hy, this._hz);
    quat.lookRotation(_q, _dir);
    const o = slot * 4;
    sim.orient[o] = _q[0]; sim.orient[o + 1] = _q[1]; sim.orient[o + 2] = _q[2]; sim.orient[o + 3] = _q[3];

    // Jaw schedule, written AFTER _animate's pull (see the header): SHUT until
    // the approach commits, then a smoothstep to full as the horn tips reach
    // the lens. See JAW_OPEN_START for why the old hunting gape was withdrawn,
    // and note this same scalar folds the four mandible bones open.
    //
    // It is HELD at 1 through the swallow: `dist` starts climbing again the
    // moment the body centre passes the diver, and a gape derived from it alone
    // would snap the maw shut around the lens on the way out.
    //
    // Nothing is written before the run latches, either. The wheel starts from
    // inside JAW_OPEN_START and swims OUT through it, so a purely
    // distance-driven gape cracked the maw during the wheel and then left it
    // decaying open on the way out - measured 0.372 at 115 m, which is a
    // hunting gape on an animal that has not committed to anything yet.
    const gape = this.phase === DUNE_AMBUSH_PHASE.SWALLOW ? 1
      : !this._running || dist > JAW_OPEN_START ? 0
        : 1 - smoothstep(SWALLOW_DIST, JAW_OPEN_START, dist);
    if (gape > 0) sim.jawOpen[slot] = Math.max(sim.jawOpen[slot], gape);
  }

  /** Chase the unit aim vector with a frame-rate-independent first-order lag,
   *  renormalising as it goes. `rate` is 1/s; 0 holds the current heading. */
  _aim(ax, ay, az, rate, dt) {
    const k = 1 - Math.exp(-Math.max(0, rate) * Math.max(0, dt));
    this._hx = lerp(this._hx, ax, k);
    this._hy = lerp(this._hy, ay, k);
    this._hz = lerp(this._hz, az, k);
  }

  /** Hand the agent back to its own AI, threat clean, still moving the way it
   *  was. The old upward shove is gone with the hold: an animal that has just
   *  swum THROUGH the diver is already leaving, and adding lift to a straight
   *  exit only bent it. */
  _release(slot) {
    const sim = this.sim;
    if (slot >= 0) {
      sim.behaviour[slot] = BEHAVIOUR.IDLE;
      sim.state[slot] = 0; sim.stateT[slot] = 0;
      sim.targetKind[slot] = TARGET.NONE; sim.targetId[slot] = -1;
      sim.threat[slot] = 0;
      sim.homeX[slot] = SITE.x;
      sim.homeY[slot] = SITE.seabedY + SITE.hoverAbove;
      sim.homeZ[slot] = SITE.z;
      sim.territoryR[slot] = SITE.territoryR;
      // Keep the exit velocity on the charge heading so the handback is not a
      // visible kink; the territorial AI turns it home in its own time.
      sim.velX[slot] = this._hx * 8; sim.velY[slot] = this._hy * 8; sim.velZ[slot] = this._hz * 8;
    }
    this.phase = DUNE_AMBUSH_PHASE.RELEASED;
    this.completed = true;
  }
}
