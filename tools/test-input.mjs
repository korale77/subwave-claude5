#!/usr/bin/env node
/**
 * Input and locomotion test.
 *
 * The QA harness verifies that pixels appear; it teleports the camera to do so.
 * That is exactly why it missed the controls being dead: nothing in it ever
 * pressed a key. This test does what a player does - dispatch real keyboard and
 * mouse events at the page - and asserts the player actually MOVES.
 *
 * Every check here is phrased as an observable the user would notice:
 * "W moves me forward", "the mouse turns me", "I can dive".
 *
 * Usage:  node tools/test-input.mjs [--headed]
 */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

/**
 * Pick a free TCP port.
 *
 * These tools launch a dev server and a Chrome debug endpoint. With fixed
 * ports, two runs at once (several agents verifying in parallel, or a manual
 * run alongside CI) collide and fail with an opaque connection error. Asking
 * the OS for an ephemeral port makes concurrent runs safe.
 */
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let PORT = 0;   // assigned from freePort()
let CDP_PORT = 0;   // assigned from freePort()
const HEADED = process.argv.includes('--headed');

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? '   ' + detail : ''}`);
  if (!ok) failures++;
};

async function waitForPort(port, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const s = connect(port, '127.0.0.1', () => { s.end(); resolve(true); });
      s.on('error', () => resolve(false));
      s.setTimeout(400, () => { s.destroy(); resolve(false); });
    });
    if (ok) return true;
    await sleep(200);
  }
  return false;
}

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
      }, 180000);
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

/** Windows virtual key codes for the keys we exercise. */
const VK = {
  KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68, KeyE: 69, KeyF: 70,
  KeyQ: 81, KeyR: 82, KeyL: 76, Space: 32, ShiftLeft: 16, ControlLeft: 17,
  KeyJ: 74, Escape: 27,
};

/** Dispatch a real key event through the browser's input pipeline. */
async function key(sock, code, down) {
  await sock.send('Input.dispatchKeyEvent', {
    type: down ? 'keyDown' : 'keyUp',
    code,
    key: code.startsWith('Key') ? code.slice(3).toLowerCase() : code,
    windowsVirtualKeyCode: VK[code] || 0,
    nativeVirtualKeyCode: VK[code] || 0,
  });
}

/** Hold a key for `ms`, letting the game loop run. */
async function hold(sock, code, ms) {
  await key(sock, code, true);
  await sleep(ms);
  await key(sock, code, false);
  await sleep(120);
}

const state = (sock) => sock.eval(`(() => {
  const g = window.subwave;
  const p = g.player;
  return {
    pos: Array.from(p.position).map(v => +v.toFixed(2)),
    vel: p.velocity ? Array.from(p.velocity).map(v => +v.toFixed(2)) : null,
    yaw: +g.renderer.camera.yaw.toFixed(3),
    pitch: +g.renderer.camera.pitch.toFixed(3),
    swimming: !!p.swimming,
    grounded: !!p.grounded,
    inVessel: !!p.inVessel,
    context: g.input.context,
    contextStack: g.input.contextStack.slice(),
    pointerLocked: g.input.pointerLocked,
    enabled: g.input.enabled,
    paused: g.paused,
    oxygen: p.oxygen != null ? +p.oxygen.toFixed(1) : null,
    depth: +g.renderer.camera.depth.toFixed(2),
  };
})()`);

const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
const distXZ = (a, b) => Math.hypot(b[0] - a[0], b[2] - a[2]);

// ---------------------------------------------------------------------------

const chromePath = CHROME_PATHS.find((p) => existsSync(p));
if (!chromePath) { console.error('Chrome not found.'); process.exit(1); }

PORT = await freePort();
CDP_PORT = await freePort();

const server = spawn(process.execPath, ['server.mjs', '--port', String(PORT)],
  { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] });
if (!(await waitForPort(PORT))) { console.error('server failed'); server.kill(); process.exit(1); }


const profile = join(ROOT, 'qa-output', 'input-profile');
await mkdir(profile, { recursive: true });
const chromeArgs = [
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-webgpu', '--enable-features=Vulkan',
  '--window-size=1280,720',
];
if (!HEADED) chromeArgs.push('--headless=new');
chromeArgs.push(`http://127.0.0.1:${PORT}/`);
const chrome = spawn(chromePath, chromeArgs, { stdio: ['ignore', 'ignore', 'ignore'] });

const cleanup = () => { try { chrome.kill(); } catch {} try { server.kill(); } catch {} };

if (!(await waitForPort(CDP_PORT))) { console.error('chrome failed'); cleanup(); process.exit(1); }
await sleep(1500);

const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
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

// --- boot ------------------------------------------------------------------
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

// Click "Begin" the way a player does, so we exercise the real start path
// (including whatever it does about pointer lock) rather than calling start().
await sock.eval(`document.getElementById('boot-start').click()`);
await sleep(2000);

console.log('\nSUBWAVE input & locomotion\n');

// --- 0. baseline ------------------------------------------------------------
let s0 = await state(sock);
console.log(`  context=${s0.context} stack=[${s0.contextStack}] pointerLock=${s0.pointerLocked} ` +
            `enabled=${s0.enabled} paused=${s0.paused}`);
console.log(`  pos=${s0.pos} grounded=${s0.grounded} swimming=${s0.swimming}\n`);

check('game is not paused after starting', !s0.paused);
check('input is enabled', s0.enabled);
check('an input context is active (not bare global)', s0.context !== 'global',
      `context=${s0.context}`);

// --- 1. WASD ---------------------------------------------------------------
console.log('\n  Movement\n');

{
  const before = (await state(sock)).pos;
  await hold(sock, 'KeyW', 900);
  const after = (await state(sock)).pos;
  const moved = distXZ(before, after);
  check('W moves the player forward', moved > 0.5,
        `moved ${moved.toFixed(2)} m  ${before} -> ${after}`);
}

{
  const before = (await state(sock)).pos;
  await hold(sock, 'KeyS', 900);
  const after = (await state(sock)).pos;
  check('S moves the player backward', distXZ(before, after) > 0.5,
        `moved ${distXZ(before, after).toFixed(2)} m`);
}

{
  const before = (await state(sock)).pos;
  await hold(sock, 'KeyA', 900);
  const after = (await state(sock)).pos;
  check('A strafes left', distXZ(before, after) > 0.5,
        `moved ${distXZ(before, after).toFixed(2)} m`);
}

{
  const before = (await state(sock)).pos;
  await hold(sock, 'KeyD', 900);
  const after = (await state(sock)).pos;
  check('D strafes right', distXZ(before, after) > 0.5,
        `moved ${distXZ(before, after).toFixed(2)} m`);
}

// --- 2. mouse look ----------------------------------------------------------
console.log('\n  Look\n');

{
  // DIRECTION, not just magnitude. The original version of this test only
  // asserted |dYaw| > 0.01, which passes just as happily when the controls are
  // inverted - and they were, on both axes, until a human played it.
  const probe = await sock.eval(`(() => {
    const g = window.subwave, inp = g.input, cam = g.renderer.camera;
    const M = 300;                       // pixels of mouse movement
    const wasLocked = inp.pointerLocked;
    const out = new Float32Array(2);
    inp.pointerLocked = true;            // headless never grants a real lock

    inp.mouseDX = M; inp.mouseDY = 0;
    inp.look(out, 1 / 60);
    const yawRight = out[0];

    inp.mouseDX = 0; inp.mouseDY = -M;   // screen Y grows down, so up is -M
    inp.look(out, 1 / 60);
    const pitchUp = out[1];

    inp.pointerLocked = wasLocked;
    return { yawRight, pitchUp, sens: inp.mouseSensitivity };
  })()`);

  check('mouse RIGHT yields a positive (clockwise) yaw delta', probe.yawRight > 0.01,
        `300 px right -> ${probe.yawRight.toFixed(4)} rad`);
  check('mouse UP yields a positive (look-up) pitch delta', probe.pitchUp > 0.01,
        `300 px up -> ${probe.pitchUp.toFixed(4)} rad`);

  // And that those deltas actually rotate the view the right way once applied.
  const applied = await sock.eval(`(async () => {
    const { quat, vec3, headingFromDir, RAD2DEG } = await import('/src/core/math.js');
    const q = quat.create(), f = vec3.create();
    // Face north, then apply a positive yaw delta: the heading must move toward
    // east (90 deg), not west (270 deg).
    quat.fromEuler(q, 0.4, 0, 0);
    quat.forward(f, q);
    const heading = headingFromDir(f) * RAD2DEG;
    // Positive pitch must raise the view.
    quat.fromEuler(q, 0, 0.4, 0);
    quat.forward(f, q);
    return { headingForPositiveYaw: heading, forwardYForPositivePitch: f[1] };
  })()`);

  check('positive yaw turns toward EAST', applied.headingForPositiveYaw > 0 && applied.headingForPositiveYaw < 90,
        `yaw +0.4 rad -> heading ${applied.headingForPositiveYaw.toFixed(1)} deg (east is 90)`);
  check('positive pitch looks UP', applied.forwardYForPositivePitch > 0.1,
        `pitch +0.4 rad -> forward.y = ${applied.forwardYForPositivePitch.toFixed(3)}`);

  const st = await state(sock);
  if (!st.pointerLocked) {
    check('pointer-lock hint is shown when uncaptured',
          await sock.eval(`document.getElementById('lock-hint')?.classList.contains('show') === true`),
          'so an uncaptured cursor never looks like broken controls');
  }
}

// --- 3. diving --------------------------------------------------------------
console.log('\n  Diving\n');

{
  // Put the player in water over deep enough seafloor, then try to descend.
  await sock.eval(`(() => {
    subwave.player.position.set([0, 0.5, 240]);
    if (subwave.player.velocity) subwave.player.velocity.set([0,0,0]);
  })()`);
  await sleep(700);
  const before = await state(sock);
  check('player is in water at the reef', before.swimming || before.depth >= 0,
        `swimming=${before.swimming} depth=${before.depth} y=${before.pos[1]}`);

  // Ctrl is the descend binding while swimming.
  await hold(sock, 'ControlLeft', 2500);
  const after = await state(sock);
  const descended = before.pos[1] - after.pos[1];
  check('holding descend actually submerges the player', after.pos[1] < -1.0,
        `y ${before.pos[1]} -> ${after.pos[1]} (descended ${descended.toFixed(2)} m)`);
  check('depth readout increases when submerged', after.depth > 1.0,
        `depth=${after.depth} m`);
  check('oxygen drains while submerged', after.oxygen == null || after.oxygen < 100,
        `oxygen=${after.oxygen}`);
}

// --- 3b. discoverability ----------------------------------------------------
console.log('\n  Discoverability\n');

{
  // The player could not find how to dive or climb. Assert the legend is on
  // screen and that it literally names those keys for the current context.
  const legend = await sock.eval(`(() => {
    const el = document.getElementById('controls');
    const rows = [...document.querySelectorAll('#controls-list dt')].map(n => n.textContent);
    const labels = [...document.querySelectorAll('#controls-list dd')].map(n => n.textContent);
    return {
      visible: el?.classList.contains('show') === true,
      title: document.getElementById('controls-title')?.textContent || '',
      pairs: labels.map((l, i) => l + ' = ' + rows[i]),
      context: window.subwave.input.context,
    };
  })()`);

  check('a control legend is on screen', legend.visible, `context=${legend.context} title="${legend.title}"`);
  const joined = legend.pairs.join(' | ');
  check('the legend names how to DIVE', /DIVE/i.test(joined), joined.slice(0, 150));
  check('the legend names how to go UP', /Rise|CLIMB|Surface/i.test(joined), `title="${legend.title}"`);
}

// --- 3c. control feel -------------------------------------------------------
console.log('\n  Control feel\n');

{
  // BUG THE PLAYTEST FOUND: swimming could tumble past vertical and leave you
  // inverted with the seabed overhead. Drive a large sustained pitch input and
  // assert the world's up direction is NEVER below the horizon.
  await sock.eval(`(() => {
    subwave.player.position.set([0, -8, 240]);
    if (subwave.player.velocity) subwave.player.velocity.set([0,0,0]);
  })()`);
  await sleep(700);

  const tumble = await sock.eval(`(async () => {
    const { vec3, quat } = await import('/src/core/math.js');
    const g = window.subwave, inp = g.input;
    const up = vec3.create();
    let minUpY = 1, maxPitch = 0, steps = 0;
    const wasLocked = inp.pointerLocked;
    inp.pointerLocked = true;
    // EVERY direction, not just up and down: eight compass points of hard sweep,
    // 75 frames each, 10 s in total. At 80 px/frame each leg is ~13 rad of
    // commanded rotation, an order of magnitude more than is needed to tumble,
    // and the diagonals are what a real hand does.
    const LEGS = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
    for (const [dx, dy] of LEGS) {
      for (let i = 0; i < 75; i++) {
        inp.mouseDX = 80 * dx; inp.mouseDY = 80 * dy;   // screen Y grows down
        g._simulate(1 / 60);
        steps++;
        quat.up(up, g.player.orientation);
        if (up[1] < minUpY) minUpY = up[1];
        maxPitch = Math.max(maxPitch, Math.abs(g.player.pitch));
      }
    }
    inp.mouseDX = 0; inp.mouseDY = 0;
    inp.pointerLocked = wasLocked;
    return { minUpY, maxPitch, steps, swimming: !!g.player.swimming };
  })()`);

  check('swimming never inverts the player', tumble.minUpY > 0.05,
        `worst up.y = ${tumble.minUpY.toFixed(3)} (must stay > 0) over ` +
        `${(tumble.steps / 60).toFixed(1)} s of hard sweep in 8 directions, ` +
        `swimming=${tumble.swimming}`);
  check('swim pitch is clamped short of vertical', tumble.maxPitch < 1.52,
        `max |pitch| = ${tumble.maxPitch.toFixed(3)} rad (${(tumble.maxPitch * 57.2958).toFixed(1)} deg)`);
}

// --- 3c2. swim response times ----------------------------------------------
// THE COMPLAINT: "press and hold W to swim forward and then press [S] to swim
// backward. It keeps swimming forward for a while. Same with strafing."
//
// This suite had NO response-time assertion anywhere, which is why a playtester
// found that before any test did. It could measure that W moved the diver; it
// could not measure that S stopped him, and on the build that was reported, S
// never did: the thrust direction was slewed by a normalised lerp, which is
// degenerate at exactly 180 degrees, so a dead-ahead reversal never turned the
// thrust round at all. 2.5 s of held S left the diver at +3.40 m/s.
//
// Every number below is a stopwatch on the REAL loop driven by REAL key events,
// anchored to the frame the game was actually seen holding the key on - not to
// when the test sent it, which is a round trip away.
console.log('\n  Swim response\n');

{
  /** Lagoon: seabed at -15 m, 6.3 m of water over the eye, flat for 24 m. */
  const SITE = [0, -8, 240];
  /** Every axis must answer within this, seconds. */
  const REVERSE_LIMIT = 0.30;
  const STOP_LIMIT = 0.50;

  const place = () => sock.eval(`(async () => {
    const { quat } = await import('/src/core/math.js');
    const p = subwave.player;
    p.position.set(${JSON.stringify(SITE)});
    p.velocity.set([0, 0, 0]);
    p.yaw = 0; p.pitch = 0; p.roll = 0;   // forward is -Z, right is +X, level
    quat.fromEuler(p.orientation, 0, 0, 0);
    p.finTier = 1;                        // no fins bonus, so cruise is SWIM_SPEED
    p.stamina = 100;
    return { swimming: !!p.swimming };
  })()`);

  // Sample the velocity AND the keys the game can see, once per rendered frame.
  const startTrace = () => sock.eval(`(() => {
    const g = window.subwave, p = g.player, k = g.input.keys;
    g.__swimTrace = []; g.__swimTracing = true;
    const t0 = performance.now();
    const CODES = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ControlLeft'];
    const tick = () => {
      if (!g.__swimTracing) return;
      g.__swimTrace.push([performance.now() - t0,
        p.velocity[0], p.velocity[1], p.velocity[2],
        CODES.map((c) => (k.has(c) ? 1 : 0)).join('')]);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return true;
  })()`);
  const endTrace = () => sock.eval(`(() => {
    const g = window.subwave; g.__swimTracing = false;
    const t = g.__swimTrace; g.__swimTrace = null; return t;
  })()`);

  const KEYBIT = { KeyW: 0, KeyA: 1, KeyS: 2, KeyD: 3, Space: 4, ControlLeft: 5 };
  const down = (row, code) => row[4][KEYBIT[code]] === '1';
  /** Body-relative components: yaw 0 puts forward on -Z and right on +X. */
  const AXIS = { fwd: (r) => -r[3], right: (r) => r[1], up: (r) => r[2] };

  /** First sample index at or after `from` where the game holds `code`. */
  const whenHeld = (tr, code, from = 0) => {
    for (let i = from; i < tr.length; i++) if (down(tr[i], code)) return i;
    return -1;
  };
  /** First sample at or after `from` where nothing is held. */
  const whenIdle = (tr, from = 0) => {
    for (let i = from; i < tr.length; i++) if (!/1/.test(tr[i][4])) return i;
    return -1;
  };
  /** Seconds from sample `i0` until `pred(value)` holds; null if never. */
  const secondsUntil = (tr, i0, axis, pred) => {
    for (let i = i0; i < tr.length; i++) {
      if (pred(AXIS[axis](tr[i]))) return (tr[i][0] - tr[i0][0]) / 1000;
    }
    return null;
  };
  const mean = (tr, axis, fromMs, toMs) => {
    let sum = 0, n = 0;
    for (const r of tr) {
      if (r[0] >= fromMs && r[0] <= toMs) { sum += AXIS[axis](r); n++; }
    }
    return n ? sum / n : NaN;
  };
  const fmt = (v) => (v === null ? 'never' : v.toFixed(3) + ' s');

  const SWIM_SPEED = 4.0, SWIM_SPRINT_SPEED = 6.5;   // PLAYER.SWIM_SPEED etc.

  // ---- forward: W to cruise, then S ---------------------------------------
  {
    await place();
    await sleep(600);
    await startTrace();
    await key(sock, 'KeyW', true);
    await sleep(2200);
    await key(sock, 'KeyW', false);
    await key(sock, 'KeyS', true);
    await sleep(900);
    await key(sock, 'KeyS', false);
    await sleep(900);
    const tr = await endTrace();

    const iW = whenHeld(tr, 'KeyW');
    const t63 = secondsUntil(tr, iW, 'fwd', (v) => v >= 0.63 * SWIM_SPEED);
    const cruise = mean(tr, 'fwd', tr[iW][0] + 1600, tr[iW][0] + 2100);

    const iS = whenHeld(tr, 'KeyS', iW);
    const tRev = secondsUntil(tr, iS, 'fwd', (v) => v <= 0);

    const iIdle = whenIdle(tr, iS);
    const vAtRelease = Math.abs(AXIS.fwd(tr[iIdle]));
    const tStop = secondsUntil(tr, iIdle, 'fwd',
      (v) => Math.abs(v) <= 0.1 * vAtRelease);

    check('W then S reverses the diver promptly',
          tRev !== null && tRev <= REVERSE_LIMIT,
          `forward velocity crossed zero ${fmt(tRev)} after the game saw S ` +
          `(limit ${REVERSE_LIMIT} s; the reported build: never, still +3.40 m/s at 2.5 s)`);
    check('releasing the keys stops the diver',
          tStop !== null && tStop <= STOP_LIMIT,
          `|v| fell below 10% of ${vAtRelease.toFixed(2)} m/s in ${fmt(tStop)} ` +
          `(limit ${STOP_LIMIT} s)`);
    check('W from rest reaches 63% of cruise promptly',
          t63 !== null && t63 <= 0.25, `${fmt(t63)} to 2.52 m/s`);
    check('swim cruise speed is exactly SWIM_SPEED',
          Math.abs(cruise - SWIM_SPEED) < 0.02,
          `${cruise.toFixed(4)} m/s against ${SWIM_SPEED.toFixed(3)}`);
    // The stroke used to multiply the THRUST, so the velocity surged with it -
    // measured 2.48-5.95 m/s at cruise, 89% of the mean. It is camera-only now.
    let lo = Infinity, hi = -Infinity;
    for (const r of tr) {
      if (r[0] >= tr[iW][0] + 1600 && r[0] <= tr[iW][0] + 2100) {
        lo = Math.min(lo, AXIS.fwd(r)); hi = Math.max(hi, AXIS.fwd(r));
      }
    }
    check('cruise velocity does not surge with the fin stroke',
          (hi - lo) / cruise < 0.05,
          `ripple ${(100 * (hi - lo) / cruise).toFixed(1)}% of mean ` +
          `(${lo.toFixed(2)}-${hi.toFixed(2)} m/s); the pulse belongs on the camera`);
  }

  // ---- strafe: D to cruise, then A ----------------------------------------
  // Named explicitly in the complaint, and a separate code path from forward
  // only in which basis vector it uses - which is exactly why it must be
  // asserted separately.
  {
    await place();
    await sleep(600);
    await startTrace();
    await key(sock, 'KeyD', true);
    await sleep(2200);
    await key(sock, 'KeyD', false);
    await key(sock, 'KeyA', true);
    await sleep(900);
    await key(sock, 'KeyA', false);
    await sleep(700);
    const tr = await endTrace();

    const iD = whenHeld(tr, 'KeyD');
    const cruise = mean(tr, 'right', tr[iD][0] + 1600, tr[iD][0] + 2100);
    const iA = whenHeld(tr, 'KeyA', iD);
    const tRev = secondsUntil(tr, iA, 'right', (v) => v <= 0);

    check('D then A reverses the strafe promptly',
          tRev !== null && tRev <= REVERSE_LIMIT,
          `lateral velocity crossed zero ${fmt(tRev)} after the game saw A ` +
          `(limit ${REVERSE_LIMIT} s)`);
    check('strafing reaches the same speed as swimming forward',
          Math.abs(cruise - SWIM_SPEED) < 0.02,
          `${cruise.toFixed(4)} m/s against ${SWIM_SPEED.toFixed(3)}`);
  }

  // ---- vertical: Space to rise, then ControlLeft ---------------------------
  {
    await place();
    await sleep(600);
    await startTrace();
    // 1.1 s of rise, not more: at 4.35 m/s a longer hold breaks the surface,
    // which swaps in the treading kick and the head-below-the-crest clamp and
    // would make the reversal measurement about those instead.
    await key(sock, 'Space', true);
    await sleep(1100);
    await key(sock, 'Space', false);
    await key(sock, 'ControlLeft', true);
    await sleep(900);
    await key(sock, 'ControlLeft', false);
    await sleep(500);
    const tr = await endTrace();

    const iUp = whenHeld(tr, 'Space');
    const iDn = whenHeld(tr, 'ControlLeft', iUp);
    const tRev = iDn < 0 ? null : secondsUntil(tr, iDn, 'up', (v) => v <= 0);
    check('rise then dive reverses the vertical promptly',
          tRev !== null && tRev <= REVERSE_LIMIT,
          `vertical velocity crossed zero ${fmt(tRev)} after the game saw ` +
          `descend (limit ${REVERSE_LIMIT} s)`);
  }

  // ---- sprint --------------------------------------------------------------
  {
    await place();
    await sleep(600);
    await startTrace();
    await key(sock, 'ShiftLeft', true);
    await key(sock, 'KeyW', true);
    await sleep(2600);
    const tr0 = await endTrace();
    await key(sock, 'KeyW', false);
    await key(sock, 'ShiftLeft', false);

    const iW = whenHeld(tr0, 'KeyW');
    const sprint = mean(tr0, 'fwd', tr0[iW][0] + 2000, tr0[iW][0] + 2500);
    check('swim sprint speed is exactly SWIM_SPRINT_SPEED',
          Math.abs(sprint - SWIM_SPRINT_SPEED) < 0.03,
          `${sprint.toFixed(4)} m/s against ${SWIM_SPRINT_SPEED.toFixed(3)}`);
  }
}

// --- 3d. the mouse-delta contract -------------------------------------------
console.log('\n  Pointer accounting\n');

{
  // BUG THE PLAYTEST FELT BUT COULD NOT NAME: about half of all mouse motion was
  // being thrown away. Deltas accumulate per RENDERED frame but are consumed by
  // the FIXED-STEP simulation, and endFrame() used to zero them unconditionally -
  // so at 120 Hz against a 60 Hz sim, where steps-per-frame alternate 1,0,1,0,
  // every zero-step frame's motion was discarded, and at 30 fps the same delta was
  // integrated twice. look() now DRAINS the accumulator instead.
  //
  // This is the exact analogue of the discarded key presses that markEdgesConsumed
  // fixed; it was simply never fixed for the continuous axis.
  const drain = await sock.eval(`(() => {
    const inp = window.subwave.input;
    const out = new Float32Array(2);
    const wasLocked = inp.pointerLocked;
    const wasSmooth = inp.mouseSmoothing;
    inp.pointerLocked = true;
    inp.mouseSmoothing = 0;

    // (a) A frame that runs NO simulation step must not lose the motion: the
    //     accumulator has to survive endFrame() and be added to the next frame's.
    inp.mouseDX = 0; inp.mouseDY = 0;
    inp.mouseDX += 100;
    inp.endFrame();                  // a rendered frame with zero sim steps
    inp.mouseDX += 100;
    inp.look(out, 1 / 60);
    const carried = out[0] / inp.mouseSensitivity;

    // (b) Two reads inside one frame must not double-count: the second sees zero.
    inp.mouseDX = 100;
    inp.look(out, 1 / 60);
    const first = out[0] / inp.mouseSensitivity;
    inp.look(out, 1 / 60);
    const second = out[0] / inp.mouseSensitivity;

    inp.pointerLocked = wasLocked;
    inp.mouseSmoothing = wasSmooth;
    inp.mouseDX = 0; inp.mouseDY = 0;
    return { carried, first, second };
  })()`);

  check('a frame with no sim step does not lose pointer motion',
        Math.abs(drain.carried - 200) < 1e-3,
        `200 px delivered across two frames yielded ${drain.carried.toFixed(4)} px of look`);
  check('two reads in one frame do not double-count the same motion',
        Math.abs(drain.first - 100) < 1e-3 && Math.abs(drain.second) < 1e-9,
        `first read ${drain.first.toFixed(4)} px, second read ${drain.second.toFixed(6)} px`);
}

// --- 3e. boarding ----------------------------------------------------------
console.log('\n  Vessel\n');

{
  // Stand the player next to the vessel and press E.
  const setup = await sock.eval(`(() => {
    const v = subwave.vessel, p = subwave.player;
    p.position.set([v.position[0] + 2.0, v.position[1] + 1.0, v.position[2]]);
    if (p.velocity) p.velocity.set([0,0,0]);
    return { vessel: Array.from(v.position).map(n=>+n.toFixed(1)),
             player: Array.from(p.position).map(n=>+n.toFixed(1)) };
  })()`);
  await sleep(800);
  const before = await state(sock);
  await hold(sock, 'KeyE', 250);
  await sleep(600);
  const after = await state(sock);
  check('E boards the vessel when standing next to it', after.inVessel,
        `inVessel ${before.inVessel} -> ${after.inVessel}, ` +
        `player=${setup.player} vessel=${setup.vessel}`);

  if (after.inVessel) {
    check('boarding switches to a vessel input context', /vessel/i.test(after.context),
          `context=${after.context}`);
    const b2 = (await state(sock)).pos;
    await hold(sock, 'KeyW', 1200);
    const a2 = (await state(sock)).pos;
    check('W drives the vessel', dist(b2, a2) > 1.0, `moved ${dist(b2, a2).toFixed(2)} m`);

    await hold(sock, 'KeyF', 250);
    await sleep(600);
    const a3 = await state(sock);
    check('F disembarks', !a3.inVessel, `inVessel=${a3.inVessel}`);
  }
}

// --- 4. vessel handling ----------------------------------------------------
console.log('\n  Vessel handling\n');

// ---------------------------------------------------------------------------
// THE VESSEL IS DIRECTLY CONTROLLED. Everything below asserts the kinematic
// model in entities/vessel.js `_directControl`, which replaced the rigid-body
// attitude cascade on the piloted path.
//
// THE ASSERTION THIS SUITE NEVER HAD, AND THE REASON THE MODEL CHANGED:
// nothing anywhere measured a RESPONSE TIME. Every check was green on the build
// a playtest called uncontrollable, because "the vessel eventually points where
// you asked" and "the vessel points where you asked while your hand is still
// moving" are different claims and only the first was ever tested. Measured on
// that build, a 0.15 s hand swipe worth 126 degrees had moved the view 0.47
// degrees - 0.4% - at the moment the hand stopped, and took five more seconds to
// finish. Block A is that measurement, and it is the most important check here.
//
// Roll is asserted at 0.5 DEGREES, not the 15-25 the old bounds allowed, because
// the piloted hull is built with a literal zero roll argument and any reading
// above float noise means something has put the cascade back.
//
// Bank is read as asin(right.y), never quat.toEuler().roll: toEuler folds roll
// into yaw and returns a fabricated 0 within a quarter-degree of vertical, which
// is exactly the attitude these tests visit.
// ---------------------------------------------------------------------------

const RAD = 57.29577951308232;

/**
 * Preamble every direct-control probe shares. Defines `step`, the VIEW readouts
 * and `bank`.
 *
 * The heading and pitch come from applyCamera, i.e. from the camera the player
 * actually looks through, not from the hull directly. In cockpit mode those are
 * the same thing by contract - the camera is rigid to the hull - and asserting
 * on the camera is what makes these checks bind that contract too.
 */
const HEAD = `
  const { vec3, quat, headingFromDir, wrapAngle } = await import('/src/core/math.js');
  const g = window.subwave, inp = g.input;
  const wasLocked = inp.pointerLocked;
  inp.pointerLocked = true;
  inp.mouseSmoothing = 0;
  g.clock.resync();
  const DEG = 57.29577951308232;
  const SENS = inp.mouseSensitivity;
  const _f = vec3.create(), _r = vec3.create();
  const viewFwd = () => {
    g.vessel.applyCamera(g.renderer.camera, 1, 1 / 60);
    quat.forward(_f, g.renderer.camera.orientation);
    return _f;
  };
  const viewHeading = () => headingFromDir(viewFwd());
  const viewPitch = () => Math.asin(Math.max(-1, Math.min(1, viewFwd()[1])));
  const bank = () => {
    quat.right(_r, g.vessel.orientation);
    return Math.asin(Math.max(-1, Math.min(1, _r[1])));
  };
  const step = () => g._simulate(1 / 60);
`;

/**
 * Finds genuinely deep water once and defines `reset(y)`, which parks the vessel
 * there, level, boarded and trimmed.
 *
 * board() is a no-op on a vessel already flagged as piloted, and board() is what
 * seeds BOTH the aim and the direct model's lagged hull angles from the hull's
 * real attitude. Without clearing the flag first each check inherited the
 * previous one's aim - which is why an identical left turn and right turn once
 * behaved differently. The actuators are cleared for the same reason: this
 * helper teleports the vessel, and leaving the ducts mid-manoeuvre made whichever
 * check ran second measure a different vessel.
 */
const RESET_FN = `
  const terr = await import('/src/world/terrain.js');
  let bx = 0, bz = 0, best = Infinity;
  for (let r = 400; r < 4000; r += 100) {
    for (let a = 0; a < 24; a++) {
      const x = Math.cos(a / 24 * 6.2832) * r, z = Math.sin(a / 24 * 6.2832) * r;
      const h = terr.sampleHeight(x, z);
      if (h < best) { best = h; bx = x; bz = z; }
    }
  }
  const reset = (y) => {
    g.vessel.position.set([bx, y, bz]);
    quat.identity(g.vessel.orientation);
    quat.copy(g.vessel.prevOrientation, g.vessel.orientation);
    g.vessel.velocity.set([0, 0, 0]);
    g.vessel.angularVelocity.set([0, 0, 0]);
    g.vessel.hull = g.vessel.hullMax;
    g.player.inVessel = true;
    g.vessel.piloted = false;
    g.vessel.board();
    g.vessel.aimYaw = 0; g.vessel.aimPitch = 0;
    g.vessel.prevAimYaw = 0; g.vessel.prevAimPitch = 0;
    g.vessel.nacelleTilt.fill(0); g.vessel.nacelleYaw.fill(0);
    g.vessel.nacelleThrottle.fill(0); g.vessel.nacelleCommand.fill(0);
    g.vessel.nacelleTiltCommand.fill(0); g.vessel.nacelleYawCommand.fill(0);
    g.vessel.finPitch = 0; g.vessel.finYaw = 0;
    g.vessel.finPitchCommand = 0; g.vessel.finYawCommand = 0;
    g.vessel.trimNeutral();
    g._updateInputContext();
    g.clock.resync();
    inp.mouseDX = 0; inp.mouseDY = 0;
  };
`;

const TAIL = `
  inp.mouseDX = 0; inp.mouseDY = 0;
  inp.keys.delete('KeyW');
  inp.pointerLocked = wasLocked;
  g.clock.resync();
`;

// ===========================================================================
// A. RESPONSE TIME. The check the suite has never had.
// ===========================================================================
{
  const swipeProbe = (y, throttle, settle) => `(async () => {
    ${HEAD}
    ${RESET_FN}
    reset(${y});
    ${throttle ? "inp.keys.add('KeyW');" : "inp.keys.delete('KeyW');"}
    for (let i = 0; i < ${settle}; i++) step();
    const h0 = viewHeading(), a0 = g.vessel.aimYaw;
    // 126 degrees delivered over 0.15 s - nine fixed steps - then hands off.
    const TOTAL = 126 / DEG;
    const STEPS = 9;
    const perStep = (TOTAL / STEPS) / SENS;
    let peakBank = 0;
    for (let i = 0; i < STEPS; i++) {
      inp.mouseDX = perStep;
      step();
      peakBank = Math.max(peakBank, Math.abs(bank()));
    }
    inp.mouseDX = 0;
    const atStop = wrapAngle(viewHeading() - h0);
    const trace = [];
    for (let i = 0; i < 15; i++) {          // 0.25 s after the hand stops
      step();
      peakBank = Math.max(peakBank, Math.abs(bank()));
      trace.push(wrapAngle(viewHeading() - h0));
    }
    const commanded = wrapAngle(g.vessel.aimYaw - a0);
    ${TAIL}
    return {
      commanded,
      pointerGain: commanded / TOTAL,
      atStop: atStop / commanded,
      at100: trace[5] / commanded,
      at250: trace[14] / commanded,
      peakBank,
      speed: g.vessel.speed, beta: g.vessel.beta,
    };
  })()`;

  for (const [label, y, throttle, settle] of [
    ['submerged, hovering', -150, 0, 60],
    ['submerged, at cruise', -150, 1, 300],
    ['in air, hovering', 300, 0, 60],
    ['in air, at cruise', 300, 1, 300],
  ]) {
    const r = await sock.eval(swipeProbe(y, throttle, settle));
    check(`the view delivers a 126 deg flick within 0.25 s (${label})`,
          r.at250 >= 0.90,
          `${(r.at250 * 100).toFixed(1)}% of ${(r.commanded * RAD).toFixed(1)} deg delivered ` +
          `0.25 s after the hand stopped (${(r.atStop * 100).toFixed(1)}% at the stop, ` +
          `${(r.at100 * 100).toFixed(1)}% at 0.10 s); the old model delivered 0.4% at the ` +
          `stop and took 5 s. speed ${r.speed.toFixed(1)} m/s, beta ${r.beta.toFixed(2)}`);
    check(`the flick loses none of the pointer (${label})`,
          Math.abs(r.pointerGain - 1) < 1e-6,
          `pointer gain ${r.pointerGain.toFixed(6)} - the aim is an exact integral of ` +
          'the pointer, with no rail, no rate limit and no queue');
    check(`a 126 deg flick rolls the hull by nothing (${label})`,
          r.peakBank < 0.5 / RAD,
          `peak bank ${(r.peakBank * RAD).toFixed(4)} deg (budget 0.5)`);
  }
}

// ===========================================================================
// A2. THE SAME FLICK, WITH REAL MOUSE EVENTS ON THE REAL LOOP.
//
// Everything above steps the fixed sim by hand, which is deterministic and
// therefore the right way to measure a time constant - but it also bypasses the
// DOM, the 120 Hz render loop and the accumulator that shares one frame's worth
// of pointer motion out over 0, 1 or 2 sim steps. Those are exactly where two
// earlier bugs lived (half of all motion discarded, and the same motion counted
// twice at 30 fps), so the headline claim is measured once more end to end:
// real MouseEvents dispatched one per rendered frame, real wall-clock timing,
// nothing driven by hand.
// ===========================================================================
{
  const realMouse = await sock.eval(`(async () => {
    ${HEAD}
    ${RESET_FN}
    reset(-150);
    inp.mouseDX = 0; inp.mouseDY = 0;
    const frame = () => new Promise((res) => requestAnimationFrame(res));
    // The camera is updated by the real loop every frame; read it, do not drive it.
    const camHeading = () => {
      quat.forward(_f, g.renderer.camera.orientation);
      return headingFromDir(_f);
    };
    for (let i = 0; i < 40; i++) await frame();      // settle on the real loop
    const h0 = camHeading(), a0 = g.vessel.aimYaw;
    // movementX is a long in MouseEventInit, so the per-event step must be a whole
    // number of pixels or the browser rounds it and the commanded angle drifts.
    const N = 18;                                    // ~0.15 s at 120 fps
    const perEvent = Math.round((126 / DEG) / SENS / N);
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      window.dispatchEvent(new MouseEvent('mousemove', {
        movementX: perEvent, movementY: 0, bubbles: true,
      }));
      await frame();
    }
    const swipeMs = performance.now() - t0;
    const atStop = wrapAngle(camHeading() - h0);
    const t1 = performance.now();
    while (performance.now() - t1 < 250) await frame();
    const at250 = wrapAngle(camHeading() - h0);
    const commanded = wrapAngle(g.vessel.aimYaw - a0);
    const expected = perEvent * N * SENS;
    ${TAIL}
    return {
      swipeMs, commanded, expected,
      pointerGain: commanded / expected,
      atStop: atStop / commanded,
      at250: at250 / commanded,
    };
  })()`);

  check('real mouse events on the real loop deliver the same flick',
        realMouse.at250 >= 0.90,
        `${(realMouse.expected * RAD).toFixed(1)} deg dispatched over ` +
        `${realMouse.swipeMs.toFixed(0)} ms of wall clock; the camera had ` +
        `${(realMouse.atStop * 100).toFixed(1)}% of it at the last event and ` +
        `${(realMouse.at250 * 100).toFixed(1)}% 250 ms later`);
  check('real mouse events lose none of the pointer',
        Math.abs(realMouse.pointerGain - 1) < 1e-6,
        `gain ${realMouse.pointerGain.toFixed(6)} through the DOM, the accumulator ` +
        'and the fixed step');
}

// ===========================================================================
// B. POINTER GAIN IS 1.000 AT EVERY AIM PITCH.
//
// The number that proves the travel loss is gone. The yaw rail this replaced
// tightened with pitch to bound the roll a heading offset couples, and it cost
// the player 0.913 / 0.504 / 0.358 / 0.303 of their hand at 15 / 30 / 45 / 60
// degrees of aim pitch. With roll structurally zero there is nothing to couple,
// so there is no rail, and the gain is the same number at every attitude.
// ===========================================================================
{
  const gainProbe = `(async () => {
    ${HEAD}
    ${RESET_FN}
    const out = [];
    for (const deg of [0, 15, 30, 45, 60, 75]) {
      reset(-150);
      for (let i = 0; i < 30; i++) step();
      g.vessel.aimPitch = deg / DEG;
      for (let i = 0; i < 30; i++) step();     // let the hull reach that pitch
      const a0 = g.vessel.aimYaw;
      const px = 20, N = 60;                   // 1200 px over one second
      let peakBank = 0;
      for (let i = 0; i < N; i++) {
        inp.mouseDX = px;
        step();
        peakBank = Math.max(peakBank, Math.abs(bank()));
      }
      inp.mouseDX = 0;
      const delivered = wrapAngle(g.vessel.aimYaw - a0);
      const commanded = px * N * SENS;
      for (let i = 0; i < 30; i++) { step(); peakBank = Math.max(peakBank, Math.abs(bank())); }
      out.push({
        deg,
        gain: delivered / commanded,
        commandedDeg: commanded * DEG,
        hullErrDeg: wrapAngle(viewHeading() - g.vessel.aimYaw) * DEG,
        peakBank,
      });
    }
    ${TAIL}
    return out;
  })()`;

  const gains = await sock.eval(gainProbe);
  for (const r of gains) {
    check(`pointer gain is exactly 1.000 at ${r.deg} deg of aim pitch`,
          Math.abs(r.gain - 1) < 1e-6,
          `${r.commandedDeg.toFixed(1)} deg of pointer -> gain ${r.gain.toFixed(6)}; ` +
          `hull settled ${Math.abs(r.hullErrDeg).toFixed(2)} deg off the aim, ` +
          `peak bank ${(r.peakBank * RAD).toFixed(4)} deg`);
  }
}

// ===========================================================================
// C. ROLL IS ZERO FROM ANY INPUT.
//
// "no lateral rolls, barrel rolls or other", asserted as an absolute rather than
// as a budget. Pure yaw, pure pitch, a diagonal and a hard sweep, at hover and at
// top speed, in both media. The old model's worst case here was 110-114 degrees
// of coupled roll above 65 degrees of aim pitch, and its own guard was 25.8 deg.
// ===========================================================================
{
  const rollMatrix = (y) => `(async () => {
    ${HEAD}
    ${RESET_FN}
    const CASES = [
      ['pure yaw', 12, 0], ['pure pitch', 0, -12],
      ['diagonal', 9, -9], ['hard sweep', 40, 14],
    ];
    const out = [];
    for (const throttle of [0, 1]) {
      for (const [label, dx, dy] of CASES) {
        reset(${y});
        if (throttle) inp.keys.add('KeyW'); else inp.keys.delete('KeyW');
        for (let i = 0; i < 60; i++) step();
        let peak = 0;
        for (let i = 0; i < 480; i++) {
          inp.mouseDX = dx; inp.mouseDY = dy;
          step();
          peak = Math.max(peak, Math.abs(bank()));
        }
        inp.mouseDX = 0; inp.mouseDY = 0;
        for (let i = 0; i < 120; i++) { step(); peak = Math.max(peak, Math.abs(bank())); }
        inp.keys.delete('KeyW');
        out.push({ label, throttle, peak, speed: g.vessel.speed });
      }
    }
    ${TAIL}
    return out;
  })()`;

  for (const [medium, y] of [['submerged', -150], ['in air', 300]]) {
    const rows = await sock.eval(rollMatrix(y));
    let worst = 0, worstAt = '';
    for (const r of rows) {
      if (r.peak > worst) {
        worst = r.peak;
        worstAt = `${r.label}, throttle ${r.throttle}, ${r.speed.toFixed(0)} m/s`;
      }
    }
    check(`no input rolls the hull ${medium}`, worst < 0.5 / RAD,
          `worst peak bank ${(worst * RAD).toFixed(4)} deg over ${rows.length} runs ` +
          `(pure yaw / pure pitch / diagonal / hard sweep, at hover and at speed); ` +
          `worst was ${worstAt}. Budget 0.5 deg`);
  }
}

// ===========================================================================
// D. A MOUSE REVERSAL REVERSES THE VIEW.
//
// Measured on the old model: 0.3-1.6 s to turn round, with up to 166 degrees of
// overshoot, because the hull was still spending the momentum of the first half
// of the movement. A first-order lag on a positional target cannot do that - it
// has no state but the current attitude - so the view turns round as soon as the
// aim crosses back over it.
// ===========================================================================
{
  const reverseProbe = (y, throttle, settle) => `(async () => {
    ${HEAD}
    ${RESET_FN}
    reset(${y});
    ${throttle ? "inp.keys.add('KeyW');" : "inp.keys.delete('KeyW');"}
    for (let i = 0; i < ${settle}; i++) step();
    const px = 10;                         // 600 px/s, a firm sustained sweep
    let prev = viewHeading();
    for (let i = 0; i < 90; i++) { inp.mouseDX = px; step(); prev = viewHeading(); }
    const hAtReversal = viewHeading();
    let tReverse = -1, overshoot = 0, peakBank = 0;
    for (let i = 0; i < 60; i++) {
      inp.mouseDX = -px;
      step();
      const h = viewHeading();
      const rate = wrapAngle(h - prev);
      prev = h;
      overshoot = Math.max(overshoot, wrapAngle(h - hAtReversal));
      peakBank = Math.max(peakBank, Math.abs(bank()));
      if (tReverse < 0 && rate < 0) tReverse = (i + 1) / 60;
    }
    ${TAIL}
    return { tReverse, overshoot, peakBank };
  })()`;

  for (const [label, y, throttle, settle] of [
    ['submerged, hovering', -150, 0, 60],
    ['submerged, at cruise', -150, 1, 300],
    ['in air, at cruise', 300, 1, 300],
  ]) {
    const r = await sock.eval(reverseProbe(y, throttle, settle));
    check(`the view reverses with the mouse (${label})`,
          r.tReverse > 0 && r.tReverse < 0.15,
          `turned round ${r.tReverse < 0 ? 'NEVER' : (r.tReverse * 1000).toFixed(0) + ' ms'} ` +
          `after the pointer did, carrying ${(r.overshoot * RAD).toFixed(1)} deg past the ` +
          'reversal point (the old model took 0.3-1.6 s and overshot up to 166 deg)');
  }
}

// ===========================================================================
// E. A SUSTAINED TURN IS A TURN.
// ===========================================================================
{
  for (const dir of [+1, -1]) {
    const label = dir > 0 ? 'right' : 'left';
    const turn = await sock.eval(`(async () => {
      ${HEAD}
      ${RESET_FN}
      reset(-200);
      inp.keys.add('KeyW');
      for (let i = 0; i < 120; i++) step();
      let heading = 0, prev = viewHeading(), peakBank = 0, minUpY = 1, maxOmega = 0;
      let minClear = Infinity, contactSteps = 0;
      const rates = [];
      const up = vec3.create();
      for (let i = 0; i < 480; i++) {       // 8 s of held mouse at 480 px/s
        inp.mouseDX = ${dir} * 8;
        step();
        const h = viewHeading();
        const d = wrapAngle(h - prev);
        heading += d;
        prev = h;
        if (i > 120) rates.push(d * 60);
        peakBank = Math.max(peakBank, Math.abs(bank()));
        quat.up(up, g.vessel.orientation);
        minUpY = Math.min(minUpY, up[1]);
        maxOmega = Math.max(maxOmega, vec3.len(g.vessel.angularVelocity));
        minClear = Math.min(minClear, g.vessel.groundClearance);
        if (g.vessel._hullContact.contacts > 0) contactSteps++;
      }
      inp.mouseDX = 0;
      const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
      const sd = Math.sqrt(rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length);
      ${TAIL}
      return {
        heading, mean, sd, peakBank, minUpY, maxOmega, minClear, contactSteps,
        depth: g.vessel.depth, speed: g.vessel.speed,
      };
    })()`);

    check(`a sustained ${label} turn submerged is a real turn`,
          Math.sign(turn.heading) === dir && Math.abs(turn.heading) > 2.5 &&
          Math.abs(turn.mean) > 0.45,
          `${(Math.abs(turn.mean) * RAD).toFixed(0)} deg/s sustained, ` +
          `${(turn.heading * RAD).toFixed(0)} deg total, consistently signed; ` +
          `depth ${turn.depth.toFixed(0)} m, ${turn.speed.toFixed(1)} m/s`);
    check(`a sustained ${label} turn is steady, not a limit cycle`,
          Math.abs(turn.sd) < Math.abs(turn.mean) * 0.20 + 0.02,
          `yaw rate ${turn.mean.toFixed(3)} +/- ${turn.sd.toFixed(4)} rad/s over the last 6 s`);
    check(`a sustained ${label} turn never inverts or rolls the vessel`,
          turn.minUpY > 0.30 && turn.peakBank < 0.5 / RAD,
          `worst up.y ${turn.minUpY.toFixed(3)}, peak bank ` +
          `${(turn.peakBank * RAD).toFixed(4)} deg, peak |omega| ` +
          `${turn.maxOmega.toFixed(3)} rad/s, min ground clearance ` +
          `${turn.minClear.toFixed(0)} m, ${turn.contactSteps} steps in contact`);
  }
}

// ===========================================================================
// F. DIVE AND SURFACE ON THE MOUSE AND W ALONE.
//
// The user's original request, unchanged by the control rewrite: there is no
// ballast, trim, roll or vertical key, and none must be needed.
// ===========================================================================
{
  const dive = await sock.eval(`(async () => {
    ${HEAD}
    ${RESET_FN}
    reset(60);
    const allowed = new Set(['KeyW']);
    const heldBefore = [...inp.keys];
    inp.keys.clear();
    let minUpY = 1, peakBank = 0, deepest = 0, pressedAnythingElse = false;
    const up = vec3.create();
    const drive = (n, dy) => {
      for (let i = 0; i < n; i++) {
        inp.mouseDY = dy;
        step();
        for (const k of inp.keys) if (!allowed.has(k)) pressedAnythingElse = true;
        quat.up(up, g.vessel.orientation);
        minUpY = Math.min(minUpY, up[1]);
        peakBank = Math.max(peakBank, Math.abs(bank()));
        deepest = Math.max(deepest, g.vessel.depth);
      }
    };
    inp.keys.add('KeyW');
    drive(60, 0);                     // build speed, level, in air
    // 40 deg of nose-down aim. mouseDY is screen-DOWN positive, which is nose-down.
    drive(30, (40 / DEG) / SENS / 30);
    const aimAfter = g.vessel.aimPitch;
    for (let n = 0; n < 2400 && g.vessel.depth < 110; n++) drive(1, 0);
    const bottom = g.vessel.position[1];
    const depthAtBottom = g.vessel.depth;
    // Aim up and come home on the same two controls.
    drive(45, -(95 / DEG) / SENS / 45);
    for (let n = 0; n < 3000 && g.vessel.position[1] < -2; n++) drive(1, 0);
    const top = g.vessel.position[1];
    inp.mouseDY = 0;
    inp.keys.delete('KeyW');
    for (const k of heldBefore) inp.keys.add(k);
    ${TAIL}
    return {
      aimAfter, bottom, depthAtBottom, top, deepest, minUpY, peakBank,
      pressedAnythingElse, hull: g.vessel.hull, rating: g.vessel.depthRating,
      ballast: g.vessel.ballastFill,
    };
  })()`);

  check('aiming down builds a real nose-down aim', dive.aimAfter < -0.35,
        `aimPitch = ${dive.aimAfter.toFixed(3)} rad (${(dive.aimAfter * RAD).toFixed(0)} deg)`);
  check('the vessel DIVES on the mouse and W alone', dive.depthAtBottom > 60,
        `reached ${dive.depthAtBottom.toFixed(0)} m depth (y = ${dive.bottom.toFixed(0)}); ` +
        'no ballast, trim or vertical key exists to press');
  check('the vessel SURFACES again on the mouse and W alone', dive.top > -8,
        `came back to y = ${dive.top.toFixed(0)} from ${dive.bottom.toFixed(0)}, ` +
        `ballast now ${dive.ballast.toFixed(2)}`);
  check('nothing but W was ever held', !dive.pressedAnythingElse);
  check('the round trip never inverts the vessel', dive.minUpY > 0.0,
        `worst up.y = ${dive.minUpY.toFixed(3)} (positive throughout = never inverted)`);
  check('the round trip rolls the hull by nothing', dive.peakBank < 0.5 / RAD,
        `peak bank ${(dive.peakBank * RAD).toFixed(4)} deg over a dive to ` +
        `${dive.deepest.toFixed(0)} m and back`);
  check('the hull survives its own dive', dive.hull > 55,
        `hull ${dive.hull.toFixed(1)}% after a ${dive.deepest.toFixed(0)} m round trip ` +
        `(crush depth ${dive.rating.toFixed(0)} m); the flight computer still slows the ` +
        'vessel to its submerged limit on the way down, which is what makes the entry ' +
        'survivable');
}

// ===========================================================================
// G. THE THROTTLE IS A THROTTLE. Reported from play: "once we move forward with
// the vessel, even if we release the gas it keeps moving and won't stop." A
// centred throttle commands a STOP - the one clause of the old throttle law that
// was always right, and it survives here for free because the target velocity is
// the zero vector.
// ===========================================================================
{
  for (const [label, y] of [['submerged', -160], ['in air', 600]]) {
    const coast = await sock.eval(`(async () => {
      ${HEAD}
      ${RESET_FN}
      reset(${y});
      const speed = () => Math.hypot(g.vessel.velocity[0], g.vessel.velocity[2]);
      inp.keys.add('KeyW');
      for (let i = 0; i < 600; i++) step();
      const released = speed();
      inp.keys.delete('KeyW');
      let tHalf = -1, tTenth = -1;
      for (let i = 0; i < 1200; i++) {
        step();
        const s = speed();
        if (tHalf < 0 && s <= released * 0.5) tHalf = (i + 1) / 60;
        if (tTenth < 0 && s <= released * 0.1) { tTenth = (i + 1) / 60; break; }
      }
      ${TAIL}
      return { released, tHalf, tTenth, final: speed() };
    })()`);

    check(`releasing the throttle actually stops the vessel (${label})`,
          coast.tTenth > 0 && coast.tTenth < 3,
          `released at ${coast.released.toFixed(1)} m/s -> half in ` +
          `${coast.tHalf > 0 ? coast.tHalf.toFixed(2) + ' s' : 'NEVER'}, a tenth in ` +
          `${coast.tTenth > 0 ? coast.tTenth.toFixed(2) + ' s' : 'NEVER'}`);
  }
}

// ===========================================================================
// H. W FROM REST REACHES THE RATED SPEED PROMPTLY, IN BOTH MEDIA.
// ===========================================================================
{
  const speeds = await sock.eval(`(async () => {
    ${HEAD}
    ${RESET_FN}
    const { VESSEL } = await import('/src/core/constants.js');
    const run = (y, steps, vMax) => {
      reset(y);
      inp.keys.add('KeyW');
      let peak = 0, minBeta = 1, maxBeta = 0, t63 = -1;
      for (let i = 0; i < steps; i++) {
        step();
        const s = Math.hypot(g.vessel.velocity[0], g.vessel.velocity[2]);
        if (s > peak) peak = s;
        if (t63 < 0 && s >= 0.63 * vMax) t63 = (i + 1) / 60;
        minBeta = Math.min(minBeta, g.vessel.beta);
        maxBeta = Math.max(maxBeta, g.vessel.beta);
      }
      inp.keys.delete('KeyW');
      return {
        peak, minBeta, maxBeta, t63,
        final: Math.hypot(g.vessel.velocity[0], g.vessel.velocity[2]),
      };
    };
    const sub = run(-260, 600, VESSEL.MAX_SUBSPEED);
    const air = run(900, 900, VESSEL.MAX_AIRSPEED);
    ${TAIL}
    return { sub, air, subMax: VESSEL.MAX_SUBSPEED, airMax: VESSEL.MAX_AIRSPEED };
  })()`);

  check('the submerged speed run really stayed submerged', speeds.sub.minBeta > 0.95,
        `beta stayed in [${speeds.sub.minBeta.toFixed(3)}, ${speeds.sub.maxBeta.toFixed(3)}]`);
  check('the air speed run really stayed in air', speeds.air.maxBeta < 0.05,
        `beta stayed in [${speeds.air.minBeta.toFixed(3)}, ${speeds.air.maxBeta.toFixed(3)}]`);
  for (const [label, r, vMax] of [
    ['submerged', speeds.sub, speeds.subMax], ['in air', speeds.air, speeds.airMax],
  ]) {
    check(`top speed reaches its rating and no more (${label})`,
          r.peak > vMax * 0.90 && r.peak < vMax * 1.08,
          `peak ${r.peak.toFixed(1)} m/s against ${vMax} (ended at ${r.final.toFixed(1)})`);
    // ACCELERATION, not just the ceiling: the velocity is a first-order lag on a
    // commanded target, so 63% of it is one time constant by construction and any
    // other number means something has been put back in front of the throttle.
    check(`W from rest reaches 63% of top speed promptly (${label})`,
          r.t63 > 0 && r.t63 <= 0.40,
          `63% of ${vMax} m/s in ${r.t63 < 0 ? 'NEVER' : r.t63.toFixed(3) + ' s'} ` +
          '(DIRECT_VEL_TAU is 0.25 s)');
  }
}

// ===========================================================================
// I. THE HULL DOES NOT PASS THROUGH TERRAIN.
//
// A kinematic body writes its own position, so contact is the ONLY thing keeping
// it out of the ground - which makes this the check that has to exist. Flown, at
// full throttle, straight into the seabed and straight into a cliff at Vne.
// ===========================================================================
{
  const terrainProbe = await sock.eval(`(async () => {
    ${HEAD}
    const terr = await import('/src/world/terrain.js');
    // A shallow seabed the vessel can reach inside its 220 m tier-0 crush depth,
    // and the island summit.
    let sx = 0, sz = 0, sBest = -Infinity, hx = 0, hz = 0, high = -Infinity;
    for (let r = 100; r < 2400; r += 40) {
      for (let a = 0; a < 48; a++) {
        const x = Math.cos(a / 48 * 6.2832) * r, z = Math.sin(a / 48 * 6.2832) * r;
        const h = terr.sampleHeight(x, z);
        if (h < -40 && h > sBest) { sBest = h; sx = x; sz = z; }
        if (h > high) { high = h; hx = x; hz = z; }
      }
    }
    const fly = (x, y, z, yaw, pitch, steps) => {
      g.vessel.position.set([x, y, z]);
      quat.fromEuler(g.vessel.orientation, yaw, 0, 0);
      quat.copy(g.vessel.prevOrientation, g.vessel.orientation);
      g.vessel.velocity.set([0, 0, 0]);
      g.vessel.angularVelocity.set([0, 0, 0]);
      g.vessel.hull = g.vessel.hullMax;
      g.player.inVessel = true;
      g.vessel.piloted = false;
      g.vessel.board();
      g.vessel.aimYaw = yaw; g.vessel.aimPitch = pitch;
      g.vessel.prevAimYaw = yaw; g.vessel.prevAimPitch = pitch;
      g.vessel.trimNeutral();
      g._updateInputContext();
      g.clock.resync();
      inp.keys.add('KeyW');
      let inside = Infinity, pen = 0, contacts = 0, peak = 0;
      for (let i = 0; i < steps; i++) {
        step();
        peak = Math.max(peak, g.vessel.speed);
        const ground = terr.sampleHeight(g.vessel.position[0], g.vessel.position[2]);
        inside = Math.min(inside, g.vessel.position[1] - ground);
        pen = Math.max(pen, g.vessel._hullContact.maxPenetration || 0);
        if (g.vessel._hullContact.contacts > 0) contacts++;
      }
      inp.keys.delete('KeyW');
      return { inside, pen, contacts, peak };
    };
    const seabed = fly(sx, sBest + 60, sz, 0, -60 / DEG, 900);
    const cliff = fly(hx - 1500, high * 0.5, hz, Math.PI / 2, 0, 1500);
    ${TAIL}
    return { seabed, cliff, seabedY: sBest, summitY: high };
  })()`);

  for (const [label, r] of [
    ['seabed', terrainProbe.seabed], ['cliff at Vne', terrainProbe.cliff],
  ]) {
    check(`flying the vessel into the ${label} does not put it through the terrain`,
          r.contacts > 0 && r.inside > -1.0 && r.pen < 3.0,
          `${r.contacts} steps in contact at up to ${r.peak.toFixed(0)} m/s; hull centre ` +
          `never closer than ${r.inside.toFixed(2)} m to the height field, worst probe ` +
          `penetration ${r.pen.toFixed(2)} m against a 7.4 m hull`);
  }
}

// ===========================================================================
// J. THE AIM IS INDEPENDENT OF THE HULL.
//
// The rail this replaced read the hull and ASSIGNED what it read, through
// quat.toEuler - which inverts its reported pitch past 90 degrees of roll, so a
// rolling hull wrote a fiction over the pilot every step. That was the whole of
// "the mouse stops responding". Nothing on the pointer path reads the hull at
// all now, so the same mouse movement must produce a bit-identical aim whatever
// attitude the hull is dropped into.
// ===========================================================================
{
  const aimGain = (roll) => `(async () => {
    ${HEAD}
    ${RESET_FN}
    reset(-100);
    quat.fromEuler(g.vessel.orientation, 0, 0.2, ${roll});
    quat.copy(g.vessel.prevOrientation, g.vessel.orientation);
    g.vessel.aimYaw = 0; g.vessel.aimPitch = 0;
    g.vessel.prevAimYaw = 0; g.vessel.prevAimPitch = 0;
    for (let i = 0; i < 60; i++) { inp.mouseDY = 10; step(); }
    inp.mouseDY = 0;
    const r = { aimPitch: g.vessel.aimPitch, aimYaw: g.vessel.aimYaw, bank: bank() };
    ${TAIL}
    return r;
  })()`;

  const level = await sock.eval(aimGain(0));
  const rolled = await sock.eval(aimGain(2.1));
  const inverted = await sock.eval(aimGain(2.967));
  check('the aim is bit-identical however the hull is lying',
        Math.abs(rolled.aimPitch - level.aimPitch) < 1e-9 &&
        Math.abs(inverted.aimPitch - level.aimPitch) < 1e-9,
        `1 s of mouse-down moved the aim ${(level.aimPitch * RAD).toFixed(3)} deg on a level ` +
        `hull, ${(rolled.aimPitch * RAD).toFixed(3)} deg on one rolled 120 deg and ` +
        `${(inverted.aimPitch * RAD).toFixed(3)} deg on one rolled 170 deg`);
  check('a hull dropped in inverted comes back to level roll immediately',
        Math.abs(level.bank) < 0.5 / RAD && Math.abs(rolled.bank) < 0.5 / RAD &&
        Math.abs(inverted.bank) < 0.5 / RAD,
        `bank after one second: ${(level.bank * RAD).toFixed(4)} / ` +
        `${(rolled.bank * RAD).toFixed(4)} / ${(inverted.bank * RAD).toFixed(4)} deg from ` +
        '0 / 120 / 170 deg of imposed roll - the piloted attitude is rebuilt from ' +
        '(heading, pitch, 0) every step, so roll cannot survive one');
}

// ===========================================================================
// K. THE AIM HOLDS AFTER THE MOUSE STOPS, AND THE HULL FOLLOWS IT WITHOUT
// RINGING. The original check, kept: a target read from pointer SPEED collapses
// the instant the hand does, and you cannot hold a climb.
// ===========================================================================
{
  for (const [label, y] of [['in air', 260], ['submerged', -90]]) {
    const flight = await sock.eval(`(async () => {
      ${HEAD}
      ${RESET_FN}
      reset(${y});
      inp.keys.add('KeyW');
      for (let i = 0; i < 120; i++) step();
      for (let i = 0; i < 20; i++) { inp.mouseDY = -25; step(); }
      inp.mouseDY = 0;
      const aimAfterInput = g.vessel.aimPitch;
      const trace = [];
      let peakBank = 0;
      for (let i = 0; i < 90; i++) {
        step();
        trace.push(viewPitch());
        peakBank = Math.max(peakBank, Math.abs(bank()));
      }
      const aimHeld = g.vessel.aimPitch;
      let reversals = 0;
      for (let i = 46; i < trace.length - 1; i++) {
        const a = trace[i] - trace[i - 1];
        const b = trace[i + 1] - trace[i];
        if (a !== 0 && b !== 0 && Math.sign(a) !== Math.sign(b)) reversals++;
      }
      ${TAIL}
      return {
        aimAfterInput, aimHeld, reversals, peakBank,
        settled: trace[trace.length - 1],
        peak: Math.max(...trace.map(Math.abs)),
      };
    })()`);

    check(`pointer input builds a real pitch aim (${label})`,
          Math.abs(flight.aimAfterInput) > 0.05,
          `aimPitch = ${flight.aimAfterInput.toFixed(4)} rad after 20 frames of input`);
    check(`the aim HOLDS exactly after the mouse stops (${label})`,
          flight.aimHeld === flight.aimAfterInput,
          `${flight.aimAfterInput.toFixed(6)} -> ${flight.aimHeld.toFixed(6)} rad over 1.5 s ` +
          'of no input; nothing may write the aim but the pointer');
    check(`the view settles on the aim (${label})`,
          Math.abs(flight.settled - flight.aimHeld) < 0.01,
          `aim ${flight.aimHeld.toFixed(3)} rad -> view ${flight.settled.toFixed(3)} rad ` +
          `(${Math.abs((flight.settled - flight.aimHeld) * RAD).toFixed(3)} deg of error)`);
    check(`pitch does not ring (${label})`, flight.reversals <= 2,
          `${flight.reversals} direction reversals in the last 0.75 s, peak bank ` +
          `${(flight.peakBank * RAD).toFixed(4)} deg`);
  }

  // ---- the eye stays inside the hull that is actually DRAWN ---------------
  //
  // "Rigidly attached to the hull" is a claim about the DRAWN hull. The mesh comes
  // from the node matrices and the eye from applyCamera, and when those were built
  // from different transforms - the mesh from the sim state, the eye from the
  // render-interpolated state - they separated by (1 - alpha) of one sim step of
  // travel. MEASURED at 120 m/s: 1.997 m on a 7.4 m hull, which puts the eye
  // outside it, defeats the back-face culling that hides the hull and canopy, and
  // swings the nacelles into frame. Reported from play as "a bunch of disconnected
  // floating vessel parts, some clipped".
  //
  // THIS MUST BE MEASURED AT alpha < 1. At alpha = 1 the interpolation is the
  // identity and the defect is invisible - which is why every existing view check
  // here, all of which call applyCamera with alpha 1, stayed green through it. The
  // camera's ROTATION is not the quantity either: the rotations agreed throughout.
  const rigid = await sock.eval(`(async () => {
    ${HEAD}
    ${RESET_FN}
    const { mat4 } = await import('/src/core/math.js');
    const { VESSEL } = await import('/src/core/constants.js');
    const { VESSEL_NODE } = await import('/src/entities/vessel_mesh.js');
    reset(-200);
    // Real speed, because the defect is exactly proportional to it.
    inp.keys.add('KeyW');
    for (let i = 0; i < 180; i++) step();
    const inv = mat4.create(), local = vec3.create();
    let worst = 0;
    for (let i = 0; i < 60; i++) {
      step();
      // Sample the alphas a 120 Hz renderer actually produces against a 60 Hz sim.
      for (const alpha of [0, 0.25, 0.5, 0.75, 1]) {
        g.vessel.applyCamera(g.renderer.camera, alpha, 1 / 60);
        const base = VESSEL_NODE.HULL * 16;
        mat4.invert(inv, g.vessel.nodeMatrices.subarray(base, base + 16));
        vec3.transformMat4(local, g.renderer.camera.position, inv);
        worst = Math.max(worst, Math.hypot(
          local[0] - VESSEL.COCKPIT_EYE[0],
          local[1] - VESSEL.COCKPIT_EYE[1],
          local[2] - VESSEL.COCKPIT_EYE[2]));
      }
    }
    inp.keys.delete('KeyW');
    return { worst, speed: vec3.len(g.vessel.velocity) };
  })()`);
  check('the cockpit eye stays inside the DRAWN hull at speed',
        rigid.worst < 0.01,
        `worst offset from COCKPIT_EYE ${rigid.worst.toFixed(6)} m at ` +
        `${rigid.speed.toFixed(1)} m/s, sampled at alpha 0/0.25/0.5/0.75/1; ` +
        'the sim-state mesh transform measured 1.997 m here');

  // Put the world back: the checks above fly the vessel a long way, and leaving it
  // there strands anything that runs after it in open water.
  const restore = await sock.eval(`(() => {
    const g = window.subwave;
    // Exit through the real API: board() refuses a vessel that is still flagged as
    // piloted, so clearing player.inVessel alone leaves boarding broken for every
    // later test - which is exactly what it did.
    if (g.player.inVessel) g.player.exitVessel(g.vessel);
    g.player.inVessel = false;
    g.vessel.piloted = false;
    g.vessel.position.set(g.spawn.vesselPad);
    g.vessel.velocity.set([0, 0, 0]);
    g.vessel.angularVelocity.set([0, 0, 0]);
    g.vessel.hull = g.vessel.hullMax;
    g.vessel.aimPitch = 0;
    g.vessel.aimYaw = 0;
    g.player.position.set(g.spawn.position);
    if (g.player.velocity) g.player.velocity.set([0, 0, 0]);
    g._updateInputContext();
    // Settle both bodies onto the ground before handing over. The pad is only
    // approximately at terrain height, so a freshly placed vessel is falling.
    for (let i = 0; i < 240; i++) g._simulate(1 / 60);
    return {
      pad: Array.from(g.spawn.vesselPad),
      pos: Array.from(g.vessel.position),
      piloted: !!g.vessel.piloted, inVessel: !!g.player.inVessel,
      clearance: g.vessel.groundClearance,
    };
  })()`);
  await sleep(500);
  void restore;
}


// --- 5. the developer jump menu (J) -----------------------------------------
//
// Everything here is a REAL key through the browser's input pipeline, because
// the two things most likely to be wrong are only observable that way: whether
// the input gate actually holds, and whether the camera stays attached to the
// player across a 3 km discontinuity.
{
  console.log('\n5. developer jump menu');

  // Start from a known place, on foot, menu closed.
  await sock.eval(`(() => {
    const g = window.subwave;
    if (g.jumpMenu.open) g.jumpMenu.hide();
    if (g.player.inVessel) g.player.exitVessel(g.vessel);
    g.setPaused(false);
    g.jumpTo(2);
  })()`);
  await sleep(1500);

  await key(sock, 'KeyJ', true); await key(sock, 'KeyJ', false);
  await sleep(400);
  let s = await state(sock);
  const opened = await sock.eval(`(() => {
    const el = document.getElementById('jump-menu');
    const hint = document.getElementById('lock-hint');
    return {
      open: window.subwave.jumpMenu.open,
      shown: el.classList.contains('show'),
      rows: document.querySelectorAll('#jump-list button').length,
      lockHint: hint.classList.contains('show'),
      locked: !!document.pointerLockElement,
    };
  })()`);
  check('J opens the jump menu', opened.open && opened.shown,
    `${opened.rows} biome rows`);
  // SELF-DESCRIBING, never a literal again: 14 biome anchors + 2 station rows
  // + one row per authored place. The literal here was 14 when the two station
  // rows landed (red on every otherwise-green run), then 16 when the places
  // landed - the count moves with two registries, so derive it from them.
  const { BIOME_COUNT } = await import('../src/world/biomes.js');
  const { PLACES } = await import('../src/world/places.js');
  // A place with an authored cave interior renders a second row ('<short>-in',
  // see ui/jump-menu.js), so the interior rows are part of the derivation too.
  const interiorRows = PLACES.filter((p) => p.caveArrival).length;
  const wantRows = BIOME_COUNT + 2 + PLACES.length + interiorRows;
  check('the anchor list is complete', opened.rows === wantRows,
    `${opened.rows}/${wantRows} (${BIOME_COUNT} anchors + 2 stations + ${PLACES.length} places ` +
    `+ ${interiorRows} cave interior rows)`);
  check('input is gated while the menu is open', s.enabled === false,
    `input.enabled = ${s.enabled}, context '${s.context}'`);
  check('pointer lock is released and the lock hint is suppressed',
    !opened.locked && !opened.lockHint, '');

  // THE LEAK TEST. Nothing else in this suite would catch a broken input gate:
  // every other check wants the keys to work.
  const before = (await state(sock)).pos;
  await hold(sock, 'KeyW', 500);
  const afterHold = (await state(sock)).pos;
  const leaked = distXZ(before, afterHold);
  check('W does not reach the simulation while the menu is open', leaked < 0.25,
    `moved ${leaked.toFixed(3)} m in 500 ms of held W`);

  // Type a coordinate and submit it. The field must receive real text - which is
  // exactly what input.enabled = false buys, by disarming SWALLOW_CODES.
  await sock.eval(`(() => {
    const el = document.getElementById('jump-coords');
    el.focus();
  })()`);
  await sock.send('Input.insertText', { text: '-1888 -2120' });
  const typed = await sock.eval(`document.getElementById('jump-coords').value`);
  check('the coordinate field receives real keystrokes', typed === '-1888 -2120',
    JSON.stringify(typed));
  await sock.eval(`document.getElementById('jump-form')
    .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))`);
  await sleep(1200);

  s = await state(sock);
  const arrived = Math.hypot(s.pos[0] - -1888, s.pos[2] - -2120);
  check('typed coordinates jump the player there', arrived < 1.0,
    `${arrived.toFixed(2)} m from (-1888, -2120), depth ${s.depth.toFixed(0)} m`);
  check('the menu closed itself on the jump', !(await sock.eval(
    `window.subwave.jumpMenu.open`)), '');
  check('input is handed back after the menu closes', s.enabled === true,
    `input.enabled = ${s.enabled}`);

  // THE CAMERA-ATTACHMENT TEST. This is the live observable of the omitted
  // prevPosition bug, which put the camera a measured mean 447.71 m from the
  // player - permanently, because only simulate() refreshes prevPosition.
  const camGap = await sock.eval(`(async () => {
    const g = window.subwave;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const m = await import('/src/core/math.js');
    return +m.vec3.dist(g.renderer.camera.position, g.player.position).toFixed(3);
  })()`);
  check('the camera stays attached across the jump', camGap < 3.0,
    `${camGap} m from the player (eye height is 1.68 m)`);

  // The water column must be right on the FIRST frame, not two seconds later:
  // the spring's 2 s tau is correct for crossing a biome edge and wrong for a
  // teleport. Measured before the snap took a position: green sigmaT 0.0801
  // against a true 0.3025, a 3.8x error.
  const water = await sock.eval(`(async () => {
    const g = window.subwave;
    const B = await import('/src/world/biomes.js');
    const T = await import('/src/world/terrain.js');
    const c = g.renderer.camera.position;
    const h = T.sampleHeight(c[0], c[2]);
    const want = B.waterTypeAt(c[0], c[2], h, Math.max(0, -c[1]), T.sampleSlope(c[0], c[2]));
    const ratio = g._waterColumn.sigmaT[1] / want.sigmaT[1];
    return { name: g._waterColumn.name, want: want.name, ratio: +ratio.toFixed(4) };
  })()`);
  check('the water column snapped to the destination, not sprung toward it',
    water.name === water.want && Math.abs(water.ratio - 1) < 0.02,
    `${water.name}, green sigmaT ratio ${water.ratio}`);

  // Movement works again once the gate releases.
  const b2 = (await state(sock)).pos;
  await hold(sock, 'KeyW', 600);
  const moved = distXZ(b2, (await state(sock)).pos);
  check('the input gate released, so W moves again', moved > 1.0,
    `moved ${moved.toFixed(2)} m`);

  // J closes as well as opens. This is the regression guard for the edge that
  // survived hide() and re-opened the menu one frame later, every time.
  await key(sock, 'KeyJ', true); await key(sock, 'KeyJ', false);
  await sleep(400);
  const reopened = await sock.eval(`window.subwave.jumpMenu.open`);
  await key(sock, 'KeyJ', true); await key(sock, 'KeyJ', false);
  await sleep(600);
  const closed = await sock.eval(`(() => ({
    open: window.subwave.jumpMenu.open,
    enabled: window.subwave.input.enabled,
  }))()`);
  check('J closes the menu and it stays closed',
    reopened === true && closed.open === false && closed.enabled === true,
    `reopen ${reopened}, then closed ${!closed.open}, input ${closed.enabled}`);

  // In the vessel the HULL moves and the player rides it, and the chase spring
  // must not integrate the jump - forget _chaseValid and the camera is 3 km back.
  const inVessel = await sock.eval(`(async () => {
    const g = window.subwave;
    if (g.jumpMenu.open) g.jumpMenu.hide();
    g.vessel.board();
    g.player.inVessel = true;
    const before = Array.from(g.vessel.position);
    const r = g.jumpTo('trenchFloor');
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const m = await import('/src/core/math.js');
    return {
      hullMoved: +m.vec3.dist(before, g.vessel.position).toFixed(0),
      rider: +m.vec3.dist(g.player.position, g.vessel.position).toFixed(3),
      inVessel: g.player.inVessel,
      camGap: +m.vec3.dist(g.renderer.camera.position, g.vessel.position).toFixed(2),
      hullTier: g.vessel.hullTier, hull: g.vessel.hull,
      underwater: g.vessel.underwater, depth: +r.depth.toFixed(0),
    };
  })()`);
  check('an in-vessel jump moves the hull', inVessel.hullMoved > 1000,
    `${inVessel.hullMoved} m`);
  check('the player rides it', inVessel.inVessel && inVessel.rider < 0.01,
    `${inVessel.rider} m from the hull`);
  check('the hull medium latch is set, so the context is right immediately',
    inVessel.underwater === true, `depth ${inVessel.depth} m`);
  check('the hull tier was granted and the hull is intact',
    inVessel.hullTier >= 3 && inVessel.hull === 100,
    `tier ${inVessel.hullTier}, hull ${inVessel.hull}`);
  check('the chase camera did not spring across the jump', inVessel.camGap < 40,
    `${inVessel.camGap} m from the hull`);

  await sock.eval(`(() => {
    const g = window.subwave;
    g.player.exitVessel(g.vessel);
    g.jumpTo(2);
  })()`);
  await sleep(600);
}

// --- report -----------------------------------------------------------------
if (consoleErrors.length) {
  console.log(`\n  console errors (${consoleErrors.length}):`);
  const seen = new Set();
  for (const e of consoleErrors) {
    const k = e.slice(0, 120);
    if (seen.has(k)) continue;
    seen.add(k);
    console.log('    x ' + e.split('\n')[0].slice(0, 160));
  }
}

console.log(`\n${failures === 0 ? 'All input checks passed.' : `${failures} CHECK(S) FAILED.`}\n`);
cleanup();
process.exit(failures ? 1 : 0);
