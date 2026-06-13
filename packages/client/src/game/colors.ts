/**
 * Shared Nord-ish palette constants. Centralized here (importing nothing) so the
 * named colors have exactly ONE definition each and can be reused across the
 * effects subsystem, the HUD, and GameApp without import cycles or re-typed hex.
 */

/** Nord aurora red: own-damage numbers, the HP bar fill, and the death flash. */
export const NORD_RED = 0xbf616a;
/** Nord aurora yellow: XP bar fill and the LEVEL UP flash. */
export const NORD_YELLOW = 0xebcb8b;
/** Polar-night dark: the empty track behind HP/XP bars. */
export const BAR_BG = 0x2e3440;
