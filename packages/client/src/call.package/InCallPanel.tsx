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
  RtkRecordingToggle,
  RtkScreenShareToggle,
  RtkSettingsToggle,
  RtkUiProvider,
} from '@cloudflare/realtimekit-react-ui';
import { type CSSProperties, useEffect } from 'react';
import { UI_FONT, UI_GOLD_BORDER, UI_PANEL_BG, UI_TEXT_COLOR } from '../theme';
import type { Meeting } from './realtimekit';

// The prebuilt in-call UI (ROADMAP Phase 4 増分③〜④). These imports are
// legal INSIDE call.package only — the containment unit for the vendor
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
  'recording.label': '録画',
  'recording.indicator': '録画中',
  'recording.started': '録画を開始しました',
  'recording.stopped': '録画を停止しました',
  'recording.start': '録画開始',
  'recording.stop': '録画停止',
  'recording.starting': '録画を開始しています…',
  'recording.stopping': '録画を停止しています…',
  'recording.idle': '録画していません',
  'recording.error.start': '録画を開始できませんでした',
  'recording.error.stop': '録画を停止できませんでした',
});

/** What the panel reports when a recording appears on the meeting. */
export interface RecordingStarted {
  recordingId: string;
  startedAtMs: bigint;
}

/**
 * The ongoing call, assembled from the UI Kit's parts: the participant
 * grid (which also lays out shared screens), the control bar toggles
 * (including recording — 増分④), the remote audio sink, and the dialog
 * manager. RtkUiProvider syncs the meeting and the toggles' state into
 * every Rtk child. `onRecordingStarted` feeds the SpacetimeDB catalog
 * row (register_call_recording) so the list/DL UI has something to show
 * before the webhook lands.
 */
export function InCallPanel({
  meeting,
  onRecordingStarted,
}: {
  meeting: Meeting;
  onRecordingStarted?: (event: RecordingStarted) => void;
}) {
  useEffect(() => {
    if (onRecordingStarted === undefined) return;
    // Dedup so STARTING→RECORDING does not double-register the same id.
    const seen = new Set<string>();
    const report = (state: string) => {
      if (state !== 'STARTING' && state !== 'RECORDING') return;
      for (const row of meeting.recording.recordings) {
        if (row.state !== 'STARTING' && row.state !== 'RECORDING') continue;
        if (row.id === '' || seen.has(row.id)) continue;
        seen.add(row.id);
        onRecordingStarted({
          recordingId: row.id,
          startedAtMs: BigInt(Date.now()),
        });
      }
    };
    meeting.recording.addListener('recordingUpdate', report);
    report(meeting.recording.recordingState);
    return () => {
      meeting.recording.removeListener('recordingUpdate', report);
    };
  }, [meeting, onRecordingStarted]);

  return (
    <div style={inCallStyle}>
      <RtkUiProvider meeting={meeting} t={dockLanguage}>
        <div style={stageStyle}>
          <RtkGrid style={{ width: '100%', height: '100%' }} />
        </div>
        <div style={rowStyle}>
          <RtkRecordingIndicator />
          <RtkMicToggle size="sm" />
          <RtkCameraToggle size="sm" />
          <RtkScreenShareToggle size="sm" />
          <RtkRecordingToggle size="sm" />
          <RtkSettingsToggle size="sm" />
          <RtkLeaveButton size="sm" />
        </div>
        <RtkParticipantsAudio />
        <RtkDialogManager />
      </RtkUiProvider>
    </div>
  );
}
