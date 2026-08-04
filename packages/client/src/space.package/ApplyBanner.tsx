// fallow-ignore-file coverage-gaps -- a small React banner; needs a DOM, and no DOM test environment is configured. Whether it shows is membershipPrompt + decideAdmission, unit-tested in @maple/shared
import type { MembershipPrompt } from '@maple/shared';
import type { CSSProperties } from 'react';
import { UI_BUTTON_BG, UI_FONT, UI_GOLD_BORDER, UI_PANEL_BG, UI_TEXT_COLOR } from '../theme';
import type { AdmissionSurfaceProps } from './AdmissionOverlay';

const bannerStyle: CSSProperties = {
  position: 'absolute',
  bottom: 12,
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '6px 8px 6px 14px',
  borderRadius: 999,
  background: UI_PANEL_BG,
  border: UI_GOLD_BORDER,
  color: UI_TEXT_COLOR,
  font: UI_FONT,
  whiteSpace: 'nowrap',
};

const buttonStyle: CSSProperties = {
  padding: '4px 12px',
  borderRadius: 999,
  border: UI_GOLD_BORDER,
  background: UI_BUTTON_BG,
  color: UI_TEXT_COLOR,
  font: 'inherit',
  cursor: 'pointer',
};

/** What the banner says per affordance (labels shared with AdmissionOverlay's button). */
const BANNER_TEXT: Record<'apply' | 'apply-first', { lead: string; button: string }> = {
  apply: { lead: 'メンバーとして参加できます', button: '参加を申請する' },
  // The space-first application seeds the admin (initialMembership), and
  // reading like an ordinary request confused the production owner
  // (2026-08-04) — say what the press actually does.
  'apply-first': {
    lead: 'まだメンバーがいません。最初に参加した人が管理者になります',
    button: '管理者として参加する',
  },
};

/**
 * The banner's content per affordance; nothing for `reapply` (a rejected
 * member re-applies from the blocking overlay, never from a banner) or when
 * there is no prompt at all. A function of its own — not more conditions in
 * ApplyBanner — to keep each uncovered DOM component under the CRAP budget
 * fallow enforces (the AdmissionOverlay Hint/ApplyButton precedent).
 */
function BannerBody({
  prompt,
  onApply,
}: {
  prompt: MembershipPrompt | undefined;
  onApply: () => void;
}) {
  if (prompt === undefined || prompt === 'reapply') return null;
  const text = BANNER_TEXT[prompt];
  return (
    <div style={bannerStyle}>
      <span>{text.lead}</span>
      <button type="button" style={buttonStyle} onClick={onApply}>
        {text.button}
      </button>
    </div>
  );
}

/**
 * The application affordance for a signed-in member who is in the world
 * under the guest rules (guests admitted, no membership yet): they can look
 * around already, so the ask is a banner, not a blocking overlay — the
 * blocked case is the AdmissionOverlay's job, which carries the same button.
 */
export function ApplyBanner({ connected, admission, prompt, onApply }: AdmissionSurfaceProps) {
  if (!connected || admission !== 'admitted') return null;
  return <BannerBody prompt={prompt} onApply={onApply} />;
}
