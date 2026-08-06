// fallow-ignore-file coverage-gaps -- a React component that mounts the canvas and renders connection status; needs a DOM, and no DOM test environment is configured
import { DEFAULT_STATUS, membershipPrompt, type StatusView } from '@kaede/shared';
import { type CSSProperties, useContext, useEffect, useRef, useState } from 'react';
import { AuthSessionContext } from './auth.package';
import { CallDock, RecordingsPanel } from './call.package';
import { ChatPanel } from './chat.package';
import { createGameApp, type GameApp } from './game.package';
import { HuddleControl } from './huddle.package';
import {
  type AuthTokenGetter,
  type CallRecordingView,
  type ChatLog,
  type ChatScopeView,
  type ConnectionStatus,
  type HuddleView,
  type Net,
  planChatDraftOffline,
  type SpaceView,
  startNet,
  type ZoneAdminView,
} from './net.package';
import { dmNotifier } from './notify.package';
import { RenameControl } from './profile.package';
import { AdminSection, AdmissionOverlay, ApplyBanner } from './space.package';
import { StatusControl } from './status.package';
import { UI_FONT, UI_GOLD_BORDER, UI_PANEL_BG, UI_TEXT_COLOR } from './theme';

const STATUS_MESSAGES: Record<Exclude<ConnectionStatus, 'connected'>, string> = {
  connecting: 'サーバーに接続中…',
  reconnecting: '接続が切れました。再接続しています…',
  idle: '離席中のため接続を休止しています。キーボードかマウスの操作で再開します',
};

const overlayStyle: CSSProperties = {
  position: 'absolute',
  top: 12,
  left: '50%',
  transform: 'translateX(-50%)',
  padding: '6px 14px',
  borderRadius: 999,
  background: UI_PANEL_BG,
  border: UI_GOLD_BORDER,
  color: UI_TEXT_COLOR,
  font: UI_FONT,
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
};

/**
 * The application affordance for this client, from the space view (see
 * membershipPrompt). `anyMemberRow` mirrors the server's admin seed
 * condition over the public directory — every status counts. Before the
 * first report there is no admission either, so no surface renders the
 * fallback prompt.
 */
function promptFor(signedIn: boolean, space: SpaceView | undefined) {
  return membershipPrompt({
    signedIn,
    membership: space?.self,
    anyMemberRow: space !== undefined && space.members.length > 0,
  });
}

/** Connection-status pill; hidden while connected. Split for App's CRAP. */
function ConnectionBanner({ status }: { status: ConnectionStatus }) {
  if (status === 'connected') return null;
  return <div style={overlayStyle}>{STATUS_MESSAGES[status]}</div>;
}

/**
 * Approved-member recording catalog gate (増分④). Split from App so the
 * connected ∧ approved ∧ list branching stays under the CRAP / cognitive
 * budget (the ChatPanel LineMark precedent).
 */
function ApprovedRecordingsPanel({
  connected,
  selfStatus,
  recordings,
  getToken,
}: {
  connected: boolean;
  selfStatus: string | undefined;
  recordings: CallRecordingView[];
  getToken: AuthTokenGetter;
}) {
  if (!connected || selfStatus !== 'approved') return null;
  return <RecordingsPanel recordings={recordings} getToken={getToken} />;
}

/** Call-dock net facade over the live Net handle. Split for App's CRAP. */
function callDockNetOf(netRef: { current: Net | undefined }) {
  return {
    ownGroupCall: () => netRef.current?.ownGroupCall(),
    registerGroupCall: (meetingId: string) =>
      netRef.current?.registerGroupCall(meetingId) ??
      Promise.reject(new Error('SpacetimeDB: not connected')),
    registerCallRecording: (args: {
      recordingId: string;
      meetingId: string;
      startedAtMs: bigint;
    }) => netRef.current?.registerCallRecording(args),
  };
}

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  // The authoritative display name from the own player row; undefined
  // whenever no row is known to exist (before the first spawn, during a
  // reconnect, after a retention sweep — see startNet's onOwnName contract).
  // While undefined a rename has nowhere to land (the server would refuse it
  // as no-target), so the form stays disabled.
  const [ownName, setOwnName] = useState<string>();
  // Everything membership-related (own admission, roster, guest setting),
  // published by the net stack on every space_member / space_setting change;
  // undefined until the first session reports. Held as one value so the
  // overlays and the admin panel can never disagree about the same instant.
  const [space, setSpace] = useState<SpaceView>();
  // The global-scope chat history, published whole by the net stack on
  // every chat_message change (seed and row events alike).
  const [chatLog, setChatLog] = useState<ChatLog>([]);
  // True after a send was dropped or refused server-side (onChatRefused) —
  // the panel clears its draft optimistically, so this is the only trace
  // the sender gets. Cleared by the next send attempt.
  const [chatSendRefused, setChatSendRefused] = useState(false);
  // The authoritative own status (ステータス手動切替), published by the net
  // stack on session entry and every own player_status change. Never
  // undefined: a missing row IS the default status.
  const [ownStatus, setOwnStatus] = useState<StatusView>(DEFAULT_STATUS);
  // The meeting-room zones (every map), published by the net stack on every
  // conversation_group change — the admin panel's zone section renders it.
  const [zones, setZones] = useState<ZoneAdminView[]>([]);
  // The huddle control's answer (own huddle / joinable huddle / neither),
  // published deduplicated by the net stack (ROADMAP Phase 3 増分③).
  const [huddle, setHuddle] = useState<HuddleView>({ own: undefined, joinable: undefined });
  // Which chat scopes a send may address right now (全体 / このマップ /
  // いまの会話グループ), published deduplicated by the net stack (ROADMAP
  // Phase 3 増分④). Empty until the first session reports; the panel is
  // disabled until then anyway.
  const [chatScopes, setChatScopes] = useState<ChatScopeView>([]);
  // The conversation group this client is in (or undefined), published
  // deduplicated by the net stack (ROADMAP Phase 4 増分①) — the call
  // dock's offer and its auto-leave watch both ride it.
  const [ownGroupId, setOwnGroupId] = useState<bigint>();
  // Recording catalog (ROADMAP Phase 4 増分④) — approved members only under
  // RLS; guests keep the empty default.
  const [recordings, setRecordings] = useState<CallRecordingView[]>([]);
  const session = useContext(AuthSessionContext);
  // The one handle on the net stack: created inside the effect, disposed by
  // its cleanup, read by the name form at submit time. A ref rather than
  // state because nothing needs to re-render when it changes.
  const netRef = useRef<Net>(undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let game: GameApp | undefined;
    let cancelled = false;

    void (async () => {
      const created = await createGameApp(host);
      // The effect may have been torn down (StrictMode double-invoke) while we
      // were awaiting init; if so, dispose immediately and never mount.
      if (cancelled) {
        created.destroy();
        return;
      }
      game = created;
      netRef.current = startNet(created, session.getToken, {
        onStatus: setStatus,
        onOwnName: setOwnName,
        onSpace: setSpace,
        onChat: setChatLog,
        onChatRefused: () => setChatSendRefused(true),
        onOwnStatus: setOwnStatus,
        onZones: setZones,
        onHuddle: setHuddle,
        onChatScopes: setChatScopes,
        onOwnGroup: setOwnGroupId,
        onCallRecordings: setRecordings,
        // The DM → browser-notification pipeline: the notifier decides
        // (shouldNotifyDm) and raises; nothing app-side needs to re-render,
        // so no state rides this hook.
        onDmRow: (event) => dmNotifier().onDmRow(event),
      });
    })();

    return () => {
      cancelled = true;
      netRef.current?.dispose();
      netRef.current = undefined;
      game?.destroy();
    };
  }, [session]);

  // The admission notice and the admin panel gate themselves on `connected`:
  // while disconnected the subscribed rows are stale, so the connection
  // overlay speaks and the rest hides until the next session republishes.
  const connected = status === 'connected';
  const admission = space?.admission;
  const self = space?.self;
  // Whether to offer this client the membership application (join is an
  // explicit act — see membershipPrompt): as a button on the blocking
  // notice, or as a banner while walking around under the guest rules.
  const prompt = promptFor(session.signedIn, space);
  const apply = () => netRef.current?.applyForMembership();

  return (
    <div style={{ position: 'relative' }}>
      <div ref={hostRef} />
      <AdmissionOverlay
        connected={connected}
        admission={admission}
        prompt={prompt}
        onApply={apply}
      />
      <ConnectionBanner status={status} />
      <ApplyBanner connected={connected} admission={admission} prompt={prompt} onApply={apply} />
      <RenameControl
        connected={connected}
        ownName={ownName}
        self={self}
        onSubmit={(name) => netRef.current?.setDisplayName(name)}
      />
      <StatusControl
        connected={connected}
        ownName={ownName}
        status={ownStatus}
        onSetAvailability={(availability) => netRef.current?.setAvailability(availability)}
        onSetStatusText={(text) => netRef.current?.setStatusText(text)}
      />
      <CallDock
        connected={connected}
        ownGroupId={ownGroupId}
        ownName={ownName}
        getToken={session.getToken}
        net={callDockNetOf(netRef)}
      />
      <ApprovedRecordingsPanel
        connected={connected}
        selfStatus={self?.status}
        recordings={recordings}
        getToken={session.getToken}
      />
      <HuddleControl
        connected={connected}
        ownName={ownName}
        view={huddle}
        actions={{
          onCreateHuddle: (spec) => netRef.current?.createHuddle(spec),
          onJoinHuddle: (groupId) => netRef.current?.joinHuddle(groupId),
          onLeaveHuddle: () => netRef.current?.leaveHuddle(),
        }}
      />
      <AdminSection
        connected={connected}
        space={space}
        zones={zones}
        zoneActions={{
          onCreateZone: (spec) => netRef.current?.createZone(spec),
          onUpdateZone: (zoneId, edit) => netRef.current?.updateZone({ zoneId, ...edit }),
          onMoveZone: (zoneId) => netRef.current?.moveZone(zoneId),
          onDeleteZone: (zoneId) => netRef.current?.deleteZone(zoneId),
        }}
        onMemberAction={(action, member) => netRef.current?.memberAction(action, member.identity)}
        onGuestsAllowedChange={(allowed) => netRef.current?.setGuestsAllowed(allowed)}
        onSendAnnouncement={(text) => netRef.current?.sendAnnouncement(text)}
      />
      <ChatPanel
        connected={connected}
        ownName={ownName}
        log={chatLog}
        scopes={chatScopes}
        sendRefused={chatSendRefused}
        // The netRef-less fallback (mount not finished — the panel is
        // disabled then anyway) delegates to the same no-session rule
        // Net.planChatSend applies, so the rule has one home.
        planDraft={(draft) => netRef.current?.planChatSend(draft) ?? planChatDraftOffline(draft)}
        onSendPlan={(plan, scope) => {
          setChatSendRefused(false);
          netRef.current?.sendPlanned(plan, scope);
        }}
        onSendReaction={(emoji) => netRef.current?.sendReaction(emoji)}
      />
    </div>
  );
}
