/**
 * SUBWAVE settings.
 *
 * One flat, versioned, schema-validated settings object persisted to
 * localStorage. Every option declares its type, range and default here, which
 * means the options UI can be generated from the schema rather than hand-built,
 * and a corrupt or outdated save can never inject a bad value.
 */

import { clamp } from './math.js';
import { TIER, TIER_NAMES } from './gpu.js';
import { events, EVENTS } from './events.js';

const STORAGE_KEY = 'subwave.settings.v1';
export const SETTINGS_VERSION = 1;

/**
 * Schema. `kind` drives the UI widget:
 *   'enum'   -> segmented control / dropdown (options list)
 *   'range'  -> slider (min, max, step, optional format)
 *   'bool'   -> toggle
 *   'int'    -> stepper
 */
export const SCHEMA = {
  // ---- graphics ---------------------------------------------------------
  qualityTier: {
    group: 'graphics', label: 'Quality preset', kind: 'enum',
    options: ['auto', ...TIER_NAMES], default: 'auto',
    help: 'Auto picks a preset from your GPU. Changing this rebuilds render targets.',
  },
  resolutionScale: {
    group: 'graphics', label: 'Resolution scale', kind: 'range',
    min: 0.5, max: 1.5, step: 0.05, default: 1.0, format: (v) => `${Math.round(v * 100)}%`,
  },
  fieldOfView: {
    group: 'graphics', label: 'Field of view', kind: 'range',
    min: 60, max: 110, step: 1, default: 75, format: (v) => `${v}°`,
  },
  taa: { group: 'graphics', label: 'Temporal anti-aliasing', kind: 'bool', default: true },
  ssr: { group: 'graphics', label: 'Screen-space reflections', kind: 'bool', default: true },
  ssao: { group: 'graphics', label: 'Ambient occlusion', kind: 'bool', default: true },
  volumetricClouds: { group: 'graphics', label: 'Volumetric clouds', kind: 'bool', default: true },
  // Read by render/passes/volumetrics.js's enabled(), which is in turn what
  // FLAG_VOLUMETRICS_ON is packed from - so turning this off puts the collimated
  // beam back into the analytic model in the same frame rather than deleting it
  // from both sides. It declared this key and NOTHING read it for the life of
  // the project, while the flag itself was wired to the volumetric-CLOUD preset.
  volumetricLight: {
    group: 'graphics', label: 'Volumetric light & god rays', kind: 'bool', default: true,
    help: 'Sun shafts underwater and lamp cones in the water and the air. Off saves ~0.1 ms.',
  },
  caustics: { group: 'graphics', label: 'Caustics', kind: 'bool', default: true },
  marineSnow: { group: 'graphics', label: 'Marine snow & particulate', kind: 'bool', default: true },
  motionBlur: { group: 'graphics', label: 'Motion blur', kind: 'range', min: 0, max: 1, step: 0.05, default: 0.35 },
  bloom: { group: 'graphics', label: 'Bloom', kind: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  filmGrain: { group: 'graphics', label: 'Film grain', kind: 'range', min: 0, max: 1, step: 0.05, default: 0.25 },
  chromaticAberration: { group: 'graphics', label: 'Chromatic aberration', kind: 'range', min: 0, max: 1, step: 0.05, default: 0.4 },
  lensWater: { group: 'graphics', label: 'Water droplets on lens', kind: 'bool', default: true },
  /**
   * Draw the vessel's own geometry from the cockpit.
   *
   * OFF by default: the cockpit view is meant to be an unobstructed window onto
   * the world with only the windshield HUD over it, and the interior coaming
   * occupied roughly a third of the frame. Turning it ON draws the whole vessel
   * again - which is all-or-nothing on purpose, because the coaming is what
   * occludes the nacelles, and they sit inside the frame by three degrees.
   */
  cockpitInterior: { group: 'graphics', label: 'Cockpit interior', kind: 'bool', default: false },
  // A TAA resolve is a 1-pixel box: 0.900 of contrast at half-Nyquist and 0.637 at
  // Nyquist even fully converged and still. Every renderer that runs TAA sharpens
  // that back; this one had no sharpening filter of any kind.
  sharpness: { group: 'graphics', label: 'Sharpness', kind: 'range', min: 0, max: 1, step: 0.05, default: 0.5 },
  viewDistanceScale: {
    group: 'graphics', label: 'View distance', kind: 'range',
    min: 0.5, max: 1.5, step: 0.05, default: 1.0, format: (v) => `${Math.round(v * 100)}%`,
  },
  vsync: { group: 'graphics', label: 'Frame rate cap', kind: 'enum', options: ['vsync', '30', '60', '120', 'uncapped'], default: 'vsync' },
  exposureCompensation: { group: 'graphics', label: 'Exposure', kind: 'range', min: -2, max: 2, step: 0.1, default: 0, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} EV` },

  // ---- audio ------------------------------------------------------------
  masterVolume: { group: 'audio', label: 'Master', kind: 'range', min: 0, max: 1, step: 0.01, default: 0.85 },
  ambienceVolume: { group: 'audio', label: 'Ambience', kind: 'range', min: 0, max: 1, step: 0.01, default: 0.9 },
  creatureVolume: { group: 'audio', label: 'Creatures', kind: 'range', min: 0, max: 1, step: 0.01, default: 1.0 },
  vesselVolume: { group: 'audio', label: 'Vessel', kind: 'range', min: 0, max: 1, step: 0.01, default: 0.8 },
  musicVolume: { group: 'audio', label: 'Music', kind: 'range', min: 0, max: 1, step: 0.01, default: 0.55 },
  uiVolume: { group: 'audio', label: 'Interface', kind: 'range', min: 0, max: 1, step: 0.01, default: 0.7 },
  monoAudio: { group: 'audio', label: 'Mono output', kind: 'bool', default: false },
  dynamicRange: { group: 'audio', label: 'Dynamic range', kind: 'enum', options: ['full', 'night', 'compressed'], default: 'full' },

  // ---- controls ---------------------------------------------------------
  mouseSensitivity: { group: 'controls', label: 'Mouse sensitivity', kind: 'range', min: 0.2, max: 3.0, step: 0.05, default: 1.0 },
  invertY: { group: 'controls', label: 'Invert vertical look', kind: 'bool', default: false },
  mouseSmoothing: { group: 'controls', label: 'Mouse smoothing', kind: 'range', min: 0, max: 0.9, step: 0.05, default: 0 },
  padSensitivity: { group: 'controls', label: 'Gamepad sensitivity', kind: 'range', min: 0.2, max: 3.0, step: 0.05, default: 1.0 },
  padDeadzone: { group: 'controls', label: 'Gamepad deadzone', kind: 'range', min: 0.02, max: 0.4, step: 0.01, default: 0.16 },
  rumble: { group: 'controls', label: 'Gamepad rumble', kind: 'bool', default: true },
  holdToSprint: { group: 'controls', label: 'Hold to sprint', kind: 'bool', default: true },
  holdToInteract: { group: 'controls', label: 'Hold to interact', kind: 'bool', default: false },

  // ---- accessibility ----------------------------------------------------
  headBob: { group: 'accessibility', label: 'Head bob', kind: 'range', min: 0, max: 1, step: 0.05, default: 0.6 },
  cameraShake: { group: 'accessibility', label: 'Camera shake', kind: 'range', min: 0, max: 1, step: 0.05, default: 1.0 },
  fovKick: { group: 'accessibility', label: 'Speed FOV effect', kind: 'range', min: 0, max: 1, step: 0.05, default: 1.0 },
  // Also the artistic vignette control - there is no separate one - which is why
  // it defaults low. The cos^4 law in lens.wgsl is applied AFTER the exposure
  // histogram meters, so at 1.0 it silently removed 48.4% of every frame's light
  // with nothing to compensate, and on the smooth underwater gradients it was 91%
  // of all the structure visible in the frame.
  vignette: { group: 'accessibility', label: 'Vignette', kind: 'range', min: 0, max: 1, step: 0.05, default: 0.22 },
  flashReduction: { group: 'accessibility', label: 'Reduce flashing', kind: 'bool', default: false,
    help: 'Caps lightning, strobes and damage flashes. Recommended if you are photosensitive.' },
  colorBlindMode: { group: 'accessibility', label: 'Colour vision', kind: 'enum', options: ['none', 'protanopia', 'deuteranopia', 'tritanopia'], default: 'none' },
  subtitles: { group: 'accessibility', label: 'Audio cue subtitles', kind: 'bool', default: false,
    help: 'Shows text for creature calls and important sounds you might miss.' },
  hudScale: { group: 'accessibility', label: 'HUD scale', kind: 'range', min: 0.75, max: 1.5, step: 0.05, default: 1.0 },
  hudOpacity: { group: 'accessibility', label: 'HUD opacity', kind: 'range', min: 0.3, max: 1, step: 0.05, default: 1.0 },
  threatIndicator: { group: 'accessibility', label: 'Directional threat indicator', kind: 'bool', default: true },

  // ---- gameplay ---------------------------------------------------------
  difficulty: { group: 'gameplay', label: 'Difficulty', kind: 'enum', options: ['relaxed', 'standard', 'harsh'], default: 'standard',
    help: 'Relaxed slows oxygen use and disables item loss on death. Harsh does the opposite.' },
  oxygenRateScale: { group: 'gameplay', label: 'Oxygen consumption', kind: 'range', min: 0.5, max: 1.5, step: 0.05, default: 1.0 },
  creatureAggression: { group: 'gameplay', label: 'Creature aggression', kind: 'range', min: 0.25, max: 1.5, step: 0.05, default: 1.0 },
  showTutorialPrompts: { group: 'gameplay', label: 'Tutorial prompts', kind: 'bool', default: true },
  autosaveMinutes: { group: 'gameplay', label: 'Autosave interval', kind: 'int', min: 0, max: 30, step: 1, default: 5,
    format: (v) => (v === 0 ? 'off' : `${v} min`) },
  showFps: { group: 'gameplay', label: 'Show performance stats', kind: 'bool', default: false },
};

export const GROUPS = ['graphics', 'audio', 'controls', 'accessibility', 'gameplay'];
export const GROUP_LABELS = {
  graphics: 'Graphics',
  audio: 'Audio',
  controls: 'Controls',
  accessibility: 'Accessibility',
  gameplay: 'Gameplay',
};

function coerce(key, value) {
  const s = SCHEMA[key];
  if (!s) return undefined;
  switch (s.kind) {
    case 'bool':
      return !!value;
    case 'enum':
      return s.options.includes(value) ? value : s.default;
    case 'int': {
      const n = Math.round(Number(value));
      return Number.isFinite(n) ? clamp(n, s.min, s.max) : s.default;
    }
    case 'range': {
      const n = Number(value);
      return Number.isFinite(n) ? clamp(n, s.min, s.max) : s.default;
    }
    default:
      return value;
  }
}

export class Settings {
  constructor() {
    this.values = {};
    for (const k of Object.keys(SCHEMA)) this.values[k] = SCHEMA[k].default;
    /** Key bindings live alongside the settings but have their own shape. */
    this.bindings = null;
    this._listeners = new Set();
    this._saveTimer = 0;
  }

  get(key) { return this.values[key]; }

  set(key, value) {
    const v = coerce(key, value);
    if (v === undefined) {
      console.warn(`[settings] unknown key '${key}'`);
      return;
    }
    if (this.values[key] === v) return;
    const prev = this.values[key];
    this.values[key] = v;
    for (const fn of this._listeners) {
      try { fn(key, v, prev); } catch (e) { console.error(e); }
    }
    this.saveDebounced();
  }

  /** Subscribe to any change. Returns an unsubscribe function. */
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  reset(key) {
    if (key) this.set(key, SCHEMA[key].default);
    else for (const k of Object.keys(SCHEMA)) this.set(k, SCHEMA[k].default);
  }

  resetGroup(group) {
    for (const k of Object.keys(SCHEMA)) {
      if (SCHEMA[k].group === group) this.set(k, SCHEMA[k].default);
    }
  }

  keysInGroup(group) {
    return Object.keys(SCHEMA).filter((k) => SCHEMA[k].group === group);
  }

  /** Format a value for display using the schema's formatter. */
  display(key) {
    const s = SCHEMA[key];
    const v = this.values[key];
    if (s.format) return s.format(v);
    if (s.kind === 'bool') return v ? 'On' : 'Off';
    if (s.kind === 'range') return v.toFixed(2);
    return String(v);
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (parsed.version !== SETTINGS_VERSION) {
        console.info('[settings] version changed; using defaults');
        return false;
      }
      for (const k of Object.keys(parsed.values || {})) {
        const v = coerce(k, parsed.values[k]);
        if (v !== undefined) this.values[k] = v;
      }
      this.bindings = parsed.bindings || null;
      return true;
    } catch (err) {
      console.warn('[settings] load failed:', err);
      return false;
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: SETTINGS_VERSION,
        values: this.values,
        bindings: this.bindings,
      }));
    } catch (err) {
      console.warn('[settings] save failed:', err);
    }
  }

  saveDebounced() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.save(), 400);
  }

  // -------------------------------------------------------------------------
  // Application to subsystems
  // -------------------------------------------------------------------------

  /** Resolve the 'auto' quality preset against the GPU's own detection. */
  resolveTier(gpu) {
    const q = this.values.qualityTier;
    if (q === 'auto') return gpu.autoDetectTier();
    const i = TIER_NAMES.indexOf(q);
    return i >= 0 ? i : TIER.HIGH;
  }

  applyToGPU(gpu) {
    const tier = this.resolveTier(gpu);
    const changed = tier !== gpu.tier;
    gpu.setTier(tier);
    gpu.setResolutionScale(this.values.resolutionScale);
    if (changed) {
      events.emit(EVENTS.QUALITY_CHANGED, { tier, name: TIER_NAMES[tier] });
    }
    return changed;
  }

  applyToInput(input) {
    // The schema exposes a 1.0-centred multiplier; the manager wants radians/pixel.
    input.mouseSensitivity = 0.0022 * this.values.mouseSensitivity;
    input.padLookSensitivity = 2.4 * this.values.padSensitivity;
    input.invertY = this.values.invertY;
    input.mouseSmoothing = this.values.mouseSmoothing;
    input.padDeadzone = this.values.padDeadzone;
    if (this.bindings) input.loadBindings(this.bindings);
  }

  captureBindings(input) {
    this.bindings = input.serializeBindings();
    this.saveDebounced();
  }

  /** Difficulty multipliers derived from the difficulty enum. */
  get difficultyProfile() {
    switch (this.values.difficulty) {
      case 'relaxed':
        return { oxygenScale: 0.75, damageTaken: 0.6, loseItemsOnDeath: false, aggression: 0.7, vesselDamage: 0.6 };
      case 'harsh':
        return { oxygenScale: 1.25, damageTaken: 1.5, loseItemsOnDeath: true, aggression: 1.3, vesselDamage: 1.4 };
      default:
        return { oxygenScale: 1.0, damageTaken: 1.0, loseItemsOnDeath: true, aggression: 1.0, vesselDamage: 1.0 };
    }
  }

  /** Target frame interval in ms, or 0 for uncapped/vsync. */
  get frameCapMs() {
    const v = this.values.vsync;
    if (v === 'vsync' || v === 'uncapped') return 0;
    const fps = Number(v);
    return Number.isFinite(fps) && fps > 0 ? 1000 / fps : 0;
  }
}

export const settings = new Settings();
