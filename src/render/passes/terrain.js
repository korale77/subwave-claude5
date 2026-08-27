/**
 * SUBWAVE terrain pass.
 *
 * The first thing in the frame that touches the depth buffer, and the pass the
 * sky, the ocean surface and every volumetric composite behind it depend on for
 * a correct depth prepass-equivalent. It writes sceneColor (HDR radiance),
 * sceneDepth (reverse-Z) and velocity (motion vectors for TAA).
 *
 * ONE DRAW PER CHUNK. There is no instancing to be had here - every chunk has a
 * different mesh - so the cost is one setVertexBuffer, one setIndexBuffer, one
 * setBindGroup with a dynamic offset, and one drawIndexed. At the streaming
 * radius that is a few hundred draws after frustum culling, which is a
 * fraction of a millisecond of encode time and buys per-chunk culling that a
 * single merged buffer could not do at all.
 *
 * The per-draw uniform carries the chunk's origin ALREADY REBASED into
 * camera-relative space. Doing that on the CPU in f64 and shipping a small
 * number is the whole reason the vertex positions can be chunk-local f32: at
 * 3 km from the world origin an absolute f32 vertex has 0.25 mm of precision
 * left, and the wave-height and depth reconstruction downstream need better.
 */

import { colorAttachment, depthAttachment, DepthState, Primitive, vertexLayout, GROUP, STAGE }
  from '../../core/pipelines.js';
import { FORMATS } from '../../core/gpu.js';
import { profiler } from '../../core/profiler.js';
import { WORLD } from '../../core/constants.js';
import { VERTEX_STRIDE, lodStep, lodResolution } from '../../world/terrain.js';

/** Bytes in the per-draw ChunkUniform: two vec4f. */
const CHUNK_UNIFORM_BYTES = 32;

/** Shader-side size of the CaveMouths.discs array; see pass/terrain.wgsl. */
const MAX_MOUTH_DISCS = 16;
/** CaveMouths uniform: one count vec4 + MAX_MOUTH_DISCS disc vec4s. */
const MOUTH_UNIFORM_BYTES = 16 + MAX_MOUTH_DISCS * 16;

/**
 * Build the terrain frame-graph pass.
 *
 * @param {import('../renderer.js').Renderer} renderer
 * @param {import('../../world/chunks.js').ChunkManager} chunkManager
 * @param {import('../../world/cave_chunks.js').CaveChunkManager} [caveChunks]
 *   optional: when present, chunks whose footprint intersects a cave-mouth
 *   disc are drawn with the MASKED pipeline, which discards fragments inside
 *   the discs so the mouths the volumetric layer carved are actually open.
 *   Without it the pass behaves exactly as it always has.
 */
export function makeTerrainPass(renderer, chunkManager, caveChunks = null) {
  let pipeline = null;
  let maskedPipeline = null;
  let shadowPipeline = null;
  let chunkLayout = null;
  let maskedLayout = null;
  let chunkBindGroup = null;
  let maskedBindGroup = null;
  let mouthBuffer = null;
  let boundRing = null;
  const mouthData = new Float32Array(MOUTH_UNIFORM_BYTES / 4);
  /** Chunks routed to the masked pipeline this frame. Reused. */
  const maskedChunks = [];

  const layout = vertexLayout([
    [0, 'float32x3'],   // chunk-local xz, absolute y
    [1, 'float32x3'],   // normal
    [2, 'float32x2'],   // chunk uv
    [3, 'unorm8x4'],    // sqrt(albedo).rgb, roughness
    [4, 'unorm8x4'],    // sediment, rockiness, ao, blended macroStyle
  ]);

  // Same buffer, same stride, POSITION ONLY. A trimmed layout is legal and
  // fetches 12 bytes of the 40 instead of all of them, which matters when the
  // caster set is 2.5x the camera-visible triangle count. Written out rather
  // than built with vertexLayout(), which packs the stride to the attributes.
  const shadowLayout = {
    arrayStride: VERTEX_STRIDE,
    stepMode: 'vertex',
    attributes: [{ shaderLocation: 0, format: 'float32x3', offset: 0 }],
  };

  /** Per-cascade caster lists, rebuilt once a frame by beginShadowFrame(). */
  const casterLists = [];
  const shadowStats = { chunks: [0, 0, 0, 0], triangles: [0, 0, 0, 0], scanned: 0 };

  return {
    name: 'terrain',
    type: 'render',
    writes: ['sceneColor', 'sceneDepth', 'velocity', 'aoGate'],
    // Nothing is declared as read: the shadow atlas, caustics and sky LUTs this
    // pass samples all live in bind group 0, which every pass holds for the
    // whole frame. Declaring them here would make the graph validator demand a
    // producer even on tiers where those passes are switched off.
    reads: [],

    init(ctx) {
      if (layout.arrayStride !== VERTEX_STRIDE) {
        throw new Error(
          `[terrain] vertex layout is ${layout.arrayStride} bytes but terrain.js ` +
          `bakes ${VERTEX_STRIDE}. The mesher and the pipeline have drifted apart.`);
      }

      const module = ctx.shaders.module('pass/terrain.wgsl', {}, 'terrain');

      // One dynamically-offset uniform, reused by every draw. Building a bind
      // group per chunk would allocate a few hundred objects a frame for no
      // gain; the offset is the only thing that changes.
      chunkLayout = ctx.pipelines.bindGroupLayout('terrain.chunk.bgl', [{
        binding: 0,
        visibility: STAGE.VF,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: CHUNK_UNIFORM_BYTES },
      }]);

      pipeline = ctx.pipelines.renderPipeline({
        label: 'terrain',
        layout: ctx.pipelines.pipelineLayout('terrain.pl', [renderer.frameLayout, chunkLayout]),
        vertex: { module, entryPoint: 'vs_terrain', buffers: [layout] },
        fragment: {
          module,
          entryPoint: 'fs_terrain',
          targets: [
            { format: FORMATS.hdr },
            { format: FORMATS.velocity },
            // The SSAO gate - see FragOut.gate in pass/terrain.wgsl.
            { format: FORMATS.r8 },
          ],
        },
        // Back-face culling is what makes the chunk skirts free: they are only
        // ever seen from outside, and their winding is built for exactly that.
        primitive: Primitive.triangles,
        depthStencil: DepthState.opaque(FORMATS.depth),
      });

      // The MASKED variant: same shader with the CAVE_MOUTHS block compiled
      // in, plus the disc uniform at binding 1. A separate pipeline because
      // `discard` disables early-Z for every draw that shares it; typically
      // 0-4 chunks a frame take this path and the other hundreds keep theirs.
      if (caveChunks) {
        const maskedModule = ctx.shaders.module(
          'pass/terrain.wgsl', { CAVE_MOUTHS: 1 }, 'terrain.masked');
        maskedLayout = ctx.pipelines.bindGroupLayout('terrain.masked.bgl', [
          {
            binding: 0,
            visibility: STAGE.VF,
            buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: CHUNK_UNIFORM_BYTES },
          },
          {
            binding: 1,
            visibility: STAGE.F,
            buffer: { type: 'uniform', minBindingSize: MOUTH_UNIFORM_BYTES },
          },
        ]);
        maskedPipeline = ctx.pipelines.renderPipeline({
          label: 'terrain.masked',
          layout: ctx.pipelines.pipelineLayout('terrain.masked.pl',
            [renderer.frameLayout, maskedLayout]),
          vertex: { module: maskedModule, entryPoint: 'vs_terrain', buffers: [layout] },
          fragment: {
            module: maskedModule,
            entryPoint: 'fs_terrain',
            targets: [
              { format: FORMATS.hdr },
              { format: FORMATS.velocity },
              { format: FORMATS.r8 },
            ],
          },
          primitive: Primitive.triangles,
          depthStencil: DepthState.opaque(FORMATS.depth),
        });
        mouthBuffer = ctx.device.createBuffer({
          label: 'terrain.mouths',
          size: MOUTH_UNIFORM_BYTES,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
      }

      // Depth-only caster. NO FRAGMENT STAGE - nothing here alpha-tests, and
      // dropping it halves what the atlas costs. HARDWARE DEPTH BIAS IS ZERO on
      // purpose: shadow.wgsl owns the entire bias budget on the receiver side,
      // where it can scale with the cascade's own texel size, and a second bias
      // applied here is exactly how peter-panning ships.
      shadowPipeline = ctx.pipelines.renderPipeline({
        label: 'terrain.shadow',
        layout: ctx.pipelines.pipelineLayout('terrain.shadow.pl',
          [renderer.shadowCasterLayout, chunkLayout]),
        vertex: { module, entryPoint: 'vs_terrain_shadow', buffers: [shadowLayout] },
        primitive: Primitive.triangles,
        depthStencil: DepthState.shadow(FORMATS.shadow, 0, 0, 0),
      });
    },

    /** Per-cascade caster stats, for probe.mjs. */
    shadowStats,

    /**
     * Build this frame's per-cascade caster lists.
     *
     * ONE light-space projection per resident chunk, tested against all four
     * cascades - 3,293 chunks x (6 dot products + 24 compares), a few hundredths
     * of a millisecond, against 3,293 x 4 full projections if the test were done
     * inside castShadows().
     */
    beginShadowFrame(ctx, shadows) {
      for (let i = 0; i < shadows.count; i++) {
        if (casterLists[i] === undefined) casterLists[i] = [];
        casterLists[i].length = 0;
        shadowStats.chunks[i] = 0;
        shadowStats.triangles[i] = 0;
      }
      let scanned = 0;
      for (const chunk of chunkManager.chunks.values()) {
        if (!chunk.vertexBuffer) continue;
        scanned++;
        const b = chunk.aabb;
        // The AABB's minY is skirtMinY, so it already extends below the surface
        // this pass actually draws. Conservative is the right way round here: a
        // chunk admitted for nothing costs one draw, a chunk wrongly rejected
        // leaves a hole in the shadow.
        const p = shadows.projectBox(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ);
        for (let i = 0; i < shadows.count; i++) {
          if (!shadows.boxCasts(i, p)) continue;
          casterLists[i].push(chunk);
          shadowStats.chunks[i]++;
          shadowStats.triangles[i] += surfaceIndexCount(chunk.lod) / 3;
        }
      }
      shadowStats.scanned = scanned;
    },

    /**
     * Draw this pass's casters into cascade `cascade`.
     * @returns {number} draws issued
     */
    castShadows(ctx, pass, cascade, shadows) {
      if (!shadowPipeline) return 0;
      const list = casterLists[cascade];
      if (!list || list.length === 0) return 0;

      if (chunkBindGroup === null || boundRing !== ctx.uniforms.buffer) {
        boundRing = ctx.uniforms.buffer;
        chunkBindGroup = ctx.device.createBindGroup({
          label: 'terrain.chunk.bg',
          layout: chunkLayout,
          entries: [{
            binding: 0,
            resource: { buffer: boundRing, offset: 0, size: CHUNK_UNIFORM_BYTES },
          }],
        });
      }

      pass.setPipeline(shadowPipeline);
      pass.setBindGroup(GROUP.FRAME, renderer.shadowCasterGroup);

      const stride = ctx.uniforms.alignment;
      const block = ctx.uniforms.alloc(stride * list.length);
      const f = block.f32;
      const strideF = stride >> 2;
      const origin = ctx.camera.worldOrigin;

      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        const o = i * strideF;
        f[o] = c.originX - origin[0];
        f[o + 1] = 0;
        f[o + 2] = c.originZ - origin[2];
        f[o + 3] = WORLD.CHUNK_SIZE;
        f[o + 4] = c.lod;
        f[o + 5] = lodStep(c.lod);
        f[o + 6] = cascade;   // ChunkUniform.params.z, read by vs_terrain_shadow
        f[o + 7] = 0;

        _offsetScratch[0] = block.offset + i * stride;
        pass.setBindGroup(GROUP.PASS, chunkBindGroup, _offsetScratch);
        pass.setVertexBuffer(0, c.vertexBuffer, 0, c.vertexBytes);
        pass.setIndexBuffer(c.indexBuffer, 'uint16', 0, c.indexBytes);
        // SURFACE ONLY. The skirt is a vertical curtain up to 64 m deep hung
        // from every chunk boundary, wound so its sun-facing half presents FRONT
        // faces to the light and survives back-face culling. At a 25 degree sun
        // a 64 m curtain paints 137 m of shadow across the neighbouring chunk,
        // and skirtDepth is a function of LOD, so the stripe would pop as chunks
        // change ring. The mesher emits every surface index before every skirt
        // index, so the surface is a prefix and dropping the skirt is a shorter
        // draw. What leaks instead is a sub-texel sliver of light at an LOD
        // boundary crack, which the 1.7-texel normal offset and the 16-tap PCF
        // erase; a 137 m dark stripe they would not.
        pass.drawIndexed(surfaceIndexCount(c.lod));
      }
      return list.length;
    },

    execute(ctx, encoder) {
      if (!pipeline) return;

      const camera = ctx.camera;
      const chunks = chunkManager.visibleChunks(camera);
      if (chunks.length === 0) return;

      // The live cave-mouth discs. Zero discs (or no cave manager at all) is
      // the shipped pre-cave behaviour, draw for draw.
      const discs = maskedPipeline ? caveChunks.activeMouthDiscs(MAX_MOUTH_DISCS) : null;
      const discCount = discs ? (discs.length / 4) | 0 : 0;
      if (discCount > 0) {
        mouthData.fill(0);
        mouthData[0] = discCount;
        for (let i = 0; i < discCount * 4; i++) mouthData[4 + i] = discs[i];
        ctx.device.queue.writeBuffer(mouthBuffer, 0, mouthData);
      }

      // One bind group for the whole ring; only the dynamic offset moves. It is
      // rebuilt only if the ring buffer object itself was replaced.
      if (chunkBindGroup === null || boundRing !== ctx.uniforms.buffer) {
        boundRing = ctx.uniforms.buffer;
        chunkBindGroup = ctx.device.createBindGroup({
          label: 'terrain.chunk.bg',
          layout: chunkLayout,
          entries: [{
            binding: 0,
            resource: { buffer: boundRing, offset: 0, size: CHUNK_UNIFORM_BYTES },
          }],
        });
        maskedBindGroup = null;
      }
      if (maskedPipeline && maskedBindGroup === null) {
        maskedBindGroup = ctx.device.createBindGroup({
          label: 'terrain.masked.bg',
          layout: maskedLayout,
          entries: [
            { binding: 0, resource: { buffer: boundRing, offset: 0, size: CHUNK_UNIFORM_BYTES } },
            { binding: 1, resource: { buffer: mouthBuffer } },
          ],
        });
      }

      const pass = encoder.beginRenderPass(profiler.gpuPass({
        label: 'terrain',
        colorAttachments: [
          colorAttachment(ctx.targets.view('sceneColor'), { loadOp: 'load' }),
          colorAttachment(ctx.targets.view('velocity'), { loadOp: 'load' }),
          colorAttachment(ctx.targets.view('aoGate'), { loadOp: 'load' }),
        ],
        depthStencilAttachment: depthAttachment(ctx.targets.view('sceneDepth'), { clear: false }),
      }, 'terrain'));

      pass.setPipeline(pipeline);
      pass.setBindGroup(GROUP.FRAME, ctx.frameBindGroup);

      // ONE ring allocation for every chunk, sub-divided by hand at the dynamic
      // offset alignment. UniformRing.alloc() mints two typed-array views per
      // call, which is nothing for a pass with three draws and is sixteen
      // hundred short-lived objects a frame for a pass with eight hundred.
      // The base offset is already alignment-aligned, so base + i * stride is
      // too, which is exactly what setBindGroup demands.
      const stride = ctx.uniforms.alignment;
      const block = ctx.uniforms.alloc(stride * chunks.length);
      const f = block.f32;
      const strideF = stride >> 2;
      const origin = camera.worldOrigin;

      // Two batches off ONE uniform block: chunks touched by a mouth disc are
      // deferred and drawn with the masked pipeline after the plain batch, so
      // the pipeline switches exactly once however the sort interleaved them.
      // Depth testing makes the order change invisible.
      maskedChunks.length = 0;

      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const o = i * strideF;
        // A chunk is a column: it has no y origin. The vertex stream carries
        // ABSOLUTE height and the shader rebases it against frame.worldOrigin.y,
        // so this slot stays zero rather than duplicating that number.
        f[o] = c.originX - origin[0];
        f[o + 1] = 0;
        f[o + 2] = c.originZ - origin[2];
        f[o + 3] = WORLD.CHUNK_SIZE;
        f[o + 4] = c.lod;
        f[o + 5] = lodStep(c.lod);
        f[o + 6] = 0;
        f[o + 7] = 0;

        if (discCount > 0 && chunkTouchesDisc(c, discs, discCount)) {
          maskedChunks.push(c, block.offset + i * stride);
          continue;
        }
        _offsetScratch[0] = block.offset + i * stride;
        pass.setBindGroup(GROUP.PASS, chunkBindGroup, _offsetScratch);
        pass.setVertexBuffer(0, c.vertexBuffer, 0, c.vertexBytes);
        pass.setIndexBuffer(c.indexBuffer, 'uint16', 0, c.indexBytes);
        pass.drawIndexed(c.indexCount);
      }

      if (maskedChunks.length > 0) {
        pass.setPipeline(maskedPipeline);
        for (let i = 0; i < maskedChunks.length; i += 2) {
          const c = maskedChunks[i];
          _offsetScratch[0] = maskedChunks[i + 1];
          pass.setBindGroup(GROUP.PASS, maskedBindGroup, _offsetScratch);
          pass.setVertexBuffer(0, c.vertexBuffer, 0, c.vertexBytes);
          pass.setIndexBuffer(c.indexBuffer, 'uint16', 0, c.indexBytes);
          pass.drawIndexed(c.indexCount);
        }
      }
      pass.end();
    },
  };
}

/** Does the chunk's 128 m footprint intersect any live mouth disc in XZ? */
function chunkTouchesDisc(chunk, discs, discCount) {
  const x0 = chunk.originX, x1 = x0 + WORLD.CHUNK_SIZE;
  const z0 = chunk.originZ, z1 = z0 + WORLD.CHUNK_SIZE;
  for (let i = 0; i < discCount; i++) {
    const dx = Math.max(x0, Math.min(discs[i * 4], x1)) - discs[i * 4];
    const dz = Math.max(z0, Math.min(discs[i * 4 + 1], z1)) - discs[i * 4 + 1];
    const r = discs[i * 4 + 3];
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}

// setBindGroup takes an ARRAY of dynamic offsets; allocating a one-element
// array per draw would be a few hundred garbage objects every frame.
const _offsetScratch = [0];

/**
 * Indices belonging to a chunk's SURFACE, excluding the skirt.
 *
 * bakeChunk() writes `quads * 6` surface indices and then `perimeter * 6` skirt
 * indices, so the surface is a prefix of the index buffer and this is the whole
 * of what the shadow caster draws. At LOD 0 that is 98,304 of 101,376.
 */
function surfaceIndexCount(lod) {
  const quads = lodResolution(lod) - 1;
  return quads * quads * 6;
}
