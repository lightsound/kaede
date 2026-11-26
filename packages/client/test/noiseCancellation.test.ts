import { describe, expect, it } from 'vite-plus/test';
import { noiseCancellationFace } from '../src/call.package/noiseCancellation';

describe('noiseCancellationFace', () => {
  it('offers to turn processing on while it is off', () => {
    expect(noiseCancellationFace(false, false)).toEqual({
      label: 'ノイズ除去をオンにする',
      disabled: false,
    });
  });

  it('offers to turn processing off while it is on', () => {
    expect(noiseCancellationFace(true, false)).toEqual({
      label: 'ノイズ除去をオフにする',
      disabled: false,
    });
  });

  it('disables under a transitional face while a click is in flight, either way', () => {
    expect(noiseCancellationFace(false, true)).toEqual({ label: '⏳ 処理中…', disabled: true });
    expect(noiseCancellationFace(true, true)).toEqual({ label: '⏳ 処理中…', disabled: true });
  });
});
