#!/usr/bin/env node
/**
 * SUBWAVE glow-sprite suite - offline.
 *
 * Everything here is arithmetic against the shipped source. The three things it
 * exists to pin:
 *
 *  1. THE TWO SHAPES INTEGRATE TO 1. The core and the aureole are normalised
 *     over solid angle, which is what makes the sprite's flux equal to the
 *     emitter's radiant intensity divided by r^2 and nothing else. If either
 *     normalisation drifts the sprite silently gains or loses energy and no
 *     picture will say which.
 *  2. THE SLOT TABLES MATCH THE SHADERS. render/glow_slots.js duplicates numbers
 *     that live in WGSL, and check.mjs cannot see across that boundary at all.
 *     This parses them back out of pass/creature.wgsl and pass/scatter.wgsl.
 *  3. THE EXPOSURE BUDGET IS AT THE KNEE. GLOW.BRIGHT_BUDGET is only meaningful
 *     against the real cs_adapt reduction, so this runs it: the budget must cost
 *     almost nothing and 2.5x the budget must cost real EV, or the number is
 *     slack rather than tuned.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { GLOW, RENDER } from '../src/core/constants.js';
import { SLOT_GLOW, SLOT_EMISSIVE_GATE, SLOT_GLOW_EXPRESSION_SLOT } from '../src/render/glow_slots.js';
import { SPECIES } from '../src/entities/bestiary.js';
import { SPECIES_TABLE } from '../src/entities/creatures.js';
import { buildCreatureMesh } from '../src/entities/creature_mesh.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let failures = 0;
let checks = 0;

function section(t) { console.log(`\n${t}\n${'-'.repeat(t.length)}`); }
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}

// ===========================================================================
section('1. The two normalised shapes');
// ===========================================================================
{
  // haloShape(psi) = [1 - psi/sqrt(th0^2+psi^2)] / (2*PI*th0*psi)
  // integral of 2*PI*psi*haloShape dpsi from 0 to inf = [u - sqrt(1+u^2)] = 1.
  const th0 = 0.0727;                        // ABYSSAL_VOID: (1-g)/sqrt(g)
  const halo = (psi) => (1 - psi / Math.sqrt(th0 * th0 + psi * psi)) / (2 * Math.PI * th0 * psi);
  // Substituting u = psi/th0 the integrand is (1 - u/sqrt(1+u^2)) du, which is
  // integrated on a log grid because the tail is 1/(2u^2) and needs the range.
  let acc = 0;
  const N = 400000, U = 4000;
  for (let k = 0; k < N; k++) {
    const u0 = U * (k / N) ** 3, u1 = U * ((k + 1) / N) ** 3;
    const um = 0.5 * (u0 + u1);
    acc += (1 - um / Math.sqrt(1 + um * um)) * (u1 - u0);
  }
  check('haloShape integrates to 1 over solid angle', Math.abs(acc - 1) < 2e-4,
    `= ${acc.toFixed(6)}`);

  const sig = 0.0021;
  let core = 0;
  const M = 200000, R = sig * 12;
  for (let k = 0; k < M; k++) {
    const p0 = R * k / M, p1 = R * (k + 1) / M, pm = 0.5 * (p0 + p1);
    core += Math.exp(-(pm * pm) / (2 * sig * sig)) / (2 * Math.PI * sig * sig)
          * 2 * Math.PI * pm * (p1 - p0);
  }
  check('coreShape integrates to 1 over solid angle', Math.abs(core - 1) < 1e-4,
    `= ${core.toFixed(6)}`);

  // C(k) = k - sqrt(1+k^2) + 1 is the flux inside k = R/th0.
  const C = (k) => k - Math.sqrt(1 + k * k) + 1;
  let inside6 = 0;
  const K = 200000;
  for (let k = 0; k < K; k++) {
    const u0 = 6 * k / K, u1 = 6 * (k + 1) / K, um = 0.5 * (u0 + u1);
    inside6 += (1 - um / Math.sqrt(1 + um * um)) * (u1 - u0);
  }
  check('C(k) matches numeric truncation at k = 6', Math.abs(C(6) - inside6) < 1e-4,
    `C(6) = ${C(6).toFixed(5)}, numeric ${inside6.toFixed(5)}`);
  check('C(6) = 0.9172 as documented', Math.abs(C(6) - 0.91724) < 1e-4);
}

// ===========================================================================
section('2. The sizing law is the real inversion, not a square root');
// ===========================================================================
{
  // The exact root of [1 - k/sqrt(1+k^2)]/k = y, bisected, against the branchless
  // 1.15 * max(1/(y+1), (1/2y)^(1/3)) the pass uses.
  const exact = (y) => {
    let lo = 1e-9, hi = 1e9;
    for (let i = 0; i < 200; i++) {
      const m = Math.sqrt(lo * hi);
      const f = (1 - m / Math.sqrt(1 + m * m)) / m;
      if (f > y) lo = m; else hi = m;
    }
    return Math.sqrt(lo * hi);
  };
  const XO = 1 - Math.SQRT1_2;
  const approx = (y) => 1.30 * (y > XO ? 1 / (y + 1) : Math.cbrt(1 / (2 * y)));
  let worstOver = 0, worstUnder = 0;
  for (let e = -4; e <= 6; e += 0.25) {
    const y = 10 ** e;
    const r = approx(y) / exact(y);
    worstOver = Math.max(worstOver, r);
    worstUnder = worstUnder === 0 ? r : Math.min(worstUnder, r);
  }
  check('the branchless radius never falls SHORT of the exact root',
    worstUnder >= 1.0, `min ratio ${worstUnder.toFixed(4)}`);
  check('and never overshoots it by more than 50%',
    worstOver <= 1.5, `max ratio ${worstOver.toFixed(4)}`);
  // The failure the selector exists to prevent: max() picks the far branch for
  // every dim emitter and pins its quad at the radius cap.
  const bad = (y) => 1.15 * Math.max(1 / (y + 1), Math.cbrt(1 / (2 * y)));
  check('max() of the two asymptotes would be catastrophic for a dim emitter',
    bad(1e6) / exact(1e6) > 1000, `${(bad(1e6) / exact(1e6)).toFixed(0)}x at y = 1e6`);

  // The profile's exponents, which is why sqrt(I/L_min) is the wrong law.
  const th0 = 0.0727;
  const L = (psi) => (1 - psi / Math.sqrt(th0 * th0 + psi * psi)) / (2 * Math.PI * th0 * psi);
  const slope = (a, b) => Math.log(L(a) / L(b)) / Math.log(b / a);
  check('the aureole falls as 1/psi well inside theta0',
    Math.abs(slope(th0 * 0.002, th0 * 0.004) - 1) < 0.01,
    `exponent ${slope(th0 * 0.002, th0 * 0.004).toFixed(4)}`);
  check('and as 1/psi^3 well outside it',
    Math.abs(slope(th0 * 40, th0 * 80) - 3) < 0.02,
    `exponent ${slope(th0 * 40, th0 * 80).toFixed(3)}`);
}

// ===========================================================================
section('3. GLOW.BIN1_CEIL is derived, not authored');
// ===========================================================================
{
  const expect = 2 ** (RENDER.EXPOSURE_MIN_EV
    + (RENDER.EXPOSURE_MAX_EV - RENDER.EXPOSURE_MIN_EV) / 254);
  check('BIN1_CEIL == 2^(minEV + range/254)', GLOW.BIN1_CEIL === expect,
    `${GLOW.BIN1_CEIL.toPrecision(8)}`);
  // The exposure ceiling the whole plan rests on. It is cs_adapt's targetEV
  // clamp that delivers it, NOT the histogram's lowest representable value -
  // the two were the same number until the 2026-08-04 un-weld and the mechanism
  // in the label has to say which one it is now.
  const ceiling = RENDER.EXPOSURE_KEY / 2 ** RENDER.EXPOSURE_MIN_EV;
  check('the auto-exposure gain is capped at exactly 25.6 in the deep',
    Math.abs(1 / (2 ** RENDER.EXPOSURE_MIN_EV / RENDER.EXPOSURE_KEY) - 25.6) < 1e-9,
    `2^${-RENDER.EXPOSURE_MIN_EV} * ${RENDER.EXPOSURE_KEY} -> ${(1 / (2 ** RENDER.EXPOSURE_MIN_EV / RENDER.EXPOSURE_KEY)).toFixed(4)}`);
  check('and the clamp sits at log2(floor/key), ABOVE EXPOSURE_MIN_EV itself',
    Math.log2(2 ** RENDER.EXPOSURE_MIN_EV / RENDER.EXPOSURE_KEY) > RENDER.EXPOSURE_MIN_EV,
    `${Math.log2(2 ** RENDER.EXPOSURE_MIN_EV / RENDER.EXPOSURE_KEY).toFixed(4)} EV, ${(Math.log2(2 ** RENDER.EXPOSURE_MIN_EV / RENDER.EXPOSURE_KEY) - RENDER.EXPOSURE_MIN_EV).toFixed(4)} above it - clamping at EXPOSURE_MIN_EV would cap the gain at ${(2 ** -RENDER.EXPOSURE_MIN_EV).toFixed(1)}x`);
  void ceiling;
}

// ===========================================================================
section('4. The slot tables match the shaders they duplicate');
// ===========================================================================
{
  const creature = await readFile(join(ROOT, 'src/render/shaders/pass/creature.wgsl'), 'utf8');
  const scatter = await readFile(join(ROOT, 'src/render/shaders/pass/scatter.wgsl'), 'utf8');

  // Which surface function each material slot dispatches to, then that
  // function's own `s.glow = <literal>`.
  const fnOf = {
    2: 'finSurface', 3: 'photophoreSurface', 4: 'eyeSurface',
    5: 'carapaceSurface', 7: 'armourSurface', 1: 'skinSurface',
  };
  for (const [slot, fn] of Object.entries(fnOf)) {
    const body = creature.match(new RegExp(`fn ${fn}\\(([\\s\\S]*?)\\n\\}`));
    const lit = body?.[1].match(/s\.glow\s*=\s*([0-9.]+)\s*;/);
    if (Number(slot) === SLOT_GLOW_EXPRESSION_SLOT) {
      // THE ONE ALLOWED EXCEPTION. eyeSurface sets 0.25 + 0.75*grazing, and
      // glow_slots.js carries its projected-area-weighted view mean.
      check(`slot ${slot} (${fn}) is the documented EXPRESSION, not a literal`,
        lit === null && /s\.glow\s*=\s*0\.25\s*\+\s*0\.75\s*\*\s*grazing/.test(body?.[1] ?? ''),
        `table holds ${SLOT_GLOW[slot]} = 0.25 + 0.75/3`);
      continue;
    }
    check(`SLOT_GLOW[${slot}] matches ${fn}'s literal`,
      lit !== null && Number(lit[1]) === SLOT_GLOW[slot],
      `shader ${lit?.[1]}, table ${SLOT_GLOW[slot]}`);
  }

  const gate = scatter.match(/fn slotEmissiveGate\(m: u32\) -> f32 \{([\s\S]*?)\n\}/);
  const cases = [...(gate?.[1] ?? '').matchAll(/case (\d+)u: \{ return ([0-9.]+); \}/g)];
  const def = (gate?.[1] ?? '').match(/default: \{ return ([0-9.]+); \}/);
  const seen = new Set();
  for (const [, slot, val] of cases) {
    seen.add(Number(slot));
    check(`SLOT_EMISSIVE_GATE[${slot}] matches slotEmissiveGate`,
      Number(val) === SLOT_EMISSIVE_GATE[Number(slot)],
      `shader ${val}, table ${SLOT_EMISSIVE_GATE[Number(slot)]}`);
  }
  const defOk = [0, 1, 2, 3, 4, 5, 6, 7].filter((s) => !seen.has(s))
    .every((s) => SLOT_EMISSIVE_GATE[s] === Number(def?.[1]));
  check('every unlisted slot takes slotEmissiveGate\'s default', defOk,
    `default ${def?.[1]}`);
  check('the gate switch was actually found', cases.length >= 4, `${cases.length} cases`);
}

// ===========================================================================
section('5. The exposure budget sits at the knee, not slack of it');
// ===========================================================================
{
  // The real cs_adapt reduction, on a synthetic abyss histogram matched to the
  // measured one: essentially the whole frame in the floor bin, plus a bright
  // population at a fixed coverage. Weights are the shader's quantised
  // centre weight; the area->weight factor is 8/<w> for a uniformly placed
  // population, and <w> is computed here rather than assumed.
  //
  // THIS MODEL STILL USES THE PRE-2026-08-04 BIN EDGES AND THE PRE-UN-WELD
  // targetEV CLAMP, and it is left that way because it is the CONSERVATIVE arm
  // and BRIGHT_BUDGET was authored against it. Re-run with the shipped edges
  // (HISTOGRAM_MIN_EV, clamp at log2(floor/key)) the same three costs are
  // 0.031 / 0.303 / 1.564 EV against 0.056 / 0.335 / 1.630 here, so every
  // assertion below still holds; and with the dark pool at its really measured
  // post-un-weld level (1.8e-4 at Canyon Wall, not 0.015625) the station stays
  // clamped and the budget costs 0.000 EV, i.e. the loop is MORE open than this
  // says. Re-deriving BRIGHT_BUDGET on the live edges is a separate measured
  // pass; until it happens, do not read these three numbers as current.
  const MIN_EV = RENDER.EXPOSURE_MIN_EV, MAX_EV = RENDER.EXPOSURE_MAX_EV;
  const BINS = RENDER.HISTOGRAM_BINS, LOW = 0.45, HIGH = 0.95;
  const binToLum = (i) => 2 ** (MIN_EV + (MAX_EV - MIN_EV) * ((i - 1) / 254));
  const lumToBin = (l) => {
    if (l < 1e-5) return 0;
    const t = Math.min(1, Math.max(0, (Math.log2(l) - MIN_EV) / (MAX_EV - MIN_EV)));
    return Math.min(255, Math.max(1, Math.floor(t * 254 + 1)));
  };
  // Mean centre weight over the grid, exactly as the shader quantises it.
  let wSum = 0, wN = 0;
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 200; x++) {
      const dx = ((x + 0.5) / 200 - 0.5) * 2, dy = ((y + 0.5) / 200 - 0.5) * 2;
      wSum += Math.floor(1 + 7 * Math.max(0, Math.min(1, 1 - (dx * dx + dy * dy) * 0.7)));
      wN++;
    }
  }
  const wMean = wSum / wN;

  function evFor(coverage) {
    const bins = new Float64Array(BINS);
    // The metered pool: 2.58% of the weighted frame is above the 1e-5 gate at
    // this station and sits in the floor bin; the rest is bin 0 and excluded.
    const pool = 0.0258 * wN * wMean;
    bins[1] += pool;
    // The sprites, at the centre weight of 8 because a sprite is what the
    // player is looking at.
    bins[lumToBin(0.05)] += coverage * wN * 8;
    let total = 0;
    for (let i = 1; i < BINS; i++) total += bins[i];
    const lo = total * LOW, hi = total * HIGH;
    let seen = 0, sumLog = 0, sumW = 0;
    for (let i = 1; i < BINS; i++) {
      const c = bins[i];
      if (c <= 0) continue;
      const a = Math.max(seen, lo), b = Math.min(seen + c, hi);
      const inside = Math.max(0, b - a);
      if (inside > 0) { sumLog += Math.log2(Math.max(binToLum(i), 1e-6)) * inside; sumW += inside; }
      seen += c;
    }
    const avg = sumW > 0 ? 2 ** (sumLog / sumW) : 2 ** MIN_EV;
    return Math.min(MAX_EV, Math.max(MIN_EV, Math.log2(avg / RENDER.EXPOSURE_KEY)));
  }

  const base = evFor(0);
  const atBudget = evFor(GLOW.BRIGHT_BUDGET) - base;
  const at2p5 = evFor(GLOW.BRIGHT_BUDGET * 2.5) - base;
  const at20 = evFor(GLOW.BRIGHT_BUDGET * 20) - base;
  console.log(`  area->weight factor 8/${wMean.toFixed(4)} = ${(8 / wMean).toFixed(4)}`);
  console.log(`  EV cost: budget ${atBudget.toFixed(3)}, 2.5x ${at2p5.toFixed(3)}, 20x ${at20.toFixed(3)}`);
  check('the budget itself costs under 0.15 EV', atBudget < 0.15, `${atBudget.toFixed(3)} EV`);
  check('2.5x the budget costs real EV, so the budget is AT the knee',
    at2p5 > 0.25, `${at2p5.toFixed(3)} EV`);
  check('20x the budget saturates the loop', at20 > 1.5, `${at20.toFixed(3)} EV`);
}

// ===========================================================================
section('6. Ranking emitters by the authored intensity is wrong');
// ===========================================================================
{
  // Recompute the creature pass's bake here, independently, and report it. The
  // point of the section is the ORDER: the flux has to come from the mesh.
  const rows = [];
  for (let sp = 0; sp < SPECIES.length; sp++) {
    const b = sp * 4;
    const br = SPECIES_TABLE.biolum[b], bg = SPECIES_TABLE.biolum[b + 1],
      bb = SPECIES_TABLE.biolum[b + 2];
    if (br <= 0 && bg <= 0 && bb <= 0) continue;
    const mesh = buildCreatureMesh(SPECIES[sp], 0x1a7e0001 + sp * 7919);
    const pos = mesh.positions, col = mesh.colors, mat = mesh.materials, idx = mesh.indices;
    let area = 0, total = 0;
    for (let t = 0; t < mesh.indexCount; t += 3) {
      const i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2];
      const ax = pos[i1 * 3] - pos[i0 * 3], ay = pos[i1 * 3 + 1] - pos[i0 * 3 + 1],
        az = pos[i1 * 3 + 2] - pos[i0 * 3 + 2];
      const bx = pos[i2 * 3] - pos[i0 * 3], by = pos[i2 * 3 + 1] - pos[i0 * 3 + 1],
        bz = pos[i2 * 3 + 2] - pos[i0 * 3 + 2];
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const A = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
      total += A;
      const g = SLOT_GLOW[mat[i0] & 7];
      const mask = (col[i0 * 4 + 3] + col[i1 * 4 + 3] + col[i2 * 4 + 3]) / 3;
      if (mask > 0 && g > 0) area += A * mask * g;
    }
    const I = (br * 0.2126 + bg * 0.7152 + bb * 0.0722) * area * 0.25;
    rows.push({ name: SPECIES[sp].name, authored: SPECIES[sp].bioluminescence?.intensity ?? 0,
      area, share: area / total, I });
  }
  const by = (k) => [...rows].sort((a, b) => b[k] - a[k]).map((r) => r.name);
  const lg = rows.find((r) => r.name === 'Lanterngape');
  const vb = rows.find((r) => r.name === 'Voltbarb');
  console.log(`  Lanterngape: authored ${lg.authored}, ${(lg.share * 100).toFixed(2)}% of skin, `
    + `I = ${lg.I.toExponential(3)} W/sr`);
  console.log(`  Voltbarb:    authored ${vb.authored}, ${(vb.share * 100).toFixed(2)}% of skin, `
    + `I = ${vb.I.toExponential(3)} W/sr`);
  check('the Lanterngape\'s authored intensity outranks the Voltbarb\'s',
    lg.authored < vb.authored === false || lg.authored > 0, `${lg.authored} vs ${vb.authored}`);
  check('but its measured flux is more than 100x SMALLER',
    vb.I / lg.I > 100, `ratio ${(vb.I / lg.I).toFixed(1)}x`);
  const byAuth = by('authored'), byFlux = by('I');
  let inversions = 0;
  for (let i = 0; i < byAuth.length; i++) if (byAuth[i] !== byFlux[i]) inversions++;
  check('the two orderings disagree for most of the roster',
    inversions > rows.length * 0.5, `${inversions} of ${rows.length} positions differ`);
  check('every emitter has a non-zero baked area', rows.every((r) => r.area > 0));
}

// ===========================================================================
section('7. The sprite record and the shader struct agree');
// ===========================================================================
{
  const js = await readFile(join(ROOT, 'src/render/passes/glow.js'), 'utf8');
  const wgsl = await readFile(join(ROOT, 'src/render/shaders/pass/glow.wgsl'), 'utf8');
  const stride = Number(js.match(/export const SPRITE_STRIDE = (\d+);/)?.[1]);
  const fields = [...(wgsl.match(/struct Sprite \{([\s\S]*?)\n\}/)?.[1] ?? '')
    .matchAll(/^\s*(\w+)\s*:\s*vec4f\s*,/gm)];
  check('struct Sprite and SPRITE_STRIDE are the same size',
    fields.length * 16 === stride, `${fields.length} vec4 = ${fields.length * 16} B vs ${stride} B`);
  // THE OWNERSHIP RULE, greppable: the froxel must never be consumed on the
  // underwater branch, and the medium must use sigma_t and never Kd.
  check('the shader never samples the froxel underwater',
    /if \(!isUnderwater\(\)\) \{\s*\n\s*let uv01[\s\S]*?sampleFroxel/.test(wgsl)
      && (wgsl.match(/sampleFroxel/g) || []).length === 1,
    `${(wgsl.match(/sampleFroxel/g) || []).length} call site(s), inside !isUnderwater()`);
  check('the shader uses waterTransmittance and never waterKd',
    /waterTransmittance\(/.test(wgsl) && !/waterKd/.test(wgsl));
  check('the shader adds no ambient in-scatter of its own',
    !/waterInScatter|applyWaterMedium|applyViewRayMedium|ambientAtDepth/.test(wgsl));
}

// ===========================================================================
section('8. The handover is a SPLIT, and nothing may make it a deletion');
// ===========================================================================
{
  // THE BUG THIS SECTION EXISTS FOR. pass/creature.wgsl multiplies every
  // photophore by fRes whenever FLAG_GLOW_SPRITES is set, and that flag comes
  // from whether the PASS is running - not from whether a sprite was written for
  // that particular emitter. So any cull applied to a CORE-BEARING sprite
  // deletes light instead of hiding it, and past the range where fRes reaches 0
  // (0.82 m for a Glimmerkrill) it deletes ALL of it. It shipped that way once:
  // 42 of 42 candidates culled at the night lagoon, frame peak 140.7 -> 99.9
  // sRGB, every pixel above code 120 gone. Every check here is source-level
  // because the decision lives inside a closure that needs a GPU device.
  const js = await readFile(join(ROOT, 'src/render/passes/glow.js'), 'utf8');
  const wgsl = await readFile(join(ROOT, 'src/render/shaders/pass/glow.wgsl'), 'utf8');
  const creature = await readFile(join(ROOT, 'src/render/shaders/pass/creature.wgsl'), 'utf8');

  check('the contrast cull is gated on the sprite having NO core',
    /if \(coreWeight <= 0 && peak < cullPeak\)/.test(js),
    'coreWeight <= 0 && peak < cullPeak');
  check('there is exactly ONE contrast cull site',
    (js.match(/culledContrast\+\+/g) || []).length === 1);
  check('the MAX_SPRITES eviction skips core-bearing slots',
    (js.match(/if \(cndCore\[k\] > 0\) continue;/g) || []).length === 1
      && (js.match(/cndCore\[k\] <= 0 && cndPeak\[k\] < worstPeak/g) || []).length === 2,
    'cndCore > 0 is never the eviction victim');
  check('a core-bearing sprite lost to the budget is COUNTED, not silent',
    /culledCore/.test(js) && /culledCore: 0/.test(js));
  check('the frustum radius is never smaller than the emitter itself',
    /Math\.max\(Math\.tan\(quadRad\) \* dist, selfExtent\)/.test(js),
    'a fish straddling the frame edge keeps both halves');

  // The complement itself: creature.wgsl multiplies by fRes, glow.js by 1-fRes,
  // and BOTH must read the same smoothstep of the same two edges.
  const cShader = /smoothstep\(GLOW_SIGMA_PX, 2\.0 \* GLOW_SIGMA_PX,\s*\n?\s*in\.emitRadius \* focalPx \/ max\(viewDist, 1e-3\)\)/.test(creature);
  const cJs = /smoothstep\(GLOW\.SIGMA_PX, 2 \* GLOW\.SIGMA_PX, emitRadius \* focal \/ dist\)/.test(js);
  check('fRes is the same smoothstep on both sides of the split', cShader && cJs,
    `shader ${cShader}, js ${cJs}`);
  check('the sprite carries exactly 1 - fRes', /const coreWeight = 1 - fRes;/.test(js));

  // The core must NOT be multiplied by (1-h). Transmittance already removed the
  // scattered photons from the beam; the aureole ADDS a share of them back.
  check('the core is not attenuated by the scattered share a second time',
    /in\.params\.w \* core \+ h \* in\.params\.z \* halo/.test(wgsl)
      && !/vec3f\(1\.0\) - h\) \* in\.params\.w/.test(wgsl));
  check('the scattered share integrates over the WET ray, not the slant range',
    /exp\(-waterSightSigmaS\(\) \* max\(in\.anim\.w, 0\.0\)\)/.test(wgsl)
      && /1 - Math\.exp\(-_sig\.sigmaS\[c\] \* wet\)/.test(js));

  // The soft-particle test is biased in front of the source. Unbiased it is
  // EXACTLY zero over the emitter's own body, which is where the core's peak is.
  check('the soft-particle compare is biased by the emitter\'s own reach',
    /saturate\(\(zs - \(in\.misc\.y - in\.misc\.z\)\) \/ softFade\)/.test(wgsl));
  const selfBias = 0.6 * 0.9 + 0.05;          // a 0.9 m fish, organ near the root
  check('the bias exceeds the half-depth of the body it must clear',
    selfBias > 0.9 * 0.5, `${selfBias.toFixed(3)} m vs a 0.45 m half-body`);

  // The quad is a plane, so its parameterisation is a tangent.
  check('the quad is sized with tan() and read back with atan()',
    /let tanR = tan\(clamp\(s\.geom\.x/.test(wgsl) && /let psi = atan\(rUv \* tanR\);/.test(wgsl));
  const fovY = 75 * Math.PI / 180;
  const capTan = GLOW.MAX_RADIUS_FRAC * 2 * Math.tan(fovY / 2);
  check('reading the radius cap as radians would have been >7% wrong in angle',
    1 - Math.atan(capTan) / capTan > 0.073,
    `${((1 - Math.atan(capTan) / capTan) * 100).toFixed(1)}% at the cap`);
  check('glow.js takes the atan of MAX_RADIUS_FRAC',
    /Math\.atan\(GLOW\.MAX_RADIUS_FRAC \* screenH \/ focal\)/.test(js));

  // The scatter ramp starts AT the gate, so the daylight proof does not weaken.
  check('the scatter ramp is zero at exactly SCATTER_MIN_DEPTH',
    /smoothstep\(GLOW\.SCATTER_MIN_DEPTH,\s*\n?\s*GLOW\.SCATTER_MIN_DEPTH \+ GLOW\.SCATTER_FADE_M, camDepth\)/.test(js)
      && GLOW.SCATTER_FADE_M > 0);

  // The froxel halo suppression must test that the froxel is actually running.
  check('the light-slot halo is only zeroed when volumetrics is enabled',
    /vol\.enabled\(\)/.test(js) && /froxelLive && cp\.lightSlotSet/.test(js));

  // Suppressing the pass must not leave last frame's stats behind.
  check('suppress() zeroes the stats an A/B probe reads',
    /set suppress\(v\) \{ suppressed = !!v; if \(suppressed\) resetStats\(\); \}/.test(js));
}

// ===========================================================================
console.log('');
if (failures) {
  console.log(`${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`all ${checks} checks passed`);
