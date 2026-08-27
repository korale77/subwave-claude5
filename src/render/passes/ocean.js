/**
 * SUBWAVE ocean surface pass.
 *
 * Builds and draws the camera-centred clipmap. The justification for a clipmap
 * over a projected grid is at the top of pass/ocean_surface.wgsl.
 *
 * TWO RENDER PASSES, ONE MESH, AND THE REASON IS NOT PERFORMANCE:
 *
 *   The water fragment shader has to SAMPLE sceneDepth - to reject refraction
 *   samples that lie in front of the surface, to measure the water column for
 *   the shallow-water ramp, and to drive the shoreline surf band. A texture
 *   cannot be a writable depth attachment and a sampled binding in the same
 *   pass. So the clipmap is rasterised twice: first depth-only, writing
 *   sceneDepth; then shaded with the depth attachment marked read-only and a
 *   'greater-equal' test, which admits exactly the fragments the first pass
 *   kept. `@invariant` on the vertex position guarantees the two passes agree
 *   bit-for-bit, which is what makes the equality test safe.
 *
 * Vertex cost is paid twice, but the prepass has no fragment stage at all and
 * the clipmap is ~90k triangles after culling, so it is cheap next to what
 * depth-aware refraction buys.
 */

import { profiler } from '../../core/profiler.js';
import {
  colorAttachment, depthAttachment, DepthState, Primitive, vertexLayout, STAGE,
} from '../../core/pipelines.js';
import { FORMATS } from '../../core/gpu.js';
import {
  createVertexBuffer, createIndexBuffer, DynamicBuffer, BufferUsage,
} from '../../core/resources.js';
import { OCEAN, TRUE_DARK_DEPTH } from '../../core/constants.js';

/** Cells along one edge of a clipmap block. Four blocks span a level. */
export const OCEAN_BLOCK_CELLS = OCEAN.CLIPMAP_RESOLUTION / 4;

/**
 * Cell size of the innermost level, metres. 0.5 m resolves the 8 m ripple
 * cascade at better than Nyquist right where the camera lives, which is what
 * keeps the waterline from looking faceted when you are floating in it.
 */
export const OCEAN_BASE_CELL = 0.5;

/** Outer radius of the horizon annulus, metres. Well past any real sightline. */
const HORIZON_RADIUS = 60000;

/**
 * Grid the whole clipmap is snapped to, metres. ONE snap for EVERY level, and
 * that is not the textbook choice - a geometry clipmap normally snaps level L
 * to two of its own cells. Here it must not, because every level is exactly as
 * wide as the hole it fills in its parent: floor(x/2c) and floor(x/4c) differ by
 * 2c half the time, so per-level snapping slides a level off the hole it is
 * covering and leaves a strip two cells wide with no geometry in it at all -
 * a crack you can see the sky through, at every ring boundary, half the time.
 *
 * A single snap makes every level concentric, so each hole IS its child's
 * footprint. The cost is that levels above the first re-snap every 1 m instead
 * of every 2 of their own cells; their vertices then shift within a lattice
 * whose displacement is mip-filtered to the vertex spacing, so the surface they
 * reconstruct changes by ~1 cm at 64 m and less further out. A visible crack is
 * not a trade against a centimetre.
 */
export const OCEAN_CLIPMAP_SNAP = 2 * OCEAN_BASE_CELL;

/**
 * Fraction of a level's coverage radius over which CDLOD morphing happens.
 *
 * MORPH_END must leave room for the snap: the camera sits up to OCEAN_CLIPMAP_SNAP
 * from the clipmap centre, so the nearest point of a level's outer boundary is
 * at radius - OCEAN_CLIPMAP_SNAP, and the morph has to have reached 1 by then or the
 * fine level does not meet the coarse lattice and the seam cracks. The tightest
 * ratio is level 0's, OCEAN_CLIPMAP_SNAP / (2 * BLOCK_CELLS * BASE_CELL) = 1/32.
 */
export const OCEAN_MORPH_START = 0.72;
export const OCEAN_MORPH_END = 0.96;

/** 16 blocks at level 0, 12 per ring above it, plus one horizon annulus. */
const MAX_INSTANCES = 16 + (OCEAN.CLIPMAP_RINGS - 1) * 12 + 1;

/**
 * @param {import('../../sim/ocean.js').OceanSim} sim
 * @param {import('../../sim/sky.js').SkySystem} sky its uniform is bound at
 *   group 2 so the reflected sky is looked up through the atmosphere model's
 *   own LUT parameterisation rather than a copy of it.
 * @returns {object} a frame-graph pass
 */
export function createOceanSurfacePass(sim, sky) {
  let vertexBuffer = null;
  let indexBuffer = null;
  let indexCount = 0;
  let instances = null;
  let geomLayout = null;
  let shadeLayout = null;
  let skyLayout = null;
  let geomGroup = null;
  let skyGroup = null;
  let shadeGroups = [null, null];
  let depthPipeline = null;
  let shadePipeline = null;

  return {
    name: 'oceanSurface',
    type: 'render',
    reads: ['sceneOpaque', 'sceneDepthOpaque'],
    writes: ['sceneColor', 'sceneDepth', 'velocity'],

    enabled(ctx) {
      return !!shadePipeline && ctx.camera != null;
    },

    init(ctx) {
      buildGeometry(ctx);
      instances = new DynamicBuffer(ctx.device, {
        label: 'ocean-blocks',
        usage: BufferUsage.STORAGE,
        capacity: MAX_INSTANCES,
        stride: 8,
      });

      const module = ctx.shaders.module('pass/ocean_surface.wgsl', {
        OCEAN_BLOCK_CELLS,
        OCEAN_GERSTNER: sim.gerstnerOnly ? 1 : 0,
        OCEAN_CASCADES: sim.cascadeCount,
        TRUE_DARK_DEPTH: TRUE_DARK_DEPTH.toFixed(1),
      }, 'ocean-surface');

      // The depth prepass touches only the uniform, the displacement cascades
      // and the instance list - deliberately NOT sceneDepth, which it writes.
      geomLayout = ctx.pipelines.bindGroupLayout('ocean.geom.bgl', [
        { binding: 0, visibility: STAGE.VF, buffer: { type: 'uniform' } },
        { binding: 1, visibility: STAGE.V, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 6, visibility: STAGE.V, buffer: { type: 'read-only-storage' } },
      ]);
      shadeLayout = ctx.pipelines.bindGroupLayout('ocean.shade.bgl', [
        { binding: 0, visibility: STAGE.VF, buffer: { type: 'uniform' } },
        { binding: 1, visibility: STAGE.V, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 2, visibility: STAGE.F, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 3, visibility: STAGE.F, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 4, visibility: STAGE.F, texture: { sampleType: 'float' } },
        { binding: 5, visibility: STAGE.F, texture: { sampleType: 'depth' } },
        { binding: 6, visibility: STAGE.V, buffer: { type: 'read-only-storage' } },
        // A sampler of the ocean's OWN, because the shared frame.linearSampler
        // has maxAnisotropy 1 and terrain and clouds depend on it staying that
        // way. The sea is the one surface in the frame whose screen footprint is
        // routinely 100:1 elongated - see the note on `oceanAniso` in
        // pass/ocean_surface.wgsl for the measurement.
        { binding: 7, visibility: STAGE.F, sampler: { type: 'filtering' } },
      ]);
      // Bindings 1-3 are the atmosphere model's own LUT contract (see the
      // SKY_HAS_LUTS / SKY_HAS_MULTISCATTER blocks in common/atmosphere.wgsl).
      // Binding them here is what lets the water call aerialPerspective() -
      // the SAME function the sky pass applies to the terrain. The sky pass
      // runs BEFORE the ocean, so the distant sea would otherwise be the one
      // surface in the frame with no atmosphere in front of it, and it meets
      // the hazed sky at a hard line.
      skyLayout = ctx.pipelines.bindGroupLayout('ocean.sky.bgl', [
        { binding: 0, visibility: STAGE.F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: STAGE.F, sampler: { type: 'filtering' } },
        { binding: 2, visibility: STAGE.F, texture: { sampleType: 'float' } },
        { binding: 3, visibility: STAGE.F, texture: { sampleType: 'float' } },
      ]);
      skyGroup = ctx.device.createBindGroup({
        label: 'ocean.sky.bg',
        layout: skyLayout,
        entries: [
          { binding: 0, resource: { buffer: sky.uniformBuffer } },
          { binding: 1, resource: ctx.samplers.linearClamp },
          { binding: 2, resource: ctx.targets.view('transmittanceLUT') },
          { binding: 3, resource: sky.multiScatterView },
        ],
      });

      const frameLayout = ctx.renderer.frameLayout;
      const layouts = [
        vertexLayout([[0, 'float32x2']]),
      ];

      depthPipeline = ctx.pipelines.renderPipeline({
        label: 'ocean.depth',
        layout: ctx.pipelines.pipelineLayout('ocean.depth.pl', [frameLayout, geomLayout]),
        vertex: { module, entryPoint: 'vs_ocean', buffers: layouts },
        // Both faces write depth: the surface is legitimately visible from
        // underneath, and culling here would punch a hole in the ceiling.
        primitive: Primitive.trianglesNoCull,
        depthStencil: DepthState.opaque(FORMATS.depth),
      });

      shadePipeline = ctx.pipelines.renderPipeline({
        label: 'ocean.shade',
        layout: ctx.pipelines.pipelineLayout('ocean.shade.pl', [frameLayout, shadeLayout, skyLayout]),
        vertex: { module, entryPoint: 'vs_ocean', buffers: layouts },
        fragment: {
          module, entryPoint: 'fs_ocean',
          targets: [
            { format: FORMATS.hdr },
            { format: FORMATS.velocity },
          ],
        },
        primitive: Primitive.trianglesNoCull,
        depthStencil: DepthState.testNoWriteInclusive(FORMATS.depth),
      });

      rebuildBindGroups(ctx);
    },

    resize(ctx) {
      rebuildBindGroups(ctx);
    },

    execute(ctx, encoder) {
      const count = buildInstances(ctx);
      if (count === 0) return;

      instances.count = count;
      instances.upload();

      const depthView = ctx.targets.view('sceneDepth');

      const pre = encoder.beginRenderPass(profiler.gpuPass({
        label: 'ocean.depth',
        colorAttachments: [],
        depthStencilAttachment: depthAttachment(depthView, { clear: false }),
      }, 'ocean.depth'));
      pre.setPipeline(depthPipeline);
      pre.setBindGroup(0, ctx.frameBindGroup);
      pre.setBindGroup(1, geomGroup);
      pre.setVertexBuffer(0, vertexBuffer);
      pre.setIndexBuffer(indexBuffer, 'uint32');
      pre.drawIndexed(indexCount, count);
      pre.end();

      const shade = encoder.beginRenderPass(profiler.gpuPass({
        label: 'ocean.shade',
        colorAttachments: [
          colorAttachment(ctx.targets.view('sceneColor'), { loadOp: 'load' }),
          // Loaded, not cleared: everything the terrain and the entities wrote
          // outside the water has to survive this pass.
          colorAttachment(ctx.targets.view('velocity'), { loadOp: 'load' }),
        ],
        depthStencilAttachment: depthAttachment(depthView, { readOnly: true }),
      }, 'ocean.shade'));
      shade.setPipeline(shadePipeline);
      shade.setBindGroup(0, ctx.frameBindGroup);
      shade.setBindGroup(1, shadeGroups[sim.foamParity]);
      shade.setBindGroup(2, skyGroup);
      shade.setVertexBuffer(0, vertexBuffer);
      shade.setIndexBuffer(indexBuffer, 'uint32');
      shade.drawIndexed(indexCount, count);
      shade.end();
    },

    destroy() {
      vertexBuffer?.destroy();
      indexBuffer?.destroy();
      instances?.destroy();
    },
  };

  // -------------------------------------------------------------------------

  function buildGeometry(ctx) {
    const B = OCEAN_BLOCK_CELLS;
    const side = B + 1;
    const verts = new Float32Array(side * side * 2);
    for (let j = 0, o = 0; j < side; j++) {
      for (let i = 0; i < side; i++, o += 2) {
        verts[o] = i;
        verts[o + 1] = j;
      }
    }
    // Wound so the face normal is +Y when the grid is read as (x, z): the
    // surface is drawn with culling off, but a consistent winding keeps
    // front_facing meaningful for anything that later wants it.
    const idx = new Uint32Array(B * B * 6);
    let k = 0;
    for (let j = 0; j < B; j++) {
      for (let i = 0; i < B; i++) {
        const a = j * side + i;
        const b = a + side;
        idx[k++] = a; idx[k++] = b; idx[k++] = a + 1;
        idx[k++] = a + 1; idx[k++] = b; idx[k++] = b + 1;
      }
    }
    indexCount = idx.length;
    vertexBuffer = createVertexBuffer(ctx.device, verts, 'ocean-clipmap-vb');
    indexBuffer = createIndexBuffer(ctx.device, idx, 'ocean-clipmap-ib');
  }

  function rebuildBindGroups(ctx) {
    if (!geomLayout || !instances) return;
    const device = ctx.device;
    geomGroup = device.createBindGroup({
      label: 'ocean.geom.bg',
      layout: geomLayout,
      entries: [
        { binding: 0, resource: { buffer: sim.uniformBuffer } },
        { binding: 1, resource: sim.displacementView },
        { binding: 6, resource: { buffer: instances.gpu } },
      ],
    });
    for (let parity = 0; parity < 2; parity++) {
      shadeGroups[parity] = device.createBindGroup({
        label: `ocean.shade.bg${parity}`,
        layout: shadeLayout,
        entries: [
          { binding: 0, resource: { buffer: sim.uniformBuffer } },
          { binding: 1, resource: sim.displacementView },
          { binding: 2, resource: sim.derivativeView },
          { binding: 3, resource: sim.foamViewFor(parity) },
          { binding: 4, resource: ctx.targets.view('sceneOpaque') },
          // The PRE-ocean depth snapshot, not sceneDepth: our own prepass has
          // already overwritten sceneDepth with the water surface by the time
          // this group is used, and a water column measured against the water
          // is identically zero.
          { binding: 5, resource: ctx.targets.view('sceneDepthOpaque') },
          { binding: 6, resource: { buffer: instances.gpu } },
          // 8, not 16. Both restore crest structure right up to the horizon and
          // the two crops are indistinguishable at 6x; the cost is not. Measured
          // on the headless profiler with terrain as the yardstick, ocean.shade
          // went 0.263 -> 0.291 -> 0.381 of terrain's time at maxAnisotropy
          // 1 -> 8 -> 16, so 16 buys nothing visible for four times the extra.
          { binding: 7, resource: ctx.samplers.aniso(8) },
        ],
      });
    }
  }

  /**
   * Rebuild the visible block list, straight into the instance buffer's staging
   * array - a per-frame scratch copy would allocate a view every frame for no
   * benefit.
   *
   * Every level shares one snapped centre (see OCEAN_CLIPMAP_SNAP), so each level's
   * footprint is EXACTLY the hole its parent leaves, and a vertex that has
   * morphed onto its even lattice lands on the parent's lattice to the bit.
   * Those two facts are the whole crack-free guarantee.
   */
  function buildInstances(ctx) {
    const cam = ctx.camera;
    const data = instances.cpu;
    const B = OCEAN_BLOCK_CELLS;
    const levels = OCEAN.CLIPMAP_RINGS;
    // Displacement can carry a vertex outside its own block, so the cull box
    // has to be grown by the worst-case excursion or blocks pop at the edge.
    const vBound = sim.verticalBound;
    const hBound = vBound * OCEAN.CHOPPINESS + 1.0;
    const cx = Math.floor(cam.position[0] / OCEAN_CLIPMAP_SNAP) * OCEAN_CLIPMAP_SNAP;
    const cz = Math.floor(cam.position[2] / OCEAN_CLIPMAP_SNAP) * OCEAN_CLIPMAP_SNAP;
    let n = 0;

    for (let level = 0; level < levels; level++) {
      const cell = OCEAN_BASE_CELL * Math.pow(2, level);
      const extent = B * cell;
      const radius = 2 * extent;

      for (let bz = 0; bz < 4; bz++) {
        for (let bx = 0; bx < 4; bx++) {
          // Levels above 0 are rings: the inner 2x2 is the previous level.
          if (level > 0 && bx >= 1 && bx <= 2 && bz >= 1 && bz <= 2) continue;
          const ox = cx + (bx - 2) * extent;
          const oz = cz + (bz - 2) * extent;
          if (!cam.isBoxVisible(
            ox - hBound, -vBound, oz - hBound,
            ox + extent + hBound, vBound, oz + extent + hBound)) continue;
          if (n >= MAX_INSTANCES) break;
          const o = n++ * 8;
          data[o + 0] = ox;
          data[o + 1] = oz;
          data[o + 2] = cell;
          data[o + 3] = level;
          data[o + 4] = OCEAN_MORPH_START * radius;
          data[o + 5] = OCEAN_MORPH_END * radius;
          data[o + 6] = 0;
          data[o + 7] = 0;
        }
      }
    }

    // The horizon annulus, centred on the CAMERA rather than on the clipmap.
    // Its inner radius therefore has to come in by the snap offset, or the
    // 60 km ring starts outside the clipmap's outermost edge on the side the
    // snap moved away from and leaves a bare ring 2 km out. Coming in instead
    // overlaps the outermost level slightly, which costs nothing: at that range
    // the annulus and the clipmap are the same flat water to well under a pixel.
    const lastRadius = 2 * B * OCEAN_BASE_CELL * Math.pow(2, levels - 1) - 2 * OCEAN_CLIPMAP_SNAP;
    if (n < MAX_INSTANCES) {
      const o = n++ * 8;
      data[o + 0] = 0;
      data[o + 1] = 0;
      data[o + 2] = lastRadius;
      data[o + 3] = -1;
      data[o + 4] = lastRadius;
      data[o + 5] = HORIZON_RADIUS;
      data[o + 6] = 0;
      data[o + 7] = 0;
    }
    return n;
  }
}

/**
 * Coverage radius of the outermost DISPLACED clipmap level, metres. Past this
 * the horizon annulus takes over, flat and undisplaced - which is correct,
 * because at 2 km a 2 m wave subtends a tenth of a pixel.
 */
export const OCEAN_CLIPMAP_RADIUS =
  2 * OCEAN_BLOCK_CELLS * OCEAN_BASE_CELL * Math.pow(2, OCEAN.CLIPMAP_RINGS - 1);
