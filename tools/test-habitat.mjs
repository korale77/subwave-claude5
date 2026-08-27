#!/usr/bin/env node
/** Deterministic fixed-habitat geometry, site, clearing and airlock checks. */

import { readFileSync } from 'node:fs';
import { WORLD, PLAYER } from '../src/core/constants.js';
import * as terrain from '../src/world/terrain.js';
import { biomeAt, setBiomeSeed } from '../src/world/biomes.js';
import { createCapsuleContact, CollisionWorld, MATERIAL } from '../src/world/collision.js';
import { Habitat } from '../src/entities/habitat.js';
import { Player, PLAYER_STATE } from '../src/entities/player.js';
import { Camera } from '../src/render/camera.js';
import { HABITAT_SITE, HABITAT_INTERIOR_SPACES, insideHabitatClearing,
  insideHabitatVolume } from '../src/world/habitat_site.js';
import { HABITAT_MATERIAL, HABITAT_MODULES } from '../src/entities/habitat_mesh.js';
import { VESSEL_MATERIAL } from '../src/entities/vessel_mesh.js';
import { generateScatterForChunk, SCATTER_FLOATS_PER_INSTANCE } from '../src/world/scatter.js';

let fails = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) fails++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label.padEnd(62)} ${detail}`);
};

terrain.setSeed(WORLD.DEFAULT_SEED);
setBiomeSeed(WORLD.DEFAULT_SEED);

console.log('\n== 1. authored site remains a deep, level Sand Plains shelf ==');
{
  const s = HABITAT_SITE;
  const h = terrain.sampleHeight(s.x, s.z);
  const slope = terrain.sampleSlope(s.x, s.z, 12);
  const b = biomeAt(s.x, s.z, h, terrain.sampleSlope(s.x, s.z));
  ok(b === 4, 'station centre is classified as Sand Plains', `biome ${b}`);
  ok(-h >= 40 && -h <= 48, 'seabed is deep enough for the whole station', `${(-h).toFixed(2)} m`);
  ok(slope < 0.08, 'foundation shelf stays nearly level', `slope ${slope.toFixed(4)}`);
  ok(s.deckY - h >= 9.5, 'legs preserve a vehicle-height undercroft', `${(s.deckY - h).toFixed(2)} m`);
  ok(-s.deckY > 30, 'main deck remains fully submerged', `${(-s.deckY).toFixed(2)} m`);
  const toStationX = s.x - s.arrival.x, toStationZ = s.z - s.arrival.z;
  const facingX = Math.sin(s.arrival.yaw), facingZ = -Math.cos(s.arrival.yaw);
  ok(facingX * toStationX + facingZ * toStationZ > 0,
    'staging jump faces the airlock instead of open water');
}

console.log('\n== 2. procedural station mesh is finite and presentation-sized ==');
const habitat = new Habitat().init();
{
  const m = habitat.mesh;
  ok(m.vertexCount > 1500, 'mesh has enough geometry for modules and interior', `${m.vertexCount} vertices`);
  ok(m.indexCount > 4000 && m.indexCount % 3 === 0, 'triangle index buffer is complete', `${m.indexCount} indices`);
  ok(m.parts.length >= 6, 'manufactured material families remain separate', `${m.parts.length} parts`);
  ok([...m.vertices].every(Number.isFinite), 'all packed vertex values are finite');
  ok([...m.indices].every((i) => i < m.vertexCount), 'every index addresses a real vertex');
  let inverted = 0, wound = 0;
  for (let i = 0; i < m.indexCount; i += 3) {
    const ia=m.indices[i]*12, ib=m.indices[i+1]*12, ic=m.indices[i+2]*12;
    const abx=m.vertices[ib]-m.vertices[ia], aby=m.vertices[ib+1]-m.vertices[ia+1], abz=m.vertices[ib+2]-m.vertices[ia+2];
    const acx=m.vertices[ic]-m.vertices[ia], acy=m.vertices[ic+1]-m.vertices[ia+1], acz=m.vertices[ic+2]-m.vertices[ia+2];
    const nx=aby*acz-abz*acy, ny=abz*acx-abx*acz, nz=abx*acy-aby*acx;
    const area2=Math.hypot(nx,ny,nz);
    if (area2 < 1e-8) continue;
    const vnx=m.vertices[ia+3]+m.vertices[ib+3]+m.vertices[ic+3];
    const vny=m.vertices[ia+4]+m.vertices[ib+4]+m.vertices[ic+4];
    const vnz=m.vertices[ia+5]+m.vertices[ib+5]+m.vertices[ic+5];
    wound++;
    if (nx*vnx+ny*vny+nz*vnz < -1e-7) inverted++;
  }
  ok(inverted === 0, 'every non-degenerate face winds with its vertex normal',
    `${inverted}/${wound} inverted`);
  ok(m.boundingRadius > 25 && m.boundingRadius < 40, 'culling sphere encloses the landmark', `${m.boundingRadius} m`);
}

console.log('\n== 3. the construction clearing removes procedural intersections ==');
{
  const s = HABITAT_SITE, chunk = WORLD.CHUNK_SIZE;
  const loX = Math.floor((s.x - s.clearRadius) / chunk), hiX = Math.floor((s.x + s.clearRadius) / chunk);
  const loZ = Math.floor((s.z - s.clearRadius) / chunk), hiZ = Math.floor((s.z + s.clearRadius) / chunk);
  let inside = 0, checked = 0;
  for (let cz = loZ; cz <= hiZ; cz++) for (let cx = loX; cx <= hiX; cx++) {
    const r = generateScatterForChunk(cx, cz, 0);
    for (let i = 0; i < r.count; i++) {
      const o = i * SCATTER_FLOATS_PER_INSTANCE;
      const x = cx * chunk + r.instances[o + 3];
      const z = cz * chunk + r.instances[o + 11];
      checked++;
      if (insideHabitatClearing(x, z)) inside++;
    }
  }
  ok(inside === 0, 'no flora, rock or ore occupies the station clearing', `${inside}/${checked}`);
}

console.log('\n== 4. cycling the airlock changes medium and locomotion ==');
{
  const collision = new CollisionWorld(terrain);
  const player = new Player(collision);
  player.setHabitat(habitat);
  const e = HABITAT_SITE.exteriorDoor;
  player.teleport(e[0], e[1], e[2], 0, 0);
  ok(habitat.tryInteract(player), 'exterior control admits a nearby swimmer');
  ok(player.inHabitat && habitat.playerInside, 'dry-room latch is owned by the airlock');
  ok(player.state === PLAYER_STATE.GROUNDED && !player.eyeSubmerged,
    'entry switches swimming to dry walking', `state ${player.state}`);
  ok(Math.abs(player.yaw - Math.PI) < 1e-6,
    'airlock entry keeps facing inward toward the habitat');
  ok(player.depth === 0, 'pressurised room suspends depth survival effects', `depth ${player.depth}`);
  const camera = new Camera();
  camera.position[1] = player.position[1] + PLAYER.EYE_HEIGHT;
  camera.dryInterior = true;
  // A CAMERA IN A DRY ROOM IS STILL IN THE WATER, and this assertion used to
  // demand the opposite. Suppressing isUnderwater() disabled the fullscreen
  // composite, handed the medium back to applyViewRayWater() at an eye height of
  // zero (full surface irradiance at 33 m), returned the raw sight density
  // instead of the biome's 0.30, counted the collimated sun beam twice, and made
  // waterPathLength() return 0 for every upward ray. The dry bubble is per pixel
  // now, in the dryPath target; see Camera.isUnderwater.
  ok(camera.isUnderwater, 'a dry interior does not lie about the medium the camera is in');
  ok(camera.dryInterior, 'the eye still knows it has air around it');
  camera.dryInterior = false;
  ok(camera.isUnderwater, 'and the same below-sea-level camera is wet either way');

  const room = HABITAT_SITE.interior;
  ok(room.spaces.length === 8, 'interior exposes four rooms, three halls and an airlock',
    `${room.spaces.length} pressure volumes`);
  const commons = room.spaces.find((s) => s.name === 'commons');
  ok(commons.maxX - commons.minX >= 9 && commons.maxZ - commons.minZ >= 9,
    'commons is materially larger than the original room',
    `${commons.maxX-commons.minX} x ${commons.maxZ-commons.minZ} m`);

  const body = { position: player.position, velocity: new Float32Array(3),
    radius: PLAYER.RADIUS, height: PLAYER.HEIGHT };
  const contact = createCapsuleContact();
  contact.grounded = true;
  const walkTo = (lx, lz) => {
    const tx = HABITAT_SITE.x + lx, tz = HABITAT_SITE.z + lz;
    for (let i = 0; i < 500 && Math.hypot(tx-body.position[0], tz-body.position[2]) > 0.06; i++) {
      const dx = tx-body.position[0], dz = tz-body.position[2];
      const d = Math.hypot(dx, dz), speed = Math.min(3, d / 0.04);
      body.velocity[0] = dx / d * speed; body.velocity[1] = 0; body.velocity[2] = dz / d * speed;
      habitat.resolvePlayer(body, 0.04, contact);
    }
    return Math.hypot(tx-body.position[0], tz-body.position[2]) <= 0.07;
  };
  ok(walkTo(0, 0), 'airlock connects to the enlarged commons');
  ok(walkTo(15.2, 0.4), 'east hallway connects commons to the laboratory');
  ok(walkTo(25.8, 0.4), 'second hallway connects the laboratory to the observatory');
  ok(walkTo(15.2, 0.4) && walkTo(0, 0) && walkTo(0, 1.85) && walkTo(-14, 2.2),
    'west hallway connects commons to the crew room');

  body.velocity.set([-20, -4, 0]);
  habitat.resolvePlayer(body, 1, contact);
  ok(contact.wallHit, 'outer pressure-room walls contain the walking capsule');
  ok(Math.abs(player.position[1] - room.floorY) < 1e-3 && contact.material === MATERIAL.METAL,
    'interior floor is walkable metal', `y ${player.position[1].toFixed(2)}`);

  player.position.set(HABITAT_SITE.interiorDoor);
  ok(habitat.tryInteract(player), 'interior control returns the player to the sea');
  ok(!player.inHabitat && !habitat.playerInside && player.eyeSubmerged,
    'exit restores the underwater medium');
  ok(Math.abs(player.yaw) < 1e-6,
    'airlock exit faces AWAY from the station (north, open water)',
    `yaw ${player.yaw}`);
}

console.log('\n== 5. the authored Kestrel lane is open but the deck is solid ==');
{
  const s = HABITAT_SITE;
  const under = { position: new Float32Array([s.x, s.deckY - 2.2, s.z]),
    prevPosition: new Float32Array([s.x, s.deckY - 2.2, s.z]),
    velocity: new Float32Array([0, 0, 0]) };
  ok(habitat.resolveVessel(under) === 0, 'level Kestrel clears the central under-deck lane',
    `centre y ${under.position[1].toFixed(2)}`);
  const intoDeck = { position: new Float32Array([s.x, s.deckY - 0.2, s.z]),
    prevPosition: new Float32Array([s.x, s.deckY - 3.0, s.z]),
    velocity: new Float32Array([0, 2, 0]) };
  ok(habitat.resolveVessel(intoDeck) > 0 && intoDeck.velocity[1] === 0,
    'vehicle collision stops an ascent through the deck');
}

console.log('\n== 6. the rebuilt station is glazed, round inside and fully submerged ==');
{
  const m = habitat.mesh;
  const byMat = new Map();
  for (const p of m.parts) byMat.set(p.material, (byMat.get(p.material) || 0) + p.indexCount);
  // The four faults the 2026-08-03 rebuild answered, as assertions.
  ok(!m.parts.some((p) => p.material === VESSEL_MATERIAL.HULL),
    'no part borrows the vessel hull skin', 'platedSkin scatters bare-alloy plates');
  ok(byMat.get(HABITAT_MATERIAL.GLASS) > 0 && byMat.get(HABITAT_MATERIAL.VIEWPORT) > 0,
    'glazing is skinned on BOTH faces',
    `${byMat.get(HABITAT_MATERIAL.GLASS)} out / ${byMat.get(HABITAT_MATERIAL.VIEWPORT)} in`);
  ok(byMat.get(HABITAT_MATERIAL.INTERIOR) > 0, 'the dry rooms have their own material');
  const lamps = m.parts.filter((p) => p.material === VESSEL_MATERIAL.EMISSIVE);
  ok(lamps.every((p) => p.emission <= 4),
    'no lamp lens is authored past the AgX shoulder',
    `max emission ${Math.max(...lamps.map((p) => p.emission))}`);

  // UVs ARE IN METRES on every habitat surface. habPanelDetail's 1.15 m panel
  // grid and habGlassDetail's 0.95 m panes are meaningless against a 0..1 UV,
  // and meshgen's own primitives all emit 0..1 - so a part that slipped through
  // on cylinder() or torus() would render as one texel of arc.
  let maxU = 0, maxV = 0;
  for (let i = 0; i < m.vertexCount; i++) {
    maxU = Math.max(maxU, Math.abs(m.vertices[i * 12 + 10]));
    maxV = Math.max(maxV, Math.abs(m.vertices[i * 12 + 11]));
  }
  ok(maxU > 6 && maxV > 6, 'habitat UVs are in metres, not normalised',
    `max |u| ${maxU.toFixed(2)}, max |v| ${maxV.toFixed(2)}`);

  // Round rooms against square colliders: the walkable square, inset by the
  // player radius, must stay inside the interior skin or a diver walks through
  // a visible wall at the corners.
  for (const mod of HABITAT_MODULES) {
    const space = HABITAT_INTERIOR_SPACES.find((sp) =>
      Math.abs((sp.minX + sp.maxX) * 0.5 - mod.x) < 0.4 &&
      Math.abs((sp.minZ + sp.maxZ) * 0.5 - mod.z) < 0.4);
    if (!space) continue;
    const halfX = (space.maxX - space.minX) * 0.5 - PLAYER.RADIUS;
    const halfZ = (space.maxZ - space.minZ) * 0.5 - PLAYER.RADIUS;
    const reach = Math.hypot(halfX, halfZ);
    ok(reach < mod.r - 0.17, `${space.name} stays inside its round skin`,
      `reach ${reach.toFixed(2)} m vs skin ${(mod.r - 0.17).toFixed(2)} m`);
  }

  // Fully submerged, which is what puts the dome under water rather than through
  // the surface. The apex is the highest point on the building.
  let maxY = -Infinity;
  for (let i = 0; i < m.vertexCount; i++) maxY = Math.max(maxY, m.vertices[i * 12 + 1]);
  ok(HABITAT_SITE.deckY + maxY < -8,
    'the whole station including the dome stays well under the surface',
    `apex ${(HABITAT_SITE.deckY + maxY).toFixed(2)} m`);
  ok(m.boundingRadius >= Math.max(...Array.from({ length: m.vertexCount }, (_, i) =>
    Math.hypot(m.vertices[i * 12], m.vertices[i * 12 + 1], m.vertices[i * 12 + 2]))),
    'the culling sphere is measured, not asserted');
}

console.log('\n== 7. the station is solid to the world around it ==');
{
  const s = HABITAT_SITE;
  // Inside a room, inside a corridor, and on the deck: all occupied.
  ok(insideHabitatVolume(s.x, s.deckY + 1.8, s.z), 'the commons is occupied volume');
  ok(insideHabitatVolume(s.x + 8, s.deckY + 1.8, s.z), 'the east corridor is occupied');
  ok(insideHabitatVolume(s.x + 25.8, s.deckY + 1.8, s.z + 0.4), 'the observatory is occupied');
  ok(insideHabitatVolume(s.x, s.deckY - 0.2, s.z + 5), 'the deck slab is occupied');
  // The undercroft is NOT: it is the authored Kestrel lane, and filling it with
  // an exclusion would empty the one place the building is meant to be flown.
  ok(!insideHabitatVolume(s.x, s.deckY - 5, s.z), 'the undercroft stays open water');
  ok(!insideHabitatVolume(s.x, s.deckY + 1.8, s.z - 40), 'open water 40 m north is free');
  ok(!insideHabitatVolume(s.x + 200, s.deckY, s.z), 'the cheap reject box works');

  // A diver may not swim into a dry corridor: exterior collision used to push
  // only the drums and the legs, leaving a 4 m gap between the commons and the
  // laboratory that led straight into the east hall.
  const player = { position: new Float32Array([s.x + 8.5, s.deckY + 1.85, s.z]),
    velocity: new Float32Array([0, 0, 0]), radius: PLAYER.RADIUS,
    currentHeight: PLAYER.HEIGHT };
  habitat.playerInside = false;
  habitat.resolveExteriorPlayer(player);
  const pushed = Math.hypot(player.position[0] - (s.x + 8.5),
    player.position[1] - (s.deckY + 1.85), player.position[2] - s.z);
  ok(pushed > 0.5, 'a swimmer is pushed out of the east corridor',
    `moved ${pushed.toFixed(2)} m`);
}

console.log('\n== 8. every dry interior surface is inside the hull that encloses it ==');
{
  // THE TUBE HAS TO CONTAIN ITS OWN FLOOR, and nothing else notices when it does
  // not: the mesh is finite, wound correctly and passes every other check while
  // 34 m2 of walkway hangs in open water and the hall reads as a bare pipe. This
  // samples the INTERIOR-material faces and asks whether each lies inside the
  // station's own solid envelope.
  const m = habitat.mesh;
  const interior = m.parts.find((p) => p.material === HABITAT_MATERIAL.INTERIOR);
  const s = HABITAT_SITE;
  let outside = 0, sampled = 0;
  for (let k = interior.firstIndex; k < interior.firstIndex + interior.indexCount; k += 3) {
    const a = m.indices[k] * 12, b = m.indices[k + 1] * 12, c = m.indices[k + 2] * 12;
    const cx = (m.vertices[a] + m.vertices[b] + m.vertices[c]) / 3;
    const cy = (m.vertices[a + 1] + m.vertices[b + 1] + m.vertices[c + 1]) / 3;
    const cz = (m.vertices[a + 2] + m.vertices[b + 2] + m.vertices[c + 2]) / 3;
    sampled++;
    if (!insideHabitatVolume(s.x + cx, s.deckY + cy, s.z + cz, 0.10)) outside++;
  }
  ok(outside / sampled < 0.005, 'interior faces stay inside the pressure envelope',
    `${outside}/${sampled} outside`);
}

console.log('\n== 9. exterior collision resolves without teleporting a body ==');
{
  const s = HABITAT_SITE;
  habitat.playerInside = false;
  const swim = (lx, ly, lz) => {
    const b = { position: new Float32Array([s.x + lx, s.deckY + ly, s.z + lz]),
      velocity: new Float32Array([0, 0, 0]), radius: PLAYER.RADIUS,
      currentHeight: PLAYER.HEIGHT };
    habitat.resolveExteriorPlayer(b);
    return { moved: Math.hypot(b.position[0] - (s.x + lx), b.position[1] - (s.deckY + ly),
      b.position[2] - (s.z + lz)), y: b.position[1] - s.deckY };
  };
  // A diver standing on the deck under a corridor: the tube is a WALL, not a
  // capsule resolved in (side, y). Resolved vertically it drove them 1.47 m down
  // and the deck clause then put them 2.32 m below where they started.
  const onDeck = swim(8, 0.02, 0);
  ok(onDeck.y > -0.4, 'a diver on the deck under a corridor is not pushed under it',
    `y ${onDeck.y.toFixed(2)} m, moved ${onDeck.moved.toFixed(2)} m`);
  // Directly over a drum's axis there is no horizontal direction to prefer, and
  // taking one arbitrarily is a 5.74 m teleport.
  const overDome = swim(0, 8.0, 0);
  ok(overDome.moved < 1.2, 'a diver on the commons axis is not flung sideways',
    `moved ${overDome.moved.toFixed(2)} m`);
  // The dome is solid: a collider derived from the interior ceiling left 2.72 m
  // of glass with nothing behind it.
  const inDome = swim(2.0, 6.6, 0);
  ok(inDome.moved > 0.2, 'the commons dome is solid to a swimmer',
    `moved ${inDome.moved.toFixed(2)} m`);
  // The authored interaction point must be reachable: it used to sit 0.55 m
  // inside a trunk that is now sealed and solid.
  const e = HABITAT_SITE.exteriorDoor;
  const atDoor = { position: new Float32Array(e), velocity: new Float32Array(3),
    radius: PLAYER.RADIUS, currentHeight: PLAYER.HEIGHT };
  habitat.resolveExteriorPlayer(atDoor);
  // 1e-3, not 1e-6: `position` is Float32Array and the authored door is a
  // double, so an untouched copy still differs by a float32 ulp.
  ok(Math.hypot(atDoor.position[0] - e[0], atDoor.position[1] - e[1],
    atDoor.position[2] - e[2]) < 1e-3, 'the exterior airlock control is reachable');
  const player2 = new Player(new CollisionWorld(terrain));
  player2.setHabitat(habitat);
  player2.teleport(e[0], e[1], e[2], Math.PI, 0);
  ok(habitat.tryInteract(player2), 'and still admits a swimmer from there');
  habitat.tryInteract(player2);

  // Every module collider matches its drawn shell, not an interior ceiling.
  for (const m of HABITAT_MODULES) {
    ok(m.apex > m.top && m.apex < 9, `${m.x} drum collider tracks its drawn apex`,
      `top ${m.top} apex ${m.apex}`);
  }
}

// ---------------------------------------------------------------------------
// 10. the medium-ownership and glazing decisions, at source level
// ---------------------------------------------------------------------------
//
// These live in shaders and in a pass registration order, so nothing offline can
// execute them - but every one of them is a rule that reads as an ordinary line
// of code and silently reverts a measured fix if it is "tidied". Same reason
// test-glow.mjs section 8 greps rather than runs.
{
  console.log('\n== 10. the dry-bubble and glazing contracts are stated in the source ==');
  const read = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  const entity = read('render/shaders/pass/entity.wgsl');
  const under = read('render/shaders/pass/underwater.wgsl');
  const water = read('render/shaders/common/water.wgsl');
  const camera = read('render/camera.js');
  const passes = read('render/passes/index.js');
  const lighting = read('render/shaders/common/lighting.wgsl');

  ok(/get isUnderwater\(\)\s*\{\s*return this\.position\[1\] < 0;\s*\}/.test(camera),
    'a dry interior does not suppress the frame-wide water flag',
    'Camera.isUnderwater must not read dryInterior - see the five contracts it broke');

  ok(entity.includes('out.dryPath') && entity.includes('-viewDist'),
    'the entity pass writes a SIGNED hull crossing',
    'FragOut.dryPath carries the sign; a prefix cannot describe a segment');
  ok(/dryInteriorSurface && eyeIsDry\(\)/.test(entity),
    'the medium skip is eye-aware, not surface-only',
    'an unconditional skip renders the commons unfogged through a transparent pane');

  ok(under.includes('dist - dryPath'),
    'the composite applies the medium over the WET length only');
  ok(under.includes('froxelSegment('),
    'and takes the volume over the wet SEGMENT, not from the eye');
  // Call sites only - the docstring above it names the function too, and a grep
  // that counts prose is a test that fails on its own comment.
  const mediumCalls = under.split('\n')
    .filter((l) => !l.trim().startsWith('//') && l.includes('applyViewRayMedium(')).length;
  ok(mediumCalls === 1, 'the composite applies the medium exactly once',
    `${mediumCalls} call site(s)`);
  ok(/isUnderwater\(\) && !eyeIsDry\(\)/.test(under),
    'the eye vignette is keyed on the EYE, not on the pixel',
    'per pixel it steps 12% at every window edge');

  ok(water.includes('VALID UNDERWATER ONLY'),
    'froxelSegment still says why differencing two taps is legal');

  ok(!entity.includes('HAB_ROOM_SPILL =') && !entity.includes('fn habViewportRadiance'),
    'neither emissive window fake has come back',
    'the room and the sea are real geometry now');
  ok(!read('entities/habitat_mesh.js').includes('const WINDOW_SPILL'),
    'and the gain that scaled one of them is gone with it');

  const glazeAt = passes.indexOf('game.glazingPass');
  const underAt = passes.indexOf('game.underwaterPass');
  const glowAt = passes.indexOf('game.particlesPass');
  ok(glazeAt > underAt && glazeAt < glowAt,
    'glazing is registered after the composite and before the sprites',
    `underwater ${underAt}, glazing ${glazeAt}, glow ${glowAt}`);

  ok(/submerged && s\.dryInterior < 0\.5/.test(lighting),
    'a lamp in a dry room is not attenuated by water it is not in');
  ok(lighting.includes('HAB_ROOM_BOUNCE') && !/HAB_ROOM_BOUNCE[\s\S]{0,200}columnLoss \*/.test(lighting),
    'a sealed room is filled by its own bounce, not by the sky');
  ok(!entity.includes('ROOM_CAVITY'),
    'and ROOM_CAVITY is gone, not merely retuned',
    'it was compensation for a defect fixed in 238fab9');
}

console.log(`\n${fails ? `FAILED: ${fails}` : 'All habitat checks passed.'}`);
process.exitCode = fails ? 1 : 0;
