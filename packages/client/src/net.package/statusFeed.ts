// fallow-ignore-file coverage-gaps -- wires live SpacetimeDB row events to the status lines; needs a running host. The narrowing, default and label rules live in @kaede/shared (statusViewOf / DEFAULT_STATUS / statusLabel), unit-tested there
import { DEFAULT_STATUS, type StatusView, statusViewOf } from '@kaede/shared';
import type { Identity } from 'spacetimedb';
import type { DbConnection } from '../module_bindings';
import type { SessionRows } from './rowEvents';

/**
 * What acting on status rows needs from the session that wires the feed.
 * Exported for the same fallow private-type-leaks reason as
 * ReactionFeedHooks: it appears in wireStatuses' exported signature.
 */
export interface StatusFeedHooks {
  applyOwn(view: StatusView): void;
  applyRemote(idHex: string, view: StatusView): void;
}

/**
 * The status view the subscribed cache holds for `identity` — the seed half
 * of the status display (a status is STATE, restored on entry/reload; the
 * opposite of the reaction seed rule). A missing row means the default
 * (see the player_status table), and statusViewOf narrows the raw row at
 * this boundary (the isReactionEmoji rule): a row this module cannot vouch
 * for reads as the default rather than rendering an unvetted string. The
 * same cache-before-event SDK guarantee as playerFeed.ts's nameOf makes
 * reading it during row handling safe.
 */
export function cachedStatusView(c: DbConnection, identity: Identity): StatusView {
  return statusViewOf(c.db.playerStatus.identity.find(identity));
}

/**
 * Wires one session's status row EVENTS (ROADMAP Phase 2) — playerFeed.ts's
 * applyName wiring, for the line beside the name. Insert and update both
 * carry the new view (the first write of an identity-keyed upsert row is an
 * insert, every later one an update); DELETE is wired too, unlike names,
 * because this table loses rows while their owner stays rendered on this
 * screen — removePlayer deletes player and status together, and the own
 * sprite keeps drawing through that — so the missing row's meaning (the
 * default) must be applied explicitly.
 */
export function wireStatuses(c: DbConnection, rows: SessionRows, hooks: StatusFeedHooks): void {
  const apply = (identity: Identity, view: StatusView): void =>
    rows.route(
      identity,
      () => hooks.applyOwn(view),
      (idHex) => hooks.applyRemote(idHex, view),
    );
  rows.on(c.db.playerStatus, {
    insert: (row) => apply(row.identity, statusViewOf(row)),
    update: (row) => apply(row.identity, statusViewOf(row)),
    delete: (row) => apply(row.identity, DEFAULT_STATUS),
  });
}
