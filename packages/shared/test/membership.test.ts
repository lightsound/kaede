import { describe, expect, it } from 'vitest';
import {
  asMembership,
  decideAdmission,
  evaluateApplication,
  evaluateJoin,
  evaluateMemberAction,
  evaluateSettingChange,
  guestsAllowedFrom,
  initialMembership,
  isActingAdmin,
  type MemberAction,
  type Membership,
  membershipPrompt,
  profileNameFrom,
  statusAfter,
} from '../src';

const APPROVED_MEMBER: Membership = { status: 'approved', role: 'member' };
const PENDING_MEMBER: Membership = { status: 'pending', role: 'member' };
const REJECTED_MEMBER: Membership = { status: 'rejected', role: 'member' };
const BANNED_MEMBER: Membership = { status: 'banned', role: 'member' };
const ADMIN: Membership = { status: 'approved', role: 'admin' };
/** An admin whose own approval was somehow lost must not keep acting as one. */
const PENDING_ADMIN: Membership = { status: 'pending', role: 'admin' };

describe('asMembership', () => {
  it('passes through the recognised values', () => {
    expect(asMembership({ status: 'approved', role: 'admin' })).toEqual(ADMIN);
    expect(asMembership({ status: 'pending', role: 'member' })).toEqual(PENDING_MEMBER);
    expect(asMembership({ status: 'rejected', role: 'member' })).toEqual(REJECTED_MEMBER);
    expect(asMembership({ status: 'banned', role: 'member' })).toEqual(BANNED_MEMBER);
  });

  // Fail closed: a corrupted or future value must never widen privileges.
  it('reads any unrecognised value as the least-privileged one', () => {
    expect(asMembership({ status: 'owner', role: 'owner' })).toEqual(PENDING_MEMBER);
    expect(asMembership({ status: '', role: '' })).toEqual(PENDING_MEMBER);
  });
});

describe('initialMembership', () => {
  it('makes the very first member the approved admin', () => {
    expect(initialMembership(true)).toEqual(ADMIN);
  });

  it('makes every later applicant a pending member', () => {
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

describe('evaluateJoin / decideAdmission', () => {
  it('admits an approved member', () => {
    expect(evaluateJoin({ membership: APPROVED_MEMBER, guestsAllowed: true })).toEqual({
      ok: true,
    });
    expect(decideAdmission({ membership: APPROVED_MEMBER, guestsAllowed: true })).toBe('admitted');
  });

  it('refuses each non-approved status under its own name', () => {
    expect(evaluateJoin({ membership: PENDING_MEMBER, guestsAllowed: true })).toEqual({
      ok: false,
      reason: 'pending-approval',
    });
    expect(evaluateJoin({ membership: REJECTED_MEMBER, guestsAllowed: true })).toEqual({
      ok: false,
      reason: 'rejected',
    });
    expect(evaluateJoin({ membership: BANNED_MEMBER, guestsAllowed: true })).toEqual({
      ok: false,
      reason: 'banned',
    });
  });

  it('rules a connection without a membership by the guest setting', () => {
    expect(evaluateJoin({ membership: undefined, guestsAllowed: true })).toEqual({ ok: true });
    expect(evaluateJoin({ membership: undefined, guestsAllowed: false })).toEqual({
      ok: false,
      reason: 'guests-not-allowed',
    });
    expect(decideAdmission({ membership: undefined, guestsAllowed: false })).toBe(
      'guests-not-allowed',
    );
  });

  // Turning guests away must never lock members out of their own office.
  it('never applies the guest setting to an approved member', () => {
    expect(evaluateJoin({ membership: APPROVED_MEMBER, guestsAllowed: false })).toEqual({
      ok: true,
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
});

describe('evaluateApplication', () => {
  it('lets a member file a first application', () => {
    expect(evaluateApplication({ hasAccount: true, membership: undefined })).toEqual({ ok: true });
  });

  // Re-application after a rejection is an explicit act; allowing it is what
  // keeps a mistaken rejection from ever locking someone out.
  it('lets a rejected member re-apply', () => {
    expect(evaluateApplication({ hasAccount: true, membership: REJECTED_MEMBER })).toEqual({
      ok: true,
    });
  });

  it('refuses guests (no account to hang a membership on)', () => {
    expect(evaluateApplication({ hasAccount: false, membership: undefined })).toEqual({
      ok: false,
      reason: 'no-account',
    });
  });

  it('refuses a duplicate application', () => {
    expect(evaluateApplication({ hasAccount: true, membership: PENDING_MEMBER })).toEqual({
      ok: false,
      reason: 'already-applied',
    });
    expect(evaluateApplication({ hasAccount: true, membership: APPROVED_MEMBER })).toEqual({
      ok: false,
      reason: 'already-member',
    });
  });

  it('refuses a banned member until an admin lifts the ban', () => {
    expect(evaluateApplication({ hasAccount: true, membership: BANNED_MEMBER })).toEqual({
      ok: false,
      reason: 'banned',
    });
  });
});

describe('evaluateMemberAction', () => {
  const act = (action: MemberAction, target: Membership | undefined, actor = ADMIN) =>
    evaluateMemberAction({ actor, target, action });

  // The UI gate is cosmetic; this server-side check is the actual authority.
  it('refuses every non-admin actor', () => {
    expect(act('approve', PENDING_MEMBER, APPROVED_MEMBER)).toEqual({
      ok: false,
      reason: 'not-admin',
    });
    expect(act('approve', PENDING_MEMBER, PENDING_ADMIN)).toEqual({
      ok: false,
      reason: 'not-admin',
    });
    expect(
      evaluateMemberAction({ actor: undefined, target: PENDING_MEMBER, action: 'reject' }),
    ).toEqual({ ok: false, reason: 'not-admin' });
  });

  it('refuses acting on a membership that no longer exists', () => {
    expect(act('approve', undefined)).toEqual({ ok: false, reason: 'no-such-member' });
  });

  // Covers self-targeting too: with a single admin and no promotion path,
  // acting on an admin would leave the space unmanageable.
  it('refuses targeting an admin', () => {
    expect(act('reject', ADMIN)).toEqual({ ok: false, reason: 'target-is-admin' });
    expect(act('ban', PENDING_ADMIN)).toEqual({ ok: false, reason: 'target-is-admin' });
  });

  it('decides an application: approve, reject, or ban', () => {
    expect(act('approve', PENDING_MEMBER)).toEqual({ ok: true });
    expect(act('reject', PENDING_MEMBER)).toEqual({ ok: true });
    expect(act('ban', PENDING_MEMBER)).toEqual({ ok: true });
    expect(act('unban', PENDING_MEMBER)).toEqual({ ok: false, reason: 'invalid-transition' });
  });

  it('expels or bans an approved member, never re-approves one', () => {
    expect(act('reject', APPROVED_MEMBER)).toEqual({ ok: true });
    expect(act('ban', APPROVED_MEMBER)).toEqual({ ok: true });
    expect(act('approve', APPROVED_MEMBER)).toEqual({ ok: false, reason: 'invalid-transition' });
  });

  // Approve doubles as the recovery from a mistaken rejection or ban, so a
  // wrong click is always one action away from being undone.
  it('recovers a rejected or banned member by approving them', () => {
    expect(act('approve', REJECTED_MEMBER)).toEqual({ ok: true });
    expect(act('approve', BANNED_MEMBER)).toEqual({ ok: true });
  });

  it('escalates a rejection to a ban, and lifts a ban back to rejected', () => {
    expect(act('ban', REJECTED_MEMBER)).toEqual({ ok: true });
    expect(act('unban', BANNED_MEMBER)).toEqual({ ok: true });
    expect(statusAfter('unban')).toBe('rejected');
  });

  it('lands each action on its status', () => {
    expect(statusAfter('approve')).toBe('approved');
    expect(statusAfter('reject')).toBe('rejected');
    expect(statusAfter('ban')).toBe('banned');
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

describe('membershipPrompt', () => {
  it('offers a signed-in member without a membership the application', () => {
    expect(membershipPrompt({ signedIn: true, membership: undefined })).toBe('apply');
  });

  it('offers a rejected member the re-application', () => {
    expect(membershipPrompt({ signedIn: true, membership: REJECTED_MEMBER })).toBe('reapply');
  });

  it('offers guests nothing (they cannot apply)', () => {
    expect(membershipPrompt({ signedIn: false, membership: undefined })).toBeUndefined();
  });

  it('offers nothing when there is nothing to file', () => {
    expect(membershipPrompt({ signedIn: true, membership: PENDING_MEMBER })).toBeUndefined();
    expect(membershipPrompt({ signedIn: true, membership: APPROVED_MEMBER })).toBeUndefined();
    expect(membershipPrompt({ signedIn: true, membership: BANNED_MEMBER })).toBeUndefined();
  });
});

describe('profileNameFrom', () => {
  it('extracts and normalizes the OIDC name claim', () => {
    expect(profileNameFrom({ name: ' 楓  かえで ' })).toBe('楓 かえで');
  });

  // The Clerk JWT template may not carry the claim yet (ROADMAP), and other
  // issuers never will; the caller then leaves the profile nameless.
  it('yields nothing for a missing or non-string claim', () => {
    expect(profileNameFrom({})).toBeUndefined();
    expect(profileNameFrom({ name: 42 })).toBeUndefined();
    expect(profileNameFrom(null)).toBeUndefined();
    expect(profileNameFrom('name')).toBeUndefined();
  });

  it('yields nothing for a name the shared rules refuse', () => {
    expect(profileNameFrom({ name: '   ' })).toBeUndefined();
    expect(profileNameFrom({ name: 'x'.repeat(40) })).toBeUndefined();
  });
});
