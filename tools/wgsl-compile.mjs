#!/usr/bin/env node
/**
 * WGSL compilation check.
 *
 * tools/check.mjs validates the #include graph and brace balance, but it does
 * not know WGSL. Only a real implementation does. This launches headless Chrome,
 * preprocesses every shader with the project's own ShaderLibrary, hands the
 * result to createShaderModule, and reports the compilation diagnostics mapped
 * back to the ORIGINAL source file and line.
 *
 * That mapping matters: a shader assembled from six headers reports errors at
 * line 812 of the expanded text, which tells you nothing on its own.
 *
 * This is the fastest possible feedback loop for shader work - a few seconds,
 * versus booting the whole game and hoping the pass that uses the shader runs.
 *
 * Usage:
 *   node tools/wgsl-compile.mjs              all entry points
 *   node tools/wgsl-compile.mjs pass/ocean   only matching paths
 */

import { spawn } from 'node:child_process';
import { readdir, readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { RENDER, DEEP_TINT_REFERENCE_E, GLOW } from '../src/core/constants.js';

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
const SHADERS = join(ROOT, 'src/render/shaders');
let CDP_PORT = 0;   // assigned from freePort()
const FILTER = process.argv[2] || '';

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

/**
 * Defines the renderer supplies.
 *
 * DERIVED FROM constants.js, not transcribed from it. This list used to be a
 * hand-copy with a comment asking the next person to keep it in sync, which is
 * the same drift hazard that makes `check.mjs` necessary: a shader that reads a
 * constant the renderer defines and this tool does not simply fails to compile
 * here while working in the game, and one that reads a STALE value compiles
 * clean here and is wrong in the game. Only the values with no single correct
 * answer (the FFT specialisation sizes, the tier) stay literal.
 */
const DEFINES = {
  MAX_LIGHTS: RENDER.MAX_LIGHTS,
  MAX_LIGHTS_PER_CLUSTER: RENDER.MAX_LIGHTS_PER_CLUSTER,
  CLUSTER_X: RENDER.CLUSTER_X, CLUSTER_Y: RENDER.CLUSTER_Y, CLUSTER_Z: RENDER.CLUSTER_Z,
  // sim/cluster_cull.wgsl's copy of the RECEIVER's z grid. Deliberately not
  // named CLUSTER_NEAR / CLUSTER_FAR_*: a define is substituted whole-word into
  // every module, and those three names are `const` declarations in
  // common/lighting.wgsl. See RENDER.CLUSTER_CULL_UNION.
  CULL_NEAR: RENDER.CLUSTER_NEAR.toFixed(4),
  CULL_FAR_AIR: RENDER.CLUSTER_FAR_AIR.toFixed(1),
  CULL_FAR_WATER: RENDER.CLUSTER_FAR_WATER.toFixed(1),
  CLUSTER_CULL_UNION: RENDER.CLUSTER_CULL_UNION ? 1 : 0,
  SHADOW_CASCADES: RENDER.SHADOW_CASCADES,
  SHADOW_PCF_TAPS: 16,
  SHADOW_RESOLUTION: RENDER.SHADOW_RESOLUTION,
  SHADOW_UW_CUTOFF: RENDER.SHADOW_UNDERWATER_CUTOFF.toFixed(1),
  FROXEL_X: RENDER.FROXEL_X, FROXEL_Y: RENDER.FROXEL_Y, FROXEL_Z: RENDER.FROXEL_Z,
  FROXEL_MAX_DISTANCE: RENDER.FROXEL_MAX_DISTANCE.toFixed(1),
  FROXEL_DEPTH_POWER: RENDER.FROXEL_DEPTH_POWER.toFixed(1),
  CAUSTICS_MAX_DEPTH: RENDER.CAUSTICS_MAX_DEPTH.toFixed(1),
  CAUSTICS_SCALE: RENDER.CAUSTICS_SCALE.toFixed(1),
  CAUSTICS_RESOLUTION: RENDER.CAUSTICS_RESOLUTION,
  CAUSTIC_MAX_LOD: (RENDER.CAUSTICS_MIP_LEVELS - 1).toFixed(1),
  CAUSTIC_PEAK: RENDER.CAUSTICS_INTENSITY_CLAMP.toFixed(1),
  CAUSTIC_TAP2_SCALE: RENDER.CAUSTIC_TAP2_SCALE.toFixed(3),
  CAUSTIC_TAP2_LOD: Math.log2(RENDER.CAUSTIC_TAP2_SCALE).toFixed(6),
  CAUSTIC_TILE_MEAN_R: RENDER.CAUSTIC_TILE_MEAN[0].toFixed(5),
  CAUSTIC_TILE_MEAN_G: RENDER.CAUSTIC_TILE_MEAN[1].toFixed(5),
  CAUSTIC_TILE_MEAN_B: RENDER.CAUSTIC_TILE_MEAN[2].toFixed(5),
  CAUSTIC_COMPOSITE_MEAN_R: RENDER.CAUSTIC_COMPOSITE_MEAN[0].toFixed(5),
  CAUSTIC_COMPOSITE_MEAN_G: RENDER.CAUSTIC_COMPOSITE_MEAN[1].toFixed(5),
  CAUSTIC_COMPOSITE_MEAN_B: RENDER.CAUSTIC_COMPOSITE_MEAN[2].toFixed(5),
  AGX_LOOK_POWER: RENDER.AGX_LOOK_POWER.toFixed(3),
  AGX_LOOK_SATURATION: RENDER.AGX_LOOK_SATURATION.toFixed(3),
  VIGNETTE_FALLOFF: RENDER.VIGNETTE_FALLOFF.toFixed(3),
  VIGNETTE_POWER: RENDER.VIGNETTE_POWER.toFixed(1),
  CA_CENTRE: RENDER.CA_CENTRE.toFixed(8),
  CA_EDGE: RENDER.CA_EDGE.toFixed(8),
  DEEP_TINT_REFERENCE_E: DEEP_TINT_REFERENCE_E.toFixed(3),
  GLOW_SIGMA_PX: GLOW.SIGMA_PX.toFixed(3),
  SSAO_SAMPLES: RENDER.SSAO_SAMPLES,
  OCEAN_CASCADES: 3,
  MAX_BONES: RENDER.MAX_BONES_PER_CREATURE,
  QUALITY_TIER: 2,
  USE_SSR: 1, USE_SSAO: 1, USE_CLOUDS: 1, USE_CAUSTICS: 1,
  // The ocean FFT is specialised per cascade resolution at pipeline-creation
  // time, so these have no single "correct" value. We compile at the HIGH-tier
  // size, which is what matters for catching real errors.
  FFT_SIZE: 256,
  FFT_LOG2: 8,
  FFT_HALF: 128,
};

/**
 * Extra defines used ONLY when validating a header in isolation.
 *
 * Some headers are deliberately parameterised - common/ocean.wgsl lets the
 * includer pick its bind group, because the sim passes own group 0 while the
 * render passes reserve group 0 for the Frame. Such a header cannot compile
 * standalone without a choice being made for it.
 *
 * These are kept OUT of DEFINES on purpose: if they were always defined, a real
 * pass that forgot to declare its group would silently compile against group 0
 * instead of tripping the header's own #error guard.
 */
const HEADER_VALIDATION_DEFINES = {
  OCEAN_GROUP: 0,
  OCEAN_BINDING: 0,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (extname(e.name) === '.wgsl') out.push(p);
  }
  return out;
}

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

// --- minimal CDP over raw WebSocket (no dependencies) ----------------------

class Sock {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname; this.port = +u.port; this.path = u.pathname + u.search;
    this.buf = Buffer.alloc(0); this.pending = new Map(); this.id = 1;
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
      if (op === 1) {
        try {
          const m = JSON.parse(payload.toString('utf8'));
          if (m.id != null && this.pending.has(m.id)) {
            const { resolve, reject } = this.pending.get(m.id);
            this.pending.delete(m.id);
            m.error ? reject(new Error(m.error.message)) : resolve(m.result);
          }
        } catch { /* ignore */ }
      }
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
      }, 120000);
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

async function main() {
  const { ShaderLibrary } = await import(new URL('../src/core/shaderlib.js', import.meta.url).href);

  // Load every shader source and preprocess entry points on the Node side, so
  // the browser only has to compile - and so preprocessor errors are reported
  // here, with our own line mapping, rather than as WGSL syntax noise.
  const files = await walk(SHADERS);
  const lib = new ShaderLibrary({ root: SHADERS });
  for (const f of files) {
    const rel = relative(SHADERS, f).split(/[\\/]/).join('/');
    lib.put(rel, await readFile(f, 'utf8'));
  }

  const entries = [];
  const headers = [];
  for (const [rel, src] of lib.sources) {
    if (FILTER && !rel.includes(FILTER)) continue;
    if (/@(vertex|fragment|compute)\b/.test(src)) entries.push(rel);
    else headers.push(rel);
  }
  entries.sort();
  headers.sort();

  // A header is never compiled on its own, so a syntax error in one only
  // surfaces when some pass happens to include it - and then the error is
  // attributed to the pass. Wrap each header in a throwaway compute entry
  // point so every declaration is parsed and validated in isolation.
  //
  // The synthetic module is registered as a real source so #include resolves
  // relative to the shader root exactly as it would in production.
  for (const h of headers) {
    const synthetic = `zz-validate/${h.replace(/\//g, '-')}`;
    lib.put(synthetic,
      `#include "../${h}"\n` +
      '@compute @workgroup_size(1) fn wgslValidateEntry() {}\n');
    entries.push(synthetic);
  }

  if (entries.length === 0) {
    console.log('\nNo WGSL entry points found' + (FILTER ? ` matching '${FILTER}'` : '') + '.\n');
    process.exit(0);
  }

  console.log(`\nWGSL compile check  -  ${entries.length} entry point(s)\n`);

  // Preprocess, keeping each shader's line map for diagnostic remapping.
  const jobs = [];
  const preprocessErrors = [];
  for (const rel of entries) {
    try {
      // Synthetic header wrappers get the extra parameterisation defines; real
      // entry points must stand on their own.
      const isHeaderProbe = rel.startsWith('zz-validate/');
      const defines = isHeaderProbe
        ? { ...DEFINES, ...HEADER_VALIDATION_DEFINES }
        : DEFINES;
      const { code, map } = lib.preprocess(rel, defines);
      jobs.push({ rel, code, map });
    } catch (e) {
      preprocessErrors.push({ rel, message: e.message });
    }
  }

  for (const e of preprocessErrors) {
    console.log(`  x ${e.rel}\n      preprocessor: ${e.message}`);
  }

  if (jobs.length === 0) {
    console.log('\nNothing could be preprocessed.\n');
    process.exit(1);
  }

  // --- chrome -----------------------------------------------------------
  const chromePath = CHROME_PATHS.find((p) => existsSync(p));
  if (!chromePath) {
    console.error('Chrome not found. Looked in:\n  ' + CHROME_PATHS.join('\n  '));
    process.exit(1);
  }

  // WebGPU is only exposed in a SECURE CONTEXT. about:blank does not qualify,
  // so we serve a trivial page over http://127.0.0.1, which does.
  const SERVE_PORT = await freePort();
  CDP_PORT = await freePort();
  const server = spawn(process.execPath, ['server.mjs', '--port', String(SERVE_PORT)], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'],
  });
  if (!(await waitForPort(SERVE_PORT))) {
    console.error('Dev server did not start.');
    server.kill();
    process.exit(1);
  }

  const profile = join(ROOT, 'qa-output', 'wgsl-profile');
  await mkdir(profile, { recursive: true });

  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--enable-unsafe-webgpu', '--enable-features=Vulkan',
    `http://127.0.0.1:${SERVE_PORT}/tools/blank.html`,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  const cleanup = () => { try { chrome.kill(); } catch {} try { server.kill(); } catch {} };

  if (!(await waitForPort(CDP_PORT))) {
    console.error('Chrome did not expose its debugging port.');
    cleanup();
    process.exit(1);
  }

  // Give the page a moment to actually navigate before we evaluate in it.
  await sleep(1200);
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
  if (!page) {
    console.error('No page target available.');
    cleanup();
    process.exit(1);
  }
  const sock = new Sock(page.webSocketDebuggerUrl);
  await sock.connect();
  await sock.send('Runtime.enable');

  const haveGPU = await sock.eval(`(async () => {
    if (!navigator.gpu) return null;
    const a = await navigator.gpu.requestAdapter();
    if (!a) return null;
    window.__dev = await a.requestDevice();
    window.__dev.onuncapturederror = () => {};
    return true;
  })()`);

  if (!haveGPU) {
    console.error('\nHeadless Chrome could not provide a WebGPU device.\n' +
                  'Check chrome://gpu, and confirm the page is a secure context.\n');
    sock.close(); cleanup();
    process.exit(1);
  }

  // --- compile ------------------------------------------------------------
  let failures = 0;
  let warnings = 0;

  for (const job of jobs) {
    const encoded = Buffer.from(job.code, 'utf8').toString('base64');
    const result = await sock.eval(`(async () => {
      const code = new TextDecoder().decode(
        Uint8Array.from(atob(${JSON.stringify(encoded)}), c => c.charCodeAt(0)));
      window.__dev.pushErrorScope('validation');
      const m = window.__dev.createShaderModule({ code });
      const info = await m.getCompilationInfo();
      const scoped = await window.__dev.popErrorScope();
      return {
        messages: info.messages.map(x => ({
          type: x.type, line: x.lineNum, col: x.linePos, message: x.message,
        })),
        scopedError: scoped ? scoped.message : null,
      };
    })()`);

    const errs = result.messages.filter((m) => m.type === 'error');
    const warns = result.messages.filter((m) => m.type === 'warning');
    warnings += warns.length;

    if (errs.length === 0 && !result.scopedError) {
      const lines = job.code.split('\n').length;
      console.log(`  ok  ${job.rel.padEnd(34)} ${String(lines).padStart(5)} lines expanded` +
                  (warns.length ? `   (${warns.length} warning${warns.length > 1 ? 's' : ''})` : ''));
      for (const w of warns.slice(0, 4)) {
        const o = job.map[Math.max(0, Math.min(job.map.length - 1, w.line - 1))];
        console.log(`        ~ ${o ? `${o.file}:${o.line}` : '?'}  ${w.message.split('\n')[0]}`);
      }
      continue;
    }

    failures++;
    console.log(`\n  x  ${job.rel}`);
    const srcLines = job.code.split('\n');
    for (const m of errs.slice(0, 8)) {
      // Map the expanded line back to the file and line a human can open.
      const origin = job.map[Math.max(0, Math.min(job.map.length - 1, m.line - 1))];
      const where = origin ? `${origin.file}:${origin.line}` : `${job.rel}:?`;
      console.log(`       ${where}  (expanded line ${m.line})`);
      console.log(`         ${m.message.split('\n').join('\n         ')}`);
      const ctx = srcLines[m.line - 1];
      if (ctx) console.log(`         | ${ctx.trim().slice(0, 110)}`);
    }
    if (result.scopedError) {
      console.log(`       validation: ${result.scopedError.split('\n')[0]}`);
    }
  }

  sock.close();
  cleanup();

  const total = jobs.length + preprocessErrors.length;
  const bad = failures + preprocessErrors.length;
  console.log(`\n  ${total - bad}/${total} compiled` +
              (warnings ? `, ${warnings} warning(s)` : '') + '\n');

  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.error('\nwgsl-compile failed:', e);
  process.exit(1);
});
