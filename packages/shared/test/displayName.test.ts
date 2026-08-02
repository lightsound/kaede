import { describe, expect, it } from 'vitest';
import {
  DISPLAY_NAME_MAX_LENGTH,
  evaluateRename,
  normalizeDisplayName,
  resolveJoinName,
} from '../src';

describe('normalizeDisplayName', () => {
  it('accepts a plain name unchanged', () => {
    expect(normalizeDisplayName('楓')).toEqual({ ok: true, name: '楓' });
    expect(normalizeDisplayName('Kaede Dev')).toEqual({ ok: true, name: 'Kaede Dev' });
  });

  it('trims surrounding whitespace and collapses inner runs', () => {
    expect(normalizeDisplayName('  楓 \t\n の樹  ')).toEqual({ ok: true, name: '楓 の樹' });
  });

  // IME input can produce combining marks; both spellings must be one identity.
  it('normalizes to NFC so composed and decomposed forms agree', () => {
    const decomposed = 'か\u3099えで'; // か + combining voiced mark
    expect(normalizeDisplayName(decomposed)).toEqual({ ok: true, name: 'がえで' });
  });

  it('refuses an empty or whitespace-only name as empty', () => {
    expect(normalizeDisplayName('')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeDisplayName('   \t ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('accepts a name of exactly the maximum length', () => {
    const name = 'あ'.repeat(DISPLAY_NAME_MAX_LENGTH);
    expect(normalizeDisplayName(name)).toEqual({ ok: true, name });
  });

  it('refuses a name one code point over the maximum', () => {
    expect(normalizeDisplayName('あ'.repeat(DISPLAY_NAME_MAX_LENGTH + 1))).toEqual({
      ok: false,
      reason: 'too-long',
    });
  });

  // Length is code points, not UTF-16 units: surrogate-pair characters count once.
  it('counts astral-plane characters as one', () => {
    const name = '𩸽'.repeat(DISPLAY_NAME_MAX_LENGTH); // U+29E3D, 2 UTF-16 units each
    expect(normalizeDisplayName(name)).toEqual({ ok: true, name });
  });

  it('refuses control and format characters', () => {
    expect(normalizeDisplayName('a\u0000b')).toEqual({ ok: false, reason: 'forbidden-characters' });
    // RIGHT-TO-LEFT OVERRIDE: would reverse surrounding text on other screens.
    expect(normalizeDisplayName('a\u202Eb')).toEqual({ ok: false, reason: 'forbidden-characters' });
  });

  // \s covers most controls (\t, \n); the verdict must be on the collapsed text.
  it('treats whitespace-class controls as whitespace, not as forbidden', () => {
    expect(normalizeDisplayName('a\tb')).toEqual({ ok: true, name: 'a b' });
  });
});

describe('evaluateRename', () => {
  it('accepts a valid name when either target exists', () => {
    expect(evaluateRename({ rawName: '楓', hasAccount: true, hasNameRow: false })).toEqual({
      ok: true,
      name: '楓',
    });
    expect(evaluateRename({ rawName: '楓', hasAccount: false, hasNameRow: true })).toEqual({
      ok: true,
      name: '楓',
    });
  });

  // A rename with nowhere to land must fail loudly, not report success while
  // the name evaporates (a guest before join, or after its row was swept).
  it('refuses a rename when neither an account nor a player_name row exists', () => {
    expect(evaluateRename({ rawName: '楓', hasAccount: false, hasNameRow: false })).toEqual({
      ok: false,
      reason: 'no-target',
    });
  });

  it('refuses an invalid name even with targets present', () => {
    expect(evaluateRename({ rawName: ' ', hasAccount: true, hasNameRow: true })).toEqual({
      ok: false,
      reason: 'empty',
    });
  });
});

describe('resolveJoinName', () => {
  // A rename made on another device must win over this device's stale row.
  it('prefers the persisted account name over the resumed row name', () => {
    expect(
      resolveJoinName({
        persistedName: '楓',
        resumedRowName: 'Player-abc123',
        identityHex: 'abc123def',
      }),
    ).toBe('楓');
  });

  it('keeps the resumed row name when no account name is set', () => {
    expect(
      resolveJoinName({
        persistedName: undefined,
        resumedRowName: '楓の樹',
        identityHex: 'abc123def',
      }),
    ).toBe('楓の樹');
  });

  it('derives the default from the identity when nothing else exists', () => {
    expect(
      resolveJoinName({
        persistedName: undefined,
        resumedRowName: undefined,
        identityHex: 'abc123def',
      }),
    ).toBe('Player-abc123');
  });
});
