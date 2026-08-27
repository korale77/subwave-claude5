/** Default-seed staging for the fixed visual Pale Herald encounter. */
export const ABYSS_ENCOUNTER_SITE = Object.freeze({
  name: 'Pale Herald Encounter',
  short: 'dread',
  x: 2016,
  y: -900,
  z: 1920,
  seabedY: -1044.5451573212845,
  stageRadius: 220,
  stageTopY: -800,
  stageBottomY: -1080,
  // Face inward toward the world centre, keeping the entire reveal away from
  // the return-current boundary that surrounds the outer abyss.
  yaw: Math.atan2(-2016, 1920),
  pitch: 0,
});

/** Presentation exclusion: the reveal needs black negative space around one animal. */
export function insideAbyssEncounterStage(x, y, z, margin = 0) {
  if (y > ABYSS_ENCOUNTER_SITE.stageTopY + margin ||
      y < ABYSS_ENCOUNTER_SITE.stageBottomY - margin) return false;
  const dx=x-ABYSS_ENCOUNTER_SITE.x, dz=z-ABYSS_ENCOUNTER_SITE.z;
  const r=ABYSS_ENCOUNTER_SITE.stageRadius+margin;
  return dx*dx+dz*dz < r*r;
}

export function insideAbyssEncounterFootprint(x, z, margin = 0) {
  const dx=x-ABYSS_ENCOUNTER_SITE.x, dz=z-ABYSS_ENCOUNTER_SITE.z;
  const r=ABYSS_ENCOUNTER_SITE.stageRadius+margin;
  return dx*dx+dz*dz < r*r;
}
