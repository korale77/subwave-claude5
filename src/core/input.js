/**
 * SUBWAVE input.
 *
 * Everything the game reads is an ACTION, never a raw key. Actions are bound
 * per CONTEXT (on foot, swimming, piloting in air, piloting underwater, UI), so
 * the same physical key can mean different things without any call-site
 * branching. Bindings are user-rebindable and persisted by settings.js.
 *
 * Edge state (`wasPressed` / `wasReleased`) is valid for exactly one frame and
 * is cleared by `endFrame()`, which the game loop calls last.
 */

import { clamp, saturate } from './math.js';

/** Input contexts, most specific last. `push`/`pop` manage the stack. */
export const CONTEXT = {
  GLOBAL: 'global',
  FOOT: 'foot',
  SWIM: 'swim',
  VESSEL_AIR: 'vesselAir',
  VESSEL_WATER: 'vesselWater',
  UI: 'ui',
};

/** Every action the game can ask about. Adding one here is mandatory. */
export const ACTION = {
  // Movement (analog where noted)
  MOVE_FORWARD: 'moveForward',   // axis -1..1
  MOVE_RIGHT: 'moveRight',       // axis -1..1
  MOVE_UP: 'moveUp',             // axis -1..1 (swim ascend / vessel vertical trim)
  LOOK_X: 'lookX',               // delta, radians
  LOOK_Y: 'lookY',               // delta, radians
  THROTTLE: 'throttle',          // axis -1..1 (vessel main thrust)

  JUMP: 'jump',
  SPRINT: 'sprint',
  CROUCH: 'crouch',

  // Interaction
  INTERACT: 'interact',
  PRIMARY: 'primary',
  SECONDARY: 'secondary',
  RELOAD_TOOL: 'reloadTool',
  NEXT_TOOL: 'nextTool',
  PREV_TOOL: 'prevTool',
  TOOL_1: 'tool1', TOOL_2: 'tool2', TOOL_3: 'tool3',
  TOOL_4: 'tool4', TOOL_5: 'tool5', TOOL_6: 'tool6',
  FLASHLIGHT: 'flashlight',
  SCAN: 'scan',
  BEACON: 'beacon',

  // Vessel
  BOARD: 'board',
  DISEMBARK: 'disembark',
  LIGHTS_TOGGLE: 'lightsToggle',
  LIGHTS_FLOOD: 'lightsFlood',
  LIGHTS_WIDE: 'lightsWide',
  LIGHTS_WORK: 'lightsWork',
  LIGHTS_CABIN: 'lightsCabin',
  SONAR: 'sonar',
  SILENT_RUNNING: 'silentRunning',
  CAMERA_TOGGLE: 'cameraToggle',
  DRILL: 'drill',
  RECALL_VESSEL: 'recallVessel',

  // Meta / UI
  PAUSE: 'pause',
  INVENTORY: 'inventory',
  CRAFTING: 'crafting',
  DATABANK: 'databank',
  MAP: 'map',
  PHOTO_MODE: 'photoMode',
  UI_UP: 'uiUp', UI_DOWN: 'uiDown', UI_LEFT: 'uiLeft', UI_RIGHT: 'uiRight',
  UI_CONFIRM: 'uiConfirm', UI_CANCEL: 'uiCancel', UI_TAB_NEXT: 'uiTabNext', UI_TAB_PREV: 'uiTabPrev',

  HELP: 'help',

  /** Start/stop the automated showcase demo (src/demo/director.js). */
  DEMO_SHOWCASE: 'demoShowcase',

  // Debug
  DEBUG_OVERLAY: 'debugOverlay',
  DEBUG_FREECAM: 'debugFreecam',
  DEBUG_TIME_TOGGLE: 'debugTimeToggle',
  DEBUG_TELEPORT: 'debugTeleport',
};

/**
 * Default bindings.
 *   'Key:<KeyboardEvent.code>'   digital
 *   'Mouse:<button index>'       digital
 *   'Wheel:up' | 'Wheel:down'    digital (one frame)
 *   'Pad:<buttonIndex>'          digital
 *   'PadAxis:<axisIndex>[+|-]'   analog, optionally half-range
 *   'Axis:<neg>/<pos>'           two digital keys forming an axis
 */
export const DEFAULT_BINDINGS = {
  [CONTEXT.GLOBAL]: {
    [ACTION.PAUSE]: ['Key:Escape', 'Pad:9'],
    [ACTION.DEBUG_OVERLAY]: ['Key:F3'],
    [ACTION.DEBUG_FREECAM]: ['Key:F4'],
    // ']' rather than a function key: DESIGN/12 12.13 reserves the bracket pair
    // for the time-of-day dev family, and F6 (which this replaced) focuses
    // Chrome's address bar.
    [ACTION.DEBUG_TIME_TOGGLE]: ['Key:BracketRight'],
    [ACTION.PHOTO_MODE]: ['Key:KeyP'],
    [ACTION.INVENTORY]: ['Key:Tab', 'Pad:3'],
    [ACTION.CRAFTING]: ['Key:KeyC'],
    // J is the developer jump menu, and it TOOK this key from ACTION.DATABANK.
    // That is deliberate and it is safe today: the databank is unbuilt - grep
    // src/ and DATABANK has zero consumers - so the binding was doing nothing,
    // while the jump menu is the thing a developer reaches for many times an
    // hour. label() returns '--' for an unbound action, so nothing throws.
    // WHOEVER BUILDS THE DATABANK PICKS A NEW KEY; G, I, K, N, O, T, U and Z are
    // all free.
    [ACTION.DEBUG_TELEPORT]: ['Key:KeyJ'],
    [ACTION.MAP]: ['Key:KeyM'],
    [ACTION.HELP]: ['Key:KeyH'],
    // G was on the free list the DEBUG_TELEPORT comment above maintains (G, I,
    // K, N, O, T, U, Z); whoever needs G next picks from what remains. The demo
    // is global so one key starts it on foot, swimming or in the cockpit, and
    // the DIRECTOR - not this binding - is what stops it on any other input:
    // see onRawInput() below and src/demo/director.js.
    [ACTION.DEMO_SHOWCASE]: ['Key:KeyG'],
  },
  [CONTEXT.FOOT]: {
    [ACTION.MOVE_FORWARD]: ['Axis:KeyS/KeyW', 'PadAxis:1-'],
    [ACTION.MOVE_RIGHT]: ['Axis:KeyA/KeyD', 'PadAxis:0+'],
    [ACTION.JUMP]: ['Key:Space', 'Pad:0'],
    [ACTION.SPRINT]: ['Key:ShiftLeft', 'Pad:10'],
    [ACTION.CROUCH]: ['Key:ControlLeft', 'Pad:11'],
    [ACTION.INTERACT]: ['Key:KeyE', 'Pad:2'],
    [ACTION.BOARD]: ['Key:KeyE', 'Pad:2'],
    [ACTION.PRIMARY]: ['Mouse:0', 'Pad:7'],
    [ACTION.SECONDARY]: ['Mouse:2', 'Pad:6'],
    [ACTION.FLASHLIGHT]: ['Key:KeyF', 'Pad:4'],
    [ACTION.SCAN]: ['Key:KeyQ'],
    [ACTION.BEACON]: ['Key:KeyB'],
    [ACTION.NEXT_TOOL]: ['Wheel:up'],
    [ACTION.PREV_TOOL]: ['Wheel:down'],
    [ACTION.TOOL_1]: ['Key:Digit1'], [ACTION.TOOL_2]: ['Key:Digit2'],
    [ACTION.TOOL_3]: ['Key:Digit3'], [ACTION.TOOL_4]: ['Key:Digit4'],
    [ACTION.TOOL_5]: ['Key:Digit5'], [ACTION.TOOL_6]: ['Key:Digit6'],
    [ACTION.RECALL_VESSEL]: ['Key:KeyR'],
  },
  [CONTEXT.SWIM]: {
    [ACTION.MOVE_FORWARD]: ['Axis:KeyS/KeyW', 'PadAxis:1-'],
    [ACTION.MOVE_RIGHT]: ['Axis:KeyA/KeyD', 'PadAxis:0+'],
    [ACTION.MOVE_UP]: ['Axis:ControlLeft/Space', 'Pad:0'],
    [ACTION.SPRINT]: ['Key:ShiftLeft', 'Pad:10'],
    [ACTION.INTERACT]: ['Key:KeyE', 'Pad:2'],
    [ACTION.BOARD]: ['Key:KeyE', 'Pad:2'],
    [ACTION.PRIMARY]: ['Mouse:0', 'Pad:7'],
    [ACTION.SECONDARY]: ['Mouse:2', 'Pad:6'],
    [ACTION.FLASHLIGHT]: ['Key:KeyF', 'Pad:4'],
    [ACTION.SCAN]: ['Key:KeyQ'],
    [ACTION.BEACON]: ['Key:KeyB'],
    [ACTION.NEXT_TOOL]: ['Wheel:up'],
    [ACTION.PREV_TOOL]: ['Wheel:down'],
    [ACTION.TOOL_1]: ['Key:Digit1'], [ACTION.TOOL_2]: ['Key:Digit2'],
    [ACTION.TOOL_3]: ['Key:Digit3'], [ACTION.TOOL_4]: ['Key:Digit4'],
    [ACTION.TOOL_5]: ['Key:Digit5'], [ACTION.TOOL_6]: ['Key:Digit6'],
    [ACTION.RECALL_VESSEL]: ['Key:KeyR'],
  },
  // The two vessel contexts carry IDENTICAL movement bindings, and that is
  // deliberate. The Kestrel is flown by pointing it: the mouse sets a persistent
  // heading and pitch, W/S drives along it, and that is the whole scheme in both
  // media. Nothing about how you move changes when the hull goes under, so
  // nothing about the bindings does either - which also means the context switch
  // at the waterline can no longer take a control away mid-manoeuvre.
  //
  // Deleted from the old set, all of it made redundant by the above:
  //   ROLL (Q/E)          bank is now a consequence of turning, not a key. This
  //                       also frees Q for SCAN and E for BOARD, resolving two
  //                       binding collisions - and DESIGN/12 line 354 said
  //                       outright that KeyE should never have been roll.
  //   BOOST (Shift)       shared its key with "descend", so holding Shift did
  //                       both. AX_CMD_MAX is now large enough that a boost on
  //                       top of it is meaningless.
  //   BALLAST_FILL (G)    diving is aiming down and pressing W. The tanks
  //   BALLAST_BLOW (R)    flood and blow themselves - see Vessel._updateBallast.
  //   TRIM_NEUTRAL (T)    the trim is always neutral now; there is nothing to ask
  //                       for.
  //   STABILITY_ASSIST(Z) the "manual" mode it toggled had no attitude loop at
  //                       all and latched a permanent pitch rate.
  [CONTEXT.VESSEL_AIR]: {
    [ACTION.THROTTLE]: ['Axis:KeyS/KeyW', 'PadAxis:1-'],
    [ACTION.MOVE_RIGHT]: ['Axis:KeyA/KeyD', 'PadAxis:0+'],
    [ACTION.MOVE_UP]: ['Axis:ShiftLeft/Space', 'PadAxis:3-'],
    [ACTION.DISEMBARK]: ['Key:KeyF', 'Pad:1'],
    [ACTION.LIGHTS_TOGGLE]: ['Key:KeyL', 'Pad:4'],
    [ACTION.LIGHTS_FLOOD]: ['Key:Digit1'],
    [ACTION.LIGHTS_WIDE]: ['Key:Digit2'],
    [ACTION.LIGHTS_WORK]: ['Key:Digit3'],
    [ACTION.LIGHTS_CABIN]: ['Key:Digit4'],
    [ACTION.SONAR]: ['Key:KeyV', 'Pad:5'],
    [ACTION.SILENT_RUNNING]: ['Key:KeyX'],
    [ACTION.CAMERA_TOGGLE]: ['Key:KeyY', 'Pad:8'],
    [ACTION.PRIMARY]: ['Mouse:0', 'Pad:7'],
    [ACTION.SECONDARY]: ['Mouse:2', 'Pad:6'],
    [ACTION.SCAN]: ['Key:KeyQ'],
  },
  [CONTEXT.VESSEL_WATER]: {
    [ACTION.THROTTLE]: ['Axis:KeyS/KeyW', 'PadAxis:1-'],
    [ACTION.MOVE_RIGHT]: ['Axis:KeyA/KeyD', 'PadAxis:0+'],
    [ACTION.MOVE_UP]: ['Axis:ShiftLeft/Space', 'PadAxis:3-'],
    [ACTION.DISEMBARK]: ['Key:KeyF', 'Pad:1'],
    [ACTION.LIGHTS_TOGGLE]: ['Key:KeyL', 'Pad:4'],
    [ACTION.LIGHTS_FLOOD]: ['Key:Digit1'],
    [ACTION.LIGHTS_WIDE]: ['Key:Digit2'],
    [ACTION.LIGHTS_WORK]: ['Key:Digit3'],
    [ACTION.LIGHTS_CABIN]: ['Key:Digit4'],
    [ACTION.SONAR]: ['Key:KeyV', 'Pad:5'],
    [ACTION.SILENT_RUNNING]: ['Key:KeyX'],
    [ACTION.CAMERA_TOGGLE]: ['Key:KeyY', 'Pad:8'],
    [ACTION.DRILL]: ['Mouse:0', 'Pad:7'],
    [ACTION.PRIMARY]: ['Mouse:0', 'Pad:7'],
    [ACTION.SECONDARY]: ['Mouse:2', 'Pad:6'],
    [ACTION.SCAN]: ['Key:KeyQ'],
  },
  [CONTEXT.UI]: {
    [ACTION.UI_UP]: ['Key:ArrowUp', 'Key:KeyW', 'Pad:12'],
    [ACTION.UI_DOWN]: ['Key:ArrowDown', 'Key:KeyS', 'Pad:13'],
    [ACTION.UI_LEFT]: ['Key:ArrowLeft', 'Key:KeyA', 'Pad:14'],
    [ACTION.UI_RIGHT]: ['Key:ArrowRight', 'Key:KeyD', 'Pad:15'],
    [ACTION.UI_CONFIRM]: ['Key:Enter', 'Key:Space', 'Pad:0'],
    [ACTION.UI_CANCEL]: ['Key:Escape', 'Pad:1'],
    [ACTION.UI_TAB_NEXT]: ['Key:KeyE', 'Pad:5'],
    [ACTION.UI_TAB_PREV]: ['Key:KeyQ', 'Pad:4'],
    [ACTION.PRIMARY]: ['Mouse:0'],
  },
};

/** Keys the browser handles that we must suppress while playing. */
const SWALLOW_CODES = new Set([
  'Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'F3', 'F4', 'Slash', 'Quote',
]);

export class InputManager {
  /**
   * @param {HTMLElement} element The canvas; pointer lock and mouse events attach here.
   */
  constructor(element) {
    this.element = element;

    // --- raw state -------------------------------------------------------
    this.keys = new Set();
    this.keysPressed = new Set();
    this.keysReleased = new Set();
    this.mouseButtons = new Set();
    this.mousePressed = new Set();
    this.mouseReleased = new Set();
    this.mouseX = 0;         // client coords, for UI hit-testing
    this.mouseY = 0;
    this.mouseDX = 0;        // accumulated movement this frame (device px)
    this.mouseDY = 0;
    this.wheelDelta = 0;
    this.wheelUp = false;
    this.wheelDown = false;

    // --- pointer lock ----------------------------------------------------
    this.pointerLocked = false;
    this.wantsPointerLock = false;
    this._lockRequestPending = false;
    this._lastLockExit = 0;

    // --- gamepad ---------------------------------------------------------
    this.gamepadIndex = -1;
    this.gamepadConnected = false;
    this.padButtons = new Uint8Array(20);
    this.padButtonsPrev = new Uint8Array(20);
    this.padAxes = new Float32Array(8);
    this.padDeadzone = 0.16;
    this.padCurveExponent = 2.0;
    this._rumbleUntil = 0;

    // --- configuration ---------------------------------------------------
    this.bindings = structuredClone(DEFAULT_BINDINGS);
    this.contextStack = [CONTEXT.GLOBAL];
    this.mouseSensitivity = 0.0022;   // radians per device pixel
    this.padLookSensitivity = 2.4;    // radians per second at full stick
    this.invertY = false;
    this.mouseSmoothing = 0;          // 0 = raw (default); 0..1 blends previous frames
    this.enabled = true;
    this._smoothDX = 0;
    this._smoothDY = 0;

    /** Set while a rebind is in progress; the next input is captured instead of dispatched. */
    this._rebind = null;
    /** See markEdgesConsumed(): guards edge state against being dropped. */
    this._edgesConsumed = false;
    /** See wasPressedOnce(): actions already delivered for the current press. */
    this._framePressLatch = new Set();
    /** Subscribers notified when pointer lock is gained or lost. */
    this._lockListeners = new Set();
    this._lockRetry = null;
    /**
     * Subscribers notified of RAW device activity - see onRawInput(). The demo
     * director's abort hangs off this, at the DOM event itself, because any
     * polling scheme has a window in which a press can be consumed (edges are
     * cleared by the sim) before the poller sees it.
     */
    this._rawListeners = new Set();

    this._bound = {};
    this._attach();
  }

  // -------------------------------------------------------------------------
  // DOM wiring
  // -------------------------------------------------------------------------

  _attach() {
    const b = this._bound;

    b.keydown = (e) => {
      if (e.repeat) return;
      if (this._rebind) { this._captureRebind('Key:' + e.code); e.preventDefault(); return; }
      if (!this.keys.has(e.code)) this.keysPressed.add(e.code);
      this.keys.add(e.code);
      this._notifyRaw('key', e.code, 0, 0);
      if (this.enabled && (SWALLOW_CODES.has(e.code) || this.pointerLocked)) e.preventDefault();
    };
    b.keyup = (e) => {
      this.keys.delete(e.code);
      this.keysReleased.add(e.code);
    };

    b.mousedown = (e) => {
      if (this._rebind) { this._captureRebind('Mouse:' + e.button); e.preventDefault(); return; }
      if (!this.mouseButtons.has(e.button)) this.mousePressed.add(e.button);
      this.mouseButtons.add(e.button);
      this._notifyRaw('mousedown', String(e.button), 0, 0);
      if (this.wantsPointerLock && !this.pointerLocked) this.requestPointerLock();
    };
    b.mouseup = (e) => {
      this.mouseButtons.delete(e.button);
      this.mouseReleased.add(e.button);
    };
    b.mousemove = (e) => {
      if (this.pointerLocked) {
        this.mouseDX += e.movementX || 0;
        this.mouseDY += e.movementY || 0;
      }
      // Movement is reported locked or not: an unlocked cursor crossing the
      // canvas is still a human at the desk, which is exactly what the demo
      // abort needs to hear about.
      this._notifyRaw('mousemove', '', e.movementX || 0, e.movementY || 0);
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    };
    b.wheel = (e) => {
      this.wheelDelta += e.deltaY;
      if (e.deltaY < 0) this.wheelUp = true;
      else if (e.deltaY > 0) this.wheelDown = true;
      this._notifyRaw('wheel', '', 0, e.deltaY);
      if (this.pointerLocked) e.preventDefault();
    };
    b.contextmenu = (e) => { if (this.enabled) e.preventDefault(); };

    b.pointerlockchange = () => {
      const locked = document.pointerLockElement === this.element;
      if (this.pointerLocked && !locked) this._lastLockExit = performance.now();
      this.pointerLocked = locked;
      this._lockRequestPending = false;
      if (!locked) { this.mouseDX = 0; this.mouseDY = 0; }
      this.element.classList.toggle('locked', locked);
      // Mouse look silently does nothing without the lock, which reads as
      // "the controls are flaky". Let the UI say so explicitly.
      for (const fn of this._lockListeners) {
        try { fn(locked); } catch (e) { console.error(e); }
      }
    };
    b.pointerlockerror = () => {
      this._lockRequestPending = false;
      console.warn('[input] pointer lock request failed');
    };

    b.blur = () => this.clearAll();
    b.visibility = () => { if (document.hidden) this.clearAll(); };

    b.gamepadconnected = (e) => {
      this.gamepadIndex = e.gamepad.index;
      this.gamepadConnected = true;
      console.info(`[input] gamepad connected: ${e.gamepad.id}`);
    };
    b.gamepaddisconnected = (e) => {
      if (e.gamepad.index === this.gamepadIndex) {
        this.gamepadIndex = -1;
        this.gamepadConnected = false;
        this.padButtons.fill(0);
        this.padAxes.fill(0);
      }
    };

    window.addEventListener('keydown', b.keydown, { passive: false });
    window.addEventListener('keyup', b.keyup);
    this.element.addEventListener('mousedown', b.mousedown);
    window.addEventListener('mouseup', b.mouseup);
    window.addEventListener('mousemove', b.mousemove);
    this.element.addEventListener('wheel', b.wheel, { passive: false });
    this.element.addEventListener('contextmenu', b.contextmenu);
    document.addEventListener('pointerlockchange', b.pointerlockchange);
    document.addEventListener('pointerlockerror', b.pointerlockerror);
    window.addEventListener('blur', b.blur);
    document.addEventListener('visibilitychange', b.visibility);
    window.addEventListener('gamepadconnected', b.gamepadconnected);
    window.addEventListener('gamepaddisconnected', b.gamepaddisconnected);
  }

  destroy() {
    const b = this._bound;
    window.removeEventListener('keydown', b.keydown);
    window.removeEventListener('keyup', b.keyup);
    this.element.removeEventListener('mousedown', b.mousedown);
    window.removeEventListener('mouseup', b.mouseup);
    window.removeEventListener('mousemove', b.mousemove);
    this.element.removeEventListener('wheel', b.wheel);
    this.element.removeEventListener('contextmenu', b.contextmenu);
    document.removeEventListener('pointerlockchange', b.pointerlockchange);
    document.removeEventListener('pointerlockerror', b.pointerlockerror);
    window.removeEventListener('blur', b.blur);
    document.removeEventListener('visibilitychange', b.visibility);
    window.removeEventListener('gamepadconnected', b.gamepadconnected);
    window.removeEventListener('gamepaddisconnected', b.gamepaddisconnected);
  }

  /**
   * Drop pending EDGES without touching held state.
   *
   * For a UI that closes on a key and then hands the keyboard back. The closing
   * keydown is recorded by this manager's own window listener whatever the UI
   * does - and a modal's capture-phase listener runs BEFORE that bubble listener
   * for a real event, so the modal cannot clear the edge from inside its own
   * handler. Left pending, the edge is delivered on the next frame and re-opens
   * the thing that just closed. See ui/jump-menu.js's hide().
   */
  clearEdges() {
    this.keysPressed.clear();
    this.keysReleased.clear();
    this.mousePressed.clear();
    this.mouseReleased.clear();
    this.wheelUp = false;
    this.wheelDown = false;
    this._framePressLatch.clear();
  }

  clearAll() {
    this.keys.clear();
    this.mouseButtons.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;
    this.wheelUp = false;
    this.wheelDown = false;
    this.padButtons.fill(0);
    this.padAxes.fill(0);
  }

  // -------------------------------------------------------------------------
  // Pointer lock
  // -------------------------------------------------------------------------

  requestPointerLock() {
    if (this.pointerLocked || this._lockRequestPending) return;
    // Chrome rate-limits re-locking right after an Escape-triggered exit. Retry
    // once the cooldown expires instead of dropping the request on the floor -
    // otherwise a player who taps Escape has to guess that clicking re-arms it.
    const sinceExit = performance.now() - this._lastLockExit;
    if (sinceExit < 1250) {
      if (!this._lockRetry) {
        this._lockRetry = setTimeout(() => {
          this._lockRetry = null;
          if (this.wantsPointerLock && !this.pointerLocked) this.requestPointerLock();
        }, 1250 - sinceExit + 60);
      }
      return;
    }
    this._lockRequestPending = true;
    const p = this.element.requestPointerLock({ unadjustedMovement: true });
    // unadjustedMovement is not universally supported; fall back silently.
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        this._lockRequestPending = false;
        // The fallback returns a promise as well, and a try/catch does not catch
        // a rejected one: it reaches window.onunhandledrejection, which raises
        // the fatal overlay over a game that is running perfectly well. Any
        // environment that refuses pointer lock outright - headless Chrome, an
        // embedded frame - would otherwise report itself as a crash.
        try {
          const q = this.element.requestPointerLock();
          if (q && typeof q.catch === 'function') q.catch(() => {});
        } catch { /* ignore */ }
      });
    }
  }

  /** Subscribe to pointer-lock changes. Returns an unsubscribe function. */
  onPointerLockChange(fn) {
    this._lockListeners.add(fn);
    return () => this._lockListeners.delete(fn);
  }

  /**
   * Subscribe to RAW device activity: `fn(kind, code, dx, dy)` with kind one of
   * 'key' (keydown only, no repeats), 'mousedown', 'mousemove' (dx/dy are the
   * event's movement) or 'wheel' (dy is deltaY).
   *
   * This fires AT THE DOM EVENT, before any frame or sim step runs, which is
   * what makes it fit for the showcase demo's any-input abort: the action/edge
   * layer above is cleared by the simulation's own consumption protocol, so a
   * poller can miss a press that a sim step has already eaten. Listeners decide
   * their own thresholds (e.g. ignoring sub-pixel mouse noise); this reports
   * everything. Returns an unsubscribe function.
   */
  onRawInput(fn) {
    this._rawListeners.add(fn);
    return () => this._rawListeners.delete(fn);
  }

  _notifyRaw(kind, code, dx, dy) {
    if (this._rawListeners.size === 0) return;
    for (const fn of this._rawListeners) {
      try { fn(kind, code, dx, dy); } catch (e) { console.error(e); }
    }
  }

  exitPointerLock() {
    this.wantsPointerLock = false;
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** True when gameplay should be receiving look input. */
  get hasFocus() { return this.pointerLocked; }

  // -------------------------------------------------------------------------
  // Contexts
  // -------------------------------------------------------------------------

  pushContext(ctx) {
    if (this.contextStack[this.contextStack.length - 1] !== ctx) this.contextStack.push(ctx);
  }
  popContext(ctx) {
    if (ctx) {
      const i = this.contextStack.lastIndexOf(ctx);
      if (i > 0) this.contextStack.splice(i, 1);
    } else if (this.contextStack.length > 1) {
      this.contextStack.pop();
    }
  }
  /** Replace everything above GLOBAL with a single context. */
  setContext(ctx) {
    this.contextStack.length = 1;
    if (ctx !== CONTEXT.GLOBAL) this.contextStack.push(ctx);
  }
  get context() { return this.contextStack[this.contextStack.length - 1]; }
  hasContext(ctx) { return this.contextStack.includes(ctx); }

  /** All bindings for an action, searched from the top of the context stack down. */
  _sourcesFor(action) {
    for (let i = this.contextStack.length - 1; i >= 0; i--) {
      const set = this.bindings[this.contextStack[i]];
      const s = set && set[action];
      if (s && s.length) return s;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Source evaluation
  // -------------------------------------------------------------------------

  _digital(src, mode) {
    // mode: 0 = held, 1 = pressed this frame, 2 = released this frame
    const colon = src.indexOf(':');
    const kind = src.slice(0, colon);
    const arg = src.slice(colon + 1);
    switch (kind) {
      case 'Key':
        return mode === 0 ? this.keys.has(arg)
          : mode === 1 ? this.keysPressed.has(arg)
          : this.keysReleased.has(arg);
      case 'Mouse': {
        const b = +arg;
        return mode === 0 ? this.mouseButtons.has(b)
          : mode === 1 ? this.mousePressed.has(b)
          : this.mouseReleased.has(b);
      }
      case 'Wheel':
        if (mode === 2) return false;
        return arg === 'up' ? this.wheelUp : this.wheelDown;
      case 'Pad': {
        const b = +arg;
        if (b >= this.padButtons.length) return false;
        const now = this.padButtons[b] > 0;
        const prev = this.padButtonsPrev[b] > 0;
        return mode === 0 ? now : mode === 1 ? (now && !prev) : (!now && prev);
      }
      case 'PadAxis': {
        const idx = parseInt(arg, 10);
        const half = arg.endsWith('+') ? 1 : arg.endsWith('-') ? -1 : 0;
        const v = this._padAxis(idx);
        const on = half === 0 ? Math.abs(v) > 0.5 : half > 0 ? v > 0.5 : v < -0.5;
        return mode === 0 ? on : false;
      }
      case 'Axis': {
        const [neg, pos] = arg.split('/');
        return mode === 0 ? (this.keys.has(neg) || this.keys.has(pos))
          : mode === 1 ? (this.keysPressed.has(neg) || this.keysPressed.has(pos))
          : (this.keysReleased.has(neg) || this.keysReleased.has(pos));
      }
      default:
        return false;
    }
  }

  _padAxis(i) {
    const raw = i < this.padAxes.length ? this.padAxes[i] : 0;
    const a = Math.abs(raw);
    if (a < this.padDeadzone) return 0;
    // Radial rescale then a response curve for fine control near centre.
    const t = (a - this.padDeadzone) / (1 - this.padDeadzone);
    return Math.sign(raw) * Math.pow(t, this.padCurveExponent);
  }

  _analog(src) {
    const colon = src.indexOf(':');
    const kind = src.slice(0, colon);
    const arg = src.slice(colon + 1);
    if (kind === 'Axis') {
      const [neg, pos] = arg.split('/');
      return (this.keys.has(pos) ? 1 : 0) - (this.keys.has(neg) ? 1 : 0);
    }
    if (kind === 'PadAxis') {
      const idx = parseInt(arg, 10);
      const v = this._padAxis(idx);
      if (arg.endsWith('-')) return -v;
      return v;
    }
    if (kind === 'Pad') {
      const b = +arg;
      return b < this.padButtons.length ? this.padButtons[b] / 255 : 0;
    }
    return this._digital(src, 0) ? 1 : 0;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Is the action currently held? */
  isDown(action) {
    if (!this.enabled) return false;
    const srcs = this._sourcesFor(action);
    if (!srcs) return false;
    for (const s of srcs) if (this._digital(s, 0)) return true;
    return false;
  }

  /** Did the action go down this frame? */
  wasPressed(action) {
    if (!this.enabled) return false;
    const srcs = this._sourcesFor(action);
    if (!srcs) return false;
    for (const s of srcs) if (this._digital(s, 1)) return true;
    return false;
  }

  /**
   * Edge read for consumers that run once per RENDERED FRAME rather than once
   * per simulation step. Returns true exactly once per physical press.
   *
   * wasPressed() cannot promise that. Edges deliberately survive a frame that
   * runs zero simulation steps, so that the sim - which is the intended reader -
   * never misses a press (see markEdgesConsumed). But the handful of toggles
   * driven straight from Game._frame run BEFORE the step loop, so on a
   * zero-step frame they see the same edge a second time and toggle back. At a
   * 120 Hz display against the 60 Hz sim that is about every other frame, which
   * is why those toggles felt like they worked half the time.
   *
   * The latch clears itself the moment the underlying edge goes away, so this
   * needs no cooperation from endFrame() and cannot interact with the
   * consumption protocol the simulation relies on.
   */
  wasPressedOnce(action) {
    if (!this.wasPressed(action)) {
      this._framePressLatch.delete(action);
      return false;
    }
    if (this._framePressLatch.has(action)) return false;
    this._framePressLatch.add(action);
    return true;
  }

  /** Did the action come up this frame? */
  wasReleased(action) {
    if (!this.enabled) return false;
    const srcs = this._sourcesFor(action);
    if (!srcs) return false;
    for (const s of srcs) if (this._digital(s, 2)) return true;
    return false;
  }

  /** Analog value in [-1,1] (or [0,1] for trigger-like actions). */
  axis(action) {
    if (!this.enabled) return 0;
    const srcs = this._sourcesFor(action);
    if (!srcs) return 0;
    let best = 0;
    for (const s of srcs) {
      const v = this._analog(s);
      if (Math.abs(v) > Math.abs(best)) best = v;
    }
    return clamp(best, -1, 1);
  }

  /**
   * Look delta for this frame, in radians, written into `out`.
   *
   *   out[0]  YAW delta, as a change in COMPASS HEADING. Moving the mouse right
   *           is POSITIVE and must turn the view right (clockwise, toward east).
   *   out[1]  PITCH delta, POSITIVE = look UP. Moving the mouse up is therefore
   *           positive, which is why dy is negated below - screen Y grows
   *           downward.
   *
   * Both are meant to be ADDED directly to a heading and a pitch. Every
   * consumer must respect these signs; getting either wrong inverts mouse look,
   * and both were wrong at one point.
   *
   * THIS CALL DRAINS THE MOUSE ACCUMULATOR. That is not an implementation
   * detail, it is the fix for a bug that threw away half of all mouse motion.
   * Mouse deltas arrive per RENDERED frame but are consumed by the FIXED-STEP
   * simulation, which runs 0, 1 or several steps per frame. endFrame() used to
   * zero the accumulator unconditionally, so at 120 Hz display against a 60 Hz
   * sim - where steps-per-frame alternate 1, 0, 1, 0 - every zero-step frame
   * accumulated motion and then discarded it, and at 30 fps the same delta was
   * integrated twice. Look felt jittery and its sensitivity tracked the frame
   * rate. This is the same class of bug as the discarded key presses that
   * markEdgesConsumed() fixed; it was simply never fixed for the continuous
   * axis.
   *
   * Draining on read is exact for every case: N steps in one frame share the
   * delta exactly once, a zero-step frame carries it to the next frame, and
   * nothing is ever counted twice. It is safe because there is exactly ONE look
   * consumer per simulation step - Player._readLook or Vessel._readInput, never
   * both, since Game._simulate branches on inVessel.
   *
   * The GAMEPAD contribution is deliberately outside the drain: a stick is a
   * rate, already multiplied by dt, so it must be sampled per step rather than
   * accumulated and shared out.
   */
  look(out, dt) {
    let dx = this.mouseDX;
    let dy = this.mouseDY;
    // Drain. See the note above.
    this.mouseDX = 0;
    this.mouseDY = 0;
    if (this.mouseSmoothing > 0) {
      const k = saturate(this.mouseSmoothing);
      this._smoothDX = this._smoothDX * k + dx * (1 - k);
      this._smoothDY = this._smoothDY * k + dy * (1 - k);
      dx = this._smoothDX;
      dy = this._smoothDY;
    }
    let yaw = dx * this.mouseSensitivity;
    // Screen Y grows downward, so mouse-up is a negative dy. Negate it here so
    // out[1] follows the "positive is up" contract above.
    let pitch = -dy * this.mouseSensitivity;

    // Right stick (axes 2 and 3 on a standard gamepad).
    const gx = this._padAxis(2);
    const gy = this._padAxis(3);
    // Stick Y also grows downward, so it is negated for the same reason.
    if (gx || gy) {
      yaw += gx * this.padLookSensitivity * dt;
      pitch += -gy * this.padLookSensitivity * dt;
    }

    if (this.invertY) pitch = -pitch;

    if (!this.enabled) {
      out[0] = 0;
      out[1] = 0;
      return out;
    }
    // The gamepad works without pointer lock; the mouse does not, so when the
    // cursor is free only the stick contribution survives.
    if (this.pointerLocked) {
      out[0] = yaw;
      out[1] = pitch;
    } else {
      const padPitch = -gy * this.padLookSensitivity * dt;
      out[0] = gx * this.padLookSensitivity * dt;
      out[1] = this.invertY ? -padPitch : padPitch;
    }
    return out;
  }

  /** Movement vector from MOVE_RIGHT / MOVE_FORWARD, length-clamped to 1. */
  moveVector(out) {
    const x = this.axis(ACTION.MOVE_RIGHT);
    const z = this.axis(ACTION.MOVE_FORWARD);
    const len = Math.hypot(x, z);
    if (len > 1) { out[0] = x / len; out[1] = z / len; }
    else { out[0] = x; out[1] = z; }
    return out;
  }

  // -------------------------------------------------------------------------
  // Frame lifecycle
  // -------------------------------------------------------------------------

  /** Poll the gamepad. Call at the START of the frame, before any queries. */
  beginFrame() {
    if (this.gamepadIndex >= 0 && navigator.getGamepads) {
      const pads = navigator.getGamepads();
      const pad = pads[this.gamepadIndex];
      if (pad) {
        this.padButtonsPrev.set(this.padButtons);
        const n = Math.min(pad.buttons.length, this.padButtons.length);
        for (let i = 0; i < n; i++) {
          this.padButtons[i] = Math.round(saturate(pad.buttons[i].value) * 255);
        }
        const m = Math.min(pad.axes.length, this.padAxes.length);
        for (let i = 0; i < m; i++) this.padAxes[i] = pad.axes[i];
      }
    }
  }

  /**
   * Tell the input system that a simulation step has read the edge state.
   *
   * Edge-triggered input (wasPressed / wasReleased) is only true for one
   * "frame" - but gameplay reads it from the FIXED-TIMESTEP simulation, which
   * does not run on every rendered frame. At 120 Hz display against a 60 Hz
   * sim, roughly half of all rendered frames execute zero simulation steps. If
   * endFrame() cleared edges unconditionally, half of every key press would be
   * discarded before any game code ever saw it - which reads to the player as
   * "the controls don't work half the time".
   *
   * So the sim marks edges consumed, and endFrame() only clears them once they
   * actually have been.
   */
  markEdgesConsumed() {
    this._edgesConsumed = true;
  }

  /**
   * Clear per-frame state. Call at the END of the frame.
   *
   * Edge state is cleared only if a simulation step consumed it - see
   * markEdgesConsumed().
   *
   * The MOUSE DELTA is deliberately NOT cleared here. It is drained by look()
   * instead, so that a rendered frame which runs zero simulation steps carries
   * its motion forward rather than discarding it. Clearing it here is the bug
   * described at length on look(); do not reinstate it.
   */
  endFrame() {
    if (this._edgesConsumed) {
      this.keysPressed.clear();
      this.keysReleased.clear();
      this.mousePressed.clear();
      this.mouseReleased.clear();
      this.wheelUp = false;
      this.wheelDown = false;
      this._edgesConsumed = false;
    }
    this.wheelDelta = 0;
  }

  // -------------------------------------------------------------------------
  // Rebinding & persistence
  // -------------------------------------------------------------------------

  /**
   * Capture the next physical input and bind it to `action` in `context`.
   * @returns {Promise<string>} the captured source string
   */
  startRebind(context, action, slot = 0) {
    return new Promise((resolve) => {
      this._rebind = { context, action, slot, resolve };
    });
  }

  cancelRebind() {
    if (this._rebind) { this._rebind.resolve(null); this._rebind = null; }
  }

  _captureRebind(source) {
    const r = this._rebind;
    this._rebind = null;
    if (!r) return;
    if (source === 'Key:Escape') { r.resolve(null); return; }
    const set = (this.bindings[r.context] ||= {});
    const list = (set[r.action] ||= []);
    list[r.slot] = source;
    r.resolve(source);
  }

  /** Human-readable label for the primary binding of an action, for UI prompts. */
  label(action) {
    const srcs = this._sourcesFor(action);
    if (!srcs || !srcs.length) return '--';
    return prettySource(srcs[0]);
  }

  serializeBindings() { return structuredClone(this.bindings); }

  loadBindings(saved) {
    if (!saved) return;
    this.bindings = structuredClone(DEFAULT_BINDINGS);
    for (const ctx of Object.keys(saved)) {
      if (!this.bindings[ctx]) this.bindings[ctx] = {};
      Object.assign(this.bindings[ctx], saved[ctx]);
    }
  }

  resetBindings() { this.bindings = structuredClone(DEFAULT_BINDINGS); }

  /** Fire a gamepad rumble if the pad supports it. */
  rumble(strong = 0.5, weak = 0.3, durationMs = 120) {
    if (this.gamepadIndex < 0 || !navigator.getGamepads) return;
    const pad = navigator.getGamepads()[this.gamepadIndex];
    const actuator = pad?.vibrationActuator;
    if (!actuator || typeof actuator.playEffect !== 'function') return;
    const now = performance.now();
    if (now < this._rumbleUntil) return; // do not stack rumbles
    this._rumbleUntil = now + durationMs;
    actuator.playEffect('dual-rumble', {
      startDelay: 0,
      duration: durationMs,
      strongMagnitude: saturate(strong),
      weakMagnitude: saturate(weak),
    }).catch(() => { /* not supported */ });
  }
}

const KEY_LABELS = {
  Space: 'Space', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift',
  ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl', AltLeft: 'L-Alt',
  Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backspace: 'Bksp',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
};

const PAD_LABELS = [
  'A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start',
  'LS', 'RS', 'D-Up', 'D-Down', 'D-Left', 'D-Right', 'Home',
];

/** "Key:KeyW" -> "W", "Axis:KeyS/KeyW" -> "W/S", "Pad:0" -> "A". */
export function prettySource(src) {
  const colon = src.indexOf(':');
  const kind = src.slice(0, colon);
  const arg = src.slice(colon + 1);
  const key = (code) => {
    if (KEY_LABELS[code]) return KEY_LABELS[code];
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return 'Num' + code.slice(6);
    return code;
  };
  switch (kind) {
    case 'Key': return key(arg);
    case 'Mouse': return ['LMB', 'MMB', 'RMB'][+arg] || `Mouse${arg}`;
    case 'Wheel': return arg === 'up' ? 'Wheel Up' : 'Wheel Down';
    case 'Pad': return PAD_LABELS[+arg] || `Pad${arg}`;
    case 'PadAxis': return `Stick${arg}`;
    case 'Axis': {
      const [neg, pos] = arg.split('/');
      return `${key(pos)}/${key(neg)}`;
    }
    default: return src;
  }
}
