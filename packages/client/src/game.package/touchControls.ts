// fallow-ignore-file coverage-gaps -- builds PixiJS display objects and binds pointer events; needs a real canvas
import type { PlayerInput } from '@kaede/shared';
import { Circle, Container, Graphics, Text, TextStyle } from 'pixi.js';

// Directional pad (bottom-left): four buttons in a diamond/cross. Smaller than
// the jump button so the diamond fits the corner and adjacent HIT areas never
// overlap. Adjacent pad buttons sit PAD_SPACING * sqrt(2) apart, so the
// no-overlap rule is PAD_SPACING * sqrt(2) >= 2 * PAD_HIT_RADIUS.
const PAD_BTN_RADIUS = 48;
const PAD_HIT_RADIUS = PAD_BTN_RADIUS * 1.25; // 60; fat-finger tolerance, no overlap
const PAD_CX = 160;
const PAD_CY = 560;
const PAD_SPACING = 90; // 90 * sqrt(2) ~= 127 >= 2 * 60 = 120, so hit areas clear

// Jump button (bottom-right): standalone, so it keeps the larger size and the
// original generous hit multiplier.
const JUMP_BTN_RADIUS = 64;
const JUMP_HIT_RADIUS = JUMP_BTN_RADIUS * 1.4; // oversized for fat-finger tolerance
const JUMP_X = 1170;
const JUMP_Y = 600;

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
  sample(): PlayerInput;
  dispose(): void;
} {
  const container = new Container();

  const padBtn = (dx: number, dy: number, glyph: string) =>
    createButton(PAD_CX + dx, PAD_CY + dy, glyph, PAD_BTN_RADIUS, PAD_HIT_RADIUS, GLYPH_STYLE);

  const left = padBtn(-PAD_SPACING, 0, '◀');
  const right = padBtn(PAD_SPACING, 0, '▶');
  const up = padBtn(0, -PAD_SPACING, '▲');
  const down = padBtn(0, PAD_SPACING, '▼');
  const jump = createButton(JUMP_X, JUMP_Y, 'JUMP', JUMP_BTN_RADIUS, JUMP_HIT_RADIUS, JUMP_STYLE);

  container.addChild(left.node, right.node, up.node, down.node, jump.node);

  return {
    container,
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
