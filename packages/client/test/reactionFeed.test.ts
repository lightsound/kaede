import type { ReactionEmoji } from '@kaede/shared';
import { Identity } from 'spacetimedb';
import { describe, expect, it } from 'vite-plus/test';
import { wireReactions } from '../src/net.package/reactionFeed';
import { sessionRows } from '../src/net.package/rowEvents';
import type { RowOf } from '../src/net.package/rows';
type Reaction = RowOf<'reaction'>;
import { at, fakeConnection, fakeTable } from './fakeDb';

const ME = new Identity(1n);
const OTHER = new Identity(2n);

const reactionRow = (identity: Identity, emoji: string): Reaction => ({
  identity,
  emoji,
  sentAt: at(1000),
});

function harness() {
  const reaction = fakeTable<Reaction>({ identity: (row) => row.identity });
  const conn = fakeConnection({ reaction });
  const rows = sessionRows(ME.toHexString(), () => false);
  const shown: string[] = [];
  const hooks = {
    showLocalReaction: (emoji: ReactionEmoji) => shown.push(`local ${emoji}`),
    showRemoteReaction: (idHex: string, emoji: ReactionEmoji) =>
      shown.push(`remote ${idHex} ${emoji}`),
  };
  return { reaction, conn, rows, hooks, shown };
}

describe('wireReactions', () => {
  it('shows inserts and updates, routed to own or remote by identity', () => {
    const { reaction, conn, rows, hooks, shown } = harness();
    wireReactions(conn, rows, hooks);
    reaction.insert(reactionRow(ME, '👍'));
    reaction.insert(reactionRow(OTHER, '😮'));
    reaction.update(reactionRow(OTHER, '🎉'));
    expect(shown).toEqual([
      'local 👍',
      `remote ${OTHER.toHexString()} 😮`,
      `remote ${OTHER.toHexString()} 🎉`,
    ]);
  });

  it('never shows the seed: a cached row alone displays nothing', () => {
    const { reaction, conn, rows, hooks, shown } = harness();
    reaction.seed([reactionRow(ME, '❤️')]);
    wireReactions(conn, rows, hooks);
    expect(shown).toEqual([]);
  });

  it('renders nothing for an emoji outside the palette', () => {
    const { reaction, conn, rows, hooks, shown } = harness();
    wireReactions(conn, rows, hooks);
    reaction.insert(reactionRow(OTHER, '🦊'));
    expect(shown).toEqual([]);
  });

  it('wires no delete: a removed row changes nothing on screen', () => {
    const { reaction, conn, rows, hooks, shown } = harness();
    wireReactions(conn, rows, hooks);
    reaction.insert(reactionRow(ME, '😂'));
    reaction.remove(reactionRow(ME, '😂'));
    expect(shown).toEqual(['local 😂']);
  });
});
