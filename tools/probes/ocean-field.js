// Read the ocean displacement/derivative cascades back off the GPU and report
// the real amplitudes. Run with: node tools/probe.mjs --file tools/probes/ocean-field.js
const sim = window.subwave.ocean;
const r = window.subwave.renderer;
const { readTexture2D } = await import('/src/core/resources.js');

function f16(h) {
  const s = (h & 0x8000) ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

async function statCascade(tex, layer, n) {
  const raw = await readTexture2D(r.gpu.device, tex, n, n, { bytesPerPixel: 8, origin: [0, 0, layer] });
  const v = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const sq = [0, 0, 0, 0];
  const mx = [0, 0, 0, 0];
  const count = n * n;
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 4; c++) {
      const x = f16(v[i * 4 + c]);
      sq[c] += x * x;
      if (Math.abs(x) > mx[c]) mx[c] = Math.abs(x);
    }
  }
  return {
    rms: sq.map((a) => +Math.sqrt(a / count).toFixed(5)),
    absMax: mx.map((a) => +a.toFixed(5)),
  };
}

const out = {
  env: {
    windSpeed: r.env.windSpeed,
    seaState: r.env.seaState,
    windDir: Array.from(r.env.windDir || []),
    choppiness: r.env.choppiness,
    foamCoverage: r.env.foamCoverage,
  },
  spectrum: {
    windSpeed: sim.spectrum.windSpeed,
    hs: sim.spectrum.hs,
    h0Scale: sim.spectrum.h0Scale,
    m0: sim.spectrum.m0,
    hsFromM0: 4 * Math.sqrt(sim.spectrum.m0),
    energyGain: sim.spectrum.energyGain,
    cpuPointwiseRms: sim.spectrum.cpuPointwiseRms,
  },
  n: sim.n,
  cascadeCount: sim.cascadeCount,
  gerstnerOnly: sim.gerstnerOnly,
  cpuHeightSamples: [],
  displacement: {},
  derivative: {},
};

for (let i = 0; i < 8; i++) {
  out.cpuHeightSamples.push(+sim.sampleHeightCPU(i * 13.7, i * 7.3, sim.time).toFixed(4));
}

for (let c = 0; c < sim.cascadeCount; c++) {
  out.displacement['cascade' + c] = await statCascade(sim.displacementTexture, c, sim.n);
  out.derivative['cascade' + c] = await statCascade(sim.derivativeTexture, c, sim.n);
}

return out;
