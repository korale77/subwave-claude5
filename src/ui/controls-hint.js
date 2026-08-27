/**
 * Contextual control legend.
 *
 * A player tested SUBWAVE and could not work out how to dive or how to climb.
 * Nothing was wrong with the bindings - Space and Ctrl worked the whole time -
 * but nothing on screen said they existed, and a control you cannot discover
 * does not exist as far as the player is concerned.
 *
 * So this shows only the keys that do something in the CURRENT input context,
 * and it names the two that were impossible to guess explicitly: how to go
 * down, and how to go up.
 *
 * It is a DOM overlay rather than part of the Canvas2D HUD on purpose. It is
 * chrome, not instrumentation - it should not be projected on the canopy glass
 * with the flight instruments, it needs selectable-looking text at small sizes,
 * and it must be trivially toggleable.
 */

import { CONTEXT, ACTION } from '../core/input.js';

/**
 * Per-context legend. Each entry is [label, actionOrLiteral, isPrimary].
 * When the second element is an ACTION the live binding is looked up, so a
 * rebound key shows its real label rather than a stale hard-coded one.
 * `isPrimary` highlights the lines that answer "how do I move?".
 */
const LEGENDS = {
  [CONTEXT.FOOT]: {
    title: 'On foot',
    rows: [
      ['Move', ACTION.MOVE_FORWARD, true],
      ['Jump', ACTION.JUMP, false],
      ['Sprint', ACTION.SPRINT, false],
      ['Board vessel', ACTION.BOARD, true],
      ['Flashlight', ACTION.FLASHLIGHT, false],
      ['Swim', 'Walk into the water', true],
      ['Showcase demo (G or Esc stops it)', ACTION.DEMO_SHOWCASE, false],
      // Shift+G is not an ACTION - the binding grammar has no modifier form, so
      // the modifier is read at the press site in main.js. Written as a literal
      // key label for the same reason, and stated here because an opt-in that
      // nothing announces is an opt-in nobody finds.
      ['Showcase demo + record video', 'Shift+G', false],
    ],
  },
  [CONTEXT.SWIM]: {
    title: 'Swimming',
    rows: [
      ['Swim', ACTION.MOVE_FORWARD, true],
      ['DIVE (down)', 'Ctrl', true],
      ['Rise (up)', 'Space', true],
      ['Sprint fins', ACTION.SPRINT, false],
      ['Board vessel', ACTION.BOARD, true],
      ['Flashlight', ACTION.FLASHLIGHT, false],
      ['Showcase demo (G or Esc stops it)', ACTION.DEMO_SHOWCASE, false],
      // Shift+G is not an ACTION - the binding grammar has no modifier form, so
      // the modifier is read at the press site in main.js. Written as a literal
      // key label for the same reason, and stated here because an opt-in that
      // nothing announces is an opt-in nobody finds.
      ['Showcase demo + record video', 'Shift+G', false],
    ],
  },
  // The vessel legends name the MOUSE as the way to dive and to surface, because
  // that is now literally true: the mouse aims the hull and W drives along the
  // aim. The rows this replaces named a flood key, a blow key and a hold-depth
  // key - three controls the player had to learn to do what pointing now does.
  [CONTEXT.VESSEL_AIR]: {
    title: 'Flying',
    rows: [
      ['Point where you want to go', 'Mouse', true],
      ['Thrust / reverse', ACTION.THROTTLE, true],
      ['Strafe', ACTION.MOVE_RIGHT, false],
      ['Fine up / down', 'Space / Shift', false],
      ['Exterior lights', ACTION.LIGHTS_TOGGLE, false],
      ['View', ACTION.CAMERA_TOGGLE, false],
      ['Exit vessel', ACTION.DISEMBARK, true],
      ['To DIVE', 'Aim down and fly into the sea', true],
    ],
  },
  [CONTEXT.VESSEL_WATER]: {
    title: 'Submerged',
    rows: [
      ['DIVE / Surface - point where you want to go', 'Mouse', true],
      ['Thrust / reverse', ACTION.THROTTLE, true],
      ['Strafe', ACTION.MOVE_RIGHT, false],
      ['Fine up / down', 'Space / Shift', false],
      ['Exterior lights', ACTION.LIGHTS_TOGGLE, false],
      ['Sonar', ACTION.SONAR, false],
      ['Silent running', ACTION.SILENT_RUNNING, false],
      ['Exit vessel', ACTION.DISEMBARK, true],
    ],
  },
};

/** Seconds the legend stays fully opaque after the context changes. */
const BRIGHT_SECONDS = 12;
/** Seconds after which it hides itself entirely. */
const HIDE_SECONDS = 34;

export class ControlsHint {
  /**
   * @param {import('../core/input.js').InputManager} input
   */
  constructor(input) {
    this.input = input;
    this.root = document.getElementById('controls');
    this.titleEl = document.getElementById('controls-title');
    this.listEl = document.getElementById('controls-list');

    /** User toggle (H). When false the legend never shows. */
    this.enabled = true;
    this._context = null;
    this._elapsed = 0;
    this._visible = false;
  }

  /** Toggle visibility, and reset the fade so it comes back fully lit. */
  toggle() {
    this.enabled = !this.enabled;
    this._elapsed = 0;
    if (!this.enabled) this._hide();
    else this._render(this.input.context, true);
    return this.enabled;
  }

  /** Re-show the legend, e.g. after the context changes or on demand. */
  reveal() {
    this._elapsed = 0;
    if (this.enabled) this._render(this.input.context, true);
  }

  update(dt, paused) {
    if (!this.root) return;

    if (!this.enabled || paused) {
      this._hide();
      return;
    }

    const ctx = this.input.context;
    if (ctx !== this._context) {
      // A context change is exactly the moment the player needs new keys.
      this._context = ctx;
      this._elapsed = 0;
      this._render(ctx, true);
      return;
    }

    this._elapsed += dt;
    if (this._elapsed > HIDE_SECONDS) {
      this._hide();
    } else if (this._elapsed > BRIGHT_SECONDS) {
      this.root.classList.add('faded');
    }
  }

  _hide() {
    if (!this._visible) return;
    this._visible = false;
    this.root.classList.remove('show', 'faded');
  }

  _render(context, show) {
    const legend = LEGENDS[context];
    if (!legend) { this._hide(); return; }

    this.titleEl.textContent = legend.title;

    // Rebuild wholesale: it changes only on a context switch, a handful of
    // times per session, so there is nothing to gain from diffing.
    const frag = document.createDocumentFragment();
    for (const [label, binding, primary] of legend.rows) {
      const dt = document.createElement('dt');
      // A binding that names an ACTION is resolved live, so a rebound key is
      // always shown correctly.
      dt.textContent = Object.values(ACTION).includes(binding)
        ? this.input.label(binding)
        : binding;
      const dd = document.createElement('dd');
      dd.textContent = label;
      if (primary) dd.className = 'key';
      frag.append(dt, dd);
    }
    this.listEl.replaceChildren(frag);

    if (show) {
      this.root.classList.add('show');
      this.root.classList.remove('faded');
      this._visible = true;
    }
  }
}
