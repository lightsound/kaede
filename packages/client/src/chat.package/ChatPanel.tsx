// fallow-ignore-file coverage-gaps -- a React chat panel; needs a DOM, and no DOM test environment is configured. The validation and rate rules it relies on are normalizeChatText / evaluateChatSend, unit-tested in @maple/shared
import {
  CHAT_TEXT_MAX_LENGTH,
  type ChatDraftPlan,
  type ChatDraftRejectReason,
  evaluateChatSend,
  type PlannedSend,
  REACTION_EMOJIS,
  type ReactionEmoji,
} from '@maple/shared';
import { type CSSProperties, useEffect, useRef } from 'react';
import { type ChatEntryView, type ChatLog, chatEntryKey } from '../net.package';
import {
  UI_DM_COLOR,
  UI_ERROR_COLOR,
  UI_FONT,
  UI_GOLD,
  UI_GOLD_BORDER,
  UI_GOLD_BORDER_SOFT,
  UI_PANEL_BG,
  UI_TEXT_COLOR,
} from '../theme';
import { blurringClick, DraftForm, postingDisabled } from '../ui.package';

const REJECT_MESSAGES: Record<ChatDraftRejectReason, string> = {
  empty: 'メッセージを入力してください',
  'too-long': `メッセージは${CHAT_TEXT_MAX_LENGTH}文字以内にしてください`,
  'forbidden-characters': '使用できない文字が含まれています',
  // The @-leading draft resolved to nobody. Deliberately NOT posted
  // publicly (planChatDraft), so the message must say why nothing was sent
  // — and that '@' is what made this a DM.
  'dm-no-recipient': '宛先が見つかりません(@で始まる発言は在室中の相手への DM になります)',
  'dm-ambiguous-recipient': '同じ表示名の人が複数いるため、DM を送れません',
  'dm-empty-body': 'DM の本文を入力してください',
};

const RATE_LIMITED_MESSAGE = '送信が速すぎます。少し待ってから送ってください';

const SEND_REFUSED_MESSAGE = '送信できませんでした。少し待ってからもう一度お試しください';

const panelStyle: CSSProperties = {
  position: 'absolute',
  bottom: 12,
  right: 12,
  width: 300,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 8,
  borderRadius: 8,
  background: UI_PANEL_BG,
  border: UI_GOLD_BORDER,
  font: UI_FONT,
  color: UI_TEXT_COLOR,
};

const logStyle: CSSProperties = {
  maxHeight: 160,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  wordBreak: 'break-word',
};

const formStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap', // the inline error wraps onto its own line
  alignItems: 'center',
  gap: 6,
};

const reactionRowStyle: CSSProperties = {
  display: 'flex',
  gap: 4,
};

const reactionButtonStyle: CSSProperties = {
  flex: '1 1 0',
  padding: '2px 0',
  borderRadius: 6,
  border: UI_GOLD_BORDER_SOFT,
  background: 'transparent',
  fontSize: 15,
  cursor: 'pointer',
};

/** The sender name lead-in; the local player's own lines get the gold accent. */
function senderStyle(own: boolean): CSSProperties {
  return { color: own ? UI_GOLD : UI_TEXT_COLOR, fontWeight: 'bold' };
}

const dmMarkStyle: CSSProperties = {
  color: UI_DM_COLOR,
  fontWeight: 'bold',
};

/**
 * One log line. A DM line is marked apart from room chatter — the [DM] tag
 * and the → 宛先 in the DM accent color — because the log holds both and a
 * private line must never read as something the room saw. Only the sender
 * and the recipient ever hold the row (row-level security), so no
 * receiver-side filtering happens here.
 */
function LogLine({ entry }: { entry: ChatEntryView }) {
  return (
    <div>
      {entry.kind === 'dm' && <span style={dmMarkStyle}>[DM] </span>}
      <span style={senderStyle(entry.own)}>{entry.senderName}</span>
      {entry.kind === 'dm' && <span style={dmMarkStyle}> → {entry.recipientName}</span>}{' '}
      {entry.text}
    </div>
  );
}

/**
 * The reaction palette row (ROADMAP Phase 2): one button per palette emoji,
 * sitting between the log and the input row so the input stays where the
 * chat habit expects it (the bottom line). Gated exactly like the chat
 * input — sending needs a player row to react from. Each click blurs its
 * button (blurringClick — see its comment for the keyboard reasons).
 *
 * No client-side bucket mirror and no refusal notice, unlike the message
 * form: a reaction is a fire-and-forget gesture with no draft to lose, so
 * a burst-exceeding click simply not appearing is feedback enough (the
 * server refusal stays loud in the reducer log).
 */
function ReactionRow({
  disabled,
  onSendReaction,
}: {
  disabled: boolean;
  onSendReaction: (emoji: ReactionEmoji) => void;
}) {
  return (
    <div style={reactionRowStyle}>
      {REACTION_EMOJIS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          style={reactionButtonStyle}
          aria-label={`リアクション ${emoji}`}
          disabled={disabled}
          onClick={blurringClick(() => onSendReaction(emoji))}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}

/**
 * The chat panel (ROADMAP Phase 2): the recent log — public messages and
 * this client's DMs merged — over the reaction palette and an input row.
 * An INPUT element on purpose — game.package/input.ts ignores key events
 * aimed at text entry, so typing here never walks the avatar.
 *
 * One input serves both kinds: `planDraft` classifies the draft (public,
 * @mention DM, or refused — the shared planChatDraft rules), and a refused
 * plan shows its reason WITHOUT sending anything; in particular a mention
 * that resolves to nobody never falls back to the public chat. An accepted
 * plan goes to `onSendPlan` whole — which reducer it means is the network
 * layer's dispatch (Net.sendPlanned), not this panel's. Rate limiting
 * mirrors the server's ONE chat bucket for both kinds (DMs charge
 * chat_guard server-side precisely so this mirror stays honest); the
 * mirror is UX — the server's verdict is the authority. The draft clears
 * on submit — the success signal is the message coming back through the
 * subscription into the log, and the rare send lost to a disconnect racing
 * the submit is cheaper to retype than every sent message is to clear by
 * hand.
 */
export function ChatPanel({
  connected,
  ownName,
  log,
  sendRefused,
  planDraft,
  onSendPlan,
  onSendReaction,
}: {
  connected: boolean;
  /** The authoritative name from the own player row; undefined without one. */
  ownName: string | undefined;
  /** The subscribed chat+DM history, ascending by send order. */
  log: ChatLog;
  /**
   * True after a send was dropped or refused server-side (e.g. the
   * per-identity rate bucket shared with another tab, or a DM recipient
   * who left mid-flight): the draft was already cleared, so this notice is
   * the only trace the sender gets.
   */
  sendRefused: boolean;
  /** Classifies one draft (public / DM / refused) — see Net.planChatSend. */
  planDraft: (draft: string) => ChatDraftPlan;
  /** Dispatches one accepted plan (public message or DM) — see Net.sendPlanned. */
  onSendPlan: (plan: PlannedSend) => void;
  /** Sends one palette-emoji reaction (fire-and-forget; see ReactionRow). */
  onSendReaction: (emoji: ReactionEmoji) => void;
}) {
  // The client-side mirror of the server's chat_guard token bucket.
  const allowanceRef = useRef(0n);
  // The marker as it stood before the most recent charge, so a refusal can
  // hand that token back — the authority never charged the refused send, and
  // without the rollback the mirror would rate-limit retries the server
  // would accept. One level of undo only: refusals cannot say WHICH send
  // failed, so with several in flight the mirror may still run one token
  // ahead — it is a UX aid, and the server verdict stays the authority.
  const chargedFromRef = useRef<bigint>(undefined);
  const logRef = useRef<HTMLDivElement>(null);

  // Keep the newest line in view. Scrolling on every log change also covers
  // the initial seed after (re)connecting.
  useEffect(() => {
    const el = logRef.current;
    if (el && log.length > 0) el.scrollTop = el.scrollHeight;
  }, [log]);

  // Refund the mirrored token when a send comes back refused.
  useEffect(() => {
    if (!sendRefused || chargedFromRef.current === undefined) return;
    allowanceRef.current = chargedFromRef.current;
    chargedFromRef.current = undefined;
  }, [sendRefused]);

  // The one gate for both send controls: the reaction row and the message
  // form need the same player row to speak from.
  const disabled = postingDisabled(connected, ownName);

  const submit = (draft: string): string | undefined => {
    const plan = planDraft(draft);
    if (plan.kind === 'refused') return REJECT_MESSAGES[plan.reason];
    const send = evaluateChatSend({
      allowanceMicros: allowanceRef.current,
      nowMicros: BigInt(Date.now()) * 1000n,
    });
    if (!send.ok) return RATE_LIMITED_MESSAGE;
    chargedFromRef.current = allowanceRef.current;
    allowanceRef.current = send.allowanceMicros;
    onSendPlan(plan);
    return undefined;
  };

  return (
    <div style={panelStyle}>
      {log.length > 0 && (
        <div ref={logRef} role="log" aria-label="チャットログ" style={logStyle}>
          {log.map((m) => (
            <LogLine key={chatEntryKey(m)} entry={m} />
          ))}
        </div>
      )}
      <ReactionRow disabled={disabled} onSendReaction={onSendReaction} />
      <DraftForm
        disabled={disabled}
        placeholder="メッセージを送信"
        ariaLabel="チャット入力"
        buttonLabel="送信"
        clearOnSubmit={true}
        formStyle={formStyle}
        submit={submit}
      />
      {sendRefused && <span style={{ color: UI_ERROR_COLOR }}>{SEND_REFUSED_MESSAGE}</span>}
    </div>
  );
}
