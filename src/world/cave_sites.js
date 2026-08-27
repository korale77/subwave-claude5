/**
 * Authored cave sites: hand-placed volumes merged into the procedural tunnel
 * graph at macro-graph build time (world/caves.js, buildMacroGraph).
 *
 * The procedural graph is a pure function of (seed, cell) and cannot author a
 * COMPOSED space - an entrance corridor that reads as an approach, opening
 * into one large chamber sized for 10-16 m props. This module holds that
 * composition as data. Everything here is expressed relative to the MOUTH's
 * terrain surface height, so the cave keeps its shape (corridor pitch, roof
 * thickness, chamber clearance) under any seed; the shipped numbers were sited
 * against WORLD.DEFAULT_SEED (the scan and its gates are in the JELLY_SITE
 * docstring below).
 *
 * WHY MERGE INTO THE GRAPH RATHER THAN ADD A FOURTH FIELD TERM: the graph is
 * the one representation every consumer already agrees on - caveDensity and
 * generateCaveChunk share graphTermIn arithmetic, caveOccupancy prunes on the
 * per-cell AABB, gatherMouths/activeMouthDiscs breach the terrain from the
 * cell mouth list, and collision admits on caveVoidAt. A separate authored
 * term would need five hand-kept mirrors of that plumbing; a merged graph
 * needs none.
 *
 * OWNERSHIP: every primitive of a site lives in ONE macro cell - the cell of
 * its mouth start point - and must stay within REACH (384 m) of that cell's
 * box, or the 3x3x3 neighbourhood query stops being sufficient and the site
 * silently vanishes from far chunks. checkSiteReach() enforces it at resolve
 * time and throws, so a bad edit can never reach a frame.
 *
 * This module imports only terrain and constants. The shroom-instance
 * resolver (which needs the assembled field) lives in caves.js.
 */

import { sampleHeight, getSeed } from './terrain.js';

/**
 * JELLYSHROOM HOLLOW - a large purple cavern in the Twilight Terraces shelf
 * at (0, 2000), entered through a descending corridor from a seabed mouth at
 * -153 m. Chamber floor near -250 m, under 80-99 m of rock (the shelf-break
 * slope RISES to -80 m over the chamber while the corridor descends).
 *
 * SITED BY SCAN, not by hand: 40 m grid over r [700, 2600], mouth seabed in
 * [-175, -115], slope <= 0.45, >= 500 m from every biome anchor, >= 450 m
 * from every authored place and station, and a 130 m chamber run whose 5x5
 * overburden probe keeps >= 18 m of rock over a chamber top 56 m below the
 * mouth surface. This mouth won on roof (98.5 m) and on arrival framing
 * (slope 0.06 at the mouth, so the hole reads as a hole). Verified against
 * the procedural graph at the default seed: no procedural system's AABB
 * touches the mouth-to-chamber volume, so the space is exactly what is
 * authored here.
 *
 * All dy values are metres BELOW the mouth's terrain surface (positive down).
 * Corridor: [dx, dy, dz, radius]; chambers: [dx, dy, dz, rx, ry, rz];
 * shrooms: [dx, dz, height] with height in metres of delivered mesh.
 */
export const JELLY_SITE = Object.freeze({
  short: 'jelly',
  /**
   * VESSEL-SCALE, re-authored 2026-08-18 after a playtest: the original
   * diver-scale bore (rBase 6.5, corridor r 6.5-10) was unenterable by the
   * 7.4 m Kestrel and unswimmable on a tank - at the chamber's ~250 m the
   * oxygen depth multiplier is ~2.1x, so even a tier-2 suit's 210 s is
   * ~100 effective seconds against a 300 m each-way corridor swim. The
   * reference game's answer is the vehicle, and it is this site's answer
   * too: rBase 13 gives a ~21 m shaft and the corridor bores 26-30 m wide,
   * comfortable for the hull, and the cabin recycler (six-second tank
   * refill) turns the vessel into the dive base the chamber needs.
   * resolveVesselHull's cave admission (world/collision.js) landed in the
   * same change - without it every mouth is heightfield-solid to the hull
   * regardless of bore.
   */
  mouth: Object.freeze({ x: 0, z: 2000, rBase: 13.0 }),
  /** Corridor waypoints from the mouth start (index 0 IS the mouth start
   *  point, dy 20 below the surface like a mid-band procedural entrance).
   *  Consecutive waypoints become capsules sharing endpoints and radii, the
   *  same connectivity-by-construction the procedural walks use. */
  corridor: Object.freeze([
    Object.freeze([0, 20, 0, 13.0]),
    Object.freeze([7, 33, -36, 13.0]),
    Object.freeze([-9, 50, -74, 13.5]),
    Object.freeze([-5, 65, -110, 14.0]),
    Object.freeze([0, 73, -142, 15.0]),
    // Last leg runs INTO the main chamber centre so the corridor provably
    // opens into it (an ellipsoid always swallows a capsule that ends at its
    // centre - the same argument the procedural chamber spawn makes).
    Object.freeze([0, 78, -174, 15.0]),
  ]),
  /** The cavern: one main hall, two side lobes, one ceiling dome. The dome
   *  was lifted (dy 64 -> 56, ry 15 -> 18) after the second review round:
   *  the 16 m giant's cap sat almost against the roof and the hall read as
   *  a low room. Roof over the dome top stays > 60 m of rock. */
  chambers: Object.freeze([
    Object.freeze([0, 78, -174, 44, 22, 38]),
    Object.freeze([-28, 82, -158, 24, 14, 22]),
    Object.freeze([26, 76, -194, 24, 15, 22]),
    Object.freeze([4, 56, -176, 30, 18, 26]),
  ]),
  /**
   * Jellyshroom stands, authored in plan. Height is the delivered mesh height
   * in metres (instance scale = height / the generator's registered 14 m).
   * The composition is the reference's: a handful of giants dominating the
   * hall, mediums between them, small caps at the fringes.
   */
  shrooms: Object.freeze([
    Object.freeze([0, -176, 16]),
    Object.freeze([-24, -162, 13.5]),
    Object.freeze([26, -190, 14.5]),
    Object.freeze([-34, -180, 11]),
    Object.freeze([14, -152, 12]),
    Object.freeze([34, -200, 8]),
    Object.freeze([-12, -196, 9]),
    Object.freeze([8, -166, 7]),
    Object.freeze([-40, -168, 6.5]),
    Object.freeze([22, -170, 6]),
    Object.freeze([-6, -186, 4]),
    Object.freeze([30, -158, 4.5]),
    Object.freeze([-18, -146, 3.5]),
    Object.freeze([40, -186, 5]),
  ]),
});

/** All authored sites. One today; the array is the extension point. */
export const CAVE_SITES = Object.freeze([JELLY_SITE]);

// ---------------------------------------------------------------------------
// Resolution: surface-relative spec -> absolute primitives, memoised per seed.
// ---------------------------------------------------------------------------

const MACRO = 512;           // must equal caves.js CAVE_MACRO_SIZE
const REACH = 384;           // must equal caves.js REACH
const DETAIL_AMP = 2.9;      // must equal caves.js DETAIL_AMP (AABB clearance)

let _resolvedSeed = -1;
let _resolved = null;

/** Throw if any primitive strays past REACH of the owning cell's box. */
function checkSiteReach(site, r) {
  const bx0 = r.cell[0] * MACRO - REACH, bx1 = (r.cell[0] + 1) * MACRO + REACH;
  const by0 = r.cell[1] * MACRO - REACH, by1 = (r.cell[1] + 1) * MACRO + REACH;
  const bz0 = r.cell[2] * MACRO - REACH, bz1 = (r.cell[2] + 1) * MACRO + REACH;
  const check = (x, y, z, pad, what) => {
    if (x - pad < bx0 || x + pad > bx1 || y - pad < by0 || y + pad > by1 ||
        z - pad < bz0 || z + pad > bz1) {
      throw new Error(`[cave_sites] ${site.short}: ${what} at (${x}, ${y}, ${z}) ` +
        `escapes REACH of owning cell (${r.cell}); the 3x3x3 query would miss it`);
    }
  };
  for (const c of r.capsules) {
    check(c[0], c[1], c[2], c[3] + DETAIL_AMP, 'capsule end');
    check(c[4], c[5], c[6], c[7] + DETAIL_AMP, 'capsule end');
  }
  for (const e of r.chambers) {
    check(e[0], e[1], e[2], Math.max(e[3], e[4], e[5]) + DETAIL_AMP, 'chamber');
  }
}

/**
 * Resolve every authored site against the current terrain seed.
 *
 * @returns {Array<{site: object, cell: number[], surface: number,
 *   capsules: number[][], chambers: number[][],
 *   mouth: {x: number, y: number, z: number, topY: number,
 *           topR: number, r: number},
 *   aabb: {minX,minY,minZ,maxX,maxY,maxZ}}>}
 *   capsules as [ax,ay,az,ra, bx,by,bz,rb], chambers as [cx,cy,cz,rx,ry,rz].
 */
export function resolvedCaveSites() {
  const seed = getSeed();
  if (_resolved && _resolvedSeed === seed) return _resolved;
  const out = [];
  for (const site of CAVE_SITES) {
    const mx = site.mouth.x, mz = site.mouth.z;
    const surface = sampleHeight(mx, mz);
    const w = site.corridor;
    const p = (i) => [mx + w[i][0], surface - w[i][1], mz + w[i][2], w[i][3]];
    const capsules = [];
    for (let i = 0; i + 1 < w.length; i++) {
      const a = p(i), b = p(i + 1);
      capsules.push([a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3]]);
    }
    const chambers = site.chambers.map((e) =>
      [mx + e[0], surface - e[1], mz + e[2], e[3], e[4], e[5]]);
    const start = p(0);
    const r = {
      site,
      // Owning cell: the cell of the mouth START point, exactly the ownership
      // rule the procedural root walks use.
      cell: [Math.floor(start[0] / MACRO), Math.floor(start[1] / MACRO),
             Math.floor(start[2] / MACRO)],
      surface,
      capsules,
      chambers,
      mouth: {
        x: mx, y: start[1], z: mz,
        topY: surface + site.mouth.rBase * 0.55,
        topR: site.mouth.rBase * 0.80,
        r: site.mouth.rBase,
      },
      aabb: null,
    };
    // AABB over everything, perturbation clearance included - the region test
    // the render side gates on.
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const grow = (x, y, z, pad) => {
      if (x - pad < minX) minX = x - pad;
      if (y - pad < minY) minY = y - pad;
      if (z - pad < minZ) minZ = z - pad;
      if (x + pad > maxX) maxX = x + pad;
      if (y + pad > maxY) maxY = y + pad;
      if (z + pad > maxZ) maxZ = z + pad;
    };
    for (const c of capsules) {
      grow(c[0], c[1], c[2], c[3] + DETAIL_AMP);
      grow(c[4], c[5], c[6], c[7] + DETAIL_AMP);
    }
    grow(r.mouth.x, r.mouth.topY, r.mouth.z, r.mouth.topR + DETAIL_AMP);
    for (const e of chambers) grow(e[0], e[1], e[2], Math.max(e[3], e[4], e[5]) + DETAIL_AMP);
    r.aabb = { minX, minY, minZ, maxX, maxY, maxZ };
    checkSiteReach(site, r);
    out.push(r);
  }
  _resolvedSeed = seed;
  _resolved = out;
  return out;
}
