import { DbConnection, tables } from '../module_bindings';

// Production builds default to Maincloud so a missing env var can't silently
// point a deployed client at localhost; dev keeps the local server.
const URI =
  import.meta.env.VITE_SPACETIME_URI ??
  (import.meta.env.PROD ? 'wss://maincloud.spacetimedb.com' : 'ws://localhost:3000');
const DB = import.meta.env.VITE_SPACETIME_DB ?? 'maple-like';

const TOKEN_KEY = 'maple.token';

// Two windows of the same browser share localStorage, so they'd otherwise
// resume the SAME persisted identity and collide. `?guest` opts out of token
// persistence entirely — a throwaway identity per load — so a second guest
// window can act as a distinct player for local multiplayer testing.
const GUEST = new URLSearchParams(window.location.search).has('guest');

export interface Connected {
  conn: DbConnection;
  myIdHex: string;
}

/**
 * Opens a connection and resolves once the initial player subscription has been
 * applied (so the row cache is populated). The auth token is persisted in
 * localStorage so the same identity — and thus the same player row — resumes
 * across reloads. If a stored token fails to authenticate, it's cleared and we
 * retry once anonymously. Guest mode never reads or writes the stored token.
 */
export function connect(): Promise<Connected> {
  const stored = GUEST ? null : localStorage.getItem(TOKEN_KEY);
  return attempt(stored ?? undefined).catch((err) => {
    // A stored token that no longer authenticates would lock us out forever;
    // drop it and retry anonymously so the user always gets back into the world.
    if (stored) {
      localStorage.removeItem(TOKEN_KEY);
      return attempt(undefined);
    }
    throw err;
  });
}

function attempt(token: string | undefined): Promise<Connected> {
  return new Promise((resolve, reject) => {
    DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .withToken(token)
      .onConnect((conn, identity, freshToken) => {
        // Persist the credentials the server settled on (the same token for an
        // authenticated resume, a newly minted one for an anonymous connect).
        if (!GUEST) localStorage.setItem(TOKEN_KEY, freshToken);
        const myIdHex = identity.toHexString();
        conn
          .subscriptionBuilder()
          .onApplied(() => resolve({ conn, myIdHex }))
          // Subscribe to players, mobs, and the public chat log in one applied
          // batch so every row cache is populated before the connection resolves.
          .subscribe([tables.player, tables.mob, tables.message]);
      })
      .onConnectError((_ctx, err) => reject(err))
      .onDisconnect(() => {})
      .build();
  });
}
