// fallow-ignore-file coverage-gaps -- a React chat panel; needs a DOM, and no DOM test environment is configured. The validation and rate rules it relies on are normalizeChatText / evaluateChatSend, unit-tested in @kaede/shared; the allowance mirror over them is chatAllowance.ts (unit-tested)
import {
  CHAT_SCOPE_SPACE,
  CHAT_TEXT_MAX_LENGTH,
  type ChatDraftPlan,
  type ChatDraftRejectReason,
  type ChatScope,
  fallbackChatScope,
  type GestureKind,
  type PlannedSend,
  type ReactionEmoji,
} from '@kaede/shared';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { type ChatLog, type ChatScopeView, chatEntryKey } from '../net.package';
import { NotificationControl } from '../notify.package';
import { UI_ERROR_COLOR, UI_STACKED_PANEL_STYLE } from '../theme';
import { DraftForm, postingDisabled } from '../ui.package';
import { chargeSend, FRESH_ALLOWANCE, refundRefused } from './chatAllowance';
import { LogLine } from './LogLine';
import { GESTURE_PALETTE, PaletteRow, REACTION_PALETTE } from './PaletteRow';
import { ScopeRow } from './ScopeRow';

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
  ...UI_STACKED_PANEL_STYLE,
  padding: 8,
  position: 'absolute',
  bottom: 12,
  right: 12,
  width: 300,
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
 * mirrors the server's ONE chat bucket for both kinds (chatAllowance.ts);
 * the mirror is UX — the server's verdict is the authority. The draft clears
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
  onPlayGesture,
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
  /** Sends one palette-emoji reaction (fire-and-forget; see REACTION_PALETTE). */
  onSendReaction: (emoji: ReactionEmoji) => void;
  /** Plays one pose gesture (fire-and-forget; see GESTURE_PALETTE — ①c). */
  onPlayGesture: (gesture: GestureKind) => void;
}) {
  // The client-side mirror of the server's chat_guard token bucket, with
  // its one-level refund on refusal (chatAllowance.ts).
  const allowanceRef = useRef(FRESH_ALLOWANCE);
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

  // Refund the mirrored token when a send comes back refused — during render
  // (the when-a-prop-changes pattern), so the rollback lands in the same
  // commit that paints the refusal notice.
  // oxlint-disable-next-line react/refs -- 意図的な render 中の調整（上のコメント参照）
  allowanceRef.current = refundRefused(allowanceRef.current, sendRefused);

  // The one gate for both send controls: the reaction row and the message
  // form need the same player row to speak from.
  const disabled = postingDisabled(connected, ownName);

  // The stale-pick gate: the pick going stale (scope !== picked) means the
  // offered list moved while the draft was being typed — walking out of
  // the group, the huddle disbanding. Dispatching the reconciled fallback
  // then would silently re-scope the message to 全体 — for a CLOSED
  // conversation, a confidentiality leak — so the submit refuses and keeps
  // the draft (the resolveChatRoute rule that a message whose destination
  // moved must fail loudly, applied one layer earlier). Snapping the pick
  // to the rendered fallback makes the refusal one-shot: the NEXT submit
  // goes where the control visibly says. Only a PUBLIC plan is gated: a DM
  // addresses the recipient the plan resolved and ignores the scope
  // selector (see Net.sendPlanned). Split from `submit` to keep both
  // uncovered functions under the CRAP budget fallow enforces (the
  // backfillAccountName precedent).
  const refuseStaleScope = (plan: PlannedSend): string | undefined => {
    if (plan.kind !== 'public' || scope === picked) return undefined;
    setPicked(scope);
    return SCOPE_LOST_MESSAGE;
  };

  const submit = (draft: string): string | undefined => {
    const plan = planDraft(draft);
    if (plan.kind === 'refused') return REJECT_MESSAGES[plan.reason];
    const staleRefusal = refuseStaleScope(plan);
    if (staleRefusal !== undefined) return staleRefusal;
    const charged = chargeSend(allowanceRef.current, BigInt(Date.now()) * 1000n);
    if (charged === undefined) return RATE_LIMITED_MESSAGE;
    allowanceRef.current = charged;
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
      <PaletteRow palette={REACTION_PALETTE} disabled={disabled} onPick={onSendReaction} />
      <PaletteRow palette={GESTURE_PALETTE} disabled={disabled} onPick={onPlayGesture} />
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
