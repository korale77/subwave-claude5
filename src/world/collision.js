/**
 * SUBWAVE collision.
 *
 * The world is a heightfield plus (later) marching-cubes cave volumes. There is
 * no triangle soup to build a BVH over: chunks are regenerated as the camera
 * moves and a rebuild would cost more than every query it accelerates. So every
 * query here is an ANALYTIC query against the terrain field, and the only
 * acceleration structure is the entity hash at the bottom of the file.
 *
 * The terrain module is injected rather than imported so this file has no
 * opinion about how the field is generated. The contract is:
 *
 *   heightAt(x, z) | sampleHeight(x, z) -> number   REQUIRED, metres, y up
 *   normalAt(out, x, z) | sampleNormal(out, x, z)   optional; central differences otherwise
 *   materialAt(x, z) | sampleMaterial(x, z)         optional; slope heuristic otherwise
 *
 * Coordinates are ABSOLUTE world space throughout. Sea level is y = 0.
 */

import { vec3, mat3, clamp, smoothstep, EPSILON, TAU, hash2i } from '../core/math.js';
import { WORLD, OCEAN, PLAYER, VESSEL } from '../core/constants.js';
// The hull probe set below IS the Kestrel's skids, so it takes their dimensions
// from the mesh rather than restating them. vessel_mesh.js is pure arithmetic
// with no GPU in it, so a headless physics test can still import this file.
import { VESSEL_SKID_KEEL, VESSEL_SKID_RADIUS } from '../entities/vessel_mesh.js';

// ---------------------------------------------------------------------------
// Surface materials
// ---------------------------------------------------------------------------

/** Material ids, matching the footstep synthesis table in DESIGN/05.2.7. */
export const MATERIAL = {
  DRY_SAND: 0,
  WET_SAND: 1,
  SHELL_GRAVEL: 2,
  BASALT_DRY: 3,
  BASALT_WET: 4,
  CORAL_RUBBLE: 5,
  SPORETURF: 6,
  SILT: 7,
  METAL: 8,
  SHALLOW_WATER: 9,
  ICE: 10,
  VENT_CRUST: 11,
};

export const MATERIAL_NAMES = [
  'drySand', 'wetSand', 'shellGravel', 'basaltDry', 'basaltWet', 'coralRubble',
  'sporeturf', 'silt', 'metal', 'shallowWater', 'ice', 'ventCrust',
];

/** Traction multiplier applied to ground acceleration, from the same table. */
export const MATERIAL_GRIP = Float32Array.of(
  0.62, 0.78, 0.70, 0.92, 0.74, 0.66, 0.84, 0.55, 1.00, 0.72, 0.42, 0.80);

/** 0 = hard, 1 = deeply yielding. Scales fall damage and footstep timbre. */
export const MATERIAL_SOFTNESS = Float32Array.of(
  0.85, 0.70, 0.45, 0.05, 0.05, 0.30, 0.75, 0.95, 0.00, 0.60, 0.20, 0.25);

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Assumed Lipschitz bound on the terrain height field: |grad h| <= this.
 * The ray marcher below is a sphere trace on f(t) = y(t) - h(x(t), z(t)), and
 * f is Lipschitz in t with constant |dir.y| + L*|dir.xz|. 4.0 is tan(76 deg),
 * which is steeper than any walkable or climbable surface the generator makes;
 * genuine vertical cliff faces are handled by the step floor instead.
 */
const TERRAIN_LIPSCHITZ = 4.0;

/** Ray marcher bounds. See raycast() for the worst-case analysis. */
const RAY_MAX_STEPS = 512;
const RAY_MIN_STEP = 0.05;
const RAY_MAX_STEP = 24.0;
const RAY_BISECT_ITERATIONS = 24;
const RAY_SURFACE_EPSILON = 1e-3;

/** Central-difference half-width for reconstructed normals, metres. */
const NORMAL_EPSILON = 0.35;

/** Capsule solver: never advance more than this fraction of a radius per substep. */
const CAPSULE_SUBSTEP_FRACTION = 0.5;
const CAPSULE_MAX_SUBSTEPS = 16;

/** Vessel contact solver. */
const HULL_ITERATIONS = 4;
const HULL_RESTITUTION = 0.06;
const HULL_FRICTION = 0.62;
/** Baumgarte factor: fraction of penetration corrected per second of solver time. */
const HULL_BAUMGARTE = 0.25;
const HULL_PENETRATION_SLOP = 0.01;

// ---------------------------------------------------------------------------
// Result records. Allocated once by the caller, reused forever.
// ---------------------------------------------------------------------------

/** @returns {object} reusable record for groundInfo(). */
export function createGroundInfo() {
  return {
    height: 0,
    normal: vec3.create(0, 1, 0),
    /** cos of the slope angle, i.e. normal.y. 1 = flat. */
    slopeCos: 1,
    slopeAngle: 0,
    material: MATERIAL.BASALT_DRY,
    grip: 1,
    softness: 0,
    walkable: true,
    submerged: false,
  };
}

/** @returns {object} reusable record for raycast(). */
export function createRayHit() {
  return {
    hit: false,
    t: 0,
    point: vec3.create(),
    normal: vec3.create(0, 1, 0),
    steps: 0,
    /** True when the marcher ran out of iterations without deciding. */
    exhausted: false,
  };
}

/** @returns {object} reusable record for resolveCapsule(). */
export function createCapsuleContact() {
  return {
    grounded: false,
    groundY: 0,
    normal: vec3.create(0, 1, 0),
    slopeCos: 1,
    walkable: true,
    material: MATERIAL.BASALT_DRY,
    steppedUp: 0,
    wallHit: false,
    wallNormal: vec3.create(),
    /** Downward speed at the moment of touchdown, m/s. Zero unless landing this call. */
    landingSpeed: 0,
  };
}

/** @returns {object} reusable record for waterSurfaceAt(). */
export function createWaterSample() {
  return {
    y: 0,
    normal: vec3.create(0, 1, 0),
    /** Horizontal Gerstner displacement at the queried point. */
    dx: 0,
    dz: 0,
  };
}

/** @returns {object} reusable record for resolveVesselHull(). */
export function createHullContact() {
  return {
    contacts: 0,
    maxPenetration: 0,
    /** Closing speed along the contact normal before the impulse, m/s. */
    impactSpeed: 0,
    normal: vec3.create(0, 1, 0),
    material: MATERIAL.BASALT_DRY,
  };
}

// ---------------------------------------------------------------------------
// CPU ocean surface
// ---------------------------------------------------------------------------

/**
 * The 16-wave Gerstner set from DESIGN/03.1.10, tabulated at U10 = 10 m/s,
 * Hs = 2.46 m. Wavelengths scale with (U10/10)^2 (deep-water dispersion ties
 * wavelength to the square of the generating wind), amplitudes with Hs.
 *
 * Columns: wavelength (m), amplitude (m), direction offset from wind (deg),
 * steepness.
 */
const GERSTNER_TABLE = [
  [148.0, 0.420, -11, 0.55], [112.0, 0.510, +19, 0.60],
  [87.6, 0.620, -4, 0.65], [71.0, 0.550, +27, 0.65],
  [58.0, 0.440, -22, 0.70], [46.0, 0.360, +8, 0.70],
  [35.5, 0.280, -33, 0.75], [27.0, 0.210, +14, 0.75],
  [19.5, 0.155, -18, 0.80], [14.2, 0.112, +31, 0.80],
  [10.1, 0.079, -7, 0.85], [7.2, 0.055, +23, 0.85],
  [5.0, 0.037, -29, 0.90], [3.4, 0.024, +12, 0.90],
  [2.2, 0.015, -15, 0.95], [1.4, 0.009, +36, 0.95],
];

const GERSTNER_COUNT = GERSTNER_TABLE.length;
const GERSTNER_REF_HS = 2.46;
const GERSTNER_REF_WIND = 10.0;
/** Fixed-point iterations used to invert the horizontal displacement. */
const GERSTNER_INVERT_ITERATIONS = 3;

/**
 * The CPU-side Gerstner sum. Buoyancy, footstep splashes and the audio
 * waterline all read this, and it must agree with what the GPU draws or the
 * vessel will float visibly above or below its own reflection.
 *
 * Stored as a struct-of-arrays so the inner loop is a flat typed-array walk
 * with no property lookups.
 */
class GerstnerField {
  constructor(seed) {
    const n = GERSTNER_COUNT;
    this.dirX = new Float32Array(n);
    this.dirZ = new Float32Array(n);
    this.k = new Float32Array(n);        // wavenumber, rad/m
    this.omega = new Float32Array(n);    // angular frequency, rad/s
    this.amp = new Float32Array(n);      // metres
    this.qa = new Float32Array(n);       // Q*A, the horizontal displacement gain
    this.phase = new Float32Array(n);
    this.seed = seed >>> 0;
    this.windDir = 0;
    this.seaState = 2;
    this._rebuild();
  }

  /** @param {number} state Douglas sea state 0..9. @param {number} windDir radians. */
  configure(state, windDir) {
    const s = clamp(Math.round(state), 0, OCEAN.SEA_STATES.length - 1);
    if (s === this.seaState && windDir === this.windDir) return;
    this.seaState = s;
    this.windDir = windDir;
    this._rebuild();
  }

  _rebuild() {
    const entry = OCEAN.SEA_STATES[this.seaState];
    const hsScale = entry.hs / GERSTNER_REF_HS;
    const lambdaScale = Math.max(0.04, (entry.wind / GERSTNER_REF_WIND) ** 2);
    const g = OCEAN.GRAVITY;

    for (let i = 0; i < GERSTNER_COUNT; i++) {
      const [lambda0, amp0, dirDeg, steepness] = GERSTNER_TABLE[i];
      const lambda = Math.max(OCEAN.MIN_WAVELENGTH, lambda0 * lambdaScale);
      const k = TAU / lambda;
      const angle = this.windDir + dirDeg * (Math.PI / 180);
      const amp = amp0 * hsScale;

      this.dirX[i] = Math.sin(angle);
      this.dirZ[i] = -Math.cos(angle);
      this.k[i] = k;
      this.omega[i] = Math.sqrt(g * k);
      this.amp[i] = amp;
      // Q = steepness / (k * A * N) is the largest Q that cannot self-intersect
      // the surface; folding A in here removes a multiply from the inner loop.
      this.qa[i] = amp > EPSILON
        ? (steepness / (k * amp * GERSTNER_COUNT)) * amp
        : 0;
      // Deterministic phase: the same seed must give the same sea forever.
      this.phase[i] = (hash2i(this.seed ^ 0x9e3779b9, i) / 4294967296) * TAU;
    }
  }

  /**
   * Height and normal AT the world column (x, z).
   *
   * Gerstner waves are parametric: the sum gives the surface point produced BY
   * a lattice point, not the height above one. Newton on the horizontal
   * displacement converges in three iterations for any steepness the table can
   * produce (Q is capped below self-intersection), which is exactly what
   * DESIGN/03.1.9 budgets for.
   */
  sample(out, x, z, t) {
    let px = x, pz = z;
    for (let iter = 0; iter < GERSTNER_INVERT_ITERATIONS; iter++) {
      let dx = 0, dz = 0;
      for (let i = 0; i < GERSTNER_COUNT; i++) {
        const ph = this.k[i] * (this.dirX[i] * px + this.dirZ[i] * pz) - this.omega[i] * t + this.phase[i];
        const c = Math.cos(ph) * this.qa[i];
        dx += this.dirX[i] * c;
        dz += this.dirZ[i] * c;
      }
      px = x - dx;
      pz = z - dz;
    }

    let y = 0, nx = 0, nz = 0, ny = 0, dispX = 0, dispZ = 0;
    for (let i = 0; i < GERSTNER_COUNT; i++) {
      const dxi = this.dirX[i], dzi = this.dirZ[i];
      const ph = this.k[i] * (dxi * px + dzi * pz) - this.omega[i] * t + this.phase[i];
      const s = Math.sin(ph), c = Math.cos(ph);
      const a = this.amp[i];
      const wa = this.k[i] * a;
      y += a * s;
      dispX += dxi * c * this.qa[i];
      dispZ += dzi * c * this.qa[i];
      nx += dxi * wa * c;
      nz += dzi * wa * c;
      ny += (this.qa[i] * this.k[i]) * s;
    }

    out.y = y;
    out.dx = dispX;
    out.dz = dispZ;
    const n = out.normal;
    n[0] = -nx;
    n[1] = 1 - ny;
    n[2] = -nz;
    vec3.normalize(n, n);
    return out;
  }

  /** Height only. Half the work of sample() and by far the most common query. */
  heightAt(x, z, t) {
    let px = x, pz = z;
    for (let iter = 0; iter < GERSTNER_INVERT_ITERATIONS; iter++) {
      let dx = 0, dz = 0;
      for (let i = 0; i < GERSTNER_COUNT; i++) {
        const ph = this.k[i] * (this.dirX[i] * px + this.dirZ[i] * pz) - this.omega[i] * t + this.phase[i];
        const c = Math.cos(ph) * this.qa[i];
        dx += this.dirX[i] * c;
        dz += this.dirZ[i] * c;
      }
      px = x - dx;
      pz = z - dz;
    }
    let y = 0;
    for (let i = 0; i < GERSTNER_COUNT; i++) {
      const ph = this.k[i] * (this.dirX[i] * px + this.dirZ[i] * pz) - this.omega[i] * t + this.phase[i];
      y += this.amp[i] * Math.sin(ph);
    }
    return y;
  }
}

// ---------------------------------------------------------------------------
// Spatial hash
// ---------------------------------------------------------------------------

/**
 * Uniform-grid spatial hash for entities (creatures, props, beacons, the
 * vessel). Open-addressed by a 3D integer hash into a fixed bucket table with
 * intrusive singly-linked chains, so insert/remove/query never allocate.
 *
 * CELL SIZE. The rule for a uniform grid is: make the cell about the size of
 * the median query radius. Too small and a query walks hundreds of empty
 * cells; too large and every bucket degenerates into a linear scan.
 * SUBWAVE's queries are creature perception (PLAYER.SCAN_RANGE = 22 m),
 * boarding (VESSEL.BOARD_RANGE = 4.5 m) and creature-vs-creature separation
 * (typically 8-20 m). 16 m sits in the middle of that band: a 22 m query
 * touches 4x3x4 = 48 cells, a 4.5 m query touches 8, and with RENDER's cap of
 * 260 creatures spread over a 6 km world the mean occupancy is far below one
 * per cell.
 */
export class SpatialHash {
  /**
   * @param {number} capacity maximum simultaneous entities
   * @param {number} cellSize metres
   * @param {number} buckets  bucket count, rounded up to a power of two
   */
  constructor(capacity = 1024, cellSize = 16, buckets = 4096) {
    this.capacity = capacity;
    this.cellSize = cellSize;
    this.invCell = 1 / cellSize;

    let b = 1;
    while (b < buckets) b <<= 1;
    this.bucketMask = b - 1;

    this.head = new Int32Array(b).fill(-1);
    this.next = new Int32Array(capacity).fill(-1);
    this.bucketOf = new Int32Array(capacity).fill(-1);
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.z = new Float32Array(capacity);
    this.present = new Uint8Array(capacity);
    this.count = 0;
  }

  _bucket(cx, cy, cz) {
    return hash2i(hash2i(cx, cy), cz) & this.bucketMask;
  }

  _bucketFor(x, y, z) {
    return this._bucket(
      Math.floor(x * this.invCell),
      Math.floor(y * this.invCell),
      Math.floor(z * this.invCell),
    );
  }

  /** Insert or move entity `id`. Ids are caller-assigned dense indices. */
  insert(id, x, y, z) {
    if (id < 0 || id >= this.capacity) return false;
    const b = this._bucketFor(x, y, z);
    if (this.present[id]) {
      if (this.bucketOf[id] === b) {
        this.x[id] = x; this.y[id] = y; this.z[id] = z;
        return true;
      }
      this._unlink(id);
    } else {
      this.count++;
      this.present[id] = 1;
    }
    this.x[id] = x; this.y[id] = y; this.z[id] = z;
    this.bucketOf[id] = b;
    this.next[id] = this.head[b];
    this.head[b] = id;
    return true;
  }

  /** Alias for insert(); reads better at call sites that only ever move things. */
  move(id, x, y, z) { return this.insert(id, x, y, z); }

  remove(id) {
    if (id < 0 || id >= this.capacity || !this.present[id]) return false;
    this._unlink(id);
    this.present[id] = 0;
    this.bucketOf[id] = -1;
    this.count--;
    return true;
  }

  _unlink(id) {
    const b = this.bucketOf[id];
    if (b < 0) return;
    let cur = this.head[b];
    if (cur === id) { this.head[b] = this.next[id]; this.next[id] = -1; return; }
    while (cur >= 0) {
      const n = this.next[cur];
      if (n === id) { this.next[cur] = this.next[id]; this.next[id] = -1; return; }
      cur = n;
    }
  }

  clear() {
    this.head.fill(-1);
    this.next.fill(-1);
    this.bucketOf.fill(-1);
    this.present.fill(0);
    this.count = 0;
  }

  /**
   * Ids within `radius` of (x, y, z), written into `out`.
   * Allocation-free: `out` is a caller-owned array (plain or Int32Array) and
   * the return value is how many entries were written.
   *
   * Buckets are shared by many cells, so an entry can appear via a bucket it
   * does not geometrically belong to; the distance test below is what makes
   * the result exact, and it also deduplicates because each entity lives in
   * exactly one bucket.
   */
  queryRadius(x, y, z, radius, out, maxResults = out.length) {
    const r2 = radius * radius;
    const inv = this.invCell;
    const x0 = Math.floor((x - radius) * inv), x1 = Math.floor((x + radius) * inv);
    const y0 = Math.floor((y - radius) * inv), y1 = Math.floor((y + radius) * inv);
    const z0 = Math.floor((z - radius) * inv), z1 = Math.floor((z + radius) * inv);

    let n = 0;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          let id = this.head[this._bucket(cx, cy, cz)];
          while (id >= 0) {
            const dx = this.x[id] - x, dy = this.y[id] - y, dz = this.z[id] - z;
            if (dx * dx + dy * dy + dz * dz <= r2) {
              // A bucket collision can list an entity whose true cell is
              // elsewhere; only accept it from the cell it actually occupies
              // so it is reported exactly once.
              if (Math.floor(this.x[id] * inv) === cx &&
                  Math.floor(this.y[id] * inv) === cy &&
                  Math.floor(this.z[id] * inv) === cz) {
                if (n >= maxResults) return n;
                out[n++] = id;
              }
            }
            id = this.next[id];
          }
        }
      }
    }
    return n;
  }

  /** Nearest entity to a point within `radius`, or -1. */
  nearest(x, y, z, radius, scratch) {
    const n = this.queryRadius(x, y, z, radius, scratch);
    let best = -1, bestD2 = Infinity;
    for (let i = 0; i < n; i++) {
      const id = scratch[i];
      const dx = this.x[id] - x, dy = this.y[id] - y, dz = this.z[id] - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = id; }
    }
    return best;
  }
}

// ---------------------------------------------------------------------------
// Static shape hash (scatter collision proxies)
// ---------------------------------------------------------------------------

/**
 * Spatial hash for STATIC ANALYTIC CAPSULES - the collision proxies of
 * collidable scatter (vent chimneys, boulders, coral heads, slabs).
 *
 * WHY A SECOND HASH AND NOT `CollisionWorld.entities`. The entity hash is sized
 * 2,048 with a 16 m cell for a few hundred MOVING point entities; the statics
 * near two 3x3-chunk rings measure up to ~950 collidable instances PER CHUNK in
 * reef water (18 chunks x 957 = 17,226 worst case), and several proxies are
 * larger than a 16 m cell (a whaleFall spans ~30 m at scale 1). Registering
 * them there would evict the creatures and still miss the big shapes -
 * "solid, except when it isn't". This hash holds 24,576 shapes.
 *
 * SHAPES ARE CAPSULES, DELIBERATELY. One primitive covers every proxy class:
 * a sphere is a zero-length capsule, a pillar is a vertical one, a whale-fall
 * spine is a horizontal one. The endpoints are WORLD-space (absolute), baked by
 * scatter_collision.js from the instance's own scaled basis, so tilt, stretch
 * and slope alignment are already in them.
 *
 * THE GRID IS 2D (XZ), 64 m CELLS. Statics stand on the seabed, so slicing Y
 * buys nothing but empty cells on a 1,100 m depth range. 64 m exceeds the
 * largest proxy's bounding DIAMETER (whaleFall: ~24 m bound radius at max
 * scale), and correctness never depends on the cell anyway: a query inflates
 * its rectangle by `maxBound`, the largest bounding radius ever inserted, and
 * prechecks each candidate against its OWN `boundR` - so a shape is found from
 * exactly as far away as it can reach, however coarse the grid.
 */
export class StaticShapeHash {
  /**
   * @param {number} capacity maximum simultaneous shapes
   * @param {number} cellSize metres (XZ)
   * @param {number} buckets  bucket count, rounded up to a power of two
   */
  constructor(capacity = 24576, cellSize = 64, buckets = 2048) {
    this.capacity = capacity;
    this.cellSize = cellSize;
    this.invCell = 1 / cellSize;

    let b = 1;
    while (b < buckets) b <<= 1;
    this.bucketMask = b - 1;

    this.head = new Int32Array(b).fill(-1);
    this.next = new Int32Array(capacity).fill(-1);
    this.bucketOf = new Int32Array(capacity).fill(-1);
    // Capsule endpoints, world space.
    this.ax = new Float32Array(capacity);
    this.ay = new Float32Array(capacity);
    this.az = new Float32Array(capacity);
    this.bx = new Float32Array(capacity);
    this.by = new Float32Array(capacity);
    this.bz = new Float32Array(capacity);
    this.r = new Float32Array(capacity);
    // Midpoint + bounding radius, for the broad-phase precheck.
    this.mx = new Float32Array(capacity);
    this.my = new Float32Array(capacity);
    this.mz = new Float32Array(capacity);
    this.boundR = new Float32Array(capacity);
    this.typeId = new Uint8Array(capacity);
    this.present = new Uint8Array(capacity);

    // Free-slot stack: initially every slot, highest on top so allocation
    // walks 0, 1, 2... which keeps the SoA prefix dense and cache-friendly.
    this._free = new Int32Array(capacity);
    for (let i = 0; i < capacity; i++) this._free[i] = capacity - 1 - i;
    this._freeTop = capacity;

    this.count = 0;
    /** Shapes refused because the table was full. Must stay 0 in play. */
    this.overflow = 0;
    /** Largest bounding radius ever inserted; the query inflation term. */
    this.maxBound = 0;
  }

  _bucket(cx, cz) {
    return hash2i(cx, cz) & this.bucketMask;
  }

  /**
   * Insert a capsule; returns the slot id, or -1 when full (counted in
   * `overflow` rather than thrown - a missing proxy is degraded, not fatal).
   */
  add(ax, ay, az, bx, by, bz, r, typeId) {
    if (this._freeTop === 0) { this.overflow++; return -1; }
    const id = this._free[--this._freeTop];
    this.ax[id] = ax; this.ay[id] = ay; this.az[id] = az;
    this.bx[id] = bx; this.by[id] = by; this.bz[id] = bz;
    this.r[id] = r;
    const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5, mz = (az + bz) * 0.5;
    this.mx[id] = mx; this.my[id] = my; this.mz[id] = mz;
    const hx = ax - mx, hy = ay - my, hz = az - mz;
    const bound = Math.sqrt(hx * hx + hy * hy + hz * hz) + r;
    this.boundR[id] = bound;
    if (bound > this.maxBound) this.maxBound = bound;
    this.typeId[id] = typeId & 0xff;
    this.present[id] = 1;

    const b = this._bucket(Math.floor(mx * this.invCell), Math.floor(mz * this.invCell));
    this.bucketOf[id] = b;
    this.next[id] = this.head[b];
    this.head[b] = id;
    this.count++;
    return id;
  }

  /** Remove a slot returned by add(). */
  remove(id) {
    if (id < 0 || id >= this.capacity || !this.present[id]) return false;
    const b = this.bucketOf[id];
    let cur = this.head[b];
    if (cur === id) {
      this.head[b] = this.next[id];
    } else {
      while (cur >= 0) {
        const n = this.next[cur];
        if (n === id) { this.next[cur] = this.next[id]; break; }
        cur = n;
      }
    }
    this.next[id] = -1;
    this.bucketOf[id] = -1;
    this.present[id] = 0;
    this._free[this._freeTop++] = id;
    this.count--;
    // maxBound is deliberately NOT recomputed: it only ever inflates the query
    // rectangle, so a stale (larger) value costs a few empty prechecks and can
    // never miss a shape.
    return true;
  }

  clear() {
    this.head.fill(-1);
    this.next.fill(-1);
    this.bucketOf.fill(-1);
    this.present.fill(0);
    for (let i = 0; i < this.capacity; i++) this._free[i] = this.capacity - 1 - i;
    this._freeTop = this.capacity;
    this.count = 0;
    this.maxBound = 0;
  }

  /**
   * Slots whose capsule MAY come within `radius` of (x, y, z), written into
   * `out` (caller-owned Int32Array). The precheck is midpoint distance against
   * `radius + boundR`, so every true overlap is returned and the caller does
   * the exact narrow-phase test. Returns the number written.
   */
  query(x, y, z, radius, out, maxResults = out.length) {
    if (this.count === 0) return 0;
    const inv = this.invCell;
    const reach = radius + this.maxBound;
    const x0 = Math.floor((x - reach) * inv), x1 = Math.floor((x + reach) * inv);
    const z0 = Math.floor((z - reach) * inv), z1 = Math.floor((z + reach) * inv);

    let n = 0;
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const bucket = this._bucket(cx, cz);
        let id = this.head[bucket];
        while (id >= 0) {
          // A bucket is shared by many cells; accept a shape only from the
          // cell its midpoint occupies so it is reported exactly once.
          if (Math.floor(this.mx[id] * inv) === cx &&
              Math.floor(this.mz[id] * inv) === cz) {
            const dx = this.mx[id] - x, dy = this.my[id] - y, dz = this.mz[id] - z;
            const rr = radius + this.boundR[id];
            if (dx * dx + dy * dy + dz * dz <= rr * rr) {
              if (n >= maxResults) return n;
              out[n++] = id;
            }
          }
          id = this.next[id];
        }
      }
    }
    return n;
  }
}

/**
 * Closest points between segments P1Q1 and P2Q2 (Ericson, Real-Time Collision
 * Detection 5.1.9), written into `outP` (on P1Q1) and `outQ` (on P2Q2).
 * Scalar arguments so the hot path carries no allocation and no views.
 */
function closestSegSeg(outP, outQ,
  p1x, p1y, p1z, q1x, q1y, q1z,
  p2x, p2y, p2z, q2x, q2y, q2z) {
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
  const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s, t;
  if (a <= EPSILON && e <= EPSILON) {
    s = 0; t = 0;
  } else if (a <= EPSILON) {
    s = 0; t = clamp(f / e, 0, 1);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPSILON) {
      t = 0; s = clamp(-c / a, 0, 1);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > EPSILON ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  outP[0] = p1x + d1x * s; outP[1] = p1y + d1y * s; outP[2] = p1z + d1z * s;
  outQ[0] = p2x + d2x * t; outQ[1] = p2y + d2y * t; outQ[2] = p2z + d2z * t;
}

/**
 * Closest point on segment AB to point P, written into `out`.
 * @returns {number} the segment parameter t in [0, 1]
 */
function closestOnSegment(out, px, py, pz, ax, ay, az, bx, by, bz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = 0;
  if (len2 > EPSILON) {
    t = ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / len2;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
  }
  out[0] = ax + abx * t;
  out[1] = ay + aby * t;
  out[2] = az + abz * t;
  return t;
}

// ---------------------------------------------------------------------------
// CollisionWorld
// ---------------------------------------------------------------------------

const _n = vec3.create();
const _n2 = vec3.create();
const _p = vec3.create();
const _r = vec3.create();
const _v = vec3.create();
const _t = vec3.create();
const _t2 = vec3.create();
const _cp = vec3.create();
const _invI = mat3.create();
const _rot = mat3.create();

export class CollisionWorld {
  /**
   * @param {object} terrain module or object exposing heightAt(x, z)
   * @param {object} [opts] {seed, entityCapacity}
   */
  constructor(terrain, { seed = WORLD.DEFAULT_SEED, entityCapacity = 2048 } = {}) {
    // The terrain module names its samplers sampleHeight/sampleNormal; accept
    // the shorter aliases too so a test harness can hand in a two-line stub.
    const height = terrain && (terrain.heightAt || terrain.sampleHeight);
    if (typeof height !== 'function') {
      throw new Error('[CollisionWorld] terrain must expose heightAt(x, z) or sampleHeight(x, z)');
    }
    this.terrain = terrain;
    this._height = height.bind(terrain);
    this._normal = terrain.normalAt || terrain.sampleNormal || null;
    if (this._normal) this._normal = this._normal.bind(terrain);
    this._material = terrain.materialAt || terrain.sampleMaterial || null;
    if (this._material) this._material = this._material.bind(terrain);
    this._hasNormal = this._normal !== null;
    this._hasMaterial = this._material !== null;

    /** The authoritative CPU wave field. Replaced by setOcean() when available. */
    this.waves = new GerstnerField(seed);
    this.ocean = null;

    this.entities = new SpatialHash(entityCapacity, 16, 4096);

    /**
     * Collision proxies for collidable static scatter, fed by
     * src/world/scatter_collision.js as chunks stream in and out around the
     * player and the vessel. Sized and celled per the StaticShapeHash header.
     * Gated live by WORLD.SCATTER_COLLISION: at 0 both resolvers skip the
     * narrow phase entirely and reproduce the pre-proxy behaviour exactly.
     */
    this.statics = new StaticShapeHash();
    /** Broad-phase results, reused across steps. 256 exceeds the densest
     *  measured neighbourhood (reef, ~5 true candidates within player reach;
     *  the vessel's 6 m gather sees tens). Overflow degrades to the nearest
     *  256, it does not throw. */
    this._staticHits = new Int32Array(256);
    this._segA = vec3.create();
    this._segB = vec3.create();

    this._water = createWaterSample();
    this._ground = createGroundInfo();
    this._ray = createRayHit();

    /** Diagnostics, sampled by the debug overlay. */
    this.stats = { heightQueries: 0, rayQueries: 0, raySteps: 0, caveContacts: 0 };

    /** The volumetric cave field, when the game wires one in. See setCaveField. */
    this.caves = null;
    this._caveNormal = vec3.create();
  }

  /**
   * Attach the volumetric cave field (the world/caves.js module or anything
   * exposing `caveDensity`, `caveNormal`, `caveVoidAt` and `isInsideCave`).
   *
   * With it attached, resolveCapsule() gains three behaviours and nothing else
   * in this file changes:
   *
   *   1. A capsule INSIDE a carved void resolves against the field by sphere
   *      depenetration instead of against the heightfield - a heightfield
   *      query inside a cave answers for the rock overhead and would snap the
   *      body up through the roof.
   *   2. The vertical ground snap declines to fire where the ground it would
   *      snap to has been carved open (the mouth shaft), which is what lets a
   *      diver swim down INTO a mouth.
   *   3. The horizontal too-tall-to-step wall test declines likewise, which is
   *      what lets a diver swim sideways into a mouth on a steep face.
   *
   * ADMISSION is gated on `caveVoidAt` (the carved void only) and never on raw
   * `caveDensity > 0`: the overhang displacement also opens field pockets
   * below the heightfield, but nothing renders them today, and a body must
   * never be allowed somewhere the frame shows as solid ground. Depenetration
   * inside an admitted void then runs on `caveDensity`, because that is the
   * exact field the cave MESH is marched from - the wall you slide along is
   * the wall on screen. The field magnitude is a LOWER bound on true distance
   * (caves.js documents why), so a single push can over-push slightly along
   * the normal - into open water, the safe direction - and the fixed-point is
   * reached over the resolver's own iterations.
   *
   * resolveVesselHull() gains the SAME three behaviours (2026-08-18). It
   * originally kept the plain heightfield because every shipped mouth was
   * diver-scale (2-6 m against a 7.4 m hull); the Jellyshroom Hollow's
   * authored 21 m mouth and 26-30 m corridor exist FOR the vessel - the
   * chamber sits at ~250 m where a tank swim is impossible and the cabin
   * recycler is the air supply - so the hull now admits per probe on the
   * same caveVoidAt gate and depenetrates against caveDensity along
   * caveNormal. The open-world hot path is protected by ONE field query per
   * resolve call: |caveVoidAt(pos)| is a LOWER bound on the distance to any
   * carved void, so a body reading below -24 m (hull reach 3.55 m + a Vne
   * step + margin) skips every per-probe cave test.
   */
  setCaveField(caves) {
    this.caves = caves && typeof caves.caveDensity === 'function' ? caves : null;
    return this;
  }

  /** Is this point inside a carved, RENDERED cave void (see setCaveField)?
   *  Called from the grounded hot path, so it early-outs on the start-zone
   *  exclusion (no cave geometry exists within CAVE_SAFE_RADIUS of the axis)
   *  before paying for a field query. */
  _caveOpen(x, y, z) {
    if (this.caves === null) return false;
    const safe = this.caves.CAVE_SAFE_RADIUS || 0;
    if (x * x + z * z < safe * safe) return false;
    return y < this._height(x, z) && this.caves.caveVoidAt(x, y, z) > 0;
  }

  /** Has the GROUND at this column been carved away just below `groundY`?
   *
   *  The ground-snap gate, and deliberately NOT _caveOpen: that predicate
   *  tests the body's own point against `heightAt(x, z)`, and at a mouth rim
   *  on a slope the snap target (`footprintHeight`, the MAX of five samples)
   *  sits ABOVE the column's own height, so the body is pinned at a level
   *  where `y < heightAt` is still false and the gate can never open -
   *  measured: a capsule descending the shipped canyon mouth parked at
   *  -541.67 m over a hole whose void read +2.68 m. What the snap actually
   *  needs to know is whether the surface it would snap TO exists, which is a
   *  question about the point just below that surface. */
  _groundCarved(x, groundY, z) {
    if (this.caves === null) return false;
    const safe = this.caves.CAVE_SAFE_RADIUS || 0;
    if (x * x + z * z < safe * safe) return false;
    return this.caves.caveVoidAt(x, groundY - 0.3, z) > 0;
  }

  /**
   * Attach the GPU ocean simulation. If it publishes a CPU wave query we defer
   * to it, so buoyancy and rendering are guaranteed to agree; otherwise the
   * built-in Gerstner field stands in and stays statistically identical.
   */
  setOcean(ocean) {
    this.ocean = ocean && typeof ocean.oceanHeightAt === 'function' ? ocean : null;
    if (ocean && ocean.seaState != null) {
      this.waves.configure(ocean.seaState, ocean.windDirection || 0);
    }
    return this;
  }

  /** Sea state and wind direction for the fallback wave field. */
  setSeaState(state, windDir = 0) {
    this.waves.configure(state, windDir);
    return this;
  }

  // -------------------------------------------------------------------------
  // Terrain queries
  // -------------------------------------------------------------------------

  heightAt(x, z) {
    this.stats.heightQueries++;
    return this._height(x, z);
  }

  /**
   * Surface normal. Uses the terrain's analytic gradient when it has one,
   * otherwise central differences at NORMAL_EPSILON - wide enough that a
   * single-metre noise octave does not dominate the result, narrow enough that
   * a 0.4 m step still reads as a step.
   */
  normalAt(out, x, z) {
    if (this._hasNormal) return this._normal(out, x, z);
    const e = NORMAL_EPSILON;
    const hx = this._height(x + e, z) - this._height(x - e, z);
    const hz = this._height(x, z + e) - this._height(x, z - e);
    out[0] = -hx;
    out[1] = 2 * e;
    out[2] = -hz;
    return vec3.normalize(out, out);
  }

  /**
   * Everything a locomotion or audio system needs about the ground under a
   * column, in one query. Writes into `out` (createGroundInfo()).
   */
  groundInfo(out, x, z, time = 0) {
    const h = this.heightAt(x, z);
    this.normalAt(out.normal, x, z);
    out.height = h;
    out.slopeCos = clamp(out.normal[1], -1, 1);
    out.slopeAngle = Math.acos(out.slopeCos);
    out.walkable = out.slopeCos >= PLAYER.MAX_SLOPE;

    const surf = this.waterHeightAt(x, z, time);
    out.submerged = h < surf;
    out.material = this._hasMaterial
      ? this._material(x, z)
      : this._inferMaterial(h, out.slopeCos, surf);
    out.grip = MATERIAL_GRIP[out.material];
    out.softness = MATERIAL_SOFTNESS[out.material];
    return out;
  }

  /**
   * Fallback material classification when the terrain generator has no
   * material channel: slope decides rock vs sediment, and the waterline
   * decides wet vs dry. Crude, but it keeps footsteps and traction plausible
   * on any terrain that only knows how to be a height field.
   */
  _inferMaterial(h, slopeCos, waterY) {
    const depth = waterY - h;
    if (slopeCos < 0.72) return depth > 0 ? MATERIAL.BASALT_WET : MATERIAL.BASALT_DRY;
    if (depth > 0.4) return depth > 6 ? MATERIAL.SILT : MATERIAL.CORAL_RUBBLE;
    if (depth > -0.6) return MATERIAL.WET_SAND;
    if (h > 42) return MATERIAL.BASALT_DRY;
    return MATERIAL.DRY_SAND;
  }

  /**
   * Height of the terrain over the capsule's whole footprint, not just its
   * axis. A heightfield sampled only at the centre lets a capsule sink its
   * shoulder into a ridge that passes between samples; taking the maximum of
   * the centre and four offsets at 0.75r is conservative in the direction that
   * matters (it pushes the body out, never in).
   */
  footprintHeight(x, z, radius) {
    const r = radius * 0.75;
    let h = this.heightAt(x, z);
    const a = this.heightAt(x + r, z); if (a > h) h = a;
    const b = this.heightAt(x - r, z); if (b > h) h = b;
    const c = this.heightAt(x, z + r); if (c > h) h = c;
    const d = this.heightAt(x, z - r); if (d > h) h = d;
    return h;
  }

  // -------------------------------------------------------------------------
  // Ray casting
  // -------------------------------------------------------------------------

  /**
   * Cast a ray against the terrain height field.
   *
   * ALGORITHM. Define f(t) = origin.y + t*dir.y - h(origin.xz + t*dir.xz), the
   * signed height of the ray above the surface. An intersection is a zero
   * crossing of f. Because h is Lipschitz with constant L (TERRAIN_LIPSCHITZ),
   * f is Lipschitz in t with constant K = |dir.y| + L*|dir.xz|, so from any t
   * with f(t) > 0 the surface cannot be nearer than f(t)/K. Marching by exactly
   * that distance is a sphere trace: it is unconditionally safe (it can never
   * step over a hit) and it takes long strides in open air, unlike a fixed
   * step which is either slow everywhere or wrong near cliffs.
   *
   * Once f goes negative the crossing is bracketed in [tPrev, t] and 24
   * bisections drive the interval below RAY_SURFACE_EPSILON - a fixed, tiny
   * cost that turns the marcher's coarse answer into a sub-millimetre one.
   *
   * WORST CASE. Steps shrink toward RAY_MIN_STEP only where the ray runs
   * parallel to a surface at the Lipschitz limit - grazing a 76-degree cliff.
   * There the marcher degenerates to a 0.05 m fixed step and RAY_MAX_STEPS
   * bounds it at 25.6 m of travel, after which it reports `exhausted` rather
   * than lying. Every non-grazing ray terminates in O(log(maxDist)) strides;
   * measured on the project's own fbm terrain a 200 m ray costs 20-40 steps.
   *
   * @param {Float32Array} origin absolute world position
   * @param {Float32Array} dir    unit direction
   * @param {number} maxDist      metres
   * @param {object} out          createRayHit() record
   */
  raycast(origin, dir, maxDist, out = this._ray) {
    this.stats.rayQueries++;
    out.hit = false;
    out.exhausted = false;
    out.steps = 0;
    out.t = maxDist;

    const ox = origin[0], oy = origin[1], oz = origin[2];
    const dx = dir[0], dy = dir[1], dz = dir[2];
    const horizontal = Math.hypot(dx, dz);
    const K = Math.abs(dy) + TERRAIN_LIPSCHITZ * horizontal;

    let f0 = oy - this.heightAt(ox, oz);
    if (f0 <= 0) {
      // Started inside the terrain: report an immediate hit so callers never
      // get a silent miss when a body has already been pushed underground.
      out.hit = true;
      out.t = 0;
      vec3.set(out.point, ox, oy, oz);
      this.normalAt(out.normal, ox, oz);
      return out;
    }
    if (K < EPSILON) return out;   // ray is stationary in the field; no crossing

    let t = 0;
    let tPrev = 0;
    for (let i = 0; i < RAY_MAX_STEPS; i++) {
      out.steps++;
      this.stats.raySteps++;
      const step = clamp(f0 / K, RAY_MIN_STEP, RAY_MAX_STEP);
      tPrev = t;
      t += step;
      if (t >= maxDist) {
        // Test the endpoint exactly so a hit in the final fraction is not lost.
        const fEnd = (oy + maxDist * dy) - this.heightAt(ox + maxDist * dx, oz + maxDist * dz);
        if (fEnd > 0) return out;
        t = maxDist;
        return this._bisect(out, ox, oy, oz, dx, dy, dz, tPrev, t);
      }
      const f = (oy + t * dy) - this.heightAt(ox + t * dx, oz + t * dz);
      if (f <= 0) return this._bisect(out, ox, oy, oz, dx, dy, dz, tPrev, t);
      f0 = f;
    }
    out.exhausted = true;
    return out;
  }

  _bisect(out, ox, oy, oz, dx, dy, dz, lo, hi) {
    for (let i = 0; i < RAY_BISECT_ITERATIONS && hi - lo > RAY_SURFACE_EPSILON; i++) {
      const mid = (lo + hi) * 0.5;
      const f = (oy + mid * dy) - this.heightAt(ox + mid * dx, oz + mid * dz);
      if (f > 0) lo = mid; else hi = mid;
    }
    out.hit = true;
    out.t = hi;
    out.point[0] = ox + hi * dx;
    out.point[1] = oy + hi * dy;
    out.point[2] = oz + hi * dz;
    this.normalAt(out.normal, out.point[0], out.point[2]);
    return out;
  }

  /** Convenience: distance from `origin` straight down to the terrain. */
  heightAboveGround(x, y, z) {
    return y - this.heightAt(x, z);
  }

  // -------------------------------------------------------------------------
  // Water surface
  // -------------------------------------------------------------------------

  /**
   * Full surface sample: height, horizontal Gerstner displacement and normal.
   * This is the SAME evaluation the ocean renderer uses, so the vessel floats
   * exactly where the water is drawn.
   */
  waterSurfaceAt(x, z, time, out = this._water) {
    if (this.ocean) {
      const s = this.ocean.oceanHeightAt(x, z, time);
      out.y = s.y;
      out.dx = s.dx || 0;
      out.dz = s.dz || 0;
      if (s.n) vec3.copy(out.normal, s.n);
      else vec3.set(out.normal, 0, 1, 0);
      return out;
    }
    return this.waves.sample(out, x, z, time);
  }

  /** Height only. The hot path: the vessel calls this once per hull station. */
  waterHeightAt(x, z, time) {
    if (this.ocean) return this.ocean.oceanHeightAt(x, z, time).y;
    return this.waves.heightAt(x, z, time);
  }

  /** Depth of the seabed below the instantaneous surface, metres. */
  waterColumnAt(x, z, time) {
    return this.waterHeightAt(x, z, time) - this.heightAt(x, z);
  }

  // -------------------------------------------------------------------------
  // Capsule resolution (the player)
  // -------------------------------------------------------------------------

  /**
   * Move and resolve an upright capsule against the terrain.
   *
   * `body.position` is the FEET point (the bottom of the capsule), which makes
   * step-up, ground snap and the waterline all read directly off the same
   * value. Velocity is integrated by the caller's forces; this function only
   * advances position and removes the components the terrain forbids.
   *
   * Tunnelling is prevented by substepping so no substep advances further than
   * half a radius. At PLAYER.RADIUS that is 0.17 m per substep, i.e. an honest
   * ceiling of 16 * 0.17 / dt = 163 m/s before the solver could miss a wall -
   * far above anything a player can reach on foot or in freefall.
   *
   * @param {object} body {position, velocity, radius, height, stepHeight, stepDown, maxSlope}
   * @param {number} dt
   * @param {object} out createCapsuleContact()
   * @param {number} [time] ocean time, so the wet/dry material split follows the
   *   real wave surface rather than a nominal sea level
   */
  resolveCapsule(body, dt, out, time = 0) {
    const pos = body.position;
    const vel = body.velocity;
    const radius = body.radius != null ? body.radius : PLAYER.RADIUS;
    const stepUp = body.stepHeight != null ? body.stepHeight : PLAYER.STEP_HEIGHT;
    const stepDown = body.stepDown != null ? body.stepDown : PLAYER.STEP_HEIGHT * 1.3;
    const maxSlope = body.maxSlope != null ? body.maxSlope : PLAYER.MAX_SLOPE;
    const wasGrounded = out.grounded;

    out.wallHit = false;
    out.steppedUp = 0;
    out.landingSpeed = 0;
    out.grounded = false;

    const speed = vec3.len(vel);
    const substeps = clamp(
      Math.ceil((speed * dt) / (radius * CAPSULE_SUBSTEP_FRACTION)), 1, CAPSULE_MAX_SUBSTEPS);
    const h = dt / substeps;

    // Static scatter proxies: broad phase ONCE per resolve (the whole step's
    // travel fits inside one inflated gather), narrow phase per substep so a
    // fast swimmer cannot tunnel a thin chimney between contacts. Gated live
    // by WORLD.SCATTER_COLLISION; at 0 this block is two loads and a branch.
    const capHeight = body.height != null ? body.height : PLAYER.HEIGHT;
    let staticN = 0;
    if (WORLD.SCATTER_COLLISION !== 0 && this.statics.count > 0) {
      staticN = this.statics.query(
        pos[0], pos[1] + capHeight * 0.5, pos[2],
        radius + capHeight * 0.5 + speed * dt + 0.5, this._staticHits);
    }

    let caveMode = false;

    for (let s = 0; s < substeps; s++) {
      // ---- cave interior --------------------------------------------------
      // Inside a carved void the heightfield answers for the rock overhead,
      // so the whole heightfield block below is wrong there; the field is the
      // only authority. Gated on the capsule's centre - a body straddling the
      // mouth rim takes the heightfield path with the two carve gates below,
      // which is exactly the handover that lets it cross.
      if (this.caves !== null &&
          this._caveOpen(pos[0], pos[1] + capHeight * 0.5, pos[2])) {
        caveMode = true;
        this._resolveCapsuleCaveStep(pos, vel, radius, capHeight, h, out);
        continue;
      }

      // ---- horizontal ----------------------------------------------------
      let nx = pos[0] + vel[0] * h;
      let nz = pos[2] + vel[2] * h;
      if (vel[0] !== 0 || vel[2] !== 0) {
        let ahead = this.footprintHeight(nx, nz, radius);
        // The too-tall test reads the heightfield, which knows nothing about
        // a mouth carved through a steep face; when the destination is open
        // cave void, the "wall" is a hole and the body may pass.
        if (ahead - pos[1] > stepUp &&
            !this._caveOpen(nx, pos[1] + radius, nz)) {
          // Too tall to step onto: treat as a wall and slide along it. The
          // wall normal is the terrain normal with its vertical part removed;
          // on a heightfield that is the uphill gradient direction.
          this.normalAt(_n, nx, nz);
          _n[1] = 0;
          const l = Math.hypot(_n[0], _n[2]);
          if (l > EPSILON) {
            _n[0] /= l; _n[2] /= l;
            const into = vel[0] * _n[0] + vel[2] * _n[2];
            if (into < 0) {
              vel[0] -= into * _n[0];
              vel[2] -= into * _n[2];
            }
            out.wallHit = true;
            out.wallNormal[0] = _n[0];
            out.wallNormal[1] = 0;
            out.wallNormal[2] = _n[2];
            nx = pos[0] + vel[0] * h;
            nz = pos[2] + vel[2] * h;
            ahead = this.footprintHeight(nx, nz, radius);
          }
          if (ahead - pos[1] > stepUp) {
            // Still blocked after sliding (an inside corner): stop dead
            // horizontally rather than grinding into the rock.
            nx = pos[0];
            nz = pos[2];
            vel[0] = 0;
            vel[2] = 0;
          }
        }
        if (ahead > pos[1] && ahead - pos[1] <= stepUp) out.steppedUp += ahead - pos[1];
      }
      pos[0] = nx;
      pos[2] = nz;

      // ---- vertical -------------------------------------------------------
      pos[1] += vel[1] * h;
      const ground = this.footprintHeight(pos[0], pos[2], radius);
      if (pos[1] <= ground) {
        // The ground snap declines where the ground has been carved open -
        // this is the gate that lets a diver descend INTO a cave mouth; the
        // cave-interior branch above takes over once the capsule is through.
        if (this._groundCarved(pos[0], ground, pos[2])) {
          // falling through the mouth: no contact this substep
        } else {
          if (vel[1] < 0) {
            if (!wasGrounded && !out.grounded) out.landingSpeed = Math.max(out.landingSpeed, -vel[1]);
            vel[1] = 0;
          }
          pos[1] = ground;
          out.grounded = true;
        }
      } else if (wasGrounded && vel[1] <= 0 && pos[1] - ground <= stepDown &&
                 !this._groundCarved(pos[0], ground, pos[2])) {
        // Step-down snap: keeps the player glued to a descending slope instead
        // of launching off every convexity. Carve-gated for the same reason as
        // the snap above: a walker crossing a mouth falls in rather than being
        // glued across the hole.
        pos[1] = ground;
        vel[1] = 0;
        out.grounded = true;
      }

      // ---- static scatter proxies -----------------------------------------
      if (staticN > 0) this._pushCapsuleOutOfStatics(pos, vel, radius, capHeight, staticN, out);
    }

    if (caveMode) {
      // The heightfield tail below would report the ROCK ABOVE the cave as
      // the ground. Inside the override the honest answers are local ones:
      // the last contact normal (kept by the cave step), the feet as groundY,
      // and wet basalt - a cave wall is never anything else.
      out.groundY = pos[1];
      out.slopeCos = clamp(out.normal[1], -1, 1);
      out.material = MATERIAL.BASALT_WET;
      out.walkable = out.grounded && out.slopeCos >= maxSlope;
      return out;
    }
    this.normalAt(out.normal, pos[0], pos[2]);
    out.groundY = this.footprintHeight(pos[0], pos[2], radius);
    out.slopeCos = clamp(out.normal[1], -1, 1);
    out.material = this._hasMaterial
      ? this._material(pos[0], pos[2])
      : this._inferMaterial(out.groundY, out.slopeCos,
        this.waterHeightAt(pos[0], pos[2], time));
    // Grounded says "in contact"; walkable says "can push off it". A player on
    // a 55-degree face is grounded and sliding, and the caller needs both bits.
    out.walkable = out.slopeCos >= maxSlope;
    return out;
  }

  /**
   * One substep of capsule motion inside a carved cave void: integrate, then
   * depenetrate two spheres (feet and head centres) against the volumetric
   * field. Position-level pushes and into-velocity removal ONLY, exactly the
   * discipline _pushCapsuleOutOfStatics keeps, so THE SWIM CONTRACT is
   * untouched: no force, no smoothing, no state, and every swim steady state
   * stays independent of SWIM_DRAG.
   *
   * Two iterations: the field magnitude under-estimates distance near a
   * max() seam, so one push can leave residue; the second collects it, and
   * whatever survives a pathological corner is collected by the next substep
   * of the same 60 Hz resolver rather than accumulating.
   */
  _resolveCapsuleCaveStep(pos, vel, radius, height, h, out) {
    const caves = this.caves;
    const n = this._caveNormal;
    pos[0] += vel[0] * h;
    pos[1] += vel[1] * h;
    pos[2] += vel[2] * h;
    const headOffset = Math.max(radius, height - radius);
    for (let iter = 0; iter < 2; iter++) {
      let touched = false;
      for (let sph = 0; sph < 2; sph++) {
        const cy = pos[1] + (sph === 0 ? radius : headOffset);
        const d = caves.caveDensity(pos[0], cy, pos[2]);
        if (d >= radius) continue;
        caves.caveNormal(n, pos[0], cy, pos[2]);
        const push = radius - d;
        pos[0] += n[0] * push;
        pos[1] += n[1] * push;
        pos[2] += n[2] * push;
        const into = vel[0] * n[0] + vel[1] * n[1] + vel[2] * n[2];
        if (into < 0) {
          vel[0] -= into * n[0];
          vel[1] -= into * n[1];
          vel[2] -= into * n[2];
        }
        vec3.copy(out.normal, n);
        if (n[1] > 0.6) {
          out.grounded = true;
        } else {
          out.wallHit = true;
          const l = Math.hypot(n[0], n[2]);
          if (l > EPSILON) {
            out.wallNormal[0] = n[0] / l;
            out.wallNormal[1] = 0;
            out.wallNormal[2] = n[2] / l;
          }
        }
        this.stats.caveContacts++;
        touched = true;
      }
      if (!touched) break;
    }
  }

  /**
   * Push an upright capsule out of every penetrating static proxy, POSITION
   * LEVEL, exactly the way the terrain path resolves: the position moves out
   * along the contact normal and the velocity loses only its into-contact
   * component. No force, no smoothing, no state - which is what THE SWIM
   * CONTRACT requires of anything touching the diver (the thrust/drag model
   * upstream is untouched and every swim steady state stays independent of
   * SWIM_DRAG). Candidates come from the caller's one broad-phase gather;
   * shapes are resolved sequentially, so a corner between two proxies relaxes
   * over the substeps like the terrain's own inside-corner case.
   */
  _pushCapsuleOutOfStatics(pos, vel, radius, height, staticN, out) {
    const s = this.statics;
    const hits = this._staticHits;
    for (let k = 0; k < staticN; k++) {
      const id = hits[k];
      // Player capsule axis: feet-anchored, so it moves with pos as we push.
      const ax = pos[0], az = pos[2];
      const ay0 = pos[1] + radius;
      const ay1 = pos[1] + Math.max(radius, height - radius);
      closestSegSeg(this._segA, this._segB,
        ax, ay0, az, ax, ay1, az,
        s.ax[id], s.ay[id], s.az[id], s.bx[id], s.by[id], s.bz[id]);
      const dx = this._segA[0] - this._segB[0];
      const dy = this._segA[1] - this._segB[1];
      const dz = this._segA[2] - this._segB[2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const pen = radius + s.r[id] - d;
      if (pen <= 0) continue;

      let nx, ny, nz;
      if (d > 1e-6) {
        nx = dx / d; ny = dy / d; nz = dz / d;
      } else {
        // Axis passes exactly through the proxy: push straight up, the one
        // direction that is always free on a seabed prop.
        nx = 0; ny = 1; nz = 0;
      }

      pos[0] += nx * pen;
      pos[1] += ny * pen;
      pos[2] += nz * pen;

      const into = vel[0] * nx + vel[1] * ny + vel[2] * nz;
      if (into < 0) {
        vel[0] -= into * nx;
        vel[1] -= into * ny;
        vel[2] -= into * nz;
      }

      if (ny > 0.6) {
        // Standing on top of the prop counts as ground contact, or the walk
        // state machine would flip to AIRBORNE on every boulder.
        out.grounded = true;
      } else {
        out.wallHit = true;
        const l = Math.hypot(nx, nz);
        if (l > EPSILON) {
          out.wallNormal[0] = nx / l;
          out.wallNormal[1] = 0;
          out.wallNormal[2] = nz / l;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Vessel hull resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve a rigid hull against the terrain using a set of body-space probe
   * spheres.
   *
   * WHY PROBES AND NOT A CONVEX SWEEP. A swept convex hull needs a convex
   * opponent, and the terrain has none: it is a height field today and a
   * marching-cubes field in the caves tomorrow, regenerated per chunk as the
   * camera moves. Producing a convex decomposition to sweep against would cost
   * more than the physics it serves and would have to be rebuilt every time a
   * chunk re-meshes. Probes query the same analytic field the buoyancy solver
   * already samples, cost O(P) with P = 14, and - crucially - give SEVERAL
   * simultaneous contacts, which is what makes the hull rock, settle and skid
   * on a reef instead of pivoting about one deepest point. A single sweep
   * returns one contact and one normal, and a 7.4 m vessel resting on it would
   * behave like a ball.
   *
   * The solver is sequential-impulse with Baumgarte stabilisation, matching
   * DESIGN/04.2.9 (6 iterations there, 4 here at 60 Hz - the extra two buy
   * nothing once added mass is engaged).
   *
   * @param {object} body {position, orientation, velocity, angularVelocity, mass, inertia}
   * @param {Float32Array} probesLocal xyz triples in body space
   * @param {number} probeCount
   * @param {number} probeRadius
   * @param {number} dt
   * @param {object} out createHullContact()
   * @param {number} [time] ocean time, for the same reason as resolveCapsule()
   */
  resolveVesselHull(body, probesLocal, probeCount, probeRadius, dt, out, time = 0) {
    out.contacts = 0;
    out.maxPenetration = 0;
    out.impactSpeed = 0;

    const pos = body.position;
    const q = body.orientation;
    const vel = body.velocity;
    const omega = body.angularVelocity;
    const invMass = body.mass > 0 ? 1 / body.mass : 0;

    // World-space inverse inertia: R * diag(1/I) * R^T.
    mat3.fromQuat(_rot, q);
    const I = body.inertia;
    for (let c = 0; c < 3; c++) {
      const ii = 1 / Math.max(I[c], 1e-6);
      for (let rIdx = 0; rIdx < 3; rIdx++) {
        _invI[c * 3 + rIdx] = _rot[c * 3 + rIdx] * ii;
      }
    }
    // _invI currently holds R*diag; finish with * R^T.
    const m00 = _invI[0] * _rot[0] + _invI[3] * _rot[3] + _invI[6] * _rot[6];
    const m01 = _invI[0] * _rot[1] + _invI[3] * _rot[4] + _invI[6] * _rot[7];
    const m02 = _invI[0] * _rot[2] + _invI[3] * _rot[5] + _invI[6] * _rot[8];
    const m11 = _invI[1] * _rot[1] + _invI[4] * _rot[4] + _invI[7] * _rot[7];
    const m12 = _invI[1] * _rot[2] + _invI[4] * _rot[5] + _invI[7] * _rot[8];
    const m22 = _invI[2] * _rot[2] + _invI[5] * _rot[5] + _invI[8] * _rot[8];
    _invI[0] = m00; _invI[1] = m01; _invI[2] = m02;
    _invI[3] = m01; _invI[4] = m11; _invI[5] = m12;
    _invI[6] = m02; _invI[7] = m12; _invI[8] = m22;

    let correctionY = 0;
    let deepest = -Infinity;

    // Cave admission (see setCaveField): one field query decides whether any
    // carved void is near enough for the per-probe tests to matter. The
    // magnitude of caveVoidAt is a LOWER bound on distance-to-void, so
    // below -24 nothing the hull can reach this step is carved and the
    // resolver is byte-identical to the pre-cave build.
    const caves = this.caves;
    let nearCave = false;
    let bodyInCave = false;
    if (caves !== null) {
      const safe = caves.CAVE_SAFE_RADIUS || 0;
      if (pos[0] * pos[0] + pos[2] * pos[2] >= safe * safe) {
        const bodyVoid = caves.caveVoidAt(pos[0], pos[1], pos[2]);
        nearCave = bodyVoid > -24;
        // Inside the void, EVERY probe must take the cave branch: the
        // heightfield's answer is the rock 60-100 m overhead, and its
        // vertical correction would snap the hull up through the roof.
        bodyInCave = bodyVoid > 0 && pos[1] < this._height(pos[0], pos[2]);
      }
    }

    // Static scatter proxies: one broad-phase gather for the whole hull. The
    // probes reach 3.55 m from the origin, plus the step's own travel so a
    // Vne approach cannot outrun its own gather. Gated by WORLD.SCATTER_COLLISION.
    let staticN = 0;
    if (WORLD.SCATTER_COLLISION !== 0 && this.statics.count > 0) {
      staticN = this.statics.query(pos[0], pos[1], pos[2],
        3.8 + probeRadius + vec3.len(vel) * dt, this._staticHits);
    }

    for (let iter = 0; iter < HULL_ITERATIONS; iter++) {
      for (let i = 0; i < probeCount; i++) {
        _t[0] = probesLocal[i * 3];
        _t[1] = probesLocal[i * 3 + 1];
        _t[2] = probesLocal[i * 3 + 2];
        vec3.transformQuat(_r, _t, q);
        _p[0] = pos[0] + _r[0];
        _p[1] = pos[1] + _r[1];
        _p[2] = pos[2] + _r[2];

        const ground = this.heightAt(_p[0], _p[2]);
        const penetration = (ground + probeRadius) - _p[1];
        if (penetration > 0) {
          // ---- cave branch (see the nearCave gate above) -----------------
          // Taken when the probe sits in or within 1.5 m of a carved void:
          // the heightfield answers for the rock overhead there, and its
          // vertical push is wrong in every direction that matters. Contact
          // runs against caveDensity along caveNormal - the exact field the
          // cave mesh is marched from, so the wall the hull settles against
          // is the wall on screen. correctionY is deliberately NOT fed, the
          // static-proxy argument: a vertical lift is right for ground below
          // the hull and wrong for a wall or roof beside it.
          let caveContact = false;
          if (nearCave &&
              (bodyInCave || caves.caveVoidAt(_p[0], _p[1], _p[2]) > -1.5)) {
            caveContact = true;
            const d = caves.caveDensity(_p[0], _p[1], _p[2]);
            const pen = probeRadius - d;
            if (pen > 0) {
              caves.caveNormal(_n, _p[0], _p[1], _p[2]);
              const vn = this._probeContactImpulse(vel, omega, invMass, dt, pen);
              if (iter === 0) {
                out.contacts++;
                if (pen > out.maxPenetration) out.maxPenetration = pen;
                if (pen > deepest) {
                  deepest = pen;
                  vec3.copy(out.normal, _n);
                  out.material = MATERIAL.BASALT_WET;
                }
                if (-vn > out.impactSpeed) out.impactSpeed = -vn;
              }
            }
          }
          if (!caveContact) {
            this.normalAt(_n, _p[0], _p[2]);
            const vn = this._probeContactImpulse(vel, omega, invMass, dt, penetration);

            if (iter === 0) {
              out.contacts++;
              if (penetration > out.maxPenetration) out.maxPenetration = penetration;
              if (penetration > deepest) {
                deepest = penetration;
                vec3.copy(out.normal, _n);
                out.material = this._hasMaterial
                  ? this._material(_p[0], _p[2])
                  : this._inferMaterial(ground, _n[1],
                    this.waterHeightAt(_p[0], _p[2], time));
              }
              if (-vn > out.impactSpeed) out.impactSpeed = -vn;
              correctionY = Math.max(correctionY, penetration);
            }
          }
        }

        // ---- static scatter proxies against the same probe -----------------
        // Same probe offset _r, same impulse machinery; only the opponent and
        // its normal differ. correctionY is deliberately NOT fed: it lifts the
        // body VERTICALLY, which is right for a heightfield below the hull and
        // wrong for a chimney beside it - proxy penetration recovers through
        // the Baumgarte bias along the true contact normal instead.
        for (let k = 0; k < staticN; k++) {
          const sid = this._staticHits[k];
          const st = this.statics;
          closestOnSegment(_cp, _p[0], _p[1], _p[2],
            st.ax[sid], st.ay[sid], st.az[sid], st.bx[sid], st.by[sid], st.bz[sid]);
          const dx = _p[0] - _cp[0], dy = _p[1] - _cp[1], dz = _p[2] - _cp[2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const pen = probeRadius + st.r[sid] - d;
          if (pen <= 0) continue;

          if (d > 1e-6) {
            _n[0] = dx / d; _n[1] = dy / d; _n[2] = dz / d;
          } else {
            vec3.set(_n, 0, 1, 0);
          }
          const vn = this._probeContactImpulse(vel, omega, invMass, dt, pen);

          if (iter === 0) {
            out.contacts++;
            if (pen > out.maxPenetration) out.maxPenetration = pen;
            if (pen > deepest) {
              deepest = pen;
              vec3.copy(out.normal, _n);
              // Scatter proxies are rock, coral and mineral; wet basalt is the
              // honest single material for the impact SFX until proxies carry
              // their own.
              out.material = MATERIAL.BASALT_WET;
            }
            if (-vn > out.impactSpeed) out.impactSpeed = -vn;
          }
        }
      }
    }

    // Residual positional correction. Baumgarte alone leaves a slow sink under
    // sustained load (resting on a slope with thrust into it); lifting the body
    // by the leftover penetration is what makes it actually rest.
    if (correctionY > HULL_PENETRATION_SLOP) {
      pos[1] += (correctionY - HULL_PENETRATION_SLOP) * 0.6;
    }
    return out;
  }

  /**
   * One sequential-impulse contact at the CURRENT probe: normal impulse with
   * Baumgarte bias and restitution, then Coulomb friction. Extracted so the
   * terrain contact and the static-proxy contact run EXACTLY the same solver -
   * two copies of this arithmetic would be this project's most repeated bug.
   *
   * Reads module scratch state set by the caller: `_r` (contact offset from
   * the COM, world space), `_n` (contact normal, unit, world space) and
   * `_invI` (world-space inverse inertia, built once per resolve).
   * Mutates `vel` and `omega` in place.
   *
   * @returns {number} the pre-impulse normal closing velocity vn (negative
   *   approaching), which is what the caller's iter-0 stats record.
   */
  _probeContactImpulse(vel, omega, invMass, dt, penetration) {
    // Contact point velocity: v + omega x r.
    _v[0] = vel[0] + omega[1] * _r[2] - omega[2] * _r[1];
    _v[1] = vel[1] + omega[2] * _r[0] - omega[0] * _r[2];
    _v[2] = vel[2] + omega[0] * _r[1] - omega[1] * _r[0];
    const vn = vec3.dot(_v, _n);

    // Effective mass along the normal.
    vec3.cross(_t2, _r, _n);
    vec3.transformMat3(_t, _t2, _invI);
    vec3.cross(_t2, _t, _r);
    const denom = invMass + vec3.dot(_t2, _n);
    if (denom < 1e-9) return vn;

    const bias = (HULL_BAUMGARTE / Math.max(dt, 1e-4)) *
      Math.max(0, penetration - HULL_PENETRATION_SLOP);
    const restitution = vn < -1.0 ? HULL_RESTITUTION : 0;
    let jn = (-(1 + restitution) * vn + bias) / denom;
    if (jn < 0) jn = 0;

    // Apply the normal impulse.
    vel[0] += jn * _n[0] * invMass;
    vel[1] += jn * _n[1] * invMass;
    vel[2] += jn * _n[2] * invMass;
    vec3.cross(_t2, _r, _n);
    vec3.scale(_t2, _t2, jn);
    vec3.transformMat3(_t, _t2, _invI);
    omega[0] += _t[0]; omega[1] += _t[1]; omega[2] += _t[2];

    // Coulomb friction on the tangential component.
    _v[0] = vel[0] + omega[1] * _r[2] - omega[2] * _r[1];
    _v[1] = vel[1] + omega[2] * _r[0] - omega[0] * _r[2];
    _v[2] = vel[2] + omega[0] * _r[1] - omega[1] * _r[0];
    const vnAfter = vec3.dot(_v, _n);
    _t2[0] = _v[0] - vnAfter * _n[0];
    _t2[1] = _v[1] - vnAfter * _n[1];
    _t2[2] = _v[2] - vnAfter * _n[2];
    const tLen = vec3.len(_t2);
    if (tLen > 1e-4) {
      vec3.scale(_n2, _t2, 1 / tLen);
      vec3.cross(_t2, _r, _n2);
      vec3.transformMat3(_t, _t2, _invI);
      vec3.cross(_t2, _t, _r);
      const denomT = invMass + vec3.dot(_t2, _n2);
      if (denomT > 1e-9) {
        let jt = -tLen / denomT;
        const limit = HULL_FRICTION * jn;
        jt = clamp(jt, -limit, limit);
        vel[0] += jt * _n2[0] * invMass;
        vel[1] += jt * _n2[1] * invMass;
        vel[2] += jt * _n2[2] * invMass;
        vec3.cross(_t2, _r, _n2);
        vec3.scale(_t2, _t2, jt);
        vec3.transformMat3(_t, _t2, _invI);
        omega[0] += _t[0]; omega[1] += _t[1]; omega[2] += _t[2];
      }
    }
    return vn;
  }

  // -------------------------------------------------------------------------
  // Entity hash pass-through
  // -------------------------------------------------------------------------

  insertEntity(id, x, y, z) { return this.entities.insert(id, x, y, z); }
  moveEntity(id, x, y, z) { return this.entities.insert(id, x, y, z); }
  removeEntity(id) { return this.entities.remove(id); }
  queryRadius(x, y, z, radius, out, maxResults) {
    return this.entities.queryRadius(x, y, z, radius, out, maxResults);
  }

  /**
   * A safe standing point near (x, z): the terrain height, unless the ground
   * there is steeper than the walk limit, in which case the nearest of eight
   * probes at `searchRadius` that is walkable wins. Used by vessel egress and
   * by respawn placement.
   *
   * @returns {boolean} true if a walkable point was found and written to `out`
   */
  findFooting(out, x, z, searchRadius = 2.5, time = 0) {
    this.normalAt(_n, x, z);
    if (_n[1] >= PLAYER.MAX_SLOPE) {
      vec3.set(out, x, this.heightAt(x, z), z);
      return true;
    }
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      const px = x + Math.cos(a) * searchRadius;
      const pz = z + Math.sin(a) * searchRadius;
      this.normalAt(_n, px, pz);
      if (_n[1] >= PLAYER.MAX_SLOPE) {
        vec3.set(out, px, this.heightAt(px, pz), pz);
        return true;
      }
    }
    vec3.set(out, x, this.heightAt(x, z), z);
    return false;
  }

  /**
   * Ground-effect height for the vessel: distance from a point to whichever is
   * nearer, the seabed or the water surface. Both surfaces reflect a duct's
   * downwash, though water reflects it less (DESIGN/04.2.5).
   *
   * @returns {number} negative when the point is below both surfaces
   */
  surfaceClearance(x, y, z, time) {
    const ground = y - this.heightAt(x, z);
    const water = y - this.waterHeightAt(x, z, time);
    return Math.min(ground, water < 0 ? Infinity : water);
  }

  /** Distance from the world centre; used for the soft/hard boundary logic. */
  boundaryFactor(x, z) {
    const r = Math.hypot(x, z);
    return smoothstep(WORLD.SOFT_BOUNDARY, WORLD.HARD_BOUNDARY, r);
  }
}

/**
 * Vessel hull probe radius: the skid tube radius, which is what the vessel comes
 * to rest on.
 *
 * IMPORTED, NOT RESTATED. The resolver holds every probe CENTRE this far above
 * the ground, so the pair (probe y, probe radius) is the stance the Kestrel
 * settles into, and it has to be the same pair the mesh draws. At the 0.16 this
 * replaces - a number that called itself the tube radius while the tube was
 * 75 mm - the physics parked the origin 1.26 m up and the geometry's lowest
 * point was at 1.175 m, so a landed vessel hovered 8.5 cm over the sand with the
 * contact solver insisting it was down.
 */
export const VESSEL_PROBE_RADIUS = VESSEL_SKID_RADIUS;

/**
 * Default hull probe set in body space, derived from the mesh's extremes:
 * four skid feet, four nacelle bases, nose, tail and two beam midpoints.
 *
 * The skid feet sit on the tube's CENTRELINE, so a probe sphere of the tube's
 * own radius has its underside exactly on the tube's underside. Their z reaches
 * past the ends of the straight run on purpose: the contact base wants to be as
 * long as the skid, and out there the real tube has swept upward, so the probe is
 * conservative - it touches down first, never last.
 */
export const VESSEL_HULL_PROBES = Float32Array.of(
  // skid feet
  -1.18, VESSEL_SKID_KEEL, -1.60, 1.18, VESSEL_SKID_KEEL, -1.60,
  -1.18, VESSEL_SKID_KEEL, 1.40, 1.18, VESSEL_SKID_KEEL, 1.40,
  // nacelle undersides (VESSEL.NACELLE_POSITIONS, dropped to the duct rim)
  VESSEL.NACELLE_POSITIONS[0][0], -0.52, VESSEL.NACELLE_POSITIONS[0][2],
  VESSEL.NACELLE_POSITIONS[1][0], -0.52, VESSEL.NACELLE_POSITIONS[1][2],
  VESSEL.NACELLE_POSITIONS[2][0], -0.52, VESSEL.NACELLE_POSITIONS[2][2],
  VESSEL.NACELLE_POSITIONS[3][0], -0.52, VESSEL.NACELLE_POSITIONS[3][2],
  // hull extremities
  0.00, -0.18, -3.55, 0.00, -0.10, 3.55,
  -2.02, -0.20, 0.20, 2.02, -0.20, 0.20,
);

export const VESSEL_HULL_PROBE_COUNT = VESSEL_HULL_PROBES.length / 3;
