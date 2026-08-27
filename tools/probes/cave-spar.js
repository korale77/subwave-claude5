/**
 * GEODE SPAR: determinism and delivery, offline, no browser.
 *
 * 1. Bakes the First Hollow chamber's cave chunk TWICE (cold cache both
 *    times, worker-free inline path) and byte-compares the ENTIRE packed
 *    buffer - vertices, indices and the appended spar instances - because a
 *    spar layout that drifts between bakes would pop between visits.
 * 2. Surveys the chamber neighbourhood for delivered spar instances: count
 *    per chunk, per-variant partition, scale range, and the band/rock gates
 *    re-checked against the field (an instance outside the Geode band or on
 *    daylight rock is a bake bug, not a tuning choice).
 *
 * Run: node tools/probes/cave-spar.js
 */

import { WORLD } from '../../src/core/constants.js';
import * as terrain from '../../src/world/terrain.js';
import { clearCaveCache, isInsideCave } from '../../src/world/caves.js';
import { bakeCaveChunk, SPAR_INSTANCE_STRIDE } from '../../src/world/cave_mesh.js';

terrain.setSeed(WORLD.DEFAULT_SEED);

const CHAMBER = { x: 1903.1, y: -661.7, z: 1349.3 };
const ccx = Math.floor(CHAMBER.x / 32), ccy = Math.floor(CHAMBER.y / 32), ccz = Math.floor(CHAMBER.z / 32);

// --- 1. determinism -------------------------------------------------------
clearCaveCache();
const a = bakeCaveChunk(ccx, ccy, ccz);
clearCaveCache();
const b = bakeCaveChunk(ccx, ccy, ccz);
if (!a || !b) {
  console.log('FAIL: chamber chunk baked empty', !!a, !!b);
  process.exit(1);
}
const ua = new Uint8Array(a.buf, 0, a.vbBytes + a.ibBytes + a.sparBytes);
const ub = new Uint8Array(b.buf, 0, b.vbBytes + b.ibBytes + b.sparBytes);
let identical = ua.length === ub.length;
if (identical) for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) { identical = false; break; }
console.log(`determinism: two cold bakes of (${ccx},${ccy},${ccz}) byte-identical over ` +
  `${ua.length} bytes (vb ${a.vbBytes} + ib ${a.ibBytes} + spar ${a.sparBytes}): ${identical ? 'YES' : 'NO'}`);
console.log(`  sparCount ${a.sparCount}, variants [${a.sparCounts}]`);

// --- 2. delivery over the chamber neighbourhood ----------------------------
let total = 0, chunksWith = 0, chunksBaked = 0;
let scaleMin = Infinity, scaleMax = -Infinity;
let bandBad = 0, voidBad = 0;
const perChunk = [];
for (let dz = -2; dz <= 2; dz++) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const baked = bakeCaveChunk(ccx + dx, ccy + dy, ccz + dz);
      if (!baked) continue;
      chunksBaked++;
      if (baked.sparCount === 0) continue;
      chunksWith++;
      total += baked.sparCount;
      perChunk.push(`(${ccx + dx},${ccy + dy},${ccz + dz}):${baked.sparCount}`);
      const sf = new Float32Array(baked.buf, baked.vbBytes + baked.ibBytes,
        baked.sparCount * (SPAR_INSTANCE_STRIDE >> 2));
      const ox = (ccx + dx) * 32 - 1, oy = (ccy + dy) * 32 - 1, oz = (ccz + dz) * 32 - 1;
      for (let i = 0; i < baked.sparCount; i++) {
        const o = i * 8;
        const wx = sf[o] + ox, wy = sf[o + 1] + oy, wz = sf[o + 2] + oz;
        const s = sf[o + 3];
        if (s < scaleMin) scaleMin = s;
        if (s > scaleMax) scaleMax = s;
        if (wy > -560 || wy < -1050) bandBad++;
        // The seed vertex is ON the wall, so the point itself is at void ~0;
        // being inside the cave one metre along the normal is the real claim.
        const nx = sf[o + 4], ny = sf[o + 5], nz = sf[o + 6];
        if (!isInsideCave(wx + nx, wy + ny, wz + nz)) voidBad++;
      }
    }
  }
}
console.log(`delivery: ${total} instances in ${chunksWith}/${chunksBaked} baked chunks of the 5^3 neighbourhood`);
console.log(`  per chunk: ${perChunk.join(' ')}`);
console.log(`  scale ${scaleMin.toFixed(3)}..${scaleMax.toFixed(3)} of the 3.4 m mesh ` +
  `(${(scaleMin * 3.4).toFixed(2)}..${(scaleMax * 3.4).toFixed(2)} m delivered)`);
console.log(`  band violations ${bandBad}, off-wall (1 m along normal not in cave) ${voidBad}`);
console.log(identical && bandBad === 0 ? 'PROBE PASS' : 'PROBE FAIL');
