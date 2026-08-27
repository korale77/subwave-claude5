# SUBWAVE - DESIGN SECTION 11

# UI, HUD, MENUS, PDA & UX FLOWS

Status: BINDING IMPLEMENTATION SPEC. Version 1.0.
Owner: UI/UX systems. Consumers: renderer (sec 02/03), vessel (sec 04), creatures (sec 05),
survival/crafting (sec 06), world/biomes (sec 07), audio (sec 08), save (sec 10), perf (sec 12).

Conflict resolution rule: for any quantity that is *simulated* (physics, O2 chemistry, creature AI),
the owning section wins and this section only specifies how it is *displayed*. For any quantity that
is *presentational* (position, colour, timing, easing, draw budget), THIS section wins.

---

## 11.0 SCOPE, AXES, UNITS, GLOSSARY

### 11.0.1 What this section covers

1. The rendering technique for every pixel of UI (11.1).
2. The visual language: palette, typography, line weights, grid, motion (11.2).
3. The cockpit windshield HUD (11.3).
4. The free-swim mask HUD (11.4).
5. All full/partial screens: menus, settings, inventory, fabricator, PDA, chart, death, photo (11.5).
6. The bathymetric chart and its exploration-reveal mechanic (11.6).
7. Interaction feedback: outlines, prompts, hold rings, damage, threat, toasts (11.7).
8. Step-by-step UX flows and the tutorialization doctrine (11.8).
9. Performance budgets and the non-stalling Canvas2D upload path (11.9).
10. Input map, rebinding, gamepad, accessibility (11.10, 11.11).
11. Acceptance tests (11.12).

### 11.0.2 UI coordinate space (UIS) - BINDING

The world coordinate system is defined in the shared brief (right-handed, +X east, +Y up, +Z south,
sea level y=0, depth d = -y). UI uses a separate 2D space.

```
UIS: origin at the exact centre of the framebuffer.
     +x to the RIGHT, +y UP.
     y ranges [-1, +1]  (so 1 UIS unit = HALF the framebuffer height)
     x ranges [-A, +A]  where A = aspect = W_px / H_px

Conversions (W_px, H_px = framebuffer size in PHYSICAL device pixels):
     px_per_uis = H_px / 2                    // 540 at 1080p, 720 at 1440p, 1080 at 2160p
     ndc.x  = uis.x / A                       // ndc in [-1,1]
     ndc.y  = uis.y
     px.x   = (uis.x * px_per_uis) + W_px/2
     px.y   = (H_px/2) - (uis.y * px_per_uis)  // note flip: px y is down
```

Rationale for a centre-origin, height-normalised space: instruments that must stay optically
centred (attitude, reticle, velocity vector) are aspect-invariant by construction; edge-anchored
instruments use an anchor + offset and therefore behave correctly from 4:3 to 32:9 without a single
per-aspect special case.

### 11.0.3 Anchors

All UI elements are positioned as `pos = ANCHOR + offset`, offset in UIS.

```
+------------------+------------------+------------------+
| TL (-A, +1)      | TC ( 0, +1)      | TR (+A, +1)      |
+------------------+------------------+------------------+
| ML (-A,  0)      | MC ( 0,  0)      | MR (+A,  0)      |
+------------------+------------------+------------------+
| BL (-A, -1)      | BC ( 0, -1)      | BR (+A, -1)      |
+------------------+------------------+------------------+
```

Additional derived anchors used by the HUD only:

| Anchor | Definition                                   | Purpose                          |
|--------|----------------------------------------------|----------------------------------|
| CL     | (-min(A, 1.60), 0)                           | Left instrument column, ultrawide-clamped |
| CR     | (+min(A, 1.60), 0)                           | Right instrument column          |
| GC     | Collimated HUD centre = MC + boresight offset | Gunsight/velocity-vector origin  |

**Ultrawide clamp (BINDING):** any element anchored to CL/CR/ML/MR/TL/TR/BL/BR clamps its effective
|x| to `min(A, 1.60)`. At 16:9 (A=1.7778) the clamp is inactive at |x|<=1.60 and instruments sit
0.1778 UIS (96 px) inside the edge. At 21:9 (A=2.3333) instruments do NOT migrate to the far edges;
the extra horizontal field is pure world view. At 4:3 (A=1.3333) the clamp is A itself and the safe
area inset (11.0.4) prevents clipping.

### 11.0.4 Safe area

| Region              | Inset from framebuffer edge (UIS) | px @1080p |
|---------------------|-----------------------------------|-----------|
| Title-safe (menus)  | 0.075 vertical, 0.075 horizontal  | 40.5      |
| Action-safe (HUD)   | 0.050 vertical, 0.050 horizontal  | 27        |
| Absolute (toasts)   | 0.030 vertical, 0.030 horizontal  | 16.2      |

Nothing legible may be placed outside action-safe. The bathymetric chart and photo-mode viewport
are exempt (they intentionally bleed).

### 11.0.5 Units and glossary

| Term            | Meaning                                                                    |
|-----------------|----------------------------------------------------------------------------|
| UIS             | UI space unit, = half framebuffer height (11.0.2)                           |
| dpu             | device pixels per UIS unit = H_px/2                                         |
| hu              | "height unit" = 2 UIS = full framebuffer height (used only for text ramps)  |
| Layer W         | WebGPU vector UI renderer (11.1.2)                                          |
| Layer C         | Canvas2D-in-worker page rasteriser, uploaded as texture (11.1.3)            |
| Layer D         | DOM/CSS overlay (11.1.4)                                                    |
| Panel class     | HUD painted on the windshield glass; has parallax                          |
| Collimated class| HUD focused at optical infinity; no parallax                                |
| Prim            | one UI primitive instance, 48 bytes (11.9.3)                               |
| Page            | one Canvas2D-rasterised 256x256 atlas tile                                  |
| EMI             | electromagnetic interference scalar 0..1 supplied by world/creature systems |

Angles: radians internally, degrees in all user-visible text. Headings 0..359 deg, 0 = north (-Z),
increasing clockwise from above. Bearings shown as 3 digits, zero-padded ("007", "182", "359").
Depth shown as a positive number with unit "M". Negative altitude is never shown; below sea level
the altimeter reads ground clearance, not altitude.

---

## 11.1 RENDERING TECHNIQUE - WHICH PIXELS ARE DRAWN HOW

### 11.1.1 The three layers, and the law that assigns elements to them

There are exactly three UI rendering technologies in SUBWAVE. Every UI element belongs to exactly
one. Adding a fourth requires a spec amendment.

**The assignment law (apply in order, first match wins):**

1. If it must exist before a `GPUDevice` exists, or after the device is lost, or needs a native text
   caret / IME / clipboard / OS accessibility tree -> **Layer D (DOM)**.
2. Else if it is a block of prose or a table of static labels that changes less than 1x/second and is
   longer than 40 characters -> **Layer C (Canvas2D page)**, composited by Layer W.
3. Else -> **Layer W (WebGPU vector)**.

Consequence: *no gameplay HUD element is ever DOM.* Every number that moves is a WebGPU-drawn
analytic vector primitive. Every paragraph of PDA prose is a Canvas2D page drawn as a textured quad
by the same WebGPU pass.

### 11.1.2 Layer W - WebGPU analytic vector UI (primary)

* One vertex-buffer-less pipeline. `draw(6, instanceCount)`; the vertex shader expands `vertex_index`
  0..5 into an oriented screen-space bounding quad from a `UIPrim` read out of a storage buffer.
* Fragment shader evaluates a signed distance field per primitive kind and antialiases with
  `alpha = 1 - smoothstep(-aa, aa, d)`, `aa = 0.70 * fwidth(d)`. No MSAA required; the UI pass runs
  on the resolved, non-MSAA target.
* Premultiplied alpha, `src: one, dst: one-minus-src-alpha`. No depth test, no depth write. Sorting
  is by the `layer` field, done CPU-side with a 12-bit radix bucket sort (see 11.9.4).
* **Justification:** analytic SDF vector drawing is resolution independent (critical: the 3D scene may
  render at 0.6x scale while the HUD must stay razor sharp at native), it scales to 4K without atlas
  re-rasterisation, it lets stroke weight/glow be animated per-frame for free (instrument dimming,
  alarm pulses, EMI glitch), and it collapses the entire HUD into 1-2 draw calls. A glyph-atlas
  approach would need per-resolution re-bake and cannot animate stroke weight.

Primitive kinds (`UIPrim.kind` low byte):

| id | kind          | SDF / behaviour                                                        | params used                         |
|----|---------------|------------------------------------------------------------------------|-------------------------------------|
| 0  | CAPSULE       | line segment p0->p1, round caps, half-width param.x                    | x=halfwidth, y=softness             |
| 1  | ARC           | annulus sector, centre p0, radius param.x, halfwidth y, from z to w rad | x=r, y=hw, z=a0, w=a1               |
| 2  | RRECT         | rounded rect centre p0, half-extent p1, corner r param.x, stroke y     | x=corner, y=stroke(0=fill)          |
| 3  | TRI           | triangle p0,p1,(param.xy), filled                                       | xy=p2, z=featherpx                  |
| 4  | QUAD_TEX      | textured quad, atlas rect in param, page id in extra                    | xyzw = u0,v0,u1,v1                  |
| 5  | RING_SWEEP    | progress ring, centre p0, radius x, hw y, sweep 0..1 in z, from -PI/2   | x=r, y=hw, z=t, w=capstyle          |
| 6  | SEG14         | 14-segment starburst digit cell, bitmask in param.x, cell half-ext p1   | x=bits, y=slant, z=stroke           |
| 7  | TAPE          | full procedural ruler (ticks+majors) along p0->p1                       | x=value, y=units/UIS, z=majorEvery, w=tickHalfLen |
| 8  | GRAD          | linear (w=0) or radial (w=1) gradient fill over rect p0..p1             | xy=dir/centre, z=pow, w=mode        |
| 9  | GRID          | procedural grid over rect, spacing param.x, weight y                    | x=spacing, y=weight, z=phase        |
| 10 | DASH_CAPSULE  | as CAPSULE with dash period z, duty w                                   | x=hw, z=period, w=duty              |
| 11 | NEEDLE        | tapered needle from p0, angle param.x, len y, basew z, tipw w           | -                                   |
| 12 | BLIP          | soft radial dot, radius x, core power y                                 | -                                   |
| 13 | CHEVRON       | V mark at p0, angle x, size y, stroke z                                 | -                                   |
| 14 | GLOW_POINT    | additive-only bloom seed, radius x, intensity y (HDR pass only)         | -                                   |
| 15 | HATCH         | slope hachure field over rect, angle x, spacing y (chart only)          | -                                   |

`TAPE` is a deliberate optimisation: one instance renders an entire compass ribbon or depth tape
including all minor ticks and major ticks. Only the numeric labels on the tape cost glyph instances.
A 90-degree compass ribbon costs 1 TAPE + 5 labels (~30 CAPSULEs) instead of ~120 primitives.

### 11.1.3 Layer C - Canvas2D pages rasterised in a worker, uploaded as texture

* An `OffscreenCanvas` (256x256, or 512x256 / 512x512 for wide pages) lives in a dedicated
  `ui-raster` Web Worker. Web Workers and OffscreenCanvas are platform APIs, not third-party
  dependencies, and are therefore permitted under the zero-dependency rule.
* The worker draws text/prose using `fillText` with a **system font stack only** (11.2.4), then calls
  `transferToImageBitmap()` and `postMessage(bitmap, [bitmap])` - a zero-copy transfer.
* Main thread calls `device.queue.copyExternalImageToTexture()` into a sub-rect of the page atlas.
  Never `getImageData`, never `readPixels`, never `drawImage` of the canvas on the main thread.
* Layer W then draws those pages as `QUAD_TEX` primitives, so Canvas2D content **inherits the same
  compositing, glass refraction, bloom and colour grading as the vector UI**. Canvas2D is a text
  rasteriser here, not a compositor.
* **Justification:** implementing Unicode-aware line breaking, kerning, bidi and font fallback in
  WGSL would be thousands of lines and would still be worse than the browser's. PDA prose, specimen
  field notes, settings descriptions and credits are static, so the rasterisation cost is paid once
  and cached. Numbers that change every frame never go through Layer C.

Hard rule: **any string that changes more than once per second MUST be Layer W stroke text.** A page
that would need re-rasterising more than 2x/second is a design bug.

### 11.1.4 Layer D - DOM/CSS overlay (strictly rationed)

DOM is a single `<div id="dom-ui">` positioned over the canvas, `pointer-events: none` by default,
with `pointer-events: auto` only on live inputs. Permitted uses - this list is exhaustive:

| # | Element                              | Why DOM is mandatory                                          |
|---|--------------------------------------|---------------------------------------------------------------|
| 1 | Boot / loading screen (pre-device)   | Runs before `requestAdapter()` resolves; must show WebGPU-unsupported error |
| 2 | Fatal error / device-lost screen     | Must render with no GPU                                       |
| 3 | Text input fields (seed, save name, beacon label, photo caption) | IME, clipboard, autocorrect, native caret, mobile keyboards |
| 4 | Key-rebind capture surface           | Needs real `keydown` with `code`, and must survive pointer-lock changes |
| 5 | Screen-reader mirror (`aria-live`)   | Only the a11y tree reaches assistive tech                     |
| 6 | Pointer-lock / fullscreen consent CTA| Browsers require a real user gesture on a real element        |
| 7 | PNG download anchor (photo mode)     | `<a download>` is the only save path without a server         |

Everything else on Layer D is forbidden. Reason: a DOM overlay forces the browser to promote a
separate compositor layer above the WebGPU canvas; that layer cannot receive glass refraction,
cannot be bloomed, cannot be colour-graded, and betrays the diegetic illusion instantly. It also
costs a full-screen composite blit every frame it is non-empty.

DOM styling uses one inline `<style>` block, CSS custom properties mirroring the palette tokens in
11.2.1, and no external stylesheet. Total DOM CSS budget: 6 KB.

### 11.1.5 Where in the frame each layer is composited

| Pass | Content                                                        | Colour space   | Gets bloom | Gets tonemap | Gets glass FX |
|------|----------------------------------------------------------------|----------------|-----------|--------------|---------------|
| P1   | 3D scene (opaque + transparent + water)                        | HDR linear     | yes       | yes          | -             |
| P2   | Panel-class HUD, drawn as emissive on windshield geometry       | HDR linear     | yes       | yes          | yes (native)  |
| P3   | Collimated-class HUD, fullscreen, no depth                      | HDR linear     | yes       | yes          | no            |
| P4   | World-space diegetic device screens (PDA, fabricator, chart table) | HDR linear  | yes       | yes          | no            |
| P5   | Tonemap + grade + film grain                                    | HDR -> sRGB    | -         | -            | -             |
| P6   | Meta UI: menus, pause, settings, inventory, toasts, prompts      | sRGB, native res| no       | no           | no            |
| P7   | Outline/selection compositing (reads id buffer from P1)          | sRGB           | no        | no           | no            |
| P8   | Accessibility post (daltonise, contrast boost, flash limiter)     | sRGB           | -         | -            | -             |
| P9   | DOM overlay (browser composites)                                 | sRGB           | no        | no           | no            |

P2/P3/P4 are Layer W writing into HDR. P6/P7 are Layer W writing into sRGB. **Layer W is a single
renderer instantiated three times with different targets and different luminance scales.**

Critical: **P6 always renders at native framebuffer resolution even when the 3D render scale is
below 1.0.** On tier LOW with render scale 0.65, the world is upscaled to native and the UI is then
drawn crisp on top. Text is never resampled.

### 11.1.6 HDR luminance scale for diegetic UI

Panel and collimated HUD are physical light sources inside a dark cockpit. Their emissive luminance
auto-adapts so the HUD never blooms out at the surface at noon nor blinds the player at 900 m.

```
// evaluated once per frame on CPU, 1 value pushed to the UI uniform buffer
L_scene = exp2(autoExposureEV)         // scene average luminance estimate, cd/m2, from sec 03
L_target = clamp(0.22 * pow(L_scene, 0.65), 6.0, 240.0)   // cd/m2
L_hud   += (L_target - L_hud) * (1 - exp(-dt / 1.8))       // 1.8 s time constant
L_hud   *= exp2(userHudBrightnessDb / 6.0)                 // user offset, -12..+12 dB, default 0
```

Consequences that are gameplay-visible and intentional:
- At the surface at noon (L_scene ~ 8000 cd/m2), L_hud ~ 240 cd/m2 -> the HUD is a thin bright
  overlay, barely bloomed.
- At 400 m (L_scene ~ 0.02 cd/m2), L_hud clamps at 6 cd/m2 -> **the instruments become the brightest
  thing in the cockpit and cast a faint amber glow on the player's hands and the seat.** This is the
  single strongest mood beat of the deep and is mandatory.
- The cockpit interior receives 1 bounce of HUD light via a 4 Hz-updated SH-L1 probe seeded from the
  HUD's total emitted power (see sec 03). Budget: 1 compute dispatch, 64 threads.

Meta UI (P6) does not adapt; it is authored in sRGB and is always fully legible.

---

## 11.2 (A) THE VISUAL LANGUAGE

### 11.2.1 Palette

Design constraint from the client: restrained, instrument-like. Amber / cyan / white on near-black,
plus a red warning state. SUBWAVE adds exactly one rationed accent (violet) for xenobiological
anomalies, capped at 2% of lit UI pixels; it exists so that "this organism is not like the others"
can be said without words. No green anywhere in the UI - green is reserved entirely for
bioluminescent flora/fauna in the world, so that green light always means *life*, never *interface*.

All values are sRGB. Linear values are given for the four hero colours; for the rest, apply
`lin = c <= 0.04045 ? c/12.92 : pow((c+0.055)/1.055, 2.4)` per channel.

**Neutrals (backgrounds and structure)**

| Token           | Hex     | RGB8          | Use                                                    | Max coverage |
|-----------------|---------|---------------|--------------------------------------------------------|--------------|
| `bg.void`       | #04070A | 4, 7, 10      | Menu backdrop, letterbox, death screen                 | 100%         |
| `bg.panel`      | #0A1116 | 10, 17, 22    | Panel fill, PDA page background, inventory slot bed    | 60%          |
| `bg.raise`      | #101B22 | 16, 27, 34    | Raised/selected panel, hovered slot                    | 20%          |
| `bg.sunken`     | #020406 | 2, 4, 6       | Inset wells, tape backgrounds, chart water fill        | 30%          |
| `line.hair`     | #1B2C35 | 27, 44, 53    | Hairline dividers, inactive grid                       | 8%           |
| `line.rule`     | #2E4A56 | 46, 74, 86    | Active dividers, panel borders                         | 6%           |

**Amber - PRIMARY DATA. The colour of "this is a measurement".**

| Token         | Hex     | RGB8        | Linear (approx)          | Use                                        |
|---------------|---------|-------------|--------------------------|--------------------------------------------|
| `amber.core`  | #FFB03A | 255,176,58  | 1.000, 0.434, 0.0423     | Primary numerics, needles, active labels   |
| `amber.mid`   | #C97F1E | 201,127,30  | 0.5647, 0.2051, 0.0125   | Secondary numerics, tick majors            |
| `amber.dim`   | #6B4413 | 107,68,19   | 0.1413, 0.0578, 0.0056   | Inactive/greyed instrument, tape minors    |
| `amber.ghost` | #2A1B08 | 42,27,8     | 0.0223, 0.0103, 0.0022   | Unlit segments of 14-seg displays          |

**Cyan - STATE AND SYSTEMS. The colour of "this is nominal / this is a system".**

| Token        | Hex     | RGB8        | Linear (approx)          | Use                                        |
|--------------|---------|-------------|--------------------------|--------------------------------------------|
| `cyan.core`  | #6FE9F5 | 111,233,245 | 0.1808, 0.8148, 0.9130   | O2, power, nominal bars, selection focus   |
| `cyan.mid`   | #2FA6B6 | 47,166,182  | 0.0284, 0.3813, 0.4620   | Bar troughs, chart contour index lines     |
| `cyan.dim`   | #145C68 | 20,92,104   | 0.0057, 0.1022, 0.1329   | Chart minor contours, disabled cyan        |
| `cyan.ghost` | #06181C | 6,24,28     | 0.0018, 0.0089, 0.0116   | Empty bar track                            |

**White - STRUCTURE AND TEXT.**

| Token         | Hex     | RGB8        | Linear (approx)          | Use                                        |
|---------------|---------|-------------|--------------------------|--------------------------------------------|
| `white.core`  | #F2FAFC | 242,250,252 | 0.8882, 0.9559, 0.9733   | Headings, hero prose, crosshair             |
| `white.mid`   | #A9C2C9 | 169,194,201 | 0.3813, 0.5271, 0.5711   | Body prose, list items                      |
| `white.dim`   | #5C7079 | 92,112,121  | 0.1022, 0.1559, 0.1845   | Captions, units suffix, hint text            |

**Red - WARNING. Rationed hard.**

| Token       | Hex     | RGB8        | Linear (approx)          | Use                                          | Max coverage |
|-------------|---------|-------------|--------------------------|----------------------------------------------|--------------|
| `red.core`  | #FF3B2F | 255,59,47   | 1.000, 0.0438, 0.0284    | CRITICAL state, master warning lamp, breach  | 4%           |
| `red.mid`   | #C42418 | 196,36,24   | 0.5271, 0.0185, 0.0091   | WARNING state fill                            | 6%           |
| `red.dim`   | #5E120C | 94,18,12    | 0.1069, 0.0056, 0.0033   | Danger zone on gauges (always-present marks)  | 8%           |

**Violet - ANOMALY (rationed to 2%).**

| Token          | Hex     | RGB8        | Use                                                        |
|----------------|---------|-------------|-------------------------------------------------------------|
| `violet.core`  | #B98CFF | 185,140,255 | Unidentified specimen, anomalous scan, unknown ore signature |
| `violet.dim`   | #3A2A5E | 58,42,94    | Anomaly panel border                                         |

**Semantic aliases (use these in code, never raw tokens, so retheming is one file):**

| Semantic          | Token         | Semantic         | Token        |
|-------------------|---------------|------------------|--------------|
| `ui.primary`      | `amber.core`  | `ui.nominal`     | `cyan.core`  |
| `ui.secondary`    | `amber.mid`   | `ui.caution`     | `amber.core` |
| `ui.text`         | `white.mid`   | `ui.warning`     | `red.mid`    |
| `ui.textStrong`   | `white.core`  | `ui.critical`    | `red.core`   |
| `ui.textWeak`     | `white.dim`   | `ui.anomaly`     | `violet.core`|
| `ui.focus`        | `cyan.core`   | `ui.disabled`    | `amber.dim`  |

**Escalation ramp (used identically by O2, hull, power, pressure, temp):**

| State     | Colour        | Stroke mult | Blink                      | Audio (sec 08 ref) |
|-----------|---------------|-------------|----------------------------|--------------------|
| NOMINAL   | `cyan.core`   | 1.00        | none                       | -                  |
| ADVISORY  | `amber.mid`   | 1.00        | none                       | single soft tick   |
| CAUTION   | `amber.core`  | 1.15        | none, but +12% glow        | slow triad, 0.5 Hz |
| WARNING   | `red.mid`     | 1.30        | 1.20 Hz, duty 0.60         | triple tone, 1 Hz  |
| CRITICAL  | `red.core`    | 1.50        | 2.40 Hz, duty 0.50         | continuous, 2 Hz   |

Blink is a raised-cosine, never a hard square, to satisfy the photosensitivity limiter (11.11.6):
`k = 0.5 - 0.5*cos(2*PI*clamp(frac(t*f)/duty,0,1))`, applied to alpha between 0.35 and 1.0. Alpha
never reaches 0, so an instrument never appears to vanish - a blinking instrument that disappears
reads as a *failed* instrument, which is a different state.

### 11.2.2 Line weights and the AA rule

Weights are specified in device pixels at 1080p and scale with `H_px/1080`.

| Name      | px @1080p | UIS half-width (@1080p) | Use                                          |
|-----------|-----------|--------------------------|----------------------------------------------|
| `hair`    | 1.0       | 0.000926                 | Grids, minor ticks, chart minor contours     |
| `thin`    | 1.5       | 0.001389                 | Panel borders, tape minors, prose rules      |
| `regular` | 2.0       | 0.001852                 | Default instrument stroke, glyph stroke      |
| `medium`  | 2.5       | 0.002315                 | Hold rings, selected borders, index contours |
| `bold`    | 3.0       | 0.002778                 | Hero numerics, needles, warning frames       |
| `heavy`   | 5.0       | 0.004630                 | Master caution frame, breach indicator       |

Scaling: `px = base_px * (H_px/1080) * uiScale`, where `uiScale` is the accessibility scalar
0.80..1.60 (default 1.00). After scaling, **stroke width is clamped to >= 1.15 device px** so that
no line can thin below the AA floor and shimmer. Below 1.15 px the SDF renderer instead reduces
alpha proportionally (`alpha *= w/1.15`), which is the correct perceptual behaviour and produces
stable, non-crawling hairlines under camera motion.

Antialiasing: analytic, `aa = 0.70 * fwidth(d)`. Never MSAA. Never a blur. Never a texture.

### 11.2.3 The grid

Base grid unit `g = 8 device px at 1080p = 0.0148148 UIS`.

* All meta-UI (P6) layout positions, sizes, paddings and gaps are integer multiples of `g`.
* HUD instrument positions are NOT grid-snapped (they are optical, driven by the windshield surface),
  but their internal sub-layout is.
* Standard spacing scale: `g`, `2g` (16 px), `3g` (24), `4g` (32), `6g` (48), `8g` (64), `12g` (96),
  `16g` (128). Nothing between.
* Panel corner radius: `1g` for small chips, `1.5g` for cards, `0g` for instruments (instruments are
  hard-cornered; software is rounded - this is the fastest way to tell diegetic from meta at a glance).
* Column system for meta screens: 12 columns across the title-safe width, gutter `3g`. At A=1.7778
  the title-safe width is 2*(1.7778-0.075) = 3.4056 UIS = 1839 px; each column is 133 px, gutter 24.

### 11.2.4 Typography

**No external font files. Two typographic systems.**

**(a) `SUBWAVE-INSTRUMENT` - procedural stroke (centreline) font. Layer W. All HUD, all numerics,
all buttons, all labels under 40 chars.**

The font is defined as centreline geometry, not outlines. Each glyph is a list of segments in a
normalised em box; each segment is drawn as a `CAPSULE` (straight) or `ARC` (curved) primitive at
runtime. Stroke weight is therefore a *runtime parameter*, which is what lets the whole HUD thicken
under alarm, thin under low power, and glitch under EMI without any re-rasterisation.

```js
// Data format (a single .js module, ~14 KB source, no build step)
// Crockford-style compactness: one flat Float32Array + one index table.
//
// GLYPH_INDEX : Uint16Array(96*3)   // per codepoint 0x20..0x7F: [segOffset, segCount, advance_x1000]
// SEG         : Float32Array        // groups of 5 floats: [x0, y0, x1, y1, bulge]
//
// bulge = tan(theta/4) of the circular arc from (x0,y0) to (x1,y1); bulge == 0 => straight line.
// (DXF bulge convention. Positive = counter-clockwise.)
// Coordinates are in em units with origin at the baseline-left of the glyph cell.
```

| Metric              | Value (em) | @ cap height 24 px |
|---------------------|-----------|---------------------|
| Em box              | 1.000     | 33.3 px             |
| Cap height          | 0.720     | 24.0 px             |
| x-height            | 0.520     | 17.3 px             |
| Ascender            | 0.760     | 25.3 px             |
| Descender           | -0.200    | -6.7 px             |
| Advance (monospace) | 0.560     | 18.7 px             |
| Default stroke      | 0.062     | 2.07 px             |
| Stroke range        | 0.045 .. 0.095 | 1.5 .. 3.2 px  |
| Slant (oblique var) | 8.0 deg   | -                   |
| Tracking (default)  | 0.030 em  | 1.0 px              |

Glyph coverage: ASCII 0x20-0x7E (95 glyphs) plus 9 instrument symbols mapped into 0x80-0x88:
degree, arrow-up, arrow-down, arrow-left, arrow-right, delta, plus-minus, ohm-like "pressure" mark,
and a lozenge used as the anomaly mark. Total 104 glyphs.

Segment budget: 104 glyphs, mean 6.4 segments/glyph = 666 segments = 3330 floats = 13.3 KB binary,
authored as a JS array literal (~34 KB source, minifies to nothing since there is no build step;
served gzipped by the static host).

Monospace is mandatory for all numeric readouts (digits must not shift horizontally as they change -
a proportional digit set makes a depth readout visibly "jitter", which reads as instability). Prose
in the instrument font uses the same monospace advance; this is correct, because prose in the
instrument font only ever appears as short instrument labels.

**Rendering:** each visible character emits `segCount` instances. Cost table:

| String                | Chars | Instances | Notes                         |
|-----------------------|-------|-----------|-------------------------------|
| "0123456789" digits   | 10    | 51        | mean 5.1 seg/digit            |
| "DEPTH"               | 5     | 27        |                               |
| Full cockpit HUD text | ~210  | ~1340     | labels + tape numbers + units |

**Fast path for hero numerics:** the four largest numeric readouts (depth, O2 seconds, speed, power)
use `SEG14` primitives instead of stroke glyphs: one instance per digit cell, 14-segment starburst,
lit segments given as a bitmask. A 4-digit depth readout is 4 instances instead of ~21. It also
looks unmistakably like an instrument. Digit-to-bitmask is a 16-entry lookup table.

```
SEG14 layout (bit index):        Segment on/off bitmask examples
   --0--                          '0' = 0b00000000111111 | diagonals off  = 0x003F
  |\ | /|                         '1' = 0x0006
  7 8 9 10                        '8' = 0x007F
  |  \|/ |                        '-' = 0x0040 (bits 6+13 = the two centre bars)
   -6- -13-
  |  /|\ |
  5 12 11 4     (bit 6 = centre-left bar, bit 13 = centre-right bar)
  | / | \|
   --3--
```

**(b) System-font prose - Layer C. PDA field notes, databank entries, settings descriptions,
credits, long tooltips.**

```css
--font-data:  ui-monospace, "SF Mono", Menlo, "Cascadia Mono", "DejaVu Sans Mono", Consolas, monospace;
--font-prose: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
```

| Role              | Stack        | Size @1080p | Line height | Colour        | Tracking |
|-------------------|--------------|-------------|-------------|---------------|----------|
| PDA entry title   | `--font-data`| 22 px       | 30 px       | `white.core`  | 0.06 em  |
| PDA body prose    | `--font-prose`| 17 px      | 26 px       | `white.mid`   | 0.005 em |
| PDA field note    | `--font-prose` italic | 16 px | 25 px  | `white.dim`   | 0.01 em  |
| Data table cell   | `--font-data`| 15 px       | 22 px       | `amber.mid`   | 0.02 em  |
| Settings desc     | `--font-prose`| 14 px      | 21 px       | `white.dim`   | 0        |
| Credits           | `--font-prose`| 16 px      | 28 px       | `white.mid`   | 0        |

Canvas2D text is rendered with `textRendering: "geometricPrecision"` unavailable-tolerant fallback,
`imageSmoothingEnabled=false` on upload, and is always rasterised at the *device* pixel size for the
current resolution and `uiScale`; changing resolution or uiScale invalidates the whole page atlas
(re-rasterisation of all live pages is budgeted at 90 ms, hidden behind a 200 ms crossfade).

**Minimum legible size (BINDING):** stroke-font cap height must be >= 14 device px and Canvas2D text
>= 13 device px after all scaling. Any element that would fall below drops to an LOD form (a solid
bar, a dot, or nothing) rather than rendering illegible mush. This matters at 720p on a low tier.

### 11.2.5 Motion: durations and easing

All UI motion is driven by **unscaled real time**, unaffected by pause, time dilation or the
death slowdown, with `dt` clamped to 33.3 ms so a hitch cannot teleport an animation.

**Named easing curves:**

| Name             | Definition                                        | Feel                    |
|------------------|---------------------------------------------------|-------------------------|
| `ease.linear`    | t                                                 | Tapes, ribbons, timers  |
| `ease.snap`      | cubicBezier(0.20, 0.00, 0.00, 1.00)               | Appear, focus move      |
| `ease.settle`    | cubicBezier(0.16, 1.00, 0.30, 1.00)               | Panel open, card land   |
| `ease.exit`      | cubicBezier(0.40, 0.00, 1.00, 1.00)               | Dismiss, close          |
| `ease.inOut`     | cubicBezier(0.45, 0.00, 0.55, 1.00)               | Crossfades              |
| `ease.overshoot` | cubicBezier(0.34, 1.56, 0.64, 1.00)               | Craft-complete pop ONLY |
| `ease.mech`      | 1 - pow(1-t, 3) with a 1-frame hold at t=0        | Mechanical switches     |

Bezier evaluation: precomputed 33-entry LUT per curve with linear interpolation; error < 0.4%.
No Newton iteration at runtime.

**Duration table (BINDING):**

| Event                                   | Duration | Easing          | Notes                                 |
|-----------------------------------------|----------|-----------------|---------------------------------------|
| Hover on                                | 80 ms    | `ease.snap`     |                                       |
| Hover off                               | 140 ms   | `ease.exit`     | Slower out = less flicker on the move |
| Press down                              | 40 ms    | `ease.linear`   |                                       |
| Press release                           | 120 ms   | `ease.settle`   |                                       |
| Focus ring move (gamepad/keys)          | 130 ms   | `ease.snap`     | Ring travels, does not teleport       |
| Panel / card open                       | 220 ms   | `ease.settle`   | Scale 0.96->1.0, alpha 0->1           |
| Panel / card close                      | 160 ms   | `ease.exit`     |                                       |
| Screen crossfade (menu <-> menu)        | 180 ms   | `ease.inOut`    |                                       |
| Screen enter from gameplay (pause)      | 220 ms   | `ease.settle`   | Plus DOF ramp, see 11.5.6             |
| Toast in                                | 200 ms   | `ease.settle`   | Slide 0.03 UIS + fade                 |
| Toast hold                              | 4200 ms  | -               |                                       |
| Toast out                               | 320 ms   | `ease.exit`     |                                       |
| Interaction prompt fade in              | 120 ms   | `ease.snap`     |                                       |
| Interaction prompt fade out             | 90 ms    | `ease.exit`     |                                       |
| Hold-to-interact ring                   | per action| `ease.linear`  | Linear is mandatory: it is a contract |
| Hold ring unwind on release             | 3.0x speed| `ease.linear`  |                                       |
| HUD cold-boot sequence                  | 1400 ms  | staged          | See 11.3.9                            |
| HUD shutdown                            | 520 ms   | `ease.exit`     |                                       |
| Alarm blink (WARNING)                   | 833 ms   | raised cosine   | 1.20 Hz                               |
| Alarm blink (CRITICAL)                  | 417 ms   | raised cosine   | 2.40 Hz                               |
| PDA raise / lower (world-space anim)    | 380 / 300 ms | `ease.settle`/`ease.exit` |                        |
| Inventory open / close                  | 200 / 150 ms | `ease.settle`/`ease.exit` |                        |
| Craft complete pop                      | 260 ms   | `ease.overshoot`| The ONLY overshoot in the game        |
| Scan progress ring                      | per scan | `ease.linear`   |                                       |
| Chart pan inertia                       | 420 ms   | exp decay tau=0.14 s |                                  |
| Chart zoom step                         | 160 ms   | `ease.settle`   | Zoom is geometric, factor 1.35        |
| Death fade to black                     | 2600 ms  | `ease.inOut`    | Audio LPF sweeps in parallel          |
| Death screen text reveal                | 900 ms   | `ease.snap`     | Starts at t=2600 ms                   |
| Damage glass-crack appear               | 90 ms    | `ease.snap`     |                                       |
| Threat darkening ramp in / out          | 600 / 1400 ms | `ease.inOut` | See 11.7.5                           |
| Photo-mode shutter                      | 110 ms   | `ease.exit`     |                                       |

**Motion-reduction override:** when `a11y.reduceMotion` is on, every duration above is multiplied by
0.45 and every translation/scale animation becomes a pure crossfade. The hold-to-interact ring, the
alarm blinks and the scan ring are exempt (they carry information).

### 11.2.6 Damped-instrument motion (the spring)

Needles, tapes and bars never jump. They use an implicit (unconditionally stable) damped spring so
that a frame hitch cannot make an instrument explode.

```js
// Implicit damped spring. Stable for any h. zeta=1 => critically damped (no overshoot).
// x: displayed value, v: velocity, target: simulated value, w: natural freq (rad/s), z: damping ratio
function springStep(s, target, w, z, h) {
  const f    = 1.0 + 2.0 * h * z * w;
  const oo   = w * w;
  const hoo  = h * oo;
  const hhoo = h * hoo;
  const det  = f + hhoo;
  const detX = f * s.x + h * s.v + hhoo * target;
  const detV = s.v + hoo * (target - s.x);
  s.x = detX / det;
  s.v = detV / det;
}
// 1% settling time for zeta=1:  t99 = 6.64 / w
```

**Angular wrap rule:** compass/heading springs operate on the *shortest angular difference*:
`target = x + wrapPi(targetRaw - x)`. Without this a pass through 359->000 spins the ribbon
the long way. This is a mandatory unit test.

**Asymmetric springs:** hull integrity, O2 and power use a *fast-down, slow-up* pair
(`w_down` when target < x, `w_up` when target > x). Damage must read instantly; recovery must read
as recovery, not as a glitch.

### 11.2.7 The diegetic doctrine

**Rule: if the player character could plausibly be looking at a real object, it is a real object.**

Every UI element is classified. This table is BINDING; adding an element requires classifying it.

| Class          | Definition                                  | Exists in fiction | In 3D space | Examples                                            |
|----------------|---------------------------------------------|-------------------|-------------|-----------------------------------------------------|
| DIEGETIC       | A real object the character sees             | yes               | yes         | Cockpit HUD on glass, PDA, chart table, fabricator screen, mask HUD, beacon light, ore vein glow |
| SPATIAL        | Not in fiction, but drawn in world space     | no                | yes         | Interaction outline, world-anchored prompt, hold ring on an object |
| META           | Overlays the screen, not in fiction          | no                | no          | Toasts, damage vignette, threat darkening, subtitles |
| NON-DIEGETIC   | Frankly a menu                               | no                | no          | Main menu, settings, pause, death screen, photo mode |

**Quotas (BINDING):** during normal gameplay with no menu open, at least **85% of lit UI pixels must
be DIEGETIC**, and META must never exceed 8%. This is measurable: the UI renderer tags every prim
with its class and a debug pass sums coverage. It is a shipping gate (11.12).

**Forbidden outright**, because they destroy the fiction of being alone on an alien planet:
- Any floating radar/minimap in the corner.
- Any quest marker, objective list, or "go here" arrow.
- Any XP bar, level-up, achievement popup or score.
- Any tutorial modal that stops the world.
- Any damage-direction arc around a crosshair.
- Any voice-over, radio chatter, mission control, or second human perspective in any string.
- Any glyph or text in the world that implies a prior human civilisation.

**Permitted non-diegetic exceptions, and their justification:**
- Menus/settings/pause: unavoidable, and honestly presented as software.
- Subtitles/captions: accessibility, mandatory, never optional to *support*.
- Damage vignette and threat darkening: physiological, not informational - they represent the
  character's perception, not a UI.
- Toasts: capped, 3 max, 0.036 UIS tall, no icons except a single category glyph, and they never
  carry information the player cannot also get diegetically.

**Voice of all UI text (BINDING):** terse, observational, first-person-past for logs, imperative for
prompts, unit-suffixed for data. No brand, no fiction of a manufacturer with a personality, no
humour, no exclamation marks, no second-person scolding. The PDA is the player's own device and
therefore has no personality of its own: it *records*, it does not *speak*. There is no AI companion.

Good: `DESCENT PAST 300 M. HULL STRESS 41 %. LIGHT: NONE.`
Bad: `Careful! You're getting deep. Better watch that hull!`

---
