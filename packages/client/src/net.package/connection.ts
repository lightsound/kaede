// fallow-ignore-file coverage-gaps -- opens a SpacetimeDB WebSocket; needs a running host, not a unit test
import type { Identity } from 'spacetimedb';
import { DbConnection, tables } from '../module_bindings';

// Production builds default to Maincloud so a missing env var can't silently
// point a deployed client at localhost; dev keeps the local server.
const URI =
  import.meta.env.VITE_SPACETIME_URI ??
  (import.meta.env.PROD ? 'wss://maincloud.spacetimedb.com' : 'ws://localhost:3000');
const DB = import.meta.env.VITE_SPACETIME_DB ?? 'maple-like';

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
        // The world (player, plus the name labels and statuses split off /
        // beside it), everything admission is decided from (the member
        // directory and the space settings), and the conversation tables
        // (the chat history, the DM history and the current reactions). All
        // must be applied before we resolve, so the first admission decision
        // rules on real rows rather than an empty cache, and the chat log
        // seeds from the full retained history (bounded server-side to
        // CHAT_HISTORY_MAX rows — see the chat_message table). dm_message is
        // subscribed whole like every table here, but its row-level-security
        // filter means the seed and events carry only THIS identity's own
        // conversations (see tables.ts in the server). Reactions are
        // subscribed for their row EVENTS only; the seed never displays
        // (see reactionFeed.ts). Statuses are the opposite: the seed IS the
        // display (a status is state, restored on entry — see sync.ts).
        conn
          .subscriptionBuilder()
          .onApplied(() => resolve({ conn, myIdentity: identity, myIdHex: identity.toHexString() }))
          .subscribe([
            tables.player,
            tables.playerName,
            tables.spaceMember,
            tables.spaceSetting,
            tables.chatMessage,
            tables.dmMessage,
            tables.reaction,
            tables.playerStatus,
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
