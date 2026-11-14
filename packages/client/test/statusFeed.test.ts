import { DEFAULT_STATUS, type StatusView } from '@kaede/shared';
import { Identity } from 'spacetimedb';
import { describe, expect, it } from 'vite-plus/test';
import { sessionRows } from '../src/net.package/rowEvents';
import { cachedStatusView, wireStatuses } from '../src/net.package/statusFeed';
import type { RowOf } from '../src/net.package/rows';
type PlayerStatus = RowOf<'playerStatus'>;
import { fakeConnection, fakeTable } from './fakeDb';

const ME = new Identity(1n);
const OTHER = new Identity(2n);

const statusRow = (identity: Identity, availability: string, text: string): PlayerStatus => ({
  identity,
  availability,
  text,
});

function harness() {
  const playerStatus = fakeTable<PlayerStatus>({ identity: (row) => row.identity });
  const conn = fakeConnection({ playerStatus });
  const rows = sessionRows(ME.toHexString(), () => false);
  const applied: string[] = [];
  const hooks = {
    applyOwn: (view: StatusView) => applied.push(`own ${view.availability}:${view.text}`),
    applyRemote: (idHex: string, view: StatusView) =>
      applied.push(`remote ${idHex} ${view.availability}:${view.text}`),
  };
  return { playerStatus, conn, rows, hooks, applied };
}

describe('cachedStatusView', () => {
  it('reads the default while the cache holds no row', () => {
    const { conn } = harness();
    expect(cachedStatusView(conn, ME)).toEqual(DEFAULT_STATUS);
  });

  it('reads the cached row, narrowed at the boundary', () => {
    const { playerStatus, conn } = harness();
    playerStatus.seed([statusRow(OTHER, 'busy', '集中')]);
    expect(cachedStatusView(conn, OTHER)).toEqual({ availability: 'busy', text: '集中' });
    playerStatus.seed([statusRow(ME, 'unvetted', 'x')]);
    expect(cachedStatusView(conn, ME)).toEqual(DEFAULT_STATUS);
  });
});

describe('wireStatuses', () => {
  it('routes inserts and updates to own or remote by identity', () => {
    const { playerStatus, conn, rows, hooks, applied } = harness();
    wireStatuses(conn, rows, hooks);
    playerStatus.insert(statusRow(ME, 'away', ''));
    playerStatus.insert(statusRow(OTHER, 'busy', '会議中'));
    playerStatus.update(statusRow(OTHER, 'online', ''));
    expect(applied).toEqual([
      'own away:',
      `remote ${OTHER.toHexString()} busy:会議中`,
      `remote ${OTHER.toHexString()} online:`,
    ]);
  });

  it('applies the default on delete, while the owner stays rendered', () => {
    const { playerStatus, conn, rows, hooks, applied } = harness();
    wireStatuses(conn, rows, hooks);
    playerStatus.insert(statusRow(ME, 'busy', '集中'));
    playerStatus.remove(statusRow(ME, 'busy', '集中'));
    expect(applied).toEqual(['own busy:集中', 'own online:']);
  });
});
