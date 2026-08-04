import { describe, expect, it } from 'vitest';
import {
  type ConnectionClaims,
  type ConnectionPolicy,
  classifyConnection,
  memberIssuersFor,
} from '../src';

const CLERK_PRODUCTION = 'https://clerk.example.town';
const CLERK_DEVELOPMENT = 'https://dev-instance.clerk.accounts.dev';

// Two guest issuers, mirroring the real deployment targets: the local
// standalone host and Maincloud each mint their own guest-resume tokens.
const policy: ConnectionPolicy = {
  memberIssuers: [CLERK_PRODUCTION],
  memberAudience: 'kaede-spacetimedb',
  guestIssuers: ['localhost', 'https://auth.maincloud.example'],
};

/** Claims from our own provider, overridable per test. */
function claims(overrides: Partial<ConnectionClaims> = {}): ConnectionClaims {
  return {
    issuer: CLERK_PRODUCTION,
    audience: ['kaede-spacetimedb'],
    subject: 'user_abc',
    ...overrides,
  };
}

describe('classifyConnection', () => {
  it('admits a token from our provider pinned to our audience as a member', () => {
    expect(classifyConnection(claims(), policy)).toEqual({ kind: 'member', subject: 'user_abc' });
  });

  it('admits a tokenless connection as a guest', () => {
    expect(classifyConnection(null, policy)).toEqual({ kind: 'guest' });
  });

  // Literal issuers rather than a loop over policy.guestIssuers: trimming the
  // fixture must fail these tests, not silently shrink them.
  it.each(['localhost', 'https://auth.maincloud.example'])(
    'admits a token issued by host %s as a guest, not a member',
    (issuer) => {
      expect(classifyConnection(claims({ issuer, audience: [] }), policy)).toEqual({
        kind: 'guest',
      });
    },
  );

  // A token our own provider minted for another application must not become a
  // member: that is how a second Clerk-backed app's users would get in as ours.
  it('refuses a token from our provider that pins another audience', () => {
    expect(classifyConnection(claims({ audience: ['some-other-app'] }), policy)).toEqual({
      kind: 'audience-mismatch',
    });
  });

  it('refuses a token from our provider that pins no audience at all', () => {
    expect(classifyConnection(claims({ audience: [] }), policy)).toEqual({
      kind: 'audience-mismatch',
    });
  });

  // The gate that keeps unknown providers out entirely: an issuer in neither
  // list gets the refusal verdict (which onConnect turns into a rejection —
  // ROADMAP Phase 1 gate ②), never member and never guest.
  it('refuses an issuer outside the policy, even with our audience', () => {
    expect(classifyConnection(claims({ issuer: CLERK_DEVELOPMENT }), policy)).toEqual({
      kind: 'unregistered-issuer',
      issuer: CLERK_DEVELOPMENT,
    });
  });

  // The window ROADMAP gate ① exists to prevent: production is live while
  // the development instance is still trusted, and both mint members. This
  // is exactly the policy memberIssuersFor builds for NON-production
  // databases (see below), which is why the production database must never
  // receive it.
  it('makes members of every issuer the policy lists', () => {
    const bothInstances: ConnectionPolicy = {
      ...policy,
      memberIssuers: [CLERK_PRODUCTION, CLERK_DEVELOPMENT],
    };
    expect(classifyConnection(claims({ issuer: CLERK_DEVELOPMENT }), bothInstances)).toEqual({
      kind: 'member',
      subject: 'user_abc',
    });
    expect(classifyConnection(claims(), bothInstances)).toEqual({
      kind: 'member',
      subject: 'user_abc',
    });
  });
});

// ROADMAP Phase 1 gate ①, as a rule: which database gets to treat the
// development instance as a member mint.
describe('memberIssuersFor', () => {
  const issuers = { production: CLERK_PRODUCTION, development: CLERK_DEVELOPMENT };

  it('trusts only the production issuer on the production database', () => {
    expect(memberIssuersFor(true, issuers)).toEqual([CLERK_PRODUCTION]);
  });

  it('keeps the development issuer on every other database', () => {
    expect(memberIssuersFor(false, issuers)).toEqual([CLERK_PRODUCTION, CLERK_DEVELOPMENT]);
  });

  // The full loop: the list memberIssuersFor builds, fed through
  // classifyConnection — a dev-instance token is refused as a member by the
  // production policy (unregistered-issuer, which onConnect rejects) and
  // admitted by the local one.
  it('closes gate ① end to end: a dev token is refused on production, admitted locally', () => {
    const production: ConnectionPolicy = {
      ...policy,
      memberIssuers: memberIssuersFor(true, issuers),
    };
    const local: ConnectionPolicy = { ...policy, memberIssuers: memberIssuersFor(false, issuers) };
    const devToken = claims({ issuer: CLERK_DEVELOPMENT });
    expect(classifyConnection(devToken, production)).toEqual({
      kind: 'unregistered-issuer',
      issuer: CLERK_DEVELOPMENT,
    });
    expect(classifyConnection(devToken, local)).toEqual({ kind: 'member', subject: 'user_abc' });
    // The production issuer is a member mint on both.
    expect(classifyConnection(claims(), production)).toEqual({
      kind: 'member',
      subject: 'user_abc',
    });
  });
});
