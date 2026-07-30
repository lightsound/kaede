/** The JWT claims the module needs to decide what a connection may become. */
export interface ConnectionClaims {
  /** The `iss` claim: which provider minted this token. */
  issuer: string;
  /** The `aud` claim: which application the issuer minted it for. */
  audience: readonly string[];
  /** The `sub` claim: the issuer's stable id for this user. */
  subject: string;
}

/** Which issuers we trust, and for what. */
export interface ConnectionPolicy {
  /** Issuers we recognise as our own identity provider, so they mint members. */
  readonly memberIssuers: readonly string[];
  /** The `aud` our JWT template pins, proving the token was minted for kaede. */
  readonly memberAudience: string;
  /**
   * SpacetimeDB hosts whose own tokens we expect to see. A guest that connects
   * tokenless is handed a host-issued token and replays it to resume its
   * identity, so these are guests, not members.
   */
  readonly guestIssuers: readonly string[];
}

/**
 * How a connection authenticated. `member` is the only verdict that may ever be
 * granted member privileges; `guest` covers both tokenless entry and identities
 * we cannot attribute to our provider.
 */
export type ConnectionAuth =
  | { kind: 'member'; subject: string }
  | { kind: 'guest'; issuer: string | null; issuerRecognised: boolean }
  | { kind: 'rejected'; reason: 'audience-mismatch' };

/**
 * Decides what a connecting client is, from its token alone.
 *
 * Only a token minted by one of `policy.memberIssuers` **and** pinned to
 * `policy.memberAudience` is a member: a token our own provider minted for a
 * different application is refused outright rather than quietly demoted, since
 * accepting it would let another Clerk-backed app's users in as ours.
 *
 * Everything else is a guest. An issuer in neither list yields
 * `issuerRecognised: false`, which the caller reports: such a token is admitted
 * only because a guest holds no privileges to escalate to, and closing that
 * door means naming every host issuer we deploy to first (see ROADMAP Phase 1).
 */
export function classifyConnection(
  claims: ConnectionClaims | null,
  policy: ConnectionPolicy,
): ConnectionAuth {
  if (claims === null) return { kind: 'guest', issuer: null, issuerRecognised: true };
  if (policy.memberIssuers.includes(claims.issuer)) {
    return claims.audience.includes(policy.memberAudience)
      ? { kind: 'member', subject: claims.subject }
      : { kind: 'rejected', reason: 'audience-mismatch' };
  }
  return {
    kind: 'guest',
    issuer: claims.issuer,
    issuerRecognised: policy.guestIssuers.includes(claims.issuer),
  };
}
