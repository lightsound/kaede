import {
  PLAYER_HALF_H,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  type CollisionMap,
} from '@maple/shared';
import { Container, FillGradient, Graphics } from 'pixi.js';
import { createOscillator } from '../sprites/oscillator';

/**
 * The non-interactive scene: a fixed sky gradient, two parallax silhouette
 * layers, and the polished static map geometry (grass-lipped ground, highlighted
 * platforms, knotted ropes).
 *
 * Layering contract (must be preserved by GameApp):
 *   sky (screen-space, fixed) → parallax (screen-space, scrolls fractionally)
 *   → world geometry (ropes first = behind platforms) → players → effects.
 * Sky and parallax are screen-space so they're added to the STAGE behind the
 * world; the map geometry is world-space and added INSIDE the world container.
 */

// Nord-ish night palette, same family as the existing colors — improved, not
// redesigned. The sky runs deep blue at the top to a lighter horizon.
const SKY_TOP = 0x0b0e16;
const SKY_HORIZON = 0x2b3450;

const FAR_HILL_COLOR = 0x232a3d; // distant treeline/hills, almost sky-toned
const NEAR_HILL_COLOR = 0x2e3650; // closer rolling hills
const STAR_COLOR = 0xeceff4;
const CLOUD_COLOR = 0x3b4564; // soft mid-sky clouds (drawn with explicit alpha)

const SOLID_COLOR = 0x3b4252;
const GRASS_COLOR = 0xa3be8c; // grass lip on top of the ground slab
const GRASS_LIP_H = 8;
const PLATFORM_COLOR = 0x5e81ac;
const PLATFORM_HIGHLIGHT = 0x81a1c1; // subtle top-edge highlight on platforms
const PLATFORM_HIGHLIGHT_H = 3;
const ROPE_COLOR = 0xd8a657;
const ROPE_WIDTH = 4;
const ROPE_KNOT_COLOR = 0xb8860b;
const ROPE_KNOT_SPACING = 24; // a small knot every ~24px down the rope
const ROPE_KNOT_R = 3;

// Portal: MapleStory-ish blue-ish swirl, drawn as a few concentric ellipses that
// slowly rotate and pulse. Layered light→dark blue for a glowing-vortex read.
const PORTAL_COLORS = [0x88c0d0, 0x5e81ac, 0x81a1c1, 0x4c6a92];
const PORTAL_RX = 26; // horizontal radius of the outermost ellipse
const PORTAL_RY = 44; // vertical radius — a tall oval, like a doorway
const PORTAL_SWIRL_PERIOD_MS = 2600; // one slow pulse cycle
const PORTAL_PULSE = 0.12; // scale pulse amplitude (±12%)

// Parallax: distant layers move at a FRACTION of the camera scroll, so they
// drift slower than the foreground and read as far away. 0.2x ≈ very distant,
// 0.5x ≈ mid hills. The world geometry is effectively 1.0x.
const FAR_PARALLAX = 0.2;
const NEAR_PARALLAX = 0.5;

const STAR_COUNT = 60;
const CLOUD_COUNT = 6;

export interface Scene {
  /** Screen-space backdrop (sky + parallax). Add to the stage behind the world. */
  backdrop: Container;
  /**
   * Reposition the parallax layers for the current camera offset (cam.x/cam.y
   * are the world container's position, i.e. negative as you scroll right).
   * Called every frame from the ticker.
   */
  update(camX: number, camY: number): void;
}

/**
 * A built map's world-space geometry plus a per-frame `update` driving any
 * animated bits (the portal swirl). GameApp owns the current MapGfx, adds
 * `node` inside the world container, ticks `update`, and destroys + rebuilds it
 * on a map change. The sky/parallax backdrop is shared across maps (identical
 * world dimensions) and never rebuilt.
 */
export interface MapGfx {
  node: Container;
  /** Advance animated geometry (portal swirl) by dtMs. */
  update(dtMs: number): void;
}

export function createScene(viewW: number, viewH: number): Scene {
  const backdrop = new Container();

  // Sky: a single full-viewport rect with a vertical gradient. textureSpace
  // 'local' maps the gradient across the rect's own bounds, so start/end use
  // normalized 0..1 coordinates.
  const sky = new Graphics();
  const skyGradient = new FillGradient({
    type: 'linear',
    start: { x: 0, y: 0 },
    end: { x: 0, y: 1 },
    colorStops: [
      { offset: 0, color: SKY_TOP },
      { offset: 1, color: SKY_HORIZON },
    ],
    textureSpace: 'local',
  });
  sky.rect(0, 0, viewW, viewH).fill(skyGradient);

  // Far layer: a faint treeline silhouette plus stars (stars ride the far layer
  // so they drift, ever so slightly, with it). Drawn world-wide so it covers the
  // viewport across the full camera range at this parallax factor.
  const far = new Container();
  far.addChild(makeStars(viewW, viewH), makeHillStrip(FAR_HILL_COLOR, 0.62, 70, 11));

  // Near layer: rolling hills closer to the player, plus a few soft clouds.
  const near = new Container();
  near.addChild(makeHillStrip(NEAR_HILL_COLOR, 0.74, 110, 7), makeClouds(viewH));

  backdrop.addChild(sky, far, near);

  function update(camX: number, _camY: number): void {
    // A layer at factor f sits at camX * f: f=1 would track the world exactly
    // (foreground), smaller f lags behind so it reads as distant.
    far.x = camX * FAR_PARALLAX;
    near.x = camX * NEAR_PARALLAX;
  }

  return { backdrop, update };
}

/** A starfield scattered over the upper sky, deterministic so it doesn't flicker. */
function makeStars(viewW: number, viewH: number): Graphics {
  const g = new Graphics();
  const rng = mulberry32(1337);
  for (let i = 0; i < STAR_COUNT; i++) {
    // Spread across roughly two viewport widths so the far layer's slow drift
    // never reveals an empty edge.
    const x = rng() * viewW * 2;
    const y = rng() * viewH * 0.55;
    const r = 0.6 + rng() * 1.2;
    g.circle(x, y, r);
  }
  g.fill({ color: STAR_COLOR, alpha: 0.7 });
  return g;
}

/** A few translucent clouds drifting in the mid sky. */
function makeClouds(viewH: number): Graphics {
  const g = new Graphics();
  const rng = mulberry32(7);
  for (let i = 0; i < CLOUD_COUNT; i++) {
    const x = rng() * WORLD_WIDTH;
    const y = 60 + rng() * (viewH * 0.4);
    const w = 60 + rng() * 80;
    // A cloud is a couple of overlapping rounded blobs.
    g.roundRect(x, y, w, 22, 11).roundRect(x + w * 0.3, y - 10, w * 0.5, 24, 12);
  }
  g.fill({ color: CLOUD_COLOR, alpha: 0.45 });
  return g;
}

/**
 * A rolling silhouette strip spanning the whole world: a polygon whose top edge
 * undulates as a sine wave, filled down to the world's bottom. `baseFrac` sets
 * the silhouette's resting height (fraction of WORLD_HEIGHT from the top),
 * `amp` the hill height, `period` the wave length.
 */
function makeHillStrip(color: number, baseFrac: number, amp: number, periodCount: number): Graphics {
  const g = new Graphics();
  const baseY = WORLD_HEIGHT * baseFrac;
  const span = WORLD_WIDTH * 1.5; // overdraw so the parallax lag never shows a gap
  const step = span / 96;
  const pts: number[] = [0, WORLD_HEIGHT];
  for (let x = 0; x <= span; x += step) {
    const y = baseY - amp * (0.5 + 0.5 * Math.sin((x / span) * Math.PI * 2 * periodCount));
    pts.push(x, y);
  }
  pts.push(span, WORLD_HEIGHT);
  g.poly(pts).fill(color);
  return g;
}

/**
 * The static geometry of `map` as a Container of Graphics, plus animated
 * portals. Ropes are drawn FIRST so they sit BEHIND platforms (preserving the
 * existing depth order); then the ground slab with a grass lip, then highlighted
 * one-way platforms; finally the portals on top. Parameterized by the map so
 * GameApp can build/swap per PlayerState.mapId — the backdrop is unchanged
 * because every map shares the world dimensions.
 */
export function createMapGfx(map: CollisionMap): MapGfx {
  const node = new Container();
  const g = new Graphics();

  for (const r of map.ropes) {
    const top = r.top;
    const bottom = r.bottom + PLAYER_HALF_H; // lower end rests on a floor
    g.rect(r.x - ROPE_WIDTH / 2, top, ROPE_WIDTH, bottom - top).fill(ROPE_COLOR);
    // Knots every ROPE_KNOT_SPACING px give the rope a hand-over-hand texture.
    for (let y = top + ROPE_KNOT_SPACING; y < bottom; y += ROPE_KNOT_SPACING) {
      g.circle(r.x, y, ROPE_KNOT_R).fill(ROPE_KNOT_COLOR);
    }
  }

  for (const s of map.solids) {
    g.rect(s.x, s.y, s.w, s.h).fill(SOLID_COLOR);
    // Grass lip along the top edge of the ground slab.
    g.rect(s.x, s.y, s.w, GRASS_LIP_H).fill(GRASS_COLOR);
  }

  for (const p of map.platforms) {
    g.rect(p.x, p.y, p.w, p.h).fill(PLATFORM_COLOR);
    // A lighter strip on the landing edge reads as a top highlight.
    g.rect(p.x, p.y, p.w, PLATFORM_HIGHLIGHT_H).fill(PLATFORM_HIGHLIGHT);
  }

  node.addChild(g);

  // One swirling portal per portal entry. Each is its own Container so it can
  // rotate/pulse independently; they all share one oscillator for the pulse.
  const portals = map.portals.map((p) => {
    const node = createPortalGfx();
    node.position.set(p.x, p.y);
    return node;
  });
  for (const p of portals) node.addChild(p);

  const swirl = createOscillator(PORTAL_SWIRL_PERIOD_MS);
  function update(dtMs: number): void {
    const s = swirl.tick(dtMs);
    const scale = 1 + PORTAL_PULSE * s;
    for (const portal of portals) {
      portal.rotation += dtMs * 0.0008; // slow continuous spin
      portal.scale.set(scale, scale);
    }
  }

  return { node, update };
}

/**
 * A single portal: concentric blue-ish ellipses (light center → dark rim) that
 * read as a glowing vortex once GameApp spins/pulses the container. Origin is
 * the portal center, so positioning it at the portal coord lines the swirl up
 * with the activation box.
 */
function createPortalGfx(): Container {
  const node = new Container();
  const g = new Graphics();
  // Outer rim first (largest), then progressively smaller/lighter rings.
  for (let i = 0; i < PORTAL_COLORS.length; i++) {
    const k = 1 - i / PORTAL_COLORS.length;
    g.ellipse(0, 0, PORTAL_RX * k, PORTAL_RY * k).fill({ color: PORTAL_COLORS[i], alpha: 0.65 });
  }
  node.addChild(g);
  return node;
}

/**
 * A tiny deterministic PRNG (mulberry32). The scene's stars/clouds must land in
 * the same spots every load (no flicker, no per-frame churn), so we seed a
 * stable generator instead of Math.random.
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
