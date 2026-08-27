/**
 * SUBWAVE GPU context.
 *
 * Owns the WebGPU adapter/device/canvas-context lifecycle, capability
 * detection, the derived quality tier, and swap-chain resize. Everything else
 * in the renderer receives a `GPUContext` and never touches `navigator.gpu`.
 *
 * Depth convention (BINDING): reverse-Z. Depth textures clear to 0.0 and
 * compare with 'greater'. See core/math.js `perspectiveReverseZInfinite`.
 */

import { clamp } from './math.js';

/** Formats used across the whole frame graph. Single source of truth. */
export const FORMATS = {
  /** Main HDR scene colour. rgba16float everywhere - we need alpha for refraction masks. */
  hdr: 'rgba16float',
  /** Lower-precision HDR for bloom chains and half-res effects. */
  hdrLow: 'rgba16float',
  /** Depth. 32-bit float is required for reverse-Z at our world scale. */
  depth: 'depth32float',
  /** Shadow cascade atlas. */
  shadow: 'depth32float',
  /** Packed velocity (rg) for TAA / motion blur. */
  velocity: 'rg16float',
  /** Volumetric froxel scattering + transmittance. */
  froxel: 'rgba16float',
  /** Ocean spectrum / displacement cascades. */
  oceanSpectrum: 'rg32float',
  oceanDisplacement: 'rgba16float',
  oceanDerivative: 'rgba16float',
  /** Single-channel utility (AO). Render-attachment + sampled only. */
  r8: 'r8unorm',
  r16f: 'r16float',
  /**
   * Caustics. Must be rgba16float rather than the single-channel r16float you
   * would expect: WebGPU's storage-texture format list does NOT include
   * r16float, and caustics are produced by a compute pass. rgba16float is both
   * storage-capable and filterable without an optional feature.
   * The spare channels are not waste - we store per-wavelength caustics (R/G/B
   * focus at slightly different points because water is dispersive), which is
   * what gives caustic edges their faint colour fringing.
   */
  caustics: 'rgba16float',
  /** Procedurally generated material textures. */
  albedo: 'rgba8unorm',
  normalPacked: 'rg8unorm',
};

/** Quality tiers. Drives resolution scale, pass enablement and content caps. */
export const TIER = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  ULTRA: 3,
};

export const TIER_NAMES = ['low', 'medium', 'high', 'ultra'];

/**
 * Per-tier render settings. Passes read these instead of branching on tier
 * directly, so a new tier only needs a new row here.
 */
export const TIER_PRESETS = {
  [TIER.LOW]: {
    name: 'low',
    renderScale: 0.72,
    shadowCascades: 2,
    shadowResolution: 1024,
    shadowPcfTaps: 4,
    froxelDim: [96, 54, 32],
    oceanFftSize: 128,
    oceanCascades: 2,
    oceanGerstnerFallback: true,
    volumetricClouds: false,
    ssr: false,
    ssao: false,
    taa: true,
    bloomMips: 4,
    maxParticles: 24000,
    maxCreatures: 90,
    maxScatterInstances: 40000,
    terrainLodRings: 5,
    viewDistance: 1400,
    caustics: true,
    causticsResolution: 256,
    marineSnow: true,
    anisotropy: 4,
  },
  [TIER.MEDIUM]: {
    name: 'medium',
    renderScale: 0.85,
    shadowCascades: 3,
    shadowResolution: 1536,
    shadowPcfTaps: 8,
    froxelDim: [128, 72, 48],
    oceanFftSize: 256,
    oceanCascades: 3,
    oceanGerstnerFallback: false,
    volumetricClouds: true,
    ssr: true,
    ssao: true,
    taa: true,
    bloomMips: 5,
    maxParticles: 64000,
    maxCreatures: 160,
    maxScatterInstances: 90000,
    terrainLodRings: 6,
    viewDistance: 2200,
    caustics: true,
    causticsResolution: 512,
    marineSnow: true,
    anisotropy: 8,
  },
  [TIER.HIGH]: {
    name: 'high',
    renderScale: 1.0,
    shadowCascades: 4,
    shadowResolution: 2048,
    shadowPcfTaps: 16,
    froxelDim: [160, 90, 64],
    oceanFftSize: 256,
    oceanCascades: 3,
    oceanGerstnerFallback: false,
    volumetricClouds: true,
    ssr: true,
    ssao: true,
    taa: true,
    bloomMips: 6,
    maxParticles: 128000,
    maxCreatures: 260,
    maxScatterInstances: 160000,
    terrainLodRings: 7,
    viewDistance: 3200,
    caustics: true,
    causticsResolution: 512,
    marineSnow: true,
    anisotropy: 16,
  },
  [TIER.ULTRA]: {
    name: 'ultra',
    renderScale: 1.0,
    shadowCascades: 4,
    shadowResolution: 2048,
    shadowPcfTaps: 16,
    froxelDim: [192, 108, 80],
    oceanFftSize: 512,
    oceanCascades: 3,
    oceanGerstnerFallback: false,
    volumetricClouds: true,
    ssr: true,
    ssao: true,
    taa: true,
    bloomMips: 6,
    maxParticles: 200000,
    maxCreatures: 360,
    maxScatterInstances: 240000,
    terrainLodRings: 8,
    viewDistance: 4000,
    caustics: true,
    // 512, NOT 1024. Measured at 48 modes, the base dispatch costs 15.71 /
    // 45.63 / 153.16 us standalone at 256 / 512 / 1024, and 1024 buys sub-texel
    // rms error 1.02% -> 0.35% while the tile mean and the clamp fraction are
    // identical to four digits. 0.14 ms of an 8.33 ms frame for 0.67 points of
    // an error nobody can see is the wrong trade; the mip chain now does the
    // anti-aliasing that resolution was standing in for.
    causticsResolution: 512,
    marineSnow: true,
    anisotropy: 16,
  },
};

/** Optional device features we will use when present. */
const WANTED_FEATURES = [
  'timestamp-query',
  'float32-filterable',
  'shader-f16',
  'rg11b10ufloat-renderable',
  'depth32float-stencil',
  'indirect-first-instance',
  'texture-compression-bc',
  'dual-source-blending',
];

export class UnsupportedError extends Error {
  constructor(message, detail = '') {
    super(message);
    this.name = 'UnsupportedError';
    this.detail = detail;
  }
}

export class GPUContext {
  constructor() {
    /** @type {GPUAdapter|null} */ this.adapter = null;
    /** @type {GPUDevice|null} */ this.device = null;
    /** @type {GPUCanvasContext|null} */ this.context = null;
    /** @type {HTMLCanvasElement|null} */ this.canvas = null;

    this.presentFormat = 'bgra8unorm';
    this.features = new Set();
    this.limits = {};
    this.adapterInfo = { vendor: '', architecture: '', device: '', description: '' };

    this.tier = TIER.HIGH;
    this.preset = TIER_PRESETS[TIER.HIGH];

    /** Backbuffer size in device pixels. */
    this.width = 1;
    this.height = 1;
    /** Internal render target size = backbuffer * renderScale, even-aligned. */
    this.renderWidth = 1;
    this.renderHeight = 1;
    this.devicePixelRatio = 1;
    /** User-facing multiplier applied on top of the tier's renderScale. */
    this.resolutionScale = 1;

    this.lost = false;
    this.lostReason = '';

    this._resizeListeners = new Set();
    this._lostListeners = new Set();
    this._uncapturedErrors = 0;
    this._maxReportedErrors = 25;
  }

  // -------------------------------------------------------------------------
  // Initialisation
  // -------------------------------------------------------------------------

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{tier?: number, forceFallbackAdapter?: boolean, powerPreference?: GPUPowerPreference}} [opts]
   */
  async init(canvas, opts = {}) {
    if (!('gpu' in navigator)) {
      throw new UnsupportedError(
        'WebGPU is not available in this browser.',
        'SUBWAVE requires WebGPU. Use the latest Google Chrome on desktop. ' +
          'If you are on Chrome already, check chrome://gpu and make sure hardware acceleration is enabled.',
      );
    }

    this.canvas = canvas;

    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: opts.powerPreference || 'high-performance',
      forceFallbackAdapter: !!opts.forceFallbackAdapter,
    });
    if (!adapter) {
      throw new UnsupportedError(
        'No suitable GPU adapter was found.',
        'Your browser exposes WebGPU but could not provide a GPU adapter. ' +
          'Check chrome://gpu for blocklisting, or try enabling hardware acceleration.',
      );
    }
    this.adapter = adapter;

    // Adapter identity is advisory only; some builds return empty strings.
    try {
      const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
      if (info) {
        this.adapterInfo = {
          vendor: info.vendor || '',
          architecture: info.architecture || '',
          device: info.device || '',
          description: info.description || '',
        };
      }
    } catch { /* non-fatal */ }

    const requiredFeatures = WANTED_FEATURES.filter((f) => adapter.features.has(f));

    // Ask for headroom on the limits the renderer actually stresses.
    const al = adapter.limits;
    const requiredLimits = {
      maxTextureDimension2D: Math.min(al.maxTextureDimension2D, 8192),
      maxTextureArrayLayers: Math.min(al.maxTextureArrayLayers, 256),
      maxBufferSize: Math.min(al.maxBufferSize, 512 * 1024 * 1024),
      maxStorageBufferBindingSize: Math.min(al.maxStorageBufferBindingSize, 512 * 1024 * 1024),
      maxUniformBufferBindingSize: Math.min(al.maxUniformBufferBindingSize, 64 * 1024),
      maxStorageBuffersPerShaderStage: Math.min(al.maxStorageBuffersPerShaderStage, 10),
      maxStorageTexturesPerShaderStage: Math.min(al.maxStorageTexturesPerShaderStage, 8),
      maxSampledTexturesPerShaderStage: Math.min(al.maxSampledTexturesPerShaderStage, 16),
      maxComputeWorkgroupStorageSize: Math.min(al.maxComputeWorkgroupStorageSize, 32768),
      maxComputeInvocationsPerWorkgroup: Math.min(al.maxComputeInvocationsPerWorkgroup, 256),
      maxComputeWorkgroupSizeX: Math.min(al.maxComputeWorkgroupSizeX, 256),
      maxComputeWorkgroupSizeY: Math.min(al.maxComputeWorkgroupSizeY, 256),
      maxVertexBuffers: Math.min(al.maxVertexBuffers, 8),
      maxVertexAttributes: Math.min(al.maxVertexAttributes, 16),
      maxColorAttachments: Math.min(al.maxColorAttachments, 8),
      maxBindGroups: Math.min(al.maxBindGroups, 4),
    };

    let device;
    try {
      device = await adapter.requestDevice({ label: 'subwave-device', requiredFeatures, requiredLimits });
    } catch (err) {
      // Retry with defaults - some drivers reject specific limit combinations.
      console.warn('[gpu] requestDevice with explicit limits failed, retrying with defaults:', err);
      device = await adapter.requestDevice({ label: 'subwave-device-fallback', requiredFeatures });
    }
    this.device = device;
    this.features = new Set(device.features);
    this.limits = device.limits;

    device.lost.then((info) => {
      this.lost = true;
      this.lostReason = `${info.reason}: ${info.message}`;
      console.error('[gpu] device lost -', this.lostReason);
      for (const fn of this._lostListeners) {
        try { fn(info); } catch (e) { console.error(e); }
      }
    });

    device.onuncapturederror = (ev) => {
      this._uncapturedErrors++;
      if (this._uncapturedErrors <= this._maxReportedErrors) {
        console.error('[gpu] uncaptured error:', ev.error.message);
        if (this._uncapturedErrors === this._maxReportedErrors) {
          console.error('[gpu] further uncaptured errors will be suppressed.');
        }
      }
    };

    this.presentFormat = navigator.gpu.getPreferredCanvasFormat();
    this.context = canvas.getContext('webgpu');
    if (!this.context) {
      throw new UnsupportedError('Could not acquire a WebGPU canvas context.');
    }
    this.context.configure({
      device,
      format: this.presentFormat,
      alphaMode: 'opaque',
      // COPY_SRC lets photo mode and the QA harness read the framebuffer back.
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    this.setTier(opts.tier != null ? opts.tier : this.autoDetectTier());
    this.resize();
    return this;
  }

  /**
   * Guess a starting quality tier from adapter limits and identity.
   * The player can always override it in settings; this only picks the default.
   */
  autoDetectTier() {
    const l = this.limits || {};
    const desc = `${this.adapterInfo.vendor} ${this.adapterInfo.architecture} ${this.adapterInfo.description}`.toLowerCase();

    // Software rasterisers and known-weak integrated parts start at LOW.
    if (/swiftshader|llvmpipe|software|basic render/.test(desc)) return TIER.LOW;

    const bigBuffers = (l.maxStorageBufferBindingSize || 0) >= 256 * 1024 * 1024;
    const bigTextures = (l.maxTextureDimension2D || 0) >= 8192;
    const wideCompute = (l.maxComputeInvocationsPerWorkgroup || 0) >= 256;
    const manyLayers = (l.maxTextureArrayLayers || 0) >= 256;

    let score = 0;
    if (bigBuffers) score += 2;
    if (bigTextures) score += 1;
    if (wideCompute) score += 1;
    if (manyLayers) score += 1;
    if (this.features.has('float32-filterable')) score += 1;
    if (this.features.has('timestamp-query')) score += 1;

    // Apple silicon and discrete desktop parts handle HIGH comfortably.
    if (/apple/.test(desc) && score >= 5) return TIER.HIGH;
    if (/nvidia|amd|radeon|geforce|rtx|arc/.test(desc) && score >= 5) return TIER.HIGH;
    if (/intel/.test(desc)) return score >= 5 ? TIER.MEDIUM : TIER.LOW;

    if (score >= 6) return TIER.HIGH;
    if (score >= 4) return TIER.MEDIUM;
    return TIER.LOW;
  }

  setTier(tier) {
    this.tier = clamp(tier | 0, TIER.LOW, TIER.ULTRA);
    this.preset = TIER_PRESETS[this.tier];
    return this.preset;
  }

  /** Extra user-side resolution multiplier (0.5 .. 1.5). */
  setResolutionScale(s) {
    this.resolutionScale = clamp(s, 0.5, 1.5);
    this.resize();
  }

  // -------------------------------------------------------------------------
  // Sizing
  // -------------------------------------------------------------------------

  /**
   * Sync canvas backing-store size to its CSS size, and recompute the internal
   * render resolution. Returns true if anything changed.
   */
  resize() {
    const canvas = this.canvas;
    if (!canvas) return false;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width || canvas.clientWidth || window.innerWidth);
    const cssH = Math.max(1, rect.height || canvas.clientHeight || window.innerHeight);

    const maxDim = this.limits.maxTextureDimension2D || 8192;
    const w = clamp(Math.round(cssW * dpr), 1, maxDim);
    const h = clamp(Math.round(cssH * dpr), 1, maxDim);

    const scale = clamp(this.preset.renderScale * this.resolutionScale, 0.4, 1.5);
    // Even dimensions keep half-res chains (bloom, volumetrics) exact.
    const rw = clamp(Math.max(2, Math.round((w * scale) / 2) * 2), 2, maxDim);
    const rh = clamp(Math.max(2, Math.round((h * scale) / 2) * 2), 2, maxDim);

    const changed =
      w !== this.width || h !== this.height ||
      rw !== this.renderWidth || rh !== this.renderHeight;

    this.width = w;
    this.height = h;
    this.renderWidth = rw;
    this.renderHeight = rh;
    this.devicePixelRatio = dpr;

    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;

    if (changed) {
      for (const fn of this._resizeListeners) {
        try { fn(this); } catch (e) { console.error(e); }
      }
    }
    return changed;
  }

  get aspect() {
    return this.renderWidth / Math.max(1, this.renderHeight);
  }

  onResize(fn) {
    this._resizeListeners.add(fn);
    return () => this._resizeListeners.delete(fn);
  }

  onLost(fn) {
    this._lostListeners.add(fn);
    return () => this._lostListeners.delete(fn);
  }

  // -------------------------------------------------------------------------
  // Convenience
  // -------------------------------------------------------------------------

  has(feature) {
    return this.features.has(feature);
  }

  /** The swap-chain texture view for this frame. */
  currentView() {
    return this.context.getCurrentTexture().createView();
  }

  /** Wrap `fn` in a GPU error scope and log anything it raises. */
  async withErrorScope(filter, label, fn) {
    this.device.pushErrorScope(filter);
    const result = await fn();
    const err = await this.device.popErrorScope();
    if (err) console.error(`[gpu] ${filter} error in ${label}:`, err.message);
    return result;
  }

  describe() {
    const l = this.limits || {};
    return {
      adapter: this.adapterInfo,
      presentFormat: this.presentFormat,
      tier: TIER_NAMES[this.tier],
      features: [...this.features].sort(),
      backbuffer: `${this.width}x${this.height}`,
      renderTarget: `${this.renderWidth}x${this.renderHeight}`,
      limits: {
        maxTextureDimension2D: l.maxTextureDimension2D,
        maxBufferSize: l.maxBufferSize,
        maxStorageBufferBindingSize: l.maxStorageBufferBindingSize,
        maxComputeInvocationsPerWorkgroup: l.maxComputeInvocationsPerWorkgroup,
      },
    };
  }

  destroy() {
    try { this.device?.destroy(); } catch { /* ignore */ }
    this.device = null;
    this.context = null;
  }
}
