// fallow-ignore-file coverage-gaps -- a small React form; needs a DOM, and no DOM test environment is configured. The validation callers plug in lives in @maple/shared, unit-tested there
import { type CSSProperties, type FormEvent, useState } from 'react';
import {
  UI_BUTTON_BG,
  UI_ERROR_COLOR,
  UI_GOLD_BORDER,
  UI_GOLD_BORDER_SOFT,
  UI_TEXT_COLOR,
} from '../theme';

const inputStyle: CSSProperties = {
  width: 160,
  flex: '1 1 auto',
  minWidth: 0,
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
 * The one-line text form behind the rename control and the chat input: an
 * input, a submit button, and an inline error. The caller owns the rule —
 * `submit` validates the draft and either dispatches it (returning
 * undefined) or returns the error message to show. Editing clears the
 * error; whether an accepted submit clears the draft is the caller's call
 * (chat clears, rename keeps the draft for resubmission).
 */
export function DraftForm({
  disabled,
  placeholder,
  ariaLabel,
  buttonLabel,
  clearOnSubmit,
  formStyle,
  submit,
}: {
  disabled: boolean;
  placeholder: string;
  ariaLabel: string;
  buttonLabel: string;
  /** Whether an accepted submit clears the draft. */
  clearOnSubmit: boolean;
  /** The form row's layout and chrome (position, panel background). */
  formStyle: CSSProperties;
  /** Validates and dispatches the draft; a returned string shows as the error. */
  submit: (draft: string) => string | undefined;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const failure = submit(draft);
    setError(failure);
    if (failure === undefined && clearOnSubmit) setDraft('');
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
        placeholder={placeholder}
        aria-label={ariaLabel}
        disabled={disabled}
      />
      <button type="submit" style={buttonStyle} disabled={disabled}>
        {buttonLabel}
      </button>
      {error !== undefined && <span style={errorStyle}>{error}</span>}
    </form>
  );
}
