import { describe, expect, it } from 'vitest';
import {
  CHAT_BURST_MESSAGES,
  CHAT_HISTORY_MAX,
  CHAT_SCOPE_GROUP,
  CHAT_SCOPE_MAP,
  CHAT_SCOPE_SPACE,
  CHAT_SEND_COST_MICROS,
  CHAT_TEXT_MAX_LENGTH,
  chatOverflowIds,
  chatScopeOptions,
  chatScopeTag,
  chatTargetFor,
  evaluateChatSend,
  fallbackChatScope,
  isChatScope,
  normalizeChatText,
  resolveChatRoute,
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

  // DoS hardening: a rejected send is never charged against the rate
  // bucket, so grossly oversized raw input must be refused BEFORE the
  // NFC/regex work — even when its whitespace would have collapsed within
  // the cap (the accepted trade-off; see RAW_LENGTH_FACTOR in text.ts).
  it('refuses grossly oversized raw input without normalizing it', () => {
    const padded = `${' '.repeat(CHAT_TEXT_MAX_LENGTH * 4)}あ`;
    expect(normalizeChatText(padded)).toEqual({ ok: false, reason: 'too-long' });
  });

  it('accepts raw input at the pre-normalization bound', () => {
    const text = 'あ'.repeat(CHAT_TEXT_MAX_LENGTH);
    const padded = text.padStart(CHAT_TEXT_MAX_LENGTH * 4, ' ');
    expect(normalizeChatText(padded)).toEqual({ ok: true, text });
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

describe('isChatScope', () => {
  it('accepts the three stored scopes and nothing else', () => {
    expect(isChatScope(CHAT_SCOPE_SPACE)).toBe(true);
    expect(isChatScope(CHAT_SCOPE_MAP)).toBe(true);
    expect(isChatScope(CHAT_SCOPE_GROUP)).toBe(true);
    expect(isChatScope('announce')).toBe(false);
    expect(isChatScope('')).toBe(false);
  });
});

describe('resolveChatRoute', () => {
  const onMap = { mapId: 1, groupId: undefined };
  const inGroup = { mapId: 1, groupId: 42n };

  it('routes 全体 to target 0, whatever the sender addressed', () => {
    expect(resolveChatRoute({ scope: CHAT_SCOPE_SPACE, target: 77n, context: inGroup })).toEqual({
      ok: true,
      scope: CHAT_SCOPE_SPACE,
      target: 0n,
    });
  });

  it('routes マップ to the sender own map, zero-extended', () => {
    expect(resolveChatRoute({ scope: CHAT_SCOPE_MAP, target: 1n, context: onMap })).toEqual({
      ok: true,
      scope: CHAT_SCOPE_MAP,
      target: 1n,
    });
  });

  // The in-flight teleport: the draft was addressed to the map the sender
  // was on, the row says otherwise. Refused rather than re-routed (the DM
  // no-fallback rule).
  it('refuses a map send addressed to a map the sender is not on', () => {
    expect(resolveChatRoute({ scope: CHAT_SCOPE_MAP, target: 0n, context: onMap })).toEqual({
      ok: false,
      reason: 'wrong-map',
    });
  });

  it('routes 会話グループ to the group the membership names', () => {
    expect(resolveChatRoute({ scope: CHAT_SCOPE_GROUP, target: 42n, context: inGroup })).toEqual({
      ok: true,
      scope: CHAT_SCOPE_GROUP,
      target: 42n,
    });
  });

  // The impersonation this check exists for: a hostile client naming a
  // group id it never joined, and the honest race of walking out of one.
  it('refuses a group send naming another group, or any group while in none', () => {
    expect(resolveChatRoute({ scope: CHAT_SCOPE_GROUP, target: 43n, context: inGroup })).toEqual({
      ok: false,
      reason: 'not-a-member',
    });
    expect(resolveChatRoute({ scope: CHAT_SCOPE_GROUP, target: 42n, context: onMap })).toEqual({
      ok: false,
      reason: 'not-a-member',
    });
  });

  it('refuses a scope this build does not know', () => {
    expect(resolveChatRoute({ scope: 'announce', target: 0n, context: inGroup })).toEqual({
      ok: false,
      reason: 'unknown-scope',
    });
  });
});

describe('chatScopeOptions / fallbackChatScope', () => {
  it('offers 会話グループ only while a membership names one', () => {
    expect(chatScopeOptions({ mapId: 0, groupId: undefined })).toEqual([
      CHAT_SCOPE_SPACE,
      CHAT_SCOPE_MAP,
    ]);
    expect(chatScopeOptions({ mapId: 0, groupId: 7n })).toEqual([
      CHAT_SCOPE_SPACE,
      CHAT_SCOPE_MAP,
      CHAT_SCOPE_GROUP,
    ]);
  });

  it('keeps a selection that is still offered', () => {
    const offered = chatScopeOptions({ mapId: 0, groupId: 7n });
    expect(fallbackChatScope(CHAT_SCOPE_GROUP, offered)).toBe(CHAT_SCOPE_GROUP);
    expect(fallbackChatScope(CHAT_SCOPE_MAP, offered)).toBe(CHAT_SCOPE_MAP);
  });

  it('falls back to 全体 when the selection is gone or unknown', () => {
    const offered = chatScopeOptions({ mapId: 0, groupId: undefined });
    expect(fallbackChatScope(CHAT_SCOPE_GROUP, offered)).toBe(CHAT_SCOPE_SPACE);
    expect(fallbackChatScope('announce', offered)).toBe(CHAT_SCOPE_SPACE);
  });
});

describe('chatTargetFor', () => {
  it('addresses 全体 with 0 and マップ with the zero-extended map id', () => {
    expect(chatTargetFor(CHAT_SCOPE_SPACE, { mapId: 3, groupId: 7n })).toBe(0n);
    expect(chatTargetFor(CHAT_SCOPE_MAP, { mapId: 3, groupId: undefined })).toBe(3n);
  });

  it('addresses 会話グループ with the membership group, and nothing while in none', () => {
    expect(chatTargetFor(CHAT_SCOPE_GROUP, { mapId: 3, groupId: 7n })).toBe(7n);
    expect(chatTargetFor(CHAT_SCOPE_GROUP, { mapId: 3, groupId: undefined })).toBeUndefined();
  });

  // The two halves of the pair must agree: whatever the sender addresses
  // from a context, the server's verification of that same context accepts.
  it('produces targets the routing rule accepts', () => {
    const context = { mapId: 2, groupId: 9n };
    for (const scope of chatScopeOptions(context)) {
      const target = chatTargetFor(scope, context);
      if (target === undefined) throw new Error('an offered scope must have a target');
      expect(resolveChatRoute({ scope, target, context })).toEqual({ ok: true, scope, target });
    }
  });
});

describe('chatScopeTag', () => {
  const tag = (over: Partial<Parameters<typeof chatScopeTag>[0]>) =>
    chatScopeTag({
      scope: CHAT_SCOPE_SPACE,
      announcement: false,
      mapName: '広場',
      groupName: '会議室A',
      ...over,
    });

  it('names each scope', () => {
    expect(tag({})).toBe('全体');
    expect(tag({ scope: CHAT_SCOPE_MAP })).toBe('広場');
    expect(tag({ scope: CHAT_SCOPE_GROUP })).toBe('会議室A');
  });

  // The announcement marker outranks the scope it is stored under (space).
  it('marks an announcement whatever its scope column says', () => {
    expect(tag({ announcement: true })).toBe('アナウンス');
  });

  // A closed group deleted mid-history, or a map this build does not have.
  it('falls back to a generic group label and drops an unknown map or scope', () => {
    expect(tag({ scope: CHAT_SCOPE_GROUP, groupName: undefined })).toBe('会話グループ');
    expect(tag({ scope: CHAT_SCOPE_MAP, mapName: undefined })).toBeUndefined();
    expect(tag({ scope: 'huddle-only' })).toBeUndefined();
  });
});
