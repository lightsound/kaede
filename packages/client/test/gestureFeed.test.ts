import { Identity } from 'spacetimedb';
import { describe, expect, it } from 'vite-plus/test';
import { cachedStateGesture, wireGestures } from '../src/net.package/gestureFeed';
import { sessionRows } from '../src/net.package/rowEvents';
import type { RowOf } from '../src/net.package/rows';
type Gesture = RowOf<'gesture'>;
import { at, fakeConnection, fakeTable } from './fakeDb';

const ME = new Identity(1n);
const OTHER = new Identity(2n);

const gestureRow = (identity: Identity, gesture: string, sentAtMs = 1000): Gesture => ({
  identity,
  gesture,
  sentAt: at(sentAtMs),
});

function harness() {
  const gesture = fakeTable<Gesture>({ identity: (row) => row.identity });
  const conn = fakeConnection({ gesture });
  const rows = sessionRows(ME.toHexString(), () => false);
  const applied: string[] = [];
  const hooks = {
    applyOwn: (g: string | undefined) => applied.push(`own state ${g ?? 'none'}`),
    applyRemote: (idHex: string, g: string | undefined) =>
      applied.push(`remote ${idHex} state ${g ?? 'none'}`),
    waveOwn: () => applied.push('own wave'),
    waveRemote: (idHex: string) => applied.push(`remote ${idHex} wave`),
  };
  return { gesture, conn, rows, hooks, applied };
}

describe('cachedStateGesture', () => {
  it('restores a state gesture from the seed', () => {
    const { gesture, conn } = harness();
    gesture.seed([gestureRow(ME, 'sit')]);
    expect(cachedStateGesture(conn, ME)).toBe('sit');
  });

  it('never restores the transient wave, an unknown kind, or a missing row', () => {
    const { gesture, conn } = harness();
    gesture.seed([gestureRow(ME, 'wave'), gestureRow(OTHER, 'spin')]);
    expect(cachedStateGesture(conn, ME)).toBeUndefined();
    expect(cachedStateGesture(conn, OTHER)).toBeUndefined();
    expect(cachedStateGesture(conn, new Identity(3n))).toBeUndefined();
  });
});

describe('wireGestures', () => {
  it('applies state gestures from inserts and updates, routed by identity', () => {
    const { gesture, conn, rows, hooks, applied } = harness();
    wireGestures(conn, rows, hooks);
    gesture.insert(gestureRow(ME, 'sleep'));
    gesture.insert(gestureRow(OTHER, 'sit'));
    gesture.update(gestureRow(OTHER, 'dance'));
    expect(applied).toEqual([
      'own state sleep',
      `remote ${OTHER.toHexString()} state sit`,
      `remote ${OTHER.toHexString()} state dance`,
    ]);
  });

  it('plays a wave as a transient and clears the state directive alongside', () => {
    const { gesture, conn, rows, hooks, applied } = harness();
    wireGestures(conn, rows, hooks);
    gesture.insert(gestureRow(OTHER, 'wave'));
    expect(applied).toEqual([
      `remote ${OTHER.toHexString()} state none`,
      `remote ${OTHER.toHexString()} wave`,
    ]);
  });

  it('replays a repeated wave: the update carries a fresh sentAt and fires again', () => {
    const { gesture, conn, rows, hooks, applied } = harness();
    wireGestures(conn, rows, hooks);
    gesture.insert(gestureRow(ME, 'wave', 1000));
    gesture.update(gestureRow(ME, 'wave', 2000));
    expect(applied).toEqual(['own state none', 'own wave', 'own state none', 'own wave']);
  });

  it('ignores a kind outside the vocabulary entirely', () => {
    const { gesture, conn, rows, hooks, applied } = harness();
    wireGestures(conn, rows, hooks);
    gesture.insert(gestureRow(ME, 'spin'));
    expect(applied).toEqual([]);
  });

  it('clears the pose on delete', () => {
    const { gesture, conn, rows, hooks, applied } = harness();
    wireGestures(conn, rows, hooks);
    gesture.insert(gestureRow(ME, 'sit'));
    gesture.remove(gestureRow(ME, 'sit'));
    expect(applied).toEqual(['own state sit', 'own state none']);
  });
});
