import { describe, expect, it } from 'vite-plus/test';
import {
  findPostingSender,
  guestsAllowed,
  membershipOf,
  removePlayer,
  requireAdmin,
  spawnOrResume,
  sweepExpiredRows,
  sweepOrphanedSiblings,
  syncNameOnline,
  trimHistory,
} from '../src/world';
import { as, asModule, at, identityFor, makeHarness, type Harness } from './harness';

// Characterization tests for the player-lifecycle and admission glue in
// world.ts, run against the official module test harness (see
// harness.ts) — the real schema and table semantics, not a fake. The
// rules world.ts delegates (admission, name precedence, expiry) are
// pinned in @kaede/shared; these pin what world.ts itself does with the
// rows: which tables each path reads, writes and deletes.

const ALICE = 'user_alice';
const BOB = 'user_bob';

function seedMember(harness: Harness, sub: string, role: string) {
  const identity = identityFor(harness, sub);
  asModule(harness, (ctx) => {
    ctx.db.spaceMember.insert({
      identity,
      displayName: 'Member',
      status: 'approved',
      role,
      requestedAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
  });
  return identity;
}

function seedPlayerRows(harness: Harness, sub: string) {
  const identity = identityFor(harness, sub);
  asModule(harness, (ctx) => {
    ctx.db.player.insert({
      identity,
      x: 200,
      y: 300,
      vx: 0,
      vy: 0,
      facing: 1,
      onGround: false,
      rope: -1,
      tick: 0,
      online: true,
      updatedAt: ctx.timestamp,
      mapId: 0,
    });
    ctx.db.playerName.insert({ identity, name: 'P', online: true });
    ctx.db.playerGuard.insert({ identity, allowanceMicros: 1n });
  });
  return identity;
}

describe('membershipOf / requireAdmin / guestsAllowed', () => {
  it('reads the membership standing off the space_member row', () => {
    const harness = makeHarness();
    expect(as(harness, ALICE, (ctx) => membershipOf(ctx, ctx.sender))).toBeUndefined();
    seedMember(harness, ALICE, 'admin');
    expect(as(harness, ALICE, (ctx) => membershipOf(ctx, ctx.sender))).toEqual({
      status: 'approved',
      role: 'admin',
    });
  });

  it('lets an acting admin through and refuses members and guests by name', () => {
    const harness = makeHarness();
    expect(() => as(harness, ALICE, (ctx) => requireAdmin(ctx, 'set_space_setting'))).toThrow(
      'set_space_setting refused (not-admin)',
    );
    seedMember(harness, ALICE, 'member');
    expect(() => as(harness, ALICE, (ctx) => requireAdmin(ctx, 'set_space_setting'))).toThrow(
      'set_space_setting refused (not-admin)',
    );
    const alice = identityFor(harness, ALICE);
    asModule(harness, (ctx) => {
      const row = ctx.db.spaceMember.identity.find(alice)!;
      ctx.db.spaceMember.identity.update({ ...row, role: 'admin' });
    });
    expect(() => as(harness, ALICE, (ctx) => requireAdmin(ctx, 'set_space_setting'))).not.toThrow();
  });

  it('reads a missing setting row as guests allowed', () => {
    const harness = makeHarness();
    expect(as(harness, ALICE, (ctx) => guestsAllowed(ctx))).toBe(true);
    asModule(harness, (ctx) => ctx.db.spaceSetting.insert({ id: 0, guestsAllowed: false }));
    expect(as(harness, ALICE, (ctx) => guestsAllowed(ctx))).toBe(false);
  });
});

describe('trimHistory', () => {
  it('deletes only the oldest rows beyond the cap', () => {
    const harness = makeHarness();
    const remaining = asModule(harness, (ctx) => {
      for (let i = 0; i < 5; i++) {
        ctx.db.conversationGroup.insert({
          id: 0n,
          kind: 'zone',
          name: `z${i}`,
          closed: false,
          mapId: 0,
          x: 0,
          y: 0,
          w: 1,
          h: 1,
        });
      }
      trimHistory(ctx.db.conversationGroup, 3);
      return [...ctx.db.conversationGroup.iter()].map((row) => row.name);
    });
    expect(remaining).toEqual(['z2', 'z3', 'z4']);
  });
});

describe('removePlayer', () => {
  it('deletes the player rows and every lazy guard row of the identity', () => {
    const harness = makeHarness();
    const alice = seedPlayerRows(harness, ALICE);
    asModule(harness, (ctx) => {
      // Every identity-keyed table removePlayer sweeps (world.ts's
      // identityKeyed list): the three player_* siblings seeded above,
      // the public reaction / gesture / player_status rows, and the
      // lazy guard tables (playerGuard arrived with the siblings).
      ctx.db.chatGuard.insert({ identity: alice, allowanceMicros: 1n });
      ctx.db.reaction.insert({ identity: alice, emoji: '👍', sentAt: ctx.timestamp });
      ctx.db.reactionGuard.insert({ identity: alice, allowanceMicros: 1n });
      ctx.db.gesture.insert({ identity: alice, gesture: 'wave', sentAt: ctx.timestamp });
      ctx.db.gestureGuard.insert({ identity: alice, allowanceMicros: 1n });
      ctx.db.playerStatus.insert({ identity: alice, availability: 'online', text: '' });
      ctx.db.statusGuard.insert({ identity: alice, allowanceMicros: 1n });
      ctx.db.portalGuard.insert({ identity: alice, allowanceMicros: 1n });
      ctx.db.huddleGuard.insert({ identity: alice, allowanceMicros: 1n });
      ctx.db.callGuard.insert({ identity: alice, allowanceMicros: 1n });
    });
    asModule(harness, (ctx) => removePlayer(ctx, alice));
    const remaining = asModule(harness, (ctx) =>
      [
        ctx.db.player,
        ctx.db.playerName,
        ctx.db.playerGuard,
        ctx.db.chatGuard,
        ctx.db.reaction,
        ctx.db.reactionGuard,
        ctx.db.gesture,
        ctx.db.gestureGuard,
        ctx.db.playerStatus,
        ctx.db.statusGuard,
        ctx.db.portalGuard,
        ctx.db.huddleGuard,
        ctx.db.callGuard,
        ctx.db.groupMember,
      ].filter((table) => table.identity.find(alice) !== null),
    );
    expect(remaining).toEqual([]);
  });

  it("cleans up the player's huddle when its last member leaves", () => {
    const harness = makeHarness();
    const alice = seedPlayerRows(harness, ALICE);
    const groupId = asModule(harness, (ctx) => {
      const group = ctx.db.conversationGroup.insert({
        id: 0n,
        kind: 'huddle',
        name: 'h',
        closed: false,
        mapId: 0,
        x: 0,
        y: 0,
        w: 10,
        h: 10,
      });
      ctx.db.groupCall.insert({ groupId: group.id, meetingId: 'm-1' });
      ctx.db.groupMember.insert({ identity: alice, groupId: group.id });
      return group.id;
    });
    asModule(harness, (ctx) => removePlayer(ctx, alice));
    const gone = asModule(
      harness,
      (ctx) =>
        ctx.db.groupMember.identity.find(alice) === null &&
        ctx.db.conversationGroup.id.find(groupId) === null &&
        ctx.db.groupCall.groupId.find(groupId) === null,
    );
    expect(gone).toBe(true);
  });
});

describe('spawnOrResume', () => {
  it('spawns a fresh player at the spawn point with its sibling rows', () => {
    const harness = makeHarness(100_000);
    as(harness, ALICE, (ctx) => spawnOrResume(ctx));
    const alice = identityFor(harness, ALICE);
    const seen = asModule(harness, (ctx) => ({
      player: ctx.db.player.identity.find(alice),
      name: ctx.db.playerName.identity.find(alice),
      guard: ctx.db.playerGuard.identity.find(alice),
    }));
    expect(seen.player).toMatchObject({ x: 200, online: true, mapId: 0 });
    expect(seen.player?.y).toBeGreaterThan(0);
    expect(seen.name).toEqual({
      identity: alice,
      name: `Player-${alice.toHexString().slice(0, 6)}`,
      online: true,
    });
    expect(seen.guard?.allowanceMicros).toBe(100_000_000n);
  });

  it('prefers the persisted account name and resumes the surviving row in place', () => {
    const harness = makeHarness(100_000);
    const alice = identityFor(harness, ALICE);
    asModule(harness, (ctx) => {
      ctx.db.account.insert({
        id: 0n,
        identity: alice,
        displayName: 'Persisted',
        createdAt: ctx.timestamp,
        updatedAt: ctx.timestamp,
        subject: '',
      });
      ctx.db.player.insert({
        identity: alice,
        x: 555,
        y: 300,
        vx: 0,
        vy: 0,
        facing: 1,
        onGround: false,
        rope: -1,
        tick: 0,
        online: false,
        updatedAt: ctx.timestamp,
        mapId: 0,
      });
      ctx.db.playerName.insert({ identity: alice, name: 'Old', online: false });
    });
    harness.clock.set(at(200_000));
    as(harness, ALICE, (ctx) => spawnOrResume(ctx));
    const seen = asModule(harness, (ctx) => ({
      player: ctx.db.player.identity.find(alice),
      name: ctx.db.playerName.identity.find(alice),
    }));
    expect(seen.name).toEqual({ identity: alice, name: 'Persisted', online: true });
    expect(seen.player).toMatchObject({ x: 555, online: true });
    expect(seen.player?.updatedAt.microsSinceUnixEpoch).toBe(200_000_000n);
  });
});

describe('syncNameOnline', () => {
  // The no-write half of the contract (an unchanged mirror must not
  // broadcast) is not observable through the harness — it exposes no
  // write/delta channel, and an update writing identical values leaves
  // the state byte-identical. These pin the observable half: the row's
  // content tracks the flag exactly.
  it('mirrors the flag when it flips and leaves the row content as-is when it does not', () => {
    const harness = makeHarness();
    const alice = seedPlayerRows(harness, ALICE);
    const seen = asModule(harness, (ctx) => {
      const row = ctx.db.playerName.identity.find(alice)!;
      syncNameOnline(ctx, row, true);
      const afterNoop = ctx.db.playerName.identity.find(alice);
      syncNameOnline(ctx, row, false);
      return { afterNoop, afterFlip: ctx.db.playerName.identity.find(alice) };
    });
    expect(seen.afterNoop?.online).toBe(true);
    expect(seen.afterFlip?.online).toBe(false);
  });
});

describe('findPostingSender', () => {
  it('throws not-in-world when the sender has no player row', () => {
    const harness = makeHarness();
    expect(() => as(harness, ALICE, (ctx) => findPostingSender(ctx, 'send_chat_message'))).toThrow(
      'send_chat_message refused (not-in-world)',
    );
  });

  it('returns the three world rows for an admitted sender', () => {
    const harness = makeHarness();
    const alice = seedPlayerRows(harness, ALICE);
    const rows = as(harness, ALICE, (ctx) => findPostingSender(ctx, 'send_chat_message'));
    expect(rows?.row.identity.toHexString()).toBe(alice.toHexString());
    expect(rows?.guard.allowanceMicros).toBe(1n);
    expect(rows?.nameRow).toEqual({ identity: alice, name: 'P', online: true });
  });

  it('reclaims a broken pair (missing guard) instead of acting on it', () => {
    const harness = makeHarness();
    const alice = identityFor(harness, ALICE);
    asModule(harness, (ctx) => {
      ctx.db.player.insert({
        identity: alice,
        x: 200,
        y: 300,
        vx: 0,
        vy: 0,
        facing: 1,
        onGround: false,
        rope: -1,
        tick: 0,
        online: true,
        updatedAt: ctx.timestamp,
        mapId: 0,
      });
      ctx.db.playerName.insert({ identity: alice, name: 'P', online: true });
    });
    expect(
      as(harness, ALICE, (ctx) => findPostingSender(ctx, 'send_chat_message')),
    ).toBeUndefined();
    const gone = asModule(
      harness,
      (ctx) =>
        ctx.db.player.identity.find(alice) === null &&
        ctx.db.playerName.identity.find(alice) === null,
    );
    expect(gone).toBe(true);
  });

  it('reclaims the rows of a sender the admission rules would now refuse', () => {
    const harness = makeHarness();
    const alice = seedPlayerRows(harness, ALICE);
    asModule(harness, (ctx) => ctx.db.spaceSetting.insert({ id: 0, guestsAllowed: false }));
    expect(
      as(harness, ALICE, (ctx) => findPostingSender(ctx, 'send_chat_message')),
    ).toBeUndefined();
    expect(asModule(harness, (ctx) => ctx.db.player.identity.find(alice))).toBeNull();
  });
});

describe('sweeps', () => {
  it('sweepExpiredRows removes only rows past the retention window', () => {
    const harness = makeHarness(700_000);
    const alice = identityFor(harness, ALICE);
    const bob = seedPlayerRows(harness, BOB);
    asModule(harness, (ctx) => {
      ctx.db.player.insert({
        identity: alice,
        x: 200,
        y: 300,
        vx: 0,
        vy: 0,
        facing: 1,
        onGround: false,
        rope: -1,
        tick: 0,
        online: false,
        updatedAt: at(0),
        mapId: 0,
      });
    });
    asModule(harness, (ctx) => sweepExpiredRows(ctx));
    expect(asModule(harness, (ctx) => ctx.db.player.identity.find(alice))).toBeNull();
    expect(asModule(harness, (ctx) => ctx.db.player.identity.find(bob))).not.toBeNull();
  });

  it('sweepOrphanedSiblings reclaims sibling rows whose player row is gone', () => {
    const harness = makeHarness();
    const bob = seedPlayerRows(harness, BOB);
    const alice = identityFor(harness, ALICE);
    asModule(harness, (ctx) => {
      ctx.db.playerName.insert({ identity: alice, name: 'Ghost', online: true });
      ctx.db.playerGuard.insert({ identity: alice, allowanceMicros: 1n });
    });
    asModule(harness, (ctx) => sweepOrphanedSiblings(ctx));
    const seen = asModule(harness, (ctx) => ({
      ghostName: ctx.db.playerName.identity.find(alice),
      ghostGuard: ctx.db.playerGuard.identity.find(alice),
      bobName: ctx.db.playerName.identity.find(bob),
    }));
    expect(seen.ghostName).toBeNull();
    expect(seen.ghostGuard).toBeNull();
    expect(seen.bobName).not.toBeNull();
  });
});
