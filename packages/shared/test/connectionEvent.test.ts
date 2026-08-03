import { describe, expect, it } from 'vitest';
import { DISCONNECT_INTENT_FRESH_MS, disconnectReasonFrom } from '../src/connectionEvent';

describe('disconnectReasonFrom', () => {
  it('intent 行がなければ unannounced(予告なしの切断)', () => {
    expect(disconnectReasonFrom(undefined)).toBe('unannounced');
  });

  it('新鮮な announce があれば idle(アイドル抑制の自主切断)', () => {
    expect(disconnectReasonFrom(0)).toBe('idle');
    expect(disconnectReasonFrom(1_500)).toBe('idle');
    expect(disconnectReasonFrom(DISCONNECT_INTENT_FRESH_MS)).toBe('idle');
  });

  it('古い announce は信じない(切断されないまま残った intent の誤ラベル防止)', () => {
    expect(disconnectReasonFrom(DISCONNECT_INTENT_FRESH_MS + 1)).toBe('unannounced');
    expect(disconnectReasonFrom(1000 * 60 * 60)).toBe('unannounced');
  });
});
