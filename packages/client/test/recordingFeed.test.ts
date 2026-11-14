import { describe, expect, it } from 'vite-plus/test';
import { type RecordingLabelView, wireRecordings } from '../src/net.package/recordingFeed';
import { sessionRows } from '../src/net.package/rowEvents';
import type { RowOf } from '../src/net.package/rows';
type CallRecording = RowOf<'callRecording'>;
import { at, fakeConnection, fakeTable } from './fakeDb';

const recordingRow = (
  id: bigint,
  startedAtMs: number,
  fileName = `rec-${id}.webm`,
): CallRecording => ({
  id,
  fileName,
  groupName: '会議室',
  starterName: 'たろう',
  startedAt: at(startedAtMs),
});

function harness() {
  const callRecording = fakeTable<CallRecording>({ id: (row) => row.id });
  const conn = fakeConnection({ callRecording });
  const rows = sessionRows('me', () => false);
  const published: RecordingLabelView[][] = [];
  const hooks = { onRecordings: (labels: RecordingLabelView[]) => published.push(labels) };
  return { callRecording, conn, rows, hooks, published };
}

describe('wireRecordings', () => {
  it('publishes the seed at wiring time, newest first, keyed by stringified id', () => {
    const { callRecording, conn, rows, hooks, published } = harness();
    callRecording.seed([recordingRow(1n, 1000), recordingRow(2n, 3000), recordingRow(3n, 2000)]);
    wireRecordings(conn, rows, hooks);
    expect(published).toHaveLength(1);
    expect(published[0].map((label) => label.key)).toEqual(['2', '3', '1']);
    expect(published[0][0]).toEqual({
      key: '2',
      fileName: 'rec-2.webm',
      groupName: '会議室',
      starterName: 'たろう',
      startedAtMs: 3000,
    });
  });

  it('republishes whole on insert and delete; an update is not wired', () => {
    const { callRecording, conn, rows, hooks, published } = harness();
    wireRecordings(conn, rows, hooks);
    expect(published).toEqual([[]]);
    callRecording.insert(recordingRow(1n, 1000));
    callRecording.update(recordingRow(1n, 1000, 'renamed.webm'));
    callRecording.remove(recordingRow(1n, 1000));
    expect(published.map((labels) => labels.map((label) => label.fileName))).toEqual([
      [],
      ['rec-1.webm'],
      [],
    ]);
  });
});
