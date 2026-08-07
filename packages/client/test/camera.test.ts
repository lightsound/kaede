import { describe, expect, it } from 'vitest';
import { cameraOffset } from '../src/game.package/camera';

// A 1000x600 world seen through an 800x400 viewport: 200px of horizontal and
// 200px of vertical scroll before the camera hits an edge.
const VIEW_W = 800;
const VIEW_H = 400;
const WORLD_W = 1000;
const WORLD_H = 600;

const offset = (focusX: number, focusY: number) =>
  cameraOffset(focusX, focusY, VIEW_W, VIEW_H, WORLD_W, WORLD_H);

describe('cameraOffset', () => {
  it('centers the focus while away from every edge', () => {
    expect(offset(500, 300)).toEqual({ x: -100, y: -100 });
  });

  it('clamps at the top-left so the world edge is never crossed', () => {
    expect(offset(0, 0)).toEqual({ x: -0, y: -0 });
  });

  it('clamps at the bottom-right', () => {
    expect(offset(WORLD_W, WORLD_H)).toEqual({ x: -200, y: -200 });
  });

  it('centers a world smaller than the viewport instead of pinning an edge', () => {
    expect(cameraOffset(50, 50, VIEW_W, VIEW_H, 400, 200)).toEqual({ x: 200, y: 100 });
  });

  it('treats a world exactly the viewport size as centered at zero', () => {
    expect(cameraOffset(50, 50, VIEW_W, VIEW_H, VIEW_W, VIEW_H)).toEqual({ x: 0, y: 0 });
  });
});
