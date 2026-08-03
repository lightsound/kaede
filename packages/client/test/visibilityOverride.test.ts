import { describe, expect, it } from 'vitest';
import { parseVisibilityOverride } from '../src/notify.package/visibilityOverride';

describe('parseVisibilityOverride', () => {
  it('visibility=hidden をタブ切替と同じ読み(hidden・フォーカスなし)に上書きする', () => {
    expect(parseVisibilityOverride('?visibility=hidden')).toEqual({
      hidden: true,
      hasFocus: false,
    });
    expect(parseVisibilityOverride('?idleMs=500&visibility=hidden')).toEqual({
      hidden: true,
      hasFocus: false,
    });
  });

  it('欠落・空・その他の値は上書きなし(素の document を読む)', () => {
    expect(parseVisibilityOverride('')).toBeUndefined();
    expect(parseVisibilityOverride('?other=1')).toBeUndefined();
    expect(parseVisibilityOverride('?visibility=')).toBeUndefined();
    expect(parseVisibilityOverride('?visibility=visible')).toBeUndefined();
    expect(parseVisibilityOverride('?visibility=HIDDEN')).toBeUndefined();
  });
});
