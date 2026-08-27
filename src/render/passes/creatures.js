/**
 * SUBWAVE creature pass.
 *
 * Draws every living thing in the ocean, immediately after the vessel and
 * before the scatter, into sceneColor, sceneDepth and velocity.
 *
 * FOUR STRUCTURAL DECISIONS.
 *
 * 1. ONE SHARED MESH BUFFER, ONE DRAW PER SPECIES. All 37 meshes are generated
 *    once at boot and packed into a single vertex and index buffer, so a draw is
 *    one drawIndexed with a firstIndex and a baseVertex and there is never a
 *    mesh rebind. The visible set is sorted by species so each species' visible
 *    instances are a contiguous RANGE, and `firstInstance` addresses it.
 *    MEASURED: 37 species, 23,946 vertices, 33,398 triangles, 1.48 MB, and a
 *    typical frame is eight to fourteen draws.
 *
 * 2. THE SKELETON IS SOLVED ON THE GPU, in one compute dispatch of
 *    instanceCount * 24 threads before the render pass. See the header of
 *    shaders/pass/creature.wgsl for why that can be one thread per bone rather
 *    than a serial walk. The CPU's contribution to animation is six scalars per
 *    creature - phase, speed, bend, bank, jaw, startle - which is 24 bytes of
 *    the 160-byte instance record.
 *
 * 3. NO PER-DRAW UNIFORM. Everything a draw needs is in storage buffers indexed
 *    by @builtin(instance_index) and by the species index inside the instance
 *    record, so the encode loop is setPipeline, two setVertexBuffer-equivalents
 *    and N drawIndexed calls with no bind group churn at all.
 *
 * 4. PREVIOUS-FRAME ANIMATION STATE LIVES HERE, not in the sim. The simulation
 *    has no business knowing about temporal antialiasing, and the sim ticks at
 *    30/10/1 Hz per LOD class while the renderer runs every frame - so "the
 *    previous frame's pose" is a rendering fact and is kept in arrays indexed by
 *    the sim's slot, invalidated by the generation counter when a slot is
 *    recycled.
 *
 * REBASING. Instance positions are ORIGIN-relative - computed on the CPU in f64
 * against camera.worldOrigin - and that is NOT the same as camera-relative. The
 * origin only jumps when the camera leaves a RENDER.REBASE_RADIUS = 2048 m box,
 * so it can sit two kilometres behind the eye, and anything that wants a real
 * distance to the viewer must measure against camera.position instead. The
 * PREVIOUS position is rebased with the CURRENT origin, which is what stops a
 * rebase frame from fabricating a screen-wide motion vector.
 */

import {
  colorAttachment, depthAttachment, DepthState, Primitive, vertexLayout, GROUP, STAGE,
} from '../../core/pipelines.js';
import { FORMATS } from '../../core/gpu.js';
import { BufferUsage, createBuffer } from '../../core/resources.js';
import { profiler } from '../../core/profiler.js';
import { RENDER, CREATURE_DRAW, GLOW, WORLD } from '../../core/constants.js';
import { clamp, smoothstep } from '../../core/math.js';
import { SPECIES, BIOLUM_PATTERN } from '../../entities/bestiary.js';
import { SLOT_GLOW } from '../glow_slots.js';
import {
  buildCreatureMesh, BONE_ROLE, albedoPatternParams,
} from '../../entities/creature_mesh.js';
import {
  SPECIES_TABLE, ARCHETYPES, ANIM_MODE, ANIM_MODE_ENV, BEHAVIOUR, ATTACK_STATE,
  FLEE_STATE, SWIM_ANIM, SWIM_ANIM_STRIDE,
} from '../../entities/creatures.js';

/** Bytes per creature vertex. See packMesh(). */
export const CREATURE_VERTEX_STRIDE = 48;
/** Bytes per instance record. Must match `struct Inst` in creature.wgsl. */
export const CREATURE_INSTANCE_STRIDE = 160;
/** Bytes per rest-bone record. Must match `struct RestBone`. */
const REST_BONE_STRIDE = 32;
/**
 * Bytes per species animation record. Must match `struct SpeciesAnim` in
 * pass/creature.wgsl, which is eleven vec4 - eight animation, two albedo
 * pattern, one emission.
 *
 * There is no test-layout.mjs for bind group 1, so tools/test-bestiary.mjs
 * section 16 parses `struct SpeciesAnim` out of the shader and compares its size
 * with this number. A disagreement here fails no validation and throws no error:
 * it just reads every species' parameters from the wrong offset, which is the
 * exact failure mode test-layout.mjs exists to catch on bind group 0.
 */
const SPECIES_ANIM_STRIDE = 176;
/** Bytes per solved bone. Must match `struct Bone` (three vec4f). */
const BONE_STRIDE = 48;

const MAX_BONES = RENDER.MAX_BONES_PER_CREATURE;
const MAX_INSTANCES = RENDER.MAX_CREATURES;

/** Compute workgroup size. Must match @workgroup_size in the shader. */
const SKIN_WORKGROUP = 64;

/**
 * Maximum bioluminescent creature lights submitted per frame.
 *
 * A Lanterngape's esca genuinely lighting the rock in front of it is the single
 * most valuable thing this pass contributes to the dark, and it is also the
 * easiest way to blow the 256-light budget: 260 creatures with a glow would take
 * every slot and leave none for the vessel's lamps. Eight is enough that the
 * nearest lit animals cast real light and the rest rely on their emissive
 * surface, which is visible on its own.
 */
const MAX_CREATURE_LIGHTS = 8;
/** Beyond this range a creature's own glow is not worth a light slot, metres. */
const CREATURE_LIGHT_RANGE = 90;
/** Mean of the metabolic pulse, shared with render/passes/glow.js. */
const PULSE_MEAN = GLOW.PULSE_MEAN;

/**
 * Per-species draw distance, as a multiple of body length.
 *
 * 220 puts a 0.11 m Coppersprat at 24 m and a 96 m Nethercoil at the view
 * distance cap. The floor of 90 m is what keeps a shoal of sprats visible across
 * a lagoon; the ceiling is RENDER.MAX_VIEW_DISTANCE because past that the
 * frustum test has already rejected it.
 *
 * These are DRAW distances, not simulation distances - the spawner's despawn
 * radii are far larger (600-1400 m) so that a leviathan can be simulated, and
 * heard, long before anything is drawn for it.
 */
// Both from constants.js, because the SIMULATION reads the same rule: an agent
// past its own draw distance is not on camera in any meaningful sense, and the
// despawn/reclaim bookkeeping depends on agreeing with this pass about that.
const DRAW_DISTANCE_PER_LENGTH = CREATURE_DRAW.DISTANCE_PER_LENGTH;
const DRAW_DISTANCE_MIN = CREATURE_DRAW.DISTANCE_MIN;

/**
 * Build the creature frame-graph pass.
 *
 * @param {import('../renderer.js').Renderer} renderer
 * @param {object} game the Game instance; `game.creatures` is the CreatureSim
 * @returns {object} a FrameGraph pass with an extra submitLights(renderer)
 */
export function makeCreaturePass(renderer, game) {
  /** @type {GPUDevice|null} */
  let device = null;
  let pipeline = null;
  let pipelineNoCull = null;
  let skinPipeline = null;

  let meshVertexBuffer = null;
  let meshIndexBuffer = null;
  let instanceBuffer = null;
  let boneBuffer = null;
  let restBoneBuffer = null;
  let speciesBuffer = null;
  let skinParamBuffer = null;

  let renderLayout = null;
  let computeLayout = null;
  let skinLayout = null;
  let emptyLayout = null;
  let renderBindGroup = null;
  let computeBindGroup = null;
  let skinBindGroup = null;
  let emptyBindGroup = null;

  /** @type {Array<{firstIndex, indexCount, baseVertex, radius, triangles, twoSided}>} */
  let meshes = null;

  /** Instance staging. One allocation, reused every frame. */
  const instanceData = new Float32Array(MAX_INSTANCES * (CREATURE_INSTANCE_STRIDE / 4));
  const instanceU32 = new Uint32Array(instanceData.buffer);
  const skinParams = new Uint32Array(4);

  /** Visible slots for this frame, and their species, sorted by species. */
  const visible = new Int32Array(MAX_INSTANCES);
  const visibleSpecies = new Int32Array(MAX_INSTANCES);
  /** Metres from the CAMERA, kept from the cull test so nothing re-measures it. */
  const visibleDist = new Float32Array(MAX_INSTANCES);
  const order = new Int32Array(MAX_INSTANCES);

  /**
   * Previous-frame animation state, indexed by the sim's slot. `prevGen` is the
   * generation the state was recorded for: when a slot is recycled the
   * generation changes and the previous state is reset to the current one, so a
   * newly spawned creature does not inherit the motion vector of whatever
   * occupied its slot last.
   */
  const prevPosX = new Float64Array(MAX_INSTANCES);
  const prevPosY = new Float64Array(MAX_INSTANCES);
  const prevPosZ = new Float64Array(MAX_INSTANCES);
  const prevQuat = new Float32Array(MAX_INSTANCES * 4);
  const prevPhase = new Float32Array(MAX_INSTANCES);
  const prevSpeed = new Float32Array(MAX_INSTANCES);
  const prevBend = new Float32Array(MAX_INSTANCES);
  const prevBank = new Float32Array(MAX_INSTANCES);
  const prevJaw = new Float32Array(MAX_INSTANCES);
  const prevGen = new Int32Array(MAX_INSTANCES).fill(-1);

  /** Brightest bioluminescent creatures in frame, for submitLights(). */
  const lightSlots = new Int32Array(MAX_CREATURE_LIGHTS);
  /** Delivered illuminance I/d^2 for the slot, which is what ranks it. */
  const lightScore = new Float32Array(MAX_CREATURE_LIGHTS);
  let lightCount = 0;
  const lightPos = new Float32Array(3);
  const lightColor = new Float32Array(3);
  /** Membership view of lightSlots, rebuilt on demand for the glow pass. */
  const lightSet = new Set();

  /**
   * Per-species EMISSION, baked from the real procedural mesh.
   *
   *   flux[sp*3..2]  radiant intensity in W/sr at biolum radiance 1, i.e.
   *                  biolumRGB * (sum over triangles of area * mask * s.glow)/4.
   *                  The /4 is Cauchy's theorem: the mean projected area of a
   *                  convex body is a quarter of its surface area, which is what
   *                  turns a Lambertian emitting AREA at radiance L into a
   *                  radiant INTENSITY I = L*A/4.
   *   radius[sp]     the emissive organ's effective radius in the rest pose, m.
   *   area[sp]       the effective emissive area, m2. Kept for the offline test.
   *   hz[sp]         the pulse rate, so the sprite beats with the body.
   *
   * WHY THIS CANNOT COME FROM `bioluminescence.intensity`. A Lanterngape's
   * authored intensity is 3.5 and a Voltbarb's is 8, but the Lanterngape's esca
   * is 0.35% of its skin and the Voltbarb's rows are 20.6% - so ranking emitters
   * by the authored number is wrong by four orders of magnitude, and in the
   * wrong direction. The flux has to come from the mesh.
   */
  const speciesEmit = {
    flux: new Float32Array(SPECIES.length * 3),
    radius: new Float32Array(SPECIES.length),
    area: new Float32Array(SPECIES.length),
    hz: new Float32Array(SPECIES.length),
    /** Flux-weighted centroid of the emissive triangles, MODEL space, metres.
     *  This is where the light actually is: a Lanterngape's esca is a point at
     *  the end of a 1.4 m fish, so the glow pass places its sprite here rather
     *  than on the instance root. Rest pose - the bone deform is not applied. */
    centroid: new Float32Array(SPECIES.length * 3),
  };

  const stats = {
    speciesBuilt: 0,
    meshVertices: 0,
    meshTriangles: 0,
    meshBytes: 0,
    gpuBytes: 0,
    instances: 0,
    draws: 0,
    triangles: 0,
    boneThreads: 0,
    lights: 0,
  };

  const meshLayout = vertexLayout([
    [0, 'float32x3'],   // position, model space
    [1, 'float32x3'],   // normal, model space
    [2, 'float32x2'],   // uv; x around the body, y along it
    [3, 'unorm8x4'],    // sqrt(linear rgb), a = bioluminescence mask
    [4, 'unorm8x4'],    // x = material slot / 255, y = inflate weight,
                        // z = trunk mask (gates the albedo pattern)
    [5, 'uint8x4'],     // bone indices
    [6, 'unorm8x4'],    // bone weights
  ]);

  // -------------------------------------------------------------------------
  // Mesh library
  // -------------------------------------------------------------------------

  const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0);

  /**
   * Pack one creature_mesh structure-of-arrays mesh into the interleaved
   * 48-byte vertex the pipeline expects.
   *
   * Colour is stored as sqrt(linear) in eight bits, the same encoding
   * pass/terrain.wgsl and pass/scatter.wgsl use and for the same reason: eight
   * bits of LINEAR colour puts its first step at 1/255, which is a visible band
   * across the dark dorsum of every counter-shaded animal in the roster.
   *
   * The bioluminescence MASK rides in colour.w, exactly where meshgen puts a
   * plant's sway weight - creature_mesh.js documents the reuse. Eight bits is
   * ample: the mask selects photophores, and a photophore is either lit or it is
   * not.
   */
  function packMesh(mesh) {
    const n = mesh.vertexCount;
    const buf = new ArrayBuffer(n * CREATURE_VERTEX_STRIDE);
    const f32 = new Float32Array(buf);
    const u8 = new Uint8Array(buf);
    const pos = mesh.positions, nrm = mesh.normals, uv = mesh.uvs;
    const col = mesh.colors, mat = mesh.materials;
    const inflate = mesh.inflate, bi = mesh.boneIndices, bw = mesh.boneWeights;
    const stride4 = CREATURE_VERTEX_STRIDE / 4;
    const trunk = new Uint8Array(n);
    for (const part of mesh.parts) {
      if (part.kind !== 'body') continue;
      trunk.fill(1, part.start, part.start + part.count);
    }

    for (let i = 0; i < n; i++) {
      const o = i * stride4;
      const b = i * CREATURE_VERTEX_STRIDE;
      const p3 = i * 3, p2 = i * 2, p4 = i * 4;
      f32[o + 0] = pos[p3]; f32[o + 1] = pos[p3 + 1]; f32[o + 2] = pos[p3 + 2];
      f32[o + 3] = nrm[p3]; f32[o + 4] = nrm[p3 + 1]; f32[o + 5] = nrm[p3 + 2];
      f32[o + 6] = uv[p2]; f32[o + 7] = uv[p2 + 1];
      u8[b + 32] = clampByte(Math.sqrt(Math.max(col[p4], 0)) * 255);
      u8[b + 33] = clampByte(Math.sqrt(Math.max(col[p4 + 1], 0)) * 255);
      u8[b + 34] = clampByte(Math.sqrt(Math.max(col[p4 + 2], 0)) * 255);
      u8[b + 35] = clampByte(col[p4 + 3] * 255);       // biolum mask
      u8[b + 36] = mat[i] & 0x07;                      // material slot
      u8[b + 37] = clampByte((inflate ? inflate[i] : 0) * 255);
      // TRUNK MASK. The albedo pattern is a function of the LOFT's (theta, u),
      // and a snout, barbel, tentacle or leg is also MM_FLORA but carries a
      // sweep uv instead - so the material slot cannot gate the pattern and this
      // bit has to.
      u8[b + 38] = trunk[i] ? 255 : 0;
      u8[b + 39] = 0;
      u8[b + 40] = bi[p4] & 0xff;
      u8[b + 41] = bi[p4 + 1] & 0xff;
      u8[b + 42] = bi[p4 + 2] & 0xff;
      u8[b + 43] = bi[p4 + 3] & 0xff;
      // Bone weights are unorm8, so they are re-normalised in the vertex shader
      // rather than trusted to sum to 255 after rounding. See skinVertex().
      u8[b + 44] = clampByte(bw[p4] * 255);
      u8[b + 45] = clampByte(bw[p4 + 1] * 255);
      u8[b + 46] = clampByte(bw[p4 + 2] * 255);
      u8[b + 47] = clampByte(bw[p4 + 3] * 255);
    }
    return { f32, u8 };
  }

  /**
   * Generate every species once and pack them into one pair of buffers, plus
   * the rest-bone palette and the per-species animation block.
   *
   * The MESH SEED is derived from the species index, not the world seed: an
   * animal's ANATOMY does not have to change when the planet does, and pinning
   * it means the mesh library is identical across saves and can be built before
   * the world seed is known. Per-individual variety comes from the instance
   * scale and tint.
   */
  function buildMeshLibrary() {
    const vertexChunks = [];
    const indexChunks = [];
    meshes = new Array(SPECIES.length);
    const restData = new Float32Array(SPECIES.length * MAX_BONES * (REST_BONE_STRIDE / 4));
    const animData = new Float32Array(SPECIES.length * (SPECIES_ANIM_STRIDE / 4));
    const animU32 = new Uint32Array(animData.buffer);

    let vertexCursor = 0;
    let indexCursor = 0;
    let totalTriangles = 0;

    for (let sp = 0; sp < SPECIES.length; sp++) {
      const record = SPECIES[sp];
      const mesh = buildCreatureMesh(record, 0x1a7e0001 + sp * 7919);
      const packed = packMesh(mesh);
      vertexChunks.push(packed.u8);
      indexChunks.push(new Uint32Array(mesh.indices.buffer, mesh.indices.byteOffset,
        mesh.indexCount));

      meshes[sp] = {
        firstIndex: indexCursor,
        indexCount: mesh.indexCount,
        baseVertex: vertexCursor,
        radius: mesh.boundingRadius,
        triangles: mesh.triangleCount,
        boneCount: mesh.boneCount,
        // Fins, bells and membranes are single-sided sheets. Culling them makes
        // half of every fin in the ocean vanish from one side, so any species
        // with translucent tissue goes in the no-cull batch and the fragment
        // shader flips the normal on a back face.
        twoSided: hasTranslucent(mesh),
      };
      vertexCursor += mesh.vertexCount;
      indexCursor += mesh.indexCount;
      totalTriangles += mesh.triangleCount;
      stats.meshVertices += mesh.vertexCount;

      writeRestBones(restData, sp, mesh);
      bakeSpeciesEmit(sp, mesh);
      writeSpeciesAnim(animData, animU32, sp, mesh);
    }

    // One upload each. Concatenating on the CPU beats 37 small writeBuffers,
    // and the staging arrays are transient either way.
    const vertexBytes = vertexChunks.reduce((n, a) => n + a.byteLength, 0);
    const indexBytes = indexChunks.reduce((n, a) => n + a.byteLength, 0);
    const vertexData = new Uint8Array(vertexBytes);
    let vo = 0;
    for (const a of vertexChunks) { vertexData.set(a, vo); vo += a.byteLength; }
    const indexData = new Uint32Array(indexBytes / 4);
    let io = 0;
    for (const a of indexChunks) { indexData.set(a, io); io += a.length; }

    meshVertexBuffer = createBuffer(device, {
      label: 'creature.mesh.vb',
      size: Math.max(vertexBytes, CREATURE_VERTEX_STRIDE),
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    meshIndexBuffer = createBuffer(device, {
      label: 'creature.mesh.ib',
      size: Math.max(indexBytes, 4),
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(meshVertexBuffer, 0, vertexData);
    device.queue.writeBuffer(meshIndexBuffer, 0, indexData);

    restBoneBuffer = createBuffer(device, {
      label: 'creature.restBones',
      size: restData.byteLength,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(restBoneBuffer, 0, restData);

    speciesBuffer = createBuffer(device, {
      label: 'creature.speciesAnim',
      size: animData.byteLength,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(speciesBuffer, 0, animData);

    stats.speciesBuilt = SPECIES.length;
    stats.meshTriangles = totalTriangles;
    stats.meshBytes = vertexBytes + indexBytes;
    console.info(
      `[creatures] mesh library: ${SPECIES.length} species, ` +
      `${stats.meshVertices.toLocaleString()} vertices, ` +
      `${totalTriangles.toLocaleString()} triangles, ` +
      `${(stats.meshBytes / 1048576).toFixed(2)} MB`);
  }

  /** True if any vertex of a mesh is thin tissue, so the species is two-sided. */
  function hasTranslucent(mesh) {
    for (let i = 0; i < mesh.vertexCount; i++) if (mesh.materials[i] === 2) return true;
    return false;
  }

  /**
   * Write one species' rest-bone palette.
   *
   * The palette is species-major at a fixed MAX_BONES stride, so the shader's
   * restBoneBase() is one multiply. Unused slots are left as the identity rest
   * pose, which is harmless because the compute kernel skips bones past the
   * species' own count.
   */
  function writeRestBones(out, sp, mesh) {
    const base = sp * MAX_BONES * (REST_BONE_STRIDE / 4);
    const bones = mesh.bones;
    for (let b = 0; b < Math.min(bones.length, MAX_BONES); b++) {
      const bone = bones[b];
      const o = base + b * (REST_BONE_STRIDE / 4);
      out[o + 0] = bone.position[0];
      out[o + 1] = bone.position[1];
      out[o + 2] = bone.position[2];
      out[o + 3] = bone.u;
      out[o + 4] = bone.parent;
      out[o + 5] = bone.role;
      out[o + 6] = bone.restLength;
      // info.w: used by BONE_ROLE.MANDIBLE alone, and it carries that horn's
      // RADIAL ANGLE about the body axis. The GPU rebuilds the fold axis from
      // it (tangential to the radial), which is what lets four horns flare
      // outward in four different planes off one scalar driver.
      out[o + 7] = bone.radial ?? 0;
    }
  }

  /**
   * Integrate one species' emissive area off the real mesh.
   *
   * The weight per triangle is `area * mask * SLOT_GLOW[material]`, which is
   * exactly the product pass/creature.wgsl multiplies the species' biolum
   * radiance by (`in.extra.x * s.glow`) - so the sprite's flux and the
   * geometry's emission cannot disagree by construction. The mask is per-VERTEX
   * (creature_mesh.js writes it into colour.w) and is averaged over the three
   * corners; the material is a per-vertex slot and a triangle never spans two,
   * so corner 0 decides it.
   *
   * `radius` is sqrt(2/3) * R_g, the mean projected radius of gyration of a 3-D
   * isotropic distribution, over the SAME weights. NOT bodyLength: a
   * Lanterngape's esca is a point at the end of a 1.4 m fish and a Wisplight's
   * ventral rows span its whole body, and bodyLength gets both wrong. This is
   * the radius the fRes handover in pass/creature.wgsl tests against, so it
   * decides at what range the geometry stops resolving the organ.
   */
  function bakeSpeciesEmit(sp, mesh) {
    const b = sp * 4;
    const br = SPECIES_TABLE.biolum[b];
    const bg = SPECIES_TABLE.biolum[b + 1];
    const bb = SPECIES_TABLE.biolum[b + 2];
    speciesEmit.hz[sp] = SPECIES_TABLE.biolum[b + 3];
    if (br <= 0 && bg <= 0 && bb <= 0) return;

    const pos = mesh.positions, col = mesh.colors, mat = mesh.materials;
    const idx = mesh.indices;
    let area = 0;
    let cx = 0, cy = 0, cz = 0;
    // Two passes over the triangles: the first accumulates the weighted
    // centroid, the second the second moment about it. Both are O(tris) and run
    // once at boot.
    for (let t = 0; t < mesh.indexCount; t += 3) {
      const i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2];
      const g = SLOT_GLOW[mat[i0] & 7];
      const mask = (col[i0 * 4 + 3] + col[i1 * 4 + 3] + col[i2 * 4 + 3]) / 3;
      if (mask <= 0 || g <= 0) continue;
      const ax = pos[i1 * 3] - pos[i0 * 3];
      const ay = pos[i1 * 3 + 1] - pos[i0 * 3 + 1];
      const az = pos[i1 * 3 + 2] - pos[i0 * 3 + 2];
      const bx = pos[i2 * 3] - pos[i0 * 3];
      const by = pos[i2 * 3 + 1] - pos[i0 * 3 + 1];
      const bz = pos[i2 * 3 + 2] - pos[i0 * 3 + 2];
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const w = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz) * mask * g;
      if (!(w > 0)) continue;
      area += w;
      cx += w * (pos[i0 * 3] + pos[i1 * 3] + pos[i2 * 3]) / 3;
      cy += w * (pos[i0 * 3 + 1] + pos[i1 * 3 + 1] + pos[i2 * 3 + 1]) / 3;
      cz += w * (pos[i0 * 3 + 2] + pos[i1 * 3 + 2] + pos[i2 * 3 + 2]) / 3;
    }
    if (area <= 0) return;
    cx /= area; cy /= area; cz /= area;

    let m2 = 0;
    for (let t = 0; t < mesh.indexCount; t += 3) {
      const i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2];
      const g = SLOT_GLOW[mat[i0] & 7];
      const mask = (col[i0 * 4 + 3] + col[i1 * 4 + 3] + col[i2 * 4 + 3]) / 3;
      if (mask <= 0 || g <= 0) continue;
      const ax = pos[i1 * 3] - pos[i0 * 3];
      const ay = pos[i1 * 3 + 1] - pos[i0 * 3 + 1];
      const az = pos[i1 * 3 + 2] - pos[i0 * 3 + 2];
      const bx = pos[i2 * 3] - pos[i0 * 3];
      const by = pos[i2 * 3 + 1] - pos[i0 * 3 + 1];
      const bz = pos[i2 * 3 + 2] - pos[i0 * 3 + 2];
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const w = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz) * mask * g;
      if (!(w > 0)) continue;
      const px = (pos[i0 * 3] + pos[i1 * 3] + pos[i2 * 3]) / 3 - cx;
      const py = (pos[i0 * 3 + 1] + pos[i1 * 3 + 1] + pos[i2 * 3 + 1]) / 3 - cy;
      const pz = (pos[i0 * 3 + 2] + pos[i1 * 3 + 2] + pos[i2 * 3 + 2]) / 3 - cz;
      m2 += w * (px * px + py * py + pz * pz);
    }

    const rg = Math.sqrt(m2 / area);
    speciesEmit.centroid[sp * 3] = cx;
    speciesEmit.centroid[sp * 3 + 1] = cy;
    speciesEmit.centroid[sp * 3 + 2] = cz;
    speciesEmit.area[sp] = area;
    speciesEmit.radius[sp] = Math.sqrt(2 / 3) * rg;
    // A DORSAL_EMBER wash is PIGMENT-GLOW, NOT A LAMP: its flux is zeroed so
    // considerLight() never submits the animal as a point light and the glow
    // pass never draws it a sprite, while radius/area stay REAL - fs_creature
    // multiplies the geometry's emission by fRes(emitRadius), and a zeroed
    // radius silently kills the ember it exists to deliver (shipped for one
    // round; the daylight frames lost every trace of red). Measured before
    // the flux gate: the Splitmaw's body-length wash baked an enormous
    // emissive area, the animal submitted ITSELF as one of the eight
    // creature lights, and the close-range specular of its own lamp bloomed
    // the hull WHITE at any albedo - a black diagnostic tint still delivered
    // (135, 225, 255) on the flank against a scene red of 3. The light
    // system's photophore-sized assumption is kept true instead of stretched.
    const ember = SPECIES[sp].bioluminescence.pattern === BIOLUM_PATTERN.DORSAL_EMBER;
    speciesEmit.flux[sp * 3 + 0] = ember ? 0 : br * area * 0.25;
    speciesEmit.flux[sp * 3 + 1] = ember ? 0 : bg * area * 0.25;
    speciesEmit.flux[sp * 3 + 2] = ember ? 0 : bb * area * 0.25;
  }

  /**
   * Write one species' animation block.
   *
   * Everything here comes from the ARCHETYPES table in entities/creatures.js,
   * which transcribes DESIGN/06.3.5, plus the species' own swim mode and body
   * length. The one derived value is `Ap`, the dorsoventral amplitude fraction:
   * DESIGN/06.3.3 gives 0 for most fish, 0.6 for the cetacean-tailed Pale Herald
   * and 0.25 for rays, and thunniform / rajiform is exactly that distinction.
   */
  function writeSpeciesAnim(out, outU32, sp, mesh) {
    const a = ARCHETYPES[SPECIES_TABLE.archetype[sp]];
    const mode = SPECIES_TABLE.animMode[sp];
    const env = ANIM_MODE_ENV[mode];
    const o = sp * (SPECIES_ANIM_STRIDE / 4);
    const L = SPECIES_TABLE.length[sp];
    // The wave parameters come from the species' RESOLVED row, which defaults
    // from the archetype and which entities/creatures.js's `_animate` reads for
    // the other half of the same model - the CPU owns the beat rate, this owns
    // the amplitude, and they cannot be allowed to describe different animals.
    const sw = SPECIES_TABLE.swimAnim;
    const so = sp * SWIM_ANIM_STRIDE;

    // wave.* is uploaded for completeness; the shader consumes `phase`, which
    // the CPU accumulates from exactly these four.
    out[o + 0] = sw[so + SWIM_ANIM.f0]; out[o + 1] = sw[so + SWIM_ANIM.kf];
    out[o + 2] = sw[so + SWIM_ANIM.fMin]; out[o + 3] = sw[so + SWIM_ANIM.fMax];
    out[o + 4] = sw[so + SWIM_ANIM.A0]; out[o + 5] = sw[so + SWIM_ANIM.A1];
    out[o + 6] = sw[so + SWIM_ANIM.U0]; out[o + 7] = sw[so + SWIM_ANIM.U1];
    out[o + 8] = env.c0; out[o + 9] = env.c1; out[o + 10] = env.c2; out[o + 11] = env.uMin;
    out[o + 12] = sw[so + SWIM_ANIM.lambdaB];
    out[o + 13] = sw[so + SWIM_ANIM.bendMax];
    out[o + 14] = a.rollMax;
    out[o + 15] = L;
    out[o + 16] = a.mFin;
    out[o + 17] = a.af0;
    out[o + 18] = a.af1;
    // lambdaFin: 0.9 chord lengths, DESIGN/06.3.2's rajiform detail. Expressed
    // in span fraction, so a full wave crosses a little over the whole wing.
    out[o + 19] = 0.9;
    out[o + 20] = SPECIES_TABLE.biolum[sp * 4 + 0];
    out[o + 21] = SPECIES_TABLE.biolum[sp * 4 + 1];
    out[o + 22] = SPECIES_TABLE.biolum[sp * 4 + 2];
    out[o + 23] = SPECIES_TABLE.biolum[sp * 4 + 3];
    outU32[o + 24] = mode;
    outU32[o + 25] = mesh.spineCount;
    outU32[o + 26] = mesh.jawBone >>> 0;
    outU32[o + 27] = mesh.lureBone >>> 0;
    // Jaw travel. A predator's gape is wide; a grazer's picking mouth is not.
    out[o + 28] = SPECIES_TABLE.tier[sp] >= 3 ? 0.95
      : SPECIES_TABLE.tier[sp] >= 1 ? 0.62 : 0.38;
    // Inflation, in metres of normal displacement at inflate = 1. Only two
    // species have a non-zero per-vertex inflate weight, so this is harmless
    // everywhere else.
    out[o + 29] = L * 0.22;
    out[o + 30] = SPECIES_TABLE.thickness[sp];
    // Ap's per-MODE derivation moved into the swimAnim resolution in
    // entities/creatures.js, where it is the default a `swimAnim` row overrides.
    out[o + 31] = sw[so + SWIM_ANIM.Ap];

    // ---- albedo pattern -------------------------------------------------
    // creature_mesh.js owns the recipe -> shader translation, because it also
    // owns the (theta, u) parameterisation the mask is written against and the
    // sRGB -> linear decode every other creature colour goes through.
    const pat = albedoPatternParams(SPECIES[sp]);
    out[o + 32] = pat.kind;
    out[o + 33] = pat.count;
    out[o + 34] = pat.duty;
    out[o + 35] = pat.strength;
    out[o + 36] = pat.colour[0];
    out[o + 37] = pat.colour[1];
    out[o + 38] = pat.colour[2];
    out[o + 39] = pat.roughness;

    // ---- emission -------------------------------------------------------
    // The organ's own radius, which is what fs_creature's fRes handover tests
    // against: the geometry keeps fRes of the emission and render/passes/glow.js
    // draws 1 - fRes, so the total is exactly 1 at every range. See
    // bakeSpeciesEmit() for why this is a radius of gyration and not bodyLength.
    out[o + 40] = speciesEmit.radius[sp];
    out[o + 41] = speciesEmit.area[sp];
    // emit.z: per-species SKIN ROUGHNESS BIAS (meshRecipe.skinRoughnessBias,
    // default 0 = bit-identical for every existing species). Built for the
    // Splitmaw: skinSurface's wet-mucus 0.34 base is a broad specular mirror
    // of the bright water dome in the Sunken Dunes' luminous column, and it
    // rendered a NEAR-BLACK albedo as a white-lavender sheen - the animal's
    // authored colour never reached the frame. A matte hide is the fix the
    // albedo can survive.
    out[o + 42] = SPECIES[sp].meshRecipe?.skinRoughnessBias ?? 0;
    // emit.w: MANDIBLE FOLD, radians. The angle each BONE_ROLE.MANDIBLE bone
    // rotates its horn INWARD at jawOpen = 0, about the axis tangential to that
    // horn's own radial; the mesh is authored open, so 0 here is the shipped
    // pre-splayed X at every gape and the field is its own bisect. Measured
    // rather than tuned - test-bestiary section 15 replays the rotation over
    // the real vertices and asserts the folded tips clear each other.
    out[o + 43] = SPECIES[sp].meshRecipe?.mandibles?.fold ?? 0;
  }

  // -------------------------------------------------------------------------
  // Per-frame instance packing
  // -------------------------------------------------------------------------

  /**
   * Gather the visible creatures, sort them by species and pack the instance
   * records.
   *
   * @returns {number} how many instances were written
   */
  function packInstances(camera) {
    const sim = game.creatures;
    const live = sim.liveSlots();
    const origin = camera.worldOrigin;
    const camX = camera.position[0], camY = camera.position[1], camZ = camera.position[2];

    let n = 0;
    for (let k = 0; k < live.length && n < MAX_INSTANCES; k++) {
      const i = live[k];
      const sp = sim.species[i];
      const mesh = meshes[sp];
      if (!mesh || mesh.indexCount === 0) continue;

      const x = sim.posX[i], y = sim.posY[i], z = sim.posZ[i];
      const dx = x - camX, dy = y - camY, dz = z - camZ;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const drawMax = Math.min(
        Math.max(DRAW_DISTANCE_MIN, sim.bodyLength[i] * DRAW_DISTANCE_PER_LENGTH),
        RENDER.MAX_VIEW_DISTANCE);
      if (dist > drawMax) continue;

      const radius = mesh.radius * sim.scale[i];
      if (!camera.isSphereVisible(sim._pointOf(i), radius)) continue;

      visible[n] = i;
      visibleSpecies[n] = sp;
      visibleDist[n] = dist;
      order[n] = n;
      n++;
    }
    if (n === 0) return 0;

    // Sort by species so each species' instances are one contiguous range.
    // Insertion sort on the index array: n is at most 260 and the set is almost
    // sorted frame to frame because the live list is slot-ordered and slots are
    // handed out in species batches by the spawner.
    for (let a = 1; a < n; a++) {
      const key = order[a];
      const keySpecies = visibleSpecies[key];
      let b = a - 1;
      while (b >= 0 && visibleSpecies[order[b]] > keySpecies) {
        order[b + 1] = order[b];
        b--;
      }
      order[b + 1] = key;
    }

    const stride4 = CREATURE_INSTANCE_STRIDE / 4;
    lightCount = 0;
    for (let idx = 0; idx < n; idx++) {
      const i = visible[order[idx]];
      const sp = sim.species[i];
      const o = idx * stride4;

      // ---- previous-frame state ----------------------------------------
      const gen = sim.generation[i];
      if (prevGen[i] !== gen) {
        prevGen[i] = gen;
        prevPosX[i] = sim.posX[i]; prevPosY[i] = sim.posY[i]; prevPosZ[i] = sim.posZ[i];
        prevQuat[i * 4] = sim.orient[i * 4];
        prevQuat[i * 4 + 1] = sim.orient[i * 4 + 1];
        prevQuat[i * 4 + 2] = sim.orient[i * 4 + 2];
        prevQuat[i * 4 + 3] = sim.orient[i * 4 + 3];
        prevPhase[i] = sim.phase[i];
        prevSpeed[i] = 0;
        prevBend[i] = 0;
        prevBank[i] = 0;
        prevJaw[i] = sim.jawOpen[i];
      }

      const speed = Math.sqrt(sim.velX[i] * sim.velX[i] + sim.velY[i] * sim.velY[i]
        + sim.velZ[i] * sim.velZ[i]);

      // ---- posScale, orient --------------------------------------------
      instanceData[o + 0] = sim.posX[i] - origin[0];
      instanceData[o + 1] = sim.posY[i] - origin[1];
      instanceData[o + 2] = sim.posZ[i] - origin[2];
      instanceData[o + 3] = sim.scale[i];
      instanceData[o + 4] = sim.orient[i * 4];
      instanceData[o + 5] = sim.orient[i * 4 + 1];
      instanceData[o + 6] = sim.orient[i * 4 + 2];
      instanceData[o + 7] = sim.orient[i * 4 + 3];

      // ---- anim ---------------------------------------------------------
      instanceData[o + 8] = sim.phase[i];
      instanceData[o + 9] = speed;
      instanceData[o + 10] = sim.bendTurn[i];
      instanceData[o + 11] = sim.bank[i];

      // ---- anim2: jaw, startle, pursuit lead, inflate --------------------
      instanceData[o + 12] = sim.jawOpen[i];
      const startle = sim.behaviour[i] === BEHAVIOUR.FLEE &&
        sim.state[i] === FLEE_STATE.STARTLE
        ? 1 - clamp(sim.startleT[i] / Math.max(ARCHETYPES[sim.archetype[i]].tStartle, 1e-3), 0, 1)
        : 0;
      instanceData[o + 13] = startle;
      instanceData[o + 14] = pursuitAngle(sim, i);
      // The Bloatspine puffs up when it is frightened, which is the whole animal:
      // fear drives the inflation directly and nothing else needs to know.
      instanceData[o + 15] = clamp(sim.fear[i] / 1.3, 0, 1);

      // ---- tint ---------------------------------------------------------
      // Per-individual brightness jitter from the slot hash so a school is a
      // school of individuals. The emissive gain rises with the animal's own
      // arousal: a startled Glimmerkrill flashes, a calm one glimmers.
      const jitter = 0.88 + 0.24 * ((i * 2654435761 >>> 24) / 255);
      instanceData[o + 16] = jitter;
      instanceData[o + 17] = jitter;
      instanceData[o + 18] = jitter;
      instanceData[o + 19] = 1 + 1.6 * clamp(sim.fear[i] / 1.3, 0, 1);

      // ---- ids ----------------------------------------------------------
      instanceU32[o + 20] = idx * MAX_BONES;
      instanceU32[o + 21] = sp;
      instanceU32[o + 22] = sim.flags[i];
      instanceU32[o + 23] = Math.min(meshes[sp].boneCount, MAX_BONES);

      // ---- previous frame ------------------------------------------------
      // Rebased with the CURRENT origin, so a rebase frame does not fabricate a
      // screen-wide motion vector.
      instanceData[o + 24] = prevPosX[i] - origin[0];
      instanceData[o + 25] = prevPosY[i] - origin[1];
      instanceData[o + 26] = prevPosZ[i] - origin[2];
      instanceData[o + 27] = prevPhase[i];
      instanceData[o + 28] = prevQuat[i * 4];
      instanceData[o + 29] = prevQuat[i * 4 + 1];
      instanceData[o + 30] = prevQuat[i * 4 + 2];
      instanceData[o + 31] = prevQuat[i * 4 + 3];
      instanceData[o + 32] = prevSpeed[i];
      instanceData[o + 33] = prevBend[i];
      instanceData[o + 34] = prevBank[i];
      instanceData[o + 35] = prevJaw[i];

      // ---- misc: hurt, individual hash -----------------------------------
      instanceData[o + 36] = 1 - clamp(sim.hp[i] / Math.max(sim.hpMax[i], 1e-3), 0, 1);
      // The pattern's per-INDIVIDUAL phase. Same Knuth multiplicative hash the
      // brightness jitter above uses, on a different byte of the product, so a
      // fish that happens to be pale is not also always barred the same way.
      instanceData[o + 37] = ((i * 2654435761 >>> 16) & 0xff) / 255;
      instanceData[o + 38] = 0;
      instanceData[o + 39] = 0;

      // ---- record this frame as next frame's previous --------------------
      prevPosX[i] = sim.posX[i]; prevPosY[i] = sim.posY[i]; prevPosZ[i] = sim.posZ[i];
      prevQuat[i * 4] = sim.orient[i * 4];
      prevQuat[i * 4 + 1] = sim.orient[i * 4 + 1];
      prevQuat[i * 4 + 2] = sim.orient[i * 4 + 2];
      prevQuat[i * 4 + 3] = sim.orient[i * 4 + 3];
      prevPhase[i] = sim.phase[i];
      prevSpeed[i] = speed;
      prevBend[i] = sim.bendTurn[i];
      prevBank[i] = sim.bank[i];
      prevJaw[i] = sim.jawOpen[i];

      // ---- light candidate ----------------------------------------------
      // The distance comes from THIS function's own cull test, not from
      // sim.distToCamera: that field is written by simulate(), which does not
      // run while the game is paused, so a paused frame would light nothing.
      //
      // It must be the distance to the CAMERA and not the length of the packed
      // instance position. Those are not the same vector: instance positions are
      // relative to camera.worldOrigin, which only moves
      // when the camera leaves a RENDER.REBASE_RADIUS = 2048 m box, so at the
      // default spawn the origin is still (0,0,0) and the camera is 452 m from
      // it. MEASURED with a Lanterngape planted 5.93 m in front of the camera:
      // the origin-relative length was 446.58 m, every candidate failed the 90 m
      // range test, and the pass submitted zero lights - the entire creature
      // bioluminescence light path was unreachable in play.
      considerLight(i, sp, visibleDist[order[idx]], sim.scale[i]);
    }
    return n;
  }

  /**
   * Signed angle from the agent's forward direction to its target, for the
   * pursuit-lead term. Zero unless the animal is actually committed: the lead is
   * the readability cue for an incoming attack, and a fish that aims its head at
   * everything it happens to be near reads as uncanny rather than as dangerous.
   */
  function pursuitAngle(sim, i) {
    if (sim.behaviour[i] !== BEHAVIOUR.ATTACK) return 0;
    const st = sim.state[i];
    if (st !== ATTACK_STATE.APPROACH && st !== ATTACK_STATE.WINDUP &&
        st !== ATTACK_STATE.LUNGE) return 0;
    if (!sim._targetPosition(i, _targetScratch)) return 0;
    sim._forwardOf(i, _fwdScratch);
    const dx = _targetScratch[0] - sim.posX[i];
    const dz = _targetScratch[2] - sim.posZ[i];
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1e-3) return 0;
    // Horizontal bearing difference only: the vertical component is already
    // carried by the body's own pitch through the depth-keeping force.
    const fx = _fwdScratch[0], fz = _fwdScratch[2];
    const fl = Math.sqrt(fx * fx + fz * fz) || 1;
    const cross = (fx / fl) * (dz / d) - (fz / fl) * (dx / d);
    const dot = (fx / fl) * (dx / d) + (fz / fl) * (dz / d);
    return Math.atan2(cross, dot);
  }

  /**
   * Keep the MAX_CREATURE_LIGHTS creatures that actually light the most.
   *
   * RANKED BY ILLUMINANCE, NOT BY RANGE, AND GATED ON THE MESH'S OWN FLUX. The
   * gate this replaces was `sum(biolum.rgb) >= 0.25`, an authored RADIANCE, and
   * the ordering was distance alone. A radiance says nothing about how much
   * light an animal makes: a Lanterngape's authored 3.5 sits on 0.35% of its
   * skin and a Voltbarb's 8 on 20.63%, so the two differ by 196x in radiant
   * intensity and in the opposite order to the authored numbers. What decides
   * whether a lamp is worth one of eight cluster slots is what it delivers HERE,
   * which is I/d^2 - so a bright animal at 30 m beats a spark at 3 m, and the
   * spark keeps its own emissive surface and its sprite either way.
   */
  function considerLight(i, sp, d, scale) {
    const f3 = sp * 3;
    const peak = Math.max(speciesEmit.flux[f3], speciesEmit.flux[f3 + 1],
      speciesEmit.flux[f3 + 2]);
    if (!(peak > 0)) return;
    if (d > CREATURE_LIGHT_RANGE) return;
    const score = peak * scale * scale / Math.max(d * d, 1e-4);
    if (lightCount < MAX_CREATURE_LIGHTS) {
      lightSlots[lightCount] = i;
      lightScore[lightCount] = score;
      lightCount++;
      return;
    }
    // Replace the weakest.
    let worst = 0;
    for (let k = 1; k < MAX_CREATURE_LIGHTS; k++) if (lightScore[k] < lightScore[worst]) worst = k;
    if (score > lightScore[worst]) { lightSlots[worst] = i; lightScore[worst] = score; }
  }

  // -------------------------------------------------------------------------
  // Pass
  // -------------------------------------------------------------------------

  return {
    name: 'creatures',
    type: 'render',
    writes: ['sceneColor', 'sceneDepth', 'velocity', 'aoGate'],
    // Shadow atlas, caustics and the sky LUTs live in bind group 0, which is
    // bound for the whole frame; declaring them here would make the graph
    // validator demand a producer even on tiers that switch them off.
    reads: [],
    stats,
    /**
     * Per-species baked emission, for render/passes/glow.js. See the field's
     * own docstring: `flux` is a radiant intensity per unit biolum radiance,
     * `radius` the emissive organ's radius of gyration in the rest pose.
     */
    speciesEmit,

    /**
     * The sim slots holding a MAX_CREATURE_LIGHTS point light this frame.
     *
     * The glow pass zeroes those emitters' aureoles, because sim/froxel_inject
     * already draws one for a submitted light and two would double it. It is
     * NOT the sprite cull list - eight slots gated at 90 m is a LIGHT budget,
     * and 300 Glimmerkrill in one frame produce exactly eight of them.
     */
    lightSlotSet() {
      lightSet.clear();
      for (let k = 0; k < lightCount; k++) lightSet.add(lightSlots[k]);
      return lightSet;
    },

    enabled() {
      return pipeline !== null && !!game.creatures && game.creatures.count > 0;
    },

    init(ctx) {
      if (meshLayout.arrayStride !== CREATURE_VERTEX_STRIDE) {
        throw new Error(
          `[creatures] vertex layout is ${meshLayout.arrayStride} bytes but ` +
          `CREATURE_VERTEX_STRIDE is ${CREATURE_VERTEX_STRIDE}. They have drifted apart.`);
      }

      device = ctx.device;
      buildMeshLibrary();

      instanceBuffer = createBuffer(device, {
        label: 'creature.instances',
        size: MAX_INSTANCES * CREATURE_INSTANCE_STRIDE,
        usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
      });
      // Two halves: current poses, then previous-frame poses. See the shader
      // header for why the previous pose has to be solved rather than inferred.
      boneBuffer = createBuffer(device, {
        label: 'creature.bones',
        size: 2 * MAX_INSTANCES * MAX_BONES * BONE_STRIDE,
        usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
      });
      skinParamBuffer = createBuffer(device, {
        label: 'creature.skinParams',
        size: 16,
        usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
      });
      stats.gpuBytes = stats.meshBytes + instanceBuffer.size + boneBuffer.size
        + restBoneBuffer.size + speciesBuffer.size;

      // GLOW_SIGMA_PX is the reconstruction filter's width, and both the sprite
      // pass and the fRes handover below have to be sized by the SAME number.
      const module = ctx.shaders.module('pass/creature.wgsl', {
        GLOW_SIGMA_PX: GLOW.SIGMA_PX.toFixed(3),
      }, 'creature');

      renderLayout = ctx.pipelines.bindGroupLayout('creature.render.bgl', [
        { binding: 0, visibility: STAGE.VF, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: STAGE.VF, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: STAGE.V, buffer: { type: 'read-only-storage' } },
      ]);
      // The COMPUTE view of group 1 deliberately omits `bones`: the kernel binds
      // the same buffer as read_write in group 2, and WebGPU forbids a writable
      // storage buffer from being aliased by any other binding in the same pass.
      computeLayout = ctx.pipelines.bindGroupLayout('creature.compute.bgl', [
        { binding: 0, visibility: STAGE.C, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: STAGE.C, buffer: { type: 'read-only-storage' } },
      ]);
      skinLayout = ctx.pipelines.bindGroupLayout('creature.skin.bgl', [
        { binding: 0, visibility: STAGE.C, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: STAGE.C, buffer: { type: 'storage' } },
        { binding: 2, visibility: STAGE.C, buffer: { type: 'uniform', minBindingSize: 16 } },
      ]);
      // The kernel touches no frame resources, but its bindings live in groups 1
      // and 2, so group 0 has to exist in the layout to reach them.
      emptyLayout = ctx.pipelines.bindGroupLayout('creature.empty.bgl', []);

      skinPipeline = ctx.pipelines.computePipeline({
        label: 'creature.skeleton',
        layout: ctx.pipelines.pipelineLayout('creature.skin.pl',
          [emptyLayout, computeLayout, skinLayout]),
        compute: { module, entryPoint: 'cs_creature_skeleton' },
      });

      const base = {
        label: 'creature',
        layout: ctx.pipelines.pipelineLayout('creature.pl',
          [renderer.frameLayout, renderLayout]),
        vertex: { module, entryPoint: 'vs_creature', buffers: [meshLayout] },
        fragment: {
          module,
          entryPoint: 'fs_creature',
          targets: [
            { format: FORMATS.hdr },
            { format: FORMATS.velocity },
            // The SSAO gate - see FragOut.gate in pass/creature.wgsl.
            { format: FORMATS.r8 },
          ],
        },
        depthStencil: DepthState.opaque(FORMATS.depth),
      };
      pipeline = ctx.pipelines.renderPipeline({ ...base, primitive: Primitive.triangles });
      pipelineNoCull = ctx.pipelines.renderPipeline({
        ...base, label: 'creature.twoSided', primitive: Primitive.trianglesNoCull,
      });

      emptyBindGroup = device.createBindGroup({
        label: 'creature.empty.bg', layout: emptyLayout, entries: [],
      });
      renderBindGroup = device.createBindGroup({
        label: 'creature.render.bg',
        layout: renderLayout,
        entries: [
          { binding: 0, resource: { buffer: instanceBuffer } },
          { binding: 1, resource: { buffer: speciesBuffer } },
          { binding: 2, resource: { buffer: boneBuffer } },
        ],
      });
      computeBindGroup = device.createBindGroup({
        label: 'creature.compute.bg',
        layout: computeLayout,
        entries: [
          { binding: 0, resource: { buffer: instanceBuffer } },
          { binding: 1, resource: { buffer: speciesBuffer } },
        ],
      });
      skinBindGroup = device.createBindGroup({
        label: 'creature.skin.bg',
        layout: skinLayout,
        entries: [
          { binding: 0, resource: { buffer: restBoneBuffer } },
          { binding: 1, resource: { buffer: boneBuffer } },
          { binding: 2, resource: { buffer: skinParamBuffer } },
        ],
      });
    },

    /**
     * Add the brightest bioluminescent creatures as real point lights.
     *
     * Called from the game loop alongside the vessel's lamps, after
     * renderer.clearLights(). A Lanterngape's esca picking a circle of rock out
     * of absolute dark is the pass's most valuable contribution to the deep, and
     * it costs at most eight of the 256 light slots.
     *
     * THE INTENSITY IS THE MESH'S OWN RADIANT INTENSITY, IN W/sr, AND NOTHING
     * ELSE. What this replaces was `6 * gain * max(bodyLength, 0.05)`, i.e.
     * 0.300 for a Glimmerkrill whose own emissive geometry makes 2.559e-5 W/sr:
     * 11,700x too bright, from a constant with no derivation behind it. Those
     * were the blown cyan aureoles in the deep - a light that large drives the
     * froxel volume, which drives auto-exposure, which then crushes everything
     * the animal was supposed to be lighting.
     *
     * `speciesEmit.flux` already integrates biolum radiance x emissive area x
     * SLOT_GLOW over the real mesh and divides by 4 (Cauchy: the mean projected
     * area of a convex body is a quarter of its surface area), so it is exactly
     * the intensity the geometry radiates. The three instance gains are
     * byte-for-byte pass/creature.wgsl's and render/passes/glow.js's, because a
     * point light, an emissive surface and a sprite that disagree about one
     * animal's brightness are three different animals.
     *
     * NO LURE MULTIPLIER. The 3.5x this used to apply to SPECIES_FLAG.LURE was a
     * gameplay knob on a physical quantity, and it is precisely the class of
     * fudge the flux bake exists to remove: neither the emissive surface nor the
     * sprite carries it, so it made the lure's light disagree with the lure. If
     * an esca should out-shine a Voltbarb's flanks - and by measurement it does
     * not, 6.725e-3 W/sr against 1.317 - the place to say so is the authored
     * biolum radiance in the bestiary, where all three consumers read it.
     *
     * @param {import('../renderer.js').Renderer} r
     */
    submitLights(r) {
      const sim = game.creatures;
      if (!sim || !r.addLight) { stats.lights = 0; return; }
      let added = 0;
      for (let k = 0; k < lightCount; k++) {
        const i = lightSlots[k];
        if (!sim.alive[i]) continue;
        const sp = sim.species[i];
        const f3 = sp * 3;

        const s = sim.scale[i];
        // The emissive AREA scales with the square of the instance scale, and
        // the flux was baked at scale 1.
        const depth = WORLD.SEA_LEVEL - sim.posY[i];
        const darkGain = 1 + 1.4 * smoothstep(60, 520, depth);
        const arousal = 1 + 1.6 * clamp(sim.fear[i] / 1.3, 0, 1);
        // The metabolic pulse is on the EMISSIVE SURFACE and on the sprite,
        // where it is visible as a beat. A cluster light is re-culled and
        // re-injected into the froxel volume every frame, so beating it there
        // would strobe a volume that is temporally reprojected; the light
        // carries the pulse's mean instead.
        const gain = s * s * darkGain * arousal
          * (speciesEmit.hz[sp] > 0 ? PULSE_MEAN : 1);

        const fr = speciesEmit.flux[f3] * gain;
        const fg = speciesEmit.flux[f3 + 1] * gain;
        const fb = speciesEmit.flux[f3 + 2] * gain;
        // colorIntensity is a colour times a scalar in the Light record, so the
        // per-channel intensity is split into a unit-peak hue and a magnitude.
        const peak = Math.max(fr, fg, fb);
        if (!(peak > 0)) continue;
        lightColor[0] = fr / peak;
        lightColor[1] = fg / peak;
        lightColor[2] = fb / peak;
        lightPos[0] = sim.posX[i];
        lightPos[1] = sim.posY[i];
        lightPos[2] = sim.posZ[i];
        r.addLight({
          position: lightPos,
          color: lightColor,
          intensity: peak,
          // A CULLING radius, not a brightness. punctualAttenuation()'s window
          // is (1-(r/R)^4)^2, which is 0.88 at R/2, so a range longer than the
          // light can be seen at is CLOSER to inverse square than a tight one -
          // it costs cluster occupancy and never adds light.
          range: clamp(4 + 14 * sim.bodyLength[i], 4, 45),
          type: 'point',
        });
        added++;
      }
      stats.lights = added;
    },

    execute(ctx, encoder) {
      if (!pipeline) return;
      const sim = game.creatures;
      if (!sim || sim.count === 0) return;
      const camera = ctx.camera;

      const count = packInstances(camera);
      stats.instances = count;
      stats.draws = 0;
      stats.triangles = 0;
      stats.boneThreads = 0;
      if (count === 0) return;

      ctx.device.queue.writeBuffer(instanceBuffer, 0, instanceData.buffer, 0,
        count * CREATURE_INSTANCE_STRIDE);
      skinParams[0] = count;
      skinParams[1] = MAX_INSTANCES * MAX_BONES;
      ctx.device.queue.writeBuffer(skinParamBuffer, 0, skinParams);

      // ---- skeleton solve ------------------------------------------------
      const threads = count * MAX_BONES;
      stats.boneThreads = threads;
      const cpass = encoder.beginComputePass(profiler.gpuPass({
        label: 'creature.skeleton',
      }, 'creature.skeleton'));
      cpass.setPipeline(skinPipeline);
      cpass.setBindGroup(0, emptyBindGroup);
      cpass.setBindGroup(1, computeBindGroup);
      cpass.setBindGroup(2, skinBindGroup);
      cpass.dispatchWorkgroups(Math.ceil(threads / SKIN_WORKGROUP));
      cpass.end();

      // ---- draw ----------------------------------------------------------
      const pass = encoder.beginRenderPass(profiler.gpuPass({
        label: 'creatures',
        colorAttachments: [
          colorAttachment(ctx.targets.view('sceneColor'), { loadOp: 'load' }),
          colorAttachment(ctx.targets.view('velocity'), { loadOp: 'load' }),
          colorAttachment(ctx.targets.view('aoGate'), { loadOp: 'load' }),
        ],
        depthStencilAttachment: depthAttachment(ctx.targets.view('sceneDepth'), { clear: false }),
      }, 'creatures'));

      pass.setBindGroup(GROUP.FRAME, ctx.frameBindGroup);
      pass.setBindGroup(GROUP.PASS, renderBindGroup);
      pass.setVertexBuffer(0, meshVertexBuffer);
      pass.setIndexBuffer(meshIndexBuffer, 'uint32');

      // Pipeline-outer so the two cull modes are two state changes for the whole
      // pass rather than two per species. The instance array is already sorted
      // by species, so each species is one contiguous run and one draw.
      let draws = 0;
      let triangles = 0;
      for (let cullPass = 0; cullPass < 2; cullPass++) {
        const wantTwoSided = cullPass === 1;
        let bound = false;
        let runStart = 0;
        while (runStart < count) {
          const sp = visibleSpecies[order[runStart]];
          let runEnd = runStart + 1;
          while (runEnd < count && visibleSpecies[order[runEnd]] === sp) runEnd++;
          const mesh = meshes[sp];
          if (mesh.twoSided === wantTwoSided) {
            if (!bound) {
              pass.setPipeline(wantTwoSided ? pipelineNoCull : pipeline);
              bound = true;
            }
            const instances = runEnd - runStart;
            pass.drawIndexed(mesh.indexCount, instances, mesh.firstIndex,
              mesh.baseVertex, runStart);
            draws++;
            triangles += mesh.triangles * instances;
          }
          runStart = runEnd;
        }
      }

      pass.end();
      stats.draws = draws;
      stats.triangles = triangles;
    },

    destroy() {
      meshVertexBuffer?.destroy();
      meshIndexBuffer?.destroy();
      instanceBuffer?.destroy();
      boneBuffer?.destroy();
      restBoneBuffer?.destroy();
      speciesBuffer?.destroy();
      skinParamBuffer?.destroy();
      meshVertexBuffer = null;
      meshIndexBuffer = null;
      instanceBuffer = null;
      boneBuffer = null;
      restBoneBuffer = null;
      speciesBuffer = null;
      skinParamBuffer = null;
      pipeline = null;
    },
  };
}

// Scratch for pursuitAngle(). Module scope so the encode loop allocates nothing.
const _targetScratch = new Float32Array(3);
const _fwdScratch = new Float32Array(3);
