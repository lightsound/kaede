// fallow-ignore-file coverage-gaps -- a React gate around the admin panel; needs a DOM, and no DOM test environment is configured. The gating rule is isActingAdmin, unit-tested in @maple/shared
import { isActingAdmin } from '@maple/shared';
import type { RefObject } from 'react';
import type { Net, SpaceView } from '../net.package';
import { AdminPanel } from './AdminPanel';

/**
 * Shows the admin panel to acting admins, wired to the net stack's admin
 * actions. Read through a ref because the net stack is created inside an
 * effect after mount; the handlers resolve it at click time, the App's
 * NameEditor precedent. Hidden while disconnected — the roster would be
 * stale and every action would be dropped anyway.
 */
export function AdminSection({
  connected,
  space,
  netRef,
}: {
  connected: boolean;
  space: SpaceView | undefined;
  netRef: RefObject<Net | undefined>;
}) {
  if (!connected || space === undefined || !isActingAdmin(space.self)) return null;
  return (
    <AdminPanel
      members={space.members}
      guestsAllowed={space.guestsAllowed}
      onApprove={(idHex) => netRef.current?.approveMember(idHex)}
      onRemove={(idHex) => netRef.current?.removeMember(idHex)}
      onGuestsAllowedChange={(allowed) => netRef.current?.setGuestsAllowed(allowed)}
    />
  );
}
