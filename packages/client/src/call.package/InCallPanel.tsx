// fallow-ignore-file coverage-gaps -- a React panel over the vendor's prebuilt meeting components; needs a DOM and WebRTC, and no DOM test environment is configured. The join sequencing around it lives in flow.ts (unit-tested)
import {
  // Not a React hook despite the name — a plain factory merging a partial
  // dict over the UI Kit's default language (aliased so lint agrees).
  useLanguage as makeRtkLanguage,
  RtkCameraToggle,
  RtkDialogManager,
  RtkGrid,
  RtkLeaveButton,
  RtkMicToggle,
  RtkParticipantsAudio,
  RtkRecordingIndicator,
  RtkScreenShareToggle,
  RtkSettingsToggle,
  RtkUiProvider,
} from '@cloudflare/realtimekit-react-ui';
import { type CSSProperties, useEffect, useState } from 'react';
import {
  UI_BUTTON_BG,
  UI_ERROR_COLOR,
  UI_FONT,
  UI_GOLD_BORDER,
  UI_PANEL_BG,
  UI_TEXT_COLOR,
} from '../theme';
import { blurringClick } from '../ui.package';
import type { Meeting } from './realtimekit';

// The prebuilt in-call UI (ROADMAP Phase 4 増分③). These imports are legal
// INSIDE call.package only — the containment unit for the vendor
// dependency is this package (VISION 決定ログ 2026-08-06). Lazy-loaded
// from CallDock so idle players never download the kit (hls.js,
// @floating-ui, hark, lodash-es, …).

// Sized for the dock over the 2D world (部品を組む — not fullscreen).
const inCallStyle: CSSProperties = {
  position: 'absolute',
  bottom: 220,
  left: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '6px 8px',
  borderRadius: 8,
  background: UI_PANEL_BG,
  border: UI_GOLD_BORDER,
  font: UI_FONT,
  color: UI_TEXT_COLOR,
  width: 520,
  maxWidth: 520,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
  justifyContent: 'center',
};

// RtkGrid fills its container, so the stage fixes the dimensions.
const stageStyle: CSSProperties = {
  height: 300,
  display: 'flex',
};

/**
 * The dock's visible vendor strings, over the UI Kit's English defaults
 * (the rest of kaede is Japanese). Vendor-keyed, so it lives here rather
 * than in the Paraglide messages (those keys are ours).
 */
const dockLanguage = makeRtkLanguage({
  '(you)': '(自分)',
  you: '自分',
  mic_on: 'マイク オン',
  mic_off: 'マイク オフ',
  enable_mic: 'マイクをオンにする',
  disable_mic: 'マイクをオフにする',
  video_on: 'カメラ オン',
  video_off: 'カメラ オフ',
  enable_video: 'カメラをオンにする',
  disable_video: 'カメラをオフにする',
  screenshare: '画面共有',
  'screenshare.start': '画面共有',
  'screenshare.stop': '共有停止',
  'screenshare.shared': '画面を共有しています。',
  'screenshare.min_preview': 'プレビューを縮小',
  'screenshare.max_preview': 'プレビューを拡大',
  settings: '設定',
  audio: '音声',
  video: '映像',
  camera: 'カメラ',
  screen: '画面',
  test: 'テスト',
  'settings.microphone_input': 'マイク入力',
  'settings.speaker_output': 'スピーカー出力',
  'settings.notification_sound': '通知音',
  'settings.mirror_video': '自分の映像を反転',
  'settings.camera_off': 'カメラがオフです',
  leave: '退出',
  leave_confirmation: '通話から退出しますか？',
  cancel: 'キャンセル',
  yes: 'はい',
  'audio_playback.title': '音声を再生',
  'audio_playback.description': 'ブラウザの自動再生制限のため、クリックで通話音声を有効にします。',
  audio_playback: '音声を有効にする',
  // The recording indicator (増分④ — the transparency rule: every
  // participant sees it, whoever started the recording).
  'recording.label': '録画中',
  'recording.indicator': 'この通話は録画されています',
});

/** What the recording toggle calls — CallDock binds these to the Worker API. */
export interface RecordingHandlers {
  /** Starts the recording and logs its label row; rejects on refusal. */
  start(): Promise<void>;
  /** Stops the active recording; resolves even when none is active. */
  stop(): Promise<void>;
}

const recordButtonStyle: CSSProperties = {
  padding: '2px 8px',
  borderRadius: 6,
  border: UI_GOLD_BORDER,
  background: UI_BUTTON_BG,
  color: UI_TEXT_COLOR,
  font: 'inherit',
  cursor: 'pointer',
  flexShrink: 0,
};

/**
 * The provider-side recording state this client currently observes.
 * Subscribed exactly like the UI Kit's own recording parts (the
 * recordingUpdate room event), so it reflects every start/stop whoever
 * caused it — our Worker, another member, the unattended auto-stop.
 */
function useRecordingState(meeting: Meeting): string {
  const [state, setState] = useState<string>(meeting.recording.recordingState);
  useEffect(() => {
    setState(meeting.recording.recordingState);
    const listener = (next: string) => setState(next);
    meeting.recording.addListener('recordingUpdate', listener);
    return () => {
      meeting.recording.removeListener('recordingUpdate', listener);
    };
  }, [meeting]);
  return state;
}

/** The provider states collapsed to what the toggle rules on. */
type RecordingPhase = 'idle' | 'recording' | 'transitional';

function recordingPhaseOf(state: string): RecordingPhase {
  if (state === 'RECORDING' || state === 'PAUSED') return 'recording';
  return state === 'IDLE' ? 'idle' : 'transitional';
}

/** The button's face for one phase (disabled while anything is in flight). */
function toggleFace(phase: RecordingPhase, busy: boolean): { label: string; disabled: boolean } {
  return {
    label: phase === 'recording' ? '⏹ 録画停止' : '⏺ 録画開始',
    disabled: busy || phase === 'transitional',
  };
}

/**
 * The recording toggle (増分④) — deliberately NOT the UI Kit's
 * RtkRecordingToggle: that component renders only under a can_record
 * preset and dials the provider from the CLIENT, which cannot carry the
 * storage_config that sends the file to our R2 bucket. This button asks
 * our Worker instead (members only — CallDock offers it to signed-in
 * members, and the Worker 403s anyone else); what it SHOWS still comes
 * from the same room state the indicator renders. The helpers above are
 * split out to keep every uncovered function under the CRAP budget.
 */
function RecordingToggle({ meeting, handlers }: { meeting: Meeting; handlers: RecordingHandlers }) {
  const phase = recordingPhaseOf(useRecordingState(meeting));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const face = toggleFace(phase, busy);
  const toggle = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await (phase === 'recording' ? handlers.stop() : handlers.start());
    } catch (err) {
      console.error('recording toggle failed', err);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        style={recordButtonStyle}
        disabled={face.disabled}
        onClick={blurringClick(() => void toggle())}
      >
        {face.label}
      </button>
      {failed && <span style={{ color: UI_ERROR_COLOR }}>録画の操作に失敗しました</span>}
    </>
  );
}

/**
 * The ongoing call, assembled from the UI Kit's parts: the participant
 * grid (which also lays out shared screens), the control bar toggles, the
 * remote audio sink, and the dialog manager (device settings and the
 * leave confirmation render through it). RtkUiProvider syncs the meeting
 * and the toggles' state into every Rtk child. The recording indicator
 * renders for EVERYONE (the 増分④ transparency rule); the recording
 * toggle only when the dock handed handlers (signed-in members).
 */
export function InCallPanel({
  meeting,
  recording,
}: {
  meeting: Meeting;
  /** The member-only recording control, or undefined for guests. */
  recording: RecordingHandlers | undefined;
}) {
  return (
    <div style={inCallStyle}>
      <RtkUiProvider meeting={meeting} t={dockLanguage}>
        <RtkRecordingIndicator meeting={meeting} />
        <div style={stageStyle}>
          <RtkGrid style={{ width: '100%', height: '100%' }} />
        </div>
        <div style={rowStyle}>
          <RtkMicToggle size="sm" />
          <RtkCameraToggle size="sm" />
          <RtkScreenShareToggle size="sm" />
          <RtkSettingsToggle size="sm" />
          {recording !== undefined && <RecordingToggle meeting={meeting} handlers={recording} />}
          <RtkLeaveButton size="sm" />
        </div>
        <RtkParticipantsAudio />
        <RtkDialogManager />
      </RtkUiProvider>
    </div>
  );
}
