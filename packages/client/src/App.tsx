// fallow-ignore-file coverage-gaps -- a React component that lays the surfaces out over the canvas and renders connection status; needs a DOM, and no DOM test environment is configured. Its commands to the net stack are netActions.ts, and the gates it renders by sit with their surfaces (call.package's recordingAccess.ts, space.package's applyPrompt.ts); all three are unit-tested
import { type CSSProperties, useContext } from 'react';
import { AuthSessionContext } from './auth.package';
import { approvedMember, CallDock, RecordingsDock, recordingsDockVisible } from './call.package';
import { ChatPanel } from './chat.package';
import { HuddleControl } from './huddle.package';
import type { ConnectionStatus } from './net.package';
import { DevPerfHud } from './perf.package';
import { RenameControl } from './profile.package';
import { AdminSection, AdmissionOverlay, ApplyBanner, promptFor } from './space.package';
import { StatusControl } from './status.package';
import { UI_FONT, UI_GOLD_BORDER, UI_PANEL_BG, UI_TEXT_COLOR } from './theme';
import { useNetStack } from './useNetStack';

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

export function App() {
  const session = useContext(AuthSessionContext);
  // What the net stack publishes, and the commands that reach it
  // (useNetStack). App only decides which surface goes where.
  const {
    hostRef,
    status,
    ownName,
    space,
    chatLog,
    chatSendRefused,
    ownStatus,
    zones,
    huddle,
    chatScopes,
    ownGroupId,
    recordings,
    actions,
  } = useNetStack();

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

  return (
    <div style={{ position: 'relative' }}>
      <div ref={hostRef} />
      <DevPerfHud />
      <AdmissionOverlay
        connected={connected}
        admission={admission}
        prompt={prompt}
        onApply={actions.applyForMembership}
      />
      {status !== 'connected' && <div style={overlayStyle}>{STATUS_MESSAGES[status]}</div>}
      <ApplyBanner
        connected={connected}
        admission={admission}
        prompt={prompt}
        onApply={actions.applyForMembership}
      />
      <RenameControl
        connected={connected}
        ownName={ownName}
        self={self}
        onSubmit={actions.setDisplayName}
      />
      <StatusControl
        connected={connected}
        ownName={ownName}
        status={ownStatus}
        onSetAvailability={actions.setAvailability}
        onSetStatusText={actions.setStatusText}
      />
      <CallDock
        connected={connected}
        member={approvedMember(session.signedIn, space)}
        ownGroupId={ownGroupId}
        net={actions.call}
      />
      <RecordingsDock
        visible={recordingsDockVisible(connected, session.signedIn, space)}
        net={actions.call}
        labels={recordings}
      />
      <HuddleControl
        connected={connected}
        ownName={ownName}
        view={huddle}
        actions={actions.huddle}
      />
      <AdminSection
        connected={connected}
        space={space}
        zones={zones}
        zoneActions={actions.zones}
        onMemberAction={actions.memberAction}
        onGuestsAllowedChange={actions.setGuestsAllowed}
        onSendAnnouncement={actions.sendAnnouncement}
      />
      <ChatPanel
        connected={connected}
        ownName={ownName}
        log={chatLog}
        scopes={chatScopes}
        sendRefused={chatSendRefused}
        planDraft={actions.planChatSend}
        onSendPlan={actions.sendPlanned}
        onSendReaction={actions.sendReaction}
        onPlayGesture={actions.playGesture}
      />
    </div>
  );
}
