# SUBWAVE - DESIGN SECTION 12

# Controls, Input Mapping & Camera Feel

**Status:** BINDING SPEC. Implementers must match every number in this document.
**Owner section:** 12. **Depends on:** 04 (Vessel Physics), 05 (Player Physics/Swim), 09 (HUD/Windshield), 14 (Audio), 16 (Persistence).
**Coordinate system:** right-handed, +X east, +Y up, +Z south, metres, sea level y=0, depth d = -y.
**Heading:** h = 0 rad is north (-Z), increasing clockwise viewed from above; east = pi/2 rad (90 deg).

---

## 12.0 Conventions used in this document

### 12.0.1 Angular conventions (binding for all input code)

World forward vector from heading `h` and pitch `p`:

```js
// h: heading, radians, 0 = north(-Z), +ve clockwise from above
// p: pitch,   radians, +ve = looking UP
const fwd = [ Math.sin(h) * Math.cos(p),
              Math.sin(p),
             -Math.cos(h) * Math.cos(p) ];
```

A yaw rotation of `+h` (clockwise from above) equals a rotation of `-h` about the +Y axis in
right-handed quaternion terms. **Every yaw quaternion built from a heading MUST use `-h`.**
This is the single most common sign bug in this subsystem; assert it in unit tests.

Body axes of the vessel (used by all attitude controllers in 12.8):

| Body axis | Direction               | Rate symbol | Positive rate means            |
|-----------|-------------------------|-------------|--------------------------------|
| `+Xb`     | starboard (pilot right) | `q` (pitch) | nose UP                        |
| `+Yb`     | vessel up               | `r` (yaw)   | nose RIGHT (heading increasing)|
| `-Zb`     | vessel forward          | `p` (roll)  | roll RIGHT (starboard down)    |

Euler extraction order for display and for the assist controllers: **Z-X-Y intrinsic**
(heading, then pitch, then roll), evaluated from the body quaternion. Internally attitude is
ALWAYS a unit quaternion; Euler angles are derived per frame for HUD and for the level/trim
controllers only, and are never integrated.

### 12.0.2 Units

| Quantity                | Unit in code | Unit in UI        |
|-------------------------|--------------|-------------------|
| Angle                   | rad          | deg (1 dp)        |
| Angular rate            | rad/s        | deg/s (0 dp)      |
| Mouse sensitivity       | deg / count  | abstract slider   |
| Time constant           | s            | s or ms           |
| Camera shake rotation   | rad          | deg               |
| Camera shake translation| m            | mm                |
| FOV                     | rad (vFOV)   | deg (hFOV @ 16:9) |
| Dead zone               | fraction 0..1| percent           |
| Rumble magnitude        | 0..1         | percent           |

### 12.0.3 Terminology

- **Action** - a named, engine-level intent (`MOVE_FORWARD`, `BALLAST_BLOW`). Never a key.
- **Binding** - a (device, control, modifier-mask) triple mapped to an action in one context.
- **Context** - an exclusive input state (`FOOT`, `VESSEL_WATER`, `UI_MENU`, ...). See 12.2.
- **Tap** - press+release with hold duration `< T_tap` (default 0.30 s) and no drag.
- **Hold** - press sustained `>= T_hold` for the action (per-action, table 12.4.1).
- **Repeat** - an action re-fired at an interval while held (UI only; never gameplay).
- **Axis** - a continuous input in [-1,1] (stick) or [0,1] (trigger) or unbounded (mouse delta).
- **Digital axis** - a pair of keys synthesised into an axis with SOCD resolution (12.10.4).

---

## 12.1 Input stack architecture

### 12.1.1 Layers

```
[DOM events]  keydown/keyup, mousemove(pointerlocked), mousedown/up, wheel, blur,
              visibilitychange, pointerlockchange, gamepadconnected/disconnected
                     |
                     v
[RawDeviceState]  keyDown:Set<code>, mouseButtons:bitmask, mouseAccumX/Y (counts),
                  wheelAccum (normalised notches), gamepad snapshot (polled)
                     |
                     v
[BindingResolver]  context stack -> binding table -> ActionState
                     |
                     v
[ActionState]  per action: {down, pressedThisFrame, releasedThisFrame, heldFor(s), value(f32)}
                     |
                     v
[ControlSchemes]  FootController / SwimController / VesselAssisted / VesselManual / UIRouter
                     |
                     v
[CameraRig]  look integration, FOV solver, shake accumulator, motion-comfort filters
```

### 12.1.2 Frame ordering (binding)

Exactly this order, once per rendered frame:

1. `pollGamepads()` - `navigator.getGamepads()` snapshot, curves + dead zones applied.
2. `drainMouseAccumulators()` - read and zero `mouseAccumX/Y`, `wheelAccum`.
3. `resolveBindings()` - produce `ActionState` for the top-of-stack context.
4. `runFixedSim(dt_fixed = 1/120 s)` - 1..4 substeps, catch-up cap 4. **Action state is
   held constant across all substeps of a frame.** Analogue axes are likewise frozen.
5. `applyLook()` - camera yaw/pitch/roll integration at **render rate**, after the sim, using
   the full frame's accumulated mouse counts. This decouples look latency from the fixed step.
6. `solveCamera()` - FOV, shake, comfort filters, final view matrix.
7. `clearFrameEdges()` - clear `pressedThisFrame` / `releasedThisFrame`.

**Latency budget:** DOM event -> photons must be `<= 45 ms` at 60 fps, `<= 30 ms` at 120 fps.
Look input specifically must be `<= 2` frames. No look smoothing may be enabled by default.

### 12.1.3 Mouse accumulation

Mouse deltas are accumulated in the DOM handler, never sampled:

```js
function onMouseMove(e) {
  if (document.pointerLockElement !== canvas) return;
  // Chrome coalesces high-polling-rate moves; getCoalescedEvents keeps sub-frame fidelity.
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of evs) {
    let dx = ev.movementX, dy = ev.movementY;
    // Spike guard: driver/RDP/VM glitches emit 5-digit deltas.
    if (dx >  MOUSE_EVENT_CLAMP) dx =  MOUSE_EVENT_CLAMP;
    if (dx < -MOUSE_EVENT_CLAMP) dx = -MOUSE_EVENT_CLAMP;
    if (dy >  MOUSE_EVENT_CLAMP) dy =  MOUSE_EVENT_CLAMP;
    if (dy < -MOUSE_EVENT_CLAMP) dy = -MOUSE_EVENT_CLAMP;
    raw.mouseAccumX += dx; raw.mouseAccumY += dy;
  }
}
```

| Constant             | Value | Notes                                             |
|----------------------|-------|---------------------------------------------------|
| `MOUSE_EVENT_CLAMP`  | 400   | device counts per single event                    |
| `MOUSE_FRAME_CLAMP`  | 1600  | device counts per frame, applied at drain time    |
| `MOUSE_FRAME_CLAMP_LOWFPS` | 3200 | used when frame dt > 40 ms so slow frames do not clip legitimate fast flicks |

Because look uses **accumulated counts** and not "counts per second", mouse look is exactly
frame-rate independent. Never multiply mouse delta by `dt`.

### 12.1.4 Wheel normalisation

`WheelEvent.deltaMode` is 0 (pixels), 1 (lines) or 2 (pages) in Chrome depending on device.

```js
const WHEEL_PX_PER_NOTCH = 100, WHEEL_LINES_PER_NOTCH = 3, WHEEL_PAGES_PER_NOTCH = 1;
let notches = e.deltaMode === 0 ? e.deltaY / WHEEL_PX_PER_NOTCH
            : e.deltaMode === 1 ? e.deltaY / WHEEL_LINES_PER_NOTCH
            :                     e.deltaY / WHEEL_PAGES_PER_NOTCH;
raw.wheelAccum += notches;           // +ve = scroll down / toward user
```

Discrete wheel actions fire when `|wheelAccum| >= 1.0`, consuming 1.0 per fire, max 6 fires
per frame. Trackpad inertial scroll therefore produces at most 6 slot changes/frame.
The `wheel` listener MUST be registered `{ passive: false }` and call `preventDefault()`
while a gameplay context is active, or Chrome scrolls the page behind the canvas.

---

## 12.2 Contexts

Contexts form a **stack**. The top context consumes input. Contexts below it are frozen but
retain their held-key state; on pop, any key still physically down is re-evaluated (no
"sticky key" carry-through of edges - see 12.10.9).

| Ctx ID            | Description                                       | Pointer lock | Sim runs | Cursor |
|-------------------|---------------------------------------------------|--------------|----------|--------|
| `BOOT`            | pre-gesture splash, "Click to dive"               | no           | no       | shown  |
| `FOOT`            | walking on island / on vessel deck                | yes          | yes      | hidden |
| `SWIM_SURFACE`    | in water, head above waterline                    | yes          | yes      | hidden |
| `SWIM_SUB`        | in water, head below waterline                    | yes          | yes      | hidden |
| `VESSEL_AIR`      | piloting, hull reference above waterline          | yes          | yes      | hidden |
| `VESSEL_SURFACE`  | piloting, hull straddling waterline (transitional)| yes          | yes      | hidden |
| `VESSEL_WATER`    | piloting, hull fully submerged                    | yes          | yes      | hidden |
| `UI_OVERLAY`      | inventory / fabricator / storage; world keeps running | no       | yes      | shown  |
| `UI_MENU`         | pause, options, save/load                         | no           | **no**   | shown  |
| `UI_MODAL`        | confirm dialog, key-rebind capture                | no           | no       | shown  |
| `SOFT_PAUSE`      | pointer lock lost / tab hidden; "click to resume" | no           | **no**   | shown  |
| `PHOTO`           | detached free camera                              | yes          | frozen   | hidden |
| `CINEMATIC`       | scripted camera (first dive, leviathan reveal)    | yes          | yes      | hidden |
| `DEAD`            | blackout + respawn prompt                         | no           | yes      | shown  |

**Context transition rules**

| From -> To                        | Trigger                                                     | Latch time |
|-----------------------------------|-------------------------------------------------------------|------------|
| `FOOT` -> `SWIM_SURFACE`          | player capsule origin y < -0.15 m and waterdepth > 1.2 m     | 0.20 s     |
| `SWIM_SURFACE` -> `SWIM_SUB`      | eye point y < -0.06 m                                        | 0.12 s     |
| `SWIM_SUB` -> `SWIM_SURFACE`      | eye point y > +0.04 m                                        | 0.12 s     |
| `SWIM_SURFACE` -> `FOOT`          | ground contact and capsule origin y > -0.10 m                | 0.20 s     |
| `VESSEL_AIR` -> `VESSEL_SURFACE`  | any hull sample point y < 0                                  | 0 s        |
| `VESSEL_SURFACE` -> `VESSEL_WATER`| all hull sample points y < -0.30 m                           | 0.25 s     |
| `VESSEL_WATER` -> `VESSEL_SURFACE`| any hull sample point y > -0.10 m                            | 0.25 s     |
| `VESSEL_SURFACE` -> `VESSEL_AIR`  | all hull sample points y > +0.25 m                           | 0.25 s     |
| any gameplay -> `SOFT_PAUSE`      | `pointerlockchange` to null, or `visibilitychange` to hidden | 0 s        |

The **hysteresis bands are mandatory** - a vessel bobbing at the waterline must not oscillate
control schemes. See 12.10.1 for the control-authority cross-fade.

---

## 12.3 Full binding tables

### 12.3.0 Notation

- Key names are `KeyboardEvent.code` values (layout-independent). UI labels are resolved via
  `navigator.keyboard.getLayoutMap()` - see 12.10.12.
- `M0` = left mouse, `M1` = middle, `M2` = right, `M3` = back, `M4` = forward.
- `WHEEL+` = scroll up (away from user), `WHEEL-` = scroll down.
- Gamepad uses the W3C **Standard Gamepad** mapping: `B0`=A/Cross, `B1`=B/Circle, `B2`=X/Square,
  `B3`=Y/Triangle, `B4`=LB/L1, `B5`=RB/R1, `B6`=LT/L2(analog), `B7`=RT/R2(analog), `B8`=View/Share,
  `B9`=Menu/Options, `B10`=L3, `B11`=R3, `B12..15`=DPad U/D/L/R. `LS`/`RS` = axes 0,1 / 2,3.
- Semantics column: `TAP`, `HOLD`, `TOGGLE`, `AXIS`, `HOLD+TAP` (both meanings, disambiguated by
  duration), `REPEAT` (UI only).

### 12.3.1 GLOBAL (active in every gameplay context unless overridden)

| Action           | Primary   | Alt      | Gamepad     | Semantics | Notes                                       |
|------------------|-----------|----------|-------------|-----------|---------------------------------------------|
| `PAUSE`          | Escape    | -        | B9          | TAP       | See 12.5.5 for Escape/pointer-lock interplay |
| `MAP`            | KeyM      | -        | B8          | TOGGLE    | Pushes `UI_OVERLAY`                         |
| `JOURNAL`        | KeyJ      | -        | B8 HOLD 0.5s| TOGGLE    | Scan log; pushes `UI_OVERLAY`               |
| `INVENTORY`      | Tab       | KeyI     | B3          | TOGGLE    | Pushes `UI_OVERLAY`; disabled in `VESSEL_*` unless docked-storage in range |
| `HUD_TOGGLE`     | F2        | -        | -           | TOGGLE    | Cycles Full -> Minimal -> Off               |
| `SCREENSHOT`     | F9        | -        | -           | TAP       | `canvas.toBlob` -> download, no HUD by default |
| `PHOTO_MODE`     | KeyP      | -        | -           | TOGGLE    | Pushes `PHOTO`                              |
| `QUICKSAVE`      | F8        | -        | -           | TAP       | 1.5 s cooldown; blocked while `damageTaken < 3 s` |
| `PERF_OVERLAY`   | F10       | -        | -           | TOGGLE    | frame graph, GPU timings                    |
| `VOLUME_DOWN`    | Minus     | -        | -           | TAP/REPEAT| -3 dB master, floor -60 dB                  |
| `VOLUME_UP`      | Equal     | -        | -           | TAP/REPEAT| +3 dB master, ceiling 0 dB                  |

`F1`, `F3`, `F5`, `F6`, `F7`, `F11`, `F12` are **never** bound: Chrome intercepts or partially
intercepts them. `F4` is reserved for future use and left unbound to avoid Alt+F4 confusion.

### 12.3.2 Context `FOOT`

| Action            | Primary      | Alt        | Gamepad        | Semantics | Detail                                                     |
|-------------------|--------------|------------|----------------|-----------|------------------------------------------------------------|
| `MOVE_FORWARD`    | KeyW         | ArrowUp    | LS -Y          | HOLD/AXIS | digital axis, SOCD `null`                                  |
| `MOVE_BACK`       | KeyS         | ArrowDown  | LS +Y          | HOLD/AXIS |                                                            |
| `MOVE_LEFT`       | KeyA         | ArrowLeft  | LS -X          | HOLD/AXIS | SOCD `last-wins`                                           |
| `MOVE_RIGHT`      | KeyD         | ArrowRight | LS +X          | HOLD/AXIS |                                                            |
| `LOOK_YAW`        | Mouse X      | -          | RS +X          | AXIS      | see 12.6                                                   |
| `LOOK_PITCH`      | Mouse Y      | -          | RS +Y          | AXIS      | inverted by option, default not inverted                   |
| `SPRINT`          | ShiftLeft    | -          | B10 (L3)       | HOLD      | option "Sprint: Hold/Toggle", default Hold. Drains stamina 6.5/s |
| `JUMP`            | Space        | -          | B0             | TAP       | variable height: impulse scales 0.70..1.00 for hold 0..0.18 s |
| `CROUCH`          | ControlLeft  | KeyC       | B1             | HOLD      | option Hold/Toggle, default Hold                           |
| `INTERACT`        | KeyE         | -          | B2             | TAP       | tap window `< 0.30 s`                                      |
| `INTERACT_HOLD`   | KeyE (0.55s) | -          | B2 (0.55s)     | HOLD      | radial fill on HUD; used for board-vessel, harvest, pry    |
| `TOOL_PRIMARY`    | M0           | -          | B7 (RT)        | HOLD+TAP  | per-tool; analog on RT (>= 0.35 = fire)                    |
| `TOOL_SECONDARY`  | M2           | -          | B6 (LT)        | HOLD+TAP  |                                                            |
| `TOOL_NEXT`       | WHEEL-       | -          | B5 (RB)        | TAP       |                                                            |
| `TOOL_PREV`       | WHEEL+       | -          | B4 (LB)        | TAP       |                                                            |
| `TOOL_SLOT_1..5`  | Digit1..5    | -          | -              | TAP       | direct select; re-press holsters                           |
| `TOOL_HOLSTER`    | KeyX         | -          | B3 HOLD 0.40s  | TAP       |                                                            |
| `TOOL_RECHARGE`   | KeyR         | -          | B2 HOLD (ctx)  | TAP       | swap power cell from inventory                             |
| `LIGHT_HEAD`      | KeyF         | -          | DPad Up (B12)  | TOGGLE    | helmet lamp; 3 brightness steps on Shift+KeyF              |
| `SCAN`            | KeyQ         | -          | DPad Right(B15)| HOLD      | scanner beam while held; 0.9-3.4 s per target              |
| `FREE_LOOK`       | AltLeft      | M3         | B11 HOLD (R3)  | HOLD      | detaches view yaw from movement, +/-100 deg; recenters tau 0.22 s |
| `CAM_CYCLE`       | KeyC + Shift | -          | DPad Down(B13) | TAP       | first-person -> shoulder (only on land; disabled in water) |

Locomotion numbers referenced by input (owned by section 05, restated for binding sanity):
walk 2.6 m/s, sprint 5.1 m/s, crouch 1.3 m/s, jump apex 0.72 m. Movement acceleration
18 m/s^2 ground, deceleration 26 m/s^2; input direction is normalised so diagonal is not faster.

### 12.3.3 Contexts `SWIM_SURFACE` / `SWIM_SUB`

Differences from `FOOT` only; everything else inherits.

| Action           | Primary     | Alt      | Gamepad   | Semantics | Detail                                                     |
|------------------|-------------|----------|-----------|-----------|------------------------------------------------------------|
| `MOVE_FORWARD`   | KeyW        | ArrowUp  | LS -Y     | HOLD/AXIS | swims along **camera forward** (full 3D) when `SWIM_SUB`; along horizontal projection when `SWIM_SURFACE` |
| `SWIM_UP`        | Space       | -        | B0        | HOLD      | 1.05 m/s vertical; at surface becomes "climb out" if ledge within 0.6 m |
| `SWIM_DOWN`      | ControlLeft | KeyC     | B1        | HOLD      | 1.05 m/s vertical                                          |
| `SPRINT`         | ShiftLeft   | -        | B10       | HOLD      | fin burst: speed x1.85, O2 burn x2.2, stamina 11/s          |
| `JUMP`           | -           | -        | -         | -         | **unbound** in water; Space is `SWIM_UP`                    |
| `CROUCH`         | -           | -        | -         | -         | **unbound**; ControlLeft is `SWIM_DOWN`                     |
| `EMERGENCY_ASCENT`| Space x2 (double-tap <= 0.28 s) | - | B0 x2 | TAP    | 4 s of 2.3 m/s ascent, O2 burn x3.0. Option "Double-tap actions" default ON; when OFF this action is unbound |
| `O2_READOUT`     | KeyO        | -        | -         | TAP       | speaks/flashes remaining O2 seconds on HUD for 3 s          |
| `CAM_CYCLE`      | -           | -        | -         | -         | **unbound**; first-person only in water (design rule)       |
| `LIGHT_HEAD`     | KeyF        | -        | B12       | TOGGLE    | as FOOT; auto-on below d = 45 m if option "Auto Lamp" ON    |

Swim numbers referenced by input (owned by 05): base swim 1.55 m/s, finned 2.4 m/s, burst
4.45 m/s. Water drag makes input feel laggy by design: acceleration 4.2 m/s^2, decel 3.0 m/s^2.
Look pitch clamp in water is **+/- 89.5 deg** (near-vertical swimming must be possible).

### 12.3.4 Context `VESSEL_AIR` - **ASSISTED** scheme (default)

| Action            | Primary      | Alt       | Gamepad      | Semantics | Detail                                                        |
|-------------------|--------------|-----------|--------------|-----------|---------------------------------------------------------------|
| `AIM_YAW`         | Mouse X      | -         | RS +X        | AXIS      | drives virtual reticle (12.8.3), not direct torque             |
| `AIM_PITCH`       | Mouse Y      | -         | RS +Y        | AXIS      |                                                                |
| `THROTTLE_UP`     | KeyW         | -         | B7 (RT) axis | HOLD      | +55 %/s of setpoint; double-tap = snap to 100 %                |
| `THROTTLE_DOWN`   | KeyS         | -         | B6 (LT) axis | HOLD      | -70 %/s; double-tap = snap to 0 %; held at 0 % for 0.40 s engages reverse to -30 % |
| `ROLL_LEFT`       | KeyA         | -         | B4 (LB)      | HOLD      | +/-1.0 roll command; overrides auto-level while held + 0.6 s   |
| `ROLL_RIGHT`      | KeyD         | -         | B5 (RB)      | HOLD      |                                                                |
| `STRAFE_LEFT`     | KeyA + AltLeft| KeyZ     | LS -X        | HOLD      | lateral thrusters, only below 18 m/s airspeed                  |
| `STRAFE_RIGHT`    | KeyD + AltLeft| -        | LS +X        | HOLD      |                                                                |
| `CLIMB`           | Space        | -         | B0           | HOLD      | vertical thruster / collective, +1.0                           |
| `DESCEND`         | ControlLeft  | -         | B1           | HOLD      | -1.0                                                           |
| `BOOST`           | ShiftLeft    | -         | B10 (L3)     | HOLD      | x1.9 thrust, 6.0 s reservoir, 14 s recharge, FOV kick +11 deg  |
| `AIRBRAKE`        | KeyX         | -         | B11 (R3)     | HOLD      | Cd x3.4, pitch-up trim +2 deg, strong shake (12.7.4)           |
| `HOLD_HOVER`      | KeyH         | -         | DPad L (B14) | TOGGLE    | station-keeping (12.8.6)                                       |
| `HOLD_ALTITUDE`   | KeyT         | -         | DPad U (B12) | TOGGLE    | altitude hold at current AGL/ASL (12.8.5)                      |
| `LEVEL_NOW`       | KeyR         | -         | B3 HOLD 0.5s | TAP       | snap-to-level assist: roll->0, pitch->0 over 0.9 s             |
| `GEAR`            | KeyG         | -         | DPad D (B13) | TOGGLE    | landing skids; auto-deploys below 6 m AGL if option ON         |
| `LIGHT_EXT`       | KeyL         | -         | DPad R (B15) | TOGGLE    | exterior floods                                                |
| `LIGHT_EXT_MODE`  | ShiftLeft+KeyL| -        | DPad R HOLD  | TAP       | cycle Flood -> Spot -> Wide -> Off                             |
| `LIGHT_INT`       | KeyK         | -         | -            | TOGGLE    | cockpit interior lamps (3 dim steps on Shift+KeyK)             |
| `HUD_MODE`        | KeyN         | -         | -            | TAP       | windshield HUD: Nav -> Survey -> Combat-avoid -> Minimal       |
| `SONAR_PING`      | KeyV         | -         | -            | TAP       | 2.4 s cooldown; audible to fauna (see 13)                      |
| `SCAN`            | KeyQ         | -         | -            | HOLD      | vessel scanner array                                           |
| `CAM_CYCLE`       | KeyC         | -         | -            | TAP       | Cockpit -> Chase (6.5 m) -> Orbit (12 m)                       |
| `FREE_LOOK`       | AltLeft      | M3        | B11 HOLD     | HOLD      | +/-135 deg yaw, +/-70 deg pitch; recenter tau 0.25 s           |
| `EXIT_VESSEL`     | KeyE (0.60s) | -         | B2 (0.60s)   | HOLD      | see 12.10.2                                                    |
| `BALLAST_FILL`    | KeyF         | -         | -            | HOLD      | pre-floods for a planned dive; disengages auto-trim while held  |
| `BALLAST_BLOW`    | KeyR + Shift | -         | -            | HOLD      | (rarely useful in air; kept for parity)                        |
| `EMERGENCY_BLOW`  | KeyR x2 (double-tap) | -  | B3 x2        | TAP       | full blow + 100 % vertical thrust for 5 s, 1 use / 90 s        |

Note `KeyA`/`KeyD` are **roll** by default in air and **yaw** in water (12.3.6). This is
deliberate: banked flight in air, flat turns in water. Strafe lives on Alt+A/D and on the
left stick, which is otherwise unused in air. Players who dislike this can select the
"Unified" binding preset (12.9.7) where A/D is always yaw and Q/E is always roll.

### 12.3.5 Context `VESSEL_AIR` - **MANUAL** scheme

Only the deltas from Assisted are listed; unlisted actions are identical.

| Action           | Primary      | Gamepad      | Semantics | Detail                                                        |
|------------------|--------------|--------------|-----------|---------------------------------------------------------------|
| `PITCH_CMD`      | Mouse Y      | RS +Y        | AXIS      | **direct moment command**, no reticle, no auto-return          |
| `YAW_CMD`        | Mouse X      | RS +X        | AXIS      | direct rudder/yaw thruster command                             |
| `ROLL_CMD`       | KeyA/KeyD    | LS +X        | AXIS      | direct roll moment; **no auto-level ever**                     |
| `THROTTLE_AXIS`  | KeyW/KeyS, WHEEL | RT/LT    | AXIS      | persistent lever 0..100 %, no speed setpoint, no speed hold    |
| `TRIM_PITCH_UP`  | PageUp       | -            | TAP/REPEAT| +0.5 deg trim per press, range +/-12 deg, repeat 8 Hz after 0.4 s |
| `TRIM_PITCH_DOWN`| PageDown     | -            | TAP/REPEAT|                                                               |
| `TRIM_RESET`     | Home         | -            | TAP       | zero all trims                                                 |
| `HOLD_HOVER`     | KeyH         | DPad L       | TOGGLE    | **available but OFF by default**; explicit opt-in per flight   |
| `HOLD_ALTITUDE`  | KeyT         | DPad U       | TOGGLE    | available; disengages on any `CLIMB`/`DESCEND` input           |
| `LEVEL_NOW`      | -            | -            | -         | **unbound in Manual** (it is an assist)                        |

### 12.3.6 Context `VESSEL_WATER` - **ASSISTED**

| Action            | Primary      | Alt       | Gamepad      | Semantics | Detail                                                        |
|-------------------|--------------|-----------|--------------|-----------|---------------------------------------------------------------|
| `AIM_YAW`         | Mouse X      | -         | RS +X        | AXIS      | reticle radius 16 deg (tighter than air)                       |
| `AIM_PITCH`       | Mouse Y      | -         | RS +Y        | AXIS      |                                                                |
| `THROTTLE_UP`     | KeyW         | -         | RT           | HOLD      | +45 %/s (slower than air)                                      |
| `THROTTLE_DOWN`   | KeyS         | -         | LT           | HOLD      | -60 %/s; reverse to -40 % (thrusters are symmetric underwater) |
| `YAW_LEFT`        | KeyA         | -         | LS -X        | HOLD      | **flat turn** (differential thrusters)                         |
| `YAW_RIGHT`       | KeyD         | -         | LS +X        | HOLD      |                                                                |
| `ROLL_LEFT`       | KeyQ         | -         | B4 (LB)      | HOLD      | rarely needed; auto-level fights it after release + 0.6 s      |
| `ROLL_RIGHT`      | Shift+KeyQ   | -         | B5 (RB)      | HOLD      | `KeyE` is deliberately NOT used for roll: it must stay free for `EXIT_VESSEL`. The `Unified` preset moves roll to KeyQ/KeyE and exit to KeyG. |
| `ASCEND`          | Space        | -         | B0           | HOLD      | vertical thrusters up; overrides auto-trim                     |
| `DESCEND`         | ControlLeft  | -         | B1           | HOLD      | vertical thrusters down                                        |
| `BALLAST_BLOW`    | KeyR         | -         | DPad U HOLD  | HOLD      | pumps water out, 0.42 m^3/s; makes vessel lighter              |
| `BALLAST_FILL`    | KeyF         | -         | DPad D HOLD  | HOLD      | floods, 0.55 m^3/s                                             |
| `BALLAST_AUTO`    | KeyB         | -         | DPad D TAP   | TOGGLE    | re-engages auto-trim; default ON in Assisted                   |
| `EMERGENCY_BLOW`  | KeyR x2      | -         | B3 x2        | TAP       | 100 % blow + 100 % up-thrust 5 s; hull stress +; 90 s cooldown |
| `HOLD_DEPTH`      | KeyT         | -         | DPad U TAP   | TOGGLE    | depth hold at current depth (12.8.5)                           |
| `HOLD_HOVER`      | KeyH         | -         | DPad L       | TOGGLE    | 3-axis station keeping vs. current                             |
| `SILENT_RUN`      | KeyZ         | -         | B11 HOLD 0.5s| TOGGLE    | thrust cap 35 %, lights forced off, acoustic signature -18 dB  |
| `BOOST`           | ShiftLeft    | -         | B10          | HOLD      | x1.55 thrust (less than air), 4.5 s reservoir, 18 s recharge   |
| `AIRBRAKE`        | KeyX         | -         | B11 (R3)     | HOLD      | reverse thrust + flare, decel 6.8 m/s^2                        |
| `SONAR_PING`      | KeyV         | -         | B3 TAP       | TAP       | 2.4 s cooldown; reveals 240 m sphere on HUD for 6 s            |
| `SONAR_PASSIVE`   | ShiftLeft+KeyV| -        | -            | TOGGLE    | continuous listening display, no emission                      |
| `LIGHT_EXT`       | KeyL         | -         | DPad R       | TOGGLE    | auto-on below d = 60 m if option ON                            |
| `EXIT_VESSEL`     | KeyE (0.60s) | -         | B2 (0.60s)   | HOLD      | floods airlock; see 12.10.2. Blocked if d > 380 m unless suit rated |

### 12.3.7 Context `VESSEL_WATER` - **MANUAL** (deltas only)

| Action           | Primary       | Gamepad | Semantics | Detail                                                          |
|------------------|---------------|---------|-----------|------------------------------------------------------------------|
| `PITCH_CMD`      | Mouse Y       | RS +Y   | AXIS      | direct dive-plane + pitch-thruster moment                        |
| `YAW_CMD`        | Mouse X       | RS +X   | AXIS      | direct rudder + yaw-thruster moment                              |
| `ROLL_CMD`       | KeyQ / Shift+KeyQ | LS +X | AXIS     | direct; **no auto-level**                                        |
| `VTHRUST_UP`     | Space         | B0      | HOLD      | vertical thrusters only; **does not** touch ballast              |
| `VTHRUST_DOWN`   | ControlLeft   | B1      | HOLD      |                                                                  |
| `BALLAST_BLOW`   | KeyR          | DPad U  | HOLD      | manual only; no auto-trim to fall back on                        |
| `BALLAST_FILL`   | KeyF          | DPad D  | HOLD      |                                                                  |
| `BALLAST_AUTO`   | -             | -       | -         | **unbound**; auto-trim does not exist in Manual                  |
| `TRIM_FWD_PUMP`  | PageUp        | -       | TAP/REPEAT| moves 40 kg of trim water forward per press; range +/-320 kg      |
| `TRIM_AFT_PUMP`  | PageDown      | -       | TAP/REPEAT| affects static pitch angle by ~0.9 deg per 40 kg                  |
| `HOLD_DEPTH`     | KeyT          | DPad U  | TOGGLE    | available, off by default; uses V-thrusters only, never ballast   |

### 12.3.8 Context `VESSEL_SURFACE`

`VESSEL_SURFACE` uses the **`VESSEL_WATER` binding table** with three overrides, because the
common case is a player about to dive:

| Action        | Behaviour at surface                                                              |
|---------------|-----------------------------------------------------------------------------------|
| `THROTTLE_*`  | Thrust authority scales with submerged fraction (12.10.1); HUD shows "SURFACE"     |
| `Space`       | `ASCEND` - if it results in full emergence for 0.35 s, context promotes to `VESSEL_AIR` and Space silently rebinds to `CLIMB` (identical feel, no re-press needed) |
| `BALLAST_FILL`| Available and highlighted; the primary way to initiate a dive from a floating start |

### 12.3.9 Contexts `UI_OVERLAY` / `UI_MENU` / `UI_MODAL`

| Action           | Primary                | Alt        | Gamepad       | Semantics   | Detail                                    |
|------------------|------------------------|------------|---------------|-------------|-------------------------------------------|
| `UI_UP`          | ArrowUp                | KeyW       | DPad U / LS-Y | TAP/REPEAT  | repeat: 0.42 s delay, 12 Hz               |
| `UI_DOWN`        | ArrowDown              | KeyS       | DPad D / LS+Y | TAP/REPEAT  |                                           |
| `UI_LEFT`        | ArrowLeft              | KeyA       | DPad L / LS-X | TAP/REPEAT  |                                           |
| `UI_RIGHT`       | ArrowRight             | KeyD       | DPad R / LS+X | TAP/REPEAT  |                                           |
| `UI_CONFIRM`     | Enter                  | Space, M0  | B0            | TAP         |                                           |
| `UI_CANCEL`      | Escape                 | Backspace  | B1            | TAP         | pops one context level                    |
| `UI_TAB_NEXT`    | Tab                    | -          | B5 (RB)       | TAP         | wraps                                     |
| `UI_TAB_PREV`    | Shift+Tab              | -          | B4 (LB)       | TAP         |                                           |
| `UI_CONTEXT`     | M2                     | -          | B3            | TAP         | item context menu                         |
| `UI_QUICK_MOVE`  | Shift+M0               | -          | B2            | TAP         | move stack container<->inventory          |
| `UI_SPLIT`       | ControlLeft+M0 drag    | -          | B2 HOLD 0.4 s | HOLD        | split stack; gamepad opens a count spinner|
| `UI_DROP`        | KeyX                   | Delete     | B3 HOLD 0.5 s | HOLD        | 0.5 s hold guard to prevent misdrops      |
| `UI_SORT`        | KeyR                   | -          | B10 (L3)      | TAP         |                                           |
| `UI_SEARCH`      | Slash                  | -          | B11 (R3)      | TAP         | focuses a text field -> pushes text-entry sub-state |
| `UI_PAGE_UP`     | PageUp                 | WHEEL+     | B6 (LT)       | TAP/REPEAT  |                                           |
| `UI_PAGE_DOWN`   | PageDown               | WHEEL-     | B7 (RT)       | TAP/REPEAT  |                                           |
| `UI_RESET_DEFAULT`| KeyR HOLD 0.80 s      | -          | B9 HOLD 0.8 s | HOLD        | options screens only; radial confirm      |
| `UI_UNBIND`      | Backspace              | -          | B2            | TAP         | rebind capture screen only                |
| `UI_CLOSE_ALL`   | Escape HOLD 0.45 s     | -          | B1 HOLD 0.45 s| HOLD        | pops the whole UI stack back to gameplay  |

**Text-entry sub-state:** while a text field has focus, ALL gameplay and UI bindings except
`Escape` (blur field) and `Enter` (commit) are suspended and keystrokes go to the field.
`keydown` is not `preventDefault`ed in this sub-state except for Tab.

### 12.3.10 Context `PHOTO`

| Action            | Primary       | Gamepad      | Semantics | Detail                                        |
|-------------------|---------------|--------------|-----------|-----------------------------------------------|
| `CAM_MOVE_*`      | WASD          | LS           | HOLD      | 3.0 m/s base                                  |
| `CAM_UP/DOWN`     | Space / Ctrl  | B0 / B1      | HOLD      |                                               |
| `CAM_FAST`        | ShiftLeft     | B10          | HOLD      | x4.0                                          |
| `CAM_SLOW`        | AltLeft       | B11          | HOLD      | x0.2                                          |
| `CAM_ROLL`        | KeyQ / KeyE   | LB / RB      | HOLD      | 40 deg/s, range +/-45 deg                     |
| `CAM_FOV`         | WHEEL         | LT / RT      | AXIS      | hFOV 18..130 deg, 2 deg per notch             |
| `CAM_FOCUS`       | M2 (aim+hold) | B2           | HOLD      | sets DOF focal distance by raycast            |
| `CAM_APERTURE`    | Shift+WHEEL   | DPad L/R     | AXIS      | f/1.2 .. f/22 in 1/3 stops                    |
| `TIME_SCALE`      | KeyT + WHEEL  | DPad U/D     | AXIS      | 0.0 .. 1.0, default 0.0 (frozen)              |
| `HIDE_UI`         | F2            | B8           | TOGGLE    |                                               |
| `CAPTURE`         | F9 / Enter    | B9           | TAP       | renders at up to 3840x2160 with 4x TAA frames |
| `EXIT`            | Escape / KeyP | B1           | TAP       | restores previous context and camera          |

### 12.3.11 Context `CINEMATIC` and `DEAD`

| Context     | Allowed actions                                                       |
|-------------|-----------------------------------------------------------------------|
| `CINEMATIC` | `FREE_LOOK` at 45 % authority (if the shot allows), `PAUSE`, `SKIP` (hold Space or B0 for 1.20 s, only after 2.0 s of playback, only for already-seen cinematics unless option "Allow skipping first-time cinematics" is ON) |
| `DEAD`      | `UI_CONFIRM` (respawn) after a 2.5 s input lockout; `PAUSE`; nothing else. Look is frozen and the camera performs the death fall-away (12.7.7). |

---

## 12.4 Hold vs tap semantics

### 12.4.1 Duration constants

| Constant                 | Value  | Applies to                                                    |
|--------------------------|--------|---------------------------------------------------------------|
| `T_TAP_MAX`              | 0.30 s | max press duration still counted as a tap                     |
| `T_HOLD_INTERACT`        | 0.55 s | `INTERACT_HOLD` on foot                                       |
| `T_HOLD_EXIT_VESSEL`     | 0.60 s | `EXIT_VESSEL`                                                 |
| `T_HOLD_DROP`            | 0.50 s | `UI_DROP`                                                     |
| `T_HOLD_DESTRUCTIVE`     | 0.80 s | `UI_RESET_DEFAULT`, delete save                               |
| `T_HOLD_SKIP_CINEMATIC`  | 1.20 s | `SKIP`                                                        |
| `T_DOUBLE_TAP`           | 0.28 s | max gap between the two taps of a double-tap                  |
| `T_DOUBLE_TAP_LOCKOUT`   | 0.10 s | min gap; faster than this is treated as key chatter and ignored|
| `T_REPEAT_DELAY_UI`      | 0.42 s | first repeat delay in UI                                      |
| `T_REPEAT_RATE_UI`       | 12 Hz  | subsequent repeats in UI                                      |
| `T_BUFFER_WINDOW`        | 0.25 s | input buffering during locked animations (12.10.2)            |

### 12.4.2 Disambiguation rule for `HOLD+TAP` actions

When one physical control carries both a tap action and a hold action (e.g. `KeyE`):

1. On press, start a timer. **Do not** fire the tap action yet.
2. If released before `T_HOLD_x`, fire the tap action on release.
3. If still held at `T_HOLD_x`, fire the hold action once and mark the press consumed;
   the subsequent release fires nothing.
4. A radial progress ring appears on the HUD at 0.12 s and fills to `T_HOLD_x`.

**Exception - latency-critical actions.** `TOOL_PRIMARY` and `JUMP` fire on press, never on
release. They are excluded from rule (1). For `TOOL_PRIMARY`, hold semantics are handled by
the tool itself (a drill ramps up while held; a scanner charges).

### 12.4.3 Hold-to-toggle accessibility conversion

Every action with `HOLD` semantics has an accessibility option **"Toggle instead of hold"**
in one of three grouped switches, plus a global master:

| Option group             | Actions affected                                             | Default |
|--------------------------|--------------------------------------------------------------|---------|
| `TOGGLE_SPRINT`          | `SPRINT`, `BOOST`                                            | Hold    |
| `TOGGLE_CROUCH`          | `CROUCH`, `SWIM_DOWN` (as sustained descent)                 | Hold    |
| `TOGGLE_TOOL`            | `TOOL_PRIMARY`, `TOOL_SECONDARY`, `SCAN`                     | Hold    |
| `TOGGLE_VESSEL_SUSTAIN`  | `CLIMB`/`DESCEND`, `BALLAST_FILL`/`BALLAST_BLOW`, `AIRBRAKE` | Hold    |
| `TOGGLE_FREE_LOOK`       | `FREE_LOOK`                                                  | Hold    |
| `TOGGLE_ALL_HOLDS`       | master: forces all of the above to Toggle                    | Off     |

Confirmation holds (`INTERACT_HOLD`, `EXIT_VESSEL`, `UI_DROP`, `T_HOLD_DESTRUCTIVE`) are
**not** convertible to toggles - they exist to prevent accidents - but their durations are
scaled by an accessibility slider **"Hold duration"** with range 0.40x .. 2.00x, default 1.00x.

### 12.4.4 Double-tap actions

Double-taps exist for exactly three actions: `EMERGENCY_ASCENT`, `EMERGENCY_BLOW`, and
throttle snap (`THROTTLE_UP`/`THROTTLE_DOWN` to 100 %/0 %). The option **"Double-tap actions"**
(default ON) disables all of them; when OFF, `EMERGENCY_ASCENT` and `EMERGENCY_BLOW` become
directly bindable single controls (unbound by default, surfaced in the rebind list).

---

## 12.5 Pointer lock

### 12.5.1 Acquisition

Pointer lock may only be requested from a user-gesture handler. There are exactly three
acquisition sites:

| Site                | Gesture                          | Also performs                                          |
|---------------------|----------------------------------|--------------------------------------------------------|
| `BOOT` splash       | `pointerdown` on "CLICK TO DIVE" | `AudioContext.resume()`, optional `requestFullscreen()`, gamepad unlock prompt |
| `SOFT_PAUSE` overlay| `pointerdown` anywhere on canvas | re-arm audio if suspended                              |
| `UI_MENU` -> resume | `pointerdown` on RESUME, or `Escape` keyup | pops UI stack                                 |

```js
async function acquirePointerLock() {
  if (document.pointerLockElement === canvas) return true;
  const now = performance.now();
  if (now - lastUserExitMs < PL_COOLDOWN_MS) { showResumingToast(); scheduleRetry(); return false; }
  try {
    // unadjustedMovement:true gives RAW device counts (no OS pointer acceleration).
    // Chrome 111+ returns a Promise; older paths return undefined.
    const r = canvas.requestPointerLock({ unadjustedMovement: true });
    if (r && r.then) await r;
    input.unadjusted = true;
  } catch (err) {
    // NotSupportedError on some Linux/remote-desktop configs -> fall back.
    try { canvas.requestPointerLock(); input.unadjusted = false; }
    catch (e2) { showPointerLockDiagnostic(e2); return false; }
  }
  return document.pointerLockElement === canvas;
}
```

| Constant       | Value   | Notes                                                                 |
|----------------|---------|-----------------------------------------------------------------------|
| `PL_COOLDOWN_MS` | 1300  | Chrome refuses a re-lock issued too soon after a user-initiated exit (~1 s). We add margin. |
| `PL_RETRY_MS`  | 120     | retry interval while in cooldown                                      |
| `PL_RETRY_MAX_MS` | 4000 | after this, stop auto-retrying and require a fresh click              |

**`unadjustedMovement` matters for feel.** With it, `movementX/Y` are raw device counts and
sensitivity is deterministic. Without it, the OS acceleration curve is baked in and the same
sensitivity value feels different. Persist which mode produced the user's tuned sensitivity
(`sens.calibratedUnadjusted`); if the mode changes between sessions, show a one-time notice
"Mouse input mode changed - you may want to re-check sensitivity" and do **not** silently
rescale.

### 12.5.2 Loss

`pointerlockchange` firing with `document.pointerLockElement === null` is the single
authoritative loss signal. Causes: user pressed Escape; tab hidden; fullscreen exited;
canvas removed/reparented; OS-level interruption (screen lock, UAC, Cmd+Tab).

On loss during any gameplay context, **immediately and unconditionally**:

1. `releaseAllInputs()` - clear `keyDown`, mouse buttons, gamepad button latches; synthesise
   release edges for every action that was down so held state cannot leak (12.10.9).
2. Stop all rumble (`gamepad.vibrationActuator.reset()`).
3. Push `SOFT_PAUSE`; freeze the simulation; hold the last camera transform.
4. Duck audio to -18 dB over 150 ms; do not suspend the AudioContext yet (only on tab hide).
5. Record `lastUserExitMs = performance.now()`.

**`SOFT_PAUSE` is not the pause menu.** It is a translucent full-canvas panel with a single
line: `PAUSED - CLICK TO RESUME`. This is critical: Escape is easy to hit by accident, and
dropping the player into a full menu (with Save/Quit adjacency) after a stray keypress is
hostile. A second `Escape` while in `SOFT_PAUSE` opens the real `UI_MENU`.

### 12.5.3 Re-acquire UX

```
[gameplay] --Escape/blur--> [SOFT_PAUSE]
                               | click on canvas
                               v
                        cooldown elapsed?
                         yes /        \ no
                            v          v
                     [gameplay]   "RESUMING..." + spinner, retry every 120 ms
                                        | success
                                        v
                                   [gameplay]
```

- The resume click target is the **entire canvas**, minimum 100 % of the viewport. There is
  no small button to miss.
- On successful re-lock, discard the first `mousemove` event's delta entirely (Chrome
  occasionally delivers one large synthetic delta as the cursor is warped) and additionally
  suppress look input for 60 ms.
- Fade audio back up over 200 ms; unfreeze sim on the frame after lock is confirmed, with
  `dt` clamped to `1/60` for the first frame to avoid a physics jump.
- If three consecutive acquisitions fail, show a diagnostic panel: "Your browser blocked
  mouse capture. Try clicking the game area again, or press F11 for fullscreen." Offer a
  **Cursor Mode** fallback (12.5.6).

### 12.5.4 Fullscreen and the Keyboard Lock API

| Setting                         | Default | Effect                                                                 |
|---------------------------------|---------|------------------------------------------------------------------------|
| `Fullscreen on start`           | ON      | `canvas.requestFullscreen()` from the boot gesture                      |
| `Capture Escape key`            | ON      | when fullscreen, call `navigator.keyboard.lock(['Escape'])`             |

With Keyboard Lock active, `Escape` is delivered to the page as a normal `keydown` and does
**not** exit pointer lock. Escape then opens `UI_MENU` directly, which is the desired feel.
Chrome still lets the user leave fullscreen by **press-and-holding Escape for ~2 s**, and
shows its own toast the first time. Requirements:

- Call `navigator.keyboard.lock(['Escape'])` only after `fullscreenchange` confirms fullscreen.
- Call `navigator.keyboard.unlock()` in the `fullscreenchange` handler when leaving fullscreen,
  and in `pagehide`.
- Feature-detect: `navigator.keyboard && navigator.keyboard.lock`. If absent, fall back to
  the pointer-lock-Escape behaviour of 12.5.2 with no user-visible difference other than the
  extra `SOFT_PAUSE` step.
- The options screen must state plainly: "Hold Escape to leave fullscreen."

### 12.5.5 Escape handling matrix

| Context        | Keyboard Lock ON                   | Keyboard Lock OFF                                    |
|----------------|------------------------------------|------------------------------------------------------|
| gameplay       | open `UI_MENU`, exit pointer lock  | Chrome exits pointer lock -> `SOFT_PAUSE`             |
| `SOFT_PAUSE`   | n/a (does not occur)               | open `UI_MENU`                                        |
| `UI_OVERLAY`   | close overlay, re-lock pointer     | close overlay, re-lock pointer (subject to cooldown)  |
| `UI_MENU`      | back one page; at root -> resume   | same                                                  |
| `UI_MODAL`     | cancel modal                       | same                                                  |
| rebind capture | cancel capture (never binds Escape)| same                                                  |
| `PHOTO`        | exit photo mode                    | same                                                  |
| text entry     | blur field                         | same                                                  |

`Escape` can never be rebound and can never be assigned to a gameplay action.

### 12.5.6 Cursor Mode fallback

If pointer lock is unavailable (rare Chrome configurations, some kiosk policies), the game
must remain playable:

- Look is driven by cursor **position** relative to screen centre, inside a 12 %-of-height
  dead zone, with a turn rate proportional to offset up to 220 deg/s at the screen edge.
- A visible reticle marks screen centre; the OS cursor is drawn as a small ring.
- A persistent banner reads "CURSOR MODE - mouse capture unavailable".
- This mode is also selectable manually as an accessibility option.

---

## 12.6 Camera feel

### 12.6.1 Mouse sensitivity

The canonical quantity is **degrees of yaw per mouse count**:

```
deg_per_count = SENS_BASE * sensitivity_slider * axis_multiplier * context_scale * zoom_scale
SENS_BASE = 0.022 deg/count      // Quake/Source-compatible reference
```

| Option                      | Range        | Default | Step  | Notes                                       |
|-----------------------------|--------------|---------|-------|---------------------------------------------|
| `sensitivity_slider`        | 0.10 .. 10.00| **2.50**| 0.05  | default = 0.055 deg/count = 6545 counts/360 |
| `sens_y_multiplier`         | 0.25 .. 4.00 | 1.00    | 0.01  | vertical relative to horizontal              |
| `invert_y`                  | bool         | OFF     | -     | applies to mouse and stick independently     |
| `invert_x`                  | bool         | OFF     | -     |                                              |
| `invert_y_vessel`           | bool         | OFF     | -     | separate switch; flight-sim players want it  |
| `mouse_accel`               | bool         | **OFF** | -     | see 12.6.2                                   |
| `mouse_smoothing`           | 0 .. 100 %   | **0 %** | 1     | see 12.6.3                                   |
| `raw_input` (unadjusted)    | bool         | ON      | -     | maps to `unadjustedMovement`                 |

At the default, an 800 DPI mouse needs **8.18 inches (208 mm)** of travel for a 360 deg turn
on foot. At 1600 DPI, 4.09 in. The options screen must display "cm/360" live, computed from a
user-entered DPI (default 800) - this is the only trustworthy way to let players port muscle
memory in.

**Per-context scale** (`context_scale`), applied on top of the slider:

| Context                    | `context_scale` | Rationale                                    |
|----------------------------|-----------------|----------------------------------------------|
| `FOOT`                     | 1.00            | reference                                    |
| `SWIM_SURFACE` / `SWIM_SUB`| 0.88            | water resists head movement; also reduces sim sickness |
| `VESSEL_AIR` (Assisted)    | 0.72            | mouse drives the reticle, not the head       |
| `VESSEL_WATER` (Assisted)  | 0.60            | heavy vehicle, dense medium                  |
| `VESSEL_*` (Manual)        | 0.55            | direct moment command; low gain is essential |
| `FREE_LOOK` (any)          | 1.00            |                                              |
| `PHOTO`                    | 0.80            |                                              |
| Scanner zoom / binocular   | see zoom_scale  |                                              |

Each of these is individually exposed in Advanced options with range 0.25 .. 2.00.

**Zoom scaling.** When FOV changes (scanner zoom, boost FOV kick is excluded), apply:

```
zoom_scale = tan(hfov_current / 2) / tan(hfov_base / 2)     // "0 % monitor distance" match
```

Option **"Zoom sensitivity"**: `Match tan (default)` | `Match FOV ratio` | `None (1.0)`.
FOV kick from acceleration/boost must **NOT** feed `zoom_scale` - that would make sensitivity
wobble with the throttle, which feels broken. Only deliberate optical zoom feeds it.

### 12.6.2 Acceleration (default OFF)

When enabled:

```
v = counts_this_frame / dt              // counts per second
gain = 1 + accel_amount * pow(min(v / accel_threshold, 1e6), accel_power - 1)
gain = min(gain, accel_cap)
deg = counts * deg_per_count * gain
```

| Parameter         | Range      | Default (when accel ON) |
|-------------------|------------|--------------------------|
| `accel_amount`    | 0.0 .. 2.0 | 0.35                     |
| `accel_power`     | 1.0 .. 2.0 | 1.20                     |
| `accel_threshold` | 200 .. 6000 counts/s | 1400           |
| `accel_cap`       | 1.0 .. 4.0 | 2.00                     |

`dt` for this computation is clamped to `[1/240, 1/30]` so a hitched frame cannot produce a
spurious acceleration spike. Acceleration is disabled entirely in `VESSEL_*` Manual.

### 12.6.3 Smoothing

Default **0 %** (none). When non-zero, a one-Euro-style filter, NOT a naive EMA, so that slow
movement is smoothed but fast flicks are not:

```
alpha(f_c, dt) = 1 / (1 + 1/(2*PI*f_c*dt))
f_c = f_min + beta * |d_hat|            // d_hat = low-passed derivative of the raw delta
smoothed = alpha * raw + (1 - alpha) * smoothed_prev
```

| Parameter | Value at 100 % smoothing | At 0 %      |
|-----------|--------------------------|-------------|
| `f_min`   | 1.6 Hz                   | disabled    |
| `beta`    | 0.012                    | disabled    |

The slider interpolates `f_min` from 30 Hz (1 %) down to 1.6 Hz (100 %) logarithmically.
Maximum added latency at 100 % is 42 ms; the options screen shows the number.

Gamepad look uses a **separate**, always-on smoothing of `f_min = 12 Hz`, `beta = 0.02`,
because stick noise is real. This is not user-visible.

### 12.6.4 Look integration and clamps

```js
// applied once per rendered frame, post-sim
let dYaw   = counts_x * deg_per_count_x * DEG2RAD * (invert_x ? -1 : 1);
let dPitch = counts_y * deg_per_count_y * DEG2RAD * (invert_y ? -1 : 1) * -1; // screen Y is down
```

| Context                    | Pitch clamp        | Roll source                                            |
|----------------------------|--------------------|--------------------------------------------------------|
| `FOOT`                     | +/- 88.0 deg       | none (0)                                               |
| `SWIM_SURFACE`             | +/- 85.0 deg       | strafe lean, +/-2.5 deg, tau 0.35 s                    |
| `SWIM_SUB`                 | +/- 89.5 deg       | strafe lean +/-4.0 deg; **full-quaternion mode** below -80 deg pitch to avoid gimbal snap |
| `VESSEL_*` (cockpit view)  | none (vessel free) | vessel roll x `camera_roll_follow` (12.7.9)            |
| `FREE_LOOK`                | +/- 70 deg (vessel), +/-88 deg (foot) | -                                   |
| `PHOTO`                    | +/- 89.9 deg       | manual `CAM_ROLL`, +/-45 deg                           |

When the head pitch clamp is reached, further input in that direction is **discarded**, not
accumulated - releasing and re-pushing must not "unwind" stored input.

`SWIM_SUB` full-quaternion mode: when the player looks past 80 deg from horizontal, the head
orientation switches from (yaw, pitch) Euler to a free quaternion so that swimming
vertically and then turning does not cause a heading snap. Exiting the cone re-derives yaw
from the quaternion's forward vector projected onto the XZ plane, blended over 0.30 s.

### 12.6.5 Field of view

The UI slider is **horizontal FOV at 16:9**. Internally the renderer uses vertical FOV so the
game is **Hor+**: ultrawide monitors see more horizontally, never less vertically.

```js
const vfov = 2 * Math.atan( Math.tan(hfov16x9 / 2) / (16/9) );
const hfov_actual = 2 * Math.atan( Math.tan(vfov / 2) * (W / H) );
```

| Context / view          | Default hFOV | Min | Max | Notes                                         |
|-------------------------|--------------|-----|-----|-----------------------------------------------|
| `FOOT`                  | 90 deg       | 65  | 120 | user slider `fov_base`                        |
| `SWIM_SURFACE`          | `fov_base`   | -   | -   | same as foot                                  |
| `SWIM_SUB` (mask optics)| `fov_base` / 1.25 = 72 deg | - | - | option "Mask Optics", default ON |
| `VESSEL_*` cockpit      | `fov_base` - 12 = 78 deg | 60 | 110 | offset slider `fov_cockpit_offset`, -25..+10, default -12 |
| `VESSEL_*` chase        | `fov_base` - 4 = 86 deg  | -  | -   |                                               |
| `VESSEL_*` orbit        | `fov_base` = 90 deg      | -  | -   |                                               |
| Scanner zoom (foot)     | 32 deg       | -   | -   | 1-step optical zoom, 0.25 s ease              |
| Vessel telescope (HUD)  | 14 deg       | -   | -   | picture-in-picture on the windshield          |
| `PHOTO`                 | 60 deg       | 18  | 130 |                                               |

**Mask optics** models the flat-port magnification of a diving helmet: water/air refraction
gives ~1.33x apparent magnification. We use **1.25x** (tuned down for comfort) as a default,
with the option offering `Off (1.00)`, `Comfort (1.15)`, `Realistic (1.33)`. The corresponding
mask vignette (owned by section 09) is tied to the same setting. Transition when crossing the
waterline is a 0.28 s smoothstep on vFOV to avoid a snap.

### 12.6.6 FOV kick

FOV kick communicates acceleration without moving the horizon. It is additive on top of the
context FOV and is **excluded from sensitivity zoom scaling**.

```
target_kick = K_SPEED * max(0, (v - v_ref)) + K_ACCEL * clamp(a_fwd, 0, a_max) + KICK_BOOST * boostActive
kick += (target_kick - kick) * (1 - exp(-dt / tau))      // tau = tau_attack if rising else tau_release
hfov = hfov_ctx + clamp(kick, 0, kick_max)
```

| Context      | `K_SPEED` (deg per m/s) | `v_ref` (m/s) | `K_ACCEL` (deg per m/s^2) | `a_max` | `KICK_BOOST` | `kick_max` | `tau_attack` | `tau_release` |
|--------------|--------------------------|---------------|----------------------------|---------|--------------|------------|--------------|----------------|
| `FOOT` sprint| 0.90                     | 2.6           | 0.00                       | -       | 0.0          | 4.0 deg    | 0.22 s       | 0.35 s         |
| `SWIM_*`     | 1.30                     | 1.55          | 0.00                       | -       | 0.0          | 5.0 deg    | 0.30 s       | 0.45 s         |
| `VESSEL_AIR` | 0.34                     | 14.0          | 0.55                       | 12 m/s^2| 11.0 deg     | 22.0 deg   | 0.18 s       | 0.55 s         |
| `VESSEL_WATER`| 0.62                    | 5.0           | 0.80                       | 6 m/s^2 | 7.0 deg      | 14.0 deg   | 0.25 s       | 0.60 s         |

Option **"FOV kick"**: `Full (100 %)` | `Reduced (50 %)` | `Off (0 %)`. Default Full.
Reverse/braking produces a **negative** kick of at most -6 deg using `K_ACCEL` with negative
`a_fwd`, `tau_attack = 0.12 s` - this sells the airbrake hard.

### 12.6.7 View bob (foot and swim only)

| Parameter                 | Walk        | Sprint      | Swim (finned) |
|---------------------------|-------------|-------------|---------------|
| Vertical amplitude        | 22 mm       | 41 mm       | 34 mm         |
| Lateral amplitude         | 14 mm       | 26 mm       | 18 mm         |
| Roll amplitude            | 0.45 deg    | 0.90 deg    | 1.20 deg      |
| Step frequency            | 1.85 Hz     | 2.55 Hz     | 0.62 Hz       |
| Vertical:lateral phase    | 2:1 (figure-8) | 2:1      | 1:1 (sinusoidal glide) |
| Landing dip               | -0.085 m over 0.10 s, recover 0.26 s (critically damped) | scaled by impact speed / 7 m/s | n/a |

Bob is driven by an accumulated **distance phase**, not by time, so it stops instantly when
the player stops and never desynchronises from footstep audio. Option **"View bob"**:
0 .. 150 %, default **60 %**. At 0 % the landing dip is also disabled.

There is **no view bob in any vessel context**. Vessel motion comes from physics + shake only.

---

## 12.7 Camera shake

### 12.7.1 Model

All shake is a sum of independent generators, evaluated per frame into a single 6-DOF offset
(3 rotation, 3 translation) applied **after** the view matrix is composed from gameplay
orientation. Shake never affects aim, hit detection, or the vessel's actual attitude.

```js
// One generator, one axis:
//   A0   peak amplitude (rad for rotation, m for translation)
//   f0   base frequency (Hz)
//   tau  exponential decay time constant (s); 0 => sustained
//   t    seconds since generator start
function shakeAxis(gen, axis, t) {
  const env = gen.sustained ? gen.envelope(t) : Math.exp(-t / gen.tau);
  const W = [0.62, 0.27, 0.11];          // octave weights, sum 1.00
  const F = [1.00, 2.17, 4.61];          // irrational-ish ratios: no beating
  let s = 0;
  for (let k = 0; k < 3; k++) {
    s += W[k] * valueNoise1D(gen.f0 * F[k] * t + gen.phase[axis][k]);   // noise in [-1,1]
  }
  return gen.A0[axis] * env * s * globalShakeScale;
}
```

- `valueNoise1D` is cubic-Hermite-interpolated hash noise, period 1.0 in its argument. It is
  C1-continuous, so shake never has visible corners.
- `gen.phase[axis][k]` are fixed random offsets per generator instance (seeded per event) so
  two simultaneous identical events do not constructively double.
- Generators are additive with a **soft clip** on the total: if `|total_rot| > 6.0 deg`, apply
  `total *= 6.0 / |total_rot|`. Translation soft clip at 0.14 m.
- Maximum 12 concurrent generators; oldest low-priority generator is evicted.
- `globalShakeScale` = user option **"Camera shake"** 0 .. 150 %, default **100 %**.

### 12.7.2 Sustained generators (envelope-driven)

| Generator            | Condition                     | `A0` pitch/yaw/roll (deg) | `A0` xyz (mm) | `f0` (Hz) | Envelope                              |
|----------------------|-------------------------------|---------------------------|---------------|-----------|---------------------------------------|
| `THRUST_IDLE`        | vessel powered, throttle 0    | 0.05 / 0.04 / 0.03        | 1.2 / 1.6 / 1.0 | 11.0    | constant                              |
| `THRUST_CRUISE`      | air, throttle t in 0..1       | (0.06+0.22t) x (1/1/0.8)  | (2+7t) each   | 8.5 + 5t  | linear in throttle                    |
| `THRUST_WATER`       | water, throttle t             | (0.05+0.15t) x (1/1/0.7)  | (2+5t) each   | 5.5 + 3t  | linear in throttle                    |
| `BOOST_SUSTAIN`      | boost active                  | 0.40 / 0.34 / 0.26        | 9 / 12 / 8    | 15.0      | attack 0.12 s, release 0.30 s         |
| `AIRBRAKE_BUFFET`    | airbrake held, v > 12 m/s     | 0.55 / 0.42 / 0.30        | 5 / 8 / 5     | 13.5      | scales with (v/45)^2, clamp 1.0       |
| `HULL_STRESS`        | d > crush_depth * 0.85        | 0.10 / 0.08 / 0.06        | 3 / 3 / 3     | 2.2       | (d/crush - 0.85)/0.15, clamp 1.0; also drives creak audio |
| `TURBULENCE`         | air, altitude < 60 m over land| 0.18 / 0.14 / 0.22        | 6 / 9 / 6     | 1.6       | wind speed / 18 m/s                   |
| `CURRENT_SHEAR`      | inside a current volume       | 0.12 / 0.10 / 0.16        | 8 / 6 / 8     | 0.45      | current speed / 3.0 m/s               |
| `SURFACE_CHOP`       | `VESSEL_SURFACE`              | 0.9 / 0.35 / 1.4          | 40 / 90 / 40  | 0.55      | wave height / 1.4 m; this is deliberately large - floating is uncomfortable |
| `LOW_O2_PULSE`       | player O2 < 20 s              | 0.22 / 0.10 / 0.14        | 4 / 6 / 4     | 1.05      | (20 - o2)/20; synced to heartbeat SFX |

### 12.7.3 Impulse generators (exponential decay)

| Event                        | `A0` pitch/yaw/roll (deg) | `A0` xyz (mm) | `f0` (Hz) | `tau` (s) | Priority |
|------------------------------|---------------------------|---------------|-----------|-----------|----------|
| `FOOTSTEP` (sprint only)     | 0.09 / 0.03 / 0.06        | 2 / 3 / 1     | 14.0      | 0.09      | 0        |
| `LAND_SOFT` (< 4 m/s)        | 0.5 / 0.15 / 0.3          | 6 / 14 / 4    | 9.0       | 0.18      | 1        |
| `LAND_HARD` (>= 7 m/s)       | 1.6 / 0.5 / 1.1           | 14 / 40 / 10  | 7.5       | 0.42      | 2        |
| `HULL_SCRAPE`                | 0.35 / 0.30 / 0.45        | 8 / 6 / 8     | 22.0      | 0.15 (retrigger 20 Hz while scraping) | 1 |
| `COLLIDE_LIGHT` (< 4 m/s)    | 0.8 / 0.6 / 0.9           | 12 / 10 / 12  | 12.0      | 0.30      | 2        |
| `COLLIDE_MED` (4..10 m/s)    | 2.1 / 1.6 / 2.4           | 34 / 28 / 34  | 9.5       | 0.55      | 3        |
| `COLLIDE_HEAVY` (> 10 m/s)   | 4.4 / 3.2 / 5.0           | 70 / 60 / 70  | 7.0       | 0.95      | 4        |
| `CREATURE_BUMP` (small)      | 0.9 / 0.8 / 1.0           | 16 / 12 / 16  | 10.5      | 0.35      | 2        |
| `CREATURE_STRIKE` (large)    | 3.6 / 3.0 / 4.2           | 60 / 50 / 60  | 6.5       | 1.10      | 4        |
| `CREATURE_GRAB` (leviathan)  | 5.5 / 4.5 / 6.5           | 95 / 80 / 95  | 4.0       | sustained for grab duration, then 0.9 s decay | 5 |
| `DAMAGE_PLAYER`              | 1.2 / 0.9 / 1.4           | 10 / 10 / 10  | 11.0      | 0.28      | 3        |
| `DAMAGE_VESSEL_MINOR`        | 0.9 / 0.7 / 1.1           | 18 / 16 / 18  | 13.0      | 0.32      | 3        |
| `DAMAGE_VESSEL_MAJOR`        | 2.8 / 2.2 / 3.4           | 45 / 40 / 45  | 8.0       | 0.75      | 4        |
| `HULL_BREACH`                | 3.2 / 2.6 / 3.8           | 55 / 48 / 55  | 5.5       | 1.40      | 5        |
| `EMERGENCY_BLOW_START`       | 1.4 / 0.5 / 0.9           | 20 / 55 / 20  | 6.0       | 0.80      | 3        |
| `SURFACE_BREACH` (water->air)| 1.1 / 0.4 / 0.8           | 22 / 48 / 22  | 5.0       | 0.60      | 2        |
| `WATER_ENTRY` (air->water)   | 1.5 / 0.6 / 1.0           | 26 / 55 / 26  | 6.5       | 0.70      | 3        |
| `DRILL_CONTACT` (per 0.1 s)  | 0.30 / 0.22 / 0.26        | 4 / 5 / 4     | 26.0      | 0.12      | 1        |
| `ORE_FRACTURE`               | 0.7 / 0.5 / 0.6           | 9 / 12 / 9    | 10.0      | 0.30      | 2        |
| `SONAR_PING` (self)          | 0.06 / 0.04 / 0.05        | 2 / 2 / 2     | 3.2       | 0.45      | 0        |

Collision amplitudes scale with `min(1, impactSpeed / referenceSpeed)` within their band and
additionally by `min(1, impulse / 40 kN*s)` so a glancing blow is not the same as a head-on.

### 12.7.4 Leviathan roar (special case)

The roar is the game's signature dread beat and gets a bespoke, two-band generator plus
non-shake effects. Distance `D` in metres from the source, `g(D) = 1 / (1 + D/60)`.

| Band | `A0` pitch/yaw/roll (deg)     | `A0` xyz (mm)   | `f0` (Hz) | Envelope                                      |
|------|-------------------------------|-----------------|-----------|-----------------------------------------------|
| Sub  | 0.90 / 0.70 / 1.05 x g(D)     | 18 / 22 / 18 x g| 0.85      | attack 0.18 s, sustain 1.05 s, release 0.55 s |
| Body | 0.34 / 0.26 / 0.40 x g(D)     | 6 / 8 / 6 x g   | 3.20      | attack 0.06 s, sustain 0.90 s, release 0.40 s |

Additional, non-shake, gated by comfort options:

| Effect                        | Value                                              | Disabled by                    |
|-------------------------------|----------------------------------------------------|--------------------------------|
| HUD glitch (windshield)       | 0.35 s of scanline tear + 6 % chromatic offset     | "Screen effects: Reduced/Off"  |
| Interior light flicker        | 3 dips to 30 % over 0.9 s                          | -                              |
| FOV pulse                     | +3.0 deg over 0.12 s, release 0.6 s                | "FOV kick: Off"                |
| Rumble                        | see 12.9.6                                         | rumble intensity 0             |
| Low-pass on all other audio   | 900 Hz for 0.8 s                                   | -                              |
| Compass needle scatter        | +/-18 deg noise for 0.6 s (magnetic disturbance)   | -                              |

At `D > 220 m` only the Sub band plays, at 45 % amplitude - the point is that you feel it
before you can see anything.

### 12.7.5 Recoil / tool kick (rotational, deterministic)

Tools use a **deterministic recoil** (not shake) so aim remains learnable: an instantaneous
pitch-up of `R_p` deg and yaw of `R_y` deg (alternating sign, seeded pattern), recovered by a
critically damped spring `omega_n = 14 rad/s`, returning 92 % of the kick.

| Tool             | `R_p` (deg) | `R_y` (deg) | Rate limit |
|------------------|-------------|-------------|------------|
| Survey pinger    | 0.15        | 0.05        | 1.0 Hz     |
| Cutter (contact) | 0.05        | 0.04        | continuous |
| Drill (contact)  | 0.10        | 0.08        | continuous |
| Repulsion pulse  | 1.30        | 0.40        | 0.5 Hz     |
| Sample harpoon   | 0.85        | 0.30        | 0.8 Hz     |

### 12.7.6 Head/cockpit inertia ("neck spring")

The camera lags the rig by a critically damped spring so that hard vessel manoeuvres are felt.

| Context        | Rot. `omega_n` | Rot. zeta | Max lag | Trans. `omega_n` | Trans. zeta | Max trans lag |
|----------------|----------------|-----------|---------|------------------|-------------|---------------|
| `FOOT`         | 26 rad/s       | 1.00      | 1.2 deg | 30 rad/s         | 1.00        | 12 mm         |
| `SWIM_*`       | 16 rad/s       | 0.95      | 3.0 deg | 20 rad/s         | 0.95        | 25 mm         |
| Vessel cockpit | 11 rad/s       | 0.88      | 5.5 deg | 14 rad/s         | 0.90        | 55 mm         |
| Vessel chase   | 6 rad/s        | 0.80      | 9.0 deg | 7 rad/s          | 0.82        | 300 mm        |

The neck spring is driven by the **rig's angular acceleration**, not velocity, so steady turns
do not accumulate lag. Comfort option **"Camera inertia"**: 0 .. 100 %, default **80 %**.

### 12.7.7 Death camera

On player death: input locked for 2.5 s; camera detaches, pitch rolls to +32 deg over 1.8 s
(ease-out cubic), drifts 1.4 m backward and 0.6 m up, FOV widens by +14 deg over 2.2 s,
desaturation to 15 % over 1.6 s, all shake generators killed except a 0.30 deg / 0.8 Hz
sustained drift. If death occurred underwater, add a slow 6 deg/s roll about forward.

### 12.7.8 Motion-sickness / comfort options (full list)

| Option                     | Values                                | Default | Effect                                                          |
|----------------------------|---------------------------------------|---------|-----------------------------------------------------------------|
| `Camera shake`             | 0 .. 150 %                            | 100 %   | scales `globalShakeScale`                                       |
| `View bob`                 | 0 .. 150 %                            | 60 %    | 12.6.7; 0 also kills landing dip                                |
| `FOV kick`                 | Full / Reduced / Off                  | Full    | 12.6.6                                                          |
| `Camera inertia`           | 0 .. 100 %                            | 80 %    | 12.7.6                                                          |
| `Camera roll follow`       | 0 .. 100 %                            | 100 %   | 12.7.9; 0 = artificial horizon lock in vessel                   |
| `Auto-roll on turn`        | On / Off                              | On      | Assisted bank-to-turn visual roll only (physics unaffected)     |
| `Mask optics`              | Off / Comfort / Realistic             | Comfort | 12.6.5                                                          |
| `Motion vignette`          | Off / Subtle / Strong                 | Off     | radial darkening proportional to speed + angular rate; Subtle = 12 % at 20 m/s, Strong = 28 % |
| `Static reference frame`   | Off / Cockpit frame / Frame + horizon | Cockpit frame | draws a fixed-in-screen-space cockpit surround / artificial horizon rail |
| `Screen effects`           | Full / Reduced / Off                  | Full    | scales chromatic aberration, glitch, water droplets, blood-in-water |
| `Depth of field`           | On / Off                              | On      | some players find DOF nauseating                                |
| `Motion blur`              | Off / Camera only / Full              | Off     | **default Off** - per-object blur is a common trigger           |
| `Water surface distortion` | Full / Reduced / Off                  | Full    | Reduced halves the refraction wobble amplitude                  |
| `Transition fades`         | On / Off                              | On      | 0.15 s black dip on vessel enter/exit instead of a swept camera |
| `Comfort preset`           | Default / Sensitive / Maximum comfort | Default | one-click bundle, table below                                   |

**Comfort presets**

| Setting            | Default | Sensitive | Maximum comfort         |
|--------------------|---------|-----------|-------------------------|
| Camera shake       | 100 %   | 45 %      | 0 %                     |
| View bob           | 60 %    | 25 %      | 0 %                     |
| FOV kick           | Full    | Reduced   | Off                     |
| Camera inertia     | 80 %    | 40 %      | 0 %                     |
| Camera roll follow | 100 %   | 55 %      | 0 %                     |
| Auto-roll on turn  | On      | Off       | Off                     |
| Mask optics        | Comfort | Comfort   | Off                     |
| Motion vignette    | Off     | Subtle    | Strong                  |
| Static ref. frame  | Cockpit | Cockpit   | Frame + horizon         |
| Motion blur        | Off     | Off       | Off                     |
| Depth of field     | On      | On        | Off                     |
| Transition fades   | On      | On        | On                      |
| FOV base           | 90 deg  | 100 deg   | 105 deg                 |

### 12.7.9 Camera roll follow

In vessel cockpit view, the camera's roll = `vessel_roll * camera_roll_follow`. At 0 % the
cockpit geometry rolls around a level camera, which reads as "gimballed seat" and is extremely
comfortable. At 100 % the world rolls, which is the intended default. Values between blend
linearly; the cockpit mesh is always drawn in vessel space, so the seat, canopy frame and
instruments remain fixed relative to the hull regardless of the setting - only the horizon
moves. This is the cheapest and most effective sickness mitigation available and must ship.

---

## 12.8 Vessel control schemes

### 12.8.1 Reference vessel parameters (assumed; owned by section 04)

These values are **assumptions** that the gains below are tuned against. If section 04
disagrees, gains must be re-derived by the stated formulas, not by hand-tweaking.

| Symbol        | Value            | Meaning                                        |
|---------------|------------------|------------------------------------------------|
| `m_dry`       | 2400 kg          | vessel mass, ballast empty                     |
| `V_hull`      | 4.60 m^3         | displaced volume, fully submerged              |
| `V_ballast`   | 2.40 m^3         | ballast tank capacity                          |
| `rho_sw`      | 1025 kg/m^3      | seawater density (surface)                     |
| `m_neutral`   | 4715 kg          | `rho_sw * V_hull`                              |
| `I_roll`      | 3.1e3 kg*m^2     | about forward axis                             |
| `I_pitch`     | 9.4e3 kg*m^2     | about starboard axis                           |
| `I_yaw`       | 10.2e3 kg*m^2    | about up axis                                  |
| `tau_roll_max`| 28.0 kN*m        | -> `alpha_roll_max`  = 9.03 rad/s^2            |
| `tau_pitch_max`| 42.0 kN*m       | -> `alpha_pitch_max` = 4.47 rad/s^2            |
| `tau_yaw_max` | 34.0 kN*m        | -> `alpha_yaw_max`   = 3.33 rad/s^2            |
| `F_main_max`  | 96 kN (air), 62 kN (water) | main thrust                          |
| `F_vert_max`  | 54 kN (air), 30 kN (water) | vertical thrusters                   |
| `F_lat_max`   | 18 kN (air), 12 kN (water) | lateral thrusters                    |
| `v_max_air`   | 82 m/s           | level flight, 100 % throttle, no boost         |
| `v_max_water` | 14.5 m/s         | level, 100 % throttle                          |
| `ballast_rate_fill` | 0.55 m^3/s | flood rate                                     |
| `ballast_rate_blow` | 0.42 m^3/s at d=0, scaled by `1/(1 + d/180)` | pump works against pressure |

All controller outputs are **normalised commands** `u in [-1, 1]` multiplied by the relevant
max torque/force. This keeps the gains meaningful even if section 04 retunes absolute values.

### 12.8.2 Assist matrix

| Assist                       | Assisted | Manual | Custom | Description                                            |
|------------------------------|----------|--------|--------|--------------------------------------------------------|
| `A_AUTO_LEVEL_ROLL`          | ON       | OFF    | user   | roll -> 0 (or bank target) when no roll input          |
| `A_AUTO_LEVEL_PITCH`         | ON       | OFF    | user   | pitch -> 0 when no pitch input and speed > 6 m/s (air) |
| `A_MOUSE_AIM`                | ON       | OFF    | user   | virtual reticle + attitude tracking (12.8.3)           |
| `A_BANK_TO_TURN`             | ON (air) | OFF    | user   | coordinated banked turns                               |
| `A_SPEED_SETPOINT`           | ON       | OFF    | user   | throttle commands speed, not thrust                    |
| `A_AUTO_TRIM_BALLAST`        | ON       | OFF    | user   | ballast servo nulls steady vertical thrust             |
| `A_HOVER_ON_IDLE`            | ON       | OFF    | user   | auto station-keep when idle < 0.5 m/s                  |
| `A_GEAR_AUTO`                | ON       | OFF    | user   | skids deploy below 6 m AGL                             |
| `A_COLLISION_SOFTSTOP`       | ON       | OFF    | user   | throttle taper when time-to-contact < 1.2 s            |
| `A_TERRAIN_FLOOR`            | ON       | OFF    | user   | 3 m soft floor above seabed via vertical thrusters     |
| `A_YAW_DAMP`                 | ON       | ON     | user   | pure rate damping; kept in Manual because it is physical (fins) |
| `A_PITCH_LIMIT`              | ON (85 deg)| OFF  | user   | attitude envelope limit                                |
| `A_GYRO_STABILISE`           | ON       | 25 %   | user   | reaction-wheel damping vs. turbulence/currents         |

The scheme selector is a single option **"Vessel handling"**: `Assisted` | `Manual` | `Custom`.
Selecting Custom copies the current scheme's values and unlocks the 13 switches above.
The scheme also changes bindings (12.3.4 vs 12.3.5) - this must be shown in the rebind screen
as two separate binding profiles.

### 12.8.3 Mouse-aim flight (Assisted)

Mouse deltas move a **virtual reticle** in the vessel's body-fixed angular space rather than
directly commanding torque.

```
// per frame
retYaw   += dxCounts * degPerCount_x * ctxScale       // radians after conversion
retPitch += dyCounts * degPerCount_y * ctxScale
// clamp to a cone
r = hypot(retYaw, retPitch)
if (r > R_MAX) { retYaw *= R_MAX/r; retPitch *= R_MAX/r; }
// recentring when idle
if (idleTime > RET_IDLE) { k = exp(-dt / RET_TAU); retYaw *= k; retPitch *= k; }
// rate command toward the reticle
q_cmd = clamp(K_AIM * retPitch, -Q_MAX, +Q_MAX)      // pitch rate command
r_cmd = clamp(K_AIM * retYaw,   -R_MAX_RATE, +R_MAX_RATE)
```

| Parameter    | `VESSEL_AIR` | `VESSEL_WATER` | Notes                                        |
|--------------|--------------|----------------|----------------------------------------------|
| `R_MAX`      | 22.0 deg     | 16.0 deg       | reticle cone half-angle                      |
| `RET_IDLE`   | 0.25 s       | 0.25 s         | idle before recentring starts                |
| `RET_TAU`    | 0.90 s       | 1.20 s         | recentring time constant                     |
| `K_AIM`      | 3.2 1/s      | 2.4 1/s        | rate command per radian of reticle offset    |
| `Q_MAX` (pitch rate) | 70 deg/s | 34 deg/s     |                                              |
| `R_MAX_RATE` (yaw)   | 55 deg/s | 26 deg/s     |                                              |
| Reticle recentring option | ON  | ON             | "Reticle auto-centre", user can disable      |

The reticle is drawn on the windshield as a hollow 18 px circle with a 3 px boresight cross;
when `r > 0.85 * R_MAX` it turns amber and a small "AUTHORITY LIMIT" caret appears
(section 09 owns the visuals; this section owns the trigger thresholds).

### 12.8.4 Inner-loop attitude controllers

All three axes use the same PD-with-filtered-D form, outputting a normalised command:

```
e      = target - measured                     // angle error (rad) or rate error (rad/s)
d_raw  = (rate mode) ? 0 : measured_rate
d_lpf += (d_raw - d_lpf) * (1 - exp(-dt / (1/(2*PI*F_D))))
u      = (Kp * e - Kd * d_lpf) / alpha_max     // normalise by max angular accel
u      = clamp(u, -1, +1)
```

**Attitude-hold (angle) mode** - used by auto-level, `LEVEL_NOW`, hover:

| Axis  | `omega_n` (rad/s) | `zeta` | `Kp = omega_n^2` (1/s^2) | `Kd = 2*zeta*omega_n` (1/s) | `F_D` (Hz) | `alpha_max` (rad/s^2) |
|-------|-------------------|--------|--------------------------|------------------------------|------------|------------------------|
| Roll (air)   | 3.00       | 0.90   | 9.00                     | 5.40                         | 22         | 9.03                   |
| Pitch (air)  | 2.20       | 0.90   | 4.84                     | 3.96                         | 22         | 4.47                   |
| Yaw (air)    | 1.60       | 1.00   | 2.56                     | 3.20                         | 18         | 3.33                   |
| Roll (water) | 1.70       | 1.00   | 2.89                     | 3.40                         | 12         | 9.03 x 0.55 = 4.97     |
| Pitch (water)| 1.30       | 1.00   | 1.69                     | 2.60                         | 12         | 4.47 x 0.55 = 2.46     |
| Yaw (water)  | 0.95       | 1.10   | 0.90                     | 2.09                         | 10         | 3.33 x 0.55 = 1.83     |

Water `alpha_max` is scaled by 0.55 to account for hydrodynamic added mass and damping.

**Rate-command mode** - used by mouse-aim (12.8.3) and by gamepad look:

| Axis  | `Kp_rate` (1/s) | Feed-forward | Integrator |
|-------|-----------------|--------------|------------|
| Pitch | 5.5             | `q_cmd / alpha_max * 0.35` | none |
| Yaw   | 4.0             | `r_cmd / alpha_max * 0.35` | none |
| Roll  | 7.0             | `p_cmd / alpha_max * 0.45` | none |

No integrator on attitude axes: steady-state attitude error is corrected by the outer
auto-level loop or by trim, never by a windup-prone integrator on a torque command.

### 12.8.5 Bank-to-turn (Assisted, air only)

```
// Coordinated turn: the bank angle that makes the horizontal lift component
// supply the required centripetal acceleration.
phi_cmd = atan2(r_cmd * v_horiz, G)                 // G = 9.81 m/s^2
phi_cmd = clamp(phi_cmd, -PHI_MAX, +PHI_MAX)
phi_cmd *= smoothstep(V_BANK_LO, V_BANK_HI, v_horiz) // no banking while hovering
phi_cmd += manual_roll_input * PHI_MANUAL            // player roll adds on top
```

| Parameter    | Value    |
|--------------|----------|
| `PHI_MAX`    | 60 deg   |
| `V_BANK_LO`  | 6 m/s    |
| `V_BANK_HI`  | 18 m/s   |
| `PHI_MANUAL` | 75 deg   |
| Water equivalent | banking disabled; instead a 0.25-weight visual-only roll of up to 12 deg is applied to the **camera** (not the hull) when `Auto-roll on turn` is ON |

When `manual_roll_input != 0`, auto-level roll is suspended and resumes 0.60 s after release
with a 0.35 s ramp of `Kp` from 0 to full, so the hull does not snap level.

### 12.8.6 Altitude hold / depth hold (cascade)

```
// Outer loop: position error -> vertical velocity setpoint
vz_sp = clamp(KP_POS * (y_target - y), -VZ_MAX, +VZ_MAX)
// Inner loop: velocity error -> normalised vertical force command
e_v    = vz_sp - vz
I     += e_v * dt;  I = clamp(I, -I_MAX, +I_MAX)          // trapezoidal, clamped
u_vert = clamp(KP_V * e_v + KI_V * I - KD_V * az_lpf, -1, +1)
if (u_vert is saturated and sign(e_v) == sign(u_vert)) I -= e_v * dt   // back-calc anti-windup
```

| Mode                | `KP_POS` (1/s) | `VZ_MAX` (m/s) | `KP_V` | `KI_V` (1/s) | `KD_V` (s) | `I_MAX` | Notes                     |
|---------------------|----------------|----------------|--------|--------------|------------|---------|---------------------------|
| Altitude hold (air) | 0.55           | 6.0            | 0.90   | 0.35         | 0.06       | 2.9     | reference is barometric y |
| AGL hold (air, low) | 0.85           | 4.0            | 1.10   | 0.40         | 0.06       | 2.5     | engaged below 40 m AGL; ray-cast ground, 5-sample median filter |
| Depth hold (water)  | 0.40           | 3.0            | 1.10   | 0.45         | 0.10       | 2.2     | vertical thrusters only   |
| Hover (air)         | 0.90           | 2.0            | 1.30   | 0.55         | 0.08       | 1.8     | plus horizontal station-keep |
| Hover (water)       | 0.70           | 1.2            | 1.40   | 0.60         | 0.12       | 1.6     | fights current            |

**Disengagement.** Altitude/depth hold disengages immediately and silently when the player
gives any vertical input (`CLIMB`/`DESCEND`/`ASCEND`/`VTHRUST_*`) for more than 0.10 s, when
ballast is manually operated, when the vessel collides, or when `|pitch| > 55 deg`. It
re-engages **only** on an explicit re-press. On disengage, play a 2-tone descending chirp
(-14 dB, 0.18 s) and flash the HUD annunciator.

**Target capture.** On engage, `y_target = y + vz * 0.45` (lead by half a second) so engaging
while drifting does not yank the vessel backwards.

### 12.8.7 Auto-trim ballast (Assisted only)

Ballast is a slow, near-lossless actuator; vertical thrusters are fast and expensive. The
auto-trim servo moves ballast to null the **steady-state** vertical thruster command.

```
u_vert_slow += (u_vert - u_vert_slow) * (1 - exp(-dt / TAU_TRIM))
if (abs(u_vert_slow) > TRIM_DEADBAND && !manualBallast && depth > 1.0) {
   ballast_cmd = -sign(u_vert_slow) * min(1, (abs(u_vert_slow) - TRIM_DEADBAND) / TRIM_SPAN)
   // +ve ballast_cmd = fill (heavier); u_vert_slow > 0 means thrusters pushing UP => blow
} else ballast_cmd = 0
```

| Parameter        | Value  | Meaning                                                     |
|------------------|--------|-------------------------------------------------------------|
| `TAU_TRIM`       | 8.0 s  | very slow - trim must not chase transients                  |
| `TRIM_DEADBAND`  | 0.08   | 8 % of vertical authority tolerated indefinitely            |
| `TRIM_SPAN`      | 0.30   | full ballast rate at 38 % vertical command                  |
| Pump power draw  | 3.2 kW fill, 5.8 kW blow at d=0, +0.9 kW per 100 m depth    |
| Audible cue      | pump whine at -22 dB, pitch 180 Hz + 40 Hz per 10 % rate    |

Auto-trim is suspended for 2.0 s after any manual ballast input and for 1.5 s after a
depth-hold engage (to let the fast loop settle first).

Additionally, a **buoyancy readout** on the windshield shows net buoyancy in kN with a
+/- 30 kN bar and a green "NEUTRAL" band at +/- 1.5 kN. In Manual this is the player's
primary depth-keeping instrument and it must be legible at a glance.

### 12.8.8 Speed setpoint vs. thrust lever

| | Assisted (`A_SPEED_SETPOINT` ON) | Manual |
|---|---|---|
| Throttle meaning | commanded speed `v_sp = throttle * v_max_ctx` | commanded thrust fraction |
| Controller | PI on speed error: `Kp = 0.45 s/m` normalised, `Ki = 0.18 (s*m)^-1`, `I_MAX = 0.8` | none |
| Reverse | `throttle in [-0.30, 1.00]` (air), `[-0.40, 1.00]` (water) | same range, direct |
| Zero-throttle behaviour | active braking to 0 m/s at up to 0.5 of `F_main_max` | coast; drag only |
| Boost | multiplies `v_sp` cap by 1.9 (air) / 1.55 (water) | multiplies thrust by same |
| Cruise memory | throttle setpoint persists across context changes, rescaled by `v_max` ratio | lever position persists absolutely |

In Assisted, releasing all throttle input holds the current setpoint (it is a setpoint, not a
spring). In Manual, releasing throttle input holds the lever position. Neither decays.
Both display as a 0..100 % bar with a reverse notch.

### 12.8.9 Soft-stop and terrain floor (Assisted)

```
// Collision soft-stop: 9 forward rays in a 26 deg cone, 120 m max
ttc = min over rays of (dist / max(0.1, closing_speed))
if (ttc < TTC_WARN) throttleScale = smoothstep(TTC_STOP, TTC_WARN, ttc)
```

| Parameter    | Air     | Water   |
|--------------|---------|---------|
| `TTC_WARN`   | 1.20 s  | 1.60 s  |
| `TTC_STOP`   | 0.45 s  | 0.60 s  |
| Min throttle scale | 0.10 | 0.05  |
| Ray count / cone | 9 / 26 deg | 13 / 34 deg |
| HUD cue      | proximity arc + 2-tone alert at 4 Hz | same, plus sonar shading |

Terrain floor: below 3.0 m clearance to the seabed, add `u_vert += smoothstep(3.0, 0.8, clr) * 0.55`
so the vessel does not plough the bottom while the player looks at the scanner. Disabled in
Manual, and disabled entirely when `GEAR` is deployed (so you can actually land).

### 12.8.10 Manual scheme specifics

- Mouse commands **moment**, scaled: `u_pitch = clamp(dyCounts * degPerCount * MANUAL_GAIN_P, -1, 1)`
  accumulated into a first-order held command with `tau_release = 0.18 s` (so the surface does
  not slam back to neutral). `MANUAL_GAIN_P = 0.055 /deg`, `MANUAL_GAIN_Y = 0.045 /deg`.
- Only `A_YAW_DAMP` (rate damping, `Kd = 0.9 / alpha_yaw_max`) and 25 % `A_GYRO_STABILISE`
  remain - both justified as physical hardware (fins, reaction wheels), not as pilot aids.
- Ballast is the **only** way to hold depth without burning power. A Manual player who leaves
  ballast wrong will slowly sink or rise; that is the intended tension.
- Manual grants a **+12 % top speed** and **+18 % angular rate** bonus (control surfaces are
  not being fought by assists) and **-15 % power draw**. This makes Manual a real choice
  rather than a hair-shirt.
- Manual disables the reticle entirely; the windshield shows a flight-path-vector (velocity
  vector) marker and a boresight cross instead.

### 12.8.11 Scheme switching

Handling scheme can be changed at any time from the pause menu **or** by `Shift+KeyH`
(rebindable, default bound). On switch:

1. Freeze commanded attitude at current attitude.
2. Cross-fade assist authority over **0.8 s** (linear on all assist gains).
3. Convert throttle: Assisted->Manual sets lever = `current_speed / v_max`;
   Manual->Assisted sets setpoint = `current_speed`.
4. Convert ballast: Assisted->Manual leaves ballast where it is (auto-trim just stops);
   Manual->Assisted starts auto-trim after a 2.0 s settle.
5. HUD prints `HANDLING: MANUAL` / `HANDLING: ASSISTED` for 2.5 s.

---

## 12.9 Gamepad

### 12.9.1 Detection and lifecycle

- Chrome exposes gamepads only **after a user gesture** on the page. The `BOOT` splash must
  therefore also display "or press any button on your controller" and poll
  `navigator.getGamepads()` after the first gesture.
- `navigator.getGamepads()` returns a **fresh snapshot array** and MUST be called every frame;
  cached `Gamepad` objects are stale in Chrome.
- Handle `gamepadconnected` / `gamepaddisconnected`. On disconnect while in a gameplay
  context: push `SOFT_PAUSE`, release all inputs, show "CONTROLLER DISCONNECTED".
- Only `mapping === "standard"` devices get the default map. Non-standard devices land in a
  "Raw device" rebinding screen listing axes/buttons by index with live values.
- **Active device detection**: whichever device produced input most recently (with a 0.12
  threshold for analogue, any edge for digital) owns the on-screen glyph set. Switching is
  instantaneous but glyph-set changes are debounced by 0.35 s to avoid flicker.
- Glyph set inferred from `gamepad.id`: contains `054c` or `DualSense`/`DualShock` -> PlayStation;
  `057e` or `Pro Controller` -> Nintendo; `Xbox`/`045e`/anything else -> Xbox. Player-overridable.

### 12.9.2 Dead zones

Sticks use **scaled radial** dead zones (never per-axis), so diagonals are not clipped:

```js
function stickVector(x, y, dzIn, dzOut) {
  let r = Math.hypot(x, y);
  if (r <= dzIn) return [0, 0];
  const s = Math.min(1, (r - dzIn) / (dzOut - dzIn)) / r;
  return [x * s, y * s];
}
```

| Control        | Inner DZ | Outer DZ | User range        |
|----------------|----------|----------|-------------------|
| Left stick     | 0.14     | 0.95     | 0.02 .. 0.40      |
| Right stick    | 0.10     | 0.95     | 0.02 .. 0.40      |
| Triggers       | 0.06     | 0.94     | 0.02 .. 0.30      |
| Digital-from-analog threshold | 0.55 press / 0.40 release (hysteresis) | - | - |

An in-options **stick visualiser** draws the live raw and post-deadzone vectors plus a
30-second drift trace, and a "Calibrate: leave sticks centred for 3 s" button that measures
the resting offset and the noise radius and suggests an inner dead zone of
`max(0.05, restNoiseRadius * 1.6 + restOffset)`.

### 12.9.3 Response curves

```js
// r in [0,1] after dead zone; gamma > 1 = finer control near centre
const shaped = Math.pow(r, gamma);
// optional S-curve blend for look:
const s = (1 - blend) * shaped + blend * (r * r * (3 - 2 * r));
```

| Use              | `gamma` default | Range     | `blend` | Notes                                     |
|------------------|-----------------|-----------|---------|-------------------------------------------|
| Movement (LS)    | 1.00            | 1.0 .. 2.0| 0.00    | linear feels correct for locomotion       |
| Look (RS), foot  | 1.80            | 1.0 .. 3.0| 0.20    |                                           |
| Look (RS), vessel Assisted | 1.60  | 1.0 .. 3.0| 0.25    | drives reticle                            |
| Look (RS), vessel Manual   | 2.20  | 1.0 .. 3.0| 0.10    | direct moment: needs a big fine zone      |
| Triggers         | 1.30            | 1.0 .. 2.5| 0.00    | throttle                                  |

### 12.9.4 Look rates and ramp

Stick look is **rate-based**: `dYaw = shaped_x * maxRate * sensMul * dt`.

| Context                | Max yaw rate | Max pitch rate | Ramp time to max | Ramp curve |
|------------------------|--------------|----------------|------------------|------------|
| `FOOT`                 | 190 deg/s    | 140 deg/s      | 0.28 s           | ease-in quad |
| `SWIM_*`               | 150 deg/s    | 130 deg/s      | 0.35 s           | ease-in quad |
| `VESSEL_*` (reticle)   | 105 deg/s    | 105 deg/s      | 0.22 s           | linear     |
| `FREE_LOOK`            | 210 deg/s    | 160 deg/s      | 0.20 s           | linear     |
| `PHOTO`                | 90 deg/s     | 70 deg/s       | 0.40 s           | ease-in cubic |

"Ramp" (a.k.a. turn acceleration) applies only while the stick is held **beyond 0.92
magnitude**; below that the rate is instantaneous from the curve. Option
**"Look acceleration"** 0 .. 200 %, default 100 %; at 0 % the ramp is disabled.

Separate sliders: `pad_sens_x` and `pad_sens_y`, 0.20 .. 3.00, default 1.00, applied as
`sensMul`. Separate `pad_invert_y` (default OFF) and `pad_invert_y_vessel` (default OFF).

### 12.9.5 Interaction magnetism (gamepad only)

Because a stick cannot pixel-hunt, the interaction ray gets a soft assist: candidate
interactables within a **4.5 deg** cone (foot) / **3.0 deg** (vessel docking) of the boresight
and within range are selected by lowest angular distance; while a candidate is selected, look
rate is scaled by **0.82** within 2.0 deg of it (a gentle "sticky" effect). This never applies
to mouse input and never applies to any offensive tool.

### 12.9.6 Rumble

Chrome supports `gamepad.vibrationActuator.playEffect(type, params)` with
`type = "dual-rumble"` (`startDelay`, `duration`, `weakMagnitude`, `strongMagnitude`) and,
on supporting Xbox pads, `"trigger-rumble"` (adds `leftTrigger`, `rightTrigger`).

Rules:
- All magnitudes below are multiplied by the option **"Rumble"** 0 .. 150 %, default 100 %.
  Additionally **"Trigger rumble"** On/Off, default On (falls back to dual-rumble if absent).
- Only **one** dual-rumble effect can play at a time per pad; the implementation maintains a
  priority queue and composites overlapping requests by taking `max()` of magnitudes and
  extending duration, re-issuing `playEffect` at most every 60 ms.
- `duration` is capped at 5000 ms per call; sustained effects are re-issued in 250 ms chunks.
- Call `vibrationActuator.reset()` on: pointer lock loss, tab hidden, pause, death, context
  pop to any UI context, and gamepad disconnect.
- `playEffect` requires user activation and a visible page; wrap in try/catch and ignore
  rejections silently (never log-spam).

| Event                     | Duration | `strongMagnitude` | `weakMagnitude` | Trigger L/R | Notes                        |
|---------------------------|----------|-------------------|-----------------|-------------|------------------------------|
| UI move                   | 12 ms    | 0.00              | 0.10            | -           | only if "UI rumble" ON (default OFF) |
| UI confirm                | 25 ms    | 0.00              | 0.18            | -           |                              |
| Footstep (sprint)         | 18 ms    | 0.06              | 0.02            | -           |                              |
| Land hard                 | 140 ms   | 0.45              | 0.20            | -           | scaled by speed/7            |
| Tool drill (loop)         | 250 ms x N| 0.10             | 0.35            | 0.25 / 0.25 | while contacting             |
| Ore fracture              | 120 ms   | 0.30              | 0.45            | -           |                              |
| Scanner lock              | 60 ms    | 0.00              | 0.22            | -           | 2 pulses 90 ms apart         |
| Vessel engine idle        | continuous| 0.04             | 0.02            | -           | only if "Engine rumble" ON (default ON) |
| Vessel throttle (t)       | continuous| 0.04 + 0.16t     | 0.02 + 0.10t    | 0 / 0.20t   |                              |
| Boost start               | 220 ms   | 0.55              | 0.35            | 0 / 0.60    |                              |
| Airbrake                  | continuous| 0.30             | 0.42            | 0.45 / 0    |                              |
| Water entry               | 300 ms   | 0.50              | 0.30            | -           |                              |
| Surface breach            | 260 ms   | 0.42              | 0.26            | -           |                              |
| Ballast pump (loop)       | 250 ms x N| 0.08             | 0.20            | -           | rate-scaled                  |
| Collide light             | 90 ms    | 0.35              | 0.25            | -           |                              |
| Collide medium            | 180 ms   | 0.65              | 0.40            | -           |                              |
| Collide heavy             | 400 ms   | 1.00              | 0.65            | -           |                              |
| Hull scrape (loop)        | 250 ms x N| 0.18             | 0.55            | -           |                              |
| Creature bump             | 200 ms   | 0.55              | 0.35            | -           |                              |
| Creature strike           | 450 ms   | 0.90              | 0.55            | -           |                              |
| Leviathan grab            | sustained| 1.00              | 0.75            | 0.8 / 0.8   | until released               |
| Leviathan roar (D<=40 m)  | 1400 ms  | 0.70              | 0.15            | -           | strong only: it is a sub-bass event |
| Leviathan roar (40..220 m)| 1400 ms  | 0.70 x g(D)       | 0.10 x g(D)     | -           | `g(D)=1/(1+D/60)`, floor 0.05 |
| Damage taken (player)     | 160 ms   | 0.50              | 0.30            | -           |                              |
| Hull breach               | 700 ms   | 0.85              | 0.60            | -           |                              |
| Low O2 heartbeat          | 90 ms    | 0.22              | 0.05            | -           | 1 per beat, only below 20 s  |
| Depth crush warning       | 350 ms   | 0.30              | 0.10            | -           | 1 per 4 s while over-depth   |
| Emergency blow            | 900 ms   | 0.60              | 0.45            | -           |                              |

### 12.9.7 Binding presets

| Preset          | Description                                                                  |
|-----------------|------------------------------------------------------------------------------|
| `Default`       | tables in 12.3                                                               |
| `Unified`       | A/D always yaw, Q/E always roll, in both air and water                       |
| `Southpaw`      | swaps LS/RS on gamepad                                                       |
| `Flight-sim`    | inverted pitch everywhere, throttle on LS-Y as an absolute lever, rudder on triggers, roll on RS-X |
| `Left-handed KB`| IJKL movement, arrow-cluster actions, all right-hand-side keys mirrored       |
| `One-handed KB` | all gameplay reachable from WASD + surrounding 12 keys + mouse; holds converted to toggles |
| `Legacy sub`    | Subnautica-like: no roll, mouse yaw/pitch only, Space/C vertical             |

Presets are applied to the **current handling scheme's profile** only, and never silently
overwrite user edits - applying a preset shows a diff list and requires confirmation.

---

## 12.10 Edge cases

### 12.10.1 Water / air transition while inputs are held

The transition is a **cross-fade of control authority**, not a switch:

```
sub = submergedFraction(hull)               // 0 = fully in air, 1 = fully underwater
sub_f += (sub - sub_f) * (1 - exp(-dt / 0.35))    // 0.35 s smoothing
authority_air   = 1 - sub_f
authority_water = sub_f
u_total = u_air * authority_air + u_water * authority_water
```

Rules:

1. **Held keys carry over.** A player holding `KeyW` through the surface keeps accelerating;
   the throttle setpoint is rescaled by `v_max_water / v_max_air` (Assisted) or the lever
   position is preserved (Manual). No re-press is ever required.
2. **Actions that do not exist in the destination context** are handled per this table:

| Action held across transition | Air -> Water                                    | Water -> Air                              |
|-------------------------------|-------------------------------------------------|-------------------------------------------|
| `CLIMB` (Space)               | becomes `ASCEND`, seamless                      | `ASCEND` becomes `CLIMB`, seamless        |
| `DESCEND` (Ctrl)              | becomes `DESCEND` (water), seamless             | seamless                                  |
| `ROLL_*` (A/D, air)           | becomes `YAW_*` (water) **only on re-press**; a held key is consumed and produces nothing until released, with a 1.2 s HUD hint "A/D = YAW" | mirror rule, hint "A/D = ROLL" |
| `BALLAST_FILL/BLOW`           | already valid, continues                        | continues (pumps still work at surface)   |
| `AIRBRAKE`                    | becomes water airbrake, seamless                | seamless                                  |
| `GEAR` deployed               | auto-retracts at `sub_f > 0.6`, 1.4 s animation | stays retracted                           |
| `BOOST`                       | reservoir is shared; magnitude changes, seamless| seamless                                  |
| `SILENT_RUN`                  | n/a in air                                      | auto-disengages, annunciator flash        |

   The "consumed until released" rule for A/D exists because silently converting a held roll
   into a held yaw at the moment of splashdown produces an uncommanded spin. This is the one
   place where we deliberately drop input.

3. **Camera/optics** cross-fade over 0.28 s: FOV (mask optics only applies on foot/swim, not
   in the sealed cockpit), underwater fog, colour absorption, and the `WATER_ENTRY` /
   `SURFACE_BREACH` shake impulses fire once at `sub_f` crossing 0.5 (rising / falling).
4. **Player on foot/swimming** uses the same pattern with the eye point instead of hull
   samples, and with the swim/walk controllers cross-faded over 0.20 s.
5. **Audio** cross-fades the underwater low-pass (cut-off `20000 -> 780 Hz`) over 0.22 s with
   an equal-power curve. Owned by section 14; listed here because the trigger is `sub_f`.

### 12.10.2 Input during locked animations

| Animation                   | Duration | Movement | Look                | Buffering                              |
|-----------------------------|----------|----------|---------------------|----------------------------------------|
| Board vessel (from foot)    | 1.10 s   | locked   | 40 % authority      | last 0.25 s of input buffered, applied on the first unlocked frame |
| Board vessel (from swim)    | 1.45 s   | locked   | 40 %                | same; airlock drain audio               |
| Exit vessel (to land)       | 1.05 s   | locked   | 55 %                | same                                    |
| Exit vessel (to water)      | 1.35 s   | locked   | 55 %                | same; O2 timer starts at `t = 0.9 s`    |
| Tool swap                   | 0.35 s   | free     | free                | `TOOL_PRIMARY` buffered                 |
| Ore harvest (drill finish)  | 0.40 s   | free     | free                | none                                    |
| Climb ledge (from water)    | 0.85 s   | locked   | 70 %                | movement buffered                        |
| Fabricator use              | 1.2..4 s | locked   | free (look around)  | `UI_CANCEL` aborts, refunds resources    |
| Death fall-away             | 2.5 s    | locked   | locked              | none; all input discarded                |
| Respawn fade-in             | 1.2 s    | locked   | free                | movement buffered                        |

**Buffering rule.** During a locked animation, presses of `MOVE_*`, `TOOL_PRIMARY`, `JUMP`,
`INTERACT` occurring in the final `T_BUFFER_WINDOW` (0.25 s) are recorded with their press
time and replayed as press edges on the first unlocked frame. At most 3 buffered actions;
oldest dropped. Holds that are still physically down at unlock resume naturally from key
state and do not need buffering.

**Cancellation.** Board/exit animations are **not** cancellable (they are physical airlock
cycles). Fabricator and harvest are cancellable via `UI_CANCEL` / releasing `TOOL_PRIMARY`.

**Transition fades.** With the comfort option "Transition fades" ON (default), board/exit use
a 0.15 s fade-to-black + 0.20 s fade-in instead of a swept camera. With it OFF, the camera
physically travels the path with the neck spring of the destination context.

### 12.10.3 Key repeat

- `KeyboardEvent.repeat === true` events are **discarded outright** for every gameplay action.
  Only UI navigation uses repeat, and it uses the game's own timer (`T_REPEAT_DELAY_UI`,
  `T_REPEAT_RATE_UI`), **not** the OS repeat rate, so behaviour is identical across machines.
- Digital-hold actions derive from `keyDown` set membership, so OS repeat is irrelevant to them.
- Text entry fields use native repeat (they are native semantics).

### 12.10.4 Simultaneous conflicting inputs (SOCD)

| Pair                                      | Resolution      | Rationale                                    |
|-------------------------------------------|-----------------|----------------------------------------------|
| `MOVE_LEFT` + `MOVE_RIGHT`                | **last wins**   | responsive strafing; matches player expectation |
| `MOVE_FORWARD` + `MOVE_BACK`              | **null (0)**    | prevents accidental creep                    |
| `SWIM_UP` + `SWIM_DOWN`                   | null            |                                              |
| `CLIMB` + `DESCEND`                       | null            |                                              |
| `ROLL_LEFT` + `ROLL_RIGHT`                | null            | a rolling snap on a fumble is nauseating     |
| `YAW_LEFT` + `YAW_RIGHT`                  | last wins       |                                              |
| `THROTTLE_UP` + `THROTTLE_DOWN`           | null (setpoint holds) |                                        |
| `BALLAST_FILL` + `BALLAST_BLOW`           | null, **and** both pumps off (no power draw) | physically correct       |
| `BOOST` + `AIRBRAKE`                      | airbrake wins   | safety-biased                                |
| `SPRINT` + `CROUCH`                       | crouch wins     |                                              |
| `TOOL_PRIMARY` + `TOOL_SECONDARY`         | primary wins; secondary queued until primary releases | |
| `SILENT_RUN` + `SONAR_PING`               | ping refused, HUD "SILENT RUNNING" flash | |
| `HOLD_DEPTH` + manual vertical input      | manual wins, hold disengages (12.8.6) | |
| Keyboard axis + gamepad axis, same frame  | **max magnitude wins** per axis; ties -> keyboard | avoids fighting |
| Mouse look + stick look, same frame       | **summed** (both applied) | intentional: mouse+pad hybrid users exist |

"Last wins" is implemented by recording a press ordinal per key and comparing; it must survive
a key being released and re-pressed while the opposite key is still held.

### 12.10.5 Chrome: pointer lock

Covered in 12.5. Additional specifics:

| Gotcha                                                                 | Mitigation                                          |
|------------------------------------------------------------------------|-----------------------------------------------------|
| `requestPointerLock` throws if not in a user-gesture task               | only call from `pointerdown`/`keydown`/`click`      |
| Re-lock within ~1 s of a user Escape is rejected                        | `PL_COOLDOWN_MS = 1300` + retry loop (12.5.1)       |
| `unadjustedMovement` unsupported on some platforms -> Promise rejects   | catch, retry without options, set `input.unadjusted=false` |
| First `mousemove` after lock can carry a large synthetic delta          | discard first event, suppress look 60 ms            |
| Pointer lock silently dropped when the canvas is re-created/resized in a way that reparents it | never reparent the canvas; resize via `width`/`height` attributes only |
| `contextmenu` opens on right-click even when locked, in some configs    | `addEventListener('contextmenu', e => e.preventDefault())` on document |
| Mouse buttons 3/4 trigger browser back/forward                          | `preventDefault()` on `mousedown`, `mouseup` and `auxclick` for `button >= 3` |
| Middle-click autoscroll                                                 | `preventDefault()` on `mousedown` button 1          |
| Text selection / drag ghosting from the canvas                          | CSS `user-select:none; -webkit-user-drag:none; touch-action:none` |

### 12.10.6 Chrome: fullscreen

| Gotcha                                                        | Mitigation                                                    |
|---------------------------------------------------------------|---------------------------------------------------------------|
| `requestFullscreen()` requires a user gesture                 | boot splash gesture; a Fullscreen toggle in the pause menu     |
| Returns a rejected Promise if blocked                         | catch; do not block boot on it                                 |
| Exiting fullscreen also drops pointer lock                    | single `SOFT_PAUSE` path handles both                          |
| Chrome shows its own "Press Esc to exit full screen" toast     | expected; our first-run tutorial mentions it                   |
| Keyboard Lock requires fullscreen and is revoked on exit      | `navigator.keyboard.unlock()` in `fullscreenchange`            |
| `devicePixelRatio` and canvas size change on entering FS      | resize handler must be idempotent; recompute projection, and **do not** reset camera or input state |
| macOS FS animation takes ~700 ms with 0-size frames           | skip rendering when `canvas.width===0`; clamp first `dt` after resize to 1/60 |

### 12.10.7 Chrome: gamepad

| Gotcha                                                              | Mitigation                                                 |
|---------------------------------------------------------------------|------------------------------------------------------------|
| Gamepads hidden until a user gesture                                | boot prompt; poll after first gesture                      |
| `getGamepads()` array entries can be `null` with sparse indices     | iterate the whole array, null-check                        |
| Cached `Gamepad` objects go stale                                   | re-read every frame; never store the object                 |
| `mapping` may be `""` (non-standard)                                | raw-binding screen                                          |
| `vibrationActuator` may be absent                                   | feature-detect; disable rumble UI                           |
| `playEffect` rejects without user activation or when hidden         | try/catch, silent                                           |
| Effects continue after tab hide on some builds                      | explicit `reset()` on `visibilitychange`                    |
| Duplicate device reported on connect (XInput + DInput)              | de-duplicate by `(id, index)`; prefer `mapping==="standard"` |
| Stick drift on worn controllers                                     | calibration tool (12.9.2)                                   |
| Trigger rest value can be `-1` on some legacy pads                  | detect range on first 30 frames; remap `[-1,1]`->`[0,1]`     |

### 12.10.8 Chrome: tab visibility, throttling, and audio

| Situation                        | Behaviour                                                                            |
|----------------------------------|--------------------------------------------------------------------------------------|
| `visibilitychange` -> hidden     | push `SOFT_PAUSE`; `releaseAllInputs()`; `vibrationActuator.reset()`; fade master to -60 dB over 120 ms then `audioCtx.suspend()`; stop rAF loop |
| `visibilitychange` -> visible    | keep `SOFT_PAUSE`; on the resume click: `audioCtx.resume()`, fade up over 200 ms, restart rAF, re-acquire pointer lock |
| `window.blur`                    | same as hidden (Alt+Tab may not fire visibilitychange on all platforms). Idempotent.  |
| Background rAF throttling        | rAF simply stops being called; because we pause on hide, no catch-up is needed        |
| First frame after resume         | `dt` clamped to `1/60`; physics accumulator flushed, not replayed                     |
| Long frame (dt > 0.25 s)         | clamp `dt` to 0.25 s and drop accumulated substeps beyond 4; log a hitch counter       |
| `AudioContext` starts `suspended`| boot gesture calls `resume()`; if it fails, retry on every subsequent gesture until it succeeds; show a small "AUDIO OFF - CLICK TO ENABLE" chip |
| `pagehide` / `beforeunload`      | `navigator.keyboard.unlock()`, `exitPointerLock()`, flush save to IndexedDB (synchronously best-effort via `localStorage` mirror of the small state) |
| WebGPU device lost               | pause, show recovery dialog, attempt `requestDevice()` re-init once; input state preserved |

### 12.10.9 Sticky keys / lost keyup

`keyup` can be lost when focus changes mid-press (Alt+Tab, Cmd+Tab, OS dialogs).

- `releaseAllInputs()` runs on `blur`, `visibilitychange`, and `pointerlockchange`-to-null.
- It synthesises release edges so any `HOLD` state machine terminates cleanly (e.g. an
  in-progress `INTERACT_HOLD` cancels rather than completing).
- Additionally, a **watchdog**: if a key has been continuously down for > 120 s while the
  player has produced no other input, release it and log a warning (guards against a wedged
  key from a driver glitch).
- Modifier state (`Shift`/`Ctrl`/`Alt`) is re-synchronised from every incoming
  `KeyboardEvent.getModifierState()` rather than tracked purely by edges.

### 12.10.10 Chorded bindings and modifier hygiene

- A binding is `(code, modMask)` where `modMask` is any subset of `{Shift, Ctrl, Alt}`.
  `Meta`/`Cmd` may **never** be part of a binding (macOS system shortcuts, and Chrome drops
  keyups while Meta is held).
- A chorded binding wins over the unchorded one for the same `code` when its full modifier
  set matches. `Shift+KeyL` therefore suppresses `KeyL`.
- The unchorded binding fires only if **no** modifier that participates in any chord for that
  code is currently held.
- `AltLeft` used as a plain hold binding (`FREE_LOOK`) must `preventDefault()` to stop the
  Chrome/Windows menu-bar focus behaviour. `AltRight` (AltGr on many layouts) is never bound.
- Bindings are never allowed to collide with: `Ctrl+W/T/N/R/Tab/Shift+I/Shift+J/Shift+C/L/D`,
  `Alt+F4`, `F5`, `F11`, `F12`, or any `Meta` combination. The rebind capture screen rejects
  these with the message "Reserved by the browser".

### 12.10.11 Rebinding capture rules

1. Push `UI_MODAL`; suspend all other bindings.
2. Show "Press a key, mouse button, or controller input. Esc to cancel, Backspace to unbind."
3. Capture the **first** non-modifier `keydown` plus the modifier state at that instant.
   A modifier pressed alone for > 1.0 s can be bound on its own (so `ShiftLeft` alone is
   bindable) - this is why we wait for a non-modifier or a timeout.
4. Mouse: capture `mousedown` (buttons 0-4) and `wheel` (as `WHEEL+`/`WHEEL-`).
5. Gamepad: capture the first button edge or an axis crossing 0.65.
6. On conflict with an existing binding **in the same context**, show
   "X is already bound to <Action> in <Context>. [Swap] [Replace] [Cancel]".
   Conflicts across mutually exclusive contexts are allowed and not reported.
7. Each action supports up to 2 keyboard/mouse bindings and 2 gamepad bindings.
8. `Escape` and browser-reserved combinations are rejected (12.10.10).

### 12.10.12 Keyboard layout

- Bindings store `KeyboardEvent.code` (physical position), so WASD stays in the same physical
  place on AZERTY/QWERTZ/Dvorak.
- Display labels come from `navigator.keyboard.getLayoutMap()` (Chrome supports it), resolved
  once at boot and again on `layoutchange` if available. Fallback label = the `code` with the
  `Key`/`Digit` prefix stripped.
- A first-run prompt on non-QWERTY layouts offers "Use ZQSD instead of WASD?" (AZERTY) -
  which rebinds by **code** to the physically equivalent cluster.
- Dead keys and IME never affect gameplay because we read `code`, not `key`, and because
  `keydown` is `preventDefault`ed in gameplay contexts.

### 12.10.13 Trackpads and unusual pointers

- Detect a probable trackpad: `wheel` events with `deltaMode === 0` and fractional
  `deltaY`, or `pointerType === "touch"`. On detection, offer a one-time toast
  "Trackpad detected - apply trackpad preset?" which sets `sensitivity_slider = 5.0`,
  `mouse_smoothing = 25 %`, and enables `mouse_accel` with `accel_amount = 0.6`.
- Touch input is **not supported** for gameplay; the boot screen states desktop-only. Touch
  events are `preventDefault`ed on the canvas to avoid page zoom/scroll.
- Tablet/pen (absolute pointers) do not produce useful `movementX` under pointer lock; if
  `pointerType === "pen"` is seen, suggest Cursor Mode (12.5.6).

### 12.10.14 Miscellaneous

| Case                                    | Handling                                                        |
|-----------------------------------------|-----------------------------------------------------------------|
| Two contexts want the same key          | top-of-stack wins; there is no fallthrough                       |
| Action pressed in frame N, context popped in frame N | the press edge is discarded, not delivered to the new context |
| `UI_OVERLAY` opened while sprinting     | sprint releases; on close, sprint resumes only if the key is still physically down |
| Player exits vessel while it is moving  | exit blocked if `|v| > 3.0 m/s` (air) / `1.5 m/s` (water); HUD "SLOW DOWN TO DISEMBARK" |
| Player exits vessel below rated depth   | blocked above 380 m unless suit upgraded; HUD shows the rating   |
| Vessel destroyed while piloting         | forced exit animation 0.8 s, input locked, then `SWIM_SUB`       |
| Rebinding while a gamepad is disconnected | gamepad rows greyed with "connect a controller to rebind"      |
| Save/load during input                  | input state is never serialised; on load, all actions start released |
| Multiple browser windows of the game    | only the focused one has pointer lock; the other sits in `SOFT_PAUSE` |
| Extremely high frame rate (>240 fps)    | mouse deltas still accumulate correctly; per-frame clamp scales with dt (12.1.3) |
| System sleep / wake                     | `dt` clamp + `SOFT_PAUSE` via `visibilitychange` covers it        |

---

## 12.11 Settings persistence

`localStorage` key `subwave.input.v3` (JSON, < 24 KB). Not IndexedDB: it must be readable
synchronously before the first frame, and it must survive a save-file wipe.

```json
{
  "version": 3,
  "profiles": {
    "assisted": { "FOOT": { "MOVE_FORWARD": [["KeyW",0],["ArrowUp",0]] }, "...": {} },
    "manual":   { "...": {} }
  },
  "scheme": "assisted",
  "preset": "Default",
  "mouse": { "sens": 2.50, "yMul": 1.00, "invertY": false, "invertYVessel": false,
             "accel": false, "accelAmount": 0.35, "accelPower": 1.20,
             "smoothing": 0, "raw": true, "calibratedUnadjusted": true, "dpi": 800,
             "ctxScale": { "FOOT":1.0, "SWIM":0.88, "VAIR":0.72, "VWATER":0.60, "VMANUAL":0.55 } },
  "pad": { "sensX":1.00, "sensY":1.00, "invertY":false, "invertYVessel":false,
           "dzLeft":0.14, "dzRight":0.10, "dzTrigger":0.06, "gammaLook":1.80,
           "lookAccel":1.00, "rumble":1.00, "triggerRumble":true, "glyphs":"auto" },
  "camera": { "fovBase":90, "fovCockpitOffset":-12, "maskOptics":"comfort",
              "shake":1.00, "bob":0.60, "fovKick":"full", "inertia":0.80,
              "rollFollow":1.00, "autoRoll":true, "vignette":"off",
              "staticFrame":"cockpit", "screenFx":"full", "dof":true,
              "motionBlur":"off", "waterDistort":"full", "fades":true,
              "comfortPreset":"default" },
  "access": { "toggleSprint":false, "toggleCrouch":false, "toggleTool":false,
              "toggleVesselSustain":false, "toggleFreeLook":false, "toggleAll":false,
              "holdScale":1.00, "doubleTapEnabled":true, "cursorMode":false },
  "browser": { "fullscreenOnStart":true, "captureEscape":true }
}
```

**Migration.** On load, if `version < 3`, run migrators in sequence; unknown actions are
dropped with a console warning; missing actions fall back to the current defaults. A corrupt
blob is discarded wholesale and replaced with defaults, with a one-time toast.

**Reset.** "Reset all controls" requires `T_HOLD_DESTRUCTIVE` (0.80 s) and shows a radial fill.

---

## 12.12 First-run onboarding (input only)

The starting reef is threat-free precisely so controls can be taught without pressure. Prompts
are contextual, dismiss on completion, and never repeat once satisfied. Glyphs match the active
device (12.9.1).

| Trigger                                    | Prompt                                       | Satisfied by                        |
|--------------------------------------------|----------------------------------------------|-------------------------------------|
| Spawn on beach                             | `[W A S D] MOVE  /  [MOUSE] LOOK`            | 6 m travelled + 90 deg turned       |
| Within 8 m of vessel                       | `[HOLD E] BOARD`                             | boarding                            |
| First frame in cockpit                     | `[W] THROTTLE  [MOUSE] STEER  [SPACE] CLIMB` | 40 m travelled                      |
| Airborne above 25 m                        | `[L] LIGHTS   [C] VIEW`                      | either pressed, or 60 s elapsed     |
| Nose within 20 m of water while descending | `[SPACE]/[CTRL] DEPTH - DIVE STRAIGHT IN`    | submerging                          |
| First `VESSEL_WATER` frame                 | `A/D NOW YAW  -  [F] FLOOD  [R] BLOW`        | 20 s elapsed or ballast used        |
| Depth 30 m                                 | `[T] DEPTH HOLD   [V] SONAR`                 | either pressed, or 90 s elapsed     |
| Hovering, stationary, 5 s                  | `[HOLD E] EXIT - CHECK YOUR OXYGEN`          | exiting                             |
| First `SWIM_SUB` frame outside vessel      | `O2 [xx s]  -  [SHIFT] SWIM FASTER`          | 15 s elapsed                        |
| O2 below 25 s, first time                  | `RETURN TO VESSEL`                           | re-boarding                         |
| First time pointer lock lost               | `CLICK TO RESUME  -  HOLD ESC TO LEAVE FULLSCREEN` | resume                       |

All onboarding can be disabled with **"Control hints: On / Once / Off"**, default `Once`.

---

## 12.13 Developer / QA bindings

Active only when the URL contains `?dev=1`. Never shipped-enabled; the parse happens once at
boot and sets a frozen flag.

| Key            | Function                                              |
|----------------|--------------------------------------------------------|
| Backquote      | dev console (text entry sub-state)                     |
| F7             | toggle free-fly noclip camera                          |
| ShiftLeft+F7   | teleport vessel to camera                              |
| BracketLeft/Right | time-of-day -/+ 15 min                              |
| Semicolon      | cycle biome debug overlay                              |
| Quote          | cycle GPU pass visualiser                              |
| Comma/Period   | frame-step (pause sim; step 1 fixed step)              |
| Slash          | toggle 0.25x / 1x / 4x time scale                      |
| Digit9         | spawn creature picker                                  |
| Digit0         | damage vessel 10 %                                     |
| ShiftLeft+Digit0 | full repair + refill O2/power                        |
| Backslash      | input-state inspector (live action table + raw devices)|

---

## 12.14 Acceptance tests

Each must be an automated or scripted check before this section is signed off.

| # | Test                                                                                             | Pass criterion                                                              |
|---|--------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------|
| 1 | Look with a synthetic 1000-count horizontal sweep at 30, 60, 144 fps                              | resulting yaw identical within 0.01 deg across all frame rates               |
| 2 | Default sensitivity, 800 DPI                                                                      | 360 deg turn requires 6545 +/- 5 counts                                      |
| 3 | Hold `KeyW`, cross the waterline in the vessel 20 times                                           | no context oscillation; `sub_f` monotonic within each crossing; no dropped throttle |
| 4 | Hold `KeyD` (roll) in air, splash down                                                            | no yaw command produced until `KeyD` is released and re-pressed              |
| 5 | Press Escape, immediately click to resume, 50 times                                               | resume succeeds within 1.6 s every time; no console errors                   |
| 6 | Alt+Tab away mid-sprint mid-drill, return                                                         | no stuck keys; drill loop stopped; rumble stopped; sim time did not advance  |
| 7 | Disconnect gamepad while boosting                                                                 | `SOFT_PAUSE` within 1 frame; rumble stopped; boost released                  |
| 8 | Assisted auto-level from 45 deg roll, no input                                                    | settles within +/-1 deg in <= 1.4 s, overshoot <= 8 %                        |
| 9 | Depth hold engaged at 120 m, 1.0 m/s current disturbance                                          | steady-state depth error <= 0.6 m; no ballast oscillation (period > 25 s)    |
|10 | Auto-trim from 50 % over-ballasted at 80 m                                                        | vertical thruster command < 0.08 within 45 s; no oscillation                 |
|11 | Manual mode, no input, 60 s                                                                       | vessel attitude drifts (expected); no assist torque measurable (< 0.5 % of max) |
|12 | All 13 assists individually toggled in Custom                                                     | no NaN, no discontinuity > 0.15 in any normalised command at the toggle frame |
|13 | Every action in every context has at least one default binding, or is documented as intentionally unbound | 100 % coverage report                                              |
|14 | Rebind every action to a random legal key, save, reload                                           | bindings restored exactly; no conflicts undetected                           |
|15 | Camera shake at 150 % with 12 simultaneous generators                                             | total rotation never exceeds 6.0 deg; no visible C1 discontinuity            |
|16 | Comfort preset "Maximum comfort"                                                                  | zero camera rotation not directly commanded by the player, except vessel-physics attitude with rollFollow=0 |
|17 | Leviathan roar at D = 10, 60, 200, 400 m                                                          | shake and rumble monotonically decrease; nothing at 400 m                    |
|18 | Board/exit vessel 100 times with buffered inputs                                                  | buffered action replays exactly once; never twice; never lost                 |
|19 | AZERTY layout                                                                                     | movement keys are physically Z/Q/S/D; labels read "Z Q S D"                  |
|20 | Input-to-photon latency, high-speed capture at 60 fps                                             | <= 45 ms mouse-move to on-screen rotation                                    |
|21 | 30-minute session on integrated GPU at 30 fps                                                     | no input drift, no accumulator overflow, sensitivity unchanged               |
|22 | Simultaneous mouse + gamepad look                                                                 | contributions sum; no jitter; glyph set does not flicker faster than 0.35 s  |

---

## 12.15 Open items for other sections

1. Section 04 must confirm or supply the vessel mass/inertia/authority table in 12.8.1; if it
   differs, re-derive `Kp = omega_n^2` and `Kd = 2*zeta*omega_n` from the same `omega_n`/`zeta`
   targets rather than re-tuning by feel.
2. Section 09 owns the windshield reticle, buoyancy bar, annunciators and hold-progress rings;
   this section owns their trigger thresholds and timings.
3. Section 14 owns the audio for pumps, disengage chirps, and the roar low-pass; this section
   owns the trigger conditions and the -14 dB / 0.18 s chirp spec.
4. Section 05 must confirm the swim/walk speeds quoted in 12.3.2/12.3.3.
5. Section 13 (fauna) must confirm that `SONAR_PING` and `SILENT_RUN` affect creature
   aggression, and supply the leviathan roar distance model if it differs from `1/(1+D/60)`.
6. Section 16 must not clear `subwave.input.v3` when deleting a save.
