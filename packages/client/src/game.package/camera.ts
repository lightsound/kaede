/**
 * Returns the world Container offset that centers (focusX, focusY) in a
 * viewport of view*, clamped so the camera never shows past the world edges.
 * A world smaller than the viewport (a compact map on a wide window, now
 * that the viewport follows the window size) sits centered instead of
 * pinned to an edge.
 */
export function cameraOffset(
  focusX: number,
  focusY: number,
  viewW: number,
  viewH: number,
  worldW: number,
  worldH: number,
): { x: number; y: number } {
  return {
    x: offsetAxis(focusX, viewW, worldW),
    y: offsetAxis(focusY, viewH, worldH),
  };
}

function offsetAxis(focus: number, view: number, world: number): number {
  if (world <= view) return (view - world) / 2;
  return -clamp(focus - view / 2, 0, world - view);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
