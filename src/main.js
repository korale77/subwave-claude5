/**
 * SUBWAVE entry point.
 *
 * Boot sequence, the fixed-timestep game loop, and the wiring between systems.
 * Everything here is orchestration - no gameplay or rendering logic lives in
 * this file.
 *
 * The loop is a classic accumulator: simulation runs at a FIXED 60 Hz so
 * physics and buoyancy are stable regardless of frame rate, while rendering
 * interpolates between simulation states.
 */

import { Renderer, FLAG } from './render/renderer.js';
import { CameraRig } from './render/camera.js';
import { Clock, WorldClock, FIXED_DT } from './core/time.js';
import { InputManager, ACTION, CONTEXT } from './core/input.js';
import { settings } from './core/settings.js';
import { ControlsHint } from './ui/controls-hint.js';
import { JumpMenu } from './ui/jump-menu.js';
import { teleportTo, primeArrival, parseCoords, validateTarget } from './entities/teleport.js';
import { getBiomeAnchors } from './world/biome_anchors.js';
import { events, EVENTS } from './core/events.js';
import { profiler } from './core/profiler.js';
import { UnsupportedError, TIER_NAMES } from './core/gpu.js';
import { WORLD, WATER_TYPES, RENDER } from './core/constants.js';
import { clamp } from './core/math.js';
import { waterTypeAt, materialAt, BIOMES } from './world/biomes.js';
import { HABITAT_SITE } from './world/habitat_site.js';
import { ABYSS_ENCOUNTER_SITE } from './world/abyss_encounter_site.js';
import { PLACES, PLACE_BY_SHORT } from './world/places.js';

/** Boot stages and their relative weights, for an honest progress bar. */
const BOOT_STAGES = [
  { id: 'gpu', label: 'Acquiring GPU', weight: 8 },
  { id: 'shaders', label: 'Compiling shaders', weight: 18 },
  { id: 'sky', label: 'Precomputing atmosphere', weight: 10 },
  { id: 'terrain', label: 'Generating the seafloor', weight: 32 },
  { id: 'ocean', label: 'Seeding the ocean', weight: 14 },
  { id: 'entities', label: 'Assembling the vessel', weight: 10 },
  { id: 'audio', label: 'Tuning hydrophones', weight: 4 },
  { id: 'ready', label: 'Ready', weight: 4 },
];

class Game {
  constructor() {
    this.canvas = document.getElementById('viewport');
    this.renderer = new Renderer();
    this.clock = new Clock();
    this.worldClock = new WorldClock(0.30);   // mid-morning: bright and welcoming
    this.input = new InputManager(this.canvas);
    this.rig = new CameraRig(this.renderer.camera);
    this.controlsHint = new ControlsHint(this.input);
    // Constructed here rather than in boot() because it only needs the game
    // object, which it holds by reference and reads lazily - the systems it
    // reaches (terrain, spawner, scatterPass) do not exist until stage 5, and it
    // cannot be opened before boot completes anyway.
    this.jumpMenu = new JumpMenu(this);

    /** Systems, populated during boot. Kept in one place so the loop is readable. */
    this.sky = null;
    this.weather = null;
    this.ocean = null;
    this.chunks = null;
    this.collision = null;
    this.scatterCollision = null;
    this.player = null;
    this.vessel = null;
    this.habitat = null;
    this.abyssEncounter = null;
    this.leviathanResidencies = null;
    this.caveResidencies = null;
    this.stationResidencies = null;
    this.duneAmbush = null;
    this.creatures = null;
    this.spawner = null;
    this.entitiesPass = null;
    this.glazingPass = null;
    this.creaturePass = null;
    this.shadows = null;
    this.hud = null;
    this.audio = null;
    /** The automated showcase demo (src/demo/director.js). Fully inert until
     *  its key: nothing below reads it except behind `demo?.active`. */
    this.demo = null;

    /** Water-classification dwell state: the committed water-type row, and
     *  the differing candidate with its accumulated hold time. See
     *  _updateWaterColumn and WORLD.WATER_TYPE_DWELL. */
    this._waterTypeHeld = null;
    this._waterCandType = null;
    this._waterCandT = 0;

    /** Frame-graph passes owned by a system rather than by the renderer. */
    this.skyPass = null;
    this.cloudsPass = null;
    this.volumetricsPass = null;

    this.running = false;
    this.paused = false;
    this.started = false;
    this.seed = WORLD.DEFAULT_SEED;

    this._rafHandle = 0;
    this._bootProgress = 0;
    this._statsEl = document.getElementById('stats');
    this._interactionPromptEl = document.getElementById('interaction-prompt');
    this._statsAccum = 0;
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  _setStage(index, fraction = 0) {
    const total = BOOT_STAGES.reduce((a, s) => a + s.weight, 0);
    let done = 0;
    for (let i = 0; i < index; i++) done += BOOT_STAGES[i].weight;
    done += BOOT_STAGES[index].weight * clamp(fraction, 0, 1);
    const t = done / total;
    this._bootProgress = t;

    const fill = document.getElementById('boot-bar-fill');
    const text = document.getElementById('boot-stage-text');
    const pct = document.getElementById('boot-stage-pct');
    if (fill) fill.style.right = `${(1 - t) * 100}%`;
    if (text) text.textContent = BOOT_STAGES[index].label;
    if (pct) pct.textContent = `${Math.round(t * 100)}%`;

    events.emit(EVENTS.BOOT_PROGRESS, { stage: BOOT_STAGES[index].id, t });
  }

  async boot() {
    settings.load();

    // --- GPU -------------------------------------------------------------
    this._setStage(0, 0);
    const requestedTier = settings.get('qualityTier');
    await this.renderer.init(this.canvas, {
      tier: requestedTier === 'auto' ? undefined : TIER_NAMES.indexOf(requestedTier),
    });
    settings.applyToGPU(this.renderer.gpu);
    settings.applyToInput(this.input);
    console.info('[subwave] GPU:', this.renderer.gpu.describe());
    this._setStage(0, 1);

    // Systems are imported lazily so a failure in one reports against its own
    // boot stage rather than as an opaque module-load error.
    this._setStage(1, 0);
    const [
      { SkySystem }, { WeatherSystem }, { OceanSim },
      terrain, { ChunkManager }, { CollisionWorld }, { ScatterCollision },
      { Player }, { Vessel }, { Habitat }, { HUD }, { registerPasses },
      { makeSkyPass }, { makeCloudsPass }, caves, { CaveChunkManager },
    ] = await Promise.all([
      import('./sim/sky.js'),
      import('./sim/weather.js'),
      import('./sim/ocean.js'),
      import('./world/terrain.js'),
      import('./world/chunks.js'),
      import('./world/collision.js'),
      import('./world/scatter_collision.js'),
      import('./entities/player.js'),
      import('./entities/vessel.js'),
      import('./entities/habitat.js'),
      import('./ui/hud.js'),
      import('./render/passes/index.js'),
      import('./render/passes/sky.js'),
      import('./render/passes/clouds.js'),
      import('./world/caves.js'),
      import('./world/cave_chunks.js'),
    ]);
    this._setStage(1, 0.5);

    const r = this.renderer;

    // --- world -----------------------------------------------------------
    terrain.setSeed(this.seed);
    this.terrain = terrain;

    // The live optical water column, sprung toward whatever biomes.waterTypeAt()
    // says the camera is in. It is a MUTABLE object handed to the renderer once
    // and mutated in place every frame, rather than a new WATER_TYPES entry being
    // assigned, so the coefficients can blend continuously across a boundary.
    // Seeded from the type at the origin so the very first frame is already right.
    const seed = WATER_TYPES.OCEANIC_CLEAR;
    this._waterColumn = {
      id: seed.id, name: seed.name,
      sigmaA: Float32Array.from(seed.sigmaA),
      sigmaS: Float32Array.from(seed.sigmaS),
      sigmaT: Float32Array.from(seed.sigmaT),
      Kd: Float32Array.from(seed.Kd),
      // The same column with its Jerlov red restored, for the water-leaving
      // radiance only. Sprung as INPUTS rather than as a precomputed
      // reflectance: deepWaterReflectance() is nonlinear in them, so springing
      // its output would be a different quantity across a biome boundary.
      surfaceSigmaA: Float32Array.from(seed.surfaceSigmaA),
      surfaceKd: Float32Array.from(seed.surfaceKd),
      deepTint: Float32Array.from(seed.deepTint),
      g: seed.g, ior: seed.ior, density: seed.density,
      snowMultiplier: seed.snowMultiplier, visibility: seed.visibility,
      // Per-water-type medium chromaticity (KELP_EMERALD's art deviation;
      // 1.0 for every row that does not author one). Sprung like every other
      // quantity that reaches a pixel - the renderer multiplies it into
      // RENDER.WATER_CHROMA at the pack site.
      chroma: seed.chroma ?? 1,
    };
    r.env.waterType = this._waterColumn;
    // The local haze chromaticity, sprung on the same schedule as the column
    // above. It is a BIOME quantity rather than a water-type one - two biomes
    // can share OCEANIC_CLEAR and still want a different cast - so it comes
    // from materialAt()'s weight blend and not from WATER_TYPES. Seeded to the
    // biome at the origin so the first frame is already right, exactly as the
    // column is. See RENDER.WATER_FOG_TINT_STRENGTH for why this term carries
    // the biome separation that the seabed albedo cannot.
    this._fogTint = Float32Array.from(BIOMES[0].fogTint);
    r.env.fogTint = this._fogTint;
    this._sightDensity = BIOMES[0].sightDensity;
    r.env.sightDensity = this._sightDensity;
    this._setStage(2, 0);
    this.sky = new SkySystem(r, this.worldClock);
    await this.sky.init?.();
    this.weather = new WeatherSystem(this.seed);
    // The sky's LUT compute passes come from sky.makePasses(); these two are the
    // draws, and registerPasses() places them after opaque geometry.
    this.skyPass = makeSkyPass(this.sky);
    this.cloudsPass = makeCloudsPass(this.sky);

    this._setStage(3, 0);
    this.collision = new CollisionWorld(terrain);
    // Static scatter collision (backlog 3.5): streams collidable-instance
    // proxies into collision.statics around the player and the vessel, inside
    // the fixed step so the proxy set is a function of sim state alone.
    this.scatterCollision = new ScatterCollision(this.collision);
    this.chunks = new ChunkManager(r.gpu.device, r.camera, terrain);
    await this.chunks.init?.((f) => this._setStage(3, f));
    // The volumetric cave layer: its own streamer (3-D chunk addresses, its
    // own worker), and the field wired into collision so a carved mouth is
    // passable and a cave interior is solid. No boot prime: the start zone is
    // inside caves.js's NO_CAVE_RADIUS, so there is nothing to stream yet.
    this.caves = caves;
    this.caveChunks = new CaveChunkManager(r.gpu.device, r.camera);
    this.collision.setCaveField(caves);
    /** True while the CAMERA is inside a carved cave void; feeds FLAG_IN_CAVE
     *  and the HUD annunciator. Recomputed every rendered frame. */
    this.inCave = false;

    this._setStage(4, 0);
    this.ocean = new OceanSim(r);
    await this.ocean.init?.();
    this.collision.setOcean?.(this.ocean);

    // --- entities ---------------------------------------------------------
    this._setStage(5, 0);
    this.player = new Player(this.collision);
    this.vessel = new Vessel(this.collision, r.gpu.device);
    this.habitat = new Habitat(r.gpu.device);
    await this.vessel.init?.();
    this.habitat.init();
    // Derive the start point from the terrain that was actually generated
    // rather than trusting a constant. See terrain.findSpawnPoint().
    const spawn = terrain.findSpawnPoint();
    this.spawn = spawn;
    this.player.position.set(spawn.position);
    this.vessel.position.set(spawn.vesselPad);
    // Face the player out over the water toward the lagoon they are meant to
    // explore, so the first thing they see is somewhere to go.
    r.camera.setEuler(spawn.shoreBearing, -0.05, 0);
    this.player.yaw = spawn.shoreBearing;
    console.info(`[subwave] spawn ${spawn.position.map((v) => v.toFixed(1))} ` +
                 `(ground ${spawn.height.toFixed(1)} m, slope ${spawn.slope.toFixed(3)}), ` +
                 `vessel ${spawn.vesselPad.map((v) => v.toFixed(1))}`);
    if (spawn.height < 1.0) {
      console.error('[subwave] spawn point is not dry land - the player will start in water.');
    }
    // The player needs to know which vessel the boarding prompt targets.
    this.player.setVessel(this.vessel);
    this.player.setHabitat(this.habitat);
    this.vessel.setHabitat(this.habitat);

    const { makeEntitiesPass, makeGlazingPass } =
      await import('./render/passes/entities.js');
    this.entitiesPass = makeEntitiesPass(r, this);
    // The habitat's windows, drawn transparent after the underwater composite.
    // registerPasses() reads this off the game object BY NAME, so an unset field
    // is a silently absent pass and the station simply has no glass.
    this.glazingPass = makeGlazingPass(r, this);

    // --- creatures --------------------------------------------------------
    // The population is created here, populated after the frame graph has run
    // pass.init() (the creature pass builds its mesh library there), and ticked
    // inside the fixed-step simulation. The spawner owns the Safe Charter and
    // installs its own enforcement on the sim; see entities/spawner.js.
    const [{ CreatureSim }, { Spawner }, { AbyssEncounter }, { LeviathanResidencies },
           { CaveResidencies }, { StationResidencies }, { DuneAmbush },
           { makeCreaturePass }] = await Promise.all([
      import('./entities/creatures.js'),
      import('./entities/spawner.js'),
      import('./entities/abyss_encounter.js'),
      import('./entities/leviathan_residency.js'),
      import('./entities/cave_residency.js'),
      import('./entities/station_residency.js'),
      import('./entities/dune_ambush.js'),
      import('./render/passes/creatures.js'),
    ]);
    this.creatures = new CreatureSim(this.collision, { seed: this.seed });
    this.spawner = new Spawner(this.creatures, { seed: this.seed });
    this.abyssEncounter = new AbyssEncounter(this.creatures);
    this.leviathanResidencies = new LeviathanResidencies(this.creatures);
    this.caveResidencies = new CaveResidencies(this.creatures);
    this.stationResidencies = new StationResidencies(this.creatures);
    this.duneAmbush = new DuneAmbush(this.creatures);
    this.spawner.attach({
      // A strike reaches the player through here rather than creatures.js
      // importing the player: the sim has no business knowing what a player is.
      onPlayerDamage: (amount, source, direction) => {
        this.player.damage(amount, source, direction);
      },
    });
    this.creaturePass = makeCreaturePass(r, this);

    // The world's own render passes. registerPasses() picks these up off the
    // game object by name, so every one of them has to be constructed here -
    // a missing assignment is a silently absent pass, not an error.
    // (Caustics is not built here - the ocean sim contributes it via
    // makeCausticsPass(), alongside its other compute passes.)
    const [{ makeTerrainPass }, { createOceanSurfacePass },
           { createUnderwaterPass }, { makeScatterPass },
           { makeVolumetricsPass }, { makeGlowPass }, { makeSsaoPass }] = await Promise.all([
      import('./render/passes/terrain.js'),
      import('./render/passes/ocean.js'),
      import('./render/passes/underwater.js'),
      import('./render/passes/scatter.js'),
      import('./render/passes/volumetrics.js'),
      import('./render/passes/glow.js'),
      import('./render/passes/ssao.js'),
    ]);
    // The cave manager rides along so the terrain pass can open the cave-mouth
    // discs (its masked pipeline); without it the mouths stay roofed over.
    this.terrainPass = makeTerrainPass(r, this.chunks, this.caveChunks);
    const { makeCavesPass } = await import('./render/passes/caves.js');
    this.cavesPass = makeCavesPass(r, this.caveChunks);
    this.oceanPass = createOceanSurfacePass(this.ocean, this.sky);
    this.underwaterPass = createUnderwaterPass(this.ocean);
    this.scatterPass = makeScatterPass(r, this);
    this.volumetricsPass = makeVolumetricsPass(r);
    // Screen-space ambient occlusion, in the slot render/passes/index.js
    // schedules between the last opaque pass and the sky. Constructed on every
    // tier - it disables itself when the preset ships without SSAO or when
    // RENDER.SSAO_STRENGTH is 0.
    this.ssaoPass = makeSsaoPass(r);
    // The bioluminescent glow sprites, in the slot render/passes/index.js
    // already schedules after the underwater composite and before the post
    // chain. It reads the creature and scatter passes' baked emission, so it is
    // constructed after both.
    this.particlesPass = makeGlowPass(r, this);

    // --- ui / audio -------------------------------------------------------
    this._setStage(6, 0);
    this.hud = new HUD(r);
    await this.hud.init?.();

    // The post chain and the HUD composite plug into the same frame-graph
    // hooks registerPasses() looks for (render/passes/index.js), so they are
    // constructed here and picked up below.
    const [{ createPostPasses }, { createHudPass }] = await Promise.all([
      import('./render/passes/post.js'),
      import('./render/passes/hud.js'),
    ]);
    this.postPasses = createPostPasses(r);
    this.hudPass = createHudPass(r, this.hud);

    // --- passes -----------------------------------------------------------
    this._setStage(7, 0);
    // The shadow system reads the caster passes off this object by name, so it
    // is constructed after all of them and before registerPasses() puts its pass
    // in the frame.
    const { ShadowSystem } = await import('./render/shadows.js');
    this.shadows = new ShadowSystem(r, this);
    registerPasses(r, this);
    await r.graph.init();

    // Scatter geometry can only be built once the graph has run pass.init() and
    // handed the pass a device, and it has to be populated BEFORE the first
    // frame or the player watches the seabed sprout. It is centred on the spawn
    // rather than on the camera because the camera is not placed until the first
    // _updateCamera().
    await this.scatterPass.prime(spawn.position, (f) => this._setStage(7, f * 0.9));

    // The ocean has to be alive before the first frame too. Priming is one
    // synchronous pass over the spawn cells within 900 m; it is bounded by
    // RENDER.MAX_CREATURES so it cannot run long.
    const primed = this.spawner.prime(spawn.position, this.worldClock);
    console.info(`[subwave] population primed: ${primed} creatures, ` +
      `${this.spawner.cells.size} spawn cells`);
    this._setStage(7, 0.95);

    // The showcase demo director. Constructed at boot so the key works from
    // the first frame, but it owns nothing until started - qa.mjs and every
    // scenario run with it exactly as inert as before it existed.
    const { DemoDirector } = await import('./demo/director.js');
    this.demo = new DemoDirector(this);

    this._wireEvents();
    this.running = true;
    events.emit(EVENTS.BOOT_COMPLETE, {});
    this._setStage(7, 1);
    return this;
  }

  _wireEvents() {
    settings.onChange((key) => {
      if (key === 'qualityTier' || key === 'resolutionScale') {
        settings.applyToGPU(this.renderer.gpu);
      } else if (key.startsWith('mouse') || key.startsWith('pad') || key === 'invertY') {
        settings.applyToInput(this.input);
      } else if (key === 'headBob') {
        this.rig.bobScale = settings.get('headBob');
      } else if (key === 'cameraShake') {
        this.rig.shakeScale = settings.get('cameraShake');
      } else if (key === 'fovKick') {
        this.rig.fovKickScale = settings.get('fovKick');
      }
    });

    this.rig.bobScale = settings.get('headBob');
    this.rig.shakeScale = settings.get('cameraShake');
    this.rig.fovKickScale = settings.get('fovKick');

    // Tell the player when the mouse is not captured. Without this, an
    // uncaptured cursor is silently indistinguishable from broken look controls.
    this.input.onPointerLockChange(() => this._syncLockHint());
    // Clicking the canvas always re-arms capture.
    this.canvas.addEventListener('mousedown', () => {
      // The jump menu's own root is a full-screen scrim, so a click meant for it
      // never reaches the canvas; this is the second line, for a click that
      // lands during the open/close transition.
      // Not during the demo: clicks are a spectator there, not a command, and
      // a re-locked pointer makes the browser eat the first Escape (the stated
      // stop key) to exit the lock. The director releases the pointer and its
      // wantsPointerLock latch on start and restores both on stop.
      if (this.started && !this.paused && !this.jumpMenu.open && !this.demo?.active) {
        this.input.wantsPointerLock = true;
        this.input.requestPointerLock();
      }
    });

    // A lost device is unrecoverable without a full rebuild; tell the player
    // plainly rather than freezing on a black canvas.
    events.on(EVENTS.DEVICE_LOST, ({ reason, message }) => {
      this.running = false;
      window.__subwaveFatal?.(
        'Graphics device lost',
        'The GPU connection was lost. This usually means a driver reset or the tab ' +
        'running out of video memory. Reload to continue.',
        `${reason}: ${message}`,
      );
    });

    // An active sonar ping is the loudest event in the game: +0.90 threat to
    // every creature within 400 m and a one-frame flash expansion through any
    // shoal inside 12 m. DESIGN/06.1.8(b).
    events.on(EVENTS.VESSEL_SONAR_PING, ({ range }) => {
      this.creatures?.sonarPing(this.vessel.position, range || 400);
    });

    // Pause when the tab is hidden so we do not burn battery, and resync the
    // clock on return so the accumulator does not fire a burst of steps.
    // NOT while the showcase demo runs: the demo's stated contract is that
    // only G or Escape stops it, and the old auto-pause broke that sideways -
    // alt-tab paused the game, and the Escape pressed to unpause was the
    // demo's own abort key. A hidden tab stops getting rAF frames anyway, so
    // the demo simply freezes and the resync below resumes it seamlessly.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (!this.demo?.active) this.setPaused(true);
      } else {
        this.clock.resync();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------

  start() {
    if (this.started) return;
    this.started = true;
    this.input.wantsPointerLock = true;
    this.input.requestPointerLock();
    this.clock.resync();
    // Reflect the CURRENT lock state immediately. pointerlockchange only fires
    // on a transition, so if the request is denied outright no event ever
    // arrives and the player is left with a dead mouse and no explanation.
    this._syncLockHint();
    events.emit(EVENTS.GAME_START, { seed: this.seed, isNewGame: true });
    this._rafHandle = requestAnimationFrame((t) => this._frame(t));
  }

  /**
   * The representative position of each biome in the CURRENT terrain, resolved
   * on first use and cached against the seed.
   *
   * @returns {ReadonlyArray<object>} see world/biome_anchors.js
   */
  biomeAnchors() {
    return getBiomeAnchors(this.terrain);
  }

  /**
   * Jump to a biome or to a coordinate. THE one entry point.
   *
   * The jump menu, tools/shot.mjs setups, tools/probe.mjs and the browser
   * console all go through here, which is what keeps a shot list from ever
   * hard-coding an anchor coordinate that the terrain can invalidate.
   *
   *   subwave.jumpTo(5)                 // biome id, or 'kelp' / 'Kelp Forest'
   *   subwave.jumpTo('2456 2160')       // x z, height derived
   *   subwave.jumpTo('-168, 3, -648')   // x y z
   *   subwave.jumpTo({ x: 0, z: 240 })
   *
   * @param {number|string|object} target
   * @param {object} [opts] forwarded to teleportTo (yaw, pitch, grantGear)
   * @returns {object} the teleport result, or `{error}` if the target is unusable
   */
  jumpTo(target, opts = {}) {
    let x, y = null, z, label = opts.label, anchorYaw = null, anchorPitch = null;
    let resetAbyssEncounter = false;
    let caveArrival = null;

    if (typeof target === 'number' || (typeof target === 'string' && !/[\s,]/.test(target))) {
      // A biome id, short name or full name. Numeric strings are ambiguous with
      // a one-token coordinate, but a one-token coordinate is not a coordinate,
      // so treating them as ids is the only reading that means anything.
      const key = String(target).toLowerCase();
      if (key === HABITAT_SITE.short || key === 'habitat' || key === 'pelagos') {
        const a = HABITAT_SITE.arrival;
        x = a.x; y = a.y; z = a.z;
        label = label ?? HABITAT_SITE.name;
        anchorYaw = a.yaw; anchorPitch = a.pitch;
      } else if (key === ABYSS_ENCOUNTER_SITE.short || key === 'abyss-encounter' ||
          key === 'pale-herald') {
        const a = ABYSS_ENCOUNTER_SITE;
        x = a.x; y = a.y; z = a.z;
        label = label ?? a.name;
        anchorYaw = a.yaw; anchorPitch = a.pitch;
        resetAbyssEncounter = true;
      } else if (key.endsWith('-in') && PLACE_BY_SHORT[key.slice(0, -3)]?.caveArrival) {
        // The CAVE-INTERIOR row of a place that has one. The heightfield
        // teleport cannot express this destination - teleportTo refuses any y
        // below the terrain surface ("y raised out of the terrain"), because
        // for open ground an eye under the heightfield photographs back-face
        // culled nothing. A cave interior is below the heightfield BY
        // DEFINITION, so the row goes through the ordinary teleport first
        // (latches, gear grant, history resets, spawner prime - all keyed on
        // the snapped, above-rock arrival) and is then RE-SEATED below.
        const p = PLACE_BY_SHORT[key.slice(0, -3)];
        const a = p.caveArrival;
        x = a.x; y = a.y; z = a.z;
        label = label ?? `${p.name} (chamber)`;
        anchorYaw = a.yaw; anchorPitch = a.pitch;
        caveArrival = a;
      } else if (PLACE_BY_SHORT[key] || PLACES.some((p) => p.name.toLowerCase() === key)) {
        // Authored landmark places. Same shape as the two station rows above:
        // the arrival pose is curated in world/places.js, aimed AT the place's
        // subject with the compass convention, and sampled from the terrain.
        const p = PLACE_BY_SHORT[key] ?? PLACES.find((q) => q.name.toLowerCase() === key);
        const a = p.arrival;
        x = a.x; y = a.y; z = a.z;
        label = label ?? p.name;
        anchorYaw = a.yaw; anchorPitch = a.pitch;
      } else {
        const anchors = this.biomeAnchors();
        const a = anchors.find((r) => String(r.id) === key
          || r.short.toLowerCase() === key || r.name.toLowerCase() === key);
        if (!a) return { error: `no biome '${target}'. Try an id 0-${anchors.length - 1}, or ${anchors.map((r) => r.short).join(', ')}` };
        x = a.viewX; y = a.viewY; z = a.viewZ;
        label = label ?? a.name; anchorYaw = a.yaw; anchorPitch = a.pitch;
        if (!a.dominant) {
          console.warn(`[jump] ${a.name} is not dominant anywhere; weight ${a.weight.toFixed(3)} at this anchor`);
        }
      }
    } else if (typeof target === 'object' && target !== null) {
      x = target.x; z = target.z;
      y = Number.isFinite(target.y) ? target.y : null;
    } else {
      const parsed = parseCoords(target);
      if (!parsed) return { error: `cannot parse '${target}'. Try "x z" or "x y z"` };
      x = parsed.x; y = parsed.y; z = parsed.z;
    }

    const valid = validateTarget(x, z);
    if (!valid.ok) return { error: valid.reason };

    // A jump is an external discontinuity, not an airlock traversal. Never let
    // the dry-medium latch follow the player to an unrelated underwater point.
    if (this.habitat) this.habitat.playerInside = false;
    if (this.player) this.player.inHabitat = false;
    if (resetAbyssEncounter) this.abyssEncounter?.reset();
    // A jump can land inside a residency's activation ring or leave one
    // behind; despawning and re-arming makes either case start clean, exactly
    // as the encounter's reset does.
    this.leviathanResidencies?.reset();
    this.caveResidencies?.reset();
    this.stationResidencies?.reset();
    this.duneAmbush?.reset();
    const result = teleportTo(this, x, y, z, {
      ...opts,
      // Explicit caller framing always wins. Only named biome destinations get
      // the curated anchor view; typed coordinates retain teleport's generic
      // downhill heading.
      yaw: opts.yaw ?? anchorYaw ?? undefined,
      pitch: opts.pitch ?? anchorPitch ?? undefined,
      label,
    });
    result.warn = valid.warn;
    // THE CAVE RE-SEAT. teleportTo snapped the y out of the rock (see the
    // interior branch above for why that snap is right for every destination
    // but this one); Player.teleport is the function that rewrites every
    // latch and history slot by hand, so calling it again at the authored
    // interior point leaves nothing stale - and the water column and the
    // spawner are re-pointed at the point the player actually occupies.
    // ON FOOT ONLY: a 7.4 m hull re-seated into a 9 m chamber would start
    // interpenetrated with the cave contact solver, so a piloted jump keeps
    // the snapped above-rock arrival and the pilot swims in.
    if (caveArrival && !this.player.inVessel) {
      const a = caveArrival;
      this.player.teleport(a.x, a.y, a.z,
        opts.yaw ?? a.yaw, opts.pitch ?? a.pitch,
        { time: this.worldClock?.totalSeconds ?? 0 });
      result.x = a.x; result.y = a.y; result.z = a.z;
      result.yaw = opts.yaw ?? a.yaw; result.pitch = opts.pitch ?? a.pitch;
      this.snapWaterColumn?.([a.x, a.y + this.player.currentEyeHeight, a.z]);
      this.spawner?.prime?.(this.player.position, this.worldClock);
      this.renderer?.camera?.resetHistory?.();
      this.renderer?.resetAdaptation?.();
    }
    // Fire and forget, but NEVER floating: an unhandled rejection reaches
    // window.onunhandledrejection, which raises the fatal overlay over a
    // perfectly healthy game.
    primeArrival(this, result.x, result.y, result.z)
      .catch((e) => console.warn('[jump] scatter prime failed:', e));
    return result;
  }

  setPaused(p) {
    if (this.paused === p) return;
    this.paused = p;
    this.clock.setPaused(p);
    events.emit(EVENTS.GAME_PAUSE, { paused: p });
    if (p) {
      this.input.exitPointerLock();
    } else {
      this.input.wantsPointerLock = true;
      this.clock.resync();
    }
    this._syncLockHint();
  }

  _frame(timestamp) {
    if (!this.running) return;
    this._rafHandle = requestAnimationFrame((t) => this._frame(t));

    const dt = this.clock.beginFrame(timestamp);
    this.input.beginFrame();

    // These four are TOGGLES read once per rendered frame, ahead of the fixed
    // step loop, so they must use wasPressedOnce: a plain wasPressed edge
    // survives a zero-step frame by design and would toggle them straight back.
    // While the DEMO runs, only PAUSE stays live - keyboard Escape never
    // reaches this read (the director's raw abort consumes it via
    // clearEdges), so this is the GAMEPAD Start button, and it stops the show
    // rather than pausing under it. The other toggles are spectator keys
    // during a demo: a jump menu opened over the cinematic teleports the
    // route out from under the director (and its close handler re-arms
    // wantsPointerLock, defeating the demo's pointer release), HELP fights
    // the director's own legend latch, and the time snap jolts the scene.
    if (this.input.wasPressedOnce(ACTION.PAUSE)) {
      if (this.demo?.active) this.demo.stop('input: pause');
      else this.setPaused(!this.paused);
    }
    if (this.input.wasPressedOnce(ACTION.DEBUG_OVERLAY)) {
      settings.set('showFps', !settings.get('showFps'));
    }
    if (!this.demo?.active) {
      if (this.input.wasPressedOnce(ACTION.HELP)) this.controlsHint.toggle();
      // The jump menu disables input while it is up, so this read is dead until
      // it closes itself - but toggle() handles both directions anyway, so the
      // hotkey still works if input is ever left enabled behind a UI.
      if (this.input.wasPressedOnce(ACTION.DEBUG_TELEPORT)) this.jumpMenu.toggle();
      // Snap the world clock between noon and deep night so the lighting can be
      // inspected in both without waiting out a 20-minute cycle. It runs here,
      // ahead of sky.update(), so the sky, the ambient probe and the star field
      // are all rebuilt from the new time on this very frame.
      if (this.input.wasPressedOnce(ACTION.DEBUG_TIME_TOGGLE)) {
        this.worldClock.toggleDayNight();
        this.renderer.resetAdaptation();
      }
    }
    // The showcase demo. Same key starts and stops it; Escape (the ONLY other
    // stop input - a spectator may type, click and alt-tab freely) stops it
    // through InputManager.onRawInput at the DOM event, which is why the
    // director's own abort ignores this key (see the note in director.js).
    // SHIFT+G ALSO RECORDS the run to a video file (src/demo/recorder.js);
    // plain G is exactly what it always was. The modifier is read off the live
    // held-key set rather than expressed as a binding because the binding
    // grammar in core/input.js has no modifier form, and inventing one for a
    // single dev key would be the larger change. tools/demo-capture.mjs
    // dispatches an unmodified KeyG, so the harness never records.
    if (this.input.wasPressedOnce(ACTION.DEMO_SHOWCASE)) {
      const record = this.input.keys.has('ShiftLeft') || this.input.keys.has('ShiftRight');
      this.demo?.toggle({ record });
    }
    this.demo?.frameUpdate(dt);

    // The input CONTEXT must be current before the simulation reads bindings.
    // Choosing it afterwards (from the camera update) leaves it a frame stale,
    // and on the very first frame it is still the bare global context, which
    // has no movement bindings at all.
    // A modal DOM menu owns the keyboard. setContext() wipes the stack to
    // [GLOBAL, ctx] every frame, so re-asserting a gameplay context underneath
    // the menu would undo its CONTEXT.UI push on the very next frame.
    if (!this.jumpMenu.open) this._updateInputContext();

    // --- fixed-step simulation -------------------------------------------
    profiler.cpu('sim');
    let steps = 0;
    while (this.clock.step()) {
      this._simulate(FIXED_DT);
      steps++;
    }
    // Only release edge-triggered input once a step has actually read it.
    // Frames that run zero steps must not consume a key press. See
    // InputManager.markEdgesConsumed().
    if (steps > 0) this.input.markEdgesConsumed();
    profiler.cpuEnd('sim');

    // --- per-frame (variable rate) work ----------------------------------
    profiler.cpu('update');
    const alpha = this.clock.alpha;

    this.worldClock.advance(this.paused ? 0 : dt);

    // Camera follows whichever thing the player is currently inhabiting. It
    // runs FIRST because the sky's atmosphere uniform is parameterised by the
    // viewer's altitude, and a stale altitude puts the horizon in the sky-view
    // LUT one frame behind the horizon the sky shader samples it at.
    this._updateCamera(dt, alpha);

    // The medium and the HUD both need to know the eye is under rock. One
    // field query per rendered frame (microseconds; band- and crater-gated
    // inside caves.js). This drives FLAG_IN_CAVE, whose consumers are
    // pass/underwater.wgsl (the enclosed-water in-scatter gate), the HUD, and
    // _updateWaterColumn's cave snow reduction - which is why it runs HERE,
    // right after the camera moves and before the water column reads it.
    {
      const cp = this.renderer.camera.position;
      this.inCave = this.caves.isInsideCave(cp[0], cp[1], cp[2]);
      this.renderer.extraFlags = this.inCave ? FLAG.IN_CAVE : 0;
    }

    // The optical column the camera is looking through. Must follow the camera
    // update and precede anything that shades, because every water coefficient in
    // the Frame uniform comes from it.
    this._updateWaterColumn(dt);

    // Weather before sky: the sky reads cloud cover, wind and air turbidity out
    // of renderer.env, all of which weather owns.
    this.weather.update(dt, this.worldClock, this.renderer);
    this.sky.update(this.worldClock, this.renderer, dt);
    this.ocean.update(dt, this.renderer);

    // The streaming centre is biased along the VELOCITY of whatever the player is
    // riding, so chunks bake before they are needed rather than under the nose. At
    // 120 m/s that difference is a chunk and a half of lead. See STREAM_LEAD_SECONDS.
    this.chunks.update(this.renderer.camera.position,
      this.player.inVessel ? this.vessel.velocity : this.player.velocity);
    // Cave streaming: worker-fed, so this call is queue management and at most
    // four buffer uploads. It also advances the mouth-disc registry the
    // terrain pass reads.
    this.caveChunks.update(this.renderer.camera.position);
    // Scatter streams on the terrain's heels: it reads the heightfield the
    // terrain bakes from, and it declines to generate while the terrain queue is
    // still draining so the two bakes never land in the same frame.
    this.scatterPass.update(this.renderer.camera.position);
    // The population streams on the player, not the camera: a chase camera 12 m
    // behind the vessel must not shift which cells are resident. It also does
    // not stream while PAUSED - unlike the terrain and the scatter, which are a
    // function of position alone, the population is a function of position and
    // TIME, and continuing to cull and respawn behind a paused game both burns
    // frames for nothing and destroys any state a debug tool has just set up.
    if (!this.paused) {
      // The near field seeds a ball of animals around the eye, and every test it
      // makes is geometric - so a player standing in the habitat's commons at
      // -33 m reads as open water with a seabed 10 m below, and gets fish
      // swimming through a pressurised room. The airlock latch is the authority.
      this.spawner.inDryInterior = !this.player.inVessel && !!this.player.inHabitat;
      this.spawner.update(dt, this.player.inVessel ? this.vessel.position : this.player.position,
        this.worldClock);
    }

    // Lights are rebuilt every frame; the vessel adds its lamps here.
    this.renderer.clearLights();
    this.vessel.submitLights?.(this.renderer);
    this.player.submitLights?.(this.renderer);
    this.habitat.submitLights?.(this.renderer, this.renderer.camera.position);
    // Bioluminescent creatures are real lights. Submitted after the vessel's so
    // that if the 256-light budget is ever tight it is the fish that lose, not
    // the lamps the player is steering by.
    this.creaturePass.submitLights?.(this.renderer);

    this.renderer.camera.update(
      this.renderer.gpu.renderWidth, this.renderer.gpu.renderHeight, dt);

    this.hud.update(dt, this);
    this.controlsHint.update(dt, this.paused);
    this.jumpMenu.update(dt);
    const habitatPrompt = this.habitat?.prompt(this.player) || '';
    if (this._interactionPromptEl) {
      this._interactionPromptEl.textContent = habitatPrompt;
      this._interactionPromptEl.classList.toggle('show', !!habitatPrompt && !this.jumpMenu.open);
    }
    profiler.cpuEnd('update');

    // --- render -----------------------------------------------------------
    profiler.cpu('render');
    this.renderer.render(this.clock.now, dt);
    profiler.cpuEnd('render');

    // THE SHOWCASE RECORDER READS THE CANVAS HERE AND NOWHERE ELSE. It must be
    // AFTER render() and still inside this rAF callback: a WebGPU swap-chain
    // surface is only readable by drawImage in the window between the frame
    // being drawn and the compositor taking it. Pumping from frameUpdate() at
    // the top of this method - a hundred lines before the draw - is reading a
    // surface that has already been handed off, and it produced a 27 KB, nine
    // second, entirely BLACK mp4 that every other check passed.
    this.demo?.afterRender();

    this._updateStats(dt);
    this.input.endFrame();
  }

  _simulate(dt) {
    if (this.paused) return;
    // THE DEMO'S OWNERSHIP BOUNDARY. While the showcase demo is active the
    // player and the vessel are simulated with the director's VirtualInput -
    // the same query surface, driven by the authored route - instead of the
    // real InputManager. This is a documented MODE (see demo/director.js):
    // entered only by the demo key, exited by G or Escape via the raw-input
    // hook. The director restores ITS OWN save set on exit (day fraction,
    // lamp, camera mode, legend, accumulator/edges, and the parked vessel's
    // pose when unpiloted - the set is enumerated in director.js); what it
    // does NOT undo is what the sanctioned jumpTo cuts inherently do - gear
    // grants, residency resets, player position - the same as any dev-menu
    // jump. beginStep()
    // runs the route's state machine for this step and may execute a cut
    // (game.jumpTo) before the entities move.
    const input = this.demo?.active ? this.demo.beginStep(dt) : this.input;
    // Scatter proxies stream BEFORE the bodies resolve, so a chunk a body just
    // entered is solid on the same step it can first be touched. At most one
    // collidable-only bake per step, chunk crossings only - 1.5-2.8 ms warm,
    // measured worst 8.17 ms (a real one-frame hitch at 120 fps; both arms
    // and the fix direction are at scatter_collision.js's header).
    this.scatterCollision.update(this.player.position, this.vessel.position);
    const inVessel = this.player.inVessel;
    if (inVessel) {
      this.vessel.simulate(dt, input, this.worldClock.totalSeconds);
      this.player.simulateInVessel(dt, this.vessel);
    } else {
      this.player.simulate(dt, input, this.worldClock.totalSeconds);
      this.vessel.simulateUnpiloted(dt, this.worldClock.totalSeconds);
    }
    // Creatures tick inside the fixed step, after the things they react to have
    // moved: the perception layer reads the player's and the vessel's positions
    // and velocities from this frame, not the last one.
    this.creatures.simulate(dt, this._creatureWorld());
    // The authored abyss reveal poses one real Pale Herald only until its close
    // crossing is complete; from then on the normal territorial AI owns it.
    this.abyssEncounter?.update(dt,
      this.player.inVessel ? this.vessel.position : this.player.position);
    // Residencies keep one live apex resident per authored site while the
    // focus is near enough to ever meet it. Population, not script - the
    // territorial AI owns the animal from the moment it exists.
    this.leviathanResidencies?.update(
      this.player.inVessel ? this.vessel.position : this.player.position);
    // The Splitmaw's one authored acknowledgement of the diver: a pose-driven
    // bluff-charge that opens the maw at the lens and releases (see
    // entities/dune_ambush.js). AFTER the residency so a same-tick adoption of
    // a freshly spawned resident works, and after creatures.simulate so its
    // per-tick jawOpen write lands downstream of _animate's pull.
    this.duneAmbush?.update(dt,
      this.player.inVessel ? this.vessel.position : this.player.position);
    // The cave residency is the same idea gated on the focus being INSIDE the
    // cave system - so it can never spawn during a variety tour (no tour eye
    // is ever under a roof) and never before the player has committed to the
    // mouth. The focus's own field query, not the camera's `inCave` flag: the
    // chase camera can be outside a shaft the vessel's occupant is inside.
    this.caveResidencies?.update(dt,
      this.player.inVessel ? this.vessel.position : this.player.position);
    // The station residency is a POD of tier-0 grazers at the Pelagos
    // observatory - the one population the ambient spawner cannot maintain,
    // because it evicts everything inside the habitat envelope. Same
    // population-not-script rule as the two above; it replaced the demo's
    // _stepFauna staging.
    this.stationResidencies?.update(
      this.player.inVessel ? this.vessel.position : this.player.position);
  }

  /**
   * The world state the creature perception layer reads. Assembled into ONE
   * reused object so the sim never sees a fresh shape and the 60 Hz tick
   * allocates nothing.
   */
  _creatureWorld() {
    let w = this._creatureCtx;
    if (!w) {
      w = this._creatureCtx = {
        playerPos: null, playerVel: null, playerAlive: true, playerInVessel: false,
        playerNoise: 0.05, playerFwd: null, vessel: null, camera: null, daylight: 1,
      };
    }
    const p = this.player;
    w.playerPos = p.position;
    w.playerVel = p.velocity;
    w.playerAlive = p.alive !== false;
    w.playerInVessel = p.inVessel;
    // Lateral-line source strength, DESIGN/06.1.8(b): 0.05 floating still,
    // 0.40 swimming at 1.4 m/s, 1.05 sprinting. Interpolated on actual speed
    // rather than on the input, so a drifting player really is quiet - which is
    // the mechanic that makes holding still work.
    const speed = Math.hypot(p.velocity[0], p.velocity[1], p.velocity[2]);
    w.playerNoise = 0.05 + Math.min(speed / 1.4, 1) * 0.35
      + Math.max(0, speed - 1.4) / 2.9 * 0.65;
    w.playerFwd = this.renderer.camera.forward;
    w.vessel = this.vessel;
    w.camera = this.renderer.camera;
    w.daylight = this.worldClock.daylight;
    return w;
  }

  /**
   * Pick the input context for this frame. Runs BEFORE simulation, because the
   * simulation is what reads the bindings.
   */
  /** Show the "click to look" hint exactly when the mouse is not captured. */
  _syncLockHint() {
    const el = document.getElementById('lock-hint');
    if (!el) return;
    // ...and not while the jump menu is up, or "Click to look" sits in the
    // middle of the open menu at z-index 40 for as long as it is open. The
    // showcase demo suppresses it too - nobody should be told to click while
    // the game is flying itself; the next lock transition after the demo ends
    // re-evaluates this and brings the hint back if it is still true.
    const show = this.started && !this.paused
      && !this.jumpMenu?.open && !this.demo?.active && !this.input.pointerLocked;
    el.classList.toggle('show', show);
  }

  _updateInputContext() {
    if (this.player.inVessel) {
      this.input.setContext(this.vessel.underwater ? CONTEXT.VESSEL_WATER : CONTEXT.VESSEL_AIR);
    } else {
      this.input.setContext(this.player.swimming ? CONTEXT.SWIM : CONTEXT.FOOT);
    }
  }

  /**
   * Track the optical properties of the water column the camera is in.
   *
   * `renderer.env.waterType` used to be assigned once in the Renderer constructor
   * and never written again, and `biomes.waterTypeAt()` - the function written to
   * answer exactly this question - was exported and imported by nothing. So the
   * whole ocean, from the lagoon to the hadal trench, rendered in one water type.
   * Measured at 118 m that was 14.8x too dark in scene luminance, because reef
   * coefficients over an abyssal column extinguish 181x more blue than the open
   * ocean actually does.
   *
   * Sprung rather than switched. A biome boundary is a line on a map but an
   * optical water mass changes over minutes, and stepping every coefficient in one
   * frame recolours the entire screen at a position the player can stand astride.
   * This is render state, not generation, so the spring cannot affect determinism.
   */
  /**
   * Snap the water column to the camera's CURRENT surroundings in one step.
   *
   * The spring below exists so a biome edge does not pop, and its 2 s tau is
   * right for a vessel crossing one. It is exactly wrong for a teleport: a jump
   * from the reef to the trench would render the abyss with REEF_TURQUOISE
   * coefficients for two full seconds, which is the same class of error CLAUDE.md
   * measures at 14.8x in scene luminance. A teleport is a discontinuity imposed
   * from OUTSIDE the simulation, like the day/night debug toggle, and gets the
   * same treatment resetAdaptation() gives exposure and TAA.
   *
   * THE POSITION IS AN ARGUMENT, and it has to be. A teleport runs OUTSIDE the
   * frame loop, and `renderer.camera.position` is not written until
   * _updateCamera() on the NEXT frame - so a snap that read the camera would
   * sample where the player just left. Measured doing exactly that: one frame
   * after a spawn-to-kelp jump the green sigmaT was 0.0801 against the correct
   * 0.3025, a 3.8x error, because the column had been "snapped" to the beach and
   * was then springing from there.
   *
   * @param {ArrayLike<number>} [at] absolute position to sample; the camera's
   *   own position when omitted
   */
  snapWaterColumn(at) {
    this._updateWaterColumn(0, 1, at);
  }

  /**
   * @param {number} dt seconds
   * @param {number} [blend] override the spring factor; 1 snaps. See
   *   snapWaterColumn().
   * @param {ArrayLike<number>} [at] position to classify; the camera by default.
   */
  _updateWaterColumn(dt, blend, at) {
    const cam = this.renderer.camera.position;
    const c = at ?? cam;
    const w = this._waterColumn;
    const h = this.terrain.sampleHeightFast(c[0], c[2]);
    // The slope is not optional: waterTypeAt used to force it to 0, which made
    // the flat biomes win everywhere and cost the ocean two thirds of its biome
    // catalogue. sampleSlope's own 2 m epsilon is the span the bake classifies
    // over, so this asks the same question the mesh under the camera answered.
    const slope = this.terrain.sampleSlope(c[0], c[2]);
    // THE CATEGORICAL TARGET DWELLS; THE SPRING BELOW IS UNTOUCHED. The
    // classifier's spatial smoothing (WORLD.WATER_TYPE_SMOOTH_RADIUS) is
    // radius-limited, and what survives it is patch-scale minority water a
    // moving eye crosses in under two seconds - the dive-coral corridor
    // measured Kelp Coastal patches of 0.5-1.0 s inside reef water
    // (tools/probes/coral-corridor.mjs). The colour spring cannot absorb
    // those because it RETARGETS on frame one and `w.id` (which indexes
    // WATER_BOTTOM_ALBEDO) snaps with it. So a DIFFERING answer must hold
    // for WORLD.WATER_TYPE_DWELL seconds before it becomes the target; the
    // committed row is held by identity (WATER_TYPES rows are static).
    // Explicit snaps - `at` from snapWaterColumn, or blend 1 from teleports
    // and jumps - commit immediately and reset the candidate, same as
    // resetAdaptation. Dwell 0 is the undwelled build exactly. This replaced
    // the demo's waterColumnPin: free play stopped flickering, so the
    // showcase no longer needs to lie.
    const raw = waterTypeAt(c[0], c[2], h, Math.max(0, -c[1]), slope, this.terrain);
    if (at || blend === 1 || this._waterTypeHeld === null
        || WORLD.WATER_TYPE_DWELL <= 0) {
      this._waterTypeHeld = raw;
      this._waterCandType = null;
    } else if (raw !== this._waterTypeHeld) {
      if (this._waterCandType !== raw) { this._waterCandType = raw; this._waterCandT = 0; }
      this._waterCandT += dt;
      if (this._waterCandT >= WORLD.WATER_TYPE_DWELL) {
        this._waterTypeHeld = raw;
        this._waterCandType = null;
      }
    } else {
      this._waterCandType = null;
    }
    const target = this._waterTypeHeld;
    const k = blend ?? (1 - Math.exp(-dt / RENDER.WATER_BLEND_TAU));
    for (let i = 0; i < 3; i++) {
      w.sigmaT[i] += (target.sigmaT[i] - w.sigmaT[i]) * k;
      w.sigmaS[i] += (target.sigmaS[i] - w.sigmaS[i]) * k;
      w.sigmaA[i] += (target.sigmaA[i] - w.sigmaA[i]) * k;
      w.Kd[i] += (target.Kd[i] - w.Kd[i]) * k;
      w.surfaceSigmaA[i] += (target.surfaceSigmaA[i] - w.surfaceSigmaA[i]) * k;
      w.surfaceKd[i] += (target.surfaceKd[i] - w.surfaceKd[i]) * k;
      w.deepTint[i] += (target.deepTint[i] - w.deepTint[i]) * k;
    }
    w.g += (target.g - w.g) * k;
    // SPRING EVERY QUANTITY THAT REACHES A PIXEL, not just the colour ones. The
    // snow multiplier used to snap while the colour sprung, and with the slope
    // restored the classification is a high-frequency quantity - it changes 30
    // times per km over the kelp bed against 0.5 before - so the marine snow was
    // stepping 0 <-> 0.15 in one frame at every crossing while the water it is
    // suspended in took two seconds to catch up. `visibility` is informational
    // today and is sprung with it so the two cannot drift apart.
    w.visibility += (target.visibility - w.visibility) * k;
    // Per-type medium chromaticity, sprung for the same reason as everything
    // above it: a snap at the kelp boundary would step the whole spectrum's
    // flattening in one frame.
    w.chroma += ((target.chroma ?? 1) - w.chroma) * k;
    // CAVE INTERIORS ARE STILL WATER. The snow field is authored per water
    // TYPE, i.e. for the open column above the roof; a sealed chamber has
    // neither the detritus rain nor the current that suspends it. Scaling the
    // spring TARGET (never the sprung value) keeps the mouth transition on the
    // same WATER_BLEND_TAU spring as every other optical quantity, and
    // RENDER.CAVE_SNOW_REDUCTION = 0 reproduces the open-water image exactly.
    // `this.inCave` is written each frame right after _updateCamera, so on
    // the CONTINUOUS path the flag this reads is the current frame's camera.
    // On a SNAP (`at` passed, teleport/jump) it is one frame stale - the
    // pre-jump camera's answer - and with blend 1 that stale answer used to
    // be latched into every cave-medium spring at once: a jump INTO the
    // chamber snapped enclosure, sight-chroma neutralisation and the depth
    // grade to their open-water values and then crawled back over the
    // 2 s spring (the 2026-08-18 review's finding 3: the arrival
    // photographs a half-drained indigo transition, the exact failure the
    // neutralisation exists to prevent). A snap must classify the
    // DESTINATION, exactly as snapWaterColumn classifies the destination's
    // water. See the knob's docstring in core/constants.js for why snow is
    // the one term left to cut here.
    const inCaveNow = at
      ? this.caves.isInsideCave(at[0], at[1], at[2])
      : this.inCave;
    const caveSnow = inCaveNow ? 1 - clamp(RENDER.CAVE_SNOW_REDUCTION, 0, 1) : 1;
    w.snowMultiplier += (target.snowMultiplier * caveSnow - w.snowMultiplier) * k;
    // The enclosure drain rides the SAME spring, for the same reason - the
    // review measured the flag-driven binary step strobing 85% of a shallow
    // mouth's light in one frame. Target folds the knob in, so the shader
    // reads one 0..1 scalar and 0 is exactly the open-water image.
    const encTarget = inCaveNow ? clamp(RENDER.CAVE_ENCLOSURE, 0, 1) : 0;
    this.renderer.caveEnclosure += (encTarget - this.renderer.caveEnclosure) * k;
    // The local haze chromaticity, on the same spring. This is the SECOND
    // consumer of the slope, and it wants the blended answer rather than the
    // dominant one: fogTint is the colour of a volume the player is inside, and
    // at a boundary they really are inside a mixture. materialAt() already
    // weight-averages it across every biome present, which is why this reads
    // the blend and `waterTypeAt` above reads a category.
    const mat = materialAt(c[0], c[2], h, slope);
    const ft = this._fogTint;
    for (let i = 0; i < 3; i++) ft[i] += (mat.fogTint[i] - ft[i]) * k;
    // Visibility is authored by the dominant biome, then temporally sprung.
    // Spatial averaging diluted Shelf Break's 0.40 target to 0.70 at its own
    // curated arrival because its wide feathers overlap Rock Spires; the whole
    // point of this control is for the named biome to reach its named range.
    // The same 2 s spring that protects the optical column prevents a boundary
    // pop even when the dominant classification changes.
    const sightTarget = BIOMES[mat.biome].sightDensity;
    this._sightDensity += (sightTarget - this._sightDensity) * k;
    this.renderer.env.sightDensity = this._sightDensity;
    // The id and the name are the CLASSIFICATION, not the column, so they snap:
    // there is no meaningful value between two water types and nothing reads
    // them as one (the shaders take Kd's w slot for the id and never use it).
    // qa.mjs asserts on this id, which is therefore a claim about what
    // waterTypeAt returned this frame and not about what the pixels are made of
    // - that is what expectGreenDominant is for.
    w.id = target.id;
    w.name = target.name;
    // Suspended-matter load, which is what the snow density actually keys on.
    this.renderer.env.turbidity = clamp((w.snowMultiplier - 1) * 0.25, 0, 1);
  }

  _updateCamera(dt, alpha) {
    const cam = this.renderer.camera;
    cam.dryInterior = !this.player.inVessel && !!this.player.inHabitat;
    if (this.player.inVessel) {
      // applyCamera resolves the vessel's drawn transform itself, so that the eye
      // and the mesh are built from one value and cannot separate.
      this.vessel.applyCamera(cam, alpha, dt);
      this.rig.targetFov = this.vessel.cameraFov;
    } else {
      // A parked vessel is still drawn, so it still needs its render transform -
      // and on these frames applyCamera is not the one to produce it.
      this.vessel.applyRender(alpha);
      this.player.applyCamera(cam, alpha);
      this.rig.targetFov = this.player.cameraFov;
      this.rig.updateBob(dt, this.player.bobIntensity, this.player.grounded);
    }
    this.rig.apply(dt);
  }

  _updateStats(dt) {
    const el = this._statsEl;
    if (!el) return;
    const show = settings.get('showFps');
    el.classList.toggle('show', show);
    if (!show) return;

    this._statsAccum += dt;
    if (this._statsAccum < 0.25) return;
    this._statsAccum = 0;

    const c = this.clock;
    const cam = this.renderer.camera;
    const lines = [
      `${c.fps.toFixed(0)} fps   ${(c.smoothedDt * 1000).toFixed(2)} ms   p99 ${c.percentile(0.99).toFixed(1)} ms`,
      `pos ${cam.position[0].toFixed(0)} ${cam.position[1].toFixed(1)} ${cam.position[2].toFixed(0)}   depth ${cam.depth.toFixed(1)} m`,
      `${this.worldClock.formatted()}   ${TIER_NAMES[this.renderer.gpu.tier]}   ${this.renderer.gpu.renderWidth}x${this.renderer.gpu.renderHeight}`,
      `chunks ${this.chunks.loadedCount ?? 0}   lights ${this.renderer.lightCount}`,
      `creatures ${this.creatures.count} (${this.creaturePass.stats.instances} drawn, ` +
      `${this.creaturePass.stats.draws} draws)   ai ${this.creatures.stats.msLast.toFixed(2)} ms`,
    ];
    // The GPU row prints the SPAN, not the scope sum, and prints the refusal
    // when there is one. It was `if (gpu > 0)` against `profiler.gpuTotal`, and
    // once that getter started refusing with NaN the comparison went false and
    // the whole row silently disappeared - which reads as "the GPU is not
    // instrumented", the exact opposite of "the instrument caught itself
    // lying". `gpuFrameSpan` is measured; see profiler.gpuTotal for why nothing
    // else here is a cost.
    if (!profiler.gpuAvailable) {
      lines.push('gpu (timestamp-query unavailable)');
    } else {
      const span = profiler.gpuFrameSpan;
      const why = profiler.gpuTotalRefusal();
      lines.push(`gpu span ${Number.isFinite(span) ? `${span.toFixed(2)} ms` : '--'}` +
        (why ? '   (no total)' : `   total ${profiler.gpuTotal.toFixed(2)} ms`));
      if (why) lines.push(`  ${why}`);
    }
    el.textContent = lines.join('\n');
  }

  destroy() {
    this.running = false;
    cancelAnimationFrame(this._rafHandle);
    // Stop the showcase FIRST: it restores latches this teardown would otherwise
    // leave set, and if it is recording, its stop() is what flushes the encoder
    // and saves the file. A destroy with a live MediaRecorder loses the take.
    this.demo?.stop('destroy');
    this.input.destroy();
    this.habitat?.destroy();
    this.caveChunks?.destroy();
    this.renderer.destroy();
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const game = new Game();
// Exposed for the QA harness and for debugging from the console.
window.subwave = game;

try {
  await game.boot();

  const startButton = document.getElementById('boot-start');
  const bootScreen = document.getElementById('boot');
  startButton.classList.add('ready');

  const begin = () => {
    startButton.removeEventListener('click', begin);
    bootScreen.classList.add('hidden');
    // The Web Audio context can only start from a user gesture.
    game.audio?.resume?.();
    game.start();
  };
  startButton.addEventListener('click', begin);
} catch (err) {
  console.error('[subwave] boot failed:', err);
  if (err instanceof UnsupportedError) {
    window.__subwaveFatal?.('Cannot start', err.message, err.detail);
  } else {
    window.__subwaveFatal?.(
      'Boot failed',
      'SUBWAVE could not start. The error below is the place to look.',
      err.stack || String(err),
    );
  }
}
