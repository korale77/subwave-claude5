/**
 * SUBWAVE WGSL shader library and preprocessor.
 *
 * WGSL has no include mechanism, so we ship a small, strict preprocessor:
 *
 *   #include "common/math.wgsl"      // path relative to the shader root
 *   #pragma once                     // guard a header against double inclusion
 *   #define MAX_LIGHTS 128           // textual macro, whole-word substitution
 *   #ifdef NAME / #ifndef NAME / #if EXPR / #elif EXPR / #else / #endif
 *
 * `#if` expressions accept integers, defined names, the `defined(NAME)` call,
 * and the operators  ! && || == != < <= > >= + - * / ( )  - evaluated by a tiny
 * recursive-descent parser (never `eval`).
 *
 * Every emitted line is tracked back to its origin file and line so that WGSL
 * compilation diagnostics can be rewritten into real source locations. That
 * matters enormously once shaders are assembled from a dozen headers.
 */

const DIRECTIVE = /^[ \t]*#[ \t]*(\w+)[ \t]*(.*)$/;
const INCLUDE_ARG = /^["<]([^">]+)[">]/;

export class ShaderError extends Error {
  constructor(message, file, line) {
    super(message);
    this.name = 'ShaderError';
    this.file = file;
    this.line = line;
  }
}

// ---------------------------------------------------------------------------
// #if expression evaluation
// ---------------------------------------------------------------------------

/** Tokenise a preprocessor expression. */
function tokenizeExpr(src) {
  const tokens = [];
  const re = /\s*(\d+|[A-Za-z_]\w*|&&|\|\||[=!<>]=|[-+*/()!<>])/g;
  let m;
  let last = 0;
  while ((m = re.exec(src))) {
    if (m.index !== last && src.slice(last, m.index).trim()) {
      throw new ShaderError(`Unexpected token in #if expression: ${src.slice(last, m.index).trim()}`);
    }
    tokens.push(m[1]);
    last = re.lastIndex;
  }
  if (src.slice(last).trim()) {
    throw new ShaderError(`Unexpected token in #if expression: ${src.slice(last).trim()}`);
  }
  return tokens;
}

/**
 * Evaluate a preprocessor expression to a number (0 = false).
 * Precedence, loosest first: || && ==/!= relational +/- * / unary.
 */
function evalExpr(src, defines) {
  const tokens = tokenizeExpr(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  const valueOf = (name) => {
    if (!Object.prototype.hasOwnProperty.call(defines, name)) return 0;
    const v = defines[name];
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    const n = Number(String(v).replace(/[uif]$/, ''));
    return Number.isFinite(n) ? n : 1; // a non-numeric define is "truthy"
  };

  function primary() {
    const t = next();
    if (t === undefined) throw new ShaderError('Unexpected end of #if expression');
    if (t === '(') {
      const v = orExpr();
      if (next() !== ')') throw new ShaderError('Missing ) in #if expression');
      return v;
    }
    if (t === '!') return primary() ? 0 : 1;
    if (t === '-') return -primary();
    if (t === '+') return primary();
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    if (t === 'defined') {
      let name;
      if (peek() === '(') { next(); name = next(); if (next() !== ')') throw new ShaderError('Missing ) after defined()'); }
      else name = next();
      return Object.prototype.hasOwnProperty.call(defines, name) ? 1 : 0;
    }
    if (/^[A-Za-z_]\w*$/.test(t)) return valueOf(t);
    throw new ShaderError(`Unexpected token '${t}' in #if expression`);
  }

  function mulExpr() {
    let v = primary();
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const r = primary();
      v = op === '*' ? v * r : (r === 0 ? 0 : Math.trunc(v / r));
    }
    return v;
  }
  function addExpr() {
    let v = mulExpr();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const r = mulExpr();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function relExpr() {
    let v = addExpr();
    while (peek() === '<' || peek() === '>' || peek() === '<=' || peek() === '>=') {
      const op = next();
      const r = addExpr();
      v = (op === '<' ? v < r : op === '>' ? v > r : op === '<=' ? v <= r : v >= r) ? 1 : 0;
    }
    return v;
  }
  function eqExpr() {
    let v = relExpr();
    while (peek() === '==' || peek() === '!=') {
      const op = next();
      const r = relExpr();
      v = (op === '==' ? v === r : v !== r) ? 1 : 0;
    }
    return v;
  }
  function andExpr() {
    let v = eqExpr();
    while (peek() === '&&') { next(); const r = eqExpr(); v = v && r ? 1 : 0; }
    return v;
  }
  function orExpr() {
    let v = andExpr();
    while (peek() === '||') { next(); const r = andExpr(); v = v || r ? 1 : 0; }
    return v;
  }

  const result = orExpr();
  if (pos !== tokens.length) throw new ShaderError(`Trailing tokens in #if expression: ${tokens.slice(pos).join(' ')}`);
  return result;
}

// ---------------------------------------------------------------------------
// Path handling
// ---------------------------------------------------------------------------

/** Normalise `a/b/../c` style paths. Shader paths are always root-relative. */
function normalizePath(p) {
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function dirname(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

// ---------------------------------------------------------------------------
// ShaderLibrary
// ---------------------------------------------------------------------------

export class ShaderLibrary {
  /**
   * @param {{root?: string, device?: GPUDevice}} [opts]
   *   root - URL prefix the .wgsl files are fetched from.
   */
  constructor(opts = {}) {
    this.root = (opts.root || './src/render/shaders/').replace(/\/?$/, '/');
    this.device = opts.device || null;
    /** @type {Map<string,string>} raw file text by normalised path */
    this.sources = new Map();
    /** @type {Map<string,GPUShaderModule>} compiled modules by cache key */
    this.modules = new Map();
    /** Defines applied to every shader unless overridden per-compile. */
    this.globalDefines = {};
    /** @type {Map<string,Promise<string>>} in-flight fetches */
    this._pending = new Map();
    this.stats = { fetched: 0, compiled: 0, cacheHits: 0, bytes: 0 };
  }

  setDevice(device) { this.device = device; return this; }

  /** Merge defines available to every shader (constants, tier settings...). */
  define(map) {
    Object.assign(this.globalDefines, map);
    return this;
  }

  /** Register source text directly - used by generated shaders and tests. */
  put(path, source) {
    const p = normalizePath(path);
    this.sources.set(p, source);
    this.stats.bytes += source.length;
    return this;
  }

  has(path) { return this.sources.has(normalizePath(path)); }

  /** Fetch (and cache) one .wgsl file. */
  async load(path) {
    const p = normalizePath(path);
    if (this.sources.has(p)) return this.sources.get(p);
    if (this._pending.has(p)) return this._pending.get(p);

    const promise = (async () => {
      const url = this.root + p;
      const res = await fetch(url);
      if (!res.ok) throw new ShaderError(`Failed to load shader '${p}' (HTTP ${res.status} from ${url})`, p, 0);
      const text = await res.text();
      this.sources.set(p, text);
      this.stats.fetched++;
      this.stats.bytes += text.length;
      return text;
    })();

    this._pending.set(p, promise);
    try {
      return await promise;
    } finally {
      this._pending.delete(p);
    }
  }

  /**
   * Load `path` plus everything it transitively includes.
   * Call this once at boot for every entry point so preprocessing is sync afterwards.
   */
  async loadRecursive(path, seen = new Set()) {
    const p = normalizePath(path);
    if (seen.has(p)) return;
    seen.add(p);
    const src = await this.load(p);
    const dir = dirname(p);
    const includes = [];
    for (const line of src.split('\n')) {
      const m = DIRECTIVE.exec(line);
      if (m && m[1] === 'include') {
        const a = INCLUDE_ARG.exec(m[2].trim());
        if (a) includes.push(normalizePath(a[1].startsWith('/') ? a[1].slice(1) : (dir ? dir + '/' + a[1] : a[1])));
      }
    }
    await Promise.all(includes.map((inc) => this.loadRecursive(inc, seen)));
  }

  /** Load many entry points and their dependency trees in parallel. */
  async preload(paths) {
    const seen = new Set();
    await Promise.all(paths.map((p) => this.loadRecursive(p, seen)));
    return this;
  }

  // -------------------------------------------------------------------------
  // Preprocessing
  // -------------------------------------------------------------------------

  /**
   * Expand a shader entry point into final WGSL.
   * @returns {{code: string, map: Array<{file: string, line: number}>, files: string[]}}
   */
  preprocess(path, defines = {}) {
    const p = normalizePath(path);
    if (!this.sources.has(p)) {
      throw new ShaderError(`Shader '${p}' has not been loaded. Call load()/preload() first.`, p, 0);
    }

    const macros = Object.assign(Object.create(null), this.globalDefines, defines);
    const out = [];
    /** Line map: out[i] came from map[i].file : map[i].line */
    const map = [];
    const onceGuarded = new Set();
    const filesUsed = [];

    // Whole-word macro substitution. Only names that appear in `macros` are
    // touched, so ordinary WGSL identifiers are never mangled.
    let macroRe = null;
    const rebuildMacroRe = () => {
      const names = Object.keys(macros).filter((n) => /^[A-Za-z_]\w*$/.test(n));
      macroRe = names.length ? new RegExp(`\\b(${names.join('|')})\\b`, 'g') : null;
    };
    rebuildMacroRe();

    const substitute = (line) => {
      if (!macroRe) return line;
      macroRe.lastIndex = 0;
      return line.replace(macroRe, (m) => {
        const v = macros[m];
        return v === undefined || v === null ? m : String(v);
      });
    };

    const emit = (text, file, line) => {
      out.push(text);
      map.push({ file, line });
    };

    const include = (filePath, stack) => {
      if (stack.includes(filePath)) {
        throw new ShaderError(`Circular #include: ${[...stack, filePath].join(' -> ')}`, filePath, 0);
      }
      const src = this.sources.get(filePath);
      if (src === undefined) {
        throw new ShaderError(
          `Missing shader include '${filePath}' (from ${stack[stack.length - 1] || '<root>'})`,
          filePath, 0,
        );
      }
      if (!filesUsed.includes(filePath)) filesUsed.push(filePath);

      const dir = dirname(filePath);
      const lines = src.split('\n');
      // Conditional stack entries: {taken, active, seenElse}
      const cond = [];
      const active = () => cond.every((c) => c.active);

      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const d = DIRECTIVE.exec(raw);

        if (!d) {
          if (active()) emit(substitute(raw), filePath, i + 1);
          continue;
        }

        const kind = d[1];
        const arg = d[2].trim();

        switch (kind) {
          case 'if': {
            const val = active() ? evalExpr(arg, macros) !== 0 : false;
            cond.push({ taken: val, active: val && active(), parentActive: active(), seenElse: false });
            break;
          }
          case 'ifdef':
          case 'ifndef': {
            const has = Object.prototype.hasOwnProperty.call(macros, arg);
            const val = kind === 'ifdef' ? has : !has;
            const ok = active() && val;
            cond.push({ taken: ok, active: ok, parentActive: active(), seenElse: false });
            break;
          }
          case 'elif': {
            const top = cond[cond.length - 1];
            if (!top) throw new ShaderError('#elif without #if', filePath, i + 1);
            if (top.seenElse) throw new ShaderError('#elif after #else', filePath, i + 1);
            if (top.taken) { top.active = false; }
            else {
              const val = top.parentActive && evalExpr(arg, macros) !== 0;
              top.active = val;
              top.taken = top.taken || val;
            }
            break;
          }
          case 'else': {
            const top = cond[cond.length - 1];
            if (!top) throw new ShaderError('#else without #if', filePath, i + 1);
            if (top.seenElse) throw new ShaderError('duplicate #else', filePath, i + 1);
            top.seenElse = true;
            top.active = top.parentActive && !top.taken;
            top.taken = true;
            break;
          }
          case 'endif': {
            if (!cond.pop()) throw new ShaderError('#endif without #if', filePath, i + 1);
            break;
          }
          case 'include': {
            if (!active()) break;
            const a = INCLUDE_ARG.exec(arg);
            if (!a) throw new ShaderError(`Malformed #include: ${arg}`, filePath, i + 1);
            const rel = a[1];
            const target = normalizePath(rel.startsWith('/') ? rel.slice(1) : (dir ? dir + '/' + rel : rel));
            if (onceGuarded.has(target)) break;
            include(target, [...stack, filePath]);
            break;
          }
          case 'pragma': {
            if (active() && arg === 'once') {
              if (onceGuarded.has(filePath)) return; // already emitted elsewhere
              onceGuarded.add(filePath);
            }
            break;
          }
          case 'define': {
            if (!active()) break;
            const sp = arg.indexOf(' ');
            const name = sp < 0 ? arg : arg.slice(0, sp);
            const value = sp < 0 ? 1 : arg.slice(sp + 1).trim();
            if (!/^[A-Za-z_]\w*$/.test(name)) {
              throw new ShaderError(`Invalid #define name '${name}'`, filePath, i + 1);
            }
            macros[name] = /^-?\d+$/.test(value) ? parseInt(value, 10) : value;
            rebuildMacroRe();
            break;
          }
          case 'undef': {
            if (!active()) break;
            delete macros[arg];
            rebuildMacroRe();
            break;
          }
          case 'error': {
            if (active()) throw new ShaderError(`#error: ${arg}`, filePath, i + 1);
            break;
          }
          default:
            // Unknown directive: pass through so WGSL reports it in context.
            if (active()) emit(substitute(raw), filePath, i + 1);
        }
      }

      if (cond.length) {
        throw new ShaderError(`Unterminated #if in ${filePath} (${cond.length} open)`, filePath, lines.length);
      }
    };

    include(p, []);
    return { code: out.join('\n'), map, files: filesUsed };
  }

  // -------------------------------------------------------------------------
  // Module creation
  // -------------------------------------------------------------------------

  /**
   * Preprocess + create a GPUShaderModule, cached by path and defines.
   * Compilation diagnostics are remapped to original files and re-logged.
   */
  module(path, defines = {}, label = null) {
    if (!this.device) throw new ShaderError('ShaderLibrary has no device; call setDevice() first.');
    const p = normalizePath(path);
    const key = p + '|' + stableStringify(defines);
    const cached = this.modules.get(key);
    if (cached) { this.stats.cacheHits++; return cached; }

    const { code, map, files } = this.preprocess(p, defines);
    const mod = this.device.createShaderModule({ label: label || p, code });
    this.stats.compiled++;

    mod.getCompilationInfo?.().then((info) => {
      if (!info || !info.messages.length) return;
      for (const msg of info.messages) {
        const origin = map[Math.max(0, Math.min(map.length - 1, msg.lineNum - 1))];
        const where = origin ? `${origin.file}:${origin.line}` : `${p}:?`;
        const codeLine = code.split('\n')[msg.lineNum - 1] || '';
        const text = `[wgsl ${msg.type}] ${where} (expanded ${p}:${msg.lineNum})\n  ${msg.message}\n  | ${codeLine.trim()}`;
        if (msg.type === 'error') console.error(text, '\n  includes:', files.join(', '));
        else if (msg.type === 'warning') console.warn(text);
        else console.info(text);
      }
    }).catch(() => { /* getCompilationInfo is best-effort */ });

    this.modules.set(key, mod);
    return mod;
  }

  /** Await compilation diagnostics for a module and return errors as an array. */
  async validate(path, defines = {}) {
    const mod = this.module(path, defines);
    const info = await mod.getCompilationInfo?.();
    if (!info) return [];
    return info.messages.filter((m) => m.type === 'error').map((m) => m.message);
  }

  /** Drop compiled modules (e.g. after a live shader edit). Sources are kept. */
  invalidateModules() {
    this.modules.clear();
  }

  /** Drop a single source file so it is refetched, plus all compiled modules. */
  invalidateSource(path) {
    this.sources.delete(normalizePath(path));
    this.modules.clear();
  }
}

/** Deterministic JSON for cache keys (object key order must not matter). */
function stableStringify(obj) {
  const keys = Object.keys(obj).sort();
  return keys.map((k) => `${k}=${obj[k]}`).join(',');
}

export { normalizePath, evalExpr };
