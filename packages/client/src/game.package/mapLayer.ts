// fallow-ignore-file coverage-gaps -- draws the map geometry and portals as PixiJS graphics; needs a WebGL canvas. The map data and the rules it draws (collision, portal triggers) live in @kaede/shared (map.ts, physics.ts), unit-tested there

// The static map visuals: the collision geometry and the portals, built
// once per map. GameApp.ts parks the layer at the bottom of the world
// container and rebuilds it whole on every map switch.
import { type CollisionMap, PLAYER_HALF_H, type Portal, type WorldMap } from '@kaede/shared';
import { Container, Graphics, Text, TextStyle } from 'pixi.js';

const SOLID_COLOR = 0x3b4252;
const PLATFORM_COLOR = 0x5e81ac; // one-way platforms: lighter than solid ground
const ROPE_COLOR = 0xd8a657;
const ROPE_WIDTH = 4;

const PORTAL_COLOR = 0x7aa2f7;
// The portal's destination and the up-key affordance, hovering over the gate.
const PORTAL_LABEL_STYLE = new TextStyle({
  fill: 0xbdd3ff,
  fontSize: 12,
  fontFamily: 'sans-serif',
});

/**
 * One portal's visuals: the glowing gate over its trigger area and the
 * destination label (with the up-key affordance) above it.
 */
function drawPortal(layer: Container, portal: Portal): void {
  const { rect } = portal;
  const gate = new Graphics()
    .ellipse(rect.x + rect.w / 2, rect.y + rect.h / 2, rect.w / 2, rect.h / 2)
    .fill({ color: PORTAL_COLOR, alpha: 0.35 })
    .ellipse(rect.x + rect.w / 2, rect.y + rect.h / 2, rect.w / 3, rect.h / 2.6)
    .fill({ color: PORTAL_COLOR, alpha: 0.5 });
  const label = new Text({ text: `↑ ${portal.label}`, style: PORTAL_LABEL_STYLE });
  label.anchor.set(0.5, 1);
  label.position.set(rect.x + rect.w / 2, rect.y - 6);
  layer.addChild(gate, label);
}

/**
 * The collision geometry as one Graphics: ropes hang behind everything;
 * platforms and the ground slab draw on top of them.
 */
function drawCollision(collision: CollisionMap): Graphics {
  const gfx = new Graphics();
  for (const r of collision.ropes) {
    // Visual span: rope.top down to rope.bottom + PLAYER_HALF_H (the lower end
    // rests on a floor, while rope.bottom bounds the climbing player's center).
    gfx
      .rect(r.x - ROPE_WIDTH / 2, r.top, ROPE_WIDTH, r.bottom + PLAYER_HALF_H - r.top)
      .fill(ROPE_COLOR);
  }
  for (const s of collision.solids) gfx.rect(s.x, s.y, s.w, s.h).fill(SOLID_COLOR);
  for (const p of collision.platforms) gfx.rect(p.x, p.y, p.w, p.h).fill(PLATFORM_COLOR);
  return gfx;
}

/**
 * The static map visuals as one Container: the collision geometry with the
 * portals glowing on top. Added to the world before any player view, so
 * the whole map renders behind players — and rebuilt whole by setMap, so a
 * map switch cannot leak the previous map's shapes.
 */
export function buildMapLayer(map: WorldMap): Container {
  const layer = new Container();
  layer.addChild(drawCollision(map.collision));
  for (const portal of map.portals) drawPortal(layer, portal);
  return layer;
}
