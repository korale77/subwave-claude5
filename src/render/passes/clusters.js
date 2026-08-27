/**
 * Clustered light culling.
 *
 * The frustum is diced into CLUSTER_X x CLUSTER_Y x CLUSTER_Z froxels; a
 * compute pass assigns every light to the clusters it touches, and the shading
 * pass then only evaluates the handful of lights that can actually reach the
 * pixel. Without this, a scene with a vessel's five lamps plus bioluminescence
 * would loop over every light for every pixel.
 *
 * Z slicing is EXPONENTIAL, matching lighting.wgsl:
 *
 *   slice = floor( log(z / near) * CLUSTER_Z / log(far / near) )
 *
 * Uniform slicing would spend almost every slice on the far field, where the
 * eye cannot resolve light boundaries anyway, and leave the first few metres -
 * where the vessel's own lamps live - in a single slice.
 */

import { profiler } from '../../core/profiler.js';
import { STAGE } from '../../core/pipelines.js';
import { createUniformBuffer } from '../../core/resources.js';
import { RENDER } from '../../core/constants.js';

const WORKGROUP = [4, 4, 4];

export function makeClusterPass(renderer) {
  let pipeline = null;
  let bindGroupLayout = null;
  let bindGroup = null;
  let paramsBuffer = null;
  // mat4x4f (16 floats) + 8 scalars, 16-byte aligned.
  const params = new Float32Array(24);

  const clusterCount = RENDER.CLUSTER_X * RENDER.CLUSTER_Y * RENDER.CLUSTER_Z;

  return {
    name: 'clusterCull',
    type: 'compute',
    reads: [],
    writes: [],

    init(ctx) {
      const module = ctx.shaders.module('sim/cluster_cull.wgsl', {}, 'cluster-cull');

      paramsBuffer = createUniformBuffer(ctx.device, params.byteLength, 'cluster-params');

      bindGroupLayout = ctx.pipelines.bindGroupLayout('clusterCull.bgl', [
        { binding: 0, visibility: STAGE.C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: STAGE.C, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: STAGE.C, buffer: { type: 'storage' } },
        { binding: 3, visibility: STAGE.C, buffer: { type: 'storage' } },
      ]);

      bindGroup = ctx.device.createBindGroup({
        label: 'clusterCull.bg',
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: paramsBuffer } },
          { binding: 1, resource: { buffer: renderer.lightBuffer } },
          { binding: 2, resource: { buffer: renderer.clusterRangeBuffer } },
          { binding: 3, resource: { buffer: renderer.clusterIndexBuffer } },
        ],
      });

      pipeline = ctx.pipelines.computePipeline({
        label: 'clusterCull',
        layout: ctx.pipelines.pipelineLayout('clusterCull.pl', [bindGroupLayout]),
        compute: { module, entryPoint: 'cs_cluster_cull' },
      });
    },

    execute(ctx, encoder) {
      if (!pipeline) return;
      const cam = ctx.camera;

      // Cull against the far distance the shading passes actually use, not the
      // infinite far plane - an infinite far would make every slice infinite.
      const near = cam.near;
      const far = RENDER.MAX_VIEW_DISTANCE;

      params.set(cam.view, 0);
      params[16] = near;
      params[17] = far;
      params[18] = Math.log(far / near);
      params[19] = renderer.lightCount;
      params[20] = cam.tanHalfFov;
      params[21] = cam.aspect;
      params[22] = RENDER.MAX_LIGHTS_PER_CLUSTER;
      params[23] = 0;
      ctx.device.queue.writeBuffer(paramsBuffer, 0, params);

      const pass = encoder.beginComputePass(profiler.gpuPass({
        label: 'clusterCull',
      }, 'clusterCull'));
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(
        Math.ceil(RENDER.CLUSTER_X / WORKGROUP[0]),
        Math.ceil(RENDER.CLUSTER_Y / WORKGROUP[1]),
        Math.ceil(RENDER.CLUSTER_Z / WORKGROUP[2]),
      );
      pass.end();

      profiler.setCount('clusters', clusterCount);
    },
  };
}
