/**
 * SUBWAVE scatter pass.
 *
 * Draws every plant, rock, coral, crystal, fungus and ore node on the seabed,
 * immediately after the vessel and before the sky, into sceneColor, sceneDepth
 * and velocity.
 *
 * THREE STRUCTURAL DECISIONS, ALL ABOUT DRAW COUNT.
 *
 * 1. ONE SHARED MESH BUFFER. Every type, at every LOD, is generated once at
 *    boot and packed into a single vertex buffer and a single index buffer, so a
 *    draw is one drawIndexed with a firstIndex and a baseVertex. No mesh rebind,
 *    ever.
 *
 * 2. INSTANCES ARE GROUPED BY TYPE INSIDE EACH CHUNK. world/scatter.js emits
 *    types contiguously and hands back firstByType, so a chunk's instances for
 *    one type are a RANGE, and one draw covers them with a firstInstance offset.
 *    The loop is therefore chunk-outer (one setVertexBuffer) and type-inner (one
 *    drawIndexed per type present), which is a few hundred microseconds of
 *    encode for the whole seabed.
 *
 * 3. THE SCATTER RADIUS IS SET BY WATER OPTICS, NOT BY TASTE. The residency
 *    radius is SCATTER_MAX_VIEW_DISTANCE, 340 m, because
 *    WATER_TYPES.REEF_TURQUOISE extinguishes blue at 0.144 /m - 1% of a coral
 *    head's contrast survives 32 m - and even OCEANIC_CLEAR only reaches 111 m.
 *    Twenty-odd resident chunks instead of the terrain's three thousand is what
 *    makes this affordable at 120 fps; a scatter field that followed the terrain
 *    streaming radius would be two thousand draws of geometry the water has
 *    already erased.
 *
 * REBASING. Instance translations are chunk-local XZ with absolute Y, exactly as
 * terrain.js bakes its vertices. The per-draw uniform carries the chunk origin
 * already rebased against camera.worldOrigin, computed on the CPU in f64.
 */

import {
  colorAttachment, depthAttachment, DepthState, Primitive, vertexLayout, GROUP, STAGE,
} from '../../core/pipelines.js';
import { FORMATS } from '../../core/gpu.js';
import { BufferUsage, createBuffer } from '../../core/resources.js';
import { profiler } from '../../core/profiler.js';
import { WORLD, RENDER } from '../../core/constants.js';
import { clamp, smoothstep } from '../../core/math.js';
import * as meshgen from '../../world/meshgen.js';
import { MESH_DETAIL } from '../../world/meshgen.js';
import {
  SCATTER_TYPES, SCATTER_TYPE_COUNT, SCATTER_STRIDE, SCATTER_MAX_PER_CHUNK,
  SCATTER_MAX_VIEW_DISTANCE, SCATTER_GLOBAL_CAP,
  generateScatterForChunk, scatterLodFor,
} from '../../world/scatter.js';
import { scatterGeneratorArgs, bakeScatterTypeEmit } from '../scatter_emit.js';

const CHUNK_SIZE = WORLD.CHUNK_SIZE;

/**
 * Bytes per MESH vertex: position(12) + normal(12) + uv(8) + colour/material(4)
 * + sway weight(4).
 *
 * WHY 40 BYTES AND NOT THE 20 DESIGN/02 QUOTES. The 20-byte record quantises
 * position to three f16 and the normal to an octahedral pair, and it is the right
 * answer at the scale it was written for - a streamed INSTANCE record, multiplied
 * by 160,000. This buffer is not that. It holds ONE COPY of each mesh at each
 * LOD: 31 types, 55 meshes, 10,924 vertices, a MEASURED 0.60 MB in total. Saving
 * 0.3 MB is not worth hand-rolling an f16 encoder and an octahedral projection,
 * each of which is a place for a silent precision bug to live. The INSTANCE
 * stream, which is the one that really is multiplied by 160,000, IS packed - 64
 * bytes, with unorm8 tints and unorm8 metadata.
 */
export const SCATTER_VERTEX_STRIDE = 40;
const SCATTER_VERTEX_FLOATS = SCATTER_VERTEX_STRIDE / 4;

/**
 * Bytes in ScatterUniform. Must match `struct ScatterUniform` in the WGSL:
 * six vec4f, written as SCATTER_UNIFORM_FLOATS floats in execute().
 *
 * This is a PER-DRAW uniform in the ring, not the Frame uniform, so
 * tools/test-layout.mjs does not cover it - init() asserts what it can instead.
 */
const SCATTER_UNIFORM_FLOATS = 24;
const SCATTER_UNIFORM_BYTES = SCATTER_UNIFORM_FLOATS * 4;

/**
 * Fraction of a type's view distance at which each detail tier gives way.
 * Indexed by MESH_DETAIL, so HIGH survives only the nearest seventh of the range
 * and LOW covers everything out to the cut-off.
 *
 * These are deliberately tight, and the reason is areal: the number of instances
 * inside a radius goes as r^2, so a tier that keeps half the RANGE keeps a
 * quarter of the population - and meshgen's MEDIUM tier is four times the
 * triangles of its LOW. Switching at 0.5 measured 6.6 MILLION triangles
 * submitted on the reef; switching at 0.34 costs the same picture beyond 50 m,
 * where a coral head is forty pixels across and its extra 900 triangles are all
 * sub-pixel.
 */
const DETAIL_SWITCH = [1.0, 0.34, 0.14];   // LOW, MEDIUM, HIGH

/**
 * Chunks kept beyond the residency radius before they are dropped, and the
 * distance the camera must travel before the resident set is recomputed. Both
 * mirror ChunkManager's constants for the same reason: without hysteresis a
 * player hovering on the boundary regenerates the same chunk twice a second.
 */
const UNLOAD_MARGIN = 1.18;
const RESCAN_DISTANCE = 16;

/**
 * How far past a LOD ring boundary a chunk must fall before it is regenerated
 * COARSER. Refinement has no such margin - it happens the moment the ring says
 * so, because the ground under the player's mask is what the whole streamer is
 * for - but coarsening does, or a player working the boundary regenerates the
 * same chunk every rescan.
 *
 * 1.25 puts the coarsen edge at 200 m against ring 0's 160 m, a 40 m band
 * against a 16 m rescan step, so it takes three rescans to cross either way.
 *
 * Coarsening is not optional. Refine-only looks safer and is not: every chunk
 * the camera ever passed within 160 m of stays at LOD 0 until it leaves the
 * 401 m unload radius, so a player working a small area drives the resident set
 * to all-LOD-0 - a MEASURED 32 chunks x 4,674 worst-case instances = 149,568
 * against RENDER.MAX_SCATTER_INSTANCES of 160,000. At the cap
 * generateScatterForChunk starts dropping whole types by importance, and the
 * first two it drops on a reef are seagrass and cobble, which is exactly the
 * content the refinement path exists to deliver.
 *
 * Nothing visible is lost by it: ring 0 already has to reach past every
 * maxLod-0 type's view distance (the binding row is mushroomCap at 130 m), so
 * at the 200 m coarsen edge there is 70 m of slack before anything a coarse
 * chunk lacks could have been drawn.
 */
const COARSEN_HYSTERESIS = 1.25;

/**
 * What should happen to a chunk that is already resident at `existingLod` and
 * whose NEAREST point is now `nearDist` metres from the camera.
 *
 * This is the LOD-refinement decision, and it is a free function rather than
 * three lines inside rescan()'s closure so that it can be asserted offline. It
 * is the single most load-bearing rule in this file - without the refine branch
 * a chunk keeps the LOD it was born with for as long as it is resident, and
 * every chunk that streams in during play is born at LOD 1 (its centre crosses
 * the 340 m residency radius, so its near point is 250-276 m away), which
 * deletes every maxLod-0 type outright. MEASURED on the reef chunk under the qa
 * reef-floor camera: LOD 0 is 4,648 instances and LOD 1 is 573, losing seagrass
 * 2,600 -> 0, cobble 1,295 -> 0, tube coral 138 -> 0. Outside the disc prime()
 * builds at boot, the game had never drawn a blade of seagrass.
 *
 * Refinement is IMMEDIATE and coarsening is not, because the two errors are not
 * symmetric: refining late leaves bare ground under the player's mask, while
 * coarsening early only costs instances nobody can see. COARSEN_HYSTERESIS puts
 * the coarsen edge at 200 m against ring 0's 160 m - a 40 m band against a 16 m
 * rescan step, so it takes three rescans to cross either way and a player
 * working the boundary cannot make the same chunk regenerate every scan.
 *
 * @param {number} existingLod the LOD the resident chunk was generated at
 * @param {number} nearDist metres from the camera to the chunk's nearest point
 * @returns {'refine'|'coarsen'|'keep'}
 */
export function scatterLodTransition(existingLod, nearDist) {
  if (scatterLodFor(nearDist) < existingLod) return 'refine';
  if (scatterLodFor(nearDist / COARSEN_HYSTERESIS) > existingLod) return 'coarsen';
  return 'keep';
}

/**
 * Generation budget per frame, milliseconds.
 *
 * A cold chunk is a MEASURED 5.3 ms median, 8.7 ms worst over 200 varied chunks
 * (tools/test-scatter.mjs section 14), so this admits one chunk per frame and no
 * more. The very first chunk of a session measures 16 ms in the browser while V8
 * is still interpreting the walk, but that one lands inside prime(), before
 * anything is being rendered.
 *
 * This is not a hitch the pass invented. The terrain's own bake budget is one
 * LOD-0-equivalent, which chunks.js documents as a measured 9 to 24 ms, and
 * scatter declines to run at all until the terrain queue has drained - so the two
 * never land in the same frame. At the 21 m/s the vessel makes underwater a 340 m
 * residency radius admits 0.9 new chunks per SECOND, so the budget is idle almost
 * all of the time and the whole radius is pre-generated at boot.
 */
const GENERATE_MS_BUDGET = 5.0;

/**
 * Build the scatter frame-graph pass.
 *
 * The returned object is a FrameGraph pass with two extra methods the game loop
 * owns rather than the graph:
 *   `prime(position)`  generate the whole residency radius at once, at boot
 *   `update(position)` stream one chunk's worth of work per frame
 *
 * @param {import('../renderer.js').Renderer} renderer
 * @param {object} game the Game instance; `game.chunks` is consulted so scatter
 *   never generates ahead of the terrain it has to stand on
 * @returns {object} a FrameGraph pass
 */
export function makeScatterPass(renderer, game) {
  /** @type {GPUDevice|null} */
  let device = null;
  let pipelineCull = null;
  let pipelineNoCull = null;
  let shadowPipelineCull = null;
  let shadowPipelineNoCull = null;
  let drawLayout = null;
  let drawBindGroup = null;
  let boundRing = null;

  /** Shared mesh geometry. */
  let meshVertexBuffer = null;
  let meshIndexBuffer = null;
  /** @type {Array<Array<object>>} per type, the LOD chain nearest-first */
  let lodChains = null;
  /** @type {number[]} type ids whose generator meshgen does not export */
  const missingGenerators = [];

  /**
   * Per-TYPE emission, baked off the real generated mesh for the glow pass.
   *
   *   flux[t*3..2]   radiant intensity in W/sr at per-instance scale 1 and
   *                  emissive scale 1: emissiveColor * emissive * Aeff / 4,
   *                  with the /4 being Cauchy's mean-projected-area theorem and
   *                  Aeff the sum over triangles of
   *                  `area * slotEmissiveGate(m) * <s.glow>_m`. That is the same
   *                  product pass/scatter.wgsl line 659 emits, so the sprite and
   *                  the geometry cannot disagree about how bright the type is.
   *   radius[t]      the emissive region's radius of gyration, metres, at
   *                  per-instance scale 1.
   *   centroid[t*3]  the emissive area's centroid in MESH-LOCAL metres at scale
   *                  1. Only submitLights() reads it, and only the Y component:
   *                  a mushroom's light comes out of its cap and its instance
   *                  origin is at the base and SUNK, so a light left at the
   *                  origin is buried in the sediment and radiates half its
   *                  output into the ground. The X and Z components are dropped
   *                  because the emissive forms are radially symmetric about
   *                  their stalk and the residual is bounded by radius[t].
   *   area[t]        Aeff itself. Its only readers are the two is-this-type-
   *                  emissive predicates below, at bakeTypeEmit's caller and in
   *                  extractEmissive; tools/probes/glow-census.js is the one
   *                  tool that reads typeEmit at all and it reads flux and
   *                  radius. (It said "for tools/test-glow.mjs", which has never
   *                  read this object.)
   *   fluoresces[t]  1 if the type's emission is PUMPED by surviving blue
   *                  daylight rather than self-powered, in which case the caller
   *                  must apply the same pump pass/scatter.wgsl does. Those four
   *                  corals are zero at exactly the depth the glow pass runs at,
   *                  which is why they must not get a self-powered sprite.
   *
   * `<s.glow>_m` is a MEAN FIELD - scatter's glow is fragment-varying, unlike
   * the creature pass's per-slot constants - and glow_slots.js derives each
   * entry and states the residual uncertainty.
   */
  const typeEmit = {
    flux: new Float32Array(SCATTER_TYPE_COUNT * 3),
    radius: new Float32Array(SCATTER_TYPE_COUNT),
    centroid: new Float32Array(SCATTER_TYPE_COUNT * 3),
    area: new Float32Array(SCATTER_TYPE_COUNT),
    fluoresces: new Uint8Array(SCATTER_TYPE_COUNT),
  };
  /** Resident chunks that hold at least one emissive instance. Refilled, not
   *  reallocated, so emissiveInstances() costs nothing per frame. */
  const emissiveChunks = [];

  /** @type {Map<number, object>} resident scatter chunks, keyed by packed (cx,cz) */
  const chunks = new Map();
  /** @type {Array<object>} pending generation jobs, nearest first */
  let queue = [];
  const queued = new Set();
  let lastScanX = Infinity;
  let lastScanZ = Infinity;
  let liveInstances = 0;

  const visible = [];
  const stats = {
    residentChunks: 0,
    queuedChunks: 0,
    instances: 0,
    visibleChunks: 0,
    visibleInstances: 0,
    draws: 0,
    triangles: 0,
    meshTriangles: 0,
    meshBytes: 0,
    gpuBytes: 0,
    generateMsLast: 0,
    generateMsPeak: 0,
    // What the terrain gate saw on the last update(). Published because the gate
    // is otherwise invisible from a probe: a stalled scatter queue and a gated
    // one look identical from the outside.
    terrainOutstanding: 0,
    // Deep scatter lights - see submitLights(). `beacons` + `fill` is what was
    // actually handed to renderer.addLight(), which is not the same as the
    // authored counts: the search can come up short and the 256-light budget can
    // refuse. `candidates` is what the walk looked at, so an empty selection can
    // be told apart from an empty seabed.
    beacons: 0,
    fill: 0,
    lightCandidates: 0,
    lightGate: 0,
    lightMs: 0,
  };

  const meshLayout = vertexLayout([
    [0, 'float32x3'],   // position, mesh-local metres
    [1, 'float32x3'],   // normal, mesh-local
    [2, 'float32x2'],   // uv; v is the 0..1 stalk parameter on swept forms
    [3, 'unorm8x4'],    // sqrt(colour).rgb, a = MESH_MATERIAL slot / 255
    [4, 'float32'],     // sway weight, 0 anchored .. 1 tip
  ]);
  const instanceLayout = vertexLayout([
    [5, 'float32x4'],   // basis row 0 + chunk-local X
    [6, 'float32x4'],   // basis row 1 + absolute Y
    [7, 'float32x4'],   // basis row 2 + chunk-local Z
    [8, 'unorm8x4'],    // tint.rgb (halved), a = emissive scale
    [9, 'float32'],     // sway phase, radians
    [10, 'float32'],    // sway amplitude, 0..2
    [11, 'unorm8x4'],   // fade dither, type id, variant, flags
  ], 'instance');

  // Trimmed layouts for the depth-only caster: same buffers, same strides, only
  // the attributes vs_scatter_shadow actually declares. The sway and the LOD
  // fade both have to be reproduced exactly, so swayWeight/phase/amp and
  // instMeta all survive the trim; only the normal, uv, colour and tint go.
  const shadowMeshLayout = {
    arrayStride: SCATTER_VERTEX_STRIDE,
    stepMode: 'vertex',
    attributes: [
      { shaderLocation: 0, format: 'float32x3', offset: 0 },
      { shaderLocation: 4, format: 'float32', offset: 36 },
    ],
  };
  const shadowInstanceLayout = {
    arrayStride: SCATTER_STRIDE,
    stepMode: 'instance',
    attributes: [
      { shaderLocation: 5, format: 'float32x4', offset: 0 },
      { shaderLocation: 6, format: 'float32x4', offset: 16 },
      { shaderLocation: 7, format: 'float32x4', offset: 32 },
      { shaderLocation: 9, format: 'float32', offset: 52 },
      { shaderLocation: 10, format: 'float32', offset: 56 },
      { shaderLocation: 11, format: 'unorm8x4', offset: 60 },
    ],
  };

  /** Per-cascade caster lists, rebuilt once a frame by beginShadowFrame(). */
  const shadowChunks = [];
  /** Per-cascade minimum caster diameter, metres. */
  const shadowMinSize = [];
  const shadowStats = { chunks: [], draws: [], instances: [] };

  const key = (cx, cz) => ((cx & 0xffff) << 16) | (cz & 0xffff);

  let statsShapeChecked = false;

  /**
   * Terrain work that is not on the GPU yet, as ONE number.
   *
   * THREE COUNTERS, NOT ONE, AND THAT IS THE WHOLE POINT. The gate used to read
   * `chunks.stats.queued` alone, which was correct only while the mesher ran on
   * the main thread and a job left the queue exactly when its mesh existed. With
   * the worker pool a job leaves `queued` the moment it is DISPATCHED, sits in
   * `inFlight` while a worker meshes it, then in `pendingUploads` until the
   * upload budget takes it - so `queued` reads 0 with bakes still outstanding and
   * a one-counter gate does not gate at all. ChunkManager._updateStats documents
   * the three as disjoint and says in so many words that anything asking whether
   * the ground is finished has to add them.
   */
  function terrainOutstanding() {
    const s = game.chunks?.stats;
    if (s === undefined) return 0;
    if (!statsShapeChecked) {
      statsShapeChecked = true;
      const missing = ['queued', 'inFlight', 'pendingUploads']
        .filter((f) => typeof s[f] !== 'number');
      if (missing.length > 0) {
        console.error(
          `[scatter] ChunkManager.stats is missing ${missing.join(', ')}, so the ` +
          'terrain gate cannot tell whether a bake is still in flight. Scatter ' +
          'will generate on top of terrain that has not been meshed.');
      }
    }
    return s.queued + s.inFlight + s.pendingUploads;
  }

  // -------------------------------------------------------------------------
  // Mesh library
  // -------------------------------------------------------------------------

  /**
   * Generate every type at every LOD it needs and pack them into one pair of
   * buffers.
   *
   * The MESH SEED is the type id, not the world seed: a rock's SHAPE does not
   * have to change when the planet does, and pinning it means the mesh library
   * is identical across saves and can be built before the world seed is known.
   * Per-instance variety comes from the instance tint, the scale, the stretch
   * and the yaw, which are all seeded from the world.
   */
  function buildMeshLibrary() {
    const vertexChunks = [];
    const indexChunks = [];
    lodChains = new Array(SCATTER_TYPE_COUNT);
    let vertexCursor = 0;
    let indexCursor = 0;
    let totalTriangles = 0;

    for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
      const type = SCATTER_TYPES[t];
      const generator = meshgen[type.generator];
      if (typeof generator !== 'function') {
        missingGenerators.push(type.id);
        lodChains[t] = [];
        continue;
      }

      auditMeshParams(type, generator);

      const chain = [];
      for (let detail = type.maxDetail; detail >= MESH_DETAIL.LOW; detail--) {
        const mesh = generator(
          ...scatterGeneratorArgs(type, { ...type.meshParams, detail }));
        const packed = packMesh(mesh);
        vertexChunks.push(packed);
        const indices = new Uint32Array(mesh.indices);
        indexChunks.push(indices);

        chain.push({
          detail,
          firstIndex: indexCursor,
          indexCount: mesh.indexCount,
          baseVertex: vertexCursor,
          radius: mesh.boundingRadius,
          maxDist: 0,     // filled below, once the chain length is known
          triangles: mesh.triangleCount,
        });
        vertexCursor += mesh.vertexCount;
        indexCursor += mesh.indexCount;
        totalTriangles += mesh.triangleCount;
      }
      // Nearest tier first. The last entry always reaches the type's full view
      // distance, whatever DETAIL_SWITCH says, or a type whose maxDetail is LOW
      // would vanish at half its range.
      for (let i = 0; i < chain.length; i++) {
        chain[i].maxDist = type.viewDistance * DETAIL_SWITCH[chain[i].detail];
      }
      chain[chain.length - 1].maxDist = type.viewDistance;
      lodChains[t] = chain;
      bakeTypeEmit(t, type, generator);
    }

    if (missingGenerators.length > 0) {
      console.error(
        `[scatter] world/meshgen.js does not export ${missingGenerators.length} ` +
        'generator(s) the scatter table names, so those types will not be drawn: ' +
        missingGenerators.map((id) => `${SCATTER_TYPES[id].key} -> ${SCATTER_TYPES[id].generator}`)
          .join(', '));
    }

    // One upload each. Concatenating on the CPU and writing once beats 90 small
    // writeBuffers, and the arrays are transient either way.
    const vertexBytes = vertexChunks.reduce((n, a) => n + a.byteLength, 0);
    const indexBytes = indexChunks.reduce((n, a) => n + a.byteLength, 0);
    const vertexData = new Uint8Array(vertexBytes);
    let vo = 0;
    for (const a of vertexChunks) { vertexData.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), vo); vo += a.byteLength; }
    const indexData = new Uint32Array(indexBytes / 4);
    let io = 0;
    for (const a of indexChunks) { indexData.set(a, io); io += a.length; }

    meshVertexBuffer = createBuffer(device, {
      label: 'scatter.mesh.vb',
      size: Math.max(vertexBytes, SCATTER_VERTEX_STRIDE),
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    meshIndexBuffer = createBuffer(device, {
      label: 'scatter.mesh.ib',
      size: Math.max(indexBytes, 4),
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    });
    if (vertexBytes > 0) device.queue.writeBuffer(meshVertexBuffer, 0, vertexData);
    if (indexBytes > 0) device.queue.writeBuffer(meshIndexBuffer, 0, indexData);

    stats.meshTriangles = totalTriangles;
    stats.meshBytes = vertexBytes + indexBytes;
    console.info(
      `[scatter] mesh library: ${SCATTER_TYPE_COUNT - missingGenerators.length} types, ` +
      `${vertexChunks.length} LOD meshes, ${totalTriangles.toLocaleString()} triangles, ` +
      `${(stats.meshBytes / 1048576).toFixed(2)} MB`);
  }

  /**
   * Report every `meshParams` key that reaches no code at all.
   *
   * `meshParams` is forwarded to the generator as its `opts` bag, so a key the
   * generator never reads - and that `scatter_emit.js`'s GENERATOR_SHAPE_ARGS
   * never lifts into a positional argument - is inert. `check.mjs` cannot see across that boundary
   * because the connection is a property name inside an object literal in one
   * file and a property READ in another, and 46 of the table's 93 keys had
   * accumulated on the dead side of it: `rings`+`radial`+`bore` on both sponges,
   * `subdiv` on every rock and ore, `veins` on every ore, `prisms`, `pods`,
   * `fronds`, `faces`, `taper`, `mesh`.
   *
   * The check is a READ RECORDER, not a declared key list, because a declared
   * list is a second copy of the truth and would drift the first time a
   * generator changed its mind. The params object is wrapped in a Proxy whose
   * `get` trap records the key, the generator is run once against it, and
   * whatever was never touched is by construction dead. Run once per type at
   * boot, against a mesh that is thrown away.
   */
  function auditMeshParams(type, generator) {
    const params = { ...type.meshParams, detail: type.maxDetail };
    const read = new Set();
    const probe = new Proxy(params, {
      get(target, key) { read.add(key); return target[key]; },
      has(target, key) { read.add(key); return key in target; },
    });
    try {
      generator(...scatterGeneratorArgs(type, probe));
    } catch (err) {
      console.error(`[scatter] ${type.key}: ${type.generator} threw while auditing ` +
        `its meshParams: ${err && err.message}`);
      return;
    }
    // `detail` is injected here rather than authored, so it is never a finding.
    const dead = Object.keys(type.meshParams).filter((k) => !read.has(k));
    if (dead.length > 0) {
      console.error(
        `[scatter] ${type.key}.meshParams has ${dead.length} key(s) that ` +
        `${type.generator} never reads and scatter_emit.js's ` +
        'GENERATOR_SHAPE_ARGS never passes ' +
        `positionally, so they change nothing: ${dead.join(', ')}`);
    }
    return dead;
  }

  /**
   * Fan `bakeScatterTypeEmit`'s per-type record into the SoA arrays above.
   *
   * The arithmetic itself lives in `render/scatter_emit.js` because
   * `tools/scatter-census.mjs` needs exactly the same numbers offline and a
   * closure inside this pass is unreachable without a `GPUDevice` - which is the
   * reason the census could not be written until 2026-08-06. Do not reinstate a
   * local copy: an emitted-flux figure that disagrees with the one the light
   * submitter ranks on is worse than no figure at all.
   */
  function bakeTypeEmit(t, type, generator) {
    typeEmit.fluoresces[t] = type.fluoresces ? 1 : 0;
    const e = bakeScatterTypeEmit(type, generator);
    if (e === null) return;
    typeEmit.area[t] = e.area;
    typeEmit.radius[t] = e.radius;
    typeEmit.centroid[t * 3 + 0] = e.centroid[0];
    typeEmit.centroid[t * 3 + 1] = e.centroid[1];
    typeEmit.centroid[t * 3 + 2] = e.centroid[2];
    typeEmit.flux[t * 3 + 0] = e.flux[0];
    typeEmit.flux[t * 3 + 1] = e.flux[1];
    typeEmit.flux[t * 3 + 2] = e.flux[2];
  }

  /**
   * Keep the emissive instances of one generated chunk on the CPU.
   *
   * The glow pass needs a world position, a scale and the per-instance emissive
   * multiplier for every emitter within range, and the GPU instance buffer is
   * write-only from here. Measured share of instances that are emissive-typed:
   * 7.0% at the 120 m station and 24.7% in the abyss, so this is ~260 kB across
   * 32 resident chunks.
   *
   * The basis rows are the SCALED axes (see SCATTER_STRIDE), so the scale comes
   * back out as their lengths. A non-uniform (sxz, sy, sxz) scale multiplies area
   * by neither sxz^2 nor sy^2, so the geometric mean (sxz^2 * sy)^(1/3) is used
   * and squared - exact for a uniform scale and within a few per cent for the
   * stretches the generator actually applies.
   */
  function extractEmissive(data, originX, originZ) {
    const f = data.instances;
    const u8 = new Uint8Array(f.buffer, f.byteOffset, data.count * SCATTER_STRIDE);
    let n = 0;
    for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
      if (typeEmit.area[t] > 0) n += data.countsByType[t];
    }
    if (n === 0) return null;
    const out = {
      count: 0,
      // The chunk's own origin, so the glow pass can walk resident chunks in a
      // deterministic order rather than in Map insertion order.
      originX, originZ,
      // The packed (cx, cz) key. submitLights() needs an id for an emissive
      // instance that survives from frame to frame, or its hysteresis has
      // nothing to compare against.
      key: key(Math.round(originX / CHUNK_SIZE), Math.round(originZ / CHUNK_SIZE)),
      pos: new Float32Array(n * 3),
      scale: new Float32Array(n),
      emitScale: new Float32Array(n),
      type: new Uint8Array(n),
      // The instance's SCALED local Y axis, for submitLights(). Its length is
      // the vertical scale and its direction is where the mesh's up went after
      // `align` and `tilt`, so `up * typeEmit.centroid.y` is the offset from the
      // instance origin to the emissive centroid without a second basis lookup.
      // A wall-hanging form (align 1.0 on a vertical face) has this pointing
      // sideways, which is exactly right and is what a world-up offset would get
      // wrong.
      up: new Float32Array(n * 3),
      // Where each type's instances start and how many there are, INSIDE these
      // arrays - not data.firstByType, which indexes the full instance buffer
      // including the non-emissive types. submitLights()'s beacon pass walks
      // seven eligible types out of forty-two and must not touch the rest.
      typeFirst: new Int32Array(SCATTER_TYPE_COUNT),
      typeCount: new Int32Array(SCATTER_TYPE_COUNT),
    };
    let k = 0;
    for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
      const c = data.countsByType[t];
      if (c === 0 || typeEmit.area[t] <= 0) continue;
      const first = data.firstByType[t];
      out.typeFirst[t] = k;
      out.typeCount[t] = c;
      for (let j = 0; j < c; j++) {
        const o = (first + j) * 16;
        const sxz = Math.hypot(f[o + 0], f[o + 4], f[o + 8]);
        const uy0 = f[o + 1], uy1 = f[o + 5], uy2 = f[o + 9];
        const sy = Math.hypot(uy0, uy1, uy2);
        out.pos[k * 3 + 0] = originX + f[o + 3];
        out.pos[k * 3 + 1] = f[o + 7];
        out.pos[k * 3 + 2] = originZ + f[o + 11];
        out.up[k * 3 + 0] = uy0;
        out.up[k * 3 + 1] = uy1;
        out.up[k * 3 + 2] = uy2;
        out.scale[k] = Math.cbrt(sxz * sxz * sy);
        out.emitScale[k] = u8[(first + j) * SCATTER_STRIDE + 51] / 255;
        out.type[k] = t;
        k++;
      }
    }
    out.count = k;
    return k > 0 ? out : null;
  }

  /**
   * Pack one meshgen structure-of-arrays mesh into the interleaved 40-byte
   * vertex the pipeline expects.
   *
   * Colour is stored as sqrt(linear), the same encoding terrain.js uses for its
   * vertex albedo and for the same reason: eight bits of LINEAR colour puts its
   * first step at 1/255, which is 13% of a dark basalt's 0.03 reflectance and
   * bands visibly across a rock face. sqrt spends the codes where the eye is.
   */
  function packMesh(mesh) {
    const n = mesh.vertexCount;
    const buf = new ArrayBuffer(n * SCATTER_VERTEX_STRIDE);
    const f32 = new Float32Array(buf);
    const u8 = new Uint8Array(buf);
    const pos = mesh.positions, nrm = mesh.normals, uv = mesh.uvs;
    const col = mesh.colors, mat = mesh.materials;

    for (let i = 0; i < n; i++) {
      const o = i * SCATTER_VERTEX_FLOATS;
      const b = i * SCATTER_VERTEX_STRIDE;
      const p3 = i * 3, p2 = i * 2, p4 = i * 4;
      f32[o + 0] = pos[p3]; f32[o + 1] = pos[p3 + 1]; f32[o + 2] = pos[p3 + 2];
      f32[o + 3] = nrm[p3]; f32[o + 4] = nrm[p3 + 1]; f32[o + 5] = nrm[p3 + 2];
      f32[o + 6] = uv[p2]; f32[o + 7] = uv[p2 + 1];
      u8[b + 32] = clampByte(Math.sqrt(Math.max(col[p4], 0)) * 255);
      u8[b + 33] = clampByte(Math.sqrt(Math.max(col[p4 + 1], 0)) * 255);
      u8[b + 34] = clampByte(Math.sqrt(Math.max(col[p4 + 2], 0)) * 255);
      u8[b + 35] = mat[i] & 0x07;
      // colour.w is the sway weight meshgen guarantees on every vertex.
      f32[o + 9] = col[p4 + 3];
    }
    return f32;
  }

  const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0);

  // -------------------------------------------------------------------------
  // Residency
  // -------------------------------------------------------------------------

  /** Rebuild the desired chunk set. Cheap: the radius is 23 chunks, not 3000. */
  function rescan(camX, camZ) {
    lastScanX = camX;
    lastScanZ = camZ;
    const radius = SCATTER_MAX_VIEW_DISTANCE;
    const half = CHUNK_SIZE * 0.5;
    const c0x = Math.floor((camX - radius) / CHUNK_SIZE);
    const c1x = Math.floor((camX + radius) / CHUNK_SIZE);
    const c0z = Math.floor((camZ - radius) / CHUNK_SIZE);
    const c1z = Math.floor((camZ + radius) / CHUNK_SIZE);
    const r2 = radius * radius;

    queue.length = 0;
    queued.clear();

    for (let cz = c0z; cz <= c1z; cz++) {
      const ddz = cz * CHUNK_SIZE + half - camZ;
      for (let cx = c0x; cx <= c1x; cx++) {
        const ddx = cx * CHUNK_SIZE + half - camX;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 > r2) continue;
        const k = key(cx, cz);
        // RESIDENCY is decided on the CENTRE, so the resident set stays a disc
        // and matches the unload test below. The LOD is decided on the NEAREST
        // POINT, because `maxLod` deletes whole types and the only question it
        // has to answer is how close anything in this chunk can get - see
        // scatterLodFor. The two differ by up to a half-diagonal, 90.5 m.
        const nx = Math.max(0, Math.abs(ddx) - half);
        const nz = Math.max(0, Math.abs(ddz) - half);
        const dist = Math.sqrt(nx * nx + nz * nz);
        const existing = chunks.get(k);
        if (existing) {
          existing.keep = true;
          // A RESIDENT CHUNK MUST BE ABLE TO CHANGE LOD - see
          // scatterLodTransition, which owns the rule and is asserted offline by
          // tools/test-scatter.mjs section 12.
          if (scatterLodTransition(existing.lod, dist) !== 'keep' && !queued.has(k)) {
            queued.add(k);
            queue.push({ k, cx, cz, dist });
          }
          continue;
        }
        if (queued.has(k)) continue;
        queued.add(k);
        queue.push({ k, cx, cz, dist });
      }
    }
    // Nearest first: the ground under the player's mask must not be the last
    // thing to grow plants.
    queue.sort((a, b) => a.dist - b.dist);

    const unloadR = radius * UNLOAD_MARGIN;
    const unloadR2 = unloadR * unloadR;
    for (const chunk of chunks.values()) {
      if (chunk.keep) { chunk.keep = false; continue; }
      const ddx = chunk.originX + half - camX;
      const ddz = chunk.originZ + half - camZ;
      if (ddx * ddx + ddz * ddz > unloadR2) unload(chunk);
    }
  }

  function unload(chunk) {
    chunk.buffer?.destroy();
    liveInstances -= chunk.count;
    chunks.delete(chunk.k);
  }

  /**
   * Generate one queued chunk and upload it.
   *
   * A job may be a REFINEMENT of a chunk that is already resident, so the old
   * buffer has to be reclaimed - both its GPU allocation and its share of
   * liveInstances. The budget is computed against liveInstances WITHOUT the old
   * chunk, because those instances are about to be released; charging them twice
   * would make a refine near the global cap generate a chunk poorer than the one
   * it replaces.
   */
  function generate(job) {
    const lod = scatterLodFor(job.dist);
    const prev = chunks.get(job.k);
    const inUse = liveInstances - (prev ? prev.count : 0);
    const budget = Math.min(SCATTER_MAX_PER_CHUNK, SCATTER_GLOBAL_CAP - inUse);
    if (budget <= 0) return false;

    const data = generateScatterForChunk(job.cx, job.cz, lod, { budget });
    const chunk = {
      k: job.k, cx: job.cx, cz: job.cz, lod,
      originX: job.cx * CHUNK_SIZE, originZ: job.cz * CHUNK_SIZE,
      count: data.count,
      countsByType: data.countsByType,
      firstByType: data.firstByType,
      aabb: data.aabb,
      buffer: null,
      keep: false,
      sortKey: 0,
      // Emissive instances kept on the CPU for render/passes/glow.js. Null when
      // the chunk holds none, which is most of the map.
      emit: extractEmissive(data, job.cx * CHUNK_SIZE, job.cz * CHUNK_SIZE),
    };
    if (prev) {
      prev.buffer?.destroy();
      liveInstances -= prev.count;
    }
    if (data.count > 0) {
      const bytes = data.count * SCATTER_STRIDE;
      chunk.buffer = createBuffer(device, {
        label: `scatter.inst.${job.cx}.${job.cz}`,
        size: bytes,
        usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(chunk.buffer, 0, data.instances.buffer,
        data.instances.byteOffset, bytes);
      liveInstances += data.count;
    }
    chunks.set(job.k, chunk);
    stats.generateMsLast = data.genMs;
    if (data.genMs > stats.generateMsPeak) stats.generateMsPeak = data.genMs;
    return true;
  }

  function drainQueue(msBudget) {
    if (queue.length === 0) return;
    const t0 = performance.now();
    // Always admit the first job: the budget test runs BEFORE the job is
    // charged, so a queue can never stall behind a chunk that is on its own
    // more expensive than the whole budget.
    do {
      const job = queue.shift();
      queued.delete(job.k);
      generate(job);
    } while (queue.length > 0 && performance.now() - t0 < msBudget);
    refreshStats();
  }

  /**
   * Is type `t` worth drawing as a shadow caster in this chunk, at this cascade?
   *
   * THE SUB-TEXEL CULL IS THE REAL SAVING. A caster narrower than the receiver's
   * PCF kernel cannot leave a shadow that survives filtering, so drawing it is
   * pure cost. `minSize` is 1.5 kernel radii in metres: 13 cm in cascade 0 and
   * 1.35 m in cascade 3, which removes shoreGrass (2,400 per chunk), seagrass
   * (2,600), beachPebble (1,100) and the gravel fields from the far cascades
   * while keeping boulders, giant kelp and coral heads everywhere.
   *
   * The size test uses the type's LARGEST instance scale, so it can only ever
   * under-cull. Over-culling here is the one visible failure mode: too
   * aggressive and coral heads stop casting on the reef floor.
   */
  function shadowTypeSkipped(chunk, t, dist, minSize, cascade) {
    if (chunk.countsByType[t] === 0) return true;
    const chain = lodChains[t];
    if (chain.length === 0) return true;
    const type = SCATTER_TYPES[t];
    // Past its view distance the vertex shader shrinks the mesh to nothing, so
    // the draw would rasterise zero pixels. Same test the colour pass applies.
    if (dist > type.viewDistance) return true;
    const entry = shadowChainEntry(t, dist, cascade);
    if (entry === null) return true;
    const maxScale = type.scale ? type.scale[1] : 1;
    return 2 * entry.radius * maxScale < minSize;
  }

  /**
   * The LOD mesh a shadow caster draws.
   *
   * Cascades 0 and 1 use exactly what the colour pass picks, so the shadow's
   * silhouette is the silhouette on screen. From SHADOW_SCATTER_COARSE_FROM
   * outward the cascade texel is 22.8 cm or more and the whole plant is a few
   * texels wide, so the coarsest mesh in the chain carries it - which matters,
   * because cascades are NESTED spheres and a plant two metres from the eye is
   * otherwise re-transformed at full detail in all four of them.
   */
  function shadowChainEntry(t, dist, cascade) {
    const chain = lodChains[t];
    if (chain.length === 0) return null;
    if (cascade >= RENDER.SHADOW_SCATTER_COARSE_FROM) return chain[chain.length - 1];
    return pickLod(chain, dist);
  }

  function refreshStats() {
    stats.residentChunks = chunks.size;
    stats.queuedChunks = queue.length;
    stats.instances = liveInstances;
    let bytes = 0;
    for (const c of chunks.values()) bytes += c.count * SCATTER_STRIDE;
    stats.gpuBytes = bytes + stats.meshBytes;
  }

  // -------------------------------------------------------------------------
  // Deep scatter lights
  //
  // ~800 emissive props are drawn per deep chunk and every one of them was a
  // SELF-LIT DECAL: a glowcup pooled no light on the sediment under it, a vent
  // chimney did not light its own plume, a crystal spire threw no colour onto
  // the rock beside it. renderer.addLight() had four call sites - the vessel,
  // the player, the habitat and the creatures - and not one of them was scatter,
  // against RENDER.MAX_LIGHTS 256 of which a deep frame used 6-12. Below the
  // photic zone the frame IS the emissive scatter (nulling this pass at Abyssal
  // Plain drops scene luminance 99.86%) and none of it was a light, which is why
  // dark mass measures EXACTLY 0.0000 across 1.2 M pixels at all twelve
  // underwater anchors against 0.011-0.184 in the reference frames.
  //
  // TWO CLASSES, AND THE SPLIT IS ABOUT THE FROXEL, NOT ABOUT BRIGHTNESS.
  // BEACONS carry `volumetric: 1.0` and are the only new lights that enter
  // sim/froxel_inject's per-froxel loop, so they cost 921,600 samples each;
  // FILL carries `volumetric: 0` and is skipped there by the hoisted shape.z
  // test, so it is contact light on geometry and nothing else.
  //
  // WHAT DECIDES WHO IS A BEACON IS SIGNATURE MEMBERSHIP, NOT FLUX, AND THAT IS
  // THE ONE RULE THIS FILE EXISTS TO ENFORCE. Read off the shipped bake, W/sr at
  // the mid of each type's own authored scale range: mushroomCluster 13.31,
  // crystalSpire 6.93, ventChimney 1.13, crystalShard 0.74, mushroomCap 0.77,
  // glowPod 0.48 - against the signatures trenchWallSpine 36.84, spireCrown
  // 26.74, canyonBanner 8.83, terraceVeil 7.03, ventCathedral 6.09, abyssRib
  // 0.95 and shelfUrn 0.54. Take the largest NON-FLUORESCING emitter each deep
  // biome actually carries, which is what a flux ranking would pick, and the
  // answer is a SHARED prop at four of the seven: crystalShard at Shelf Break
  // (0.74 against shelfUrn's 0.54, and "trench crystals" is on that biome's
  // Avoid list) and mushroomCluster at Twilight Terraces, Abyssal Plain and
  // Trench Floor (13.31 against terraceVeil 7.03, abyssRib 0.95 and
  // ventCathedral 6.09; Abyssal Plain's Avoid column names "mushroom forest" in
  // so many words). Rank by POPULATION x flux instead - the delivered figure -
  // and it is worse still, because the shared kit outnumbers every signature.
  //
  // So the beacon class is CLOSED to the signature rows plus
  // RENDER.DEEP_BEACON_EXTRA; the fill class is open but pays
  // RENDER.DEEP_LIGHT_EXCLUSIVITY_POW for every extra biome the type lives in
  // and is capped per type.
  //
  // AND THE FIGURE THAT ONCE STOOD HERE WAS THE WRONG QUANTITY. It read "the
  // share of SUBMITTED RADIANT INTENSITY going to a signature form: Boulder
  // Field 0.970, Shelf Break 0.933, ... Trench Floor 1.000 - and no form on a
  // biome's own Avoid list exceeds 0.065 of it anywhere", and it is deleted
  // rather than corrected in place because it was never a measurement of the
  // thing it was quoted for. A frame is made of DELIVERED IRRADIANCE, I/d^2,
  // from the lights whose influence reaches the frustum; beacons are searched to
  // 160 m and fill to 35 m, so summing I over both classes buries a factor of
  // 10^2-10^3 that runs entirely one way - it flatters the far signature and
  // hides the near shared kit. Shelf Break's 0.933 is 0.094 of the delivered
  // quantity, and Boulder Field's 0.970 is 0.174.
  //
  // MEASURED ON DELIVERED IN-FRUSTUM IRRADIANCE, six headings per anchor at the
  // biome-anchor arrival pose, day 0.32 - the share going to a signature form,
  // and the largest single contributor:
  //
  //   Boulder Field   0.174  oreCopper       0.697   (no emissive signature)
  //   Shelf Break     0.094  crystalShard    0.902   AVOID: "trench crystals"
  //   Rock Spires     0.966  spireCrown      0.952
  //   Twilight Terr.  0.717  terraceVeil     0.717
  //   Canyon Wall     0.669  canyonBanner    0.669
  //   Abyssal Plain   0.213  mushroomCap     0.412   AVOID: "mushroom forest"
  //   Trench Wall     0.483  trenchWallSpine 0.473
  //   Trench Floor    1.000  trenchWallSpine 0.973
  //
  // FIVE OF THE EIGHT ARE LIT BY THEIR OWN SIGNATURE and two are not, and the
  // two that are not are a CONTENT fact and not a selection one: crystalShard
  // carries bit 7 (Shelf Break) and mushroomCap and glowPod both carry bit 11
  // (Abyssal Plain), against signatures of shelfUrn 0.54 W/sr at 130 m and
  // abyssRib 0.95 W/sr at 93 m. No ranking makes a 0.54 W/sr urn at 130 m beat
  // a 0.74 W/sr shard at 17 m; the fix is the biome mask in world/scatter.js.
  // -------------------------------------------------------------------------

  /**
   * Per-type light metadata, derived once at boot off the shipped table and the
   * emission bake. Nothing here is authored twice: `signatureBiome` and `biomes`
   * are world/scatter.js's own fields.
   */
  const lightMeta = {
    /** 1 if this type may be promoted at all. */
    eligible: new Uint8Array(SCATTER_TYPE_COUNT),
    /** 1 if this type may be promoted as a BEACON. */
    beacon: new Uint8Array(SCATTER_TYPE_COUNT),
    /** Radiant intensity at instance scale 1, W/sr - max over the channels. */
    peak: new Float32Array(SCATTER_TYPE_COUNT),
    /** flux / peak: a unit-peak hue, because Light packs colour x scalar. */
    colour: new Float32Array(SCATTER_TYPE_COUNT * 3),
    /** 1 / popcount(biomes) ^ RENDER.DEEP_LIGHT_EXCLUSIVITY_POW. */
    exclusivity: new Float32Array(SCATTER_TYPE_COUNT),
    /** The beacon-eligible type ids, so the beacon walk skips 47 of 59 rows
     *  (a signature with baked peak 0 is skipped too - meadowPillar). */
    beaconTypes: [],
  };

  /**
   * Resolve which types can carry a light, and how much they are worth.
   *
   * FLUORESCING TYPES ARE EXCLUDED, ALL OF THEM. Their emission is PUMPED by
   * surviving blue daylight rather than self-powered - pass/scatter.wgsl applies
   * the pump per pixel and glow.js applies the identical one to the sprite - and
   * at the depths this runs at that pump is essentially zero. Promoting one
   * would be a self-powered light for a re-emitter, which is the exact error
   * glow.js documents at its own scatter gate. It costs Shelf Break its
   * brightest form (coralFan, 68.0% of the biome's authored flux) and Coral
   * Garden its signature, and it is still right.
   */
  function buildLightMeta() {
    const extra = new Set(RENDER.DEEP_BEACON_EXTRA || []);
    const seen = new Set();
    for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
      const type = SCATTER_TYPES[t];
      const r = typeEmit.flux[t * 3], g = typeEmit.flux[t * 3 + 1], b = typeEmit.flux[t * 3 + 2];
      const peak = Math.max(r, g, b);
      lightMeta.peak[t] = peak;
      if (peak > 0) {
        lightMeta.colour[t * 3 + 0] = r / peak;
        lightMeta.colour[t * 3 + 1] = g / peak;
        lightMeta.colour[t * 3 + 2] = b / peak;
      }
      // popcount of the biome mask. A signature row is in one biome and pays
      // nothing; mushroomCap and glowPod are in five and pay 25x at exponent 2.
      let bits = 0;
      for (let m = type.biomes >>> 0; m !== 0; m >>>= 1) bits += m & 1;
      lightMeta.exclusivity[t] = 1 / Math.pow(Math.max(bits, 1),
        RENDER.DEEP_LIGHT_EXCLUSIVITY_POW);

      const eligible = peak > 0 && !typeEmit.fluoresces[t];
      lightMeta.eligible[t] = eligible ? 1 : 0;
      const isExtra = extra.has(type.key);
      if (isExtra) seen.add(type.key);
      lightMeta.beacon[t] = (eligible && (type.signatureBiome != null || isExtra)) ? 1 : 0;
      if (lightMeta.beacon[t]) lightMeta.beaconTypes.push(t);
    }
    for (const k of extra) {
      if (!seen.has(k)) {
        // Loud, because a typo here is invisible in the frame: the biome simply
        // has no beacon and the deep looks exactly as flat as it did before.
        console.error(
          `[scatter] RENDER.DEEP_BEACON_EXTRA names '${k}', which is not a key in ` +
          'the scatter table. That biome will get no beacon.');
      }
    }
  }

  /**
   * The three knobs the DELIVERED-IRRADIANCE selection adds, live-mutable so an
   * A/B is a console poke and not a rebuild. Published as `pass.lightTuning`.
   *
   * THESE BELONG IN core/constants.js AND ARE HERE ONLY BECAUSE THIS STAGE'S
   * FILE OWNERSHIP STOPS AT THIS FILE. Move them, keeping the derivations, the
   * first time constants.js is open. Every one of them reproduces the previous
   * selection exactly at its OFF value, which is what makes the fix bisectable
   * on its own:
   *   frustumOnly = false, typeIrradianceCap = 1, overselect = 1
   * is byte-for-byte the shipped Stage 2 selection.
   *
   * WHY THIS EXISTS AT ALL. `lightReport()` used to rank types by SUBMITTED
   * RADIANT INTENSITY summed over a 160 m sphere, and a frame is not made of
   * that - it is made of DELIVERED IRRADIANCE, I/d^2, from the lights whose
   * influence reaches the frustum. Because beacons are searched to 160 m and
   * fill to 35 m, a shared-kit fill light at 4 m beats a signature beacon at
   * 60-130 m by two to three orders of magnitude, and the old metric could not
   * see it. Re-ranked on the real quantity, Twilight Terraces was glowPod 70.1%
   * against terraceVeil 2.6% and Abyssal Plain was mushroomCap 52.2% + glowPod
   * 36.8% - both biomes lit by the exact forms their own Avoid column names,
   * under an acceptance criterion that read PASS.
   */
  const lightTuning = {
    /**
     * Skip a candidate whose INFLUENCE SPHERE misses the frustum.
     *
     * This is exact, not an approximation: `punctualAttenuation`'s window is
     * zero at the light's own range, so a light whose sphere of radius `range`
     * does not intersect the frustum cannot put a photon on any visible
     * surface. It is therefore not a dimming - it is a slot that was being
     * spent on a light behind the eye being spent on one in front of it. There
     * is no popping to guard against for the same reason: a sphere leaving the
     * frustum is contributing zero at the moment it leaves.
     */
    frustumOnly: true,
    /**
     * Most of the frame's DELIVERED IRRADIANCE any one scatter type may supply,
     * beacons and fill counted together.
     *
     * This is the constraint the Avoid rule actually needs, and it is stated on
     * the delivered quantity because that is the quantity the rule is about.
     * `DEEP_FILL_PER_TYPE` bounds SLOTS, which is a different thing: four
     * glowPods at 3 m and one terraceVeil at 40 m is four slots against one and
     * 27x the irradiance per slot.
     *
     * 0.34 is a third of the frame, i.e. no single form may be a plurality
     * against the two next-largest together. Lower starves the near field of
     * contact light in biomes that genuinely carry only two eligible forms;
     * higher stops binding at the biomes that need it.
     */
    typeIrradianceCap: 0.34,
    /**
     * How many candidates per class the ranking pass keeps, as a multiple of
     * the class's light count.
     *
     * The cap can only REPLACE a light, never merely delete one - the frames
     * the Stage 2 lights produced are the best thing in the stage and the goal
     * is a different composition, not a darker one. Replacement needs
     * runners-up, and 3x is what makes a capped type's slot go to the next form
     * rather than to nothing. It costs one bounded array walk, not a second
     * walk of the seabed.
     */
    overselect: 3,
  };

  /**
   * One ranked, bounded, per-type-capped selection of instances.
   *
   * The shape is creatures.js's `lightSlots` / `lightScore` - a fixed array plus
   * replace-the-weakest - with two additions. The PER-TYPE CAP is what stops the
   * fill class collapsing onto whichever shared form is brightest in the biome,
   * and it is enforced by making an over-quota candidate able to displace only
   * the weakest entry OF ITS OWN TYPE, so the cap can never be exceeded and a
   * better instance of a capped type still gets in.
   */
  function makeSelection(capacity) {
    return {
      n: 0,
      capacity,
      id: new Float64Array(capacity),
      score: new Float64Array(capacity),
      chunk: new Array(capacity).fill(null),
      index: new Int32Array(capacity),
      type: new Int32Array(capacity),
      order: new Int32Array(capacity),
      perType: new Int32Array(SCATTER_TYPE_COUNT),
      // DELIVERED IRRADIANCE at the eye, W/m^2, before the gate/gain: the
      // candidate's radiant intensity over max(d^2, 1). This is the quantity a
      // frame is actually made of, and it is carried on the slot rather than
      // recomputed so that the cap phase, the emit and the report cannot
      // disagree about it. See planEmission().
      irr: new Float64Array(capacity),
      /**
       * Squared eye distance, so the report needs no second walk. It is to the
       * instance ORIGIN, the same distance the score is built from, and not to
       * the emissive centroid the light is finally placed at - the two differ by
       * the centroid offset, under 2 m on every emissive form in the table, and
       * using one number for the score, the cap and the report is worth more
       * than that.
       */
      d2: new Float64Array(capacity),
      /** Slot indices this frame's cap phase chose, in emission order. */
      plan: new Int32Array(capacity),
      planN: 0,
    };
  }

  function resetSelection(sel) {
    sel.n = 0;
    sel.planN = 0;
    sel.perType.fill(0);
  }

  function writeSlot(sel, k, id, score, chunk, index, type, irr, d2) {
    sel.id[k] = id;
    sel.score[k] = score;
    sel.chunk[k] = chunk;
    sel.index[k] = index;
    sel.type[k] = type;
    sel.irr[k] = irr;
    sel.d2[k] = d2;
  }

  function considerSlot(sel, want, perTypeCap, id, score, chunk, index, type, irr, d2) {
    if (sel.perType[type] >= perTypeCap) {
      let worst = -1;
      for (let i = 0; i < sel.n; i++) {
        if (sel.type[i] !== type) continue;
        if (worst < 0 || sel.score[i] < sel.score[worst]) worst = i;
      }
      if (worst >= 0 && score > sel.score[worst]) {
        writeSlot(sel, worst, id, score, chunk, index, type, irr, d2);
      }
      return;
    }
    if (sel.n < want) {
      writeSlot(sel, sel.n, id, score, chunk, index, type, irr, d2);
      sel.perType[type]++;
      sel.n++;
      return;
    }
    let worst = 0;
    for (let i = 1; i < sel.n; i++) if (sel.score[i] < sel.score[worst]) worst = i;
    if (score > sel.score[worst]) {
      sel.perType[sel.type[worst]]--;
      writeSlot(sel, worst, id, score, chunk, index, type, irr, d2);
      sel.perType[type]++;
    }
  }

  /**
   * Fill `sel.order` with slot indices, brightest first.
   *
   * SUBMISSION ORDER IS LOAD-BEARING. cluster_cull.wgsl breaks its fill loop at
   * MAX_LIGHTS_PER_CLUSTER and walks lights in INDEX order, so a saturated
   * cluster keeps the 32 LOWEST-INDEXED lights and not the nearest. Insertion
   * sort, on a reused array, because n is 10 or 40 and it must not allocate.
   */
  function sortSelection(sel) {
    for (let i = 0; i < sel.n; i++) sel.order[i] = i;
    for (let i = 1; i < sel.n; i++) {
      const v = sel.order[i];
      const s = sel.score[v];
      let j = i - 1;
      while (j >= 0 && sel.score[sel.order[j]] < s) { sel.order[j + 1] = sel.order[j]; j--; }
      sel.order[j + 1] = v;
    }
  }

  /** Per-type delivered-irradiance budget, refilled by planEmission(). */
  const planTypeIrr = new Float64Array(SCATTER_TYPE_COUNT);
  /** Instance ids already planned this frame, so the two classes cannot double. */
  const planIds = new Set();

  /**
   * Choose which of the over-selected candidates actually become lights, under
   * a cap on the share of the frame's DELIVERED IRRADIANCE any one type may
   * supply.
   *
   * TWO ROUNDS, AND THE FIRST ONE IS ONLY THERE TO LEARN THE TOTAL. The cap is
   * a SHARE, so it cannot be enforced online: the budget depends on a total
   * that is not known until the selection is finished. Round 1 is the
   * unconstrained greedy - exactly what shipped - and its summed irradiance E0
   * is the budget's denominator; round 2 re-runs the same greedy against a
   * per-type budget of `cap * E0`. One round and not a fixed point, because E0
   * is an upper bound on the achievable total (round 2 can only replace a
   * candidate with a lower-scoring one), so the realised share can land a
   * little ABOVE `cap` and never wildly so - and the acceptance number is the
   * realised share, which `lightReport()` measures rather than assumes.
   *
   * BEACONS ARE PLANNED FIRST, for the reason emitSelection() states: the
   * classes overlap in the near field, a signature emitter four metres away
   * wins in both, and submitting it twice costs two cluster slots and two
   * froxel iterations for one prop. Planning beacons first also spends the
   * budget on the froxel-carrying class before the contact-light class sees it,
   * which is the direction this whole item wants.
   *
   * @param {object} bSel beacon candidates, already sorted by score
   * @param {number} bWant beacon lights to emit
   * @param {object} fSel fill candidates, already sorted by score
   * @param {number} fWant fill lights to emit
   */
  function planEmission(bSel, bWant, fSel, fWant) {
    const e0 = planRound(bSel, bWant, fSel, fWant, Infinity);
    const cap = clamp(lightTuning.typeIrradianceCap, 0, 1);
    if (cap >= 1 || !(e0 > 0)) return;
    planRound(bSel, bWant, fSel, fWant, cap * e0);
  }

  /** One greedy pass under a per-type irradiance budget. Returns the total. */
  function planRound(bSel, bWant, fSel, fWant, budget) {
    planIds.clear();
    planTypeIrr.fill(0);
    let total = 0;
    total += planClass(bSel, bWant, budget, bWant);
    total += planClass(fSel, fWant, budget, RENDER.DEEP_FILL_PER_TYPE);
    return total;
  }

  /**
   * Fill one class's plan, in score order, subject to the shared per-type
   * irradiance budget and the class's own per-type SLOT cap.
   *
   * The slot cap survives alongside the irradiance cap because they bound
   * different failures: slots bound cluster occupancy (which is why
   * DEEP_FILL_PER_TYPE is 4 of 12 and not 12), irradiance bounds who the frame
   * looks like it was lit by.
   *
   * TWO SWEEPS, AND THE SECOND ONE IS WHAT KEEPS THIS FROM BEING A DIMMER. The
   * capped sweep can run out of admissible candidates - at a biome that carries
   * only two eligible forms it does so immediately - and a cap that leaves the
   * slot EMPTY is just the deep going dark again, which is the one outcome this
   * item is not allowed to buy its diversity with. The second sweep therefore
   * refills whatever the first left, in the same score order, ignoring the
   * budget. The cap can consequently only ever REORDER who holds the slots; the
   * light COUNT is exactly what it would have been without it. Measured at
   * Boulder Field before this sweep existed: 15 lights -> 3, and delivered
   * in-frustum irradiance 2.7e-4 -> 4e-5.
   *
   * AND A TYPE'S FIRST LIGHT IS NEVER CAPPED, for the same reason in the other
   * direction: a single candidate can be worth more than the whole budget on its
   * own - at Boulder Field the brightest oreCopper is 2.4e-4 against a budget of
   * 1.4e-5 - and a rule that then admits NONE of that form has stopped bounding
   * repetition and started deleting the brightest light in the frame.
   *
   * SIGNATURE FORMS ARE EXEMPT OUTRIGHT. The cap exists to stop the SHARED KIT
   * owning a biome's light; a biome's own authored signature owning it is the
   * stated goal. Capping it inverts the item: measured at Twilight Terraces with
   * the exemption missing, terraceVeil went 0.752 -> 0.146 of delivered
   * irradiance and mushroomCap + glowPod - the two forms that biome's Avoid
   * column names - went 0.199 -> 0.715.
   */
  function planClass(sel, want, budget, slotCap) {
    sel.planN = 0;
    const perType = sel.perType;
    perType.fill(0);
    let total = 0;
    for (let sweep = 0; sweep < 2; sweep++) {
      const capped = sweep === 0 && budget !== Infinity;
      for (let k = 0; k < sel.n && sel.planN < want; k++) {
        const i = sel.order[k];
        const id = sel.id[i];
        if (planIds.has(id)) continue;
        const t = sel.type[i];
        if (perType[t] >= slotCap) continue;
        const e = sel.irr[i];
        if (capped && perType[t] > 0 && SCATTER_TYPES[t].signatureBiome == null
          && planTypeIrr[t] + e > budget) continue;
        planTypeIrr[t] += e;
        perType[t]++;
        total += e;
        planIds.add(id);
        sel.plan[sel.planN++] = i;
      }
      if (!capped || sel.planN >= want) break;
    }
    return total;
  }

  const beaconSel = makeSelection(RENDER.MAX_LIGHTS);
  const fillSel = makeSelection(RENDER.MAX_LIGHTS);
  /** Instance ids that held a light LAST frame, for the hysteresis margin. */
  const incumbents = new Set();
  /** Instance ids holding a light THIS frame; handed to glow.js. */
  const lightIds = new Set();
  const _lightPos = new Float32Array(3);
  const _lightColour = new Float32Array(3);
  const _candPos = new Float32Array(3);

  /**
   * Can this candidate put light on anything that is in the frame?
   *
   * The test is on the light's INFLUENCE SPHERE, not on the prop: a glowcup two
   * metres behind the eye with a 6 m range still pools light on the sediment in
   * front of it, and culling by the prop's own visibility would throw that
   * away. `punctualAttenuation`'s window is exactly zero at the light's range,
   * so a sphere of that radius that misses the frustum contributes nothing
   * anywhere, and dropping it is a slot freed rather than light removed. It is
   * also why there is no hysteresis margin here: a sphere crossing the frustum
   * plane is delivering zero at the crossing.
   *
   * The position is the EMISSIVE CENTROID, the same one emitSelection() submits
   * - see its comment about `up` and wall-hanging forms.
   */
  function candidateVisible(camera, ch, j, t, range) {
    const cy = typeEmit.centroid[t * 3 + 1];
    _candPos[0] = ch.pos[j * 3] + ch.up[j * 3] * cy;
    _candPos[1] = ch.pos[j * 3 + 1] + ch.up[j * 3 + 1] * cy;
    _candPos[2] = ch.pos[j * 3 + 2] + ch.up[j * 3 + 2] * cy;
    return camera.isSphereVisible(_candPos, range);
  }
  /**
   * Per-type accounting for the acceptance report, SPLIT BY CLASS. Reset every
   * frame.
   *
   * Two arrays and not one, because a beacon-eligible TYPE can also win a FILL
   * slot - a spireCrown four metres from the eye is a perfectly good contact
   * light - and a report that attributed those to the beacon class would credit
   * the class with light the froxel never carried. Measured, the mis-attribution
   * was small (abyssRib, 0.005 of Abyssal Plain) and it is exactly the kind of
   * instrument error this project keeps paying for.
   */
  const lightTypeCount = [new Int32Array(SCATTER_TYPE_COUNT), new Int32Array(SCATTER_TYPE_COUNT)];
  const lightTypeIntensity = [
    new Float64Array(SCATTER_TYPE_COUNT), new Float64Array(SCATTER_TYPE_COUNT)];
  /**
   * DELIVERED IRRADIANCE at the eye, W/m^2, summed per type per class - and
   * this, not `lightTypeIntensity`, is what the Avoid rule is graded on.
   *
   * `inFrustum` counts only the lights whose influence sphere reaches the
   * frustum, because a light behind the eye lights nothing that is in the
   * frame. `all` keeps the unrestricted sum so the two can be read side by side
   * and the restriction can be shown to be doing something. Both are summed
   * over the ACTUALLY SUBMITTED lights, after the 256-light budget and after
   * the beacon/fill de-duplication, so a light the renderer refused is not
   * credited to anybody.
   */
  const lightTypeIrrFrustum = [
    new Float64Array(SCATTER_TYPE_COUNT), new Float64Array(SCATTER_TYPE_COUNT)];
  const lightTypeIrrAll = [
    new Float64Array(SCATTER_TYPE_COUNT), new Float64Array(SCATTER_TYPE_COUNT)];
  /** Summed eye distance per type per class, for the report's mean. */
  const lightTypeDist = [
    new Float64Array(SCATTER_TYPE_COUNT), new Float64Array(SCATTER_TYPE_COUNT)];
  /** Lights whose influence sphere reached the frustum, per type per class. */
  const lightTypeSeen = [new Int32Array(SCATTER_TYPE_COUNT), new Int32Array(SCATTER_TYPE_COUNT)];

  /**
   * A stable id for one emissive instance: the chunk key, then the index inside
   * that chunk's emit arrays. SCATTER_MAX_PER_CHUNK is 6144, so 16 bits is
   * generous, and the product stays well inside a double's exact integer range.
   */
  const instanceId = (chunk, index) => chunk.key * 65536 + index;

  /**
   * Culling radius for a light of radiant intensity `intensity`.
   *
   * DERIVED, NOT AUTHORED PER CLASS. `punctualAttenuation`'s window is
   * (1-(r/R)^4)^2, which is still 0.88 at R/2, so a range longer than the light
   * can be seen at is CLOSER to inverse square than a tight one: it costs
   * cluster occupancy and never adds light. The honest radius is where the
   * irradiance falls to RENDER.DEEP_LIGHT_CUTOFF_E, which is sqrt(I / E). The
   * class ceiling then bounds the occupancy cost, and water transmittance -
   * which this does not model - cuts the true reach well inside the ceiling in
   * every water type except ABYSSAL_VOID.
   */
  function rangeFor(intensity, ceiling) {
    const r = Math.sqrt(intensity / RENDER.DEEP_LIGHT_CUTOFF_E);
    return clamp(r, RENDER.DEEP_LIGHT_RANGE_MIN, ceiling);
  }

  /**
   * Promote the ranked emissive scatter to real punctual lights.
   *
   * Registered with renderer.addLightSubmitter() in init(), so it runs at the
   * top of Renderer.render() - after the vessel, the player, the habitat and the
   * creatures, which is the same argument main.js makes for ordering those four:
   * if the light budget or a cluster is tight, the props lose and the lamps the
   * player steers by do not.
   *
   * THE INTENSITY IS THE MESH'S OWN RADIANT INTENSITY AND NOTHING ELSE, exactly
   * as creatures.js does it: `typeEmit.flux` already integrates the authored
   * emission over the real generated mesh, gates it by material slot and divides
   * by 4 for Cauchy's mean projected area, and the two per-instance gains
   * (scale^2 for the area, `emitScale` for the per-instance hash) are the same
   * ones pass/scatter.wgsl and glow.js apply. The prop, its aureole and its
   * light therefore cannot disagree about how bright the prop is. There is no
   * brightness fudge and RENDER.DEEP_LIGHT_GAIN is 1.0: the goal is that objects
   * LIGHT THEIR SURROUNDINGS, which raises dark mass by creating lit and unlit
   * regions - not that the deep gets brighter, which the AgX shoulder answers by
   * desaturating (measured, x3 emission moved a coral's delivered HSV saturation
   * 0.128 -> 0.093, x8 -> 0.046).
   *
   * @param {import('../renderer.js').Renderer} r
   */
  function submitLights(r) {
    stats.beacons = 0;
    stats.fill = 0;
    stats.lightCandidates = 0;
    stats.lightGate = 0;
    lightTypeCount[0].fill(0); lightTypeCount[1].fill(0);
    lightTypeIntensity[0].fill(0); lightTypeIntensity[1].fill(0);
    lightTypeIrrFrustum[0].fill(0); lightTypeIrrFrustum[1].fill(0);
    lightTypeIrrAll[0].fill(0); lightTypeIrrAll[1].fill(0);
    lightTypeDist[0].fill(0); lightTypeDist[1].fill(0);
    lightTypeSeen[0].fill(0); lightTypeSeen[1].fill(0);
    lightIds.clear();

    const camera = r.camera;
    if (!camera || !r.addLight || chunks.size === 0) { incumbents.clear(); return; }
    const beaconWant = Math.max(0, RENDER.DEEP_BEACON_COUNT | 0);
    const fillWant = Math.max(0, RENDER.DEEP_FILL_COUNT | 0);
    if (beaconWant === 0 && fillWant === 0) { incumbents.clear(); return; }

    const t0 = performance.now();
    const camX = camera.position[0], camY = camera.position[1], camZ = camera.position[2];
    // The RAMP, not a switch, and on the camera's depth: above it there is
    // daylight, caustics and a cast shadow doing this job better, and every
    // shallow emitter fluoresces and is excluded anyway. A hard switch would put
    // forty lights on and off once per bob for a diver hovering on the contour,
    // which is the same failure glow.js's own gate documents.
    const gate = smoothstep(RENDER.DEEP_LIGHT_MIN_DEPTH,
      RENDER.DEEP_LIGHT_MIN_DEPTH + RENDER.DEEP_LIGHT_FADE_M, WORLD.SEA_LEVEL - camY);
    stats.lightGate = gate;
    if (gate <= 0) { incumbents.clear(); return; }

    const beaconSearch = RENDER.DEEP_BEACON_SEARCH;
    const fillSearch = RENDER.DEEP_FILL_SEARCH;
    const hyst = 1 + RENDER.DEEP_LIGHT_HYSTERESIS;
    // A chunk is 128 m square, so anything whose XZ box is outside the search
    // radius cannot hold a candidate. This is what keeps the fill walk to the
    // one or two chunks under the camera instead of all 23 resident ones.
    const chunkReach = CHUNK_SIZE * 1.4143;
    const beaconChunk2 = (beaconSearch + chunkReach) * (beaconSearch + chunkReach);
    const fillChunk2 = (fillSearch + chunkReach) * (fillSearch + chunkReach);
    const beacon2 = beaconSearch * beaconSearch;
    const fill2 = fillSearch * fillSearch;

    resetSelection(beaconSel);
    resetSelection(fillSel);
    let candidates = 0;
    // The same gain emitSelection() applies, hoisted so a candidate's culling
    // radius - and therefore its frustum test - is the radius the light will
    // actually be submitted with. Testing an ungated radius would admit a
    // candidate at the top of the depth ramp whose real sphere misses the
    // frustum, and reject none, which is the safe direction but not the honest
    // one.
    const gain = RENDER.DEEP_LIGHT_GAIN * gate;
    // OVERSELECT: the cap phase can only REPLACE a light if there is a
    // runner-up to replace it with. Bounded by MAX_LIGHTS, which is the
    // selections' allocated capacity.
    const os = Math.max(1, lightTuning.overselect | 0);
    const beaconPool = Math.min(RENDER.MAX_LIGHTS, beaconWant * os);
    const fillPool = Math.min(RENDER.MAX_LIGHTS, fillWant * os);
    const fillTypePool = RENDER.DEEP_FILL_PER_TYPE * os;
    const frustumOnly = lightTuning.frustumOnly === true;

    const list = emissiveChunksRefill();
    for (let c = 0; c < list.length; c++) {
      const ch = list[c];
      const dcx = ch.originX + CHUNK_SIZE * 0.5 - camX;
      const dcz = ch.originZ + CHUNK_SIZE * 0.5 - camZ;
      const chunkD2 = dcx * dcx + dcz * dcz;
      if (chunkD2 > beaconChunk2) continue;

      // ---- beacons: seven eligible types out of forty-two ------------------
      if (beaconWant > 0) {
        for (let bi = 0; bi < lightMeta.beaconTypes.length; bi++) {
          const t = lightMeta.beaconTypes[bi];
          const n = ch.typeCount[t];
          if (n === 0) continue;
          const first = ch.typeFirst[t];
          const peak = lightMeta.peak[t];
          const excl = lightMeta.exclusivity[t];
          for (let j = first; j < first + n; j++) {
            const dx = ch.pos[j * 3] - camX;
            const dy = ch.pos[j * 3 + 1] - camY;
            const dz = ch.pos[j * 3 + 2] - camZ;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > beacon2) continue;
            candidates++;
            const s = ch.scale[j];
            const intensity = peak * s * s * ch.emitScale[j];
            if (!(intensity > 0)) continue;
            if (frustumOnly && !candidateVisible(camera, ch, j, t,
              rangeFor(intensity * gain, RENDER.DEEP_BEACON_RANGE_MAX))) continue;
            const id = instanceId(ch, j);
            const invD2 = 1 / Math.max(d2, 1);
            let score = intensity * excl * invD2;
            if (incumbents.has(id)) score *= hyst;
            considerSlot(beaconSel, beaconPool, beaconPool, id, score, ch, j, t,
              intensity * gain * invD2, d2);
          }
        }
      }

      // ---- fill: every eligible emitter in the near field -------------------
      if (fillWant > 0 && chunkD2 <= fillChunk2) {
        for (let j = 0; j < ch.count; j++) {
          const t = ch.type[j];
          if (lightMeta.eligible[t] === 0) continue;
          const dx = ch.pos[j * 3] - camX;
          const dy = ch.pos[j * 3 + 1] - camY;
          const dz = ch.pos[j * 3 + 2] - camZ;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > fill2) continue;
          candidates++;
          const s = ch.scale[j];
          const intensity = lightMeta.peak[t] * s * s * ch.emitScale[j];
          if (!(intensity > 0)) continue;
          if (frustumOnly && !candidateVisible(camera, ch, j, t,
            rangeFor(intensity * gain, RENDER.DEEP_FILL_RANGE_MAX))) continue;
          const id = instanceId(ch, j);
          const invD2 = 1 / Math.max(d2, 1);
          let score = intensity * lightMeta.exclusivity[t] * invD2;
          if (incumbents.has(id)) score *= hyst;
          considerSlot(fillSel, fillPool, fillTypePool, id, score, ch, j, t,
            intensity * gain * invD2, d2);
        }
      }
    }
    stats.lightCandidates = candidates;

    // RANK, THEN CAP, THEN EMIT. sortSelection orders each class by score;
    // planEmission picks who actually gets a slot under the delivered-irradiance
    // cap; emitSelection walks the plan. Beacons before fill inside both, for
    // the reason emitSelection states.
    sortSelection(beaconSel);
    sortSelection(fillSel);
    planEmission(beaconSel, beaconWant, fillSel, fillWant);
    stats.beacons = emitSelection(r, beaconSel, gate, RENDER.DEEP_BEACON_RANGE_MAX, 1);
    stats.fill = emitSelection(r, fillSel, gate, RENDER.DEEP_FILL_RANGE_MAX, 0);

    incumbents.clear();
    for (const id of lightIds) incumbents.add(id);
    stats.lightMs = performance.now() - t0;
  }

  /**
   * Hand one class's PLANNED selection to the renderer. Returns how many landed.
   *
   * It walks `sel.plan` rather than `sel.order`: the score decides the ranking,
   * planEmission() decides who survives the delivered-irradiance cap, and this
   * only submits. The plan is already in score order and already deduplicated
   * across the two classes, so the `lightIds` test below is a belt-and-braces
   * guard on a rule the plan enforces rather than the rule itself.
   */
  function emitSelection(r, sel, gate, ceiling, volumetric) {
    const camera = r.camera;
    const gain = RENDER.DEEP_LIGHT_GAIN * gate;
    let added = 0;
    for (let k = 0; k < sel.planN; k++) {
      const i = sel.plan[k];
      // THE TWO CLASSES OVERLAP AND THE NEAR FIELD IS WHERE THEY OVERLAP MOST.
      // A signature emitter four metres from the eye wins its beacon slot AND
      // outscores every ordinary emitter for a fill slot, so without this the
      // brightest prop in frame is submitted TWICE at the same position: two
      // cluster slots, two froxel iterations and double the irradiance on the
      // rock beneath it. Measured before the test existed, at the shipped
      // counts: 3 of 13 spireCrown lights at Rock Spires and 4 of 14
      // canyonBanner lights at Canyon Wall were the same instances twice.
      // Beacons are emitted first, so `lightIds` is exactly the beacon set by
      // the time the fill class runs.
      if (lightIds.has(sel.id[i])) continue;
      const ch = sel.chunk[i];
      const j = sel.index[i];
      const t = sel.type[i];
      const s = ch.scale[j];
      const intensity = lightMeta.peak[t] * s * s * ch.emitScale[j] * gain;
      if (!(intensity > 0)) continue;

      // The emissive CENTROID, not the instance origin. `up` is the instance's
      // scaled local Y axis, so this follows `align` and `tilt` - a wall-hanging
      // spine's light comes off the wall, not out of the rock behind it.
      const cy = typeEmit.centroid[t * 3 + 1];
      _lightPos[0] = ch.pos[j * 3] + ch.up[j * 3] * cy;
      _lightPos[1] = ch.pos[j * 3 + 1] + ch.up[j * 3 + 1] * cy;
      _lightPos[2] = ch.pos[j * 3 + 2] + ch.up[j * 3 + 2] * cy;
      _lightColour[0] = lightMeta.colour[t * 3];
      _lightColour[1] = lightMeta.colour[t * 3 + 1];
      _lightColour[2] = lightMeta.colour[t * 3 + 2];

      const range = rangeFor(intensity, ceiling);
      const slot = r.addLight({
        position: _lightPos,
        color: _lightColour,
        intensity,
        range,
        type: 'point',
        // The whole reason there are two classes. A fill light is contact light
        // on geometry; letting 40 of them into the froxel loop would multiply
        // the heaviest inner loop in the frame by five for a shaft nobody can
        // see at 6-14 m.
        volumetric,
      });
      if (slot < 0) break;   // the 256-light budget said no; stop asking
      added++;
      lightIds.add(sel.id[i]);
      // `volumetric` doubles as the class index: 1 is the beacon class, which is
      // exactly the class that enters the froxel, and 0 is fill.
      lightTypeCount[volumetric][t]++;
      lightTypeIntensity[volumetric][t] += intensity;
      // THE REPORT'S QUANTITY, MEASURED ON THE LIGHT THAT WAS ACTUALLY
      // SUBMITTED. `sel.irr` is the same number computed at selection time; it
      // is recomputed here from the emitted intensity so that a light the
      // 256-light budget refused, or one the plan dropped, cannot be credited
      // to a type, and so that the metric cannot drift from the selection's
      // arithmetic by being maintained twice.
      const d2 = sel.d2[i];
      const e = intensity / Math.max(d2, 1);
      lightTypeIrrAll[volumetric][t] += e;
      lightTypeDist[volumetric][t] += Math.sqrt(d2);
      // Exact, not conservative-by-luck: punctualAttenuation is zero at
      // `range`, so a sphere of that radius missing the frustum is a light that
      // cannot reach a visible surface.
      if (camera && camera.isSphereVisible(_lightPos, range)) {
        lightTypeIrrFrustum[volumetric][t] += e;
        lightTypeSeen[volumetric][t]++;
      }
    }
    return added;
  }

  /**
   * The resident emissive chunks, refilled and sorted. Shared by
   * `emissiveInstances()` and `submitLights()` so there is one walk of the Map
   * and one sort per call rather than two implementations that can disagree
   * about the order.
   */
  function emissiveChunksRefill() {
    emissiveChunks.length = 0;
    for (const chunk of chunks.values()) {
      if (chunk.emit) emissiveChunks.push(chunk.emit);
    }
    // SORTED, because a Map iterates in INSERTION order and chunks are
    // inserted as their generation jobs land - i.e. in the order the player
    // walked. The glow pass's MAX_SPRITES budget resolves ties by arrival, so
    // without this two identical camera states reached from the north and from
    // the south draw a different subset of the same seabed. submitLights()
    // needs it for the same reason, one class down: its selection is bounded
    // and ties inside it would otherwise depend on the approach direction.
    emissiveChunks.sort((a, b) => (a.originZ - b.originZ) || (a.originX - b.originX));
    return emissiveChunks;
  }

  // -------------------------------------------------------------------------
  // Pass
  // -------------------------------------------------------------------------

  return {
    name: 'scatter',
    type: 'render',
    writes: ['sceneColor', 'sceneDepth', 'velocity', 'aoGate'],
    // Shadow atlas, caustics and the sky LUTs live in bind group 0, which is
    // bound for the whole frame; declaring them here would make the graph
    // validator demand a producer even on tiers that switch them off.
    reads: [],
    stats,
    /** Per-type baked emission for render/passes/glow.js. See its docstring. */
    typeEmit,

    /**
     * Resident chunks holding emissive instances, for the glow pass.
     *
     * Returns the SAME array every frame, refilled - the glow pass walks it once
     * per frame and must not make the seabed allocate. Each entry is
     * `{count, pos, scale, emitScale, type}` in ABSOLUTE world coordinates.
     */
    emissiveInstances: emissiveChunksRefill,

    submitLights,

    /**
     * The emissive instances holding a punctual light this frame, as the
     * `chunk.key * 65536 + index` ids submitLights() ranks by.
     *
     * The creature pass publishes the same thing (`lightSlotSet`) and glow.js
     * consumes it to pass `haloW = 0`, so the aureole around a promoted emitter
     * is drawn once - by the froxel volume - instead of twice. THE SCATTER HALF
     * OF THAT CONTRACT IS NOT WIRED UP: glow.js's scatter loop still passes
     * `haloW = 1` for every instance, so a BEACON currently gets both the
     * froxel's in-scatter and the sprite's aureole. It is one line at
     * glow.js:648 - `const haloW = lightSet && lightSet.has(ch.key * 65536 + j)
     * ? 0 : 1` - and that file is owned elsewhere in this stage. Fill lights are
     * `volumetric: 0` and inject nothing, so they must keep their aureole and
     * must NOT be in this set's consumer; the set is beacons and fill together,
     * so the consumer has to intersect it with the beacon class or read
     * `stats.beacons`. Until then `stats.haloSuppressed` stays 0 for scatter.
     */
    lightSlotSet() { return lightIds; },

    /**
     * The knobs the delivered-irradiance selection adds. Live-mutable; see
     * `lightTuning`'s own docstring for the OFF values that reproduce the
     * previous selection exactly.
     */
    lightTuning,

    /**
     * Per-type accounting of what actually became a light, for the acceptance
     * gate "no deep biome's key light is a form on its own Avoid list".
     *
     * RANKED BY DELIVERED IN-FRUSTUM IRRADIANCE, AND THE PREVIOUS RANKING WAS
     * THE WRONG QUANTITY. It summed SUBMITTED RADIANT INTENSITY over a 160 m
     * sphere and called the share of that the share of delivered illumination
     * "up to the per-light distance". That parenthetical is the whole error:
     * beacons are searched to 160 m and fill to 35 m, so the distance term is
     * not a small correction, it is two to three orders of magnitude, and it
     * runs the ONE direction that matters here - it hides the shared near-field
     * kit behind the far signature. Measured on the shipped Stage 2 build the
     * two rankings disagree completely: Twilight Terraces read 0.658 of its
     * SUBMITTED intensity going to a signature form, while its DELIVERED
     * in-frustum irradiance was glowPod 0.701 against terraceVeil 0.026 - and
     * "glowcup carpet" is the first entry in that biome's own Avoid column.
     *
     * `share` is therefore delivered in-frustum irradiance over the frame's
     * total. `shareAll` drops the frustum restriction and `submittedShare` is
     * the old quantity, both kept so the correction is auditable rather than
     * asserted. Read them together with `beacons` / `fill`: only the beacon
     * class enters the froxel volume.
     */
    lightReport() {
      const types = [];
      let total = 0;          // delivered, in frustum
      let totalAll = 0;       // delivered, frustum or not
      let totalI = 0;         // submitted radiant intensity (the old quantity)
      let beaconE = 0;
      for (let c = 0; c < 2; c++) {
        for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
          total += lightTypeIrrFrustum[c][t];
          totalAll += lightTypeIrrAll[c][t];
          totalI += lightTypeIntensity[c][t];
        }
      }
      for (let t = 0; t < SCATTER_TYPE_COUNT; t++) beaconE += lightTypeIrrFrustum[1][t];
      for (let c = 0; c < 2; c++) {
        for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
          const n = lightTypeCount[c][t];
          if (n === 0) continue;
          types.push({
            key: SCATTER_TYPES[t].key,
            signature: SCATTER_TYPES[t].signatureBiome ?? null,
            beaconEligible: lightMeta.beacon[t] === 1,
            class: c === 1 ? 'beacon' : 'fill',
            count: n,
            /** Of `count`, how many had their influence sphere in the frustum. */
            inFrustum: lightTypeSeen[c][t],
            meanDist: lightTypeDist[c][t] / n,
            irradiance: lightTypeIrrFrustum[c][t],
            share: total > 0 ? lightTypeIrrFrustum[c][t] / total : 0,
            shareAll: totalAll > 0 ? lightTypeIrrAll[c][t] / totalAll : 0,
            intensity: lightTypeIntensity[c][t],
            submittedShare: totalI > 0 ? lightTypeIntensity[c][t] / totalI : 0,
          });
        }
      }
      types.sort((a, b) => b.irradiance - a.irradiance || b.intensity - a.intensity);
      // The share going to a form that is the biome's own authored signature.
      // Reported here rather than recomputed by every caller, because the
      // caller that recomputes it is the caller that gets the quantity wrong.
      let signatureE = 0;
      for (const ty of types) if (ty.signature != null) signatureE += ty.irradiance;
      return {
        beacons: stats.beacons, fill: stats.fill,
        candidates: stats.lightCandidates, gate: stats.lightGate,
        ms: stats.lightMs,
        /** Delivered in-frustum irradiance at the eye, W/m^2. THE quantity. */
        totalIrradiance: total,
        totalIrradianceAll: totalAll,
        totalIntensity: totalI,
        signatureShare: total > 0 ? signatureE / total : 0,
        beaconShare: total > 0 ? beaconE / total : 0,
        tuning: {
          frustumOnly: lightTuning.frustumOnly,
          typeIrradianceCap: lightTuning.typeIrradianceCap,
          overselect: lightTuning.overselect,
        },
        types,
      };
    },

    enabled() {
      return pipelineCull !== null && chunks.size > 0;
    },

    init(ctx) {
      if (meshLayout.arrayStride !== SCATTER_VERTEX_STRIDE) {
        throw new Error(
          `[scatter] mesh vertex layout is ${meshLayout.arrayStride} bytes but ` +
          `SCATTER_VERTEX_STRIDE is ${SCATTER_VERTEX_STRIDE}. They have drifted apart.`);
      }
      if (instanceLayout.arrayStride !== SCATTER_STRIDE) {
        throw new Error(
          `[scatter] instance layout is ${instanceLayout.arrayStride} bytes but ` +
          `world/scatter.js emits ${SCATTER_STRIDE}. They have drifted apart.`);
      }

      // Every draw gets its own slice of ONE ring allocation, spaced at the
      // device's dynamic-offset alignment. WebGPU only guarantees that
      // alignment is at least 64 B, so a uniform that outgrew it would have
      // consecutive draws reading each other's tails - a silent, per-device
      // corruption that would only show on the hardware with the smaller value.
      if (SCATTER_UNIFORM_BYTES > ctx.uniforms.alignment) {
        throw new Error(
          `[scatter] ScatterUniform is ${SCATTER_UNIFORM_BYTES} bytes but the ` +
          `dynamic-offset alignment is only ${ctx.uniforms.alignment}; draws would overlap.`);
      }

      device = ctx.device;
      buildMeshLibrary();
      buildLightMeta();
      // A render pass cannot submit lights from execute(): the light buffer has
      // already been uploaded and the cluster cull already encoded by then. See
      // Renderer.addLightSubmitter().
      ctx.renderer?.addLightSubmitter(submitLights);

      const module = ctx.shaders.module('pass/scatter.wgsl', {}, 'scatter');

      drawLayout = ctx.pipelines.bindGroupLayout('scatter.draw.bgl', [{
        binding: 0,
        visibility: STAGE.VF,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: SCATTER_UNIFORM_BYTES },
      }]);

      const base = {
        label: 'scatter',
        layout: ctx.pipelines.pipelineLayout('scatter.pl', [renderer.frameLayout, drawLayout]),
        vertex: { module, entryPoint: 'vs_scatter', buffers: [meshLayout, instanceLayout] },
        fragment: {
          module,
          entryPoint: 'fs_scatter',
          targets: [
            { format: FORMATS.hdr },
            { format: FORMATS.velocity },
            // The SSAO gate - see FragOut.gate in pass/scatter.wgsl.
            { format: FORMATS.r8 },
          ],
        },
        depthStencil: DepthState.opaque(FORMATS.depth),
      };
      // TWO PIPELINES, ONE SHADER. A rock is a closed solid and its back faces
      // are pure waste - at a 10 m boulder that is a second full-screen-ish fill
      // for nothing. A kelp blade is a single-sided sheet: cull it and half of
      // every plant in the ocean disappears from one side. The fragment shader
      // flips the normal on a back face, so the only difference between the two
      // is the cull mode, and the type table's `twoSided` picks one.
      pipelineCull = ctx.pipelines.renderPipeline({ ...base, primitive: Primitive.triangles });
      pipelineNoCull = ctx.pipelines.renderPipeline({
        ...base, label: 'scatter.twoSided', primitive: Primitive.trianglesNoCull,
      });

      // Depth-only casters. No fragment stage - the LOD fade here is a geometric
      // shrink, not a discard, so there is nothing to alpha-test. No hardware
      // depth bias: shadow.wgsl owns the whole bias budget on the receiver side.
      const shadowBase = {
        label: 'scatter.shadow',
        layout: ctx.pipelines.pipelineLayout('scatter.shadow.pl',
          [renderer.shadowCasterLayout, drawLayout]),
        vertex: {
          module, entryPoint: 'vs_scatter_shadow',
          buffers: [shadowMeshLayout, shadowInstanceLayout],
        },
        depthStencil: DepthState.shadow(FORMATS.shadow, 0, 0, 0),
      };
      shadowPipelineCull = ctx.pipelines.renderPipeline({
        ...shadowBase, primitive: Primitive.triangles,
      });
      shadowPipelineNoCull = ctx.pipelines.renderPipeline({
        ...shadowBase, label: 'scatter.shadow.twoSided',
        primitive: Primitive.trianglesNoCull,
      });
    },

    /** Per-cascade caster stats, for probe.mjs. */
    shadowStats,

    /**
     * Build this frame's per-cascade caster lists.
     *
     * Scatter is only resident to SCATTER_MAX_VIEW_DISTANCE (340 m), so it can
     * only ever reach cascades 0-2 and the near edge of 3; the cascade test does
     * that for free rather than by a special case.
     */
    beginShadowFrame(ctx, shadows) {
      const camera = ctx.camera;
      const px = camera.position[0], py = camera.position[1], pz = camera.position[2];
      for (let i = 0; i < shadows.count; i++) {
        if (shadowChunks[i] === undefined) shadowChunks[i] = [];
        shadowChunks[i].length = 0;
        shadowMinSize[i] = shadows.minCasterSize(i);
        shadowStats.chunks[i] = 0;
        shadowStats.draws[i] = 0;
        shadowStats.instances[i] = 0;
      }
      for (const chunk of chunks.values()) {
        if (chunk.count === 0) continue;
        const b = chunk.aabb;
        const p = shadows.projectBox(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ);
        let wanted = false;
        for (let i = 0; i < shadows.count; i++) {
          if (!shadows.boxCasts(i, p)) continue;
          shadowChunks[i].push(chunk);
          shadowStats.chunks[i]++;
          wanted = true;
        }
        if (!wanted) continue;
        // The SAME distance the colour pass measures - to the box, not the
        // centre - so the caster picks the same LOD mesh and the same fade the
        // camera pass draws. A shadow cast by a silhouette other than the one on
        // screen is worse than no shadow.
        const cxm = clamp(px, b.minX, b.maxX) - px;
        const cym = clamp(py, b.minY, b.maxY) - py;
        const czm = clamp(pz, b.minZ, b.maxZ) - pz;
        chunk.shadowDist = Math.sqrt(cxm * cxm + cym * cym + czm * czm);
      }
    },

    /**
     * Draw this pass's casters into cascade `cascade`.
     * @returns {number} draws issued
     */
    castShadows(ctx, pass, cascade, shadows) {
      if (!shadowPipelineCull) return 0;
      const list = shadowChunks[cascade];
      if (!list || list.length === 0) return 0;

      if (drawBindGroup === null || boundRing !== ctx.uniforms.buffer) {
        boundRing = ctx.uniforms.buffer;
        drawBindGroup = ctx.device.createBindGroup({
          label: 'scatter.draw.bg',
          layout: drawLayout,
          entries: [{
            binding: 0,
            resource: { buffer: boundRing, offset: 0, size: SCATTER_UNIFORM_BYTES },
          }],
        });
      }

      // Count first: the ring slot count must be exact, or a loose bound
      // reserves tens of kilobytes for draws that do not happen and the passes
      // allocating after this one wrap.
      const minSize = shadowMinSize[cascade];
      let planned = 0;
      for (let ci = 0; ci < list.length; ci++) {
        const chunk = list[ci];
        for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
          if (shadowTypeSkipped(chunk, t, chunk.shadowDist, minSize, cascade)) continue;
          planned++;
        }
      }
      if (planned === 0) return 0;

      pass.setBindGroup(GROUP.FRAME, renderer.shadowCasterGroup);
      pass.setVertexBuffer(0, meshVertexBuffer);
      pass.setIndexBuffer(meshIndexBuffer, 'uint32');

      const stride = ctx.uniforms.alignment;
      const block = ctx.uniforms.alloc(stride * planned);
      const f = block.f32;
      const strideF = stride >> 2;
      const origin = ctx.camera.worldOrigin;

      let draws = 0;
      let instances = 0;
      let currentPipeline = null;
      let boundChunk = null;
      for (let pass2 = 0; pass2 < 2; pass2++) {
        const wantTwoSided = pass2 === 1;
        for (let ci = 0; ci < list.length; ci++) {
          const chunk = list[ci];
          const dist = chunk.shadowDist;
          for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
            const type = SCATTER_TYPES[t];
            if (type.twoSided !== wantTwoSided) continue;
            if (shadowTypeSkipped(chunk, t, dist, minSize, cascade)) continue;
            const chainEntry = shadowChainEntry(t, dist, cascade);

            if (currentPipeline !== pass2) {
              pass.setPipeline(wantTwoSided ? shadowPipelineNoCull : shadowPipelineCull);
              currentPipeline = pass2;
              boundChunk = null;
            }
            if (boundChunk !== chunk) {
              pass.setVertexBuffer(1, chunk.buffer);
              boundChunk = chunk;
            }

            // vs_scatter_shadow reads chunkOrigin, params.z (sway) and shape.xy
            // (the fade window). The rest of ScatterUniform is fragment-side, but
            // the binding declares minBindingSize so the whole slot is reserved.
            const o = draws * strideF;
            f[o + 0] = chunk.originX - origin[0];
            f[o + 1] = -origin[1];
            f[o + 2] = chunk.originZ - origin[2];
            f[o + 3] = cascade;                // ScatterUniform.chunkOrigin.w
            f[o + 10] = type.sways ? type.swayStrength : 0;
            f[o + 12] = type.fadeStart;
            f[o + 13] = type.viewDistance;

            _offsetScratch[0] = block.offset + draws * stride;
            pass.setBindGroup(GROUP.PASS, drawBindGroup, _offsetScratch);
            const count = chunk.countsByType[t];
            pass.drawIndexed(chainEntry.indexCount, count, chainEntry.firstIndex,
              chainEntry.baseVertex, chunk.firstByType[t]);
            draws++;
            instances += count;
          }
        }
      }
      shadowStats.draws[cascade] = draws;
      shadowStats.instances[cascade] = instances;
      return draws;
    },

    /**
     * Fill the whole residency radius before the first frame. Yields to the
     * event loop between chunks so the boot progress bar keeps painting.
     * @param {ArrayLike<number>} position absolute world position to centre on
     * @param {(t: number) => void} [onProgress] 0..1
     */
    async prime(position, onProgress) {
      if (!device) return;
      rescan(position[0], position[2]);
      const total = queue.length;
      if (total === 0) { onProgress?.(1); refreshStats(); return; }
      let done = 0;
      while (queue.length > 0) {
        // Four chunks a slice: about 16 ms of generation, short enough that the
        // boot screen still paints between batches. Nothing is being rendered
        // yet, so responsiveness is the constraint, not frame time.
        for (let i = 0; i < 4 && queue.length > 0; i++) {
          const job = queue.shift();
          queued.delete(job.k);
          generate(job);
          done++;
        }
        onProgress?.(Math.min(1, done / total));
        await new Promise((r) => setTimeout(r, 0));
      }
      onProgress?.(1);
      refreshStats();
    },

    /**
     * Per-frame streaming. Recomputes the resident set only after the camera has
     * travelled RESCAN_DISTANCE, and never generates while the TERRAIN still has
     * work OUTSTANDING - a plant cannot be planted on ground that has not been
     * baked, and stacking a 4 ms scatter bake on top of a terrain upload is how a
     * one-frame hitch becomes a visible stall. See terrainOutstanding() for why
     * that is three counters rather than the queue depth.
     * @param {ArrayLike<number>} position absolute camera position
     */
    update(position) {
      if (!device) return;
      const x = position[0], z = position[2];
      const dx = x - lastScanX, dz = z - lastScanZ;
      if (dx * dx + dz * dz > RESCAN_DISTANCE * RESCAN_DISTANCE) rescan(x, z);
      stats.terrainOutstanding = terrainOutstanding();
      if (stats.terrainOutstanding > 0) return;
      drainQueue(GENERATE_MS_BUDGET);
    },

    /**
     * Every resident chunk's LOD, instance count and distance to the camera.
     *
     * The refinement path is invisible from the outside - a chunk stuck at LOD 1
     * looks exactly like a chunk that is genuinely empty - so there has to be a
     * way to read the LOD of the ground the player is standing on without a
     * screenshot. `node tools/probe.mjs "subwave.scatterPass.debugChunks()"`.
     * @param {ArrayLike<number>} [position] absolute point to measure from;
     *   defaults to the last rescan centre
     * @returns {{lodHistogram: number[], chunks: Array<object>}}
     */
    debugChunks(position) {
      const cx = position ? position[0] : lastScanX;
      const cz = position ? position[2] : lastScanZ;
      const half = CHUNK_SIZE * 0.5;
      const lodHistogram = [];
      const out = [];
      for (const chunk of chunks.values()) {
        const dx = chunk.originX + half - cx;
        const dz = chunk.originZ + half - cz;
        lodHistogram[chunk.lod] = (lodHistogram[chunk.lod] ?? 0) + 1;
        out.push({
          cx: chunk.cx, cz: chunk.cz, lod: chunk.lod, count: chunk.count,
          dist: Math.round(Math.sqrt(dx * dx + dz * dz)),
        });
      }
      for (let i = 0; i < lodHistogram.length; i++) lodHistogram[i] ??= 0;
      out.sort((a, b) => a.dist - b.dist);
      return { lodHistogram, chunks: out };
    },

    execute(ctx, encoder) {
      if (!pipelineCull || chunks.size === 0) return;
      const camera = ctx.camera;

      // ---- CPU cull, per chunk, in ABSOLUTE coordinates ------------------
      visible.length = 0;
      const px = camera.position[0], py = camera.position[1], pz = camera.position[2];
      let visInstances = 0;
      for (const chunk of chunks.values()) {
        if (chunk.count === 0) continue;
        const b = chunk.aabb;
        if (!camera.isBoxVisible(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ)) continue;
        // DISTANCE TO THE BOX, NOT TO THE CENTRE. Measuring to the centre reads
        // like a harmless simplification and deletes plants: a chunk is 128 m
        // across, so its centre can be 90 m away while its near corner is under
        // the player's mask, and every type whose view distance is shorter than
        // that - seagrass at 74 m, cobble at 64 m, gravel at 46 m - would be
        // culled out of the chunk the player is looking straight into.
        //
        // The vertical term is not padding either: a vessel 300 m above the reef
        // is inside every chunk's XZ footprint and must still draw nothing,
        // because no type reaches that far.
        const cxm = clamp(px, b.minX, b.maxX) - px;
        const cym = clamp(py, b.minY, b.maxY) - py;
        const czm = clamp(pz, b.minZ, b.maxZ) - pz;
        chunk.sortKey = cxm * cxm + czm * czm + cym * cym;
        visible.push(chunk);
        visInstances += chunk.count;
      }
      if (visible.length === 0) {
        stats.visibleChunks = 0;
        stats.visibleInstances = 0;
        stats.draws = 0;
        stats.triangles = 0;
        return;
      }
      // Front to back, so the depth buffer rejects the far plants cheaply.
      visible.sort((a, b) => a.sortKey - b.sortKey);
      stats.visibleChunks = visible.length;
      stats.visibleInstances = visInstances;

      if (drawBindGroup === null || boundRing !== ctx.uniforms.buffer) {
        boundRing = ctx.uniforms.buffer;
        drawBindGroup = ctx.device.createBindGroup({
          label: 'scatter.draw.bg',
          layout: drawLayout,
          entries: [{
            binding: 0,
            resource: { buffer: boundRing, offset: 0, size: SCATTER_UNIFORM_BYTES },
          }],
        });
      }

      const pass = encoder.beginRenderPass(profiler.gpuPass({
        label: 'scatter',
        colorAttachments: [
          colorAttachment(ctx.targets.view('sceneColor'), { loadOp: 'load' }),
          colorAttachment(ctx.targets.view('velocity'), { loadOp: 'load' }),
          colorAttachment(ctx.targets.view('aoGate'), { loadOp: 'load' }),
        ],
        depthStencilAttachment: depthAttachment(ctx.targets.view('sceneDepth'), { clear: false }),
      }, 'scatter'));

      pass.setBindGroup(GROUP.FRAME, ctx.frameBindGroup);
      pass.setVertexBuffer(0, meshVertexBuffer);
      pass.setIndexBuffer(meshIndexBuffer, 'uint32');

      // ONE ring allocation for every draw this pass will make, sub-divided by
      // hand at the dynamic-offset alignment. UniformRing.alloc() mints two
      // typed-array views per call, which is nothing for three draws and is a
      // few hundred short-lived objects a frame for a few hundred.
      //
      // The count is EXACT, not `chunks * types`. The ring is 1 MB and each slot
      // is 256 B, so the loose bound would reserve 160 KB of it for draws that
      // mostly do not happen - and the terrain pass, which allocates after this
      // one, is the thing that would wrap and flicker.
      let plannedDraws = 0;
      for (let ci = 0; ci < visible.length; ci++) {
        const chunk = visible[ci];
        const d = Math.sqrt(chunk.sortKey);
        for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
          if (chunk.countsByType[t] === 0) continue;
          if (d > SCATTER_TYPES[t].viewDistance) continue;
          if (lodChains[t].length === 0) continue;
          plannedDraws++;
        }
      }
      if (plannedDraws === 0) {
        pass.end();
        stats.draws = 0;
        stats.triangles = 0;
        return;
      }
      const stride = ctx.uniforms.alignment;
      const block = ctx.uniforms.alloc(stride * plannedDraws);
      const f = block.f32;
      const strideF = stride >> 2;
      const origin = camera.worldOrigin;

      let draws = 0;
      let triangles = 0;
      let currentPipeline = null;

      // Pipeline-outer so the two cull modes are two state changes for the whole
      // pass rather than two per chunk; chunk-inner so an instance buffer is
      // bound once for every type it feeds.
      for (let pass2 = 0; pass2 < 2; pass2++) {
        const wantTwoSided = pass2 === 1;
        let boundChunk = null;
        for (let ci = 0; ci < visible.length; ci++) {
          const chunk = visible[ci];
          const dist = Math.sqrt(chunk.sortKey);
          for (let t = 0; t < SCATTER_TYPE_COUNT; t++) {
            const count = chunk.countsByType[t];
            if (count === 0) continue;
            const type = SCATTER_TYPES[t];
            if (type.twoSided !== wantTwoSided) continue;
            if (dist > type.viewDistance) continue;
            const chainEntry = pickLod(lodChains[t], dist);
            if (chainEntry === null) continue;

            if (currentPipeline !== pass2) {
              pass.setPipeline(wantTwoSided ? pipelineNoCull : pipelineCull);
              currentPipeline = pass2;
              boundChunk = null;
            }
            if (boundChunk !== chunk) {
              pass.setVertexBuffer(1, chunk.buffer);
              boundChunk = chunk;
            }

            const o = draws * strideF;
            f[o + 0] = chunk.originX - origin[0];
            f[o + 1] = -origin[1];
            f[o + 2] = chunk.originZ - origin[2];
            f[o + 3] = 0;
            f[o + 4] = type.emissiveColor[0] * type.emissive;
            f[o + 5] = type.emissiveColor[1] * type.emissive;
            f[o + 6] = type.emissiveColor[2] * type.emissive;
            // Respiration rate. Bioluminescence is metabolic, so it breathes;
            // a mineral vein glow does not, and gets 0.
            f[o + 7] = type.emissive > 0 && type.ore === null ? 0.55 : 0.0;
            // Roughness bias: the material slot owns the BASE roughness; a
            // row may bias it (emerald rebuild: wet kelp membranes at 0.62
            // slot roughness specularly mirrored the bright canopy and the
            // whole forest read pale mint - three albedo cuts never showed
            // on screen because the pixel was mostly reflection).
            f[o + 8] = type.roughnessBias ?? 0;
            f[o + 9] = type.translucency;
            f[o + 10] = type.sways ? type.swayStrength : 0;
            f[o + 11] = type.thickness;
            f[o + 12] = type.fadeStart;
            f[o + 13] = type.viewDistance;
            f[o + 14] = 1.0;                   // base AO
            f[o + 15] = type.id;
            f[o + 16] = type.colorMul[0];
            f[o + 17] = type.colorMul[1];
            f[o + 18] = type.colorMul[2];
            f[o + 19] = 0;                     // metallic bias
            // Algal film: 1 on bare mineral, 0 on living tissue. Only brain
            // coral needs the 0 today - meshgen stamps it ROCK, so it reaches
            // mineralSurface and grew turf on its own polyps - but the film is a
            // property of the ORGANISM, not of the shading slot, so it belongs
            // on the type rather than in a special case in the shader.
            f[o + 20] = type.algalFilm;
            f[o + 21] = type.fluoresces ? 1 : 0;
            f[o + 22] = 0;
            f[o + 23] = 0;

            _offsetScratch[0] = block.offset + draws * stride;
            pass.setBindGroup(GROUP.PASS, drawBindGroup, _offsetScratch);
            pass.drawIndexed(chainEntry.indexCount, count, chainEntry.firstIndex,
              chainEntry.baseVertex, chunk.firstByType[t]);
            draws++;
            triangles += chainEntry.triangles * count;
          }
        }
      }

      pass.end();
      stats.draws = draws;
      stats.triangles = triangles;
    },

    destroy() {
      for (const chunk of chunks.values()) chunk.buffer?.destroy();
      chunks.clear();
      queue.length = 0;
      queued.clear();
      liveInstances = 0;
      meshVertexBuffer?.destroy();
      meshIndexBuffer?.destroy();
      meshVertexBuffer = null;
      meshIndexBuffer = null;
    },
  };
}

/**
 * Pick the nearest LOD entry whose range still contains `dist`.
 * Chains are ordered nearest-first and the last entry always reaches the type's
 * full view distance, so this returns null only past that distance.
 */
function pickLod(chain, dist) {
  for (let i = 0; i < chain.length; i++) {
    if (dist <= chain[i].maxDist) return chain[i];
  }
  return null;
}

// setBindGroup takes an ARRAY of dynamic offsets; allocating a one-element array
// per draw would be a few hundred garbage objects every frame.
const _offsetScratch = [0];
