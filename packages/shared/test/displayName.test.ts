import { describe, expect, it } from 'vitest';
import { DISPLAY_NAME_MAX_LENGTH, normalizeDisplayName } from '../src';

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
