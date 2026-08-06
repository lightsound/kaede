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
 * The rows of one `kind` out of a conversation_group iteration, in id
 * order — the ONE filtering-and-ordering rule behind the server's
 * occupancy pass and the client's rendering/admin projections, so
 * overlapping zones resolve (and huddles list) in the same deterministic
 * order everywhere. Kind is narrowed by exact match: rows of a kind this
 * build does not know never pass.
 */
function sortedGroupRowsOf<T extends { id: bigint; kind: string }>(
  rows: Iterable<T>,
  kind: string,
): T[] {
  const groups = [...rows].filter((row) => row.kind === kind);
  groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return groups;
}

/** The zone-kind rows in the shared deterministic order (see sortedGroupRowsOf). */
export function sortedZoneRows<T extends { id: bigint; kind: string }>(rows: Iterable<T>): T[] {
  return sortedGroupRowsOf(rows, GROUP_KIND_ZONE);
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

// ── 立ち話グループ (ROADMAP Phase 3 増分③) ──────────────────────────────
// The ad-hoc kind of 会話グループ: founded on the spot by anyone in the
// world, following its members' avatars instead of a placed rect. Same
// table (kind='huddle' rows, the placement columns unused), same membership
// table — these rules live HERE, next to the zone rules, both because the
// two kinds share the conversation-group vocabulary and because new shared
// files whose public signatures name types from other files add
// type-coupling edges past the evidence cap (the map.ts precedent from
// 増分①), so every request/verdict type below is self-contained.

/**
 * The `kind` value of a 立ち話グループ. Same exact-match narrowing rule as
 * GROUP_KIND_ZONE: builds that predate a kind render its rows as nothing.
 */
export const GROUP_KIND_HUDDLE = 'huddle';

/**
 * What a nameless huddle is called. Unlike a zone (a labelled room), a
 * huddle is an ad-hoc conversation — demanding a name would add friction
 * to the one gesture that must stay effortless, so an empty input means
 * this default rather than a refusal (see normalizeHuddleName).
 */
export const HUDDLE_DEFAULT_NAME = '立ち話';

/**
 * How close (px, nearest member) joining requires standing — 参加は
 * 「近づいてボタン」. About four avatar widths: close enough to read as
 * "walked up to the circle", far enough that the join button does not
 * demand pixel-perfect positioning.
 */
export const HUDDLE_JOIN_DISTANCE = 140;

/**
 * Beyond this distance from every OTHER member (px), a member has walked
 * away and the server removes them from the huddle. Much larger than
 * HUDDLE_JOIN_DISTANCE — the gap is the hysteresis band (the
 * ZONE_EXIT_MARGIN idea): drifting a step past the join range must not
 * flap membership, and flipping it needs real walking. A solo member is
 * never distance-ruled: the huddle follows their avatar (that is what
 * "アバターに追従" means for its anchor) until they leave, teleport away
 * or someone joins.
 */
export const HUDDLE_LEAVE_DISTANCE = 320;

/**
 * The huddle-kind rows out of a conversation_group iteration, in id order
 * — sortedZoneRows' sibling, one shared core so the two kinds cannot
 * drift in how they filter and order.
 */
export function sortedHuddleRows<T extends { id: bigint; kind: string }>(rows: Iterable<T>): T[] {
  return sortedGroupRowsOf(rows, GROUP_KIND_HUDDLE);
}

/** Why a huddle name was refused (empty is not a refusal — see normalizeHuddleName). */
export type HuddleNameRejectReason = 'too-long' | 'forbidden-characters';

/** `name` is the normalized name to persist and render. */
export type HuddleNameVerdict =
  | { ok: true; name: string }
  | { ok: false; reason: HuddleNameRejectReason };

/**
 * Validates and normalizes what create_huddle may write: the display-name
 * text rules at the zone cap, except that an EMPTY input is accepted as
 * HUDDLE_DEFAULT_NAME instead of refused — see its comment. Shared with
 * the client form so a name that leaves the UI is never refused for its
 * content.
 */
export function normalizeHuddleName(raw: string): HuddleNameVerdict {
  const verdict = normalizeSingleLineText(raw, ZONE_NAME_MAX_LENGTH);
  if (!verdict.ok) {
    return verdict.reason === 'empty'
      ? { ok: true, name: HUDDLE_DEFAULT_NAME }
      : { ok: false, reason: verdict.reason };
  }
  return { ok: true, name: verdict.text };
}

/** Distance from `position` to the closest of `members`, +Infinity for none. */
function nearestMemberDistance(
  position: { x: number; y: number },
  members: readonly { x: number; y: number }[],
): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const member of members) {
    nearest = Math.min(nearest, Math.hypot(member.x - position.x, member.y - position.y));
  }
  return nearest;
}

/** What ruling on one join_huddle call needs (see evaluateHuddleJoin). */
export interface HuddleJoinRequest {
  /** The joiner's authoritative AABB center. */
  position: { x: number; y: number };
  /** The joiner's map. */
  mapId: number;
  /** The huddle's map (the conversation_group row's mapId, its founding map). */
  huddleMapId: number;
  /** The huddle's current members' authoritative AABB centers. */
  memberPositions: readonly { x: number; y: number }[];
}

export type HuddleJoinVerdict = { ok: true } | { ok: false; reason: 'wrong-map' | 'too-far' };

/**
 * Whether a player may join a huddle: same map, and within
 * HUDDLE_JOIN_DISTANCE of at least one member (nearest-member distance —
 * the circle is wherever its people stand, so proximity is to a person,
 * not to a stored point). The client's join button offers only what this
 * accepts (findJoinableHuddleId); the server re-rules on the sender's
 * authoritative row, so client resolution is never trusted.
 */
export function evaluateHuddleJoin(request: HuddleJoinRequest): HuddleJoinVerdict {
  if (request.mapId !== request.huddleMapId) return { ok: false, reason: 'wrong-map' };
  if (nearestMemberDistance(request.position, request.memberPositions) > HUDDLE_JOIN_DISTANCE) {
    return { ok: false, reason: 'too-far' };
  }
  return { ok: true };
}

/** What ruling on one member's huddle retention needs (see keepsHuddleMembership). */
export interface HuddleRetentionRequest {
  /** The member's authoritative AABB center after the movement being ruled on. */
  position: { x: number; y: number };
  /** The member's map after the movement (a portal landing may change it). */
  mapId: number;
  /** The huddle's map (the conversation_group row's mapId). */
  huddleMapId: number;
  /** The OTHER members' authoritative AABB centers (empty for a solo huddle). */
  otherMemberPositions: readonly { x: number; y: number }[];
}

/**
 * Whether a huddle member is still in the conversation after a movement —
 * the ONE rule behind every server-side huddle auto-leave. Walking (or
 * teleporting) away IS leaving: off the huddle's map, or farther than
 * HUDDLE_LEAVE_DISTANCE from every other member. A solo member always
 * stays (the huddle follows their avatar); joining resumes distance
 * ruling. The join/leave distance gap is the hysteresis (see
 * HUDDLE_LEAVE_DISTANCE).
 */
export function keepsHuddleMembership(request: HuddleRetentionRequest): boolean {
  if (request.mapId !== request.huddleMapId) return false;
  if (request.otherMemberPositions.length === 0) return true;
  const nearest = nearestMemberDistance(request.position, request.otherMemberPositions);
  return nearest <= HUDDLE_LEAVE_DISTANCE;
}

/** One huddle as the join-button rule reads it (see findJoinableHuddleId). */
export interface JoinableHuddleCandidate {
  id: bigint;
  mapId: number;
  memberPositions: readonly { x: number; y: number }[];
}

/**
 * The huddle a join button should offer right now, or undefined: the first
 * (lowest id — pass sortedHuddleRows order) huddle the join rule accepts
 * from `position`. Client-side UX only; join_huddle re-rules the same
 * geometry on the sender's authoritative row.
 */
export function findJoinableHuddleId(
  position: { x: number; y: number },
  mapId: number,
  huddles: readonly JoinableHuddleCandidate[],
): bigint | undefined {
  return huddles.find(
    (huddle) =>
      evaluateHuddleJoin({
        position,
        mapId,
        huddleMapId: huddle.mapId,
        memberPositions: huddle.memberPositions,
      }).ok,
  )?.id;
}

/**
 * The huddle's canvas label — zoneLabel's sibling. 💬 marks an open
 * standing conversation; 🤫 is the クローズド「コソコソ話している」
 * rendering (in this increment a visual distinction only, like the zone
 * lock: the chat invisibility it promises is 増分④'s RLS work).
 */
export function huddleLabel(name: string, closed: boolean): string {
  return closed ? `🤫 ${name}` : `💬 ${name}`;
}

/**
 * The occupancy tag under a member's avatar, for ANY conversation-group
 * kind — the one dispatch behind every tag render, so a zone member shows
 * 📍 while a huddle member shows the huddle's own label (🤫 on a closed
 * one: the コソコソ reading follows the members, not just the circle). A
 * kind this build does not know renders as nothing (the exact-match rule).
 */
export function groupTagLabel(group: {
  kind: string;
  name: string;
  closed: boolean;
}): string | undefined {
  if (group.kind === GROUP_KIND_ZONE) return zoneTagLabel(group.name);
  if (group.kind === GROUP_KIND_HUDDLE) return huddleLabel(group.name, group.closed);
  return undefined;
}

/**
 * The huddle reducers' token-bucket parameters (create/join/leave — the
 * chat numbers: each call writes public rows broadcast to every
 * subscriber). The evaluator wrapper lives server-side (huddles.ts) rather
 * than here, deliberately: a shared wrapper's signature would name the
 * sendAllowance types and add type-coupling edges past the evidence cap
 * (the header comment of this section); the rule itself stays the
 * unit-tested evaluateSendAllowance core.
 */
export const HUDDLE_SEND_COST_MICROS = 1_000_000n;
export const HUDDLE_BURST_SENDS = 5;

// ── 会話グループ単位の通話 (ROADMAP Phase 4 増分①) ──────────────────────
// A conversation group's call is one `group_call` row: groupId → the call
// provider's meeting id (the reusable room the CallProvider joins). The row
// is REGISTERED by a member (register_group_call) after the Worker
// provisioned the meeting, and its meeting id is the JOIN CAPABILITY — the
// token-minting Worker knows nothing about groups, so whoever can read the
// row can join the call, which is why the row rides a members-only RLS
// filter (see groupCallVisibility in the server's tables.ts). These are the
// shared rules of that flow; the reducer stays a thin untestable wrapper
// (the huddle precedent).

/**
 * Whether `meetingId` has the shape the call provider issues (a UUID) —
 * what register_group_call accepts into the group_call row. The row's
 * meeting id is dialed by every joining member's CallProvider, so garbage
 * must be refused at the write (the sender is the one client the server
 * cannot trust): a wrong-but-well-formed id fails harmlessly at the
 * provider, while an unbounded string is a stored-injection surface.
 */
export function isMeetingIdLike(meetingId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(meetingId);
}

/**
 * The call-registration token bucket's parameters (the huddle numbers, a
 * bucket of its own — register_group_call writes a public row broadcast to
 * the group's subscribers, and buckets shared across features drift from
 * their client-side mirrors). The evaluator wrapper lives server-side
 * (calls.ts), for the HUDDLE_SEND_COST_MICROS reason: a shared wrapper
 * would add type-coupling edges past the evidence cap.
 */
export const CALL_SEND_COST_MICROS = 1_000_000n;
export const CALL_BURST_SENDS = 5;

// ---------------------------------------------------------------------------
// Call recordings (ROADMAP Phase 4 増分④)
// ---------------------------------------------------------------------------

/**
 * Global cap on call_recording rows. Recordings outlive their conversation
 * group (YouTube re-use), so group deletion must not cascade; the write
 * path trims to this newest-N instead (chat_message's CHAT_HISTORY_MAX
 * precedent). 50 × ~hour-long meetings is plenty for a small community and
 * keeps the approved-members subscription bounded.
 */
export const RECORDING_HISTORY_MAX = 50;

/** Lifecycle statuses mirrored from RealtimeKit's recording.statusUpdate. */
export const RECORDING_STATUS_RECORDING = 'recording';
export const RECORDING_STATUS_UPLOADING = 'uploading';
export const RECORDING_STATUS_UPLOADED = 'uploaded';
export const RECORDING_STATUS_ERRORED = 'errored';

export type RecordingStatus =
  | typeof RECORDING_STATUS_RECORDING
  | typeof RECORDING_STATUS_UPLOADING
  | typeof RECORDING_STATUS_UPLOADED
  | typeof RECORDING_STATUS_ERRORED;

const RECORDING_STATUSES: ReadonlySet<string> = new Set([
  RECORDING_STATUS_RECORDING,
  RECORDING_STATUS_UPLOADING,
  RECORDING_STATUS_UPLOADED,
  RECORDING_STATUS_ERRORED,
]);

/** Whether `status` is one of the four recording lifecycle values. */
export function isRecordingStatus(status: string): status is RecordingStatus {
  return RECORDING_STATUSES.has(status);
}

/**
 * Maps a RealtimeKit webhook/API status (UPPER_SNAKE) onto our row
 * vocabulary. Unknown values return undefined so the upsert can refuse
 * rather than store a free-form string (the availability exact-match rule).
 */
export function recordingStatusFromProvider(raw: string): RecordingStatus | undefined {
  switch (raw) {
    case 'INVOKED':
    case 'RECORDING':
      return RECORDING_STATUS_RECORDING;
    case 'UPLOADING':
      return RECORDING_STATUS_UPLOADING;
    case 'UPLOADED':
      return RECORDING_STATUS_UPLOADED;
    case 'ERRORED':
      return RECORDING_STATUS_ERRORED;
    default:
      return isRecordingStatus(raw) ? raw : undefined;
  }
}

/**
 * Whether `recordingId` has the provider's id shape — same UUID rule as
 * meeting ids (isMeetingIdLike). Kept as a named alias so call sites read
 * as recording authority, not meeting authority.
 */
export function isRecordingIdLike(recordingId: string): boolean {
  return isMeetingIdLike(recordingId);
}

/**
 * Oldest-first compare for call_recording trim (RECORDING_HISTORY_MAX).
 * Ties break on recordingId ascending so the order is stable across hosts.
 * Split out of the reducer / feed sort arrows for the CRAP budget.
 */
export function compareRecordingsOldestFirst(
  a: { startedAtMs: bigint; recordingId: string },
  b: { startedAtMs: bigint; recordingId: string },
): number {
  if (a.startedAtMs === b.startedAtMs) {
    return a.recordingId < b.recordingId ? -1 : a.recordingId > b.recordingId ? 1 : 0;
  }
  return a.startedAtMs < b.startedAtMs ? -1 : 1;
}

/** Newest-first compare for the approved-member recordings list UI. */
export function compareRecordingsNewestFirst(
  a: { startedAtMs: bigint; recordingId: string },
  b: { startedAtMs: bigint; recordingId: string },
): number {
  return compareRecordingsOldestFirst(b, a);
}
