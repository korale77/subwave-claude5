/**
 * SUBWAVE HUD composite pass.
 *
 * Draws the Canvas2D HUD texture (src/ui/hud.js) over the tonemapped swap chain
 * with the windshield treatment in shaders/pass/hud.wgsl. Runs last, after the
 * post chain, because the HUD is emissive UI on glass and must not be
 * tonemapped, bloomed or graded with the scene.
 *
 * Everything that varies per frame - head parallax, canopy curvature, the
 * strength of the glass reflection, the emissive gain from the HUD's own
 * luminance adaptation - is computed here on the CPU and uploaded as one 64-byte
 * uniform. The shader has no CPU-side branch and no per-frame allocation.
 */

import { profiler } from '../../core/profiler.js';
import { colorAttachment, Blend, STAGE, GROUP } from '../../core/pipelines.js';
import { createUniformBuffer } from '../../core/resources.js';
import { vec3, clamp, saturate, lerp } from '../../core/math.js';

/** Bytes in HudParams (4 x vec4f). Must match shaders/pass/hud.wgsl. */
const HUD_PARAMS_BYTES = 64;

/**
 * Head-lag to UV parallax. The virtual image is collimated at ~1.6 m and the
 * canopy is ~0.75 m from the eye, so a centimetre of head travel moves the
 * image by roughly 0.6% of the frame width.
 */
const PARALLAX_PER_METRE = 0.075;
const PARALLAX_LIMIT = 0.018;
/** How fast the pilot's head catches up with the hull, 1/s. */
const HEAD_FOLLOW_RATE = 4.5;

/** Canopy barrel coefficients. Small: this must read as glass, not a fisheye. */
const CANOPY_K1 = 0.055;
const CANOPY_K2 = 0.030;

/** Dive-mask curvature: a faceplate is nearly flat, and it is close to the eye. */
const MASK_K1 = 0.014;
const MASK_K2 = 0.004;

/**
 * @param {import('../renderer.js').Renderer} renderer
 * @param {import('../../ui/hud.js').HUD} hud
 * @returns {object} a frame-graph pass
 */
export function createHudPass(renderer, hud) {
  let pipeline = null;
  let layout = null;
  let uniformBuffer = null;
  let bindGroup = null;
  let boundView = null;

  const params = new Float32Array(HUD_PARAMS_BYTES / 4);

  // Damped head position in camera-relative space, and scratch for the lag.
  const headPos = vec3.create();
  const lag = vec3.create();
  let headSeeded = false;
  let flickerPhase = 0;

  return {
    name: 'hud',
    type: 'render',
    reads: [],
    writes: [],

    enabled(ctx) {
      return !!(hud && hud.visible && hud.view && hud.mode !== 'none');
    },

    async init(ctx) {
      // Each pass owns its shader dependency; the renderer has no global
      // preload list and loadRecursive is a cache hit once anything else asked.
      await ctx.shaders.loadRecursive('pass/hud.wgsl');
      const module = ctx.shaders.module('pass/hud.wgsl', {}, 'hud');
      uniformBuffer = createUniformBuffer(ctx.device, HUD_PARAMS_BYTES, 'hud.params');

      layout = ctx.pipelines.bindGroupLayout('hud.bgl', [
        { binding: 0, visibility: STAGE.F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: STAGE.F, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 2, visibility: STAGE.F, sampler: { type: 'filtering' } },
      ]);

      pipeline = ctx.pipelines.renderPipeline({
        label: 'hud',
        layout: ctx.pipelines.pipelineLayout('hud.pl', [renderer.frameLayout, layout]),
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: {
          module,
          entryPoint: 'fs_hud',
          targets: [{ format: ctx.gpu.presentFormat, blend: Blend.premultiplied }],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
      });
    },

    resize() {
      // The HUD texture is recreated at the new output size; its view changes.
      bindGroup = null;
      boundView = null;
      headSeeded = false;
    },

    execute(ctx, encoder) {
      if (!pipeline || !hud.view) return;

      if (bindGroup === null || boundView !== hud.view) {
        boundView = hud.view;
        bindGroup = ctx.device.createBindGroup({
          label: 'hud.bg',
          layout,
          entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: hud.view },
            // linearClamp, not the frame group's repeat sampler: a HUD that
            // wraps would put the compass ribbon on the depth tape.
            { binding: 2, resource: ctx.samplers.linearClamp },
          ],
        });
      }

      const cam = ctx.camera;
      const dt = clamp(ctx.dt, 0, 1 / 20);
      const mask = hud.mode === 'swim';

      // Head parallax. The pilot's head does not follow the hull instantly, so
      // the lag between the two is exactly the head-relative displacement that
      // moves a collimated image. Derived from translation, never rotation: the
      // HUD is fixed to the glass, so rotating the camera moves it not at all.
      if (!headSeeded) {
        vec3.copy(headPos, cam.relativePosition);
        headSeeded = true;
      } else {
        vec3.damp(headPos, headPos, cam.relativePosition, HEAD_FOLLOW_RATE, dt);
      }
      vec3.sub(lag, headPos, cam.relativePosition);
      const lagRight = vec3.dot(lag, cam.right);
      const lagUp = vec3.dot(lag, cam.up);
      const px = clamp(-lagRight * PARALLAX_PER_METRE, -PARALLAX_LIMIT, PARALLAX_LIMIT);
      // UV v runs down: a head that rises pushes the virtual image down.
      const py = clamp(lagUp * PARALLAX_PER_METRE, -PARALLAX_LIMIT, PARALLAX_LIMIT);

      // Projector flicker: a real HUD projector has a small ripple on its lamp
      // supply. Two beats so it never lands on a visible period.
      flickerPhase += dt;
      const flicker = 1 + 0.012 * Math.sin(flickerPhase * 47.3) +
        0.006 * Math.sin(flickerPhase * 113.7);

      const boot = hud.bootFraction;
      const glassGain = mask ? 0.0 : lerp(0.10, 0.34, saturate(hud.gain));

      params[0] = mask ? px * 0.35 : px;
      params[1] = mask ? py * 0.35 : py;
      params[2] = mask ? MASK_K1 : CANOPY_K1;
      params[3] = mask ? MASK_K2 : CANOPY_K2;

      // Lateral colour at the edge. The canopy is a coated combiner and does
      // disperse; the dive mask is flat faceplate glass read directly and
      // barely does. Both figures are bounded by the same hard constraint, and
      // it is the constraint and not the taste that fixes them:
      //
      // The shader offsets each primary by `radial * optics.x * r2` in UV, so
      // the red-to-blue separation in output pixels is
      //     2 * |radial.x| * optics.x * r2 * outputWidth.
      // The depth and speed tapes sit at |radial.x| ~ 0.40 and r2 ~ 0.72 (16:9;
      // more on an ultrawide, where they are further off axis), and their hero
      // numerals have a cap height of ~14 px at 1080p. Separation must stay
      // under the ~3 px glyph stroke or the numeral resolves as three coloured
      // copies rather than one fringed one - measured 7 px at 0.0090 and the
      // four-digit depth readout was unreadable. 0.0016 puts it at 1.2 px there
      // and ~3 px in the extreme corner, where no instrument is drawn.
      params[4] = mask ? 0.0012 : 0.0016;
      params[5] = glassGain;
      params[6] = hud.gain;
      // Master opacity, and the showcase demo's fade rides it. THE HUD PASS
      // RUNS AFTER THE WHOLE POST CHAIN (passes/index.js) and composites onto
      // the swap chain with loadOp 'load', so lens.wgsl's fade multiply cannot
      // reach these instruments; without this line they stay fully bright over
      // a black frame at every segment cut, in the window and in the recording.
      // See Renderer.demoFade. Rests at 1.0.
      params[7] = 1 - saturate(renderer.demoFade);

      params[8] = ctx.time;
      params[9] = ctx.gpu.width / Math.max(1, ctx.gpu.height);
      params[10] = mask ? 1 : 0;
      params[11] = flicker;

      params[12] = mask ? 0.0 : 0.55;        // projector raster strength
      params[13] = mask ? 0.30 : 0.72;       // coaming line the glass mirrors about
      params[14] = hud.stress;
      params[15] = boot;

      ctx.device.queue.writeBuffer(uniformBuffer, 0, params);

      const pass = encoder.beginRenderPass(profiler.gpuPass({
        label: 'hud',
        colorAttachments: [colorAttachment(ctx.outputView, { loadOp: 'load' })],
      }, 'hud'));
      pass.setPipeline(pipeline);
      pass.setBindGroup(GROUP.FRAME, ctx.frameBindGroup);
      pass.setBindGroup(GROUP.PASS, bindGroup);
      pass.draw(3);
      pass.end();
    },

    destroy() {
      uniformBuffer?.destroy();
      uniformBuffer = null;
    },
  };
}

export { HUD_PARAMS_BYTES };
