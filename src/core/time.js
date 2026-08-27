/**
 * SUBWAVE clocks.
 *
 * Two distinct notions of time:
 *   - Clock:     real, wall-clock frame timing + the fixed-timestep accumulator.
 *   - WorldClock: in-fiction time of day, which drives sun/moon, creature
 *                 activity and ambience. Runs at a large multiple of real time.
 *
 * The simulation runs at a FIXED 60 Hz. Rendering interpolates between the two
 * most recent simulation states using `alpha`. This keeps vessel physics,
 * buoyancy and creature steering stable regardless of frame rate.
 */

import { clamp, TAU, saturate, smoothstep } from './math.js';

/** Fixed simulation rate. BINDING: physics tuning assumes this value. */
export const FIXED_DT = 1 / 60;
/** Never run more than this many simulation steps in one frame (spiral-of-death guard). */
export const MAX_STEPS_PER_FRAME = 5;
/** A single frame longer than this is treated as a stall and does not advance sim time. */
export const MAX_FRAME_DT = 0.25;

export class Clock {
  constructor() {
    this.now = 0;            // seconds since start (real, unscaled)
    this.dt = 0;             // last real frame delta, clamped
    this.rawDt = 0;          // unclamped, for diagnostics
    this.scaledDt = 0;       // dt * timeScale
    this.frame = 0;
    this.timeScale = 1;
    this.paused = false;

    this.accumulator = 0;
    this.alpha = 0;          // render interpolation factor in [0,1)
    this.stepsThisFrame = 0;
    this.simTime = 0;        // accumulated fixed-step simulation time
    this.simTick = 0;

    this._last = 0;
    this._started = false;

    // Smoothed frame-time statistics for the HUD/profiler.
    this.fps = 60;
    this.smoothedDt = FIXED_DT;
    this._samples = new Float32Array(120);
    this._sampleIndex = 0;
    this._sampleCount = 0;
  }

  /** Begin a new frame. `timestampMs` is the value passed to requestAnimationFrame. */
  beginFrame(timestampMs) {
    const t = timestampMs / 1000;
    if (!this._started) {
      this._started = true;
      this._last = t;
      this.dt = FIXED_DT;
      this.rawDt = FIXED_DT;
    } else {
      this.rawDt = t - this._last;
      this._last = t;
      this.dt = clamp(this.rawDt, 0, MAX_FRAME_DT);
    }

    this.now += this.dt;
    this.frame++;
    this.scaledDt = this.paused ? 0 : this.dt * this.timeScale;

    // Frame-time statistics.
    this._samples[this._sampleIndex] = this.rawDt;
    this._sampleIndex = (this._sampleIndex + 1) % this._samples.length;
    this._sampleCount = Math.min(this._sampleCount + 1, this._samples.length);
    let sum = 0;
    for (let i = 0; i < this._sampleCount; i++) sum += this._samples[i];
    this.smoothedDt = sum / Math.max(1, this._sampleCount);
    this.fps = 1 / Math.max(1e-6, this.smoothedDt);

    this.accumulator += this.scaledDt;
    this.stepsThisFrame = 0;
    return this.dt;
  }

  /**
   * Consume one fixed simulation step if one is due.
   * Usage: `while (clock.step()) { simulate(FIXED_DT); }`
   */
  step() {
    if (this.accumulator < FIXED_DT) {
      this.alpha = this.accumulator / FIXED_DT;
      return false;
    }
    if (this.stepsThisFrame >= MAX_STEPS_PER_FRAME) {
      // We are behind: drop the backlog rather than spiral.
      this.accumulator = 0;
      this.alpha = 0;
      return false;
    }
    this.accumulator -= FIXED_DT;
    this.stepsThisFrame++;
    this.simTime += FIXED_DT;
    this.simTick++;
    this.alpha = this.accumulator / FIXED_DT;
    return true;
  }

  setPaused(p) {
    if (p === this.paused) return;
    this.paused = p;
    if (p) this.accumulator = 0;
  }

  /** Call after a long stall (tab hidden, loading screen) to avoid a burst of steps. */
  resync() {
    this.accumulator = 0;
    this._last = performance.now() / 1000;
  }

  /** Percentile frame time in ms, for the perf HUD. */
  percentile(p = 0.99) {
    if (this._sampleCount === 0) return 0;
    const a = Array.from(this._samples.subarray(0, this._sampleCount)).sort((x, y) => x - y);
    return a[clamp(Math.floor(p * (a.length - 1)), 0, a.length - 1)] * 1000;
  }
}

// ---------------------------------------------------------------------------
// World clock
// ---------------------------------------------------------------------------

/** Real seconds per in-game day. 20 real minutes = one full day/night cycle. */
export const SECONDS_PER_DAY = 1200;

/** Named key times as fractions of the day, used by the lighting tables. */
export const KEY_TIMES = {
  midnight: 0.0,
  astronomicalDawn: 0.185,
  dawn: 0.22,
  sunrise: 0.25,
  morning: 0.33,
  noon: 0.5,
  afternoon: 0.66,
  sunset: 0.75,
  dusk: 0.78,
  astronomicalDusk: 0.815,
  night: 0.9,
};

/**
 * The two times the debug day/night toggle snaps between. Night is 0.95 rather
 * than KEY_TIMES.night so the sun is unambiguously down and the stars are at
 * full visibility - 0.9 still catches the tail of the astronomical dusk ramp.
 */
export const DAY_FRACTION = KEY_TIMES.noon;
export const NIGHT_FRACTION = 0.95;

export class WorldClock {
  /**
   * @param {number} startFraction Fraction of the day to start at.
   *   Default 0.30 = mid-morning: bright, safe, welcoming for the first minutes.
   */
  constructor(startFraction = 0.30) {
    this.dayFraction = startFraction;   // [0,1), 0 = midnight, 0.5 = solar noon
    this.day = 0;                       // whole days elapsed
    this.totalSeconds = startFraction * SECONDS_PER_DAY;
    this.rate = 1;                      // multiplier on the passage of world time
    this.frozen = false;

    /** Axial tilt of the planet, radians. Gives seasonal-ish sun arcs. */
    this.axialTilt = 0.32;
    /** Player latitude in radians. Fixed - the playable region is small. */
    this.latitude = 0.21;

    // Two moons; see DESIGN/03. Periods are in in-game days.
    this.moonPeriods = [7.4, 23.1];
    this.moonPhases = [0.28, 0.71];
  }

  advance(realDt) {
    if (this.frozen) return;
    this.totalSeconds += realDt * this.rate;
    this._recompute();
  }

  /**
   * Derive everything that is a function of totalSeconds. Every path that moves
   * the clock goes through here, because the moon phases are NOT free-running -
   * they are a function of the absolute time, and a seek that updates the day
   * fraction without them leaves moonDirection() and moonIllumination() reading
   * the phase from wherever the clock used to be.
   */
  _recompute() {
    const days = this.totalSeconds / SECONDS_PER_DAY;
    this.day = Math.floor(days);
    this.dayFraction = days - this.day;
    const p = this.moonPeriods;
    this.moonPhases[0] = (days / p[0]) % 1;
    this.moonPhases[1] = (days / p[1]) % 1;
  }

  /** Set the time of day directly, e.g. from a debug key or a save file. */
  setDayFraction(f) {
    const frac = ((f % 1) + 1) % 1;
    this.totalSeconds = (this.day + frac) * SECONDS_PER_DAY;
    this._recompute();
  }

  /**
   * Snap between day and night. Returns the new day fraction.
   *
   * The direction is read off the CURRENT light level rather than a stored
   * bool, so the toggle stays correct when the time has been moved by something
   * else - the console, a save load, or the cycle simply having run on.
   */
  toggleDayNight() {
    this.setDayFraction(this.isNight ? DAY_FRACTION : NIGHT_FRACTION);
    return this.dayFraction;
  }

  /** Hour angle: 0 at solar noon, +-PI at midnight. */
  get hourAngle() {
    return (this.dayFraction - 0.5) * TAU;
  }

  /**
   * Sun direction (unit vector pointing FROM the scene TOWARD the sun).
   * Uses a simple sky-sphere model: the sun rises in the east (+X), sets west.
   */
  sunDirection(out) {
    const h = this.hourAngle;
    const decl = this.axialTilt * Math.sin((this.day / 84) * TAU); // slow seasonal drift
    const lat = this.latitude;

    const sinAlt = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(h);
    const altitude = Math.asin(clamp(sinAlt, -1, 1));
    const cosAz = (Math.sin(decl) - Math.sin(lat) * sinAlt) / Math.max(1e-4, Math.cos(lat) * Math.cos(altitude));
    let azimuth = Math.acos(clamp(cosAz, -1, 1)); // 0 = north
    if (Math.sin(h) > 0) azimuth = TAU - azimuth;

    // Convert (altitude, azimuth-from-north-clockwise) to our world axes.
    const ca = Math.cos(altitude);
    out[0] = ca * Math.sin(azimuth);   // east
    out[1] = Math.sin(altitude);       // up
    out[2] = -ca * Math.cos(azimuth);  // -Z is north
    return out;
  }

  /** Moon direction: roughly opposite the sun, offset by its phase. */
  moonDirection(out, index = 0) {
    const phase = this.moonPhases[index];
    const h = this.hourAngle + Math.PI + phase * TAU * 0.15;
    const decl = 0.14 * Math.sin(phase * TAU) + (index === 1 ? 0.22 : -0.08);
    const lat = this.latitude;
    const sinAlt = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(h);
    const altitude = Math.asin(clamp(sinAlt, -1, 1));
    const cosAz = (Math.sin(decl) - Math.sin(lat) * sinAlt) / Math.max(1e-4, Math.cos(lat) * Math.cos(altitude));
    let azimuth = Math.acos(clamp(cosAz, -1, 1));
    if (Math.sin(h) > 0) azimuth = TAU - azimuth;
    const ca = Math.cos(altitude);
    out[0] = ca * Math.sin(azimuth);
    out[1] = Math.sin(altitude);
    out[2] = -ca * Math.cos(azimuth);
    return out;
  }

  /** Illuminated fraction of a moon's disc, 0 = new, 1 = full. */
  moonIllumination(index = 0) {
    return 0.5 - 0.5 * Math.cos(this.moonPhases[index] * TAU);
  }

  /** Sun altitude in radians (negative below the horizon). */
  get sunAltitude() {
    const d = [0, 0, 0];
    this.sunDirection(d);
    return Math.asin(clamp(d[1], -1, 1));
  }

  /**
   * 0 at full night, 1 at full day, with a smooth civil-twilight ramp.
   * Everything that "gets dark at night" should read this rather than the hour.
   */
  get daylight() {
    return smoothstep(-0.10, 0.14, Math.sin(this.sunAltitude));
  }

  /** 1 during civil twilight (the golden/blue hour), 0 otherwise. */
  get twilight() {
    const s = Math.sin(this.sunAltitude);
    return saturate(1 - Math.abs(s + 0.02) / 0.18);
  }

  get isNight() { return this.daylight < 0.15; }

  /** "07:42" style clock string for the HUD. */
  formatted() {
    const totalMinutes = this.dayFraction * 24 * 60;
    const h = Math.floor(totalMinutes / 60);
    const m = Math.floor(totalMinutes % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  serialize() {
    return { totalSeconds: this.totalSeconds, rate: this.rate };
  }
  deserialize(s) {
    if (!s) return;
    this.totalSeconds = s.totalSeconds || 0;
    this.rate = s.rate != null ? s.rate : 1;
    this._recompute();
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** A countdown timer that fires a callback at most once per interval. */
export class Interval {
  constructor(seconds, callback) {
    this.interval = seconds;
    this.callback = callback;
    this.remaining = seconds;
  }
  update(dt) {
    this.remaining -= dt;
    if (this.remaining <= 0) {
      this.remaining += this.interval;
      if (this.remaining < 0) this.remaining = this.interval;
      this.callback();
      return true;
    }
    return false;
  }
  reset() { this.remaining = this.interval; }
}

/**
 * Round-robin work scheduler: spreads N items over M frames so expensive
 * per-entity work (AI re-planning, chunk checks) never spikes a single frame.
 */
export class Staggered {
  constructor(period) {
    this.period = Math.max(1, period | 0);
    this.phase = 0;
  }
  tick() { this.phase = (this.phase + 1) % this.period; }
  /** True if item `index` should be processed on the current phase. */
  due(index) { return index % this.period === this.phase; }
}
