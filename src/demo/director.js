/**
 * The showcase demo director: a segment state machine that flies the authored
 * route in demo/script.js hands-free, and hands control back the moment the
 * viewer asks for it (the demo key, or Escape).
 *
 * CONTROL OWNERSHIP IS A MODE, AND THIS FILE IS ITS WHOLE BOUNDARY. While the
 * demo runs, Game._simulate hands the player and the vessel a VirtualInput
 * (below) instead of the real InputManager - the same object shape
 * Player.simulate and Vessel.simulate already accept ("or anything with the
 * same queries"). The control contract's pointer-owns-aim clause governs PLAY;
 * this mode is entered only by the demo key and exited by it or Escape, so
 * inside it the director is the pointer: it emits look deltas through the same
 * look() drain, at a cinematic rate limit, and the aim/heading integration
 * downstream is untouched. Nothing here writes the aim, the yaw or the pitch
 * directly - the deltas go through the one door the hand normally uses.
 *
 * THE ABORT IS WIRED AT THE DOM EVENT (InputManager.onRawInput), not polled
 * from the action layer, because edge state is consumed by the simulation and
 * a poller can lose the race. ONLY the demo key (whose press/again-to-stop is
 * owned by the toggle in Game._frame - aborting on it here would let the very
 * same press restart the demo one frame later) and Escape stop the demo. It
 * used to be any input at all, and that made the demo unwatchable as a demo:
 * alt-tabbing away to take notes aborted it on the AltLeft keydown, and a
 * nudged mouse killed it mid-scene. A viewer who wants out has two obvious,
 * stated exits; everything else is a spectator shifting in their seat. The
 * stop restores every latch it touched: time of day, suit lamp, camera mode,
 * controls legend, and the real input's pending mouse accumulator (which
 * nobody drained while the virtual input was the consumer - handing it back
 * full would deliver one giant look step).
 *
 * NAVIGATION IS ROBUST, NOT PERFECT, BY DESIGN. Waypoint steering writes aim +
 * throttle and lets Vessel._directControl fly, or writes the same commanded
 * swim direction the keys produce and lets the swim contract's first-order lag
 * be the whole smoothing. Collision pushes back and small deviations are
 * accepted; every segment and every step carries a timeout, so the demo NEVER
 * stalls - a blocked waypoint costs its scene and the run moves on. Cuts go
 * through game.jumpTo(), the sanctioned mechanism, so gear grants, residency
 * resets and the caveArrival re-seat all behave exactly as the jump menu's.
 */

import { ACTION } from '../core/input.js';
import { vec3, quat, clamp, lerp, wrapAngle } from '../core/math.js';
import { DemoRecorder } from './recorder.js';
import { speciesIndexOf } from '../entities/creatures.js';
import { SEGMENTS } from './script.js';

/** Cinematic look-rate limits, rad/s. The vessel's own DIRECT_AIM_TAU adds its
 *  0.09 s lag downstream, so these read as camera moves, not snaps. */
const LOOK_RATE_SWIM = 1.5;
const LOOK_RATE_VESSEL = 1.1;
/** First-order ease on the look approach, seconds. */
const LOOK_TAU = 0.45;
/**
 * ANGULAR ACCELERATION CAP, rad/s^2. THE EASE USED TO BE ONE-SIDED.
 *
 * The approach below is a constant-rate slew far from the target and an
 * exponential settle near it - so it eases OUT and never eases IN, and every
 * retarget (which is every step boundary) started at full rate on its first
 * frame. On film that reads as the sequence the playtest described: "going only
 * forward and then only turning before only going forward again". A human hand
 * accelerates. Capping the CHANGE in angular rate is the whole difference, and
 * it costs one scalar per axis.
 *
 * Sized so a full-rate swing takes ~0.6 s to spin up: 1.5 / 2.5 on foot,
 * 1.1 / 1.6 in the cockpit. Both are far above what a `turn` step's smoothstep
 * ever asks for, so an authored sweep still runs exactly to its `dur`.
 */
const LOOK_ACCEL_SWIM = 2.5;
const LOOK_ACCEL_VESSEL = 1.6;
/**
 * CORNERING LOOK-AHEAD. Default window, metres, inside which a navigation step
 * blends its gaze and its thrust toward the NEXT navigable step's.
 *
 * A leg used to own one gaze target for its whole length and hand over at the
 * boundary, which is what made every corner a stop-turn-go. Blending over the
 * last few metres is what a player does: they are already looking into the turn
 * while still swimming out of the straight. Authorable per step as `lead`.
 */
const LEAD_SWIM = 9;
const LEAD_WALK = 5;
const LEAD_FLY = 110;
/**
 * The thrust blend is capped below 1 while the gaze blend is not. The gaze may
 * hand over completely - looking at the next subject early is the point - but
 * steering fully onto the next waypoint before reaching this one would leave a
 * leg unable to close its own `arriveR`. The waypoint-passed test in
 * _navBlend() is what actually retires a step that has been rounded.
 */
const LEAD_MOVE_MAX = 0.62;
/** Fade timings, seconds. The hold needs only to guarantee one fully black
 *  sim step for the cut itself; the arrival's scatter prime and TAA reset
 *  land on the first fade-in frames, which are still >80% black. It was 0.30
 *  and, together with the zeroed input the old cut-out returned, read as the
 *  demo stopping at every segment boundary. */
const FADE_OUT = 0.45;
const FADE_HOLD = 0.10;
const FADE_IN = 0.85;
/**
 * The scene-title card: seconds of fade-in, full hold, and fade-out from the
 * moment a segment's body begins (i.e. after the cut's black). The whole
 * envelope is shorter than any segment, so a card never survives into the
 * next scene; the alpha rides the HUD canvas, so demoFade still dims it at a
 * boundary exactly like every other instrument.
 */
const TITLE_IN = 0.7;
const TITLE_HOLD = 3.6;
const TITLE_OUT = 0.9;

/**
 * The attribution credit, bottom-right: what made this. Same envelope shape as
 * the title card and the three numbers SUM TO CREDIT_TOTAL by construction.
 *
 * THE CLOCK STARTS AT THE FIRST `run` STEP, NOT AT start(). A run opens with a
 * cut to black (FADE_OUT + FADE_HOLD + FADE_IN), and counting the credit's ten
 * seconds from the key press would spend the first ~0.6 s of them behind a
 * black screen - the viewer would get nine. Starting at the first run step
 * makes the ten seconds ten seconds of PICTURE.
 *
 * It is shown only on a full-route start (see _creditArmed in start()). A
 * mid-route entry through start(i) is an authoring/harness entry, not a
 * showing, and tools/test-parity.mjs pauses two of its arms inside this
 * window - an overlay alive there would be a difference between its two arms
 * and nothing else.
 */
const CREDIT_TEXT = 'Fable/Opus 5';
const CREDIT_IN = 0.6;
const CREDIT_HOLD = 8.5;
const CREDIT_OUT = 0.9;
const CREDIT_TOTAL = CREDIT_IN + CREDIT_HOLD + CREDIT_OUT;

/** DOM overlays that must fade with the picture - see _applyFade(). */
const FADED_DOM_IDS = ['stats', 'interaction-prompt'];

/**
 * The ONLY key besides the demo key itself that stops the demo. Everything
 * else - other keys, mouse buttons, wheel, mouse motion - is deliberately
 * ignored so a viewer can alt-tab to another app, take notes, or bump the
 * desk without killing the show. This also retires the measured headless
 * Chrome ghost-key carve-outs (phantom NumLock streams, a held Numpad5) that
 * the any-input abort needed: a ghost key that is not Escape now simply does
 * nothing.
 */
const ABORT_CODE = 'Escape';

/** Segment SKIP keys, live only while the showcase is running.
 *
 *  AUTHORING A LATE SCENE MEANS PLAYING THE ROUTE AHEAD OF IT, and for the
 *  dunes climax that is five minutes per look. The J menu is not a substitute:
 *  it teleports to the anchor, and the Splitmaw's whole beat is the AMBUSH -
 *  DuneAmbush arms off the cut, waits for the diver to rise, crosses and runs -
 *  so a bare jump photographs a patrol silhouette that never notices the
 *  camera. That is exactly the failure the module was written to fix.
 *
 *  Skipping goes through _advanceSegment, so it takes the same fade and the
 *  same cut a natural boundary would, and REPLAY re-enters the segment through
 *  its own cut - which is what re-arms the ambush, since jumpTo() resets the
 *  residencies and DuneAmbush with it. Not bound to a game ACTION: input is
 *  virtual while the demo runs, and these are the only two raw keys besides
 *  Escape the director listens to. */
const SKIP_NEXT_CODE = 'Period';
const SKIP_REPLAY_CODE = 'Comma';

/**
 * An index or a segment `id` into an index. Out-of-range clamps; an unknown id
 * warns and falls back to 0, because silently playing the wrong scene is how a
 * mis-typed name costs a whole authoring pass.
 *
 * @param {number|string} at
 * @returns {number} a valid index into SEGMENTS
 */
function resolveSegment(at) {
  if (typeof at === 'string') {
    const i = SEGMENTS.findIndex((s) => s.id === at);
    if (i >= 0) return i;
    console.warn(`[demo] no segment '${at}'; starting at 0. ids: `
      + SEGMENTS.map((s) => s.id).join(', '));
    return 0;
  }
  return clamp(Math.trunc(at) || 0, 0, SEGMENTS.length - 1);
}

const _p = vec3.create();
const _q = vec3.create();
const _fwd = vec3.create();
const _right = vec3.create();
/** Cornering scratch: the resolved next-step gaze and move targets. */
const _nextLook = vec3.create();
const _nextMove = vec3.create();
const _gaze = vec3.create();
const _dir = vec3.create();
/** watchFauna's aimBody scratch: the tracked animal's nose axis and its
 *  orientation quaternion lifted out of the sim's flat SoA. */
const _bodyAxis = vec3.create();
const _bodyQuat = quat.create();

/**
 * The demo's stand-in for the InputManager: the exact query surface
 * Player.simulate and Vessel.simulate read, driven by the director each step.
 *
 * Edges (`wasPressed`) are armed for exactly one sim step; look deltas are
 * consumed by the one look() call the step makes, mirroring the drain
 * contract of the real accumulator.
 */
class VirtualInput {
  constructor() {
    this.forward = 0;   // MOVE_FORWARD / THROTTLE axis
    this.strafe = 0;    // MOVE_RIGHT
    this.vertical = 0;  // MOVE_UP
    this.sprint = false;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this._pressed = new Set();
  }

  /** Zero everything that must not leak across steps. */
  reset() {
    this.forward = 0; this.strafe = 0; this.vertical = 0;
    this.sprint = false;
    this.lookYaw = 0; this.lookPitch = 0;
    this._pressed.clear();
  }

  press(action) { this._pressed.add(action); }

  /** Same drain contract as InputManager.look(); dt is accepted and unused
   *  because the deltas are already per-step quantities. */
  look(out, dt) {
    out[0] = this.lookYaw;
    out[1] = this.lookPitch;
    this.lookYaw = 0;
    this.lookPitch = 0;
    return out;
  }

  moveVector(out) {
    const len = Math.hypot(this.strafe, this.forward);
    if (len > 1) { out[0] = this.strafe / len; out[1] = this.forward / len; }
    else { out[0] = this.strafe; out[1] = this.forward; }
    return out;
  }

  axis(action) {
    switch (action) {
      case ACTION.THROTTLE:
      case ACTION.MOVE_FORWARD: return clamp(this.forward, -1, 1);
      case ACTION.MOVE_RIGHT: return clamp(this.strafe, -1, 1);
      case ACTION.MOVE_UP: return clamp(this.vertical, -1, 1);
      default: return 0;
    }
  }

  isDown(action) { return action === ACTION.SPRINT ? this.sprint : false; }
  wasPressed(action) { return this._pressed.has(action); }
  wasPressedOnce(action) { return false; }
  wasReleased() { return false; }
}

export class DemoDirector {
  /** @param {object} game the Game instance (src/main.js) */
  constructor(game) {
    this.game = game;
    this.input = new VirtualInput();

    /** True from start() until stop(); Game._simulate branches on it. */
    this.active = false;
    /** Run notes: what was tracked, what timed out. Read by the harness. */
    this.notes = [];

    this._segIndex = -1;
    this._segment = null;
    this._segElapsed = 0;
    this._stepIndex = 0;
    this._stepElapsed = 0;
    this._stepState = null;
    this._totalElapsed = 0;

    // 'idle' | 'cut-out' (fading to black; the black hold lives inside it,
    // via _fadeHold) | 'run' | 'finish-out'
    this._phase = 'idle';
    this._fadeOpacity = 0;
    this._fadeHold = 0;
    /** Seconds a `fadeOut` step asked the picture to take to reach black
     *  WHILE THE SEGMENT IS STILL RUNNING; 0 = no early fade pending. See the
     *  step in _runStep for why a route ever wants one. */
    this._fadeEarly = 0;

    this._saved = null;
    this._unsubRaw = null;
    /** @type {DemoRecorder|null} live only while a Shift+G run is recording. */
    this._recorder = null;
    /** Scene-title card state: uppercased text and seconds since its segment
     *  began. Infinity parks the envelope at alpha 0 between runs. */
    this._titleText = '';
    this._titleT = Infinity;
    /** Attribution credit state: armed only by a full-route start, and its
     *  clock held at Infinity until the first `run` step releases it (see the
     *  CREDIT_* block). Infinity parks the envelope at alpha 0. */
    this._creditArmed = false;
    this._creditT = Infinity;
    /** Segment lamp GOAL (true/false), serviced through the real FLASHLIGHT
     *  action in beginStep; null = no goal pending. */
    this._lampGoal = null;
    /** Last motion the run phase emitted, re-played through fades so a
     *  segment boundary is a glide into black, not a commanded stop. */
    this._carry = { forward: 0, strafe: 0, vertical: 0, sprint: false };
    /** Live angular rate of the gaze, rad/s, per axis. Carried ACROSS steps on
     *  purpose - that continuity is what makes a corner one motion instead of
     *  two - and zeroed at a cut, where the picture is black anyway. */
    this._lookRateYaw = 0;
    this._lookRatePitch = 0;
    /** Set by _emitLookAngles each step; beginStep decays the rates when a step
     *  emitted no gaze at all, so the next one still eases in from rest. */
    this._lookEmitted = false;
    /** Written by _peekNextNav() into the module scratch _nextLook/_nextMove. */
    this._nextHasLook = false;
    this._nextHasMove = false;
  }

  /** Window-visible state for tools/demo-capture.mjs. */
  get state() {
    return {
      active: this.active,
      phase: this._phase,
      segment: this._segment ? this._segment.id : null,
      index: this._segIndex,
      elapsed: this._segElapsed,
      step: this._stepIndex,
      total: this._totalElapsed,
      notes: this.notes,
      /** True only on a Shift+G run. tools/demo-capture.mjs asserts it FALSE:
       *  the harness dispatches an unmodified KeyG and must never write video
       *  into a headless profile. */
      recording: !!this._recorder,
    };
  }

  // NOTE deliberately NO beats() accessor here: the capture harness reads the
  // segment/beat table by importing /src/demo/script.js in the page, so a
  // director-side copy would be an export with no importer - this project's
  // most repeated bug class.

  /**
   * One key starts it; the same key (or Escape) stops it.
   *
   * @param {{record?: boolean}} [opts] `record: true` is Shift+G - see start().
   */
  toggle(opts) {
    if (this.active) this.stop('demo key');
    else this.start(0, opts);
  }

  /**
   * @param {number|string} [atSegment] first segment to play, for authoring a
   *   single scene without sitting through the route ahead of it. An INDEX or a
   *   segment `id` - `subwave.demo.start('sunken-dunes')` beats counting rows in
   *   script.js, and the id survives an insertion earlier in the route where an
   *   index does not. Unknown ids fall back to 0 with a console warning rather
   *   than silently playing the beach. The key always starts at 0.
   * @param {{record?: boolean}} [opts] `record: true` captures the canvas to a
   *   video file the browser downloads when the run ends - Shift+G, opt-in, so
   *   a plain G (and tools/demo-capture.mjs, which dispatches an unmodified
   *   KeyG) behaves exactly as it always has and writes no file.
   */
  start(atSegment = 0, { record = false } = {}) {
    const g = this.game;
    if (this.active || !g.started || g.paused || !g.player.alive) return;
    this.active = true;
    this.notes = [];
    this._totalElapsed = 0;
    this._lampGoal = null;
    this._carry.forward = 0; this._carry.strafe = 0;
    this._carry.vertical = 0; this._carry.sprint = false;
    this._lookRateYaw = 0; this._lookRatePitch = 0;

    // Everything the demo may touch, saved once and restored on ANY exit.
    // Vessel pose included: the beach-dawn onStart re-parks a far-away hull
    // ~0.75 s after the key press - faster than a regretted press can abort -
    // and the review's scenario (vessel parked at the kelp forest, tap G,
    // instant abort, hull silently kilometres away) is real. Restored only
    // when the player is NOT piloting at exit: a hull they are flying is
    // theirs, wherever the demo left it.
    this._saved = {
      dayFraction: g.worldClock.dayFraction,
      lampOn: g.player.lampOn,
      cameraMode: g.vessel.cameraMode,
      legendEnabled: g.controlsHint.enabled,
      timeTouched: false,
      vesselPos: [g.vessel.position[0], g.vessel.position[1], g.vessel.position[2]],
      vesselYaw: g.vessel.aimYaw ?? 0,
      vesselPitch: g.vessel.aimPitch ?? 0,
      wantsPointerLock: g.input.wantsPointerLock,
    };
    // The legend is chrome over a cinematic; the HUD stays, it is part of the
    // showcase. controlsHint.update() hides itself while enabled is false.
    g.controlsHint.enabled = false;

    // Release the pointer: the demo never reads the mouse, and a locked
    // pointer makes the browser consume the first Escape to exit the lock
    // instead of delivering it - the stated stop key would need two presses.
    // A free cursor is also what lets the viewer click another window.
    // wantsPointerLock too, or the mousedown handler re-locks on the first
    // click (clicks no longer abort) and Escape goes back to needing two.
    g.input.wantsPointerLock = false;
    g.input.exitPointerLock();

    // Started only after the refusal checks above, so a start that never
    // happens never opens an encoder. A recorder that declines to start warns
    // and returns false - the showcase is the feature, the file is a byproduct.
    if (record) {
      const rec = new DemoRecorder();
      if (rec.start(g.canvas)) {
        this._recorder = rec;
        this._showRecIndicator(true);
      }
    }

    this._unsubRaw = g.input.onRawInput((kind, code, dx, dy) => this._onRaw(kind, code, dx, dy));

    const from = resolveSegment(atSegment);
    // Arm the credit for a SHOWING - a run of the route from the top, which is
    // what G and Shift+G do. start(i) into the middle is an authoring or
    // harness entry (tools/demo-capture.mjs --only, tools/test-parity.mjs) and
    // gets no overlay. Armed, not started: the clock is released by the first
    // `run` step so the ten seconds are ten seconds of picture, not of the
    // opening fade. See the CREDIT_* block.
    this._creditArmed = from === 0;
    this._creditT = Infinity;

    this._segIndex = from - 1;
    this._advanceSegment();
    console.info('[demo] showcase started - G or Escape stops it, '
      + '"." skips to the next segment, "," replays the current one');
  }

  /**
   * Stop and RESTORE. Idempotent; safe from a DOM handler mid-frame or from
   * inside a step. `reason` lands in the console and the notes so a capture
   * report can say why a run ended.
   */
  stop(reason) {
    if (!this.active) return;
    this.active = false;
    const g = this.game;
    const finished = reason === 'finished';

    if (this._unsubRaw) { this._unsubRaw(); this._unsubRaw = null; }

    // Take the scene-title card down with the run; frameUpdate() no longer
    // writes it once active is false, so a stale one would otherwise linger.
    this._titleText = '';
    this._titleT = Infinity;
    this._creditArmed = false;
    this._creditT = Infinity;
    if (g.hud) {
      g.hud.demoTitle = ''; g.hud.demoTitleAlpha = 0;
      g.hud.demoCredit = ''; g.hud.demoCreditAlpha = 0;
    }

    // Finalise the take on EVERY exit path. An Escape abort saves what it has -
    // a partial run is still footage, and discarding it is the one outcome a
    // viewer cannot undo. Fired and forgotten on purpose: stop() is called from
    // a DOM handler and from inside a fixed step, it must stay synchronous and
    // idempotent, and DemoRecorder.stop() never rejects. Cut here rather than
    // after the restores below so the file ends on the demo's own black frame
    // instead of on the first frame of restored play.
    if (this._recorder) {
      const rec = this._recorder;
      this._recorder = null;
      this._showRecIndicator(false);
      rec.stop().catch((err) => console.warn('[demo] recording:', err));
    }

    this._lampGoal = null;

    const s = this._saved;
    if (s) {
      if (s.timeTouched) {
        g.worldClock.setDayFraction(s.dayFraction);
        g.renderer.resetAdaptation();
      }
      // DIRECT WRITES, DELIBERATELY, and only here: with `active` false there
      // is no sim step left to press a virtual action into, and what is being
      // re-established is the player's OWN saved state - the scenario-setup
      // carve-out the real-demo contract itself grants. Everything the
      // RUNNING demo does goes through VirtualInput actions (see _runStep's
      // lamp/camera steps); the _chaseValid invalidation mirrors the real
      // CAMERA_TOGGLE handler byte for byte.
      g.player.lampOn = s.lampOn;
      // The chase bias is the director's own instrument and has no saved value:
      // free play never writes it, so the restore is unconditionally 0. Same
      // for the dolly, which a mid-dolly abort would otherwise leave part-way.
      g.vessel.chasePitchBias = 0;
      g.vessel.chaseDolly = 1;
      if (g.vessel.cameraMode !== s.cameraMode) {
        g.vessel.cameraMode = s.cameraMode;
        g.vessel._chaseValid = false;
      }
      g.controlsHint.enabled = s.legendEnabled;
      if (s.legendEnabled) g.controlsHint.reveal();
      g.input.wantsPointerLock = s.wantsPointerLock;
      // The parked hull goes back where its owner left it - but only when
      // nobody is flying it: a player who aborted mid-flight owns the vessel
      // wherever it is, and teleporting it out from under them would be the
      // worse surprise. See the save-site comment for the regret scenario.
      if (!g.player.inVessel) {
        g.vessel.teleport(s.vesselPos[0], s.vesselPos[1], s.vesselPos[2],
          s.vesselYaw, s.vesselPitch);
      }
    }
    this._saved = null;

    // An abort with the pointer unlocked leaves mouse-look dead, and
    // frameUpdate stripped the "click to look" hint every frame while the
    // demo ran - re-sync it or the one UI element that names that state
    // stays hidden (the review's F3).
    g._syncLockHint?.();

    // The real accumulator was never drained while the virtual input was the
    // consumer; hand it back EMPTY or the first look after the demo is one
    // giant integrated swipe. Edges likewise - the keystroke that aborted has
    // done its job as an abort and must not also fire as gameplay two frames
    // in a row. clearEdges() is the whole fix and has precedent (the jump
    // menu closes through it for exactly this modal-exit case): the review
    // proved the first draft only zeroed the VIRTUAL input, so an abort by E
    // beside the vessel also boarded it, an abort by F re-toggled the lamp
    // stop() had just restored, and an abort by Y undid the restored camera
    // mode - the real InputManager's keysPressed/mousePressed/wheel edges
    // survived into the next frame's wasPressedOnce and the next step.
    g.input.mouseDX = 0;
    g.input.mouseDY = 0;
    g.input.clearEdges();
    this.input.reset();
    this._lookRateYaw = 0; this._lookRatePitch = 0;

    this._segment = null;
    this._phase = 'idle';
    if (!finished) {
      // Abort: hand the frame back NOW. A fade would sit between the player
      // and the control they just reclaimed. (A finished run keeps its black
      // frame; frameUpdate fades it back out over FADE_IN.)
      this._fadeOpacity = 0;
      this._applyFade();
    }
    this._fadeEarly = 0;
    console.info(`[demo] stopped (${reason}) after ${this._totalElapsed.toFixed(1)} s`);
  }

  // -------------------------------------------------------------------------
  // Per-frame: fades only. Rendering-rate work, no game state.
  // -------------------------------------------------------------------------

  frameUpdate(dt) {
    const phase = this._phase;
    if (phase === 'cut-out' || phase === 'finish-out') {
      this._fadeOpacity = Math.min(1, this._fadeOpacity + dt / FADE_OUT);
      this._applyFade();
    } else if (phase === 'run' && this._fadeEarly > 0) {
      // A `fadeOut` step is running the segment out under black BEFORE its
      // last steps finish - the run phase is the only place the picture can
      // darken while the route still has work to do.
      this._fadeOpacity = Math.min(1, this._fadeOpacity + dt / this._fadeEarly);
      this._applyFade();
    } else if (this._fadeOpacity > 0 && (phase === 'run' || phase === 'idle')) {
      this._fadeOpacity = Math.max(0, this._fadeOpacity - dt / FADE_IN);
      this._applyFade();
    }
    this._updateTitle(dt);
    this._updateCredit(dt);
    // Keep the pointer-lock hint down while the demo owns the screen; it is
    // re-evaluated by main.js on the next lock transition after restore.
    if (this.active) {
      document.getElementById('lock-hint')?.classList.remove('show');
    }
  }

  /**
   * Drive the HUD's scene-title card (hud.demoTitle/demoTitleAlpha - the only
   * writer, like renderer.demoFade). It lives in the FRAME, not in DOM,
   * because the Shift+G recording sees the canvas and nothing else. rAF-side
   * on purpose: the envelope is cosmetic, and holding it out of the fixed
   * step keeps VirtualInput's ownership of the sim untouched.
   */
  _updateTitle(dt) {
    const hud = this.game.hud;
    if (!hud) return;
    if (!this.active) {
      if (hud.demoTitleAlpha !== 0) { hud.demoTitle = ''; hud.demoTitleAlpha = 0; }
      return;
    }
    this._titleT += dt;
    const t = this._titleT;
    const a = t < TITLE_IN ? t / TITLE_IN
      : t < TITLE_IN + TITLE_HOLD ? 1
      : Math.max(0, 1 - (t - TITLE_IN - TITLE_HOLD) / TITLE_OUT);
    hud.demoTitle = this._titleText;
    hud.demoTitleAlpha = this._titleText ? a : 0;
  }

  /**
   * Drive the HUD's attribution credit (hud.demoCredit/demoCreditAlpha - the
   * only writer, like demoTitle and renderer.demoFade). rAF-side beside
   * _updateTitle and for the same reason: the envelope is cosmetic and the
   * fixed step belongs to VirtualInput.
   *
   * The clock is released by the first `run` step rather than by start(), so
   * the ten seconds do not begin behind the opening cut's black - see the
   * CREDIT_* block for the arithmetic.
   */
  _updateCredit(dt) {
    const hud = this.game.hud;
    if (!hud) return;
    if (!this.active || !this._creditArmed) {
      if (hud.demoCreditAlpha !== 0) { hud.demoCredit = ''; hud.demoCreditAlpha = 0; }
      return;
    }
    // Held at Infinity until the picture is actually up.
    if (this._creditT === Infinity) {
      if (this._phase !== 'run') return;
      this._creditT = 0;
    }
    this._creditT += dt;
    const t = this._creditT;
    if (t >= CREDIT_TOTAL) {
      // Disarm at the end so the envelope can never restart mid-route, and so
      // the region key falls back to a constant '' for the rest of the run.
      this._creditArmed = false;
      hud.demoCredit = '';
      hud.demoCreditAlpha = 0;
      return;
    }
    const a = t < CREDIT_IN ? t / CREDIT_IN
      : t < CREDIT_IN + CREDIT_HOLD ? 1
      : Math.max(0, 1 - (t - CREDIT_IN - CREDIT_HOLD) / CREDIT_OUT);
    // Uppercased here, not in the HUD: the stroke font has no lowercase and
    // drawText SKIPS unknown glyphs silently, so a lowercase string would ship
    // as "/ 5" and look like a bug in the layout rather than in the text.
    hud.demoCredit = CREDIT_TEXT.toUpperCase();
    hud.demoCreditAlpha = a;
  }

  /**
   * Called from Game._frame IMMEDIATELY AFTER renderer.render(), and that
   * placement is the whole contract - see the comment at the call site and the
   * pump note in recorder.js. A WebGPU canvas is only readable by drawImage
   * between the draw and the compositor taking the surface; this hook ran from
   * frameUpdate() at the top of the frame once and every recording came out
   * black.
   */
  afterRender() {
    if (!this._recorder) return;
    this._recorder.tick();
    // The recorder can give up on its own: it walks a ladder of encoder
    // configurations and may exhaust it (see recorder.js). Drop the handle and
    // put the REC light out when it does, or the showcase claims to be
    // recording for four more minutes and then saves nothing.
    if (!this._recorder.recording) {
      this._recorder = null;
      this._showRecIndicator(false);
    }
  }

  /**
   * Publish the fade. THE CANVAS IS THE PICTURE AND DOM IS NOT PART OF IT.
   *
   * This used to be one `<div id="demo-fade">` at `inset: 0`, which covered the
   * whole window and was the obvious way to do it - right up until the showcase
   * learned to record itself. A canvas capture stream sees the canvas alone, so
   * that overlay was invisible to the recorder and every one of the eleven
   * segment boundaries hard-cut in the file while fading on screen. The fade is
   * now a scalar the lens pass multiplies onto the final display code value
   * (`Renderer.demoFade`, last line of pass/lens.wgsl), which reproduces what
   * the CSS overlay did - browser compositing is in sRGB space too - and puts
   * it inside the frame where the recorder and the HUD both already are.
   *
   * THE CANVAS HALF IS TWO PASSES, NOT ONE. `Renderer.demoFade` is read by
   * pass/lens.wgsl for the scene and by pass/hud.wgsl for the instruments,
   * because the HUD pass is registered AFTER the post chain and lens cannot
   * reach it; the reasoning is written out at the field itself.
   *
   * The DOM chrome that can still be on screen mid-run is dimmed here from the
   * SAME scalar rather than by a second overlay: `#stats` and
   * `#interaction-prompt` (the legend is disabled by start(), `#lock-hint` is
   * stripped every frame by frameUpdate, `#rec-indicator` is deliberately left
   * OUT - a recording light has to stay legible through the black). One owner
   * per surface: a full-screen div over an in-canvas fade would darken the
   * canvas twice.
   */
  _applyFade() {
    const a = this._fadeOpacity;
    const r = this.game.renderer;
    if (r) r.demoFade = a;
    const dim = a > 0 ? String(Math.max(0, 1 - a)) : '';
    for (const id of FADED_DOM_IDS) {
      const el = document.getElementById(id);
      if (el) el.style.opacity = dim;
    }
  }

  /** The REC dot. Deliberately DOM, so it stays OUT of the recording. */
  _showRecIndicator(on) {
    const el = document.getElementById('rec-indicator');
    if (el) el.classList.toggle('show', !!on);
  }

  // -------------------------------------------------------------------------
  // Fixed step: the state machine. Called from Game._simulate while active.
  // -------------------------------------------------------------------------

  /**
   * Advance the director one fixed step and return the input the entities
   * should be simulated with this step.
   *
   * @param {number} dt fixed step seconds
   * @returns {VirtualInput}
   */
  beginStep(dt) {
    const vi = this.input;
    vi.reset();
    this._totalElapsed += dt;

    switch (this._phase) {
      case 'cut-out':
        // Wait for the frame-rate fade to reach black, then hold one black
        // step for the cut itself. The LAST run step's motion keeps playing
        // through the fade (look deltas zero, so the heading holds): a
        // centred throttle commands a STOP on both the vessel and the swim
        // contract, and the old zeroed input here braked the walkthrough to a
        // halt at every segment boundary - the reported "demo stops briefly".
        this._applyCarry(vi);
        if (this._fadeOpacity >= 1) {
          this._fadeHold += dt;
          if (this._fadeHold >= FADE_HOLD) this._executeCut();
        }
        return vi;
      case 'finish-out':
        this._applyCarry(vi);
        if (this._fadeOpacity >= 1) this.stop('finished');
        return vi;
      case 'run':
        break;
      default:
        return vi;
    }

    const seg = this._segment;
    this._segElapsed += dt;

    // Service the segment's lamp goal through the real action. A piloted
    // start clears it silently (the old write's own guard); otherwise press
    // until the state confirms, which the fade's black hold covers.
    if (this._lampGoal != null) {
      if (this.game.player.inVessel || this.game.player.lampOn === this._lampGoal) {
        this._lampGoal = null;
      } else {
        vi.press(ACTION.FLASHLIGHT);
      }
    }

    if (this._segElapsed > seg.timeout) {
      this._note(`segment '${seg.id}' hit its ${seg.timeout}s timeout at step ${this._stepIndex}`);
      // A timed-out segment is usually a BLOCKED waypoint: the last commanded
      // motion is by definition pointed at whatever blocked it, so carrying
      // that throttle through the fade would fly the hull into the obstacle
      // for another half second (hull damage survives the demo). Brake into
      // this fade instead - continuity yields to the old safety property here.
      this._carry.forward = 0; this._carry.strafe = 0;
      this._carry.vertical = 0; this._carry.sprint = false;
      this._advanceSegment();
      return vi;
    }

    // Run the current step; a finished step hands the same sim step to the
    // next one so zero-duration steps (lamp, camera, note) cost no frames.
    this._lookEmitted = false;
    for (let guard = 0; guard < 8; guard++) {
      if (this._stepIndex >= seg.steps.length) {
        this._advanceSegment();
        this._applyCarry(vi);
        return vi;
      }
      const step = seg.steps[this._stepIndex];
      const done = this._runStep(step, dt, vi);
      if (!done) { this._recordCarry(vi); this._decayLookRate(dt); return vi; }
      this._stepIndex++;
      this._stepElapsed = 0;
      this._stepState = null;
    }
    this._recordCarry(vi);
    this._decayLookRate(dt);
    return vi;
  }

  /** Bleed the angular rate off when a step commanded no gaze this tick, so a
   *  held frame hands the next step a camera at rest rather than one still
   *  carrying the last leg's momentum. */
  _decayLookRate(dt) {
    if (this._lookEmitted) return;
    const a = (this.game.player.inVessel ? LOOK_ACCEL_VESSEL : LOOK_ACCEL_SWIM) * dt;
    this._lookRateYaw = clamp(0, this._lookRateYaw - a, this._lookRateYaw + a);
    this._lookRatePitch = clamp(0, this._lookRatePitch - a, this._lookRatePitch + a);
  }

  /** Replay the last run motion into a boundary/fade step. */
  _applyCarry(vi) {
    const c = this._carry;
    vi.forward = c.forward; vi.strafe = c.strafe;
    vi.vertical = c.vertical; vi.sprint = c.sprint;
  }

  /** Remember the motion a run step emitted, for the fades between scenes. */
  _recordCarry(vi) {
    const c = this._carry;
    c.forward = vi.forward; c.strafe = vi.strafe;
    c.vertical = vi.vertical; c.sprint = vi.sprint;
  }

  _advanceSegment() {
    this._segIndex++;
    this._stepIndex = 0;
    this._stepElapsed = 0;
    this._stepState = null;
    this._segElapsed = 0;
    if (this._segIndex >= SEGMENTS.length) {
      // The show is over: fade to black, restore behind it, fade back in.
      this._phase = 'finish-out';
      console.info('%c[demo] SUBWAVE showcase - end', 'font-weight:bold');
      return;
    }
    this._segment = SEGMENTS[this._segIndex];
    console.info(`[demo] ${this._segIndex + 1}/${SEGMENTS.length} ${this._segment.id}: ${this._segment.label}`);
    if (this._segment.cut || this._segment.time != null) {
      this._phase = 'cut-out';
      this._fadeHold = 0;
    } else {
      this._beginSegmentBody();
    }
  }

  /** Behind full black: apply the time, take the jump, start the scene. */
  _executeCut() {
    const g = this.game;
    const seg = this._segment;
    if (seg.time != null) {
      g.worldClock.setDayFraction(seg.time);
      g.renderer.resetAdaptation();
      this._saved.timeTouched = true;
    }
    let cutResult = null;
    if (seg.cut) {
      let result;
      if (typeof seg.cut === 'string') {
        result = g.jumpTo(seg.cut);
      } else {
        const { target, opts } = seg.cut(g);
        result = g.jumpTo(target, opts);
      }
      if (result?.error) {
        this._note(`cut for '${seg.id}' failed: ${result.error} - skipping segment`);
        this._advanceSegment();
        return;
      }
      cutResult = result;
    }
    // No water-column override. The pin that stood here (classifying every
    // segment at its subject's coordinates) made 9 of 12 segments photograph
    // water free play would not show. The
    // flicker it papered over is fixed for ALL play by the classification
    // dwell in main.js._updateWaterColumn (WORLD.WATER_TYPE_DWELL) plus the
    // re-aimed dive-coral swim route; the cut's own jump already snaps the
    // column at the arrival point, which is an ordinary game state.
    this._beginSegmentBody();
  }

  _beginSegmentBody() {
    const g = this.game;
    const seg = this._segment;
    // The segment's lamp state is a GOAL serviced through the real
    // FLASHLIGHT action in beginStep's run phase, not a field write. For cut
    // segments the first press lands on the very next sim step - still
    // behind the fade's black hold - so the state is correct before the
    // first visible frame, same as the old write.
    this._lampGoal = seg.lamp != null ? !!seg.lamp : null;
    try { seg.onStart?.(g); } catch (e) { this._note(`onStart '${seg.id}' threw: ${e.message}`); }
    // The scene-title card. Uppercased HERE because the HUD's stroke font is
    // uppercase-only (ui/hud.js GLYPHS) and the route authors mixed case.
    this._titleText = (seg.title || '').toUpperCase();
    this._titleT = 0;
    // A new scene starts from rest: carrying the previous segment's angular
    // rate across a cut would open the frame already swinging.
    this._lookRateYaw = 0; this._lookRatePitch = 0;
    // An early fade belongs to the segment that asked for one; the arrival
    // fades back IN from the cut's black like every other scene.
    this._fadeEarly = 0;
    this._segElapsed = 0;
    this._phase = 'run';
  }

  // -------------------------------------------------------------------------
  // Step interpreter
  // -------------------------------------------------------------------------

  /** @returns {boolean} true when the step is complete */
  _runStep(step, dt, vi) {
    this._stepElapsed += dt;
    const g = this.game;

    if (step.note) { this._note(step.note); return true; }
    // Lamp and camera go through the REAL actions (the real-demo contract:
    // no state write a player cannot reproduce). Both are toggles and the
    // script wants an absolute state, so: press only when the state differs,
    // and complete only when the state CONFIRMS - the press is consumed by
    // the real handler on this same sim step (Player._handleInteraction /
    // Vessel._readInput run after beginStep returns), so confirmation costs
    // one 8 ms step. Waiting on the state rather than counting presses makes
    // a double-toggle impossible even though the zero-duration guard loop
    // can re-enter, and self-heals if a handler ever skips a step.
    if (step.lamp !== undefined) {
      if (g.player.inVessel) { this._note('lamp step while piloted - skipped'); return true; }
      if (g.player.lampOn === !!step.lamp) return true;
      vi.press(ACTION.FLASHLIGHT);
      return false;
    }
    if (step.camera) {
      if (!g.player.inVessel) { this._note(`camera step '${step.camera}' on foot - skipped`); return true; }
      if (g.vessel.cameraMode === step.camera) return true;
      vi.press(ACTION.CAMERA_TOGGLE);
      return false;
    }
    // Vessel exterior lights, the lamp step's shape exactly: absolute state
    // through the real toggle, completing on confirmation. `flood` is a
    // faithful sentinel for the whole exterior package because
    // toggleExteriorLights drives every exterior group to one state.
    if (step.lights !== undefined) {
      if (!g.player.inVessel) { this._note('lights step on foot - skipped'); return true; }
      if (!!g.vessel.lights.flood === !!step.lights) return true;
      vi.press(ACTION.LIGHTS_TOGGLE);
      return false;
    }
    if (step.board) return this._stepBoard(step.board, vi);
    if (step.disembark) return this._stepDisembark(step.disembark, vi);
    if (step.interact) return this._stepInteract(step.interact, vi);
    // An absolute-state write with no toggle behind it, so it completes on the
    // step it starts: the chase pitch bias is the director's own instrument and
    // has no player-facing control to route through (see the field's note).
    if (step.chaseBias !== undefined) {
      if (!g.player.inVessel) { this._note('chaseBias on foot - skipped'); return true; }
      g.vessel.chasePitchBias = this._num(step.chaseBias);
      return true;
    }
    // BRING THE FADE FORWARD, so the steps after it run under black.
    //
    // The boundary fade normally starts when a segment ENDS (_advanceSegment
    // -> 'cut-out'), which means every step is fully visible. That is wrong
    // for exactly one class of step: the ones that exist to leave the world in
    // the state the NEXT segment needs. jelly-hollow's closing `disembark` is
    // the case - the scene is shot from the cockpit and the dismount put the
    // player outside their own hull for the half second before the fade, which
    // a playtest reported as "we see our own vessel for a second".
    //
    // Setting the rate here rather than driving the opacity means the ramp
    // still runs on the RENDER clock in frameUpdate, alongside the other two
    // fades, so there is one owner of _fadeOpacity. The following 'cut-out'
    // finds the screen already black and its FADE_HOLD cuts immediately.
    //
    // IT HAS TO BLOCK, and the first cut of it did not - which made it a no-op
    // in exactly the case it was written for. Setting the rate and completing
    // on the same step hands the next step (a `disembark`, which finishes in
    // one sim step) straight through to the end of the segment, and the
    // boundary fade then starts from ZERO anyway: traced on the running game,
    // renderer.demoFade read 0.000 through the whole jelly-hollow tail and was
    // still 0.000 at t+41.2 with the segment leaving at 41.9. So this step
    // waits for the black it asked for. The escape hatch is 4x the authored
    // ramp, because the ramp is on the render clock and the sim must not be
    // able to hang on a frame that never arrives; the segment timeout is the
    // outer backstop as always.
    if (step.fadeOut !== undefined) {
      const dur = Math.max(this._num(step.fadeOut), 1e-3);
      this._fadeEarly = dur;
      return this._fadeOpacity >= 1 || this._stepElapsed >= dur * 4;
    }
    if (step.turn) return this._stepTurn(step.turn, dt, vi);
    if (step.pan) return this._stepPan(step.pan, dt, vi);
    if (step.lookAt) return this._stepLookAt(step.lookAt, dt, vi);
    if (step.dwell) return this._stepDwell(step.dwell, dt, vi);
    if (step.walkTo) return this._stepWalkTo(step.walkTo, dt, vi);
    if (step.swimTo) return this._stepSwimTo(step.swimTo, dt, vi);
    if (step.flyTo) return this._stepFlyTo(step.flyTo, dt, vi);
    if (step.hover) return this._stepHover(step.hover, dt, vi);
    if (step.chaseDolly) return this._stepChaseDolly(step.chaseDolly, dt, vi);
    if (step.watchFauna) return this._stepWatchFauna(step.watchFauna, dt, vi);
    this._note(`unknown step in '${this._segment.id}' - skipped`);
    return true;
  }

  _resolve(point, out) {
    if (typeof point === 'function') return point(this.game, out);
    out[0] = point[0]; out[1] = point[1]; out[2] = point[2];
    return out;
  }

  _num(v) { return typeof v === 'function' ? v(this.game) : v; }

  /** The demo's eye: the point gaze directions are measured from. */
  _eye(out) {
    const g = this.game;
    if (g.player.inVessel) { vec3.copy(out, g.vessel.position); return out; }
    vec3.copy(out, g.player.position);
    out[1] += g.player.currentEyeHeight;
    return out;
  }

  /**
   * Emit look deltas that ease the current heading/pitch toward a target pair.
   * Compass convention throughout: yaw = atan2(dx, -dz), pitch positive up.
   *
   * THREE LIMITS, IN ORDER, AND THEY DO DIFFERENT JOBS. The exponential is the
   * settle (a camera move, not a servo snap). The RATE clamp is the constant
   * slew far from target, which is what makes a pan's duration predictable
   * enough to author. The ACCELERATION clamp - see LOOK_ACCEL_* - is the
   * ease-IN the first two never had, and it is the one that stops every step
   * boundary reading as a snap. The final guard is an anti-overshoot: a stored
   * rate the remaining error cannot absorb is spent exactly, not rung past.
   */
  _emitLookAngles(tgtYaw, tgtPitch, dt, vi, rate) {
    const g = this.game;
    const inV = g.player.inVessel;
    const curYaw = inV ? g.vessel.aimYaw : g.player.yaw;
    const curPitch = inV ? g.vessel.aimPitch : g.player.pitch;
    const maxRate = rate ?? (inV ? LOOK_RATE_VESSEL : LOOK_RATE_SWIM);
    const maxAccel = (inV ? LOOK_ACCEL_VESSEL : LOOK_ACCEL_SWIM) * dt;
    const k = 1 - Math.exp(-dt / LOOK_TAU);
    const dyaw = wrapAngle(tgtYaw - curYaw);
    const dpitch = tgtPitch - curPitch;

    const wantYaw = clamp(dyaw * k / dt, -maxRate, maxRate);
    const wantPitch = clamp(dpitch * k / dt, -maxRate, maxRate);
    let ry = clamp(wantYaw, this._lookRateYaw - maxAccel, this._lookRateYaw + maxAccel);
    let rp = clamp(wantPitch, this._lookRatePitch - maxAccel, this._lookRatePitch + maxAccel);

    let stepYaw = ry * dt;
    if (Math.abs(stepYaw) > Math.abs(dyaw)) { stepYaw = dyaw; ry = dyaw / dt; }
    let stepPitch = rp * dt;
    if (Math.abs(stepPitch) > Math.abs(dpitch)) { stepPitch = dpitch; rp = dpitch / dt; }

    this._lookRateYaw = ry;
    this._lookRatePitch = rp;
    this._lookEmitted = true;
    vi.lookYaw = stepYaw;
    vi.lookPitch = stepPitch;
    return { dyaw, dpitch };
  }

  /** Aim at an ALREADY-RESOLVED absolute point. */
  _emitLookAtVec(target, dt, vi, rate) {
    this._eye(_p);
    const dx = target[0] - _p[0], dy = target[1] - _p[1], dz = target[2] - _p[2];
    const flat = Math.hypot(dx, dz);
    const yaw = Math.atan2(dx, -dz);
    const pitch = Math.atan2(dy, Math.max(flat, 1e-3));
    return this._emitLookAngles(yaw, pitch, dt, vi, rate);
  }

  _emitLookAtPoint(point, dt, vi, rate) {
    this._resolve(point, _q);
    return this._emitLookAtVec(_q, dt, vi, rate);
  }

  /**
   * Resolve the gaze and thrust targets of the NEXT navigable step, for the
   * cornering blend.
   *
   * Non-geometric steps (board, lamp, camera, note, ...) are SKIPPED rather
   * than treated as the end of the route - a `disembark` between two swim legs
   * must not cost the corner. A step whose subject cannot be resolved as a
   * fixed point (watchFauna tracks a live animal; pan/turn carry angles, not
   * places) stops the scan, because there is nothing honest to blend toward.
   *
   * @returns {boolean} true when `_nextLook` and/or `_nextMove` were written
   */
  _peekNextNav() {
    const seg = this._segment;
    if (!seg) return false;
    this._nextHasLook = false;
    this._nextHasMove = false;
    const end = Math.min(seg.steps.length, this._stepIndex + 5);
    for (let i = this._stepIndex + 1; i < end; i++) {
      const st = seg.steps[i];
      const nav = st.swimTo || st.flyTo || st.walkTo;
      if (nav) {
        this._resolve(nav.point, _nextMove);
        this._nextHasMove = true;
        if (nav.look) this._resolve(nav.look, _nextLook);
        else vec3.copy(_nextLook, _nextMove);
        this._nextHasLook = true;
        return true;
      }
      const gaze = st.lookAt || st.dwell || st.hover;
      if (gaze) {
        const pt = st.lookAt ? gaze.point : gaze.look;
        if (!pt) continue;              // a blind dwell: keep scanning
        this._resolve(pt, _nextLook);
        this._nextHasLook = true;
        return true;
      }
      if (st.watchFauna || st.pan || st.turn) return false;
      // board / disembark / interact / lamp / camera / lights / chaseBias /
      // note / chaseDolly: no geometry of their own, so look past them.
    }
    return false;
  }

  /**
   * The corner blend for one navigation step.
   *
   * `u` runs 0 at `lead` metres out to 1 at `arriveR`, smoothstepped. It also
   * owns the WAYPOINT-PASSED test: once inside the lead window, a distance that
   * has started growing again means the leg is behind us and grinding toward a
   * radius it will never close (which is exactly what the coral leg did for
   * ~10 s on two captures). `st.minDist` is the closest approach so far.
   *
   * @returns {number} the blend weight; -1 means "this step is finished"
   */
  _navBlend(st, dist, lead, arriveR) {
    if (dist < st.minDist) st.minDist = dist;
    if (dist < lead && dist > st.minDist + 0.6) return -1;
    if (dist >= lead) return 0;
    const u = clamp((lead - dist) / Math.max(lead - arriveR, 1e-3), 0, 1);
    return u * u * (3 - 2 * u);
  }

  _stepPan(p, dt, vi) {
    this._emitLookAngles(this._num(p.yaw), this._num(p.pitch ?? 0), dt, vi, p.rate);
    if (p.move) { vi.forward = p.move[0]; vi.strafe = p.move[1]; vi.vertical = p.move[2]; }
    return this._stepElapsed >= (p.dur ?? 3);
  }

  /**
   * A RELATIVE, SIGNED, TIMED sweep of the gaze - the step `pan` cannot be.
   *
   * `pan` names an absolute yaw and _emitLookAngles wraps the error, so it
   * always takes the SHORT way round and a 180 degree sweep has no defined
   * direction at all. The showcase's opening move is "turn 180 to the LEFT,
   * past the sun and the mountain, and end on the vessel", which is a statement
   * about the PATH, not the destination. So this step drives the target itself:
   * `startYaw + by * smoothstep(t/dur)`, which the error-tracking below then
   * follows by a hair, so the direction is whatever sign `by` carries and the
   * duration is exactly `dur`.
   *
   *   by     signed radians; negative is LEFT (counter-clockwise from above)
   *   toPoint  ...or a place to END on, with `dir` choosing the way round.
   *          `by` is then derived at step start, so the sweep lands exactly on
   *          the subject however the previous step left the heading - which is
   *          what "turn left until the vessel is centred" actually means.
   *   dir    +1 right (clockwise), -1 left. Only meaningful with `toPoint`.
   *   dur    seconds, ease in and out
   *   pitch  a number (eased to, from wherever the pitch is now) or a
   *          [from, to] pair, on the same smoothstep
   *   move   drift channels, dwell's exactly - a turning camera may still swim
   */
  _stepTurn(p, dt, vi) {
    const g = this.game;
    const inV = g.player.inVessel;
    let st = this._stepState;
    if (!st) {
      st = this._stepState = {
        yaw0: inV ? g.vessel.aimYaw : g.player.yaw,
        pitch0: inV ? g.vessel.aimPitch : g.player.pitch,
        by: 0,
      };
      if (p.toPoint) {
        // Resolve ONCE, at step start: a per-tick re-resolve would let the
        // diver's own drift bend the sweep, and the whole point of this step
        // is a path the author can predict.
        this._eye(_p);
        this._resolve(p.toPoint, _q);
        const want = Math.atan2(_q[0] - _p[0], -(_q[2] - _p[2]));
        const dir = p.dir ?? 1;
        let by = wrapAngle(want - st.yaw0);
        // wrapAngle always hands back the SHORT way; take the long way round
        // when the author asked for the other side.
        if (by * dir < 0) by += dir * 2 * Math.PI;
        st.by = by;
      } else {
        st.by = this._num(p.by ?? 0);
      }
    }
    const dur = p.dur ?? 4;
    const u = clamp(this._stepElapsed / dur, 0, 1);
    const e = u * u * (3 - 2 * u);
    const tgtYaw = st.yaw0 + st.by * e;
    let tgtPitch = st.pitch0;
    if (Array.isArray(p.pitch)) {
      tgtPitch = lerp(this._num(p.pitch[0]), this._num(p.pitch[1]), e);
    } else if (p.pitch != null) {
      tgtPitch = lerp(st.pitch0, this._num(p.pitch), e);
    }
    this._emitLookAngles(tgtYaw, tgtPitch, dt, vi, p.rate);
    if (p.move) { vi.forward = p.move[0]; vi.strafe = p.move[1]; vi.vertical = p.move[2]; }
    return this._stepElapsed >= dur;
  }

  _stepLookAt(p, dt, vi) {
    this._emitLookAtPoint(p.point, dt, vi);
    // Optional drift, same [forward, strafe, vertical] channels as dwell's:
    // a gaze step between two navigation steps must not read as a full stop.
    if (p.move) { vi.forward = p.move[0]; vi.strafe = p.move[1]; vi.vertical = p.move[2]; }
    return this._stepElapsed >= (p.dur ?? 3);
  }

  _stepDwell(p, dt, vi) {
    if (p.look) this._emitLookAtPoint(p.look, dt, vi);
    if (p.move) { vi.forward = p.move[0]; vi.strafe = p.move[1]; vi.vertical = p.move[2]; }
    return this._stepElapsed >= (p.dur ?? 3);
  }

  /**
   * Swim navigation: gaze at `look` (or at the waypoint) while thrusting
   * toward the waypoint. The commanded direction is decomposed into the same
   * forward/strafe/ascend channels the keys drive, so the swim contract's own
   * lag is the only smoothing between here and the water.
   */
  _stepSwimTo(p, dt, vi) {
    const g = this.game;
    if (g.player.inVessel) { this._note('swimTo while piloted - skipped'); return true; }
    const st = this._stepState || (this._stepState = { minDist: Infinity });
    const arriveR = p.arriveR ?? 2.5;
    const tgt = this._resolve(p.point, _q);
    this._eye(_p);
    let dx = tgt[0] - _p[0], dy = tgt[1] - _p[1], dz = tgt[2] - _p[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist <= arriveR) return true;
    if (this._stepElapsed >= (p.maxT ?? 20)) {
      this._note(`swimTo in '${this._segment.id}' timed out ${dist.toFixed(1)} m short`);
      return true;
    }

    const lead = Math.max(p.lead ?? LEAD_SWIM, arriveR + 0.5);
    const u = this._navBlend(st, dist, lead, arriveR);
    if (u < 0) return true;                      // waypoint rounded and passed
    const peeked = u > 0 ? this._peekNextNav() : false;

    // GAZE: the authored look point, easing onto the next step's over the last
    // `lead` metres so the turn starts before the corner rather than at it.
    this._resolve(p.look ?? p.point, _gaze);
    if (peeked && this._nextHasLook) vec3.lerp(_gaze, _gaze, _nextLook, u);
    this._emitLookAtVec(_gaze, dt, vi);

    // THRUST: same blend, capped, so the line through the corner is an arc.
    if (peeked && this._nextHasMove) {
      const w = u * LEAD_MOVE_MAX;
      const nx = _nextMove[0] - _p[0], ny = _nextMove[1] - _p[1], nz = _nextMove[2] - _p[2];
      const nl = Math.max(Math.hypot(nx, ny, nz), 1e-3);
      dx = lerp(dx / dist, nx / nl, w);
      dy = lerp(dy / dist, ny / nl, w);
      dz = lerp(dz / dist, nz / nl, w);
    } else { dx /= dist; dy /= dist; dz /= dist; }
    const il = Math.max(Math.hypot(dx, dy, dz), 1e-3);

    // Decompose the world-space direction into the view-relative channels
    // Player._simulateSwim consumes (vertical is world-up at 0.62 gain there).
    quat.forward(_fwd, g.player.orientation);
    quat.right(_right, g.player.orientation);
    const ix = dx / il, iy = dy / il, iz = dz / il;
    let f = _fwd[0] * ix + _fwd[1] * iy + _fwd[2] * iz;
    let sr = _right[0] * ix + _right[1] * iy + _right[2] * iz;
    const residualY = iy - _fwd[1] * f - _right[1] * sr;
    const v = clamp(residualY / 0.62, -1, 1);
    const len = Math.hypot(f, sr);
    if (len > 1) { f /= len; sr /= len; }
    vi.forward = f;
    vi.strafe = sr;
    vi.vertical = v;
    vi.sprint = !!p.sprint;
    return false;
  }

  /**
   * Land navigation: same idea flattened to the ground plane.
   *
   * `look` DECOUPLES THE GAZE FROM THE WALK, which the bare form cannot do -
   * without it the heading IS the path, so the camera can only ever watch
   * where the feet are going. The beach opener is the case that needed it: the
   * approach to the Kestrel has to stop OFF the hull's long axis (the eye went
   * through the nose otherwise - see the leg in script.js), and a walk that
   * looks where it is going would have swung the vessel out of frame for the
   * last few metres of the one shot the scene exists for.
   *
   * With `look` set the body still walks the waypoint bearing, but the
   * direction is decomposed into the forward/strafe channels relative to the
   * GAZE heading - swimTo's decomposition one dimension down. Land locomotion
   * charges STRAFE_MULTIPLIER for the sideways component (player.js), so a
   * large gaze offset is a slow walk: keep the subject within ~60 degrees of
   * the path or author the leg longer.
   */
  _stepWalkTo(p, dt, vi) {
    const g = this.game;
    if (g.player.inVessel) { this._note('walkTo while piloted - skipped'); return true; }
    const st = this._stepState || (this._stepState = { minDist: Infinity });
    const arriveR = p.arriveR ?? 1.2;
    const tgt = this._resolve(p.point, _q);
    const pos = g.player.position;
    let dx = tgt[0] - pos[0], dz = tgt[2] - pos[2];
    const dist = Math.hypot(dx, dz);
    if (dist <= arriveR) return true;
    if (this._stepElapsed >= (p.maxT ?? 15)) {
      this._note(`walkTo in '${this._segment.id}' timed out ${dist.toFixed(1)} m short`);
      return true;
    }
    const lead = Math.max(p.lead ?? LEAD_WALK, arriveR + 0.5);
    const u = this._navBlend(st, dist, lead, arriveR);
    if (u < 0) return true;
    const peeked = u > 0 ? this._peekNextNav() : false;
    if (peeked && this._nextHasMove) {
      const w = u * LEAD_MOVE_MAX;
      const nx = _nextMove[0] - pos[0], nz = _nextMove[2] - pos[2];
      const nl = Math.max(Math.hypot(nx, nz), 1e-3);
      dx = lerp(dx / dist, nx / nl, w);
      dz = lerp(dz / dist, nz / nl, w);
    }
    const track = Math.atan2(dx, -dz);
    if (p.look) {
      // Gaze on the subject, blending onto the next step's over the lead
      // window exactly as swimTo does, and the body crabs along the track.
      this._resolve(p.look, _gaze);
      if (peeked && this._nextHasLook) vec3.lerp(_gaze, _gaze, _nextLook, u);
      this._emitLookAtVec(_gaze, dt, vi);
      const rel = wrapAngle(track - g.player.yaw);
      vi.forward = Math.cos(rel);
      vi.strafe = Math.sin(rel);
    } else {
      this._emitLookAngles(track, this._num(p.pitch ?? -0.06), dt, vi, p.rate);
      // Walk on the body heading; when the gaze is still coming around, walking
      // at reduced speed keeps the path curved rather than crabbing sideways.
      const err = Math.abs(wrapAngle(track - g.player.yaw));
      vi.forward = err > 1.1 ? 0.25 : 1.0;
    }
    vi.sprint = !!p.sprint;
    return false;
  }

  /** Vessel navigation: aim at the waypoint, throttle along the aim. */
  _stepFlyTo(p, dt, vi) {
    const g = this.game;
    if (!g.player.inVessel) { this._note('flyTo while on foot - skipped'); return true; }
    const st = this._stepState || (this._stepState = { minDist: Infinity });
    const arriveR = p.arriveR ?? 12;
    const tgt = this._resolve(p.point, _q);
    const pos = g.vessel.position;
    let dx = tgt[0] - pos[0], dy = tgt[1] - pos[1], dz = tgt[2] - pos[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist <= arriveR) return true;
    if (this._stepElapsed >= (p.maxT ?? 30)) {
      this._note(`flyTo in '${this._segment.id}' timed out ${dist.toFixed(1)} m short`);
      return true;
    }
    const lead = Math.max(p.lead ?? LEAD_FLY, arriveR + 1);
    const u = this._navBlend(st, dist, lead, arriveR);
    if (u < 0) return true;
    // Bank the turn into the previous leg: on the direct path the aim IS the
    // flight direction, so blending the waypoint bearing toward the next one is
    // literally flying an arc through the corner. `straight: true` opts a leg
    // OUT of it - the water entry has to be a straight line through the surface
    // or the hull visibly banks as it crosses (playtest note 3).
    if (u > 0 && !p.straight && this._peekNextNav() && this._nextHasMove) {
      const w = u * LEAD_MOVE_MAX;
      const nx = _nextMove[0] - pos[0], ny = _nextMove[1] - pos[1], nz = _nextMove[2] - pos[2];
      const nl = Math.max(Math.hypot(nx, ny, nz), 1e-3);
      dx = lerp(dx / dist, nx / nl, w) * dist;
      dy = lerp(dy / dist, ny / nl, w) * dist;
      dz = lerp(dz / dist, nz / nl, w) * dist;
    }
    // There is deliberately no `look` option here; hover is the step that pans.
    const yaw = Math.atan2(dx, -dz);
    const pitch = Math.atan2(dy, Math.max(Math.hypot(dx, dz), 1e-3));
    const { dyaw } = this._emitLookAngles(yaw, pitch, dt, vi);
    // Throttle: full en route, easing near arrival (the direct model's 0.25 s
    // velocity lag turns that into a clean brake), and held low while the nose
    // is still far off the bearing so a turn is a turn, not an orbit.
    const cruise = this._num(p.throttle ?? 0.8);
    const near = clamp(dist / (p.brakeR ?? 45), p.minThrottle ?? 0.18, 1);
    vi.forward = Math.abs(dyaw) > 1.0 ? 0.15 : cruise * near;
    return false;
  }

  /** Vessel station-hold with a slow pan: throttle centred commands a STOP. */
  _stepHover(p, dt, vi) {
    const g = this.game;
    if (!g.player.inVessel) { this._note('hover while on foot - skipped'); return true; }
    if (p.look) {
      this._eye(_p);
      this._resolve(p.look, _q);
      const dx = _q[0] - _p[0], dy = _q[1] - _p[1], dz = _q[2] - _p[2];
      let yaw = Math.atan2(dx, -dz);
      const pitch = Math.atan2(dy, Math.max(Math.hypot(dx, dz), 1e-3));
      // The "orbit" is a slow yaw drift off the subject bearing: the hull is
      // stationary (throttle centred = stop), so drifting the AIM sweeps the
      // camera across the subject without flying an actual circle.
      if (p.orbitRate) yaw += p.orbitRate * this._stepElapsed;
      this._emitLookAngles(yaw, pitch, dt, vi);
    }
    return this._stepElapsed >= (p.dur ?? 8);
  }

  /**
   * Animate the chase camera INTO the cockpit: eases `vessel.chaseDolly` from
   * 1 to 0 over `dur`, which converges the chase pose (spring target,
   * orientation, FOV - see Vessel.applyCamera) onto the cockpit pose, so the
   * `camera: 'cockpit'` step that follows is a cut-free handoff. Written for
   * the showcase's air-to-water transition: the audience watches the view fly
   * into the vehicle and the HUD appear, then the same uncut motion dives.
   * Optional `look` holds the aim on a subject while the camera closes.
   */
  _stepChaseDolly(p, dt, vi) {
    const g = this.game;
    if (!g.player.inVessel) { this._note('chaseDolly while on foot - skipped'); return true; }
    if (g.vessel.cameraMode !== 'chase') { this._note('chaseDolly outside chase view - skipped'); return true; }
    if (p.look) this._emitLookAtPoint(p.look, dt, vi);
    const dur = p.dur ?? 3.5;
    const u = clamp(this._stepElapsed / dur, 0, 1);
    // Smoothstep: the camera leaves the chase point gently and settles into
    // the seat gently; the spring underneath adds its own ~0.13 s of ease.
    g.vessel.chaseDolly = 1 - u * u * (3 - 2 * u);
    return this._stepElapsed >= dur;
  }

  _stepBoard(p, vi) {
    const g = this.game;
    if (g.player.inVessel) return true;
    if (this._stepElapsed >= (p.maxT ?? 8)) {
      this._note('board timed out - vessel out of range');
      return true;
    }
    // One press per half second while in range; canBoard gates the rest.
    const st = this._stepState || (this._stepState = { next: 0 });
    if (this._stepElapsed >= st.next && g.vessel.canBoard(g.player.position)) {
      vi.press(ACTION.BOARD);
      st.next = this._stepElapsed + 0.5;
    }
    return false;
  }

  _stepDisembark(p, vi) {
    const g = this.game;
    if (!g.player.inVessel) return true;
    if (this._stepElapsed >= (p.maxT ?? 6)) return true;
    const st = this._stepState || (this._stepState = { next: 0 });
    if (this._stepElapsed >= st.next) {
      vi.press(ACTION.DISEMBARK);
      st.next = this._stepElapsed + 0.5;
    }
    return false;
  }

  _stepInteract(p, vi) {
    const g = this.game;
    const st = this._stepState || (this._stepState = {
      next: 0, wasInside: !!g.player.inHabitat,
    });
    if (!!g.player.inHabitat !== st.wasInside) return true;    // the airlock cycled
    if (this._stepElapsed >= (p.maxT ?? 5)) {
      this._note(`interact in '${this._segment.id}' timed out (airlock out of range?)`);
      return true;
    }
    if (this._stepElapsed >= st.next) {
      vi.press(ACTION.INTERACT);
      st.next = this._stepElapsed + 0.6;
    }
    return false;
  }

  /**
   * Track live fauna: the nearest alive animal at or above `minTier` within
   * `radius` of the player. Population is the one non-deterministic input the
   * demo accepts (stated in script.js); when nothing qualifies this is an
   * authored scanning pan, and the notes record which of the two happened.
   *
   * `until` ENDS THE STEP ON THE WORLD'S OWN SIGNAL RATHER THAN A STOPWATCH,
   * and it exists because the dunes climax cannot be timed. The Splitmaw's
   * charge starts from wherever its patrol AI happened to leave it, so the
   * moment the maw reaches the lens moves by seconds between runs; a `dur` that
   * fits one run cuts the next one early or holds it inside the animal. The
   * predicate takes the game and returns true when the shot is over - here,
   * when DuneAmbush latches SWALLOW. `dur` and `maxT` still bound it, so a
   * predicate that never fires degrades to the old behaviour rather than
   * hanging the segment.
   */
  _stepWatchFauna(p, dt, vi) {
    const g = this.game;
    const st = this._stepState || (this._stepState = {
      slot: -1, trackT: 0, baseYaw: g.player.yaw, found: false,
      // An optional SPECIES lock, resolved once. A bare tier floor takes
      // whatever happens to be nearest, and the kelp opener is authored around
      // one particular animal - the Glassclaw, the little walking crab the
      // playtest asked to look at - which a tier-2 Frondmaw drifting past would
      // otherwise win. Resolved to -1 (no lock) when the id is absent.
      species: p.species ? speciesIndexOf(p.species) : -1,
    });
    const sim = g.creatures;
    const pos = g.player.position;
    const wanted = (i) => sim.tier[i] >= p.minTier &&
      (st.species < 0 || sim.species[i] === st.species);
    // ACQUISITION FLOOR, and it is a floor on the SEARCH only.
    //
    // A tracked animal crossing the lens at a few metres swings the bearing
    // through a large angle on its own - it is parallax, not a rotation the
    // route asked for, and it is the same fault the ossuary segment cured by
    // pushing every gaze 45-90 m out (script.js). The coral reef beat measured
    // it directly: cut10 logged "reef fish: tracking tier-0 at 4.8 m" and the
    // playtest reported the swim "does too many rotations".
    //
    // An animal already being tracked that CLOSES inside the floor keeps being
    // tracked: something swimming toward the lens reads as an approach and
    // holds a stable bearing. Only the pick is gated.
    const minR2 = (p.minRange ?? 0) * (p.minRange ?? 0);

    // Re-validate or (re)acquire. A tracked animal can despawn or flee out of
    // range mid-beat; rescanning every step keeps the gaze honest.
    let best = st.slot >= 0 && sim.alive[st.slot] && wanted(st.slot) ? st.slot : -1;
    if (best < 0) {
      let bestD = p.radius * p.radius;
      for (let i = 0; i < sim.capacity; i++) {
        if (!sim.alive[i] || !wanted(i)) continue;
        const dx = sim.posX[i] - pos[0], dy = sim.posY[i] - pos[1], dz = sim.posZ[i] - pos[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < minR2) continue;
        if (d2 < bestD) { bestD = d2; best = i; }
      }
      if (best >= 0 && !st.found) {
        st.found = true;
        const d = Math.hypot(sim.posX[best] - pos[0], sim.posY[best] - pos[1], sim.posZ[best] - pos[2]);
        this._note(`${p.name || 'fauna'}: tracking tier-${sim.tier[best]} at ${d.toFixed(1)} m`);
      }
      st.slot = best;
    }

    // Optional drift, dwell's channels: a held track must not read as a full
    // stop when the scene wants the diver still easing forward (the kelp and
    // dunes segments both do).
    if (p.move) { vi.forward = p.move[0]; vi.strafe = p.move[1]; vi.vertical = p.move[2]; }

    // Checked before the gaze, so the frame the predicate fires on is the last
    // one this step aims - the fadeOut that follows starts from a settled look.
    if (p.until && p.until(g)) {
      this._note(`${p.name || 'fauna'}: ended on its own signal at ${this._stepElapsed.toFixed(1)} s`);
      return true;
    }

    if (best >= 0) {
      _q[0] = sim.posX[best]; _q[1] = sim.posY[best]; _q[2] = sim.posZ[best];
      this._eye(_p);
      // AIM AT THE NEAREST POINT OF THE BODY, NOT AT THE ORIGIN.
      //
      // sim.posX/Y/Z is the animal's CENTRE, which is fine for anything whose
      // length is small against its range and wrong for anything that is not.
      // The Splitmaw is ninety metres: through the swallow the centre is still
      // 56 m out while the maw is at the lens, so a gaze on the origin looked
      // 45 m PAST the head and the delivered frame was the mandible junction
      // rather than the mouth.
      //
      // The nearest point on the body axis is the right target at both ends of
      // the beat and needs no blend between them: broadside it is the middle,
      // which frames the whole animal, and head-on it is the snout, which
      // frames the maw. Opt-in, so no other beat on the route moves.
      if (p.aimBody) {
        const o = best * 4;
        _bodyQuat[0] = sim.orient[o]; _bodyQuat[1] = sim.orient[o + 1];
        _bodyQuat[2] = sim.orient[o + 2]; _bodyQuat[3] = sim.orient[o + 3];
        quat.forward(_bodyAxis, _bodyQuat);
        const half = 0.5 * sim.bodyLength[best];
        const t = clamp((_p[0] - _q[0]) * _bodyAxis[0] + (_p[1] - _q[1]) * _bodyAxis[1]
          + (_p[2] - _q[2]) * _bodyAxis[2], -half, half);
        _q[0] += _bodyAxis[0] * t; _q[1] += _bodyAxis[1] * t; _q[2] += _bodyAxis[2] * t;
      }
      const dx = _q[0] - _p[0], dy = _q[1] - _p[1], dz = _q[2] - _p[2];
      this._emitLookAngles(Math.atan2(dx, -dz),
        Math.atan2(dy, Math.max(Math.hypot(dx, dz), 1e-3)), dt, vi);
      st.trackT += dt;
      if (st.trackT >= (p.dur ?? 5)) return true;
    } else {
      // Nothing on stage yet: slow scanning sweep about the entry heading.
      // HALVED from 0.55 rad / 0.45 rad/s. The wide sweep was most of the
      // reported "the camera keeps turning around too much" at the Platter
      // Forest, where the fallback fires often - and a searching look reads as
      // searching at a quarter of the amplitude.
      this._emitLookAngles(st.baseYaw + 0.28 * Math.sin(this._stepElapsed * 0.28),
        p.scanPitch ?? 0.05, dt, vi);
    }
    if (this._stepElapsed >= (p.maxT ?? 20)) {
      if (!st.found) this._note(`${p.name || 'fauna'}: nothing staged within ${p.radius} m in ${p.maxT} s`);
      return true;
    }
    return false;
  }

  // NOTE: the demo stages NO fauna. The observatory pod that a `fauna` step
  // once raw-spawned here is ordinary population now
  // (entities/station_residency.js) - present in free play, maintained by the
  // same residency machinery as the leviathans, and simply walked past by the
  // demo like any player. The demo-owned-creatures rule is why.

  // -------------------------------------------------------------------------
  // Abort
  // -------------------------------------------------------------------------

  _onRaw(kind, code) {
    if (!this.active) return;
    // Escape stops. The demo key stops the demo through the toggle in
    // Game._frame (aborting on it here would let the same press restart it
    // one frame later); every other key, button, wheel tick and mouse pixel
    // is a spectator, not a command - see ABORT_CODE - except the two
    // authoring skips, see SKIP_NEXT_CODE.
    if (kind !== 'key') return;
    if (code === ABORT_CODE) { this.stop('input: Escape'); return; }
    if (code === SKIP_NEXT_CODE) { this.skipSegment(1); return; }
    if (code === SKIP_REPLAY_CODE) { this.skipSegment(0); return; }
  }

  /**
   * Jump to another segment mid-run, through the normal boundary fade and cut.
   *
   * @param {number} delta 1 for the next segment, 0 to replay the current one,
   *   -1 for the previous. Replaying re-runs the segment's own cut, which is
   *   what re-arms the residencies and the dune ambush.
   */
  skipSegment(delta = 1) {
    if (!this.active || this._phase === 'finish-out') return;
    // _advanceSegment does its own ++, so aim one short of the target. Clamped
    // to -1 so a replay of segment 0 is still a replay and not the end.
    this._segIndex = Math.max(-1, this._segIndex + delta - 1);
    this._note(delta === 0 ? 'replay segment' : `skip ${delta > 0 ? 'forward' : 'back'}`);
    this._advanceSegment();
  }

  _note(text) {
    const line = `t+${this._totalElapsed.toFixed(1)}s ${text}`;
    this.notes.push(line);
    console.info(`[demo] ${line}`);
  }
}
