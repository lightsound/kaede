/**
 * Admission and role rules for the single MVP space (ROADMAP Phase 1: 承認制・
 * 管理者ロール・ゲスト入場設定). Pure and shared so the server reducers stay
 * thin untestable wrappers while every rule here is unit-tested — the
 * classifyConnection / evaluateRename precedent.
 *
 * The space is implicit today (one community, one world). Multi-tenancy
 * (Phase 6) turns these rows into org-scoped rows via additive tables; the
 * verdicts below are already per-space, so only their inputs move.
 */

/**
 * Where a member stands in the waiting-room flow: `pending` from first
 * connection until an admin approves, `approved` afterwards. There is no
 * `removed` status — removal deletes the membership, and the next connection
 * re-applies from scratch (a deliberate re-application, not a ban).
 */
export type MemberStatus = 'pending' | 'approved';

/** What a member may do: `admin` approves/removes members and edits settings. */
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
  return {
    status: row.status === 'approved' ? 'approved' : 'pending',
    role: row.role === 'admin' ? 'admin' : 'member',
  };
}

/**
 * What a newly created membership starts as. The very first member becomes
 * the approved admin; everyone after waits in the pending state.
 *
 * Why first-member seeding (and not a subject/issuer constant or a dev-only
 * seed reducer): a hardcoded subject requires knowing the production Clerk
 * user id before it exists and diverges per environment, while a seed
 * reducer is a backdoor that must be remembered and removed. First-member
 * works identically on every fresh database, and the exposure window is
 * operational, not architectural: the owner publishes the production module
 * and signs in before announcing the URL, and the public space_member table
 * makes the claimed admin verifiable at a glance. Admins cannot be removed
 * (see evaluateRemoval), so the space can never end up admin-less.
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
 * Why a join was refused: the member has not been approved yet, or the
 * connection has no membership and guests are currently not admitted.
 */
export type JoinRefusalReason = 'pending-approval' | 'guests-not-allowed';

export type JoinVerdict = { ok: true } | { ok: false; reason: JoinRefusalReason };

/**
 * Admission check for one join request. A connection with a membership is a
 * member (approval decides), one without is a guest (the space setting
 * decides). The guest toggle deliberately does not apply to members: turning
 * guests away must never lock members out.
 */
export function evaluateJoin(request: {
  /** The sender's membership, or undefined for a guest connection. */
  membership: Membership | undefined;
  /** The space's guest-admission setting (missing row reads as true). */
  guestsAllowed: boolean;
}): JoinVerdict {
  if (request.membership !== undefined) {
    return request.membership.status === 'approved'
      ? { ok: true }
      : { ok: false, reason: 'pending-approval' };
  }
  return request.guestsAllowed ? { ok: true } : { ok: false, reason: 'guests-not-allowed' };
}

/** Why an admin action (approve / remove / setting change) was refused. */
export type AdminActionRefusalReason =
  | 'not-admin'
  | 'no-such-member'
  | 'already-approved'
  | 'target-is-admin';

export type AdminActionVerdict = { ok: true } | { ok: false; reason: AdminActionRefusalReason };

/**
 * The shared shell of every admin action aimed at one member: the actor must
 * be an acting admin and the target must still exist; then `targetRule` adds
 * the action's own refusal, if any. Refusals are loud (never silent success)
 * so a stale admin UI hears that its list has drifted.
 */
function evaluateTargetedAdminAction(
  request: { actor: Membership | undefined; target: Membership | undefined },
  targetRule: (target: Membership) => AdminActionRefusalReason | undefined,
): AdminActionVerdict {
  if (!isActingAdmin(request.actor)) return { ok: false, reason: 'not-admin' };
  if (request.target === undefined) return { ok: false, reason: 'no-such-member' };
  const reason = targetRule(request.target);
  return reason === undefined ? { ok: true } : { ok: false, reason };
}

/** Admission check for approving a member: pending targets only, and only once. */
export function evaluateApproval(request: {
  actor: Membership | undefined;
  target: Membership | undefined;
}): AdminActionVerdict {
  return evaluateTargetedAdminAction(request, (target) =>
    target.status === 'approved' ? 'already-approved' : undefined,
  );
}

/**
 * Admission check for removing a member. Admins cannot be removed — this
 * covers self-removal too, so the space always keeps at least one admin
 * (there is no promotion path yet that could create a second one).
 */
export function evaluateRemoval(request: {
  actor: Membership | undefined;
  target: Membership | undefined;
}): AdminActionVerdict {
  return evaluateTargetedAdminAction(request, (target) =>
    target.role === 'admin' ? 'target-is-admin' : undefined,
  );
}

/** Admission check for changing a space setting: acting admins only. */
export function evaluateSettingChange(request: {
  actor: Membership | undefined;
}): AdminActionVerdict {
  return isActingAdmin(request.actor) ? { ok: true } : { ok: false, reason: 'not-admin' };
}

/**
 * What the client should do about entering the world, decided from the same
 * subscribed state the server rules on (space_member / space_setting), so the
 * client never sends a join it can predict will be refused, and reacts the
 * moment an approval or a setting flip arrives:
 *
 * - `join`: allowed in — send join (or re-join after a retention sweep).
 * - `wait-approval`: membership is pending — show the waiting room.
 * - `guest-refused`: no membership and guests are not admitted — show the
 *   refusal notice.
 * - `reapply`: this session had a membership and it vanished, i.e. an admin
 *   removed us. Reconnect: the fresh connection recreates the account and a
 *   pending membership (= a re-application). Deciding this here also stops
 *   the own-row-deleted auto-rejoin from slipping the removed member back in
 *   as a guest in the same session.
 */
export type AdmissionDecision = 'join' | 'wait-approval' | 'guest-refused' | 'reapply';

export function decideAdmission(request: {
  membership: Membership | undefined;
  /** Whether this session has ever seen its own membership row. */
  wasMember: boolean;
  guestsAllowed: boolean;
}): AdmissionDecision {
  if (request.membership === undefined && request.wasMember) return 'reapply';
  const verdict = evaluateJoin(request);
  if (verdict.ok) return 'join';
  return verdict.reason === 'pending-approval' ? 'wait-approval' : 'guest-refused';
}

/**
 * What the UI should say about an admission decision. `reapply` reads as
 * pending-approval: the reapply reconnect files a fresh pending membership,
 * so the waiting room is the truthful UI for the moment in between.
 */
export type Admission = 'admitted' | 'pending-approval' | 'guest-refused';

export function admissionOf(decision: AdmissionDecision): Admission {
  if (decision === 'join') return 'admitted';
  return decision === 'guest-refused' ? 'guest-refused' : 'pending-approval';
}
