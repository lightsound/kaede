// fallow-ignore-file coverage-gaps -- draws PixiJS graphics for the huddle layer; needs a WebGL canvas. The membership, labels and geometry rules live in @kaede/shared (zone.ts), unit-tested there
import { PLAYER_HALF_H } from '@kaede/shared';
import { type Container, Graphics, Text, TextStyle } from 'pixi.js';

/**
 * One 立ち話グループ as the renderer draws it (ROADMAP Phase 3 増分③).
 * Unlike a zone there is no rect: the circle follows the members' avatars,
 * so the net stack's feed hands the renderer the member IDENTITIES and the
 * renderer resolves their sprite positions every frame — the huddle moves
 * as smoothly as the people in it.
 */
export interface HuddleRender {
  /** The group row id, stringified — a stable identity for the view map. */
  key: string;
  /** The composed label (huddleLabel in @kaede/shared — 🤫 rides it when closed). */
  label: string;
  closed: boolean;
  /** Whether the local player is a member (its sprite anchors the circle too). */
  includesLocal: boolean;
  /** The remote members' identity hexes; sprites may be absent (offline-hidden). */
  memberIds: readonly string[];
}

/**
 * One rendered huddle as the e2e hook reports it (E2EWorldSnapshot's
 * inline `huddles` shape — inline here too, so no unused named export and
 * no private type leaking through the returned handle's inferred type).
 */
type HuddleFrame = { label: string; closed: boolean; members: number };

// An open huddle reads as a warm spot on the floor; a closed one shifts to
// a hushed violet — with the 🤫 label, the「コソコソ話している」look.
const HUDDLE_OPEN_COLOR = 0xebcb8b;
const HUDDLE_CLOSED_COLOR = 0xb48ead;

const HUDDLE_LABEL_STYLE = new TextStyle({
  fill: 0xe5e9f0,
  fontSize: 12,
  fontFamily: 'sans-serif',
});

/** The circle's minimum half-width (px): a solo huddle still reads as a spot. */
const HUDDLE_MIN_RADIUS = 70;
/** Horizontal padding past the farthest member (px). */
const HUDDLE_RADIUS_PAD = 50;
/** The floor ellipse is this fraction as tall as it is wide. */
const HUDDLE_ELLIPSE_FLATTEN = 0.35;

interface HuddleView {
  gfx: Graphics;
  label: Text;
}

/** The members' rendered footprint: center x/y and the farthest x-offset. */
function huddleFootprint(positions: readonly { x: number; y: number }[]): {
  cx: number;
  cy: number;
  spread: number;
} {
  let sumX = 0;
  let sumY = 0;
  for (const p of positions) {
    sumX += p.x;
    sumY += p.y;
  }
  const cx = sumX / positions.length;
  const cy = sumY / positions.length;
  let spread = 0;
  for (const p of positions) spread = Math.max(spread, Math.abs(p.x - cx));
  return { cx, cy, spread };
}

/**
 * Owns the huddle layer's Pixi children: `set` reconciles one Graphics +
 * label pair per huddle (row-event cadence), `renderFrame` repositions
 * them from the members' CURRENT sprite positions (frame cadence — the
 * circle follows the avatars), and `snapshot` reports what the last frame
 * actually drew, for the e2e hook. Members whose sprites are absent
 * (offline-hidden, mid-subscription-swap) simply don't anchor the circle;
 * a huddle with no resolvable sprite this frame hides.
 */
export function createHuddleLayer(
  layer: Container,
  resolvePositions: (huddle: HuddleRender) => readonly { x: number; y: number }[],
) {
  let huddles: readonly HuddleRender[] = [];
  const views = new Map<string, HuddleView>();
  let lastFrame: HuddleFrame[] = [];

  function createView(key: string): HuddleView {
    const gfx = new Graphics();
    const label = new Text({ text: '', style: HUDDLE_LABEL_STYLE });
    label.anchor.set(0.5, 1);
    layer.addChild(gfx, label);
    const view = { gfx, label };
    views.set(key, view);
    return view;
  }

  function drawView(
    view: HuddleView,
    huddle: HuddleRender,
    positions: readonly { x: number; y: number }[],
  ): void {
    const { cx, cy, spread } = huddleFootprint(positions);
    const rx = Math.max(HUDDLE_MIN_RADIUS, spread + HUDDLE_RADIUS_PAD);
    const color = huddle.closed ? HUDDLE_CLOSED_COLOR : HUDDLE_OPEN_COLOR;
    view.gfx
      .clear()
      .ellipse(cx, cy + PLAYER_HALF_H, rx, rx * HUDDLE_ELLIPSE_FLATTEN)
      .fill({ color, alpha: 0.12 })
      .ellipse(cx, cy + PLAYER_HALF_H, rx, rx * HUDDLE_ELLIPSE_FLATTEN)
      .stroke({ color, alpha: 0.6, width: 2 });
    view.gfx.visible = true;
    view.label.text = huddle.label;
    view.label.position.set(cx, cy - PLAYER_HALF_H - 44);
    view.label.visible = true;
  }

  function hideView(view: HuddleView): void {
    view.gfx.clear();
    view.gfx.visible = false;
    view.label.visible = false;
  }

  return {
    set(next: readonly HuddleRender[]): void {
      huddles = next;
      const keep = new Set(next.map((huddle) => huddle.key));
      for (const [key, view] of views) {
        if (keep.has(key)) continue;
        view.gfx.destroy();
        view.label.destroy();
        views.delete(key);
      }
    },
    renderFrame(): void {
      const frame: HuddleFrame[] = [];
      for (const huddle of huddles) {
        const view = views.get(huddle.key) ?? createView(huddle.key);
        const positions = resolvePositions(huddle);
        if (positions.length === 0) {
          hideView(view);
          continue;
        }
        drawView(view, huddle, positions);
        frame.push({ label: huddle.label, closed: huddle.closed, members: positions.length });
      }
      lastFrame = frame;
    },
    snapshot(): { label: string; closed: boolean; members: number }[] {
      return lastFrame;
    },
  };
}
