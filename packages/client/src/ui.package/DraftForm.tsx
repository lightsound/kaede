// fallow-ignore-file coverage-gaps -- a small React form; needs a DOM, and no DOM test environment is configured. The validation callers plug in lives in @kaede/shared, unit-tested there
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
  clearOnSubmit: boolean;
  formStyle: CSSProperties;
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
