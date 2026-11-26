import { describe, expect, it } from 'vite-plus/test';
import {
  noiseCancellationAction,
  noiseCancellationFace,
  noiseCancellationMicLive,
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

describe('noiseCancellationMicLive', () => {
  it('is live when audio is enabled and the raw track is live and enabled', () => {
    expect(
      noiseCancellationMicLive({
        audioEnabled: true,
        rawAudioTrack: { readyState: 'live', enabled: true },
      }),
    ).toBe(true);
  });

  it('is not live while audio is disabled, even with a live track', () => {
    expect(
      noiseCancellationMicLive({
        audioEnabled: false,
        rawAudioTrack: { readyState: 'live', enabled: true },
      }),
    ).toBe(false);
  });

  it('is not live before the raw track exists', () => {
    expect(noiseCancellationMicLive({ audioEnabled: true, rawAudioTrack: undefined })).toBe(false);
  });

  it('is not live once the raw track has ended', () => {
    expect(
      noiseCancellationMicLive({
        audioEnabled: true,
        rawAudioTrack: { readyState: 'ended', enabled: true },
      }),
    ).toBe(false);
  });

  it('is not live while the raw track is disabled', () => {
    expect(
      noiseCancellationMicLive({
        audioEnabled: true,
        rawAudioTrack: { readyState: 'live', enabled: false },
      }),
    ).toBe(false);
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
