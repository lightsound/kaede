// fallow-ignore-file coverage-gaps -- a React overlay; needs a DOM, and no DOM test environment is configured. The admission and prompt it renders are decideAdmission / membershipPrompt, unit-tested in @kaede/shared
import type { Admission, MembershipPrompt } from '@kaede/shared';
import type { CSSProperties } from 'react';
import { UI_BUTTON_BG, UI_GOLD, UI_GOLD_BORDER, UI_OVERLAY_BG, UI_TEXT_COLOR } from '../theme';

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

const applyButtonStyle: CSSProperties = {
  marginTop: 6,
  padding: '8px 20px',
  borderRadius: 8,
  border: UI_GOLD_BORDER,
  background: UI_BUTTON_BG,
  color: UI_TEXT_COLOR,
  font: 'inherit',
  cursor: 'pointer',
};

const MESSAGES: Record<
  Exclude<Admission, 'admitted'>,
  { title: string; body: string; hint?: string }
> = {
  'pending-approval': {
    title: '参加申請を受け付けました',
    body: '管理者の承認をお待ちください。承認されると自動的に入場します。',
    hint: '左下のフォームで表示名を設定すると、管理者があなたを見分けやすくなります。',
  },
  rejected: {
    title: '参加は承認されませんでした',
    body: '管理者が申請を承認しませんでした。もう一度申請できます。',
  },
  banned: {
    title: '参加が制限されています',
    body: '管理者により参加が制限されています。',
  },
  'guests-not-allowed': {
    title: 'ゲスト入場は現在許可されていません',
    body: 'メンバーの方は右上からログインしてください。',
  },
};

/** The prompt's button labels; no prompt, no button (e.g. banned, guests). */
const PROMPT_LABELS: Record<MembershipPrompt, string> = {
  apply: '参加を申請する',
  // The space-first application seeds the admin (membershipPrompt) —
  // labeled with what the press actually does, like the ApplyBanner.
  'apply-first': '管理者として参加する',
  reapply: 'もう一度申請する',
};

/**
 * What a held signed-in member reads instead of the guest sign-in hint:
 * they are past signing in, and applying is their next move. The
 * space-first variant enters immediately (the first application is seeded
 * approved — initialMembership), so it must not promise an approval wait.
 */
const MEMBER_GUESTS_OFF_BODY: Record<'apply' | 'apply-first', string> = {
  apply: 'メンバーとして参加を申請すると、承認後に入場できます。',
  'apply-first': 'まだメンバーがいません。最初に参加した人が管理者になり、すぐに入場できます。',
};

function bodyFor(
  admission: Exclude<Admission, 'admitted'>,
  prompt: MembershipPrompt | undefined,
): string {
  if (admission === 'guests-not-allowed' && (prompt === 'apply' || prompt === 'apply-first')) {
    return MEMBER_GUESTS_OFF_BODY[prompt];
  }
  return MESSAGES[admission].body;
}

/**
 * What both admission surfaces render from: the blocking overlay (here) and
 * the in-world ApplyBanner take exactly the same inputs, declared once so
 * the two cannot drift (and so the clone detector sees one type, not two).
 */
export interface AdmissionSurfaceProps {
  connected: boolean;
  /** The current admission, or undefined before the net stack's first report. */
  admission: Admission | undefined;
  /** The application affordance to offer, if any (see membershipPrompt). */
  prompt: MembershipPrompt | undefined;
  onApply: () => void;
}

function Hint({ text }: { text: string | undefined }) {
  if (text === undefined) return null;
  return <div style={{ opacity: 0.7 }}>{text}</div>;
}

function ApplyButton({
  prompt,
  onApply,
}: {
  prompt: MembershipPrompt | undefined;
  onApply: () => void;
}) {
  if (prompt === undefined) return null;
  return (
    <button type="button" style={applyButtonStyle} onClick={onApply}>
      {PROMPT_LABELS[prompt]}
    </button>
  );
}

/**
 * The full-canvas notice shown while this client may not be in the world
 * (承認待ち / 不承認 / 参加制限 / ゲスト入場不許可), carrying the
 * application button when applying is the way forward (membershipPrompt).
 * It covers the canvas because the game renders the local sprite at the
 * spawn point even before a join — without the cover, being refused would
 * look identical to having entered. Nothing shows while admitted, before
 * the first report, or while disconnected — offline the rows are stale, and
 * the connection overlay speaks instead.
 */
export function AdmissionOverlay({ connected, admission, prompt, onApply }: AdmissionSurfaceProps) {
  if (!connected || admission === undefined || admission === 'admitted') return null;
  return (
    <div style={overlayStyle}>
      <div style={titleStyle}>{MESSAGES[admission].title}</div>
      <div>{bodyFor(admission, prompt)}</div>
      <Hint text={MESSAGES[admission].hint} />
      <ApplyButton prompt={prompt} onApply={onApply} />
    </div>
  );
}
