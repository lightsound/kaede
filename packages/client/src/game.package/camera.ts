/**
 * Returns the world Container offset that centers (focusX, focusY) in a
 * viewport of view*, clamped so the camera never shows past the world edges.
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
    x: -clamp(focusX - viewW / 2, 0, Math.max(0, worldW - viewW)),
    y: -clamp(focusY - viewH / 2, 0, Math.max(0, worldH - viewH)),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
