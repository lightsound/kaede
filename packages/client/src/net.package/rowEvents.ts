import type { Identity } from 'spacetimedb';

/**
 * A generated table handle's row events, typed by its row. Every table this
 * client subscribes to has a primary key, so every handle has update events
 * too.
 */
export interface RowEvents<Row> {
  onInsert(handler: (ctx: unknown, row: Row) => void): unknown;
  onUpdate(handler: (ctx: unknown, oldRow: Row, newRow: Row) => void): unknown;
  onDelete(handler: (ctx: unknown, row: Row) => void): unknown;
}

/**
 * What a feed does on one table's row events. Each kind is optional; an
 * update hands over the new row (no feed reads the old one).
 */
export interface RowHandlers<Row> {
  insert?: (row: Row) => void;
  update?: (row: Row) => void;
  delete?: (row: Row) => void;
}

/**
 * One session's row events. wireSession builds one per connection and every
 * feed registers through it, so two rules live here once instead of in each
 * handler:
 *
 * - Staleness: no handler runs once the session is stale. The socket closes
 *   asynchronously, so a disposed or replaced session's row events can
 *   still be delivered (an idle resume can start a new session while the
 *   old socket is closing), and acting on one would drive a destroyed scene
 *   or write to consumers the replacement session now owns. A feed's
 *   synchronous seeding needs no guard: wireSession runs in one go, and
 *   neither dispose() nor a newer connect can interleave with it.
 * - Ownership: a row is either this client's own (the local avatar and the
 *   own-name / own-status consumers) or a remote player's, keyed by
 *   identity hex like the remote views.
 */
export interface SessionRows {
  /** Registers `handlers` on `table`'s row events; none runs once stale. */
  on<Row>(table: RowEvents<Row>, handlers: RowHandlers<Row>): void;
  /**
   * Registers one argument-less handler on every row event of `table` — for
   * feeds that re-project a whole view from the cache on any change rather
   * than acting on the individual row.
   */
  onAny(table: RowEvents<unknown>, handler: () => void): void;
  /**
   * Wraps a callback that is not a row event (a subscription's onApplied)
   * so it, too, does nothing once the session is stale.
   */
  live(callback: () => void): () => void;
  /** Whether `identity` is this client's own. */
  isOwn(identity: Identity): boolean;
  /** Calls `own` for this client's identity, else `remote` with the identity's hex. */
  route(identity: Identity, own: () => void, remote: (idHex: string) => void): void;
}

/**
 * Builds one session's row events for the client whose identity hex is
 * `myIdHex`. `isStale` turns true once this session's events must be
 * ignored, and stays true.
 */
export function sessionRows(myIdHex: string, isStale: () => boolean): SessionRows {
  const on = <Row>(table: RowEvents<Row>, handlers: RowHandlers<Row>): void => {
    const { insert, update, delete: remove } = handlers;
    if (insert) {
      table.onInsert((_ctx, row) => {
        if (!isStale()) insert(row);
      });
    }
    if (update) {
      table.onUpdate((_ctx, _old, row) => {
        if (!isStale()) update(row);
      });
    }
    if (remove) {
      table.onDelete((_ctx, row) => {
        if (!isStale()) remove(row);
      });
    }
  };
  return {
    on,
    onAny: (table, handler) => on(table, { insert: handler, update: handler, delete: handler }),
    live: (callback) => () => {
      if (!isStale()) callback();
    },
    isOwn: (identity) => identity.toHexString() === myIdHex,
    route(identity, own, remote) {
      const idHex = identity.toHexString();
      if (idHex === myIdHex) own();
      else remote(idHex);
    },
  };
}
