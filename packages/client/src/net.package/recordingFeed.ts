// fallow-ignore-file coverage-gaps -- wires live SpacetimeDB row events to the recording-label list; needs a running host. It carries no rules of its own — the rows are published verbatim, newest first
import type { DbConnection } from '../module_bindings';

/**
 * One call_recording row as the 録画一覧 renders it (ROADMAP Phase 4
 * 増分④): the human labels for one recording. The R2 object itself — and
 * whether it is downloadable yet — is the Worker's listing (call.package
 * fetches it when the panel opens); this view only decorates that listing,
 * joined on `fileName`. `key` is the stringified row id (bigint is no
 * React key).
 */
export interface RecordingLabelView {
  key: string;
  /** The R2 object basename — the join key against the Worker's listing. */
  fileName: string;
  groupName: string;
  starterName: string;
  /** When the recording started, in epoch milliseconds (display only). */
  startedAtMs: number;
}

/** What publishing the label list needs from the session that wires the feed. */
export interface RecordingFeedHooks {
  /** True once this session's events must be ignored (see wireSession). */
  isStale(): boolean;
  /** Every call_recording change, as the whole list (newest first). */
  onRecordings(labels: RecordingLabelView[]): void;
}

/**
 * Publishes the recording labels, seeded from the cache and republished
 * whole on every row event (the onZones shape — the table is small by
 * construction, capped at RECORDING_HISTORY_MAX server-side).
 */
export function wireRecordings(c: DbConnection, hooks: RecordingFeedHooks): void {
  const publish = (): void => {
    if (hooks.isStale()) return;
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
  c.db.callRecording.onInsert(() => publish());
  c.db.callRecording.onDelete(() => publish());
  publish();
}
