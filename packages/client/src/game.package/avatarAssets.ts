// fallow-ignore-file coverage-gaps -- loads the bundled PNGs into PixiJS textures, which needs a browser to decode the images (the unit-test setup has no browser or DOM); the manifests it reads are validated by studio.package/catalog.ts, which is unit-tested, and checked clean end to end by asset-studio.spec.ts

// The avatar assets every player view shares: the base pose sheet (Phase 5
// 増分①a) and the gesture kit (増分①c), bundled statically by Vite so the
// hashed URLs bust caches with the assets. The dev-only dress-up preview's
// outfit, carry and item assets are dressUpPreview.ts's — loaded on demand,
// and their loader code is dropped from production builds.
import { Assets } from 'pixi.js';
import avatarManifest from './avatar/manifest.json';
import standUrl from './avatar/stand.png';
import walkAUrl from './avatar/walk-a.png';
import walkBUrl from './avatar/walk-b.png';
import walkCUrl from './avatar/walk-c.png';
import walkDUrl from './avatar/walk-d.png';
import danceAUrl from './avatar-gestures/dance-a.png';
import danceBUrl from './avatar-gestures/dance-b.png';
import danceCUrl from './avatar-gestures/dance-c.png';
import danceDUrl from './avatar-gestures/dance-d.png';
import danceEUrl from './avatar-gestures/dance-e.png';
import danceFUrl from './avatar-gestures/dance-f.png';
import danceGUrl from './avatar-gestures/dance-g.png';
import danceHUrl from './avatar-gestures/dance-h.png';
import gestureManifest from './avatar-gestures/manifest.json';
import sitUrl from './avatar-gestures/sit.png';
import sleepUrl from './avatar-gestures/sleep.png';
import waveUrl from './avatar-gestures/wave.png';
import type {
  AvatarSheetTextures,
  GestureKit,
  GestureSheetTextures,
  HeadgearDisplay,
} from './avatarView';
import headphonesUrl from './items/headphones/headphones.png';
import headphonesManifest from './items/headphones/manifest.json';

/** The base outfit's pose sheet (stand + four walk frames) every player view shares. */
export async function loadBaseSheet(): Promise<AvatarSheetTextures> {
  const [stand, walkA, walkB, walkC, walkD] = await Promise.all(
    [standUrl, walkAUrl, walkBUrl, walkCUrl, walkDUrl].map((url) => Assets.load(url)),
  );
  return {
    stand,
    'walk-a': walkA,
    'walk-b': walkB,
    'walk-c': walkC,
    'walk-d': walkD,
  };
}

/**
 * Loads the ①c gesture assets every player view shares: the gesture pose
 * sheet (avatar.boy-basic-gestures) and the busy headgear with its
 * per-pose neck anchors — the base manifest's for the walk poses, the
 * gesture manifest's for the gesture poses (the base wins the shared
 * `stand`: it is the frame actually rendered). Bundled statically like the
 * base sheet: gestures are a core feature on every avatar, not a preview.
 */
export async function loadGestureKit(): Promise<GestureKit> {
  const [sit, sleep, wave, a, b, c, d, e, f, g, h, headphones] = await Promise.all(
    [
      sitUrl,
      sleepUrl,
      waveUrl,
      danceAUrl,
      danceBUrl,
      danceCUrl,
      danceDUrl,
      danceEUrl,
      danceFUrl,
      danceGUrl,
      danceHUrl,
      headphonesUrl,
    ].map((url) => Assets.load(url)),
  );
  const sheet: GestureSheetTextures = {
    sit,
    sleep,
    wave,
    'dance-a': a,
    'dance-b': b,
    'dance-c': c,
    'dance-d': d,
    'dance-e': e,
    'dance-f': f,
    'dance-g': g,
    'dance-h': h,
  };
  const necks: Record<string, readonly number[]> = {};
  for (const [pose, meta] of Object.entries(gestureManifest.poses)) {
    necks[pose] = meta.anchors.neck;
  }
  for (const [pose, meta] of Object.entries(avatarManifest.poses)) {
    necks[pose] = meta.anchors.neck;
  }
  const headgear: HeadgearDisplay = {
    texture: headphones,
    grip: headphonesManifest.frame.anchors.grip,
    necks,
  };
  return { sheet, headgear };
}
