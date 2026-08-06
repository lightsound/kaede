// fallow-ignore-file coverage-gaps -- a SpacetimeDB schema declaration; validated by publishing the module, not by unit tests
import { CHAT_SCOPE_GROUP, CHAT_SCOPE_MAP, CHAT_SCOPE_SPACE, DEFAULT_MAP_ID } from '@kaede/shared';
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
      // MemberStatus in @kaede/shared: 'pending' | 'approved' | 'rejected' | 'banned'
      status: t.string(),
      role: t.string(), // MemberRole in @kaede/shared: 'member' | 'admin'
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
      // The map this player is on (WorldMap id in @kaede/shared; ROADMAP
      // Phase 3 AoI). Appended with a default so existing rows migrate on
      // re-publish (additive-only rule), and INDEXED because clients
      // subscribe with `WHERE mapId = ...` — subscription queries are
      // re-evaluated per transaction, so an unindexed filter column would
      // table-scan on every commit (the dm_message sender/recipient
      // precedent). Changed only by enter_portal; replays never cross maps.
      // Per the scaling invariant this stays a MAP id — never a tenant/org
      // discriminator (the whole database is one org scope).
      mapId: t.u32().index().default(DEFAULT_MAP_ID),
    },
  ),
  // The display name of everyone in the world, split from `player` because it
  // changes on join/rename only: keeping it on the hot row meant
  // re-broadcasting the string to every client on every movement update.
  // Public — clients render name labels from it — and subscribed alongside
  // `player` (connection.ts).
  //
  // Since the map-scoped player subscription (Phase 3 AoI), this table is
  // also the SPACE-WIDE presence directory: the `player` subscription is
  // filtered to the client's own map, so anything that must see everyone in
  // the space regardless of map — today the DM mention candidates
  // (collectDmCandidates) — reads this table instead. That is why `online`
  // is mirrored here (appended with a default, additive-only rule): it is
  // player.online's low-frequency shadow, rewritten only when the flag
  // actually flips (connect/disconnect/heartbeat-refresh — see
  // syncNameOnline in world.ts), never on movement, so the hot-row diet
  // that split this table off is not undone. The rows' lifecycle is
  // unchanged: created with the player row, deleted with it (removePlayer),
  // so "a named row exists" still means "in the world (within retention)".
  //
  // The default is FALSE deliberately, for the one moment it applies: the
  // migration backfill of rows that predate the column. Backfilling true
  // would resurrect disconnected-but-retained players as DM candidates for
  // up to the retention window (send_dm would refuse them, but only after
  // the sender tried); backfilling false merely hides players until their
  // reconnect writes true back (every live path does: join's sibling
  // upsert, the heartbeat refresh, every accepted batch) — a false
  // negative that self-heals in seconds beats a lingering false positive.
  playerName: table(
    { name: 'player_name', public: true },
    {
      identity: t.identity().primaryKey(),
      name: t.string(),
      online: t.bool().default(false),
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
  // read as today's), and reactions reference `id` from their own table.
  // DMs needed private delivery, so they landed in a table of their own —
  // `dm_message` below, additively, exactly as planned here.
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
  // guests off entirely. What the filter SQL CAN express is a per-row
  // sender/recipient rule, which is exactly how `dm_message` gets its
  // private delivery (verified locally and on Maincloud with non-owner
  // connections, 2026-08-03). Revisit this table's read gate with the
  // Phase 3 chat scopes: closed conversation groups need filtered reads
  // anyway, so the mechanism is now proven and the design lands there.
  chatMessage: table(
    { name: 'chat_message', public: true },
    {
      id: t.u64().primaryKey().autoInc(),
      sender: t.identity(),
      senderName: t.string(),
      text: t.string(),
      sentAt: t.timestamp(),
      // Which conversation this message belongs to (ROADMAP Phase 3 増分④),
      // exactly the additive extension planned above: ChatScope in
      // @kaede/shared ('space' | 'map' | 'group'), appended with the 'space'
      // default so every pre-増分④ row reads as 全体 and no migration writes
      // a single row. INDEXED because both the row-level-security filters
      // below and the client's map-scoped subscription select on it, and
      // subscription queries are re-evaluated per transaction (the
      // player.mapId rule).
      scope: t.string().index().default(CHAT_SCOPE_SPACE),
      // What the scope points AT: the WorldMap id for 'map' (zero-extended
      // to u64 — one column cannot be two widths), the conversation_group id
      // for 'group', unused (0) for 'space'. One target column rather than
      // one per kind: the scope discriminates, and a second nullable column
      // would only add a way for the two to disagree. Indexed for the same
      // filter reason as `scope`.
      target: t.u64().index().default(0n),
      // The admin announcement marker (ROADMAP Phase 3 増分④ 管理者の全体
      // アナウンス): a space-scoped message rendered as 強調. Deliberately a
      // FLAG rather than a fourth `scope` value, because an announcement is
      // space-scoped in every respect that matters to delivery — the RLS
      // allow-list, the subscription and the retention trim all treat it as
      // one — and only its sender eligibility (admins) and its rendering
      // differ. A scope value would have forked those three paths to say the
      // same thing. Clients cannot set it: send_chat_message always writes
      // false and only send_announcement (admin-checked) writes true.
      announcement: t.bool().default(false),
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
  //   in @kaede/shared, the space_setting missing-row precedent), so no
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
      availability: t.string(), // Availability in @kaede/shared: 'online' | 'away' | 'busy'
      text: t.string(), // free-text status line, '' while unset
    },
  ),
  // The @mention DM history (ROADMAP Phase 2) — chat_message's shape with a
  // recipient, in a table of its own because delivery is PRIVATE: the
  // row-level-security filter below (dmMessageVisibility) hands each row
  // only to its sender and its recipient, which no column on the public
  // chat table could do. The table itself is still `public: true` — RLS
  // filters what a public table's subscription yields per connection; a
  // non-public table would yield nothing to anyone.
  //
  // - `sender` and `recipient` carry btree indexes because the RLS filter
  //   selects on them and subscription queries are re-evaluated per
  //   transaction — without indexes every commit would table-scan on every
  //   subscriber's behalf (the ROADMAP AoI rule, applied here).
  // - BOTH names are snapshotted at send time, for the same reason
  //   chat_message snapshots senderName: the history outlives every name
  //   source (player rows sweep ~10 minutes after leaving, a guest identity
  //   is per-tab), and a render-time recipient lookup would leave the other
  //   side of an old conversation nameless the moment they left.
  // - Retention is one global cap, DM_HISTORY_MAX in @kaede/shared (see its
  //   comment for why a per-pair cap would grow storage without bound), and
  //   rows deliberately do NOT ride removePlayer: the reaction /
  //   player_status "rows die with the player" rule is for ephemeral state,
  //   while history outlives the player rows (the chat_message precedent) —
  //   a member leaving must not erase the other member's copy of their
  //   conversation. Rows whose both identities are gone (two closed guest
  //   tabs) are displaced by the cap like any other row.
  // - Like every conversation table: the single space's data, no tenant/org
  //   column (the scaling invariant). Message-attached reactions, read
  //   state and notification bookkeeping, if ever wanted, land additively
  //   in tables referencing `id`.
  dmMessage: table(
    { name: 'dm_message', public: true },
    {
      id: t.u64().primaryKey().autoInc(),
      sender: t.identity().index(),
      recipient: t.identity().index(),
      senderName: t.string(),
      recipientName: t.string(),
      text: t.string(),
      sentAt: t.timestamp(),
    },
  ),
  // 会話グループ (ROADMAP Phase 3 増分②③ / VISION の統一抽象): one row per
  // conversation group. `kind` discriminates the group's nature:
  // - 'zone' (増分②): the admin-placed meeting-room zone, whose placement
  //   lives in mapId + x/y/w/h.
  // - 'huddle' (増分③): the ad-hoc 立ち話グループ anyone founds on the
  //   spot — exactly the additive row vocabulary this table planned for
  //   (no schema change). A huddle's position derives from its members'
  //   avatars, so x/y/w/h stay 0 and unused; `mapId` is its FOUNDING map,
  //   invariant for the row's life (teleporting off it is leaving — the
  //   keepsHuddleMembership rule), and its rows live exactly as long as
  //   they have members: every membership-removal path deletes a huddle
  //   row that hits zero members (cleanupEmptyHuddle in world.ts), so no
  //   retention sweep is needed and one identity can keep at most one
  //   huddle alive.
  // 増分④'s chat scopes then reference `id` as their target regardless of
  // kind, which is the whole point of unifying: one table to scope on, one
  // membership table to filter visibility with.
  //
  // `closed` is the オープン/クローズド setting (VISION): whether the
  // group's conversation is visible to non-members. In this increment it
  // only changes the rendering (the zone's 🔒 label; the huddle's 🤫
  // 「コソコソ話している」 look); the chat invisibility it promises is
  // 増分④'s RLS work.
  //
  // `mapId` is indexed: the server-side occupancy pass filters zones by the
  // moving player's map inside movement reducers, and 増分④'s map-scoped
  // subscriptions may filter on it (the ROADMAP AoI rule — filter columns
  // carry indexes). Kind is deliberately NOT a fenced enum column: builds
  // narrow by exact match (GROUP_KIND_ZONE / GROUP_KIND_HUDDLE), so rows of
  // a newer kind render as nothing rather than breaking (the
  // availability-vocabulary rule).
  //
  // No timestamp columns, deliberately: zone rows are admin-edited config
  // with no retention rule (bounded by ZONE_MAX, not by trimming), nothing
  // renders a created-at, and columns it does not have are columns the E2E
  // seeding (`spacetimedb-cli sql` INSERT — which cannot express optionals
  // or timestamps) does not need to fake. Like every realtime table: the
  // single space's data, no tenant/org column (the scaling invariant).
  conversationGroup: table(
    { name: 'conversation_group', public: true },
    {
      id: t.u64().primaryKey().autoInc(),
      kind: t.string(), // GROUP_KIND_ZONE in @kaede/shared ('huddle' arrives with 増分③)
      name: t.string(),
      closed: t.bool(),
      mapId: t.u32().index(),
      x: t.number(),
      y: t.number(),
      w: t.number(),
      h: t.number(),
    },
  ),
  // Who is in which conversation group (誰がどのゾーン/立ち話に居るか) —
  // the space-wide occupancy directory, public so every client renders the
  // occupancy tag whatever map it is looking at (the player_name presence
  // precedent). Keyed by identity, so "one conversation group at a time"
  // is structural, not a rule someone must remember to enforce. Zone
  // membership is written ONLY by the server-side occupancy pass
  // (syncGroupOccupancy in world.ts) — clients never name their zone, so
  // there is nothing to trust or rate-limit. Huddle membership (増分③) is
  // written by the huddle reducers (an explicit join is the point of a
  // 立ち話 — huddles.ts re-rules the geometry server-side and rate-limits
  // with huddle_guard) plus the same occupancy pass for the walk-away
  // auto-leave; while a membership names a huddle the pass never reassigns
  // it to a zone (explicit intent outranks standing geometry — see
  // syncGroupOccupancy).
  //
  // `groupId` carries a btree index for 増分④: the closed-conversation RLS
  // filter joins chat rows to this table on groupId with :sender bound to
  // `identity`, and RLS/subscription filter columns must be indexed
  // (the dm_message sender/recipient precedent, per the ROADMAP AoI rule).
  //
  // Rows die with the player (removePlayer), like reaction/player_status:
  // occupancy is ephemeral presence state, and an orphaned public row
  // would ride every entering client's egress forever.
  groupMember: table(
    { name: 'group_member', public: true },
    {
      identity: t.identity().primaryKey(),
      groupId: t.u64().index(),
    },
  ),
  // The connection-event log (ROADMAP Phase 2 エラー監視 ②): one row per
  // clientConnected / clientDisconnected, the server-side primary source for
  // the reconnect-failure metric. It must live HERE and not in the browser's
  // telemetry: when the network is down, the client's beacon cannot leave
  // the machine either, so the only party that reliably observes a client
  // failing to come back is the server (ADR §8.1-2).
  //
  // Deliberately NOT public: an append-only log broadcast to every
  // subscriber would ride each entering client's initial subscription and
  // re-broadcast every insert to the whole room — pure egress for rows no
  // client renders. Private tables are never broadcast, so these rows cost
  // writes and storage only. The reader is the operator, over
  // `spacetime sql` (e.g. failure rate = unannounced disconnects without a
  // matching reconnect, grouped by hour).
  //
  // `connectionId` correlates the pair: one connection produces exactly one
  // 'connected' and one 'disconnected' row, while `identity` alone cannot
  // tell a member's two tabs apart. `detail` carries the classification —
  // 'member' | 'guest' on connect (the classifyConnection verdict),
  // DisconnectReason ('idle' | 'unannounced', @kaede/shared) on disconnect —
  // because an idle cut (the idle guard's deliberate suspension after
  // IDLE_DISCONNECT_MS without input — idle.ts) is the majority disconnect
  // in an always-open office and counting it as a failure would drown the
  // metric the log exists for.
  //
  // Kept to CONNECTION_EVENT_MAX rows by the writers (the chat_message
  // trimHistory pattern), so the log cannot grow without bound.
  connectionEvent: table(
    { name: 'connection_event' },
    {
      id: t.u64().primaryKey().autoInc(),
      identity: t.identity(),
      connectionId: t.connectionId(),
      kind: t.string(), // 'connected' | 'disconnected'
      detail: t.string(), // connect: 'member' | 'guest'; disconnect: DisconnectReason
      at: t.timestamp(),
    },
  ),
  // The announced-disconnect marker: announce_idle_suspend files one row for
  // the sender CONNECTION (not identity — a member's second tab must not
  // relabel the first tab's drop), and clientDisconnected consumes it to
  // classify the drop (disconnectReasonFrom in @kaede/shared). Private and
  // transient — a row normally lives for the milliseconds between the
  // announce and the socket close; rows orphaned past their freshness window
  // (an announce whose disconnect never fired) are swept by the disconnect
  // handler so they can neither mislabel a later drop nor pile up.
  disconnectIntent: table(
    { name: 'disconnect_intent' },
    {
      connectionId: t.connectionId().primaryKey(),
      announcedAt: t.timestamp(),
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
  // The portal-use rate limit's token-bucket marker — chat_guard's shape,
  // for enter_portal (ROADMAP Phase 3). A teleport is a public hot-row write
  // broadcast to the subscribers of both maps, with no tick budget bounding
  // it (unlike movement) — and a portal pair lands you inside the return
  // portal, so ping-ponging as fast as calls can land is always
  // geometrically valid; the bucket bounds what that can turn into egress
  // (the status_guard reasoning). Its own table like every other guard:
  // buckets shared across features drift from their client-side mirrors.
  // Same lifecycle as the other lazy guards: created on first use, deleted
  // with the player rows (removePlayer).
  portalGuard: table(
    { name: 'portal_guard' },
    {
      identity: t.identity().primaryKey(),
      allowanceMicros: t.i64(),
    },
  ),
  // The huddle rate limit's token-bucket marker — chat_guard's shape, for
  // create_huddle / join_huddle / leave_huddle (ROADMAP Phase 3 増分③).
  // Every huddle call writes public rows broadcast to every subscriber
  // (a group row and/or a membership row), and unlike the zone reducers
  // these are open to everyone in the world, so they get the posting
  // guard treatment. One bucket for all three: they are the same UI
  // surface with no client-side mirror to drift from, and one bucket also
  // caps a create/leave (or join/leave) ping-pong as a whole. Same
  // lifecycle as the other lazy guards: created on first use, deleted
  // with the player rows (removePlayer).
  huddleGuard: table(
    { name: 'huddle_guard' },
    {
      identity: t.identity().primaryKey(),
      allowanceMicros: t.i64(),
    },
  ),
  // A conversation group's video call (ROADMAP Phase 4 増分①): groupId →
  // the call provider's meeting id, the reusable room every joining
  // member's CallProvider dials. `groupId` as the PRIMARY KEY makes "one
  // call per conversation group" structural (the group_member identity-PK
  // precedent), and the PK's btree is the index the RLS join below selects
  // on. The row means "a meeting is provisioned for this group", not "a
  // call is live": nobody tracks who is inside the meeting yet (that is
  // the recording/presence increment's webhook work), so the row lives as
  // long as its GROUP does — delete_zone and cleanupEmptyHuddle delete it
  // with the group row (deleteGroupCall in world.ts) — and re-joining an
  // idle meeting is the provider's normal reuse, not a bug.
  //
  // The meeting id is the JOIN CAPABILITY: the token-minting Worker
  // verifies the caller is a signed-in member of the SPACE (a Clerk JWT)
  // but knows nothing about groups — SpacetimeDB is the only group
  // authority, so which GROUP'S call a member may join is enforced
  // entirely by who can read this row (the members-only RLS filter below,
  // the dm_message thinking). A member who shares the id out of band can
  // already share the call itself; that is the chat-history trust level,
  // accepted. Registration (register_group_call in calls.ts) accepts only
  // the sender's own group and a provider-shaped id (isMeetingIdLike in
  // @kaede/shared), from any in-world identity — guests included since
  // 増分② (the Worker mints for them too; see the calls.ts header).
  //
  // No timestamp columns, deliberately (the conversation_group rule):
  // nothing rules on a registered-at, and columns the table does not have
  // are columns the E2E seeding (`spacetimedb-cli sql` INSERT — which
  // cannot express timestamps) does not need to fake. Like every realtime
  // table: the single space's data, no tenant/org column (the scaling
  // invariant).
  groupCall: table(
    { name: 'group_call', public: true },
    {
      groupId: t.u64().primaryKey(),
      meetingId: t.string(),
    },
  ),
  // The call-registration rate limit's token-bucket marker — chat_guard's
  // shape, for register_group_call (ROADMAP Phase 4 増分①). Its own bucket
  // for the standing reason (buckets shared across features drift from
  // their client-side mirrors), and because a refused registration must
  // not tax chat: the call flow retries by design (two members racing to
  // register resolve through a refusal). Same lifecycle as the other lazy
  // guards: created on first use, deleted with the player rows
  // (removePlayer).
  callGuard: table(
    { name: 'call_guard' },
    {
      identity: t.identity().primaryKey(),
      allowanceMicros: t.i64(),
    },
  ),
});

// Row-level security for dm_message: a connection is handed only the rows it
// sent or received (:sender is the subscriber's identity). One filter with
// OR — verified to work as a single filter (2026-08-03 spike, non-owner
// connections; the fallback of two filters unioned was not needed). The
// module owner bypasses RLS (`spacetimedb-cli sql` reads everything), which
// is why the spike had to prove privacy with ordinary client connections.
// Registered by being a module export (index.ts re-exports it).
export const dmMessageVisibility = spacetimedb.clientVisibilityFilter.sql(
  'SELECT * FROM dm_message WHERE sender = :sender OR recipient = :sender',
);

// Row-level security for chat_message (ROADMAP Phase 3 増分④): the closed
// conversation groups' messages reach their MEMBERS only. Registering any
// filter on a table makes the filters an ALLOW-LIST — a row matching none of
// them reaches nobody — so the space and map scopes need their own filters
// even though they hide nothing; the closed-group JOIN alone would have
// deleted every other message in the space the moment this shipped.
//
// Four filters rather than one OR: the union of a table's filters is what a
// connection sees (the dm_message spike's fallback, needed here), and each
// JOIN needs its own FROM clause anyway. Both joins carry an explicit ON
// clause, and both join columns are indexed: with the same join written as a
// WHERE equality the host rejects EVERY subscription on this table with
// "Subscriptions require indexes on join columns" — including the plain
// `scope = 'space'` one, which mentions no join at all. That failure is
// invisible at publish time (the module uploads fine) and only surfaces as a
// subscription error, so a filter change here needs the non-owner spike
// (2026-08-05, packages/e2e chat-scope.spec.ts is its standing version).
//
// The closed flag is read LIVE off conversation_group rather than
// snapshotted onto the message: flipping a zone or huddle to クローズド
// hides its history immediately, and flipping back reveals it — which is
// what "the group's setting" means to a member who toggles it mid-meeting.
// The consequence, accepted: a deleted group (delete_zone, or a huddle
// losing its last member) leaves its closed rows joinable to nothing, so
// they become invisible to everyone and expire with the global retention
// trim (ROADMAP 増分④ の履歴・orphan の決め打ち).
export const chatSpaceVisibility = spacetimedb.clientVisibilityFilter.sql(
  `SELECT * FROM chat_message WHERE scope = '${CHAT_SCOPE_SPACE}'`,
);

// The map scope is an ATTENTION boundary, not a confidentiality one, and
// this filter deliberately says so: it hides nothing, and what keeps a
// client from holding another map's chatter is its subscription
// (subscribeMapRows). Same reading as everything else map-scoped — `player`
// rows carry no filter either, so any client may already subscribe to
// another map's positions, and the zones, huddles and occupancy rows are
// space-wide public by design. The read-privacy rule in this space is the
// CLOSED conversation group, which the two joins below enforce server-side.
// Binding this filter to the sender's own player.map_id would not fit
// anyway: `target` is a u64 and `player.map_id` a u32, so the join columns
// have different types (a 2026-08-05 assessment of a review finding).
export const chatMapVisibility = spacetimedb.clientVisibilityFilter.sql(
  `SELECT * FROM chat_message WHERE scope = '${CHAT_SCOPE_MAP}'`,
);

// An OPEN group's conversation is visible to the room around it (VISION の
// オープン/クローズド), member or not — the join only has to prove the
// target group is open.
export const chatOpenGroupVisibility = spacetimedb.clientVisibilityFilter.sql(
  `SELECT c.* FROM chat_message c JOIN conversation_group g ON c.target = g.id WHERE c.scope = '${CHAT_SCOPE_GROUP}' AND g.closed = false`,
);

// A CLOSED group's conversation reaches its members only — the one filter
// this increment exists for. group_member.groupId carries the btree index
// 増分② put there for exactly this join (RLS filters are re-evaluated per
// transaction). Membership is live too: the occupancy pass removing a
// member's row revokes the rows from their cache as deletes.
export const chatGroupMemberVisibility = spacetimedb.clientVisibilityFilter.sql(
  `SELECT c.* FROM chat_message c JOIN group_member m ON c.target = m.group_id WHERE c.scope = '${CHAT_SCOPE_GROUP}' AND m.identity = :sender`,
);

// Row-level security for group_call (ROADMAP Phase 4 増分①): a group's
// call row reaches its MEMBERS only — one filter, so it is the allow-list
// entire (a row matching no filter reaches nobody, which here is the
// point: the meeting id is the join capability, see the table comment).
// Members-only even for OPEN groups, deliberately: an open group's chat
// being readable by the room (chatOpenGroupVisibility) does not extend to
// its call being JOINABLE by the room — joining the conversation
// (walking into the zone, join_huddle) is the gate, exactly the
// resolveChatRoute not-a-member rule on the send side. The join follows
// the chatGroupMemberVisibility shape: ON-clause join (a WHERE-equality
// join breaks every subscription on the table — the 増分④ spike), both
// join columns indexed (group_call.group_id is the PK; group_member's
// btree is 増分②'s). Membership is live: joining a group grants the row,
// leaving revokes it as a delete (the 増分④ observation).
export const groupCallVisibility = spacetimedb.clientVisibilityFilter.sql(
  'SELECT c.* FROM group_call c JOIN group_member m ON c.group_id = m.group_id WHERE m.identity = :sender',
);
