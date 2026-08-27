#!/usr/bin/env node
/**
 * Demo/free-play PARITY harness, minimum viable.
 *
 * The real-demo contract says the walkthrough is a camera operator over the
 * ordinary game: with presentation overlays quiet, the scene the demo
 * photographs and the scene free play delivers from the same state must be
 * the same render. This tool measures that, per segment:
 *
 *   ARM A (demo): start the showcase AT the segment (subwave.demo.start(i),
 *     the director's own authoring entry), ride to a designated beat chosen
 *     PAST the title card's envelope, ASSERT the overlays are quiet
 *     (renderer.demoFade === 0 and hud.demoTitleAlpha === 0 - asserted, not
 *     forced: mid-segment they rest at zero by construction, and forcing them
 *     would hide a regression), snapshot the player pose and world state,
 *     pause the sim (rendering continues, so TAA and exposure settle on a
 *     frozen scene), settle 60 rAF, capture.
 *   ARM B (free play, same page, same seed): stop the demo with a REAL
 *     Escape, restore the snapshot through the sanctioned public surface -
 *     worldClock.setDayFraction, jumpTo with the captured pose, lampOn as
 *     the player's own hand would have it - let streaming settle, pause,
 *     settle the same 60 rAF, capture.
 *
 * HARD GATES (exit 1) - the numeric detectors for the class of bug the
 * water-column pin was:
 *   - water classification id equal between arms;
 *   - per-channel |delta|/max on the sprung sigmaT and Kd under 2%;
 *   - |delta meanL| / meanL under 10%.
 * SOFT GATE (warn only): hue x sat histogram cosine under 0.985. Fauna are
 * honestly nondeterministic between arms (pausing freezes each arm's own
 * animals, it cannot make the two arms' animals match) and the wave/sway
 * phase differs at equal dayFraction, so the cosine is advisory in v1; the
 * PNG pair is written side by side for the human read this project requires.
 *
 * v1 scope - three ON-FOOT segments (a piloted pose cannot be reproduced
 * through jumpTo yet; a segment found piloted at its beat is SKIPPED with a
 * warning): dive-coral (the pin regression this harness exists for),
 * kelp-dwell (the other water-sensitive shallow biome), ossuary (lamp-on
 * dark seabed - also exercises the action-routed lamp; it replaced cave-mouth
 * when the 2026-08-19 director's cut removed that segment). The habitat
 * interior is deliberately out (no jumpTo reaches it; the pod's free-play
 * presence is test-creatures section 21's job). jelly-hollow is out for the
 * cave-chamber reason: a raw coordinate jump into an unstreamed cave
 * photographs open water and the comparison would go green on two wrong
 * frames - the CLAUDE.md cave trap.
 *
 * CALIBRATE BEFORE TRUSTING: run twice (--name a / --name b) and compare the
 * two ARM A rows per segment across runs - that spread bounds what the
 * tolerances can honestly claim, the test-variety self-cosine discipline.
 *
 *   node tools/test-parity.mjs --name t1
 *   node tools/test-parity.mjs --name t1b --only dive-coral
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './lib/browser.mjs';
import { decodePNG } from './lib/png.mjs';
import { frameMetrics, cosineSimilarity } from './lib/frame-metrics.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const args = process.argv.slice(2);
const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const NAME = flag('--name') || `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const ONLY = flag('--only') ? flag('--only').split(',') : null;
const OUT = join(ROOT, 'parity-output', NAME);

/** The parity targets: segment id and the demo-clock beat second to pause at.
 *  Every `at` must be past the title envelope (~5.2 s of TITLE_IN+HOLD+OUT)
 *  AND at least ~3 s before the segment's measured end - the overlay wait
 *  runs unpaused, and the first run of this tool proved a beat 1 s from the
 *  end captures the NEXT segment's title over the wrong scene.
 *
 *  `startIndex` rides the demo from an EARLIER segment when the target
 *  depends on carried state: demo.start(2) put a fresh on-foot player
 *  through dive-coral's piloted cut - no vessel, flyTo skipped, and the
 *  "demo arm" swam kelp water from the splash point. dive-coral is only
 *  dive-coral after beach-dawn and board-climb have run. */
const TARGETS = [
  // 38, NOT 21. The 2026-08-21 recut made the dive one continuous take from
  // the air, so the player is still PILOTED at t+21 and this target became a
  // permanent SKIP - a target that can never run is not a gate. The swim
  // begins near t+31 and the segment measured 48.0 s in the cut11 capture, so
  // 38 is past the title envelope, on foot, and 10 s clear of the end.
  { id: 'dive-coral', at: 38, startIndex: 0,
    why: 'the pin regression; Reef/Kelp boundary water' },
  { id: 'kelp-dwell', at: 10, why: 'the other water-sensitive shallow biome' },
  // Was cave-mouth until the 2026-08-19 director's cut removed that segment;
  // the ossuary is the route's remaining lamp-on dark-seabed scene and its
  // 'skull' cut is the same reproducible jumpTo form. Beat 8 sits past the
  // ~5.2 s title envelope and ~4 s before the segment's measured ~12.7 s end.
  { id: 'ossuary', at: 8, why: 'lamp-on dark seabed; exercises the action-routed lamp' },
];

/** Hard-gate tolerances. meanL 10% covers exposure settling and fauna in one
 *  arm; the water-column gates are near-exact because the column is the same
 *  deterministic classifier in both arms. */
const SIGMA_TOL = 0.02;
const MEANL_TOL = 0.10;
const COSINE_SOFT = 0.985;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------
// Minimal CDP-over-WebSocket client, same as tools/demo-capture.mjs.
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

/** A real Escape through the browser's input pipeline - the demo's own abort. */
async function pressEscape(sock) {
  for (const type of ['keyDown', 'keyUp']) {
    await sock.send('Input.dispatchKeyEvent', {
      type, code: 'Escape', key: 'Escape',
      windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    });
  }
}

/** Render-settle: N animation frames with the sim paused. Each eval is short
 *  (the probe.mjs 90 s CDP-deadline trap), so settle in one bounded await. */
const SETTLE_60 = `(() => new Promise((res) => {
  let n = 0;
  const f = () => { if (++n >= 60) res(true); else requestAnimationFrame(f); };
  requestAnimationFrame(f);
}))()`;

const STATE_EXPR = `(() => {
  const g = window.subwave, p = g.player, w = g._waterColumn, t = g._waterTypeHeld;
  return {
    x: p.position[0], y: p.position[1], z: p.position[2],
    yaw: p.yaw, pitch: p.pitch, lampOn: p.lampOn, inVessel: p.inVessel,
    dayFraction: g.worldClock.dayFraction,
    demoFade: g.renderer.demoFade, titleAlpha: g.hud?.demoTitleAlpha ?? 0,
    creditAlpha: g.hud?.demoCreditAlpha ?? 0,
    water: { id: w.id, name: w.name,
      sigmaT: Array.from(w.sigmaT), Kd: Array.from(w.Kd) },
    target: t ? { sigmaT: Array.from(t.sigmaT), Kd: Array.from(t.Kd) } : null,
  };
})()`;

async function captureTo(sock, file) {
  const png = await sock.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(OUT, file), Buffer.from(png.data, 'base64'));
}

// --------------------------------------------------------------------------

if (process.argv.includes('--name') && !process.argv.includes('--force') && existsSync(OUT)) {
  console.error(`parity-output/${NAME}/ already exists. To replace it on purpose: --name ${NAME} --force`);
  process.exit(1);
}
await mkdir(OUT, { recursive: true });

const { cdpPort, cleanup } = await launchBrowser({
  tag: 'parity', root: ROOT, windowSize: '1600,900',
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

// ---- boot (identical to demo-capture) --------------------------------------
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
await sock.eval(`(() => {
  document.getElementById('boot')?.classList.add('hidden');
  window.subwave.start();
})()`);
await sleep(2000);

const segIndex = await sock.eval(
  `(async () => (await import('/src/demo/script.js')).SEGMENTS.map((s) => s.id))()`);

const rows = [];
let hardFails = 0;

// A TARGET MUST NOT LEAVE THE PLAYER IN THE VESSEL FOR THE NEXT ONE. Measured:
// with dive-coral skipping (piloted), the Escape that ended it left the player
// flying, kelp-dwell's cut then jumped the HULL to the kelp anchor, every
// swimTo in it logged 'while piloted - skipped', the segment ran out in under a
// second and the tool reported "never reached t+10s" as a HARD FAILURE. The
// same two segments pass individually. Clearing the seat between targets is
// what makes the list order-independent.
const dismount = async (sock) => {
  if (!(await sock.eval('!!window.subwave.player.inVessel').catch(() => false))) return;
  // The REAL key, like every other input this tool sends: KeyF is
  // ACTION.DISEMBARK (core/input.js), and Vessel._readInput turns it into the
  // same disembarkRequested latch a player sets.
  for (const type of ['keyDown', 'keyUp']) {
    await sock.send('Input.dispatchKeyEvent', {
      type, code: 'KeyF', key: 'f',
      windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70,
    });
  }
  await sleep(500);
  if (await sock.eval('!!window.subwave.player.inVessel').catch(() => false)) {
    console.error('  could not dismount between targets - later targets may be invalid');
  }
};

for (const target of TARGETS) {
  await dismount(sock);
  if (ONLY && !ONLY.includes(target.id)) continue;
  const idx = segIndex.indexOf(target.id);
  if (idx < 0) { console.error(`segment '${target.id}' is not in the route`); hardFails++; continue; }
  console.log(`\n== ${target.id} @ t+${target.at}s  (${target.why}) ==`);

  // ---- ARM A: the demo -----------------------------------------------------
  await sock.eval('window.subwave.setPaused(false)');
  await sock.eval(`window.subwave.demo.start(${target.startIndex ?? idx})`);
  await sleep(200);
  {
    const st = await sock.eval('window.subwave.demo?.state ?? null');
    if (!st?.active) { console.error('  demo did not start'); hardFails++; continue; }
  }
  // Ride to the beat (possibly through earlier segments, see startIndex).
  // A run that advances PAST the target (a timeout skipped it) is a fault
  // worth reporting, not silently re-waiting.
  let atBeat = false;
  const rideEnd = Date.now() + 240000;
  while (Date.now() < rideEnd) {
    const st = await sock.eval('window.subwave.demo?.state ?? null').catch(() => null);
    if (!st?.active || st.index > idx) break;
    if (st.index === idx && st.elapsed >= target.at) { atBeat = true; break; }
    await sleep(100);
  }
  if (!atBeat) {
    console.error(`  never reached t+${target.at}s inside '${target.id}'`);
    hardFails++;
    await pressEscape(sock);
    await sleep(400);
    continue;
  }
  // Overlays must be QUIET at a mid-segment beat - asserted, never forced,
  // and BOUNDED: this wait runs unpaused, so a long poll can cross the
  // segment boundary and photograph the next segment's title (measured on
  // this tool's own first run). One second, then the index re-verify below
  // catches any boundary crossing.
  //
  // The attribution credit is in here too. A mid-route start(i) never arms it
  // (director.js gates it on entering at segment 0), so it rests at 0 by
  // construction on every arm this tool runs - which is exactly why it is
  // worth asserting: if a future change arms it more widely, two of these
  // targets pause inside its ten-second envelope and the difference would
  // otherwise land silently in arm A's pixels.
  let overlay = { f: -1, a: -1, c: -1 };
  for (let k = 0; k < 10; k++) {
    overlay = await sock.eval(
      '({ f: window.subwave.renderer.demoFade, a: window.subwave.hud?.demoTitleAlpha ?? 0,'
      + ' c: window.subwave.hud?.demoCreditAlpha ?? 0 })');
    if (overlay.f === 0 && overlay.a === 0 && overlay.c === 0) break;
    await sleep(100);
  }
  // Freeze, then verify the frozen state is STILL the target segment - the
  // pause stops the demo clock, so everything after this line is stable.
  await sock.eval('window.subwave.setPaused(true)');
  const frozen = await sock.eval('window.subwave.demo?.state ?? null');
  if (!frozen?.active || frozen.index !== idx) {
    console.error(`  segment advanced before the pause (now index ${frozen?.index}); ` +
      `move the beat earlier than t+${target.at}s`);
    hardFails++;
    await sock.eval('window.subwave.setPaused(false)');
    await pressEscape(sock);
    await sleep(400);
    continue;
  }
  if (overlay.f !== 0 || overlay.a !== 0 || overlay.c !== 0) {
    console.error(`  overlays not quiet at the beat (fade ${overlay.f}, `
      + `title ${overlay.a}, credit ${overlay.c})`);
    hardFails++;
  }
  const A = await sock.eval(STATE_EXPR);
  if (A.inVessel) {
    console.log('  SKIPPED: player is piloted at this beat; v1 reproduces on-foot poses only');
    await sock.eval('window.subwave.setPaused(false)');
    await pressEscape(sock);
    await sleep(400);
    continue;
  }
  await sock.eval(SETTLE_60);
  const fileA = `${target.id}-demo.png`;
  await captureTo(sock, fileA);
  await sock.eval('window.subwave.setPaused(false)');
  await pressEscape(sock);
  await sleep(600);
  {
    const st = await sock.eval('window.subwave.demo?.state ?? null').catch(() => null);
    if (st?.active) { console.error('  demo did not stop on Escape'); hardFails++; continue; }
  }

  // ---- ARM B: free play, same state ---------------------------------------
  // The sanctioned public surface only: the world clock, the jump mechanism
  // (which snaps the water column at the arrival, an ordinary game state),
  // and the lamp as the player's own hand would set it.
  await sock.eval(`(() => {
    const g = window.subwave;
    g.worldClock.setDayFraction(${A.dayFraction});
    g.jumpTo({ x: ${A.x}, y: ${A.y}, z: ${A.z} }, { yaw: ${A.yaw}, pitch: ${A.pitch}, label: 'parity' });
    g.player.lampOn = ${A.lampOn};
  })()`);
  await sleep(2500);                      // streaming settle (terrain, scatter, caves)
  await sock.eval('window.subwave.setPaused(true)');
  await sock.eval(SETTLE_60);
  const B = await sock.eval(STATE_EXPR);
  const fileB = `${target.id}-free.png`;
  await captureTo(sock, fileB);
  await sock.eval('window.subwave.setPaused(false)');

  // ---- compare -------------------------------------------------------------
  const mA = frameMetrics(decodePNG(await readFile(join(OUT, fileA))));
  const mB = frameMetrics(decodePNG(await readFile(join(OUT, fileB))));
  const cos = cosineSimilarity(mA.hist, mB.hist);
  const worstDrift = (u, v) => {
    let worst = 0;
    for (const k of ['sigmaT', 'Kd']) {
      for (let c = 0; c < 3; c++) {
        worst = Math.max(worst, Math.abs(u[k][c] - v[k][c]) / Math.max(u[k][c], v[k][c], 1e-9));
      }
    }
    return worst;
  };
  const sigmaWorst = worstDrift(A.water, B.water);
  // Arm A's column can be legitimately MID-SPRING at the beat (the player
  // crossed a real boundary within ~2 tau of it - cave-mouth measured 57.9%
  // exactly this way on this tool's first run) while arm B's jump SNAPS to
  // the table. Comparing a transient against a snap is not a demo violation,
  // so the sigma gate is hard only when arm A had settled onto its own
  // committed target.
  const settleDrift = A.target ? worstDrift(A.water, A.target) : 0;
  const settledA = settleDrift < SIGMA_TOL;
  const dMeanL = Math.abs(mA.meanL - mB.meanL) / Math.max(mA.meanL, 1e-9);
  const idOK = A.water.id === B.water.id;
  const sigmaOK = sigmaWorst < SIGMA_TOL || !settledA;
  const meanOK = dMeanL < MEANL_TOL;
  if (!idOK || !sigmaOK || !meanOK) hardFails++;

  console.log(`  water id     ${idOK ? 'ok  ' : 'FAIL'} demo '${A.water.name}' vs free '${B.water.name}'`);
  console.log(`  sigma/Kd     ${sigmaWorst < SIGMA_TOL ? 'ok  ' : settledA ? 'FAIL' : 'WARN'} ` +
    `worst channel drift ${(100 * sigmaWorst).toFixed(2)}% (gate ${100 * SIGMA_TOL}%` +
    `${settledA ? '' : `; SOFT - demo column mid-spring, ${(100 * settleDrift).toFixed(1)}% off its own target`})`);
  console.log(`  meanL        ${meanOK ? 'ok  ' : 'FAIL'} ${mA.meanL.toFixed(4)} vs ${mB.meanL.toFixed(4)} (${(100 * dMeanL).toFixed(1)}%, gate ${100 * MEANL_TOL}%)`);
  console.log(`  hist cosine  ${cos >= COSINE_SOFT ? 'ok  ' : 'WARN'} ${cos.toFixed(4)} (soft ${COSINE_SOFT}; fauna/wave phase differ by design)`);
  console.log(`  frames       ${fileA} / ${fileB} - READ THEM`);

  rows.push({
    segment: target.id, at: target.at,
    demo: { file: fileA, meanL: mA.meanL, hueEntropyBits: mA.hueEntropyBits,
      darkMass: mA.darkMass, water: A.water, pose: { x: A.x, y: A.y, z: A.z, yaw: A.yaw, pitch: A.pitch } },
    free: { file: fileB, meanL: mB.meanL, hueEntropyBits: mB.hueEntropyBits,
      darkMass: mB.darkMass, water: B.water },
    gates: { idOK, sigmaWorst, settledA, settleDrift, dMeanL, cosine: cos },
  });
}

sock.close();
cleanup();

await writeFile(join(OUT, 'report.json'), JSON.stringify(
  { name: NAME, rows, consoleErrors, hardFails }, null, 2));
console.log(`\n${hardFails === 0 ? 'PARITY GATES GREEN' : `${hardFails} HARD FAILURE(S)`}` +
  ` - report -> ${join(OUT, 'report.json')}`);
if (consoleErrors.length) {
  console.log('console errors:');
  for (const e of consoleErrors) console.log(`  ${e}`);
}
process.exit(hardFails === 0 ? 0 : 1);
