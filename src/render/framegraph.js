/**
 * SUBWAVE frame graph.
 *
 * A pass registry with explicit ordering and declared resource usage. It is
 * deliberately NOT a fully automatic render graph with barrier inference -
 * WebGPU already handles synchronisation between passes on the same queue, so
 * paying for graph compilation every frame would buy us nothing.
 *
 * What it DOES buy us:
 *   - one place that states the frame's pass order, which is the single most
 *     important piece of documentation in a renderer
 *   - per-pass enable/disable by quality tier and by settings, without every
 *     pass having to branch internally
 *   - automatic GPU timestamp scoping for the profiler
 *   - a resource declaration that catches "pass B reads a target pass A never
 *     wrote" at startup rather than as a black screen
 *
 * A Pass is a plain object:
 *   {
 *     name, type: 'render'|'compute',
 *     reads: [...targetNames], writes: [...targetNames],
 *     enabled(ctx) -> bool,        // optional
 *     init(ctx),                   // optional, once, after targets exist
 *     resize(ctx),                 // optional, on render-resolution change
 *     execute(ctx, encoder),       // required
 *     destroy(),                   // optional
 *   }
 */

import { profiler } from '../core/profiler.js';

/** Shared context handed to every pass. */
export class FrameContext {
  constructor({ gpu, shaders, pipelines, targets, samplers, uniforms, world, scene }) {
    this.gpu = gpu;
    this.device = gpu.device;
    this.shaders = shaders;
    this.pipelines = pipelines;
    this.targets = targets;
    this.samplers = samplers;
    this.uniforms = uniforms;

    /** Populated per frame by the renderer. */
    this.world = world || null;
    this.scene = scene || null;
    this.camera = null;
    this.frameBindGroup = null;
    this.frameIndex = 0;
    this.time = 0;
    this.dt = 0;
    /** The swap-chain view for this frame. */
    this.outputView = null;
    /** Set by the renderer each frame; passes read it instead of recomputing. */
    this.underwater = false;
    /**
     * The EYE is sealed in a dry volume below sea level - today, the habitat.
     * INDEPENDENT of `underwater`, and both are true at once inside the station:
     * the camera is in the water and merely has air around it. See
     * Camera.isUnderwater for the five contracts conflating them used to break.
     */
    this.dryInterior = false;
    this.cameraDepth = 0;
    /** Ping-pong parity for history buffers (TAA, volumetrics). */
    this.parity = 0;
  }

  get preset() { return this.gpu.preset; }
  get width() { return this.gpu.renderWidth; }
  get height() { return this.gpu.renderHeight; }

  /** Current and previous history target names for a ping-ponged resource. */
  history(base) {
    return this.parity === 0
      ? { current: `${base}A`, previous: `${base}B` }
      : { current: `${base}B`, previous: `${base}A` };
  }
}

export class FrameGraph {
  constructor(ctx) {
    this.ctx = ctx;
    /** @type {Array<object>} in execution order */
    this.passes = [];
    this.byName = new Map();
    this.initialised = false;
    this._disabled = new Set();
  }

  /** Register a pass. Order of registration IS execution order. */
  add(pass) {
    if (!pass.name) throw new Error('[FrameGraph] pass has no name');
    if (this.byName.has(pass.name)) throw new Error(`[FrameGraph] duplicate pass '${pass.name}'`);
    if (typeof pass.execute !== 'function') {
      throw new Error(`[FrameGraph] pass '${pass.name}' has no execute()`);
    }
    pass.type = pass.type || 'render';
    pass.reads = pass.reads || [];
    pass.writes = pass.writes || [];
    this.passes.push(pass);
    this.byName.set(pass.name, pass);
    return this;
  }

  /** Insert a pass immediately before a named one. */
  addBefore(name, pass) {
    const i = this.passes.findIndex((p) => p.name === name);
    if (i < 0) throw new Error(`[FrameGraph] no pass named '${name}'`);
    this.add(pass);
    this.passes.pop();
    this.passes.splice(i, 0, pass);
    return this;
  }

  /**
   * Validate that every resource a pass reads is either produced by an earlier
   * pass or exists as a persistent (history) target. Catches wiring mistakes at
   * startup instead of as an inexplicably black screen.
   */
  validate() {
    const produced = new Set();
    const problems = [];
    for (const pass of this.passes) {
      for (const r of pass.reads) {
        const isPersistent = /History|Prev|prev/.test(r);
        if (!produced.has(r) && !isPersistent) {
          problems.push(`pass '${pass.name}' reads '${r}' before any pass writes it`);
        }
      }
      for (const w of pass.writes) produced.add(w);
    }
    // Every declared target must actually be registered with RenderTargets.
    for (const pass of this.passes) {
      for (const name of [...pass.reads, ...pass.writes]) {
        if (!this.ctx.targets.targets.has(name) && !/^_/.test(name)) {
          problems.push(`pass '${pass.name}' references unknown target '${name}'`);
        }
      }
    }
    if (problems.length) {
      console.error('[FrameGraph] validation problems:\n  ' + problems.join('\n  '));
    }
    return problems;
  }

  async init() {
    for (const pass of this.passes) {
      if (pass.init) await pass.init(this.ctx);
    }
    this.initialised = true;
    this.validate();
  }

  resize() {
    for (const pass of this.passes) {
      if (pass.resize) pass.resize(this.ctx);
    }
  }

  /** Force a pass off regardless of its own enabled() check. Debug aid. */
  setDisabled(name, disabled) {
    if (disabled) this._disabled.add(name);
    else this._disabled.delete(name);
  }

  isEnabled(pass) {
    if (this._disabled.has(pass.name)) return false;
    if (pass.enabled && !pass.enabled(this.ctx)) return false;
    return true;
  }

  /** Run every enabled pass in order into `encoder`. */
  execute(encoder) {
    const ctx = this.ctx;
    for (let i = 0; i < this.passes.length; i++) {
      const pass = this.passes[i];
      if (!this.isEnabled(pass)) continue;
      // The pass opens its own GPURenderPassEncoder; we only scope CPU time here.
      // GPU timing is attached inside the pass via profiler.gpuPass(desc, name).
      profiler.cpu(pass.name);
      try {
        pass.execute(ctx, encoder);
      } catch (err) {
        console.error(`[FrameGraph] pass '${pass.name}' threw:`, err);
        // Disable a repeatedly-throwing pass rather than spam the console at 60 Hz.
        this._disabled.add(pass.name);
        console.error(`[FrameGraph] pass '${pass.name}' disabled for the rest of the session.`);
      }
      profiler.cpuEnd(pass.name);
    }
  }

  destroy() {
    for (const pass of this.passes) {
      if (pass.destroy) {
        try { pass.destroy(); } catch (e) { console.error(e); }
      }
    }
    this.passes.length = 0;
    this.byName.clear();
  }

  /** Human-readable listing for the debug overlay. */
  describe() {
    return this.passes.map((p) => {
      const state = this.isEnabled(p) ? ' ' : 'x';
      return `${state} ${p.type === 'compute' ? 'C' : 'R'} ${p.name}`;
    }).join('\n');
  }
}
