// fallow-ignore-file coverage-gaps -- draws PixiJS graphics for the zone layer; needs a WebGL canvas. The zone geometry, labels and occupancy rules live in @kaede/shared (zone.ts), unit-tested there
import type { Rect } from '@kaede/shared';
import { type Container, Graphics, Text, TextStyle } from 'pixi.js';

/**
 * One meeting-room zone as the renderer draws it (ROADMAP Phase 3 増分②):
 * the placed rect, the composed label (zoneLabel in @kaede/shared — the
 * closed marker rides it) and the closed flag, which picks the tint. Built
 * by the net stack's zone feed from the subscribed conversation_group
 * rows; the renderer knows nothing about groups or kinds.
 */
export interface ZoneRender {
  /** The group row id, stringified — a stable identity for the snapshot. */
  key: string;
  rect: Rect;
  label: string;
  closed: boolean;
}

// Open zones read as an inviting spot, closed ones as a shut door; both
// stay translucent — a zone is a place ON the map, never cover over it.
const ZONE_OPEN_COLOR = 0xa3be8c;
const ZONE_CLOSED_COLOR = 0xbf616a;

const ZONE_LABEL_STYLE = new TextStyle({
  fill: 0xe5e9f0,
  fontSize: 12,
  fontFamily: 'sans-serif',
});

/** One zone's visuals: the tinted area, its border, and the label above. */
function drawZone(layer: Container, zone: ZoneRender): void {
  const { rect } = zone;
  const color = zone.closed ? ZONE_CLOSED_COLOR : ZONE_OPEN_COLOR;
  const area = new Graphics()
    .rect(rect.x, rect.y, rect.w, rect.h)
    .fill({ color, alpha: 0.14 })
    .rect(rect.x, rect.y, rect.w, rect.h)
    .stroke({ color, alpha: 0.6, width: 2 });
  const label = new Text({ text: zone.label, style: ZONE_LABEL_STYLE });
  label.anchor.set(0, 1);
  label.position.set(rect.x + 4, rect.y - 4);
  layer.addChild(area, label);
}

/**
 * Replaces `layer`'s contents with the given zones. The layer container is
 * owned by GameApp (parked between the map layer and the player views);
 * rebuilding contents wholesale mirrors buildMapLayer — a zone edit cannot
 * leak the previous rect's shapes.
 */
export function renderZoneLayer(layer: Container, zones: readonly ZoneRender[]): void {
  for (const child of layer.removeChildren()) child.destroy({ children: true });
  for (const zone of zones) drawZone(layer, zone);
}
