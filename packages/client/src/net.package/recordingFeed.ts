import type { DbConnection } from '../module_bindings';
import type { SessionRows } from './rowEvents';

/**
 * One call_recording row as the 録画一覧 renders it (ROADMAP Phase 4
 * 増分④): the human labels for one recording. The R2 object itself — and
 * whether it is downloadable yet — is the module's R2 listing
 * (list_recordings; call.package fetches it when the panel opens); this
 * view only decorates that listing, joined on `fileName`. `key` is the
 * stringified row id (bigint is no React key).
 */
export interface RecordingLabelView {
  key: string;
  fileName: string;
  groupName: string;
  starterName: string;
  startedAtMs: number;
}

export interface RecordingFeedHooks {
  onRecordings(labels: RecordingLabelView[]): void;
}

/**
 * Publishes the recording labels, seeded from the cache and republished
 * whole on every row event (the onZones shape — the table is small by
 * construction, capped at RECORDING_HISTORY_MAX server-side).
 */
export function wireRecordings(
  c: DbConnection,
  rows: SessionRows,
  hooks: RecordingFeedHooks,
): void {
  const publish = (): void => {
    const labels = [...c.db.callRecording.iter()]
      .map((row) => ({
        key: row.id.toString(),
        fileName: row.fileName,
        groupName: row.groupName,
        starterName: row.starterName,
        startedAtMs: Number(row.startedAt.microsSinceUnixEpoch / 1000n),
      }))
      .sort((a, b) => b.startedAtMs - a.startedAtMs);
    hooks.onRecordings(labels);
  };
  rows.on(c.db.callRecording, { insert: publish, delete: publish });
  publish();
}
