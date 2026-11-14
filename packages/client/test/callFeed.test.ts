import { Identity } from 'spacetimedb';
import { describe, expect, it } from 'vite-plus/test';
import { wireOwnGroup } from '../src/net.package/callFeed';
import { sessionRows } from '../src/net.package/rowEvents';
import type { RowOf } from '../src/net.package/rows';
type GroupMember = RowOf<'groupMember'>;
import { fakeConnection, fakeTable } from './fakeDb';

const ME = new Identity(1n);
const OTHER = new Identity(2n);

const memberRow = (identity: Identity, groupId: bigint): GroupMember => ({ identity, groupId });

function harness() {
  const groupMember = fakeTable<GroupMember>({ identity: (row) => row.identity });
  const conn = fakeConnection({ groupMember });
  const rows = sessionRows(ME.toHexString(), () => false);
  const published: (bigint | undefined)[] = [];
  const hooks = { onOwnGroup: (groupId: bigint | undefined) => published.push(groupId) };
  return { groupMember, conn, rows, hooks, published };
}

describe('wireOwnGroup', () => {
  it('publishes the seeded own group at wiring time, undefined in none', () => {
    const { groupMember, conn, rows, hooks, published } = harness();
    groupMember.seed([memberRow(ME, 7n), memberRow(OTHER, 9n)]);
    wireOwnGroup(conn, rows, ME, hooks);
    expect(published).toEqual([7n]);
  });

  it('follows the own row only: joins, moves and leaves, deduplicated', () => {
    const { groupMember, conn, rows, hooks, published } = harness();
    wireOwnGroup(conn, rows, ME, hooks);
    groupMember.insert(memberRow(OTHER, 3n)); // someone else's row: no publish
    groupMember.insert(memberRow(ME, 3n));
    groupMember.update(memberRow(ME, 3n)); // same group again: deduplicated
    groupMember.update(memberRow(ME, 4n));
    groupMember.remove(memberRow(ME, 4n));
    expect(published).toEqual([undefined, 3n, 4n, undefined]);
  });
});
