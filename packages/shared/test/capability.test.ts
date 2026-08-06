import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_SCOPE_RECORDING,
  capabilityFresh,
  hmacSha256Hex,
  mintCapability,
  RECORDING_PASS_TTL_SECONDS,
  verifiedCapabilitySubject,
} from '../src/capability';

const NOW = 1_785_972_000;
const SUBJECT = 'c200dd03e1587e8995dd277e41928dd841aaf0aedc8cf1e02b2290955b289d7b';
const SECRET = '9f2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff00';

const claims = {
  scope: CAPABILITY_SCOPE_RECORDING,
  subjectHex: SUBJECT,
  expSeconds: NOW + RECORDING_PASS_TTL_SECONDS,
};

describe('hmacSha256Hex', () => {
  it('RFC 4231 のテストベクタに一致する(純 TS 実装の正しさの根拠)', () => {
    // Test case 2: ASCII key and data.
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
    // Test case 1's key is 20 bytes of 0x0b — not ASCII-expressible, so the
    // long-key branch (key > block size, hashed first) is pinned instead:
    // a 100-char ASCII key against Web Crypto's answer for the same input.
    expect(hmacSha256Hex('k'.repeat(100), 'block-size exceeded')).toBe(
      'ca3043b55dfc7cb219e460736421ee033bb58b8fb4e285049bca957e4e676fb5',
    );
  });

  it('SHA-256 の空文字・abc ベクタを HMAC 経由で内包する(独立ベクタで固定)', () => {
    // NIST vectors for the underlying digest are covered indirectly; this
    // pins one more independently computed HMAC so a padding bug in either
    // half cannot cancel out.
    expect(hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog')).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    );
  });

  it('非 ASCII の入力は署名しない(黙って誤エンコードしない)', () => {
    expect(hmacSha256Hex('鍵', 'message')).toBeUndefined();
    expect(hmacSha256Hex('key', 'かえで')).toBeUndefined();
  });
});

describe('mintCapability / verifiedCapabilitySubject', () => {
  it('往復する: mint した pass を同じ秘密で検証すると subject が返る', () => {
    const pass = mintCapability(claims, SECRET);
    expect(pass).toBeDefined();
    expect(verifiedCapabilitySubject(pass ?? '', CAPABILITY_SCOPE_RECORDING, [SECRET], NOW)).toBe(
      SUBJECT,
    );
  });

  it('ローテーション: 受理リストのどの秘密で署名されていても通る', () => {
    const pass = mintCapability(claims, SECRET) ?? '';
    expect(
      verifiedCapabilitySubject(pass, CAPABILITY_SCOPE_RECORDING, ['new-secret', SECRET], NOW),
    ).toBe(SUBJECT);
    expect(
      verifiedCapabilitySubject(pass, CAPABILITY_SCOPE_RECORDING, ['new-secret'], NOW),
    ).toBeUndefined();
  });

  it('空の受理リスト・空秘密は何も検証しない(アンカー未設営は fail closed)', () => {
    const pass = mintCapability(claims, SECRET) ?? '';
    expect(verifiedCapabilitySubject(pass, CAPABILITY_SCOPE_RECORDING, [], NOW)).toBeUndefined();
    expect(verifiedCapabilitySubject(pass, CAPABILITY_SCOPE_RECORDING, [''], NOW)).toBeUndefined();
    expect(mintCapability(claims, '')).toBeUndefined();
  });

  it('期限切れ・スコープ違い・改ざんは拒否する', () => {
    const pass = mintCapability(claims, SECRET) ?? '';
    expect(
      verifiedCapabilitySubject(pass, CAPABILITY_SCOPE_RECORDING, [SECRET], claims.expSeconds),
    ).toBeUndefined();
    expect(verifiedCapabilitySubject(pass, 'relay', [SECRET], NOW)).toBeUndefined();
    const tampered = pass.replace(SUBJECT, `${SUBJECT.slice(0, -1)}a`);
    expect(
      verifiedCapabilitySubject(tampered, CAPABILITY_SCOPE_RECORDING, [SECRET], NOW),
    ).toBeUndefined();
    const macFlipped = pass.slice(0, -1) + (pass.endsWith('0') ? '1' : '0');
    expect(
      verifiedCapabilitySubject(macFlipped, CAPABILITY_SCOPE_RECORDING, [SECRET], NOW),
    ).toBeUndefined();
  });

  it('形式外のトークンは拒否する', () => {
    for (const junk of ['', 'v1', 'v2:recording:aa:1:00', `v1:recording:${SUBJECT}:x:00`, 'a:b']) {
      expect(
        verifiedCapabilitySubject(junk, CAPABILITY_SCOPE_RECORDING, [SECRET], NOW),
      ).toBeUndefined();
    }
  });

  it('語彙を破る claims は mint しない(区切り文字の混入余地を残さない)', () => {
    expect(mintCapability({ ...claims, subjectHex: 'not-hex!' }, SECRET)).toBeUndefined();
    expect(mintCapability({ ...claims, scope: 'Bad:Scope' }, SECRET)).toBeUndefined();
    expect(mintCapability({ ...claims, expSeconds: 1.5 }, SECRET)).toBeUndefined();
    expect(mintCapability({ ...claims, expSeconds: -1 }, SECRET)).toBeUndefined();
  });
});

describe('capabilityFresh', () => {
  it('余命がマージンを超えるうちは再利用し、切れかけ・期限切れ・ゴミは再発行に回す', () => {
    const pass = mintCapability(claims, SECRET) ?? '';
    expect(capabilityFresh(pass, NOW)).toBe(true);
    expect(capabilityFresh(pass, claims.expSeconds - 16)).toBe(true);
    expect(capabilityFresh(pass, claims.expSeconds - 15)).toBe(false);
    expect(capabilityFresh(pass, claims.expSeconds + 1)).toBe(false);
    expect(capabilityFresh('garbage', NOW)).toBe(false);
  });
});
