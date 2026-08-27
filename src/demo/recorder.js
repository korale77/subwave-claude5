/**
 * Records the showcase demo to a video file, in the browser, with no encoder of
 * our own: MediaRecorder over `HTMLCanvasElement.captureStream()`.
 *
 * WHAT IS IN THE PICTURE, AND WHY THAT DECIDED THE FADE. A capture stream sees
 * the CANVAS and nothing else - no DOM sits in it. That is affordable here only
 * because this project composites almost everything into the WebGPU frame
 * already: `ui/hud.js` uploads its OffscreenCanvas as a GPU texture, so the
 * instruments ride along. The one part of the cinematic that did NOT was the
 * director's black cross-fade, which was a `<div>`; it would have left the video
 * hard-cutting at all eleven segment boundaries while the live view faded. So
 * the fade moved into the lens pass (`Renderer.demoFade`, applied on the final
 * display code value exactly as CSS compositing did) and this file can stay a
 * dumb sink. Anything added to the showcase in DOM from here on is invisible to
 * the recording - put it in the frame.
 *
 * IT RECORDS AN INTERMEDIATE CANVAS, NOT THE GAME CANVAS, AND THAT IS THE WHOLE
 * REASON MP4 WORKS. Capturing #viewport directly hands the encoder the BACKING
 * STORE: CSS size times devicePixelRatio, so a 1600x900 window on a HiDPI
 * display encodes 3200x1800 - and with whatever parity the rounding leaves,
 * measured 1280x577 once. macOS hardware H.264 refuses both faults (an
 * oversized frame and an ODD dimension are equally fatal to it) and every take
 * silently fell through to WebM. So each frame is drawn into a 2D canvas sized
 * at CSS pixels, capped by `DEMO_RECORD.CAPTURE_MAX_*`, and rounded DOWN to
 * even on both axes.
 *
 * **THE PUMP MUST RUN INSIDE A rAF CALLBACK.** `renderer.js` warns that drawing
 * this canvas into a 2D context does not reliably capture WebGPU content, and
 * it is half right: measured, a `drawImage` from a plain task returns ONE flat
 * colour (the swap-chain texture is gone after present), while the same call
 * inside the rAF callback, AFTER `renderer.render()` and before the callback
 * returns, gets the real frame - mean level 125.63 over 327 distinct colours
 * against 170.00 over 1. `DemoDirector.afterRender` is called from exactly that
 * window in `Game._frame`, which is why `tick()` is the pump and why it must
 * stay one. Reading the canvas from a timer, or from `frameUpdate()` at the top
 * of the frame (a surface already handed to the compositor), produces a video
 * of flat colour that no test in this repo would notice.
 *
 * CONTAINER IS NEGOTIATED AT RUNTIME, AND `isTypeSupported` IS NOT THE ARBITER
 * IT LOOKS LIKE. It parses the codec STRING and knows nothing about the frame
 * size it will be handed, so it happily returns true for an H.264 level whose
 * resolution ceiling this canvas blows straight through - and the refusal then
 * arrives ASYNCHRONOUSLY, on `onerror`, after `start()` has already returned
 * true and the showcase is running. Shipped once exactly that way: the list led
 * with Baseline 3.0 (720x480 max) against a 3200x1800 backing store and every
 * run died with `EncodingError: The given encoder configuration is not
 * supported by the encoder` and saved nothing.
 *
 * So this class WALKS `DEMO_RECORD.MIME_CANDIDATES` rather than picking one row
 * and trusting it. A failure before any data has arrived advances to the next
 * candidate and restarts, costing at most the first second of the run; a
 * failure after data has arrived keeps what it has and stops, because
 * restarting mid-run would split one take into two files. A bitrate the encoder
 * will not take is retried once without the bitrate. The chosen type is logged,
 * because a run has to be able to say what it wrote.
 *
 * FAILING TO RECORD MUST NEVER FAIL THE SHOWCASE. Every path here returns false
 * and warns instead of throwing: the demo is the feature and the recording is a
 * side effect of watching it.
 *
 * THE FRAME SIZE IS FIXED AT `start()`. The intermediate canvas keeps the size
 * it was given, so resizing the window mid-take no longer corrupts the stream -
 * `drawImage` just rescales into it - but the aspect ratio it was sized for is
 * baked in, so a reshaped window distorts the rest of the file. Resizing the
 * capture instead would restart the encoder and split one take into two, which
 * is worse; the constraint is warned about once and left.
 */

import { DEMO_RECORD } from '../core/constants.js';

/** Container MIME -> file extension. Anything unlisted falls back to `.webm`. */
const EXTENSIONS = [
  ['video/mp4', 'mp4'],
  ['video/webm', 'webm'],
];

/**
 * UTC stamp for the filename, `yyyymmdd-hhmmss`.
 *
 * `Date` is banned in world GENERATION because determinism is a contract there.
 * This is a download filename for a human, produced by a key press, and it
 * reaches no seed, no hash and no noise field.
 */
function timestamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/**
 * Round DOWN to an even number, floor 2. H.264 encodes in 16x16 macroblocks and
 * chroma is subsampled 2x2, so an ODD dimension is rejected outright by macOS's
 * hardware encoder - the same class of refusal as an oversized frame, and just
 * as invisible beforehand. `gpu.js` rounds its RENDER targets even but the
 * CANVAS is a CSS measurement and can be anything; 1280x577 was measured.
 */
function even(n) {
  const x = Math.max(2, Math.floor(n) || 2);
  return x - (x % 2);
}

/**
 * The size to record at: the canvas's CSS box, fitted inside the
 * `CAPTURE_MAX_*` ceiling with aspect preserved, then forced even.
 *
 * CSS pixels and not the backing store - see the header. The scale is uniform
 * so nothing is stretched, and the even() runs LAST because rounding after
 * scaling is what actually reaches the encoder.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {{width: number, height: number}}
 */
function captureSize(canvas) {
  const cw = canvas.clientWidth || canvas.width || 2;
  const ch = canvas.clientHeight || canvas.height || 2;
  const scale = Math.min(1,
    DEMO_RECORD.CAPTURE_MAX_WIDTH / cw,
    DEMO_RECORD.CAPTURE_MAX_HEIGHT / ch);
  return { width: even(cw * scale), height: even(ch * scale) };
}

/** The extension for a negotiated MIME type. */
function extensionFor(mime) {
  for (const [prefix, ext] of EXTENSIONS) if (mime.startsWith(prefix)) return ext;
  return 'webm';
}

/**
 * One take. Construct, `start(canvas)`, `stop()` - not reusable, because a
 * MediaRecorder that has stopped cannot be restarted and pretending otherwise
 * would silently produce an empty second file.
 */
export class DemoRecorder {
  constructor() {
    /** @type {MediaRecorder|null} */
    this._rec = null;
    /** @type {MediaStream|null} */
    this._stream = null;
    /** @type {Blob[]} */
    this._chunks = [];
    /** Negotiated container, null until start() succeeds. */
    this.mimeType = null;
    /** True between a successful start() and stop(). */
    this.recording = false;
    /** Capture dimensions, fixed at start() - see the resize note in the header. */
    this.width = 0;
    this.height = 0;
    /** @type {HTMLCanvasElement|null} */
    this._canvas = null;
    /** Latched by tick() so the resize warning is said once, not every frame. */
    this._resized = false;
    /** @type {Array<{mime: string, bitrate: number}>} the attempt ladder. */
    this._attempts = [];
    /** How far down that ladder we are. See _onEncoderError. */
    this._attemptIndex = 0;
    /** @type {*} first-chunk watchdog timer - see _armWatchdog. */
    this._watchdog = null;
    /** @type {HTMLCanvasElement|null} the surface actually recorded. */
    this._dest = null;
    /** @type {CanvasRenderingContext2D|null} */
    this._ctx = null;
    /** @type {MediaStreamTrack|null} */
    this._track = null;
    /** CSS size of the game canvas at start(), for the resize watchdog. */
    this._srcSize = [0, 0];
    /** Pump throttle deadline - see tick(). */
    this._nextPaint = 0;
    this._minPaintMs = 1000 / Math.max(1, DEMO_RECORD.FPS);
    /** Latched so a failing drawImage warns once, not every frame. */
    this._paintFailed = false;
    /** True once a non-empty chunk has arrived - the test for whether a mid-run
     *  encoder failure has anything worth keeping. */
    this._gotData = false;
  }

  /** Is there any chance at all of recording in this browser? */
  static supported() {
    return typeof MediaRecorder !== 'undefined' &&
      typeof HTMLCanvasElement !== 'undefined' &&
      typeof HTMLCanvasElement.prototype.captureStream === 'function';
  }

  /**
   * The first container this browser will actually encode, or null.
   * @returns {string|null}
   */
  static pickMime() {
    return DemoRecorder.supportedMimes()[0] ?? null;
  }

  /**
   * Every candidate this browser CLAIMS to support, in preference order.
   *
   * "Claims" is the operative word - see the header. This is the ladder
   * start() walks when the encoder refuses a row at the resolution it is
   * actually handed, which isTypeSupported cannot predict.
   *
   * @returns {string[]}
   */
  static supportedMimes() {
    if (typeof MediaRecorder === 'undefined') return [];
    return DEMO_RECORD.MIME_CANDIDATES.filter((m) => MediaRecorder.isTypeSupported(m));
  }

  /**
   * Begin recording `canvas`. Returns false (having warned) on any failure, so
   * the caller can start the showcase regardless.
   *
   * @param {HTMLCanvasElement} canvas the game's own #viewport
   * @returns {boolean}
   */
  start(canvas) {
    if (this.recording || !canvas) return false;
    if (!DemoRecorder.supported()) {
      console.warn('[demo] recording unavailable: no MediaRecorder/captureStream');
      return false;
    }
    const mimes = DemoRecorder.supportedMimes();
    if (!mimes.length) {
      console.warn('[demo] recording unavailable: no supported container from ' +
        DEMO_RECORD.MIME_CANDIDATES.join(', '));
      return false;
    }
    // Each container is tried at the authored bitrate and then, if that fails,
    // at the browser's own default - an encoder always accepts its own default,
    // and a thriftier file beats no file. Interleaved rather than appended so a
    // container that works at all is exhausted before dropping to a worse one.
    this._attempts = [];
    for (const mime of mimes) {
      this._attempts.push({ mime, bitrate: DEMO_RECORD.BITRATE });
      this._attempts.push({ mime, bitrate: 0 });
    }
    this._attemptIndex = 0;
    this._canvas = canvas;
    this._resized = false;

    // The intermediate surface everything is actually recorded from. `alpha:
    // false` because the game canvas is opaque and an alpha channel would only
    // cost the encoder a composite; high-quality smoothing because this is a
    // downscale on most displays and a box filter aliases the HUD's hairlines.
    const size = captureSize(canvas);
    this.width = size.width;
    this.height = size.height;
    this._dest = document.createElement('canvas');
    this._dest.width = this.width;
    this._dest.height = this.height;
    this._ctx = this._dest.getContext('2d', { alpha: false });
    if (!this._ctx) {
      console.warn('[demo] recording unavailable: no 2D context for the capture surface');
      this._release();
      return false;
    }
    this._ctx.imageSmoothingEnabled = true;
    this._ctx.imageSmoothingQuality = 'high';
    this._srcSize = [canvas.clientWidth, canvas.clientHeight];
    // Paint once before the stream exists, so the encoder's first frame is the
    // game and not an uninitialised black surface.
    this._paint();
    if (!this._attach()) return false;
    return true;
  }

  /**
   * Open the stream and the encoder on the current candidate. Advances through
   * the ladder itself on a synchronous throw; the ASYNCHRONOUS refusal is
   * handled by _onEncoderError, which is the case that actually bites.
   *
   * @returns {boolean}
   */
  _attach() {
    while (this._attempts && this._attemptIndex < this._attempts.length) {
      const { mime, bitrate } = this._attempts[this._attemptIndex];
      try {
        // One stream per attempt: a track stopped by a previous failure is not
        // reusable, and captureStream on a live canvas is cheap.
        // frameRate 0 means the stream emits ONLY on requestFrame(), so the
        // pump decides the cadence exactly - no duplicated frames while the
        // scene is still and no sampling race against the paint.
        this._stream = this._dest.captureStream(0);
        this._track = this._stream.getVideoTracks()[0] ?? null;
        if (this._track) this._track.contentHint = 'detail';
        const opts = bitrate ? { mimeType: mime, videoBitsPerSecond: bitrate } : { mimeType: mime };
        this._rec = new MediaRecorder(this._stream, opts);
        this._chunks = [];
        this._gotData = false;
        this._rec.ondataavailable = (e) => {
          if (!e.data || !e.data.size) return;
          this._chunks.push(e.data);
          if (!this._gotData) { this._gotData = true; this._clearWatchdog(); }
        };
        this._rec.onerror = (e) => this._onEncoderError(e);
        this._rec.start(DEMO_RECORD.TIMESLICE_MS);
        this.mimeType = mime;
        this.recording = true;
        this._armWatchdog();
        // The stream samples the canvas as it is presented, so a backgrounded
        // tab - whose rAF is throttled to about 1 Hz - records a minute of
        // frozen frames rather than nothing, which looks like a broken encoder.
        // Say so up front.
        console.info(`[demo] recording ${this.width}x${this.height} as ${mime}` +
          `${bitrate ? '' : ' (browser default bitrate)'} - keep this window in the foreground`);
        return true;
      } catch (err) {
        console.warn(`[demo] ${mime} would not start:`, err);
        this._teardown();
        this._attemptIndex++;
      }
    }
    console.warn('[demo] recording unavailable: no encoder configuration would ' +
      `produce data at ${this.width}x${this.height}`);
    this._release();
    return false;
  }

  /**
   * AN ENCODER THAT NEVER COMPLAINS AND NEVER PRODUCES A BYTE IS THE FAILURE
   * MODE NO ERROR HANDLER CATCHES, and it is indistinguishable from a healthy
   * recorder until the run ends with an empty blob. Give the first chunk a
   * generous window - several timeslices - and if nothing has arrived, treat
   * it exactly like a refusal and drop down the ladder.
   */
  _armWatchdog() {
    this._clearWatchdog();
    this._watchdog = setTimeout(() => {
      this._watchdog = null;
      if (!this.recording || this._gotData) return;
      console.warn(`[demo] ${this.mimeType} produced no data in ` +
        `${DEMO_RECORD.FIRST_DATA_TIMEOUT_MS} ms; trying the next encoder`);
      this._nextAttempt();
    }, DEMO_RECORD.FIRST_DATA_TIMEOUT_MS);
  }

  _clearWatchdog() {
    if (this._watchdog) { clearTimeout(this._watchdog); this._watchdog = null; }
  }

  /** Drop the current attempt and start the next one down the ladder. */
  _nextAttempt() {
    this._teardown();
    this._attemptIndex++;
    this.recording = false;
    this._attach();
  }

  /**
   * The asynchronous refusal. THIS IS THE ONE THAT SHIPPED BROKEN: an H.264
   * level whose resolution ceiling the canvas exceeds passes isTypeSupported
   * and passes start(), then fails here with EncodingError while the showcase
   * plays on, and the run ends with an empty blob and no download.
   *
   * Before any data has arrived the take is worth nothing, so drop down the
   * ladder and restart - the cost is the head of the run, which is the fade in
   * from black. Once data HAS arrived, keep it: restarting would split one take
   * into two files, and a truncated video is worth more than a lost one.
   */
  _onEncoderError(e) {
    const err = e?.error ?? e;
    const mime = this.mimeType;
    if (this._gotData) {
      console.warn(`[demo] encoder failed mid-run on ${mime}; ` +
        'keeping what was recorded:', err);
      return;
    }
    console.warn(`[demo] ${mime} failed at ${this.width}x${this.height} ` +
      '(the codec string passed isTypeSupported; the encoder still refused it):', err);
    this._nextAttempt();
  }

  /** Drop the current attempt's encoder and stream, keeping the ladder state. */
  _teardown() {
    this._clearWatchdog();
    if (this._rec) {
      try { if (this._rec.state !== 'inactive') this._rec.stop(); } catch { /* already dead */ }
      this._rec.ondataavailable = null;
      this._rec.onerror = null;
      this._rec = null;
    }
    if (this._stream) {
      for (const track of this._stream.getTracks()) track.stop();
      this._stream = null;
    }
    this._track = null;
    this._chunks = [];
  }

  /**
   * THE PUMP. Copy the game canvas into the capture surface and emit one frame.
   *
   * MUST BE CALLED INSIDE THE rAF CALLBACK, AFTER `renderer.render()` - see the
   * header. It is: `DemoDirector.afterRender` is invoked from `Game._frame`
   * immediately after the render. Do not move this to a timer, and do not
   * "optimise" it into an interval. Throttled to `DEMO_RECORD.FPS`, which is
   * also the rate the stream samples at: painting faster than the encoder reads
   * costs a full-frame blit per extra paint and changes nothing in the file.
   * The display runs at 120 Hz here, so this drops three of every four calls.
   *
   * Also carries the resize watchdog. The stream's size is fixed at start(), so
   * a reshaped window no longer breaks the file - drawImage rescales into the
   * same surface - but the aspect it was sized for is baked in, and that is
   * worth saying once.
   */
  tick() {
    if (!this.recording) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : 0);
    if (now < this._nextPaint) return;
    // Advance the DEADLINE by a fixed period rather than restamping it to
    // `now`. Restamping quantises the cadence up to the next whole display
    // frame every time - at 120 Hz a 33.3 ms period becomes 41.6 ms and the
    // pump delivers 24 Hz into a 30 Hz stream, which the encoder fills with
    // duplicate frames. The max() is the catch-up clamp: after a stall the
    // deadline is dragged forward instead of firing a burst of make-up paints.
    this._nextPaint = Math.max(now, this._nextPaint + this._minPaintMs);
    this._paint();
    // requestFrame is the whole point of the frameRate-0 stream: exactly one
    // encoded frame per painted frame.
    this._track?.requestFrame?.();

    if (this._resized) return;
    const c = this._canvas;
    if (!c || (c.clientWidth === this._srcSize[0] && c.clientHeight === this._srcSize[1])) return;
    this._resized = true;
    console.warn(`[demo] window resized to ${c.clientWidth}x${c.clientHeight} mid-recording; ` +
      `the file keeps its original ${this.width}x${this.height} frame`);
  }

  /**
   * One blit of the game canvas into the capture surface.
   *
   * Wrapped because a drawImage from a canvas whose context has been lost
   * throws, and losing the recording is not a reason to lose the showcase.
   */
  _paint() {
    if (!this._ctx || !this._canvas) return;
    try {
      this._ctx.drawImage(this._canvas, 0, 0, this.width, this.height);
    } catch (err) {
      if (!this._paintFailed) {
        this._paintFailed = true;
        console.warn('[demo] could not read the canvas for recording:', err);
      }
    }
  }

  /**
   * Stop, finalise and hand the file to the browser's downloads.
   *
   * Resolves with the saved filename, or null if there was nothing to save.
   * NEVER rejects: the director calls this from its synchronous stop() on every
   * exit path, including an Escape abort, and an unhandled rejection there would
   * take the restore with it. A partial take is still footage, so an abort saves
   * exactly like a completed run.
   *
   * @returns {Promise<string|null>}
   */
  stop() {
    if (!this.recording || !this._rec) return Promise.resolve(null);
    this.recording = false;
    // Disarm first: a stop inside the grace window would otherwise let the
    // watchdog fire afterwards and start a NEW recording nobody asked for.
    this._clearWatchdog();
    const rec = this._rec;
    return new Promise((resolve) => {
      rec.onstop = () => {
        let name = null;
        try {
          name = this._save();
        } catch (err) {
          console.warn('[demo] recording failed to save:', err);
        }
        this._release();
        resolve(name);
      };
      try {
        rec.stop();
      } catch (err) {
        console.warn('[demo] recorder would not stop:', err);
        this._release();
        resolve(null);
      }
    });
  }

  /** Build the blob and trigger the download. @returns {string|null} */
  _save() {
    if (!this._chunks.length) {
      console.warn('[demo] recording produced no data');
      return null;
    }
    const mime = this.mimeType ?? 'video/webm';
    const blob = new Blob(this._chunks, { type: mime });
    const name = `${DEMO_RECORD.FILENAME_PREFIX}-${timestamp()}.${extensionFor(mime)}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on a later task: revoking synchronously after click() races the
    // browser's own fetch of the object URL and loses on some builds.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    const mb = (blob.size / 1048576).toFixed(1);
    console.info(`[demo] recording saved: ${name} (${mb} MB)`);
    return name;
  }

  /** Drop everything. Idempotent, and ends the ladder - unlike _teardown(),
   *  which keeps the ladder state so the next candidate can be tried. */
  _release() {
    if (this._stream) {
      for (const track of this._stream.getTracks()) track.stop();
      this._stream = null;
    }
    this._rec = null;
    this._track = null;
    this._chunks = [];
    this._canvas = null;
    this._dest = null;
    this._ctx = null;
    this._attempts = [];
    this._gotData = false;
    this._clearWatchdog();
    this.recording = false;
  }
}
