#!/usr/bin/env node
/** Deterministic site, timing, safety and AI-handoff checks for the abyss reveal. */

import { WORLD } from '../src/core/constants.js';
import * as terrain from '../src/world/terrain.js';
import { biomeAt, setBiomeSeed } from '../src/world/biomes.js';
import { CreatureSim, BEHAVIOUR, speciesIndexOf } from '../src/entities/creatures.js';
import {
  AbyssEncounter, ABYSS_ENCOUNTER_PHASE,
} from '../src/entities/abyss_encounter.js';
import { ABYSS_ENCOUNTER_SITE } from '../src/world/abyss_encounter_site.js';
import { insideAbyssEncounterFootprint } from '../src/world/abyss_encounter_site.js';
import {
  generateScatterForChunk, SCATTER_FLOATS_PER_INSTANCE, SCATTER_STRIDE, SCATTER_TYPES,
} from '../src/world/scatter.js';

let fails=0;
const ok=(cond,label,detail='')=>{
  if(!cond) fails++;
  console.log(`  ${cond?'ok  ':'FAIL'} ${label.padEnd(66)} ${detail}`);
};

terrain.setSeed(WORLD.DEFAULT_SEED);
setBiomeSeed(WORLD.DEFAULT_SEED);

console.log('\n== 1. authored site is legal open water in the Abyssal Plain ==');
{
  const s=ABYSS_ENCOUNTER_SITE;
  const h=terrain.sampleHeight(s.x,s.z), slope=terrain.sampleSlope(s.x,s.z);
  ok(biomeAt(s.x,s.z,h,slope)===11,'encounter centre remains Abyssal Plain');
  ok(Math.abs(h-s.seabedY)<1e-6,'recorded seabed height matches generated terrain',h.toFixed(2));
  ok(s.y<=-820 && s.y-h>100,'arrival is deep and leaves leviathan-scale open water',`${(s.y-h).toFixed(1)} m clearance`);
  ok(Math.hypot(s.x,s.z)<WORLD.SOFT_BOUNDARY,'site remains inside the return-current boundary',Math.hypot(s.x,s.z).toFixed(1));
  const fx=Math.sin(s.yaw),fz=-Math.cos(s.yaw);
  ok(fx*(-s.x)+fz*(-s.z)>0,'arrival faces inward, away from the world boundary');
}

console.log('\n== 1b. the presentation floor keeps negative space ==');
{
  const s=ABYSS_ENCOUNTER_SITE, cs=WORLD.CHUNK_SIZE;
  const loX=Math.floor((s.x-s.stageRadius)/cs),hiX=Math.floor((s.x+s.stageRadius)/cs);
  const loZ=Math.floor((s.z-s.stageRadius)/cs),hiZ=Math.floor((s.z+s.stageRadius)/cs);
  let routineGlow=0,dark=0,signature=0;
  for(let cz=loZ;cz<=hiZ;cz++)for(let cx=loX;cx<=hiX;cx++){
    const r=generateScatterForChunk(cx,cz,0),u8=new Uint8Array(r.instances.buffer);
    for(let i=0;i<r.count;i++){
      const o=i*SCATTER_FLOATS_PER_INSTANCE;
      const x=cx*cs+r.instances[o+3],z=cz*cs+r.instances[o+11];
      if(!insideAbyssEncounterFootprint(x,z))continue;
      const type=SCATTER_TYPES[u8[i*SCATTER_STRIDE+61]];
      if(type.signatureBiome!==undefined)signature++;
      else if(type.emissive>0)routineGlow++;
      else dark++;
    }
  }
  ok(routineGlow===0,'routine emissive scatter is absent from the encounter floor',`${routineGlow} lights`);
  ok(dark>0,'dark lamp-revealed formations remain in the presentation volume',`${dark} instances`);
  ok(signature>0,'rare biome-signature landmarks remain exempt',`${signature} instances`);
}

console.log('\n== 2. encounter escalates visually and never attacks during staging ==');
const sim=new CreatureSim(null,{seed:WORLD.DEFAULT_SEED,capacity:8});
const encounter=new AbyssEncounter(sim);
const focus=Float32Array.of(ABYSS_ENCOUNTER_SITE.x,ABYSS_ENCOUNTER_SITE.y,ABYSS_ENCOUNTER_SITE.z);
sim.spawn(speciesIndexOf('CRT_COPPERSPRAT'),focus[0]+12,focus[1],focus[2]);
const phases=new Set();
let minDist=Infinity,maxDist=0,stagedAttack=false,maxSpeed=0,maxTravelSpeed=0;
let lastX=0,lastY=0,lastZ=0,haveLast=false;
for(let n=0;n<240;n++){
  encounter.update(0.1,focus);
  phases.add(encounter.phase);
  const i=sim.slotOf(encounter.handle);
  if(i>=0){
    const d=Math.hypot(sim.posX[i]-focus[0],sim.posY[i]-focus[1],sim.posZ[i]-focus[2]);
    minDist=Math.min(minDist,d);maxDist=Math.max(maxDist,d);
    maxSpeed=Math.max(maxSpeed,Math.hypot(sim.velX[i],sim.velY[i],sim.velZ[i]));
    if(haveLast)maxTravelSpeed=Math.max(maxTravelSpeed,
      Math.hypot(sim.posX[i]-lastX,sim.posY[i]-lastY,sim.posZ[i]-lastZ)/0.1);
    lastX=sim.posX[i];lastY=sim.posY[i];lastZ=sim.posZ[i];haveLast=true;
    stagedAttack ||= sim.behaviour[i]!==BEHAVIOUR.IDLE || sim.threat[i]!==0;
  }
}
ok(sim.liveSlots().length===1,'director clears ambient fauna and guarantees one encounter animal');
const slot=sim.slotOf(encounter.handle);
ok(slot>=0 && sim.species[slot]===speciesIndexOf('LEV_PALEHERALD'),'the encounter animal is the authored Pale Herald');
ok(phases.has(ABYSS_ENCOUNTER_PHASE.OMEN) &&
  phases.has(ABYSS_ENCOUNTER_PHASE.DISTANT_CROSSING) &&
  phases.has(ABYSS_ENCOUNTER_PHASE.CLOSE_CROSSING),
  'sequence visits omen, distant silhouette and close crossing');
ok(maxDist>150 && minDist>=55 && minDist<70,'reveal closes from darkness without colliding',`${maxDist.toFixed(1)} -> ${minDist.toFixed(1)} m`);
ok(maxSpeed<=19.001,'authored motion never exceeds Pale Herald burst speed',`${maxSpeed.toFixed(2)} m/s`);
ok(maxTravelSpeed<=19.001,'world-space path itself contains no hidden phase jump',`${maxTravelSpeed.toFixed(2)} m/s`);
ok(!stagedAttack,'staging cannot damage or pursue the player');
ok(encounter.completed && encounter.phase===ABYSS_ENCOUNTER_PHASE.RELEASED,'the same animal is handed back to normal AI');

console.log('\n== 3. reset makes the demo repeatable without accumulating leviathans ==');
encounter.reset();
ok(sim.liveSlots().length===0 && !encounter.completed,'reset retires the authored animal and re-arms the sequence');
encounter.update(0.1,focus);
ok(sim.liveSlots().length===1,'a repeat jump starts one fresh reveal');

console.log(`\n${fails?`FAILED: ${fails}`:'All abyss encounter checks passed.'}`);
process.exitCode=fails?1:0;
