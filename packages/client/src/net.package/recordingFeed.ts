// fallow-ignore-file coverage-gaps -- wires live SpacetimeDB row events into a React-facing list; the catalog rules live in @kaede/shared / packages/server

import type { DbConnection } from '../module_bindings';

/** One call_recording row as the recordings panel wants it. */
export interface CallRecordingView {
  recordingId: string;
  meetingId: string;
  groupId: bigint;
  status: string;
  objectKey: string;
  outputFileName: string;
  startedAtMs: bigint;
  durationSecs: number;
}

/** Newest-first list from the subscribed cache (RLS already narrowed it). */
export function callRecordingsOf(c: DbConnection): CallRecordingView[] {
  const rows = [...c.db.callRecording.iter()].map((row) => ({
    recordingId: row.recordingId,
    meetingId: row.meetingId,
    groupId: row.groupId,
    status: row.status,
    objectKey: row.objectKey,
    outputFileName: row.outputFileName,
    startedAtMs: row.startedAtMs,
    durationSecs: row.durationSecs,
  }));
  rows.sort((a, b) => {
    if (a.startedAtMs === b.startedAtMs) {
      return a.recordingId < b.recordingId ? 1 : a.recordingId > b.recordingId ? -1 : 0;
    }
    return a.startedAtMs < b.startedAtMs ? 1 : -1;
  });
  return rows;
}

/**
 * Publishes the whole recording catalog on every seed/insert/update/delete.
 * Guests receive an empty subscription (RLS), so they see [].
 */
export function wireCallRecordings(
  c: DbConnection,
  hooks: {
    isStale(): boolean;
    onCallRecordings(rows: CallRecordingView[]): void;
  },
): void {
  const publish = () => {
    if (hooks.isStale()) return;
    hooks.onCallRecordings(callRecordingsOf(c));
  };
  publish();
  c.db.callRecording.onInsert(publish);
  c.db.callRecording.onUpdate((_old, _row) => publish());
  c.db.callRecording.onDelete(publish);
}
