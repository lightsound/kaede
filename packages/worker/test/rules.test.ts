import { describe, expect, it } from 'vitest';
import {
  allowedOrigin,
  bearerTokenFrom,
  callerKindOf,
  guestSubjectFrom,
  participantNameFrom,
  recordingArchiveKey,
  recordingObjectKey,
  recordingObjectPrefix,
  recordingWebhookFieldsFrom,
  routeCallRequest,
  routeNeedsCaller,
  routeNeedsMember,
  unverifiedIssuerOf,
} from '../src/rules';

const MEETING_ID = 'bbb8280d-7d30-430b-a3a0-78802ed5617c';
const RECORDING_ID = '97cb480d-5840-4528-ace3-919b5e386c68';

describe('routeCallRequest', () => {
  it('POST /calls/meetings はミーティング作成', () => {
    expect(routeCallRequest('POST', '/calls/meetings')).toEqual({ kind: 'provision' });
  });

  it('POST /calls/meetings/{id}/participants はトークン発行(UUID 形式のみ)', () => {
    expect(routeCallRequest('POST', `/calls/meetings/${MEETING_ID}/participants`)).toEqual({
      kind: 'mint',
      meetingId: MEETING_ID,
    });
    expect(routeCallRequest('POST', '/calls/meetings/not-a-uuid/participants')).toBeUndefined();
    expect(routeCallRequest('POST', '/calls/meetings//participants')).toBeUndefined();
  });

  it('録画 start/stop/download と webhook をルーティングする', () => {
    expect(routeCallRequest('POST', `/calls/meetings/${MEETING_ID}/recordings`)).toEqual({
      kind: 'startRecording',
      meetingId: MEETING_ID,
    });
    expect(routeCallRequest('POST', `/calls/recordings/${RECORDING_ID}/stop`)).toEqual({
      kind: 'stopRecording',
      recordingId: RECORDING_ID,
    });
    expect(routeCallRequest('GET', `/calls/recordings/${RECORDING_ID}/download`)).toEqual({
      kind: 'downloadRecording',
      recordingId: RECORDING_ID,
    });
    expect(routeCallRequest('POST', '/webhooks/realtimekit')).toEqual({ kind: 'webhook' });
  });

  it('POST 以外・知らないパスはルーティングしない', () => {
    expect(routeCallRequest('GET', '/calls/meetings')).toBeUndefined();
    expect(routeCallRequest('POST', '/calls')).toBeUndefined();
    expect(routeCallRequest('POST', `/calls/meetings/${MEETING_ID}`)).toBeUndefined();
  });
});

describe('routeNeedsCaller / routeNeedsMember', () => {
  it('webhook だけ caller 不要、録画系はメンバー限定', () => {
    expect(routeNeedsCaller({ kind: 'webhook' })).toBe(false);
    expect(routeNeedsCaller({ kind: 'provision' })).toBe(true);
    expect(routeNeedsMember({ kind: 'mint', meetingId: MEETING_ID })).toBe(false);
    expect(routeNeedsMember({ kind: 'startRecording', meetingId: MEETING_ID })).toBe(true);
    expect(routeNeedsMember({ kind: 'downloadRecording', recordingId: RECORDING_ID })).toBe(true);
  });
});

describe('allowedOrigin', () => {
  const allowlist = 'https://kaede.town, http://localhost:5173';

  it('許可リストに完全一致した origin だけを返す', () => {
    expect(allowedOrigin('https://kaede.town', allowlist)).toBe('https://kaede.town');
    expect(allowedOrigin('http://localhost:5173', allowlist)).toBe('http://localhost:5173');
    expect(allowedOrigin('https://evil.example', allowlist)).toBeUndefined();
    // 前方一致やサブドメインでは通らない
    expect(allowedOrigin('https://kaede.town.evil.example', allowlist)).toBeUndefined();
  });

  it('origin ヘッダなし(同一オリジン・curl)は付与不要', () => {
    expect(allowedOrigin(null, allowlist)).toBeUndefined();
  });
});

describe('participantNameFrom', () => {
  it('表示名の共有ルールで正規化する', () => {
    expect(participantNameFrom({ name: '  かえで  ' })).toBe('かえで');
  });

  it('名前が無い・使えないときは既定名(参加は名前で失敗しない)', () => {
    expect(participantNameFrom(undefined)).toBe('参加者');
    expect(participantNameFrom({})).toBe('参加者');
    expect(participantNameFrom({ name: '' })).toBe('参加者');
    expect(participantNameFrom({ name: 'x'.repeat(100) })).toBe('参加者');
    expect(participantNameFrom({ name: 42 })).toBe('参加者');
  });
});

describe('bearerTokenFrom', () => {
  it('Bearer トークンだけを取り出す', () => {
    expect(bearerTokenFrom('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerTokenFrom('Bearer ')).toBeUndefined();
    expect(bearerTokenFrom('Basic abc')).toBeUndefined();
    expect(bearerTokenFrom(null)).toBeUndefined();
  });
});

/** 未署名の JWT 形式文字列を組み立てる(unverifiedIssuerOf は署名を見ない)。 */
function unsignedJwt(payload: Record<string, unknown>): string {
  const encode = (part: unknown) =>
    btoa(JSON.stringify(part)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${encode({ alg: 'ES256', typ: 'JWT' })}.${encode(payload)}.sig`;
}

describe('unverifiedIssuerOf', () => {
  it('iss クレームを未検証で読む(ディスパッチ専用)', () => {
    expect(unverifiedIssuerOf(unsignedJwt({ iss: 'localhost' }))).toBe('localhost');
    expect(unverifiedIssuerOf(unsignedJwt({}))).toBeUndefined();
    expect(unverifiedIssuerOf(unsignedJwt({ iss: 42 }))).toBeUndefined();
    expect(unverifiedIssuerOf('not-a-jwt')).toBeUndefined();
  });
});

describe('callerKindOf', () => {
  const clerk = 'https://clerk.kaede.town';

  it('Clerk issuer はメンバー経路、SpacetimeDB ホストの issuer はゲスト経路', () => {
    expect(callerKindOf(clerk, clerk)).toBe('member');
    expect(callerKindOf('localhost', clerk)).toBe('guest');
    expect(callerKindOf('https://auth.spacetimedb.com', clerk)).toBe('guest');
  });

  it('知らない issuer はどの検証器にも渡さない', () => {
    expect(callerKindOf('https://evil.example', clerk)).toBeUndefined();
    expect(callerKindOf(undefined, clerk)).toBeUndefined();
  });
});

describe('guestSubjectFrom', () => {
  const now = 1_700_000_000;

  it('ホスト発行トークンのクレームを受理する(exp null = 無期限)', () => {
    expect(
      guestSubjectFrom(
        {
          iss: 'localhost',
          aud: 'spacetimedb',
          exp: null,
          hex_identity: 'aabbcc',
        },
        now,
      ),
    ).toBe('aabbcc');
  });

  it('issuer/audience/exp/subject が不正なら拒否', () => {
    expect(
      guestSubjectFrom({ iss: 'evil', aud: 'spacetimedb', hex_identity: 'x' }, now),
    ).toBeUndefined();
    expect(
      guestSubjectFrom({ iss: 'localhost', aud: 'other', hex_identity: 'x' }, now),
    ).toBeUndefined();
    expect(
      guestSubjectFrom(
        { iss: 'localhost', aud: 'spacetimedb', exp: now - 1, hex_identity: 'x' },
        now,
      ),
    ).toBeUndefined();
    expect(
      guestSubjectFrom({ iss: 'localhost', aud: 'spacetimedb', hex_identity: '' }, now),
    ).toBeUndefined();
  });
});

describe('recording object key / webhook fields', () => {
  it('meeting 単位のプレフィックスと outputFileName を結合する', () => {
    expect(recordingObjectPrefix(MEETING_ID)).toBe(`recordings/${MEETING_ID}`);
    expect(recordingObjectKey(MEETING_ID, 'weekly.mp4')).toBe(
      `recordings/${MEETING_ID}/weekly.mp4`,
    );
    expect(recordingObjectKey(MEETING_ID, '/weekly.mp4')).toBe(
      `recordings/${MEETING_ID}/weekly.mp4`,
    );
    expect(recordingArchiveKey(RECORDING_ID)).toBe(`recordings/id/${RECORDING_ID}`);
  });

  it('recording.statusUpdate だけをカタログ更新用に読む', () => {
    const fields = recordingWebhookFieldsFrom({
      event: 'recording.statusUpdate',
      recording: {
        id: RECORDING_ID,
        status: 'UPLOADED',
        meetingId: MEETING_ID,
        outputFileName: 'weekly.mp4',
        startedTime: '2026-06-03T10:00:00.000Z',
        recordingDuration: 1800,
        downloadUrl: 'https://example.com/weekly.mp4',
      },
    });
    expect(fields).toEqual({
      recordingId: RECORDING_ID,
      meetingId: MEETING_ID,
      status: 'UPLOADED',
      outputFileName: 'weekly.mp4',
      startedAtMs: BigInt(Date.parse('2026-06-03T10:00:00.000Z')),
      durationSecs: 1800,
      downloadUrl: 'https://example.com/weekly.mp4',
    });
    expect(recordingWebhookFieldsFrom({ event: 'meeting.started' })).toBeUndefined();
    expect(recordingWebhookFieldsFrom({ event: 'recording.statusUpdate' })).toBeUndefined();
  });
});
