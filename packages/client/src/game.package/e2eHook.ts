// fallow-ignore-file coverage-gaps -- reads live PixiJS display state (and samples the frame rate) for the dev-only test hook; the contract lives in @kaede/shared (e2eHook.ts) and the Playwright specs exercise it end to end

// The dev-only window into the scene (window.__kaedeE2E): what the
// Playwright specs and the dev PerfHud read. Every entry point gates on the
// build-time DEV constant, so production bundles drop this code; GameApp.ts
// installs the hook (see its start()).
import type { E2EHook, E2EPlayerSnapshot } from '@kaede/shared';
import { visibleBubbleText, visibleReactionEmoji } from './bubble';
import type { PlayerView } from './playerView';
import type { ZoneRender } from './zoneLayer';

/**
 * One player as the e2e hook reports it: rendered pose plus any live
 * overheads and the status line. The optional fields are guarded
 * assignments (one uniform shape) rather than conditional spreads — three
 * spread ternaries put this uncovered function over the CRAP budget
 * fallow enforces.
 */
function playerSnapshot(view: PlayerView): E2EPlayerSnapshot {
  const snap: E2EPlayerSnapshot = {
    x: view.root.x,
    y: view.root.y,
    name: view.label.text,
    pose: view.avatar.pose(),
  };
  const bubble = visibleBubbleText(view.bubble);
  if (bubble !== undefined) snap.bubble = bubble;
  const reaction = visibleReactionEmoji(view.reaction);
  if (reaction !== undefined) snap.reaction = reaction;
  return withUnderlineSnapshots(view, snap);
}

/**
 * Folds the persistent under-avatar lines (status, zone tag) into one
 * snapshot. Split from playerSnapshot to keep both uncovered functions
 * under the CRAP budget fallow enforces (the reason playerSnapshot avoids
 * conditional spreads, continued).
 */
function withUnderlineSnapshots(view: PlayerView, snap: E2EPlayerSnapshot): E2EPlayerSnapshot {
  if (view.status.visible) snap.status = view.status.text;
  if (view.zone.visible) snap.zone = view.zone.text;
  return snap;
}

/** Rolling Pixi FPS over ~500ms. Production builds compile this to `return 0`. */
export function sampleFpsWindow(
  now: number,
  state: { frames: number; windowStart: number; fps: number },
): number {
  if (!import.meta.env.DEV) return 0;
  state.frames += 1;
  if (now - state.windowStart < 500) return state.fps;
  state.fps = (state.frames * 1000) / (now - state.windowStart);
  state.frames = 0;
  state.windowStart = now;
  return state.fps;
}

/**
 * Test affordance for the Playwright smoke tests — see E2EHook in
 * @kaede/shared for the contract and who consumes it. Constructed only in dev
 * builds, so the build-time DEV constant lets production bundles drop the
 * hook code entirely.
 */
export function createE2EHook(
  local: PlayerView,
  remotes: Map<string, PlayerView>,
  currentTick: () => number,
  currentMapId: () => number,
  currentZones: () => readonly ZoneRender[],
  currentHuddles: () => readonly { label: string; closed: boolean; members: number }[],
  currentFps: () => number,
): E2EHook | undefined {
  if (!import.meta.env.DEV) return undefined;
  return {
    snapshot: () => ({
      tick: currentTick(),
      mapId: currentMapId(),
      local: playerSnapshot(local),
      remotePlayers: [...remotes.values()].map(playerSnapshot),
      zones: currentZones().map((zone) => ({ label: zone.label, closed: zone.closed })),
      huddles: [...currentHuddles()],
      fps: currentFps(),
    }),
  };
}
