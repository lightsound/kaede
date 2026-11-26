import { SyncResponse } from 'spacetimedb/server';
import { describe, expect, it } from 'vite-plus/test';
import { type CallConfig, type Http, mintParticipantToken } from '../src/provider';

// The provider module's one outbound call that unit tests can pin
// without a live provider: minting a participant token is a pure
// request-shape decision (endpoint, preset, and — since the token
// expiry change — the validity window derived from the caller's
// timestamp), so a stub Http that records the request and answers the
// success envelope pins the whole contract. The live round trip stays
// e2e's job (the calls.ts header rule).

const CFG: CallConfig = {
  id: 0,
  realtimekitToken: 'test-admin-token',
  realtimekitAppId: 'app-1',
  cloudflareAccountId: 'acct-1',
  storageAccessKeyId: 'akid',
  storageSecretAccessKey: 'secret',
  storageBucket: 'recordings-bucket',
};

interface CapturedRequest {
  url: string;
  body: unknown;
}

function stubHttp(captured: CapturedRequest[]): Http {
  return {
    fetch: (url: URL | string, init?: { body?: string | null }) => {
      captured.push({
        url: String(url),
        body: init?.body == null ? undefined : (JSON.parse(init.body) as unknown),
      });
      return new SyncResponse(JSON.stringify({ success: true, data: { token: 'minted-token' } }), {
        status: 200,
      });
    },
  };
}

describe('mintParticipantToken', () => {
  it('posts the participant to the meeting endpoint and returns the minted token', () => {
    const captured: CapturedRequest[] = [];
    const token = mintParticipantToken(
      stubHttp(captured),
      CFG,
      'meeting-1',
      'Alice',
      'clerk-subject-1',
      Date.UTC(2027, 0, 15, 8, 0, 0),
    );
    expect(token).toBe('minted-token');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-1/realtime/kit/app-1/meetings/meeting-1/participants',
    );
    expect(captured[0]?.body).toMatchObject({
      name: 'Alice',
      preset_name: 'group_call_participant',
      custom_participant_id: 'clerk-subject-1',
    });
  });

  it('bounds the token window to 24 hours from the mint timestamp', () => {
    const captured: CapturedRequest[] = [];
    mintParticipantToken(
      stubHttp(captured),
      CFG,
      'meeting-1',
      'Alice',
      'clerk-subject-1',
      Date.UTC(2027, 0, 15, 8, 0, 0),
    );
    expect(captured[0]?.body).toMatchObject({
      token: {
        not_before: '2027-01-15T08:00:00.000Z',
        expires_on: '2027-01-16T08:00:00.000Z',
      },
    });
  });
});
