import type { Rect } from './types';

export interface AABB {
  cx: number;
  cy: number;
  hw: number;
  hh: number;
}

function aabbBounds(box: AABB) {
  return {
    left: box.cx - box.hw,
    right: box.cx + box.hw,
    top: box.cy - box.hh,
    bottom: box.cy + box.hh,
  };
}

export function rectBounds(r: Rect) {
  return { left: r.x, right: r.x + r.w, top: r.y, bottom: r.y + r.h };
}

export function overlaps(box: AABB, r: Rect): boolean {
  const b = aabbBounds(box);
  const s = rectBounds(r);
  return b.left < s.right && b.right > s.left && b.top < s.bottom && b.bottom > s.top;
}
