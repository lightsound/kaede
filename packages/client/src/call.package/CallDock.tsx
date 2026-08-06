// fallow-ignore-file coverage-gaps -- a React control over the call flow, rendering the vendor's prebuilt meeting components; needs a DOM and WebRTC, and no DOM test environment is configured. The sequencing rules live in flow.ts (unit-tested)

// The prebuilt in-call UI (ROADMAP Phase 4 増分③). These imports are legal
// INSIDE call.package only — the containment unit for the vendor
// dependency is this package (VISION 決定ログ 2026-08-06).
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
  RtkScreenShareToggle,
  RtkSettingsToggle,
  RtkUiProvider,
} from '@cloudflare/realtimekit-react-ui';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
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
import { mintCallToken, provisionMeeting } from './api';
import { acquireCallTicket } from './flow';
import { dialMeeting, type Meeting } from './realtimekit';

// Stacked above the huddle control in the profile corner (bottom-left):
// a call is something you do from the conversation group you stand in,
// like the huddle is something you found where you stand.
const panelStyle: CSSProperties = {
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
  maxWidth: 420,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
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

// The ongoing call is wider than the idle offer: the grid needs room for
// tiles and shared screens (kaede stays a dock over the 2D world, so the
// panel is sized, not fullscreen — the 部品を組む decision, ROADMAP 増分③).
const inCallStyle: CSSProperties = {
  ...panelStyle,
  width: 520,
  maxWidth: 520,
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
});

/**
 * The ongoing call, assembled from the UI Kit's parts: the participant
 * grid (which also lays out shared screens), the control bar toggles, the
 * remote audio sink, and the dialog manager (device settings and the
 * leave confirmation render through it). RtkUiProvider syncs the meeting
 * and the toggles' state into every Rtk child.
 */
function InCallPanel({ meeting }: { meeting: Meeting }) {
  return (
    <div style={inCallStyle}>
      <RtkUiProvider meeting={meeting} t={dockLanguage}>
        <div style={stageStyle}>
          <RtkGrid style={{ width: '100%', height: '100%' }} />
        </div>
        <div style={{ ...rowStyle, justifyContent: 'center' }}>
          <RtkMicToggle size="sm" />
          <RtkCameraToggle size="sm" />
          <RtkScreenShareToggle size="sm" />
          <RtkSettingsToggle size="sm" />
          <RtkLeaveButton size="sm" />
        </div>
        <RtkParticipantsAudio />
        <RtkDialogManager />
      </RtkUiProvider>
    </div>
  );
}

/** The out-of-call offer: one button, plus the last failure if any. */
function IdlePanel({ notice, onJoin }: { notice: string | undefined; onJoin: () => void }) {
  return (
    <div style={panelStyle}>
      <div style={rowStyle}>
        <button type="button" style={buttonStyle} onClick={blurringClick(onJoin)}>
          📞 通話に参加
        </button>
        {notice !== undefined && <span style={{ color: UI_ERROR_COLOR }}>{notice}</span>}
      </div>
    </div>
  );
}

/** The dock's phase: out of a call, dialing, or in one. */
type CallPhase =
  | { kind: 'idle'; notice?: string }
  | { kind: 'joining' }
  | { kind: 'in-call'; groupId: bigint; meeting: Meeting };

/**
 * Whether the dock renders nothing: disconnected, or out of every
 * conversation group. Guests are offered the dock like members (増分② —
 * the Worker verifies their host-issued token). An ONGOING call always
 * renders — the WebRTC session is independent of the SpacetimeDB
 * connection, so a reconnect blip must not hide a live mic/camera with no
 * way to leave it (the session outliving its UI was a review finding);
 * sign-out needs no case here because the auth remount unmounts the dock,
 * whose cleanup leaves the call. Split from the component to keep both
 * under the CRAP budget.
 */
function dockHidden(connected: boolean, ownGroupId: bigint | undefined, phase: CallPhase): boolean {
  if (phase.kind === 'in-call') return false;
  return !connected || ownGroupId === undefined;
}

/** What the dock calls on the net facade (the HuddleActions shape). */
export interface CallDockNet {
  ownGroupCall(): { groupId: bigint; meetingId: string | undefined } | undefined;
  registerGroupCall(meetingId: string): Promise<void>;
}

/** Everything the join sequence below needs from the mounted dock. */
interface JoinContext {
  net: CallDockNet;
  getToken: AuthTokenGetter;
  ownName: string | undefined;
  setPhase: (update: (current: CallPhase) => CallPhase) => void;
  meetingRef: { current: Meeting | undefined };
  /** The in-flight latch: a double-click must not start two pipelines. */
  joiningRef: { current: boolean };
}

/**
 * The whole join sequence: acquire the ticket (flow.ts — provisioning and
 * registering the meeting when the group has none), dial in, and hand the
 * live meeting to the in-call phase. Failures land back in the idle phase
 * with a notice; the dial's onEnded resets the phase on every exit path
 * (own leave, kick, meeting end).
 */
async function joinCall(ctx: JoinContext): Promise<void> {
  // The latch, ref-based because two clicks can land before React renders
  // the joining phase (a review finding): the second becomes a no-op
  // instead of a parallel pipeline whose meeting nothing would track.
  if (ctx.joiningRef.current) return;
  ctx.joiningRef.current = true;
  ctx.setPhase(() => ({ kind: 'joining' }));
  try {
    const ticket = await acquireCallTicket({
      ownGroupCall: () => ctx.net.ownGroupCall(),
      registerGroupCall: (meetingId) => ctx.net.registerGroupCall(meetingId),
      provisionMeeting: () => provisionMeeting(ctx.getToken),
      mintToken: (meetingId) => mintCallToken(ctx.getToken, meetingId, ctx.ownName ?? ''),
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    const meeting = await dialMeeting({
      authToken: ticket.authToken,
      onEnded: () => {
        ctx.meetingRef.current = undefined;
        ctx.setPhase(() => ({ kind: 'idle' }));
      },
    });
    ctx.meetingRef.current = meeting;
    // onEnded can beat this line (kicked mid-handshake): an idle phase
    // must not be overwritten with a dead meeting's in-call panel.
    ctx.setPhase((current) =>
      current.kind === 'idle' ? current : { kind: 'in-call', groupId: ticket.groupId, meeting },
    );
  } catch (err) {
    console.error('call join failed', err);
    ctx.setPhase(() => ({ kind: 'idle', notice: '通話に参加できませんでした' }));
  } finally {
    ctx.joiningRef.current = false;
  }
}

/**
 * The call dock (ROADMAP Phase 4 増分①〜③): joins the conversation
 * group's call — provisioning and registering its meeting when it has
 * none — and renders the ongoing call with the UI Kit's prebuilt parts.
 * Offered to everyone in a conversation group, guests included (増分② —
 * the api layer falls back to the connection's host-issued token, which
 * the Worker verifies); outside a group there is no call to join. Leaving
 * the group in any way (walking off, switching, getting swept) ends the
 * participation: the auto-leave effect below watches the own-group signal.
 */
export function CallDock({
  connected,
  ownGroupId,
  ownName,
  getToken,
  net,
}: {
  connected: boolean;
  /** The own-group signal (NetHooks.onOwnGroup). */
  ownGroupId: bigint | undefined;
  /** The authoritative display name — what the call tile shows the others. */
  ownName: string | undefined;
  getToken: AuthTokenGetter;
  net: CallDockNet;
}) {
  const [phase, setPhase] = useState<CallPhase>({ kind: 'idle' });
  // The live meeting for the unmount cleanup — state would be stale there.
  const meetingRef = useRef<Meeting>(undefined);
  // See JoinContext.joiningRef.
  const joiningRef = useRef(false);

  // The auto-leave watch: a call is the GROUP's, so the session ends the
  // moment the membership stops naming its group (walked away, switched
  // conversations, swept from the world). The dial's onEnded fires on
  // leave(), which resets the phase.
  useEffect(() => {
    if (phase.kind !== 'in-call') return;
    if (ownGroupId !== phase.groupId) void phase.meeting.leave().catch(() => {});
  }, [phase, ownGroupId]);

  // Unmount cleanup (auth remount, App teardown): the WebRTC session
  // outlives no component. Ref-based so it never re-runs mid-call.
  useEffect(
    () => () => {
      void meetingRef.current?.leave().catch(() => {});
      meetingRef.current = undefined;
    },
    [],
  );

  if (dockHidden(connected, ownGroupId, phase)) return null;
  if (phase.kind === 'joining') return <div style={panelStyle}>📞 通話に接続中…</div>;
  if (phase.kind === 'in-call') return <InCallPanel meeting={phase.meeting} />;
  return (
    <IdlePanel
      notice={phase.notice}
      onJoin={() => void joinCall({ net, getToken, ownName, setPhase, meetingRef, joiningRef })}
    />
  );
}
