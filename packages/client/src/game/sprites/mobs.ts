import { MOB_STATS, type MobKind } from '@maple/shared';
import { Container, Graphics } from 'pixi.js';
import { createOscillator } from './oscillator';

/**
 * Procedural mob rigs. Each is a Container whose origin is the mob's AABB center
 * (GameApp positions the root there and hangs the HP bar above it), sized from
 * MOB_STATS half extents so the drawing roughly fills the collision box. Facing
 * is applied by the caller via `body.scale.x` exactly like players.
 *
 * Animation state lives inside the rig and is advanced by `update(dtMs)` from
 * the ticker; GameApp passes only whether the mob is moving (to gate the
 * mushroom's waddle), since mobs don't predict and their velocity is implicit.
 */

const PALETTE: Record<MobKind, number> = {
  slime: 0xa3be8c,
  mushroom: 0xd08770,
  golem: 0x6b7280, // stony grey-blue
};

const EYE = 0x10131b;
const EYE_WHITE = 0xeceff4;

// Slime: a squishy blob that constantly squash-stretches and hops with the
// bounce, so it reads as alive even while patrolling.
const SLIME_PERIOD_MS = 900;
const SLIME_SQUASH = 0.16; // scale.y swing amplitude (x counter-oscillates)
const SLIME_HOP_PX = 5; // vertical hop tied to the same bounce

// Mushroom: a stem + wide spotted cap that waddles (small rotation) while it
// walks. The waddle is gated off when stationary so an idle mushroom sits still.
const MUSH_PERIOD_MS = 420;
const MUSH_WADDLE_RAD = 0.16;

// Golem: a heavy stone bruiser that bobs slowly up and down (its mass lumbers).
// The bob runs always (even idle) but is small, so it reads as a hulking idle.
const GOLEM_PERIOD_MS = 1400;
const GOLEM_BOB_PX = 3;
const GOLEM_ROCK = 0x4b515c; // darker stone for plating
const GOLEM_CRACK = 0x363b44; // crack lines

export interface MobRig {
  body: Container;
  /** Advance the rig by dtMs. `moving` gates motion-only animation (waddle). */
  update(dtMs: number, moving: boolean): void;
}

export function createMobRig(kind: MobKind): MobRig {
  if (kind === 'slime') return createSlimeRig();
  if (kind === 'golem') return createGolemRig();
  return createMushroomRig();
}

function createSlimeRig(): MobRig {
  const s = MOB_STATS.slime;
  const w = s.halfW * 2;
  const h = s.halfH * 2;
  const color = PALETTE.slime;

  // The visual pivots around its bottom (feet) so squash flattens it onto the
  // ground instead of through it. We offset all geometry up by halfH from a
  // bottom anchor at y = +halfH, then animate scale about that anchor.
  const body = new Container();
  const inner = new Container();
  inner.y = s.halfH; // bottom anchor at the AABB floor
  body.addChild(inner);

  const blob = new Graphics()
    // ellipse-ish rounded blob sitting on the anchor (drawn above y=0).
    .roundRect(-s.halfW, -h, w, h, s.halfW)
    .fill(color);
  const eyes = new Graphics()
    .circle(-s.halfW * 0.35, -h * 0.62, 2.4)
    .circle(s.halfW * 0.35, -h * 0.62, 2.4)
    .fill(EYE);
  inner.addChild(blob, eyes);

  const bounce = createOscillator(SLIME_PERIOD_MS);

  function update(dtMs: number, _moving: boolean): void {
    const b = bounce.tick(dtMs);
    // Squash and stretch: y stretches as x squashes and vice versa (volume-ish).
    inner.scale.y = 1 + SLIME_SQUASH * b;
    inner.scale.x = 1 - SLIME_SQUASH * b;
    // Hop: lift when stretched (b > 0). |b| keeps the mob from sinking below the
    // floor on the squash half of the cycle.
    inner.y = s.halfH - SLIME_HOP_PX * Math.max(0, b);
  }

  return { body, update };
}

function createMushroomRig(): MobRig {
  const s = MOB_STATS.mushroom;
  const color = PALETTE.mushroom;
  const halfW = s.halfW;
  const halfH = s.halfH;

  const body = new Container();
  // Rotate-about-the-base so the waddle rocks the cap, not the feet. The pivot
  // sits at the bottom; geometry is drawn upward from there.
  const inner = new Container();
  inner.y = halfH;
  body.addChild(inner);

  const stemW = halfW * 0.9;
  const stemH = halfH * 0.9;
  const stem = new Graphics()
    .roundRect(-stemW / 2, -stemH, stemW, stemH, 3)
    .fill(0xe9e1cf); // pale stem
  // Angry eyes on the stem: small with slanted brows.
  const eyes = new Graphics()
    .circle(-stemW * 0.3, -stemH * 0.55, 2.2)
    .circle(stemW * 0.3, -stemH * 0.55, 2.2)
    .fill(EYE_WHITE);
  const pupils = new Graphics()
    .circle(-stemW * 0.3, -stemH * 0.55, 1.1)
    .circle(stemW * 0.3, -stemH * 0.55, 1.1)
    .fill(EYE);
  const brows = new Graphics()
    .poly([-stemW * 0.55, -stemH * 0.78, -stemW * 0.1, -stemH * 0.62, -stemW * 0.55, -stemH * 0.66])
    .poly([stemW * 0.55, -stemH * 0.78, stemW * 0.1, -stemH * 0.62, stemW * 0.55, -stemH * 0.66])
    .fill(EYE);

  // Wide cap sitting atop the stem, with a couple of lighter spots.
  const capW = halfW * 2;
  const capH = halfH * 0.95;
  const capTop = -stemH - capH * 0.55;
  const cap = new Graphics()
    .roundRect(-capW / 2, capTop, capW, capH, capH / 2)
    .fill(color);
  const spots = new Graphics()
    .circle(-capW * 0.22, capTop + capH * 0.5, 2.6)
    .circle(capW * 0.18, capTop + capH * 0.42, 3.2)
    .fill(0xf4f1e8);

  inner.addChild(stem, eyes, pupils, brows, cap, spots);

  const waddle = createOscillator(MUSH_PERIOD_MS);

  function update(dtMs: number, moving: boolean): void {
    const w = waddle.tick(dtMs);
    // Only rock while walking; a stationary mushroom holds still.
    inner.rotation = moving ? MUSH_WADDLE_RAD * w : 0;
  }

  return { body, update };
}

function createGolemRig(): MobRig {
  const s = MOB_STATS.golem;
  const halfW = s.halfW;
  const halfH = s.halfH;
  const color = PALETTE.golem;

  const body = new Container();
  // Bottom anchor at the AABB floor; geometry is drawn upward from there so the
  // slow bob lifts the whole mass without clipping into the ground.
  const inner = new Container();
  inner.y = halfH;
  body.addChild(inner);

  // Blocky torso filling most of the box, with darker plating and crack lines so
  // it reads as carved stone rather than a flat slab.
  const torsoW = halfW * 1.7;
  const torsoH = halfH * 1.5;
  const torso = new Graphics()
    .roundRect(-torsoW / 2, -torsoH, torsoW, torsoH, 4)
    .fill(color);
  const plating = new Graphics()
    .rect(-torsoW / 2, -torsoH * 0.55, torsoW, torsoH * 0.18)
    .fill(GOLEM_ROCK);
  const cracks = new Graphics()
    .poly([-torsoW * 0.2, -torsoH * 0.9, -torsoW * 0.05, -torsoH * 0.6, -torsoW * 0.25, -torsoH * 0.35])
    .stroke({ color: GOLEM_CRACK, width: 1.5 });

  // A squat head block on top.
  const headW = halfW * 1.0;
  const headH = halfH * 0.5;
  const headY = -torsoH - headH * 0.5;
  const head = new Graphics()
    .roundRect(-headW / 2, headY - headH / 2, headW, headH, 3)
    .fill(color);
  const eyes = new Graphics()
    .rect(-headW * 0.28, headY - 1.5, 4, 3)
    .rect(headW * 0.12, headY - 1.5, 4, 3)
    .fill(0xebcb8b); // glowing amber eyes

  // Stubby arms hanging at the sides.
  const arms = new Graphics()
    .roundRect(-torsoW / 2 - 5, -torsoH * 0.85, 6, torsoH * 0.7, 3)
    .roundRect(torsoW / 2 - 1, -torsoH * 0.85, 6, torsoH * 0.7, 3)
    .fill(GOLEM_ROCK);

  inner.addChild(torso, plating, cracks, arms, head, eyes);

  const bob = createOscillator(GOLEM_PERIOD_MS);

  function update(dtMs: number, _moving: boolean): void {
    const b = bob.tick(dtMs);
    // Heavy, ever-present bob: lift the whole body by a few px on the upswing.
    inner.y = halfH - GOLEM_BOB_PX * Math.max(0, b);
  }

  return { body, update };
}

/**
 * A death poof: an expanding, fading ring drawn at a mob's death spot. Returns
 * the node plus an `update` returning false when finished, matching GameApp's
 * Effect contract so it rides the same effects loop.
 */
const POOF_LIFE_MS = 320;
const POOF_MAX_R = 26;

export function createDeathPoof(kind: MobKind): {
  node: Graphics;
  update(dtMs: number): boolean;
} {
  const node = new Graphics();
  const color = PALETTE[kind];
  let ms = 0;
  // Redraw the ring each frame at the current radius (cheap: a single circle).
  function draw(r: number, alpha: number): void {
    node.clear().circle(0, 0, r).fill({ color, alpha });
  }
  draw(POOF_MAX_R * 0.3, 0.6);
  return {
    node,
    update(dtMs: number): boolean {
      ms += dtMs;
      const k = ms / POOF_LIFE_MS;
      draw(POOF_MAX_R * (0.3 + 0.7 * k), Math.max(0, 0.6 * (1 - k)));
      return ms < POOF_LIFE_MS;
    },
  };
}
