#!/usr/bin/env node
/**
 * SUBWAVE shadow-cascade fit verification, offline, no GPU.
 *
 * The shadow pass cannot be run without a device, but everything that decides
 * whether it produces a picture or a silently empty atlas is arithmetic:
 *
 *   - mat4.orthoReverseZ's depth row. With the sign flipped it maps the caster
 *     range to clip.z in [1, 2], which the rasteriser clips away entirely. The
 *     atlas then keeps its 0.0 clear, the receiver's 'greater' compare reports
 *     LIT everywhere, and the result is byte-for-byte identical to having no
 *     shadow pass at all - at the full cost of running one.
 *   - the caster/receiver handshake. shadow.wgsl recovers the cascade's texel
 *     size from |row0| and its NDC-per-metre depth scale from |row2| of the SAME
 *     matrix the caster transforms with, so if the CPU's own idea of either
 *     drifts from what the matrix encodes, every bias in the receiver is wrong.
 *   - the texel-snap guard band. Without it the snapped sphere's lateral edge
 *     lands at NDC 1.0008 and clips.
 *
 * The fit here MIRRORS ShadowSystem._fit() rather than importing it, because
 * _fit needs a Renderer, a Camera and a GPU preset. When one changes the other
 * must change with it - that is the point, the numbers below are the contract.
 *
 * Usage:  node tools/test-shadow.mjs
 */

import { mat4, vec3 } from '../src/core/math.js';
import { RENDER } from '../src/core/constants.js';

let failures = 0;
let checks = 0;

function ok(cond, label, detail = '') {
  checks++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;
function section(n) { console.log(`\n${n}`); }

/** Apply a column-major mat4 to a point. */
function xform(m, x, y, z) {
  return {
    x: m[0] * x + m[4] * y + m[8] * z + m[12],
    y: m[1] * x + m[5] * y + m[9] * z + m[13],
    z: m[2] * x + m[6] * y + m[10] * z + m[14],
    w: m[3] * x + m[7] * y + m[11] * z + m[15],
  };
}

// ---------------------------------------------------------------------------

section('mat4.orthoReverseZ maps the caster range into [0, 1]');
{
  const o = new Float32Array(16);
  const near0 = 0, far0 = 100;
  mat4.orthoReverseZ(o, -10, 10, -10, 10, near0, far0);

  // mat4.lookAt is right-handed, so a point in front of the light camera has
  // NEGATIVE view z. z_view = -near is the plane facing the light.
  const atNear = xform(o, 0, 0, -near0);
  const atFar = xform(o, 0, 0, -far0);
  const atMid = xform(o, 0, 0, -50);
  ok(near(atNear.z, 1, 1e-6), 'z_view = -near maps to clip.z 1.0', `got ${atNear.z}`);
  ok(near(atFar.z, 0, 1e-6), 'z_view = -far maps to clip.z 0.0', `got ${atFar.z}`);
  ok(near(atMid.z, 0.5, 1e-6), 'z_view = -mid maps to clip.z 0.5', `got ${atMid.z}`);
  ok(atNear.z > atFar.z, 'REVERSE-Z: nearer the light is a GREATER depth');
  ok(atNear.w === 1 && atFar.w === 1,
    'orthographic clip.w is 1, so sampleShadowPCF cannot take its w <= 0 early-out');

  // |row2| is what shadow.wgsl's cascadeDepthScale() recovers.
  const row2 = Math.hypot(o[2], o[6], o[10]);
  ok(near(row2, 1 / (far0 - near0), 1e-9),
    '|row2| equals 1 / (far - near), which cascadeDepthScale recovers',
    `${row2} vs ${1 / (far0 - near0)}`);

  // A negative near is ordinary for an orthographic light volume - the near
  // plane routinely sits behind the light camera's own origin.
  const n2 = new Float32Array(16);
  mat4.orthoReverseZ(n2, -10, 10, -10, 10, -64, 270);
  ok(near(xform(n2, 0, 0, 64).z, 1, 1e-5), 'negative ortho near still maps to 1.0');
  ok(near(xform(n2, 0, 0, -270).z, 0, 1e-5), 'and its far still maps to 0.0');

  const x = xform(o, 10, -10, -50);
  ok(near(x.x, 1, 1e-6) && near(x.y, -1, 1e-6),
    'the lateral extents map to NDC +-1', `x=${x.x} y=${x.y}`);
}

// ---------------------------------------------------------------------------

section('Frustum-slice bounding sphere');

/** MIRRORS ShadowSystem._fit(). */
function fitRadius(near0, far0, k2) {
  if (k2 * (far0 + near0) >= far0 - near0) {
    return { zc: far0, radius: far0 * Math.sqrt(k2) };
  }
  return {
    zc: 0.5 * (far0 + near0) * (1 + k2),
    radius: 0.5 * Math.sqrt((far0 - near0) * (far0 - near0)
      + 2 * (far0 * far0 + near0 * near0) * k2
      + (far0 + near0) * (far0 + near0) * k2 * k2),
  };
}

/** Farthest a frustum-slice corner sits from a centre on the view axis. */
function cornerDistance(zc, z, tx, ty) {
  return Math.hypot(z - zc, z * tx, z * ty);
}

{
  // The MEASURED camera at the QA spawn. baseFov is 75 degrees but the rig's
  // speed kick moves it, which is why _fit reads camera.fov live.
  const fov = 62 * Math.PI / 180;
  const aspect = 2.2145328719723185;
  const ty = Math.tan(fov * 0.5);
  const tx = ty * aspect;
  const k2 = tx * tx + ty * ty;
  ok(near(Math.sqrt(k2), 1.4598, 2e-3), 'corner slope k = sqrt(tx^2 + ty^2)',
    `${Math.sqrt(k2).toFixed(4)}`);

  const splits = RENDER.SHADOW_SPLITS;
  const expect = [36.8, 98.1, 233.0, 613.2];
  for (let i = 0; i < 4; i++) {
    const n = i === 0 ? 0 : RENDER.SHADOW_FAR * splits[i - 1];
    const f = RENDER.SHADOW_FAR * splits[i];
    const { zc, radius } = fitRadius(n, f, k2);
    ok(near(radius, expect[i], 0.2), `cascade ${i} radius`, `${radius.toFixed(1)} m`);
    // The sphere must actually CONTAIN the slice, or the cascade has a hole in
    // it that no bias can fix.
    const dNear = cornerDistance(zc, n, tx, ty);
    const dFar = cornerDistance(zc, f, tx, ty);
    ok(dNear <= radius + 1e-6 && dFar <= radius + 1e-6,
      `cascade ${i} sphere contains both corner rings`,
      `near ${dNear.toFixed(2)} far ${dFar.toFixed(2)} <= ${radius.toFixed(2)}`);
  }

  // A NARROW frustum takes the other branch, which is the one the wide QA
  // camera never exercises.
  {
    const nty = Math.tan((40 * Math.PI / 180) * 0.5);
    const ntx = nty * 1.0;
    const nk2 = ntx * ntx + nty * nty;
    const n = 100, f = 400;
    ok(nk2 * (f + n) < f - n, 'narrow FOV takes the interior-centre branch');
    const { zc, radius } = fitRadius(n, f, nk2);
    ok(zc > n && zc < f, 'its centre lies inside the slice', `zc ${zc.toFixed(1)}`);
    const dNear = cornerDistance(zc, n, ntx, nty);
    const dFar = cornerDistance(zc, f, ntx, nty);
    ok(near(dNear, radius, 1e-6) && near(dFar, radius, 1e-6),
      'and both corner rings sit exactly ON the sphere',
      `${dNear.toFixed(4)} / ${dFar.toFixed(4)} vs ${radius.toFixed(4)}`);
  }
}

// ---------------------------------------------------------------------------

section('Caster/receiver handshake: the matrix carries the fit');

/**
 * MIRRORS ShadowSystem._fit(): build one cascade's matrix from an absolute
 * sphere centre. Returns the matrix plus the numbers the CPU believes.
 */
function buildCascade(centreAbs, radius, sunDir, worldOrigin, res) {
  const V = new Float32Array(16);
  const negSun = vec3.create(-sunDir[0], -sunDir[1], -sunDir[2]);
  mat4.lookAt(V, vec3.create(0, 0, 0), negSun, vec3.create(0, 1, 0));
  const s = [V[0], V[4], V[8]];
  const u = [V[1], V[5], V[9]];
  const d = [V[2], V[6], V[10]];

  const GUARD = RENDER.SHADOW_FIT_GUARD_TEXELS;
  const EXT = RENDER.SHADOW_CASTER_EXTRUSION;
  const texel = 2 * radius / (res - 2 * GUARD);
  const half = texel * res * 0.5;

  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const snapX = Math.floor(dot(centreAbs, s) / texel) * texel;
  const snapY = Math.floor(dot(centreAbs, u) / texel) * texel;
  const snapZ = Math.floor(dot(centreAbs, d));

  const rx = snapX - dot(worldOrigin, s);
  const ry = snapY - dot(worldOrigin, u);
  const rz = snapZ - dot(worldOrigin, d);

  const O = new Float32Array(16);
  mat4.orthoReverseZ(O, rx - half, rx + half, ry - half, ry + half,
    -rz - radius - EXT, -rz + radius + 1);
  const M = new Float32Array(16);
  mat4.multiply(M, O, V);
  return { M, texel, half, radius, depthRange: 2 * radius + EXT + 1, s, u, d, snapZ };
}

{
  const res = RENDER.SHADOW_RESOLUTION;
  const sunDir = [0.9014362692832947, 0.42340120673179626, 0.09024476259946823];
  const camera = [-240.88, 5.20, -382.91];
  const forward = [0.67686927318573, 0, 0.7361032962799072];

  const fov = 62 * Math.PI / 180;
  const ty = Math.tan(fov * 0.5);
  const tx = ty * 2.2145328719723185;
  const k2 = tx * tx + ty * ty;

  for (const worldOrigin of [[0, 0, 0], [-2048, 0, 3072]]) {
    const tag = worldOrigin[0] === 0 ? 'origin 0' : 'after a rebase';
    const { zc, radius } = fitRadius(0, RENDER.SHADOW_FAR * RENDER.SHADOW_SPLITS[0], k2);
    const centreAbs = [
      camera[0] + forward[0] * zc,
      camera[1] + forward[1] * zc,
      camera[2] + forward[2] * zc,
    ];
    const fit = buildCascade(centreAbs, radius, sunDir, worldOrigin, res);
    const M = fit.M;

    // What shadow.wgsl recovers, verbatim from cascadeTexelWorldSize() and
    // cascadeDepthScale().
    const row0 = Math.hypot(M[0], M[4], M[8]);
    const row2 = Math.hypot(M[2], M[6], M[10]);
    const shaderTexel = 2 / (row0 * res);
    const shaderRange = 1 / row2;
    ok(near(shaderTexel, fit.texel, fit.texel * 1e-4),
      `${tag}: shader-recovered texel matches the CPU fit`,
      `${(shaderTexel * 100).toFixed(3)} cm vs ${(fit.texel * 100).toFixed(3)} cm`);
    ok(near(shaderRange, fit.depthRange, fit.depthRange * 1e-4),
      `${tag}: shader-recovered depth range matches 2R + EXT + 1`,
      `${shaderRange.toFixed(2)} m vs ${fit.depthRange.toFixed(2)} m`);

    // The sphere, in CAMERA-RELATIVE coordinates, must land inside NDC with the
    // guard band intact. This is the check that caught the missing guard: with
    // none, the lateral edge reaches 1.0008 and clips.
    const rel = [
      centreAbs[0] - worldOrigin[0],
      centreAbs[1] - worldOrigin[1],
      centreAbs[2] - worldOrigin[2],
    ];
    let maxAbsXY = 0;
    let minZ = Infinity, maxZ = -Infinity;
    const N = 64;
    for (let a = 0; a < N; a++) {
      for (let b = 0; b < N; b++) {
        const th = (a + 0.5) / N * Math.PI;
        const ph = (b + 0.5) / N * 2 * Math.PI;
        const p = xform(M,
          rel[0] + radius * Math.sin(th) * Math.cos(ph),
          rel[1] + radius * Math.cos(th),
          rel[2] + radius * Math.sin(th) * Math.sin(ph));
        maxAbsXY = Math.max(maxAbsXY, Math.abs(p.x), Math.abs(p.y));
        minZ = Math.min(minZ, p.z);
        maxZ = Math.max(maxZ, p.z);
      }
    }
    ok(maxAbsXY <= 1.0, `${tag}: every sphere point stays inside NDC |xy| <= 1`,
      `max ${maxAbsXY.toFixed(6)}`);
    ok(minZ >= 0 && maxZ <= 1, `${tag}: and inside clip.z [0, 1]`,
      `${minZ.toFixed(4)} .. ${maxZ.toFixed(4)}`);

    // A caster extruded toward the sun by the full extrusion must still be in.
    const up = xform(M,
      rel[0] + sunDir[0] * RENDER.SHADOW_CASTER_EXTRUSION,
      rel[1] + sunDir[1] * RENDER.SHADOW_CASTER_EXTRUSION,
      rel[2] + sunDir[2] * RENDER.SHADOW_CASTER_EXTRUSION);
    ok(up.z > 0 && up.z <= 1,
      `${tag}: a caster ${RENDER.SHADOW_CASTER_EXTRUSION} m up-sun still rasterises`,
      `clip.z ${up.z.toFixed(4)}`);
  }

  // The texel LATTICE must be world-anchored: translating the camera by a
  // fraction of a texel must not move the snapped origin at all.
  {
    const { zc, radius } = fitRadius(0, RENDER.SHADOW_FAR * RENDER.SHADOW_SPLITS[0], k2);
    const raw = [camera[0] + forward[0] * zc, camera[1], camera[2] + forward[2] * zc];
    const probe = buildCascade(raw, radius, sunDir, [0, 0, 0], res);
    const texel = probe.texel;
    const S = probe.s;
    // Slide the centre along the light's own x axis to the MIDDLE of its texel
    // cell, so a +-0.2 texel nudge is unambiguously inside one cell rather than
    // straddling a floor() boundary by accident.
    const lx = raw[0] * S[0] + raw[1] * S[1] + raw[2] * S[2];
    const toMid = (Math.floor(lx / texel) + 0.5) * texel - lx;
    const mid = [raw[0] + S[0] * toMid, raw[1] + S[1] * toMid, raw[2] + S[2] * toMid];
    const a = buildCascade(mid, radius, sunDir, [0, 0, 0], res);
    const nudge = (k) => buildCascade(
      [mid[0] + S[0] * texel * k, mid[1] + S[1] * texel * k, mid[2] + S[2] * texel * k],
      radius, sunDir, [0, 0, 0], res);
    const b = nudge(0.2), c = nudge(-0.2);
    ok(a.M[12] === b.M[12] && a.M[12] === c.M[12],
      'a sub-texel camera move leaves the snapped lattice exactly where it was');
    ok(nudge(9).M[12] !== a.M[12], 'and a nine-texel move does shift it');
  }
}

// ---------------------------------------------------------------------------

section('Documented bias, at the fit this build produces');
{
  const fov = 62 * Math.PI / 180;
  const ty = Math.tan(fov * 0.5);
  const tx = ty * 2.2145328719723185;
  const k2 = tx * tx + ty * ty;
  const EXT = RENDER.SHADOW_CASTER_EXTRUSION;
  const bias = [];
  for (let i = 0; i < 4; i++) {
    const n = i === 0 ? 0 : RENDER.SHADOW_FAR * RENDER.SHADOW_SPLITS[i - 1];
    const f = RENDER.SHADOW_FAR * RENDER.SHADOW_SPLITS[i];
    const { radius } = fitRadius(n, f, k2);
    bias.push((2 * radius + EXT + 1) * RENDER.SHADOW_DEPTH_BIAS * 100);
  }
  console.log(`  constant world bias per cascade: ${bias.map((b) => b.toFixed(1) + ' cm').join(', ')}`);
  ok(near(bias[0], 6.0, 0.15),
    'cascade 0 constant bias is the 6 cm shadow.wgsl documents', `${bias[0].toFixed(2)} cm`);
  ok(bias[3] < 30, 'and the last cascade stays under a half-texel of its own 59.9 cm',
    `${bias[3].toFixed(1)} cm`);
}

// ---------------------------------------------------------------------------

section('Split table agrees with shadow.wgsl');
{
  ok(RENDER.SHADOW_SPLITS.length === RENDER.SHADOW_CASCADES,
    'SHADOW_SPLITS has one entry per cascade');
  ok(RENDER.SHADOW_SPLITS[RENDER.SHADOW_CASCADES - 1] === 1.0,
    'the last split reaches SHADOW_FAR exactly');
  let rising = true;
  for (let i = 1; i < RENDER.SHADOW_SPLITS.length; i++) {
    if (RENDER.SHADOW_SPLITS[i] <= RENDER.SHADOW_SPLITS[i - 1]) rising = false;
  }
  ok(rising, 'splits are strictly increasing');
  // Mirrors cascadeSplitFraction(): fewer cascades drop the NEAREST splits.
  const pick = (count, i) => RENDER.SHADOW_SPLITS[i + (RENDER.SHADOW_CASCADES - count)];
  ok(pick(2, 0) === 0.38 && pick(2, 1) === 1.0,
    'a 2-cascade tier gets 0.38 / 1.00, matching cascadeSplitFraction()');
  ok(pick(3, 0) === 0.16 && pick(3, 2) === 1.0,
    'a 3-cascade tier gets 0.16 / 0.38 / 1.00');
}

console.log(`\n${failures === 0 ? 'Shadow fit verified.' : `${failures} FAILURE(S)`}  (${checks} checks)`);
process.exit(failures === 0 ? 0 : 1);
