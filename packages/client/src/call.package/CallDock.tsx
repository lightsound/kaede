// fallow-ignore-file coverage-gaps -- a React control over the call flow and live media tracks; needs a DOM and WebRTC, and no DOM test environment is configured. The sequencing rules live in flow.ts (unit-tested); the provider seam is provider.ts
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
import type { CallSession, CallSnapshot, CallTile } from './provider';
import { realtimeKitProvider } from './realtimekit';

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

const tileStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 2,
  width: 120,
};

const videoStyle: CSSProperties = {
  width: 120,
  height: 90,
  borderRadius: 6,
  background: '#000',
  objectFit: 'cover',
};

/** Attaches a live MediaStreamTrack to a media element (or detaches it). */
function useTrack(ref: { current: HTMLMediaElement | null }, track: MediaStreamTrack | undefined) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (track === undefined) {
      element.srcObject = null;
      return;
    }
    element.srcObject = new MediaStream([track]);
    element.play().catch(() => {
      // Autoplay refusals self-heal: the user is already interacting with
      // the dock (they clicked to join), and the next toggle re-plays.
    });
    return () => {
      element.srcObject = null;
    };
  }, [ref, track]);
}

function VideoTile({ tile }: { tile: CallTile }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  useTrack(videoRef, tile.videoTrack);
  useTrack(audioRef, tile.audioTrack);
  return (
    <div style={tileStyle}>
      {tile.videoTrack !== undefined ? (
        // The self preview is muted by contract (its audio never plays);
        // remote tiles carry audio on the sibling element below.
        <video ref={videoRef} style={videoStyle} autoPlay playsInline muted />
      ) : (
        <div
          style={{ ...videoStyle, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          📷 オフ
        </div>
      )}
      {!tile.isSelf && (
        // biome-ignore lint/a11y/useMediaCaption: ライブ通話音声にキャプションは存在しない(文字起こしは将来の増分)
        <audio ref={audioRef} autoPlay />
      )}
      <span>{tile.isSelf ? `${tile.name}(自分)` : tile.name}</span>
    </div>
  );
}

/** The ongoing call: everyone's tiles plus the local media controls. */
function InCallPanel({ session, snapshot }: { session: CallSession; snapshot: CallSnapshot }) {
  return (
    <div style={panelStyle}>
      <div style={rowStyle}>
        {snapshot.tiles.map((tile) => (
          <VideoTile key={tile.key} tile={tile} />
        ))}
      </div>
      <div style={rowStyle}>
        <button
          type="button"
          style={buttonStyle}
          onClick={blurringClick(() => void session.setMic(!snapshot.micOn).catch(() => {}))}
        >
          {snapshot.micOn ? '🎤 ミュート' : '🎤 オン'}
        </button>
        <button
          type="button"
          style={buttonStyle}
          onClick={blurringClick(() => void session.setCamera(!snapshot.cameraOn).catch(() => {}))}
        >
          {snapshot.cameraOn ? '📷 オフ' : '📷 オン'}
        </button>
        <button
          type="button"
          style={buttonStyle}
          onClick={blurringClick(() => void session.leave().catch(() => {}))}
        >
          退出
        </button>
      </div>
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
  | { kind: 'in-call'; groupId: bigint; session: CallSession; snapshot: CallSnapshot };

/**
 * Whether the dock renders nothing: disconnected or a guest (the Worker
 * would refuse the token anyway), or out of every conversation group with
 * no call to show — an ongoing call stays rendered through the leave
 * round-trip (the auto-leave effect ends it). Split from the component to
 * keep both under the CRAP budget.
 */
function dockHidden(
  connected: boolean,
  signedIn: boolean,
  ownGroupId: bigint | undefined,
  phase: CallPhase,
): boolean {
  return !connected || !signedIn || (ownGroupId === undefined && phase.kind !== 'in-call');
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
  sessionRef: { current: CallSession | undefined };
}

/**
 * The whole join sequence: acquire the ticket (flow.ts — provisioning and
 * registering the meeting when the group has none), dial the provider, and
 * publish every snapshot into the dock's phase. Failures land back in the
 * idle phase with a notice; the provider's onEnded resets the phase on
 * every exit path (own leave, kick, meeting end).
 */
async function joinCall(ctx: JoinContext): Promise<void> {
  ctx.setPhase(() => ({ kind: 'joining' }));
  try {
    const ticket = await acquireCallTicket({
      ownGroupCall: () => ctx.net.ownGroupCall(),
      registerGroupCall: (meetingId) => ctx.net.registerGroupCall(meetingId),
      provisionMeeting: () => provisionMeeting(ctx.getToken),
      mintToken: (meetingId) => mintCallToken(ctx.getToken, meetingId, ctx.ownName ?? ''),
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    const session = await realtimeKitProvider.join({
      authToken: ticket.authToken,
      onSnapshot: (snapshot) =>
        ctx.setPhase((current) =>
          current.kind === 'idle'
            ? current
            : { kind: 'in-call', groupId: ticket.groupId, session, snapshot },
        ),
      onEnded: () => {
        ctx.sessionRef.current = undefined;
        ctx.setPhase(() => ({ kind: 'idle' }));
      },
    });
    ctx.sessionRef.current = session;
  } catch (err) {
    console.error('call join failed', err);
    ctx.setPhase(() => ({ kind: 'idle', notice: '通話に参加できませんでした' }));
  }
}

/**
 * The call dock (ROADMAP Phase 4 増分①): joins the conversation group's
 * call — provisioning and registering its meeting when it has none — and
 * renders the ongoing call's tiles and media toggles. Offered to
 * signed-in MEMBERS in a conversation group only: the token Worker
 * refuses guests (the 増分① scope cut), and outside a group there is no
 * call to join. Leaving the group in any way (walking off, switching,
 * getting swept) ends the participation: the auto-leave effect below
 * watches the own-group signal.
 */
export function CallDock({
  connected,
  signedIn,
  ownGroupId,
  ownName,
  getToken,
  net,
}: {
  connected: boolean;
  signedIn: boolean;
  /** The own-group signal (NetHooks.onOwnGroup). */
  ownGroupId: bigint | undefined;
  /** The authoritative display name — what the call tile shows the others. */
  ownName: string | undefined;
  getToken: AuthTokenGetter;
  net: CallDockNet;
}) {
  const [phase, setPhase] = useState<CallPhase>({ kind: 'idle' });
  // The live session for the unmount cleanup — state would be stale there.
  const sessionRef = useRef<CallSession>(undefined);

  // The auto-leave watch: a call is the GROUP's, so the session ends the
  // moment the membership stops naming its group (walked away, switched
  // conversations, swept from the world). The provider fires onEnded on
  // leave(), which resets the phase.
  useEffect(() => {
    if (phase.kind !== 'in-call') return;
    if (ownGroupId !== phase.groupId) void phase.session.leave().catch(() => {});
  }, [phase, ownGroupId]);

  // Unmount cleanup (auth remount, App teardown): the WebRTC session
  // outlives no component. Ref-based so it never re-runs mid-call.
  useEffect(
    () => () => {
      void sessionRef.current?.leave().catch(() => {});
      sessionRef.current = undefined;
    },
    [],
  );

  if (dockHidden(connected, signedIn, ownGroupId, phase)) return null;
  if (phase.kind === 'joining') return <div style={panelStyle}>📞 通話に接続中…</div>;
  if (phase.kind === 'in-call') {
    return <InCallPanel session={phase.session} snapshot={phase.snapshot} />;
  }
  return (
    <IdlePanel
      notice={phase.notice}
      onJoin={() => void joinCall({ net, getToken, ownName, setPhase, sessionRef })}
    />
  );
}
