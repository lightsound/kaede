// fallow-ignore-file coverage-gaps -- forwards user actions to live SpacetimeDB reducers; needs a running host. The rules it applies are pure and unit-tested in @kaede/shared (planChatDraft / collectDmCandidates)
/**
 * The user-action half of the Net facade (PR #32 で予告した分割の片翼):
 * every method a UI control calls, each forwarding one argument set to one
 * reducer on the CURRENT connection. Split out of sync.ts so the
 * connection lifecycle (retries, idle suspension, session wiring — what
 * sync.ts keeps) and the action surface grow independently — new posting
 * features land here without touching the state machine's shell.
 */
import {
  type Availability,
  type ChatDraftPlan,
  type ChatScope,
  chatTargetFor,
  collectDmCandidates,
  DEFAULT_MAP_ID,
  type DmCandidate,
  type MemberAction,
  type PlannedSend,
  planChatDraft,
  type ReactionEmoji,
} from '@kaede/shared';
import { Identity } from 'spacetimedb';
import type { DbConnection } from '../module_bindings';

/**
 * The draft plan while no session exists: no candidates, so public drafts
 * still classify and mentions refuse. The ONE home of the
 * "disconnected means nobody to resolve against" rule — planChatSend
 * delegates here, and the App-side fallback for the pre-mount instant
 * (when no Net exists to ask) is this same function through the package
 * index.
 */
export function planChatDraftOffline(draft: string): ChatDraftPlan {
  return planChatDraft(draft, []);
}

/**
 * Everyone a DM mention can resolve to right now, read at submit time from
 * the subscribed cache — so no state has to stream to the UI as people
 * come and go. This is only the cache projection; the eligibility rule
 * (in the world, online, named) is the pure collectDmCandidates,
 * unit-tested in @kaede/shared. Read from player_name — the space-wide
 * presence directory — NOT from `player`: since the Phase 3 AoI 絞り込み
 * the player subscription covers only the client's own map, while a DM
 * must reach anyone in the space (会話フロアが違っても届く). player_name
 * rows share the player rows' lifecycle and now mirror `online`, so the
 * rule's inputs are unchanged: rows lingering through the retention
 * window (~10 minutes after leaving) are excluded by the online flag,
 * exactly as before.
 */
function dmCandidatesOf(c: DbConnection): readonly DmCandidate[] {
  return collectDmCandidates(
    [...c.db.playerName.iter()].map((row) => ({
      online: row.online,
      name: row.name,
      key: row.identity.toHexString(),
    })),
  );
}

/**
 * The `target` column one scoped send addresses, read from the subscribed
 * cache at SUBMIT time (ROADMAP Phase 3 増分④) — the own player row's map
 * and the own group_member row's group, the same two rows the server builds
 * its context from. Undefined when the scope has no target here (会話
 * グループ while in none), which the caller turns into a refusal rather
 * than a send to somewhere else: the panel offers only scopes the selector
 * feed says exist, so this is the racing case (walking out of a zone
 * between the draft and the submit).
 *
 * Resolving here rather than in the panel is the DM candidate-resolution
 * precedent: the message addresses what the sender was looking at, and the
 * server re-verifies it against its own rows (resolveChatRoute).
 */
function chatTargetOf(c: DbConnection, scope: ChatScope): bigint | undefined {
  const identity = c.identity;
  return identity === undefined ? undefined : chatTargetFor(scope, senderContext(c, identity));
}

/**
 * Where this connection stands, as the scope rules read it. Its own
 * function so both it and chatTargetOf stay under the CRAP budget fallow
 * enforces for uncovered code (the backfillAccountName precedent).
 */
function senderContext(c: DbConnection, identity: Identity) {
  return {
    mapId: c.db.player.identity.find(identity)?.mapId ?? DEFAULT_MAP_ID,
    groupId: c.db.groupMember.identity.find(identity)?.groupId,
  };
}

/** Each member transition's generated reducer call, keyed by the shared vocabulary. */
const MEMBER_ACTION_CALLS: Record<
  MemberAction,
  (c: DbConnection, identity: Identity) => Promise<unknown>
> = {
  approve: (c, identity) => c.reducers.approveMember({ identity }),
  reject: (c, identity) => c.reducers.rejectMember({ identity }),
  ban: (c, identity) => c.reducers.banMember({ identity }),
  unban: (c, identity) => c.reducers.unbanMember({ identity }),
};

/** The user-action surface of Net (see sync.ts for the lifecycle half). */
export interface NetApi {
  /**
   * Asks the server to rename this player (set_display_name). The result
   * arrives as an own player_name row event, which is also the caller's
   * success signal. Failures (a disconnect racing the submit, a server
   * rejection) only log: the form keeps its draft, so the user can see the
   * label didn't change and resubmit.
   */
  setDisplayName(name: string): void;
  /**
   * Files (or re-files, after a rejection) this client's membership
   * application. Success arrives as the own space_member row appearing in
   * the subscription; the server refuses guests and duplicates.
   */
  applyForMembership(): void;
  /**
   * Admin actions: one member transition (MemberAction, on the identity a
   * SpaceMemberView carries) or the guest-admission setting. The server
   * re-checks that the sender is an acting admin; these methods exist for
   * the admin panel, whose gating is cosmetic. Success arrives as
   * space_member / space_setting row events (a fresh SpaceView); failures
   * only log, and the unchanged view is the visible outcome.
   */
  memberAction(action: MemberAction, member: Identity): void;
  setGuestsAllowed(allowed: boolean): void;
  /**
   * Classifies one chat draft: public message, DM (with the mention
   * resolved against who is in the world and online RIGHT NOW, read from
   * the subscribed cache), or refused. The rules are the pure planChatDraft
   * in @kaede/shared — this method only supplies the live candidate list
   * (planChatDraftOffline while disconnected, so an @mention refuses
   * rather than resolving against stale rows). The caller dispatches an
   * accepted plan through sendPlanned; splitting plan from send keeps the
   * panel's rate-limit mirror charging in between, exactly once per
   * accepted plan.
   */
  planChatSend(draft: string): ChatDraftPlan;
  /**
   * Sends one accepted plan: send_chat_message under `scope` for the public
   * kind, send_dm (to the identity the plan resolved) for the DM kind — the
   * one place that dispatches on the plan's kind. `scope` is the selector's
   * choice (全体 / このマップ / いまの会話グループ); what it addresses is
   * resolved here from the subscribed cache (chatTargetOf) and re-verified
   * server-side. A DM ignores it — an @mention is outside the scopes by
   * design (its own table, its own privacy rule).
   *
   * Success arrives as a chat_message / dm_message row event; the log line
   * (and, for public messages, the speech bubble) comes from it, so the
   * sender sees exactly what the receivers received. Failures (a disconnect
   * racing the submit, a scope that stopped existing mid-draft, a server
   * refusal) log AND report through onRefused: the panel clears the draft
   * optimistically, so unlike the other reducers a dropped call has no
   * visible "nothing changed" signal to fall back on.
   */
  sendPlanned(plan: PlannedSend, scope: ChatScope): void;
  /**
   * Posts one space-wide admin announcement (send_announcement — ROADMAP
   * Phase 3 増分④). The memberAction rule applies: the server re-checks
   * that the sender is an acting admin, so the panel's gating is cosmetic.
   * Success arrives as a chat_message row event like any other line;
   * failures only log, and the announcement simply not appearing in the
   * log is the visible outcome.
   */
  sendAnnouncement(text: string): void;
  /**
   * Posts one palette-emoji reaction (send_reaction). Success arrives as a
   * reaction row event — the badge over the sender's avatar comes from it,
   * so the sender sees exactly what everyone else received. Failures only
   * log (no onRefused counterpart): a reaction is a transient gesture,
   * so a refused send simply not appearing is feedback enough.
   */
  sendReaction(emoji: ReactionEmoji): void;
  /**
   * Sets the sender's availability (set_availability) or free-text status
   * line (set_status_text; '' clears). Success arrives as a player_status
   * row event — the line under the avatar and the control's highlight both
   * come from it, so the sender sees exactly what everyone else received.
   * Failures only log: the authoritative view simply not changing is the
   * feedback (the setDisplayName rule), and the control keeps offering the
   * retry.
   */
  setAvailability(availability: Availability): void;
  setStatusText(text: string): void;
  /**
   * The zone admin actions (ROADMAP Phase 3 増分②), for the admin panel's
   * zone section — the memberAction rule applies: the server re-checks
   * that the sender is an acting admin, the panel's gating is cosmetic.
   * Placement coordinates never ride these calls: create and move center
   * the zone on the SENDER's authoritative row server-side. Success
   * arrives as conversation_group / group_member row events (the zone
   * layer, the tags and the panel list all re-project); failures only
   * log, and the unchanged view is the visible outcome.
   */
  createZone(spec: { name: string; closed: boolean }): void;
  updateZone(spec: { zoneId: bigint; name: string; closed: boolean; w: number; h: number }): void;
  moveZone(zoneId: bigint): void;
  deleteZone(zoneId: bigint): void;
  /**
   * The huddle actions (ROADMAP Phase 3 増分③), open to everyone in the
   * world: found a huddle where the sender stands (the founding position
   * comes from the sender's authoritative row server-side — the create_zone
   * rule), join the one the control offered (the server re-rules the
   * proximity), leave the one the membership names. Success arrives as
   * conversation_group / group_member row events (the circle, the tags and
   * the control all re-project); failures only log, and the unchanged view
   * is the visible outcome.
   */
  createHuddle(spec: { name: string; closed: boolean }): void;
  joinHuddle(groupId: bigint): void;
  leaveHuddle(): void;
  /**
   * Joins the sender's conversation group's call (the join_group_call
   * procedure — ROADMAP Phase 4 増分⑥): the module resolves the group
   * from the sender's own membership, reuses or provisions the meeting
   * (racing starters resolve server-side), and returns the ticket — the
   * group the meeting was bound to (what the dock's auto-leave watch
   * compares against) and the participant token the dial uses. Rejects
   * on refusal (not in a group, rate-limited, provider failure) for the
   * dock to surface.
   */
  joinGroupCall(): Promise<{ groupId: bigint; authToken: string }>;
  /**
   * Starts / stops the cloud recording of the ticket-named group's call
   * (start_group_recording / stop_group_recording — 承認済みメンバー
   * 限定, enforced server-side; the dock's member gate is cosmetic).
   * `groupId` is the join ticket's group, so the control stays bound to
   * the call the WebRTC session is on even when the live membership has
   * already moved elsewhere; the module resolves the meeting from its
   * own group_call row and writes the label row itself. Both reject on
   * refusal; a stop with nothing to stop resolves (the benign race —
   * auto-stop, another member stopped first).
   */
  startGroupRecording(groupId: bigint): Promise<void>;
  stopGroupRecording(groupId: bigint): Promise<void>;
  /**
   * The finished recordings in the bucket, newest first, and a
   * short-lived presigned download URL for one of them (list_recordings /
   * recording_download_url — 承認済みメンバー限定, enforced server-side).
   */
  listRecordings(): Promise<RecordingFile[]>;
  recordingDownloadUrl(fileName: string): Promise<string>;
}

/** One finished recording, as the listing procedure reports it (増分④→⑥). */
export interface RecordingFile {
  fileName: string;
  /** Object size in bytes (the u64 return narrowed — far below 2^53). */
  size: number;
  /** The R2 LastModified timestamp (ISO 8601) — when the upload landed. */
  uploadedAt: string;
}

/** What forwarding user actions needs from the lifecycle owner (sync.ts). */
export interface NetApiDeps {
  /** The CURRENT connection — undefined while disconnected or suspended. */
  conn(): DbConnection | undefined;
  /** See NetHooks.onChatRefused (sync.ts). */
  onChatRefused(): void;
}

/**
 * Builds the user-action surface over the live connection the deps expose.
 */
export function createNetApi(deps: NetApiDeps): NetApi {
  /**
   * The shared shell of every user-triggered reducer call: drop with a
   * warning while disconnected, log a server refusal. Success never needs
   * handling here — it arrives as row events (see the method docs).
   * `onRefused` is for the one caller (chat) whose UI otherwise has no
   * "nothing changed" signal to fall back on; it runs on both the
   * disconnected drop and a server rejection.
   */
  function callReducer(
    name: string,
    call: (c: DbConnection) => Promise<unknown>,
    onRefused?: () => void,
  ): void {
    const c = deps.conn();
    if (!c) {
      console.warn(`SpacetimeDB: not connected, ${name} dropped`);
      onRefused?.();
      return;
    }
    call(c).catch((err: unknown) => {
      console.error(`SpacetimeDB: ${name} rejected`, err);
      onRefused?.();
    });
  }

  /**
   * Builds the common method shape: one argument forwarded to one reducer
   * through callReducer. A factory rather than five hand-written one-line
   * wrappers because those wrappers are token-identical and only grow with
   * every posting feature (chat, reaction, status…) — the exact repetition
   * the semantic clone gate exists to stop. Methods that differ (no
   * argument, two arguments, a refusal hook) stay written out.
   */
  function forward<A>(
    name: string,
    call: (c: DbConnection, arg: A) => Promise<unknown>,
  ): (arg: A) => void {
    return (arg) => callReducer(name, (c) => call(c, arg));
  }

  return {
    setDisplayName: forward('set_display_name', (c, name: string) =>
      c.reducers.setDisplayName({ name }),
    ),
    applyForMembership() {
      callReducer('apply_for_membership', (c) => c.reducers.applyForMembership({}));
    },
    memberAction(action, member) {
      callReducer(`${action}_member`, (c) => MEMBER_ACTION_CALLS[action](c, member));
    },
    setGuestsAllowed: forward('set_guests_allowed', (c, allowed: boolean) =>
      c.reducers.setGuestsAllowed({ allowed }),
    ),
    planChatSend(draft) {
      const c = deps.conn();
      return c ? planChatDraft(draft, dmCandidatesOf(c)) : planChatDraftOffline(draft);
    },
    sendPlanned(plan, scope) {
      if (plan.kind === 'dm') {
        callReducer(
          'send_dm',
          (c) =>
            c.reducers.sendDm({
              recipient: Identity.fromString(plan.recipientKey),
              text: plan.text,
            }),
          deps.onChatRefused,
        );
        return;
      }
      callReducer(
        'send_chat_message',
        (c) => {
          const target = chatTargetOf(c, scope);
          // The selector offered a scope that stopped existing between the
          // draft and the submit. Refused rather than re-scoped, so the
          // message never lands somewhere its author did not pick (the DM
          // no-fallback rule); the panel's notice tells the sender.
          if (target === undefined) {
            return Promise.reject(new Error(`no target for the ${scope} scope`));
          }
          return c.reducers.sendChatMessage({ text: plan.text, scope, target });
        },
        deps.onChatRefused,
      );
    },
    sendReaction: forward('send_reaction', (c, emoji: ReactionEmoji) =>
      c.reducers.sendReaction({ emoji }),
    ),
    setAvailability: forward('set_availability', (c, availability: Availability) =>
      c.reducers.setAvailability({ availability }),
    ),
    setStatusText: forward('set_status_text', (c, text: string) =>
      c.reducers.setStatusText({ text }),
    ),
    createZone: forward('create_zone', (c, spec: { name: string; closed: boolean }) =>
      c.reducers.createZone(spec),
    ),
    updateZone: forward(
      'update_zone',
      (c, spec: { zoneId: bigint; name: string; closed: boolean; w: number; h: number }) =>
        c.reducers.updateZone(spec),
    ),
    moveZone: forward('move_zone', (c, zoneId: bigint) => c.reducers.moveZone({ zoneId })),
    deleteZone: forward('delete_zone', (c, zoneId: bigint) => c.reducers.deleteZone({ zoneId })),
    createHuddle: forward(
      'create_huddle',
      (c, { name, closed }: { name: string; closed: boolean }) =>
        c.reducers.createHuddle({ name, closed }),
    ),
    leaveHuddle() {
      callReducer('leave_huddle', (c) => c.reducers.leaveHuddle({}));
    },
    joinHuddle: forward('join_huddle', (c, groupId: bigint) => c.reducers.joinHuddle({ groupId })),
    sendAnnouncement: forward('send_announcement', (c, text: string) =>
      c.reducers.sendAnnouncement({ text }),
    ),
    joinGroupCall() {
      const c = deps.conn();
      if (!c) return Promise.reject(new Error('SpacetimeDB: not connected'));
      return c.procedures.joinGroupCall({});
    },
    startGroupRecording(groupId) {
      const c = deps.conn();
      if (!c) return Promise.reject(new Error('SpacetimeDB: not connected'));
      return c.procedures.startGroupRecording({ groupId }).then(() => undefined);
    },
    stopGroupRecording(groupId) {
      const c = deps.conn();
      if (!c) return Promise.reject(new Error('SpacetimeDB: not connected'));
      return c.procedures.stopGroupRecording({ groupId }).then(() => undefined);
    },
    listRecordings() {
      const c = deps.conn();
      if (!c) return Promise.reject(new Error('SpacetimeDB: not connected'));
      return c.procedures.listRecordings({}).then((files) =>
        files.map((file) => ({
          fileName: file.fileName,
          size: Number(file.size),
          uploadedAt: file.uploadedAt,
        })),
      );
    },
    recordingDownloadUrl(fileName) {
      const c = deps.conn();
      if (!c) return Promise.reject(new Error('SpacetimeDB: not connected'));
      return c.procedures.recordingDownloadUrl({ fileName });
    },
  };
}
