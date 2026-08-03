import { describe, expect, it } from 'vitest';
import {
  evaluateReactionSend,
  isReactionEmoji,
  REACTION_BURST_SENDS,
  REACTION_EMOJIS,
  REACTION_SEND_COST_MICROS,
} from '../src';

describe('isReactionEmoji', () => {
  it('accepts every palette emoji', () => {
    for (const emoji of REACTION_EMOJIS) {
      expect(isReactionEmoji(emoji)).toBe(true);
    }
  });

  it('refuses free-form text', () => {
    expect(isReactionEmoji('')).toBe(false);
    expect(isReactionEmoji('こんにちは')).toBe(false);
    expect(isReactionEmoji('👍 ')).toBe(false); // trailing space: not an exact match
    expect(isReactionEmoji('👍👍')).toBe(false);
  });

  it('refuses near-miss variants of palette emojis', () => {
    // Skin-tone modifier on the palette's plain 👍.
    expect(isReactionEmoji('👍🏻')).toBe(false);
    // ❤ without the VS16 the palette entry carries.
    expect(isReactionEmoji('\u2764')).toBe(false);
    // A ZWJ composition (❤️‍🔥): exact matching refuses it without any
    // normalization reasoning.
    expect(isReactionEmoji('\u2764\uFE0F\u200D\u{1F525}')).toBe(false);
  });

  it('refuses emojis outside the palette', () => {
    expect(isReactionEmoji('💩')).toBe(false);
  });
});

// The bucket core (bank cap, refill) is unit-tested through evaluateChatSend
// (chat.test.ts) — both delegate to evaluateSendAllowance. These pin the
// reaction-specific parameters.
describe('evaluateReactionSend', () => {
  const NOW = 1_700_000_000_000_000n; // an arbitrary wall-clock instant

  it('allows exactly the reaction burst back-to-back, then refuses', () => {
    let marker = 0n; // no guard row yet = the epoch marker
    for (let i = 0; i < REACTION_BURST_SENDS; i += 1) {
      const verdict = evaluateReactionSend({ allowanceMicros: marker, nowMicros: NOW });
      expect(verdict.ok).toBe(true);
      if (verdict.ok) marker = verdict.allowanceMicros;
    }
    expect(evaluateReactionSend({ allowanceMicros: marker, nowMicros: NOW })).toEqual({
      ok: false,
      reason: 'rate-limited',
    });
  });

  it('advances the marker by the reaction cost per accepted send', () => {
    const verdict = evaluateReactionSend({ allowanceMicros: NOW, nowMicros: NOW });
    expect(verdict).toEqual({ ok: true, allowanceMicros: NOW + REACTION_SEND_COST_MICROS });
  });
});
