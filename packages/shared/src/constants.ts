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

/** Climbing speed on ropes/ladders in px/s. */
export const CLIMB_SPEED = 140;
/** Max horizontal distance (px) between the player center and a rope to grab it. */
export const ROPE_GRAB_RANGE = 16;
/** Initial vertical velocity when jumping off a rope in px/s (negative = up). */
export const ROPE_JUMP_VELOCITY = -540;
/**
 * Downward nudge (px) applied when dropping through a one-way platform, so the
 * "feet were at the top edge" check no longer holds on the next tick.
 */
export const PLATFORM_DROP_NUDGE = 1;

/** How often a client flushes its pending input batches to the server (ms). */
export const INPUT_FLUSH_INTERVAL_MS = 100;
/**
 * Remote players are rendered this far in the past (ms) so that there are
 * always two snapshots to interpolate between at the 10Hz row-update rate.
 */
export const INTERP_DELAY_MS = 120;

/** Max ticks accepted per submit_inputs call; clients chunk bigger backlogs. */
export const INPUT_BATCH_MAX_TICKS = 30;
/**
 * Server-side speed-hack guard: a player's total tick count may exceed the
 * wall-clock ticks elapsed since spawn by at most this many ticks.
 */
export const TICK_ALLOWANCE_SLACK = 30;
/** Client resend watchdog: re-send un-acked inputs after this long (ms). */
export const RESEND_TIMEOUT_MS = 600;
/** Client keeps at most this many ticks of prediction history (~10s). */
export const PREDICTION_HISTORY_MAX_TICKS = 600;
