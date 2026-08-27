#!/usr/bin/env node
/**
 * Framed screenshots of the running game.
 *
 * tools/qa.mjs owns the fixed regression scenarios and must keep its shot list
 * stable so a diff between runs means something. This is the other half of that
 * job: an arbitrary camera, on demand, for the view you are actually working
 * on. Judging water is impossible without pointing the camera at the sun, and
 * that is not a regression scenario.
 *
 *   node tools/shot.mjs --name glitter --setup "
 *     subwave.worldClock.setDayFraction(0.30);
 *     subwave.player.position.set([0, 2, 220]);
 *     subwave.renderer.camera.setEuler(subwave.sky.sunAzimuth, 0.02, 0);"
 *
 *   node tools/shot.mjs --list shots/water.json     several at once
 *
 * Output lands in shot-output/<name>.png - deliberately NOT qa-output, which
 * tools/qa.mjs wipes on every run.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './lib/browser.mjs';

/**
 * Pick a free TCP port.
 *
 * Same reason as probe.mjs and qa.mjs, which have had this for a while: this
 * tool used to hard-code 8096 and 9225, so two agents taking screenshots at
 * once collided and the second died with an opaque connection error. The
 * Chrome profile directory is made unique for the same reason - a second
 * headless Chrome pointed at a live profile refuses to start.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'shot-output');
// Assigned by launchBrowser below, which owns the ephemeral-port allocation for
// every browser tool here.
let PORT = 0;
let CDP_PORT = 0;

const args = process.argv.slice(2);
const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const NAME = flag('--name') || 'shot';
const SETUP = flag('--setup');
const LIST = flag('--list');
/** Real seconds of settling after the setup runs, before the capture. */
const SETTLE = Number(flag('--settle') || 1.2);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal CDP-over-WebSocket client. We ship no dependencies. */
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

// ---------------------------------------------------------------------------

const shots = LIST
  ? JSON.parse(await readFile(join(ROOT, LIST), 'utf8'))
  : [{ name: NAME, setup: SETUP || '' }];

await mkdir(OUT, { recursive: true });

// THE PROFILE USED TO GO INTO `shot-output/` BESIDE THE PNGs, AND NOTHING EVER
// REMOVED IT. Measured 2026-08-06, after test-variety.mjs had already been fixed
// for exactly this: 174 abandoned profile directories holding 8.6 GB, against
// 1.3 GB of actual screenshots. tools/lib/browser.mjs is that fix, shared, so it
// cannot be applied to one tool and missed on three.
const { chrome, port: PORT_, cdpPort: CDP_PORT_, cleanup } = await launchBrowser({
  tag: 'shot', root: ROOT, windowSize: '1600,900',
});
PORT = PORT_; CDP_PORT = CDP_PORT_;
await sleep(1500);

const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
const sock = new Sock(page.webSocketDebuggerUrl);
await sock.connect();
await sock.send('Runtime.enable');

const errors = [];
sock.onEvent = (m) => {
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  }
};

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

// Take the splash down by hand. start() runs the loop but nothing dismisses the
// overlay unless a real click does, and every capture would be a picture of it.
await sock.eval(`(() => {
  document.getElementById('boot')?.classList.add('hidden');
  window.subwave.start();
})()`).catch(() => {});
await sleep(2000);

// Setups need one thing the game does not expose: put the eye HERE, looking
// THERE, and keep it there. The player owns the camera (Player.applyCamera
// overwrites whatever Camera.setEuler was told), and it only rebuilds its
// orientation quaternion inside simulate(), which a paused game never calls -
// so a shot has to write yaw/pitch AND the quaternion AND both history slots,
// or the interpolator drags the eye back towards where the player really is.
await sock.eval(`(async () => {
  const { quat, vec3 } = await import('/src/core/math.js');
  window.__shot = {
    place(x, y, z, yaw, pitch) {
      const p = window.subwave.player;
      p.inVessel = false;
      p.position.set([x, y, z]);
      p.velocity.set([0, 0, 0]);
      vec3.copy(p.prevPosition, p.position);
      p.yaw = yaw;
      p.pitch = pitch;
      quat.fromEuler(p.orientation, yaw, pitch, 0);
      quat.copy(p.prevOrientation, p.orientation);
    },
    /**
     * Compass yaw that faces the sun, plus an optional offset in radians.
     * Verified against the HUD heading readout rather than derived: the
     * camera's forward basis comes out of quat.fromEuler, and guessing its
     * sign convention gives you a shot of the anti-solar sky.
     */
    sunYaw(offset) {
      const s = window.subwave.sky.sunDir;
      return Math.atan2(-s[0], s[2]) + (offset || 0);
    },
  };
})()`);

for (const shot of shots) {
  // Unpause first: a scenario that paused the previous shot would otherwise
  // freeze the ocean before this one's camera move has been rendered.
  await sock.eval('window.subwave.setPaused(false)').catch(() => {});
  if (shot.setup) {
    try {
      // The lock hint is a DOM overlay that sits in the middle of the frame
      // whenever the cursor is free, which it always is under CDP.
      await sock.eval(`(() => {
        ${shot.setup}
        // Same for the developer jump menu and its arrival toast: a setup that
        // uses subwave.jumpTo() leaves the toast up for 4 s, which is longer
        // than most settles.
        for (const id of ['lock-hint', 'jump-menu', 'jump-toast']) {
          const el = document.getElementById(id);
          if (el) el.style.display = 'none';
        }
      })()`);
    } catch (e) {
      console.error(`  ${shot.name}: setup threw: ${e.message}`);
      continue;
    }
  }
  await sleep(SETTLE * 1000);

  const stats = await sock.eval(`(async () => {
    const r = window.subwave.renderer;
    const s = await r.debugReadback('sceneColor', 64);
    return { lum: s && s.luminance, exposure: r.exposure,
             depth: r.env.cameraDepth, fps: window.subwave.fps };
  })()`).catch(() => null);

  const png = await sock.send('Page.captureScreenshot', { format: 'png' });
  const file = join(OUT, `${shot.name}.png`);
  await writeFile(file, Buffer.from(png.data, 'base64'));
  const lum = stats?.lum != null ? stats.lum.toFixed(4) : '?';
  console.log(`  ${shot.name.padEnd(22)} scene lum ${lum}  exposure ${(stats?.exposure ?? 0).toFixed(4)}  -> ${file}`);
}

if (errors.length) console.log('\n  console errors:\n    ' + errors.join('\n    '));
sock.close();
cleanup();
