// fallow-ignore-file coverage-gaps -- a small React form; needs a DOM, and no DOM test environment is configured. The validation it relies on is normalizeDisplayName, unit-tested in @maple/shared
import {
  DISPLAY_NAME_MAX_LENGTH,
  type DisplayNameRejectReason,
  normalizeDisplayName,
} from '@maple/shared';
import { type CSSProperties, type FormEvent, useState } from 'react';

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
  background: 'rgba(11, 13, 18, 0.85)',
  border: '1px solid rgba(216, 166, 87, 0.6)',
  font: '13px sans-serif',
};

const inputStyle: CSSProperties = {
  width: 160,
  padding: '4px 8px',
  borderRadius: 6,
  border: '1px solid rgba(216, 166, 87, 0.4)',
  background: 'rgba(0, 0, 0, 0.4)',
  color: '#eceff4',
  font: 'inherit',
};

const buttonStyle: CSSProperties = {
  padding: '4px 10px',
  borderRadius: 6,
  border: '1px solid rgba(216, 166, 87, 0.6)',
  background: 'rgba(216, 166, 87, 0.15)',
  color: '#eceff4',
  font: 'inherit',
  cursor: 'pointer',
};

const errorStyle: CSSProperties = {
  color: '#e8a2a2',
};

/**
 * The minimal display-name form (ROADMAP Phase 1: プロフィールの永続化).
 * Validates with the same shared rules the server enforces, so a submitted
 * name is never rejected server-side; the applied name comes back through the
 * player row and shows above the avatar.
 */
export function NameEditor({
  disabled,
  onSubmit,
}: {
  /** True while there is no connection to carry the rename. */
  disabled: boolean;
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
    setDraft('');
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
        placeholder="表示名"
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
