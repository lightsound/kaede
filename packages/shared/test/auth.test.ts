import { describe, expect, it } from 'vitest';
import { type ConnectionClaims, type ConnectionPolicy, classifyConnection } from '../src';

const CLERK_PRODUCTION = 'https://clerk.example.town';
const CLERK_DEVELOPMENT = 'https://dev-instance.clerk.accounts.dev';

const policy: ConnectionPolicy = {
  memberIssuers: [CLERK_PRODUCTION],
  memberAudience: 'kaede-spacetimedb',
  guestIssuers: ['localhost'],
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

  it('admits a host-issued token as a guest, not a member', () => {
    expect(classifyConnection(claims({ issuer: 'localhost', audience: [] }), policy)).toEqual({
      kind: 'guest',
    });
  });

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

  // The gate that keeps the development instance out of production: its issuer
  // is simply absent from memberIssuers, so its users are guests at most.
  it('never makes a member of an issuer outside the policy, even with our audience', () => {
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
