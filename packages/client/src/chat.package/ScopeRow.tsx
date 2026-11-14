// fallow-ignore-file coverage-gaps -- a React scope-selector row for the chat panel; needs a DOM, and no DOM test environment is configured. Which scopes exist is decided by the net stack's chat scope feed (unit-tested in net.package), and this file only renders the offered list
import { type ChatScope } from '@kaede/shared';
import { type CSSProperties } from 'react';
import { type ChatScopeView } from '../net.package';
import {
  UI_BUTTON_BG,
  UI_GOLD,
  UI_GOLD_BORDER,
  UI_GOLD_BORDER_SOFT,
  UI_TEXT_COLOR,
} from '../theme';
import { blurringClick } from '../ui.package';

const scopeRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 4,
  margin: 0,
  padding: 0,
  border: 'none',
};

const scopeLegendStyle: CSSProperties = {
  float: 'left', // a legend is a block box; floating keeps the row on one line
  padding: '0 4px 0 0',
  opacity: 0.7,
};

const scopeButtonStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  padding: '2px 8px',
  borderRadius: 999,
  border: UI_GOLD_BORDER_SOFT,
  background: 'transparent',
  color: UI_TEXT_COLOR,
  font: 'inherit',
  cursor: 'pointer',
};

/** The picked scope, filled so "where this goes" is readable at a glance. */
const scopeSelectedStyle: CSSProperties = {
  ...scopeButtonStyle,
  border: UI_GOLD_BORDER,
  background: UI_BUTTON_BG,
  color: UI_GOLD,
};

/**
 * The send-scope selector (送信先スコープ切替): a radio group naming exactly
 * what a send would reach — 全体, this map, or the conversation group the
 * sender is in. The list comes from the net stack (which scopes exist is a
 * question about the authoritative rows), so a scope the server would
 * refuse is never offered and the 会話グループ choice simply disappears
 * when the sender walks out.
 *
 * Real radio inputs inside labels, not styled buttons: the group's
 * semantics come free (and the specs can ask for a radio by its label).
 * Each change blurs the input for the reason the palette rows use
 * blurringClick — a focused control eats the arrow keys the avatar walks
 * with.
 */
export function ScopeRow({
  scopes,
  selected,
  disabled,
  onSelect,
}: {
  scopes: ChatScopeView;
  selected: ChatScope;
  disabled: boolean;
  onSelect: (scope: ChatScope) => void;
}) {
  return (
    <fieldset style={scopeRowStyle}>
      <legend style={scopeLegendStyle}>送信先</legend>
      {scopes.map((option) => (
        <label
          key={option.scope}
          style={option.scope === selected ? scopeSelectedStyle : scopeButtonStyle}
        >
          <input
            type="radio"
            name="chat-scope"
            checked={option.scope === selected}
            disabled={disabled}
            onChange={blurringClick(() => onSelect(option.scope))}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
