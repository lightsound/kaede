// fallow-ignore-file coverage-gaps -- wires live SpacetimeDB row events to the zone/huddle layers and occupancy tags; needs a running host. The geometry, labels, membership and occupancy rules live in @kaede/shared (zone.ts), unit-tested there
import {
  findJoinableHuddleId,
  GROUP_KIND_HUDDLE,
  groupTagLabel,
  huddleLabel,
  mapFor,
  sortedHuddleRows,
  sortedZoneRows,
  zoneLabel,
} from '@kaede/shared';
import type { Identity } from 'spacetimedb';
import type { HuddleRender, ZoneRender } from '../game.package';
import type { DbConnection } from '../module_bindings';
import { onAnyRowEvent } from './rowEvents';

/**
 * One zone as the admin panel edits it (会議室ゾーンの管理 UI — ROADMAP
 * Phase 3 増分②): the row's fields plus the map's display name. `key` is
 * the stringified group id (bigint is no React key).
 */
export interface ZoneAdminView {
  id: bigint;
  key: string;
  name: string;
  closed: boolean;
  mapId: number;
  mapName: string;
  w: number;
  h: number;
}

/**
 * What the huddle control renders (立ち話の発足/参加/離脱 UI — ROADMAP
 * Phase 3 増分③), published by the feed whenever the answer changes: the
 * huddle the own membership names (leave is offered), or the nearest
 * joinable one (join is offered), or neither (founding is offered). Both
 * never coexist — one conversation group at a time is structural.
 */
export interface HuddleView {
  /** The own huddle's composed label, or undefined while in none. */
  own: string | undefined;
  /** The joinable huddle right now (client-side UX; join_huddle re-rules). */
  joinable: { id: bigint; label: string } | undefined;
}

/** What acting on zone and occupancy rows needs from the session that wires the feed. */
export interface ZoneFeedHooks {
  /** True once this session's events must be ignored (see wireSession). */
  isStale(): boolean;
  /** The map whose zones the canvas currently renders. */
  currentMapId(): number;
  /** Replaces the rendered zone layer (already filtered to the current map). */
  setMapZones(zones: readonly ZoneRender[]): void;
  /** Replaces the rendered huddles (already filtered to the current map). */
  setMapHuddles(huddles: readonly HuddleRender[]): void;
  applyOwnZone(tag: string | undefined): void;
  applyRemoteZone(idHex: string, tag: string | undefined): void;
  /** Every conversation_group change, as the whole admin view (all maps). */
  onZones(zones: ZoneAdminView[]): void;
  /** Every change of the huddle control's answer (deduplicated by value). */
  onHuddle(view: HuddleView): void;
}

/**
 * The composed occupancy tag the subscribed cache holds for `identity`, or
 * undefined while in no group — the seed half of the tag display
 * (occupancy is STATE, like a status: restored on entry/reload and read by
 * labelOf when a remote view is (re)created). The tag dispatches on the
 * group's kind (groupTagLabel): 📍 for a zone, the huddle's own 💬/🤫
 * label for a huddle, nothing for a kind this build does not know.
 */
export function cachedZoneTag(c: DbConnection, identity: Identity): string | undefined {
  const member = c.db.groupMember.identity.find(identity);
  if (member === null) return undefined;
  const group = c.db.conversationGroup.id.find(member.groupId);
  return group === null ? undefined : groupTagLabel(group);
}

/**
 * Wires one session's zone rendering (the conversation_group rows), the
 * occupancy tags (the group_member rows) and the admin panel's zone list.
 * Both tables are display-only state (the statusFeed rule: seed AND row
 * events display), and all writes are server-side — the occupancy pass and
 * the admin reducers — so this feed only ever projects the cache.
 *
 * `refresh()` re-projects everything for the current map; the session
 * calls it at entry and after every map switch (the zone layer and the
 * own tag are per-map projections of space-wide tables).
 */
export function wireZones(
  c: DbConnection,
  myIdentity: Identity,
  hooks: ZoneFeedHooks,
): { refresh(): void } {
  const myIdHex = myIdentity.toHexString();

  // The zone-kind rows in the shared deterministic order (sortedZoneRows —
  // the same order the server resolves overlap in).
  const zoneRows = () => sortedZoneRows(c.db.conversationGroup.iter());

  const pushLayer = (): void => {
    const mapId = hooks.currentMapId();
    hooks.setMapZones(
      zoneRows()
        .filter((row) => row.mapId === mapId)
        .map((row) => ({
          key: String(row.id),
          rect: { x: row.x, y: row.y, w: row.w, h: row.h },
          label: zoneLabel(row.name, row.closed),
          closed: row.closed,
        })),
    );
  };

  // The huddle-kind rows on the current map, with each one's membership
  // split into "the local player" and remote identity hexes — the renderer
  // resolves sprite positions per frame (huddleLayer.ts), so this feed
  // only ever names WHO anchors the circle, never where.
  const pushHuddles = (): void => {
    const mapId = hooks.currentMapId();
    const memberships = [...c.db.groupMember.iter()];
    hooks.setMapHuddles(
      sortedHuddleRows(c.db.conversationGroup.iter())
        .filter((row) => row.mapId === mapId)
        .map((row) => {
          const memberIds: string[] = [];
          let includesLocal = false;
          for (const member of memberships) {
            if (member.groupId !== row.id) continue;
            const idHex = member.identity.toHexString();
            if (idHex === myIdHex) includesLocal = true;
            else memberIds.push(idHex);
          }
          return {
            key: String(row.id),
            label: huddleLabel(row.name, row.closed),
            closed: row.closed,
            includesLocal,
            memberIds,
          };
        }),
    );
  };

  // The huddle control's answer (see HuddleView), re-derived from the
  // cache whenever anything it reads changes — group rows, memberships,
  // and PLAYER rows: the joinable verdict is a proximity test on the
  // authoritative positions, which only ever change through row events
  // (accepted batches, portals, joins), so listening to those events IS
  // listening to movement. Deduplicated by value: the row-event cadence is
  // a few per second while people move, the answer flips rarely.
  let lastHuddleViewKey = '';
  const publishHuddleView = (): void => {
    const view = deriveHuddleView();
    const key = `${view.own ?? ''}|${view.joinable === undefined ? '' : `${view.joinable.id}:${view.joinable.label}`}`;
    if (key === lastHuddleViewKey) return;
    lastHuddleViewKey = key;
    hooks.onHuddle(view);
  };

  const deriveHuddleView = (): HuddleView => {
    const ownMember = c.db.groupMember.identity.find(myIdentity);
    const ownGroup = ownMember === null ? null : c.db.conversationGroup.id.find(ownMember.groupId);
    if (ownGroup !== null && ownGroup.kind === GROUP_KIND_HUDDLE) {
      return { own: huddleLabel(ownGroup.name, ownGroup.closed), joinable: undefined };
    }
    // In no group, or in a zone: founding and joining both stay offered —
    // a huddle is an explicit act that outranks standing zone geometry.
    return { own: undefined, joinable: findJoinable() };
  };

  /** The joinable huddle from the own authoritative position, if any. */
  const findJoinable = (): HuddleView['joinable'] => {
    const own = c.db.player.identity.find(myIdentity);
    if (own === null) return undefined;
    const huddles = sortedHuddleRows(c.db.conversationGroup.iter());
    const candidates = huddles.map((row) => ({
      id: row.id,
      mapId: row.mapId,
      memberPositions: huddleMemberPositions(row.id),
    }));
    const id = findJoinableHuddleId({ x: own.x, y: own.y }, own.mapId, candidates);
    if (id === undefined) return undefined;
    const row = huddles.find((huddle) => huddle.id === id);
    return row === undefined ? undefined : { id, label: huddleLabel(row.name, row.closed) };
  };

  /** The authoritative positions of `groupId`'s members visible in the cache. */
  const huddleMemberPositions = (groupId: bigint): { x: number; y: number }[] => {
    const positions = [];
    for (const member of c.db.groupMember.iter()) {
      if (member.groupId !== groupId) continue;
      const row = c.db.player.identity.find(member.identity);
      if (row !== null) positions.push({ x: row.x, y: row.y });
    }
    return positions;
  };

  const pushAdminView = (): void => {
    hooks.onZones(
      zoneRows().map((row) => ({
        id: row.id,
        key: String(row.id),
        name: row.name,
        closed: row.closed,
        mapId: row.mapId,
        mapName: mapFor(row.mapId).name,
        w: row.w,
        h: row.h,
      })),
    );
  };

  const applyTag = (identity: Identity): void => {
    const idHex = identity.toHexString();
    const tag = cachedZoneTag(c, identity);
    if (idHex === myIdHex) hooks.applyOwnZone(tag);
    else hooks.applyRemoteZone(idHex, tag);
  };

  /** Re-derives every occupant's tag (a group rename/delete changes them all). */
  const applyAllTags = (): void => {
    for (const member of c.db.groupMember.iter()) applyTag(member.identity);
  };

  const refresh = (): void => {
    pushLayer();
    pushHuddles();
    pushAdminView();
    publishHuddleView();
    applyAllTags();
    // The own tag explicitly, beyond the occupant iteration: a session may
    // (re)start with NO own membership row — the iteration then never
    // touches the own tag, and a tag left over from before the reconnect
    // or map switch must clear rather than linger.
    applyTag(myIdentity);
  };

  // Zone rows: the layer, the admin list and every occupant tag re-project
  // on any change. A deleted group's memberships are deleted in the same
  // transaction (delete_zone), and the SDK applies the whole transaction
  // to the cache before firing callbacks — so applyAllTags never resolves
  // a dangling groupId here.
  onAnyRowEvent(c.db.conversationGroup, () => {
    if (hooks.isStale()) return;
    refresh();
  });

  // Membership rows: one player's tag changes, and the huddle circle's
  // member set with it; DELETE must clear the tag explicitly (the
  // statusFeed onDelete rule — the owner may stay rendered while its row
  // goes).
  c.db.groupMember.onInsert((_ctx, row) => {
    if (hooks.isStale()) return;
    applyTag(row.identity);
    pushHuddles();
    publishHuddleView();
  });
  c.db.groupMember.onUpdate((_ctx, _old, row) => {
    if (hooks.isStale()) return;
    applyTag(row.identity);
    pushHuddles();
    publishHuddleView();
  });
  c.db.groupMember.onDelete((_ctx, row) => {
    if (hooks.isStale()) return;
    const idHex = row.identity.toHexString();
    if (idHex === myIdHex) hooks.applyOwnZone(undefined);
    else hooks.applyRemoteZone(idHex, undefined);
    pushHuddles();
    publishHuddleView();
  });

  // Player rows: the joinable verdict is a proximity test on the
  // authoritative positions, so it re-derives as they change. The huddle
  // circles themselves do NOT re-project here — the renderer follows the
  // sprites per frame; only the control's answer reads positions from the
  // cache. Deduplication keeps the per-batch cadence out of React.
  onAnyRowEvent(c.db.player, () => {
    if (hooks.isStale()) return;
    publishHuddleView();
  });

  refresh();
  return { refresh };
}
