#!/usr/bin/env node
/**
 * SUBWAVE static checker.
 *
 * Runs entirely offline (no browser, no GPU) and catches the failure modes that
 * actually bite when a large codebase is written by many hands at once:
 *
 *   1. JS syntax errors                (node --check, ESM mode)
 *   2. Unresolvable relative imports   (typo'd paths, wrong depth, missing .js)
 *   3. Imports of names a module does not export  <- the big one
 *   4. Duplicate exports within a module
 *   5. Import cycles
 *   6. WGSL #include graph errors + preprocessor failures for every entry point
 *   7. WGSL sanity: unbalanced braces, unknown bind group indices, stray tabs
 *
 * Usage:  node tools/check.mjs [--quiet] [--json]
 * Exit code is non-zero when any error is found, so it works as a gate.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = join(ROOT, 'src');
const SHADERS = join(SRC, 'render', 'shaders');

const args = process.argv.slice(2);
const QUIET = args.includes('--quiet');
const JSON_OUT = args.includes('--json');

const errors = [];
const warnings = [];
const err = (file, msg) => errors.push({ file: relative(ROOT, file), msg });
const warn = (file, msg) => warnings.push({ file: relative(ROOT, file), msg });

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

async function walk(dir, exts, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    // tools/probes holds probe.mjs --file scripts. They are evaluated as the
    // body of an async function inside the page, so a bare `return` is correct
    // there and they are deliberately not modules; parsing them as modules
    // reports a syntax error for every one of them.
    if (e.name === 'probes' && e.isDirectory()) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, exts, out);
    else if (exts.includes(extname(e.name))) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lightweight JS source scanning
// ---------------------------------------------------------------------------

/**
 * Strip comments, string bodies and regex literals so the scanning regexes
 * below only ever see code. Not a real parser, but it handles the constructs
 * this codebase actually uses - including regex literals, which naive strippers
 * mistake for division followed by a string.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 0; // 0 code, 1 line comment, 2 block comment, 3 string, 4 template, 5 regex
  let quote = '';
  let templateDepth = 0;
  let inCharClass = false;

  // A `/` begins a regex literal when the previous significant token cannot end
  // an expression. Otherwise it is division.
  const regexAllowedHere = () => {
    for (let k = out.length - 1; k >= 0; k--) {
      const ch = out[k];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
      if (/[)\]}]/.test(ch)) return false;
      if (/[\w$]/.test(ch)) {
        // Keywords like return/typeof/case may precede a regex; identifiers may not.
        let e = k + 1, s = k;
        while (s >= 0 && /[\w$]/.test(out[s])) s--;
        const word = out.slice(s + 1, e);
        return ['return', 'typeof', 'instanceof', 'in', 'of', 'case', 'do', 'else',
                'yield', 'await', 'delete', 'void', 'new'].includes(word);
      }
      return true; // operators, commas, brackets-open, semicolons...
    }
    return true;
  };

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 0) {
      if (c === '/' && c2 === '/') { state = 1; i += 2; out += '  '; continue; }
      if (c === '/' && c2 === '*') { state = 2; i += 2; out += '  '; continue; }
      if (c === '/' && regexAllowedHere()) { state = 5; inCharClass = false; out += ' '; i++; continue; }
      if (c === '"' || c === "'") { state = 3; quote = c; out += c; i++; continue; }
      if (c === '`') { state = 4; templateDepth = 0; out += c; i++; continue; }
      out += c; i++;
    } else if (state === 5) {
      // Inside a regex literal: blank it out, tracking escapes and char classes.
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === '[') inCharClass = true;
      else if (c === ']') inCharClass = false;
      else if (c === '/' && !inCharClass) {
        state = 0;
        out += ' ';
        i++;
        while (i < n && /[a-z]/.test(src[i])) { out += ' '; i++; } // flags
        continue;
      } else if (c === '\n') { state = 0; out += '\n'; i++; continue; } // unterminated: bail
      out += ' ';
      i++;
    } else if (state === 1) {
      if (c === '\n') { state = 0; out += '\n'; }
      i++;
    } else if (state === 2) {
      if (c === '*' && c2 === '/') { state = 0; i += 2; continue; }
      out += c === '\n' ? '\n' : ' ';
      i++;
    } else if (state === 3) {
      out += c;
      if (c === '\\') { out += c2 || ''; i += 2; continue; }
      if (c === quote) state = 0;
      i++;
    } else {
      out += c;
      if (c === '\\') { out += c2 || ''; i += 2; continue; }
      if (c === '$' && c2 === '{') { templateDepth++; out += c2; i += 2; continue; }
      if (c === '}' && templateDepth > 0) { templateDepth--; i++; continue; }
      if (c === '`' && templateDepth === 0) state = 0;
      i++;
    }
  }
  return out;
}


/**
 * Like stripComments, but ALSO blanks the inside of string and template
 * literals. The import scanner needs string contents (module paths live there),
 * so it cannot use this - but any scan looking for real identifiers must, or
 * prose inside an error message reads as code. "must expose sampleHeight(x, z)"
 * in a thrown Error is not a call to sampleHeight.
 */
function stripCommentsAndStrings(src) {
  const noComments = stripComments(src);
  let out = '';
  let i = 0;
  let quote = '';
  while (i < noComments.length) {
    const c = noComments[i];
    if (!quote) {
      if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
      out += c; i++;
    } else {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === quote) { quote = ''; out += c; i++; continue; }
      out += c === '\n' ? '\n' : ' ';
      i++;
    }
  }
  return out;
}

/** Collect the names a module exports. */
function collectExports(src, file) {
  const names = new Set();
  const dupes = [];
  const add = (n) => {
    if (!n) return;
    if (names.has(n)) dupes.push(n);
    names.add(n);
  };

  // export function foo / export async function foo / export class Foo
  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)) add(m[1]);

  // export const/let/var  — including destructuring lists
  for (const m of src.matchAll(/^\s*export\s+(?:const|let|var)\s+([^=;\n]+)/gm)) {
    const decl = m[1].trim();
    if (decl.startsWith('{') || decl.startsWith('[')) {
      for (const id of decl.matchAll(/([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?/g)) {
        add(id[2] || id[1]);
      }
    } else {
      add(decl.split(/[\s,]/)[0]);
    }
  }

  // export { a, b as c }  (with or without a from-clause)
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      add((as[1] || as[0]).trim());
    }
  }

  if (/^\s*export\s+default\b/m.test(src)) add('default');

  // export * from './x.js' — record for transitive resolution
  const stars = [...src.matchAll(/^\s*export\s+\*\s+from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);

  for (const d of dupes) err(file, `duplicate export '${d}'`);
  return { names, stars };
}

/** Collect the imports a module makes. */
function collectImports(src) {
  const imports = [];
  const re = /^\s*import\s+(?:([^'"]+?)\s+from\s+)?['"]([^'"]+)['"]/gm;
  for (const m of src.matchAll(re)) {
    const clause = (m[1] || '').trim();
    const spec = m[2];
    const named = [];
    let defaultImport = null;
    let namespace = null;

    if (clause) {
      const braceStart = clause.indexOf('{');
      const head = braceStart >= 0 ? clause.slice(0, braceStart) : clause;
      const body = braceStart >= 0 ? clause.slice(braceStart + 1, clause.lastIndexOf('}')) : '';

      const headTrim = head.replace(/,\s*$/, '').trim();
      if (headTrim.startsWith('* as ')) namespace = headTrim.slice(5).trim();
      else if (headTrim) defaultImport = headTrim;

      for (const part of body.split(',')) {
        const t = part.trim();
        if (!t) continue;
        const as = t.split(/\s+as\s+/);
        named.push({ imported: as[0].trim(), local: (as[1] || as[0]).trim() });
      }
    }
    // Dynamic import('...') is handled separately below.
    imports.push({ spec, named, defaultImport, namespace, line: lineOf(src, m.index) });
  }

  // Dynamic imports: only check that the path resolves.
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    imports.push({ spec: m[1], named: [], defaultImport: null, namespace: null, dynamic: true, line: lineOf(src, m.index) });
  }
  return imports;
}

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function checkJavaScript() {
  const files = [
    ...(await walk(SRC, ['.js'])),
    ...(await walk(join(ROOT, 'tools'), ['.mjs', '.js'])),
    join(ROOT, 'server.mjs'),
  ].filter((f) => existsSync(f));

  if (files.length === 0) {
    warn(SRC, 'no JavaScript sources found');
    return { files, modules: new Map() };
  }

  // 1. Syntax
  const syntaxResults = await Promise.all(files.map(async (f) => {
    try {
      await execFileAsync(process.execPath, ['--check', f], { cwd: ROOT });
      return null;
    } catch (e) {
      const msg = (e.stderr || e.message || '').split('\n').filter(Boolean).slice(0, 6).join('\n    ');
      return { file: f, msg };
    }
  }));
  for (const r of syntaxResults) if (r) err(r.file, `syntax error:\n    ${r.msg}`);

  // 2. Build the module graph.
  const modules = new Map();
  for (const f of files) {
    const raw = await readFile(f, 'utf8');
    const src = stripComments(raw);
    const { names, stars } = collectExports(src, f);
    modules.set(f, {
      file: f,
      exports: names,
      starExports: stars,
      imports: collectImports(src),
      lines: raw.split('\n').length,
      bytes: raw.length,
    });
  }

  // 3. Resolve imports, check paths and named bindings.
  const resolveSpec = (fromFile, spec) => {
    if (!spec.startsWith('.') && !spec.startsWith('/')) return null; // bare/builtin
    const base = spec.startsWith('/') ? join(ROOT, spec) : resolve(dirname(fromFile), spec);
    for (const candidate of [base, base + '.js', join(base, 'index.js')]) {
      if (existsSync(candidate)) return candidate;
    }
    return undefined; // unresolved
  };

  const exportsOf = (file, seen = new Set()) => {
    const mod = modules.get(file);
    if (!mod || seen.has(file)) return new Set();
    seen.add(file);
    const all = new Set(mod.exports);
    for (const s of mod.starExports) {
      const target = resolveSpec(file, s);
      if (target) for (const n of exportsOf(target, seen)) all.add(n);
    }
    return all;
  };

  for (const mod of modules.values()) {
    for (const imp of mod.imports) {
      const target = resolveSpec(mod.file, imp.spec);
      if (target === null) continue;   // external / node builtin
      if (target === undefined) {
        err(mod.file, `line ${imp.line}: cannot resolve import '${imp.spec}'`);
        continue;
      }
      if (imp.dynamic) continue;
      const available = exportsOf(target);
      for (const { imported } of imp.named) {
        if (imported && !available.has(imported)) {
          err(mod.file,
            `line ${imp.line}: '${imported}' is not exported by ${relative(ROOT, target)}` +
            (available.size ? `\n    available: ${[...available].sort().slice(0, 24).join(', ')}${available.size > 24 ? ', ...' : ''}` : ''));
        }
      }
      if (imp.defaultImport && !available.has('default')) {
        err(mod.file, `line ${imp.line}: ${relative(ROOT, target)} has no default export`);
      }
    }
  }

  // 4. Undefined identifiers that LOOK like imports we forgot.
  //
  // Checking that every imported name is exported catches half the problem; the
  // other half is using a name you never imported at all, which is a runtime
  // ReferenceError the browser only reports when that line executes. We cannot
  // do real scope analysis here, but we can catch the common case: a call to a
  // bare lowerCamelCase helper that is exported by one of our own core modules
  // and is neither imported nor declared locally.
  {
    const coreExports = new Map();   // name -> module that exports it
    for (const mod of modules.values()) {
      if (!/\/(core|world)\//.test(mod.file)) continue;
      for (const n of mod.exports) {
        if (!coreExports.has(n)) coreExports.set(n, mod.file);
      }
    }

    for (const mod of modules.values()) {
      const raw = await readFile(mod.file, 'utf8');
      const src = stripCommentsAndStrings(raw);

      // Everything this module has legitimately brought into scope.
      const inScope = new Set();
      for (const imp of mod.imports) {
        for (const { local } of imp.named) inScope.add(local);
        if (imp.defaultImport) inScope.add(imp.defaultImport);
        if (imp.namespace) inScope.add(imp.namespace);
      }
      for (const n of mod.exports) inScope.add(n);
      // Plain declarations.
      for (const m of src.matchAll(/\b(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) {
        inScope.add(m[1]);
      }
      // DESTRUCTURED declarations, including the dynamic-import form
      //   const { readTexture2D } = await import('...')
      // which is how several modules legitimately pull in a helper lazily.
      for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
        for (const part of m[1].split(',')) {
          const t = part.trim();
          if (!t) continue;
          const as = t.split(/\s*:\s*/);
          const name = (as[1] || as[0]).trim();
          if (/^[A-Za-z_$][\w$]*$/.test(name)) inScope.add(name);
        }
      }
      // CLASS AND OBJECT METHODS. `mat3(m) { ... }` inside a class declares a
      // method, not a call to a free function of the same name.
      for (const m of src.matchAll(/(?:^|[{,;])\s*(?:static\s+|async\s+|get\s+|set\s+|\*)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) {
        inScope.add(m[1]);
      }
      // Object-literal shorthand and arrow properties.
      for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:=|:)\s*(?:async\s*)?(?:function|\()/g)) {
        inScope.add(m[1]);
      }

      for (const m of src.matchAll(/(^|[^.\w$])([a-z][A-Za-z0-9_$]{2,})\s*\(/g)) {
        const name = m[2];
        if (inScope.has(name)) continue;
        if (!coreExports.has(name)) continue;
        // Skip anything that is a property access or a declaration we missed.
        err(mod.file,
          `'${name}()' is used but never imported - it is exported by ` +
          `${relative(ROOT, coreExports.get(name))}`);
      }
    }
  }

  // 5. Import cycles (warning: legal in ESM but a design smell here).
  const graph = new Map();
  for (const mod of modules.values()) {
    const deps = [];
    for (const imp of mod.imports) {
      if (imp.dynamic) continue;
      const t = resolveSpec(mod.file, imp.spec);
      if (t) deps.push(t);
    }
    graph.set(mod.file, deps);
  }
  const state = new Map();
  const stack = [];
  const reported = new Set();
  const visit = (n) => {
    if (state.get(n) === 2) return;
    if (state.get(n) === 1) {
      const i = stack.indexOf(n);
      const cycle = stack.slice(i).concat(n).map((f) => relative(ROOT, f));
      const key = [...cycle].sort().join('|');
      if (!reported.has(key)) {
        reported.add(key);
        warn(n, `import cycle: ${cycle.join(' -> ')}`);
      }
      return;
    }
    state.set(n, 1);
    stack.push(n);
    for (const d of graph.get(n) || []) visit(d);
    stack.pop();
    state.set(n, 2);
  };
  for (const n of graph.keys()) visit(n);

  return { files, modules };
}

// ---------------------------------------------------------------------------
// WGSL
// ---------------------------------------------------------------------------

async function checkWGSL() {
  const files = await walk(SHADERS, ['.wgsl']);
  if (files.length === 0) {
    warn(SHADERS, 'no WGSL shaders found');
    return { files: [], entries: [] };
  }

  const { ShaderLibrary } = await import(new URL('../src/core/shaderlib.js', import.meta.url).href);
  const lib = new ShaderLibrary({ root: SHADERS });

  const sources = new Map();
  for (const f of files) {
    const rel = relative(SHADERS, f).split(/[\\/]/).join('/');
    const text = await readFile(f, 'utf8');
    sources.set(rel, text);
    lib.put(rel, text);
  }

  // Entry points are shaders that declare a @vertex/@fragment/@compute stage.
  const entries = [];
  for (const [rel, text] of sources) {
    if (/@(vertex|fragment|compute)\b/.test(text)) entries.push(rel);
  }

  // Defines the real renderer supplies. Kept in sync by hand; a missing one
  // shows up here as a preprocessor failure rather than a runtime shader error.
  const DEFINES = {
    MAX_LIGHTS: 256,
    MAX_SPOT_LIGHTS: 32,
    SHADOW_CASCADES: 4,
    SHADOW_PCF_TAPS: 16,
    CLUSTER_X: 16, CLUSTER_Y: 9, CLUSTER_Z: 24,
    FROXEL_X: 160, FROXEL_Y: 90, FROXEL_Z: 64,
    OCEAN_CASCADES: 3,
    MAX_BONES: 24,
    QUALITY_TIER: 2,
    USE_SSR: 1,
    USE_SSAO: 1,
    USE_CLOUDS: 1,
    USE_CAUSTICS: 1,
    WORKGROUP_SIZE: 64,
  };

  for (const entry of entries) {
    try {
      const { code } = lib.preprocess(entry, DEFINES);

      // Cheap structural sanity checks. A real WGSL parse happens in Chrome.
      let depth = 0;
      let inLineComment = false, inBlockComment = false;
      for (let i = 0; i < code.length; i++) {
        const c = code[i], c2 = code[i + 1];
        if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
        if (inBlockComment) { if (c === '*' && c2 === '/') { inBlockComment = false; i++; } continue; }
        if (c === '/' && c2 === '/') { inLineComment = true; i++; continue; }
        if (c === '/' && c2 === '*') { inBlockComment = true; i++; continue; }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        if (depth < 0) { err(join(SHADERS, entry), 'unbalanced braces (extra `}`) after preprocessing'); break; }
      }
      if (depth > 0) err(join(SHADERS, entry), `unbalanced braces (${depth} unclosed \`{\`) after preprocessing`);

      // Bind groups must stay within the 4 declared slots.
      for (const m of code.matchAll(/@group\((\d+)\)/g)) {
        if (+m[1] > 3) err(join(SHADERS, entry), `@group(${m[1]}) exceeds the 4 bind-group budget`);
      }
      // Leftover directives mean a preprocessor bug or a typo'd directive.
      for (const m of code.matchAll(/^\s*#\s*(\w+)/gm)) {
        err(join(SHADERS, entry), `unprocessed preprocessor directive '#${m[1]}' survived expansion`);
      }
    } catch (e) {
      err(join(SHADERS, entry), `preprocessor: ${e.message}`);
    }
  }

  // The generated manifest must match what is actually on disk, or the browser
  // will silently fail to fetch a shader that exists.
  try {
    const manifestSrc = await readFile(join(SHADERS, 'manifest.js'), 'utf8');
    const listed = [...manifestSrc.matchAll(/'([^']+\.wgsl)'/g)].map((m) => m[1]);
    const onDisk = [...sources.keys()].sort();
    const listedFiles = [...new Set(listed)].sort();
    for (const f of onDisk) {
      if (!listedFiles.includes(f)) {
        err(join(SHADERS, 'manifest.js'),
          `shader '${f}' exists but is not in the manifest - run: node tools/gen-shader-manifest.mjs`);
      }
    }
    for (const f of listedFiles) {
      if (!onDisk.includes(f)) {
        err(join(SHADERS, 'manifest.js'),
          `manifest lists '${f}' which no longer exists - run: node tools/gen-shader-manifest.mjs`);
      }
    }
  } catch {
    err(SHADERS, 'shaders/manifest.js is missing - run: node tools/gen-shader-manifest.mjs');
  }

  // Every non-entry shader should be included by something.
  const included = new Set();
  for (const [rel, text] of sources) {
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    for (const m of text.matchAll(/^\s*#\s*include\s+["<]([^">]+)[">]/gm)) {
      const p = m[1].startsWith('/') ? m[1].slice(1) : (dir ? dir + '/' + m[1] : m[1]);
      included.add(p.split('/').reduce((acc, s) => {
        if (s === '..') acc.pop();
        else if (s !== '.' && s) acc.push(s);
        return acc;
      }, []).join('/'));
    }
  }
  for (const rel of sources.keys()) {
    if (!entries.includes(rel) && !included.has(rel)) {
      warn(join(SHADERS, rel), 'shader is neither an entry point nor included anywhere (dead file?)');
    }
  }
  for (const inc of included) {
    if (!sources.has(inc)) err(SHADERS, `#include target '${inc}' does not exist`);
  }

  return { files, entries };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const t0 = Date.now();
const js = await checkJavaScript();
const wgsl = await checkWGSL();
const ms = Date.now() - t0;

const totalLines = [...js.modules.values()].reduce((a, m) => a + m.lines, 0);

if (JSON_OUT) {
  console.log(JSON.stringify({
    ok: errors.length === 0,
    errors, warnings,
    stats: { jsFiles: js.files.length, jsLines: totalLines, wgslFiles: wgsl.files.length, wgslEntries: wgsl.entries.length, ms },
  }, null, 2));
} else {
  if (!QUIET) {
    console.log(`\nSUBWAVE check  -  ${js.files.length} JS files (${totalLines.toLocaleString()} lines), ` +
                `${wgsl.files.length} WGSL files (${wgsl.entries.length} entry points)  [${ms} ms]\n`);
  }
  if (warnings.length) {
    console.log(`WARNINGS (${warnings.length})`);
    for (const w of warnings) console.log(`  ~ ${w.file}: ${w.msg}`);
    console.log('');
  }
  if (errors.length) {
    console.log(`ERRORS (${errors.length})`);
    for (const e of errors) console.log(`  x ${e.file}: ${e.msg}`);
    console.log('');
  } else {
    console.log('No errors.\n');
  }
}

process.exit(errors.length ? 1 : 0);
