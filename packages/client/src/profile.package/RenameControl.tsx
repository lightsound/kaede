// fallow-ignore-file coverage-gaps -- a small React gate around NameEditor; needs a DOM, and no DOM test environment is configured. The validation behind it is normalizeDisplayName/evaluateRename, unit-tested in @maple/shared
import type { SpaceMemberView } from '../net.package';
import { NameEditor } from './NameEditor';

/** The placeholder: the in-world name, else the name on the membership. */
function currentNameOf(
  ownName: string | undefined,
  self: SpaceMemberView | undefined,
): string | undefined {
  return ownName ?? self?.displayName;
}

/**
 * Decides when the name form is usable: a rename needs somewhere to land
 * (see evaluateRename) — the own player row while in the world, or, for a
 * member still in the waiting room, the account behind the own membership
 * row. That second case is deliberate: a pending member's name is what the
 * admin sees in the approval list, so setting it before entry matters most.
 */
export function RenameControl({
  connected,
  ownName,
  self,
  onSubmit,
}: {
  connected: boolean;
  /** The authoritative name from the own player row; undefined without one. */
  ownName: string | undefined;
  /** The own membership row; undefined for guests. */
  self: SpaceMemberView | undefined;
  onSubmit: (name: string) => void;
}) {
  const hasRenameTarget = ownName !== undefined || self !== undefined;
  return (
    <NameEditor
      disabled={!connected || !hasRenameTarget}
      currentName={currentNameOf(ownName, self)}
      onSubmit={onSubmit}
    />
  );
}
