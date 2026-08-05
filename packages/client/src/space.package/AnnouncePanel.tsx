// fallow-ignore-file coverage-gaps -- a React form in the admin panel; needs a DOM, and no DOM test environment is configured. The authority is server-side (send_announcement over evaluateSettingChange / normalizeChatText, unit-tested in @kaede/shared)
import { CHAT_TEXT_MAX_LENGTH, normalizeChatText } from '@kaede/shared';
import { type CSSProperties, type FormEvent, useState } from 'react';
import { UI_BUTTON_BG, UI_ERROR_COLOR, UI_GOLD, UI_GOLD_BORDER, UI_TEXT_COLOR } from '../theme';

const headingStyle: CSSProperties = {
  fontWeight: 'bold',
  color: UI_GOLD,
  margin: '8px 0 4px',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 0',
  flexWrap: 'wrap',
};

const inputStyle: CSSProperties = {
  flex: '1 1 80px',
  minWidth: 0,
  padding: '2px 6px',
  borderRadius: 6,
  border: UI_GOLD_BORDER,
  background: 'rgba(0, 0, 0, 0.4)',
  color: UI_TEXT_COLOR,
  font: 'inherit',
};

const buttonStyle: CSSProperties = {
  padding: '2px 8px',
  borderRadius: 6,
  border: UI_GOLD_BORDER,
  background: UI_BUTTON_BG,
  color: UI_TEXT_COLOR,
  font: 'inherit',
  cursor: 'pointer',
  flexShrink: 0,
};

/**
 * What a refused draft says. One message for every reason, unlike the chat
 * panel's per-reason table: an announcement is typed by an admin into a
 * one-line field whose only real failure is length, and a second copy of
 * that table would be a clone of it.
 */
const DRAFT_ERROR = `送信できない内容です(${CHAT_TEXT_MAX_LENGTH}文字以内)`;

/**
 * The admin panel's 全体アナウンス section (ROADMAP Phase 3 増分④): type
 * the message, then confirm it. Two steps deliberately — an announcement
 * reaches every person in the space, on every map, inside closed meetings
 * included, so it must not be one stray Enter away. The confirmation is an
 * in-page step rather than a browser dialog: the panel is the surface, and
 * a dialog would put the text out of view exactly when it is being checked.
 *
 * The draft is validated with the same normalizeChatText the server applies
 * (instant feedback; the server re-checks regardless), and the admin gate
 * is server-side — this panel only renders for acting admins, cosmetically.
 */
export function AnnouncePanel({ onSendAnnouncement }: { onSendAnnouncement(text: string): void }) {
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const verdict = normalizeChatText(draft);
    if (!verdict.ok) {
      setError(DRAFT_ERROR);
      return;
    }
    setError(undefined);
    setPending(verdict.text);
  };

  const send = () => {
    if (pending !== undefined) onSendAnnouncement(pending);
    setPending(undefined);
    setDraft('');
  };

  return (
    <div>
      <div style={headingStyle}>全体アナウンス</div>
      <form style={rowStyle} onSubmit={handleSubmit}>
        <input
          style={inputStyle}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(undefined);
            setPending(undefined);
          }}
          placeholder="全員に知らせる内容"
          aria-label="アナウンス入力"
        />
        <button type="submit" style={buttonStyle}>
          確認
        </button>
        {error !== undefined && (
          <span style={{ color: UI_ERROR_COLOR, flexBasis: '100%' }}>{error}</span>
        )}
      </form>
      {pending !== undefined && (
        <div style={rowStyle}>
          <span style={{ flexBasis: '100%' }}>この内容を全員に送信します: 「{pending}」</span>
          <button type="button" style={buttonStyle} onClick={send}>
            送信する
          </button>
          <button type="button" style={buttonStyle} onClick={() => setPending(undefined)}>
            やめる
          </button>
        </div>
      )}
    </div>
  );
}
