import { describe, expect, it } from 'vitest';
import { allowedOrigin, participantNameFrom, routeCallRequest } from '../src/rules';

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
    expect(participantNameFrom(undefined)).toBe('メンバー');
    expect(participantNameFrom({})).toBe('メンバー');
    expect(participantNameFrom({ name: '' })).toBe('メンバー');
    expect(participantNameFrom({ name: 'x'.repeat(100) })).toBe('メンバー');
    expect(participantNameFrom({ name: 42 })).toBe('メンバー');
  });
});
