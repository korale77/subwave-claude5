/**
 * SUBWAVE cave pass: draws the volumetric override's marched chunks.
 *
 * Scheduled immediately after the terrain pass (render/passes/index.js), into
 * the same four targets, with the same one-draw-per-chunk shape. The two
 * passes are two halves of ONE ground: the terrain pass draws the heightfield
 * with its fragments discarded inside the cave-mouth discs (its masked
 * pipeline), and this pass draws everything the volumetric field carved -
 * including the surface copy that backs those discs. See world/cave_mesh.js
 * for the cull that keeps the two from z-fighting, and CaveChunkManager for
 * the disc registry.
 *
 * NO SHADOW HALF, deliberately - and the exposure is REAL, not hypothetical.
 * Cave geometry neither casts into nor is expected in the CSM atlas. The P4
 * review enumerated every mouth in the playable disc at the default seed:
 * 23, of which TEN surface above SHADOW_UNDERWATER_CUTOFF (95 m), the
 * shallowest at 16.0 m on the reef - this header's first draft claimed all
 * mouths were below the cutoff and was wrong. At those ten, the shadow
 * caster still draws the roof the colour pass discards, so the open shaft
 * sits under a phantom-roof shadow and its walls take no real sun. Bounded:
 * a wrong shadow on a dark hole, not a hole in the image. The fix, when a
 * shallow mouth is judged to matter, is a caster-side discard mirroring the
 * colour pipeline's - see the backlog. Zero mouths surface above WATER at
 * this seed, but WORLD.CAVE_MAX_Y (120) admits land mouths in principle and
 * nothing guards them: that is a property of the seed, not of this code.
 */

import { colorAttachment, depthAttachment, DepthState, Primitive, vertexLayout, GROUP, STAGE }
  from '../../core/pipelines.js';
import { FORMATS } from '../../core/gpu.js';
import { profiler } from '../../core/profiler.js';
import { CAVE_VERTEX_STRIDE, SPAR_INSTANCE_STRIDE, SPAR_VARIANTS,
         CAVE_PROP_VARIANTS, CAVE_PROP_SPEL_BASE } from '../../world/cave_mesh.js';
import { buildMesh, MESH_DETAIL, MESH_MATERIAL } from '../../world/meshgen.js';
import { jellyShroomInstances } from '../../world/caves.js';
import { resolvedCaveSites } from '../../world/cave_sites.js';
import { RENDER } from '../../core/constants.js';

/** Bytes in the per-draw CaveChunkUniform: two vec4f. */
const CHUNK_UNIFORM_BYTES = 32;

/** Bytes per packed spar mesh vertex: pos f32x3, normal f32x3, colour unorm8x4. */
const SPAR_MESH_STRIDE = 28;

/**
 * The spar mesh variants: SPAR_VARIANTS seeds of the ONE registered
 * `crystalSpar` parameterisation (world/meshgen.js MESH_GENERATORS - the
 * 3.4 m / 6-facet calcite cluster test-meshgen actually measures; using other
 * heights here would be exactly the registry-drift CLAUDE.md documents on
 * `giantKelp`). Size variety comes from the bake's per-instance 0.25-1.0
 * scale, not from unregistered parameterisations.
 */
const SPAR_SEEDS = [0x5a11, 0x5a22, 0x5a33, 0x5a44];

/**
 * The authored-site prop library: CAVE_PROP_VARIANTS entries matching
 * world/cave_mesh.js's variant partition - two jellyshroom seeds, two
 * speleothem seeds, both REGISTERED parameterisations (the registry-drift rule
 * SPAR_SEEDS cites). Unlike the spar's colour-only stream, the prop packer
 * folds the per-vertex MATERIAL into the colour alpha as an emissive gate, so
 * fs_prop can make a cap glow and a stalk not without a second vertex stream.
 */
// `emitScale` scales the packed emissive gate per entry: the speleothems are
// hundreds against fourteen shrooms, and at gate parity they collectively
// out-shone the caps (first delivered frames - white spikes owning the
// exposure). Halving the crystals keeps the caps the scene's key.
const PROP_SPECS = [
  { name: 'jellyshroom', seed: 0x3e11, emitScale: 1.0 },
  { name: 'jellyshroom', seed: 0x3e77, emitScale: 1.0 },
  { name: 'jellySpeleothem', seed: 0x3ea1, emitScale: 0.5 },
  { name: 'jellySpeleothem', seed: 0x3eb3, emitScale: 0.5 },
];

/** Emissive gate packed into the prop library's colour alpha, by material. */
const PROP_EMISSIVE_GATE = {
  [MESH_MATERIAL.EMISSIVE]: 255,
  [MESH_MATERIAL.TRANSLUCENT]: 140,
  [MESH_MATERIAL.CRYSTAL]: 90,
};

const _offsetScratch = [0];

/**
 * Build the cave frame-graph pass.
 *
 * @param {import('../renderer.js').Renderer} renderer
 * @param {import('../../world/cave_chunks.js').CaveChunkManager} caveChunks
 */
export function makeCavesPass(renderer, caveChunks) {
  let pipeline = null;
  let chunkLayout = null;
  let chunkBindGroup = null;
  let boundRing = null;
  let sparPipeline = null;
  let sparVB = null;
  let sparIB = null;
  /** Per variant: {firstIndex, indexCount, baseVertex} into the merged mesh. */
  let sparRanges = null;
  let propPipeline = null;
  let propVB = null;
  let propIB = null;
  let propRanges = null;
  /** Cap-light source list, resolved lazily from the authored shroom set. */
  let shroomLights = null;

  const layout = vertexLayout([
    [0, 'float32x3'],   // chunk-local position
    [1, 'float32x3'],   // marched field normal
    [2, 'unorm8x4'],    // mouth weight, skylight, grotto weight, spare
  ]);

  // Spar draws: one shared mesh library, per-chunk instance buffer. The
  // instance layout mirrors SPAR_INSTANCE_STRIDE in world/cave_mesh.js.
  const sparMeshLayout = vertexLayout([
    [0, 'float32x3'],   // mesh-local position
    [1, 'float32x3'],   // facet normal
    [2, 'unorm8x4'],    // vertex colour
  ]);
  const sparInstanceLayout = vertexLayout([
    [3, 'float32x3'],   // lattice-origin-relative position
    [4, 'float32'],     // uniform scale
    [5, 'float32x3'],   // wall normal (instance +Y aligns to it)
    [6, 'float32'],     // yaw about that normal
  ], 'instance');

  /** Build and upload the merged spar mesh library. Runs once, in init(). */
  function buildSparLibrary(ctx) {
    if (sparMeshLayout.arrayStride !== SPAR_MESH_STRIDE ||
        sparInstanceLayout.arrayStride !== SPAR_INSTANCE_STRIDE) {
      throw new Error('[caves] spar vertex layouts drifted from their packers');
    }
    const meshes = SPAR_SEEDS.map((s) => buildMesh('crystalSpar', s, MESH_DETAIL.HIGH));
    let vTotal = 0, iTotal = 0;
    for (const m of meshes) { vTotal += m.vertexCount; iTotal += m.indexCount; }
    const vb = new ArrayBuffer(vTotal * SPAR_MESH_STRIDE);
    const vf = new Float32Array(vb);
    const vu = new Uint8Array(vb);
    const ib = new Uint32Array(iTotal);
    sparRanges = [];
    let vBase = 0, iBase = 0;
    for (const m of meshes) {
      for (let v = 0; v < m.vertexCount; v++) {
        const o = (vBase + v) * (SPAR_MESH_STRIDE >> 2);
        vf[o] = m.positions[v * 3];
        vf[o + 1] = m.positions[v * 3 + 1];
        vf[o + 2] = m.positions[v * 3 + 2];
        vf[o + 3] = m.normals[v * 3];
        vf[o + 4] = m.normals[v * 3 + 1];
        vf[o + 5] = m.normals[v * 3 + 2];
        const b = (vBase + v) * SPAR_MESH_STRIDE + 24;
        vu[b] = Math.min(255, Math.round(m.colors[v * 4] * 255));
        vu[b + 1] = Math.min(255, Math.round(m.colors[v * 4 + 1] * 255));
        vu[b + 2] = Math.min(255, Math.round(m.colors[v * 4 + 2] * 255));
        vu[b + 3] = 255;
      }
      ib.set(m.indices, iBase);
      sparRanges.push({ firstIndex: iBase, indexCount: m.indexCount, baseVertex: vBase });
      vBase += m.vertexCount;
      iBase += m.indexCount;
    }
    sparVB = ctx.device.createBuffer({
      label: 'caves.spar.vb', size: vb.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    ctx.device.queue.writeBuffer(sparVB, 0, vb);
    sparIB = ctx.device.createBuffer({
      label: 'caves.spar.ib', size: ib.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    ctx.device.queue.writeBuffer(sparIB, 0, ib);
  }

  /** Build and upload the merged prop mesh library. Runs once, in init(). */
  function buildPropLibrary(ctx) {
    const specs = PROP_SPECS;
    // The variant PARTITION is a cross-file convention: cave_mesh.js emits
    // shrooms into variants [0, CAVE_PROP_SPEL_BASE) and speleothems into
    // [CAVE_PROP_SPEL_BASE, CAVE_PROP_VARIANTS). A reordered or resized spec
    // list would draw shrooms with the crystal mesh and no test would fire -
    // this is the same drift class the stride assertions below guard.
    if (specs.length !== CAVE_PROP_VARIANTS ||
        specs[0].name !== 'jellyshroom' ||
        specs[CAVE_PROP_SPEL_BASE].name !== 'jellySpeleothem') {
      throw new Error('[caves] PROP_SPECS drifted from cave_mesh.js\'s variant partition');
    }
    const meshes = specs.map((p) => buildMesh(p.name, p.seed, MESH_DETAIL.HIGH));
    let vTotal = 0, iTotal = 0;
    for (const m of meshes) { vTotal += m.vertexCount; iTotal += m.indexCount; }
    const vb = new ArrayBuffer(vTotal * SPAR_MESH_STRIDE);
    const vf = new Float32Array(vb);
    const vu = new Uint8Array(vb);
    const ib = new Uint32Array(iTotal);
    propRanges = [];
    let vBase = 0, iBase = 0;
    for (let mi = 0; mi < meshes.length; mi++) {
      const m = meshes[mi];
      const emitScale = specs[mi].emitScale ?? 1;
      for (let v = 0; v < m.vertexCount; v++) {
        const o = (vBase + v) * (SPAR_MESH_STRIDE >> 2);
        vf[o] = m.positions[v * 3];
        vf[o + 1] = m.positions[v * 3 + 1];
        vf[o + 2] = m.positions[v * 3 + 2];
        vf[o + 3] = m.normals[v * 3];
        vf[o + 4] = m.normals[v * 3 + 1];
        vf[o + 5] = m.normals[v * 3 + 2];
        const b = (vBase + v) * SPAR_MESH_STRIDE + 24;
        vu[b] = Math.min(255, Math.round(m.colors[v * 4] * 255));
        vu[b + 1] = Math.min(255, Math.round(m.colors[v * 4 + 1] * 255));
        vu[b + 2] = Math.min(255, Math.round(m.colors[v * 4 + 2] * 255));
        vu[b + 3] = Math.round((PROP_EMISSIVE_GATE[m.materials[v]] ?? 0) * emitScale);
      }
      ib.set(m.indices, iBase);
      propRanges.push({ firstIndex: iBase, indexCount: m.indexCount, baseVertex: vBase });
      vBase += m.vertexCount;
      iBase += m.indexCount;
    }
    propVB = ctx.device.createBuffer({
      label: 'caves.prop.vb', size: vb.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    ctx.device.queue.writeBuffer(propVB, 0, vb);
    propIB = ctx.device.createBuffer({
      label: 'caves.prop.ib', size: ib.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    ctx.device.queue.writeBuffer(propIB, 0, ib);
  }

  /**
   * The jellyshroom caps as punctual lights. Registered with
   * renderer.addLightSubmitter() - the ONE point that is after the loop's
   * entity submitters, before _uploadLights(), and on the right side of
   * camera.update() (see the hook's own docstring). The source list is
   * caves.js jellyShroomInstances - the SAME records the bake seats the
   * geometry from - so a cap and its light cannot separate.
   *
   * The caps are the chamber's key light and the reason the reference's
   * purple reads: emissive surfaces composite but illuminate nothing, and a
   * 16 m glowing dome that lit no rock would read as a sticker. volumetric: 1
   * puts them in the froxel volume, which the cave enclosure drain
   * deliberately spares - so the water around the caps glows too.
   *
   * RENDER.JELLY_LIGHT_INTENSITY = 0 is the whole-feature bisect.
   */
  function submitJellyLights(r) {
    const gain = RENDER.JELLY_LIGHT_INTENSITY ?? 0;
    if (!(gain > 0)) return;
    if (!shroomLights) {
      shroomLights = jellyShroomInstances()
        .filter((s) => s.height >= (RENDER.JELLY_LIGHT_MIN_HEIGHT ?? 6))
        .map((s) => ({
          // The cap centroid, not the base: light comes from the dome.
          pos: [s.x, s.y + s.height * 0.86, s.z],
          scale2: s.scale * s.scale,
        }));
      // One dim throat light per site, a few metres down the mouth shaft, so
      // the entrance leaks violet into the open water and the hole reads as
      // an INHABITED hole from outside - the reference caves' tell. Weighted
      // like a quarter-size shroom; volumetric, so the froxel carries the
      // glow up through the shaft.
      for (const r of resolvedCaveSites()) {
        shroomLights.push({
          // Ten metres up the shaft from the corridor start, i.e. ~10 m
          // below the rim: deep enough that the source itself stays hidden,
          // high enough that its pool reaches the funnel walls. NOT
          // volumetric: the froxel injection has no rock-occlusion test, and
          // this light sits under the seabed - its halo bled through the
          // terrain as a free-floating violet bloom in the open water
          // (photographed on the first throat-light arrival frame). The
          // surface pool it paints on the shaft walls is the whole effect.
          pos: [r.mouth.x, r.mouth.y + 10, r.mouth.z],
          scale2: 0.7,
          vol: 0,
        });
      }
    }
    if (shroomLights.length === 0) return;
    const cam = r.camera.position;
    const maxN = RENDER.JELLY_LIGHT_MAX ?? 8;
    const color = RENDER.JELLY_LIGHT_COLOR ?? [1.0, 0.32, 0.88];
    // Nearest-N by distance, but only when the camera is anywhere near the
    // site - the common case is one early-out on the first distance test.
    const near = [];
    for (const s of shroomLights) {
      const dx = s.pos[0] - cam[0], dy = s.pos[1] - cam[1], dz = s.pos[2] - cam[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 220 * 220) near.push({ s, d2 });
    }
    if (near.length === 0) return;
    near.sort((a, b) => a.d2 - b.d2);
    for (let i = 0; i < Math.min(maxN, near.length); i++) {
      const s = near[i].s;
      const intensity = gain * s.scale2;
      r.addLight({
        position: s.pos,
        color,
        intensity,
        // Same cutoff-derived range law the scatter lights use.
        range: Math.min(60, Math.sqrt(intensity / 1.13e-2)),
        type: 'point',
        volumetric: s.vol ?? 1,
      });
    }
  }

  return {
    name: 'caves',
    type: 'render',
    writes: ['sceneColor', 'sceneDepth', 'velocity', 'aoGate'],
    reads: [],

    init(ctx) {
      if (layout.arrayStride !== CAVE_VERTEX_STRIDE) {
        throw new Error(
          `[caves] vertex layout is ${layout.arrayStride} bytes but cave_mesh.js ` +
          `packs ${CAVE_VERTEX_STRIDE}. The baker and the pipeline have drifted apart.`);
      }
      const module = ctx.shaders.module('pass/cave.wgsl', {}, 'cave');
      chunkLayout = ctx.pipelines.bindGroupLayout('caves.chunk.bgl', [{
        binding: 0,
        visibility: STAGE.VF,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: CHUNK_UNIFORM_BYTES },
      }]);
      pipeline = ctx.pipelines.renderPipeline({
        label: 'caves',
        layout: ctx.pipelines.pipelineLayout('caves.pl', [renderer.frameLayout, chunkLayout]),
        vertex: { module, entryPoint: 'vs_cave', buffers: [layout] },
        fragment: {
          module,
          entryPoint: 'fs_cave',
          targets: [
            { format: FORMATS.hdr },
            { format: FORMATS.velocity },
            { format: FORMATS.r8 },
          ],
        },
        // Back-face culled: marching cubes winds every triangle out of the
        // rock, so a cave interior presents front faces to an eye inside it
        // and the kept seabed copy presents front faces to an eye above it.
        primitive: Primitive.triangles,
        depthStencil: DepthState.opaque(FORMATS.depth),
      });

      // The geode spar: same targets, same chunk uniform (the instances are
      // packed relative to the same lattice origin), its own mesh library.
      buildSparLibrary(ctx);
      sparPipeline = ctx.pipelines.renderPipeline({
        label: 'caves.spar',
        layout: ctx.pipelines.pipelineLayout('caves.pl', [renderer.frameLayout, chunkLayout]),
        vertex: { module, entryPoint: 'vs_spar', buffers: [sparMeshLayout, sparInstanceLayout] },
        fragment: {
          module,
          entryPoint: 'fs_spar',
          targets: [
            { format: FORMATS.hdr },
            { format: FORMATS.velocity },
            { format: FORMATS.r8 },
          ],
        },
        primitive: Primitive.triangles,
        depthStencil: DepthState.opaque(FORMATS.depth),
      });

      // The authored-site props: same instance basis as the spar (vs_spar),
      // their own fragment path (fs_prop) and mesh library.
      buildPropLibrary(ctx);
      propPipeline = ctx.pipelines.renderPipeline({
        label: 'caves.prop',
        layout: ctx.pipelines.pipelineLayout('caves.pl', [renderer.frameLayout, chunkLayout]),
        vertex: { module, entryPoint: 'vs_spar', buffers: [sparMeshLayout, sparInstanceLayout] },
        fragment: {
          module,
          entryPoint: 'fs_prop',
          targets: [
            { format: FORMATS.hdr },
            { format: FORMATS.velocity },
            { format: FORMATS.r8 },
          ],
        },
        primitive: Primitive.triangles,
        depthStencil: DepthState.opaque(FORMATS.depth),
      });

      renderer.addLightSubmitter(submitJellyLights);
    },

    execute(ctx, encoder) {
      if (!pipeline) return;
      const chunks = caveChunks.visibleChunks(ctx.camera);
      if (chunks.length === 0) return;

      if (chunkBindGroup === null || boundRing !== ctx.uniforms.buffer) {
        boundRing = ctx.uniforms.buffer;
        chunkBindGroup = ctx.device.createBindGroup({
          label: 'caves.chunk.bg',
          layout: chunkLayout,
          entries: [{
            binding: 0,
            resource: { buffer: boundRing, offset: 0, size: CHUNK_UNIFORM_BYTES },
          }],
        });
      }

      const pass = encoder.beginRenderPass(profiler.gpuPass({
        label: 'caves',
        colorAttachments: [
          colorAttachment(ctx.targets.view('sceneColor'), { loadOp: 'load' }),
          colorAttachment(ctx.targets.view('velocity'), { loadOp: 'load' }),
          colorAttachment(ctx.targets.view('aoGate'), { loadOp: 'load' }),
        ],
        depthStencilAttachment: depthAttachment(ctx.targets.view('sceneDepth'), { clear: false }),
      }, 'caves'));

      pass.setPipeline(pipeline);
      pass.setBindGroup(GROUP.FRAME, ctx.frameBindGroup);

      const stride = ctx.uniforms.alignment;
      const block = ctx.uniforms.alloc(stride * chunks.length);
      const f = block.f32;
      const strideF = stride >> 2;
      const origin = ctx.camera.worldOrigin;

      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const o = i * strideF;
        // Full 3-D rebase in f64 on the CPU; unlike terrain chunks a cave
        // chunk has a real Y origin, so all three axes ship camera-relative.
        f[o] = c.originX - origin[0];
        f[o + 1] = c.originY - origin[1];
        f[o + 2] = c.originZ - origin[2];
        f[o + 3] = 0;
        f[o + 4] = 0;
        f[o + 5] = 0;
        f[o + 6] = 0;
        f[o + 7] = 0;

        _offsetScratch[0] = block.offset + i * stride;
        pass.setBindGroup(GROUP.PASS, chunkBindGroup, _offsetScratch);
        pass.setVertexBuffer(0, c.vertexBuffer, 0, c.vertexBytes);
        pass.setIndexBuffer(c.indexBuffer, 'uint32', 0, c.indexBytes);
        pass.drawIndexed(c.indexCount);
      }

      // Geode spar, second loop so the pipeline switches once, not per chunk.
      // Instances were sorted by variant at bake time, so each variant is one
      // contiguous instanced range addressed with firstInstance.
      if (sparPipeline) {
        let bound = false;
        for (let i = 0; i < chunks.length; i++) {
          const c = chunks[i];
          if (!(c.sparCount > 0) || !c.sparBuffer || !c.sparCounts) continue;
          if (!bound) {
            pass.setPipeline(sparPipeline);
            pass.setVertexBuffer(0, sparVB);
            pass.setIndexBuffer(sparIB, 'uint32');
            bound = true;
          }
          _offsetScratch[0] = block.offset + i * stride;
          pass.setBindGroup(GROUP.PASS, chunkBindGroup, _offsetScratch);
          pass.setVertexBuffer(1, c.sparBuffer, 0, c.sparBytes);
          let first = 0;
          for (let v = 0; v < SPAR_VARIANTS; v++) {
            const n = c.sparCounts[v];
            if (n > 0) {
              const r = sparRanges[v];
              pass.drawIndexed(r.indexCount, n, r.firstIndex, r.baseVertex, first);
            }
            first += n;
          }
        }
      }

      // Authored-site props, same shape as the spar loop: one pipeline switch,
      // one contiguous instanced range per variant.
      if (propPipeline) {
        let bound = false;
        for (let i = 0; i < chunks.length; i++) {
          const c = chunks[i];
          if (!(c.propCount > 0) || !c.propBuffer || !c.propCounts) continue;
          if (!bound) {
            pass.setPipeline(propPipeline);
            pass.setVertexBuffer(0, propVB);
            pass.setIndexBuffer(propIB, 'uint32');
            bound = true;
          }
          _offsetScratch[0] = block.offset + i * stride;
          pass.setBindGroup(GROUP.PASS, chunkBindGroup, _offsetScratch);
          pass.setVertexBuffer(1, c.propBuffer, 0, c.propBytes);
          let first = 0;
          for (let v = 0; v < CAVE_PROP_VARIANTS; v++) {
            const n = c.propCounts[v];
            if (n > 0) {
              const r = propRanges[v];
              pass.drawIndexed(r.indexCount, n, r.firstIndex, r.baseVertex, first);
            }
            first += n;
          }
        }
      }
      pass.end();
    },
  };
}
