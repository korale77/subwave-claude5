// SUBWAVE - the inverse FFT that turns the wave spectrum into a heightfield.
//
// Radix-2 decimation-in-time, one workgroup per row (then per column), entirely
// resident in workgroup storage. N/2 threads, log2(N) butterfly stages, one
// barrier between stages.
//
// Why not Stockham: Stockham's selling point is that it avoids the bit-reversal
// permutation. Here the permutation is free - it is folded into the initial load
// from the scratch buffer, which every variant has to do anyway - so the only
// thing Stockham would buy is a second workgroup array to ping-pong through, and
// the only thing it would cost is an algorithm that is much harder to verify by
// eye. The transform below is the same butterfly network, byte-for-byte
// equivalent to the reference DFT that tools/test-ocean.mjs checks it against.
//
// No 1/N normalisation anywhere. The physical surface really is the UNNORMALISED
// inverse transform h(x) = sum_k h(k) e^{i k x}; the amplitude scale lives in h0.
//
// The lattice is centred (k = 0 at bin N/2), so the transform's output must be
// multiplied by the (-1)^(n+m) chequerboard. That is done once, in the assemble
// pass, rather than twice here.

#include "../common/math.wgsl"

// Set per compile from the tier's oceanFftSize. The fallbacks exist only so the
// offline checker, which has no quality preset, can still preprocess the file.
#ifndef FFT_SIZE
#define FFT_SIZE 256
#define FFT_LOG2 8
#define FFT_HALF 128
#endif

@group(0) @binding(0) var<storage, read_write> hkt : array<vec2f>;

var<workgroup> gBuf : array<vec2f, FFT_SIZE>;

/// Reverse the low `FFT_LOG2` bits of an index.
fn bitReverse(iIn: u32) -> u32 {
  var v = iIn;
  var r = 0u;
  for (var b = 0u; b < FFT_LOG2; b = b + 1u) {
    r = (r << 1u) | (v & 1u);
    v = v >> 1u;
  }
  return r;
}

/// The butterfly network, operating in place on gBuf.
/// `t` is the thread's index in [0, N/2): each thread owns exactly one butterfly
/// per stage, and the two elements it touches are touched by no other thread, so
/// a single barrier between stages is sufficient.
fn butterflies(t: u32) {
  for (var s = 1u; s <= FFT_LOG2; s = s + 1u) {
    workgroupBarrier();
    let len = 1u << s;
    let half = len >> 1u;
    let blk = t / half;
    let j = t % half;
    let i0 = blk * len + j;
    let i1 = i0 + half;
    // +i convention: this is the INVERSE transform.
    let ang = PI * f32(j) / f32(half);
    let w = vec2f(cos(ang), sin(ang));
    let u = gBuf[i0];
    let v0 = gBuf[i1];
    let v = vec2f(v0.x * w.x - v0.y * w.y, v0.x * w.y + v0.y * w.x);
    gBuf[i0] = u + v;
    gBuf[i1] = u - v;
  }
  workgroupBarrier();
}

// ---------------------------------------------------------------------------

/// Pass 1: transform every row. wg.x = row, wg.y = field*cascadeCount + cascade.
@compute @workgroup_size(FFT_HALF, 1, 1)
fn cs_fftRow(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let base = (wg.y * FFT_SIZE + wg.x) * FFT_SIZE;
  let t = lid.x;

  gBuf[t] = hkt[base + bitReverse(t)];
  gBuf[t + FFT_HALF] = hkt[base + bitReverse(t + FFT_HALF)];

  butterflies(t);

  hkt[base + t] = gBuf[t];
  hkt[base + t + FFT_HALF] = gBuf[t + FFT_HALF];
}

/// Pass 2: transform every column, reading with stride N.
/// wg.x = column, wg.y = field*cascadeCount + cascade.
@compute @workgroup_size(FFT_HALF, 1, 1)
fn cs_fftCol(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let base = wg.y * FFT_SIZE * FFT_SIZE + wg.x;
  let t = lid.x;

  gBuf[t] = hkt[base + bitReverse(t) * FFT_SIZE];
  gBuf[t + FFT_HALF] = hkt[base + bitReverse(t + FFT_HALF) * FFT_SIZE];

  butterflies(t);

  hkt[base + t * FFT_SIZE] = gBuf[t];
  hkt[base + (t + FFT_HALF) * FFT_SIZE] = gBuf[t + FFT_HALF];
}
