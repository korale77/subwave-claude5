/**
 * The frame-metrics kernel: one module defining every per-frame statistic this
 * project judges an image by.
 *
 * WHY IT IS ONE MODULE. CLAUDE.md cites a biome-variety
 * metric ("frame-to-frame cosine similarity over 2-D hue x saturation
 * histograms, 0.384 against the reference frames' 0.148") as authoritative, and that
 * metric has no implementation at any point in the repository's history. Every
 * acceptance criterion phrased in terms of it was therefore a claim rather than
 * a measurement. Defining the statistics in exactly one place is what makes a
 * before/after comparison mean anything: two tools that each roll their own
 * binning cannot be compared, and this project has already been burned twice by
 * instruments that moved for a reason other than the one under test.
 *
 * WHY THE STATISTICS ARE THESE STATISTICS. Each one exists because a previously
 * used measure gave a confident wrong answer:
 *   - Hue x saturation COSINE replaces dominant-hue spread, which peaked at
 *     91 deg on a frame that looked worse and scored 0.154% on the deep
 *     reference frame the whole biome pass was aimed at.
 *   - Cosine is never sufficient ALONE: it measures difference BETWEEN frames
 *     and is maximised by "every frame is one different colour". Measured,
 *     abyss x underwater-deep = 0.1328 - spectacularly different - and both
 *     frames are bad (0.67 and 0.08 bits of hue entropy, dark mass 0.0000 on
 *     both). Hue ENTROPY and DARK MASS are the within-frame floors that turn
 *     the gate into a conjunction.
 *   - Dark mass and flat fraction are RELATIVE to the frame's own median, so a
 *     dark frame and a bright one are asked the same question about contrast.
 *
 * MEASURE ON THE DISPLAY-REFERRED SCREENSHOT, never on
 * `renderer.debugReadback('resolved')`: TAA precedes tonemapping, so `resolved`
 * is pre-AgX, and AgX is the operator that decides delivered saturation. Every
 * function here therefore consumes decoded PNG bytes, and luminance is Rec709
 * luma over DISPLAY CODE VALUES in [0, 1] - it is deliberately not linearised,
 * because the quantity being judged is what the display emits and what the eye
 * is offered, not scene radiance.
 */

/**
 * Hue bins in the 2-D histogram. 32 bins is 11.25 deg, finer than the eye's hue
 * JND across most of the wheel and coarse enough that a 1.2 Mpixel frame fills
 * every occupied bin thousands deep. The section-0 abyss x trench-wall finding
 * reproduces at three different binnings, so the choice is not load-bearing -
 * but it must be IDENTICAL across every comparison, which is why it is exported
 * rather than written out at each call site.
 */
export const HUE_BINS = 32;

/**
 * Saturation bins in the 2-D histogram, linear over [0, 1].
 */
export const SAT_BINS = 8;

/**
 * Flattened length of a hue x saturation histogram, the vector cosine works on.
 */
export const HIST_BINS = HUE_BINS * SAT_BINS;

/**
 * The chroma gate, and the reason it is 0.06/0.02 and not 0.20.
 *
 * The retired dominant-hue-spread metric gated at saturation 0.20, which the
 * deep never clears: it scored 0.154% on the deep reference frame the entire
 * biome pass was aimed at, i.e. it was blind to the exact frames that needed
 * measuring. 0.06 admits them. `minVal` is the companion floor: hue and
 * saturation of a near-black pixel are arithmetic on quantisation noise, and
 * v < 0.02 is below display code 5, where an 8-bit sRGB step is a third of the
 * remaining range. Note what this gate does NOT establish - 100.0% of every
 * underwater frame's pixels clear s >= 0.06 at a median luminance of 0.05, so a
 * high gated fraction is not evidence of colour, only evidence that the gate
 * did not throw the frame away.
 */
export const DEFAULT_GATE = Object.freeze({ minSat: 0.06, minVal: 0.02 });

/**
 * Default analysis window, as fractions of frame height.
 *
 * Rows outside [0.08, 0.82] carry the HUD - a compass band at the top and a
 * depth/status band at the bottom - which is authored UI colour at authored UI
 * saturation and would contribute the same bins to every frame in the suite,
 * flattening exactly the between-frame differences the cosine exists to find.
 * The section-0 baseline table was measured with this window, so changing it
 * invalidates comparison against that table. Prefer capturing with
 * `subwave.hud.visible = false` (passes/hud.js gates the pass on it) AND
 * keeping this crop, so the numbers stay comparable either way.
 *
 * IT GOVERNS THE COLOUR STATISTICS AND NOTHING ELSE. Every figure `frameMetrics`
 * returns is taken inside it; the depth-derived near-mass a caller pairs those
 * figures with is not, because it comes off a render target rather than off these
 * pixels. See the near-mass docstring in `tools/test-variety.mjs` for what the
 * two pixel sets disagree about.
 *
 * The bounds are taken with FLOOR, not round, and that is not arbitrary: on a
 * 757-row frame the two differ by one row and the difference is measurable -
 * trench-wall's flat fraction reads 0.286 under floor and 0.273 under round,
 * 4.5% apart. Floor is what the section-0 baseline used, and reproducing that
 * table to its printed precision is the whole acceptance test for this kernel.
 */
export const DEFAULT_CROP = Object.freeze({ top: 0.08, bottom: 0.82, left: 0.0, right: 1.0 });

/**
 * Rec709 luma of a display code triple.
 *
 * @param {number} r red in [0, 1]
 * @param {number} g green in [0, 1]
 * @param {number} b blue in [0, 1]
 * @returns {number} luma in [0, 1]
 */
export function luma709(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * HSV of a display code triple, written out-first so no per-pixel allocation
 * happens in the analysis loop.
 *
 * @param {Float64Array|number[]} out receives [hue in [0,360), sat, val]
 * @param {number} r red in [0, 1]
 * @param {number} g green in [0, 1]
 * @param {number} b blue in [0, 1]
 * @returns {Float64Array|number[]} out
 */
export function rgbToHsv(out, r, g, b) {
  const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
  const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
  }
  out[0] = h;
  out[1] = max > 0 ? d / max : 0;
  out[2] = max;
  return out;
}

/**
 * Cosine similarity between two histograms.
 *
 * 1.0 means the two frames distribute their colour identically; the section-0
 * finding is that abyss and trench-wall, 200 m apart in depth, measure 0.9975 -
 * statistically one image. Zero-length vectors return 0 rather than NaN so a
 * fully gated-out frame degrades to "shares nothing" instead of poisoning a
 * confusion matrix.
 *
 * @param {ArrayLike<number>} a first histogram
 * @param {ArrayLike<number>} b second histogram, same length
 * @returns {number} similarity in [0, 1] for non-negative histograms
 */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) throw new Error(`cosineSimilarity: length ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * Shannon entropy of a hue distribution, in bits.
 *
 * The ceiling is log2(32) = 5 bits. The measured band for the art-direction
 * reference class is 1.24-3.38; the shipped deep frames measure 0.08-0.67, and
 * `underwater-deep` at 0.08 bits is a frame that carries essentially one hue.
 *
 * WHICH WEIGHTS TO HAND IT. `frameMetrics` reports the entropy of the GATED
 * PIXEL COUNTS (`hueCounts`) as the headline figure, because that is what the
 * section-0 baseline is: over the same seven `qa-output/` frames the counts
 * variant returns 0.6656 / 0.4086 / 0.0772 / 1.2985 / 1.6125 / 1.5187 / 3.4530,
 * which is the published table (0.67 / 0.41 / 0.08 / 1.30 / 1.61 / 1.52 / 3.46)
 * to the printed digit on six of seven and to within 0.3% on the seventh - spawn
 * rounds to 3.45, not the printed 3.46. A saturation-weighted variant does not
 * reproduce it at all (0.64 / 0.40 / 0.05 / 1.32 / 1.85 / 0.90 / 3.12, i.e. up
 * to 41% out at underwater-shallow, and out in BOTH directions). The
 * saturation-weighted form is reported alongside as `hueEntropySatBits` because
 * it answers a different and also useful question - how the DELIVERED chroma is
 * spread rather than how the pixels are - but weighting by saturation on top of
 * an s >= 0.06 gate weights the same quantity twice, and on frames where nearly
 * every pixel clears the gate that mostly re-ranks bins by how saturated they
 * happen to be. Do not swap which one is headline without re-baselining.
 *
 * @param {ArrayLike<number>} hueWeights HUE_BINS totals, counts or weights
 * @returns {number} entropy in bits, 0 when the frame carries no gated chroma
 */
export function hueEntropyBits(hueWeights) {
  let total = 0;
  for (let i = 0; i < hueWeights.length; i++) total += hueWeights[i];
  if (total <= 0) return 0;
  let h = 0;
  for (let i = 0; i < hueWeights.length; i++) {
    const p = hueWeights[i] / total;
    if (p > 0) h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Linearly interpolated percentile of an ASCENDING-sorted sample array.
 *
 * @param {ArrayLike<number>} sorted ascending samples
 * @param {number} q quantile in [0, 1]
 * @returns {number} the interpolated sample value
 */
export function percentile(sorted, q) {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = lo + 1 >= n ? n - 1 : lo + 1;
  const f = pos - lo;
  return sorted[lo] * (1 - f) + sorted[hi] * f;
}

/**
 * Resolve a crop specified in height/width fractions to integer pixel bounds.
 *
 * @param {number} width frame width
 * @param {number} height frame height
 * @param {{top?: number, bottom?: number, left?: number, right?: number}} crop fractions
 * @returns {{x0: number, y0: number, x1: number, y1: number}} half-open bounds
 */
export function resolveCrop(width, height, crop) {
  const c = crop || DEFAULT_CROP;
  const t = c.top === undefined ? 0 : c.top;
  const bo = c.bottom === undefined ? 1 : c.bottom;
  const l = c.left === undefined ? 0 : c.left;
  const r = c.right === undefined ? 1 : c.right;
  // Floor, not round - see DEFAULT_CROP for the measured reason.
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(t * height)));
  const y1 = Math.max(y0 + 1, Math.min(height, Math.floor(bo * height)));
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(l * width)));
  const x1 = Math.max(x0 + 1, Math.min(width, Math.floor(r * width)));
  return { x0, y0, x1, y1 };
}

/**
 * Every per-frame statistic, from one pass over the decoded image.
 *
 * The parity option is the instrument's own self-test. Splitting ONE frame into
 * its two checkerboard halves and comparing them must return >= 0.9999, and
 * that is what establishes that all later variance between frames is world
 * variance and not instrument noise - the same discipline as `test-variety`'s
 * control repeat, which exists because a same-anchor comparison of one fixed
 * build has already read 0.0003 to 0.9594.
 *
 * @param {{width: number, height: number, channels: number, data: Uint8Array}} image decoded PNG
 * @param {{crop?: object, gate?: {minSat: number, minVal: number}, parity?: number|null}} [options]
 * @returns {{
 *   width: number, height: number, pixels: number,
 *   hist: Float64Array, hueCounts: Float64Array, hueSatWeights: Float64Array,
 *   gatedFraction: number, hueEntropyBits: number, hueEntropySatBits: number,
 *   medianL: number, p05L: number, p95L: number, dynamicRange: number,
 *   meanL: number, darkMass: number, flatFraction: number
 * }} the frame's statistics; `hist` is the HIST_BINS histogram for cosineSimilarity
 */
export function frameMetrics(image, options = {}) {
  const { width, height, channels, data } = image;
  const gate = options.gate || DEFAULT_GATE;
  const parity = options.parity === undefined ? null : options.parity;
  const { x0, y0, x1, y1 } = resolveCrop(width, height, options.crop);

  const maxPixels = (x1 - x0) * (y1 - y0);
  const lum = new Float32Array(maxPixels);
  const hist = new Float64Array(HIST_BINS);
  const hueCounts = new Float64Array(HUE_BINS);
  const hueSatWeights = new Float64Array(HUE_BINS);
  const hsv = new Float64Array(3);
  const inv255 = 1 / 255;

  let n = 0;
  let gated = 0;
  let sumL = 0;
  for (let y = y0; y < y1; y++) {
    const rowStart = y * width * channels;
    for (let x = x0; x < x1; x++) {
      // Checkerboard parity keeps the subsample spatially unbiased: a column or
      // row subsample would systematically favour one phase of any vertical or
      // horizontal structure in the frame.
      if (parity !== null && ((x + y) & 1) !== parity) continue;
      const i = rowStart + x * channels;
      let r;
      let g;
      let b;
      if (channels >= 3) {
        r = data[i] * inv255;
        g = data[i + 1] * inv255;
        b = data[i + 2] * inv255;
      } else {
        r = data[i] * inv255;
        g = r;
        b = r;
      }
      const l = luma709(r, g, b);
      lum[n++] = l;
      sumL += l;
      rgbToHsv(hsv, r, g, b);
      const s = hsv[1];
      if (s < gate.minSat || hsv[2] < gate.minVal) continue;
      gated++;
      let hb = (hsv[0] / 360) * HUE_BINS | 0;
      if (hb >= HUE_BINS) hb = HUE_BINS - 1;
      let sb = s * SAT_BINS | 0;
      if (sb >= SAT_BINS) sb = SAT_BINS - 1;
      hist[hb * SAT_BINS + sb]++;
      hueCounts[hb]++;
      hueSatWeights[hb] += s;
    }
  }

  const used = lum.subarray(0, n);
  const sorted = used.slice();
  sorted.sort();
  const medianL = percentile(sorted, 0.5);
  const p05L = percentile(sorted, 0.05);
  const p95L = percentile(sorted, 0.95);

  // Dark mass and flat fraction are RELATIVE to this frame's own median so the
  // question asked of a 0.05-median abyss frame and a 0.49-median beach frame is
  // the same question. On a frame with no median there is nothing to be relative
  // to, so both degrade to zero rather than to a divide-by-zero.
  const darkCut = 0.4 * medianL;
  const flatCut = 0.10 * medianL;
  let dark = 0;
  let flat = 0;
  if (medianL > 0) {
    for (let i = 0; i < n; i++) {
      const l = used[i];
      if (l < darkCut) dark++;
      const d = l - medianL;
      if ((d < 0 ? -d : d) < flatCut) flat++;
    }
  }

  return {
    width,
    height,
    pixels: n,
    hist,
    hueCounts,
    hueSatWeights,
    gatedFraction: n > 0 ? gated / n : 0,
    hueEntropyBits: hueEntropyBits(hueCounts),
    hueEntropySatBits: hueEntropyBits(hueSatWeights),
    medianL,
    p05L,
    p95L,
    dynamicRange: p05L > 0 ? p95L / p05L : Infinity,
    meanL: n > 0 ? sumL / n : 0,
    darkMass: n > 0 ? dark / n : 0,
    flatFraction: n > 0 ? flat / n : 0,
  };
}
