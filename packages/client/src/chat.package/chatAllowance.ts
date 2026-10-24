import { evaluateChatSend } from '@kaede/shared';

/**
 * The client-side mirror of the server's chat_guard token bucket — ONE
 * bucket for public messages and DMs alike (DMs charge chat_guard
 * server-side precisely so this mirror stays honest). The mirror is UX
 * for instant feedback; the server's verdict is the authority.
 */
export interface AllowanceMirror {
  /** The bucket marker, as evaluateChatSend reads and advances it. */
  readonly allowanceMicros: bigint;
  /**
   * The marker as it stood before the most recent charge, so a refusal can
   * hand that token back — the authority never charged the refused send,
   * and without the rollback the mirror would rate-limit retries the
   * server would accept. One level of undo only: refusals cannot say WHICH
   * send failed, so with several in flight the mirror may still run one
   * token ahead. Undefined before the first charge and once refunded.
   */
  readonly chargedFromMicros: bigint | undefined;
}

/** Nothing charged yet: the epoch marker, the full burst available. */
export const FRESH_ALLOWANCE: AllowanceMirror = {
  allowanceMicros: 0n,
  chargedFromMicros: undefined,
};

/** Charges one send at `nowMicros`; undefined when the bucket refuses it. */
export function chargeSend(
  mirror: AllowanceMirror,
  nowMicros: bigint,
): AllowanceMirror | undefined {
  const send = evaluateChatSend({ allowanceMicros: mirror.allowanceMicros, nowMicros });
  if (!send.ok) return undefined;
  return { allowanceMicros: send.allowanceMicros, chargedFromMicros: mirror.allowanceMicros };
}

/**
 * Hands the charged marker back when a send came back refused (the
 * mirror unchanged otherwise). Consuming the marker is what makes a
 * replayed call safe — ChatPanel calls this during render: it can never
 * refund twice.
 */
export function refundRefused(mirror: AllowanceMirror, sendRefused: boolean): AllowanceMirror {
  if (!sendRefused || mirror.chargedFromMicros === undefined) return mirror;
  return { allowanceMicros: mirror.chargedFromMicros, chargedFromMicros: undefined };
}
