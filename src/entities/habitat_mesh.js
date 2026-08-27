/**
 * Procedural mesh for the fixed Pelagos Habitat. No imported assets, no
 * construction UI, no textures.
 *
 * WHAT THIS FILE IS FOR, stated once so the next pass does not undo it.
 *
 * The first version of this building was cylinders with flat lids on sticks,
 * skinned with the Kestrel's materials. Photographed on the real approach it
 * had three faults that read as one, and all three were structural rather than
 * tuning:
 *
 *   1. It borrowed VESSEL_MATERIAL.HULL, so `platedSkin` scattered its 11%
 *      bare-alloy plate family - metallic 1, zero albedo, pure reflected
 *      ambient - over every module in half-metre Worley cells. On a 7.4 m
 *      airframe those are the occasional replaced panel. On a 50 m building
 *      under an ambient SH that dominates the frame, they were white confetti.
 *      (The 63.7%-of-frame figure once quoted here is a PRE-238fab9 number,
 *      measured when evalAmbient had no depth term; the conclusion does not
 *      depend on the exact share.)
 *      Worse, `TRIM_NOSE_Z = -2.55` is a livery constant derived for a hull
 *      spanning z -3.70..+3.70, and this body spans z -9.9..+7.4, so the ENTIRE
 *      airlock end and the aft third of the deck were painted hi-vis orange at
 *      0.92 mix. Both faults are cured by having our own materials; see
 *      HABITAT_MATERIAL and the habitat block in pass/entity.wgsl.
 *   2. It had no glazing anywhere, so nothing on it separated in value from the
 *      water. Sand Plains water at 33 m veils a uniformly bright object into the
 *      background; what survives a veil is CONTRAST, and the reference frames
 *      get theirs from dark window bands with a lit room behind them.
 *   3. Its airlock was an open-ended tube with a 720-intensity point light
 *      inside it - six times the Kestrel's searchlight - so the hatch rendered
 *      as a white sun. A hatch is a DOOR: a dished plate, a heavy flange, a
 *      round porthole, locking dogs, and two marker lamps.
 *
 * GEOMETRY IS BUILT FROM BANDS OF REVOLUTION, not from meshgen's cylinder().
 * cylinder() emits exactly two rings with v in {0, 1}, so it cannot carry a
 * window sill, a shoulder or a dome; and neither it nor torus() nor lathe()
 * honours a vScale, so none of them can produce the metre-space UVs the habitat
 * materials read. `revolve()` below does both, and openings cut real corridor
 * apertures rather than intersecting two skins.
 *
 * ALL UVs ARE IN METRES. u is arc length around a shell, v is distance along
 * its axis. That is what lets one 1.15 x 1.60 m panel grid be correct on a
 * 6.4 m module, a 1.7 m corridor and a flat deck at the same time.
 */

import { mat4 } from '../core/math.js';
import { MeshBuilder, cylinder, torus } from '../world/meshgen.js';
import { VESSEL_MATERIAL, VESSEL_VERTEX_STRIDE } from './vessel_mesh.js';

/**
 * Habitat-only material ids, continuing VESSEL_MATERIAL. Must match the
 * dispatch chain in render/shaders/pass/entity.wgsl.
 */
export const HABITAT_MATERIAL = Object.freeze({
  PANEL: 7,
  GLASS: 8,
  VIEWPORT: 9,
  INTERIOR: 10,
  /** Lit panels INSIDE a dry room. Separate from VESSEL_MATERIAL.EMISSIVE
   *  because the dry-interior flag is per PART, and the exterior marker lamps
   *  on the same building are genuinely under 33 m of water. */
  SCREEN: 11,
});

const TAU = Math.PI * 2;
const WHITE = Float32Array.of(1, 1, 1, 0);

// ---- transforms -----------------------------------------------------------

const at = (x, y, z) => mat4.fromTranslation(mat4.create(), [x, y, z]);

/** Local +Y mapped to world +X, so a shell built about Y becomes an X corridor. */
const alongX = (x, y, z) => Float32Array.of(
  0, -1, 0, 0,
  1, 0, 0, 0,
  0, 0, 1, 0,
  x, y, z, 1,
);
/** Local +Y mapped to world +Z, for the airlock trunk and any Z corridor. */
const alongZ = (x, y, z) => Float32Array.of(
  1, 0, 0, 0,
  0, 0, 1, 0,
  0, -1, 0, 0,
  x, y, z, 1,
);
/** Local +Y mapped to world -X. Right-handed, so merge() keeps the winding. */
const alongNegX = (x, y, z) => Float32Array.of(
  0, 1, 0, 0,
  -1, 0, 0, 0,
  0, 0, 1, 0,
  x, y, z, 1,
);
/** Local +Y mapped to world -Z. */
const alongNegZ = (x, y, z) => Float32Array.of(
  1, 0, 0, 0,
  0, 0, -1, 0,
  0, 1, 0, 0,
  x, y, z, 1,
);

// ---- primitives with metre UVs -------------------------------------------

/**
 * Surface of revolution about +Y through an explicit ring list, with real
 * apertures and UVs in metres.
 *
 * @param {Array<[number, number]>} rings [radius, y] bottom to top
 * @param {number} segments azimuthal divisions
 * @param {object} [opts]
 *   openings  corridor bores to cut, as {ax, u, y, r} - see cutQuad()
 *   inward    emit an interior skin: normals reversed AND winding reversed
 *             together, which is what meshgen has no option for and what
 *             test-habitat's face-winding check requires
 *   uRef      radius the u coordinate is measured at; defaults to the largest
 *             ring, so a tapered shell keeps one continuous panel pitch instead
 *             of one that stretches as the radius falls
 *   v0        starting v, metres, for chaining bands into one panel run
 * @returns {object} a meshgen build() struct
 */
function revolve(rings, segments, opts = {}) {
  const seg = Math.max(3, segments | 0);
  const openings = opts.openings || [];
  const inward = !!opts.inward;
  const n = rings.length;
  let uRef = opts.uRef;
  if (uRef == null) {
    uRef = 0;
    for (const [r] of rings) if (r > uRef) uRef = r;
  }

  const cols = seg + 1;
  const az = new Float64Array(cols);
  for (let j = 0; j < cols; j++) az[j] = (j / seg) * TAU;

  // Arc length along the profile is the v coordinate, so a dome's panels stay
  // square instead of compressing toward the apex.
  const v = new Float64Array(n);
  v[0] = opts.v0 ?? 0;
  for (let i = 1; i < n; i++) {
    v[i] = v[i - 1]
      + Math.hypot(rings[i][0] - rings[i - 1][0], rings[i][1] - rings[i - 1][1]);
  }

  const mb = new MeshBuilder(n * cols, n * cols * 6);
  const pos = new Float32Array(3), nrm = new Float32Array(3), uv = new Float32Array(2);
  const s = inward ? -1 : 1;

  // One vertex grid, then quads. The last column duplicates the first at
  // theta = TAU so u runs a clean 0..circumference rather than wrapping to zero
  // in the middle of a panel.
  for (let i = 0; i < n; i++) {
    const [r, y] = rings[i];
    // Profile normal: the (dr, dy) tangent rotated a quarter turn outward.
    const ip = Math.max(0, i - 1), inx = Math.min(n - 1, i + 1);
    const dr = rings[inx][0] - rings[ip][0];
    const dy = rings[inx][1] - rings[ip][1];
    const pl = Math.hypot(dr, dy) || 1;
    const nr = dy / pl, ny = -dr / pl;
    for (let j = 0; j < cols; j++) {
      const th = az[j];
      const c = Math.cos(th), sn = Math.sin(th);
      pos[0] = r * c; pos[1] = y; pos[2] = r * sn;
      nrm[0] = nr * c * s; nrm[1] = ny * s; nrm[2] = nr * sn * s;
      uv[0] = th * uRef; uv[1] = v[i];
      mb.addVertex(pos, nrm, uv, WHITE);
    }
  }

  for (let i = 0; i < n - 1; i++) {
    const ym = (rings[i][1] + rings[i + 1][1]) * 0.5;
    const rm = (rings[i][0] + rings[i + 1][0]) * 0.5;
    for (let j = 0; j < cols - 1; j++) {
      const th = (az[j] + az[j + 1]) * 0.5;
      let open = false;
      for (const bore of openings) {
        if (cutQuad(bore, rm * Math.cos(th), ym, rm * Math.sin(th))) { open = true; break; }
      }
      if (open) continue;
      // theta runs +X toward +Z, which is CLOCKWISE seen from +Y, so a quad
      // taken (lower-j, lower-j+1, upper-j+1) has its cross product pointing
      // INTO the shell. The outward winding is the reversed one - the same
      // correction meshgen's bridgeRings carries as its `flip` argument.
      const a = i * cols + j, b = a + 1, c = b + cols, d2 = a + cols;
      if (inward) { mb.addTriangle(a, b, c); mb.addTriangle(a, c, d2); }
      else { mb.addTriangle(a, c, b); mb.addTriangle(a, d2, c); }
    }
  }
  return mb.build();
}

/**
 * Flat annulus or disc in the XZ plane, facing +Y or -Y, UVs in metres.
 * Used for hatch faces, deck pads, module floors and ceilings.
 */
function disc(outerR, innerR, y, dir, segments, inward = false) {
  const seg = Math.max(3, segments | 0);
  const mb = new MeshBuilder((seg + 1) * 2, seg * 6);
  const pos = new Float32Array(3), nrm = new Float32Array(3), uv = new Float32Array(2);
  const s = inward ? -1 : 1;
  nrm[0] = 0; nrm[1] = dir * s; nrm[2] = 0;
  for (let ri = 0; ri < 2; ri++) {
    const r = ri === 0 ? innerR : outerR;
    for (let j = 0; j <= seg; j++) {
      const th = (j / seg) * TAU;
      pos[0] = r * Math.cos(th); pos[1] = y; pos[2] = r * Math.sin(th);
      uv[0] = pos[0]; uv[1] = pos[2];
      mb.addVertex(pos, nrm, uv, WHITE);
    }
  }
  const stride = seg + 1;
  // theta runs +X toward +Z, clockwise seen from +Y, so an up-facing fan winds
  // backwards and a down-facing one forwards. `inward` flips both together.
  const up = (dir * s) > 0;
  for (let j = 0; j < seg; j++) {
    const a = j, b = j + 1, c = stride + j + 1, d = stride + j;
    if (up) { mb.addTriangle(a, b, c); mb.addTriangle(a, c, d); }
    else { mb.addTriangle(a, c, b); mb.addTriangle(a, d, c); }
  }
  return mb.build();
}

/**
 * Axis-aligned slab with UVs in metres on every face, so the panel grid runs
 * continuously from a module onto the deck it stands on.
 *
 * meshgen's box() gives each face its own 0..1 quad, which on a 26 m deck would
 * put one panel joint across the whole thing.
 */
function slab(hx, hy, hz) {
  const mb = new MeshBuilder(24, 36);
  const pos = new Float32Array(3), nrm = new Float32Array(3), uv = new Float32Array(2);
  // normal, then the two in-plane axes the UV is measured along, then the four
  // corners CCW seen from outside.
  const faces = [
    [[1, 0, 0], 2, 1, [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]]],
    [[-1, 0, 0], 2, 1, [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]],
    [[0, 1, 0], 0, 2, [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]]],
    [[0, -1, 0], 0, 2, [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]],
    [[0, 0, 1], 0, 1, [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
    [[0, 0, -1], 0, 1, [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
  ];
  const h = [hx, hy, hz];
  for (const [nv, ua, va, corners] of faces) {
    const start = mb.vertexCount;
    nrm[0] = nv[0]; nrm[1] = nv[1]; nrm[2] = nv[2];
    for (const c of corners) {
      pos[0] = c[0] * hx; pos[1] = c[1] * hy; pos[2] = c[2] * hz;
      uv[0] = c[ua] * h[ua]; uv[1] = c[va] * h[va];
      mb.addVertex(pos, nrm, uv, WHITE);
    }
    mb.addTriangle(start, start + 1, start + 2);
    mb.addTriangle(start, start + 2, start + 3);
  }
  return mb.build();
}

/** Rescale a built mesh's UVs in place. For torus/cylinder, whose uv is 0..1. */
function metreUV(mesh, su, sv) {
  const uvs = mesh.uvs;
  for (let i = 0; i < uvs.length; i += 2) { uvs[i] *= su; uvs[i + 1] *= sv; }
  return mesh;
}

/**
 * Cylinder with its u and v converted from turns to metres.
 *
 * meshgen's cylUV() emits u = 0..1 around and v = 0..1 along, and every
 * habitat material reads uv in METRES - a 1.15 m panel grid against a 0..1 UV
 * puts the whole grid inside one texel. Anything on a habitat material has to
 * come through here, ringUV(), revolve(), disc() or slab().
 */
function cylUV(rb, rt, h, seg) {
  return metreUV(cylinder(rb, rt, h, seg, { color: WHITE }), TAU * Math.max(rb, rt), h);
}

/** Torus with its u and v converted from turns to metres of arc. */
function ringUV(major, minor, majorSeg = 32, minorSeg = 8) {
  return metreUV(torus(major, minor, majorSeg, minorSeg, { color: WHITE }),
    TAU * major, TAU * minor);
}

/**
 * Where a straight corridor of radius `tubeR` pierces a vertical drum of radius
 * `shellR` centred at (cx, cz), and how wide the hole has to be.
 *
 * `dirX` is +1/-1/0 and `offset` is the corridor's fixed coordinate on the other
 * horizontal axis - a hall on z = 1.85 leaving westward is (-1, 1.85). The exit
 * azimuth is NOT +/-PI/2 or 0 unless the hall happens to run through the module
 * centre, and three of the five corridors here do not: getting this wrong puts
 * the hole beside the tube and opens the room to the sea.
 *
 * The half-angle is exact. A point on the drum at azimuth t is distance
 * hypot(shellR*cos t, dy) from a corridor axis running along x, so the hole at
 * the axis height closes at |cos t| = tubeR/shellR.
 *
 * @returns {[number, number]} an `openings` entry: [azimuth, halfWidth]
 */
function bore(axis, offset, dir, radius, y = HALL_Y) {
  return { ax: axis, u: offset, d: Math.sign(dir), y, r: radius };
}

/**
 * True if a point on a shell lies inside a corridor bore.
 *
 * THE APERTURE IS A REAL CYLINDER INTERSECTION, in the shell's own local frame.
 * The obvious implementation - and the one this file shipped first - removes
 * quads by AZIMUTH alone, which cuts a full-height slot from the skirt to the
 * apex: photographed, the commons dome had three vertical gashes in it at the
 * three corridor bearings, and every drum was slit top to bottom. An aperture
 * is where a TUBE passes, so the test is the distance to the tube's axis line,
 * and the resulting hole is the ellipse it should be.
 *
 * IT IS A HALF-CYLINDER, and `d` is what makes it one. A bore is an infinite
 * line, so testing the distance alone cuts the hole TWICE - once where the
 * corridor is and once diametrically opposite, where there is nothing but sea.
 * Photographed from the commons, that put a second window-height hole in the
 * south wall through which the ladder on the drum's outside, the seabed and the
 * sky were all plainly visible.
 *
 * @param {{ax: string, u: number, d: number, y: number, r: number}} b bore: the
 *   axis it runs along, its fixed coordinate on the other horizontal axis, WHICH
 *   SIDE of the shell it leaves by, its height above the deck plane, and its
 *   radius. All in the SHELL's local frame.
 */
function cutQuad(b, px, py, pz) {
  const along = b.ax === 'x' ? px : pz;
  if (along * b.d <= 0) return false;
  const dy = py - b.y;
  const ds = b.ax === 'x' ? pz - b.u : px - b.u;
  return dy * dy + ds * ds < b.r * b.r;
}

// ---- site constants shared with habitat.js and habitat_site.js ------------

/**
 * Module centres, shell radii and heights, local XZ about the deck plane.
 *
 * `top` is the INTERIOR ceiling disc; `apex` is the outermost drawn point of the
 * shell. habitat.js derives its exterior collider from `apex`, so a collider can
 * neither stop short of the drawn skin nor extend past it into open water - the
 * commons dome runs to 8.22 m and a collider built from `top` left 2.72 m of
 * glass with nothing behind it.
 */
export const HABITAT_MODULES = Object.freeze([
  Object.freeze({ x: 0, z: 0, r: 6.40, top: 4.30, apex: 8.22 }),   // commons + dome
  Object.freeze({ x: 15.20, z: 0.40, r: 4.80, top: 4.05, apex: 5.24 }),  // laboratory
  Object.freeze({ x: -13.95, z: 2.20, r: 4.50, top: 3.92, apex: 5.04 }), // crew room
  Object.freeze({ x: 25.80, z: 0.40, r: 4.60, top: 4.05, apex: 5.16 }),  // observatory
]);

/**
 * Corridor bore and axis height above the deck plane, and the half-width of the
 * walkway inside it.
 *
 * THE TUBE HAS TO CONTAIN ITS OWN FLOOR. At the first cut the bore was 1.70 on
 * an axis at 1.85, so the liner's lowest point was y = 0.27 - ABOVE the 0.20
 * walkway - and the deck's edges at +/-1.24 were 2.19 m from the axis against a
 * 1.58 m liner. Ray-cast against the built mesh, 34 m2 of dry interior floor
 * hung outside the corridor in open water, and from inside the hall you saw the
 * bottom of a pipe rather than a deck: exactly the "pipes down the middle of the
 * hallway" this rebuild is answering, arriving by a different route. The
 * constraint is hypot(HALL_HALF_W, HALL_Y - FLOOR_Y) < HALL_R - liner inset.
 */
const HALL_R = 2.10;
const HALL_Y = 1.70;
const HALL_HALF_W = 1.20;
/** Interior deck: HABITAT_SITE.interior.floorY is this above HABITAT_SITE.deckY. */
const FLOOR_Y = 0.20;
/** Deck slab top face and thickness. These EXACTLY match the `deck + 0.02` /
 *  `deck - 0.48` planes habitat.js resolves against; at 0.25 m thick the drawn
 *  underside sat 0.25 m above the collider's, so a diver rising into the
 *  undercroft stopped in open water short of the visible plate. */
const DECK_TOP = 0.02;
const DECK_H = 0.50;
/** Half-width of the gap the deck's north edge leaves for the airlock trunk. */
const DOOR_GAP = 3.10;
/** Deck extent, matching the resolveExteriorPlayer/resolveVessel box exactly. */
const DECK_X0 = -19.80, DECK_X1 = 32.20, DECK_Z0 = -6.60, DECK_Z1 = 7.40;

/** Support legs. Kept identical to LEGS in habitat.js: they are collision. */
export const HABITAT_LEGS = Object.freeze([
  [-5.2, -4.6], [5.2, -4.6], [-5.2, 4.6], [5.2, 4.6],
  [11.2, -3.6], [19.0, -3.6], [11.2, 4.4], [19.0, 4.4],
  [-17.2, -1.5], [-17.2, 5.9], [-10.8, -1.5], [-10.8, 5.9],
  [23.0, -3.5], [29.0, 4.1],
]);
const LEG_DROP = 10.73;

/** Airlock trunk: outer (hatch) face, how far it reaches into the commons, and
 *  its bore. The trunk is buried past the drum surface at z = -6.40 so its cut
 *  end is never visible from inside the room. */
const LOCK_Z0 = -9.90;
const LOCK_Z1 = -5.70;
const LOCK_R = 2.20;
const LOCK_HALF_W = 1.25;

// ---- palette --------------------------------------------------------------
//
// Each entry is the per-part `tint`: rgb multiplies the material's albedo and a
// multiplies its roughness bias. The VALUE SPREAD BETWEEN THESE IS THE
// SILHOUETTE. A 30 m approach through Sand Plains water delivers the building
// through a veil that compresses everything toward the water's own code, so the
// only structure that survives is the building's internal contrast: bone shells
// against a deep-petrol roof, near-black legs, and black glass. Painting it all
// one near-white, as the first version did, is what made it disappear.

// MEASURED, not chosen. Decoding the hab-approach shot and inverting the
// real chain - agxSigmoid, agxLook, the outset, the depth grade at the station's
// own camera depth, the EOTF and the sRGB encode - recovers an exterior
// illuminant of 1 : 1.404 : 6.020 at this depth and this water. That is bluer
// than daylightAtDepth alone (1 : 1.25 : 4.11); the extra 1.46x in blue is the
// sky SH's own chromaticity, which evalAmbient carries correctly through
// columnLoss. It is the number paint here has to be authored against, and it
// had never been written down.
//
// Two things follow, and both were wrong before.
//
// HUE IS NOT AVAILABLE AT 48 m, ONLY VALUE. Forward-modelled through the same
// chain, everything from the old bone [0.62, 0.60, 0.55] to an extreme ochre
// [0.75, 0.50, 0.10] delivers hue 213-215 degrees on the approach frame, because
// the veil is 87% of the pixel. So no albedo can carry the silhouette out there:
// judge this palette at 4-25 m, and expect the approach shot to stay blue.
//
// AND THE BLUE CHANNEL WAS CLIPPING. Over the habitat's bounding box, 30.8% of
// pixels had B >= 250 against 0.0% over the water directly above it. All three
// channels sat near the top, the differences lived only in R and G, and AgX had
// already flattened the shoulder. THAT is what "it looks a bit white" was.

/**
 * Shell paint. Warm cream - and its BLUE is the whole fix.
 *
 * 0.55 blue against an illuminant of 11.686 is 6.43, which is on the display
 * ceiling; 0.17 is 1.99, which peaks at code 232 at every range. Red goes 0.62 ->
 * 0.72 to buy back the luminance the cut costs, so the approach silhouette only
 * slips 1.30x -> 1.21x the water above while delivered saturation halves at 4 m.
 * The shell stops being a paler version of the water and becomes a NEUTRAL
 * against a saturated blue, which is where the reference frame's cream actually
 * comes from.
 *
 * Warmer than this does not help: full chromatic inversion delivers grey (hue
 * 202, saturation 0.07), because neutralising a blue key cannot overshoot without
 * an albedo above 1. 0.17 is the knee.
 *
 * In air this is a sand-ochre rather than a bone white, and that is fine - the
 * station is a fixed landmark at a fixed depth and is never seen dry. Do not
 * copy it onto anything that is.
 *
 * It was also byte-identical to WATER_BOTTOM_ALBEDO[1], the reef carbonate sand
 * the water's own body colour is derived from. The building was painted the
 * colour of the seabed.
 */
const PAINT_SHELL = [0.72, 0.55, 0.17, 0.02];
/**
 * Roof caps, collars, door frames, kerbs. Near-black navy.
 *
 * The deep petrol this replaces delivered luma 0.372 at 48 m against the water's
 * 0.380 - it WAS the water, to half a percent, and photographed as the same cyan
 * as everything else. At 4 m the new value is 3.4x below the shell (1.8 EV)
 * against the old pair's 1.9x, and it stays a genuinely saturated blue.
 *
 * It still does nothing at 48 m and nothing can: the veil floor there is luma
 * 0.334 against the water's 0.382, so the ENTIRE budget for "darker than the
 * water" at that range is 0.19 EV and this already spends 0.13 of it. Do not
 * re-author trim to chase the approach frame.
 */
const PAINT_TRIM = [0.022, 0.030, 0.075, -0.04];
/**
 * Legs, truss, masts, handrails. Near-black, so the undercroft reads as frame.
 * Warm-biased (R > B in albedo) so that under a 1 : 1.4 : 6 key it lands on the
 * shell's hue instead of reading as a second, bluer material.
 */
const PAINT_STRUCT = [0.036, 0.030, 0.022, 0.06];
/**
 * Hi-vis: the hatch surround and the deck edge markers only.
 *
 * YELLOW, NOT ORANGE, AND THE OLD VALUE PHOTOGRAPHED PINK. [0.52, 0.115, 0.018]
 * has G/R = 0.221 in albedo against an illuminant whose G/R is 1.404, so
 * delivered green landed below both red and blue: measured hue 334 (magenta-pink)
 * at 4 m, sweeping through 274 (violet) at 12 m to blue. It is the dusty-pink
 * flange ring in the hab-hatch-close shot. At G/R = 0.60 it delivers hue 76 at 4 m
 * decays monotonically to the water's hue instead of sweeping through the wheel.
 * Yellow-and-black is also what real hazard marking is.
 *
 * It is paler than the pink was. If more chroma is wanted the answer is COVERAGE
 * - more marker area - and never saturation, for the same reason raising glowcup
 * density beat raising glowcup brightness.
 */
const PAINT_HIVIS = [0.60, 0.36, 0.028, -0.02];
/** Glazing needs no tint; the material owns the pane and the mullion. */
const GLASS_TINT = [1, 1, 1, 0];
/** Interior surfaces, likewise. */
const ROOM_TINT = [1, 1, 1, 0];

// A WINDOW IS NOT A LAMP, AND IT IS NOT AN EMITTER EITHER. There was a
// WINDOW_SPILL gain here, feeding `entity.params.z` on the glass part so that
// pass/entity.wgsl could add a constant warm patch standing in for the room
// behind the pane. The glazing transmits now and the room behind it is the real
// room, so the gain has nothing left to scale; leaving the constant in place
// would be exactly the dead authored data CLAUDE.md warns about. If the station
// needs to read warmer from 40 m the lever is HAB_COVE_GAIN and the interior
// lamp intensities, never a gain on a pane.

/**
 * Emissive gain for lamp lenses. The previous build used 18 here with a livery
 * that was already hi-vis orange underneath it; the airlock ring alone read as a
 * clipped white disc across a third of the frame at four metres.
 */
const LENS_GAIN = 2.6;

// ---- module builder -------------------------------------------------------

/**
 * One pressure module: exterior shell, glazing band, interior skin and interior
 * pane, all from a single band list so the four cannot drift apart.
 *
 * `bands` entries are [radius, y, kind], kind 'p' panel or 'g' glass. A run of
 * consecutive rings of one kind becomes one revolve, and v accumulates across
 * the whole profile so the panel grid does not restart at every band boundary.
 */
function moduleShell(out, cx, cz, bands, segments, openings, opts = {}) {
  const inset = opts.inset ?? 0.16;
  let uRef = 0;
  for (const b of bands) if (b[0] > uRef) uRef = b[0];

  // Cumulative arc length so every run knows where it starts.
  const v = [0];
  for (let i = 1; i < bands.length; i++) {
    v.push(v[i - 1] + Math.hypot(bands[i][0] - bands[i - 1][0], bands[i][1] - bands[i - 1][1]));
  }

  // A band entry's kind applies to the SEGMENT above it, so a run of segments
  // i..j-1 spans rings i..j and the boundary ring is shared with the next run.
  // Advancing by anything other than i = j re-reads the previous run's kind and
  // emits the boundary band twice, in both materials.
  const last = bands.length - 1;
  let i = 0;
  while (i < last) {
    const kind = bands[i][2];
    let j = i + 1;
    while (j < last && bands[j][2] === kind) j++;
    const run = [], runIn = [];
    for (let k = i; k <= j; k++) {
      run.push([bands[k][0], bands[k][1]]);
      runIn.push([Math.max(0.02, bands[k][0] - inset), bands[k][1]]);
    }
    const common = { openings, uRef, v0: v[i] };
    const glass = kind === 'g';
    // 't' is opaque panel routed to the dark trim part instead of the bone one.
    // THE ROOF CAP IS THE SILHOUETTE. A drum that is all one bone value has
    // nothing to separate its top from its side through 40 m of Sand Plains
    // water, and the reference stations all carry a deep-coloured cap for
    // exactly that reason. It is the same geometry and the same material - only
    // the per-part tint differs, which is where paint belongs.
    const outer = glass ? out.glass : (kind === 't' ? out.trim : out.shell);
    outer.merge(revolve(run, segments, common), at(cx, 0, cz));
    // BOTH faces, always. Glazing needs it to be a window from inside; opaque
    // shell needs it because a room's wall is the inside of the hull and there
    // is nothing else to be. A `skinTo` option that suppressed the inner skin
    // above a height used to sit here, and it was inert: every opaque run on
    // every one of the four modules is below its own threshold, so it never
    // fired once. Dead authored data, of exactly the kind CLAUDE.md warns about.
    (glass ? out.pane : out.room).merge(
      revolve(runIn, segments, { ...common, inward: true, uRef: uRef - inset }),
      at(cx, 0, cz));
    i = j;
  }
}

/**
 * An external stiffener ring on a drum, cut by the same bores as its skin.
 *
 * THESE CANNOT BE TORI. A torus is a closed loop, so a ring at the corridor axis
 * height runs straight across every doorway on the module - and standing in the
 * airlock looking into the commons, the ring at 1.70 m passed 1.37 m in front of
 * the eye and spanned the entire frame. A ring frame is part of the shell, so it
 * is built as one: a short outward bulge in the profile, revolved with the
 * module's own `openings`.
 */
function collarRing(out, cx, cz, R, y, minor, openings, segments) {
  out.trim.merge(revolve([
    [R, y - minor * 1.5], [R + minor, y], [R, y + minor * 1.5],
  ], segments, { openings, uRef: R }), at(cx, 0, cz));
}

/**
 * A corridor between two module skins.
 *
 * `crossA`/`crossB` are where the tube axis actually meets each drum, computed
 * by `crossing()` from the module's own centre and radius. The tube is buried
 * 0.75 m inside both, which is what keeps its cut end out of sight: from within
 * a room the buried length presents back faces and vanishes.
 *
 * A COLLAR AT EACH CROSSING IS LOAD-BEARING, not decoration - see collar().
 */
function corridor(out, crossA, crossB, axis, offset, tubeR = HALL_R) {
  const place = axis === 'x' ? alongX : alongZ;
  const put = (t) => (axis === 'x' ? place(t, HALL_Y, offset)
    : place(offset, HALL_Y, t));
  const span = (a, b, r, inward) => revolve(
    [[r, 0], [r, b - a]], 28, { inward });

  // The tube runs well past both crossings; the buried length presents back
  // faces from inside a room and vanishes. The LINER has to run past them too,
  // because the bore cut in the drum reaches its deepest about 0.3 m inboard of
  // the crossing plane and a liner that stops short leaves a slot straight out
  // to open sea - which, photographed from the commons, was a starfield in the
  // top corners of the room.
  out.shell.merge(span(crossA - 0.85, crossB + 0.85, tubeR, false), put(crossA - 0.85));
  out.room.merge(span(crossA - 0.75, crossB + 0.75, tubeR - 0.12, true), put(crossA - 0.75));

  collar(out, axis, offset, crossA, -1, tubeR);
  collar(out, axis, offset, crossB, +1, tubeR);
  if (crossB - crossA > 3.2) {
    out.trim.merge(ringUV(tubeR + 0.03, 0.11, 28, 6), put((crossA + crossB) * 0.5));
  }

  // Deck inside the tube. A round corridor with no floor reads as a pipe, which
  // is exactly the complaint this rebuild is answering. It sits 4 mm below the
  // module floor discs so the two cannot z-fight where they overlap inside a
  // module skin.
  const mid = (crossA + crossB) * 0.5, len = crossB - crossA + 1.2;
  const fx = axis === 'x' ? mid : offset;
  const fz = axis === 'x' ? offset : mid;
  out.room.merge(
    slab(axis === 'x' ? len * 0.5 : HALL_HALF_W, 0.09,
      axis === 'x' ? HALL_HALF_W : len * 0.5),
    at(fx, FLOOR_Y - 0.094, fz));
}

/**
 * The flange where a corridor meets a drum: a conical flare and a short barrel.
 *
 * A TORUS CANNOT COVER AN ELLIPTICAL BORE IN A CURVED SKIN, and that is why
 * this is a flare and not the ring it started as. The cut is a cylinder
 * intersection, so its rim is a space curve that reaches about 0.3 m inboard of
 * the crossing plane and, once the quad grid has quantised it, up to 2.2 m from
 * the tube axis. The flare widens to 2.55 m and then runs 0.36 m INBOARD as a
 * straight barrel, past the deepest point of the cut, which seals the joint from
 * every viewing angle at once. It stands proud of the drum - which is exactly
 * what an external flange bolted over a hull penetration does, and what the
 * reference stations show at every module-to-module joint.
 *
 * `dir` is +1 when the drum lies at increasing t along the corridor axis.
 */
function collar(out, axis, offset, t, dir, tubeR) {
  const profile = (r0, r1) => [
    [r0, 0.00], [r0 + (r1 - r0) * 0.42, 0.60], [r1, 0.98], [r1, 1.70],
  ];
  // The flare's small end is outboard and its barrel inboard, so local +Y must
  // point INTO the drum: toward +t for dir +1 and toward -t for dir -1.
  const origin = t - dir * 0.98;
  const xf = axis === 'x'
    ? (dir > 0 ? alongX(origin, HALL_Y, offset) : alongNegX(origin, HALL_Y, offset))
    : (dir > 0 ? alongZ(offset, HALL_Y, origin) : alongNegZ(offset, HALL_Y, origin));
  out.trim.merge(revolve(profile(tubeR + 0.03, 2.98), 28, {}), xf);
  // THE INBOARD COLLAR IS TWO-SIDED AND ENDS IN A FLAT PLATE, and neither half
  // is belt-and-braces.
  //
  // Two-sided because it is seen from both: from inside the corridor, which
  // needs inward-facing faces, and from inside the ROOM, where a doorway rim is
  // an ordinary outward surface.
  //
  // AND A TUBE CANNOT COVER A HOLE SEEN ALONG ITS OWN AXIS. That is the whole
  // reason for the annulus. The bore cut in the drum's skin is quantised to the
  // azimuth grid and the ring rows, so from the room it is a stepped rectangle
  // about 4.3 m across; a collar of any radius is edge-on to that view and
  // hides none of it, and behind the hole is the corridor's outward tube (also
  // back-facing) and then open sea. Photographed from the commons, the airlock
  // doorway was a rectangle of seabed with a porthole floating in it. A flat
  // ring plate set inboard of the whole cut is what a bulkhead penetration
  // actually carries, and it is the only thing that closes this.
  out.room.merge(revolve(profile(tubeR - 0.11, 2.84), 28, { inward: true }), xf);
  out.room.merge(revolve(profile(tubeR - 0.16, 2.79), 28, {}), xf);
  out.room.merge(disc(2.86, tubeR - 0.13, 1.70, 1, 28), xf);
}

/**
 * Where a corridor axis meets a drum, on the given side.
 *
 * Three of the five corridors here do not run through their module's centre, so
 * this is never just `cx +/- r`.
 */
function crossing(cx, cz, r, axis, dir, offset) {
  const d = axis === 'x' ? offset - cz : offset - cx;
  const along = Math.sqrt(Math.max(0.01, r * r - d * d));
  return (axis === 'x' ? cx : cz) + dir * along;
}

// ---- the building ---------------------------------------------------------

/**
 * Build the whole habitat.
 *
 * @returns {{vertices: Float32Array, indices: Uint32Array, parts: Array,
 *   vertexCount: number, indexCount: number, boundingRadius: number}}
 */
export function buildHabitatMesh() {
  const out = {
    shell: new MeshBuilder(8192, 24576),
    trim: new MeshBuilder(4096, 12288),
    struct: new MeshBuilder(4096, 12288),
    hivis: new MeshBuilder(1024, 3072),
    glass: new MeshBuilder(4096, 12288),
    pane: new MeshBuilder(4096, 12288),
    room: new MeshBuilder(8192, 24576),
    lamp: new MeshBuilder(1024, 3072),
    screen: new MeshBuilder(1024, 3072),
  };

  buildDeck(out);
  buildCommons(out);
  buildLaboratory(out);
  buildCrewRoom(out);
  buildObservatory(out);
  buildCorridors(out);
  buildAirlock(out);
  buildLegs(out);
  buildDressing(out);
  buildInteriorFit(out);

  return pack([
    { mb: out.shell, material: HABITAT_MATERIAL.PANEL, tint: PAINT_SHELL, emission: 0 },
    { mb: out.trim, material: HABITAT_MATERIAL.PANEL, tint: PAINT_TRIM, emission: 0 },
    { mb: out.struct, material: HABITAT_MATERIAL.PANEL, tint: PAINT_STRUCT, emission: 0 },
    { mb: out.hivis, material: HABITAT_MATERIAL.PANEL, tint: PAINT_HIVIS, emission: 0 },
    { mb: out.glass, material: HABITAT_MATERIAL.GLASS, tint: GLASS_TINT, emission: 0 },
    { mb: out.pane, material: HABITAT_MATERIAL.VIEWPORT, tint: GLASS_TINT, emission: 0 },
    { mb: out.room, material: HABITAT_MATERIAL.INTERIOR, tint: ROOM_TINT, emission: 0 },
    // TWO EMISSIVE FAMILIES, and the split is not cosmetic. One part cannot be
    // both wet and dry, and passes/entities.js flags the whole part: with the
    // exterior marker lamps and the interior console screens sharing a group,
    // either the lamps lost their water medium or the screens gained 33 m of
    // ocean between themselves and a player standing two metres away.
    { mb: out.lamp, material: VESSEL_MATERIAL.EMISSIVE, tint: [1.0, 0.72, 0.42, 0], emission: LENS_GAIN },
    // A CONSOLE FACE AT EMISSION 1.15 IS ON THE AgX SHOULDER. Measured off the
    // delivered commons frame it sat at scene [1.10, 1.49, 1.70] and came back
    // at HSV saturation 0.11 - pale grey-cyan, the brightest thing in the room
    // and the least coloured. Cutting the gain and saturating the tint takes it
    // to 0.70. This is "a brighter object is a whiter one" read backwards, on
    // something that already existed.
    { mb: out.screen, material: HABITAT_MATERIAL.SCREEN, tint: [0.10, 0.62, 0.98, 0], emission: 0.60 },
  ]);
}

/** The platform: slab, kerb, and the truss that makes the undercroft readable. */
function buildDeck(out) {
  const cx = (DECK_X0 + DECK_X1) * 0.5, cz = (DECK_Z0 + DECK_Z1) * 0.5;
  const hx = (DECK_X1 - DECK_X0) * 0.5, hz = (DECK_Z1 - DECK_Z0) * 0.5;
  out.shell.merge(slab(hx, DECK_H * 0.5, hz), at(cx, DECK_TOP - DECK_H * 0.5, cz));

  // Toe rail all round. A flat plate with no edge reads as a floating quad; a
  // 0.22 m kerb gives it a thickness the eye can find from below and from
  // across the site.
  //
  // THE NORTH EDGE IS BROKEN FOR THE AIRLOCK. The trunk leaves the deck at
  // z = -6.60 and runs on to -9.90, so an unbroken kerb - and, below, an
  // unbroken handrail and conduit run - crosses the doorway at knee, waist and
  // chest height. Photographed from the commons looking north, that is four
  // horizontal bars across the only way out.
  const kerb = 0.22;
  const runs = [
    [cx, DECK_Z1 - 0.11, hx, 0.11],
    [DECK_X0 + 0.11, cz, 0.11, hz], [DECK_X1 - 0.11, cz, 0.11, hz],
    // North edge, in two pieces either side of the trunk.
    [(DECK_X0 + (-DOOR_GAP)) * 0.5, DECK_Z0 + 0.11, (-DOOR_GAP - DECK_X0) * 0.5, 0.11],
    [(DOOR_GAP + DECK_X1) * 0.5, DECK_Z0 + 0.11, (DECK_X1 - DOOR_GAP) * 0.5, 0.11],
  ];
  for (const [x, z, kx, kz] of runs) {
    out.trim.merge(slab(kx, kerb * 0.5, kz), at(x, DECK_TOP + kerb * 0.5, z));
  }

  // Under-deck truss. Photographed from below, the first version was one flat
  // untextured plane filling the sky; longitudinal girders on the leg lines plus
  // transverse frames turn that into structure without touching collision,
  // which owns only the slab and the legs.
  const girderY = DECK_TOP - DECK_H - 0.30;
  for (const z of [-4.6, 0.4, 4.6]) {
    out.struct.merge(slab(hx, 0.30, 0.13), at(cx, girderY, z));
  }
  for (let x = DECK_X0 + 1.6; x < DECK_X1; x += 3.2) {
    out.struct.merge(slab(0.10, 0.24, hz), at(x, girderY + 0.04, cz));
  }
}

/**
 * The commons: the room the airlock opens into, and the one the player is meant
 * to arrive in. Round in plan, glazed all round at eye height, and roofed with a
 * ribbed glass dome.
 *
 * The dome is glazed on both faces, so from the floor the water column overhead
 * is visible through it. That is the whole point of the room.
 */
function buildCommons(out) {
  const R = 6.40;
  // Apertures are cut for the tube, not for its collar: the collar is what
  // covers the edge, so the hole only has to clear the bore.
  // Bores are in the module's OWN local frame, so a corridor on world z = 1.85
  // through a drum centred on world (0, 0) is a bore at u = 1.85.
  const openings = [
    bore('z', 0, -1, LOCK_R + 0.06),      // airlock trunk, leaves north
    bore('x', 0, +1, HALL_R + 0.06),      // east hall, on z = 0
    bore('x', 1.85, -1, HALL_R + 0.06),   // west hall, on z = 1.85
  ];

  moduleShell(out, 0, 0, [
    [6.24, 0.00, 'p'],
    [6.46, 0.34, 'p'],
    [6.40, 0.70, 'p'],
    [6.40, 1.62, 'p'],
    [6.44, 1.74, 'g'],
    [6.44, 3.16, 'g'],
    [6.40, 3.28, 'p'],
    [6.40, 4.02, 't'],
    [6.22, 4.42, 't'],
    // ---- glass dome ----
    [6.06, 4.72, 'g'],
    [5.72, 5.42, 'g'],
    [5.10, 6.16, 'g'],
    [4.20, 6.90, 'g'],
    [2.95, 7.56, 'g'],
    [1.45, 8.02, 'g'],
    [0.05, 8.22, 'g'],
  ], 64, openings, { inset: 0.16 });

  // Collars: the joint between the shell and the deck, the window band's sill
  // and head, and the dome springing ring. These four horizontals are what make
  // a drum read as an assembly rather than as an extruded circle.
  for (const [y, minor] of [[0.34, 0.15], [1.70, 0.10], [3.20, 0.10], [4.50, 0.26]]) {
    collarRing(out, 0, 0, R + 0.02, y, minor, openings, 64);
  }
  // Meridian ribs on the dome. The glass material already draws a mullion grid;
  // these are the structural arches over it, and they are what reads at range.
  const domeRings = [[6.10, 4.66], [5.72, 5.42], [5.10, 6.16], [4.20, 6.90],
    [2.95, 7.56], [1.45, 8.02], [0.05, 8.22]];
  for (let a = 0; a < 8; a++) {
    const th = (a / 8) * TAU;
    for (let i = 0; i < domeRings.length - 1; i++) {
      const [r0, y0] = domeRings[i], [r1, y1] = domeRings[i + 1];
      const len = Math.hypot(r1 - r0, y1 - y0);
      const mx = (r0 + r1) * 0.5, my = (y0 + y1) * 0.5;
      // A short box aligned with the segment, rotated into the meridian plane.
      const ca = Math.cos(th), sa = Math.sin(th);
      const dx = (r1 - r0) / len, dy = (y1 - y0) / len;
      out.struct.merge(slab(0.055, len * 0.5, 0.055), Float32Array.of(
        ca * dy, -dx, sa * dy, 0,
        ca * dx, dy, sa * dx, 0,
        -sa, 0, ca, 0,
        mx * ca, my, mx * sa, 1,
      ));
    }
  }
  // Apex cap and its beacon.
  out.trim.merge(ringUV(0.40, 0.16, 20, 6), at(0, 8.20, 0));
  out.lamp.merge(cylUV(0.16, 0.16, 0.20, 12), at(0, 8.24, 0));
}

/** Laboratory: a window band and a solid roof, so the commons dome stays unique. */
function buildLaboratory(out) {
  const R = 4.80, cx = 15.20, cz = 0.40;
  const openings = [
    bore('x', 0 - cz, -1, HALL_R + 0.06),      // west, to the commons
    bore('x', 0.15 - cz, +1, HALL_R + 0.06),   // east, to the observatory
  ];
  moduleShell(out, cx, cz, [
    [4.64, 0.00, 'p'], [4.86, 0.34, 'p'], [4.80, 0.70, 'p'],
    [4.80, 1.62, 'p'], [4.84, 1.74, 'g'], [4.84, 3.16, 'g'],
    [4.80, 3.28, 'p'], [4.80, 4.10, 't'], [4.52, 4.56, 't'],
    [3.60, 4.92, 't'], [1.90, 5.16, 't'], [0.05, 5.24, 't'],
  ], 48, openings, { inset: 0.16 });
  for (const [y, minor] of [[0.34, 0.14], [1.70, 0.09], [3.20, 0.09], [4.20, 0.20]]) {
    collarRing(out, cx, cz, R + 0.02, y, minor, openings, 48);
  }
}

/** Crew room. Same family, one deck light lower, with a roof hatch fairing. */
function buildCrewRoom(out) {
  const R = 4.50, cx = -13.95, cz = 2.20;
  const openings = [bore('x', 1.85 - cz, +1, HALL_R + 0.06)];
  moduleShell(out, cx, cz, [
    [4.34, 0.00, 'p'], [4.56, 0.34, 'p'], [4.50, 0.70, 'p'],
    [4.50, 1.62, 'p'], [4.54, 1.74, 'g'], [4.54, 3.16, 'g'],
    [4.50, 3.28, 'p'], [4.50, 3.96, 't'], [4.22, 4.40, 't'],
    [3.30, 4.74, 't'], [1.70, 4.96, 't'], [0.05, 5.04, 't'],
  ], 48, openings, { inset: 0.16 });
  for (const [y, minor] of [[0.34, 0.14], [1.70, 0.09], [3.20, 0.09], [4.06, 0.19]]) {
    collarRing(out, cx, cz, R + 0.02, y, minor, openings, 48);
  }
}

/**
 * Observatory: a glazed drum. The far end of the walk, and the one place the
 * player stands surrounded by water on every side.
 */
function buildObservatory(out) {
  const R = 4.60, cx = 25.80, cz = 0.40;
  const openings = [bore('x', 0.15 - cz, -1, HALL_R + 0.06)];
  moduleShell(out, cx, cz, [
    [4.44, 0.00, 'p'], [4.66, 0.34, 'p'], [4.60, 0.70, 'p'],
    [4.60, 1.10, 'p'], [4.64, 1.22, 'g'], [4.64, 3.62, 'g'],
    [4.60, 3.74, 'p'], [4.60, 4.10, 't'], [4.30, 4.52, 't'],
    [3.35, 4.86, 't'], [1.75, 5.08, 't'], [0.05, 5.16, 't'],
  ], 48, openings, { inset: 0.16 });
  for (const [y, minor] of [[0.34, 0.14], [1.18, 0.09], [3.66, 0.09], [4.18, 0.19]]) {
    collarRing(out, cx, cz, R + 0.02, y, minor, openings, 48);
  }
}

/** The three connecting halls, spanning drum surface to drum surface. */
function buildCorridors(out) {
  const M = HABITAT_MODULES;
  const cross = (m, dir, offset) => crossing(m.x, m.z, m.r, 'x', dir, offset);
  // commons -> laboratory, on z = 0
  corridor(out, cross(M[0], 1, 0), cross(M[1], -1, 0), 'x', 0);
  // laboratory -> observatory, on z = 0.15. The two drums nearly touch, so this
  // is a short flanged neck rather than a run of tube - which is also what the
  // reference stations do where two modules are bolted directly together.
  corridor(out, cross(M[1], 1, 0.15), cross(M[3], -1, 0.15), 'x', 0.15);
  // crew room -> commons, on z = 1.85
  corridor(out, cross(M[2], 1, 1.85), cross(M[0], -1, 1.85), 'x', 1.85);
}

/**
 * The airlock trunk and its hatch.
 *
 * THE HATCH IS A DOOR. The previous version was an open-ended tube with a
 * 720-intensity point lamp inside it, so the approach photographed a white disc
 * with an orange ring - the "glowing like a yellow sun" the rebuild was asked
 * for. A door reads as a door because of what is ON it: a heavy flange, a dished
 * plate, radial locking dogs, a handwheel, and a round porthole with a lit room
 * behind it. The porthole is glazed on BOTH faces, so it is a warm circle from
 * the sea and a circle of sea from the airlock.
 *
 * Nothing passes through it geometrically. Habitat.tryInteract() teleports, so a
 * sealed trunk is both correct and what stops the interior blowing out through
 * the mouth.
 */
function buildAirlock(out) {
  const len = LOCK_Z1 - LOCK_Z0;
  const xf = alongZ(0, HALL_Y, LOCK_Z0);

  // Trunk. It runs from the hatch face well past the commons drum surface at
  // z = -6.40, and collar() seals the penetration.
  out.shell.merge(revolve([[LOCK_R, 0], [LOCK_R, len]], 32, {}), xf);
  out.room.merge(revolve([
    [LOCK_R - 0.13, 0.30], [LOCK_R - 0.13, len],
  ], 32, { inward: true }), xf);
  out.room.merge(slab(LOCK_HALF_W, 0.09, len * 0.5 - 0.2),
    at(0, FLOOR_Y - 0.094, LOCK_Z0 + len * 0.5 + 0.2));
  collar(out, 'z', 0, -6.40, +1, LOCK_R);

  // ---- the door ----------------------------------------------------------
  // Outer face plane. The trunk is SEALED here: tryInteract() teleports, so
  // nothing has to pass through, and an open mouth is what let the interior
  // blow out down the tube in the first place.
  const zf = LOCK_Z0;
  const hy = HALL_Y;

  // Heavy flange ring around the opening, and a hi-vis surround outside it so
  // the door can be found from across the site.
  out.trim.merge(ringUV(LOCK_R + 0.05, 0.20, 32, 8), alongZ(0, hy, zf));
  out.hivis.merge(ringUV(LOCK_R + 0.26, 0.11, 32, 6), alongZ(0, hy, zf - 0.06));

  // Dished plate, bulging outward into the sea, from the flange in to the
  // porthole frame. Rings run bottom-to-top in the local frame - i.e. from the
  // apex back to the flange - because revolve() derives its outward normal from
  // the profile's direction of travel, and a reversed list points it inboard.
  //
  // EMITTED ON BOTH FACES. Outward-only, the plate is back-face culled from
  // inside the airlock, so the diver standing on the interior door point looked
  // straight through a sealed hatch at open water - a hole in the one piece of
  // geometry whose entire job is to close the hull.
  const doorProfile = [
    [0.90, -0.34], [1.24, -0.26], [1.56, -0.11], [LOCK_R, 0.00],
  ];
  out.shell.merge(revolve(doorProfile, 32, {}), alongZ(0, hy, zf));
  out.room.merge(revolve(doorProfile.map(([r, y]) => [r - 0.03, y + 0.07]), 32,
    { inward: true }), alongZ(0, hy, zf));

  // Porthole: one frame, an outward pane and an inward pane. Outward it is
  // black glass with the room's warm spill behind it; inward it is the sea.
  out.trim.merge(ringUV(0.90, 0.13, 28, 8), alongZ(0, hy, zf - 0.34));
  out.glass.merge(disc(0.88, 0, 0, -1, 28), alongZ(0, hy, zf - 0.33));
  out.pane.merge(disc(0.86, 0, 0, -1, 28, true), alongZ(0, hy, zf - 0.24));

  // Locking ring and its handles: a ring outside the porthole with six radial
  // spokes, which is what a dogged pressure door actually carries and what
  // makes the plate read as a door rather than as a lid.
  out.struct.merge(ringUV(1.34, 0.065, 24, 6), alongZ(0, hy, zf - 0.20));
  for (let s = 0; s < 6; s++) {
    const th = (s / 6) * TAU;
    const c = Math.cos(th), sn = Math.sin(th);
    out.struct.merge(slab(0.30, 0.042, 0.042), Float32Array.of(
      c, sn, 0, 0,
      -sn, c, 0, 0,
      0, 0, 1, 0,
      c * 1.34, hy + sn * 1.34, zf - 0.20, 1,
    ));
  }
  // Locking dogs on the flange itself.
  for (let d = 0; d < 8; d++) {
    const th = (d / 8) * TAU + Math.PI / 8;
    out.struct.merge(slab(0.09, 0.09, 0.14),
      at(Math.cos(th) * (LOCK_R + 0.05), hy + Math.sin(th) * (LOCK_R + 0.05), zf - 0.06));
  }

  // Four marker lamps on the hi-vis surround, and nothing else emissive on the
  // door. LENS_GAIN is 2.6 against the 18 that put a clipped white disc across
  // a third of the frame at four metres.
  for (let m = 0; m < 4; m++) {
    const th = (m / 4) * TAU + Math.PI / 4;
    const r = LOCK_R + 0.26;
    out.trim.merge(cylUV(0.16, 0.13, 0.10, 12),
      alongZ(Math.cos(th) * r, hy + Math.sin(th) * r, zf - 0.13));
    out.lamp.merge(cylUV(0.10, 0.10, 0.04, 12),
      alongZ(Math.cos(th) * r, hy + Math.sin(th) * r, zf - 0.19));
  }
}

/** Support legs, their footpads, and the diagonal bracing between them. */
function buildLegs(out) {
  for (const [x, z] of HABITAT_LEGS) {
    // Tapered tube, wider at the deck where the moment is.
    out.struct.merge(revolve([
      [0.30, -LEG_DROP], [0.34, -LEG_DROP + 1.2], [0.40, -1.6], [0.52, -0.10],
    ], 16, {}), at(x, 0, z));
    // Footpad: a spread cone, because a 0.3 m tube ending in mid-sand reads as
    // a pole pushed into the seabed rather than as a foundation.
    out.struct.merge(revolve([
      [1.06, -LEG_DROP - 0.34], [1.02, -LEG_DROP - 0.14],
      [0.62, -LEG_DROP - 0.02], [0.34, -LEG_DROP + 0.10],
    ], 16, {}), at(x, 0, z));
    out.trim.merge(ringUV(0.56, 0.10, 16, 6), at(x, -0.16, z));
  }
  // Diagonal bracing on the four transverse leg pairs. Only pairs that share an
  // x, so nothing crosses the central lane the Kestrel drives through.
  const pairs = [[-5.2, -4.6, 4.6], [5.2, -4.6, 4.6], [11.2, -3.6, 4.4],
    [19.0, -3.6, 4.4], [-17.2, -1.5, 5.9], [-10.8, -1.5, 5.9]];
  for (const [x, z0, z1] of pairs) {
    for (const [ya, yb] of [[-2.4, -7.4], [-7.4, -2.4]]) {
      const dz = z1 - z0, dy = yb - ya;
      const len = Math.hypot(dz, dy);
      out.struct.merge(slab(0.075, len * 0.5, 0.075), Float32Array.of(
        1, 0, 0, 0,
        0, dy / len, dz / len, 0,
        0, -dz / len, dy / len, 0,
        x, (ya + yb) * 0.5, (z0 + z1) * 0.5, 1,
      ));
    }
  }
}

/**
 * Exterior dressing: the things that make a base look occupied rather than
 * delivered. Solar arrays, a comms mast, handrails, conduit runs and
 * floodlights, all sized off the reference frames.
 */
function buildDressing(out) {
  // Handrail down both long deck edges, in two-metre bays with real stanchions.
  // The north run breaks either side of the airlock trunk; see the kerb above.
  for (const z of [DECK_Z0 + 0.35, DECK_Z1 - 0.35]) {
    const north = z < 0;
    for (let x = DECK_X0 + 1.0; x < DECK_X1 - 0.5; x += 2.0) {
      if (north && Math.abs(x) < DOOR_GAP) continue;
      out.struct.merge(slab(0.035, 0.50, 0.035), at(x, DECK_TOP + 0.62, z));
    }
    const spans = north
      ? [[DECK_X0 + 1.0, -DOOR_GAP], [DOOR_GAP, DECK_X1 - 1.0]]
      : [[DECK_X0 + 1.0, DECK_X1 - 1.0]];
    for (const [x0, x1] of spans) {
      out.struct.merge(slab((x1 - x0) * 0.5, 0.035, 0.035),
        at((x0 + x1) * 0.5, DECK_TOP + 1.10, z));
    }
  }

  // Solar / thermal arrays on short stalks, canted to the surface.
  for (const [x, z, yaw] of [[-19.0, 5.6, 0.35], [-19.0, -5.0, -0.35], [31.0, 5.6, 0.35]]) {
    out.struct.merge(slab(0.09, 0.75, 0.09), at(x, DECK_TOP + 0.75, z));
    const tilt = 0.62, c = Math.cos(tilt), s = Math.sin(tilt);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    out.trim.merge(slab(1.55, 0.05, 1.05), Float32Array.of(
      cy, 0, -sy, 0,
      sy * s, c, cy * s, 0,
      sy * c, -s, cy * c, 0,
      x, DECK_TOP + 1.62, z, 1,
    ));
  }

  // Comms mast off the laboratory roof, with a dish.
  out.struct.merge(revolve([[0.16, 0], [0.10, 3.4]], 10, {}), at(15.20, 5.20, 0.40));
  out.struct.merge(revolve([
    [1.10, 0.62], [0.98, 0.34], [0.62, 0.10], [0.05, 0.00],
  ], 20, {}), at(15.20, 8.30, 0.40));
  out.lamp.merge(cylUV(0.10, 0.10, 0.14, 10), at(15.20, 8.60, 0.40));

  // Conduit runs along the OUTSIDE of the shells and across the deck. Pipes are
  // good detail on a hull and bad detail down the middle of a corridor, which is
  // where the previous version put its only tube - and equally bad across a
  // doorway, which is where the first cut of these put two of them. Both runs
  // clear the airlock and neither passes through a drum: the south edge is
  // 6.95 m out against the commons' 6.40, and the north run starts east of the
  // trunk and stops short of the observatory.
  for (const [z, y, x0, x1] of [
    [6.95, 0.90, DECK_X0 + 1.0, DECK_X1 - 1.0],
    [6.95, 1.22, DECK_X0 + 1.0, DECK_X1 - 1.0],
    [-6.30, 0.90, DOOR_GAP, 20.5],
  ]) {
    out.struct.merge(revolve([[0.11, 0], [0.11, x1 - x0]], 10, {}),
      alongX(x0, DECK_TOP + y, z));
  }

  // Floodlights on the module shoulders, aimed down at the deck and the
  // approach. These are the housings; habitat.js submits the matching lights.
  for (const [x, y, z] of [[0, 4.30, -5.30], [15.20, 4.55, -4.10],
    [-13.95, 4.35, -3.60], [25.80, 4.50, -3.90]]) {
    out.trim.merge(cylUV(0.30, 0.24, 0.34, 12), at(x, y, z));
    out.lamp.merge(cylUV(0.20, 0.20, 0.06, 12), at(x, y - 0.05, z));
  }

  // Ladder up the commons drum, from the deck to the dome collar.
  for (let y = 0.45; y < 4.4; y += 0.36) {
    out.struct.merge(slab(0.28, 0.028, 0.028), at(0, y, 6.62));
  }
  for (const sx of [-0.28, 0.28]) {
    out.struct.merge(revolve([[0.035, 0.30], [0.035, 4.55]], 6, {}), at(sx, 0, 6.62));
  }
}

/**
 * Interior fit-out: the floors, ceilings and furniture of the four rooms.
 *
 * The room SHELLS are already inward-facing skins emitted by moduleShell(), so
 * this only has to add the horizontal surfaces and the props. Every room is
 * round in plan and the collision AABB is the square inscribed in it: with
 * PLAYER.RADIUS 0.34, the commons' walkable half-diagonal is 5.88 m against a
 * 6.24 m skin, so a diver can never reach the corner where the square leaves
 * the circle. The same margin holds for all four rooms.
 */
function buildInteriorFit(out) {
  for (const m of HABITAT_MODULES) {
    const inner = m.r - 0.17;
    out.room.merge(disc(inner, 0, FLOOR_Y, 1, 40), at(m.x, 0, m.z));
    // The commons is open to its dome; the other three get a ceiling.
    if (m.x !== 0) {
      out.room.merge(disc(inner, 0, m.top, -1, 40), at(m.x, 0, m.z));
      // Light cove: a ring recessed into the ceiling, lit by habInteriorDetail.
      out.room.merge(ringUV(inner * 0.62, 0.10, 32, 6), at(m.x, m.top - 0.12, m.z));
    }
  }
  // The commons keeps a narrow soffit ring at the dome springing so the glazing
  // starts from a lip rather than from the wall panel.
  out.room.merge(disc(6.23, 5.10, 4.58, -1, 48), at(0, 0, 0));
  out.trim.merge(ringUV(5.20, 0.16, 48, 8), at(0, 4.60, 0));

  // ---- commons: a central table under the dome, and seating ---------------
  out.room.merge(cylUV(1.35, 1.20, 0.10, 24), at(0, FLOOR_Y + 0.78, 0));
  out.room.merge(cylUV(0.30, 0.55, 0.78, 16), at(0, FLOOR_Y, 0));
  for (let s = 0; s < 5; s++) {
    const th = (s / 5) * TAU + 0.3;
    out.room.merge(cylUV(0.34, 0.30, 0.44, 12),
      at(Math.cos(th) * 2.15, FLOOR_Y, Math.sin(th) * 2.15));
  }
  // A console bank against the wall, clear of all three doorways.
  for (const th of [1.05, 1.75, 2.45]) {
    const r = 5.35;
    out.room.merge(slab(0.85, 0.50, 0.36),
      at(Math.cos(th) * r, FLOOR_Y + 0.50, Math.sin(th) * r));
    out.screen.merge(slab(0.68, 0.22, 0.02),
      at(Math.cos(th) * (r - 0.38), FLOOR_Y + 1.18, Math.sin(th) * (r - 0.38)));
  }

  // ---- laboratory --------------------------------------------------------
  out.room.merge(slab(2.60, 0.45, 0.42), at(15.20, FLOOR_Y + 0.45, 3.30));
  out.room.merge(slab(2.60, 0.45, 0.42), at(15.20, FLOOR_Y + 0.45, -2.50));
  for (const sx of [-1.9, 1.9]) {
    out.room.merge(slab(0.55, 0.90, 0.34), at(15.20 + sx, FLOOR_Y + 0.90, 3.55));
  }
  out.screen.merge(slab(2.30, 0.02, 0.16), at(15.20, FLOOR_Y + 1.62, 3.66));

  // ---- crew room ---------------------------------------------------------
  for (const dz of [-1.25, 1.25]) {
    out.room.merge(slab(1.05, 0.30, 0.62), at(-13.95, FLOOR_Y + 0.30, 2.20 + dz));
    out.room.merge(slab(1.05, 0.10, 0.62), at(-13.95, FLOOR_Y + 1.42, 2.20 + dz));
  }
  out.room.merge(slab(0.42, 0.85, 1.30), at(-16.60, FLOOR_Y + 0.85, 2.20));

  // ---- observatory: nothing but a rail and a bench, so the glass wins -----
  out.room.merge(ringUV(3.70, 0.055, 32, 6), at(25.80, FLOOR_Y + 1.02, 0.40));
  for (let s = 0; s < 4; s++) {
    const th = (s / 4) * TAU + 0.4;
    out.room.merge(slab(0.05, 0.51, 0.05),
      at(25.80 + Math.cos(th) * 3.70, FLOOR_Y + 0.51, 0.40 + Math.sin(th) * 3.70));
  }
  out.room.merge(cylUV(1.15, 1.15, 0.42, 20), at(25.80, FLOOR_Y, 0.40));
}

// ---- packing --------------------------------------------------------------

/**
 * Interleave the meshgen SOA output into the entity pipeline's 48-byte vertex
 * and emit one part per material family.
 *
 * PART COUNT IS DRAW COUNT. passes/entities.js issues one uniform allocation,
 * bind-group set and drawIndexed per part in the colour pass, and again per
 * part per casting shadow cascade. Eight families is deliberate: it is what the
 * palette needs and no more.
 */
function pack(groups) {
  const built = [];
  for (const g of groups) {
    if (g.mb.indexCount === 0) continue;
    g.mb.computeTangents();
    built.push({ ...g, mesh: g.mb.build() });
  }

  let vertexCount = 0, indexCount = 0;
  for (const g of built) { vertexCount += g.mesh.vertexCount; indexCount += g.mesh.indexCount; }
  const vertices = new Float32Array(vertexCount * (VESSEL_VERTEX_STRIDE / 4));
  const indices = new Uint32Array(indexCount);
  const parts = [];
  let vo = 0, io = 0, r2 = 0;
  for (const g of built) {
    const m = g.mesh, firstIndex = io;
    for (let i = 0; i < m.vertexCount; i++) {
      const d = (vo + i) * 12, p = i * 3, t = i * 4, u = i * 2;
      const px = m.positions[p], py = m.positions[p + 1], pz = m.positions[p + 2];
      vertices[d] = px; vertices[d + 1] = py; vertices[d + 2] = pz;
      vertices[d + 3] = m.normals[p]; vertices[d + 4] = m.normals[p + 1]; vertices[d + 5] = m.normals[p + 2];
      vertices[d + 6] = m.tangents[t]; vertices[d + 7] = m.tangents[t + 1];
      vertices[d + 8] = m.tangents[t + 2]; vertices[d + 9] = m.tangents[t + 3];
      vertices[d + 10] = m.uvs[u]; vertices[d + 11] = m.uvs[u + 1];
      const dd = px * px + py * py + pz * pz;
      if (dd > r2) r2 = dd;
    }
    for (let i = 0; i < m.indexCount; i++) indices[io++] = m.indices[i] + vo;
    parts.push({
      firstIndex, indexCount: m.indexCount, material: g.material,
      tint: g.tint, emission: g.emission, node: 0,
    });
    vo += m.vertexCount;
  }

  // MEASURED, never a literal. The predecessor hard-coded 39.5 against a real
  // extent of 33.0, and this radius drives both the colour pass's frustum cull
  // and the shadow-cascade test - too small and the far end of the base pops
  // out of frame, too large and it is tested against cascades it cannot reach.
  return {
    vertices, indices, parts, vertexCount, indexCount,
    boundingRadius: Math.sqrt(r2) + 0.5,
  };
}
