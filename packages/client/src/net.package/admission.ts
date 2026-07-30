// fallow-ignore-file coverage-gaps -- wires live SpacetimeDB row events to the admission rules; needs a running host. The rules themselves (decideAdmission, evaluateJoin, asMembership, guestsAllowedFrom) are pure and unit-tested in @maple/shared
import {
  type Admission,
  type AdmissionDecision,
  asMembership,
  decideAdmission,
  guestsAllowedFrom,
  type MemberRole,
  type MemberStatus,
  type Membership,
} from '@maple/shared';
import type { Identity } from 'spacetimedb';
import type { DbConnection } from '../module_bindings';

/** The generated space_member row type (all columns). */
type SpaceMemberRow =
  ReturnType<DbConnection['db']['spaceMember']['iter']> extends Iterator<infer R> ? R : never;

/** One space_member row, shaped for the admin UI. */
export interface SpaceMemberView {
  /** The live row's identity: the target handle for approve/remove calls. */
  identity: Identity;
  /** Its hex form: the stable React key, and the fallback label. */
  idHex: string;
  /** The member's chosen name; undefined until they set one. */
  displayName: string | undefined;
  status: MemberStatus;
  role: MemberRole;
  /** When the membership was first filed, for a stable oldest-first order. */
  requestedAtMs: number;
}

/**
 * Everything membership-related the UI renders: this client's own admission
 * and standing, the space settings, and the member directory (public to all
 * clients; only admins get UI on top of it). Published on every
 * space_member / space_setting change. Not reset on disconnect — the last
 * known view holds until the next session republishes, and the UI gates
 * itself on the connection status instead.
 */
export interface SpaceView {
  admission: Admission;
  /** This client's own membership row, or undefined for guests. */
  self: SpaceMemberView | undefined;
  guestsAllowed: boolean;
  /** The whole directory, oldest membership first. */
  members: SpaceMemberView[];
}

/** What the admission wiring needs from the session that owns it. */
export interface AdmissionHooks {
  /** Reports every change of the membership / settings view. */
  onSpace(view: SpaceView): void;
  /** Admission allows being in the world: resume or join (idempotent). */
  enterWorld(): void;
  /**
   * Our membership vanished — an admin removed us. Reconnect so the fresh
   * connection files a new pending membership (= a re-application). Called
   * at most once per session.
   */
  reapply(): void;
  /** The session's dispose guard; row events refuse to run once true. */
  isDisposed(): boolean;
}

/**
 * Owns admission for one session (承認制 / ゲスト入場設定): mirrors the
 * server's join rule over the subscribed space_member / space_setting rows,
 * reports every change through `onSpace`, and acts on the own decision —
 * enter when admitted, reconnect when removed. The caller runs `reevaluate`
 * once after seeding and again when its own player row is deleted, so
 * approvals, setting flips, kicks and retention sweeps all funnel through
 * one rule.
 *
 * Consistency note: the SDK applies a whole transaction to the row cache
 * before dispatching any of its callbacks, so when a removal deletes our
 * player row and our membership together, the decision — from whichever
 * callback runs it first — already sees both gone and lands on `reapply`,
 * never on a rejoin-as-guest in between.
 */
export function wireAdmission(
  c: DbConnection,
  myIdentity: Identity,
  hooks: AdmissionHooks,
): { reevaluate(): void } {
  // Whether this session has seen its own membership row: its later absence
  // then means an admin removed us (decideAdmission's `reapply`), not that
  // we are a guest.
  let wasMember = false;
  // The reapply reconnect must fire once, though several row deletions
  // (membership, own player row) each re-evaluate.
  let reapplied = false;

  const guestsAllowedNow = (): boolean =>
    guestsAllowedFrom(c.db.spaceSetting.id.find(0) ?? undefined);

  const viewOf = (row: SpaceMemberRow): SpaceMemberView => ({
    identity: row.identity,
    idHex: row.identity.toHexString(),
    displayName: row.displayName,
    ...asMembership(row),
    requestedAtMs: Number(row.requestedAt.toMillis()),
  });

  const buildSpaceView = (admission: Admission): SpaceView => {
    let self: SpaceMemberView | undefined;
    const members: SpaceMemberView[] = [];
    for (const row of c.db.spaceMember.iter()) {
      const view = viewOf(row);
      members.push(view);
      if (row.identity.isEqual(myIdentity)) self = view;
    }
    members.sort((a, b) => a.requestedAtMs - b.requestedAtMs);
    return { admission, self, guestsAllowed: guestsAllowedNow(), members };
  };

  const act = (decision: AdmissionDecision): void => {
    if (decision === 'admitted') {
      hooks.enterWorld();
      return;
    }
    if (decision === 'reapply' && !reapplied) {
      reapplied = true;
      hooks.reapply();
    }
  };

  const reevaluate = (): void => {
    const memberRow = c.db.spaceMember.identity.find(myIdentity);
    const membership: Membership | undefined = memberRow ? asMembership(memberRow) : undefined;
    wasMember ||= membership !== undefined;
    const decision = decideAdmission({ membership, wasMember, guestsAllowed: guestsAllowedNow() });
    // A reapply shows as the waiting room: the reconnect it triggers files a
    // fresh pending membership, so that is the truthful UI for the moment
    // in between.
    hooks.onSpace(buildSpaceView(decision === 'reapply' ? 'pending-approval' : decision));
    act(decision);
  };

  // Membership and settings drive admission and the admin panel; every
  // change re-runs the one admission rule and republishes the view.
  const rerun = (): void => {
    if (hooks.isDisposed()) return;
    reevaluate();
  };
  c.db.spaceMember.onInsert(rerun);
  c.db.spaceMember.onUpdate(rerun);
  c.db.spaceMember.onDelete(rerun);
  c.db.spaceSetting.onInsert(rerun);
  c.db.spaceSetting.onUpdate(rerun);
  c.db.spaceSetting.onDelete(rerun);

  return { reevaluate };
}
