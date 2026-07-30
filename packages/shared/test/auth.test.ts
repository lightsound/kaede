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
    expect(classifyConnection(null, policy)).toEqual({
      kind: 'guest',
      issuer: null,
      issuerRecognised: true,
    });
  });

  it('admits a host-issued token as a guest, not a member', () => {
    expect(classifyConnection(claims({ issuer: 'localhost', audience: [] }), policy)).toEqual({
      kind: 'guest',
      issuer: 'localhost',
      issuerRecognised: true,
    });
  });

  // A token our own provider minted for another application must not become a
  // member: that is how a second Clerk-backed app's users would get in as ours.
  it('rejects a token from our provider that pins another audience', () => {
    expect(classifyConnection(claims({ audience: ['some-other-app'] }), policy)).toEqual({
      kind: 'rejected',
      reason: 'audience-mismatch',
    });
  });

  it('rejects a token from our provider that pins no audience at all', () => {
    expect(classifyConnection(claims({ audience: [] }), policy)).toEqual({
      kind: 'rejected',
      reason: 'audience-mismatch',
    });
  });

  // The gate that keeps the development instance out of production: its issuer
  // is simply absent from memberIssuers, so its users are guests at most.
  it('never makes a member of an issuer outside the policy, even with our audience', () => {
    expect(classifyConnection(claims({ issuer: CLERK_DEVELOPMENT }), policy)).toEqual({
      kind: 'guest',
      issuer: CLERK_DEVELOPMENT,
      issuerRecognised: false,
    });
  });

  it('flags an issuer in neither list so the caller can report it', () => {
    const auth = classifyConnection(claims({ issuer: 'https://accounts.google.com' }), policy);
    expect(auth).toEqual({
      kind: 'guest',
      issuer: 'https://accounts.google.com',
      issuerRecognised: false,
    });
  });
});
