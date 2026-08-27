/**
 * SUBWAVE - the material-slot emission maps, mirrored out of the shaders.
 *
 * THESE ARE DUPLICATES OF NUMBERS THAT LIVE IN WGSL, and check.mjs cannot see
 * across that boundary at all. The glow pass has to know, on the CPU, how much
 * of a mesh's emissive area actually reaches the screen - because a sprite whose
 * flux disagrees with the geometry it sits on is a sprite that pops as the
 * geometry resolves. tools/test-glow.mjs parses `s.glow = <literal>` out of
 * pass/creature.wgsl and the `slotEmissiveGate` switch out of pass/scatter.wgsl
 * and asserts they equal what is here; that test is the only thing standing
 * between these tables and silent drift.
 *
 * Slot ids are world/meshgen.js's MESH_MATERIAL, 0..7, which both shaders index
 * with the same 3-bit field.
 */

/**
 * Creature material slot -> the constant `s.glow` its surface function sets in
 * pass/creature.wgsl. Multiplies the species' bioluminescent radiance, so it is
 * exactly the factor by which a photophore on that slot contributes to the
 * animal's emitted flux.
 *
 * ROCK, FLORA and SEDIMENT all fall through to skinSurface(), which is 1.0.
 * CRYSTAL is the one entry that is not a literal in the shader: eyeSurface()
 * sets `0.25 + 0.75 * grazing`, and 0.5 is its PROJECTED-AREA-weighted view
 * mean, not its arithmetic one. For a convex body with the normal uniform over
 * the visible hemisphere the flux weight is cos(theta), so
 * <cos> = 1/2, <cos^2> = 1/3 and the weighted <grazing> = 1 - (1/3)/(1/2) = 1/3,
 * giving 0.25 + 0.75/3 = 0.5. The unweighted mean would be 0.625; flux is what
 * this table is used to compute, so the weighted one is the right average.
 */
export const SLOT_GLOW = [
  1.0,    // 0 ROCK        -> skinSurface
  1.0,    // 1 FLORA       -> skinSurface (skin, mantle, muscle)
  0.6,    // 2 TRANSLUCENT -> finSurface
  1.0,    // 3 EMISSIVE    -> photophoreSurface
  0.5,    // 4 CRYSTAL     -> eyeSurface, view-averaged (see above)
  0.35,   // 5 BONE        -> carapaceSurface
  1.0,    // 6 SEDIMENT    -> skinSurface
  0.2,    // 7 METAL       -> armourSurface
];

/** The one SLOT_GLOW entry that is a shader EXPRESSION rather than a literal. */
export const SLOT_GLOW_EXPRESSION_SLOT = 4;

/**
 * Scatter material slot -> `slotEmissiveGate(m)` in pass/scatter.wgsl. The share
 * of a type's authored emission that the slot is responsible for: a mushroom's
 * stem does not glow, an ore body's light comes out of its veins.
 */
export const SLOT_EMISSIVE_GATE = [
  0.05,   // 0 ROCK        (default)
  0.05,   // 1 FLORA       (default)
  0.20,   // 2 TRANSLUCENT - a lit tip on a sea whip
  1.00,   // 3 EMISSIVE
  0.85,   // 4 CRYSTAL
  0.05,   // 5 BONE        (default)
  0.05,   // 6 SEDIMENT    (default)
  0.35,   // 7 METAL       - vein glow
];

/**
 * Scatter material slot -> the AREA-WEIGHTED MEAN of the fragment-varying
 * `s.glow` its surface function produces, with the respiration pulse factored
 * out (the caller multiplies that in per type, because it is zero for a mineral
 * vein and 0.55 rad/s for living tissue).
 *
 * THIS IS A MEAN FIELD, AND IT IS THE ONE APPROXIMATION IN THE SPRITE'S FLUX.
 * Unlike the creature table above, scatter's `s.glow` is not a constant per
 * slot - it is a function of the normal, the uv and object-space noise - so a
 * CPU bake can only reproduce its mean. Each entry is derived, not fitted:
 *
 *   EMISSIVE  glowSurface: 0.35 + 0.90*<under>*<mix(0.5, gill, gate)>
 *             + 0.30*<uv.y>. `under` is saturate(-1.4*N.y), whose area-weighted
 *             mean over a closed body is (1/2)*int_0^1 min(1.4u, 1) du = 0.3214;
 *             `gill` is a sine and averages 0.5 whatever the band gate does;
 *             <uv.y> = 0.5. -> 0.35 + 0.1446 + 0.15 = 0.6446.
 *   CRYSTAL   crystalSurface: 0.45 + 0.85*<grazing^2> + 0.25*<band>. Weighted by
 *             cos(theta) as above, <(1-cos)^2> = (1/2 - 2/3 + 1/4)/(1/2) = 1/6;
 *             a 7-step terrace of a near-uniform variable averages 0.5.
 *             -> 0.45 + 0.1417 + 0.125 = 0.7167.
 *   METAL     mineralSurface's veinGlow = saturate(0.30 + 0.70*(1 - mottle))
 *             with <mottle> = 0.5 -> 0.65. (The tissue branch is selected by the
 *             type's fluorescence flag, which no ore carries.)
 *   TRANSLUC. frondSurface: uv.y^2 -> 1/3.
 *   FLORA     floraSurface: saturate(uv.y) -> 0.5.
 *   BONE      boneSurface: 0.4 + 0.6*<pore>; the worley shell covers ~8% ->0.45.
 *   ROCK/SED  mineralSurface, same as METAL.
 *
 * The residual uncertainty is roughly +/-20% on the aureole's absolute
 * brightness, which is well inside the 4x range the population spans and cannot
 * break energy conservation: the halo is additive and the geometry gives nothing
 * back for it, so an error here changes how bright a halo is and never whether
 * light is double-counted.
 */
export const SLOT_GLOW_MEAN = [
  0.65,   // 0 ROCK
  0.50,   // 1 FLORA
  0.3333, // 2 TRANSLUCENT
  0.6446, // 3 EMISSIVE
  0.7167, // 4 CRYSTAL
  0.45,   // 5 BONE
  0.65,   // 6 SEDIMENT
  0.65,   // 7 METAL
];
