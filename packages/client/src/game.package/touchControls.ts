// fallow-ignore-file coverage-gaps -- builds PixiJS display objects and binds pointer events; needs a real canvas
import type { PlayerInput } from '@kaede/shared';
import { Circle, Container, Graphics, Text, TextStyle } from 'pixi.js';

// Directional pad (bottom-left): four buttons in a diamond/cross. Smaller than
// the jump button so the diamond fits the corner and adjacent HIT areas never
// overlap. Adjacent pad buttons sit PAD_SPACING * sqrt(2) apart, so the
// no-overlap rule is PAD_SPACING * sqrt(2) >= 2 * PAD_HIT_RADIUS.
const PAD_BTN_RADIUS = 48;
const PAD_HIT_RADIUS = PAD_BTN_RADIUS * 1.25; // 60; fat-finger tolerance, no overlap
const PAD_SPACING = 90; // 90 * sqrt(2) ~= 127 >= 2 * 60 = 120, so hit areas clear

// Jump button (bottom-right): standalone, so it keeps the larger size and the
// original generous hit multiplier.
const JUMP_BTN_RADIUS = 64;
const JUMP_HIT_RADIUS = JUMP_BTN_RADIUS * 1.4; // oversized for fat-finger tolerance

// The overlay was designed on a 1280x720 canvas; now that the canvas follows
// the window (Phase 4.5 増分②), layout() re-anchors the two clusters to the
// window corners at the design offsets, and shrinks them proportionally on
// windows smaller than the design so the pad and the jump button never
// collide or leave the screen.
const DESIGN_W = 1280;
const DESIGN_H = 720;
const PAD_ANCHOR_X = 160; // pad center, from the left edge
const PAD_ANCHOR_Y = 160; // pad center, from the bottom edge
const JUMP_ANCHOR_X = 110; // jump center, from the right edge
const JUMP_ANCHOR_Y = 120; // jump center, from the bottom edge

const BTN_COLOR = 0xeceff4;
const IDLE_ALPHA = 0.35;
const PRESSED_ALPHA = 0.7;

const GLYPH_STYLE = new TextStyle({ fill: 0x10131b, fontSize: 36, fontFamily: 'sans-serif' });
const JUMP_STYLE = new TextStyle({ fill: 0x10131b, fontSize: 24, fontFamily: 'sans-serif' });

/**
 * A single round button. Each button owns its own pointer handlers, so holding
 * one (e.g. ▶) while tapping another (e.g. ▲) works for free: Pixi delivers a
 * separate pointer stream per touch point.
 *
 * Note: a finger that slides off one button onto another without lifting fires
 * pointerupoutside on the first but no pointerdown on the second (the second
 * never saw a fresh press), so the press does not transfer. Acceptable.
 */
function createButton(
  cx: number,
  cy: number,
  glyph: string,
  btnRadius: number,
  hitRadius: number,
  style: TextStyle,
): { node: Container; pressed: () => boolean } {
  const node = new Container();
  node.position.set(cx, cy);

  const circle = new Graphics().circle(0, 0, btnRadius).fill(BTN_COLOR);
  circle.alpha = IDLE_ALPHA;

  const label = new Text({ text: glyph, style });
  label.anchor.set(0.5);
  label.alpha = IDLE_ALPHA;

  node.addChild(circle, label);

  node.eventMode = 'static';
  node.hitArea = new Circle(0, 0, hitRadius);

  let down = false;
  const press = () => {
    down = true;
    circle.alpha = PRESSED_ALPHA;
    label.alpha = PRESSED_ALPHA;
  };
  const release = () => {
    down = false;
    circle.alpha = IDLE_ALPHA;
    label.alpha = IDLE_ALPHA;
  };

  node.on('pointerdown', press);
  node.on('pointerup', release);
  node.on('pointerupoutside', release);
  node.on('pointercancel', release);

  return { node, pressed: () => down };
}

/** Screen-space touch overlay: a 4-way pad bottom-left, JUMP bottom-right. */
export function createTouchControls(): {
  container: Container;
  /** Re-anchors (and, below the design size, shrinks) the clusters for a window of width x height CSS pixels. */
  layout(width: number, height: number): void;
  sample(): PlayerInput;
  dispose(): void;
} {
  const container = new Container();

  // Two anchored clusters: the buttons sit at offsets from their cluster's
  // center, and layout() places (and scales) the clusters — so a resize
  // never has to know about individual buttons.
  const pad = new Container();
  const jumpCluster = new Container();

  const padBtn = (dx: number, dy: number, glyph: string) =>
    createButton(dx, dy, glyph, PAD_BTN_RADIUS, PAD_HIT_RADIUS, GLYPH_STYLE);

  const left = padBtn(-PAD_SPACING, 0, '◀');
  const right = padBtn(PAD_SPACING, 0, '▶');
  const up = padBtn(0, -PAD_SPACING, '▲');
  const down = padBtn(0, PAD_SPACING, '▼');
  const jump = createButton(0, 0, 'JUMP', JUMP_BTN_RADIUS, JUMP_HIT_RADIUS, JUMP_STYLE);

  pad.addChild(left.node, right.node, up.node, down.node);
  jumpCluster.addChild(jump.node);
  container.addChild(pad, jumpCluster);

  return {
    container,
    layout(width, height) {
      // Cap at 1: larger windows keep the design size (the buttons serve
      // thumb reach, not display area); smaller ones shrink proportionally.
      const t = Math.min(1, width / DESIGN_W, height / DESIGN_H);
      pad.scale.set(t);
      pad.position.set(PAD_ANCHOR_X * t, height - PAD_ANCHOR_Y * t);
      jumpCluster.scale.set(t);
      jumpCluster.position.set(width - JUMP_ANCHOR_X * t, height - JUMP_ANCHOR_Y * t);
    },
    sample: () => ({
      left: left.pressed(),
      right: right.pressed(),
      up: up.pressed(),
      down: down.pressed(),
      jump: jump.pressed(),
    }),
    dispose: () => {
      container.destroy({ children: true });
    },
  };
}
