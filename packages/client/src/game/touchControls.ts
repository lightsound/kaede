import type { PlayerInput } from '@maple/shared';
import { Circle, Container, Graphics, Text, TextStyle } from 'pixi.js';

const BTN_RADIUS = 64;
const HIT_RADIUS = BTN_RADIUS * 1.4; // oversized for fat-finger tolerance
const BTN_Y = 640;
const LEFT_X = 110;
const RIGHT_X = 270;
const JUMP_X = 1170;

const BTN_COLOR = 0xeceff4;
const IDLE_ALPHA = 0.35;
const PRESSED_ALPHA = 0.7;

const GLYPH_STYLE = new TextStyle({ fill: 0x10131b, fontSize: 48, fontFamily: 'sans-serif' });

/**
 * A single round button. Each button owns its own pointer handlers, so holding
 * one (e.g. ▶) while tapping another (e.g. ▲) works for free: Pixi delivers a
 * separate pointer stream per touch point.
 *
 * Note: a finger that slides off one button onto another without lifting fires
 * pointerupoutside on the first but no pointerdown on the second (the second
 * never saw a fresh press), so the press does not transfer. Acceptable.
 */
function createButton(cx: number, glyph: string): { node: Container; pressed: () => boolean } {
  const node = new Container();
  node.position.set(cx, BTN_Y);

  const circle = new Graphics().circle(0, 0, BTN_RADIUS).fill(BTN_COLOR);
  circle.alpha = IDLE_ALPHA;

  const label = new Text({ text: glyph, style: GLYPH_STYLE });
  label.anchor.set(0.5);
  label.alpha = IDLE_ALPHA;

  node.addChild(circle, label);

  node.eventMode = 'static';
  node.hitArea = new Circle(0, 0, HIT_RADIUS);

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

/** Screen-space touch overlay: ◀ ▶ bottom-left, ▲ bottom-right. */
export function createTouchControls(): {
  container: Container;
  sample(): PlayerInput;
  dispose(): void;
} {
  const container = new Container();

  const left = createButton(LEFT_X, '◀');
  const right = createButton(RIGHT_X, '▶');
  const jump = createButton(JUMP_X, '▲');

  container.addChild(left.node, right.node, jump.node);

  return {
    container,
    sample: () => ({
      left: left.pressed(),
      right: right.pressed(),
      jump: jump.pressed(),
    }),
    dispose: () => {
      container.destroy({ children: true });
    },
  };
}
