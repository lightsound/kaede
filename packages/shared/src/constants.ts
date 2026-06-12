/** Simulation tick rate (Hz). Rendering is decoupled from this. */
export const TICK_RATE = 60;
/** Seconds per simulation tick. */
export const DT = 1 / TICK_RATE;

/** Gravity in px/s^2. The y axis points down (screen coordinates). */
export const GRAVITY = 2400;
/** Horizontal move speed in px/s. */
export const MOVE_SPEED = 240;
/** Initial vertical velocity of a jump in px/s (negative = up). */
export const JUMP_VELOCITY = -840;
/** Terminal fall speed in px/s. */
export const MAX_FALL_SPEED = 1200;

/** Player AABB half extents in px. PlayerState (x, y) is the AABB center. */
export const PLAYER_HALF_W = 16;
export const PLAYER_HALF_H = 24;

/** How often a client publishes its state to the server (ms). */
export const SNAPSHOT_SEND_INTERVAL_MS = 100;
/**
 * Remote players are rendered this far in the past (ms) so that there are
 * always two snapshots to interpolate between at the 10Hz publish rate.
 */
export const INTERP_DELAY_MS = 120;
