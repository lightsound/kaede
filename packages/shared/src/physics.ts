import type { Rect } from './types';

/** Axis-aligned box described by its center and half extents. */
export interface AABB {
  cx: number;
  cy: number;
  hw: number;
  hh: number;
}

/** Left/right/top/bottom edges of a center+half-extents box. */
export function aabbBounds(box: AABB) {
  return {
    left: box.cx - box.hw,
    right: box.cx + box.hw,
    top: box.cy - box.hh,
    bottom: box.cy + box.hh,
  };
}

/** Left/right/top/bottom edges of a top-left+size rectangle. */
export function rectBounds(r: Rect) {
  return { left: r.x, right: r.x + r.w, top: r.y, bottom: r.y + r.h };
}

/** A center+half-extents box as a top-left+size Rect (the same span, re-expressed). */
export function aabbToRect(box: AABB): Rect {
  return { x: box.cx - box.hw, y: box.cy - box.hh, w: box.hw * 2, h: box.hh * 2 };
}

/** True when a center+half-extents box overlaps a top-left+size rect. */
export function overlaps(box: AABB, r: Rect): boolean {
  const b = aabbBounds(box);
  const s = rectBounds(r);
  return b.left < s.right && b.right > s.left && b.top < s.bottom && b.bottom > s.top;
}
