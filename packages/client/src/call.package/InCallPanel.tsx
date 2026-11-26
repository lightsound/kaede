// fallow-ignore-file coverage-gaps -- a React panel over the vendor's prebuilt meeting components; needs a DOM and WebRTC, and no DOM test environment is configured. The join sequencing around it lives server-side in the join_group_call procedure (増分⑥)
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
  UI_GOLD_BORDER,
  UI_STACKED_PANEL_STYLE,
  UI_TEXT_COLOR,
} from '../theme';
import { blurringClick } from '../ui.package';
import { noiseCancellationFace } from './noiseCancellation';
import type { Meeting, NoiseCanceller } from './realtimekit';

// The prebuilt in-call UI (ROADMAP Phase 4 増分③). These imports are legal
// INSIDE call.package only — the containment unit for the vendor
// dependency is this package (VISION 決定ログ 2026-08-06). Lazy-loaded
// from CallDock so idle players never download the kit (hls.js,
// @floating-ui, hark, lodash-es, …).

// Sized for the dock over the 2D world (部品を組む — not fullscreen); where
// the dock sits is App's: the bottom-left column (leftColumn.ts).
const inCallStyle: CSSProperties = {
  ...UI_STACKED_PANEL_STYLE,
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
  'recording.label': '録画中',
  'recording.indicator': 'この通話は録画されています',
});

export interface RecordingHandlers {
  start(): Promise<void>;
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
 * caused it — our procedures, another member, the unattended auto-stop.
 */
function useRecordingState(meeting: Meeting): string {
  const [state, setState] = useState<string>(meeting.recording.recordingState);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- 外部システム（RealtimeKit の meeting）の観測値を state に同期する定型パターン
    setState(meeting.recording.recordingState);
    const listener = (next: string) => setState(next);
    meeting.recording.addListener('recordingUpdate', listener);
    return () => {
      meeting.recording.removeListener('recordingUpdate', listener);
    };
  }, [meeting]);
  return state;
}

type RecordingPhase = 'idle' | 'recording' | 'starting' | 'stopping';

/**
 * The SDK's RecordingState vocabulary, folded per direction. Unknown
 * states (a future SDK word) read as 'starting': both transitional
 * phases render a disabled wait face, so an unknown state degrades to
 * "wait" rather than offering a possibly wrong action.
 */
const PHASE_BY_STATE: Record<string, RecordingPhase> = {
  IDLE: 'idle',
  STARTING: 'starting',
  RECORDING: 'recording',
  PAUSED: 'recording',
  STOPPING: 'stopping',
};

function recordingPhaseOf(state: string): RecordingPhase {
  return PHASE_BY_STATE[state] ?? 'starting';
}

type PendingAction = 'start' | 'stop' | null;

/**
 * What the toggle is waiting on, the in-flight call folded in: the room
 * state can lag the click by seconds (start) or race ahead of the
 * promise (stop can see IDLE before our procedure resolves), so while
 * our call is in flight the clicked direction wins over the room state.
 */
function effectivePhase(phase: RecordingPhase, pending: PendingAction): RecordingPhase {
  if (pending === null) return phase;
  return pending === 'start' ? 'starting' : 'stopping';
}

/**
 * The transitional faces name what is happening instead of a silently
 * disabled button: cloud recording provisions a server-side recorder on
 * demand, and the gap between the start click and the RECORDING room
 * event is ~12–15 seconds (measured 2026-08-07 — start API accepts in
 * ~2s, the recorder boots in ~12s). Without copy the button just greys
 * out and the wait reads as breakage.
 */
const TRANSITIONAL_FACES: Record<'starting' | 'stopping', string> = {
  starting: '⏳ 録画準備中…',
  stopping: '⏳ 停止処理中…',
};

function toggleFace(
  phase: RecordingPhase,
  pending: PendingAction,
): { label: string; disabled: boolean } {
  const effective = effectivePhase(phase, pending);
  if (effective === 'starting' || effective === 'stopping') {
    return { label: TRANSITIONAL_FACES[effective], disabled: true };
  }
  return { label: effective === 'recording' ? '⏹ 録画停止' : '⏺ 録画開始', disabled: false };
}

/**
 * The recording toggle (増分④) — deliberately NOT the UI Kit's
 * RtkRecordingToggle: that component renders only under a can_record
 * preset and dials the provider from the CLIENT, which cannot carry the
 * storage_config that sends the file to our R2 bucket. This button asks
 * our server instead (approved members only — CallDock offers it to
 * approved members, and the recording procedures refuse anyone else);
 * what it SHOWS still comes from the same room state the indicator
 * renders. The helpers above are split out to keep every uncovered
 * function under the CRAP budget.
 */
function RecordingToggle({ meeting, handlers }: { meeting: Meeting; handlers: RecordingHandlers }) {
  const phase = recordingPhaseOf(useRecordingState(meeting));
  const [pending, setPending] = useState<PendingAction>(null);
  const [failed, setFailed] = useState(false);
  const face = toggleFace(phase, pending);
  const toggle = async () => {
    const action = phase === 'recording' ? 'stop' : 'start';
    setPending(action);
    setFailed(false);
    try {
      await (action === 'stop' ? handlers.stop() : handlers.start());
    } catch (err) {
      console.error('recording toggle failed', err);
      setFailed(true);
    } finally {
      setPending(null);
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
 * The noise-cancellation toggle — kaede's own button like the recording
 * toggle, because the UI Kit has no surface for the vendor's separate
 * noise-cancellation package. Rendered only when the dial armed a
 * canceller (realtimekit.ts): where initialization failed, the call
 * simply has no processing and no dead control to explain. The default
 * is ON (autoManage arms it at dial; processing starts when the mic
 * goes live) — this toggle is the participant's way out when the
 * processing sounds wrong to them. The canceller exposes no change
 * events, so the face re-reads `enabled` on the meeting's audioUpdate
 * events: every transition rides one (autoManage enables on unmute,
 * the package self-disables after a runtime error), and our own clicks
 * re-read on settle.
 */
function NoiseCancellationToggle({
  meeting,
  canceller,
}: {
  meeting: Meeting;
  canceller: NoiseCanceller;
}) {
  const [enabled, setEnabled] = useState<boolean>(canceller.enabled);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const sync = () => setEnabled(canceller.enabled);
    // oxlint-disable-next-line react/set-state-in-effect -- 外部システム（RealtimeKit の meeting）の観測値を state に同期する定型パターン
    sync();
    meeting.self.on('audioUpdate', sync);
    return () => {
      meeting.self.off('audioUpdate', sync);
    };
  }, [meeting, canceller]);
  const face = noiseCancellationFace(enabled, pending);
  const toggle = async () => {
    setPending(true);
    setFailed(false);
    try {
      await (enabled ? canceller.disable() : canceller.enable());
    } catch (err) {
      console.error('noise cancellation toggle failed', err);
      setFailed(true);
    } finally {
      setPending(false);
      setEnabled(canceller.enabled);
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
      {failed && <span style={{ color: UI_ERROR_COLOR }}>ノイズ除去の操作に失敗しました</span>}
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
  noiseCancellation,
}: {
  meeting: Meeting;
  recording: RecordingHandlers | undefined;
  noiseCancellation: NoiseCanceller | undefined;
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
          {noiseCancellation !== undefined && (
            <NoiseCancellationToggle meeting={meeting} canceller={noiseCancellation} />
          )}
          <RtkLeaveButton size="sm" />
        </div>
        <RtkParticipantsAudio />
        <RtkDialogManager />
      </RtkUiProvider>
    </div>
  );
}
