// fallow-ignore-file coverage-gaps -- a React panel over the subscribed member directory; needs a DOM, and no DOM test environment is configured. The authority for every action here is server-side (evaluateApproval / evaluateRemoval / evaluateSettingChange, unit-tested in @maple/shared)
import type { CSSProperties } from 'react';
import type { SpaceMemberView } from '../net.package';
import {
  UI_BUTTON_BG,
  UI_FONT,
  UI_GOLD,
  UI_GOLD_BORDER,
  UI_PANEL_BG,
  UI_TEXT_COLOR,
} from '../theme';

const panelStyle: CSSProperties = {
  position: 'absolute',
  top: 56,
  right: 12,
  width: 260,
  maxHeight: '70vh',
  overflowY: 'auto',
  padding: '10px 12px',
  borderRadius: 8,
  background: UI_PANEL_BG,
  border: UI_GOLD_BORDER,
  color: UI_TEXT_COLOR,
  font: UI_FONT,
};

const headingStyle: CSSProperties = {
  font: `bold ${UI_FONT}`,
  color: UI_GOLD,
  margin: '8px 0 4px',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 6,
  padding: '3px 0',
};

const nameStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const buttonStyle: CSSProperties = {
  padding: '2px 8px',
  borderRadius: 6,
  border: UI_GOLD_BORDER,
  background: UI_BUTTON_BG,
  color: UI_TEXT_COLOR,
  font: 'inherit',
  cursor: 'pointer',
  flexShrink: 0,
};

/** What the list shows for a member who has not set a name yet. */
function labelOf(member: SpaceMemberView): string {
  return member.displayName ?? `未設定 (${member.idHex.slice(0, 6)})`;
}

/**
 * The minimal admin panel (ROADMAP Phase 1: 管理者ロール): the pending list
 * with approve/remove, the member list with remove, and the guest-admission
 * toggle. Rendering this panel is gated on the viewer's own role, but that
 * gate is cosmetic — every action is re-checked server-side against the
 * sender's membership. Results arrive as row events refreshing the props;
 * there is no local success state to get out of sync.
 */
export function AdminPanel({
  members,
  guestsAllowed,
  onApprove,
  onRemove,
  onGuestsAllowedChange,
}: {
  /** The whole member directory, oldest first (see SpaceView.members). */
  members: SpaceMemberView[];
  guestsAllowed: boolean;
  onApprove: (member: SpaceMemberView) => void;
  onRemove: (member: SpaceMemberView) => void;
  onGuestsAllowedChange: (allowed: boolean) => void;
}) {
  const pending = members.filter((m) => m.status === 'pending');
  const approved = members.filter((m) => m.status === 'approved');

  return (
    <section style={panelStyle} aria-label="管理">
      <div style={{ ...headingStyle, marginTop: 0 }}>管理</div>

      <label style={{ ...rowStyle, cursor: 'pointer' }}>
        <span>ゲスト入場を許可</span>
        <input
          type="checkbox"
          checked={guestsAllowed}
          onChange={(e) => onGuestsAllowedChange(e.target.checked)}
        />
      </label>

      <div style={headingStyle}>承認待ち ({pending.length})</div>
      {pending.length === 0 && <div style={{ opacity: 0.6 }}>承認待ちのメンバーはいません</div>}
      {pending.map((member) => (
        <div key={member.idHex} style={rowStyle}>
          <span style={nameStyle}>{labelOf(member)}</span>
          <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            <button type="button" style={buttonStyle} onClick={() => onApprove(member)}>
              承認
            </button>
            <button type="button" style={buttonStyle} onClick={() => onRemove(member)}>
              削除
            </button>
          </span>
        </div>
      ))}

      <div style={headingStyle}>メンバー ({approved.length})</div>
      {approved.map((member) => (
        <div key={member.idHex} style={rowStyle}>
          <span style={nameStyle}>
            {labelOf(member)}
            {member.role === 'admin' && <span style={{ opacity: 0.6 }}> (管理者)</span>}
          </span>
          {/* Admins are not removable (server-enforced too), so no dead button. */}
          {member.role !== 'admin' && (
            <button type="button" style={buttonStyle} onClick={() => onRemove(member)}>
              削除
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
