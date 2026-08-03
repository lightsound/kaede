// fallow-ignore-file coverage-gaps -- shared UI style constants only; nothing behavioral to test
/**
 * The HUD palette: dark panels with the kaede gold accent, shared by every
 * DOM overlay (connection notice, name form, waiting room, admin panel) so
 * the chrome reads as one surface.
 */
export const UI_FONT = '13px sans-serif';
export const UI_TEXT_COLOR = '#eceff4';
export const UI_ERROR_COLOR = '#e8a2a2';
export const UI_GOLD = '#d8a657';
/** DM lines in the chat log: private traffic reads apart from room chatter. */
export const UI_DM_COLOR = '#c6a0e8';
export const UI_PANEL_BG = 'rgba(11, 13, 18, 0.85)';
/** Denser than UI_PANEL_BG: full-canvas covers that must hide the world. */
export const UI_OVERLAY_BG = 'rgba(11, 13, 18, 0.92)';
export const UI_GOLD_BORDER = '1px solid rgba(216, 166, 87, 0.6)';
export const UI_GOLD_BORDER_SOFT = '1px solid rgba(216, 166, 87, 0.4)';
export const UI_BUTTON_BG = 'rgba(216, 166, 87, 0.15)';
