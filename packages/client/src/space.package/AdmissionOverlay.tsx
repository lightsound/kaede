// fallow-ignore-file coverage-gaps -- a static React overlay; needs a DOM, and no DOM test environment is configured. The admission it renders is decideAdmission, unit-tested in @maple/shared
import type { Admission } from '@maple/shared';
import type { CSSProperties } from 'react';
import { UI_GOLD, UI_OVERLAY_BG, UI_TEXT_COLOR } from '../theme';

const overlayStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  background: UI_OVERLAY_BG,
  color: UI_TEXT_COLOR,
  font: '14px sans-serif',
  textAlign: 'center',
  padding: 24,
};

const titleStyle: CSSProperties = {
  font: 'bold 18px sans-serif',
  color: UI_GOLD,
};

const MESSAGES = {
  'pending-approval': {
    title: '入場申請を受け付けました',
    body: '管理者の承認をお待ちください。承認されると自動的に入場します。',
    hint: '左下のフォームで表示名を設定すると、管理者があなたを見分けやすくなります。',
  },
  'guests-not-allowed': {
    title: 'ゲスト入場は現在許可されていません',
    body: 'メンバーの方は右上からログインしてください。',
    hint: undefined,
  },
} as const;

function Hint({ text }: { text: string | undefined }) {
  if (text === undefined) return null;
  return <div style={{ opacity: 0.7 }}>{text}</div>;
}

/**
 * The full-canvas notice shown while this client may not be in the world
 * (承認待ち / ゲスト入場不許可). It covers the canvas because the game
 * renders the local sprite at the spawn point even before a join — without
 * the cover, being refused would look identical to having entered. Nothing
 * shows while admitted, before the first report, or while disconnected —
 * offline the rows are stale, and the connection overlay speaks instead.
 */
export function AdmissionOverlay({
  connected,
  admission,
}: {
  connected: boolean;
  /** The current admission, or undefined before the net stack's first report. */
  admission: Admission | undefined;
}) {
  if (!connected || admission === undefined || admission === 'admitted') return null;
  const message = MESSAGES[admission];
  return (
    <div style={overlayStyle}>
      <div style={titleStyle}>{message.title}</div>
      <div>{message.body}</div>
      <Hint text={message.hint} />
    </div>
  );
}
