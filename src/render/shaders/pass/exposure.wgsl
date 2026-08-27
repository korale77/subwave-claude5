// SUBWAVE - auto exposure by luminance histogram.
//
// Two dispatches. The first bins log-luminance over a strided grid of the
// resolved scene; the second reduces the histogram to a target EV and adapts
// toward it with separate rise and fall rates.
//
// WHY A HISTOGRAM RATHER THAN A MIP-CHAIN AVERAGE
// A downsampled average is dominated by whatever covers the most pixels. In
// this game that is either an almost-black abyss or a mirror-bright sea
// surface, and a mean would clip whichever one you actually care about. Taking
// a weighted mean of a percentile WINDOW of the histogram throws away both the
// dead black and the specular highlights and meters the thing between them,
// which is the terrain and the creatures.
//
// The asymmetry between EXPOSURE_SPEED_UP and EXPOSURE_SPEED_DOWN is the whole
// point of the system: light adaptation is fast, dark adaptation is slow. When
// you dive out of the sunlit zone the image goes dark and then SLOWLY opens up
// over several seconds, exactly as your eyes do.

// Group 0 is the engine's frame group, which this pass does not read; its
// bindings are still present in the pipeline layout so every post pass shares
// one group assignment.
#include "../common/math.wgsl"

const HISTOGRAM_BINS : u32 = 256u;
/// Bins below this are treated as "no light at all" and excluded, so a frame of
/// pure black cannot drag the average to the EV floor and blow out the next
/// bioluminescent thing that appears.
const BLACK_BIN : u32 = 1u;

// THE HISTOGRAM'S LOW EDGE AND THE EXPOSURE'S LOW LIMIT ARE TWO DIFFERENT
// NUMBERS, and this shader is where they were welded together until 2026-08-04.
// `range.x` (RENDER.EXPOSURE_MIN_EV) is the METERING FLOOR: the darkest average
// worth exposing for, and hence the gain ceiling, EXPOSURE_KEY / 2^range.x.
// `misc2.y` (RENDER.HISTOGRAM_MIN_EV) is where the BINS start, at the same 1e-5
// inclusion gate `luminanceToBin` applies. They differ by 10.61 stops, and while
// they were one value the bins could not represent anything below the floor, so
// every deep frame metered as exactly the floor and the meter reported a
// constant instead of the scene. See RENDER.EXPOSURE_MIN_EV for the numbers.
struct ExposureParams {
  // x = metering floor EV, y = maxEV, z = speedUp (1/s), w = speedDown (1/s)
  range : vec4f,
  // x = dt, y = EV compensation, z = low percentile, w = high percentile
  misc  : vec4f,
  // x = grid width, y = grid height, z = stride, w = 0
  grid  : vec4f,
  // x = exposure key (the value the metered BAND maps onto),
  // y = histogram low bin edge in EV, zw = 0
  misc2 : vec4f,
};

struct ExposureState {
  bins       : array<atomic<u32>, 256>,
  exposure   : f32,
  ev         : f32,
  avgLum     : f32,
  validPixels: f32,
};

@group(1) @binding(0) var<uniform> params : ExposureParams;
@group(1) @binding(1) var srcTex : texture_2d<f32>;
@group(1) @binding(2) var<storage, read_write> state : ExposureState;

var<workgroup> localBins : array<atomic<u32>, 256>;

/// Luminance -> bin. Bin 0 is reserved for "below the 1e-5 inclusion gate".
/// The 254 metered bins span [misc2.y, range.y], NOT [range.x, range.y].
fn luminanceToBin(lum: f32) -> u32 {
  if (lum < 1e-5) { return 0u; }
  let ev = log2(lum);
  let t = saturate((ev - params.misc2.y) / max(params.range.y - params.misc2.y, 1e-3));
  return clamp(u32(t * 254.0 + 1.0), 1u, HISTOGRAM_BINS - 1u);
}

fn binToLuminance(bin: u32) -> f32 {
  let t = (f32(bin) - 1.0) / 254.0;
  return exp2(mix(params.misc2.y, params.range.y, t));
}

@compute @workgroup_size(16, 16, 1)
fn cs_histogram(@builtin(global_invocation_id) gid: vec3u,
                @builtin(local_invocation_index) lid: u32) {
  atomicStore(&localBins[lid], 0u);
  workgroupBarrier();

  let gw = u32(params.grid.x);
  let gh = u32(params.grid.y);
  if (gid.x < gw && gid.y < gh) {
    let stride = i32(params.grid.z);
    let coord = vec2i(i32(gid.x) * stride, i32(gid.y) * stride);
    let c = textureLoad(srcTex, coord, 0).rgb;
    let lum = luminance(max(c, vec3f(0.0)));

    // Centre-weighted metering. A creature that fills the middle of the frame
    // must set the exposure; the corners, which are usually open water, must
    // not. Weight is quantised to 1..8 so the atomic stays integer.
    let uv = (vec2f(gid.xy) + 0.5) / vec2f(params.grid.xy);
    let d = (uv - vec2f(0.5)) * vec2f(2.0);
    let w = mix(1.0, 8.0, saturate(1.0 - dot(d, d) * 0.7));
    atomicAdd(&localBins[luminanceToBin(lum)], u32(w));
  }

  workgroupBarrier();
  let count = atomicLoad(&localBins[lid]);
  if (count > 0u) {
    atomicAdd(&state.bins[lid], count);
  }
}

@compute @workgroup_size(256, 1, 1)
fn cs_adapt(@builtin(local_invocation_index) lid: u32) {
  if (lid == 0u) {
    var total = 0.0;
    for (var i = BLACK_BIN; i < HISTOGRAM_BINS; i = i + 1u) {
      total += f32(atomicLoad(&state.bins[i]));
    }

    var avgLum = 0.0;
    if (total > 0.0) {
      // Weighted mean of log-luminance across the percentile window. Working in
      // log space is mandatory: a linear mean is dominated by the single
      // brightest sample and would make the exposure flicker on every specular.
      let lo = total * params.misc.z;
      let hi = total * params.misc.w;
      var seen = 0.0;
      var sumLogLum = 0.0;
      var sumW = 0.0;
      for (var i = BLACK_BIN; i < HISTOGRAM_BINS; i = i + 1u) {
        let c = f32(atomicLoad(&state.bins[i]));
        if (c > 0.0) {
          // The part of this bin that falls inside the window.
          let a = max(seen, lo);
          let b = min(seen + c, hi);
          let inside = max(0.0, b - a);
          if (inside > 0.0) {
            sumLogLum += log2(max(binToLuminance(i), 1e-6)) * inside;
            sumW += inside;
          }
          seen += c;
        }
      }
      if (sumW > 0.0) { avgLum = exp2(sumLogLum / sumW); }
    }
    if (avgLum <= 0.0) {
      // Nothing metered (fully black frame). Hold the previous exposure rather
      // than snapping to the floor.
      avgLum = max(state.avgLum, 1e-5);
    }

    // The exposure that maps the metered average onto the key.
    //
    // The key is NOT 0.18, and the difference is not a fudge. What `avgLum`
    // measures is the log-average of the 45th-95th PERCENTILE band, not the mean
    // of the frame - the bottom 45% is discarded because in this game it is
    // usually empty water or true black. Mapping the middle of the bright half
    // onto middle grey necessarily puts the frame's own median well below it:
    // measured, it landed at code 0.30 where a correctly exposed image wants
    // ~0.44. EXPOSURE_KEY is where that BAND belongs, and it sits above middle
    // grey by exactly as much as the window is biased upward.
    //
    // THE LOW CLAMP IS THE GAIN CEILING AND IT IS DERIVED, NOT `range.x` ITSELF.
    // The floor is a LUMINANCE (2^range.x = 0.015625); the clamp is on an
    // EXPOSURE, so it is that luminance's own target EV, log2(floor / key) =
    // -4.678. That is the identical arithmetic this line used to perform on an
    // avgLum the histogram had already pinned to the floor, so the delivered
    // gain at a clamped station is bit-for-bit the 25.6 it always was - what
    // changed is that `state.avgLum` now reports the scene instead of the floor.
    // Clamping at `range.x` directly would cap the gain at 2^6 = 64 instead:
    // between the 51.2 and 102.4 ceilings whose A/B is written up on
    // RENDER.EXPOSURE_MIN_EV, both of which wash the deep out.
    let floorEV = log2(exp2(params.range.x) / params.misc2.x);
    let targetEV = clamp(log2(avgLum / params.misc2.x), floorEV, params.range.y);
    let prevEV = select(state.ev, targetEV, state.validPixels < 0.5);
    // Brighter scene -> higher EV -> the fast, light-adaptation rate.
    let speed = select(params.range.w, params.range.z, targetEV > prevEV);
    let k = 1.0 - exp(-max(params.misc.x, 0.0) * speed);
    let ev = prevEV + (targetEV - prevEV) * k;

    state.ev = ev;
    state.avgLum = avgLum;
    state.validPixels = 1.0;
    state.exposure = exp2(-ev + params.misc.y);
  }

  // The barrier is outside the branch: every invocation must reach it.
  workgroupBarrier();
  atomicStore(&state.bins[lid], 0u);
}
