/**
 * SUBWAVE post-processing chain.
 *
 * Five frame-graph passes, in this order and for these reasons:
 *
 *   taa      resolves in HDR, before anything bakes an exposure or a curve into
 *            the history buffer
 *   exposure meters the RESOLVED image, so the histogram is not measuring TAA
 *            noise, and adapts on the GPU with no readback in the critical path
 *   bloom    thresholds in exposed units and builds its chain scene-referred
 *   tonemap  exposure -> depth-band grade -> AgX -> display-referred linear
 *   lens     droplets, chromatic aberration, vignette, grain, sRGB encode, and
 *            the upscale from render resolution to the backbuffer
 *
 * The lens pass is the one that writes the swap chain, which is why it is the
 * only pass here that is never disabled: its individual effects go to zero, but
 * something has to produce an image.
 */

import { profiler } from '../../core/profiler.js';
import { colorAttachment, Blend, STAGE, GROUP } from '../../core/pipelines.js';
import { createUniformBuffer, createStorageBuffer, createBuffer, BufferUsage } from '../../core/resources.js';
import { settings } from '../../core/settings.js';
import { RENDER, DEPTH_BANDS, WORLD } from '../../core/constants.js';
import { clamp, saturate, lerp, smoothstep } from '../../core/math.js';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/** Bytes in the exposure state buffer: 256 u32 bins + 4 f32. */
const EXPOSURE_STATE_BYTES = RENDER.HISTOGRAM_BINS * 4 + 16;
/** Byte offset of the f32 tail (exposure, ev, avgLum, validPixels). */
const EXPOSURE_TAIL_OFFSET = RENDER.HISTOGRAM_BINS * 4;
/** validPixels within that tail: the fourth f32. See ExposureState in exposure.wgsl. */
const VALID_PIXELS_OFFSET = 12;
/** Scratch for the one-word write in the exposure pass's invalidate(). */
const ZERO_F32 = new Float32Array([0]);

/**
 * Histogram metering window. The bottom 45% of the weighted population is
 * discarded because in this game it is almost always empty water or true black,
 * and the top 5% because it is almost always a specular glint off a wave.
 *
 * IT IS A WINDOW ON THE METERED POOL, NOT ON THE FRAME, AND THE TWO SEPARATE IN
 * THE DEEP. `cs_histogram` drops everything below 1e-5 into bin 0 and `cs_adapt`
 * sums from bin 1, so the effective FRAME percentile window is
 * `excluded + (1 - excluded) * [0.45, 0.95]`. Measured over the fourteen biome
 * anchors: exactly 45-95 everywhere down to Twilight Terraces at 287 m, because
 * nothing there is below the gate, and then 53-96 / 65-97 / 68-97 / 73-98 at
 * Canyon Wall / Abyssal Plain / Trench Wall / Trench Floor, where 15-51% of the
 * frame carries no light at all.
 *
 * THAT DRIFT IS NOT A REASON TO MOVE THE WINDOW, and moving it is second-order
 * against the histogram floor either way. Re-measured on the real frames with
 * the bin quantisation removed, the exposure the same reduction asks for over
 * [0.20, 0.80] is 1.9x to 7.1x HIGHER than over [0.45, 0.95] at those four
 * stations - i.e. widening downward asks for more gain, which is the direction
 * the deep must not go. See RENDER.EXPOSURE_MIN_EV for why. Changing either
 * number here means re-deriving RENDER.EXPOSURE_KEY with it.
 */
const METER_LOW = 0.45;
const METER_HIGH = 0.95;

/** Base bloom strength before the user's 0..2 slider. */
const BLOOM_BASE_INTENSITY = 0.085;
/** Soft-knee width around BLOOM_THRESHOLD, in linear units. */
const BLOOM_KNEE = 0.45;
/** Upsample tent radius in destination texels. */
const BLOOM_UPSAMPLE_RADIUS = 1.0;

/** Seconds for the canopy to dry after surfacing. */
const LENS_DRY_RATE = 0.42;

/**
 * Per-depth colour grade. Keys sit on DEPTH_BANDS boundaries so the grade and
 * the simulation agree about where a band begins. Descending drains red first,
 * exactly as the water's Kd does physically, and lifts the black point toward the
 * water's own colour so that "black" underwater is never neutral - which is the
 * single most common mistake in underwater rendering.
 *
 * `lift` and `contrast` are CODE quantities and the tonemap applies them between
 * AgX's outset matrix and its EOTF. They were authored against a chain that was
 * missing that EOTF, so each lift has been re-derived as `old^(1/2.2)` - the exact
 * inverse of the pow the tonemap now applies - which holds the delivered black
 * floor of every band unchanged while the rest of the range is corrected.
 *
 * `sat` is deliberately 1.0 at every depth. It multiplies a SCENE-REFERRED
 * saturation about luminance, and any value below 1 mixes a blue pixel back
 * toward its own luma - which is to say it puts back exactly the red the water
 * just physically removed. At the old 0.42 the deepest band forced red to at
 * least 14% of every pixel's luminance no matter how little red actually
 * survived, and that is why the deep seabed read as flat pale blue-white. The
 * colour death with depth is the water's job; the grade must not fight it, and
 * must not fake it either.
 */
const GRADE_KEYS = [
  // Contrast in the daylight bands rose 0.14/0.14/0.16 -> 0.17/0.17/0.18 in
  // the same pass; the S-curve is display-referred and the deep bands keep
  // their own values, so contrast stays monotone with depth (checked by hand:
  // 0.17/0.17/0.18/0.18/0.20/0.22/0.24 - test-post asserts gain and sat
  // monotonicity but has NO contrast assertion, so this is a comment, not a
  // tested claim).
  { depth: DEPTH_BANDS[0].min, gain: [1.00, 1.00, 1.00], sat: 1.00, lift: [0.000, 0.000, 0.000], gamma: [1.00, 1.00, 1.00], contrast: 0.17 },
  // 2026-08-17 clarity pass: the green/blue lift in the daylight bands was cut
  // ~25% (band 1 [0, .059, .090] -> [0, .044, .068], bands 2-3 scaled the
  // same). A display-referred lift raises BLACKS toward blue-green, which is a
  // shadow desaturator - milky shadows were half of the "washed out" report.
  // Lift stays monotone-increasing with depth per channel (checked by hand;
  // test-post has no lift-monotonicity assertion).
  { depth: DEPTH_BANDS[1].min, gain: [0.98, 1.00, 1.02], sat: 1.00, lift: [0.000, 0.044, 0.068], gamma: [1.00, 1.00, 0.99], contrast: 0.17 },
  { depth: DEPTH_BANDS[2].min, gain: [0.86, 0.99, 1.06], sat: 1.00, lift: [0.000, 0.061, 0.101], gamma: [1.04, 1.00, 0.97], contrast: 0.18 },
  { depth: DEPTH_BANDS[3].min, gain: [0.62, 0.92, 1.10], sat: 1.00, lift: [0.000, 0.074, 0.127], gamma: [1.12, 1.02, 0.95], contrast: 0.18 },
  { depth: DEPTH_BANDS[4].min, gain: [0.40, 0.80, 1.12], sat: 1.00, lift: [0.000, 0.111, 0.197], gamma: [1.24, 1.05, 0.93], contrast: 0.20 },
  { depth: DEPTH_BANDS[5].min, gain: [0.28, 0.66, 1.10], sat: 1.00, lift: [0.059, 0.123, 0.215], gamma: [1.34, 1.08, 0.92], contrast: 0.22 },
  { depth: WORLD.MAX_DEPTH, gain: [0.22, 0.56, 1.06], sat: 1.00, lift: [0.081, 0.134, 0.226], gamma: [1.42, 1.10, 0.90], contrast: 0.24 },
];

const _grade = {
  gain: [1, 1, 1], sat: 1, lift: [0, 0, 0], gamma: [1, 1, 1], contrast: 0.06,
};

/** Evaluate the grade at a depth, smoothly across keys. Fills `_grade`. */
function evaluateGrade(depth) {
  const d = clamp(depth, 0, WORLD.MAX_DEPTH);
  let i = 0;
  while (i < GRADE_KEYS.length - 2 && d >= GRADE_KEYS[i + 1].depth) i++;
  const a = GRADE_KEYS[i];
  const b = GRADE_KEYS[i + 1];
  // smoothstep, not linear: a C1 blend means no visible seam as the camera
  // hovers exactly on a band boundary.
  const t = smoothstep(a.depth, b.depth, d);
  for (let c = 0; c < 3; c++) {
    _grade.gain[c] = lerp(a.gain[c], b.gain[c], t);
    _grade.lift[c] = lerp(a.lift[c], b.lift[c], t);
    _grade.gamma[c] = lerp(a.gamma[c], b.gamma[c], t);
  }
  _grade.sat = lerp(a.sat, b.sat, t);
  _grade.contrast = lerp(a.contrast, b.contrast, t);
  return _grade;
}

/** TAA is on only when both the user and the quality tier allow it. */
function taaEnabled(ctx) {
  return !!settings.get('taa') && !!ctx.gpu.preset.taa;
}

/** The target the rest of the chain reads: the TAA output, or the raw scene. */
function postSourceName(ctx) {
  return taaEnabled(ctx) ? ctx.history('taaHistory').current : 'sceneColor';
}

/**
 * Bind groups keyed by whatever makes them differ (a source view, a parity, a
 * mip index). Cleared wholesale on resize, when every view is invalidated.
 */
class BindGroupCache {
  constructor(label, layout) {
    this.label = label;
    this.layout = layout;
    this.map = new Map();
  }

  get(device, key, makeEntries) {
    let g = this.map.get(key);
    if (!g) {
      g = device.createBindGroup({ label: this.label, layout: this.layout, entries: makeEntries() });
      this.map.set(key, g);
    }
    return g;
  }

  clear() { this.map.clear(); }
}

/** Shared GPU state the exposure producer and its two consumers all need. */
function createSharedState() {
  return {
    exposureBuffer: null,
    readbackPool: [],
    ensure(ctx) {
      if (this.exposureBuffer) return this.exposureBuffer;
      this.exposureBuffer = createStorageBuffer(ctx.device, EXPOSURE_STATE_BYTES, 'exposure-state');
      // Three staging buffers: at most two frames are ever in flight, and the
      // third means a slow map never stalls the producer.
      for (let i = 0; i < 3; i++) {
        this.readbackPool.push({
          busy: false,
          buffer: createBuffer(ctx.device, {
            label: `exposure-readback-${i}`, size: 16,
            usage: BufferUsage.COPY_DST | BufferUsage.MAP_READ,
          }),
        });
      }
      return this.exposureBuffer;
    },
    destroy() {
      this.exposureBuffer?.destroy();
      this.exposureBuffer = null;
      for (const s of this.readbackPool) s.buffer.destroy();
      this.readbackPool.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// TAA
// ---------------------------------------------------------------------------

function createTaaPass(renderer) {
  let pipeline = null;
  let layout = null;
  let uniform = null;
  let cache = null;
  let historyFrames = 0;
  const params = new Float32Array(8);

  return {
    name: 'taa',
    type: 'render',
    reads: ['sceneColor', 'velocity', 'sceneDepth'],
    writes: ['taaHistoryA', 'taaHistoryB'],

    enabled(ctx) { return taaEnabled(ctx); },

    async init(ctx) {
      // Load the include graph before compiling: the renderer has no global
      // preload list, so each pass owns its own shader dependency.
      await ctx.shaders.loadRecursive('pass/taa.wgsl');
      const module = ctx.shaders.module('pass/taa.wgsl', {}, 'taa');
      uniform = createUniformBuffer(ctx.device, 32, 'taa.params');
      layout = ctx.pipelines.bindGroupLayout('taa.bgl', [
        { binding: 0, visibility: STAGE.F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: STAGE.F, texture: { sampleType: 'float' } },
        { binding: 2, visibility: STAGE.F, texture: { sampleType: 'float' } },
        { binding: 3, visibility: STAGE.F, texture: { sampleType: 'float' } },
        { binding: 4, visibility: STAGE.F, texture: { sampleType: 'depth' } },
      ]);
      cache = new BindGroupCache('taa.bg', layout);
      const format = ctx.targets.targets.get('taaHistoryA').desc.format;
      pipeline = ctx.pipelines.renderPipeline({
        label: 'taa',
        layout: ctx.pipelines.pipelineLayout('taa.pl', [renderer.frameLayout, layout]),
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: { module, entryPoint: 'fs_taa', targets: [{ format }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
      });
    },

    resize() {
      cache?.clear();
      historyFrames = 0;
    },

    /**
     * Drop the history without touching the bind groups. For a discontinuity
     * the reprojection cannot see coming - a time-of-day jump, a teleport -
     * where the previous frame is not a worse sample of this frame, it is a
     * sample of a different scene.
     */
    invalidateHistory() { historyFrames = 0; },

    execute(ctx, encoder) {
      if (!pipeline) return;
      const h = ctx.history('taaHistory');

      params[0] = RENDER.TAA_FEEDBACK_MIN;
      params[1] = RENDER.TAA_FEEDBACK_MAX;
      params[2] = 1.25;                       // variance clip gamma
      params[3] = 1.0;                        // velocity scale
      params[4] = 1 / ctx.width;
      params[5] = 1 / ctx.height;
      params[6] = ctx.width;
      params[7] = ctx.height;
      // The history texture holds nothing meaningful for the first two frames
      // (and after a resize), so run pure current-frame until it is populated.
      if (historyFrames < 2) { params[0] = 0; params[1] = 0; }
      ctx.device.queue.writeBuffer(uniform, 0, params);

      const bg = cache.get(ctx.device, h.previous, () => [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: ctx.targets.view('sceneColor') },
        { binding: 2, resource: ctx.targets.view(h.previous) },
        { binding: 3, resource: ctx.targets.view('velocity') },
        { binding: 4, resource: ctx.targets.view('sceneDepth') },
      ]);

      const pass = encoder.beginRenderPass(profiler.gpuPass({
        label: 'taa',
        colorAttachments: [colorAttachment(ctx.targets.view(h.current), { clear: { r: 0, g: 0, b: 0, a: 1 } })],
      }, 'taa'));
      pass.setPipeline(pipeline);
      pass.setBindGroup(GROUP.FRAME, ctx.frameBindGroup);
      pass.setBindGroup(GROUP.PASS, bg);
      pass.draw(3);
      pass.end();

      historyFrames++;
    },

    destroy() { uniform?.destroy(); uniform = null; },
  };
}

// ---------------------------------------------------------------------------
// Auto exposure
// ---------------------------------------------------------------------------

function createExposurePass(renderer, shared) {
  let histogramPipeline = null;
  let adaptPipeline = null;
  let layout = null;
  let uniform = null;
  let cache = null;
  const params = new Float32Array(16);

  return {
    name: 'exposure',
    type: 'compute',
    reads: ['sceneColor'],
    writes: [],

    async init(ctx) {
      await ctx.shaders.loadRecursive('pass/exposure.wgsl');
      const module = ctx.shaders.module('pass/exposure.wgsl', {}, 'exposure');
      shared.ensure(ctx);
      uniform = createUniformBuffer(ctx.device, 64, 'exposure.params');
      layout = ctx.pipelines.bindGroupLayout('exposure.bgl', [
        { binding: 0, visibility: STAGE.C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: STAGE.C, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: STAGE.C, buffer: { type: 'storage' } },
      ]);
      cache = new BindGroupCache('exposure.bg', layout);
      const pipelineLayout = ctx.pipelines.pipelineLayout('exposure.pl', [renderer.frameLayout, layout]);
      histogramPipeline = ctx.pipelines.computePipeline({
        label: 'exposure.histogram', layout: pipelineLayout,
        compute: { module, entryPoint: 'cs_histogram' },
      });
      adaptPipeline = ctx.pipelines.computePipeline({
        label: 'exposure.adapt', layout: pipelineLayout,
        compute: { module, entryPoint: 'cs_adapt' },
      });
    },

    resize() { cache?.clear(); },

    /**
     * Converge on the next frame instead of easing over several seconds.
     *
     * This writes zero to ExposureState.validPixels, which is the flag the
     * adapt shader already uses to mean "there is no previous exposure worth
     * keeping" - it seeds prevEV from the metered target, so the adaptation
     * step is a no-op and the image is correctly exposed immediately. Dark
     * adaptation is deliberately slow (EXPOSURE_SPEED_DOWN), which is right
     * when you swim into the abyss and wrong when the sun is teleported below
     * the horizon.
     */
    invalidate(device) {
      if (!shared.exposureBuffer) return;
      device.queue.writeBuffer(shared.exposureBuffer, EXPOSURE_TAIL_OFFSET + VALID_PIXELS_OFFSET, ZERO_F32);
    },

    execute(ctx, encoder) {
      if (!histogramPipeline) return;
      // Metering every pixel buys nothing: a 2x2 stride is 4x cheaper and the
      // histogram of a quarter of two million pixels is statistically identical.
      const stride = ctx.gpu.tier === 0 ? 3 : 2;
      const gw = Math.max(1, Math.floor(ctx.width / stride));
      const gh = Math.max(1, Math.floor(ctx.height / stride));

      params[0] = RENDER.EXPOSURE_MIN_EV;
      params[1] = RENDER.EXPOSURE_MAX_EV;
      params[2] = RENDER.EXPOSURE_SPEED_UP;
      params[3] = RENDER.EXPOSURE_SPEED_DOWN;
      params[4] = clamp(ctx.dt, 0, 0.1);
      params[5] = clamp(settings.get('exposureCompensation'), -2, 2);
      params[6] = METER_LOW;
      params[7] = METER_HIGH;
      params[8] = gw;
      params[9] = gh;
      params[10] = stride;
      params[11] = 0;
      params[12] = RENDER.EXPOSURE_KEY;
      // The histogram's low bin edge, which is NOT the metering floor in
      // params[0] - see the header of pass/exposure.wgsl. Passed as a uniform
      // rather than baked into the shader so it stays live-overridable, which is
      // what makes `HISTOGRAM_MIN_EV = EXPOSURE_MIN_EV` a one-line bisect.
      params[13] = RENDER.HISTOGRAM_MIN_EV;
      params[14] = 0; params[15] = 0;
      ctx.device.queue.writeBuffer(uniform, 0, params);

      const srcName = postSourceName(ctx);
      const srcView = ctx.targets.view(srcName);
      const bg = cache.get(ctx.device, srcView, () => [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: srcView },
        { binding: 2, resource: { buffer: shared.exposureBuffer } },
      ]);

      const pass = encoder.beginComputePass(profiler.gpuPass({ label: 'exposure' }, 'exposure'));
      pass.setPipeline(histogramPipeline);
      pass.setBindGroup(GROUP.FRAME, ctx.frameBindGroup);
      pass.setBindGroup(GROUP.PASS, bg);
      pass.dispatchWorkgroups(Math.ceil(gw / 16), Math.ceil(gh / 16), 1);
      pass.setPipeline(adaptPipeline);
      pass.dispatchWorkgroups(1, 1, 1);
      pass.end();

      // Mirror the GPU's exposure back to JS for the Frame uniform and the HUD
      // luminance adaptation. Non-blocking, two frames behind, and the shaders
      // that actually need it read the buffer directly, so the latency never
      // shows up in an image.
      const slot = shared.readbackPool.find((s) => !s.busy);
      if (slot) {
        encoder.copyBufferToBuffer(shared.exposureBuffer, EXPOSURE_TAIL_OFFSET, slot.buffer, 0, 16);
        slot.busy = true;
        queueMicrotask(() => {
          slot.buffer.mapAsync(GPUMapMode.READ).then(() => {
            const f = new Float32Array(slot.buffer.getMappedRange());
            const e = f[0];
            if (Number.isFinite(e) && e > 0) renderer.exposure = e;
            slot.buffer.unmap();
            slot.busy = false;
          }).catch(() => { slot.busy = false; });
        });
      }
    },

    destroy() { uniform?.destroy(); uniform = null; },
  };
}

// ---------------------------------------------------------------------------
// Bloom
// ---------------------------------------------------------------------------

function createBloomPass(renderer, shared) {
  let prefilter = null;
  let downsample = null;
  let upsample = null;
  let layout = null;
  let cache = null;
  /** @type {GPUBuffer[]} one 32-byte uniform per chain step. */
  let stepUniforms = [];
  /** Per-mip views and dimensions, resolved once per resize. */
  let mipViews = [];
  let mipDims = [];
  let mipCountUsed = 0;
  const scratch = new Float32Array(8);

  const writeStep = (ctx, index, srcW, srcH, threshold, knee, radius, karis) => {
    scratch[0] = 1 / srcW;
    scratch[1] = 1 / srcH;
    scratch[2] = srcW;
    scratch[3] = srcH;
    scratch[4] = threshold;
    scratch[5] = knee;
    scratch[6] = radius;
    scratch[7] = karis ? 1 : 0;
    ctx.device.queue.writeBuffer(stepUniforms[index], 0, scratch);
  };

  return {
    name: 'bloom',
    type: 'render',
    reads: ['sceneColor'],
    writes: ['bloomChain'],

    enabled(ctx) { return settings.get('bloom') > 0.001; },

    async init(ctx) {
      await ctx.shaders.loadRecursive('pass/bloom.wgsl');
      const module = ctx.shaders.module('pass/bloom.wgsl', {}, 'bloom');
      shared.ensure(ctx);
      layout = ctx.pipelines.bindGroupLayout('bloom.bgl', [
        { binding: 0, visibility: STAGE.F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: STAGE.F, texture: { sampleType: 'float' } },
        { binding: 2, visibility: STAGE.F, sampler: { type: 'filtering' } },
        { binding: 3, visibility: STAGE.F, buffer: { type: 'read-only-storage' } },
      ]);
      cache = new BindGroupCache('bloom.bg', layout);
      // bloom.wgsl declares its own resources at @group(1), following the
      // project-wide rule that group 0 is always the Frame. The pipeline layout
      // must therefore include the frame layout at slot 0 even though bloom
      // barely reads it, or the group indices do not line up.
      const pl = ctx.pipelines.pipelineLayout('bloom.pl', [renderer.frameLayout, layout]);
      const format = ctx.targets.targets.get('bloomChain').desc.format;

      prefilter = ctx.pipelines.renderPipeline({
        label: 'bloom.prefilter', layout: pl,
        vertex: { module, entryPoint: 'vs_bloom' },
        fragment: { module, entryPoint: 'fs_prefilter', targets: [{ format }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
      });
      downsample = ctx.pipelines.renderPipeline({
        label: 'bloom.downsample', layout: pl,
        vertex: { module, entryPoint: 'vs_bloom' },
        fragment: { module, entryPoint: 'fs_downsample', targets: [{ format }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
      });
      // Progressive upsample: each level ADDS into the level above it, which is
      // what turns a set of blurred mips into one wide, smooth kernel.
      upsample = ctx.pipelines.renderPipeline({
        label: 'bloom.upsample', layout: pl,
        vertex: { module, entryPoint: 'vs_bloom' },
        fragment: { module, entryPoint: 'fs_upsample', targets: [{ format, blend: Blend.additive }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
      });

      this.resize(ctx);
    },

    resize(ctx) {
      cache?.clear();
      for (const b of stepUniforms) b.destroy();
      stepUniforms = [];
      mipViews = [];
      mipDims = [];
      const size = ctx.targets.size('bloomChain');
      if (!size) { mipCountUsed = 0; return; }
      // Stop before a mip gets small enough that the 13-tap filter reaches
      // outside it, which turns the widest bloom level into a clamped smear.
      let n = 0;
      while (n < size.mips && Math.min(size.width >> n, size.height >> n) >= 8) n++;
      mipCountUsed = Math.max(1, n);
      const steps = mipCountUsed * 2;
      for (let i = 0; i < steps; i++) {
        stepUniforms.push(createUniformBuffer(ctx.device, 32, `bloom.step${i}`));
      }
      // Resolved here rather than in execute(): RenderTargets.subView keys its
      // cache by JSON.stringify, so asking for the same mip every frame would
      // allocate a descriptor and a string per chain step per frame.
      for (let m = 0; m < mipCountUsed; m++) {
        mipViews.push(ctx.targets.subView('bloomChain', {
          baseMipLevel: m, mipLevelCount: 1, dimension: '2d',
        }));
        mipDims.push({ w: Math.max(1, size.width >> m), h: Math.max(1, size.height >> m) });
      }
    },

    execute(ctx, encoder) {
      if (!prefilter || mipCountUsed === 0) return;
      const srcView = ctx.targets.view(postSourceName(ctx));
      const mipView = (m) => mipViews[m];
      const mipW = (m) => mipDims[m].w;
      const mipH = (m) => mipDims[m].h;

      const draw = (label, pipeline, dstView, dstW, dstH, bg, load) => {
        const pass = encoder.beginRenderPass(profiler.gpuPass({
          label,
          colorAttachments: [load
            ? colorAttachment(dstView, { loadOp: 'load' })
            : colorAttachment(dstView, { clear: { r: 0, g: 0, b: 0, a: 1 } })],
        }, label));
        pass.setViewport(0, 0, dstW, dstH, 0, 1);
        pass.setPipeline(pipeline);
        pass.setBindGroup(GROUP.FRAME, ctx.frameBindGroup);
        pass.setBindGroup(GROUP.PASS, bg);
        pass.draw(3);
        pass.end();
      };

      // --- threshold + first downsample -------------------------------------
      writeStep(ctx, 0, ctx.width, ctx.height, RENDER.BLOOM_THRESHOLD, BLOOM_KNEE, 0, true);
      draw('bloom.prefilter', prefilter, mipView(0), mipW(0), mipH(0),
        cache.get(ctx.device, srcView, () => [
          { binding: 0, resource: { buffer: stepUniforms[0] } },
          { binding: 1, resource: srcView },
          { binding: 2, resource: ctx.samplers.linearClamp },
          { binding: 3, resource: { buffer: shared.exposureBuffer } },
        ]), false);

      // --- downsample chain --------------------------------------------------
      for (let m = 1; m < mipCountUsed; m++) {
        writeStep(ctx, m, mipW(m - 1), mipH(m - 1), 0, 0, 0, false);
        draw(`bloom.down${m}`, downsample, mipView(m), mipW(m), mipH(m),
          cache.get(ctx.device, `down${m}`, () => [
            { binding: 0, resource: { buffer: stepUniforms[m] } },
            { binding: 1, resource: mipView(m - 1) },
            { binding: 2, resource: ctx.samplers.linearClamp },
            { binding: 3, resource: { buffer: shared.exposureBuffer } },
          ]), false);
      }

      // --- progressive upsample ---------------------------------------------
      for (let m = mipCountUsed - 1; m >= 1; m--) {
        const idx = mipCountUsed + m;
        writeStep(ctx, idx, mipW(m), mipH(m), 0, 0, BLOOM_UPSAMPLE_RADIUS, false);
        draw(`bloom.up${m}`, upsample, mipView(m - 1), mipW(m - 1), mipH(m - 1),
          cache.get(ctx.device, `up${m}`, () => [
            { binding: 0, resource: { buffer: stepUniforms[idx] } },
            { binding: 1, resource: mipView(m) },
            { binding: 2, resource: ctx.samplers.linearClamp },
            { binding: 3, resource: { buffer: shared.exposureBuffer } },
          ]), true);
      }
    },

    destroy() {
      for (const b of stepUniforms) b.destroy();
      stepUniforms = [];
      mipViews = [];
      mipDims = [];
    },
  };
}

// ---------------------------------------------------------------------------
// Tonemap + grade
// ---------------------------------------------------------------------------

function createTonemapPass(renderer, shared) {
  let pipeline = null;
  let layout = null;
  let uniform = null;
  let cache = null;
  const params = new Float32Array(16);

  return {
    name: 'tonemap',
    type: 'render',
    reads: ['sceneColor', 'bloomChain'],
    writes: ['resolved'],

    async init(ctx) {
      await ctx.shaders.loadRecursive('pass/tonemap.wgsl');
      const module = ctx.shaders.module('pass/tonemap.wgsl', {}, 'tonemap');
      shared.ensure(ctx);
      uniform = createUniformBuffer(ctx.device, 64, 'tonemap.params');
      layout = ctx.pipelines.bindGroupLayout('tonemap.bgl', [
        { binding: 0, visibility: STAGE.F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: STAGE.F, texture: { sampleType: 'float' } },
        { binding: 2, visibility: STAGE.F, texture: { sampleType: 'float' } },
        { binding: 3, visibility: STAGE.F, buffer: { type: 'read-only-storage' } },
      ]);
      cache = new BindGroupCache('tonemap.bg', layout);
      const format = ctx.targets.targets.get('resolved').desc.format;
      pipeline = ctx.pipelines.renderPipeline({
        label: 'tonemap',
        layout: ctx.pipelines.pipelineLayout('tonemap.pl', [renderer.frameLayout, layout]),
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: { module, entryPoint: 'fs_tonemap', targets: [{ format }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
      });
    },

    resize() { cache?.clear(); },

    execute(ctx, encoder) {
      if (!pipeline) return;
      // Above the surface the grade is neutral: the deep grade is the water's,
      // not the camera's.
      //
      // AND A DRY ROOM IS NEUTRAL TOO, which now has to be said explicitly.
      // `ctx.underwater` used to go false inside the habitat all by itself,
      // because Camera.isUnderwater conflated the medium with the eye's own air;
      // it does not any more, and without this clause the commons would take the
      // 33 m grade - a blue lift and a red pull-down modelling a water column
      // that is not between the eye and the wall. The depth grade is the
      // WATER's, so a sealed room gets the surface key.
      const g = evaluateGrade(ctx.underwater && !ctx.dryInterior ? ctx.cameraDepth : 0);
      // AND A CAVE IS NEUTRAL TOO, by the dry-room argument above one step
      // further: the depth grade models the open water COLUMN over the eye -
      // red drained, blacks lifted toward the water's blue - and a cave has a
      // roof where that column would be. At the Jellyshroom Hollow's 240 m
      // the band grade multiplied scene red by ~0.5 and lifted blue blacks
      // ~0.15 code, which turned every authored violet wall indigo whatever
      // the scene delivered (the third leg of the cave chroma fix; the two
      // sight-path legs are at waterTransmittance() in common/water.wgsl).
      // Faded on the SPRUNG enclosure times the same CAVE_SIGHT_NEUTRAL knob
      // - one concept, one bisect: inside a cave, the open-column colour
      // model stands down. Contrast relaxes to the surface key's 0.17.
      const cn = renderer.caveEnclosure * clamp(RENDER.CAVE_SIGHT_NEUTRAL ?? 0, 0, 1);
      if (cn > 0.001) {
        for (let c = 0; c < 3; c++) {
          g.gain[c] = lerp(g.gain[c], 1, cn);
          g.lift[c] = lerp(g.lift[c], 0, cn);
          g.gamma[c] = lerp(g.gamma[c], 1, cn);
        }
        g.contrast = lerp(g.contrast, 0.17, cn);
      }
      const bloomOn = settings.get('bloom') > 0.001;

      params[0] = g.lift[0]; params[1] = g.lift[1]; params[2] = g.lift[2];
      params[3] = g.contrast;
      params[4] = g.gain[0]; params[5] = g.gain[1]; params[6] = g.gain[2];
      params[7] = g.sat;
      params[8] = g.gamma[0]; params[9] = g.gamma[1]; params[10] = g.gamma[2];
      params[11] = bloomOn ? BLOOM_BASE_INTENSITY * settings.get('bloom') : 0;
      params[12] = RENDER.AGX_LOOK_POWER;
      params[13] = RENDER.AGX_LOOK_SATURATION;
      params[14] = 0; params[15] = 0;
      // EV compensation is NOT sent here: the adaptation pass folds it into the
      // exposure it publishes, so the bloom threshold and this tonemap both see
      // the same number and a stop of compensation is applied exactly once.
      ctx.device.queue.writeBuffer(uniform, 0, params);

      const srcView = ctx.targets.view(postSourceName(ctx));
      const bg = cache.get(ctx.device, srcView, () => [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: srcView },
        { binding: 2, resource: ctx.targets.subView('bloomChain', { baseMipLevel: 0, mipLevelCount: 1, dimension: '2d' }) },
        { binding: 3, resource: { buffer: shared.exposureBuffer } },
      ]);

      const pass = encoder.beginRenderPass(profiler.gpuPass({
        label: 'tonemap',
        colorAttachments: [colorAttachment(ctx.targets.view('resolved'), { clear: { r: 0, g: 0, b: 0, a: 1 } })],
      }, 'tonemap'));
      pass.setPipeline(pipeline);
      pass.setBindGroup(GROUP.FRAME, ctx.frameBindGroup);
      pass.setBindGroup(GROUP.PASS, bg);
      pass.draw(3);
      pass.end();
    },

    destroy() { uniform?.destroy(); uniform = null; },
  };
}

// ---------------------------------------------------------------------------
// Lens effects + final encode
// ---------------------------------------------------------------------------

function createLensPass(renderer) {
  let pipeline = null;
  let layout = null;
  let uniform = null;
  let cache = null;
  let wasUnderwater = false;
  let seeded = false;
  const params = new Float32Array(16);

  return {
    name: 'lens',
    type: 'render',
    reads: ['resolved'],
    writes: [],

    async init(ctx) {
      await ctx.shaders.loadRecursive('pass/lens.wgsl');
      const module = ctx.shaders.module('pass/lens.wgsl', {}, 'lens');
      uniform = createUniformBuffer(ctx.device, 64, 'lens.params');
      layout = ctx.pipelines.bindGroupLayout('lens.bgl', [
        { binding: 0, visibility: STAGE.F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: STAGE.F, texture: { sampleType: 'float' } },
      ]);
      cache = new BindGroupCache('lens.bg', layout);
      pipeline = ctx.pipelines.renderPipeline({
        label: 'lens',
        layout: ctx.pipelines.pipelineLayout('lens.pl', [renderer.frameLayout, layout]),
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: { module, entryPoint: 'fs_lens', targets: [{ format: ctx.gpu.presentFormat }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
      });
    },

    resize() { cache?.clear(); },

    execute(ctx, encoder) {
      if (!pipeline) return;
      const dt = clamp(ctx.dt, 0, 0.1);
      const state = renderer.lens;

      // Surfacing sheets the canopy. Breaking the surface downward does not:
      // the water is on the outside either way, but underwater there is no air
      // for it to bead against.
      //
      // AN AIRLOCK IS NOT SURFACING, and a teleport out of one is not either.
      // Cycling into the habitat used to fire this transition and sheet the
      // visor with beads that then dried over several seconds INSIDE the room.
      // Photographed from the commons that is a field of pale blobs drifting
      // across the walls, the dome and the furniture, and it looked exactly like
      // geometry or particles leaking through the hull; it was neither, and only
      // a session that had already been in the water showed it. The transition
      // being modelled is a water surface crossed into AIR, and a diver who
      // walks through an airlock has not crossed one.
      //
      // BOTH clauses below are load-bearing and they guard opposite mistakes.
      // `!inRoom` on the trigger is what stops the airlock sheeting the visor.
      // Latching `inWater` rather than `ctx.underwater` is what stops the
      // reverse: main.js clears the habitat latch on a J-teleport, so jumping
      // from the commons to a beach with the room latched as submerged sheets
      // the visor on dry land. That second half used to be free, because
      // Camera.isUnderwater turned itself off in a dry interior; it does not any
      // more - the camera is in the water and merely has air around it - so the
      // room has to be subtracted here explicitly.
      const inRoom = !!ctx.camera?.dryInterior;
      const inWater = ctx.underwater && !inRoom;
      if (seeded && wasUnderwater && !inWater && !inRoom) state.wetness = 1;
      wasUnderwater = inWater;
      seeded = true;
      if (inWater) {
        state.wetness = 0;
      } else {
        state.wetness = Math.max(0, state.wetness - LENS_DRY_RATE * dt);
      }

      const wet = settings.get('lensWater') ? saturate(state.wetness) : 0;

      params[0] = clamp(settings.get('chromaticAberration'), 0, 1);
      params[1] = clamp(settings.get('vignette'), 0, 1);
      params[2] = clamp(settings.get('filmGrain'), 0, 1);
      params[3] = wet;
      params[4] = ctx.time;
      params[5] = ctx.gpu.width / Math.max(1, ctx.gpu.height);
      // The fine mist layer is the expensive half of the droplet effect; the
      // lowest tier does without it.
      params[6] = ctx.gpu.tier > 0 ? 1 : 0;
      params[7] = saturate(state.stress);
      params[8] = 0.010;   // airflow drag per m/s
      params[9] = 0.55;    // bead fall rate
      params[10] = 1.0;    // bead scale
      params[11] = 0.85;   // refraction strength
      params[12] = clamp(settings.get('sharpness'), 0, 1);
      params[13] = 1 / Math.max(1, ctx.width);
      params[14] = 1 / Math.max(1, ctx.height);
      // The showcase demo's fade to black - see Renderer.demoFade for why the
      // HUD pass carries the other half of it. Transported in the lens params'
      // one spare slot rather than as a Frame field: the Frame struct is the
      // project's tightest byte contract (tools/test-layout.mjs exists to
      // police it), and both consumers of this scalar already own a per-pass
      // uniform with room in it.
      params[15] = saturate(renderer.demoFade);
      ctx.device.queue.writeBuffer(uniform, 0, params);

      const srcView = ctx.targets.view('resolved');
      const bg = cache.get(ctx.device, srcView, () => [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: srcView },
      ]);

      const pass = encoder.beginRenderPass(profiler.gpuPass({
        label: 'lens',
        colorAttachments: [colorAttachment(ctx.outputView, { clear: { r: 0, g: 0, b: 0, a: 1 } })],
      }, 'lens'));
      pass.setPipeline(pipeline);
      pass.setBindGroup(GROUP.FRAME, ctx.frameBindGroup);
      pass.setBindGroup(GROUP.PASS, bg);
      pass.draw(3);
      pass.end();
    },

    destroy() { uniform?.destroy(); uniform = null; },
  };
}

// ---------------------------------------------------------------------------

/**
 * Build the post chain. Register the returned passes in order.
 *
 * Also publishes `renderer.lens`, the small mutable block the HUD writes its
 * stress level into, and sets `_postWritesSwapChain` so the fallback present
 * pass stands down.
 *
 * @param {import('../renderer.js').Renderer} renderer
 * @returns {Array<object>} frame-graph passes in execution order
 */
export function createPostPasses(renderer) {
  renderer._postWritesSwapChain = true;
  renderer.lens = { wetness: 0, stress: 0 };

  const shared = createSharedState();
  const passes = [
    createTaaPass(renderer),
    createExposurePass(renderer, shared),
    createBloomPass(renderer, shared),
    createTonemapPass(renderer, shared),
    createLensPass(renderer),
  ];
  // The shared exposure buffer outlives every individual pass, so its teardown
  // hangs off the last one rather than being freed three times.
  const last = passes[passes.length - 1];
  const ownDestroy = last.destroy;
  last.destroy = () => {
    ownDestroy?.call(last);
    shared.destroy();
  };
  return passes;
}

export { evaluateGrade, GRADE_KEYS, EXPOSURE_STATE_BYTES };
