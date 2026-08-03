// fallow-ignore-file coverage-gaps -- builds PixiJS display objects against a live canvas (the touchControls precedent); the bubble lifetime constant it applies is shared and the e2e chat spec asserts the show/expire behavior end to end
import { CHAT_BUBBLE_DURATION_MS, PLAYER_HALF_H } from '@maple/shared';
import { Container, Graphics, Text, TextStyle } from 'pixi.js';

// Dark text on a light rounded rect, wrapped narrow so a max-length message
// stays a bubble rather than a banner. breakWords because Japanese has no
// spaces to wrap on.
const TEXT_STYLE = new TextStyle({
  fill: 0x10131b,
  fontSize: 12,
  fontFamily: 'sans-serif',
  wordWrap: true,
  wordWrapWidth: 180,
  breakWords: true,
});

/** The bubble box: fill, padding around the text, and where its bottom edge
 * sits (clear of the name label above the avatar). */
const BOX = {
  color: 0xf4f6fa,
  padX: 6,
  padY: 4,
  bottomY: -PLAYER_HALF_H - 24,
} as const;

/** One player's speech bubble (chat — ROADMAP Phase 2), hidden until it speaks. */
export interface Bubble {
  /** Parent this under the player's root container. */
  root: Container;
  bg: Graphics;
  text: Text;
  /** When the visible bubble hides (performance.now() ms); see expireBubble. */
  expiresAt: number;
}

export function createBubble(): Bubble {
  const bg = new Graphics();
  const text = new Text({ text: '', style: TEXT_STYLE });
  text.anchor.set(0.5, 1);
  text.y = BOX.bottomY - BOX.padY;
  const root = new Container();
  root.visible = false;
  root.addChild(bg, text);
  return { root, bg, text, expiresAt: 0 };
}

/** Fills the bubble with `text`, sized to fit, and arms its hide time. */
export function showBubble(bubble: Bubble, text: string, nowMs: number): void {
  bubble.text.text = text;
  const w = bubble.text.width + BOX.padX * 2;
  const h = bubble.text.height + BOX.padY * 2;
  bubble.bg
    .clear()
    .roundRect(-w / 2, BOX.bottomY - h, w, h, 6)
    .fill(BOX.color);
  bubble.root.visible = true;
  bubble.expiresAt = nowMs + CHAT_BUBBLE_DURATION_MS;
}

/**
 * Hides the bubble once its time is up. Checked from the frame loop rather
 * than armed as a setTimeout so there is no timer to cancel on the many
 * paths that destroy a view (remove, clear, app teardown).
 */
export function expireBubble(bubble: Bubble, nowMs: number): void {
  if (bubble.root.visible && nowMs >= bubble.expiresAt) bubble.root.visible = false;
}

/** The visible bubble's text, or undefined while hidden (the e2e snapshot shape). */
export function visibleBubbleText(bubble: Bubble): string | undefined {
  return bubble.root.visible ? bubble.text.text : undefined;
}
