// What emitters are actually WITHIN REACH at a station, and how bright does the
// glow pass predict each one?
//
//   node tools/probe.mjs --file tools/probes/glow-census.js
//
// The acceptance probe reports "6224 of 7169 candidates culled on contrast",
// which is either a population fact or a sizing bug and the two look identical
// from outside. This lists the nearest emitters with their range, their baked
// flux and the sprite peak the pass predicts, so the two can be told apart.

const g = window.subwave;
const { quat, vec3 } = await import('/src/core/math.js');
const { GLOW, WORLD } = await import('/src/core/constants.js');
const { SCATTER_TYPES } = await import('/src/world/scatter.js');

const ST = window.__glowStation || {
  name: 'abyss-qa', x: 2394, y: -700, z: -1388, yaw: 1.2, pitch: -0.25, day: 0.5,
};

function place() {
  const p = g.player;
  p.inVessel = false;
  p.position.set([ST.x, ST.y, ST.z]);
  p.velocity.set([0, 0, 0]);
  vec3.copy(p.prevPosition, p.position);
  p.yaw = ST.yaw; p.pitch = ST.pitch;
  quat.fromEuler(p.orientation, ST.yaw, ST.pitch, 0);
  quat.copy(p.prevOrientation, p.orientation);
}

g.worldClock.setDayFraction(ST.day);
const end = performance.now() + 8000;
while (performance.now() < end) {
  await new Promise((r) => requestAnimationFrame(r));
  place();
}

const cam = g.renderer.camera;
const wt = g.renderer.env.waterType;
const exposure = g.renderer.exposure;
const focal = g.renderer.gpu.renderHeight * 0.5 / Math.tan(cam.fov * 0.5);
const sigA = GLOW.SIGMA_PX / focal;
const gg = Math.min(0.995, Math.max(0.05, wt.g));
const th0 = (1 - gg) / Math.sqrt(gg);
const W = [0.2126, 0.7152, 0.0722];

const rows = [];
const _abs = new Float32Array(3);
const chunks = g.scatterPass.emissiveInstances();
const te = g.scatterPass.typeEmit;
let total = 0;
for (const ch of chunks) {
  for (let j = 0; j < ch.count; j++) {
    total++;
    const t = ch.type[j];
    const x = ch.pos[j * 3], y = ch.pos[j * 3 + 1], z = ch.pos[j * 3 + 2];
    const dx = x - cam.position[0], dy = y - cam.position[1], dz = z - cam.position[2];
    const d = Math.hypot(dx, dy, dz);
    const s = ch.scale[j];
    const k = s * s * ch.emitScale[j];
    let lumHalo = 0, lumCore = 0;
    for (let c = 0; c < 3; c++) {
      const e = te.flux[t * 3 + c] * k / (d * d);
      const T = Math.exp(-wt.sigmaT[c] * d);
      const h = 1 - Math.exp(-wt.sigmaS[c] * d);
      lumHalo += e * T * h * W[c];
      lumCore += e * T * (1 - h) * W[c];
    }
    const aEff = Math.max(sigA, te.radius[t] * s / d);
    const peak = lumHalo / (2 * Math.PI * th0 * aEff);
    _abs[0] = x; _abs[1] = y; _abs[2] = z;
    const vis = cam.isSphereVisible(_abs, Math.max(0.5, aEff * d));
    rows.push({ t, key: SCATTER_TYPES[t].key, d: +d.toFixed(1), s: +s.toFixed(2),
      peak: +peak.toPrecision(4), peakExposed: +(peak * exposure).toPrecision(4),
      vis, elevDeg: +(Math.asin(dy / d) * 180 / Math.PI).toFixed(1),
      offAxisDeg: +(Math.acos(Math.max(-1, Math.min(1,
        (dx * cam.forward[0] + dy * cam.forward[1] + dz * cam.forward[2]) / d)))
        * 180 / Math.PI).toFixed(1),
      directCore: +lumCore.toPrecision(4) });
  }
}
rows.sort((a, b) => b.peak - a.peak);

const floorScene = GLOW.FLOOR_EXPOSED / exposure;
const dists = rows.map((r) => r.d).sort((a, b) => a - b);

// Terrain under the eye, so "is the camera near the floor" is answered too.
const { sampleHeight } = await import('/src/world/terrain.js');

return {
  station: ST,
  waterType: wt.name,
  sigmaT: [...wt.sigmaT], sigmaS: [...wt.sigmaS], g: wt.g, theta0_deg: +(th0 * 180 / Math.PI).toFixed(3),
  exposure: +exposure.toPrecision(6),
  focalPx: +focal.toFixed(1), sigmaA_rad: +sigA.toPrecision(4),
  floorScene: +floorScene.toPrecision(4),
  groundY: +sampleHeight(ST.x, ST.z).toFixed(2),
  eyeY: ST.y,
  residentEmissiveChunks: chunks.length,
  emissiveInstancesResident: total,
  nearest10m: dists.filter((d) => d < 10).length,
  nearest30m: dists.filter((d) => d < 30).length,
  nearest60m: dists.filter((d) => d < 60).length,
  nearest120m: dists.filter((d) => d < 120).length,
  minDist: dists[0] ?? null,
  brightest: rows.slice(0, 6),
  nearestTen: rows.slice().sort((a,b)=>a.d-b.d).slice(0,10),
  camFwd: [...cam.forward].map((v)=>+v.toFixed(3)),
  camPos: [...cam.position].map((v)=>+v.toFixed(2)),
  aboveFloor: rows.filter((r) => r.peak >= floorScene).length,
  aboveFloorAndVisible: rows.filter((r) => r.peak >= floorScene && r.vis).length,
  visibleAny: rows.filter((r) => r.vis).length,
  visibleWithin120: rows.filter((r) => r.vis && r.d < 120).length,
  creaturesInFrame: g.creaturePass?.stats?.instances ?? null,
  creaturePopulation: g.creatures?.count ?? null,
};
