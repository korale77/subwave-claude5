/**
 * SUBWAVE cave mesher worker.
 *
 * The cave twin of terrain_worker.js, and it exists for the same measured
 * reason: one cave chunk bake is 14-75 ms of field evaluation and marching
 * cubes (tools/test-caves.mjs prints the field half; the packed bake adds the
 * cull and encode), which is up to nine 120 Hz frames and INDIVISIBLE. The
 * terrain bake budget has about 2 ms of idle margin, so none of this may ever
 * run on the frame. What stays on the main thread is the upload: two
 * writeBuffer calls on a transferred ArrayBuffer.
 *
 * DETERMINISM. A cave chunk is a pure function of (cx, cy, cz) and the seed:
 * caves.js re-derives its seeds from terrain.getSeed() on every public entry,
 * has no Math.random and no iteration-order dependence, and its macro-graph
 * cache is verified NOT load-bearing by test-caves.mjs (a cold cache is
 * bit-identical). The `ready` handshake makes a bake arriving before its
 * `init` structurally impossible, exactly as the terrain worker's does.
 *
 * PROTOCOL, exhaustive.
 *   main -> worker  { t: 'init', seed }                          transfer: none
 *                   { t: 'bake', key, cx, cy, cz, seq }          transfer: none
 *                   { t: 'recycle', buf }                        transfer: [buf]
 *   worker -> main  { t: 'ready', seed }
 *                   { t: 'baked', key, seq, empty: true }        (no geometry)
 *                   { t: 'baked', key, seq, buf, vbBytes, ibBytes, vertexCount,
 *                     indexCount, triangleCount, aabb, grottoFraction,
 *                     culledTriangles, sparCount, sparCounts, sparBytes,
 *                     propCount, propCounts, propBytes,
 *                     bakeMs }                                   transfer: [buf]
 *                   { t: 'error', key, seq, message }
 *
 * An EMPTY answer is an answer, not a failure: most probed addresses contain
 * no cave surface at all (occupancy rejects them inside generateCaveChunk for
 * 28 us), and the manager caches the emptiness forever - it is deterministic.
 */

import { STREAMING } from '../core/constants.js';
import { setSeed } from './terrain.js';
import { bakeCaveChunk } from './cave_mesh.js';

/** Spare transfer buffers by exact byte length; see terrain_worker.js. */
const spare = new Map();

function take(bytes) {
  const free = spare.get(bytes);
  if (free !== undefined && free.length > 0) return free.pop();
  return new ArrayBuffer(bytes);
}

function keep(buf) {
  if (!buf || buf.byteLength === 0) return;
  let free = spare.get(buf.byteLength);
  if (free === undefined) { free = []; spare.set(buf.byteLength, free); }
  if (free.length < STREAMING.WORKER_FREE_LIST_PER_SIZE) free.push(buf);
}

self.onmessage = (ev) => {
  const m = ev.data;

  if (m.t === 'init') {
    setSeed(m.seed >>> 0);
    self.postMessage({ t: 'ready', seed: m.seed >>> 0 });
    return;
  }

  if (m.t === 'recycle') { keep(m.buf); return; }
  if (m.t !== 'bake') return;

  try {
    const baked = bakeCaveChunk(m.cx, m.cy, m.cz, take);
    if (!baked) {
      self.postMessage({ t: 'baked', key: m.key, seq: m.seq, empty: true });
      return;
    }
    self.postMessage({
      t: 'baked', key: m.key, seq: m.seq,
      buf: baked.buf, vbBytes: baked.vbBytes, ibBytes: baked.ibBytes,
      vertexCount: baked.vertexCount, indexCount: baked.indexCount,
      triangleCount: baked.triangleCount, aabb: baked.aabb,
      grottoFraction: baked.grottoFraction,
      culledTriangles: baked.culledTriangles,
      sparCount: baked.sparCount, sparCounts: baked.sparCounts,
      sparBytes: baked.sparBytes,
      propCount: baked.propCount, propCounts: baked.propCounts,
      propBytes: baked.propBytes, bakeMs: baked.bakeMs,
    }, [baked.buf]);
  } catch (e) {
    self.postMessage({
      t: 'error', key: m.key, seq: m.seq,
      message: String((e && e.stack) || (e && e.message) || e),
    });
  }
};
