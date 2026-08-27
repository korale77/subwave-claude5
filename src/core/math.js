/**
 * SUBWAVE core math.
 *
 * Conventions (BINDING for the whole codebase):
 *   - Right-handed world space. +X east, +Y up, +Z south. Metres.
 *   - Sea level is y = 0. Depth d = -y (positive downwards).
 *   - Heading 0 rad = north (-Z), increasing clockwise seen from above (+X = 90deg).
 *   - Matrices are column-major Float32Array(16), matching WGSL mat4x4<f32>.
 *   - Quaternions are (x, y, z, w).
 *   - Projections emit WebGPU clip space: z in [0, 1], and we use REVERSE-Z
 *     (near -> 1, far -> 0) with an infinite far plane. Depth buffers therefore
 *     clear to 0.0 and compare with 'greater'.
 *
 * Style: gl-matrix-like `out`-first functions so hot paths never allocate.
 */

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

export const PI = Math.PI;
export const TAU = Math.PI * 2;
export const HALF_PI = Math.PI * 0.5;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const EPSILON = 1e-6;

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const saturate = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
export const fract = (x) => x - Math.floor(x);
export const sqr = (x) => x * x;

/** Linear remap from [a0,a1] to [b0,b1], unclamped. */
export const remap = (x, a0, a1, b0, b1) => b0 + ((x - a0) / (a1 - a0)) * (b1 - b0);
/** Linear remap, clamped to the destination range. */
export const remapClamped = (x, a0, a1, b0, b1) => {
  const t = saturate((x - a0) / (a1 - a0 || EPSILON));
  return b0 + t * (b1 - b0);
};

/** GLSL smoothstep. */
export const smoothstep = (edge0, edge1, x) => {
  const t = saturate((x - edge0) / (edge1 - edge0 || EPSILON));
  return t * t * (3 - 2 * t);
};
/** Ken Perlin's C2-continuous variant. */
export const smootherstep = (edge0, edge1, x) => {
  const t = saturate((x - edge0) / (edge1 - edge0 || EPSILON));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/**
 * Frame-rate independent exponential approach.
 * `rate` is the fraction of remaining distance covered per second (0..1 exclusive).
 * Use this instead of `lerp(a, b, 0.1)` in any per-frame smoothing.
 */
export const damp = (a, b, rate, dt) => b + (a - b) * Math.exp(-rate * dt);

/** Exponential approach expressed as a half-life in seconds. */
export const dampHalfLife = (a, b, halfLife, dt) =>
  b + (a - b) * Math.pow(2, -dt / Math.max(halfLife, 1e-9));

export const moveTowards = (a, b, maxDelta) => {
  const d = b - a;
  return Math.abs(d) <= maxDelta ? b : a + Math.sign(d) * maxDelta;
};

/** Wrap to (-PI, PI]. */
export const wrapAngle = (a) => {
  a = (a + PI) % TAU;
  if (a < 0) a += TAU;
  return a - PI;
};
/** Wrap to [0, TAU). */
export const wrapAngle2Pi = (a) => {
  a %= TAU;
  return a < 0 ? a + TAU : a;
};
/** Shortest signed angular difference b - a, in (-PI, PI]. */
export const angleDelta = (a, b) => wrapAngle(b - a);
/** Angular lerp along the short arc. */
export const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;

export const degToRad = (d) => d * DEG2RAD;
export const radToDeg = (r) => r * RAD2DEG;

/** Next power of two >= x. */
export const nextPow2 = (x) => {
  let v = x - 1;
  v |= v >> 1; v |= v >> 2; v |= v >> 4; v |= v >> 8; v |= v >> 16;
  return v + 1;
};
/** Round n up to the next multiple of `align` (align must be a power of two). */
export const alignUp = (n, align) => (n + align - 1) & ~(align - 1);

// Easing curves used by UI and camera work.
export const ease = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => t * (2 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outQuart: (t) => 1 - Math.pow(1 - t, 4),
  inExpo: (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  outExpo: (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  outBack: (t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
  outElastic: (t) =>
    t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * PI) / 3)) + 1,
};

// ---------------------------------------------------------------------------
// Deterministic pseudo-random
// ---------------------------------------------------------------------------

/** Fast 32-bit integer scramble (used as a spatial hash and PRNG seeder). */
export function hashU32(x) {
  x |= 0;
  x = (x ^ 61) ^ (x >>> 16);
  x = (x + (x << 3)) | 0;
  x ^= x >>> 4;
  x = Math.imul(x, 0x27d4eb2d);
  x ^= x >>> 15;
  return x >>> 0;
}

/** Hash 2 integers -> u32. Order-sensitive, well distributed. */
export function hash2i(x, y) {
  let h = Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

/** Hash 3 integers -> u32. */
export function hash3i(x, y, z) {
  let h = Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(z | 0, 0xcb1ab31f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

/** Hash to [0,1). */
export const hash2f = (x, y) => hash2i(x, y) / 4294967296;
export const hash3f = (x, y, z) => hash3i(x, y, z) / 4294967296;

/**
 * mulberry32 - small, fast, statistically decent PRNG.
 * Returns a function producing floats in [0,1).
 */
export function makeRng(seed) {
  let a = (seed | 0) >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (lo, hi) => lo + rng() * (hi - lo);
  rng.int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length) % arr.length];
  /** Box-Muller normal deviate. */
  rng.normal = () => {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
  };
  /** Uniform point on the unit sphere, written into `out`. */
  rng.onSphere = (out) => {
    const z = rng() * 2 - 1;
    const t = rng() * TAU;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    out[0] = r * Math.cos(t);
    out[1] = r * Math.sin(t);
    out[2] = z;
    return out;
  };
  rng.shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  };
  return rng;
}

/** Radical inverse in base b - the guts of the Halton sequence. */
export function radicalInverse(i, base) {
  let f = 1, r = 0;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/** Halton(2,3) point n (1-indexed), written into `out` as [0,1)^2. Used for TAA jitter. */
export function halton23(n, out) {
  out[0] = radicalInverse(n, 2);
  out[1] = radicalInverse(n, 3);
  return out;
}

// ---------------------------------------------------------------------------
// vec2
// ---------------------------------------------------------------------------

export const vec2 = {
  create: (x = 0, y = 0) => Float32Array.of(x, y),
  set: (o, x, y) => { o[0] = x; o[1] = y; return o; },
  copy: (o, a) => { o[0] = a[0]; o[1] = a[1]; return o; },
  add: (o, a, b) => { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; return o; },
  sub: (o, a, b) => { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; return o; },
  mul: (o, a, b) => { o[0] = a[0] * b[0]; o[1] = a[1] * b[1]; return o; },
  scale: (o, a, s) => { o[0] = a[0] * s; o[1] = a[1] * s; return o; },
  scaleAndAdd: (o, a, b, s) => { o[0] = a[0] + b[0] * s; o[1] = a[1] + b[1] * s; return o; },
  dot: (a, b) => a[0] * b[0] + a[1] * b[1],
  cross: (a, b) => a[0] * b[1] - a[1] * b[0],
  len: (a) => Math.hypot(a[0], a[1]),
  sqrLen: (a) => a[0] * a[0] + a[1] * a[1],
  dist: (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]),
  sqrDist: (a, b) => { const x = b[0] - a[0], y = b[1] - a[1]; return x * x + y * y; },
  normalize: (o, a) => {
    const l = Math.hypot(a[0], a[1]);
    if (l > EPSILON) { o[0] = a[0] / l; o[1] = a[1] / l; } else { o[0] = 0; o[1] = 0; }
    return o;
  },
  lerp: (o, a, b, t) => { o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; return o; },
  rotate: (o, a, rad) => {
    const c = Math.cos(rad), s = Math.sin(rad), x = a[0], y = a[1];
    o[0] = x * c - y * s; o[1] = x * s + y * c; return o;
  },
};

// ---------------------------------------------------------------------------
// vec3
// ---------------------------------------------------------------------------

export const vec3 = {
  create: (x = 0, y = 0, z = 0) => Float32Array.of(x, y, z),
  clone: (a) => Float32Array.of(a[0], a[1], a[2]),
  set: (o, x, y, z) => { o[0] = x; o[1] = y; o[2] = z; return o; },
  copy: (o, a) => { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; },
  zero: (o) => { o[0] = 0; o[1] = 0; o[2] = 0; return o; },
  add: (o, a, b) => { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; o[2] = a[2] + b[2]; return o; },
  sub: (o, a, b) => { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; o[2] = a[2] - b[2]; return o; },
  mul: (o, a, b) => { o[0] = a[0] * b[0]; o[1] = a[1] * b[1]; o[2] = a[2] * b[2]; return o; },
  div: (o, a, b) => { o[0] = a[0] / b[0]; o[1] = a[1] / b[1]; o[2] = a[2] / b[2]; return o; },
  scale: (o, a, s) => { o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; return o; },
  addScalar: (o, a, s) => { o[0] = a[0] + s; o[1] = a[1] + s; o[2] = a[2] + s; return o; },
  scaleAndAdd: (o, a, b, s) => {
    o[0] = a[0] + b[0] * s; o[1] = a[1] + b[1] * s; o[2] = a[2] + b[2] * s; return o;
  },
  negate: (o, a) => { o[0] = -a[0]; o[1] = -a[1]; o[2] = -a[2]; return o; },
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (o, a, b) => {
    const ax = a[0], ay = a[1], az = a[2], bx = b[0], by = b[1], bz = b[2];
    o[0] = ay * bz - az * by;
    o[1] = az * bx - ax * bz;
    o[2] = ax * by - ay * bx;
    return o;
  },
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  sqrLen: (a) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2],
  dist: (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]),
  sqrDist: (a, b) => {
    const x = b[0] - a[0], y = b[1] - a[1], z = b[2] - a[2];
    return x * x + y * y + z * z;
  },
  /** Horizontal (XZ) distance, ignoring depth. Used constantly by AI and streaming. */
  distXZ: (a, b) => Math.hypot(b[0] - a[0], b[2] - a[2]),
  normalize: (o, a) => {
    const l = Math.hypot(a[0], a[1], a[2]);
    if (l > EPSILON) { const s = 1 / l; o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; }
    else { o[0] = 0; o[1] = 0; o[2] = 0; }
    return o;
  },
  lerp: (o, a, b, t) => {
    o[0] = a[0] + (b[0] - a[0]) * t;
    o[1] = a[1] + (b[1] - a[1]) * t;
    o[2] = a[2] + (b[2] - a[2]) * t;
    return o;
  },
  /** Frame-rate independent smoothing of a vector. */
  damp: (o, a, b, rate, dt) => {
    const k = Math.exp(-rate * dt);
    o[0] = b[0] + (a[0] - b[0]) * k;
    o[1] = b[1] + (a[1] - b[1]) * k;
    o[2] = b[2] + (a[2] - b[2]) * k;
    return o;
  },
  min: (o, a, b) => {
    o[0] = Math.min(a[0], b[0]); o[1] = Math.min(a[1], b[1]); o[2] = Math.min(a[2], b[2]); return o;
  },
  max: (o, a, b) => {
    o[0] = Math.max(a[0], b[0]); o[1] = Math.max(a[1], b[1]); o[2] = Math.max(a[2], b[2]); return o;
  },
  /** Clamp the vector's length to `maxLen`. */
  clampLen: (o, a, maxLen) => {
    const l = Math.hypot(a[0], a[1], a[2]);
    if (l > maxLen && l > EPSILON) {
      const s = maxLen / l;
      o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s;
    } else if (o !== a) {
      o[0] = a[0]; o[1] = a[1]; o[2] = a[2];
    }
    return o;
  },
  /** Reflect `a` about unit normal `n`. */
  reflect: (o, a, n) => {
    const d = 2 * (a[0] * n[0] + a[1] * n[1] + a[2] * n[2]);
    o[0] = a[0] - d * n[0]; o[1] = a[1] - d * n[1]; o[2] = a[2] - d * n[2];
    return o;
  },
  /** Component of `a` parallel to unit normal `n`, removed. */
  projectOnPlane: (o, a, n) => {
    const d = a[0] * n[0] + a[1] * n[1] + a[2] * n[2];
    o[0] = a[0] - d * n[0]; o[1] = a[1] - d * n[1]; o[2] = a[2] - d * n[2];
    return o;
  },
  /** Transform as a point (applies translation). */
  transformMat4: (o, a, m) => {
    const x = a[0], y = a[1], z = a[2];
    let w = m[3] * x + m[7] * y + m[11] * z + m[15];
    w = w || 1;
    o[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    o[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    o[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
    return o;
  },
  /** Transform as a direction (ignores translation). */
  transformMat4Dir: (o, a, m) => {
    const x = a[0], y = a[1], z = a[2];
    o[0] = m[0] * x + m[4] * y + m[8] * z;
    o[1] = m[1] * x + m[5] * y + m[9] * z;
    o[2] = m[2] * x + m[6] * y + m[10] * z;
    return o;
  },
  transformMat3: (o, a, m) => {
    const x = a[0], y = a[1], z = a[2];
    o[0] = m[0] * x + m[3] * y + m[6] * z;
    o[1] = m[1] * x + m[4] * y + m[7] * z;
    o[2] = m[2] * x + m[5] * y + m[8] * z;
    return o;
  },
  transformQuat: (o, a, q) => {
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    const x = a[0], y = a[1], z = a[2];
    // t = 2 * cross(q.xyz, v)
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);
    o[0] = x + qw * tx + (qy * tz - qz * ty);
    o[1] = y + qw * ty + (qz * tx - qx * tz);
    o[2] = z + qw * tz + (qx * ty - qy * tx);
    return o;
  },
  /** Any unit vector perpendicular to unit `a`. */
  anyPerpendicular: (o, a) => {
    if (Math.abs(a[0]) < 0.9) { o[0] = 1; o[1] = 0; o[2] = 0; }
    else { o[0] = 0; o[1] = 1; o[2] = 0; }
    const d = o[0] * a[0] + o[1] * a[1] + o[2] * a[2];
    o[0] -= d * a[0]; o[1] -= d * a[1]; o[2] -= d * a[2];
    return vec3.normalize(o, o);
  },
  equalsApprox: (a, b, eps = 1e-5) =>
    Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps,
  isFinite: (a) => Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]),
  str: (a, p = 2) => `(${a[0].toFixed(p)}, ${a[1].toFixed(p)}, ${a[2].toFixed(p)})`,
};

// Shared axis constants. TypedArrays cannot be frozen, so these are read-only
// BY CONVENTION: never pass one as an `out` parameter.
export const VEC3_ZERO = vec3.create(0, 0, 0);
export const VEC3_ONE = vec3.create(1, 1, 1);
export const VEC3_UP = vec3.create(0, 1, 0);
export const VEC3_DOWN = vec3.create(0, -1, 0);
export const VEC3_NORTH = vec3.create(0, 0, -1);
export const VEC3_EAST = vec3.create(1, 0, 0);

// ---------------------------------------------------------------------------
// vec4
// ---------------------------------------------------------------------------

export const vec4 = {
  create: (x = 0, y = 0, z = 0, w = 0) => Float32Array.of(x, y, z, w),
  set: (o, x, y, z, w) => { o[0] = x; o[1] = y; o[2] = z; o[3] = w; return o; },
  copy: (o, a) => { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; o[3] = a[3]; return o; },
  add: (o, a, b) => { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; o[2] = a[2] + b[2]; o[3] = a[3] + b[3]; return o; },
  sub: (o, a, b) => { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; o[2] = a[2] - b[2]; o[3] = a[3] - b[3]; return o; },
  scale: (o, a, s) => { o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; o[3] = a[3] * s; return o; },
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3],
  lerp: (o, a, b, t) => {
    o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t;
    o[2] = a[2] + (b[2] - a[2]) * t; o[3] = a[3] + (b[3] - a[3]) * t;
    return o;
  },
  transformMat4: (o, a, m) => {
    const x = a[0], y = a[1], z = a[2], w = a[3];
    o[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
    o[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
    o[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
    o[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
    return o;
  },
  normalize: (o, a) => {
    const l = Math.hypot(a[0], a[1], a[2], a[3]);
    if (l > EPSILON) { const s = 1 / l; o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; o[3] = a[3] * s; }
    return o;
  },
};

// ---------------------------------------------------------------------------
// quat  (x, y, z, w)
// ---------------------------------------------------------------------------

export const quat = {
  create: () => Float32Array.of(0, 0, 0, 1),
  clone: (a) => Float32Array.of(a[0], a[1], a[2], a[3]),
  identity: (o) => { o[0] = 0; o[1] = 0; o[2] = 0; o[3] = 1; return o; },
  copy: (o, a) => { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; o[3] = a[3]; return o; },
  set: (o, x, y, z, w) => { o[0] = x; o[1] = y; o[2] = z; o[3] = w; return o; },

  setAxisAngle: (o, axis, rad) => {
    const h = rad * 0.5, s = Math.sin(h);
    o[0] = axis[0] * s; o[1] = axis[1] * s; o[2] = axis[2] * s; o[3] = Math.cos(h);
    return o;
  },

  /** Hamilton product: o = a * b (apply b first, then a). */
  multiply: (o, a, b) => {
    const ax = a[0], ay = a[1], az = a[2], aw = a[3];
    const bx = b[0], by = b[1], bz = b[2], bw = b[3];
    o[0] = ax * bw + aw * bx + ay * bz - az * by;
    o[1] = ay * bw + aw * by + az * bx - ax * bz;
    o[2] = az * bw + aw * bz + ax * by - ay * bx;
    o[3] = aw * bw - ax * bx - ay * by - az * bz;
    return o;
  },

  conjugate: (o, a) => { o[0] = -a[0]; o[1] = -a[1]; o[2] = -a[2]; o[3] = a[3]; return o; },
  invert: (o, a) => {
    const d = a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3];
    const s = d > EPSILON ? 1 / d : 0;
    o[0] = -a[0] * s; o[1] = -a[1] * s; o[2] = -a[2] * s; o[3] = a[3] * s;
    return o;
  },
  normalize: (o, a) => {
    let l = Math.hypot(a[0], a[1], a[2], a[3]);
    if (l < EPSILON) { return quat.identity(o); }
    l = 1 / l;
    o[0] = a[0] * l; o[1] = a[1] * l; o[2] = a[2] * l; o[3] = a[3] * l;
    return o;
  },
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3],

  /** Rotate `a` about its own local X axis by rad (pitch). */
  rotateX: (o, a, rad) => {
    const h = rad * 0.5, bx = Math.sin(h), bw = Math.cos(h);
    const ax = a[0], ay = a[1], az = a[2], aw = a[3];
    o[0] = ax * bw + aw * bx;
    o[1] = ay * bw + az * bx;
    o[2] = az * bw - ay * bx;
    o[3] = aw * bw - ax * bx;
    return o;
  },
  /** Rotate `a` about its own local Y axis by rad (yaw). */
  rotateY: (o, a, rad) => {
    const h = rad * 0.5, by = Math.sin(h), bw = Math.cos(h);
    const ax = a[0], ay = a[1], az = a[2], aw = a[3];
    o[0] = ax * bw - az * by;
    o[1] = ay * bw + aw * by;
    o[2] = az * bw + ax * by;
    o[3] = aw * bw - ay * by;
    return o;
  },
  /** Rotate `a` about its own local Z axis by rad (roll). */
  rotateZ: (o, a, rad) => {
    const h = rad * 0.5, bz = Math.sin(h), bw = Math.cos(h);
    const ax = a[0], ay = a[1], az = a[2], aw = a[3];
    o[0] = ax * bw + ay * bz;
    o[1] = ay * bw - ax * bz;
    o[2] = az * bw + aw * bz;
    o[3] = aw * bw - az * bz;
    return o;
  },

  /**
   * Yaw-pitch-roll in this project's world convention.
   * Applied as Ry(-yaw) * Rx(pitch) * Rz(roll) - the intuitive
   * "turn, then look up/down, then bank" order for aircraft and submarines.
   *
   * YAW IS A COMPASS HEADING: 0 = north (-Z), increasing CLOCKWISE seen from
   * above, so +PI/2 faces east (+X). That matches headingFromDir() and the
   * compass HUD, and it is the reason for the negation below - a mathematically
   * positive rotation about +Y is COUNTER-clockwise from above, which is the
   * opposite of a heading.
   *
   * Getting this backwards inverts mouse look, and it did: turning the mouse
   * right swung the view west. If you change the sign here you must also change
   * headingFromDir(), dirFromHeading() and the compass, because they all agree
   * with each other.
   *
   * PITCH is positive UP.
   */
  fromEuler: (o, yaw, pitch, roll) => {
    const cy = Math.cos(-yaw * 0.5), sy = Math.sin(-yaw * 0.5);
    const cp = Math.cos(pitch * 0.5), sp = Math.sin(pitch * 0.5);
    const cr = Math.cos(roll * 0.5), sr = Math.sin(roll * 0.5);
    o[0] = cy * sp * cr + sy * cp * sr;
    o[1] = sy * cp * cr - cy * sp * sr;
    o[2] = cy * cp * sr - sy * sp * cr;
    o[3] = cy * cp * cr + sy * sp * sr;
    return o;
  },

  /**
   * Decompose to {yaw, pitch, roll} in the same convention as fromEuler, so
   * fromEuler(toEuler(q)) round-trips. `yaw` comes back as a compass heading.
   */
  toEuler: (q, out = { yaw: 0, pitch: 0, roll: 0 }) => {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    const sp = 2 * (w * x + y * z);
    out.pitch = Math.asin(clamp(sp, -1, 1));
    if (Math.abs(sp) > 0.99999) {
      // Gimbal lock: fold roll into yaw.
      out.yaw = -2 * Math.atan2(y, w);
      out.roll = 0;
    } else {
      // Negated to undo the heading negation in fromEuler.
      out.yaw = -Math.atan2(2 * (w * y - x * z), 1 - 2 * (x * x + y * y));
      out.roll = Math.atan2(2 * (w * z - x * y), 1 - 2 * (x * x + z * z));
    }
    return out;
  },

  /** Shortest-arc rotation taking unit vector `from` to unit vector `to`. */
  rotationTo: (() => {
    const tmp = vec3.create();
    return (o, from, to) => {
      const d = vec3.dot(from, to);
      if (d > 0.999999) return quat.identity(o);
      if (d < -0.999999) {
        vec3.anyPerpendicular(tmp, from);
        o[0] = tmp[0]; o[1] = tmp[1]; o[2] = tmp[2]; o[3] = 0;
        return o;
      }
      vec3.cross(tmp, from, to);
      o[0] = tmp[0]; o[1] = tmp[1]; o[2] = tmp[2]; o[3] = 1 + d;
      return quat.normalize(o, o);
    };
  })(),

  /**
   * Orientation whose -Z axis points along `forward` and whose +Y is as close
   * to `up` as possible. (-Z forward matches the camera/RH convention.)
   */
  lookRotation: (() => {
    const f = vec3.create(), r = vec3.create(), u = vec3.create();
    const m = new Float32Array(9);
    return (o, forward, up = VEC3_UP) => {
      vec3.normalize(f, forward);
      // The basis must be RIGHT-HANDED: with -Z as forward the columns have to
      // satisfy X x Y = Z = -f, which means right = f x up and up = right x f.
      // Both cross products used to be the other way round, which negated `right`
      // while leaving `up` correct - a determinant -1 basis, i.e. a reflection.
      // fromMat3 reads a reflection as garbage and quat.normalize then hides it,
      // so nothing ever threw: EVERY purely horizontal `forward` came back as the
      // identity (facing north), and every other direction came back simply wrong.
      vec3.cross(r, f, up);
      if (vec3.sqrLen(r) < 1e-8) {
        vec3.anyPerpendicular(r, f);
      }
      vec3.normalize(r, r);
      vec3.cross(u, r, f);
      // Columns: X = right, Y = up, Z = -forward
      m[0] = r[0]; m[1] = r[1]; m[2] = r[2];
      m[3] = u[0]; m[4] = u[1]; m[5] = u[2];
      m[6] = -f[0]; m[7] = -f[1]; m[8] = -f[2];
      return quat.fromMat3(o, m);
    };
  })(),

  fromMat3: (o, m) => {
    const trace = m[0] + m[4] + m[8];
    if (trace > 0) {
      const s = Math.sqrt(trace + 1) * 2;
      o[3] = 0.25 * s;
      o[0] = (m[5] - m[7]) / s;
      o[1] = (m[6] - m[2]) / s;
      o[2] = (m[1] - m[3]) / s;
    } else if (m[0] > m[4] && m[0] > m[8]) {
      const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
      o[3] = (m[5] - m[7]) / s;
      o[0] = 0.25 * s;
      o[1] = (m[1] + m[3]) / s;
      o[2] = (m[6] + m[2]) / s;
    } else if (m[4] > m[8]) {
      const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
      o[3] = (m[6] - m[2]) / s;
      o[0] = (m[1] + m[3]) / s;
      o[1] = 0.25 * s;
      o[2] = (m[5] + m[7]) / s;
    } else {
      const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
      o[3] = (m[1] - m[3]) / s;
      o[0] = (m[6] + m[2]) / s;
      o[1] = (m[5] + m[7]) / s;
      o[2] = 0.25 * s;
    }
    return quat.normalize(o, o);
  },

  slerp: (o, a, b, t) => {
    let ax = a[0], ay = a[1], az = a[2], aw = a[3];
    let bx = b[0], by = b[1], bz = b[2], bw = b[3];
    let cosom = ax * bx + ay * by + az * bz + aw * bw;
    if (cosom < 0) { cosom = -cosom; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    let s0, s1;
    if (1 - cosom > 1e-6) {
      const omega = Math.acos(cosom), sinom = Math.sin(omega);
      s0 = Math.sin((1 - t) * omega) / sinom;
      s1 = Math.sin(t * omega) / sinom;
    } else {
      s0 = 1 - t; s1 = t;
    }
    o[0] = s0 * ax + s1 * bx;
    o[1] = s0 * ay + s1 * by;
    o[2] = s0 * az + s1 * bz;
    o[3] = s0 * aw + s1 * bw;
    return o;
  },

  /** Frame-rate independent slerp toward `b`. */
  damp: (o, a, b, rate, dt) => quat.slerp(o, a, b, 1 - Math.exp(-rate * dt)),

  /**
   * Integrate an angular velocity (rad/s, world space) over dt.
   * o = normalize(a + 0.5 * dt * omega_quat * a)
   */
  integrate: (o, a, omega, dt) => {
    const wx = omega[0] * dt * 0.5, wy = omega[1] * dt * 0.5, wz = omega[2] * dt * 0.5;
    const ax = a[0], ay = a[1], az = a[2], aw = a[3];
    o[0] = ax + (wx * aw + wy * az - wz * ay);
    o[1] = ay + (wy * aw + wz * ax - wx * az);
    o[2] = az + (wz * aw + wx * ay - wy * ax);
    o[3] = aw + (-wx * ax - wy * ay - wz * az);
    return quat.normalize(o, o);
  },

  /** Local axes of the orientation. */
  right: (o, q) => vec3.transformQuat(vec3.set(o, 1, 0, 0), o, q),
  up: (o, q) => vec3.transformQuat(vec3.set(o, 0, 1, 0), o, q),
  /** -Z is forward. */
  forward: (o, q) => vec3.transformQuat(vec3.set(o, 0, 0, -1), o, q),
};

// ---------------------------------------------------------------------------
// mat3 (column-major, 9 floats). Used for normal matrices and TBN.
// ---------------------------------------------------------------------------

export const mat3 = {
  create: () => Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1),
  identity: (o) => {
    o[0] = 1; o[1] = 0; o[2] = 0;
    o[3] = 0; o[4] = 1; o[5] = 0;
    o[6] = 0; o[7] = 0; o[8] = 1;
    return o;
  },
  fromMat4: (o, m) => {
    o[0] = m[0]; o[1] = m[1]; o[2] = m[2];
    o[3] = m[4]; o[4] = m[5]; o[5] = m[6];
    o[6] = m[8]; o[7] = m[9]; o[8] = m[10];
    return o;
  },
  fromQuat: (o, q) => {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    o[0] = 1 - (yy + zz); o[1] = xy + wz; o[2] = xz - wy;
    o[3] = xy - wz; o[4] = 1 - (xx + zz); o[5] = yz + wx;
    o[6] = xz + wy; o[7] = yz - wx; o[8] = 1 - (xx + yy);
    return o;
  },
  multiply: (o, a, b) => {
    const a00 = a[0], a01 = a[1], a02 = a[2];
    const a10 = a[3], a11 = a[4], a12 = a[5];
    const a20 = a[6], a21 = a[7], a22 = a[8];
    for (let i = 0; i < 3; i++) {
      const b0 = b[i * 3], b1 = b[i * 3 + 1], b2 = b[i * 3 + 2];
      o[i * 3] = b0 * a00 + b1 * a10 + b2 * a20;
      o[i * 3 + 1] = b0 * a01 + b1 * a11 + b2 * a21;
      o[i * 3 + 2] = b0 * a02 + b1 * a12 + b2 * a22;
    }
    return o;
  },
  transpose: (o, a) => {
    if (o === a) {
      let t = a[1]; o[1] = a[3]; o[3] = t;
      t = a[2]; o[2] = a[6]; o[6] = t;
      t = a[5]; o[5] = a[7]; o[7] = t;
    } else {
      o[0] = a[0]; o[1] = a[3]; o[2] = a[6];
      o[3] = a[1]; o[4] = a[4]; o[5] = a[7];
      o[6] = a[2]; o[7] = a[5]; o[8] = a[8];
    }
    return o;
  },
  invert: (o, a) => {
    const a00 = a[0], a01 = a[1], a02 = a[2];
    const a10 = a[3], a11 = a[4], a12 = a[5];
    const a20 = a[6], a21 = a[7], a22 = a[8];
    const b01 = a22 * a11 - a12 * a21;
    const b11 = -a22 * a10 + a12 * a20;
    const b21 = a21 * a10 - a11 * a20;
    let det = a00 * b01 + a01 * b11 + a02 * b21;
    if (!det) return mat3.identity(o);
    det = 1 / det;
    o[0] = b01 * det;
    o[1] = (-a22 * a01 + a02 * a21) * det;
    o[2] = (a12 * a01 - a02 * a11) * det;
    o[3] = b11 * det;
    o[4] = (a22 * a00 - a02 * a20) * det;
    o[5] = (-a12 * a00 + a02 * a10) * det;
    o[6] = b21 * det;
    o[7] = (-a21 * a00 + a01 * a20) * det;
    o[8] = (a11 * a00 - a01 * a10) * det;
    return o;
  },
  /** Normal matrix = transpose(inverse(upper-left 3x3 of m)). */
  normalFromMat4: (() => {
    const tmp = new Float32Array(9);
    return (o, m) => {
      mat3.fromMat4(tmp, m);
      mat3.invert(o, tmp);
      return mat3.transpose(o, o);
    };
  })(),
};

// ---------------------------------------------------------------------------
// mat4 (column-major, 16 floats)
// ---------------------------------------------------------------------------

export const mat4 = {
  create: () => Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1),
  clone: (a) => new Float32Array(a),
  copy: (o, a) => { o.set(a); return o; },
  identity: (o) => {
    o.fill(0);
    o[0] = 1; o[5] = 1; o[10] = 1; o[15] = 1;
    return o;
  },

  multiply: (o, a, b) => {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    for (let i = 0; i < 4; i++) {
      const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
      o[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      o[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      o[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      o[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    }
    return o;
  },

  fromTranslation: (o, v) => {
    mat4.identity(o);
    o[12] = v[0]; o[13] = v[1]; o[14] = v[2];
    return o;
  },
  fromScaling: (o, v) => {
    o.fill(0);
    o[0] = v[0]; o[5] = v[1]; o[10] = v[2]; o[15] = 1;
    return o;
  },
  fromQuat: (o, q) => {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    o[0] = 1 - (yy + zz); o[1] = xy + wz; o[2] = xz - wy; o[3] = 0;
    o[4] = xy - wz; o[5] = 1 - (xx + zz); o[6] = yz + wx; o[7] = 0;
    o[8] = xz + wy; o[9] = yz - wx; o[10] = 1 - (xx + yy); o[11] = 0;
    o[12] = 0; o[13] = 0; o[14] = 0; o[15] = 1;
    return o;
  },

  /** TRS compose: M = T * R * S. */
  fromRotationTranslationScale: (o, q, t, s) => {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const sx = s[0], sy = s[1], sz = s[2];
    o[0] = (1 - (yy + zz)) * sx; o[1] = (xy + wz) * sx; o[2] = (xz - wy) * sx; o[3] = 0;
    o[4] = (xy - wz) * sy; o[5] = (1 - (xx + zz)) * sy; o[6] = (yz + wx) * sy; o[7] = 0;
    o[8] = (xz + wy) * sz; o[9] = (yz - wx) * sz; o[10] = (1 - (xx + yy)) * sz; o[11] = 0;
    o[12] = t[0]; o[13] = t[1]; o[14] = t[2]; o[15] = 1;
    return o;
  },

  getTranslation: (o, m) => { o[0] = m[12]; o[1] = m[13]; o[2] = m[14]; return o; },

  translate: (o, a, v) => {
    const x = v[0], y = v[1], z = v[2];
    if (o !== a) o.set(a);
    o[12] = a[0] * x + a[4] * y + a[8] * z + a[12];
    o[13] = a[1] * x + a[5] * y + a[9] * z + a[13];
    o[14] = a[2] * x + a[6] * y + a[10] * z + a[14];
    o[15] = a[3] * x + a[7] * y + a[11] * z + a[15];
    return o;
  },

  scale: (o, a, v) => {
    const x = v[0], y = v[1], z = v[2];
    o[0] = a[0] * x; o[1] = a[1] * x; o[2] = a[2] * x; o[3] = a[3] * x;
    o[4] = a[4] * y; o[5] = a[5] * y; o[6] = a[6] * y; o[7] = a[7] * y;
    o[8] = a[8] * z; o[9] = a[9] * z; o[10] = a[10] * z; o[11] = a[11] * z;
    o[12] = a[12]; o[13] = a[13]; o[14] = a[14]; o[15] = a[15];
    return o;
  },

  transpose: (o, a) => {
    if (o === a) {
      let t;
      t = a[1]; o[1] = a[4]; o[4] = t;
      t = a[2]; o[2] = a[8]; o[8] = t;
      t = a[3]; o[3] = a[12]; o[12] = t;
      t = a[6]; o[6] = a[9]; o[9] = t;
      t = a[7]; o[7] = a[13]; o[13] = t;
      t = a[11]; o[11] = a[14]; o[14] = t;
    } else {
      o[0] = a[0]; o[1] = a[4]; o[2] = a[8]; o[3] = a[12];
      o[4] = a[1]; o[5] = a[5]; o[6] = a[9]; o[7] = a[13];
      o[8] = a[2]; o[9] = a[6]; o[10] = a[10]; o[11] = a[14];
      o[12] = a[3]; o[13] = a[7]; o[14] = a[11]; o[15] = a[15];
    }
    return o;
  },

  invert: (o, a) => {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;

    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return mat4.identity(o);
    det = 1 / det;

    o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return o;
  },

  /** Fast inverse for rigid transforms (rotation + translation, no scale). */
  invertRigid: (o, a) => {
    const tx = a[12], ty = a[13], tz = a[14];
    const m00 = a[0], m01 = a[1], m02 = a[2];
    const m10 = a[4], m11 = a[5], m12 = a[6];
    const m20 = a[8], m21 = a[9], m22 = a[10];
    o[0] = m00; o[1] = m10; o[2] = m20; o[3] = 0;
    o[4] = m01; o[5] = m11; o[6] = m21; o[7] = 0;
    o[8] = m02; o[9] = m12; o[10] = m22; o[11] = 0;
    o[12] = -(m00 * tx + m01 * ty + m02 * tz);
    o[13] = -(m10 * tx + m11 * ty + m12 * tz);
    o[14] = -(m20 * tx + m21 * ty + m22 * tz);
    o[15] = 1;
    return o;
  },

  /** Right-handed look-at view matrix. */
  lookAt: (() => {
    const f = vec3.create(), s = vec3.create(), u = vec3.create();
    return (o, eye, center, up = VEC3_UP) => {
      vec3.sub(f, center, eye);
      vec3.normalize(f, f);
      vec3.cross(s, f, up);
      if (vec3.sqrLen(s) < 1e-10) vec3.anyPerpendicular(s, f);
      vec3.normalize(s, s);
      vec3.cross(u, s, f);
      o[0] = s[0]; o[1] = u[0]; o[2] = -f[0]; o[3] = 0;
      o[4] = s[1]; o[5] = u[1]; o[6] = -f[1]; o[7] = 0;
      o[8] = s[2]; o[9] = u[2]; o[10] = -f[2]; o[11] = 0;
      o[12] = -vec3.dot(s, eye);
      o[13] = -vec3.dot(u, eye);
      o[14] = vec3.dot(f, eye);
      o[15] = 1;
      return o;
    };
  })(),

  /**
   * REVERSE-Z perspective with an INFINITE far plane, WebGPU clip space (z in [0,1]).
   * near maps to z=1, infinity maps to z=0. Pair with:
   *   depthClearValue: 0.0, depthCompare: 'greater'
   * This is the project default - float32 depth + reverse-Z gives us usable
   * precision from 0.05 m out to the horizon in a 1600 m deep world.
   */
  perspectiveReverseZInfinite: (o, fovY, aspect, near) => {
    const f = 1 / Math.tan(fovY * 0.5);
    o.fill(0);
    o[0] = f / aspect;
    o[5] = f;
    o[10] = 0;
    o[11] = -1;
    o[14] = near;
    return o;
  },

  /** REVERSE-Z perspective with a finite far plane (used for shadow/probe cameras). */
  perspectiveReverseZ: (o, fovY, aspect, near, far) => {
    const f = 1 / Math.tan(fovY * 0.5);
    o.fill(0);
    o[0] = f / aspect;
    o[5] = f;
    o[10] = near / (far - near);
    o[11] = -1;
    o[14] = (far * near) / (far - near);
    return o;
  },

  /** Conventional [0,1] depth perspective. Kept for tools/debug. */
  perspectiveZO: (o, fovY, aspect, near, far) => {
    const f = 1 / Math.tan(fovY * 0.5);
    o.fill(0);
    o[0] = f / aspect;
    o[5] = f;
    o[10] = far / (near - far);
    o[11] = -1;
    o[14] = (far * near) / (near - far);
    return o;
  },

  /**
   * Orthographic, WebGPU [0,1] depth, REVERSE-Z (near -> 1, far -> 0).
   * Used for the shadow cascades so they share the depth conventions.
   *
   * `o[10]` is POSITIVE. mat4.lookAt is right-handed, so a point in front of the
   * light camera has NEGATIVE view z; with the sign flipped this mapped the whole
   * caster range to clip.z in [1, 2], which the rasteriser clips away entirely.
   * The atlas would then keep its 0.0 clear and the receiver's 'greater' compare
   * would report LIT for every pixel - byte-for-byte identical to having no shadow
   * pass at all, at the full cost of running one. Verified: z_view = -near maps to
   * 1.0 and z_view = -far to 0.0.
   */
  orthoReverseZ: (o, left, right, bottom, top, near, far) => {
    o.fill(0);
    const lr = 1 / (left - right);
    const bt = 1 / (bottom - top);
    const nf = 1 / (far - near);
    o[0] = -2 * lr;
    o[5] = -2 * bt;
    o[10] = nf;
    o[12] = (left + right) * lr;
    o[13] = (top + bottom) * bt;
    o[14] = far * nf;
    o[15] = 1;
    return o;
  },

  /** Apply a sub-pixel jitter (in NDC units) to a projection matrix, for TAA. */
  applyJitter: (o, proj, jitterX, jitterY) => {
    if (o !== proj) o.set(proj);
    o[8] += jitterX;
    o[9] += jitterY;
    return o;
  },

  isFinite: (m) => {
    for (let i = 0; i < 16; i++) if (!Number.isFinite(m[i])) return false;
    return true;
  },
};

// ---------------------------------------------------------------------------
// Bounding volumes
// ---------------------------------------------------------------------------

export class AABB {
  constructor(minX = Infinity, minY = Infinity, minZ = Infinity,
              maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity) {
    this.min = vec3.create(minX, minY, minZ);
    this.max = vec3.create(maxX, maxY, maxZ);
  }
  static fromCenterHalf(c, h) {
    return new AABB(c[0] - h[0], c[1] - h[1], c[2] - h[2], c[0] + h[0], c[1] + h[1], c[2] + h[2]);
  }
  reset() {
    vec3.set(this.min, Infinity, Infinity, Infinity);
    vec3.set(this.max, -Infinity, -Infinity, -Infinity);
    return this;
  }
  expandPoint(x, y, z) {
    const mn = this.min, mx = this.max;
    if (x < mn[0]) mn[0] = x; if (y < mn[1]) mn[1] = y; if (z < mn[2]) mn[2] = z;
    if (x > mx[0]) mx[0] = x; if (y > mx[1]) mx[1] = y; if (z > mx[2]) mx[2] = z;
    return this;
  }
  expandAABB(b) {
    this.expandPoint(b.min[0], b.min[1], b.min[2]);
    this.expandPoint(b.max[0], b.max[1], b.max[2]);
    return this;
  }
  /** Grow by a uniform margin in metres. */
  pad(m) {
    this.min[0] -= m; this.min[1] -= m; this.min[2] -= m;
    this.max[0] += m; this.max[1] += m; this.max[2] += m;
    return this;
  }
  center(o) {
    o[0] = (this.min[0] + this.max[0]) * 0.5;
    o[1] = (this.min[1] + this.max[1]) * 0.5;
    o[2] = (this.min[2] + this.max[2]) * 0.5;
    return o;
  }
  halfExtents(o) {
    o[0] = (this.max[0] - this.min[0]) * 0.5;
    o[1] = (this.max[1] - this.min[1]) * 0.5;
    o[2] = (this.max[2] - this.min[2]) * 0.5;
    return o;
  }
  get boundingRadius() {
    const hx = (this.max[0] - this.min[0]) * 0.5;
    const hy = (this.max[1] - this.min[1]) * 0.5;
    const hz = (this.max[2] - this.min[2]) * 0.5;
    return Math.hypot(hx, hy, hz);
  }
  containsPoint(p) {
    return p[0] >= this.min[0] && p[0] <= this.max[0] &&
           p[1] >= this.min[1] && p[1] <= this.max[1] &&
           p[2] >= this.min[2] && p[2] <= this.max[2];
  }
  intersects(b) {
    return this.min[0] <= b.max[0] && this.max[0] >= b.min[0] &&
           this.min[1] <= b.max[1] && this.max[1] >= b.min[1] &&
           this.min[2] <= b.max[2] && this.max[2] >= b.min[2];
  }
  /** Squared distance from a point to the box (0 if inside). */
  sqrDistToPoint(p) {
    let d = 0;
    for (let i = 0; i < 3; i++) {
      const v = p[i];
      if (v < this.min[i]) d += (this.min[i] - v) ** 2;
      else if (v > this.max[i]) d += (v - this.max[i]) ** 2;
    }
    return d;
  }
}

/**
 * View frustum as up to 6 planes (nx, ny, nz, d), pointing INWARD:
 * a point is inside when dot(n, p) + d >= 0 for every plane.
 * Degenerate planes (from an infinite far plane) are dropped.
 */
export class Frustum {
  constructor() {
    this.planes = new Float32Array(24);
    this.count = 0;
  }

  /** Gribb/Hartmann extraction from a column-major viewProj, for [0,1] clip depth. */
  fromViewProj(m) {
    const p = this.planes;
    let n = 0;
    const push = (a, b, c, d) => {
      const len = Math.hypot(a, b, c);
      if (len < 1e-8) return; // infinite/degenerate plane - ignore it
      const s = 1 / len;
      p[n * 4] = a * s; p[n * 4 + 1] = b * s; p[n * 4 + 2] = c * s; p[n * 4 + 3] = d * s;
      n++;
    };
    // Rows of the matrix (column-major storage => row i is m[i], m[4+i], m[8+i], m[12+i]).
    const r0 = [m[0], m[4], m[8], m[12]];
    const r1 = [m[1], m[5], m[9], m[13]];
    const r2 = [m[2], m[6], m[10], m[14]];
    const r3 = [m[3], m[7], m[11], m[15]];

    push(r3[0] + r0[0], r3[1] + r0[1], r3[2] + r0[2], r3[3] + r0[3]); // left
    push(r3[0] - r0[0], r3[1] - r0[1], r3[2] - r0[2], r3[3] - r0[3]); // right
    push(r3[0] + r1[0], r3[1] + r1[1], r3[2] + r1[2], r3[3] + r1[3]); // bottom
    push(r3[0] - r1[0], r3[1] - r1[1], r3[2] - r1[2], r3[3] - r1[3]); // top
    push(r2[0], r2[1], r2[2], r2[3]);                                 // z >= 0
    push(r3[0] - r2[0], r3[1] - r2[1], r3[2] - r2[2], r3[3] - r2[3]); // z <= w
    this.count = n;
    return this;
  }

  containsSphere(cx, cy, cz, radius) {
    const p = this.planes;
    for (let i = 0; i < this.count; i++) {
      const o = i * 4;
      if (p[o] * cx + p[o + 1] * cy + p[o + 2] * cz + p[o + 3] < -radius) return false;
    }
    return true;
  }

  containsAABB(box) {
    const p = this.planes, mn = box.min, mx = box.max;
    for (let i = 0; i < this.count; i++) {
      const o = i * 4;
      const nx = p[o], ny = p[o + 1], nz = p[o + 2], d = p[o + 3];
      // Positive vertex: the corner furthest along the plane normal.
      const px = nx >= 0 ? mx[0] : mn[0];
      const py = ny >= 0 ? mx[1] : mn[1];
      const pz = nz >= 0 ? mx[2] : mn[2];
      if (nx * px + ny * py + nz * pz + d < 0) return false;
    }
    return true;
  }

  containsBoxMinMax(minX, minY, minZ, maxX, maxY, maxZ) {
    const p = this.planes;
    for (let i = 0; i < this.count; i++) {
      const o = i * 4;
      const nx = p[o], ny = p[o + 1], nz = p[o + 2], d = p[o + 3];
      const px = nx >= 0 ? maxX : minX;
      const py = ny >= 0 ? maxY : minY;
      const pz = nz >= 0 ? maxZ : minZ;
      if (nx * px + ny * py + nz * pz + d < 0) return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Ray / intersection helpers
// ---------------------------------------------------------------------------

/**
 * Slab test. Returns the entry distance along the ray, or -1 for a miss.
 * `invDir` must be 1/dir componentwise (Infinity is fine for axis-aligned rays).
 */
export function rayAABB(origin, invDir, box, maxDist = Infinity) {
  let tmin = 0, tmax = maxDist;
  for (let i = 0; i < 3; i++) {
    const t1 = (box.min[i] - origin[i]) * invDir[i];
    const t2 = (box.max[i] - origin[i]) * invDir[i];
    const lo = Math.min(t1, t2), hi = Math.max(t1, t2);
    tmin = Math.max(tmin, lo);
    tmax = Math.min(tmax, hi);
    if (tmax < tmin) return -1;
  }
  return tmin;
}

/** Ray vs sphere. Returns nearest positive t, or -1. */
export function raySphere(origin, dir, center, radius) {
  const ox = origin[0] - center[0], oy = origin[1] - center[1], oz = origin[2] - center[2];
  const b = ox * dir[0] + oy * dir[1] + oz * dir[2];
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  if (t0 >= 0) return t0;
  const t1 = -b + s;
  return t1 >= 0 ? t1 : -1;
}

/** Ray vs the horizontal plane y = planeY. Returns t, or -1 if parallel/behind. */
export function rayPlaneY(origin, dir, planeY) {
  if (Math.abs(dir[1]) < 1e-8) return -1;
  const t = (planeY - origin[1]) / dir[1];
  return t >= 0 ? t : -1;
}

/** Moller-Trumbore. Returns t or -1. */
export function rayTriangle(origin, dir, a, b, c) {
  const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
  const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
  const px = dir[1] * e2z - dir[2] * e2y;
  const py = dir[2] * e2x - dir[0] * e2z;
  const pz = dir[0] * e2y - dir[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-9) return -1;
  const inv = 1 / det;
  const tx = origin[0] - a[0], ty = origin[1] - a[1], tz = origin[2] - a[2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t >= 0 ? t : -1;
}

/** Closest point on segment ab to point p, written into `out`. Returns the parameter t. */
export function closestPointOnSegment(out, p, a, b) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const denom = abx * abx + aby * aby + abz * abz;
  let t = 0;
  if (denom > 1e-12) {
    t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / denom;
    t = saturate(t);
  }
  out[0] = a[0] + abx * t;
  out[1] = a[1] + aby * t;
  out[2] = a[2] + abz * t;
  return t;
}

// ---------------------------------------------------------------------------
// Game-specific conversions
// ---------------------------------------------------------------------------

/** World depth in metres below the sea surface (0 at or above the surface). */
export const depthOf = (y) => Math.max(0, -y);

/**
 * Compass heading in radians from a forward direction.
 * 0 = north (-Z), PI/2 = east (+X), increasing clockwise from above.
 */
export const headingFromDir = (dir) => wrapAngle2Pi(Math.atan2(dir[0], -dir[2]));

/** Unit forward direction (XZ plane) for a compass heading. */
export const dirFromHeading = (out, heading) =>
  vec3.set(out, Math.sin(heading), 0, -Math.cos(heading));

/** Cardinal label for a heading in radians. */
export function headingLabel(heading) {
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const i = Math.round(wrapAngle2Pi(heading) / (TAU / 8)) % 8;
  return names[i];
}

/** Hydrostatic pressure in bar at depth d metres (1 bar atmospheric + rho*g*h). */
export const pressureAtDepth = (d) => 1 + Math.max(0, d) * 0.1007; // seawater rho=1027, g=9.81

/** Simple PID controller used by the vessel stability assist and camera rigs. */
export class PID {
  constructor(kp, ki, kd, integralLimit = Infinity, outputLimit = Infinity) {
    this.kp = kp; this.ki = ki; this.kd = kd;
    this.integralLimit = integralLimit;
    this.outputLimit = outputLimit;
    this.integral = 0;
    this.prevError = 0;
    this.hasPrev = false;
  }
  reset() { this.integral = 0; this.prevError = 0; this.hasPrev = false; }
  update(error, dt) {
    if (dt <= 0) return 0;
    this.integral = clamp(this.integral + error * dt, -this.integralLimit, this.integralLimit);
    const derivative = this.hasPrev ? (error - this.prevError) / dt : 0;
    this.prevError = error;
    this.hasPrev = true;
    const out = this.kp * error + this.ki * this.integral + this.kd * derivative;
    return clamp(out, -this.outputLimit, this.outputLimit);
  }
}
