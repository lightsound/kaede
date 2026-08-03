import { describe, expect, it } from 'vitest';
import { CHAT_TEXT_MAX_LENGTH, collectDmCandidates, type DmCandidate, planChatDraft } from '../src';

const KAEDE: DmCandidate = { name: '楓', key: 'aa11' };
const MOMIJI: DmCandidate = { name: 'もみじ', key: 'bb22' };
const ROOM: readonly DmCandidate[] = [KAEDE, MOMIJI];

describe('planChatDraft', () => {
  it('classifies a plain message as public, normalized', () => {
    expect(planChatDraft('  こんにちは、 かえで!  ', ROOM)).toEqual({
      kind: 'public',
      text: 'こんにちは、 かえで!',
    });
  });

  it('keeps a message with an @ in the middle public', () => {
    expect(planChatDraft('連絡は info@example.com へ', ROOM)).toEqual({
      kind: 'public',
      text: '連絡は info@example.com へ',
    });
  });

  it('classifies an @-leading message as a DM to the mentioned candidate', () => {
    expect(planChatDraft('@楓 おつかれさま', ROOM)).toEqual({
      kind: 'dm',
      recipientKey: 'aa11',
      recipientName: '楓',
      text: 'おつかれさま',
    });
  });

  // The whole draft is normalized before parsing, so whitespace pasted
  // around the mention collapses instead of breaking the name match.
  it('normalizes before parsing the mention', () => {
    expect(planChatDraft('  @楓 \t おつかれ  ', ROOM)).toEqual({
      kind: 'dm',
      recipientKey: 'aa11',
      recipientName: '楓',
      text: 'おつかれ',
    });
  });

  // Display names may contain spaces; the name's end is decided by
  // candidate matching, not by the first space.
  it('resolves a name containing spaces', () => {
    const spaced: DmCandidate = { name: 'かえで さん', key: 'cc33' };
    expect(planChatDraft('@かえで さん 会議です', [spaced, ...ROOM])).toEqual({
      kind: 'dm',
      recipientKey: 'cc33',
      recipientName: 'かえで さん',
      text: '会議です',
    });
  });

  // Display names may contain '@' itself (normalizeSingleLineText refuses
  // only category C).
  it('resolves a name containing an @', () => {
    const atName: DmCandidate = { name: '楓@作業中', key: 'dd44' };
    expect(planChatDraft('@楓@作業中 いまいい?', [atName, ...ROOM])).toEqual({
      kind: 'dm',
      recipientKey: 'dd44',
      recipientName: '楓@作業中',
      text: 'いまいい?',
    });
  });

  it('picks the longest matching name when one prefixes another', () => {
    const longer: DmCandidate = { name: '楓さん', key: 'ee55' };
    expect(planChatDraft('@楓さん こんにちは', [KAEDE, longer])).toEqual({
      kind: 'dm',
      recipientKey: 'ee55',
      recipientName: '楓さん',
      text: 'こんにちは',
    });
  });

  it('refuses an @-leading message that matches nobody — never public', () => {
    expect(planChatDraft('@いない人 ひみつの話', ROOM)).toEqual({
      kind: 'refused',
      reason: 'dm-no-recipient',
    });
  });

  // Japanese IMEs produce the fullwidth ＠ by default and NFC does not
  // fold it to ASCII; reading it as public would broadcast a private
  // draft.
  it('treats a fullwidth ＠ as a mention sigil, resolving like @', () => {
    expect(planChatDraft('＠楓 全角でもDM', ROOM)).toEqual({
      kind: 'dm',
      recipientKey: 'aa11',
      recipientName: '楓',
      text: '全角でもDM',
    });
  });

  it('refuses a fullwidth ＠ mention matching nobody — never public', () => {
    expect(planChatDraft('＠いない人 ひみつの話', ROOM)).toEqual({
      kind: 'refused',
      reason: 'dm-no-recipient',
    });
  });

  it('refuses an @-only draft as no-recipient', () => {
    expect(planChatDraft('@', ROOM)).toEqual({ kind: 'refused', reason: 'dm-no-recipient' });
  });

  it('refuses when nobody is in the room to resolve against', () => {
    expect(planChatDraft('@楓 だれもいない', [])).toEqual({
      kind: 'refused',
      reason: 'dm-no-recipient',
    });
  });

  // A prefix of a candidate name is NOT that candidate: the mention must
  // cover the whole name up to a space (or the end).
  it('refuses a mention that stops mid-name', () => {
    expect(planChatDraft('@もみ じゃなくて', ROOM)).toEqual({
      kind: 'refused',
      reason: 'dm-no-recipient',
    });
  });

  // Display names are not unique; delivering to "one of them" would leak
  // the message to whichever the sender did not mean.
  it('refuses a name held by several people as ambiguous', () => {
    const twin: DmCandidate = { name: '楓', key: 'ff66' };
    expect(planChatDraft('@楓 これはどっち宛?', [...ROOM, twin])).toEqual({
      kind: 'refused',
      reason: 'dm-ambiguous-recipient',
    });
  });

  it('refuses a mention with no body', () => {
    expect(planChatDraft('@楓', ROOM)).toEqual({ kind: 'refused', reason: 'dm-empty-body' });
    expect(planChatDraft('@楓   ', ROOM)).toEqual({ kind: 'refused', reason: 'dm-empty-body' });
  });

  // The sender may appear in the candidate list: a self-DM is a memo.
  it('resolves a self-mention when the caller includes the sender', () => {
    expect(planChatDraft('@楓 自分メモ', ROOM)).toMatchObject({ kind: 'dm', recipientKey: 'aa11' });
  });

  it('propagates the text rules: empty and too-long refuse before parsing', () => {
    expect(planChatDraft('   ', ROOM)).toEqual({ kind: 'refused', reason: 'empty' });
    expect(planChatDraft(`@楓 ${'あ'.repeat(CHAT_TEXT_MAX_LENGTH)}`, ROOM)).toEqual({
      kind: 'refused',
      reason: 'too-long',
    });
  });

  it('refuses control characters in a DM body like any message', () => {
    expect(planChatDraft('@楓 a\u202Eb', ROOM)).toEqual({
      kind: 'refused',
      reason: 'forbidden-characters',
    });
  });
});

describe('collectDmCandidates', () => {
  it('keeps online, named players — the own player included', () => {
    expect(
      collectDmCandidates([
        { online: true, name: '楓', key: 'aa11' },
        { online: true, name: 'もみじ', key: 'bb22' },
      ]),
    ).toEqual(ROOM);
  });

  // An offline player row lingers for the retention window after leaving;
  // nobody renders it, so nothing may resolve a mention to it.
  it('drops offline players', () => {
    expect(collectDmCandidates([{ online: false, name: '楓', key: 'aa11' }])).toEqual([]);
  });

  // A nameless row is the mid-teardown broken-pair case (sync.ts's nameOf
  // reads '' then); nothing renders it, so nothing can mention it.
  it('drops players without a resolvable name', () => {
    expect(
      collectDmCandidates([
        { online: true, name: undefined, key: 'aa11' },
        { online: true, name: '', key: 'bb22' },
      ]),
    ).toEqual([]);
  });
});
