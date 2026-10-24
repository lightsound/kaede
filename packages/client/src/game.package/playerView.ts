// fallow-ignore-file coverage-gaps -- builds one player's PixiJS display objects (avatar, name, status and zone lines, overheads), and the unit-test setup has no browser or DOM; the pose-priority rule here (poseDirective) is asserted end to end by gesture.spec.ts, and the labels and overheads by the status, zone, chat, reaction and display-name specs

// One player as the scene draws it: the avatar, the name label above it,
// the persistent status and zone lines under it, and the transient
// overheads (speech bubble, reaction). Local and remote players share this
// one shape; GameApp.ts decides where each view stands and what it shows.
import { PLAYER_HALF_H } from '@kaede/shared';
import { Container, Text, TextStyle } from 'pixi.js';
import {
  type AvatarSheetTextures,
  type AvatarView,
  createAvatarView,
  type GestureKit,
  type HeldItemDisplay,
} from './avatarView';
import { type Bubble, createBubble, createReactionBadge, type ReactionBadge } from './bubble';

const NAME_STYLE = new TextStyle({ fill: 0xffffff, fontSize: 13, fontFamily: 'sans-serif' });

/**
 * The standing-still pose an avatar should hold: the explicit gesture
 * outranks the status-derived sleep (the ①c priority rule; rendered
 * motion outranks both, inside avatarView).
 */
export function poseDirective(
  gesture: string | undefined,
  availability: string | undefined,
): string | undefined {
  return gesture ?? (availability === 'away' ? 'sleep' : undefined);
}

export interface PlayerView {
  root: Container;
  /**
   * The avatar visual, wrapped in a Container kept at unit scale so the
   * facing flip stays `body.scale.x = facing` — the sprite inside carries
   * its own scale and ground anchor, and mixing the two on one node would
   * make the flip erase them.
   */
  body: Container;
  /** The pose-frame avatar inside `body` (Phase 5 増分①a); animated every frame. */
  avatar: AvatarView;
  label: Text;
  /** The status line under the avatar, hidden while the status is default (setUnderline). */
  status: Text;
  /** The zone occupancy tag under the status line, hidden while in no zone (setUnderline). */
  zone: Text;
  /** The speech bubble, hidden until this player chats (showBubble). */
  bubble: Bubble;
  /** The emoji reaction, hidden until this player reacts (showReaction). */
  reaction: ReactionBadge;
}

// The status line (ROADMAP Phase 2): dimmer and smaller than the name so
// the name stays the anchor. It sits UNDER the avatar — the slot above the
// name belongs to the transient overheads (bubble, reaction stack), and a
// persistent line there would collide with both.
const STATUS_STYLE = new TextStyle({ fill: 0xb8c2d9, fontSize: 11, fontFamily: 'sans-serif' });

// The zone occupancy tag (ROADMAP Phase 3 増分②): the status line's twin,
// one slot further down so the two persistent lines never collide.
const ZONE_TAG_STYLE = new TextStyle({ fill: 0x9ccfd8, fontSize: 11, fontFamily: 'sans-serif' });

/**
 * One persistent under-avatar line (the status at PLAYER_HALF_H+4, the
 * zone tag at +20), parked at `y` and hidden until a value arrives.
 */
function createUnderline(style: TextStyle, y: number): Text {
  const line = new Text({ text: '', style });
  line.anchor.set(0.5, 0);
  line.y = y;
  line.visible = false;
  return line;
}

/**
 * A labelled avatar view parented under the world container. The visual is
 * the pose-frame avatar (Phase 5 増分①a — one AI-generated character as a
 * stand + walk pose sheet, frame-swapped by avatarView.ts), grounded on the
 * physics AABB: the AABB stays the authority for collision and every
 * overlay anchor, and the frames are only how that box looks. Local and
 * remote players share the one character — the name label and the camera
 * (which follows the local player) are what tell people apart until the
 * dress-up increments.
 */
export function createPlayerView(
  world: Container,
  name: string,
  sheet: AvatarSheetTextures,
  held?: HeldItemDisplay,
  kit?: GestureKit,
): PlayerView {
  const root = new Container();
  const body = new Container();
  const avatar = createAvatarView(body, sheet, held, kit);
  const label = new Text({ text: name, style: NAME_STYLE });
  label.anchor.set(0.5, 1);
  label.y = -PLAYER_HALF_H - 4;
  const status = createUnderline(STATUS_STYLE, PLAYER_HALF_H + 4);
  const zone = createUnderline(ZONE_TAG_STYLE, PLAYER_HALF_H + 20);
  const bubble = createBubble();
  const reaction = createReactionBadge();
  root.addChild(body, label, status, zone, bubble.root, reaction.root);
  world.addChild(root);
  return { root, body, avatar, label, status, zone, bubble, reaction };
}

/**
 * Applies one composed persistent line (statusLabel / zoneTagLabel in
 * @kaede/shared, undefined while default) to its Text. Unlike the
 * transient overheads there is no timer: both lines are state, visible
 * until the next row event replaces them.
 */
export function setUnderline(line: Text, value: string | undefined): void {
  line.visible = value !== undefined;
  line.text = value ?? '';
}
