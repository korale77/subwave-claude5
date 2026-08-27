#!/usr/bin/env node
/**
 * Generate src/render/shaders/manifest.js.
 *
 * The browser cannot enumerate a directory, so the shader library needs an
 * explicit list of what to fetch at boot. Rather than hand-maintain that list -
 * which drifts the moment anyone adds a shader - it is generated from disk, and
 * tools/check.mjs verifies it is still current.
 *
 * Run:  node tools/gen-shader-manifest.mjs [--check]
 *   --check exits non-zero if the manifest is stale, without writing.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHADERS = join(ROOT, 'src/render/shaders');
const OUT = join(SHADERS, 'manifest.js');
const CHECK_ONLY = process.argv.includes('--check');

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (extname(e.name) === '.wgsl') out.push(p);
  }
  return out;
}

const files = (await walk(SHADERS))
  .map((f) => relative(SHADERS, f).split(/[\\/]/).join('/'))
  .sort();

const entryPoints = [];
for (const rel of files) {
  const src = await readFile(join(SHADERS, rel), 'utf8');
  if (/@(vertex|fragment|compute)\b/.test(src)) entryPoints.push(rel);
}

const content = `/**
 * GENERATED FILE - do not edit.
 * Regenerate with: node tools/gen-shader-manifest.mjs
 *
 * The browser cannot list a directory, so the shader library is told explicitly
 * what to fetch at boot. tools/check.mjs fails if this drifts from disk.
 */

/** Every .wgsl file in the project, including headers. */
export const SHADER_FILES = ${JSON.stringify(files, null, 2).replace(/"/g, "'")};

/** The subset that declares a @vertex, @fragment or @compute entry point. */
export const SHADER_ENTRY_POINTS = ${JSON.stringify(entryPoints, null, 2).replace(/"/g, "'")};
`;

let existing = null;
try { existing = await readFile(OUT, 'utf8'); } catch { /* first run */ }

if (CHECK_ONLY) {
  if (existing !== content) {
    console.error('Shader manifest is STALE. Run: node tools/gen-shader-manifest.mjs');
    process.exit(1);
  }
  console.log(`Shader manifest current (${files.length} files, ${entryPoints.length} entry points).`);
  process.exit(0);
}

if (existing === content) {
  console.log(`Shader manifest already current (${files.length} files).`);
} else {
  await writeFile(OUT, content);
  console.log(`Wrote manifest: ${files.length} files, ${entryPoints.length} entry points.`);
}
