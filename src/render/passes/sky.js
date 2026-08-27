/**
 * SUBWAVE sky pass.
 *
 * Drawn AFTER opaque geometry. Three draws share one render pass:
 *
 *   1. the sky itself, depth-tested so it only fills pixels nothing wrote
 *   2. aerial-perspective extinction over the pixels that DID get geometry
 *   3. aerial-perspective in-scatter over the same pixels
 *
 * Draws 2 and 3 are separate because `dst * T + S` with a per-channel T has no
 * single-draw WebGPU blend equation - see the header of
 * shaders/pass/sky_render.wgsl.
 */

import {
  colorAttachment, depthAttachment, BindGroupBuilder, STAGE, Primitive, DepthState,
  FULLSCREEN_VERTEX_COUNT,
} from '../../core/pipelines.js';
import { FORMATS } from '../../core/gpu.js';
import { profiler } from '../../core/profiler.js';

/**
 * Depth state for the aerial-perspective draws.
 *
 * The fullscreen triangle is emitted at clip z = 0, which under reverse-Z is
 * the far plane and also the depth clear value. `less` therefore passes only
 * where something wrote a depth GREATER than zero - that is, only over real
 * geometry - and lets early-Z reject the sky pixels for free instead of
 * discarding them in the fragment shader.
 */
const depthGeometryOnly = (format) => ({
  format, depthWriteEnabled: false, depthCompare: 'less',
});

/** Multiply into the colour target while leaving the alpha channel untouched. */
const BLEND_MULTIPLY_RGB = {
  color: { srcFactor: 'dst', dstFactor: 'zero', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
};

/** Add into the colour target while leaving the alpha channel untouched. */
const BLEND_ADD_RGB = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
};

/**
 * True when the sky can contribute anything to this frame: the camera is above
 * the waterline, or it is below it and looking far enough up that part of the
 * frustum clears the surface (Snell's window, and the sky above the surface
 * silhouette). Marching the sky for a camera staring at the seabed is pure
 * waste, and it is a common state in this game.
 */
function skyIsVisible(ctx) {
  if (!ctx.underwater) return true;
  const cam = ctx.camera;
  // World-space y of the highest of the four corner rays. The absolute values
  // pick whichever corner points up, which matters the moment the rig rolls
  // the camera: with a plain `up[1] * tan` a rolled view would cull the sky
  // while it is still on screen.
  const t = cam.tanHalfFov;
  return cam.forward[1] + Math.abs(cam.up[1]) * t + Math.abs(cam.right[1]) * t * cam.aspect > 0;
}

/**
 * @param {import('../../sim/sky.js').SkySystem} sky
 * @returns {object} a frame-graph pass
 */
export function makeSkyPass(sky) {
  let skyPipeline = null;
  let extinctionPipeline = null;
  let inScatterPipeline = null;
  let layout = null;
  let bindGroup = null;

  const buildBindGroup = (ctx) => {
    const b = new BindGroupBuilder('skyPass');
    b.uniform(sky.uniformBuffer, STAGE.F);
    b.sampler(ctx.samplers.linearClamp, STAGE.F);
    b.texture(ctx.targets.view('transmittanceLUT'), STAGE.F);
    b.texture(sky.multiScatterView, STAGE.F);
    b.storage(sky.starBuffer, STAGE.F, true);
    b.storage(sky.starCellBuffer, STAGE.F, true);
    b.depthTexture(ctx.targets.view('sceneDepth'), STAGE.F);
    const built = b.build(ctx.pipelines);
    layout = built.layout;
    return built.group;
  };

  return {
    name: 'sky',
    type: 'render',
    reads: ['skyLUT', 'transmittanceLUT', '_skyMultiScatter', 'sceneDepth'],
    writes: ['sceneColor'],

    enabled(ctx) { return skyIsVisible(ctx); },

    init(ctx) {
      const module = ctx.shaders.module('pass/sky_render.wgsl', {}, 'sky-render');
      bindGroup = buildBindGroup(ctx);
      const pipelineLayout = ctx.pipelines.pipelineLayout(
        'sky.pl', [ctx.renderer.frameLayout, layout]);
      const target = { format: FORMATS.hdr };

      skyPipeline = ctx.pipelines.renderPipeline({
        label: 'sky',
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: { module, entryPoint: 'fs_sky', targets: [target] },
        primitive: Primitive.trianglesNoCull,
        // greater-EQUAL, not greater: the fullscreen triangle sits exactly on
        // the reverse-Z far plane, so a strict `greater` would reject every
        // pixel and draw nothing at all.
        depthStencil: DepthState.testNoWriteInclusive(FORMATS.depth),
      });

      extinctionPipeline = ctx.pipelines.renderPipeline({
        label: 'sky.aerialExtinction',
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: {
          module, entryPoint: 'fs_aerialExtinction',
          targets: [{ format: FORMATS.hdr, blend: BLEND_MULTIPLY_RGB }],
        },
        primitive: Primitive.trianglesNoCull,
        depthStencil: depthGeometryOnly(FORMATS.depth),
      });

      inScatterPipeline = ctx.pipelines.renderPipeline({
        label: 'sky.aerialInScatter',
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: {
          module, entryPoint: 'fs_aerialInScatter',
          targets: [{ format: FORMATS.hdr, blend: BLEND_ADD_RGB }],
        },
        primitive: Primitive.trianglesNoCull,
        depthStencil: depthGeometryOnly(FORMATS.depth),
      });
    },

    resize(ctx) {
      // sceneDepth was rebuilt, so its view in the bind group is stale.
      bindGroup = buildBindGroup(ctx);
    },

    execute(ctx, encoder) {
      if (!skyPipeline) return;
      const pass = encoder.beginRenderPass(profiler.gpuPass({
        label: 'sky',
        colorAttachments: [colorAttachment(ctx.targets.view('sceneColor'), { loadOp: 'load' })],
        // Read-only so the fragment shader may also SAMPLE sceneDepth for the
        // aerial-perspective distance; a writable depth attachment cannot be
        // bound as a texture in the same pass.
        depthStencilAttachment: depthAttachment(ctx.targets.view('sceneDepth'), { readOnly: true }),
      }, 'sky'));

      pass.setBindGroup(0, ctx.frameBindGroup);
      pass.setBindGroup(1, bindGroup);

      pass.setPipeline(skyPipeline);
      pass.draw(FULLSCREEN_VERTEX_COUNT);

      // Aerial perspective is an air phenomenon. With the camera submerged the
      // medium between the eye and everything it can see is water, and
      // common/water.wgsl owns that.
      if (!ctx.underwater) {
        pass.setPipeline(extinctionPipeline);
        pass.draw(FULLSCREEN_VERTEX_COUNT);
        pass.setPipeline(inScatterPipeline);
        pass.draw(FULLSCREEN_VERTEX_COUNT);
      }

      pass.end();
    },
  };
}
