// fallow-ignore-file coverage-gaps -- builds PixiJS display objects against a live canvas (the touchControls precedent); the lifetime constants it applies are shared and the e2e chat/reaction specs assert the show/expire behavior end to end

// The transient displays above a player's avatar: the speech bubble (chat)
// and the emoji reaction (ROADMAP Phase 2). One module because they share
// the overhead lifecycle — hidden until shown, hidden again once their
// display window elapses — and the stacking rule when both are visible at
// once (see layoutReaction).
import {
  CHAT_BUBBLE_DURATION_MS,
  PLAYER_HALF_H,
  REACTION_DURATION_MS,
  type ReactionEmoji,
} from '@kaede/shared';
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

const BOX = {
  color: 0xf4f6fa,
  padX: 6,
  padY: 4,
  bottomY: -PLAYER_HALF_H - 24,
} as const;

const REACTION_STYLE = new TextStyle({ fontSize: 24, fontFamily: 'sans-serif' });

const REACTION_STACK_GAP = 4;

/**
 * The shared shape of one overhead display: a container that is hidden
 * until shown and hides again once its display window elapses. `expiresAt`
 * is checked from the frame loop rather than armed as a setTimeout so
 * there is no timer to cancel on the many paths that destroy a view
 * (remove, clear, app teardown).
 */
export interface Overhead {
  root: Container;
  expiresAt: number;
}

function armOverhead(overhead: Overhead, nowMs: number, durationMs: number): void {
  overhead.root.visible = true;
  overhead.expiresAt = nowMs + durationMs;
}

export function expireOverhead(overhead: Overhead, nowMs: number): void {
  if (overhead.root.visible && nowMs >= overhead.expiresAt) overhead.root.visible = false;
}

export interface Bubble extends Overhead {
  bg: Graphics;
  text: Text;
  topY: number;
}

export function createBubble(): Bubble {
  const bg = new Graphics();
  const text = new Text({ text: '', style: TEXT_STYLE });
  text.anchor.set(0.5, 1);
  text.y = BOX.bottomY - BOX.padY;
  const root = new Container();
  root.visible = false;
  root.addChild(bg, text);
  return { root, bg, text, expiresAt: 0, topY: BOX.bottomY };
}

export function showBubble(bubble: Bubble, text: string, nowMs: number): void {
  bubble.text.text = text;
  const w = bubble.text.width + BOX.padX * 2;
  const h = bubble.text.height + BOX.padY * 2;
  bubble.topY = BOX.bottomY - h;
  bubble.bg
    .clear()
    .roundRect(-w / 2, bubble.topY, w, h, 6)
    .fill(BOX.color);
  armOverhead(bubble, nowMs, CHAT_BUBBLE_DURATION_MS);
}

export function visibleBubbleText(bubble: Bubble): string | undefined {
  return bubble.root.visible ? bubble.text.text : undefined;
}

export interface ReactionBadge extends Overhead {
  text: Text;
}

export function createReactionBadge(): ReactionBadge {
  const text = new Text({ text: '', style: REACTION_STYLE });
  text.anchor.set(0.5, 1);
  const root = new Container();
  root.visible = false;
  root.addChild(text);
  return { root, text, expiresAt: 0 };
}

export function showReaction(badge: ReactionBadge, emoji: ReactionEmoji, nowMs: number): void {
  badge.text.text = emoji;
  armOverhead(badge, nowMs, REACTION_DURATION_MS);
}

export function visibleReactionEmoji(badge: ReactionBadge): string | undefined {
  return badge.root.visible ? badge.text.text : undefined;
}

/**
 * Places the reaction relative to the bubble, resolving the collision when
 * both are visible: each alone sits in the same slot above the name label,
 * together the reaction stacks on top of the bubble — the bubble is prose
 * that needs its spot to stay readable, while the emoji stays legible
 * anywhere. Called every frame (the expire pass) because the bubble can
 * appear, resize or expire mid-display and the reaction must follow.
 */
export function layoutReaction(badge: ReactionBadge, bubble: Bubble): void {
  badge.text.y = bubble.root.visible ? bubble.topY - REACTION_STACK_GAP : BOX.bottomY;
}
