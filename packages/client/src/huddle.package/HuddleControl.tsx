// fallow-ignore-file coverage-gaps -- a React control over the huddle reducers; needs a DOM, and no DOM test environment is configured. The authority for every action is server-side (huddles.ts over normalizeHuddleName / evaluateHuddleJoin, unit-tested in @kaede/shared)
import {
  HUDDLE_DEFAULT_NAME,
  type HuddleNameRejectReason,
  normalizeHuddleName,
  ZONE_NAME_MAX_LENGTH,
} from '@kaede/shared';
import { type CSSProperties, useState } from 'react';
import type { HuddleView } from '../net.package';
import { UI_BUTTON_BG, UI_FONT, UI_GOLD_BORDER, UI_PANEL_BG, UI_TEXT_COLOR } from '../theme';
import { blurringClick, DraftForm, postingDisabled } from '../ui.package';

/** The user-facing wording of each huddle-name refusal (normalizeHuddleName). */
const NAME_ERRORS: Record<HuddleNameRejectReason, string> = {
  'too-long': `名前は${ZONE_NAME_MAX_LENGTH}文字以内にしてください`,
  'forbidden-characters': '使えない文字が含まれています',
};

// Stacked above the status panel in the profile corner (bottom-left): a
// huddle is something you do from where your avatar stands, like a status
// is something you claim about yourself — not part of the chat panel.
const panelStyle: CSSProperties = {
  position: 'absolute',
  bottom: 148,
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
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
};

const actionButtonStyle: CSSProperties = {
  padding: '2px 8px',
  borderRadius: 6,
  border: UI_GOLD_BORDER,
  background: UI_BUTTON_BG,
  color: UI_TEXT_COLOR,
  font: 'inherit',
  cursor: 'pointer',
  flexShrink: 0,
};

/** What the control dispatches — one callback per huddle reducer (see NetApi). */
export interface HuddleActions {
  onCreateHuddle(spec: { name: string; closed: boolean }): void;
  onJoinHuddle(groupId: bigint): void;
  onLeaveHuddle(): void;
}

/**
 * The founding form (DraftForm carries the input, submit and inline error
 * — the status-text precedent): an optional name (empty means
 * HUDDLE_DEFAULT_NAME — founding must stay a one-click gesture) and the
 * オープン/クローズド choice. The founding position is server-side
 * ("where the sender stands"), so there is nothing else to ask;
 * validation mirrors the server's normalizeHuddleName for instant
 * feedback.
 */
function FoundHuddleForm({
  disabled,
  onCreate,
}: {
  disabled: boolean;
  onCreate: HuddleActions['onCreateHuddle'];
}) {
  const [closed, setClosed] = useState(false);

  const submit = (draft: string): string | undefined => {
    const verdict = normalizeHuddleName(draft);
    if (!verdict.ok) return NAME_ERRORS[verdict.reason];
    onCreate({ name: verdict.name, closed });
    return undefined;
  };

  return (
    <div style={rowStyle}>
      <DraftForm
        disabled={disabled}
        placeholder={HUDDLE_DEFAULT_NAME}
        ariaLabel="立ち話の名前"
        buttonLabel="ここで立ち話"
        clearOnSubmit={true}
        formStyle={rowStyle}
        submit={submit}
      />
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        <input
          type="checkbox"
          checked={closed}
          disabled={disabled}
          onChange={(e) => setClosed(e.target.checked)}
        />
        コソコソ話す
      </label>
    </div>
  );
}

/**
 * The huddle control (ROADMAP Phase 3 増分③), for everyone in the world:
 * while in a huddle it names it and offers leaving; otherwise it offers
 * founding one on the spot and — while standing near one — joining it
 * (近づいて参加ボタン). What it offers comes from the feed's HuddleView
 * (the shared join rule over the subscribed cache); the server re-rules
 * every action, so the offers are UX, not authority.
 */
export function HuddleControl({
  connected,
  ownName,
  view,
  actions,
}: {
  connected: boolean;
  /** The authoritative name from the own player row; undefined without one. */
  ownName: string | undefined;
  view: HuddleView;
  actions: HuddleActions;
}) {
  // The shared posting gate: a huddle action needs a player row to act from.
  const disabled = postingDisabled(connected, ownName);

  if (view.own !== undefined) {
    return (
      <div style={panelStyle}>
        <div style={rowStyle}>
          <span>{view.own}</span>
          <button
            type="button"
            style={actionButtonStyle}
            disabled={disabled}
            onClick={blurringClick(actions.onLeaveHuddle)}
          >
            抜ける
          </button>
        </div>
      </div>
    );
  }
  const joinable = view.joinable;
  return (
    <div style={panelStyle}>
      {joinable !== undefined && (
        <div style={rowStyle}>
          <button
            type="button"
            style={actionButtonStyle}
            disabled={disabled}
            onClick={blurringClick(() => actions.onJoinHuddle(joinable.id))}
          >
            {joinable.label} に参加
          </button>
        </div>
      )}
      <FoundHuddleForm disabled={disabled} onCreate={actions.onCreateHuddle} />
    </div>
  );
}
