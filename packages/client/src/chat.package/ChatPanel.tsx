// fallow-ignore-file coverage-gaps -- a React chat panel; needs a DOM, and no DOM test environment is configured. The validation and rate rules it relies on are normalizeChatText / evaluateChatSend, unit-tested in @maple/shared
import {
  CHAT_TEXT_MAX_LENGTH,
  type ChatTextRejectReason,
  evaluateChatSend,
  normalizeChatText,
} from '@maple/shared';
import { type CSSProperties, useEffect, useRef } from 'react';
import type { ChatLog } from '../net.package';
import {
  UI_ERROR_COLOR,
  UI_FONT,
  UI_GOLD,
  UI_GOLD_BORDER,
  UI_PANEL_BG,
  UI_TEXT_COLOR,
} from '../theme';
import { DraftForm } from '../ui.package';

const REJECT_MESSAGES: Record<ChatTextRejectReason, string> = {
  empty: 'メッセージを入力してください',
  'too-long': `メッセージは${CHAT_TEXT_MAX_LENGTH}文字以内にしてください`,
  'forbidden-characters': '使用できない文字が含まれています',
};

const RATE_LIMITED_MESSAGE = '送信が速すぎます。少し待ってから送ってください';

const SEND_REFUSED_MESSAGE = '送信できませんでした。少し待ってからもう一度お試しください';

/**
 * When the chat input is unusable: sending needs a player row to speak from
 * (the server refuses otherwise), and ownName is defined exactly while one
 * exists — the same gate the rename form uses. A separate function (not
 * inlined) to keep the untestable component under the CRAP budget fallow
 * enforces for uncovered functions (the currentNameOf precedent).
 */
function chatDisabled(connected: boolean, ownName: string | undefined): boolean {
  return !connected || ownName === undefined;
}

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

/** The sender name lead-in; the local player's own lines get the gold accent. */
function senderStyle(own: boolean): CSSProperties {
  return { color: own ? UI_GOLD : UI_TEXT_COLOR, fontWeight: 'bold' };
}

/**
 * The global-scope chat panel (ROADMAP Phase 2 第一弾): the recent log over
 * an input row. An INPUT element on purpose — game.package/input.ts ignores
 * key events aimed at text entry, so typing here never walks the avatar.
 *
 * Sending validates and rate-limits with the exact rules the server
 * enforces (shared pure functions), so a message that leaves this form is
 * never refused for its content; the local token-bucket marker mirrors the
 * server's chat_guard purely as UX (the server's verdict is the authority).
 * The draft clears on submit — the success signal is the message coming
 * back through the subscription into the log, and the rare send lost to a
 * disconnect racing the submit is cheaper to retype than every sent
 * message is to clear by hand.
 */
export function ChatPanel({
  connected,
  ownName,
  log,
  sendRefused,
  onSend,
}: {
  connected: boolean;
  /** The authoritative name from the own player row; undefined without one. */
  ownName: string | undefined;
  /** The subscribed chat history, ascending by send order. */
  log: ChatLog;
  /**
   * True after a send was dropped or refused server-side (e.g. the
   * per-identity rate bucket shared with another tab): the draft was
   * already cleared, so this notice is the only trace the sender gets.
   */
  sendRefused: boolean;
  onSend: (text: string) => void;
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

  const submit = (draft: string): string | undefined => {
    const verdict = normalizeChatText(draft);
    if (!verdict.ok) return REJECT_MESSAGES[verdict.reason];
    const send = evaluateChatSend({
      allowanceMicros: allowanceRef.current,
      nowMicros: BigInt(Date.now()) * 1000n,
    });
    if (!send.ok) return RATE_LIMITED_MESSAGE;
    chargedFromRef.current = allowanceRef.current;
    allowanceRef.current = send.allowanceMicros;
    onSend(verdict.text);
    return undefined;
  };

  return (
    <div style={panelStyle}>
      {log.length > 0 && (
        <div ref={logRef} role="log" aria-label="チャットログ" style={logStyle}>
          {log.map((m) => (
            <div key={m.id.toString()}>
              <span style={senderStyle(m.own)}>{m.senderName}</span> {m.text}
            </div>
          ))}
        </div>
      )}
      <DraftForm
        disabled={chatDisabled(connected, ownName)}
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
