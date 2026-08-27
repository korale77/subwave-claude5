/**
 * A representative world position for each biome, found by searching the real
 * generated terrain.
 *
 * The developer jump menu needs an answer to "where is the kelp forest?", and
 * there are only two ways to have one. A baked table of coordinates is free but
 * LIES WITHOUT FAILING the moment the seed or any terrain layer moves: it still
 * returns a position, the position is still in the world, and it is simply no
 * longer the biome it claims. That is exactly what `WORLD.BASE_POSITION` did -
 * it named a beach the generator had put under 17 m of water, and the player
 * spawned swimming in open ocean - and it is why `terrain.findSpawnPoint()`
 * derives the start from the terrain instead of naming it.
 *
 * So this searches. It is a pure query over `terrain` and `biomes` with no DOM
 * and no GPU, so the offline suite can assert at any seed that every anchor it
 * returns is genuinely the biome it is labelled with.
 *
 * Measured on the default seed: 14/14 dominant. The scorer deliberately spends
 * more than the original point-only search: an anchor is a VIEW of a place, not
 * a proof that one sample under the camera has the requested label.
 */

import { PLAYER, PLAYER_LAMP, WORLD } from '../core/constants.js';
import { BIOMES, BIOME_COUNT, biomeWeights, waterTypeAt } from './biomes.js';

/**
 * Coarse grid pitch, metres. 97x97 = 9,409 samples over the 6,144 m playfield at
 * ~5.3 us each (sampleHeight ~1.0, sampleSlope ~3.8, biomeWeights the rest).
 * Halving it quadruples the cost to find a spot the refine pass already reaches.
 */
const COARSE_STEP = 64;
/** Local refine pitch and reach, metres: 17x17 = 289 samples per biome. */
const REFINE_STEP = 8;
const REFINE_RADIUS = 64;

/**
 * Scale at which an arrival should read as a landform. Classification still
 * uses terrain.sampleSlope's 2 m default so it agrees with the rendered mesh;
 * this second slope is presentation evidence. A 2 m wrinkle must not be enough
 * to make a bare plain the representative view of Rock Spires.
 */
const LANDFORM_SLOPE_EPS = 32;
/** Four samples on this ring measure whether the camera is in a biome or on a sliver. */
const NEIGHBOUR_RADIUS = 40;
/**
 * ELIGIBILITY FLOORS ON THE EVIDENCE, and they are the SAME NUMBERS
 * `tools/test-jump.mjs` asserts - the point weight at `:100` and the four-point
 * neighbourhood at `:105`.
 *
 * Until `nearFieldDominance` joined the product, the resolver had no term that
 * could keep either promise; it merely happened to. It stopped happening the
 * moment a presentation term worth up to 1/0.42 could be traded against them:
 * with only the near-field factor added, Shelf Break took a site at
 * neighbourhood 0.343, and with the neighbourhood floor alone it took one at
 * point weight 0.33. Both are candidates that bought a clean 24 m disc with the
 * evidence that the biome is there at all.
 *
 * So the order is now explicit and it is the right one: ELIGIBILITY FIRST,
 * PRESENTATION SECOND. A candidate must be inside both authored bands, must
 * hold the blend at the point, and must hold the ring - and only then do the
 * presentation terms rank what is left. A resolver that satisfies a suite's
 * guard by luck is a guard that fails on the next seed.
 */
const WEIGHT_FLOOR = 0.45;
const NEIGHBOUR_FLOOR = 0.35;

/**
 * NEAR-FIELD DOMINANCE: how far out the arrival's OWN biome has to be the one
 * that wins, and how hard a foreign sample is punished.
 *
 * `NEIGHBOUR_RADIUS`'s four samples at 40 m are a POINT test with a sanity ring,
 * and Shelf Break is the proof that a point test is not enough. Its anchor
 * measures 0.906 own-biome dominance in a 24 m disc and 52 of 64 samples on a
 * 6-20 m ring - and the ten samples that go to Twilight Terraces were enough for
 * the placer to seat a `terraceVeil`, TWILIGHT TERRACES' EXCLUSIVE SIGNATURE,
 * 7.4 m from the eye at 14.9 m across. Ablated at the identical pose, whole-frame
 * near-mass was 0.3643 for terrain alone, 0.6672 with only that one object added,
 * and 0.7753 delivered. No per-biome density weight can reach it: `terraceVeil`
 * is not in Shelf Break's mask at all, so the fix has to be the SITE.
 *
 * 24 m, because that is the radius inside which a signature form seats itself in
 * the FOREGROUND: the tour's near-mass window is 15 m, the biggest signature
 * meshes are 12-15 m across, and half of one seated at 24 m still crosses the
 * 15 m plane. Two rings of eight, 16 samples, so the cost lands where the branch
 * and bound in `considerSample` can pay for it.
 *
 * The exponent is 2, and it is 2 because 4 was measured and cost more than it
 * bought. The quantity being punished is not "how much of the ground is mine" -
 * it is "how many chances did a foreign placer get" - so the term wants to be
 * steep; but it only ever ranks candidates that have ALREADY cleared the two
 * evidence floors above, and past squaring it stops moving the anchors it was
 * aimed at and starts moving the ones it was not. Measured over all fourteen,
 * exponent 2 against exponent 4: both re-site Shelf Break to the same
 * (-352, -1888) at near-dominance 1.000, both re-site Canyon Wall to the same
 * (-2496, -488); exponent 4 additionally moves Twilight Terraces and Rock Spires
 * off sites this round did not set out to touch, and costs 372 ms against
 * 327 ms of the 400 ms `test-jump` budget. Measured over the 32 m grid of
 * Shelf-Break-dominant samples, 928 of 2,465 candidates hold 1.0, so squaring
 * is already enough to make holding it the cheapest way to win.
 */
const NEAR_FIELD_RADIUS = 24;
const NEAR_FIELD_SPOKES = 8;
const NEAR_FIELD_RINGS = 2;
const NEAR_FIELD_EXPONENT = 2;

/**
 * WHICH BIOMES THE TWO PRESENTATION TERMS ARE ALLOWED TO RE-SITE, by id. Shelf
 * Break and Canyon Wall, and this list is short because IT WAS MEASURED SHORT.
 *
 * Applied to all fourteen and toured, the terms are a net LOSS even though each
 * one is individually sound. Measured, whole 14-anchor tour, unrestricted
 * against the build before it:
 *
 *  - SAND PLAINS collapses. Hue entropy 0.070 -> 0.003 and near-mass
 *    0.445 -> 0.851: the near-field disc moved it onto a site whose delivered
 *    frame is one flat close surface. Its nearest-neighbour cosine "improves"
 *    from Shallow Reef 0.9225 to Shelf Break 0.2501, which is exactly the
 *    degenerate-cosine trap `tools/test-variety.mjs` exists to catch - a frame
 *    of one flat colour scores wonderfully against everything.
 *  - BOULDER FIELD near-mass 0.315 -> 0.654, TRENCH WALL 0.381 -> 0.266 with
 *    hue entropy 0.668 -> 0.871, KELP FOREST 0.505 -> 0.393. Mixed, none of it
 *    measured against a read PNG.
 *  - The deep-seven mean pairwise cosine goes 0.6723 -> 0.7121, i.e. the wrong
 *    way, while the whole-tour figure goes 0.2278 -> 0.1978 - and the shallow
 *    half of that gain is Sand Plains' degenerate frame.
 *
 * THE TERRAIN CAN ONLY SEE HALF THE PROBLEM, which is why this cannot be fixed
 * by tuning. `framingView` marches the heightfield; the near field of a deep
 * frame is SCATTER. At Canyon Wall the terrain's own share of the frame inside
 * 15 m is 0.07 where the delivered figure is 0.397. So the terms are a good
 * prior and a bad oracle, and a biome joins this list when its delivered frame
 * has been toured and READ, not before.
 *
 * AND SAND PLAINS MUST NOT BE RE-SITED FOR VOIDING THE TOUR CONTROL, which is
 * the other reason someone reaches for this list. Its anchor VOIDed one run at
 * self-cosine 0.96796, and the record identifies the cause exactly: that
 * capture reads nearest geometry 1.183 m and `lensMass` 0.01001 - one percent of
 * the frame inside the 1.2 m lens floor - with hue entropy 0.5355. THIRTEEN
 * OTHER CAPTURES OF THE SAME ANCHOR READ `lensMass` 0.00000 EXACTLY, nearest
 * geometry 2.077-2.235 m and entropy 0.110-0.208. A drifter crossed the lens.
 * Measured over five fresh control runs at the shipped anchor, self-cosine
 * 0.999358 / 0.998158 / 0.999382 / 0.999941 / 0.999450 against a 0.98 gate, and
 * one VOID in the twenty tours of this anchor on record.
 *
 * A FRAMING CHANGE CANNOT FIX IT AND THE OBVIOUS ONES MAKE THE PICTURE WORSE.
 * The clearance being defended is 0.9 m - the gap between the seabed at 2.1 m
 * and the 1.2 m floor - and lifting the eye off the seabed does not widen it,
 * because the object is free-swimming and is seeded around the EYE. Four lifted
 * and pitched-down restagings were photographed
 * (`tools/shots/sand-restage.json`, eye 8-16 m, pitch -0.25 to -0.55): every one
 * fills the frame with pale sediment, drives the delivered exposure 14.1 -> 18.2
 * -20.1, loses the horizon that gives the frame its only tonal structure, and
 * still has jellies in it. The lever that would work is on the INSTRUMENT, which
 * already records the field that separates the cases: retake a capture whose
 * `lensMass` is non-zero.
 *
 * ROCK SPIRES IS DELIBERATELY NOT ON IT even though it is the biome that
 * motivated `framingView`. It takes the AIM and not the SCORE: see
 * `considerSample`, and the measurement is in `LANDMARK_BIOMES`.
 *
 * THE HONEST RESIDUAL, so nobody re-opens this expecting a free win. No
 * arrangement of these terms gets a ROCK needle silhouetted at Rock Spires: the
 * site that ships keeps the entropy and its tall foreground form is a
 * `crystalSpire` with the rock only a dark mass at its foot. TWO successive
 * explanations of that have been written here and BOTH WERE WRONG, so both are
 * kept, retracted, in the order they were believed:
 *
 *  - "no camera can photograph what carries no light at 367 m". Wrong as
 *    stated: `tools/shots/spires-silhouette.json`'s `spires-silhouette-60m`
 *    frame is a real dark tapering rock needle at 292 m with glowing scatter
 *    beside it. It closed the question by over-generalising the depth.
 *  - "the actual blocker is the landform slope band", i.e. that the resolver
 *    rejects the gentle ground a spire has to be photographed FROM. Also wrong,
 *    and measured wrong: relaxing that floor from 0.85 to 0.51 admits 30 coarse
 *    candidates, only 2 of them carry a needle, and the site that then WINS is
 *    on its formation at slope 0.92 anyway.
 *
 * The third answer is on the comment above `LANDMARK_HEADINGS`, it is measured
 * against photographed frames rather than inferred, and it is about the
 * BACKDROP. Read that before spending anything else here.
 */
const PRESENTATION_BIOMES = Object.freeze([7, 10]);

/**
 * Biomes whose arrival must be AIMED AT THEIR OWN LANDFORM, by id.
 *
 * Only Rock Spires, and the reason is that it is the one biome whose identity is
 * a SILHOUETTE rather than a ground cover: it is authored as "tall thin towers
 * against open water", and real 200 m needles were built for it. Everything else in the table reads from the material and the
 * scatter under a generic downhill reveal.
 *
 * THE WINDOW IS THE WATER'S OWN CONTRAST RANGE, NOT A DISTANCE IN METRES, and
 * that correction is the whole reason the two obvious versions of this fail.
 * Both are photographable now - `node tools/shot.mjs --list
 * tools/shots/spires-aim.json` holds the shipped arrival next to both of them,
 * at the anchor the jump menu resolves - and both are recorded here because the
 * terrain ray-march recommends each of them:
 *
 *  - AIM AT THE TALLEST THING. Ray-scanned over 24 headings, the ground rises
 *    190-215 m above that eye at 250 m on headings +20 to +60 deg. Marched
 *    through the real 75 deg fovY frustum those same headings sit at terrain
 *    near-mass 0.93-1.00, because the eye is standing on the tower's FOOT, and
 *    the delivered frame is a lamp blow-out on rock a metre away.
 *  - AIM AT THE BEST SILHOUETTE. The heading whose frustum near-mass and open
 *    fraction are best (yaw -1.83, near-mass 0.036, 70% open water) puts a
 *    134 m-prominence tower 177 m away, and DELIVERS AN EMPTY FRAME: at 367 m
 *    there is no daylight and the suit lamp reaches tens of metres, not
 *    hundreds, so nothing at 177 m is lit at all.
 *
 * A needle is photographable only between those two failures, and THE SCALE
 * THAT SEPARATES THEM IS THE SUIT LAMP, NOT THE WATER. That correction is
 * 2026-08-05 and it replaces this comment's own previous answer (the contrast
 * range R = max_i ln(1 + sigmaT_i/sigmaS_i)/sigmaT_i, 15.9-44.3 m over the
 * columns Rock Spires actually carries), which was inferred from the two
 * failures above without ever photographing a success. Fourteen frames were
 * taken at the resolved anchor and at eight other Rock Spires sites, all under
 * the tour's own conditions (day 0.32, lamp on, 14 s settle), and they separate
 * cleanly BY RANGE IN METRES and not by any multiple of R:
 *
 *   32 m  (R 15.9)  the rock is IN the beam. `PLAYER_LAMP.range` is 48 m, so a
 *                   crest at 32 m is front-lit against a 4.1-4.6% albedo and
 *                   delivers an amorphous glow with no edge. Confirmed to be
 *                   geometry and not an empty frame: `debugReadDepth(60)` at
 *                   that pose reads near-mass 0.244 with a minimum depth of
 *                   22.5 m, i.e. a quarter of the frame IS the rock.
 *   56-60 m         SILHOUETTE. The rock is outside the beam, so it is unlit,
 *                   and the beam's own in-scatter behind it is still bright:
 *                   three sites at 111 m, 292 m and 317 m of depth all deliver
 *                   a readable dark needle against lit haze.
 *   64-81 m         nothing. The in-scatter behind the crest has faded to the
 *                   rock's own value and the edge disappears - measured at four
 *                   sites, 341-422 m deep.
 *   110-177 m       nothing, which is the second failure recorded above.
 *
 * That reading was `[1.00, 1.35] x PLAYER_LAMP.range`, AND IT IS THE DEPTH
 * COLUMN OF ITS OWN TABLE THAT SEPARATES THOSE FRAMES, not the distance column.
 * Every success above sits at 111 / 292 / 317 m and every failure at 341-476 m,
 * so the two orderings are the same ordering. Score them instead by the
 * downwelling daylight that survives to the site - `max_i exp(-Kd_i x depth)` on
 * its own column, which is the quantity `Kd` exists to answer - and the
 * separation is clean with no exceptions: successes 0.132, 4.93e-3, 3.1e-3;
 * failures 2.0e-3 down to 3.65e-6. IT IS A BACKDROP, NOT A RANGE. A dark rock
 * only reads against water that is LIT, the lamp cannot light water it is
 * pointing THROUGH, and below about 320 m in these columns there is nothing
 * behind the subject at all.
 *
 * The distance window still holds as a NECESSARY condition and is what
 * `LANDMARK_SILHOUETTE_NEAR/FAR` encode - inside 48 m the subject is in the beam
 * and has no edge - but it is not sufficient, and the resolver has no term for
 * the backdrop. Adding one does not help at this seed: see the comment above
 * `LANDMARK_HEADINGS` for the exhaustive search that says the three conditions
 * do not intersect anywhere in this world.
 */
const LANDMARK_BIOMES = Object.freeze([8]);

/**
 * WHY THERE IS NO `standOff` FLAG HERE, AND WHY ROCK SPIRES STILL HAS NO NEEDLE.
 *
 * The obvious next move on this file - a per-biome "stand off your own landform"
 * property, general enough for Stage 5's landmarks - was built, measured against
 * the real resolver, PHOTOGRAPHED, and REMOVED, and the measurements are kept
 * because they close two hypotheses and identify the quantity that actually
 * decides a silhouette. Nothing below is a plan; it is what the frames said.
 *
 * 1. THE LANDFORM-SLOPE BAND IS NOT THE BLOCKER, and the retraction on
 *    `PRESENTATION_BIOMES` is the same finding. Relaxing Rock Spires' slope floor
 *    from its authored 0.85 to 0.51 admits 30 candidates on the 9,409-point
 *    coarse grid - 205 eligible against 175 - including two of the three sites
 *    the previous pass measured as DELIVERING a needle, (1780, 1048) and
 *    (1600, -1868), whose slopes are 0.81 and 0.71. But only 2 of those 30 carry
 *    a needle at all, and with the relaxation in place the site that WINS is on
 *    its formation anyway, 32 m slope 0.92, inside the authored band. The real
 *    defect was that Rock Spires took the AIM from `framingView` and not the
 *    SCORE, so nothing ever ranked one site above another by whether a needle
 *    was in the picture.
 *
 * 2. FIXING THAT DOES MOVE THE ANCHOR ONTO A NEEDLE, AND THE FRAME IS EMPTY.
 *    Multiplying `needleAim`'s score into the product moves the anchor to
 *    (1184, -2016): needle score 0.903, an isolated crest 33.4 deg up at 56 m,
 *    with the arrival pitched +0.060 rad so the crest sits one headroom below the
 *    top edge. `tools/shots/spires-standoff.json` photographs it under the tour's
 *    own conditions and THERE IS NOTHING IN THE PICTURE - a lamp cone on flat
 *    sediment and black beyond it. Of the four other candidate sites in that
 *    list, two are the same empty frame, one shows near-field structure with no
 *    silhouette in it, and the fifth entry is the reference frame at 292 m,
 *    which reproduces.
 *
 * 3. THE SILHOUETTE BAND IS NOT A DISTANCE. It is a BACKDROP, and the previous
 *    pass's `[1.00, 1.35] x PLAYER_LAMP.range` is that backdrop confounded with
 *    depth. Its three successes were at 111 m, 292 m and 317 m of depth and every
 *    one of its failures at 341-476 m, so the distance band and the depth sort
 *    the same frames. Score them by the surviving downwelling daylight instead -
 *    `max_i exp(-Kd_i x depth)` on the site's own column, which is exactly the
 *    quantity `Kd` is for - and the separation is clean and has no exceptions:
 *    every success is at 3.1e-3 or brighter (0.132, 4.93e-3, 3.1e-3) and every
 *    failure at 2.0e-3 or darker (2.0e-3 down to 3.65e-6). A dark rock against
 *    open water needs the water behind it to be LIT, and below ~320 m in these
 *    columns it is not. The lamp cannot supply it: the lamp lights what is inside
 *    48 m, and the subject has to be outside that or it has no edge.
 *
 * 4. AND AT THIS SEED THE THREE REQUIREMENTS DO NOT INTERSECT. Over a 16 m
 *    lattice of the whole playfield: 34,609 seabed samples carry daylight at or
 *    above 3e-3; 1,119 of those are Rock-Spires-dominant; 120 pass the biome's
 *    own evidence floors; 283 samples in the world carry a needle by
 *    `needleAim`'s test - and of the 12 that are BOTH lit and Rock Spires, ALL
 *    TWELVE fail `WEIGHT_FLOOR` or `NEIGHBOUR_FLOOR`. They are mosaic slivers,
 *    which is exactly what those floors exist to refuse. 206 of the 283 lit
 *    needles are SHELF BREAK, and that includes (1768, 1048) - 12 m from the
 *    reference frame everyone has been quoting as the Rock Spires arrival we
 *    want. Mapped at 4 m pitch, its own 48 m neighbourhood is a mosaic in which
 *    4 of 169 cells qualify at all.
 *
 * SO THE SPIRES-SILHOUETTE-60M SHOT IS REAL AND IS NOT A
 * ROCK SPIRES ARRIVAL. Reaching one is not a resolver change: it needs either
 * the terrain to put a lit needle inside Rock Spires' own body (the needle
 * aspect target, at the shallow end of the [40, 620] band), or a
 * Stage 5 PLACE whose footprint is authored around one. Both are out of this
 * file. What ships from this pass is this comment and the shot list.
 *
 * THE BEST DEEP ROCK FRAME THAT WAS PHOTOGRAPHED, for whoever takes it next:
 * `spires-standoff-alt-1936`, at (-1936, -592), 329 m, which is the highest
 * refined score of the eight needle candidates (0.1629 against the winner's
 * 0.0995) and delivers a dark rock ridge, a pale crown, violet crystal and
 * cyan/gold emitters over lit sediment. It has no NEEDLE in it, so it was not
 * taken - but it is a better Rock Spires frame than the one that ships, and the
 * reason it is unreachable is worth knowing: its coarse seed ranks SIXTH, and
 * the resolver only refines the winner. The refined score is nearly uncorrelated
 * with the coarse score for this biome, because a 4 m move changes the crest
 * elevation by 12 deg.
 */

/** Headings scanned, and the fan that a 75 deg fovY at 2.11 aspect actually sees. */
const LANDMARK_HEADINGS = 24;
const LANDMARK_FAN = 4;
/** Burial and tower windows, in multiples of the water's contrast range. */
const LANDMARK_NEAR_FRAC = 0.6;
const LANDMARK_FAR_FRAC = 3.0;
/** Samples along one heading. 12 puts the pitch at 4.9 m in NEPHELOID. */
const LANDMARK_STEPS = 12;
/** Elevation above the eye line, radians: burial reference, tower floor and cap. */
const LANDMARK_BURIAL_REF = 0.14;
const LANDMARK_BURIAL_MAX = 0.14;
const LANDMARK_TOWER_MIN = 0.16;
const LANDMARK_TOWER_CAP = 0.80;

/**
 * THE NEEDLE SEARCH: the silhouette band, and the frame it has to fit in.
 *
 * These are the second, independent profile a LANDMARK biome takes, and they
 * exist because the first one - the burial/tower pair above - cannot express the
 * question. What it measures is the OPENEST frame, and the three ways that fails
 * to find a needle were each measured at the shipped anchor (-1928, 952):
 *
 *  1. THE OPEN FRACTION COUNTS HEADINGS WHOSE CREST IS BELOW THE EYE LINE, so it
 *     is MAXIMISED BY A FAN WITH NO TOWER IN IT. The eye stands at the foot of a
 *     161 m tower 33 m away, so the burial test alone rejects all twelve
 *     tower-bearing headings outright (their near-window elevation is 20.8-64.6
 *     deg against a 0.14 rad cap) and the winner is chosen from the eight that
 *     look downhill into open water.
 *  2. THE HEADING IT RETURNS NEED NOT CONTAIN THE TOWER IT SCORED. `frameAt`
 *     aggregates a +/-60 deg fan, so the winning frame at yaw 210 deg takes its
 *     entire tower credit from heading 270 deg - 60 deg off the aim, at the very
 *     edge of the frame. Headings 210/225/240/255 all score 0.6417 and the tie
 *     is broken by index order.
 *  3. THE PITCH CANNOT SEE WHAT JUSTIFIED THE AIM. `STAGED_ARRIVAL` holds
 *     -0.58 rad, so the frame's top edge is +4.3 deg while that crest is at
 *     +33.1 deg. Nothing that qualified the heading is in the picture.
 *
 * So the needle search asks the question directly: AIM AT THE CREST, require the
 * crest to be ISOLATED rather than the rest of the fan to be below the eye, and
 * derive the pitch from the crest. `LANDMARK_CORE` is the burial fan for that
 * test and it is +/-2 headings (+/-30 deg) rather than the frame's full +/-60,
 * because a tall mass at the FRAME EDGE is composition and a tall mass in the
 * CENTRE is the thing that buries the subject: measured over the same sites, the
 * +/-60 fan reads a burial of 70-77 deg at every eye position from which a
 * needle is in fact visible, because it is standing next to the needle's own
 * foot.
 *
 * `LANDMARK_CREST_MIN/CAP` are the crest elevations the frame can hold with the
 * ground still in it: at `LANDMARK_PITCH_HEADROOM` below the 37.5 deg half-fovY,
 * a 17.2 deg crest pitches the camera 12.8 deg DOWN and a 54.4 deg one pitches
 * it 24.4 deg up, where the bottom edge still lands on ground 5 m ahead.
 * `LANDMARK_ISO_DROP` is 0.20 rad because the towers are 18-41 m wide at half
 * prominence (census p50 25.2 m), which at 56 m subtends 18-40 deg, i.e. one to
 * three of the 15 deg headings - a wall fills the fan and scores zero.
 *
 * `LANDMARK_NEEDLE_FLOOR` is the same 0.25 floor `bandTerm` uses and for the same
 * reason: a frame with no needle in it is a weak Rock Spires arrival, not an
 * ineligible one, and zeroing it would drop the biome to `bestWeightFallback` at
 * any seed whose spires are all buried.
 *
 * IF THIS SCORE IS EVER MULTIPLIED INTO THE PRODUCT, MOVE THE FLOOR OUTSIDE THE
 * BURIAL FACTOR FIRST. As written the burial reciprocal scales the whole term,
 * so a needle frame at the burial cap scores 0.125 - BELOW the floor - and the
 * openest-frame fallback, which scores up to 1.0 on exactly the frames the needle
 * search exists to reject (0.6417 at the shipped anchor, on a fan chosen for
 * containing no tower), can outrank it. `floor + (1 - floor) x burial x quality`
 * has the same ordering among needle frames and keeps every one of them in
 * [0.25, 1]. It is not written that way today because nothing reads this score:
 * Rock Spires takes the AIM and not the SCORE.
 */
const LANDMARK_CORE = 2;
const LANDMARK_SILHOUETTE_NEAR = PLAYER_LAMP.range;
const LANDMARK_SILHOUETTE_FAR = PLAYER_LAMP.range * 1.35;
const LANDMARK_NEAR_STEP = 6;
const LANDMARK_FAR_STEP = 4;
const LANDMARK_CREST_MIN = 0.30;
const LANDMARK_CREST_CAP = 0.95;
const LANDMARK_ISO_DROP = 0.20;
const LANDMARK_PITCH_HEADROOM = Math.PI / 6;
const LANDMARK_NEEDLE_FLOOR = 0.25;
/**
 * Curated rotation from the generic downhill view, by biome id. Most arrivals
 * keep the natural downhill reveal. Trench Wall looks across its relief so the
 * wall has a silhouette; Canyon Wall faces uphill instead of photographing
 * empty water.
 *
 * ROCK SPIRES' ENTRY IS DEAD AND MUST STAY 0. It carried +90 deg once, then 0,
 * and now `framingView` supplies its heading outright because it is in
 * `LANDMARK_BIOMES` - so whatever is written in slot 8 is added to a downhill
 * heading that is then discarded. Left at 0 so that the fallback path (no tower
 * within the water's contrast range, at some other seed) is the plain downhill
 * reveal rather than a rotation nothing has measured.
 */
const VIEW_YAW_OFFSET = Object.freeze([
  0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, Math.PI, 0, Math.PI * 0.5, 0,
  // Ossuary Flats (14): the plain downhill reveal. This table is indexed by
  // biome id, so it MUST grow with BIOMES - a missing entry is `yaw +
  // undefined = NaN` and test-jump's finite-framing assertion goes red.
  0,
  // Crimson Meadow (15): the plain downhill reveal. The meadow is a flat
  // shallow plateau, so downhill is as good as any curated rotation until a
  // delivered frame says otherwise.
  0,
  // Bulb Grove (16): the plain downhill reveal, same reasoning as the meadow.
  0,
  // Platter Forest (17): the plain downhill reveal until a delivered frame
  // argues for a curated rotation.
  0,
  // Sunken Dunes (18): the plain downhill reveal - the plateau is open in
  // every direction and the subject (the resident leviathan) moves, so no
  // fixed rotation is better than downhill until a delivered frame argues.
  0,
]);

/**
 * Arrivals that `teleport.js`'s generic framing cannot produce, by biome id.
 *
 * The generic arrival is water-sized and self-correcting: the eye sits
 * `0.125 x beamRange` above the seabed (3.36 m in OCEANIC_CLEAR, 2.7 m in
 * HADAL_SUSPENSION) and the pitch aims at the ground one aim-distance ahead
 * with `GROUND_LINE_LIFT` added. ELEVEN OF THE FOURTEEN KEEP IT.
 *
 * `eyeLift` is the EYE's height above the seabed, metres (the anchor stores
 * FEET, hence the `PLAYER.EYE_HEIGHT` subtraction); `null` keeps the water's
 * own. `pitch` is radians, positive up, authored past `arrivalPitch`'s clamp.
 *
 * EVERY NUMBER BELOW IS A DELIVERED-FRAME NUMBER, NOT A TERRAIN ONE, and that
 * is the whole reason this table is authored rather than derived. Terrain
 * ray-marching cannot see scatter, and in this world the scatter IS the near
 * field: at Canyon Wall the terrain's own share of the frame inside 15 m is
 * 0.07 at `eyeLift: 10` while the delivered figure at `eyeLift: 8` is 0.397,
 * so 0.33 of that frame is a `canyonBanner` the heightfield knows nothing
 * about. Each entry was tuned by re-running `tools/test-variety.mjs --only`
 * and READING THE PNG, and the sweeps are recorded so the next reader does not
 * repeat them.
 *
 * SHELF BREAK, `pitch: -0.45`. Delivered near-mass at the resolved site runs
 * 0.240 at `arrivalPitch`'s own -0.62 clamp and 0.0744 here; hue entropy 0.919
 * -> 0.838, against a tour baseline of 0.639. The eye is left at the water's
 * own height because the site already opens onto the drop (the ground falls
 * 8 m by 20 m ahead, 22 m by 40 m and 65 m by 160 m) and lifting it as well
 * empties the frame.
 *
 * ROCK SPIRES, `pitch: -0.58`. It stands on ground that FALLS at about 27 deg
 * along the heading `framingView` picks, and a shallow line of sight down a
 * falling slope is nearly parallel to it, so the pitch controls near-mass far
 * more strongly than the eye height does. Measured on the site this pass
 * REJECTED (see PRESENTATION_BIOMES), where the fall is 45 deg, delivered
 * near-mass runs 0.0026 at -0.35, 0.0462 at -0.50 and 0.1311 at -0.58 - the
 * frame goes from empty to in-band over 13 degrees of pitch. On the site that
 * shipped it delivers 0.1268 with hue entropy 1.90, against 0.1114 and 1.938
 * at the old -0.35, so the pitch is carrying the aim change and costing
 * essentially nothing. IT IS ALSO THE FALLBACK AND ONLY THE FALLBACK: when
 * `needleAim` finds a crest, `stagedView` takes the pitch DERIVED from that
 * crest instead, because -0.58 puts the frame's top edge at +4.3 deg and no
 * needle worth aiming at is that low.
 *
 * CANYON WALL, `eyeLift: 16, pitch: -0.25`, AND THE REJECTION IT REVERSES IS
 * RECORDED BECAUSE IT WAS RIGHT AT THE TIME. `eyeLift: 8, pitch: -0.25` was
 * measured once before and refused: it moved near-mass 0.927 -> 0.829 but
 * pushed the nearest neighbour the wrong way, Abyssal Plain 0.9870 -> 0.9953,
 * because lifting the eye in a 21.4 m contrast range traded near geometry for
 * fog and fog was exactly what it was being confused with. BOTH HALVES OF THAT
 * HAVE SINCE MOVED. Canyon Wall no longer shares Abyssal Plain's water - it
 * carries NEPHELOID, whose contrast range is 19.6 m against HADAL_SUSPENSION's
 * 21.4 in a NEUTRAL spectrum, and `canyon x abyssal` fell 0.9868 -> 0.9317 on
 * that change alone - and the framing term above has moved the anchor off the
 * site that was buried in the first place.
 *
 * THE LIFT IS NOT MONOTONE HERE AND THAT IS WHY IT IS 16. Delivered near-mass
 * against `eyeLift`, all at pitch -0.25: 8 -> 0.397, 12 -> 0.438, 14 -> 0.509,
 * 16 -> 0.172, 18 -> 0.089. It RISES to 14 because the eye climbs INTO the
 * banner that fills the right of the frame, and only clears it past 15 m. The
 * cost of clearing it is real and is recorded rather than hidden: dark mass
 * goes 0.374 at lift 12 to 0.000 at 16, and hue entropy 2.72 -> 1.97. 1.97 is
 * still well over the 1.399 tour baseline and the near-mass band is the stated
 * acceptance, so 16 is the trade this round takes.
 */
const STAGED_ARRIVAL = Object.freeze({
  7: Object.freeze({ eyeLift: null, pitch: -0.45 }),
  8: Object.freeze({ eyeLift: null, pitch: -0.58 }),
  10: Object.freeze({ eyeLift: 16, pitch: -0.25 }),
});

/**
 * THE PLAYFIELD IS A SQUARE AND THE WORLD IS A DISC, and the corners are outside
 * it. `WORLD.HALF_EXTENT` is 3072 m on each axis, so a corner sample sits at
 * radius 4344 - well past `HARD_BOUNDARY` (3050), where `collision.boundaryFactor`
 * has fully ramped and the solver pushes you back in. Scanning the raw square
 * put the Trench Floor anchor at radius 3271: a real trench floor, correctly
 * classified, in a place the world itself refuses to hold you.
 *
 * The gate is `SOFT_BOUNDARY` (2900) rather than `HARD_BOUNDARY`, because
 * boundaryFactor is a smoothstep BETWEEN the two - anything past the soft radius
 * is already being pushed, just less. An anchor should arrive in open world, not
 * on the ramp.
 */
const MAX_ANCHOR_RADIUS = WORLD.SOFT_BOUNDARY;

/** Scratch, so a scan of ~13,000 samples allocates nothing. */
const _w = new Float64Array(BIOME_COUNT);

/**
 * @typedef {object} BiomeAnchor
 * @property {number} id       biome id, equal to its index in BIOMES
 * @property {string} name     'Kelp Forest'
 * @property {string} short    'kelp'
 * @property {number} x        metres, east
 * @property {number} z        metres, south
 * @property {number} height   terrain height at (x, z); negative is underwater
 * @property {number} slope    gradient magnitude at (x, z)
 * @property {number} landformSlope gradient magnitude over a 64 m span
 * @property {number} weight   this biome's blend weight there, 0..1
 * @property {number} neighbourhood mean biome weight on a four-point 40 m ring
 * @property {number} nearDominance fraction of a 16-point 24 m disc this biome WINS
 * @property {number} yaw      curated compass heading for the arrival frame
 * @property {number} viewX    arrival x; always x, see stagedView
 * @property {number|null} viewY absolute arrival y of the FEET, or null to let
 *   teleport.js size the eye off the arrival column's own water
 * @property {number} viewZ    arrival z; always z
 * @property {number|null} pitch authored arrival pitch, or null for automatic ground framing
 * @property {boolean} dominant  true when this biome actually wins at (x, z)
 */

/**
 * Distance from a band's centre, 1 in the middle and 0 at or past either edge.
 *
 * Depth centredness prefers the middle of the record's OWN depth band over its
 * edges, which is what stops Coral Garden ([6, 44]) landing on its 6 m boundary
 * with Shallow Reef where both are marginal and the frame shows neither. Slope
 * centredness prefers the record's authored landform instead of flat ground,
 * over the 32 m epsilon rather than classification's 2 m.
 *
 * Reaching zero is an ELIGIBILITY failure and not a weak score: without the
 * rejection, a strong point weight still chose Rock Spires at 10 m on a 64 m
 * span slope of 0.065.
 *
 * @param {number} value @param {ReadonlyArray<number>} band [min, max]
 * @returns {number} 0..1
 */
function bandCentredness(value, band) {
  const span = band[1] - band[0];
  const t = span > 0 ? (value - band[0]) / span : 0.5;
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return 1 - Math.abs(2 * clamped - 1);
}

/** The `0.25 + 0.75x` floor: centredness must not overwhelm the other evidence. */
function bandTerm(centredness) {
  return 0.25 + 0.75 * centredness;
}

/**
 * Mean own-biome blend weight on the four cardinal points of the presentation
 * ring. Classification at each point uses its real 2 m slope. The centre's
 * weight is deliberately not included: `weight` already carries it.
 */
function ownBiomeWeight(terrain, id, x, z) {
  if (x * x + z * z > MAX_ANCHOR_RADIUS * MAX_ANCHOR_RADIUS) return 0;
  const h = terrain.sampleHeight(x, z);
  const s = terrain.sampleSlope(x, z);
  biomeWeights(_w, x, z, h, s);
  return _w[id];
}

function neighbourhoodWeight(terrain, id, x, z) {
  return (
    ownBiomeWeight(terrain, id, x + NEIGHBOUR_RADIUS, z) +
    ownBiomeWeight(terrain, id, x - NEIGHBOUR_RADIUS, z) +
    ownBiomeWeight(terrain, id, x, z + NEIGHBOUR_RADIUS) +
    ownBiomeWeight(terrain, id, x, z - NEIGHBOUR_RADIUS)
  ) * 0.25;
}

/**
 * Fraction of a `NEAR_FIELD_RADIUS` disc on which `id` is the biome that WINS.
 *
 * This asks a different question from `neighbourhoodWeight`, and the difference
 * is the point: the neighbourhood term averages the own-biome WEIGHT, so a ring
 * of samples that all score 0.45 for us and 0.55 for somebody else reads as a
 * healthy 0.45. What seats a foreign signature mesh is the ARGMAX, because that
 * is what `scatter.js` resolves per candidate before it runs the biome mask. So
 * this counts wins, not weight. See NEAR_FIELD_RADIUS for the measurement.
 *
 * @param {object} terrain @param {number} id @param {number} x @param {number} z
 * @returns {number} 0..1
 */
function nearFieldDominance(terrain, id, x, z) {
  let wins = 0;
  for (let s = 0; s < NEAR_FIELD_SPOKES; s++) {
    // Half-step the spokes so they never land on the four cardinal points the
    // neighbourhood ring already samples - two rings agreeing by construction
    // would make this term redundant on exactly the axes that matter least.
    const a = (s + 0.5) * 2 * Math.PI / NEAR_FIELD_SPOKES;
    const cx = Math.cos(a), cz = Math.sin(a);
    for (let r = 1; r <= NEAR_FIELD_RINGS; r++) {
      const d = NEAR_FIELD_RADIUS * r / NEAR_FIELD_RINGS;
      const px = x + cx * d, pz = z + cz * d;
      const h = terrain.sampleHeight(px, pz);
      biomeWeights(_w, px, pz, h, terrain.sampleSlope(px, pz));
      let top = -1, best = 0;
      for (let i = 0; i < BIOME_COUNT; i++) if (_w[i] > top) { top = _w[i]; best = i; }
      if (best === id) wins++;
    }
  }
  return wins / (NEAR_FIELD_SPOKES * NEAR_FIELD_RINGS);
}

/**
 * The distance at which contrast still survives in this column, metres.
 *
 * MUST STAY EQUAL TO `teleport.js`'s `arrivalOptics().range`. It is the same
 * derivation - against a target under the same ambient, signal is
 * exp(-sigmaT r) and single-scattered path radiance is
 * (sigmaS/sigmaT)(1 - exp(-sigmaT r)), so equal contrast sits at
 * ln(1 + sigmaT/sigmaS)/sigmaT - kept at the channel that holds it longest.
 * The anchor and the arrival would otherwise size the same frame with two
 * different rulers. Duplicated rather than imported because `teleport.js`
 * imports the entities, and this module is a pure terrain query the offline
 * suites load on its own.
 *
 * @param {object} water a `WATER_TYPES` row
 * @returns {number} metres
 */
function contrastRange(water) {
  let range = 0;
  for (let i = 0; i < 3; i++) {
    const r = Math.log(1 + water.sigmaT[i] / water.sigmaS[i]) / water.sigmaT[i];
    if (r > range) range = r;
  }
  return range;
}

const _burial = new Float64Array(LANDMARK_HEADINGS);
const _tower = new Float64Array(LANDMARK_HEADINGS);
/** The needle search's own profile: core burial and crest elevation per heading. */
const _core = new Float64Array(LANDMARK_HEADINGS);
const _crest = new Float64Array(LANDMARK_HEADINGS);

/**
 * Aim a landmark arrival at an isolated crest standing in the lamp's silhouette
 * band, or report that there is none.
 *
 * Marched on its own profile rather than on `framingView`'s, because the two
 * windows are different quantities and sharing them would move the other
 * thirteen anchors: the burial/tower pair is scaled by the water's contrast
 * range and this one by `PLAYER_LAMP.range`. See LANDMARK_CORE for the three
 * measured failures this replaces and LANDMARK_BIOMES for the band.
 *
 * @param {object} terrain @param {number} x @param {number} z
 * @param {number} eyeY absolute y of the arrival eye
 * @returns {{score: number, yaw: number, pitch: number}|null} null when no
 *   heading carries a needle this frame can hold
 */
function needleAim(terrain, x, z, eyeY) {
  const N = LANDMARK_HEADINGS;
  for (let k = 0; k < N; k++) {
    const yaw = k * 2 * Math.PI / N;
    const sx = Math.sin(yaw), sz = -Math.cos(yaw);
    let core = -Math.PI, crest = -Math.PI;
    for (let d = LANDMARK_NEAR_STEP; d <= LANDMARK_SILHOUETTE_NEAR; d += LANDMARK_NEAR_STEP) {
      const e = Math.atan2(terrain.sampleHeight(x + sx * d, z + sz * d) - eyeY, d);
      if (e > core) core = e;
    }
    for (let d = LANDMARK_SILHOUETTE_NEAR + LANDMARK_FAR_STEP;
      d <= LANDMARK_SILHOUETTE_FAR; d += LANDMARK_FAR_STEP) {
      const e = Math.atan2(terrain.sampleHeight(x + sx * d, z + sz * d) - eyeY, d);
      if (e > crest) crest = e;
    }
    _core[k] = core; _crest[k] = crest;
  }

  let bestScore = 0, bestK = -1;
  for (let k = 0; k < N; k++) {
    const crest = _crest[k];
    if (crest < LANDMARK_CREST_MIN || crest > LANDMARK_CREST_CAP) continue;
    // The subject is CENTRED, so the foreground that matters is the middle of
    // the frame and not its edges.
    let core = -Math.PI;
    for (let j = -LANDMARK_CORE; j <= LANDMARK_CORE; j++) {
      const i = ((k + j) % N + N) % N;
      if (_core[i] > core) core = _core[i];
    }
    if (core > LANDMARK_BURIAL_MAX) continue;
    // Isolation, not openness: how much of the frame stands WELL BELOW the
    // crest, which a wall fails and a needle passes wherever the eye line sits.
    let isolated = 0;
    for (let j = -LANDMARK_FAN; j <= LANDMARK_FAN; j++) {
      if (j === 0) continue;
      const i = ((k + j) % N + N) % N;
      if (_crest[i] < crest - LANDMARK_ISO_DROP) isolated++;
    }
    const quality = (isolated / (2 * LANDMARK_FAN))
      * bandCentredness(crest, [LANDMARK_CREST_MIN, LANDMARK_CREST_CAP]);
    const s = (1 / (1 + Math.max(0, core) / LANDMARK_BURIAL_REF))
      * (LANDMARK_NEEDLE_FLOOR + (1 - LANDMARK_NEEDLE_FLOOR) * quality);
    if (s > bestScore) { bestScore = s; bestK = k; }
  }
  if (bestK < 0) return null;
  return {
    score: bestScore,
    yaw: bestK * 2 * Math.PI / LANDMARK_HEADINGS,
    // The crest sits one headroom below the frame's own top edge, so the needle
    // is whole and the ground is still in the bottom of the picture.
    pitch: _crest[bestK] - LANDMARK_PITCH_HEADROOM,
  };
}

/**
 * How well this candidate FRAMES, and - for a landmark biome - which way to
 * look. The other half of "an anchor is a VIEW of a place".
 *
 * The instrument is one elevation profile per heading, taken from the arrival
 * eye and split at multiples of the column's own contrast range: a BURIAL
 * window inside `LANDMARK_NEAR_FRAC` and a TOWER window out to
 * `LANDMARK_FAR_FRAC`. A frame is aggregated over the 11 headings it actually
 * contains, because the 75 deg fovY at 2.11 aspect is +/- 58.3 deg horizontally
 * and the scan is 11.25 deg apart.
 *
 * TWO OUTPUTS, AND ONLY ONE OF THEM IS NEW ART DIRECTION.
 *
 *  - EVERY biome gets the burial term, `1/(1 + burial/LANDMARK_BURIAL_REF)`. It
 *    is the resolver's only defence against the failure the whole tour keeps
 *    reporting: G5 wants near-mass in [0.06, 0.20] and 10 of 12 underwater
 *    anchors miss it, mostly on the FULL side. Canyon Wall delivered 0.9339 with
 *    the eye 2.7 m off a slope climbing 135 m over the 200 m in front of it, and
 *    nothing in the old score could see that - `landformSlope` says a steep site
 *    is a GOOD Canyon Wall, which is true of the place and says nothing about
 *    the picture. It is a soft reciprocal rather than a cutoff on purpose:
 *    Canyon Wall's authored slope band is [0.60, 3.2], so EVERY candidate it has
 *    buries something, and a cutoff would score the whole biome zero and drop it
 *    to `bestWeightFallback`.
 *  - A LANDMARK biome additionally gets a heading, and it is resolved in TWO
 *    STAGES. `needleAim` runs first and wins whenever a needle is standing in the
 *    lamp's silhouette band, and it RETURNS BEFORE THE FAN IS MARCHED - the two
 *    profiles are independent, so marching one the winner never reads was 288
 *    `sampleHeight` calls per candidate for nothing, on the one biome whose score
 *    now pays for a framing pass at every coarse sample. When it finds none the
 *    arrival falls back to THE OPENEST FRAME - the crest inside the tower window
 *    ON THE AIMED HEADING times the fraction of the fan that stays BELOW the eye
 *    line - which is a second objective and not a broken first one: with no
 *    landmark to show, show the water. If neither qualifies it degrades to the
 *    burial term at the generic reveal, so a seed with no tower in reach still
 *    resolves.
 *
 * THE TOWER CREDIT COMES FROM THE AIMED HEADING AND NOT FROM THE FAN, and that
 * is a fix rather than a preference. `frameAt` aggregates `max` over +/-60 deg,
 * so the openest-frame branch could - and at the previously shipped anchor did -
 * take its entire tower credit from a heading 60 deg off the aim, at the very
 * edge of the frame, with four headings tied at 0.6417 and the tie broken by
 * index order. Burial and openness stay fan-wide because both are questions
 * about the WHOLE picture; the subject is not.
 *
 * @param {object} terrain @param {number} id @param {number} x @param {number} z
 * @param {number} height terrain height at (x, z) @param {number} slope 2 m slope
 * @returns {{score: number, yaw: number, pitch: (number|null)}} score in (0, 1],
 *   the arrival yaw, and a derived pitch when a needle was aimed at
 */
function framingView(terrain, id, x, z, height, slope) {
  const aimed = LANDMARK_BIOMES.includes(id);
  const water = waterTypeAt(x, z, height, Math.max(0, -height), slope, terrain);
  const range = contrastRange(water);
  // Same eye the arrival will use, so the elevation angles are the real ones.
  // Mirrors teleport.js's EYE_FRAC and its HOVER_EYE_MIN/MAX clamp.
  const eyeY = height + Math.min(6, Math.max(2, 0.125 * range));
  const nearEnd = LANDMARK_NEAR_FRAC * range;
  const farEnd = LANDMARK_FAR_FRAC * range;
  const step = Math.max(2, farEnd / LANDMARK_STEPS);
  const N = LANDMARK_HEADINGS;
  const generic = viewYaw(terrain, id, x, z);
  // A non-landmark biome only ever looks one way, so only that frame's own
  // eleven headings are profiled. Scanning all 32 for it would multiply this
  // function's cost by three for an answer nothing reads.
  const k0 = ((Math.round(generic * N / (2 * Math.PI)) % N) + N) % N;
  const first = aimed ? 0 : -LANDMARK_FAN;
  const last = aimed ? N - 1 : LANDMARK_FAN;
  for (let j = first; j <= last; j++) {
    const k = ((k0 + j) % N + N) % N;
    const yaw = k * 2 * Math.PI / N;
    const sx = Math.sin(yaw), sz = -Math.cos(yaw);
    let b = -Math.PI, t = -Math.PI;
    for (let d = step; d <= farEnd; d += step) {
      const e = Math.atan2(terrain.sampleHeight(x + sx * d, z + sz * d) - eyeY, d);
      if (d <= nearEnd) { if (e > b) b = e; } else if (e > t) t = e;
    }
    _burial[k] = b; _tower[k] = t;
  }

  /** The 11-heading aggregate of the frame centred on heading k. */
  const frameAt = (k) => {
    let burial = -Math.PI, tower = -Math.PI, open = 0;
    for (let j = -LANDMARK_FAN; j <= LANDMARK_FAN; j++) {
      const i = ((k + j) % N + N) % N;
      if (_burial[i] > burial) burial = _burial[i];
      if (_tower[i] > tower) tower = _tower[i];
      if (_tower[i] < 0) open++;
    }
    return { burial, tower, openFrac: open / (2 * LANDMARK_FAN + 1) };
  };
  const burialTerm = (burial) => 1 / (1 + Math.max(0, burial) / LANDMARK_BURIAL_REF);

  if (aimed) {
    const needle = needleAim(terrain, x, z, eyeY);
    if (needle) return needle;
    let bestScore = 0, bestYaw = 0;
    for (let k = 0; k < N; k++) {
      const f = frameAt(k);
      if (f.burial > LANDMARK_BURIAL_MAX || f.tower < LANDMARK_TOWER_MIN) continue;
      const s = Math.min(f.tower, LANDMARK_TOWER_CAP) / LANDMARK_TOWER_CAP * f.openFrac;
      if (s > bestScore) { bestScore = s; bestYaw = k * 2 * Math.PI / N; }
    }
    if (bestScore > 0) return { score: bestScore, yaw: bestYaw, pitch: null };
  }
  return { score: burialTerm(frameAt(k0).burial), yaw: generic, pitch: null };
}

const _normal = new Float64Array(3);

/** The teleport's deterministic downhill heading, plus per-biome art direction. */
function viewYaw(terrain, id, x, z) {
  terrain.sampleNormal(_normal, x, z);
  let yaw;
  if (Math.hypot(_normal[0], _normal[2]) > 1e-3) {
    yaw = Math.atan2(_normal[0], -_normal[2]);
  } else if (Math.hypot(x, z) > 1e-3) {
    // Flat-ground fallback faces the island, matching teleport.js.
    yaw = Math.atan2(-x, z);
  } else {
    yaw = 0;
  }
  return yaw + VIEW_YAW_OFFSET[id];
}

/**
 * The arrival pose for a proof point: where the eye stands and where it looks.
 *
 * THE CAMERA STAYS IN THE PROOF POINT'S OWN COLUMN, and that is the correction
 * this function carries. It used to walk the Rock Spires camera 72 m down the
 * 12 m-span normal and then hold it `height + 6` above the height of the point
 * it had walked AWAY from - so on ground that keeps descending, the eye ended
 * 62.6 m above the seabed under it, pitched 0.14 rad UP, and the delivered
 * frame was open water with a near-mass of exactly 0.0000 and no landform in
 * it at all. The eye height of a staged view must be measured at the eye, and
 * the cheapest way to guarantee that is not to move the eye: `teleport.js`
 * already sizes the height off the arrival column's own water and seabed.
 *
 * What survives the removal is the real insight - the pose that PROVES a biome
 * and the pose that PHOTOGRAPHS it are different - and it is now expressed as
 * an authored eye height and pitch (`STAGED_ARRIVAL`) rather than as a walk.
 * Nothing here is a baked coordinate: every number is relative to terrain
 * sampled at the current seed.
 */
function stagedView(terrain, id, x, z, height, framing) {
  // `framingView` already resolved the heading - the generic downhill reveal
  // for thirteen biomes, the tower it found for a landmark one - so re-deriving
  // it here would let the two disagree about the frame that was SCORED.
  const yaw = framing ? framing.yaw : viewYaw(terrain, id, x, z);
  // A DERIVED PITCH OUTRANKS THE AUTHORED ONE, and only `needleAim` produces
  // one. The authored value is a number tuned against a frame whose subject is
  // the water; a needle frame's pitch is a function of where the needle's crest
  // is, so it cannot be authored in advance and must not be overwritten by a
  // constant that was measured on a different picture.
  const aimedPitch = framing && framing.pitch !== null && framing.pitch !== undefined
    ? framing.pitch : null;
  const staged = STAGED_ARRIVAL[id];
  if (!staged) return { viewX: x, viewY: null, viewZ: z, yaw, pitch: aimedPitch };
  return {
    viewX: x,
    // FEET, not the eye: teleportTo's `y` is the player's position and the
    // camera sits PLAYER.EYE_HEIGHT above it.
    viewY: staged.eyeLift === null ? null : height + staged.eyeLift - PLAYER.EYE_HEIGHT,
    viewZ: z,
    yaw,
    pitch: aimedPitch !== null ? aimedPitch : staged.pitch,
  };
}

/**
 * Evaluate one sample against every biome and keep it if it beats that biome's
 * incumbent.
 *
 * `argmax(biomeWeights)` is used as the dominance test rather than a second
 * `biomeAt()` call, and that is exact rather than an approximation:
 * `biomeWeights` writes `(score - (top - BLEND_WINDOW))^2` for every score above
 * the cutoff and zero below, which is strictly increasing in the score over the
 * eligible set, so it preserves the argmax that `biomeAt` returns. Calling both
 * would run `scoreAll` twice for one answer.
 *
 * @param {object} terrain the terrain module
 * @param {number} x @param {number} z
 * @param {Array<BiomeAnchor|null>} best one slot per biome, mutated in place
 * @param {Float64Array} scores one slot per biome, mutated in place
 * @param {number} [only=-1] when >= 0, ignore the sample unless this biome is
 *   the one that dominates there - see the refine clause below
 * @param {Array<Array<object>>|null} [rescue=null] when given, a per-biome list
 *   of RESCUE SEEDS: every dominant sample a FLOOR rejects is recorded with the
 *   soft key `weight * bandTerm(depthCentred) * bandTerm(slopeCentred)` (the
 *   bandTerm floor of 0.25 keeps a zeroed centredness comparable instead of
 *   erasing the sample). Only the coarse pass passes this - see the rescue
 *   clause in resolveBiomeAnchors for why it exists and what it may not do.
 */
function considerSample(terrain, x, z, best, scores, only = -1, rescue = null) {
  // Gate here rather than in the loops, so no future caller can forget it.
  if (x * x + z * z > MAX_ANCHOR_RADIUS * MAX_ANCHOR_RADIUS) return;
  const height = terrain.sampleHeight(x, z);
  // NEVER omit this. biomeWeights defaults slope to 0, which is not a neutral
  // prior - it is the value that makes the flat records win, and it collapses
  // fourteen live biomes into eight. sampleSlope's own 2 m epsilon is the span
  // the chunk bake classifies over, so this asks the same question the mesh
  // under a jumped-to camera will answer.
  const slope = terrain.sampleSlope(x, z);
  biomeWeights(_w, x, z, height, slope);

  let top = -1;
  let dominant = 0;
  for (let i = 0; i < BIOME_COUNT; i++) {
    if (_w[i] > top) { top = _w[i]; dominant = i; }
  }

  // THE REFINE PASS MAY ONLY IMPROVE THE BIOME IT IS REFINING, and this is a
  // sampling correction rather than a policy. The coarse grid is uniform over
  // the whole playfield, so a cross-biome win there is fair; the refine grid is
  // 8 m and exists ONLY inside fourteen 128 m boxes, one around each biome's
  // coarse winner. Letting it also overwrite biome j's incumbent hands j a
  // point drawn from a biased sample - the neighbourhood of a DIFFERENT biome's
  // landform - that j's own neighbourhood never got the chance to beat.
  //
  // Measured: Canyon Wall's anchor was taken out of Rock Spires' refine box and
  // landed at (-1968, 928), 45 m from the Rock Spires anchor, so two menu
  // destinations photographed the same 50 m of world (hue x saturation cosine
  // 0.9748) and the Canyon Wall arrival was INSIDE the rock - near-mass 0.9977,
  // an abstract faceted blue surface with no horizon and no scale. Its own
  // coarse winner, 1.5 km away at (-2144, -800), scored 0.2826 and was simply
  // never refined. Restricting the refine moves exactly ONE anchor: 13 of 14
  // are byte-identical, and the resolve gets cheaper (315 -> 286 ms) because
  // the rejected samples no longer pay for a 32 m slope and a neighbour ring.
  if (only >= 0 && dominant !== only) return;
  const weight = _w[dominant];
  // BRANCH AND BOUND FROM HERE DOWN, AND IT IS EXACT RATHER THAN AN
  // APPROXIMATION. The score is a PRODUCT of factors that are each in [0, 1],
  // so the partial product after any prefix of them is an UPPER BOUND on the
  // final score, and a candidate that cannot beat the incumbent on the bound
  // cannot beat it at all. The argmax is therefore identical to the one an
  // eager evaluation finds, and the iteration order still fixes every tie.
  //
  // The factors are ordered CHEAPEST FIRST, and the ordering is worth about
  // half the resolve. Measured over the whole scan: 71,848 `sampleSlope` calls
  // at ~3.8 us each is 273 ms of a 435 ms resolve, and the neighbour ring alone
  // was 53,820 of them because it ran before anything could reject the sample.
  // The presentation terms are 16 samples (near-field disc) and up to 288
  // (framing fan) and would be 3x-100x this function's whole budget if they ran
  // on all 9,409 coarse samples.
  const b = BIOMES[dominant];
  if (weight < WEIGHT_FLOOR) return;
  const depthCentred = bandCentredness(-height, b.depth);
  if (depthCentred <= 0) {
    // Rescue key uses bandTerm(0) = 0.25 for BOTH un-passed terms rather than
    // computing the landform slope here: the 32 m sampleSlope is the cost the
    // branch-and-bound ordering exists to avoid, and a depth-rejected sliver
    // should rank below a slope-rejected basin anyway.
    if (rescue) recordRescue(rescue[dominant], x, z, weight * 0.25 * 0.25);
    return;
  }
  const landformSlope = terrain.sampleSlope(x, z, LANDFORM_SLOPE_EPS);
  const slopeCentred = bandCentredness(landformSlope, b.slope);
  if (slopeCentred <= 0) {
    if (rescue) recordRescue(rescue[dominant], x, z, weight * bandTerm(depthCentred) * 0.25);
    return;
  }
  const bound = weight * bandTerm(depthCentred) * bandTerm(slopeCentred);
  if (!(bound > scores[dominant])) return;
  const neighbourhood = neighbourhoodWeight(terrain, dominant, x, z);
  if (neighbourhood < NEIGHBOUR_FLOOR) {
    if (rescue) recordRescue(rescue[dominant], x, z, bound);
    return;
  }
  if (!(bound * neighbourhood > scores[dominant])) return;
  // THE AIM AND THE SCORE ARE SEPARATE PRIVILEGES, and Rock Spires holds
  // exactly one of them. `PRESENTATION_BIOMES` says whose SITE the two new
  // terms may move; `LANDMARK_BIOMES` says whose HEADING `framingView`
  // supplies. Rock Spires is in the second and not the first, so its anchor is
  // still chosen by the shipped score and only the direction it faces is new.
  // Giving it the score as well has now been tried TWICE and photographed once:
  // the first arrangement landed on a site with delivered hue entropy 1.056
  // against 1.938, and the second - `needleAim`'s score multiplied in - landed
  // on (1184, -2016), which has a real needle by the test and delivers an EMPTY
  // FRAME because there is no daylight behind it at 373 m. The comment above
  // `LANDMARK_HEADINGS` carries that measurement and the exhaustive search.
  const scored = PRESENTATION_BIOMES.includes(dominant);
  const aimed = LANDMARK_BIOMES.includes(dominant);
  let nearTerm = 1;
  if (scored) {
    nearTerm = nearFieldDominance(terrain, dominant, x, z) ** NEAR_FIELD_EXPONENT;
    if (!(bound * neighbourhood * nearTerm > scores[dominant])) return;
  }
  // Eleven biomes take neither, and for them this is the shipped resolver: no
  // fan is marched and the heading is the plain downhill reveal.
  const framing = scored || aimed
    ? framingView(terrain, dominant, x, z, height, slope)
    : null;
  const score = bound * neighbourhood * nearTerm * (scored ? framing.score : 1);
  if (!(score > scores[dominant])) return;
  scores[dominant] = score;
  const view = stagedView(terrain, dominant, x, z, height, framing);
  best[dominant] = {
    id: b.id, name: b.name, short: b.short,
    x, z, height, slope, landformSlope, weight, neighbourhood,
    // Reported for every anchor, scored for two. Filled in by the caller so an
    // unscored biome does not pay 16 classifications per candidate for a number
    // nothing multiplies.
    nearDominance: 0,
    dominant: true,
    ...view,
  };
}

/**
 * How many dominant-but-floor-rejected coarse samples each biome keeps as
 * rescue seeds, and the insertion that keeps them.
 *
 * THE RESCUE EXISTS BECAUSE A BIOME'S ELIGIBLE POCKETS CAN BE SMALLER THAN THE
 * COARSE PITCH, and Ossuary Flats is the measured case: its 285-365 m basins
 * are 40-80 m across inside rolling relief, so on the 64 m coarse lattice all
 * 33 of its dominant samples fail a floor (19 on landform slope, 11 on depth
 * centredness, 3 on the neighbourhood ring) while a 16 m sweep of the same
 * annulus finds 15 sites that pass every floor - the biome resolved
 * `dominant: false` purely because the refine stage, which exists for exactly
 * this sampling problem, only ever ran around a coarse WINNER. The rescue
 * gives a winnerless biome refine boxes around its NEAR-MISSES instead.
 *
 * WHAT IT MAY NOT DO: move any biome that has a coarse winner (it runs only
 * when `best[i]` is null after the normal passes), or weaken any floor (the
 * rescue refine calls the same considerSample with the same eligibility).
 * Measured on the default seed: the other fourteen anchors are byte-identical
 * with the rescue in and out, and the three seeds it ranks for Ossuary Flats
 * all carry a fully-passing site in their 128 m box ((2008,-824), (-1160,1816)
 * and (-888,-2104), keys 0.337 / 0.177 / 0.171 by the soft product).
 */
const RESCUE_SEEDS = 3;

function recordRescue(list, x, z, key) {
  if (list.length === RESCUE_SEEDS && key <= list[list.length - 1].key) return;
  let i = list.length;
  while (i > 0 && list[i - 1].key < key) i--;
  list.splice(i, 0, { x, z, key });
  if (list.length > RESCUE_SEEDS) list.pop();
}

/**
 * Fallback for a biome that dominates nowhere in the scan: the position where
 * its weight was highest, flagged `dominant: false`.
 *
 * It reports what it found rather than hiding the miss or throwing. A menu row
 * that says "Kelp Forest, weight 0.41, not dominant" is a usable destination AND
 * a bug report; a row that silently teleports you into Boulder Field is neither.
 *
 * @param {object} terrain @param {number} id
 * @returns {BiomeAnchor}
 */
function bestWeightFallback(terrain, id) {
  const half = WORLD.HALF_EXTENT;
  // -Infinity, not -1. The only way to reach this function is a biome whose
  // weight is 0 everywhere, and against a start of -1 with a strict `>` the
  // "winner" is then simply the first in-radius grid point - a coordinate with
  // nothing to do with the biome, returned under a docstring promising the
  // position where its weight was highest. This is a fallback whose entire job
  // is to be honest at a seed where the scan failed.
  let bx = 0, bz = 0, bh = 0, bs = 0, bw = -Infinity;
  for (let x = -half + COARSE_STEP * 0.5; x < half; x += COARSE_STEP) {
    for (let z = -half + COARSE_STEP * 0.5; z < half; z += COARSE_STEP) {
      if (x * x + z * z > MAX_ANCHOR_RADIUS * MAX_ANCHOR_RADIUS) continue;
      const height = terrain.sampleHeight(x, z);
      const slope = terrain.sampleSlope(x, z);
      biomeWeights(_w, x, z, height, slope);
      if (_w[id] > bw) { bw = _w[id]; bx = x; bz = z; bh = height; bs = slope; }
    }
  }
  const b = BIOMES[id];
  const landformSlope = terrain.sampleSlope(bx, bz, LANDFORM_SLOPE_EPS);
  const neighbourhood = neighbourhoodWeight(terrain, id, bx, bz);
  const nearDominance = nearFieldDominance(terrain, id, bx, bz);
  // No landmark aim on this path by construction: the biome wins nowhere, so
  // there is nothing to prove it is standing next to. The generic reveal is the
  // honest framing for a destination that is already reporting a miss.
  const view = stagedView(terrain, id, bx, bz, bh, null);
  return {
    id: b.id, name: b.name, short: b.short,
    x: bx, z: bz, height: bh, slope: bs, landformSlope, weight: bw,
    neighbourhood, nearDominance, ...view, dominant: false,
  };
}

/**
 * Find a representative position for every biome in the current terrain.
 *
 * Two passes: a fixed coarse grid over the whole playfield, then a local refine
 * around each biome's coarse winner. The refine matters because the coarse
 * pitch is 64 m and the terms it is optimising - slope, and distance from a
 * depth-band edge - both move faster than that. The refine is confined to the
 * biome it is refining; the reason is in `considerSample`, and it is about the
 * refine grid being a biased sample rather than about art direction.
 *
 * Deterministic: fixed bounds, fixed iteration order, no RNG and no clock. It is
 * a read-only query, so it cannot perturb generation either way.
 *
 * @param {object} terrain the terrain module (`sampleHeight`, `sampleSlope`),
 *   passed rather than imported so a caller cannot accidentally scan a different
 *   seed than the one it holds
 * @returns {ReadonlyArray<BiomeAnchor>} one entry per biome, ordered by id
 */
export function resolveBiomeAnchors(terrain) {
  const half = WORLD.HALF_EXTENT;
  const best = new Array(BIOME_COUNT).fill(null);
  const scores = new Float64Array(BIOME_COUNT);

  const rescue = Array.from({ length: BIOME_COUNT }, () => []);
  for (let x = -half + COARSE_STEP * 0.5; x < half; x += COARSE_STEP) {
    for (let z = -half + COARSE_STEP * 0.5; z < half; z += COARSE_STEP) {
      considerSample(terrain, x, z, best, scores, -1, rescue);
    }
  }

  for (let i = 0; i < BIOME_COUNT; i++) {
    const seed = best[i];
    if (!seed) continue;
    const cx = seed.x, cz = seed.z;
    for (let dx = -REFINE_RADIUS; dx <= REFINE_RADIUS; dx += REFINE_STEP) {
      for (let dz = -REFINE_RADIUS; dz <= REFINE_RADIUS; dz += REFINE_STEP) {
        const x = cx + dx, z = cz + dz;
        if (x < -half || x > half || z < -half || z > half) continue;
        considerSample(terrain, x, z, best, scores, i);
      }
    }
  }

  // RESCUE REFINE - only for a biome the coarse pass left with NO winner, so
  // it cannot move any existing anchor by construction. Same refine grid, same
  // considerSample, same floors; the only new thing is where the boxes sit.
  // See RESCUE_SEEDS above for the measurement that forced this stage.
  for (let i = 0; i < BIOME_COUNT; i++) {
    if (best[i]) continue;
    for (const seed of rescue[i]) {
      for (let dx = -REFINE_RADIUS; dx <= REFINE_RADIUS; dx += REFINE_STEP) {
        for (let dz = -REFINE_RADIUS; dz <= REFINE_RADIUS; dz += REFINE_STEP) {
          const x = seed.x + dx, z = seed.z + dz;
          if (x < -half || x > half || z < -half || z > half) continue;
          considerSample(terrain, x, z, best, scores, i);
        }
      }
    }
  }

  for (let i = 0; i < BIOME_COUNT; i++) {
    if (!best[i]) best[i] = bestWeightFallback(terrain, i);
    // Fourteen calls, once, for the record. `considerSample` only pays for it
    // on the biomes whose score actually multiplies it.
    best[i].nearDominance = nearFieldDominance(terrain, i, best[i].x, best[i].z);
    Object.freeze(best[i]);
  }
  return Object.freeze(best);
}

/** Cached result and the seed it was resolved against. */
let _cache = null;
let _cacheSeed = -1;

/**
 * Cached `resolveBiomeAnchors`, re-resolved whenever the world seed changes.
 *
 * Keyed on the seed rather than computed once, because a stale table is the
 * failure this module exists to prevent - and `terrain.setSeed()` is reachable
 * from the console and from the offline suites.
 *
 * @param {object} terrain the terrain module
 * @returns {ReadonlyArray<BiomeAnchor>}
 */
export function getBiomeAnchors(terrain) {
  const seed = terrain.getSeed();
  if (_cache && _cacheSeed === seed) return _cache;
  _cache = resolveBiomeAnchors(terrain);
  _cacheSeed = seed;
  return _cache;
}

/** Drop the cache. For tests that re-seed and want the cost measured again. */
export function invalidateBiomeAnchors() {
  _cache = null;
  _cacheSeed = -1;
}
