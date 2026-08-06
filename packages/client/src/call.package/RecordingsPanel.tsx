// fallow-ignore-file coverage-gaps -- a React list over SpacetimeDB rows + Worker download; needs a DOM and the live Worker. Catalog rules live in @kaede/shared / packages/server
import { RECORDING_STATUS_UPLOADED } from '@kaede/shared';
import { type CSSProperties, useState } from 'react';
import type { AuthTokenGetter } from '../net.package';
import {
  UI_BUTTON_BG,
  UI_ERROR_COLOR,
  UI_FONT,
  UI_GOLD_BORDER,
  UI_PANEL_BG,
  UI_TEXT_COLOR,
} from '../theme';
import { blurringClick } from '../ui.package';
import { downloadCallRecording } from './api';

/** One catalog row the panel can render (net.package's CallRecordingView). */
export interface RecordingListItem {
  recordingId: string;
  status: string;
  objectKey: string;
  outputFileName: string;
  startedAtMs: bigint;
  durationSecs: number;
}

const panelStyle: CSSProperties = {
  position: 'absolute',
  bottom: 12,
  right: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '8px 10px',
  borderRadius: 8,
  background: UI_PANEL_BG,
  border: UI_GOLD_BORDER,
  font: UI_FONT,
  color: UI_TEXT_COLOR,
  width: 320,
  maxHeight: 280,
  overflow: 'auto',
};

const buttonStyle: CSSProperties = {
  padding: '2px 8px',
  borderRadius: 6,
  border: UI_GOLD_BORDER,
  background: UI_BUTTON_BG,
  color: UI_TEXT_COLOR,
  font: 'inherit',
  cursor: 'pointer',
  flexShrink: 0,
};

const STATUS_LABEL: Record<string, string> = {
  recording: '録画中',
  uploading: 'アップロード中',
  uploaded: '完了',
  errored: 'エラー',
};

function formatStartedAt(ms: bigint): string {
  if (ms === 0n) return '—';
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(secs: number): string {
  if (secs <= 0) return '';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Approved-member recording catalog (ROADMAP Phase 4 増分④). Lives in
 * call.package so the download helper (Worker client) stays next to the
 * rest of the call API — no vendor SDK imports. Hidden when the list is
 * empty and the viewer is not an approved member (parent gates that).
 */
export function RecordingsPanel({
  recordings,
  getToken,
}: {
  recordings: RecordingListItem[];
  getToken: AuthTokenGetter;
}) {
  const [notice, setNotice] = useState<string>();
  const [busyId, setBusyId] = useState<string>();

  if (recordings.length === 0) return null;

  const download = async (row: RecordingListItem) => {
    if (row.status !== RECORDING_STATUS_UPLOADED || row.objectKey === '') {
      setNotice('まだダウンロードできません');
      return;
    }
    setBusyId(row.recordingId);
    setNotice(undefined);
    try {
      const blob = await downloadCallRecording(getToken, row.recordingId, row.objectKey);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = row.outputFileName === '' ? `${row.recordingId}.mp4` : row.outputFileName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('recording download failed', err);
      setNotice('ダウンロードに失敗しました');
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <div style={panelStyle}>
      <div style={{ fontWeight: 600 }}>録画</div>
      {recordings.map((row) => {
        const canDownload = row.status === RECORDING_STATUS_UPLOADED && row.objectKey !== '';
        const duration = formatDuration(row.durationSecs);
        return (
          <div
            key={row.recordingId}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              justifyContent: 'space-between',
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {formatStartedAt(row.startedAtMs)}
              {duration === '' ? '' : ` · ${duration}`}
              {` · ${STATUS_LABEL[row.status] ?? row.status}`}
            </span>
            <button
              type="button"
              style={buttonStyle}
              disabled={!canDownload || busyId === row.recordingId}
              onClick={blurringClick(() => void download(row))}
            >
              {busyId === row.recordingId ? '…' : 'DL'}
            </button>
          </div>
        );
      })}
      {notice !== undefined && <span style={{ color: UI_ERROR_COLOR }}>{notice}</span>}
    </div>
  );
}
