// fallow-ignore-file coverage-gaps -- fetches the RealtimeKit well-known public key and verifies rtk-signature over the raw body; needs the live well-known endpoint. The payload shaping lives in rules.ts (unit-tested)

// RealtimeKit webhook signature verification (ROADMAP Phase 4 増分0/④):
// RSA-SHA256 over the raw request body, header `rtk-signature`, public key
// from https://api.realtime.cloudflare.com/.well-known/webhooks.json.

const WEBHOOK_PUBLIC_KEY_URL = 'https://api.realtime.cloudflare.com/.well-known/webhooks.json';

/** Cached SPKI bytes so every delivery does not re-fetch the well-known. */
let cachedSpki: ArrayBuffer | undefined;

function pemToSpki(pem: string): ArrayBuffer {
  const clean = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function webhookPublicKeySpki(): Promise<ArrayBuffer> {
  if (cachedSpki !== undefined) return cachedSpki;
  const response = await fetch(WEBHOOK_PUBLIC_KEY_URL);
  if (!response.ok) {
    throw new Error(`webhook public key fetch failed (${response.status})`);
  }
  const payload: unknown = await response.json();
  const data = (payload as { data?: { publicKey?: unknown } } | null)?.data;
  const pem = data?.publicKey;
  if (typeof pem !== 'string' || pem === '') {
    throw new Error('webhook public key missing');
  }
  cachedSpki = pemToSpki(pem);
  return cachedSpki;
}

/**
 * Verifies `rtk-signature` (base64 RSA-SHA256) against the RAW body bytes.
 * Do not re-serialize parsed JSON before calling — whitespace/key order
 * would invalidate the signature (RealtimeKit docs).
 */
export async function verifyRtkSignature(
  signatureHeader: string | null,
  body: ArrayBuffer,
): Promise<boolean> {
  if (signatureHeader === null || signatureHeader === '') return false;
  let signature: Uint8Array;
  try {
    const binary = atob(signatureHeader);
    signature = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) signature[i] = binary.charCodeAt(i);
  } catch {
    return false;
  }
  try {
    const spki = await webhookPublicKeySpki();
    const key = await crypto.subtle.importKey(
      'spki',
      spki,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, body);
  } catch (err) {
    console.error('webhook signature verify failed', err);
    return false;
  }
}
