/**
 * SUBWAVE volumetric light - the froxel volume's producer.
 *
 * Two compute dispatches over a FROXEL_X x FROXEL_Y x FROXEL_Z grid:
 *
 *   1. INJECT     one thread per froxel. Evaluates the local scattering source
 *                 (sun beam x caustics x shadow, plus every lamp in the froxel's
 *                 cluster) and the local density, and blends it against the
 *                 reprojected previous frame. Writes `froxelDensity{A,B}`.
 *   2. INTEGRATE  one thread per screen COLUMN, marching all slices from the eye
 *                 outward. Writes `froxelScatter`, which is what bind group 0
 *                 exposes to every consumer.
 *
 * The encoding contract, the ownership rule that keeps the medium applied
 * exactly once, and the reason `froxelScatter.a` is 1.0 are all written down at
 * the top of shaders/sim/froxel_integrate.wgsl. Read that before changing
 * anything here.
 *
 * ---------------------------------------------------------------------------
 * THIS PASS CANNOT BIND THE RENDERER'S NORMAL BIND GROUP 0.
 *
 * `froxelScatter` sits at group 0 binding 10 as a TEXTURE_BINDING, and this pass
 * writes it as a STORAGE_BINDING. WebGPU forbids a texture being readable and
 * writable in the same synchronisation scope, and Dawn validates that against
 * the bind group's ENTRIES rather than against what the shader statically uses -
 * so merely having it in the group invalidates the whole command buffer. It is
 * the same platform rule the shadow pass hit with `shadowAtlas`, and
 * renderer.js's `frameBindGroupVol(parity)` is the same answer: an otherwise
 * identical group 0 with the previous frame's density volume - read-only this
 * frame - substituted at binding 10. That keeps every frame.* accessor, the
 * cluster light lists, the shadow cascades and all of common/water.wgsl
 * available to the compute shaders verbatim.
 *
 * The one thing the shaders must therefore never do is call sampleFroxel(), and
 * neither of them does; there is nothing to sample yet at that point in the
 * frame anyway.
 *
 * ---------------------------------------------------------------------------
 * THREE VOLUMES, NOT TWO. rgba16float rejects `read_write` storage access on
 * this device ("does not support storage texture access StorageTextureAccess::
 * ReadWrite"), so stage 2 cannot integrate in place and needs a separate scatter
 * target; and the temporal reprojection needs the PREVIOUS density as well as
 * this frame's, so the density itself has to ping-pong.
 */

import { profiler } from '../../core/profiler.js';
import { STAGE } from '../../core/pipelines.js';
import { createUniformBuffer } from '../../core/resources.js';
import { RENDER } from '../../core/constants.js';
import { settings } from '../../core/settings.js';

/**
 * An 8x8x1 workgroup, not 4x4x4, and the reason is the cluster walk.
 *
 * The light cluster grid is CLUSTER_X x CLUSTER_Y x CLUSTER_Z = 16 x 9 x 24
 * against a 160 x 90 x 64 froxel grid, so one cluster tile covers 10 x 10
 * froxels. An 8x8x1 group therefore shares ONE cluster z-slice across all 64
 * lanes and spans at most 2x2 tiles in xy - near-perfect coherence for
 * `clusterIndices`. A 4x4x4 group would straddle four cluster z-slices and
 * diverge on every lamp lookup.
 */
const WORKGROUP = 8;

/**
 * Build the froxel volumetrics pass.
 *
 * @param {import('../renderer.js').Renderer} renderer
 * @returns {object} a frame-graph pass named 'volumetrics'
 */
export function makeVolumetricsPass(renderer) {
  let injectPipeline = null;
  let integratePipeline = null;
  let injectLayout = null;
  let integrateLayout = null;
  /** Indexed by frame parity. */
  const injectGroups = [null, null];
  const integrateGroups = [null, null];
  let paramsBuffer = null;
  const params = new Float32Array(4);

  let dims = [0, 0, 0];
  /**
   * Frames since the density volumes last held a valid history. The reprojection
   * blend has to be zero until the OTHER volume has been written at least once,
   * or the first frames of every session (and of every resize) accumulate
   * against a zero-filled texture and fade in from black over ten frames.
   */
  let historyFrames = 0;
  /** Frame index of the last execute(), to notice frames the pass sat out. */
  let lastFrame = -2;

  return {
    name: 'volumetrics',
    type: 'compute',
    // Declared so FrameGraph.validate() and the profiler see the real
    // dependencies. The froxel volumes are reached through bind group 0 rather
    // than through a declared read, which is exactly how a missing producer for
    // this texture stayed invisible for the life of the project.
    reads: ['caustics', 'shadowAtlas'],
    writes: ['froxelScatter', 'froxelDensityA', 'froxelDensityB'],

    enabled() {
      return !!injectPipeline && settings.get('volumetricLight');
    },

    init(ctx) {
      dims = ctx.gpu.preset.froxelDim;
      paramsBuffer = createUniformBuffer(ctx.device, params.byteLength, 'froxel-params');

      const injectModule = ctx.shaders.module('sim/froxel_inject.wgsl', {}, 'froxel-inject');
      const integrateModule = ctx.shaders.module(
        'sim/froxel_integrate.wgsl', {}, 'froxel-integrate');

      injectLayout = ctx.pipelines.bindGroupLayout('froxelInject.bgl', [
        { binding: 0, visibility: STAGE.C, buffer: { type: 'uniform' } },
        {
          binding: 1, visibility: STAGE.C,
          storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '3d' },
        },
        { binding: 2, visibility: STAGE.C, texture: { sampleType: 'float', viewDimension: '3d' } },
      ]);
      integrateLayout = ctx.pipelines.bindGroupLayout('froxelIntegrate.bgl', [
        { binding: 0, visibility: STAGE.C, texture: { sampleType: 'float', viewDimension: '3d' } },
        {
          binding: 1, visibility: STAGE.C,
          storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '3d' },
        },
      ]);

      injectPipeline = ctx.pipelines.computePipeline({
        label: 'froxelInject',
        layout: ctx.pipelines.pipelineLayout(
          'froxelInject.pl', [renderer.frameLayout, injectLayout]),
        compute: { module: injectModule, entryPoint: 'cs_froxel_inject' },
      });
      integratePipeline = ctx.pipelines.computePipeline({
        label: 'froxelIntegrate',
        layout: ctx.pipelines.pipelineLayout(
          'froxelIntegrate.pl', [renderer.frameLayout, integrateLayout]),
        compute: { module: integrateModule, entryPoint: 'cs_froxel_integrate' },
      });

      rebuild(ctx);
    },

    resize(ctx) {
      // The froxel targets are fixed-size, but RenderTargets.resize() rebuilds
      // every declared target, so the views these groups hold are stale.
      rebuild(ctx);
    },

    /**
     * Drop the temporal history. Called from Renderer.resetAdaptation() for the
     * same discontinuities TAA and auto-exposure are reset for - a teleport or
     * the day/night toggle invalidate the reprojection completely.
     */
    invalidateHistory() { historyFrames = 0; },

    execute(ctx, encoder) {
      if (!injectPipeline) return;
      const parity = ctx.parity;

      // A frame the pass sat out (the setting toggled, a resize, a throw) left
      // the volume for this parity holding whatever it held two frames before
      // that. Reprojecting into it would blend a stale camera's volume back in
      // for ten frames, so treat any gap as no history at all.
      if (ctx.frameIndex !== lastFrame + 1) historyFrames = 0;
      lastFrame = ctx.frameIndex;

      params[0] = historyFrames > 0 ? RENDER.FROXEL_HISTORY_BLEND : 0;
      // Reserved. The caustic normaliser is now the CAUSTIC_TILE_MEAN_* shader
      // defines, per channel, so nothing reads this slot - and a stale live
      // value left in it is exactly the kind of thing that gets wired back up.
      params[1] = 0.0;
      // The LATCHED flag, never raw beta: a hull at the surface swings the
      // medium several times a second with the chop, and a volume that swapped
      // media with it would strobe the whole frame.
      params[2] = ctx.underwater ? 1 : 0;
      params[3] = RENDER.FROXEL_WATERLINE_BAND;
      ctx.device.queue.writeBuffer(paramsBuffer, 0, params);

      const groupsX = Math.ceil(dims[0] / WORKGROUP);
      const groupsY = Math.ceil(dims[1] / WORKGROUP);

      // TWO compute passes, not two dispatches in one. The density volume is a
      // write-only storage target in the first and a sampled texture in the
      // second, and sim/ocean.js already records that WebGPU rejects that pair
      // inside a single pass. It also gives the profiler one GPU scope each,
      // which is the only way to know what the two halves actually cost.
      const inject = encoder.beginComputePass(profiler.gpuPass({
        label: 'volumetrics.inject',
      }, 'volumetrics.inject'));
      inject.setPipeline(injectPipeline);
      inject.setBindGroup(0, renderer.frameBindGroupVol(parity));
      inject.setBindGroup(1, injectGroups[parity]);
      inject.dispatchWorkgroups(groupsX, groupsY, dims[2]);
      inject.end();

      const integrate = encoder.beginComputePass(profiler.gpuPass({
        label: 'volumetrics.integrate',
      }, 'volumetrics.integrate'));
      integrate.setPipeline(integratePipeline);
      integrate.setBindGroup(0, renderer.frameBindGroupVol(parity));
      integrate.setBindGroup(1, integrateGroups[parity]);
      // One thread per screen column; each marches all dims[2] slices in order.
      integrate.dispatchWorkgroups(groupsX, groupsY, 1);
      integrate.end();

      historyFrames++;
      profiler.setCount('froxels', dims[0] * dims[1] * dims[2]);
    },

    destroy() {
      paramsBuffer?.destroy();
    },
  };

  function rebuild(ctx) {
    if (!injectLayout) return;
    historyFrames = 0;
    for (let parity = 0; parity < 2; parity++) {
      // Mirrors FrameContext.history(): parity 0 writes A and reads B.
      const current = parity === 0 ? 'froxelDensityA' : 'froxelDensityB';
      const previous = parity === 0 ? 'froxelDensityB' : 'froxelDensityA';
      injectGroups[parity] = ctx.device.createBindGroup({
        label: `froxelInject.bg.${parity}`,
        layout: injectLayout,
        entries: [
          { binding: 0, resource: { buffer: paramsBuffer } },
          { binding: 1, resource: ctx.targets.view(current) },
          { binding: 2, resource: ctx.targets.view(previous) },
        ],
      });
      integrateGroups[parity] = ctx.device.createBindGroup({
        label: `froxelIntegrate.bg.${parity}`,
        layout: integrateLayout,
        entries: [
          { binding: 0, resource: ctx.targets.view(current) },
          { binding: 1, resource: ctx.targets.view('froxelScatter') },
        ],
      });
    }
  }
}
