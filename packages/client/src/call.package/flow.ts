// The join orchestration of the call dock (ROADMAP Phase 4 増分①), pure
// over injected effects so the sequencing — and especially the
// registration race — is unit-testable (the shared-rules convention,
// applied to an async flow).

/**
 * How long to wait, after losing the registration race, for the winner's
 * group_call row to land in the subscribed cache. The row was inserted
 * BEFORE our reducer was refused (that order is why we were refused), so
 * the subscription usually already delivered it; the delay only covers
 * the tail where the row event is still in flight.
 */
const REGISTER_RETRY_DELAY_MS = 500;

/** What the flow needs injected: the net reads/calls and the Worker calls. */
export interface CallFlowDeps {
  /** NetApi.ownGroupCall — the submit-time cache read. */
  ownGroupCall(): { groupId: bigint; meetingId: string | undefined } | undefined;
  /** NetApi.registerGroupCall — rejects when the registration is refused. */
  registerGroupCall(meetingId: string): Promise<void>;
  /** api.ts provisionMeeting, with the token getter already bound. */
  provisionMeeting(): Promise<string>;
  /** api.ts mintCallToken, with token getter and display name bound. */
  mintToken(meetingId: string): Promise<string>;
  /** Injected setTimeout, so tests need no timer mocking. */
  delay(ms: number): Promise<void>;
}

/** What a successful join flow hands the provider (and the auto-leave watch). */
export interface CallTicket {
  /** The group whose call this is — the dock leaves when it stops being ours. */
  groupId: bigint;
  /** The minted participant token CallProvider.join dials with. */
  authToken: string;
}

/**
 * The registered meeting for `groupId` after this client lost the
 * registration race, or undefined when the loss was not a race after all
 * (walked out of the group mid-flow, a genuine refusal). Split from
 * acquireCallTicket so each stays under the CRAP budget.
 */
async function meetingAfterLostRace(
  deps: CallFlowDeps,
  groupId: bigint,
): Promise<string | undefined> {
  await deps.delay(REGISTER_RETRY_DELAY_MS);
  const retry = deps.ownGroupCall();
  if (retry === undefined || retry.groupId !== groupId) return undefined;
  return retry.meetingId;
}

/**
 * Acquires everything a call join needs: the group's meeting (reusing the
 * registered one, or provisioning + registering a fresh one), then the
 * participant token. Registration can race another member starting the
 * same group's call — both provision a meeting, one insert wins — and the
 * loser recovers by joining the winner's row; the loser's provisioned
 * meeting is simply never referenced (idle meetings cost nothing).
 * Everything else propagates as a rejection for the dock to surface.
 */
export async function acquireCallTicket(deps: CallFlowDeps): Promise<CallTicket> {
  const own = deps.ownGroupCall();
  if (own === undefined) throw new Error('call flow: not in a conversation group');
  let meetingId = own.meetingId;
  if (meetingId === undefined) {
    const provisioned = await deps.provisionMeeting();
    try {
      await deps.registerGroupCall(provisioned);
      // The reducer bound the meeting to the sender's CURRENT group. If the
      // membership moved between the read above and the registration
      // landing (walked into another zone mid-flow), the row belongs to
      // the new group and this ticket's groupId would lie to the
      // auto-leave watch — refuse instead of joining under a stale label
      // (a review finding); the user retries from where they now stand.
      const current = deps.ownGroupCall();
      if (current === undefined || current.groupId !== own.groupId) {
        throw new Error('call flow: left the group mid-registration');
      }
      meetingId = provisioned;
    } catch (err) {
      meetingId = await meetingAfterLostRace(deps, own.groupId);
      if (meetingId === undefined) throw err;
    }
  }
  return { groupId: own.groupId, authToken: await deps.mintToken(meetingId) };
}
