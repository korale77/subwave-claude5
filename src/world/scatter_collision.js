/**
 * SUBWAVE static scatter collision - backlog item 3.5.
 *
 * "You swim straight through the Vent Cathedral": 32 of the 51 scatter rows
 * carry `collidable: true`, packed into every instance's flag byte since the
 * table was written, and until this module nothing read it. This module makes
 * them solid to the PLAYER and the VESSEL:
 *
 *   - it maintains a small ring of chunks (3x3, 128 m each) around the player
 *     and around the vessel, re-baking each chunk's COLLIDABLE instances with
 *     `generateScatterForChunk(cx, cz, 0, { collidableOnly: true })` - the
 *     same pure function the renderer draws from, so a proxy exists exactly
 *     where an instance is drawn (same seed, same placement walk, byte-
 *     identical instances; see the collidableOnly doc in scatter.js);
 *   - it converts each instance into one or two ANALYTIC CAPSULES via the
 *     authored PROXY_CAPSULES table below and registers them in
 *     `CollisionWorld.statics` (the second spatial hash - the entity hash is
 *     2,048 slots with a 16 m cell and would neither hold nor find them);
 *   - `CollisionWorld.resolveCapsule` / `resolveVesselHull` do the narrow
 *     phase, so the player and the vessel needed no changes at all.
 *
 * WHY A SEPARATE STREAMER AND NOT THE RENDER PASS'S. The scatter render pass
 * streams a multi-kilometre LOD'd resident set on the CAMERA; collision needs
 * lod-0 truth in a couple of hundred metres around two BODIES, and the sim
 * must not reach into a render pass for physics data (a headless test has no
 * render pass at all). Re-baking is affordable IN THE STEADY STATE, WHICH
 * BAKES NOTHING - chunks re-bake only when a focus crosses a 128 m boundary,
 * at most one chunk per sim step. THE CROSSING ITSELF IS A REAL HITCH AND
 * BOTH ARMS OF THE MEASUREMENT ARE RECORDED HERE, per the quote-both-arms
 * rule: a collidable-only bake measures 1.5-2.8 ms per chunk warm (6 varied
 * chunks) but test-scatter-collision section 3 has measured a WORST of
 * 8.17 ms on the same tree, and qa's underwater-shallow p99 of 16.4 ms
 * (against 9.8-10.2 at the other ten stations) is consistent with one bake
 * landing inside one 120 fps frame. The steady state and the toggle are
 * unaffected; the fix, when the hitch is judged to matter in play, is a
 * velocity-lookahead prefetch or a worker bake, not a bigger budget - see
 * STATUS backlog.
 *
 * DETERMINISM. Proxies are a pure function of (cx, cz, seed) - the instance
 * walk is the scatter table's own - and registration order is instance order
 * within a chunk, so a save reloaded at the same spot rebuilds the same hash.
 *
 * CREATURES DELIBERATELY GET NOTHING HERE. The spawner/AI budget is its own
 * world (fish steer by raycast and flow fields, not by contact), and giving
 * 260 agents a proxy narrow phase would buy visual nothing at real cost.
 */

import { WORLD } from '../core/constants.js';
import {
  SCATTER_TYPES, SCATTER_TYPE_COUNT, SCATTER_FLAG, generateScatterForChunk,
} from './scatter.js';

const CHUNK_SIZE = WORLD.CHUNK_SIZE;

/** Chunk ring half-width around each focus: 1 -> 3x3 chunks, so proxies exist
 *  at least 128 m ahead of a body - 1.07 s of lead at the 120 m/s airspeed
 *  Vne, against a worst refill of 5 chunks x 1 step = 83 ms per crossing. */
const RING = 1;

/**
 * ANALYTIC PROXY CAPSULES PER COLLIDABLE ROW, in MESH-LOCAL units.
 *
 * Each entry is one or more capsules `[x0, y0, z0, x1, y1, z1, r]`: a segment
 * plus a radius, in the generator's own mesh space at scale 1. At registration
 * the endpoints go through the instance's scaled basis (so scale, stretch,
 * yaw, slope alignment and tilt are all honoured for free) and the radius is
 * scaled by the mean of the two basis lengths perpendicular to the capsule's
 * dominant local axis - a chimney stretched x2.6 in Y must not get x2.6 fatter.
 *
 * THE NUMBERS ARE MEASURED, NOT GUESSED, and tools/test-scatter-collision.mjs
 * rebuilds every mesh and re-measures them so they cannot drift the way the
 * test-meshgen registry sizes did. Method: build the row's mesh with
 * `scatterGeneratorArgs(type, {...meshParams, detail: maxDetail})`, take the
 * AABB and the area-weighted 50th/80th-percentile horizontal radius of the
 * triangle centroids (r50/r80), and author a capsule near r80 for compact
 * forms, r50 for splayed ones. UNDER-BLOCKING IS THE CHOSEN ERROR DIRECTION:
 * a fin tip or a canopy edge you can swim through reads as soft growth; an
 * invisible wall half a metre outside a chimney reads as a bug. Fans/veils
 * block near their stem plane only; the mushroom cap, kelp (not collidable),
 * whale-fall ribs and rib arches stay swim-through on purpose.
 *
 * Stats quoted per row: mesh y-range, r50/r80, from the measurement above.
 */
export const PROXY_CAPSULES = Object.freeze({
  // y [0.00,1.86] r50 0.45 r80 0.70 - branching head, trunk plus lower canopy
  coralBranching: [[0, 0.2, 0, 0, 1.3, 0, 0.55]],
  // y [-0.12,0.62] r50 0.64 r80 0.86 - a low dome; squat capsule
  coralBrain: [[0, -0.05, 0, 0, 0.05, 0, 0.6]],
  // y [0.00,1.66] r50 0.38 r80 0.74, plane centroid x ~0.35 - stem band only
  coralFan: [[0.35, 0.5, 0, 0.35, 1.2, 0, 0.45]],
  // y [-0.24,1.20] r50 0.59 r80 0.95 - barrel body, bore stays open-topped
  spongeBarrel: [[0, 0.1, 0, 0, 0.7, 0, 0.62]],
  // y [-0.83,1.24] r50 0.89 r80 1.01 - sunken blob
  rockMedium: [[0, -0.25, 0, 0, 0.35, 0, 0.85]],
  // y [-0.60,0.64] r50 0.67 r80 0.78
  boulder: [[0, -0.15, 0, 0, 0.15, 0, 0.7]],
  // y [-0.12,1.96] r50 0.11 r80 0.21 - slender prism cluster core
  crystalSpire: [[0, 0, 0, 0, 1.6, 0, 0.24]],
  // y [0,5.80] r50 1.32 r80 1.99 - STEM ONLY; the 2.3 m cap is passable above
  mushroomCluster: [[0, 0.6, 0, 0, 4.6, 0, 0.8]],
  // y [0.00,1.20] r50 0.20 r80 0.25 - stacked cone
  ventChimney: [[0, 0.1, 0, 0, 0.95, 0, 0.26]],
  // y [-0.05,1.33] r50 0.07 r80 0.17 - one thin rib, centroid z ~ -0.2
  boneRib: [[0, 0.15, -0.2, 0, 1.1, -0.2, 0.14]],
  // ore nodes: y ~[-0.8,1.0] r80 0.83-1.03 - attached blobs
  oreIron: [[0, -0.15, 0, 0, 0.25, 0, 0.8]],
  oreCopper: [[0, -0.1, 0, 0, 0.3, 0, 0.85]],
  oreTitanium: [[0, -0.1, 0, 0, 0.25, 0, 0.9]],
  oreQuartz: [[0, -0.15, 0, 0, 0.25, 0, 0.72]],
  // y [0.00,4.45] r50 0.33 r80 0.84 - a column
  reefPillar: [[0, 0.4, 0, 0, 3.9, 0, 0.6]],
  // y [0.00,4.18] r50 1.34 r80 2.04 - broad crown; core mass only
  coralCrown: [[0, 0.6, 0, 0, 3.2, 0, 1.35]],
  // y [0.00,4.14] r50 1.23 r80 2.20, a 0.4 m-thick sail - stem band
  sandSail: [[0, 0.5, 0, 0, 3.5, 0, 0.9]],
  // y [-0.62,1.02] r50 0.81 r80 0.99 - flattened boulder, scales 4.8-9.5
  boulderShelter: [[0, -0.2, 0, 0, 0.3, 0, 0.9]],
  // y [-0.91,3.80] r50 1.78 r80 2.39 - urn cluster
  shelfUrn: [[0, 0, 0, 0, 2.4, 0, 1.5]],
  // y [-0.38,5.24] r50 0.37 r80 0.54
  spireCrown: [[0, 0, 0, 0, 4.6, 0, 0.45]],
  // y [0.00,4.97] r50 1.06 r80 1.93, plane centroid x ~0.4 - stem band
  terraceVeil: [[0.4, 0.6, 0, 0.4, 4.0, 0, 0.7]],
  // y [0.00,5.80] r50 0.80 r80 2.31, x span [-4.75,2.33] - stem band
  canyonBanner: [[-1.2, 0.7, 0, -1.2, 4.8, 0, 0.8]],
  // y [-0.70,17.22], z to 8.34 - the arch CHORD; the span stays swim-through
  abyssRib: [[0, 0.2, -0.3, 0, 15.5, 7.0, 0.9]],
  // y [-0.25,6.31] r50 0.41 r80 0.56
  trenchWallSpine: [[0, 0, 0, 0, 5.6, 0, 0.5]],
  // y [0.00,5.41] r50 1.11 r80 1.37 - the cathedral cone
  ventCathedral: [[0, 0.3, 0, 0, 4.6, 0, 1.15]],
  // Stratum slabs: squat and WIDE (r50 2-6.6), where one vertical capsule
  // would either overshoot the top by its own radius or leave the rim open.
  // Two crossed HORIZONTAL capsules at mid-height cover the central mass;
  // the disc's four corners stay soft, which errs passable, per the header.
  // shelfStrata y [0,6.32] r50 4.35
  shelfStrata: [
    [-3.5, 2.4, 0, 3.5, 2.4, 0, 2.4],
    [0, 2.4, -3.5, 0, 2.4, 3.5, 2.4],
  ],
  // canyonLedge y [0,5.51] r50 2.83
  canyonLedge: [
    [-2.4, 2.0, 0, 2.4, 2.0, 0, 2.0],
    [0, 2.0, -2.4, 0, 2.0, 2.4, 2.0],
  ],
  // terraceStep y [0,5.92] r50 6.57
  terraceStep: [
    [-5.5, 2.4, 0, 5.5, 2.4, 0, 2.4],
    [0, 2.4, -5.5, 0, 2.4, 5.5, 2.4],
  ],
  // trenchLedge y [0,4.69] r50 1.90
  trenchLedge: [
    [-1.5, 1.9, 0, 1.5, 1.9, 0, 1.8],
    [0, 1.9, -1.5, 0, 1.9, 1.5, 1.8],
  ],
  // whaleFall x [-14.3,15.9] - the SPINE; the rib cage stays swim-through
  whaleFall: [[-12, 0.9, 0.6, 14, 0.9, 0.6, 1.1]],
  // ossuaryColossus: the same generator at 34 m and A DIFFERENT MESH SEED, so
  // the spine's baked azimuth differs from whaleFall's. Measured on the row's
  // own mesh (principal xz axis 0.333,-0.943, extent -21.6..15.5): the SPINE
  // only, ribs stay swim-through, exactly as whaleFall above.
  ossuaryColossus: [[-5.4, 1.4, 12.8, 5.1, 1.4, -17.0, 1.6]],
  // duneColossus: whale-fall generator at 40 m, its own mesh seed. Measured
  // (principal xz axis 0.899,-0.437 on the low band, extent -22.3..24.2):
  // the SPINE only at 86% of the extent, ribs stay swim-through.
  duneColossus: [[-20.2, 1.0, 11.4, 15.7, 1.0, -6.0, 1.8]],
  // duneRib: the 20 m breach rib - an arch, so the CHORD, per abyssRib.
  // Mesh aabb x [-4.7,1.4] y [-0.7,14.2] z [-1.0,10.1] at the row's fixed
  // seed; the span stays swim-through.
  duneRib: [[0, 0.4, 0, -3.1, 12.9, 8.0, 1.05]],
  // paleOssuary: an ENTERABLE shell, so this is a capsule WALL SET, not a
  // solid - left/right cranium walls, rear wall, crown and rostrum, with the
  // eye sockets, the jaw arch and the whole interior chamber (|x|<~3.9,
  // y<~12) left open. A capsule cannot be a curved wall, so the proxies bulge
  // ~1.5 m inside the visual bone; under-blocking is the header's chosen
  // error direction and the openings must never grow an invisible pane.
  // Mesh aabb x [-6.8,7.8] y [-4,14.2] z [-8.1,18.7] at the row's fixed seed.
  // TWO STACKED BANDS PER WALL plus a crossed crown, because one wall capsule
  // was measured climbable: pushing a swimmer capsule sideways into the single
  // y 5.5 band for 200 steps walked it up the rounded top (7.4 m) and over,
  // into the chamber through visual bone. With the second band the same push
  // stops outside the shell. The dome SHOULDER (~11-12 m, where the wall
  // bands end and the crown begins) remains softer than the visual surface -
  // that is the file's chosen under-blocking direction, not an oversight.
  paleOssuary: [
    [-5.8, 4.2, -4.5, -5.8, 4.2, 3.0, 1.9],
    [5.8, 4.2, -4.5, 5.8, 4.2, 3.0, 1.9],
    [-5.2, 8.3, -3.8, -5.2, 8.3, 2.4, 1.9],
    [5.2, 8.3, -3.8, 5.2, 8.3, 2.4, 1.9],
    [-3.5, 5.5, -6.6, 3.5, 5.5, -6.6, 2.0],
    [-2.5, 8.8, -5.9, 2.5, 8.8, -5.9, 1.9],
    [0, 13.4, -2.6, 0, 13.4, 2.6, 2.5],
    [-2.6, 13.4, 0, 2.6, 13.4, 0, 2.5],
    [0, 2.6, 6.0, 0, 2.2, 17.0, 2.2],
  ],
  // y [0.04,2.64] r50 0.77 r80 0.92 - glass dome lattice, treated as a shell
  wallLattice: [[0, 0.6, 0, 0, 2.1, 0, 0.85]],
  // y [-0.01,3.40] r50 1.32 r80 1.76 - bracket stack
  terraceShelf: [[0, 0.4, 0, 0, 2.6, 0, 1.3]],
  // meadowPillar y [0.00,17.94] - STEM ONLY, the mushroomCluster pattern: the
  // stem band (y 1.8-9.0) measures r50 0.81-0.93 / r80 0.96-1.13 with the base
  // skirt at r80 1.92 and the cap flare starting ~11 m (r 1.9-2.7, rim to 6.4).
  // The 6 m flat cap stays swim-through on purpose - it is the silhouette, not
  // a wall, and a swimmer bumping an invisible 12 m disc reads as a bug.
  meadowPillar: [[0, 0.8, 0, 0, 10.5, 0, 1.0]],
  // meadowStrata y [0,5.51] r50 3.12 - the crossed-horizontal slab pattern
  // (see the shelfStrata comment above); corners stay soft, per the header.
  meadowStrata: [
    [-2.6, 2.0, 0, 2.6, 2.0, 0, 2.0],
    [0, 2.0, -2.6, 0, 2.0, 2.6, 2.0],
  ],
  // bulbTree: TRUNK CLUSTER ONLY, the meadowPillar stem pattern - the trunks
  // spread ~0.5 r at the base and converge under the bulb (~5 m up at the
  // row's 9.5 m mesh), so one capsule at their pooled radius blocks the
  // cluster. The furred bulb stays swim-through on purpose: spikes are soft
  // tissue, and a swimmer bumping an invisible 6 m sphere reads as a bug.
  bulbTree: [[0, 0.4, 0, 0, 4.6, 0, 0.85]],
  // platterSpire / platterYoung: TRUNK ONLY, and the platters are
  // deliberately pass-through - a RECORDED limitation, not an oversight.
  // Platter heights and radii are per-seed random, so a static capsule list
  // cannot track them, and a capsule is a swept sphere with no disc
  // approximation that would not also block the open water between platters.
  // The trunks are what the vessel steers around; a hull clipping a platter
  // edge at speed is the accepted cost until platters get deterministic
  // heights or a real disc proxy. The radius covers the bark relief swell
  // (+14%) at the row's base radius; the trunk leans up to 0.07 H, which the
  // taper margin absorbs.
  platterSpire: [[0, 0.0, 0, 0, 43.0, 0, 2.4]],
  platterYoung: [[0, 0.0, 0, 0, 16.5, 0, 1.2]],
});

/**
 * PROXY_CAPSULES indexed by type id, with the dominant local axis of each
 * capsule precomputed (0 = X, 1 = Y, 2 = Z; the radius scales by the two
 * OTHER basis lengths). Built once at import; null for non-collidable rows.
 */
const PROXY_BY_TYPE = (() => {
  const table = new Array(SCATTER_TYPE_COUNT).fill(null);
  for (const type of SCATTER_TYPES) {
    const caps = PROXY_CAPSULES[type.key];
    if (!caps) continue;
    table[type.id] = caps.map((c) => {
      const dx = Math.abs(c[3] - c[0]);
      const dy = Math.abs(c[4] - c[1]);
      const dz = Math.abs(c[5] - c[2]);
      let axis = 1;                                  // spheres scale like pillars
      if (dx > dy && dx > dz) axis = 0;
      else if (dz > dy && dz > dx) axis = 2;
      return { c, axis };
    });
  }
  return table;
})();

/** Chunk map key; coordinates fit comfortably in +/-32k chunks. */
const key = (cx, cz) => (cx + 32768) * 65536 + (cz + 32768);

export class ScatterCollision {
  /** @param {import('./collision.js').CollisionWorld} collision */
  constructor(collision) {
    this.collision = collision;
    /** key -> {cx, cz, slots: Int32Array, count} for every registered chunk. */
    this._chunks = new Map();
    /** Chunk keys waiting to bake, nearest focus first. */
    this._queue = [];
    this._queued = new Set();
    // Last focus chunk coords; the wanted set is recomputed only when one of
    // them crosses a chunk boundary, so the steady state allocates nothing.
    this._fax = Infinity; this._faz = Infinity;
    this._fbx = Infinity; this._fbz = Infinity;
    this._enabled = false;

    /** Diagnostics for probes and the debug overlay. */
    this.stats = {
      chunksLive: 0, proxiesLive: 0, bakes: 0,
      lastBakeMs: 0, worstBakeMs: 0, totalBakeMs: 0,
      /** Mirrors the hash's counted (never thrown) insert overflow; a probe
       *  that only reads this object must be able to see saturation. */
      hashOverflow: 0,
    };
  }

  /**
   * Maintain the proxy set. Call once per FIXED sim step, before the player
   * and the vessel resolve, with the two bodies' absolute positions.
   *
   * @param {Float32Array} focusA the player position
   * @param {Float32Array} [focusB] the vessel position
   */
  update(focusA, focusB) {
    const enabled = WORLD.SCATTER_COLLISION !== 0;
    if (!enabled) {
      // The bisect: on the first disabled step every proxy is unregistered,
      // so behaviour reverts to the pre-proxy game exactly (the resolvers
      // additionally gate their narrow phases, so even the ring teardown is
      // never load-bearing for correctness).
      if (this._enabled) this._clearAll();
      this._enabled = false;
      return;
    }
    this._enabled = true;

    const ax = Math.floor(focusA[0] / CHUNK_SIZE);
    const az = Math.floor(focusA[2] / CHUNK_SIZE);
    const bx = focusB ? Math.floor(focusB[0] / CHUNK_SIZE) : ax;
    const bz = focusB ? Math.floor(focusB[2] / CHUNK_SIZE) : az;

    if (ax !== this._fax || az !== this._faz || bx !== this._fbx || bz !== this._fbz) {
      this._fax = ax; this._faz = az;
      this._fbx = bx; this._fbz = bz;
      this._retarget(ax, az, bx, bz);
    }

    if (this._queue.length > 0) this._bakeNext();
  }

  /** Recompute the wanted chunk set after a focus crossed a chunk boundary. */
  _retarget(ax, az, bx, bz) {
    const wanted = new Set();
    for (let dz = -RING; dz <= RING; dz++) {
      for (let dx = -RING; dx <= RING; dx++) {
        wanted.add(key(ax + dx, az + dz));
        wanted.add(key(bx + dx, bz + dz));
      }
    }
    // Unregister leavers immediately - removal is a few hundred slot frees.
    for (const [k, rec] of this._chunks) {
      if (!wanted.has(k)) this._unregister(k, rec);
    }
    // Queue joiners nearest-first, so the chunk a body is IN always bakes
    // before the ring around it.
    this._queue.length = 0;
    this._queued.clear();
    for (const k of wanted) {
      if (this._chunks.has(k)) continue;
      this._queue.push(k);
      this._queued.add(k);
    }
    const d2 = (k) => {
      const cx = Math.floor(k / 65536) - 32768, cz = (k % 65536) - 32768;
      const da = Math.max(Math.abs(cx - ax), Math.abs(cz - az));
      const db = Math.max(Math.abs(cx - bx), Math.abs(cz - bz));
      return Math.min(da, db);
    };
    this._queue.sort((p, q) => d2(p) - d2(q));
  }

  /** Bake and register the next queued chunk. One per step: 1.5-2.8 ms warm,
   *  worst measured 8.17 ms - see the header's both-arms cost paragraph. */
  _bakeNext() {
    const k = this._queue.shift();
    this._queued.delete(k);
    const cx = Math.floor(k / 65536) - 32768;
    const cz = (k % 65536) - 32768;

    const t0 = performance.now();
    const r = generateScatterForChunk(cx, cz, 0, { collidableOnly: true });
    const f = r.instances;
    const u8 = new Uint8Array(f.buffer);
    const statics = this.collision.statics;
    const originX = cx * CHUNK_SIZE;
    const originZ = cz * CHUNK_SIZE;

    const slots = [];
    for (let i = 0; i < r.count; i++) {
      const flags = u8[i * 64 + 63];
      if ((flags & SCATTER_FLAG.COLLIDABLE) === 0) continue;
      const caps = PROXY_BY_TYPE[u8[i * 64 + 61]];
      if (caps === null) continue;

      const b = i * 16;
      // Scaled basis columns and origin, straight from the instance record
      // (layout documented at SCATTER_STRIDE in scatter.js).
      const bxx = f[b], bxy = f[b + 4], bxz = f[b + 8];
      const byx = f[b + 1], byy = f[b + 5], byz = f[b + 9];
      const bzx = f[b + 2], bzy = f[b + 6], bzz = f[b + 10];
      const px = originX + f[b + 3], py = f[b + 7], pz = originZ + f[b + 11];
      const lx = Math.hypot(bxx, bxy, bxz);
      const ly = Math.hypot(byx, byy, byz);
      const lz = Math.hypot(bzx, bzy, bzz);

      for (let c = 0; c < caps.length; c++) {
        const { c: cap, axis } = caps[c];
        const ax0 = px + bxx * cap[0] + byx * cap[1] + bzx * cap[2];
        const ay0 = py + bxy * cap[0] + byy * cap[1] + bzy * cap[2];
        const az0 = pz + bxz * cap[0] + byz * cap[1] + bzz * cap[2];
        const ax1 = px + bxx * cap[3] + byx * cap[4] + bzx * cap[5];
        const ay1 = py + bxy * cap[3] + byy * cap[4] + bzy * cap[5];
        const az1 = pz + bxz * cap[3] + byz * cap[4] + bzz * cap[5];
        const rw = cap[6] * (axis === 0 ? (ly + lz) : axis === 2 ? (lx + ly) : (lx + lz)) * 0.5;
        const slot = statics.add(ax0, ay0, az0, ax1, ay1, az1, rw, u8[i * 64 + 61]);
        if (slot >= 0) slots.push(slot);
      }
    }

    this._chunks.set(k, { cx, cz, slots: Int32Array.from(slots), count: slots.length });
    const ms = performance.now() - t0;
    this.stats.bakes++;
    this.stats.lastBakeMs = ms;
    this.stats.totalBakeMs += ms;
    if (ms > this.stats.worstBakeMs) this.stats.worstBakeMs = ms;
    this.stats.chunksLive = this._chunks.size;
    this.stats.proxiesLive = statics.count;
    this.stats.hashOverflow = statics.overflow;
  }

  _unregister(k, rec) {
    const statics = this.collision.statics;
    for (let i = 0; i < rec.slots.length; i++) statics.remove(rec.slots[i]);
    this._chunks.delete(k);
    this.stats.chunksLive = this._chunks.size;
    this.stats.proxiesLive = statics.count;
  }

  _clearAll() {
    for (const [k, rec] of this._chunks) this._unregister(k, rec);
    this._queue.length = 0;
    this._queued.clear();
    this._fax = this._faz = this._fbx = this._fbz = Infinity;
  }
}
