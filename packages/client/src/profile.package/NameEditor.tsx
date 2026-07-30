// fallow-ignore-file coverage-gaps -- a small React form; needs a DOM, and no DOM test environment is configured. The validation it relies on is normalizeDisplayName, unit-tested in @maple/shared
import {
  DISPLAY_NAME_MAX_LENGTH,
  type DisplayNameRejectReason,
  normalizeDisplayName,
} from '@maple/shared';
import { type CSSProperties, type FormEvent, useState } from 'react';
import {
  UI_BUTTON_BG,
  UI_ERROR_COLOR,
  UI_FONT,
  UI_GOLD_BORDER,
  UI_GOLD_BORDER_SOFT,
  UI_PANEL_BG,
  UI_TEXT_COLOR,
} from '../theme';

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

const inputStyle: CSSProperties = {
  width: 160,
  padding: '4px 8px',
  borderRadius: 6,
  border: UI_GOLD_BORDER_SOFT,
  background: 'rgba(0, 0, 0, 0.4)',
  color: UI_TEXT_COLOR,
  font: 'inherit',
};

const buttonStyle: CSSProperties = {
  padding: '4px 10px',
  borderRadius: 6,
  border: UI_GOLD_BORDER,
  background: UI_BUTTON_BG,
  color: UI_TEXT_COLOR,
  font: 'inherit',
  cursor: 'pointer',
};

const errorStyle: CSSProperties = {
  color: UI_ERROR_COLOR,
};

/**
 * The minimal display-name form (ROADMAP Phase 1: プロフィールの永続化).
 * Validates with the same shared rules the server enforces, so a well-formed
 * name is never rejected for its content; the one remaining server refusal
 * (`no-target`, a rename with nowhere to land) surfaces as the label not
 * changing. The applied name comes back through the player row and shows
 * above the avatar.
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
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const verdict = normalizeDisplayName(draft);
    if (!verdict.ok) {
      setError(REJECT_MESSAGES[verdict.reason]);
      return;
    }
    setError(undefined);
    // The draft is deliberately NOT cleared: the success signal is the applied
    // name coming back through the player row onto the avatar label, and a
    // rename dropped in transit (disconnect racing the submit) leaves the text
    // here to resubmit rather than silently discarding it.
    onSubmit(verdict.name);
  };

  return (
    <form style={formStyle} onSubmit={handleSubmit}>
      <input
        style={inputStyle}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(undefined);
        }}
        placeholder={currentName ?? '表示名'}
        aria-label="表示名"
        disabled={disabled}
      />
      <button type="submit" style={buttonStyle} disabled={disabled}>
        変更
      </button>
      {error !== undefined && <span style={errorStyle}>{error}</span>}
    </form>
  );
}
