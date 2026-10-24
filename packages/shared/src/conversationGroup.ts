/**
 * The rules of 会話グループ (VISION の統一抽象) that span its kinds: the
 * deterministic order of conversation_group rows per kind (one private
 * core behind sortedZoneRows and sortedHuddleRows), and the occupancy tag
 * that dispatches on a group's kind. Each kind's own rules live in zone.ts
 * (会議室ゾーン) and huddle.ts (立ち話グループ). Taken together these need
 * both kinds' vocabularies, so they sit above the two files rather than in
 * either: in zone.ts they would close an import cycle (huddle.ts already
 * imports zone.ts for the name cap), and in huddle.ts the zone-only
 * sortedZoneRows and the 📍 branch of the tag would sit in the huddle file.
 */

import { GROUP_KIND_HUDDLE, huddleLabel } from './huddle';
import { GROUP_KIND_ZONE, zoneTagLabel } from './zone';

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

/**
 * The huddle-kind rows out of a conversation_group iteration, in id order
 * — sortedZoneRows' sibling, one shared core so the two kinds cannot
 * drift in how they filter and order.
 */
export function sortedHuddleRows<T extends { id: bigint; kind: string }>(rows: Iterable<T>): T[] {
  return sortedGroupRowsOf(rows, GROUP_KIND_HUDDLE);
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
