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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return value as Record<string, unknown>;
}

function nestedData(payload: unknown): Record<string, unknown> | undefined {
  const root = asRecord(payload);
  if (root === undefined) return undefined;
  return asRecord(root.data);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function publicKeyPemFrom(payload: unknown): string | undefined {
  const data = nestedData(payload);
  if (data === undefined) return undefined;
  return nonEmptyString(data.publicKey);
}

async function fetchWebhookPublicKeyPem(): Promise<string> {
  const response = await fetch(WEBHOOK_PUBLIC_KEY_URL);
  if (!response.ok) {
    throw new Error(`webhook public key fetch failed (${response.status})`);
  }
  const pem = publicKeyPemFrom(await response.json());
  if (pem === undefined) throw new Error('webhook public key missing');
  return pem;
}

async function webhookPublicKeySpki(): Promise<ArrayBuffer> {
  if (cachedSpki !== undefined) return cachedSpki;
  cachedSpki = pemToSpki(await fetchWebhookPublicKeyPem());
  return cachedSpki;
}

/** Decodes the base64 `rtk-signature` header, or undefined when malformed. */
function signatureBytesFrom(header: string): Uint8Array | undefined {
  try {
    const binary = atob(header);
    const signature = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) signature[i] = binary.charCodeAt(i);
    return signature;
  } catch {
    return undefined;
  }
}

async function rsaVerify(signature: Uint8Array, body: ArrayBuffer): Promise<boolean> {
  const spki = await webhookPublicKeySpki();
  const key = await crypto.subtle.importKey(
    'spki',
    spki,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, body);
}

async function tryRsaVerify(signature: Uint8Array, body: ArrayBuffer): Promise<boolean> {
  try {
    return await rsaVerify(signature, body);
  } catch (err) {
    console.error('webhook signature verify failed', err);
    return false;
  }
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
  const signature = signatureBytesFrom(signatureHeader);
  if (signature === undefined) return false;
  return tryRsaVerify(signature, body);
}
