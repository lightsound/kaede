// fallow-ignore-file coverage-gaps -- public API barrel only; behavior lives in the re-exported modules
export type { SpaceMemberView, SpaceView } from './admission';
export type { ChatLog } from './chatLog';
export type { AuthTokenGetter } from './connection';
export { type ConnectionStatus, type Net, startNet } from './sync';
