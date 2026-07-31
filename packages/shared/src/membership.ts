/**
 * Membership and admission rules for the single MVP space (ROADMAP Phase 1:
 * 承認制・管理者ロール・ゲスト入場設定). Pure and shared so the server
 * reducers stay thin untestable wrappers while every rule here is
 * unit-tested — the classifyConnection / evaluateRename precedent.
 *
 * The Discord-model separation this module encodes:
 * - The **account** (global profile: display name, future belongings) is
 *   never touched by space-level actions. Rejecting or banning someone in
 *   this space must not damage what they carry across spaces.
 * - The **membership** (space_member row) is the only thing space actions
 *   move, and they only ever change its `status` — rows are never deleted,
 *   so every admin action is reversible and a mistaken rejection can always
 *   be undone from the admin panel.
 *
 * The space is implicit today (one community, one world). Multi-tenancy
 * (Phase 6) turns these rows into org-scoped rows via additive tables; the
 * verdicts below are already per-space, so only their inputs move.
 */

import { normalizeDisplayName } from './displayName';

/**
 * Where a member stands in the application flow:
 *
 * - `pending`: applied (明示的な参加申請), waiting for an admin.
 * - `approved`: admitted to the world.
 * - `rejected`: an admin turned the application down, or expelled an
 *   approved member. May re-apply (an explicit act — never automatic, so a
 *   rejection cannot bounce straight back into the pending list).
 * - `banned`: may not re-apply until an admin lifts it.
 */
export type MemberStatus = 'pending' | 'approved' | 'rejected' | 'banned';

/** What a member may do: `admin` decides applications and edits settings. */
export type MemberRole = 'member' | 'admin';

/** A member's standing in the space, as the public space_member row carries it. */
export interface Membership {
  readonly status: MemberStatus;
  readonly role: MemberRole;
}

/**
 * Narrows the raw row strings (generated bindings and the table schema type
 * them as plain strings) into the closed unions, failing closed: any value
 * this build does not recognise — a bug, or a status added by a newer module
 * — reads as the least-privileged combination, so it can never grant entry
 * or admin powers by accident.
 */
export function asMembership(row: { status: string; role: string }): Membership {
  const status =
    row.status === 'approved' || row.status === 'rejected' || row.status === 'banned'
      ? row.status
      : 'pending';
  return { status, role: row.role === 'admin' ? 'admin' : 'member' };
}

/**
 * What a newly filed application starts as. The very first member becomes
 * the approved admin; everyone after waits in the pending state.
 *
 * Why first-member seeding (and not a subject/issuer constant or a dev-only
 * seed reducer): a hardcoded subject requires knowing the production Clerk
 * user id before it exists and diverges per environment, while a seed
 * reducer is a backdoor that must be remembered and removed. First-member
 * works identically on every fresh database, and the exposure window is
 * operational, not architectural: the owner publishes the production module
 * and signs in before announcing the URL, and the public space_member table
 * makes the claimed admin verifiable at a glance. Admins cannot be targeted
 * by member actions (see evaluateMemberAction), so the space can never end
 * up admin-less.
 */
export function initialMembership(isFirstMember: boolean): Membership {
  return isFirstMember
    ? { status: 'approved', role: 'admin' }
    : { status: 'pending', role: 'member' };
}

/** True when this membership may act as an admin: approved AND holding the role. */
export function isActingAdmin(membership: Membership | undefined): boolean {
  return membership?.status === 'approved' && membership.role === 'admin';
}

/**
 * The one vocabulary for "may this client be in the world": `admitted`, or
 * why not. The same words name the server's join verdict, the client's
 * decision, and what the UI shows, so a state never gets re-spelled on its
 * way through the stack.
 */
export type Admission =
  | 'admitted'
  | 'pending-approval'
  | 'rejected'
  | 'banned'
  | 'guests-not-allowed';

/** Why a join was refused: every admission except being admitted. */
export type JoinRefusalReason = Exclude<Admission, 'admitted'>;

export type JoinVerdict = { ok: true } | { ok: false; reason: JoinRefusalReason };

/**
 * Admission check for one join request. A connection with a membership is
 * ruled by its status; one without follows the guest rules — including a
 * signed-in member who has not applied yet, who may look around under the
 * same conditions as any guest until they apply. The guest toggle
 * deliberately does not apply to approved members: turning guests away must
 * never lock members out.
 */
export function evaluateJoin(request: {
  /** The sender's membership, or undefined for a guest connection. */
  membership: Membership | undefined;
  /** The space's guest-admission setting (missing row reads as true). */
  guestsAllowed: boolean;
}): JoinVerdict {
  if (request.membership === undefined) {
    return request.guestsAllowed ? { ok: true } : { ok: false, reason: 'guests-not-allowed' };
  }
  if (request.membership.status === 'approved') return { ok: true };
  const reason =
    request.membership.status === 'pending' ? 'pending-approval' : request.membership.status;
  return { ok: false, reason };
}

/**
 * What the client should do about entering the world, decided from the same
 * subscribed state the server rules on (space_member / space_setting), so
 * the client never sends a join it can predict will be refused, and reacts
 * the moment an approval or a setting flip arrives. `admitted` means enter;
 * anything else is shown to the user.
 */
export function decideAdmission(request: {
  membership: Membership | undefined;
  guestsAllowed: boolean;
}): Admission {
  const verdict = evaluateJoin(request);
  return verdict.ok ? 'admitted' : verdict.reason;
}

/**
 * The guest-admission flag a (possibly missing) settings singleton means:
 * an absent row reads as the default, allowed. Shared so the server's join
 * rule and the client's mirror of it cannot drift on the default. Accepts
 * `null` so both SDKs' `find` results (server: null, client cache: null,
 * plain optionals: undefined) pass through without a conversion.
 */
export function guestsAllowedFrom(row: { guestsAllowed: boolean } | null | undefined): boolean {
  return row?.guestsAllowed ?? true;
}

/** Why an application (apply_for_membership) was refused. */
export type ApplicationRefusalReason =
  | 'no-account'
  | 'already-applied'
  | 'already-member'
  | 'banned';

export type ApplicationVerdict = { ok: true } | { ok: false; reason: ApplicationRefusalReason };

/**
 * Admission check for filing (or re-filing) a membership application.
 * Applying is an explicit act of the signed-in user — never a connection
 * side effect — so a rejected applicant returns to the pending list only by
 * choosing to, and a ban simply makes this verdict refuse.
 */
export function evaluateApplication(request: {
  /** Whether the sender has an account, i.e. is a signed-in member. */
  hasAccount: boolean;
  /** The sender's current membership, or undefined before the first application. */
  membership: Membership | undefined;
}): ApplicationVerdict {
  if (!request.hasAccount) return { ok: false, reason: 'no-account' };
  if (request.membership === undefined || request.membership.status === 'rejected') {
    return { ok: true };
  }
  const reason = REAPPLY_REFUSALS[request.membership.status];
  return { ok: false, reason };
}

/** Why each non-reapplicable status refuses a fresh application. */
const REAPPLY_REFUSALS = {
  pending: 'already-applied',
  approved: 'already-member',
  banned: 'banned',
} as const satisfies Record<Exclude<MemberStatus, 'rejected'>, ApplicationRefusalReason>;

/**
 * The four things an admin can do to one membership. All of them are status
 * transitions on the existing row — nothing is ever deleted — so every one
 * of them can be undone by another action:
 *
 * - `approve`: let them in. Also the recovery from a mistaken rejection or
 *   ban, which is why it is allowed from any non-approved status.
 * - `reject`: turn a pending application down, or expel an approved member.
 * - `ban`: like reject, but re-application is refused until lifted.
 * - `unban`: lift a ban back to `rejected` (may re-apply again).
 */
export type MemberAction = 'approve' | 'reject' | 'ban' | 'unban';

/** Which actions make sense from each current status. */
const ALLOWED_ACTIONS: Record<MemberStatus, readonly MemberAction[]> = {
  pending: ['approve', 'reject', 'ban'],
  approved: ['reject', 'ban'],
  rejected: ['approve', 'ban'],
  banned: ['approve', 'unban'],
};

/** The status a membership lands on after an action. */
export function statusAfter(action: MemberAction): MemberStatus {
  return STATUS_AFTER[action];
}

const STATUS_AFTER: Record<MemberAction, MemberStatus> = {
  approve: 'approved',
  reject: 'rejected',
  ban: 'banned',
  unban: 'rejected',
};

/** Why an admin action (member transition / setting change) was refused. */
export type AdminActionRefusalReason =
  | 'not-admin'
  | 'no-such-member'
  | 'target-is-admin'
  | 'invalid-transition';

export type AdminActionVerdict = { ok: true } | { ok: false; reason: AdminActionRefusalReason };

/**
 * Admission check for one admin action on one membership. Only an acting
 * admin may act; the target must still exist; admins cannot be targeted
 * (covers self-targeting too, so the space always keeps at least one admin —
 * there is no promotion path yet that could create a second one); and the
 * action must be a sensible transition from the target's current status, so
 * a stale admin UI hears that its list has drifted rather than seeing a
 * silent success.
 */
export function evaluateMemberAction(request: {
  actor: Membership | undefined;
  target: Membership | undefined;
  action: MemberAction;
}): AdminActionVerdict {
  if (!isActingAdmin(request.actor)) return { ok: false, reason: 'not-admin' };
  if (request.target === undefined) return { ok: false, reason: 'no-such-member' };
  if (request.target.role === 'admin') return { ok: false, reason: 'target-is-admin' };
  if (!ALLOWED_ACTIONS[request.target.status].includes(request.action)) {
    return { ok: false, reason: 'invalid-transition' };
  }
  return { ok: true };
}

/** Admission check for changing a space setting: acting admins only. */
export function evaluateSettingChange(request: {
  actor: Membership | undefined;
}): AdminActionVerdict {
  return isActingAdmin(request.actor) ? { ok: true } : { ok: false, reason: 'not-admin' };
}

/**
 * The application affordance the UI can offer: a first application, or a
 * re-application after a rejection.
 */
export type MembershipPrompt = 'apply' | 'reapply';

/**
 * Which application affordance the UI should offer this client, if any:
 * `apply` for a signed-in member who has not applied, `reapply` after a
 * rejection. Nothing for guests (they cannot apply), for pending or
 * approved members (nothing to file), or for banned members (the server
 * would refuse; the admission notice explains instead).
 */
export function membershipPrompt(request: {
  /** Whether this client is signed in as a member (client-side knowledge). */
  signedIn: boolean;
  membership: Membership | undefined;
}): MembershipPrompt | undefined {
  if (!request.signedIn) return undefined;
  if (request.membership === undefined) return 'apply';
  return request.membership.status === 'rejected' ? 'reapply' : undefined;
}

/**
 * The display name a member's identity provider vouches for, extracted from
 * a JWT payload (the OIDC `name` claim), normalized by the same rules every
 * other name goes through. Undefined when the claim is missing (the Clerk
 * JWT template may not carry it yet — see ROADMAP), not a string, or not a
 * usable name — the caller then simply leaves the profile nameless, exactly
 * as before.
 */
export function profileNameFrom(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const name = (payload as Record<string, unknown>).name;
  if (typeof name !== 'string') return undefined;
  const verdict = normalizeDisplayName(name);
  return verdict.ok ? verdict.name : undefined;
}
