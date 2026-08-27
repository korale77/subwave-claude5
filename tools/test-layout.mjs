#!/usr/bin/env node
/**
 * Frame uniform layout verification.
 *
 * The single most dangerous contract in the renderer is the byte layout of the
 * Frame struct: JS writes it field by field with StructWriter, WGSL reads it as
 * a declared struct. If the two ever disagree by even four bytes, every shader
 * silently reads garbage from that field onward - and the symptom is usually
 * "the lighting looks a bit off", which is nearly impossible to trace.
 *
 * So we parse the offsets out of the WGSL comments and compare them against
 * what the JS writer actually produces. This runs offline, with no GPU.
 *
 * Run:  node tools/test-layout.mjs
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { StructWriter } from '../src/core/resources.js';
import { FRAME_BYTES, LIGHT_BYTES } from '../src/render/renderer.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------------------
// 1. What the JS side actually writes.
// ---------------------------------------------------------------------------

const buf = new ArrayBuffer(FRAME_BYTES);
const w = new StructWriter(new Float32Array(buf), new Uint32Array(buf));
const M = new Float32Array(16);
const jsOffsets = new Map();
const at = (name) => jsOffsets.set(name, w.bytes);
const v4 = () => w.vec4(0, 0, 0, 0);

at('view'); w.mat4(M);
at('proj'); w.mat4(M);
at('viewProj'); w.mat4(M);
at('invView'); w.mat4(M);
at('invProj'); w.mat4(M);
at('invViewProj'); w.mat4(M);
at('prevViewProj'); w.mat4(M);
at('viewProjUnjittered'); w.mat4(M);

at('cameraPos'); v4();
at('cameraFwd'); v4();
at('cameraRight'); v4();
at('cameraUp'); v4();
at('prevCameraPos'); v4();
at('worldOrigin'); v4();
at('camPlanes'); v4();

at('sunDir'); v4();
at('sunIlluminance'); v4();
at('moonDir'); v4();
at('moonIlluminance'); v4();

at('ambientSH'); for (let i = 0; i < 9; i++) v4();

at('waterSigmaT'); v4();
at('waterSigmaS'); v4();
at('waterKd'); v4();
at('waterDeepTint'); v4();
at('waterSurface'); v4();
at('camWater'); v4();

at('fogParams'); v4();
at('fogColour'); v4();

at('screen'); v4();
at('outputSize'); v4();
at('taaJitter'); v4();

at('exposureParams'); v4();
at('timeParams'); v4();

at('weather'); v4();
at('windDir'); v4();

at('counts'); w.align(16); w.u(0); w.u(0); w.u(0); w.u(0);

at('waterBottom'); v4();
at('skyGeometry'); v4();
at('waterFogTint'); v4();
at('waterSurfaceKd'); v4();
at('waterSurfaceSigmaT'); v4();

at('deepKeyDir'); v4();
at('deepKeyRadiance'); v4();

at('caveMedium'); v4();

at('veilTune'); v4();

const jsTotal = w.bytes;

// ---------------------------------------------------------------------------
// 2. What the WGSL declares, per its offset comments.
// ---------------------------------------------------------------------------

const wgsl = await readFile(ROOT + 'src/render/shaders/common/frame.wgsl', 'utf8');
const structBody = wgsl.slice(wgsl.indexOf('struct Frame {'), wgsl.indexOf('};', wgsl.indexOf('struct Frame {')));

// Lines look like:  name : type,   // offset  size  comment
// The type may itself contain commas (array<vec4f, 9>), so anchor on the
// comment rather than on the first comma.
const wgslOffsets = new Map();
for (const line of structBody.split('\n')) {
  const m = /^\s*(\w+)\s*:\s*(.+?),?\s*\/\/\s*(\d+)\s+(\d+)/.exec(line);
  if (m) wgslOffsets.set(m[1], { type: m[2].replace(/,$/, '').trim(), offset: +m[3], size: +m[4] });
}

console.log('\nFrame uniform layout\n');
check('WGSL struct fields were parsed', wgslOffsets.size > 20, `${wgslOffsets.size} fields`);

// ---------------------------------------------------------------------------
// 3. Compare.
// ---------------------------------------------------------------------------

let mismatches = 0;
console.log('\n  field                    JS     WGSL');
for (const [name, jsOff] of jsOffsets) {
  const wg = wgslOffsets.get(name);
  if (!wg) {
    console.log(`  ${name.padEnd(22)} ${String(jsOff).padStart(5)}   (absent in WGSL)`);
    mismatches++;
    continue;
  }
  const same = wg.offset === jsOff;
  if (!same) mismatches++;
  console.log(`  ${same ? ' ' : '!'} ${name.padEnd(20)} ${String(jsOff).padStart(5)} ${String(wg.offset).padStart(8)}`);
}
console.log('');

check('every JS field matches its WGSL offset', mismatches === 0, `${mismatches} mismatch(es)`);

for (const name of wgslOffsets.keys()) {
  if (!jsOffsets.has(name)) {
    check(`WGSL field '${name}' is written by JS`, false, 'declared in WGSL but never written');
  }
}

check('JS writer total equals FRAME_BYTES', jsTotal === FRAME_BYTES,
  `wrote ${jsTotal}, FRAME_BYTES=${FRAME_BYTES}`);
check('FRAME_BYTES is 16-byte aligned', FRAME_BYTES % 16 === 0);

// The struct must not exceed the guaranteed minimum uniform binding size.
check('Frame fits in the minimum guaranteed uniform binding (64 KB)', FRAME_BYTES <= 65536);

// ---------------------------------------------------------------------------
// 4. StructWriter's own alignment guarantees.
// ---------------------------------------------------------------------------

console.log('\nStructWriter alignment\n');
{
  const b = new ArrayBuffer(256);
  const sw = new StructWriter(new Float32Array(b), new Uint32Array(b));
  sw.f(1);                       // 4 bytes in
  sw.vec4(1, 2, 3, 4);           // must skip to 16
  check('vec4 aligns to 16 bytes', sw.bytes === 32, `bytes=${sw.bytes}`);

  const sw2 = new StructWriter(new Float32Array(b), new Uint32Array(b));
  sw2.f(1);
  sw2.vec3(1, 2, 3);             // vec3 occupies 16 bytes in a uniform
  check('vec3 occupies a full 16 bytes', sw2.bytes === 32, `bytes=${sw2.bytes}`);

  const sw3 = new StructWriter(new Float32Array(b), new Uint32Array(b));
  sw3.f(1);
  sw3.mat4(M);
  check('mat4 aligns to 16 and spans 64', sw3.bytes === 80, `bytes=${sw3.bytes}`);

  const sw4 = new StructWriter(new Float32Array(b), new Uint32Array(b));
  sw4.mat3(new Float32Array(9));
  check('mat3 spans 48 bytes (3 padded columns)', sw4.bytes === 48, `bytes=${sw4.bytes}`);

  let threw = false;
  try {
    const sw5 = new StructWriter(new Float32Array(b), new Uint32Array(b));
    for (let i = 0; i < 10; i++) sw5.vec4(0, 0, 0, 0);
    sw5.padTo(16);
  } catch { threw = true; }
  check('padTo throws on overrun', threw);
}

// ---------------------------------------------------------------------------
// 5. The Light struct, which is declared THREE times.
// ---------------------------------------------------------------------------
//
// frame.wgsl declares it, sim/cluster_cull.wgsl carries a hand-kept copy because
// that pass cannot bind group 0, and renderer.js writes it with a hard-coded
// stride. cluster_cull.wgsl's comment has claimed since it was written that "the
// byte layout is asserted by tools/test-layout.mjs"; until the shape field was
// added it was not, and a drifting stride there is silent - the cull would read
// every light past the first from the wrong offset and the light lists would be
// plausible and wrong.

console.log('\nLight struct\n');
{
  const fieldsOf = (src, label) => {
    const start = src.indexOf('struct Light {');
    if (start < 0) return null;
    const body = src.slice(start, src.indexOf('};', start));
    const out = [];
    for (const line of body.split('\n').slice(1)) {
      const m = /^\s*(\w+)\s*:\s*([\w<>, ]+?)\s*,/.exec(line.replace(/\/\/.*$/, ''));
      if (m) out.push([m[1], m[2].trim()]);
    }
    check(`${label} declares struct Light`, out.length > 0, `${out.length} fields`);
    return out;
  };

  const frameLight = fieldsOf(wgsl, 'frame.wgsl');
  const cullSrc = await readFile(ROOT + 'src/render/shaders/sim/cluster_cull.wgsl', 'utf8');
  const cullLight = fieldsOf(cullSrc, 'cluster_cull.wgsl');

  if (frameLight && cullLight) {
    // Every field is a vec4f, so the size is exactly 16 per field and there is
    // no padding to reason about. Assert that rather than assuming it.
    const allVec4 = frameLight.every(([, t]) => t === 'vec4f');
    check('every Light field is vec4f (so size = 16 x fields)', allVec4,
      frameLight.map(([n, t]) => `${n}:${t}`).join(' '));

    check('LIGHT_BYTES matches frame.wgsl', frameLight.length * 16 === LIGHT_BYTES,
      `WGSL ${frameLight.length * 16}, JS ${LIGHT_BYTES}`);

    const sameNames = frameLight.length === cullLight.length &&
      frameLight.every(([n], i) => cullLight[i][0] === n);
    check('cluster_cull.wgsl mirrors frame.wgsl field for field', sameNames,
      sameNames ? '' : `frame [${frameLight.map(f => f[0])}] vs cull [${cullLight.map(f => f[0])}]`);
  }

  // addLight() writes d[o + N] for every slot. The highest N it touches must be
  // exactly LIGHT_BYTES/4 - 1, or the tail of every light is uninitialised
  // garbage from the previous frame's light at that index.
  const rendererSrc = await readFile(ROOT + 'src/render/renderer.js', 'utf8');
  const addLight = rendererSrc.slice(rendererSrc.indexOf('  addLight(l) {'));
  const slots = new Set(
    [...addLight.slice(0, addLight.indexOf('\n  }')).matchAll(/\bd\[o \+ (\d+)\]/g)].map(m => +m[1]));
  const want = LIGHT_BYTES / 4;
  const missing = [];
  for (let i = 0; i < want; i++) if (!slots.has(i)) missing.push(i);
  check('addLight writes every float slot', missing.length === 0 && slots.size === want,
    `wrote ${slots.size} of ${want}${missing.length ? `, missing ${missing.join(',')}` : ''}`);
}

console.log(`\n${failures === 0 ? 'Layout contract verified.' : `${failures} CHECK(S) FAILED.`}\n`);
process.exit(failures ? 1 : 0);
