# SUBWAVE

A browser-native, WebGPU exploration/survival game in the vein of Subnautica. Walk a
beach, board a hybrid aerodyne/submersible, fly it, dive it, explore an ocean down to
-1131 m. It builds, boots, and runs at 120 fps.

**WHERE THINGS ARE WRITTEN DOWN, and it is a deliberate split.** This file holds only
what spans more than one file, or what is true of the PROJECT rather than of any code in
it. **Everything that one file owns is documented in that file**, at the point where it
can be violated — those comments carry the measurements, refutations and history, and
this file states each rule with its consequence and POINTS at the site. Read the site
before changing anything; where both state a rule, the code is authoritative.

---

## HARD CONSTRAINTS (never violate these)

1. **Zero third-party runtime dependencies.** No npm packages, no CDN, no external
   assets. `package.json` has no `dependencies` and must stay that way.
2. **No build step.** Plain ES modules served directly. No TypeScript, no bundler. The
   browser loads `src/main.js` as written.
3. **All shaders hand-written WGSL** in `src/render/shaders/`.
4. **All art procedural.** No model files, no textures, no audio files. Meshes are
   generated in code, textures from noise, audio (when built) from Web Audio synthesis.
5. **WebGPU only**, latest Chrome. No WebGL fallback.
6. **No stubs.** Agents have shipped placeholder code that passed every test: a
   `FRESNEL_PLACEHOLDER` shader constant, a debug checkerboard hull, a test reading a
   missing field via `?? 0`. If something cannot be finished, say so in the report.

## COORDINATE SYSTEM (binding, everything depends on it)

- Right-handed. **+X east, +Y up, +Z south.** Metres.
- Sea level `y = 0`. Underwater is `y < 0`. **Depth `d = -y`, POSITIVE going down.**
- **Heading 0 = north (-Z), increasing CLOCKWISE from above, east = +PI/2.**
  `quat.fromEuler` takes yaw as a compass heading and negates internally; pitch is
  positive UP. `headingFromDir`, `dirFromHeading` and the compass HUD agree. Do not
  "fix" those signs — mouse look was inverted once because they disagreed.
- Matrices are column-major `Float32Array(16)` matching WGSL `mat4x4f`. Quaternions
  are `(x, y, z, w)`.
- **Reverse-Z projection**, infinite far plane: near maps to 1, far to 0. Depth targets
  clear to `0.0`, compare `'greater'`. `DepthState` in `core/pipelines.js` is the single
  source of truth.

## THE CONTROL CONTRACT (the piloted vessel is DIRECTLY controlled)

Read this before touching `entities/vessel.js` or `core/input.js`. In 2026-07 the old
attitude/rate cascade was REVERSED on purpose, at the user's explicit instruction; the
full autopsy is in `vessel.js`'s header and deleted-cascade blocks. The two paths:

- **PILOTED, the vessel is KINEMATIC** (`Vessel._directControl`): orientation from
  `aimYaw`/`aimPitch` with roll a literal `0`, one first-order lag on the aim pair and
  one on velocity, then integration and real terrain contact. No attitude PID, no
  allocator, no aero/hydro moments on this path.
- **UNPILOTED, it is the rigid body it always was** (`simulateUnpiloted`) — a parked
  hull sits on its skids. **Do not delete the force model, the allocator or `_mix`**;
  the offline suites still measure them. The fork is `piloted && !unpiloted` in `_step`.

The clauses that SURVIVE, non-negotiable:

- **`input.look()` DRAINS the mouse accumulator.** Exactly ONE consumer may call it per
  sim step (Player *or* Vessel, never both — a frame carries 0, 1 or several steps),
  and `endFrame()` must not clear the deltas. Contract at `look()` in `core/input.js`.
- **The mouse integrates a persistent AIM** — compass heading + pitch clamped ±85°, gain
  exactly 1.0 everywhere. Positional, not a rate. **Nothing but the pointer may write
  it** — no rail, no clamp, no rate limit, no queue; each was tried and failed
  (autopsies at the aim block in `vessel.js`).
- **The cockpit camera is RIGIDLY attached to the hull.** Back-face culling hides a hull
  the eye is inside, but the nacelles sit ~42° off-axis against a 37° FOV half-angle —
  a five-degree margin. Rotate the camera off the hull and they arrive as floating
  vessel pieces. `qa.mjs`'s `cockpit-turning` scenario is the guard.
- **The chase camera has the ONLY two knobs, both placement-only** (`CHASE_LAG_COMP`,
  `chasePitchBias`), inside the `else` branch of `applyCamera` — on the cockpit path
  they spend the five-degree margin. Derivations at the constants.
- **The windshield HUD's horizon comes from the CAMERA** (= the hull), conformal with
  the glass. **A centred throttle commands a STOP, not zero acceleration** — the target
  velocity is the zero vector, so the lag that accelerates also stops.
- **Every DISCRETE decision reads the latched `vessel.underwater`, never raw `beta`** —
  surface chop swings `beta` several times a second.
- **The flight computer slows down for the water** — `_directSpeedLimit` walks the limit
  to `MAX_SUBSPEED` on a descent; without it a Vne dive costs 250% of the hull.
- **No ballast, trim, roll or vertical key** — diving is aiming down and opening the
  throttle. **The hull does not bank** — roll is a literal constant, measured 0.0000°
  peak at every attitude in both media.
- **The allocator is reached by NO running game** — the unpiloted branch zeroes every
  command and skips `_mix`; the piloted branch returns before it. `_allocate` runs only
  from the offline suites; its rules still hold *of it* (clamp to `FIN_TORQUE_FRAC`,
  ONE saturation scalar, true moment Jacobian). Do not delete it; do not call it live.

The DELETED rules — none may come back on its own; the killing numbers are in
`vessel.js`: the attitude/rate cascade on the piloted path (a 126° flick delivered
0.4%); `AIM_LEASH` and the pitch-coupled yaw rail; the yaw-rate budget; the aim rate
limit and pending queue (destroyed 85% of a flick / built a 0.97 s signed backlog);
the flight-path outer loop, trim and shortest-arc error (kept for the unpiloted body).

Two traps still live:

- **Filtering the orientation as a QUATERNION reintroduces roll** — a slerp between two
  zero-roll orientations peaks at 9.42° of roll at the midpoint. `_directControl` lags
  heading and pitch AS ANGLES and rebuilds the quaternion.
- **`quat.toEuler` must not read the hull** — it folds roll into yaw and inverts pitch
  past 90° of roll. Use `hullAim()` (roll-immune, what `board()` seeds from).

Given up on purpose (not bugs): momentum, angle of attack, sideslip, stall,
weathervane, axis coupling; releasing the throttle stops the vessel in mid-air.
**Collision is unaffected** — `test-input.mjs` flies the hull into a cliff at Vne.

## THE SWIM CONTRACT (a diver is a first-order lag, and nothing else)

`Player._simulateSwim` and `_readLook`; the measured autopsies are in the docstrings.

- **THE THRUST IS THE COMMANDED DIRECTION** — no slew, no smoothing, no state. The old
  slew was degenerate at exactly π (held S kept swimming FORWARD at +3.40 m/s); the
  0.167 s velocity lag IS the smoothing.
- **EVERY SWIM STEADY STATE IS INDEPENDENT OF `SWIM_DRAG`** — thrust and buoyancy are
  written relative to the drag, so cruise/sprint/drift are fixed points for ANY drag
  rate. Write any new term in the same relative form or that property is lost.
- **THE STROKE PULSE IS ON THE CAMERA, NOT THE THRUST** (`strokeSurge`) — on the thrust
  the velocity swung 161% of its mean; camera-only keeps the documented speeds exact.
- **INVERSION IS UNREACHABLE BY CONSTRUCTION** — heading + clamped pitch, roll damped
  to zero; no quaternion to tumble. **If you ever test levelness, test the UP vector**
  — the old auto-level tested RIGHT, which an upside-down diver satisfies.

## THE IMAGE PIPELINE — count the encodes

`render/passes/post.js`, `shaders/pass/{tonemap,lens}.wgsl`, `RENDER.*` in constants.js.

- **AgX encodes once, `lens.wgsl` encodes once, exactly ONE EOTF between them.**
  `agxEncode` returns a DISPLAY CODE VALUE; `tonemap.wgsl` must end with
  `pow(mapped, 2.2)`. Missing, 18% grey landed at code 187 and the double encode hid a
  1.14 EV exposure error. The display-referred grade only means anything in code space.
- **The demo fade is applied twice ON PURPOSE, once per surface** — `Renderer.demoFade`
  into the last line of `pass/lens.wgsl` AND `pass/hud.wgsl`'s master opacity; wire one
  half and a bright panel floats over black at every cut. Full reasoning at `demoFade`
  in `renderer.js` and the tail of `lens.wgsl`.
- Counted, not tuned — reasoning at each site: the metering window and `EXPOSURE_KEY`
  move together; grade saturation is 1.0 at every depth; the TWO vignettes multiply,
  both AFTER the histogram meters; TAA is a 1-pixel box sharpened back, never weakened.

## CROSS-FILE INVARIANTS

Rules several files must agree about, so no single file can hold them; the derivation
and measurements live at the site named on each line.

### Water and the medium

- **`sigmaT` is BEAM extinction (line of sight); `Kd` is DIFFUSE attenuation (daylight
  vs depth), and smaller** — the classic bug is confusing them: `sigmaT` for depth is
  pitch black at 40 m; `Kd` for distance is crisp to the horizon. Both on
  `WATER_TYPES` in `core/constants.js`.
- **The medium is applied EXACTLY ONCE per pixel**, by the composite in
  `pass/underwater.wgsl`. Submerged geometry must not also call `applyWaterMedium` —
  that double application turned clear reef water milky white.
- **`surfaceSigmaA`/`surfaceKd` are the same water with its Jerlov red put back, for
  the water-leaving radiance only.** The consumer set is CLOSED (three functions);
  `test-ocean.mjs` §12 greps for it. Derivation at the block in `core/constants.js`.
- **`renderer.env.waterType` is LIVE and SPRUNG; read the sprung value, not the
  table.** One chain: `biomes.js` decides (`waterTypeAt`), `main.js` springs,
  `renderer.js` packs, `common/water.wgsl` consumes. **Everyone samples the CAMERA; the
  categorical target additionally DWELLS** (`WORLD.WATER_TYPE_DWELL`) so minority water
  cannot flicker the column (explicit snaps bypass it); every knob bisects to 0.
- **One `waterTypeAt()` call shades every visible pixel of sea** — kilometres from
  altitude — and `w.id` (indexing `WATER_BOTTOM_ALBEDO`) SNAPS in one frame. Crossing a
  beach can retint the whole reef on screen.
- **`aphoticFactor` has THREE live implementations that must agree to the digit**
  (`common/ocean.wgsl`, `world/biomes.js`, `passes/glow.js`; `test-ocean.mjs` §6 checks
  a fourth) — or the classifier admits water on daylight the renderer zeroed.
- **The aphotic gate on `_columnCeiling` is what makes deep water types reachable**
  (`WORLD.COLUMN_APHOTIC_GATE`; 0 is the bisect) — without it every deep column fell to
  ABYSSAL_VOID under half the world. A/B at `waterTypeAt` in `world/biomes.js`.
- **A biome's colour lives on the HAZE, not the ground** (seabed albedo is 1.6–6%).
  `BIOMES[].fogTint` must ROTATE colour, never change energy — `renderer.js` normalises
  it to unit luma. The clarity knobs (`frame.veilTune`) are per-frame uniform writes:
  global, one frame, no spring, deliberately live on the above-water sight path too.
- **`BIOMES[].sightDensity` scales sigma_t and sigma_s TOGETHER, submerged eye only** —
  sigma_t alone makes an energy-inconsistent bright fog.
- **The art-deviation water rows (LAGOON_VIOLET, PLATTER_TEAL, KELP_EMERALD,
  DUNE_AZURE) are deliberate, each scoped to ONE biome, by explicit user instruction**
  ("vibrant colors beat physics"). Do not "correct" them toward Jerlov or widen them;
  each row in `core/constants.js` carries the argument and the refuted drafts.

### Ownership of light

- **The froxel volume is applied EXACTLY ONCE; ownership inverts with the medium.**
  Underwater the composite keeps transmittance/in-scatter/tint; the volume owns beam
  and lamps (`.a` = 1.0). In air the volume owns the whole aerial medium for its four
  geometry consumers. The beam leaves the analytic model in ONE line
  (`froxelOwnsBeam()`). **`ocean_surface.wgsl`, `sky_render.wgsl`, `clouds.wgsl` must
  NEVER consume the volume** — they call `aerialPerspective()` and would double.
- **The cluster cull and the receiver must slice Z on the same grid** — they once did
  not, and nothing small ever lit anything. The cull mirrors the constants through
  defines deliberately named `CULL_*`; `RENDER.CLUSTER_CULL_UNION = 0` is the bisect.
- **The ONLY place a pass may submit lights is `Renderer.addLightSubmitter()`** — after
  the loop's submitters, before upload/cull, on the right side of `camera.update()`.
  Order within the hook matters: at the 32-light cap a cluster keeps the
  LOWEST-INDEXED lights, so props run last.
- **A scatter type's emitted flux has ONE definition, in a device-free module**
  (`render/scatter_emit.js`) so `tools/scatter-census.mjs` can import it in node. No
  local copies, no device-dependent lines there.
- **`lightMeta.peak` (max channel — what ranking uses) and Rec709 luma (what quoted
  figures use) differ 1.19–2.98× per type.** Anything gating on light reads the peak.
- **Rank lights by delivered in-frustum irradiance (`I/d²`), never submitted
  intensity** — intensity ranking let a 4 m fill light beat a 130 m beacon by three
  orders. `render/passes/scatter.js`.
- **An emitter's aureole has ONE owner, inverting with light class**: a BEACON
  (`volumetric: 1`) gets a froxel shaft and NO sprite; a FILL light gets the sprite
  only. Both doubled once. Ownership block atop `passes/glow.js`.
- **The deep key's colour is per PLACE, its energy ONE number** — `DEEP_KEY_PALETTE` is
  luma-normalised and sprung; the magnitude multiplies AFTER the spring so zeroing it
  bisects in one frame. A global radiance made the deep MORE alike; ABYSSAL_VOID's null
  row is a refutation. **Do not re-run the sweep — read it** in `core/constants.js`.
- **`SHADOW_UNDERWATER_CUTOFF` is one number across four files and stays at 95** — 260
  was tried and refuted (below the photic zone the sun cannot be the key light at any
  cutoff). A/B/A at the constant in `core/constants.js`.
- **Inside a cave the open-column colour model stands down** (`CAVE_SIGHT_NEUTRAL` ×
  the SPRUNG enclosure; exactly 0 outside a cave, bit-exact open water at knob 0). If a
  cave reads wrong, tune the SOURCES, never widen this. Measured failure at the
  `waterTransmittance` docstring in `common/water.wgsl`.
- **A light inside a dry hull must not scatter in the water outside it** —
  `LIGHT_INTERIOR` removes it from the froxel INJECTION only; it still lights geometry.
- **The caustic is a MEAN-1 multiplier on the solar beam** — it can only REDISTRIBUTE
  the metered beam. Ambient sites multiply `causticFactor() - 1` (mean zero);
  `caustic × gain` is a DC lift, the bug this replaced. `common/water.wgsl`.
- **The sky ambient SH is attenuated by `daylightAtDepth(pointDepth)` — the
  ILLUMINATION path, not the view path** (`common/lighting.wgsl`, fixed in `238fab9`;
  a stale assertion of this bug once cost a whole tuning pass).

### Geometry, streaming and identity

- **A scatter chunk's AABB must contain every mesh it draws** — the pad derives
  vertical reach from the row's authored height (or `boundsPad`); a 46 m spire once
  vanished whole. Derivation at the emit's AABB block in `world/scatter.js`.
- **Scatter type ids are placement salts: APPEND, NEVER INSERT.** **Signature
  membership is the `signatureBiome` FIELD, not any id range, and it is load-bearing**:
  `passes/scatter.js` promotes those rows to BEACON lights, so adding it makes a row a
  light source. Count the table, not any comment (`test-scatter` asserts the signature
  count as `BIOMES.length - 2`); `DEEP_BEACON_EXTRA` is the non-signature beacon.
- **A `biomeTint` separates two biomes' COLOUR, not their VOCABULARY** — the vocabulary
  cosine is over SHAPES. Tint for hue; a second ROW off the same generator when two
  biomes must not read alike.
- **A `biomeTint` channel's real ceiling is 1.5990, not 2.0** — the unorm8 encode
  saturates the HALVED value, so anything above clips in silence. `BIOME_TINT_CEIL`
  enforces it; `test-scatter.mjs` re-derives it from the DELIVERED bytes.
- **No subtraction ships before its replacement** — a weight can only subtract, and
  "small rocks on a normal slope" becomes "a normal slope". Removal ships in the SAME
  change as its replacement, gated on delivered hue entropy not falling, as a matched
  pair. Conditions at the `biomeDensity` entry in `world/scatter.js` (which today
  authors ZERO weights); do not requote the withdrawn headline (`rockSmall` row).
- **An export with no importer, or a catalogue field with no reader, is this project's
  most repeated bug. GREP EVERY FIELD YOU ADD.** A blended-but-unread `fogTint`; an
  unimported `waterTypeAt` (14.8× luminance error); an unconsumed `lightSlotSet()`.
  The countermeasure is a NAMED CONSUMER WITH A DUE DATE at the site (`VENT_HAZE`'s
  docstring is the worked example). Anything else: claim it or delete it.
- **The biome system's `slope = 0` default is a lie** — it makes the FLAT biomes win
  (67.50% of the seabed misclassified). Any caller that can reach
  `terrain.sampleSlope(x, z)` MUST pass it; `caves.js` and `spawner.js` still default.
- **The placement loop's slope reads 1.187× the exact slope, biased toward rejection** —
  size a `slope: [0, x]` band against `sampleChunkField` or a low-slope row silently
  delivers zero instances. Derivation at the dark-mass block in `world/scatter.js`.
- **A co-moving seed volume has zero density at its leading edge — continuity, not
  tuning.** It read as "there are no fish" on a 16% dip; no target raise fixes an
  angular deficit. `entities/spawner.js` carries the boundary source.
- **The camera in a dry room is still in the water; the dry bubble is per pixel.**
  `Camera.isUnderwater` is `y < 0` and NOTHING else — one extra `&&` once broke five
  contracts at once. Dryness is the `dryPath` render target; `camera.dryInterior` is
  the EYE's own medium only. `render/camera.js`, `pass/underwater.wgsl`.
- **Caves are live.** `IN_CAVE` drives the SPRUNG enclosure drain — never gate pixels
  on the raw flag, it flickers at the mouth plane. **An unmeshed chamber photographs as
  open water** — check `game.caveChunks` streamed the address before trusting a frame.
- **"The coral reef" is not `REEF_TURQUOISE`, and biome 2 "Shallow Reef" carries
  OCEANIC_CLEAR** — a shot list aimed at "the reef" by name photographs the wrong
  water. Build it from a search for the WATER TYPE (`tools/shots/reef-flyover.json`).

### Consequences that read as bugs and are not

- Silent running caps the DISPLAYED throttle, not the speed; a piloted hull does not
  bob (wave forces are on the force pipeline the kinematic path skips).
- **The underwater cast shadow reads faint, and it is the MEDIUM, not the sun** — the
  lever is the composite's in-scatter or the water's `sigmaS`/`g`, never the
  direct/ambient balance or the caustic gain (`tools/probes/caustics-shadow.js`, which
  records the waterline-framing trap that voids a reading).
- Today's murkiest delivered water is ~42 m visibility; older murk figures are stale.

---

## LAYOUT

```
index.html              boot screen, fatal-error overlay, pointer-lock hint, legend
server.mjs              zero-dep dev server (COOP/COEP headers, WGSL as text/plain)
src/main.js             boot sequence + fixed-timestep game loop + system wiring
src/core/               math, gpu, shaderlib, resources, pipelines, time, input,
                        events, settings, profiler, constants
src/world/              noise, terrain, biomes, biome_anchors, chunks, caves, meshgen,
                        scatter, collision, scatter_collision, habitat_site, places,
                        abyss_encounter_site, leviathan_sites, terrain_worker, cave_*
src/render/             renderer (Frame uniform + bind group 0), camera, framegraph,
                        shadows (CSM atlas), glow_slots, scatter_emit, passes/*.js,
                        shaders/{common,pass,sim}/*.wgsl
src/entities/           player, vessel, vessel_mesh, bestiary, creature_mesh,
                        creatures, spawner, habitat, habitat_mesh, abyss_encounter,
                        teleport, leviathan_residency, cave_residency, dune_ambush,
                        station_residency
src/sim/                ocean (FFT spectrum), sky (atmosphere LUTs), weather
src/demo/               the press-G showcase: script.js (route as data), director.js
                        (state machine, any-input abort), recorder.js (SHIFT+G records
                        to mp4); each header carries its constraints. Audit route edits
                        offline (tools/probes/demo-path.mjs for clearance, demo-gaze.mjs
                        for depression angle, demo-corridor.mjs to find a bearing at all
                        — a leg through none of them is a guess); demo-capture.mjs →
                        demo-output/, and it records camera PITCH and DEPTH per frame:
                        a floor-ward frame and a canopy-ward one share every colour
                        metric, so nothing else in the report can tell them apart
src/ui/                 hud (Canvas2D), controls-hint (DOM legend), jump-menu
tools/                  the verification suite; tools/lib/ its shared kernel;
                        tools/probes/ instruments whose measurements are cited;
                        tools/shots/ shot lists
variety-output/,        tours and censuses — BOTH GITIGNORED WHOLE: every report named
census-output/          anywhere is LOCAL; re-run the tool to rebuild one
DESIGN/                 ~22,000 lines of authored spec, numbered 00-09, 11, 12
                        — there is no DESIGN/10, so AUDIO is undesigned, not deferred;
                        whoever builds it writes the spec first. Where a DESIGN
                        document and the code disagree the CODE IS AUTHORITATIVE;
                        the unbuilt sections say so in place
```

### Load-bearing contracts

- **`core/constants.js` is the single source of truth** for every tuned number; a
  disagreeing `DESIGN/` document is stale.
- **`render/passes/index.js` IS the frame** — its ordering comments carry the
  constraints, and it reads passes off the game object BY NAME: an unset field is a
  silently absent pass, so register a new pass there AND construct it in `main.js`.
- **`shaders/common/frame.wgsl`** declares the Frame uniform and bind group 0; offsets
  verified by `tools/test-layout.mjs`. Add fields at the END, bump `FRAME_BYTES`.
- **Camera-relative rendering.** `Camera.position` is absolute; shaders receive
  positions with `worldOrigin` subtracted. Use `camera.toRelative(out, absPos)`;
  `isSphereVisible`/`isBoxVisible` take ABSOLUTE coordinates.
- **The vessel mesh and cockpit camera come from ONE resolved transform**
  (`Vessel.applyRender()`) — built from different states they separated 2 m at 120 m/s,
  putting the eye outside the hull (see the cockpit clause).
- **`terrain.findSpawnPoint()`** derives the start point from the terrain; never
  hard-code a spawn coordinate.
- **The shadow pass CANNOT bind the full frame bind group** — `shadowAtlas` is in group
  0, and WebGPU rejects one texture as `TEXTURE_BINDING` and `RENDER_ATTACHMENT` in one
  scope. The caster pipelines carry their own minimal layout; a platform rule.
- **`mat4.orthoReverseZ`'s depth row is the difference between a shadow atlas and an
  expensive no-op** — sign-flipped, every caster clips away and the receiver reports
  LIT everywhere. `tools/test-shadow.mjs` is offline arithmetic against exactly this.
- **The terrain mesher runs in a pool of module Web Workers** (platform API, no
  dependency breach); a chunk is a pure function of `(cx, cz, lod)` + seed, worker
  output verified byte-identical. `typeof Worker === 'undefined'` in Node lets offline
  suites bake inline.

## VERIFICATION — run these, they have caught almost every real bug

```bash
node tools/check.mjs            # syntax, imports, WGSL includes, manifest freshness
node tools/test-layout.mjs      # Frame uniform byte drift, Light struct mirror
node tools/wgsl-compile.mjs     # REAL WGSL compilation in headless Chrome
node tools/qa.mjs               # boots the game; per-scenario brightness / fps /
                                # depth / black-fraction. Count SCENARIOS in the file
node tools/test-input.mjs       # REAL keys, REAL mouse: movement, the accumulator,
                                # diving on mouse + W alone, top speeds in both media
node tools/test-vessel-control.mjs   # allocator authority (calls _allocate DIRECTLY)
node tools/test-jump.mjs        # jump menu anchors + teleport latches (offline)
node tools/test-variety.mjs     # the BIOME-VARIETY TOUR — the only implementation of
                                # the variety metric this file cites. Jumps to every
                                # anchor (count the destinations in the file); cosine
                                # printed NEXT TO hue entropy, dark mass, near-mass.
                                # Runs the tour TWICE; self-cosine < 0.98 VOIDS the
                                # run (a creature filling the lens included — re-site
                                # the anchor, never loosen the gate). --out/--force,
                                # --gate (G1..G7), --only, --check-g5
node tools/scatter-census.mjs   # WHAT EACH BIOME IS MADE OF, offline, ~5 s: type
                                # shares, flux, vocabulary cosine, mask-vs-delivery
                                # audit. --sample lattice for the whole disc;
                                # definitional decisions at its header
node tools/probe.mjs "<expr>"   # evaluate anything against the running game;
                                # --file f for a script (90 s CDP deadline)
node tools/shot.mjs --list f    # screenshots into shot-output/, readable with Read
node tools/gen-shader-manifest.mjs   # after adding a shader
```

Plus offline suites:
`test-noise test-terrain test-ocean test-sky test-post test-hud test-entities
test-meshgen test-scatter test-caves test-bestiary test-creatures test-vessel-control
test-shadow test-caustics test-glow test-jump test-habitat test-abyss-encounter
test-dune-ambush test-parity test-scatter-collision`

- **The scatter census RE-BASELINES; nothing it prints may be diffed against a figure
  in a document** — no historical sample is enumerated, so a difference has four
  inseparable causes; take a control run on the tree you are changing
  (take one and name it whatever you like — none ships). **Its two SCOPES are
  different questions** —
  instance-biome vs anchor-box read 0% and 40% seagrass at one anchor; the 30 m disc
  is the scope near a sight range.
- **`test-input.mjs` completes about half the time; both deaths are harness faults**:
  an orphaned Chrome holding the fixed profile (`pkill -f
  'user-data-dir=.*input-profile'`), and a hung `Runtime.evaluate` that leaks that
  Chrome. Run twice before concluding; budget six minutes.
- **Tour comparability is absolute on destination count and anchor moves** — every
  recorded tour predates the current destination set, so **no valid reference tour
  exists: take a fresh control before using a tour as a gate.**
- `tools/lib/png.mjs` (zero-dep decoder, PNG ONLY — the art references are .jpeg,
  undecodable) and `tools/lib/frame-metrics.mjs` are the shared kernel; anything
  measuring a delivered frame imports them, so two tools cannot disagree.
- **Every browser tool goes through `launchBrowser` in `tools/lib/browser.mjs`** — one
  copy of find-Chrome, ephemeral ports, full-signal teardown, SIGKILL so the profile
  deletes, startup reaper. A private copy of that truth cost 8.6 GB of leaked profiles.
- **`test-meshgen` is the only thing that looks at a new generator.** A generator is
  only tested if added to `MESH_GENERATORS`, and the entry must use the ROW's
  parameters — the registry's defaults drift and measure a mesh that ships nowhere.
- **The wall-clock budgets measure this machine's load as much as the code** — the same
  build reads ~2.3× slower under load, green idle, red 8/8 loaded. **Never bisect for a
  red wall-clock check**; size against a same-session control, interleave A/Bs in one
  process (terrain bake: ~2 ms real margin; lottery suites never judged on one sample).

### How to judge visual work

**Tests passing and looking right are different claims** — three visual bugs shipped
with every suite green because nobody looked. `qa.mjs` writes `qa-output/*.png`; **read
them with the Read tool** (it clears `qa-output/` at startup — concurrent runs clobber).

- `renderer.debugReadback(targetName)`: measured channel means and black-fraction for
  any render target; REFUSES (not zeros) if the target lacks `COPY_SRC`.
- `renderer.debugReadDepth(nearMetres, maxDim)`: the companion for GEOMETRY — exact
  reverse-Z linearisation, near-mass and range percentiles; it answers what dark mass
  (absence of contrast, not presence of anything) cannot on a dark frame. Read from a
  settled eye — the speed kick moves the fov.
- **A shot setup must aim the PLAYER, not the camera** — `camera.setEuler()` is rebuilt
  from `player.yaw`/`player.pitch` next frame and fails silently and selectively.
  Write both: `p.yaw = y; p.pitch = pt; c.setEuler(y, pt, 0);` aiming AT a target
  (`yaw = atan2(dx, -dz)`, `pitch = asin(dy / dist)`) beats guessing an angle.
- **`MAX_GPU_SCOPES` must exceed what the frame requests** — a scope past the cap
  silently repeats its LAST resolved average; read `profiler._scopeCount` at your
  framing before adding a pass.
- **The per-scope GPU breakdown supports NO cost claim on this machine** — 45 scopes
  once summed to 61 ms inside a measured 5.8 ms GPU span; `profiler.gpuTotal` returns
  NaN rather than a plausible lie (docstring in `core/profiler.js`). What DOES support
  one: `gpuFrameSpan`, and `--no-vsync` throughput (`tools/probes/motion-budget.js`).

### Measurement traps — instruments that lie

Each produced a confident wrong answer here at least once — a number that moves for a
reason other than the one being tested.

- **Do not measure biome diversity by dominant-hue spread** — it rewards worse frames
  and is nearly blind to blue-dominant biomes. Use hue × saturation histogram cosine.
- **A cosine is never read alone** — it is MAXIMISED by "every frame is one different
  flat colour"; read it next to hue entropy and dark mass. Corollary: filling an empty
  frame RAISES the cosine, so real improvement can read as regression.
- **A cosine can move far more than the frame does when a haze sits on a hue-bin edge**
  (±1° moved one pair 0.646→0.953; worked example at the NEPHELOID row in
  `core/constants.js`). Two values for one pair are two measurements, not drift.
- **A metric can improve while the picture gets worse — it has, three times. OPEN THE
  PNG.** The calibration frames behind gate G5 were all looked at (`G5_CALIBRATION` in
  `tools/test-variety.mjs`) — the only reason its expect column means anything.
- **Every gated number has a control spread, most wider than the effect claimed.** A
  quantity with no control column may not be promoted to a gate; p95/p05 and the lens
  minimum are known lottery reads.
- **An A/B must be a matched pair on one tree with one `--only` set — two tours are not
  an A/B** (fauna dominates; the wrong diagnosis that shipped is at the `rockSmall` row
  in `world/scatter.js`).
- **The tour's suit lamp is ~11× the rest of the frame in the deep** — ambient-shaping
  terms read as noise on that instrument. Measure `sceneColor` with the lamp toggled
  before declaring a term dead.
- **Do not judge a flee fix by circular concentration of relative bearing** — maximal
  for a tail-on lock AND a flank-on slip. Read `meanAbsRelBearingDeg` and `tailOnFrac`.
- **A pinned camera makes geometry free** (`motion-budget.js` ABORTS if the camera did
  not travel), and **the abyss qa station contains nothing to light** — its brightness
  is the grade's black lift on zero. Judge neither cost nor the deep from there.
- **A statistic sampled once is a lottery read**, and adding/removing an agent reseeds
  every other agent's PRNG stream — toggle a weight, park a body far away.
- **A brighter object is a WHITER one** — raised emission crosses the AgX shoulder and
  DROPS delivered saturation; pale colour underwater is a REFLECTANCE problem.
- **The "0.384 vs 0.148" variety claim was fiction that stood here as measured fact.**
  The metric exists now (`test-variety.mjs`); the reference-frame half does not (the
  references are .jpeg, undecodable) — never quote a reference-class cosine.

---

## STYLE

- JSDoc block comment on every exported symbol.
- Comments explain **why**, and non-obvious physics or algorithm choices. Never restate
  the code. No decorative banners beyond the existing `// ---- name ----` form.
- 2-space indent, single quotes, no emoji.
- Out-first non-allocating math (`vec3.add(out, a, b)`). No allocation in per-frame or
  per-vertex loops.
- SoA typed arrays for entity storage.
- Determinism is a contract: same seed, bit-identical world. No `Math.random()`,
  `Date.now()`, or iteration-order dependence in generation. Never sample noise in
  chunk-local coordinates — that is what makes a seam visible.
- **Never pack two indices into one hash coordinate** — `hash2(3 * cellX + s, ...)`
  aliases (measured 100.00% agreement between draws that should be independent) and
  prints a one-cell-period lattice on any thinned population. Use `hash3`.

## WORKING WITH AGENTS ON THIS PROJECT

- **Every implementation phase needs an adversarial reviewer.** The one phase that
  shipped without one shipped three visual bugs.
- **If a reviewer fails (API error), re-run it.** Do not absorb the job manually and
  call it reviewed.
- Give agents the exact export names of anything they depend on — interface drift is
  the most common failure between parallel agents; `check.mjs` catches it late.
- Demand measured numbers and screenshot descriptions, not claims. Agents have reported
  work as verified that was not.
