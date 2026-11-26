import { describe, expect, it } from 'vite-plus/test';
import {
  noiseCancellationAction,
  noiseCancellationFace,
} from '../src/call.package/noiseCancellation';

describe('noiseCancellationFace', () => {
  it('offers to turn processing off while the mic is live and processing is wanted', () => {
    expect(noiseCancellationFace(true, true, false)).toEqual({
      label: 'ノイズ除去をオフにする',
      disabled: false,
    });
  });

  it('offers to turn processing on while the mic is live and processing is unwanted', () => {
    expect(noiseCancellationFace(false, true, false)).toEqual({
      label: 'ノイズ除去をオンにする',
      disabled: false,
    });
  });

  it('shows the wanted-on face disabled while the mic is off, offering no action', () => {
    expect(noiseCancellationFace(true, false, false)).toEqual({
      label: 'ノイズ除去をオフにする',
      disabled: true,
    });
  });

  it('shows the wanted-off face disabled while the mic is off', () => {
    expect(noiseCancellationFace(false, false, false)).toEqual({
      label: 'ノイズ除去をオンにする',
      disabled: true,
    });
  });

  it('disables under a transitional face while an operation is in flight', () => {
    expect(noiseCancellationFace(true, true, true)).toEqual({
      label: '⏳ 処理中…',
      disabled: true,
    });
    expect(noiseCancellationFace(false, false, true)).toEqual({
      label: '⏳ 処理中…',
      disabled: true,
    });
  });
});

describe('noiseCancellationAction', () => {
  it('enables when processing is wanted, not yet active, and the mic is live', () => {
    expect(noiseCancellationAction(true, false, true)).toBe('enable');
  });

  it('disables when processing is unwanted, active, and the mic is live', () => {
    expect(noiseCancellationAction(false, true, true)).toBe('disable');
  });

  it('does nothing when intent and actual state already agree', () => {
    expect(noiseCancellationAction(true, true, true)).toBe('none');
    expect(noiseCancellationAction(false, false, true)).toBe('none');
  });

  it('never enables or disables while the mic is off', () => {
    expect(noiseCancellationAction(true, false, false)).toBe('none');
    expect(noiseCancellationAction(false, true, false)).toBe('none');
  });
});
