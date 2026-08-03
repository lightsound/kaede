// fallow-ignore-file coverage-gaps -- a React control over the live Notification permission; needs a DOM, and no DOM test environment is configured. The decision rules it configures are shouldNotifyDm, unit-tested in @maple/shared
import type { CSSProperties } from 'react';
import { useState } from 'react';
import { UI_GOLD_BORDER_SOFT, UI_TEXT_COLOR } from '../theme';
import { blurringClick } from '../ui.package';
import { type DmNotifier, dmNotifier, type NotifyUiState } from './notifier';

const buttonStyle: CSSProperties = {
  padding: '2px 8px',
  borderRadius: 6,
  border: UI_GOLD_BORDER_SOFT,
  background: 'transparent',
  color: UI_TEXT_COLOR,
  font: 'inherit',
  cursor: 'pointer',
  alignSelf: 'flex-start',
};

const blockedStyle: CSSProperties = {
  ...buttonStyle,
  cursor: 'default',
  opacity: 0.6,
};

/** The 'default'-permission arm: enabling notifications IS this click (see below). */
function EnableButton({ notifier, onSettled }: { notifier: DmNotifier; onSettled: () => void }) {
  const request = () => {
    void notifier.requestPermission().then(onSettled);
  };
  return (
    <button
      type="button"
      style={buttonStyle}
      aria-label="DM通知を有効にする"
      onClick={blurringClick(request)}
    >
      🔔 DM通知を有効にする
    </button>
  );
}

/** The 'granted' arm: the session-local on/off (the delegated minimal toggle). */
function MuteToggle({
  muted,
  notifier,
  onToggled,
}: {
  muted: boolean;
  notifier: DmNotifier;
  onToggled: () => void;
}) {
  const toggle = () => {
    notifier.setMuted(!muted);
    onToggled();
  };
  return (
    <button
      type="button"
      style={buttonStyle}
      aria-label="DM通知のオン/オフ"
      aria-pressed={!muted}
      onClick={blurringClick(toggle)}
    >
      {muted ? '🔕 DM通知: オフ' : '🔔 DM通知: オン'}
    </button>
  );
}

/**
 * The DM-notification switch (ROADMAP Phase 2), one control over
 * Notification.permission's three states plus the session mute:
 * - unsupported: renders nothing — the feature is simply absent, and a
 *   dead button would be chrome without a purpose;
 * - default: an enable button, because the permission prompt can only be
 *   raised from a user gesture (auto-requesting on load is ignored or
 *   auto-denied by modern browsers) — so enabling notifications IS this
 *   click, there is no on-load path;
 * - granted: an on/off toggle for THIS session — revoking via browser site
 *   settings is too hostile to be the only off switch, e.g. while
 *   presenting;
 * - denied: an inert notice — a page cannot re-prompt a denied permission,
 *   so the honest UI is "blocked in the browser", not a button that
 *   silently does nothing.
 *
 * Deliberately NOT gated on connection or the player row (postingDisabled):
 * the permission is a browser fact, and granting it while disconnected is
 * fine — notifications simply start when rows flow again.
 */
export function NotificationControl() {
  const notifier = dmNotifier();
  // The only mutations flow through this control's own children (the
  // notifier has no other writer), so re-reading after each action stays
  // consistent without a subscription.
  const [ui, setUi] = useState<NotifyUiState>(notifier.uiState());
  const refresh = () => setUi(notifier.uiState());

  if (ui.permission === 'unsupported') return null;
  if (ui.permission === 'denied') {
    return <span style={blockedStyle}>🔕 DM通知はブラウザでブロック中</span>;
  }
  if (ui.permission === 'default') {
    return <EnableButton notifier={notifier} onSettled={refresh} />;
  }
  return <MuteToggle muted={ui.muted} notifier={notifier} onToggled={refresh} />;
}
