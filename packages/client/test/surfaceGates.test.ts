import type { MemberStatus } from '@kaede/shared';
import { Identity } from 'spacetimedb';
import { describe, expect, it } from 'vite-plus/test';
import { approvedMember, recordingsDockVisible } from '../src/call.package/recordingAccess';
import type { SpaceMemberView, SpaceView } from '../src/net.package';
import { promptFor } from '../src/space.package/applyPrompt';

function member(status: MemberStatus): SpaceMemberView {
  return {
    identity: Identity.zero(),
    idHex: '00',
    displayName: 'かえで',
    status,
    role: 'member',
    requestedAtMs: 0,
  };
}

/** A space view whose directory holds `members`, with `self` as this client's own row. */
function space(self: SpaceMemberView | undefined, members: SpaceMemberView[]): SpaceView {
  return { admission: 'admitted', self, guestsAllowed: true, members };
}

describe('promptFor', () => {
  it('offers nothing to a guest', () => {
    expect(promptFor(false, space(undefined, []))).toBeUndefined();
    expect(promptFor(false, undefined)).toBeUndefined();
  });

  it('falls back to the first application before the first space report', () => {
    // No surface renders it yet: there is no admission until the report.
    expect(promptFor(true, undefined)).toBe('apply-first');
  });

  it('labels the first application only while the directory is empty, whatever the rows say', () => {
    expect(promptFor(true, space(undefined, []))).toBe('apply-first');
    expect(promptFor(true, space(undefined, [member('rejected')]))).toBe('apply');
  });

  it("reads this client's own row: re-application after a rejection, nothing while pending", () => {
    const rejected = member('rejected');
    expect(promptFor(true, space(rejected, [rejected]))).toBe('reapply');
    const pending = member('pending');
    expect(promptFor(true, space(pending, [pending]))).toBeUndefined();
  });
});

describe('approvedMember', () => {
  it('needs both a sign-in and an approved own row', () => {
    const approved = member('approved');
    expect(approvedMember(true, space(approved, [approved]))).toBe(true);
    expect(approvedMember(false, space(approved, [approved]))).toBe(false);
    const pending = member('pending');
    expect(approvedMember(true, space(pending, [pending]))).toBe(false);
    expect(approvedMember(true, space(undefined, [approved]))).toBe(false);
    expect(approvedMember(true, undefined)).toBe(false);
  });
});

describe('recordingsDockVisible', () => {
  it('shows the dock to a connected approved member only', () => {
    const approved = member('approved');
    expect(recordingsDockVisible(true, true, space(approved, [approved]))).toBe(true);
    expect(recordingsDockVisible(false, true, space(approved, [approved]))).toBe(false);
    expect(recordingsDockVisible(true, false, space(approved, [approved]))).toBe(false);
  });
});
