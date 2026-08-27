// Probe: near-field removal causes and density with the player PINNED.
//
//   node tools/probe.mjs --file tools/probes/nearfield-stationary.js
//
// The CONTROL for tools/probes/nearfield-swim.js. Same code, same window, the
// only difference is that the position is held at the lagoon census point after
// each simulate. Every previous measurement of the near-field director was made
// this way, so this is the number the "churn while moving" claim has to beat.
// See tools/probes/nearfield-lib.js for what it discriminates.

const { runTrial } = await import('/tools/probes/nearfield-lib.js');
return await runTrial({ swim: false, seconds: 32, fillMs: 12000 });
