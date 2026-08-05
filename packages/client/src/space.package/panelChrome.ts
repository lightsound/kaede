// fallow-ignore-file coverage-gaps -- style constants for the admin panel's sections; there is nothing to execute, and no DOM test environment is configured
/**
 * The admin panel's shared chrome: the section heading, the form row, and
 * the controls inside them. One module because the panel's sections
 * (members, zones, announcements) are one surface — and because three
 * copies of the same style block is exactly the duplication the clone gate
 * exists to stop. Section-specific styles stay with their section.
 */
import type { CSSProperties } from 'react';
import {
  UI_BUTTON_BG,
  UI_ERROR_COLOR,
  UI_GOLD,
  UI_GOLD_BORDER,
  UI_GOLD_BORDER_SOFT,
  UI_TEXT_COLOR,
} from '../theme';

/** One section's title inside the panel (the panel supplies the font). */
export const panelHeadingStyle: CSSProperties = {
  fontWeight: 'bold',
  color: UI_GOLD,
  margin: '8px 0 4px',
};

/** One form or list row: controls in a line, wrapping onto the next when tight. */
export const panelRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 0',
  flexWrap: 'wrap',
};

/** A text input filling the row's free space. */
export const panelInputStyle: CSSProperties = {
  flex: '1 1 80px',
  minWidth: 0,
  padding: '2px 6px',
  borderRadius: 6,
  border: UI_GOLD_BORDER_SOFT,
  background: 'rgba(0, 0, 0, 0.4)',
  color: UI_TEXT_COLOR,
  font: 'inherit',
};

/** An action button; never shrinks, so its label stays readable. */
export const panelButtonStyle: CSSProperties = {
  padding: '2px 8px',
  borderRadius: 6,
  border: UI_GOLD_BORDER,
  background: UI_BUTTON_BG,
  color: UI_TEXT_COLOR,
  font: 'inherit',
  cursor: 'pointer',
  flexShrink: 0,
};

/** An inline refusal, on its own line under the row it belongs to. */
export const panelErrorStyle: CSSProperties = {
  color: UI_ERROR_COLOR,
  flexBasis: '100%',
};
