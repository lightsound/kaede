import { DbConnection, tables } from '../module_bindings';

const URI = import.meta.env.VITE_SPACETIME_URI ?? 'ws://localhost:3000';
const DB = import.meta.env.VITE_SPACETIME_DB ?? 'maple-like';

export interface Connected {
  conn: DbConnection;
  myIdHex: string;
}

/**
 * Opens an anonymous connection and resolves once the initial player
 * subscription has been applied (so the row cache is populated). Each browser
 * window gets a fresh identity, so we never pass or persist a token.
 */
export function connect(): Promise<Connected> {
  return new Promise((resolve, reject) => {
    DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .onConnect((conn, identity) => {
        const myIdHex = identity.toHexString();
        conn
          .subscriptionBuilder()
          .onApplied(() => resolve({ conn, myIdHex }))
          .subscribe(tables.player);
      })
      .onConnectError((_ctx, err) => reject(err))
      .onDisconnect(() => {})
      .build();
  });
}
