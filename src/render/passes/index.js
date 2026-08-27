/**
 * SUBWAVE frame composition.
 *
 * THIS FILE IS THE FRAME. The order below is the order the GPU executes, and it
 * is the single most important piece of documentation in the renderer - if you
 * want to know what a SUBWAVE frame is, read this list.
 *
 * Ordering constraints that are NOT obvious and must not be casually changed:
 *
 *   - Sky is drawn AFTER opaque geometry, not before. Drawing it first wastes
 *     fill on every pixel the terrain later covers; drawn after with a depth
 *     test it only touches pixels nothing else claimed.
 *   - sceneOpaque is copied BEFORE the ocean surface, because the surface
 *     refracts it. A surface cannot refract itself.
 *   - The ocean surface is drawn BEFORE the underwater composite, so that when
 *     the camera is submerged the surface (seen from below, with Snell's
 *     window) is itself fogged by the water between it and the eye.
 *   - Volumetrics are PRODUCED early, right after light culling, and consumed
 *     late. The froxel volume is a compute pass with no attachment dependency
 *     on the geometry, and its consumers straddle the geometry: the opaque
 *     shaders composite it themselves in air, while from below the underwater
 *     composite adds it once for the whole frame. It has to follow the shadow
 *     atlas, the caustics tile and the cluster lists, all of which it samples.
 *   - TAA runs before tonemapping. Resolving in HDR avoids the tonemapper
 *     baking different exposures into the history buffer.
 *   - The HUD composites after tonemapping, because it is emissive UI on glass
 *     and must not be tonemapped along with the scene.
 */

import { profiler } from '../../core/profiler.js';
import { colorAttachment, depthAttachment } from '../../core/pipelines.js';
import { settings } from '../../core/settings.js';
import { makeClusterPass } from './clusters.js';

/**
 * Register every pass on the renderer's frame graph, in execution order.
 *
 * @param {import('../renderer.js').Renderer} renderer
 * @param {object} game the Game instance, for the systems each pass needs
 */
export function registerPasses(renderer, game) {
  const g = renderer.graph;

  // ---- simulation / precompute (compute passes, no attachments) ----------
  g.add(makeClearPass(renderer));

  if (game.sky?.makePasses) {
    for (const p of game.sky.makePasses()) g.add(p);
  }
  if (game.ocean?.makePasses) {
    for (const p of game.ocean.makePasses()) g.add(p);
  }
  if (game.ocean?.makeCausticsPass) {
    g.add(game.ocean.makeCausticsPass());
  }

  // ---- shadows -----------------------------------------------------------
  if (game.shadows?.makePass) g.add(game.shadows.makePass());

  // ---- light culling -----------------------------------------------------
  // Must run after every system has submitted its lights for the frame and
  // before anything shades, since shading walks the cluster lists this builds.
  g.add(makeClusterPass(renderer));

  // ---- volumetrics -------------------------------------------------------
  // HERE, and not down beside the underwater composite where the hook used to
  // be. It is a compute pass with no attachment dependency on the geometry, and
  // its consumers are on BOTH sides of the geometry: the terrain, entity,
  // scatter and creature fragment shaders composite it in air, and the
  // underwater composite does it for the whole frame from below. Placed after
  // `underwater` it would have been too late for every one of the first four.
  //
  // It must run AFTER `shadow` (it takes a cascade tap per froxel), AFTER
  // `caustics` (the shafts are the refracting surface's own irradiance ratio)
  // and AFTER `clusterCull` (it walks the cluster light lists). All three are
  // above.
  if (game.volumetricsPass) g.add(game.volumetricsPass);

  // ---- opaque geometry ---------------------------------------------------
  // Scatter goes AFTER the terrain and the vessel, not before: it is by far the
  // most fragment-hungry opaque pass (thin blades, high instance counts, a
  // translucency evaluation per pixel) and every one of its fragments that the
  // seabed or the hull already occludes is rejected by the depth test for free.
  if (game.terrainPass) g.add(game.terrainPass);
  // Cave chunks right behind the terrain: the two are one ground (the terrain
  // pass discards inside the cave-mouth discs and this pass backs them), and
  // drawing the caves second lets the seabed's depth reject most of a cave's
  // fragments for free - from outside, almost all of a cave is behind rock.
  if (game.cavesPass) g.add(game.cavesPass);
  if (game.entitiesPass) g.add(game.entitiesPass);
  // Creatures before scatter for the same depth-rejection reason, and after the
  // vessel because a fish inside the cockpit glass is a fish the hull already
  // occludes. The pass opens its own COMPUTE pass first, to solve the skeletons,
  // then its render pass - both inside one execute(), because the two are a
  // producer/consumer pair that nothing else may come between.
  if (game.creaturePass) g.add(game.creaturePass);
  if (game.scatterPass) g.add(game.scatterPass);

  // ---- screen-space ambient occlusion ------------------------------------
  // After the LAST opaque depth writer (scatter) so the half-res AO estimate
  // sees every occluder, and BEFORE the sky and copyOpaque: the apply half
  // multiplies sceneColor in place, so the ocean surface refracts an AO'd
  // seabed and the underwater composite attenuates an AO'd surface - AO is a
  // property of surface radiance and must precede the medium, which is applied
  // exactly once, downstream. Sky and cloud pixels are untouched twice over:
  // their aoGate is the clear's zero AND they are drawn after this runs.
  if (game.ssaoPass) g.add(game.ssaoPass);

  // ---- sky (fills only unwritten depth) ----------------------------------
  if (game.skyPass) g.add(game.skyPass);
  if (game.cloudsPass) g.add(game.cloudsPass);

  // ---- copy opaque for refraction ----------------------------------------
  g.add(makeCopyOpaquePass(renderer));

  // ---- water surface -----------------------------------------------------
  if (game.oceanPass) g.add(game.oceanPass);

  // ---- underwater medium -------------------------------------------------
  if (game.underwaterPass) g.add(game.underwaterPass);

  // ---- transparents ------------------------------------------------------
  // HABITAT GLAZING IS DRAWN HERE AND NOT IN `entities`, and the reason is the
  // list above it: creatures, scatter, sky, clouds and the ocean surface all
  // draw between the entity pass and this point, and a pane that writes no depth
  // is overwritten by every one of them - on exactly the pixels it exists to be
  // seen against. After the composite is also the only place it can own the
  // medium in front of itself and nothing else. See makeGlazingPass.
  //
  // BEFORE `glow`: an emitter between the eye and the station must not be tinted
  // by a pane behind it, and that is much more common than the reverse.
  if (game.glazingPass) g.add(game.glazingPass);
  if (game.particlesPass) g.add(game.particlesPass);

  // ---- post chain --------------------------------------------------------
  if (game.postPasses) {
    for (const p of game.postPasses) g.add(p);
  }

  // ---- UI ----------------------------------------------------------------
  if (game.hudPass) g.add(game.hudPass);

  // ---- present -----------------------------------------------------------
  g.add(makePresentPass(renderer));

  // A pass that is simply absent from `game` produces no error anywhere - the
  // frame just quietly renders without it, which is how an entire terrain pass
  // can go missing and present only as a black screen. Name the ones that must
  // exist for the frame to mean anything.
  const REQUIRED = ['terrain', 'ocean', 'underwater', 'sky', 'entities', 'scatter',
    'creatures', 'shadow', 'volumetrics'];
  const present = new Set(g.passes.map((p) => p.name));
  const missing = REQUIRED.filter((n) => ![...present].some((p) => p.startsWith(n)));
  if (missing.length) {
    console.error(
      `[frameGraph] MISSING PASSES: ${missing.join(', ')}.\n` +
      '  registerPasses() reads these off the game object by name; an unset ' +
      'field is an absent pass, not an error. Check that main.js constructed them.');
  }

  return g;
}

/**
 * Clears the scene targets at the top of the frame.
 *
 * Reverse-Z means depth clears to 0.0 (the far plane), which is the opposite of
 * what most engines do - DEPTH_CLEAR_VALUE in pipelines.js is the single source
 * of truth for that and every pass should use depthAttachment() rather than
 * writing the value by hand.
 */
function makeClearPass(renderer) {
  return {
    name: 'clear',
    type: 'render',
    writes: ['sceneColor', 'sceneDepth', 'velocity', 'dryPath', 'aoGate'],
    execute(ctx, encoder) {
      const pass = encoder.beginRenderPass(profiler.gpuPass({
        label: 'clear',
        colorAttachments: [
          colorAttachment(ctx.targets.view('sceneColor'), { clear: { r: 0, g: 0, b: 0, a: 1 } }),
          colorAttachment(ctx.targets.view('velocity'), { clear: { r: 0, g: 0, b: 0, a: 0 } }),
          // ZERO means "the whole view ray is water", which is the right answer
          // for every pixel of every frame that does not contain the station.
          // Only the entity pass writes it; see the dryPath declaration in
          // render/renderer.js for the encoding.
          colorAttachment(ctx.targets.view('dryPath'), { clear: { r: 0, g: 0, b: 0, a: 0 } }),
          // ZERO means "no ambient share here", so a pixel no geometry pass
          // claims - sky, clouds, the ocean surface - takes no AO. See the
          // aoGate declaration in render/renderer.js.
          colorAttachment(ctx.targets.view('aoGate'), { clear: { r: 0, g: 0, b: 0, a: 0 } }),
        ],
        depthStencilAttachment: depthAttachment(ctx.targets.view('sceneDepth'), { clear: true }),
      }, 'clear'));
      pass.end();
    },
  };
}

/**
 * Snapshot the opaque scene so the water surface can refract it.
 *
 * A texture cannot be sampled and rendered to in the same pass, so this is a
 * genuine copy rather than a rebind. It costs a full-resolution rgba16float
 * blit (~0.15 ms at 1080p) which is cheap next to what refraction buys.
 */
function makeCopyOpaquePass(renderer) {
  return {
    name: 'copyOpaque',
    type: 'render',
    reads: ['sceneColor', 'sceneDepth'],
    writes: ['sceneOpaque', 'sceneDepthOpaque'],
    execute(ctx, encoder) {
      const size = { width: ctx.width, height: ctx.height, depthOrArrayLayers: 1 };
      encoder.copyTextureToTexture(
        { texture: ctx.targets.texture('sceneColor') },
        { texture: ctx.targets.texture('sceneOpaque') },
        size,
      );
      // DEPTH TOO, and it is the half that is easy to forget. The ocean surface
      // writes its own depth in a prepass before it shades, so by the time the
      // water fragment wants to know how deep the seabed is, sceneDepth is the
      // water. Without this snapshot the water column measures zero everywhere
      // and the sea renders as an unmodified window onto whatever is behind it.
      encoder.copyTextureToTexture(
        { texture: ctx.targets.texture('sceneDepth') },
        { texture: ctx.targets.texture('sceneDepthOpaque') },
        size,
      );
    },
  };
}

/**
 * Final blit from the internal render target to the swap chain.
 *
 * The internal target may be a different resolution than the backbuffer
 * (renderScale), so this is where upscaling happens. A copy is only valid when
 * the sizes and formats match exactly; otherwise we need a filtered draw, which
 * the post chain's final tonemap pass normally handles by writing straight to
 * the swap chain. This pass exists as the fallback for when the post chain is
 * disabled entirely (debug views, or a tier with no post).
 */
function makePresentPass(renderer) {
  let pipeline = null;
  let bindGroupLayout = null;

  return {
    name: 'present',
    type: 'render',
    reads: ['sceneColor'],

    enabled(ctx) {
      // The post chain writes the swap chain itself when it is running.
      return !ctx.renderer._postWritesSwapChain;
    },

    init(ctx) {
      const module = ctx.shaders.module('pass/present.wgsl', {}, 'present');
      bindGroupLayout = ctx.pipelines.bindGroupLayout('present.bgl', [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ]);
      pipeline = ctx.pipelines.renderPipeline({
        label: 'present',
        layout: ctx.pipelines.pipelineLayout('present.pl', [bindGroupLayout]),
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: {
          module, entryPoint: 'fs_present',
          targets: [{ format: ctx.gpu.presentFormat }],
        },
        primitive: { topology: 'triangle-list' },
      });
    },

    execute(ctx, encoder) {
      if (!pipeline) return;
      const bg = ctx.device.createBindGroup({
        label: 'present.bg',
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: ctx.targets.view('sceneColor') },
          { binding: 1, resource: ctx.samplers.linearClamp },
        ],
      });
      const pass = encoder.beginRenderPass(profiler.gpuPass({
        label: 'present',
        colorAttachments: [colorAttachment(ctx.outputView, { clear: { r: 0, g: 0, b: 0, a: 1 } })],
      }, 'present'));
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bg);
      pass.draw(3);
      pass.end();
    },
  };
}
