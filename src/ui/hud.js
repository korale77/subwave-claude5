/**
 * SUBWAVE heads-up displays.
 *
 * Two instrument suites share one implementation and one texture:
 *   - the COCKPIT HUD, projected on the windshield glass while piloting
 *     (ribbon compass, depth tape, attitude, speed, systems, sonar, annunciators)
 *   - the FREE-SWIM wrist unit, a single compact panel in the bottom-left
 *     corner with oxygen as the hero element, plus a few-pixel centre reticle
 *
 * WHY CANVAS2D RATHER THAN A WEBGPU VECTOR UI
 * -------------------------------------------
 * A signed-distance vector UI drawn in WGSL is the right answer for interfaces
 * that change every pixel every frame. This one does not. The cockpit HUD is
 * dominated by numerals, ticks and lamp legends that change at 2-15 Hz; between
 * changes it is a still image. Canvas2D lets us rasterise only the instruments
 * whose displayed value actually moved, into their own sub-rectangles, and
 * upload only those rectangles - typically 30-120 KB per redraw, capped at
 * MAX_REDRAW_HZ. A WebGPU UI pass would shade every one of the two million
 * output pixels every single frame whether or not a needle moved, and would
 * need a hand-written glyph rasteriser to do it.
 *
 * The second reason is compositing. One texture and one fullscreen draw means
 * the entire windshield treatment - canopy curvature, head parallax, edge
 * chromatic fringing, the reflection of the instrument glow in the glass -
 * lives in a single shader (render/passes/hud.js) and applies uniformly. That
 * treatment is the point of the cockpit, and it is much harder to keep coherent
 * across a thousand independently-transformed vector primitives.
 *
 * The cost we accept in exchange is that the HUD cannot animate continuously
 * for free. That is why every instrument damps to a quantised displayed value
 * (11.2.6), and why the only self-animating elements - the sonar sweep and the
 * alarm blink - fold their phase into the region signature, so they cost
 * exactly one small rectangle each and cost nothing at all when parked.
 *
 * TYPOGRAPHY is a procedural centreline stroke font (GLYPHS below): polylines
 * in a normalised em box, stroked at a runtime line width. No font files, no
 * glyph atlas, resolution independent, and the stroke weight is a per-frame
 * parameter - which is what lets the whole HUD thicken under alarm exactly as
 * the escalation ramp in DESIGN/11 specifies.
 */

import {
  UI_COLORS, HUD as HUD_LAYOUT, PLAYER, VESSEL, DEPTH_BANDS,
  depthBandIndex, pressureAt,
} from '../core/constants.js';
import {
  clamp, saturate, damp, wrapAngle, wrapAngle2Pi, radToDeg,
  smoothstep, remapClamped, headingLabel, headingFromDir, depthOf, TAU, PI,
} from '../core/math.js';
import { settings } from '../core/settings.js';
import { events, EVENTS } from '../core/events.js';
import { createTexture, TextureUsage } from '../core/resources.js';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Redraw ceiling. Instruments damp at HUD.NEEDLE_DAMPING = 9.5/s, whose 99%
 * settling time is ~0.48 s; sampling that at 30 Hz is well past the point where
 * a viewer can tell, and it halves the rasterisation and upload cost.
 */
const MAX_REDRAW_HZ = 30;

/**
 * Showcase attribution credit geometry, all as fractions of screen HEIGHT so
 * the label keeps its corner and its size on any aspect ratio (the wrist
 * unit's rule, HUD.WRIST in core/constants.js).
 *
 * The margins are the wrist unit's, so the credit sits the same distance off
 * the bottom-right corner as the wrist sits off the bottom-left. CREDIT_CAP is
 * about 55 px at 1080p: this is a title-sized credit, meant to be legible in a
 * downscaled or phone-sized replay of the capture rather than a discreet
 * watermark, at the author's instruction.
 *
 * CREDIT_MARGIN_Y IS NOT THE WRIST'S 0.040, AND THE DIFFERENCE IS MEASURED.
 * At this cap the label is 0.53*H wide, and only 0.415*H of the bottom-right
 * corner is clear of the annunciator strip at 16:9 - so a true corner
 * placement OVERLAPS the strip, which makes the two regions NEIGHBOURS.
 * Overlap is not a correctness bug (_computeNeighbours repaints both) but it
 * is a permanent cost: the credit is rasterised and uploaded on every
 * annunciator blink for the whole session, to draw nothing, because its own
 * key rests at ''. Measured at the true corner: 2.80 regions per redraw in the
 * settled cockpit against tools/test-hud.mjs's budget of 2.2, i.e. it fails
 * the gate. Lifting the box to clear the strip at its WIDEST (hudScale 1.5,
 * top edge 0.9094*H) costs a few percent of screen height and returns the
 * settled cockpit to its old numbers. Shrinking the label instead would have
 * cost the size that was actually asked for.
 *
 * CREDIT_MAX_CHARS only sizes the BOX (see the placement in _layout); the text
 * is right-aligned inside it and _drawDemoCredit SHRINKS a string that would
 * not fit, so this is an upper bound for layout stability, not a limit - keep
 * it near the real length or the slack is paid in rasterised pixels, and in
 * width that has to stay clear of the sonar disc at hudScale 1.5.
 */
const CREDIT_CAP = 0.051;
/**
 * Stroke weights as a FRACTION OF CAP HEIGHT - see the note in
 * _drawDemoCredit for why these are not the `k * pixelScale` form the
 * instruments use.
 *
 * The glyphs are centreline polylines (GLYPHS), not closed outlines, so there
 * is no fill to turn on: weight IS the only boldness this font has, and a
 * "solid" letter is simply a thick enough stroke. 0.15 is about three times
 * the scene-title card's 4.7% of cap, which is what a corner credit needs to
 * survive video compression at half size.
 *
 * THE INK RIM IS A CONTOUR, NOT A SECOND LETTER. These two are close together
 * on purpose: at 0.10/0.20 the dark halo was as wide as the light core and the
 * letters read as HOLLOW OUTLINES rather than as solid strokes - legible, but
 * exactly the "too thin" complaint that prompted this. Keep INK within about
 * 0.05 of WEIGHT so the dark edge stays a rim.
 *
 * 0.15 is also near the ceiling this font has: rendered and looked at, 0.19
 * starts closing the 'A' apex and the 'B' bowls. Do not raise these without
 * rasterising the result - the counters go before the legibility does, so the
 * failure is invisible to every numeric check in tools/test-hud.mjs.
 */
const CREDIT_WEIGHT = 0.15;
const CREDIT_INK_WEIGHT = 0.20;
const CREDIT_MARGIN_X = 0.030;
const CREDIT_MARGIN_Y = 0.100;
const CREDIT_MAX_CHARS = 13;

/** Reference display luminance the HUD gain is normalised against, cd/m2. */
const HUD_REFERENCE_NITS = 120;

/**
 * Scene luminance HUD_REFERENCE_NITS is calibrated against, cd/m2: a bright
 * overcast day at the surface, which is the condition the instrument spends
 * most of its life in and the one it must look exactly right in.
 */
const REFERENCE_SCENE_NITS = 160;

/**
 * Brightness exponent for the adaptation, and the limits of the gain it drives.
 *
 * 0.35 is roughly the Stevens brightness exponent, which is what makes the
 * panel read as EQUALLY bright to the eye across the nine stops between noon at
 * the surface and 700 m down. Tracking scene luminance any harder than this
 * makes the instrument invisible at noon; tracking it any softer makes it the
 * only thing the eye can see in the dark.
 *
 * The ceiling is exactly 1.0 and cannot usefully be raised: the instrument
 * colours are authored as sRGB hex, so any gain above unity clips the green and
 * blue of UI_COLORS.instrument first and washes the whole palette toward white
 * - which destroys the amber-then-red oxygen ramp, the one thing the colours
 * are load-bearing for. A brighter HUD than this needs brighter SOURCE colours.
 */
const HUD_ADAPT_EXPONENT = 0.35;
const HUD_GAIN_MIN = 0.45;
const HUD_GAIN_MAX = 1.00;

/** Sonar head rotation period, seconds (DESIGN/04 4.1: 360 deg / 3.20 s). */
const SONAR_SWEEP_PERIOD = 3.2;

/** Seconds a sonar contact stays on the display after its last update. */
const SONAR_CONTACT_LIFETIME = 6.0;
const SONAR_MAX_CONTACTS = 24;

/** HUD cold-boot sequence length, seconds (DESIGN/11 11.2.5). */
const BOOT_DURATION = 1.4;

/** Compass ribbon field of view, degrees across the full ribbon width. */
const COMPASS_SPAN_DEG = 90;

/** Depth tape window, metres from top to bottom of the tape. */
const DEPTH_TAPE_SPAN = 120;

/** Speed tape window, metres per second from top to bottom. */
const SPEED_TAPE_SPAN = 40;

/** Attitude ladder scale: screen radii per degree of pitch. */
const PITCH_DEG_PER_RADIUS = 30;

// ---------------------------------------------------------------------------
// Escalation ramp (DESIGN/11 11.2.1)
// ---------------------------------------------------------------------------

const LEVEL_NOMINAL = 0;
const LEVEL_ADVISORY = 1;
const LEVEL_CAUTION = 2;
const LEVEL_WARNING = 3;
const LEVEL_CRITICAL = 4;

const LEVEL_STROKE = [1.00, 1.00, 1.15, 1.30, 1.50];
const LEVEL_BLINK_HZ = [0, 0, 0, 1.20, 2.40];
const LEVEL_DUTY = [1, 1, 1, 0.60, 0.50];

/**
 * Systems-stack rows: label, the damped value they read, and the four
 * escalation thresholds (advisory, caution, warning, critical). One table so
 * the dirty-tracking signature and the draw can never disagree about which
 * level a row is at, which is what decides whether the row blinks at all.
 */
const SYSTEM_ROWS = [
  { label: 'PWR', field: 'power', t: [0.35, 0.20, 0.10, 0.05] },
  { label: 'O2', field: 'oxygen', t: [0.40, 0.20, 0.10, 0.04] },
  { label: 'HUL', field: 'hull', t: [0.80, 0.55, 0.35, 0.18] },
];

/** Annunciator lamp legends, in panel order. Levels are computed per frame. */
const ANNUNCIATOR_LABELS = ['DEPTH', 'PWR', 'HULL', 'O2', 'HEAT', 'LEAK'];

/**
 * Raised-cosine blink, never a hard square wave: a square blink violates the
 * photosensitivity limiter and reads as a strobe rather than an alarm. Alpha
 * bottoms out at 0.35, never 0 - an instrument that vanishes reads as a FAILED
 * instrument, which is a different message entirely.
 */
function blinkAlpha(level, t) {
  const hz = LEVEL_BLINK_HZ[level];
  if (hz <= 0) return 1;
  const duty = LEVEL_DUTY[level];
  const phase = t * hz - Math.floor(t * hz);
  const k = 0.5 - 0.5 * Math.cos(TAU * saturate(phase / duty));
  return 0.35 + 0.65 * k;
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const C = {
  ink: UI_COLORS.ink,
  cyan: UI_COLORS.instrument,
  cyanDim: UI_COLORS.instrumentDim,
  amber: UI_COLORS.amber,
  warn: UI_COLORS.warn,
  good: UI_COLORS.good,
  text: UI_COLORS.text,
  textDim: UI_COLORS.textDim,
};

const LEVEL_COLOR = [C.cyan, C.amber, C.amber, C.warn, C.warn];

/**
 * Oxygen ramp colours for the wrist unit. Red is held back for
 * PLAYER.OXYGEN_CRITICAL alone, so a diver can tell "surface soon" from "you
 * are about to drown" by hue, before reading a single digit. The cockpit ramp
 * cannot do this - it drives six unrelated systems at once and needs red the
 * moment any of them is out of limits.
 */
const OXYGEN_COLOR = [C.cyan, C.cyan, C.amber, C.amber, C.warn];

const _rgbaCache = new Map();

/** '#rrggbb' + alpha -> a cached 'rgba(...)' string. */
function rgba(hex, a) {
  const alpha = a >= 1 ? 1 : a <= 0 ? 0 : Math.round(a * 1000) / 1000;
  const key = hex + '|' + alpha;
  let s = _rgbaCache.get(key);
  if (s === undefined) {
    const n = parseInt(hex.slice(1), 16);
    s = `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
    _rgbaCache.set(key, s);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Procedural centreline stroke font
// ---------------------------------------------------------------------------
//
// Each glyph is a list of open polylines in a unit box: x in [0,1] across the
// glyph width, y in [0,1] from baseline to cap height. Curves are chamfered
// rather than arced, which is both cheaper and the correct look - this is a
// plotter/CRT instrument face, not a book face. Zero is slashed so it can never
// be confused with O on a depth readout.

const FONT_CAP = 0.72;       // cap height, em
const FONT_ADVANCE = 0.56;   // monospace advance, em
const FONT_WIDTH = 0.44;     // glyph box width, em
const FONT_TRACKING = 0.03;  // extra letterspacing, em

/** Degree sign. Declared once so no source file needs a literal in a string. */
export const DEG = '°';

const GLYPHS = {
  '0': [[0, 0.18, 0.18, 0, 0.82, 0, 1, 0.18, 1, 0.82, 0.82, 1, 0.18, 1, 0, 0.82, 0, 0.18],
    [0.14, 0.26, 0.86, 0.74]],
  '1': [[0.12, 0.78, 0.5, 1, 0.5, 0], [0.16, 0, 0.84, 0]],
  '2': [[0, 0.8, 0.2, 1, 0.8, 1, 1, 0.8, 1, 0.62, 0, 0.16, 0, 0, 1, 0]],
  '3': [[0, 1, 1, 1, 0.55, 0.56, 0.8, 0.56, 1, 0.38, 1, 0.18, 0.82, 0, 0.18, 0, 0, 0.18]],
  '4': [[0.75, 0, 0.75, 1, 0.05, 0.28, 1, 0.28]],
  '5': [[1, 1, 0, 1, 0, 0.58, 0.78, 0.58, 1, 0.4, 1, 0.18, 0.8, 0, 0.2, 0, 0, 0.16]],
  '6': [[0.95, 1, 0.22, 1, 0, 0.78, 0, 0.18, 0.18, 0, 0.82, 0, 1, 0.18, 1, 0.4,
    0.82, 0.58, 0.12, 0.58, 0, 0.44]],
  '7': [[0, 1, 1, 1, 0.3, 0]],
  '8': [[0.18, 0.58, 0, 0.74, 0, 0.86, 0.18, 1, 0.82, 1, 1, 0.86, 1, 0.74, 0.82, 0.58,
    1, 0.4, 1, 0.18, 0.82, 0, 0.18, 0, 0, 0.18, 0, 0.4, 0.18, 0.58]],
  '9': [[0.05, 0, 0.78, 0, 1, 0.22, 1, 0.82, 0.82, 1, 0.18, 1, 0, 0.82, 0, 0.6,
    0.18, 0.42, 0.88, 0.42, 1, 0.56]],
  'A': [[0, 0, 0.5, 1, 1, 0], [0.17, 0.34, 0.83, 0.34]],
  'B': [[0, 0, 0, 1, 0.72, 1, 1, 0.78, 0.72, 0.55, 0, 0.55],
    [0.72, 0.55, 1, 0.32, 0.72, 0, 0, 0]],
  'C': [[1, 0.82, 0.8, 1, 0.2, 1, 0, 0.8, 0, 0.2, 0.2, 0, 0.8, 0, 1, 0.18]],
  'D': [[0, 0, 0, 1, 0.7, 1, 1, 0.74, 1, 0.26, 0.7, 0, 0, 0]],
  'E': [[1, 1, 0, 1, 0, 0, 1, 0], [0, 0.52, 0.78, 0.52]],
  'F': [[1, 1, 0, 1, 0, 0], [0, 0.52, 0.76, 0.52]],
  'G': [[1, 0.82, 0.8, 1, 0.2, 1, 0, 0.8, 0, 0.2, 0.2, 0, 0.8, 0, 1, 0.2, 1, 0.45, 0.55, 0.45]],
  'H': [[0, 0, 0, 1], [1, 0, 1, 1], [0, 0.52, 1, 0.52]],
  'I': [[0.18, 1, 0.82, 1], [0.5, 1, 0.5, 0], [0.18, 0, 0.82, 0]],
  'J': [[0.75, 1, 0.75, 0.2, 0.55, 0, 0.2, 0, 0, 0.2]],
  'K': [[0, 0, 0, 1], [0.95, 1, 0.05, 0.42], [0.33, 0.6, 1, 0]],
  'L': [[0, 1, 0, 0, 1, 0]],
  'M': [[0, 0, 0, 1, 0.5, 0.45, 1, 1, 1, 0]],
  'N': [[0, 0, 0, 1, 1, 0, 1, 1]],
  'O': [[0, 0.2, 0.2, 0, 0.8, 0, 1, 0.2, 1, 0.8, 0.8, 1, 0.2, 1, 0, 0.8, 0, 0.2]],
  'P': [[0, 0, 0, 1, 0.75, 1, 1, 0.8, 0.75, 0.55, 0, 0.55]],
  'Q': [[0, 0.2, 0.2, 0, 0.8, 0, 1, 0.2, 1, 0.8, 0.8, 1, 0.2, 1, 0, 0.8, 0, 0.2],
    [0.62, 0.26, 1.02, -0.06]],
  'R': [[0, 0, 0, 1, 0.75, 1, 1, 0.8, 0.75, 0.55, 0, 0.55], [0.5, 0.55, 1, 0]],
  'S': [[1, 0.85, 0.8, 1, 0.2, 1, 0, 0.82, 0, 0.68, 0.2, 0.55, 0.8, 0.55, 1, 0.38,
    1, 0.18, 0.8, 0, 0.2, 0, 0, 0.15]],
  'T': [[0, 1, 1, 1], [0.5, 1, 0.5, 0]],
  'U': [[0, 1, 0, 0.2, 0.2, 0, 0.8, 0, 1, 0.2, 1, 1]],
  'V': [[0, 1, 0.5, 0, 1, 1]],
  'W': [[0, 1, 0.22, 0, 0.5, 0.62, 0.78, 0, 1, 1]],
  'X': [[0, 0, 1, 1], [0, 1, 1, 0]],
  'Y': [[0, 1, 0.5, 0.5, 1, 1], [0.5, 0.5, 0.5, 0]],
  'Z': [[0, 1, 1, 1, 0, 0, 1, 0]],
  ' ': [],
  '.': [[0.5, 0.02, 0.5, 0]],
  ',': [[0.55, 0.06, 0.35, -0.14]],
  '-': [[0.12, 0.5, 0.88, 0.5]],
  '+': [[0.5, 0.16, 0.5, 0.84], [0.12, 0.5, 0.88, 0.5]],
  '/': [[0.05, 0, 0.95, 1]],
  ':': [[0.5, 0.66, 0.5, 0.64], [0.5, 0.22, 0.5, 0.2]],
  '%': [[0.05, 0, 0.95, 1],
    [0.05, 0.78, 0.22, 0.62, 0.05, 0.46, 0.05, 0.78],
    [0.95, 0.54, 0.78, 0.38, 0.95, 0.22, 0.95, 0.54]],
  '_': [[0, 0, 1, 0]],
  '<': [[0.8, 1, 0.2, 0.5, 0.8, 0]],
  '>': [[0.2, 1, 0.8, 0.5, 0.2, 0]],
  '(': [[0.7, 1, 0.3, 0.7, 0.3, 0.3, 0.7, 0]],
  ')': [[0.3, 1, 0.7, 0.7, 0.7, 0.3, 0.3, 0]],
  [DEG]: [[0.28, 0.78, 0.5, 0.9, 0.72, 0.78, 0.72, 0.62, 0.5, 0.5, 0.28, 0.62, 0.28, 0.78]],
};

/** Horizontal advance per character, in pixels, for a given cap height. */
export function textAdvance(cap) {
  return cap * (FONT_ADVANCE + FONT_TRACKING) / FONT_CAP;
}

/** Ink width of a string in pixels (excludes the trailing side bearing). */
export function textWidth(text, cap) {
  if (!text.length) return 0;
  const adv = textAdvance(cap);
  return text.length * adv - (adv - cap * FONT_WIDTH / FONT_CAP);
}

/**
 * Stroke a string. The caller owns strokeStyle, lineWidth, lineCap and lineJoin;
 * every glyph in the string is accumulated into ONE path and stroked once,
 * because a per-glyph stroke() is where a Canvas2D text renderer goes to die.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text          only characters present in GLYPHS are drawn
 * @param {number} x             anchor, meaning set by `align`
 * @param {number} y             anchor, meaning set by `baseline`
 * @param {number} cap           cap height in device pixels
 * @param {{align?: 'left'|'center'|'right', baseline?: 'bottom'|'middle'|'top'}} [opts]
 */
export function drawText(ctx, text, x, y, cap, opts) {
  const align = (opts && opts.align) || 'left';
  const baseline = (opts && opts.baseline) || 'bottom';
  const adv = textAdvance(cap);
  const gw = cap * FONT_WIDTH / FONT_CAP;
  const total = text.length ? text.length * adv - (adv - gw) : 0;
  let px = align === 'center' ? x - total * 0.5 : align === 'right' ? x - total : x;
  const by = baseline === 'middle' ? y + cap * 0.5 : baseline === 'top' ? y + cap : y;

  ctx.beginPath();
  for (let i = 0; i < text.length; i++) {
    const g = GLYPHS[text[i]];
    if (g !== undefined) {
      for (let s = 0; s < g.length; s++) {
        const sub = g[s];
        ctx.moveTo(px + sub[0] * gw, by - sub[1] * cap);
        for (let k = 2; k < sub.length; k += 2) {
          ctx.lineTo(px + sub[k] * gw, by - sub[k + 1] * cap);
        }
      }
    }
    px += adv;
  }
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

/** Coerce anything to a finite number. The single gate that keeps NaN off the canvas. */
function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Zero-padded integer, e.g. pad(7, 3) -> '007'. Clamped to `digits` width. */
function pad(v, digits) {
  const n = Math.abs(Math.round(num(v, 0)));
  let s = String(Math.min(n, Math.pow(10, digits) - 1));
  while (s.length < digits) s = '0' + s;
  return s;
}

/**
 * Signed fixed-point with an explicit sign, e.g. '+04.2' / '-11.8'.
 *
 * The magnitude is rounded ONCE at full precision and then split. Rounding the
 * fractional part on its own loses the carry: 9.96 would render as '+09.9',
 * which is both wrong and non-monotonic against the neighbouring values. For
 * the same reason the saturation clamp is applied to the whole quantity, so an
 * over-range value reads '+99.9' rather than '+99.0'.
 */
function signed(v, intDigits, frac) {
  const x = num(v, 0);
  const s = x < 0 ? '-' : '+';
  const scale = Math.pow(10, frac);
  const n = Math.min(Math.round(Math.abs(x) * scale), Math.pow(10, intDigits + frac) - 1);
  const whole = Math.floor(n / scale);
  return s + pad(whole, intDigits) + (frac > 0 ? '.' + pad(n - whole * scale, frac) : '');
}

/** Exponential approach that can never produce NaN, whatever dt or input does. */
function approach(current, target, rate, dt) {
  const c = num(current, 0);
  const t = num(target, c);
  const r = Math.max(0, num(rate, 0));
  const d = clamp(num(dt, 0), 0, 0.25);
  const out = damp(c, t, r, d);
  return Number.isFinite(out) ? out : t;
}

/** Angular approach taking the SHORT way round, so 359 -> 001 never spins 358 deg. */
function approachAngle(current, target, rate, dt) {
  const c = num(current, 0);
  const t = num(target, c);
  const d = clamp(num(dt, 0), 0, 0.25);
  const k = 1 - Math.exp(-Math.max(0, num(rate, 0)) * d);
  const out = wrapAngle2Pi(c + wrapAngle(t - c) * k);
  return Number.isFinite(out) ? out : wrapAngle2Pi(t);
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

export class HUD {
  /**
   * @param {import('../render/renderer.js').Renderer} renderer
   */
  constructor(renderer) {
    this.renderer = renderer;

    /** @type {OffscreenCanvas|HTMLCanvasElement|null} */
    this.canvas = null;
    /** @type {CanvasRenderingContext2D|null} */
    this.ctx = null;
    /** @type {GPUTexture|null} */
    this.texture = null;
    /** @type {GPUTextureView|null} */
    this.view = null;

    this.width = 0;
    this.height = 0;
    /** Uniform pixel scale: 1.0 at 1080p, so every weight in DESIGN/11 holds. */
    this.pixelScale = 1;

    /** 'cockpit' | 'swim' | 'none'. Drives which region set is live. */
    this.mode = 'none';
    this.visible = true;
    /** Emissive gain from the HUD luminance adaptation (DESIGN/11 11.1.6). */
    this.gain = 1;
    /** 0..1 physiological stress, consumed by the post lens pass. */
    this.stress = 0;
    /** Seconds since the cockpit HUD powered up; drives the cold-boot reveal. */
    this.bootTime = BOOT_DURATION;

    this.time = 0;
    this._sinceRedraw = 1;
    this._layoutDirty = true;
    this._modeChanged = true;
    /**
     * Set when the canvas was cleared wholesale rather than region by region.
     * The texture is normally kept in sync by per-region copies, so a clear
     * that is not followed by a full copy leaves the OLD mode's pixels live in
     * the texture anywhere the new mode has no region - which is how the wrist
     * unit used to bleed through the middle of the cockpit panel.
     */
    this._fullUpload = true;

    /** @type {Array<object>} live regions for the current mode */
    this.regions = [];
    this._cockpitRegions = [];
    this._swimRegions = [];
    this._noneRegions = [];

    /**
     * Showcase scene title, written by demo/director.js every frame and by
     * nothing else. Drawn top-centre IN THE FRAME (this canvas is a GPU
     * texture) so the Shift+G recording sees it - a DOM caption would be
     * invisible to the capture stream, the same reason the demo fade moved
     * into the lens pass. Empty/0 outside the showcase, costing nothing:
     * the region's key is stable so it is never rasterised.
     */
    this.demoTitle = '';
    this.demoTitleAlpha = 0;

    /**
     * Showcase attribution credit, bottom-right, same ownership rule as
     * `demoTitle`: demo/director.js writes it and nothing else does. It is in
     * the CANVAS rather than in DOM for the one reason that matters - the
     * Shift+G recorder blits this canvas and only this canvas, so a DOM
     * credit would be legible on screen and absent from every mp4. The REC
     * dot is DOM precisely because it must NOT be recorded; this is the
     * opposite case.
     *
     * The stroke font has no lowercase (see GLYPHS), so the director
     * uppercases what it writes here rather than letting drawText silently
     * drop half the string.
     */
    this.demoCredit = '';
    this.demoCreditAlpha = 0;

    /** Regions whose rects overlap, so a redraw of one repaints the other. */
    this._neighbours = new Map();

    /** Raw sampled state, refreshed from the game every update. */
    this.state = {
      inVessel: false,
      cockpitView: true,
      heading: 0,
      pitch: 0,
      roll: 0,
      depth: 0,
      altitude: 0,
      verticalSpeed: 0,
      speed: 0,
      underwater: false,
      power: 1,
      oxygen: 1,
      oxygenSeconds: PLAYER.OXYGEN_TIERS[0],
      hull: 1,
      health: 1,
      ballast: VESSEL.BALLAST_NEUTRAL,
      depthRating: VESSEL.DEPTH_RATINGS[0],
      suitRating: PLAYER.SUIT_DEPTH_TIERS[0],
      depthHold: null,
      holdActive: false,
      lightsOn: false,
      silentRunning: false,
      sonarRange: 240,
      sonarActive: true,
      leak: 0,
      heat: 0,
    };

    /** Damped display values. Instruments never snap (DESIGN/11 11.2.6). */
    this.disp = {
      heading: 0,
      pitch: 0,
      roll: 0,
      depth: 0,
      verticalSpeed: 0,
      speed: 0,
      power: 1,
      oxygen: 1,
      hull: 1,
      health: 1,
      ballast: VESSEL.BALLAST_NEUTRAL,
      lHud: HUD_REFERENCE_NITS,
    };

    /** Live sonar contacts: SoA so the update loop never allocates. */
    this.contacts = {
      id: new Int32Array(SONAR_MAX_CONTACTS),
      bearing: new Float32Array(SONAR_MAX_CONTACTS),
      distance: new Float32Array(SONAR_MAX_CONTACTS),
      size: new Float32Array(SONAR_MAX_CONTACTS),
      hostile: new Uint8Array(SONAR_MAX_CONTACTS),
      age: new Float32Array(SONAR_MAX_CONTACTS),
      count: 0,
    };

    /** Annunciator levels, refilled in place so the panel never allocates. */
    this._annunLevels = new Int8Array(ANNUNCIATOR_LABELS.length);

    this._unsubs = [];
    this._prevDepth = 0;
    this._hasPrevDepth = false;
    this._destroyed = false;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async init() {
    this._buildSurface();
    this._defineRegions();
    this._subscribe();
    return this;
  }

  _subscribe() {
    const u = this._unsubs;
    u.push(events.on(EVENTS.VESSEL_ENTER, () => { this.bootTime = 0; }));
    u.push(events.on(EVENTS.VESSEL_SONAR_CONTACT, (c) => this.addSonarContact(c)));
    u.push(events.on(EVENTS.RESIZE, () => { this._layoutDirty = true; }));
    u.push(settings.onChange((key) => {
      if (key === 'hudScale' || key === 'hudOpacity') this._layoutDirty = true;
    }));
  }

  /** (Re)create the offscreen canvas and its GPU texture at output resolution. */
  _buildSurface() {
    const gpu = this.renderer.gpu;
    const w = Math.max(2, gpu.width | 0);
    const h = Math.max(2, gpu.height | 0);
    if (this.canvas && this.width === w && this.height === h) return false;

    this.width = w;
    this.height = h;
    // 1080p is the reference height every weight in DESIGN/11.2.2 is quoted at.
    this.pixelScale = h / 1080;

    this.canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
    this.ctx = this.canvas.getContext('2d', { alpha: true, willReadFrequently: false });
    if (this.ctx) {
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.ctx.imageSmoothingEnabled = false;
    }

    const device = this.renderer.gpu.device;
    if (device) {
      this.texture?.destroy();
      // RENDER_ATTACHMENT is not optional: copyExternalImageToTexture requires
      // it on the destination even though we never render into this texture.
      this.texture = createTexture(device, {
        label: 'hud',
        width: w, height: h,
        format: 'rgba8unorm',
        usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST | TextureUsage.RENDER_ATTACHMENT,
      });
      this.view = this.texture.createView({ label: 'hud.view' });
    }
    return true;
  }

  destroy() {
    this._destroyed = true;
    for (const fn of this._unsubs) {
      try { fn(); } catch (e) { console.error(e); }
    }
    this._unsubs.length = 0;
    this.texture?.destroy();
    this.texture = null;
    this.view = null;
  }

  // -------------------------------------------------------------------------
  // Sonar contacts
  // -------------------------------------------------------------------------

  /**
   * Record or refresh a sonar contact.
   * @param {{id?: number, bearing: number, distance: number, size?: number, hostile?: boolean}} c
   *   bearing is a WORLD heading in radians (0 = north), not a relative bearing.
   */
  addSonarContact(c) {
    if (!c) return;
    const k = this.contacts;
    const id = num(c.id, -1);
    let slot = -1;
    for (let i = 0; i < k.count; i++) {
      if (id >= 0 && k.id[i] === id) { slot = i; break; }
    }
    if (slot < 0) {
      if (k.count < SONAR_MAX_CONTACTS) {
        slot = k.count++;
      } else {
        // Evict the stalest contact rather than dropping the new one: a fresh
        // return is always more useful than a six-second-old one.
        let oldest = 0;
        for (let i = 1; i < k.count; i++) if (k.age[i] > k.age[oldest]) oldest = i;
        slot = oldest;
      }
    }
    k.id[slot] = id;
    k.bearing[slot] = wrapAngle2Pi(num(c.bearing, 0));
    k.distance[slot] = Math.max(0, num(c.distance, 0));
    k.size[slot] = clamp(num(c.size, 1), 0.2, 6);
    k.hostile[slot] = c.hostile ? 1 : 0;
    k.age[slot] = 0;
  }

  _ageContacts(dt) {
    const k = this.contacts;
    for (let i = k.count - 1; i >= 0; i--) {
      k.age[i] += dt;
      if (k.age[i] > SONAR_CONTACT_LIFETIME) {
        const last = --k.count;
        if (i !== last) {
          k.id[i] = k.id[last]; k.bearing[i] = k.bearing[last];
          k.distance[i] = k.distance[last]; k.size[i] = k.size[last];
          k.hostile[i] = k.hostile[last]; k.age[i] = k.age[last];
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------

  /**
   * Sample the game, advance every damped instrument, and repaint whichever
   * regions actually changed.
   *
   * @param {number} dt seconds (unscaled real time; UI motion ignores pause)
   * @param {object} game the Game instance
   */
  update(dt, game) {
    if (this._destroyed || !this.ctx) return;
    // A hitch must not teleport an instrument (DESIGN/11 11.2.5).
    const step = clamp(num(dt, 0), 0, 1 / 30);
    this.time += step;

    if (this._buildSurface()) this._layoutDirty = true;

    this._sampleState(game);
    this._advance(step);
    this._ageContacts(step);
    this._updateLuminance(step);

    // The windshield HUD is conformal glass: it only exists as seen from
    // INSIDE the canopy. In chase view the canopy is on screen, not around
    // the eye, so a piloted hull viewed externally draws no HUD at all (and
    // not the swim HUD either - there is no diver in the water).
    const mode = !this.visible ? 'none'
      : this.state.inVessel ? (this.state.cockpitView ? 'cockpit' : 'none')
      : 'swim';
    if (mode !== this.mode) {
      this.mode = mode;
      this._modeChanged = true;
      if (mode === 'cockpit') this.bootTime = 0;
    }
    if (this.bootTime < BOOT_DURATION) this.bootTime += step;

    if (this._layoutDirty) {
      this._layout();
      this._layoutDirty = false;
      this._modeChanged = true;
    }
    if (this._modeChanged) {
      this.regions = this.mode === 'cockpit' ? this._cockpitRegions
        : this.mode === 'swim' ? this._swimRegions : this._noneRegions;
      this.ctx.clearRect(0, 0, this.width, this.height);
      for (const r of this.regions) { r.dirty = true; r.key = ''; }
      this._modeChanged = false;
      this._fullUpload = true;
      this._sinceRedraw = 1;
    }

    this._sinceRedraw += step;
    if (this._sinceRedraw < 1 / MAX_REDRAW_HZ) return;
    this._sinceRedraw = 0;
    this._repaint();
  }

  /**
   * Pull state out of the game defensively. Every field is optional and every
   * read is coerced to a finite number, because the HUD must keep drawing
   * something sane while the systems around it are still being built.
   */
  _sampleState(game) {
    const s = this.state;
    const player = game && game.player;
    const vessel = game && game.vessel;
    const cam = this.renderer && this.renderer.camera;

    s.inVessel = !!(player && player.inVessel);
    // Default TRUE when the vessel has no cameraMode (offline tests build a
    // bare state): absence of a chase camera means the eye is in the cockpit.
    s.cockpitView = !vessel || vessel.cameraMode == null || vessel.cameraMode === 'cockpit';

    const src = s.inVessel ? vessel : player;
    const pos = (src && src.position) || (cam && cam.position) || null;
    s.depth = num(src && src.depth, pos ? depthOf(num(pos[1], 0)) : 0);
    s.altitude = num(src && src.altitude, pos ? Math.max(0, num(pos[1], 0)) : 0);
    s.underwater = src && typeof src.underwater === 'boolean'
      ? src.underwater
      : s.depth > 0;
    // The eye is inside a carved cave void (main.js asks the volumetric field
    // once per frame). Drawn as a tag on the depth tape: depth alone stops
    // meaning "distance to open surface" under a rock roof.
    s.inCave = !!(game && game.inCave);

    if (src && typeof src.heading === 'number' && Number.isFinite(src.heading)) {
      s.heading = wrapAngle2Pi(src.heading);
    } else if (cam) {
      s.heading = headingFromDir(cam.forward);
    }
    s.pitch = num(src && src.pitch, cam ? Math.asin(clamp(num(cam.forward[1], 0), -1, 1)) : 0);
    // Roll from the CAMERA, not from the hull.
    //
    // A HUD drawn on the canopy glass has to be conformal with what is visible
    // THROUGH the glass, so its horizon must agree with the camera's. In the
    // Kestrel the camera now follows the pilot's aim while the hull lags behind
    // it, so reading the hull would draw a horizon line that disagrees with the
    // real one in the window by the whole attitude error.
    //
    // This channel was previously hard-zero - it read `src.roll`, and no vessel or
    // player object has ever exposed a `roll` field, so the artificial horizon's
    // roll axis did not work at all.
    s.roll = num(src && src.roll,
      cam && cam.right && cam.up
        ? Math.atan2(num(cam.right[1], 0), Math.max(num(cam.up[1], 1e-6), 1e-6))
        : 0);
    s.speed = num(src && src.speed, num(cam && cam.speed, 0));
    s.verticalSpeed = num(src && src.verticalSpeed, NaN);

    if (vessel) {
      s.power = saturate(num(vessel.powerFraction,
        num(vessel.power, 1) / Math.max(1e-3, num(vessel.powerCapacity, 1))));
      s.hull = saturate(num(vessel.hullFraction, num(vessel.hull, VESSEL.MAX_HULL) / VESSEL.MAX_HULL));
      s.ballast = saturate(num(vessel.ballast, VESSEL.BALLAST_NEUTRAL));
      s.depthRating = num(vessel.depthRating, VESSEL.DEPTH_RATINGS[0]);
      s.depthHold = typeof vessel.depthHold === 'number' && Number.isFinite(vessel.depthHold)
        ? vessel.depthHold : null;
      s.holdActive = vessel.holdY != null;
      s.lightsOn = !!vessel.lightsOn;
      s.silentRunning = !!vessel.silentRunning;
      s.sonarRange = num(vessel.sonarRange, s.sonarRange);
      s.sonarActive = vessel.sonarActive !== false;
      s.leak = saturate(num(vessel.leak, 0));
      s.heat = saturate(num(vessel.heat, 0));
    }

    if (player) {
      const tier = clamp(num(player.oxygenTier, 0) | 0, 0, PLAYER.OXYGEN_TIERS.length - 1);
      const capacity = num(player.oxygenCapacity, PLAYER.OXYGEN_TIERS[tier]);
      s.oxygenSeconds = Math.max(0, num(player.oxygen, capacity));
      s.oxygen = saturate(s.oxygenSeconds / Math.max(1, capacity));
      s.health = saturate(num(player.health, PLAYER.MAX_HEALTH) / PLAYER.MAX_HEALTH);
      // The suit rating, not the vessel's, is what turns a depth into a
      // decision while swimming, so the wrist depth readout escalates against it.
      s.suitRating = Math.max(1, num(player.suitDepthRating, PLAYER.SUIT_DEPTH_TIERS[0]));
    }
    // In the cockpit the tank reads the cabin reserve, not the suit bottle.
    if (s.inVessel && vessel && typeof vessel.cabinOxygen === 'number') {
      s.oxygenSeconds = Math.max(0, num(vessel.cabinOxygen, VESSEL.CABIN_OXYGEN));
      s.oxygen = saturate(s.oxygenSeconds / VESSEL.CABIN_OXYGEN);
    }
  }

  /** Advance every damped display value. */
  _advance(dt) {
    const s = this.state;
    const d = this.disp;
    const needle = HUD_LAYOUT.NEEDLE_DAMPING;
    const tape = HUD_LAYOUT.TAPE_DAMPING;

    d.heading = approachAngle(d.heading, s.heading, needle, dt);
    d.pitch = approach(d.pitch, s.pitch, needle, dt);
    d.roll = approach(d.roll, s.roll, needle, dt);
    d.depth = approach(d.depth, s.depth, tape, dt);
    d.speed = approach(d.speed, s.speed, tape, dt);

    // Vertical speed: use the simulation's value when it exists, otherwise
    // differentiate depth. Depth is positive DOWN, so a shrinking depth is a
    // positive (upward) vertical speed.
    let vs = s.verticalSpeed;
    if (!Number.isFinite(vs)) {
      vs = this._hasPrevDepth && dt > 1e-4 ? (this._prevDepth - s.depth) / dt : 0;
    }
    this._prevDepth = s.depth;
    this._hasPrevDepth = true;
    d.verticalSpeed = approach(d.verticalSpeed, clamp(vs, -60, 60), 4.5, dt);

    // Asymmetric springs: damage must read instantly, recovery must read as
    // recovery. Fast down, slow up (DESIGN/11 11.2.6).
    d.power = approach(d.power, s.power, s.power < d.power ? 14 : 3.2, dt);
    d.oxygen = approach(d.oxygen, s.oxygen, s.oxygen < d.oxygen ? 14 : 3.2, dt);
    d.hull = approach(d.hull, s.hull, s.hull < d.hull ? 22 : 1.6, dt);
    d.health = approach(d.health, s.health, s.health < d.health ? 22 : 1.6, dt);
    d.ballast = approach(d.ballast, s.ballast, needle, dt);

    // Stress: what the post chain uses to tint the world when the body panics.
    const o2Stress = 1 - smoothstep(PLAYER.OXYGEN_CRITICAL, PLAYER.OXYGEN_WARN * 2, s.oxygenSeconds);
    const hullStress = 1 - smoothstep(0.15, 0.5, d.hull);
    const overdepth = remapClamped(s.depth, s.depthRating, s.depthRating * 1.2, 0, 1);
    this.stress = saturate(s.inVessel ? Math.max(hullStress, overdepth) : o2Stress);
    const lens = this.renderer && this.renderer.lens;
    if (lens) lens.stress = this.stress;
  }

  /**
   * HUD emissive luminance adaptation (DESIGN/11 11.1.6).
   *
   * The instruments are physical light sources in a dark cabin. Their luminance
   * tracks the scene's so they never bloom out at noon, and so that at 400 m
   * they become the brightest thing in the cockpit - which is the single
   * strongest mood beat of the deep and is not optional.
   */
  _updateLuminance(dt) {
    const exposure = num(this.renderer && this.renderer.exposure, 1);
    // renderer.exposure is a linear multiplier; invert it to a scene EV, then
    // to an approximate scene luminance with the standard K = 12.5 calibration.
    const sceneEV = -Math.log2(clamp(exposure, 1e-6, 1e6));
    const lScene = clamp(Math.pow(2, sceneEV) * 12.5, 1e-4, 1e6);
    // Normalised against the reference scene FIRST, then compressed. Raising an
    // absolute luminance in cd/m2 to a fractional power is dimensionally
    // meaningless and pins the result against one clamp or the other in every
    // condition the game actually has - which is exactly what it used to do,
    // leaving the whole HUD drawn at 5% of its colour in broad daylight.
    const lTarget = clamp(
      HUD_REFERENCE_NITS * Math.pow(lScene / REFERENCE_SCENE_NITS, HUD_ADAPT_EXPONENT),
      HUD_REFERENCE_NITS * HUD_GAIN_MIN, HUD_REFERENCE_NITS * HUD_GAIN_MAX);
    // 1.8 s time constant, frame-rate independent.
    this.disp.lHud += (lTarget - this.disp.lHud) * (1 - Math.exp(-dt / 1.8));
    if (!Number.isFinite(this.disp.lHud)) this.disp.lHud = HUD_REFERENCE_NITS;
    this.gain = clamp(this.disp.lHud / HUD_REFERENCE_NITS, HUD_GAIN_MIN, HUD_GAIN_MAX)
      * clamp(num(settings.get('hudOpacity'), 1), 0.3, 1);
  }

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  _defineRegions() {
    this._cockpitRegions = [
      { id: 'compass', draw: (c, r) => this._drawCompass(c, r), key: '', dirty: true },
      { id: 'depth', draw: (c, r) => this._drawDepthTape(c, r), key: '', dirty: true },
      { id: 'speed', draw: (c, r) => this._drawSpeedTape(c, r), key: '', dirty: true },
      { id: 'attitude', draw: (c, r) => this._drawAttitude(c, r), key: '', dirty: true },
      { id: 'systems', draw: (c, r) => this._drawSystems(c, r), key: '', dirty: true },
      { id: 'sonar', draw: (c, r) => this._drawSonar(c, r), key: '', dirty: true },
      { id: 'annunciators', draw: (c, r) => this._drawAnnunciators(c, r), key: '', dirty: true },
    ];
    this._swimRegions = [
      { id: 'wrist', draw: (c, r) => this._drawWrist(c, r), key: '', dirty: true },
      { id: 'reticle', draw: (c, r) => this._drawReticle(c, r), key: '', dirty: true },
    ];
    // The showcase scene title lives in EVERY mode, including 'none': the
    // demo's chase-view segments draw no instruments, but the title is the
    // scene card and must still be in the frame there.
    this._titleRegion = { id: 'demoTitle', draw: (c, r) => this._drawDemoTitle(c, r), key: '', dirty: true };
    this._cockpitRegions.push(this._titleRegion);
    this._swimRegions.push(this._titleRegion);
    // The attribution credit rides in the same three lists for the same
    // reason: it is presentation, not instrumentation, and it must be in the
    // frame in whatever mode the opening seconds happen to be in.
    this._creditRegion = { id: 'demoCredit', draw: (c, r) => this._drawDemoCredit(c, r), key: '', dirty: true };
    this._cockpitRegions.push(this._creditRegion);
    this._swimRegions.push(this._creditRegion);
    this._noneRegions = [this._titleRegion, this._creditRegion];
  }

  _layout() {
    const W = this.width;
    const H = this.height;
    const s = clamp(num(settings.get('hudScale'), 1), 0.75, 1.5);
    const L = HUD_LAYOUT;

    const place = (region, cx, cy, w, h) => {
      const x = Math.max(0, Math.round(cx - w * 0.5));
      const y = Math.max(0, Math.round(cy - h * 0.5));
      region.x = x;
      region.y = y;
      region.w = Math.max(1, Math.min(Math.round(w), W - x));
      region.h = Math.max(1, Math.min(Math.round(h), H - y));
    };

    const byId = (list, id) => list.find((r) => r.id === id);
    const cr = this._cockpitRegions;

    // The ribbon plus the heading readout box that hangs under it. The region
    // is 3.6 ribbon-heights tall and the ribbon sits 1.28 of them down from its
    // top, so this offset puts the RIBBON, not the region, on COMPASS.y.
    place(byId(cr, 'compass'), L.COMPASS.x * W, L.COMPASS.y * H + L.COMPASS.height * H * s * 0.52,
      L.COMPASS.width * W * s, L.COMPASS.height * H * s * 3.6);

    // Tape columns carry the tape, its labels and the vertical-speed gauge.
    place(byId(cr, 'depth'), L.DEPTH_TAPE.x * W - L.DEPTH_TAPE.width * W * s * 0.6,
      L.DEPTH_TAPE.y * H, L.DEPTH_TAPE.width * W * s * 2.4, L.DEPTH_TAPE.height * H * s);
    const ar = L.ATTITUDE.radius * H * s;
    place(byId(cr, 'attitude'), L.ATTITUDE.x * W, L.ATTITUDE.y * H, ar * 2.7, ar * 2.7);

    // Left column: the speed tape with the systems stack directly beneath it.
    // The two are solved together against the space above the annunciator strip
    // and shrunk proportionally if they do not fit, because at HUD scale 1.5
    // they otherwise overlap it - and an instrument drawn over another
    // instrument is worse than a slightly smaller one.
    //
    // The budget is speedH/2 + sysH and NOT speedH + sysH: the speed tape is
    // CENTRED on SPEED.y, so shrinking it moves its top edge down by as much as
    // it lifts its bottom edge, and only half the height it gives up is space
    // the systems stack can use. Solving against the unshrunk top edge instead
    // over-credits the shrink by exactly that half and still lands the stack
    // 9-13 px inside the annunciator strip at every resolution at scale 1.5.
    const gap = 10 * s;
    const annH = L.ANNUNCIATORS.height * H * s * 1.6;
    const columnBottom = L.ANNUNCIATORS.y * H - annH * 0.5 - gap;
    let speedH = L.SPEED.height * H * s * 0.62;
    let sysH = 0.150 * H * s;
    const available = columnBottom - L.SPEED.y * H - gap;
    if (speedH * 0.5 + sysH > available) {
      const k = Math.max(0.35, available / (speedH * 0.5 + sysH));
      speedH *= k;
      sysH *= k;
    }

    place(byId(cr, 'speed'), L.SPEED.x * W + L.SPEED.width * W * s * 0.6,
      L.SPEED.y * H, L.SPEED.width * W * s * 2.4, speedH);

    const speedRegion = byId(cr, 'speed');
    const sysW = L.SPEED.width * W * s * 3.4;
    place(byId(cr, 'systems'), L.SPEED.x * W + sysW * 0.5 - L.SPEED.width * W * s * 0.5,
      speedRegion.y + speedRegion.h + gap + sysH * 0.5, sysW, sysH);

    const sr = L.SONAR.radius * H * s;
    place(byId(cr, 'sonar'), L.SONAR.x * W, L.SONAR.y * H, sr * 2.2, sr * 2.2);

    place(byId(cr, 'annunciators'), L.ANNUNCIATORS.x * W, L.ANNUNCIATORS.y * H,
      L.ANNUNCIATORS.width * W * s, annH);

    // Free swim: one panel pinned to the bottom-left corner, and a reticle a
    // few pixels across at the exact centre. Nothing else - DESIGN/05 05.8.5 is
    // explicit that the swimmer has no floating screen-space instruments, and
    // the middle of the frame is the one place a diving HUD must leave alone.
    const sw = this._swimRegions;
    const wristH = L.WRIST.height * H * s;
    const wristW = wristH * L.WRIST.aspect;
    const wristX = L.WRIST.marginX * H;
    const wristY = H - L.WRIST.marginY * H - wristH;
    place(byId(sw, 'wrist'), wristX + wristW * 0.5, wristY + wristH * 0.5, wristW, wristH);

    const ret = L.RETICLE.radius * H * s;
    place(byId(sw, 'reticle'), 0.5 * W, 0.5 * H, ret * 3.2, ret * 3.2);

    // The showcase scene title: top-centre, just below the compass block so
    // the two do not fight at HUD scale 1 (they may touch at 1.5, which the
    // neighbour propagation handles). NOT scaled by hudScale - it is a title
    // card, not an instrument.
    place(this._titleRegion, 0.5 * W, 0.205 * H, 0.64 * W, 0.068 * H);

    // The attribution credit, pinned to the BOTTOM-RIGHT corner. Both margins
    // and the cap height are fractions of screen HEIGHT, never width - the
    // same rule the wrist unit is anchored by, and for the same reason: a
    // margin quoted against width walks away from the corner on an ultrawide.
    //
    // The box is sized for CREDIT_MAX_CHARS rather than for the live string so
    // the rect is stable across a text change and _computeNeighbours does not
    // have to be re-derived when the string does; _drawDemoCredit right-aligns
    // inside it, so a shorter string simply sits in the same corner.
    //
    // NOT scaled by hudScale, for the title card's reason - a credit is not an
    // instrument. At hudScale 1.5 the annunciator strip widens to x 0.125-0.875
    // and clips this box's left edge by a few pixels; that is exactly what the
    // neighbour propagation below exists to handle.
    const credCap = CREDIT_CAP * H;
    const credW = textWidth('M'.repeat(CREDIT_MAX_CHARS), credCap);
    const credH = credCap * 2.2;
    place(this._creditRegion,
      W - CREDIT_MARGIN_X * H - credW * 0.5,
      H - CREDIT_MARGIN_Y * H - credH * 0.5,
      credW, credH);

    // Cockpit LAST: the title region is in both lists and _computeNeighbours
    // overwrites its group per call, so the surviving group must be the
    // cockpit one - that is the mode where it can overlap the compass. A
    // stale swim-mode mark on a non-live cockpit region is harmless (mode
    // changes reset every dirty flag anyway); a missed compass repaint under
    // the title would punch a hole in the ribbon.
    this._computeNeighbours(this._swimRegions);
    this._computeNeighbours(this._cockpitRegions);
  }

  /**
   * Regions are cleared and repainted individually, so two regions whose
   * rectangles overlap must always be repainted together - otherwise clearing
   * one punches a hole in the other. The layout keeps overlap rare (only the
   * sonar disc and the annunciator strip touch at 16:9), but "rare" is not
   * "never" across every aspect ratio and HUD scale.
   */
  _computeNeighbours(list) {
    for (const a of list) {
      const group = [];
      for (const b of list) {
        if (a === b) continue;
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
          group.push(b);
        }
      }
      this._neighbours.set(a, group);
    }
  }

  // -------------------------------------------------------------------------
  // Repaint
  // -------------------------------------------------------------------------

  /**
   * Dirty tracking: every region derives a quantised signature from exactly the
   * values it draws, at the precision a viewer could actually resolve - INCLUDING
   * the phase of anything that moves on its own, so a sweep or an alarm blink is
   * just another term in the signature rather than a separate always-on path. If
   * the signature is unchanged the region is neither rasterised nor uploaded.
   */
  _repaint() {
    const ctx = this.ctx;
    const device = this.renderer.gpu.device;
    if (!ctx || !this.texture) return;

    const booting = this.bootTime < BOOT_DURATION;
    for (const r of this.regions) {
      const key = this._regionKey(r.id);
      if (booting || key !== r.key) r.dirty = true;
      r.key = key;
    }
    // Overlap propagation runs to a fixed point AFTER every key is settled.
    // Doing it inline in the loop above would make the result depend on the
    // order the regions happen to be listed in, and a region dirtied by a
    // later neighbour would carry a stale key into the next repaint.
    for (let changed = true; changed;) {
      changed = false;
      for (const r of this.regions) {
        if (!r.dirty) continue;
        for (const n of this._neighbours.get(r) || []) {
          if (!n.dirty) { n.dirty = true; changed = true; }
        }
      }
    }

    let painted = 0;
    for (const r of this.regions) {
      if (!r.dirty) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      ctx.clearRect(r.x, r.y, r.w, r.h);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      r.draw(ctx, r);
      ctx.restore();
      painted++;
    }
    if (!device) return;

    // After a wholesale clear the texture must be replaced wholesale, even if
    // nothing was painted: the cleared pixels are the update.
    if (this._fullUpload) {
      this._fullUpload = false;
      for (const r of this.regions) r.dirty = false;
      device.queue.copyExternalImageToTexture(
        { source: this.canvas, origin: { x: 0, y: 0 }, flipY: false },
        { texture: this.texture, origin: { x: 0, y: 0 }, premultipliedAlpha: false },
        { width: this.width, height: this.height },
      );
      return;
    }
    if (painted === 0) return;

    for (const r of this.regions) {
      if (!r.dirty) continue;
      r.dirty = false;
      device.queue.copyExternalImageToTexture(
        { source: this.canvas, origin: { x: r.x, y: r.y }, flipY: false },
        { texture: this.texture, origin: { x: r.x, y: r.y }, premultipliedAlpha: false },
        { width: r.w, height: r.h },
      );
    }
  }

  /**
   * Quantised per-region signature. The quantum for each value is the smallest
   * change that moves a pixel: 0.1 deg of heading is a third of a pixel on the
   * ribbon, 0.05 m of depth is a fifth of a pixel on the tape.
   *
   * Any region that can BLINK also folds in a blink phase, because the alarm
   * ramp is a time-varying alpha: without it the escalation is drawn once at
   * whatever phase the value last changed on and then frozen, which is exactly
   * the failure mode a blinking alarm exists to avoid.
   */
  _regionKey(id) {
    const d = this.disp;
    const s = this.state;
    switch (id) {
      case 'compass':
        return (radToDeg(d.heading) * 10 | 0).toString(36);
      case 'depth':
        return `${(d.depth * 20) | 0}|${(d.verticalSpeed * 20) | 0}|${(s.depthRating) | 0}|` +
          `${s.depthHold === null ? 'x' : (s.depthHold | 0)}|${s.inCave ? 'c' : ''}` +
          this._blinkKey(this._depthLevel());
      case 'speed':
        return `${(d.speed * 20) | 0}|${s.underwater ? 1 : 0}`;
      case 'attitude':
        return `${(d.pitch * 800) | 0}|${(d.roll * 800) | 0}|${s.underwater ? 1 : 0}`;
      case 'systems':
        return `${(d.power * 400) | 0}|${(d.oxygen * 400) | 0}|${(d.hull * 400) | 0}|` +
          `${(d.ballast * 400) | 0}|${s.silentRunning ? 1 : 0}|${s.lightsOn ? 1 : 0}` +
          `|${s.holdActive ? 1 : 0}` +
          this._blinkKey(this._systemsLevel());
      case 'sonar':
        // The sweep is the only continuously moving element. With the head
        // parked - passive, or silent running - the display is a still image
        // apart from contact decay, which the quantised ages below capture, so
        // a stealthy cockpit costs no uploads at all.
        if (s.sonarActive && !s.silentRunning) {
          return 's' + ((this.time / SONAR_SWEEP_PERIOD) * 90 | 0);
        } else {
          const k = this.contacts;
          let out = `p${k.count}|${(radToDeg(d.heading) * 4) | 0}|${s.sonarRange | 0}`;
          for (let i = 0; i < k.count; i++) out += `|${(k.age[i] * 4) | 0}`;
          return out;
        }
      case 'annunciators': {
        const levels = this._annunciatorLevels();
        let out = '';
        let worst = LEVEL_NOMINAL;
        for (let i = 0; i < levels.length; i++) {
          out += levels[i];
          if (levels[i] > worst) worst = levels[i];
        }
        return out + this._blinkKey(worst);
      }
      case 'wrist':
        return `${(s.oxygenSeconds * 4) | 0}|${(d.oxygen * 400) | 0}|${(d.health * 200) | 0}|` +
          `${(d.depth * 10) | 0}|${(radToDeg(d.heading) * 4) | 0}|${s.suitRating | 0}|` +
          `${s.inCave ? 'c' : ''}` +
          this._blinkKey(this._oxygenLevel());
      case 'reticle':
        // Fixed geometry in a fixed place: drawn once per mode change, never again.
        return 'r';
      case 'demoTitle':
        // Alpha quantised to 24 steps: ~17 repaints per fade envelope, zero
        // while the title holds and exactly one (the clear) when it ends.
        return this.demoTitleAlpha > 0.01
          ? `${this.demoTitle}|${(this.demoTitleAlpha * 24) | 0}` : '';
      case 'demoCredit':
        // Same 24-step quantisation as the title, and the same payoff: the
        // key is a constant '' whenever the showcase is not running, which is
        // what keeps a settled HUD at zero rasterisations and zero uploads.
        return this.demoCreditAlpha > 0.01
          ? `${this.demoCredit}|${(this.demoCreditAlpha * 24) | 0}` : '';
      default:
        return '';
    }
  }

  /**
   * Blink phase for a region that is currently alarming, quantised into steps
   * of the raised-cosine ramp; empty when nothing in the region blinks, so a
   * nominal panel still costs exactly zero redraws.
   *
   * Twelve steps per cycle is finer than the eye resolves the ramp and puts the
   * worst case - 2.40 Hz at CRITICAL - at 28.8 redraws per second, just under
   * the MAX_REDRAW_HZ ceiling, so an alarm never starves the rest of the HUD.
   */
  _blinkKey(level) {
    const hz = LEVEL_BLINK_HZ[level];
    if (hz <= 0) return '';
    return '|b' + (Math.floor(this.time * hz * 12) % 12);
  }

  // -------------------------------------------------------------------------
  // Instrument: ribbon compass
  // -------------------------------------------------------------------------

  _drawCompass(ctx, r) {
    const s = this.pixelScale;
    const alpha = this._bootAlpha(0.0);
    if (alpha <= 0) return;

    const ribbonH = r.h / 3.6;
    const x0 = r.x;
    const w = r.w;
    const y0 = r.y + ribbonH * 0.78;
    const cx = x0 + w * 0.5;
    const pxPerDeg = w / COMPASS_SPAN_DEG;
    const headingDeg = radToDeg(this.disp.heading);

    // Bed and rules.
    ctx.fillStyle = rgba(C.ink, 0.55 * alpha);
    ctx.fillRect(x0, y0, w, ribbonH);
    ctx.lineWidth = Math.max(1.15, 1.5 * s);
    ctx.strokeStyle = rgba(C.cyanDim, 0.75 * alpha);
    ctx.beginPath();
    ctx.moveTo(x0, y0 + ribbonH);
    ctx.lineTo(x0 + w, y0 + ribbonH);
    ctx.stroke();

    // Ticks. Iterate whole degrees around the current heading so the ribbon
    // scrolls continuously rather than snapping tick-to-tick.
    const first = Math.ceil(headingDeg - COMPASS_SPAN_DEG * 0.5);
    const last = Math.floor(headingDeg + COMPASS_SPAN_DEG * 0.5);
    const cap = ribbonH * 0.52;
    ctx.lineWidth = Math.max(1.15, 1.5 * s);

    for (let deg = first; deg <= last; deg++) {
      const d = ((deg % 360) + 360) % 360;
      if (d % 5 !== 0) continue;
      const x = cx + (deg - headingDeg) * pxPerDeg;
      const major = d % 45 === 0;
      const mid = d % 15 === 0;
      const len = major ? ribbonH * 0.72 : mid ? ribbonH * 0.46 : ribbonH * 0.26;
      // Fade the outer sixth of the ribbon so ticks do not pop at the edges.
      const edge = saturate((w * 0.5 - Math.abs(x - cx)) / (w * 0.16));
      ctx.strokeStyle = rgba(major ? C.cyan : C.cyanDim, (major ? 0.95 : 0.6) * edge * alpha);
      ctx.beginPath();
      ctx.moveTo(x, y0 + ribbonH);
      ctx.lineTo(x, y0 + ribbonH - len);
      ctx.stroke();

      if (major) {
        const label = headingLabel(d * PI / 180);
        ctx.strokeStyle = rgba(d % 90 === 0 ? C.text : C.cyan, 0.95 * edge * alpha);
        ctx.lineWidth = Math.max(1.15, (d % 90 === 0 ? 2.4 : 1.8) * s);
        drawText(ctx, label, x, y0 - ribbonH * 0.18, cap, { align: 'center', baseline: 'bottom' });
        ctx.lineWidth = Math.max(1.15, 1.5 * s);
      } else if (mid) {
        ctx.strokeStyle = rgba(C.cyanDim, 0.7 * edge * alpha);
        ctx.lineWidth = Math.max(1.15, 1.4 * s);
        drawText(ctx, pad(d, 3), x, y0 - ribbonH * 0.22, cap * 0.62,
          { align: 'center', baseline: 'bottom' });
        ctx.lineWidth = Math.max(1.15, 1.5 * s);
      }
    }

    // Lubber line and the digital heading box under it.
    const boxW = textWidth('000', ribbonH * 0.9) + ribbonH * 1.1;
    const boxH = ribbonH * 1.5;
    const boxY = y0 + ribbonH + ribbonH * 0.28;
    ctx.fillStyle = rgba(C.ink, 0.82 * alpha);
    ctx.fillRect(cx - boxW * 0.5, boxY, boxW, boxH);
    ctx.strokeStyle = rgba(C.amber, 0.9 * alpha);
    ctx.lineWidth = Math.max(1.15, 2.0 * s);
    ctx.strokeRect(cx - boxW * 0.5, boxY, boxW, boxH);

    ctx.beginPath();
    ctx.moveTo(cx - ribbonH * 0.34, boxY - ribbonH * 0.02);
    ctx.lineTo(cx, boxY - ribbonH * 0.46);
    ctx.lineTo(cx + ribbonH * 0.34, boxY - ribbonH * 0.02);
    ctx.stroke();

    const bearing = pad(Math.round(headingDeg) % 360, 3);
    ctx.strokeStyle = rgba(C.amber, alpha);
    ctx.lineWidth = Math.max(1.15, 2.6 * s);
    drawText(ctx, bearing, cx - ribbonH * 0.22, boxY + boxH * 0.5, ribbonH * 0.9,
      { align: 'center', baseline: 'middle' });
    ctx.lineWidth = Math.max(1.15, 1.5 * s);
    ctx.strokeStyle = rgba(C.textDim, 0.9 * alpha);
    drawText(ctx, DEG, cx + boxW * 0.5 - ribbonH * 0.42, boxY + boxH * 0.5, ribbonH * 0.5,
      { align: 'center', baseline: 'middle' });
  }

  // -------------------------------------------------------------------------
  // Instrument: depth tape
  // -------------------------------------------------------------------------

  _drawDepthTape(ctx, r) {
    const s = this.pixelScale;
    const alpha = this._bootAlpha(0.25);
    if (alpha <= 0) return;

    const tapeW = r.w * 0.42;
    const tx = r.x + r.w - tapeW;
    const cy = r.y + r.h * 0.5;
    const ppm = r.h / DEPTH_TAPE_SPAN;
    const depth = this.disp.depth;
    const rating = Math.max(1, this.state.depthRating);
    const yOf = (d) => cy + (d - depth) * ppm;

    ctx.fillStyle = rgba(C.ink, 0.5 * alpha);
    ctx.fillRect(tx, r.y, tapeW, r.h);

    // Crush-depth redline: everything past the hull rating is hatched red, and
    // the band is always visible on the tape even when it is far below, because
    // knowing where the floor of your envelope is matters more than tidiness.
    const yRating = yOf(rating);
    if (yRating < r.y + r.h) {
      const top = Math.max(r.y, yRating);
      ctx.fillStyle = rgba(C.warn, 0.10 * alpha);
      ctx.fillRect(tx, top, tapeW, r.y + r.h - top);
      ctx.strokeStyle = rgba(C.warn, 0.35 * alpha);
      ctx.lineWidth = Math.max(1.15, 1.2 * s);
      ctx.beginPath();
      for (let hy = top; hy < r.y + r.h; hy += 9 * s) {
        ctx.moveTo(tx, hy);
        ctx.lineTo(tx + tapeW, hy + 9 * s);
      }
      ctx.stroke();
      if (yRating >= r.y && yRating <= r.y + r.h) {
        ctx.strokeStyle = rgba(C.warn, alpha);
        ctx.lineWidth = Math.max(1.15, 3.0 * s);
        ctx.beginPath();
        ctx.moveTo(tx, yRating);
        ctx.lineTo(tx + tapeW, yRating);
        ctx.stroke();
        ctx.lineWidth = Math.max(1.15, 2.0 * s);
        drawText(ctx, 'MAX', tx - 6 * s, yRating - 3 * s, r.h * 0.022,
          { align: 'right', baseline: 'bottom' });
      }
    }

    // Ticks: 5 m minor, 20 m major with a label.
    const dTop = depth - DEPTH_TAPE_SPAN * 0.5;
    const dBot = depth + DEPTH_TAPE_SPAN * 0.5;
    const cap = r.h * 0.026;
    for (let d = Math.ceil(dTop / 5) * 5; d <= dBot; d += 5) {
      if (d < 0) continue;
      const y = yOf(d);
      const major = d % 20 === 0;
      const len = major ? tapeW * 0.55 : tapeW * 0.3;
      const edge = saturate((r.h * 0.5 - Math.abs(y - cy)) / (r.h * 0.14));
      ctx.strokeStyle = rgba(major ? C.cyan : C.cyanDim, (major ? 0.9 : 0.55) * edge * alpha);
      ctx.lineWidth = Math.max(1.15, (major ? 2.0 : 1.4) * s);
      ctx.beginPath();
      ctx.moveTo(tx + tapeW, y);
      ctx.lineTo(tx + tapeW - len, y);
      ctx.stroke();
      if (major) {
        drawText(ctx, String(d), tx + tapeW - len - 5 * s, y, cap,
          { align: 'right', baseline: 'middle' });
      }
    }

    // Depth-hold bug.
    if (this.state.depthHold !== null) {
      const y = clamp(yOf(this.state.depthHold), r.y, r.y + r.h);
      ctx.strokeStyle = rgba(C.good, 0.95 * alpha);
      ctx.lineWidth = Math.max(1.15, 2.2 * s);
      ctx.beginPath();
      ctx.moveTo(tx + tapeW, y);
      ctx.lineTo(tx + tapeW * 0.62, y - tapeW * 0.22);
      ctx.lineTo(tx + tapeW * 0.62, y + tapeW * 0.22);
      ctx.closePath();
      ctx.stroke();
    }

    // Hero readout, centred on the tape.
    const level = this._depthLevel();
    const blink = blinkAlpha(level, this.time);
    const boxH = r.h * 0.072;
    const boxW = r.w * 0.86;
    const bx = r.x + r.w - boxW;
    ctx.fillStyle = rgba(C.ink, 0.9 * alpha);
    ctx.fillRect(bx, cy - boxH * 0.5, boxW, boxH);
    ctx.strokeStyle = rgba(LEVEL_COLOR[level], blink * alpha);
    ctx.lineWidth = Math.max(1.15, 2.0 * LEVEL_STROKE[level] * s);
    ctx.strokeRect(bx, cy - boxH * 0.5, boxW, boxH);

    ctx.strokeStyle = rgba(LEVEL_COLOR[level], blink * alpha);
    ctx.lineWidth = Math.max(1.15, 3.0 * LEVEL_STROKE[level] * s);
    drawText(ctx, pad(depth, 4), bx + boxW - boxH * 0.62, cy, boxH * 0.62,
      { align: 'right', baseline: 'middle' });
    ctx.lineWidth = Math.max(1.15, 1.6 * s);
    ctx.strokeStyle = rgba(C.textDim, 0.9 * alpha);
    drawText(ctx, 'M', bx + boxW - boxH * 0.34, cy, boxH * 0.3,
      { align: 'center', baseline: 'middle' });
    drawText(ctx, 'DEPTH', bx, cy - boxH * 0.62, boxH * 0.26,
      { align: 'left', baseline: 'bottom' });
    if (this.state.inCave) {
      // Under a roof, depth stops meaning "metres to an open surface" - say so
      // where the depth is read, in the caution colour, no blink: a cave is a
      // condition, not an alarm.
      ctx.strokeStyle = rgba(C.amber, 0.95 * alpha);
      ctx.lineWidth = Math.max(1.15, 2.0 * s);
      drawText(ctx, 'CAVE', bx, cy + boxH * 0.62, boxH * 0.26,
        { align: 'left', baseline: 'top' });
    }

    this._drawVerticalSpeed(ctx, r, tx, cy, alpha);
  }

  /**
   * Rate-of-change needle, left of the depth tape. Full scale is the vessel's
   * maximum climb rate, so a pegged needle means "you are at the machine's
   * limit", not an arbitrary number.
   */
  _drawVerticalSpeed(ctx, r, tapeX, cy, alpha) {
    const s = this.pixelScale;
    const gaugeR = r.w * 0.34;
    const gx = tapeX - gaugeR * 0.30;
    const full = VESSEL.MAX_CLIMB_RATE;
    const vs = clamp(this.disp.verticalSpeed, -full, full);
    const maxAngle = 1.15; // radians either side of horizontal

    ctx.strokeStyle = rgba(C.cyanDim, 0.7 * alpha);
    ctx.lineWidth = Math.max(1.15, 1.4 * s);
    for (let i = -2; i <= 2; i++) {
      const a = (i / 2) * maxAngle;
      const inner = i === 0 ? gaugeR * 0.62 : gaugeR * 0.76;
      ctx.beginPath();
      ctx.moveTo(gx + Math.cos(a) * inner, cy - Math.sin(a) * inner);
      ctx.lineTo(gx + Math.cos(a) * gaugeR, cy - Math.sin(a) * gaugeR);
      ctx.stroke();
    }

    const angle = (vs / full) * maxAngle;
    const climbing = vs >= 0;
    ctx.strokeStyle = rgba(Math.abs(vs) > full * 0.85 ? C.amber : C.cyan, alpha);
    ctx.lineWidth = Math.max(1.15, 2.6 * s);
    ctx.beginPath();
    ctx.moveTo(gx, cy);
    ctx.lineTo(gx + Math.cos(angle) * gaugeR * 0.94, cy - Math.sin(angle) * gaugeR * 0.94);
    ctx.stroke();

    ctx.lineWidth = Math.max(1.15, 1.6 * s);
    ctx.strokeStyle = rgba(climbing ? C.good : C.amber, 0.95 * alpha);
    drawText(ctx, signed(this.disp.verticalSpeed, 2, 1), gx - gaugeR * 0.1,
      cy + gaugeR * 0.98, r.h * 0.022, { align: 'left', baseline: 'top' });
  }

  // -------------------------------------------------------------------------
  // Instrument: speed tape
  // -------------------------------------------------------------------------

  _drawSpeedTape(ctx, r) {
    const s = this.pixelScale;
    const alpha = this._bootAlpha(0.25);
    if (alpha <= 0) return;

    const tapeW = r.w * 0.42;
    const tx = r.x;
    const cy = r.y + r.h * 0.5;
    const underwater = this.state.underwater;
    const maxSpeed = underwater ? VESSEL.MAX_SUBSPEED : VESSEL.MAX_AIRSPEED;
    const span = underwater ? SPEED_TAPE_SPAN * 0.6 : SPEED_TAPE_SPAN * 2.6;
    const ppu = r.h / span;
    const speed = this.disp.speed;
    const yOf = (v) => cy - (v - speed) * ppu;

    ctx.fillStyle = rgba(C.ink, 0.5 * alpha);
    ctx.fillRect(tx, r.y, tapeW, r.h);

    // Overspeed band above the envelope.
    const yMax = yOf(maxSpeed);
    if (yMax > r.y) {
      ctx.fillStyle = rgba(C.warn, 0.10 * alpha);
      ctx.fillRect(tx, r.y, tapeW, Math.min(yMax, r.y + r.h) - r.y);
    }

    const step = underwater ? 2 : 5;
    const majorEvery = underwater ? 10 : 20;
    const cap = r.h * 0.034;
    for (let v = Math.ceil((speed - span * 0.5) / step) * step; v <= speed + span * 0.5; v += step) {
      if (v < 0) continue;
      const y = yOf(v);
      const major = v % majorEvery === 0;
      const len = major ? tapeW * 0.55 : tapeW * 0.3;
      const edge = saturate((r.h * 0.5 - Math.abs(y - cy)) / (r.h * 0.14));
      ctx.strokeStyle = rgba(major ? C.cyan : C.cyanDim, (major ? 0.9 : 0.55) * edge * alpha);
      ctx.lineWidth = Math.max(1.15, (major ? 2.0 : 1.4) * s);
      ctx.beginPath();
      ctx.moveTo(tx, y);
      ctx.lineTo(tx + len, y);
      ctx.stroke();
      if (major) {
        drawText(ctx, String(v), tx + len + 5 * s, y, cap, { align: 'left', baseline: 'middle' });
      }
    }

    const boxH = r.h * 0.11;
    const boxW = r.w * 0.86;
    ctx.fillStyle = rgba(C.ink, 0.9 * alpha);
    ctx.fillRect(tx, cy - boxH * 0.5, boxW, boxH);
    ctx.strokeStyle = rgba(speed > maxSpeed ? C.warn : C.cyan, alpha);
    ctx.lineWidth = Math.max(1.15, 2.0 * s);
    ctx.strokeRect(tx, cy - boxH * 0.5, boxW, boxH);

    ctx.lineWidth = Math.max(1.15, 3.0 * s);
    ctx.strokeStyle = rgba(speed > maxSpeed ? C.warn : C.amber, alpha);
    drawText(ctx, pad(speed, 3), tx + boxH * 0.24, cy, boxH * 0.58,
      { align: 'left', baseline: 'middle' });

    ctx.lineWidth = Math.max(1.15, 1.6 * s);
    ctx.strokeStyle = rgba(C.textDim, 0.9 * alpha);
    // The tape and the hero number are metres per second, which is the unit the
    // whole simulation is in; the knot conversion is a subordinate line so the
    // pilot never has to reconcile two scales while reading the tape.
    drawText(ctx, underwater ? 'WTR' : 'AIR', tx, cy - boxH * 0.62, boxH * 0.26,
      { align: 'left', baseline: 'bottom' });
    drawText(ctx, `${pad(speed * 1.94384, 3)} KT`, tx, cy + boxH * 0.62, boxH * 0.26,
      { align: 'left', baseline: 'top' });
  }

  // -------------------------------------------------------------------------
  // Instrument: attitude indicator
  // -------------------------------------------------------------------------

  /**
   * Artificial horizon that works in air, in water and inverted.
   *
   * Pitch outside +/-90 deg is folded back with a 180 deg roll flip, which is
   * the standard spherical fix: without it, pushing over the top makes the
   * ladder run backwards and the display silently lies about which way is up.
   */
  _drawAttitude(ctx, r) {
    const s = this.pixelScale;
    const alpha = this._bootAlpha(0.5);
    if (alpha <= 0) return;

    const cx = r.x + r.w * 0.5;
    const cy = r.y + r.h * 0.5;
    const R = Math.min(r.w, r.h) * 0.37;

    let pitchDeg = radToDeg(wrapAngle(this.disp.pitch));
    let rollRad = this.disp.roll;
    if (Math.abs(pitchDeg) > 90) {
      pitchDeg = Math.sign(pitchDeg) * (180 - Math.abs(pitchDeg));
      rollRad += PI;
    }
    const pxPerDeg = R / PITCH_DEG_PER_RADIUS;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.clip();

    ctx.translate(cx, cy);
    // Canvas y is down, so a visually counter-clockwise horizon (right wing
    // down = right end of the horizon rises) is a NEGATIVE ctx.rotate.
    ctx.rotate(-rollRad);
    const horizonY = pitchDeg * pxPerDeg;

    // Ground/sky halves. Underwater the "sky" is the lit surface side, which is
    // why the two states use different tints rather than a fixed blue.
    ctx.fillStyle = rgba(this.state.underwater ? C.cyanDim : C.cyan, 0.14 * alpha);
    ctx.fillRect(-R * 1.6, horizonY - R * 3.2, R * 3.2, R * 3.2);
    ctx.fillStyle = rgba(C.ink, 0.68 * alpha);
    ctx.fillRect(-R * 1.6, horizonY, R * 3.2, R * 3.2);

    ctx.strokeStyle = rgba(C.text, 0.95 * alpha);
    ctx.lineWidth = Math.max(1.15, 2.2 * s);
    ctx.beginPath();
    ctx.moveTo(-R * 1.6, horizonY);
    ctx.lineTo(R * 1.6, horizonY);
    ctx.stroke();

    // Pitch ladder, dashed below the horizon.
    const cap = R * 0.13;
    for (let p = -80; p <= 80; p += 10) {
      if (p === 0) continue;
      const y = horizonY - p * pxPerDeg;
      if (Math.abs(y - 0) > R * 1.25) continue;
      const half = (p % 20 === 0 ? R * 0.5 : R * 0.3);
      ctx.strokeStyle = rgba(C.text, 0.75 * alpha);
      ctx.lineWidth = Math.max(1.15, 1.6 * s);
      ctx.beginPath();
      if (p > 0) {
        ctx.moveTo(-half, y); ctx.lineTo(half, y);
      } else {
        const dash = half * 0.32;
        for (let k = -1; k <= 1; k += 1) {
          ctx.moveTo(k * half * 0.66 - dash * 0.5, y);
          ctx.lineTo(k * half * 0.66 + dash * 0.5, y);
        }
      }
      // Tick ends turn toward the horizon, the standard "which way is up" cue.
      ctx.moveTo(-half, y); ctx.lineTo(-half, y + Math.sign(p) * R * 0.05);
      ctx.moveTo(half, y); ctx.lineTo(half, y + Math.sign(p) * R * 0.05);
      ctx.stroke();
      if (p % 20 === 0) {
        ctx.lineWidth = Math.max(1.15, 1.5 * s);
        drawText(ctx, String(Math.abs(p)), -half - R * 0.06, y, cap,
          { align: 'right', baseline: 'middle' });
        drawText(ctx, String(Math.abs(p)), half + R * 0.06, y, cap,
          { align: 'left', baseline: 'middle' });
      }
    }
    ctx.restore();

    // Roll scale and pointer, fixed to the instrument.
    ctx.strokeStyle = rgba(C.cyanDim, 0.85 * alpha);
    ctx.lineWidth = Math.max(1.15, 1.5 * s);
    for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const rad = a * PI / 180 - Math.PI * 0.5;
      const inner = (a % 30 === 0 || a === 45 || a === -45) ? R * 1.10 : R * 1.05;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(rad) * R * 1.0, cy + Math.sin(rad) * R * 1.0);
      ctx.lineTo(cx + Math.cos(rad) * inner, cy + Math.sin(rad) * inner);
      ctx.stroke();
    }
    const rp = -rollRad - Math.PI * 0.5;
    ctx.fillStyle = rgba(C.amber, alpha);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(rp) * R * 0.97, cy + Math.sin(rp) * R * 0.97);
    ctx.lineTo(cx + Math.cos(rp - 0.06) * R * 0.86, cy + Math.sin(rp - 0.06) * R * 0.86);
    ctx.lineTo(cx + Math.cos(rp + 0.06) * R * 0.86, cy + Math.sin(rp + 0.06) * R * 0.86);
    ctx.closePath();
    ctx.fill();

    // Boresight. Never rotates, never moves - it is the aircraft.
    ctx.strokeStyle = rgba(C.amber, alpha);
    ctx.lineWidth = Math.max(1.15, 3.0 * s);
    ctx.beginPath();
    ctx.moveTo(cx - R * 0.62, cy);
    ctx.lineTo(cx - R * 0.24, cy);
    ctx.lineTo(cx - R * 0.12, cy + R * 0.12);
    ctx.moveTo(cx + R * 0.62, cy);
    ctx.lineTo(cx + R * 0.24, cy);
    ctx.lineTo(cx + R * 0.12, cy + R * 0.12);
    ctx.stroke();
    ctx.fillStyle = rgba(C.amber, alpha);
    ctx.fillRect(cx - 1.5 * s, cy - 1.5 * s, 3 * s, 3 * s);

    // Bezel, plus the pitch and roll digits under it.
    ctx.strokeStyle = rgba(C.cyanDim, 0.8 * alpha);
    ctx.lineWidth = Math.max(1.15, 1.5 * s);
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.stroke();

    ctx.lineWidth = Math.max(1.15, 1.6 * s);
    ctx.strokeStyle = rgba(C.textDim, 0.9 * alpha);
    drawText(ctx, `${signed(pitchDeg, 2, 0)}${DEG}`, cx - R * 0.9, cy + R * 1.24, R * 0.13,
      { align: 'left', baseline: 'top' });
    drawText(ctx, `${signed(radToDeg(wrapAngle(rollRad)), 3, 0)}${DEG}`, cx + R * 0.9,
      cy + R * 1.24, R * 0.13, { align: 'right', baseline: 'top' });
  }

  // -------------------------------------------------------------------------
  // Instrument: systems stack
  // -------------------------------------------------------------------------

  _drawSystems(ctx, r) {
    const s = this.pixelScale;
    const alpha = this._bootAlpha(0.7);
    if (alpha <= 0) return;

    const rowH = r.h / 4.6;
    const labelW = textWidth('PWR', rowH * 0.42) + 8 * s;
    const barX = r.x + labelW;
    const barW = r.w - labelW - textWidth('100%', rowH * 0.4) - 10 * s;

    for (let i = 0; i < SYSTEM_ROWS.length; i++) {
      const row = SYSTEM_ROWS[i];
      const value = this.disp[row.field];
      const level = this._rampLevel(value, row.t[0], row.t[1], row.t[2], row.t[3]);
      const y = r.y + i * rowH;
      const blink = blinkAlpha(level, this.time);
      const col = LEVEL_COLOR[level];

      ctx.strokeStyle = rgba(C.textDim, 0.9 * alpha);
      ctx.lineWidth = Math.max(1.15, 1.6 * s);
      drawText(ctx, row.label, r.x, y + rowH * 0.5, rowH * 0.42,
        { align: 'left', baseline: 'middle' });

      const bh = rowH * 0.44;
      const by = y + rowH * 0.5 - bh * 0.5;
      ctx.fillStyle = rgba(C.ink, 0.75 * alpha);
      ctx.fillRect(barX, by, barW, bh);
      ctx.fillStyle = rgba(col, 0.85 * blink * alpha);
      ctx.fillRect(barX, by, barW * saturate(value), bh);
      ctx.strokeStyle = rgba(col, 0.7 * alpha);
      ctx.lineWidth = Math.max(1.15, 1.4 * LEVEL_STROKE[level] * s);
      ctx.strokeRect(barX, by, barW, bh);
      // Segment the track so the bar reads as an instrument, not a progress bar.
      ctx.strokeStyle = rgba(C.ink, 0.8 * alpha);
      ctx.beginPath();
      for (let k = 1; k < 10; k++) {
        const sx = barX + barW * k * 0.1;
        ctx.moveTo(sx, by);
        ctx.lineTo(sx, by + bh);
      }
      ctx.stroke();

      ctx.strokeStyle = rgba(col, blink * alpha);
      ctx.lineWidth = Math.max(1.15, 1.8 * s);
      drawText(ctx, `${pad(value * 100, 3)}%`, r.x + r.w, y + rowH * 0.5, rowH * 0.4,
        { align: 'right', baseline: 'middle' });
    }

    // Ballast trim: a centre-zero gauge, because what matters is which side of
    // neutral you are on, not the absolute tank fill.
    const y = r.y + 3 * rowH;
    const trim = (this.disp.ballast - VESSEL.BALLAST_NEUTRAL) * 2;
    ctx.strokeStyle = rgba(C.textDim, 0.9 * alpha);
    ctx.lineWidth = Math.max(1.15, 1.6 * s);
    drawText(ctx, 'BAL', r.x, y + rowH * 0.5, rowH * 0.42, { align: 'left', baseline: 'middle' });

    const bh = rowH * 0.44;
    const by = y + rowH * 0.5 - bh * 0.5;
    const mid = barX + barW * 0.5;
    ctx.fillStyle = rgba(C.ink, 0.75 * alpha);
    ctx.fillRect(barX, by, barW, bh);
    ctx.fillStyle = rgba(trim > 0 ? C.amber : C.cyan, 0.85 * alpha);
    const half = barW * 0.5 * clamp(Math.abs(trim), 0, 1);
    ctx.fillRect(trim >= 0 ? mid : mid - half, by, half, bh);
    ctx.strokeStyle = rgba(C.cyanDim, 0.8 * alpha);
    ctx.lineWidth = Math.max(1.15, 1.4 * s);
    ctx.strokeRect(barX, by, barW, bh);
    ctx.beginPath();
    ctx.moveTo(mid, by - bh * 0.25);
    ctx.lineTo(mid, by + bh * 1.25);
    ctx.stroke();
    ctx.strokeStyle = rgba(C.text, 0.95 * alpha);
    ctx.lineWidth = Math.max(1.15, 1.8 * s);
    drawText(ctx, trim >= 0 ? 'FLD' : 'BLW', r.x + r.w, y + rowH * 0.5, rowH * 0.4,
      { align: 'right', baseline: 'middle' });

    // Mode strip: vertical hold, lights, silent running.
    //
    // HOLD replaces what used to display the assisted/manual flight law. There is
    // only one flight law now, so a lamp naming it told the pilot nothing; whether
    // the vertical hold has latched a reference is something they act on.
    const my = r.y + 4 * rowH;
    const chips = [
      { text: 'HOLD', on: this.state.holdActive },
      { text: 'LGT', on: this.state.lightsOn },
      { text: 'SIL', on: this.state.silentRunning },
    ];
    let cxp = r.x;
    for (const chip of chips) {
      const cw = textWidth(chip.text, rowH * 0.34) + 10 * s;
      ctx.strokeStyle = rgba(chip.on ? C.amber : C.cyanDim, (chip.on ? 0.95 : 0.4) * alpha);
      ctx.lineWidth = Math.max(1.15, 1.4 * s);
      ctx.strokeRect(cxp, my + rowH * 0.16, cw, rowH * 0.62);
      drawText(ctx, chip.text, cxp + cw * 0.5, my + rowH * 0.47, rowH * 0.34,
        { align: 'center', baseline: 'middle' });
      cxp += cw + 6 * s;
    }
  }

  // -------------------------------------------------------------------------
  // Instrument: sonar
  // -------------------------------------------------------------------------

  _drawSonar(ctx, r) {
    const s = this.pixelScale;
    const alpha = this._bootAlpha(0.85);
    if (alpha <= 0) return;

    const cx = r.x + r.w * 0.5;
    const cy = r.y + r.h * 0.5;
    const R = Math.min(r.w, r.h) * 0.45;
    const range = Math.max(1, this.state.sonarRange);
    const active = this.state.sonarActive && !this.state.silentRunning;

    ctx.fillStyle = rgba(C.ink, 0.62 * alpha);
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.fill();

    ctx.strokeStyle = rgba(C.cyanDim, 0.65 * alpha);
    ctx.lineWidth = Math.max(1.15, 1.3 * s);
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, R * i / 3, 0, TAU);
      ctx.stroke();
    }
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI * 0.5;
      ctx.moveTo(cx + Math.cos(a) * R * 0.12, cy + Math.sin(a) * R * 0.12);
      ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    }
    ctx.stroke();

    // Sweep. The display is head-up, so north walks around the bezel.
    const sweep = active ? (this.time / SONAR_SWEEP_PERIOD) * TAU : 0;
    if (active) {
      const steps = 14;
      for (let i = 0; i < steps; i++) {
        const a = sweep - i * 0.055 - Math.PI * 0.5;
        const k = (1 - i / steps);
        ctx.strokeStyle = rgba(C.good, 0.30 * k * k * alpha);
        ctx.lineWidth = Math.max(1.15, 2.2 * s);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
        ctx.stroke();
      }
    }

    // North marker on the bezel.
    const northA = -this.disp.heading - Math.PI * 0.5;
    ctx.strokeStyle = rgba(C.text, 0.85 * alpha);
    ctx.lineWidth = Math.max(1.15, 1.8 * s);
    drawText(ctx, 'N', cx + Math.cos(northA) * R * 1.13, cy + Math.sin(northA) * R * 1.13,
      R * 0.17, { align: 'center', baseline: 'middle' });

    // Contacts.
    const k = this.contacts;
    for (let i = 0; i < k.count; i++) {
      const rel = wrapAngle2Pi(k.bearing[i] - this.disp.heading);
      const rr = clamp(k.distance[i] / range, 0, 1) * R;
      const a = rel - Math.PI * 0.5;
      const px = cx + Math.cos(a) * rr;
      const py = cy + Math.sin(a) * rr;
      // Blips are brightest just after the sweep crosses them and fade over one
      // revolution, exactly like a phosphor PPI.
      const sinceSweep = active
        ? wrapAngle2Pi(sweep - rel) / TAU
        : saturate(k.age[i] / SONAR_CONTACT_LIFETIME);
      const fade = saturate(1 - sinceSweep) * saturate(1 - k.age[i] / SONAR_CONTACT_LIFETIME);
      const blipR = R * (0.035 + 0.028 * clamp(k.size[i], 0.2, 6));
      ctx.fillStyle = rgba(k.hostile[i] ? C.warn : C.good, (0.25 + 0.75 * fade) * alpha);
      ctx.beginPath();
      ctx.arc(px, py, blipR, 0, TAU);
      ctx.fill();
      if (k.hostile[i]) {
        ctx.strokeStyle = rgba(C.warn, (0.4 + 0.6 * fade) * alpha);
        ctx.lineWidth = Math.max(1.15, 1.6 * s);
        ctx.beginPath();
        ctx.arc(px, py, blipR * 2.1, 0, TAU);
        ctx.stroke();
      }
    }

    ctx.strokeStyle = rgba(active ? C.cyan : C.textDim, 0.9 * alpha);
    ctx.lineWidth = Math.max(1.15, 1.6 * s);
    drawText(ctx, active ? `${pad(range, 3)} M` : 'PASSIVE', cx, cy + R * 1.06, R * 0.15,
      { align: 'center', baseline: 'top' });
  }

  // -------------------------------------------------------------------------
  // Instrument: annunciator panel
  // -------------------------------------------------------------------------

  /**
   * Fill and return the annunciator level array. Refilled in place: this runs
   * twice per repaint (signature, then draw) and must not allocate.
   */
  _annunciatorLevels() {
    const s = this.state;
    const d = this.disp;
    const out = this._annunLevels;
    const ratio = s.depth / Math.max(1, s.depthRating);
    out[0] = ratio > 1.2 ? LEVEL_CRITICAL : ratio > 1.0 ? LEVEL_WARNING
      : ratio > VESSEL.CREAK_THRESHOLD ? LEVEL_CAUTION : LEVEL_NOMINAL;
    out[1] = this._rampLevel(d.power, 0.35, 0.2, 0.1, 0.04);
    out[2] = this._rampLevel(d.hull, 0.8, 0.55, 0.35, 0.18);
    out[3] = this._rampLevel(d.oxygen, 0.4, 0.2, 0.1, 0.04);
    out[4] = this._rampLevel(1 - s.heat, 0.6, 0.4, 0.25, 0.12);
    out[5] = s.leak > 0.66 ? LEVEL_CRITICAL : s.leak > 0.33 ? LEVEL_WARNING
      : s.leak > 0 ? LEVEL_CAUTION : LEVEL_NOMINAL;
    return out;
  }

  _drawAnnunciators(ctx, r) {
    const s = this.pixelScale;
    const alpha = this._bootAlpha(0.95);
    if (alpha <= 0) return;

    const levels = this._annunciatorLevels();
    const count = ANNUNCIATOR_LABELS.length;
    const gap = 6 * s;
    const lampW = (r.w - gap * (count - 1)) / count;
    const lampH = r.h * 0.62;
    const y = r.y + (r.h - lampH) * 0.5;
    const cap = Math.min(lampH * 0.42, lampW * 0.26);

    for (let i = 0; i < count; i++) {
      const text = ANNUNCIATOR_LABELS[i];
      const level = levels[i];
      const x = r.x + i * (lampW + gap);
      const lit = level > LEVEL_NOMINAL;
      const blink = blinkAlpha(level, this.time);
      const col = lit ? LEVEL_COLOR[level] : C.cyanDim;
      const a = (lit ? blink : 0.30) * alpha;

      // The cap is the same near-opaque dark plastic whether the lamp is lit or
      // not, and lighting it adds a colour wash INSIDE that cap rather than
      // replacing it. Filling a lit lamp with 16% colour and an unlit one with
      // 50% ink makes the lit lamp the MORE transparent of the two, which is
      // backwards for the one element whose whole job is to become the
      // brightest thing in the cockpit the instant it fires.
      ctx.fillStyle = rgba(C.ink, 0.82 * alpha);
      ctx.fillRect(x, y, lampW, lampH);
      if (lit) {
        ctx.fillStyle = rgba(col, 0.22 * blink * alpha);
        ctx.fillRect(x, y, lampW, lampH);
      }
      ctx.strokeStyle = rgba(col, a);
      ctx.lineWidth = Math.max(1.15, 1.6 * LEVEL_STROKE[level] * s);
      ctx.strokeRect(x, y, lampW, lampH);
      // Unlit lamps keep their outline AND their legend, in text rather than
      // instrument colour: a panel that changes shape when an alarm fires is
      // harder to read at a glance than one that lights up, but a legend drawn
      // at 30% of a dim teal over a daylit sea composites to within a few
      // percent of the cap behind it and the strip reads as six blank boxes.
      ctx.strokeStyle = rgba(lit ? col : C.textDim, (lit ? blink : 0.78) * alpha);
      ctx.lineWidth = Math.max(1.15, 2.0 * LEVEL_STROKE[level] * s);
      drawText(ctx, text, x + lampW * 0.5, y + lampH * 0.5, cap,
        { align: 'center', baseline: 'middle' });
    }
  }

  // -------------------------------------------------------------------------
  // Free-swim: wrist unit and centre reticle
  // -------------------------------------------------------------------------

  /**
   * The wrist unit: one chamfered panel in the bottom-left corner, where the
   * forearm actually is (DESIGN/05 05.8.5). It is deliberately small - about a
   * sixth of the screen height - and deliberately off-centre, because the
   * middle of the frame is where the diver is looking and is the one place a
   * swimming HUD must never occupy.
   *
   * Oxygen is the hero and everything else is subordinate to it, because in the
   * water oxygen is the only number that can kill you in the next ten seconds.
   * Its escalation is physical rather than decorative: the arc thickens, the
   * numerals grow, the case frame adopts the alarm colour, the blink doubles in
   * rate at PLAYER.OXYGEN_CRITICAL, and a contracting breath ring appears
   * inside the dial. The four secondary readouts share one baseline grid, one
   * value size and one label size precisely so that none of them can compete
   * with the dial for a glance.
   */
  _drawWrist(ctx, r) {
    const s = this.pixelScale;
    // Inset the case from the region so a stroked edge is not half-clipped by
    // the region rectangle it is repainted through.
    const edge = Math.max(2, 2.5 * s);
    const x0 = r.x + edge;
    const y0 = r.y + edge;
    const w = r.w - edge * 2;
    const u = r.h - edge * 2;      // every dimension below is a multiple of it
    const gut = u * 0.075;

    const level = this._oxygenLevel();
    const blink = blinkAlpha(level, this.time);
    const col = OXYGEN_COLOR[level];

    this._drawWristCase(ctx, x0, y0, w, u, level, blink);
    this._drawOxygenDial(ctx, x0 + u * 0.5, y0 + u * 0.5, u, level, blink, col);

    // Column divider, so the hero and the readouts read as two instruments on
    // one case rather than one crowded one.
    const colX = x0 + u * 0.985;
    ctx.strokeStyle = rgba(C.cyanDim, 0.45);
    ctx.lineWidth = Math.max(1.15, 1.2 * s);
    ctx.beginPath();
    ctx.moveTo(colX - u * 0.055, y0 + u * 0.12);
    ctx.lineTo(colX - u * 0.055, y0 + u * 0.88);
    ctx.stroke();

    // Secondary readouts. One grid: four rows of equal height, labels flush
    // left, values right-aligned against a fixed unit column, so every baseline
    // and every digit stem lines up whatever the values happen to be.
    const colR = x0 + w - gut;
    const rowH = (u - gut * 2) / 4;
    const capValue = u * 0.125;
    const capLabel = u * 0.075;
    const unitW = textWidth('BAR', capLabel) + u * 0.062;
    const valX = colX + (colR - colX) * 0.38;

    const depth = this.disp.depth;
    const depthRatio = depth / Math.max(1, this.state.suitRating);
    const depthCol = depthRatio > 1.0 ? C.warn : depthRatio > 0.8 ? C.amber : C.text;
    // Under a roof the wrist's depth row IS the cave annunciator - the depth
    // tape's CAVE tag lives on the COCKPIT hud, which no diver under a
    // diver-scale mouth can be using (the review's dead-consumer finding);
    // the label swaps rather than a new element so the grid cannot collide.
    const inCave = this.state.inCave;
    const rows = [
      { label: inCave ? 'CAVE' : 'DEPTH', value: pad(depth, 4), unit: 'M',
        col: inCave ? C.amber : depthCol },
      { label: 'PRESS', value: pad(pressureAt(depth), 3), unit: 'BAR', col: C.text },
      // The cardinal sits in the unit column rather than a degree sign: the row
      // is already labelled HDG, and 'NE' is what a diver actually navigates on.
      {
        label: 'HDG',
        value: pad(Math.round(radToDeg(this.disp.heading)) % 360, 3),
        unit: headingLabel(this.disp.heading),
        col: C.text,
      },
    ];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const cy = y0 + gut + rowH * (i + 0.5);
      ctx.strokeStyle = rgba(C.textDim, 0.85);
      ctx.lineWidth = Math.max(1.15, 1.4 * s);
      drawText(ctx, row.label, colX, cy, capLabel, { align: 'left', baseline: 'middle' });
      ctx.strokeStyle = rgba(row.col, 0.95);
      ctx.lineWidth = Math.max(1.15, 2.0 * s);
      drawText(ctx, row.value, colR - unitW, cy, capValue, { align: 'right', baseline: 'middle' });
      ctx.strokeStyle = rgba(C.textDim, 0.85);
      ctx.lineWidth = Math.max(1.15, 1.4 * s);
      drawText(ctx, row.unit, colR, cy, capLabel, { align: 'right', baseline: 'middle' });
    }

    // Suit integrity closes the grid as a bar rather than a number: a missing
    // block is legible in peripheral vision, which three digits are not.
    const hy = y0 + gut + rowH * 3.5;
    const hh = u * 0.075;
    const health = saturate(this.disp.health);
    const segments = 8;
    const segW = (colR - valX) / segments;
    const lit = Math.round(health * segments);
    ctx.strokeStyle = rgba(C.textDim, 0.85);
    ctx.lineWidth = Math.max(1.15, 1.4 * s);
    drawText(ctx, 'INTEG', colX, hy, capLabel, { align: 'left', baseline: 'middle' });
    for (let i = 0; i < segments; i++) {
      const on = i < lit;
      ctx.fillStyle = rgba(on ? (health < 0.3 ? C.warn : C.good) : C.cyanDim, on ? 0.9 : 0.3);
      ctx.fillRect(valX + segW * i, hy - hh * 0.5, segW - Math.max(1, 1.5 * s), hh);
    }
  }

  /**
   * The case: a chamfered slab with corner brackets. The chamfer and the
   * brackets are the whole reason the panel reads as a physical device strapped
   * to an arm instead of a rectangle of debug text, and the frame is the only
   * element that carries the oxygen alarm colour outside the dial itself.
   */
  _drawWristCase(ctx, x0, y0, w, h, level, blink) {
    const s = this.pixelScale;
    const c = h * 0.11;

    ctx.beginPath();
    ctx.moveTo(x0 + c, y0);
    ctx.lineTo(x0 + w - c, y0);
    ctx.lineTo(x0 + w, y0 + c);
    ctx.lineTo(x0 + w, y0 + h - c);
    ctx.lineTo(x0 + w - c, y0 + h);
    ctx.lineTo(x0 + c, y0 + h);
    ctx.lineTo(x0, y0 + h - c);
    ctx.lineTo(x0, y0 + c);
    ctx.closePath();
    ctx.fillStyle = rgba(C.ink, 0.62);
    ctx.fill();
    const alarm = level >= LEVEL_WARNING;
    ctx.strokeStyle = alarm ? rgba(OXYGEN_COLOR[level], 0.85 * blink) : rgba(C.cyanDim, 0.9);
    ctx.lineWidth = Math.max(1.15, 1.5 * LEVEL_STROKE[level] * s);
    ctx.stroke();

    // Bezel rules inside the two long edges, on the diagonal the chamfers set
    // up. Purely a case detail, and dim enough never to compete with a readout.
    const b = h * 0.26;
    ctx.strokeStyle = rgba(C.cyan, 0.40);
    ctx.lineWidth = Math.max(1.15, 1.5 * s);
    ctx.beginPath();
    ctx.moveTo(x0 + c, y0 + b * 0.34);
    ctx.lineTo(x0 + c + b, y0 + b * 0.34);
    ctx.moveTo(x0 + w - c, y0 + h - b * 0.34);
    ctx.lineTo(x0 + w - c - b, y0 + h - b * 0.34);
    ctx.stroke();
  }

  /**
   * The oxygen dial: a 240 degree arc with the gap at the bottom, filled by the
   * remaining gas fraction, with seconds remaining as the numeral inside it.
   *
   * Seconds and not a percentage: at 80 m the same bar level buys a quarter of
   * the time (PLAYER.OXYGEN_DEPTH_FACTOR), so a fraction is a number that lies
   * about exactly the thing it is there to warn about.
   */
  _drawOxygenDial(ctx, cx, cy, u, level, blink, col) {
    const s = this.pixelScale;
    const R = u * 0.345;
    const start = PI * (150 / 180);
    const sweep = PI * (240 / 180);

    ctx.strokeStyle = rgba(C.cyanDim, 0.45);
    ctx.lineWidth = Math.max(1.15, u * 0.055);
    ctx.beginPath();
    ctx.arc(cx, cy, R, start, start + sweep);
    ctx.stroke();

    const frac = saturate(this.disp.oxygen);
    if (frac > 0.002) {
      ctx.strokeStyle = rgba(col, blink);
      ctx.lineWidth = Math.max(1.15, u * 0.062 * LEVEL_STROKE[level]);
      ctx.beginPath();
      ctx.arc(cx, cy, R, start, start + sweep * frac);
      ctx.stroke();
    }

    // Quarter ticks outside the arc, so a glance reads the fill against a scale
    // instead of against nothing.
    ctx.strokeStyle = rgba(C.cyanDim, 0.85);
    ctx.lineWidth = Math.max(1.15, 1.3 * s);
    ctx.beginPath();
    for (let i = 0; i <= 4; i++) {
      const a = start + sweep * i * 0.25;
      const r1 = R * (i % 2 === 0 ? 1.30 : 1.22);
      ctx.moveTo(cx + Math.cos(a) * R * 1.12, cy + Math.sin(a) * R * 1.12);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    }
    ctx.stroke();

    // Breath bloom: below PLAYER.OXYGEN_CRITICAL the dial acquires a pulse of
    // its own at 0.8 Hz - a resting breath rate the player feels rather than
    // reads. Three nested fills and not a stroked ring: a ring at this radius
    // crosses the numerals and reads as a scratch on the glass, where a bloom
    // that swells behind them reads as breathing.
    if (level === LEVEL_CRITICAL) {
      const pulse = 0.5 - 0.5 * Math.cos(this.time * TAU * 0.8);
      const rr = R * (0.52 + 0.34 * pulse);
      ctx.fillStyle = rgba(C.warn, 0.05 + 0.03 * (1 - pulse));
      for (let i = 3; i >= 1; i--) {
        ctx.beginPath();
        ctx.arc(cx, cy, rr * i / 3, 0, TAU);
        ctx.fill();
      }
    }

    // Quantity above, value, unit below. The three are spaced off the numeral's
    // half cap height rather than eyeballed, so growing the numerals under alarm
    // cannot push them into the labels.
    const seconds = Math.max(0, this.state.oxygenSeconds);
    const capHero = u * (level >= LEVEL_WARNING ? 0.285 : 0.25);
    const heroY = cy + u * 0.02;

    ctx.strokeStyle = rgba(C.textDim, 0.9);
    ctx.lineWidth = Math.max(1.15, 1.4 * s);
    drawText(ctx, 'O2', cx, heroY - capHero * 0.5 - u * 0.035, u * 0.075,
      { align: 'center', baseline: 'bottom' });

    ctx.strokeStyle = rgba(col, blink);
    ctx.lineWidth = Math.max(1.15, u * 0.030 * LEVEL_STROKE[level]);
    drawText(ctx, pad(seconds, seconds >= 100 ? 3 : 2), cx, heroY, capHero,
      { align: 'center', baseline: 'middle' });

    ctx.strokeStyle = rgba(C.textDim, 0.9);
    ctx.lineWidth = Math.max(1.15, 1.4 * s);
    drawText(ctx, 'SEC', cx, heroY + capHero * 0.5 + u * 0.030, u * 0.072,
      { align: 'center', baseline: 'top' });
  }

  /**
   * Centre reticle: a dot and four ticks, seventeen pixels across at 1080p.
   * It marks where the interaction and scan rays point, and that is all it is
   * allowed to do - every pixel it spends is spent on the part of the frame the
   * player is actually looking through.
   *
   * Stroked twice, an ink pass under a light one, because a single thin light
   * stroke vanishes against bright sand and a single dark one vanishes in the
   * deep. The pair survives both.
   */
  _drawReticle(ctx, r) {
    const s = this.pixelScale;
    const cx = r.x + r.w * 0.5;
    const cy = r.y + r.h * 0.5;
    const rad = Math.min(r.w, r.h) * 0.31;

    for (let p = 0; p < 2; p++) {
      ctx.strokeStyle = p === 0 ? rgba(C.ink, 0.5) : rgba(C.text, 0.85);
      ctx.lineWidth = Math.max(1.15, (p === 0 ? 3.4 : 1.5) * s);
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const a = i * PI * 0.5;
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        ctx.moveTo(cx + dx * rad * 0.52, cy + dy * rad * 0.52);
        ctx.lineTo(cx + dx * rad, cy + dy * rad);
      }
      ctx.stroke();
    }

    const dot = Math.max(1.8, 2.2 * s);
    ctx.fillStyle = rgba(C.ink, 0.5);
    ctx.fillRect(cx - dot, cy - dot, dot * 2, dot * 2);
    ctx.fillStyle = rgba(C.text, 1);
    ctx.fillRect(cx - dot * 0.5, cy - dot * 0.5, dot, dot);
  }

  /**
   * The showcase scene title: the biome/area name, top-centre, with a hairline
   * rule under it. Driven by demo/director.js through `demoTitle` /
   * `demoTitleAlpha`; a no-op (and a zero-cost region, see its key) otherwise.
   *
   * Stroked ink-under-light like the reticle, because the card sits over sky
   * in one segment and over black water in the next. The glyph set is
   * uppercase-only, so the director uppercases what the route authors.
   */
  _drawDemoTitle(ctx, r) {
    const a = this.demoTitleAlpha;
    const text = this.demoTitle;
    if (!text || a <= 0.01) return;
    const s = this.pixelScale;
    // Fit the cap height to the region: never wider than 92% of it, so a long
    // name (THE GEODE CHAMBER) shrinks instead of clipping.
    let cap = r.h * 0.52;
    const w = textWidth(text, cap);
    if (w > r.w * 0.92) cap *= (r.w * 0.92) / w;
    const cx = r.x + r.w * 0.5;
    const cy = r.y + r.h * 0.42;

    ctx.globalAlpha = a;
    for (let p = 0; p < 2; p++) {
      ctx.strokeStyle = p === 0 ? rgba(C.ink, 0.55) : rgba(C.text, 0.92);
      ctx.lineWidth = Math.max(1.15, (p === 0 ? 4.0 : 1.8) * s);
      drawText(ctx, text, cx, cy, cap, { align: 'center', baseline: 'middle' });
    }
    const rule = textWidth(text, cap) * 0.5 + cap * 0.4;
    const ry = cy + cap * 0.95;
    ctx.strokeStyle = rgba(C.cyanDim, 0.7);
    ctx.lineWidth = Math.max(1.15, 1.2 * s);
    ctx.beginPath();
    ctx.moveTo(cx - rule, ry);
    ctx.lineTo(cx + rule, ry);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /**
   * The showcase attribution credit, bottom-right. Driven by demo/director.js
   * through `demoCredit` / `demoCreditAlpha`; a no-op, and a zero-cost region,
   * whenever the showcase is not running.
   *
   * Stroked ink-under-light like the title card and the reticle, because the
   * opening ten seconds of the route run over a dawn sky and the credit has to
   * survive being drawn over bright cloud as well as over dark water.
   *
   * Deliberately lighter than the title card - thinner light pass, no rule
   * under it - so it reads as a corner credit rather than as a second
   * headline competing with the scene name.
   */
  _drawDemoCredit(ctx, r) {
    const a = this.demoCreditAlpha;
    const text = this.demoCredit;
    if (!text || a <= 0.01) return;
    const s = this.pixelScale;
    // Shrink rather than clip if a longer credit than the box was authored
    // for is ever set: CREDIT_MAX_CHARS sizes the rect, this keeps the promise.
    let cap = CREDIT_CAP * this.height;
    const w = textWidth(text, cap);
    if (w > r.w) cap *= r.w / w;
    // Right edge and baseline of the box, so the label hangs off the corner
    // whatever its length.
    const x = r.x + r.w;
    const y = r.y + r.h - cap * 0.6;

    ctx.globalAlpha = a;
    for (let p = 0; p < 2; p++) {
      ctx.strokeStyle = p === 0 ? rgba(C.ink, 0.62) : rgba(C.text, 0.95);
      // WEIGHT IS A FRACTION OF CAP, NOT A PIXEL COUNT TIMES pixelScale. Every
      // instrument in this file sizes its strokes as `k * s` because they are
      // all drawn near one cap height, where the two are interchangeable. This
      // label is not: tripling CREDIT_CAP left a `k * s` weight at its old
      // thickness and the letters went from 8% of cap to 2.7% - the same ink
      // stretched over three times the height, which is exactly what "so thin
      // it is hard to see" looks like. Written against cap, weight tracks any
      // future size change for free.
      ctx.lineWidth = Math.max(1.15, cap * (p === 0 ? CREDIT_INK_WEIGHT : CREDIT_WEIGHT));
      drawText(ctx, text, x, y, cap, { align: 'right', baseline: 'bottom' });
    }
    ctx.globalAlpha = 1;
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  /**
   * Cold-boot reveal. Instruments come up staggered over BOOT_DURATION so the
   * cockpit feels like it is powering on rather than being pasted in.
   * @param {number} delay 0..1 fraction of the sequence before this element lights
   */
  _bootAlpha(delay) {
    if (this.bootTime >= BOOT_DURATION) return 1;
    const t = this.bootTime / BOOT_DURATION;
    return saturate((t - delay) / Math.max(0.05, 0.35 * (1 - delay)));
  }

  /** Map a 0..1 "healthy is high" quantity onto the escalation ramp. */
  _rampLevel(v, advisory, caution, warning, critical) {
    const x = num(v, 1);
    if (x <= critical) return LEVEL_CRITICAL;
    if (x <= warning) return LEVEL_WARNING;
    if (x <= caution) return LEVEL_CAUTION;
    if (x <= advisory) return LEVEL_ADVISORY;
    return LEVEL_NOMINAL;
  }

  _depthLevel() {
    const ratio = this.state.depth / Math.max(1, this.state.depthRating);
    if (ratio > 1.2) return LEVEL_CRITICAL;
    if (ratio > 1.0) return LEVEL_WARNING;
    if (ratio > VESSEL.CREAK_THRESHOLD) return LEVEL_CAUTION;
    if (ratio > 0.6) return LEVEL_ADVISORY;
    return LEVEL_NOMINAL;
  }

  /** Worst escalation level currently displayed in the systems stack. */
  _systemsLevel() {
    let worst = LEVEL_NOMINAL;
    for (const row of SYSTEM_ROWS) {
      const level = this._rampLevel(this.disp[row.field], row.t[0], row.t[1], row.t[2], row.t[3]);
      if (level > worst) worst = level;
    }
    return worst;
  }

  /**
   * Escalation level of the free-swim oxygen gauge, in SECONDS remaining and
   * never a fraction - a full-looking bar at 80 m is a quarter of the time it
   * is at the surface.
   *
   * The two thresholds are PLAYER.OXYGEN_WARN and PLAYER.OXYGEN_CRITICAL, and
   * they are what the whole escalation hangs off: at WARN the dial goes amber
   * (OXYGEN_COLOR) and pulses at 1.20 Hz, at CRITICAL it goes red and pulses at
   * 2.40 Hz with the breath ring underneath. The CAUTION step above them is a
   * silent colour change only, so the first pulse the player ever sees is the
   * one that means something.
   */
  _oxygenLevel() {
    const seconds = this.state.oxygenSeconds;
    if (seconds < PLAYER.OXYGEN_CRITICAL) return LEVEL_CRITICAL;
    if (seconds < PLAYER.OXYGEN_WARN) return LEVEL_WARNING;
    if (seconds < PLAYER.OXYGEN_WARN * 2) return LEVEL_CAUTION;
    return LEVEL_NOMINAL;
  }

  /** Cold-boot progress 0..1, for the composite pass's projector-strike wipe. */
  get bootFraction() {
    return saturate(this.bootTime / BOOT_DURATION);
  }

  /** Depth band name, for the post-chain grade and the debug overlay. */
  get depthBandName() {
    return DEPTH_BANDS[depthBandIndex(this.state.depth)].name;
  }
}

export { blinkAlpha, rgba, GLYPHS };
