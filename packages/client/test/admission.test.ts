import { Identity } from 'spacetimedb';
import { describe, expect, it } from 'vite-plus/test';
import { type SpaceView, wireAdmission } from '../src/net.package/admission';
import { sessionRows } from '../src/net.package/rowEvents';
import type { RowOf } from '../src/net.package/rows';
type SpaceMember = RowOf<'spaceMember'>;
type SpaceSetting = RowOf<'spaceSetting'>;
import { at, fakeConnection, fakeTable } from './fakeDb';

const ME = new Identity(1n);
const OTHER = new Identity(2n);

const memberRow = (
  identity: Identity,
  status: string,
  requestedAtMs = 1000,
  displayName?: string,
): SpaceMember => ({
  identity,
  displayName,
  status,
  role: 'member',
  requestedAt: at(requestedAtMs),
  updatedAt: at(requestedAtMs),
});

const settingRow = (guestsAllowed: boolean): SpaceSetting => ({ id: 0, guestsAllowed });

function harness() {
  const spaceMember = fakeTable<SpaceMember>({ identity: (row) => row.identity });
  const spaceSetting = fakeTable<SpaceSetting>({ id: (row) => row.id });
  const conn = fakeConnection({ spaceMember, spaceSetting });
  const rows = sessionRows(ME.toHexString(), () => false);
  const views: SpaceView[] = [];
  let enters = 0;
  const hooks = {
    onSpace: (view: SpaceView) => views.push(view),
    enterWorld: () => {
      enters += 1;
    },
  };
  return { spaceMember, spaceSetting, conn, rows, hooks, views, enters: () => enters };
}

describe('wireAdmission', () => {
  it('admits a guest while no setting row exists (missing reads as allowed)', () => {
    const h = harness();
    const admission = wireAdmission(h.conn, h.rows, ME, h.hooks);
    admission.reevaluate();
    expect(h.views.at(-1)!.admission).toBe('admitted');
    expect(h.enters()).toBe(1);
    expect(h.views.at(-1)!.guestsAllowed).toBe(true);
    expect(h.views.at(-1)!.self).toBeUndefined();
  });

  it('refuses a guest once the setting flips off, without entering', () => {
    const h = harness();
    h.spaceSetting.seed([settingRow(false)]);
    const admission = wireAdmission(h.conn, h.rows, ME, h.hooks);
    admission.reevaluate();
    expect(h.views.at(-1)!.admission).toBe('guests-not-allowed');
    expect(h.enters()).toBe(0);
  });

  it('re-evaluates on membership changes: pending holds, approval enters', () => {
    const h = harness();
    h.spaceSetting.seed([settingRow(false)]);
    wireAdmission(h.conn, h.rows, ME, h.hooks);
    h.spaceMember.insert(memberRow(ME, 'pending'));
    expect(h.views.at(-1)!.admission).toBe('pending-approval');
    expect(h.enters()).toBe(0);
    h.spaceMember.update(memberRow(ME, 'approved'));
    expect(h.views.at(-1)!.admission).toBe('admitted');
    expect(h.enters()).toBe(1);
    expect(h.views.at(-1)!.self?.status).toBe('approved');
  });

  it('publishes the directory oldest first, with the own row marked as self', () => {
    const h = harness();
    h.spaceMember.seed([
      memberRow(OTHER, 'approved', 2000, 'はなこ'),
      memberRow(ME, 'approved', 1000),
    ]);
    const admission = wireAdmission(h.conn, h.rows, ME, h.hooks);
    admission.reevaluate();
    const view = h.views.at(-1)!;
    expect(view.members.map((member) => member.idHex)).toEqual([
      ME.toHexString(),
      OTHER.toHexString(),
    ]);
    expect(view.members[1].displayName).toBe('はなこ');
    expect(view.self?.idHex).toBe(ME.toHexString());
  });

  it('re-evaluates on space_setting events, not only on manual calls', () => {
    const h = harness();
    wireAdmission(h.conn, h.rows, ME, h.hooks);
    // No reevaluate() call after wiring: the setting row's own events must
    // drive the re-evaluation (rows.onAny on spaceSetting).
    h.spaceSetting.insert(settingRow(false));
    expect(h.views.at(-1)!.admission).toBe('guests-not-allowed');
    expect(h.enters()).toBe(0);
    h.spaceSetting.update(settingRow(true));
    expect(h.views.at(-1)!.admission).toBe('admitted');
    expect(h.enters()).toBe(1);
  });

  it('a rejected membership refuses even while guests are allowed', () => {
    const h = harness();
    h.spaceMember.seed([memberRow(ME, 'rejected')]);
    const admission = wireAdmission(h.conn, h.rows, ME, h.hooks);
    admission.reevaluate();
    expect(h.views.at(-1)!.admission).toBe('rejected');
    expect(h.enters()).toBe(0);
  });
});
