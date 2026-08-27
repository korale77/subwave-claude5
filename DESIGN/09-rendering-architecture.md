# SUBWAVE -- DESIGN 09: WebGPU Rendering Architecture, Frame Graph, Shaders & Formats

Status: BINDING. Version 1.0. Owner: Renderer.
Any section that draws pixels obeys this document. Where another section conflicts with a
number here, this document wins for GPU-side concerns; report the conflict.

Scope: device/capability negotiation, the exact per-frame pass ordering, the shading model,
shadows, ambient/GI, the material system, the four bind groups, TAA, transparency ordering,
VRAM and millisecond budgets, and the WGSL module layout.

Non-scope: gameplay, world generation algorithms, creature AI, audio. This document only
specifies the *interfaces* those systems present to the renderer (buffer layouts, texture
formats, draw submission contracts).

---

## 0. GLOBAL RENDERER CONVENTIONS (read first)

| Convention | Value |
|---|---|
| Handedness | Right-handed. +X east, +Y up, +Z south. Metres. |
| Sea level | y = 0.0 exactly. Depth d = -y, positive downward. |
| Heading | 0 rad = north (-Z), increasing clockwise seen from +Y. east = pi/2. |
| Clip space | WebGPU NDC: x,y in [-1,1], z in [0,1]. |
| Depth convention | REVERSED-Z. Near plane maps to z=1.0, far to z=0.0. |
| Far plane | INFINITE (reversed-Z infinite perspective). near = 0.08 m. |
| Depth compare | `greater` for all depth tests. Clear value 0.0. |
| Depth linearize | `linearViewZ = near / max(depth, 1e-7)` (infinite reversed-Z). |
| Winding | Counter-clockwise = front face. `cullMode: 'back'` by default. |
| Colour space | All lighting in linear Rec.709 primaries. sRGB encode only at the final swapchain write. |
| Photometric unit | Radiance stored in the HDR buffer is **pre-exposed**: `stored = radiance_nits * frame.exposure`. Sun at noon = 1.6e5 nits equivalent. |
| Camera-relative | All world positions passed to shaders are relative to `frame.worldOrigin`, re-anchored whenever the camera moves > 2048 m from the current origin. f32 is sufficient within +/-4096 m. |
| Time base | `frame.timeSeconds` wraps at 3600.0 s to preserve f32 precision in shader noise. All animation phases must be wrap-safe (use only sin/cos/fract of `time * k` where `k*3600` is an integer multiple of 2pi or 1.0). |

### 0.1 Quality tiers

Four tiers. The tier is chosen at boot by the capability probe (Section A.5) and may be
changed at runtime; changing tier destroys and rebuilds the render-target set and the
pipeline cache subset that depends on tier-scoped `#define`s.

| Tier | Name | Target | Render scale (default) | Notes |
|---|---|---|---|---|
| T0 | Shoal | 30 fps @ 1280x720 | 0.72 | Weak integrated GPUs. Heavy feature removal. |
| T1 | Reef | 60 fps @ 1600x900 | 0.85 | Modern integrated / low dGPU. |
| T2 | Trench | 60 fps @ 1920x1080 | 1.00 | **Reference tier.** Apple M-series, mid dGPU. All budgets in this doc are T2. |
| T3 | Abyss | 60 fps @ 2560x1440 | 1.00 | High dGPU. Adds PCSS, higher froxel res, extra cloud steps. |

Dynamic resolution scaling (DRS) is always on: render scale is adjusted in steps of 0.05
within `[tierMin, tierMax]` based on a 12-frame median of the GPU frame time from
timestamp queries. Target 15.2 ms; scale down if median > 16.0 ms for 8 consecutive frames,
scale up if median < 13.4 ms for 30 consecutive frames. UI/HUD always renders at native
resolution (it is composited after upscale).

---

## A. DEVICE & CAPABILITIES

### A.1 Adapter and device request

```
adapter = await navigator.gpu.requestAdapter({
  powerPreference: 'high-performance',
  forceFallbackAdapter: false
});
```

If `navigator.gpu` is undefined, or `requestAdapter` returns null, or the adapter reports
`isFallbackAdapter === true`, the game shows the "WebGPU required" screen and stops. There
is **no WebGL fallback** (hard constraint). The screen names Chrome 121+ explicitly and
links to `chrome://gpu`.

### A.2 Features

No feature is *required* -- the renderer must boot on a bare core WebGPU device. Every
feature is requested opportunistically and gates an optional path.

| Feature | Requested | If present | If absent |
|---|---|---|---|
| `timestamp-query` | always | Per-pass GPU timing, DRS driven by real GPU ms, dev HUD flamegraph. Resolve into a 2 x 64 x 8-byte query set, read back with a 3-frame-deep staging ring. | DRS falls back to CPU frame-time deltas (`performance.now()` between `requestAnimationFrame`), smoothed over 20 frames. Per-pass profiler disabled. |
| `float32-filterable` | always | HiZ and the ocean displacement cascade can use linear-filtered `r32float`/`rgba32float`. Cloud weather map at f32. | Ocean displacement stored as `rgba16float` (loses ~0.5 mm of vertical precision at 2 km cascade -- acceptable). HiZ sampled with `textureLoad` + manual gather. |
| `depth32float-stencil8` | always | Single depth+stencil target for the decal/water-mask stencil trick, and for the "inside cockpit" stencil region. | Stencil emulated with a separate `r8uint` storage texture written from the fragment shader (T2/T3 only); at T0/T1 the stencil-dependent effects (interior-only volumetrics tint, canopy edge mask) are disabled. |
| `shader-f16` | always | `enable f16;` in the froxel scatter, bloom, cloud march, boids, and particle shaders. ~12-18% faster on those passes on Apple silicon. Storage of froxel history as `f16` vec4 in a storage buffer variant. | All f16 code paths compile to f32 via the `HALF`/`h4` typedef macros in `common/precision.wgsl`. |
| `rg11b10ufloat-renderable` | always | Bloom chain and the volumetric cloud buffer use `rg11b10ufloat` instead of `rgba16float` (halves that VRAM, ~0.05 ms saved). | `rgba16float`. |
| `bgra8unorm-storage` | always | Final composite can write the swapchain texture directly from a compute shader, skipping one fullscreen draw. | Final composite is a fullscreen triangle render pass. |
| `dual-source-blending` | optional | Used only by the canopy-glass pass for per-channel tinted transmission (`src1` as the transmission colour) in a single pass. | Canopy glass uses two passes: multiply-blend transmission, then additive reflection. Costs +0.06 ms. |
| `subgroups` | optional | Faster histogram reduction, boids neighbour reduction, FFT butterfly stage. | Workgroup-shared-memory reductions. |
| `texture-compression-bc` / `-astc` / `-etc2` | **NOT requested** | n/a | n/a -- all textures are generated at runtime on the GPU from noise; we do not ship compressed assets and do not implement a runtime BC encoder in v1. Left as a post-v1 memory optimisation (a compute BC7 encoder would cut the material array VRAM by ~4x). |
| `depth-clip-control` | optional | `unclippedDepth: true` on the shadow pipelines so that geometry between the light and the near plane still writes correct depth ("pancaking" without artefacts). | Shadow cascade near planes are extended backwards by 250 m instead; costs depth precision, mitigated by `depth32float` cascades. |
| `indirect-first-instance` | always | GPU culling writes `firstInstance` directly into the indirect args, so one indirect buffer serves all batches. | Each batch gets its own indirect draw slot with `firstInstance = 0` and a per-batch instance-buffer offset supplied through bind group 3 dynamic offset. |
| `clip-distances` | not used | n/a | n/a |

### A.3 Requested limits

Requested in `requestDevice({ requiredLimits })`. If a request fails, the code retries with
the adapter's reported limit for that key, then re-runs the tier decision.

| Limit | Requested | Core default | Why |
|---|---|---|---|
| `maxTextureDimension2D` | 8192 | 8192 | Shadow atlas is 2048 per cascade in an array; sky/BRDF LUTs are small. 8192 is never exceeded. |
| `maxTextureArrayLayers` | 256 | 256 | Material arrays use up to 64 layers, caustics 8, blue noise 64. |
| `maxBindGroups` | 4 | 4 | Exactly four groups. See Section G. |
| `maxBindingsPerBindGroup` | 24 | 1000 | Group 0 uses 19. |
| `maxUniformBufferBindingSize` | 65536 | 65536 | Frame = 1312 B, Shadow = 400 B, per-draw = 256 B. |
| `maxStorageBufferBindingSize` | 268435456 (256 MiB) | 134217728 | Terrain vertex pool is a single 192 MiB storage buffer at T2/T3. **Fallback:** if only 128 MiB, the terrain pool is split into 2 buffers and bound via a pass-level dynamic index (costs one extra bind group swap per 2048 chunks). |
| `maxBufferSize` | 268435456 | 268435456 | Same. |
| `maxStorageBuffersPerShaderStage` | 8 | 8 | Group 0 uses 3, leaving 5 for the pass/material/draw groups. Hard budget, see G.5. |
| `maxStorageTexturesPerShaderStage` | 8 | 4 | Froxel scatter writes 2, ocean FFT writes 3, GPU cull writes 0 textures. **Fallback to 4:** ocean FFT splits its assemble pass into two dispatches (+0.04 ms). |
| `maxSampledTexturesPerShaderStage` | 16 | 16 | Group 0 uses 9; groups 1-3 have a hard combined budget of 7. See G.5. |
| `maxSamplersPerShaderStage` | 8 | 16 | Group 0 defines 5 shared samplers; material set adds 1. |
| `maxVertexBuffers` | 4 | 8 | Terrain and instanced meshes use vertex-pulling from storage buffers, not vertex buffers. Only the fullscreen triangle (0 buffers) and the UI (1 buffer) use the vertex stage classically. |
| `maxVertexAttributes` | 8 | 16 | |
| `maxColorAttachments` | 4 | 8 | Prepass uses 2, forward uses 1, cloud pass uses 2. |
| `maxComputeWorkgroupStorageSize` | 16384 | 16384 | FFT butterfly needs 256 x 2 x vec2f x 2 = 8192 B; boids grid tile needs 12 KB. |
| `maxComputeInvocationsPerWorkgroup` | 256 | 256 | |
| `maxComputeWorkgroupSizeX/Y/Z` | 256 / 256 / 64 | 256 / 256 / 64 | |
| `maxComputeWorkgroupsPerDimension` | 65535 | 65535 | |
| `maxDynamicUniformBuffersPerPipelineLayout` | 2 | 8 | Bind group 3 uses 1 dynamic uniform. Bind group 1 uses 1. |

### A.4 Canvas configuration

```
context.configure({
  device,
  format: navigator.gpu.getPreferredCanvasFormat(),   // bgra8unorm on Chrome/macOS
  alphaMode: 'opaque',
  usage: GPUTextureUsage.RENDER_ATTACHMENT
       | (hasBgra8Storage ? GPUTextureUsage.STORAGE_BINDING : 0),
  colorSpace: 'srgb',
  toneMapping: { mode: 'standard' }
});
```

HDR display output (`extended` tone mapping / rec2100-hlg) is **out of scope for v1**;
the tonemapper always targets 1.0 = display white and the final buffer is sRGB-encoded.
The canvas backing store is set to `floor(cssWidth * devicePixelRatio)` clamped so that
`width * height <= 3_686_400` (i.e. never more than 1440p worth of pixels) -- beyond that,
`devicePixelRatio` is artificially reduced.

### A.5 Graceful degradation matrix

Tier is picked by: (1) an adapter-info heuristic (`adapter.info.vendor`/`architecture`,
`isFallbackAdapter`), (2) a 400 ms boot micro-benchmark that runs the froxel scatter shader
over a 160x90x64 volume 20 times and measures wall-clock, (3) the user's saved override in
localStorage (`subwave.gfx.tier`), which always wins if present.

| Feature | T0 Shoal | T1 Reef | T2 Trench | T3 Abyss |
|---|---|---|---|---|
| Render scale range | 0.55-0.80 | 0.70-1.00 | 0.80-1.00 | 0.85-1.00 |
| Shadow cascades | 2 | 3 | 4 | 4 |
| Shadow resolution | 1024 | 1536 | 2048 | 2048 |
| Shadow filter | 2x2 hardware PCF | 9-tap PCF | 16-tap Poisson PCF | PCSS (16 blocker + 32 filter) |
| Froxel volume | 96x54x32 | 128x72x48 | 160x90x64 | 192x108x96 |
| Froxel temporal reproj. | off | on | on | on |
| Volumetric clouds | 2D impostor billboard sky only | quarter-res, 32 steps | half-res, 64 steps | half-res, 96 steps + 8 light steps |
| Ocean FFT cascades | 2 @ 128^2 | 3 @ 256^2 | 4 @ 256^2 | 4 @ 512^2 (cascade 0 only at 512) |
| Ocean surface tessellation | 5 LODs, 24 m base quad | 6 LODs, 16 m | 7 LODs, 8 m | 7 LODs, 4 m |
| SSR | off (env cube only) | quarter-res, 12 steps | half-res, 24 steps + 4 refine | half-res, 40 steps + 6 refine |
| GTAO | off (SH ambient only) | half-res, 4 slices x 4 steps | half-res, 6 slices x 6 steps | full-res, 8 slices x 8 steps |
| Caustics | off | 256^2, 1 depth slice | 512^2, 4 depth slices | 512^2, 8 depth slices, chromatic |
| Terrain triplanar | 1 axis (dominant) | 3-axis, k=3 | 3-axis, k=4 + detail | 3-axis, k=8 + detail + POM |
| Parallax occlusion (POM) | off | off | off | on, 8-24 steps, terrain + hard-surface only |
| TAA | off (FXAA-equivalent 3-tap luma AA) | on, 8-sample Halton | on, 16-sample Halton | on, 16-sample Halton + CAS |
| Motion blur | off | off | off | on, 8 taps |
| Bloom mips | 4 | 5 | 6 | 6 |
| Lens water droplets | off | on (static) | on (animated) | on (animated + refracted) |
| Max punctual lights | 128 | 384 | 1024 | 1024 |
| Max shadowed punctual | 0 | 2 | 4 | 6 |
| Max lights/cluster | 24 | 48 | 64 | 64 |
| Particle budget (live) | 12k | 32k | 65k | 131k |
| Boids agents | 1536 | 4096 | 8192 | 16384 |
| Skinned creature budget | 24 | 64 | 128 | 192 |
| Anisotropic filtering | 1x | 4x | 8x | 16x |
| Material array size | 256^2 x 32 | 256^2 x 48 | 512^2 x 48 | 512^2 x 64 |
| Decals | off | off | on | on |
| Target VRAM | 300 MB | 460 MB | 800 MB | 1250 MB |

**Hard-failure fallbacks (independent of tier):**

- Device lost (`device.lost`): show a modal, attempt exactly one automatic re-init after
  1500 ms, rebuilding all resources from the procedural generators (nothing is loaded from
  disk, so recovery is fully deterministic given the world seed). Second loss = give up.
- Shader compilation error at boot: the offending permutation falls back to a
  `debug_magenta` pipeline and the error string is written to `console.error` plus the
  in-game diagnostics overlay; the frame still renders.
- `createRenderPipelineAsync` is used for everything; the loading screen does not dismiss
  until the "core 42" pipelines are resolved. Non-core permutations (rare materials,
  debug views) are compiled lazily and the draw is skipped for the frames where the
  pipeline is not ready yet.

---

## B. FRAME GRAPH

### B.1 Structure

One `GPUCommandEncoder` per frame, submitted once at the end (single `queue.submit`).
Passes are grouped into 7 phases. Within a phase, order is as listed. There is exactly one
compute pass encoder per contiguous run of compute passes (they are dispatches inside a
shared `beginComputePass`) except where a storage-texture read-after-write barrier forces a
split -- WebGPU inserts those barriers automatically between dispatches in the same pass, so
splits are only needed when a pass output must be *sampled* (not `textureLoad`ed) by a
later dispatch, which requires a usage transition and therefore a new pass.

Notation in the tables:
- `LD` = load op: `C` clear, `L` load, `-` n/a. `ST` = store op: `S` store, `D` discard.
- Cost is the T2 @ 1920x1080 GPU budget in milliseconds.
- Tiers column lists the tiers at which the pass executes.

### B.2 Phase 1 -- Simulation & preparation (compute)

| # | Pass | Type | Inputs | Outputs (format) | LD/ST | ms | Tiers |
|---|---|---|---|---|---|---|---|
| 1.01 | `frame_upload` | copy | CPU staging ring (3 frames) | Frame UBO 1312 B, Shadow UBO 400 B, light SSBO 64 KB, draw UBO ring 4 MB | - | 0.02 | all |
| 1.02 | `ocean_spectrum` | compute | h0 spectrum `rgba16float` 256x256x4 (static, regenerated on sea-state change) | Hkt dx/dy/dz `rgba32float` 256x256x4 x3 | -/S | 0.05 | all |
| 1.03 | `ocean_fft_h` | compute | Hkt, butterfly LUT `rgba32float` 8x256 | ping `rgba32float` 256x256x4 x3 | -/S | 0.18 | all |
| 1.04 | `ocean_fft_v` | compute | ping | displacement `rgba16float` 256x256x4, derivatives `rgba16float` 256x256x4 | -/S | 0.17 | all |
| 1.05 | `ocean_assemble` | compute | displacement, derivatives, prev foam | normal+folding `rgba16float` 256x256x4, foam `r16float` 256x256x4 | -/S | 0.06 | all |
| 1.06 | `ocean_mips` | compute | displacement, normal | mip chain (6 levels each) | -/S | 0.04 | all |
| 1.07 | `terrain_meshing` | compute | density field params, chunk request queue | terrain vertex pool (storage), index pool, chunk meta | -/S | 0.45 (amortized cap) | all |
| 1.08 | `skinning` | compute | bone matrices SSBO, rest-pose vertex pool | skinned vertex pool `array<PackedVertex>` | -/S | 0.18 | all |
| 1.09 | `boids_grid_build` | compute | agent SSBO | grid counts + offsets (u32), sorted agent ids | -/S | 0.04 | all |
| 1.10 | `boids_update` | compute | agent SSBO, grid, terrain SDF coarse `r16float` 64^3 | agent SSBO (double-buffered) | -/S | 0.06 | all |
| 1.11 | `particle_emit` | compute | emitter SSBO, free-list | particle SSBO, free-list | -/S | 0.03 | all |
| 1.12 | `particle_update` | compute | particle SSBO, HiZ (prev frame), flow field `rgba8` 64^3 | particle SSBO, alive-list, indirect args | -/S | 0.09 | all |
| 1.13 | `light_prepass_cull` | compute | light SSBO, frustum | active-light index list, active count | -/S | 0.02 | all |
| 1.14 | `light_cluster_cull` | compute | active list, cluster AABB SSBO | cluster ranges `array<vec2u>`, light index list | -/S | 0.08 | all |
| 1.15 | `sky_transmittance_lut` | compute | atmosphere params | `rgba16float` 256x64 | -/S | 0.03 (only when sun moves > 0.25 deg) | all |
| 1.16 | `sky_multiscatter_lut` | compute | transmittance LUT | `rgba16float` 32x32 | -/S | 0.05 (same trigger) | T1-T3 |
| 1.17 | `sky_view_lut` | compute | transmittance, multiscatter | `rgba16float` 192x108 (lat-long, non-linear v) | -/S | 0.06 | all |
| 1.18 | `sky_ambient_sh` | compute | sky view LUT | ambient SH SSBO (9 x vec4f), copied into next frame's Frame UBO | -/S | 0.01 | all |
| 1.19 | `aerial_perspective_lut` | compute | transmittance, multiscatter | `rgba16float` 32x32x32 | -/S | 0.09 | T1-T3 |
| 1.20 | `env_specular_update` | compute | sky view LUT, ambient SH, water params | env cube `rgba16float` 64x64x6, 6 mips (1 face + its mips per frame, 6-frame cycle) | -/S | 0.05 | all |
| 1.21 | `cloud_noise_bake` | compute | - | shape `r8unorm` 128^3, detail `r8unorm` 32^3 | -/S | 0 (boot only, 4.2 ms once) | T1-T3 |
| 1.22 | `caustics_gen` | compute | ocean normal cascade 0+1, sun dir | caustics `rgba8unorm` 512x512x4 array (RGB = per-wavelength intensity at 4 depth slices) | -/S | 0.12 | T1-T3 |
| 1.23 | `sky_visibility_update` | compute | terrain coarse SDF `r16float` 128^3 | sky visibility `rgba8unorm` 64x32x64 (rgb = bent normal, a = visibility), 8 z-slices/frame | -/S | 0.04 | T1-T3 |
| 1.24 | `gpu_cull_opaque` | compute | instance SSBO, chunk meta, HiZ (previous frame, reprojected), Frame | indirect args buffer, compacted instance index buffer, per-batch counts | -/S | 0.15 | all |

Phase 1 subtotal: **2.07 ms**.

Notes:
- 1.02-1.06 are one compute pass encoder; the FFT is a Stockham auto-sort radix-2, 8 stages
  for 256, with the butterfly factors precomputed into an `rgba32float` 8x256 LUT at boot.
  Three fields (dY, dX+dZ packed, slope+jacobian packed) x 4 cascades = 12 transforms per
  axis, issued as a single dispatch with `z = 12`.
- 1.07 is *budgeted*: the meshing dispatch consumes at most `N` chunk jobs per frame where
  `N` is adjusted to keep the measured pass under 0.5 ms (start at 4, range 1..12).
- 1.24 uses the *previous* frame's HiZ reprojected by `prevViewProj -> viewProj`; a small
  (2-texel) conservative dilation of the tested bounding-sphere screen extent compensates.
  False negatives are impossible by construction (the dilation only over-estimates size);
  false positives (drawing something occluded) are harmless.

### B.3 Phase 2 -- Shadows (render)

| # | Pass | Type | Inputs | Outputs | LD/ST | ms | Tiers |
|---|---|---|---|---|---|---|---|
| 2.01 | `shadow_cascade_0` | render | terrain pool, instance pool, skinned pool, indirect args | `depth32float` 2048x2048 array layer 0 | C(0.0)/S | 0.36 | all |
| 2.02 | `shadow_cascade_1` | render | same | layer 1 | C/S | 0.24 | all |
| 2.03 | `shadow_cascade_2` | render | same | layer 2 | C/S | 0.20 | T1-T3 |
| 2.04 | `shadow_cascade_3` | render | same | layer 3 | C/S | 0.15 | T2-T3 |

Phase 2 subtotal: **0.95 ms**. No colour attachments. `fragment` stage is omitted entirely
for opaque casters (depth-only pipeline, no fragment entry point) and is a 1-instruction
alpha-test shader for foliage/kelp. Cascades 2 and 3 are re-rendered only every other frame
in an alternating pattern (2 on even frames, 3 on odd) when the camera's angular+positional
delta is below (0.6 deg, 1.2 m); the budget above assumes the worst case.

### B.4 Phase 3 -- Prepass, HiZ, AO

| # | Pass | Type | Inputs | Outputs | LD/ST | ms | Tiers |
|---|---|---|---|---|---|---|---|
| 3.01 | `prepass` | render | terrain pool, instance pool, skinned pool, indirect args | MRT0 `rgb10a2unorm` (oct-normal.xy 10+10, roughness 10, matClass 2), MRT1 `rg16float` (screen-space motion vector, NDC units), depth `depth32float` | C(0,0,0,0)/S, C(0.0)/S | 0.85 | all |
| 3.02 | `hiz_build` | compute | depth | `r32float` 1920x1080 with 8 mips, min-reduce (reversed-Z: min value = farthest) | -/S | 0.10 | all |
| 3.03 | `gtao_trace` | compute | HiZ, MRT0, blue noise | AO+bent-normal `rgba8unorm` half-res | -/S | 0.35 | T1-T3 |
| 3.04 | `gtao_denoise` | compute | AO, depth, prev AO, motion | AO `rgba8unorm` half-res (history) | -/S | 0.15 | T1-T3 |

Phase 3 subtotal: **1.45 ms**.

The prepass is a *visibility* prepass, not a full G-buffer. It exists to (a) give the
forward passes `depthCompare: 'equal'` + `depthWriteEnabled: false` so overdraw costs one
depth test, (b) feed HiZ for next-frame culling and this-frame SSR, (c) supply motion
vectors for TAA and motion blur, and (d) supply normals for GTAO and SSR. The 2-bit
`matClass` field is: `0 = terrain, 1 = organic (SSS-capable), 2 = hard-surface/vessel,
3 = water-adjacent/wet`. SSR and GTAO use it to modulate their behaviour.

Alpha-tested geometry (kelp fronds, fish fins) participates in the prepass with a
`depthWriteEnabled: true, depthCompare: 'greater'` alpha-test pipeline. Transparent
geometry does not.

### B.5 Phase 4 -- Volumetrics (compute)

| # | Pass | Type | Inputs | Outputs | LD/ST | ms | Tiers |
|---|---|---|---|---|---|---|---|
| 4.01 | `froxel_inject` | compute | Frame, light SSBO, cluster lists, shadow array, caustics, water params, blue noise | scattering `rgba16float` 160x90x64 (rgb = sigma_s * phase-weighted radiance, a = sigma_t) | -/S | 0.22 | all |
| 4.02 | `froxel_reproject` | compute | scattering, history `rgba16float` 160x90x64, Frame(prevViewProj) | scattering (blended in place via ping-pong) | -/S | 0.06 | T1-T3 |
| 4.03 | `froxel_integrate` | compute | scattering | integrated `rgba16float` 160x90x64 (rgb = accumulated in-scatter, a = transmittance) | -/S | 0.24 | all |
| 4.04 | `cloud_render` | compute | cloud noise 3D, weather map, sky LUTs, depth (for occlusion), blue noise | cloud colour `rgba16float` half-res (rgb premultiplied, a = transmittance), cloud depth `r32float` half-res | -/S | 0.55 | T1-T3 |
| 4.05 | `cloud_reproject` | compute | cloud colour, cloud history, motion | cloud history | -/S | 0.10 | T1-T3 |

Phase 4 subtotal: **1.17 ms**.

Froxel geometry: 160 x 90 tiles (12 x 12 px each at 1080p) x 64 depth slices.
Slice distribution is exponential over `[froxelNear=0.25 m, froxelFar]`:
`z(k) = froxelNear * pow(froxelFar/froxelNear, (k + jitter) / 64)` with `froxelFar = 96 m`
underwater and `640 m` above water. The `jitter` is a per-frame Halton(2) value in [0,1)
that is *identical for all froxels in a frame* (whole-volume jitter) so that reprojection
stays coherent, plus a per-froxel blue-noise offset of +/-0.15 slices.

### B.6 Phase 5 -- Main forward render (render)

Single render pass encoder wherever possible: passes 5.01-5.10 share one
`beginRenderPass` with `colorAttachments = [HDR rgba16float]` and
`depthStencilAttachment = depth32float (load, readonly for 5.02+ where noted)`.
Splits are forced only where a pass must *sample* the HDR target it also writes
(refraction) -- that requires a copy, listed explicitly.

| # | Pass | Type | Inputs | Outputs | LD/ST | ms | Tiers |
|---|---|---|---|---|---|---|---|
| 5.01 | `sky` | render | sky view LUT, transmittance, star field (procedural), cloud buffer | HDR `rgba16float` | C(0)/S, depth L (test `equal` to 0.0 = far) | 0.12 | all |
| 5.02 | `forward_terrain` | render | terrain pool, material set 0, group 0 | HDR | L/S, depth L, `equal`, no write | 1.85 | all |
| 5.03 | `forward_scatter` | render | instance pool, indirect args, material set 1 (organic) | HDR | L/S, depth `equal`, no write | 0.95 | all |
| 5.04 | `forward_skinned` | render | skinned pool, material set 1 | HDR | L/S, depth `equal`, no write | 0.55 | all |
| 5.05 | `forward_vessel` | render | vessel mesh pool, material set 2 (hard-surface) | HDR | L/S, depth `equal`, no write | 0.28 | all |
| 5.06 | `decals` | render | decal instance SSBO, material set 2, depth (read-only) | HDR (blend: `src-alpha`/`one-minus-src-alpha`) | L/S, depth `greater-equal`, no write | 0.10 | T2-T3 |
| 5.07 | `volumetric_apply` | render | froxel integrated, depth | HDR (blend `one`/`src-alpha` where src.a = transmittance) | L/S | 0.10 | all |
| 5.08 | `cloud_composite` | render | cloud history, cloud depth, depth | HDR (blend `one`/`src-alpha`) | L/S | 0.08 | T1-T3 |
| -- | `hdr_copy_for_refraction` | copy | HDR | HDR-copy `rgba16float` (half-res at T0/T1, full at T2/T3), 5 mips for rough refraction | - | 0.12 | all |
| 5.09 | `ssr_trace` | compute | HiZ, MRT0, HDR-copy, env cube | SSR `rgba16float` half-res (rgb radiance, a = confidence) | -/S | 0.40 | T1-T3 |
| 5.10 | `ssr_resolve` | compute | SSR, MRT0, GTAO | SSR resolved half-res | -/S | 0.15 | T1-T3 |
| 5.11 | `ocean_surface` | render | ocean displacement/normal/foam cascades, HDR-copy, SSR, env cube, froxel, caustics | HDR | L/S, depth L, `greater`, **write** | 0.70 | all |
| 5.12 | `transparent_sorted` | render | jellyfish/membrane meshes, HDR-copy, group 0 | HDR (blend `src-alpha`/`one-minus-src-alpha`, premultiplied variant for additive bioluminescence) | L/S, depth `greater`, no write | 0.35 | all |
| 5.13 | `particles` | render | particle SSBO, alive list, indirect args, depth (soft particles), froxel | HDR (two pipelines: alpha-blend and additive) | L/S, depth `greater`, no write | 0.40 | all |
| 5.14 | `canopy_glass` | render | vessel canopy mesh, HDR-copy, env cube, HUD emissive layer | HDR | L/S, depth `greater`, no write | 0.14 | all |

Phase 5 subtotal: **6.29 ms**.

### B.7 Phase 6 -- Post-processing (compute unless noted)

| # | Pass | Type | Inputs | Outputs | LD/ST | ms | Tiers |
|---|---|---|---|---|---|---|---|
| 6.01 | `luma_histogram` | compute | HDR (mip 2, generated by a 0.03 ms downsample) | histogram SSBO 256 x u32 | -/S | 0.04 | all |
| 6.02 | `exposure_adapt` | compute | histogram, prev exposure | exposure SSBO 4 x f32 (read by *next* frame's Frame UBO) | -/S | 0.02 | all |
| 6.03 | `taa_resolve` | compute | HDR, TAA history `rgba16float`, MRT1 motion, depth, prev depth | TAA output = new history `rgba16float` | -/S | 0.45 | T1-T3 |
| 6.04 | `motion_blur` | compute | TAA output, MRT1, tile-max `rg16float` 1/16 res | blurred `rgba16float` | -/S | 0.22 | T3 |
| 6.05 | `bloom_downsample` | compute | TAA output | 6 mips `rg11b10ufloat`, 13-tap Karis-average filter on mip 0 | -/S | 0.16 | all |
| 6.06 | `bloom_upsample` | compute | bloom mips | bloom mip 0 (tent filter, radius 1.0 texel per level) | -/S | 0.14 | all |
| 6.07 | `lens_water` | compute | droplet SSBO (256 droplets), HDR-copy | droplet normal+mask `rgba8unorm` quarter-res | -/S | 0.05 | T1-T3 |
| 6.08 | `composite` | compute or render | TAA/motion output, bloom, droplet mask, grade LUT `rgba8unorm` 32x32x32, blue noise | swapchain `bgra8unorm` | -/S | 0.20 | all |
| 6.09 | `sharpen_cas` | compute | (fused into 6.08) | - | - | 0.00 | T2-T3 |
| 6.10 | `ui_hud` | render | UI vertex buffer, glyph atlas `r8unorm` 1024x1024, icon atlas `rgba8unorm` 1024x1024 | swapchain (blend `src-alpha`) | L/S | 0.15 | all |

Phase 6 subtotal: **1.21 ms** (T2; motion blur excluded -- it is T3-only and is paid for
there by the higher render budget of a stronger GPU).

`composite` performs, in this order, in one shader:
1. Sample TAA output (or motion-blur output at T3).
2. Add bloom mip 0 scaled by `postParams.x` (default 0.045).
3. Apply lens water droplet refraction: offset the sample UV by
   `dropletNormal.xy * 0.035 * dropletMask` and add a 1.4x specular sparkle.
4. Chromatic aberration: 3 taps of the composited colour at radial offsets
   `{-1, 0, +1} * postParams.z * r^2` texels, where `r` is the normalised distance from
   centre and `postParams.z` defaults to 1.1 px (rises to 3.0 px underwater below 200 m).
5. Exposure is *already applied* (HDR buffer is pre-exposed) -- no multiply here.
6. Tonemap: AgX (see Section J.4) with a per-tier LUT-free analytic implementation.
7. Colour grading: trilinear sample of the 32x32x32 `rgba8unorm` grade LUT selected by
   biome/depth blend (two LUTs cross-faded by `lutContribution`).
8. Vignette: `1 - postParams.w * pow(r, 2.4)`, default `postParams.w = 0.28`, rising to
   0.55 below 400 m depth.
9. Film grain: `grain = (blueNoise(uv, frameIndex) - 0.5) * postParams2.x * (1 - luma)`,
   default intensity 0.018, doubled at night and below 300 m.
10. CAS sharpen (T2/T3), sharpness `postParams2.w` = 0.30.
11. 8-bit ordered-dither via the blue-noise texture (+/- 0.5/255), then sRGB OETF.

### B.8 Full-frame budget summary

| Phase | ms (T2, 1080p) |
|---|---|
| 1 Simulation & preparation | 2.07 |
| 2 Shadows | 0.95 |
| 3 Prepass / HiZ / AO | 1.45 |
| 4 Volumetrics | 1.17 |
| 5 Main forward | 6.29 |
| 6 Post + UI | 1.21 |
| Sum of passes | 13.14 |
| Pass-transition / barrier overhead (measured, ~2%) | 0.28 |
| **GPU total** | **13.42** |
| Driver/submit/present overhead reserve | 1.20 |
| **Effective total** | **14.62** (budget 16.60, headroom 1.98) |

CPU budget (separate thread of the same frame, must also fit 16.6 ms):
| CPU task | ms |
|---|---|
| Game sim + physics + audio dispatch | 3.5 |
| Visibility / LOD / streaming decisions | 1.6 |
| Draw-list build + bind-group churn + encoder recording | 3.2 |
| Uniform staging writes (`writeBuffer` into ring) | 0.6 |
| **CPU total** | **8.9** |

Terrain meshing, noise texture generation, and mesh generation for creatures run in
2 Web Workers (no OffscreenCanvas WebGPU device in workers for v1 -- workers produce typed
arrays which the main thread uploads). Worker->main transfer uses transferable
`ArrayBuffer`s; upload is capped at 6 MB per frame.

---

## C. SHADING MODEL

### C.1 BRDF

Specular: Cook-Torrance with GGX/Trowbridge-Reitz NDF, Smith height-correlated visibility,
Schlick Fresnel, plus a multiscatter energy-compensation term.
Diffuse: energy-conserving Lambert scaled by `(1 - F)` for the direct term. Burley/Disney
diffuse is a `#define DIFFUSE_BURLEY` option enabled only at T3 (costs ~4 ALU per light).

Roughness input is *perceptual*; `alpha = clamp(roughness, 0.045, 1.0)^2`. The 0.045 floor
prevents specular aliasing fireflies from the sun; combined with geometric specular AA
(Section C.4).

```wgsl
// ---- common/brdf.wgsl ----------------------------------------------------
// #pragma once
// #include "common/math.wgsl"

const F0_DIELECTRIC : f32 = 0.04;

struct SurfaceCtx {
  N          : vec3f,   // shading normal, world, unit
  V          : vec3f,   // view vector (surface -> eye), world, unit
  geoN       : vec3f,   // geometric normal, world, unit
  diffuseCol : vec3f,   // (1 - metallic) * baseColor
  f0         : vec3f,   // mix(vec3(specularF0), baseColor, metallic)
  f90        : f32,     // 1.0, or reduced for grazing-dark materials
  alpha      : f32,     // perceptual roughness squared
  a2         : f32,     // alpha * alpha
  NoV        : f32,     // saturate(dot(N,V)) + 1e-5
  energyComp : vec3f,   // multiscatter compensation, see brdfEnergyCompensation()
  sssStr     : f32,     // 0..1 subsurface strength
  sssWrap    : f32,     // 0..1 diffuse wrap
  sssCol     : vec3f,   // transmission tint
  thickness  : f32,     // metres, for back-scatter transmission
}

// --- Normal distribution: GGX / Trowbridge-Reitz -------------------------
fn D_GGX(NoH: f32, a2: f32) -> f32 {
  // Karis' numerically-stable form; avoids catastrophic cancellation when a2 -> 0.
  let d = (NoH * a2 - NoH) * NoH + 1.0;
  return a2 / max(PI * d * d, 1e-9);
}

// --- Visibility: Smith height-correlated, already divided by 4*NoL*NoV ----
fn V_SmithGGXCorrelated(NoV: f32, NoL: f32, a2: f32) -> f32 {
  let lambdaV = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  let lambdaL = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(lambdaV + lambdaL, 1e-7);
}

// --- Fresnel -------------------------------------------------------------
fn F_Schlick(f0: vec3f, f90: f32, u: f32) -> vec3f {
  let f = pow(saturate(1.0 - u), 5.0);
  return f0 + (vec3f(f90) - f0) * f;
}
fn F_SchlickScalar(f0: f32, f90: f32, u: f32) -> f32 {
  return f0 + (f90 - f0) * pow(saturate(1.0 - u), 5.0);
}

// --- Diffuse -------------------------------------------------------------
fn Fd_Lambert() -> f32 { return INV_PI; }

fn Fd_Burley(NoV: f32, NoL: f32, LoH: f32, rough: f32) -> f32 {
  let f90 = 0.5 + 2.0 * rough * LoH * LoH;
  let lightScatter = F_SchlickScalar(1.0, f90, NoL);
  let viewScatter  = F_SchlickScalar(1.0, f90, NoV);
  return lightScatter * viewScatter * INV_PI;
}

// --- Analytic split-sum environment BRDF (no LUT texture) ----------------
// Karis' mobile fit, error < 1.2% for roughness in [0.02, 1.0].
// Returns (scale, bias): specularEnv = f0 * x + f90 * y
fn envBRDFApprox(rough: f32, NoV: f32) -> vec2f {
  let c0 = vec4f(-1.0, -0.0275, -0.572,  0.022);
  let c1 = vec4f( 1.0,  0.0425,  1.040, -0.040);
  let r  = vec4f(rough) * c0 + c1;
  let a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  return vec2f(-1.04, 1.04) * a004 + r.zw;
}

// --- Multiscatter energy compensation (Fdez-Aguera style) ----------------
// Ess = directional albedo of the single-scatter GGX lobe for f0 = 1.
// Applied as a multiplier on BOTH the direct and the IBL specular lobes.
fn brdfEnergyCompensation(f0: vec3f, rough: f32, NoV: f32) -> vec3f {
  let ab  = envBRDFApprox(rough, NoV);
  let Ess = max(ab.x + ab.y, 1e-3);
  return vec3f(1.0) + f0 * (1.0 / Ess - 1.0);
}

// --- Direct punctual evaluation ------------------------------------------
// Returns radiance contribution; caller multiplies by lightColour * attenuation
// * shadow. NoL is folded in here.
fn evalBRDF(s: SurfaceCtx, L: vec3f) -> vec3f {
  let H   = normalize(s.V + L);
  let NoL = saturate(dot(s.N, L));
  let NoH = saturate(dot(s.N, H));
  let LoH = saturate(dot(L, H));

  // Specular
  let D  = D_GGX(NoH, s.a2);
  let Vv = V_SmithGGXCorrelated(s.NoV, NoL, s.a2);
  let F  = F_Schlick(s.f0, s.f90, LoH);
  let Fr = (D * Vv) * F * s.energyComp;

  // Diffuse, energy-conserving: the fraction not reflected specularly.
  let kD = (vec3f(1.0) - F);
#if DIFFUSE_BURLEY
  let Fd = s.diffuseCol * Fd_Burley(s.NoV, NoL, LoH, sqrt(s.alpha)) * kD;
#else
  let Fd = s.diffuseCol * Fd_Lambert() * kD;
#endif

  // Wrapped diffuse for subsurface materials (kelp, jelly, fish flesh).
  // Energy normalised so that integral over the hemisphere is preserved.
  let w      = s.sssWrap;
  let NoLw   = saturate((dot(s.N, L) + w) / ((1.0 + w) * (1.0 + w)));
  let diffuseTerm = mix(NoL, NoLw, s.sssStr);

  // Back-scatter transmission (light exiting the far side toward the eye).
  // Cheap Jimenez/Frostbite approximation, no shadow map lookup required.
  let tDist  = max(s.thickness, 0.001);
  let backL  = -L - s.N * 0.25;
  let backNL = pow(saturate(dot(s.V, normalize(backL))), 8.0);
  let trans  = s.sssCol * s.sssStr * backNL * exp(-tDist * 2.6);

  return Fr * NoL + Fd * diffuseTerm + trans;
}
```

`s.f90` is 1.0 for all materials except heavily-porous wet organics, where it is
`saturate(dot(f0, vec3(50.0/3.0)))` (Frostbite's reflectance-based f90 for low-f0
materials) so that wet kelp does not glow white at grazing angles.

### C.2 Light types

| Type | Count | Source | Representation |
|---|---|---|---|
| Directional sun | 1 | `frame.sunDirW`, `frame.sunIlluminance` | Disc of angular radius `frame.sunDirW.w` (default 0.00465 rad = 0.266 deg). Specular uses the "representative point" sphere-light correction with `sphereAngularRadius`. |
| Directional moon | 1 | `frame.moonDirW`, `frame.moonIlluminance` | Same, angular radius 0.00452 rad. Illuminance scaled by phase: `0.25 lux * pow(phase, 1.4)` at full. Never casts shadows in v1; instead its contribution is multiplied by the ambient sky visibility term. |
| Punctual point | up to 1024 total (point + spot share the pool) | `s_lights` storage buffer | Sphere light of radius `sourceRadius` (default 0.05 m), inverse-square with a smooth windowing function. |
| Punctual spot | (same pool) | `s_lights` with `type = 1` | Cone with `cosInner`/`cosOuter`, smoothstep falloff. |
| Shadowed punctual | up to 6 (T3) / 4 (T2) / 2 (T1) / 0 (T0) | `extra.y = shadowIndex` | Each occupies one 1024x1024 layer of a separate `depth32float` 1024x1024x6 array. Spots use a single perspective map; points use a 90-deg 6-face virtual cube packed into 6 consecutive layers, so a shadowed *point* light consumes the entire budget at T2. Design rule: only the vessel headlights (spots) and the player torch (spot) are ever shadowed. |
| Emissive surfaces | unbounded | Material `emissiveFactor` | Not lights. They contribute to bloom and to the froxel volume only via a coarse "emissive probe" injection: any mesh with `emissiveFactor.a > 40` and bounding radius > 0.35 m registers a virtual point light in `s_lights` with intensity derived from `emissive * surfaceArea / (4*PI)`. Managed by the entity system; the renderer just consumes `s_lights`. |

Punctual attenuation (exact, binding):

```wgsl
// r  = distance to light centre
// R  = influence radius (posRadius.w)
// rs = source radius (default 0.05 m, packed in extra.w upper bits -- see note)
fn punctualAttenuation(r: f32, R: f32, rs: f32) -> f32 {
  let d2  = max(r * r, rs * rs);           // sphere-light near-field clamp
  let inv = 1.0 / d2;
  let t   = saturate(1.0 - pow(r / R, 4.0));
  return inv * t * t;                       // windowed inverse-square
}
```

Intensity units: `colourInt.w` is luminous intensity in candela. Radiance contribution is
`colour * intensity * punctualAttenuation(...)`, then multiplied by `frame.exposure` at the
end of the forward shader (the whole HDR buffer is pre-exposed). Vessel headlight default:
28000 cd, 22 deg inner / 30 deg outer cone, 5700 K (RGB `(1.000, 0.968, 0.955)`), influence
radius 120 m in air, 55 m underwater (the shorter radius is set by gameplay code because
water extinction makes further contribution invisible).

### C.3 Clustered forward+ light culling

**Cluster grid.** Tiles are 80 x 80 screen pixels of the *render target* (post render-scale).
Z is sliced exponentially into 24 slices.

```
tilesX  = ceil(renderWidth  / 80)     // 24 at 1920
tilesY  = ceil(renderHeight / 80)     // 14 at 1080
slices  = 24
clusterCount = tilesX * tilesY * slices     // 8064 at 1080p
```

Maximum supported: `tilesX <= 32`, `tilesY <= 20` => `clusterCount <= 15360`. Buffers are
allocated for the maximum and re-sliced on resize.

Exponential Z slicing (Doom 2016 scheme), with `zn = 0.25 m`, `zf = 640 m` (air) or
`zf = 140 m` (underwater; recomputed whenever the camera crosses the surface):

```
sliceScale = slices / log(zf / zn)
sliceBias  = -slices * log(zn) / log(zf / zn)
slice(viewZ) = clamp(u32(floor(log(viewZ) * sliceScale + sliceBias)), 0, slices - 1)
```

`sliceScale`/`sliceBias` live in `frame.clusterParams.zw`.

**Buffers.**

| Buffer | Layout | Size @ max | Usage |
|---|---|---|---|
| `s_lights` | `array<PunctualLight>` (64 B each), 1024 entries | 64 KiB | STORAGE read in all shaders; written by `writeBuffer` each frame (only the used prefix). |
| `s_clusterAABB` | `array<vec4f>` pairs (min.xyz + pad, max.xyz + pad), 2 per cluster | 15360 x 32 B = 480 KiB | Rebuilt only on resize or projection change. View space. |
| `s_activeLights` | `array<u32>` + leading `u32` count | 4 KiB | Output of 1.13. |
| `s_clusterRanges` | `array<vec2u>` (offset, count) per cluster | 15360 x 8 B = 120 KiB | Output of 1.14. |
| `s_lightIndices` | `array<u32>`, `clusterCount * maxLightsPerCluster` | 15360 x 64 x 4 B = 3.75 MiB | Output of 1.14. Allocated with a global atomic bump counter; overflow clamps (drops the farthest lights). |

```wgsl
struct PunctualLight {           // 64 bytes, align 16
  posRadius  : vec4f,  //  0: xyz = world position (camera-relative), w = influence radius (m)
  colourInt  : vec4f,  // 16: rgb = linear colour (unit-luminance), w = intensity (candela)
  dirCosInner: vec4f,  // 32: xyz = spot direction (unit, pointing away from light), w = cos(innerAngle)
  extra      : vec4f,  // 48: x = cos(outerAngle)
                       //     y = shadowIndex as f32 (-1.0 = unshadowed)
                       //     z = type (0.0 = point, 1.0 = spot, 2.0 = tube/capsule)
                       //     w = packed: floor(w) = volumetricScale*100, frac(w) = sourceRadius (m, 0..0.99)
}
```

**Cull dispatch.**

```
// 1.13 light_prepass_cull
@compute @workgroup_size(64)   dispatch( ceil(lightCount / 64), 1, 1 )
//   Frustum-vs-sphere test against the 6 camera planes + a distance cut at
//   `min(R + zf, 1.2 * zf)`. Appends surviving indices with atomicAdd.

// 1.14 light_cluster_cull
@compute @workgroup_size(4, 4, 4)          // 64 invocations, one cluster each
dispatch( ceil(tilesX/4), ceil(tilesY/4), ceil(slices/4) )   // = (6, 4, 6) at 1080p
```

Per-invocation algorithm:
1. Compute the cluster's view-space AABB (read from `s_clusterAABB`).
2. Cooperatively load 64 active light indices into workgroup shared memory at a time.
3. For each: sphere-vs-AABB test (`distSq(clamp(lightVS, aabbMin, aabbMax), lightVS) < R^2`).
   For spots, additionally reject with the cone-vs-sphere test using the AABB's bounding
   sphere (cheap, conservative).
4. Append passing indices to the per-cluster slot in `s_lightIndices` at
   `clusterIndex * maxLightsPerCluster + n`, capped at `maxLightsPerCluster`.
5. Write `s_clusterRanges[clusterIndex] = vec2u(base, n)`.

Fragment-shader lookup:

```wgsl
fn clusterIndexFromFragment(fragCoord: vec2f, viewZ: f32) -> u32 {
  let tx = u32(fragCoord.x / 80.0);
  let ty = u32(fragCoord.y / 80.0);
  let sz = u32(clamp(floor(log(viewZ) * frame.clusterParams.z + frame.clusterParams.w),
                     0.0, frame.clusterParams.y - 1.0));   // note: .y holds sliceCount-1 fallback
  return (sz * u32(frame.clusterParams.y) + ty) * u32(frame.clusterParams.x) + tx;
}
```
(`clusterParams = vec4f(tilesX, tilesY, sliceScale, sliceBias)`; the slice count is the
compile-time constant `CLUSTER_SLICES = 24`.)

**Cost guarantees.** Worst-case per-fragment light loop = 64 iterations. The forward shaders
place the loop behind an early `if (count == 0u)` and use `let` hoisting so the compiler can
keep the surface context in registers. Measured target: 1024 lights, 40% of screen covered
by >= 8 lights => `forward_terrain` stays within 1.85 ms.

### C.4 Specular anti-aliasing and normal handling

- Normals are stored octahedrally-encoded; decoded with the standard oct-decode and
  renormalised.
- Geometric specular AA (Kaplanyan/Tokuyoshi), applied to `alpha` before use:

```wgsl
fn filterRoughness(alpha: f32, N: vec3f) -> f32 {
  let dNdx = dpdx(N);
  let dNdy = dpdy(N);
  let variance = 0.25 * (dot(dNdx, dNdx) + dot(dNdy, dNdy));   // SIGMA^2 = 0.25
  let kernelRoughness = min(2.0 * variance, 0.18);             // THRESHOLD = 0.18
  return saturate(alpha + kernelRoughness);
}
```

- Normal maps are mip-mapped with a *variance-preserving* (Toksvig-like) reduction: the mip
  generator writes the length of the averaged normal into the roughness channel of the
  MRAH array, and the shader does `alpha = max(alpha, toksvigAlpha)`.

---

## D. SHADOWS

### D.1 Cascaded shadow maps (sun)

| Parameter | T0 | T1 | T2 | T3 |
|---|---|---|---|---|
| Cascade count | 2 | 3 | 4 | 4 |
| Resolution per cascade | 1024 | 1536 | 2048 | 2048 |
| Texture | `depth32float`, `2d-array`, `size` x `size` x `count` | | | |
| Total shadow VRAM | 8.4 MB | 28.3 MB | 67.1 MB | 67.1 MB |
| Shadow distance | 160 m | 260 m | 400 m | 520 m |

Split distances (T2, view-space metres from the camera). Computed with the practical split
scheme, `lambda = 0.86`, `near = 0.5`, `far = shadowDistance`:

```
split_i = lambda * near * pow(far/near, i/N) + (1-lambda) * (near + (far-near) * i/N)
```

| Cascade | T2 near (m) | T2 far (m) | Texel world size (m) | Purpose |
|---|---|---|---|---|
| 0 | 0.08 | 11.5 | 0.0126 | Player hands, cockpit interior, near foliage |
| 1 | 10.8 | 41.0 | 0.0447 | Vessel, nearby rocks, creatures |
| 2 | 38.5 | 137.0 | 0.150 | Mid terrain, kelp forests |
| 3 | 128.5 | 400.0 | 0.437 | Distant cliffs, island silhouette |

Adjacent cascades overlap by 6% (the `near` of cascade i+1 is 0.94 x the `far` of cascade i)
to give room for the cross-fade band.

**Cascade fitting and stabilisation (binding):**
1. Fit a *sphere* to the cascade's view frustum slice (not an AABB). The sphere's radius is
   constant for a given split regardless of camera orientation, which removes shimmer under
   rotation.
2. Build a light-space orthographic projection with `width = height = 2 * radius`.
3. Snap the light-space origin to the shadow texel grid:
   `texelSize = 2 * radius / shadowMapSize; origin = floor(origin / texelSize) * texelSize`.
4. Extend the ortho near plane 300 m backwards along the light direction to capture
   off-screen casters (or use `unclippedDepth` if `depth-clip-control` is available and
   extend only 40 m).
5. Recompute only when the fitted sphere centre moves > 0.5 texel or the sun direction
   changes by > 0.02 deg.

**Bias (binding numbers):**

| Bias | Value | Applied where |
|---|---|---|
| `depthBias` (pipeline) | 3 units | Shadow pipeline constant. With `depth32float` and reversed-Z the unit is `2^-23` of the ortho depth range. |
| `depthBiasSlopeScale` | 2.2 | Shadow pipeline. |
| `depthBiasClamp` | 0.004 | Shadow pipeline. |
| Normal offset | `worldPos += geoN * texelWorldSize * 1.7 * sqrt(1 - NoL^2) ` | Applied in the *receiver* when computing the shadow lookup position, per cascade, using that cascade's `texelWorldSize`. |
| Constant receiver bias | `0.0012 / cascadeFar` in NDC depth | Added after projection. |
| Cascade blend band | 8% of the cascade's range, dithered by blue noise (1-tap, not 2-tap sampling) | Fragment shader. |

**Filtering:**

| Tier | Kernel |
|---|---|
| T0 | Hardware 2x2 PCF (single `textureSampleCompare`). |
| T1 | 9 taps, 3x3 unit-spaced, uniform weights, `textureSampleCompare`. |
| T2 | 16-tap Poisson disc, radius 2.5 texels for cascade 0/1 and 1.5 texels for 2/3, rotated per-pixel by a blue-noise angle (`vogel`-style spiral is used for the T3 PCSS filter instead). |
| T3 | PCSS: 16-tap blocker search over a radius of `lightAngularRadius * cascadeFar / texelWorldSize` clamped to [2, 24] texels; penumbra radius `= (receiverZ - avgBlockerZ)/avgBlockerZ * lightSize` clamped to [1.0, 16.0] texels; 32-tap Vogel-disc PCF at that radius. Sun `lightSize` = 0.0093 rad diameter. |

**Underwater shadow behaviour (binding).** Below the surface, direct sunlight becomes
progressively diffuse due to multiple scattering; hard shadows must vanish. Two multipliers,
both applied to the sun's shadow term (never to the ambient term):

```wgsl
// d = depth below surface in metres (0 at surface, positive downward)
fn underwaterShadowStrength(d: f32) -> f32 {
  // 1) Multiple-scattering diffusion: shadows soften and fade.
  let diffuse = exp(-max(d, 0.0) / 18.0);        // 3.5% remaining at 60 m
  // 2) Hard cut-off at the depth where direct sun is < 0.5% of surface value.
  let cutoff  = 1.0 - smoothstep(70.0, 110.0, max(d, 0.0));
  return diffuse * cutoff;
}
// shadow = mix(1.0, rawShadow, underwaterShadowStrength(depthBelowSurface))
```

Additionally, when the camera is below the surface, cascade 0 and 1 are re-fitted to a
shorter shadow distance (`min(shadowDistance, 90 m)`) because nothing beyond that is visible
through the water anyway; this reclaims about 0.15 ms and quadruples near-field shadow
resolution underwater. Cascade 3 is skipped entirely when
`cameraDepthBelowSurface > 25 m`.

**Contact shadows.** A 12-step screen-space ray march along `L` in the depth buffer,
maximum world length 0.4 m, thickness threshold 0.06 m, applied only to `matClass == 1 or 2`
(organic and hard-surface), and only at T2/T3. Cost is included in the forward passes.
Fades out over depth `> 45 m` and disappears with `underwaterShadowStrength`.

**Shadow casters.** A mesh casts a sun shadow if `flags & MAT_CAST_SHADOW`. Terrain always
casts. Particles never cast. Ocean surface never casts a shadow map (its shadowing of the
water volume is handled by the caustics + froxel path). Transparent creatures
(jellyfish) cast only into cascade 0/1 with a 0.35 alpha-test threshold, producing a soft
partial shadow -- cheap and reads correctly.

---

## E. GLOBAL ILLUMINATION / AMBIENT

**Decision: no probe grid, no ray tracing, no irradiance volumes.** Ambient is a
three-part analytic system chosen for maximum quality per millisecond. Total cost:
**0.10 ms of compute per frame + ~1.6 MB VRAM**.

### E.1 Part 1 -- SH-L2 distant ambient (sky above, water column below)

A 9-coefficient RGB spherical harmonic band-limited environment, recomputed every frame in
pass 1.18 by projecting the 192x108 sky-view LUT onto SH.

- Above water: pure sky radiance projection, plus a ground-bounce lobe. The ground bounce is
  a single directional term added into the SH: `L_ground = skyIrradiance * groundAlbedo *
  0.42`, with `groundAlbedo` supplied by the biome system (sand 0.28, basalt 0.06,
  vegetation 0.11).
- Below water: the SH is replaced by an *analytic water-column SH*, computed on the CPU (it
  is 9 coefficients -- trivial) as follows. The dominant radiance comes downward through
  Snell's window; the rest is isotropic multiple scattering.

```
// L_down  = sunIlluminance * sunTransmittanceAtDepth(d) * 0.92   (through Snell window)
// L_iso   = waterDeepTint * skyIrradiance * exp(-sigmaT * d * 1.35) * 0.30
// SH = SH_cosineLobe(dir = -Y, radiance = L_down) + SH_constant(L_iso)
```

SH evaluation in shaders uses the standard Ramamoorthi/Hanrahan irradiance convolution
constants; the CPU pre-multiplies the convolution weights into the coefficients so the
shader is 9 MADs:

```wgsl
// ambientSH is stored PRE-CONVOLVED (cosine-lobe weights already folded in),
// so this returns irradiance/PI directly = diffuse radiance for albedo 1.
fn evalAmbientSH(n: vec3f) -> vec3f {
  let c = frame.ambientSH;               // array<vec4f, 9>, rgb in xyz
  var r = c[0].xyz;
  r += c[1].xyz * n.y;
  r += c[2].xyz * n.z;
  r += c[3].xyz * n.x;
  r += c[4].xyz * (n.x * n.y);
  r += c[5].xyz * (n.y * n.z);
  r += c[6].xyz * (3.0 * n.z * n.z - 1.0);
  r += c[7].xyz * (n.x * n.z);
  r += c[8].xyz * (n.x * n.x - n.y * n.y);
  return max(r, vec3f(0.0));
}
```

### E.2 Part 2 -- Sky-visibility volume (large-scale occlusion)

A single 3D texture giving "how much of the sky can this point see, and from which
direction" -- this is what makes caves, canyons, overhangs and kelp forests read as dark
without any probe network.

| Property | Value |
|---|---|
| Format | `rgba8unorm` |
| Dimensions | 64 x 32 x 64 texels |
| World extent | 1024 m (X) x 512 m (Y) x 1024 m (Z), i.e. 16 m x 16 m x 16 m per texel |
| Anchoring | Snapped to a 16 m grid, re-centred on the camera; scrolled toroidally (wrap-around addressing), only newly-exposed slabs are recomputed |
| Contents | `rgb` = bent normal (the average unoccluded direction), remapped `[-1,1] -> [0,1]`; `a` = sky visibility fraction |
| Generation | Compute pass 1.23: 32 cone-traced rays per texel against the coarse terrain SDF (`r16float` 128^3 covering the same volume). 8 z-slices per frame => full refresh in 8 frames (133 ms). |
| Sampling | Trilinear, with a half-texel inset; sampled once per fragment |
| VRAM | 64*32*64*4 = 512 KiB (+ 4 MiB for the coarse SDF) |
| Cost | 0.04 ms/frame amortized |

Ambient application:

```wgsl
let sv       = textureSampleLevel(t_skyVisibility, samp_linearClamp, volumeUV, 0.0);
let bentN    = normalize(sv.xyz * 2.0 - 1.0);
let skyVis   = sv.a;
// Combine large-scale visibility with fine-scale GTAO.
let ao       = min(skyVis, gtao);
// Use the bent normal for the diffuse ambient lookup - this is what gives
// directional occlusion inside caves and under overhangs.
let ambientN = normalize(mix(N, bentN, 0.65 * (1.0 - ao)));
let diffuseAmbient = evalAmbientSH(ambientN) * s.diffuseCol * ao * aoMultiBounce(ao, albedo);
```

`aoMultiBounce` is Jimenez's albedo-tinted multi-bounce fit:

```wgsl
fn aoMultiBounce(ao: f32, albedo: vec3f) -> vec3f {
  let a =  2.0404 * albedo - vec3f(0.3324);
  let b = -4.7951 * albedo + vec3f(0.6417);
  let c =  2.7552 * albedo + vec3f(0.6903);
  return saturate(max(vec3f(ao), ((ao * a + b) * ao + c) * ao));
}
```

### E.3 Part 3 -- Specular ambient (prefiltered environment cube)

| Property | Value |
|---|---|
| Format | `rgba16float`, cube, 64x64 per face |
| Mips | 6 (64, 32, 16, 8, 4, 2), roughness 0.0, 0.2, 0.4, 0.6, 0.8, 1.0 |
| Content | Above water: prefiltered sky + a horizon-clipped ocean-plane reflection. Below water: prefiltered water-column radiance (Snell's window disc + isotropic body) -- this is what jelly, fish scales and the vessel hull reflect at depth. |
| Update | Pass 1.20, one face + its mip chain per frame (6-frame cycle, 100 ms). Forced full refresh on surface crossing and on `sun elevation` changes > 1.5 deg. |
| Prefilter | 24 GGX importance samples per texel at mip>=1, cosine-lobe for mip 5. Base mip is a direct LUT copy. |
| VRAM | 64*64*6*8 B * 1.333 = 262 KiB |
| Cost | 0.05 ms/frame |

Specular ambient application (split-sum, analytic DFG -- no BRDF LUT texture):

```wgsl
let R      = reflect(-s.V, s.N);
let mip    = sqrt(s.alpha) * 5.0;                       // perceptual roughness -> mip
let pre    = textureSampleLevel(t_envSpecular, samp_linearClamp, R, mip).rgb;
let ab     = envBRDFApprox(sqrt(s.alpha), s.NoV);
let specAmbient = pre * (s.f0 * ab.x + vec3f(ab.y)) * s.energyComp * specOcclusion;
```

Specular occlusion (Lagarde's horizon-based term, prevents ambient specular leaking through
walls):

```wgsl
fn specularOcclusion(NoV: f32, ao: f32, alpha: f32) -> f32 {
  return saturate(pow(NoV + ao, exp2(-16.0 * alpha - 1.0)) - 1.0 + ao);
}
```

SSR (Section B.6 pass 5.09) replaces the environment cube where its confidence `a > 0`,
blended: `spec = mix(specAmbient, ssr.rgb, ssr.a)`. SSR confidence goes to 0 at screen
edges (8% border fade), on ray-march failure, and when the hit is behind the tested surface
by more than `0.6 m + 0.02 * viewZ`.

### E.4 Bioluminescence and "there is no ambient" depths

Below `d = 220 m` the sky SH is essentially zero. To avoid a completely flat black, the
ambient system adds an **abyssal floor term**: a constant `vec3(0.0016, 0.0031, 0.0044)`
nits (roughly the measured deep-ocean background from bioluminescent plankton), multiplied
by the biome's `bioluminescentDensity` factor. This must remain below the point where it
lifts blacks visibly after tonemapping -- it exists so that surfaces at the edge of the
torch cone fade to a faint blue rather than a hard cutoff.

---

## F. MATERIALS

### F.1 The Material struct (binding)

Stored in one storage buffer per *material set* (see F.3): `array<Material>` with 1024 slots.

```wgsl
// ---- common/material.wgsl -----------------------------------------------
struct Material {                    // offset  size  notes
  baseColorFactor    : vec4f,        //    0     16   rgb linear, a = base alpha
  emissiveFactor     : vec4f,        //   16     16   rgb linear (unit), a = nits scale 0..4000
  subsurfaceColour   : vec4f,        //   32     16   rgb transmission tint, a = default thickness (m)
  detailParams       : vec4f,        //   48     16   x=detailAlbedoStrength y=detailNormalStrength
                                     //                z=detailScaleNear (1/m) w=detailScaleFar (1/m)
  uvTransform        : vec4f,        //   64     16   xy = uv scale, zw = uv offset
  metallic           : f32,          //   80      4   0 or 1 in practice; 0..1 allowed for corrosion blends
  roughness          : f32,          //   84      4   perceptual
  normalScale        : f32,          //   88      4
  occlusionStrength  : f32,          //   92      4
  specularF0         : f32,          //   96      4   dielectric reflectance, default 0.04 (range 0.02..0.08)
  clearcoat          : f32,          //  100      4   0..1, used for wet surfaces and vessel canopy
  clearcoatRoughness : f32,          //  104      4
  anisotropy         : f32,          //  108      4   -1..1, used for brushed hull metal and fish scales
  sssStrength        : f32,          //  112      4
  sssWrap            : f32,          //  116      4   0..1
  porosity           : f32,          //  120      4   how much wetness affects this material
  heightScale        : f32,          //  124      4   POM amplitude in metres (T3 only)
  triplanarSharpness : f32,          //  128      4   exponent k, default 4.0
  alphaCutoff        : f32,          //  132      4
  emissivePulseHz    : f32,          //  136      4   0 = steady
  emissivePulsePhase : f32,          //  140      4   radians
  texAlbedo          : u32,          //  144      4   layer index, 0xFFFFFFFF = none (use factor)
  texNormal          : u32,          //  148      4
  texMRAH            : u32,          //  152      4   metallic/roughness/AO/height
  flags              : u32,          //  156      4   see table
}                                    // TOTAL: 160 bytes, align 16
```

`sizeof(Material) = 160`. Buffer = 1024 * 160 = **160 KiB per material set**.

Flags bitfield:

| Bit | Name | Meaning |
|---|---|---|
| 0 | `MAT_ALPHA_TEST` | Use `alphaCutoff`; participates in prepass with depth write. |
| 1 | `MAT_ALPHA_BLEND` | Rendered in pass 5.12, no depth write, sorted. |
| 2 | `MAT_ADDITIVE` | Blend `one`/`one` (bioluminescent membranes, plankton). |
| 3 | `MAT_DOUBLE_SIDED` | `cullMode: 'none'`; normal flipped by `frontFacing`. |
| 4 | `MAT_CAST_SHADOW` | Included in shadow passes. |
| 5 | `MAT_TRIPLANAR` | World-space triplanar instead of UVs. |
| 6 | `MAT_DETAIL` | Sample detail albedo/normal. |
| 7 | `MAT_WETNESS` | Responds to the wetness system. |
| 8 | `MAT_SSS` | Enable the wrapped-diffuse + transmission path. |
| 9 | `MAT_ANISO` | Enable the anisotropic GGX path (costs ~14 ALU). |
| 10 | `MAT_CLEARCOAT` | Enable the second specular lobe. |
| 11 | `MAT_POM` | Parallax occlusion mapping (T3 only). |
| 12 | `MAT_EMISSIVE_PULSE` | Animate emissive by `sin(time * 2pi * Hz + phase)`. |
| 13 | `MAT_VERTEX_COLOR` | Multiply base colour by the instance/vertex colour. |
| 14 | `MAT_WIND_SWAY` | Vertex shader applies the wind/current sway function. |
| 15 | `MAT_NO_FOG` | Skip the water/air medium application (cockpit interior, HUD). |
| 16-31 | reserved | Must be zero. |

Material permutations are handled by *dynamic branching on flags*, not by pipeline
permutation, with three exceptions that DO get separate pipelines because they change the
blend state or the fragment output: `MAT_ALPHA_TEST`, `MAT_ALPHA_BLEND`, `MAT_ADDITIVE`.
Plus a compile-time `#define` split for `MAT_TRIPLANAR` (terrain vs. everything else),
because triplanar triples the texture taps and must not cost anything for non-terrain.
Total forward-opaque pipeline count: 3 material sets x 2 (triplanar) x 2 (alpha-test) x
2 (double-sided) = 24, plus shadow and prepass variants (16), plus transparent (6) = **46
render pipelines** for the material system. Well within reasonable compile time
(~350 ms total, all async, warmed on the loading screen).

### F.2 Vertex format

Vertex-pulled from storage buffers, not vertex-buffer bound. One packed struct, 32 bytes:

```wgsl
struct PackedVertex {              // 32 bytes
  px : f32, py : f32, pz : f32,    //  0..11  position, camera-relative metres
  n  : u32,                        // 12      octahedral normal, 16:16 snorm
  t  : u32,                        // 16      octahedral tangent 16:16 snorm (sign in bit 0 of u)
  uv : u32,                        // 20      2 x f16 UV
  col: u32,                        // 24      rgba8unorm vertex colour / AO / wind weight
  mat: u32,                        // 28      lo16 = material index, hi8 = layer0, hi8 = layer1 (terrain)
}
```

Terrain uses `col.a` for baked ambient occlusion and `mat` for the two-layer blend.
Skinned meshes use a *parallel* buffer of `array<vec2u>` (4 x u8 bone index + 4 x u8 weight)
consumed only by the skinning compute pass, which writes into the skinned `PackedVertex`
pool -- the forward pass never sees bones.

### F.3 Texture strategy: procedural arrays

There are no image files. All textures are generated on the GPU at load time (and on biome
transitions) by compute shaders in `gen/` (value/simplex/worley/domain-warp/flow noise,
Voronoi cellular, reaction-diffusion for coral, curl-noise for sediment streaks).

**Material sets.** Three sets, each with its own texture arrays and material table. A set is
bound as bind group 2 and changes at most 3 times per frame.

| Set | Contents | Albedo array | Normal array | MRAH array | Layers (T2) |
|---|---|---|---|---|---|
| 0 `terrain` | Sand, silt, gravel, basalt, granite, chalk, ice, clay, coral rock, ore veins | 512x512 `rgba8unorm-srgb` | 512x512 `rg8unorm` | 256x256 `rgba8unorm` | 16 |
| 1 `organic` | Kelp, seagrass, coral, sponge, fish skin, shell, chitin, jelly membrane, fur/algae | 512x512 `rgba8unorm-srgb` | 512x512 `rg8unorm` | 256x256 `rgba8unorm` | 24 |
| 2 `hardsurface` | Vessel hull panels, glass, rubber, composite, painted metal, wear masks, HUD glyph plates | 512x512 `rgba8unorm-srgb` | 512x512 `rg8unorm` | 256x256 `rgba8unorm` | 12 |

Channel packing:
- Albedo array: `rgb` = base colour (sRGB-encoded, hardware-decoded), `a` = opacity.
- Normal array: `rg` = tangent-space normal XY (`rg8unorm`, remapped `2*x-1`), Z
  reconstructed as `sqrt(saturate(1 - x*x - y*y))`.
- MRAH array: `r` = metallic, `g` = roughness (perceptual), `b` = ambient occlusion,
  `a` = height (for POM and for height-blending).

Mip generation: a dedicated compute shader, box filter for albedo/MRAH, and a
**normal-variance-preserving** filter for the normal array (average the un-normalised
normals, store the pre-normalised XY, and write `1 - length(avg)` scaled into the
MRAH roughness channel of the same mip as an additive roughness term). 10 mips for 512,
9 for 256. Generated once per array creation, ~7 ms total at boot.

Filtering: `samp_aniso` = `{ magFilter:'linear', minFilter:'linear', mipmapFilter:'linear',
addressModeU/V:'repeat', maxAnisotropy: tierAniso }`.

**Shared global textures** (bind group 0 or the material set, not per material):

| Texture | Format | Size | Use |
|---|---|---|---|
| `t_detailAlbedo` | `rgba8unorm-srgb` | 256x256, 9 mips | Universal high-frequency albedo break-up |
| `t_detailNormal` | `rg8unorm` | 512x512, 10 mips | Universal high-frequency normal |
| `t_blueNoise` | `r8unorm` array | 128x128 x 64 | Every stochastic decision in the renderer |
| `t_gradeLUT` | `rgba8unorm` 3d | 32x32x32 x 2 | Colour grading (2 slots cross-faded) |
| `t_caustics` | `rgba8unorm` array | 512x512 x 4 | See B.2 1.22 |

### F.4 Triplanar mapping (terrain, binding)

```wgsl
// N is the GEOMETRIC normal in world space. k = material.triplanarSharpness.
fn triplanarWeights(Ng: vec3f, k: f32) -> vec3f {
  var w = pow(abs(Ng), vec3f(k));
  w = w / max(w.x + w.y + w.z, 1e-5);
  // Cull weak axes so the compiler can skip taps (>= 2 taps saved on ~70% of pixels).
  w = select(vec3f(0.0), w, w > vec3f(0.02));
  return w / max(w.x + w.y + w.z, 1e-5);
}

// World-space UVs, scale in texels per metre (material.uvTransform.xy).
// Z-mirroring on the X and Z planes prevents the classic mirrored-texture seam.
fn triplanarUV(P: vec3f, Ng: vec3f, scale: vec2f) -> array<vec2f, 3> {
  let sx = sign(Ng.x); let sz = sign(Ng.z);
  return array<vec2f,3>(
    vec2f(-P.z * sx, -P.y) * scale,   // X-plane (YZ)
    vec2f( P.x,      P.z ) * scale,   // Y-plane (XZ)
    vec2f( P.x * sz, -P.y) * scale    // Z-plane (XY)
  );
}
```

Normal reprojection uses Whiteout blending (cheap, stable):

```wgsl
fn triplanarNormal(nx: vec3f, ny: vec3f, nz: vec3f, Ng: vec3f, w: vec3f) -> vec3f {
  // nx, ny, nz are tangent-space normals sampled on the three planes.
  let ax = vec3f(nx.xy + Ng.zy, abs(nx.z) * Ng.x);
  let ay = vec3f(ny.xy + Ng.xz, abs(ny.z) * Ng.y);
  let az = vec3f(nz.xy + Ng.xy, abs(nz.z) * Ng.z);
  return normalize(ax.zyx * w.x + ay.xzy * w.y + az.xyz * w.z);
}
```

**Layer blending.** Terrain vertices carry two layer indices and a blend weight
(`mat` hi-16 and `col.b`). Blending is height-aware, not linear:

```wgsl
fn heightBlend(h0: f32, w0: f32, h1: f32, w1: f32, contrast: f32) -> vec2f {
  let d  = max(w0 + h0, w1 + h1) - contrast;      // contrast default 0.22
  let b0 = max(w0 + h0 - d, 0.0);
  let b1 = max(w1 + h1 - d, 0.0);
  return vec2f(b0, b1) / max(b0 + b1, 1e-5);
}
```

Total texture taps for a T2 terrain fragment, worst case: 3 planes x 2 layers x 3 arrays
= 18, plus 2 detail = 20. With weight-culling the average is ~11. This is why
`forward_terrain` is the most expensive pass (1.85 ms).

**Detail texturing.** Two octaves, cross-faded by view distance so that detail never
aliases in the distance:

```
nearScale = material.detailParams.z    // default 4.0 (1/m) -> 25 cm features
farScale  = material.detailParams.w    // default 0.25 (1/m) -> 4 m features
fadeNear  = 1.0 - smoothstep(6.0, 26.0, viewDist)
fadeFar   = smoothstep(10.0, 45.0, viewDist) * (1.0 - smoothstep(180.0, 400.0, viewDist))
albedo   *= mix(1.0, detailN.r * 2.0, detailAlbedoStrength * fadeNear)
normal    = blendNormalRNM(normal, detailNormalNear, detailNormalStrength * fadeNear)
normal    = blendNormalRNM(normal, detailNormalFar,  detailNormalStrength * 0.6 * fadeFar)
```

### F.5 Wetness

Wetness is a scalar `w in [0,1]` computed per fragment, driven by three sources, taking the
max:
1. **Submersion proximity**: `wSub = 1.0 - smoothstep(0.0, 0.35, worldY - waveHeightAt(x,z))`
   -- surfaces within 35 cm above the wave surface are fully wet.
2. **Drying timer**: objects (the player, the vessel) carry a `wetTimer` in their instance
   data, set to 1.0 on submersion and decaying with a 12.0 s half-life in air (28.0 s in
   rain, 4.0 s in direct noon sun): `wDry = exp(-dt * 0.0578)` per second for the 12 s case.
3. **Rain/spray**: `wRain = frame.weather.z * upFacing`, `upFacing = saturate(N.y * 1.4)`.

Application (binding):

```wgsl
fn applyWetness(inout_albedo: ptr<function, vec3f>,
                inout_rough : ptr<function, f32>,
                inout_f0    : ptr<function, vec3f>,
                w: f32, porosity: f32, N: vec3f) {
  let wp = w * porosity;
  // 1) Water fills pores: albedo darkens and saturates (Jensen/Nishita porous model fit).
  *inout_albedo = *inout_albedo * mix(1.0, 0.62, wp)
                * mix(vec3f(1.0), vec3f(0.92, 0.97, 1.04), wp);   // slight blue shift
  // 2) Micro-roughness is filled in.
  *inout_rough  = mix(*inout_rough, 0.055, wp);
  // 3) A thin water layer raises reflectance to water's F0 (n = 1.333).
  *inout_f0     = mix(*inout_f0, vec3f(0.0201), w * 0.85);
}
```

Additionally, `MAT_WETNESS` surfaces gain a **clearcoat lobe** with
`clearcoat = w * 0.9, clearcoatRoughness = mix(0.30, 0.03, w)` -- this is the "sheet of
water" specular that sells the transition when the vessel breaches the surface. Puddle
accumulation is faked by a world-space noise mask (`worley(P.xz * 0.6)`) that biases
`w` upward in concavities (`col.a` baked AO used as the concavity proxy).

### F.6 Subsurface scattering

Two mechanisms, both cheap; no screen-space blur pass.

1. **Wrapped diffuse** (`sssWrap`, see `evalBRDF`). Kelp 0.5, jelly 0.85, fish flesh 0.35,
   coral 0.25, sponge 0.6.
2. **Thin-film back transmission** (`trans` term in `evalBRDF`), driven by `thickness`
   taken from `MRAH.a * subsurfaceColour.a` (or from a per-vertex thickness in `col.g` for
   creature meshes where the artist-free procedural generator computes it as the distance
   to the medial axis).

For **jellyfish and other genuinely translucent volumes**, an additional term is added in
pass 5.12: a depth-based "thickness through the mesh" computed as
`abs(backfaceDepth - frontfaceDepth)` obtained by rendering the back faces of translucent
creatures into an `r16float` half-res buffer just before 5.12 (cost included in the 0.35 ms).
Radiance is then `sssCol * exp(-thickness * absorption) * phaseHG(VoL, 0.55)`, which gives
the correct forward-scattering glow when a jelly passes in front of the torch.

---

## G. UNIFORM / BINDING LAYOUT (BINDING FOR ALL IMPLEMENTERS)

Four bind groups. **No shader may use a binding not listed here.** Adding a binding requires
a change to this document.

### G.1 Bind group 0 -- per-frame (bound once, never rebound during the frame)

| Binding | Type | WGSL declaration | Notes |
|---|---|---|---|
| 0 | uniform | `var<uniform> frame : Frame;` | 1312 B, see G.2 |
| 1 | uniform | `var<uniform> shadowU : ShadowUniform;` | 400 B, see G.3 |
| 2 | storage (read) | `var<storage, read> s_lights : array<PunctualLight>;` | 64 KiB |
| 3 | storage (read) | `var<storage, read> s_clusterRanges : array<vec2u>;` | 120 KiB |
| 4 | storage (read) | `var<storage, read> s_lightIndices : array<u32>;` | 3.75 MiB |
| 5 | texture | `var t_shadowCascades : texture_depth_2d_array;` | `depth32float` |
| 6 | texture | `var t_shadowSpot : texture_depth_2d_array;` | `depth32float` 1024x1024x6 |
| 7 | texture | `var t_froxel : texture_3d<f32>;` | integrated in-scatter+transmittance |
| 8 | texture | `var t_skyView : texture_2d<f32>;` | |
| 9 | texture | `var t_skyTransmittance : texture_2d<f32>;` | |
| 10 | texture | `var t_aerialLUT : texture_3d<f32>;` | |
| 11 | texture | `var t_caustics : texture_2d_array<f32>;` | |
| 12 | texture | `var t_envSpecular : texture_cube<f32>;` | |
| 13 | texture | `var t_blueNoise : texture_2d_array<f32>;` | |
| 14 | texture | `var t_skyVisibility : texture_3d<f32>;` | |
| 15 | comparison sampler | `var samp_shadowCmp : sampler_comparison;` | `compare: 'greater'` (reversed-Z) |
| 16 | sampler | `var samp_linearClamp : sampler;` | |
| 17 | sampler | `var samp_linearRepeat : sampler;` | |
| 18 | sampler | `var samp_pointClamp : sampler;` | |

Sampled-texture count in group 0: **10** (bindings 5-14). Sampler count: 4.

### G.2 The `Frame` uniform (EXACT, 1312 bytes)

```wgsl
// ---- common/frame.wgsl --------------------------------------------------
// #pragma once
// std140-compatible: every mat4x4f and vec4f is 16-byte aligned; no scalars
// or vec3s appear at struct scope (they are packed into vec4 slots) so that
// the JS-side DataView writer is a flat sequence of float writes.

struct Frame {
  // ---- Matrices ---------------------------------------- offset  size ----
  view                : mat4x4f,   //    0    64   world -> view (camera-relative world)
  proj                : mat4x4f,   //   64    64   view  -> clip, reversed-Z infinite, JITTERED
  viewProj            : mat4x4f,   //  128    64   proj * view (jittered)
  invView             : mat4x4f,   //  192    64
  invProj             : mat4x4f,   //  256    64
  invViewProj         : mat4x4f,   //  320    64   clip -> camera-relative world
  prevViewProj        : mat4x4f,   //  384    64   previous frame, UNJITTERED, in CURRENT origin space
  prevInvViewProj     : mat4x4f,   //  448    64
  viewProjUnjittered  : mat4x4f,   //  512    64   for velocity + cluster + culling maths

  // ---- Camera ------------------------------------------------------------
  cameraPosW          : vec4f,     //  576    16   xyz = camera-relative position (~0), w = 1.0
  cameraFwdW          : vec4f,     //  592    16   xyz = forward (unit), w = tan(fovY * 0.5)
  cameraRightW        : vec4f,     //  608    16   xyz = right (unit),   w = aspect (W/H)
  cameraUpW           : vec4f,     //  624    16   xyz = up (unit),      w = fovY (radians)
  prevCameraPosW      : vec4f,     //  640    16   xyz = prev position in current origin space,
                                   //                w = camera speed (m/s)
  worldOrigin         : vec4f,     //  656    16   xyz = f64-derived origin of the current
                                   //                camera-relative space, w = rebase radius (2048)
  camPlanes           : vec4f,     //  672    16   x = near (0.08), y = shadowFar, z = 1/near,
                                   //                w = maxViewDistance (culling)

  // ---- Sun / Moon --------------------------------------------------------
  sunDirW             : vec4f,     //  688    16   xyz = direction TO the sun (unit), w = angular radius (rad)
  sunIlluminance      : vec4f,     //  704    16   rgb = linear illuminance (already /1e3), w = sun elevation (rad)
  moonDirW            : vec4f,     //  720    16   xyz = direction TO the moon, w = angular radius (rad)
  moonIlluminance     : vec4f,     //  736    16   rgb, w = moon phase 0..1

  // ---- Ambient -----------------------------------------------------------
  ambientSH           : array<vec4f, 9>,  // 752   144   pre-convolved SH-L2, rgb in xyz, w unused

  // ---- Water medium ------------------------------------------------------
  waterSigmaT         : vec4f,     //  896    16   rgb = extinction per metre, w = sea level y (0.0)
  waterSigmaS         : vec4f,     //  912    16   rgb = scattering per metre, w = phase g (0.62)
  waterDeepTint       : vec4f,     //  928    16   rgb = asymptotic deep colour, w = turbidity 0..1
  waterSurface        : vec4f,     //  944    16   x = caustic strength, y = foam coverage 0..1,
                                   //                z = choppiness, w = sea state (0..9 Douglas)
  camWater            : vec4f,     //  960    16   x = camera depth below surface (m, >0 submerged),
                                   //                y = submerged fraction of the viewport 0..1,
                                   //                z = underwater flag (0.0 / 1.0),
                                   //                w = signed distance from camera to surface (m)

  // ---- Air medium --------------------------------------------------------
  fogParams           : vec4f,     //  976    16   x = density at y=0 (1/m, 3.2e-5), y = height falloff (1/m, 1.1e-3),
                                   //                z = start distance (m), w = max opacity (0.985)
  fogColour           : vec4f,     //  992    16   rgb = fog inscatter tint, w = anisotropy g (0.15)

  // ---- Screen / TAA ------------------------------------------------------
  screen              : vec4f,     // 1008    16   x = renderW px, y = renderH px, z = 1/renderW, w = 1/renderH
  outputSize          : vec4f,     // 1024    16   x = outputW, y = outputH, z = renderScale, w = 1/renderScale
  taaJitter           : vec4f,     // 1040    16   x,y = current jitter (NDC), z,w = previous jitter (NDC)

  // ---- Exposure / time ---------------------------------------------------
  exposureParams      : vec4f,     // 1056    16   x = exposure multiplier, y = previous exposure,
                                   //                z = EV compensation, w = 1/exposure
  timeParams          : vec4f,     // 1072    16   x = time (s, wraps at 3600), y = deltaTime (s),
                                   //                z = frameIndex mod 64 (f32), w = total frames (f32)
  timeOfDay           : vec4f,     // 1088    16   x = day fraction 0..1, y = day length (s, 1440.0),
                                   //                z = twilight factor 0..1, w = star intensity 0..1

  // ---- Weather / wind ----------------------------------------------------
  weather             : vec4f,     // 1104    16   x = cloud coverage 0..1, y = cloud density mul,
                                   //                z = precipitation 0..1, w = lightning flash 0..1
  wind                : vec4f,     // 1120    16   xyz = wind vector (m/s, world), w = gust 0..1
  currentFlow         : vec4f,     // 1136    16   xyz = water current (m/s, world), w = turbulence 0..1

  // ---- Clustering / volumetrics -----------------------------------------
  clusterParams       : vec4f,     // 1152    16   x = tilesX, y = tilesY, z = sliceScale, w = sliceBias
  lightCounts         : vec4f,     // 1168    16   x = punctual count, y = shadowed count,
                                   //                z = maxLightsPerCluster, w = tileSizePx (80.0)
  volumeParams        : vec4f,     // 1184    16   x = froxelNear, y = froxelFar, z = slice jitter 0..1,
                                   //                w = temporal blend (0.92)
  volumeDim           : vec4f,     // 1200    16   x,y,z = froxel dims, w = 1/sliceCount

  // ---- Shadows -----------------------------------------------------------
  shadowParams        : vec4f,     // 1216    16   x = cascade count, y = shadow map size (texels),
                                   //                z = normal offset scale (1.7), w = fade start (m)
  cascadeSplits       : vec4f,     // 1232    16   view-space far distance of cascades 0..3

  // ---- Post --------------------------------------------------------------
  causticsParams      : vec4f,     // 1248    16   x = uv scale (1/m), y = scroll speed, z = max depth (m),
                                   //                w = chromatic split
  postParams          : vec4f,     // 1264    16   x = bloom intensity, y = bloom threshold (pre-exposed),
                                   //                z = chromatic aberration (px), w = vignette strength
  postParams2         : vec4f,     // 1280    16   x = grain intensity, y = grain scale, z = LUT blend,
                                   //                w = CAS sharpness
  lensWater           : vec4f,     // 1296    16   x = droplet amount 0..1, y = seconds since surface exit,
                                   //                z = wipe progress 0..1, w = interior fog 0..1
}
// TOTAL SIZE: 1312 bytes. Alignment: 16. Multiple of 16: yes (82 * 16).
```

Upload: a single 1312-byte `Float32Array` view written by hand each frame into a
triple-buffered 4 KiB-aligned staging region, then `queue.writeBuffer(frameUBO, 0, staging,
0, 1312)`. Field offsets are generated once into a frozen JS constant object
(`FRAME_OFFSETS`) and asserted against this table by a unit test in
`test/frame_layout.test.js`.

`debugParams` is deliberately **not** in `Frame`; debug visualisation uses a
`@group(1) @binding(7)` uniform so that shipping builds can strip it.

### G.3 The `ShadowUniform` (400 bytes)

```wgsl
struct ShadowCascade {              // 80 bytes
  viewProj      : mat4x4f,          //  0  64  world (camera-relative) -> shadow clip
  params        : vec4f,            // 64  16  x = texel world size (m), y = constant depth bias,
                                    //          z = normal offset (m), w = split far (m, view space)
}
struct ShadowUniform {
  cascades      : array<ShadowCascade, 4>,   //   0  320
  spotViewProj0 : mat4x4f,                   // 320   64   only the first shadowed spot is
                                             //             matrix-resident here; spots 1..5 live in
                                             //             a small storage buffer in bind group 1
                                             //             of the passes that need them.
  spotParams    : vec4f,                     // 384   16   x = spot count, y = spot map size,
                                             //             z = spot bias, w = spot normal offset
}
// TOTAL: 400 bytes.
```

### G.4 Bind groups 1, 2, 3

**Bind group 1 -- per-pass.** Layout differs per pass; the *slots* are standardised so that
shader authors do not invent conventions:

| Binding | Convention |
|---|---|
| 0 | Pass uniform (`var<uniform> pass : PassUniform;`), always with a dynamic offset, always <= 256 B |
| 1-4 | Pass input textures (up to 4) |
| 5-6 | Pass storage buffers (read or read_write, up to 2) |
| 7 | Pass storage texture (compute passes) OR debug uniform (render passes) |

Sampled textures used: <= 4. Storage buffers used: <= 2. This is the budget that keeps the
totals under the device limits (see G.5).

**Bind group 2 -- per-material-set.** Changed at most 3 times per frame.

| Binding | Type | Declaration |
|---|---|---|
| 0 | storage (read) | `var<storage, read> s_materials : array<Material>;` (160 KiB) |
| 1 | texture | `var t_albedoArray : texture_2d_array<f32>;` |
| 2 | texture | `var t_normalArray : texture_2d_array<f32>;` |
| 3 | texture | `var t_mrahArray : texture_2d_array<f32>;` |
| 4 | texture | `var t_detailAlbedo : texture_2d<f32>;` |
| 5 | texture | `var t_detailNormal : texture_2d<f32>;` |
| 6 | sampler | `var samp_aniso : sampler;` |

Sampled textures: 5. Storage buffers: 1.

**Bind group 3 -- per-draw / per-instance-batch.**

| Binding | Type | Declaration |
|---|---|---|
| 0 | uniform (dynamic offset) | `var<uniform> draw : DrawUniform;` (256 B stride) |
| 1 | storage (read) | `var<storage, read> s_instances : array<InstanceData>;` |
| 2 | storage (read) | `var<storage, read> s_vertices : array<PackedVertex>;` (vertex pulling) |
| 3 | storage (read) | `var<storage, read> s_indices : array<u32>;` (only where index pulling is used; otherwise the pipeline uses a real index buffer) |

```wgsl
struct DrawUniform {                // 256 B stride (dynamic-offset aligned), 144 B used
  model        : mat4x4f,           //   0  64  object -> camera-relative world
  prevModel    : mat4x4f,           //  64  64  previous frame, for velocity
  materialIndex: u32,               // 128   4
  instanceBase : u32,               // 132   4  offset into s_instances
  vertexBase   : u32,               // 136   4  offset into s_vertices
  flags        : u32,               // 140   4  per-draw overrides (see below)
  tint         : vec4f,             // 144  16  multiplied into baseColorFactor
  userParams   : vec4f,             // 160  16  free slot (e.g. damage 0..1, wetTimer, charge)
                                    // 176..255 = padding
}

struct InstanceData {               // 64 bytes
  posScale     : vec4f,             //  0  xyz = camera-relative position, w = uniform scale
  rotation     : vec4f,             // 16  quaternion (x,y,z,w), unit
  prevPosScale : vec4f,             // 32  previous-frame position + scale (velocity)
  packed       : vec4f,             // 48  x = colour variant seed 0..1, y = wind phase,
                                    //     z = material index override (f32, -1 = use draw),
                                    //     w = LOD fade 0..1
}
```

`InstanceData` is 64 B; the instance pool at T2 is 200 000 entries = **12.8 MiB**.

### G.5 The per-stage resource budget (HARD)

| Resource | Group 0 | Group 1 (max) | Group 2 | Group 3 | Total | Device limit |
|---|---|---|---|---|---|---|
| Sampled textures | 10 | 4 | 5 | 0 | **19** | 16 requested, 24 preferred |
| Samplers | 4 | 0 | 1 | 0 | **5** | 16 |
| Storage buffers | 3 | 2 | 1 | 3 | **9** | 8 core |
| Uniform buffers | 2 | 1 | 0 | 1 | **4** | 12 |
| Storage textures | 0 | 1 | 0 | 0 | **1** | 4 core |

Two totals exceed the *core* limits (19 > 16 sampled, 9 > 8 storage buffers). Resolution
(binding):

1. The renderer requests `maxSampledTexturesPerShaderStage: 24` and
   `maxStorageBuffersPerShaderStage: 10`. These are supported on every desktop Chrome
   backend we target (Metal, D3D12, Vulkan all report >= 128 / >= 16 in practice, and
   Chrome exposes them).
2. If the request is refused, the `#define TIGHT_BINDINGS 1` path is compiled, which:
   - drops `t_shadowSpot`, `t_aerialLUT`, and `t_skyVisibility` from group 0 for
     *fragment* shaders in the material passes (spot shadows disabled, aerial perspective
     folded analytically into the fog, sky visibility replaced by `col.a` baked AO). Group 0
     drops to 7 sampled textures. Total: 16. Fits exactly.
   - merges `s_indices` into `s_vertices` (single buffer with an index sub-range) and moves
     `s_clusterRanges` into the first 120 KiB of `s_lightIndices`. Total storage buffers: 7.
3. **No pass may exceed the budget in the table.** A pass needing a 5th input texture must
   pack channels or use a texture array.

Bind-group churn target per frame: <= 3 group-2 changes, <= 40 group-1 changes,
<= 900 group-3 dynamic-offset changes (dynamic offsets do not rebind the group; they are
cheap `setBindGroup(3, bg, [offset])` calls).

---

## H. TAA + JITTER

### H.1 Sample sequence

- Sequence: **Halton(2, 3)**, 16 samples at T2/T3, 8 at T1.
- Index: `k = frame.timeParams.w mod N` (`N` = 16 or 8).
- Sample values `h in [0,1)^2` are remapped to `[-0.5, 0.5)` and multiplied by a filter
  width `W = 1.0` (a Gaussian-weighted jitter of `W = 1.15` is available as an option; the
  default is uniform).
- Applied by modifying the projection matrix *after* it is built:

```
jitterNDC.x = (h.x - 0.5) * W * 2.0 / renderWidth
jitterNDC.y = (h.y - 0.5) * W * 2.0 / renderHeight   // note: NOT flipped; WebGPU NDC +Y up
proj[2][0] += jitterNDC.x        // column-major mat4: element (row 0, col 2)
proj[2][1] += jitterNDC.y
```

`frame.taaJitter = vec4f(jitterNDC.x, jitterNDC.y, prevJitterNDC.x, prevJitterNDC.y)`.
`viewProjUnjittered` is kept separately for: motion-vector computation, cluster assignment,
culling, HiZ, and any world-space reconstruction that must be jitter-free.

Jitter is **disabled** (set to 0) when: TAA is off (T0), the camera is fully static and the
world is paused (photo mode uses a 64-sample accumulation instead), or the frame is a
cubemap/probe render.

### H.2 Motion vectors

Written by the prepass (MRT1, `rg16float`) as:

```
mv = (currClipUnjittered.xy / currClipUnjittered.w)
   - (prevClipUnjittered.xy / prevClipUnjittered.w)     // in NDC units, range about [-2, 2]
```

Static geometry uses `prevModel == model` and the previous camera matrices. Skinned meshes
write true per-vertex motion (the skinning pass keeps the previous frame's skinned positions
in a double buffer). The ocean surface writes motion from the *displaced* position of the
same parametric point in both frames -- this is essential or the wave crests smear. Particles
write motion in pass 5.13 only when TAA is enabled and the particle is larger than 4 px
(smaller ones are excluded from history via the "no-history" flag encoded as
`mv = (NaN-safe) 1e4` sentinel, which forces `historyWeight = 0`).

### H.3 Resolve

Pass 6.03, `@workgroup_size(8, 8)`, one invocation per output pixel.

1. **Current colour**: 3x3 neighbourhood of the HDR buffer, converted to **YCoCg**, with a
   Mitchell-Netravali-like reconstruction: centre weight 1.0, edge 0.16, corner 0.06,
   normalised. This is the "sharpen the current sample" step; it replaces a separate sharpen
   filter for the TAA-induced blur.
2. **Neighbourhood statistics**: mean `m1` and second moment `m2` over the 3x3 YCoCg
   samples; `sigma = sqrt(max(m2 - m1*m1, 0))`; box = `m1 +/- gamma * sigma` with
   `gamma = 1.25` (T2) / `1.0` (T3, sharper but more prone to ghosting) -- plus the true
   min/max box intersected in, using `boxMin = max(m1 - gamma*sigma, trueMin)` and
   symmetrically for max. This is variance clipping with a hard clamp fallback.
3. **History fetch**: `prevUV = uv - mv * 0.5` (NDC->UV scale), sampled with an optimised
   **5-tap Catmull-Rom** (Karis) to avoid the over-blur of bilinear history.
4. **Clip, not clamp**: history is clipped toward the current colour along the line
   `history -> m1`, using the AABB ray-intersection form. Clipping preserves more history
   than clamping on thin features.
5. **Feedback weight**:
   ```
   base    = 0.94                                        // 16-frame equivalent
   // Reject on velocity: fast motion -> trust history less.
   velLen  = length(mv * screen.xy)                       // pixels
   wVel    = 1.0 - saturate((velLen - 1.5) / 28.0) * 0.55
   // Reject on depth disocclusion.
   dz      = abs(linearDepth - prevLinearDepth) / max(linearDepth, 1e-3)
   wDepth  = 1.0 - smoothstep(0.030, 0.090, dz)
   // Reject on luminance mismatch after clipping (fireflies, specular pops).
   dLum    = abs(curr.x - histClipped.x) / max(curr.x + histClipped.x, 1e-3)
   wLum    = 1.0 - saturate((dLum - 0.25) / 0.55) * 0.7
   // Reject off-screen history.
   wEdge   = all(prevUV > 0 && prevUV < 1) ? 1.0 : 0.0
   alpha   = base * wVel * wDepth * wLum * wEdge
   result  = mix(curr, histClipped, alpha)
   ```
6. **Anti-flicker**: both current and history are weighted by `1/(1+luma)` before the mix and
   divided back afterwards (Karis tonemapped-average), which removes almost all specular
   fireflies.
7. **Output** is written to the new history AND used as the post-chain input. Format
   `rgba16float`, `a` stores the resolved `alpha` for the debug view.

### H.4 Interaction with volumetrics

The froxel volume has its **own** temporal reprojection (pass 4.02) that must not be
double-counted by TAA:

- The froxel volume is reprojected in *volume space*: for froxel `(x,y,z)`, reconstruct its
  world position at the slice centre, project by `prevViewProj`, convert to the previous
  volume's froxel coordinate, and sample trilinearly from the history volume.
- Blend `0.92` (i.e. `volumeParams.w`), reduced to `0.55` when
  `|prevSlice - currSlice| > 1.5` or when the reprojected sample leaves the volume.
- The whole-volume slice jitter (Section B.5) is a *frame-coherent* Halton(2) value, so the
  volume's temporal integration converges on the correct slice-integral. It must NOT be
  per-froxel-random or reprojection will thrash.
- Because the volume is already temporally filtered and is applied at a much lower
  frequency than the colour buffer, TAA's neighbourhood clamp would fight it. Fix: pass 5.07
  writes the volumetric contribution with a **wider** effective footprint (the froxel volume
  is trilinearly sampled with a half-froxel bilateral-depth-weighted blur), so its spatial
  variance is below the TAA clamp threshold everywhere, and TAA never clips it. Verified by
  the `taa_clip_rate` debug view: volumetric-dominated pixels must show a clip rate < 2%.
- Cloud reprojection (4.05) uses the same scheme in 2D with blend 0.90 and a hard reject on
  `|cloudDepth - prevCloudDepth| / cloudDepth > 0.25`.

### H.5 Known artefacts and their mitigations (binding acceptance criteria)

| Artefact | Mitigation | Acceptance |
|---|---|---|
| Ghosting behind fast fish | Velocity + luminance rejection above; fish are `matClass 1` and get a 1.25x rejection multiplier | No visible trail beyond 2 frames at 8 m/s lateral |
| Bioluminescent particle smear | Particles < 4 px write the no-history sentinel | Point lights on plankton stay crisp |
| Ocean crest shimmer | Parametric ocean motion vectors + roughness filtering + `alpha` floor 0.045 | No crawling at 30 m distance, sea state 4 |
| Disocclusion noise at cave mouths | GTAO and the froxel volume are temporally stable independently; TAA disocclusion falls back to the spatially-reconstructed current colour (step 1's Mitchell filter) | Acceptable 1-frame softness |
| HUD shimmer | HUD is composited **after** TAA at native resolution | Zero |

---

## I. TRANSPARENCY & REFRACTION ORDER

The single hardest ordering problem in this game is: the camera can be above the water
looking down through the surface at a jellyfish that is itself in front of a kelp frond,
while a godray passes through all of it, and the whole thing is seen through the vessel's
glass canopy which has a HUD projected on it. The ordering below is **binding**.

### I.1 Ordering rules

1. **All opaque geometry first** (passes 5.02-5.06). Depth is complete, HiZ is valid,
   the medium (water or air) has been applied per-fragment analytically inside each forward
   shader via `applyMedium()` (Section I.3).
2. **Volumetric application** (5.07) adds the froxel in-scatter and multiplies by
   volumetric transmittance for everything drawn so far. Godrays exist *only* here -- there
   is no separate radial-blur godray pass. Above water, sun shafts through clouds come from
   the same froxel volume (which is 640 m deep in air).
3. **Cloud composite** (5.08) -- clouds are always behind everything except the sky, so they
   composite with `one, src-alpha` using the cloud transmittance, depth-tested against the
   cloud depth buffer versus the scene depth so that a mountain in front of a cloud is
   correct.
4. **HDR copy** for refraction. Full-res at T2/T3, plus 5 mip levels generated by a
   box-downsample compute dispatch. Mip level is chosen by the refracting surface's
   roughness: `mip = sqrt(alpha) * 4.0`. This is the *only* source any refracting surface
   may read; nothing samples the HDR target it is currently writing.
5. **SSR** (5.09/5.10) traces against the HiZ + the HDR copy. Runs *before* the ocean
   surface because the ocean is its biggest consumer.
6. **Ocean surface** (5.11). Depth-tested `greater` and **writes depth**. This is deliberate:
   the surface is an opaque-with-refraction surface, not a blended one. Reasons: (a) it lets
   underwater particles and jellyfish behind the surface be correctly occluded, (b) it gives
   TAA correct motion vectors for the surface, (c) refraction is done by sampling the HDR
   copy with a UV offset, which is strictly better than blending. See I.2 for the two
   sub-cases.
7. **Sorted transparents** (5.12): jellyfish, salps, siphonophores, membranes, thin fins,
   ice sheets, bubble curtains. Sorted **back to front by view-space depth of the object's
   bounding-sphere centre**, with a per-object override key for objects that must be drawn
   in a fixed relative order (a jelly's bell vs. its tentacles). Depth test `greater`, depth
   write **off**. Two pipelines: `src-alpha/one-minus-src-alpha` (bodies) and `one/one`
   (bioluminescent emission), always issued as body-then-emission for the same object.
   Objects larger than 3 m are split into per-triangle-sorted sub-batches by the CPU only if
   the camera is inside their bounding sphere (rare; costs a sort of <= 400 triangles).
8. **Particles** (5.13): rendered after 5.12 in a single pass, sorted back-to-front by a
   GPU bitonic sort over the alive list (key = quantised view depth, 16-bit). Two draw
   calls: alpha-blended then additive. Soft particles: `alpha *= saturate((sceneZ -
   particleZ) / softness)` with `softness = 0.35 m` for bubbles, `1.2 m` for marine snow,
   `0.15 m` for sparks. Particles read the froxel volume for in-scatter so that a bubble
   plume inside a torch beam glows.
9. **Canopy glass** (5.14): drawn last of the world geometry. Refracts the HDR copy (which
   at this point does **not** contain 5.11-5.13 -- an accepted approximation; the canopy
   refraction offset is <= 3 px so the error is invisible). Adds: environment reflection,
   a dirt/salt-crust mask, water droplets running on the outside (when the vessel has just
   surfaced), interior fog when `lensWater.w > 0`, and the **HUD emissive layer** as an
   additive term with a slight chromatic offset and a Fresnel-boosted intensity so that the
   instrumentation genuinely looks projected on the glass rather than pasted on the screen.
10. **Post chain** (6.x) -- operates on the fully composited HDR.
11. **Screen-space UI** (6.10) -- inventory, menus, subtitles-free hint text. Native
    resolution, after upscale, never TAA'd.

### I.2 The ocean surface: two sub-cases

| Case | Condition | Behaviour |
|---|---|---|
| Above-water surface | `camWater.z == 0.0` and the surface fragment's normal faces the camera | Fresnel (F0 = 0.0201, Schlick, with a roughness-dependent `F_SchlickRoughness`) blends between: **reflection** = `mix(envCube, ssr.rgb, ssr.a)` + sun specular (GGX with the sun's solid angle, roughness from the FFT slope variance + foam), and **refraction** = HDR copy sampled at `uv + refractOffset`, then attenuated by `waterTransmittance(sigmaT, refractedPathLength)` and augmented with `waterInScatter` over that path. `refractOffset = (N.xz - Ngeo.xz) * 0.045 * saturate(20.0/viewDist)`, clamped so the sampled UV never crosses the surface silhouette (checked by comparing the sampled pixel's depth against the surface depth; on failure, fall back to the un-offset sample). |
| Below-water surface | `camWater.z == 1.0` | The surface is seen from below. Inside **Snell's window** (half-angle 48.6 deg from vertical) the fragment shows the refracted sky/sun disc + above-water geometry (from the HDR copy, which contains the above-water opaques since they were drawn in 5.02-5.06). Outside the window, **total internal reflection**: the fragment mirrors the underwater scene, which we approximate with the env cube's lower hemisphere + SSR. The boundary is softened over 2.5 deg. Foam is rendered from below as a bright scattering sheet with `sigma_s` tripled. |

The surface mesh is a camera-locked projected grid (7 LOD rings at T2, base quad 8 m,
extending to 4 km) with the FFT displacement applied in the vertex stage. Vertices beyond
1.2 km use only cascade 3 (the largest wavelength) to avoid aliasing. The mesh is
**clipped by the terrain**: the vertex shader reads a coarse height field and pushes ocean
vertices below terrain out of the frustum (`position.w = -1`) so no surface is drawn inside
rock.

### I.3 The medium application contract

Every forward fragment shader ends with exactly:

```wgsl
// L = the surface's outgoing radiance in the camera direction, pre-exposure.
// P = world (camera-relative) fragment position.
var Lout = L;
if ((material.flags & MAT_NO_FOG) == 0u) {
  Lout = applyMedium(Lout, P);
}
return vec4f(Lout * frame.exposureParams.x, alpha);
```

`applyMedium` dispatches on whether the camera and the fragment are above or below the
surface (four cases). This is the single point of truth for water and air fog; **no pass may
apply extinction anywhere else.** The froxel volume adds only the *shadowed, local-light*
in-scatter on top (pass 5.07), which is why the froxel injection stores only
`sigma_s * (localLightRadiance + shadowedSunRadiance)` and not the analytic base term.

```wgsl
// ---- common/water.wgsl --------------------------------------------------
// #pragma once
// #include "common/math.wgsl"

// Beer-Lambert transmittance through `dist` metres of water.
fn waterTransmittance(sigmaT: vec3f, dist: f32) -> vec3f {
  return exp(-sigmaT * max(dist, 0.0));
}

// Henyey-Greenstein phase function.
fn phaseHG(cosTheta: f32, g: f32) -> f32 {
  let g2 = g * g;
  let d  = max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4);
  return (1.0 - g2) / (4.0 * PI * d * sqrt(d));
}

// Cosine of the sun's REFRACTED direction below the surface (Snell, n = 1.333).
// sunCosZenith = dot(sunDirW, +Y) above the surface.
fn refractedSunCos(sunCosZenith: f32) -> f32 {
  let sinI = sqrt(max(0.0, 1.0 - sunCosZenith * sunCosZenith));
  let sinT = clamp(sinI / 1.333, 0.0, 1.0);
  return sqrt(max(1.0e-4, 1.0 - sinT * sinT));
}

// Downwelling sun irradiance surviving to depth d (metres below the surface),
// including the Fresnel transmission at a statistically-flat surface.
fn sunTransmittanceAtDepth(sigmaT: vec3f, d: f32, cosT: f32) -> vec3f {
  let path = max(d, 0.0) / max(cosT, 0.15);
  return exp(-sigmaT * path);
}

// Analytic single-scattering of SUNLIGHT along a view ray of length s.
//   y0    : world Y of the ray origin (negative below the surface)
//   dirY  : Y component of the (unit) view ray direction, pointing AWAY from the eye
//   s     : path length in metres through the water
//   cosT  : cosine of the refracted sun zenith angle (from refractedSunCos)
//   phase : phaseHG(dot(viewDir, refractedSunDir), g), evaluated by the caller
//   sunL  : sun radiance AT THE SURFACE, already multiplied by the Fresnel
//           transmission (0.977 for near-vertical sun) and by the sky/cloud transmittance
//
// Derivation: depth(t) = -(y0 + dirY*t); the sun path is depth(t)/cosT; the eye path
// is t. Both extinctions are exponential, so the integrand is exp(-k*t) with
//   k = sigmaT * (1 - dirY/cosT)
// and a constant prefactor exp(sigmaT * y0 / cosT) = transmittance to the ray origin.
fn waterSunInScatter(y0: f32, dirY: f32, s: f32,
                     sigmaT: vec3f, sigmaS: vec3f,
                     cosT: f32, phase: f32, sunL: vec3f) -> vec3f {
  let invC = 1.0 / max(cosT, 0.15);
  let k    = sigmaT * (1.0 - dirY * invC);
  let T0   = exp(sigmaT * min(y0, 0.0) * invC);   // <= 1, sun transmittance at the origin
  // (1 - exp(-k*s)) / k, numerically stable as k -> 0 (2nd-order series).
  let ks   = k * s;
  let stable = select(s * (1.0 - 0.5 * ks + (1.0 / 6.0) * ks * ks),
                      (vec3f(1.0) - exp(-ks)) / k,
                      abs(ks) > vec3f(1.0e-3));
  return sunL * sigmaS * phase * T0 * max(stable, vec3f(0.0));
}

// Ambient (sky + multiple-scattering) in-scatter along the same ray.
// Isotropic; uses the depth-averaged ambient radiance so it needs no integral
// over depth beyond the simple homogeneous form.
fn waterAmbientInScatter(s: f32, sigmaT: vec3f, sigmaS: vec3f,
                         ambient: vec3f) -> vec3f {
  let t = (vec3f(1.0) - exp(-sigmaT * s)) / max(sigmaT, vec3f(1e-6));
  return ambient * sigmaS * INV_PI * t;
}

// THE contract function. Applies water and/or air medium to `L` for a fragment at P.
fn applyMedium(L: vec3f, P: vec3f) -> vec3f {
  let toEye   = -P;                      // camera is at the origin (camera-relative space)
  let dist    = length(toEye);
  if (dist < 1e-4) { return L; }
  let dir     = -toEye / dist;           // eye -> fragment, unit
  let camY    = frame.cameraPosW.y;      // ~0 in camera-relative space; use worldOrigin.y
  let y0      = frame.worldOrigin.y + camY;
  let y1      = y0 + dir.y * dist;

  // Split the segment at y = 0 (the mean sea level; the true wavy surface is
  // handled by the ocean pass, this analytic split uses the plane).
  var waterLen = 0.0;
  var airLen   = 0.0;
  var waterY0  = y0;
  if (y0 < 0.0 && y1 < 0.0)        { waterLen = dist; }
  else if (y0 >= 0.0 && y1 >= 0.0) { airLen   = dist; }
  else {
    let t = clamp(-y0 / (y1 - y0), 0.0, 1.0) * dist;
    if (y0 < 0.0) { waterLen = t;        airLen = dist - t; waterY0 = y0; }
    else          { airLen   = t;        waterLen = dist - t; waterY0 = 0.0; }
  }

  var outL = L;
  if (waterLen > 0.0) {
    let sigmaT = frame.waterSigmaT.rgb;
    let sigmaS = frame.waterSigmaS.rgb;
    let cosT   = refractedSunCos(max(frame.sunDirW.y, 0.0));
    let sunRef = normalize(vec3f(frame.sunDirW.x, cosT / 1.0, frame.sunDirW.z));
    let ph     = phaseHG(dot(dir, -sunRef), frame.waterSigmaS.w);
    let sunL   = frame.sunIlluminance.rgb * 0.977;
    outL = outL * waterTransmittance(sigmaT, waterLen)
         + waterSunInScatter(waterY0, dir.y, waterLen, sigmaT, sigmaS, cosT, ph, sunL)
         + waterAmbientInScatter(waterLen, sigmaT, sigmaS, evalAmbientSH(vec3f(0.0, 1.0, 0.0)));
  }
  if (airLen > 0.0) {
    // Exponential height fog with analytic height integral.
    let fd = frame.fogParams.x;
    let fh = frame.fogParams.y;
    let dY = dir.y * airLen;
    let hInt = select(exp(-fh * max(y0, 0.0)) * airLen,
                      exp(-fh * max(y0, 0.0)) * (1.0 - exp(-fh * dY)) / (fh * dY),
                      abs(dY) > 1e-3) * airLen;
    let od = fd * hInt;
    let tr = exp(-od);
    let ph = phaseHG(dot(dir, -frame.sunDirW.xyz), frame.fogColour.w);
    outL = outL * tr + frame.fogColour.rgb * (1.0 - tr) * (0.6 + 0.4 * ph * 4.0);
  }
  return outL;
}
```

### I.4 Default water medium coefficients

Per-metre coefficients, linear Rec.709 approximations of Jerlov water types. These are the
**defaults**; the biome system may override them per region, but only within the listed
bounds.

| Water type | Where | `sigma_a` (R,G,B) 1/m | `sigma_s` (R,G,B) 1/m | `sigma_t` = a+s | g | Deep tint |
|---|---|---|---|---|---|---|
| Oceanic I (clear) | Open ocean, > 400 m from shore | 0.4500, 0.0630, 0.0145 | 0.0015, 0.0035, 0.0090 | 0.4515, 0.0665, 0.0235 | 0.62 | 0.02, 0.09, 0.16 |
| Oceanic II | Starting reef shallows | 0.4600, 0.0760, 0.0290 | 0.0090, 0.0140, 0.0230 | 0.4690, 0.0900, 0.0520 | 0.66 | 0.05, 0.16, 0.19 |
| Coastal 1 (turbid) | River mouths, silt shelves | 0.5100, 0.1400, 0.0950 | 0.0450, 0.0620, 0.0790 | 0.5550, 0.2020, 0.1740 | 0.72 | 0.09, 0.16, 0.13 |
| Kelp-shadow | Inside kelp forests | 0.5400, 0.1900, 0.1300 | 0.0300, 0.0400, 0.0450 | 0.5700, 0.2300, 0.1750 | 0.70 | 0.06, 0.13, 0.09 |
| Hydrothermal | Vent fields | 0.6200, 0.3100, 0.2900 | 0.1400, 0.1350, 0.1300 | 0.7600, 0.4450, 0.4200 | 0.80 | 0.11, 0.10, 0.10 |
| Abyssal | > 600 m | 0.4500, 0.0630, 0.0145 | 0.0008, 0.0018, 0.0045 | 0.4508, 0.0648, 0.0190 | 0.55 | 0.004, 0.010, 0.016 |
| Brine pool | Dense brine layers | 0.9000, 0.5500, 0.4000 | 0.2000, 0.1900, 0.1800 | 1.1000, 0.7400, 0.5800 | 0.85 | 0.05, 0.04, 0.03 |

Sanity check on Oceanic I: red transmittance at 10 m = `exp(-4.515) = 0.011` (99% of red
gone); blue at 10 m = `exp(-0.235) = 0.79`; blue at 100 m = `exp(-2.35) = 0.095`; blue at
250 m = `exp(-5.875) = 0.0028`. Below ~280 m the analytic sun term is under 0.3% and the
"pitch black except your lights" fantasy is physically satisfied without any artificial
cutoff. Biome transitions lerp `sigma_a`, `sigma_s`, `g` and the tint over 60 m of travel.

---

## J. BUDGETS

### J.1 VRAM by resource class (T2, 1920x1080)

| Class | Resources | MB |
|---|---|---|
| Main render targets | HDR `rgba16float` (16.6) + TAA history `rgba16float` (16.6) | 33.2 |
| Depth | depth32float current (8.3) + previous (8.3) | 16.6 |
| Prepass MRTs | normal/rough `rgb10a2unorm` (8.3) + motion `rg16float` (8.3) | 16.6 |
| HiZ | `r32float` full-res + 8 mips | 11.1 |
| HDR refraction copy | `rgba16float` + 5 mips | 22.1 |
| GTAO | half-res `rgba8unorm` x 2 (current + history) | 4.1 |
| SSR | half-res `rgba16float` x 2 | 8.3 |
| Bloom chain | 6 mips `rg11b10ufloat` from half-res | 2.8 |
| Lens droplets | quarter-res `rgba8unorm` | 0.5 |
| Froxel volumes | 160x90x64 `rgba16float` x 3 (scatter, history, integrated) | 22.1 |
| Cloud buffers | shape `r8unorm` 128^3 (2.1) + detail 32^3 (0.03) + weather `rgba8` 512^2 (1.0) + half-res colour `rgba16float` and depth `r32float`, x2 for history (12.4) | 15.6 |
| Sun shadow atlas | `depth32float` 2048x2048x4 | 67.1 |
| Spot shadow atlas | `depth32float` 1024x1024x6 | 25.2 |
| Sky/atmosphere LUTs | transmittance 256x64, multiscatter 32x32, skyview 192x108, aerial 32^3 (all `rgba16float`) | 1.2 |
| Env specular cube | 64x64x6 `rgba16float` + 6 mips | 0.3 |
| Sky visibility volume | 64x32x64 `rgba8unorm` + coarse SDF 128^3 `r16float` | 4.7 |
| Ocean FFT set | 4 cascades: h0, Hkt x3 `rgba32float` 256^2, displacement/normal `rgba16float` 256^2 + mips, foam `r16float` | 9.4 |
| Caustics | 512x512x4 `rgba8unorm` + mips | 5.6 |
| Material set 0 (terrain) | albedo 512^2x16 srgb (22.4) + normal rg8 512^2x16 (11.2) + MRAH 256^2x16 (5.6), all with mips (x1.333). Per-layer cost = 2.333 MB. | 37.3 |
| Material set 1 (organic) | 24 layers, same formats | 56.0 |
| Material set 2 (hard-surface) | 12 layers, same formats | 28.0 |
| Shared textures | detail albedo/normal, blue noise 128^2x64, grade LUTs, glyph + icon atlases | 8.9 |
| Terrain geometry pool | vertex 160 MB + index 48 MB (single storage buffer at 192 MB requested limit, or 2 x 104 MB) | 208.0 |
| Static mesh pool | vessel, props, rocks, corals (vertex + index) | 26.0 |
| Skinned mesh pool | rest pose (18) + skinned output double-buffered (36) + bone matrices (0.5) | 54.5 |
| Instance pool | 200k `InstanceData` | 12.8 |
| Particle buffers | 65k particles x 80 B (5.2) + alive/free/sort lists (2.1) | 7.3 |
| Boids buffers | 8192 agents x 64 B + grid (0.6) | 1.1 |
| Light + cluster buffers | lights (0.06) + cluster AABBs (0.47) + ranges (0.12) + indices (3.75) | 4.4 |
| Indirect + culling buffers | indirect args, compacted indices, counters | 5.0 |
| Uniform ring buffers | frame/shadow/pass/draw, triple-buffered | 12.0 |
| Readback staging | timestamps, histogram, picking | 1.0 |
| **TOTAL** | | **~729 MB** |
| Allocator slack / fragmentation (8%) | | 58 |
| **BUDGET** | | **787 MB** (target 800, hard cap 1024) |

Tier totals: T0 ~275 MB, T1 ~420 MB, T2 ~787 MB, T3 ~1195 MB. The dominant single line item
at every tier is the terrain geometry pool; it is the first thing halved when memory is
tight (Section J.1 footnote below), which costs streaming radius, not visual quality.

If the adapter reports less than 1.5 GB of usable memory (heuristic: it is an integrated
GPU by `adapter.info`, or a `mapAsync` allocation probe of 512 MB fails), the tier is
forced down one step and the terrain geometry pool is halved.

### J.2 Per-pass millisecond budget (T2, 1920x1080) -- the authoritative table

| Pass | ms | Cumulative |
|---|---|---|
| frame_upload | 0.02 | 0.02 |
| ocean_spectrum + fft_h + fft_v + assemble + mips | 0.50 | 0.52 |
| terrain_meshing (amortized cap) | 0.45 | 0.97 |
| skinning | 0.18 | 1.15 |
| boids_grid_build + boids_update | 0.10 | 1.25 |
| particle_emit + particle_update | 0.12 | 1.37 |
| light_prepass_cull + light_cluster_cull | 0.10 | 1.47 |
| sky LUTs (transmittance + multiscatter + view + SH + aerial) | 0.24 | 1.71 |
| env_specular_update | 0.05 | 1.76 |
| caustics_gen | 0.12 | 1.88 |
| sky_visibility_update | 0.04 | 1.92 |
| gpu_cull_opaque | 0.15 | 2.07 |
| shadow_cascade_0..3 | 0.95 | 3.02 |
| prepass | 0.85 | 3.87 |
| hiz_build | 0.10 | 3.97 |
| gtao_trace + gtao_denoise | 0.50 | 4.47 |
| froxel_inject + reproject + integrate | 0.52 | 4.99 |
| cloud_render + cloud_reproject | 0.65 | 5.64 |
| sky | 0.12 | 5.76 |
| forward_terrain | 1.85 | 7.61 |
| forward_scatter | 0.95 | 8.56 |
| forward_skinned | 0.55 | 9.11 |
| forward_vessel | 0.28 | 9.39 |
| decals | 0.10 | 9.49 |
| volumetric_apply | 0.10 | 9.59 |
| cloud_composite | 0.08 | 9.67 |
| hdr_copy_for_refraction (+ mips) | 0.12 | 9.79 |
| ssr_trace + ssr_resolve | 0.55 | 10.34 |
| ocean_surface | 0.70 | 11.04 |
| transparent_sorted | 0.35 | 11.39 |
| particles | 0.40 | 11.79 |
| canopy_glass | 0.14 | 11.93 |
| luma_histogram + exposure_adapt | 0.06 | 11.99 |
| taa_resolve | 0.45 | 12.44 |
| bloom_downsample + bloom_upsample | 0.30 | 12.74 |
| lens_water | 0.05 | 12.79 |
| composite (+ fused CAS) | 0.20 | 12.99 |
| ui_hud | 0.15 | 13.14 |
| Pass-transition / barrier overhead (measured, ~2%) | 0.28 | **13.42** |
| **Present + driver reserve** | 1.20 | **14.62 of 16.60** |

**Enforcement.** With `timestamp-query`, each pass writes begin/end timestamps. The dev HUD
shows measured vs. budget per pass, and a pass exceeding 130% of its budget for 60
consecutive frames logs a warning with the pass name. CI runs a headless capture on the
reference scene (see `test/perf_scene.js`) and fails if the total exceeds 15.0 ms.

### J.3 Draw-call and primitive budgets

| Metric | T2 budget |
|---|---|
| Draw calls per frame (all passes) | <= 900 |
| Indirect multi-draw batches | <= 64 (each expands to up to 4096 instances) |
| Triangles submitted per frame (all passes, incl. shadows) | <= 5.5 M |
| Triangles rasterised in the main view | <= 2.2 M |
| Instances after GPU cull | <= 90 000 |
| Compute dispatches | <= 120 |
| `setBindGroup` calls | <= 1000 |
| `setPipeline` calls | <= 80 |
| Buffer writes (`writeBuffer`) | <= 24, total <= 6 MB |

### J.4 Tonemapping

**AgX** (Troy Sobotka's transform), implemented analytically:
1. Convert linear Rec.709 to the AgX working space via a fixed 3x3 matrix.
2. Log2 encode over `[-12.47393, +4.026069]` EV.
3. Apply the 6th-order polynomial sigmoid approximation of the AgX contrast curve.
4. Apply the "look" (per-biome): slope, offset, power, saturation.
5. Convert back to linear Rec.709 via the inverse matrix, then the grade LUT, then sRGB
   OETF.

AgX is chosen over ACES/Reinhard because it desaturates highlights gracefully (the sun on
the water surface and the torch on white sand both blow out to a believable near-white
instead of ACES' notorious hue skews) and it keeps deep-blue underwater scenes from
collapsing to a flat cyan. Per-biome "look" parameters live in the biome table (Section 04).

Exposure: histogram-based auto-exposure over 256 log-luminance bins spanning
`[-8, +14] EV`. Target: the 55th percentile of the (centre-weighted, 40% inner-ellipse
bias) histogram maps to 0.18 middle grey. Adaptation speed: 1.6 EV/s brightening (eye
adapting to light), 0.55 EV/s darkening (adapting to dark) -- deliberately asymmetric to
mimic human dark adaptation, and doubled in duration when descending past 80 m so that
entering the twilight zone *feels* like your eyes adjusting. Manual clamp:
`[-4 EV, +16 EV]`. EV compensation from gameplay (e.g. -1.2 EV inside the vessel with
interior lights off) is added in `exposureParams.z`.

---

## K. WGSL SHADER MODULE ORGANIZATION

### K.1 No build step: the runtime preprocessor

Shaders are plain `.wgsl` files served statically and fetched with `fetch()`. A ~200-line
`ShaderLibrary` class in `src/core/shaderlib.js` implements a minimal, deterministic
preprocessor. All directives are inside WGSL line comments so that the raw files remain
valid-ish WGSL for editor tooling.

| Directive | Semantics |
|---|---|
| `//#include "path/to/file.wgsl"` | Textual inclusion, resolved relative to `/src/render/shaders/`. Cycles are an error. |
| `//#pragma once` | Include guard. Must be the first non-comment line of every header. |
| `//#define NAME value` | Object-like macro only. No function-like macros. Values are integers, floats, or bare identifiers. |
| `//#if EXPR` / `//#elif` / `//#else` / `//#endif` | `EXPR` is a restricted integer expression: identifiers, integer literals, `+ - * / %`, `== != < > <= >=`, `&& || !`, parentheses. Evaluated by a 90-line recursive-descent parser (no `eval`). |
| `//#permute NAME 0 1 2` | Declares that this module has a permutation axis. The pipeline cache key is the sorted list of `(NAME, value)` pairs. |
| `//#requires FEATURE` | The module compiles only if the device has the named WebGPU feature; otherwise `ShaderLibrary` throws a descriptive error at pipeline-creation time. |

Everything else is untouched. There is **no** macro expansion inside string-like contexts
(WGSL has none) and no token pasting.

Module caching: the resolved source for a given `(entryFile, defines)` pair is cached in a
`Map`, and the resulting `GPUShaderModule` in a second `Map` keyed by a FNV-1a 64-bit hash
of the final source string. In dev mode (`?dev=1`), a 500 ms poll re-fetches changed files
and invalidates the caches, giving hot shader reload with no bundler.

WebGPU exposes no pipeline binary cache, so first-run compilation cost is paid every session.
Mitigation: the "core 42" pipelines are created with `createRenderPipelineAsync` in parallel
during the procedural world generation (which takes 2-4 s anyway), so compilation is hidden.

### K.2 Directory layout

```
/src/render/shaders/
  common/
    precision.wgsl      // f16 typedefs (h4/h3/h1), HALF macros, #requires shader-f16 guards
    math.wgsl           // PI, INV_PI, saturate, pow5, safeNormalize, quat ops,
                        //   rotation from quat, tangent frame, remap, luminance,
                        //   sRGB<->linear, YCoCg<->RGB, hash/pcg, interleaved gradient noise
    encode.wgsl         // octEncode/octDecode, packUnorm/snorm helpers, R11G11B10 pack,
                        //   depth<->linear, motion vector encode, normal-roughness pack
    frame.wgsl          // struct Frame + @group(0) declarations for the WHOLE group 0
    material.wgsl       // struct Material, MAT_* flag constants, material sampling helpers
    brdf.wgsl           // SurfaceCtx, D/V/F, envBRDFApprox, energy compensation, evalBRDF,
                        //   anisotropic + clearcoat variants
    lighting.wgsl       // cluster lookup, punctual eval loop, sun/moon eval, ambient eval,
                        //   specular occlusion, contact shadow
    shadow.wgsl         // cascade select, normal offset, PCF/PCSS kernels,
                        //   underwaterShadowStrength
    water.wgsl          // extinction, phase, Snell, in-scatter, applyMedium, caustics lookup
    sky.wgsl            // sky LUT sampling, aerial perspective, sun/moon disc, star field
    noise.wgsl          // value/simplex/worley/curl/fbm/domain-warp (shared by gen/ and runtime)
    triplanar.wgsl      // weights, UVs, normal blend, height blend
    fullscreen.wgsl     // the standard 3-vertex fullscreen triangle vertex shader
    debug.wgsl          // debug view modes, colour ramps, text-free numeric readout
  pass/
    prepass.wgsl  forward.wgsl  shadow_depth.wgsl  sky_render.wgsl
    ocean_surface.wgsl  transparent.wgsl  particles.wgsl  canopy.wgsl  decal.wgsl
    hiz.wgsl  gtao.wgsl  ssr.wgsl  taa.wgsl  bloom.wgsl  composite.wgsl
    motion_blur.wgsl  lens_water.wgsl  histogram.wgsl  ui.wgsl
  compute/
    ocean_spectrum.wgsl  ocean_fft.wgsl  ocean_assemble.wgsl
    froxel_inject.wgsl  froxel_integrate.wgsl  cloud_march.wgsl
    light_cull.wgsl  gpu_cull.wgsl  skinning.wgsl  boids.wgsl  particles_update.wgsl
    terrain_mc.wgsl  caustics.wgsl  sky_lut.wgsl  env_prefilter.wgsl
    sky_visibility.wgsl  mipgen.wgsl  sort_bitonic.wgsl
  gen/
    tex_terrain.wgsl  tex_organic.wgsl  tex_hardsurface.wgsl
    tex_detail.wgsl  tex_bluenoise.wgsl  tex_cloud_noise.wgsl  lut_grade.wgsl
```

### K.3 Naming conventions (binding)

| Kind | Convention | Example |
|---|---|---|
| File | `snake_case.wgsl` | `ocean_surface.wgsl` |
| Struct | `PascalCase` | `SurfaceCtx`, `PunctualLight` |
| Function | `camelCase`; math primitives named after the literature (`D_GGX`, `V_Smith...`, `F_Schlick`, `Fd_Burley`) keep the underscore convention | `evalBRDF`, `D_GGX` |
| Constant | `SCREAMING_SNAKE` | `MAX_LIGHTS_PER_CLUSTER` |
| Macro / define | `SCREAMING_SNAKE` | `DIFFUSE_BURLEY`, `TIGHT_BINDINGS` |
| Texture binding | `t_` prefix | `t_shadowCascades` |
| Sampler binding | `samp_` prefix | `samp_linearClamp` |
| Storage buffer binding | `s_` prefix | `s_lightIndices` |
| Uniform binding | bare lowercase noun | `frame`, `pass`, `draw`, `shadowU` |
| Vertex entry point | `vs_main` (or `vs_<variant>`) | `vs_instanced` |
| Fragment entry point | `fs_main` (or `fs_<variant>`) | `fs_alphaTest` |
| Compute entry point | `cs_main` (or `cs_<stage>`) | `cs_horizontal` |
| Varying struct | `VsOut` | |
| World-space vector | suffix `W` | `sunDirW` |
| View-space vector | suffix `V` | `posV` |
| Tangent-space vector | suffix `T` | `normalT` |
| Screen/UV | `uv`, `fragCoord`, `ndc` | |

Additional rules:
- Every function that can divide by a user value must clamp the denominator with an explicit
  `max(x, EPS)`; bare `/` by a potentially-zero value is a review rejection.
- No `textureSample` in non-uniform control flow -- use `textureSampleLevel` or hoist the
  sample. This is a WGSL validation error, so it is caught, but authors must structure code
  so that gradients are available.
- `saturate` is our own (`clamp(x, 0.0, 1.0)`) in `math.wgsl`; do not open-code it.
- All loops over lights, cascades, or samples use `let` upper bounds derived from
  compile-time constants where possible so the compiler can unroll.
- Group 0 is declared **once**, in `common/frame.wgsl`. No other file may declare a
  `@group(0)` binding. Files that do not use the whole group still include the header;
  unused bindings are stripped by the WGSL compiler's dead-code pass but must still be
  present in the pipeline layout (which is why the layout is a single shared
  `GPUBindGroupLayout` object created once).

### K.4 Pipeline layout objects

Exactly five `GPUPipelineLayout` objects exist:

| Name | Groups | Used by |
|---|---|---|
| `PL_MATERIAL` | 0 frame, 1 pass, 2 material-set, 3 draw | prepass, forward*, shadow, transparent, decal, canopy |
| `PL_FULLSCREEN` | 0 frame, 1 pass | sky, volumetric_apply, cloud_composite, composite, ui-less post |
| `PL_COMPUTE_SIM` | 0 frame, 1 pass | ocean, particles, boids, skinning, terrain, cull |
| `PL_COMPUTE_POST` | 0 frame, 1 pass | hiz, gtao, ssr, taa, bloom, froxel, histogram, mipgen |
| `PL_UI` | 1 pass only (no frame group) | ui_hud, loading screen |

Creating a pipeline with an implicit ("auto") layout is forbidden -- it defeats bind-group
sharing and makes the resource budget unverifiable.

---

## L. DEBUG & VALIDATION SURFACE

The renderer exposes a debug mode selector (`F3` cycles, or `?debug=N`), implemented as a
`#define`-free uniform branch in `composite.wgsl` (so it costs nothing when mode 0):

| Mode | View |
|---|---|
| 0 | Final image |
| 1 | Base colour |
| 2 | World normal |
| 3 | Perceptual roughness |
| 4 | Metallic |
| 5 | AO (GTAO x sky visibility) |
| 6 | Linear depth (log-scaled ramp) |
| 7 | Motion vectors (hue = direction, value = magnitude) |
| 8 | Cluster light count (0 = black, 64 = red) |
| 9 | Cascade index (4 flat colours) |
| 10 | Shadow term only |
| 11 | Froxel in-scatter only |
| 12 | Froxel transmittance only |
| 13 | Water optical depth (per-channel, false-colour) |
| 14 | SSR confidence |
| 15 | TAA history weight |
| 16 | TAA clip rate (running average) |
| 17 | Overdraw (prepass rejects vs. shaded) |
| 18 | Triangle density heat map |
| 19 | Exposure histogram overlay |
| 20 | Wireframe (line-list re-render of the visible batches) |
| 21 | LOD level (terrain + instances) |
| 22 | Material index (hashed to colour) |
| 23 | Wetness |

Validation gates that must pass in CI before any renderer PR merges:

1. `test/frame_layout.test.js` -- every offset in Section G.2 matches the JS writer.
2. `test/binding_budget.test.js` -- parses every `.wgsl` file, counts bindings per group per
   stage, and asserts the table in G.5.
3. `test/shader_compile.test.js` -- creates every pipeline permutation on a headless device
   and asserts zero compilation messages of severity `error`; warnings are printed.
4. `test/perf_scene.js` -- the reference scene (shallow reef at dawn, 640 instances, 96
   creatures, sea state 3, 210 lights) must render under 15.0 ms GPU on the reference
   machine.
5. `test/determinism.test.js` -- two renders of the same frame with the same seed and the
   same jitter index must be bit-identical (this catches uninitialised buffers).

---

## M. OPEN INTERFACES REQUIRED FROM OTHER SECTIONS

These are the exact things the renderer needs handed to it. Sections that own them must
match these shapes.

| Provider | Interface | Shape |
|---|---|---|
| World / terrain | Chunk mesh | `PackedVertex[]` + `u32[]` indices + a `ChunkMeta` (AABB, LOD, material layer indices) |
| World / terrain | Coarse SDF | `r16float` 128^3 covering 1024x512x1024 m, updated as the player moves |
| World / biomes | Water medium | `sigma_a`, `sigma_s`, `g`, deep tint, per biome, blended over 60 m |
| World / biomes | Grade LUT | 32x32x32 `rgba8unorm`, two slots, cross-fade weight |
| World / biomes | AgX look | slope, offset, power, saturation (4 floats) |
| Creatures | Skinned mesh | rest-pose `PackedVertex[]`, `array<vec2u>` bone indices/weights, bone matrices per frame |
| Creatures | Bioluminescence | emissive material index + optional virtual point light registration |
| Vessel | Lights | up to 6 spot definitions in `PunctualLight` form; 1-2 may be shadowed |
| Vessel | HUD | a mesh in canopy-local space with emissive-only materials, drawn in pass 5.14 |
| Day/night | Sun/moon | direction, illuminance, angular radius, phase -- written into `Frame` |
| Weather | Cloud coverage, precipitation, wind, sea state | written into `Frame.weather`, `Frame.wind`, `Frame.waterSurface.w` |
| Audio | (none) | The renderer publishes `exposure` and `cameraDepthBelowSurface` for audio filtering |

---

## N. CHANGE CONTROL

Changing any of the following requires a version bump of this document and a review by the
renderer owner: the `Frame` struct, the `Material` struct, the `PunctualLight` struct, the
bind group layouts, the pass order, the per-pass ms budgets, the coordinate/depth
conventions. Everything else (kernel sizes, tier thresholds, default constants) may be tuned
freely as long as the budgets in Section J still hold.
