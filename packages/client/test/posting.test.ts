import { describe, expect, it, vi } from 'vitest';
import { blurringClick, postingDisabled } from '../src/ui.package';

describe('postingDisabled', () => {
  it('requires both a connection and an own player row (ownName defined)', () => {
    expect(postingDisabled(true, 'かえで')).toBe(false);
    expect(postingDisabled(false, 'かえで')).toBe(true);
    expect(postingDisabled(true, undefined)).toBe(true);
    expect(postingDisabled(false, undefined)).toBe(true);
  });
});

describe('blurringClick', () => {
  it('runs the action, then blurs the button', () => {
    const order: string[] = [];
    const handler = blurringClick(() => order.push('act'));
    handler({ currentTarget: { blur: () => order.push('blur') } });
    expect(order).toEqual(['act', 'blur']);
  });

  it('does not swallow the action when blur is a no-op', () => {
    const act = vi.fn();
    blurringClick(act)({ currentTarget: { blur: vi.fn() } });
    expect(act).toHaveBeenCalledTimes(1);
  });
});
