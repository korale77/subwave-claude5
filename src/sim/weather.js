/**
 * SUBWAVE weather.
 *
 * A Markov chain over the WEATHER table, sampled once per game hour, driving a
 * set of critically damped springs. Two properties matter more than anything
 * else here:
 *
 *   NEVER SNAP.  Every published number is the output of a second-order
 *     critically damped spring, so it is C1 continuous. A first-order lag
 *     would be continuous in value but not in slope, and a wave spectrum
 *     rebaked off a discontinuous wind speed pops visibly.
 *
 *   DETERMINISTIC.  The state sequence is a pure function of (seed, game
 *     hour). Nothing is drawn from Math.random and nothing depends on frame
 *     timing, so a save that stores only the world clock reloads into exactly
 *     the same weather. That is also why the wind direction is a deterministic
 *     noise field rather than the Ornstein-Uhlenbeck walk DESIGN 03.10.4
 *     describes: an OU walk is not reconstructible from a timestamp, and a
 *     smooth noise field is statistically indistinguishable from one.
 */

import { WEATHER, OCEAN } from '../core/constants.js';
import { SECONDS_PER_DAY } from '../core/time.js';
import { events, EVENTS } from '../core/events.js';
import { clamp, saturate, lerp, TAU, hash2i, hash3i, wrapAngle2Pi } from '../core/math.js';

/** Real seconds in one game hour. */
const SECONDS_PER_GAME_HOUR = SECONDS_PER_DAY / 24;

/**
 * The six states in WEATHER, in a fixed order. The Markov matrix and every
 * auxiliary table below is indexed by this order, so it must not be reordered
 * without reordering them too.
 */
const STATE_IDS = ['clear', 'breezy', 'overcast', 'squall', 'storm', 'fogbank'];
const STATES = STATE_IDS.map((id) => Object.values(WEATHER).find((w) => w.id === id));

/**
 * Parameters DESIGN 03.10.2 specifies that constants.js WEATHER does not
 * carry. Same order as STATE_IDS.
 *
 *   gustFactor    peak/mean of the instantaneous wind
 *   gustPeriod    real seconds of the dominant gust cycle
 *   turbidity     atmospheric Mie multiplier - the single control that turns a
 *                 clear blue sky white. CLEAR and BREEZY sit at 1.6 and 2.0,
 *                 not the 2.2/2.6 of a hazy continental sky: measured across
 *                 the spawn frame at 2.2 the solar aureole was 5.5x brighter
 *                 and 3x less saturated than the sky 37 deg away (B/R 1.19
 *                 against 3.31), and at a 106 deg horizontal FOV it filled
 *                 most of any frame with the sun in it. 1.6 takes the Mie
 *                 coefficient to 6.4e-6 against a Rayleigh blue of 33.1e-6 and
 *                 keeps mieG at the clean-air 0.80, since sky.js's asymmetry
 *                 ramp only starts at 2.2. TURBIDITY_MIN is 0.6; do not chase
 *                 vibrance below it, and never confuse this with the WATER's
 *                 turbidity (see _publish).
 *   cloudType     0 stratus, 0.5 cumulus, 1 cumulonimbus
 *   whitecap      fraction of the surface covered in foam
 *   caustics      relative caustic intensity (cloud kills caustics dead)
 *   stormFactor   surface stir, consumed by the ocean and the vessel
 *   airFogSigma   air extinction, 1/m; V = 3.912 / sigma
 *   minMinutes    real minutes the state must be held before it may transition
 *   maxMinutes    real minutes after which a transition is forced
 */
const STATE_EXTRA = [
  { gustFactor: 1.25, gustPeriod: 22, turbidity: 1.6, cloudType: 0.50, whitecap: 0.001, caustics: 1.00, stormFactor: 0.00, airFogSigma: 1.4e-4, minMinutes: 8,  maxMinutes: 22 },
  { gustFactor: 1.40, gustPeriod: 16, turbidity: 2.0, cloudType: 0.50, whitecap: 0.005, caustics: 0.72, stormFactor: 0.10, airFogSigma: 1.8e-4, minMinutes: 8,  maxMinutes: 20 },
  { gustFactor: 1.35, gustPeriod: 18, turbidity: 3.4, cloudType: 0.00, whitecap: 0.010, caustics: 0.06, stormFactor: 0.20, airFogSigma: 2.8e-4, minMinutes: 10, maxMinutes: 25 },
  { gustFactor: 1.85, gustPeriod: 7,  turbidity: 4.2, cloudType: 1.00, whitecap: 0.041, caustics: 0.10, stormFactor: 0.65, airFogSigma: 1.4e-3, minMinutes: 3,  maxMinutes: 7 },
  { gustFactor: 1.70, gustPeriod: 9,  turbidity: 5.2, cloudType: 1.00, whitecap: 0.104, caustics: 0.03, stormFactor: 1.00, airFogSigma: 2.4e-3, minMinutes: 6,  maxMinutes: 16 },
  { gustFactor: 1.15, gustPeriod: 30, turbidity: 6.0, cloudType: 0.00, whitecap: 0.000, caustics: 0.55, stormFactor: 0.00, airFogSigma: 4.1e-2, minMinutes: 5,  maxMinutes: 14 },
];

/**
 * Transition weights, rows in STATE_IDS order. Taken from DESIGN 03.10.3 with
 * the GLASS_CALM column folded into CLEAR (constants.js has no such state) and
 * SCATTERED mapped onto BREEZY. Rows are normalised at sample time, so these
 * are weights rather than probabilities and do not have to sum to exactly 1.
 *
 * The structural constraints live in the zeros: STORM can never follow CLEAR
 * or BREEZY, because a real front takes hours to arrive, and FOGBANK never
 * follows a blow.
 */
const TRANSITIONS = [
  //          clear breezy over  squall storm  fog
  /* clear */ [0.52, 0.34, 0.09, 0.02, 0.00, 0.03],
  /* breezy*/ [0.28, 0.42, 0.22, 0.06, 0.01, 0.01],
  /* over  */ [0.11, 0.26, 0.40, 0.13, 0.06, 0.04],
  /* squall*/ [0.06, 0.24, 0.36, 0.22, 0.12, 0.00],
  /* storm */ [0.02, 0.10, 0.44, 0.26, 0.18, 0.00],
  /* fog   */ [0.38, 0.14, 0.18, 0.02, 0.00, 0.28],
];

/**
 * A new save is calm for its first 40 real minutes. This is a client
 * requirement from DESIGN 03.10.3 and it is implemented as a filter on the
 * transition sample rather than as a separate system, so nothing downstream
 * has to know about it.
 */
const SAFE_START_MINUTES = 40;
const SAFE_START_STATES = [0, 1];

/**
 * State a new world opens in, when the caller does not name one.
 *
 * BREEZY, not CLEAR. The safe-start filter pins the first 40 real minutes to
 * {CLEAR, BREEZY}, so whatever this is decides what every demo session and
 * every QA screenshot sees; CLEAR at cloudCover 0.10 is a handful of scattered
 * cumulus, which is honest but thin, while BREEZY at 0.32 is the fair-weather
 * cumulus field that actually shows the sky off - and now that the coverage
 * remap in pass/clouds.wgsl is calibrated, 0.32 really is 32% of the sky
 * (measured 0.35) rather than the 0.01% it used to be. BREEZY also carries
 * cloudType 0.50, the cumulus profile.
 *
 * The trade is seaState 3 (Hs 0.88 m) instead of CLEAR's 2 (Hs 0.32 m): the
 * opening sea is a gentle swell rather than glass.
 */
const DEFAULT_START_STATE = 'breezy';

/** Spring time constants, real seconds (DESIGN 03.10.4). */
const TAU_WIND = 55;
const TAU_CLOUD = 90;
const TAU_VISIBILITY = 25;

/** Game hours of lookahead, so the barometer can lead the weather. */
const PRESSURE_LEAD_SECONDS = 240;

/** Deterministic value noise in [-1, 1]. */
function noise1(x, seed) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash2i(i, seed) / 4294967296;
  const b = hash2i(i + 1, seed) / 4294967296;
  return lerp(a, b, u) * 2 - 1;
}

/**
 * A second-order critically damped spring, integrated with its exact closed
 * form rather than a discrete approximation. That matters because the game
 * runs at a variable frame rate and a semi-implicit Euler spring changes its
 * effective stiffness with dt - the weather would settle at a different speed
 * on a 144 Hz machine than on a 30 Hz one.
 */
class Spring {
  /** @param {number} tau real seconds to reach ~80% of a step change */
  constructor(tau, value = 0) {
    this.omega = 3 / tau;
    this.value = value;
    this.velocity = 0;
  }

  /** Jump to a value with zero velocity. Only for load/reset, never in play. */
  reset(v) {
    this.value = v;
    this.velocity = 0;
  }

  update(target, dt) {
    if (dt <= 0) return this.value;
    const w = this.omega;
    const a = this.value - target;
    const b = this.velocity + w * a;
    const e = Math.exp(-w * dt);
    this.value = (a + b * dt) * e + target;
    this.velocity = (b - w * a - w * b * dt) * e;
    return this.value;
  }
}

export class WeatherSystem {
  /**
   * @param {number} seed world seed; the whole state sequence derives from it
   * @param {{startState?: string}} [opts] `startState` is a STATE_IDS id;
   *   omitted it is DEFAULT_START_STATE
   */
  constructor(seed, opts = {}) {
    this.seed = (seed | 0) >>> 0;

    /** states[h] = index into STATES for game hour h. Replayed from hour 0. */
    this._states = [];
    /** Hour at which the state occupying _states[last] began. */
    this._runStart = 0;
    /** Forced-change deadline for the current run, in game hours. */
    this._runLimit = 0;

    const startIndex = Math.max(0, STATE_IDS.indexOf(opts.startState || DEFAULT_START_STATE));
    /** Hour-0 state. Replayed verbatim on load so a save reconstructs exactly. */
    this._startIndex = startIndex;
    this._states.push(startIndex);
    this._runLimit = this._drawDuration(startIndex, 0);

    this.stateIndex = startIndex;
    this.state = STATES[startIndex];
    this.previousStateIndex = startIndex;

    // --- published, spring-smoothed ---------------------------------------
    const s = STATES[startIndex];
    const x = STATE_EXTRA[startIndex];
    this._windSpring = new Spring(TAU_WIND, s.windSpeed);
    this._seaSpring = new Spring(TAU_WIND, s.seaState);
    this._cloudSpring = new Spring(TAU_CLOUD, s.cloudCover);
    this._cloudTypeSpring = new Spring(TAU_CLOUD, x.cloudType);
    this._rainSpring = new Spring(TAU_VISIBILITY, s.rain);
    this._fogSpring = new Spring(TAU_VISIBILITY, s.fog);
    this._turbiditySpring = new Spring(TAU_CLOUD, x.turbidity);
    this._whitecapSpring = new Spring(TAU_WIND, x.whitecap);
    this._causticSpring = new Spring(TAU_VISIBILITY, x.caustics);
    this._stormSpring = new Spring(TAU_WIND, x.stormFactor);
    this._visibilitySpring = new Spring(TAU_VISIBILITY, s.visibilityMul);
    this._pressureSpring = new Spring(TAU_CLOUD, 1013);
    // Air extinction spans 293x between CLEAR and FOGBANK, so it is sprung in
    // LOG space: a linear spring on a range that wide crawls out of fog and
    // then slams into it, and it is the one published quantity whose target is
    // not already smoothed by a second, independent spring.
    this._fogSigmaSpring = new Spring(TAU_VISIBILITY, Math.log(x.airFogSigma));

    /** Mean wind speed, m/s, before gusts. */
    this.windSpeed = s.windSpeed;
    /** Instantaneous wind speed including the gust envelope. */
    this.gustSpeed = s.windSpeed;
    /** Unit wind direction on the XZ plane. Heading 0 = north = -Z. */
    this.windDir = new Float32Array([0, -1]);
    this.windHeading = 0;
    this.seaState = s.seaState;
    this.cloudCover = s.cloudCover;
    this.cloudType = x.cloudType;
    this.rain = s.rain;
    this.fog = s.fog;
    this.turbidity = x.turbidity;
    this.whitecap = x.whitecap;
    this.causticStrength = x.caustics;
    this.stormFactor = x.stormFactor;
    this.visibilityMul = s.visibilityMul;
    /** Published above-water extinction coefficient, 1/m. */
    this.fogDensity = x.airFogSigma * (0.35 + 0.65 * s.fog / 0.92);
    /** Barometric pressure, hPa. Leads the weather by PRESSURE_LEAD_SECONDS. */
    this.pressure = 1013;

    this.elapsed = 0;
  }

  // -------------------------------------------------------------------------
  // Schedule
  // -------------------------------------------------------------------------

  /** Uniform [0,1) drawn deterministically from the seed and a game hour. */
  _rand(hour, salt) {
    return hash3i(this.seed, hour, salt) / 4294967296;
  }

  /** How many game hours this run of `index` will last before it is forced out. */
  _drawDuration(index, hour) {
    const x = STATE_EXTRA[index];
    const u = this._rand(hour, 0x9e37);
    const minutes = lerp(x.minMinutes, x.maxMinutes, u);
    return hour + (minutes * 60) / SECONDS_PER_GAME_HOUR;
  }

  /**
   * Extend the deterministic schedule so that _states[hour] exists.
   * Replaying from hour 0 is what makes a save reload identical; the loop is a
   * few hundred iterations for a full session and runs once per game hour.
   */
  _ensureSchedule(hour) {
    while (this._states.length <= hour) {
      const h = this._states.length;
      const current = this._states[h - 1];
      const x = STATE_EXTRA[current];
      const heldHours = h - this._runStart;
      const heldSeconds = heldHours * SECONDS_PER_GAME_HOUR;
      const forced = h >= this._runLimit;

      if (heldSeconds < x.minMinutes * 60 && !forced) {
        this._states.push(current);
        continue;
      }

      const safeStart = h * SECONDS_PER_GAME_HOUR < SAFE_START_MINUTES * 60;
      const row = TRANSITIONS[current];
      let total = 0;
      for (let i = 0; i < STATES.length; i++) {
        if (safeStart && !SAFE_START_STATES.includes(i)) continue;
        if (forced && i === current) continue;   // the run is over, move on
        total += row[i];
      }

      let next = current;
      if (total > 0) {
        let pick = this._rand(h, 0x2545) * total;
        for (let i = 0; i < STATES.length; i++) {
          if (safeStart && !SAFE_START_STATES.includes(i)) continue;
          if (forced && i === current) continue;
          pick -= row[i];
          if (pick <= 0) { next = i; break; }
        }
      }

      this._states.push(next);
      if (next !== current) {
        this._runStart = h;
        this._runLimit = this._drawDuration(next, h);
      } else if (forced) {
        // Nothing else was legal (safe-start with a single option): restart the
        // clock so we do not re-roll every single hour.
        this._runStart = h;
        this._runLimit = this._drawDuration(next, h);
      }
    }
    return this._states[hour];
  }

  /** The scheduled state index at a world time in real seconds. */
  stateAtTime(totalSeconds) {
    const hour = Math.max(0, Math.floor(totalSeconds / SECONDS_PER_GAME_HOUR));
    return this._ensureSchedule(hour);
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  /**
   * @param {number} dt real seconds
   * @param {import('../core/time.js').WorldClock} worldClock
   * @param {import('../render/renderer.js').Renderer} renderer
   */
  update(dt, worldClock, renderer) {
    const t = worldClock ? worldClock.totalSeconds : (this.elapsed += dt);
    const index = this.stateAtTime(t);

    if (index !== this.stateIndex) {
      this.previousStateIndex = this.stateIndex;
      this.stateIndex = index;
      this.state = STATES[index];
      events.emit(EVENTS.WEATHER_CHANGE, {
        state: STATES[index].id,
        previous: STATES[this.previousStateIndex].id,
        wind: STATES[index].windSpeed,
      });
    }

    const target = STATES[index];
    const extra = STATE_EXTRA[index];

    this.windSpeed = this._windSpring.update(target.windSpeed, dt);
    this.seaState = this._seaSpring.update(target.seaState, dt);
    this.cloudCover = saturate(this._cloudSpring.update(target.cloudCover, dt));
    this.cloudType = saturate(this._cloudTypeSpring.update(extra.cloudType, dt));
    this.rain = saturate(this._rainSpring.update(target.rain, dt));
    this.fog = saturate(this._fogSpring.update(target.fog, dt));
    this.turbidity = this._turbiditySpring.update(extra.turbidity, dt);
    this.whitecap = Math.max(0, this._whitecapSpring.update(extra.whitecap, dt));
    this.causticStrength = Math.max(0, this._causticSpring.update(extra.caustics, dt));
    this.stormFactor = saturate(this._stormSpring.update(extra.stormFactor, dt));
    this.visibilityMul = Math.max(0.05, this._visibilitySpring.update(target.visibilityMul, dt));
    const sigma = Math.exp(this._fogSigmaSpring.update(Math.log(extra.airFogSigma), dt));
    this.fogDensity = sigma * (0.35 + 0.65 * this.fog / 0.92);

    // The barometer must FALL BEFORE the storm, otherwise it is a readout
    // rather than a forecast. Targeting the state PRESSURE_LEAD_SECONDS ahead
    // costs nothing (the schedule is already deterministic that far out) and
    // gives the player a real, learnable instrument.
    const aheadIndex = this.stateAtTime(t + PRESSURE_LEAD_SECONDS);
    this.pressure = this._pressureSpring.update(
      1013 - 46 * STATE_EXTRA[aheadIndex].stormFactor, dt);

    this._updateWind(t);
    this._publish(renderer);
  }

  /**
   * Wind direction and the gust envelope, both pure functions of world time.
   *
   * The prevailing direction turns slowly over days; the instantaneous
   * direction wanders around it. Gusts are the two-band envelope from DESIGN
   * 03.10.5, whose beat between a slow and a fast component is what makes wind
   * sound and look alive rather than periodic.
   */
  _updateWind(t) {
    const days = t / SECONDS_PER_DAY;
    const prevailing = TAU * (noise1(days * 0.37, this.seed ^ 0x51f3) * 0.5 + 0.5);
    const wander = 0.30 * noise1(t / 180, this.seed ^ 0x7c2b);
    this.windHeading = wrapAngle2Pi(prevailing + wander);
    // Heading 0 = north = -Z, clockwise from above.
    this.windDir[0] = Math.sin(this.windHeading);
    this.windDir[1] = -Math.cos(this.windHeading);

    const extra = STATE_EXTRA[this.stateIndex];
    const period = extra.gustPeriod;
    const envelope = 0.6 * noise1(t / period, this.seed ^ 0x1ab7)
                   + 0.4 * noise1(t / (0.31 * period) + 17, this.seed ^ 0x33d9);
    this.gustSpeed = Math.max(0,
      this.windSpeed * (1 + (extra.gustFactor - 1) * envelope));
  }

  /** Push the current state onto renderer.env for the renderer and the ocean. */
  _publish(renderer) {
    if (!renderer) return;
    const env = renderer.env;

    env.cloudCover = this.cloudCover;
    env.cloudType = this.cloudType;
    env.rain = this.rain;
    env.windSpeed = this.gustSpeed;
    env.windDir[0] = this.windDir[0];
    env.windDir[1] = this.windDir[1];
    env.seaState = this.seaState;
    env.foamCoverage = this.whitecap;
    env.causticStrength = this.causticStrength;
    // Atmospheric turbidity, distinct from env.turbidity, which is the WATER's
    // particulate load. Mixing the two would make a foggy day muddy the ocean.
    env.airTurbidity = this.turbidity;
    env.fogDensity = this.fogDensity;
    env.choppiness = OCEAN.CHOPPINESS * lerp(0.85, 1.25, saturate(this.seaState / 8));
  }

  // -------------------------------------------------------------------------

  /** Sea state interpolated wave height, metres. Convenience for the HUD. */
  get significantWaveHeight() {
    const s = clamp(this.seaState, 0, OCEAN.SEA_STATES.length - 1);
    const i = Math.floor(s);
    const j = Math.min(i + 1, OCEAN.SEA_STATES.length - 1);
    return lerp(OCEAN.SEA_STATES[i].hs, OCEAN.SEA_STATES[j].hs, s - i);
  }

  /**
   * Above-water visibility in metres: the Koschmieder distance at which
   * contrast falls to 2%, from the extinction actually published this frame.
   */
  get visibility() {
    return 3.912 / Math.max(this.fogDensity, 1e-6);
  }

  /**
   * The full published state. Systems that want everything (HUD, audio, the
   * ocean's spectrum bake) read this rather than a dozen fields.
   */
  snapshot() {
    return {
      id: this.state.id,
      windSpeed: this.windSpeed,
      gustSpeed: this.gustSpeed,
      windHeading: this.windHeading,
      seaState: this.seaState,
      cloudCover: this.cloudCover,
      cloudType: this.cloudType,
      rain: this.rain,
      fog: this.fog,
      turbidity: this.turbidity,
      whitecap: this.whitecap,
      causticStrength: this.causticStrength,
      stormFactor: this.stormFactor,
      visibilityMul: this.visibilityMul,
      pressure: this.pressure,
      significantWaveHeight: this.significantWaveHeight,
    };
  }

  /**
   * Weather is reconstructed from the seed and the world clock, so a save
   * needs nothing but the seed. The spring values are deliberately NOT saved:
   * on load they are snapped to the scheduled state, which is correct because
   * a load is not a continuous moment.
   */
  serialize() {
    return { seed: this.seed };
  }

  deserialize(data, worldClock) {
    if (data && data.seed != null) this.seed = data.seed >>> 0;
    this._states.length = 0;
    this._runStart = 0;
    const t = worldClock ? worldClock.totalSeconds : 0;
    this._states.push(this._startIndex);
    this._runLimit = this._drawDuration(this._startIndex, 0);
    const index = this.stateAtTime(t);
    this.stateIndex = index;
    this.previousStateIndex = index;
    this.state = STATES[index];

    const s = STATES[index];
    const x = STATE_EXTRA[index];
    this._windSpring.reset(s.windSpeed);
    this._seaSpring.reset(s.seaState);
    this._cloudSpring.reset(s.cloudCover);
    this._cloudTypeSpring.reset(x.cloudType);
    this._rainSpring.reset(s.rain);
    this._fogSpring.reset(s.fog);
    this._turbiditySpring.reset(x.turbidity);
    this._whitecapSpring.reset(x.whitecap);
    this._causticSpring.reset(x.caustics);
    this._stormSpring.reset(x.stormFactor);
    this._visibilitySpring.reset(s.visibilityMul);
    this._pressureSpring.reset(1013 - 46 * x.stormFactor);
    this._fogSigmaSpring.reset(Math.log(x.airFogSigma));
    this.fogDensity = x.airFogSigma * (0.35 + 0.65 * s.fog / 0.92);
    this._updateWind(t);
  }
}

/** The state table this system runs on, for tools and tests. */
export { STATE_IDS, STATE_EXTRA, TRANSITIONS };
