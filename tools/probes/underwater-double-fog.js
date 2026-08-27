// Is the water medium applied TWICE on the underwater path?
//
// Places the eye at a controlled 2 m depth over the reef floor looking at the
// seabed, then reads sceneColor with the underwater composite ON and OFF. The
// composite is the pass that is supposed to OWN the medium, so with it disabled
// the seabed should come back close to its dry-lit radiance. If the "off"
// reading is already the milky in-scattered wash, the geometry shaders are
// fogging themselves and the composite is the second application.
const g = window.subwave;
const r = g.renderer;
const { quat, vec3 } = await import('/src/core/math.js');
const T = await import('/src/world/terrain.js');
const { readTexture2D } = await import('/src/core/resources.js');

function f16(h) {
  const s = (h & 0x8000) ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

const frames = async (n) => {
  for (let i = 0; i < n; i++) await new Promise((res) => requestAnimationFrame(res));
};

/** Mean radiance over a fractional window of sceneColor, plus a row profile. */
async function sample() {
  const tex = r.targets.texture('sceneColor');
  const size = r.targets.size('sceneColor');
  const raw = await readTexture2D(r.gpu.device, tex, size.width, size.height,
    { bytesPerPixel: 8 });
  const v = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const px = (x, y) => {
    const i = (y * size.width + x) * 4;
    return [f16(v[i]), f16(v[i + 1]), f16(v[i + 2])];
  };
  const box = (x0, y0, x1, y1) => {
    let a = 0, b = 0, c = 0, n = 0;
    for (let y = y0 | 0; y < (y1 | 0); y += 2) {
      for (let x = x0 | 0; x < (x1 | 0); x += 2) {
        const p = px(x, y);
        a += p[0]; b += p[1]; c += p[2]; n++;
      }
    }
    return [+(a / n).toFixed(4), +(b / n).toFixed(4), +(c / n).toFixed(4)];
  };
  const W = size.width, H = size.height;
  const fmt = (a) => a.map((x) => x.toFixed(4)).join(' ');
  // Column profile down the middle of the frame.
  const column = [];
  for (let k = 0; k < 16; k++) {
    const y = Math.min(H - 3, Math.round((k + 0.5) / 16 * H));
    column.push(`y${String(y).padStart(4)} ${fmt(box(W * 0.45, y, W * 0.55, y + 2))}`);
  }
  return {
    size: `${W}x${H}`,
    whole: fmt(box(0, 0, W, H)),
    seabedNear: fmt(box(W * 0.3, H * 0.80, W * 0.7, H * 0.98)),
    centre: fmt(box(W * 0.45, H * 0.45, W * 0.55, H * 0.55)),
    column,
  };
}

// --- put the eye 4 m over the flattest reef floor we can find ---------------
let best = null;
for (let i = 0; i < 1200; i++) {
  const a = i * 2.39996323, rad = Math.sqrt(i / 1200) * 300;
  const x = Math.cos(a) * rad, z = 240 + Math.sin(a) * rad;
  const h = T.sampleHeight(x, z);
  const slope = T.sampleSlope(x, z);
  if (h > -9 && h < -5.5 && slope < 0.28 && (!best || slope < best.slope)) {
    best = { x, z, h, slope };
  }
}
if (!best) return { error: 'no reef floor found' };

const p = g.player;
const EYE_ABOVE_FLOOR = 4.0;
p.inVessel = false;
p.position.set([best.x, best.h + EYE_ABOVE_FLOOR - p.currentEyeHeight, best.z]);
p.velocity.set([0, 0, 0]);
vec3.copy(p.prevPosition, p.position);
p.yaw = 0.8;
p.pitch = -0.55;
quat.fromEuler(p.orientation, p.yaw, p.pitch, 0);
quat.copy(p.prevOrientation, p.orientation);
g.setPaused(true);
await frames(150);

const out = {
  floor: { x: +best.x.toFixed(1), z: +best.z.toFixed(1), h: +best.h.toFixed(2),
    slope: +best.slope.toFixed(3) },
  camDepth: +r.camera.depth.toFixed(2),
  waterType: r.env.waterType.name,
  sigmaT: Array.from(r.env.waterType.sigmaT),
  Kd: Array.from(r.env.waterType.Kd),
  exposure: +r.exposure.toFixed(4),
};

out.withComposite = await sample();

r.graph.setDisabled('underwater', true);
await frames(8);
out.withoutComposite = await sample();

r.graph.setDisabled('underwater', false);
await frames(8);

// And with the ocean surface gone too, so nothing but terrain + scatter + sky
// contributes: isolates what the geometry shaders themselves produced.
r.graph.setDisabled('underwater', true);
r.graph.setDisabled('ocean', true);
await frames(8);
out.geometryOnly = await sample();
r.graph.setDisabled('ocean', false);
r.graph.setDisabled('underwater', false);
await frames(8);

return out;
