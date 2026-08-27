#!/usr/bin/env node
/**
 * Live probe: boot the game in Chrome and evaluate an arbitrary expression
 * against the running `subwave` instance.
 *
 * This is the debugger for "it runs but the screen is black" - the class of bug
 * that produces no error at all, so neither the static checker nor the shader
 * compiler can see it.
 *
 *   node tools/probe.mjs "subwave.renderer.graph.describe()"
 *   node tools/probe.mjs --file tools/probes/glow-census.js
 */

import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { launchBrowser } from './lib/browser.mjs';

/**
 * Pick a free TCP port.
 *
 * These tools launch a dev server and a Chrome debug endpoint. With fixed
 * ports, two runs at once (several agents verifying in parallel, or a manual
 * run alongside CI) collide and fail with an opaque connection error. Asking
 * the OS for an ephemeral port makes concurrent runs safe.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
let PORT = 0;   // assigned from freePort()
let CDP_PORT = 0;   // assigned from freePort()

const args = process.argv.slice(2);
const FILE = args.includes('--file') ? args[args.indexOf('--file') + 1] : null;
const EXPR = FILE ? null : args.filter((a) => !a.startsWith('--')).join(' ');

/**
 * `--no-vsync` (or SUBWAVE_NO_VSYNC=1): unlock the presentation cadence.
 *
 * WITHOUT IT NO COST PROBE CAN MEASURE ANYTHING. Chrome drives requestAnimationFrame
 * off the compositor's vsync even in headless, so every frame interval this harness
 * can observe is quantised to the refresh period - measured here, four consecutive
 * A/B arms of a real `graph.setDisabled('scatter')` reported p50 8.09 / 8.27 / 8.29 /
 * 8.27 ms against a 120 Hz period of 8.333 ms, i.e. the scatter pass appeared to cost
 * 0.00 ms whether it ran or not. A pass has to push the frame PAST the period before
 * a wall-clock median moves at all, so an A/B on a frame with any headroom left reads
 * as noise, and one that crosses the boundary reads as a step of a whole period.
 *
 * OFF BY DEFAULT, deliberately. Uncapped rAF spins the GPU flat out, which changes
 * thermal and clock behaviour and makes the game itself run at several hundred steps
 * a second; it is the right configuration for measuring a cost and the wrong one for
 * measuring anything else. `tools/probes/motion-budget.js` refuses to report a median
 * that sits on the cadence, so a run that forgot the flag is VOID rather than plausible.
 */
const NO_VSYNC = args.includes('--no-vsync') || process.env.SUBWAVE_NO_VSYNC === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// THE PROFILE USED TO BE THE FIXED PATH `qa-output/probe-profile`, AND THAT WAS
// TWO BUGS. A second headless Chrome on a profile the first still holds hands
// its URL to the incumbent and exits, so nothing ever listens on the new CDP
// port and this tool reported "chrome failed" - the trap CLAUDE.md records for
// test-input.mjs. And `qa-output/` is the one directory `qa.mjs` CLEARS at
// startup, so a concurrent QA run could delete a live probe's profile out from
// under it. tools/lib/browser.mjs puts it in tmp, names it for the port, and
// reaps what an earlier run could not.
const { chrome, port: PORT_, cdpPort: CDP_PORT_, cleanup } = await launchBrowser({
  tag: 'probe', root: ROOT, windowSize: '1280,720', noVsync: NO_VSYNC,
});
PORT = PORT_; CDP_PORT = CDP_PORT_;
if (NO_VSYNC) console.error('[probe] vsync disabled: frame intervals are real cost, not cadence');
await sleep(1500);

const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
const sock = new Sock(page.webSocketDebuggerUrl);
await sock.connect();
await sock.send('Runtime.enable');

const logs = [];
sock.onEvent = (m) => {
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    logs.push(`[${m.params.type}] ${text}`);
  }
};

// Wait for boot.
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

await sock.eval('window.subwave.start()').catch(() => {});
await sleep(2500);

const expression = FILE ? await readFile(FILE, 'utf8') : `(() => (${EXPR}))()`;
try {
  const result = await sock.eval(
    `(async () => { const r = await (async () => { ${FILE ? expression : `return ${expression}`} })();
       return typeof r === 'string' ? r : JSON.stringify(r, null, 2); })()`);
  console.log(result);
} catch (e) {
  console.error('probe threw:', e.message);
}

if (logs.length) {
  console.log('\n--- console ---');
  for (const l of logs.slice(-30)) console.log(l);
}

cleanup();
