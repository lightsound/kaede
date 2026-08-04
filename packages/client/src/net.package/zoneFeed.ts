// fallow-ignore-file coverage-gaps -- wires live SpacetimeDB row events to the zone layer and occupancy tags; needs a running host. The geometry, labels and occupancy rules live in @kaede/shared (zone.ts), unit-tested there
import { mapFor, sortedZoneRows, zoneLabel, zoneTagLabel } from '@kaede/shared';
import type { Identity } from 'spacetimedb';
import type { ZoneRender } from '../game.package';
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

/** What acting on zone and occupancy rows needs from the session that wires the feed. */
export interface ZoneFeedHooks {
  /** True once this session's events must be ignored (see wireSession). */
  isStale(): boolean;
  /** The map whose zones the canvas currently renders. */
  currentMapId(): number;
  /** Replaces the rendered zone layer (already filtered to the current map). */
  setMapZones(zones: readonly ZoneRender[]): void;
  applyOwnZone(tag: string | undefined): void;
  applyRemoteZone(idHex: string, tag: string | undefined): void;
  /** Every conversation_group change, as the whole admin view (all maps). */
  onZones(zones: ZoneAdminView[]): void;
}

/**
 * The composed occupancy tag the subscribed cache holds for `identity`, or
 * undefined while in no group — the seed half of the tag display
 * (occupancy is STATE, like a status: restored on entry/reload and read by
 * labelOf when a remote view is (re)created). Any group kind tags: a
 * huddle member (増分③) is in a conversation too.
 */
export function cachedZoneTag(c: DbConnection, identity: Identity): string | undefined {
  const member = c.db.groupMember.identity.find(identity);
  if (member === null) return undefined;
  const group = c.db.conversationGroup.id.find(member.groupId);
  return group === null ? undefined : zoneTagLabel(group.name);
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
    pushAdminView();
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

  // Membership rows: one player's tag changes; DELETE must clear it
  // explicitly (the statusFeed onDelete rule — the owner may stay rendered
  // while its row goes).
  c.db.groupMember.onInsert((_ctx, row) => {
    if (hooks.isStale()) return;
    applyTag(row.identity);
  });
  c.db.groupMember.onUpdate((_ctx, _old, row) => {
    if (hooks.isStale()) return;
    applyTag(row.identity);
  });
  c.db.groupMember.onDelete((_ctx, row) => {
    if (hooks.isStale()) return;
    const idHex = row.identity.toHexString();
    if (idHex === myIdHex) hooks.applyOwnZone(undefined);
    else hooks.applyRemoteZone(idHex, undefined);
  });

  refresh();
  return { refresh };
}
