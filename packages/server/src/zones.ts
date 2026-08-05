// fallow-ignore-file coverage-gaps -- reducers only run inside a SpacetimeDB module host, so no unit test can import this file; the rules worth testing (admin check, spec validation, placement clamping, occupancy) are delegated to evaluateSettingChange / evaluateZoneSpec / clampZoneRect / resolveZoneOccupancy in @kaede/shared and unit-tested there

// The meeting-room zone admin reducers (ROADMAP Phase 3 増分②): placing,
// editing and removing the zone-kind conversation_group rows. Every action
// is vetted server-side against the sender's membership (the
// transitionMember precedent — the client-side gating of the zone panel is
// cosmetic), and every placement coordinate comes from the SENDER'S
// authoritative player row, never from the client: "place it where I
// stand" needs no trusted geometry and gives the admin instant visual
// feedback on the canvas. No rate guard, like the other admin reducers:
// the actions are admin-gated and rare, and the occupancy churn they can
// cause is bounded by the map's population.
import {
  clampZoneRect,
  evaluateZoneSpec,
  GROUP_KIND_ZONE,
  mapFor,
  ZONE_DEFAULT_H,
  ZONE_DEFAULT_W,
  ZONE_MAX,
} from '@kaede/shared';
import { SenderError, t } from 'spacetimedb/server';
import { spacetimedb } from './tables';
import { type Ctx, deleteGroupCall, recomputeZoneOccupancyOnMap, requireAdmin } from './world';

/** The zone-kind group row `zoneId` names, or a loud refusal. */
function requireZone(ctx: Ctx, zoneId: bigint, reducerName: string) {
  const row = ctx.db.conversationGroup.id.find(zoneId);
  if (row === null || row.kind !== GROUP_KIND_ZONE) {
    throw new SenderError(`${reducerName} refused (no-such-zone)`);
  }
  return row;
}

/**
 * Where the placing admin stands: the sender's authoritative row. Placement
 * is defined as "centered on me", so an admin not in the world (waiting
 * room, observer connection) has nowhere to place from — a loud refusal,
 * nothing written yet.
 */
function senderPlacement(ctx: Ctx, reducerName: string): { x: number; y: number; mapId: number } {
  const row = ctx.db.player.identity.find(ctx.sender);
  if (row === null) throw new SenderError(`${reducerName} refused (not-in-world)`);
  return { x: row.x, y: row.y, mapId: row.mapId };
}

/** How many conversation-group rows exist (the ZONE_MAX cap counts all kinds). */
function groupCount(ctx: Ctx): number {
  return Number(ctx.db.conversationGroup.count());
}

/** The rect a zone occupies centered on (centerX, centerY), clamped into map `mapId`. */
function placeRect(mapId: number, centerX: number, centerY: number, w: number, h: number) {
  const bounds = mapFor(mapId).collision;
  return clampZoneRect({
    centerX,
    centerY,
    w,
    h,
    mapWidth: bounds.width,
    mapHeight: bounds.height,
  });
}

// Places a new zone centered on the sender, at the default size (resize is
// update_zone's job), on the map the sender is standing on. The cap bounds
// both the public table's entry egress and the per-batch occupancy work
// (see the conversation_group table comment). The occupancy recompute
// covers players already standing inside the new rect — including
// quiescent ones the movement pass would never re-rule.
export const createZone = spacetimedb.reducer(
  { name: t.string(), closed: t.bool() },
  (ctx, { name, closed }) => {
    requireAdmin(ctx, 'create_zone');
    const spec = evaluateZoneSpec({ name, w: ZONE_DEFAULT_W, h: ZONE_DEFAULT_H });
    if (!spec.ok) throw new SenderError(`create_zone refused (${spec.reason})`);
    if (groupCount(ctx) >= ZONE_MAX) throw new SenderError('create_zone refused (zone-limit)');
    const placement = senderPlacement(ctx, 'create_zone');
    const rect = placeRect(placement.mapId, placement.x, placement.y, spec.w, spec.h);
    ctx.db.conversationGroup.insert({
      id: 0n, // 0 asks autoInc to assign the real id
      kind: GROUP_KIND_ZONE,
      name: spec.name,
      closed,
      mapId: placement.mapId,
      ...rect,
    });
    recomputeZoneOccupancyOnMap(ctx, placement.mapId);
  },
);

// Edits a zone's name, オープン/クローズド setting and size. The rect keeps
// its center and re-clamps into the map, so resizing near an edge stays
// in-world; the recompute covers standers the new rect gained or lost.
export const updateZone = spacetimedb.reducer(
  { zoneId: t.u64(), name: t.string(), closed: t.bool(), w: t.u32(), h: t.u32() },
  (ctx, { zoneId, name, closed, w, h }) => {
    requireAdmin(ctx, 'update_zone');
    const row = requireZone(ctx, zoneId, 'update_zone');
    const spec = evaluateZoneSpec({ name, w, h });
    if (!spec.ok) throw new SenderError(`update_zone refused (${spec.reason})`);
    const rect = placeRect(row.mapId, row.x + row.w / 2, row.y + row.h / 2, spec.w, spec.h);
    ctx.db.conversationGroup.id.update({
      ...row,
      name: spec.name,
      closed,
      ...rect,
    });
    recomputeZoneOccupancyOnMap(ctx, row.mapId);
  },
);

// Re-centers a zone on the sender — the "move it here" edit, which may
// carry the zone to another map (the sender's). Both maps recompute: the
// origin's members lose a zone that no longer names anything on their map
// (resolveZoneOccupancy's stale-id rule clears or reassigns them), and the
// destination's standers may have gained one.
export const moveZone = spacetimedb.reducer({ zoneId: t.u64() }, (ctx, { zoneId }) => {
  requireAdmin(ctx, 'move_zone');
  const row = requireZone(ctx, zoneId, 'move_zone');
  const placement = senderPlacement(ctx, 'move_zone');
  const rect = placeRect(placement.mapId, placement.x, placement.y, row.w, row.h);
  const originMapId = row.mapId;
  ctx.db.conversationGroup.id.update({ ...row, mapId: placement.mapId, ...rect });
  recomputeZoneOccupancyOnMap(ctx, originMapId);
  if (placement.mapId !== originMapId) recomputeZoneOccupancyOnMap(ctx, placement.mapId);
});

// Deletes a zone. Its memberships are deleted explicitly BEFORE the
// recompute — the recompute would clear them too (every member's player
// row is on this map by construction), but a membership row naming a
// deleted group must not survive even if that invariant ever breaks: 増分④
// hangs chat visibility off these rows. The recompute then reassigns
// standers that an overlapping zone still covers.
export const deleteZone = spacetimedb.reducer({ zoneId: t.u64() }, (ctx, { zoneId }) => {
  requireAdmin(ctx, 'delete_zone');
  const row = requireZone(ctx, zoneId, 'delete_zone');
  ctx.db.conversationGroup.id.delete(zoneId);
  deleteGroupCall(ctx, zoneId);
  const members = [];
  for (const member of ctx.db.groupMember.iter()) {
    if (member.groupId === zoneId) members.push(member.identity);
  }
  for (const identity of members) ctx.db.groupMember.identity.delete(identity);
  recomputeZoneOccupancyOnMap(ctx, row.mapId);
});
