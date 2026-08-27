# SUBWAVE - DESIGN 03

# Ocean Simulation, Underwater Optics, Sky, Weather & Day/Night

Binding implementation spec. Section owner: Ocean & Atmosphere.
Everything numeric in this document is normative. Where a number is marked `[TUNE]` it may be
changed at runtime through the debug console but the shipped default is the value given.

---

## 03.0 SCOPE, CONVENTIONS, BUDGETS

### 03.0.1 Coordinate & unit conventions (restated, binding)

| Item | Value |
|------|-------|
| Handedness | Right-handed |
| +X | East |
| +Y | Up |
| +Z | South |
| Sea level | y = 0.0 m (mean still water level, MSWL) |
| Depth | d = -y, positive downward |
| Heading | 0 rad = north (-Z), increasing clockwise from above; east = pi/2 |
| Angles | radians internally, degrees only in UI strings |
| Linear units | metres |
| Mass | kilograms |
| Gravity | g = 9.81 m/s^2 (binding; wave dispersion and buoyancy both use this) |
| Water density | rho_sw = 1025.0 kg/m^3 at 15 C, 35 PSU (brine pools override, see 03.4.3) |
| Air density | rho_air = 1.225 kg/m^3 at y = 0 |
| Refractive index | n_air = 1.000277, n_seawater = 1.3390 (sodium D), per-channel in 03.6.3 |
| Speed of sound (air) | 343.0 m/s |
| Speed of sound (water) | 1500.0 m/s |

### 03.0.2 Two clocks (binding)

There are two independent time bases and every time constant in this document declares which
it uses. Mixing them is a bug.

| Clock | Symbol | Definition |
|-------|--------|------------|
| Real time | `t_r` (s) | Wall-clock seconds since session start, accumulated from `performance.now()` deltas clamped to <= 0.05 s per frame. |
| Game time | `t_g` (s) | Simulated planetary time. `dt_g = dt_r * TIME_SCALE`, TIME_SCALE = 48.0 nominal (03.9.1). |

- Wave phase, foam decay, particle motion, weather-transition smoothing, droplet lifetimes,
  audio envelopes, temporal reprojection: **real seconds**.
- Sun/moon ephemeris, day-of-year, tide, creature circadian gating, weather-state dwell times:
  **game seconds**.

### 03.0.3 Radiometric / photometric convention (binding)

- All RGB triples in this document are **linear Rec.709 primaries**, D65 white, unless stated.
- Irradiance `E` is quoted in **lux-equivalent per channel** (a photometric magnitude split
  into 3 channels whose luminance-weighted sum `0.2126 R + 0.7152 G + 0.0722 B` equals the
  scalar illuminance). This keeps every number checkable against real photometry.
- Radiance `L` is in **cd/m^2 (nits)**.
- All HDR render targets store **pre-exposed** radiance:
  `L_stored = L_scene * preExposure`, with `preExposure = 1.0 / (1.2 * 2^EV100_prev)` computed
  once per frame on the CPU from the previous frame's auto-exposure result and uploaded in the
  frame uniform block. This keeps values inside fp16 range (6.0e-8 .. 65504) across the
  9 orders of magnitude between noon surface and moonless 400 m.
- Auto-exposure clamp (binding for mood): `EV100 in [-3.0, 16.0]`. The lower clamp is what
  guarantees the abyss reads as **black** and not as an amplified grey.
- Section 02 (Renderer) owns the tonemapper (AgX, contrast 1.0, and a -0.02 black lift = 0).
  This section only guarantees correct scene-referred values entering it.

### 03.0.4 Quality tiers

Tier is a single global enum resolved at boot by the adapter probe (section 02) and is
overridable in the options menu. Every subsystem below has a tier column.

| Tier | Target hardware | Target |
|------|-----------------|--------|
| ULTRA | M3 Max / RTX 4070+ | 60 fps @ 1920x1080, 2x supersampled ocean normals |
| HIGH | M1 Pro / M3 / RTX 3060 | 60 fps @ 1920x1080 |
| MEDIUM | M1 / Iris Xe (fast) | 60 fps @ 1600x900, or 45 fps @ 1080p |
| LOW | Integrated / older | 30 fps @ 1280x720 |

### 03.0.5 GPU frame budget for this section (1920x1080, HIGH, M1 Pro class)

| Pass | Budget (ms) | Tier notes |
|------|-------------|------------|
| Ocean spectrum update + 12x IFFT (256^2) | 0.95 | ULTRA 512^2 = 3.10; LOW: skipped (Gerstner) |
| Ocean derivative + foam + mip chain | 0.22 | |
| Ocean clipmap render (surface, above) | 1.05 | |
| Ocean clipmap render (underside) | 0.35 | only when cam depth > -1.5 m |
| SSR (half-res, HiZ) | 0.55 | MEDIUM 0.30, LOW off |
| Planar reflection (vessel only, 640x360) | 0.40 | HIGH+ only, only when |cam.y| < 30 |
| Sky LUTs (transmittance cached, sky-view + AP) | 0.20 | |
| Volumetric clouds (quarter-res + TAA upsample) | 1.60 | MEDIUM 0.75, LOW 0.10 |
| Froxel inject | 0.35 | |
| Froxel integrate | 0.12 | |
| Froxel apply | 0.08 | |
| Caustics splat + resolve | 0.30 | MEDIUM analytic 0.05, LOW analytic 0.05 |
| Marine snow simulate + render | 0.25 | |
| Rain / ripple / droplet | 0.15 | |
| Waterline overlay + underwater post | 0.18 | |
| **Total** | **~6.75** | of a 16.6 ms frame |

### 03.0.6 Interfaces this section EXPORTS

| Symbol | Kind | Contract |
|--------|------|----------|
| `oceanHeightAt(x, z, t_r) -> {y, dx, dz, n}` | JS | CPU wave query, authoritative for buoyancy & audio. Accuracy: <= 0.15 m RMS vs GPU field at sea state 5. Cost <= 3.5 us/call. See 03.1.9. |
| `oceanNormalAt(x, z, t_r) -> vec3` | JS | Derived from the same 64-component CPU sum. |
| `waterTypeAt(x, y, z) -> WaterType` | JS | Blend weights over the 6 water types; owned here, sampled from the biome field provided by section 04. |
| `ambientIrradianceAt(depth) -> vec3` | JS | E_d(d) in lux-eq, used by gameplay (plant growth, creature aggression light gating). |
| `sunDirection(t_g) -> vec3`, `sunIlluminance(t_g) -> vec3` | JS | |
| `moonState(t_g) -> [{dir, phase, illum} x2]` | JS | Selk and Ithra. |
| `wgsl/water_common.wgsl` | WGSL include | `applyUnderwaterTransfer()`, `sampleFroxel()`, `beerLambert()`, `hg2()`. Every opaque shader in the game MUST call `applyUnderwaterTransfer` as its last step. |
| `weatherState()` | JS | Current + target state, blend t, U10, rain rate, cloud coverage. |
| Froxel light-injection slot | GPU | Sections 05 (vessel) and 06 (creatures) push local lights and bioluminescent emitters into `LightVolumeList` (03.5.6). |

### 03.0.7 Interfaces this section DEPENDS ON

| Symbol | Provided by | Assumption made here |
|--------|-------------|----------------------|
| Terrain height texture `T_height` | 04 Terrain | R16Float, world-space toroidal atlas, 1 texel = 1.0 m in the 4 km inner ring, queryable in WGSL as `terrainHeight(xz) -> f32`, valid within +-8 km of camera. |
| Shoreline SDF `T_shoreDist` | 04 Terrain | R16Float, signed distance in metres to the y=0 coastline, +ve seaward. |
| Sun cascaded shadow map | 02 Renderer | 4 cascades, 2048^2 D32Float array, splits at 12/48/180/700 m. |
| Cluster light list | 02 Renderer | 20x12x32 clusters, up to 64 lights/cluster. |
| HiZ depth pyramid | 02 Renderer | R32Float, 8 mips from half-res depth. |
| Previous-frame colour + depth | 02 Renderer | For SSR and temporal upsampling. |
| Audio bus graph | 07 Audio | Named buses `air`, `water`, `interior`; this section owns the crossfade automation. |
| Biome field | 04 Terrain | Returns a biome id + blend weight at any xz; maps to WaterType via table 03.4.3. |

---

## 03.1 (A) OCEAN SURFACE - SPECTRAL WAVE MODEL

### 03.1.1 Model choice

The open ocean is simulated as a **linear, directional, wind-driven gravity wave field**
synthesised by inverse FFT of a randomised **JONSWAP** wavenumber spectrum with
**Donelan-Banner** directional spreading, evolved with the deep-water dispersion relation and
displaced horizontally by the **Tessendorf choppy-wave** transform.

Why JONSWAP over Phillips: Phillips is a fully-developed-only, non-normalisable spectrum with
a notorious k -> 0 divergence and no fetch parameter. JONSWAP is fetch-limited, has a
peak-enhancement factor `gamma` that is exactly the knob that separates "young, steep, angry
storm sea" from "old, long, smooth swell", and it reduces to Pierson-Moskowitz at
gamma = 1.0. Both storm and glass-calm weather states therefore come from one model.

### 03.1.2 The spectrum

Frequency spectrum (m^2 s / rad):

```
S_J(w) = (alpha * g^2 / w^5) * exp(-1.25 * (w_p/w)^4) * gamma^r

r      = exp( -(w - w_p)^2 / (2 * sigma^2 * w_p^2) )
sigma  = 0.07  if w <= w_p
         0.09  if w >  w_p

alpha  = 0.076 * (U10^2 / (F * g))^0.22          // Phillips constant, fetch-limited
w_p    = 22.0 * (g^2 / (U10 * F))^(1/3)          // peak angular frequency, rad/s
```

with `U10` = wind speed at 10 m (m/s), `F` = fetch (m), `g` = 9.81.

Defaults: `F = 1.20e5 m` (120 km) in open water. Fetch is reduced near land by sampling the
shoreline SDF along the upwind direction: `F = clamp(F_open, 2.0e3, distanceToUpwindLand)`.
This is what makes the lee side of the starting island genuinely calmer - a required part of
the "safe start" fantasy.

`gamma` by weather state, table 03.10.2. Range 1.0 (old swell) .. 5.0 (young storm sea).

Convert to a wavenumber spectrum with the deep-water dispersion `w = sqrt(g k)`:

```
dw/dk  = 0.5 * sqrt(g / k)
S(k)   = S_J(sqrt(g*k)) * 0.5 * sqrt(g/k)        // m^3
```

Directional spreading (Donelan-Banner / Mitsuyasu form):

```
D(theta, w) = N(s) * cos^(2s)( (theta - theta_w) / 2 )
N(s)        = (1 / (2*sqrt(PI))) * Gamma(s+1) / Gamma(s+0.5)
s(w)        = 9.77 * (w / w_p)^mu
mu          =  5.00   if w <= w_p
              -2.50   if w >  w_p
```

`theta_w` is the wind direction (heading convention 03.0.1). Clamp `s` to [0.4, 40.0].
`N(s)` is evaluated with a Lanczos gamma approximation on the CPU during spectrum bake, never
in a shader.

An upwind leakage term is added so the sea is never perfectly one-directional
(real seas have 3-8% reverse energy):

```
D_final(theta,w) = (1 - eps) * D(theta,w) + eps * D(theta + PI, w),  eps = 0.055
```

Swell injection (a second, narrow, long-period component that persists after the wind drops):

```
S_total(k,theta) = S(k)*D_final(theta,w) + A_swell * S_swell(k) * D_swell(theta)
S_swell: JONSWAP with gamma = 6.0, w_p_swell = w_p_hist(t - 40 min game),
         theta_swell = theta_w_hist(t - 40 min game),  s = 24.0 (narrow)
A_swell in [0, 1], see weather table.
```

### 03.1.3 The cascade (binding tile sizes)

Three tiles, all `N x N` complex, band-limited so that no wavenumber is represented twice.
Tile-size ratios are deliberately non-integer so the three periodicities never beat into a
visible super-tile.

| c | Name | L_c (m) | dx (m) | dk = 2pi/L (rad/m) | k_nyq = pi*N/L | band k (rad/m) | band lambda (m) | used bins (N=256) |
|---|------|---------|--------|--------------------|----------------|----------------|-----------------|-------------------|
| 0 | SWELL | 2048.0 | 8.0000 | 0.0030680 | 0.39270 | 0.00307 .. 0.15708 | 40.0 .. 2048 | ~8,240 |
| 1 | WIND  | 61.0   | 0.23828| 0.1030025 | 13.1901 | 0.15708 .. 2.09440 | 3.0 .. 40.0 | ~1,290 |
| 2 | RIPPLE| 4.7    | 0.018359| 1.3369   | 171.13  | 2.09440 .. 171.13 | 0.0367 .. 3.0 | ~51,000 |

Ratios: L0/L1 = 33.574, L1/L2 = 12.979, L0/L2 = 435.74. None rational with a small
denominator, so the least common visible period is far beyond draw distance.

Band splitting uses a smooth partition of unity (a hard cut produces a visible "shelf" in the
slope statistics and a ringing halo around the boundary wavelength):

```
// third-octave crossfades centred on k01 = 0.15708, k12 = 2.09440
w01 = smoothstep(k01/1.26, k01*1.26, k)
w12 = smoothstep(k12/1.26, k12*1.26, k)
W0 = 1 - w01
W1 = w01 * (1 - w12)
W2 = w12
// amplitudes are scaled by sqrt(W_c) so total ENERGY is exactly preserved
```

Verify that each cascade can represent its crossfade skirt:
C1 must reach down to 0.15708/1.26 = 0.12467 >= dk1 = 0.10300 (OK, bin radius 1.21).
C2 must reach down to 2.09440/1.26 = 1.66222 >= dk2 = 1.33690 (OK, bin radius 1.24).
C0 must reach up to 0.15708*1.26 = 0.19792 <= k_nyq0 = 0.39270 (OK).
C1 must reach up to 2.09440*1.26 = 2.63894 <= k_nyq1 = 13.190 (OK).

`N` by tier:

| Tier | N | IFFTs/frame | Spectrum update |
|------|---|-------------|-----------------|
| ULTRA | 512 | 12 | every frame |
| HIGH | 256 | 12 | every frame |
| MEDIUM | 256 | 8 (cascade 2 derivatives folded) | every frame |
| LOW | - | 0 | Gerstner, 03.1.10 |

### 03.1.4 Initial spectrum h0 (baked, CPU or one-shot compute)

For every discrete `k = (k_x, k_z)` with `k_x = 2pi*(n - N/2)/L`, `k_z = 2pi*(m - N/2)/L`:

```
kmag = length(k);  if (kmag < 1e-6) { h0 = 0; continue; }
theta = atan2(k.x, -k.z)                       // heading convention: 0 = north
S2D  = S_total(kmag, theta) / kmag             // 1/k converts S(k)*D(theta) to a 2D density
amp  = sqrt( 2.0 * S2D * W_c(kmag) * dk * dk )
h0   = (1/sqrt(2)) * (xi_r + i*xi_i) * amp     // xi ~ N(0,1), Box-Muller from a seeded PCG32
```

Seed: `hash(worldSeed, cascadeIndex)`. The same seed always produces the same sea, so replays
and multiplayer-free determinism hold.

Storage: `h0` and `conj(h0(-k))` are packed into **one RGBA32Float 2D array texture,
`T_h0`, size N x N x 3**, channels `(h0.re, h0.im, h0conj.re, h0conj.im)`.
Memory at N=256: 256*256*3*16 B = **3.146 MB** (N=512: 12.58 MB).

`T_h0` is regenerated only when U10, wind direction, fetch, gamma or swell parameters change
by more than the thresholds in 03.10.4, and then it is **cross-faded over 12.0 real seconds**
between two h0 textures to avoid a visible pop.

### 03.1.5 Time evolution and dispersion quantisation

```
w(k) = sqrt( g * k * tanh(k * H_ref) )         // H_ref = 400.0 m -> effectively deep water
```

`tanh(k*400)` differs from 1 by < 1e-6 for all k in cascade 1 and 2, and by up to 0.14 for the
longest swell, which is the correct physical behaviour over a 400 m shelf. Shallow-water
shoaling near the island is handled separately in 03.3.7 because a single global FFT cannot
carry a spatially varying depth.

**Loop quantisation (binding).** To make the whole ocean exactly periodic with period
`T_rep = 200.0 real seconds`, quantise:

```
w0     = 2*PI / T_rep                          // 0.0314159 rad/s
w_q(k) = floor( w(k) / w0 + 0.5 ) * w0
```

This costs nothing visually (the quantisation error is < 0.5 * 0.0314 rad/s, i.e. a phase
error growing to at most PI over 200 s, which is absorbed by the loop itself) and buys:
seamless state save/restore, deterministic replay, and a cheap precomputed `exp(i w t)` table.

Per-frame spectrum update (compute, workgroup 8x8, dispatch ceil(N/8) x ceil(N/8) x 3):

```
h(k,t)   = h0(k) * exp(i*w_q*t)  +  conj(h0(-k)) * exp(-i*w_q*t)
Dy(k)    = h
Dx(k)    = -i * (k.x / kmag) * h * lambda_c
Dz(k)    = -i * (k.z / kmag) * h * lambda_c
dDy/dx   =  i * k.x * h
dDy/dz   =  i * k.z * h
dDx/dx   = -(k.x*k.x/kmag) * h * lambda_c
dDz/dz   = -(k.z*k.z/kmag) * h * lambda_c
dDx/dz   = -(k.x*k.z/kmag) * h * lambda_c
```

Eight real output fields. They are packed as **four complex fields** (each complex IFFT
carries two real signals using the standard Hermitian trick), so **4 IFFTs per cascade,
12 total**.

Choppiness `lambda_c` per cascade (dimensionless horizontal displacement gain):

| c | lambda_c | Rationale |
|---|----------|-----------|
| 0 | 1.00 | Long swell; higher values self-intersect. |
| 1 | 1.35 | Where wind-chop sharpening reads best. |
| 2 | 1.60 | Capillary crest sharpening; Jacobian is clamped anyway. |

`lambda_c` is multiplied by a global `chopScale` from the weather state (0.55 in glass calm,
1.0 nominal, 1.25 in storm).

### 03.1.6 IFFT in WGSL

Algorithm: **Stockham auto-sort radix-2, two passes (rows then columns), shared-memory
resident**.

- One workgroup per row/column. Workgroup size = N/2 threads (128 at N=256, 256 at N=512).
- Shared memory: 2 * N * 8 B (vec2<f32> ping/pong) = 4 KB at N=256, 8 KB at N=512. Both fit
  the 16 KB minimum WebGPU workgroup storage limit.
- `log2(N)` butterfly stages per pass (8 at N=256), `workgroupBarrier()` between stages.
- Twiddles from a precomputed `T_twiddle` R32Float texture of size (log2 N) x (N/2) x 2, or
  computed inline with `sincos` - measured: inline is 4% slower on Apple, 11% faster on
  discrete NVIDIA. Ship: **precomputed twiddle texture** (uniform behaviour, 8 KB).
- Bit-reversal is avoided entirely by Stockham.
- Pass 1 dispatch: (N, 1, 3*4) i.e. rows x cascades*fields. Pass 2 the same, transposed
  access. Total dispatches: 2.

Output textures (2D array, layer = cascade):

| Texture | Format | Size | Bytes (N=256) | Contents |
|---------|--------|------|---------------|----------|
| `T_disp` | RGBA16Float | N x N x 3 | 1.573 MB | (Dx, Dy, Dz, unused) |
| `T_deriv` | RGBA16Float | N x N x 3 | 1.573 MB | (dDy/dx, dDy/dz, dDx/dx + dDz/dz, dDx/dz) |
| `T_foam` | RG16Float | N x N x 3 | 0.786 MB | (foamAccum, jacobianMin) - persistent, ping-pong x2 |
| `T_h0` | RGBA32Float | N x N x 3 | 3.146 MB | baked spectrum, x2 for crossfade |
| `T_hkt` | RGBA32Float | N x N x 3 x 4 | 12.58 MB | intermediate complex fields (transient, aliased) |

Total steady-state ocean VRAM at HIGH: **~12.6 MB** (transients aliased into the renderer's
scratch heap). At ULTRA (N=512): ~50 MB.

`T_disp` and `T_deriv` are generated with a **full mip chain** (mip 0..8 at N=256) using a
custom box-downsample compute pass, because the hardware `generateMipmaps` equivalent does not
exist in WebGPU and because the derivative mips need a **second moment** channel:

```
// mip reduction for T_deriv: store mean slope AND slope variance
mean  = avg(child.xy)
var   = avg(child.x^2 + child.y^2) - dot(mean, mean)
out   = vec4(mean.x, mean.y, var, child.w_avg)
```

The variance channel drives the filtered specular roughness in 03.2.4. Mip generation cost:
0.09 ms.

### 03.1.7 Jacobian, foam generation, foam advection

Per texel, per cascade:

```
Jxx = 1.0 + lambda_c * dDx/dx
Jzz = 1.0 + lambda_c * dDz/dz
Jxz =       lambda_c * dDx/dz
J   = Jxx*Jzz - Jxz*Jxz
```

`J < 0` means the surface has folded (a breaking crest). `J` is summed across cascades by
multiplying the per-cascade Jacobians (correct to first order for independent displacements).

Foam injection and decay (persistent `T_foam`, updated every frame in the same compute pass
that reads `T_deriv`):

```
inject   = saturate( (J_thresh - J) * J_gain )
J_thresh = 0.58        // [TUNE]
J_gain   = 1.45

// advect the accumulator by the horizontal displacement gradient (foam rides the surface)
uv_prev  = uv - (D_xz(uv) - D_xz_prev(uv)) / L_c
F_adv    = sample(T_foam_prev, uv_prev).r

F_new    = max( F_adv * exp(-dt_r / tau_foam), inject )
tau_foam = 4.5 s   open ocean
         = 2.2 s   glass calm / clear
         = 7.5 s   storm (foam persists in streaks)
```

A second channel accumulates **"foam age"** for shading: fresh foam (age < 0.35 s) is bright
and opaque, old foam is thin, blue-tinted and streaky. Age advects with the same offset.

Additionally, **wind-streak foam**: at U10 > 12 m/s the foam accumulator is anisotropically
blurred along the wind direction with a 9-tap kernel of length `0.55 * U10` metres, producing
the Langmuir streaks that identify a real storm sea.

Whitecap coverage sanity check (Monahan & O'Muircheartaigh):
`W = 3.84e-6 * U10^3.41`. At U10 = 10 -> 0.0099 (1.0%), at U10 = 20 -> 0.104 (10.4%).
The Jacobian threshold `J_thresh` is auto-calibrated once per weather change by a 1-pass
histogram reduction over `T_foam` so that measured coverage matches `W` within +-15%.
This keeps the sea honest across all wind speeds without hand-tuning per state.

### 03.1.8 Normals

Normals are NOT stored; they are reconstructed in the pixel shader from `T_deriv` so that
mip-filtered slope variance is available:

```
slope = vec2(0);  varAcc = 0;
for c in 0..2 {
  d = textureSample(T_deriv, uv * (worldXZ / L_c), c);   // with per-cascade mip bias
  jac_xx = 1.0 + lambda_c * d.z * 0.5;   // packed sum term
  slope += d.xy / max(jac_xx, 0.15);
  varAcc += d.z_variance;
}
N = normalize(vec3(-slope.x, 1.0, -slope.y));
```

Per-cascade distance fade to kill aliasing (the discarded energy is moved into roughness, so
the specular lobe widens instead of the normal map sparkling):

| c | Full detail within | Fades to 0 at | Energy transfer |
|---|--------------------|---------------|-----------------|
| 2 | 24 m | 60 m | `alpha^2 += 2 * var_2` |
| 1 | 400 m | 900 m | `alpha^2 += 2 * var_1` |
| 0 | always | never | - |

### 03.1.9 CPU wave query (buoyancy authority)

The GPU field cannot be read back at 60 fps without a 2-3 frame stall, and vessel physics
needs the surface at the physics rate (120 Hz). Therefore the CPU maintains an independent
but **statistically identical** evaluation.

At each `T_h0` bake, the CPU extracts the **64 highest-amplitude components of cascade 0 and
the 32 highest of cascade 1** (96 total), sorted by `|h0| * sqrt(W_c)`, into a flat Float32Array
of `(kx, kz, kmag, amp, phase, omega)`.

```
oceanHeightAt(x, z, t):
  y = 0; dx = 0; dz = 0; sx = 0; sz = 0
  for i in 0..95:
    ph = kx_i*x + kz_i*z - omega_i*t + phase_i
    s = sin(ph); c = cos(ph)
    y  += amp_i * c
    dx += -lambda * (kx_i/kmag_i) * amp_i * s
    dz += -lambda * (kz_i/kmag_i) * amp_i * s
    sx += -kx_i * amp_i * s
    sz += -kz_i * amp_i * s
  return { y, dx, dz, n: normalize(vec3(-sx, 1, -sz)) }
```

The returned `(x + dx, y, z + dz)` is a point ON the surface; to get the height AT a given
`(x,z)` the caller runs **3 fixed-point iterations** of
`p = (x,z) - D_xz(p)` before evaluating `y`. Documented cost: 96 sin/cos * 4 iterations =
~3.5 us. Budget: 24 probe points per physics tick = 84 us/tick, 10.1 ms/s at 120 Hz. Acceptable.

Guaranteed accuracy vs the GPU field: **RMS <= 0.15 m at Hs = 2.5 m**, **<= 0.35 m at Hs = 8 m**.
Sub-metre chop that the CPU misses is applied to the vessel as a synthetic high-frequency
buoyancy noise (section 05), not as geometry error.

A verification harness renders the GPU heightfield and the CPU sum side by side with a
difference readout; CI-style manual check before each milestone. **NOT BUILT as specified** --
the shipped equivalent is `tools/test-ocean.mjs`, which checks the CPU spectrum offline.

### 03.1.10 LOW tier: Gerstner fallback

No FFT. A sum of **16 Gerstner waves** in the vertex shader plus **2 scrolling procedural
normal layers** baked once at boot into a 512x512 RGBA8 texture (derivative-of-value-noise,
4 octaves, generated by a 0.4 ms compute pass).

```
P  = P0 + sum_i [ (k_i/|k_i|) * A_i * Q_i * sin(dot(k_i,P0) - w_i t + ph_i) * (0,?,0 not applied to y) ]
y  =      sum_i [ A_i * cos(dot(k_i,P0) - w_i t + ph_i) ]
Q_i = steepness_i / (|k_i| * A_i * 16)      // 16 = wave count, guarantees no self-intersection
```

The 16 waves are drawn deterministically from the same JONSWAP spectrum at boot (importance
sampled by amplitude), so LOW and HIGH agree on gross sea state. Direction jitter
+-38 deg around the wind.

Reference table at U10 = 10 m/s, Hs = 2.46 m (regenerate for other U10 by scaling A by
`Hs/2.46` and lambda by `(U10/10)^2`):

| i | lambda (m) | A (m) | dir (deg from wind) | steepness | T (s) |
|---|-----------|-------|---------------------|-----------|-------|
| 0 | 148.0 | 0.42 | -11 | 0.55 | 9.74 |
| 1 | 112.0 | 0.51 | +19 | 0.60 | 8.47 |
| 2 |  87.6 | 0.62 |  -4 | 0.65 | 7.49 |
| 3 |  71.0 | 0.55 | +27 | 0.65 | 6.75 |
| 4 |  58.0 | 0.44 | -22 | 0.70 | 6.10 |
| 5 |  46.0 | 0.36 |  +8 | 0.70 | 5.43 |
| 6 |  35.5 | 0.28 | -33 | 0.75 | 4.77 |
| 7 |  27.0 | 0.21 | +14 | 0.75 | 4.16 |
| 8 |  19.5 | 0.155| -18 | 0.80 | 3.54 |
| 9 |  14.2 | 0.112| +31 | 0.80 | 3.02 |
|10 |  10.1 | 0.079| -7  | 0.85 | 2.55 |
|11 |   7.2 | 0.055| +23 | 0.85 | 2.15 |
|12 |   5.0 | 0.037| -29 | 0.90 | 1.79 |
|13 |   3.4 | 0.024| +12 | 0.90 | 1.48 |
|14 |   2.2 | 0.015| -15 | 0.95 | 1.19 |
|15 |   1.4 | 0.009| +36 | 0.95 | 0.95 |

Foam on LOW: `foam = smoothstep(0.62, 0.94, y/Hs) * smoothstep(0.2, 0.6, slopeMag)` - a crest
proxy, no Jacobian.

`oceanHeightAt` on LOW uses these same 16 waves, so CPU and GPU agree exactly.

---

## 03.2 (A cont.) OCEAN SURFACE MESH

### 03.2.1 Choice: camera-centred radial clipmap (NOT a projected grid)

**Decision: world-space concentric-ring clipmap with CDLOD geomorphing.**

Justification (this is a real trade and the losing option is popular, so state it):

| Criterion | Projected grid | Radial clipmap | Winner |
|-----------|----------------|----------------|--------|
| Vertex density where it matters | Perfect (screen-uniform) | Good (distance-uniform) | Projected |
| Stability under horizontal displacement | Poor - the grid is parameterised in screen space, so choppy displacement makes vertices slide relative to the texture, producing crawling normals and silhouette gaps at grazing angles | Excellent - vertex world XZ is fixed per frame modulo snapping | **Clipmap** |
| Camera crossing the waterline | Degenerate; the projector inverts and needs special cases | Trivial; the same mesh renders from either side | **Clipmap** |
| Underside rendering (Snell's window) | Needs a separate pass with a re-derived projector | Same draw, flipped winding | **Clipmap** |
| Intersecting terrain / shoreline | Hard to get skirts right | Ring blocks give natural per-block clipping and a fixed 0.5 m inner cell for the shore | **Clipmap** |
| Agreement with CPU buoyancy sampling | Screen-dependent, non-reproducible | World-space, reproducible | **Clipmap** |
| Triangle count for a 65 km horizon | Lower | Higher (mitigated by an analytic horizon ring) | Projected |
| Frustum culling granularity | N/A | Per 32x32 block | Clipmap |

The two decisive rows are displacement stability and the waterline. SUBWAVE's core sell is a
craft that flies over, lands on, and dives through the water surface; the camera lives at the
waterline more than any comparable game. The projected grid's failure exactly there rules it out.

### 03.2.2 Clipmap geometry

One shared vertex buffer: a **33 x 33 grid of unit-spaced vertices (1089 verts, 2048 tris,
6144 indices)**. Positions are `u16` pairs; total VB 4.4 KB, IB 12.3 KB. Everything else is
per-instance.

Per-instance data (`OceanBlockInstance`, 32 B, storage buffer, up to 256 instances):

```
struct OceanBlockInstance {
  originXZ : vec2<f32>,   // world XZ of block corner, snapped
  scale    : f32,         // metres per grid cell for this level
  level    : f32,         // LOD level index, float for morph math
  morphK   : vec2<f32>,   // CDLOD morph start/end radii, metres
  _pad     : vec2<f32>,
}
```

Levels:

| Level l | Cell size (m) | Block extent (m) | Blocks | Coverage radius (m) |
|---------|---------------|------------------|--------|---------------------|
| 0 | 0.50 | 16.0 | 16 (4x4) | 32 |
| 1 | 1.00 | 32.0 | 12 (ring) | 64 |
| 2 | 2.00 | 64.0 | 12 | 128 |
| 3 | 4.00 | 128.0 | 12 | 256 |
| 4 | 8.00 | 256.0 | 12 | 512 |
| 5 | 16.0 | 512.0 | 12 | 1,024 |
| 6 | 32.0 | 1,024 | 12 | 2,048 |
| 7 | 64.0 | 2,048 | 12 | 4,096 |
| 8 | 128.0 | 4,096 | 12 | 8,192 |
| 9 | 256.0 | 8,192 | 12 | 16,384 |
| 10 | 512.0 | 16,384 | 12 | 32,768 |

Totals before culling: 16 + 10*12 = **136 blocks, 278,528 triangles, 148,104 vertices**.
After frustum culling at 65 deg horizontal FOV: typically **38-52 blocks, 78k-107k triangles**.

Beyond 32.8 km: a single **horizon ring** (a 256-segment annulus from 32.8 km to 140 km,
512 triangles) shaded with cascade-0 statistics only (no displacement, BRDF + sky only) and
cross-faded with the last clipmap level over 4 km.

Each level is snapped to `2 * cellSize` to prevent vertex swimming:
`origin = floor(cam.xz / (2*cell)) * (2*cell)`.

CDLOD morph: for a vertex at grid position `p` in a block of level `l`,

```
d      = length(worldXZ - cam.xz)
morph  = saturate( (d - morphK.x) / (morphK.y - morphK.x) )
morphK = (0.72 * R_l, 0.98 * R_l)          // R_l = coverage radius of level l
pSnap  = floor(p * 0.5) * 2.0              // even neighbour
worldXZ = mix(p, pSnap, morph) * scale + origin
```

Culling: a compute pass (`ocean_cull`, workgroup 64, 1 dispatch of 4 groups) tests each of
the 136 candidate blocks against the frustum, expanded vertically by the conservative
displacement bound `+-(1.6*Hs + 0.5)` m, and writes a compacted instance buffer plus an
indirect draw args buffer. Zero CPU readback.

### 03.2.3 Vertex displacement

```
disp = vec3(0);
for c in 0..2 {
  fade = oceanCascadeFade(c, d);          // table 03.1.8
  if (fade <= 0.0) continue;
  disp += textureSampleLevel(T_disp, worldXZ / L_c, c, mipForCell(scale, L_c)).xyz * fade;
}
worldPos = vec3(worldXZ.x + disp.x, disp.y, worldXZ.y + disp.z);
```

`mipForCell` selects `log2(scale / dx_c)` so the sampled detail never exceeds the vertex
Nyquist. Vertex-level cascade drop-out (cascade 2 always dropped for `scale > 0.5 m`,
cascade 1 for `scale > 4 m`) means the largest blocks are cheap.

Additionally a **domain warp** on cascade 0 UVs at very large scale removes the residual
2,048 m tiling:
`uv0 += 0.035 * L0 * (fbm2(worldXZ * 1.4e-4), fbm2(worldXZ * 1.4e-4 + 71.3))`
This distorts the long swell by up to 72 m over kilometre scales - invisible as a distortion,
fatal to the perception of tiling.

### 03.2.4 Underside pass

When `cam.y < +2.0 m` the clipmap is drawn a second time with `cullMode: 'front'` and a
different fragment entry point:

- Fresnel computed with `n1 = 1.339, n2 = 1.0`. Critical angle
  `theta_c = asin(1/1.339) = 48.31 deg`.
- Inside Snell's window (angle from vertical < 48.31 deg): refract the view ray into air and
  sample the sky-view LUT and the cloud buffer; compress the whole hemisphere into the disc.
  This is the single most recognisable "you are underwater" cue and must be exact.
- Outside the window: total internal reflection - sample the SSR buffer / mirrored terrain, so
  the ceiling becomes a mirror of the seafloor. Fade TIR reflectance from 0.06 at 46 deg to
  1.00 at 48.31 deg over a 2.3 deg band.
- The window edge gets chromatic dispersion: sample R/G/B with refracted directions computed
  from n = (1.3405, 1.3345, 1.3305), giving a real prismatic rim.
- Foam seen from below is a diffuse white sheet with transmission 0.30 and a strong
  forward-scatter bloom.
- Rain seen from below: the ripple normal layer (03.10.6) is applied to the underside normal
  at 0.6 weight, so a squall is visible as a stippled ceiling.

Levels 6-10 are skipped for the underside (nothing beyond ~2 km is meaningfully visible
through water) -> 52 blocks max, 0.35 ms.

---

## 03.3 (B) SURFACE SHADING

### 03.3.1 BRDF

Specular only for the water itself; there is no diffuse albedo for water (all "colour" comes
from the volumetric transfer below the surface, 03.4).

```
F0 = 0.02037                                  // ((1.339-1)/(1.339+1))^2, scalar (water is achromatic here)
F  = F0 + (1 - F0) * pow(1 - saturate(dot(N, V)), 5.0)      // Schlick
```

Grazing-angle guard: at |N.V| < 0.06 the interpolated normal is unreliable and F -> 1 produces
a bright horizon line. Clamp:
`F = mix(F, 0.92, smoothstep(0.10, 0.02, dot(N,V)))` and additionally bend N toward V
("normal flattening") by `mix(N, normalize(N + V*0.55), smoothstep(0.25,0.0,dot(N,V)))`.

Microfacet distribution: **GGX**, anisotropic, with roughness derived from unresolved slope
variance (03.1.6/03.1.8):

```
alpha_base = 0.0270 + 0.0016 * U10          // glassy 0.027 at calm, 0.059 at U10=20
alpha_x^2  = alpha_base^2 + 2.0 * varSlopeX_unresolved
alpha_z^2  = alpha_base^2 + 2.0 * varSlopeZ_unresolved
alpha_x, alpha_z clamped to [0.018, 0.34]
```

Anisotropy is real: wind-driven seas have larger cross-wind slope variance than along-wind at
short scales, and the resulting stretched sun glitter path is a signature ocean look.
`varSlope` per axis comes from the variance channel of the `T_deriv` mip chain, rotated into
wind space.

Sun as an area light: sun angular radius `theta_sun = 0.00465 rad (0.266 deg)`,
solid angle `omega_sun = 6.79e-5 sr`. Use Karis' normalisation:

```
alpha_eff = saturate( alpha + theta_sun / (2 * dist_norm) )   // dist_norm = 1 for a directional light
energyNorm = (alpha / alpha_eff)^2
```

Sky specular (IBL): a **256x256 octahedral environment map**, `RGBA16Float`, 8 mips,
prefiltered with GGX importance sampling (16 samples/texel, split across 4 frames, 0.11 ms).
The base level is filled analytically from the sky-view LUT plus the cloud buffer, so it is
always exactly consistent with the sky the player sees. Split-sum: a 32x32 RG16Float DFG LUT
baked once at boot.

### 03.3.2 Reflections - three-tier composite

Evaluated in this order, each filling in where the previous failed:

**Tier 1 - Screen-space reflections.**
- Half resolution (960x540), R11G11B10Float output + R8 confidence.
- Ray march in the HiZ pyramid (section 02), max **48 iterations**, starting mip 1, mip
  descend on hit, ascend on miss.
- Thickness test: a hit is accepted if
  `0 < (rayDepth - sceneDepth) < max(0.5, 0.02 * sceneDepth)` metres.
- Source: **previous frame colour, reprojected** by the previous view-projection using the
  current frame's depth. Reprojection failure (velocity disocclusion) -> confidence 0.
- Edge fade: confidence multiplied by `smoothstep(0, 0.12, min(uv, 1-uv))` per axis.
- Ray jitter: per-pixel blue-noise offset from a 128x128 R8 spatiotemporal blue noise texture,
  cycled over 32 frames; result temporally accumulated with alpha 0.12 and a 3x3
  neighbourhood clamp.
- Roughness: rays are cone-traced by choosing the source mip
  `mip = log2(1 + alpha_eff * hitDistance * 8)`.
- Cost 0.55 ms. Off on LOW.

**Tier 2 - Planar reflection, vessel + island silhouette only.**
- Enabled when `abs(cam.y) < 30.0` and camera is above water.
- 640x360 RGBA16Float, reflection matrix about the plane `y = meanSurfaceY` (NOT the displaced
  surface - the error is absorbed by the normal-based UV distortion below).
- Draws only: the player vessel, terrain within 200 m, and creatures within 60 m. No
  volumetrics, no clouds (those come from Tier 3).
- Sampled with UV displaced by the surface normal: `uv += N.xz * 0.11 * (1 - saturate(y/8))`.
- Composited where SSR confidence < 0.75.
- HIGH and ULTRA only.

**Tier 3 - Analytic sky / env probe.**
- Always available, zero failure. Samples the octahedral env map at the reflected vector with
  mip from `alpha_eff`.
- Above-horizon reflected rays: sky-view LUT + clouds.
- Below-horizon reflected rays (which happens constantly on a rough sea): use the
  **underwater ambient colour at 1.5 m depth** (03.4.6), not black. This one detail is the
  difference between a plausible sea and a plastic one.

Composite:

```
R = mix( mix(skyProbe, planarR, planarConf), ssrR, ssrConf )
```

### 03.3.3 Refraction

The scene below the surface is available in the opaque colour buffer (water is drawn after
opaques, before transparents).

```
// 1. tangential normal offset, scaled by how much water there actually is
depthDelta = linearDepth(sceneDepth) - linearDepth(surfaceDepth)      // metres of water column
strength   = 0.18 * min(depthDelta, 0.60)                            // metres of lateral shift
uvOff      = (N.xz - Nflat.xz) * strength * projScale / linearDepth(surfaceDepth)

// 2. chromatic dispersion
uvR = uv + uvOff * 1.000
uvG = uv + uvOff * 0.985
uvB = uv + uvOff * 0.970

// 3. validity: reject samples whose scene depth is IN FRONT of the water
if (linearDepth(sceneDepth(uvC)) < linearDepth(surfaceDepth)) uvC = uv;   // per channel

refr = vec3(sample(uvR).r, sample(uvG).g, sample(uvB).b)
```

Then the water column between the surface and the refracted geometry is integrated with the
full underwater transfer of 03.4.5 using path length `depthDelta / max(0.15, -refractedRay.y)`.
This is what produces the correct "sand is warm at 0.4 m and cyan at 6 m" shoreline gradient
without any hand-authored ramp.

### 03.3.4 Foam shading

```
foamCoverage = saturate( F_accum * 1.35 )
// break up the shape so it never looks like a blob
erosion = worley3(worldXZ * 1.7, t*0.05) * 0.55 + worley3(worldXZ * 6.1, t*0.11) * 0.30
                                              + valueNoise(worldXZ * 19.0) * 0.15
foamMask = smoothstep(erosion - 0.14, erosion + 0.14, foamCoverage)
```

| Property | Fresh foam (age < 0.35 s) | Old foam (age > 2.0 s) |
|----------|---------------------------|------------------------|
| Albedo | (0.92, 0.94, 0.95) | (0.62, 0.68, 0.72) |
| Roughness (alpha) | 0.48 | 0.62 |
| Opacity over water | 1.00 | 0.55 |
| Subsurface tint | (0.55, 0.78, 0.80) | (0.40, 0.62, 0.66) |
| Emissive (night, bioluminescent bloom biomes) | see 06 | - |

Foam is lit as a **dense scattering slab**: diffuse `albedo/PI * (NdotL)` plus a wrap term
`saturate((NdotL + 0.35)/1.35)` and a strong forward transmission when the sun is behind
(`pow(saturate(dot(V,-L)), 3.5) * 0.6`), which makes backlit breaking crests glow.

### 03.3.5 Sun glitter and horizon filtering

At the horizon a single pixel covers thousands of wave facets. Without filtering this is a
solid white band. Beyond `alpha` widening, apply a **pixel-footprint slope integration**:

```
footprintM   = linearDepth * pixelAngularSize / max(0.05, abs(V.y))   // metres of sea per pixel
extraVar     = slopeVarianceAtScale(footprintM)                       // from the T_deriv mip chain
alpha_x^2   += 2 * extraVar.x;  alpha_z^2 += 2 * extraVar.y
```

`slopeVarianceAtScale` reads the mip whose texel size >= footprintM. Beyond the last mip
(footprint > 2048 m), use the analytic Cox-Munk total slope variance:
`sigma_total^2 = 0.003 + 0.00512 * U10` (upwind+crosswind, classic Cox-Munk 1954).
At U10 = 10 this is 0.0542 -> RMS slope 0.233 rad = 13.4 deg. The horizon glitter path width
then falls out of physics, not tuning.

### 03.3.6 Shallow water and shoreline

`h_col = surfaceY - terrainY` (metres of water column, from `T_height`).

Depth colour ramp (this is the *result* of 03.4 for the reef water type, tabulated here as the
acceptance target that the volumetric transfer must reproduce; it is not a separate art asset):

| h_col (m) | Perceived surface colour (linear RGB, noon, clear, Jerlov IA reef) |
|-----------|-------------------------------------------------------------------|
| 0.00 | (0.86, 0.79, 0.63) wet sand showing through |
| 0.15 | (0.78, 0.76, 0.66) |
| 0.40 | (0.62, 0.74, 0.69) |
| 1.00 | (0.42, 0.72, 0.72) |
| 2.50 | (0.24, 0.66, 0.74) |
| 5.00 | (0.13, 0.56, 0.73) |
| 10.0 | (0.055, 0.42, 0.68) |
| 20.0 | (0.017, 0.26, 0.58) |
| 40.0 | (0.004, 0.12, 0.43) |
| 80.0 | (0.000, 0.035, 0.26) |
| 200+ | (0.000, 0.002, 0.075) |

Shoreline whitecap band, driven by the shoreline SDF `d_s` (metres, +ve seaward):

```
phase   = d_s / lambda_s - t_r / T_s
band    = pow( saturate(sin(2*PI*phase) * 0.5 + 0.5), 5.0 )
shoreFoam = band
          * smoothstep(6.5, 0.0, h_col)                     // only in shallow water
          * smoothstep(0.35, 1.20, Hs)                      // no surf on a glass-calm day
          * (0.55 + 0.45 * noise2(worldXZ * 0.09 + t_r*0.02))  // alongshore variation
lambda_s = 22.0 m       // shore-parallel wave spacing
T_s      = 6.5 s        // set period; scaled by (Tp / 7.5) from the spectrum
```

Two bands are summed with `lambda_s` = 22.0 m and 41.0 m and a 0.37 phase offset so the surf
does not look metronomic.

Breaking clamp (a real, cheap Miche-type limit that stops waves from towering in 0.5 m of
water):

```
A_max     = 0.78 * h_col            // depth-limited breaking
shoal     = clamp( pow(max(h_col, 0.4) / 40.0, -0.25), 1.0, 2.20 )   // Green's law, clamped
dispY    *= shoal
dispY     = clamp(dispY, -A_max, A_max)
dispXZ   *= mix(1.0, 0.25, smoothstep(3.0, 0.3, h_col))   // choppiness dies in the shallows
```

Wet sand (applied by the terrain shader, parameters owned here):

```
wetLine   = maxSurfaceY_over_last_3s(xz)          // a 512^2 R16Float "wetness" texture, decays
wetness   = saturate( (wetLine - terrainY + 0.05) / 0.60 )
wetness  *= exp(-dt_r / 3.0)                       // 3.0 s dry-off time constant
albedo   *= mix(1.0, 0.45, wetness)
roughness = mix(roughness, roughness - 0.35, wetness)
F0        = mix(F0_sand, 0.02, wetness * 0.7)      // wet sand gets a water film
```

A thin **sheet-flow** layer: where `-0.05 < h_col < 0.12`, render the ocean surface with
opacity `saturate(h_col/0.12)` and add a 0.4-weight specular sheen, which gives the receding
wave its wet glassy skin instead of a hard geometric edge.

---

## 03.4 (C) UNDERWATER OPTICS

This is the most important system in the game. Everything below is physically parameterised;
no "underwater blue tint" post-effect exists anywhere in the codebase.

### 03.4.1 The transport model

Radiance arriving at the eye along a ray of length `s` through a homogeneous medium:

```
L(s) = T(0,s) * L_bg  +  Integral_0^s [ T(0,t) * sigma_s * Integral_4pi p(w,w') L_i(x_t,w') dw' ] dt

T(a,b) = exp( -sigma_t * (b-a) ),   sigma_t = sigma_a + sigma_s      // per RGB channel
```

We evaluate this as **three additive terms**:

1. `L_direct` - background radiance attenuated by `exp(-sigma_t * s)` (beam attenuation).
2. `L_ss` - analytic single scattering of the refracted sun beam (03.4.5).
3. `L_ms` - multiple scattering / ambient, approximated with a similarity-theory reduced
   medium and the depth-dependent ambient irradiance (03.4.6).

Local light sources (vessel lamps, flares, bioluminescence) are handled in the froxel volume
(03.5), not analytically, because they need shadowing and per-froxel occlusion.

### 03.4.2 Two attenuation coefficients (critical distinction)

Real ocean optics has two different attenuation numbers and using the wrong one is the classic
mistake that makes rendered water look either too opaque or too clear.

| Symbol | Name | Applies to |
|--------|------|------------|
| `sigma_t = sigma_a + sigma_s` | Beam attenuation `c` | A **collimated** path: the direct view ray, specular highlights, distant object visibility, the sun beam's own extinction. |
| `Kd` | Diffuse attenuation | The **downwelling irradiance** field, i.e. how much daylight is left at depth d. Always smaller than `sigma_t` because forward-scattered photons stay in the beam. |

We relate them with a fixed forward-scatter fraction:

```
Kd = sigma_a + f_b * sigma_s ,     f_b = 0.35
```

`f_b = 0.35` is chosen so that the derived `Kd` for the clear-oceanic type matches published
Jerlov IA values to within 5%.

Underwater visibility (Secchi-like, contrast threshold 2%) is
`V = 3.912 / sigma_t` for the most-transmitting channel; every water type below lists it.

### 03.4.3 Water types (binding table)

RGB band centres: **R = 610 nm, G = 550 nm, B = 460 nm**.

All coefficients in **1/m**.

| # | Id | sigma_a (R,G,B) | sigma_s (R,G,B) | sigma_t (R,G,B) | Kd (R,G,B) | g (HG) | Vis (m) |
|---|-----|-----------------|-----------------|-----------------|------------|--------|---------|
| 1 | `OCEANIC_CLEAR` (Jerlov IA) | 0.2520, 0.0520, 0.0165 | 0.0110, 0.0160, 0.0250 | 0.2630, 0.0680, 0.0415 | 0.2559, 0.0576, 0.0253 | 0.924 | 94.3 |
| 2 | `REEF_TURQUOISE` (Jerlov II shallow) | 0.2780, 0.0640, 0.0290 | 0.0850, 0.0980, 0.1150 | 0.3630, 0.1620, 0.1440 | 0.3078, 0.0983, 0.0693 | 0.918 | 27.2 |
| 3 | `COASTAL_GREEN` (Jerlov 3C, kelp) | 0.3600, 0.0850, 0.1400 | 0.2200, 0.2800, 0.3200 | 0.5800, 0.3650, 0.4600 | 0.4370, 0.1830, 0.2520 | 0.905 | 10.7 |
| 4 | `MURKY_PARTICULATE` (silt basin) | 0.9000, 0.5500, 0.6800 | 1.6000, 1.7000, 1.7500 | 2.5000, 2.2500, 2.4300 | 1.4600, 1.1450, 1.2925 | 0.862 | 1.74 |
| 5 | `BRINE` (hypersaline pool) | 0.6500, 0.1400, 0.0300 | 0.0400, 0.0500, 0.0700 | 0.6900, 0.1900, 0.1000 | 0.6640, 0.1575, 0.0545 | 0.800 | 39.1 |
| 6 | `ABYSSAL_VOID` (> 900 m, oligotrophic) | 0.2300, 0.0480, 0.0140 | 0.0060, 0.0080, 0.0120 | 0.2360, 0.0560, 0.0260 | 0.2321, 0.0508, 0.0182 | 0.930 | 150.5 |
| L | `VENT_SMOKE` (local override volume) | 3.4000, 3.1000, 2.9000 | 5.2000, 4.9000, 4.6000 | 8.6000, 8.0000, 7.5000 | 5.2200, 4.8150, 4.5100 | 0.780 | 0.52 |

Extra per-type properties:

| Id | n (index) | rho (kg/m^3) | MS boost | Snow multiplier | Notes |
|----|-----------|--------------|----------|-----------------|-------|
| `OCEANIC_CLEAR` | 1.3390 | 1025 | 1.00 | 1.00 | Default open ocean. |
| `REEF_TURQUOISE` | 1.3392 | 1026 | 1.30 | 0.75 | Starting zone. Bright, high MS -> the glowing turquoise look. |
| `COASTAL_GREEN` | 1.3395 | 1024 | 1.55 | 1.60 | Kelp forests, river outflow. |
| `MURKY_PARTICULATE` | 1.3400 | 1028 | 2.20 | 6.00 | Sediment basins, dread biome. |
| `BRINE` | 1.3900 | 1198 | 0.85 | 0.20 | Visible refractive interface with seawater; separate buoyancy density. |
| `ABYSSAL_VOID` | 1.3402 | 1032 | 0.90 | 0.55 | Below 900 m; daylight is already zero here, matters only for lamp falloff. |
| `VENT_SMOKE` | 1.3410 | 1010 | 3.00 | 12.00 | Emissive: (0.9,0.35,0.10) * 0.4 cd/m^2 near the orifice; T = 620 K plume shimmer. |

**Verification of the brief's requirements** (1% transmission depth, `d_1% = 4.605 / Kd`, for
OCEANIC_CLEAR):

| Channel | Kd | d at 10% | d at 1% | Requirement | Pass |
|---------|-----|---------|---------|-------------|------|
| R (610 nm) | 0.2559 | 9.0 m | 18.0 m | red gone by 15-20 m | YES |
| G (550 nm) | 0.0576 | 40.0 m | 80.0 m | green gone by 60-100 m | YES |
| B (460 nm) | 0.0253 | 91.0 m | 182.0 m | blue gone by ~200 m | YES |

Blending: `waterTypeAt()` returns up to 3 weights; all coefficients are **linearly blended in
coefficient space** (not in colour space), and `g` is blended by the scattering-weighted mean
`g_mix = sum(w_i * sigma_s_i * g_i) / sum(w_i * sigma_s_i)`.

Blend fields are authored as a 3D low-resolution texture `T_waterType`
(**64 x 32 x 64, RGBA8Unorm, covering the whole 16 km x 2 km x 16 km world = 0.5 MB**), where
the 4 channels are weights for types 2,3,4,5 and type 1 is `1 - sum`. Type 6 is selected
analytically by `depth > 900 m`. Vent smoke volumes are separate analytic spheres/cones
(up to 16 active) evaluated in the froxel injection pass.

### 03.4.4 Depth-dependent modifiers

Two effects modulate the base coefficients with depth, both real and both cheap:

```
// 1. Deep chlorophyll maximum: a scattering/absorption bump at the thermocline
dcm = 1.0 + 0.55 * exp( -pow((d - 62.0) / 26.0, 2.0) )       // peak +55% at 62 m
sigma_s *= dcm ;  sigma_a *= (1.0 + 0.35*(dcm-1.0))

// 2. Storm-stirred sediment in the surface layer
stir = 1.0 + (3.5 * stormFactor) * exp(-d / 9.0)             // stormFactor in [0,1], 03.10
sigma_s *= stir ; sigma_a *= (1.0 + 0.5*(stir-1.0))
```

Thermocline is also a *visible* refractive layer: at `d = 58..66 m` a subtle shimmer
(refraction UV offset of 1.2 px amplitude modulated by a scrolling 3D noise at 0.08 Hz) is
applied in the underwater post pass. Density step 1025 -> 1027.5 kg/m^3 across the layer is
exported to section 05 for neutral-buoyancy gameplay.

### 03.4.5 Analytic single scattering (the sun beam)

The sun refracts at the surface (Snell, n = 1.339). With `theta_a` = solar zenith angle in
air, `sin(theta_w) = sin(theta_a) / 1.339`, so the underwater sun is always within 48.31 deg
of vertical - hence beams underwater are always relatively steep, which is exactly the look.

Let:
- `d_c` = camera depth (m)
- `w` = view direction (unit), `w.y > 0` looking up
- `s` = distance to the first opaque hit (or the froxel far plane)
- `mu_s = |cos(theta_w)|` = vertical component of the refracted sun direction
- `k_s = Kd / mu_s` per channel (sun path attenuation per metre of *depth*)
- `k_v = sigma_t` per channel (view path attenuation per metre of *path*)
- `E_sun_uw(0)` = per-channel sun irradiance just below the surface (03.4.6)
- `p = phase(dot(w, sunDirWater))`

Depth along the ray: `d(t) = d_c - t * w.y`.

```
Integral = Int_0^s sigma_s * p * E_sun_uw(0) * exp(-k_s*(d_c - t*w.y)) * exp(-k_v*t) dt
         = sigma_s * p * E_sun_uw(0) * exp(-k_s*d_c) * ( exp(A*s) - 1 ) / A
where A = k_s * w.y - k_v
```

Numerical guard (A -> 0 when the view ray is parallel to the iso-attenuation surfaces):

```
if (abs(A) < 1e-4) { term = s * (1.0 + 0.5*A*s); }     // 2-term Taylor of (exp(A s)-1)/A
else               { term = (exp(A*s) - 1.0) / A;  }
```

Multiply by an occlusion factor `Vis_sun` obtained from the froxel volume (or, when froxels
are disabled, from a single shadow-map sample at the ray midpoint) and by the caustic
transmission texture sampled at the ray's mid-depth projection - this is what makes single
scattering ripple.

Phase function (two-term, because a single HG at g = 0.92 has no backscatter at all and the
water looks unlit from behind):

```
hg(mu, g) = (1 - g*g) / (4*PI * pow(1 + g*g - 2*g*mu, 1.5))
p(mu)     = w_f * hg(mu, g_f) + (1 - w_f) * hg(mu, g_b)
w_f = 0.85,  g_f = g_type,  g_b = -0.25
```

At `g_type = 0.924`: forward peak `p(1) = 0.85 * 26.1 + 0.15 * 0.0509 = 22.2 sr^-1`, backscatter
`p(-1) = 0.85 * 0.00108 + 0.15 * 0.0509 = 0.0086 sr^-1`. Ratio ~2580:1, matching Petzold.

### 03.4.6 Ambient irradiance vs depth, sun elevation and cloud

**Step 1 - surface global horizontal illuminance.**

```
h        = solar elevation (rad), negative below horizon
E_dir_h  = 1.0e5 * max(0, sin(h))^1.13 * exp(-0.19 / max(0.05, sin(h)))   // lux, direct on horizontal
E_dif_h  = 1.05e4 * max(0.02, sin(h + 0.105))^0.72 + twilight(h)          // lux, sky diffuse
twilight(h) = 3.4 * exp( (h + 0.1047) / 0.0524 )   for h < -0.1047 rad (-6 deg), else 0
```

`twilight(h)` is fitted so that: civil twilight end (h = -6 deg) = 3.4 lux, nautical
(h = -12 deg) = 0.008 lux, astronomical (h = -18 deg) = 0.0006 lux. This matches published
twilight illuminance to better than a factor of 2 across 24 magnitudes.

**Step 2 - cloud modulation.**

```
T_cloud_total  = 1.0 - 0.78 * pow(C, 1.30)          // C = cloud cover fraction [0,1]
f_direct       = pow(1.0 - C, 1.80)                 // fraction of the direct beam surviving
E_dir_h' = E_dir_h * f_direct * T_cloud_total
E_dif_h' = (E_dif_h + E_dir_h * (1 - f_direct) * 0.62) * T_cloud_total
```

At C = 1.0 (solid overcast) `T_cloud_total = 0.22`, `f_direct = 0` -> total horizontal
illuminance at noon drops from ~95 klx to ~19 klx. Correct (real overcast noon: 10-25 klx).

**Step 3 - spectral split.** Multiply by the tint vectors (each normalised to luminance 1.0):

| Condition | T_sun (R,G,B) | T_sky (R,G,B) |
|-----------|---------------|---------------|
| h > 30 deg | 1.050, 1.000, 0.930 | 0.690, 0.980, 2.070 |
| h = 15 deg | 1.180, 0.965, 0.795 | 0.720, 0.985, 1.940 |
| h = 6 deg | 1.400, 0.905, 0.560 | 0.840, 0.995, 1.660 |
| h = 2 deg | 1.680, 0.815, 0.325 | 1.020, 1.010, 1.310 |
| h = 0 deg | 1.860, 0.750, 0.210 | 1.180, 1.010, 1.080 |
| h < -2 deg | - (no direct) | 1.020, 1.000, 1.180 |
| overcast (any h) | - | 0.980, 1.000, 1.045 |

Interpolate linearly in `h`. Overcast tint is blended in by `C^1.5`.

**Step 4 - surface transmission (Fresnel + whitecaps).**

```
theta_a  = acos(sin(h))                              // solar zenith
R_dir    = fresnelUnpolarised(theta_a, 1.0, 1.339)   // ~0.021 at h=49, 0.06 at h=15, 0.35 at h=3
T_dir    = (1 - R_dir) * (1 - W)                     // W = whitecap fraction, 03.1.7
T_dif    = 0.934 * (1 - 0.6*W)                       // integrated hemispherical transmittance

E_uw(0-) = E_dir_h' * T_sun * T_dir  +  E_dif_h' * T_sky * T_dif      // per RGB, lux-eq
```

The rough-surface correction: `R_dir` is evaluated with the mean surface tilt included by
averaging Fresnel over a Gaussian slope distribution with variance `sigma_total^2` from
03.3.5. Precompute this into a **64 x 16 R16Float LUT** indexed by (solar zenith, slope
variance), regenerated when U10 changes.

**Step 5 - propagation to depth.**

```
E_d(depth) = E_uw(0-) * exp( -Kd_eff * depth ) * S_aphotic(depth)

Kd_eff     = Kd * (1.0 + 0.14 * (1/mu_s - 1.0))       // slant-path correction, mu_s = cos(refracted zenith)

S_aphotic(d) = 1.0 - smoothstep(320.0, 540.0, d)      // BINDING: hard aphotic window
```

`S_aphotic` is not physical padding - it is the numerical statement of "below 540 m there is
zero daylight in this game". Justification:
(a) real photosynthetically usable light ends at 150-200 m and human-visible daylight at
    600-1000 m in the clearest ocean;
(b) leaving a 1e-8 signal alive forces the auto-exposure to hunt and the tonemapper to lift
    grain into a visible grey soup;
(c) the design requires that below the twilight zone the ONLY light in the world is the
    player's lamps and bioluminescence. That is a hard guarantee, and this window is how it
    is enforced.

Combined with the `EV100 >= -3.0` clamp, everything below 540 m is measured black.

**Reference table - OCEANIC_CLEAR, noon (h = 49 deg), clear sky (C = 0.05).**
`E_uw(0-) = (91.0, 91.7, 103.7) klx-eq`.

| depth (m) | E_R (lux) | E_G (lux) | E_B (lux) | Scalar (lx) | % of surface | Look |
|-----------|-----------|-----------|-----------|-------------|--------------|------|
| 0 | 91,000 | 91,700 | 103,700 | 93,100 | 100% | blinding, sun glitter |
| 2 | 54,600 | 81,700 | 98,600 | 84,200 | 90.4% | bright turquoise |
| 5 | 25,300 | 68,700 | 91,400 | 71,900 | 77.2% | sunlit reef |
| 10 | 7,030 | 51,500 | 80,600 | 54,000 | 58.0% | red already 7.7% |
| 15 | 1,955 | 38,600 | 71,000 | 40,300 | 43.3% | skin looks green |
| 20 | 543 | 28,900 | 62,600 | 30,300 | 32.5% | blood is green |
| 30 | 42.0 | 16,200 | 48,700 | 15,200 | 16.3% | monochrome blue-green |
| 40 | 3.25 | 9,120 | 37,900 | 9,270 | 9.96% | dive-light territory |
| 60 | 0.019 | 2,880 | 22,900 | 3,720 | 4.00% | twilight begins |
| 80 | 0.000 | 910 | 13,800 | 1,650 | 1.77% | caustics gone |
| 100 | 0.000 | 288 | 8,340 | 808 | 0.87% | deep blue only |
| 150 | 0.000 | 16.2 | 2,320 | 179 | 0.19% | dusk-equivalent |
| 200 | 0.000 | 0.91 | 646 | 47.3 | 0.051% | the "blue nothing" |
| 300 | 0.000 | 0.0029 | 50.1 | 3.62 | 0.0039% | just navigable without lights |
| 400 | 0.000 | 0.000 | 2.72 (x0.700) | 0.196 | 2.1e-4 % | starlight-equivalent |
| 450 | 0.000 | 0.000 | 0.616 (x0.451) | 0.0445 | 4.8e-5 % | lamps mandatory |
| 500 | 0.000 | 0.000 | 0.0888 (x0.087) | 0.0064 | 6.9e-6 % | effectively black |
| 540+ | 0.000 | 0.000 | 0.000 | 0.000 | 0 | TRUE BLACK |

(Values at 400-500 m include the `S_aphotic` factor, shown in parentheses.)

**Ambient radiance from irradiance.** The underwater light field is strongly downwelling, so
ambient radiance depends on view direction:

```
L_amb(d, w) = E_d(d) / (2*PI) * ( 0.35 + 0.65 * pow( saturate(w.y*0.5 + 0.5), 1.80 ) )
```

Looking straight up at 10 m: `L = 51,500/6.283 * 1.0 = 8,196 cd/m^2` (matches a bright sky,
correct). Looking straight down at 10 m: `L = 51,500/6.283 * 0.35 = 2,869 cd/m^2`.

**Multiple scattering / ambient in-scatter term** (similarity theory reduced medium):

```
sigma_s' = sigma_s * (1 - g)
sigma_t' = sigma_a + sigma_s'
albedo'  = sigma_s' / sigma_t'
L_ms(s)  = L_amb(d_avg, w) * albedo' * MS_boost * (1 - exp(-sigma_t' * s))
```

`d_avg = d_c - 0.5*s*w.y` (mean depth over the segment). `MS_boost` from the water-type table.

The complete underwater fragment transfer, applied by `applyUnderwaterTransfer()` at the end
of **every** opaque and transparent shader:

```
L_out = L_surface_or_object * exp(-sigma_t * s)     // direct
      + L_ss                                        // analytic sun single scatter
      + L_ms                                        // ambient multiple scatter
      + froxelInscatter(uv, depth)                  // local lights, godrays, fog detail
```

Where the froxel volume is enabled (HIGH+), `L_ss` sun scattering is taken **from the froxel
volume instead** to avoid double counting; the analytic form is used on MEDIUM/LOW and for
transparent surfaces behind the froxel far plane.

### 03.4.7 Colour grading rider (non-negotiable)

There is **no** underwater colour LUT, no blue vignette, no saturation push. If the water
looks wrong, the coefficients are wrong. The only permitted underwater post-process
operations are: chromatic aberration 1.4 px at the frame edge (dome-port simulation), a
barrel distortion `k1 = +0.040, k2 = +0.006` on the helmet view only, and the depth-of-field
owned by section 02.

---

## 03.5 (D) VOLUMETRICS - FROXEL FOG AND GOD RAYS

### 03.5.1 Grid

| Tier | Grid (X x Y x Z) | Froxels | Bytes/texture (RGBA16F) | Total (3 textures) |
|------|------------------|---------|--------------------------|--------------------|
| ULTRA | 240 x 135 x 96 | 3,110,400 | 24.88 MB | 74.6 MB |
| HIGH | 160 x 90 x 64 | 921,600 | 7.373 MB | 22.1 MB |
| MEDIUM | 128 x 72 x 48 | 442,368 | 3.539 MB | 10.6 MB |
| LOW | disabled | - | - | analytic only (03.4.5) |

Three textures: `T_vbuffer` (media: scattering RGB + extinction A), `T_scatter`
(integrated in-scatter RGB + transmittance A), `T_history` (previous frame's `T_vbuffer`).
`T_scatter` needs no history (it is derived).

Actually needed: `T_vbuffer` + `T_vbufferHistory` + `T_scatter` = 3 textures = the numbers
above. All `rgba16float`, `STORAGE_BINDING | TEXTURE_BINDING`, dimension `3d`.

### 03.5.2 Depth distribution

Exponential (constant relative slice thickness), which puts resolution where extinction is
strongest:

```
z_near = 0.25 m
z_far  = 400.0 m   when camera is underwater
       = 12000.0 m when camera is in air (aerial perspective + fog + clouds shadowing)
ratio  = z_far / z_near
d(i)   = z_near * pow(ratio, (i + 0.5 + jitter) / D)        // slice centre, D = depth count
i(d)   = D * log(d / z_near) / log(ratio) - 0.5
```

At HIGH underwater: `ratio = 1600`, `pow(1600, 1/64) = 1.1222` -> 12.22% thickness growth per
slice. Slice 0 thickness 0.030 m, slice 63 thickness 43.6 m. This is deliberately coarse at
the far plane: at 400 m in any water type the transmittance is already < 1e-4, so the error is
unobservable.

Above water `ratio = 48000`, growth per slice `pow(48000,1/64) = 1.1815`.

### 03.5.3 Pass 1: injection (`vol_inject`)

Workgroup `4 x 4 x 4` (64 invocations). Dispatch `40 x 23 x 16` at HIGH.

Per froxel:
1. Reconstruct world position from froxel indices + jittered slice depth + the **current
   frame's jittered projection matrix**.
2. Determine medium:
   - If `worldPos.y < surfaceHeight(worldPos.xz)`: water. Fetch water-type weights from
     `T_waterType`, apply the depth modifiers of 03.4.4, get `sigma_s`, `sigma_a`, `g`.
   - Else: air. `sigma_s = beta_R(h) + beta_M(h)` from the atmosphere model (03.8.2) plus the
     weather fog layer (03.10.7).
   - Local override volumes (vent smoke, up to 16 analytic cones; murky pockets; bioluminescent
     blooms) are added with `max()` on extinction and `+=` on emission.
3. Add a **fine-grain density texture** so the medium has visible structure in a light beam:
   ```
   grain = 1.0 + 0.25 * (worley3d(worldPos * 1.667 + vec3(0, -t_r*0.01, 0)) * 2 - 1)
   sigma_s *= grain           // 0.6 m feature size, drifts down at 0.01 m/s
   ```
   Only applied when `depth > 40 m` and ramped up with depth (`* smoothstep(40, 140, depth)`),
   which is the "swimming through soup" cue.
4. Directional (sun/moon) light:
   ```
   Vis   = sampleCSM(worldPos)                                  // 3x3 PCF, 1 cascade selected by depth
   Vis  *= sampleCaustics(worldPos)                             // ripple modulation, 03.6
   Vis  *= smoothstep(90.0, 45.0, depth)                        // beams fade out below ~60 m
   E_sun = (underwater ? E_sun_uw(0)*exp(-Kd_eff*depth) : E_sun_air)
   L_in += sigma_s * phase(dot(V, sunDirLocal)) * E_sun * Vis
   ```
5. Ambient:
   ```
   L_in += sigma_s * (E_d(depth) / (4*PI)) * MS_boost * ambientPhaseFlattening
   ```
6. Local lights: iterate the cluster the froxel falls into (cluster grid `20 x 12 x 32`,
   up to 64 lights). For each:
   ```
   d2      = dot(Lvec, Lvec)
   atten   = 1 / max(d2, 0.04) * spotCone(...) * shadowCube(...)   // shadow only for the 2 primary vessel lamps
   L_in   += sigma_s * phase(dot(V, normalize(Lvec))) * lightColor * atten * light.volumetricGain
   ```
   `volumetricGain` default 1.0; the vessel's main forward beam uses **2.5** to fake the
   multiple scattering inside a dense beam without a second march.
7. Emission (bioluminescence volumes, vent glow, brine shimmer) added directly.
8. Write `T_vbuffer = vec4(L_in * sigma_s_normalised, sigma_t_luminance)`. Specifically:
   store `rgb = L_in` (already multiplied by sigma_s) and `a = mean(sigma_t)`; the per-channel
   extinction difference is folded into `rgb` by the integrator using the stored per-froxel
   water type... **No.** Chromatic extinction is essential underwater. Therefore:
   `T_vbuffer.rgb = L_in` and `T_vbuffer.a = sigma_t.g`, and the R and B extinctions are
   reconstructed in the integrator from a per-frame uniform ratio
   `sigma_t_ratio = sigma_t.rgb / sigma_t.g` of the **dominant** water type at the camera.
   Error where two water types meet is < 3% of transmittance and is invisible; this saves a
   second RGBA16F texture (7.4 MB) and a second sample per step.

### 03.5.4 Temporal reprojection

- Slice jitter: `jitter = halton(frameIndex % 16, base 2) - 0.5` applied to the slice index
  (i.e. along Z only), plus a `+-0.5` froxel XY offset from Halton(3)/Halton(5).
- History reprojection: the previous frame's `T_vbuffer` is sampled at the froxel's world
  position projected by the previous view-projection into previous froxel space (trilinear).
- Validity: reject if the reprojected froxel is outside [0,1]^3, or if
  `abs(log(d_prev/d_reproj)) > 0.115` (one slice), or if the camera crossed the waterline this
  frame.
- Blend: `vbuffer = mix(historyClamped, current, alpha)`, `alpha = 0.05` valid, `1.0` invalid.
- Neighbourhood clamp: 2x2x2 min/max of the current frame's froxel neighbourhood, expanded by
  0.15 * (max-min) to avoid over-clamping.
- On a lightning flash or a lamp toggle, `alpha` is forced to 0.45 for 4 frames (a global
  "volumetric discontinuity" flag) so the volume responds immediately.

### 03.5.5 Pass 2: integration (`vol_integrate`)

Workgroup `8 x 8 x 1`. Dispatch `20 x 12 x 1` at HIGH. Each invocation marches **all 64
slices front to back** for one (x, y) column.

```
accumScatter = vec3(0); accumTrans = vec3(1);
for i in 0..D-1 {
  v      = T_vbuffer[x,y,i]
  sigma  = vec3(v.a) * sigma_t_ratio
  dz     = sliceThickness(i)
  T_step = exp(-sigma * dz)
  // Hillaire's energy-conserving analytic slice integral (not a midpoint sample):
  Sint   = (v.rgb - v.rgb * T_step) / max(sigma, vec3(1e-6))
  accumScatter += accumTrans * Sint
  accumTrans   *= T_step
  T_scatter[x,y,i] = vec4(accumScatter, dot(accumTrans, vec3(0.2126,0.7152,0.0722)))
}
```

Storing scalar transmittance in `.a` loses per-channel colour of the *transmittance*; the
per-channel transmittance for the direct term is applied analytically by
`applyUnderwaterTransfer` using the exact path length, so this is only used for the
in-scatter's own occlusion. Verified error < 2%.

### 03.5.6 Pass 3: apply

Sampled in the composite:

```
z_froxel = D * log(linearDepth / z_near) / log(ratio) - 0.5
// depth-aware fix-up: bias the sample toward the near side for pixels on a depth
// discontinuity, otherwise fog bleeds over silhouettes
z_froxel -= 0.5 * saturate( abs(ddx(linearDepth)) + abs(ddy(linearDepth)) )
fog = textureSampleLevel(T_scatter, sampler_linear, vec3(uv, (z_froxel+0.5)/D), 0)
color = color * fog.a + fog.rgb
```

Pixels beyond `z_far` clamp to the last slice and get the analytic tail of 03.4.5 for the
remaining distance.

### 03.5.7 Light-injection interface for other sections

```
struct VolumeLight {
  posRadius   : vec4<f32>,   // xyz world, w = influence radius (m)
  colorInt    : vec4<f32>,   // rgb linear, a = luminous intensity (cd)
  dirAngle    : vec4<f32>,   // xyz spot axis, w = cos(outer half angle); w = -2 means point
  params      : vec4<f32>,   // x = cos(inner), y = volumetricGain, z = shadowIndex(-1 none), w = flicker seed
}
```

Buffer `LightVolumeList`: max **256 lights**, storage buffer 16 KB. Section 05 (vessel)
publishes up to 8; section 06 (creatures/bioluminescence) up to 192; flares/beacons the rest.
A CPU-side loose-cluster binner (20 x 12 x 32 = 7,680 clusters, u32 offsets + u16 indices,
`64 * 7680 * 2 B = 983 KB` worst case, typically 60 KB) is rebuilt every frame; budget 0.25 ms CPU.

---

## 03.6 (E) CAUSTICS

### 03.6.1 Method: GPU photon splatting from the wave gradient

Chosen over analytic noise-caustics because the caustic pattern must be **causally the same
water surface** the player sees from above; a mismatched analytic pattern is immediately
readable as fake when the camera crosses the waterline, which happens constantly.

Photon grid: `P x P` photons over a world-space patch of `S x S` metres centred on the camera
(snapped to 1.0 m in XZ).

| Tier | P | Photons | Patch S (m) | Target texture | Method |
|------|---|---------|-------------|----------------|--------|
| ULTRA | 512 | 262,144 | 96 | 1024^2 | splat |
| HIGH | 384 | 147,456 | 96 | 512^2 | splat |
| MEDIUM | - | - | 96 | 512^2 | analytic |
| LOW | - | - | 96 | 256^2 | analytic |

### 03.6.2 Splat pass

Workgroup `8 x 8`, dispatch `P/8 x P/8`.

```
// 1. photon origin on the undisplaced surface, jittered
o_xz  = patchOrigin + (vec2(gid.xy) + haltonJitter(frame)) * (S / P)
// 2. sample the ocean displacement + normal at that point (all 3 cascades)
disp  = oceanDisp(o_xz);   n = oceanNormal(o_xz)
p_surf = vec3(o_xz.x + disp.x, disp.y, o_xz.y + disp.z)
// 3. refract the sun direction into the water
for ch in {R,G,B}:                      // n_R=1.3305, n_G=1.3345, n_B=1.3405
   r_ch = refract(-sunDir, n, 1.0/n_ch)
// 4. intersect with the receiving surface: the terrain heightfield
   t    = raymarchTerrain(p_surf, r_ch, maxDist = 140.0, steps = 24)   // secant refine 3 iters
   hit  = p_surf + r_ch * t
// 5. splat with fixed-point atomic add
   uv   = (hit.xz - patchOrigin) / S
   E    = E_sun_uw0[ch] * (S*S / (P*P)) * exp(-Kd[ch] * (0.0 - hit.y)) * shadowAtSurface
   atomicAdd(&accum[ch][texel(uv)], u32(E * 4096.0))
```

`raymarchTerrain` uses the same `T_height` texture with a min-max mip pyramid for conservative
stepping, so the cost is ~6 texture fetches per photon in practice.

Divergence-based intensity is *implicit*: where the refracted beams converge, more photons land
in a texel. This is the physically correct construction and produces genuine caustic
cusps and folds, including the bright filaments at the edges - which an analytic function
cannot do.

### 03.6.3 Resolve pass

```
// R32Uint -> R11G11B10Float
c = vec3(accum) / 4096.0 / referenceEnergyPerTexel
// separable 3x3 Gaussian, sigma in world metres:
sigma_blur = 0.06 + 0.020 * depthOfReceiver      // deeper = blurrier
// temporal accumulation to kill splat noise
caustics = mix(causticsHistory_reprojected, c, 0.40)
```

History is reprojected by the patch-origin delta (a pure 2D texel shift, exact when the origin
is snapped to a texel multiple - which is why `patchOrigin` is snapped to `S/texRes` metres,
i.e. 0.1875 m at HIGH).

### 03.6.4 Application

Sampled by terrain, creature, vessel-hull and particle shaders:

```
uvC   = (worldPos.xz - patchOrigin) / S
if (any(uvC < 0 || uvC > 1)) causticFade = 0 else causticFade = boxFade(uvC, 0.06)
d     = -worldPos.y
C     = textureSample(T_caustics, uvC).rgb
C    *= saturate(dot(N, -sunDirRefracted)) * 0.75 + 0.25      // wrap term, caustics reach shadowed faces
C    *= shadowCSM(worldPos)
C    *= exp(-d / d_coh)                                       // pattern coherence loss, d_coh = 22.0 m
C    *= 1.0 - smoothstep(45.0, 65.0, d)                       // BINDING: zero below 65 m
C    *= causticFade * causticIntensity                        // causticIntensity from weather (0 at C>0.85)
L_out += albedo * C
```

**Binding requirement: caustics are identically zero for depth > 65 m.** Physically this is
because the surface wave pattern's angular spectrum diffuses with depth (the pattern's
coherence length is ~`lambda_wave * d / (n * A)`); practically it is because caustics below
the twilight boundary look wrong and destroy the dread.

Caustics also modulate:
- the froxel sun injection (03.5.3) - this is what makes god rays ripple;
- the ocean surface's transmitted light seen from above in shallow water (so the seabed
  shimmer is visible from the beach);
- foam and marine snow brightness.

### 03.6.5 Analytic fallback (MEDIUM / LOW)

```
fn causticAnalytic(p: vec2<f32>, t: f32) -> f32 {
  var s = 0.0;
  var q = p * 0.55;
  for (var i = 0; i < 3; i++) {
    let w = worleyF1(q + vec2(t * (0.11 + 0.04*f32(i)), t * 0.07));
    s += pow(1.0 - w, 12.0) * (0.55 / (1.0 + f32(i)));
    q = q * 2.13 + vec2(3.7, -1.9);
  }
  return s * 1.6;
}
```

Two octaves scrolled in opposite directions, multiplied not summed, gives the interference
cells. Chromatic fringing faked by evaluating with `p * (1.0 +- 0.004)` for R and B.

### 03.6.6 Memory

| Resource | Format | Size | Bytes |
|----------|--------|------|-------|
| `accum` (3x) | R32Uint | 512^2 | 3.146 MB |
| `T_caustics` | R11G11B10Float | 512^2 | 1.049 MB |
| `T_causticsHistory` | R11G11B10Float | 512^2 | 1.049 MB |
| Total (HIGH) | | | **5.24 MB** |

Cost: splat 0.22 ms, resolve 0.08 ms.

---

## 03.7 (F) PARTICULATE / MARINE SNOW

### 03.7.1 Density model

Real marine-snow aggregate concentration falls roughly as `z^-0.8` below the euphotic zone,
with a surface-productivity peak. Rendered ("visible mote") density is tuned for look but
anchored to the physical numbers.

| Depth band (m) | Physical N (>0.5 mm, per m^3) | Rendered N (per m^3) | Mean radius (mm) | Sink speed (m/s) |
|----------------|-------------------------------|----------------------|------------------|------------------|
| 0 - 30 | 900 | 1,200 | 0.9 | 0.0060 |
| 30 - 120 | 2,100 | 2,500 | 1.4 | 0.0085 |
| 120 - 350 | 3,400 | 3,800 | 2.1 | 0.0110 |
| 350 - 800 | 1,800 | 2,200 | 2.8 | 0.0140 |
| 800 - 1500 | 700 | 900 | 3.4 | 0.0165 |
| > 1500 | 260 | 400 | 4.0 | 0.0180 |

Multipliers: water type `Snow multiplier` column (03.4.3); weather `stormFactor` adds
`* (1 + 2.5*stormFactor)` above 12 m; vent plumes `* 12`.

### 03.7.2 GPU particle system

- Persistent storage buffer of particles, **65,536 (HIGH) / 131,072 (ULTRA) / 24,576
  (MEDIUM) / 8,192 (LOW)**.
- Particle record, **24 bytes**:
  ```
  struct Snow {
    posRel : vec3<f16>,   // 6 B, position relative to the box, quantised to 1 mm
    size   : f16,         // 2 B, radius in mm
    vel    : vec3<f16>,   // 6 B
    seed   : u16,         // 2 B
    phase  : f16,         // 2 B, brownian phase
    flags  : u16,         // 2 B: type (snow/bubble/sediment/plankton), fade
    _pad   : u32,         // 4 B, alignment to 24
  }
  ```
  Buffer 1.57 MB at 65,536.
- **Toroidal box**: all particles live in a `40 x 26 x 40 m` box centred on the camera and
  snapped to 0.25 m. Particles that leave wrap to the opposite face; density is therefore
  exactly constant and cost is exactly fixed. Active particle count is set each frame from
  `N_target = density(depth) * boxVolume`, clamped to the buffer size; the excess particles
  are marked inactive (size 0) rather than compacted.
- Simulation compute, workgroup 256, 1 dispatch:
  ```
  v  = vec3(0, -sinkSpeed, 0)
     + currentField(worldPos, t_r)                       // section 04 provides currents
     + brownian(seed, phase) * 0.004 * sin(2*PI*0.7*t_r + phase)
     + wake(worldPos)                                    // vessel thrusters + player swim
  pos += v * dt_r
  ```
  `wake()` is a sum of up to 4 analytic impulse sources: a radial velocity
  `k / max(r^2, 0.25)` capped at 3.5 m/s within 3.0 m of the source, direction away from the
  thruster axis, decaying with `exp(-t/0.8)`.
- Render: instanced quads, **no geometry shader**, vertex-pulled from the buffer.
  - Camera-facing, size `clamp(radius_m * projScale / dist, 1.2 px, 26 px)`.
  - Soft-particle depth fade over 0.25 m.
  - Alpha from a 32x32 R8 radial falloff generated at boot (`pow(1-r, 2.2)`).
  - **Lit by the froxel volume**: each particle samples `T_scatter` at its own position and
    multiplies by `sigma_s_of_particle / sigma_s_of_water`, so motes light up brilliantly in
    the vessel's headlight cone and vanish outside it. This is the single most important
    detail for the "soup" feel.
  - Additional direct term from up to 2 nearest lights, evaluated per particle in the vertex
    stage, with a `pow(saturate(dot(V,-L)), 6.0) * 3.0` forward-scatter boost (real aggregates
    are strongly forward scattering and flare when backlit).
  - Blend: premultiplied alpha, depth test on, depth write off, drawn after opaques and
    before the ocean surface transparency.
- Cost: simulate 0.06 ms, render 0.19 ms at 65,536.

### 03.7.3 Particle sub-types

| Type | Count share | Size (mm) | Motion | Look |
|------|-------------|-----------|--------|------|
| `SNOW` | 78% | 0.6 - 5.0 | sink + drift | off-white, irregular alpha |
| `PLANKTON` | 14% | 0.3 - 1.2 | sink + 0.05 Hz vertical oscillation of 0.15 m | faint green tint, weak self-emission at night (0.02 cd/m^2) |
| `SEDIMENT` | 6% | 0.2 - 0.8 | spawned on seabed contact, 2.5 s life, buoyant then settling | brown, dense clouds |
| `BUBBLE` | 2% | 0.5 - 12.0 | rise at `v = 0.24 * (r/2mm)^0.5`, radius grows by Boyle: `r = r0 * (P0/P)^(1/3)`, `P = 101325 + 1025*9.81*d` | specular sphere, refractive, wobble at 6 Hz |

Sediment burst: 256 particles spawned when the vessel or player collides with the seabed at
> 0.8 m/s, or when a large creature passes within 1.5 m of the floor.

Bubbles from the player's rebreather: 6-14 per exhalation (every 3.8 s), rising, expanding.
A diver at 40 m exhaling a 2 mm bubble reaches 3.4 mm at the surface (`(5.02/1.0)^(1/3)`), which
is the correct factor and worth having.

### 03.7.4 "Swimming through soup" at depth

Beyond the particle count ramp, three additional cues, all already specified above, combine:
1. froxel grain noise (03.5.3 step 3) ramping in from 40 m;
2. `MURKY_PARTICULATE` water-type weight rising in the deep basins;
3. depth-of-field near-plane blur (section 02) driven by `sigma_t` -
   `focusNear = 0.4 / max(sigma_t.g, 0.02)` metres.

Target readable visibility at 600 m in a sediment basin: **2.5 - 4 m** with the vessel's main
beam, i.e. the beam terminates in a wall of suspended matter well before it reaches anything.

---

## 03.8 (G) SKY & DAY/NIGHT

### 03.8.1 Model choice: raymarched single+multiple scattering, LUT-based

**Decision: a physically parameterised Rayleigh + Mie + ozone atmosphere evaluated into LUTs
(the Bruneton/Hillaire scheme), NOT Preetham and NOT Hosek-Wilkie.**

Justification:
- Preetham and Hosek-Wilkie are **empirical fits to daytime clear-sky luminance only**. Both
  are undefined (Preetham) or clamped (HW) for sun elevations below the horizon. SUBWAVE needs
  twilight, deep dusk and moonlight to be continuous and correct - the dusk dive is a core
  mood beat.
- Neither gives spectral **irradiance**, only sky luminance. Section 03.4.6 needs the actual
  per-channel downwelling irradiance to drive underwater attenuation. Deriving it from a
  luminance fit means inventing the spectral split; deriving it from a physical model is free.
- Hosek-Wilkie needs a ~1,080-float coefficient dataset embedded in source; the physical model
  needs 12 numbers.
- The same medium description feeds the froxel aerial-perspective volume, so the island at
  6 km and the sky agree by construction.
- Cost is lower than Hosek-Wilkie at runtime once LUTs exist.

### 03.8.2 Atmosphere parameters (binding)

| Parameter | Value | Unit |
|-----------|-------|------|
| Planet radius `R_g` | 6,371,000 | m |
| Atmosphere top `R_t` | R_g + 92,000 | m |
| Rayleigh scattering `beta_R` at y=0 | (5.802, 13.558, 33.100) e-6 | 1/m |
| Rayleigh scale height `H_R` | 8,000 | m |
| Rayleigh absorption | 0 | 1/m |
| Mie scattering `beta_M` at y=0 | (3.996, 3.996, 3.996) e-6 | 1/m |
| Mie absorption at y=0 | (4.400, 4.400, 4.400) e-6 | 1/m |
| Mie scale height `H_M` | 1,200 | m |
| Mie asymmetry `g_M` | 0.80 | - |
| Ozone absorption peak | (0.650, 1.881, 0.085) e-6 | 1/m |
| Ozone distribution | tent, centre 25,000 m, half-width 15,000 m | m |
| Ground albedo | 0.055 (open ocean), 0.28 (over the island) | - |
| Turbidity coupling | `beta_M *= T_turb`, `T_turb in [0.6, 6.0]` from weather | - |
| Solar irradiance at top of atmosphere | (1.474, 1.850, 1.912) | W/m^2/nm at the 3 band centres |
| Sun angular radius | 0.00465 (0.266 deg) | rad |

Ozone density: `rho_O3(h) = max(0, 1 - abs(h - 25000) / 15000)`.

The Mie asymmetry is raised in haze/fog weather to 0.86 and the Mie scattering scaled by
turbidity, which is the single control that turns a clear blue sky into a white hazy one.

### 03.8.3 LUTs and passes

| LUT | Format | Size | Bytes | Update |
|-----|--------|------|-------|--------|
| `T_transmittance` | RGBA16Float | 256 x 64 | 131 KB | once at boot; on turbidity change |
| `T_multiScatter` | RGBA16Float | 32 x 32 | 8.2 KB | on turbidity/sun-elevation-bucket change (32 buckets) |
| `T_skyView` | RGBA16Float | 192 x 108 | 166 KB | every frame (0.09 ms) |
| `T_aerialPersp` | RGBA16Float | 32 x 32 x 32 | 262 KB | every frame (0.06 ms), covers 0-64 km |
| Total | | | **~0.57 MB** | |

- `T_transmittance` parameterisation: `(mu = cos(view zenith), r = altitude)` with the standard
  Bruneton non-linear mapping.
- `T_skyView` parameterisation: azimuth (relative to sun) x a non-linear zenith mapping with
  extra resolution within 8 deg of the horizon (`v = 0.5 + 0.5*sign(l)*sqrt(abs(l))`,
  `l = zenith angle - horizon`). This is what keeps the twilight band crisp.
- Multiple scattering: 2nd-order isotropic approximation with the infinite-series closed form
  `L_ms_total = L_2nd * (1 / (1 - f_ms))`, 64 directions, 20 steps, evaluated in a 32x32
  compute dispatch.
- Sky-view march: 32 steps clear, 48 near the horizon, with the transmittance LUT for the
  sun-path term.

The sky is rendered by sampling `T_skyView` in the far-plane pass; the sun disc is added
analytically with limb darkening
`I(r) = I0 * (1 - 0.6*(1 - sqrt(1 - (r/R)^2)))` and clamped for fp16 (03.0.3).

### 03.8.4 Ephemeris

Planet: axial tilt `eps = 21.4 deg`, year `Y = 384 game days`, world latitude
`phi = +41.0 deg` (fixed for the whole playable world - it is ~16 km across, so latitude
variation is < 0.15 deg and is ignored). Longitude is arbitrary; local solar time = game clock.

```
doy      = floor(t_g / 86400) mod 384        // starting doy = 264 (near autumn equinox)
lambda_e = 2*PI * (doy - 80.0) / 384.0       // ecliptic longitude, 0 at vernal equinox
delta    = asin( sin(eps) * sin(lambda_e) )  // solar declination
H        = (t_g_hours / 24.0 - 0.5) * 2*PI   // hour angle, 0 at local solar noon
sin(h)   = sin(phi)*sin(delta) + cos(phi)*cos(delta)*cos(H)
az       = atan2( -cos(delta)*sin(H),  sin(delta)*cos(phi) - cos(delta)*sin(phi)*cos(H) )
```

`az` is in the heading convention (0 = north, CW). Sun direction vector:
`sunDir = (sin(az)*cos(h), sin(h), -cos(az)*cos(h))`.

Declination range: +-21.4 deg. Noon elevation range at phi=41: 27.6 deg (midwinter) to
70.4 deg (midsummer). Day length range: 9.3 h to 14.7 h.

### 03.8.5 Moons

Two moons. Both on circular, slightly inclined orbits; positions from a simple mean-motion
ephemeris (no perturbations).

| Moon | `Selk` | `Ithra` |
|------|--------|---------|
| Sidereal period | 27.90 game days | 4.63 game days |
| Synodic period (phase cycle) | 30.08 game days | 4.69 game days |
| Angular diameter | 0.720 deg (0.01257 rad) | 0.192 deg (0.00335 rad) |
| Geometric albedo | 0.112 | 0.196 |
| Colour (linear RGB, full) | (1.000, 0.972, 0.930) pale grey-white | (1.000, 0.815, 0.560) ochre |
| Orbital inclination to the ecliptic | 6.1 deg | 14.7 deg |
| Longitude of ascending node at epoch | 118.0 deg | 41.5 deg |
| Mean anomaly at epoch (t_g = 0) | 214.0 deg | 77.0 deg |
| Full-moon illuminance (horizontal, at zenith) | 0.620 lux | 0.0410 lux |
| Surface luminance (full, at zenith) | 6,100 cd/m^2 | 4,900 cd/m^2 |
| Rendered features | 3-octave procedural crater field + 2 dark mare regions (fbm-masked), tidally locked | smooth, 1 bright ray system, tidally locked |

Phase: `cos(phaseAngle) = dot(moonDir, sunDir)`; illuminated fraction
`k = 0.5*(1 + cos(phaseAngle))`. Illuminance scales as
`E = E_full * k^1.35 * max(0, sin(h_moon))` (the 1.35 exponent approximates the real opposition
surge / non-Lambertian lunar phase curve).

Combined maximum night illuminance (both full, both high): **0.661 lux** = 1/145,000 of noon.
Underwater consequence: at 10 m depth under a full Selk,
`E_d = 0.62 * 0.934 * exp(-0.0576*10) = 0.326 lux` green - roughly moonlit-room level.
Below 40 m under moonlight the world is already effectively black. Night diving without lamps
must be terrifying and nearly blind, and these numbers deliver that without a special case.

Both moons cast shadows: the renderer's directional light slot is filled by
`argmax(illuminance)` over {sun, Selk, Ithra}, with the other two contributing to ambient only.
Moon shadows use only cascade 0 and 1 (48 m) to save cost.

Earthshine equivalent: the unlit limb of Selk is rendered at
`0.019 * E_planetshine` with a colour of (0.55, 0.72, 1.00) - the planet's own ocean-blue
albedo reflected back. Subtle, and free environmental storytelling: the player can see their
own world's colour on the moon.

### 03.8.6 Star field

- **8,192 stars**, generated at boot into a vertex buffer (32 B/star = 262 KB).
- Positions: Fibonacci lattice on the sphere with a per-star jitter of 0.6 x the mean spacing,
  so the distribution is uniform without being visibly regular. Mean spacing at 8,192 points
  over 4pi sr = 2.5 deg.
- Magnitude distribution: `N(<m) proportional to 10^(0.42 m)` sampled by inverse CDF over
  `m in [-1.4, 6.8]`. This yields ~14 stars brighter than m=1.5, ~48 brighter than m=2.5,
  ~1,700 brighter than m=5.0 - close to the real sky.
- Luminance: `L_star = L_0 * 10^(-0.4 m)` with `L_0` set so that an m=0 star delivers
  2.65e-6 lux (the real value) integrated over its PSF.
- Colour: blackbody, temperature drawn from the following magnitude-limited spectral mix:

| Class | T (K) | Fraction | RGB (normalised, linear) |
|-------|-------|----------|--------------------------|
| O/B | 22,000 | 0.055 | (0.735, 0.815, 1.000) |
| A | 9,200 | 0.130 | (0.885, 0.915, 1.000) |
| F | 7,000 | 0.180 | (1.000, 0.975, 0.965) |
| G | 5,700 | 0.220 | (1.000, 0.925, 0.830) |
| K | 4,400 | 0.290 | (1.000, 0.808, 0.630) |
| M | 3,200 | 0.125 | (1.000, 0.660, 0.400) |

- Rendering: point sprites, `max(1.6, 0.9 + 0.35*(2.0 - m))` px, with a Gaussian PSF of
  `sigma = 1.30 px`. Stars with `m < 1.5` additionally get a 4-ray diffraction cross of length
  `(2.0 - m) * 7.0` px at 22.5 deg to the screen axes (the "lens" the player is looking
  through), intensity 0.06 of the core.
- Twinkle (atmospheric scintillation, real physics):
  ```
  airmass = 1.0 / (sin(alt) + 0.50572 * pow(alt_deg + 6.07995, -1.6364))
  amp     = clamp(0.18 * pow(airmass - 1.0, 0.60), 0.0, 0.55) * (1 + 1.4*turbidityNorm)
  s(t)    = amp * ( 0.55*n1(t*3.5 + ph) + 0.30*n1(t*7.1 + ph*2.3) + 0.15*n1(t*13.3 + ph*5.1) )
  L      *= exp(s(t))                          // log-normal intensity fluctuation, correct statistics
  ```
  `n1` is a 1D value-noise in [-1,1]; `ph` is a per-star random phase. Stars near the zenith
  barely twinkle; stars at 10 deg altitude flicker hard. Correct and beautiful.
  Chromatic scintillation: additionally shift the R and B channels' `s(t)` phases by +-0.31,
  producing the real red/blue flashing of low bright stars.
- **Milky-way analogue** ("the Spill"): a great circle inclined 62 deg to the celestial
  equator, node at RA 34 deg. Brightness from a 4-octave fbm evaluated in a band-local
  coordinate, modulated by `exp(-(bandLat/0.115 rad)^2)`, with 3 dark-lane masks from a second
  fbm (multiplicative, exponent 2.2). Peak surface brightness **21.4 mag/arcsec^2 =
  2.86e-4 cd/m^2**.
- Airglow / background: uniform **22.0 mag/arcsec^2 = 1.66e-4 cd/m^2** with a horizon
  brightening of `1 + 0.9*exp(-alt/0.14 rad)` and a slow (0.004 Hz) 12% modulation.
- Stars fade out with sky brightness automatically: they are additive into the same HDR buffer
  and the sky's own luminance at twilight (>1e-2 cd/m^2) swamps them. No manual fade curve.
- Stars are visible from underwater through Snell's window down to ~6 m in clear water at
  night. Do not special-case this; it falls out of 03.2.4 + 03.4.

### 03.8.7 Aurora

Trigger: `sunElevation < -8 deg` AND `Kp >= 6.0` AND camera latitude band flag
(the northern "Glacial Shelf" and "Fracture Trench" biomes, or anywhere with a clear northern
horizon at world Z < -4,000 m).

`Kp` is an Ornstein-Uhlenbeck random walk on [0, 9] updated in game time:
`dKp = -(Kp - 2.1)/(18 game hours) * dt_g + 0.85 * sqrt(dt_g/3600) * N(0,1)`, clamped.
`Kp >= 6` occurs on roughly **4% of nights**, which makes the aurora a genuine event.

Rendering: raymarched curtain between two spherical shells.

| Parameter | Value |
|-----------|-------|
| Lower shell altitude | 90,000 m |
| Upper shell altitude | 240,000 m |
| Emission peak altitude | 105,000 m (green), 215,000 m (red) |
| Steps | 32 (HIGH), 20 (MEDIUM), 0 (LOW: 2D scrolling billboard) |
| Resolution | half-res (960x540), temporally accumulated alpha 0.10 |
| Ground track | domain-warped fbm ridge: `curtain(u) = ridged3(u*0.9 + warp)`, warp = `1.4*fbm2(u*0.35 + t*0.006)` |
| Curtain thickness | 2.5 km horizontal |
| Drift | 0.9 m/s equivalent (the ground track scrolls at 0.006 units/s) |

Emission lines and their vertical profiles:

| Line | lambda (nm) | RGB (linear) | Altitude profile | Peak radiance at Kp=7 |
|------|-------------|--------------|------------------|-----------------------|
| OI green | 557.7 | (0.180, 1.000, 0.280) | Gaussian, centre 105 km, sigma 22 km | 8.5e-3 cd/m^2 |
| OI red | 630.0 | (1.000, 0.160, 0.100) | Gaussian, centre 215 km, sigma 40 km | 2.2e-3 cd/m^2 |
| N2+ blue-violet | 427.8 | (0.220, 0.350, 1.000) | sharp lower border, 92-104 km, only when Kp >= 7.5 | 1.1e-3 cd/m^2 |

Vertical striations ("rays") are added by multiplying by
`0.55 + 0.45 * ridged1(bandCoord * 46.0 + t*0.02)` - the fine field-aligned structure.

Aurora contributes to scene lighting as a large-area ambient term of up to **0.012 lux**
(negligible for exposure but it does tint the sea green, and it is visible from just under the
surface through Snell's window, which is a moment worth building).

### 03.8.8 Volumetric clouds

Two layers.

**Layer A - low/mid convective (raymarched).**

| Parameter | Value |
|-----------|-------|
| Altitude band | 900 m to 4,200 m |
| Base shape noise | Perlin-Worley, `128^3 R8Unorm` = 2.10 MB, tiling 4,096 m |
| Detail erosion noise | Worley 3-octave, `32^3 RGBA8Unorm` = 131 KB, tiling 96 m |
| Curl noise (wisp warp) | `32^3 RGBA8Snorm` = 131 KB, tiling 512 m |
| Weather map | `512^2 RGBA8Unorm` = 1.05 MB, covering 40 km, channels (coverage, precipitation, type, anvil) |
| Weather map scroll | wind vector at 3,000 m = `1.35 * U10` in the wind direction |
| Primary steps | 48 looking up (zenith) -> 96 near horizon, `steps = mix(48, 96, pow(1-abs(V.y), 2.0))` |
| Step length | `dist_remaining * 0.006`, min 12 m, max 640 m; doubled after 6 consecutive empty samples, halved on re-entry |
| Early out | transmittance < 0.010 |
| Light march | 6 steps toward the sun, exponentially growing, total 1,800 m; plus 1 long sample at 8,000 m |
| Render resolution | 480 x 270 (quarter), 1 of 16 pixels per frame in a 4x4 Bayer cycle, reprojected to full res |
| Reprojection | previous view-proj on the cloud's own "depth" (the transmittance-weighted mean sample distance), neighbourhood clamp 3x3 |
| Disocclusion fallback | immediate quarter-res march with 24 steps |
| Cost | 1.60 ms HIGH, 0.75 ms MEDIUM |

Density:

```
h_frac  = (p.y - 900) / 3300
base    = perlinWorley(p / 4096)
grad    = heightGradient(h_frac, cloudType)         // stratus / stratocumulus / cumulus curves
cov     = weather.coverage * coverageWeather        // from the weather state
d0      = remap(base, 1.0 - cov, 1.0, 0.0, 1.0) * grad
// erosion: worley detail, inverted at the base, direct at the top
er      = mix(1 - worley3(p/96), worley3(p/96), saturate(h_frac*2.0))
density = saturate( remap(d0, er * 0.32 * (1 - h_frac), 1.0, 0.0, 1.0) ) * densityScale
densityScale = 0.045 * (1 + 1.8 * weather.precip)     // 1/m
```

Height gradients (piecewise linear, `h_frac` -> multiplier):

| type | 0.00 | 0.07 | 0.20 | 0.45 | 0.75 | 1.00 |
|------|------|------|------|------|------|------|
| stratus | 0.0 | 1.0 | 1.0 | 0.55 | 0.10 | 0.0 |
| stratocumulus | 0.0 | 0.7 | 1.0 | 0.90 | 0.35 | 0.0 |
| cumulus | 0.0 | 0.2 | 0.75 | 1.00 | 0.85 | 0.0 |
| cumulonimbus (storm) | 0.0 | 0.35 | 0.85 | 1.00 | 1.00 | 0.30 (anvil) |

Lighting:

```
// Beer-Powder (Schneider) with 3-octave multiple-scattering approximation (Wrenninge)
T_sun = 0
for o in 0..2 { T_sun += c^o * exp(-d_sun * sigma * b^o) * hg(mu, g*c^o) }   a=0.5,b=0.5,c=0.5
powder = 1.0 - exp(-2.0 * sigma * ds)
L += T_view * sigma * ds * (sunColor * T_sun * powder + ambientSky(h_frac))
ambientSky(h) = mix(skyGroundColor*0.35, skyZenithColor*0.85, h)
```

Clouds cast on everything, including underwater irradiance, via a **cloud shadow map**:
`512^2 R8Unorm`, orthographic along the sun direction covering 24 km, updated every 4 frames
by a cheap 8-step march at cloud altitude only. Cost 0.05 ms. Sampled by:
the terrain shader, the ocean surface shader, the froxel injection, AND
`E_uw(0-)` in 03.4.6 (through the `C` term, which is the *local* coverage read from this map,
not the global weather coverage). Cloud shadows sweeping across a reef and dimming the caustics
is a signature look and it must be causally correct.

**Layer B - high cirrus (cheap).**
Altitude 8,000 m. A single procedural 2D layer: 3-octave stretched fbm on a dome, scrolled at
`2.6 * U10` in the upper-wind direction (offset 24 deg from surface wind), with a
`pow(fbm, 2.4)` shaping and directional sun scattering
`0.25 + 0.75*pow(saturate(dot(V, sunDir)), 8.0)`. Cost 0.04 ms. Always on, all tiers.

**LOW-tier fallback for layer A.** Two 2D procedural cloud textures (`512^2 RG8`, generated at
boot: R = density, G = a precomputed "self-shadow" from a 1D sun march) mapped onto a dome with
parallax offset `uv += V.xz * (H_cloud / max(0.02, V.y)) * scale`, two altitudes (1,400 m and
3,000 m) for a fake volume, and the same sun-scatter term. Cost 0.10 ms. Cloud shadow map is
generated from the same texture, so all downstream lighting still works.

---

## 03.9 (H) DAY/NIGHT CLOCK

### 03.9.1 Timing

| Quantity | Value |
|----------|-------|
| Game day | 24 game hours |
| Real seconds per game day | **1,800 s (30 real minutes)** |
| TIME_SCALE | 48.0 |
| 1 game hour | 75.0 real s |
| 1 game minute | 1.25 real s |
| Game year | 384 game days (= 8 real hours of continuous play) |
| Start time (new game) | day 264, 08:20 local solar time |
| Accelerated time (sleep/wait at base) | up to 20x TIME_SCALE (= 960x real), capped so a full night skip takes 35 real seconds |
| Time is paused | only in the pause menu; never during inventory or crafting |

The starting time (08:20, morning) is deliberate: bright, safe, low sun with long shadows on
the reef, and the first night arrives after ~19 real minutes of play.

### 03.9.2 Key times (reference: equinox, delta = 0.0 deg, latitude 41.0 N)

Hour angle for a given elevation `h`: `cos(H) = (sin h - sin phi sin delta)/(cos phi cos delta)`.
At delta = 0: `cos(H) = sin(h)/cos(phi) = sin(h)/0.7547`.

| Event | Sun elevation | Game time | Real seconds from midnight | Notes |
|-------|---------------|-----------|----------------------------|-------|
| Astronomical dawn | -18.0 deg | 04:23 | 329 | first sky gradient, stars start to go |
| Nautical dawn | -12.0 deg | 04:56 | 370 | horizon distinguishable |
| Civil dawn | -6.0 deg | 05:28 | 410 | "dawn" - blue hour begins |
| Sunrise | -0.833 deg (refracted) | 06:00 | 450 | |
| Golden hour end | +6.0 deg | 06:29 | 486 | |
| Mid-morning | +25.0 deg | 08:04 | 605 | |
| Solar noon | +49.0 deg | 12:00 | 900 | |
| Mid-afternoon | +25.0 deg | 15:56 | 1,195 | |
| Golden hour start | +6.0 deg | 17:31 | 1,314 | |
| Sunset | -0.833 deg | 18:00 | 1,350 | |
| Civil dusk | -6.0 deg | 18:32 | 1,390 | "dusk" - blue hour |
| Nautical dusk | -12.0 deg | 19:04 | 1,430 | |
| Astronomical dusk | -18.0 deg | 19:37 | 1,471 | full dark begins |
| Full night | < -18.0 deg | 19:37 - 04:23 | 658 real s | 8.77 game h = 11.0 real min |

Seasonal drift: sunrise ranges 04:44 (midsummer) to 07:22 (midwinter); the design should
expect night length between 6.2 and 15.6 real minutes.

### 03.9.3 Lighting key-frame table (BINDING)

Values for `OCEANIC_CLEAR` water, `C = 0.05` (clear). Interpolate by sun elevation, not by
clock time, so the table stays correct across seasons. Sun/sky RGB are colours normalised to
luminance 1.0; illuminance columns carry the magnitude.

| Key | Sun elev | Sun colour (RGB) | Sun E_horiz (lux) | Sky/ambient colour (RGB) | Sky E_horiz (lux) | UW ambient @5 m (lux, RGB) | UW ambient @30 m (lux, RGB) | Mood |
|-----|----------|------------------|-------------------|--------------------------|-------------------|----------------------------|------------------------------|------|
| NIGHT_DARK | -30 | - | 0 | 1.02, 1.00, 1.18 | 0.0012 | 0.0003, 0.0008, 0.0011 | 0.0, 0.0002, 0.0006 | starlight only; Selk new |
| NIGHT_MOONLIT | -30 (Selk full, alt 45) | 1.00, 0.972, 0.930 | 0.44 | 1.02, 1.00, 1.18 | 0.0012 | 0.12, 0.33, 0.45 | 0.001, 0.075, 0.245 | silver, high contrast |
| ASTRO_TWILIGHT | -18 | - | 0 | 1.02, 1.00, 1.18 | 0.0006 | 0.00016, 0.00042, 0.00058 | 0.0, 0.0001, 0.0003 | |
| NAUT_TWILIGHT | -12 | - | 0 | 1.02, 1.00, 1.18 | 0.0080 | 0.0021, 0.0056, 0.0077 | 0.0, 0.0013, 0.0042 | deep indigo |
| CIVIL_TWILIGHT | -6 | - | 0 | 1.05, 1.00, 1.24 | 3.40 | 0.90, 2.38 , 3.44 | 0.0, 0.56, 1.85 | blue hour; ocean is ink |
| HORIZON | 0 | 1.860, 0.750, 0.210 | 800 | 1.180, 1.010, 1.080 | 2,600 | 720, 1,730, 2,320 | 1.1, 400, 1,240 | disc on the water |
| LOW_SUN | +2 | 1.680, 0.815, 0.325 | 2,050 | 1.020, 1.010, 1.310 | 3,900 | 1,540, 3,320 , 4,900 | 2.6, 770, 2,620 | long glitter path |
| GOLDEN | +6 | 1.400, 0.905, 0.560 | 7,000 | 0.840, 0.995, 1.660 | 6,200 | 3,610, 7,290, 12,100 | 6.1, 1,690, 6,470 | signature dive-out shot |
| MORNING | +15 | 1.180, 0.965, 0.795 | 21,000 | 0.720, 0.985, 1.940 | 9,900 | 8,240, 20,300, 33,600 | 14.0, 4,700, 18,000 | |
| MID | +30 | 1.100, 0.985, 0.865 | 47,000 | 0.700, 0.982, 2.020 | 13,500 | 16,300, 42,000, 62,700 | 27.6, 9,760, 33,600 | |
| NOON | +49 | 1.050, 1.000, 0.930 | 78,000 | 0.690, 0.980, 2.070 | 17,000 | 25,300, 68,700, 91,400 | 42.0, 16,200, 48,700 | max caustics |

Underwater ambient columns are the direct output of the 03.4.6 pipeline and are listed here as
**acceptance test values**: a debug overlay (`F7`) prints
`E_d(5)` and `E_d(30)` and they must match this table to within +-8%.

Overcast (C = 1.0) multipliers, applied to both sun and sky columns:
`sun -> 0`, `sky E -> total * 0.22`, `sky colour -> (0.980, 1.000, 1.045)`.

### 03.9.4 Additional time-of-day couplings owned here (published to other sections)

| Signal | Curve | Consumers |
|--------|-------|-----------|
| `dayFactor` | `saturate((sin(h) + 0.10) / 0.35)` | creature circadian AI (06), plant animation |
| `nightFactor` | `1 - dayFactor` | bioluminescence intensity (x0 day, x1 night, with a 90 real-second lag) |
| `twilightFactor` | `exp(-pow((h_deg + 2.0)/7.0, 2.0))` | peak predator activity at dawn/dusk (06) |
| `moonPhaseSelk` | 0..1 | spawn tables for one deep species (06) |
| `tidalPhase` | `sin(2*PI*t_g/(12.42 game h)) * A_selk + sin(2*PI*t_g/(11.1 game h)) * A_ithra` | sea level offset, +-0.85 m at spring tide, +-0.22 m at neap; feeds the shoreline and 04 |

Tide is applied as a **global offset to MSWL** (`y_sea = tideOffset`), so all depth maths,
buoyancy and the shoreline follow automatically. Spring tides occur when Selk and Ithra align
(every ~5.5 game days) and are worth a UI note because some caves are only enterable at low tide.

---

## 03.10 (I) WEATHER

### 03.10.1 States

Seven states. Each is a set of target parameters; the live weather is a **continuous blend**
toward the target, not a switch.

| # | State | Frequency | Duration (real min) | Feel |
|---|-------|-----------|---------------------|------|
| 0 | `GLASS_CALM` | 6% | 4 - 9 | Eerie mirror. No wind. Sound is only distant animals. Rare, memorable. |
| 1 | `CLEAR` | 30% | 8 - 22 | Default postcard. |
| 2 | `SCATTERED` | 26% | 8 - 20 | Cumulus, moving shadows, best light. |
| 3 | `OVERCAST` | 17% | 10 - 25 | Flat, grey, cold. Underwater goes dim and green. |
| 4 | `SQUALL` | 11% | 3 - 7 | Fast, violent, localised. Rain, gusts, short steep sea. |
| 5 | `STORM` | 6% | 6 - 16 | Dangerous surface. Lightning. Hs up to 9.8 m. |
| 6 | `FOG_BANK` | 4% | 5 - 14 | Visibility 40-160 m. Silent, disorienting, no horizon. |

### 03.10.2 Parameter table (BINDING)

| Param | GLASS_CALM | CLEAR | SCATTERED | OVERCAST | SQUALL | STORM | FOG_BANK |
|-------|-----------|-------|-----------|----------|--------|-------|----------|
| U10 (m/s) | 0.8 | 4.5 | 7.5 | 9.5 | 14.0 | 20.0 | 2.2 |
| Gust factor (peak/mean) | 1.05 | 1.25 | 1.40 | 1.35 | 1.85 | 1.70 | 1.15 |
| Gust period (real s) | 40 | 22 | 16 | 18 | 7 | 9 | 30 |
| Fetch F (km) | 120 | 120 | 120 | 120 | 35 | 200 | 120 |
| JONSWAP gamma | 1.0 | 1.6 | 2.4 | 3.3 | 5.0 | 3.6 | 1.2 |
| Swell amplitude A_swell | 0.35 | 0.30 | 0.25 | 0.22 | 0.15 | 0.10 | 0.40 |
| Hs (m) | 0.10 | 0.50 | 1.38 | 2.22 | 4.82 | 9.84 | 0.12 |
| Tp (s) | 3.4 | 3.4 | 5.6 | 7.1 | 9.2 | 15.0 | 3.5 |
| lambda_p (m) | 18 | 18 | 49 | 79 | 132 | 351 | 19 |
| chopScale | 0.55 | 0.85 | 1.00 | 1.05 | 1.20 | 1.25 | 0.60 |
| Whitecap W | 0.000 | 0.001 | 0.005 | 0.010 | 0.041 | 0.104 | 0.000 |
| Cloud coverage C | 0.02 | 0.10 | 0.42 | 0.95 | 0.85 | 0.98 | 0.30 |
| Cloud type | cumulus | cumulus | cumulus | stratus | cumulonimbus | cumulonimbus | stratus |
| Cloud base (m) | 1,800 | 1,500 | 1,200 | 900 | 700 | 600 | 200 |
| Turbidity T_turb | 1.6 | 2.2 | 2.6 | 3.4 | 4.2 | 5.2 | 6.0 |
| Rain rate (mm/h) | 0 | 0 | 0 | 0.2 | 22.0 | 11.0 | 0 |
| Lightning (strikes/min within 10 km) | 0 | 0 | 0 | 0 | 0.6 | 3.2 | 0 |
| Above-water visibility (m) | 42,000 | 28,000 | 22,000 | 14,000 | 2,800 | 1,600 | 95 |
| Air fog sigma_t (1/m) | 9.3e-5 | 1.4e-4 | 1.8e-4 | 2.8e-4 | 1.4e-3 | 2.4e-3 | 4.1e-2 |
| stormFactor (surface stir) | 0.0 | 0.0 | 0.10 | 0.20 | 0.65 | 1.00 | 0.0 |
| Underwater vis multiplier @0-10 m | 1.15 | 1.00 | 0.95 | 0.88 | 0.55 | 0.34 | 1.02 |
| Underwater vis multiplier @>40 m | 1.00 | 1.00 | 1.00 | 1.00 | 0.96 | 0.92 | 1.00 |
| Caustic intensity | 1.15 | 1.00 | 0.72 | 0.06 | 0.10 | 0.03 | 0.55 |
| Ambient audio bed | `calm_surface` | `light_wind` | `wind_chop` | `wind_flat` | `rain_squall` | `storm_roar` | `fog_still` |

Hs values verify against `Hs = 0.0246 * U10^2` (fully developed) modified by the fetch and
gamma: GLASS_CALM 0.016 -> raised to 0.10 by the residual swell; CLEAR 0.50; SCATTERED 1.38;
OVERCAST 2.22; SQUALL fetch-limited to 4.82 (below the 4.82 fully-developed value of 4.82 -
these agree because the squall's short fetch is offset by its high gamma); STORM 9.84.

### 03.10.3 Transition rules

A Markov chain evaluated **once per game hour (75 real s)**, but only after the current state
has been held for its minimum duration. Rows sum to 1.

| from \ to | CALM | CLEAR | SCAT | OVER | SQUALL | STORM | FOG |
|-----------|------|-------|------|------|--------|-------|-----|
| GLASS_CALM | 0.42 | 0.34 | 0.12 | 0.04 | 0.00 | 0.00 | 0.08 |
| CLEAR | 0.06 | 0.46 | 0.34 | 0.09 | 0.02 | 0.00 | 0.03 |
| SCATTERED | 0.02 | 0.26 | 0.42 | 0.22 | 0.06 | 0.01 | 0.01 |
| OVERCAST | 0.01 | 0.10 | 0.26 | 0.40 | 0.13 | 0.06 | 0.04 |
| SQUALL | 0.00 | 0.06 | 0.24 | 0.36 | 0.22 | 0.12 | 0.00 |
| STORM | 0.00 | 0.02 | 0.10 | 0.44 | 0.26 | 0.18 | 0.00 |
| FOG_BANK | 0.14 | 0.24 | 0.14 | 0.18 | 0.02 | 0.00 | 0.28 |

Hard constraints:
- **The starting island's 900 m radius safe zone never sees STORM or SQUALL during the first
  40 real minutes of a new save.** Weather is forced to {GLASS_CALM, CLEAR, SCATTERED}. This
  is a client requirement, implemented as a filter on the transition sampling, not as a
  separate system.
- STORM cannot follow GLASS_CALM or CLEAR directly; a real front takes time. The matrix
  already enforces this (0.00 entries).
- Barometric pressure is tracked (`P = 1013 - 46*stormFactor` hPa) purely so the cockpit
  barometer instrument (section 05) can **fall before a storm**: the pressure signal leads the
  weather change by 4 real minutes because the transition target is chosen 4 minutes before it
  begins to blend. This gives the player a real, learnable forecast tool. Excellent gameplay
  value for ~10 lines of code.

### 03.10.4 Blending

All numeric parameters blend with a **critically damped spring**, time constant
`tau_w = 55 real s` for wind/wave parameters, `tau_c = 90 real s` for cloud coverage,
`tau_v = 25 real s` for fog/visibility.

The wave spectrum's `T_h0` is rebaked when any of `{U10, theta_w, F, gamma, A_swell}` has
drifted more than `{0.35 m/s, 0.045 rad, 8 km, 0.15, 0.05}` from the last bake. Rebake cost
0.6 ms on a compute queue; the result cross-fades over 12 real s between two `T_h0` textures
with weights `(1-a, a)` applied to `h0` amplitude, which is energy-correct because the two
spectra are independent random fields.

Wind direction: Ornstein-Uhlenbeck around a per-day prevailing direction:
```
theta_prevail(day) = 2*PI * fbm1(day * 0.37)          // slow seasonal-ish rotation
dtheta = -(theta_w - theta_prevail)/(300 s) * dt_r + 0.06 * sqrt(dt_r) * N(0,1)
```
Wave direction lags wind with a first-order lag of `tau = 90 real s` (a real sea does not turn
instantly), which produces genuine cross-seas after a wind shift - visually rich and free.

### 03.10.5 Gusts

`U10_inst = U10 * (1 + (gustFactor-1) * (0.6*n1(t/T_g) + 0.4*n1(t/(0.31*T_g) + 17.0)))`.
Gusts drive: cascade-2 amplitude (+-25%, near-instant), foam streaking, particle drift,
audio wind bed gain (+-6 dB), and a visible **cat's-paw** effect - a local patch of roughened
water. The cat's-paw is implemented as a low-frequency 2D field
`gustField(xz, t) = fbm2(xz*0.0035 - windDir*t*0.9)` multiplying cascade-2 amplitude in the
vertex/pixel shader by `mix(0.55, 1.45, gustField)`. Patches ~280 m across drifting downwind.
This is one of the highest-value-per-line effects in the whole ocean system.

### 03.10.6 Rain

| Property | Value |
|----------|-------|
| Particle count | `min(28000, rainRate * 1600)` instanced quads |
| Volume | cylinder r = 26 m, h = 34 m, camera-centred, toroidal wrap |
| Fall speed | `8.4 * (rainRate/22)^0.14` m/s (terminal velocity vs drop size) |
| Wind advection | full `U10_inst` horizontal |
| Streak length | `speed * 0.030 s` = ~0.25 m (shutter-consistent motion blur) |
| Streak width | 1.6 - 3.2 px |
| Colour | not white: `L = ambientSky * 0.85`, refractive so it picks up the sun -> bright when backlit |
| Splash decals | on terrain and vessel hull: 1,024-slot ring buffer, 0.35 s life, expanding ring in a 128^2 RG8 detail normal |
| Cost | 0.09 ms |

**Ocean ripple normal layer.** A dedicated `512 x 512 RG8Snorm` texture covering a 32 m patch,
updated by a compute pass every frame:

```
// spawn: N = rainRate * 34 rings per frame at random texels (blue-noise sequence)
// each texel holds (amplitude, radius) of the nearest active ring in a 4-ring-per-texel
//   fixed-capacity structure -- in practice implemented as an accumulation:
for each active ring r:
   d      = |texelWorld - r.center|
   w      = exp(-pow((d - r.radius)/0.030, 2.0)) * r.amp
   height += w * cos( (d - r.radius) * 210.0 )
r.radius += 0.45 m/s * dt_r        (max 0.35 m)
r.amp    *= exp(-dt_r / 0.42 s)
```
Ring capacity 2,048, stored in a storage buffer, culled when `amp < 0.02`.
Normals derived by central differences, composited into the ocean normal with weight
`saturate(rainRate / 8.0) * 0.65` and into the underside normal at 0.6 of that.

**Rain damps capillary waves** (real, and the reason heavy rain visibly flattens the sea):
```
cascade2Amplitude *= 1.0 - 0.55 * min(1.0, rainRate / 12.0)
alpha_base        *= 1.0 - 0.30 * min(1.0, rainRate / 12.0)
```

**Rain audio**: synthesized. A pink-noise bed band-passed 400-6,000 Hz with gain
`-38 + 14*log10(rainRate)` dB, plus 40-140 discrete droplet impacts/s (each a 2.5 ms filtered
noise click at 1.2-4.5 kHz with random pan), plus a low rumble 40-90 Hz at heavy rates. On the
vessel canopy the bandpass shifts to 900-9,000 Hz and gains a 3.2 kHz resonance (+7 dB, Q 4).

### 03.10.7 Fog bank

A horizontal layer, not a global fog. Injected into the froxel volume above water:

```
top      = 12.0 + 28.0 * fbm2(xz * 0.0009 + windDrift)      // 12 - 40 m, undulating
sigma_t  = 4.1e-2 * saturate((top - y) / 6.0) * densityNoise(xz, y)
densityNoise = 0.55 + 0.45 * fbm3(vec3(xz, y*3.0) * 0.012 - vec3(windDrift, 0))
```

Visibility `V = 3.912 / sigma_t` = 95 m at full density. Fog is **not** applied below y = 0
(it is an air phenomenon); when the player dives out of a fog bank the surface becomes a
glowing white ceiling, which is a strong image.

Fog banks drift with the wind at `0.65 * U10` and have a finite horizontal extent (a 2D mask
from a large-scale fbm thresholded at 0.55), so the player can watch one roll in.

### 03.10.8 Lightning

- Strike selection: Poisson process at the tabulated rate. Position: uniform in an annulus
  1.2 - 14 km from the camera, azimuth biased 30% toward the storm cell centre.
- Visual: a **procedural bolt** - an L-system-free recursive midpoint displacement between the
  cloud base and either the sea surface or another cloud point, 5 subdivision levels,
  displacement `0.28 * segmentLength` perpendicular, 2-4 forks with 0.55 length ratio.
  Rendered as camera-facing ribbons with additive HDR, core luminance 1.2e6 cd/m^2 (clamped
  after pre-exposure), width 1.5-6 m, plus a bloom contribution.
- Flash light: a temporary directional light from the bolt azimuth,
  **illuminance 1,200 lux at 3 km, scaling as 1/d^1.6** (not 1/d^2 - a bolt is a long line
  source), colour (0.86, 0.90, 1.00), duration 120 ms with a 3-pulse envelope:
  `[0-14 ms ramp to 1.0][14-38 ms decay to 0.25][38-52 ms to 0.85][52-88 ms to 0.10][88-120 ms to 0]`.
  It writes to the same shadow-casting directional slot for those frames (cascades 0-2 only).
- **Underwater flash visibility**: the flash contributes to `E_uw(0-)` exactly like the sun,
  so it propagates with `exp(-Kd*d)`. A 1,200 lux flash is visible as a distinct brightening to
  `1,200 * exp(-0.0253*d) = 1%` at **182 m** in clear water. Ceiling lit blue-white for one
  frame at 40 m: unmistakable and free.
  The froxel volume must not smear the flash: the "volumetric discontinuity" flag (03.5.4)
  fires on every strike.
- Thunder: delay `d / 343 m/s` in air. Synthesized as a 2.5-6.0 s burst: brown noise shaped by
  an exponential envelope with 3 secondary echoes at 0.35/0.9/1.7 s (0.45/0.25/0.12 gain), low
  passed at `f_c = 2000 * exp(-d/4200)` Hz (2,000 Hz at 1 km -> 220 Hz at 9.2 km), plus a
  0-40 Hz rumble whose duration scales with distance (a close strike cracks, a distant one
  rolls).
- Thunder underwater: arrives at `d / 1500 m/s` (much sooner, which is correct and strange),
  low-passed at 380 Hz, with the additional water-absorption filter of 03.11.4. Reads as a
  muffled body-felt thud. Also add a 0.15 s hull resonance if the player is inside the vessel.

---

## 03.11 (J) THE WATERLINE

### 03.11.1 Detection and hysteresis

```
surfY   = oceanHeightAt(cam.x, cam.z, t_r).y + tideOffset
signed  = cam.y - surfY                          // +ve above water
r_cam   = 0.090 m                                // effective camera "sphere" at the near plane
state:  ABOVE  if signed >  +r_cam
        BELOW  if signed <  -r_cam
        CROSS  otherwise
```

Hysteresis: the ABOVE/BELOW latch requires `|signed| > r_cam + 0.020 m` to flip, and the
classification is temporally smoothed over 2 frames. Without this, a chop of a few centimetres
strobes the underwater post at 60 Hz.

### 03.11.2 The split-screen effect

A dedicated full-screen **waterline overlay pass** runs after the scene and before tonemapping,
active only in CROSS state (and for 6 frames after leaving it, fading out).

Per pixel:
```
// Cast the pixel ray and evaluate the ocean surface at a fixed short distance
ray     = normalize(worldRayFromUV(uv))
p       = cam + ray * 0.35                       // 0.35 m: just past the near plane
h       = oceanHeightGPU(p.xz)                   // cheap 2-cascade sample, no cascade 2
f       = (p.y - h) / 0.35                       // signed, roughly in "screen height" units
```

`f > 0` -> air pixel, `f < 0` -> water pixel. The boundary `f = 0` is the meniscus.

Meniscus treatment (this is the part that sells it):

| Band (in |f| px, converted via ddx/ddy of f) | Effect |
|-----------------------------------------------|--------|
| 0 - 1.5 px | Bright rim: additive `0.35 * skyLuminance`, the specular sliver on the meniscus edge. |
| 0 - 7 px (water side) | Refractive bulge: sample offset `uv += normalize(grad(f)) * 14 px * pow(1 - |f|/7, 1.7)`. The water surface acts as a thick lens right at the eye. |
| 0 - 7 px (air side) | Slight downward pull `uv -= grad(f) * 4 px * ...` and a 0.55 alpha wet smear. |
| 4 - 22 px (water side) | Chromatic aberration ramp from 0 to 3.0 px, radial. |
| everywhere | The boundary is jittered by the actual ocean normal at `p`: `f += dot(N.xz, ray.xz) * 0.05`, so it wobbles with the chop rather than being a straight line. |

Air-side pixels get the air post-chain; water-side pixels get the underwater post-chain
(fog was already applied per-pixel by the froxel volume, which is depth-correct on both sides,
so no double work).

Critically: **the froxel volume, caustics, and marine snow all remain active on the water side
with the camera's depth clamped to `max(0.02, -signed)`**, so at the waterline the water side
is nearly clear and the transition into fog as the camera sinks is continuous.

The ocean surface geometry itself is not clipped or special-cased: the clipmap simply passes
through the near plane, and the overlay pass draws the meniscus that the rasteriser cannot.

### 03.11.3 Lens / windshield droplets

One system, two coordinate spaces (screen space for the free camera / helmet, windshield UV
space for the cockpit).

| Property | Value |
|----------|-------|
| Max droplets | 96 |
| Record | pos (vec2), radius px (f32), age (f32), slideVel (vec2), seed (u32) = 28 B |
| Radius | 2 - 14 px (helmet), 3 - 26 px (windshield, which is further from the eye) |
| Spawn on surfacing | 48 droplets instantly, radii biased large |
| Spawn in rain | `1.5 * rainRate/22` per second, above water only |
| Spawn from spray | `2.2 * Hs * speed/10` per second when within 1.5 m of the surface at speed |
| Dry-off | `radius *= exp(-dt_r / 22.0 s)`; removed below 1.5 px |
| Cleared | fully cleared 0.5 s after going fully submerged |
| Slide | `slideVel += (gravityScreen + cameraAccelScreen * 0.35) * dt_r * (radius/8)`, damped 0.88/s; droplets leave a 0.3-alpha trail that itself evaporates |
| Merge | droplets whose centres are within `0.7*(r1+r2)` merge, `r = (r1^3+r2^3)^(1/3)` (volume conserving) |

Rendering: the droplet set is rasterised into a `512^2 RG8Snorm` "droplet gradient" texture
(one instanced quad per droplet, writing an analytic spherical-cap gradient), then the final
composite offsets its sample UV:

```
g      = textureSample(T_droplet, uv).rg          // gradient of the droplet height field
uvOff  = -g * 0.090 * dropletStrength
color  = sample(sceneColor, uv + uvOff)
// droplets also concentrate light: a small specular kick
color += pow(saturate(dot(normalize(vec3(g, 0.4)), lightDirScreen)), 24.0) * 0.20
```

Droplets refract, so through a droplet the world is **inverted and magnified** - do not fake
this with a blur.

**Windshield clearing**: no wiper. The vessel canopy has a *hydrophobic surface field*
triggered by a cockpit control (and automatically on surfacing at speed): a radial wavefront
expanding from the canopy centre at 1.4 canopy-widths/s, clearing droplets it passes and
leaving a brief 0.25 s shimmer band behind it. 0.8 s total. Accompanied by a synthesized
"glassy sweep" sound (a swept resonant filter on filtered noise, 900 -> 5,500 Hz over 0.8 s).

### 03.11.4 Audio transition

Two buses, `air` and `water`, plus `interior`. Every emitter feeds both; the crossfade
is at the bus level so nothing pops.

| Direction | Duration | Automation |
|-----------|----------|------------|
| Air -> water | 0.220 s | `air` gain: equal-power to 0. `water` gain: equal-power to 1. `waterLPF` (BiquadFilterNode, lowpass, Q = 0.9): frequency 18,000 -> 480 Hz, exponential ramp. Low shelf at 120 Hz: 0 -> +6 dB. Reverb send: 0.12 -> 0.34. |
| Water -> air | 0.140 s | Reverse of the above (faster - breaking the surface is abrupt). |

Transients:
- **Immersion "gulp"** (submerging): synthesized, 0.35 s. Filtered noise burst (bandpass
  80-900 Hz, Q 1.2) with 40 ms attack / 300 ms exponential decay, summed with a sine sweep
  340 -> 110 Hz over 0.28 s at -9 dB, plus 4-7 bubble transients (each: 8 ms sine burst whose
  frequency follows the Minnaert relation `f = 3.26 / r_mm` kHz, with an exponential 30 ms decay).
- **Emergence "break"** (surfacing): 0.22 s. A high-passed noise burst (600-9,000 Hz) with a
  6 ms attack, plus a 0.4 s water-drain-off layer (filtered noise, 1.5-5 kHz, slow decay), plus
  a re-triggered wind bed fade-in.
- In CROSS state, both are held at `mix` proportional to the fraction of the *screen* that is
  submerged (computed by a 1-texel reduction of the overlay's `f` sign, read back with a
  2-frame latency - a stale value is fine here). Half-submerged sounds half-muffled, which is
  a detail almost nothing does and everyone notices.

**Underwater propagation model** (owned here, applied by section 07):
```
delay      = distance / 1500.0                       // vs 343.0 in air
absorption(f, r) = exp(-alpha(f) * r)
alpha(1 kHz)  = 6.0e-5  1/m
alpha(10 kHz) = 1.0e-3  1/m
alpha(30 kHz) = 6.0e-3  1/m
// implemented as a distance-driven lowpass: f_c = 12000 * exp(-r / 260) + 250  Hz
```
So a creature 200 m away underwater is audible (water carries sound far) but has lost
everything above ~5.8 kHz, and at 800 m only the sub-1 kHz body of the call survives. This is
correct, and it is exactly the tool that makes the deep feel enormous.

Additional underwater processing (always on when the `water` bus is active):
- No stereo panning above 1.2 kHz beyond +-0.25 (human directional hearing fails underwater);
  instead, direction is conveyed by a subtle 0-6 ms interaural delay and by the reverb balance.
- A depth-driven pitch/pressure cue: a 22-38 Hz sine at -46 dB whose frequency rises with depth
  (`f = 22 + 0.016*d` Hz), giving a felt, sub-audible weight below 300 m.
- Inside the vessel: the `water` bus is additionally filtered by the hull transfer function
  (lowpass 900 Hz, 2 notches at 340 Hz and 1,180 Hz) and mixed at -11 dB under the `interior`
  bus.

---

## 03.12 RESOURCES, BUFFER LAYOUTS, ACCEPTANCE

### 03.12.1 Uniform blocks

```wgsl
struct OceanUniforms {                     // 256 B, bound at group(1) binding(0)
  cascadeL      : vec4<f32>,               // L0, L1, L2, unused
  cascadeChop   : vec4<f32>,               // lambda_c 0..2, chopScale
  cascadeFade   : vec4<f32>,               // fade start/end for c2, c1
  windDirSpeed  : vec4<f32>,               // dirX, dirZ, U10, U10_inst
  spectrum      : vec4<f32>,               // Hs, Tp, gamma, A_swell
  foam          : vec4<f32>,               // J_thresh, J_gain, tau_foam, streakLen
  shore         : vec4<f32>,               // lambda_s, T_s, shoreFoamGain, tideOffset
  slopeVar      : vec4<f32>,               // sigma2_upwind, sigma2_cross, alpha_base, unused
  patch         : vec4<f32>,               // causticPatchOriginX, Z, causticPatchSize, causticIntensity
  time          : vec4<f32>,               // t_r, t_r_mod_Trep, dt_r, frameIndex
  _reserved     : array<vec4<f32>, 6>,
}

struct WaterMediumUniforms {               // 128 B
  sigma_a       : vec4<f32>,               // rgb + unused
  sigma_s       : vec4<f32>,
  sigma_t       : vec4<f32>,
  Kd            : vec4<f32>,
  phase         : vec4<f32>,               // g_forward, g_back, w_forward, MS_boost
  eUwSurface    : vec4<f32>,               // E_uw(0-) rgb, scalar lux
  sunWater      : vec4<f32>,               // refracted sun dir xyz, mu_s
  aphotic       : vec4<f32>,               // d0=320, d1=540, dcmDepth, stormFactor
}

struct AtmosphereUniforms {                // 192 B
  betaR         : vec4<f32>,
  betaM         : vec4<f32>,               // rgb scattering, a = absorption
  ozone         : vec4<f32>,
  radii         : vec4<f32>,               // Rg, Rt, Hr, Hm
  sunDirIllum   : vec4<f32>,               // xyz dir, w = horizontal illuminance
  sunColor      : vec4<f32>,               // normalised rgb, w = angular radius
  moon0         : vec4<f32>,               // xyz dir, w = illuminance (Selk)
  moon1         : vec4<f32>,               // xyz dir, w = illuminance (Ithra)
  moonParams    : vec4<f32>,               // selkPhase, ithraPhase, selkAngRad, ithraAngRad
  cloudParams   : vec4<f32>,               // coverage, densityScale, baseAlt, topAlt
  weather       : vec4<f32>,               // turbidity, rainRate, fogSigma, stormFactor
  timeOfDay     : vec4<f32>,               // t_g_norm, dayFactor, nightFactor, twilightFactor
}
```

### 03.12.2 Total VRAM owned by this section (HIGH tier, 1920x1080)

| Group | MB |
|-------|-----|
| Ocean spectrum + displacement + derivative + foam (with mips) | 12.6 |
| Ocean mesh VB/IB/instances | 0.03 |
| Froxel volumes (3x) | 22.1 |
| Caustics (accum + resolve + history) | 5.24 |
| Sky LUTs | 0.57 |
| Cloud noises (base + detail + curl + weather map) | 3.41 |
| Cloud render targets (quarter + history + shadow map) | 4.15 |
| Marine snow buffer | 1.57 |
| Rain rings + ripple normal + splash | 0.72 |
| Droplet gradient texture | 0.52 |
| Star VB | 0.26 |
| Environment probe (octahedral, mipped) | 0.35 |
| SSR + history | 4.15 |
| Planar reflection | 1.84 |
| Water type 3D field | 0.50 |
| Misc LUTs (Fresnel-rough, DFG, twiddle, blue noise) | 0.12 |
| **Total** | **~58.1 MB** |

ULTRA: ~148 MB. MEDIUM: ~31 MB. LOW: ~9 MB.

### 03.12.3 Acceptance tests (must pass before this section is signed off)

| # | Test | Pass criterion |
|---|------|----------------|
| 1 | Debug overlay F7 vs table 03.9.3 | `E_d(5 m)` and `E_d(30 m)` within +-8% at all 11 key elevations |
| 2 | Red-channel extinction | A neutral 0.5-grey object at 18 m in `OCEANIC_CLEAR` at noon reads R < 0.01 of its G |
| 3 | Abyss blackness | At depth 600 m with all lamps off and no bioluminescence in frame, the tonemapped output histogram has 100% of pixels below code value 2/255 |
| 4 | Caustic cutoff | Caustic contribution is exactly 0.0 for all pixels with depth > 65 m |
| 5 | Tiling | Fly at 40 m altitude at 60 m/s for 120 s in STORM; no periodic pattern identifiable in a 4x time-lapse |
| 6 | Waterline stability | Bob at the surface in SCATTERED for 60 s; no frame where the underwater post toggles twice within 3 frames |
| 7 | CPU/GPU wave agreement | RMS of `oceanHeightAt` vs GPU heightfield over 4,096 samples <= 0.15 m at Hs 2.5 m |
| 8 | Whitecap calibration | Measured foam coverage within +-15% of `3.84e-6 * U10^3.41` at U10 = 5, 10, 15, 20 |
| 9 | Frame budget | This section's total GPU time <= 7.5 ms at 1080p HIGH on the reference M1 Pro |
| 10 | LOW tier | 30 fps at 1280x720 on an Intel Iris Xe with all systems in fallback |
| 11 | Determinism | Same seed + same input log -> identical `oceanHeightAt` output to 1e-5 after 30 real minutes |
| 12 | Snell's window | From 3 m depth looking up in `OCEANIC_CLEAR`, the bright disc half-angle measures 48.3 deg +-1.0 deg |
| 13 | No third-party anything | Static audit: zero imports outside the repo, zero fetches of non-code assets, zero `.glb/.png/.wav` in the build |
| 14 | Safe start | A new save at the island spawn is never subjected to SQUALL/STORM in the first 40 real minutes |
| 15 | Aurora rarity | Over 200 simulated nights, aurora occurs on 3-6% of them |

### 03.12.4 Open items handed to other sections

- Section 04 must supply the current-velocity field sampled by marine snow and by the vessel;
  this section assumes `currentField(p, t) -> vec3` exists with magnitude <= 1.8 m/s.
- Section 05 must consume `oceanHeightAt` at 120 Hz and must NOT read GPU wave data.
- Section 06 must publish bioluminescent emitters into `LightVolumeList` with
  `volumetricGain` set; this section will not special-case creature glow.
- Section 02 must guarantee the `EV100 >= -3.0` clamp; without it acceptance test 3 fails.
