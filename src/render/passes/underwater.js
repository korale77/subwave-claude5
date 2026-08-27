/**
 * SUBWAVE underwater composite pass.
 *
 * Runs after the ocean surface and the volumetrics, before the transparents.
 * It reads sceneColor and sceneDepth and, WHEN THE EYE IS SUBMERGED, applies the
 * water medium to the whole frame so no other shader has to. With the eye in air
 * it only draws the meniscus, because this pass is disabled a couple of metres
 * up and the geometry shaders therefore have to own the medium for a seabed seen
 * from a boat. pass/underwater.wgsl's header has the whole rule.
 *
 * WHY THERE IS A ROUND TRIP: a texture cannot be sampled and rendered to in the
 * same render pass, and sceneColor is not created with COPY_DST, so the result
 * cannot simply be copied back either. The composite therefore writes its own
 * full-resolution target and a second, trivial fullscreen draw blits it into
 * sceneColor. Two fullscreen passes at 1080p is about 0.2 ms - cheap next to
 * making every surface shader in the game responsible for its own fog, which is
 * the alternative and is how underwater renderers end up with terrain and
 * creatures disagreeing about visibility.
 *
 * The pass stays enabled even when the camera is nominally above water: at the
 * waterline the classification is PER PIXEL, and the shader falls through to
 * the untouched source colour for air pixels.
 */

import { profiler } from '../../core/profiler.js';
import { colorAttachment, Primitive, STAGE } from '../../core/pipelines.js';
import { FORMATS } from '../../core/gpu.js';
import { TRUE_DARK_DEPTH } from '../../core/constants.js';

/**
 * Camera must be within this of the FLAT sea level for the per-pixel meniscus,
 * plus the sea's own vertical excursion - the classification is against y = 0,
 * so on a swell the eye can be metres above sea level and still be inside a
 * wave. Must stay >= waterlineBand() in pass/underwater.wgsl, or the shader's
 * meniscus is switched off from out here.
 */
const WATERLINE_BAND = 1.5;

/**
 * @param {import('../../sim/ocean.js').OceanSim} sim
 * @returns {object} a frame-graph pass
 */
export function createUnderwaterPass(sim) {
  let compositePipeline = null;
  let blitPipeline = null;
  let compositeLayout = null;
  let blitLayout = null;
  let compositeGroup = null;
  let blitGroup = null;

  return {
    name: 'underwater',
    type: 'render',
    reads: ['sceneColor', 'sceneDepth', 'dryPath'],
    writes: ['sceneColor'],

    enabled(ctx) {
      if (!compositePipeline) return false;
      // Above water and far enough from it that no pixel can be submerged.
      return ctx.underwater ||
        Math.abs(ctx.camera.position[1]) < WATERLINE_BAND + sim.verticalBound;
    },

    init(ctx) {
      // Declared here rather than in renderer.js so the renderer does not have
      // to know which optional passes exist. RenderTargets builds it
      // immediately (the render resolution is already known) and rebuilds it on
      // every resize along with everything else.
      ctx.targets.declare('underwaterComposite', { format: FORMATS.hdr });

      const module = ctx.shaders.module('pass/underwater.wgsl', {
        OCEAN_CASCADES: sim.cascadeCount,
        TRUE_DARK_DEPTH: TRUE_DARK_DEPTH.toFixed(1),
      }, 'underwater');

      compositeLayout = ctx.pipelines.bindGroupLayout('underwater.bgl', [
        { binding: 0, visibility: STAGE.F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: STAGE.F, texture: { sampleType: 'float' } },
        { binding: 2, visibility: STAGE.F, texture: { sampleType: 'depth' } },
        // The dry length of each view ray - see FragOut.dryPath in
        // pass/entity.wgsl. Bound unconditionally: it is cleared to zero every
        // frame and only the station ever writes it, so away from the habitat
        // this pass is algebraically identical to what it was.
        { binding: 4, visibility: STAGE.F, texture: { sampleType: 'unfilterable-float' } },
      ]);
      blitLayout = ctx.pipelines.bindGroupLayout('underwater.blit.bgl', [
        { binding: 3, visibility: STAGE.F, texture: { sampleType: 'float' } },
      ]);

      const frameLayout = ctx.renderer.frameLayout;
      compositePipeline = ctx.pipelines.renderPipeline({
        label: 'underwater.composite',
        layout: ctx.pipelines.pipelineLayout('underwater.pl', [frameLayout, compositeLayout]),
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: { module, entryPoint: 'fs_underwater', targets: [{ format: FORMATS.hdr }] },
        primitive: Primitive.trianglesNoCull,
      });
      blitPipeline = ctx.pipelines.renderPipeline({
        label: 'underwater.blit',
        layout: ctx.pipelines.pipelineLayout('underwater.blit.pl', [frameLayout, blitLayout]),
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: { module, entryPoint: 'fs_blit', targets: [{ format: FORMATS.hdr }] },
        primitive: Primitive.trianglesNoCull,
      });

      rebuild(ctx);
    },

    resize(ctx) { rebuild(ctx); },

    execute(ctx, encoder) {
      const composite = encoder.beginRenderPass(profiler.gpuPass({
        label: 'underwater.composite',
        colorAttachments: [
          colorAttachment(ctx.targets.view('underwaterComposite'), { loadOp: 'clear' }),
        ],
      }, 'underwater'));
      composite.setPipeline(compositePipeline);
      composite.setBindGroup(0, ctx.frameBindGroup);
      composite.setBindGroup(1, compositeGroup);
      composite.draw(3);
      composite.end();

      const blit = encoder.beginRenderPass(profiler.gpuPass({
        label: 'underwater.blit',
        colorAttachments: [
          colorAttachment(ctx.targets.view('sceneColor'), { loadOp: 'clear' }),
        ],
      }, 'underwater.blit'));
      blit.setPipeline(blitPipeline);
      blit.setBindGroup(0, ctx.frameBindGroup);
      blit.setBindGroup(1, blitGroup);
      blit.draw(3);
      blit.end();
    },
  };

  function rebuild(ctx) {
    if (!compositeLayout) return;
    compositeGroup = ctx.device.createBindGroup({
      label: 'underwater.bg',
      layout: compositeLayout,
      entries: [
        { binding: 0, resource: { buffer: sim.uniformBuffer } },
        { binding: 1, resource: ctx.targets.view('sceneColor') },
        { binding: 2, resource: ctx.targets.view('sceneDepth') },
        { binding: 4, resource: ctx.targets.view('dryPath') },
      ],
    });
    blitGroup = ctx.device.createBindGroup({
      label: 'underwater.blit.bg',
      layout: blitLayout,
      entries: [{ binding: 3, resource: ctx.targets.view('underwaterComposite') }],
    });
  }
}
