#!/usr/bin/env node
/**
 * SUBWAVE HUD verification.
 *
 * Drives src/ui/hud.js against a recording stub of CanvasRenderingContext2D and
 * a stub GPUDevice, so every draw path runs with no browser and no GPU.
 *
 * What it actually proves:
 *   1. No draw path throws, at either extreme of every input.
 *   2. No non-finite number and no NaN-bearing colour string ever reaches a
 *      canvas call - the failure mode that silently blanks a Canvas2D layer.
 *   3. Every uploaded rectangle lies inside the canvas, at 4:3, 16:9 and 32:9,
 *      and at both ends of the HUD scale range.
 *   4. The compass spring takes the SHORT way through the 359/000 wrap.
 *   5. Dirty tracking actually elides work: a settled HUD uploads nothing on
 *      the free-swim display, and only the animated sonar (plus the region it
 *      overlaps) in the cockpit.
 *
 * Usage:  node tools/test-hud.mjs
 */

import { HUD, drawText, textWidth, GLYPHS, DEG } from '../src/ui/hud.js';
import { settings } from '../src/core/settings.js';
import { PLAYER, VESSEL } from '../src/core/constants.js';
import { wrapAngle, radToDeg } from '../src/core/math.js';

let failures = 0;
let checks = 0;

function ok(cond, label, detail = '') {
  checks++;
  if (cond) {
    console.log(`  ok   ${label}${detail ? '  ' + detail : ''}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? '  ' + detail : ''}`);
  }
}

function section(name) {
  console.log(`\n${name}`);
}

// ---------------------------------------------------------------------------
// Stub Canvas2D
// ---------------------------------------------------------------------------

const NUMERIC_METHODS = new Set([
  'clearRect', 'fillRect', 'strokeRect', 'rect', 'moveTo', 'lineTo', 'arc',
  'arcTo', 'quadraticCurveTo', 'bezierCurveTo', 'translate', 'rotate', 'scale',
  'setTransform', 'ellipse', 'fillText', 'strokeText', 'setLineDash',
]);

class StubContext2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.calls = 0;
    this.violations = [];
    this._fillStyle = '#000';
    this._strokeStyle = '#000';
    this._lineWidth = 1;
    this.lineCap = 'butt';
    this.lineJoin = 'miter';
    this.imageSmoothingEnabled = true;
    this.font = '';
    this.globalAlpha = 1;
    this.minLineWidth = Infinity;

    for (const name of [
      'save', 'restore', 'beginPath', 'closePath', 'fill', 'stroke', 'clip',
      'clearRect', 'fillRect', 'strokeRect', 'rect', 'moveTo', 'lineTo', 'arc',
      'translate', 'rotate', 'scale', 'setLineDash', 'fillText', 'strokeText',
    ]) {
      this[name] = (...args) => this._record(name, args);
    }
  }

  _record(name, args) {
    this.calls++;
    if (NUMERIC_METHODS.has(name)) {
      for (let i = 0; i < args.length; i++) {
        const v = args[i];
        if (typeof v === 'number' && !Number.isFinite(v)) {
          this.violations.push(`${name}() arg ${i} = ${v}`);
        }
      }
    }
  }

  _checkColor(which, v) {
    if (typeof v !== 'string' || v.includes('NaN') || v.includes('undefined') ||
        v.includes('Infinity')) {
      this.violations.push(`${which} = ${String(v)}`);
    }
  }

  set fillStyle(v) { this._checkColor('fillStyle', v); this._fillStyle = v; }
  get fillStyle() { return this._fillStyle; }
  set strokeStyle(v) { this._checkColor('strokeStyle', v); this._strokeStyle = v; }
  get strokeStyle() { return this._strokeStyle; }

  set lineWidth(v) {
    if (!Number.isFinite(v) || v <= 0) this.violations.push(`lineWidth = ${v}`);
    else this.minLineWidth = Math.min(this.minLineWidth, v);
    this._lineWidth = v;
  }
  get lineWidth() { return this._lineWidth; }

  measureText(t) { return { width: t.length * 8 }; }
}

class StubCanvas {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.ctx = new StubContext2D(this);
  }
  getContext() { return this.ctx; }
}

// ---------------------------------------------------------------------------
// Stub GPU + environment
// ---------------------------------------------------------------------------

const uploads = [];

function makeStubDevice() {
  return {
    createTexture: () => ({
      createView: () => ({ stub: 'view' }),
      destroy() {},
    }),
    queue: {
      copyExternalImageToTexture(src, dst, size) {
        uploads.push({
          x: src.origin.x, y: src.origin.y, w: size.width, h: size.height,
        });
      },
    },
  };
}

function makeRenderer(width, height) {
  return {
    exposure: 1,
    lens: { wetness: 0, stress: 0 },
    gpu: { width, height, device: makeStubDevice() },
    camera: {
      position: new Float32Array([0, 4, 0]),
      forward: new Float32Array([0, 0, -1]),
      speed: 0,
      depth: 0,
    },
  };
}

globalThis.OffscreenCanvas = StubCanvas;
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeGame(overrides = {}) {
  const p = Object.assign({
    inVessel: true,
    position: new Float32Array([0, -100, 0]),
    oxygen: 90, oxygenCapacity: 90, health: 100,
  }, overrides.player || {});
  const v = Object.assign({
    position: new Float32Array([0, -100, 0]),
    depth: 100, heading: 0, pitch: 0, roll: 0, speed: 12,
    underwater: true, powerFraction: 0.8, hullFraction: 1.0,
    ballast: VESSEL.BALLAST_NEUTRAL, depthRating: VESSEL.DEPTH_RATINGS[0],
    depthHold: null, holdActive: false, lightsOn: true, silentRunning: false,
    sonarRange: 240, sonarActive: true, leak: 0, heat: 0, cabinOxygen: VESSEL.CABIN_OXYGEN,
  }, overrides.vessel || {});
  return { player: p, vessel: v };
}

async function makeHud(width = 1920, height = 1080) {
  uploads.length = 0;
  const hud = new HUD(makeRenderer(width, height));
  await hud.init();
  return hud;
}

function run(hud, game, frames, dt = 1 / 60) {
  for (let i = 0; i < frames; i++) hud.update(dt, game);
}

function violations(hud) {
  return hud.ctx.violations;
}

// ---------------------------------------------------------------------------
// 1. Font coverage
// ---------------------------------------------------------------------------

section('Stroke font');
{
  const canvas = new StubCanvas(256, 256);
  const ctx = canvas.getContext('2d');
  const all = Object.keys(GLYPHS).join('');
  ctx.lineWidth = 2;
  drawText(ctx, all, 10, 100, 24, { align: 'left', baseline: 'bottom' });
  ok(ctx.violations.length === 0, 'every glyph strokes with finite coordinates',
    ctx.violations.slice(0, 3).join('; '));
  const required = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const absent = [...required].filter((c) => GLYPHS[c] === undefined);
  ok(absent.length === 0, 'full uppercase alphabet and digit set',
    absent.length ? `missing ${absent.join('')}` : `${Object.keys(GLYPHS).length} glyphs total`);
  ok(GLYPHS[DEG] !== undefined && GLYPHS['%'] !== undefined && GLYPHS[':'] !== undefined,
    'degree sign, percent and colon are present');

  const w1 = textWidth('000', 24);
  const w2 = textWidth('888', 24);
  ok(Math.abs(w1 - w2) < 1e-9, 'monospace: all digit strings measure identically',
    `${w1.toFixed(3)} px`);
  ok(textWidth('', 24) === 0, 'empty string has zero width');

  // Every string the HUD can emit must be drawable.
  const alphabet = new Set(Object.keys(GLYPHS));
  const emitted = 'NSEW NE SE SW NW DEPTH MAX PWR HUL BAL O2 HULL HEAT LEAK AIR WTR KT ' +
    'M PASSIVE FLD BLW AUTO LGT SIL INTEG BAR O2 S 0123456789+-.:%/<>_' + DEG;
  const missing = [...emitted].filter((c) => !alphabet.has(c));
  ok(missing.length === 0, 'every character the HUD emits has a glyph',
    missing.length ? `missing: ${missing.join('')}` : '');
}

// ---------------------------------------------------------------------------
// 2. Extreme cockpit states
// ---------------------------------------------------------------------------

section('Cockpit HUD - extreme states');
{
  const cases = [
    ['surface, zero everything', { vessel: { depth: 0, speed: 0, heading: 0, pitch: 0, roll: 0, underwater: false, powerFraction: 0, hullFraction: 0, ballast: 0 } }],
    ['hadal, past crush depth', { vessel: { depth: 1600, depthRating: VESSEL.DEPTH_RATINGS[0], speed: 21, hullFraction: 0.01, powerFraction: 0.02 } }],
    ['heading at the 000 wrap', { vessel: { heading: 6.28318530717 } }],
    ['heading just past 359', { vessel: { heading: 0.0001 } }],
    ['inverted flight', { vessel: { pitch: 0.3, roll: Math.PI, underwater: false, depth: 0 } }],
    ['pitch past vertical', { vessel: { pitch: 2.9, roll: 0.4 } }],
    ['negative vertical speed, fast dive', { vessel: { depth: 400, verticalSpeed: -24 } }],
    ['positive vertical speed, emergency blow', { vessel: { depth: 400, verticalSpeed: 24 } }],
    ['ballast fully blown', { vessel: { ballast: 0 } }],
    ['ballast fully flooded', { vessel: { ballast: 1 } }],
    ['cabin O2 exhausted', { vessel: { cabinOxygen: 0 } }],
    ['leak and overheat', { vessel: { leak: 1, heat: 1 } }],
    ['silent running, sonar passive', { vessel: { silentRunning: true, sonarActive: false, lightsOn: false } }],
    ['depth-hold bug set', { vessel: { depthHold: 250, depth: 240 } }],
    ['depth-hold far off tape', { vessel: { depthHold: 1500, depth: 10 } }],
  ];

  for (const [label, over] of cases) {
    const hud = await makeHud();
    const game = makeGame(over);
    run(hud, game, 90);
    const v = violations(hud);
    ok(v.length === 0, label, v.length ? v.slice(0, 3).join('; ') : `${hud.ctx.calls} canvas calls`);
  }
}

// ---------------------------------------------------------------------------
// 3. Hostile / malformed inputs
// ---------------------------------------------------------------------------

section('Hostile inputs');
{
  const hud = await makeHud();
  const game = makeGame({
    vessel: {
      depth: NaN, heading: NaN, pitch: Infinity, roll: -Infinity, speed: NaN,
      powerFraction: NaN, hullFraction: undefined, ballast: null,
      depthRating: 0, verticalSpeed: NaN, sonarRange: 0,
    },
    player: { oxygen: NaN, oxygenCapacity: 0, health: NaN },
  });
  run(hud, game, 60);
  ok(violations(hud).length === 0, 'NaN/Infinity/undefined state never reaches the canvas',
    violations(hud).slice(0, 4).join('; '));
  ok(Number.isFinite(hud.disp.depth) && Number.isFinite(hud.disp.heading) &&
     Number.isFinite(hud.disp.verticalSpeed) && Number.isFinite(hud.gain),
  'damped display values stay finite',
  `depth=${hud.disp.depth} hdg=${hud.disp.heading.toFixed(4)} gain=${hud.gain.toFixed(4)}`);

  const hud2 = await makeHud();
  hud2.update(0, undefined);
  hud2.update(1e9, undefined);
  hud2.update(-5, null);
  hud2.update(NaN, {});
  run(hud2, {}, 20);
  ok(violations(hud2).length === 0, 'no game object, absurd dt, negative dt, NaN dt',
    violations(hud2).slice(0, 3).join('; '));

  const hud3 = await makeHud();
  const g3 = makeGame();
  hud3.renderer.exposure = 0;
  run(hud3, g3, 10);
  hud3.renderer.exposure = 1e30;
  run(hud3, g3, 10);
  hud3.renderer.exposure = NaN;
  run(hud3, g3, 10);
  ok(violations(hud3).length === 0 && Number.isFinite(hud3.gain),
    'degenerate renderer.exposure cannot poison the HUD gain', `gain=${hud3.gain}`);
}

// ---------------------------------------------------------------------------
// 4. Free-swim HUD
// ---------------------------------------------------------------------------

section('Free-swim wrist display');
{
  const o2Cases = [
    ['nominal', PLAYER.OXYGEN_TIERS[0]],
    ['caution', PLAYER.OXYGEN_WARN * 1.5],
    ['warning', PLAYER.OXYGEN_WARN - 1],
    ['critical', PLAYER.OXYGEN_CRITICAL - 1],
    ['empty', 0],
  ];
  for (const [label, o2] of o2Cases) {
    const hud = await makeHud();
    const game = makeGame({
      player: { inVessel: false, oxygen: o2, oxygenCapacity: PLAYER.OXYGEN_TIERS[0], health: 12 },
    });
    game.player.depth = 180;
    game.player.heading = 4.9;
    run(hud, game, 120);
    const v = violations(hud);
    ok(v.length === 0 && hud.mode === 'swim', `O2 ${label} (${o2.toFixed(1)} s)`,
      v.length ? v.slice(0, 3).join('; ') : `stress=${hud.stress.toFixed(3)}`);
  }

  // The escalation must be monotone: more urgency as oxygen falls.
  const stressAt = async (o2) => {
    const hud = await makeHud();
    const game = makeGame({ player: { inVessel: false, oxygen: o2, oxygenCapacity: 90 } });
    run(hud, game, 60);
    return hud.stress;
  };
  const s90 = await stressAt(90);
  const s30 = await stressAt(PLAYER.OXYGEN_WARN);
  const s10 = await stressAt(PLAYER.OXYGEN_CRITICAL);
  const s0 = await stressAt(0);
  ok(s90 === 0 && s30 > s90 && s10 > s30 && s0 >= s10 && s0 === 1,
    'stress escalates monotonically to 1.0 at empty',
    `${s90.toFixed(2)} -> ${s30.toFixed(2)} -> ${s10.toFixed(2)} -> ${s0.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// 5. Compass wrap
// ---------------------------------------------------------------------------

section('Compass spring across the 359/000 wrap');
{
  const hud = await makeHud();
  const game = makeGame();
  game.vessel.heading = (359.5 * Math.PI) / 180;
  run(hud, game, 240);
  const startDeg = radToDeg(hud.disp.heading);

  // Snap the target across the wrap.
  game.vessel.heading = (0.5 * Math.PI) / 180;
  let maxStep = 0;
  let prev = hud.disp.heading;
  for (let i = 0; i < 120; i++) {
    hud.update(1 / 60, game);
    maxStep = Math.max(maxStep, Math.abs(radToDeg(wrapAngle(hud.disp.heading - prev))));
    prev = hud.disp.heading;
  }
  const endDeg = radToDeg(hud.disp.heading);
  const err = Math.abs(radToDeg(wrapAngle(hud.disp.heading - game.vessel.heading)));
  ok(maxStep < 1.0, 'no single frame jumps the long way round',
    `max step ${maxStep.toFixed(4)} deg (start ${startDeg.toFixed(2)}, end ${endDeg.toFixed(2)})`);
  ok(err < 0.05, 'settles on the target heading', `error ${err.toFixed(4)} deg`);
  ok(hud.disp.heading >= 0 && hud.disp.heading < Math.PI * 2,
    'displayed heading stays in [0, 2PI)', `${hud.disp.heading.toFixed(6)} rad`);

  // 359 -> 001 must never route through 180.
  const hud2 = await makeHud();
  const g2 = makeGame();
  g2.vessel.heading = (359 * Math.PI) / 180;
  run(hud2, g2, 240);
  g2.vessel.heading = (1 * Math.PI) / 180;
  let wentSouth = false;
  for (let i = 0; i < 120; i++) {
    hud2.update(1 / 60, g2);
    const d = radToDeg(hud2.disp.heading);
    if (d > 90 && d < 270) wentSouth = true;
  }
  ok(!wentSouth, 'the ribbon never scrolls through south to get from 359 to 001');
}

// ---------------------------------------------------------------------------
// 6. Layout safety across aspect ratios and HUD scales
// ---------------------------------------------------------------------------

section('Layout containment');
{
  const sizes = [[1440, 1080], [1920, 1080], [3440, 1080], [2560, 1440], [1280, 720]];
  const scales = [0.75, 1.0, 1.5];
  let worst = '';
  let worstColumn = '';
  let allInside = true;
  let columnClear = true;
  let smallestCap = Infinity;

  for (const [w, h] of sizes) {
    for (const scale of scales) {
      settings.set('hudScale', scale);
      const hud = await makeHud(w, h);
      const game = makeGame();
      run(hud, game, 30);
      for (const r of hud._cockpitRegions.concat(hud._swimRegions)) {
        if (r.x < 0 || r.y < 0 || r.x + r.w > w || r.y + r.h > h) {
          allInside = false;
          worst = `${w}x${h} @${scale}: ${r.id} = ${r.x},${r.y} ${r.w}x${r.h}`;
        }
      }
      // The left column must never collide with itself: the speed tape and the
      // systems stack share an x range, so an overlap there is a real one. So
      // is the stack running into the annunciator strip below it - which is the
      // collision the column solve exists to prevent, and the one it used to
      // miss at every resolution at hudScale 1.5.
      const speed = hud._cockpitRegions.find((r) => r.id === 'speed');
      const sys = hud._cockpitRegions.find((r) => r.id === 'systems');
      const ann = hud._cockpitRegions.find((r) => r.id === 'annunciators');
      if (speed.y + speed.h > sys.y) {
        columnClear = false;
        worstColumn = `${w}x${h} @${scale}: speed ends ${speed.y + speed.h}, systems starts ${sys.y}`;
      }
      if (sys.y + sys.h > ann.y && sys.x < ann.x + ann.w && ann.x < sys.x + sys.w) {
        columnClear = false;
        worstColumn = `${w}x${h} @${scale}: systems ends ${sys.y + sys.h}, annunciators start ${ann.y}`;
      }
      smallestCap = Math.min(smallestCap, hud.ctx.minLineWidth);
    }
  }
  settings.set('hudScale', 1.0);
  ok(allInside, 'every region rect stays inside the canvas at 4:3, 16:9, 21:9 and 720p', worst);
  ok(columnClear, 'the left column never overlaps itself or the annunciators', worstColumn);
  ok(smallestCap >= 1.15, 'no stroke thins below the 1.15 device-px AA floor',
    `min lineWidth ${smallestCap.toFixed(3)} px`);
}

// ---------------------------------------------------------------------------
// 7. Upload containment and dirty tracking
// ---------------------------------------------------------------------------

section('Dirty tracking and uploads');
{
  const W = 1920;
  const H = 1080;
  const hud = await makeHud(W, H);
  const game = makeGame();
  run(hud, game, 400);

  const bad = uploads.filter((u) => u.x < 0 || u.y < 0 || u.w < 1 || u.h < 1 ||
    u.x + u.w > W || u.y + u.h > H);
  ok(bad.length === 0, 'every uploaded rect is inside the texture',
    bad.length ? JSON.stringify(bad[0]) : `${uploads.length} uploads`);

  // Settled cockpit: only the sonar animates, plus the annunciator strip it
  // overlaps. Anything more means the dirty keys are not quantised properly.
  uploads.length = 0;
  const before = hud.ctx.calls;
  run(hud, game, 60);   // 1 s -> ~30 redraws at MAX_REDRAW_HZ
  const perRedraw = uploads.length / 30;
  ok(perRedraw <= 2.2, 'settled cockpit uploads at most the animated regions',
    `${perRedraw.toFixed(2)} regions per redraw, ${hud.ctx.calls - before} canvas calls/s`);

  const px = uploads.reduce((a, u) => a + u.w * u.h, 0) / 30;
  ok(px < 250000, 'settled upload volume stays well under a full frame',
    `${(px / 1000).toFixed(0)} kpx per redraw vs ${(W * H / 1000).toFixed(0)} kpx full-screen`);

  // Free swim with a static state must eventually upload nothing at all.
  const hud2 = await makeHud(W, H);
  const swim = makeGame({ player: { inVessel: false, oxygen: 90, oxygenCapacity: 90, health: 100 } });
  swim.player.depth = 20;
  swim.player.heading = 1.2;
  run(hud2, swim, 600);
  uploads.length = 0;
  run(hud2, swim, 60);
  ok(uploads.length === 0, 'a fully settled free-swim HUD uploads nothing',
    `${uploads.length} uploads in 1 s`);

  // ...and a change must wake it up again.
  swim.player.depth = 21.4;
  run(hud2, swim, 30);
  ok(uploads.length > 0, 'a state change re-dirties the region', `${uploads.length} uploads`);
}

// ---------------------------------------------------------------------------
// 8. Sonar contacts
// ---------------------------------------------------------------------------

section('Sonar');
{
  const hud = await makeHud();
  const game = makeGame();
  run(hud, game, 30);

  hud.addSonarContact({ id: 1, bearing: 0, distance: 0, size: 6, hostile: true });
  hud.addSonarContact({ id: 2, bearing: 6.28, distance: 1e6, size: 0.01, hostile: false });
  hud.addSonarContact({ id: 3, bearing: -99, distance: -50, size: NaN, hostile: true });
  hud.addSonarContact({ bearing: NaN, distance: NaN });
  hud.addSonarContact(null);
  for (let i = 0; i < 60; i++) hud.addSonarContact({ id: 100 + i, bearing: i * 0.1, distance: i * 4 });
  run(hud, game, 30);
  ok(violations(hud).length === 0, 'degenerate and overflowing contacts draw safely',
    violations(hud).slice(0, 3).join('; '));
  ok(hud.contacts.count <= 24, 'contact list is capped', `${hud.contacts.count} contacts`);

  let allFinite = true;
  for (let i = 0; i < hud.contacts.count; i++) {
    if (!Number.isFinite(hud.contacts.bearing[i]) || !Number.isFinite(hud.contacts.distance[i]) ||
        !Number.isFinite(hud.contacts.size[i])) allFinite = false;
  }
  ok(allFinite, 'stored contact fields are all finite');

  // Contacts age out.
  run(hud, game, 60 * 8);
  ok(hud.contacts.count === 0, 'contacts expire after their lifetime',
    `${hud.contacts.count} remaining`);
}

// ---------------------------------------------------------------------------
// 9. Mode switching
// ---------------------------------------------------------------------------

section('Mode switching');
{
  const hud = await makeHud();
  const game = makeGame();
  for (let i = 0; i < 8; i++) {
    game.player.inVessel = i % 2 === 0;
    run(hud, game, 20);
  }
  ok(violations(hud).length === 0, 'repeated cockpit/free-swim transitions are clean',
    violations(hud).slice(0, 3).join('; '));

  hud.visible = false;
  run(hud, game, 20);
  ok(hud.mode === 'none' && violations(hud).length === 0, 'hiding the HUD stops all drawing');
  hud.visible = true;
  run(hud, game, 20);
  ok(hud.mode !== 'none', 'the HUD comes back');

  hud.destroy();
  ok(hud.texture === null, 'destroy() releases the texture');
}

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? 'HUD verified.' : `${failures} FAILURE(S)`}  ` +
  `${checks - failures}/${checks} checks passed.\n`);
process.exit(failures ? 1 : 0);
