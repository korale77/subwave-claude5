/**
 * SUBWAVE scatter type -> MESH ARGUMENTS and EMITTED FLUX, in one place.
 *
 * This module exists because two consumers need exactly the same answer and
 * neither may be allowed to hold its own copy of it:
 *
 *   - `render/passes/scatter.js` builds the mesh library and the per-type
 *     emission the glow pass and the light submitter run on;
 *   - `tools/scatter-census.mjs` reports TOTAL EMITTED FLUX per biome offline,
 *     which is the gate the total-flux acceptance criterion is graded by.
 *
 * Both were closures inside `makeScatterPass()` until 2026-08-06, which is why
 * the census had to be written and could not be: a `GPUDevice` is not available
 * in node, so the only way to measure emitted flux offline was to transcribe the
 * arithmetic - and CLAUDE.md's most repeated finding is that two copies of one
 * truth drift.
 *
 * `tools/test-glow.mjs:304` is NOT a third copy of this and must not be folded
 * into it: it integrates the analogous quantity for CREATURE meshes, off
 * `SLOT_GLOW` and a per-vertex emissive mask rather than off
 * `SLOT_EMISSIVE_GATE * SLOT_GLOW_MEAN`, and test-glow section 6 exists to rank
 * creatures with it. What the two genuinely share is the `0.25` Cauchy factor
 * and the fold to a scalar, and those are the parts that could drift.
 *
 * NOTHING HERE TOUCHES A DEVICE, AND THAT IS THE CONSTRAINT THIS FILE HAS TO
 * KEEP. It imports the material-slot tables and calls a meshgen generator, both
 * of which are pure. Adding a device-dependent line here silently breaks the
 * census, and the census has no way to report that beyond failing to import.
 */

import { SLOT_EMISSIVE_GATE, SLOT_GLOW_MEAN } from './glow_slots.js';

/**
 * Extra POSITIONAL shape arguments a generator takes between `size` and `opts`,
 * read out of the type's meshParams.
 *
 * meshgen's generators are (seed, primarySize, ...shape, opts) rather than a
 * single options bag, and the shape arguments differ per family. Keeping the
 * mapping in one table means a generator that gains an argument is one line
 * here, not a search through the type catalogue - and a generator that is absent
 * from the table gets the (seed, size, opts) form, which is what most of them
 * are.
 *
 * DELIBERATELY NOT EXPORTED. `scatterGeneratorArgs` below is the only reader it
 * has ever had; exporting it would put a second symbol with no importer into a
 * tree whose most repeated bug is exactly that. It is named in the console.error
 * `auditMeshParams` prints in `render/passes/scatter.js`, which is a message to a
 * human and not an import.
 */
const GENERATOR_SHAPE_ARGS = {
  generateRock: (p) => [p.irregularity ?? 0.5],
  generateCrystal: (p) => [p.sides ?? 6],
  generateKelp: (p) => [p.blades ?? 18],
  generateGiantKelp: (p) => [p.blades ?? 24],
  generateSeagrass: (p) => [p.blades ?? 7],
  generateShoreGrass: (p) => [p.blades ?? 9],
  generateMushroom: (p) => [p.capRadius ?? 1.95],
  generateBloodGrass: (p) => [p.blades ?? 58],
  // generateMeadowPillar is (seed, height, opts): its height already rides the
  // shared `size` slot below (params.height), and capRadius/beds/crown are opts
  // keys. The empty row is deliberate - listing height here would pass it TWICE.
  generateMeadowPillar: () => [],
  // generateBulbTree is (seed, height, opts): height rides the shared `size`
  // slot (params.height) and trunks/fruit/ground/secondary are opts keys -
  // the meadowPillar rule, restated so nobody adds height here twice.
  generateBulbTree: () => [],
  // generatePlatterSpire and generateRingHalo are (seed, height, opts): the
  // meadowPillar rule again - height rides the shared `size` slot, and
  // platters/rings are opts keys.
  generatePlatterSpire: () => [],
  generateRingHalo: () => [],
};

/**
 * The full argument list for one scatter type's generator.
 *
 * @param {object} type a `SCATTER_TYPES` row
 * @param {object} params the row's `meshParams` plus a `detail` tier. Passed
 *   through to the generator as its `opts` bag, so a Proxy may be substituted
 *   here to record which keys the generator actually reads.
 * @returns {Array} positional arguments for `meshgen[type.generator]`
 */
export function scatterGeneratorArgs(type, params) {
  // The MESH seed is the type id, not the world seed: a rock's SHAPE need not
  // change when the planet does, and pinning it means the mesh library is
  // identical across saves and can be built before the world seed is known.
  const seed = 0x5ca7 + type.id * 977;
  const size = params.size ?? params.height ?? params.radius ?? 1;
  // generateOreNode is the one generator whose second argument is not a size:
  // it selects a row of meshgen's ORE_APPEARANCE table, which carries the host
  // rock colour, the vein colour and the vein's own emission. `oreAppearance`
  // on the type is that row index, and it is distinct from `ore.materialId`,
  // which is what the mining system harvests.
  if (type.generator === 'generateOreNode') {
    return [seed, type.oreAppearance ?? 0, size, params];
  }
  const shape = GENERATOR_SHAPE_ARGS[type.generator]?.(params) ?? [];
  return [seed, size, ...shape, params];
}

/**
 * Integrate one scatter type's emissive area off its own generated mesh.
 *
 * The HIGHEST-detail mesh in the chain, deliberately: it is the truest statement
 * of the form's area, and a sprite whose flux stepped with the LOD ring would
 * pulse as the player swam toward it.
 *
 * The respiration pulse is folded in as its TIME MEAN, 1 - 0.28 * rate, so a
 * living type is 15.4% dimmer than a mineral vein of the same authored emission
 * - which is what pass/scatter.wgsl actually delivers on average. Fluorescence
 * is NOT folded in: it is pumped by surviving blue daylight, so it is a
 * per-frame, per-depth quantity and the caller applies it.
 *
 * @param {object} type a `SCATTER_TYPES` row
 * @param {Function} generator the meshgen export named by `type.generator`
 * @param {object} [prebuilt] the type's maxDetail mesh, if the caller already
 *   has one. It MUST be the mesh `scatterGeneratorArgs(type, {...meshParams,
 *   detail: type.maxDetail})` produces or the flux is silently wrong; the
 *   renderer does not pass it and builds its own.
 * @returns {{flux: number[], radius: number, centroid: number[], area: number}|null}
 *   null for a type that emits nothing, or whose emissive area integrates to
 *   zero. `flux` is radiant intensity in W/sr at per-instance scale 1 and
 *   emissive scale 1: `emissiveColor * emissive * Aeff / 4`, the /4 being
 *   Cauchy's mean-projected-area theorem and Aeff the sum over triangles of
 *   `area * slotEmissiveGate(m) * <s.glow>_m`. That is the same product
 *   pass/scatter.wgsl emits, so the sprite and the geometry cannot disagree
 *   about how bright the type is. `radius` is the emissive region's radius of
 *   gyration in metres at scale 1; `centroid` is the emissive area's centroid in
 *   MESH-LOCAL metres at scale 1.
 */
export function bakeScatterTypeEmit(type, generator, prebuilt) {
  if (!(type.emissive > 0)) return null;
  const mesh = prebuilt ?? generator(
    ...scatterGeneratorArgs(type, { ...type.meshParams, detail: type.maxDetail }));
  const pos = mesh.positions, mat = mesh.materials, idx = mesh.indices;
  // mix(slotEmissiveGate(m), 1.0, fluo) - a fluorescing coral emits out of the
  // whole tissue, not out of one organ, which is why it skips the slot gate.
  const fluo = type.fluoresces ? 1 : 0;

  let area = 0, cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < mesh.indexCount; i += 3) {
    const i0 = idx[i], i1 = idx[i + 1], i2 = idx[i + 2];
    const m = mat[i0] & 7;
    const gate = fluo ? 1 : SLOT_EMISSIVE_GATE[m];
    const w0 = gate * SLOT_GLOW_MEAN[m];
    if (w0 <= 0) continue;
    const ax = pos[i1 * 3] - pos[i0 * 3];
    const ay = pos[i1 * 3 + 1] - pos[i0 * 3 + 1];
    const az = pos[i1 * 3 + 2] - pos[i0 * 3 + 2];
    const bx = pos[i2 * 3] - pos[i0 * 3];
    const by = pos[i2 * 3 + 1] - pos[i0 * 3 + 1];
    const bz = pos[i2 * 3 + 2] - pos[i0 * 3 + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const w = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz) * w0;
    if (!(w > 0)) continue;
    area += w;
    cx += w * (pos[i0 * 3] + pos[i1 * 3] + pos[i2 * 3]) / 3;
    cy += w * (pos[i0 * 3 + 1] + pos[i1 * 3 + 1] + pos[i2 * 3 + 1]) / 3;
    cz += w * (pos[i0 * 3 + 2] + pos[i1 * 3 + 2] + pos[i2 * 3 + 2]) / 3;
  }
  if (area <= 0) return null;
  cx /= area; cy /= area; cz /= area;

  let m2 = 0;
  for (let i = 0; i < mesh.indexCount; i += 3) {
    const i0 = idx[i], i1 = idx[i + 1], i2 = idx[i + 2];
    const m = mat[i0] & 7;
    const w0 = (fluo ? 1 : SLOT_EMISSIVE_GATE[m]) * SLOT_GLOW_MEAN[m];
    if (w0 <= 0) continue;
    const ax = pos[i1 * 3] - pos[i0 * 3];
    const ay = pos[i1 * 3 + 1] - pos[i0 * 3 + 1];
    const az = pos[i1 * 3 + 2] - pos[i0 * 3 + 2];
    const bx = pos[i2 * 3] - pos[i0 * 3];
    const by = pos[i2 * 3 + 1] - pos[i0 * 3 + 1];
    const bz = pos[i2 * 3 + 2] - pos[i0 * 3 + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const w = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz) * w0;
    if (!(w > 0)) continue;
    const px = (pos[i0 * 3] + pos[i1 * 3] + pos[i2 * 3]) / 3 - cx;
    const py = (pos[i0 * 3 + 1] + pos[i1 * 3 + 1] + pos[i2 * 3 + 1]) / 3 - cy;
    const pz = (pos[i0 * 3 + 2] + pos[i1 * 3 + 2] + pos[i2 * 3 + 2]) / 3 - cz;
    m2 += w * (px * px + py * py + pz * pz);
  }

  // Same respiration rate the per-draw uniform writes: 0.55 for living tissue,
  // 0 for a mineral vein.
  const rate = type.ore === null ? 0.55 : 0.0;
  const pulseMean = 1 - 0.28 * rate;
  const k = type.emissive * area * 0.25 * pulseMean;
  return {
    flux: [
      type.emissiveColor[0] * k,
      type.emissiveColor[1] * k,
      type.emissiveColor[2] * k,
    ],
    radius: Math.sqrt(2 / 3) * Math.sqrt(m2 / area),
    centroid: [cx, cy, cz],
    area,
  };
}
