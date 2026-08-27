/** Fixed Pelagos Habitat: static mesh, lights, airlock transition and dry room. */

import { vec3, mat4 } from '../core/math.js';
import { createVertexBuffer, createIndexBuffer } from '../core/resources.js';
import { MATERIAL } from '../world/collision.js';
import { HABITAT_SITE } from '../world/habitat_site.js';
import { PLAYER_STATE } from './player.js';
import { buildHabitatMesh, HABITAT_MODULES, HABITAT_LEGS } from './habitat_mesh.js';

const INTERACT_RANGE = 2.7;
const LIGHT_RANGE = 180;

/**
 * Exterior collision volumes, [localX, localZ, radius, yLow, yHigh] about the
 * deck plane.
 *
 * THE MODULE CENTRES AND RADII ARE THE MESH'S, imported rather than retyped.
 * They were two hand-maintained copies in two files - as the leg list still
 * nearly was, with two of its rows in a different order - and check.mjs cannot
 * see across that boundary at all. A drum whose collider is 5 cm from its skin
 * is a diver clipping into a wall, with every test green.
 */
const MODULES = Object.freeze(HABITAT_MODULES.map(
  (m) => Object.freeze([m.x, m.z, m.r, 0, m.apex])));

/**
 * The corridors, as capsule-ish cylinders about their own axis:
 * [axis, fixedCoordinate, from, to, radius].
 *
 * These did not exist before, and their absence was reachable: exterior
 * collision pushed only the drums and the legs, so a 4.0 m gap between the
 * commons and the laboratory let a diver swim INTO the east corridor and stand
 * in a dry room with the underwater composite still running. Now that the
 * corridors are visible tubes rather than back-face-culled shells, that is
 * something a player would find in the first minute.
 *
 * They are all above the deck, so none of them narrows the Kestrel lane, which
 * runs underneath it.
 */
const CORRIDORS = Object.freeze([
  Object.freeze(['x', 0.00, 4.10, 12.60, 2.12]),
  Object.freeze(['x', 0.15, 17.80, 23.30, 2.12]),
  Object.freeze(['x', 1.85, -11.60, -3.60, 2.12]),
  // The airlock trunk stops SHORT of its own hatch: HABITAT_SITE.exteriorDoor
  // is the interaction point and a diver has to be able to reach it.
  Object.freeze(['z', 0.00, -9.60, -5.70, 2.22]),
]);

const LEGS = HABITAT_LEGS;

/** Corridor axis height above the deck plane; matches HALL_Y in habitat_mesh.js. */
const CORRIDOR_Y = 1.70;

/**
 * Push a body sideways out of the horizontal corridor tubes.
 *
 * HORIZONTAL ONLY, exactly like the drum push above, and that is not an
 * approximation - it is what stops the resolver fighting the deck. A tube's
 * axis is 1.85 m above the deck plane and its bore is 1.7 m, so the gap under
 * one is 0.15 m: nothing swims there, and there is no reason to resolve a body
 * downward into a slab the very next clause then resolves it back out of.
 * Resolving in the (side, y) plane instead pushed a diver standing on the deck
 * under the east corridor 1.47 m DOWN, whereupon the deck clause put them
 * 2.32 m below where they started, under the platform, and left them there.
 *
 * @returns {number} contacts resolved
 */
function pushCorridors(p, v, ox, oz, deck, bodyR, low, high) {
  let contacts = 0;
  const axisY = deck + CORRIDOR_Y;
  for (const [axis, fixed, from, to, radius] of CORRIDORS) {
    const alongWorld = axis === 'x' ? p[0] - ox : p[2] - oz;
    if (alongWorld < from || alongWorld > to) continue;
    if (high <= axisY - radius || low >= axisY + radius) continue;
    const limit = radius + bodyR;
    let dSide = axis === 'x' ? (p[2] - oz) - fixed : (p[0] - ox) - fixed;
    let d = Math.abs(dSide);
    if (d >= limit) continue;
    if (d < 1e-5) { dSide = -1; d = 1; }
    const ns = dSide / d;
    p[axis === 'x' ? 2 : 0] += ns * (limit - d);
    const vi = axis === 'x' ? 2 : 0;
    if (v[vi] * ns < 0) v[vi] = 0;
    contacts++;
  }
  return contacts;
}

export class Habitat {
  constructor(device = null) {
    this.device = device;
    this.site = HABITAT_SITE;
    this.mesh = null;
    this.gpu = null;
    this.position = new Float32Array([HABITAT_SITE.x, HABITAT_SITE.deckY, HABITAT_SITE.z]);
    this.modelMatrix = mat4.fromTranslation(mat4.create(),
      this.position);
    this.prevModelMatrix = new Float32Array(this.modelMatrix);
    this.playerInside = false;
  }

  init() {
    this.mesh = buildHabitatMesh();
    if (this.device) {
      this.gpu = {
        vertexBuffer: createVertexBuffer(this.device, this.mesh.vertices, 'habitat.vb'),
        indexBuffer: createIndexBuffer(this.device, this.mesh.indices, 'habitat.ib'),
        parts: this.mesh.parts,
      };
    }
    return this;
  }

  destroy() {
    this.gpu?.vertexBuffer?.destroy();
    this.gpu?.indexBuffer?.destroy();
    this.gpu = null;
  }

  /** Prompt text for the HUD/DOM overlay, or an empty string. */
  prompt(player) {
    if (player.inVessel) return '';
    const p = this.playerInside ? this.site.interiorDoor : this.site.exteriorDoor;
    return vec3.dist(player.position, p) <= INTERACT_RANGE
      ? (this.playerInside ? 'E  Cycle airlock and exit habitat' : 'E  Cycle airlock and enter habitat')
      : '';
  }

  tryInteract(player) {
    if (player.inVessel) return false;
    const target = this.playerInside ? this.site.interiorDoor : this.site.exteriorDoor;
    if (vec3.dist(player.position, target) > INTERACT_RANGE) return false;

    if (this.playerInside) {
      this.playerInside = false;
      player.inHabitat = false;
      const p = this.site.exteriorDoor;
      // Yaw 0 = north = AWAY from the north-face airlock: the view direction
      // stays consistent with travel through the lock (enter facing the
      // station, exit facing open water). This used to reuse the entry's PI
      // and dropped the swimmer nose-first into the hull it had just left.
      player.teleport(p[0], p[1], p[2] - 0.8, 0, 0, { time: player._time });
      player.state = PLAYER_STATE.SWIM_FREE;
      player.eyeSubmerged = true;
      player.grounded = false;
    } else {
      this.playerInside = true;
      player.inHabitat = true;
      const p = this.site.interiorDoor;
      // Yaw PI faces south (+Z) from the north airlock: down the trunk into
      // the commons, revealing the habitat instead of the exit door.
      player.teleport(p[0], p[1], p[2], Math.PI, 0, { time: player._time });
      player.state = PLAYER_STATE.GROUNDED;
      player.eyeSubmerged = false;
      player.submergence = 0;
      player.depth = 0;
      player.grounded = true;
      player.walkable = true;
      vec3.zero(player.velocity);
    }
    return true;
  }

  /**
   * Connected pressure-volume collision. Each room and corridor is an AABB in
   * local XZ, with deliberate overlaps at door portals. Resolving movement one
   * axis at a time makes the union slide like a conventional indoor collider
   * while retaining a single shared metal floor and ceiling.
   */
  resolvePlayer(body, dt, out) {
    const p = body.position, v = body.velocity, r = body.radius;
    const room = this.site.interior;
    const wasGrounded = out.grounded;
    out.wallHit = false;
    out.steppedUp = 0;
    out.landingSpeed = 0;

    const inside = (x, z) => room.spaces.some((space) => {
      const lx = x - this.site.x, lz = z - this.site.z;
      return lx >= space.minX + r && lx <= space.maxX - r &&
        lz >= space.minZ + r && lz <= space.maxZ - r;
    });
    const oldX = p[0];
    const vx = v[0];
    p[0] += v[0] * dt;
    if (!inside(p[0], p[2])) {
      p[0] = oldX; v[0] = 0; out.wallHit = true;
      out.wallNormal[0] = vx > 0 ? -1 : 1;
      out.wallNormal[1] = 0; out.wallNormal[2] = 0;
    }
    const oldZ = p[2];
    const vz = v[2];
    p[2] += v[2] * dt;
    if (!inside(p[0], p[2])) {
      p[2] = oldZ; v[2] = 0; out.wallHit = true;
      out.wallNormal[0] = 0; out.wallNormal[1] = 0;
      out.wallNormal[2] = vz > 0 ? -1 : 1;
    }

    p[1] += v[1] * dt;
    if (p[1] <= room.floorY) {
      if (!wasGrounded && v[1] < 0) out.landingSpeed = -v[1];
      p[1] = room.floorY;
      if (v[1] < 0) v[1] = 0;
      out.grounded = true;
    } else {
      out.grounded = false;
    }
    const head = p[1] + (body.height ?? 1.82);
    if (head > room.ceilingY) {
      p[1] -= head - room.ceilingY;
      if (v[1] > 0) v[1] = 0;
    }
    out.groundY = room.floorY;
    out.normal[0] = 0; out.normal[1] = 1; out.normal[2] = 0;
    out.slopeCos = 1;
    out.walkable = true;
    out.material = MATERIAL.METAL;
    return out;
  }

  /** Keep a swimming diver out of pressure shells, decks and support legs. */
  resolveExteriorPlayer(player) {
    if (this.playerInside) return;
    const p = player.position, v = player.velocity;
    const feet = p[1], head = feet + player.currentHeight;
    const ox = this.site.x, oz = this.site.z, deck = this.site.deckY;

    const pushCylinder = (lx, lz, radius, y0, y1) => {
      if (head <= deck + y0 || feet >= deck + y1) return;
      let dx = p[0] - (ox + lx), dz = p[2] - (oz + lz);
      let d = Math.hypot(dx, dz);
      const limit = radius + player.radius;
      if (d >= limit) return;
      // ON THE AXIS THERE IS NO HORIZONTAL DIRECTION TO PREFER, and taking one
      // arbitrarily is a teleport: over the commons dome, whose collider is
      // 6.40 m of radius and 8.22 m tall, that is 5.74 m in a single frame.
      // Leave by the NEARER cap instead - which is the top for a diver settling
      // onto a roof and the bottom for one rising into the deck from below.
      if (d < 1e-5) {
        if (deck + y1 - feet < head - (deck + y0)) {
          p[1] = deck + y1;
          if (v[1] < 0) v[1] = 0;
        } else {
          p[1] = deck + y0 - player.currentHeight;
          if (v[1] > 0) v[1] = 0;
        }
        return;
      }
      const nx = dx / d, nz = dz / d;
      p[0] += nx * (limit - d); p[2] += nz * (limit - d);
      const into = v[0] * nx + v[2] * nz;
      if (into < 0) { v[0] -= into * nx; v[2] -= into * nz; }
    };
    for (const module of MODULES) pushCylinder(...module);
    for (const [x,z] of LEGS) {
      pushCylinder(x, z, 0.48, -10.9, 0.1);
    }
    pushCorridors(p, v, ox, oz, deck, player.radius, feet, head);

    // The broad deck is a ceiling from below and a floor from above. It is not
    // a heightfield, so the open water under it remains genuinely navigable.
    const inDeck = p[0] > ox - 19.8 && p[0] < ox + 32.2 &&
      p[2] > oz - 6.6 && p[2] < oz + 7.4;
    if (inDeck) {
      const bottom = deck - 0.48, top = deck + 0.02;
      if (feet < bottom && head > bottom) {
        p[1] = bottom - player.currentHeight;
        if (v[1] > 0) v[1] = 0;
      } else if (feet < top && head > top && feet >= bottom) {
        p[1] = top;
        if (v[1] < 0) v[1] = 0;
      }
    }
  }

  /** Coarse static-hull collision that preserves the authored drive-through. */
  resolveVessel(vessel) {
    const p = vessel.position, v = vessel.velocity;
    const ox = this.site.x, oz = this.site.z, deck = this.site.deckY;
    const dx0 = p[0] - ox, dz0 = p[2] - oz;
    if (dx0 * dx0 + dz0 * dz0 > 65 * 65) return 0;
    const halfY = 1.55;
    const radius = 2.25;
    let contacts = 0;
    const pushCylinder = (lx, lz, obstacleR, y0, y1) => {
      if (p[1] + halfY <= deck + y0 || p[1] - halfY >= deck + y1) return;
      let dx = p[0] - (ox + lx), dz = p[2] - (oz + lz), d = Math.hypot(dx, dz);
      const limit = radius + obstacleR;
      if (d >= limit) return;
      // See the diver's copy: a full-radius sideways shove off the axis is a
      // teleport. Leave by the nearer cap - the Kestrel arrives on a drum's axis
      // either settling onto the roof or rising into the deck from the lane.
      if (d < 1e-5) {
        if (deck + y1 - p[1] < p[1] - (deck + y0)) {
          p[1] = deck + y1 + halfY;
          if (v[1] < 0) v[1] = 0;
        } else {
          p[1] = deck + y0 - halfY;
          if (v[1] > 0) v[1] = 0;
        }
        contacts++;
        return;
      }
      const nx = dx / d, nz = dz / d;
      p[0] += nx * (limit - d); p[2] += nz * (limit - d);
      const into = v[0] * nx + v[2] * nz;
      if (into < 0) { v[0] -= into * nx; v[2] -= into * nz; }
      contacts++;
    };
    // Only the supports exist below deck; their wide spacing is the route.
    for (const [x,z] of LEGS) {
      pushCylinder(x, z, 0.48, -10.9, 0.1);
    }
    // Pressure shells and the corridors joining them exist above the deck.
    for (const module of MODULES) pushCylinder(...module);
    contacts += pushCorridors(p, v, ox, oz, deck, radius, p[1] - halfY, p[1] + halfY);

    const inDeck = p[0] > ox - 19.8 - radius && p[0] < ox + 32.2 + radius &&
      p[2] > oz - 6.6 - radius && p[2] < oz + 7.4 + radius;
    if (inDeck) {
      const bottom = deck - 0.48, top = deck + 0.02;
      if (p[1] + halfY > bottom && p[1] - halfY < top) {
        const cameFromBelow = vessel.prevPosition[1] <= bottom - halfY + 0.15;
        p[1] = cameFromBelow ? bottom - halfY : top + halfY;
        if ((cameFromBelow && v[1] > 0) || (!cameFromBelow && v[1] < 0)) v[1] = 0;
        contacts++;
      }
    }
    return contacts;
  }

  /**
   * Practical lights: four exterior floods with visible housings, and one lamp
   * per dry room.
   *
   * INTENSITY IS IN THE SAME UNITS AS VESSEL_LIGHTS, and the previous values
   * were not. The airlock lamp was 720 against the Kestrel's brightest lamp at
   * 120 - a forward SEARCHLIGHT, and a 0.30 rad spot at that, where this was
   * isotropic and 1.7 m from the tube wall it was inside. Measured at the hatch
   * framing, that one light stopped the whole frame down 3.12x (1.64 EV) and put
   * 0.26% of the frame at clipped white with an equivalent core radius of 54 px.
   * It is the "glowing like a yellow sun" the rebuild was asked for, and it is a
   * SOURCE value: darkening it in the tonemap would have taken the rest of the
   * frame with it.
   *
   * EVERY LAMP INSIDE A SEALED HULL IS type 'interior'. Only that type is
   * skipped by the froxel injection, so a 'point' lamp in a dry room scatters in
   * the water outside it - which is the exact failure LIGHT_INTERIOR exists to
   * prevent, and which the laboratory's 540 and the observatory's 390 were both
   * doing. The floods are genuinely wet and stay punctual.
   */
  submitLights(renderer, cameraPosition) {
    const dx = cameraPosition[0] - this.site.x;
    const dz = cameraPosition[2] - this.site.z;
    if (dx * dx + dz * dz > LIGHT_RANGE * LIGHT_RANGE) return;
    // TWO WARMS, AND THE SPLIT IS THE ROOMS' COLOUR. [1.0, 0.62, 0.32] is about
    // 1900 K - below a candle - and one lamp colour was being used both inside a
    // dry room and out in the water. Measured off the delivered commons frame,
    // the room's illuminant was 1 : 0.88 : 2.21: green sitting BELOW red while
    // blue sat 2.2x above it, and the green deficit is this bulb. A room lamp is
    // seen in AIR, so it gets ~3000 K; the hatch marker is seen THROUGH WATER,
    // where the extra red chroma is the entire point of it, so it does not move.
    const warmRoom = [1.0, 0.80, 0.58];
    const warmMark = [1.0, 0.62, 0.32];
    const cool = [0.42, 0.72, 1.0];
    const add = (x, y, z, color, intensity, range, type = 'point') => renderer.addLight({
      position: [this.site.x + x, this.site.deckY + y, this.site.z + z],
      color, intensity, range, type,
    });

    // Exterior floods, under the housings buildDressing() puts on the module
    // shoulders. These stage the approach and are the only habitat lights that
    // may reach the water.
    add(0, 4.05, -5.60, cool, 34, 26);
    add(15.20, 4.30, -4.40, cool, 26, 22);
    add(-13.95, 4.10, -2.70, cool, 22, 20);
    add(25.80, 4.25, -4.55, cool, 24, 22);
    // A warm marker over the hatch, so the door is the warmest thing on a cold
    // blue building and reads as the way in from across the site. It is ABOVE
    // the trunk rather than in front of the door: on the axis it sat a metre
    // from a near-mirror porthole and its own specular reflection clipped white.
    add(0, 3.85, -9.40, warmMark, 20, 18);

    // Dry rooms. Sealed, so 'interior' - only that type is skipped by the
    // froxel injection.
    //
    // These are much stronger than the exterior floods and that is not an
    // inconsistency: illuminance falls as 1/d^2, a room lamp is 3-4 m from what
    // it lights, and it is competing with the daylight coming down through the
    // commons dome, which arrives already blue. Under-lit, the rooms rendered as
    // cold blue-violet boxes lit entirely by the sky ambient - the opposite of
    // the warm interior the window bands are advertising from outside.
    //
    // THE RANGE IS THE LEAK CONTROL, AND IT IS EXACT. Punctual lights here have
    // no shadow map and LIGHT_INTERIOR only removes a lamp from the froxel
    // injection - it does not stop one illuminating geometry - so a lamp inside
    // the commons also lit the deck outside it and the neighbouring modules. The
    // drum's own outer skin is safe (its normal points away, dot(N, L) < 0 culls
    // it), but the deck slab's nearest exterior point is 7.65 m from the commons
    // axis and the laboratory's west skin is 10.4 m, both inside the old 16 m.
    // punctualAttenuation's window term is identically ZERO at d >= range, so a
    // range under the inter-module distance removes the neighbour leak exactly.
    //
    // Measured: the deck took about 39% of its ambient red from the commons lamp
    // and takes about 3.7% now. NOT zero, and do not claim it is - the geometry
    // does not allow it. The farthest interior point that must stay lit is the
    // commons wall base at 7.41 m against that 7.65 m exterior point, a 3%
    // window, so a range that hard-cuts the deck also kills the wall. The
    // intensities come down with the ranges because two things now pay for the
    // room instead: HAB_COVE_GAIN went 0.055 -> 0.34 on a lit ceiling that
    // CANNOT leak, and evalPunctualLights no longer attenuates these lamps by
    // 4 m of ocean that is not in the room, which alone is worth about +60%.
    add(0, 4.20, 0, warmRoom, 70, 9.0, 'interior');
    add(0, 2.60, -7.60, warmRoom, 18, 4.5, 'interior');
    add(15.20, 3.70, 0.40, warmRoom, 34, 6.5, 'interior');
    add(-13.95, 3.40, 2.20, warmRoom, 30, 6.2, 'interior');
    add(25.80, 3.60, 0.40, warmRoom, 32, 6.5, 'interior');
  }
}
