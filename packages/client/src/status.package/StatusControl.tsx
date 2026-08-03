// fallow-ignore-file coverage-gaps -- a React status panel; needs a DOM, and no DOM test environment is configured. The validation and label rules it relies on are isAvailability / normalizeStatusText / statusLabel, unit-tested in @maple/shared
import {
  AVAILABILITIES,
  AVAILABILITY_ICONS,
  AVAILABILITY_LABELS,
  type Availability,
  normalizeStatusText,
  STATUS_TEXT_MAX_LENGTH,
  type StatusTextRejectReason,
  type StatusView,
} from '@maple/shared';
import type { CSSProperties } from 'react';
import {
  UI_BUTTON_BG,
  UI_FONT,
  UI_GOLD_BORDER,
  UI_GOLD_BORDER_SOFT,
  UI_PANEL_BG,
  UI_TEXT_COLOR,
} from '../theme';
import { blurringClick, DraftForm, postingDisabled } from '../ui.package';

const REJECT_MESSAGES: Record<StatusTextRejectReason, string> = {
  'too-long': `ステータスは${STATUS_TEXT_MAX_LENGTH}文字以内にしてください`,
  'forbidden-characters': '使用できない文字が含まれています',
};

// Stacked just above the rename form (bottom-left, the profile corner):
// the status is a statement about yourself, like the name — not part of
// the conversation panel on the right.
const panelStyle: CSSProperties = {
  position: 'absolute',
  bottom: 58,
  left: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '6px 8px',
  borderRadius: 8,
  background: UI_PANEL_BG,
  border: UI_GOLD_BORDER,
  font: UI_FONT,
  color: UI_TEXT_COLOR,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  gap: 4,
};

const textRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap', // the inline error wraps onto its own line
  alignItems: 'center',
  gap: 6,
};

/** One availability button's chrome; the current selection gets the gold fill. */
function availabilityButtonStyle(selected: boolean): CSSProperties {
  return {
    flex: '1 1 0',
    padding: '2px 6px',
    borderRadius: 6,
    border: selected ? UI_GOLD_BORDER : UI_GOLD_BORDER_SOFT,
    background: selected ? UI_BUTTON_BG : 'transparent',
    color: UI_TEXT_COLOR,
    font: 'inherit',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  };
}

const clearButtonStyle: CSSProperties = {
  padding: '4px 10px',
  borderRadius: 6,
  border: UI_GOLD_BORDER_SOFT,
  background: 'transparent',
  color: UI_TEXT_COLOR,
  font: 'inherit',
  cursor: 'pointer',
};

/**
 * The availability switch row (ステータス手動切替 — ROADMAP Phase 2): one
 * button per availability, the current one highlighted from the
 * authoritative row (never from the click — the row event is what everyone
 * else sees). Buttons rather than a <select> deliberately: isTextEntry
 * (game.package/input.ts) exempts only text fields, so a focused select
 * would feed arrow keys to BOTH the value and the avatar's movement. Each
 * click blurs its button (blurringClick — see its comment for the
 * keyboard reasons; re-verified by hand for these buttons, 2026-08-03).
 */
function AvailabilityRow({
  disabled,
  current,
  onSetAvailability,
}: {
  disabled: boolean;
  current: Availability;
  onSetAvailability: (availability: Availability) => void;
}) {
  return (
    <div style={rowStyle}>
      {AVAILABILITIES.map((availability) => (
        <button
          key={availability}
          type="button"
          style={availabilityButtonStyle(availability === current)}
          aria-label={`ステータス ${AVAILABILITY_LABELS[availability]}`}
          aria-pressed={availability === current}
          disabled={disabled}
          onClick={blurringClick(() => onSetAvailability(availability))}
        >
          {AVAILABILITY_ICONS[availability]} {AVAILABILITY_LABELS[availability]}
        </button>
      ))}
    </div>
  );
}

/**
 * The manual status panel (ROADMAP Phase 2): the three-state availability
 * switch over the free-text line, rendered beside the avatar's name by the
 * canvas (statusLabel). Gated exactly like the chat panel — a status write
 * needs a player row to land on, and `ownName` is defined exactly while one
 * exists.
 *
 * The free-text form validates with the same shared rule the server
 * enforces (normalizeStatusText), so a text that leaves the form is never
 * refused for its content. clearOnSubmit — unlike the rename form — because
 * the applied text becomes the placeholder: the emptied input showing the
 * authoritative line IS the success signal, and the next draft starts
 * clean. Submitting an empty draft is the clear operation; the クリア
 * button is the discoverable spelling of the same thing.
 */
export function StatusControl({
  connected,
  ownName,
  status,
  onSetAvailability,
  onSetStatusText,
}: {
  connected: boolean;
  /** The authoritative name from the own player row; undefined without one. */
  ownName: string | undefined;
  /** The authoritative own status (DEFAULT_STATUS while no row exists). */
  status: StatusView;
  onSetAvailability: (availability: Availability) => void;
  /** Sets the free-text status line; '' clears it. */
  onSetStatusText: (text: string) => void;
}) {
  // The shared posting gate: a status write needs a player row to land on.
  const disabled = postingDisabled(connected, ownName);

  const submit = (draft: string): string | undefined => {
    const verdict = normalizeStatusText(draft);
    if (!verdict.ok) return REJECT_MESSAGES[verdict.reason];
    onSetStatusText(verdict.text);
    return undefined;
  };

  return (
    <div style={panelStyle}>
      <AvailabilityRow
        disabled={disabled}
        current={status.availability}
        onSetAvailability={onSetAvailability}
      />
      <div style={textRowStyle}>
        <DraftForm
          disabled={disabled}
          placeholder={status.text === '' ? 'ひとことステータス' : status.text}
          ariaLabel="ひとことステータス"
          buttonLabel="設定"
          clearOnSubmit={true}
          formStyle={textRowStyle}
          submit={submit}
        />
        <button
          type="button"
          style={clearButtonStyle}
          aria-label="ひとことステータスをクリア"
          disabled={disabled || status.text === ''}
          onClick={blurringClick(() => onSetStatusText(''))}
        >
          クリア
        </button>
      </div>
    </div>
  );
}
