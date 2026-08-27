#!/usr/bin/env node
/**
 * SUBWAVE in-browser QA harness (headless Chrome, no dependencies).
 *
 * Static checks cannot tell us whether a shader compiles, whether the ocean is
 * actually drawn, or whether the frame is black. This drives a real Chrome via
 * the DevTools Protocol over a raw WebSocket (hand-rolled, since we ship no
 * dependencies) and reports what the game really does:
 *
 *   - every console error and every WebGPU validation message
 *   - whether boot completed, and how long each stage took
 *   - a screenshot per scenario, with a pixel histogram so "it rendered
 *     something" is a measured claim rather than an assumption
 *   - frame timing over a sample window
 *
 * Usage:
 *   node tools/qa.mjs                    run all scenarios
 *   node tools/qa.mjs --scenario surface  run one
 *   node tools/qa.mjs --keep-open        leave Chrome running for inspection
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * Pick a free TCP port.
 *
 * These tools launch a dev server and a Chrome debug endpoint. With fixed
 * ports, two runs at once (several agents verifying in parallel, or a manual
 * run alongside CI) collide and fail with an opaque connection error. Asking
 * the OS for an ephemeral port makes concurrent runs safe.
 */
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'qa-output');
let PORT = 0;   // assigned from freePort()
let CDP_PORT = 0;   // assigned from freePort()

const args = process.argv.slice(2);
const KEEP_OPEN = args.includes('--keep-open');
const ONLY = args.includes('--scenario') ? args[args.indexOf('--scenario') + 1] : null;
const HEADED = args.includes('--headed');

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

/**
 * Scenarios teleport the camera and set world state, then screenshot.
 * Each `setup` runs inside the page with `subwave` (the Game instance) and the
 * `qa` helper (installed by INSTALL_HELPER below) in scope.
 *
 * ALWAYS PLACE THE EYE WITH qa.place(), NEVER WITH camera.setEuler(). The player
 * owns the camera - Player.applyCamera() overwrites the camera's orientation from
 * the player's quaternion every single frame - so setEuler() on an on-foot
 * scenario is silently discarded and the shot comes out pointing wherever the
 * PREVIOUS scenario left the player. That is not a hypothetical: 'reef-floor'
 * asked for yaw 0.8 and a 31 degree look down at the seabed, and every frame it
 * ever produced was a level view on heading 137 inherited from
 * 'underwater-shallow'.
 *
 * And FREEZE BEFORE THE WATER MOVES YOU. A submerged diver is positively buoyant
 * above PLAYER neutral depth, so any scenario that teleports underwater and then
 * lets the simulation run has a few hundred milliseconds to rise before the
 * screenshot. Pausing in the same tick as the teleport keeps the eye exactly
 * where the scenario put it; terrain and scatter still stream while paused, so
 * nothing is lost by it.
 */
const SCENARIOS = [
  {
    id: 'spawn',
    name: 'What the player actually sees on spawn',
    setup: `
      subwave.worldClock.setDayFraction(0.32);
      const p = subwave.spawn.position;
      qa.place(p[0], p[1], p[2], subwave.spawn.shoreBearing, -0.06);
      setTimeout(() => subwave.setPaused(true), 900);
    `,
    expect: { minBrightness: 0.05, maxBlackFraction: 0.55 },
  },
  {
    id: 'vessel-on-beach',
    name: 'The vessel, parked where the player walks to it',
    setup: `
      subwave.worldClock.setDayFraction(0.32);
      const v = subwave.vessel.position, b = subwave.spawn.shoreBearing;
      qa.place(v[0] - Math.sin(b) * 9, v[1] + 1, v[2] + Math.cos(b) * 9, b, -0.12);
      setTimeout(() => subwave.setPaused(true), 900);
    `,
    expect: { minBrightness: 0.03 },
  },
  {
    id: 'underwater-shallow',
    name: 'Shallow reef, 8 m down',
    setup: `
      subwave.worldClock.setDayFraction(0.5);
      qa.place(0, -8, 240, 1.2, -0.15);
      // The near-field creature director seeds animals over the first ten-odd
      // seconds in the water. Freezing in the same tick as the placement made
      // this scenario incapable of photographing a fish however well the
      // director worked - which is exactly the class of measurement bug the
      // notes at the top of this file exist to prevent.
      await qa.hold(13);
      await qa.freeze();
    `,
    // expectWaterType was added to the four pre-existing underwater scenarios
    // after the fact, and it is not decoration: all four ran green through the
    // entire life of the waterTypeAt() slope defect, which is what let an
    // authored water type be absent from the game without a red check. The
    // lagoon classifies OCEANIC_CLEAR under the old rule and the new one alike -
    // that is exactly why these four are unchanged and are worth pinning.
    expect: { minBrightness: 0.02, maxBlackFraction: 0.6, expectBlueDominant: true,
      minDepth: 5, maxDepth: 8, expectWaterType: 'OCEANIC_CLEAR' },
  },
  {
    id: 'reef-floor',
    name: 'Close on the reef floor - is anything actually growing there?',
    setup: `
      subwave.worldClock.setDayFraction(0.4);
      // Hover EYE_ABOVE_FLOOR metres over the lagoon floor and look DOWN at it.
      // None of the other scenarios point at the floor, so scatter could be
      // entirely absent and every one of them would still pass.
      //
      // The flattest candidate wins, not the shallowest: a 2 m hover over a 30
      // degree slope buries the near half of the frame in a wall of rock, which
      // is not what "close on the reef floor" is meant to show. The depth band is
      // narrow so the camera's own depth is predictable and the expectations
      // below can bracket it - that bracket is the whole point, because the
      // failure this scenario used to have was floating silently to the surface
      // and photographing open water while claiming to photograph the seabed.
      const T = await import('/src/world/terrain.js');
      const EYE_ABOVE_FLOOR = 4.0;
      let best = null;
      for (let i = 0; i < 1200; i++) {
        const a = i * 2.39996323, r = Math.sqrt(i / 1200) * 300;
        const x = Math.cos(a) * r, z = 240 + Math.sin(a) * r;
        const h = T.sampleHeight(x, z);
        if (h < -8.5 || h > -5.5) continue;
        const slope = T.sampleSlope(x, z);
        if (!best || slope < best.slope) best = { x, z, h, slope };
      }
      if (!best) throw new Error('no lagoon floor between 5.5 m and 8.5 m down');
      // qa.place takes the FEET; the eye is currentEyeHeight above them.
      qa.place(best.x, best.h + EYE_ABOVE_FLOOR - subwave.player.currentEyeHeight,
               best.z, 0.8, -0.55);
      // Same reason as 'underwater-shallow': this scenario asks "is anything
      // actually growing there?", and the animals are half the answer.
      await qa.hold(13);
      await qa.freeze();
    `,
    // The eye is 4 m over a floor 5.5-8.5 m down, so 1.5-4.5 m of water over it.
    expect: { minBrightness: 0.02, expectBlueDominant: true,
      minDepth: 1.3, maxDepth: 4.7, expectWaterType: 'OCEANIC_CLEAR' },
  },
  {
    id: 'underwater-deep',
    name: 'Twilight zone, 120 m down',
    // WHY IT MOVED 2026-08-18. The station lived at (455, 1926) - r ~1980,
    // 2 m outside the Platter Forest's (biome 17) new r 1540-1960 annulus at
    // a depth (118 m) inside its 88-124 band, and the record's radius
    // feather handed the column to PLATTER_TEAL: the scenario photographed a
    // biome instead of generic open twilight and the water pin fired exactly
    // as designed. Re-picked from an offline sweep (waterTypeAt over a
    // 2-degree/30 m polar grid, OCEANIC_CLEAR required at the point AND
    // across a 24 m neighbourhood so a terrain nudge cannot flip it):
    // (-1940, 342), seabed -123.2 m, slope 0.23.
    setup: `
      subwave.worldClock.setDayFraction(0.5);
      qa.place(-1940, -120, 342, 1.2, -0.25);
      await qa.freeze();
    `,
    // Auto-exposure deliberately normalises the displayed image, so depth is
    // asserted on the PRE-exposure scene radiance, which is the physical claim.
    //
    // OCEANIC_CLEAR here is a load-bearing pin, not a formality: a column
    // this deep that classifies as a green shallow type loses its surviving
    // daylight by orders of magnitude (the pre-move comment recorded a
    // measured 3.4-million-fold green blackout for exactly that switch), and
    // every other expectation would pass through it. biomes.js's column
    // ceiling is what keeps it OCEANIC_CLEAR, and this line is the guard.
    expect: { expectBlueDominant: true, minDepth: 100, maxSceneLuminance: 3.0,
      expectWaterType: 'OCEANIC_CLEAR' },
  },
  {
    id: 'abyss',
    name: 'Abyssal dark, 700 m down (should be near black without lights)',
    setup: `
      subwave.worldClock.setDayFraction(0.5);
      qa.place(2394, -700, -1388, 1.2, -0.25);
      await qa.freeze();
    `,
    // Below TRUE_DARK_DEPTH no sunlight remains; with no lamps on, the scene
    // radiance before exposure must be essentially nothing.
    //
    // THE NAME IS A DEPTH, NOT A BIOME, AND IT IS NOT THE ABYSSAL PLAIN.
    // Measured offline against the shipped classifier (setSeed(DEFAULT_SEED),
    // real sampleSlope): this column is Trench Wall 0.537 / Canyon Wall 0.463
    // over a seabed at -750.5 m, and Abyssal Plain has no weight in it at all.
    // The station is left where it is on purpose - it is 700 m of unlit water,
    // which is the only thing this scenario asserts - but do not reach for it as
    // "the plain", and do not use its brightness as an acceptance metric:
    // CLAUDE.md records the abyss frame's 0.0056 as the depth grade's black
    // lift on a scene value of zero, i.e. a constant that the glow pass being on
    // or off does not move.
    expect: { minDepth: 600, maxSceneLuminance: 0.02, expectWaterType: 'ABYSSAL_VOID' },
  },
  {
    id: 'cockpit',
    name: 'In the vessel, cockpit HUD visible',
    setup: `
      subwave.worldClock.setDayFraction(0.35);
      subwave.vessel.position.set([0, 40, 240]);
      subwave.player.inVessel = true;
      subwave.vessel.setLightGroup?.('flood', true);
      setTimeout(() => subwave.setPaused(true), 900);
    `,
    expect: { minBrightness: 0.04 },
  },
  {
    id: 'cockpit-turning',
    name: 'Cockpit MID-TURN - the view must be an unobstructed window',
    // The cockpit only works because back-face culling hides it: the eye sits inside
    // the hull and inside the canopy, so both present back faces and vanish
    // (passes/entities.js). But the NACELLES are outside the hull, about 42 degrees
    // off the eye axis against a 37 degree half-FOV - just barely out of frame. Any
    // camera rotation away from the hull's own heading swings them in, and with the
    // hull back-face culled they appear as parts floating in mid-air with nothing
    // joining them. This scenario holds the aim well off the hull heading, which is
    // what a hard turn does, and looks.
    setup: `
      subwave.worldClock.setDayFraction(0.35);
      subwave.vessel.position.set([0, 40, 240]);
      subwave.player.inVessel = true;
      subwave.vessel.board();
      subwave.vessel.setLightGroup?.('flood', true);
      // Let the scene stream, then force the aim 50 degrees off the hull's heading
      // in the same tick as the pause, so the offset is guaranteed to be there when
      // the shutter opens rather than depending on how fast the hull turned.
      const { quat } = await import('/src/core/math.js');
      quat.identity(subwave.vessel.orientation);
      quat.copy(subwave.vessel.prevOrientation, subwave.vessel.orientation);
      setTimeout(() => {
        subwave.vessel.aimYaw = 0.873;
        subwave.vessel.prevAimYaw = 0.873;
        subwave.setPaused(true);
      }, 900);
    `,
    expect: { minBrightness: 0.04 },
  },
  {
    id: 'night',
    name: 'Night at the surface, moons and stars',
    setup: `
      subwave.worldClock.setDayFraction(0.0);
      qa.place(0, 6, 240, 0.5, 0.35);
      setTimeout(() => subwave.setPaused(true), 900);
    `,
    // Night is dim in absolute terms; exposure lifts it, so assert on the scene.
    expect: { maxSceneLuminance: 1.5 },
  },
  // -------------------------------------------------------------------------
  // The two below are the first scenarios that leave the lagoon on purpose.
  //
  // Every scenario above this line sits within about 300 m of the origin and 8 m
  // of the surface, which is a lot of coverage of one reef and none at all of
  // the rest of the map. Kelp beds, the shelf break, the spires and the trench
  // were all generated, none of them had ever been in a frame, and a whole water
  // type was missing from the game without any shot being able to notice.
  //
  // Nothing above was MOVED. The eight lagoon shots are the regression baseline
  // for the beach, the vessel, the cockpit and the reef, and a scenario that
  // moves stops being comparable with its own history.
  // -------------------------------------------------------------------------
  {
    id: 'kelp-forest',
    name: 'The emerald kelp basin - giant trunks, gold fruit and a deep seabed',
    // RE-SITED 2026-08-18 (emerald rebuild, terrain phase): the biome moved
    // onto the carved kelp basin (terrain.js LAYER 9.5; record depth
    // [56, 170], r 1050-1950), so the old chunk (5,6) station at 39 m is no
    // longer kelp ground. The new station is basin interior: floor -106.5,
    // 33 kelp within 15 m / 217 within 45 m at the default seed, water
    // KELP_EMERALD through the real smoothing path. The old siting story is
    // kept below for the method - the census guard is unchanged and fired
    // for exactly the reason its message names.
    // WHY HERE, AND WHY IT MOVED 2026-08-18. The station lived at chunk
    // (-7,-9), (-835, -1093), from its first commit - and that point is
    // r ~1375, inside the Bulb Grove's (biome 16) new r 1250-1520 annulus,
    // whose record full-fits 14-30 m x slope <= 0.55 ground the kelp bed had
    // only ever held on a partial fit (this comment used to quote kelp
    // weight 0.514 there, i.e. never a full fit; kelp's own depth floor has
    // been 28 m since the Crimson Meadow cession). The census guard below
    // fired exactly as designed - 7 kelp within 15 m against a floor of 15 -
    // and the fix is the one its message names: re-pick from a census.
    //
    // The station is now chunk (5,6): 473 kelpStalk + 22 kelpGiant, the
    // densest shallow bed within r 520-1240 (scanned offline over the whole
    // belt with generateScatterForChunk at the default seed), 917 m from
    // spawn. At the pinned point (672, 864) the seabed is -42.6 m, slope
    // 0.37, kelp is the dominant record at weight 0.45, waterTypeAt returns
    // COASTAL_GREEN through the real smoothing path, and 54 kelp stand
    // within 15 m / 253 within 45 m.
    //
    // The eye lands at about 39 m: inside kelp's authored [28, 78] band, and
    // COASTAL_GREEN's column ceiling (87.2 m since 2ba914e re-authored the
    // type) clears the -42.6 m seabed with 44 m of margin. The ceiling is
    // keyed on the column and not on the eye, so swimming up or down inside
    // this bed cannot change the answer - only leaving it can.
    //
    // Pitch -0.16 puts the seabed in the lower third. Level-pitch framings of
    // this bed come back with no ground in the frame at all, because 24 m of
    // Jerlov 3C water is 8.8 optical depths of green and the far seabed is
    // simply not there to be photographed.
    setup: `
      subwave.worldClock.setDayFraction(0.32);
      subwave.player.lampOn = false;
      // COUNT THE KELP BEFORE PHOTOGRAPHING IT. Every expectation below is
      // satisfied by empty green water at this station - measured, with
      // scatterPass.execute nulled so that not one stalk, blade or rubble plate
      // was drawn, the frame moved 0.9% in luminance and all six passed. A
      // scenario named for its content has to fail when the content is not
      // there, and this is the half of that which does not depend on the
      // renderer: generateScatterForChunk is a pure function of (cx, cz, lod)
      // and the seed, so it answers "is the bed still here" directly.
      //
      // The radius stays 15 m from the station's Jerlov-3C days (visibility
      // is 50.8 m since the clarity passes, so the count is now conservative
      // twice over). Measured at the 2026-08-18 station: 54 kelp within
      // 15 m, 78 within 20 m, 253 within 45 m, out of chunk (5,6)'s 473
      // kelpStalk + 22 kelpGiant. The floor is 15, so the bed can lose 72%
      // of itself before this trips - and a landform or BIOME change that
      // moves the ground out from under it fails LOUDLY here rather than
      // silently shipping a picture of water, which is precisely how the
      // Bulb Grove's arrival was caught. qa.mjs treats a setup throw as a
      // hard failure.
      const S = await import('/src/world/scatter.js');
      const CS = (await import('/src/core/constants.js')).WORLD.CHUNK_SIZE;
      const EX = -732, EZ = 1005, RAD = 15, FLOOR = 15;
      const kelpIds = S.SCATTER_TYPES.filter((t) => /kelp/i.test(t.key)).map((t) => t.id);
      let kelpNear = 0;
      for (let cx = Math.floor((EX - RAD) / CS); cx <= Math.floor((EX + RAD) / CS); cx++) {
        for (let cz = Math.floor((EZ - RAD) / CS); cz <= Math.floor((EZ + RAD) / CS); cz++) {
          const sc = S.generateScatterForChunk(cx, cz, 0);
          for (const id of kelpIds) {
            for (let i = sc.firstByType[id]; i < sc.firstByType[id] + sc.countsByType[id]; i++) {
              const x = cx * CS + sc.instances[i * 16 + 3];
              const z = cz * CS + sc.instances[i * 16 + 11];
              if ((x - EX) ** 2 + (z - EZ) ** 2 <= RAD * RAD) kelpNear++;
            }
          }
        }
      }
      if (kelpNear < FLOOR) {
        throw new Error('kelp-forest station has ' + kelpNear + ' kelp within ' + RAD +
          ' m, floor ' + FLOOR + ' - the bed moved; re-pick the station from a census');
      }
      qa.place(-732, -103, 1005, 1.571, -0.16);
      // Long, for three separate reasons: the chunk is 917 m outside the
      // streamed lagoon and needs LOD-0 terrain AND the scatter pass to arrive;
      // the near-field creature director seeds over the first ten-odd seconds;
      // and renderer.env.waterType is SPRUNG at RENDER.WATER_BLEND_TAU = 2 s, so
      // the column needs several time constants or the shot is photographed
      // through the previous scenario's water.
      await qa.hold(15);
      await qa.freeze();
    `,
    // COASTAL_GREEN is the claim this scenario exists to hold, and it is
    // asserted twice over on purpose - once on the classification and once on
    // the pixels, because the two failed independently before. waterTypeAt()
    // used to classify the seabed with the slope forced to 0, which made the
    // flat biomes win and returned REEF_TURQUOISE here; and a correct
    // classification still has to survive the spring, the composite and the
    // grade to reach the frame. Green over blue is the physical signature:
    // COASTAL_GREEN's Kd is [0.2310, 0.0754, 0.0900] (re-authored by 2ba914e;
    // this comment used to quote the Jerlov-3C column), so over the 2026-08-18
    // station's 42.6 m column green outruns blue by
    // exp((0.0900 - 0.0754) * 42.6) = 1.9x. A blue-dominant frame here is not
    // this water.
    //
    // Nothing in this frame is unlit - noon sun, a seabed 3.5 m under the eye,
    // no cave and no shadowed volume - so the only dark pixels available are the
    // HUD panel, which is 2.6% of the canvas.
    //
    // minVisibleScatter is the other half of the content assertion the census in
    // the setup starts: the census proves the bed EXISTS, this proves the pass
    // DREW it. They fail independently - a chunk that never streamed, a scatter
    // pass that culled everything and a bed that moved are three different bugs -
    // and neither of them was covered when this scenario first shipped. Measured
    // here: 15,627 instances drawn out of 24,530 resident, so the floor of 5,000
    // is a 3.1x margin against a run-to-run wobble in which chunks have streamed,
    // and still fails hard on a scatter pass that draws nothing.
    //
    // KNOW WHAT IT CANNOT SEE. stats.visibleInstances is written INSIDE the
    // scatter pass's execute(), so a pass that never runs leaves the previous
    // frame's count standing: measured, replacing scatterPass.execute with a
    // no-op leaves this reading 15,627 while the plants are gone from the
    // picture, and the frame's own luminance moves 0.9% (0.3801 -> 0.3765),
    // which is why no pixel test can stand in for it either. That failure mode
    // is covered by the census in the setup instead, which asks the generator
    // directly and never touches the renderer.
    // KELP_EMERALD since the emerald rebuild: green outruns blue by
    // exp((0.0250 - 0.0182) * 103) = 2.0x over the station's column, so
    // green dominance is still the physical signature. Depth band moved
    // with the basin re-site. minVisibleScatter drops 5000 -> 2000: the
    // basin bed is fewer, far larger plants (giants are 150/chunk capped
    // against the old stalk row's 900).
    expect: { minBrightness: 0.03, maxBlackFraction: 0.10, expectGreenDominant: true,
      minDepth: 100, maxDepth: 106, expectWaterType: 'KELP_EMERALD',
      minVisibleScatter: 2000 },
  },
  {
    id: 'trench-wall',
    name: 'The trench wall at 900 m - a rock face rising past the eye',
    // THE STATION IS SEARCHED, NOT WRITTEN DOWN, AND THAT IS THE 2026-08-05
    // REPAIR. Read this before touching the coordinates, because the two things
    // that went wrong here went wrong QUIETLY and in opposite directions.
    //
    // 1. THE ASSERTION BROKE ON A COIN FLIP. The shipped station was the literal
    //    (2262, -900, 1728), and measured offline against the real classifier
    //    (terrain.setSeed(WORLD.DEFAULT_SEED), waterTypeAt with the real
    //    sampleSlope) that column blends Canyon Wall 0.500 / Trench Wall 0.500 -
    //    an exact tie, resolved only by waterTypeAt's `w <= bestW` keeping the
    //    FIRST maximum, i.e. by the lower biome index. It cost nothing while both
    //    biomes carried ABYSSAL_VOID. The moment Canyon Wall was moved to
    //    HADAL_SUSPENSION the same tie began returning the other water and this
    //    scenario went red - correctly, which is why the assertion stays. But
    //    RE-STRINGING it to HADAL_SUSPENSION would have pinned a committed check
    //    to a float tie between two biomes, where one ULP of feather anywhere
    //    flips it back and the failure reads as a colour bug.
    // 2. THE FACE IT WAS FRAMED ON NO LONGER EXISTS. The original comment
    //    measured a 157 m step at z = 1728 (seabed -844 m at x = 2210, -1001 m at
    //    x = 2220) and stood the eye 42 m off it. Re-measured today on the same
    //    transect the seabed runs -957 / -947 / -941 / -925 / -916 / -918 / -922
    //    / -925 / -929 m across x = 2180..2260: the rim was smoothed by the
    //    2026-08-03 trench-tear fix and what is left is an undulating floor with
    //    a 28 m eye clearance. The BEFORE screenshot agrees - a featureless blue
    //    field with an unbounded lamp bloom in the middle of it and no
    //    silhouette anywhere. The scenario had been photographing open water
    //    under a name that promised a wall, and every check in it stayed green.
    //
    // So the station is derived from the terrain the way `reef-floor`'s is, and
    // for the stronger version of the same reason: a literal coordinate in a
    // world that is regenerated by every terrain change is a claim with no
    // guarantor. The search asks for the two things the scenario's name promises
    // - Trench Wall DOMINANT rather than tied, and rock that rises past the eye
    // close enough to fill the frame - and throws rather than photographing
    // whatever is there if it cannot find both.
    //
    // Measured on today's seed the search settles on (2080, 1640) looking due
    // north, 2.6 km from spawn: Trench Wall 0.997 against 0.003 (margin 0.994,
    // not 0.000), floor -944 m at the eye and -993 m sixty metres behind it, and
    // a face that climbs -944 / -930 / -922 / -910 / -888 / -878 / -870 m over
    // the first 60 m, crossing the eye's own -900 m at 35 m out and reaching
    // -805 m at 120 m.
    //
    // THAT IS A RAMP, NOT THE NEAR-VERTICAL RIM THE OLD COMMENT DESCRIBED, AND
    // THE NAME SHOULD NOT PROMISE MORE THAN THE GENERATOR MAKES. Surveyed on a
    // 20 m grid over x 1600..2700, z 1000..2600, restricted to seabed below
    // -820 m: the largest seabed rise over a 10 m step anywhere in the deep
    // south-east is 29 m, and the four steepest are all in Canyon Wall's blend.
    // There is no near-vertical face left down there to photograph.
    //
    // AND THE FACE STILL DOES NOT READ IN THE PICTURE. Stated here because a
    // green scenario that photographs an invisible wall is exactly the failure
    // this file keeps rediscovering. In the delivered frame the rock is a
    // gradient; what is legible is the emissive scatter growing ON it - a
    // cluster of glow pods and crystal spires along the top of the frame where
    // the wall rises, which is a real and readable improvement over the old
    // station's empty water, and is still not a lit rock face. The cause is
    // recorded in the plan and is not qa.mjs's to fix: below 95 m every shadow
    // cascade is switched off, the suit lamp is the only directional light in
    // the game, and against a 0.023-0.031 rock albedo the in-scatter along the
    // sight path outweighs the reflected lamp. Re-shoot this frame when the deep
    // key lands; do not re-frame it until then, and do not add a brightness
    // threshold that a lamp bloom on empty water would satisfy.
    //
    // THIS IS NOT THE CAVE SCENARIO IT WAS ASKED TO BE, AND THE REASON IS THAT
    // THERE IS NOTHING IN A CAVE TO PHOTOGRAPH. The geometry is real -
    // world/caves.js generates it, and caves.isInsideCave(-676, -69.4, 172) is
    // true inside a chamber that admits an 8 m sphere - but caves.js is imported
    // by NOTHING under src/: world/chunks.js, main.js and
    // render/passes/index.js contain the string 'cave' zero times, and the
    // IN_CAVE flag declared in render/renderer.js and shaders/common/frame.wgsl
    // is never written and never read. Cave geometry is therefore never meshed,
    // never drawn and never collided. Placed in that chamber the camera
    // photographs a flat pale-blue field - 56 m inside solid rock, looking at
    // open water, because the heightfield's underside is back-face culled. A
    // scenario that shipped that frame would be a stub asserting nothing.
    //
    // So this photographs the enclosed dark rock that DOES exist. The trench in
    // the south-east is a designed ravine (terrain.js TERRAIN_LAYERS' quintic
    // wall profile) and its flanks still rise 139 m over the 120 m in front of
    // the eye, which is the enclosure this scenario is for.
    //
    // It is the regression guard for the one thing nothing else covers: that
    // terrain streams and meshes 2.6 km from spawn at all. It is NO LONGER the
    // counter-evidence to "the map has no walls" that the first draft claimed -
    // the wall is in the heightfield and not in the picture, and a claim about
    // the image has to be settled by the image.
    setup: `
      subwave.worldClock.setDayFraction(0.32);
      const T = await import('/src/world/terrain.js');
      const B = await import('/src/world/biomes.js');
      // The eye altitude is the fixed quantity - the depth bracket below is
      // asserted against it - and everything else is searched around it.
      //
      // STANDOFF IS SET AGAINST PLAYER.LAMP_RANGE (48 m), NOT AGAINST TASTE. At
      // 900 m the suit lamp is the only directional light in the game - every
      // shadow cascade is cut off at 95 m - so a face beyond 48 m is lit by the
      // ambient alone. Asking for the crossing at 30 m puts rock INSIDE the
      // lamp's reach; the searched winner sits at 35 m. (An earlier draft asked
      // for 45 m, landed the face at 50 - just outside the lamp - and delivered
      // a frame 16% dimmer: lum 0.0169 against 0.0202.)
      const EYE_Y = -900, STANDOFF = 30, MIN_CLEARANCE = 30;
      const w = new Float32Array(B.BIOME_COUNT);
      const TW = B.BIOMES.findIndex((b) => b.short === 'trenchWall');
      let best = null;
      for (let x = 1700; x <= 2400; x += 20) {
        for (let z = 1400; z <= 2300; z += 20) {
          const bed = T.sampleHeight(x, z);
          // Open water under the eye, not a hole to be buried in. (Same number
          // as STANDOFF by coincidence and not by meaning - this one is
          // vertical clearance, that one is horizontal reach.)
          if (bed > EYE_Y - MIN_CLEARANCE) continue;
          // biomeWeights with the REAL slope. Defaulting it to 0 is the defect
          // CLAUDE.md records as turning fourteen live biomes into eight, and it
          // would hand this search to the FLAT biomes - the exact opposite of
          // what a wall scenario wants.
          const slope = T.sampleSlope(x, z);
          B.biomeWeights(w, x, z, bed, slope);
          let top = 0, second = 0, topI = -1;
          for (let i = 0; i < B.BIOME_COUNT; i++) {
            if (w[i] > top) { second = top; top = w[i]; topI = i; }
            else if (w[i] > second) second = w[i];
          }
          // DOMINANT, not merely winning. The margin floor is what stops this
          // landing back on a 0.500/0.500 tie whose water type is decided by
          // loop order; measured, 530 of the sampled columns clear it.
          if (topI !== TW || top - second < 0.60) continue;
          for (let k = 0; k < 16; k++) {
            const yaw = k * Math.PI / 8, dx = Math.sin(yaw), dz = -Math.cos(yaw);
            // Where does the seabed climb past the eye's own altitude? That is
            // the point at which rock stops being a floor and starts being a
            // wall, and beyond it the frame is filled rather than open.
            let cross = -1;
            for (let d = 20; d <= 75; d += 5) {
              if (T.sampleHeight(x + dx * d, z + dz * d) >= EYE_Y) { cross = d; break; }
            }
            if (cross < 0) continue;
            const rise = T.sampleHeight(x + dx * (cross + 10), z + dz * (cross + 10))
                       - T.sampleHeight(x + dx * (cross - 10), z + dz * (cross - 10));
            // Steep first, then close to the standoff: one metre of rise is
            // worth one metre of framing error. Measured, the winner crosses at
            // 35 m with 31.9 m of rise over the 20 m spanning the crossing.
            const score = rise - Math.abs(cross - STANDOFF);
            if (!best || score > best.score) best = { x, z, yaw, cross, rise, score };
          }
        }
      }
      if (!best) throw new Error('no Trench Wall station with rock rising past ' + EYE_Y + ' m');
      // The suit lamp is on because this stands in for a cave interior, and
      // because it is the only light a diver is SUPPOSED to have down here. It
      // is worth 4.0% of the frame's radiance and no more (measured at the old
      // station: scene 0.01419 lit against 0.01362 unlit). LAMP_RANGE is 48 m
      // and the searched face crosses the eye at 35 m, so the rock is now inside
      // the lamp's reach - and, as the block above records, still does not read.
      subwave.player.lampOn = true;
      qa.place(best.x, EYE_Y, best.z, best.yaw, -0.10);
      await qa.hold(15);
      await qa.freeze();
    `,
    // minBrightness is the content claim: auto-exposure normalises the frame, so
    // a brightness floor usually measures nothing, but it cannot lift a frame
    // with no geometry in it because there is no radiance to multiply. BE EXACT
    // ABOUT HOW STRONG THAT IS. The honest number is the A/B, not the gap to
    // another scenario: with the terrain pass nulled this frame reads 0.0232
    // against a floor of 0.03 and a normal 0.2302, so it catches a missing wall
    // by 1.29x while passing by 7.7x. (An earlier draft quoted "a 41x
    // separation", which is the ratio to the 'abyss' scenario at a different
    // station and is not what this assertion is comparing.) maxBlackFraction is
    // the weaker second opinion: debugReadback counts a pixel black below
    // luminance 1e-4 and the exposed void clears that, so it measures 0.0% here
    // and only catches a total failure.
    //
    // THE FLOOR IS EMPIRICAL, AND IT IS CURRENTLY PINNING A BUG. An earlier
    // draft of this block claimed "no daylight is leaking down here ...
    // everything in frame is deep tint and lamp", from ABYSSAL_VOID's blue Kd of
    // 0.0182 putting 900 m at 16.4 optical depths and 7.7e-8 of the surface
    // irradiance. The arithmetic is right and the conclusion is wrong. Measured
    // at this station with the lamp off: scene radiance 0.01595 at noon, 0.01362
    // at dayFraction 0.32, 0.004476 at 0.24, 2.56e-4 at 0.1 and 9.85e-5 at
    // midnight - 162x from noon to midnight, so 99.3% of this frame is SOLAR.
    // Stubbing sky._updateAmbient and zeroing renderer.env.ambientSH takes the
    // same frame to EXACTLY 0.0: 100% of it is the sky ambient SH, which
    // renderer.updateAmbientSH() builds from the above-water zenith/horizon/
    // ground triple with no depth term at all, and which lighting.wgsl's
    // evalAmbient() then attenuates only by the water between the CAMERA and the
    // point. A seabed at the camera's own depth therefore receives the full
    // surface sky at 900 m. So minBrightness 0.03 here is a floor under
    // whatever currently lights the abyss, and the day that is fixed this
    // scenario goes red and it will not be a regression - the honest frame at
    // this station is much closer to 'abyss''s 0.0056. Re-derive it then; do not
    // "fix" the lighting by keeping this number.
    //
    // 2026-08-02: THE FLOOR IS RETIRED, AND NOT MERELY LOWERED. The paragraph
    // above called this exactly right - the sky ambient SH now has its depth
    // term, this frame reads 0.0187 against the old floor of 0.03, and that is
    // the predicted consequence rather than a regression. But re-deriving the
    // NUMBER would have been the wrong repair, because the ASSERTION no longer
    // discriminates: measured on the fixed build, nulling the terrain pass takes
    // this frame to 0.0200 - BRIGHTER than the 0.0187 it reads with the wall in
    // it. The A/B quoted above (0.2302 lit against 0.0232 nulled, 9.9x) has
    // collapsed to 0.95x, because the frame's radiance is now the medium and no
    // longer the geometry. A brightness floor cannot see a missing wall down
    // here at any threshold, and one tuned until it passes would be a stub.
    //
    // What replaces it is the claim this station can still honestly make:
    // content EXISTS kilometres from spawn. `minVisibleScatter` reads the
    // scatter pass's own visible-instance counter - 6549 at the old station when
    // the floor was written, 4737 there today, MEASURED 4820 of 15374 resident at
    // the searched one - and it falls to zero if streaming, meshing or the draw
    // path breaks at range, which is one of the two things this scenario says it
    // uniquely guards. The floor stays at 3000, a 1.6x margin. Do not raise it to
    // look healthier: it is a floor under "the world exists out here", not a
    // population target, and the count moves with whatever the near field seeded.
    //
    // THE OTHER ONE IS NOW UNGUARDED, AND THAT IS STATED RATHER THAN PAPERED
    // OVER: nothing here asserts that the WALL is rasterised, because scatter is
    // a separate pass and would survive the terrain pass vanishing. A real test
    // wants spatial variance over the frame, or a depth-buffer coverage
    // fraction, and qa.mjs has neither. Do not invent a threshold on a quantity
    // that does not move; add the measurement instead.
    //
    // `expectWaterType` IS EARNED HERE NOW RATHER THAN COINCIDENTAL. Trench Wall
    // carries ABYSSAL_VOID deliberately - it is the clearest water in the
    // catalogue and the deep contrast partner to Canyon Wall's and Abyssal
    // Plain's HADAL_SUSPENSION - and the search above guarantees Trench Wall is
    // the dominant weight in this column by a margin of 0.994, so the classifier
    // has no tie to break. If this line ever goes red again, check the biome
    // margin before you touch the string: a searched station that lands on a tie
    // is a search bug, not a water bug.
    //
    // The depth bracket is arithmetic, not tuning: the setup pins the FEET at
    // -900 m and the eye sits currentEyeHeight above them, so the camera depth
    // is 900 minus a metre or two (measured 898.3) and can only leave that band
    // if the pin, the placement or the eye height broke.
    expect: { maxBlackFraction: 0.35, expectBlueDominant: true,
      minDepth: 850, maxDepth: 901, maxSceneLuminance: 0.05,
      expectWaterType: 'ABYSSAL_VOID', minVisibleScatter: 3000 },
  },
];

/**
 * Installed in the page as `window.qa` before any scenario runs, and aliased to
 * `qa` inside each setup.
 *
 * place() exists because there is no supported way to aim an on-foot camera from
 * outside the simulation. Camera.setEuler() is overwritten by
 * Player.applyCamera() on the next frame, and the player only rebuilds its own
 * orientation quaternion inside simulate(), which a paused game never calls - so
 * the yaw/pitch scalars, the quaternion and BOTH interpolation history slots all
 * have to be written by hand or the eye drifts back to wherever the player
 * really is. tools/shot.mjs learned the same lesson; this is the same code, and
 * it belongs in both because the two tools must frame identically.
 */
const INSTALL_HELPER = `(async () => {
  const { quat, vec3 } = await import('/src/core/math.js');
  window.qa = {
    /** Put the player's FEET here, looking along this compass yaw and pitch. */
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
    /**
     * Run the simulation for N seconds with the eye PINNED where place() put it.
     *
     * freeze() exists to stop a buoyant diver drifting, and it does that by
     * pausing - which also stops everything else the simulation owns. That is
     * fine for terrain and scatter, which stream while paused, and wrong for
     * anything the SIMULATION produces. The near-field creature director is the
     * case that exposed it: it seeds animals around the player over the first
     * ten-odd seconds in the water, so a scenario that placed the eye and froze
     * in the same tick could never photograph a single fish no matter how well
     * the director worked. The shot was structurally incapable of showing the
     * thing it existed to check.
     *
     * Re-pinning every animation frame caps the buoyant drift at one frame's
     * worth - 4 mm at 0.5 m/s - which is what freeze() was protecting and is
     * indistinguishable in the image.
     *
     * IT ALSO HOLDS THE DIVER ALIVE BY DEFAULT, for the same reason and it is
     * not a courtesy. Running the simulation is what makes the scenario real,
     * and the simulation kills a diver below the suit's rating:
     * PLAYER.SUIT_DEPTH_TIERS starts at 60 m and Player._updatePressure
     * saturates at 90 dps, so at the 'trench-wall' station the tier-0 suit
     * spends all of PLAYER.MAX_HEALTH in 1.11 s and _die() respawns the player
     * at the base anchor - the scenario would photograph the BEACH. Oxygen goes
     * the same way more slowly: consumption scales with absolute pressure, so a
     * 90 s tank is 28.1 s at 700 m and 81.9 s at 22 m, and a hold long enough to
     * stream distant chunks trips the warning tier and paints its vignette over
     * the frame. Both are the simulation eroding the scenario's own premise,
     * which is exactly what this function exists to stop. Measured: at 8 m and
     * 22 m neither term is reachable inside a 15 s hold, so the existing lagoon
     * scenarios are pixel-unaffected by this.
     *
     * IT IS OPT-OUT - hold(n, { lifeSupport: false }) - BECAUSE THE PIN IS ALSO
     * A BLINDFOLD. While it is on, no scenario can measure drowning, pressure
     * damage, the oxygen warning tiers or the death/respawn path - a future
     * scenario about any of those has to turn it off or it will silently
     * photograph a healthy diver. _oxygenWarnTier is a PRIVATE field, so a
     * rename breaks the pin with no error at all and the only symptom is the
     * warning vignette quietly coming back into the frame.
     */
    async hold(seconds, { lifeSupport = true } = {}) {
      const g = window.subwave;
      const p = g.player;
      const { PLAYER } = await import('/src/core/constants.js');
      const x = p.position[0], y = p.position[1], z = p.position[2];
      const yaw = p.yaw, pitch = p.pitch;
      const end = performance.now() + seconds * 1000;
      while (performance.now() < end) {
        await new Promise((res) => requestAnimationFrame(res));
        this.place(x, y, z, yaw, pitch);
        if (lifeSupport) {
          p.oxygen = p.oxygenCapacity;
          p._oxygenWarnTier = 0;
          p.health = PLAYER.MAX_HEALTH;
        }
      }
    },
    /**
     * Stop the simulation after ONE fixed step. Buoyancy would otherwise carry a
     * submerged eye upward for as long as the scenario waits - the whole reason
     * 'reef-floor' used to photograph open water - but pausing in the very same
     * tick leaves the player's derived state a scenario behind, and the HUD then
     * reports the previous scenario's depth over the new one's view. Four frames
     * is one step at any frame rate the harness sees; at 0.5 m/s of buoyant rise
     * that is under a millimetre. Terrain, scatter and the renderer all keep
     * running while paused, so nothing else is lost by stopping here.
     */
    async freeze() {
      for (let i = 0; i < 4; i++) {
        await new Promise((res) => requestAnimationFrame(res));
      }
      window.subwave.setPaused(true);
    },
  };
})()`;

// ---------------------------------------------------------------------------
// Minimal WebSocket client (CDP speaks WS; we ship no dependencies)
// ---------------------------------------------------------------------------

class MiniWebSocket {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname;
    this.port = +u.port;
    this.path = u.pathname + u.search;
    this.socket = null;
    this.handlers = new Map();
    this.onMessage = null;
    this._buffer = Buffer.alloc(0);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = createHash('sha1').update(Math.random().toString()).digest('base64');
      this.socket = connect(this.port, this.host, () => {
        this.socket.write(
          `GET ${this.path} HTTP/1.1\r\n` +
          `Host: ${this.host}:${this.port}\r\n` +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      this.socket.on('error', reject);

      let handshakeDone = false;
      this.socket.on('data', (chunk) => {
        if (!handshakeDone) {
          const s = chunk.toString('latin1');
          const end = s.indexOf('\r\n\r\n');
          if (end < 0) return;
          if (!/101/.test(s.slice(0, 20))) return reject(new Error('WS upgrade failed: ' + s.slice(0, 120)));
          handshakeDone = true;
          const rest = chunk.subarray(end + 4);
          if (rest.length) this._feed(rest);
          resolve();
          return;
        }
        this._feed(chunk);
      });
    });
  }

  _feed(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    for (;;) {
      const frame = this._readFrame();
      if (!frame) break;
      if (frame.opcode === 1) {
        try {
          const msg = JSON.parse(frame.payload.toString('utf8'));
          this._dispatch(msg);
        } catch { /* partial or non-JSON; ignore */ }
      } else if (frame.opcode === 8) {
        this.socket.end();
        break;
      }
    }
  }

  _readFrame() {
    const b = this._buffer;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2); offset = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      len = Number(b.readBigUInt64BE(2)); offset = 10;
    }
    if (masked) offset += 4;
    if (b.length < offset + len) return null;
    const payload = b.subarray(offset, offset + len);
    this._buffer = b.subarray(offset + len);
    return { fin, opcode, payload };
  }

  send(obj) {
    const data = Buffer.from(JSON.stringify(obj), 'utf8');
    const len = data.length;
    let header;
    // Client frames must be masked per RFC 6455.
    const mask = Buffer.from([0, 0, 0, 0]);
    if (len < 126) {
      header = Buffer.alloc(6);
      header[0] = 0x81; header[1] = 0x80 | len;
      mask.copy(header, 2);
    } else if (len < 65536) {
      header = Buffer.alloc(8);
      header[0] = 0x81; header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
      mask.copy(header, 4);
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x81; header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
      mask.copy(header, 10);
    }
    this.socket.write(Buffer.concat([header, data]));
  }

  _dispatch(msg) {
    if (msg.id != null && this.handlers.has(msg.id)) {
      const { resolve, reject } = this.handlers.get(msg.id);
      this.handlers.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (this.onMessage) {
      this.onMessage(msg);
    }
  }

  close() { try { this.socket?.end(); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------------------
// CDP session
// ---------------------------------------------------------------------------

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.listeners = new Map();
    ws.onMessage = (msg) => {
      const ls = this.listeners.get(msg.method);
      if (ls) for (const fn of ls) fn(msg.params);
    };
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.ws.handlers.set(id, { resolve, reject });
      this.ws.send({ id, method, params });
      setTimeout(() => {
        if (this.ws.handlers.has(id)) {
          this.ws.handlers.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60000);
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  /** Evaluate an expression in the page and return its value. */
  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.text || 'page exception');
    }
    return r.result?.value;
  }
}

// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPort(port, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const s = connect(port, '127.0.0.1', () => { s.end(); resolve(true); });
      s.on('error', () => resolve(false));
      s.setTimeout(500, () => { s.destroy(); resolve(false); });
    });
    if (ok) return true;
    await sleep(250);
  }
  return false;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  return res.json();
}

/** Analyse a PNG screenshot: mean channel values and how much of it is black. */
function analysePNG(base64) {
  // Decoding PNG without a dependency is not worth it; instead we ask the page
  // for the histogram directly (see captureAnalysis). This function just
  // records size so a zero-byte or trivially-small capture is still caught.
  const bytes = Buffer.from(base64, 'base64');
  return { bytes: bytes.length };
}

// ---------------------------------------------------------------------------

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const chromePath = CHROME_PATHS.find((p) => existsSync(p));
  if (!chromePath) {
    console.error('Could not find Chrome. Looked in:\n  ' + CHROME_PATHS.join('\n  '));
    process.exit(1);
  }

  // --- dev server -------------------------------------------------------
  console.log(`\nSUBWAVE QA\n\n  chrome: ${chromePath}`);
  PORT = await freePort();
  CDP_PORT = await freePort();

  const server = spawn(process.execPath, ['server.mjs', '--port', String(PORT)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  if (!(await waitForPort(PORT))) {
    console.error('Dev server did not start.');
    server.kill();
    process.exit(1);
  }
  console.log(`  server: http://127.0.0.1:${PORT}/`);

  // --- chrome -----------------------------------------------------------
  const profileDir = join(OUT, 'chrome-profile');
  const chromeArgs = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check',
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan',
    '--window-size=1600,900',
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-popup-blocking',
  ];
  if (!HEADED) chromeArgs.push('--headless=new');
  chromeArgs.push('about:blank');

  const chrome = spawn(chromePath, chromeArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  chrome.stderr.on('data', () => {});

  // TEAR DOWN ON EVERY EXIT PATH, NOT JUST THE HAPPY ONE. The normal path at the
  // bottom of main() kills both, and every other path - a throw, a rejected
  // promise, the SIGTERM an agent harness sends a hung tool - used to orphan a
  // headless Chrome with no signal at all. That is how two of them were found on
  // 2026-08-06 still running after 1h38m holding 2.96 GB between them.
  //
  // THE PROFILE IS NOT REMOVED HERE AND DOES NOT NEED TO BE: it lives in
  // `qa-output/chrome-profile` and this tool DELETES `qa-output/` wholesale at
  // startup, so it is reaped once per run by construction. That is why qa-output
  // held 81 MB where shot-output held 8.6 GB of abandoned profiles. `--keep-open`
  // is the one mode that must not be torn down, and it returns before the normal
  // kill for the same reason.
  let qaCleaned = false;
  const qaCleanup = () => {
    if (qaCleaned || KEEP_OPEN) return;
    qaCleaned = true;
    try { chrome.kill('SIGKILL'); } catch { /* already gone */ }
    try { server.kill('SIGKILL'); } catch { /* already gone */ }
  };
  process.on('exit', qaCleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    process.on(sig, () => { qaCleanup(); process.exit(1); });
  }
  process.on('uncaughtException', (e) => { qaCleanup(); console.error(e); process.exit(1); });
  process.on('unhandledRejection', (e) => { qaCleanup(); console.error(e); process.exit(1); });

  if (!(await waitForPort(CDP_PORT))) {
    console.error('Chrome DevTools port never opened.');
    chrome.kill(); server.kill();
    process.exit(1);
  }

  const targets = await fetchJSON(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`).catch(
    () => fetchJSON(`http://127.0.0.1:${CDP_PORT}/json/list`));
  const target = Array.isArray(targets) ? targets.find((t) => t.type === 'page') : targets;
  if (!target?.webSocketDebuggerUrl) {
    console.error('No debuggable page target.');
    chrome.kill(); server.kill();
    process.exit(1);
  }

  const ws = new MiniWebSocket(target.webSocketDebuggerUrl);
  await ws.connect();
  const cdp = new CDP(ws);

  // --- collect diagnostics ----------------------------------------------
  const consoleErrors = [];
  const consoleWarnings = [];
  const allConsole = [];

  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');

  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    allConsole.push({ level: p.type, text });
    if (p.type === 'error') consoleErrors.push(text);
    if (p.type === 'warning') consoleWarnings.push(text);
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails;
    consoleErrors.push(d.exception?.description || d.text);
  });
  cdp.on('Log.entryAdded', (p) => {
    allConsole.push({ level: p.entry.level, text: p.entry.text });
    if (p.entry.level === 'error') consoleErrors.push(p.entry.text);
  });

  // --- load --------------------------------------------------------------
  console.log('\n  loading...');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });

  const bootDeadline = Date.now() + 120000;
  let booted = false;
  let bootError = null;
  while (Date.now() < bootDeadline) {
    await sleep(1000);
    const state = await cdp.eval(`(() => {
      const fatal = document.getElementById('fatal');
      if (fatal && fatal.classList.contains('show')) {
        return { fatal: true,
                 title: document.getElementById('fatal-title')?.textContent,
                 message: document.getElementById('fatal-message')?.textContent,
                 detail: document.getElementById('fatal-detail')?.textContent };
      }
      if (typeof subwave === 'undefined' || !window.subwave) return { pending: 'module' };
      if (!window.subwave.running) return { pending: 'booting',
                 progress: window.subwave._bootProgress || 0 };
      return { ready: true, gpu: window.subwave.renderer.gpu.describe() };
    })()`).catch((e) => ({ evalError: String(e) }));

    if (state?.fatal) { bootError = state; break; }
    if (state?.ready) { booted = true; console.log('  booted.');
      console.log('  gpu:', JSON.stringify(state.gpu, null, 2).split('\n').join('\n  '));
      break; }
  }

  const results = { booted, bootError, scenarios: [], consoleErrors, consoleWarnings };

  if (bootError) {
    console.log(`\n  BOOT FAILED: ${bootError.title}\n  ${bootError.message}\n`);
    if (bootError.detail) console.log('  ' + bootError.detail.split('\n').join('\n  '));
  } else if (!booted) {
    console.log('\n  BOOT TIMED OUT (120 s).');
  } else {
    // Start the game loop without needing a real click.
    // Hide the boot overlay: we call start() directly rather than clicking
    // "Begin", so nothing else takes the splash down and every screenshot would
    // otherwise be a picture of the splash screen.
    await cdp.eval(`(() => {
      document.getElementById('boot')?.classList.add('hidden');
      window.subwave.start();
    })()`).catch(() => {});
    await sleep(2000);
    await cdp.eval(INSTALL_HELPER);

    const scenarios = ONLY ? SCENARIOS.filter((s) => s.id === ONLY) : SCENARIOS;
    for (const sc of scenarios) {
      process.stdout.write(`\n  [${sc.id}] ${sc.name}\n`);
      try {
        // Player state carries from one scenario to the next - the runner is the
        // only thing between them - and the suit lamp is the piece of it that
        // changes pixels. 'trench-wall' turns it on and is currently last;
        // clearing it HERE rather than at the end of that setup is deliberate,
        // because the game keeps rendering (and keeps resubmitting lights) while
        // paused, so a reset written after qa.freeze() lands in the screenshot:
        // measured, it took the trench frame from scene 0.0142 to 0.0134, i.e. it
        // quietly photographed the scenario with its lamp off.
        await cdp.eval('window.subwave.setPaused(false); window.subwave.player.lampOn = false;')
          .catch(() => {});
        await cdp.eval(`(async () => { ${sc.setup} })()`);
      } catch (e) {
        console.log(`    setup failed: ${e.message}`);
        results.scenarios.push({ id: sc.id, error: 'setup: ' + e.message });
        continue;
      }
      // Let TAA converge and streaming settle.
      await sleep(2500);

      // Ask the page to analyse its own framebuffer - far cheaper and more
      // informative than decoding a PNG here.
      // Read the render target itself. Drawing a WebGPU canvas into a 2D
      // context does NOT reliably capture its contents - it silently yields
      // black - so canvas-based measurement reports a working renderer as a
      // total failure. debugReadback copies a target we own.
      const analysis = await cdp.eval(`(async () => {
        const r = window.subwave.renderer;
        const clock = window.subwave.clock;
        const C = await import('/src/core/constants.js');
        const shown = await r.debugReadback('resolved', 96);
        const scene = await r.debugReadback('sceneColor', 64);
        return {
          meanR: shown.meanR, meanG: shown.meanG, meanB: shown.meanB,
          brightness: shown.luminance,
          maxLuminance: shown.maxLuminance,
          blackFraction: shown.blackFraction,
          sceneLuminance: scene.luminance,
          exposure: r.exposure,
          fps: clock.fps, frameMs: clock.smoothedDt * 1000,
          p99Ms: clock.percentile(0.99),
          depth: r.camera.depth,
          // WHERE THE CAMERA ACTUALLY WAS. A scenario whose station is SEARCHED
          // rather than written down ('reef-floor', 'trench-wall') otherwise
          // leaves no record of the coordinate it photographed, so a frame that
          // changes because the terrain moved is indistinguishable from one that
          // changed because the renderer did.
          camX: r.camera.position[0], camY: r.camera.position[1], camZ: r.camera.position[2],
          chunks: window.subwave.chunks?.loadedCount ?? -1,
          lights: r.lightCount,
          // Plants and rubble the scatter pass actually DREW last frame, which is
          // the only number here that can tell a scenario about its own content.
          // Every other field describes the water, the exposure or the camera,
          // and all of them are satisfied by an empty seabed.
          scatterVisible: window.subwave.scatterPass?.stats?.visibleInstances ?? -1,
          scatterResident: window.subwave.scatterPass?.stats?.instances ?? -1,
          // The water type the CLASSIFIER returned this frame, as the KEY a
          // scenario names rather than the display name. It is not the sprung
          // column and must not be described as one: main.js springs the
          // coefficients at WATER_BLEND_TAU but assigns the id outright, so this
          // reports what waterTypeAt() said and not what the pixels are made of.
          // Pair it with expectGreenDominant/expectBlueDominant, which are the
          // pixels. A scenario that claims to be in a particular water has to be
          // able to say so: the whole reason biomes.waterTypeAt() shipped
          // classifying the seabed as flat for as long as it did is that no shot
          // could tell which water it was in, and an entire type was absent from
          // the game without a single red check.
          waterType: Object.keys(C.WATER_TYPES).find(
            (k) => C.WATER_TYPES[k].id === r.env.waterType?.id) ?? null,
        };
      })()`);

      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = join(OUT, `${sc.id}.png`);
      await writeFile(file, Buffer.from(shot.data, 'base64'));

      // --- evaluate expectations -----------------------------------------
      const problems = [];
      const e = sc.expect || {};
      if (e.minBrightness != null && analysis.brightness < e.minBrightness) {
        problems.push(`too dark: brightness ${analysis.brightness.toFixed(4)} < ${e.minBrightness}`);
      }
      if (e.maxBrightness != null && analysis.brightness > e.maxBrightness) {
        problems.push(`too bright: brightness ${analysis.brightness.toFixed(4)} > ${e.maxBrightness}`);
      }
      if (e.maxBlackFraction != null && analysis.blackFraction > e.maxBlackFraction) {
        problems.push(`mostly black: ${(analysis.blackFraction * 100).toFixed(1)}% > ${e.maxBlackFraction * 100}%`);
      }
      if (e.minDepth != null && analysis.depth < e.minDepth) {
        problems.push(`camera never reached depth: ${analysis.depth.toFixed(1)} m < ${e.minDepth} m`);
      }
      // The other half of the bracket, and it is the half that catches a
      // scenario drifting away from what it claims to be looking at.
      if (e.maxDepth != null && analysis.depth > e.maxDepth) {
        problems.push(`camera drifted deeper than the scenario: ${analysis.depth.toFixed(1)} m > ${e.maxDepth} m`);
      }
      if (e.maxSceneLuminance != null && analysis.sceneLuminance > e.maxSceneLuminance) {
        problems.push(`scene radiance too high pre-exposure: ${analysis.sceneLuminance.toFixed(4)} > ${e.maxSceneLuminance}`);
      }
      if (e.expectBlueDominant && !(analysis.meanB > analysis.meanR)) {
        problems.push(`underwater but not blue-dominant: R=${analysis.meanR.toFixed(3)} B=${analysis.meanB.toFixed(3)}`);
      }
      // Green over BLUE, not green over red - every water in the table kills red
      // first, so red tells you nothing about which one you are in. Green beating
      // blue is the signature of a coastal column specifically: it is the only
      // water type whose Kd_green is below its Kd_blue.
      if (e.expectGreenDominant && !(analysis.meanG > analysis.meanB)) {
        problems.push(`coastal water but not green-dominant: G=${analysis.meanG.toFixed(3)} B=${analysis.meanB.toFixed(3)}`);
      }
      // The classification itself, upstream of every pixel. This is the only
      // assertion in the file that can fail while the picture still looks
      // plausible, which is exactly the failure that let waterTypeAt() classify
      // the whole seabed as flat for its entire life.
      if (e.expectWaterType != null && analysis.waterType !== e.expectWaterType) {
        problems.push(`wrong water column: ${analysis.waterType} where the scenario claims ${e.expectWaterType}`);
      }
      // The content, for a scenario that is named after content. A frame of
      // empty water passes every other check in this list.
      if (e.minVisibleScatter != null && analysis.scatterVisible < e.minVisibleScatter) {
        problems.push(`nothing growing: ${analysis.scatterVisible} scatter instances drawn < ${e.minVisibleScatter}`);
      }

      console.log(`    rgb(${analysis.meanR.toFixed(3)}, ${analysis.meanG.toFixed(3)}, ${analysis.meanB.toFixed(3)})` +
                  `  lum ${analysis.brightness.toFixed(4)}  black ${(analysis.blackFraction * 100).toFixed(1)}%` +
                  `  water ${analysis.waterType}`);
      console.log(`    scene(pre-exposure) ${analysis.sceneLuminance.toFixed(4)}  exposure ${analysis.exposure.toFixed(4)}`);
      console.log(`    ${analysis.fps.toFixed(1)} fps  ${analysis.frameMs.toFixed(2)} ms  p99 ${analysis.p99Ms.toFixed(1)} ms` +
                  `  depth ${analysis.depth.toFixed(1)} m  chunks ${analysis.chunks}  lights ${analysis.lights}` +
                  `  scatter ${analysis.scatterVisible}/${analysis.scatterResident}`);
      console.log(`    camera (${analysis.camX.toFixed(0)}, ${analysis.camY.toFixed(1)}, ${analysis.camZ.toFixed(0)})`);
      if (problems.length) for (const p of problems) console.log(`    ! ${p}`);

      results.scenarios.push({ id: sc.id, ...analysis, problems, screenshot: file });
    }
  }

  // --- report -------------------------------------------------------------
  console.log('\n  ---');
  if (consoleErrors.length) {
    console.log(`\n  CONSOLE ERRORS (${consoleErrors.length}):`);
    const seen = new Set();
    for (const e of consoleErrors) {
      const key = e.slice(0, 200);
      if (seen.has(key)) continue;
      seen.add(key);
      console.log('    x ' + e.split('\n').slice(0, 6).join('\n      '));
    }
  } else if (booted) {
    console.log('\n  No console errors.');
  }

  const wgslWarnings = consoleWarnings.filter((w) => /wgsl|shader/i.test(w));
  if (wgslWarnings.length) {
    console.log(`\n  SHADER WARNINGS (${wgslWarnings.length}):`);
    for (const w of wgslWarnings.slice(0, 20)) console.log('    ~ ' + w.split('\n')[0]);
  }

  await writeFile(join(OUT, 'report.json'), JSON.stringify(results, null, 2));
  console.log(`\n  screenshots + report: ${OUT}\n`);

  const failed = !booted || consoleErrors.length > 0 ||
                 results.scenarios.some((s) => s.problems?.length || s.error);

  if (!KEEP_OPEN) {
    ws.close();
    chrome.kill();
    server.kill();
  } else {
    console.log('  --keep-open: Chrome left running. Ctrl-C to exit.\n');
    return;
  }

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nQA harness failed:', err);
  process.exit(1);
});
