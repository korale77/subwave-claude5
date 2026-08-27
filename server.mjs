/**
 * SUBWAVE dev server.
 *
 * Zero dependencies. Serves the project root as static files with the MIME
 * types WebGPU/ESM development needs, plus the cross-origin isolation headers
 * required for SharedArrayBuffer (used by the terrain streaming workers).
 *
 *   node server.mjs [--port 8080] [--host 127.0.0.1]
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(argOf('--port', process.env.PORT || 8080));
const HOST = argOf('--host', '127.0.0.1');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wgsl': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
};

/** Resolve a URL path to a file inside ROOT, or null if it escapes the root. */
function resolveSafe(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const rel = normalize(p).replace(/^([/\\])+/, '');
  if (rel === '..' || rel.startsWith('..' + sep)) return null;
  return join(ROOT, rel);
}

const server = createServer(async (req, res) => {
  const started = process.hrtime.bigint();
  const file = resolveSafe(req.url || '/');

  const finish = (code) => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const tag = code >= 400 ? '!' : ' ';
    process.stdout.write(`${tag} ${code} ${(req.url || '').slice(0, 90)}  ${ms.toFixed(1)}ms\n`);
  };

  if (!file) {
    res.writeHead(403).end('Forbidden');
    return finish(403);
  }

  let info;
  try {
    info = await stat(file);
    if (info.isDirectory()) {
      info = await stat(join(file, 'index.html'));
    }
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found: ' + req.url);
    return finish(404);
  }

  const target = info.isDirectory() ? join(file, 'index.html') : file;
  const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': info.size,
    // No caching: this is a dev server and we edit shaders constantly.
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    // Cross-origin isolation -> SharedArrayBuffer available for worker streaming.
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });

  if (req.method === 'HEAD') {
    res.end();
    return finish(200);
  }

  createReadStream(target).pipe(res);
  finish(200);
});

server.listen(PORT, HOST, () => {
  process.stdout.write(
    `\n  SUBWAVE dev server\n  http://${HOST}:${PORT}/\n  root: ${ROOT}\n  (cross-origin isolated; WGSL served as text/plain)\n\n`,
  );
});
