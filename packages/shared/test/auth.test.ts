import { describe, expect, it } from 'vitest';
import { type ConnectionClaims, type ConnectionPolicy, classifyConnection } from '../src';

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

  // The window ROADMAP gate 1 warns about: production is live while the
  // development instance is still trusted, and both mint members.
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
