/**
 * GENERATED FILE - do not edit.
 * Regenerate with: node tools/gen-shader-manifest.mjs
 *
 * The browser cannot list a directory, so the shader library is told explicitly
 * what to fetch at boot. tools/check.mjs fails if this drifts from disk.
 */

/** Every .wgsl file in the project, including headers. */
export const SHADER_FILES = [
  'common/atmosphere.wgsl',
  'common/brdf.wgsl',
  'common/frame.wgsl',
  'common/fullscreen.wgsl',
  'common/lighting.wgsl',
  'common/math.wgsl',
  'common/noise.wgsl',
  'common/ocean.wgsl',
  'common/shadow.wgsl',
  'common/triplanar.wgsl',
  'common/water.wgsl',
  'pass/bloom.wgsl',
  'pass/cave.wgsl',
  'pass/clouds.wgsl',
  'pass/creature.wgsl',
  'pass/entity.wgsl',
  'pass/exposure.wgsl',
  'pass/glow.wgsl',
  'pass/hud.wgsl',
  'pass/lens.wgsl',
  'pass/ocean_surface.wgsl',
  'pass/present.wgsl',
  'pass/scatter.wgsl',
  'pass/sky_render.wgsl',
  'pass/ssao.wgsl',
  'pass/taa.wgsl',
  'pass/terrain.wgsl',
  'pass/tonemap.wgsl',
  'pass/underwater.wgsl',
  'sim/caustics.wgsl',
  'sim/caustics_mip.wgsl',
  'sim/cluster_cull.wgsl',
  'sim/froxel_inject.wgsl',
  'sim/froxel_integrate.wgsl',
  'sim/ocean_fft.wgsl',
  'sim/ocean_foam.wgsl',
  'sim/ocean_spectrum.wgsl',
  'sim/sky_multiscatter.wgsl',
  'sim/sky_transmittance.wgsl',
  'sim/sky_view.wgsl'
];

/** The subset that declares a @vertex, @fragment or @compute entry point. */
export const SHADER_ENTRY_POINTS = [
  'common/fullscreen.wgsl',
  'pass/bloom.wgsl',
  'pass/cave.wgsl',
  'pass/clouds.wgsl',
  'pass/creature.wgsl',
  'pass/entity.wgsl',
  'pass/exposure.wgsl',
  'pass/glow.wgsl',
  'pass/hud.wgsl',
  'pass/lens.wgsl',
  'pass/ocean_surface.wgsl',
  'pass/present.wgsl',
  'pass/scatter.wgsl',
  'pass/sky_render.wgsl',
  'pass/ssao.wgsl',
  'pass/taa.wgsl',
  'pass/terrain.wgsl',
  'pass/tonemap.wgsl',
  'pass/underwater.wgsl',
  'sim/caustics.wgsl',
  'sim/caustics_mip.wgsl',
  'sim/cluster_cull.wgsl',
  'sim/froxel_inject.wgsl',
  'sim/froxel_integrate.wgsl',
  'sim/ocean_fft.wgsl',
  'sim/ocean_foam.wgsl',
  'sim/ocean_spectrum.wgsl',
  'sim/sky_multiscatter.wgsl',
  'sim/sky_transmittance.wgsl',
  'sim/sky_view.wgsl'
];
