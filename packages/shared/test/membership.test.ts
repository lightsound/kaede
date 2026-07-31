import { describe, expect, it } from 'vitest';
import {
  asMembership,
  decideAdmission,
  evaluateApproval,
  evaluateJoin,
  evaluateRemoval,
  evaluateSettingChange,
  guestsAllowedFrom,
  initialMembership,
  isActingAdmin,
  type Membership,
} from '../src';

const APPROVED_MEMBER: Membership = { status: 'approved', role: 'member' };
const PENDING_MEMBER: Membership = { status: 'pending', role: 'member' };
const ADMIN: Membership = { status: 'approved', role: 'admin' };
/** An admin whose own approval was somehow lost must not keep acting as one. */
const PENDING_ADMIN: Membership = { status: 'pending', role: 'admin' };

describe('asMembership', () => {
  it('passes through the recognised values', () => {
    expect(asMembership({ status: 'approved', role: 'admin' })).toEqual(ADMIN);
    expect(asMembership({ status: 'pending', role: 'member' })).toEqual(PENDING_MEMBER);
  });

  // Fail closed: a corrupted or future value must never widen privileges.
  it('reads any unrecognised value as the least-privileged one', () => {
    expect(asMembership({ status: 'banned', role: 'owner' })).toEqual(PENDING_MEMBER);
    expect(asMembership({ status: '', role: '' })).toEqual(PENDING_MEMBER);
  });
});

describe('initialMembership', () => {
  it('makes the very first member the approved admin', () => {
    expect(initialMembership(true)).toEqual(ADMIN);
  });

  it('makes every later member a pending member', () => {
    expect(initialMembership(false)).toEqual(PENDING_MEMBER);
  });
});

describe('isActingAdmin', () => {
  it('requires both the role and the approval', () => {
    expect(isActingAdmin(ADMIN)).toBe(true);
    expect(isActingAdmin(PENDING_ADMIN)).toBe(false);
    expect(isActingAdmin(APPROVED_MEMBER)).toBe(false);
    expect(isActingAdmin(undefined)).toBe(false);
  });
});

describe('evaluateJoin', () => {
  it('admits an approved member', () => {
    expect(evaluateJoin({ membership: APPROVED_MEMBER, guestsAllowed: true })).toEqual({
      ok: true,
    });
  });

  it('holds a pending member in the waiting room', () => {
    expect(evaluateJoin({ membership: PENDING_MEMBER, guestsAllowed: true })).toEqual({
      ok: false,
      reason: 'pending-approval',
    });
  });

  it('admits a guest while the setting allows guests', () => {
    expect(evaluateJoin({ membership: undefined, guestsAllowed: true })).toEqual({ ok: true });
  });

  it('refuses a guest while the setting disallows guests', () => {
    expect(evaluateJoin({ membership: undefined, guestsAllowed: false })).toEqual({
      ok: false,
      reason: 'guests-not-allowed',
    });
  });

  // The setting rides a singleton row that does not exist until an admin
  // first touches it; no row must mean the default, allowed.
  it('reads a missing settings row as the default (guests allowed)', () => {
    expect(guestsAllowedFrom(undefined)).toBe(true);
    expect(guestsAllowedFrom(null)).toBe(true);
    expect(guestsAllowedFrom({ guestsAllowed: false })).toBe(false);
    expect(guestsAllowedFrom({ guestsAllowed: true })).toBe(true);
  });

  // Turning guests away must never lock members out of their own office.
  it('never applies the guest setting to a member', () => {
    expect(evaluateJoin({ membership: APPROVED_MEMBER, guestsAllowed: false })).toEqual({
      ok: true,
    });
    expect(evaluateJoin({ membership: PENDING_MEMBER, guestsAllowed: false })).toEqual({
      ok: false,
      reason: 'pending-approval',
    });
  });
});

describe('evaluateApproval', () => {
  it('lets an acting admin approve a pending member', () => {
    expect(evaluateApproval({ actor: ADMIN, target: PENDING_MEMBER })).toEqual({ ok: true });
  });

  // The UI gate is cosmetic; this server-side check is the actual authority.
  it('refuses every non-admin actor', () => {
    expect(evaluateApproval({ actor: APPROVED_MEMBER, target: PENDING_MEMBER })).toEqual({
      ok: false,
      reason: 'not-admin',
    });
    expect(evaluateApproval({ actor: PENDING_ADMIN, target: PENDING_MEMBER })).toEqual({
      ok: false,
      reason: 'not-admin',
    });
    expect(evaluateApproval({ actor: undefined, target: PENDING_MEMBER })).toEqual({
      ok: false,
      reason: 'not-admin',
    });
  });

  it('refuses approving a membership that no longer exists', () => {
    expect(evaluateApproval({ actor: ADMIN, target: undefined })).toEqual({
      ok: false,
      reason: 'no-such-member',
    });
  });

  it('refuses approving twice', () => {
    expect(evaluateApproval({ actor: ADMIN, target: APPROVED_MEMBER })).toEqual({
      ok: false,
      reason: 'already-approved',
    });
  });
});

describe('evaluateRemoval', () => {
  it('lets an acting admin remove a pending or approved member', () => {
    expect(evaluateRemoval({ actor: ADMIN, target: PENDING_MEMBER })).toEqual({ ok: true });
    expect(evaluateRemoval({ actor: ADMIN, target: APPROVED_MEMBER })).toEqual({ ok: true });
  });

  it('refuses every non-admin actor', () => {
    expect(evaluateRemoval({ actor: APPROVED_MEMBER, target: PENDING_MEMBER })).toEqual({
      ok: false,
      reason: 'not-admin',
    });
    expect(evaluateRemoval({ actor: undefined, target: PENDING_MEMBER })).toEqual({
      ok: false,
      reason: 'not-admin',
    });
  });

  it('refuses removing a membership that no longer exists', () => {
    expect(evaluateRemoval({ actor: ADMIN, target: undefined })).toEqual({
      ok: false,
      reason: 'no-such-member',
    });
  });

  // Covers self-removal too: with a single admin and no promotion path,
  // removing an admin would leave the space unmanageable.
  it('refuses removing an admin', () => {
    expect(evaluateRemoval({ actor: ADMIN, target: ADMIN })).toEqual({
      ok: false,
      reason: 'target-is-admin',
    });
    expect(evaluateRemoval({ actor: ADMIN, target: PENDING_ADMIN })).toEqual({
      ok: false,
      reason: 'target-is-admin',
    });
  });
});

describe('evaluateSettingChange', () => {
  it('lets only an acting admin change settings', () => {
    expect(evaluateSettingChange({ actor: ADMIN })).toEqual({ ok: true });
    expect(evaluateSettingChange({ actor: APPROVED_MEMBER })).toEqual({
      ok: false,
      reason: 'not-admin',
    });
    expect(evaluateSettingChange({ actor: undefined })).toEqual({
      ok: false,
      reason: 'not-admin',
    });
  });
});

describe('decideAdmission', () => {
  it('enters when the server would admit', () => {
    expect(
      decideAdmission({ membership: APPROVED_MEMBER, wasMember: true, guestsAllowed: false }),
    ).toBe('admitted');
    expect(decideAdmission({ membership: undefined, wasMember: false, guestsAllowed: true })).toBe(
      'admitted',
    );
  });

  it('waits while the membership is pending', () => {
    expect(
      decideAdmission({ membership: PENDING_MEMBER, wasMember: true, guestsAllowed: true }),
    ).toBe('pending-approval');
  });

  it('shows the refusal to a guest while guests are not admitted', () => {
    expect(decideAdmission({ membership: undefined, wasMember: false, guestsAllowed: false })).toBe(
      'guests-not-allowed',
    );
  });

  // A vanished membership means an admin removed us: reconnect and re-apply,
  // never fall through to the guest path — even while guests are admitted,
  // because the own-row-deleted auto-rejoin would otherwise slip the removed
  // member straight back into the world as a guest.
  it('re-applies when the membership this session had vanishes', () => {
    expect(decideAdmission({ membership: undefined, wasMember: true, guestsAllowed: true })).toBe(
      'reapply',
    );
    expect(decideAdmission({ membership: undefined, wasMember: true, guestsAllowed: false })).toBe(
      'reapply',
    );
  });
});
