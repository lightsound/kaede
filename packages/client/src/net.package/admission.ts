// fallow-ignore-file coverage-gaps -- wires live SpacetimeDB row events to the admission rules; needs a running host. The rules themselves (decideAdmission, evaluateJoin, asMembership, guestsAllowedFrom) are pure and unit-tested in @kaede/shared
import {
  type Admission,
  asMembership,
  decideAdmission,
  guestsAllowedFrom,
  type MemberRole,
  type MemberStatus,
} from '@kaede/shared';
import type { Identity } from 'spacetimedb';
import type { DbConnection } from '../module_bindings';
import type { RowOf } from './rows';

/** The generated space_member row type (all columns). */
type SpaceMemberRow = RowOf<'spaceMember'>;

/** One space_member row, shaped for the admin UI. */
export interface SpaceMemberView {
  /** The live row's identity: the target handle for the admin actions. */
  identity: Identity;
  /** Its hex form: the stable React key, and the fallback label. */
  idHex: string;
  /** The member's chosen name; undefined until they set one. */
  displayName: string | undefined;
  status: MemberStatus;
  role: MemberRole;
  /** When the latest application was filed, for a stable oldest-first order. */
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
   * True once this session's events must be ignored — the stack is torn
   * down, or a newer session has replaced this one (e.g. after an idle
   * suspension). Row events refuse to run once true.
   */
  isStale(): boolean;
}

/**
 * Owns admission for one session (承認制 / ゲスト入場設定): mirrors the
 * server's join rule over the subscribed space_member / space_setting rows,
 * reports every change through `onSpace`, and enters the world the moment
 * the rules allow it. The caller runs `reevaluate` once after seeding and
 * again when its own player row is deleted, so approvals, re-applications,
 * setting flips, expulsions and retention sweeps all funnel through one
 * rule. An expulsion needs nothing special here: the membership row flips
 * to rejected (rows are never deleted) and the same transaction removes the
 * player row, so the re-evaluation simply lands on the refusal and shows it.
 */
export function wireAdmission(
  c: DbConnection,
  myIdentity: Identity,
  hooks: AdmissionHooks,
): { reevaluate(): void } {
  const guestsAllowedNow = (): boolean => guestsAllowedFrom(c.db.spaceSetting.id.find(0));

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

  const reevaluate = (): void => {
    const memberRow = c.db.spaceMember.identity.find(myIdentity);
    const admission = decideAdmission({
      membership: memberRow ? asMembership(memberRow) : undefined,
      guestsAllowed: guestsAllowedNow(),
    });
    hooks.onSpace(buildSpaceView(admission));
    if (admission === 'admitted') hooks.enterWorld();
  };

  // Membership and settings drive admission and the admin panel; every
  // change re-runs the one admission rule and republishes the view.
  const rerun = (): void => {
    if (hooks.isStale()) return;
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
