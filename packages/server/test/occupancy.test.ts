import { describe, expect, it } from 'vite-plus/test';
import {
  cleanupEmptyHuddle,
  otherHuddleMemberPositions,
  recomputeZoneOccupancyOnMap,
  syncGroupOccupancy,
} from '../src/occupancy';
import { asModule, identityFor, makeHarness, type Harness } from './harness';

// Characterization tests for the occupancy glue in occupancy.ts, run
// against the official module test harness (see harness.ts). The
// geometry rules (zone hysteresis / overlap priority, the huddle
// walk-away rule) are pinned in @kaede/shared; these pin the writes the
// glue performs: membership insert / update / delete only on actual
// transitions, huddle stickiness, and the empty-huddle cleanup.

const ALICE = 'user_alice';
const BOB = 'user_bob';

function seedZone(harness: Harness, over: { mapId?: number } = {}): bigint {
  return asModule(
    harness,
    (ctx) =>
      ctx.db.conversationGroup.insert({
        id: 0n,
        kind: 'zone',
        name: 'room',
        closed: false,
        mapId: over.mapId ?? 0,
        x: 100,
        y: 100,
        w: 200,
        h: 200,
      }).id,
  );
}

function seedPlayer(harness: Harness, sub: string, x: number, y: number, mapId = 0) {
  const identity = identityFor(harness, sub);
  asModule(harness, (ctx) => {
    ctx.db.player.insert({
      identity,
      x,
      y,
      vx: 0,
      vy: 0,
      facing: 1,
      onGround: false,
      rope: -1,
      tick: 0,
      online: true,
      updatedAt: ctx.timestamp,
      mapId,
    });
  });
  return identity;
}

function membership(harness: Harness, sub: string): bigint | null {
  const identity = identityFor(harness, sub);
  return asModule(harness, (ctx) => ctx.db.groupMember.identity.find(identity)?.groupId ?? null);
}

describe('syncGroupOccupancy zone transitions', () => {
  it('inserts a membership when the player walks into a zone', () => {
    const harness = makeHarness();
    const zoneId = seedZone(harness);
    const alice = identityFor(harness, ALICE);
    asModule(harness, (ctx) => syncGroupOccupancy(ctx, alice, { x: 150, y: 150 }, 0));
    expect(membership(harness, ALICE)).toBe(zoneId);
  });

  // The no-write half of the contract (a same-zone pass must not
  // broadcast an unchanged group_member update) is not observable
  // through the harness — it exposes no write/delta channel, and an
  // update writing identical values leaves the state byte-identical.
  // This pins the observable half: the membership stays the zone's.
  it('keeps the same membership while the player stays in the same zone', () => {
    const harness = makeHarness();
    const zoneId = seedZone(harness);
    const alice = identityFor(harness, ALICE);
    asModule(harness, (ctx) => {
      ctx.db.groupMember.insert({ identity: alice, groupId: zoneId });
      syncGroupOccupancy(ctx, alice, { x: 160, y: 160 }, 0);
      return null;
    });
    expect(membership(harness, ALICE)).toBe(zoneId);
  });

  it('deletes the membership when the player walks out of every zone', () => {
    const harness = makeHarness();
    const zoneId = seedZone(harness);
    const alice = identityFor(harness, ALICE);
    asModule(harness, (ctx) => ctx.db.groupMember.insert({ identity: alice, groupId: zoneId }));
    asModule(harness, (ctx) => syncGroupOccupancy(ctx, alice, { x: 900, y: 900 }, 0));
    expect(membership(harness, ALICE)).toBeNull();
  });

  it('ignores zones placed on other maps', () => {
    const harness = makeHarness();
    seedZone(harness, { mapId: 3 });
    const alice = identityFor(harness, ALICE);
    asModule(harness, (ctx) => syncGroupOccupancy(ctx, alice, { x: 150, y: 150 }, 0));
    expect(membership(harness, ALICE)).toBeNull();
  });
});

describe('syncGroupOccupancy huddle stickiness', () => {
  function huddleSetup(harness: Harness) {
    const zoneId = seedZone(harness);
    const huddleId = asModule(
      harness,
      (ctx) =>
        ctx.db.conversationGroup.insert({
          id: 0n,
          kind: 'huddle',
          name: 'h',
          closed: false,
          mapId: 0,
          x: 0,
          y: 0,
          w: 10,
          h: 10,
        }).id,
    );
    const alice = identityFor(harness, ALICE);
    const bob = seedPlayer(harness, BOB, 120, 120);
    asModule(harness, (ctx) => {
      ctx.db.groupMember.insert({ identity: alice, groupId: huddleId });
      ctx.db.groupMember.insert({ identity: bob, groupId: huddleId });
    });
    return { zoneId, huddleId, alice, bob };
  }

  it('keeps the huddle membership while a member stands inside a zone', () => {
    const harness = makeHarness();
    const { huddleId, alice } = huddleSetup(harness);
    asModule(harness, (ctx) => syncGroupOccupancy(ctx, alice, { x: 150, y: 150 }, 0));
    expect(membership(harness, ALICE)).toBe(huddleId);
  });

  it('drops the huddle membership after walking away, then rules zones in the same pass', () => {
    const harness = makeHarness();
    const { zoneId, alice, bob } = huddleSetup(harness);
    asModule(harness, (ctx) => {
      const row = ctx.db.player.identity.find(bob)!;
      ctx.db.player.identity.update({ ...row, x: 5_000, y: 5_000 });
    });
    asModule(harness, (ctx) => syncGroupOccupancy(ctx, alice, { x: 150, y: 150 }, 0));
    expect(membership(harness, ALICE)).toBe(zoneId);
  });
});

describe('cleanupEmptyHuddle / otherHuddleMemberPositions', () => {
  it('deletes an empty huddle and its call row, but never a zone', () => {
    const harness = makeHarness();
    const zoneId = seedZone(harness);
    const huddleId = asModule(harness, (ctx) => {
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
      return group.id;
    });
    asModule(harness, (ctx) => {
      cleanupEmptyHuddle(ctx, huddleId);
      cleanupEmptyHuddle(ctx, zoneId);
    });
    const seen = asModule(harness, (ctx) => ({
      huddle: ctx.db.conversationGroup.id.find(huddleId),
      call: ctx.db.groupCall.groupId.find(huddleId),
      zone: ctx.db.conversationGroup.id.find(zoneId),
    }));
    expect(seen.huddle).toBeNull();
    expect(seen.call).toBeNull();
    expect(seen.zone).not.toBeNull();
  });

  it('keeps a huddle that still has members', () => {
    const harness = makeHarness();
    const bob = identityFor(harness, BOB);
    const huddleId = asModule(harness, (ctx) => {
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
      ctx.db.groupMember.insert({ identity: bob, groupId: group.id });
      return group.id;
    });
    asModule(harness, (ctx) => cleanupEmptyHuddle(ctx, huddleId));
    expect(asModule(harness, (ctx) => ctx.db.conversationGroup.id.find(huddleId))).not.toBeNull();
  });

  it('collects the positions of the other members only', () => {
    const harness = makeHarness();
    const alice = identityFor(harness, ALICE);
    const bob = seedPlayer(harness, BOB, 42, 43);
    const positions = asModule(harness, (ctx) => {
      const huddle = ctx.db.conversationGroup.insert({
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
      ctx.db.groupMember.insert({ identity: alice, groupId: huddle.id });
      ctx.db.groupMember.insert({ identity: bob, groupId: huddle.id });
      return otherHuddleMemberPositions(ctx, huddle.id, alice);
    });
    expect(positions).toEqual([{ x: 42, y: 43 }]);
  });
});

describe('recomputeZoneOccupancyOnMap', () => {
  it('re-rules the players standing on the edited map only', () => {
    const harness = makeHarness();
    const zoneId = seedZone(harness);
    // A covering zone on Bob's map too: his empty membership after the
    // map-0 pass can then only come from recompute's own map filter,
    // not from zonesOnMap finding nothing for him.
    const bobZoneId = seedZone(harness, { mapId: 2 });
    seedPlayer(harness, ALICE, 150, 150);
    seedPlayer(harness, BOB, 150, 150, 2);
    asModule(harness, (ctx) => recomputeZoneOccupancyOnMap(ctx, 0));
    expect(membership(harness, ALICE)).toBe(zoneId);
    expect(membership(harness, BOB)).toBeNull();
    asModule(harness, (ctx) => recomputeZoneOccupancyOnMap(ctx, 2));
    expect(membership(harness, BOB)).toBe(bobZoneId);
  });
});
