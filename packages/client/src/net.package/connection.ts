// fallow-ignore-file coverage-gaps -- opens a SpacetimeDB WebSocket; needs a running host, not a unit test
import { CHAT_SCOPE_GROUP, CHAT_SCOPE_MAP, CHAT_SCOPE_SPACE, DEFAULT_MAP_ID } from '@kaede/shared';
import type { Identity } from 'spacetimedb';
import { DbConnection, type SubscriptionHandle, tables } from '../module_bindings';

// Production builds default to Maincloud so a missing env var can't silently
// point a deployed client at localhost; dev keeps the local server.
const URI =
  import.meta.env.VITE_SPACETIME_URI ??
  (import.meta.env.PROD ? 'wss://maincloud.spacetimedb.com' : 'ws://localhost:3000');
const DB = import.meta.env.VITE_SPACETIME_DB ?? 'kaede';

/**
 * Where this client is pointed. Reported when a connection fails: the two
 * setup mistakes that hang the UI (no host running, database published under
 * another name) are both visible from this one string.
 */
export const target = `${URI}/${DB}`;

// Per-tab identity: sessionStorage survives a reload (so the server resumes
// the same character) while each new window still gets its own identity,
// keeping the two-windows-side-by-side demo working.
const TOKEN_KEY = 'kaede.spacetime.token';

export interface Connected {
  conn: DbConnection;
  /** This connection's identity: the key into own rows and reducer targets. */
  myIdentity: Identity;
  /** Its hex form, pre-computed once: the map key for remote-player views. */
  myIdHex: string;
  /** The map the map-scoped subscription covers: the own row's map, or the default. */
  mapId: number;
  /** The map-scoped subscription (players + chat); the session swaps it on every portal move. */
  mapSub: SubscriptionHandle;
}

/**
 * Subscribes to everything scoped to ONE map: the hot player rows (Phase 3
 * AoI 購読絞り込み) and the map-scoped chat messages (増分④ — the same
 * mechanism, as the AoI entry predicted). This is the query set the session
 * swaps on a portal move: subscribe the destination map, then unsubscribe
 * the origin (subscription overlap is refcounted client-side, so the own
 * row — also covered by the identity query below — never flickers). Both
 * filter columns are indexed server-side, which the ROADMAP AoI rule makes
 * non-negotiable: subscription queries are re-evaluated per transaction.
 *
 * Leaving a map therefore DELETES its chat lines from the cache, and the
 * panel drops them (the retention-trim path) — an accepted consequence,
 * fixed by the E2E spec: a client-side buffer that kept them would be
 * pretending to hold rows the space no longer hands it.
 *
 * The chat query is raw SQL, not the typed builder: `target` is a u64, and
 * the builder's filter values are `string | number | boolean` only.
 */
export function subscribeMapRows(
  conn: DbConnection,
  mapId: number,
  onApplied: () => void,
): SubscriptionHandle {
  return conn
    .subscriptionBuilder()
    .onApplied(onApplied)
    .subscribe([
      tables.player.where((p) => p.mapId.eq(mapId)),
      `SELECT * FROM chat_message WHERE scope = '${CHAT_SCOPE_MAP}' AND target = ${mapId}`,
    ]);
}

/**
 * Consecutive failed connects after which we stop offering the stored token.
 * A token the server no longer accepts would fail forever if we kept resending
 * it, but a host that is merely down must not cost us our character: one
 * failure is no evidence against the token, a sustained run of them is.
 */
const RESUME_MAX_FAILURES = 5;

export interface ConnectHandlers {
  /**
   * Fired whenever the socket closes, which includes a failed handshake — the
   * SDK does not distinguish the two, so this runs alongside the rejection on
   * an initial connect failure rather than only after an established drop.
   */
  onDisconnect(): void;
}

/**
 * Produces the OIDC JWT to authenticate with, or undefined for the guest
 * (anonymous) path. Called anew on every connect attempt because provider
 * session tokens are short-lived: a token fetched once and reused would be
 * expired by the time a reconnect needs it.
 */
export type AuthTokenGetter = () => Promise<string | undefined>;

/**
 * Opens a connection and resolves once the initial player subscription has
 * been applied, so the row cache is populated.
 *
 * Signed-in users authenticate with a fresh OIDC JWT from `getAuthToken`;
 * their identity is derived server-side from the token's issuer+subject, so
 * it is stable across tabs, devices, and reconnects. Without one we fall back
 * to the per-tab anonymous identity (a server-issued token in sessionStorage).
 *
 * `consecutiveFailures` is how many connects have failed in a row since this
 * client last succeeded; past RESUME_MAX_FAILURES the stored anonymous token
 * is treated as the suspect and the next attempt goes out fresh.
 */
export async function connect(
  handlers: ConnectHandlers,
  consecutiveFailures: number,
  getAuthToken: AuthTokenGetter,
): Promise<Connected> {
  const authToken = await getAuthToken();
  return new Promise((resolve, reject) => {
    const resume = consecutiveFailures < RESUME_MAX_FAILURES;
    const token =
      authToken ?? (resume ? (sessionStorage.getItem(TOKEN_KEY) ?? undefined) : undefined);
    DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .withToken(token)
      .onConnect((conn, identity, freshToken) => {
        // Persist only anonymous (server-issued) tokens. An OIDC session must
        // be re-minted per connect, and overwriting the anonymous token with
        // it would strand the guest identity after sign-out.
        if (!authToken) sessionStorage.setItem(TOKEN_KEY, freshToken);
        // Everything space-wide, applied before we resolve so the first
        // admission decision rules on real rows rather than an empty cache:
        // the OWN player row (subscribed by identity so it stays visible
        // whatever map it is on — acks and the map-change signal ride it),
        // the presence directory (player_name, now carrying `online` — the
        // DM mention candidates read it), everything admission is decided
        // from (the member directory and the space settings), and the
        // conversation tables (the space-wide and group chat history, the
        // DM history and the current reactions).
        //
        // The chat history arrives as two scope-filtered queries rather
        // than the whole table (増分④): the 'map' rows ride the map-scoped
        // subscription below, so a client holds only the maps' chatter it
        // can see. 'group' rows are subscribed whole and narrowed by
        // row-level security instead — which groups a client may read is a
        // membership question no subscription WHERE could ask (see
        // tables.ts in the server), exactly as dm_message's filter already
        // narrows the DM history subscribed here. Reactions are subscribed for their row
        // EVENTS only; the seed never displays (see reactionFeed.ts).
        // Statuses are the opposite: the seed IS the display (a status is
        // state, restored on entry — see sync.ts). The conversation groups
        // and their occupancy (Phase 3 増分②) are whole-table too: both are
        // low-frequency, small and space-wide (the admin panel lists every
        // map's zones; a member's 📍 tag shows whatever map you watch from)
        // — the ROADMAP AoI reasoning for why only the hot player rows are
        // map-scoped.
        //
        // The OTHER players' hot rows are deliberately NOT here: they are
        // map-scoped (subscribeMapRows — the Phase 3 AoI 絞り込み), and
        // which map to scope to is only knowable once the own row has
        // seeded, hence the second, dependent subscribe below. A fresh
        // identity has no row and starts on the default map.
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            const mapId = conn.db.player.identity.find(identity)?.mapId ?? DEFAULT_MAP_ID;
            const mapSub = subscribeMapRows(conn, mapId, () =>
              resolve({
                conn,
                myIdentity: identity,
                myIdHex: identity.toHexString(),
                mapId,
                mapSub,
              }),
            );
          })
          .subscribe([
            tables.player.where((p) => p.identity.eq(identity)),
            tables.playerName,
            tables.spaceMember,
            tables.spaceSetting,
            tables.chatMessage.where((c) => c.scope.eq(CHAT_SCOPE_SPACE)),
            tables.chatMessage.where((c) => c.scope.eq(CHAT_SCOPE_GROUP)),
            tables.dmMessage,
            tables.reaction,
            tables.playerStatus,
            tables.conversationGroup,
            tables.groupMember,
          ]);
      })
      // Keep the token: a host that is down rejects every attempt, and dropping
      // the identity here used to spawn a fresh character (and strand the old
      // row) on every blip. RESUME_MAX_FAILURES handles a genuinely bad token.
      .onConnectError((_ctx, err) => reject(err))
      .onDisconnect(() => {
        // A clean close emits no connectError, so a socket that closes after
        // the handshake but before the subscription applies (a module
        // republish kicking clients, a host restart) would otherwise leave
        // this promise pending forever — and with it the caller's
        // single-flight slot occupied, deadlocking the reconnect loop. The
        // reject is a no-op once the promise has resolved (a drop after a
        // successful connect).
        reject(new Error('connection closed before the initial subscription applied'));
        handlers.onDisconnect();
      })
      .build();
  });
}
