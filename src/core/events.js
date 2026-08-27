/**
 * SUBWAVE event bus.
 *
 * One global, synchronous, allocation-free-on-emit pub/sub. Systems that must
 * not know about each other (audio reacting to gameplay, UI reacting to
 * physics, the director reacting to the player) communicate exclusively here.
 *
 * Rules:
 *   - Event names are declared in EVENTS below. Emitting an undeclared name in
 *     dev mode logs a warning; this catches typos immediately.
 *   - Handlers must not throw. If one does, it is caught and logged so a single
 *     bad listener cannot kill the frame.
 *   - Handlers must not unsubscribe other handlers of the same event during
 *     dispatch; the listener array is snapshotted per emit to make that safe.
 */

/**
 * Canonical event catalogue. The comment on each line documents its payload.
 * Keep alphabetised within groups.
 */
export const EVENTS = {
  // --- lifecycle ---------------------------------------------------------
  BOOT_PROGRESS: 'boot:progress',           // {stage: string, t: number 0..1}
  BOOT_COMPLETE: 'boot:complete',           // {}
  GAME_START: 'game:start',                 // {seed: number, isNewGame: boolean}
  GAME_PAUSE: 'game:pause',                 // {paused: boolean}
  GAME_SAVE: 'game:save',                   // {slot: string}
  GAME_LOAD: 'game:load',                   // {slot: string}
  DEVICE_LOST: 'gpu:lost',                  // {reason: string, message: string}
  QUALITY_CHANGED: 'gfx:quality',           // {tier: number, name: string}
  RESIZE: 'gfx:resize',                     // {width, height, renderWidth, renderHeight}

  // --- player ------------------------------------------------------------
  PLAYER_SPAWN: 'player:spawn',             // {position: vec3}
  PLAYER_DEATH: 'player:death',             // {cause: string, position: vec3}
  PLAYER_RESPAWN: 'player:respawn',         // {position: vec3}
  PLAYER_DAMAGE: 'player:damage',           // {amount: number, source: string, direction: vec3}
  PLAYER_HEAL: 'player:heal',               // {amount: number}
  PLAYER_ENTER_WATER: 'player:enterWater',  // {speed: number, position: vec3}
  PLAYER_EXIT_WATER: 'player:exitWater',    // {speed: number, position: vec3}
  PLAYER_DEPTH_BAND: 'player:depthBand',    // {band: number, previous: number, depth: number}
  PLAYER_OXYGEN_LOW: 'player:oxygenLow',    // {seconds: number, tier: 'warn'|'critical'|'empty'}
  PLAYER_OXYGEN_REFILL: 'player:oxygenRefill', // {source: string}
  PLAYER_STAMINA_EMPTY: 'player:staminaEmpty', // {}
  PLAYER_FOOTSTEP: 'player:footstep',       // {material: string, position: vec3, speed: number}
  PLAYER_SWIM_STROKE: 'player:swimStroke',  // {position: vec3, effort: number}

  // --- vessel ------------------------------------------------------------
  VESSEL_ENTER: 'vessel:enter',             // {underwater: boolean}
  VESSEL_EXIT: 'vessel:exit',               // {underwater: boolean, position: vec3}
  VESSEL_ENTER_WATER: 'vessel:enterWater',  // {speed: number, position: vec3, angle: number}
  VESSEL_EXIT_WATER: 'vessel:exitWater',    // {speed: number, position: vec3}
  VESSEL_SKIP: 'vessel:skip',               // {speed: number, position: vec3} - skipped off the surface
  VESSEL_LIGHT_TOGGLE: 'vessel:light',      // {group: string, on: boolean}
  VESSEL_DAMAGE: 'vessel:damage',           // {amount: number, subsystem: string, source: string}
  VESSEL_SUBSYSTEM_FAIL: 'vessel:subsystemFail', // {subsystem: string}
  VESSEL_REPAIRED: 'vessel:repaired',       // {subsystem: string}
  VESSEL_POWER_LOW: 'vessel:powerLow',      // {fraction: number}
  VESSEL_DEPTH_WARNING: 'vessel:depthWarning', // {depth: number, rating: number, severity: number}
  VESSEL_HULL_CREAK: 'vessel:creak',        // {depth: number, intensity: number}
  VESSEL_COLLIDE: 'vessel:collide',         // {speed: number, normal: vec3, material: string}
  VESSEL_UPGRADE: 'vessel:upgrade',         // {id: string, tier: number}
  VESSEL_SONAR_PING: 'vessel:sonarPing',    // {range: number}
  VESSEL_SONAR_CONTACT: 'vessel:sonarContact', // {id, distance, bearing, size, hostile}
  VESSEL_RECALL: 'vessel:recall',           // {}

  // --- creatures ---------------------------------------------------------
  CREATURE_SPAWN: 'creature:spawn',         // {id: number, species: string, position: vec3}
  CREATURE_DESPAWN: 'creature:despawn',     // {id: number, species: string}
  CREATURE_AGGRO: 'creature:aggro',         // {id, species, target: 'player'|'vessel', distance}
  CREATURE_CALM: 'creature:calm',           // {id, species}
  CREATURE_ATTACK: 'creature:attack',       // {id, species, target, damage, position}
  CREATURE_VOCALIZE: 'creature:vocalize',   // {id, species, position, distance, kind}
  CREATURE_DETERRED: 'creature:deterred',   // {id, species, method}
  CREATURE_SCANNED: 'creature:scanned',     // {species, complete: boolean}
  LEVIATHAN_NEARBY: 'leviathan:nearby',     // {species, distance, bearing}
  LEVIATHAN_ROAR: 'leviathan:roar',         // {species, distance, position}

  // --- world -------------------------------------------------------------
  CHUNK_LOADED: 'world:chunkLoaded',        // {cx, cz, lod}
  CHUNK_UNLOADED: 'world:chunkUnloaded',    // {cx, cz}
  BIOME_ENTER: 'world:biomeEnter',          // {biome: string, previous: string}
  LANDMARK_DISCOVERED: 'world:landmark',    // {id: string, name: string}
  WEATHER_CHANGE: 'world:weather',          // {state: string, previous: string, wind: number}
  TIME_KEY: 'world:timeKey',                // {key: 'sunrise'|'noon'|'sunset'|'midnight'}
  TERRAIN_DEFORMED: 'world:terrainDeformed', // {position: vec3, radius: number}

  // --- gameplay ----------------------------------------------------------
  RESOURCE_MINED: 'game:mined',             // {material: string, amount: number, position: vec3}
  ITEM_ACQUIRED: 'game:itemAcquired',       // {id: string, count: number}
  ITEM_DROPPED: 'game:itemDropped',         // {id: string, count: number}
  INVENTORY_FULL: 'game:inventoryFull',     // {id: string}
  CRAFT_START: 'game:craftStart',           // {recipe: string, seconds: number}
  CRAFT_COMPLETE: 'game:craftComplete',     // {recipe: string, output: string}
  SCAN_START: 'game:scanStart',             // {target: string}
  SCAN_COMPLETE: 'game:scanComplete',       // {target: string, newEntry: boolean}
  DATABANK_UNLOCK: 'game:databank',         // {id: string, title: string}
  RECIPE_UNLOCK: 'game:recipeUnlock',       // {id: string}
  OBJECTIVE_UPDATE: 'game:objective',       // {id: string, state: string}
  BEACON_PLACED: 'game:beaconPlaced',       // {id, position, label}
  DEPTH_RECORD: 'game:depthRecord',         // {depth: number}

  // --- ui / audio --------------------------------------------------------
  UI_SCREEN: 'ui:screen',                   // {screen: string, previous: string}
  UI_TOAST: 'ui:toast',                     // {text: string, kind: 'info'|'warn'|'good', seconds: number}
  UI_PROMPT: 'ui:prompt',                   // {text: string|null, key: string}
  AUDIO_SUBMERGE: 'audio:submerge',         // {submerged: boolean, depth: number}
  AUDIO_STINGER: 'audio:stinger',           // {id: string, intensity: number}
  MUSIC_STATE: 'music:state',               // {state: string, intensity: number}
};

const VALID = new Set(Object.values(EVENTS));

export class EventBus {
  constructor({ strict = true } = {}) {
    /** @type {Map<string, Function[]>} */
    this.listeners = new Map();
    this.strict = strict;
    this.emitCount = 0;
    /** Ring buffer of recent events, for the debug overlay. */
    this.history = [];
    this.historyLimit = 200;
    this.recordHistory = false;
  }

  /** Subscribe. Returns an unsubscribe function. */
  on(event, handler) {
    if (this.strict && !VALID.has(event)) {
      console.warn(`[events] subscribing to undeclared event '${event}' - add it to EVENTS`);
    }
    let arr = this.listeners.get(event);
    if (!arr) { arr = []; this.listeners.set(event, arr); }
    arr.push(handler);
    return () => this.off(event, handler);
  }

  /** Subscribe for a single dispatch. */
  once(event, handler) {
    const wrapper = (payload) => {
      this.off(event, wrapper);
      handler(payload);
    };
    return this.on(event, wrapper);
  }

  off(event, handler) {
    const arr = this.listeners.get(event);
    if (!arr) return;
    const i = arr.indexOf(handler);
    if (i >= 0) arr.splice(i, 1);
    if (arr.length === 0) this.listeners.delete(event);
  }

  /** Fire an event. Payload objects are NOT copied - do not retain them. */
  emit(event, payload) {
    if (this.strict && !VALID.has(event)) {
      console.warn(`[events] emitting undeclared event '${event}' - add it to EVENTS`);
    }
    this.emitCount++;
    if (this.recordHistory) {
      this.history.push({ event, payload, t: performance.now() });
      if (this.history.length > this.historyLimit) this.history.shift();
    }
    const arr = this.listeners.get(event);
    if (!arr || arr.length === 0) return;
    // Snapshot so handlers can safely unsubscribe during dispatch.
    const snapshot = arr.length === 1 ? arr : arr.slice();
    for (let i = 0; i < snapshot.length; i++) {
      try {
        snapshot[i](payload);
      } catch (err) {
        console.error(`[events] handler for '${event}' threw:`, err);
      }
    }
  }

  /** Remove every listener for an event, or all listeners if omitted. */
  clear(event) {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
  }

  listenerCount(event) {
    return this.listeners.get(event)?.length || 0;
  }

  /** Diagnostics: which events have listeners, and how many. */
  describe() {
    const out = {};
    for (const [k, v] of this.listeners) out[k] = v.length;
    return out;
  }
}

/** The single bus every system shares. */
export const events = new EventBus();

// Convenience re-exports so call sites read as `on(EVENTS.X, ...)`.
export const on = (e, h) => events.on(e, h);
export const once = (e, h) => events.once(e, h);
export const off = (e, h) => events.off(e, h);
export const emit = (e, p) => events.emit(e, p);
