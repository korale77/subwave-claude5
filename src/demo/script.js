/**
 * The authored showcase route: pure data, interpreted by demo/director.js.
 *
 * A SEGMENT is one scene of the demo. In order, each carries:
 *
 *   id       stable short name; the capture harness keys its PNGs on it
 *   label    what the scene is showing, for the console log
 *   title    the biome/area name the HUD shows top-centre while the segment
 *            opens (ui/hud.js 'demoTitle' region; drawn IN THE FRAME so the
 *            recording sees it - a DOM caption would be invisible to the file)
 *   time     day fraction to set behind the cut's fade, or null to keep the
 *            current one. The director saves the pre-demo time once and
 *            restores it when the demo ends, however it ends.
 *   cut      how the segment begins: null (continuous from the previous one),
 *            a string handed to game.jumpTo() - the SANCTIONED cut mechanism,
 *            with every latch, gear grant, residency reset and caveArrival
 *            re-seat that path already owns - or a function
 *            (game) => ({ target, opts }) for computed destinations.
 *   lamp     desired suit-lamp state at segment start (null = leave alone).
 *            The tour's own policy lights the lamp below 150 m; the segments
 *            here follow it EXCEPT where a scene is lit by its own emitters
 *            (Platter Forest's disc rims, the Jellyshroom caps) or by clear
 *            azure daylight (Sunken Dunes) - a headlight in those frames
 *            flattens the light the scene is about, and each exception says so.
 *   onStart  optional hook run when the segment begins (after the cut).
 *   timeout  hard cap in seconds. A segment that has not finished its steps by
 *            then advances anyway - the demo NEVER stalls; a stuck waypoint
 *            costs one scene, not the show.
 *   beats    [{at, name}] capture moments for tools/demo-capture.mjs, seconds
 *            from segment start. The director does nothing with them; they are
 *            the harness's shot list, kept beside the route they photograph.
 *            A beat whose `at` falls past the segment's real end NEVER FIRES
 *            (the ossuary shipped one at 13 s in a 12.7 s segment) - author
 *            each `at` against the measured step timeline, not the timeout.
 *   steps    the step programme; see director.js for the vocabulary.
 *
 * POINTS are [x, y, z] arrays or functions (game, out) => out writing absolute
 * metres, resolved fresh every sim step so a moving subject can be tracked.
 *
 * DETERMINISM: the route, the waypoints and the times of day are authored
 * here and identical every run at one seed. The FAUNA is not - the prowler
 * slot, the leviathan residencies and every ambient animal draw from the live
 * population, so which animal appears (and whether one appears inside a
 * segment's window at all) varies run to run. That is accepted and stated:
 * the watchFauna steps track whatever qualifies and fall back to an authored
 * pan when nothing does, and the capture report says which happened.
 *
 * 2026-08-26 GAZE PASS (round 5). Two notes, both about where the lens is
 * POINTED rather than where the diver is: "in the shallows scene and also the
 * kelp scene, there's a part where the camera just looks down at the ground",
 * and "when the camera starts moving up towards the surface, can you make it
 * move faster and get closer to the surface?" Both were reproducible in the
 * control capture's own frames and both fixes are recorded at the steps they
 * belong to (the reef and glassclaw `watchFauna` acquisition floors, and the
 * kelp ascent). A THIRD INSTRUMENT joins the two below and this round is what
 * it was written for: `tools/probes/demo-gaze.mjs` reports the authored
 * depression angle of every leg offline, and `tools/demo-capture.mjs` now
 * samples the camera's PITCH AND DEPTH beside every PNG - a floor-ward frame
 * and a canopy-ward one share every colour metric the report used to carry, so
 * until this run the harness could not describe the note it was photographing.
 *
 * 2026-08-21 PLAYTEST RECUT (round 3). Ten notes came back against
 * the feedback5 capture and every one of them is reproducible in that
 * capture's own frames; the fixes are recorded at the segments they belong to.
 * Three of them were mechanisms rather than routes and live in director.js -
 * the cornering look-ahead, the angular-acceleration ease-in, and the `turn`
 * step - and one was a latent BUG this recut exposed: the reef leg targeted
 * `a.viewY + 2` and `viewY` is `null` on every anchor but Canyon Wall, so
 * `null + 2` flew the hull to y = +2 and parked it AT THE SURFACE. The dive
 * looked like a dive and ended with the diver swimming the last 20 m alone.
 *
 * TWO OFFLINE INSTRUMENTS NOW STAND BEHIND THE ROUTE, and a leg that has not
 * been through them is not authored, it is guessed: `tools/probes/demo-path.mjs`
 * audits the shipped waypoints and legs against the REAL scatter collision
 * proxies, and `tools/probes/demo-corridor.mjs` finds a clear bearing and eye
 * height in the first place. Both are deterministic and need no browser. The
 * numbers quoted in the segments below come from them.
 *
 * 2026-08-19 DIRECTOR'S CUT: the route was rebuilt after the biome 16-18
 * landings (Bulb Grove, Platter Forest, Sunken Dunes + Splitmaw), the Kelp
 * emerald rebuild and a frame-by-frame review of the t1-done capture. Four
 * segments were CUT on delivered evidence, not taste: canyon (near-empty navy
 * frames; the resident Hollowjaw's fallback pan fired on every captured run),
 * vents (no chimney silhouette resolved at the authored framing), brine (the
 * bone ring delivered as bare glowing polylines and the approach
 * deterministically stopped 8.6 m short) and First Hollow/Geode (murky mouth,
 * near-empty spar field; the Vaultstalker's dread beat is ceded to the
 * Splitmaw, which photographs). Their replacements below each carry the
 * evidence for their own framing. The cuts are one git revert away if a
 * playtest wants any of them back.
 */

import { quat, wrapAngle } from '../core/math.js';
import { HABITAT_SITE } from '../world/habitat_site.js';
import { PLACE_BY_SHORT } from '../world/places.js';
import { STATION_RESIDENCY_SITES } from '../entities/station_residency.js';
import { speciesIndexOf } from '../entities/creatures.js';
import { DUNE_AMBUSH_PHASE } from '../entities/dune_ambush.js';
import { resolvedCaveSites } from '../world/cave_sites.js';

/** Ashcone Isle centre and the crater-lagoon centre (world/terrain.js,
 *  WORLD.SAFE_CRATER_CENTER). Baked here the same way places.js bakes its
 *  terrain samples: demo/ must not import terrain internals for two numbers. */
const ISLAND = [-492, -656];
const LAGOON = [0, 0];

/**
 * The measured duneColossus 23 m from the Sunken Dunes anchor - the ribcage in
 * feedback5 beat 41, and the subject the recut turns RIGHT onto.
 *
 * Baked for the same reason ISLAND and LAGOON are: demo/ must not reach into
 * the scatter generator for one position. Re-measure with
 * `tools/probes/demo-corridor.mjs --anchor dunes` if the seed or the dune pass
 * ever moves; the turn is authored as "the way round", not as an angle, so a
 * small drift costs framing rather than direction.
 */
const DUNE_BONES = [-956, 2555];

/** Resolve a biome anchor row by its short name, memoised per game instance. */
function anchor(game, short) {
  let m = game.__demoAnchors;
  if (!m) {
    m = game.__demoAnchors = Object.create(null);
    for (const a of game.biomeAnchors()) m[a.short] = a;
  }
  return m[short];
}

/** Point `dist` metres along compass heading `yaw` from (x, z). */
function along(x, z, yaw, dist) {
  return [x + Math.sin(yaw) * dist, z - Math.cos(yaw) * dist];
}

/**
 * The hull's own compass heading, from its live orientation. `quat.toEuler`
 * must not be used to read the hull (it folds roll into yaw and inverts pitch
 * past 90 degrees of roll - CLAUDE.md); the forward vector is roll-immune.
 */
const _fwd = [0, 0, 0];
function hullYaw(vessel) {
  quat.forward(_fwd, vessel.orientation);
  return Math.atan2(_fwd[0], -_fwd[2]);
}

/** A point near the seabed: terrain height + `up` metres. */
function floorPoint(game, out, x, z, up) {
  out[0] = x;
  out[1] = game.terrain.sampleHeight(x, z) + up;
  out[2] = z;
  return out;
}

const HAB = HABITAT_SITE;
const SKULL = PLACE_BY_SHORT.skull;
const JELLY = PLACE_BY_SHORT.jelly;

/**
 * The Jellyshroom corridor's authored centreline, ABSOLUTE, waypoint `i` of
 * the resolved site (world/cave_sites.js owns the deltas; resolving here is
 * what keeps the tunnel run on the centreline if the cave spec ever moves).
 * `lift` raises the point off the axis - the vessel flies the bore's middle,
 * a diver might want the floor.
 */
function jellyWp(out, i, lift = 0) {
  const r = resolvedCaveSites().find((s) => s.site.short === 'jelly')
    ?? resolvedCaveSites()[0];
  const w = r.site.corridor[i];
  out[0] = r.mouth.x + w[0];
  out[1] = r.surface - w[1] + lift;
  out[2] = r.mouth.z + w[2];
  return out;
}

/**
 * Gaze point for a residency pod: the nearest live member of `siteIdx`'s
 * species within `radius` of the pod centroid AND within `bandY` metres of the
 * authored home height, falling back to the authored first member home. The
 * observatory window shot's lookup, shared with the commons dome now that two
 * pods exist; ordinary population found by species, never a demo handle.
 *
 * THE HEIGHT BAND IS NOT DEFENSIVE, IT IS THE FIX FOR A SHIPPED BUG. Playtest:
 * "in the underwater station, when we move to the other room, why does the
 * camera just look at the floor? nothing to see." Probed on this tree: exactly
 * ONE Ribbonwether survives near the observatory pod and it sits at
 * (-290.2, -43.3, 1437.2) - on the SEABED, 11.8 m BELOW the observatory eye at
 * -31.5 and 24.3 m off the pod centroid - because a Ribbonwether is a Sand
 * Plains BENTHIC GRAZER and grazing is what its behaviour does. The authored
 * homes are at window-band height (-29.5 to -31.5); its live position is not.
 * Aiming at it gave heading 345 / pitch -37 deg, and the delivered frame was
 * the observatory deck tile with the animal on the far side of it
 * (probe-habitat beat 13, HUD heading 347).
 *
 * A radius alone cannot catch that: the animal was inside 30 m the whole time.
 * The band is on the AUTHORED home height rather than on the eye, because it is
 * the window band the shot is about; the commons dome pod passes it easily
 * (probed at -20.3 to -22.8 against homes of -21.6 to -22.8).
 *
 * The fallback is NOTED rather than silent - an authored premise that has gone
 * missing is a residency bug to chase, and this file's whole history says a
 * quiet fallback is how those survive (see the dead-authored-data rule in
 * CLAUDE.md). One note per pod per session; the capture harness prints them.
 */
function residentPoint(g, out, siteIdx, radius, bandY = 6) {
  const sim = g.creatures;
  const pod = STATION_RESIDENCY_SITES[siteIdx];
  const sp = speciesIndexOf(pod.species);
  const homeY = pod.members[0].y;
  let best = -1, bestD2 = radius * radius;
  if (sim && sp >= 0) {
    for (let i = 0; i < sim.capacity; i++) {
      if (!sim.alive[i] || sim.species[i] !== sp) continue;
      if (Math.abs(sim.posY[i] - homeY) > bandY) continue;
      const dx = sim.posX[i] - pod.x, dz = sim.posZ[i] - pod.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }
  }
  if (best >= 0) {
    out[0] = sim.posX[best]; out[1] = sim.posY[best]; out[2] = sim.posZ[best];
    return out;
  }
  const noted = g.__demoResidentNoted || (g.__demoResidentNoted = Object.create(null));
  if (!noted[pod.short] && g.demo?.notes) {
    noted[pod.short] = true;
    g.demo.notes.push(`residency '${pod.short}': no member in the window band ` +
      `(${bandY} m of y ${homeY}) within ${radius} m - framing the authored home`);
  }
  const m = pod.members[0];
  out[0] = m.x; out[1] = m.y; out[2] = m.z;
  return out;
}

/** The Splitmaw residency home (world/leviathan_sites.js, 'Dune Splitmaw'):
 *  (-1040, 2530) over a -344.6 m seabed, 105 m from the dunes anchor BY
 *  DESIGN so an arrival materialises it in frame - see the sunken-dunes
 *  segment for the mechanism. */
const SPLITMAW_HOME = [-1040, 2530];

export const SEGMENTS = [
  {
    id: 'beach-dawn',
    label: 'Dawn on the strand: the sea, then a slow 180 left onto the Kestrel',
    title: 'Spawn Beach',
    time: 0.265,          // just after sunrise - long warm light on the strand
    // THE OPENER IS ONE MOVE NOW, AND ITS GEOMETRY IS MEASURED, NOT CHOSEN.
    // The playtest asked for exactly this: "the scene should start where we
    // just look at the sea, vessel behind us, then the camera turns 180 to the
    // left, passing the sunset and mountain, and then frames the vessel right
    // in the middle. Then board it." Every part of that lines up on this beach
    // and the numbers are why the segment can be this short:
    //
    //   spawn (-240.9, -382.9), shoreBearing 137.4 deg, waterline at d = 32 m
    //   the vessel pad is 12 m SEAWARD of spawn, so standing at d = 27 puts
    //     the hull 15.0 m DIRECTLY BEHIND at bearing -42.6 deg, elevation +10.8
    //   Ashcone lies on that SAME bearing: 28.5 deg of elevation at 370 m
    //   the sun at dayFraction 0.265 is azimuth 91.1 deg, altitude 5.3 deg
    //
    // So a 180 to the LEFT from the sea runs 137.4 -> 91 (the low sun) -> 0
    // (north) -> -42.6, where Ashcone and the Kestrel are the SAME BEARING and
    // the hull ends framed against the mountain. The turn step is authored as
    // `toPoint` + `dir: -1` rather than as an angle, so it lands on the hull
    // wherever the hull is; `pan` could not express it at all, because
    // wrapAngle always takes the short way and 180 has no short way.
    //
    // The three opening pans and both walk legs are GONE with it: the old
    // opener walked past the hull to look at the sea and then walked back.
    cut: (g) => {
      const [x, z] = along(g.spawn.position[0], g.spawn.position[2], g.spawn.shoreBearing, 27);
      return { target: { x, z },
               opts: { yaw: g.spawn.shoreBearing, pitch: -0.02, label: 'Spawn Beach' } };
    },
    lamp: false,
    // The route needs the Kestrel on its pad. After a free-play session it can
    // be anywhere (or crashed); vessel.teleport is the same dev API the jump
    // menu uses, and an unpiloted hull settles onto its skids from the 2 m
    // park clearance exactly as it does at boot.
    onStart: (g) => {
      const pad = g.spawn.vesselPad;
      const dx = g.vessel.position[0] - pad[0];
      const dz = g.vessel.position[2] - pad[2];
      if (!g.vessel.piloted && Math.hypot(dx, dz) > 10) {
        g.vessel.teleport(pad[0], pad[1], pad[2], g.spawn.shoreBearing, 0);
      }
    },
    timeout: 34,
    beats: [
      { at: 1.4, name: 'the-sea' },
      { at: 5.6, name: 'dawn-sun' },
      { at: 8.8, name: 'ashcone' },
      { at: 11.8, name: 'the-kestrel' },
    ],
    steps: [
      // Open on the water, drifting a step seaward so nothing is frozen.
      { dwell: { dur: 2.6, move: [0.10, 0, 0],
                 look: (g, out) => {
                   const [x, z] = along(g.spawn.position[0], g.spawn.position[2],
                     g.spawn.shoreBearing, 260);
                   out[0] = x; out[1] = 1.5; out[2] = z; return out; } } },
      // THE MOVE. Slow on purpose - `rate` overrides the 1.5 rad/s cinematic
      // cap down to what an 8 s half-turn needs - and the pitch rises through
      // it so the arc leaves the surf, crosses the low sun, and arrives lifted
      // onto Ashcone's shoulder with the hull under it. +0.19 rad is 10.9 deg,
      // which centres a hull sitting 10.8 deg up at 15 m.
      { turn: { toPoint: (g, out) => { out.set(g.vessel.position); out[1] += 1.1; return out; },
                dir: -1, dur: 8.0, rate: 0.9, pitch: [0.05, 0.19] } },
      // Settle exactly on the hull (the sweep lands within a degree; this is
      // the frame the 'the-kestrel' beat photographs) and hold it centred.
      { lookAt: { point: (g, out) => { out.set(g.vessel.position); out[1] += 1.1; return out; },
                  dur: 1.8 } },
      // 15 m of wet sand to the hatch. The old approach needed a staging leg
      // to avoid the dune grass; from the seaward side the whole line is
      // surf-washed sand, which is what makes it a pad.
      //
      // STOP OFF THE HULL'S LONG AXIS, NOT ON IT. Playtest: "we go too far so
      // the camera goes through it and we see clipping". It was arithmetic,
      // not luck: the walk targeted `vessel.position` with `arriveR: 3.4`
      // against a hull whose HALF-LENGTH is 3.7 m (VESSEL.LENGTH 7.4), and the
      // approach is exactly end-on - the pad heading is the shoreBearing and
      // the walker arrives on the reciprocal, measured 180.0 deg apart. So the
      // eye stopped 0.3 m INSIDE the nose.
      //
      // Simply stopping earlier does not fit: BOARD_RANGE is 4.5 m measured in
      // THREE dimensions from vessel.hatchPosition(), and the hatch sits 1.63 m
      // above the sand here (probed: hatch y 4.231, ground 2.405, feet on the
      // pad ~2.6), so the horizontal budget is sqrt(4.5^2 - 1.63^2) = 4.19 m.
      // End-on that leaves a band of [3.7, 4.19] to stand in.
      //
      // Coming in 60 deg off the long axis opens it up. The hull's plan
      // ellipse (semi-axes 3.7 x 2.1) is 2.30 m in that direction, so 4.0 m
      // stands 1.70 m clear, the hatch is sqrt(4.0^2 + 1.63^2) = 4.32 m away,
      // and the whole approach line clears the hull by 1.7 m or more (worst
      // point 1.96 m, abeam of the shoulder). It also frames the Kestrel three
      // quarters instead of nose-on for the last few metres.
      { walkTo: { point: (g, out) => {
                    const v = g.vessel.position;
                    // WHERE the stand-off sits is the walker's own bearing in
                    // the HULL's frame, clamped into [60, 120] degrees off the
                    // long axis. That keeps it on the side and the end the
                    // walker is already coming from - a fixed offset would put
                    // it round the far side and steer the walk THROUGH the
                    // hull - and the clamp is what guarantees the clearance,
                    // because the plan ellipse is at most 2.30 m anywhere in
                    // that arc. The hull heading is read live rather than
                    // assumed: onStart only re-parks a hull that has wandered
                    // more than 10 m, so after free play it is the shoreBearing
                    // and from a cold boot it is whatever the hull booted with.
                    // The choice is stable under the walk: `rel` converges onto
                    // the clamp as the walker closes, it does not chase.
                    const b = hullYaw(g.vessel);
                    const pp = g.player.position;
                    const rel = wrapAngle(Math.atan2(pp[0] - v[0], -(pp[2] - v[2])) - b);
                    const mag = Math.min(Math.max(Math.abs(rel), 1.05), Math.PI - 1.05);
                    const [x, z] = along(v[0], v[2], b + Math.sign(rel || 1) * mag, 4.0);
                    out[0] = x; out[1] = v[1]; out[2] = z; return out; },
                  // Gaze stays on the hull while the body sidles onto the
                  // stand-off: the shot is the vessel, not the sand.
                  look: (g, out) => { out.set(g.vessel.position); out[1] += 1.1; return out; },
                  arriveR: 1.0, maxT: 12 } },
    ],
  },

  {
    id: 'board-climb',
    label: 'Board, climb out over the water, run level at Ashcone, lagoon overlook',
    title: 'Ashcone Isle',
    time: 0.40,           // sun high enough to light the turquoise from above
    cut: null,
    lamp: null,
    timeout: 62,
    beats: [
      { at: 2.2, name: 'takeoff' },
      { at: 11, name: 'ashcone-pass' },
      { at: 19, name: 'lagoon-overlook' },
      { at: 25, name: 'lagoon-orbit' },
      { at: 31, name: 'cockpit-entry' },
    ],
    steps: [
      { board: { maxT: 8 } },
      // The chase camera for the flight scene: the hull over the water IS the
      // shot. Handed back to cockpit ON CAMERA by the dolly below.
      { camera: 'chase' },
      // TIP THE CHASE VIEW DOWN. The playtest: "have the camera look a little
      // bit more straight leveled so we can see more of the mountain instead of
      // just its tip at the bottom of the screen". The chase point hangs behind
      // the AIM, so a climbing hull drags the whole view up with it; 0.28 rad
      // (16 deg) of bias places the camera that much higher and looks that much
      // further down, which is what puts terrain back in frame. It biases the
      // PLACEMENT only - never the hull, never the cockpit. See
      // Vessel.chasePitchBias. The other half of that note was the chase
      // spring's speed lag (VESSEL.CHASE_LAG_COMP): the hull photographed as a
      // speck 85 m away because the spring trails 1.093 m per m/s.
      { chaseBias: 0.28 },
      // LEG 1, THE CLIMB OUT, 520 m rather than 240. The old pair climbed at
      // 28 deg all the way to a 300 m shoulder, and at 28 deg of nose-up the
      // island can only ever be at the bottom edge (feedback5 beat 05 is
      // that exact frame: sky, a speck, and a summit clipped at the bottom).
      // Going further out first is what buys leg 2 its shallow chord: 520 m of
      // water at 15.6 deg, with the beach and the surf receding under the hull.
      { flyTo: { point: (g, out) => {
                   const [x, z] = along(g.spawn.position[0], g.spawn.position[2],
                     g.spawn.shoreBearing, 470);
                   out[0] = x; out[1] = 150; out[2] = z; return out; },
                 throttle: 0.62, arriveR: 30, maxT: 18 } },
      // LEG 2, THE PASS. 663 m of chord for 150 m of climb - 12.7 deg - and
      // with the 16 deg bias the delivered view sits a few degrees BELOW level.
      // Ashcone is on the leg's own bearing (-42.7 deg against the summit's
      // -41.8), so it grows dead ahead and its summit tracks within ~4 deg of
      // frame centre for the whole run. The endpoint is unchanged, because the
      // hover it feeds is the one shot on this segment that already worked.
      { flyTo: { point: [ISLAND[0] + 170, 300, ISLAND[1] + 190],
                 throttle: 0.62, arriveR: 40, maxT: 24 } },
      // The money shot: hover, pitch down at the crater lagoon and the reef
      // shallows, slow orbit sweep (feedback5 beat 06).
      { hover: { dur: 11, look: [LAGOON[0], -6, LAGOON[1]], orbitRate: 0.06 } },
      // The requested air-to-water seam, first half: fly the VIEW into the
      // vehicle. The dolly converges the chase pose onto the cockpit pose
      // (position, orientation, FOV - vessel.applyCamera), the camera step
      // then flips the mode with zero visible cut, and the windshield HUD
      // arrives with it. The dive itself is the next segment, which carries
      // no cut and no time, so the whole air -> cockpit -> waterline run is
      // one unbroken take.
      { chaseDolly: { dur: 4.5, look: [LAGOON[0], -6, LAGOON[1]] } },
      { camera: 'cockpit' },
      // The bias is a chase-only instrument and the chase view is over; clear
      // it here rather than leaving stop() to do it, so a mid-segment abort
      // cannot hand a tilted chase view back either.
      { chaseBias: 0 },
    ],
  },

  {
    id: 'dive-coral',
    label: 'Dive: fly the transit, enter the water IN the hull, run submerged, dismount, swim',
    title: 'Coral Garden',
    time: null,
    // NO CUT AND NO TIME, on purpose: this segment CONTINUES board-climb's take
    // (director._advanceSegment fades only when a segment carries a cut or a
    // time), so the whole air -> cockpit -> waterline -> reef run is one shot.
    cut: null,
    lamp: null,           // lamp state is player-side; we are piloted here
    timeout: 100,
    beats: [
      { at: 7, name: 'transit' },
      { at: 15, name: 'the-dive' },
      { at: 19, name: 'water-entry' },
      { at: 24, name: 'submerged-run' },
      { at: 29, name: 'reef-arrival' },
      { at: 34, name: 'coral-swim' },
      { at: 39, name: 'reef-fish' },
      { at: 44, name: 'coral-glide' },
    ],
    steps: [
      // THE ENTRY IS FOUR COLLINEAR LEGS AND THAT IS THE WHOLE FIX. Playtest:
      // "the vessel goes down towards the water, it eventually turns left and
      // then we hop out - we should just have the vessel get to the water in a
      // straight path, and enter the water WITH the vessel so people can see
      // it's one continuous environment."
      //
      // The turn was real and structural: the transit arrived from the island
      // on bearing 157.7 deg and the descent runs on the anchor's own 77.5, so
      // the hull swung 80 deg at the last waypoint - right at the waterline.
      // Every leg below is now on the SAME bearing (a.yaw, reached at 640 m out
      // and 120 m up), so the ONLY turn happens in the air, half a kilometre
      // before the sea. `straight: true` opts the descent legs out of the
      // cornering blend as well, or the arc through the corner would bank the
      // hull as it crossed.
      //
      // AND THE HULL NOW GOES UNDER. It used to stop at y = +2 - not by design:
      // the leg targeted `a.viewY + 2` and `viewY` is `null` on every anchor
      // except Canyon Wall, so `null + 2` is 2 and the hull parked AT THE
      // SURFACE while the diver swam the last 20 m alone
      // (feedback5 beat 11 has the vessel as a speck top-left). Depths
      // come off the terrain now.
      //
      // The dive angle is 34 deg, and that is a constraint rather than taste:
      // VESSEL.SKIP_ANGLE is 12 deg and a shallower entry SKIPS off the water.
      { flyTo: { point: (g, out) => { const a = anchor(g, 'coral');
                   const [x, z] = along(a.viewX, a.viewZ, a.yaw + Math.PI, 430);
                   out[0] = x; out[1] = 120; out[2] = z; return out; },
                 throttle: 1.0, arriveR: 40, maxT: 26 } },
      // Down to 30 m over the water, still on the bearing: a 10 deg glide that
      // brings the reef shallows up under the nose.
      { flyTo: { point: (g, out) => { const a = anchor(g, 'coral');
                   const [x, z] = along(a.viewX, a.viewZ, a.yaw + Math.PI, 150);
                   out[0] = x; out[1] = 30; out[2] = z; return out; },
                 throttle: 0.6, arriveR: 18, lead: 40, straight: true, maxT: 25 } },
      // THE ENTRY. 34 deg through the surface. _directSpeedLimit walks the
      // limit down to MAX_SUBSPEED over the time-to-surface window, so this is
      // a real water entry and not a crash - measured elsewhere at 6% of the
      // hull from a Vne dive.
      { flyTo: { point: (g, out) => { const a = anchor(g, 'coral');
                   const [x, z] = along(a.viewX, a.viewZ, a.yaw + Math.PI, 90);
                   out[0] = x; out[1] = g.terrain.sampleHeight(x, z) + 12; out[2] = z; return out; },
                 throttle: 0.5, arriveR: 10, lead: 24, straight: true, maxT: 20 } },
      // 90 m of SUBMERGED flight on the same line, over the coral, so the cut
      // from air to water is something the audience watches rather than infers.
      { flyTo: { point: (g, out) => { const a = anchor(g, 'coral');
                   out[0] = a.viewX; out[2] = a.viewZ;
                   out[1] = g.terrain.sampleHeight(a.viewX, a.viewZ) + 11; return out; },
                 throttle: 0.35, arriveR: 6, lead: 24, straight: true, maxT: 20 } },
      { dwell: { dur: 1.0 } },          // let the hull settle before the hatch
      { disembark: { maxT: 6 } },
      // THE SWIM RUNS AT floor+7, NOT floor+1.2. That single number is note 4:
      // tools/probes/demo-path.mjs measured the old legs passing 0.3 m from a
      // coralBranching and -0.6 m INSIDE a coralFan, which is the reported
      // "we bump into it so it looks clunky". The corridor search
      // (demo-corridor.mjs --anchor coral --up 5,6,7) puts the whole garden at
      // 3.4-4.2 m of clearance at floor+7 with 12,000+ proxy encounters inside
      // 22 m along a 95 m run - so the coral is still dense in the near field,
      // the lens simply rides over the heads instead of through them.
      //
      // THE BEARINGS ARE UNCHANGED AND THAT IS DELIBERATE: they are water
      // evidence, not framing. tools/probes/coral-corridor.mjs re-run on this
      // tree reports 100.0% reef over all three legs and 0/25 kelp cells at
      // every waypoint camp, and moving them would forfeit that.
      { swimTo: { point: (g, out) => { const a = anchor(g, 'coral');
                    const [x, z] = along(a.viewX, a.viewZ, a.yaw + Math.PI - 0.25, 26);
                    return floorPoint(g, out, x, z, 8); },
                  look: (g, out) => { const a = anchor(g, 'coral');
                    const [x, z] = along(a.viewX, a.viewZ, a.yaw + Math.PI - 0.25, 46);
                    return floorPoint(g, out, x, z, 4.5); },
                  arriveR: 2.5, maxT: 20 } },
      // The reef fauna beat the note asks for ("the beauty of coral AND fish").
      // No tier floor: Coppersprat, Azuregraze, Violet Wrasse and the Sunplate
      // are all tier 0 here, and they are what a reef is supposed to be full
      // of. Drifting throughout - the camera never parks.
      //
      // `minRange` IS THE FIX FOR THE SPINNING, AND IT IS PARALLAX RATHER THAN
      // ROTATION. Playtest: "the camera does too many rotations... no need for
      // all that spinning". cut10's own notes name the culprit - "reef fish:
      // tracking tier-0 at 4.8 m" - and a fish crossing the lens at 4.8 m
      // sweeps the bearing through most of a half turn by itself while the
      // gaze does nothing but hold on it. It is the same fault the ossuary
      // segment cured by pushing every gaze 45-90 m out. The floor gates the
      // PICK only; a fish that then swims closer stays tracked, because an
      // approach reads as an approach.
      //
      // 8 -> 14 m, 2026-08-26, and the second reason is a DEPRESSION ANGLE
      // rather than parallax. Playtest: "there's a part where the camera just
      // looks down at the ground". 8 m was sized against the spin alone, and it
      // is too short to bound the pitch: the eye rides floor+8.7 here, so a
      // fish sitting on the sand at the old floor is asin(8.7 / 8) - i.e. the
      // gaze goes STRAIGHT DOWN and the delivered frame is bare seabed, which
      // is exactly the failure the kelp segment's crab beat was measured
      // committing (gaze-base 48/49, tracked at 3.8 m, 72 deg down). At 14 m
      // the worst case is 38 deg and the reef still fills the lower half.
      // Both captured control runs picked at 8.4-8.5 m, i.e. hard against the
      // old floor, so this moves the pick every run rather than rarely.
      // Costing no candidates is not the claim - if nothing qualifies the beat
      // falls back to its own near-level pan (scanPitch -0.05), which is a
      // reef frame either way.
      { watchFauna: { minTier: 0, radius: 26, minRange: 14, dur: 3.5, maxT: 7,
                      name: 'reef fish', move: [0.16, 0, 0], scanPitch: -0.05 } },
      // ONE CLOSING LEG, NOT TWO, and the third of the swim that goes with it.
      // Playtest: "we can make that swimming scene 1/3 shorter". The two legs
      // this replaces ran the gaze out to rel +0.35 and then round again to
      // +0.9, so the swim carried THREE retargets across 66 degrees on top of
      // the fauna beat - and each one also swung through the parallax of a
      // waypoint passed at close range. One leg on rel +0.35, held, is a line
      // through the garden instead.
      //
      // THE BEARING IS LEG 2's, UNCHANGED, and that is deliberate: the coral
      // bearings are water evidence rather than framing
      // (tools/probes/coral-corridor.mjs reports 100.0% reef and 0/25 kelp
      // cells on them), so the leg is EXTENDED along one that was already
      // certified rather than authored on a new one. Measured swim phase:
      // 26.9 s in cut10 against ~18 s here.
      { swimTo: { point: (g, out) => { const a = anchor(g, 'coral');
                    const [x, z] = along(a.viewX, a.viewZ, a.yaw + Math.PI + 0.35, 50);
                    return floorPoint(g, out, x, z, 7); },
                  look: (g, out) => { const a = anchor(g, 'coral');
                    const [x, z] = along(a.viewX, a.viewZ, a.yaw + Math.PI + 0.35, 72);
                    return floorPoint(g, out, x, z, 4.5); },
                  arriveR: 3, maxT: 16 } },
    ],
  },

  {
    id: 'bulb-grove',
    label: 'Bulb Grove: purple pom trees over white sand in the violet lagoon',
    title: 'Bulb Grove',
    time: null,
    cut: 'bulb',
    lamp: false,
    timeout: 30,
    beats: [
      { at: 5, name: 'pom-lagoon' },
      { at: 8, name: 'bulb-trees' },
      { at: 11.5, name: 'grove-glide' },
    ],
    steps: [
      // One slow drift INTO the grove with the trees held in depth ahead -
      // the biome is 14-30 m LAGOON_VIOLET and its subject is the purple
      // canopy against the pale sand, so the gaze rides above the floor line.
      // Framing from tools/shots/bulb.json's wide pose (raised eye, gentle
      // down-angle); the berries are icosphere(0) up close (recorded Bulb
      // Grove deferral), so nothing here swims lens-first into a crown.
      { swimTo: { point: (g, out) => { const a = anchor(g, 'bulb');
                    const [x, z] = along(a.viewX, a.viewZ, a.yaw, 22);
                    return floorPoint(g, out, x, z, 5.0); },
                  look: (g, out) => { const a = anchor(g, 'bulb');
                    const [x, z] = along(a.viewX, a.viewZ, a.yaw, 38);
                    return floorPoint(g, out, x, z, 8); },
                  arriveR: 3, maxT: 12 } },
      // KEEP MOVING FORWARD (playtest: "always move camera forward, dont stop
      // and move backwards" - the old ending drifted back). The crown-line
      // hazard that motivated the reverse is real (a straight push along the
      // yaw ended INSIDE a pom crown - full-frame flat purple, the icosphere
      // deferral at zero distance), so the forward line ANGLES OFF the tree
      // line instead: 0.55 rad starboard passes beside the stands with the
      // gaze held left on the crowns at +7, and the closing drift keeps
      // easing the same way. Endpoint verified against the delivered capture,
      // not the table.
      { swimTo: { point: (g, out) => { const a = anchor(g, 'bulb');
                    const [x, z] = along(a.viewX, a.viewZ, a.yaw + 0.55, 40);
                    return floorPoint(g, out, x, z, 5.4); },
                  look: (g, out) => { const a = anchor(g, 'bulb');
                    const [x, z] = along(a.viewX, a.viewZ, a.yaw + 0.30, 52);
                    return floorPoint(g, out, x, z, 7); },
                  arriveR: 3, maxT: 11 } },
      { dwell: { dur: 3.0, move: [0.10, 0, 0],
                 look: (g, out) => { const a = anchor(g, 'bulb');
                   const [x, z] = along(a.viewX, a.viewZ, a.yaw + 0.45, 58);
                   return floorPoint(g, out, x, z, 7); } } },
    ],
  },

  {
    id: 'crimson-meadow',
    label: 'Crimson Meadow: a low graze through the blood-red grass',
    title: 'Crimson Meadow',
    time: null,
    cut: 'meadow',
    lamp: false,
    timeout: 26,
    beats: [
      { at: 4, name: 'red-carpet' },
      { at: 8.5, name: 'crimson-drift' },
    ],
    steps: [
      // The meadow is one saturated idea (8-28 m of blood-red quills on pale
      // ground) so the scene is short and stays IN the grass: eye at quill
      // height, gaze shallow ahead so the carpet fills the frame in depth,
      // the way tools/shots/meadow.json's graze pose was framed. The pale
      // slopes upper-frame carry a known terrain stair-step artifact
      // (the meadow-wide shot) - the low line keeps them out of the
      // top third until that is fixed.
      { swimTo: { point: (g, out) => { const a = anchor(g, 'meadow');
                    const [x, z] = along(a.viewX, a.viewZ, a.yaw + 0.4, 24);
                    return floorPoint(g, out, x, z, 1.8); },
                  look: (g, out) => { const a = anchor(g, 'meadow');
                    const [x, z] = along(a.viewX, a.viewZ, a.yaw + 0.4, 38);
                    return floorPoint(g, out, x, z, 2.2); },
                  arriveR: 2.5, maxT: 12 } },
      // Drift on with the gaze swung RIGHT along the red band and held LOW.
      // The first capture lifted to +9 up-slope and the frame went mostly
      // pale terrain - which is also where the known stair-step artifact
      // lives - so the drift stays on the carpet at quill height.
      { dwell: { dur: 6.5, move: [0.12, 0, 0],
                 look: (g, out) => { const a = anchor(g, 'meadow');
                   const [x, z] = along(a.viewX, a.viewZ, a.yaw + 0.9, 40);
                   return floorPoint(g, out, x, z, 3); } } },
    ],
  },

  {
    id: 'kelp-dwell',
    label: 'Kelp Forest: the crab, a straight run through the emerald stipes, then up to the light',
    title: 'Kelp Forest',
    time: null,
    cut: 'kelp',
    // The basin floors run 95-194 m and the tour policy would light the lamp
    // below 150 - but KELP_EMERALD is an authored sunlit column (its green Kd
    // is pinned so the whole basin keeps daylight; constants.js row) and the
    // scene is the emerald light itself, so the lamp stays out.
    lamp: false,
    // 62 -> 76 with the 2026-08-26 ascent. The segment used ~30 s of the old
    // cap; it climbs 67 m more now, at the ~3.5 m/s the sink drift leaves of
    // the swim speed, and the run below it is at cruise rather than sprint.
    // Measured ~52 s, so the cap is still a never-stall and not a schedule.
    timeout: 76,
    // THE WHOLE SEGMENT MOVED UP OFF THE FLOOR. Playtest: "the camera gets
    // stuck in floor / rocks early on in that scene", and
    // feedback5 beat 19 is the frame - eye at floor+6, a pale outcrop
    // filling the near field, two thirds seabed. Kelp is not a collidable row,
    // so what actually grounded the lens was ROCK among the stipes, and the
    // corridor search says exactly where the rock stops:
    //
    //   demo-corridor.mjs --anchor kelp --up 8,12,16,20,30   (110 m runs)
    //     floor+16  14.7-15.7 m clear      floor+20  18.3-19.4 m
    //     floor+30  24.0-28.9 m clear      (the old floor+6 is inside it)
    //
    // Anchor floor is -115.9 m and the emerald rebuild's kelp is 124 m tall,
    // so the column above the arrival is the biome, not empty water: entering
    // at floor+16 costs nothing and the stipes still run past the lens.
    // RE-TIMED FOR THE 2026-08-26 ASCENT, and a beat past the real end never
    // fires (this list has lost one that way before), so these come off the
    // MEASURED step timeline of the gaze-fix3 capture rather than off the
    // timeout: entry to ~7 s, crab beat to ~11, the cruise-speed run through
    // the stipes to ~26, the climb to ~41, the dwell to the 44.8 s the segment
    // measured whole.
    beats: [
      { at: 5, name: 'kelp-hall' },
      { at: 9, name: 'the-crab' },
      { at: 18, name: 'through-the-stipes' },
      { at: 32, name: 'the-ascent' },
      // 40, AND THE CEILING IS THE IN-ROUTE LENGTH, NOT THE STANDALONE ONE.
      // The climb is the scene, so the frame worth photographing is the one
      // near the TOP of it - at 38 this beat fired at DEPTH 0049, still well
      // inside the column. 43 was the first try and it NEVER FIRED: the
      // segment measures 44.8 s ridden alone and 42.2 s inside the full route
      // (gaze-final), because the fauna beat and the corner blends are shorter
      // when the run has settled. Size the last beat against the smaller
      // number - it is the one a real press-G ride delivers.
      { at: 40, name: 'gold-canopy' },
    ],
    steps: [
      // IN LOW AND LEVEL, so the crab is IN FRONT rather than 16 m below.
      // Playtest: "start with the little crab in front of us, move straight
      // toward him, past him through kelp, then look upwards toward the
      // surface" - which is a blocking note, and the old entry answered none
      // of it: it arrived at floor+16 with the gaze already 39 degrees UP into
      // the canopy, so the beat that followed could only ever look back down.
      //
      // floor+10 is the lowest the corridor search will certify on the
      // authored bearings (demo-corridor.mjs --anchor kelp --up 8,10,12,16,
      // 110 m runs): 6.2 m of prop clearance on rel 0 and 8.8 m on rel +0.45
      // at floor+10, against 11.1 / 13.9 at floor+16 - comfortably clear of
      // the 2.5 m audit floor, and nothing like the floor+6 that grounded the
      // lens in feedback5/19. Everything from here RISES; the segment never
      // comes back down.
      { swimTo: { point: (g, out) => { const a = anchor(g, 'kelp');
                    const [x, z] = along(a.viewX, a.viewZ, a.yaw, 24);
                    return floorPoint(g, out, x, z, 10); },
                  look: (g, out) => { const a = anchor(g, 'kelp');
                    const [x, z] = along(a.viewX, a.viewZ, a.yaw, 46);
                    return floorPoint(g, out, x, z, 13); },
                  arriveR: 3, maxT: 14 } },
      // THE CRAB. Playtest: "at the very beginning there's a little crab, we
      // can look at it and then move straight through the kelp". That is the
      // Glassclaw - Vitrocheles fragilis, a 0.75 m translucent walking
      // lobster-analog, dangerTier 1, benthic and KELP-resident - and the step
      // has to NAME it: a bare `minTier: 2` took whatever was nearest, which on
      // four captured runs was the Frondmaw. A short beat, drifting on, gaze
      // down onto the floor and then away; the rest of the scene is up.
      // THE DRIFT DRIVES AT HIM NOW INSTEAD OF SINKING ONTO HIM. The old beat
      // was [0.14, 0, -0.75] - almost pure descent - which is what put the
      // seabed in charge of the frame in cut9 frame 23 and cut10 frame 23
      // alike. The note asks to "move straight toward him, past him", so the
      // forward channel carries it and the small sink only trims the last few
      // metres of the depression angle. Coming in at floor+10 (above) is what
      // makes that possible: the crab is 20 degrees down at 25 m instead of
      // 33, i.e. in frame rather than under it.
      //
      // `minRange` IS THE FIX FOR THE FLOOR STARE, AND THE ARITHMETIC IS THE
      // WHOLE ARGUMENT. Playtest 2026-08-26: "there's a part where the camera
      // just looks down at the ground which is not very helpful". The pick had
      // no acquisition floor, so it took the nearest qualifying animal at
      // whatever range that was - gaze-base logged "glassclaw: tracking tier-1
      // at 3.8 m" - and a benthic subject 3.8 m away from an eye riding
      // floor+11.68 is 72 DEGREES DOWN. The delivered frames are the note
      // verbatim: gaze-base 48 and 49 are 88% and 72% flat, bare seabed edge to
      // edge, with the crab a speck in a corner (the good frame, 50, comes two
      // seconds LATER, once the drift has closed the range).
      //
      // The floor is set from the depression angle, not from taste: the eye is
      // 11.68 m over the seabed, so a pick at range R sits at asin(11.68 / R)
      // below the horizon - 72 deg at 3.8 m, 36 deg at 20 m, 29 deg at 24 m.
      // 20 m is the loosest floor that still puts the kelp hall in the top
      // third of the frame, and it leaves a 20-34 m acquisition band against
      // `radius`, which is where the resident Glassclaws actually are. As at
      // the reef, the floor gates the PICK only: the drift then closes ~14 m
      // over the beat and the crab that ends up filling the lens is the same
      // one, arrived at instead of fallen onto.
      //
      // THE DRIFT IS AN ARC NOW, NOT A CHARGE, and the reason is that `move`
      // SETS A DIRECTION, NOT A RATE: the thrust is normalised before it is
      // scaled to the swim speed (player.js), so the diver covers ~4 m/s
      // whatever the channel magnitudes are. A beat that opens 20 m out and
      // runs 4 s therefore has 16 m of travel to spend, and a pure forward
      // channel spends all of it closing - it arrives ON the crab, which is
      // the near-vertical frame this step is trying to stop being. Putting
      // roughly half the channel into STRAFE turns the same 16 m into a curve
      // past the subject: the range closes at ~2.5 m/s instead of ~3.9, the
      // crab still grows to fill a real part of the lens, and the bearing
      // change is the slow parallax of an orbit rather than a lunge.
      //
      // The vertical channel goes with the same arithmetic. [0.60, 0, -0.14]
      // was authored for a gaze that started near-vertical, where the forward
      // axis alone barely descends; from 30 degrees down that forward channel
      // already sinks at half the swim speed, so a negative vertical is a
      // second descent on top of one and the beat lands on the seabed. +0.15
      // leaves a ~1.2 m/s glide down toward the crab's own level, which is
      // what keeps the closing frames off the pole: the diver ends about 5 m
      // over the seabed rather than on it.
      { watchFauna: { species: 'CRT_GLASSCLAW', minTier: 0, radius: 34, dur: 4.0,
                      maxT: 9, name: 'glassclaw', minRange: 16,
                      move: [0.62, 0.26, 0.15], scanPitch: -0.12 } },
      // ONE LONG STRAIGHT RUN THROUGH THE FOREST, mid-column, gaze level and
      // ahead so the stipes stream past on both sides. The old route fought the
      // floor over three short bearings and grounded on every one of them
      // (director-cut8 frame 18, feedback1 19, feedback2 21 - and feedback5's
      // swim timed out 8.5 m short against the same class of blocker).
      // It also RISES as it runs, floor+10 to floor+20 over 50 m of track, so
      // the whole segment is one continuous climb rather than a level run and
      // then a lift. floor+20 is a height the corridor search certified on this
      // bearing (18.3-19.4 m of prop clearance, against 13.9 at floor+16); it
      // is four metres of the ascent's climb bought on a leg that is already
      // running, which costs about a metre of extra track.
      //
      // AND IT NO LONGER SPRINTS, WHICH IS WHAT MAKES THE ASCENT FAST. See the
      // stamina paragraph on the leg below: sprinting here is what left the
      // climb with no sprint to spend. Measured at cruise this leg runs ~15 s
      // against ~8 s sprinting - the climb in it costs more than the distance
      // does - so maxT went 16 -> 20 to stop it timing out 10 m short, and what
      // it buys the ascent is 2.5 m/s.
      { swimTo: { point: (g, out) => { const a = anchor(g, 'kelp');
                    const [x, z] = along(a.viewX, a.viewZ, a.yaw + 0.45, 74);
                    return floorPoint(g, out, x, z, 20); },
                  look: (g, out) => { const a = anchor(g, 'kelp');
                    const [x, z] = along(a.viewX, a.viewZ, a.yaw + 0.45, 104);
                    return floorPoint(g, out, x, z, 34); },
                  arriveR: 3.5, maxT: 20 } },
      // THE ASCENT, which is the rest of the note: "before eventually looking
      // up to see the water surface and swimming closer to it". Sprint, steeply
      // up, out of the basin floor's emerald and into the crowns, with the gaze
      // rising ahead of the body. The basin is an authored sunlit column, so
      // what is overhead is gold fruit and daylight, not black water.
      //
      // IT ACTUALLY REACHES THE SURFACE NOW, AND THE OLD COMMENT HERE WAS
      // WRONG ABOUT WHY IT COULD NOT. Playtest 2026-08-26: "when the camera
      // starts moving up towards the surface, can you make it move faster and
      // get closer to the surface?" The control run (gaze-ctrl) ends the
      // segment at DEPTH 0078 on a -115.9 m floor - 38 m of climb out of 116,
      // no waterline anywhere in the last frame.
      //
      // The previous round concluded "the climb rate is not available to tune
      // ... measured 2.7-3.2 m/s and that is the ceiling" and took the halving
      // out of the DISTANCE instead. That reading was real but the cause was
      // misattributed: the ceiling is STAMINA, not the swim contract. Sprint in
      // water costs STAMINA_SPRINT_DRAIN * 0.78 = 14.04/s against MAX_STAMINA
      // 100 and cuts out at 12, so a diver has 6.3 s of sprint - and the
      // through-the-stipes leg above spent every second of it before this leg
      // began. `sprinting` in _simulateSwim is then false whatever this step
      // asks for, and the climb runs at SWIM_SPEED 4.0, not SWIM_SPRINT_SPEED
      // 6.5. Dropping sprint from the leg above is the whole fix; nothing here
      // needed a new knob.
      //
      // The rate itself is not the vertical channel's 0.62 gain either, and
      // that is why a steep GAZE is load-bearing: _stepSwimTo decomposes the
      // commanded direction onto the body axes, and with the look point 73-79
      // deg up the FORWARD axis does the climbing at the full swim speed. The
      // track below is authored at 66 deg so the body and the thrust agree
      // (f = cos(7 deg) = 0.99); misalign them and the residual has to come out
      // of the 0.62 channel, which is the 3 m/s the old comment measured.
      //
      // THE CLIMB IS STEEP ON PURPOSE - 16 m of forward against 50 of rise, a
      // 72 deg track - AND THAT IS FRAMING, NOT EFFICIENCY. The first cut of
      // this leg ran out to 104 m along while it climbed and delivered exactly
      // the wrong ending: DEPTH 0022 with an empty blue frame and no kelp in it
      // at all (gaze-fix2 69/70). The colony is a place, not a ceiling - it
      // thins as the route walks away from the anchor and the ground under it
      // rises - so a shallow climb leaves the forest sideways at the same time
      // as it leaves it upwards. Rising nearly in place keeps the crowns
      // around the lens all the way up, which is what makes the surface shot a
      // KELP frame instead of a swimming-pool one (gaze-fix2 66, DEPTH 0036:
      // blades, gold light and the sun through the waterline behind them).
      //
      // 74 -> 90 m along, floor+20 (-87) to floor+66 (-37): 50 m of climb over
      // a 52 m track. The rate is ~5 m/s while the sprint lasts and ~2.7 after
      // (SWIM_SPEED against the -1.1 m/s sink drift the suit carries below
      // ~55 m), so ~14 s; maxT 24 leaves the leg room to finish rather than
      // time out short, which is the failure mode that matters here.
      //
      // THE LEG DOES NOT LAND ON ITS AUTHORED HEIGHT - it undershot by ~10 m on
      // the first measured cut and has overshot by 8 on an older one - so -37
      // is a target to MEASURE against, not arithmetic to trust; the dwell
      // below takes the last few metres either way. The look point is
      // deliberately above the waterline: it is a direction, and what it buys
      // is a body pitched hard up all the way to the top of the climb rather
      // than one that levels off as it arrives.
      { swimTo: { point: (g, out) => { const a = anchor(g, 'kelp');
                    const [x, z] = along(a.viewX, a.viewZ, a.yaw + 0.45, 90);
                    return floorPoint(g, out, x, z, 66); },
                  look: (g, out) => { const a = anchor(g, 'kelp');
                    const [x, z] = along(a.viewX, a.viewZ, a.yaw + 0.45, 112);
                    return floorPoint(g, out, x, z, 150); },
                  sprint: true, arriveR: 5, maxT: 24 } },
      // THE LAST FRAME, held under the waterline instead of under the canopy.
      // The gaze is ~14 m ahead and ~90 m up, about 81 degrees, inside the swim
      // contract's 85 degree clamp; the drift keeps easing forward and up so
      // the shot is still moving when the segment cuts.
      //
      // THE OLD CEILING IS GONE WITH THE ROW IT WAS MEASURED ON. "Stop under
      // the canopy, not in it - cut9's ascent ran to floor+76 (-40 m) and the
      // last frame was a single flat green blade" was true of a kelp row with
      // a static height; kelpGiant and kelpCanopy both carry `surfaceCap: 2.5`
      // now (scatter.js), so every plant in the basin is clipped to 2.5 m under
      // the waterline and there is no height at which the diver is above the
      // blades. What changes with depth is therefore DENSITY, not presence, and
      // the shot the playtest asked for - the surface, close - can only be
      // taken from inside the crowns. Judge it on the delivered PNG, which is
      // the only thing that can tell blades-with-daylight-through-them from a
      // wall.
      //
      // THE DWELL CLIMBS ON PURPOSE NOW. It used to be held flat, because the
      // ascent already overshot its waypoint and any further rise put the lens
      // in solid kelp; here the ascent is aimed at the surface, so the ~3 m/s
      // the dwell adds (traced: ~11.7 m in 4 s, carried by a body pitched 80
      // deg up rather than by the channels) is the last of the climb rather
      // than an overshoot of it.
      { dwell: { dur: 3.0, move: [0.12, 0, 0.15],
                 look: (g, out) => { const a = anchor(g, 'kelp');
                   const [x, z] = along(a.viewX, a.viewZ, a.yaw + 0.45, 118);
                   return floorPoint(g, out, x, z, 190); } } },
    ],
  },

  {
    id: 'habitat',
    label: 'Pelagos: cycle in, the commons dome, big fish outside the observatory glass, exit',
    title: 'Pelagos Station',
    time: null,
    cut: 'station',
    lamp: false,
    timeout: 70,
    // Beat times are measured against the step timeline (probe + capture both
    // land the segment at ~33 s): commons arrival ~8.5, dome look 8.5-11,
    // observatory fish look 15.5-22.5, exit swim-away 31.3-32.8.
    beats: [
      { at: 2.5, name: 'station-approach' },
      { at: 8, name: 'commons' },
      { at: 11.5, name: 'commons-dome' },
      { at: 22.5, name: 'observatory-window' },
      { at: 34, name: 'airlock-exit' },
    ],
    steps: [
      // The window shot's Ribbonwether pod is ORDINARY POPULATION now -
      // entities/station_residency.js maintains it whether or not the demo
      // runs (the fauna step that staged it here was a demo-owned
      // creature). The 'station' cut lands ~60-75 m from the pod homes,
      // inside the residency's 170 m activation, so the pod is settled long
      // before the walk reaches the observatory.
      // The arrival stages 34 m north of the airlock, facing it. Swim to the
      // hatch in two legs so the final approach is square-on to the door.
      { swimTo: { point: [HAB.exteriorDoor[0], HAB.exteriorDoor[1] - 0.6, HAB.exteriorDoor[2] - 3.4],
                  arriveR: 1.8, maxT: 22 } },
      { swimTo: { point: [HAB.exteriorDoor[0], HAB.exteriorDoor[1], HAB.exteriorDoor[2]],
                  arriveR: 1.2, maxT: 8 } },
      { interact: { maxT: 5 } },        // cycle in; habitat.tryInteract owns the latches
      { dwell: { dur: 0.8 } },          // a breath for the dry-room arrival
      // Walk the airlock trunk into the commons.
      { walkTo: { point: [HAB.x, HAB.interior.floorY, HAB.z], arriveR: 1.2, maxT: 14 } },
      // Up through the commons glass dome: the water column overhead is the
      // whole point of the room (habitat_mesh.js, buildCommons) - and since
      // the dome-glider residency landed (station_residency.js site 1, the
      // playtest's "can we have some big fish or rays... so we can see
      // them?"), the gaze TRACKS the nearest Sandveil Ray over the glass,
      // falling back to the authored first home (still a dome-apex framing)
      // if the pod is absent - which the notes would then record as a
      // residency bug to chase, not a framing choice.
      { lookAt: { point: (g, out) => residentPoint(g, out, 1, 30), dur: 6 } },
      // Down the east halls to the observatory - the one module glazed on
      // every side, and the reason the station route exists. WAYPOINTED ON
      // THE CORRIDOR AXIS, not one straight shot: walkTo steers a straight
      // bearing and the interior collider slides axis-by-axis, so a diagonal
      // leg drifts to a room wall and can pin in a corner where both axes
      // block (measured: the single-shot return leg wedged at the
      // observatory's NW corner, local (22.9, -2.5), for 15 s). The east
      // halls all sit on local z 0-1.5; short near-axial legs stay in band.
      { walkTo: { point: [HAB.x + 8, HAB.interior.floorY, HAB.z + 0.4],
                  arriveR: 0.9, maxT: 8 } },
      { walkTo: { point: [HAB.x + 25.8, HAB.interior.floorY, HAB.z + 0.4],
                  arriveR: 1.0, maxT: 10 } },
      // The window beat: hold on the pod through the east glass. The gaze
      // tracks the nearest live RESIDENT Ribbonwether within 30 m of the
      // pod's authored centroid - ordinary population found by species, not a
      // demo handle - with the authored home as the fallback if the pod is
      // absent (the director's notes then say the premise was missing, which
      // is a residency bug to chase, not a framing choice).
      { lookAt: { point: (g, out) => residentPoint(g, out, 0, 30), dur: 7 } },
      // The way back, same axis discipline: hall centre, commons, then the
      // trunk. The door bearing straight from the observatory is northwest -
      // exactly the corner-pinning diagonal the note above measures.
      { walkTo: { point: [HAB.x + 20.5, HAB.interior.floorY, HAB.z + 0.15],
                  arriveR: 0.9, maxT: 6 } },
      { walkTo: { point: [HAB.x + 8, HAB.interior.floorY, HAB.z + 0.4],
                  arriveR: 0.9, maxT: 6 } },
      { walkTo: { point: [HAB.x, HAB.interior.floorY, HAB.z - 0.5],
                  arriveR: 0.9, maxT: 8 } },
      { walkTo: { point: [HAB.interiorDoor[0], HAB.interior.floorY, HAB.interiorDoor[2]],
                  arriveR: 1.0, maxT: 8 } },
      { interact: { maxT: 5 } },        // cycle back out
      // Back in the water facing AWAY from the station (the airlock exit now
      // seeds yaw 0, north, open water): swim off the way we are facing. No
      // parting look back - enter facing the station, exit facing away.
      // 2.2 s, not 1.5: the airlock-exit beat at 32 sits at the segment's
      // very end and missed in director-cut2 (segment ended a poll-tick
      // early); the longer swim-away restores its margin.
      { dwell: { dur: 2.2, move: [0.35, 0, 0] } },
    ],
  },

  {
    id: 'platter-forest',
    label: 'Platter Forest at dusk: a smooth line threaded between the glowing disc stacks',
    title: 'Platter Forest',
    // DUSK, NOT MIDNIGHT. 0.92 put the sun 59 degrees below the horizon and the
    // delivered frame was a trunk against pure black
    // (feedback5 beat 28). The rim-lit amber discs are still the
    // subject - that is why this scene is not a day scene - but the column
    // above them needs SOME sky or the stacks float in nothing, and the
    // day-fraction to solar-altitude table is steep here: 0.92 is -59 deg,
    // 0.86 is about -38 (still full night, and cut9 frame 32 shows the left
    // half of the frame still empty black), 0.80 is -17.6 - nautical twilight,
    // which is the first value that actually puts a gradient behind the discs.
    time: 0.80,
    cut: 'platter',
    // No lamp: the disc rims and caps are the light source of the scene and a
    // headlight at the eye has no dark side (the tour-lamp trap) - it would
    // flatten exactly the rim light the dusk cut exists for.
    lamp: false,
    timeout: 46,
    beats: [
      { at: 6, name: 'disc-hall' },
      { at: 13, name: 'starweaver' },
      { at: 20, name: 'between-the-stacks' },
      { at: 25, name: 'disc-rims' },
    ],
    // THE ROUTE IS TWO LONG LEGS AT DISC HEIGHT NOW, NOT THREE SHORT ONES NEAR
    // THE FLOOR. Playtest: "the camera keeps turning around too much and also
    // moved into the platter trunks - can we draw a smooth path between the
    // platters?" Both halves are answered with measurements:
    //
    //  INTO THE TRUNKS. demo-path.mjs measured the old glide leg passing
    //  -1.1 m INSIDE a platterSpire, and the frame shows it. The corridor
    //  search (demo-corridor.mjs --anchor platter --up 10,14,18,24) puts every
    //  bearing at 8-12 m of clearance at floor+24 against 3.1 m or less at
    //  floor+9-12, because a spire is a 46 m column and the old legs ran
    //  through the fattest part of it.
    //
    //  TURNING TOO MUCH. Three legs on three different bearings meant three
    //  gaze retargets, and the Starweaver beat's fallback scan swept +-0.55 rad
    //  on top of them. The scan is halved in director.js and the route is now
    //  two legs on ONE bearing, which the cornering blend joins into a single
    //  continuous line.
    //
    //  WHICH BEARING. An offline enumeration of platterSpire/platterYoung
    //  within 200 m of the anchor puts the densest chain at rel -0.65 rad,
    //  running from (1923, -278) out to (1946, -330) - but flying its axis is
    //  what put the lens IN a trunk, because a chain's axis passes through its
    //  own stands. The corridor search over a 200 m run threads BESIDE it
    //  instead: at rel -0.46 / floor+26 the line holds 10.3 m of clearance
    //  while still logging 2,423 proxy encounters inside 22 m, against 6.2 m
    //  and 2,690 at rel -0.26 and 5.7 m at rel -0.36. Re-run the search if the
    //  anchor ever re-sites; it moved once already for the scoreBias.
    steps: [
      // Sprint out to the near end of the chain (110 m; a cruise swim would
      // spend a third of the segment crossing open water), at disc height.
      { swimTo: { point: (g, out) => { const a = anchor(g, 'platter');
                    const [x, z] = along(a.viewX, a.viewZ, a.yaw - 0.46, 86);
                    return floorPoint(g, out, x, z, 26); },
                  look: (g, out) => { const a = anchor(g, 'platter');
                    const [x, z] = along(a.viewX, a.viewZ, a.yaw - 0.46, 128);
                    return floorPoint(g, out, x, z, 34); },
                  sprint: true, arriveR: 4, maxT: 20 } },
      // The Starweaver is the biome's exclusive resident (tier 1, ten 10 m
      // electric-blue tendrils): track one if it is inside 34 m, otherwise the
      // narrowed scan - drifting down the chain either way.
      { watchFauna: { minTier: 1, radius: 34, dur: 5, maxT: 11, name: 'starweaver',
                      move: [0.12, 0, 0], scanPitch: 0.10 } },
      // ...and on down the chain, same TRACK, but the gaze swung onto the
      // stands and the leg stopped while it is still among them.
      //
      // THE SEGMENT ENDED IN OPEN WATER AND THE ROUTE'S OWN NOTES SAY WHY.
      // Playtest: "the last part mostly just looks at the empty dark sea with
      // a little bit of platters to the left. Just remove that part."
      // cut10 frame 35 is exactly that - the right two thirds are black. The
      // cause is in the bearing paragraph above: the DENSEST CHAIN is at rel
      // -0.65 and the track deliberately threads BESIDE it at -0.46, so a gaze
      // held on the track bearing looks down the gap the corridor search
      // opened rather than at the stands the gap runs past. The track is not
      // negotiable (its axis is what put the lens inside a trunk), so the GAZE
      // moves instead: rel -0.60 puts the chain in the middle of the frame.
      //
      // And the leg stops at 122 m rather than 146: the last 24 m ran out past
      // the end of the chain. With the closing lookAt gone too the segment
      // lands near 32 s against cut10's 43.9.
      { swimTo: { point: (g, out) => { const a = anchor(g, 'platter');
                    const [x, z] = along(a.viewX, a.viewZ, a.yaw - 0.46, 122);
                    return floorPoint(g, out, x, z, 26); },
                  look: (g, out) => { const a = anchor(g, 'platter');
                    const [x, z] = along(a.viewX, a.viewZ, a.yaw - 0.60, 150);
                    return floorPoint(g, out, x, z, 38); },
                  arriveR: 4, maxT: 16 } },
    ],
  },

  {
    id: 'ossuary',
    label: 'The Pale Ossuary: an arc around the skull and out over the glowing bone flats',
    title: 'The Pale Ossuary',
    // Explicit day: the platter segment above runs at dusk, and the ossuary
    // sits at 341 m where the 319.8-520 m aphotic fade still passes a little
    // daylight - the reviewed look was a day frame, so restore it.
    time: 0.40,
    cut: 'skull',
    lamp: true,
    timeout: 40,
    beats: [
      { at: 4, name: 'skull-dome' },
      { at: 10, name: 'bone-flats' },
      { at: 16, name: 'fluorescent-drift' },
      { at: 21, name: 'ossuary-wide' },
    ],
    // NOTE 8, AND IT WAS TWO FAULTS WITH ONE CAUSE. Playtest: "the camera faces
    // down towards the ground with nothing to see and it spins around itself -
    // it should just move above ground so we can see what's there."
    //
    //  FACING DOWN: the eye sat at floor+7 and every gaze target was authored
    //  at floor+5, so the whole segment looked at dirt a few metres away.
    //  Feedback5 beat 32 is a white lamp hotspot on bare ground - the
    //  suit lamp at 341 m blowing out a surface that close.
    //
    //  SPINNING: `lookAt` at a point ten metres away, held while the diver
    //  drifts PAST it, swings the bearing through 180 degrees on its own. It
    //  is not a rotation the route asked for, it is parallax. Every gaze here
    //  is now 45-90 m out, where drift cannot swing it.
    //
    // The eye rides at floor+22-26, which the corridor search puts at 13-14.5 m
    // of clearance over the bone field with 3,000+ proxy encounters inside
    // 22 m - so there IS something to see, it is simply no longer pressed
    // against the lens. Bearings below are measured from the SKULL, whose
    // arrival sits 22 m out at 0.95 rad.
    // ...BUT NOT SO HIGH THAT THERE IS NOTHING LEFT. The first correction
    // overshot: at floor+24 with a level gaze the frame was open blue water and
    // a few glow motes, and the skull was a silhouette 56 m off at the bottom
    // edge (cut9 frames 36-37). Both faults are the same axis and the answer is
    // the middle of it - floor+13, which the corridor search still puts at
    // 7.3-8.1 m of clearance with 4,500-6,100 proxy encounters inside 22 m, and
    // a gaze aimed 45-70 m out and slightly BELOW the eye so the field runs
    // away into depth across the lower two thirds.
    steps: [
      // Rise off the arrival and swing wide, holding the skull dome broadside -
      // close enough (34 m) that the suit lamp reaches it and it reads as a
      // skull rather than as a dark mass.
      { swimTo: { point: (g, out) => { const [x, z] = along(SKULL.x, SKULL.z, 1.72, 34);
                    return floorPoint(g, out, x, z, 13); },
                  look: (g, out) => floorPoint(g, out, SKULL.x, SKULL.z, 12),
                  arriveR: 3.5, maxT: 15 } },
      // Out across the flats: the lamp-lit bone field and its glow beds passing
      // UNDER the drift instead of filling it or being left behind.
      { swimTo: { point: (g, out) => { const [x, z] = along(SKULL.x, SKULL.z, 2.35, 76);
                    return floorPoint(g, out, x, z, 13); },
                  look: (g, out) => { const [x, z] = along(SKULL.x, SKULL.z, 2.55, 120);
                    return floorPoint(g, out, x, z, 6); },
                  arriveR: 3.5, maxT: 20 } },
      // Keep going, gaze swinging slowly off the track - a long look ACROSS the
      // field, never at it.
      { dwell: { dur: 6.5, move: [0.26, 0, 0.02],
                 look: (g, out) => { const [x, z] = along(SKULL.x, SKULL.z, 2.15, 136);
                   return floorPoint(g, out, x, z, 10); } } },
    ],
  },

  {
    id: 'jelly-hollow',
    label: 'Glow Cave: board, straight down the shaft, run the bore, coast the magenta hall',
    title: 'Glow Cave',
    time: null,
    cut: 'jelly',
    // THE HULL IS PARKED ALREADY NOSED AT THE SHAFT. Playtest: "when we jump in
    // the vehicle and start going through the tunnel, we initially look in the
    // wrong direction before going in the tunnel to the left - we should just
    // go to the left directly." The board hands the cockpit whatever heading
    // the hull was parked on, and the old park used a hand-written atan2
    // against a guessed mouth position, so the first cockpit frame faced off
    // the bore and the first flyTo had to swing the nose - which, because the
    // aim IS the flight direction, reads as a hunt. Aiming the park at the
    // resolved corridor waypoint makes the very first frame the right frame.
    onStart: (g) => {
      const px = 20, pz = 2016;
      const y = g.terrain.sampleHeight(px, pz) + 2.2;
      const w = jellyWp([0, 0, 0], 0, 18);
      g.vessel.teleport(px, y, pz, Math.atan2(w[0] - px, -(w[2] - pz)), -0.18);
    },
    // No lamp: fourteen authored jellyshroom stands and their volumetric cap
    // lights ARE the scene (render/passes/caves.js), and the magenta only
    // survives because of the cave sight-chroma neutralisation - a white
    // headlight at the eye would wash the one colour the cavern is about.
    lamp: false,
    timeout: 62,
    beats: [
      { at: 1.6, name: 'cave-mouth' },
      { at: 9, name: 'shaft-descent' },
      { at: 14, name: 'corridor-run' },
      { at: 21, name: 'cavern-reveal' },
      { at: 26, name: 'shroom-giant' },
      { at: 33, name: 'chandelier-ceiling' },
    ],
    steps: [
      // A breath at the mouth (and the mesh workers' settle), then board.
      { dwell: { dur: 1.6, look: (g, out) => jellyWp(out, 0, 10) } },
      { swimTo: { point: (g, out) => { out.set(g.vessel.position); return out; },
                  arriveR: 3.2, maxT: 10 } },
      { board: { maxT: 8 } },
      // Floods on for the bore - the corridor is under 80+ m of rock and has
      // no light of its own; they go dark again just before the hall so the
      // magenta reveal is the jellyshrooms', not the floods'.
      { lights: true },
      // THE BORE, 50% FASTER. Playtest: "we should also go through the tunnel
      // 50% faster, it's a bit slow." 0.4 -> 0.6 and 0.55 -> 0.8 on the
      // authored centreline (world/cave_sites.js owns the deltas; jellyWp
      // resolves them, so the run follows the spec if the spec moves). The
      // bores are 26-30 m across and the aim-is-track rule means every
      // waypoint is also the framing.
      { flyTo: { point: (g, out) => jellyWp(out, 0, 26), throttle: 0.6, arriveR: 8, maxT: 9 } },
      { flyTo: { point: (g, out) => jellyWp(out, 0, 0), throttle: 0.6, arriveR: 7, maxT: 9 } },
      { flyTo: { point: (g, out) => jellyWp(out, 1, 0), throttle: 0.8, arriveR: 7, maxT: 8 } },
      { flyTo: { point: (g, out) => jellyWp(out, 2, 0), throttle: 0.8, arriveR: 7, maxT: 8 } },
      { flyTo: { point: (g, out) => jellyWp(out, 3, 0), throttle: 0.8, arriveR: 7, maxT: 8 } },
      { flyTo: { point: (g, out) => jellyWp(out, 4, 0), throttle: 0.75, arriveR: 7, maxT: 8 } },
      // THE FLOODS STAY ON, and this reverses a rule that had been in the route
      // since the cave landed ("they go dark just before the hall so the magenta
      // reveal is the jellyshrooms'"). That rule was written for a DIVER, whose
      // eye ends up 14 m from a 16 m cap; from the hull the same hall
      // photographed as blue smears on black in BOTH cut9 and cut10 (frames
      // 43-44 of each), because a jellyshroom lights itself and a few metres
      // around it and nothing else in a cave lights anything at all. The
      // corridor frames are the counter-evidence: flood-lit, the bore reads as
      // saturated magenta rock rather than as washed-out white, because
      // RENDER.CAVE_SIGHT_NEUTRAL keeps the authored colour on every beam leg
      // inside a cave. Lit is what makes the hall a hall.
      // THE HALL IS FLOWN, NOT WALKED. Playtest: "once in the cave, no need to
      // exit the vehicle to swim around - we can just look a bit while in the
      // vehicle." The dismount, the seat swim, the giant dwell, the hall cross
      // and the ceiling tilt were five steps and ~25 s of the segment; they are
      // one slow coast and two hovers now. A hover is the step that pans (the
      // throttle is centred, which commands a STOP, so the aim sweeps the
      // camera without flying a circle) - which is exactly the "look a bit"
      // the note asks for, and it keeps the hull's own cabin glow in frame.
      // PARK NEXT TO THE GIANT STAND, NOT MID-HALL. The first vessel-borne cut
      // of this scene coasted to the hall centre with the floods dark and
      // photographed near-black (cut9 frames 43-44): a jellyshroom cap lights
      // ITSELF and a few metres around it, so at 30 m it is a blue smear. The
      // swim route this replaced worked because the diver ended up 14 m from
      // the 16 m caps. Fly to the same distance instead.
      { flyTo: { point: (g, out) => { const c = JELLY.caveArrival;
                   out[0] = c.x - 3; out[1] = c.y + 6; out[2] = c.z - 13; return out; },
                 throttle: 0.35, arriveR: 4, maxT: 12 } },
      // The reveal: hold on the giant stand to the east - the 16 m caps 14 m
      // east of the seat are the largest authored stands in the cave
      // (world/cave_sites.js, JELLY_SITE) - with a slow sweep across them.
      { hover: { dur: 6, orbitRate: 0.05,
                 look: (g, out) => { const c = JELLY.caveArrival;
                   out[0] = c.x + 14; out[1] = c.y + 4; out[2] = c.z - 4; return out; } } },
      // Coast west across the hall so the stands pass in depth...
      { flyTo: { point: (g, out) => { const c = JELLY.caveArrival;
                   out[0] = c.x - 22; out[1] = c.y + 7; out[2] = c.z + 4; return out; },
                 throttle: 0.3, arriveR: 5, maxT: 10 } },
      // ...then tilt up into the lit speleothems and hold.
      { hover: { dur: 5.0, orbitRate: 0.04,
                 look: (g, out) => { const c = JELLY.caveArrival;
                   out[0] = c.x - 6; out[1] = c.y + 20; out[2] = c.z - 6; return out; } } },
      // STEP OUT BEHIND THE FADE, and this one is load-bearing rather than
      // cosmetic: the next segment is a SWIM, and cut9 ran the whole Splitmaw
      // scene from the cockpit because nothing here ever left the hull - every
      // swimTo logged 'while piloted - skipped' and the splitmaw never entered
      // frame (cut9 frame 49). The playtest's "no need to exit the vehicle to
      // swim around" is about the CAVE; the hatch still has to open before the
      // dunes.
      //
      // IT DOES NOT COST NOTHING ON SCREEN, AND THE FADE HAS TO COME FORWARD.
      // This clause used to end "it costs nothing on screen - the segment's
      // own fade to black covers it", and that was wrong. Playtest: "in the
      // jellyshroom cave, last part of it, we see our own vessel for a second.
      // We can cut that. We are supposed to just be inside our vessel looking
      // at the cave." The dismount is the only thing in this segment that can
      // show the hull at all - the cockpit eye is inside it and back-face
      // culling deletes it - and the boundary fade does not start until the
      // segment ENDS - so it cost the whole 0.45 s of FADE_OUT, fully lit,
      // from a diver's eye a metre off the hull.
      // The `fadeOut` step runs the picture to black BEFORE the hatch opens;
      // the following segment's cut then finds it already there.
      { fadeOut: 0.45 },
      { disembark: { maxT: 6 } },
    ],
  },

  {
    id: 'sunken-dunes',
    label: 'Sunken Dunes: the bone plain, a rise above it, and the Splitmaw coming for you',
    title: 'Sunken Dunes',
    // Back to day: DUNE_AZURE's whole identity is 121 m of clear azure sight
    // at 340 m (the one deep biome with clear water), and 'it hunts by sight
    // over open sand - you see it coming' only photographs in the light.
    time: 0.40,
    // The ANCHOR cut, not a computed stage. The residency respawns the
    // Splitmaw AT ITS HOME POINT on the first update after a teleport
    // (entities/leviathan_residency.js), and the home was sited 105 m from
    // this anchor precisely so an arrival materialises it in frame.
    cut: 'dunes',
    // No lamp: open azure water under the aphotic fade's remaining daylight;
    // a headlight would flatten the 121 m sightline the scene depends on.
    lamp: false,
    // The take is 17 s delivered and the steps' own caps sum to 33, so 40 is
    // margin on the slow path rather than a number anything normally reaches.
    // It matters that it IS margin: the segment timeout is a hard cut and would
    // truncate the swallow, which is the one frame the segment exists for.
    timeout: 40,
    // THE BLOCKING IS THE NOTE, ALMOST WORD FOR WORD: "the camera turns right
    // and we can see bones on the ground, we should then start moving forward
    // and up to swim above the bones - at that moment the monster sees us and
    // comes at us, because currently the monster is going through the bones and
    // causes clipping."
    //
    // The geometry cooperates. Measured from the anchor: the nearest
    // duneColossus - the ribcage in feedback5 beat 41 - is 23 m out at
    // rel +2.45 rad, and the Splitmaw's residency home is at rel +3.08, i.e.
    // very nearly straight behind. So ONE rightward sweep of about 140 degrees
    // puts the bones in frame and leaves the splitmaw's ground dead ahead. The
    // sweep is a `turn` with `dir: +1` rather than a lookAt, so it cannot take
    // the short way round to the left.
    //
    // The rise is what stops the clipping, and it is belt AND braces:
    // entities/dune_ambush.js floors the posed body 22 m over the heightfield
    // (MIN_GROUND_CLEARANCE), and the splitmaw now WAITS for the diver to clear
    // TURN_ALTITUDE before it commits, so the whole turn-and-rise happens
    // during PROWL by construction rather than by a stopwatch that happened to
    // fit one run.
    //
    // RE-TIMED 2026-08-21 against a 500 ms trace of the running segment rather
    // than against the step timeouts. Delivered on that trace: the sweep onto
    // the bones lands t+8, the splitmaw commits and squares up t+8.4-10, comes at
    // the diver through the whole climb, the climb hands over t+14.4, the run
    // releases t+15.5 and the maw takes the lens at t+16.8. Expect a second or
    // two of spread - the take starts from wherever the patrol left the animal,
    // which is why the segment cuts on DuneAmbush's own latch and not on a beat.
    beats: [
      { at: 3, name: 'dune-plateau' },
      { at: 8, name: 'the-bones' },
      { at: 10, name: 'it-sees-us' },
      { at: 13, name: 'the-approach' },
      { at: 16, name: 'maw' },
    ],
    steps: [
      // A short drift into the plain off the anchor's curated view.
      { swimTo: { point: (g, out) => { const a = anchor(g, 'dunes');
                    const [x, z] = along(a.viewX, a.viewZ, a.yaw, 15);
                    return floorPoint(g, out, x, z, 9); },
                  look: (g, out) => { const a = anchor(g, 'dunes');
                    const [x, z] = along(a.viewX, a.viewZ, a.yaw, 44);
                    return floorPoint(g, out, x, z, 11); },
                  arriveR: 3.5, maxT: 7 } },
      // TURN RIGHT ONTO THE BONES, gaze dropping onto the ribcage as it comes
      // round. `toPoint` + `dir: +1` derives the sweep at step start, so it
      // lands on the colossus wherever the drift above left the heading.
      // -0.16, not -0.30: at floor+9 with the ribcage 23 m off, a third of a
      // radian of down-pitch puts the bones in the top-left corner and fills
      // the frame with sand (cut10 frame 47). The arch is only a few degrees
      // below the eye at that range.
      { turn: { toPoint: (g, out) => floorPoint(g, out, DUNE_BONES[0], DUNE_BONES[1], 9),
                dir: 1, dur: 4.4, rate: 1.0, pitch: [-0.02, -0.16] } },
      // FORWARD AND UP, over the field, and THE AUTHORED HEIGHT IS NOT THE
      // DELIVERED HEIGHT. `_stepSwimTo` decomposes the world direction onto the
      // diver's own body axes and clamps each channel to +/-1, so a target 52 m
      // ahead and 30 m up spent most of its budget going FORWARD: traced at
      // 500 ms, this leg ran its full 11 s, timed out 20.4 m short, and
      // delivered 12.0 m of clearance over the seabed.
      //
      // That is not cosmetic here. dune_ambush holds the posed body 22 m over
      // the terrain (MIN_GROUND_CLEARANCE, sized to clear the bone arches), so
      // the charge cannot reach a diver below its own floor - at 12 m the maw
      // passed TEN METRES OVERHEAD instead of through the lens. Pulling the
      // waypoint IN to 34 m and UP to 44 steepens the direction so the vertical
      // channel takes the larger share.
      //
      // The leg no longer has to finish the climb on its own, either: the
      // splitmaw WAITS for the diver to clear TURN_ALTITUDE (dune_ambush.js)
      // rather than racing a stopwatch, and the drift on the watchFauna step
      // below keeps easing the diver up along an upward gaze while it tracks.
      //
      // SHORT, THOUGH - 7 s, from 13, on a waypoint pulled in to 16 m. The
      // splitmaw's whole beat is now "notices, comes, eats" with nothing in front
      // of it (dune_ambush.js retired the prowl-length wait and the broadside
      // cross), so the climax lands about five seconds after it commits. This
      // leg has to be DONE before that, or the strike happens while the camera
      // is still pointed at the climb - which is exactly the fault the first
      // cut of this rebuild shipped.
      { swimTo: { point: (g, out) => { const a = anchor(g, 'dunes');
                    const [x, z] = along(a.viewX, a.viewZ, a.yaw + 2.9, 16);
                    return floorPoint(g, out, x, z, 40); },
                  look: (g, out) => { const a = anchor(g, 'dunes');
                    const [x, z] = along(a.viewX, a.viewZ, a.yaw + 3.0, 96);
                    return floorPoint(g, out, x, z, 54); },
                  sprint: true, arriveR: 6, maxT: 6 } },
      // THE CLIMAX, AND IT ENDS INSIDE THE MOUTH. Hold the track while the
      // ambush turns the ninety-metre splitmaw in, runs the charge, springs the
      // mandible cage open over the last three seconds and swallows the lens;
      // `until` cuts the step on DuneAmbush's own SWALLOW latch rather than on
      // a stopwatch, because the charge starts from wherever the patrol AI left
      // the animal and the arrival moves by seconds between runs. `dur`/`maxT`
      // still bound it, so a run where the splitmaw never arrives degrades to a
      // timed track instead of hanging.
      //
      // SAFETY IS STRUCTURAL even though the animal now passes THROUGH the
      // diver: the charge is POSE-DRIVEN (behaviour IDLE, targetKind NONE,
      // threat 0, dune_ambush.js), so the real ATTACK state machine and its
      // 90-of-100 HP contact never execute, and nothing in the sim gives a
      // creature a collision body against the player. The drift channel keeps
      // the diver easing forward through the whole track.
      //
      // THE DRIFT IS STRAIGHT UP, AND IT USED TO BE FORWARD. `move` writes the
      // VirtualInput's axes and an axis is not a throttle - `move: [0.06, 0, 0]`
      // reads as FORWARD, full stop, so the diver swam at 3.8 m/s straight down
      // the splitmaw's throat and ate the run's whole runway before it started.
      // Vertical instead: the climb step hands over at about 15 m of clearance
      // and stalls there, the run will not release below TURN_ALTITUDE's 18, and
      // a diver still rising while ninety metres of animal squares up on them is
      // the read the beat wants anyway.
      //
      // radius 260 -> 300: acquisition has to survive twice the animal's
      // stand-off. `aimBody` is the other half of the same problem - the gaze
      // tracks the nearest point on the animal's own axis instead of its
      // ORIGIN, which on a ninety-metre body is 45 m behind the snout: without
      // it the swallow frame was the mandible junction with the maw off-camera.
      { watchFauna: { minTier: 5, radius: 300, dur: 12, maxT: 16, name: 'splitmaw',
                      move: [0, 0, 0.5], aimBody: true,
                      until: (g) => g.duneAmbush?.phase >= DUNE_AMBUSH_PHASE.SWALLOW } },
      // Black BEFORE the body has finished going past, so the cut lands on maw
      // rather than on flank. fadeOut blocks until demoFade reaches 1.
      { fadeOut: 0.5 },
    ],
  },

  {
    id: 'finale',
    label: 'Golden hour: rise through the lagoon shallows and broach facing the island',
    title: 'Ashcone Lagoon',
    time: 0.735,          // just before sunset
    cut: (g) => {
      const [x, z] = along(g.spawn.position[0], g.spawn.position[2], g.spawn.shoreBearing, 150);
      return { target: { x, z },
               opts: { yaw: g.spawn.shoreBearing + Math.PI, pitch: 0.12, label: 'Lagoon shallows' } };
    },
    lamp: false,
    timeout: 34,
    beats: [
      { at: 1.6, name: 'golden-rise' },
      { at: 8, name: 'broach' },
      { at: 11.5, name: 'end-card' },
    ],
    steps: [
      // Rise to the surface with the island summit held in frame.
      { swimTo: { point: (g, out) => {
                    const [x, z] = along(g.spawn.position[0], g.spawn.position[2],
                      g.spawn.shoreBearing, 145);
                    out[0] = x; out[1] = -1.0; out[2] = z; return out; },
                  look: [ISLAND[0], 70, ISLAND[1]],
                  arriveR: 1.6, maxT: 18 } },
      // Hold at the surface, treading, facing the island in the last light.
      { dwell: { dur: 13, look: [ISLAND[0], 55, ISLAND[1]], move: [0.2, 0, 0.3] } },
      { note: 'SUBWAVE showcase complete' },
    ],
  },
];
