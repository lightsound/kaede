import {
  CAPABILITY_SCOPE_RECORDING,
  mintCapability,
  RECORDING_PASS_TTL_SECONDS,
} from '@kaede/shared';
import { describe, expect, it } from 'vitest';
import {
  allowedOrigin,
  bearerTokenFrom,
  callerKindOf,
  guestSubjectFrom,
  parseBucketListing,
  participantNameFrom,
  RECORDING_PASS_HEADER,
  RECORDINGS_PREFIX,
  recordingObjectKey,
  recordingPassSubject,
  routeCallRequest,
  routeIsMemberOnly,
  summarizeRecordingEvent,
  unverifiedIssuerOf,
} from '../src/rules';

const MEETING_ID = 'bbb8280d-7d30-430b-a3a0-78802ed5617c';
const FILE_NAME = `${MEETING_ID}_1785992667838.mp4`;

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

  it('録画の開始/停止ルート(UUID 形式のみ)', () => {
    expect(routeCallRequest('POST', `/calls/meetings/${MEETING_ID}/recordings`)).toEqual({
      kind: 'record-start',
      meetingId: MEETING_ID,
    });
    expect(routeCallRequest('POST', `/calls/meetings/${MEETING_ID}/recordings/stop`)).toEqual({
      kind: 'record-stop',
      meetingId: MEETING_ID,
    });
    expect(routeCallRequest('POST', '/calls/meetings/not-a-uuid/recordings')).toBeUndefined();
    expect(routeCallRequest('GET', `/calls/meetings/${MEETING_ID}/recordings`)).toBeUndefined();
  });

  it('録画の一覧/DL ルート(ファイル名はプロバイダ命名形のみ)', () => {
    expect(routeCallRequest('GET', '/calls/recordings')).toEqual({ kind: 'recordings-list' });
    expect(routeCallRequest('GET', `/calls/recordings/${FILE_NAME}/download-url`)).toEqual({
      kind: 'recording-download',
      fileName: FILE_NAME,
    });
    expect(routeCallRequest('GET', '/calls/recordings/evil.txt/download-url')).toBeUndefined();
    expect(
      routeCallRequest('GET', '/calls/recordings/..%2Fsecret.mp4/download-url'),
    ).toBeUndefined();
    expect(routeCallRequest('POST', '/calls/recordings')).toBeUndefined();
  });

  it('POST/GET 以外・知らないパスはルーティングしない', () => {
    expect(routeCallRequest('GET', '/calls/meetings')).toBeUndefined();
    expect(routeCallRequest('PUT', '/calls/recordings')).toBeUndefined();
    expect(routeCallRequest('POST', '/calls')).toBeUndefined();
    expect(routeCallRequest('POST', `/calls/meetings/${MEETING_ID}`)).toBeUndefined();
  });
});

describe('routeIsMemberOnly', () => {
  it('録画系ルートだけがメンバー限定(通話系はゲストも通る — 増分②)', () => {
    expect(routeIsMemberOnly({ kind: 'provision' })).toBe(false);
    expect(routeIsMemberOnly({ kind: 'mint', meetingId: MEETING_ID })).toBe(false);
    expect(routeIsMemberOnly({ kind: 'record-start', meetingId: MEETING_ID })).toBe(true);
    expect(routeIsMemberOnly({ kind: 'record-stop', meetingId: MEETING_ID })).toBe(true);
    expect(routeIsMemberOnly({ kind: 'recordings-list' })).toBe(true);
    expect(routeIsMemberOnly({ kind: 'recording-download', fileName: FILE_NAME })).toBe(true);
  });
});

describe('recordingObjectKey', () => {
  it('recordings プレフィックス配下のキーを組む', () => {
    expect(RECORDINGS_PREFIX).toBe('recordings');
    expect(recordingObjectKey(FILE_NAME)).toBe(`${RECORDINGS_PREFIX}/${FILE_NAME}`);
  });
});

describe('parseBucketListing', () => {
  // The live ListObjectsV2 shape (2026-08-06 spike, abbreviated).
  const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>kaede-recordings</Name><Contents><Key>recordings/${FILE_NAME}</Key><Size>159134</Size><LastModified>2026-08-06T05:05:35.226Z</LastModified><ETag>&quot;31a8&quot;</ETag></Contents><Contents><Key>spike.txt</Key><Size>11</Size><LastModified>2026-08-06T05:02:18.315Z</LastModified></Contents><Contents><Key>recordings/not-a-recording.bin</Key><Size>5</Size><LastModified>2026-08-06T05:02:18.315Z</LastModified></Contents></ListBucketResult>`;

  it('recordings/ 配下のプロバイダ命名オブジェクトだけを返す', () => {
    expect(parseBucketListing(xml)).toEqual([
      { fileName: FILE_NAME, size: 159134, uploadedAt: '2026-08-06T05:05:35.226Z' },
    ]);
  });

  it('空・壊れた XML は空配列', () => {
    expect(parseBucketListing('')).toEqual([]);
    expect(parseBucketListing('<ListBucketResult></ListBucketResult>')).toEqual([]);
    expect(parseBucketListing('<Contents><Key>recordings/x.mp4</Key></Contents>')).toEqual([]);
  });
});

describe('summarizeRecordingEvent', () => {
  it('recording.statusUpdate をダウンロード URL 抜きで要約する', () => {
    const payload = {
      event: 'recording.statusUpdate',
      recording: {
        id: 'rec-1',
        status: 'UPLOADED',
        outputFileName: FILE_NAME,
        downloadUrl: 'https://example.com/secret-download',
        errMessage: null,
      },
    };
    const summary = summarizeRecordingEvent(payload);
    expect(summary).toEqual({
      event: 'recording.statusUpdate',
      recordingId: 'rec-1',
      status: 'UPLOADED',
      fileName: FILE_NAME,
      error: '',
    });
    expect(JSON.stringify(summary)).not.toContain('secret-download');
  });

  it('イベント形でない body は null', () => {
    expect(summarizeRecordingEvent(null)).toBeNull();
    expect(summarizeRecordingEvent('x')).toBeNull();
    expect(summarizeRecordingEvent({})).toBeNull();
    expect(summarizeRecordingEvent({ event: 42 })).toBeNull();
  });

  it('recording の無いイベント(meeting.started 等)も event 名は要約できる', () => {
    expect(summarizeRecordingEvent({ event: 'meeting.started' })).toEqual({
      event: 'meeting.started',
      recordingId: '',
      status: '',
      fileName: '',
      error: '',
    });
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

describe('recordingPassSubject', () => {
  const NOW = 1_785_972_000;
  const SUBJECT = 'c200dd03e1587e8995dd277e41928dd841aaf0aedc8cf1e02b2290955b289d7b';
  const SECRET = '9f2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff00';
  const pass =
    mintCapability(
      {
        scope: CAPABILITY_SCOPE_RECORDING,
        subjectHex: SUBJECT,
        expSeconds: NOW + RECORDING_PASS_TTL_SECONDS,
      },
      SECRET,
    ) ?? '';

  it('module が mint した pass を受理し subject を返す(共有実装の往復)', () => {
    expect(recordingPassSubject(pass, SECRET, NOW)).toBe(SUBJECT);
  });

  it('ローテーション用のカンマ区切りリストのどれでも通る(空白は寛容)', () => {
    expect(recordingPassSubject(pass, `next-secret, ${SECRET}`, NOW)).toBe(SUBJECT);
    expect(recordingPassSubject(pass, 'next-secret', NOW)).toBeUndefined();
  });

  it('ヘッダなし・空・期限切れ・空シークレット(アンカー未設営)は拒否する', () => {
    expect(recordingPassSubject(null, SECRET, NOW)).toBeUndefined();
    expect(recordingPassSubject('', SECRET, NOW)).toBeUndefined();
    expect(recordingPassSubject(pass, SECRET, NOW + RECORDING_PASS_TTL_SECONDS)).toBeUndefined();
    expect(recordingPassSubject(pass, '', NOW)).toBeUndefined();
    expect(recordingPassSubject(pass, ' , ,', NOW)).toBeUndefined();
  });

  it('ヘッダ名は preflight の許可リストと一致させる定数', () => {
    expect(RECORDING_PASS_HEADER).toBe('x-recording-pass');
  });
});

describe('guestSubjectFrom', () => {
  const NOW = 1_785_972_000;
  const claims = {
    hex_identity: 'c200dd03e1587e8995dd277e41928dd841aaf0aedc8cf1e02b2290955b289d7b',
    sub: 'a7f1aabc-7273-41ff-8f22-cbd4c793fec5',
    iss: 'localhost',
    aud: ['spacetimedb'],
    iat: NOW - 60,
    exp: null,
  };

  it('ホスト発行トークンの実測形(exp: null)を受理し hex_identity を返す', () => {
    expect(guestSubjectFrom(claims, NOW)).toBe(claims.hex_identity);
    // 文字列 aud・exp 省略・将来の exp も受理する
    expect(guestSubjectFrom({ ...claims, aud: 'spacetimedb', exp: undefined }, NOW)).toBe(
      claims.hex_identity,
    );
    expect(guestSubjectFrom({ ...claims, exp: NOW + 3600 }, NOW)).toBe(claims.hex_identity);
  });

  it('登録外 issuer・別 audience・期限切れ・subject 欠落は拒否する', () => {
    expect(guestSubjectFrom({ ...claims, iss: 'https://evil.example' }, NOW)).toBeUndefined();
    expect(guestSubjectFrom({ ...claims, aud: ['other'] }, NOW)).toBeUndefined();
    expect(guestSubjectFrom({ ...claims, exp: NOW - 1 }, NOW)).toBeUndefined();
    expect(guestSubjectFrom({ ...claims, exp: 'never' }, NOW)).toBeUndefined();
    expect(guestSubjectFrom({ ...claims, hex_identity: undefined }, NOW)).toBeUndefined();
    expect(guestSubjectFrom({ ...claims, hex_identity: '' }, NOW)).toBeUndefined();
    expect(guestSubjectFrom(null, NOW)).toBeUndefined();
    expect(guestSubjectFrom('token', NOW)).toBeUndefined();
  });
});
