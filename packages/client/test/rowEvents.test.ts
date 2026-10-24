import { Identity } from 'spacetimedb';
import { describe, expect, it } from 'vitest';
import { type RowEvents, sessionRows } from '../src/net.package/rowEvents';

const ME = new Identity(1n);
const OTHER = new Identity(2n);

interface Row {
  id: number;
}

/** A table handle that keeps its handlers, so a test can fire its row events. */
function fakeTable() {
  const inserts: ((ctx: unknown, row: Row) => void)[] = [];
  const updates: ((ctx: unknown, oldRow: Row, newRow: Row) => void)[] = [];
  const deletes: ((ctx: unknown, row: Row) => void)[] = [];
  const table: RowEvents<Row> = {
    onInsert: (handler) => inserts.push(handler),
    onUpdate: (handler) => updates.push(handler),
    onDelete: (handler) => deletes.push(handler),
  };
  return {
    table,
    registered: () => [inserts.length, updates.length, deletes.length],
    insert: (row: Row) => {
      for (const handler of inserts) handler(undefined, row);
    },
    update: (oldRow: Row, newRow: Row) => {
      for (const handler of updates) handler(undefined, oldRow, newRow);
    },
    delete: (row: Row) => {
      for (const handler of deletes) handler(undefined, row);
    },
  };
}

/** A session whose staleness the test flips. */
function session() {
  const state = { stale: false };
  return { state, rows: sessionRows(ME.toHexString(), () => state.stale) };
}

describe('SessionRows.on', () => {
  it('hands each event kind its row, the new one for an update', () => {
    const { rows } = session();
    const table = fakeTable();
    const seen: string[] = [];
    rows.on(table.table, {
      insert: (row) => seen.push(`insert ${row.id}`),
      update: (row) => seen.push(`update ${row.id}`),
      delete: (row) => seen.push(`delete ${row.id}`),
    });
    table.insert({ id: 1 });
    table.update({ id: 1 }, { id: 2 });
    table.delete({ id: 2 });
    expect(seen).toEqual(['insert 1', 'update 2', 'delete 2']);
  });

  it('registers only the kinds it is given', () => {
    const { rows } = session();
    const inserts = fakeTable();
    const updates = fakeTable();
    rows.on(inserts.table, { insert: () => {} });
    rows.on(updates.table, { update: () => {} });
    expect([inserts.registered(), updates.registered()]).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
  });

  it('runs no handler once the session is stale', () => {
    const { state, rows } = session();
    const table = fakeTable();
    const seen: number[] = [];
    rows.on(table.table, {
      insert: (row) => seen.push(row.id),
      update: (row) => seen.push(row.id),
      delete: (row) => seen.push(row.id),
    });
    table.insert({ id: 1 });
    state.stale = true;
    table.insert({ id: 2 });
    table.update({ id: 2 }, { id: 3 });
    table.delete({ id: 3 });
    expect(seen).toEqual([1]);
  });
});

describe('SessionRows.onAny', () => {
  it('runs one handler on every event kind until the session goes stale', () => {
    const { state, rows } = session();
    const table = fakeTable();
    let runs = 0;
    rows.onAny(table.table, () => {
      runs += 1;
    });
    table.insert({ id: 1 });
    table.update({ id: 1 }, { id: 1 });
    table.delete({ id: 1 });
    state.stale = true;
    table.insert({ id: 2 });
    expect(runs).toBe(3);
  });
});

describe('SessionRows.live', () => {
  it('runs the callback only while the session is live', () => {
    const { state, rows } = session();
    let runs = 0;
    const callback = rows.live(() => {
      runs += 1;
    });
    callback();
    state.stale = true;
    callback();
    expect(runs).toBe(1);
  });
});

describe('SessionRows ownership', () => {
  it('tells this client’s identity from everyone else’s', () => {
    const { rows } = session();
    expect(rows.isOwn(ME)).toBe(true);
    expect(rows.isOwn(OTHER)).toBe(false);
  });

  it('routes the own row to own and a remote row to remote with its hex', () => {
    const { rows } = session();
    const seen: string[] = [];
    const route = (identity: Identity) =>
      rows.route(
        identity,
        () => seen.push('own'),
        (idHex) => seen.push(`remote ${idHex}`),
      );
    route(ME);
    route(OTHER);
    expect(seen).toEqual(['own', `remote ${OTHER.toHexString()}`]);
  });
});
