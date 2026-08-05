import { describe, expect, it } from 'vitest';
import {
  allowedOrigin,
  bearerTokenFrom,
  callerKindOf,
  guestSubjectFrom,
  participantNameFrom,
  routeCallRequest,
  unverifiedIssuerOf,
} from '../src/rules';

const MEETING_ID = 'bbb8280d-7d30-430b-a3a0-78802ed5617c';

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

  it('POST 以外・知らないパスはルーティングしない', () => {
    expect(routeCallRequest('GET', '/calls/meetings')).toBeUndefined();
    expect(routeCallRequest('POST', '/calls')).toBeUndefined();
    expect(routeCallRequest('POST', `/calls/meetings/${MEETING_ID}`)).toBeUndefined();
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
