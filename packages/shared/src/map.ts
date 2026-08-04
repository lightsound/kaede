import { PLAYER_HALF_H, PLAYER_HALF_W } from './constants';
import { overlaps } from './physics';
import {
  evaluateSendAllowance,
  type SendAllowanceRequest,
  type SendAllowanceVerdict,
} from './sendAllowance';
import type { CollisionMap, PlayerInput, PlayerState, Rect } from './types';

export const WORLD_WIDTH = 3840;
export const WORLD_HEIGHT = 720;

/** y coordinate of the walkable ground surface (shared by every map). */
export const GROUND_TOP = 656;

/** A player's center y while standing on the ground slab. */
const STANDING_Y = GROUND_TOP - PLAYER_HALF_H;

/** Where new players appear (AABB center), on the default map. */
export const SPAWN_X = 200;
export const SPAWN_Y = STANDING_Y;

/** Where a portal drops the traveler: a map, and a standing position on it. */
export interface PortalTarget {
  readonly mapId: number;
  readonly x: number;
  readonly y: number;
}

/** Portal trigger size: wide enough to stop in at walk speed, gate-tall. */
const PORTAL_W = 80;
const PORTAL_H = 96;

/** A ground-level portal trigger centered on `centerX`. */
function groundPortalRect(centerX: number): Rect {
  return { x: centerX - PORTAL_W / 2, y: GROUND_TOP - PORTAL_H, w: PORTAL_W, h: PORTAL_H };
}

/**
 * A portal: a trigger area on the ground that teleports whoever stands in it
 * and presses up (the MapleStory convention) to `target`. Deliberately NOT
 * part of the physics (`CollisionMap`): a map transition inside stepPlayer
 * would drag the map id into PlayerState and every prediction replay,
 * whereas an explicit reducer keeps the deterministic physics single-map
 * and makes the teleport an authoritative row update like any other.
 */
export interface Portal {
  /** The trigger area. Keep it clear of rope columns: up grabs ropes first. */
  readonly rect: Rect;
  readonly target: PortalTarget;
  /** Destination name shown at the portal (ポータルの行き先表示). */
  readonly label: string;
}

/** The map new players spawn on, and the fallback for unknown map ids. */
export const DEFAULT_MAP_ID = 0;

/**
 * One map as the world defines it: the physics geometry plus everything
 * around it (portals, a display name). Maps are code-defined — the admin
 * map editor is deliberately postponed to the SaaS phase (VISION マップ制作).
 */
export interface WorldMap {
  readonly id: number;
  readonly name: string;
  readonly collision: CollisionMap;
  readonly portals: readonly Portal[];
}

/**
 * Map 0 「広場」— the original hard-coded level. The ground slab is the only
 * solid; every floating platform is one-way (jump through from below, land
 * from above, drop through with down+jump). Platform tops sit 100-120px
 * apart so each is reachable with the standard jump (max jump height ~147px)
 * — except the high platform at y=300, which is reachable only by climbing
 * its rope.
 *
 * Rope `bottom` is the lowest CENTER y while climbing: floorTop minus
 * PLAYER_HALF_H of whatever the rope's lower end rests on.
 *
 * The portal to the meeting floor sits at x=1700 — a deliberate 1,500px walk
 * from spawn (~6 seconds), the first probe of the movement-friction /
 * shortcut balance VISION names as the core design problem. Both portals of
 * the pair land the traveler INSIDE the opposite portal (the MapleStory
 * convention), so the return trip is one up-press with no walk.
 */
const PLAZA: WorldMap = {
  id: 0,
  name: '広場',
  collision: {
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    solids: [{ x: 0, y: GROUND_TOP, w: WORLD_WIDTH, h: WORLD_HEIGHT - GROUND_TOP }],
    platforms: [
      { x: 420, y: 540, w: 260, h: 24 },
      { x: 860, y: 440, w: 260, h: 24 },
      { x: 1320, y: 540, w: 300, h: 24 },
      { x: 1300, y: 300, w: 200, h: 24 },
      { x: 1800, y: 430, w: 240, h: 24 },
      { x: 2240, y: 540, w: 320, h: 24 },
      { x: 2760, y: 450, w: 260, h: 24 },
      { x: 3260, y: 540, w: 280, h: 24 },
    ],
    ropes: [
      { x: 550, top: 540, bottom: STANDING_Y }, // ground → platform at 420
      { x: 990, top: 440, bottom: STANDING_Y }, // ground → platform at 860
      { x: 1400, top: 300, bottom: 540 - PLAYER_HALF_H }, // platform at 1320 → high platform
    ],
  },
  portals: [
    {
      rect: groundPortalRect(1700),
      target: { mapId: 1, x: 260, y: STANDING_Y },
      label: '会議フロアへ',
    },
  ],
};

/**
 * Map 1 「会議フロア」— the second map (ROADMAP Phase 3 複数マップ), where
 * the meeting-room zones of the next increment will live. Deliberately
 * compact (half the plaza's width): a meeting floor is a destination, not a
 * promenade, and the size difference itself is data for the friction
 * experiment. Its return portal is at the arrival point (see PLAZA).
 */
const MEETING_FLOOR: WorldMap = {
  id: 1,
  name: '会議フロア',
  collision: {
    width: 1920,
    height: WORLD_HEIGHT,
    solids: [{ x: 0, y: GROUND_TOP, w: 1920, h: WORLD_HEIGHT - GROUND_TOP }],
    platforms: [
      { x: 520, y: 540, w: 260, h: 24 },
      { x: 1080, y: 440, w: 280, h: 24 },
      { x: 1560, y: 540, w: 240, h: 24 },
    ],
    ropes: [
      { x: 650, top: 540, bottom: STANDING_Y }, // ground → platform at 520
    ],
  },
  portals: [
    {
      rect: groundPortalRect(260),
      target: { mapId: 0, x: 1700, y: STANDING_Y },
      label: '広場へ',
    },
  ],
};

/** Every map, indexed by its id (MAPS[id].id === id — fixed by unit test). */
export const MAPS: readonly WorldMap[] = [PLAZA, MEETING_FLOOR];

/**
 * The map a `map_id` column names. Total: an unknown id (a newer module
 * added a map this client build does not know) falls back to the default
 * map rather than crashing — the deploy order (module before client) makes
 * the window brief, and a wrongly-rendered map beats a dead client.
 */
export function mapFor(mapId: number): WorldMap {
  return MAPS[mapId] ?? MAPS[DEFAULT_MAP_ID];
}

/**
 * The default map's physics geometry. The name predates multiple maps and
 * is kept because the physics unit tests are written against this level's
 * layout; runtime code should resolve geometry through mapFor instead.
 */
export const DEFAULT_MAP: CollisionMap = PLAZA.collision;

/**
 * Portal use (ROADMAP Phase 3 ポータル移動): how standing at a portal and
 * pressing up becomes a `enter_portal` reducer call, and how the server rules
 * on that call. Pure and shared so client and server apply the SAME
 * geometry test: the client flushes its pending inputs before calling
 * enter_portal, so by the time the reducer runs, the deterministic replay has
 * put the authoritative row exactly where the client's prediction stood —
 * an exact re-check, with no position slack to tune.
 */

/** True when the player AABB centered on `state` overlaps the portal's trigger area. */
function touchesPortal(state: PlayerState, portal: Portal): boolean {
  return overlaps({ cx: state.x, cy: state.y, hw: PLAYER_HALF_W, hh: PLAYER_HALF_H }, portal.rect);
}

/**
 * The portal the player is standing in, or undefined. Standing means
 * grounded and off ropes: portals answer the up key, which mid-air does
 * nothing and on a rope means climb — a rope grab must never double as a
 * teleport (portals are also authored clear of rope columns, see Portal).
 */
export function portalIndexAt(state: PlayerState, map: WorldMap): number | undefined {
  if (!state.onGround || state.rope !== -1) return undefined;
  const index = map.portals.findIndex((portal) => touchesPortal(state, portal));
  return index >= 0 ? index : undefined;
}

/** One tick's inputs as the intent rule reads them (see detectPortalIntent). */
export interface PortalIntentRequest {
  /** This tick's input and the previous tick's, for the press edge. */
  input: PlayerInput;
  prevInput: PlayerInput;
  /** The post-step predicted state of this tick. */
  state: PlayerState;
  map: WorldMap;
}

/**
 * The portal this tick's input asks to use, or undefined. Edge-triggered on
 * the up key (pressed this tick, not held from the last), so holding up
 * through the round trip cannot fire a second call, and a re-press after a
 * refusal starts cleanly. Ruled on the post-step state: if this tick's up
 * grabbed a rope, `state.rope` says so and the portal check refuses —
 * exactly what the server will conclude after replaying the same tick.
 */
export function detectPortalIntent(request: PortalIntentRequest): number | undefined {
  if (!request.input.up || request.prevInput.up) return undefined;
  return portalIndexAt(request.state, request.map);
}

/**
 * How long one enter_portal call suppresses further intents (ms) when no
 * answer arrives — the own row's map flip clears it early. Without this a
 * quick double-press could race the round trip, and since a portal pair
 * lands you inside the return portal, the second call would bounce you
 * straight back.
 */
export const PORTAL_PENDING_TIMEOUT_MS = 2000;

/** detectPortalIntent's inputs plus the in-flight-call state (see decidePortalCall). */
export interface PortalCallRequest extends PortalIntentRequest {
  nowMs: number;
  /** When the previous enter_portal call went out; undefined when none is pending. */
  pendingSinceMs: number | undefined;
}

/**
 * The whole client-side rule for firing one enter_portal call: the intent
 * (detectPortalIntent) gated by the in-flight window above. Pure so the
 * rule is unit-tested here; the caller (sync.ts) only supplies the live
 * clock and connection.
 */
export function decidePortalCall(request: PortalCallRequest): number | undefined {
  if (
    request.pendingSinceMs !== undefined &&
    request.nowMs - request.pendingSinceMs < PORTAL_PENDING_TIMEOUT_MS
  ) {
    return undefined;
  }
  return detectPortalIntent(request);
}

/** Why a enter_portal call was refused (the server logs it; honest clients never see one). */
export type PortalRejectReason = 'no-such-portal' | 'not-at-portal';

export type PortalUseVerdict =
  | { ok: true; target: PortalTarget }
  | { ok: false; reason: PortalRejectReason };

/** What ruling on one enter_portal call needs (see evaluatePortalUse). */
export interface PortalUseRequest {
  /** The sender's authoritative row state, on `map`. */
  state: PlayerState;
  /** The portal index the client resolved (into the map the row is on). */
  portalId: number;
  map: WorldMap;
}

/**
 * The server's admission rule for one enter_portal call: the named portal
 * must exist on the map the sender's row is on, and the row must stand in
 * it by the same test the client's intent detection used (portalIndexAt).
 * The client names the portal rather than the server searching, so a call
 * racing a map change can never teleport through a portal the sender no
 * longer sees.
 */
export function evaluatePortalUse(request: PortalUseRequest): PortalUseVerdict {
  const portal = request.map.portals[request.portalId];
  if (portal === undefined) return { ok: false, reason: 'no-such-portal' };
  if (portalIndexAt(request.state, request.map) !== request.portalId) {
    return { ok: false, reason: 'not-at-portal' };
  }
  return { ok: true, target: portal.target };
}

/**
 * Portal-use rate limit. A teleport is a public hot-row broadcast to the
 * subscribers of BOTH maps, and unlike movement it has no tick budget
 * bounding it — and a portal pair lands you inside the return portal, so
 * ping-ponging as fast as calls can land is always geometrically valid.
 * The burst covers honest play (a quick there-and-back, a mis-tap), the
 * sustained rate bounds the hostile case (the status_guard reasoning).
 */
const PORTAL_SEND_COST_MICROS = 1_000_000n; // sustained 1 use/second
const PORTAL_BURST_USES = 5;

/**
 * Charges one portal use against the sender's token bucket (see
 * evaluateSendAllowance). The marker is persisted on the sender's
 * portal_guard row.
 */
export function evaluatePortalSend(request: SendAllowanceRequest): SendAllowanceVerdict {
  return evaluateSendAllowance(request, PORTAL_SEND_COST_MICROS, PORTAL_BURST_USES);
}
