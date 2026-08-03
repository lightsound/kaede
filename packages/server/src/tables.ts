// fallow-ignore-file coverage-gaps -- a SpacetimeDB schema declaration; validated by publishing the module, not by unit tests
import { schema, t, table } from 'spacetimedb/server';

export const spacetimedb = schema({
  // The global (Discord-model) account layer: profile and belongings live here
  // and travel across organizations (VISION アカウントモデル). The internal
  // `id` — not the SpacetimeDB Identity — is the primary key, because an
  // Identity is derived from the auth provider's issuer+subject: switching
  // providers mints new Identities, and re-linking then only rewrites the
  // `identity` column while everything keyed by `id` survives untouched.
  //
  // Schema guardrails applied from day one (VISION):
  // - Conversation data (chat, DMs — Phase 2+) must be keyed by an
  //   organization scope, never directly by account or player, so it stays
  //   closed inside the organization it happened in.
  // - Per-organization profile overrides (display name / avatar) arrive later
  //   as an additive table referencing `id`; this table stays the global
  //   fallback.
  //
  // Not public: clients render names from the player row, and the
  // identity-to-account mapping is nobody else's business.
  account: table(
    { name: 'account' },
    {
      id: t.u64().primaryKey().autoInc(),
      identity: t.identity().unique(),
      // Absent until the member first sets a name; join falls back to a default.
      displayName: t.string().optional(),
      createdAt: t.timestamp(),
      updatedAt: t.timestamp(),
    },
  ),
  // Membership of the single MVP space (承認制・管理者ロール — ROADMAP
  // Phase 1). This is deliberately a table of its own rather than columns on
  // `account`: an account is global (Discord model), while being admitted to
  // a space is per-space — multi-tenancy (Phase 6) adds an org-scoped
  // sibling additively and this table's shape already matches it. For the
  // same reason, space-level actions (reject / ban) only ever move `status`
  // on this row and never touch the account: one space's decision must not
  // damage the profile a member carries across spaces. Rows are never
  // deleted, which is what makes every admin action reversible.
  //
  // A row is created by the apply_for_membership reducer (joining is an
  // explicit application, not a connection side effect).
  //
  // Public, unlike `account`, because it is how a client learns its own
  // standing: a pending member subscribes to this table and sees its row
  // flip to approved the instant an admin acts (no polling, no join
  // retries), and the admin UI reads the pending list from the same rows.
  // What it exposes — who is a member, their status/role and display name —
  // is the space's member directory, comparable to what the public `player`
  // table already shows about everyone in the world; the private
  // identity-to-account-id mapping and future belongings stay on `account`.
  // `displayName` is a projection of account.displayName (kept in sync by
  // set_display_name) so admins can tell applicants apart.
  //
  // Re-linking an account to a new provider identity (see `account`) must
  // rewrite `identity` here too.
  spaceMember: table(
    { name: 'space_member', public: true },
    {
      identity: t.identity().primaryKey(),
      displayName: t.string().optional(),
      // MemberStatus in @maple/shared: 'pending' | 'approved' | 'rejected' | 'banned'
      status: t.string(),
      role: t.string(), // MemberRole in @maple/shared: 'member' | 'admin'
      requestedAt: t.timestamp(), // when the (latest) application was filed
      updatedAt: t.timestamp(),
    },
  ),
  // Space-wide settings (単一スペースのグローバル設定 — the prototype of the
  // per-organization settings VISION plans for). One row, id 0; a missing
  // row reads as the defaults (guests allowed), so no init hook is needed
  // and existing databases pick the defaults up on re-publish. Public so
  // guests can see the admission setting flip in real time and enter the
  // moment an admin re-allows them.
  spaceSetting: table(
    { name: 'space_setting', public: true },
    {
      id: t.u8().primaryKey(),
      guestsAllowed: t.bool(),
    },
  ),
  // The hot row: rewritten on every accepted input batch and broadcast to
  // every subscriber, so egress/write/read costs scale with its size times
  // the update rate (ROADMAP Phase 2 の player 行ダイエット). Only what every
  // client needs on every movement update lives here; anything low-frequency
  // (name → player_name) or server-internal (allowanceMicros → player_guard)
  // is split out. `updatedAt` stays despite changing every update: clients
  // anchor remote interpolation on it (the server-timeline timestamp fed to
  // the clock estimator — see remoteView.ts) and the offline sweep reads it;
  // changing in lockstep with the row, splitting it out would save nothing.
  //
  // The three player_* tables live and die together: join inserts all three
  // in one transaction and every removal path deletes all three (see
  // removePlayer in reducers.ts), so a player row always has its name and
  // guard siblings.
  player: table(
    { name: 'player', public: true },
    {
      identity: t.identity().primaryKey(),
      x: t.number(),
      y: t.number(),
      vx: t.number(),
      vy: t.number(),
      facing: t.i8(), // -1 left, 1 right
      onGround: t.bool(),
      rope: t.i32(), // rope index while climbing, -1 = none
      tick: t.u32(), // ticks applied so far; state is "after tick `tick`"
      online: t.bool(), // false between disconnect and rejoin/sweep; hidden by clients
      updatedAt: t.timestamp(),
    },
  ),
  // The display name of everyone in the world, split from `player` because it
  // changes on join/rename only: keeping it on the hot row meant
  // re-broadcasting the string to every client on every movement update.
  // Public — clients render name labels from it — and subscribed alongside
  // `player` (connection.ts).
  playerName: table(
    { name: 'player_name', public: true },
    {
      identity: t.identity().primaryKey(),
      name: t.string(),
    },
  ),
  // The speed-hack guard's token-bucket marker (micros since epoch), split
  // from `player` because no client has any business seeing it: private
  // tables are never broadcast, so the marker's per-batch updates cost
  // writes but zero egress.
  playerGuard: table(
    { name: 'player_guard' },
    {
      identity: t.identity().primaryKey(),
      allowanceMicros: t.i64(),
    },
  ),
  // The global-scope chat history (ROADMAP Phase 2 第一弾). One row per
  // message, kept to the newest CHAT_HISTORY_MAX rows by the send reducer
  // (保持方針): the initial subscription enumerates this whole public table,
  // so its row count IS every entering client's egress and the space's
  // storage bill.
  //
  // Scope: this table is the single space's conversation, which is what
  // keeps the VISION guardrail (conversation data stays inside the
  // organization it happened in) — the whole database is one org scope, and
  // per the scaling invariant no tenant/org column may appear here. The
  // planned extensions are all additive: Phase 3 chat scopes append a
  // scope discriminator + target column with defaults ('space'-scoped rows
  // read as today's), DMs need private delivery so they land in a table of
  // their own, and reactions reference `id` from their own table.
  //
  // `senderName` snapshots the display name at send time because the
  // history outlives every other name source: player rows are swept ~10
  // minutes after leaving and a guest identity is per-tab, so resolving
  // `sender` at render time would leave old messages nameless. The cost is
  // that a rename does not rewrite history — the IRC reading, accepted.
  // `sender` stays alongside for own-message styling and future moderation.
  //
  // Visibility (an explicit decision, 2026-08-03 review): READING is gated
  // only by holding a connection, like every public table (player
  // positions, the member directory) — admission (guests_allowed, member
  // status) gates writing, via send_chat_message. So a guest connected
  // while guests are disabled, or a rejected/banned member, still receives
  // the retained history and live messages. Accepted for the
  // single-community MVP: the SDK's row-level security
  // (clientVisibilityFilter.sql) cannot express the admission rule — the
  // guest default is "no space_member row AND guests_allowed (missing row
  // = true)", which needs NOT EXISTS and default-on-missing semantics
  // outside the filter SQL subset — and a members-only filter would cut
  // guests off entirely. Revisit with the Phase 3 chat scopes: closed
  // conversation groups need filtered reads anyway, so the mechanism (and
  // this table's read gate) lands with that design.
  chatMessage: table(
    { name: 'chat_message', public: true },
    {
      id: t.u64().primaryKey().autoInc(),
      sender: t.identity(),
      senderName: t.string(),
      text: t.string(),
      sentAt: t.timestamp(),
    },
  ),
  // The chat rate limit's token-bucket marker — player_guard's shape, for
  // send_chat_message. Its own table because existing tables must not change
  // (re-publish compatibility) and because its lifecycle differs: created
  // lazily on the first send, deleted with the player rows (removePlayer),
  // so transient guest identities cannot pile up marker rows forever.
  chatGuard: table(
    { name: 'chat_guard' },
    {
      identity: t.identity().primaryKey(),
      allowanceMicros: t.i64(),
    },
  ),
  // The sender's current emoji reaction (ROADMAP Phase 2), shown transiently
  // above their avatar. One UPSERT row per identity rather than a
  // chat_message-style append log — a deliberate schema decision:
  // - The reaction is an ephemeral gesture with no history value, so rows
  //   for it are pure entry egress. Keying by identity bounds the table at
  //   "everyone currently in the world" with no trimming rule, where an
  //   append log would grow per send and need its own retention sweep.
  // - The visible consequence — one reaction per person at a time, a new
  //   send replacing the previous one mid-display — is the natural reading
  //   of an overhead emote, not a loss.
  // - Clients therefore display on BOTH insert (first reaction) and update
  //   (every later one) row events, never from the initial-subscription
  //   seed: the row outlives its display window, so seeded rows are
  //   history and must not replay on reload (the chat bubble seed/event
  //   rule). `sentAt` exists so a repeat of the SAME emoji still changes
  //   the row (= still fires an update event); clients never compare it
  //   against their own clock — the display timer arms client-side on
  //   event receipt.
  // - Rows die with the player: removePlayer deletes them, because a
  //   departed guest identity's row left behind in a public table would
  //   ride every future entering client's egress forever.
  // Message-attached (Slack-style) reactions are a different feature and
  // arrive later as their own additive table referencing chat_message.id;
  // this table stays the overhead gesture. Like every conversation table,
  // it is the single space's data — no tenant/org column (the scaling
  // invariant).
  reaction: table(
    { name: 'reaction', public: true },
    {
      identity: t.identity().primaryKey(),
      emoji: t.string(),
      sentAt: t.timestamp(),
    },
  ),
  // The reaction rate limit's token-bucket marker — chat_guard's shape, for
  // send_reaction. Deliberately NOT the chat bucket: ChatPanel mirrors
  // chat_guard client-side (allowanceRef) for instant feedback, and a
  // shared bucket would advance server-side on every reaction without the
  // mirror knowing, turning honest chat sends into surprise server
  // refusals. A table of its own costs one more delete in removePlayer
  // (same lifecycle as chat_guard: lazy on first send, deleted with the
  // player rows) and keeps the two rates independently tunable.
  reactionGuard: table(
    { name: 'reaction_guard' },
    {
      identity: t.identity().primaryKey(),
      allowanceMicros: t.i64(),
    },
  ),
  // The sender's manual status (ROADMAP Phase 2): the availability switch
  // (オンライン/離席/取り込み中) and the free-text line, shown persistently
  // beside the name label. The reaction table's shape — one UPSERT row per
  // identity — but the OPPOSITE display convention, because a status is
  // state where a reaction is a gesture:
  // - Clients display it from the initial-subscription SEED as well as from
  //   insert/update row events: a status must survive a reload and greet
  //   every entering client, exactly what replaying seeded reaction rows
  //   must never do. There is no display window and no timestamp column —
  //   re-asserting the same status changes nothing anyone could see, so
  //   nothing needs to force an update event (the reason reaction carries
  //   sentAt does not apply).
  // - A missing row reads as the default (online, no text — DEFAULT_STATUS
  //   in @maple/shared, the space_setting missing-row precedent), so no
  //   join hook seeds rows and only players who changed their status ever
  //   occupy entry egress.
  // - Both values live on one row: they are one concept (the status beside
  //   the name), always rendered together, and a second table would double
  //   the subscription, the cleanup and the guard for no isolation gain.
  //   Each reducer (set_availability / set_status_text) rewrites only its
  //   own column server-side, so the two controls can never clobber each
  //   other with a stale client-side merge.
  // - Rows die with the player: removePlayer deletes them, so the table is
  //   bounded by the world population and a member's status does NOT
  //   persist across sessions (an explicit decision — yesterday's
  //   取り込み中 greeting the morning room is worse than the default, and a
  //   row outliving its public player rows would ride every entering
  //   client's egress forever). It does survive a reload or a network blip:
  //   the row lives exactly as long as the player row, whose retention
  //   window (~10 min) covers both. Cross-session persistence, if ever
  //   wanted, lands additively as an account-keyed table without touching
  //   this one.
  // AFK auto-detection (deferred by ROADMAP) would write this same row from
  // a future reducer; avatar poses (Phase 5) render from it — both additive.
  // Like every realtime table, no tenant/org column (the scaling invariant).
  playerStatus: table(
    { name: 'player_status', public: true },
    {
      identity: t.identity().primaryKey(),
      availability: t.string(), // Availability in @maple/shared: 'online' | 'away' | 'busy'
      text: t.string(), // free-text status line, '' while unset
    },
  ),
  // The status rate limit's token-bucket marker — chat_guard's shape, for
  // set_availability / set_status_text. Honest writes are a few per day,
  // but a status write is a public-row broadcast to every subscriber and a
  // refused send is never charged, so the bucket bounds what a hostile
  // in-world client can turn into egress. Its own table for the same
  // reason reaction_guard is not the chat bucket: ChatPanel mirrors
  // chat_guard client-side, and any shared bucket would advance without
  // the mirror knowing. Same lifecycle as the other lazy guards: created
  // on first send, deleted with the player rows (removePlayer).
  statusGuard: table(
    { name: 'status_guard' },
    {
      identity: t.identity().primaryKey(),
      allowanceMicros: t.i64(),
    },
  ),
});
