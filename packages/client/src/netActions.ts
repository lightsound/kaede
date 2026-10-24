// The App's commands to the net stack, as the plain callbacks every surface
// takes, so no surface needs to know how the App holds its net stack. Each
// one reads the handle at call time. Before the async mount finishes, and
// after the effect's cleanup disposed it, there is no Net to ask: reducer
// commands drop silently (no warning, and no onChatRefused — the surfaces
// are disabled until connected anyway), procedure calls reject with the
// error a disconnected NetApi gives, and draft planning falls back to the
// no-session rule.
import type {
  Availability,
  ChatScope,
  MemberAction,
  PlannedSend,
  ReactionEmoji,
} from '@kaede/shared';
import type { HuddleActions } from './huddle.package';
import { type Net, planChatDraftOffline, type SpaceMemberView } from './net.package';
import type { ZoneActions } from './space.package';

/**
 * The call surfaces' net adapter over the (possibly not-yet-mounted) net
 * stack — one object serves both docks (CallDock, RecordingsDock). Every
 * method is a procedure call (増分⑥), so the not-yet-mounted fallback is
 * the same rejection a disconnected NetApi produces.
 */
function callNetOf(netRef: { current: Net | undefined }) {
  const rejectUnmounted = () => Promise.reject(new Error('SpacetimeDB: not connected'));
  return {
    joinGroupCall: () => netRef.current?.joinGroupCall() ?? rejectUnmounted(),
    startGroupRecording: (groupId: bigint) =>
      netRef.current?.startGroupRecording(groupId) ?? rejectUnmounted(),
    stopGroupRecording: (groupId: bigint) =>
      netRef.current?.stopGroupRecording(groupId) ?? rejectUnmounted(),
    listRecordings: () => netRef.current?.listRecordings() ?? rejectUnmounted(),
    recordingDownloadUrl: (fileName: string) =>
      netRef.current?.recordingDownloadUrl(fileName) ?? rejectUnmounted(),
  };
}

/**
 * The chat panel's draft planner over the same possibly-absent net stack
 * (the callNetOf shape): the netRef-less fallback (mount not finished —
 * the panel is disabled then anyway) delegates to the same no-session
 * rule Net.planChatSend applies, so the rule has one home.
 */
function chatDraftPlannerOf(netRef: { current: Net | undefined }) {
  return (draft: string) => netRef.current?.planChatSend(draft) ?? planChatDraftOffline(draft);
}

/**
 * Every command the App's surfaces dispatch: the flat ones named after the
 * Net method they reach, the rest grouped the way the surfaces take them
 * (HuddleControl's actions, AdminSection's zoneActions, the call docks'
 * net). `onChatSend` runs before every chat send: useNetStack clears its
 * "send refused" trace there, since the new attempt supersedes it.
 */
export function netActionsOf(netRef: { current: Net | undefined }, onChatSend: () => void) {
  return {
    applyForMembership: () => netRef.current?.applyForMembership(),
    setDisplayName: (name: string) => netRef.current?.setDisplayName(name),
    setAvailability: (availability: Availability) => netRef.current?.setAvailability(availability),
    setStatusText: (text: string) => netRef.current?.setStatusText(text),
    call: callNetOf(netRef),
    huddle: {
      onCreateHuddle: (spec) => netRef.current?.createHuddle(spec),
      onJoinHuddle: (groupId) => netRef.current?.joinHuddle(groupId),
      onLeaveHuddle: () => netRef.current?.leaveHuddle(),
    } satisfies HuddleActions,
    zones: {
      onCreateZone: (spec) => netRef.current?.createZone(spec),
      onUpdateZone: (zoneId, edit) => netRef.current?.updateZone({ zoneId, ...edit }),
      onMoveZone: (zoneId) => netRef.current?.moveZone(zoneId),
      onDeleteZone: (zoneId) => netRef.current?.deleteZone(zoneId),
    } satisfies ZoneActions,
    memberAction: (action: MemberAction, member: SpaceMemberView) =>
      netRef.current?.memberAction(action, member.identity),
    setGuestsAllowed: (allowed: boolean) => netRef.current?.setGuestsAllowed(allowed),
    sendAnnouncement: (text: string) => netRef.current?.sendAnnouncement(text),
    planChatSend: chatDraftPlannerOf(netRef),
    sendPlanned: (plan: PlannedSend, scope: ChatScope) => {
      onChatSend();
      netRef.current?.sendPlanned(plan, scope);
    },
    sendReaction: (emoji: ReactionEmoji) => netRef.current?.sendReaction(emoji),
    playGesture: (gesture: string) => netRef.current?.playGesture(gesture),
  };
}
