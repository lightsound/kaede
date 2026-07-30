// fallow-ignore-file coverage-gaps -- public API barrel only; behavior lives in the re-exported modules
export type { AuthTokenGetter } from './connection';
export {
  type ConnectionStatus,
  type Net,
  type SpaceMemberView,
  type SpaceView,
  startNet,
} from './sync';
