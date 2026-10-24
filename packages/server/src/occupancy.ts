// fallow-ignore-file coverage-gaps -- helpers over the SpacetimeDB reducer context; they only run inside a module host, and the rules worth testing (zone hysteresis and overlap priority, the huddle walk-away rule) are delegated to resolveZoneOccupancy / keepsHuddleMembership in @kaede/shared and unit-tested there

// Group occupancy (ROADMAP Phase 3 増分②③): who is in which conversation
// group, judged server-side wherever the authoritative position or the
// zone set changes — accepted input batches and portal landings
// (movement.ts), joins (spawnOrResume in world.ts), and the admin zone
// edits (zones.ts, through recomputeZoneOccupancyOnMap). The rules
// themselves — zone hysteresis and overlap priority (resolveZoneOccupancy),
// the huddle walk-away rule (keepsHuddleMembership) — are unit-tested in
// @kaede/shared; see zone.ts there for why this is deliberately NOT the
// portal pattern of client-detected reducer calls.
//
// Its own module, not re-exported (the world.ts header rule): world.ts
// (joins, removePlayer's huddle cleanup) and the reducer files that move
// players or edit groups (movement.ts, huddles.ts, zones.ts) all call in.
import {
  GROUP_KIND_HUDDLE,
  keepsHuddleMembership,
  resolveZoneOccupancy,
  sortedZoneRows,
  type ZoneShape,
} from '@kaede/shared';
import type { Ctx, SenderIdentity } from './world';

/**
 * The zone-kind groups placed on `mapId` in id order (sortedZoneRows —
 * the deterministic overlap priority), shaped for the occupancy rule.
 */
function zonesOnMap(ctx: Ctx, mapId: number): ZoneShape[] {
  return sortedZoneRows(ctx.db.conversationGroup.iter())
    .filter((row) => row.mapId === mapId)
    .map((row) => ({ id: row.id, rect: { x: row.x, y: row.y, w: row.w, h: row.h } }));
}

/** The conversation_group row `groupId` names IF it is a huddle, else null. */
function huddleRowOf(ctx: Ctx, groupId: bigint) {
  const row = ctx.db.conversationGroup.id.find(groupId);
  return row !== null && row.kind === GROUP_KIND_HUDDLE ? row : null;
}

/**
 * The identities holding a membership in `groupId`, minus `except`.
 * Iterates the whole membership table (bounded by the world population;
 * the groupId btree index is for 増分④'s RLS, and the generated API
 * exposes no filtered scan). Split from the position lookup below to keep
 * both uncovered functions under the CRAP budget fallow enforces.
 */
function huddleMemberIdentities(ctx: Ctx, groupId: bigint, except: SenderIdentity) {
  const identities = [];
  for (const member of ctx.db.groupMember.iter()) {
    if (member.groupId === groupId && !member.identity.isEqual(except)) {
      identities.push(member.identity);
    }
  }
  return identities;
}

/**
 * The authoritative AABB centers of `groupId`'s members other than
 * `except` — what the huddle join and retention rules measure distance
 * against. Members always have player rows (removePlayer deletes the
 * membership alongside), so the null check is the usual tolerance, not a
 * reachable state.
 */
export function otherHuddleMemberPositions(
  ctx: Ctx,
  groupId: bigint,
  except: SenderIdentity,
): { x: number; y: number }[] {
  const positions = [];
  for (const identity of huddleMemberIdentities(ctx, groupId, except)) {
    const row = ctx.db.player.identity.find(identity);
    if (row !== null) positions.push({ x: row.x, y: row.y });
  }
  return positions;
}

/**
 * Deletes a group's call row alongside its group row (ROADMAP Phase 4
 * 増分①) — the group_call lifecycle rule ("the row lives as long as its
 * group", see tables.ts), called by both group-deletion paths
 * (cleanupEmptyHuddle below, delete_zone in zones.ts). A call row naming
 * a deleted group would otherwise sit forever: it matches no RLS join, so
 * nobody could even see it to clean it up.
 */
export function deleteGroupCall(ctx: Ctx, groupId: bigint): void {
  ctx.db.groupCall.groupId.delete(groupId);
}

/**
 * Deletes a huddle row once nothing references it — the 「0人になったら
 * 行を掃除」 rule, called by every membership-removal path (the huddle
 * reducers' leave/switch, the occupancy pass's auto-leave, removePlayer).
 * Zone rows never qualify (kind-checked): a zone is placed config that
 * exists independently of its occupants.
 */
export function cleanupEmptyHuddle(ctx: Ctx, groupId: bigint): void {
  if (huddleRowOf(ctx, groupId) === null) return;
  for (const member of ctx.db.groupMember.iter()) {
    if (member.groupId === groupId) return;
  }
  ctx.db.conversationGroup.id.delete(groupId);
  deleteGroupCall(ctx, groupId);
}

/**
 * Re-rules one player's group_member row after a movement of the
 * authoritative position. Two regimes, by what the row currently names:
 * - A HUDDLE: only the walk-away rule applies (keepsHuddleMembership).
 *   While the membership holds, zone geometry never reassigns it —
 *   joining a huddle was an explicit act, and standing inside a meeting
 *   room while in one must not silently swap the conversation (the
 *   design decision recorded on group_member in tables.ts). Once the
 *   member walks (or teleports) away, the membership drops and the zone
 *   ruling below runs in the same pass — they may be standing in a zone.
 * - A ZONE or nothing: the 増分② geometry rule (hysteresis, overlap
 *   priority), writes only on actual transitions.
 * `position` is the authoritative AABB center AFTER the movement.
 */
export function syncGroupOccupancy(
  ctx: Ctx,
  identity: SenderIdentity,
  position: { x: number; y: number },
  mapId: number,
): void {
  const member = ctx.db.groupMember.identity.find(identity);
  if (member !== null) {
    const huddle = huddleRowOf(ctx, member.groupId);
    if (huddle !== null) {
      const keeps = keepsHuddleMembership({
        position,
        mapId,
        huddleMapId: huddle.mapId,
        otherMemberPositions: otherHuddleMemberPositions(ctx, huddle.id, identity),
      });
      if (keeps) return;
      ctx.db.groupMember.identity.delete(identity);
      cleanupEmptyHuddle(ctx, huddle.id);
      syncZoneOccupancy(ctx, identity, position, mapId, null);
      return;
    }
  }
  syncZoneOccupancy(ctx, identity, position, mapId, member);
}

/** A group_member row as this schema returns it. */
type GroupMemberRow = NonNullable<ReturnType<Ctx['db']['groupMember']['identity']['find']>>;

/**
 * The zone half of the occupancy pass (増分②): re-rules `member` (the
 * caller's own lookup, or null after a huddle auto-leave just deleted it)
 * against the zones on the map and writes only actual transitions — a
 * no-transition pass writes nothing, so the common case (moving around
 * inside or outside a zone) costs reads only.
 */
function syncZoneOccupancy(
  ctx: Ctx,
  identity: SenderIdentity,
  position: { x: number; y: number },
  mapId: number,
  member: GroupMemberRow | null,
): void {
  const next = resolveZoneOccupancy({
    position,
    zones: zonesOnMap(ctx, mapId),
    currentZoneId: member?.groupId,
  });
  if (member === null) {
    if (next !== undefined) ctx.db.groupMember.insert({ identity, groupId: next });
    return;
  }
  moveZoneMembership(ctx, identity, member, next);
}

/**
 * Writes an existing membership's transition: leave (delete) or switch
 * (update); a same-zone verdict writes nothing — an unchanged upsert would
 * still broadcast to every subscriber. Split from syncZoneOccupancy to
 * keep these uncovered functions under the CRAP budget fallow enforces
 * (the backfillAccountName precedent).
 */
function moveZoneMembership(
  ctx: Ctx,
  identity: SenderIdentity,
  member: GroupMemberRow,
  next: bigint | undefined,
): void {
  if (next === undefined) {
    ctx.db.groupMember.identity.delete(identity);
    return;
  }
  if (next !== member.groupId) {
    ctx.db.groupMember.identity.update({ ...member, groupId: next });
  }
}

/**
 * Re-rules every player on `mapId` — the zone-edit counterpart of the
 * per-movement pass, because a zone appearing, resizing, moving or
 * vanishing changes occupancy for players who are standing still (and a
 * quiescent player sends nothing the movement pass could rule on).
 * Offline-but-retained rows are included on purpose: their occupancy must
 * track the zone set so a resume within the retention window comes back
 * consistent. Huddle members pass through unchanged (the
 * syncGroupOccupancy stickiness — a zone edit is no reason to leave a
 * conversation, and nobody moved). O(players × zones) on one map, on a
 * rare admin action.
 */
export function recomputeZoneOccupancyOnMap(ctx: Ctx, mapId: number): void {
  for (const row of ctx.db.player.iter()) {
    if (row.mapId === mapId) {
      syncGroupOccupancy(ctx, row.identity, { x: row.x, y: row.y }, mapId);
    }
  }
}
