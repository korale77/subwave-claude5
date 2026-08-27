/**
 * SUBWAVE volumetric cloud pass.
 *
 * Two render passes per frame:
 *
 *   1. march  - half resolution into a ping-ponged history target. A 2x2 Bayer
 *               schedule marches one half-res pixel in four each frame (one
 *               full-res pixel in sixteen) and reprojects the previous frame
 *               for the rest, so the marched ray count at 1080p is 130k.
 *   2. composite - full resolution into sceneColor, premultiplied, depth-tested
 *               so clouds sit behind everything the depth buffer already owns.
 *
 * Step counts and the cost argument are stated at the top of
 * shaders/pass/clouds.wgsl. Enabled only when the tier preset asks for
 * volumetric clouds; LOW tier gets nothing from this file.
 */

import {
  colorAttachment, depthAttachment, BindGroupBuilder, STAGE, Primitive, DepthState,
  FULLSCREEN_VERTEX_COUNT,
} from '../../core/pipelines.js';
import { FORMATS } from '../../core/gpu.js';
import { profiler } from '../../core/profiler.js';

/**
 * Premultiplied-alpha composite: rgb is the in-scattered radiance the march
 * accumulated, alpha is 1 - transmittance. dst*(1-a) + src is exactly
 * dst*T + L, which is the radiative transfer solution the march produced.
 */
const BLEND_PREMULTIPLIED = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
};

/**
 * Same visibility rule as the sky pass: clouds only exist above the water, so
 * they are worth marching only when a corner of the frustum clears the surface.
 */
function cloudsVisible(ctx) {
  if (!ctx.underwater) return true;
  const cam = ctx.camera;
  const t = cam.tanHalfFov;
  return cam.forward[1] + Math.abs(cam.up[1]) * t + Math.abs(cam.right[1]) * t * cam.aspect > 0;
}

/**
 * @param {import('../../sim/sky.js').SkySystem} sky
 * @returns {object} a frame-graph pass
 */
export function makeCloudsPass(sky) {
  let marchPipeline = null;
  let compositePipeline = null;
  let layout = null;
  /** Bind groups keyed by which history target is the SOURCE. */
  const groups = { cloudHistoryA: null, cloudHistoryB: null };
  let needsClear = true;

  const buildGroup = (ctx, sourceName) => {
    const b = new BindGroupBuilder(`clouds.${sourceName}`);
    b.uniform(sky.uniformBuffer, STAGE.F);
    b.sampler(ctx.samplers.linearClamp, STAGE.F);
    b.texture(ctx.targets.view('transmittanceLUT'), STAGE.F);
    b.texture(sky.multiScatterView, STAGE.F);
    b.texture(ctx.targets.view(sourceName), STAGE.F);
    const built = b.build(ctx.pipelines);
    layout = built.layout;
    return built.group;
  };

  const rebuildGroups = (ctx) => {
    groups.cloudHistoryA = buildGroup(ctx, 'cloudHistoryA');
    groups.cloudHistoryB = buildGroup(ctx, 'cloudHistoryB');
  };

  return {
    name: 'clouds',
    type: 'render',
    reads: ['skyLUT', 'transmittanceLUT', '_skyMultiScatter', 'cloudHistoryA', 'cloudHistoryB'],
    writes: ['sceneColor', 'cloudHistoryA', 'cloudHistoryB'],

    enabled(ctx) {
      if (!ctx.preset.volumetricClouds) return false;
      if (!cloudsVisible(ctx)) return false;
      return (ctx.renderer.env.cloudCover || 0) > 0.005;
    },

    init(ctx) {
      // Declared here rather than in renderer._declareTargets because they only
      // exist when this pass does. RenderTargets rebuilds them on resize like
      // any other target.
      ctx.targets.declare('cloudHistoryA', { format: FORMATS.hdr, scale: 0.5 });
      ctx.targets.declare('cloudHistoryB', { format: FORMATS.hdr, scale: 0.5 });

      const module = ctx.shaders.module('pass/clouds.wgsl', {}, 'clouds');
      rebuildGroups(ctx);
      const pipelineLayout = ctx.pipelines.pipelineLayout(
        'clouds.pl', [ctx.renderer.frameLayout, layout]);

      marchPipeline = ctx.pipelines.renderPipeline({
        label: 'clouds.march',
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: { module, entryPoint: 'fs_cloudMarch', targets: [{ format: FORMATS.hdr }] },
        primitive: Primitive.trianglesNoCull,
      });

      compositePipeline = ctx.pipelines.renderPipeline({
        label: 'clouds.composite',
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: {
          module, entryPoint: 'fs_cloudComposite',
          targets: [{ format: FORMATS.hdr, blend: BLEND_PREMULTIPLIED }],
        },
        primitive: Primitive.trianglesNoCull,
        // Clouds live at infinity, so they may only fill pixels the depth
        // buffer left at the far plane - the same rule as the sky itself.
        depthStencil: DepthState.testNoWriteInclusive(FORMATS.depth),
      });
      needsClear = true;
    },

    resize(ctx) {
      rebuildGroups(ctx);
      needsClear = true;
    },

    execute(ctx, encoder) {
      if (!marchPipeline) return;
      const history = ctx.history('cloudHistory');

      // A freshly allocated target holds undefined data, and the march reads it
      // as history. Clear both to "no cloud, full transmittance" once so the
      // first frames converge from empty sky rather than from garbage.
      if (needsClear) {
        for (const name of ['cloudHistoryA', 'cloudHistoryB']) {
          const clearPass = encoder.beginRenderPass({
            label: `clouds.clear.${name}`,
            colorAttachments: [colorAttachment(ctx.targets.view(name),
              { clear: { r: 0, g: 0, b: 0, a: 1 } })],
          });
          clearPass.end();
        }
        needsClear = false;
      }

      const march = encoder.beginRenderPass(profiler.gpuPass({
        label: 'clouds.march',
        colorAttachments: [colorAttachment(ctx.targets.view(history.current),
          { clear: { r: 0, g: 0, b: 0, a: 1 } })],
      }, 'clouds.march'));
      march.setBindGroup(0, ctx.frameBindGroup);
      march.setBindGroup(1, groups[history.previous]);
      march.setPipeline(marchPipeline);
      march.draw(FULLSCREEN_VERTEX_COUNT);
      march.end();

      const composite = encoder.beginRenderPass(profiler.gpuPass({
        label: 'clouds.composite',
        colorAttachments: [colorAttachment(ctx.targets.view('sceneColor'), { loadOp: 'load' })],
        depthStencilAttachment: depthAttachment(ctx.targets.view('sceneDepth'), { readOnly: true }),
      }, 'clouds.composite'));
      composite.setBindGroup(0, ctx.frameBindGroup);
      composite.setBindGroup(1, groups[history.current]);
      composite.setPipeline(compositePipeline);
      composite.draw(FULLSCREEN_VERTEX_COUNT);
      composite.end();
    },
  };
}
