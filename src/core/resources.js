/**
 * SUBWAVE GPU resource helpers.
 *
 * Thin, allocation-conscious wrappers over the raw WebGPU objects:
 *   - typed buffer creation + writes with correct 4-byte alignment
 *   - a growable uniform ring so per-draw constants never stall the GPU
 *   - render target allocation that survives resize
 *   - a shared sampler cache
 *   - std140-ish struct writers for the Frame uniform and friends
 *
 * Nothing here knows about the game. It is pure plumbing.
 */

import { alignUp } from './math.js';

// WebGPU exposes these as globals only in a browser. Mirror the spec's values
// so this module can also be imported by Node-side tools and tests (the byte
// layout verifier in particular) without a GPU present.
const U = globalThis.GPUBufferUsage || {
  MAP_READ: 0x0001, MAP_WRITE: 0x0002, COPY_SRC: 0x0004, COPY_DST: 0x0008,
  INDEX: 0x0010, VERTEX: 0x0020, UNIFORM: 0x0040, STORAGE: 0x0080,
  INDIRECT: 0x0100, QUERY_RESOLVE: 0x0200,
};
const T = globalThis.GPUTextureUsage || {
  COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10,
};

// ---------------------------------------------------------------------------
// Buffers
// ---------------------------------------------------------------------------

/**
 * Create a GPUBuffer, optionally seeding it from a TypedArray.
 * Buffer size is always rounded up to 4 bytes as required by WebGPU.
 */
export function createBuffer(device, { label, size, usage, data, mappedAtCreation = false }) {
  const byteSize = alignUp(size != null ? size : data.byteLength, 4);
  const buffer = device.createBuffer({
    label,
    size: byteSize,
    usage,
    mappedAtCreation: mappedAtCreation || !!data,
  });
  if (data) {
    const Ctor = data.constructor;
    new Ctor(buffer.getMappedRange()).set(data);
    buffer.unmap();
  } else if (mappedAtCreation) {
    buffer.unmap();
  }
  return buffer;
}

export const createVertexBuffer = (device, data, label = 'vertex') =>
  createBuffer(device, { label, data, usage: U.VERTEX | U.COPY_DST });

export const createIndexBuffer = (device, data, label = 'index') =>
  createBuffer(device, { label, data, usage: U.INDEX | U.COPY_DST });

export const createUniformBuffer = (device, size, label = 'uniform') =>
  createBuffer(device, { label, size, usage: U.UNIFORM | U.COPY_DST });

export const createStorageBuffer = (device, sizeOrData, label = 'storage', extraUsage = 0) => {
  const isData = ArrayBuffer.isView(sizeOrData);
  return createBuffer(device, {
    label,
    size: isData ? sizeOrData.byteLength : sizeOrData,
    data: isData ? sizeOrData : undefined,
    usage: U.STORAGE | U.COPY_DST | U.COPY_SRC | extraUsage,
  });
};

export const createIndirectBuffer = (device, sizeOrData, label = 'indirect') => {
  const isData = ArrayBuffer.isView(sizeOrData);
  return createBuffer(device, {
    label,
    size: isData ? sizeOrData.byteLength : sizeOrData,
    data: isData ? sizeOrData : undefined,
    usage: U.INDIRECT | U.STORAGE | U.COPY_DST | U.COPY_SRC,
  });
};

/** Write a TypedArray into a buffer, honouring the 4-byte size alignment rule. */
export function writeBuffer(device, buffer, data, bufferOffset = 0, dataOffsetElems = 0, sizeElems = undefined) {
  const count = sizeElems != null ? sizeElems : data.length - dataOffsetElems;
  // writeBuffer's size argument is in elements for TypedArrays; the byte count
  // it derives must still be a multiple of 4.
  const bytesPerElem = data.BYTES_PER_ELEMENT;
  const byteCount = count * bytesPerElem;
  if (byteCount % 4 === 0) {
    device.queue.writeBuffer(buffer, bufferOffset, data, dataOffsetElems, count);
  } else {
    const padded = alignUp(byteCount, 4) / bytesPerElem;
    device.queue.writeBuffer(buffer, bufferOffset, data, dataOffsetElems, Math.min(padded, data.length - dataOffsetElems));
  }
}

/**
 * A CPU-side scratch buffer paired with a GPU buffer, for data that is rebuilt
 * every frame (instance lists, light lists, particle spawns).
 * Grows geometrically and reallocates the GPU buffer when it must.
 */
export class DynamicBuffer {
  /**
   * @param {GPUDevice} device
   * @param {{label?: string, usage: number, capacity?: number, ArrayType?: Function, stride: number}} opts
   *   stride is in ELEMENTS of ArrayType, not bytes.
   */
  constructor(device, opts) {
    this.device = device;
    this.label = opts.label || 'dynamic';
    this.usage = opts.usage | U.COPY_DST;
    this.ArrayType = opts.ArrayType || Float32Array;
    this.stride = opts.stride;
    this.capacity = Math.max(1, opts.capacity || 256);
    this.count = 0;
    this.cpu = new this.ArrayType(this.capacity * this.stride);
    this.gpu = createBuffer(device, {
      label: this.label,
      size: this.cpu.byteLength,
      usage: this.usage,
    });
    this.generation = 0;
  }

  get byteStride() { return this.stride * this.cpu.BYTES_PER_ELEMENT; }

  clear() { this.count = 0; }

  /** Ensure room for `n` total items, reallocating if needed. */
  reserve(n) {
    if (n <= this.capacity) return false;
    let cap = this.capacity;
    while (cap < n) cap = Math.ceil(cap * 1.6);
    const next = new this.ArrayType(cap * this.stride);
    next.set(this.cpu.subarray(0, this.count * this.stride));
    this.cpu = next;
    this.gpu.destroy();
    this.gpu = createBuffer(this.device, {
      label: this.label,
      size: next.byteLength,
      usage: this.usage,
    });
    this.capacity = cap;
    this.generation++;
    return true;
  }

  /** Reserve one item and return its base index into `cpu`. */
  push() {
    this.reserve(this.count + 1);
    return this.count++ * this.stride;
  }

  /** Upload the used range. Returns the byte length written. */
  upload() {
    const elems = this.count * this.stride;
    if (elems === 0) return 0;
    const bytes = alignUp(elems * this.cpu.BYTES_PER_ELEMENT, 4);
    const elemsPadded = bytes / this.cpu.BYTES_PER_ELEMENT;
    this.device.queue.writeBuffer(this.gpu, 0, this.cpu, 0, Math.min(elemsPadded, this.cpu.length));
    return bytes;
  }

  destroy() { this.gpu.destroy(); }
}

/**
 * Sub-allocating uniform ring. Many small per-draw uniform blocks are packed
 * into one big buffer at dynamic-offset-aligned boundaries; bind groups use
 * dynamic offsets to address them. Reset once per frame.
 */
export class UniformRing {
  constructor(device, { label = 'uniform-ring', size = 1 << 20, alignment } = {}) {
    this.device = device;
    this.alignment = alignment || device.limits.minUniformBufferOffsetAlignment || 256;
    this.size = alignUp(size, this.alignment);
    this.buffer = createBuffer(device, { label, size: this.size, usage: U.UNIFORM | U.COPY_DST });
    this.offset = 0;
    this.scratch = new Uint8Array(this.size);
    this.dirtyEnd = 0;
    this.overflowed = false;
  }

  reset() {
    this.offset = 0;
    this.dirtyEnd = 0;
    this.overflowed = false;
  }

  /**
   * Allocate `byteLength` bytes and return {offset, view} where view is a
   * Float32Array over the CPU scratch region. Write into `view`, then call
   * flush() once at the end of the frame.
   */
  alloc(byteLength) {
    const aligned = alignUp(byteLength, this.alignment);
    if (this.offset + aligned > this.size) {
      this.overflowed = true;
      this.offset = 0; // wrap; the frame will show artefacts but not crash
    }
    const offset = this.offset;
    this.offset += aligned;
    this.dirtyEnd = Math.max(this.dirtyEnd, offset + byteLength);
    return {
      offset,
      f32: new Float32Array(this.scratch.buffer, offset, byteLength >> 2),
      u32: new Uint32Array(this.scratch.buffer, offset, byteLength >> 2),
    };
  }

  /** Upload everything allocated this frame in a single writeBuffer. */
  flush() {
    if (this.dirtyEnd === 0) return 0;
    const bytes = alignUp(this.dirtyEnd, 4);
    this.device.queue.writeBuffer(this.buffer, 0, this.scratch.buffer, 0, bytes);
    if (this.overflowed) console.warn('[UniformRing] overflowed; increase size');
    return bytes;
  }

  destroy() { this.buffer.destroy(); }
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

/**
 * Formats that may be used with STORAGE_BINDING in core WebGPU.
 *
 * This list is much shorter than people expect - notably r16float, rg16float,
 * r8unorm and all the *-srgb formats are NOT storage-capable. Getting this
 * wrong produces a validation error at texture-creation time whose message
 * does not name the offending call site, so we check it ourselves and throw
 * something actionable instead.
 */
const STORAGE_CAPABLE_FORMATS = new Set([
  'r32uint', 'r32sint', 'r32float',
  'rg32uint', 'rg32sint', 'rg32float',
  'rgba8unorm', 'rgba8snorm', 'rgba8uint', 'rgba8sint',
  'rgba16uint', 'rgba16sint', 'rgba16float',
  'rgba32uint', 'rgba32sint', 'rgba32float',
  'bgra8unorm', // only with the 'bgra8unorm-storage' feature
]);

/** Formats that can be a RENDER_ATTACHMENT. Depth/stencil handled separately. */
const RENDERABLE_FORMATS = new Set([
  'r8unorm', 'r8uint', 'r8sint',
  'rg8unorm', 'rg8uint', 'rg8sint',
  'rgba8unorm', 'rgba8unorm-srgb', 'rgba8uint', 'rgba8sint',
  'bgra8unorm', 'bgra8unorm-srgb',
  'r16uint', 'r16sint', 'r16float',
  'rg16uint', 'rg16sint', 'rg16float',
  'rgba16uint', 'rgba16sint', 'rgba16float',
  'r32uint', 'r32sint', 'r32float',
  'rg32uint', 'rg32sint', 'rg32float',
  'rgba32uint', 'rgba32sint', 'rgba32float',
  'rgb10a2unorm', 'rg11b10ufloat',
  'depth16unorm', 'depth24plus', 'depth24plus-stencil8',
  'depth32float', 'depth32float-stencil8',
]);

export function createTexture(device, {
  label,
  width,
  height,
  depthOrArrayLayers = 1,
  format,
  usage,
  mipLevelCount = 1,
  sampleCount = 1,
  dimension = '2d',
  viewFormats,
}) {
  // Fail loudly, at the call site, with the fix spelled out.
  if ((usage & T.STORAGE_BINDING) && !STORAGE_CAPABLE_FORMATS.has(format)) {
    throw new Error(
      `[createTexture] '${label}' requests STORAGE_BINDING with format '${format}', ` +
      'which WebGPU does not allow as a storage texture.\n' +
      `  Storage-capable formats: ${[...STORAGE_CAPABLE_FORMATS].join(', ')}\n` +
      '  Use rgba16float for HDR compute targets, or r32float if you only need one ' +
      'channel and can accept unfiltered sampling.',
    );
  }
  if ((usage & T.RENDER_ATTACHMENT) && !RENDERABLE_FORMATS.has(format)) {
    throw new Error(
      `[createTexture] '${label}' requests RENDER_ATTACHMENT with format '${format}', ` +
      'which is not renderable.',
    );
  }
  return device.createTexture({
    label,
    size: { width: Math.max(1, width | 0), height: Math.max(1, height | 0), depthOrArrayLayers: Math.max(1, depthOrArrayLayers | 0) },
    format,
    usage,
    mipLevelCount,
    sampleCount,
    dimension,
    viewFormats,
  });
}

export const createRenderTarget = (device, label, width, height, format, extraUsage = 0) =>
  createTexture(device, {
    label, width, height, format,
    usage: T.RENDER_ATTACHMENT | T.TEXTURE_BINDING | extraUsage,
  });

export const createStorageTexture = (device, label, width, height, format, extraUsage = 0, depthOrArrayLayers = 1, dimension = '2d') =>
  createTexture(device, {
    label, width, height, format, depthOrArrayLayers, dimension,
    usage: T.STORAGE_BINDING | T.TEXTURE_BINDING | T.COPY_DST | T.COPY_SRC | extraUsage,
  });

export const createDepthTarget = (device, label, width, height, format = 'depth32float', extraUsage = 0) =>
  createTexture(device, {
    label, width, height, format,
    usage: T.RENDER_ATTACHMENT | T.TEXTURE_BINDING | extraUsage,
  });

/** Number of mips for a given size. */
export const mipCount = (w, h = 1, d = 1) => 1 + Math.floor(Math.log2(Math.max(w, h, d)));

/** Upload RGBA8 pixel data (Uint8Array or ImageData-like) into a texture level. */
export function writeTexture2D(device, texture, data, width, height, { bytesPerPixel = 4, mipLevel = 0, origin = [0, 0, 0], layer } = {}) {
  device.queue.writeTexture(
    { texture, mipLevel, origin: { x: origin[0], y: origin[1], z: layer != null ? layer : origin[2] } },
    data,
    { bytesPerRow: width * bytesPerPixel, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
}

/**
 * Registry of render targets sized relative to the render resolution.
 * Declare once; call `resize()` on backbuffer change and every texture is
 * rebuilt with the same labels, formats and usages.
 */
export class RenderTargets {
  constructor(device) {
    this.device = device;
    /** @type {Map<string, {desc: object, texture: GPUTexture, view: GPUTextureView, views: Map<string, GPUTextureView>}>} */
    this.targets = new Map();
    this.width = 0;
    this.height = 0;
    this.totalBytes = 0;
  }

  /**
   * Declare a target.
   * @param {string} name
   * @param {{format: string, scale?: number, width?: number, height?: number,
   *          usage?: number, mips?: boolean|number, layers?: number,
   *          dimension?: string, depth?: number}} desc
   *   scale multiplies the render resolution (0.5 = half res). Fixed-size
   *   targets pass explicit width/height instead.
   */
  declare(name, desc) {
    this.targets.set(name, { desc, texture: null, view: null, views: new Map() });
    if (this.width) this._build(name);
    return this;
  }

  _build(name) {
    const entry = this.targets.get(name);
    const d = entry.desc;
    if (entry.texture) {
      this.totalBytes -= estimateTextureBytes(entry.texture);
      entry.texture.destroy();
      entry.views.clear();
    }
    const scale = d.scale != null ? d.scale : 1;
    const w = d.width != null ? d.width : Math.max(1, Math.ceil(this.width * scale));
    const h = d.height != null ? d.height : Math.max(1, Math.ceil(this.height * scale));
    const layers = d.layers != null ? d.layers : (d.depth != null ? d.depth : 1);
    const mips = d.mips === true ? mipCount(w, h) : (typeof d.mips === 'number' ? d.mips : 1);
    const isDepth = /depth|stencil/.test(d.format);
    const usage = d.usage != null
      ? d.usage
      : (isDepth
        ? T.RENDER_ATTACHMENT | T.TEXTURE_BINDING
        : T.RENDER_ATTACHMENT | T.TEXTURE_BINDING | T.COPY_SRC);

    entry.texture = createTexture(this.device, {
      label: name, width: w, height: h,
      depthOrArrayLayers: layers,
      format: d.format, usage, mipLevelCount: mips,
      dimension: d.dimension || '2d',
    });
    entry.view = entry.texture.createView({
      label: name + '.view',
      dimension: d.viewDimension || (d.dimension === '3d' ? '3d' : (layers > 1 ? '2d-array' : '2d')),
    });
    entry.actual = { width: w, height: h, layers, mips };
    this.totalBytes += estimateTextureBytes(entry.texture);
  }

  /** Rebuild every declared target for a new render resolution. */
  resize(width, height) {
    if (width === this.width && height === this.height) return false;
    this.width = width;
    this.height = height;
    for (const name of this.targets.keys()) this._build(name);
    return true;
  }

  texture(name) {
    const e = this.targets.get(name);
    if (!e) throw new Error(`[RenderTargets] unknown target '${name}'`);
    if (!e.texture) this._build(name);
    return e.texture;
  }

  view(name) {
    const e = this.targets.get(name);
    if (!e) throw new Error(`[RenderTargets] unknown target '${name}'`);
    if (!e.view) this._build(name);
    return e.view;
  }

  /** A cached sub-view (specific mip / array layer). */
  subView(name, opts) {
    const e = this.targets.get(name);
    if (!e) throw new Error(`[RenderTargets] unknown target '${name}'`);
    if (!e.texture) this._build(name);
    const key = JSON.stringify(opts);
    let v = e.views.get(key);
    if (!v) {
      v = e.texture.createView({ label: `${name}.${key}`, ...opts });
      e.views.set(key, v);
    }
    return v;
  }

  size(name) {
    const e = this.targets.get(name);
    return e ? e.actual : null;
  }

  destroy() {
    for (const e of this.targets.values()) e.texture?.destroy();
    this.targets.clear();
    this.totalBytes = 0;
  }
}

/** Bytes per pixel for the formats we use. Approximate; good enough for budgets. */
const FORMAT_BYTES = {
  r8unorm: 1, r8uint: 1, r8sint: 1,
  rg8unorm: 2, r16float: 2, r16uint: 2, depth16unorm: 2,
  rgba8unorm: 4, 'rgba8unorm-srgb': 4, bgra8unorm: 4, 'bgra8unorm-srgb': 4,
  rg16float: 4, r32float: 4, r32uint: 4, rgb10a2unorm: 4, rg11b10ufloat: 4,
  depth24plus: 4, depth32float: 4, 'depth24plus-stencil8': 4,
  rgba16float: 8, rg32float: 8, rgba16uint: 8, 'depth32float-stencil8': 8,
  rgba32float: 16,
};

export function estimateTextureBytes(texture) {
  const bpp = FORMAT_BYTES[texture.format] || 4;
  const { width, height, depthOrArrayLayers } = texture;
  let total = 0;
  for (let m = 0; m < texture.mipLevelCount; m++) {
    total += Math.max(1, width >> m) * Math.max(1, height >> m) * depthOrArrayLayers * bpp;
  }
  return total * (texture.sampleCount || 1);
}

export const formatBytes = (f) => FORMAT_BYTES[f] || 4;

// ---------------------------------------------------------------------------
// Samplers
// ---------------------------------------------------------------------------

/** Deduplicated sampler cache. Samplers are cheap but there is no reason to churn. */
export class SamplerCache {
  constructor(device) {
    this.device = device;
    this.map = new Map();
  }
  get(desc) {
    const key = JSON.stringify(desc);
    let s = this.map.get(key);
    if (!s) {
      s = this.device.createSampler({ label: key.slice(0, 60), ...desc });
      this.map.set(key, s);
    }
    return s;
  }
  // Common presets.
  get linear() { return this.get({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' }); }
  get linearClamp() {
    return this.get({
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge',
    });
  }
  get linearRepeat() {
    return this.get({
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
      addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat',
    });
  }
  get nearest() { return this.get({ magFilter: 'nearest', minFilter: 'nearest' }); }
  get nearestClamp() {
    return this.get({
      magFilter: 'nearest', minFilter: 'nearest',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    });
  }
  aniso(level = 16) {
    return this.get({
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
      addressModeU: 'repeat', addressModeV: 'repeat',
      maxAnisotropy: level,
    });
  }
  /** Depth comparison sampler for shadow map PCF. */
  get shadowCompare() {
    return this.get({
      compare: 'greater', // reverse-Z: a fragment is lit when its depth is greater
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    });
  }
  destroy() { this.map.clear(); }
}

// ---------------------------------------------------------------------------
// Struct writing helpers (std140-compatible layout for WGSL uniforms)
// ---------------------------------------------------------------------------

/**
 * Sequential writer into a Float32Array/Uint32Array pair sharing one buffer.
 * Enforces WGSL's alignment rules: vec3/vec4 align to 16 B, mat4 to 16 B.
 * Use it so the JS side of a uniform can never silently drift from the WGSL side.
 */
export class StructWriter {
  constructor(f32, u32 = null, baseOffsetBytes = 0) {
    this.f32 = f32;
    this.u32 = u32 || new Uint32Array(f32.buffer, f32.byteOffset, f32.length);
    this.base = baseOffsetBytes >> 2; // in elements
    this.i = 0;
  }
  reset() { this.i = 0; return this; }
  /** Advance to the next multiple of `bytes` (16 for vec4/mat). */
  align(bytes) {
    const elems = bytes >> 2;
    this.i = Math.ceil(this.i / elems) * elems;
    return this;
  }
  f(v) { this.f32[this.base + this.i++] = v; return this; }
  u(v) { this.u32[this.base + this.i++] = v >>> 0; return this; }
  i32(v) { new Int32Array(this.f32.buffer, this.f32.byteOffset)[this.base + this.i++] = v | 0; return this; }
  vec2(a, b) { this.align(8); this.f(a); this.f(b); return this; }
  vec2v(v) { return this.vec2(v[0], v[1]); }
  /** vec3 occupies 16 bytes in a uniform struct; the pad slot is written as 0. */
  vec3(a, b, c) { this.align(16); this.f(a); this.f(b); this.f(c); this.f(0); return this; }
  vec3v(v) { return this.vec3(v[0], v[1], v[2]); }
  /** vec3 followed by a meaningful w component (very common: colour + intensity). */
  vec4(a, b, c, d) { this.align(16); this.f(a); this.f(b); this.f(c); this.f(d); return this; }
  vec4v(v) { return this.vec4(v[0], v[1], v[2], v[3]); }
  vec3w(v, w) { return this.vec4(v[0], v[1], v[2], w); }
  mat4(m) {
    this.align(16);
    for (let k = 0; k < 16; k++) this.f32[this.base + this.i++] = m[k];
    return this;
  }
  /** mat3x3 in WGSL is three vec4-aligned columns = 48 bytes. */
  mat3(m) {
    this.align(16);
    this.f(m[0]); this.f(m[1]); this.f(m[2]); this.f(0);
    this.f(m[3]); this.f(m[4]); this.f(m[5]); this.f(0);
    this.f(m[6]); this.f(m[7]); this.f(m[8]); this.f(0);
    return this;
  }
  /** Byte offset currently reached (useful for asserting struct size). */
  get bytes() { return this.i * 4; }
  /** Pad out to a total struct size, and assert we did not overrun. */
  padTo(totalBytes) {
    const elems = totalBytes >> 2;
    if (this.i > elems) {
      throw new Error(`[StructWriter] wrote ${this.i * 4} bytes, struct is ${totalBytes} bytes`);
    }
    while (this.i < elems) this.f32[this.base + this.i++] = 0;
    return this;
  }
}

// ---------------------------------------------------------------------------
// Readback
// ---------------------------------------------------------------------------

/**
 * Copy a buffer to the CPU. Slow (it maps and waits); use only for debug,
 * profiling and the QA harness - never per frame in the hot path.
 */
export async function readBuffer(device, src, byteLength, srcOffset = 0) {
  const size = alignUp(byteLength, 4);
  const staging = device.createBuffer({
    label: 'readback',
    size,
    usage: U.COPY_DST | U.MAP_READ,
  });
  const enc = device.createCommandEncoder({ label: 'readback' });
  enc.copyBufferToBuffer(src, srcOffset, staging, 0, size);
  device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const copy = staging.getMappedRange().slice(0);
  staging.unmap();
  staging.destroy();
  return copy;
}

/** Copy a 2D texture region to the CPU as raw bytes (row-padded to 256). */
export async function readTexture2D(device, texture, width, height, { bytesPerPixel = 4, mipLevel = 0, origin = [0, 0, 0] } = {}) {
  const bytesPerRow = alignUp(width * bytesPerPixel, 256);
  const size = bytesPerRow * height;
  const staging = device.createBuffer({ label: 'tex-readback', size, usage: U.COPY_DST | U.MAP_READ });
  const enc = device.createCommandEncoder({ label: 'tex-readback' });
  enc.copyTextureToBuffer(
    { texture, mipLevel, origin: { x: origin[0], y: origin[1], z: origin[2] } },
    { buffer: staging, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const padded = new Uint8Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();

  // Strip row padding.
  const tight = new Uint8Array(width * height * bytesPerPixel);
  const rowBytes = width * bytesPerPixel;
  for (let y = 0; y < height; y++) {
    tight.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes), y * rowBytes);
  }
  return tight;
}

export { U as BufferUsage, T as TextureUsage };
