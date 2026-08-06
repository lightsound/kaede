// fallow-ignore-file coverage-gaps -- a React control over the Worker recording API + UI Kit meeting state; needs a DOM and live WebRTC. Catalog rules live in @kaede/shared / packages/server
import { type CSSProperties, useEffect, useState } from 'react';
import type { AuthTokenGetter } from '../net.package';
import { UI_BUTTON_BG, UI_GOLD_BORDER, UI_TEXT_COLOR } from '../theme';
import { blurringClick } from '../ui.package';
import { startCallRecording, stopCallRecording } from './api';
import type { Meeting } from './realtimekit';

// Worker-backed recording toggle (増分④). RtkRecordingToggle talks to the
// client SDK and cannot attach storage_config for R2 direct upload — start
// / stop must go through the Worker (Bugbot + ROADMAP). The indicator stays
// the UI Kit's RtkRecordingIndicator so every participant sees the same
// meeting.recording state the REST start surfaces.

type RecordingState = Meeting['recording']['recordingState'];

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

function isActiveRecordingState(state: string): boolean {
  return state === 'STARTING' || state === 'RECORDING';
}

/** Active provider recording id on the meeting, if any. */
function activeRecordingId(meeting: Meeting): string | undefined {
  for (const row of meeting.recording.recordings) {
    if (isActiveRecordingState(row.state) && row.id !== '') return row.id;
  }
  return undefined;
}

function idleOrBusyLabel(busy: boolean): string {
  return busy ? '…' : '録画開始';
}

function activeToggleLabel(state: RecordingState, busy: boolean): string {
  if (busy) return '…';
  if (state === 'STARTING') return '録画開始中…';
  if (state === 'STOPPING') return '録画停止中…';
  return '録画停止';
}

function toggleLabel(state: RecordingState, busy: boolean): string {
  if (isActiveRecordingState(state) || state === 'STOPPING') {
    return activeToggleLabel(state, busy);
  }
  return idleOrBusyLabel(busy);
}

async function stopActiveRecording(meeting: Meeting, getToken: AuthTokenGetter): Promise<void> {
  const id = activeRecordingId(meeting);
  if (id === undefined) return;
  await stopCallRecording(getToken, id);
}

async function startAndReport(
  getToken: AuthTokenGetter,
  meetingId: string,
  onRecordingStarted?: (event: { recordingId: string; startedAtMs: bigint }) => void,
): Promise<void> {
  const recordingId = await startCallRecording(getToken, meetingId);
  onRecordingStarted?.({
    recordingId,
    startedAtMs: BigInt(Date.now()),
  });
}

/**
 * Approved-member recording start/stop. Hidden when `canRecord` is false
 * (guests — Worker would 403 anyway; the host preset's can_record is the
 * other half of the same rule).
 */
export function RecordingToggle({
  meeting,
  meetingId,
  getToken,
  canRecord,
  onRecordingStarted,
}: {
  meeting: Meeting;
  meetingId: string;
  getToken: AuthTokenGetter;
  canRecord: boolean;
  onRecordingStarted?: (event: { recordingId: string; startedAtMs: bigint }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<RecordingState>(meeting.recording.recordingState);

  useEffect(() => {
    const onUpdate = (next: RecordingState) => setState(next);
    meeting.recording.addListener('recordingUpdate', onUpdate);
    setState(meeting.recording.recordingState);
    return () => {
      meeting.recording.removeListener('recordingUpdate', onUpdate);
    };
  }, [meeting]);

  if (!canRecord) return null;

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (isActiveRecordingState(state)) {
        await stopActiveRecording(meeting, getToken);
        return;
      }
      await startAndReport(getToken, meetingId, onRecordingStarted);
    } catch (err) {
      console.error('recording toggle failed', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      style={buttonStyle}
      disabled={busy}
      onClick={blurringClick(() => void toggle())}
    >
      {toggleLabel(state, busy)}
    </button>
  );
}
