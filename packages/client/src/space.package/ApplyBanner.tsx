// fallow-ignore-file coverage-gaps -- a small React banner; needs a DOM, and no DOM test environment is configured. Whether it shows is membershipPrompt + decideAdmission, unit-tested in @maple/shared
import type { Admission, MembershipPrompt } from '@maple/shared';
import type { CSSProperties } from 'react';
import { UI_BUTTON_BG, UI_FONT, UI_GOLD_BORDER, UI_PANEL_BG, UI_TEXT_COLOR } from '../theme';

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

/**
 * The application affordance for a signed-in member who is in the world
 * under the guest rules (guests admitted, no membership yet): they can look
 * around already, so the ask is a banner, not a blocking overlay — the
 * blocked case is the AdmissionOverlay's job, which carries the same button.
 */
export function ApplyBanner({
  connected,
  admission,
  prompt,
  onApply,
}: {
  connected: boolean;
  admission: Admission | undefined;
  /** The application affordance to offer, if any (see membershipPrompt). */
  prompt: MembershipPrompt | undefined;
  onApply: () => void;
}) {
  if (!connected || admission !== 'admitted' || prompt !== 'apply') return null;
  return (
    <div style={bannerStyle}>
      <span>メンバーとして参加できます</span>
      <button type="button" style={buttonStyle} onClick={onApply}>
        参加を申請する
      </button>
    </div>
  );
}
