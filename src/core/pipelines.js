/**
 * SUBWAVE pipeline & bind-group cache.
 *
 * Creating pipelines is expensive and they are highly reusable, so everything
 * goes through a content-addressed cache keyed by its full descriptor.
 *
 * Also home to the project-wide render-state presets. The reverse-Z depth
 * convention (clear 0.0, compare 'greater') lives here so no pass can get it
 * wrong by accident.
 */

const REVERSE_Z_COMPARE = 'greater';
const REVERSE_Z_COMPARE_EQUAL = 'greater-equal';
export const DEPTH_CLEAR_VALUE = 0.0;

/** Standard depth-stencil states. Every pass should use one of these. */
export const DepthState = {
  /** Writes depth, tests greater (reverse-Z). Opaque geometry. */
  opaque: (format = 'depth32float') => ({
    format, depthWriteEnabled: true, depthCompare: REVERSE_Z_COMPARE,
  }),
  /** Tests equal-ish without writing. Use after a depth prepass. */
  equalNoWrite: (format = 'depth32float') => ({
    format, depthWriteEnabled: false, depthCompare: 'equal',
  }),
  /** Tests but does not write. Transparents, decals, volumetric composites. */
  testNoWrite: (format = 'depth32float') => ({
    format, depthWriteEnabled: false, depthCompare: REVERSE_Z_COMPARE,
  }),
  testNoWriteInclusive: (format = 'depth32float') => ({
    format, depthWriteEnabled: false, depthCompare: REVERSE_Z_COMPARE_EQUAL,
  }),
  /** No test, no write. Fullscreen passes that still need an attachment. */
  none: (format = 'depth32float') => ({
    format, depthWriteEnabled: false, depthCompare: 'always',
  }),
  /** Shadow casting: depth only, slope-scaled bias applied here. */
  shadow: (format = 'depth32float', constantBias = 0, slopeBias = 0, clamp = 0) => ({
    format, depthWriteEnabled: true, depthCompare: REVERSE_Z_COMPARE,
    depthBias: constantBias, depthBiasSlopeScale: slopeBias, depthBiasClamp: clamp,
  }),
};

/** Standard colour blend states. */
export const Blend = {
  none: undefined,
  alpha: {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  },
  /** Premultiplied alpha - what our particle and UI compositing use. */
  premultiplied: {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  },
  additive: {
    color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  },
  /** Emissive/bioluminescent sprites: additive but respecting source alpha. */
  additiveAlpha: {
    color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
    alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
  },
  multiply: {
    color: { srcFactor: 'dst', dstFactor: 'zero', operation: 'add' },
    alpha: { srcFactor: 'dst-alpha', dstFactor: 'zero', operation: 'add' },
  },
};

/** Common primitive states. */
export const Primitive = {
  triangles: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
  trianglesNoCull: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
  trianglesFrontCull: { topology: 'triangle-list', cullMode: 'front', frontFace: 'ccw' },
  strip: { topology: 'triangle-strip', cullMode: 'back', frontFace: 'ccw', stripIndexFormat: 'uint32' },
  lines: { topology: 'line-list' },
  points: { topology: 'point-list' },
};

/** Bind group slot assignment. BINDING across the whole renderer. */
export const GROUP = {
  FRAME: 0,     // per-frame uniforms, sky/water LUTs, shadow atlas, cluster lists
  PASS: 1,      // per-pass inputs (source textures, pass constants)
  MATERIAL: 2,  // material uniforms + textures
  DRAW: 3,      // per-draw / per-instance data
};

// ---------------------------------------------------------------------------

let nextKeyId = 1;
const objectKeys = new WeakMap();

/** Stable identity key for a GPU object (shader module, layout, ...). */
function objKey(o) {
  if (o == null) return 'null';
  let k = objectKeys.get(o);
  if (!k) {
    k = 'o' + nextKeyId++;
    objectKeys.set(o, k);
  }
  return k;
}

/** Deterministic descriptor -> string, resolving GPU objects to stable ids. */
function descKey(v) {
  if (v === null || v === undefined) return 'n';
  const t = typeof v;
  if (t === 'number' || t === 'boolean') return String(v);
  if (t === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(descKey).join(',') + ']';
  if (t === 'object') {
    // GPU objects are opaque - identify them by reference.
    if (v instanceof GPUShaderModule || v instanceof GPUBindGroupLayout ||
        v instanceof GPUPipelineLayout || v instanceof GPUTextureView ||
        v instanceof GPUSampler || v instanceof GPUBuffer || v instanceof GPUTexture) {
      return objKey(v);
    }
    const keys = Object.keys(v).sort();
    return '{' + keys.map((k) => k + ':' + descKey(v[k])).join(',') + '}';
  }
  return String(v);
}

export class PipelineCache {
  constructor(device) {
    this.device = device;
    this.render = new Map();
    this.compute = new Map();
    this.layouts = new Map();
    this.pipelineLayouts = new Map();
    this.bindGroups = new Map();
    this.stats = { renderCreated: 0, computeCreated: 0, hits: 0, layoutsCreated: 0, bindGroupsCreated: 0 };
  }

  /** Cached bind group layout. */
  bindGroupLayout(label, entries) {
    const key = label + '|' + descKey(entries);
    let l = this.layouts.get(key);
    if (!l) {
      l = this.device.createBindGroupLayout({ label, entries });
      this.layouts.set(key, l);
      this.stats.layoutsCreated++;
    }
    return l;
  }

  /** Cached pipeline layout from an ordered list of bind group layouts. */
  pipelineLayout(label, bindGroupLayouts) {
    const key = label + '|' + bindGroupLayouts.map(objKey).join(',');
    let l = this.pipelineLayouts.get(key);
    if (!l) {
      l = this.device.createPipelineLayout({ label, bindGroupLayouts });
      this.pipelineLayouts.set(key, l);
    }
    return l;
  }

  /** Cached bind group. Only cache groups whose resources are stable! */
  bindGroup(label, layout, entries) {
    const key = label + '|' + objKey(layout) + '|' + descKey(entries);
    let g = this.bindGroups.get(key);
    if (!g) {
      g = this.device.createBindGroup({ label, layout, entries });
      this.bindGroups.set(key, g);
      this.stats.bindGroupsCreated++;
    }
    return g;
  }

  /**
   * Cached render pipeline.
   * `desc` is a standard GPURenderPipelineDescriptor; `layout` defaults to 'auto'.
   */
  renderPipeline(desc) {
    const key = descKey(desc);
    let p = this.render.get(key);
    if (p) { this.stats.hits++; return p; }
    p = this.device.createRenderPipeline({ layout: 'auto', ...desc });
    this.render.set(key, p);
    this.stats.renderCreated++;
    return p;
  }

  /** Async variant - avoids a main-thread stall on first use. */
  async renderPipelineAsync(desc) {
    const key = descKey(desc);
    let p = this.render.get(key);
    if (p) { this.stats.hits++; return p; }
    p = await this.device.createRenderPipelineAsync({ layout: 'auto', ...desc });
    this.render.set(key, p);
    this.stats.renderCreated++;
    return p;
  }

  computePipeline(desc) {
    const key = descKey(desc);
    let p = this.compute.get(key);
    if (p) { this.stats.hits++; return p; }
    p = this.device.createComputePipeline({ layout: 'auto', ...desc });
    this.compute.set(key, p);
    this.stats.computeCreated++;
    return p;
  }

  async computePipelineAsync(desc) {
    const key = descKey(desc);
    let p = this.compute.get(key);
    if (p) { this.stats.hits++; return p; }
    p = await this.device.createComputePipelineAsync({ layout: 'auto', ...desc });
    this.compute.set(key, p);
    this.stats.computeCreated++;
    return p;
  }

  /** Drop everything (after a shader hot-reload). */
  clear() {
    this.render.clear();
    this.compute.clear();
    this.bindGroups.clear();
  }
}

// ---------------------------------------------------------------------------
// Bind group layout construction helpers
// ---------------------------------------------------------------------------

// Mirrored so Node-side tools can import this module without a GPU. See the
// equivalent note in core/resources.js.
const S = globalThis.GPUShaderStage || { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
export const STAGE = {
  V: S.VERTEX,
  F: S.FRAGMENT,
  C: S.COMPUTE,
  VF: S.VERTEX | S.FRAGMENT,
  VFC: S.VERTEX | S.FRAGMENT | S.COMPUTE,
  FC: S.FRAGMENT | S.COMPUTE,
};

/** Fluent builder for bind group layout entries + matching bind group entries. */
export class BindGroupBuilder {
  constructor(label = 'bindgroup') {
    this.label = label;
    this.layoutEntries = [];
    this.entries = [];
    this.binding = 0;
  }

  _next() { return this.binding++; }

  uniform(resource, visibility = STAGE.VFC, { hasDynamicOffset = false, minBindingSize } = {}) {
    const b = this._next();
    this.layoutEntries.push({ binding: b, visibility, buffer: { type: 'uniform', hasDynamicOffset, minBindingSize } });
    this.entries.push({ binding: b, resource: resource.buffer ? resource : { buffer: resource } });
    return this;
  }

  storage(resource, visibility = STAGE.C, readOnly = true, { hasDynamicOffset = false } = {}) {
    const b = this._next();
    this.layoutEntries.push({
      binding: b, visibility,
      buffer: { type: readOnly ? 'read-only-storage' : 'storage', hasDynamicOffset },
    });
    this.entries.push({ binding: b, resource: resource.buffer ? resource : { buffer: resource } });
    return this;
  }

  texture(view, visibility = STAGE.FC, {
    sampleType = 'float', viewDimension = '2d', multisampled = false,
  } = {}) {
    const b = this._next();
    this.layoutEntries.push({ binding: b, visibility, texture: { sampleType, viewDimension, multisampled } });
    this.entries.push({ binding: b, resource: view });
    return this;
  }

  /** Non-filterable float texture (rgba32float, and rgba16float without the feature). */
  textureUnfilterable(view, visibility = STAGE.FC, viewDimension = '2d') {
    return this.texture(view, visibility, { sampleType: 'unfilterable-float', viewDimension });
  }

  depthTexture(view, visibility = STAGE.FC, viewDimension = '2d') {
    const b = this._next();
    this.layoutEntries.push({ binding: b, visibility, texture: { sampleType: 'depth', viewDimension } });
    this.entries.push({ binding: b, resource: view });
    return this;
  }

  storageTexture(view, visibility = STAGE.C, { format, access = 'write-only', viewDimension = '2d' }) {
    const b = this._next();
    this.layoutEntries.push({ binding: b, visibility, storageTexture: { access, format, viewDimension } });
    this.entries.push({ binding: b, resource: view });
    return this;
  }

  sampler(samplerObj, visibility = STAGE.FC, type = 'filtering') {
    const b = this._next();
    this.layoutEntries.push({ binding: b, visibility, sampler: { type } });
    this.entries.push({ binding: b, resource: samplerObj });
    return this;
  }

  comparisonSampler(samplerObj, visibility = STAGE.FC) {
    return this.sampler(samplerObj, visibility, 'comparison');
  }

  nonFilteringSampler(samplerObj, visibility = STAGE.FC) {
    return this.sampler(samplerObj, visibility, 'non-filtering');
  }

  /** Build (or fetch from cache) the layout. */
  buildLayout(cache) {
    return cache.bindGroupLayout(this.label + '.layout', this.layoutEntries);
  }

  /** Build layout + bind group together. Returns {layout, group}. */
  build(cache, { cached = false } = {}) {
    const layout = this.buildLayout(cache);
    const group = cached
      ? cache.bindGroup(this.label, layout, this.entries)
      : cache.device.createBindGroup({ label: this.label, layout, entries: this.entries });
    return { layout, group };
  }
}

// ---------------------------------------------------------------------------
// Vertex layout helpers
// ---------------------------------------------------------------------------

const FORMAT_SIZE = {
  float32: 4, float32x2: 8, float32x3: 12, float32x4: 16,
  float16x2: 4, float16x4: 8,
  uint32: 4, uint32x2: 8, uint32x3: 12, uint32x4: 16,
  sint32: 4, sint32x2: 8, sint32x3: 12, sint32x4: 16,
  unorm8x2: 2, unorm8x4: 4, snorm8x2: 2, snorm8x4: 4,
  unorm16x2: 4, unorm16x4: 8, snorm16x2: 4, snorm16x4: 8,
  uint8x2: 2, uint8x4: 4, sint8x2: 2, sint8x4: 4,
  uint16x2: 4, uint16x4: 8, sint16x2: 4, sint16x4: 8,
};

/**
 * Build a GPUVertexBufferLayout from a list of [shaderLocation, format],
 * packing attributes tightly in declaration order.
 *
 *   vertexLayout([[0,'float32x3'],[1,'float32x3'],[2,'float32x2']])
 *   -> {arrayStride: 32, attributes: [...]}
 */
export function vertexLayout(attrs, stepMode = 'vertex') {
  let offset = 0;
  const attributes = attrs.map(([shaderLocation, format]) => {
    const a = { shaderLocation, format, offset };
    const size = FORMAT_SIZE[format];
    if (size === undefined) throw new Error(`[vertexLayout] unknown format '${format}'`);
    offset += size;
    return a;
  });
  return { arrayStride: offset, stepMode, attributes };
}

export const vertexFormatSize = (f) => FORMAT_SIZE[f] || 0;

// ---------------------------------------------------------------------------
// Fullscreen pass helper
// ---------------------------------------------------------------------------

/**
 * Every post/composite pass is a single oversized triangle with no vertex
 * buffer; the vertex shader in `common/fullscreen.wgsl` derives position and UV
 * from `vertex_index`. Draw with `pass.draw(3)`.
 */
export const FULLSCREEN_VERTEX_COUNT = 3;

/** Colour attachment descriptor shorthand. */
export function colorAttachment(view, {
  clear = null, loadOp, storeOp = 'store', resolveTarget,
} = {}) {
  return {
    view,
    resolveTarget,
    clearValue: clear || { r: 0, g: 0, b: 0, a: 0 },
    loadOp: loadOp || (clear ? 'clear' : 'load'),
    storeOp,
  };
}

/** Depth attachment shorthand. Defaults follow the reverse-Z convention. */
export function depthAttachment(view, {
  clear = true, loadOp, storeOp = 'store', readOnly = false, clearValue = DEPTH_CLEAR_VALUE,
} = {}) {
  if (readOnly) {
    return { view, depthReadOnly: true };
  }
  return {
    view,
    depthClearValue: clearValue,
    depthLoadOp: loadOp || (clear ? 'clear' : 'load'),
    depthStoreOp: storeOp,
  };
}
