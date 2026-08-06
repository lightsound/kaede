// fallow-ignore-file coverage-gaps -- a thin wrapper over jose's remote-JWKS verification; needs the issuer's live JWKS endpoint, not a unit test. The request-level rules around it (routing, origins, naming) live in rules.ts and are unit-tested
import { createRemoteJWKSet, jwtVerify } from 'jose';

/**
 * One JWKS fetcher per issuer, cached for the isolate's life: jose caches
 * the key set and re-fetches on unknown-kid, so steady-state verification
 * costs no network round-trips.
 */
const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwksByIssuer.get(issuer);
  if (cached) return cached;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  jwksByIssuer.set(issuer, jwks);
  return jwks;
}

/**
 * Verifies the caller is a signed-in member and returns the token's
 * subject (the Clerk user id — what participant minting records as
 * custom_participant_id), or undefined for anything unverifiable.
 *
 * The token is the SAME Clerk JWT the client mints for SpacetimeDB
 * connections (the `spacetimedb` template): one issuer, one audience, one
 * trust domain — the Worker checks the same issuer+audience pair the
 * module's connection policy pins, so "may call this API" and "is a
 * member-issuer identity" cannot drift apart. Guests carry a SpacetimeDB
 * host-issued token instead, verified by the sibling path in
 * spacetime.ts (増分② — the lift of 増分①'s members-only cut); the
 * issuer dispatch between the two is callerKindOf in rules.ts.
 */
export async function verifiedMemberSubject(
  token: string,
  issuer: string,
  audience: string,
): Promise<string | undefined> {
  try {
    const { payload } = await jwtVerify(token, jwksFor(issuer), {
      issuer,
      audience,
    });
    return subjectOf(payload.sub);
  } catch {
    return undefined;
  }
}

/** The verified subject, or undefined for a token that somehow carries none. */
function subjectOf(sub: unknown): string | undefined {
  return typeof sub === 'string' ? sub : undefined;
}
