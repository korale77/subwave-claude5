// SUBWAVE - the oversized-triangle fullscreen vertex shader.
//
// Every post, composite and LUT pass shares this. Draw with 3 vertices and no
// vertex buffer (FULLSCREEN_VERTEX_COUNT in pipelines.js).
//
// One oversized triangle, not two triangles: along a quad's shared diagonal the
// rasteriser packs helper lanes from both triangles into the same 2x2 quad, so
// derivatives and any quad-wide operation are wrong on that seam, and the seam
// pixels get shaded twice.

#pragma once

#include "frame.wgsl"
#include "math.wgsl"

struct FSOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
};

/// Vertices are (-1,1), (-1,-3), (3,1) in NDC - the smallest triangle that
/// covers the clip cube. The UVs run to 2 and are clipped back to exactly
/// [0,1] across the viewport.
///
/// UV origin is TOP-LEFT: uv.y = 0 is NDC y = +1. That matches WebGPU's
/// framebuffer and texture coordinate convention, so `uv` may be handed
/// straight to textureSample or scaled by frame.screen.xy to get pixels.
///
/// Clip z is 0.0 - the far plane under reverse-Z, and equal to
/// DEPTH_CLEAR_VALUE. A pass that binds a depth target with
/// `depthCompare: 'greater-equal'` therefore draws only where nothing was
/// rendered, which is what the sky pass needs. Passes that composite over the
/// whole screen disable the depth test instead.
///
/// Emitted counter-clockwise in NDC so a pipeline that inherits the engine's
/// default `Primitive.triangles` (cullMode 'back', frontFace 'ccw') still
/// draws it. Fullscreen passes should still prefer `Primitive.trianglesNoCull`
/// - relying on winding for a pass that has no inside is a trap.
@vertex
fn vs_fullscreen(@builtin(vertex_index) vi: u32) -> FSOut {
  let x = f32(vi & 2u);           // 0, 0, 2
  let y = f32((vi << 1u) & 2u);   // 0, 2, 0
  var out: FSOut;
  out.uv = vec2f(x, y);
  out.pos = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
  return out;
}

/// Integer pixel coordinate from the fragment's @builtin(position), for
/// textureLoad and for blueNoise(). Fragment position is already in pixels at
/// the sample centre, so truncation gives the pixel index.
fn fsPixelCoord(pos: vec4f) -> vec2u {
  return vec2u(pos.xy);
}

/// Unit world-space ray from the camera through a fullscreen UV. Built from
/// the camera basis rather than invViewProj because the frustum is symmetric
/// and this stays exact while costing three fused multiply-adds.
///
/// Note this uses the UNJITTERED basis vectors: TAA jitter lives in
/// frame.proj, and a jittered ray would make depth reconstruction and
/// raymarched skies wobble against the geometry they must line up with.
fn fsViewRay(uv: vec2f) -> vec3f {
  return viewRayFromUV(uv, frame.cameraFwd.xyz, frame.cameraRight.xyz, frame.cameraUp.xyz,
                       frame.cameraFwd.w, frame.cameraRight.w);
}
