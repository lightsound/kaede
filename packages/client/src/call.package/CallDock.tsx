// fallow-ignore-file coverage-gaps -- a React control over the call flow; needs a DOM and WebRTC, and no DOM test environment is configured. The sequencing rules live in flow.ts (unit-tested); the UI Kit panel is InCallPanel.tsx (lazy-loaded)
import { type CSSProperties, lazy, Suspense, useEffect, useRef, useState } from 'react';
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
import { mintCallToken, provisionMeeting, startCallRecording, stopCallRecording } from './api';
import { acquireCallTicket } from './flow';
import type { RecordingHandlers } from './InCallPanel';
import { dialMeeting, type Meeting } from './realtimekit';

// The UI Kit (hls.js, @floating-ui, hark, lodash-es, …) lives only in
// InCallPanel — lazy so idle players never download it (a review finding).
const InCallPanel = lazy(() => import('./InCallPanel').then((m) => ({ default: m.InCallPanel })));

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
  | { kind: 'in-call'; groupId: bigint; meetingId: string; meeting: Meeting };

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
  /** NetApi.logGroupRecording — the fire-and-forget label write (増分④). */
  logGroupRecording(fileName: string): void;
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
    // onEnded can beat the lines after the dial (kicked mid-handshake):
    // the dead meeting must not repopulate the ref — the unmount
    // cleanup's and the next join's only teardown handle — nor overwrite
    // the idle phase with its in-call panel.
    let ended = false;
    const meeting = await dialMeeting({
      authToken: ticket.authToken,
      onEnded: () => {
        ended = true;
        ctx.meetingRef.current = undefined;
        ctx.setPhase(() => ({ kind: 'idle' }));
      },
    });
    if (ended) return;
    ctx.meetingRef.current = meeting;
    ctx.setPhase(() => ({
      kind: 'in-call',
      groupId: ticket.groupId,
      meetingId: ticket.meetingId,
      meeting,
    }));
  } catch (err) {
    console.error('call join failed', err);
    ctx.setPhase(() => ({ kind: 'idle', notice: '通話に参加できませんでした' }));
  } finally {
    ctx.joiningRef.current = false;
  }
}

/**
 * The member-only recording control the in-call panel renders (増分④), or
 * undefined for guests: start asks the Worker (which holds the provider
 * secret and the R2 credentials) and then logs the label row the 録画一覧
 * decorates itself with; stop asks the Worker to look the active
 * recording up — no recording id is kept client-side (the stateless
 * rule). Split from the component to stay under the CRAP budget.
 */
function recordingHandlersFor(
  member: boolean,
  getToken: AuthTokenGetter,
  meetingId: string,
  net: CallDockNet,
): RecordingHandlers | undefined {
  if (!member) return undefined;
  return {
    start: async () => {
      const fileName = await startCallRecording(getToken, meetingId);
      net.logGroupRecording(fileName);
    },
    stop: () => stopCallRecording(getToken, meetingId),
  };
}

/**
 * The call dock (ROADMAP Phase 4 増分①〜③): joins the conversation
 * group's call — provisioning and registering its meeting when it has
 * none — and renders the ongoing call with the UI Kit's prebuilt parts
 * (lazy InCallPanel). Offered to everyone in a conversation group, guests
 * included (増分② — the api layer falls back to the connection's
 * host-issued token, which the Worker verifies); outside a group there is
 * no call to join. Leaving the group in any way (walking off, switching,
 * getting swept) ends the participation: the auto-leave effect below
 * watches the own-group signal.
 */
export function CallDock({
  connected,
  member,
  ownGroupId,
  ownName,
  getToken,
  net,
}: {
  connected: boolean;
  /**
   * Whether this client is an APPROVED member — the recording control is
   * offered to approved members only (増分④ 設計①), not merely to
   * signed-in identities: a signed-in-but-unapproved user walks under the
   * guest rules and must get the guest treatment here (surfaced by the
   * 増分④ manual test — log_group_recording refuses non-approved
   * senders, so a signedIn gate would offer a toggle whose label write
   * is refused). Cosmetic like every UI gate: the Worker 403s guest
   * bearers, and the label reducer re-checks membership server-side.
   */
  member: boolean;
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
  if (phase.kind === 'in-call') {
    // Same copy as the joining phase — the chunk download is usually
    // shorter than the dial, so reusing the string avoids inventing a
    // third transient.
    return (
      <Suspense fallback={<div style={panelStyle}>📞 通話に接続中…</div>}>
        <InCallPanel
          meeting={phase.meeting}
          recording={recordingHandlersFor(member, getToken, phase.meetingId, net)}
        />
      </Suspense>
    );
  }
  return (
    <IdlePanel
      notice={phase.notice}
      onJoin={() => void joinCall({ net, getToken, ownName, setPhase, meetingRef, joiningRef })}
    />
  );
}
