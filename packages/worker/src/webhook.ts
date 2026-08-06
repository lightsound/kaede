// fallow-ignore-file coverage-gaps -- SubtleCrypto signature verification against the provider's live well-known key; needs real signed deliveries, not a unit test (live-verified against RealtimeKit deliveries, ROADMAP 増分④). The payload summary rule lives in rules.ts and is unit-tested

// The webhook half of the recording flow (ROADMAP Phase 4 増分④):
// verifying that a delivery really came from RealtimeKit. The provider
// signs every request body with RSA-SHA256 (`rtk-signature`, base64) and
// publishes the public key at a well-known URL — verification is against
// the RAW body bytes (never reserialize parsed JSON: whitespace or key
// order changes the signed bytes — provider docs).
//
// What a verified event is FOR in this increment is observability only
// (index.ts logs the summary — the ERRORED recording nobody's bucket will
// ever show): relaying into SpacetimeDB needs a relay identity the module
// trusts, deferred to the webhook-relay increment (課金・Clerk 削除 —
// see ROADMAP 増分④ ⑤).

/** Where RealtimeKit publishes its webhook-signing public key. */
const PUBLIC_KEY_URL = 'https://api.realtime.cloudflare.com/.well-known/webhooks.json';

/**
 * The imported verification key, cached for the isolate's life; a FAILED
 * fetch is evicted immediately so the next delivery retries instead of
 * failing forever (the spacetime.ts host-key cache shape).
 */
let cachedKey: Promise<CryptoKey> | undefined;

function webhookKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const key = (async () => {
    const response = await fetch(PUBLIC_KEY_URL);
    if (!response.ok) throw new Error(`webhook public key fetch failed (${response.status})`);
    const payload = (await response.json()) as { data?: { publicKey?: string } };
    const pem = payload.data?.publicKey;
    if (typeof pem !== 'string') throw new Error('webhook public key missing');
    // The PEM arrives with header/footer and (possibly escaped) newlines;
    // importKey wants the bare base64 DER.
    const der = pem
      .replace(/\\n/g, '')
      .replace(/-----BEGIN PUBLIC KEY-----/, '')
      .replace(/-----END PUBLIC KEY-----/, '')
      .replace(/\s+/g, '');
    return crypto.subtle.importKey(
      'spki',
      Uint8Array.from(atob(der), (c) => c.charCodeAt(0)),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
  })();
  cachedKey = key;
  key.catch(() => {
    cachedKey = undefined;
  });
  return key;
}

/**
 * The raw body of a delivery whose `rtk-signature` verifies, or undefined
 * for anything else (missing header, bad base64, failed verification —
 * index.ts answers 401 without distinguishing).
 */
export async function verifiedWebhookBody(request: Request): Promise<ArrayBuffer | undefined> {
  const signature = request.headers.get('rtk-signature');
  if (signature === null) return undefined;
  const body = await request.arrayBuffer();
  try {
    const verified = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      await webhookKey(),
      Uint8Array.from(atob(signature), (c) => c.charCodeAt(0)),
      body,
    );
    return verified ? body : undefined;
  } catch {
    return undefined;
  }
}
