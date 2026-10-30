import { CHAT_BURST_MESSAGES, CHAT_SEND_COST_MICROS } from '@kaede/shared';
import { describe, expect, it } from 'vite-plus/test';
import {
  type AllowanceMirror,
  chargeSend,
  FRESH_ALLOWANCE,
  refundRefused,
} from '../src/chat.package/chatAllowance';

const NOW = 1_000_000_000_000n;

/** Charges `count` sends at NOW, failing the test if the bucket refuses one. */
function chargeBurst(count: number): AllowanceMirror {
  let mirror = FRESH_ALLOWANCE;
  for (let i = 0; i < count; i++) {
    const charged = chargeSend(mirror, NOW);
    if (charged === undefined) throw new Error(`send ${i + 1} should have been accepted`);
    mirror = charged;
  }
  return mirror;
}

describe('chargeSend', () => {
  it('advances the marker and remembers where it stood before the charge', () => {
    const first = chargeSend(FRESH_ALLOWANCE, NOW);
    expect(first?.chargedFromMicros).toBe(FRESH_ALLOWANCE.allowanceMicros);
    const second = first && chargeSend(first, NOW);
    expect(second?.chargedFromMicros).toBe(first?.allowanceMicros);
    expect(second?.allowanceMicros).toBe((first?.allowanceMicros ?? 0n) + CHAT_SEND_COST_MICROS);
  });

  it('refuses the send past the burst, like the server bucket', () => {
    expect(chargeSend(chargeBurst(CHAT_BURST_MESSAGES), NOW)).toBeUndefined();
  });
});

describe('refundRefused', () => {
  it('leaves the mirror alone while no send was refused', () => {
    const mirror = chargeBurst(1);
    expect(refundRefused(mirror, false)).toBe(mirror);
  });

  it('hands the last charge back once, consuming the marker', () => {
    const full = chargeBurst(CHAT_BURST_MESSAGES);
    const refunded = refundRefused(full, true);
    expect(refunded).toEqual({
      allowanceMicros: full.chargedFromMicros,
      chargedFromMicros: undefined,
    });
    // The refunded token is spendable again — the retry the server would accept.
    expect(chargeSend(refunded, NOW)).toBeDefined();
    // A replayed render cannot refund a second time.
    expect(refundRefused(refunded, true)).toBe(refunded);
  });

  it('has nothing to hand back before the first charge', () => {
    expect(refundRefused(FRESH_ALLOWANCE, true)).toBe(FRESH_ALLOWANCE);
  });
});
