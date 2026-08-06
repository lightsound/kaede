import {
  CAPABILITY_SCOPE_RECORDING,
  mintCapability,
  RECORDING_PASS_TTL_SECONDS,
} from '@kaede/shared';
import { describe, expect, it } from 'vitest';
import {
  acquireRecordingPass,
  type RecordingPassDeps,
  recordingPassGetterOf,
} from '../src/call.package/pass';

const NOW = 1_785_972_000;
const SUBJECT = 'user_3HVJjGyJ2OVHwrLPOpHPmFo6zV8';

function passExpiringAt(expSeconds: number): string {
  const pass = mintCapability(
    { scope: CAPABILITY_SCOPE_RECORDING, subject: SUBJECT, expSeconds },
    'test-secret',
  );
  if (pass === undefined) throw new Error('test pass unmintable');
  return pass;
}

const FRESH = passExpiringAt(NOW + RECORDING_PASS_TTL_SECONDS);
const STALE = passExpiringAt(NOW + 5);

/** A deps double: fresh cached pass, every effect resolves, overridable. */
function makeDeps(overrides: Partial<RecordingPassDeps> = {}): RecordingPassDeps & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    ownRecordingPass: () => FRESH,
    mintRecordingPass: () => {
      calls.push('mint');
      return Promise.resolve();
    },
    delay: (ms) => {
      calls.push(`delay:${ms}`);
      return Promise.resolve();
    },
    nowSeconds: () => NOW,
    ...overrides,
  };
}

describe('acquireRecordingPass', () => {
  it('余命の残るキャッシュ済み pass は再発行せずそのまま使う', async () => {
    const deps = makeDeps();
    expect(await acquireRecordingPass(deps)).toBe(FRESH);
    expect(deps.calls).toEqual([]);
  });

  it('pass が無ければ mint して行の到着を待つ', async () => {
    let row: string | undefined;
    const deps = makeDeps({
      ownRecordingPass: () => row,
      mintRecordingPass: () => {
        row = FRESH;
        return Promise.resolve();
      },
    });
    expect(await acquireRecordingPass(deps)).toBe(FRESH);
  });

  it('切れかけの pass は再発行し、行イベントの遅延はリトライで吸収する', async () => {
    let row = STALE;
    let delays = 0;
    const deps = makeDeps({
      ownRecordingPass: () => row,
      delay: () => {
        delays += 1;
        if (delays === 2) row = FRESH; // 2 回目の待ちで行が届く
        return Promise.resolve();
      },
    });
    expect(await acquireRecordingPass(deps)).toBe(FRESH);
    expect(delays).toBe(2);
  });

  it('mint の拒否(未承認・アンカー未設営・レート)はそのまま伝播する', async () => {
    const deps = makeDeps({
      ownRecordingPass: () => undefined,
      mintRecordingPass: () => Promise.reject(new Error('not-a-member')),
    });
    await expect(acquireRecordingPass(deps)).rejects.toThrow('not-a-member');
  });

  it('mint は通ったのに行が届かないままなら諦めて失敗にする', async () => {
    const deps = makeDeps({ ownRecordingPass: () => undefined });
    await expect(acquireRecordingPass(deps)).rejects.toThrow('row never arrived');
    expect(deps.calls.filter((call) => call.startsWith('delay')).length).toBe(4);
  });
});

describe('recordingPassGetterOf', () => {
  it('net の生メソッドを実クロック・実タイマーで束ねた getter を返す', async () => {
    // 実クロックで新しい exp を持たせれば、フレッシュ経路は mint も
    // タイマーも踏まずに解決する。
    const live = passExpiringAt(Math.floor(Date.now() / 1000) + RECORDING_PASS_TTL_SECONDS);
    let minted = 0;
    const getPass = recordingPassGetterOf({
      ownRecordingPass: () => live,
      mintRecordingPass: () => {
        minted += 1;
        return Promise.resolve();
      },
    });
    expect(await getPass()).toBe(live);
    expect(minted).toBe(0);
  });
});
