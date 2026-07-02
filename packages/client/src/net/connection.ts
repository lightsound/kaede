import { DbConnection, tables } from '../module_bindings';

// Production builds default to Maincloud so a missing env var can't silently
// point a deployed client at localhost; dev keeps the local server.
const URI =
  import.meta.env.VITE_SPACETIME_URI ??
  (import.meta.env.PROD ? 'wss://maincloud.spacetimedb.com' : 'ws://localhost:3000');
const DB = import.meta.env.VITE_SPACETIME_DB ?? 'maple-like';

// Per-tab identity: sessionStorage survives a reload (so the server resumes
// the same character) while each new window still gets its own identity,
// keeping the two-windows-side-by-side demo working.
const TOKEN_KEY = 'maple.spacetime.token';

export interface Connected {
  conn: DbConnection;
  myIdHex: string;
}

export interface ConnectHandlers {
  /** Fired when an established connection drops (not for initial connect failures). */
  onDisconnect(): void;
}

/**
 * Opens a connection (resuming this tab's identity if we have a token) and
 * resolves once the initial player subscription has been applied, so the row
 * cache is populated.
 */
export function connect(handlers: ConnectHandlers): Promise<Connected> {
  return new Promise((resolve, reject) => {
    const token = sessionStorage.getItem(TOKEN_KEY) ?? undefined;
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
      .onConnectError((_ctx, err) => {
        // The stored token may be the problem (e.g. the server no longer
        // recognizes it). Drop it so the next retry starts anonymous instead
        // of failing forever; a plain network failure just loses the resume.
        if (token) sessionStorage.removeItem(TOKEN_KEY);
        reject(err);
      })
      .onDisconnect(() => handlers.onDisconnect())
      .build();
  });
}
