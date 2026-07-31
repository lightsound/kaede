// fallow-ignore-file coverage-gaps -- a React gate around the admin panel; needs a DOM, and no DOM test environment is configured. The gating rule is isActingAdmin, unit-tested in @maple/shared
import { isActingAdmin } from '@maple/shared';
import type { SpaceMemberView, SpaceView } from '../net.package';
import { AdminPanel } from './AdminPanel';

/**
 * Shows the admin panel to acting admins. Hidden while disconnected — the
 * roster would be stale and every action would be dropped anyway. The
 * callbacks are plain functions so this package needs to know nothing about
 * how the App holds its net stack.
 */
export function AdminSection({
  connected,
  space,
  onApprove,
  onReject,
  onBan,
  onUnban,
  onGuestsAllowedChange,
}: {
  connected: boolean;
  space: SpaceView | undefined;
  onApprove: (member: SpaceMemberView) => void;
  onReject: (member: SpaceMemberView) => void;
  onBan: (member: SpaceMemberView) => void;
  onUnban: (member: SpaceMemberView) => void;
  onGuestsAllowedChange: (allowed: boolean) => void;
}) {
  if (!connected || space === undefined || !isActingAdmin(space.self)) return null;
  return (
    <AdminPanel
      members={space.members}
      guestsAllowed={space.guestsAllowed}
      onApprove={onApprove}
      onReject={onReject}
      onBan={onBan}
      onUnban={onUnban}
      onGuestsAllowedChange={onGuestsAllowedChange}
    />
  );
}
