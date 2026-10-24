// fallow-ignore-file coverage-gaps -- wires live SpacetimeDB row events to the own-group signal; needs a running host. It carries no rules of its own — the value is the own group_member row's groupId, verbatim
import type { Identity } from 'spacetimedb';
import type { DbConnection } from '../module_bindings';
import type { SessionRows } from './rowEvents';

/**
 * What acting on the own membership needs from the session that wires the
 * feed (the StatusFeedHooks shape).
 */
export interface CallFeedHooks {
  /** The conversation group the own membership names, or undefined in none. */
  onOwnGroup(groupId: bigint | undefined): void;
}

/**
 * Publishes which conversation group THIS client is in, seeded from the
 * cache and kept fresh by the own group_member row's events — what the
 * call dock renders its offer from and auto-leaves the call on (a call is
 * the GROUP's: walking away from the huddle, switching zones or being
 * swept out of the world must end your participation — ROADMAP Phase 4
 * 増分①). Deduplicated by value like every derived feed, so the row-event
 * cadence stays out of React.
 */
export function wireOwnGroup(
  c: DbConnection,
  rows: SessionRows,
  myIdentity: Identity,
  hooks: CallFeedHooks,
): void {
  // The dedupe memory; null is the never-published sentinel (a groupId is
  // bigint | undefined, so null cannot collide with a real value).
  let last: bigint | null | undefined = null;
  const publish = (): void => {
    const groupId = c.db.groupMember.identity.find(myIdentity)?.groupId;
    if (groupId === last) return;
    last = groupId;
    hooks.onOwnGroup(groupId);
  };
  const onOwnRow = (row: { identity: Identity }): void => {
    if (rows.isOwn(row.identity)) publish();
  };
  rows.on(c.db.groupMember, { insert: onOwnRow, update: onOwnRow, delete: onOwnRow });
  publish();
}
