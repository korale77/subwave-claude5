/**
 * SUBWAVE entity pass.
 *
 * Draws the vessel - and, when they exist, creatures and props - into
 * sceneColor, sceneDepth and velocity, immediately after the terrain and
 * before the sky, so the sky only pays for the pixels nothing else claimed.
 *
 * ONE DRAW PER PART, NOT PER OBJECT. The Kestrel is eleven parts across ten
 * animated nodes: the hull, the canopy, the skids, and a duct plus a rotor for
 * each of the four nacelles. Each node has its own transform, so each needs its
 * own model matrix, and merging them would mean re-skinning the whole mesh on
 * the CPU every frame to move a nacelle by two degrees. Eleven draws against
 * one vertex buffer and one index buffer costs a few microseconds of encode
 * time and buys correct articulation and correct per-node motion vectors.
 *
 * Instancing is set up but unused for the vessel, because there is exactly one
 * of it. The same pipeline and the same per-draw block will carry creature
 * schools, where instancing does pay.
 *
 * REBASING. Node matrices are computed in absolute world space by the vessel;
 * this pass subtracts the camera's current origin from the translation column
 * of BOTH the current and the previous matrix before upload. Using the current
 * origin for the previous matrix is what stops a rebase frame from producing a
 * screen-wide false motion vector.
 */

import {
  colorAttachment, depthAttachment, Blend, DepthState, Primitive, vertexLayout, GROUP, STAGE,
} from '../../core/pipelines.js';
import { FORMATS } from '../../core/gpu.js';
import { profiler } from '../../core/profiler.js';
import { RENDER, VESSEL_LIGHTS } from '../../core/constants.js';
import { clamp } from '../../core/math.js';
import { settings } from '../../core/settings.js';
import { kelvinToLinearRGB } from '../../entities/vessel.js';
import { VESSEL_VERTEX_STRIDE, VESSEL_MATERIAL } from '../../entities/vessel_mesh.js';
import { HABITAT_MATERIAL } from '../../entities/habitat_mesh.js';

/**
 * True for a habitat surface that lives inside a sealed pressure volume.
 *
 * Drives `EntityUniform.params.w` above 1.5, which entity.wgsl reads as
 * `dryInteriorSurface` and uses to skip the caustic term, the water medium and
 * the aerial froxel. The inboard glazing face is in here because the pane the
 * player looks at from the commons is dry on their side; the OUTBOARD face is
 * not, because it is genuinely 33 m under water.
 */
function habitatIsDryInterior(material) {
  return material === VESSEL_MATERIAL.CABIN
    || material === HABITAT_MATERIAL.INTERIOR
    || material === HABITAT_MATERIAL.VIEWPORT
    || material === HABITAT_MATERIAL.SCREEN;
}

/**
 * True for a habitat part drawn as real transparent glazing.
 *
 * The two skins moduleShell() emits are outward-facing GLASS and inward-facing
 * VIEWPORT, so back-face culling means a view direction crosses at most one of
 * them per hull wall and the near one is always the one facing the eye. That is
 * what makes an unsorted alpha blend tractable here; see makeGlazingPass.
 */
export function isHabitatGlazing(material) {
  return material === HABITAT_MATERIAL.GLASS
    || material === HABITAT_MATERIAL.VIEWPORT;
}

/** True for a habitat part that should be rasterised into the shadow atlas. */
function habitatCastsShadow(material) {
  return material !== VESSEL_MATERIAL.CANOPY
    && material !== VESSEL_MATERIAL.EMISSIVE
    && material !== HABITAT_MATERIAL.GLASS
    && material !== HABITAT_MATERIAL.VIEWPORT
    && material !== HABITAT_MATERIAL.INTERIOR
    && material !== HABITAT_MATERIAL.SCREEN;
}

/**
 * Bytes in EntityUniform: two mat4x4f plus three vec4f.
 * Must match `struct EntityUniform` in shaders/pass/entity.wgsl.
 *
 * The third vec4f is the shadow cascade index. It is a PER-DRAW uniform in the
 * ring, not the Frame uniform, so tools/test-layout.mjs does not cover it -
 * init() asserts against the dynamic-offset alignment instead.
 */
const ENTITY_UNIFORM_BYTES = 176;

/** Per-material tint and roughness bias. rgb multiplies albedo, a offsets roughness. */
const MATERIAL_TINT = [
  [1.00, 1.00, 1.00, 0.00],   // hull
  [1.00, 1.00, 1.00, 0.00],   // canopy
  [1.00, 1.00, 1.00, 0.00],   // nacelle
  [1.00, 1.00, 1.00, 0.00],   // rotor
  [1.00, 1.00, 1.00, 0.00],   // skid
  [1.00, 0.86, 0.62, 0.00],   // emissive - overridden per lamp group below
  [1.00, 1.00, 1.00, 0.00],   // cabin
];

/**
 * Emitting area of one lamp lens, m^2.
 *
 * MUST track POD_LENS_R in entities/vessel_mesh.js: emissive RADIANCE is
 * intensity over area, so the number below is half of the conversion from a
 * lamp's candela rating to what the shader adds to the pixel. A lens dome of
 * radius r presents pi*r^2 of projected area on axis.
 */
const LENS_AREA = Math.PI * 0.078 * 0.078;

/**
 * Per-light-group lens radiance and colour.
 *
 * The emissive gain used to be a hard-coded 12.0 for every material-5 part,
 * which is a magic number standing where a radiance belongs: it rendered at
 * 0.34 post-exposure in daylight (below BLOOM_THRESHOLD, so it did not glow at
 * all) and at 82 - blown white - at 118 m. Deriving it from the lamp's own
 * rating makes it correct at both ends with no per-scenario fudge, and it moves
 * with VESSEL_LIGHTS if those are ever retuned. The colour comes from each
 * group's kelvin rather than one shared cream tint, so a 3600 K underside lamp
 * and a 5200 K flood do not render the same.
 */
const LENS = (() => {
  const out = {};
  for (const key of Object.keys(VESSEL_LIGHTS)) {
    const def = VESSEL_LIGHTS[key];
    const c = kelvinToLinearRGB(new Float32Array(3), def.kelvin);
    // Cone terms in the same form Light.direction.w / spotParams.y carry, so
    // the lens's visible beam and the light it actually casts have one shape.
    //
    // `cone` IS THE FULL APEX ANGLE, NOT THE HALF-ANGLE. vessel.js submits it
    // verbatim as `outerAngle` and renderer.addLight halves it, so the lens has to
    // halve it too or it glows over exactly twice the angular width of the beam it
    // is meant to be the source of. The STROBE made the error obvious rather than
    // subtle: at cone 6.28 (a full sphere) cos(6.28) is +0.99998, a pencil-thin
    // cone - precisely inverting an emitter whose whole purpose is to be seen from
    // any bearing, where cos(6.28 * 0.5) is -1.0 and correctly omnidirectional.
    //
    // `coneInner` is now authored per group rather than guessed here. It used to
    // be `cone * 0.7`, chosen to match the default addLight applies when a caller
    // supplies no innerAngle - but vessel.js supplied `cone * 0.62`, so the lens
    // had never drawn the core its own beam had.
    const cosOuter = Math.cos(def.cone * 0.5);
    const cosInner = Math.cos(def.coneInner * 0.5);
    out[def.id] = {
      radiance: def.intensity / LENS_AREA,
      color: c,
      cosOuter,
      invCosDelta: 1 / Math.max(cosInner - cosOuter, 1e-4),
    };
  }
  return out;
})();

/**
 * Seconds for a hull lifted out of the water to stop reading as wet.
 *
 * The wet sheen used to key on the fragment's ABSOLUTE height, reaching zero
 * only at y = 1.818 m - so a beach the generator happened to put below that
 * would have rendered a bone-dry hull 28% darker with its roughness cut from
 * 0.36 to 0.16, forever. The quantity is time since submersion, so it is
 * tracked here from the vessel's own submerged fraction and handed to the
 * shader in EntityUniform.shadow.y.
 */
const WET_DRY_TAU = 26.0;

/**
 * Build the entity frame-graph pass.
 *
 * @param {import('../renderer.js').Renderer} renderer
 * @param {object} game the Game instance; `game.vessel` is read every frame
 * @returns {object} a FrameGraph pass
 */
export function makeEntitiesPass(renderer, game) {
  let pipeline = null;
  let dryPathPipeline = null;
  let shadowPipeline = null;
  let entityLayout = null;
  let entityBindGroup = null;
  let boundRing = null;

  /**
   * Write one habitat part's EntityUniform block and issue its draw.
   *
   * Shared by the opaque loop, the dryPath prepass and the glazing pass, so a
   * part cannot be described one way in one of them and another way in the next
   * - which matters most for the dry flag, since the three passes disagreeing
   * about which side of a pane is dry is precisely the fault the whole dryPath
   * encoding exists to remove.
   */
  function writeHabitatBlock(ctx, part, model, prevModel, pass) {
    const block = ctx.uniforms.alloc(ENTITY_UNIFORM_BYTES);
    const f = block.f32;
    f.set(model, 0); f.set(prevModel, 16);
    f[32] = part.material; f[33] = 0; f[34] = part.emission || 0;
    // Values above one are reserved for sealed habitat surfaces. They keep the
    // room dry in the entity shader - no caustics, and no water medium WHEN THE
    // EYE IS IN THE SAME ROOM - without changing the submerged treatment of the
    // exterior modules. EVERY surface a player can see from inside belongs here,
    // which is the interior skin, the inboard face of the glazing and the
    // furniture; missing one fogs a dry wall with 33 m of water that is not
    // between it and the eye.
    const dry = habitatIsDryInterior(part.material);
    f[35] = dry ? 2 : 1;
    const tint = part.tint || MATERIAL_TINT[part.material] || MATERIAL_TINT[0];
    f[36] = tint[0]; f[37] = tint[1]; f[38] = tint[2]; f[39] = tint[3] || 0;
    // WETNESS IS A PROPERTY OF THE SURFACE, NOT OF THE OBSERVER, and this used
    // to be `camera.isUnderwater ? 1 : 0` for every part of the station at once.
    // Two faults in one expression. The building is permanently submerged -
    // test-habitat.mjs section 6 asserts its apex sits below -8 m - so its
    // exterior flipping to DRY the moment a player stepped inside (albedo x1.39,
    // roughness 0.18 -> 0.42) was simply wrong; and the same flag sheeted the
    // DRY ROOMS whenever a swimmer outside was submerged, applying albedo x0.72
    // and roughness x0.35 + 0.03 to a wall in a pressurised cabin. That second
    // half was invisible only while the glazing was opaque - with a window that
    // transmits, the warm room seen from outside would be 28% darker and glossy
    // plastic.
    f[41] = dry ? 0 : 1;
    f[42] = -1; f[43] = 1;
    _offsetScratch[0] = block.offset;
    pass.setBindGroup(GROUP.PASS, entityBindGroup, _offsetScratch);
    pass.drawIndexed(part.indexCount, 1, part.firstIndex, 0, 0);
  }

  const layout = vertexLayout([
    [0, 'float32x3'],   // position, body space
    [1, 'float32x3'],   // normal
    [2, 'float32x4'],   // tangent + bitangent sign
    [3, 'float32x2'],   // uv
  ]);

  // Same buffer, same stride, position only. See terrain.js for why this is not
  // built with vertexLayout().
  const shadowLayout = {
    arrayStride: VESSEL_VERTEX_STRIDE,
    stepMode: 'vertex',
    attributes: [{ shaderLocation: 0, format: 'float32x3', offset: 0 }],
  };

  /** Per-cascade: does the vessel cast into it this frame? */
  const casts = new Array(RENDER.SHADOW_CASCADES).fill(false);
  const habitatCasts = new Array(RENDER.SHADOW_CASCADES).fill(false);

  // Scratch for the rebased matrices. Reused every draw so the encode loop
  // allocates nothing.
  const model = new Float32Array(16);
  const prevModel = new Float32Array(16);

  /** Hull wetness, 0..1. See WET_DRY_TAU. */
  let wetness = 0;

  return {
    name: 'entities',
    type: 'render',
    writes: ['sceneColor', 'sceneDepth', 'velocity', 'dryPath', 'aoGate'],
    // Shadow atlas, caustics and the sky LUTs all live in bind group 0, which
    // is bound for the whole frame; declaring them as reads here would make the
    // graph validator demand a producer even on tiers that switch them off.
    reads: [],

    enabled() {
      return !!(game.vessel?.gpu || game.habitat?.gpu);
    },

    init(ctx) {
      if (layout.arrayStride !== VESSEL_VERTEX_STRIDE) {
        throw new Error(
          `[entities] vertex layout is ${layout.arrayStride} bytes but the mesh ` +
          `generator emits ${VESSEL_VERTEX_STRIDE}. They have drifted apart.`);
      }

      const module = ctx.shaders.module('pass/entity.wgsl', {}, 'entity');

      entityLayout = ctx.pipelines.bindGroupLayout('entity.bgl', [{
        binding: 0,
        visibility: STAGE.VF,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: ENTITY_UNIFORM_BYTES },
      }]);

      pipeline = ctx.pipelines.renderPipeline({
        label: 'entity',
        layout: ctx.pipelines.pipelineLayout('entity.pl', [renderer.frameLayout, entityLayout]),
        vertex: { module, entryPoint: 'vs_entity', buffers: [layout] },
        fragment: {
          module,
          entryPoint: 'fs_entity',
          targets: [
            { format: FORMATS.hdr },
            { format: FORMATS.velocity },
            // dryPath, REPLACED here. The opaque draws own the far end of the
            // ray, so each one states the total by itself; the glazing pipeline
            // below ADDS its crossings to whatever this left. That is why the
            // two loops in execute() cannot be merged - habitat_mesh.js emits
            // `room` after `pane`, so one interleaved loop would let a replace
            // wipe a sum that had already been accumulated.
            { format: FORMATS.r16f },
            // The SSAO gate - see FragOut.gate in pass/entity.wgsl.
            { format: FORMATS.r8 },
          ],
        },
        // Back-face culling is also what hides the exterior from the cockpit
        // camera: the eye sits inside the hull and inside the canopy, so both
        // present only their back faces and vanish without a special case.
        primitive: Primitive.triangles,
        depthStencil: DepthState.opaque(FORMATS.depth),
      });

      // THE GLAZING'S HULL CROSSING, and nothing else - see FragOut.dryPath in
      // pass/entity.wgsl. Depth-tested but not depth-writing, because a pane
      // must not occlude what is behind it; additive on dryPath, because the
      // layers are then unordered and only a sum is order-independent.
      dryPathPipeline = ctx.pipelines.renderPipeline({
        label: 'entity.drypath',
        layout: ctx.pipelines.pipelineLayout('entity.pl', [renderer.frameLayout, entityLayout]),
        vertex: { module, entryPoint: 'vs_entity', buffers: [layout] },
        fragment: {
          module,
          entryPoint: 'fs_entity_drypath',
          targets: [
            { format: FORMATS.hdr, writeMask: 0 },
            { format: FORMATS.velocity, writeMask: 0 },
            { format: FORMATS.r16f, blend: Blend.additive },
            // A crossing is not a surface; the gate stays whatever the opaque
            // draw behind the pane wrote.
            { format: FORMATS.r8, writeMask: 0 },
          ],
        },
        primitive: Primitive.triangles,
        depthStencil: DepthState.testNoWrite(FORMATS.depth),
      });

      // Depth only, no fragment stage, no hardware depth bias - shadow.wgsl owns
      // the whole bias budget on the receiver side.
      shadowPipeline = ctx.pipelines.renderPipeline({
        label: 'entity.shadow',
        layout: ctx.pipelines.pipelineLayout('entity.shadow.pl',
          [renderer.shadowCasterLayout, entityLayout]),
        vertex: { module, entryPoint: 'vs_entity_shadow', buffers: [shadowLayout] },
        primitive: Primitive.triangles,
        depthStencil: DepthState.shadow(FORMATS.shadow, 0, 0, 0),
      });
    },

    /**
     * Decide which cascades the vessel casts into.
     *
     * The test is SPHERE vs CASCADE, not camera.isSphereVisible: cascade 0's
     * sphere reaches 11.6 m behind the eye and far outside the frustum
     * laterally, and a hull the camera cannot see is precisely the one whose
     * shadow it can.
     */
    beginShadowFrame(ctx, shadows) {
      const vessel = game.vessel;
      const habitat = game.habitat;
      const limit = Math.min(shadows.count, RENDER.SHADOW_VESSEL_CASCADES);
      for (let i = 0; i < casts.length; i++) {
        casts[i] = i < limit && !!(vessel && vessel.gpu)
          && shadows.sphereCasts(i, vessel.position, vessel.mesh.boundingRadius);
        habitatCasts[i] = i < shadows.count && !!(habitat && habitat.gpu)
          && shadows.sphereCasts(i, habitat.position, habitat.mesh.boundingRadius);
      }
    },

    /**
     * Draw the vessel into cascade `cascade`.
     * @returns {number} draws issued
     */
    castShadows(ctx, pass, cascade) {
      if (!shadowPipeline || (!casts[cascade] && !habitatCasts[cascade])) return 0;
      const vessel = game.vessel;

      if (entityBindGroup === null || boundRing !== ctx.uniforms.buffer) {
        boundRing = ctx.uniforms.buffer;
        entityBindGroup = ctx.device.createBindGroup({
          label: 'entity.bg',
          layout: entityLayout,
          entries: [{
            binding: 0,
            resource: { buffer: boundRing, offset: 0, size: ENTITY_UNIFORM_BYTES },
          }],
        });
      }

      pass.setPipeline(shadowPipeline);
      pass.setBindGroup(GROUP.FRAME, renderer.shadowCasterGroup);
      const origin = ctx.camera.worldOrigin;
      let draws = 0;

      if (casts[cascade]) {
        pass.setVertexBuffer(0, vessel.gpu.vertexBuffer);
        pass.setIndexBuffer(vessel.gpu.indexBuffer, 'uint32');
        const nodes = vessel.nodeMatrices;
        for (const part of vessel.gpu.parts) {
          const base = part.node * 16;
          model.set(nodes.subarray(base, base + 16));
          model[12] -= origin[0]; model[13] -= origin[1]; model[14] -= origin[2];
          const block = ctx.uniforms.alloc(ENTITY_UNIFORM_BYTES);
          block.f32.set(model, 0);
          block.f32[40] = cascade;
          _offsetScratch[0] = block.offset;
          pass.setBindGroup(GROUP.PASS, entityBindGroup, _offsetScratch);
          pass.drawIndexed(part.indexCount, 1, part.firstIndex, 0, 0);
          draws++;
        }
      }

      if (habitatCasts[cascade]) {
        const habitat = game.habitat;
        pass.setVertexBuffer(0, habitat.gpu.vertexBuffer);
        pass.setIndexBuffer(habitat.gpu.indexBuffer, 'uint32');
        model.set(habitat.modelMatrix);
        model[12] -= origin[0]; model[13] -= origin[1]; model[14] -= origin[2];
        for (const part of habitat.gpu.parts) {
          // Glass and light lenses do not cast an opaque black shadow, and an
          // interior surface is inside a shell that already casts one - letting
          // the commons dome cast would put the room it is meant to light in
          // its own shadow.
          if (!habitatCastsShadow(part.material)) continue;
          const block = ctx.uniforms.alloc(ENTITY_UNIFORM_BYTES);
          block.f32.set(model, 0);
          block.f32[40] = cascade;
          _offsetScratch[0] = block.offset;
          pass.setBindGroup(GROUP.PASS, entityBindGroup, _offsetScratch);
          pass.drawIndexed(part.indexCount, 1, part.firstIndex, 0, 0);
          draws++;
        }
      }
      return draws;
    },

    execute(ctx, encoder) {
      if (!pipeline) return;
      const vessel = game.vessel;
      const habitat = game.habitat;
      const camera = ctx.camera;
      const hideVessel = game.player?.inVessel && vessel?.cameraMode === 'cockpit' &&
        !settings.get('cockpitInterior');
      const vesselVisible = !!(vessel?.gpu) && !hideVessel &&
        camera.isSphereVisible(vessel.position, vessel.mesh.boundingRadius);
      const habitatVisible = !!(habitat?.gpu) &&
        camera.isSphereVisible(habitat.position, habitat.mesh.boundingRadius);
      if (!vesselVisible && !habitatVisible) return;

      // FROM THE COCKPIT, DRAW NO VESSEL AT ALL - not merely no interior.
      //
      // The eye sits inside the hull, so the hull and canopy hide themselves by
      // back-face culling. The NACELLES do not: they are outside the hull, at a
      // measured 54.9 degrees of azimuth against a 57.9 degree horizontal
      // half-FOV, i.e. inside the frame by three degrees. That is why hiding only
      // the coaming brings back the "detached pieces of the vessel floating in
      // mid-air" a playtest reported - the coaming is what occludes them.
      //
      // So the clean full-screen view is the whole vessel skipped for the MAIN
      // camera. castShadows() is a separate entry point driven from the light's
      // point of view, so the hull still casts its shadow on the sea below;
      // applyRender() still runs every frame from _updateCamera, so the node
      // matrices the shadow pass reads are current whether or not this draws.
      if (entityBindGroup === null || boundRing !== ctx.uniforms.buffer) {
        boundRing = ctx.uniforms.buffer;
        entityBindGroup = ctx.device.createBindGroup({
          label: 'entity.bg',
          layout: entityLayout,
          entries: [{
            binding: 0,
            resource: { buffer: boundRing, offset: 0, size: ENTITY_UNIFORM_BYTES },
          }],
        });
      }

      const pass = encoder.beginRenderPass(profiler.gpuPass({
        label: 'entities',
        colorAttachments: [
          colorAttachment(ctx.targets.view('sceneColor'), { loadOp: 'load' }),
          colorAttachment(ctx.targets.view('velocity'), { loadOp: 'load' }),
          // The station is the only thing in the world that writes dryPath, so
          // this pass is the only one that carries the attachment. Other render
          // passes keep their two - WebGPU only requires a pipeline's targets to
          // match the pass it is used in, not across passes.
          colorAttachment(ctx.targets.view('dryPath'), { loadOp: 'load' }),
          colorAttachment(ctx.targets.view('aoGate'), { loadOp: 'load' }),
        ],
        depthStencilAttachment: depthAttachment(ctx.targets.view('sceneDepth'), { clear: false }),
      }, 'entities'));

      pass.setPipeline(pipeline);
      pass.setBindGroup(GROUP.FRAME, ctx.frameBindGroup);
      const origin = camera.worldOrigin;
      const integrity = vessel ? vessel.hull / 100 : 1;
      // Wear drives the biofouling layer. Until the wear accumulator ships it
      // is derived from the damage the hull has actually taken, which is the
      // same story told with the data that exists.
      const wear = Math.min(1, (1 - integrity) * 1.4);

      // Wetting is instantaneous and drying is not, so the submerged fraction
      // sets a floor the exponential decays from. beta is the physical
      // submerged fraction; the latched `underwater` flag is the wrong input
      // here because a hull sheeted by one wave is genuinely wet.
      if (vessel) {
        const beta = Math.max(vessel.beta || 0, vessel.underwater ? 1 : 0);
        wetness = Math.max(beta, wetness - clamp(ctx.dt, 0, 0.5) / WET_DRY_TAU);
        wetness = clamp(wetness, 0, 1);
      }

      // Silent running dims every group to almost nothing; the lens has to
      // follow, or a vessel hiding in the dark still advertises itself.
      const lampScale = vessel?.silentRunning ? 0.09 : 1;

      if (vesselVisible) {
        pass.setVertexBuffer(0, vessel.gpu.vertexBuffer);
        pass.setIndexBuffer(vessel.gpu.indexBuffer, 'uint32');
        const nodes = vessel.nodeMatrices;
        const prevNodes = vessel.prevNodeMatrices;
        const parts = vessel.gpu.parts;
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          const base = part.node * 16;
          model.set(nodes.subarray(base, base + 16));
          prevModel.set(prevNodes.subarray(base, base + 16));
          // Rebase both matrices into camera-relative space with the CURRENT
          // origin, so a rebase frame does not fabricate motion.
          model[12] -= origin[0]; model[13] -= origin[1]; model[14] -= origin[2];
          prevModel[12] -= origin[0]; prevModel[13] -= origin[1]; prevModel[14] -= origin[2];

          const block = ctx.uniforms.alloc(ENTITY_UNIFORM_BYTES);
          const f = block.f32;
          f.set(model, 0);
          f.set(prevModel, 16);
          f[32] = part.material;
          f[33] = wear;
          f[35] = integrity;

          const tint = MATERIAL_TINT[part.material] || MATERIAL_TINT[0];
          f[36] = tint[0]; f[37] = tint[1]; f[38] = tint[2]; f[39] = tint[3];
          f[34] = 0;
          f[42] = -1; f[43] = 1;
          if (part.material === VESSEL_MATERIAL.EMISSIVE) {
            // A lens is dark unless its own group is switched on. The whole point
            // of one part per group is that the vessel can show which lamps are
            // actually running.
            const lens = LENS[part.lightGroup];
            if (lens) {
              f[42] = lens.cosOuter; f[43] = lens.invCosDelta;
              if (vessel.lights && vessel.lights[part.lightGroup]) {
                f[34] = lens.radiance * lampScale;
                f[36] = lens.color[0]; f[37] = lens.color[1]; f[38] = lens.color[2];
              }
            }
          }

          f[41] = wetness;   // EntityUniform.shadow.y

          _offsetScratch[0] = block.offset;
          pass.setBindGroup(GROUP.PASS, entityBindGroup, _offsetScratch);
          // The mesh builder emits GLOBAL vertex indices, so baseVertex is zero
          // and every part indexes straight into the one shared buffer.
          pass.drawIndexed(part.indexCount, 1, part.firstIndex, 0, 0);
        }
      }

      if (habitatVisible) {
        pass.setVertexBuffer(0, habitat.gpu.vertexBuffer);
        pass.setIndexBuffer(habitat.gpu.indexBuffer, 'uint32');
        model.set(habitat.modelMatrix);
        prevModel.set(habitat.prevModelMatrix);
        model[12] -= origin[0]; model[13] -= origin[1]; model[14] -= origin[2];
        prevModel[12] -= origin[0]; prevModel[13] -= origin[1]; prevModel[14] -= origin[2];
        // OPAQUE FIRST, GLAZING SECOND, AND THE ORDER IS NOT COSMETIC. The
        // opaque pipeline REPLACES dryPath and the glazing pipeline ADDS to it,
        // and habitat_mesh.js emits `room` (INTERIOR) after `pane` (VIEWPORT) -
        // so a single interleaved loop would let a replace wipe a sum that had
        // already been accumulated. See FragOut.dryPath in pass/entity.wgsl.
        for (const part of habitat.gpu.parts) {
          if (isHabitatGlazing(part.material)) continue;
          writeHabitatBlock(ctx, part, model, prevModel, pass);
        }
        // The panes contribute their hull crossing here and nothing else - no
        // colour, no depth. Their shading is done by the `glazing` pass, after
        // the underwater composite, because everything between this pass and
        // that one (creatures, scatter, sky, clouds, the ocean surface) would
        // otherwise overwrite a blend that writes no depth, on exactly the
        // pixels a window is meant to be seen against.
        pass.setPipeline(dryPathPipeline);
        for (const part of habitat.gpu.parts) {
          if (!isHabitatGlazing(part.material)) continue;
          writeHabitatBlock(ctx, part, model, prevModel, pass);
        }
      }

      pass.end();
    },
  };
}

// setBindGroup takes an ARRAY of dynamic offsets; allocating a one-element
// array per draw would be a dozen garbage objects every frame.
const _offsetScratch = [0];

/**
 * The habitat's glazing, drawn as real transparent glass.
 *
 * WHY THIS IS A SEPARATE PASS, AND WHY IT IS WHERE IT IS. The panes write no
 * depth, so they must be drawn after everything they are seen against - and
 * passes/index.js puts creatures, scatter, sky, clouds, copyOpaque and the ocean
 * surface between the entity pass and here. Every one of those claims exactly
 * the pixels a window opens onto: open water becomes sky, the sea surface seen
 * up through the commons dome is the ocean pass, a fish outside the laboratory
 * is the creature pass. Drawn with the rest of the entities, the glass would be
 * overwritten by all of them.
 *
 * AFTER THE UNDERWATER COMPOSITE is also what makes the medium tractable. By the
 * time this runs the background behind each pane has already been fogged over
 * `dist - dryPath`, which is exactly the distance to the pane; so the pane owes
 * itself one thing and one thing only - the water between the eye and ITSELF,
 * which is zero from a dry room. That is the same rule pass/glow.wgsl lives by
 * ("a sprite pass after the underwater composite is not covered by it"), and the
 * blend algebra closes exactly: with dst = inScatter + T*L_room and src =
 * inScatter + T*G, a*src + (1-a)*dst = inScatter + T*(a*G + (1-a)*L_room), which
 * is the pixel. That identity is why the pane applies the FULL medium to itself
 * rather than transmittance alone.
 *
 * BEFORE `glow`, not after: an emitter between the eye and the station must not
 * be tinted by a pane behind it, and approaching from outside is far more common
 * than the reverse. A sprite seen THROUGH a window correspondingly misses the
 * pane's tint, which on a diffuse halo is a small error.
 *
 * SORTING. moduleShell() emits an outward GLASS skin and an inward VIEWPORT
 * skin, so back-face culling means a view crosses at most ONE layer per hull
 * wall. Two layers occur only looking straight through a glazed drum, or through
 * two modules, and only where no opaque geometry intervenes; the residual there
 * is bounded by a1*a2*|C1-C2|, a couple of percent of a colour difference.
 *
 * @param {import('../renderer.js').Renderer} renderer
 * @param {object} game the Game instance; `game.habitat` is read every frame
 * @returns {object} a FrameGraph pass
 */
export function makeGlazingPass(renderer, game) {
  let pipeline = null;
  let entityLayout = null;
  let entityBindGroup = null;
  let boundRing = null;

  const layout = vertexLayout([
    [0, 'float32x3'],
    [1, 'float32x3'],
    [2, 'float32x4'],
    [3, 'float32x2'],
  ]);

  const model = new Float32Array(16);
  const prevModel = new Float32Array(16);

  return {
    name: 'glazing',
    type: 'render',
    reads: ['sceneDepth'],
    writes: ['sceneColor', 'velocity', 'dryPath'],

    enabled(ctx) {
      if (!pipeline || !game.habitat?.gpu) return false;
      const h = game.habitat;
      return ctx.camera.isSphereVisible(h.position, h.mesh.boundingRadius);
    },

    init(ctx) {
      const module = ctx.shaders.module('pass/entity.wgsl', {}, 'entity');
      entityLayout = ctx.pipelines.bindGroupLayout('entity.bgl', [{
        binding: 0,
        visibility: STAGE.VF,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: ENTITY_UNIFORM_BYTES },
      }]);

      pipeline = ctx.pipelines.renderPipeline({
        label: 'entity.glazing',
        layout: ctx.pipelines.pipelineLayout('entity.pl', [renderer.frameLayout, entityLayout]),
        vertex: { module, entryPoint: 'vs_entity', buffers: [layout] },
        fragment: {
          module,
          entryPoint: 'fs_entity',
          targets: [
            { format: FORMATS.hdr, blend: Blend.alpha },
            // VELOCITY IS NOT WRITTEN, and it cannot be blended either: an
            // alpha blend factor has to read the fragment's alpha, and
            // FragOut.velocity is a vec2f on an rg16float target with no alpha
            // channel to read - WebGPU rejects the whole pipeline for it.
            //
            // Leaving the background's motion vector in place is also the right
            // answer for the pixel, which at these alphas is mostly background:
            // a pane passes 60% of what is behind it. The mullions are the one
            // part that would rather reproject with the glass, and they are
            // 40 mm wide against TAA's own neighbourhood clamp.
            { format: FORMATS.velocity, writeMask: 0 },
            // MASKED, BUT PRESENT. fs_entity declares four fragment outputs
            // because the opaque pipeline needs dryPath and the SSAO gate, and
            // WebGPU requires a pipeline's targets to match its shader's
            // outputs - one short and the whole pipeline fails validation. The
            // crossings were already summed by the prepass in the entity pass,
            // so nothing is written.
            { format: FORMATS.r16f, writeMask: 0 },
            // The gate too: the glazing draws after the SSAO apply pass has
            // already consumed aoGate, and a pane must not overwrite the gate
            // of the opaque surface behind it anyway.
            { format: FORMATS.r8, writeMask: 0 },
          ],
        },
        // Back-face culled, exactly like the opaque pipeline - see the sorting
        // note above; it is what keeps this to one layer per hull wall.
        primitive: Primitive.triangles,
        depthStencil: DepthState.testNoWrite(FORMATS.depth),
      });
    },

    execute(ctx, encoder) {
      const habitat = game.habitat;
      if (!pipeline || !habitat?.gpu) return;

      if (boundRing !== ctx.uniforms.buffer || !entityBindGroup) {
        boundRing = ctx.uniforms.buffer;
        entityBindGroup = ctx.device.createBindGroup({
          label: 'entity.glazing.bg',
          layout: entityLayout,
          entries: [{
            binding: 0,
            resource: { buffer: boundRing, offset: 0, size: ENTITY_UNIFORM_BYTES },
          }],
        });
      }

      const pass = encoder.beginRenderPass(profiler.gpuPass({
        label: 'glazing',
        colorAttachments: [
          colorAttachment(ctx.targets.view('sceneColor'), { loadOp: 'load' }),
          colorAttachment(ctx.targets.view('velocity'), { loadOp: 'load' }),
          // Bound but write-masked; see the pipeline's targets.
          colorAttachment(ctx.targets.view('dryPath'), { loadOp: 'load' }),
          colorAttachment(ctx.targets.view('aoGate'), { loadOp: 'load' }),
        ],
        // READ-ONLY depth against a testNoWrite pipeline, the same combination
        // passes/ocean.js already uses for its shading pass.
        depthStencilAttachment: depthAttachment(ctx.targets.view('sceneDepth'),
          { clear: false, readOnly: true }),
      }, 'glazing'));

      pass.setPipeline(pipeline);
      pass.setBindGroup(GROUP.FRAME, ctx.frameBindGroup);
      pass.setVertexBuffer(0, habitat.gpu.vertexBuffer);
      pass.setIndexBuffer(habitat.gpu.indexBuffer, 'uint32');

      const origin = ctx.camera.worldOrigin;
      model.set(habitat.modelMatrix);
      prevModel.set(habitat.prevModelMatrix);
      model[12] -= origin[0]; model[13] -= origin[1]; model[14] -= origin[2];
      prevModel[12] -= origin[0]; prevModel[13] -= origin[1]; prevModel[14] -= origin[2];

      for (const part of habitat.gpu.parts) {
        if (!isHabitatGlazing(part.material)) continue;
        const block = ctx.uniforms.alloc(ENTITY_UNIFORM_BYTES);
        const f = block.f32;
        f.set(model, 0); f.set(prevModel, 16);
        f[32] = part.material; f[33] = 0; f[34] = part.emission || 0;
        f[35] = habitatIsDryInterior(part.material) ? 2 : 1;
        const tint = part.tint || MATERIAL_TINT[part.material] || MATERIAL_TINT[0];
        f[36] = tint[0]; f[37] = tint[1]; f[38] = tint[2]; f[39] = tint[3] || 0;
        // The outboard pane is 33 m under water and the inboard one is in a dry
        // room; same split as the opaque parts, same reason.
        f[41] = habitatIsDryInterior(part.material) ? 0 : 1;
        f[42] = -1; f[43] = 1;
        _offsetScratch[0] = block.offset;
        pass.setBindGroup(GROUP.PASS, entityBindGroup, _offsetScratch);
        pass.drawIndexed(part.indexCount, 1, part.firstIndex, 0, 0);
      }

      pass.end();
    },
  };
}
