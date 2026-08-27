/**
 * SUBWAVE screen-space ambient occlusion pass.
 *
 * Three subpasses inside one frame-graph node, in producer/consumer order that
 * nothing else may come between (the same reason the creature pass keeps its
 * skeleton solve and its draw in one execute()):
 *
 *   1. `ssao`       half-res AO estimate from sceneDepth      -> ssaoRaw
 *   2. `ssao.blur`  depth-aware 3x3                           -> ssaoTex
 *   3. `ssao.apply` edge-aware upsample, multiplied into sceneColor through
 *                   the per-pixel ambient-share gate (`aoGate`)
 *
 * WHERE AO LANDS - the design decision, stated once: SSAO darkens the AMBIENT
 * share of each pixel and nothing else. A forward renderer has no G-buffer to
 * re-shade from, and the geometry passes cannot sample a same-frame AO texture
 * built from the depth they are still writing - so the split is carried the
 * other way: each opaque geometry shader writes its own delivered ambient
 * fraction to `aoGate` (see aoGate() in common/water.wgsl), and this pass
 * multiplies sceneColor by 1 - strength * gate * (1 - ao). Emissives, the
 * CSM-shadowed direct beam, punctual lamps and the medium's in-scatter are
 * outside the gate's numerator, so none of them can lose energy here - the
 * glowcup protection is arithmetic, not a mask. The alternative (prior-frame
 * AO reprojected into the shaders' SurfaceCtx.occlusion) applies AO in exact
 * RGB but buys disocclusion trails on every moving creature and a second
 * depth history; this one is luminance-exact, same-frame, and artifact-free
 * under motion.
 *
 * THE APPLY BLEND IS THE TRICK THAT AVOIDS A COPY: sceneColor cannot be
 * sampled and rendered to in one pass (the underwater composite pays a
 * two-pass round trip for exactly this), but a multiplier needs no read -
 * Blend.multiply (out = src * dst) does it in fixed function, alpha
 * preserved. At RENDER.SSAO_STRENGTH = 0 the pass is skipped entirely and
 * the frame is bit-identical to a build without it.
 *
 * Scopes: `ssao`, `ssao.blur`, `ssao.apply` - three of the 19 the profiler
 * had spare at the counted framing (MAX_GPU_SCOPES docstring).
 */

import { profiler } from '../../core/profiler.js';
import { colorAttachment, Primitive, Blend, STAGE } from '../../core/pipelines.js';
import { FORMATS } from '../../core/gpu.js';
import { RENDER } from '../../core/constants.js';
import { settings } from '../../core/settings.js';
import { createUniformBuffer } from '../../core/resources.js';

/** Bytes in SsaoParams: two vec4f. */
const SSAO_UNIFORM_BYTES = 32;

/**
 * Build the SSAO frame-graph pass.
 *
 * @param {import('../renderer.js').Renderer} renderer
 * @returns {object} a frame-graph pass
 */
export function makeSsaoPass(renderer) {
  let aoPipeline = null;
  let blurPipeline = null;
  let applyPipeline = null;
  let aoLayout = null;
  let blurLayout = null;
  let applyLayout = null;
  let aoGroup = null;
  let blurGroup = null;
  let applyGroup = null;
  let paramsBuf = null;
  // Preallocated - no per-frame allocation. Written every frame so every
  // RENDER.SSAO_* knob except SAMPLES is live from the console.
  const paramsData = new Float32Array(SSAO_UNIFORM_BYTES / 4);

  return {
    name: 'ssao',
    type: 'render',
    reads: ['sceneDepth', 'aoGate'],
    writes: ['ssaoRaw', 'ssaoTex', 'sceneColor'],

    enabled() {
      // STRENGTH = 0 is the bisect: the pass does not run and the frame is
      // exactly the pre-SSAO frame (the gate byte is written regardless, read
      // by nothing). Live, so the A/B is one console assignment. The USER
      // setting is the third gate - settings.js has authored an 'Ambient
      // occlusion' bool since before the pass existed, and a settings row
      // with no reader is the project's most repeated bug class.
      return !!aoPipeline && RENDER.SSAO_STRENGTH > 0 && settings.get('ssao') !== false;
    },

    init(ctx) {
      // LOW tier ships without SSAO; the pipelines stay null and enabled()
      // stays false. The targets exist on every tier (renderer.js) so the
      // frame graph's declarations hold either way.
      if (!ctx.gpu.preset.ssao) return;

      const module = ctx.shaders.module('pass/ssao.wgsl', {
        SSAO_SAMPLES: RENDER.SSAO_SAMPLES,
      }, 'ssao');

      aoLayout = ctx.pipelines.bindGroupLayout('ssao.bgl', [
        { binding: 0, visibility: STAGE.F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: STAGE.F, texture: { sampleType: 'depth' } },
      ]);
      blurLayout = ctx.pipelines.bindGroupLayout('ssao.blur.bgl', [
        { binding: 0, visibility: STAGE.F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: STAGE.F, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: STAGE.F, texture: { sampleType: 'float' } },
      ]);
      applyLayout = ctx.pipelines.bindGroupLayout('ssao.apply.bgl', [
        { binding: 0, visibility: STAGE.F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: STAGE.F, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: STAGE.F, texture: { sampleType: 'float' } },
        { binding: 3, visibility: STAGE.F, texture: { sampleType: 'float' } },
      ]);

      const frameLayout = ctx.renderer.frameLayout;
      aoPipeline = ctx.pipelines.renderPipeline({
        label: 'ssao',
        layout: ctx.pipelines.pipelineLayout('ssao.pl', [frameLayout, aoLayout]),
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: { module, entryPoint: 'fs_ssao', targets: [{ format: FORMATS.r8 }] },
        primitive: Primitive.trianglesNoCull,
      });
      blurPipeline = ctx.pipelines.renderPipeline({
        label: 'ssao.blur',
        layout: ctx.pipelines.pipelineLayout('ssao.blur.pl', [frameLayout, blurLayout]),
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: { module, entryPoint: 'fs_ssao_blur', targets: [{ format: FORMATS.r8 }] },
        primitive: Primitive.trianglesNoCull,
      });
      applyPipeline = ctx.pipelines.renderPipeline({
        label: 'ssao.apply',
        layout: ctx.pipelines.pipelineLayout('ssao.apply.pl', [frameLayout, applyLayout]),
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: {
          module, entryPoint: 'fs_ssao_apply',
          // The multiply that makes sceneColor writable without being
          // sampled - see the header. Alpha is dst's (refraction masks live
          // there).
          targets: [{ format: FORMATS.hdr, blend: Blend.multiply }],
        },
        primitive: Primitive.trianglesNoCull,
      });

      paramsBuf = createUniformBuffer(ctx.device, SSAO_UNIFORM_BYTES, 'ssao.params');
      rebuild(ctx);
    },

    resize(ctx) { rebuild(ctx); },

    execute(ctx, encoder) {
      if (!aoPipeline) return;

      paramsData[0] = RENDER.SSAO_RADIUS;
      paramsData[1] = RENDER.SSAO_BIAS;
      paramsData[2] = RENDER.SSAO_INTENSITY;
      paramsData[3] = RENDER.SSAO_POWER;
      paramsData[4] = RENDER.SSAO_STRENGTH;
      paramsData[5] = RENDER.SSAO_FADE_START;
      paramsData[6] = RENDER.SSAO_FADE_END;
      paramsData[7] = 0;
      ctx.device.queue.writeBuffer(paramsBuf, 0, paramsData);

      const estimate = encoder.beginRenderPass(profiler.gpuPass({
        label: 'ssao',
        colorAttachments: [
          colorAttachment(ctx.targets.view('ssaoRaw'), { clear: { r: 1, g: 1, b: 1, a: 1 } }),
        ],
      }, 'ssao'));
      estimate.setPipeline(aoPipeline);
      estimate.setBindGroup(0, ctx.frameBindGroup);
      estimate.setBindGroup(1, aoGroup);
      estimate.draw(3);
      estimate.end();

      const blur = encoder.beginRenderPass(profiler.gpuPass({
        label: 'ssao.blur',
        colorAttachments: [
          colorAttachment(ctx.targets.view('ssaoTex'), { clear: { r: 1, g: 1, b: 1, a: 1 } }),
        ],
      }, 'ssao.blur'));
      blur.setPipeline(blurPipeline);
      blur.setBindGroup(0, ctx.frameBindGroup);
      blur.setBindGroup(1, blurGroup);
      blur.draw(3);
      blur.end();

      const apply = encoder.beginRenderPass(profiler.gpuPass({
        label: 'ssao.apply',
        colorAttachments: [
          colorAttachment(ctx.targets.view('sceneColor'), { loadOp: 'load' }),
        ],
      }, 'ssao.apply'));
      apply.setPipeline(applyPipeline);
      apply.setBindGroup(0, ctx.frameBindGroup);
      apply.setBindGroup(1, applyGroup);
      apply.draw(3);
      apply.end();
    },
  };

  function rebuild(ctx) {
    if (!aoLayout) return;
    aoGroup = ctx.device.createBindGroup({
      label: 'ssao.bg',
      layout: aoLayout,
      entries: [
        { binding: 0, resource: { buffer: paramsBuf } },
        { binding: 1, resource: ctx.targets.view('sceneDepth') },
      ],
    });
    blurGroup = ctx.device.createBindGroup({
      label: 'ssao.blur.bg',
      layout: blurLayout,
      entries: [
        { binding: 0, resource: { buffer: paramsBuf } },
        { binding: 1, resource: ctx.targets.view('sceneDepth') },
        { binding: 2, resource: ctx.targets.view('ssaoRaw') },
      ],
    });
    applyGroup = ctx.device.createBindGroup({
      label: 'ssao.apply.bg',
      layout: applyLayout,
      entries: [
        { binding: 0, resource: { buffer: paramsBuf } },
        { binding: 1, resource: ctx.targets.view('sceneDepth') },
        { binding: 2, resource: ctx.targets.view('ssaoTex') },
        { binding: 3, resource: ctx.targets.view('aoGate') },
      ],
    });
  }
}
