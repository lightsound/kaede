// fallow-ignore-file coverage-gaps -- wires live SpacetimeDB row events to the reaction badges; needs a running host. The palette validation and rate rule live in @kaede/shared, unit-tested there
import { isReactionEmoji, type ReactionEmoji } from '@kaede/shared';
import type { DbConnection } from '../module_bindings';
import type { SessionRows } from './rowEvents';
import type { RowOf } from './rows';

/** The generated reaction row type. */
type ReactionRow = RowOf<'reaction'>;

/**
 * What acting on reaction rows needs from the session that wires the feed.
 * Exported because it appears in wireReactions' exported signature, which
 * fallow's private-type-leaks rule refuses for a private type.
 */
export interface ReactionFeedHooks {
  showLocalReaction(emoji: ReactionEmoji): void;
  showRemoteReaction(idHex: string, emoji: ReactionEmoji): void;
}

/**
 * Wires one session's reaction display (ROADMAP Phase 2). Reactions show
 * only from row EVENTS, never from the subscribed cache's seed — the
 * chatFeed bubble rule: an event is someone reacting now, while a seeded
 * row is history (the upsert row outlives its display window, so a reload
 * must not replay it). Both event kinds trigger, because the identity-keyed
 * upsert schema makes the first reaction an insert and every later one an
 * update. The display timer arms client-side on receipt (the bubble's
 * expiresAt way); the row's sentAt is never compared against this clock.
 */
export function wireReactions(c: DbConnection, rows: SessionRows, hooks: ReactionFeedHooks): void {
  const show = (row: ReactionRow): void => {
    // The raw row string enters here and nowhere else, so this is where the
    // palette narrowing lives — the server already refuses non-palette
    // emojis (send_reaction), but a row this module cannot vouch for
    // renders nothing rather than arbitrary text on the canvas.
    const emoji = row.emoji;
    if (!isReactionEmoji(emoji)) return;
    // The badge shows over whoever reacted: our own avatar, or the
    // sender's remote view. A reaction from a player whose view is not on
    // screen (hidden as offline, or already removed) is a no-op.
    rows.route(
      row.identity,
      () => hooks.showLocalReaction(emoji),
      (idHex) => hooks.showRemoteReaction(idHex, emoji),
    );
  };
  rows.on(c.db.reaction, { insert: show, update: show });
}
