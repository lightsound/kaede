import { describe, expect, it } from 'vitest';
import {
  type DmNotifyContext,
  type DmRowEvent,
  dmNotificationContent,
  shouldNotifyDm,
} from '../src';

/** A row and context that DO notify; each test flips exactly one input. */
const EVENT: DmRowEvent = {
  source: 'event',
  own: false,
  senderName: '楓',
  senderKey: 'aa11',
  text: 'いまいい?',
};
const BACKGROUND: DmNotifyContext = {
  permission: 'granted',
  muted: false,
  hidden: true,
  hasFocus: false,
};

describe('shouldNotifyDm', () => {
  it('notifies for a foreign DM event while the tab is hidden', () => {
    expect(shouldNotifyDm(EVENT, BACKGROUND)).toBe(true);
  });

  // Focus loss alone must notify (the Slack model): the main posture is
  // the kaede tab open but unfocused while its owner works in another app,
  // where document.hidden stays false.
  it('notifies while the tab is un-hidden but unfocused', () => {
    expect(shouldNotifyDm(EVENT, { ...BACKGROUND, hidden: false, hasFocus: false })).toBe(true);
  });

  it('never notifies from the subscription seed', () => {
    expect(shouldNotifyDm({ ...EVENT, source: 'seed' }, BACKGROUND)).toBe(false);
  });

  it('never notifies for an own send', () => {
    expect(shouldNotifyDm({ ...EVENT, own: true }, BACKGROUND)).toBe(false);
  });

  it('never notifies while the tab is visible (un-hidden and focused)', () => {
    expect(shouldNotifyDm(EVENT, { ...BACKGROUND, hidden: false, hasFocus: true })).toBe(false);
  });

  // A hidden-but-focused reading is contradictory in real browsers; the
  // rule still resolves it (hidden wins) rather than leaving it undefined.
  it('notifies while hidden even if the document claims focus', () => {
    expect(shouldNotifyDm(EVENT, { ...BACKGROUND, hidden: true, hasFocus: true })).toBe(true);
  });

  it.each(['default', 'denied', 'unsupported'] as const)(
    'never notifies without granted permission (%s)',
    (permission) => {
      expect(shouldNotifyDm(EVENT, { ...BACKGROUND, permission })).toBe(false);
    },
  );

  it('never notifies while the session toggle is muted', () => {
    expect(shouldNotifyDm(EVENT, { ...BACKGROUND, muted: true })).toBe(false);
  });
});

describe('dmNotificationContent', () => {
  it('titles with the sender, bodies with the full text', () => {
    expect(dmNotificationContent(EVENT)).toEqual({
      title: '楓 からのDM',
      body: 'いまいい?',
      tag: 'kaede-dm:aa11',
    });
  });

  // The tag keys on the identity, not the name: names are neither unique
  // nor stable, and the tag is what collapses one sender's burst (and the
  // same member's second tab) into one notification.
  it('tags per sender identity', () => {
    expect(dmNotificationContent({ ...EVENT, senderKey: 'bb22' }).tag).toBe('kaede-dm:bb22');
    expect(dmNotificationContent({ ...EVENT, senderName: '別名' }).tag).toBe('kaede-dm:aa11');
  });
});
