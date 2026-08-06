// fallow-ignore-file coverage-gaps -- a React control over the call flow; needs a DOM and WebRTC, and no DOM test environment is configured. The join and race rules live server-side in the join_group_call procedure (増分⑥); the UI Kit panel is InCallPanel.tsx (lazy-loaded)
import { type CSSProperties, lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  UI_BUTTON_BG,
  UI_ERROR_COLOR,
  UI_FONT,
  UI_GOLD_BORDER,
  UI_PANEL_BG,
  UI_TEXT_COLOR,
} from '../theme';
import { blurringClick } from '../ui.package';
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
  | { kind: 'in-call'; groupId: bigint; meeting: Meeting };

/**
 * Whether the dock renders nothing: disconnected, or out of every
 * conversation group. Guests are offered the dock like members (増分②;
 * since 増分⑥ the join_group_call procedure admits every in-world
 * ctx.sender). An ONGOING call always renders — the WebRTC session is
 * independent of the SpacetimeDB connection, so a reconnect blip must not
 * hide a live mic/camera with no way to leave it (the session outliving
 * its UI was a review finding); sign-out needs no case here because the
 * auth remount unmounts the dock, whose cleanup leaves the call. Split
 * from the component to keep both under the CRAP budget.
 */
function dockHidden(connected: boolean, ownGroupId: bigint | undefined, phase: CallPhase): boolean {
  if (phase.kind === 'in-call') return false;
  return !connected || ownGroupId === undefined;
}

/** What the dock calls on the net facade (the HuddleActions shape). */
export interface CallDockNet {
  /** NetApi.joinGroupCall — the whole 増分⑥ join procedure. */
  joinGroupCall(): Promise<{ groupId: bigint; authToken: string }>;
  /** NetApi.startGroupRecording / stopGroupRecording (増分④→⑥). */
  startGroupRecording(groupId: bigint): Promise<void>;
  stopGroupRecording(groupId: bigint): Promise<void>;
}

/** Everything the join sequence below needs from the mounted dock. */
interface JoinContext {
  net: CallDockNet;
  setPhase: (update: (current: CallPhase) => CallPhase) => void;
  meetingRef: { current: Meeting | undefined };
  /** The in-flight latch: a double-click must not start two pipelines. */
  joiningRef: { current: boolean };
}

/**
 * The whole join sequence: ask the module for the ticket (join_group_call
 * — provisioning and binding the meeting when the group has none, racing
 * starters resolved server-side, 増分⑥ D4), dial in, and hand the live
 * meeting to the in-call phase. Failures land back in the idle phase with
 * a notice; the dial's onEnded resets the phase on every exit path (own
 * leave, kick, meeting end).
 */
async function joinCall(ctx: JoinContext): Promise<void> {
  // The latch, ref-based because two clicks can land before React renders
  // the joining phase (a review finding): the second becomes a no-op
  // instead of a parallel pipeline whose meeting nothing would track.
  if (ctx.joiningRef.current) return;
  ctx.joiningRef.current = true;
  ctx.setPhase(() => ({ kind: 'joining' }));
  try {
    const ticket = await ctx.net.joinGroupCall();
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
    // The ticket names the group the module actually bound the meeting to
    // (re-resolved server-side); if the user walked elsewhere mid-dial,
    // the auto-leave watch below sees the mismatch and leaves at once.
    ctx.setPhase(() => ({ kind: 'in-call', groupId: ticket.groupId, meeting }));
  } catch (err) {
    console.error('call join failed', err);
    ctx.setPhase(() => ({ kind: 'idle', notice: '通話に参加できませんでした' }));
  } finally {
    ctx.joiningRef.current = false;
  }
}

/**
 * The member-only recording control the in-call panel renders (増分④), or
 * undefined for guests. Since 増分⑥ both handlers name only the ticket's
 * GROUP: the module resolves the meeting from its own group_call row and
 * writes the label row itself, so the dock keeps no meeting id and no
 * label write. The group must come from the ticket, not the live
 * membership: in the auto-leave window (walked away, teardown pending)
 * the membership already names elsewhere, and a control clicked there
 * must still address the call the session is on. The gate is cosmetic
 * like every UI gate — the procedures re-check approved membership
 * server-side.
 */
function recordingHandlersFor(
  member: boolean,
  groupId: bigint,
  net: CallDockNet,
): RecordingHandlers | undefined {
  if (!member) return undefined;
  return {
    start: () => net.startGroupRecording(groupId),
    stop: () => net.stopGroupRecording(groupId),
  };
}

/**
 * The call dock (ROADMAP Phase 4 増分①〜⑥): joins the conversation
 * group's call — the join_group_call procedure provisions and binds the
 * meeting when the group has none — and renders the ongoing call with the
 * UI Kit's prebuilt parts (lazy InCallPanel). Offered to everyone in a
 * conversation group, guests included; outside a group there is no call
 * to join. Leaving the group in any way (walking off, switching, getting
 * swept) ends the participation: the auto-leave effect below watches the
 * own-group signal.
 */
export function CallDock({
  connected,
  member,
  ownGroupId,
  net,
}: {
  connected: boolean;
  /**
   * Whether this client is an APPROVED member — the recording control is
   * offered to approved members only (増分④ 設計①), not merely to
   * signed-in identities: a signed-in-but-unapproved user walks under the
   * guest rules and must get the guest treatment here. Cosmetic like
   * every UI gate: the recording procedures re-check approval
   * server-side.
   */
  member: boolean;
  /** The own-group signal (NetHooks.onOwnGroup). */
  ownGroupId: bigint | undefined;
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
          recording={recordingHandlersFor(member, phase.groupId, net)}
        />
      </Suspense>
    );
  }
  return (
    <IdlePanel
      notice={phase.notice}
      onJoin={() => void joinCall({ net, setPhase, meetingRef, joiningRef })}
    />
  );
}
