// fallow-ignore-file coverage-gaps -- wires live SpacetimeDB row events to the reaction badges; needs a running host. The palette validation and rate rule live in @maple/shared, unit-tested there
import { isReactionEmoji, type ReactionEmoji } from '@maple/shared';
import type { DbConnection } from '../module_bindings';
import type { RowOf } from './rows';

/** The generated reaction row type. */
type ReactionRow = RowOf<'reaction'>;

/** What acting on reaction rows needs from the session that wires the feed. */
export interface ReactionFeedHooks {
  /** True once this session's events must be ignored (see wireSession). */
  isStale(): boolean;
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
export function wireReactions(c: DbConnection, myIdHex: string, hooks: ReactionFeedHooks): void {
  const show = (row: ReactionRow): void => {
    if (hooks.isStale()) return;
    // The raw row string enters here and nowhere else, so this is where the
    // palette narrowing lives — the server already refuses non-palette
    // emojis (send_reaction), but a row this module cannot vouch for
    // renders nothing rather than arbitrary text on the canvas.
    if (!isReactionEmoji(row.emoji)) return;
    // The badge shows over whoever reacted: our own avatar, or the
    // sender's remote view. A reaction from a player whose view is not on
    // screen (hidden as offline, or already removed) is a no-op.
    const idHex = row.identity.toHexString();
    if (idHex === myIdHex) hooks.showLocalReaction(row.emoji);
    else hooks.showRemoteReaction(idHex, row.emoji);
  };
  c.db.reaction.onInsert((_ctx, row) => show(row));
  c.db.reaction.onUpdate((_ctx, _old, row) => show(row));
}
