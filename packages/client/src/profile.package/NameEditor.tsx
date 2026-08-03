// fallow-ignore-file coverage-gaps -- a small React form; needs a DOM, and no DOM test environment is configured. The validation it relies on is normalizeDisplayName, unit-tested in @maple/shared
import {
  DISPLAY_NAME_MAX_LENGTH,
  type DisplayNameRejectReason,
  normalizeDisplayName,
} from '@maple/shared';
import type { CSSProperties } from 'react';
import { UI_FONT, UI_GOLD_BORDER, UI_PANEL_BG } from '../theme';
import { DraftForm } from '../ui.package';

const REJECT_MESSAGES: Record<DisplayNameRejectReason, string> = {
  empty: '表示名を入力してください',
  'too-long': `表示名は${DISPLAY_NAME_MAX_LENGTH}文字以内にしてください`,
  'forbidden-characters': '使用できない文字が含まれています',
};

const formStyle: CSSProperties = {
  position: 'absolute',
  bottom: 12,
  left: 12,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 8px',
  borderRadius: 8,
  background: UI_PANEL_BG,
  border: UI_GOLD_BORDER,
  font: UI_FONT,
};

/**
 * The minimal display-name form (ROADMAP Phase 1: プロフィールの永続化).
 * Validates with the same shared rules the server enforces, so a well-formed
 * name is never rejected for its content; the one remaining server refusal
 * (`no-target`, a rename with nowhere to land) surfaces as the label not
 * changing. The applied name comes back through the player row and shows
 * above the avatar.
 *
 * The draft is deliberately NOT cleared on submit (clearOnSubmit false): the
 * success signal is the applied name coming back through the player row onto
 * the avatar label, and a rename dropped in transit (disconnect racing the
 * submit) leaves the text here to resubmit rather than silently discarding it.
 */
export function NameEditor({
  disabled,
  currentName,
  onSubmit,
}: {
  /** True while there is nowhere for a rename to land (no connection or no player row yet). */
  disabled: boolean;
  /** The name currently in effect, shown as the placeholder once known. */
  currentName?: string;
  onSubmit: (name: string) => void;
}) {
  return (
    <DraftForm
      disabled={disabled}
      placeholder={currentName ?? '表示名'}
      ariaLabel="表示名"
      buttonLabel="変更"
      clearOnSubmit={false}
      formStyle={formStyle}
      submit={(draft) => {
        const verdict = normalizeDisplayName(draft);
        if (!verdict.ok) return REJECT_MESSAGES[verdict.reason];
        onSubmit(verdict.name);
        return undefined;
      }}
    />
  );
}
