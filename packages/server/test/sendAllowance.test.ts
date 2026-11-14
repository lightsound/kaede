import { evaluateChatSend } from '@kaede/shared';
import { SenderError } from 'spacetimedb/server';
import { describe, expect, it } from 'vite-plus/test';
import { chargeSendAllowance } from '../src/sendAllowance';
import { as, at, makeHarness } from './harness';

// Characterization tests for the send-rate charge, run against the
// official module test harness (see harness.ts): the bucket rule is
// evaluateSendAllowance in @kaede/shared (pinned there); what these pin
// is the glue — the missing guard row reads as the epoch marker, the
// verdict writes back onto the sender's row (insert first, then
// update), and a refusal throws without writing.

describe('chargeSendAllowance', () => {
  it('creates the marker row lazily on the first charge, banked to one full burst', () => {
    const harness = makeHarness(100_000);
    const marker = as(harness, 'user_alice', (ctx) => {
      chargeSendAllowance(ctx, ctx.db.chatGuard, evaluateChatSend, 'send_test');
      return ctx.db.chatGuard.identity.find(ctx.sender)?.allowanceMicros;
    });
    // now=100s in micros; the bank floor is now − (burst−1)·cost = 96s,
    // and the first charge advances the marker one cost past it.
    expect(marker).toBe(97_000_000n);
  });

  it('updates the existing marker on later charges', () => {
    const harness = makeHarness(100_000);
    const marker = as(harness, 'user_alice', (ctx) => {
      chargeSendAllowance(ctx, ctx.db.chatGuard, evaluateChatSend, 'send_test');
      chargeSendAllowance(ctx, ctx.db.chatGuard, evaluateChatSend, 'send_test');
      return ctx.db.chatGuard.identity.find(ctx.sender)?.allowanceMicros;
    });
    expect(marker).toBe(98_000_000n);
  });

  it('refuses the sixth rapid send and writes nothing', () => {
    const harness = makeHarness(100_000);
    const seen = as(harness, 'user_alice', (ctx) => {
      for (let i = 0; i < 5; i++) {
        chargeSendAllowance(ctx, ctx.db.chatGuard, evaluateChatSend, 'send_test');
      }
      let refusal: unknown;
      try {
        chargeSendAllowance(ctx, ctx.db.chatGuard, evaluateChatSend, 'send_test');
      } catch (error) {
        refusal = error;
      }
      return { refusal, marker: ctx.db.chatGuard.identity.find(ctx.sender)?.allowanceMicros };
    });
    expect(seen.refusal).toBeInstanceOf(SenderError);
    expect((seen.refusal as Error).message).toBe('send_test refused (rate-limited)');
    expect(seen.marker).toBe(101_000_000n);
  });

  it('charges again once the bucket has refilled', () => {
    const harness = makeHarness(100_000);
    as(harness, 'user_alice', (ctx) => {
      for (let i = 0; i < 5; i++) {
        chargeSendAllowance(ctx, ctx.db.chatGuard, evaluateChatSend, 'send_test');
      }
    });
    harness.clock.set(at(102_000));
    const marker = as(harness, 'user_alice', (ctx) => {
      chargeSendAllowance(ctx, ctx.db.chatGuard, evaluateChatSend, 'send_test');
      return ctx.db.chatGuard.identity.find(ctx.sender)?.allowanceMicros;
    });
    expect(marker).toBe(102_000_000n);
  });
});
