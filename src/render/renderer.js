/**
 * SUBWAVE renderer core.
 *
 * Owns:
 *   - the Frame uniform buffer and bind group 0 (the contract in
 *     shaders/common/frame.wgsl - the byte layout here MUST match it exactly)
 *   - the render target registry and its resize behaviour
 *   - the light list and the clustered light-culling buffers
 *   - the frame graph and the per-frame encode/submit
 *
 * It does NOT own any individual pass; passes are registered from outside so
 * this file stays readable and the pass order is stated in one place.
 */

import { GPUContext, FORMATS, TIER } from '../core/gpu.js';
import { ShaderLibrary } from '../core/shaderlib.js';
import {
  RenderTargets, SamplerCache, UniformRing, StructWriter,
  createUniformBuffer, createStorageBuffer, createTexture, writeTexture2D,
  TextureUsage,
} from '../core/resources.js';
import { PipelineCache, BindGroupBuilder, STAGE, GROUP, DEPTH_CLEAR_VALUE }
  from '../core/pipelines.js';
import { FrameGraph, FrameContext } from './framegraph.js';
import { Camera } from './camera.js';
import { SHADER_FILES } from './shaders/manifest.js';
import { profiler } from '../core/profiler.js';
import { events, EVENTS } from '../core/events.js';
import {
  RENDER, WATER_TYPES, SKY, WORLD, DEPTH_BANDS, DEEP_TINT_REFERENCE_E, WATER_BOTTOM_ALBEDO,
} from '../core/constants.js';
import { vec3, clamp, saturate, lerp, smoothstep, makeRng } from '../core/math.js';

/**
 * Size of the Frame uniform struct in bytes.
 * MUST equal the total in shaders/common/frame.wgsl. Asserted at runtime.
 */
export const FRAME_BYTES = 1232;

/** Bytes per Light struct (5 x vec4f). Must match `struct Light` in frame.wgsl. */
export const LIGHT_BYTES = 80;

/** Floats per Light. Every stride into `lightData` is written in these units. */
const LIGHT_FLOATS = LIGHT_BYTES / 4;

/** Frame.counts.w bit flags. Mirrors the constants in frame.wgsl. */
export const FLAG = {
  UNDERWATER: 1,
  IN_VESSEL: 2,
  CAUSTICS_ON: 4,
  VOLUMETRICS_ON: 8,
  SSR_ON: 16,
  NIGHT: 32,
  IN_CAVE: 64,
  REDUCE_FLASHING: 128,
  GLOW_SPRITES: 256,
  DRY_INTERIOR: 512,
};

export class Renderer {
  constructor() {
    this.gpu = new GPUContext();
    this.camera = new Camera();
    /** @type {ShaderLibrary} */ this.shaders = null;
    /** @type {PipelineCache} */ this.pipelines = null;
    /** @type {RenderTargets} */ this.targets = null;
    /** @type {SamplerCache} */ this.samplers = null;
    /** @type {FrameGraph} */ this.graph = null;
    /** @type {FrameContext} */ this.ctx = null;

    this.frameBuffer = null;
    this.frameData = new ArrayBuffer(FRAME_BYTES);
    this.frameF32 = new Float32Array(this.frameData);
    this.frameU32 = new Uint32Array(this.frameData);
    this.frameWriter = new StructWriter(this.frameF32, this.frameU32);

    /** Light list, uploaded each frame. */
    this.maxLights = RENDER.MAX_LIGHTS;
    this.lightData = new Float32Array(this.maxLights * (LIGHT_BYTES / 4));
    this.lightCount = 0;
    this.lightBuffer = null;
    /** @type {Array<(r: Renderer) => void>} see addLightSubmitter(). */
    this.lightSubmitters = [];

    this.clusterRangeBuffer = null;
    this.clusterIndexBuffer = null;
    this.shadowMatrixBuffer = null;
    this.shadowMatrices = new Float32Array(RENDER.SHADOW_CASCADES * 16);

    this.frameBindGroup = null;
    this.frameBindGroupLayout = null;

    this.frameIndex = 0;

    /**
     * The showcase demo's cut-to-black, 0..1. WRITTEN BY src/demo/director.js
     * AND BY NOTHING ELSE, and it must rest at exactly 0 - anything that leaves
     * it non-zero darkens every frame in the game.
     *
     * IT HAS TWO CONSUMERS BECAUSE THE FRAME HAS TWO WRITERS AFTER THE GRADE.
     * `pass/lens.wgsl` (tune.w) multiplies the scene on the last line of the
     * post chain, but the HUD is registered AFTER that chain in passes/index.js
     * and composites onto the same swap-chain view with loadOp 'load', so the
     * lens multiply cannot reach it. `pass/hud.wgsl` therefore takes the same
     * scalar through its own master opacity (optics.w). Wire one without the
     * other and a fully bright instrument panel floats over a black frame at
     * every one of the eleven segment boundaries.
     *
     * This was a full-screen DOM overlay until the demo learned to record
     * itself: a canvas capture stream sees no DOM, so the overlay was invisible
     * to the file and every cut in it was a hard cut.
     */
    this.demoFade = 0;

    this.exposure = 1.0;
    this.prevExposure = 1.0;

    /**
     * Extra FLAG.* bits OR'd into Frame.counts.w each frame, for state the
     * renderer does not own. main.js writes FLAG.IN_CAVE here from the cave
     * field's own isInsideCave() - the WGSL consumer is the enclosed-water
     * gate in pass/underwater.wgsl.
     */
    this.extraFlags = 0;

    /** Environment state, set by the world/sky systems each frame. */
    this.env = {
      sunDir: vec3.create(0, 1, 0),
      sunColor: vec3.create(1, 0.97, 0.91),
      sunIntensity: 0,
      sunAngularRadius: SKY.SUN_ANGULAR_RADIUS,
      moonDir: vec3.create(0, -1, 0),
      moonColor: vec3.create(0.64, 0.68, 0.79),
      moonIntensity: 0,
      moonPhase: 0.5,
      /** SH-L2 ambient, 9 RGB coefficients. */
      ambientSH: new Float32Array(9 * 3),
      waterType: WATER_TYPES.REEF_TURQUOISE,
      turbidity: 0.2,
      causticStrength: 1.0,
      foamCoverage: 0.0,
      choppiness: 1.0,
      seaState: 2,
      fogDensity: 3.2e-5,
      fogHeightFalloff: 1.1e-3,
      fogColor: vec3.create(0.52, 0.62, 0.74),
      cloudCover: 0.15,
      rain: 0,
      windSpeed: 4.5,
      windDir: [1, 0],
      lightningFlash: 0,
      dayFraction: 0.3,
      lastDepthBand: 0,
    };

    /**
     * Seabed albedo, SPRUNG rather than snapped.
     *
     * main.js blends the water column's optical coefficients across a biome
     * boundary over RENDER.WATER_BLEND_TAU but snaps `id` in one frame, so
     * indexing WATER_BOTTOM_ALBEDO directly would step the shallow-water colour
     * from carbonate sand (0.62) to shelf sand (0.35) at a line the player can
     * stand astride while everything around it crossfades. Same time constant,
     * same reason.
     *
     * Seeded on the FIRST frame rather than here, because main.js replaces
     * env.waterType wholesale after the Renderer is constructed - seeding from
     * the placeholder above spends the first two seconds of every boot fading
     * out of the wrong basin's sand.
     */
    this._bottomAlbedo = new Float32Array(3);
    this._bottomAlbedoSeeded = false;

    /**
     * The local deep key's CHROMATICITY TIMES ITS GAIN - i.e. the palette row
     * normalised to unit Rec709 luma and then scaled, so this array's own luma
     * is the row's gain and is 1 wherever no row is authored. Sprung on the same
     * tau and for the same reason as _bottomAlbedo above: RENDER.DEEP_KEY_PALETTE
     * is indexed by the water type id and main.js snaps that id.
     *
     * The master magnitude is deliberately NOT in here. It is multiplied in at
     * pack time, so zeroing RENDER.DEEP_KEY_RADIANCE goes black in one frame
     * instead of fading out over the spring and the bisect stays a bisect.
     *
     * Seeded to neutral: on the first frame the spring snaps anyway, and neutral
     * is the value that makes a degenerate master (the bisect) hold still rather
     * than drift - see the pack site.
     */
    this._deepKeyTint = [1, 1, 1];
    this._deepKeyTintSeeded = false;
    /** Sprung cave-enclosure drain 0..1, owned by main.js._updateWaterColumn
     *  (target inCave ? RENDER.CAVE_ENCLOSURE : 0, WATER_BLEND_TAU). Written
     *  into frame.caveMedium.x every frame. */
    this.caveEnclosure = 0;

    this._resizeUnsub = null;
    this._destroyed = false;
  }

  // -------------------------------------------------------------------------
  // Initialisation
  // -------------------------------------------------------------------------

  async init(canvas, { tier } = {}) {
    await this.gpu.init(canvas, { tier });
    const device = this.gpu.device;

    this.shaders = new ShaderLibrary({ root: './src/render/shaders/', device });
    this.pipelines = new PipelineCache(device);
    this.pipelines.device = device;
    this.targets = new RenderTargets(device);
    this.samplers = new SamplerCache(device);
    this.uniforms = new UniformRing(device, { label: 'per-draw-ring', size: 4 << 20 });

    profiler.initGPU(device, this.gpu.has('timestamp-query'));

    this._createBuffers();
    this._declareTargets();
    this.targets.resize(this.gpu.renderWidth, this.gpu.renderHeight);
    this._createBlueNoise();

    // Shader defines available to every WGSL module. These mirror constants.js
    // so a shader never hard-codes a number the JS side also knows.
    const p = this.gpu.preset;
    this.shaders.define({
      MAX_LIGHTS: RENDER.MAX_LIGHTS,
      MAX_LIGHTS_PER_CLUSTER: RENDER.MAX_LIGHTS_PER_CLUSTER,
      CLUSTER_X: RENDER.CLUSTER_X,
      CLUSTER_Y: RENDER.CLUSTER_Y,
      CLUSTER_Z: RENDER.CLUSTER_Z,
      // The cluster grid's DEPTH bounds, for sim/cluster_cull.wgsl only. They
      // are deliberately NOT called CLUSTER_NEAR / CLUSTER_FAR_*: a define is a
      // whole-word substitution across EVERY module, and those three names are
      // `const` declarations in common/lighting.wgsl, so publishing them under
      // their own names rewrites the declaration into a syntax error. See
      // RENDER.CLUSTER_CULL_UNION for what the cull pass was slicing instead.
      CULL_NEAR: `${RENDER.CLUSTER_NEAR.toFixed(4)}`,
      CULL_FAR_AIR: `${RENDER.CLUSTER_FAR_AIR.toFixed(1)}`,
      CULL_FAR_WATER: `${RENDER.CLUSTER_FAR_WATER.toFixed(1)}`,
      CLUSTER_CULL_UNION: RENDER.CLUSTER_CULL_UNION ? 1 : 0,
      SHADOW_CASCADES: p.shadowCascades,
      SHADOW_PCF_TAPS: p.shadowPcfTaps,
      SHADOW_RESOLUTION: p.shadowResolution,
      // The upper edge of underwaterShadowStrength()'s fade. It is ALSO the
      // cascade gate in shadows.js, and the two used to be independent literals
      // of 95: arming the cascades without moving the fade renders caster
      // passes whose result the receiver multiplies by zero. One constant, two
      // consumers, no drift.
      SHADOW_UW_CUTOFF: `${RENDER.SHADOW_UNDERWATER_CUTOFF.toFixed(1)}`,
      FROXEL_X: p.froxelDim[0],
      FROXEL_Y: p.froxelDim[1],
      FROXEL_Z: p.froxelDim[2],
      FROXEL_MAX_DISTANCE: `${RENDER.FROXEL_MAX_DISTANCE.toFixed(1)}`,
      FROXEL_DEPTH_POWER: `${RENDER.FROXEL_DEPTH_POWER.toFixed(1)}`,
      CAUSTICS_MAX_DEPTH: `${RENDER.CAUSTICS_MAX_DEPTH.toFixed(1)}`,
      CAUSTICS_SCALE: `${RENDER.CAUSTICS_SCALE.toFixed(1)}`,
      CAUSTICS_RESOLUTION: p.causticsResolution,
      // DERIVED, never a literal: the coarsest LOD anything may ask for is one
      // less than the number of levels the tile carries, and a clamp above it
      // would sample a level that does not exist. See CAUSTICS_MIP_LEVELS.
      CAUSTIC_MAX_LOD: `${(RENDER.CAUSTICS_MIP_LEVELS - 1).toFixed(1)}`,
      CAUSTIC_PEAK: `${RENDER.CAUSTICS_INTENSITY_CLAMP.toFixed(1)}`,
      CAUSTIC_TAP2_SCALE: `${RENDER.CAUSTIC_TAP2_SCALE.toFixed(3)}`,
      // The second tap is a fixed scale of the first, so its LOD offset is a
      // constant and the log2 does not need to run per pixel.
      CAUSTIC_TAP2_LOD: `${Math.log2(RENDER.CAUSTIC_TAP2_SCALE).toFixed(6)}`,
      CAUSTIC_TILE_MEAN_R: `${RENDER.CAUSTIC_TILE_MEAN[0].toFixed(5)}`,
      CAUSTIC_TILE_MEAN_G: `${RENDER.CAUSTIC_TILE_MEAN[1].toFixed(5)}`,
      CAUSTIC_TILE_MEAN_B: `${RENDER.CAUSTIC_TILE_MEAN[2].toFixed(5)}`,
      CAUSTIC_COMPOSITE_MEAN_R: `${RENDER.CAUSTIC_COMPOSITE_MEAN[0].toFixed(5)}`,
      CAUSTIC_COMPOSITE_MEAN_G: `${RENDER.CAUSTIC_COMPOSITE_MEAN[1].toFixed(5)}`,
      CAUSTIC_COMPOSITE_MEAN_B: `${RENDER.CAUSTIC_COMPOSITE_MEAN[2].toFixed(5)}`,
      AGX_LOOK_POWER: `${RENDER.AGX_LOOK_POWER.toFixed(3)}`,
      AGX_LOOK_SATURATION: `${RENDER.AGX_LOOK_SATURATION.toFixed(3)}`,
      VIGNETTE_FALLOFF: `${RENDER.VIGNETTE_FALLOFF.toFixed(3)}`,
      VIGNETTE_POWER: `${RENDER.VIGNETTE_POWER.toFixed(1)}`,
      CA_CENTRE: `${RENDER.CA_CENTRE.toFixed(8)}`,
      CA_EDGE: `${RENDER.CA_EDGE.toFixed(8)}`,
      DEEP_TINT_REFERENCE_E: `${DEEP_TINT_REFERENCE_E.toFixed(3)}`,
      OCEAN_CASCADES: p.oceanCascades,
      MAX_BONES: RENDER.MAX_BONES_PER_CREATURE,
      QUALITY_TIER: this.gpu.tier,
      USE_SSR: p.ssr ? 1 : 0,
      // No USE_SSAO define: zero shaders consume one. The real SSAO pass
      // gates on preset.ssao at init and compiles its own module with its
      // own SSAO_SAMPLES define (render/passes/ssao.js); a global define
      // beside it would be a second, dead copy of that decision.
      USE_CLOUDS: p.volumetricClouds ? 1 : 0,
      USE_CAUSTICS: p.caustics ? 1 : 0,
    });

    // Fetch every shader source up front. WGSL cannot be preprocessed until
    // its text (and its whole #include tree) is in memory, and passes build
    // their pipelines synchronously inside init() - so this has to happen
    // before the frame graph is initialised, not lazily on first use.
    await this.shaders.preload(SHADER_FILES);

    this.ctx = new FrameContext({
      gpu: this.gpu,
      shaders: this.shaders,
      pipelines: this.pipelines,
      targets: this.targets,
      samplers: this.samplers,
      uniforms: this.uniforms,
    });
    this.ctx.renderer = this;
    this.ctx.camera = this.camera;

    this.graph = new FrameGraph(this.ctx);

    this._resizeUnsub = this.gpu.onResize(() => this._onResize());
    this.gpu.onLost((info) => {
      events.emit(EVENTS.DEVICE_LOST, { reason: info.reason, message: info.message });
    });

    return this;
  }

  _createBuffers() {
    const device = this.gpu.device;

    this.frameBuffer = createUniformBuffer(device, FRAME_BYTES, 'frame-uniform');
    this.lightBuffer = createStorageBuffer(device, this.lightData.byteLength, 'lights');

    const clusterCount = RENDER.CLUSTER_X * RENDER.CLUSTER_Y * RENDER.CLUSTER_Z;
    // vec2u per cluster: (offset, count)
    this.clusterRangeBuffer = createStorageBuffer(device, clusterCount * 8, 'cluster-ranges');
    this.clusterIndexBuffer = createStorageBuffer(
      device, clusterCount * RENDER.MAX_LIGHTS_PER_CLUSTER * 4, 'cluster-indices');
    this.shadowMatrixBuffer = createStorageBuffer(
      device, RENDER.SHADOW_CASCADES * 64, 'shadow-matrices');

    this.clusterCount = clusterCount;
  }

  _declareTargets() {
    const t = this.targets;
    const p = this.gpu.preset;

    // Main scene.
    t.declare('sceneColor', { format: FORMATS.hdr, usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_SRC | TextureUsage.STORAGE_BINDING });
    // COPY_SRC so copyOpaque can snapshot it; see sceneDepthOpaque below.
    t.declare('sceneDepth', {
      format: FORMATS.depth,
      usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING |
             TextureUsage.COPY_SRC,
    });
    t.declare('velocity', { format: FORMATS.velocity });
    // THE DRY PATH. Per pixel, the SIGNED sum of hull crossings in front of the
    // eye, in metres, which sums to the length of the view ray that lies inside
    // a pressurised volume. pass/underwater.wgsl applies the medium over
    // max(0, dist - dryPath) rather than over dist.
    //
    // The station is the only thing in the world that writes it, so it is zero
    // over every other pixel of every other frame and the composite is
    // algebraically unchanged there.
    //
    // r16float, NOT r8: this is a DISTANCE, and a binary mask cannot express
    // "3 m of room air and then 30 m of ocean", which is exactly what a window
    // pixel is. Nor can a mask carry the SIGN, and the sign is the whole
    // encoding - see FragOut.dryPath in pass/entity.wgsl. f16 resolves 16 mm at
    // 33 m, and the value is only ever meaningful over the station's own 50 m.
    t.declare('dryPath', { format: FORMATS.r16f });
    // A copy of scene colour taken before transparents, for refraction.
    // Needs COPY_DST because the copyOpaque pass blits sceneColor into it.
    t.declare('sceneOpaque', {
      format: FORMATS.hdr,
      usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING |
             TextureUsage.COPY_DST | TextureUsage.COPY_SRC,
    });
    // The DEPTH half of that same snapshot, and it is not optional.
    //
    // The ocean surface has to know how much water stands between itself and
    // the seabed - that measurement is the entire shallow-to-deep colour ramp,
    // the shoreline, and the refraction rejection. It cannot read sceneDepth to
    // get it: the surface runs a depth PREPASS of its own (see passes/ocean.js)
    // which overwrites sceneDepth with the water's own depth before the shading
    // pass samples it, so the column always measures exactly zero and the sea
    // comes out the colour of whatever is behind it - sky included.
    t.declare('sceneDepthOpaque', {
      format: FORMATS.depth,
      usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
    });

    // TAA history (ping-pong).
    t.declare('taaHistoryA', { format: FORMATS.hdr, usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST });
    t.declare('taaHistoryB', { format: FORMATS.hdr, usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST });
    t.declare('resolved', { format: FORMATS.hdr });

    // Shadows.
    // COPY_SRC for the same reason the sky LUTs carry it: without it
    // debugReadShadowCascade() cannot inspect a layer, and an atlas that was
    // never rendered reads as "every surface lit" - which is exactly what a
    // working shadow pass looks like on a sunless frame. There is no way to
    // tell the two apart from a screenshot.
    t.declare('shadowAtlas', {
      format: FORMATS.shadow,
      width: p.shadowResolution, height: p.shadowResolution,
      layers: p.shadowCascades,
      viewDimension: '2d-array',
      usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING |
             TextureUsage.COPY_SRC,
    });

    // Volumetrics: 3D froxel volumes. THREE of them, and none is optional.
    //
    // rgba16float rejects `read_write` storage access on this device, so the
    // integration cannot run in place and needs `froxelScatter` as a separate
    // target from the density it reads. The density itself then has to
    // ping-pong, because the temporal reprojection blends against the PREVIOUS
    // frame's density while this frame's is being written - and it must be the
    // unintegrated density, since an integrated value depends on everything in
    // front of it along the current ray, which reprojection does not preserve.
    //
    // COPY_SRC on all three for the same reason the sky LUTs carry it: a 3D
    // volume never appears on screen, so a readback is the ONLY way to tell a
    // working volume from a zero-filled one. Without it debugReadback() refuses,
    // which is how this texture went the whole life of the project with no
    // producer at all and nothing to say so.
    const [fx, fy, fz] = p.froxelDim;
    const froxelUsage = TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING |
                        TextureUsage.COPY_SRC;
    t.declare('froxelScatter', {
      format: FORMATS.froxel, width: fx, height: fy, depth: fz, dimension: '3d',
      viewDimension: '3d', usage: froxelUsage | TextureUsage.COPY_DST,
    });
    t.declare('froxelDensityA', {
      format: FORMATS.froxel, width: fx, height: fy, depth: fz, dimension: '3d',
      viewDimension: '3d', usage: froxelUsage,
    });
    t.declare('froxelDensityB', {
      format: FORMATS.froxel, width: fx, height: fy, depth: fz, dimension: '3d',
      viewDimension: '3d', usage: froxelUsage,
    });

    // Sky and water LUTs.
    // COPY_SRC on all three is deliberate: without it debugReadback() cannot
    // inspect them, and a validation failure there returns a zeroed buffer that
    // reads exactly like "this pass produced nothing" - which sends you hunting
    // a rendering bug that does not exist.
    t.declare('skyLUT', {
      format: FORMATS.hdr, width: 256, height: 128,
      usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING |
             TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC,
    });
    t.declare('transmittanceLUT', {
      format: FORMATS.hdr, width: 256, height: 64,
      usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_SRC,
    });
    // MIPPED. The caustic pattern is 0.57 m at its finest, which subtends
    // under a pixel past ~30 m at grazing incidence, and TAA cannot filter it -
    // the caustic moves independently of the motion vectors, so history
    // rejection fires exactly where the crawl is. passes/caustics.js box-filters
    // the chain itself (a box average of E preserves E's mean, which both
    // consumers depend on), and the same chain doubles as the sun's own angular
    // blur. The base level is written through a single-level subView: a
    // storage-texture binding may name only one mip.
    t.declare('caustics', {
      format: FORMATS.caustics,
      width: p.causticsResolution, height: p.causticsResolution,
      mips: RENDER.CAUSTICS_MIP_LEVELS,
      usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_SRC,
    });

    // Post chain.
    t.declare('bloomChain', { format: FORMATS.hdrLow, scale: 0.5, mips: p.bloomMips });
    // SSAO (render/passes/ssao.js). ssaoRaw is the noisy half-res estimate,
    // ssaoTex the depth-aware 3x3 blur of it that the apply pass upsamples.
    // COPY_SRC on all three SSAO targets so debugReadback()/probes can read
    // the DELIVERED occlusion and gate from one frame - toggling knobs across
    // frames measures animation drift on any moving subject (creature swim
    // phase runs off render time and does not pause), and a same-frame map
    // read is the instrument that survived that.
    t.declare('ssaoTex', {
      format: FORMATS.r8, scale: 0.5,
      usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING |
             TextureUsage.COPY_SRC,
    });
    t.declare('ssaoRaw', {
      format: FORMATS.r8, scale: 0.5,
      usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING |
             TextureUsage.COPY_SRC,
    });
    // The SSAO gate: per FULL-RES pixel, the fraction of the delivered radiance
    // that is AMBIENT - luma(ambient after medium) / luma(final) - written by
    // the four opaque geometry passes (FragOut.gate in pass/terrain.wgsl et
    // al.) and consumed once by the SSAO apply pass. It exists because SSAO
    // must not darken emission, direct sun (the CSM owns that occlusion),
    // punctual lamps or the medium's in-scatter, and the fragment shader is
    // the only place that knows the split. Cleared to 0, so the sky, clouds
    // and ocean - which never write it - take no AO at all. Declared on every
    // tier: the geometry pipelines always carry the target, and 1 byte/px is
    // cheaper than forking four pipeline layouts on the preset.
    t.declare('aoGate', {
      format: FORMATS.r8,
      usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING |
             TextureUsage.COPY_SRC,
    });
    t.declare('ssrTex', { format: FORMATS.hdrLow, scale: 0.5 });
  }

  /**
   * A 64x64 blue-noise tile, generated once at boot with void-and-cluster.
   * Blue noise (rather than white) is what lets stochastic effects resolve
   * cleanly under TAA instead of turning into crawling static.
   */
  _createBlueNoise() {
    const N = 64;
    const rng = makeRng(0x51ee7);
    const values = new Float32Array(N * N);

    // Cheap void-and-cluster approximation: start from white noise, then
    // repeatedly swap the tightest cluster with the largest void. A handful of
    // iterations already gets most of the spectral benefit.
    for (let i = 0; i < N * N; i++) values[i] = rng();

    const energy = new Float32Array(N * N);
    const SIGMA = 1.9;
    const RADIUS = 6;
    const computeEnergy = () => {
      energy.fill(0);
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          let e = 0;
          for (let dy = -RADIUS; dy <= RADIUS; dy++) {
            for (let dx = -RADIUS; dx <= RADIUS; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = (x + dx + N) % N;
              const ny = (y + dy + N) % N;
              const d2 = dx * dx + dy * dy;
              e += values[ny * N + nx] * Math.exp(-d2 / (2 * SIGMA * SIGMA));
            }
          }
          energy[y * N + x] = e;
        }
      }
    };

    for (let iter = 0; iter < 6; iter++) {
      computeEnergy();
      // Swap the value at the highest-energy site with the lowest-energy one.
      let hi = 0, lo = 0;
      for (let i = 1; i < N * N; i++) {
        if (energy[i] > energy[hi]) hi = i;
        if (energy[i] < energy[lo]) lo = i;
      }
      const t = values[hi]; values[hi] = values[lo]; values[lo] = t;
    }

    // Rank-order to a uniform distribution so the tile is exactly equidistributed.
    const order = Array.from({ length: N * N }, (_, i) => i).sort((a, b) => values[a] - values[b]);
    const pixels = new Uint8Array(N * N * 4);
    for (let rank = 0; rank < order.length; rank++) {
      const i = order[rank];
      const v = Math.round((rank / (order.length - 1)) * 255);
      pixels[i * 4 + 0] = v;
      // Offset channels give three decorrelated sequences from one fetch.
      pixels[i * 4 + 1] = (v + 85) % 256;
      pixels[i * 4 + 2] = (v + 170) % 256;
      pixels[i * 4 + 3] = 255;
    }

    this.blueNoiseTexture = createTexture(this.gpu.device, {
      label: 'blue-noise', width: N, height: N, format: 'rgba8unorm',
      usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
    });
    writeTexture2D(this.gpu.device, this.blueNoiseTexture, pixels, N, N);
    this.blueNoiseView = this.blueNoiseTexture.createView({ label: 'blue-noise.view' });
  }

  _onResize() {
    this.targets.resize(this.gpu.renderWidth, this.gpu.renderHeight);
    // Views changed; rebuild lazily. The froxel volumes are fixed-size but
    // RenderTargets.resize() rebuilds every declared target, so the volumetrics
    // variants are stale too.
    this.frameBindGroup = null;
    this._frameBindGroupVol = null;
    if (this.graph) this.graph.resize();
    this.camera.resetHistory();
    events.emit(EVENTS.RESIZE, {
      width: this.gpu.width, height: this.gpu.height,
      renderWidth: this.gpu.renderWidth, renderHeight: this.gpu.renderHeight,
    });
  }

  /**
   * Force the temporal filters to converge on the next frame.
   *
   * Auto exposure and TAA both assume the previous frame is a good predictor of
   * this one, which is true for everything the simulation does to the image and
   * false for a discontinuity imposed from outside it - the day/night debug
   * toggle, a teleport. Without this the frames after such a jump are a
   * multi-second black dip plus a frame of ghosting, and neither is the picture
   * you asked to look at.
   */
  resetAdaptation() {
    this.graph?.byName.get('exposure')?.invalidate(this.gpu.device);
    this.graph?.byName.get('taa')?.invalidateHistory();
    // The froxel volume reprojects against the previous frame too, and a
    // teleport invalidates that reprojection exactly as completely.
    this.graph?.byName.get('volumetrics')?.invalidateHistory();
  }

  // -------------------------------------------------------------------------
  // Bind group 0
  // -------------------------------------------------------------------------

  /**
   * Build (or rebuild) bind group 0. Recreated only when a target view changes,
   * never per frame - it is the single most-bound resource in the renderer.
   */
  _frameBuilder(froxelView) {
    const b = new BindGroupBuilder('frame');
    b.uniform(this.frameBuffer, STAGE.VFC);
    b.storage(this.lightBuffer, STAGE.VFC, true);
    b.storage(this.clusterRangeBuffer, STAGE.VFC, true);
    b.storage(this.clusterIndexBuffer, STAGE.VFC, true);
    b.depthTexture(this.targets.view('shadowAtlas'), STAGE.VFC, '2d-array');
    b.comparisonSampler(this.samplers.shadowCompare, STAGE.VFC);
    b.storage(this.shadowMatrixBuffer, STAGE.VFC, true);
    b.texture(this.targets.view('skyLUT'), STAGE.VFC);
    b.texture(this.targets.view('transmittanceLUT'), STAGE.VFC);
    b.texture(this.targets.view('caustics'), STAGE.VFC);
    b.texture(froxelView, STAGE.VFC, { viewDimension: '3d' });
    b.texture(this.blueNoiseView, STAGE.VFC);
    b.sampler(this.samplers.linearRepeat, STAGE.VFC);
    b.sampler(this.samplers.linearClamp, STAGE.VFC);
    b.nonFilteringSampler(this.samplers.nearestClamp, STAGE.VFC);
    return b;
  }

  _buildFrameBindGroup() {
    const built = this._frameBuilder(this.targets.view('froxelScatter')).build(this.pipelines);
    this.frameBindGroupLayout = built.layout;
    this.frameBindGroup = built.group;
    return this.frameBindGroup;
  }

  get frameLayout() {
    if (!this.frameBindGroupLayout) this._buildFrameBindGroup();
    return this.frameBindGroupLayout;
  }

  /**
   * Bind group 0 for the pass that WRITES the froxel volume, with the previous
   * frame's density volume substituted at binding 10.
   *
   * NOT AN OPTIMISATION - the normal frame group cannot be bound inside the
   * volumetrics pass at all. `froxelScatter` is a TEXTURE_BINDING there and a
   * STORAGE_BINDING in that pass's own group 1, and WebGPU forbids a texture
   * being readable and writable in the same synchronisation scope; Dawn
   * validates that against the group's ENTRIES, not against what the shader
   * statically uses, so simply not calling sampleFroxel() is not enough. This is
   * the same platform rule `shadowCasterGroup` exists for.
   *
   * Substituting rather than omitting matters: BindGroupBuilder auto-numbers its
   * bindings, so dropping the entry would renumber blueNoise from 11 to 10 and
   * every sampler after it, and the shader would silently read the wrong
   * resources. The stand-in is the density volume the pass READS this frame, so
   * it is a real, correctly-dimensioned, read-only texture at that slot and it
   * can never be the one being written.
   *
   * @param {number} parity ctx.parity - 0 writes A and reads B
   */
  frameBindGroupVol(parity) {
    const i = parity & 1;
    if (!this._frameBindGroupVol) this._frameBindGroupVol = [null, null];
    if (!this._frameBindGroupVol[i]) {
      const previous = i === 0 ? 'froxelDensityB' : 'froxelDensityA';
      this._frameBindGroupVol[i] =
        this._frameBuilder(this.targets.view(previous)).build(this.pipelines).group;
    }
    return this._frameBindGroupVol[i];
  }

  /**
   * A CUT-DOWN bind group 0 for the shadow casters, and it is not an
   * optimisation - the frame group cannot be bound inside the shadow pass at all.
   *
   * `shadowAtlas` is a TEXTURE_BINDING in the frame group and a RENDER_ATTACHMENT
   * in the shadow pass, and WebGPU forbids a texture being readable and writable
   * in the same synchronisation scope. Binding the full group inside a cascade's
   * render pass makes the whole command buffer invalid, every frame, with
   * nothing on screen to say so beyond a console error.
   *
   * The caster vertex shaders reach for exactly two things: the Frame uniform
   * (binding 0, for worldOrigin, cameraPos, time and depthAt) and the cascade
   * matrices (binding 6). Everything else in group 0 is fragment-side, and the
   * caster pipelines have no fragment stage, so it is not statically used and
   * does not belong in their layout.
   */
  _buildShadowCasterBindGroup() {
    this.shadowCasterBindGroupLayout = this.pipelines.bindGroupLayout('frame.caster.bgl', [
      { binding: 0, visibility: STAGE.V, buffer: { type: 'uniform' } },
      { binding: 6, visibility: STAGE.V, buffer: { type: 'read-only-storage' } },
    ]);
    this.shadowCasterBindGroup = this.gpu.device.createBindGroup({
      label: 'frame.caster.bg',
      layout: this.shadowCasterBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 6, resource: { buffer: this.shadowMatrixBuffer } },
      ],
    });
  }

  get shadowCasterLayout() {
    if (!this.shadowCasterBindGroupLayout) this._buildShadowCasterBindGroup();
    return this.shadowCasterBindGroupLayout;
  }

  get shadowCasterGroup() {
    if (!this.shadowCasterBindGroup) this._buildShadowCasterBindGroup();
    return this.shadowCasterBindGroup;
  }

  // -------------------------------------------------------------------------
  // Lights
  // -------------------------------------------------------------------------

  clearLights() { this.lightCount = 0; }

  /**
   * Register a callback that adds lights at the TOP of render(), after the game
   * loop's own four submitters have run.
   *
   * WHY A HOOK AND NOT ANOTHER LINE IN main.js. A render PASS cannot submit its
   * lights from execute(): _uploadLights() has already run and the clusterCull
   * pass has already been encoded by then, so anything added there lands a frame
   * late or not at all. The four existing submitters are entity-owned and the
   * loop calls them directly; a pass that owns lights needs somewhere earlier,
   * and this is the only point that is both after the loop and before the
   * upload.
   *
   * IT IS ALSO THE ONLY SUBMISSION POINT ON THE RIGHT SIDE OF camera.update().
   * addLight() rebases against `camera.worldOrigin`, and the loop's four run
   * BEFORE the camera updates - so on the frame a 2048 m rebase lands, their
   * positions are relative to the old origin while the Frame uniform carries the
   * new one. Submitters registered here see the same origin the frame does.
   *
   * ORDER IS LOAD-BEARING, and the reason is in cluster_cull.wgsl: a cluster at
   * the MAX_LIGHTS_PER_CLUSTER cap keeps the 32 LOWEST-INDEXED lights, not the
   * nearest, because the fill loop breaks on count and walks in index order.
   * Running last means the props lose a contested slot and the lamps the player
   * steers by do not - the same argument main.js makes for submitting creatures
   * after the vessel.
   *
   * @param {(r: Renderer) => void} fn
   */
  addLightSubmitter(fn) {
    if (typeof fn !== 'function') return;
    if (this.lightSubmitters.indexOf(fn) < 0) this.lightSubmitters.push(fn);
  }

  /**
   * Add a punctual light. Positions are ABSOLUTE; they are converted to
   * camera-relative space here so callers never have to think about rebasing.
   *
   * THE FOUR `shape` FIELDS ALL DEFAULT TO THEIR IDENTITY, and that is what makes
   * them safe to add. `fill = 0`, `fillPower = 1`, `volumetric = 1` and
   * `falloff = 0` reproduce the pre-shape build byte for byte, so every caller
   * that does not opt in - habitat.js's room lamps, creatures.js's biolights -
   * renders exactly as before and stays the A/B baseline for the ones that do.
   *
   * @param {object} l {position, color, intensity, range, type, direction,
   *                    innerAngle, outerAngle, shadowIndex,
   *                    fill, fillPower, volumetric, falloff}
   */
  addLight(l) {
    if (this.lightCount >= this.maxLights) return -1;
    const i = this.lightCount++;
    const o = i * LIGHT_FLOATS;
    const d = this.lightData;
    const origin = this.camera.worldOrigin;

    d[o + 0] = l.position[0] - origin[0];
    d[o + 1] = l.position[1] - origin[1];
    d[o + 2] = l.position[2] - origin[2];
    d[o + 3] = l.range;

    d[o + 4] = l.color[0];
    d[o + 5] = l.color[1];
    d[o + 6] = l.color[2];
    d[o + 7] = l.intensity;

    const isSpot = l.type === 'spot';
    if (isSpot) {
      d[o + 8] = l.direction[0];
      d[o + 9] = l.direction[1];
      d[o + 10] = l.direction[2];
      const cosOuter = Math.cos(l.outerAngle * 0.5);
      const cosInner = Math.cos((l.innerAngle != null ? l.innerAngle : l.outerAngle * 0.7) * 0.5);
      d[o + 11] = cosOuter;
      d[o + 12] = cosInner;
      // Precompute the reciprocal so the shader does not divide per pixel.
      d[o + 13] = 1 / Math.max(cosInner - cosOuter, 1e-4);
    } else {
      d[o + 8] = 0; d[o + 9] = -1; d[o + 10] = 0;
      d[o + 11] = -1; d[o + 12] = -1; d[o + 13] = 1;
    }
    // 0 point, 1 spot, 2 interior. `interior` shades exactly like a point light
    // and is skipped by the volumetric injection - see LIGHT_INTERIOR in
    // shaders/common/frame.wgsl for why a light inside a dry pressure hull must
    // not scatter in the water the hull is sitting in.
    d[o + 14] = isSpot ? 1 : (l.type === 'interior' ? 2 : 0);
    d[o + 15] = l.shadowIndex != null ? l.shadowIndex : -1;

    // shape: the core-plus-fill beam profile, the volumetric weight and the
    // falloff mix. Derivations at spotAttenuation() and punctualAttenuation()
    // in shaders/common/lighting.wgsl; the authored values are on
    // VESSEL_LIGHTS and PLAYER_LAMP in core/constants.js.
    d[o + 16] = l.fill != null ? l.fill : 0;
    d[o + 17] = l.fillPower != null ? l.fillPower : 1;
    d[o + 18] = l.volumetric != null ? l.volumetric : 1;
    d[o + 19] = l.falloff != null ? l.falloff : 0;
    return i;
  }

  _uploadLights() {
    if (this.lightCount === 0) return;
    this.gpu.device.queue.writeBuffer(
      this.lightBuffer, 0, this.lightData, 0, this.lightCount * LIGHT_FLOATS);
  }

  // -------------------------------------------------------------------------
  // Frame uniform
  // -------------------------------------------------------------------------

  /**
   * Serialise the Frame struct. The write ORDER here is the byte layout, and
   * it must match shaders/common/frame.wgsl exactly. StructWriter enforces the
   * 16-byte alignment rules; padTo() asserts the total size.
   */
  _writeFrameUniform(time, dt) {
    const cam = this.camera;
    const env = this.env;
    const w = this.frameWriter.reset();
    const gpu = this.gpu;

    // Matrices
    w.mat4(cam.view);
    w.mat4(cam.proj);
    w.mat4(cam.viewProj);
    w.mat4(cam.invView);
    w.mat4(cam.invProj);
    w.mat4(cam.invViewProj);
    w.mat4(cam.prevViewProj);
    w.mat4(cam.viewProjUnjittered);

    // Camera
    w.vec4(cam.relativePosition[0], cam.relativePosition[1], cam.relativePosition[2], 1);
    w.vec4(cam.forward[0], cam.forward[1], cam.forward[2], cam.tanHalfFov);
    w.vec4(cam.right[0], cam.right[1], cam.right[2], cam.aspect);
    w.vec4(cam.up[0], cam.up[1], cam.up[2], cam.fov);
    w.vec4(cam.prevRelativePosition[0], cam.prevRelativePosition[1], cam.prevRelativePosition[2], cam.speed);
    w.vec4(cam.worldOrigin[0], cam.worldOrigin[1], cam.worldOrigin[2], RENDER.REBASE_RADIUS);
    w.vec4(cam.near, RENDER.SHADOW_FAR, 1 / cam.near, RENDER.MAX_VIEW_DISTANCE);

    // Sun / moon
    w.vec4(env.sunDir[0], env.sunDir[1], env.sunDir[2], env.sunAngularRadius);
    w.vec4(env.sunColor[0] * env.sunIntensity, env.sunColor[1] * env.sunIntensity,
           env.sunColor[2] * env.sunIntensity, Math.asin(clamp(env.sunDir[1], -1, 1)));
    w.vec4(env.moonDir[0], env.moonDir[1], env.moonDir[2], SKY.MOONS[0].angularRadius);
    w.vec4(env.moonColor[0] * env.moonIntensity, env.moonColor[1] * env.moonIntensity,
           env.moonColor[2] * env.moonIntensity, env.moonPhase);

    // Ambient SH (9 x vec4)
    for (let i = 0; i < 9; i++) {
      w.vec4(env.ambientSH[i * 3], env.ambientSH[i * 3 + 1], env.ambientSH[i * 3 + 2], 0);
    }

    // Water
    // RENDER.WATER_CHROMA lerps the submerged column toward its own
    // achromatic (per-vector mean / luma-grey) values HERE, at the one place
    // the sprung column enters the uniform - see the knob's docstring in
    // core/constants.js. 1.0 writes the sprung values bit-exactly; the
    // surface column below stays raw at any setting.
    const wt = env.waterType;
    // The knob is the MASTER and the per-type `chroma` field (sprung with
    // the column; 1.0 when unauthored) scales under it: KELP_EMERALD's art
    // deviation flattens ITS OWN medium spectrum so gold fruit and dark
    // olive trunks photograph as authored, while every other water is
    // bit-identical at the default. RENDER.WATER_CHROMA = 0 still forces
    // achromatic everywhere (the bisect); = 1 delivers the per-type value.
    const wc = clamp(RENDER.WATER_CHROMA * (wt.chroma ?? 1), 0, 1);
    // The neutral is the MIN channel, not the mean: the least-attenuated
    // channel is the one that carries the delivered image (visibility and
    // daylight at depth are dominated by it), so min-collapse keeps today's
    // brightness and sight range while flattening the spectrum. The mean was
    // tried first and buried the scene - the authored RED coefficients are
    // huge, so mean-neutral water absorbed 10x the light of green water at
    // the kelp anchor (scene lum 0.0121 -> 0.0012, exposure pinned at cap).
    const mT = Math.min(wt.sigmaT[0], wt.sigmaT[1], wt.sigmaT[2]);
    const mS = Math.min(wt.sigmaS[0], wt.sigmaS[1], wt.sigmaS[2]);
    const mK = Math.min(wt.Kd[0], wt.Kd[1], wt.Kd[2]);
    const ch = (v, m) => m + (v - m) * wc;
    w.vec4(ch(wt.sigmaT[0], mT), ch(wt.sigmaT[1], mT), ch(wt.sigmaT[2], mT), WORLD.SEA_LEVEL);
    w.vec4(ch(wt.sigmaS[0], mS), ch(wt.sigmaS[1], mS), ch(wt.sigmaS[2], mS), wt.g);
    w.vec4(ch(wt.Kd[0], mK), ch(wt.Kd[1], mK), ch(wt.Kd[2], mK), wt.id);
    // deepTint is DELIBERATELY exempt: it is the water BODY's colour - what an
    // open-water ray shows - not a spectral filter on objects. Collapsing it
    // turned daylight shallows grey, as the debug captures show: the
    // subjects were already accurate at chroma 0, and the grey bought nothing.
    // "Accurate colours" means the CORAL is not tinted, not that the sea
    // stops being blue.
    w.vec4(wt.deepTint[0], wt.deepTint[1], wt.deepTint[2], env.turbidity);
    w.vec4(env.causticStrength, env.foamCoverage, env.choppiness, env.seaState);
    // Written at the END of the struct, not here - see the waterFogTint block
    // below. Kept out of this run so the water offsets above stay where
    // tools/test-layout.mjs and every shader expect them.

    const depth = cam.depth;
    const underwater = cam.isUnderwater;
    w.vec4(depth, underwater ? 1 : 0, underwater ? 1 : 0, cam.position[1] - WORLD.SEA_LEVEL);

    // Air
    w.vec4(env.fogDensity, env.fogHeightFalloff, 0, 0.985);
    w.vec4(env.fogColor[0], env.fogColor[1], env.fogColor[2], 0.15);

    // Screen / TAA
    w.vec4(gpu.renderWidth, gpu.renderHeight, 1 / gpu.renderWidth, 1 / gpu.renderHeight);
    w.vec4(gpu.width, gpu.height, gpu.preset.renderScale, 1 / gpu.preset.renderScale);
    w.vec4(cam.jitter[0], cam.jitter[1], cam.prevJitter[0], cam.prevJitter[1]);

    // Exposure / time
    w.vec4(this.exposure, this.prevExposure, 1.0, 0);
    w.vec4(time, dt, env.dayFraction, this.frameIndex);

    // Weather
    w.vec4(env.cloudCover, env.rain, env.windSpeed, env.lightningFlash);
    w.vec4(env.windDir[0], env.windDir[1], 0, 0);

    // Counts / flags (u32 x4)
    let flags = 0;
    if (underwater) flags |= FLAG.UNDERWATER;
    if (this.gpu.preset.caustics) flags |= FLAG.CAUSTICS_ON;
    // FLAG_VOLUMETRICS_ON means exactly one thing: "froxelScatter holds THIS
    // frame's volume". It used to be wired to preset.volumetricClouds, an
    // unrelated feature on an unrelated pass, so every froxel read was gated by
    // whether the CLOUD march was affordable. It is now load-bearing for energy
    // conservation as well as for correctness: waterInScatter() drops the
    // collimated beam when this is set, so a frame that sets it without running
    // the pass loses the beam from both sides.
    //
    // Sampled HERE, at uniform-write time, and not inside the pass's execute():
    // the flags are packed before the graph runs, so a field the pass sets would
    // always be one frame late.
    const volumetrics = this.graph?.byName.get('volumetrics');
    if (volumetrics && this.graph.isEnabled(volumetrics)) flags |= FLAG.VOLUMETRICS_ON;
    // Same mechanism, same reason. pass/creature.wgsl hands the UNRESOLVED share
    // of every photophore over to the sprite pass, so a build where the pass was
    // never constructed - registerPasses() reads it off the game object by name
    // - would lose that share entirely. Sampled here rather than in execute()
    // because the flags are packed before the graph runs.
    const glow = this.graph?.byName.get('glow');
    if (glow && this.graph.isEnabled(glow)) flags |= FLAG.GLOW_SPRITES;
    if (this.gpu.preset.ssr) flags |= FLAG.SSR_ON;
    if (env.sunIntensity < 0.02) flags |= FLAG.NIGHT;
    // THE EYE'S OWN MEDIUM, which is a different question from the frame's.
    // FLAG_UNDERWATER stays set inside a pressure hull - the camera IS in the
    // water, it merely has air around it - and the dry BUBBLE is per pixel, in
    // the dryPath target. This bit is only for the handful of things that are
    // genuinely properties of the eye: the depth grade, the composite's own
    // vignette, and which side of a pane the medium lives on.
    if (cam.dryInterior) flags |= FLAG.DRY_INTERIOR;
    if (this.extraFlags) flags |= this.extraFlags;

    w.align(16);
    w.u(this.lightCount);
    w.u(this.gpu.preset.shadowCascades);
    w.u(this.gpu.preset.froxelDim[2]);
    w.u(flags);

    // Seabed albedo. Indexed by water type id, with a mid-grey fallback so an
    // id that outruns the table gives a plausible bottom rather than a black
    // one - a black seabed makes shallow water read as the abyss, which is the
    // exact failure the term exists to fix.
    const bottomTarget = WATER_BOTTOM_ALBEDO[wt.id] || [0.25, 0.25, 0.25];
    const bk = this._bottomAlbedoSeeded
      ? 1 - Math.exp(-Math.max(dt, 0) / RENDER.WATER_BLEND_TAU) : 1;
    this._bottomAlbedoSeeded = true;
    for (let i = 0; i < 3; i++) {
      this._bottomAlbedo[i] += (bottomTarget[i] - this._bottomAlbedo[i]) * bk;
    }
    // The spare component carries the EXACT, sprung suspended-matter load.
    // Do not derive this from env.turbidity: that legacy mapping deliberately
    // clamps every clear-water multiplier <= 1 to zero, making Reef (0.75),
    // Oceanic (1.0), Brine (0.2), and Abyssal (0.55) indistinguishable to the
    // particulate shader. Keeping it beside the other water-column values also
    // avoids expanding the byte-exact Frame layout for one scalar.
    w.vec4(this._bottomAlbedo[0], this._bottomAlbedo[1], this._bottomAlbedo[2],
      Math.max(0, wt.snowMultiplier));

    // Sky geometry, so any pass on bind group 0 can index the sky-view LUT.
    // The altitude clamp is DUPLICATED from sim/sky.js._writeUniform on
    // purpose: the LUT is generated for one viewer radius, and a lookup
    // parameterised by a different one puts the horizon on the wrong row - a
    // metre of error there is a visible bright line. Reproducing the clamp is
    // the only way to guarantee the two agree without binding the Sky uniform.
    const viewerAltitude = clamp(
      cam.position[1] - WORLD.SEA_LEVEL, 0, RENDER.MAX_VIEW_DISTANCE * 4);
    // The spare component is the effective submerged sight-density multiplier.
    // Keep the authored per-water value separate from the global strength so a
    // console A/B can reproduce the old image without disturbing the spring.
    const visibilityStrength = clamp(RENDER.SUBMERGED_VISIBILITY_STRENGTH, 0, 1);
    const sightDensity = 1 - (1 - env.sightDensity) * visibilityStrength;
    w.vec4(SKY.PLANET_RADIUS, SKY.ATMOSPHERE_RADIUS, viewerAltitude,
      clamp(sightDensity, 0.05, 1));

    // Local water chroma. `env.fogTint` is the biome-blended, spring-smoothed
    // value main.js maintains beside the rest of the optical column; it is
    // normalised HERE rather than in the shader so the division happens once
    // per frame instead of once per pixel, and so a degenerate authored tint
    // (a black one) is caught on the CPU and falls back to neutral rather than
    // producing a NaN in every underwater fragment.
    const ft = env.fogTint;
    const ftLuma = ft ? 0.2126 * ft[0] + 0.7152 * ft[1] + 0.0722 * ft[2] : 0;
    if (ftLuma > 1e-6) {
      w.vec4(ft[0] / ftLuma, ft[1] / ftLuma, ft[2] / ftLuma, RENDER.WATER_FOG_TINT_STRENGTH);
    } else {
      w.vec4(1, 1, 1, 0);
    }

    // The same column with its Jerlov red restored, for the WATER-LEAVING
    // RADIANCE only - the term a flyover reads looking down at the sea. The art
    // red cut of 2026-08-02 exists to keep SUBMERGED objects legible, so it
    // belongs on the sight path and the illuminant; this term is looked at from
    // outside the medium, lights nothing and hides nothing. See the
    // surfaceSigmaA block on WATER_TYPES.
    //
    // sigma_t rather than sigma_a because that is what deepWaterReflectance()
    // takes, and it derives absorption back out as sigmaT - sigmaS. sigmaS is
    // COMMON to both sets - 2ba914e came out of absorption alone - so this is
    // exactly `surfaceSigmaA + sigmaS` and needs no second scattering upload.
    //
    // The strength rides in waterSurfaceKd.w and the mix happens in the shader,
    // so RENDER.SURFACE_BODY_PHYSICAL_RED can be flipped live for an A/B in one
    // session rather than needing two builds. The otherwise spare sigmaT.w is
    // an unrelated live control for the submerged shallow diffuse-veil cut.
    w.vec4(wt.surfaceKd[0], wt.surfaceKd[1], wt.surfaceKd[2],
           RENDER.SURFACE_BODY_PHYSICAL_RED);
    w.vec4(wt.surfaceSigmaA[0] + wt.sigmaS[0],
           wt.surfaceSigmaA[1] + wt.sigmaS[1],
           wt.surfaceSigmaA[2] + wt.sigmaS[2], RENDER.SHALLOW_VEIL_REDUCTION);

    // The deep key: the one source that survives aphoticFactor. Read straight
    // off RENDER every frame rather than cached, so all five knobs are live
    // from the console for a bisect - the same reason SURFACE_BODY_PHYSICAL_RED
    // is written here rather than folded into a shader define.
    //
    // NORMALISED ON THE CPU, once per frame instead of once per pixel, and with
    // a fallback: the shader takes dot(viewRay, dir) as a scattering cosine, so
    // a mis-authored zero vector would silently make the phase function read
    // cos = 0 everywhere and turn the key into a flat dome - the exact failure
    // it exists to avoid, with nothing to say so. Straight up is the honest
    // degenerate answer.
    const kd = RENDER.DEEP_KEY_DIR;
    const kl = Math.hypot(kd[0], kd[1], kd[2]);
    if (kl > 1e-6) {
      w.vec4(kd[0] / kl, kd[1] / kl, kd[2] / kl, RENDER.DEEP_KEY_G);
    } else {
      w.vec4(0, 1, 0, RENDER.DEEP_KEY_G);
    }

    // THE COLOUR IS PER PLACE AND THE ENERGY IS NOT, and that split is the whole
    // point of the palette. A single global radiance is a COMMON-MODE term: it
    // moved every deep frame the same direction and they collided in a new
    // histogram cell, which is measured on RENDER.DEEP_KEY_PALETTE. So the row
    // contributes CHROMATICITY ONLY - normalised to unit Rec709 luma here, once
    // per frame, exactly as env.fogTint is normalised twenty lines above and for
    // the identical reason: a palette edit must rotate colour without touching
    // the exposure histogram. The master magnitude stays one number for the
    // whole ocean, so the +0.071 EV the rail was measured at is a property of
    // DEEP_KEY_RADIANCE and cannot be changed by recolouring a biome.
    //
    // SPRUNG, on the same tau and for the same reason as _bottomAlbedo directly
    // above: main.js springs every optical coefficient but SNAPS `wt.id`, so a
    // table indexed by it steps the whole deep haze in one frame at a boundary.
    // Only the tint is sprung - the master is applied AFTER, live - so
    // `RENDER.DEEP_KEY_RADIANCE = [0, 0, 0]` still goes to black instantly
    // rather than fading out over two seconds, and the bisect stays a bisect.
    const master = RENDER.DEEP_KEY_RADIANCE;
    const masterLuma = Math.max(0,
      0.2126 * master[0] + 0.7152 * master[1] + 0.0722 * master[2]);
    const row = RENDER.DEEP_KEY_PALETTE?.[wt.id];
    // A row with no tint, and the no-row case, both fall back to the master's
    // own chromaticity: an unlisted water column keeps exactly the key it had
    // before the palette existed.
    const tint = row?.tint || master;
    const gain = Math.max(0, row ? (row.gain ?? 1) : 1);
    const tl = 0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2];
    // A ZERO-LUMA TINT HOLDS THE SPRING RATHER THAN DRIVING IT TO NEUTRAL, and
    // that is what keeps the bisect exact rather than merely correct-looking.
    // The fallback tint IS the master, so `DEEP_KEY_RADIANCE = [0, 0, 0]` makes
    // this degenerate at every unlisted column; springing toward white there
    // would leave the chromaticity two seconds out of date when the master is
    // put back, which is exactly the interval a same-frame A/B reads in. There
    // is also nothing to lose by holding: the output below is multiplied by
    // masterLuma, which is zero in that case. It doubles as the divide-by-zero
    // guard a mis-authored black tint would otherwise walk into.
    if (tl > 1e-9) {
      const kx = gain / tl;
      const kk = this._deepKeyTintSeeded
        ? 1 - Math.exp(-Math.max(dt, 0) / RENDER.WATER_BLEND_TAU) : 1;
      this._deepKeyTintSeeded = true;
      for (let i = 0; i < 3; i++) {
        const t = Math.max(0, tint[i]) * kx;
        this._deepKeyTint[i] += (t - this._deepKeyTint[i]) * kk;
      }
    }
    w.vec4(this._deepKeyTint[0] * masterLuma, this._deepKeyTint[1] * masterLuma,
      this._deepKeyTint[2] * masterLuma,
      clamp(RENDER.DEEP_KEY_DIRECTIONALITY, 0, 1));

    // Cave interior medium: x is the SPRUNG enclosure main.js maintains (the
    // RENDER.CAVE_ENCLOSURE knob is folded into the spring target CPU-side,
    // so 0 here means open water and the shader needs no second knob).
    w.vec4(this.caveEnclosure,
      // .y: the cave sight-chroma neutralisation weight, the enclosure spring
      // times its knob - so it fades in and out with the same
      // WATER_BLEND_TAU ramp and can never pop at a mouth. See the
      // consumption comment in pass/underwater.wgsl.
      this.caveEnclosure * clamp(RENDER.CAVE_SIGHT_NEUTRAL ?? 0, 0, 1), 0, 0);

    // Veil tuning (see frame.wgsl veilTune). All four are live RENDER knobs
    // whose identity values (1, 0, 1, 1) reproduce the pre-clarity-pass image
    // exactly, so each is its own bisect. Unlike the water column above they
    // are NOT sprung - each is written straight into the uniform every frame.
    // x scales the diffuse in-scatter veil only, y sharpens the fog tint's
    // chroma at unit luma, z scales marine-snow density globally, w gains the
    // froxel's collimated solar shaft.
    w.vec4(RENDER.VEIL_DIFFUSE_GAIN, RENDER.VEIL_CHROMA,
      RENDER.SNOW_DENSITY_SCALE, RENDER.SOLAR_SHAFT_GAIN);

    if (w.bytes !== FRAME_BYTES) {
      throw new Error(
        `[Renderer] Frame uniform is ${w.bytes} bytes but frame.wgsl declares ${FRAME_BYTES}. ` +
        'The JS writer and the WGSL struct have drifted apart.');
    }

    this.gpu.device.queue.writeBuffer(this.frameBuffer, 0, this.frameData, 0, FRAME_BYTES);
  }

  /** Upload the cascade matrices computed by the shadow pass. */
  uploadShadowMatrices() {
    this.gpu.device.queue.writeBuffer(
      this.shadowMatrixBuffer, 0, this.shadowMatrices, 0, this.shadowMatrices.length);
  }

  // -------------------------------------------------------------------------
  // Ambient SH
  // -------------------------------------------------------------------------

  /**
   * Project a simple analytic sky into SH-L2 irradiance coefficients.
   * A full probe-grid GI system is overkill here: the ocean's ambient is
   * dominated by a smooth sky gradient plus the water's own colour, which SH-L2
   * represents essentially exactly, for the cost of 9 vec3s.
   */
  updateAmbientSH(skyZenith, skyHorizon, groundColor) {
    const sh = this.env.ambientSH;
    sh.fill(0);

    // 48 stratified directions is plenty for a field this smooth.
    const N = 48;
    const inv = 1 / N;
    for (let i = 0; i < N; i++) {
      // Fibonacci sphere: even coverage without clustering at the poles.
      const y = 1 - (i + 0.5) * 2 * inv;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const phi = i * 2.39996323;
      const x = Math.cos(phi) * r;
      const z = Math.sin(phi) * r;

      // Sky colour for this direction.
      const t = saturate(y * 0.5 + 0.5);
      let cr, cg, cb;
      if (y >= 0) {
        const k = Math.pow(saturate(y), 0.55);
        cr = lerp(skyHorizon[0], skyZenith[0], k);
        cg = lerp(skyHorizon[1], skyZenith[1], k);
        cb = lerp(skyHorizon[2], skyZenith[2], k);
      } else {
        const k = saturate(-y * 1.4);
        cr = lerp(skyHorizon[0], groundColor[0], k);
        cg = lerp(skyHorizon[1], groundColor[1], k);
        cb = lerp(skyHorizon[2], groundColor[2], k);
      }

      // SH-L2 basis.
      const Y = [
        0.282095,
        0.488603 * y, 0.488603 * z, 0.488603 * x,
        1.092548 * x * y, 1.092548 * y * z,
        0.315392 * (3 * z * z - 1),
        1.092548 * x * z,
        0.546274 * (x * x - y * y),
      ];
      const weight = (4 * Math.PI) * inv;
      for (let b = 0; b < 9; b++) {
        const yb = Y[b] * weight;
        sh[b * 3 + 0] += cr * yb;
        sh[b * 3 + 1] += cg * yb;
        sh[b * 3 + 2] += cb * yb;
      }
    }

    // Convolve radiance -> irradiance with the Lambertian cosine kernel, and
    // fold in 1/PI so the shader can use the result directly as diffuse light.
    const A = [3.141593, 2.094395, 2.094395, 2.094395,
               0.785398, 0.785398, 0.785398, 0.785398, 0.785398];
    const invPi = 1 / Math.PI;
    for (let b = 0; b < 9; b++) {
      const k = A[b] * invPi;
      sh[b * 3 + 0] *= k;
      sh[b * 3 + 1] *= k;
      sh[b * 3 + 2] *= k;
    }
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  /**
   * Encode and submit one frame.
   * The camera must already be updated for this frame.
   */
  render(time, dt) {
    if (this.gpu.lost || this._destroyed) return;

    profiler.beginFrame();
    this.frameIndex++;

    const ctx = this.ctx;
    ctx.frameIndex = this.frameIndex;
    ctx.time = time;
    ctx.dt = dt;
    ctx.parity = this.frameIndex & 1;
    ctx.underwater = this.camera.isUnderwater;
    // Separate from `underwater` on purpose, and both are now true at once
    // inside the habitat. See Camera.isUnderwater for what conflating them cost.
    ctx.dryInterior = this.camera.dryInterior;
    ctx.cameraDepth = this.camera.depth;
    ctx.camera = this.camera;

    // Fire a depth-band event when the camera crosses a boundary; audio, the
    // director and the HUD all key off this rather than polling depth.
    const band = this._depthBand(this.camera.depth);
    if (band !== this.env.lastDepthBand) {
      events.emit(EVENTS.PLAYER_DEPTH_BAND, {
        band, previous: this.env.lastDepthBand, depth: this.camera.depth,
      });
      this.env.lastDepthBand = band;
    }

    this.uniforms.reset();
    // Passes that own lights add them here - after the loop's entity submitters
    // and after camera.update(), before the buffer goes to the GPU. See
    // addLightSubmitter() for why this is the only point that works.
    for (let i = 0; i < this.lightSubmitters.length; i++) {
      this.lightSubmitters[i](this);
    }
    this._uploadLights();
    this._writeFrameUniform(time, dt);

    if (!this.frameBindGroup) this._buildFrameBindGroup();
    ctx.frameBindGroup = this.frameBindGroup;

    let outputTexture;
    try {
      outputTexture = this.gpu.context.getCurrentTexture();
    } catch (err) {
      // Happens if the canvas was resized to zero or the tab is being torn down.
      return;
    }
    ctx.outputView = outputTexture.createView();
    ctx.outputTexture = outputTexture;

    const encoder = this.gpu.device.createCommandEncoder({ label: `frame-${this.frameIndex}` });

    this.graph.execute(encoder);

    this.uniforms.flush();
    profiler.endFrame(this.gpu.device, encoder);
    this.gpu.device.queue.submit([encoder.finish()]);

    this.prevExposure = this.exposure;
  }

  /**
   * Read the clustered light lists back and summarise LIGHTS PER CLUSTER.
   *
   * THIS IS THE GATE FOR ANY CHANGE THAT ADDS LIGHTS, and it is deliberately not
   * a frame-time delta. The clustered path's cost is not linear in the light
   * count - it is linear in cluster OCCUPANCY, because evalPunctualLights() and
   * froxelPunctual() both walk `min(count, MAX_LIGHTS_PER_CLUSTER)` per pixel
   * and per froxel, over 921,600 froxels. A frame-time reading of that is
   * dominated by whatever else the station is doing; occupancy is exact,
   * deterministic for a fixed camera and light set, and has a hard ceiling.
   *
   * `overflow` is the count of clusters sitting exactly AT the cap, and it
   * matters more than the mean: at the cap the cull pass truncates SILENTLY and
   * keeps the 32 lowest-indexed lights, which is submission order and not
   * distance. A non-zero overflow means some cluster is dropping a light that
   * should be lighting it.
   *
   * Slow (it maps and waits). Debug and QA only - never call it per frame.
   *
   * @returns {Promise<object>} occupancy percentiles over all CLUSTER_X * Y * Z
   *   clusters, plus the same over the OCCUPIED ones only
   */
  async debugReadClusters() {
    if (!this.clusterRangeBuffer) return { error: 'cluster range buffer not created' };
    const { readBuffer } = await import('../core/resources.js');
    const raw = await readBuffer(
      this.gpu.device, this.clusterRangeBuffer, this.clusterCount * 8);
    const u32 = new Uint32Array(raw);
    const counts = new Uint32Array(this.clusterCount);
    let occupied = 0, total = 0, max = 0, overflow = 0;
    for (let i = 0; i < this.clusterCount; i++) {
      const c = u32[i * 2 + 1];
      counts[i] = c;
      total += c;
      if (c > 0) occupied++;
      if (c > max) max = c;
      if (c >= RENDER.MAX_LIGHTS_PER_CLUSTER) overflow++;
    }
    const sorted = Array.from(counts).sort((a, b) => a - b);
    const pct = (arr, p) => (arr.length === 0 ? 0
      : arr[Math.min(arr.length - 1, Math.floor(p * arr.length))]);
    const nz = sorted.filter((c) => c > 0);
    return {
      lights: this.lightCount,
      clusters: this.clusterCount,
      occupiedClusters: occupied,
      max,
      overflow,
      meanAll: total / this.clusterCount,
      p50: pct(sorted, 0.50), p95: pct(sorted, 0.95), p99: pct(sorted, 0.99),
      meanOccupied: nz.length > 0 ? total / nz.length : 0,
      p50Occupied: pct(nz, 0.50), p95Occupied: pct(nz, 0.95), p99Occupied: pct(nz, 0.99),
    };
  }

  /**
   * Read a render target back to the CPU and summarise it.
   *
   * The authoritative answer to "did we actually draw anything", and the only
   * one that works for a WebGPU canvas: the swap-chain texture is gone after
   * present, and drawing the canvas into a 2D context does not reliably capture
   * WebGPU content. This copies an internal target, which we own.
   *
   * Slow (it maps and waits). Debug and QA only - never call it per frame.
   *
   * @param {string} name a target declared in _declareTargets()
   * @param {number} maxDim stride the CPU scan so it stays bounded
   * @param {number} slice for a 3D or array target, which z slice / layer to
   *   read. A froxel volume is the one target in the renderer that never
   *   appears on screen, so "which slice" is the whole question: slice 0 is the
   *   nearest 5 cm of water and slice 63 reaches 217 m.
   * @returns {Promise<object>} channel means, luminance, and black fraction
   */
  async debugReadback(name = 'sceneColor', maxDim = 128, slice = 0) {
    const tex = this.targets.texture(name);
    const size = this.targets.size(name);
    if (!tex || !size) return null;

    // THE WHOLE TARGET, then a strided sample of it. What this replaces asked
    // readTexture2D for a maxDim x maxDim region, and readTexture2D copies from
    // origin (0, 0) - so every number this function has ever returned described
    // the top-LEFT CORNER of the frame, 0.7% of the pixels, and in almost every
    // outdoor scenario that corner is sky. "Is the sea too bright" and "did the
    // seabed disappear" were both being answered by a patch that contained
    // neither. The copy is one blit of ~10 MB at 1600x757; this is a debug and
    // QA entry point that already waits on a map, so the cost does not matter
    // and being representative does.
    if ((tex.usage & 0x01) === 0) {
      // A texture without COPY_SRC cannot be copied out; the copy fails
      // validation and leaves the staging buffer zeroed, which is
      // indistinguishable from a genuinely black target. Say so instead.
      return { error: `target '${name}' lacks COPY_SRC usage and cannot be read back` };
    }

    const { readTexture2D } = await import('../core/resources.js');
    const isFloat16 = /16float/.test(tex.format);
    // COMPONENT COUNT FROM THE FORMAT, NOT FROM THE PRECISION. This used to be
    // `isFloat16 ? 8 : 4`, i.e. four components assumed for anything 16-bit
    // float - so a single-channel r16float target was read with a stride and a
    // bytesPerRow four times too large. The copy then walked off the end of
    // every row, and the numbers that came back were plausible, stable and
    // meaningless, which is the same failure mode MAX_GPU_SCOPES had.
    const comps = /^r16float$/.test(tex.format) ? 1
      : /^rg16float$/.test(tex.format) ? 2 : 4;
    const bytesPerPixel = isFloat16 ? 2 * comps : 4;

    const layers = size.layers || 1;
    if (slice < 0 || slice >= layers) {
      return { error: `slice ${slice} out of range (${layers} slices in '${name}')` };
    }

    let raw;
    try {
      raw = await readTexture2D(
        this.gpu.device, tex, size.width, size.height,
        { bytesPerPixel, origin: [0, 0, slice] });
    } catch (err) {
      return { error: String(err) };
    }

    // Stride so the CPU loop stays bounded by maxDim^2 however large the target
    // is, while the samples still span the whole frame.
    const stepX = Math.max(1, Math.floor(size.width / maxDim));
    const stepY = Math.max(1, Math.floor(size.height / maxDim));
    const view = isFloat16 ? new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2) : raw;

    let r = 0, g = 0, b = 0, a = 0, minA = Infinity, maxA = -Infinity;
    let black = 0, maxL = 0, n = 0;
    for (let y = 0; y < size.height; y += stepY) {
      for (let x = 0; x < size.width; x += stepX) {
        const i = (y * size.width + x) * (isFloat16 ? comps : 4);
        let cr, cg, cb, ca;
        if (isFloat16) {
          cr = f16ToF32(view[i + 0]);
          // A one- or two-channel target has no blue and no alpha to read. Fill
          // the missing channels from red so `luminance` and `blackFraction`
          // stay meaningful on a scalar target - a dryPath or an AO buffer is
          // exactly the kind of thing this function is asked about.
          cg = comps > 1 ? f16ToF32(view[i + 1]) : cr;
          cb = comps > 2 ? f16ToF32(view[i + 2]) : cr;
          ca = comps > 3 ? f16ToF32(view[i + 3]) : cr;
        } else {
          cr = view[i + 0] / 255;
          cg = view[i + 1] / 255;
          cb = view[i + 2] / 255;
          ca = view[i + 3] / 255;
        }
        // ALPHA TOO. froxelScatter's alpha is the transmittance the volume owns,
        // and "it is exactly 1.0 everywhere" is a contract that can only be
        // checked by measuring it - the rgb channels look identical either way.
        a += ca;
        if (ca < minA) minA = ca;
        if (ca > maxA) maxA = ca;
        r += cr; g += cg; b += cb; n++;
        const l = cr * 0.2126 + cg * 0.7152 + cb * 0.0722;
        if (l < 1e-4) black++;
        if (l > maxL) maxL = l;
      }
    }

    return {
      target: name, format: tex.format, width: size.width, height: size.height,
      slice, slices: layers, samples: n,
      meanR: r / n, meanG: g / n, meanB: b / n,
      meanA: a / n, minA, maxA,
      luminance: (r * 0.2126 + g * 0.7152 + b * 0.0722) / n,
      maxLuminance: maxL,
      blackFraction: black / n,
    };
  }

  /**
   * Read `sceneDepth` back and report the frame's METRIC DEPTH DISTRIBUTION -
   * the near-mass instrument.
   *
   * WHY IT EXISTS. The occlusion statistic this project reaches for first is
   * relative dark mass ("fraction of pixels below 0.4x the median"), and it
   * measures EXACTLY 0.0000 across ~1.2 M pixels in every underwater frame. On
   * a frame with no bright region that number reports the absence of contrast,
   * not the presence of occluding mass, so it cannot separate "there is nothing
   * in the near field" from "the near field is unlit". Metric distance can:
   * what fraction of the frame stands within 15 m is the same answer whether
   * the frame is black or blazing.
   *
   * debugReadback() cannot do this job - it decodes 4-byte pixels as RGBA8 and
   * a depth32float target is one f32 per texel - which is the same reason
   * debugReadShadowCascade() exists, and this is modelled on it.
   *
   * THE INVERSION IS EXACT AND IT DOES NOT DEPEND ON THE FOV. The frame
   * projection is mat4.perspectiveReverseZInfinite, whose only depth terms are
   * o[10] = 0, o[11] = -1, o[14] = near [verified in core/math.js]. So
   * clip.z = near and clip.w = -z_view at every pixel, ndc.z = near / axial,
   * and axial = near / ndc.z with nothing else in it. TAA cannot disturb that
   * either: mat4.applyJitter writes o[8] and o[9] only. The fov enters solely
   * in the off-axis correction from axial depth to EUCLIDEAN range, and that
   * correction uses the fov AS IT IS AT READBACK. READ IT FROM A SETTLED EYE:
   * CameraRig adds up to 11 deg of speed kick, and a frame rendered at one fov
   * and corrected at another is exact on the view axis and increasingly wrong
   * off it - at 62 -> 73 deg on a 2.21 aspect the extreme corner is out by
   * 16.3%. A stationary station has no kick and no error at all.
   *
   * ndc.z == 0 is the reverse-Z far plane, and on an INFINITE far plane that
   * means "no geometry on this ray" - sky, or water past everything. Those
   * pixels are `infFraction` and are excluded from min/median/p95, but they are
   * in the DENOMINATOR of nearMass: a frame that is 80% sky genuinely has
   * little near mass.
   *
   * It reads sceneDepth rather than sceneDepthOpaque, and there is no choice:
   * sceneDepthOpaque is a copy destination and carries no COPY_SRC, so it would
   * be refused. sceneDepth is post-ocean-prepass, so from above the waterline
   * the sea SURFACE is the occluder that answers - which is what an eye there
   * actually sees.
   *
   * Slow (a full-frame map-and-wait). Debug and QA only - never per frame.
   *
   * @param {number} nearMetres near-mass threshold, euclidean metres from the eye
   * @param {number} maxDim stride the CPU scan so it stays bounded
   * @returns {Promise<object>} nearMass, infFraction and min/median/p95 metres
   */
  async debugReadDepth(nearMetres = 15, maxDim = 256) {
    const name = 'sceneDepth';
    const tex = this.targets.texture(name);
    const size = this.targets.size(name);
    if (!tex || !size) return null;
    if ((tex.usage & 0x01) === 0) {
      // Same refusal as debugReadback, and for the same reason: a copy that
      // fails validation leaves the staging buffer zeroed, and a zeroed depth
      // buffer decodes as "every pixel is at the far plane" - a frame that is
      // 100% sky, which is a perfectly plausible reading.
      return { error: `target '${name}' lacks COPY_SRC usage and cannot be read back` };
    }
    if (tex.format !== 'depth32float') {
      return { error: `target '${name}' is ${tex.format}; this decode assumes one f32 per texel` };
    }

    const { readTexture2D } = await import('../core/resources.js');
    // readTexture2D aligns bytesPerRow up to 256 for copyTextureToBuffer and
    // strips the padding it added, so the row-stride rule is handled there.
    let raw;
    try {
      raw = await readTexture2D(this.gpu.device, tex, size.width, size.height,
        { bytesPerPixel: 4 });
    } catch (err) {
      return { error: String(err) };
    }
    const depth = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);

    const cam = this.camera;
    const near = cam.near;
    const tanY = Math.tan(cam.fov * 0.5);
    const tanX = tanY * cam.aspect;

    const stepX = Math.max(1, Math.floor(size.width / maxDim));
    const stepY = Math.max(1, Math.floor(size.height / maxDim));
    const cols = Math.ceil(size.width / stepX);
    const rows = Math.ceil(size.height / stepY);
    const hits = new Float32Array(cols * rows);

    let n = 0, hitCount = 0, nearCount = 0, sum = 0;
    for (let y = 0; y < size.height; y += stepY) {
      const ndcY = 1 - 2 * (y + 0.5) / size.height;
      const ty = ndcY * tanY;
      for (let x = 0; x < size.width; x += stepX) {
        n++;
        const z = depth[y * size.width + x];
        // `!(z > 0)` and not `z === 0`: it also rejects a NaN, which would
        // otherwise sort to the end and corrupt every percentile after it.
        if (!(z > 0)) continue;
        const ndcX = 2 * (x + 0.5) / size.width - 1;
        const tx = ndcX * tanX;
        const dist = (near / z) * Math.sqrt(1 + tx * tx + ty * ty);
        hits[hitCount++] = dist;
        sum += dist;
        if (dist <= nearMetres) nearCount++;
      }
    }

    const finite = hits.subarray(0, hitCount);
    finite.sort();
    const pick = (q) => (hitCount === 0 ? null
      : finite[Math.min(hitCount - 1, Math.round(q * (hitCount - 1)))]);

    return {
      target: name, width: size.width, height: size.height,
      samples: n, geometrySamples: hitCount, nearMetres,
      nearMass: n ? nearCount / n : 0,
      infFraction: n ? (n - hitCount) / n : 0,
      min: pick(0), median: pick(0.5), p95: pick(0.95),
      mean: hitCount ? sum / hitCount : null,
    };
  }

  /**
   * Read one shadow-atlas layer back and summarise it.
   *
   * THE ONE CHECK THAT DISTINGUISHES "SHIPPED" FROM "SHIPPED A SILENT NO-OP".
   * The atlas clears to DEPTH_CLEAR_VALUE (0.0, the reverse-Z far plane) and the
   * receiver's `compare: 'greater'` reports LIT against 0.0, so an atlas that
   * nothing rendered into is pixel-for-pixel identical to having no shadow pass
   * at all - in every screenshot, every QA brightness number and every existing
   * test. `fractionAtClear` is the number that tells them apart: an unwritten
   * cascade reports 1.0.
   *
   * debugReadback() cannot do this job: it decodes 4-byte pixels as RGBA8, and
   * a depth32float layer is one f32 per texel.
   *
   * Slow (16 MB map-and-wait at 2048). Debug and QA only.
   *
   * @param {number} cascade array layer index
   * @param {number} maxDim stride the CPU scan so it stays bounded
   * @returns {Promise<object>} min/max/mean depth and the fraction still at clear
   */
  async debugReadShadowCascade(cascade = 0, maxDim = 512) {
    const tex = this.targets.texture('shadowAtlas');
    const size = this.targets.size('shadowAtlas');
    if (!tex || !size) return null;
    if ((tex.usage & 0x01) === 0) {
      return { error: 'shadowAtlas lacks COPY_SRC usage and cannot be read back' };
    }
    if (cascade < 0 || cascade >= size.layers) {
      return { error: `cascade ${cascade} out of range (${size.layers} layers)` };
    }

    const { readTexture2D } = await import('../core/resources.js');
    let raw;
    try {
      raw = await readTexture2D(this.gpu.device, tex, size.width, size.height,
        { bytesPerPixel: 4, origin: [0, 0, cascade] });
    } catch (err) {
      return { error: String(err) };
    }
    const depth = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);

    const step = Math.max(1, Math.floor(size.width / maxDim));
    let min = Infinity, max = -Infinity, sum = 0, atClear = 0, n = 0;
    for (let y = 0; y < size.height; y += step) {
      for (let x = 0; x < size.width; x += step) {
        const d = depth[y * size.width + x];
        if (d < min) min = d;
        if (d > max) max = d;
        sum += d;
        if (d === DEPTH_CLEAR_VALUE) atClear++;
        n++;
      }
    }
    return {
      target: 'shadowAtlas', cascade, width: size.width, height: size.height,
      samples: n, min, max, mean: sum / n, fractionAtClear: atClear / n,
    };
  }

  _depthBand(depth) {
    for (let i = 0; i < DEPTH_BANDS.length; i++) {
      if (depth < DEPTH_BANDS[i].max) return i;
    }
    return DEPTH_BANDS.length - 1;
  }

  // -------------------------------------------------------------------------

  destroy() {
    this._destroyed = true;
    this._resizeUnsub?.();
    this.graph?.destroy();
    this.targets?.destroy();
    this.uniforms?.destroy();
    this.frameBuffer?.destroy();
    this.lightBuffer?.destroy();
    this.clusterRangeBuffer?.destroy();
    this.clusterIndexBuffer?.destroy();
    this.shadowMatrixBuffer?.destroy();
    this.blueNoiseTexture?.destroy();
    this.gpu?.destroy();
  }
}

/**
 * Decode an IEEE 754 half-float. Needed by debugReadback because our HDR
 * targets are rgba16float and JS has no native f16 type.
 */
function f16ToF32(h) {
  const sign = (h & 0x8000) ? -1 : 1;
  const exponent = (h >> 10) & 0x1f;
  const fraction = h & 0x3ff;
  if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}
