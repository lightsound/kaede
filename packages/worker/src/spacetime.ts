// fallow-ignore-file coverage-gaps -- a thin wrapper over jose signature verification against the SpacetimeDB host's live public key; needs the running host, not a unit test. The claims rules (issuer set, audience, exp-null handling, subject choice) live in rules.ts and are unit-tested
import { compactVerify, importSPKI } from 'jose';
import { guestSubjectFrom } from './rules';

/**
 * One imported host key per host URL, cached for the isolate's life (the
 * clerk.ts JWKS-cache shape). The host key endpoint serves a bare SPKI
 * PEM, not a JWKS — SpacetimeDB hosts expose no JWKS document
 * (live-probed 2026-08-05), so this is the 「同じ JWKS 方式」 the ROADMAP
 * planned, adapted to what the host actually serves. A rotated host key
 * heals on isolate turnover; a FAILED fetch is evicted immediately so the
 * next request retries instead of failing forever.
 */
const keyByHost = new Map<string, Promise<CryptoKey>>();

function keyFor(hostUrl: string): Promise<CryptoKey> {
  const cached = keyByHost.get(hostUrl);
  if (cached) return cached;
  const key = (async () => {
    // fallow-ignore-next-line security-sink -- the host is the SPACETIME_HOST_URL deploy-time binding (infra/alchemy.run.ts / .dev.vars), never request-derived
    const response = await fetch(`${hostUrl}/v1/identity/public-key`);
    if (!response.ok) {
      throw new Error(`SpacetimeDB public key fetch failed (${response.status})`);
    }
    return importSPKI((await response.text()).trim(), 'ES256');
  })();
  keyByHost.set(hostUrl, key);
  key.catch(() => keyByHost.delete(hostUrl));
  return key;
}

/**
 * Verifies a SpacetimeDB host-issued guest token and returns its subject
 * (the guest's Identity hex — see guestSubjectFrom), or undefined for
 * anything unverifiable. The 増分② guest path: a guest's SpacetimeDB
 * session token — the same one its connection resumes on — proves it
 * holds an identity minted by OUR host, which is the trust level guests
 * have everywhere in kaede (identity minting is open, entry is governed
 * by guests_allowed at the join, and which group's call a guest may join
 * stays with the group_call row's RLS either way). Signature first
 * (compactVerify against the host key), then the claims through the
 * unit-tested rule — jwtVerify would refuse the host's `exp: null` claim
 * outright, hence the split.
 */
export async function verifiedGuestSubject(
  token: string,
  hostUrl: string,
): Promise<string | undefined> {
  try {
    const { payload } = await compactVerify(token, await keyFor(hostUrl), {
      algorithms: ['ES256'],
    });
    return guestSubjectFrom(JSON.parse(new TextDecoder().decode(payload)), Date.now() / 1000);
  } catch {
    return undefined;
  }
}
