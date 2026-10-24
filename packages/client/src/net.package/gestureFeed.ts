// fallow-ignore-file coverage-gaps -- wires live SpacetimeDB row events to the avatar poses; needs a running host. The vocabulary validation and the state/transient split live in @kaede/shared, unit-tested there
import { isGestureKind, isTransientGesture } from '@kaede/shared';
import type { Identity } from 'spacetimedb';
import type { DbConnection } from '../module_bindings';
import type { SessionRows } from './rowEvents';
import type { RowOf } from './rows';

/** The generated gesture row type. */
type GestureRow = RowOf<'gesture'>;

/**
 * What acting on gesture rows needs from the session that wires the feed.
 * Exported for the ReactionFeedHooks reason (fallow's private-type-leaks
 * rule on exported signatures).
 */
export interface GestureFeedHooks {
  /** Applies a STATE gesture directive (sit / sleep / dance), or none. */
  applyOwn(gesture: string | undefined): void;
  applyRemote(idHex: string, gesture: string | undefined): void;
  /** Plays the transient wave — row events only, never the seed. */
  waveOwn(): void;
  waveRemote(idHex: string): void;
}

/**
 * The state-gesture directive the subscribed cache holds for `identity` —
 * the seed half of the gesture display (Phase 5 ①c). STATE gestures (sit /
 * sleep / dance) restore from the seed like a status: someone sitting must
 * still be sitting after your reload or when you enter their map. The
 * transient wave reads as none here — a seeded wave row is history that
 * must not replay (the reaction seed rule; see isTransientGesture). The
 * narrowing doubles as the isReactionEmoji boundary: a row this module
 * cannot vouch for renders nothing.
 */
export function cachedStateGesture(c: DbConnection, identity: Identity): string | undefined {
  const row = c.db.gesture.identity.find(identity);
  if (!row || !isGestureKind(row.gesture) || isTransientGesture(row.gesture)) return undefined;
  return row.gesture;
}

/**
 * Wires one session's gesture rows (Phase 5 ①c): the THIRD display
 * convention, between reactions (events only) and statuses (seed +
 * events) — the split per gesture lives in isTransientGesture. Insert and
 * update both carry the new value (the identity-keyed upsert shape);
 * DELETE clears the pose explicitly (the wireStatuses reason: the server
 * clears the row on movement and removePlayer, while the sprite keeps
 * rendering), and a repeat of the SAME gesture still fires an update
 * because the row's sentAt changed (how a second wave re-plays).
 */
export function wireGestures(c: DbConnection, rows: SessionRows, hooks: GestureFeedHooks): void {
  const applyState = (identity: Identity, gesture: string | undefined): void =>
    rows.route(
      identity,
      () => hooks.applyOwn(gesture),
      (idHex) => hooks.applyRemote(idHex, gesture),
    );
  const showTransient = (identity: Identity): void => {
    // The row no longer holds a state gesture (a sitter who waves stands
    // up into the wave), so the state directive clears alongside.
    applyState(identity, undefined);
    rows.route(
      identity,
      () => hooks.waveOwn(),
      (idHex) => hooks.waveRemote(idHex),
    );
  };
  const show = (row: GestureRow): void => {
    if (!isGestureKind(row.gesture)) return;
    if (isTransientGesture(row.gesture)) showTransient(row.identity);
    else applyState(row.identity, row.gesture);
  };
  rows.on(c.db.gesture, {
    insert: show,
    update: show,
    delete: (row) => applyState(row.identity, undefined),
  });
}
