import { Timestamp } from 'spacetimedb';
import type { DbConnection } from '../src/module_bindings';
import type { RowEvents } from '../src/net.package/rowEvents';

/**
 * Test doubles for the generated SpacetimeDB surface the net feeds read:
 * a table handle that is at once the row cache (`iter`, the index
 * finders) and the row-event source (the RowEvents registrations), plus
 * the connection that carries the tables. The feeds were written against
 * exactly this seam (they take the connection, a SessionRows and hooks),
 * so a feed's wiring — what it seeds, what it projects on each event
 * kind, what it deduplicates — can be pinned without a running host.
 *
 * The one SDK guarantee the feeds lean on is reproduced faithfully: a
 * mutation lands in the cache BEFORE its event fires (the SDK applies a
 * whole transaction to the cache before invoking any callback), so a
 * handler that re-reads the cache mid-event sees the new state. The
 * `seed` control fills the cache without firing, as a subscription's
 * initial snapshot does.
 */

/** The index extractors a fake table can answer `find` through. */
export interface FakeTableIndexes<Row> {
  identity?: (row: Row) => { toHexString(): string };
  id?: (row: Row) => bigint | number;
}

export interface FakeTable<Row> extends RowEvents<Row> {
  iter(): Iterable<Row>;
  /** The `.identity.find(...)` index accessor, when an extractor was given. */
  identity: { find(key: { toHexString(): string }): Row | null };
  /** The `.id.find(...)` index accessor, when an extractor was given. */
  id: { find(key: bigint | number): Row | null };
  /** Fills the cache without firing events (a subscription's seed). */
  seed(rows: readonly Row[]): void;
  /** Applies a row to the cache, then fires the insert handlers. */
  insert(row: Row): void;
  /** Replaces a row in the cache, then fires the update handlers. Throws for a row the cache does not hold — the SDK fires no update for one. */
  update(row: Row): void;
  /** Removes a row from the cache, then fires the delete handlers. Throws for a row the cache does not hold, like update. */
  remove(row: Row): void;
}

/**
 * Builds one fake table. Rows are keyed by the identity extractor when
 * given, else the id extractor — every table the feeds read has one of
 * the two as its primary key, which is what `update`/`remove` match on.
 */
export function fakeTable<Row>(indexes: FakeTableIndexes<Row>): FakeTable<Row> {
  const keyOf = (row: Row): string => {
    if (indexes.identity) return `identity:${indexes.identity(row).toHexString()}`;
    if (indexes.id) return `id:${String(indexes.id(row))}`;
    throw new Error('fakeTable needs an identity or id extractor to key its rows');
  };
  const store = new Map<string, Row>();
  const inserts: ((ctx: unknown, row: Row) => void)[] = [];
  const updates: ((ctx: unknown, oldRow: Row, newRow: Row) => void)[] = [];
  const deletes: ((ctx: unknown, row: Row) => void)[] = [];

  const findBy = (matches: (row: Row) => boolean): Row | null => {
    for (const row of store.values()) if (matches(row)) return row;
    return null;
  };

  return {
    iter: () => store.values(),
    identity: {
      // No extractor configured is a harness bug, not an absent row: a
      // silent null here would let a missing-row test pass against a
      // table that never had the index the feed reads (the update/remove
      // fail-loud rule).
      find: (key) => {
        if (!indexes.identity) throw new Error('fakeTable: no identity extractor configured');
        return findBy((row) => indexes.identity!(row).toHexString() === key.toHexString());
      },
    },
    id: {
      find: (key) => {
        if (!indexes.id) throw new Error('fakeTable: no id extractor configured');
        return findBy((row) => indexes.id!(row) === key);
      },
    },
    onInsert: (handler) => {
      inserts.push(handler);
    },
    onUpdate: (handler) => {
      updates.push(handler);
    },
    onDelete: (handler) => {
      deletes.push(handler);
    },
    seed: (rows) => {
      for (const row of rows) store.set(keyOf(row), row);
    },
    insert: (row) => {
      store.set(keyOf(row), row);
      for (const handler of inserts) handler(undefined, row);
    },
    update: (row) => {
      // An update event implies the row already lives in the cache (the
      // SDK fires it for a committed change to a subscribed row); a test
      // updating a row it never seeded or inserted is modelling an event
      // the real handle cannot produce, so refuse rather than invent it.
      const old = store.get(keyOf(row));
      if (old === undefined) {
        throw new Error('fakeTable.update: row is not in the cache (seed or insert it first)');
      }
      store.set(keyOf(row), row);
      for (const handler of updates) handler(undefined, old, row);
    },
    remove: (row) => {
      // Same fidelity rule as update: a delete event implies the row was
      // cached, so removing an absent row models an impossible event.
      if (!store.delete(keyOf(row))) {
        throw new Error('fakeTable.remove: row is not in the cache (seed or insert it first)');
      }
      for (const handler of deletes) handler(undefined, row);
    },
  };
}

/**
 * Wraps a record of fake tables (plus any extra surface a feed touches,
 * like `reducers`) as the generated DbConnection type the feeds take.
 * The cast is the test seam's one unsafe step: the fake implements only
 * the members the feed under test actually reads, each pinned by that
 * feed's own tests.
 */
export function fakeConnection(db: Record<string, unknown>): DbConnection {
  return { db } as unknown as DbConnection;
}

/** A Timestamp `millis` after the epoch, for row factories. */
export function at(millis: number): Timestamp {
  return new Timestamp(BigInt(millis) * 1000n);
}
