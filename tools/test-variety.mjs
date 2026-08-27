#!/usr/bin/env node
/**
 * The biome-variety tour: the acceptance instrument for biome identity work.
 *
 * WHY THIS EXISTS. `CLAUDE.md` cites "frame-to-frame cosine
 * similarity over 2-D hue x saturation histograms, 0.384 against the reference
 * frames' 0.148" as the authoritative measure of biome variety, and that metric has no
 * implementation at any point in this repository's history. Every acceptance
 * criterion phrased in terms of it was a claim. This tool is the measurement:
 * it drives the real game, visits every biome destination through
 * `subwave.jumpTo(short)` so NO COORDINATE IS BAKED, captures the delivered
 * display-referred frame, and runs the one shared kernel in
 * `tools/lib/frame-metrics.mjs` over it.
 *
 * WHY THE TOUR RUNS TWICE. The whole tour is run twice in one process and the
 * SAME-ANCHOR SELF-COSINE is the gate on believing anything else. Comparing a
 * shipped tour against an older tour of the same 14 anchors gave same-biome
 * cosines from 0.0003 to 0.9594, and this project has a flee metric that read
 * 0.096 / 0.998 / 0.910 across three runs of ONE fixed build. If any
 * destination's self-cosine falls below CONTROL_MIN the run is reported VOID
 * and is a lottery read, not data. A VOID run exits non-zero and writes no
 * baseline.
 *
 * WHY COSINE IS NEVER THE ACCEPTANCE NUMBER ON ITS OWN. Cosine measures the
 * difference BETWEEN frames and is maximised by "every frame is one different
 * colour". Measured on the shipped build, `abyss` x `underwater-deep` scores
 * 0.1328 - spectacularly different - on two frames carrying 0.67 and 0.08 bits
 * of hue entropy with dark mass 0.0000 on both, i.e. two degenerate frames each
 * of a single flat colour. That is the same class of error as the retired
 * dominant-hue-spread metric. Every cosine printed here is therefore printed
 * next to the WITHIN-frame floors - hue entropy, dark mass, p95/p05, flat
 * fraction - and the acceptance gate is the CONJUNCTION G1..G7, never G1 alone.
 *
 * AND G5 IS NOT A NEAR-MASS BAND. It was one for a whole stage, and a single
 * scalar cannot tell "a foreground element at a readable distance" from "an
 * object against the lens" - opposite outcomes. Measured: the `s1-final` Canyon
 * Wall frame PASSED at nearMass 0.1718 on an image that is one pale banner
 * filling the middle of the frame with its lower edge 0.58 m from the eye, while
 * the best-composed frame in the committed baseline - the Shelf Break shelf edge
 * - was REJECTED by 0.0008. G5 is now the conjunction of three independent
 * questions about the depth buffer (`g5Verdict`): lens clearance, the near-mass
 * band, and the standoff of the median ray. It is calibrated against four frames
 * that were opened and looked at, and `--check-g5` re-runs that calibration
 * offline in a second so a threshold cannot be moved without saying which frame
 * it reclassifies.
 *
 * AND NO METRIC REPLACES LOOKING. The PNGs are written to
 * `variety-output/<report name>/` (the control tour's into its `repeat/`)
 * precisely so a human reads them at every stage gate: a frame of coloured
 * noise passes G1-G4, and three visual bugs have shipped here with every suite
 * green. Never `qa-output/` - `qa.mjs` wipes that directory at startup and two
 * concurrent runs clobber each other's screenshots.
 *
 * THE FRAMES ARE DELIBERATELY UNTRACKED; THE REPORTS ARE TRACKED. `.gitignore`
 * excludes everything under `variety-output/` except the `*.json`, because one
 * tour is 33 MB of PNG and putting that in the history is a one-way door - while
 * every pixel of it is reproducible from the report beside it, which records the
 * seed, the day fraction, the settle and the pose each frame was taken at. To
 * get the images for a report back, re-run the tour that wrote it:
 * `node tools/test-variety.mjs --out <that report name> --force` - the `--force`
 * is required because that name's JSON already exists, and the re-run rewrites
 * it, so if the numbers matter take a plain run and compare instead.
 * Consequently a frame referenced by a `frame:` field in a committed report may
 * simply not be on a given machine, and that is not a fault.
 *
 * A RUN NEVER OVERWRITES ANOTHER RUN'S NUMBERS. This tool used to write
 * `variety-output/report.json` and `variety-output/report/*.png` unconditionally,
 * so the last tour of a session silently destroyed the numbers the previous
 * stage was being graded against - one whole stage's worth of intermediates was
 * lost that way, and the loss is invisible because the replacement file looks
 * exactly like the thing it replaced. A plain run now writes
 * `variety-output/run-<UTC stamp>.json` beside `variety-output/run-<UTC stamp>/`,
 * and `variety-output/latest.json` is rewritten as a POINTER (not a copy) at the
 * run that just finished. Any run - default or `--out` - REFUSES to start when
 * its report file or its frame directory already exists, unless `--force` is
 * passed. `variety-output/baseline.json` is the local before/after reference on
 * whatever machine took it, AND MUST NEVER BE OVERWRITTEN BY A PLAIN RUN; that
 * guard is what makes overwriting it a deliberate `--out baseline.json --force`
 * and not an accident. IT IS NOT COMMITTED AND CANNOT BE: `.gitignore` excludes
 * `variety-output/` as a whole directory, with no `!` re-includes, so a clone
 * has no baseline at all. Take a fresh control on the tree you are changing
 * before using any tour as a gate - see CLAUDE.md's tour-comparability rule.
 *
 * FIXED CONDITIONS, all of them, because a tour that changes two things at once
 * measures neither: `worldClock.setDayFraction(0.32)`, the lamp policy
 * `lampOn = depth > 150`, `hud.visible = false` (passes/hud.js gates the pass on
 * exactly that field), EVERY DOM OVERLAY HIDDEN INCLUDING THE CONTROL LEGEND -
 * see `hideOverlays`, which did not hide it until 2026-08-06 and so left
 * authored UI colour inside the cropped pixels of every tour before that - the
 * eye PINNED at the composed arrival pose for the whole settle, and a settle
 * measured rather than guessed - see `--probe-settle` and the SETTLE_SECONDS
 * docstring.
 *
 * WHAT THE CONTROL BOUNDS IS EVERY GATED QUANTITY, and it did not always. The
 * control table printed the self-cosine and the tour-to-tour delta of hue
 * entropy, dark mass and median luminance - three of the eleven statistics this
 * report is graded on. Stage 2 was argued in p95/p05 and flat fraction, which
 * had NO control bound at all, and its headline number was a deep-seven mean
 * pairwise cosine that had none either, so a verifier could not tell a 0.05
 * movement from run-to-run variance and had to abandon the attribution. Every
 * quantity any G1..G7 gate reads is now differenced across the two tours and
 * printed: the colour statistics in CONTROL, G5's three depth clauses in
 * CONTROL, DEPTH COMPOSITION, and G1/G7's cosines in CONTROL, BETWEEN-ANCHOR
 * COSINE, which rebuilds the whole confusion matrix from tour 2.
 *
 * Usage:
 *   node tools/test-variety.mjs                    the tour, twice, gated;
 *                                                  writes run-<stamp>.json
 *   node tools/test-variety.mjs --out s2-after.json  ...under a name you choose
 *   node tools/test-variety.mjs --out baseline.json --force   re-baseline (rare)
 *   node tools/test-variety.mjs --probe-settle     measure the settle time
 *   node tools/test-variety.mjs --only reef,canyon  a subset, for iteration
 *   node tools/test-variety.mjs --gate             exit 1 if G1..G7 fail
 *   node tools/test-variety.mjs --check-g5         the G5 calibration, OFFLINE:
 *                                                  no browser, no server, ~1 s
 *   node tools/test-variety.mjs --check-g5 variety-output/s1-final.json
 *                                                  ...and sweep a real tour's
 *                                                  anchors through the same gate
 *   node tools/test-variety.mjs --force            allow an existing name to be
 *                                                  replaced
 *
 * EXIT CODE. Non-zero when the RUN is invalid: boot failure, an unreachable
 * destination, or a VOID control. The G1..G7 acceptance gates are reported as a
 * scorecard and do NOT fail the run unless `--gate` is passed, because they are
 * the target the biome plan is aiming at and the build being baselined today
 * misses most of them by design. A stage that claims to have met a gate runs
 * this with `--gate`.
 */

import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchBrowser } from './lib/browser.mjs';
import { decodePNG } from './lib/png.mjs';
import {
  frameMetrics, cosineSimilarity, DEFAULT_CROP, DEFAULT_GATE, HUE_BINS, SAT_BINS,
} from './lib/frame-metrics.mjs';

// ---------------------------------------------------------------------------
// Fixed conditions
// ---------------------------------------------------------------------------

/**
 * The one time of day every frame in the suite is taken at.
 *
 * It is set on ARRIVAL and the clock then runs for the settle, because freezing
 * it is not free: `WorldClock.setDayFraction` rewrites `totalSeconds`, so
 * re-asserting the fraction every frame (or setting `frozen`) stops world time
 * outright and with it the waves, the sway and every creature animation. The
 * residual is therefore SETTLE seconds of clock at the 20-real-minute day, i.e.
 * about 0.012 of a day for a 14 s settle - and it is the SAME residual at every
 * anchor and in both tours, so it cancels in every comparison this tool makes.
 * Each capture records the day fraction it was actually taken at, so the claim
 * is auditable rather than assumed.
 */
const DAY_FRACTION = 0.32;

/**
 * Eye depth, in metres, past which the suit lamp is on.
 *
 * A fixed policy, not a per-anchor decision: the lamp is worth several stops of
 * near-field light, so letting it follow anything that varies between runs (an
 * input edge, a previous scenario's state, the player's own toggle) would put a
 * multi-stop step into the metric that has nothing to do with the biome.
 */
const LAMP_DEPTH = 150;

/**
 * Seconds the eye is held, pinned, at the arrival pose before the capture.
 *
 * MEASURED, not guessed, and the measurement changed what the number is FOR.
 * `--probe-settle` holds one arrival at 1/2/3/4/6/8/10/12/14/17/21 s and reports
 * each frame's cosine against that anchor's own final frame, alongside median
 * luminance, delivered exposure, resident and pending chunks. Measured
 * 2026-08-04 at Volcanic Beach, Shallow Reef and Canyon Wall:
 *
 *   - STREAMING IS NOT WHAT THE SETTLE IS WAITING FOR. Pending chunks were 0 and
 *     the resident count was flat at the FIRST probe, 1 s, at all three - the
 *     terrain bake is on the worker pool and `jumpTo` primes the scatter itself.
 *   - THE FRAME DOES NOT CONVERGE TO A FIXED POINT, so there is no settle at
 *     which it stops moving. Cosine-to-final at the beach ran 0.924 / 0.961 /
 *     0.983 / 0.987 / 0.979 / 0.985 / 0.992 at 1/3/6/8/10/12/14 s - NOT monotone,
 *     because the sea, the clouds and the grass are animated and the day advances
 *     0.00083 of a day per second.
 *   - WHAT LOOKS LIKE ADAPTATION LAG IS THE SUN. Reef exposure fell 2.09 -> 1.69
 *     over 21 s while delivered median luminance moved 0.4296 -> 0.4388, i.e. the
 *     metering was tracking a rising sun, not still converging on the arrival.
 *     At Canyon Wall exposure was pinned at the 25.6 rail from the first probe.
 *
 * So the settle is chosen for the ONE thing that is genuinely slow - the
 * near-field creature director, which seeds animals around the eye over the
 * first ten-odd seconds and which qa.mjs holds 13-15 s for - and everything else
 * is licensed by the CONTROL REPEAT rather than by a convergence claim. At 14 s,
 * over THREE full 14-destination runs of one unchanged build, the worst
 * same-anchor self-cosine was 0.9991 / 0.9980 / 0.9949 against a 0.98 gate, and
 * the deep-seven subset mean landed on 0.6903 / 0.6921 / 0.6903 - so the
 * headline figure is stable to about a thousandth while the control still has
 * five times the margin it needs.
 */
const SETTLE_SECONDS = 14;

/**
 * The control gate. Below this at ANY destination the run is VOID.
 *
 * 0.98 is the proposal's number and it is deliberately strict: the instrument's
 * own checkerboard self-test returns >= 0.9999 on a single frame, so everything
 * between 0.9999 and the gate is world variance - streaming, fauna, wave phase,
 * TAA - and a tour that cannot hold 0.98 across a repeat cannot resolve the
 * between-biome differences it exists to measure.
 */
const CONTROL_MIN = 0.98;

/**
 * Near-mass horizon, metres. Matches the proposal's G5 definition.
 *
 * NEAR-MASS AND THE COLOUR STATISTICS ARE TAKEN OVER DIFFERENT PIXELS, and a
 * reader who assumes otherwise will explain one with the other. Every histogram,
 * entropy, dark-mass, flat-fraction and percentile figure in this report comes
 * from `frameMetrics` under `DEFAULT_CROP`, rows 8%-82%; near-mass comes from
 * `renderer.debugReadDepth` over the WHOLE frame. At these framings the
 * discarded bottom 18% is exactly where the near-field seabed sits, so the two
 * can disagree by a lot: `canyon` reports nearMass 0.827 off a 7.7 m median ray
 * while its colour statistics never see that band. The crop stays as it is -
 * it is what keeps these numbers comparable with the committed baseline, and
 * cropping the depth read to match would silently rebaseline G5 - so the
 * mismatch is stated rather than removed.
 */
const NEAR_METRES = 15;

/**
 * G5's LENS FLOOR, metres: nothing may be nearer than this.
 *
 * NEAR-MASS ALONE IS NOT A COMPOSITION CHECK, and G5 was tuned against it for a
 * whole stage. "A foreground element at a readable distance" and "an object
 * against the lens" are opposite outcomes and near-mass cannot tell them apart:
 * `s1-final`'s Canyon Wall frame scored nearMass 0.1718, comfortably INSIDE the
 * old [0.06, 0.20] band, on a frame that is one pale banner filling the middle
 * of the image with its lower edge 0.58 m from the eye. That frame is the
 * reason this clause exists, and it is the ONLY clause that rejects it.
 *
 * 1.2 m is empirical, not a round number: over the four calibration frames plus
 * the twelve underwater anchors of `s1-final.json`, the nearest-geometry
 * distances fall into two groups with nothing between them - 0.52 m (kelp, a
 * stipe clipping the lens) and 0.58 m (canyon) below, and 2.21 m (sand) and up
 * above. 1.2 m sits at 2.1x the highest rejected reading and 0.54x the lowest
 * accepted one, i.e. roughly the log-midpoint of an empty octave.
 *
 * IT IS A SINGLE-SAMPLE STATISTIC AND THAT IS ITS WEAKNESS: `debugReadDepth`'s
 * `min` is the closest of ~101k sub-samples, so one drifting particle or one
 * fish crossing the lens trips it. `near.lensMass` - the SHARE of the frame
 * inside this same distance, taken from the depth ladder below - is printed
 * beside it precisely so a reader can tell "one stray sample" (lensMass at or
 * near 0.0000) from "an object against the lens" (a lensMass with digits in it)
 * without opening the PNG. Measured on the three-anchor ladder run, tour 1 vs
 * the control repeat: canyon 0.0790 / 0.0791, kelp 0.0867 / 0.0823, break
 * 0.0000 / 0.0000 - so it separates the two rejected frames from the accepted
 * one by two orders of magnitude and repeats to within 5%, where `min` is one
 * sample and repeats to within 2.5% only because these particular occluders are
 * static. The gate is on `min` anyway, because that is the field the historical
 * reports recorded and it is what makes the calibration below a measurement
 * rather than an assertion; once enough tours carry a ladder, move it to
 * `lensMass` and re-derive the threshold from those three columns.
 */
const LENS_FLOOR_METRES = 1.2;

/**
 * G5's near-mass band: share of the WHOLE frame within `NEAR_METRES`.
 *
 * The upper bound was 0.20 and is now 0.25, which is the one place this gate
 * got LOOSER. `baseline.json`'s Shelf Break frame - a legible shelf edge with
 * layered depth, urn sponges at a readable standoff and a long view to the left,
 * i.e. the best-composed underwater frame in the whole baseline - measured
 * 0.22077 and was REJECTED by 0.0008. The two frames this bound exists to reject
 * measure 0.7754 (two urn bodies at arm's length) and 0.8267 (a close-in pocket
 * with nothing beyond 38 m), so any cap in [0.221, 0.775] separates the observed
 * cases and the old one merely sat a hair inside the good frame. Net, G5 is far
 * stricter than it was: this bound moved 0.05 to admit one validated-good frame
 * while two independent clauses were added.
 */
const NEAR_MASS_MIN = 0.06;
const NEAR_MASS_MAX = 0.25;

/**
 * G5's STANDOFF floor, metres: the median ray must reach at least this far.
 *
 * The second thing near-mass cannot express. A frame can be legitimately
 * enclosed - Canyon Wall and Trench Wall are SUPPOSED to be, their Avoid column
 * reads "open horizons" - so the discriminator cannot be depth SPREAD, which
 * would fail exactly the biomes whose identity is confinement (measured p95/median
 * is 4.8 at Shelf Break and 9.5 at Trench Wall against 47 at Kelp Forest). It is
 * how far away the typical thing being looked at IS. Measured: 5.79 m for the
 * two-urns frame and 7.69 m for the buried-pocket frame, against 36.07 m for the
 * good shelf edge and 12.9 m for the lowest-standoff frame in `s1-final` that
 * nobody has objected to. 10 m rejects both bad cases with 1.3x margin and
 * clears every current anchor.
 */
const STANDOFF_METRES = 10;

/**
 * Horizons, in metres, of the DEPTH LADDER: a cumulative depth histogram built
 * out of the one field `debugReadDepth` already returns.
 *
 * `debugReadDepth(h).nearMass` is the fraction of the frame within `h` metres,
 * i.e. the depth CDF evaluated at `h`. Calling it along a ladder therefore gives
 * the whole distribution for free, with NO change to `render/renderer.js` - which
 * matters because a single flat slab and a layered composition can share a
 * median, a min and a near-mass and differ entirely in where the rest of the
 * frame sits. The bands are `[0, 1.2) [1.2, 4) [4, 10) [10, 25) [25, 60)
 * [60, 150) [150, inf)`, normalised over GEOMETRY samples so that sky - which is
 * legitimately most of an above-water frame - does not swamp the shape.
 *
 * THIS IS REPORTED AND NOT GATED, deliberately. The three historical calibration
 * frames below cannot be re-measured: a depth buffer is not recoverable from a
 * PNG, and two of the three were taken on trees that no longer exist. Gating on
 * a statistic that cannot be checked against the known-bad frames would be
 * exactly the "assertion written against a draft" this project keeps finding.
 *
 * IT ALREADY EARNS ITS PLACE AS A DIAGNOSTIC. Measured on the three-anchor
 * ladder run: the rejected Canyon Wall banner reads `.10 .10 .01 .01 .17 .16
 * .45` - a fifth of the geometry inside 4 m, a HOLE from 4 to 25 m, and 45%
 * past 150 m, which is "one object against a void" written out - against the
 * accepted shelf edge's `.00 .00 .01 .25 .27 .28 .19`, which is a ramp. It
 * costs one extra `debugReadDepth` per horizon per capture, measured at 573-850
 * ms for all six (95-140 ms each, dominated by the 5.8 MB depth readback), i.e.
 * about 18 s on a 14-anchor two-tour run of roughly 7.5 minutes.
 */
const DEPTH_LADDER = [LENS_FLOOR_METRES, 4, 10, 25, 60, 150];

/**
 * The four frames G5 is calibrated against, with the numbers AS RECORDED.
 *
 * A gate whose thresholds are argued rather than measured is a claim, and this
 * one is checkable: `--check-g5` runs the shipped `g5Verdict` over these records
 * and fails if any verdict disagrees with the `expect` column. The numbers are
 * embedded because none of the three reports is committed - `baseline.json`,
 * `i13-after.json` and `s1-final.json` are all machine-local and may not exist
 * on a given clone - and `--check-g5` re-reads whichever of them IS present
 * and refuses if the embedded copy has drifted from it, so the literals cannot
 * quietly stop describing the run they came from.
 *
 * Every one of these four frames was opened and looked at, which is the only
 * reason the `expect` column means anything.
 */
const G5_CALIBRATION = Object.freeze([
  {
    label: 'buried pocket', report: 'variety-output/baseline.json', short: 'canyon',
    generated: '2026-08-05T06:45:44.118Z',
    frame: 'variety-output/baseline/canyon.png',
    looksLike: 'a close-in pocket: nothing in the frame is beyond 38 m and the '
      + 'whole image is near-field mush',
    near: { min: 4.5225934982299805, nearMass: 0.8267469093712015,
      median: 7.694061279296875, p95: 37.79926300048828, infFraction: 0 },
    expect: false,
  },
  {
    label: 'two urns at arm\'s length', report: 'variety-output/i13-after.json', short: 'break',
    generated: '2026-08-05T10:22:05.633Z',
    frame: 'variety-output/i13-after/break.png',
    looksLike: 'two urn-sponge bodies fill the frame from top to bottom; the '
      + 'shelf edge the biome is named for is invisible behind them',
    near: { min: 4.418473243713379, nearMass: 0.7753994841540423,
      median: 5.791344165802002, p95: 45.17930221557617,
      infFraction: 0.07421461958831145 },
    expect: false,
  },
  {
    label: 'legible shelf edge', report: 'variety-output/baseline.json', short: 'break',
    generated: '2026-08-05T06:45:44.118Z',
    frame: 'variety-output/baseline/break.png',
    looksLike: 'the reference GOOD composition: urn sponges at a readable '
      + 'standoff, a lit slope receding to the right, open water to the left',
    near: { min: 4.739410400390625, nearMass: 0.22076625853566947,
      median: 36.07033920288086, p95: 1678.0465087890625,
      infFraction: 0.2841105610071843 },
    expect: true,
  },
  {
    label: 'banner against the lens', report: 'variety-output/s1-final.json', short: 'canyon',
    generated: '2026-08-05T15:05:18.407Z',
    frame: 'variety-output/s1-final/canyon.png',
    looksLike: 'ONE pale banner fills the middle of the frame against near-black, '
      + 'its lower edge 0.58 m from the eye; PASSED the old near-mass band at 0.1718',
    near: { min: 0.5791498422622681, nearMass: 0.17183006729714506,
      median: 120.7206039428711, p95: 8938.0615234375,
      infFraction: 0.19138675600090915 },
    expect: false,
  },
]);

/**
 * Biome ids in the "deep seven" subset, by the proposal's G7 split.
 *
 * Shelf Break through Trench Floor. The complementary shallow seven is ids 0-6.
 * Ids are used rather than names because `BIOMES` order is load-bearing
 * arithmetic elsewhere in the project and the split must not silently follow a
 * rename.
 */
const DEEP_IDS = new Set([7, 8, 9, 10, 11, 12, 13]);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'variety-output');

const args = process.argv.slice(2);
const flag = (n, d = null) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const SETTLE = Number(flag('--settle', String(SETTLE_SECONDS)));
const ONLY = flag('--only');
const PROBE_SETTLE = args.includes('--probe-settle');
const HARD_GATE = args.includes('--gate');
const FORCE = args.includes('--force');
/** `--check-g5 [report.json]`: the offline G5 calibration. No browser at all. */
const CHECK_G5 = args.includes('--check-g5');
const CHECK_G5_SWEEP = (() => {
  const next = args[args.indexOf('--check-g5') + 1];
  return CHECK_G5 && next && !next.startsWith('--') ? next : null;
})();

/**
 * UTC stamp, seconds resolution, sortable: `20260805-064700`.
 *
 * UTC and not local time because these names are quoted in reports and commit
 * messages that outlive the machine's timezone, and seconds and not minutes
 * because two tours of a 14-anchor subset can finish inside the same minute -
 * at which point the second one would collide with the first and (with
 * `--force`) destroy exactly what this naming exists to protect.
 */
const RUN_STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');

/** The default report name. Unique per run, so a plain run destroys nothing.
 *  `.json` is appended when missing: `--out p0-base` used to run the whole
 *  17-minute tour and then die writing the report INTO its own frame
 *  directory (`join(OUT, 'p0-base')`, EISDIR), because SHOT_DIR is the name
 *  with `.json` stripped and without the suffix the two are the same path. */
const OUT_NAME_RAW = flag('--out', `run-${RUN_STAMP}.json`);
const OUT_NAME = /\.json$/i.test(OUT_NAME_RAW) ? OUT_NAME_RAW : OUT_NAME_RAW + '.json';

/**
 * Where the frames go: `variety-output/<report name without .json>/`, with the
 * control tour's frames one level down in `repeat/`.
 *
 * Naming the image directory after the report is not tidiness. With every run
 * writing `variety-output/<short>.png`, a three-second `--only kelp` smoke run
 * silently replaced one frame of a committed 14-anchor baseline with a frame
 * taken under different conditions - the JSON and the PNGs beside it stopped
 * describing the same run, and nothing said so. This makes a run's images and
 * its report one indivisible set.
 */
const SHOT_DIR = join(OUT, OUT_NAME.replace(/\.json$/i, ''));

/** Pointer file rewritten after every VALID run so `latest` means something. */
const LATEST = join(OUT, 'latest.json');

/** Hold times, in seconds, that `--probe-settle` captures at. Note the 17 s
 *  and 21 s holds run PAST the spawner's 20 s first-encounter beat
 *  (NEARFIELD_PROWLER_FIRST), unpaused - a staged predator can enter those
 *  frames. Diagnostic only; the gated tour captures at 14 s with the sim
 *  paused and is not exposed. */
const PROBE_TIMES = [1, 2, 3, 4, 6, 8, 10, 12, 14, 17, 21];
/** Destinations `--probe-settle` uses: one in air, one shallow, one deep. */
const PROBE_ANCHORS = ['beach', 'reef', 'canyon'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// THE BROWSER PLUMBING LIVES IN tools/lib/browser.mjs NOW. This file is where
// the leak was found and fixed on 2026-08-06, and the fix then stayed here while
// shot.mjs and probe.mjs went on leaking - measured, 174 abandoned profiles
// holding 8.6 GB after this file was already correct. That is what a copy of one
// truth costs, so there is one copy: `launchBrowser` implements the reaper, the
// SIGKILL and all seven exit paths, and every browser tool here calls it.

// ---------------------------------------------------------------------------
// Minimal CDP-over-WebSocket client. We ship no dependencies, and every browser
// tool in tools/ inlines its own for that reason.
// ---------------------------------------------------------------------------

class Sock {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname; this.port = +u.port; this.path = u.pathname + u.search;
    this.buf = Buffer.alloc(0); this.pending = new Map(); this.id = 1; this.onEvent = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = createHash('sha1').update(String(Math.random())).digest('base64');
      this.s = connect(this.port, this.host, () => {
        this.s.write(`GET ${this.path} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n');
      });
      this.s.on('error', reject);
      let up = false;
      this.s.on('data', (c) => {
        if (!up) {
          const i = c.indexOf('\r\n\r\n');
          if (i < 0) return;
          up = true;
          const rest = c.subarray(i + 4);
          if (rest.length) this._feed(rest);
          resolve();
          return;
        }
        this._feed(c);
      });
    });
  }

  _feed(c) {
    this.buf = Buffer.concat([this.buf, c]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const op = b[0] & 0x0f;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (b.length < off + len) return;
      const payload = b.subarray(off, off + len);
      this.buf = b.subarray(off + len);
      if (op !== 1) continue;
      try {
        const m = JSON.parse(payload.toString('utf8'));
        if (m.id != null && this.pending.has(m.id)) {
          const { resolve, reject } = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        } else if (this.onEvent) this.onEvent(m);
      } catch { /* ignore */ }
    }
  }

  send(method, params = {}) {
    const id = this.id++;
    const data = Buffer.from(JSON.stringify({ id, method, params }), 'utf8');
    const n = data.length;
    let h;
    if (n < 126) { h = Buffer.alloc(6); h[0] = 0x81; h[1] = 0x80 | n; }
    else if (n < 65536) { h = Buffer.alloc(8); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(n, 2); }
    else { h = Buffer.alloc(14); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(n), 2); }
    this.s.write(Buffer.concat([h, data]));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); }
      }, 120000);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result?.value;
  }

  close() { try { this.s?.end(); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------------------
// The in-page helper
// ---------------------------------------------------------------------------

/**
 * Installed as `window.variety` before the tour starts.
 *
 * THE PIN IS THE WHOLE POINT OF THIS HELPER, and it is not the same thing
 * qa.mjs's `hold` does. A capture costs a CDP round trip, and a submerged diver
 * is positively buoyant above the neutral depth - so an unpinned eye drifts for
 * as long as the harness is talking to the browser, and the two visits of the
 * control repeat would differ by however long each round trip happened to take.
 * `startPin` therefore runs a self-sustaining rAF loop that re-writes the pose
 * every frame and keeps running ACROSS evaluations, until `stopPin`.
 *
 * Writing the pose means writing the yaw/pitch scalars, the orientation
 * quaternion AND both interpolation history slots: `Camera.setEuler` is
 * overwritten by `Player.applyCamera` on the next frame, and the player only
 * rebuilds its quaternion inside `simulate()`, which a paused game never calls.
 * The same code is in qa.mjs and shot.mjs, and it belongs in all three because
 * the three tools must frame identically.
 *
 * THE LIFE-SUPPORT PIN IS ALSO A BLINDFOLD, exactly as qa.mjs records: while it
 * is on, no capture here can ever show drowning, pressure damage or the oxygen
 * warning vignette. That is deliberate - all three are the simulation eroding
 * the scenario's own premise, and the oxygen vignette in particular would paint
 * authored UI colour over a frame whose colour is the measurement.
 */
const INSTALL_HELPER = `(async () => {
  const { quat, vec3 } = await import('/src/core/math.js');
  const { PLAYER } = await import('/src/core/constants.js');
  window.variety = {
    _pin: null,
    place(x, y, z, yaw, pitch) {
      const p = window.subwave.player;
      p.inVessel = false;
      p.position.set([x, y, z]);
      p.velocity.set([0, 0, 0]);
      vec3.copy(p.prevPosition, p.position);
      p.yaw = yaw;
      p.pitch = pitch;
      quat.fromEuler(p.orientation, yaw, pitch, 0);
      quat.copy(p.prevOrientation, p.orientation);
    },
    startPin() {
      const p = window.subwave.player;
      const pose = { x: p.position[0], y: p.position[1], z: p.position[2],
        yaw: p.yaw, pitch: p.pitch };
      this._pin = pose;
      const step = () => {
        if (this._pin !== pose) return;
        this.place(pose.x, pose.y, pose.z, pose.yaw, pose.pitch);
        p.oxygen = p.oxygenCapacity;
        p._oxygenWarnTier = 0;
        p.health = PLAYER.MAX_HEALTH;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      return pose;
    },
    stopPin() { this._pin = null; },
    /** Wait n animation frames, so callers can count RENDERED frames. */
    async frames(n) {
      for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
    },
    /**
     * Hide the DOM overlays that sit over the canvas under CDP.
     *
     * NOTE this whole helper is a JS TEMPLATE LITERAL in the harness, so nothing
     * in it may contain a backtick or a dollar-brace.
     *
     * THE ID 'controls' IS THE CONTROL LEGEND AND IT WAS INSIDE THE MEASUREMENT.
     * It is a DOM overlay like the other four, it was not in this list, and it
     * renders over the right of the canvas vertically centred - i.e. squarely
     * inside DEFAULT_CROP's rows 8%-82%, the pixels every hue histogram,
     * entropy, flat-fraction and percentile figure in this report is computed
     * from. So AUTHORED UI COLOUR (its teal rule, its pale key text, its dark
     * panel) was a term in the reef anchor's colour statistics in s1-done, s2
     * and s2-closed alike, and in every tour before them.
     *
     * It is showing at capture because ControlsHint reveals itself on a CONTEXT
     * CHANGE and hides 34 s later: jumpTo moves the player between FOOT and
     * SWIM, which re-reveals it, and the settle is 14 s - inside that window
     * every time. Pausing does not remove it either; update(dt, paused) drops
     * the show class into a 450 ms CSS opacity transition, and the capture is
     * two frames after the pause, so the frame catches it mid-fade at roughly
     * its 0.34 faded alpha. That is exactly how it reads in
     * the s2-closed tour's reef frame.
     *
     * BOTH HALVES ARE NEEDED. An inline display none beats the class rules, but
     * ControlsHint._render keeps rebuilding and re-showing the element on every
     * context change, so the toggle is flipped as well - enabled = false is the
     * documented user toggle (H) and the mechanism that class owns for "never
     * show". Equally the toggle alone is not enough: it only takes effect
     * through update(), and it hides through that same 450 ms transition, so a
     * capture landing inside one would still carry the legend at partial alpha.
     */
    hideOverlays() {
      for (const id of ['boot', 'lock-hint', 'jump-menu', 'jump-toast', 'controls']) {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      }
      const hint = window.subwave?.controlsHint;
      if (hint) hint.enabled = false;
    },
    /** Everything the report records about a frame that is not in its pixels. */
    async state() {
      const C = await import('/src/core/constants.js');
      const g = window.subwave;
      const r = g.renderer;
      const near = await r.debugReadDepth(${NEAR_METRES});
      // THE DEPTH LADDER. debugReadDepth's nearMass IS the depth CDF at its
      // horizon, so walking the horizon walks the distribution - a whole depth
      // histogram out of an API that already ships, with no renderer change.
      // The camera has not moved (the pin holds it and the sim is paused), so
      // the only thing varying between these reads is what still animates with
      // the sim paused: the ocean surface, TAA jitter. Anything larger than that
      // shows up as a non-monotone CDF, which is why monotonicity is checked
      // rather than assumed.
      if (near && !near.error) {
        const t0 = performance.now();
        const ladder = [];
        for (const h of ${JSON.stringify(DEPTH_LADDER)}) {
          const d = await r.debugReadDepth(h);
          ladder.push({ metres: h, cdf: d && !d.error ? d.nearMass : null });
        }
        near.ladderMs = performance.now() - t0;
        near.ladder = ladder;
        near.lensMass = ladder[0].cdf;
        const geo = 1 - near.infFraction;
        const cdfs = ladder.map((e) => e.cdf);
        near.ladderMonotone = cdfs.every((v, i) => v != null && (i === 0 || v >= cdfs[i - 1] - 1e-6));
        if (geo > 0 && near.ladderMonotone) {
          // Normalised over GEOMETRY, not over all samples: sky is legitimately
          // most of an above-water frame and would otherwise be the "shape".
          const bands = [];
          let lo = 0;
          let prevCdf = 0;
          for (const e of ladder) {
            bands.push({ from: lo, to: e.metres, share: Math.max(0, e.cdf - prevCdf) / geo });
            lo = e.metres;
            prevCdf = e.cdf;
          }
          bands.push({ from: lo, to: null, share: Math.max(0, geo - prevCdf) / geo });
          near.bands = bands;
          near.bandPeak = Math.max(...bands.map((b) => b.share));
          let h = 0;
          for (const b of bands) if (b.share > 0) h -= b.share * Math.log2(b.share);
          near.bandEntropyBits = h;
        }
      }
      return {
        // camera.depth, NOT env.cameraDepth: there is no such field on env, and
        // reading it returns undefined - which sorts every anchor out of the
        // "underwater" subset and makes G2/G3/G5 pass VACUOUSLY over an empty
        // set. That is the exact failure mode this project keeps writing down.
        depth: r.camera.depth,
        underwater: !!r.camera.isUnderwater,
        exposure: r.exposure,
        eye: [r.camera.position[0], r.camera.position[1], r.camera.position[2]],
        yaw: g.player.yaw, pitch: g.player.pitch,
        lampOn: !!g.player.lampOn,
        hudVisible: !!g.hud.visible,
        // MEASURED OFF THE DOM, not asserted by hideOverlays, for exactly the
        // reason hudVisible is measured: the control legend sat inside the
        // cropped pixels of every tour this project has run because nothing ever
        // checked whether it was there. visibility and opacity are what the
        // show/faded classes drive, display is what hideOverlays sets, and a
        // frame is only clean if all three agree.
        legendVisible: (() => {
          const el = document.getElementById('controls');
          if (!el) return false;
          const s = getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden'
            && parseFloat(s.opacity) > 0.001;
        })(),
        dayFraction: g.worldClock.dayFraction,
        waterType: Object.keys(C.WATER_TYPES).find(
          (k) => C.WATER_TYPES[k].id === r.env.waterType?.id) ?? null,
        // Streaming convergence, which is half of what the settle is waiting
        // for: loaded stops climbing and queued + inFlight + pendingUploads
        // returns to 0 when the ring around this arrival is fully resident.
        chunks: {
          loaded: g.chunks?.stats?.loaded ?? null,
          pending: (g.chunks?.stats?.queued ?? 0) + (g.chunks?.stats?.inFlight ?? 0)
            + (g.chunks?.stats?.pendingUploads ?? 0),
        },
        scatterInstances: g.scatterPass?.stats?.visibleInstances ?? null,
        near,
      };
    },
  };
})()`;

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * Decode a captured PNG and reduce it with the shared kernel.
 *
 * @param {Buffer} png the raw file bytes
 * @returns {object} the frameMetrics record, with `hist` as a plain array
 */
function analyse(png) {
  const img = decodePNG(png);
  const m = frameMetrics(img);
  return {
    width: m.width, height: m.height, pixels: m.pixels,
    hist: Array.from(m.hist),
    gatedFraction: m.gatedFraction,
    hueEntropyBits: m.hueEntropyBits,
    hueEntropySatBits: m.hueEntropySatBits,
    medianL: m.medianL, p05L: m.p05L, p95L: m.p95L,
    dynamicRange: m.dynamicRange, meanL: m.meanL,
    darkMass: m.darkMass, flatFraction: m.flatFraction,
  };
}

/**
 * The kernel's own self-test, run on a real captured frame.
 *
 * Splitting one frame into its two checkerboard halves must return >= 0.9999.
 * It is what establishes that every difference reported later is world variance
 * and not instrument noise, and running it HERE rather than only in the kernel's
 * own suite also proves the decode path this tool uses is the same one.
 *
 * @param {Buffer} png the raw file bytes
 * @returns {number} self-cosine of the two parities
 */
function paritySelfCosine(png) {
  const img = decodePNG(png);
  const a = frameMetrics(img, { parity: 0 });
  const b = frameMetrics(img, { parity: 1 });
  return cosineSimilarity(a.hist, b.hist);
}

const fmt = (v, n = 4) => (Number.isFinite(v) ? v.toFixed(n) : String(v));

// ---------------------------------------------------------------------------
// G5, the composition gate
// ---------------------------------------------------------------------------

/**
 * G5's three clauses over one `debugReadDepth` record.
 *
 * ONE SCALAR CANNOT DECIDE WHETHER A FRAME IS COMPOSED. The three clauses are
 * INDEPENDENT questions about the same depth buffer - is anything jammed against
 * the lens, how much of the frame is near field, and how far away is the typical
 * thing being looked at - and a frame has to answer all three. Two of the four
 * calibration frames are rejected by two clauses each and one is rejected by
 * exactly one, which is the point: near-mass alone got that last one wrong.
 *
 * A record with no geometry at all (`min === null`, an all-sky frame) fails,
 * because "nothing was in front of the camera" is not a met criterion - the same
 * refusal `subsetGate` makes for an empty subset.
 *
 * WHAT THIS STILL CANNOT MEASURE, stated so nobody assumes otherwise: the SCREEN
 * COVERAGE OF THE LARGEST SINGLE OBJECT. Three near urn sponges and one near urn
 * sponge three times the size produce the same near-mass, the same min and the
 * same median, and only the second is a wall. Getting it needs a connected-
 * component pass over the depth grid, splitting on depth discontinuity - which is
 * cheap in principle (`debugReadDepth` already sub-samples to about 267 x 300,
 * so union-find over 80k cells is milliseconds) but is NOT cheap to add here: the
 * grid itself never leaves `render/renderer.js`, so it means new machinery in the
 * renderer, and none of it could be CALIBRATED, because a depth buffer cannot be
 * recovered from a PNG and two of the four frames below were taken on trees that
 * no longer exist. An uncalibrated fourth clause is how gates acquire thresholds
 * nobody can defend. IT BELONGS TO STAGE 5's ARRIVAL COMPOSER and not here: the
 * composer is CHOOSING the pose, so it wants per-object coverage as an input to
 * a search over candidate eyes, which is a different and more useful thing than
 * a post-hoc reject. Until then `near.bandPeak` and `near.lensMass` are the
 * proxies, and both are printed.
 *
 * @param {object|null} near a `renderer.debugReadDepth` result, or null
 * @returns {{pass: boolean, clauses: Array<{id: string, what: string,
 *   value: number, pass: boolean}>}} the verdict and the per-clause detail
 */
function g5Verdict(near) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  const min = num(near?.min);
  const nearMass = num(near?.nearMass);
  const median = num(near?.median);
  const clauses = [
    { id: 'G5a', what: `lens clearance: nearest geometry >= ${LENS_FLOOR_METRES} m`,
      value: min, pass: min >= LENS_FLOOR_METRES },
    { id: 'G5b', what: `near-mass within [${NEAR_MASS_MIN}, ${NEAR_MASS_MAX}] at ${NEAR_METRES} m`,
      value: nearMass, pass: nearMass >= NEAR_MASS_MIN && nearMass <= NEAR_MASS_MAX },
    { id: 'G5c', what: `standoff: median ray >= ${STANDOFF_METRES} m`,
      value: median, pass: median >= STANDOFF_METRES },
  ];
  return { pass: clauses.every((c) => c.pass), clauses };
}

/**
 * `--check-g5`: run the shipped gate over the calibration frames, offline.
 *
 * No browser, no server, no tour - it is arithmetic over recorded numbers, so it
 * costs a second and can be run on every edit to the thresholds above. It fails
 * loudly if a verdict disagrees with the `expect` column, and separately if an
 * embedded record no longer matches the report file it was copied from.
 *
 * @param {string|null} sweep optional report to additionally list verdicts for
 * @returns {Promise<number>} process exit code
 */
async function checkG5(sweep) {
  const { readFile } = await import('node:fs/promises');
  console.log('\nG5 CALIBRATION - the shipped gate, run over the four frames it was built from.');
  console.log(`  clauses: G5a min >= ${LENS_FLOOR_METRES} m   ` +
    `G5b nearMass in [${NEAR_MASS_MIN}, ${NEAR_MASS_MAX}]   ` +
    `G5c median >= ${STANDOFF_METRES} m\n`);
  let bad = 0;
  for (const c of G5_CALIBRATION) {
    // The literals are only worth anything if they still describe the file. A
    // report that is absent is not an error - i13-after.json and s1-final.json
    // are untracked working reports - but a report that DISAGREES is.
    let provenance = 'file absent (untracked report); embedded literals used';
    const path = join(ROOT, c.report);
    if (existsSync(path)) {
      const rep = JSON.parse(await readFile(path, 'utf8'));
      const dest = rep.destinations?.find((d) => d.short === c.short);
      const rec = dest?.state?.near;
      const drift = !rec ? ['record missing'] : Object.keys(c.near)
        .filter((k) => !(Math.abs(rec[k] - c.near[k]) < 1e-9));
      if (rep.generated !== c.generated) drift.push(`generated ${rep.generated}`);
      if (drift.length) { provenance = `DRIFTED from file: ${drift.join(', ')}`; bad++; }
      else provenance = 'confirmed against the file';
    }
    const v = g5Verdict(c.near);
    const agree = v.pass === c.expect;
    if (!agree) bad++;
    console.log(`  ${agree ? 'OK  ' : 'WRONG'} ${c.label.padEnd(26)} ` +
      `gate says ${(v.pass ? 'PASS' : 'FAIL').padEnd(4)}, must ${c.expect ? 'PASS' : 'FAIL'}`);
    console.log(`        ${c.frame}`);
    console.log(`        ${c.looksLike}`);
    for (const cl of v.clauses) {
      console.log(`        ${cl.pass ? 'pass' : 'FAIL'}  ${cl.id}  ${fmt(cl.value, 4).padStart(10)}   ${cl.what}`);
    }
    console.log(`        provenance: ${provenance}\n`);
  }
  if (sweep) {
    const path = join(ROOT, sweep);
    if (!existsSync(path)) { console.error(`  sweep: no such report ${sweep}`); return 1; }
    const rep = JSON.parse(await readFile(path, 'utf8'));
    console.log(`SWEEP of ${sweep} - the gate's verdict on every underwater anchor of a real tour,`);
    console.log('  so the blast radius of a threshold change is visible rather than argued.\n');
    console.log('  anchor        verdict  G5a min   G5b nearMass  G5c median   failing');
    for (const d of rep.destinations ?? []) {
      if (!(d.state?.depth > 0.5)) continue;
      const v = g5Verdict(d.state.near);
      const failing = v.clauses.filter((cl) => !cl.pass).map((cl) => cl.id);
      console.log(`  ${d.short.padEnd(12)} ${(v.pass ? 'PASS' : 'FAIL').padEnd(7)} ` +
        `${fmt(v.clauses[0].value, 3).padStart(8)}  ${fmt(v.clauses[1].value, 4).padStart(12)}  ` +
        `${fmt(v.clauses[2].value, 2).padStart(10)}   ${failing.join(' ') || '-'}`);
    }
    console.log('');
  }
  console.log(bad === 0 ? 'G5 CALIBRATION HOLDS\n' : `${bad} DISAGREEMENT(S) - the gate does not match its own calibration\n`);
  return bad === 0 ? 0 : 1;
}

if (CHECK_G5) process.exit(await checkG5(CHECK_G5_SWEEP));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

await mkdir(OUT, { recursive: true });

// THE GUARD RUNS BEFORE ANYTHING IS SPAWNED OR CREATED, so a refusal costs a
// second rather than a whole tour. It covers the report AND its frame
// directory, because the two are one indivisible set: replacing only the JSON
// leaves PNGs from a different build sitting under a name that now claims to
// describe this one. `baseline.json` is the local before for every stage
// comparison taken on this machine and is protected by exactly this test.
if (!PROBE_SETTLE) {
  const clash = [];
  if (existsSync(join(OUT, OUT_NAME))) clash.push(relative(ROOT, join(OUT, OUT_NAME)));
  if (existsSync(SHOT_DIR)) clash.push(relative(ROOT, SHOT_DIR) + '/');
  if (clash.length && !FORCE) {
    console.error(`refusing to overwrite an existing run: ${clash.join('  ')}`);
    console.error('  A plain run writes variety-output/run-<UTC stamp>.json and never collides.');
    console.error(`  To replace this one on purpose: --out ${OUT_NAME} --force`);
    process.exit(1);
  }
  if (clash.length) {
    console.log(`--force: replacing ${clash.join('  ')}`);
    // Removed rather than merged: a shorter --only run dropped into an existing
    // directory would leave the previous tour's frames in place under a report
    // that does not mention them, which is the same "the JSON and the PNGs stop
    // describing one run" failure the naming scheme exists to prevent.
    await rm(SHOT_DIR, { recursive: true, force: true });
  }
  // Only the tour writes frames; --probe-settle would otherwise leave an empty
  // directory named after a report it never produces.
  await mkdir(SHOT_DIR, { recursive: true });
  await mkdir(join(SHOT_DIR, 'repeat'), { recursive: true });
}

// The Chrome profile goes to the OS temp directory, NOT into variety-output:
// that directory holds the committed baselines and the PNGs a human reads, and a
// browser profile is tens of megabytes of noise inside it. launchBrowser also
// runs the startup reaper, because nothing in-process survives the SIGKILL an
// agent harness sends a hung tool - which is how two headless trees came to be
// found still running after 1h38m holding 2.96 GB.
const { chrome, port: PORT, cdpPort: CDP_PORT, cleanup, fail } = await launchBrowser({
  tag: 'variety', root: ROOT, windowSize: '1600,900',
});
await sleep(1500);

const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
const sock = new Sock(page.webSocketDebuggerUrl);
await sock.connect();
await sock.send('Runtime.enable');

const consoleErrors = [];
sock.onEvent = (m) => {
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  }
};

const deadline = Date.now() + 120000;
let ready = false;
while (Date.now() < deadline) {
  await sleep(1000);
  const s = await sock.eval(`(() => {
    const f = document.getElementById('fatal');
    if (f && f.classList.contains('show')) return { fatal: document.getElementById('fatal-detail')?.textContent };
    return { ready: !!(window.subwave && window.subwave.running) };
  })()`).catch(() => ({}));
  if (s?.fatal) fail('BOOT FAILED:\n' + s.fatal);
  if (s?.ready) { ready = true; break; }
}
if (!ready) fail('boot timed out');

// The splash never comes down on its own: start() runs the loop, but only a real
// click hides the overlay, and every capture would otherwise be a picture of it.
await sock.eval(`(() => {
  document.getElementById('boot')?.classList.add('hidden');
  window.subwave.start();
})()`).catch(() => {});
await sleep(2000);
await sock.eval(INSTALL_HELPER);

const seed = await sock.eval('window.subwave.seed');
const destinations = await sock.eval(`(() => window.subwave.biomeAnchors().map((a) => ({
  id: a.id, name: a.name, short: a.short, dominant: !!a.dominant,
  weight: a.weight, height: a.height,
})))()`);

let tour = destinations;
if (ONLY) {
  const want = ONLY.split(',').map((s) => s.trim().toLowerCase());
  tour = destinations.filter((d) => want.includes(d.short.toLowerCase()));
  const missing = want.filter((w) => !tour.some((d) => d.short.toLowerCase() === w));
  if (missing.length) fail(`--only names no destination: ${missing.join(', ')}`);
}

// ---------------------------------------------------------------------------
// One visit
// ---------------------------------------------------------------------------

/**
 * Jump to a destination, hold the pose, capture, and reduce the frame.
 *
 * The order here is load-bearing. The day fraction and the HUD are set BEFORE
 * the jump so the arrival frame is already under the fixed conditions; the lamp
 * is set AFTER it, because the policy is a function of the arrival depth; and
 * the pin starts immediately after the jump so the composed arrival pose is what
 * gets photographed rather than wherever buoyancy carried the diver during the
 * settle.
 *
 * @param {{short: string, name: string}} dest the destination
 * @param {number[]} probes ascending hold times, in seconds, to capture at
 * @param {boolean} freeze pause the sim before the final capture
 * @returns {Promise<{captures: object[]}>} one record per probe time
 */
async function visit(dest, probes, freeze) {
  const jump = await sock.eval(`(async () => {
    const g = window.subwave;
    g.setPaused(false);
    g.hud.visible = false;
    g.worldClock.setDayFraction(${DAY_FRACTION});
    const r = g.jumpTo(${JSON.stringify(dest.short)});
    if (r && r.error) return { error: r.error };
    const p = g.player;
    // Depth of the FEET, which is what the anchor's own arrival y is expressed
    // in; the eye sits EYE_HEIGHT above it and no policy this coarse cares.
    p.lampOn = Math.max(0, -p.position[1]) > ${LAMP_DEPTH};
    window.variety.hideOverlays();
    window.variety.startPin();
    return { ok: true, y: p.position[1], lampOn: p.lampOn, warn: r.warn || '' };
  })()`);
  if (jump?.error) fail(`${dest.short}: jumpTo refused: ${jump.error}`);
  // validateTarget's warn is the boundary push-back: an arrival inside it is
  // being shoved by the collision solver while the settle runs, which the pin
  // hides and the frame does not.
  if (jump?.warn) console.log(`    ${dest.short}: jump warning: ${jump.warn}`);

  const captures = [];
  let held = 0;
  for (let i = 0; i < probes.length; i++) {
    const wait = probes[i] - held;
    if (wait > 0) await sleep(wait * 1000);
    held = probes[i];
    const last = i === probes.length - 1;
    if (last && freeze) {
      // Four frames is one fixed sim step at any frame rate the harness sees, so
      // the derived state the HUD-less frame is shaded from belongs to THIS
      // arrival and not the previous one. Then stop: with the sim paused there
      // is no buoyancy to pin against, and terrain, scatter and the renderer all
      // keep running regardless.
      await sock.eval('(async () => { await window.variety.frames(4); window.subwave.setPaused(true); window.variety.stopPin(); })()');
      await sock.eval('window.variety.frames(2)');
    }
    const state = await sock.eval('window.variety.state()');
    const png = await sock.send('Page.captureScreenshot', { format: 'png' });
    const bytes = Buffer.from(png.data, 'base64');
    captures.push({ heldSeconds: held, bytes, state });
  }
  if (!freeze) await sock.eval('window.variety.stopPin()');
  return { captures };
}

// ---------------------------------------------------------------------------
// --probe-settle: measure how long convergence actually takes
// ---------------------------------------------------------------------------

if (PROBE_SETTLE) {
  const anchors = tour.filter((d) => PROBE_ANCHORS.includes(d.short));
  // An empty probe set would write an empty report and exit 0, which is the
  // vacuous-pass failure this file refuses everywhere else.
  if (anchors.length === 0) {
    fail(`--probe-settle has nothing to probe: --only left none of ${PROBE_ANCHORS.join(', ')}`);
  }
  console.log(`\nSETTLE PROBE  seed ${seed}  day ${DAY_FRACTION}  ` +
    `holds ${PROBE_TIMES.join('/')} s\n`);
  const out = { seed, dayFraction: DAY_FRACTION, probeTimes: PROBE_TIMES, anchors: [] };
  for (const dest of anchors) {
    const { captures } = await visit(dest, PROBE_TIMES, false);
    const metrics = captures.map((c) => analyse(c.bytes));
    const final = metrics[metrics.length - 1];
    console.log(`  ${dest.name}  (depth ${fmt(captures[0].state.depth, 1)} m)`);
    console.log('    hold   cos-to-final   medianL   exposure   chunks  pending   nearMass');
    const rows = [];
    for (let i = 0; i < metrics.length; i++) {
      const cos = cosineSimilarity(metrics[i].hist, final.hist);
      const st = captures[i].state;
      const nm = st.near && st.near.nearMass != null ? fmt(st.near.nearMass, 4) : 'n/a';
      console.log(`    ${String(captures[i].heldSeconds).padStart(4)} s   ${fmt(cos, 6)}     ` +
        `${fmt(metrics[i].medianL)}    ${fmt(st.exposure, 4)}   ` +
        `${String(st.chunks?.loaded ?? '?').padStart(6)}  ${String(st.chunks?.pending ?? '?').padStart(6)}   ${nm}`);
      rows.push({ heldSeconds: captures[i].heldSeconds, cosToFinal: cos,
        medianL: metrics[i].medianL, exposure: st.exposure, chunks: st.chunks,
        scatterInstances: st.scatterInstances, nearMass: st.near?.nearMass ?? null,
        hueEntropyBits: metrics[i].hueEntropyBits, darkMass: metrics[i].darkMass });
    }
    out.anchors.push({ short: dest.short, name: dest.name, rows });
    console.log('');
  }
  // Stamped for the same reason the tour's report is: the committed
  // `settle-probe.json` is the measurement SETTLE_SECONDS was chosen from, and a
  // second probe used to silently replace it.
  const probeFile = join(OUT, args.includes('--out') ? OUT_NAME : `settle-probe-${RUN_STAMP}.json`);
  if (existsSync(probeFile) && !FORCE) {
    console.error(`refusing to overwrite ${relative(ROOT, probeFile)}; pass --force to replace it`);
    sock.close(); cleanup(); process.exit(1);
  }
  await writeFile(probeFile, JSON.stringify(out, null, 2));
  console.log(`  -> ${probeFile}`);
  if (consoleErrors.length) console.log('\n  console errors:\n    ' + consoleErrors.join('\n    '));
  sock.close();
  cleanup();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// The tour, twice
// ---------------------------------------------------------------------------

console.log(`\nBIOME VARIETY TOUR  seed ${seed}  day ${DAY_FRACTION}  settle ${SETTLE} s  ` +
  `lamp below ${LAMP_DEPTH} m`);
console.log(`  ${tour.length} destinations, toured TWICE in one process. The second tour is the ` +
  'CONTROL:');
console.log(`  same-anchor self-cosine must be >= ${CONTROL_MIN} at every destination or the run ` +
  'is VOID.\n');

const passes = [[], []];
const streamingWarnings = [];
let parityCosine = null;

for (let pass = 0; pass < 2; pass++) {
  console.log(`  --- tour ${pass + 1} of 2 ---`);
  for (const dest of tour) {
    const { captures } = await visit(dest, [SETTLE], true);
    const cap = captures[0];
    const file = join(pass === 0 ? SHOT_DIR : join(SHOT_DIR, 'repeat'), `${dest.short}.png`);
    await writeFile(file, cap.bytes);
    if (parityCosine === null) parityCosine = paritySelfCosine(cap.bytes);
    const m = analyse(cap.bytes);
    // Repo-relative, because the report is committed and an absolute path off
    // one machine is noise in a diff.
    passes[pass].push({ ...dest, state: cap.state, metrics: m, file: relative(ROOT, file) });
    // Streaming that has NOT converged is a frame with holes in it, and it looks
    // exactly like a frame with nothing in it. Say so at the capture rather than
    // letting it turn up as a mysterious control failure.
    const pending = cap.state.chunks?.pending ?? 0;
    if (pending > 0) streamingWarnings.push(`${dest.short} (tour ${pass + 1}): ${pending} chunks still pending at capture`);
    console.log(`    ${dest.short.padEnd(12)} depth ${fmt(cap.state.depth, 1).padStart(7)} m  ` +
      `medianL ${fmt(m.medianL)}  entropy ${fmt(m.hueEntropyBits, 2)}  ` +
      `dark ${fmt(m.darkMass)}  near ${cap.state.near?.nearMass != null ? fmt(cap.state.near.nearMass) : 'n/a'}` +
      `${pending > 0 ? `  <-- ${pending} CHUNKS PENDING` : ''}`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// The control
// ---------------------------------------------------------------------------

// WHAT GETS DIFFERENCED HERE IS WHAT MAY LATER BE QUOTED AS A RESULT. The
// original four columns bounded the self-cosine, hue entropy, dark mass and
// median luminance and nothing else, while G4 gates on p95/p05 and G6 on flat
// fraction - so every dynamic-range and flatness figure argued across a stage
// was an uncontrolled single reading, which is the lottery read CLAUDE.md names.
// A delta here is not error in the metric; it is the world's own variance
// between two visits to the same pose under identical fixed conditions, and it
// is the floor below which a before/after difference means nothing.
const control = [];
for (let i = 0; i < tour.length; i++) {
  const a = passes[0][i];
  const b = passes[1][i];
  const na = a.state.near || {};
  const nb = b.state.near || {};
  control.push({
    short: a.short, name: a.name,
    selfCosine: cosineSimilarity(a.metrics.hist, b.metrics.hist),
    dHueEntropy: b.metrics.hueEntropyBits - a.metrics.hueEntropyBits,
    dDarkMass: b.metrics.darkMass - a.metrics.darkMass,
    dMedianL: b.metrics.medianL - a.metrics.medianL,
    dDynamicRange: b.metrics.dynamicRange - a.metrics.dynamicRange,
    dFlatFraction: b.metrics.flatFraction - a.metrics.flatFraction,
    // G5's three clause values, the only gated quantities that come off the
    // depth buffer rather than the pixels. Printed in their own table below.
    dNearMin: nb.min - na.min,
    dNearMass: nb.nearMass - na.nearMass,
    dNearMedian: nb.median - na.median,
    // lensMass rides along because the LENS_FLOOR_METRES docstring argues from
    // exactly this comparison - "canyon 0.0790 / 0.0791, kelp 0.0867 / 0.0823,
    // break 0.0000 / 0.0000" - and had to be hand-built from a bespoke
    // three-anchor run to get it. It is the candidate to MOVE G5a onto once
    // enough tours carry a ladder, so its repeatability is the evidence that
    // decision waits on.
    dLensMass: nb.lensMass - na.lensMass,
    // A DELIVERED CONDITION, not a metric, and it is quoted as an acceptance
    // criterion: Stage 2's exposure-rail clause is "the gain is still exactly
    // 25.6 at the pinned stations", i.e. a claim that a number did NOT move,
    // made off one reading per station. Differenced with the rest.
    dExposure: b.state.exposure - a.state.exposure,
  });
}
const worstControl = control.reduce((w, c) => (c.selfCosine < w.selfCosine ? c : w), control[0]);
const VOID = worstControl.selfCosine < CONTROL_MIN;

/**
 * The control SPREAD of one delta column: the largest absolute tour-to-tour
 * movement, and where it happened.
 *
 * The max and not the mean, because the question a reader has is "could this
 * anchor's before/after have come from nothing", and it is asked one anchor at
 * a time. Non-finite entries are counted and excluded rather than propagated:
 * `dynamicRange` is `Infinity` whenever p05 is exactly 0, and Infinity minus
 * Infinity is NaN, which would otherwise silently poison the whole column.
 *
 * @param {string} key the field on a control record
 * @param {Array<object>} [rows] the control records to reduce
 * @returns {{max: number, at: string|null, n: number, skipped: number}}
 */
function controlSpread(key, rows = control) {
  let max = 0;
  let at = null;
  let n = 0;
  let skipped = 0;
  for (const c of rows) {
    const v = c[key];
    if (!Number.isFinite(v)) { skipped++; continue; }
    n++;
    if (Math.abs(v) > Math.abs(max)) { max = v; at = c.short; }
  }
  return { max, at, n, skipped };
}

console.log('CONTROL (tour 1 vs tour 2, same anchor)');
console.log(`  instrument self-test, checkerboard parity on one real frame: ${fmt(parityCosine, 6)}` +
  '  (>= 0.9999 means all variance below is the WORLD)');
console.log('  Every column is a quantity some gate reads. A before/after smaller than the spread');
console.log('  line below is indistinguishable from re-running the same build.');
console.log('  anchor        self-cos   d hueEntropy   d darkMass   d medianL   d p95/p05   d flatFrac');
for (const c of control) {
  const mark = c.selfCosine < CONTROL_MIN ? '  <-- BELOW GATE' : '';
  console.log(`  ${c.short.padEnd(12)} ${fmt(c.selfCosine, 6)}   ${fmt(c.dHueEntropy, 4).padStart(9)}` +
    `     ${fmt(c.dDarkMass, 4).padStart(8)}    ${fmt(c.dMedianL, 4).padStart(8)}   ` +
    `${fmt(c.dDynamicRange, 3).padStart(9)}   ${fmt(c.dFlatFraction, 4).padStart(9)}${mark}`);
}
const spreads = {
  hueEntropy: controlSpread('dHueEntropy'), darkMass: controlSpread('dDarkMass'),
  medianL: controlSpread('dMedianL'), dynamicRange: controlSpread('dDynamicRange'),
  flatFraction: controlSpread('dFlatFraction'),
};
const spreadCell = (label, s, digits) => `${label} ${fmt(s.max, digits)} (${s.at ?? 'n/a'}` +
  `${s.skipped ? `, ${s.skipped} non-finite` : ''})`;
console.log('  SPREAD, largest |delta| over the anchors and where:');
console.log(`    ${spreadCell('hueEntropy', spreads.hueEntropy, 4)}   ` +
  `${spreadCell('darkMass', spreads.darkMass, 4)}   ${spreadCell('medianL', spreads.medianL, 4)}`);
console.log(`    ${spreadCell('p95/p05', spreads.dynamicRange, 3)}   ` +
  `${spreadCell('flatFrac', spreads.flatFraction, 4)}`);
console.log(`  worst: ${worstControl.short} at ${fmt(worstControl.selfCosine, 6)} against a gate of ` +
  `${CONTROL_MIN}\n`);

// ---------------------------------------------------------------------------
// The fixed conditions, AS DELIVERED
// ---------------------------------------------------------------------------

// Asserting a condition in a setup string is not the same as the game having
// honoured it. Every one of these is read back off the running game at the
// moment of capture, because "HUD off" and "lamp on below 150 m" are claims
// until something checks them.
const allStates = [...passes[0], ...passes[1]].map((r) => r.state);
const dayMin = Math.min(...allStates.map((s) => s.dayFraction));
const dayMax = Math.max(...allStates.map((s) => s.dayFraction));
const hudOn = allStates.filter((s) => s.hudVisible).length;
const legendOn = allStates.filter((s) => s.legendVisible).length;
const lampWrong = [...passes[0], ...passes[1]].filter(
  (r) => r.state.lampOn !== (r.state.depth > LAMP_DEPTH));
console.log('FIXED CONDITIONS, AS DELIVERED (read back off the running game at each capture)');
console.log(`  day fraction  ${fmt(dayMin, 5)} .. ${fmt(dayMax, 5)}  (set to ${DAY_FRACTION} on ` +
  `arrival; the spread is the settle running on the clock, identical at every anchor)`);
console.log(`  HUD visible at ${hudOn} of ${allStates.length} captures (must be 0)`);
console.log(`  control legend visible at ${legendOn} of ${allStates.length} captures (must be 0; ` +
  'it is DOM chrome inside the cropped rows and was in every tour before 2026-08-06)');
console.log(`  lamp policy disagreements: ${lampWrong.length} ` +
  `${lampWrong.length ? `(${lampWrong.map((r) => r.short).join(', ')})` : ''}`);
const exposureSpread = controlSpread('dExposure');
console.log(`  delivered exposure gain, control spread ${fmt(exposureSpread.max, 4)} at ` +
  `${exposureSpread.at ?? 'n/a'} (an acceptance criterion is written on this number NOT moving)`);
console.log(`  chunk-streaming warnings: ${streamingWarnings.length}`);
for (const w of streamingWarnings) console.log(`    ${w}`);
console.log('');

// ---------------------------------------------------------------------------
// Per-anchor statistics
// ---------------------------------------------------------------------------

console.log('PER ANCHOR (tour 1 is the headline; every cosine below is printed next to these,');
console.log('  because cosine measures difference BETWEEN frames and is maximised by "every');
console.log('  frame is one different colour" - two degenerate flat frames score 0.13 against');
console.log('  each other. Hue entropy and dark mass are the WITHIN-frame floors.)');
console.log('  NOTE the two pixel sets: every colour figure is over the cropped rows ' +
  `${DEFAULT_CROP.top}-${DEFAULT_CROP.bottom} of frame height,`);
console.log('  nearMass is over the WHOLE frame - so nearMass counts the near-field seabed in the');
console.log('  discarded bottom band that the colour columns never see.\n');
console.log('  anchor         depth   water            entropy  darkMass  nearMass  flatFrac  p95/p05  medianL');
for (const r of passes[0]) {
  const near = r.state.near?.nearMass;
  console.log(`  ${r.short.padEnd(12)} ${fmt(r.state.depth, 1).padStart(7)}  ` +
    `${String(r.state.waterType ?? '-').padEnd(16)} ${fmt(r.metrics.hueEntropyBits, 2).padStart(6)}   ` +
    `${fmt(r.metrics.darkMass).padStart(7)}   ${(near != null ? fmt(near) : 'n/a').padStart(7)}   ` +
    `${fmt(r.metrics.flatFraction).padStart(7)}  ${fmt(r.metrics.dynamicRange, 2).padStart(6)}   ` +
    `${fmt(r.metrics.medianL)}`);
}

// ---------------------------------------------------------------------------
// Depth composition
// ---------------------------------------------------------------------------

// WHAT THE COLOUR TABLE ABOVE CANNOT SEE. Every column up there is a colour
// statistic and a frame that is one object against the lens has colour
// statistics like any other. These are the depth buffer: how near the nearest
// thing is, how much of the frame that thing is, how far the typical ray gets,
// and where the rest of the geometry sits. bandPeak is the share of the single
// busiest depth band - a flat slab pushes it toward 1.0 - and bandBits is the
// same distribution's entropy over 7 bands, so its ceiling is log2(7) = 2.81.
console.log('\nDEPTH COMPOSITION (whole frame, from renderer.debugReadDepth; the colour table');
console.log('  above is blind to all of it). G5 is the CONJUNCTION of the three gated columns:');
console.log(`  min >= ${LENS_FLOOR_METRES} m, nearMass in [${NEAR_MASS_MIN}, ${NEAR_MASS_MAX}], ` +
  `median >= ${STANDOFF_METRES} m.\n`);
console.log('  anchor         G5    min   lensMass  nearMass  median      p95   bandPeak  bandBits  ' +
  'bands 0-1.2 -4 -10 -25 -60 -150 150+');
for (const r of passes[0]) {
  if (!(r.state.depth > 0.5)) continue;
  const nr = r.state.near || {};
  const v = g5Verdict(nr);
  const bandCols = (nr.bands || []).map((b) => fmt(b.share, 2).slice(1).padStart(5)).join('');
  console.log(`  ${r.short.padEnd(12)} ${(v.pass ? 'pass' : 'FAIL').padEnd(5)}` +
    `${fmt(nr.min, 2).padStart(6)}  ${(nr.lensMass != null ? fmt(nr.lensMass, 4) : '-').padStart(8)}  ` +
    `${fmt(nr.nearMass, 4).padStart(8)}  ${fmt(nr.median, 1).padStart(6)}  ` +
    `${fmt(nr.p95, 1).padStart(8)}   ${(nr.bandPeak != null ? fmt(nr.bandPeak, 3) : '-').padStart(6)}    ` +
    `${(nr.bandEntropyBits != null ? fmt(nr.bandEntropyBits, 2) : '-').padStart(6)}  ${bandCols}` +
    `${v.pass ? '' : '   <-- ' + v.clauses.filter((c) => !c.pass).map((c) => c.id).join(' ')}`);
}
const nonMonotone = passes[0].filter((r) => r.state.near && r.state.near.ladder
  && r.state.near.ladderMonotone === false).map((r) => r.short);
if (nonMonotone.length) {
  console.log(`\n  LADDER NOT MONOTONE at ${nonMonotone.join(', ')} - the frame moved between the`);
  console.log('  ladder reads, so the bands for those anchors describe no single frame.');
}

// G5's THREE CLAUSES ARE GATED ON SINGLE READINGS AND WERE NEVER CONTROLLED.
// `min` in particular is the closest of ~101k sub-samples, so it is the most
// single-sample statistic in the report and the one most easily moved by one
// drifting mote - the LENS_FLOOR_METRES docstring says so and had to quote a
// hand-built three-anchor ladder run to get any repeat figures at all. The
// second tour already photographs the same poses; this is that comparison, for
// free.
const depthControl = control.filter((c, i) => passes[0][i].state.depth > 0.5);
const depthSpread = {
  min: controlSpread('dNearMin', depthControl),
  mass: controlSpread('dNearMass', depthControl),
  median: controlSpread('dNearMedian', depthControl),
  lens: controlSpread('dLensMass', depthControl),
};
if (depthControl.length) {
  console.log('\n  CONTROL, DEPTH COMPOSITION (tour 1 vs tour 2; G5 gates on the first three)');
  console.log('  anchor         d min   d nearMass   d median   d lensMass');
  for (const c of depthControl) {
    console.log(`  ${c.short.padEnd(12)} ${fmt(c.dNearMin, 3).padStart(7)}   ` +
      `${fmt(c.dNearMass, 4).padStart(9)}   ${fmt(c.dNearMedian, 2).padStart(8)}   ` +
      `${fmt(c.dLensMass, 4).padStart(9)}`);
  }
  console.log(`  SPREAD: ${spreadCell('min', depthSpread.min, 3)}   ` +
    `${spreadCell('nearMass', depthSpread.mass, 4)}   ` +
    `${spreadCell('median', depthSpread.median, 2)}   ` +
    `${spreadCell('lensMass', depthSpread.lens, 4)}`);
}

// ---------------------------------------------------------------------------
// The confusion matrix
// ---------------------------------------------------------------------------

const n = tour.length;

/**
 * The full between-anchor cosine matrix for one tour.
 *
 * Built for BOTH tours, not just the headline one. Every between-biome number
 * this project quotes - G1's worst neighbour, G7's deep-seven and shallow-seven
 * means - is a function of this matrix, and until now all of them were single
 * readings: the control bounded the WITHIN-anchor statistics only, so a
 * deep-seven mean that moved 0.6674 -> 0.6155 across a change had nothing
 * saying how far it moves across no change at all. The control tour already has
 * the frames; this costs 14x14 cosines over histograms that are already in
 * memory.
 *
 * @param {Array<object>} recs one tour's per-anchor records
 * @returns {number[][]} the symmetric matrix, 1 on the diagonal
 */
function buildMatrix(recs) {
  const m = [];
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let j = 0; j < n; j++) {
      row.push(i === j ? 1 : cosineSimilarity(recs[i].metrics.hist, recs[j].metrics.hist));
    }
    m.push(row);
  }
  return m;
}

const matrix = buildMatrix(passes[0]);
const matrixRepeat = buildMatrix(passes[1]);

console.log('\nCONFUSION MATRIX, hue x saturation cosine, tour 1 (1.0 = the two frames distribute');
console.log('  their colour identically)\n');
const head = passes[0].map((r) => r.short.slice(0, 5).padStart(6)).join('');
console.log(`  ${''.padEnd(12)}${head}`);
for (let i = 0; i < n; i++) {
  const cells = matrix[i].map((v, j) => (i === j ? '     -' : fmt(v, 3).padStart(6))).join('');
  console.log(`  ${passes[0][i].short.padEnd(12)}${cells}`);
}

/**
 * Each anchor's most-confusable other anchor, in one tour's matrix.
 *
 * @param {number[][]} m the matrix
 * @param {Array<object>} recs the same tour's records, for the names
 * @returns {Array<{short: string, name: string, nearestShort: string|null,
 *   nearestName: string|null, cosine: number}>}
 */
function nearestNeighbours(m, recs) {
  const out = [];
  for (let i = 0; i < n; i++) {
    let bj = -1;
    let bv = -1;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      if (m[i][j] > bv) { bv = m[i][j]; bj = j; }
    }
    out.push({ short: recs[i].short, name: recs[i].name,
      nearestShort: bj >= 0 ? recs[bj].short : null,
      nearestName: bj >= 0 ? recs[bj].name : null, cosine: bv });
  }
  return out;
}

const neighbours = nearestNeighbours(matrix, passes[0]);
const neighboursRepeat = nearestNeighbours(matrixRepeat, passes[1]);

console.log('\nNEAREST NEIGHBOUR BY NAME (the diagnostic: WHICH biome each one is being confused');
console.log('  with, not merely how much)\n');
for (const nb of neighbours) {
  console.log(`  ${nb.name.padEnd(20)} -> ${String(nb.nearestName).padEnd(20)} ${fmt(nb.cosine, 4)}`);
}
// A CATEGORICAL HAS A CONTROL TOO, and this one is quoted as evidence ("X now
// reads as its own place, it stopped pairing with Y"). The identity is an ARGMAX
// over a row whose top entries can sit thousandths apart, so it can flip on
// world variance alone with no change to any threshold. This says how often it
// did, between two tours of one build.
const neighbourFlips = [];
for (let i = 0; i < n; i++) {
  if (neighbours[i].nearestShort !== neighboursRepeat[i].nearestShort) {
    neighbourFlips.push(`${neighbours[i].short}: ${neighbours[i].nearestShort}` +
      ` -> ${neighboursRepeat[i].nearestShort}`);
  }
}
console.log(`\n  CONTROL: tour 2 picks the same neighbour at ${n - neighbourFlips.length} of ${n} ` +
  `anchors${neighbourFlips.length ? ' - flipped: ' + neighbourFlips.join(', ') : ''}`);

/**
 * Mean of the off-diagonal cosines within a subset of destinations.
 *
 * @param {number[]} idx indices into the tour
 * @param {number[][]} [m] which tour's matrix to reduce; tour 1 by default
 * @returns {number} mean pairwise cosine, 0 when the subset has fewer than two
 */
function meanPairwise(idx, m = matrix) {
  let sum = 0;
  let count = 0;
  for (let a = 0; a < idx.length; a++) {
    for (let b = a + 1; b < idx.length; b++) {
      sum += m[idx[a]][idx[b]];
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

const deepIdx = [];
const shallowIdx = [];
const underwaterIdx = [];
for (let i = 0; i < n; i++) {
  (DEEP_IDS.has(passes[0][i].id) ? deepIdx : shallowIdx).push(i);
  if (passes[0][i].state.depth > 0.5) underwaterIdx.push(i);
}
const deepMean = meanPairwise(deepIdx);
const shallowMean = meanPairwise(shallowIdx);
const allMean = meanPairwise([...Array(n).keys()]);

// THE CONTROL OF THE HEADLINE NUMBER. The deep-seven mean is what a biome stage
// is graded on and it was an uncontrolled single reading: tour 2 is an
// independent replicate of the identical build at the identical poses, so
// `control` here is how far the figure moves when NOTHING changed. A stage
// delta smaller than it is not a result.
const deepMeanRepeat = meanPairwise(deepIdx, matrixRepeat);
const shallowMeanRepeat = meanPairwise(shallowIdx, matrixRepeat);
const allMeanRepeat = meanPairwise([...Array(n).keys()], matrixRepeat);

console.log('\nSUBSET MEANS (mean pairwise cosine within each subset; control = the same figure');
console.log('  recomputed from tour 2, i.e. its movement across NO change at all)');
console.log(`  deep seven (ids 7-13)     ${fmt(deepMean, 4)}   control ${fmt(deepMeanRepeat, 4)}  ` +
  `d ${fmt(deepMeanRepeat - deepMean, 4)}   ${deepIdx.map((i) => passes[0][i].short).join(', ')}`);
console.log(`  shallow seven (ids 0-6)   ${fmt(shallowMean, 4)}   control ${fmt(shallowMeanRepeat, 4)}  ` +
  `d ${fmt(shallowMeanRepeat - shallowMean, 4)}   ${shallowIdx.map((i) => passes[0][i].short).join(', ')}`);
console.log(`  whole tour                ${fmt(allMean, 4)}   control ${fmt(allMeanRepeat, 4)}  ` +
  `d ${fmt(allMeanRepeat - allMean, 4)}`);

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const uwEntropy = underwaterIdx.map((i) => passes[0][i].metrics.hueEntropyBits);
const uwDark = underwaterIdx.map((i) => passes[0][i].metrics.darkMass);
const floorOf = (arr) => (arr.length ? Math.min(...arr) : NaN);
console.log(`  underwater (${underwaterIdx.length} anchors) hue entropy   mean ${fmt(mean(uwEntropy), 3)}  ` +
  `floor ${fmt(floorOf(uwEntropy), 3)}`);
console.log(`  underwater dark mass                 mean ${fmt(mean(uwDark), 4)}  ` +
  `floor ${fmt(floorOf(uwDark), 4)}`);
if (tour.length < destinations.length) {
  console.log(`\n  NOTE: --only ran ${tour.length} of ${destinations.length} destinations. Every ` +
    'subset figure and every gate below is over that subset ONLY and is not comparable to a ' +
    'full tour.');
}

// ---------------------------------------------------------------------------
// The acceptance gates - a CONJUNCTION, never G1 alone
// ---------------------------------------------------------------------------

/**
 * The most-confusable pair in one tour: G1's value and the pair it names.
 *
 * @param {number[][]} m the matrix @param {Array<object>} recs its records
 * @returns {{cosine: number, a?: string, b?: string}} -1 when nothing was compared
 */
function worstPairOf(m, recs) {
  let best = { cosine: -1 };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (m[i][j] > best.cosine) {
        best = { cosine: m[i][j], a: recs[i].name, b: recs[j].name };
      }
    }
  }
  return best;
}

const worstPair = worstPairOf(matrix, passes[0]);
const worstPairRepeat = worstPairOf(matrixRepeat, passes[1]);

const deepUW = deepIdx.filter((i) => passes[0][i].state.depth > 0.5);

/**
 * A gate over a subset, which FAILS when the subset is empty.
 *
 * This is not defensive coding. `Math.min()` of nothing is +Infinity and
 * `[].every()` is true, so a gate whose subset came out empty reports a
 * confident PASS on a measurement that was never taken - which is precisely how
 * an `env.cameraDepth` that does not exist made every underwater gate here go
 * green on its first run. An empty subset is a broken instrument, not a met
 * criterion.
 *
 * @param {string} id gate name
 * @param {string} what the criterion, in words
 * @param {number[]} idx the subset it is taken over
 * @param {(i: number) => number} pick the per-anchor quantity
 * @param {(v: number) => boolean} ok the per-anchor predicate
 * @param {'min'|'max'|'mean'} agg which aggregate to print
 * @returns {{id: string, what: string, value: number, pass: boolean, note: string}}
 */
function subsetGate(id, what, idx, pick, ok, agg) {
  if (idx.length === 0) {
    return { id, what, value: NaN, pass: false, note: 'EMPTY SUBSET - not measured' };
  }
  const vals = idx.map(pick);
  const value = agg === 'min' ? Math.min(...vals)
    : agg === 'max' ? Math.max(...vals)
      : vals.reduce((a, b) => a + b, 0) / vals.length;
  const worst = agg === 'max' ? Math.max(...vals) : Math.min(...vals);
  const failing = idx.filter((i, k) => !ok(vals[k]));
  return {
    id, what, value, pass: failing.length === 0,
    note: failing.length === 0 ? `n = ${idx.length}, worst ${fmt(worst, 4)}`
      : `n = ${idx.length}, fails at ${failing.map((i) => passes[0][i].short).join(', ')}`,
  };
}

const gates = [
  // The `>= 0` guard is the same refusal as subsetGate's: with fewer than two
  // destinations there is no pair, `worstPair.cosine` is its -1 sentinel, and
  // "-1 <= 0.90" would report the strictest gate in the file as PASSED on a run
  // that never compared anything.
  { id: 'G1', what: 'worst nearest-neighbour cosine <= 0.90',
    value: worstPair.cosine, pass: worstPair.cosine >= 0 && worstPair.cosine <= 0.90,
    note: worstPair.cosine >= 0 ? `${worstPair.a} x ${worstPair.b}`
      : 'EMPTY SUBSET - fewer than two destinations, nothing was compared' },
  subsetGate('G2a', 'hue entropy floor, underwater >= 1.20', underwaterIdx,
    (i) => passes[0][i].metrics.hueEntropyBits, (v) => v >= 1.20, 'min'),
  { id: 'G2b', what: 'hue entropy mean, underwater >= 1.80',
    value: underwaterIdx.length ? mean(uwEntropy) : NaN,
    pass: underwaterIdx.length > 0 && mean(uwEntropy) >= 1.80,
    note: underwaterIdx.length ? `n = ${underwaterIdx.length}` : 'EMPTY SUBSET - not measured' },
  subsetGate('G3', 'dark mass, every underwater anchor >= 0.02', underwaterIdx,
    (i) => passes[0][i].metrics.darkMass, (v) => v >= 0.02, 'min'),
  subsetGate('G4', 'p95/p05, every deep anchor >= 4.0', deepUW,
    (i) => passes[0][i].metrics.dynamicRange, (v) => v >= 4.0, 'min'),
  // G5 IS THREE CLAUSES, NOT ONE NUMBER - see g5Verdict. It was a single
  // near-mass band for a whole stage and that band PASSED a frame that is one
  // banner 0.58 m from the lens while REJECTING the best-composed frame in the
  // baseline by 0.0008.
  subsetGate('G5a', `lens clearance: nearest geometry >= ${LENS_FLOOR_METRES} m`, underwaterIdx,
    (i) => g5Verdict(passes[0][i].state.near).clauses[0].value,
    (v) => v >= LENS_FLOOR_METRES, 'min'),
  subsetGate('G5b', `near-mass in [${NEAR_MASS_MIN}, ${NEAR_MASS_MAX}], every underwater anchor`,
    underwaterIdx, (i) => g5Verdict(passes[0][i].state.near).clauses[1].value,
    (v) => v >= NEAR_MASS_MIN && v <= NEAR_MASS_MAX, 'min'),
  subsetGate('G5c', `standoff: median ray >= ${STANDOFF_METRES} m, every underwater anchor`,
    underwaterIdx, (i) => g5Verdict(passes[0][i].state.near).clauses[2].value,
    (v) => v >= STANDOFF_METRES, 'min'),
  subsetGate('G6', 'flat fraction <= 0.55, every deep anchor', deepUW,
    (i) => passes[0][i].metrics.flatFraction, (v) => v <= 0.55, 'max'),
  { id: 'G7a', what: 'deep-seven mean pairwise cosine <= 0.45',
    value: deepIdx.length > 1 ? deepMean : NaN,
    pass: deepIdx.length > 1 && deepMean <= 0.45,
    note: deepIdx.length > 1 ? `n = ${deepIdx.length}` : 'EMPTY SUBSET - not measured' },
  { id: 'G7b', what: 'shallow-seven mean pairwise cosine <= 0.25',
    value: shallowIdx.length > 1 ? shallowMean : NaN,
    pass: shallowIdx.length > 1 && shallowMean <= 0.25,
    note: shallowIdx.length > 1 ? `n = ${shallowIdx.length}` : 'EMPTY SUBSET - not measured' },
];

console.log('\nACCEPTANCE GATES - a CONJUNCTION. G1 alone is NOT the acceptance number: two frames');
console.log('  that are each one flat colour score 0.13 against each other, so a low cosine can');
console.log('  mean "different" or can mean "both degenerate". G2/G3/G4/G6 are the within-frame');
console.log('  floors that tell those two apart.\n');
for (const g of gates) {
  console.log(`  ${g.pass ? 'PASS' : 'FAIL'}  ${g.id.padEnd(4)} ${g.what.padEnd(50)} ` +
    `${fmt(g.value, 4).padStart(8)}  ${g.note}`);
}
// EVERY GATED VALUE'S CONTROL, ON ONE LINE, because the gates are what get
// quoted and a gate value moving by less than this is the world, not the work.
const gatedLine = (id, label, s) => console.log(`    ${id.padEnd(4)}${label.padEnd(20)}` +
  `${fmt(s.max, 4).padStart(9)}   worst anchor ${s.at ?? '-'}`);
console.log('\n  CONTROL OF THE GATED VALUES (tour 2 minus tour 1; a stage delta below these is noise)');
console.log(`    G1  worst pair          ${fmt(worstPairRepeat.cosine - worstPair.cosine, 4).padStart(9)}` +
  `   (tour 2's worst pair: ${worstPairRepeat.a} x ${worstPairRepeat.b} at ${fmt(worstPairRepeat.cosine, 4)})`);
gatedLine('G2', 'hue entropy', spreads.hueEntropy);
gatedLine('G3', 'dark mass', spreads.darkMass);
gatedLine('G4', 'p95/p05', spreads.dynamicRange);
console.log(`    G5  min/nearMass/median ${fmt(depthSpread.min.max, 3)} / ` +
  `${fmt(depthSpread.mass.max, 4)} / ${fmt(depthSpread.median.max, 2)}`);
gatedLine('G6', 'flat fraction', spreads.flatFraction);
console.log(`    G7a deep-seven mean     ${fmt(deepMeanRepeat - deepMean, 4).padStart(9)}`);
console.log(`    G7b shallow-seven mean  ${fmt(shallowMeanRepeat - shallowMean, 4).padStart(9)}`);
// SAY WHAT IS STILL UNBOUNDED. Every one of these is emitted for BOTH tours in
// the JSON (destinations[].metrics against destinations[].repeat.metrics, and
// the same for .state), so any of them can be differenced after the fact - but
// none is differenced HERE, and a figure nobody differenced is a single reading
// however many decimals it is quoted to. Quote one as a result and it needs a
// column above first.
console.log('\n  STILL UNCONTROLLED, and no gate reads any of them: hueEntropySatBits, meanL,');
console.log('    gatedFraction, p05L and p95L in absolute terms, near.p95, near.bandPeak,');
console.log('    near.bandEntropyBits, near.infFraction, scatterInstances.');

const gatesPassed = gates.filter((g) => g.pass).length;
console.log(`\n  ${gatesPassed}/${gates.length} gates pass. These are the TARGET the biome plan aims at,`);
console.log('  not a regression check - the build being baselined today misses most of them by');
console.log('  design. Pass --gate to make a gate failure exit non-zero.');
console.log(`\n  AND NO METRIC REPLACES LOOKING: read the PNGs in ${SHOT_DIR}/.`);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const report = {
  tool: 'tools/test-variety.mjs',
  generated: new Date().toISOString(),
  seed,
  conditions: {
    dayFraction: DAY_FRACTION, lampDepth: LAMP_DEPTH, settleSeconds: SETTLE,
    hudVisible: false, nearMetres: NEAR_METRES,
    lensFloorMetres: LENS_FLOOR_METRES, nearMassBand: [NEAR_MASS_MIN, NEAR_MASS_MAX],
    standoffMetres: STANDOFF_METRES, depthLadder: DEPTH_LADDER,
    crop: DEFAULT_CROP, gate: DEFAULT_GATE, hueBins: HUE_BINS, satBins: SAT_BINS,
  },
  instrumentSelfCosine: parityCosine,
  delivered: { dayFractionMin: dayMin, dayFractionMax: dayMax, hudVisibleCaptures: hudOn,
    legendVisibleCaptures: legendOn,
    lampPolicyDisagreements: lampWrong.map((r) => r.short), streamingWarnings },
  // `spread` and `gated` are the bound on every number anyone quotes off this
  // report: the largest movement each gated quantity made between two tours of
  // ONE build. A before/after smaller than the matching entry is a lottery read.
  control: { min: CONTROL_MIN, void: VOID, worst: worstControl, perAnchor: control,
    spread: {
      ...spreads,
      nearMin: depthSpread.min, nearMass: depthSpread.mass,
      nearMedian: depthSpread.median, lensMass: depthSpread.lens,
      exposure: exposureSpread,
    },
    gated: {
      G1: worstPairRepeat.cosine - worstPair.cosine,
      G7a: deepMeanRepeat - deepMean, G7b: shallowMeanRepeat - shallowMean,
      allMean: allMeanRepeat - allMean,
    },
    neighbourFlips },
  destinations: passes[0].map((r, i) => ({
    id: r.id, name: r.name, short: r.short, dominant: r.dominant, weight: r.weight,
    seabedHeight: r.height,
    frame: r.file,
    state: passes[0][i].state,
    metrics: r.metrics,
    g5: g5Verdict(passes[0][i].state.near),
    repeat: { frame: passes[1][i].file, state: passes[1][i].state,
      metrics: passes[1][i].metrics },
  })),
  matrix,
  // The control tour's matrix, kept whole rather than only its summaries: a
  // committed report is the only record of a run, and a reader asking "is this
  // pair's cosine real" needs the replicate pair, not a subset mean over it.
  matrixRepeat,
  neighbours,
  neighboursRepeat,
  subsetMeans: { deep: deepMean, shallow: shallowMean, all: allMean,
    deepRepeat: deepMeanRepeat, shallowRepeat: shallowMeanRepeat, allRepeat: allMeanRepeat,
    deepShorts: deepIdx.map((i) => passes[0][i].short),
    shallowShorts: shallowIdx.map((i) => passes[0][i].short) },
  gates,
  gatesRepeat: { worstPair: worstPairRepeat },
  consoleErrors,
};

if (VOID) {
  console.log('\nVOID: the control failed. Every number above is a LOTTERY READ and no baseline');
  console.log('  was written. Re-run; if it repeats, the settle is too short or something in the');
  console.log('  fixed conditions is not actually fixed.');
  // Under the run's own name, not a shared `void.json`: two void runs in a
  // session are exactly when you want to compare them, and `latest.json` is
  // deliberately NOT moved, so "latest" keeps meaning the last run whose
  // numbers may be believed.
  const voidFile = join(OUT, OUT_NAME.replace(/\.json$/i, '') + '.void.json');
  await writeFile(voidFile, JSON.stringify(report, null, 2));
  console.log(`\n  -> ${voidFile}   (frames in ${relative(ROOT, SHOT_DIR)}/)`);
} else {
  await writeFile(join(OUT, OUT_NAME), JSON.stringify(report, null, 2));
  // The pointer is a pointer, not a copy: a second full report under a fixed
  // name is the thing that made `report.json` look authoritative and get graded
  // against, which is how a stage's numbers were overwritten in the first place.
  await writeFile(LATEST, JSON.stringify({
    note: 'Pointer written by tools/test-variety.mjs. Not a report - open the file it names.',
    report: relative(ROOT, join(OUT, OUT_NAME)),
    frames: relative(ROOT, SHOT_DIR) + '/',
    written: new Date().toISOString(),
    seed: report.seed, anchors: report.destinations.length,
    worstControl, gatesPassed, gateCount: gates.length,
  }, null, 2) + '\n');
  console.log(`\n  -> ${join(OUT, OUT_NAME)}`);
  console.log(`  -> ${LATEST}   (points at the above)`);
}

if (consoleErrors.length) {
  console.log('\n  console errors:\n    ' + consoleErrors.join('\n    '));
}

sock.close();
cleanup();
process.exit(VOID || (HARD_GATE && gatesPassed < gates.length) ? 1 : 0);
