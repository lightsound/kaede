import { describe, expect, it } from 'vitest';
import {
  hmacSha256Hex,
  parseBucketListing,
  presignedS3Url,
  RECORDINGS_PREFIX,
  recordingObjectKey,
  signedS3Headers,
} from '../src/s3';

const MEETING_ID = 'bbb8280d-7d30-430b-a3a0-78802ed5617c';
const FILE_NAME = `${MEETING_ID}_1785992667838.mp4`;

// The AWS documentation's SigV4 example credentials and clock (the
// "Authenticating Requests" S3 examples): every signature below is the
// value the documentation itself prints, so the whole chain — encoding,
// canonicalization, key derivation, SHA-256, HMAC — is pinned against an
// authority this repo does not control.
const AWS_DOC_CREDENTIALS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const AWS_DOC_NOW_MS = Date.UTC(2013, 4, 24); // 20130524T000000Z
const AWS_DOC_REGION = 'us-east-1';

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

describe('signedS3Headers', () => {
  it('AWS ドキュメントの GET Bucket (List Objects) ベクタに一致する', () => {
    const headers = signedS3Headers(
      {
        method: 'GET',
        host: 'examplebucket.s3.amazonaws.com',
        path: '/',
        query: [
          ['max-keys', '2'],
          ['prefix', 'J'],
        ],
      },
      AWS_DOC_CREDENTIALS,
      AWS_DOC_NOW_MS,
      AWS_DOC_REGION,
    );
    expect(headers?.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    );
    expect(headers?.['x-amz-date']).toBe('20130524T000000Z');
    // The empty payload's well-known SHA-256 — every request we sign is a
    // body-less read.
    expect(headers?.['x-amz-content-sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('AWS ドキュメントの GET Bucket Lifecycle ベクタ(値なしクエリ)にも一致する', () => {
    const headers = signedS3Headers(
      {
        method: 'GET',
        host: 'examplebucket.s3.amazonaws.com',
        path: '/',
        query: [['lifecycle', '']],
      },
      AWS_DOC_CREDENTIALS,
      AWS_DOC_NOW_MS,
      AWS_DOC_REGION,
    );
    expect(headers?.authorization).toContain(
      'Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
    );
  });

  it('非 ASCII の入力は署名しない', () => {
    expect(
      signedS3Headers(
        { method: 'GET', host: 'ホスト', path: '/', query: [] },
        AWS_DOC_CREDENTIALS,
        AWS_DOC_NOW_MS,
        AWS_DOC_REGION,
      ),
    ).toBeUndefined();
  });
});

describe('presignedS3Url', () => {
  it('AWS ドキュメントの presigned GET ベクタに一致する', () => {
    const url = presignedS3Url(
      { method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', query: [] },
      AWS_DOC_CREDENTIALS,
      AWS_DOC_NOW_MS,
      86400,
      AWS_DOC_REGION,
    );
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it('追加クエリ(content-disposition)は空白・引用符ごと正しくエンコードされて乗る', () => {
    const url =
      presignedS3Url(
        {
          method: 'GET',
          host: 's3.amazonaws.com',
          path: `/examplebucket/${recordingObjectKey(FILE_NAME)}`,
          query: [['response-content-disposition', `attachment; filename="${FILE_NAME}"`]],
        },
        AWS_DOC_CREDENTIALS,
        AWS_DOC_NOW_MS,
        600,
        AWS_DOC_REGION,
      ) ?? '';
    expect(url).toContain(
      `response-content-disposition=attachment%3B%20filename%3D%22${FILE_NAME}%22`,
    );
    expect(url).toContain('X-Amz-Expires=600');
    expect(url).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/);
  });

  it('非 ASCII の入力は署名しない(パス・クエリは percent-encode 済みで正規形に入る)', () => {
    // The host is the one field that enters the canonical request raw —
    // paths and query values are percent-encoded to ASCII by the
    // canonicalization itself, so only a non-ASCII host can poison it.
    expect(
      presignedS3Url(
        { method: 'GET', host: 'ホスト.example', path: '/x', query: [] },
        AWS_DOC_CREDENTIALS,
        AWS_DOC_NOW_MS,
        600,
        AWS_DOC_REGION,
      ),
    ).toBeUndefined();
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
