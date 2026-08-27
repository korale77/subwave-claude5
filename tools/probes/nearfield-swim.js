// Probe: near-field removal causes and density with the player SWIMMING.
//
//   node tools/probe.mjs --file tools/probes/nearfield-swim.js
//
// The player holds a real W keydown for the whole window and holds depth by
// aiming slightly down, so the position is produced by Player._simulateSwim and
// nothing teleports. Paired with tools/probes/nearfield-stationary.js; the
// difference between the two is the headline number. See
// tools/probes/nearfield-lib.js for what it discriminates.

const { runTrial } = await import('/tools/probes/nearfield-lib.js');
return await runTrial({ swim: true, seconds: 32, fillMs: 12000 });
