/**
 * SUBWAVE terrain mesher worker.
 *
 * A module Web Worker - a platform API, so it breaches no dependency rule and
 * needs no build step. It exists because one LOD-0 bake is a measured 17.71 ms
 * mean / 23.32 ms p99, up to four 120 Hz frames, and a bake is INDIVISIBLE: no
 * frame budget can cut one in half. Moving it off the frame is the only fix,
 * and it takes the main-thread cost of a LOD-0 chunk from 17.71 ms to the two
 * writeBuffer calls that remain, measured at 0.02 ms.
 *
 * DETERMINISM. A chunk is a pure function of (cx, cz, lod) and the seed -
 * terrain.js has no Math.random, no Date.now in the geometry path, no closure
 * over live objects and no iteration-order dependence, and every scratch buffer
 * it keeps is per-module-instance, so a worker simply gets its own private
 * copy. The migration was verified by baking chunk (7, 11, 0) on both sides and
 * comparing: 0 differing bytes of 686,120 vertex bytes and 0 of 202,752 index
 * bytes. The one real hazard is the SEED - terrain.js derives its seeds at
 * module load from WORLD.DEFAULT_SEED and the game overrides that afterwards -
 * so the main thread treats a worker as unusable until it has answered `ready`,
 * which makes a bake arriving before its `init` structurally impossible.
 *
 * TRANSFER, NEVER SHARE. The mesh comes back as one transferred ArrayBuffer.
 * A SharedArrayBuffer would let two workers alias the same region and would
 * trade the determinism contract for nothing: the measured transfer round trip
 * is 0.01 ms for 889 KB.
 *
 * WORKER-SAFE IMPORT GRAPH. Nothing reachable from terrain.js may touch the
 * DOM, the GPU or `window`. A module-resolution failure here surfaces as an
 * `error` event with an EMPTY message, so the failure mode is silent; the
 * `ready` handshake in chunks.js is what turns it into one warning and an
 * inline fallback rather than a dead streamer.
 *
 * PROTOCOL, exhaustive.
 *   main -> worker  { t: 'init', seed }                        transfer: none
 *                   { t: 'bake', key, cx, cz, lod, seq }       transfer: none
 *                   { t: 'recycle', buf }                      transfer: [buf]
 *   worker -> main  { t: 'ready', seed }
 *                   { t: 'baked', key, cx, cz, lod, seq, buf, vbBytes, ibBytes,
 *                     vertexCount, indexCount, triangleCount, skirtDepth,
 *                     aabb, bakeMs }                           transfer: [buf]
 *                   { t: 'error', key, seq, message }
 *
 * `buf` layout: [0, vbBytes) interleaved vertices at VERTEX_STRIDE = 40 bytes,
 * then [vbBytes, vbBytes + ibBytes) Uint16 indices. One packed buffer rather
 * than two costs nothing - the interleaved vertex bytes are byte-for-byte the
 * same total as the six separate arrays bakeChunk returns - and it halves both
 * the message size and the free-list bookkeeping.
 */

import { STREAMING } from '../core/constants.js';
import { bakeChunk, interleaveChunk, setSeed, VERTEX_STRIDE } from './terrain.js';

/**
 * Spare transfer buffers, keyed by EXACT byte length.
 *
 * The main thread hands every buffer back the moment its upload has copied out
 * of it. Without that, a pool flying at Vne produces ~3.5 MB/s of large
 * transferred ArrayBuffers that become main-thread garbage - reintroducing
 * precisely the main-thread GC pauses this whole change exists to remove.
 *
 * @type {Map<number, ArrayBuffer[]>}
 */
const spare = new Map();

/** A buffer of exactly `bytes`, recycled if one is free. */
function take(bytes) {
  const free = spare.get(bytes);
  if (free !== undefined && free.length > 0) return free.pop();
  return new ArrayBuffer(bytes);
}

/** Keep a returned buffer if the free list for its size has room. */
function keep(buf) {
  // A buffer that was transferred away again arrives detached (byteLength 0);
  // pooling it would hand back an unusable allocation.
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
    const c = bakeChunk(m.cx, m.cz, m.lod);
    // vertexCount * 40 and indexCount * 2 with indexCount a multiple of 6, so
    // both regions are 4-byte aligned and the typed-array views below are legal
    // whatever the LOD.
    const vbBytes = c.vertexCount * VERTEX_STRIDE;
    const ibBytes = c.indices.byteLength;
    const buf = take(vbBytes + ibBytes);
    // interleaveChunk needs its f32 and u8 views over the SAME buffer at the
    // same origin; these cover the vertex region only and leave the indices
    // untouched.
    interleaveChunk(c, new Float32Array(buf, 0, vbBytes >> 2), new Uint8Array(buf, 0, vbBytes));
    new Uint16Array(buf, vbBytes, ibBytes >> 1).set(c.indices);
    self.postMessage({
      t: 'baked', key: m.key, cx: m.cx, cz: m.cz, lod: m.lod, seq: m.seq,
      buf, vbBytes, ibBytes,
      vertexCount: c.vertexCount, indexCount: c.indexCount,
      triangleCount: c.triangleCount, skirtDepth: c.skirtDepth,
      aabb: c.aabb, bakeMs: c.bakeMs,
    }, [buf]);
  } catch (e) {
    // A bake that throws is a bug in the mesher, not in the worker, so it is
    // reported per JOB. Retiring the worker instead would halve the pool and
    // hide the real fault behind a performance change.
    self.postMessage({
      t: 'error', key: m.key, seq: m.seq,
      message: String((e && e.stack) || (e && e.message) || e),
    });
  }
};
