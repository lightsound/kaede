/**
 * 会議室ゾーン (ROADMAP Phase 3 増分②) — the placed, admin-managed kind of
 * 会話グループ (VISION の統一抽象). The schema side of the abstraction is the
 * `conversation_group` table (one row per group, `kind` discriminates) plus
 * the `group_member` table (identity → groupId: who is in which group,
 * space-wide); this module holds the pure rules — occupancy with
 * hysteresis, placement clamping, spec validation — shared so the server
 * reducers stay thin untestable wrappers (the map.ts portal precedent) and
 * the admin UI can only ever offer what the server accepts.
 *
 * Occupancy is judged SERVER-SIDE, on every write of the authoritative
 * position (accepted input batches, portal landings, joins) and of the zone
 * set (the admin reducers) — deliberately NOT the portal pattern of
 * client-detected enter/leave reducer calls. Rationale (recorded in
 * ROADMAP): the geometry test costs an index lookup plus at most ZONE_MAX
 * AABB tests inside a reducer that already replays ~24 physics ticks, so
 * the CPU rides the accepted-batch rate the idle suppression already
 * bounds (移動中 2〜3回/秒・静止中 0); client-driven calls would ADD reducer
 * calls, need their own rate limit and pending windows, and still require
 * this same server-side geometry backstop — a client that never sends
 * `leave` must not keep listening to a closed conversation from across the
 * map (増分④の可視性がこの行に乗る).
 */

import { normalizeSingleLineText, type TextRejectReason } from './text';
import type { Rect } from './types';

/**
 * The `kind` value of a placed meeting-room zone. 増分③の立ち話グループ is
 * planned as another kind on the same table ('huddle') — an additive row
 * vocabulary, no schema change. Builds narrow on exact match (the
 * availability / reaction-palette precedent), so rows of a kind this build
 * does not know render as nothing rather than as a broken zone.
 */
export const GROUP_KIND_ZONE = 'zone';

/** Longest zone name, in Unicode code points (the display-name cap: a canvas label). */
export const ZONE_NAME_MAX_LENGTH = 16;

/**
 * Zone size bounds (px). The minimum keeps a zone enterable-and-leavable:
 * it must comfortably exceed twice ZONE_EXIT_MARGIN so the hysteresis band
 * cannot swallow the whole rect. The maximum is one screen width — a zone
 * is a room inside a map, not a second map.
 */
export const ZONE_MIN_SIZE = 96;
export const ZONE_MAX_SIZE = 1280;

/** The size create_zone places (update_zone resizes later). */
export const ZONE_DEFAULT_W = 360;
export const ZONE_DEFAULT_H = 240;

/**
 * Occupancy hysteresis (px): entering requires the player center inside the
 * rect, leaving requires it outside the rect EXPANDED by this margin on
 * every side. Standing on the boundary line therefore flips nothing, and
 * flipping membership back and forth needs real walking (2×margin per
 * cycle at MOVE_SPEED) — which is what bounds how fast even a hostile
 * client can turn membership churn into public-row egress, with no
 * token-bucket guard of its own.
 */
export const ZONE_EXIT_MARGIN = 32;

/**
 * How many conversation-group rows may exist at once, across all maps. A
 * cap because the occupancy pass runs inside movement reducers: it bounds
 * the per-batch geometry work, and the table is public — every row rides
 * every entering client's initial subscription.
 */
export const ZONE_MAX = 32;

/** One zone as the occupancy rule reads it: the group row's id and placed rect. */
export interface ZoneShape {
  readonly id: bigint;
  readonly rect: Rect;
}

/**
 * The zone-kind rows out of a conversation_group iteration, in id order —
 * the ONE filtering-and-ordering rule behind both the server's occupancy
 * pass and the client's rendering/admin projections, so overlapping zones
 * resolve (and list) in the same deterministic order everywhere. Kind is
 * narrowed by exact match: huddle rows (増分③) and kinds this build does
 * not know never pass.
 */
export function sortedZoneRows<T extends { id: bigint; kind: string }>(rows: Iterable<T>): T[] {
  const zones = [...rows].filter((row) => row.kind === GROUP_KIND_ZONE);
  zones.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return zones;
}

/** True when `position` (a player AABB center) is inside `rect`, boundary inclusive. */
export function zoneRectContains(rect: Rect, position: { x: number; y: number }): boolean {
  return (
    position.x >= rect.x &&
    position.x <= rect.x + rect.w &&
    position.y >= rect.y &&
    position.y <= rect.y + rect.h
  );
}

/** `rect` grown by `margin` on every side (the hysteresis leave test). */
function expandRect(rect: Rect, margin: number): Rect {
  return {
    x: rect.x - margin,
    y: rect.y - margin,
    w: rect.w + margin * 2,
    h: rect.h + margin * 2,
  };
}

/** What ruling on one player's zone occupancy needs (see resolveZoneOccupancy). */
export interface ZoneOccupancyRequest {
  /** The player's authoritative AABB center after the movement being ruled on. */
  position: { x: number; y: number };
  /**
   * The zone-kind groups on the player's map, sorted by id so overlapping
   * zones resolve deterministically (lowest id wins).
   */
  zones: readonly ZoneShape[];
  /** The zone the player's group_member row currently names, if any. */
  currentZoneId: bigint | undefined;
}

/**
 * The zone the player occupies after this movement, or undefined for none —
 * the ONE rule behind every group_member write for zones. Hysteresis: the
 * current zone is kept while the center stays within its rect expanded by
 * ZONE_EXIT_MARGIN (even when the center is simultaneously inside another
 * zone), so boundary-standing and edge jitter flip nothing; entering any
 * zone requires the center inside its unexpanded rect. A current id that no
 * longer names a zone on this map (deleted, or moved to another map) simply
 * stops matching and the player falls through to the plain entry test.
 */
export function resolveZoneOccupancy(request: ZoneOccupancyRequest): bigint | undefined {
  const { position, zones, currentZoneId } = request;
  if (currentZoneId !== undefined) {
    const current = zones.find((zone) => zone.id === currentZoneId);
    if (current && zoneRectContains(expandRect(current.rect, ZONE_EXIT_MARGIN), position)) {
      return currentZoneId;
    }
  }
  return zones.find((zone) => zoneRectContains(zone.rect, position))?.id;
}

/** What placing a zone rect needs (see clampZoneRect). */
export interface ZonePlacementRequest {
  /** Where the zone should center — the placing admin's avatar position. */
  centerX: number;
  centerY: number;
  w: number;
  h: number;
  /** The map's collision bounds (CollisionMap width/height). */
  mapWidth: number;
  mapHeight: number;
}

/** Clamps `value` into [min, max] (max wins when the range is inverted). */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * The rect a zone lands on: centered on the placing admin's position,
 * shifted (and if necessary shrunk) to fit inside the map bounds — a zone
 * hanging off the world would have unreachable area that only distorts the
 * occupancy test.
 */
export function clampZoneRect(request: ZonePlacementRequest): Rect {
  const w = Math.min(request.w, request.mapWidth);
  const h = Math.min(request.h, request.mapHeight);
  return {
    x: clamp(request.centerX - w / 2, 0, request.mapWidth - w),
    y: clamp(request.centerY - h / 2, 0, request.mapHeight - h),
    w,
    h,
  };
}

/** Why a zone spec (name and size) was refused. */
export type ZoneSpecRejectReason = TextRejectReason | 'invalid-size';

export type ZoneSpecVerdict =
  | {
      ok: true;
      /** The normalized name to persist and render. */
      name: string;
      w: number;
      h: number;
    }
  | { ok: false; reason: ZoneSpecRejectReason };

/** True when `value` is a size create/update_zone may persist. */
function isZoneSize(value: number): boolean {
  return Number.isFinite(value) && value >= ZONE_MIN_SIZE && value <= ZONE_MAX_SIZE;
}

/**
 * Validates and normalizes what create_zone / update_zone may write: the
 * name under the display-name text rules at the zone cap (empty refused —
 * a meeting room needs a label), and both size axes within the zone
 * bounds. The admin check is evaluateSettingChange (the acting-admin rule
 * shared with set_guests_allowed); this verdict covers the payload.
 */
export function evaluateZoneSpec(request: { name: string; w: number; h: number }): ZoneSpecVerdict {
  const verdict = normalizeSingleLineText(request.name, ZONE_NAME_MAX_LENGTH);
  if (!verdict.ok) return verdict;
  if (!isZoneSize(request.w) || !isZoneSize(request.h)) {
    return { ok: false, reason: 'invalid-size' };
  }
  return { ok: true, name: verdict.text, w: request.w, h: request.h };
}

/**
 * The zone's canvas label, composed here so the renderer and the e2e specs
 * use exactly the same string (the statusLabel precedent). The lock marks a
 * closed zone — in this increment a rendering distinction only; the chat
 * invisibility it promises lands with 増分④.
 */
export function zoneLabel(name: string, closed: boolean): string {
  return closed ? `🔒 ${name}` : name;
}

/**
 * The occupancy tag under an avatar (「どのゾーンに居るか」の全クライアント
 * 表示), composed here for the same one-string reason as zoneLabel.
 */
export function zoneTagLabel(name: string): string {
  return `📍 ${name}`;
}
