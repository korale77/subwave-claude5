/**
 * SUBWAVE vessel geometry - the Kestrel, generated from numbers only.
 *
 * Nothing here is loaded. The hull is a superellipse cross-section lofted along
 * a monotone spine, the canopy is a clipped ellipsoid seated on that loft by a
 * collar that follows it, the nacelles are lathed ducts with twisted blades, and
 * the skids are swept tubes. Every normal is analytic (no averaging of face normals, which would
 * round off the hard chines that make the silhouette readable) and every part
 * is deterministic: the same seed produces byte-identical vertices forever.
 *
 * The hull's principal dimensions come from VESSEL.LENGTH / BEAM / HEIGHT, and
 * they are consistent with VESSEL.AIR_REFERENCE_AREA: 7.4 x 4.2 planform gives
 * 22.4 m^2 at a 0.72 superellipse fill factor, 7.4 x 2.6 side gives 9.6 m^2,
 * and 4.2 x 2.6 frontal gives 6.1 m^2. The Kestrel is a wide lifting body with
 * four ducted fans slung under its own planform, not a fuselage with wings.
 *
 * Output is a single interleaved vertex buffer (48 B stride: position, normal,
 * tangent+sign, uv) plus a u32 index buffer, split into PARTS. Each part names
 * a NODE, and nodes carry their own animated transform (nacelle tilt, rotor
 * spin, skid retraction) so the renderer can move sub-assemblies without
 * re-uploading geometry.
 */

import { vec3, clamp, lerp, TAU, PI, makeRng } from '../core/math.js';
import { VESSEL } from '../core/constants.js';

/** Bytes per vertex: position(12) + normal(12) + tangent(16) + uv(8). */
export const VESSEL_VERTEX_STRIDE = 48;
export const VESSEL_FLOATS_PER_VERTEX = VESSEL_VERTEX_STRIDE / 4;

/** Deterministic generator seed. Changing it changes the mesh. */
export const VESSEL_MESH_SEED = 0x55410001;

/**
 * Animated nodes. Part -> node is many-to-one; the renderer uploads one model
 * matrix per node per frame plus its previous-frame matrix for motion vectors.
 */
export const VESSEL_NODE = {
  HULL: 0,
  NACELLE_FL: 1,
  NACELLE_FR: 2,
  NACELLE_RL: 3,
  NACELLE_RR: 4,
  ROTOR_FL: 5,
  ROTOR_FR: 6,
  ROTOR_RL: 7,
  ROTOR_RR: 8,
  SKIDS: 9,
};
export const VESSEL_NODE_COUNT = 10;

/** Material ids consumed by shaders/pass/entity.wgsl. */
export const VESSEL_MATERIAL = {
  HULL: 0,
  CANOPY: 1,
  NACELLE: 2,
  ROTOR: 3,
  SKID: 4,
  EMISSIVE: 5,
  CABIN: 6,
};

/**
 * Hull station table. `s` is the normalised spine parameter (0 = nose tip),
 * `a` half-beam, `b` half-height, `yc` the spine's vertical bow, `n` the
 * superellipse exponent (2 = ellipse, 4.4 = the slab-sided midbody).
 *
 * The exponent ramp is what gives the Kestrel its look: round at the ends where
 * it has to shed water, boxy amidships where it has to carry a pressure hull.
 */
const HULL_STATIONS = [
  //  s      a      b      yc     n
  [0.000, 0.050, 0.040, -0.100, 2.40],
  [0.050, 0.420, 0.200, -0.120, 2.80],
  [0.120, 0.860, 0.380, -0.120, 3.20],
  [0.220, 1.360, 0.580, -0.090, 3.80],
  [0.340, 1.780, 0.760, -0.050, 4.20],
  [0.450, 2.020, 0.860, -0.020, 4.40],
  [0.550, 2.100, 0.900, 0.000, 4.40],
  [0.660, 2.020, 0.880, 0.020, 4.20],
  [0.760, 1.820, 0.800, 0.040, 3.90],
  [0.850, 1.500, 0.660, 0.060, 3.50],
  [0.920, 1.120, 0.500, 0.070, 3.10],
  [0.970, 0.660, 0.300, 0.080, 2.80],
  [1.000, 0.160, 0.080, 0.080, 2.50],
];

/** Vertex counts per quality tier: [hull stations, hull ring, nacelle segments]. */
const TIER_RESOLUTION = [
  { stations: 24, ring: 20, lathe: 16, blades: 5, skidSegments: 12 },   // LOW
  { stations: 32, ring: 28, lathe: 24, blades: 7, skidSegments: 18 },   // MEDIUM
  { stations: 48, ring: 40, lathe: 32, blades: 7, skidSegments: 24 },   // HIGH
];

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

/**
 * Fritsch-Carlson monotone cubic Hermite. A natural cubic spline through the
 * station table overshoots between the widely-spaced midbody keys and puts a
 * visible waist in the hull; the monotone filter clamps the tangents so the
 * interpolant can never leave the interval its neighbours bracket.
 *
 * @param {number[]} xs strictly increasing knots
 * @param {number[]} ys values
 * @returns {Float64Array} per-knot tangents
 */
function monotoneTangents(xs, ys) {
  const n = xs.length;
  const d = new Float64Array(n - 1);
  const m = new Float64Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) * 0.5;
  }
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const h = Math.hypot(a, b);
    if (h > 3) {
      const t = 3 / h;
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return m;
}

/** Evaluate a monotone Hermite spline and its derivative at x. */
function hermiteEval(xs, ys, ms, x, out) {
  const n = xs.length;
  let i = 0;
  while (i < n - 2 && x > xs[i + 1]) i++;
  const h = xs[i + 1] - xs[i];
  const t = clamp((x - xs[i]) / h, 0, 1);
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  out[0] = h00 * ys[i] + h10 * h * ms[i] + h01 * ys[i + 1] + h11 * h * ms[i + 1];
  const g00 = 6 * t2 - 6 * t;
  const g10 = 3 * t2 - 4 * t + 1;
  const g01 = -6 * t2 + 6 * t;
  const g11 = 3 * t2 - 2 * t;
  out[1] = (g00 * ys[i] + g01 * ys[i + 1]) / h + g10 * ms[i] + g11 * ms[i + 1];
  return out;
}

/**
 * The station table's monotone tangents, built once.
 *
 * buildHull() and buildHullSections() each rebuild these locally because they
 * consume them in bulk; the lamp seats need a single section at an arbitrary z,
 * and re-solving four splines per lamp to get it would be absurd.
 */
const HULL_SPLINE = (() => {
  const xs = HULL_STATIONS.map((k) => k[0]);
  const av = HULL_STATIONS.map((k) => k[1]);
  const bv = HULL_STATIONS.map((k) => k[2]);
  const yv = HULL_STATIONS.map((k) => k[3]);
  const nv = HULL_STATIONS.map((k) => k[4]);
  return {
    xs, av, bv, yv, nv,
    am: monotoneTangents(xs, av),
    bm: monotoneTangents(xs, bv),
    ym: monotoneTangents(xs, yv),
    nm: monotoneTangents(xs, nv),
  };
})();

/**
 * Half-beam, half-height, spine offset and superellipse exponent at spine
 * parameter `s`, written into `out` as [a, b, yc, n].
 */
function hullSectionAt(s, out) {
  const h = HULL_SPLINE;
  hermiteEval(h.xs, h.av, h.am, s, _ev); out[0] = _ev[0];
  hermiteEval(h.xs, h.bv, h.bm, s, _ev); out[1] = _ev[0];
  hermiteEval(h.xs, h.yv, h.ym, s, _ev); out[2] = _ev[0];
  hermiteEval(h.xs, h.nv, h.nm, s, _ev); out[3] = _ev[0];
  return out;
}

const _topSec = new Float32Array(4);

/**
 * Height of the hull skin directly above (x, z) - the top branch of the station
 * superellipse, which inverts in closed form because |x/a|^n + |y/b|^n = 1.
 *
 * lampSeat() answers the neighbouring question (project a point onto the skin
 * along its own radius); this one holds x and z and solves for y, which is what
 * a part sitting ON the crown needs.
 *
 * |x| is clamped to the half-beam: past it there is no skin above the point at
 * all, and the honest answer there is the widest station point rather than a NaN
 * out of pow() on a negative base.
 *
 * THIS IS THE ANALYTIC SURFACE AND THE DRAWN ONE IS A CHORD APPROXIMATION THAT
 * LIES INSIDE IT, so a caller seating geometry against this must sink below the
 * result by more than the loft's own sagitta - measured at 8 mm at tier 0. See
 * COLLAR_SINK in buildCanopy().
 */
function hullTopY(x, z) {
  const s = clamp((z + VESSEL.LENGTH * 0.5) / VESSEL.LENGTH, 0, 1);
  hullSectionAt(s, _topSec);
  const a = _topSec[0], b = _topSec[1], yc = _topSec[2], n = _topSec[3];
  const r = Math.min(Math.abs(x) / a, 1);
  return yc + b * Math.pow(Math.max(0, 1 - Math.pow(r, n)), 1 / n);
}

/**
 * Signed-power superellipse. The sign/abs split is not cosmetic: pow() of a
 * negative base is NaN, and the naive form blows up on three quarters of the
 * ring.
 */
function superellipse(out, t, a, b, n) {
  const ct = Math.cos(t), st = Math.sin(t);
  const e = 2 / n;
  const act = Math.max(Math.abs(ct), 1e-4);
  const ast = Math.max(Math.abs(st), 1e-4);
  out[0] = a * Math.sign(ct || 1) * Math.pow(act, e);
  out[1] = b * Math.sign(st || 1) * Math.pow(ast, e);
  // d/dt. Note there is NO sign() factor here: d/du of sign(u)*|u|^e is
  // e*|u|^(e-1) for either sign of u, and carrying the sign through inverts the
  // tangent on half the ring - which inverts half the surface normals with it.
  out[2] = -a * e * Math.pow(act, e - 1) * st;
  out[3] = b * e * Math.pow(ast, e - 1) * ct;
  return out;
}

// ---------------------------------------------------------------------------
// Mesh accumulator
// ---------------------------------------------------------------------------

/** Growable interleaved vertex + index accumulator. Grows by doubling. */
class MeshBuilder {
  constructor(vertexGuess = 4096, indexGuess = 12288) {
    this.data = new Float32Array(vertexGuess * VESSEL_FLOATS_PER_VERTEX);
    this.indices = new Uint32Array(indexGuess);
    this.vertexCount = 0;
    this.indexCount = 0;
    this.parts = [];
    this._partStart = 0;
    this._partBaseVertex = 0;
  }

  _growVertices(needed) {
    const cap = this.data.length / VESSEL_FLOATS_PER_VERTEX;
    if (this.vertexCount + needed <= cap) return;
    let next = cap * 2;
    while (next < this.vertexCount + needed) next *= 2;
    const d = new Float32Array(next * VESSEL_FLOATS_PER_VERTEX);
    d.set(this.data);
    this.data = d;
  }

  _growIndices(needed) {
    if (this.indexCount + needed <= this.indices.length) return;
    let next = this.indices.length * 2;
    while (next < this.indexCount + needed) next *= 2;
    const a = new Uint32Array(next);
    a.set(this.indices);
    this.indices = a;
  }

  /**
   * @param {number[]|Float32Array} p position
   * @param {number[]|Float32Array} n normal (unit)
   * @param {number[]|Float32Array} tan tangent xyz + bitangent sign in w
   * @param {number} u
   * @param {number} v
   * @returns {number} vertex index, relative to the whole buffer
   */
  vertex(p, n, tan, u, v) {
    this._growVertices(1);
    const o = this.vertexCount * VESSEL_FLOATS_PER_VERTEX;
    const d = this.data;
    d[o] = p[0]; d[o + 1] = p[1]; d[o + 2] = p[2];
    d[o + 3] = n[0]; d[o + 4] = n[1]; d[o + 5] = n[2];
    d[o + 6] = tan[0]; d[o + 7] = tan[1]; d[o + 8] = tan[2]; d[o + 9] = tan[3];
    d[o + 10] = u; d[o + 11] = v;
    return this.vertexCount++;
  }

  /** Counter-clockwise triangle, matching Primitive.triangles frontFace 'ccw'. */
  triangle(a, b, c) {
    this._growIndices(3);
    this.indices[this.indexCount++] = a;
    this.indices[this.indexCount++] = b;
    this.indices[this.indexCount++] = c;
  }

  quad(a, b, c, d) {
    this.triangle(a, b, c);
    this.triangle(a, c, d);
  }

  beginPart() {
    this._partStart = this.indexCount;
    this._partBaseVertex = this.vertexCount;
  }

  /**
   * Close the current part. `extra` is merged in so a part can carry the tag a
   * renderer needs to address it - the lamp lenses use it to name their light
   * group, which is how passes/entities.js knows which lens to light.
   */
  endPart(name, node, material, extra) {
    this.parts.push(Object.assign({
      name,
      node,
      material,
      firstIndex: this._partStart,
      indexCount: this.indexCount - this._partStart,
      baseVertex: this._partBaseVertex,
      vertexCount: this.vertexCount - this._partBaseVertex,
    }, extra));
  }

  finish() {
    return {
      vertices: this.data.slice(0, this.vertexCount * VESSEL_FLOATS_PER_VERTEX),
      indices: this.indices.slice(0, this.indexCount),
      vertexCount: this.vertexCount,
      indexCount: this.indexCount,
      parts: this.parts,
    };
  }
}

// ---------------------------------------------------------------------------
// Part generators
// ---------------------------------------------------------------------------

const _se = new Float32Array(4);
const _seNext = new Float32Array(4);
const _pos = vec3.create();
const _nrm = vec3.create();
const _tanA = vec3.create();
const _tanB = vec3.create();
const _tan4 = new Float32Array(4);
const _ev = new Float32Array(2);

/**
 * Loft the hull. P(t, s) = (a(s)*fx(t), b(s)*fy(t) + yc(s), z(s)); the normal is
 * the normalised cross product of the two analytic tangents, which keeps the
 * four superellipse corners sharp instead of smearing them the way an averaged
 * face normal would.
 */
function buildHull(mb, res) {
  const xs = HULL_STATIONS.map((k) => k[0]);
  const av = HULL_STATIONS.map((k) => k[1]);
  const bv = HULL_STATIONS.map((k) => k[2]);
  const yv = HULL_STATIONS.map((k) => k[3]);
  const nv = HULL_STATIONS.map((k) => k[4]);
  const am = monotoneTangents(xs, av);
  const bm = monotoneTangents(xs, bv);
  const ym = monotoneTangents(xs, yv);
  const nm = monotoneTangents(xs, nv);

  const halfLen = VESSEL.LENGTH * 0.5;
  const stations = res.stations;
  const ring = res.ring;
  const base = mb.vertexCount;

  for (let i = 0; i < stations; i++) {
    const s = i / (stations - 1);
    hermiteEval(xs, av, am, s, _ev); const a = _ev[0], da = _ev[1];
    hermiteEval(xs, bv, bm, s, _ev); const b = _ev[0], db = _ev[1];
    hermiteEval(xs, yv, ym, s, _ev); const yc = _ev[0], dyc = _ev[1];
    hermiteEval(xs, nv, nm, s, _ev); const n = _ev[0], dn = _ev[1];
    const z = -halfLen + VESSEL.LENGTH * s;
    const dz = VESSEL.LENGTH;

    for (let j = 0; j <= ring; j++) {
      const t = (j / ring) * TAU;
      superellipse(_se, t, a, b, n);

      // dP/ds needs the exponent's own rate of change; a finite difference on
      // n alone is enough because n varies far more slowly than a and b.
      superellipse(_seNext, t, a, b, n + 1e-3);
      const dfx = (_seNext[0] - _se[0]) / 1e-3 * dn;
      const dfy = (_seNext[1] - _se[1]) / 1e-3 * dn;

      _pos[0] = _se[0];
      _pos[1] = _se[1] + yc;
      _pos[2] = z;

      // dP/dt (around the ring) and dP/ds (along the spine).
      vec3.set(_tanA, _se[2], _se[3], 0);
      vec3.set(_tanB, (da / a || 0) * _se[0] + dfx, (db / b || 0) * _se[1] + dfy + dyc, dz);
      // (dP/dt) x (dP/ds) is already outward for this ring/station winding; a
      // "does it point away from the spine" fix-up would be wrong at the nose
      // and tail, where the true normal is nearly axial.
      vec3.cross(_nrm, _tanA, _tanB);
      if (vec3.sqrLen(_nrm) < 1e-12) vec3.set(_nrm, _se[0], _se[1], 0);
      vec3.normalize(_nrm, _nrm);

      vec3.normalize(_tanA, _tanA);
      _tan4[0] = _tanA[0]; _tan4[1] = _tanA[1]; _tan4[2] = _tanA[2]; _tan4[3] = 1;
      mb.vertex(_pos, _nrm, _tan4, j / ring, s);
    }
  }

  const stride = ring + 1;
  for (let i = 0; i < stations - 1; i++) {
    for (let j = 0; j < ring; j++) {
      const v0 = base + i * stride + j;
      const v1 = base + i * stride + j + 1;
      const v2 = base + (i + 1) * stride + j + 1;
      const v3 = base + (i + 1) * stride + j;
      // Ring order (+j) is counter-clockwise in the station's XY plane and
      // (+i) runs aft, so (dP/dt) x (dP/ds) is the outward normal: v0-v1-v2-v3
      // is front-facing under frontFace 'ccw'.
      mb.quad(v0, v1, v2, v3);
    }
  }

  // Nose and tail caps. The end rings are 0.05 m and 0.16 m across, so a fan to
  // a single apex is invisible and costs 2 * ring triangles.
  buildCap(mb, base, stride, ring, 0, -halfLen, yv[0], -1);
  buildCap(mb, base + (stations - 1) * stride, stride, ring, stations - 1, halfLen, yv[yv.length - 1], 1);
}

function buildCap(mb, ringBase, stride, ring, stationIndex, z, yc, dir) {
  vec3.set(_pos, 0, yc, z);
  vec3.set(_nrm, 0, 0, dir);
  _tan4[0] = 1; _tan4[1] = 0; _tan4[2] = 0; _tan4[3] = 1;
  const apex = mb.vertex(_pos, _nrm, _tan4, 0.5, dir < 0 ? 0 : 1);
  // The ring runs counter-clockwise in XY, which reads clockwise when viewed
  // from -Z, so the nose fan is wound the opposite way from the tail fan.
  for (let j = 0; j < ring; j++) {
    const a = ringBase + j;
    const b = ringBase + j + 1;
    if (dir < 0) mb.triangle(apex, b, a);
    else mb.triangle(apex, a, b);
  }
}

/**
 * Canopy: a forward-raked ellipsoid, clipped below the sill and seated on the
 * crown by a collar. The rake is what sheds spray on a nose-first water entry,
 * and it is also the only asymmetry that tells the player which way the vessel
 * points from behind.
 *
 * THE SILL IS A PLANE AND THE CROWN IS NOT, SO THE RIM CANNOT SIT ON THE HULL
 * BY CONSTRUCTION AND MUST BE SEATED PER AZIMUTH. It shipped unseated: the rim
 * is the phi0 latitude circle of the ellipsoid, raked, i.e. a planar tilted
 * ellipse, while the hull crown under it runs 0.859 m at the aft rim and 0.338 m
 * at the forward one. Measured on the delivered mesh, the rim floated 0.113 m
 * (sides) to 0.272 m (nose end) above the skin at EVERY azimuth and every tier,
 * and because the shell has no cap ring the slot was a hole clean through to the
 * background - a playtest reported sky under the glass.
 *
 * NO RETUNE OF CENTER, RAKE OR SILL FIXES THAT, and that is why the collar
 * exists rather than a better number: dropping the 0.272 buries the sides
 * 0.16 m, dropping the 0.113 leaves 0.16 m of daylight at the nose, and the
 * best-fit plane (0.113 m down plus 3.5 deg of extra rake) still leaves 0.086 m
 * fore and aft while flattening the dome by a quarter. The collar drops each rim
 * vertex onto hullTopY() at its own (x, z), so it re-seats itself if the
 * ellipsoid is restyled or HULL_STATIONS is relofted.
 */
function buildCanopy(mb, res) {
  const CX = 0.66, CY = 0.52, CZ = 1.30;
  const CENTER = [0, 0.60, -1.35];
  const RAKE = -9 * (PI / 180);
  const SILL = 0.20;                 // clip plane in canopy-local y
  // How far the collar's bottom edge is buried in the hull. It has to exceed the
  // loft's own tessellation sagitta, because hullTopY() is the analytic surface
  // and the drawn hull is a chord approximation INSIDE it: measured 8 mm at
  // tier 0, 3 mm at tier 1, so 0.03 carries 3.7x the worst case.
  const COLLAR_SINK = 0.03;
  // The collar's uv.y. canopyDetail() in pass/entity.wgsl paints frame, not
  // glass, for uv.y <= 0, so the band shades as canopy framing with no shader
  // change; a negative value keeps uv.y monotone across it rather than leaving a
  // zero-extent strip for that shader's fwidth(uv.y) to measure.
  const COLLAR_V = -0.06;
  const azimuth = Math.max(16, res.ring - 8);
  const polar = Math.max(10, (res.stations >> 1) - 4);
  const base = mb.vertexCount;
  const cr = Math.cos(RAKE), sr = Math.sin(RAKE);
  // The sill ring, kept for the collar below rather than re-run through the
  // trig: [x, y, z, nx, nz] per azimuth vertex, normals already raked.
  const sill = new Float64Array((azimuth + 1) * 5);

  for (let i = 0; i <= polar; i++) {
    // Polar runs from the sill to the apex, so no vertex is ever discarded and
    // the ring topology stays a clean grid.
    const v = i / polar;
    const phi = lerp(Math.asin(clamp(SILL / CY, -1, 1)), PI * 0.5, v);
    const cy = Math.sin(phi), rr = Math.cos(phi);
    for (let j = 0; j <= azimuth; j++) {
      const u = j / azimuth;
      const th = u * TAU;
      const ex = rr * Math.cos(th);
      const ez = rr * Math.sin(th);

      const lx = CX * ex, ly = CY * cy, lz = CZ * ez;
      // Ellipsoid normal is the gradient of the implicit form, not the point.
      let nx = ex / CX, ny = cy / CY, nz = ez / CZ;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;

      _pos[0] = CENTER[0] + lx;
      _pos[1] = CENTER[1] + ly * cr - lz * sr;
      _pos[2] = CENTER[2] + ly * sr + lz * cr;
      _nrm[0] = nx;
      _nrm[1] = ny * cr - nz * sr;
      _nrm[2] = ny * sr + nz * cr;
      vec3.normalize(_nrm, _nrm);

      vec3.set(_tanA, -Math.sin(th), 0, Math.cos(th));
      _tan4[0] = _tanA[0]; _tan4[1] = _tanA[1]; _tan4[2] = _tanA[2]; _tan4[3] = 1;
      mb.vertex(_pos, _nrm, _tan4, u, v);

      if (i === 0) {
        const o = j * 5;
        sill[o] = _pos[0]; sill[o + 1] = _pos[1]; sill[o + 2] = _pos[2];
        sill[o + 3] = _nrm[0]; sill[o + 4] = _nrm[2];
      }
    }
  }

  const stride = azimuth + 1;
  for (let i = 0; i < polar; i++) {
    for (let j = 0; j < azimuth; j++) {
      const v0 = base + i * stride + j;
      const v1 = base + i * stride + j + 1;
      const v2 = base + (i + 1) * stride + j + 1;
      const v3 = base + (i + 1) * stride + j;
      // Azimuth runs in XZ and polar runs up in Y, so the outward normal is
      // (dP/dpolar) x (dP/dazimuth) - the reverse of the hull's convention.
      mb.quad(v0, v3, v2, v1);
    }
  }

  // The collar. Two rings - the seat on the hull, then the sill again - so the
  // band keeps the dome's own "i runs up" convention and its winding unchanged.
  // The sill row is DUPLICATED rather than shared: the collar meets the glass at
  // a hard chine, and sharing the row would average that edge round, which is
  // the one thing this file's analytic normals exist to avoid.
  const seatBase = mb.vertexCount;
  for (let ring = 0; ring < 2; ring++) {
    for (let j = 0; j <= azimuth; j++) {
      const o = j * 5;
      const x = sill[o], z = sill[o + 2];
      // The band is vertical, so its outward normal is the sill normal's
      // horizontal part and the canopy's plan footprint does not move.
      let nx = sill[o + 3], nz = sill[o + 4];
      const nl = Math.hypot(nx, nz);
      if (nl < 1e-6) { nx = 0; nz = -1; } else { nx /= nl; nz /= nl; }
      _pos[0] = x;
      _pos[1] = ring === 0 ? hullTopY(x, z) - COLLAR_SINK : sill[o + 1];
      _pos[2] = z;
      vec3.set(_nrm, nx, 0, nz);
      const th = (j / azimuth) * TAU;
      vec3.set(_tanA, -Math.sin(th), 0, Math.cos(th));
      _tan4[0] = _tanA[0]; _tan4[1] = _tanA[1]; _tan4[2] = _tanA[2]; _tan4[3] = 1;
      mb.vertex(_pos, _nrm, _tan4, j / azimuth, ring === 0 ? COLLAR_V : 0);
    }
  }
  for (let j = 0; j < azimuth; j++) {
    const v0 = seatBase + j;
    const v1 = seatBase + j + 1;
    const v2 = seatBase + stride + j + 1;
    const v3 = seatBase + stride + j;
    mb.quad(v0, v3, v2, v1);
  }
}

// --- cockpit coaming ---------------------------------------------------------
//
// THERE WAS NO COCKPIT. The eye at VESSEL.COCKPIT_EYE sat inside a back-face
// culled hull and a back-face culled canopy, so everything in a cockpit capture
// was the world, the screen-space HUD, and the two FORWARD NACELLES - which at
// the 2.11:1 QA aspect sit at atan2(1.85, 1.30) = 54.9 deg azimuth against a
// 57.9 deg horizontal half-FOV and are inside the frame by three degrees,
// filling both lower quadrants as unexplained pale blocks.
//
// THE SHELL'S NORMALS AND WINDING ALL FACE INWARD, and that is the whole safety
// argument: from any exterior view it presents only back faces, so the rasteriser
// discards it before it can write colour OR depth. It therefore cannot poke
// through the skin however the hull loft is retuned - the same mechanism that
// already hides the hull and the canopy from the cockpit eye, used in reverse.
//
// The rail is deliberately taller than the eye at the sides and lower than it in
// front: that is what a canopy rail is, it is what lets the pilot see out, and
// at 55 deg azimuth it is what finally puts something opaque between the eye and
// its own nacelle pylons.

/** Coaming plan: centre and half-axes of the lip ellipse, metres. */
const COAM_CZ = -0.50;
const COAM_AX = 0.62;
const COAM_AZ = 1.12;
/** Lip height ahead of the pilot (glareshield) and beside him (rail). The rail
 *  is 5 mm under the hull crown at that station, which is y = 0.825. */
const COAM_Y_SHIELD = 0.42;
const COAM_Y_RAIL   = 0.82;
/** Where the lip starts and finishes rising, as |angle| around the ellipse. */
const COAM_RISE_0 = 0.80;
const COAM_RISE_1 = 1.20;
/** Rings below the lip: [radial scale, height]. */
const COAM_RINGS = [
  0.72, 0.30,   // panel / console face
  0.55, 0.16,   // floor chine
  0.12, 0.12,   // floor
];

/** Lip height at angle `phi` around the coaming, phi = 0 dead ahead. */
function coamingLipY(phi) {
  const a = Math.abs(Math.atan2(Math.sin(phi), Math.cos(phi)));
  const t = clamp((a - COAM_RISE_0) / (COAM_RISE_1 - COAM_RISE_0), 0, 1);
  return lerp(COAM_Y_SHIELD, COAM_Y_RAIL, t * t * (3 - 2 * t));
}

/**
 * The cockpit coaming: glareshield, side consoles and floor as one closed shell
 * around the pilot, wound and normalled inward.
 */
function buildCoaming(mb, res) {
  // Twice the hull's ring count. The coaming is the only part of the vessel the
  // player ever sees from ONE METRE, and at the hull's 40 segments its lip was a
  // visibly polygonal arc across the middle of the cockpit view.
  const segs = Math.max(48, res.ring * 2);
  const rings = 1 + COAM_RINGS.length / 2;
  const base = mb.vertexCount;

  for (let i = 0; i < rings; i++) {
    const scale = i === 0 ? 1 : COAM_RINGS[(i - 1) * 2];
    for (let j = 0; j <= segs; j++) {
      const phi = (j / segs) * TAU;
      const sp = Math.sin(phi), cp = Math.cos(phi);
      const y = i === 0 ? coamingLipY(phi) : COAM_RINGS[(i - 1) * 2 + 1];
      _pos[0] = COAM_AX * scale * sp;
      _pos[1] = y;
      _pos[2] = COAM_CZ - COAM_AZ * scale * cp;

      // Surface normal from the profile's own slope in the (radial, y) plane.
      // lathe()'s formula assumes the profile is walked bottom-to-top and gives
      // the OUTWARD normal; this one is walked lip-to-floor, which flips its
      // sense - so the same expression is already the inward-facing normal, and
      // negating it would put the shell's front faces on the outside. The radial
      // direction is the ellipse GRADIENT, not the position vector: on an
      // ellipse those differ, and using the position tilts every console face
      // by the eccentricity.
      const iPrev = Math.max(0, i - 1), iNext = Math.min(rings - 1, i + 1);
      const sPrev = iPrev === 0 ? 1 : COAM_RINGS[(iPrev - 1) * 2];
      const sNext = iNext === 0 ? 1 : COAM_RINGS[(iNext - 1) * 2];
      const yPrev = iPrev === 0 ? coamingLipY(phi) : COAM_RINGS[(iPrev - 1) * 2 + 1];
      const yNext = iNext === 0 ? coamingLipY(phi) : COAM_RINGS[(iNext - 1) * 2 + 1];
      const dr = sNext - sPrev, dy = yNext - yPrev;
      const pl = Math.hypot(dr, dy) || 1;
      const nr = dy / pl, ny = -dr / pl;
      const gx = sp / COAM_AX, gz = -cp / COAM_AZ;
      const gl = Math.hypot(gx, gz) || 1;
      _nrm[0] = nr * (gx / gl);
      _nrm[1] = ny;
      _nrm[2] = nr * (gz / gl);
      vec3.normalize(_nrm, _nrm);

      _tanA[0] = COAM_AX * cp; _tanA[1] = 0; _tanA[2] = COAM_AZ * sp;
      vec3.normalize(_tanA, _tanA);
      _tan4[0] = _tanA[0]; _tan4[1] = _tanA[1]; _tan4[2] = _tanA[2]; _tan4[3] = 1;
      // uv.y is the CAVITY term: 0 at the open lip, 1 on the floor. The shell is
      // generated in code, so this ambient occlusion is exact and free, and it
      // is what makes the interior read as an enclosed volume rather than as
      // folded card.
      mb.vertex(_pos, _nrm, _tan4, j / segs, i / (rings - 1));
    }
  }

  const stride = segs + 1;
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const v0 = base + i * stride + j;
      const v1 = base + i * stride + j + 1;
      const v2 = base + (i + 1) * stride + j + 1;
      const v3 = base + (i + 1) * stride + j;
      // Reversed against lathe()'s order: (down) x (around) is the INWARD
      // normal, and inward is the only direction this shell may ever face.
      mb.quad(v0, v3, v2, v1);
    }
  }

  // Floor cap. The innermost ring is 12% of the plan, so this fan is 7 cm across.
  const inner = base + (rings - 1) * stride;
  vec3.set(_pos, 0, COAM_RINGS[COAM_RINGS.length - 1], COAM_CZ);
  vec3.set(_nrm, 0, 1, 0);
  _tan4[0] = 1; _tan4[1] = 0; _tan4[2] = 0; _tan4[3] = 1;
  const apex = mb.vertex(_pos, _nrm, _tan4, 0.5, 1);
  for (let j = 0; j < segs; j++) {
    mb.triangle(apex, inner + j + 1, inner + j);
  }
}

/**
 * Lathe a 2D profile (r, y pairs) about the local +Y axis.
 * `closeCap` seals the bottom, used by the rotor hub.
 */
function lathe(mb, profile, segments, uScale, vOffset) {
  const base = mb.vertexCount;
  const rings = profile.length / 2;
  for (let i = 0; i < rings; i++) {
    const r = profile[i * 2];
    const y = profile[i * 2 + 1];
    // Profile tangent, for the surface normal in the r-y plane.
    const ip = Math.max(0, i - 1), inx = Math.min(rings - 1, i + 1);
    const dr = profile[inx * 2] - profile[ip * 2];
    const dy = profile[inx * 2 + 1] - profile[ip * 2 + 1];
    const pl = Math.hypot(dr, dy) || 1;
    const nr = dy / pl, ny = -dr / pl;

    for (let j = 0; j <= segments; j++) {
      const th = (j / segments) * TAU;
      const c = Math.cos(th), s = Math.sin(th);
      _pos[0] = r * c; _pos[1] = y; _pos[2] = r * s;
      _nrm[0] = nr * c; _nrm[1] = ny; _nrm[2] = nr * s;
      vec3.normalize(_nrm, _nrm);
      _tan4[0] = -s; _tan4[1] = 0; _tan4[2] = c; _tan4[3] = 1;
      mb.vertex(_pos, _nrm, _tan4, (j / segments) * uScale, vOffset + i / (rings - 1));
    }
  }
  const stride = segments + 1;
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const v0 = base + i * stride + j;
      const v1 = base + i * stride + j + 1;
      const v2 = base + (i + 1) * stride + j + 1;
      const v3 = base + (i + 1) * stride + j;
      // (dP/dprofile) x (dP/dtheta) agrees with the profile normal for the
      // whole traversal, including the fold back down the duct's inner wall
      // where both the normal and the winding invert together.
      mb.quad(v0, v3, v2, v1);
    }
  }
  return base;
}

/**
 * One nacelle duct: an annular shroud (outer skin, lip, inner skin) plus a
 * pylon stub. Built at the origin in NACELLE space, with +Y the thrust axis at
 * zero tilt; the node transform places and tilts it.
 */
function buildNacelle(mb, res) {
  const R_OUT = 0.62;
  const R_IN = 0.50;
  const CHORD = 0.55;
  const LIP = 0.06;
  const top = CHORD * 0.5;
  const bot = -CHORD * 0.5;

  // Outer skin from the bottom rim up over the inlet lip, then down the inner
  // wall - one continuous lathe so the duct has no seam.
  const profile = [
    R_OUT - 0.02, bot,
    R_OUT, bot + CHORD * 0.22,
    R_OUT, top - LIP,
    R_OUT - LIP * 0.30, top - LIP * 0.25,
    R_IN + LIP * 0.35, top,
    R_IN, top - LIP * 0.45,
    R_IN, bot + CHORD * 0.15,
    R_IN + 0.03, bot,
  ];
  lathe(mb, profile, res.lathe, 1, 0);

  // Pylon: a short superelliptic stub extruded up from the duct crown toward
  // the hull underside, streamwise-elongated so it does not act as a bluff body.
  const base = mb.vertexCount;
  const segs = 12;
  const stations = 4;
  for (let i = 0; i <= stations; i++) {
    const s = i / stations;
    const halfX = lerp(0.150, 0.110, s);
    const halfZ = lerp(0.320, 0.260, s);
    const y = lerp(top - 0.02, top + 0.44, s);
    for (let j = 0; j <= segs; j++) {
      const t = (j / segs) * TAU;
      superellipse(_se, t, halfX, halfZ, 3.2);
      _pos[0] = _se[0];
      _pos[1] = y;
      _pos[2] = _se[1];
      // Section normal from the parametric derivative, rotated a quarter turn.
      _nrm[0] = _se[3];
      _nrm[1] = 0;
      _nrm[2] = -_se[2];
      vec3.normalize(_nrm, _nrm);
      if (_nrm[0] * _se[0] + _nrm[2] * _se[1] < 0) vec3.negate(_nrm, _nrm);
      _tan4[0] = 0; _tan4[1] = 1; _tan4[2] = 0; _tan4[3] = 1;
      mb.vertex(_pos, _nrm, _tan4, j / segs, s);
    }
  }
  const stride = segs + 1;
  for (let i = 0; i < stations; i++) {
    for (let j = 0; j < segs; j++) {
      const v0 = base + i * stride + j;
      const v1 = base + i * stride + j + 1;
      const v2 = base + (i + 1) * stride + j + 1;
      const v3 = base + (i + 1) * stride + j;
      mb.quad(v0, v3, v2, v1);
    }
  }
}

// --- lamp pods ---------------------------------------------------------------
//
// VESSEL_MATERIAL.EMISSIVE was declared, wired through passes/entities.js and
// consumed by pass/entity.wgsl, and used by ZERO geometry: every lamp cast light
// and not one of them had a housing. Underwater that is the largest single
// readability loss the vessel has - a submersible whose lamps have no visible
// lens is a shape with no front, and the measured ambient at 118 m is 0.0021, so
// a lens is the only thing in the frame with any contrast at all.
//
// The pods are BUILT ON THE SKIN, not placed at the mount coordinates. The
// mounts in VESSEL_LIGHT_MOUNTS are where the light SOURCE sits, and several of
// them are a few centimetres off the loft the generator actually produces - the
// underside lamp is 0.17 m inside it and the wide beams are outside it - so a
// cap dropped at those coordinates would either float or z-fight. lampSeat()
// projects each onto the hull's own superellipse instead, which is exact.

/** Barrel radius, lens radius, how far the pod is sunk into the skin, how far
 *  it stands proud, and the lens dome's rise. Metres. */
const POD_RADIUS  = 0.100;
const POD_LENS_R  = 0.078;
const POD_SINK    = 0.100;
const POD_RISE    = 0.075;
const POD_BULGE   = 0.026;

/** Light groups that get a pod: the three beam lamps. The cabin lamp points
 *  into a cockpit that has no geometry yet, and the strobe's lens would have to
 *  follow the xenon flash, which only vessel.js knows about. */
export const VESSEL_LAMP_PODS = ['flood', 'wide', 'work'];

const _sec = new Float32Array(4);
const _seat = vec3.create();
const _axis = vec3.create();
const _sideU = vec3.create();
const _sideV = vec3.create();

/**
 * Project a mount point onto the hull skin, along the ray from its own station's
 * spine centre.
 *
 * The section is |x/a|^n + |y/b|^n = 1, and both terms are homogeneous of the
 * same degree in a scale factor applied to (x, y), so the factor that puts the
 * point exactly on the curve inverts in closed form.
 */
function lampSeat(out, mount) {
  const halfLen = VESSEL.LENGTH * 0.5;
  const s = clamp((mount[2] + halfLen) / VESSEL.LENGTH, 0, 1);
  hullSectionAt(s, _sec);
  const a = _sec[0], b = _sec[1], yc = _sec[2], n = _sec[3];
  let dx = mount[0], dy = mount[1] - yc;
  // A mount exactly on the spine has no radial direction; the only sensible
  // reading of "on the hull" there is straight down.
  if (Math.hypot(dx, dy) < 1e-5) { dx = 0; dy = -1; }
  const k = Math.pow(
    Math.pow(Math.abs(dx / a), n) + Math.pow(Math.abs(dy / b), n), -1 / n);
  out[0] = dx * k;
  out[1] = yc + dy * k;
  out[2] = mount[2];
  return out;
}

/**
 * Orthonormal frame about a beam axis, ordered so that (u, axis, v) has the same
 * handedness as (X, Y, Z) - which is what lets latheAlong() reuse lathe()'s
 * winding and normal conventions unchanged.
 */
function lampBasis(aim) {
  vec3.set(_axis, aim[0], aim[1], aim[2]);
  vec3.normalize(_axis, _axis);
  vec3.anyPerpendicular(_sideU, _axis);
  vec3.normalize(_sideU, _sideU);
  vec3.cross(_sideV, _sideU, _axis);
}

/**
 * Lathe a (radius, distance-along-axis) profile about the frame lampBasis()
 * just built, centred on `seat`. Same profile-normal and winding rules as
 * lathe(); only the frame differs.
 */
function latheAlong(mb, seat, profile, segments) {
  const base = mb.vertexCount;
  const rings = profile.length / 2;
  for (let i = 0; i < rings; i++) {
    const r = profile[i * 2];
    const t = profile[i * 2 + 1];
    const ip = Math.max(0, i - 1), inx = Math.min(rings - 1, i + 1);
    const dr = profile[inx * 2] - profile[ip * 2];
    const dt = profile[inx * 2 + 1] - profile[ip * 2 + 1];
    const pl = Math.hypot(dr, dt) || 1;
    const nr = dt / pl, na = -dr / pl;

    for (let j = 0; j <= segments; j++) {
      const th = (j / segments) * TAU;
      const c = Math.cos(th), s = Math.sin(th);
      for (let k = 0; k < 3; k++) {
        _pos[k] = seat[k] + _sideU[k] * (r * c) + _axis[k] * t + _sideV[k] * (r * s);
        _nrm[k] = _sideU[k] * (nr * c) + _axis[k] * na + _sideV[k] * (nr * s);
        _tanA[k] = -_sideU[k] * s + _sideV[k] * c;
      }
      vec3.normalize(_nrm, _nrm);
      _tan4[0] = _tanA[0]; _tan4[1] = _tanA[1]; _tan4[2] = _tanA[2]; _tan4[3] = 1;
      mb.vertex(_pos, _nrm, _tan4, j / segments, i / (rings - 1));
    }
  }
  const stride = segments + 1;
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const v0 = base + i * stride + j;
      const v1 = base + i * stride + j + 1;
      const v2 = base + (i + 1) * stride + j + 1;
      const v3 = base + (i + 1) * stride + j;
      mb.quad(v0, v3, v2, v1);
    }
  }
}

/**
 * One lamp pod. `part` selects which half is emitted, because the two live in
 * different parts: BARREL is hull material on the hull node, LENS is
 * VESSEL_MATERIAL.EMISSIVE so passes/entities.js can drive its radiance from
 * whether that group is actually switched on. Both are generated from the same
 * seat and the same basis, so they cannot drift apart.
 */
function buildLampPod(mb, mount, aim, segments, lens) {
  lampSeat(_seat, mount);
  lampBasis(aim);
  const segs = Math.max(10, segments);
  if (lens) {
    // A shallow dome, so the lens catches a moving highlight instead of
    // reading as a flat sticker when it is switched off.
    latheAlong(mb, _seat, [
      POD_LENS_R, POD_RISE,
      POD_LENS_R * 0.72, POD_RISE + POD_BULGE * 0.55,
      POD_LENS_R * 0.40, POD_RISE + POD_BULGE * 0.88,
      0.0008, POD_RISE + POD_BULGE,
    ], segs);
  } else {
    latheAlong(mb, _seat, [
      POD_RADIUS, -POD_SINK,
      POD_RADIUS, POD_RISE * 0.45,
      POD_RADIUS * 0.94, POD_RISE * 0.80,
      POD_LENS_R, POD_RISE,
    ], segs);
  }
}

/** Every beam lamp's barrel, emitted into the hull part. */
function buildLampBarrels(mb, res) {
  for (let g = 0; g < VESSEL_LAMP_PODS.length; g++) {
    const id = VESSEL_LAMP_PODS[g];
    const mounts = VESSEL_LIGHT_MOUNTS[id];
    const aims = VESSEL_LIGHT_AIM[id];
    for (let i = 0; i < mounts.length; i++) {
      buildLampPod(mb, mounts[i], aims[i], res.lathe, false);
    }
  }
}

/**
 * Rotor: hub plus `count` twisted, tapered blades. Blades live on their own
 * node so the renderer spins them without touching the duct - and so the
 * motion-vector pass gets the spin for free.
 */
function buildRotor(mb, res) {
  // Profile runs bottom-to-top so the lathe's winding and its profile normal
  // agree (see lathe()).
  lathe(mb, [
    0.001, -0.12,
    0.060, -0.10,
    0.090, -0.04,
    0.085, 0.05,
    0.055, 0.11,
    0.001, 0.13,
  ], Math.max(10, res.lathe >> 1), 1, 0);

  const count = res.blades;
  const ROOT = 0.095, TIP = 0.475;
  const spanSteps = 6;
  const chordRoot = 0.185, chordTip = 0.092;
  const twistRoot = 0.42, twistTip = 0.42 - 0.244;   // -14 deg of washout

  for (let bIdx = 0; bIdx < count; bIdx++) {
    const bladeAngle = (bIdx / count) * TAU;
    const ca = Math.cos(bladeAngle), sa = Math.sin(bladeAngle);
    const base = mb.vertexCount;
    for (let i = 0; i <= spanSteps; i++) {
      const s = i / spanSteps;
      const r = lerp(ROOT, TIP, s);
      const chord = lerp(chordRoot, chordTip, s);
      const twist = lerp(twistRoot, twistTip, s);
      const ct = Math.cos(twist), st = Math.sin(twist);
      // 4 points around a thin cambered section: LE, upper, TE, lower.
      const thick = chord * 0.12 * (1 - 0.5 * s);
      const section = [
        [-chord * 0.5, 0],
        [-chord * 0.1, thick],
        [chord * 0.5, 0],
        [-chord * 0.1, -thick],
      ];
      for (let k = 0; k < 4; k++) {
        const cx = section[k][0], cy = section[k][1];
        // Rotate the section by the local twist about the span axis, then place
        // it at radius r around the hub.
        const px = cx * ct - cy * st;
        const py = cx * st + cy * ct;
        _pos[0] = r * ca - px * sa;
        _pos[1] = py;
        _pos[2] = r * sa + px * ca;
        // Outward direction of the section outline at this corner, twisted with
        // the section so the leading edge does not light like the suction face.
        const onx = SECTION_NORMAL[k][0], ony = SECTION_NORMAL[k][1];
        const nx = onx * ct - ony * st;
        const ny = onx * st + ony * ct;
        _nrm[0] = -nx * sa;
        _nrm[1] = ny;
        _nrm[2] = nx * ca;
        vec3.normalize(_nrm, _nrm);
        _tan4[0] = ca; _tan4[1] = 0; _tan4[2] = sa; _tan4[3] = 1;
        mb.vertex(_pos, _nrm, _tan4, k / 4, s);
      }
    }
    for (let i = 0; i < spanSteps; i++) {
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) & 3;
        const v0 = base + i * 4 + k;
        const v1 = base + i * 4 + k2;
        const v2 = base + (i + 1) * 4 + k2;
        const v3 = base + (i + 1) * 4 + k;
        mb.quad(v0, v1, v2, v3);
      }
    }
    // Root and tip caps. Without them a blade is an open tube and backface
    // culling puts a hole straight through it at every tip.
    const tip = base + spanSteps * 4;
    mb.triangle(tip, tip + 1, tip + 2);
    mb.triangle(tip, tip + 2, tip + 3);
    mb.triangle(base, base + 2, base + 1);
    mb.triangle(base, base + 3, base + 2);
  }
}

/** Outward in-plane direction at each of the four blade-section corners. */
const SECTION_NORMAL = [[-1, 0], [0, 1], [1, 0], [0, -1]];

/** Sweep a circle along a polyline. Used for both skid tubes. */
function sweepTube(mb, path, radius, radial) {
  const points = path.length / 3;
  const base = mb.vertexCount;
  const tangent = vec3.create();
  const normal = vec3.create();
  const binormal = vec3.create();
  const up = vec3.create(0, 1, 0);

  for (let i = 0; i < points; i++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(points - 1, i + 1);
    vec3.set(tangent,
      path[i1 * 3] - path[i0 * 3],
      path[i1 * 3 + 1] - path[i0 * 3 + 1],
      path[i1 * 3 + 2] - path[i0 * 3 + 2]);
    vec3.normalize(tangent, tangent);
    vec3.cross(binormal, up, tangent);
    if (vec3.sqrLen(binormal) < 1e-8) vec3.anyPerpendicular(binormal, tangent);
    vec3.normalize(binormal, binormal);
    vec3.cross(normal, tangent, binormal);

    for (let j = 0; j <= radial; j++) {
      const th = (j / radial) * TAU;
      const c = Math.cos(th), s = Math.sin(th);
      _nrm[0] = binormal[0] * c + normal[0] * s;
      _nrm[1] = binormal[1] * c + normal[1] * s;
      _nrm[2] = binormal[2] * c + normal[2] * s;
      _pos[0] = path[i * 3] + _nrm[0] * radius;
      _pos[1] = path[i * 3 + 1] + _nrm[1] * radius;
      _pos[2] = path[i * 3 + 2] + _nrm[2] * radius;
      _tan4[0] = tangent[0]; _tan4[1] = tangent[1]; _tan4[2] = tangent[2]; _tan4[3] = 1;
      mb.vertex(_pos, _nrm, _tan4, j / radial, i / (points - 1));
    }
  }

  const stride = radial + 1;
  for (let i = 0; i < points - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const v0 = base + i * stride + j;
      const v1 = base + i * stride + j + 1;
      const v2 = base + (i + 1) * stride + j + 1;
      const v3 = base + (i + 1) * stride + j;
      // Around-the-tube (+j) crossed with along-the-path (+i) is the outward
      // radial, so v0-v1-v2-v3 faces out.
      mb.quad(v0, v1, v2, v3);
    }
  }
}

// --- skid geometry ----------------------------------------------------------
//
// Exported rather than local, because the keel height and the tube radius
// together ARE the Kestrel's ground clearance, and two things outside this file
// need that: terrain.findSpawnPoint(), which parks it, and collision.js, whose
// hull probes are these same tubes. Every copy of these numbers that is not this
// one is a stance that silently stops matching the mesh.
/** Half-track: lateral offset of each skid tube from the centreline, metres. */
const SKID_TRACK = 1.18;
/** Half-length of the straight run, metres. */
const SKID_RUN = 1.55;
/** Height of the tube's CENTRELINE above the vessel origin - negative, i.e. below. */
export const VESSEL_SKID_KEEL = -1.10;
/** Tube radius, metres. */
export const VESSEL_SKID_RADIUS = 0.075;

/**
 * Distance from the vessel's origin down to the bottom of its skids, metres.
 *
 * The centreline sits VESSEL_SKID_KEEL below the origin over the whole straight
 * run, so the lowest point of the whole mesh is one tube radius below that.
 * Park the origin exactly this far above the ground and the Kestrel rests ON its
 * skids; park it any higher and it hovers, which is what half a metre of
 * arbitrary "hull clearance" in terrain.findSpawnPoint() was doing.
 */
export const VESSEL_SKID_DROP = -VESSEL_SKID_KEEL + VESSEL_SKID_RADIUS;

/** Two skids with upswept ends, plus three legs each. */
function buildSkids(mb, res) {
  const segments = res.skidSegments;
  const path = new Float32Array(segments * 3);

  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < segments; i++) {
      const s = i / (segments - 1);
      const z = lerp(-SKID_RUN, SKID_RUN, s);
      // Upswept ends: a smooth quartic lift over the outer 25% at each end.
      const edge = Math.max(0, Math.abs(z) / SKID_RUN - 0.72) / 0.28;
      const lift = 0.34 * edge * edge;
      path[i * 3] = side * SKID_TRACK;
      path[i * 3 + 1] = VESSEL_SKID_KEEL + lift;
      path[i * 3 + 2] = z;
    }
    sweepTube(mb, path, VESSEL_SKID_RADIUS, 8);

    for (let leg = 0; leg < 3; leg++) {
      const z = lerp(-1.15, 1.15, leg / 2);
      const legPath = Float32Array.of(
        side * SKID_TRACK * 0.55, -0.42, z,
        side * SKID_TRACK * 0.80, -0.72, z,
        side * SKID_TRACK, VESSEL_SKID_KEEL + 0.02, z,
      );
      sweepTube(mb, legPath, 0.045, 6);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the whole Kestrel.
 *
 * @param {object} [opts]
 * @param {number} [opts.tier] 0 low / 1 medium / 2 high
 * @returns {object} {vertices, indices, parts, nodes, bounds, boundingRadius,
 *                    stride, vertexCount, indexCount}
 */
export function buildVesselMesh({ tier = 2 } = {}) {
  const res = TIER_RESOLUTION[clamp(tier | 0, 0, 2)];
  const mb = new MeshBuilder();
  // The RNG exists so future cosmetic scatter (panel variation, decal
  // placement) stays deterministic; seeding it here fixes the sequence.
  const rng = makeRng(VESSEL_MESH_SEED);

  mb.beginPart();
  buildHull(mb, res);
  // The lamp barrels ride in the hull part: same node, same material, no extra
  // draw. Only the lenses need to be addressable on their own.
  buildLampBarrels(mb, res);
  mb.endPart('hull', VESSEL_NODE.HULL, VESSEL_MATERIAL.HULL);

  mb.beginPart();
  buildCanopy(mb, res);
  mb.endPart('canopy', VESSEL_NODE.HULL, VESSEL_MATERIAL.CANOPY);

  mb.beginPart();
  buildCoaming(mb, res);
  mb.endPart('coaming', VESSEL_NODE.HULL, VESSEL_MATERIAL.CABIN);

  // One emissive part per light group, so a lens can be dark when its group is
  // off and carry that group's own colour temperature when it is on.
  for (let g = 0; g < VESSEL_LAMP_PODS.length; g++) {
    const id = VESSEL_LAMP_PODS[g];
    const mounts = VESSEL_LIGHT_MOUNTS[id];
    const aims = VESSEL_LIGHT_AIM[id];
    mb.beginPart();
    for (let i = 0; i < mounts.length; i++) {
      buildLampPod(mb, mounts[i], aims[i], res.lathe, true);
    }
    mb.endPart(`lens_${id}`, VESSEL_NODE.HULL, VESSEL_MATERIAL.EMISSIVE,
      { lightGroup: id });
  }

  mb.beginPart();
  buildSkids(mb, res);
  mb.endPart('skids', VESSEL_NODE.SKIDS, VESSEL_MATERIAL.SKID);

  // Nacelles and rotors share one geometry each; only the node transform
  // differs, so they are emitted once per unit and drawn as four parts.
  const nacelleNodes = [
    VESSEL_NODE.NACELLE_FL, VESSEL_NODE.NACELLE_FR,
    VESSEL_NODE.NACELLE_RL, VESSEL_NODE.NACELLE_RR,
  ];
  const rotorNodes = [
    VESSEL_NODE.ROTOR_FL, VESSEL_NODE.ROTOR_FR,
    VESSEL_NODE.ROTOR_RL, VESSEL_NODE.ROTOR_RR,
  ];
  for (let i = 0; i < VESSEL.NACELLE_COUNT; i++) {
    mb.beginPart();
    buildNacelle(mb, res);
    mb.endPart(`nacelle${i}`, nacelleNodes[i], VESSEL_MATERIAL.NACELLE);
    mb.beginPart();
    buildRotor(mb, res);
    mb.endPart(`rotor${i}`, rotorNodes[i], VESSEL_MATERIAL.ROTOR);
  }

  const mesh = mb.finish();
  mesh.stride = VESSEL_VERTEX_STRIDE;
  mesh.nodeCount = VESSEL_NODE_COUNT;
  mesh.seed = VESSEL_MESH_SEED;
  mesh.tier = tier;
  // Consume one draw from the RNG so the seed is observably used and a future
  // cosmetic pass can continue the same stream.
  mesh.variantHash = Math.floor(rng() * 0xffffffff) >>> 0;

  // Bounds over the hull node only; nacelles and skids move, so the vessel's
  // cull radius is padded by the largest node offset instead.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const d = mesh.vertices;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const o = i * VESSEL_FLOATS_PER_VERTEX;
    if (d[o] < minX) minX = d[o];
    if (d[o] > maxX) maxX = d[o];
    if (d[o + 1] < minY) minY = d[o + 1];
    if (d[o + 1] > maxY) maxY = d[o + 1];
    if (d[o + 2] < minZ) minZ = d[o + 2];
    if (d[o + 2] > maxZ) maxZ = d[o + 2];
  }
  mesh.bounds = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
  mesh.boundingRadius = Math.max(
    Math.hypot(minX, minY, minZ), Math.hypot(maxX, maxY, maxZ)) +
    Math.max(...VESSEL.NACELLE_POSITIONS.map((p) => Math.hypot(p[0], p[1], p[2])));

  return mesh;
}

/**
 * Cross-sectional area of one superellipse station, by Green's theorem on the
 * parametric curve: A = |integral(x dy)| over one revolution. 64 points is
 * exact to 1e-6 for every exponent in the table, and this runs once at boot.
 */
function stationArea(a, b, n) {
  const N = 64;
  let area = 0;
  superellipse(_se, 0, a, b, n);
  let px = _se[0], py = _se[1];
  for (let i = 1; i <= N; i++) {
    const t = (i / N) * TAU;
    superellipse(_se, t, a, b, n);
    // Shoelace on the sampled polygon.
    area += px * _se[1] - _se[0] * py;
    px = _se[0];
    py = _se[1];
  }
  return Math.abs(area) * 0.5;
}

/**
 * Resample the hull loft into `count` physics stations for the buoyancy
 * integrator: half-beam, half-height, spine offset, superellipse exponent and
 * cross-sectional area, with the areas scaled so the trapezoidal integral of
 * the whole hull equals VESSEL.DISPLACEMENT exactly.
 *
 * Physics reads these, never the render mesh: a headless test must be able to
 * fly the vessel with no GPU, and the buoyancy answer must not change when the
 * player switches quality tier.
 */
export function buildHullSections(count = 15) {
  const xs = HULL_STATIONS.map((k) => k[0]);
  const av = HULL_STATIONS.map((k) => k[1]);
  const bv = HULL_STATIONS.map((k) => k[2]);
  const yv = HULL_STATIONS.map((k) => k[3]);
  const nv = HULL_STATIONS.map((k) => k[4]);
  const am = monotoneTangents(xs, av);
  const bm = monotoneTangents(xs, bv);
  const ym = monotoneTangents(xs, yv);
  const nm = monotoneTangents(xs, nv);

  const z = new Float32Array(count);
  const a = new Float32Array(count);
  const b = new Float32Array(count);
  const yc = new Float32Array(count);
  const n = new Float32Array(count);
  const area = new Float32Array(count);
  const dz = new Float32Array(count);
  const halfLen = VESSEL.LENGTH * 0.5;

  for (let i = 0; i < count; i++) {
    const s = i / (count - 1);
    hermiteEval(xs, av, am, s, _ev); a[i] = _ev[0];
    hermiteEval(xs, bv, bm, s, _ev); b[i] = _ev[0];
    hermiteEval(xs, yv, ym, s, _ev); yc[i] = _ev[0];
    hermiteEval(xs, nv, nm, s, _ev); n[i] = _ev[0];
    z[i] = -halfLen + VESSEL.LENGTH * s;
    area[i] = stationArea(a[i], b[i], n[i]);
    // Trapezoidal weight: half a span at the ends, a full span inside.
    const span = VESSEL.LENGTH / (count - 1);
    dz[i] = (i === 0 || i === count - 1) ? span * 0.5 : span;
  }

  let volume = 0;
  for (let i = 0; i < count; i++) volume += area[i] * dz[i];
  const scale = VESSEL.DISPLACEMENT / volume;
  for (let i = 0; i < count; i++) area[i] *= scale;

  return { count, z, a, b, yc, n, area, dz, rawVolume: volume, areaScale: scale };
}

/**
 * Local-space positions of the vessel's light emitters, in the same order as
 * VESSEL_LIGHTS' groups expect. Kept beside the mesh because they are geometry:
 * they must sit on the hull the generator actually produced.
 */
export const VESSEL_LIGHT_MOUNTS = {
  flood: [[-0.62, -0.22, -3.10], [0.62, -0.22, -3.10]],
  wide: [[-1.55, -0.30, -1.90], [1.55, -0.30, -1.90]],
  work: [[0.00, -0.66, -0.90]],
  cabin: [[0.00, 0.55, -1.35]],
  strobe: [[0.00, 0.94, 0.10]],
};

/**
 * Direction each mount aims, in local space. -Z is forward.
 *
 * These are also the axes buildLampPod() lathes each visible pod along, so the
 * lens you can see and the beam it casts point the same way by construction.
 *
 * THE FLOODS ARE TOED IN 1.6 DEG. Dead parallel, two emitters 1.24 m apart put
 * two separate discs on anything closer than about 8 m - which is exactly the
 * range a playtest was at when it reported "2 bright circles appearing on the
 * rocks". 0.028 of lateral against 1.0 of forward crosses the axes at ~22 m, so
 * the pair merges by 4-6 m and still spans the full width further out.
 *
 * THE WIDE BEAMS AIM FORWARD, NOT OUTBOARD. At [+/-0.42, -0.20, -0.88] they were
 * 25.5 deg off the centreline: with the beam's own half-angle they reached the
 * centreline and no further, so they lit the flanks and put NOTHING ahead of the
 * hull. They are the broad forward fill under the floods' core now, so they are
 * pulled in to 11.6 deg, where the two of them overlap ahead of the nose.
 */
export const VESSEL_LIGHT_AIM = {
  flood: [[0.028, -0.06, -1], [-0.028, -0.06, -1]],
  wide: [[-0.20, -0.16, -0.97], [0.20, -0.16, -0.97]],
  work: [[0, -0.77, -0.64]],
  cabin: [[0, -1, 0]],
  strobe: [[0, 1, 0]],
};
