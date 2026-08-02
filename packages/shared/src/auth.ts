/** The JWT claims the module needs to decide what a connection may become. */
export interface ConnectionClaims {
  /** The `iss` claim: which provider minted this token. */
  readonly issuer: string;
  /** The `aud` claim: which application the issuer minted it for. */
  readonly audience: readonly string[];
  /** The `sub` claim: the issuer's stable id for this user. */
  readonly subject: string;
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
 * What a connecting client is, or why it is refused. `member` is the only
 * verdict that may ever carry member privileges. `unregistered-issuer` is
 * separate from `guest` so that a token from an issuer nobody vouched for can
 * be refused (the ROADMAP Phase 1 gate, closed 2026-08-02) instead of
 * quietly slipping past a guests-not-allowed setting as a guest.
 */
export type ConnectionAuth =
  | { kind: 'member'; subject: string }
  | { kind: 'guest' }
  | { kind: 'unregistered-issuer'; issuer: string }
  | { kind: 'audience-mismatch' };

/**
 * Decides what a connecting client is, from its token alone.
 *
 * Only a token minted by one of `policy.memberIssuers` **and** pinned to
 * `policy.memberAudience` is a member: a token our own provider minted for a
 * different application yields `audience-mismatch` rather than a quiet demotion
 * to guest, since accepting it would let another Clerk-backed app's users in as
 * ours.
 *
 * A token from an issuer in neither list is `unregistered-issuer`, which
 * callers refuse: nobody vouched for that issuer, and admitting it as a guest
 * would bypass the guests-not-allowed setting. The cost is that every host we
 * deploy to must have its issuer named in `guestIssuers` first (localhost and
 * Maincloud are both registered — see the server's CONNECTION_POLICY).
 */
export function classifyConnection(
  claims: ConnectionClaims | null,
  policy: ConnectionPolicy,
): ConnectionAuth {
  if (claims === null) return { kind: 'guest' };
  if (policy.memberIssuers.includes(claims.issuer)) {
    return claims.audience.includes(policy.memberAudience)
      ? { kind: 'member', subject: claims.subject }
      : { kind: 'audience-mismatch' };
  }
  if (policy.guestIssuers.includes(claims.issuer)) return { kind: 'guest' };
  return { kind: 'unregistered-issuer', issuer: claims.issuer };
}
