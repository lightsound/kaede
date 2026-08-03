import { describe, expect, it } from 'vitest';
import {
  CHAT_BURST_MESSAGES,
  CHAT_HISTORY_MAX,
  CHAT_SEND_COST_MICROS,
  CHAT_TEXT_MAX_LENGTH,
  chatOverflowIds,
  evaluateChatSend,
  normalizeChatText,
} from '../src';

describe('normalizeChatText', () => {
  it('accepts a plain message unchanged', () => {
    expect(normalizeChatText('こんにちは、かえで!')).toEqual({
      ok: true,
      text: 'こんにちは、かえで!',
    });
  });

  it('trims surrounding whitespace and collapses inner runs (pasted newlines included)', () => {
    expect(normalizeChatText('  お疲れ \t\n さまです  ')).toEqual({
      ok: true,
      text: 'お疲れ さまです',
    });
  });

  // IME input can produce combining marks; both spellings must be one message.
  it('normalizes to NFC so composed and decomposed forms agree', () => {
    const decomposed = 'か\u3099'; // か + combining voiced mark
    expect(normalizeChatText(decomposed)).toEqual({ ok: true, text: 'が' });
  });

  it('refuses an empty or whitespace-only message as empty', () => {
    expect(normalizeChatText('')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeChatText('  \t ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('accepts a message of exactly the maximum length', () => {
    const text = 'あ'.repeat(CHAT_TEXT_MAX_LENGTH);
    expect(normalizeChatText(text)).toEqual({ ok: true, text });
  });

  it('refuses a message one code point over the maximum', () => {
    expect(normalizeChatText('あ'.repeat(CHAT_TEXT_MAX_LENGTH + 1))).toEqual({
      ok: false,
      reason: 'too-long',
    });
  });

  // Length is code points, not UTF-16 units: surrogate-pair characters count once.
  it('counts astral-plane characters as one', () => {
    const text = '𩸽'.repeat(CHAT_TEXT_MAX_LENGTH); // U+29E3D, 2 UTF-16 units each
    expect(normalizeChatText(text)).toEqual({ ok: true, text });
  });

  it('refuses control and format characters', () => {
    expect(normalizeChatText('a\u0000b')).toEqual({ ok: false, reason: 'forbidden-characters' });
    // RIGHT-TO-LEFT OVERRIDE: would reverse surrounding text on other screens.
    expect(normalizeChatText('a\u202Eb')).toEqual({ ok: false, reason: 'forbidden-characters' });
  });
});

describe('evaluateChatSend', () => {
  const NOW = 1_700_000_000_000_000n; // an arbitrary wall-clock instant

  /** Runs `count` sends back-to-back at NOW, returning the verdicts. */
  function sendBurst(count: number, startMarker: bigint) {
    const verdicts = [];
    let marker = startMarker;
    for (let i = 0; i < count; i += 1) {
      const verdict = evaluateChatSend({ allowanceMicros: marker, nowMicros: NOW });
      verdicts.push(verdict);
      if (verdict.ok) marker = verdict.allowanceMicros;
    }
    return verdicts;
  }

  it('accepts a first send (no guard row yet = epoch marker) and advances the marker', () => {
    const verdict = evaluateChatSend({ allowanceMicros: 0n, nowMicros: NOW });
    expect(verdict.ok).toBe(true);
  });

  it('allows exactly the burst size back-to-back, then refuses', () => {
    const verdicts = sendBurst(CHAT_BURST_MESSAGES + 1, 0n);
    for (const verdict of verdicts.slice(0, CHAT_BURST_MESSAGES)) {
      expect(verdict.ok).toBe(true);
    }
    expect(verdicts[CHAT_BURST_MESSAGES]).toEqual({ ok: false, reason: 'rate-limited' });
  });

  it('frees one send per cost interval after a burst', () => {
    const verdicts = sendBurst(CHAT_BURST_MESSAGES, 0n);
    const last = verdicts[CHAT_BURST_MESSAGES - 1];
    if (!last?.ok) throw new Error('burst should have been accepted');
    // Immediately after the burst: refused.
    expect(evaluateChatSend({ allowanceMicros: last.allowanceMicros, nowMicros: NOW })).toEqual({
      ok: false,
      reason: 'rate-limited',
    });
    // One cost interval later: exactly one more send fits.
    const later = NOW + CHAT_SEND_COST_MICROS;
    const freed = evaluateChatSend({ allowanceMicros: last.allowanceMicros, nowMicros: later });
    expect(freed.ok).toBe(true);
    if (freed.ok) {
      expect(
        evaluateChatSend({ allowanceMicros: freed.allowanceMicros, nowMicros: later }),
      ).toEqual({ ok: false, reason: 'rate-limited' });
    }
  });

  // The bank cap: a long idle must not accrue more than one burst.
  it('caps the banked allowance at the burst size no matter how stale the marker', () => {
    const staleMarker = NOW - CHAT_SEND_COST_MICROS * 1_000n;
    const verdicts = sendBurst(CHAT_BURST_MESSAGES + 1, staleMarker);
    expect(verdicts.filter((v) => v.ok)).toHaveLength(CHAT_BURST_MESSAGES);
    expect(verdicts[CHAT_BURST_MESSAGES]).toEqual({ ok: false, reason: 'rate-limited' });
  });
});

describe('chatOverflowIds', () => {
  it('returns nothing while the history is at or under the cap', () => {
    expect(chatOverflowIds([1n, 2n, 3n], 3)).toEqual([]);
    expect(chatOverflowIds([], CHAT_HISTORY_MAX)).toEqual([]);
  });

  it('returns the oldest ids beyond the cap, in ascending order', () => {
    expect(chatOverflowIds([5n, 3n, 9n, 1n, 7n], 3)).toEqual([1n, 3n]);
  });

  // Ids past Number.MAX_SAFE_INTEGER must still sort correctly (bigint compare).
  it('sorts as bigints, not as numbers or strings', () => {
    const big = 2n ** 60n;
    expect(chatOverflowIds([big + 1n, 2n, big], 2)).toEqual([2n]);
  });
});
