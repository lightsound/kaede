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
  collectDmCandidates,
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
 * unit-tested in @kaede/shared — deliberately not the player_name table
 * alone, whose rows linger for the retention window (~10 minutes) after
 * their owner leaves.
 */
function dmCandidatesOf(c: DbConnection): readonly DmCandidate[] {
  return collectDmCandidates(
    [...c.db.player.iter()].map((row) => ({
      online: row.online,
      name: c.db.playerName.identity.find(row.identity)?.name,
      key: row.identity.toHexString(),
    })),
  );
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
   * Sends one accepted plan: send_chat_message for the public kind, send_dm
   * (to the identity the plan resolved) for the DM kind — the one place
   * that dispatches on the plan's kind. Success arrives as a chat_message /
   * dm_message row event; the log line (and, for public messages, the
   * speech bubble) comes from it, so the sender sees exactly what the
   * receivers received. Failures (a disconnect racing the submit, a server
   * refusal) log AND report through onRefused: the panel clears the draft
   * optimistically, so unlike the other reducers a dropped call has no
   * visible "nothing changed" signal to fall back on.
   */
  sendPlanned(plan: PlannedSend): void;
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
    sendPlanned(plan) {
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
        (c) => c.reducers.sendChatMessage({ text: plan.text }),
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
  };
}
