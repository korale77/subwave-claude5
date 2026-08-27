#!/usr/bin/env node
/**
 * Capture harness for the automated showcase demo (src/demo/director.js).
 *
 * Boots the game in headless Chrome through tools/lib/browser.mjs (the ONE
 * launcher - the leak/teardown/reaper contract comes from there), presses the
 * REAL demo key through CDP's input pipeline, then rides along: at each
 * segment's authored beat time (script.js `beats`) it captures a labeled PNG
 * into demo-output/<name>/NN-<segment>-<beat>.png.
 *
 * Two runs of this tool are two diffable frame sets, and the numbers to diff
 * are printed beside the pixels: per-frame mean/median luminance, hue entropy
 * and dark mass via tools/lib/frame-metrics.mjs - the same kernel the variety
 * tour uses, so a demo frame and a tour frame can never disagree about what a
 * hue bin is. FAUNA FRAMES VARY RUN TO RUN by design (script.js states it);
 * the director's own notes say which watchFauna beats tracked an animal and
 * which fell back to the pan, and this tool prints them.
 *
 *   node tools/demo-capture.mjs --name runA
 *   node tools/demo-capture.mjs --name runB   # then diff the two tables
 *
 * TWO DEBUG FLAGS, AND THE SECOND ONE IS AN INSTRUMENT GAP RATHER THAN A
 * CONVENIENCE:
 *
 *   --only <ids>     comma-separated segment ids. Enters the route through
 *                    window.subwave.demo.start(i) - the same public surface
 *                    tools/test-parity.mjs uses - instead of the real KeyG,
 *                    and leaves as soon as the last named segment is done.
 *                    A full ride is ~6.5 minutes, which is not a loop anyone
 *                    iterates a single scene in. The default path still
 *                    presses the real key, and only that path can assert the
 *                    Shift test in main.js (see below), so --only skips that
 *                    assertion knowingly.
 *   --interval <s>   capture an extra frame every <s> seconds on top of the
 *                    beats, named NN-<segment>-t<elapsed>.png.
 *                    ONE FRAME PER BEAT CANNOT SEE MOTION. Four of the six
 *                    notes in the 2026-08-21 review - a walk overshooting into
 *                    the hull, a gaze spinning, a corridor transit with
 *                    nothing in it, half a second of the player's own vessel -
 *                    all happen BETWEEN beats and are invisible to the beat
 *                    list that photographs the scenes around them.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './lib/browser.mjs';
import { decodePNG } from './lib/png.mjs';
import { frameMetrics } from './lib/frame-metrics.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const args = process.argv.slice(2);
const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const NAME = flag('--name') || `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const OUT = join(ROOT, 'demo-output', NAME);
/** Hard wall-clock cap on the whole ride, seconds. The route's authored
 *  timeouts sum well under this; the cap is the harness's own never-stall. */
const DEADLINE_S = Number(flag('--deadline') || 600);
/** Segment ids to ride, or null for the whole route. */
const ONLY = flag('--only') ? flag('--only').split(',').map((x) => x.trim()).filter(Boolean) : null;
/** Extra capture cadence in seconds, or 0 for beats only. */
const INTERVAL_S = Number(flag('--interval') || 0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------
// Minimal CDP-over-WebSocket client, same as tools/shot.mjs (we ship no deps).
// --------------------------------------------------------------------------

class Sock {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname; this.port = +u.port; this.path = u.pathname + u.search;
    this.buf = Buffer.alloc(0); this.pending = new Map(); this.id = 1; this.onEvent = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = createHash('sha1').update(String(Math.random())).digest('base64');
      this.s = connect(this.port, this.host, () => {
        this.s.write(`GET ${this.path} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n');
      });
      this.s.on('error', reject);
      let up = false;
      this.s.on('data', (c) => {
        if (!up) {
          const i = c.indexOf('\r\n\r\n');
          if (i < 0) return;
          up = true;
          const rest = c.subarray(i + 4);
          if (rest.length) this._feed(rest);
          resolve();
          return;
        }
        this._feed(c);
      });
    });
  }

  _feed(c) {
    this.buf = Buffer.concat([this.buf, c]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const op = b[0] & 0x0f;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (b.length < off + len) return;
      const payload = b.subarray(off, off + len);
      this.buf = b.subarray(off + len);
      if (op !== 1) continue;
      try {
        const m = JSON.parse(payload.toString('utf8'));
        if (m.id != null && this.pending.has(m.id)) {
          const { resolve, reject } = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        } else if (this.onEvent) this.onEvent(m);
      } catch { /* ignore */ }
    }
  }

  send(method, params = {}) {
    const id = this.id++;
    const data = Buffer.from(JSON.stringify({ id, method, params }), 'utf8');
    const n = data.length;
    let h;
    if (n < 126) { h = Buffer.alloc(6); h[0] = 0x81; h[1] = 0x80 | n; }
    else if (n < 65536) { h = Buffer.alloc(8); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(n, 2); }
    else { h = Buffer.alloc(14); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(n), 2); }
    this.s.write(Buffer.concat([h, data]));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); }
      }, 90000);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result?.value;
  }

  close() { try { this.s?.end(); } catch { /* ignore */ } }
}

/** Press and release the demo key through the browser's REAL input pipeline -
 *  the same class of event tools/test-input.mjs proves the game hears. */
async function pressDemoKey(sock) {
  for (const type of ['keyDown', 'keyUp']) {
    await sock.send('Input.dispatchKeyEvent', {
      type, code: 'KeyG', key: 'g',
      windowsVirtualKeyCode: 71, nativeVirtualKeyCode: 71,
    });
  }
}

// --------------------------------------------------------------------------

// REFUSE to overwrite a named run without --force, the test-variety rule:
// two runs interleaved into one directory are a frame set no report
// describes. Default timestamped names never collide.
if (process.argv.includes('--name') && !process.argv.includes('--force') && existsSync(OUT)) {
  console.error(`demo-output/${NAME}/ already exists. To replace it on purpose: --name ${NAME} --force`);
  process.exit(1);
}
await mkdir(OUT, { recursive: true });

const { cdpPort, cleanup } = await launchBrowser({
  tag: 'demo', root: ROOT, windowSize: '1600,900',
});
await sleep(1500);

const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
const sock = new Sock(page.webSocketDebuggerUrl);
await sock.connect();
await sock.send('Runtime.enable');

const consoleErrors = [];
sock.onEvent = (m) => {
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  }
};

// ---- boot ------------------------------------------------------------------
{
  const deadline = Date.now() + 120000;
  let ready = false;
  while (Date.now() < deadline) {
    await sleep(1000);
    const s = await sock.eval(`(() => {
      const f = document.getElementById('fatal');
      if (f && f.classList.contains('show')) return { fatal: document.getElementById('fatal-detail')?.textContent };
      return { ready: !!(window.subwave && window.subwave.running) };
    })()`).catch(() => ({}));
    if (s?.fatal) { console.error('BOOT FAILED:\n' + s.fatal); cleanup(); process.exit(1); }
    if (s?.ready) { ready = true; break; }
  }
  if (!ready) { console.error('boot timed out'); cleanup(); process.exit(1); }
}

// Splash down, loop running - the same two lines shot.mjs uses.
await sock.eval(`(() => {
  document.getElementById('boot')?.classList.add('hidden');
  window.subwave.start();
})()`);
await sleep(2000);

// ---- the shot list comes from the route itself -----------------------------
const plan = await sock.eval(
  `(async () => (await import('/src/demo/script.js')).SEGMENTS.map(
      (s) => ({ id: s.id, timeout: s.timeout, beats: s.beats || [] })))()`);
const totalBeats = plan.reduce((a, s) => a + s.beats.length, 0);

// --only resolves to an index WINDOW, because the director runs the route in
// order: enter at the lowest named segment and stop after the highest. Any
// segment between two named ones is ridden through (and captured, so the
// frames say it happened) rather than skipped.
let firstIndex = 0;
let lastIndex_ = plan.length - 1;
const wanted = new Set(ONLY || plan.map((s) => s.id));
if (ONLY) {
  const idx = ONLY.map((id) => plan.findIndex((s) => s.id === id));
  const bad = ONLY.filter((id, i) => idx[i] < 0);
  if (bad.length) {
    console.error(`unknown segment id(s): ${bad.join(', ')}\nroute: ${plan.map((s) => s.id).join(', ')}`);
    cleanup(); process.exit(1);
  }
  firstIndex = Math.min(...idx);
  lastIndex_ = Math.max(...idx);
  for (let i = firstIndex; i <= lastIndex_; i++) wanted.add(plan[i].id);
}
const plannedBeats = plan.slice(firstIndex, lastIndex_ + 1)
  .reduce((a, s) => a + s.beats.length, 0);
console.log(`demo route: ${plan.length} segments, ${totalBeats} beats -> ${OUT}`);
if (ONLY) {
  console.log(`  --only: riding ${firstIndex}..${lastIndex_} ` +
    `(${plan.slice(firstIndex, lastIndex_ + 1).map((s) => s.id).join(', ')}), ${plannedBeats} beats`);
}
if (INTERVAL_S > 0) console.log(`  --interval: an extra frame every ${INTERVAL_S} s`);

// ---- press the key (or jump straight in) and ride --------------------------
if (ONLY) {
  await sock.eval(`window.subwave.demo.start(${firstIndex})`);
} else {
  await pressDemoKey(sock);
}
await sleep(300);
{
  const st = await sock.eval('window.subwave.demo?.state ?? null');
  if (!st?.active) {
    console.error(ONLY ? 'demo did not start' : 'demo did not start on the key press');
    cleanup(); process.exit(1);
  }
  // Video recording is Shift+G and this harness presses an UNMODIFIED KeyG
  // (pressDemoKey sends no modifiers), so a recording here would mean the
  // modifier test in main.js has come loose - and it would write a video into a
  // headless profile that is deleted on cleanup, i.e. silently burn the disk
  // and the encode time of every capture run. --only never presses the key, so
  // it cannot make this assertion and does not pretend to.
  if (!ONLY && st.recording) { console.error('demo started RECORDING on a plain KeyG'); cleanup(); process.exit(1); }
}

/**
 * THE POSE THE FRAME WAS TAKEN FROM, sampled beside every screenshot.
 *
 * "The camera just looks down at the ground" is a note about an ANGLE, and
 * until this was here the run's own account of itself could not carry one: the
 * frame metrics measure colour, and a floor-ward frame and a canopy-ward one
 * can share every one of them. The pitch is read off the CAMERA (the vessel's
 * cockpit eye is rigidly attached to the hull, so a piloted frame's pitch is
 * the hull's), and the depth beside it is what says whether an ascent arrived.
 */
const POSE_EXPR = `(() => {
  const g = window.subwave, c = g.renderer.camera, f = c.forward;
  return {
    pitchDeg: Math.atan2(f[1], Math.hypot(f[0], f[2])) * 180 / Math.PI,
    headingDeg: (Math.atan2(f[0], -f[2]) * 180 / Math.PI + 360) % 360,
    depth: Math.max(0, -c.position[1]),
    inVessel: !!g.player.inVessel,
  };
})()`;

const captured = [];           // { file, segment, beat, plannedAt, actualAt, pose }
const segTimes = new Map();    // id -> { enter (demo total s), leave }
let sawActive = false;
let lastIndex = -1;
let frameNo = 0;
const t0 = Date.now();

while (Date.now() - t0 < DEADLINE_S * 1000) {
  const st = await sock.eval('window.subwave.demo?.state ?? null').catch(() => null);
  if (!st) break;
  if (st.active) sawActive = true;
  if (sawActive && !st.active) break;            // finished (or aborted - reported below)

  if (st.index !== lastIndex && st.index >= 0 && st.index < plan.length) {
    lastIndex = st.index;
    const seg = plan[st.index];
    segTimes.set(seg.id, { enter: st.total, leave: null });
    for (const [id, t] of segTimes) if (id !== seg.id && t.leave == null) t.leave = st.total;
  }

  if (st.index > lastIndex_) break;              // --only window is done

  if (st.segment && st.index >= 0 && st.index < plan.length && wanted.has(plan[st.index].id)) {
    const seg = plan[st.index];
    const shoot = async (key, beat, plannedAt) => {
      if (captured.some((c) => c.key === key)) return;
      const png = await sock.send('Page.captureScreenshot', { format: 'png' });
      const file = `${String(frameNo++).padStart(2, '0')}-${seg.id}-${beat}.png`;
      await writeFile(join(OUT, file), Buffer.from(png.data, 'base64'));
      const pose = await sock.eval(POSE_EXPR).catch(() => null);
      captured.push({ key, file, segment: seg.id, beat, plannedAt, actualAt: st.elapsed,
        ...(pose || {}) });
      console.log(`  ${file}  (planned t+${plannedAt}s, captured t+${st.elapsed.toFixed(1)}s` +
        (pose ? `, pitch ${pose.pitchDeg.toFixed(0)} deg, depth ${pose.depth.toFixed(0)} m)` : ')'));
    };
    for (const b of seg.beats) {
      if (st.elapsed >= b.at) await shoot(`${seg.id}/${b.name}`, b.name, b.at);
    }
    if (INTERVAL_S > 0) {
      const tick = Math.floor(st.elapsed / INTERVAL_S) * INTERVAL_S;
      if (tick > 0) await shoot(`${seg.id}/t${tick}`, `t${tick.toFixed(0)}`, tick);
    }
  }
  await sleep(120);
}

// --only leaves the demo running past its window; stop it so the teardown and
// the state restore are the ordinary ones rather than a killed browser.
if (ONLY) await sock.eval("window.subwave.demo?.stop?.('capture --only window done')").catch(() => {});

// ---- the run's own account of itself ----------------------------------------
const finalState = await sock.eval('window.subwave.demo?.state ?? null').catch(() => null);
const notes = finalState?.notes || [];
const totalRuntime = finalState?.total ?? (Date.now() - t0) / 1000;
for (const [, t] of segTimes) if (t.leave == null) t.leave = totalRuntime;

sock.close();
cleanup();

// ---- metrics beside the pixels ----------------------------------------------
console.log(`\n== ${NAME}: ${captured.length} frames (${plannedBeats} beats planned), ` +
  `demo runtime ${totalRuntime.toFixed(1)} s ==`);
console.log('\nper-segment times (demo-clock seconds):');
for (const seg of plan) {
  const t = segTimes.get(seg.id);
  if (!t) {
    if (wanted.has(seg.id)) console.log(`  ${seg.id.padEnd(14)} NEVER ENTERED`);
    continue;
  }
  console.log(`  ${seg.id.padEnd(14)} ${t.enter.toFixed(1).padStart(6)} -> ${t.leave.toFixed(1).padStart(6)}  (${(t.leave - t.enter).toFixed(1)} s, cap ${seg.timeout})`);
}

console.log('\nframe                                    meanL   medL   hueEnt  darkM   flat  pitch  depth');
const report = [];
for (const c of captured) {
  const bytes = await import('node:fs/promises').then((fs) => fs.readFile(join(OUT, c.file)));
  const m = frameMetrics(decodePNG(bytes));
  report.push({ ...c, meanL: m.meanL, medianL: m.medianL, hueEntropyBits: m.hueEntropyBits,
    darkMass: m.darkMass, flatFraction: m.flatFraction });
  console.log(`  ${c.file.padEnd(38)} ${m.meanL.toFixed(4)}  ${m.medianL.toFixed(4)} ` +
    ` ${m.hueEntropyBits.toFixed(3)}   ${m.darkMass.toFixed(3)}   ${m.flatFraction.toFixed(3)}` +
    (c.pitchDeg == null ? '' :
      `  ${c.pitchDeg.toFixed(0).padStart(4)}  ${c.depth.toFixed(0).padStart(5)}`));
}

if (notes.length) {
  console.log('\ndirector notes:');
  for (const n of notes) console.log(`  ${n}`);
}
if (consoleErrors.length) {
  console.log('\nconsole errors:');
  for (const e of consoleErrors) console.log(`  ${e}`);
}

await writeFile(join(OUT, 'report.json'), JSON.stringify({
  name: NAME, runtime: totalRuntime,
  segments: [...segTimes].map(([id, t]) => ({ id, enter: t.enter, leave: t.leave })),
  frames: report.map(({ key, ...r }) => r),
  notes, consoleErrors,
}, null, 2));
console.log(`\nreport -> ${join(OUT, 'report.json')}`);
process.exit(consoleErrors.length ? 1 : 0);
