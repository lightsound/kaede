/**
 * 立ち話グループ (ROADMAP Phase 3 増分③) — the ad-hoc kind of 会話グループ:
 * founded on the spot by anyone in the world, following its members'
 * avatars instead of a placed rect. Same table as the zones (kind='huddle'
 * rows, the placement columns unused), same membership table; the rules
 * that span both kinds (row order, the occupancy tag) are
 * conversationGroup.ts. Every request/verdict type below is
 * self-contained: no exported type here references another file, so the
 * file adds no type-coupling evidence edges (the fallow cap, see
 * AGENTS.md).
 */

import { normalizeSingleLineText } from './text';
import { ZONE_NAME_MAX_LENGTH } from './zone';

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
 * The huddle reducers' token-bucket parameters (create/join/leave — the
 * chat numbers: each call writes public rows broadcast to every
 * subscriber). The evaluator wrapper lives server-side (huddles.ts) rather
 * than here, deliberately: a shared wrapper's signature would name the
 * sendAllowance types and add type-coupling edges past the evidence cap
 * (the header comment of this file); the rule itself stays the
 * unit-tested evaluateSendAllowance core.
 */
export const HUDDLE_SEND_COST_MICROS = 1_000_000n;
export const HUDDLE_BURST_SENDS = 5;
