// fallow-ignore-file coverage-gaps -- public API barrel only; behavior lives in the re-exported modules
export { loadAssetModules } from './assetCatalog';
export { createGameApp, type GameApp, type PlayerLabel } from './GameApp';
export type { HuddleRender } from './huddleLayer';
// The walk-cycle rules, re-exported for the asset studio's playback so the
// inspection preview paces frames exactly like the in-game avatar (no
// second implementation of the cadence to drift).
export { advanceWalk, IDLE_WALK_STATE, selectPose, WALK_POSES, type WalkState } from './rig';
export type { ZoneRender } from './zoneLayer';
