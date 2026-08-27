#!/usr/bin/env node
/**
 * CORRIDOR SEARCH, the authoring companion to tools/probes/demo-path.mjs.
 *
 * demo-path audits a route that already exists; this one FINDS one. From a
 * biome anchor it sweeps candidate bearings and eye heights, flies each as a
 * straight run of `--len` metres, and ranks them by the minimum clearance to
 * the heightfield and to the live scatter proxies - so a demo leg can be
 * authored against a measured corridor instead of against a guess, which is
 * how the coral and Platter legs ended up inside a fan and a spire trunk.
 *
 *   node tools/probes/demo-corridor.mjs --anchor platter --len 120 --up 12,18,24
 *
 * Same instrument and same caveats as demo-path.mjs: real proxies from a real
 * ScatterCollision, and kelp is not a collidable row.
 */

import { WORLD } from '../../src/core/constants.js';
import * as terrain from '../../src/world/terrain.js';
import { setBiomeSeed } from '../../src/world/biomes.js';
import { CollisionWorld } from '../../src/world/collision.js';
import { ScatterCollision } from '../../src/world/scatter_collision.js';
import { SCATTER_TYPES } from '../../src/world/scatter.js';
import { getBiomeAnchors } from '../../src/world/biome_anchors.js';

const args = process.argv.slice(2);
const flag = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const ANCHOR = flag('--anchor', 'coral');
const LEN = Number(flag('--len', 60));
const UPS = String(flag('--up', '2,4,6')).split(',').map(Number);
const SWEEP = Number(flag('--sweep', Math.PI));      // +- radians about the centre
/** Centre of the sweep, radians relative to the anchor's own view yaw. */
const OFFSET = Number(flag('--offset', 0));
const NBEAR = Number(flag('--bearings', 49));
const STEP = 0.5;
const TOP = Number(flag('--top', 12));
/** Follow the seabed (constant height above it) or hold a level line. */
const LEVEL = args.includes('--level');

terrain.setSeed(WORLD.DEFAULT_SEED);
setBiomeSeed(WORLD.DEFAULT_SEED);
const collision = new CollisionWorld(terrain, { seed: WORLD.DEFAULT_SEED });
const scatterCol = new ScatterCollision(collision);
const statics = collision.statics;
const TYPE_KEY = SCATTER_TYPES.map((t) => t.key);
const scratch = new Int32Array(512);

/** `--at x,z [--yaw deg]` searches around an arbitrary point instead of an
 *  anchor - the authored PLACES (world/places.js) are not biome anchors and
 *  three demo segments cut to one. */
const AT = flag('--at', null);
const a = AT
  ? (() => { const [x, z] = AT.split(',').map(Number);
      return { short: 'point', viewX: x, viewZ: z, yaw: Number(flag('--yaw', 0)) * Math.PI / 180 }; })()
  : getBiomeAnchors(terrain).find((r) => r.short === ANCHOR);
if (!a) { console.error(`no anchor '${ANCHOR}'`); process.exit(1); }

/**
 * Prime the proxy set AROUND A POINT, and re-prime as the walk moves.
 *
 * ScatterCollision keeps `RING = 1` - a 3x3 chunk block, 384 m across - and
 * UNREGISTERS everything else the moment the focus crosses a chunk boundary.
 * A one-shot priming sweep over the whole search area therefore leaves only the
 * LAST block registered and silently reports empty water everywhere else, which
 * is exactly the kind of instrument that passes a route into a tree trunk. So
 * the walk carries its own focus, the same way tools/probes/demo-path.mjs does.
 */
let primeX = Infinity, primeZ = Infinity;
function primeAt(x, z) {
  if (Math.abs(x - primeX) <= 32 && Math.abs(z - primeZ) <= 32) return;
  const f = Float32Array.of(x, 0, z);
  scatterCol.update(f, f);
  for (let i = 0; i < 400 && scatterCol._queue.length > 0; i++) scatterCol.update(f, f);
  primeX = x; primeZ = z;
}

function capsuleDist(id, x, y, z) {
  const ax = statics.ax[id], ay = statics.ay[id], az = statics.az[id];
  const dx = statics.bx[id] - ax, dy = statics.by[id] - ay, dz = statics.bz[id] - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  let t = 0;
  if (len2 > 1e-9) {
    t = ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  return Math.hypot(x - (ax + dx * t), y - (ay + dy * t), z - (az + dz * t)) - statics.r[id];
}

const rows = [];
const y0 = terrain.sampleHeight(a.viewX, a.viewZ);
for (const up of UPS) {
  for (let b = 0; b < NBEAR; b++) {
    const rel = OFFSET - SWEEP + (2 * SWEEP * b) / (NBEAR - 1);
    const yaw = a.yaw + rel;
    let minProp = Infinity, minKey = '-', minGround = Infinity, propAt = 0, groundAt = 0;
    let nProps = 0;
    const n = Math.ceil(LEN / STEP);
    for (let i = 0; i <= n; i++) {
      const d = (i / n) * LEN;
      const x = a.viewX + Math.sin(yaw) * d, z = a.viewZ - Math.cos(yaw) * d;
      primeAt(x, z);
      const h = terrain.sampleHeight(x, z);
      const y = LEVEL ? y0 + up : h + up;
      const g = y - h;
      if (g < minGround) { minGround = g; groundAt = d; }
      const m = statics.query(x, y, z, 40, scratch);
      for (let k = 0; k < m; k++) {
        const dd = capsuleDist(scratch[k], x, y, z);
        if (dd < 22) nProps++;
        if (dd < minProp) { minProp = dd; minKey = TYPE_KEY[statics.typeId[scratch[k]]] || '?'; propAt = d; }
      }
    }
    rows.push({ rel, up, minProp, minKey, propAt, minGround, groundAt, nProps });
  }
}

// Rank by clearance, then by how much scenery the run passes - a corridor
// through empty water is clear and worthless.
rows.sort((p, q) => (Math.min(q.minProp, q.minGround) - Math.min(p.minProp, p.minGround))
  || (q.nProps - p.nProps));

console.log(`\ncorridor search  anchor ${ANCHOR} (${a.viewX}, ${a.viewZ})  floor ${y0.toFixed(1)} m` +
  `  yaw ${(a.yaw * 180 / Math.PI).toFixed(1)} deg  len ${LEN} m  ${LEVEL ? 'level' : 'terrain-following'}\n`);
console.log('  rel(rad)  rel(deg)   up    minProp        at   minGround     at   nearProps');
for (const r of rows.slice(0, TOP)) {
  console.log(`  ${r.rel.toFixed(2).padStart(8)} ${(r.rel * 180 / Math.PI).toFixed(1).padStart(9)} ` +
    `${r.up.toFixed(0).padStart(4)} ${(r.minProp === Infinity ? 'inf' : r.minProp.toFixed(1)).padStart(9)} ` +
    `${r.minKey.padEnd(16)} ${r.minGround.toFixed(1).padStart(6)} ${r.groundAt.toFixed(0).padStart(6)} ` +
    `${String(r.nProps).padStart(8)}`);
}
console.log('');
