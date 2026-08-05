// fallow-ignore-file coverage-gaps -- a React chat panel; needs a DOM, and no DOM test environment is configured. The validation and rate rules it relies on are normalizeChatText / evaluateChatSend, unit-tested in @kaede/shared
import {
  CHAT_SCOPE_SPACE,
  CHAT_TEXT_MAX_LENGTH,
  type ChatDraftPlan,
  type ChatDraftRejectReason,
  type ChatScope,
  evaluateChatSend,
  fallbackChatScope,
  type PlannedSend,
  REACTION_EMOJIS,
  type ReactionEmoji,
} from '@kaede/shared';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { type ChatEntryView, type ChatLog, type ChatScopeView, chatEntryKey } from '../net.package';
import { NotificationControl } from '../notify.package';
import {
  UI_BUTTON_BG,
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
  // — and that '@' (fullwidth included) is what made this a DM.
  'dm-no-recipient': '宛先が見つかりません(@/＠で始まる発言は在室中の相手への DM になります)',
  'dm-ambiguous-recipient': '同じ表示名の人が複数いるため、DM を送れません',
  'dm-empty-body': 'DM の本文を入力してください',
};

const RATE_LIMITED_MESSAGE = '送信が速すぎます。少し待ってから送ってください';

const SEND_REFUSED_MESSAGE = '送信できませんでした。少し待ってからもう一度お試しください';

const SCOPE_LOST_MESSAGE =
  '選択していた送信先が無くなったため送信していません。送信先を確認してください';

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

const scopeRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 4,
  margin: 0,
  padding: 0,
  border: 'none',
};

const scopeLegendStyle: CSSProperties = {
  float: 'left', // a legend is a block box; floating keeps the row on one line
  padding: '0 4px 0 0',
  opacity: 0.7,
};

const scopeButtonStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  padding: '2px 8px',
  borderRadius: 999,
  border: UI_GOLD_BORDER_SOFT,
  background: 'transparent',
  color: UI_TEXT_COLOR,
  font: 'inherit',
  cursor: 'pointer',
};

/** The picked scope, filled so "where this goes" is readable at a glance. */
const scopeSelectedStyle: CSSProperties = {
  ...scopeButtonStyle,
  border: UI_GOLD_BORDER,
  background: UI_BUTTON_BG,
  color: UI_GOLD,
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

const scopeMarkStyle: CSSProperties = {
  opacity: 0.7,
};

const announcementLineStyle: CSSProperties = {
  padding: '2px 4px',
  borderRadius: 4,
  border: UI_GOLD_BORDER_SOFT,
  color: UI_GOLD,
};

/**
 * One log line. A DM line is marked apart from room chatter — the [DM] tag
 * and the → 宛先 in the DM accent color — because the log holds both and a
 * private line must never read as something the room saw. Only the sender
 * and the recipient ever hold the row (row-level security), so no
 * receiver-side filtering happens here.
 *
 * A public line carries its scope marker (ROADMAP Phase 3 増分④) for the
 * same reason: one log now merges 全体, this map's and the current group's
 * conversations, and a line whose audience is invisible reads as if it went
 * to everyone. An admin announcement is the marker plus the gold frame —
 * it is the one line that must not scroll past unnoticed.
 */
function LogLine({ entry }: { entry: ChatEntryView }) {
  return (
    <div style={entry.kind === 'chat' && entry.announcement ? announcementLineStyle : undefined}>
      <LineMark entry={entry} />
      <span style={senderStyle(entry.own)}>{entry.senderName}</span>
      <DmRecipient entry={entry} /> {entry.text}
    </div>
  );
}

/**
 * What a line leads with: [DM] for a private one, otherwise its scope
 * marker. Split from LogLine (with DmRecipient below) to keep these
 * uncovered arrows under the CRAP budget fallow enforces — the
 * backfillAccountName precedent, applied to JSX.
 */
function LineMark({ entry }: { entry: ChatEntryView }) {
  if (entry.kind === 'dm') return <span style={dmMarkStyle}>[DM] </span>;
  if (entry.scopeTag === undefined) return null;
  return <span style={scopeMarkStyle}>[{entry.scopeTag}] </span>;
}

/** The 宛先 a DM line ends its header with; nothing on a public line. */
function DmRecipient({ entry }: { entry: ChatEntryView }) {
  if (entry.kind !== 'dm') return null;
  return <span style={dmMarkStyle}> → {entry.recipientName}</span>;
}

/**
 * The send-scope selector (送信先スコープ切替): a radio group naming exactly
 * what a send would reach — 全体, this map, or the conversation group the
 * sender is in. The list comes from the net stack (which scopes exist is a
 * question about the authoritative rows), so a scope the server would
 * refuse is never offered and the 会話グループ choice simply disappears
 * when the sender walks out.
 *
 * Real radio inputs inside labels, not styled buttons: the group's
 * semantics come free (and the specs can ask for a radio by its label).
 * Each change blurs the input for the reason the palette rows use
 * blurringClick — a focused control eats the arrow keys the avatar walks
 * with.
 */
function ScopeRow({
  scopes,
  selected,
  disabled,
  onSelect,
}: {
  scopes: ChatScopeView;
  selected: ChatScope;
  disabled: boolean;
  onSelect: (scope: ChatScope) => void;
}) {
  return (
    <fieldset style={scopeRowStyle}>
      <legend style={scopeLegendStyle}>送信先</legend>
      {scopes.map((option) => (
        <label
          key={option.scope}
          style={option.scope === selected ? scopeSelectedStyle : scopeButtonStyle}
        >
          <input
            type="radio"
            name="chat-scope"
            checked={option.scope === selected}
            disabled={disabled}
            onChange={blurringClick(() => onSelect(option.scope))}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
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
 * The input's placeholder: the picked scope names the destination there
 * too, because the eye is in the input while the message is typed, not on
 * the highlighted pill above it.
 */
function placeholderFor(scopes: ChatScopeView, scope: ChatScope): string {
  return `${scopes.find((option) => option.scope === scope)?.label ?? ''}に送信`;
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
  scopes,
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
  /** The scopes a send may address right now, widest first (see ScopeRow). */
  scopes: ChatScopeView;
  /**
   * True after a send was dropped or refused server-side (e.g. the
   * per-identity rate bucket shared with another tab, or a DM recipient
   * who left mid-flight): the draft was already cleared, so this notice is
   * the only trace the sender gets.
   */
  sendRefused: boolean;
  /** Classifies one draft (public / DM / refused) — see Net.planChatSend. */
  planDraft: (draft: string) => ChatDraftPlan;
  /** Dispatches one accepted plan under the picked scope — see Net.sendPlanned. */
  onSendPlan: (plan: PlannedSend, scope: ChatScope) => void;
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
  // What the next send addresses. Held as a raw pick and reconciled against
  // the offered list on every render (fallbackChatScope): the offered list
  // changes underfoot — walking out of a zone, a huddle disbanding — and
  // the reconciliation is what keeps the control off a scope the send would
  // refuse without an effect chasing the change. The reconciled value is for
  // RENDERING only; a submit whose pick went stale refuses instead of
  // sending under the fallback (see `submit`).
  const [picked, setPicked] = useState<ChatScope>(CHAT_SCOPE_SPACE);
  const scope = fallbackChatScope(
    picked,
    scopes.map((option) => option.scope),
  );

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
    // The pick going stale means the offered list moved while the draft was
    // being typed (walking out of the group, the huddle disbanding).
    // Dispatching the reconciled fallback here would silently re-scope the
    // message to 全体 — for a CLOSED conversation, a confidentiality leak —
    // so the submit refuses and keeps the draft (the resolveChatRoute rule
    // that a message whose destination moved must fail loudly, applied one
    // layer earlier). Snapping the pick to the rendered fallback makes the
    // refusal one-shot: the NEXT submit goes where the control visibly says.
    // Only a PUBLIC plan is gated: a DM addresses the recipient the plan
    // resolved and ignores the scope selector (see Net.sendPlanned).
    if (plan.kind === 'public' && scope !== picked) {
      setPicked(scope);
      return SCOPE_LOST_MESSAGE;
    }
    const send = evaluateChatSend({
      allowanceMicros: allowanceRef.current,
      nowMicros: BigInt(Date.now()) * 1000n,
    });
    if (!send.ok) return RATE_LIMITED_MESSAGE;
    chargedFromRef.current = allowanceRef.current;
    allowanceRef.current = send.allowanceMicros;
    onSendPlan(plan, scope);
    return undefined;
  };

  return (
    <div style={panelStyle}>
      {/* At the top of the panel DMs land in — the setting lives with the
          feature it governs. Self-contained (the notifier is per-tab
          environment state, not connection state), so it takes no props
          and no posting gate. */}
      <NotificationControl />
      {log.length > 0 && (
        <div ref={logRef} role="log" aria-label="チャットログ" style={logStyle}>
          {log.map((m) => (
            <LogLine key={chatEntryKey(m)} entry={m} />
          ))}
        </div>
      )}
      <ReactionRow disabled={disabled} onSendReaction={onSendReaction} />
      <ScopeRow scopes={scopes} selected={scope} disabled={disabled} onSelect={setPicked} />
      <DraftForm
        disabled={disabled}
        placeholder={placeholderFor(scopes, scope)}
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
