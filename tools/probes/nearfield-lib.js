/**
 * Shared trial body for the near-field churn probes.
 *
 * Loaded by tools/probes/nearfield-stationary.js and
 * tools/probes/nearfield-swim.js through the dev server, so the two runs are
 * BYTE-IDENTICAL apart from whether the player is moving. That is the whole
 * point: the reported bug is "the near field churns WHILE THE PLAYER MOVES",
 * and every previous measurement of the director pinned the player, so the
 * stationary run is the control and the difference between them is the result.
 *
 * WHAT THIS DISCRIMINATES. The prior diagnosis ("CHURN") was read
 * off a probe that only ever recorded an animal while it was within 30 m, so
 * "zero survivors" is equally consistent with a SPARSE near field. This one
 * separates the two by attributing every removal to a branch:
 *
 *   nearOut            spawner._cull's near-field retirement (d > _nearRelease)
 *   reclaim            the budget-reclaim branch
 *   distanceOrBudget   plain DESPAWN_DISTANCE / over-band-budget
 *   eaten / killed     predation, which is not a director decision at all
 *   NONE               the agent is never removed - it just leaves the frustum,
 *                      or was never near in the first place
 *
 * Cause counts are cross-checked against spawner.stats.nearFieldRetired and
 * .nearFieldReclaimed, which _cull increments itself, so the attribution is not
 * only a reconstruction.
 */

/** Mirrors the module-private table in spawner.js. */
const DESPAWN_DISTANCE = [600, 600, 600, 900, 1400, 1400];
const EYE = [0, -8, 240];
const NEAR_BINS = [10, 20, 30, 45];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r2 = (v) => (v === null || v === undefined ? null : +v.toFixed(2));

/**
 * Run one trial.
 *
 * @param {object} opts
 * @param {boolean} opts.swim  true: hold W and depth-hold with pitch. false:
 *   the position is pinned after each simulate, which is exactly what every
 *   prior measurement of this director did.
 * @param {number} opts.seconds  measurement window after the fill
 * @param {number} opts.fillMs   time to let the director reach steady state
 * @returns {Promise<object>} raw measurements
 */
export async function runTrial({ swim, seconds = 32, fillMs = 12000 }) {
  const g = window.subwave;
  const sim = g.creatures;
  const sp = g.spawner;
  const { depthBandIndex } = await import('/src/core/constants.js');

  // ---- setup -------------------------------------------------------------
  g.player.inVessel = false;
  g.player.position.set(EYE);
  g.player.velocity[0] = 0; g.player.velocity[1] = 0; g.player.velocity[2] = 0;
  g.player.yaw = -Math.PI / 2;          // due west: the flattest 140 m of lagoon
  g.player.pitch = 0;
  g.input.pointerLocked = true;

  // PIN, but only the position. The real simulate still runs, so state
  // selection, the waterline, the orientation model and the creature perception
  // context are all the ones the game actually uses. BOTH modes are pinned for
  // the fill, so the two trials open their measurement window from the same
  // steady state and the only difference between them is the movement itself. A
  // diver is positively buoyant (measured 0.43 m/s of rise with no input), so an
  // unpinned fill would float the eye from 8 m to 3 m before the window opened.
  const realSimulate = g.player.simulate.bind(g.player);
  const pin = (dt, input, t) => {
    realSimulate(dt, input, t);
    g.player.position[0] = EYE[0];
    g.player.position[1] = EYE[1];
    g.player.position[2] = EYE[2];
    g.player.velocity[0] = 0; g.player.velocity[1] = 0; g.player.velocity[2] = 0;
  };
  g.player.simulate = pin;

  await sleep(fillMs);
  if (swim) g.player.simulate = realSimulate;

  // ---- instrumentation ---------------------------------------------------
  const t0 = performance.now();
  const now = () => (performance.now() - t0) / 1000;

  /** handle -> record */
  const seen = new Map();
  const removed = [];
  const causeCount = { nearOut: 0, reclaim: 0, distanceOrBudget: 0, eaten: 0,
    killed: 0, cull: 0, unattributed: 0 };
  /** Removals of agents that were EVER within the near-field radius of us. */
  const causeCountNear = { nearOut: 0, reclaim: 0, distanceOrBudget: 0, eaten: 0,
    killed: 0, cull: 0, unattributed: 0 };

  let playerPath = 0;
  const prevP = [g.player.position[0], g.player.position[1], g.player.position[2]];
  const drawn20 = [];   // creaturePass.stats.instances at 20 Hz, because a
                        // per-second sample that never moves is exactly what a
                        // FROZEN counter looks like as well.

  const realDespawn = sim.despawn.bind(sim);
  sim.despawn = (handle, reason = 'despawn') => {
    const i = sim.slotOf(handle);
    if (i >= 0) {
      const p = g.player.position;
      const d = Math.hypot(sim.posX[i] - p[0], sim.posY[i] - p[1], sim.posZ[i] - p[2]);
      const tier = sim.tier[i];
      const flag = sp._nearFieldSlot[i];
      const band = depthBandIndex(Math.max(0, -sim.posY[i]));
      const nearOut = flag === 1 && d > sp._nearRelease;
      const reclaim = !nearOut && flag === 0 && band === sp._eyeBand && tier <= 2 &&
        d > sp._nearRelease * 2;
      const far = d > DESPAWN_DISTANCE[tier];
      let cause;
      if (reason !== 'despawn') cause = reason;
      else if (nearOut) cause = 'nearOut';
      else if (reclaim) cause = 'reclaim';
      else if (far) cause = 'distanceOrBudget';
      else cause = 'unattributed';
      if (cause in causeCount) causeCount[cause]++; else causeCount.unattributed++;
      const rec = seen.get(handle);
      if (rec && rec.everNear) {
        if (cause in causeCountNear) causeCountNear[cause]++;
        else causeCountNear.unattributed++;
      }
      removed.push({
        cause, d: r2(d), tier, nearFieldSlot: flag,
        unseenT: r2(sim.unseenT[i]), behaviour: sim.behaviour[i],
        t: r2(now()),
        age: rec ? r2(now() - rec.firstT) : null,
        everNear: rec ? rec.everNear : false,
        everInFrustum: rec ? rec.everInFrustum : false,
        everWithin20: rec ? rec.everWithin20 : false,
        minD: rec ? r2(rec.minD) : null,
        nearDwell: rec && rec.firstNearT !== null
          ? r2(rec.lastNearT - rec.firstNearT) : null,
        playerTravelDuringNearDwell: rec && rec.firstNearT !== null
          ? r2(rec.lastNearPath - rec.firstNearPath) : null,
      });
    }
    return realDespawn(handle, reason);
  };

  // ---- drive the player --------------------------------------------------
  let servo = null;
  if (swim) {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    // A diver is positively buoyant here (measured 0.43 m/s of rise with no
    // input), so a real player holds depth by aiming slightly down. This writes
    // the AIM, which is what the mouse writes, and nothing else.
    servo = setInterval(() => {
      const err = EYE[1] - g.player.position[1];
      g.player.pitch = Math.max(-0.35, Math.min(0.35, 0.12 * err));
    }, 100);
  }

  // ---- 20 Hz agent tracker ----------------------------------------------
  const R = sp._nearRadius || 45;
  // THE ALONG-TRACK SHARE, which is the statistic the whole conveyor argument
  // turns on and which had never been measured live.
  //
  // In the eye frame a near-field animal drifts backwards at the swim speed
  // (its own self-motion is measured below and is ~0.37 m/s against ~4 m/s of
  // diver). If the director seeds uniformly over a disc that is co-moving with
  // the eye and never injects anything at the leading edge, continuity gives a
  // density ramp n(x, y) proportional to sqrt(R^2 - y^2) - x: exactly zero at
  // the FRONT of the ball and maximal at the back. Its forward-half integral is
  // 2R^3/3 of a total 8R^3/3, so the predicted forward share is 0.250 moving
  // against 0.500 standing still. Measuring it separates "there are too few
  // animals" from "the animals are all behind you", which the population counts
  // alone cannot do.
  //
  // The travel direction is the player velocity filtered over VEL_TAU, because
  // an unfiltered per-tick velocity is dominated by the stroke surge; it is
  // horizontal because the seeding draw is horizontal.
  const VEL_TAU = 0.5;
  const LEAD_MIN_SPEED = 1.0;      // below this the direction is noise
  const travel = [0, 0];
  let lastTickT = null;
  const forwardShare20 = [];       // {t, share, n}
  const tick = () => {
    const p = g.player.position;
    const step = Math.hypot(p[0] - prevP[0], p[1] - prevP[1], p[2] - prevP[2]);
    playerPath += step;
    const t = now();
    const dtTick = lastTickT === null ? 0 : t - lastTickT;
    if (dtTick > 0) {
      const a = 1 - Math.exp(-dtTick / VEL_TAU);
      travel[0] += ((p[0] - prevP[0]) / dtTick - travel[0]) * a;
      travel[1] += ((p[2] - prevP[2]) / dtTick - travel[1]) * a;
    }
    lastTickT = t;
    prevP[0] = p[0]; prevP[1] = p[1]; prevP[2] = p[2];
    drawn20.push(g.creaturePass.stats.instances);
    const tSpeed = Math.hypot(travel[0], travel[1]);
    const ux = tSpeed > 1e-6 ? travel[0] / tSpeed : 0;
    const uz = tSpeed > 1e-6 ? travel[1] / tSpeed : 0;
    let fwdIn = 0, fwdTotal = 0, westIn = 0;
    const cam = g.renderer.camera;
    for (const i of sim.liveSlots()) {
      const h = sim.handleOf(i);
      const d = Math.hypot(sim.posX[i] - p[0], sim.posY[i] - p[1], sim.posZ[i] - p[2]);
      let rec = seen.get(h);
      if (!rec) {
        rec = { firstT: t, firstD: d, tier: sim.tier[i], species: sim.species[i],
          nearFieldSlot: sp._nearFieldSlot[i], everNear: false,
          firstNearT: null, lastNearT: null, firstNearPath: 0, lastNearPath: 0,
          minD: d, lastT: t, everInFrustum: false, firstFrustumD: null,
          everWithin20: false };
        seen.set(h, rec);
      }
      rec.lastT = t;
      if (d < rec.minD) rec.minD = d;
      if (d <= 20) rec.everWithin20 = true;
      if (d <= R) {
        rec.everNear = true;
        if (rec.firstNearT === null) { rec.firstNearT = t; rec.firstNearPath = playerPath; }
        rec.lastNearT = t; rec.lastNearPath = playerPath;
        if (sp._nearFieldSlot[i] === 1) {
          fwdTotal++;
          if ((sim.posX[i] - p[0]) * ux + (sim.posZ[i] - p[2]) * uz > 0) fwdIn++;
          // The same share against the FIXED axis both trials travel/face along
          // (due west, -X). The stationary trial has no travel direction, so
          // this is its only available control, and by symmetry it must be 0.5.
          if (sim.posX[i] - p[0] < 0) westIn++;
        }
        // Only tested inside the radius: isSphereVisible is the expensive part
        // and an animal past R is not what either symptom is about.
        if (!rec.everInFrustum &&
            cam.isSphereVisible(sim._pointOf(i), 0.6 * sim.scale[i])) {
          rec.everInFrustum = true;
          rec.firstFrustumD = d;
        }
      }
    }
    // Only recorded while the travel direction MEANS something. Standing still
    // there is no direction to be in front of, and reporting 0.5-by-symmetry
    // samples mixed with real ones would average the statistic toward the
    // answer the fix is trying to produce.
    if (fwdTotal > 0) {
      forwardShare20.push({ t, n: fwdTotal, speed: tSpeed,
        share: tSpeed >= LEAD_MIN_SPEED ? fwdIn / fwdTotal : null,
        westShare: westIn / fwdTotal });
    }
  };
  const tracker = setInterval(tick, 50);

  // ---- 1 Hz census -------------------------------------------------------
  const samples = [];
  const sampler = setInterval(() => {
    const cam = g.renderer.camera.position;
    const bins = [0, 0, 0, 0];
    let nearSlotAlive = 0;
    for (const i of sim.liveSlots()) {
      if (sp._nearFieldSlot[i] === 1) nearSlotAlive++;
      const d = Math.hypot(sim.posX[i] - cam[0], sim.posY[i] - cam[1], sim.posZ[i] - cam[2]);
      for (let b = 0; b < NEAR_BINS.length; b++) if (d <= NEAR_BINS[b]) bins[b]++;
    }
    samples.push({
      t: r2(now()),
      d10: bins[0], d20: bins[1], d30: bins[2], d45: bins[3],
      drawn: g.creaturePass.stats.instances,
      draws: g.creaturePass.stats.draws,
      alive: sim.count,
      nearSlotAlive,
      nearFieldCount: sp.stats.nearFieldCount,
      nearFieldInner: sp.stats.nearFieldInner,
      retiredCum: sp.stats.nearFieldRetired,
      reclaimedCum: sp.stats.nearFieldReclaimed,
      spawnedCum: sp.stats.nearFieldSpawned,
      despawnedCum: sp.stats.despawned,
      playerY: r2(g.player.position[1]),
      playerPath: r2(playerPath),
    });
  }, 1000);

  const statsAtStart = JSON.parse(JSON.stringify(sp.stats));

  // ---- self-motion of near-field agents over 10 s ------------------------
  await sleep(2000);
  const motionSnap = new Map();
  for (const i of sim.liveSlots()) {
    if (sp._nearFieldSlot[i] !== 1) continue;
    const p = g.player.position;
    const d = Math.hypot(sim.posX[i] - p[0], sim.posY[i] - p[1], sim.posZ[i] - p[2]);
    if (d > R) continue;
    motionSnap.set(sim.handleOf(i), [sim.posX[i], sim.posY[i], sim.posZ[i]]);
  }
  await sleep(10000);
  const moved = [];
  let motionLost = 0;
  for (const [h, p0] of motionSnap) {
    const i = sim.slotOf(h);
    if (i < 0) { motionLost++; continue; }
    moved.push(Math.hypot(sim.posX[i] - p0[0], sim.posY[i] - p0[1], sim.posZ[i] - p0[2]));
  }

  // ---- run out the clock -------------------------------------------------
  await sleep(Math.max(0, seconds * 1000 - 12000));

  clearInterval(tracker);
  clearInterval(sampler);
  if (servo) clearInterval(servo);
  if (swim) {
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));
  }
  sim.despawn = realDespawn;
  g.player.simulate = realSimulate;

  const statsAtEnd = JSON.parse(JSON.stringify(sp.stats));
  const tEnd = now();

  // ---- reduce ------------------------------------------------------------
  const nearRecs = [...seen.values()].filter((r) => r.everNear);
  // Only agents that entered the near field AFTER the window opened have a
  // measurable lifetime; the ones already there at t=0 are left-censored, so
  // their dwell is a LOWER BOUND and is reported separately.
  const fresh = nearRecs.filter((r) => r.firstNearT > 0.5);
  const censored = nearRecs.filter((r) => r.firstNearT !== null && r.firstNearT <= 0.5);
  const dwellOf = (r) => r.lastNearT - r.firstNearT;
  const travelOf = (r) => r.lastNearPath - r.firstNearPath;

  const summarise = (arr, f) => {
    const v = arr.map(f).filter((x) => Number.isFinite(x));
    if (!v.length) return null;
    return { n: v.length, median: r2(median(v)), mean: r2(v.reduce((a, b) => a + b, 0) / v.length),
      min: r2(Math.min(...v)), max: r2(Math.max(...v)) };
  };

  const binStat = (key) => {
    const v = samples.map((s) => s[key]);
    return { mean: r2(v.reduce((a, b) => a + b, 0) / v.length), min: Math.min(...v),
      max: Math.max(...v), median: r2(median(v)) };
  };

  const stillNearAtEnd = nearRecs.filter((r) => r.lastNearT > tEnd - 0.3).length;

  return {
    mode: swim ? 'SWIMMING' : 'STATIONARY (position pinned)',
    windowSeconds: r2(tEnd),
    playerPathMetres: r2(playerPath),
    playerMeanSpeed: r2(playerPath / tEnd),
    playerDepthRange: [Math.min(...samples.map((s) => s.playerY)),
      Math.max(...samples.map((s) => s.playerY))],
    nearRadius: sp._nearRadius,
    nearRelease: r2(sp._nearRelease),
    nearFieldTarget: sp._nearFieldTarget(sp._eyeBand),

    census: {
      d10: binStat('d10'), d20: binStat('d20'), d30: binStat('d30'),
      d45: binStat('d45'), drawnInstances: binStat('drawn'),
      draws: binStat('draws'), aliveTotal: binStat('alive'),
      nearSlotAlive: binStat('nearSlotAlive'),
      drawnInstancesAt20Hz: { n: drawn20.length, median: r2(median(drawn20)),
        mean: r2(drawn20.reduce((a, b) => a + b, 0) / drawn20.length),
        min: Math.min(...drawn20), max: Math.max(...drawn20),
        distinctValues: new Set(drawn20).size },
      // The PRIMARY acceptance statistic for the drawn-instance collapse: the
      // mean over the LAST 16 s, so the 12 s pinned fill and the first half of
      // the window cannot flatter it.
      drawnInstancesLast16s: (() => {
        const cut = Math.max(0, drawn20.length - 16 * 20);
        const v = drawn20.slice(cut);
        return { n: v.length, mean: r2(v.reduce((a, b) => a + b, 0) / v.length),
          min: Math.min(...v), max: Math.max(...v), median: r2(median(v)) };
      })(),
    },

    // ---- THE ALONG-TRACK SHARE, see the tick() comment ---------------------
    forwardShare: (() => {
      const cut = tEnd - 16;
      const late = forwardShare20.filter((s) => s.t >= cut);
      const moving = late.filter((s) => s.share !== null);
      const mean = (a, f) => (a.length
        ? r2(a.reduce((x, s) => x + f(s), 0) / a.length) : null);
      return {
        samplesLast16s: late.length,
        samplesWithTravelDirection: moving.length,
        // Mean over the last 16 s. Predicted 0.250 by the conveyor model.
        alongTravelLast16s: mean(moving, (s) => s.share),
        alongTravelWholeWindow: mean(forwardShare20.filter((s) => s.share !== null),
          (s) => s.share),
        // Against the fixed due-west axis both trials use. 0.5 by symmetry
        // when the eye is pinned.
        alongFixedWestAxisLast16s: mean(late, (s) => s.westShare),
        meanNearSlotCounted: mean(late, (s) => s.n),
        meanFilteredSpeed: mean(late, (s) => s.speed),
      };
    })(),

    lifetime: {
      distinctAgentsSeen: seen.size,
      everWithinNearRadius: nearRecs.length,
      enteredDuringWindow: fresh.length,
      alreadyThereAtWindowStart: censored.length,
      stillWithinRadiusAtEnd: stillNearAtEnd,
      dwellSecondsFresh: summarise(fresh, dwellOf),
      dwellSecondsCensoredLowerBound: summarise(censored, dwellOf),
      playerTravelDuringDwellFresh: summarise(fresh, travelOf),
      playerTravelDuringDwellCensored: summarise(censored, travelOf),
      // Did the player ever actually GET to the animal before it went away?
      closestApproachFresh: summarise(fresh, (r) => r.minD),
      freshEverWithin20m: fresh.filter((r) => r.everWithin20).length,
      freshEverInFrustum: fresh.filter((r) => r.everInFrustum).length,
      nearEverInFrustum: nearRecs.filter((r) => r.everInFrustum).length,
      // THE POP RULE, measured rather than assumed. NEARFIELD_HIDE_FRAC is
      // 0.85, so no near-field agent's FIRST appearance in the frustum may be
      // inside 0.85 R. The bulk hide radius (0.45 R) is in force whenever the
      // population is under NEARFIELD_BULK_FRAC of target, which under motion
      // is essentially always - so this is the number that says whether fish
      // are materialising in view.
      firstFrustumDistanceFresh: summarise(
        fresh.filter((r) => r.nearFieldSlot === 1), (r) => r.firstFrustumD),
      freshNearSlotFirstSeenInside085R: fresh.filter(
        (r) => r.nearFieldSlot === 1 && r.firstFrustumD !== null &&
          r.firstFrustumD < 0.85 * R).length,
    },

    removals: {
      totalDespawnCalls: removed.length,
      byCauseAll: causeCount,
      byCauseAgentsThatWereEverNear: causeCountNear,
      statsDelta: {
        despawned: statsAtEnd.despawned - statsAtStart.despawned,
        nearFieldRetired: statsAtEnd.nearFieldRetired - statsAtStart.nearFieldRetired,
        nearFieldReclaimed: statsAtEnd.nearFieldReclaimed - statsAtStart.nearFieldReclaimed,
        nearFieldSpawned: statsAtEnd.nearFieldSpawned - statsAtStart.nearFieldSpawned,
        spawned: statsAtEnd.spawned - statsAtStart.spawned,
      },
      distanceAtRemoval: summarise(removed, (r) => r.d),
      unseenTAtRemoval: summarise(removed, (r) => r.unseenT),
      // CREATURE_DRAW.DISTANCE_MIN is 90 m and _nearRelease is 69.75 m, so a
      // retired animal is still inside the draw distance. Whether the player
      // could have seen it is therefore decided by the frustum and by the 6 s
      // unseen guard, not by range - so count what was actually looked at.
      nearOutThatWereEverInFrustum:
        removed.filter((r) => r.cause === 'nearOut' && r.everInFrustum).length,
      nearOutThatWereEverWithin20m:
        removed.filter((r) => r.cause === 'nearOut' && r.everWithin20).length,
      nearOutClosestApproach:
        summarise(removed.filter((r) => r.cause === 'nearOut'), (r) => r.minD),
      sampleRemovals: removed.slice(0, 12),
    },

    selfMotion10s: {
      tracked: motionSnap.size, despawnedDuring: motionLost,
      metres: summarise(moved.map((v) => ({ v })), (r) => r.v),
    },

    samples,
  };
}
