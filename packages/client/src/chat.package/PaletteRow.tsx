// fallow-ignore-file coverage-gaps -- React palette rows for the chat panel; needs a DOM, and no DOM test environment is configured. The items they offer are the shared GESTURES / REACTION_EMOJIS lists (unit-tested in @kaede/shared), and this file only renders one button per item
import {
  GESTURE_LABELS,
  GESTURES,
  type GestureKind,
  REACTION_EMOJIS,
  type ReactionEmoji,
} from '@kaede/shared';
import { type CSSProperties } from 'react';
import { UI_GOLD_BORDER_SOFT, UI_TEXT_COLOR } from '../theme';
import { blurringClick } from '../ui.package';

const paletteRowStyle: CSSProperties = {
  display: 'flex',
  gap: 4,
};

const reactionButtonStyle: CSSProperties = {
  flex: '1 1 0',
  padding: '2px 0',
  borderRadius: 6,
  border: UI_GOLD_BORDER_SOFT,
  background: 'transparent',
  fontSize: 15,
  cursor: 'pointer',
};

/**
 * The gesture buttons carry words, not emoji — smaller type, same shape,
 * in the panel's font family (a button does not inherit it by default).
 * fontFamily rather than the usual `font: 'inherit'`: the shorthand would
 * reset the fontSize above.
 */
const gestureButtonStyle: CSSProperties = {
  ...reactionButtonStyle,
  fontSize: 11,
  color: UI_TEXT_COLOR,
  fontFamily: 'inherit',
};

/**
 * What one palette row offers: its items, and how each item's button
 * reads. The accessible name is what the specs find the buttons by.
 */
export interface Palette<T extends string> {
  items: readonly T[];
  buttonStyle: CSSProperties;
  ariaLabel: (item: T) => string;
  label: (item: T) => string;
}

/**
 * The reaction palette (ROADMAP Phase 2): one button per palette emoji. A
 * burst-exceeding click simply not appearing is feedback enough (the
 * server refusal stays loud in the reducer log).
 */
export const REACTION_PALETTE: Palette<ReactionEmoji> = {
  items: REACTION_EMOJIS,
  buttonStyle: reactionButtonStyle,
  ariaLabel: (emoji) => `リアクション ${emoji}`,
  label: (emoji) => emoji,
};

/**
 * The gesture palette (Phase 5 ①c): one button per pose gesture, riding
 * under the reaction row. The pose appearing on the avatar IS the
 * feedback, and moving cancels it server-side. Sitting or sleeping ends
 * by walking; the buttons stay enabled while posed, so re-striking or
 * switching gestures is one click. play_gesture('') — standing up
 * without moving — deliberately has no button here: a tap of any arrow
 * key already is the stand-up, and a fifth 立つ button would spend row
 * space on the rare case until real demand shows up (the reducer keeps
 * the clear path so adding one later is UI-only).
 */
export const GESTURE_PALETTE: Palette<GestureKind> = {
  items: GESTURES,
  buttonStyle: gestureButtonStyle,
  ariaLabel: (gesture) => `ジェスチャー ${GESTURE_LABELS[gesture]}`,
  label: (gesture) => GESTURE_LABELS[gesture],
};

/**
 * One palette row (the reactions, and the gestures under them), sitting
 * between the log and the input row so the input stays where the chat
 * habit expects it (the bottom line). Gated exactly like the chat input —
 * sending needs a player row to speak from. Each click blurs its button
 * (blurringClick — see its comment for the keyboard reasons).
 *
 * No client-side bucket mirror and no refusal notice, unlike the message
 * form: a palette press is fire-and-forget, with no draft to lose.
 */
export function PaletteRow<T extends string>({
  palette,
  disabled,
  onPick,
}: {
  palette: Palette<T>;
  disabled: boolean;
  onPick: (item: T) => void;
}) {
  return (
    <div style={paletteRowStyle}>
      {palette.items.map((item) => (
        <button
          key={item}
          type="button"
          style={palette.buttonStyle}
          aria-label={palette.ariaLabel(item)}
          disabled={disabled}
          onClick={blurringClick(() => onPick(item))}
        >
          {palette.label(item)}
        </button>
      ))}
    </div>
  );
}
