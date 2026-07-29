// fallow-ignore-file coverage-gaps -- opens a SpacetimeDB WebSocket; needs a running host, not a unit test
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
const TOKEN_KEY = 'maple.spacetime.token';

export interface Connected {
  conn: DbConnection;
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
 * Opens a connection (resuming this tab's identity if we have a token) and
 * resolves once the initial player subscription has been applied, so the row
 * cache is populated.
 *
 * `consecutiveFailures` is how many connects have failed in a row since this
 * client last succeeded; past RESUME_MAX_FAILURES the stored token is treated
 * as the suspect and the next attempt goes out anonymous.
 */
export function connect(
  handlers: ConnectHandlers,
  consecutiveFailures: number,
): Promise<Connected> {
  return new Promise((resolve, reject) => {
    const resume = consecutiveFailures < RESUME_MAX_FAILURES;
    const token = resume ? (sessionStorage.getItem(TOKEN_KEY) ?? undefined) : undefined;
    DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .withToken(token)
      .onConnect((conn, identity, freshToken) => {
        sessionStorage.setItem(TOKEN_KEY, freshToken);
        const myIdHex = identity.toHexString();
        conn
          .subscriptionBuilder()
          .onApplied(() => resolve({ conn, myIdHex }))
          .subscribe(tables.player);
      })
      // Keep the token: a host that is down rejects every attempt, and dropping
      // the identity here used to spawn a fresh character (and strand the old
      // row) on every blip. RESUME_MAX_FAILURES handles a genuinely bad token.
      .onConnectError((_ctx, err) => reject(err))
      .onDisconnect(() => handlers.onDisconnect())
      .build();
  });
}
