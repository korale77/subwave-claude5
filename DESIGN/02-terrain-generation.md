# SUBWAVE - DESIGN SECTION 02

# Procedural Terrain, Caves, Scatter & Streaming

Status: BINDING IMPLEMENTATION SPEC. Version 1.0.
Owner section: 02. Depends on 01 (world/biome IDs), consumed by 03 (water+atmosphere), 04 (vessel), 06 (fauna), 07 (resources/mining), 09 (audio), 10 (persistence).

Everything in this document is normative. Where a number appears, implement that number. Where a formula appears, implement that formula, including operator order.

---

## 0. SCOPE AND NON-GOALS

### 0.1 In scope

| # | Subsystem | Deliverable |
|---|-----------|-------------|
| 1 | Noise kernel library | `src/world/noise.js` (CPU, f64) + `src/render/shaders/common/noise.wgsl` (GPU, non-authoritative) |
| 2 | Macro bathymetry shaping | crater, shelf break, canyon, trench, island |
| 3 | Layered heightfield stack | 15 named layers, exact composition |
| 4 | Bake-time erosion | hydraulic droplet + thermal talus + marine sediment drape |
| 5 | Chunk/LOD quadtree | 10 levels, single-draw instanced terrain |
| 6 | Volumetric layer | SDF + marching cubes for caves, overhangs, arches, mining |
| 7 | Scatter | deterministic hash placement, GPU cull, imposters |
| 8 | Procedural asset meshes | rocks, kelp, coral, sponges, fungi, crystals, vents |
| 9 | Collision | heightfield fast path + volumetric triangle grid |
| 10 | Streaming | 4 Web Workers, transferable buffers, frame budgets |
| 11 | Deformation | sparse edit list, IndexedDB persistence, replay-on-load |
| 12 | Determinism contract | bit-identical world from a 64-bit seed |

### 0.2 Out of scope for this section

Water surface/volume rendering, light absorption, fog (section 03). Creature AI and spawning (06). Ore economy, tool balance, recipes (07) - this section specifies only *where ore nodes are placed geometrically*. Terrain shading/texturing/triplanar material blending (05) - this section specifies only the per-vertex material *inputs*.

### 0.3 Hard constraints inherited from the brief

- WebGPU only, Chrome latest. No WebGL path.
- Zero third-party runtime dependencies. Marching-cubes tables, noise gradient tables, and Hermite control points are all source-code data literals, not asset files.
- Plain ES modules, no build step. Workers are `type: "module"`.
- All shaders hand-written WGSL.
- No external textures/meshes/audio.
- 60 fps @ 1920x1080 on Apple M-series; graceful 30 fps on weak integrated GPUs.
- Persistence via IndexedDB + localStorage only.

---

## 1. COORDINATE SYSTEM, UNITS, AND WORLD EXTENTS

Restating the binding convention because every formula below relies on it.

| Quantity | Definition |
|----------|------------|
| Handedness | Right-handed |
| +X | East |
| +Y | Up |
| +Z | South |
| Unit | metre (m) |
| Sea level | `y = 0.0` |
| Depth | `d = -y`, positive downward |
| Heading | `0 rad = north = -Z`, increasing clockwise from above; east = `PI/2` |
| Internal angles | radians (f64 on CPU, f32 on GPU) |
| UI angles | degrees, converted at the presentation layer only |

### 1.1 World extents

| Symbol | Value | Meaning |
|--------|-------|---------|
| `WORLD_HALF` | 8192.0 m | Half-extent on X and Z. World square is 16384 x 16384 m |
| `WORLD_R_MAX` | 11585.24 m | `WORLD_HALF * sqrt(2)`, corner radius |
| `Y_MIN` | -3600.0 m | Absolute floor. Terrain is clamped to this |
| `Y_MAX` | +96.0 m | Absolute ceiling for terrain geometry |
| `SOFT_BARRIER_R` | 7900.0 m | Radius beyond which the return-current pushback begins (section 04 implements the force; 02 only guarantees terrain exists out to `WORLD_R_MAX`) |
| `HARD_CLAMP_R` | 8180.0 m | Player/vessel hard position clamp |

The world does not wrap. Terrain outside `SOFT_BARRIER_R` is a featureless abyssal plain at approximately -2100 m with only micro detail, deliberately uninteresting.

### 1.2 Depth bands (used by every table below)

| Band | Range (m depth) | Label |
|------|-----------------|-------|
| B0 | -46 to 0 (above water) | Emergent |
| B1 | 0 to 30 | Sunlit shallow |
| B2 | 30 to 90 | Reef / kelp |
| B3 | 90 to 200 | Shelf edge |
| B4 | 200 to 520 | Twilight slope |
| B5 | 520 to 900 | Crater basin |
| B6 | 900 to 1500 | Outer slope |
| B7 | 1500 to 2200 | Abyssal plain |
| B8 | 2200 to 3600 | Trench |

---

## 2. DETERMINISM CONTRACT (READ BEFORE WRITING ANY GENERATOR CODE)

**Requirement: for a given 64-bit world seed, the generated world is bit-identical across machines, GPU vendors, Chrome versions, worker counts, and generation orders.**

This is achieved by the following seven rules. Violating any one of them voids the contract.

### R1 - All authoritative terrain is generated on the CPU in JavaScript, never on the GPU

The GPU may generate *visual* detail (detail normal maps, splat noise, foam masks, caustic patterns) because these never feed back into geometry, physics, or persistence. The GPU must never produce a value that is written to IndexedDB or used for collision.

### R2 - Authoritative math uses only exactly-specified IEEE-754 binary64 operations

Permitted in the authoritative path:

`+  -  *  /  Math.floor  Math.ceil  Math.trunc  Math.abs  Math.sqrt  Math.min  Math.max  Math.round`
plus all integer bit ops and `Math.imul`.

**Forbidden** in the authoritative path: `Math.sin`, `Math.cos`, `Math.tan`, `Math.atan`, `Math.atan2`, `Math.exp`, `Math.log`, `Math.pow`, `Math.hypot`, `Math.cbrt`, `**`, `Math.random`, `Date.now`, and any `Float32Array` round-trip that is not explicitly specified.

`Math.sqrt`, `Math.round`, `Math.floor` and the four arithmetic ops are correctly-rounded per IEEE-754 and are safe. `Math.min`/`Math.max` are safe. Everything else is implementation-defined in ECMA-262 and MUST NOT be used.

### R3 - Transcendentals are replaced by specified polynomial kernels

> **NOT IMPLEMENTED.** No `exactmath` module was built; the shipped generator
> uses the platform's `Math` directly. R3 is authored spec that the code does not
> satisfy, and `src/world/noise.js` is authoritative on what determinism the
> generator actually guarantees.

Module `exactmath` would provide these, and only these, are used:

```js
// PI as an exact binary64 literal
const SW_PI      = 3.141592653589793;      // 0x400921FB54442D18
const SW_HALF_PI = 1.5707963267948966;
const SW_TWO_PI  = 6.283185307179586;
const SW_LOG2E   = 1.4426950408889634;
const SW_LN2     = 0.6931471805599453;

// POW2_TABLE[k + 1088] = 2^k exactly, k in [-1088, 1024]. Built at module init by
// repeated multiplication by 0.5 / 2.0 from 1.0 (exact in binary64).

// sw_exp2f(f): 2^f for f in [0,1). Degree-6 truncated Taylor of exp(f*LN2).
function sw_exp2f(f) {
  const c1 = 6.931471805599453e-1, c2 = 2.402265069591007e-1,
        c3 = 5.550410866482158e-2, c4 = 9.618129107628477e-3,
        c5 = 1.333355814670500e-3, c6 = 1.540353039338161e-4;
  return 1.0 + f*(c1 + f*(c2 + f*(c3 + f*(c4 + f*(c5 + f*c6)))));
}
// sw_exp(x) = POW2_TABLE[n+1088] * sw_exp2f(t), n = floor(x*SW_LOG2E), t = x*SW_LOG2E - n
// Domain guarantee: |x| <= 60. Callers must clamp. Max rel error 3.1e-8.
```

```js
// sw_sin(x): range-reduce by SW_TWO_PI using floor(), then degree-11 odd Taylor.
// Coefficients (exact binary64 literals):
//  s1= 1.0, s3=-1.6666666666666666e-1, s5= 8.333333333333333e-3,
//  s7=-1.984126984126984e-4, s9= 2.7557319223985893e-6, s11=-2.505210838544172e-8
// sw_cos(x) = sw_sin(x + SW_HALF_PI)
// Max abs error over [-PI,PI]: 1.2e-11. Range reduction limited to |x| <= 1e6.
```

```js
// sw_atan2(y, x): octant reduction + degree-9 odd rational-free polynomial on z=|min|/|max|
//  a1= 9.99866e-1, a3=-3.302995e-1, a5= 1.801410e-1, a7=-8.51330e-2, a9= 2.08351e-2
// Max abs error: 1.1e-5 rad. This is sufficient because atan2 is used ONLY for
// azimuthal macro modulation with amplitudes >= 1 m and gradients < 0.01 m/rad.
```

```js
// sw_pow(b, e) is defined ONLY for the small integer exponents used in this spec
// (2,3,4,5,6). It is implemented as repeated multiplication with a fixed
// left-to-right order. Fractional powers are forbidden; where a fractional power
// appears in a formula below it is written explicitly as sw_exp(e * sw_log(b))
// and sw_log is provided by the same module (n + poly on mantissa, max rel err 4e-9).
```

### R4 - Order of operations is fixed and specified

Every accumulation loop in this document (fBm octave sums, erosion droplet loops, scatter reduction) has a specified iteration order. Floating-point addition is not associative; the order is part of the contract. Workers must not parallelise *within* a loop whose order is specified. Parallelism is only permitted *across* independent units (chunks, tiles, macro cells), each of which is a pure function of its own coordinates.

### R5 - Every random value derives from a pure integer hash of (seed, semantic coordinates, salt)

There is no stateful PRNG anywhere in world generation. `Math.random()` is banned from the `src/gen/` tree by a lint rule. Any value that "looks random" is `hash_u32(...)` of a tuple that fully identifies it. This makes generation order-independent by construction.

### R6 - Seed derivation

```js
// worldSeed: BigInt64, entered by the player or generated once at world creation
// from crypto.getRandomValues, then persisted. Split into two u32 halves:
const SEED_LO = Number(worldSeed & 0xFFFFFFFFn) >>> 0;
const SEED_HI = Number((worldSeed >> 32n) & 0xFFFFFFFFn) >>> 0;

// Domain seeds. SALT values are compile-time constants listed in Table 2.1.
function domainSeed(SALT) {
  return hash_u32( (hash_u32(SEED_LO ^ SALT) ^ Math.imul(SEED_HI, 0x9E3779B1)) >>> 0 );
}
```

**Table 2.1 - Domain salts (binding, never renumber; renumbering changes all existing worlds)**

| Salt name | Value | Domain |
|-----------|-------|--------|
| `SALT_MACRO_WARP` | 0x00010001 | Continental domain warp |
| `SALT_RIM_AZ` | 0x00010002 | Crater rim azimuthal modulation |
| `SALT_BASIN` | 0x00010003 | Basin undulation fBm |
| `SALT_RIDGE` | 0x00010004 | Ridged spurs |
| `SALT_EROSIVE` | 0x00010005 | Derivative-damped mid detail |
| `SALT_DUNE` | 0x00010006 | Billow dunes |
| `SALT_BOMMIE` | 0x00010007 | Reef bommie worley |
| `SALT_TALUS` | 0x00010008 | Talus worley |
| `SALT_MICRO` | 0x00010009 | Micro value fBm |
| `SALT_ISLAND` | 0x0001000A | Island local relief |
| `SALT_CANYON` | 0x0001000B | Canyon spline jitter |
| `SALT_TRENCH` | 0x0001000C | Trench spline jitter |
| `SALT_CAVE_GRAPH` | 0x00020001 | Cave worm graph |
| `SALT_CAVE_DETAIL` | 0x00020002 | Cave wall perturbation |
| `SALT_CAVE_CHAMBER` | 0x00020003 | Chamber ellipsoids |
| `SALT_OVERHANG` | 0x00020004 | Overhang 3D displacement |
| `SALT_ARCH` | 0x00020005 | Arch seeding |
| `SALT_SCATTER_BASE` | 0x00030000 | Scatter; per-category salt = base + categoryId |
| `SALT_ORE` | 0x00040001 | Ore node placement |
| `SALT_BIOME_JITTER` | 0x00050001 | Biome boundary jitter |
| `SALT_EROSION_SEED` | 0x00060001 | Droplet spawn positions |
| `SALT_ASSET_BASE` | 0x00070000 | Procedural mesh variants; per-asset salt = base + assetId |

### R7 - Version stamping and migration

`GEN_VERSION = 1`. Persisted worlds record `{ worldSeed, GEN_VERSION, EROSION_BAKE_HASH }`. `EROSION_BAKE_HASH` is a FNV-1a 32-bit hash over the packed erosion delta maps. On load, if `GEN_VERSION` differs, the world is flagged incompatible and the player is offered: (a) keep the old baked maps from IndexedDB and continue (terrain identical, new features absent), or (b) regenerate (terrain changes, mining edits preserved by world position). Never silently regenerate.

**Self-test:** on every world load, the generator evaluates `H(x,z)` at 64 fixed probe coordinates (a Halton 2,3 sequence scaled to +/-8000 m) -- **NOT IMPLEMENTED**; no probe table, `GEN_VERSION` or `DETERMINISM_PROBE_HASH` exists in the tree and FNV-1a hashes the raw binary64 bits. The result must equal the stored `DETERMINISM_PROBE_HASH`. Mismatch raises a loud console error and disables persistence for the session. This catches R2/R3 violations introduced by refactoring.

---

## 3. NOISE KERNEL LIBRARY

All functions live in `src/world/noise.js`. All take an explicit `seed` (u32) as the first argument. All are pure. All operate in binary64. Return ranges are stated and are guaranteed, not approximate.

### 3.1 Integer hash primitives

```js
// 32-bit finalizer ("lowbias32"). Avalanche bias < 0.11%.
function hash_u32(x) {
  x = x >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

function h2(seed, ix, iy) {
  let h = (seed ^ 0x9E3779B9) >>> 0;
  h = Math.imul(h ^ (ix | 0), 0x85EBCA6B) >>> 0;
  h = Math.imul(h ^ (iy | 0), 0xC2B2AE35) >>> 0;
  return hash_u32(h);
}

function h3(seed, ix, iy, iz) {
  let h = (seed ^ 0x9E3779B9) >>> 0;
  h = Math.imul(h ^ (ix | 0), 0x85EBCA6B) >>> 0;
  h = Math.imul(h ^ (iy | 0), 0xC2B2AE35) >>> 0;
  h = Math.imul(h ^ (iz | 0), 0x27D4EB2F) >>> 0;
  return hash_u32(h);
}

// Uniform [0,1) from a u32. Exactly 2^-32 quantisation.
function u01(h) { return (h >>> 0) * 2.3283064365386963e-10; }
// Uniform [-1,1) - note: NOT 2*u01-1 (that loses a bit); use the signed form.
function s11(h) { return ((h >>> 0) * 4.656612873077393e-10) - 1.0; }
```

Negative lattice coordinates are handled by two's-complement wraparound in `| 0`, which is well-defined. Coordinates are clamped to +/- 2^26 before hashing (the world never exceeds this at any frequency used).

### 3.2 Value noise

| Function | Signature | Range | Interpolant |
|----------|-----------|-------|-------------|
| `valueNoise2` | `(seed, x, y) -> f64` | `[-1, 1]` | quintic `t*t*t*(t*(t*6-15)+10)` |
| `valueNoise3` | `(seed, x, y, z) -> f64` | `[-1, 1]` | quintic |

Lattice corner value = `s11(h2(seed, ix, iy))`. Bilinear/trilinear blend with the quintic fade on each axis, evaluated x-inner then y then z.

**Cost:** 4 hashes (2D) / 8 hashes (3D) per sample. Used only for micro detail where cheapness matters more than isotropy.

### 3.3 Gradient (Perlin) noise, with analytic derivatives

| Function | Signature | Range |
|----------|-----------|-------|
| `gradNoise2` | `(seed, x, y) -> f64` | `[-1, 1]` (normalised by `*1.4142135623730951`) |
| `gradNoise2d` | `(seed, x, y) -> {n, dx, dy}` | as above + exact analytic gradient |
| `gradNoise3` | `(seed, x, y, z) -> f64` | `[-1, 1]` (normalised by `*1.1547005383792515`) |
| `gradNoise3d` | `(seed, x, y, z) -> {n, dx, dy, dz}` | as above + gradient |

Gradient tables (binding literals):

```js
// 2D: 8 unit vectors on the octagon.
const G2 = [
  1.0, 0.0,   -1.0, 0.0,   0.0, 1.0,   0.0, -1.0,
  0.7071067811865476, 0.7071067811865476,
 -0.7071067811865476, 0.7071067811865476,
  0.7071067811865476,-0.7071067811865476,
 -0.7071067811865476,-0.7071067811865476
];
// index = h2(...) & 7

// 3D: the 12 cube-edge midpoint vectors (Perlin 2002), padded to 16 by repeating
// entries 12,13,14,15 = (1,1,0),(-1,1,0),(0,-1,1),(0,-1,-1) - the standard padding
// that keeps the & 15 mask uniform-ish and is documented as acceptable.
const G3 = [
  1, 1, 0,  -1, 1, 0,   1,-1, 0,  -1,-1, 0,
  1, 0, 1,  -1, 0, 1,   1, 0,-1,  -1, 0,-1,
  0, 1, 1,   0,-1, 1,   0, 1,-1,   0,-1,-1,
  1, 1, 0,  -1, 1, 0,   0,-1, 1,   0,-1,-1
];
// index = (h3(...) & 15) * 3
```

Derivatives are computed analytically (quintic derivative `30*t^2*(t*(t-2)+1)`), never by finite difference, so that the erosive fBm in 3.7 is exact and cheap.

### 3.4 Simplex-lattice gradient noise

Used where directional artifacts of the cubic Perlin lattice would be visible (large-scale bathymetry, domain warp fields).

| Function | Signature | Range | Constants |
|----------|-----------|-------|-----------|
| `simplex2` | `(seed, x, y) -> f64` | `[-1, 1]` | `F2 = 0.3660254037844386`, `G2 = 0.21132486540518713`, kernel radius^2 `= 0.5`, output scale `= 70.0` |
| `simplex3` | `(seed, x, y, z) -> f64` | `[-1, 1]` | `F3 = 0.3333333333333333`, `G3 = 0.16666666666666666`, kernel radius^2 `= 0.6`, output scale `= 32.0` |

Kernel: `t = r2 - dx*dx - dy*dy [- dz*dz]`; if `t > 0`, `t2 = t*t; contrib = t2*t2*dot(grad, d)`. Gradients from `G2`/`G3`. Corner ordering for simplex3 is the standard 6-way comparison ladder; the exact ladder (i>=j, j>=k, i>=k branches) is fixed in code and must not be reordered.

**Cost:** 3 hashes (2D) / 4 hashes (3D). Cheaper than Perlin in 3D and isotropic.

### 3.5 Worley / cellular noise

```js
// Returns { f1, f2, id1, ox1, oy1, oz1 }
// f1, f2 are Euclidean distances in cell units (NOT squared) to the nearest and
// second-nearest feature points. Range of f1: [0, 1.7320508]. id1 = u32 hash of
// the owning cell, used for per-cell variation.
worley2(seed, x, y, jitter)    // searches 3x3 cells
worley3(seed, x, y, z, jitter) // searches 3x3x3 cells
```

Feature point of cell `(ci, cj[, ck])` is `ci + jitter * u01(h)` per axis, using three decorrelated hashes `h2(seed, ci, cj)`, `h2(seed^0x51ED270B, ci, cj)`, `h2(seed^0x2F1B3C7D, ci, cj)`. `jitter` default `1.0`; values below `0.7` are used where a regular lattice feel is wanted (crystal fields).

Derived quantities used in this spec:

| Derived | Formula | Use |
|---------|---------|-----|
| `W_F1` | `f1` | bommie mounds (inverted), pebbles |
| `W_EDGE` | `f2 - f1` | tunnel networks, talus cracks, mud polygons |
| `W_CELL` | `u01(id1)` | per-cell categorical choice |
| `W_MOUND` | `max(0, 1 - f1 / R)` with `R` in cell units | radial mound falloff |

Correct 3x3(x3) search is mandatory; the 2x2 optimisation produces discontinuities and is banned.

### 3.6 Fractal combinators

All accept `(seed, x, y[, z], octaves, lacunarity, gain, freq0, amp0)` and iterate **octave 0 first, increasing frequency**, accumulating with `sum = sum + amp * value`. The accumulation order is part of the determinism contract.

| Combinator | Per-octave value | Range | Notes |
|------------|------------------|-------|-------|
| `fbm` | `base(p * f)` | approx `[-1,1]` after normalisation | normalised by dividing by `sum(amp_i)` |
| `billow` | `abs(base(p*f)) * 2 - 1` | `[-1,1]` | round, cumuliform lobes; used for dunes |
| `ridged` | see below | `[0,1]` | multifractal with weight feedback |
| `erosiveFbm` | see 3.7 | approx `[-1,1]` | derivative-damped |

Ridged multifractal (Musgrave form, binding):

```js
function ridged(seed, x, y, oct, lac, gain, offset, sharpness, freq0) {
  let f = freq0, amp = 1.0, weight = 1.0, sum = 0.0, norm = 0.0;
  for (let i = 0; i < oct; i++) {
    let n = gradNoise2(seed + i * 131, x * f, y * f);
    n = offset - (n < 0 ? -n : n);        // offset - |n|
    n = n * n;                             // sharpen
    n = n * weight;
    weight = n * sharpness;
    if (weight > 1.0) weight = 1.0;
    if (weight < 0.0) weight = 0.0;
    sum += n * amp;
    norm += amp;
    amp *= gain; f *= lac;
  }
  return sum / norm;                       // [0, offset^2] -> practically [0,1]
}
```

Defaults where unspecified: `offset = 1.0`, `sharpness = 2.0`.

### 3.7 Erosive (derivative-damped) fBm

This is the cheap runtime approximation of fluvial incision. Higher octaves are attenuated where the accumulated slope is high, which produces flat valley floors and sharp ridge crests without an iterative solver.

```js
function erosiveFbm(seed, x, y, oct, lac, gain, freq0, kE) {
  let f = freq0, amp = 1.0, sum = 0.0, norm = 0.0;
  let dsx = 0.0, dsy = 0.0;
  for (let i = 0; i < oct; i++) {
    const g = gradNoise2d(seed + i * 977, x * f, y * f);
    dsx += g.dx * f;  dsy += g.dy * f;
    const damp = 1.0 / (1.0 + kE * (dsx * dsx + dsy * dsy));
    sum  += amp * g.n * damp;
    norm += amp;
    amp *= gain; f *= lac;
  }
  return sum / norm;
}
```

`kE` is the erosion strength; `kE = 0` degenerates to plain fBm. Values used: `kE = 1400.0` for the mid-detail layer (frequencies around 1/380 m), `kE = 260.0` for the island layer. Note `kE` must be retuned whenever `freq0` changes because `dsx` carries the frequency factor.

### 3.8 Domain warp

```js
// warpAmp in metres; warp frequency in cycles/metre.
function warp2(seed, x, y, amp, freq, oct) {
  const qx = fbm(seed ^ 0x1D3F, x, y, oct, 2.0, 0.5, freq, 1.0);
  const qy = fbm(seed ^ 0x77A5, x + 137.31, y - 91.77, oct, 2.0, 0.5, freq, 1.0);
  return { x: x + amp * qx, y: y + amp * qy };
}
```

The constant offsets `137.31` / `-91.77` decorrelate the two channels without a second seed pass; they are binding literals.

Second-order warp (`warp2` applied to its own output) is used only for the continental layer, with the amplitudes given in Table 4.2.

### 3.9 Complete noise-usage registry

Every noise evaluation in the shipping generator appears in this table. Adding a usage means adding a row.

| ID | Consumer | Kernel | Seed salt | freq0 (1/m) | Oct | Lac | Gain | Amp (m) | Extra |
|----|----------|--------|-----------|-------------|-----|-----|------|---------|-------|
| N01 | Continental warp pass 1 | simplex2 fbm | MACRO_WARP | 1/6200 | 3 | 2.07 | 0.50 | 420 (warp) | - |
| N02 | Continental warp pass 2 | simplex2 fbm | MACRO_WARP^0x55 | 1/2100 | 2 | 2.11 | 0.48 | 130 (warp) | - |
| N03 | Rim radius modulation | fbm on azimuth | RIM_AZ | 1.30 cyc/rad | 4 | 2.00 | 0.55 | 330 (radial) | 1D, periodic |
| N04 | Rim crest height mod | fbm on azimuth | RIM_AZ^0x9 | 0.85 cyc/rad | 3 | 2.00 | 0.50 | 118 | 1D, periodic |
| N05 | Basin undulation | simplex2 fbm | BASIN | 1/1600 | 5 | 2.03 | 0.50 | 46.0 | - |
| N06 | Ridged spurs | ridged | RIDGE | 1/900 | 6 | 2.14 | 0.52 | 78.0 | offset 1.0, sharp 2.0 |
| N07 | Erosive mid detail | erosiveFbm | EROSIVE | 1/380 | 7 | 2.02 | 0.49 | 34.0 | kE 1400 |
| N08 | Dunes / ripples | billow | DUNE | 1/62 | 3 | 2.30 | 0.42 | 2.40 | anisotropic 3.2:1 |
| N09 | Reef bommies | worley2 mound | BOMMIE | cell 34 m | 1 | - | - | 6.50 | jitter 0.92, R 0.62 |
| N10 | Talus / scree | worley2 edge | TALUS | cell 9 m | 1 | - | - | 1.60 | jitter 1.0 |
| N11 | Micro relief | valueNoise2 fbm | MICRO | 1/11 | 3 | 2.17 | 0.45 | 0.55 | - |
| N12 | Island ridged relief | ridged | ISLAND | 1/210 | 5 | 2.05 | 0.50 | 22.0 | offset 1.0 |
| N13 | Island erosive | erosiveFbm | ISLAND^0x3 | 1/95 | 5 | 2.00 | 0.50 | 7.5 | kE 260 |
| N14 | Canyon centreline jitter | fbm 1D | CANYON | 1/900 | 3 | 2.0 | 0.5 | 180 (lateral) | - |
| N15 | Canyon width mod | fbm 1D | CANYON^0x7 | 1/420 | 2 | 2.0 | 0.5 | 0.35 (factor) | - |
| N16 | Trench centreline jitter | fbm 1D | TRENCH | 1/2400 | 3 | 2.0 | 0.5 | 340 (lateral) | - |
| N17 | Trench wall terraces | ridged | TRENCH^0x5 | 1/160 | 4 | 2.0 | 0.5 | 26.0 | vertical-biased |
| N18 | Cave wall perturbation | simplex3 fbm | CAVE_DETAIL | 1/26 | 4 | 2.11 | 0.50 | 2.9 (SDF m) | - |
| N19 | Cave secondary tubes | worley3 edge | CAVE_DETAIL^0x11 | cell 42 m | 1 | - | - | - | jitter 1.0, thresh 0.14 |
| N20 | Chamber wall bumps | simplex3 fbm | CAVE_CHAMBER | 1/8.5 | 3 | 2.0 | 0.5 | 0.85 | - |
| N21 | Overhang displacement | simplex3 fbm | OVERHANG | 1/48 | 4 | 2.06 | 0.50 | 14.0 | vertical mask |
| N22 | Biome boundary jitter | simplex2 fbm | BIOME_JITTER | 1/340 | 3 | 2.0 | 0.5 | 1.0 (unit) | - |
| N23 | Sediment thickness | simplex2 fbm | BASIN^0x2B | 1/220 | 4 | 2.0 | 0.5 | 1.0 (unit) | - |
| N24 | Ore vein field | simplex3 fbm | ORE | 1/74 | 3 | 2.19 | 0.50 | 1.0 (unit) | thresh per ore |
| N25 | Scatter density modulation | simplex2 fbm | SCATTER_BASE+cat | 1/58 | 2 | 2.0 | 0.5 | 1.0 (unit) | - |
| N26 | Detail normal (GPU only) | simplex3 fbm WGSL | derived | 1/1.4 | 4 | 2.0 | 0.5 | n/a | NON-AUTHORITATIVE |
| N27 | Splat break-up (GPU only) | worley2 WGSL | derived | cell 3.1 m | 1 | - | - | n/a | NON-AUTHORITATIVE |

Anisotropy for N08 is applied by pre-scaling the sample coordinate: `(x*cos(a) + z*sin(a)) * 1.0, (-x*sin(a) + z*cos(a)) * 3.2` where `a` is the local dune orientation from N05's gradient. Uses `sw_sin`/`sw_cos`.

---

## 4. MACRO BATHYMETRY: CRATER, SHELF BREAK, CANYON, TRENCH

The world is the flooded impact structure of an ancient bolide. The starting island is the **central peak** of that crater. This is the single geological idea that makes the radial layout read as natural rather than arbitrary, and it is why everything is arranged in rings.

### 4.1 Radial profile `P(r)`

`P(r)` is a **monotone cubic Hermite** (Fritsch-Carlson tangent limiting, so no overshoot between control points) through the following control points. Fritsch-Carlson uses only `+ - * / min max abs` and is therefore determinism-safe.

**Table 4.1 - Radial bathymetric control points (binding)**

| i | r (m) | y (m) | Feature |
|---|-------|-------|---------|
| 0 | 0 | +46.0 | Island summit (central peak) |
| 1 | 110 | +27.5 | Upper slope |
| 2 | 220 | +6.0 | Lower slope |
| 3 | 300 | -1.0 | Waterline ring / beach |
| 4 | 460 | -16.0 | Shallow apron |
| 5 | 700 | -38.0 | Reef flat |
| 6 | 980 | -62.0 | Outer reef |
| 7 | 1250 | -88.0 | Kelp terrace |
| 8 | 1520 | -128.0 | Terrace edge |
| 9 | 1700 | -196.0 | **Shelf break lip** |
| 10 | 1900 | -352.0 | Shelf break wall (35.6 deg mean) |
| 11 | 2150 | -516.0 | Wall base |
| 12 | 2600 | -664.0 | Upper basin |
| 13 | 3200 | -782.0 | Mid basin |
| 14 | 3800 | -838.0 | Lower basin |
| 15 | 4200 | -862.0 | **Crater basin floor (deepest of basin)** |
| 16 | 4600 | -742.0 | Inner rim slope |
| 17 | 5000 | -404.0 | Inner rim steep (40.3 deg) |
| 18 | 5220 | -288.0 | **Crater rim crest** |
| 19 | 5520 | -432.0 | Outer rim shoulder |
| 20 | 6000 | -910.0 | Outer slope |
| 21 | 6600 | -1480.0 | Lower outer slope |
| 22 | 7200 | -1846.0 | Apron |
| 23 | 7800 | -1978.0 | Abyssal plain edge |
| 24 | 8600 | -2090.0 | Abyssal plain |
| 25 | 12000 | -2140.0 | Abyssal plain (corner coverage) |

`P(r)` for `r > 12000` returns `-2140.0`. `P(r)` for `r < 0` is undefined (never called).

### 4.2 Continental shaping function `Cmacro(x, z)`

```
// Step 1: second-order domain warp (N01 then N02)
w1 = warp2(SEED_MACRO_WARP, x, z, 420.0, 1/6200, 3)
w2 = warp2(SEED_MACRO_WARP^0x55, w1.x, w1.y, 130.0, 1/2100, 2)
wx = w2.x ; wz = w2.y

// Step 2: warped polar coordinates
rw    = sqrt(wx*wx + wz*wz)
theta = sw_atan2(wx, -wz)               // heading convention: 0 = north

// Step 3: crater rim azimuthal modulation (N03, N04)
rimDR   = 330.0 * fbm1(SEED_RIM_AZ,    theta * 1.30, 4, 2.0, 0.55)
rimDY   = 118.0 * fbm1(SEED_RIM_AZ^0x9, theta * 0.85, 3, 2.0, 0.50)

// fbm1 is periodic in theta with period 2*PI: it evaluates gradNoise2 on the
// unit circle (cos(theta*k), sin(theta*k)) so it wraps exactly. Uses sw_sin/sw_cos.

// Step 4: apply rim radius shift only in the rim band, blended smoothly
rimBand = smoothband(rw, 3900, 4400, 6100, 6600)   // 0 outside, 1 in [4400,6100]
rEff    = rw - rimDR * rimBand

// Step 5: base profile
h = P(rEff) + rimDY * rimBand

// Step 6: rim breach (the trench cuts the rim open). azTrench = 2.0595 rad (118 deg)
dAz     = angDiff(theta, 2.0595)                    // wrapped to [-PI, PI]
breach  = smoothstep(0.2443, 0.0873, abs(dAz))      // 1 inside +/-5 deg, 0 beyond 14 deg
h       = h - breach * rimBand * 620.0

return h
```

`smoothband(v, a0, a1, b1, b0)` = `smoothstep(a0,a1,v) * (1 - smoothstep(b1,b0,v))`.
`smoothstep(e0, e1, v)` is the standard Hermite `t*t*(3-2t)` with `t = clamp((v-e0)/(e1-e0), 0, 1)`; it uses only arithmetic and is safe.

**Table 4.2 - Macro shaping parameters**

| Parameter | Value | Note |
|-----------|-------|------|
| Warp amp 1 / freq | 420 m / 1 per 6200 m | Breaks radial symmetry at the largest scale |
| Warp amp 2 / freq | 130 m / 1 per 2100 m | Adds lobed embayments to the reef |
| Rim band | 3900 / 4400 / 6100 / 6600 m | Where azimuthal rim modulation applies |
| Rim radius modulation | +/- 330 m | Rim crest wanders between r=4890 and r=5550 |
| Rim height modulation | +/- 118 m | Crest varies between -406 and -170 m |
| Trench azimuth | 2.0595 rad (118.0 deg) | Rim breach centre |
| Breach half-angle | 0.0873 rad (5 deg) full, 0.2443 rad (14 deg) feather | |
| Breach depth | 620 m | Rim is fully cut through inside +/-5 deg |

### 4.3 Canyon carve (`CANYON`)

A single sinuous submarine canyon runs from the reef flat down through the shelf break into the crater basin, plus 3 tributaries. This is the intended early-game "descent corridor": it lets the player reach -700 m without crossing open slope.

**Table 4.3 - Canyon centreline control points (polar, before jitter)**

| k | r (m) | azimuth (deg) | floor offset below local terrain (m) | half-width at rim (m) |
|---|-------|---------------|--------------------------------------|------------------------|
| 0 | 760 | 292.0 | 12 | 45 |
| 1 | 1180 | 296.5 | 38 | 78 |
| 2 | 1620 | 289.0 | 74 | 112 |
| 3 | 2050 | 283.5 | 128 | 150 |
| 4 | 2700 | 279.0 | 176 | 168 |
| 5 | 3500 | 276.5 | 205 | 172 |
| 6 | 4400 | 274.0 | 152 | 140 |

The centreline is a Catmull-Rom spline (tension 0.5) through these points converted to Cartesian, resampled to 1-metre arclength into a flat `Float64Array` of length 2N once per world (about 4200 samples), then laterally jittered by N14 (`+/-180 m` perpendicular). The resampled polyline is cached in a module-level array; **it is generated by a specified deterministic routine, not stored as an asset.**

Carve profile at a point `p` with signed distance `s = distToPolyline(p.xz)` and interpolated `depth D` and `half-width W` (both modulated by N15: `W *= (1 + 0.35 * n)`):

```
u = clamp(s / W, 0, 1)
// V-with-rounded-floor profile
profile = 1 - u*u*(3 - 2*u)          // smoothstep falloff, 1 at centre
floorFlat = smoothstep(0.34, 0.0, u) // flat floor in the inner third
carve = D * (0.78 * profile + 0.22 * floorFlat)
h = h - carve
```

Tributaries: 3 additional canyons, each seeded from `hash_u32(SEED_CANYON ^ (0xB1 + k))`, joining the trunk at spline parameters `t = 0.28, 0.51, 0.72`, with `D` and `W` scaled to `0.45` of the trunk value at the junction and tapering to zero over 620 m upslope. Tributary azimuths are `trunkAz +/- (0.52 + 0.31 * u01(...))` rad.

### 4.4 Trench carve (`TRENCH`)

The trench is the world's deepest and most dread-laden feature. It is a straight-ish graben running outward from the crater basin at azimuth 118 deg, breaching the rim (see 4.2 step 6) and continuing past the abyssal plain to the world corner.

**Table 4.4 - Trench parameters**

| Parameter | Value |
|-----------|-------|
| Start radius | 3000 m (floor merges with basin at -862 m) |
| Rim-breach radius | 4400 to 6100 m |
| Deepest point radius | 7400 m |
| Deepest floor y | -3350 m |
| End radius | `WORLD_R_MAX` (floor -3210 m) |
| Base azimuth | 2.0595 rad (118 deg) |
| Centreline jitter | N16, `+/-340 m` lateral |
| Half-width at rim | 410 m at r=3000, 640 m at r=5200, 820 m at r=7400, 700 m at corner |
| Half-width at floor | 70 m at r=3000, 140 m at r=7400 |
| Wall angle | 52 to 68 deg (emergent from the profile) |
| Terrace count | 3 to 5 per wall, from N17 |

Floor depth profile along the trench (monotone Hermite over arclength-from-start `t` in metres):

| t (m) | floor y (m) |
|-------|-------------|
| 0 | -862 |
| 500 | -1180 |
| 1400 | -1930 |
| 2400 | -2560 |
| 3400 | -3010 |
| 4400 | -3350 |
| 6000 | -3290 |
| 8600 | -3210 |

Carve is a **hard minimum**, not a subtraction, so the trench floor is absolute:

```
sT = distToTrenchCentreline(p.xz)
Wt = trenchHalfWidth(t)
Ft = trenchFloorY(t)
uT = clamp(sT / Wt, 0, 1)
// Wall shape: steep upper, near-vertical mid, talus toe.
wall = Ft + (localH - Ft) * (uT*uT*uT*(uT*(uT*6 - 15) + 10))   // quintic
// Terraces (N17) cut into the wall
wall = wall - 26.0 * ridged(...) * smoothband(uT, 0.10, 0.25, 0.85, 0.98)
h = min(h, wall)
```

`localH` is the pre-trench height at that point. Because `min` is used, the trench never *raises* terrain, so the crater rim and abyssal plain remain intact right up to the trench lip.

### 4.5 Shelf break

The shelf break is not a separate carve: it is control points 9-11 of `P(r)` combined with the ridged spur layer L4, which is masked to `slope > 18 deg`. The result is a wall of vertical buttresses and gullies. Two hard requirements:

- The break must present a clearly readable **lip** at approximately -196 m over at least 70% of its azimuthal extent, so the player perceives "the edge of the world" from above.
- Mean wall slope must be in `[32, 42] deg` so a diving vessel can follow it without colliding, and a swimming player cannot trivially climb it.

Validation: a bake-time checker samples the break band on a 8 m grid, computes slope, and asserts `p05 >= 24 deg`, `mean in [32,42] deg`, `p95 <= 61 deg`. Failure aborts world creation with a diagnostic (this can only happen if the tables above are edited).

---

## 5. THE HEIGHTFIELD LAYER STACK

`H(x, z) -> y` is the authoritative terrain surface function. It is pure, and (after the erosion bake, section 6) depends only on `worldSeed`, the two baked erosion delta maps, and the mining edit list.

**Table 5.1 - Layer stack (evaluated top to bottom, in this exact order)**

| L | Name | Contribution | Mask | Amp (m) |
|---|------|--------------|------|---------|
| L0 | MACRO | `h = Cmacro(x,z)` (sec 4.2) | - | see 4.1 |
| L1 | BASIN_UNDULATION | `+ A * N05` | `basinMask` | 46.0 |
| L2 | RIDGE_SPURS | `+ A * (N06 - 0.32)` | `slopeMask * (1 - sedMask)` | 78.0 |
| L3 | EROSIVE_MID | `+ A * N07` | `1 - shallowFlatMask*0.55` | 34.0 |
| L4 | ISLAND_RELIEF | `+ 22.0*(N12-0.30) + 7.5*N13` | `islandMask` | 29.5 |
| L5 | CANYON | `- carve` (sec 4.3) | - | up to 205 |
| L6 | TRENCH | `min(h, wall)` (sec 4.4) | - | absolute |
| L7 | REEF_BOMMIES | `+ A * W_MOUND^1.6` | `reefMask` | 6.5 |
| L8 | DUNES | `+ A * N08` | `sedMask * flatMask` | 2.4 |
| L9 | TALUS | `- A * (1 - clamp(W_EDGE*3.4,0,1))` | `slopeMask` | 1.6 |
| L10 | BEACH_FLATTEN | see below | `abs(y) < 9` | - |
| L11 | MICRO | `+ A * N11` | `1 - underDuneMask*0.4` | 0.55 |
| L12 | EROSION_DELTA | `+ Efine(x,z) + Ecoarse(x,z)` | - | up to +/-38 |
| L13 | EDIT_DELTA | `+ sum of mining edit contributions` | - | up to -14 per edit |
| L14 | CLAMP | `h = clamp(h, Y_MIN, Y_MAX)` | - | - |

`A` denotes the amplitude column of the corresponding noise registry row.

### 5.1 Mask definitions (all in `[0,1]`, all pure)

```
d          = -h_prev                          // depth so far, using the height from L0..L3
slopeApprox= |dH/dx| , |dH/dz| via 4 m central difference of L0..L3 only (cheap, stable)
grad       = sqrt(gx*gx + gz*gz)              // metres per metre
slopeDeg   = atanApproxDeg(grad)

islandMask     = 1 - smoothstep(280, 640, r)                       // island local relief
basinMask      = smoothband(r, 2000, 2500, 4000, 4600)
reefMask       = smoothband(d, 2, 8, 58, 78) * (1 - smoothstep(0.36, 0.62, grad))
slopeMask      = smoothstep(0.32, 0.68, grad)                      // ~18 to 34 deg
flatMask       = 1 - smoothstep(0.09, 0.22, grad)                  // ~5 to 12 deg
sedMask        = flatMask * smoothstep(0.30, 0.58, N23) * smoothband(d, 40, 90, 2600, 3100)
shallowFlatMask= flatMask * (1 - smoothstep(160, 320, d))
underDuneMask  = sedMask * flatMask
```

`atanApproxDeg` is only used for authoring-time thresholds expressed in degrees and always via the tangent, never the angle, at runtime: all runtime thresholds above are expressed as **tangent values** so no arctangent is required.

### 5.2 Beach flattening (L10)

The starting beach must be walkable, gentle, and free of noise spikes that could trap the player. Within `|h| < 9 m` and `r < 900 m`:

```
t = 1 - clamp(abs(h) / 9.0, 0, 1)          // 1 at the waterline
t = t * t * (3 - 2*t)
target = h * 0.34                           // pull toward a 0.34x compressed profile
h = h + (target - h) * 0.72 * t * islandBeachMask
// islandBeachMask = 1 - smoothstep(700, 900, r)
```

Result: the shoreline gradient is 0.045 to 0.11 (2.6 to 6.3 deg) over a band about 26 m wide, and the sand extends to about -3.0 m before the reef starts. Additionally, within `r < 320 m`, all layers L2/L3/L9 amplitudes are scaled by `0.55` so the island itself is rolling rather than jagged.

### 5.3 Guaranteed safe-start invariants

The bake-time validator asserts all of these; failure aborts world creation.

| Invariant | Requirement |
|-----------|-------------|
| Spawn platform | A contiguous region of at least 900 m^2 with `y in [+2.5, +6.0]` and `grad < 0.18` exists within 60 m of `(0, 0)` |
| Beach access | A walkable path (grad < 0.45 everywhere along it) exists from spawn to the waterline, length < 220 m |
| Vessel pad | A region of at least 400 m^2 with `grad < 0.09` and `y in [+1.8, +4.5]` exists within 90 m of spawn (the vessel's landing pad) |
| No cliffs in start zone | `max(grad) < 1.30` (52 deg) for `r < 240 m` |
| No caves in start zone | No cave capsule may come within 40 m of the surface for `r < 700 m` |
| Shallow floor | `H(x,z) > -70 m` for all `r < 900 m` |
| Water access depth | Depth at `r = 400 m` is between 8 and 22 m over at least 60% of azimuths |

If an invariant fails, the world creation routine perturbs `SEED_ISLAND` by `+1` and re-bakes the island region only (bounded to 6 attempts, then falls back to forcing the flatten strength in 5.2 to 0.95). The chosen island attempt index is persisted as part of the world record so the world remains reproducible.

### 5.4 Per-vertex material outputs

Alongside `y`, `H()` produces the material inputs consumed by section 05:

| Output | Type | Derivation |
|--------|------|------------|
| `biomeA` | u8 | Primary biome ID (Table 5.2) |
| `biomeB` | u8 | Secondary biome ID (nearest competing) |
| `blend` | u8 | 0..255 blend weight of B into A |
| `ao` | u8 | Bake-time ambient occlusion, 16 cone rays over a 24 m radius, quantised |
| `sediment` | u8 | Sediment thickness in `0.05 m` units, clamped at 12.75 m |
| `flags` | u8 | bit0 `SUPPRESS`, bit1 `SHORELINE`, bit2 `WET`, bit3 `VENT_HEAT`, bits4-7 reserved |

**Table 5.2 - Biome IDs (terrain-side; section 01 owns the authoritative descriptions)**

| ID | Name | Depth band | Slope (grad) | Dominant substrate |
|----|------|------------|--------------|--------------------|
| 0 | ISLAND_ROCK | B0 | > 0.45 | basalt |
| 1 | ISLAND_SAND | B0/B1 | < 0.20 | carbonate sand |
| 2 | ISLAND_SCRUB | B0 | < 0.45 | soil over basalt |
| 3 | SHALLOW_REEF | B1 | any | coral framework |
| 4 | SAND_FLAT | B1-B2 | < 0.18 | sand |
| 5 | KELP_TERRACE | B2 | < 0.55 | cobble + holdfast rock |
| 6 | ROCKY_SPUR | B2-B3 | > 0.55 | fractured basalt |
| 7 | SHELF_BREAK_WALL | B3-B4 | > 0.62 | bare rock, encrusted |
| 8 | SEDIMENT_BASIN | B5 | < 0.16 | fine ooze |
| 9 | THERMAL_VENT_FIELD | B5-B6 | any | sulfide chimneys |
| 10 | CRATER_RIM_REEF | B4 | < 0.70 | cold-water coral rubble |
| 11 | CALCITE_FIELD | B5 | < 0.30 | calcareous plates |
| 12 | GLASS_SPONGE_SLOPE | B6 | 0.25-0.85 | siliceous spicule mat |
| 13 | TRENCH_WALL | B7-B8 | > 0.80 | dark exposed rock |
| 14 | TRENCH_FLOOR | B8 | < 0.20 | black ooze |
| 15 | ABYSSAL_PLAIN | B7 | < 0.12 | pelagic clay |
| 16 | CAVE_INTERIOR | any | any | dry rock (volumetric only) |
| 17 | LUMINOUS_GROTTO | B4-B8 | any | bioluminescent crust (volumetric only) |

Classification is a scored vote: each biome has a target `(depthRange, slopeRange, radiusRange, substratePref)` and scores `score_i = wD*fitDepth + wS*fitSlope + wR*fitRadius + 0.22 * N22_i` where `N22_i` is the boundary-jitter noise offset per biome. `wD = 0.44, wS = 0.30, wR = 0.26`. `biomeA` = argmax, `biomeB` = second, `blend = clamp((score_B / score_A) * 255, 0, 200)`.

---

## 6. BAKE-TIME EROSION

Erosion is **not** evaluated at runtime. It is baked once at world creation into two delta maps, stored in IndexedDB, and read back as a bilinear lookup by `H()` (layer L12). This is what keeps `H()` a pure, cheap function while still giving real drainage networks.

### 6.1 Delta map layout

| Map | Coverage | Resolution | Grid | Storage | Bytes |
|-----|----------|------------|------|---------|-------|
| `Efine` | central square `+/-2048 m` | 4.0 m | 1024 x 1024 | i16, scale 1/64 m (range +/-512 m) | 2,097,152 |
| `Ecoarse` | full world `+/-8192 m` | 16.0 m | 1024 x 1024 | i16, scale 1/32 m (range +/-1024 m) | 2,097,152 |

Total 4.19 MB, stored as two IndexedDB blobs plus a 4-byte FNV-1a hash each. `Efine` is applied with a smooth taper to zero over `1800..2048 m` from centre so the two maps do not double count; `Ecoarse` is computed from a version of the terrain that already includes `Efine` tapered in (two-pass bake, see 6.5).

Lookup (bilinear, clamped at edges):

```
E(x,z) = bilinear(Ecoarse, x, z) + tapFine(x,z) * bilinear(Efine, x, z)
tapFine = 1 - smoothstep(1800, 2048, max(|x|, |z|))
```

Bilinear interpolation of i16 in binary64 is exact and deterministic.

### 6.2 Hydraulic (droplet) erosion

Particle-based, applied to the **subaerial and shallow** portion only. Below -60 m, hydraulic erosion is physically wrong (no rain, no channelised runoff) and is replaced by the sediment drape of 6.4. The transition is a weight, not a cutoff.

**Table 6.1 - Droplet erosion parameters**

| Parameter | Fine grid | Coarse grid | Unit |
|-----------|-----------|-------------|------|
| Droplet count | 600,000 | 260,000 | droplets |
| Max lifetime | 64 | 48 | steps |
| Inertia | 0.055 | 0.070 | - |
| Sediment capacity factor | 3.20 | 3.60 | - |
| Min slope (capacity floor) | 0.012 | 0.020 | - |
| Deposition rate | 0.280 | 0.320 | per step |
| Erosion rate | 0.420 | 0.380 | per step |
| Evaporation rate | 0.0210 | 0.0260 | per step |
| Gravity | 9.81 | 9.81 | m/s^2 |
| Erosion brush radius | 3 | 2 | cells |
| Initial water | 1.0 | 1.0 | - |
| Initial speed | 1.0 | 1.0 | - |
| Max deposit per step | 0.55 | 0.70 | cells of height |

Droplet spawn positions are **not** random: droplet `k` spawns at

```
u = radicalInverse(k, 2)   // van der Corput base 2
v = radicalInverse(k, 3)   // base 3
px = u * (W - 1)
pz = v * (H - 1)
```
plus a `+/-0.5` cell jitter from `s11(h2(SEED_EROSION_SEED, k, 0))`. Halton sequences give better coverage than hashing alone and are exactly reproducible.

Per-step update (binding, matches the standard Beyer/Hans formulation):

```
(h, gx, gz) = bilinearHeightAndGradient(map, px, pz)
dirX = dirX*inertia - gx*(1 - inertia)
dirZ = dirZ*inertia - gz*(1 - inertia)
len  = sqrt(dirX*dirX + dirZ*dirZ)
if len > 1e-9: dirX /= len; dirZ /= len
else: break   // droplet stalls; do not respawn (determinism: fixed budget)
nx = px + dirX; nz = pz + dirZ
if out of bounds: break
newH = bilinearHeight(map, nx, nz)
dh   = newH - h
capacity = max(-dh, minSlope) * speed * water * capacityFactor
if sediment > capacity or dh > 0:
   amount = (dh > 0) ? min(dh, sediment) : (sediment - capacity) * depositRate
   depositBilinear(map, px, pz, amount); sediment -= amount
else:
   amount = min((capacity - sediment) * erodeRate, -dh)
   erodeBrush(map, px, pz, amount, brushRadius); sediment += amount
speed = sqrt(max(0, speed*speed + (-dh) * gravity))
water = water * (1 - evaporation)
px = nx; pz = nz
```

`erodeBrush` uses a precomputed weight kernel `w_ij = max(0, R - dist_ij)` normalised to sum 1, iterated in a fixed row-major order.

**Subaerial weighting.** Before erosion, the working grid stores `h`. A per-cell weight `hw = clamp((h + 60) / 90, 0, 1)` scales both erosion and deposition amounts. At `h >= +30 m`, `hw = 1`; at `h <= -60 m`, `hw = 0`. This concentrates fluvial incision on the island and the reef flat where it is visible, and leaves the deep basin to the drape pass.

### 6.3 Thermal (talus) erosion

Applied after hydraulic. Mass-conserving, 8-neighbour, Jacobi (all cells read the previous iteration's state - this makes it order-independent and trivially parallel across row bands).

**Table 6.2 - Thermal erosion parameters**

| Parameter | Value |
|-----------|-------|
| Iterations, fine grid | 12 |
| Iterations, coarse grid | 8 |
| Talus tangent, rock (`sediment < 0.4 m`) | 0.7813 (38.0 deg) |
| Talus tangent, sand (`sediment >= 0.4 m`) | 0.6249 (32.0 deg) |
| Talus tangent, submerged sediment (`d > 60 m`) | 0.3640 (20.0 deg) |
| Transfer rate | 0.42 |
| Diagonal weight | `1 / sqrt(2)` = 0.7071067811865476 |

```
for each cell c:
  totalExcess = 0
  for each of 8 neighbours n:
     dh = h[c] - h[n]
     eff = dh / (cellSize * (diagonal ? SQRT2 : 1))
     if eff > talus(c): excess[n] = dh - talus(c)*cellSize*(diag?SQRT2:1); totalExcess += excess[n]
  if totalExcess > 0:
     move = 0.42 * 0.5 * (maxExcess)
     distribute `move` to neighbours proportionally to excess[n]
```

Neighbour iteration order is fixed: `(-1,-1), (0,-1), (1,-1), (-1,0), (1,0), (-1,1), (0,1), (1,1)`.

### 6.4 Marine sediment drape

Replaces hydraulic erosion below -60 m. Models pelagic rain of fine material that accumulates in hollows and slides off slopes. This is what makes the crater basin floor read as soft ooze and the trench walls as bare rock.

**Table 6.3 - Drape parameters**

| Parameter | Value |
|-----------|-------|
| Iterations | 24 (fine), 18 (coarse) |
| Deposition per iteration | `0.42 m * marineWeight * (1 - N23mask)` |
| `marineWeight` | `smoothstep(60, 140, d)` |
| Repose tangent (fine ooze) | 0.1051 (6.0 deg) |
| Slide relaxation rate | 0.55 |
| Max accumulated thickness | 11.0 m (basin), 3.2 m (rim), 18.0 m (trench floor) |
| Compaction | thickness scaled by `1 / (1 + 0.021 * d/100)` |

The accumulated thickness per cell is retained as the `sediment` channel and written into the vertex record (5.4). It drives: substrate material selection, footstep/impact audio (section 09), digging yield (section 07), and burrowing creature spawn (section 06).

Additionally, a **slump** pass: after the drape, any cell whose sediment thickness exceeds `9.0 m` on a slope steeper than `0.30` triggers a downslope debris flow that travels up to 60 cells, depositing along the way with an exponential profile `exp(-t/22)` (via `sw_exp`). Maximum 4000 slumps, chosen as the 4000 highest-`(thickness * slope)` cells in a deterministic sort (ties broken by linear cell index).

### 6.5 Bake pipeline and budget

| Step | Grid | Workers | Est. time (M-series) | Est. time (weak iGPU laptop) |
|------|------|---------|----------------------|------------------------------|
| 1. Sample base `H` (L0..L11) | 1024^2 coarse | 4 (row bands) | 0.9 s | 2.6 s |
| 2. Hydraulic coarse | 1024^2 | 1 (order-fixed) | 1.4 s | 4.1 s |
| 3. Thermal coarse | 1024^2 x8 | 4 (Jacobi bands) | 0.5 s | 1.4 s |
| 4. Drape coarse | 1024^2 x18 | 4 | 0.7 s | 2.0 s |
| 5. Write `Ecoarse` | - | 1 | 0.05 s | 0.15 s |
| 6. Sample base `H` + `Ecoarse` | 1024^2 fine | 4 | 0.8 s | 2.3 s |
| 7. Hydraulic fine | 1024^2 | 1 | 3.2 s | 9.4 s |
| 8. Thermal fine x12 | 1024^2 | 4 | 0.7 s | 2.1 s |
| 9. Drape fine x24 | 1024^2 | 4 | 0.9 s | 2.6 s |
| 10. Slump + validate | - | 2 | 0.4 s | 1.1 s |
| 11. Write `Efine` + probes | - | 1 | 0.05 s | 0.15 s |
| **Total** | | | **9.6 s** | **28.0 s** |

The bake runs behind the world-creation screen with a progress bar and a live top-down preview of the coarse map (rendered from the worker's output). Steps 2 and 7 are single-worker because the droplet loop order is part of the determinism contract; they dominate the budget and that is accepted. If the total exceeds 45 s, the loader offers a "reduced erosion" mode (droplet counts halved) which is recorded in the world record and changes the world - it is a distinct world variant, not a quality setting.

---

## 7. CHUNKS, LOD, AND THE TERRAIN DRAW

### 7.1 Quadtree geometry

| Symbol | Value |
|--------|-------|
| `LEAF_SIZE` | 16.0 m (LOD 0 node footprint) |
| `GRID_N` | 33 (vertices per side, drawn) |
| `GRID_PAD` | 35 (vertices per side, stored; 1-ring border for seamless normals) |
| `LOD_LEVELS` | 10 (LOD 0 .. LOD 9) |
| Node size at LOD `L` | `16 * 2^L` m -> 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192 |
| Vertex spacing at LOD `L` | `0.5 * 2^L` m -> 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256 |
| Root | 4 nodes at LOD 9, covering the 16384 m world |
| Triangles per node | 2048 (surface) + 256 (skirt) = **2304** |
| Indices per node | 6912 (shared, u16) |

Every node has identical topology, which is the key enabling decision: **the entire terrain is drawn with one `drawIndexed(6912, visibleNodeCount, 0, 0, 0)` call** (plus one more for the alpha-masked batch). No per-chunk draw calls, no multi-draw-indirect extension needed.

### 7.2 LOD selection

```
// Evaluated on the CPU each frame during the quadtree descent.
// nodeSize in metres; dist = distance from camera to the node AABB (0 if inside).
split if (dist < K_LOD * nodeSize) and (node.level > 0) and (nodeSize > LEAF_SIZE)
```

**Table 7.1 - Quality tiers**

| Tier | `K_LOD` | Terrain view dist (m) | Max visible nodes | Terrain tris (typ / max) | Resident node pool | Target |
|------|---------|------------------------|-------------------|--------------------------|--------------------|--------|
| Ultra | 3.00 | 6000 | 384 | 620k / 885k | 3072 | 60 fps, M3 Pro+ / RTX 3060+ |
| High | 2.40 | 4500 | 256 | 410k / 590k | 2048 | 60 fps, M1/M2 |
| Medium | 1.90 | 3000 | 168 | 265k / 387k | 1280 | 45-60 fps, Iris Xe |
| Low | 1.50 | 1800 | 96 | 150k / 221k | 768 | 30 fps, weak iGPU |

**Underwater clamp.** Because water extinction (section 03) makes distant terrain invisible, when the camera is below `y = -2 m` the terrain view distance is additionally clamped to `min(tierDist, 1.15 * fogFarDistance)` where `fogFarDistance` is supplied by section 03 as the distance at which transmittance falls below 0.008. In the deep this drops the visible node count by 55-80%, which is precisely the budget headroom that pays for volumetric caves and dense bioluminescent scatter.

### 7.3 Crack prevention: edge stitching + geomorph + skirt

Three mechanisms, all required.

**(a) Edge stitching.** The chunk descriptor carries a 8-bit `neighborCoarser` mask: 2 bits per edge (N, E, S, W) encoding how many LOD levels coarser the neighbour is (0..3; clamped, since the quadtree is 2:1-balanced so only 0 or 1 occurs in practice - the extra bits exist for the diagonal degenerate case at world edges). In the vertex shader, for a border vertex on edge `e` with coarser neighbour by `k` levels, and border index `i`:

```wgsl
let step = 1u << k;              // 2 for one level coarser
let m = i % step;
if (m != 0u) {
  let i0 = i - m;
  let i1 = i0 + step;
  let t  = f32(m) / f32(step);
  h = mix(hEdge[i0], hEdge[i1], t);   // read from the same padded row
}
```

Because the coarse neighbour's vertices coincide exactly with the fine chunk's even-indexed border vertices (the height function is sampled on a shared world-space lattice), this produces an exact match with zero gap.

**(b) Geomorphing.** To kill popping at LOD transitions, each node computes a morph factor from camera distance:

```
morphStart = K_LOD * nodeSize * 0.72
morphEnd   = K_LOD * nodeSize * 0.97
mk = clamp((dist - morphStart) / (morphEnd - morphStart), 0, 1)
```

`mk` is uploaded per node. In the vertex shader, odd-indexed vertices (in either axis) are lerped toward the average of their even neighbours by `mk`, so that by the time the node is replaced by its parent, its geometry is already identical to the parent's. Morphing operates on the padded grid so the border case is handled by the same code path as (a).

**(c) Skirts.** Belt and braces against float precision at extreme distances and against the one-frame gap during async node swap-in. The shared index buffer appends a ring of 128 quads around the border. Skirt vertices reuse the border vertex's XZ and height, offset downward by `skirtDrop = 2.5 * cellSize` (i.e. 1.25 m at LOD0, 640 m at LOD9). Skirt vertices are flagged by index range (`vertexIndex >= 1225`) and shaded with the border vertex's material, with normals forced to the horizontal outward direction.

### 7.4 GPU data layout

**Chunk descriptor - 48 bytes, `std430`-compatible, stored in a `storage` buffer of `MAX_NODES` entries:**

| Offset | Type | Field | Notes |
|--------|------|-------|-------|
| 0 | f32 | `originX` | world X of vertex (0,0) of the padded grid |
| 4 | f32 | `originZ` | world Z of vertex (0,0) |
| 8 | f32 | `cellSize` | metres between vertices |
| 12 | f32 | `heightBase` | min height of the node |
| 16 | f32 | `heightScale` | `(maxH - minH) / 65535.0` |
| 20 | u32 | `vertexOffset` | index of vertex 0 in the global vertex pool, in vertices |
| 24 | u32 | `packed0` | byte0 `lodLevel`, byte1 `neighborCoarser`, byte2 `flags`, byte3 `biomeHint` |
| 28 | f32 | `morphK` | 0..1 |
| 32 | f32 | `aabbMinY` | for CPU/GPU culling and shadow bounds |
| 36 | f32 | `aabbMaxY` | |
| 40 | u32 | `editRevision` | bumped when mining edits touch the node; used to invalidate |
| 44 | u32 | `_pad` | must be 0 |

`flags`: bit0 `HAS_SUPPRESS` (route to masked pipeline), bit1 `HAS_CAVE_OVERLAP`, bit2 `IS_SHORE`, bit3 `IS_START_ZONE`.

**Terrain vertex record - 8 bytes, packed as 2 x u32 in a global `storage` buffer:**

| Offset | Type | Field |
|--------|------|-------|
| 0 | u16 | `h_q` (height, dequantised as `heightBase + h_q * heightScale`) |
| 2 | u8 | `biomeA` |
| 3 | u8 | `biomeB` |
| 4 | u8 | `blend` |
| 5 | u8 | `ao` |
| 6 | u8 | `sediment` (0.05 m units) |
| 7 | u8 | `flags` |

Per node: `35 * 35 * 8 = 9800 B`. Pool sizes: Ultra `3072 * 9800 = 30.1 MB`; High 20.1 MB; Medium 12.5 MB; Low 7.5 MB. The pool is a fixed `GPUBuffer` with a free-list allocator (slot granularity = one node), so no reallocation ever occurs after init.

The vertex shader synthesises XZ from `vertexIndex` and reads Y and material from the pool. **There is no vertex buffer**; only the shared index buffer is bound. This makes per-node upload a single `writeBuffer` of 9800 B at a computed offset.

### 7.5 Normals

Normals are computed in the vertex shader from the padded grid by central difference:

```wgsl
let hL = fetchH(vi - 1); let hR = fetchH(vi + 1);
let hD = fetchH(vi - 35); let hU = fetchH(vi + 35);
let n = normalize(vec3f(hL - hR, 2.0 * cellSize, hD - hU));
```

The 1-ring pad is exactly what makes border normals match across chunks of the same LOD. Across LOD boundaries, the coarse chunk's normal is used on its own vertices; the fine chunk's stitched border vertices recompute a normal from the stitched heights. Residual normal discontinuity at LOD seams is under 3 degrees in practice and is further hidden by the detail-normal layer (section 05).

### 7.6 CPU culling and the per-frame node list

```
1. Descend quadtree from the 4 roots. At each node:
   - Reject if node AABB (xz extent x [aabbMinY, aabbMaxY]) fails the frustum test.
   - Reject if distance to AABB > terrainViewDistance.
   - Split per 7.2, else emit as a leaf of the cut.
2. Sort the emitted cut by (isMasked, lodLevel, distance) - stable, insertion sort
   (the list is <= 384 entries and nearly sorted frame to frame).
3. For each emitted node not resident: enqueue a generation job (section 11), and
   substitute its nearest resident ancestor for this frame.
4. Write the descriptor array (48 B x count) into a per-frame ring section of the
   descriptor buffer (triple-buffered, 3 x MAX_NODES x 48 B).
5. Two draws: opaque batch (flags bit0 == 0), masked batch (bit0 == 1).
```

Budget: step 1-2 must complete in under **0.35 ms** at Ultra. Measured target on an M1: 0.18 ms for 384 nodes.

Occlusion culling is **not** implemented for terrain in v1. Hierarchical-Z occlusion is listed as a post-ship optimisation; underwater it would gain little because fog already limits the set.

### 7.7 Shadow cascades interaction

Section 05 owns shadows, but the terrain node list is shared. Terrain contributes to the 3 sun cascades (Ultra/High) or 2 (Medium/Low) using a **separate, coarser** cut of the same quadtree with `K_LOD` scaled by `0.45` and no morphing. Shadow terrain triangles are budgeted at 180k (Ultra) / 60k (Low), and the shadow pass uses a stripped vertex shader (position only, no material fetch). Below `y = -180 m` sun shadows are disabled entirely (section 03 guarantees no direct sun contribution there), which is a large win in the deep.

---

## 8. VOLUMETRIC LAYER: CAVES, OVERHANGS, ARCHES

### 8.1 Why a separate layer

A heightfield cannot represent a tunnel, a roof, or an arch. Rather than making the whole world volumetric (which would cost 10-30x the memory and generation time), SUBWAVE uses a **sparse volumetric override**: 32 m cubes that exist only where they are needed, marching-cubed, stitched into the heightfield.

### 8.2 Cave voxel chunk (CVC)

| Symbol | Value |
|--------|-------|
| `CVC_SIZE` | 32.0 m cube |
| `CVC_RES` | 33 x 33 x 33 samples (1.0 m voxel) |
| Overlap skirt | 1.0 m on all 6 faces (field sampled over 34 m, so 35^3 = 42875 samples with the border) |
| Scratch field | `Float32Array(42875)` = 171.5 KB per worker, reused |
| Alignment | CVC origin is on the 32 m lattice, aligned to LOD1 nodes |
| Vertical range | CVCs exist from `y = +64` down to `y = -3584`, i.e. 114 layers |
| Address | `(cx, cy, cz)` integer, `cx,cz in [-256, 255]`, `cy in [-112, 1]` |

### 8.3 The density field

Signed field `F(p)`, **positive inside solid rock**, iso-surface at `F = 0`.

```
F(p) = min( Fterrain(p), Fcave(p) ) + Fedit(p)

Fterrain(p) = (H(p.x, p.z) - p.y) * KH  +  Fover(p)
   KH = 1.0   (units: metres; the field is a true vertical distance, not normalised)

Fover(p)  = overhangMask(p) * 14.0 * simplex3fbm(SEED_OVERHANG, p * (1/48), 4, 2.06, 0.50)

Fcave(p)  = min over relevant capsules/ellipsoids of ( sdCapsule(p, seg) )   // positive outside
            perturbed:  Fcave += 2.9 * simplex3fbm(SEED_CAVE_DETAIL, p*(1/26), 4, 2.11, 0.50)
            and cut by secondary tubes:
            Fcave = min(Fcave, (worley3edge(p/42) - 0.14) * 42.0 * tubeMask(p))

Fedit(p)  = sum over intersecting edits of ( -strength_i * max(0, 1 - |p - c_i| / R_i)^2 )
```

Note the sign conventions carefully: `Fterrain > 0` below the surface. `Fcave > 0` outside a tunnel. `min()` therefore means "solid only where it is both below the surface and outside every tunnel", which is exactly right. `Fedit` is negative (removes material).

**Marching cubes runs on `F` with iso = 0.** Because `Fterrain` uses the identical `H()` including erosion delta and all detail layers, a CVC that reaches the surface produces a mesh that agrees with the heightfield mesh to within the sampling difference (1.0 m voxel vs 0.5 m LOD0 grid). Section 8.7 closes that gap.

### 8.4 The cave worm graph

Connectivity is authored by a deterministic graph, not left to noise, because the player must be able to *navigate* caves and because we must guarantee no cave in the start zone.

**Macro cell:** 512 m in X and Z, 256 m in Y. Address `(mx, my, mz)`.

Generation for one macro cell (pure function of seed + address):

```
seedC = h3(SEED_CAVE_GRAPH, mx, my, mz)
density = biomeCaveDensity(cellCentre)          // Table 8.1, tunnels per cell
n = floor(density) + ((u01(hash_u32(seedC ^ 0xA5)) < frac(density)) ? 1 : 0)
n = min(n, 4)
for t in 0..n-1:
   s = hash_u32(seedC ^ (0x1000 + t))
   start = cellMin + (u01(hs0), u01(hs1), u01(hs2)) * cellSize
   dir   = unitFromHash(s ^ 0x77)                 // uniform on sphere via Marsaglia, hash-driven
   dir.y = dir.y * 0.45 - 0.12                    // bias toward horizontal, slightly downward
   dir   = normalize(dir)
   rBase = lerp(rMin, rMax, u01(s ^ 0x91))        // Table 8.1
   len   = lerp(240, 512, u01(s ^ 0xB3))          // metres; HARD CAP 512
   steps = floor(len / 12.0)                      // 12 m step
   emit tunnel(start, dir, rBase, steps, depth=0)
```

Tunnel integration, step `i` of tunnel `t`:

```
hs   = h3(seedC ^ (0x2000 + t), i, 0, 0)
turn = (s11(hs), s11(hs>>>8) * 0.55, s11(hs>>>16)) normalized * 0.11   // <= 0.11 rad/step
dir  = normalize(dir + turn)
// Soft turn-back keeps the tunnel inside cellAABB expanded by 512 m on each side
if outside expandedAABB: dir = normalize(dir + 0.34 * toward(cellCentre))
// Vertical bias: caves hug the terrain surface band
targetY = H(p.x, p.z) - lerp(18, 130, u01(hs ^ 0xC1))
dir.y  += clamp((targetY - p.y) * 0.004, -0.09, 0.09)
p_next  = p + dir * 12.0
radius  = rBase * (0.60 + 0.40 * (0.5 + 0.5*simplex3(SEED_CAVE_GRAPH^7, p*0.011)))
emit capsule(p, p_next, radius_prev, radius)
// Branch
if i > steps*0.25 and depth < 3 and u01(h3(seedC^0x3000, t, i, 1)) < 0.14:
   spawn child tunnel: dir rotated by +/-(0.5..1.1) rad about a hash axis,
   rBase *= 0.68, remaining steps *= 0.55, depth+1
// Chamber
if u01(h3(seedC^0x4000, t, i, 2)) < 0.09:
   emit ellipsoid(p, radii = rBase * (2.2, 1.4, 2.2) * lerp(1.0, 2.6, u01(...)))
   // clamped to [14, 48] m on the major axis
```

**Reach guarantee.** The hard length cap (512 m) plus the turn-back force guarantees every capsule of macro cell `C` lies inside `C` expanded by 512 m. Therefore a CVC only needs the graphs of the **3 x 3 x 3 = 27** macro cells surrounding it. That is at most `27 * 4 = 108` tunnels of at most `43` capsules = 4644 capsules, plus chambers. These are generated once per macro cell and cached in a worker-local LRU (capacity 64 macro cells, about 1.2 MB), so in practice the per-CVC cost is a spatial-hash query.

**Spatial binning.** Capsules from the 27 cells are binned into a 64 m uniform grid hash (open addressing, 4096 slots). A voxel sample queries the `2 x 2 x 2` bins covering its 1 m neighbourhood expanded by `maxRadius`, typically yielding 6-22 capsules. Cost per CVC: `42875 samples * ~14 capsule tests * ~9 flops` = about 5.4 MFLOP -> 2.1 to 3.4 ms in a worker. Acceptable.

**Table 8.1 - Cave placement rules per biome**

| Biome | Tunnels / 512 m cell | `rMin`-`rMax` (m) | Chamber prob | Depth band for entrances | Grotto (luminous) chance | Notes |
|-------|----------------------|-------------------|--------------|--------------------------|--------------------------|-------|
| 0 ISLAND_ROCK | 0.35 | 1.6 - 3.4 | 0.04 | above water only | 0.00 | Small lava tubes; **suppressed within r < 700 m** |
| 1 ISLAND_SAND | 0.00 | - | - | - | - | none |
| 2 ISLAND_SCRUB | 0.00 | - | - | - | - | none |
| 3 SHALLOW_REEF | 0.60 | 2.0 - 4.2 | 0.05 | 4 - 40 m | 0.02 | Swim-throughs, always short, always exit |
| 4 SAND_FLAT | 0.10 | 1.8 - 3.0 | 0.02 | 10 - 60 m | 0.00 | Rare collapsed pockets |
| 5 KELP_TERRACE | 0.85 | 2.4 - 5.0 | 0.07 | 30 - 100 m | 0.05 | Cobble tunnels |
| 6 ROCKY_SPUR | 1.45 | 2.8 - 6.4 | 0.09 | 40 - 190 m | 0.08 | Dense network |
| 7 SHELF_BREAK_WALL | 2.10 | 3.2 - 7.6 | 0.12 | 130 - 520 m | 0.14 | Wall caves; big vertical shafts |
| 8 SEDIMENT_BASIN | 0.40 | 2.6 - 5.2 | 0.06 | 520 - 900 m | 0.18 | Buried, few entrances |
| 9 THERMAL_VENT_FIELD | 1.20 | 2.2 - 5.8 | 0.10 | 560 - 1400 m | 0.34 | Heat-driven, chimney shafts |
| 10 CRATER_RIM_REEF | 1.60 | 3.0 - 6.8 | 0.11 | 200 - 520 m | 0.12 | Rim is riddled |
| 11 CALCITE_FIELD | 1.05 | 3.4 - 8.2 | 0.14 | 520 - 900 m | 0.26 | Dissolution caverns, large chambers |
| 12 GLASS_SPONGE_SLOPE | 1.35 | 2.8 - 6.0 | 0.10 | 900 - 1500 m | 0.30 | |
| 13 TRENCH_WALL | 2.40 | 3.6 - 9.0 | 0.16 | 1500 - 3400 m | 0.42 | Deepest, largest, most dangerous |
| 14 TRENCH_FLOOR | 0.55 | 3.0 - 7.0 | 0.09 | 2200 - 3400 m | 0.48 | |
| 15 ABYSSAL_PLAIN | 0.15 | 2.4 - 4.6 | 0.04 | 1500 - 2200 m | 0.20 | Very sparse; makes finds feel earned |

**Start-zone suppression (hard rule).** Any capsule whose closest approach to the world axis is `< 700 m` in XZ **and** whose top is within 40 m of the surface is deleted at graph-generation time. This is checked before binning, so it costs nothing at sample time. This enforces safe-start invariant 5.3.

### 8.5 Overhangs and arches

Overhangs are the same volumetric machinery with a different driver.

**Overhang mask.**

```
overhangMask(p) = slopeMask3D(p) * bandMask(p) * seedMask(p)
slopeMask3D = smoothstep(0.85, 1.55, grad(H) at p.xz)        // 40 to 57 deg
bandMask    = 1 - smoothstep(9.0, 26.0, |H(p.xz) - p.y|)      // only within 26 m of the surface
seedMask    = smoothstep(0.42, 0.66, 0.5 + 0.5*simplex2(SEED_OVERHANG, p.xz * (1/310)))
```

With `Fover` amplitude 14 m and a 1/48 m frequency, the displaced surface leans out by up to about 11 m horizontally. That is enough for genuine ledges, roofs over the shelf-break wall, and undercut coral shelves, without producing floating islands (the band mask ties the displacement to the surface).

**Arches.** Discrete, hand-shaped features, seeded rather than emergent, because good arches are rare in nature and reliably beautiful in games.

```
Arch macro cell: 1024 m in XZ. Per cell:
  s = h2(SEED_ARCH, ax, az)
  if u01(s) >= archProb(biome): none        // archProb: 0.00 island interior, 0.16 reef,
                                            // 0.22 spur, 0.30 rim, 0.26 canyon wall, 0.34 trench wall
  Place a torus-segment SDF:
     centre  c    (hash-chosen, snapped so both feet land on terrain with grad > 0.55)
     span    S    lerp(22, 78) m
     rise    R    lerp(0.42, 0.68) * S
     tubeRad T    lerp(0.10, 0.22) * S
     axis    A    horizontal, hash-chosen azimuth
  Fcave = min(Fcave, -sdArchSolid(p))   // ADDS solid: the arch is additive rock
```

Arch solid SDF: a circular arc of radius `R` in the vertical plane containing `A`, swept with an elliptical cross-section `(T, T*0.72)`, tapered to `1.35*T` at the feet, perturbed by `0.6 m` of `simplex3fbm(SEED_ARCH^0x3, p/9)`. The arch's own CVCs are force-activated. Maximum 3 arches per 1024 m cell (only 1 in v1; the field is reserved).

Arch validation: after MC, a connectivity check asserts the arch mesh is connected to the terrain mesh at both feet (flood fill on the triangle adjacency, both feet must be in the same component as a border vertex). If not, the arch is discarded for that world; this is recorded in the world record so it stays deterministic.

### 8.6 Marching cubes

- Standard 256-entry `edgeTable` (u16) and `triTable` (256 x 16 i8). **Generated at module init** by an included routine that expands the canonical 15 base cases under the 24 rotations and complement symmetry, then verified against a 32-bit checksum literal. No data files.
- **Ambiguity resolution:** the plain triTable is ambiguous on the 6 face-ambiguous configurations (3, 6, 7, 10, 12, 13). SUBWAVE implements the **asymptotic decider**: for each ambiguous face, evaluate the bilinear saddle value `S = (f00*f11 - f01*f10) / (f00 + f11 - f01 - f10)`; if `sign(S)` matches the diagonal-positive corners, use the connected variant, otherwise the separated one. Table entries for both variants are stored; the decider selects. This eliminates the pinholes that otherwise appear where two tunnels graze.
- **Vertex placement:** linear interpolation on the edge, `t = f0 / (f0 - f1)`, clamped to `[0.001, 0.999]` to avoid degenerate triangles.
- **Vertex welding:** an edge-keyed hash map `key = (cellIndex * 3 + edgeAxis)`, open addressing, capacity 65536. Guarantees a watertight indexed mesh.
- **Normals:** central difference of `F` with `h = 0.25 m` at the final vertex position (not at the cell corner), 6 extra field evaluations per vertex. This is the dominant cost of the volumetric pass and is worth it: gradient-of-field normals are far smoother than face-averaged normals on a 1 m voxel grid.
- **Material:** `CAVE_INTERIOR` (16) by default; `LUMINOUS_GROTTO` (17) where the grotto flag of the owning tunnel is set and the vertex normal has `n.y < 0.2` (walls and ceilings, not floors); the biome from `H()` where the vertex is within 1.5 m of the heightfield surface (so cave mouths blend into their surroundings).

**Table 8.2 - Volumetric budgets**

| Quantity | Ultra | High | Medium | Low |
|----------|-------|------|--------|-----|
| CVC view distance (m) | 220 | 160 | 120 | 90 |
| Max resident CVCs | 96 | 64 | 40 | 24 |
| Typical verts / CVC | 5,400 | 5,400 | 5,400 | 5,400 |
| Typical tris / CVC | 9,800 | 9,800 | 9,800 | 9,800 |
| Hard cap verts / CVC | 65,535 | 65,535 | 65,535 | 65,535 |
| Hard cap tris / CVC | 32,768 | 32,768 | 32,768 | 32,768 |
| Typical cave tris on screen | 190k | 130k | 78k | 44k |
| Vertex pool | 24 MB | 16 MB | 10 MB | 6 MB |
| Index pool | 12 MB | 8 MB | 5 MB | 3 MB |

**Cave vertex record - 12 bytes:**

| Offset | Type | Field | Encoding |
|--------|------|-------|----------|
| 0 | u16 | `px` | local, `[0, 34) m` mapped to `[0, 65535]`, 0.000519 m precision |
| 2 | u16 | `py` | as above |
| 4 | u16 | `pz` | as above |
| 6 | i16 | `nx` | octahedral normal, snorm16 |
| 8 | i16 | `ny` | octahedral normal, snorm16 |
| 10 | u8 | `mat` | material / biome ID |
| 11 | u8 | `ao` | MC-time AO, 12 hemisphere rays over 6 m |

Indices are u16 (the 65535 vertex cap is why). CVCs are drawn with one indexed instanced draw per CVC batch, using a per-CVC descriptor buffer (origin + scale + flags, 32 B) and `firstIndex`/`baseVertex` from an indirect args array. Cave meshes never LOD: at 220 m maximum draw distance and 9.8k tris each, they do not need it.

### 8.7 Stitching the volumetric layer to the heightfield

The problem: within a CVC that breaks the surface, both the heightfield mesh and the MC mesh describe the ground. Solution, three parts:

**(1) Surface suppression.** During CVC generation the worker computes a `surfaceModified` bitmask at 1 m over the CVC footprint (32 x 32 bits = 128 B): bit set where `|F(x, H(x,z), z)| > 0.15 m` (i.e. where the volumetric field disagrees with the heightfield at the heightfield surface), or where any capsule/ellipsoid/arch AABB projects. The mask is dilated by 2 cells (Chebyshev). It is uploaded to a `SUPPRESS_ATLAS` (a `r8uint` 2D array texture, 64 layers of 512x512, covering the active region at 1 m). Terrain vertices sample it during generation and set `flags` bit0. The fragment shader `discard`s where the interpolated suppress coverage exceeds 0.5.

Chunks with any suppressed vertex set descriptor `flags` bit0 and are drawn in the **masked batch** with a separate pipeline that has `discard`. All other terrain keeps early-Z. Typically fewer than 6 nodes per frame are masked.

**(2) Overlap skirt.** The CVC field is evaluated over 34 m (1 m past each face) and the MC mesh is generated over that full extent, then triangles fully outside the 32 m core are kept (not clipped). Adjacent CVCs therefore overlap by 1 m, and the CVC/heightfield boundary is covered by 1 m of overlap in every direction. Combined with the 2-cell dilated suppression, no crack is ever visible.

**(3) Border snap.** MC vertices lying within 0.6 m of the heightfield surface **and** within the outer 1.5 m ring of a `breaksSurface` CVC are snapped in Y onto the exact bilinear LOD0 heightfield value at their XZ. This forces exact agreement along the rim of every cave mouth, eliminating T-junction shimmer.

**CVC activation predicate** (a CVC is generated only if this passes):

```
active = capsuleBinNonEmpty(cvc)
      || archIntersects(cvc)
      || overhangSeedActive(cvc)          // seedMask > 0.42 anywhere in footprint AND band overlap
      || editCellHasEdits(cvc)
breaksSurface = (minH(footprint) <= cvc.yMax + 2.0) && (maxH(footprint) >= cvc.yMin - 2.0)
if (!breaksSurface) { clamp cvc field so Fterrain never crosses 0 inside it }
```

Roughly 3-7% of the volume near the surface passes `active`, and a far smaller fraction deeper. In the trench wall biome it reaches 22%, which is why the CVC view distance is short.

---

## 9. SCATTER

Scatter is every small instanced thing on the ground: flora, rocks, corals, sponges, fungi, crystals, ore nodes, debris. It is the single largest visual contributor and the single largest triangle consumer.

### 9.1 Placement algorithm (deterministic jittered grid with rejection)

No Poisson-disk solver, no stored point sets. Placement is a pure function of `(worldSeed, categoryId, cellX, cellZ, subIndex)`.

```
For category c with cell size Sc:
  for each cell (i, j) overlapping the query region:
     base = h2(SALT_SCATTER_BASE + c, i, j)
     // Local density: biome table * noise modulation * depth/slope filters
     cx = (i + 0.5) * Sc ; cz = (j + 0.5) * Sc
     dens = densityTable[biomeAt(cx,cz)][c]                       // instances per cell
     dens *= (0.55 + 0.45 * (0.5 + 0.5 * N25(cx, cz, c)))
     k    = floor(dens) + ((u01(base ^ 0x5A) < frac(dens)) ? 1 : 0)
     k    = min(k, MAX_PER_CELL[c])                                // 1..8
     for s in 0..k-1:
        hs = hash_u32(base ^ (0x9E37 * (s + 1)))
        px = i*Sc + u01(hs)             * Sc
        pz = j*Sc + u01(hs>>>11 | hs<<21) * Sc
        py = H(px, pz)
        (gx, gz) = gradH(px, pz)          // 1 m central difference
        // FILTERS -- all must pass; each is a cheap early-out
        if (-py) not in depthRange[c][biome]: continue
        if grad(gx,gz) not in slopeRange[c]:  continue
        if sediment(px,pz) not in sedRange[c]: continue
        if suppressed(px,pz):                 continue   // inside a cave mouth
        if u01(hs>>>19) > acceptProb[c]:      continue   // blue-noise thinning
        // Minimum-distance rejection against the same category, 3x3 cell neighbourhood,
        // resolved deterministically by (cellIndex, subIndex) lexicographic priority:
        if existsEarlierNeighbourWithin(minDist[c]): continue
        emit instance
```

The minimum-distance rejection makes the result **blue-noise-like** (Bridson-quality is not required; what matters is no visible clumping and no grid alignment). Because priority is lexicographic on `(j, i, s)`, the outcome is order-independent: any worker generating any tile gets the same answer.

Jitter is full-cell (`u01 * Sc`), not centred, and the rejection radius is set to `0.62 * Sc` for most categories, which yields an effective density of about `1 / (Sc^2)` with no visible lattice.

### 9.2 Scatter tiles

| Symbol | Value |
|--------|-------|
| `SCATTER_TILE` | 64.0 m (4 x 4 LOD1 nodes) |
| Tiles resident | 441 (21 x 21) at Ultra, 289 High, 169 Medium, 81 Low |
| Max instances per tile | 6144 (all categories combined) |
| Tile generation cost | 0.9 - 2.6 ms in a worker |
| Tile buffer | 6144 * 32 B = 196,608 B |
| Total instance VRAM | Ultra `441 * 196608` = 86.7 MB (allocated), typical occupancy 34% |

To avoid allocating for the worst case everywhere, instance storage uses a **suballocated pool** of 48 MB (Ultra) / 32 / 20 / 12, with per-tile blocks rounded up to 4 KB (128 instances). Tiles that would exceed the pool trigger eviction of the farthest tile.

### 9.3 Instance record - exactly 32 bytes

| Offset | Size | Type | Field | Encoding |
|--------|------|------|-------|----------|
| 0 | 4 | f32 | `posX` | world X |
| 4 | 4 | f32 | `posY` | world Y |
| 8 | 4 | f32 | `posZ` | world Z |
| 12 | 4 | u32 | `rot` | quaternion, packed snorm10_10_10_2 (xyz in 10-bit snorm, largest-component index in the 2-bit field) |
| 16 | 2 | f16 | `scaleXZ` | uniform horizontal scale, `[0.15, 8.0]` |
| 18 | 2 | f16 | `scaleY` | vertical scale, `[0.15, 12.0]` |
| 20 | 2 | f16 | `animPhase` | `[0, 2*PI)`, per-instance sway/pulse phase |
| 22 | 2 | f16 | `animAmp` | `[0, 2]`, stiffness multiplier |
| 24 | 1 | u8 | `variantId` | 0..255, selects the procedural mesh variant |
| 25 | 1 | u8 | `meshId` | 0..255, selects the asset class |
| 26 | 1 | u8 | `biomeId` | for material tinting |
| 27 | 1 | u8 | `flags` | bit0 emissive, bit1 harvestable, bit2 collidable, bit3 casts shadow, bit4 imposter-eligible, bit5 depleted, bits6-7 LOD bias (0..3) |
| 28 | 4 | u32 | `tint` | RGBA8: RGB per-instance tint multiplier (128 = 1.0), A = emissive intensity `[0,255] -> [0, 12] cd/m^2` |

Total: **32 bytes**, 16-byte aligned, `array<InstanceRec>` in a `storage` buffer, read directly in the vertex shader by `instance_index`.

Quaternion construction: base rotation is yaw from `u01(hs)` scaled to `[0, 2*PI)`, then for slope-aligned categories the up axis is slerped from world-up toward the terrain normal by `alignFactor[c]` (Table 9.1), then a small tilt of `+/- tiltJitter[c]` radians about a hash axis.

### 9.4 Density and filter tables

**Table 9.1 - Scatter categories (universal properties)**

| ID | Category | Cell `Sc` (m) | Max/cell | `minDist` (m) | Slope range (grad) | Align | Tilt jitter (rad) | Scale range | Collide | Emissive |
|----|----------|---------------|----------|---------------|--------------------|-------|--------------------|-------------|---------|----------|
| 0 | GROUND_TUFT | 1.4 | 4 | 0.55 | 0.00 - 0.70 | 0.85 | 0.14 | 0.6 - 1.5 | no | no |
| 1 | SEAGRASS_BLADE | 1.1 | 6 | 0.42 | 0.00 - 0.35 | 0.95 | 0.10 | 0.7 - 1.8 | no | no |
| 2 | KELP_GIANT | 5.0 | 2 | 3.10 | 0.00 - 0.62 | 1.00 | 0.06 | 0.8 - 2.4 | no | no |
| 3 | KELP_BULB | 3.2 | 3 | 1.90 | 0.00 - 0.70 | 1.00 | 0.08 | 0.7 - 1.6 | no | no |
| 4 | CORAL_BRANCH | 2.6 | 3 | 1.35 | 0.00 - 0.90 | 0.70 | 0.22 | 0.5 - 2.2 | yes | no |
| 5 | CORAL_FAN | 3.4 | 2 | 2.10 | 0.35 - 1.60 | 0.30 | 0.30 | 0.6 - 2.8 | yes | no |
| 6 | CORAL_BRAIN | 4.2 | 1 | 2.90 | 0.00 - 0.42 | 0.80 | 0.12 | 0.5 - 2.0 | yes | no |
| 7 | CORAL_TUBE | 2.2 | 4 | 1.10 | 0.00 - 1.10 | 0.55 | 0.26 | 0.4 - 1.4 | no | no |
| 8 | SPONGE_BARREL | 5.6 | 1 | 3.80 | 0.00 - 0.75 | 0.75 | 0.16 | 0.6 - 2.6 | yes | no |
| 9 | SPONGE_GLASS | 3.0 | 2 | 1.70 | 0.10 - 1.40 | 0.45 | 0.28 | 0.5 - 2.2 | no | yes (0.6) |
| 10 | ROCK_SMALL | 1.8 | 5 | 0.70 | 0.00 - 1.20 | 0.90 | 0.60 | 0.3 - 1.1 | no | no |
| 11 | ROCK_MED | 4.4 | 2 | 2.40 | 0.00 - 0.95 | 0.85 | 0.45 | 0.8 - 2.6 | yes | no |
| 12 | ROCK_LARGE | 11.0 | 1 | 7.50 | 0.00 - 0.75 | 0.80 | 0.32 | 2.0 - 6.5 | yes | no |
| 13 | BOULDER | 26.0 | 1 | 18.0 | 0.00 - 0.55 | 0.75 | 0.24 | 5.0 - 14.0 | yes | no |
| 14 | FUNGUS_CAP | 2.0 | 4 | 0.90 | 0.00 - 0.80 | 0.80 | 0.20 | 0.4 - 1.9 | no | yes (2.4) |
| 15 | FUNGUS_CLUSTER | 6.0 | 2 | 3.40 | 0.00 - 0.65 | 0.80 | 0.16 | 0.7 - 2.2 | no | yes (3.1) |
| 16 | CRYSTAL_SPIRE | 7.0 | 2 | 4.20 | 0.00 - 1.30 | 0.35 | 0.34 | 0.6 - 3.4 | yes | yes (4.5) |
| 17 | CRYSTAL_CLUSTER | 3.6 | 3 | 1.90 | 0.00 - 1.50 | 0.30 | 0.40 | 0.4 - 1.6 | no | yes (3.2) |
| 18 | ORE_NODE | 9.0 | 2 | 5.00 | 0.00 - 1.30 | 0.60 | 0.30 | 0.7 - 2.0 | yes | varies |
| 19 | SHELL_DEBRIS | 1.6 | 5 | 0.55 | 0.00 - 0.45 | 0.95 | 0.70 | 0.3 - 1.0 | no | no |
| 20 | BONE_SPUR | 8.0 | 1 | 5.20 | 0.00 - 0.70 | 0.70 | 0.26 | 1.0 - 4.0 | yes | no |
| 21 | ISLAND_FROND | 4.0 | 2 | 2.30 | 0.00 - 0.65 | 0.90 | 0.12 | 0.8 - 2.4 | no | no |
| 22 | ISLAND_SHRUB | 2.4 | 3 | 1.20 | 0.00 - 0.80 | 0.85 | 0.18 | 0.5 - 1.8 | no | no |
| 23 | VENT_CHIMNEY | 14.0 | 1 | 9.00 | 0.00 - 0.60 | 0.70 | 0.14 | 1.2 - 5.0 | yes | yes (1.8) |
| 24 | TUBEWORM_CLUMP | 2.8 | 3 | 1.40 | 0.00 - 1.00 | 0.65 | 0.26 | 0.5 - 1.7 | no | no |
| 25 | BIOLUM_STALK | 3.8 | 3 | 2.00 | 0.00 - 0.90 | 0.85 | 0.15 | 0.6 - 2.6 | no | yes (6.0) |
| 26 | ANEMONE | 2.2 | 3 | 1.10 | 0.00 - 1.20 | 0.55 | 0.30 | 0.4 - 1.5 | no | yes (1.2) |
| 27 | RUBBLE_PLATE | 3.0 | 3 | 1.60 | 0.20 - 1.60 | 0.95 | 0.50 | 0.6 - 2.4 | no | no |

**Table 9.2 - Density (instances per cell, before noise modulation) by biome x category.** Blank = 0.

| Biome \ Cat | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 |
|-------------|---|---|---|---|---|---|---|---|---|---|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|
| 0 ISLAND_ROCK | 0.35 | | | | | | | | | | 1.10 | 0.45 | 0.20 | 0.06 | | | | | 0.10 | | | 0.15 | 0.30 | | | | | 0.40 |
| 1 ISLAND_SAND | 0.10 | | | | | | | | | | 0.30 | 0.06 | 0.02 | | | | | | 0.02 | 0.90 | | 0.06 | 0.08 | | | | | 0.05 |
| 2 ISLAND_SCRUB | 1.80 | | | | | | | | | | 0.55 | 0.20 | 0.05 | 0.01 | 0.05 | | | | 0.04 | | | 0.65 | 1.10 | | | | | 0.10 |
| 3 SHALLOW_REEF | 0.20 | 0.85 | | 0.15 | 1.60 | 0.55 | 0.35 | 1.10 | 0.30 | | 0.90 | 0.35 | 0.10 | 0.02 | | | | 0.05 | 0.18 | 0.70 | | | | | | 0.05 | 0.90 | 0.35 |
| 4 SAND_FLAT | 0.05 | 1.40 | | 0.05 | 0.10 | 0.04 | 0.06 | 0.12 | 0.14 | | 0.35 | 0.10 | 0.03 | 0.01 | | | | | 0.12 | 1.20 | 0.03 | | | | | 0.10 | 0.30 | 0.06 |
| 5 KELP_TERRACE | 0.30 | 0.55 | 1.20 | 0.90 | 0.45 | 0.30 | 0.15 | 0.40 | 0.22 | | 1.20 | 0.55 | 0.18 | 0.04 | 0.02 | | | 0.04 | 0.22 | 0.35 | | | | | | 0.15 | 0.40 | 0.55 |
| 6 ROCKY_SPUR | 0.15 | 0.10 | 0.35 | 0.30 | 0.80 | 0.95 | 0.10 | 0.65 | 0.30 | 0.05 | 1.70 | 0.90 | 0.32 | 0.07 | 0.06 | 0.02 | 0.05 | 0.12 | 0.34 | 0.15 | 0.02 | | | | | 0.22 | 0.55 | 1.10 |
| 7 SHELF_BREAK_WALL | | | | 0.04 | 0.35 | 1.40 | 0.02 | 0.55 | 0.18 | 0.30 | 1.10 | 0.60 | 0.22 | 0.03 | 0.10 | 0.04 | 0.10 | 0.22 | 0.40 | 0.04 | 0.05 | | | | 0.08 | 0.45 | 0.70 | 1.30 |
| 8 SEDIMENT_BASIN | | 0.06 | | | 0.02 | 0.06 | 0.02 | 0.05 | 0.10 | 0.14 | 0.20 | 0.06 | 0.02 | 0.01 | 0.12 | 0.06 | 0.03 | 0.06 | 0.16 | 0.30 | 0.22 | | | 0.02 | 0.10 | 0.55 | 0.20 | 0.05 |
| 9 THERMAL_VENT_FIELD | | | | | | 0.05 | | 0.10 | 0.06 | 0.05 | 0.85 | 0.40 | 0.15 | 0.04 | 0.30 | 0.14 | 0.22 | 0.40 | 0.62 | 0.05 | 0.10 | | | 0.55 | 1.60 | 0.35 | 0.30 | 0.70 |
| 10 CRATER_RIM_REEF | 0.05 | 0.10 | | 0.12 | 0.95 | 1.10 | 0.30 | 0.70 | 0.34 | 0.20 | 1.30 | 0.70 | 0.26 | 0.05 | 0.08 | 0.03 | 0.08 | 0.16 | 0.38 | 0.22 | 0.06 | | | 0.04 | 0.06 | 0.40 | 0.75 | 0.85 |
| 11 CALCITE_FIELD | | | | | 0.06 | 0.20 | 0.08 | 0.22 | 0.14 | 0.26 | 0.60 | 0.30 | 0.14 | 0.03 | 0.35 | 0.18 | 0.45 | 0.80 | 0.44 | 0.60 | 0.30 | | | | 0.05 | 0.70 | 0.25 | 0.55 |
| 12 GLASS_SPONGE_SLOPE | | | | | 0.04 | 0.30 | | 0.18 | 0.30 | 1.50 | 0.75 | 0.35 | 0.14 | 0.03 | 0.16 | 0.08 | 0.14 | 0.28 | 0.36 | 0.10 | 0.20 | | | 0.03 | 0.12 | 0.62 | 0.30 | 0.60 |
| 13 TRENCH_WALL | | | | | | 0.22 | | 0.14 | 0.12 | 0.55 | 1.05 | 0.62 | 0.26 | 0.05 | 0.26 | 0.12 | 0.30 | 0.55 | 0.58 | 0.04 | 0.34 | | | 0.10 | 0.20 | 0.80 | 0.22 | 1.20 |
| 14 TRENCH_FLOOR | | | | | | 0.04 | | 0.05 | 0.08 | 0.22 | 0.26 | 0.10 | 0.04 | 0.02 | 0.34 | 0.16 | 0.14 | 0.26 | 0.26 | 0.35 | 0.55 | | | 0.14 | 0.30 | 1.10 | 0.18 | 0.10 |
| 15 ABYSSAL_PLAIN | | 0.02 | | | | 0.02 | | 0.03 | 0.05 | 0.10 | 0.14 | 0.05 | 0.02 | 0.01 | 0.10 | 0.04 | 0.03 | 0.06 | 0.12 | 0.22 | 0.16 | | | | 0.06 | 0.34 | 0.12 | 0.04 |
| 16 CAVE_INTERIOR | | | | | | 0.10 | | 0.14 | 0.10 | 0.20 | 1.40 | 0.70 | 0.24 | 0.04 | 0.55 | 0.28 | 0.35 | 0.65 | 0.72 | | 0.14 | | | | | 0.45 | 0.15 | 1.05 |
| 17 LUMINOUS_GROTTO | | | | | | 0.14 | | 0.20 | 0.14 | 0.35 | 1.20 | 0.60 | 0.22 | 0.04 | 1.40 | 0.85 | 0.70 | 1.30 | 0.66 | | 0.10 | | | | | 1.60 | 0.40 | 0.90 |

Depth filters are enforced primarily by the biome (each biome occupies a depth band), plus per-category hard clamps: categories 0, 21, 22 require `y > 0.4 m`; categories 1-9, 19, 24, 26 require `y < -0.5 m`; category 2 (giant kelp) requires depth in `[18, 140] m`; category 23 requires biome 9.

### 9.5 GPU culling and draw

Two compute passes plus one indirect draw per bucket.

```
Pass A  "cullInstances"   @workgroup_size(64)
  Input : active tile list (CPU-culled by tile AABB vs frustum, <= 441 entries)
          instance pool (storage, read)
  Per thread: one instance.
    - reject if outside frustum (sphere test using per-mesh bounding radius * scale)
    - compute dist; reject if dist > catViewDist[meshId] * tierScale
    - select lod = firstIndexWhere(dist < lodDist[meshId][l])
    - bucket = meshLodBase[meshId] + lod
    - slot = atomicAdd(&counters[bucket], 1u)
    - if slot < bucketCap[bucket]: outIndices[bucketBase[bucket] + slot] = instanceIndex

Pass B  "buildIndirect"   @workgroup_size(64), 1 dispatch of ceil(NBUCKETS/64)
  For each bucket: write DrawIndexedIndirect args
    { indexCount = meshIndexCount[bucket], instanceCount = min(counters[b], cap),
      firstIndex = meshFirstIndex[bucket], baseVertex = meshBaseVertex[bucket],
      firstInstance = 0 }
  Then zero counters for next frame.

Draw: for b in 0..NBUCKETS-1: drawIndexedIndirect(argsBuffer, b * 20)
```

`NBUCKETS = 256` (28 categories x up to 6 variants x 4 LODs, capped and packed). 256 indirect draws per frame is acceptable on WebGPU (measured ~0.09 ms of CPU encode on Chrome/Metal); they are recorded once into a reusable render bundle since the args live in a buffer.

All procedural meshes for scatter live in **one shared vertex buffer and one shared index buffer** so no rebinding occurs between buckets. `baseVertex`/`firstIndex` select the sub-mesh.

Instance-order stability: `atomicAdd` produces a nondeterministic *order* within a bucket. This is fine - order does not affect the image (opaque, depth-tested) and never feeds back into simulation. Transparent scatter (none in v1; glass sponges are alpha-tested, not blended) would need sorting.

**Table 9.3 - LOD and imposter distances (metres, Ultra; multiply by tier factor 1.0 / 0.78 / 0.58 / 0.42)**

| Category | LOD0 | LOD1 | LOD2 | Imposter | Cull |
|----------|------|------|------|----------|------|
| GROUND_TUFT / SEAGRASS | 14 | 26 | - | - | 34 |
| KELP_GIANT | 26 | 55 | 95 | 150 | 210 |
| KELP_BULB | 20 | 42 | 70 | 110 | 150 |
| CORAL_BRANCH / FAN / TUBE | 22 | 46 | 78 | 120 | 165 |
| CORAL_BRAIN / SPONGE_BARREL | 30 | 62 | 100 | 150 | 200 |
| SPONGE_GLASS | 24 | 48 | 80 | 120 | 170 |
| ROCK_SMALL | 18 | 38 | 62 | - | 85 |
| ROCK_MED | 34 | 70 | 115 | - | 165 |
| ROCK_LARGE | 60 | 130 | 220 | 320 | 440 |
| BOULDER | 110 | 240 | 420 | 620 | 900 |
| FUNGUS_CAP / CLUSTER | 22 | 46 | 76 | 115 | 160 |
| CRYSTAL_SPIRE / CLUSTER | 34 | 72 | 120 | 180 | 250 |
| ORE_NODE | 40 | 85 | 140 | - | 190 |
| SHELL_DEBRIS / RUBBLE_PLATE | 16 | 32 | - | - | 44 |
| BONE_SPUR | 46 | 96 | 160 | 240 | 330 |
| ISLAND_FROND / SHRUB | 26 | 55 | 90 | 135 | 190 |
| VENT_CHIMNEY | 55 | 120 | 200 | 300 | 420 |
| TUBEWORM_CLUMP / ANEMONE | 18 | 38 | 62 | - | 88 |
| BIOLUM_STALK | 30 | 62 | 105 | 160 | 230 |

**Imposters.** Octahedral imposters, 8 x 8 view directions in a `2048 x 2048` `rgba8unorm` atlas plus a matching `rg16float` normal+depth atlas, baked **at world load** by rendering the procedural mesh from 64 directions into the atlas (one compute-free render pass, about 40 ms total for all imposter-eligible assets). Not an asset file: the meshes are procedural, so the atlas is too. Imposter rendering is a single camera-facing quad per instance with octahedral blend of the 3 nearest views, alpha-tested at 0.5.

**Table 9.4 - Max live instance counts (post-cull, per frame)**

| Category group | Ultra | High | Medium | Low |
|----------------|-------|------|--------|-----|
| Ground cover (0,1,19,27) | 220,000 | 130,000 | 62,000 | 26,000 |
| Kelp (2,3) | 26,000 | 16,000 | 8,000 | 3,400 |
| Coral + sponge (4-9) | 74,000 | 44,000 | 22,000 | 9,500 |
| Rocks (10-13) | 96,000 | 58,000 | 28,000 | 12,000 |
| Fungi + crystals (14-17,25) | 42,000 | 25,000 | 12,000 | 5,200 |
| Ore (18) | 6,000 | 4,200 | 2,600 | 1,400 |
| Misc (20-24,26) | 28,000 | 17,000 | 8,400 | 3,600 |
| **Total instances** | **492,000** | **294,300** | **143,000** | **61,100** |
| **Scatter triangles** | 1,580,000 | 900,000 | 450,000 | 195,000 |

### 9.6 Ore node placement

Ore nodes are category 18 but with an extra gate: a 3D vein field.

```
veinValue = 0.5 + 0.5 * simplex3fbm(SEED_ORE ^ oreTypeId, p * (1/74), 3, 2.19, 0.50)
gate      = veinValue > veinThreshold[oreType]
```

**Table 9.5 - Ore types (geometry/placement only; yields and uses belong to section 07)**

| ID | Name | Biomes | Depth band (m) | Vein threshold | Rel. weight | Node mesh | Emissive |
|----|------|--------|----------------|----------------|-------------|-----------|----------|
| 0 | Ferrite Nodule | 4,8,15 | 20 - 1900 | 0.52 | 1.00 | ROCK deformed + facets | no |
| 1 | Cupric Crust | 3,6,10 | 8 - 480 | 0.58 | 0.72 | crust plate on rock | no |
| 2 | Titanite Vein | 6,7,13 | 120 - 2600 | 0.66 | 0.44 | angular prism cluster | no |
| 3 | Aurelite | 9,11 | 540 - 1400 | 0.74 | 0.16 | fine speckle on rock | no |
| 4 | Lithion Salt | 8,11,14 | 500 - 3200 | 0.61 | 0.38 | efflorescent crust | faint (0.4) |
| 5 | Argent Halide | 11,12,16 | 620 - 1800 | 0.69 | 0.24 | needle cluster | no |
| 6 | Magnetite Cluster | 0,6,9 | -46 - 900 | 0.55 | 0.66 | dark spheroid cluster | no |
| 7 | Voidglass Shard | 13,14,17 | 2200 - 3400 | 0.80 | 0.08 | crystal prism | strong (7.5) |

Selection of ore type at a node: weighted pick over the types whose biome and depth gates pass, using `u01(hash_u32(hs ^ 0xF00D))` against the cumulative relative weights in ID order.

Depleted nodes set `flags` bit5 and are persisted in the same edit store as mining craters (section 12), keyed by quantised world position.

---

## 10. PROCEDURAL MESH GENERATION

All meshes are generated on the CPU at load time (in a worker), written into the shared scatter vertex/index buffers, and never regenerated. Total generation budget: **380 ms** across 4 workers at world load (parallel with the erosion bake read-back).

**Shared scatter vertex format - 20 bytes:**

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0 | 6 | i16 x3 | position, snorm16 scaled by per-mesh `boundsRadius` |
| 6 | 4 | i16 x2 | normal, octahedral snorm16 |
| 10 | 4 | i16 x2 | tangent xy octahedral (w sign in bit 0 of `param`) |
| 14 | 2 | u16 x2... | uv, unorm16 |
| 18 | 2 | u16 | `param`: bits 0-11 sway weight (unorm12), bits 12-14 material slot, bit 15 tangent sign |

Total 20 B. Indices u16 per mesh (all procedural meshes are under 65535 verts).

`sway weight` is the per-vertex animation stiffness (0 at the base, 1 at the tip), used by the vertex-shader current/wave animation. This single channel drives kelp, seagrass, fronds, anemones and tubeworms.

### 10.1 Rocks - deformed icospheres

| LOD | Subdiv | Verts | Tris |
|-----|--------|-------|------|
| 0 | 3 | 642 | 1280 |
| 1 | 2 | 162 | 320 |
| 2 | 1 | 42 | 80 |

Generation:

```
p = icosphereVertex (unit)
// 1. Anisotropic base shape
p *= axisScale             // (sx, sy, sz), each lerp(0.55, 1.45) from variant hash
// 2. Large lumps
r = 1 + AL * simplex3(seed, p * fL)
// 3. Medium erosion
r += AM * simplex3(seed^1, p * fM)
// 4. Angular chipping via worley (flattens facets)
w = worley3(seed^2, p * fC, 1.0)
r -= AC * smoothstep(0.0, 0.35, w.f1)
// 5. Flat bottom (rocks sit on the ground)
p.y = max(p.y, -0.78 + 0.10 * simplex3(seed^3, p * 2.1))
pos = p * r * boundsRadius
```

**Table 10.1 - Rock variant knobs**

| Variant | `AL` | `fL` | `AM` | `fM` | `AC` | `fC` | axisScale range | Look |
|---------|------|------|------|------|------|------|------------------|------|
| R0 rounded | 0.22 | 1.3 | 0.09 | 3.4 | 0.05 | 2.0 | 0.80-1.25 | water-worn cobble |
| R1 blocky | 0.14 | 1.1 | 0.07 | 2.8 | 0.26 | 1.5 | 0.70-1.35 | fractured basalt |
| R2 slab | 0.18 | 1.6 | 0.10 | 4.1 | 0.14 | 2.4 | sy 0.30-0.55 | plate / rubble |
| R3 spiky | 0.34 | 2.2 | 0.16 | 5.5 | 0.30 | 3.1 | 0.75-1.30 | pinnacle |
| R4 encrusted | 0.20 | 1.4 | 0.14 | 6.2 | 0.08 | 2.2 | 0.85-1.20 | coral-covered |
| R5 pumice | 0.26 | 1.9 | 0.20 | 7.8 | 0.18 | 4.0 | 0.80-1.30 | vesicular volcanic |

8 variants per rock category are baked (variant index = `hash & 7`, mapping to R0-R5 with R0 and R1 duplicated for weighting).

Normals are recomputed by area-weighted face-normal accumulation after deformation. Tangents from the icosphere's spherical UV.

### 10.2 Kelp and seagrass - swept splines

| Asset | Spline points | Radial segs | Verts (LOD0) | Tris (LOD0) | LOD1 | LOD2 |
|-------|---------------|-------------|--------------|-------------|------|------|
| KELP_GIANT | 22 | 6 | 154 stem + 18 blades x 28 | 812 verts / 1348 tris | 380/560 | 96/128 |
| KELP_BULB | 14 | 5 | 84 stem + 9 blades x 22 | 306/468 | 150/210 | 44/56 |
| SEAGRASS_BLADE | 7 | 2 (ribbon) | 16 | 18 | 8/6 | - |
| ISLAND_FROND | 11 | 4 | 66 stem + 12 leaflets | 250/362 | 118/160 | 34/44 |

Stem generation:

```
for i in 0..N-1:
   t = i / (N-1)
   // Curvature: a slow lean plus a helical twist
   lean  = leanAmp * t * t
   twist = twistRate * t * 2*PI
   c = (lean * sw_cos(twist + phase), t * height, lean * sw_sin(twist + phase))
   radius = baseRadius * (1 - 0.72 * t) * (1 + 0.18 * simplex2(seed, t*9, 0))
   ring of `radial` verts around the Frenet frame at c
   swayWeight[i] = t * t * (3 - 2*t)      // smoothstep, so the base does not move
```

**Table 10.2 - Kelp parametric knobs**

| Knob | KELP_GIANT | KELP_BULB | SEAGRASS |
|------|------------|-----------|----------|
| Height (m, at scale 1) | 9.5 | 3.4 | 0.55 |
| Base radius (m) | 0.075 | 0.045 | 0.012 |
| Lean amp (m) | 0.9 | 0.35 | 0.06 |
| Twist rate (turns) | 0.55 | 0.30 | 0.0 |
| Blade count | 18 | 9 | 1 |
| Blade length (m) | 1.4 | 0.6 | 0.55 |
| Blade width (m) | 0.20 | 0.12 | 0.03 |
| Pneumatocyst (float bladder) | yes, r 0.09 m every 0.55 m | yes, r 0.13 m at 60% | no |
| Sway weight at tip | 1.0 | 1.0 | 1.0 |

**Animation (vertex shader, section 05 owns the shader; this section owns the model):**

```
// Current-driven bend + wave orbital motion, both attenuated with depth.
u_current  = currentVec(worldPos, time)              // from section 03, m/s
waveOrb    = waveOrbitalVelocity(worldPos, time)     // from section 03, m/s, decays as exp(-k*d)
drive      = u_current + waveOrb
bend       = swayWeight * animAmp * ( drive * 0.24
             + normalize(drive) * 0.09 * sin(time*1.7 + animPhase + swayWeight*2.6) )
localPos.xz += bend.xz
localPos.y  -= 0.5 * dot(bend.xz, bend.xz) / max(stemLen, 0.01)   // arc-length preservation
```

Arc-length preservation matters: without it, kelp visibly stretches. The quadratic correction is exact to second order and costs 4 instructions.

### 10.3 Corals

**Branching coral (CORAL_BRANCH, CORAL_TUBE) - space colonization.**

| Parameter | CORAL_BRANCH | CORAL_TUBE |
|-----------|--------------|------------|
| Attractor count | 420 | 180 |
| Attractor volume | hemisphere r=1.0, squashed y*0.85 | cylinder r=0.55, h=1.2 |
| Influence radius | 0.34 | 0.42 |
| Kill radius | 0.12 | 0.16 |
| Step length | 0.055 | 0.075 |
| Max iterations | 160 | 110 |
| Resulting nodes | 180-320 | 70-140 |
| Radial segs | 5 | 6 |
| Verts LOD0 | 1100-1900 | 480-880 |
| Tris LOD0 | 1800-3100 | 800-1500 |
| Branch radius | `r_leaf * (childCount)^0.42` via Murray's law, `r_leaf = 0.018 m` | `r_leaf = 0.035 m` |

Space colonization is deterministic: attractors are placed by a hash-driven Halton sequence in the volume, and the growth loop's node ordering is by insertion index. Skeleton to mesh: generalised cylinder along each branch, with a hemisphere cap at each tip and a smooth join at bifurcations (the two child rings are lofted from a shared parent ring, so no boolean is needed).

**Fan coral (CORAL_FAN) - 2D L-system, extruded.**

```
Axiom:  F
Rules:  F -> F[+F][-F]F        (probability-weighted variants below)
        F -> F[+F]F
        F -> F[-F]F
Iterations: 5
Angle: 24 deg +/- 7 deg (hash-jittered per branch)
Segment length: 0.16 m, scaled by 0.78 per generation
Plane: the local XY plane, with a per-vertex out-of-plane offset of
       +/- 0.035 m from simplex2 to avoid a papery look
Thickness: 0.020 m at the base tapering to 0.005 m; extruded as a flat ribbon
           with 3 verts across (giving a slightly convex profile)
Verts LOD0: 620-1100   Tris LOD0: 780-1420
LOD1: decimate to every-other-generation (about 40%). LOD2: imposter only.
```

**Brain / plate coral (CORAL_BRAIN) - displaced hemisphere with a groove field.**

```
Base: UV hemisphere, 24 x 12 (312 verts, 552 tris) at LOD0
Displacement:
  w = worley2(seed, sphericalUV * 7.5, 1.0)
  groove = smoothstep(0.02, 0.16, w.f2 - w.f1)      // 0 in the groove, 1 on the ridge
  r = 1.0 + 0.085 * groove - 0.045 * (1 - groove)
  // plus a global lumpiness
  r += 0.12 * simplex3(seed^1, p * 2.2)
LOD1: 16 x 8 (144/240). LOD2: 10 x 5 (60/90).
```

**Barrel sponge (SPONGE_BARREL) - lathe with an interior bore.**

```
Profile (r, y) control points, Catmull-Rom, 14 samples:
  (0.34, 0.00) (0.44, 0.10) (0.52, 0.30) (0.56, 0.58) (0.54, 0.82) (0.50, 0.96)
Interior bore: same profile scaled by 0.62 in r, offset down by 0.10, reversed winding
Rim: a 12-segment torus join between exterior and interior
Surface: radial ribs, r *= 1 + 0.06*sin(theta * ribCount), ribCount = 9..17
         plus 0.03 * simplex3 pitting
Verts LOD0: 26 radial x 14 x 2 shells = 728, +312 rim = 1040. Tris: 1976.
LOD1: 14 radial (560/1064). LOD2: solid, no bore (168/312).
```

**Glass sponge (SPONGE_GLASS) - lattice of thin tubes.** Space colonization with `attractors = 90`, `stepLength = 0.09`, radial segs 4, then every branch is rendered as a 4-sided tube with `r = 0.012 m`. Alpha-tested lattice holes come from the geometry itself, not a texture. Verts 340-620, tris 460-880. Emissive parameter drives a faint internal glow (section 05).

### 10.4 Fungi - lathes

| Asset | Profile pts | Radial segs | Verts LOD0 | Tris LOD0 |
|-------|-------------|-------------|------------|-----------|
| FUNGUS_CAP | 11 (stem) + 13 (cap) | 14 | 336 | 616 |
| FUNGUS_CLUSTER | 4 caps of the above, hash-placed on a shared base | 12 | 1180 | 2160 |

Cap profile (normalised, `r` then `y`), Catmull-Rom, 13 samples:
`(0.00,1.00) (0.30,0.97) (0.58,0.88) (0.82,0.72) (0.96,0.52) (1.00,0.40) (0.86,0.36)` - the last point folds under to make a gill lip.

Parametric knobs: `capFlare in [0.6, 1.6]` (multiplies r), `capHeight in [0.25, 0.85]`, `stemBulge in [0.9, 1.7]`, `stemLean in [0, 0.28] rad`, `gillCount in [18, 42]` (gills are a radial groove on the underside, `r_under *= 1 + 0.05*sin(theta*gillCount)`), `emissiveBias in [0.2, 1.0]`.

Underside gills carry `material slot 1` so the emissive shader can light only the gills - the key bioluminescent read in caves.

### 10.5 Crystals - convex prisms

```
sides   = 5 + (hash & 3)          // 5..8
Build a convex polygon in XZ with radii r_k = R * (0.72 + 0.28*u01(h_k))
Extrude to height Hc, with the top ring scaled by taper in [0.05, 0.55]
Cap the top with a pyramid of apex height 0.18..0.55 * Hc
Facet cuts: for each of 2..4 hash-chosen half-spaces, clip the prism (Sutherland-Hodgman
            on the convex hull, exact and deterministic)
Verts LOD0: 46-92    Tris LOD0: 72-160
CRYSTAL_CLUSTER: 3..7 prisms sharing a base, sizes 0.35..1.0 of the primary,
            azimuths spread, tilts 0.15..0.55 rad.  Verts 210-560, Tris 340-900
```

Knobs: `R in [0.06, 0.42] m`, `Hc in [0.30, 3.20] m`, `taper`, `facetCuts`, `apexRatio`, `internalGlowDepth in [0.05, 0.4] m` (drives the shader's fake subsurface term). Crystals get no LOD1/2 mesh - they are already tiny; they go straight from LOD0 to imposter.

### 10.6 Other assets

| Asset | Method | Verts LOD0 | Tris LOD0 | Key knobs |
|-------|--------|------------|-----------|-----------|
| VENT_CHIMNEY | Lathe with a stacked-cone profile (7 stacks) + worley crust displacement + a hollow bore | 620 | 1180 | `stacks 4-9`, `flareRate`, `boreRadius`, `leanAngle` |
| BONE_SPUR | Swept spline, elliptical cross-section, ribbed | 280 | 496 | `curvature`, `ribCount 6-14`, `taper` |
| TUBEWORM_CLUMP | 9-24 thin swept tubes from a shared base, each with a flared plume of 6 ribbons | 540 | 880 | `count`, `heightRange`, `plumeSpread` |
| ANEMONE | Disc base + 40-90 tentacles as 4-seg tapered tubes | 720 | 1200 | `tentacleCount`, `length`, `curl` |
| BIOLUM_STALK | Swept spline stem + 3-9 spherical bulbs (icosphere subdiv 1) | 410 | 700 | `bulbCount`, `bulbRadius`, `spacing`, `pulseRate 0.2-1.4 Hz` |
| SHELL_DEBRIS | Logarithmic-spiral lathe (nautilus form), 3 variants | 180 | 320 | `spiralRate`, `apertureFlare` |
| RUBBLE_PLATE | Deformed disc, 9-14 gon, thickness 0.02-0.09 | 60 | 96 | `edgeRoughness` |
| GROUND_TUFT | 5-9 crossed ribbon quads | 44 | 32 | `bladeCount`, `spread`, `heightJitter` |
| ISLAND_SHRUB | 3-generation L-system stem + 20-50 leaf quads | 420 | 560 | `branchAngle`, `leafSize` |
| ORE_NODE | Rock R1 base + 4-11 crystal/nodule attachments + emissive seams along the worley cracks | 780 | 1420 | `attachCount`, `seamWidth`, `oreType` |

**Total procedural mesh memory:** 28 categories x average 4 variants x average 3 LODs x average 640 verts x 20 B = **4.3 MB vertices** + 1.8 MB indices. Plus 2 imposter atlases at 2048^2: `rgba8` 16.8 MB + `rg16f` 16.8 MB = 33.6 MB. Total asset VRAM about **40 MB**.

---

## 11. COLLISION AND STREAMING

### 11.1 CPU height query

Three tiers, in order of preference:

**Tier 1 - Height cache (hot path, used by player, vessel, and every creature).**

| Property | Value |
|----------|-------|
| Tile size | 16.0 m (matches LOD0 node) |
| Resolution | 33 x 33 samples at 0.5 m (matches LOD0 grid exactly) |
| Storage | `Float32Array(1089)` per tile = 4356 B |
| Capacity | 256 tiles = 1.11 MB |
| Coverage | 256 tiles = 4096 m^2 minimum, but in practice a 176 x 176 m band around the player plus the vessel |
| Eviction | LRU, with a pinned set (the 9 tiles under the player and the 9 under the vessel are never evicted) |
| Fill | Async via worker; a miss triggers a job and returns the Tier-2 result this frame |

Query: bilinear on the 0.5 m grid. Cost: 2 array reads plus 8 flops = about 12 ns. Normal: central difference on the same grid, 4 reads. **The cache samples exactly the same lattice as the LOD0 render mesh**, so collision and visuals agree to the bit - no "floating above the ground" class of bug.

**Tier 2 - Direct evaluation (cache miss, or rare one-off queries).** Full `H(x,z)` stack: about 3.1 us on an M1 (dominated by 7-octave erosive fBm plus 6-octave ridged). Budget: at most 64 direct evaluations per frame on the main thread (0.20 ms). A counter enforces this; the 65th falls back to the nearest cached tile's value with a linear extrapolation, flagged so gameplay code can retry next frame.

**Tier 3 - Coarse proxy (AI, spawning, pathing hints).** A 32 m grid over the whole world, `512 x 512` `Float32Array` = 1.05 MB, generated once at load (about 90 ms in workers) using only layers L0, L1, L2, L6, L12. Accurate to about +/- 9 m. Used for "is there roughly ground here", never for physics.

### 11.2 Volumetric (cave / overhang / arch) collision

Heightfield collision is wrong inside a cave. Resolution:

```
isVolumetricAt(p):
    cvc = cvcAt(p)
    return cvc != null && cvc.active
```

When `isVolumetricAt` is true for the entity's broadphase AABB, collision switches to triangle collision against the CVC mesh.

Each CVC's worker output includes, alongside the render mesh:

| Structure | Layout | Size |
|-----------|--------|------|
| Collision positions | `Float32Array(verts * 3)` (full precision, not the u16 render encoding) | up to 786 KB, typically 65 KB |
| Collision indices | `Uint16Array(tris * 3)` | typically 59 KB |
| Uniform grid | 8 x 8 x 8 cells of 4 m; `cellStart: Uint32Array(513)`, `triList: Uint32Array(n)` | typically 46 KB |
| Solid bitfield | 33^3 bits = 4492 B, one bit per voxel, `F > 0` | 4492 B |

The solid bitfield is the cheap first test: a point query is 1 array read and 2 shifts. It answers "am I inside rock" to within 1 m, which is enough for the oxygen/darkness/audio-reverb systems and for creature avoidance. Precise capsule-vs-triangle sweeps use the uniform grid and are only run for the player capsule and the vessel hull.

Collision memory: 96 CVCs x about 175 KB = **16.8 MB** on the CPU heap at Ultra. This lives in the main thread (transferred from workers), not in worker memory.

**Player capsule vs. cave:** capsule (r = 0.34 m, h = 1.72 m) swept against the triangles in the grid cells the swept AABB overlaps. Maximum 3 depenetration iterations per frame, 0.02 m skin width. Budget 0.22 ms.

**Vessel hull vs. cave:** the vessel is approximated by 7 spheres (section 04 owns the exact fit). Sphere-vs-triangle, same grid. Budget 0.30 ms.

**Overhangs on the heightfield:** an entity is under an overhang when `isVolumetricAt` is true; there is no separate case. This is why overhangs are implemented as volumetric override rather than as a heightfield hack - it collapses two collision systems into one.

### 11.3 Worker pool and job scheduling

```
workerCount = clamp(navigator.hardwareConcurrency - 2, 2, 6)
Workers are `type: "module"`, all loading the same `gen-worker.js`.
```

**Job types and priorities (lower number = higher priority):**

| Pri | Job | Typical cost (M1) | Output size | Notes |
|-----|-----|-------------------|-------------|-------|
| 0 | `HEIGHT_TILE` | 0.9 ms | 4356 B | collision cache fill; must land within 2 frames |
| 1 | `TERRAIN_NODE` LOD0-2 | 1.4 - 2.2 ms | 9800 B | |
| 2 | `CVC` | 4.5 - 9.0 ms | 100 - 900 KB | render mesh + collision |
| 3 | `SCATTER_TILE` | 0.9 - 2.6 ms | up to 196 KB | |
| 4 | `TERRAIN_NODE` LOD3-5 | 1.4 - 2.2 ms | 9800 B | |
| 5 | `TERRAIN_NODE` LOD6-9 | 1.4 - 2.2 ms | 9800 B | |
| 6 | `MACRO_GRAPH` (cave graph for a macro cell) | 1.8 ms | cached in-worker | never crosses the boundary |
| 7 | `IMPOSTER_BAKE` request | n/a | n/a | main-thread render, load only |

**Transfer discipline.** Every result is posted with `postMessage(payload, [buf1, buf2, ...])` using **transferable** `ArrayBuffer`s. No structured cloning of large data ever. The main thread returns the buffers to a free pool (`postMessage` back with transfer) so allocation churn is zero in steady state. `SharedArrayBuffer` is deliberately **not** used: it requires COOP/COEP headers, which conflicts with the "serve the files directly, no build step, no server config" constraint. The measured cost of transfer is 8-20 us per buffer, which is negligible.

**Immutable worker inputs.** Each worker receives at init: `worldSeed`, `GEN_VERSION`, and copies of `Efine`/`Ecoarse` (2.1 MB each - copied, not shared, so 4 workers cost 16.8 MB of extra RAM; accepted). Mining edits are streamed to workers as deltas (section 12).

**Table 11.1 - Per-frame main-thread budget at 60 fps (16.67 ms)**

| Activity | Ultra | Notes |
|----------|-------|-------|
| Quadtree cut + cull | 0.35 ms | 7.6 |
| Descriptor upload | 0.10 ms | 384 x 48 B |
| Node vertex uploads | 0.55 ms | max 6 nodes/frame at 9800 B |
| CVC uploads | 0.40 ms | max 1 CVC/frame |
| Scatter tile uploads | 0.35 ms | max 2 tiles/frame |
| Job dispatch + result intake | 0.25 ms | |
| Height cache maintenance | 0.10 ms | |
| Player + vessel collision | 0.52 ms | |
| **Terrain subsystem total** | **2.62 ms** | Hard cap **3.20 ms**; over budget defers uploads to the next frame |

Rate limits are hard: if more results arrive than the per-frame cap, they queue (a `Map` keyed by node id, so a stale result for a node that has been re-requested is dropped).

**Table 11.2 - Chunk lifetime state machine**

| State | Enter when | Exit when |
|-------|------------|-----------|
| `UNKNOWN` | initial | requested by the cut |
| `QUEUED` | in the cut, not resident | a worker picks it up |
| `GENERATING` | worker started | result posted |
| `READY` | result received, awaiting upload | uploaded |
| `RESIDENT` | GPU slot assigned | evicted |
| `EVICTING` | out of the cut for `> hysteresis` | slot freed |

Hysteresis: a node is only evicted after it has been outside the cut **and** beyond `1.25 x` its LOD's split distance for **90 consecutive frames** (1.5 s). This prevents thrash when the camera oscillates at an LOD boundary. Eviction picks the lowest `(priorityScore = 1/distance + 0.4 * isLowLod)`.

Cancellation: a `QUEUED` job whose node leaves the cut is removed from the queue. A `GENERATING` job is never cancelled (the worker has no preemption); its result is discarded on arrival if the node's `requestEpoch` no longer matches.

### 11.4 Streaming behaviour targets

| Scenario | Requirement |
|----------|-------------|
| Walking (1.4 m/s) | Zero visible pop-in. Nodes arrive at least 2 LOD rings ahead |
| Swimming (2.6 m/s) | Zero visible pop-in |
| Vessel cruise underwater (24 m/s) | LOD0-2 may briefly show a parent LOD; never a hole |
| Vessel flight (72 m/s max) | Terrain LOD may lag by one level for up to 0.4 s; skirts guarantee no hole. CVCs are not generated above 45 m/s (caves are irrelevant while flying) |
| Vessel dive from air to -900 m at 40 m/s | 23 s of travel; the CVC and scatter pipelines must keep up. Prefetch uses velocity: the query centre for streaming is `cameraPos + velocity * 1.1 s` |
| Teleport / load | Full 3 s budget with a fade-in; the LOD cut is built from the coarsest level down and rendered progressively |

---

## 12. TERRAIN DEFORMATION FROM MINING

### 12.1 The edit model

An edit is a **sphere of removed material**. That is the only primitive. Everything the player can do to the terrain (hand drill, cutting torch, vessel-mounted borer, explosive charge) reduces to a set of spheres.

```
struct Edit {          // 20 bytes packed, stored little-endian
  i16  cx;   // world X, quantised to 0.25 m, range +/- 8191.75 m
  i16  cy;   // world Y, quantised to 0.25 m, range +/- 8191.75 m  (clamped to world Y range)
  i16  cz;   // world Z, quantised to 0.25 m
  u8   radius;    // 0.125 m units, range 0.125 .. 31.875 m
  u8   strength;  // 0..255 -> 0.0 .. 2.0 field units
  u8   toolId;    // which tool made it (affects the wall material and the audio)
  u8   flags;     // bit0 = additive (terraforming, reserved), bit1 = permanent
  u32  tick;      // game tick when created, for ordering
  u32  reserved;  // 0
}
```

Byte accounting: `3 * i16 = 6`, `4 * u8 = 4` (total 10), then **2 bytes of zero padding** at offsets 10-11 so that `tick` lands on offset 12 and `reserved` on 16. Struct size is exactly **20 bytes**. Implementations must write the padding as zero, because the padding bytes are covered by the persistence hash.

| Offset | Type | Field |
|--------|------|-------|
| 0 | i16 | `cx` |
| 2 | i16 | `cy` |
| 4 | i16 | `cz` |
| 6 | u8 | `radius` |
| 7 | u8 | `strength` |
| 8 | u8 | `toolId` |
| 9 | u8 | `flags` |
| 10 | u8 x2 | `_pad` (must be 0) |
| 12 | u32 | `tick` |
| 16 | u32 | `reserved` (must be 0) |

Quantising centres to 0.25 m is deliberate: it makes duplicate/overlapping edits mergeable, and 0.25 m is well below the 1 m voxel resolution so no visual quality is lost.

### 12.2 Field contribution

```
Fedit(p) = - sum over edits i, in ascending `tick` order, of
             strength_i * pow2( max(0, 1 - length(p - c_i) / R_i) )
```

`pow2` is `x*x`. The quadratic falloff gives a smooth, roughly hemispherical crater with a soft lip. Summation order is by `tick` (a total order), so the result is deterministic regardless of which worker computes it.

Because `Fedit` is added to `F` (which is a *metric* field near the surface, in metres), a `strength` of 1.0 with `radius` 1.5 m removes about 1.5 m of rock at the centre. Tool tuning belongs to section 07; this section guarantees the field semantics.

### 12.3 Storage, indexing, persistence

| Property | Value |
|----------|-------|
| Edit cell | 64.0 m cube, address `(ex, ey, ez)` |
| Max edits per cell | 4096 (81,920 B) |
| Max edits per world | 262,144 (5.24 MB) |
| Store | IndexedDB object store `edits`, key `(ex << 40) | (ey << 20) | ez` as a string key, value = `ArrayBuffer` of packed Edit records |
| Write policy | Debounced: a dirty cell is flushed 1.5 s after its last modification, or immediately on `visibilitychange`/`beforeunload` |
| In-memory index | `Map<cellKey, {edits: Uint8Array, count, dirty, revision}>`, resident for cells within 320 m of the player, LRU capacity 512 cells |
| Compaction | When a cell exceeds 3072 edits, run a merge pass: any two edits with `|c_a - c_b| < 0.35 * min(R_a, R_b)` and `|R_a - R_b| < 0.25 m` are merged into one with the union radius and `max(strength)`. Deterministic (scan in `tick` order). Typically reclaims 30-50% |
| Overflow | At 4096 edits a cell refuses new edits and the tool reports "material exhausted here". This is a designed limit, not a failure; a 64 m cell with 4096 spheres is already fully hollowed |

`localStorage` holds only the world index (seed, `GEN_VERSION`, tier, attempt index, last position) - under 1 KB. All bulk data is IndexedDB.

### 12.4 Applying edits at generation time

**Volumetric path (the normal case).** Any edit forces its overlapping CVCs `active = true` and `editRevision++`. On the next generation, the CVC's `F` includes `Fedit` and marching cubes produces the crater, including the overhang that a spherical excavation naturally creates. This is why mining and overhangs share machinery.

**Heightfield path (the far-field case).** A CVC only exists within `CVC view distance` (90-220 m). Beyond that, a mined crater must still be visible or the world would visibly heal at range. So `H(x,z)` includes layer L13:

```
// Only edits whose sphere reaches the heightfield surface contribute.
Hedit(x, z) = - sum over edits i with |H_base(x,z) - cy_i| < R_i of
                strength_i * depthScale * pow2(max(0, 1 - dist2D(x,z, c_i.xz) / R_i))
depthScale = 1.0 m per field unit
```

This is a heightfield approximation of the volumetric result: correct in silhouette from a distance, wrong in the details (no overhang). The transition happens at the CVC boundary and is invisible because the CVC's suppression mask hides the heightfield exactly where the two disagree.

**Invalidation.** Creating an edit:
1. Writes to the in-memory cell index, marks dirty.
2. Posts an `EDIT_ADD` message to every worker (20 B, negligible).
3. Bumps `editRevision` on all terrain nodes and CVCs whose AABB the sphere touches (expanded by `R + 2 m`).
4. Those nodes/CVCs are re-requested at priority 0 (ahead of everything). Typical regeneration latency: 1 CVC = 6 ms, 4 terrain nodes = 7 ms; both complete within 1-2 frames, so mining feels immediate.
5. For instant visual feedback in the same frame, a **decal particle burst** and a temporary screen-space depression are drawn (section 05); by the time it fades (0.25 s) the real geometry has arrived.

**Scatter interaction.** Any scatter instance whose position falls inside an edit sphere is removed. Because scatter placement is a pure function, removal is implemented as a filter in the scatter tile job: after placing an instance, test it against the edit cells overlapping the tile. A tile is regenerated whenever an overlapping edit cell's revision changes.

**Ore depletion.** Mining an ore node sets `flags` bit5 in a separate persisted store `oreDepleted` (a `Set` of quantised positions, 8 B each, in the same edit cell keying). Depleted nodes still render (with a spent material) so the world does not visibly lose objects.

---

## 13. MEMORY AND PERFORMANCE SUMMARY

**Table 13.1 - GPU memory by subsystem (Ultra / High / Medium / Low, MB)**

| Subsystem | Ultra | High | Medium | Low |
|-----------|-------|------|--------|-----|
| Terrain vertex pool | 30.1 | 20.1 | 12.5 | 7.5 |
| Terrain descriptors (3x ring) | 0.06 | 0.04 | 0.03 | 0.02 |
| Shared terrain index buffer | 0.014 | 0.014 | 0.014 | 0.014 |
| Cave vertex pool | 24.0 | 16.0 | 10.0 | 6.0 |
| Cave index pool | 12.0 | 8.0 | 5.0 | 3.0 |
| Suppress atlas (r8uint 512^2 x64) | 16.8 | 16.8 | 8.4 | 4.2 |
| Scatter instance pool | 48.0 | 32.0 | 20.0 | 12.0 |
| Scatter cull output + indirect | 2.1 | 1.3 | 0.7 | 0.3 |
| Procedural mesh vert+index | 6.1 | 6.1 | 4.4 | 3.0 |
| Imposter atlases | 33.6 | 33.6 | 8.4 | 0.0 |
| **Terrain-section GPU total** | **172.8** | **134.0** | **69.4** | **36.0** |

**Table 13.2 - CPU memory by subsystem (MB)**

| Subsystem | Ultra | Low |
|-----------|-------|-----|
| Erosion delta maps (main) | 4.2 | 4.2 |
| Erosion delta maps (per worker x4) | 16.8 | 8.4 (2 workers) |
| Coarse proxy heightmap | 1.05 | 1.05 |
| Height cache | 1.11 | 0.55 |
| CVC collision data | 16.8 | 4.2 |
| Cave graph LRU (per worker) | 4.8 | 2.4 |
| Edit index | 5.2 | 5.2 |
| Node/tile bookkeeping | 2.4 | 0.9 |
| Worker scratch fields | 0.69 | 0.34 |
| **Total** | **53.1** | **27.2** |

**Table 13.3 - Frame triangle budget (Ultra, worst case, above water looking at the shelf break)**

| Source | Triangles |
|--------|-----------|
| Terrain main pass | 885,000 |
| Terrain shadow (3 cascades) | 180,000 |
| Caves | 190,000 |
| Scatter | 1,580,000 |
| Vessel + interior (section 04) | 180,000 |
| Fauna (section 06) | 240,000 |
| **Total** | **3,255,000** |

At 60 fps this is 195 Mtri/s of submission, comfortably within an M1's capability for simple vertex work given that terrain and scatter both use compact vertex formats and storage-buffer fetches rather than large vertex buffers.

---

## 14. VALIDATION, DEBUG, AND TEST HOOKS

| Tool | Key | Behaviour |
|------|-----|-----------|
| Wireframe terrain | `F3` then `1` | Renders the terrain cut in wireframe, colour-coded by LOD level |
| LOD heat map | `F3` then `2` | Per-node colour = LOD level; shows the ring structure |
| Chunk state overlay | `F3` then `3` | Text overlay: queued/generating/ready/resident counts, per-frame upload count, job latency p50/p95 |
| CVC bounds | `F3` then `4` | Wireframe boxes of active CVCs, tinted by `breaksSurface` |
| Cave graph | `F3` then `5` | Draws the capsule skeleton of the local macro cells as lines |
| Suppress mask | `F3` then `6` | Renders the suppress atlas as a ground decal |
| Scatter density | `F3` then `7` | Per-category instance counts, and a top-down density heat map |
| Determinism probe | `F3` then `0` | Re-runs the 64 probe evaluations and prints the hash vs. the stored one |
| Bathymetry map | `F3` then `M` | Full-world top-down render of the coarse proxy with the crater, canyon, trench, and rim labelled |
| Seed reroll | dev console `subwave.reseed(n)` | Regenerates from a new seed without a page reload; used for art review |

**Automated bake-time assertions** (all abort world creation with a diagnostic on failure):

1. All safe-start invariants of 5.3.
2. Shelf-break slope statistics of 4.5.
3. `H()` is finite and within `[Y_MIN, Y_MAX]` at 100,000 Halton-sampled points.
4. No cave capsule within 40 m of the surface for `r < 700 m`.
5. Trench floor reaches `<= -3300 m` somewhere.
6. Crater rim crest is above `-460 m` over at least 60% of azimuths outside the breach.
7. The canyon is continuous: the coarse proxy along the centreline is monotonically non-increasing to within 12 m over 95% of its length.
8. Determinism probe hash matches, computed twice with different worker counts (1 and 4).

**Golden-image regression:** 12 fixed camera poses (listed in `test/poses.js`) are rendered at 1280x720 with a fixed seed and compared against stored perceptual hashes. Terrain geometry changes intentionally break these; they exist to catch unintended ones.

---

## 15. IMPLEMENTATION ORDER (recommended, non-binding)

1. `exactmath.js` + `noise.js` + the determinism probe harness. Nothing else can be trusted until this is done and the probe is green.
2. `P(r)` + `Cmacro` + the coarse proxy, rendered as a single debug mesh. Validates the crater/shelf/trench read before any streaming exists.
3. Terrain quadtree, single-draw instanced rendering, stitching, skirts, morphing. Flat-shaded, no materials.
4. Worker pool, streaming, height cache, player collision. This is the first playable build.
5. Erosion bake + delta maps + IndexedDB. The world stops looking like noise.
6. Scatter placement + one procedural mesh (rock) + GPU cull. Density is the biggest perceived-quality jump.
7. The remaining procedural meshes, then imposters.
8. Volumetric layer: field, marching cubes, stitching, cave graph. Then overhangs, then arches.
9. Mining edits, persistence, invalidation.
10. Debug tooling and the assertion suite (in practice, build these incrementally alongside 2-9).

---

## 16. ASSUMPTIONS ABOUT OTHER SECTIONS

These are consumed by section 02 and must be confirmed:

- Section 01 owns the authoritative biome list; section 02 assumes IDs 0-17 exactly as in Table 5.2, and that no biome is added without a corresponding row in Tables 8.1 and 9.2.
- Section 03 provides `fogFarDistance` (distance at transmittance 0.008), `currentVec(pos, t)` in m/s, and `waveOrbitalVelocity(pos, t)` in m/s, all as WGSL functions in a shared include; section 02's LOD clamp and kelp animation depend on them.
- Section 03 guarantees no direct sun contribution below `y = -180 m`, which section 02 uses to disable shadow cascades there.
- Section 04 provides the vessel's 7-sphere collision approximation and its maximum speeds (72 m/s air, 24 m/s water) used in the streaming targets of 11.4.
- Section 05 owns terrain and scatter materials and consumes the per-vertex `biomeA/biomeB/blend/ao/sediment/flags` channels defined in 5.4, and the scatter `param` sway channel from section 10.
- Section 06 consumes the coarse proxy heightmap and the CVC solid bitfield for creature spawning and avoidance, and must not require a finer collision query than Tier 1.
- Section 07 owns tool strength-to-`Edit.strength` mapping and ore yields; section 02 guarantees only the geometric semantics of `Edit` and the placement of ore nodes.
- Section 10 (persistence) owns the IndexedDB schema version; section 02 requires two stores (`erosionMaps`, `edits`) and one auxiliary (`oreDepleted`).

---

*End of section 02.*
