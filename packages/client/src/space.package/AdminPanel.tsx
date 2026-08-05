// fallow-ignore-file coverage-gaps -- a React panel over the subscribed member directory; needs a DOM, and no DOM test environment is configured. The authority for every action here is server-side (evaluateMemberAction / evaluateSettingChange, unit-tested in @kaede/shared)
import type { MemberAction, MemberStatus } from '@kaede/shared';
import type { CSSProperties } from 'react';
import type { SpaceMemberView, ZoneAdminView } from '../net.package';
import { UI_FONT, UI_GOLD_BORDER, UI_PANEL_BG, UI_TEXT_COLOR } from '../theme';
import { AnnouncePanel } from './AnnouncePanel';
import { panelButtonStyle, panelHeadingStyle, panelRowStyle } from './panelChrome';
import { type ZoneActions, ZonePanel } from './ZonePanel';

const panelStyle: CSSProperties = {
  position: 'absolute',
  top: 56,
  right: 12,
  width: 280,
  maxHeight: '70vh',
  overflowY: 'auto',
  padding: '10px 12px',
  borderRadius: 8,
  background: UI_PANEL_BG,
  border: UI_GOLD_BORDER,
  color: UI_TEXT_COLOR,
  font: UI_FONT,
};

/** A member row pushes its actions to the right edge, unlike a form row. */
const memberRowStyle: CSSProperties = {
  ...panelRowStyle,
  justifyContent: 'space-between',
  flexWrap: 'nowrap',
};

const nameStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

/** One labelled member transition, as a section offers it. */
interface ActionButton {
  label: string;
  action: MemberAction;
}

/**
 * What each section offers — a deliberate subset of the server's transition
 * table (evaluateMemberAction), not a mirror of it: banning straight from
 * pending is omitted because 拒否→バン covers the rare case, and admin rows
 * render without buttons below because admins cannot be targeted, so a dead
 * button would only mislead. Everything here is reversible: 拒否済み/バン中
 * keep their rows and offer the way back (承認 recovers in one click).
 */
const SECTIONS: readonly {
  title: string;
  status: MemberStatus;
  actions: readonly ActionButton[];
  /** Sections for exceptional states hide while empty; the core two stay. */
  hideWhenEmpty: boolean;
}[] = [
  {
    title: '承認待ち',
    status: 'pending',
    actions: [
      { label: '承認', action: 'approve' },
      { label: '拒否', action: 'reject' },
    ],
    hideWhenEmpty: false,
  },
  {
    title: 'メンバー',
    status: 'approved',
    actions: [{ label: '追放', action: 'reject' }],
    hideWhenEmpty: false,
  },
  {
    title: '拒否済み',
    status: 'rejected',
    actions: [
      { label: '承認', action: 'approve' },
      { label: 'バン', action: 'ban' },
    ],
    hideWhenEmpty: true,
  },
  {
    title: 'バン中',
    status: 'banned',
    actions: [
      { label: '承認', action: 'approve' },
      { label: '解除', action: 'unban' },
    ],
    hideWhenEmpty: true,
  },
];

/** What the list shows for a member who has not set a name yet. */
function labelOf(member: SpaceMemberView): string {
  return member.displayName ?? `未設定 (${member.idHex.slice(0, 6)})`;
}

/** One member with the actions its section offers. */
function MemberRow({
  member,
  actions,
  onMemberAction,
}: {
  member: SpaceMemberView;
  actions: readonly ActionButton[];
  onMemberAction: (action: MemberAction, member: SpaceMemberView) => void;
}) {
  return (
    <div style={memberRowStyle}>
      <span style={nameStyle}>
        {labelOf(member)}
        {member.role === 'admin' && <span style={{ opacity: 0.6 }}> (管理者)</span>}
      </span>
      <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        {actions.map(({ label, action }) => (
          <button
            key={action}
            type="button"
            style={panelButtonStyle}
            onClick={() => onMemberAction(action, member)}
          >
            {label}
          </button>
        ))}
      </span>
    </div>
  );
}

/**
 * The minimal admin panel (ROADMAP Phase 1: 管理者ロール): applications to
 * decide, members to expel, mistakes to undo, the guest-admission toggle,
 * and the meeting-room zones (Phase 3 増分② — see ZonePanel). Rendering
 * this panel is gated on the viewer's own role, but that gate is cosmetic
 * — every action is re-checked server-side against the sender's
 * membership. Results arrive as row events refreshing the props; there is
 * no local success state to get out of sync.
 */
export function AdminPanel({
  members,
  guestsAllowed,
  zones,
  zoneActions,
  onMemberAction,
  onGuestsAllowedChange,
  onSendAnnouncement,
}: {
  /** The whole member directory, oldest application first (see SpaceView.members). */
  members: SpaceMemberView[];
  guestsAllowed: boolean;
  /** The whole zone list, every map, creation order (see ZoneAdminView). */
  zones: ZoneAdminView[];
  zoneActions: ZoneActions;
  onMemberAction: (action: MemberAction, member: SpaceMemberView) => void;
  onGuestsAllowedChange: (allowed: boolean) => void;
  /** Posts one space-wide announcement (see AnnouncePanel / Net.sendAnnouncement). */
  onSendAnnouncement: (text: string) => void;
}) {
  return (
    <section style={panelStyle} aria-label="管理">
      <div style={{ ...panelHeadingStyle, marginTop: 0 }}>管理</div>

      <label style={{ ...memberRowStyle, cursor: 'pointer' }}>
        <span>ゲスト入場を許可</span>
        <input
          type="checkbox"
          checked={guestsAllowed}
          onChange={(e) => onGuestsAllowedChange(e.target.checked)}
        />
      </label>

      {SECTIONS.map(({ title, status, actions, hideWhenEmpty }) => {
        const list = members.filter((m) => m.status === status);
        if (hideWhenEmpty && list.length === 0) return null;
        return (
          <div key={status}>
            <div style={panelHeadingStyle}>
              {title} ({list.length})
            </div>
            {list.map((member) => (
              <MemberRow
                key={member.idHex}
                member={member}
                actions={member.role === 'admin' ? [] : actions}
                onMemberAction={onMemberAction}
              />
            ))}
          </div>
        );
      })}

      <ZonePanel zones={zones} actions={zoneActions} />

      <AnnouncePanel onSendAnnouncement={onSendAnnouncement} />
    </section>
  );
}
