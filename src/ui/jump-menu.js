/**
 * Developer jump menu (J).
 *
 * Lists every biome at a position where it is actually dominant, takes typed
 * coordinates for anywhere else, and teleports there - with the vessel if you
 * are piloting it, without it if you are on foot. It exists so that preparing a
 * demo or checking a rendering change against the kelp bed, the canyon wall and
 * the trench does not cost minutes of travel per look.
 *
 * Like ControlsHint, it CREATES NO DOM AND INJECTS NO CSS: the markup and the
 * styling live in index.html and this only resolves elements by id, fills the
 * list and toggles a class.
 */

import { CONTEXT } from '../core/input.js';
import { HABITAT_SITE } from '../world/habitat_site.js';
import { ABYSS_ENCOUNTER_SITE } from '../world/abyss_encounter_site.js';
import { PLACES } from '../world/places.js';

/**
 * The fixed rows below the biome anchors: the two stations, then the authored
 * places. One list so a new place is one registry row and zero DOM code, and
 * so tools/test-input.mjs can derive the expected row count instead of
 * hard-coding it (that literal went stale once already, at 14).
 */
const FIXED_ROWS = [
  { key: HABITAT_SITE.short, name: HABITAT_SITE.name, meta: 'fixed landmark · 44 m down' },
  { key: ABYSS_ENCOUNTER_SITE.short, name: ABYSS_ENCOUNTER_SITE.name, meta: 'staged encounter · 900 m down' },
  ...PLACES.flatMap((p) => [
    {
      key: p.short, name: p.name,
      meta: `authored place · ${Math.round(-p.seabedY)} m down`,
    },
    // A place with an authored cave interior gets a second row. The key
    // convention ('<short>-in') is what main.js jumpTo's re-seat branch
    // matches on; see the caveArrival consumer note in world/places.js.
    ...(p.caveArrival ? [{
      key: `${p.short}-in`, name: `${p.name} · chamber`,
      meta: `cave interior · ${Math.round(-p.caveArrival.y)} m down`,
    }] : []),
  ]),
];

/** Seconds the arrival status line stays up after the menu closes. */
const STATUS_SECONDS = 4.0;

export class JumpMenu {
  /** @param {object} game the Game instance; held by reference and read lazily,
   *   because the systems it reaches do not exist until boot stage 5. */
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('jump-menu');
    this.panelEl = document.getElementById('jump-panel');
    this.listEl = document.getElementById('jump-list');
    this.statusEl = document.getElementById('jump-status');
    this.toastEl = document.getElementById('jump-toast');
    this.formEl = document.getElementById('jump-form');
    this.inputEl = document.getElementById('jump-coords');

    this._open = false;
    this._anchors = null;
    this._statusTimer = 0;
    this._arrival = null;

    this._onKeyDown = this._onKeyDown.bind(this);
    this.formEl?.addEventListener('submit', (e) => {
      e.preventDefault();
      this._jump(this.inputEl.value);
    });
  }

  /** Is the menu up? main.js gates four things on this. */
  get open() { return this._open; }

  toggle() { if (this._open) this.hide(); else this.show(); }

  show() {
    if (this._open || !this.root) return;
    this._open = true;
    this.root.classList.add('show');

    const input = this.game.input;
    input.exitPointerLock();
    // Honesty, not the guarantee: this makes input.context describe reality and
    // makes ControlsHint hide itself (there is no CONTEXT.UI legend). The
    // GUARANTEE is `enabled` below - do not delete one thinking the other covers it.
    input.setContext(CONTEXT.UI);
    // THIS IS THE WHOLE MECHANISM, and it solves two problems with one flag.
    // It gates gameplay completely: isDown/wasPressed/wasReleased/axis all
    // early-return and look() zeroes its output, so nothing leaks into the sim.
    // And it DISARMS THE KEY SWALLOWER - the window keydown handler's
    // preventDefault is gated on `enabled`, and SWALLOW_CODES contains Space,
    // Tab and the arrows, so with input live a space typed into the coordinate
    // field would be eaten AND would make the player jump. No context push can
    // do that second half; that is why this is a flag and not a context.
    input.enabled = false;
    this.game._syncLockHint();
    window.addEventListener('keydown', this._onKeyDown, true);

    this.inputEl.value = '';
    this._renderList();
    // FOCUS THE PANEL, NOT THE COORDINATE FIELD. Autofocusing the text input
    // looks helpful and breaks the hotkey: _onKeyDown must ignore J while a text
    // field has focus (a field may not eat a letter to a global hotkey), so J
    // opened the menu and then could never close it. The list is the primary
    // action anyway - click the field when you want to type.
    this.panelEl?.focus();
    // Paint the panel BEFORE the ~60 ms anchor scan, or the menu appears late
    // and the hitch reads as the hotkey not responding.
    requestAnimationFrame(() => {
      if (!this._open) return;
      this._fillList();
      // Move focus onto the first row once the rows exist, so Tab and the arrow
      // keys have somewhere to go and Enter jumps.
      if (document.activeElement === this.panelEl) this._focusRow(0);
    });
  }

  hide() {
    if (!this._open || !this.root) return;
    this._open = false;
    this.root.classList.remove('show');
    window.removeEventListener('keydown', this._onKeyDown, true);
    this.inputEl.blur();

    const input = this.game.input;
    // A key physically held while the menu was up produced no fresh keydown, so
    // re-enabling without a clear hands the simulation a key the player has
    // already forgotten about. This is the same reason the window blur handler
    // calls it.
    input.clearAll();
    input.wantsPointerLock = true;
    // requestPointerLock carries its own 1250 ms Chrome relock retry. Do not add
    // a second timer here; two racing is how you get a lock that toggles.
    input.requestPointerLock();
    this.game._syncLockHint();

    // RE-ENABLE ON THE NEXT FRAME, AFTER DROPPING THE CLOSING KEYDOWN'S EDGE.
    //
    // The J that closed the menu is still recorded in the input manager, because
    // its window listener runs whatever this does - and for a real key event
    // this modal's CAPTURE listener fires before that BUBBLE listener, so the
    // edge cannot be cleared from inside the handler that used it. Measured: the
    // menu closed and re-opened one frame later, every time, looking exactly
    // like the hotkey being ignored. clearAll() does not help - it clears held
    // keys, not the edge sets.
    requestAnimationFrame(() => {
      if (this._open) return;   // re-opened in the meantime; leave it alone
      input.clearEdges();
      input.enabled = true;
    });
  }

  /**
   * Tick the arrival status line. Costs one compare per frame when idle.
   * @param {number} dt seconds
   */
  update(dt) {
    if (this._statusTimer <= 0) return;
    this._statusTimer -= dt;
    if (this._arrival) this._showArrival();
    if (this._statusTimer <= 0) {
      this._arrival = null;
      this.toastEl?.classList.remove('show', 'warn');
    }
  }

  // -------------------------------------------------------------------------

  _setStatus(text, kind = '') {
    if (!this.statusEl) return;
    this.statusEl.textContent = text;
    this.statusEl.className = kind;
  }

  /** Placeholder rows, so the panel has its real size before the scan runs. */
  _renderList() {
    if (this._anchors) { this._paintRows(); return; }
    this.listEl.replaceChildren();
    this._setStatus('Resolving biome anchors from the terrain...');
  }

  _fillList() {
    const t0 = performance.now();
    this._anchors = this.game.biomeAnchors();
    const ms = performance.now() - t0;
    this._paintRows();
    const weak = this._anchors.filter((a) => !a.dominant).length;
    // Report the cost. A dev tool should show its own price, and a resolve that
    // suddenly takes 400 ms is a terrain regression worth noticing.
    this._setStatus(
      `${this._anchors.length} anchors resolved in ${ms.toFixed(0)} ms` +
      (weak ? ` - ${weak} not dominant anywhere` : ''),
      weak ? 'warn' : '',
    );
  }

  _paintRows() {
    const frag = document.createDocumentFragment();
    for (const a of this._anchors) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      if (!a.dominant) btn.className = 'weak';

      const idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = String(a.id).padStart(2, '0');
      const name = document.createElement('span');
      name.textContent = a.name;
      const meta = document.createElement('span');
      meta.className = 'meta';
      const d = -a.height;
      meta.textContent = a.dominant
        ? (d > 0 ? `${d.toFixed(0)} m down` : `+${a.height.toFixed(0)} m`)
        : `weight ${a.weight.toFixed(2)} - NOT dominant`;

      btn.append(idx, name, meta);
      btn.addEventListener('click', () => this._jump(a.id));
      li.append(btn);
      frag.append(li);
    }
    for (const row of FIXED_ROWS) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      const idx = document.createElement('span');
      idx.className = 'idx'; idx.textContent = '◆';
      const name = document.createElement('span');
      name.textContent = row.name;
      const meta = document.createElement('span');
      meta.className = 'meta'; meta.textContent = row.meta;
      btn.append(idx, name, meta);
      btn.addEventListener('click', () => this._jump(row.key));
      li.append(btn);
      frag.append(li);
    }
    this.listEl.replaceChildren(frag);
  }

  /** @param {number|string} target biome id or a coordinate string */
  _jump(target) {
    const result = this.game.jumpTo(target);
    if (result.error) {
      this._setStatus(result.error, 'error');
      this.inputEl.focus();
      return;
    }
    this._arrival = result;
    this._statusTimer = STATUS_SECONDS;
    this.hide();
  }

  /**
   * The arrival line, rebuilt each frame while it is up so the chunk count is
   * live. It says `streaming` because that is the truth: the resident chunk set
   * was kilometres away a moment ago and the terrain arrives over the next
   * second or so. A dev tool that hid that could not be used to judge streaming.
   *
   * It writes #jump-toast, which lives OUTSIDE #jump-menu. Writing the panel's
   * own status line here would be writing into a display:none subtree, because
   * _jump() closes the menu on the way out - the readout would never once be
   * seen, and the countdown would tick for nothing.
   */
  _showArrival() {
    if (!this.toastEl) return;
    const r = this._arrival;
    const chunks = this.game.chunks?.loadedCount ?? 0;
    this.toastEl.textContent =
      `${r.label ? r.label + '  ' : ''}` +
      `${r.x.toFixed(0)}, ${r.y.toFixed(0)}, ${r.z.toFixed(0)}` +
      `  depth ${r.depth.toFixed(0)} m  suit ${r.suitTier}` +
      (r.inVessel ? `  hull ${r.hullTier}` : '') +
      `  streaming, ${chunks} chunks` +
      (r.warn ? `  ${r.warn}` : '');
    this.toastEl.classList.add('show');
    this.toastEl.classList.toggle('warn', !!r.warn);
  }

  /** @param {number} i row index, clamped */
  _focusRow(i) {
    const rows = this.listEl?.querySelectorAll('button');
    if (!rows || !rows.length) return;
    rows[Math.max(0, Math.min(rows.length - 1, i))].focus();
  }

  _onKeyDown(e) {
    if (e.code === 'Escape') {
      e.preventDefault(); e.stopPropagation(); this.hide(); return;
    }
    const typing = document.activeElement === this.inputEl;
    // J closes - but NEVER while the coordinate field has focus. A text field
    // must not eat a letter to a global hotkey, even one no coordinate contains.
    if (e.code === 'KeyJ' && !typing) {
      e.preventDefault(); this.hide(); return;
    }
    if (!typing && (e.code === 'ArrowDown' || e.code === 'ArrowUp')) {
      e.preventDefault();
      const rows = Array.from(this.listEl?.querySelectorAll('button') ?? []);
      const at = rows.indexOf(document.activeElement);
      this._focusRow(at < 0 ? 0 : at + (e.code === 'ArrowDown' ? 1 : -1));
    }
  }
}
