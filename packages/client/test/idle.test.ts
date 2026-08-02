import { describe, expect, it } from 'vitest';
import {
  createIdleMonitor,
  IDLE_CHECK_INTERVAL_MS,
  IDLE_DISCONNECT_MS,
  parseIdleTimeoutOverride,
} from '../src/net.package/idle';

const TIMEOUT = 1000;

describe('既定値', () => {
  it('タイムアウトは 15 分で、チェック周期より十分長い(ms 単位の取り違え防止)', () => {
    expect(IDLE_DISCONNECT_MS).toBe(15 * 60 * 1000);
    expect(IDLE_DISCONNECT_MS).toBeGreaterThan(IDLE_CHECK_INTERVAL_MS * 10);
  });
});

describe('createIdleMonitor', () => {
  it('タイムアウト未満では休止しない', () => {
    const idle = createIdleMonitor(TIMEOUT, 0);
    expect(idle.check(TIMEOUT - 1)).toBe('none');
  });

  it('最後の操作からタイムアウトが経過したら一度だけ休止を指示する', () => {
    const idle = createIdleMonitor(TIMEOUT, 0);
    expect(idle.check(TIMEOUT)).toBe('suspend');
    // 休止中の周期チェックは再指示しない(切断の連打にならない)。
    expect(idle.check(TIMEOUT * 10)).toBe('none');
  });

  it('操作があるとタイムアウトの起点が進む', () => {
    const idle = createIdleMonitor(TIMEOUT, 0);
    expect(idle.activity(TIMEOUT - 1)).toBe('none');
    expect(idle.check(TIMEOUT)).toBe('none');
    expect(idle.check(TIMEOUT - 1 + TIMEOUT)).toBe('suspend');
  });

  it('休止中の操作は再開を指示し、監視は稼働に戻る', () => {
    const idle = createIdleMonitor(TIMEOUT, 0);
    idle.check(TIMEOUT);
    expect(idle.activity(TIMEOUT + 1)).toBe('resume');
    // 再開直後にまた休止しない: 起点は再開時の操作になる。
    expect(idle.check(TIMEOUT + 2)).toBe('none');
    expect(idle.check(TIMEOUT + 1 + TIMEOUT)).toBe('suspend');
  });

  it('稼働中の連続した操作は何も指示しない', () => {
    const idle = createIdleMonitor(TIMEOUT, 0);
    expect(idle.activity(1)).toBe('none');
    expect(idle.activity(2)).toBe('none');
  });
});

describe('parseIdleTimeoutOverride', () => {
  it('正の有限数だけを受け付ける', () => {
    expect(parseIdleTimeoutOverride('?idleMs=3000')).toBe(3000);
    expect(parseIdleTimeoutOverride('?other=1&idleMs=500')).toBe(500);
  });

  it('欠落・空・非数・非正・無限は無視して既定値に落とす', () => {
    expect(parseIdleTimeoutOverride('')).toBeUndefined();
    expect(parseIdleTimeoutOverride('?other=1')).toBeUndefined();
    expect(parseIdleTimeoutOverride('?idleMs=')).toBeUndefined();
    expect(parseIdleTimeoutOverride('?idleMs=abc')).toBeUndefined();
    expect(parseIdleTimeoutOverride('?idleMs=0')).toBeUndefined();
    expect(parseIdleTimeoutOverride('?idleMs=-5')).toBeUndefined();
    expect(parseIdleTimeoutOverride('?idleMs=Infinity')).toBeUndefined();
  });
});
