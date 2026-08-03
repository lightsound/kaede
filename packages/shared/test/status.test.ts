import { describe, expect, it } from 'vitest';
import {
  AVAILABILITIES,
  DEFAULT_STATUS,
  evaluateStatusSend,
  isAvailability,
  normalizeStatusText,
  STATUS_BURST_SENDS,
  STATUS_SEND_COST_MICROS,
  STATUS_TEXT_MAX_LENGTH,
  statusLabel,
  statusViewOf,
} from '../src';

describe('isAvailability', () => {
  it('accepts every availability', () => {
    for (const availability of AVAILABILITIES) {
      expect(isAvailability(availability)).toBe(true);
    }
  });

  it('refuses anything but an exact match', () => {
    expect(isAvailability('')).toBe(false);
    expect(isAvailability('Online')).toBe(false);
    expect(isAvailability('online ')).toBe(false);
    expect(isAvailability('オンライン')).toBe(false);
    expect(isAvailability('offline')).toBe(false);
  });
});

describe('statusViewOf', () => {
  it('reads a missing row as the default (online, no text)', () => {
    expect(statusViewOf(null)).toEqual(DEFAULT_STATUS);
    expect(statusViewOf(undefined)).toEqual(DEFAULT_STATUS);
  });

  it('narrows a valid row to its view', () => {
    expect(statusViewOf({ availability: 'busy', text: 'もくもく作業中' })).toEqual({
      availability: 'busy',
      text: 'もくもく作業中',
    });
  });

  it('reads a row it cannot vouch for as the default', () => {
    expect(statusViewOf({ availability: 'invisible', text: 'x' })).toEqual(DEFAULT_STATUS);
  });
});

describe('normalizeStatusText', () => {
  it('accepts an empty or whitespace-only input as the clear operation', () => {
    expect(normalizeStatusText('')).toEqual({ ok: true, text: '' });
    expect(normalizeStatusText('   ')).toEqual({ ok: true, text: '' });
  });

  it('normalizes to NFC and collapses whitespace runs', () => {
    // か + combining dakuten composes to が.
    expect(normalizeStatusText('か\u3099っつり  作業中')).toEqual({
      ok: true,
      text: 'がっつり 作業中',
    });
  });

  it('refuses control characters', () => {
    expect(normalizeStatusText('作業中\u202Eヤバい')).toEqual({
      ok: false,
      reason: 'forbidden-characters',
    });
  });

  it('caps the length in code points', () => {
    expect(normalizeStatusText('あ'.repeat(STATUS_TEXT_MAX_LENGTH))).toEqual({
      ok: true,
      text: 'あ'.repeat(STATUS_TEXT_MAX_LENGTH),
    });
    expect(normalizeStatusText('あ'.repeat(STATUS_TEXT_MAX_LENGTH + 1))).toEqual({
      ok: false,
      reason: 'too-long',
    });
  });

  it('refuses an oversized raw input without normalization work (DoS guard)', () => {
    expect(normalizeStatusText('a'.repeat(STATUS_TEXT_MAX_LENGTH * 4 + 1))).toEqual({
      ok: false,
      reason: 'too-long',
    });
  });
});

describe('statusLabel', () => {
  it('is hidden for the default status', () => {
    expect(statusLabel(DEFAULT_STATUS)).toBeUndefined();
  });

  it('shows the dot and the text for online with text', () => {
    expect(statusLabel({ availability: 'online', text: '話しかけてOK' })).toBe('🟢 話しかけてOK');
  });

  it('shows the dot and the word for away/busy without text', () => {
    expect(statusLabel({ availability: 'away', text: '' })).toBe('🟡 離席');
    expect(statusLabel({ availability: 'busy', text: '' })).toBe('🔴 取り込み中');
  });

  it('joins the word and the text for away/busy with text', () => {
    expect(statusLabel({ availability: 'busy', text: 'もくもく作業中' })).toBe(
      '🔴 取り込み中・もくもく作業中',
    );
    expect(statusLabel({ availability: 'away', text: '昼休み' })).toBe('🟡 離席・昼休み');
  });
});

// The bucket core (bank cap, refill) is unit-tested through evaluateChatSend
// (chat.test.ts) — both delegate to evaluateSendAllowance. These pin the
// status-specific parameters.
describe('evaluateStatusSend', () => {
  const NOW = 1_700_000_000_000_000n; // an arbitrary wall-clock instant

  it('allows exactly the status burst back-to-back, then refuses', () => {
    let marker = 0n; // no guard row yet = the epoch marker
    for (let i = 0; i < STATUS_BURST_SENDS; i += 1) {
      const verdict = evaluateStatusSend({ allowanceMicros: marker, nowMicros: NOW });
      expect(verdict.ok).toBe(true);
      if (verdict.ok) marker = verdict.allowanceMicros;
    }
    expect(evaluateStatusSend({ allowanceMicros: marker, nowMicros: NOW })).toEqual({
      ok: false,
      reason: 'rate-limited',
    });
  });

  it('advances the marker by the status cost per accepted send', () => {
    const verdict = evaluateStatusSend({ allowanceMicros: NOW, nowMicros: NOW });
    expect(verdict).toEqual({ ok: true, allowanceMicros: NOW + STATUS_SEND_COST_MICROS });
  });
});
