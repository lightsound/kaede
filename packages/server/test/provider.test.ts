import { SyncResponse } from 'spacetimedb/server';
import { describe, expect, it } from 'vite-plus/test';
import { type CallConfig, type Http, mintParticipantToken } from '../src/provider';

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

  it('sets not_before 60 seconds before the mint timestamp and expires_on 24 hours after it', () => {
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
        not_before: '2027-01-15T07:59:00.000Z',
        expires_on: '2027-01-16T08:00:00.000Z',
      },
    });
  });
});
