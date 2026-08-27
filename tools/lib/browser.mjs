/**
 * SUBWAVE headless-browser plumbing, in one place.
 *
 * Four tools drive a real Chrome against a real dev server - `qa.mjs`,
 * `shot.mjs`, `probe.mjs` and `test-variety.mjs` - and every one of them had its
 * own copy of the same six things: find Chrome, take two free ports, start the
 * server, start the browser, wait for both, tear it all down. The copies drifted
 * exactly the way CLAUDE.md says copies of one truth drift, and the drift was
 * not cosmetic:
 *
 *   - `test-variety.mjs` was found on 2026-08-06 leaking a browser and a profile
 *     on every abnormal exit - two headless trees alive after 1h38m holding
 *     2.96 GB, and 128 abandoned profiles holding 13 GB - and was fixed.
 *   - `shot.mjs` and `probe.mjs` were NOT, because the fix lived in one file.
 *     Measured 2026-08-06, after that fix had already shipped: **174 abandoned
 *     profile directories holding 8.6 GB** under `shot-output/`.
 *   - `probe.mjs` additionally used a FIXED profile path inside `qa-output/`,
 *     which is the trap CLAUDE.md records for `test-input.mjs` (a second Chrome
 *     on a profile the first still holds hands over its URL and exits, so
 *     nothing ever listens on the new CDP port) AND is inside the one directory
 *     `qa.mjs` CLEARS at startup, so a concurrent QA run could delete a live
 *     probe's profile out from under it.
 *
 * So the three requirements CLAUDE.md says any browser tool here inherits are
 * implemented ONCE, below, and a new tool gets them by calling `launchBrowser`.
 *
 *   1. EVERY EXIT PATH IS COVERED - `exit`, SIGTERM, SIGHUP, SIGQUIT, SIGINT,
 *      `uncaughtException`, `unhandledRejection`. SIGINT alone is the one signal
 *      an agent harness never sends.
 *   2. CHROME IS KILLED WITH SIGKILL SPECIFICALLY SO THE PROFILE CAN BE
 *      UNLINKED. A graceful Chrome takes hundreds of ms to flush and unlink, and
 *      `exit` cannot await; a SIGTERM teardown lost that race every time it was
 *      measured.
 *   3. THERE IS A STARTUP REAPER, because nothing in-process survives the
 *      SIGKILL a harness sends to a hung tool. A stale profile is one whose port
 *      is no longer listening - the port is in the directory name, so the test
 *      is exact and cannot touch a concurrent run, which by construction holds
 *      its own port open.
 *
 * THE PROFILE LIVES IN THE OS TEMP DIRECTORY AND NOT IN THE REPOSITORY. That is
 * what keeps a browser profile out of `variety-output/` beside the committed
 * baselines, out of `shot-output/` beside the PNGs a human reads, and out of
 * `qa-output/`, which is wiped by another tool.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Where a headless Chrome might be. First hit wins.
 *
 * Chrome and not Chromium or Edge: WebGPU behind `--enable-unsafe-webgpu` is
 * what every one of these tools needs, and the channel matters for it.
 */
export const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/**
 * An OS-assigned free TCP port.
 *
 * EPHEMERAL ON PURPOSE, so two of these tools can run at once. Every fixed-port
 * or fixed-profile variant in this tree has produced a "chrome failed" that was
 * really a collision with an earlier run.
 *
 * @returns {Promise<number>}
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * Is anything listening on this port RIGHT NOW? One attempt, no retry.
 *
 * Separate from `waitForPort` because the reaper asks the opposite question:
 * `waitForPort` asks "will this come up", which takes 20 s to answer NO, and the
 * reaper asks "is this dead" about every abandoned directory in tmp.
 *
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function portIsOpen(port) {
  return new Promise((resolve) => {
    const s = connect(port, '127.0.0.1', () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(400, () => { s.destroy(); resolve(false); });
  });
}

/**
 * Wait for something to accept a TCP connection on a port.
 *
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>} true once it answers
 */
export async function waitForPort(port, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await portIsOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

/**
 * Remove every stale profile directory this tool family has left in tmp.
 *
 * Stale means "the port in the directory name is no longer listening". A live
 * concurrent run holds its own port open by construction, so it can never be
 * reaped by another run - which is what makes overlapping tours safe.
 *
 * @param {string} tag the tool's own tag, e.g. 'variety'
 * @param {number} keepPort the caller's own port, never reaped
 */
async function reapStaleProfiles(tag, keepPort) {
  const re = new RegExp(`^subwave-${tag}-(\\d+)$`);
  for (const dir of existsSync(tmpdir()) ? readdirSync(tmpdir()) : []) {
    const m = re.exec(dir);
    if (!m || Number(m[1]) === keepPort) continue;
    if (await portIsOpen(Number(m[1]))) continue;   // a live run owns it
    try { rmSync(join(tmpdir(), dir), { recursive: true, force: true }); } catch { /* next time */ }
  }
}

/**
 * Start the dev server and a headless Chrome pointed at it, with the whole
 * teardown contract installed.
 *
 * @param {object} opts
 * @param {string} opts.tag short tool name; names the profile directory and is
 *   the reaper's key. Must be unique per tool.
 * @param {string} opts.root repository root, the server's cwd
 * @param {string} [opts.windowSize] `--window-size` value, default '1600,900'
 * @param {string[]} [opts.extraArgs] extra Chrome flags
 * @param {boolean} [opts.noVsync] add the two flags that unblock the swap AND
 *   unpace BeginFrame. Both are needed: `--disable-gpu-vsync` alone leaves rAF
 *   quantised to the display period.
 * @param {(msg: string) => void} [opts.onFail] called before exit(1) on a
 *   startup failure; defaults to console.error
 * @returns {Promise<{server: object, chrome: object, port: number,
 *   cdpPort: number, profile: string, cleanup: () => void,
 *   fail: (msg: string) => never}>}
 *   `cleanup` is idempotent and safe to call from a handler; `fail` reports,
 *   tears down and exits 1.
 */
export async function launchBrowser(opts) {
  const {
    tag, root, windowSize = '1600,900', extraArgs = [], noVsync = false,
    onFail = (m) => console.error(m),
  } = opts;

  const chromePath = CHROME_PATHS.find((p) => existsSync(p));
  if (!chromePath) { onFail('Chrome not found.'); process.exit(1); }

  const port = await freePort();
  const cdpPort = await freePort();

  const server = spawn(process.execPath, ['server.mjs', '--port', String(port)],
    { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] });
  if (!(await waitForPort(port))) {
    onFail('server failed');
    try { server.kill('SIGKILL'); } catch { /* already gone */ }
    process.exit(1);
  }

  const profile = join(tmpdir(), `subwave-${tag}-${port}`);
  await reapStaleProfiles(tag, port);

  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--enable-unsafe-webgpu', '--enable-features=Vulkan',
    `--window-size=${windowSize}`, '--hide-scrollbars', '--mute-audio',
    ...(noVsync ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
    ...extraArgs,
    `http://127.0.0.1:${port}/`,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  // `once` matters: the exit path can be reached twice (a signal that then falls
  // through to 'exit'), and a second kill on a reaped pid throws inside a
  // handler. The profile is removed SYNCHRONOUSLY because 'exit' cannot await,
  // and it is removed LAST so a crash mid-teardown still stops the processes.
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try { chrome.kill('SIGKILL'); } catch { /* already gone */ }
    try { server.kill('SIGKILL'); } catch { /* already gone */ }
    // Retried because the kill is delivered asynchronously even when it is
    // immediate: the first attempt can still see an open mapping.
    for (let i = 0; i < 20; i++) {
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 4 }); break; }
      catch { /* Chrome has not released it yet */ }
    }
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    process.on(sig, () => { cleanup(); process.exit(1); });
  }
  // A throw or a rejected promise past this point would otherwise orphan Chrome
  // with no signal at all, which is how the 1h38m trees survived.
  process.on('uncaughtException', (e) => { cleanup(); console.error(e); process.exit(1); });
  process.on('unhandledRejection', (e) => { cleanup(); console.error(e); process.exit(1); });

  const fail = (msg) => { onFail(msg); cleanup(); process.exit(1); };
  if (!(await waitForPort(cdpPort))) fail('chrome failed to start');

  return { server, chrome, port, cdpPort, profile, cleanup, fail };
}
