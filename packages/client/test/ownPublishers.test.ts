import { statusLabel, type StatusView } from '@kaede/shared';
import { describe, expect, it } from 'vite-plus/test';
import type { PlayerLabelPatch } from '../src/game.package';
import { createOwnPublishers } from '../src/net.package/ownPublishers';

function harness() {
  const patches: PlayerLabelPatch[] = [];
  const names: (string | undefined)[] = [];
  const statuses: StatusView[] = [];
  const publishers = createOwnPublishers({
    patchLocalLabel: (patch) => {
      patches.push(patch);
    },
    onOwnName: (name) => {
      names.push(name);
    },
    onOwnStatus: (view) => {
      statuses.push(view);
    },
  });
  return { publishers, patches, names, statuses };
}

describe('publishOwnName', () => {
  it('reports a new name to the label and the hook, once per change', () => {
    const { publishers, patches, names } = harness();
    publishers.publishOwnName('Aoi');
    // The double report a join produces (row handler + insert event) is
    // deduplicated here, not by React's same-value bailout.
    publishers.publishOwnName('Aoi');
    expect(patches).toEqual([{ name: 'Aoi' }]);
    expect(names).toEqual(['Aoi']);
    publishers.publishOwnName('Ren');
    expect(patches).toEqual([{ name: 'Aoi' }, { name: 'Ren' }]);
    expect(names).toEqual(['Aoi', 'Ren']);
  });

  it('reports a lost row as undefined without blanking the label', () => {
    const { publishers, patches, names } = harness();
    // A fresh stack starts at "no row known": nothing to report yet.
    publishers.publishOwnName(undefined);
    expect(names).toEqual([]);
    publishers.publishOwnName('Aoi');
    publishers.publishOwnName(undefined);
    publishers.publishOwnName(undefined);
    expect(names).toEqual(['Aoi', undefined]);
    // The label keeps its last text while the row is gone.
    expect(patches).toEqual([{ name: 'Aoi' }]);
  });
});

describe('publishOwnStatus', () => {
  it('publishes the composed label line and the raw view, deduplicated by value', () => {
    const { publishers, patches, statuses } = harness();
    const away: StatusView = { availability: 'away', text: '' };
    publishers.publishOwnStatus(away);
    // Same value in a fresh object (the session-entry double report) is
    // still the same status.
    publishers.publishOwnStatus({ availability: 'away', text: '' });
    expect(patches).toEqual([{ status: statusLabel(away), availability: 'away' }]);
    expect(statuses).toEqual([away]);
  });

  it('republishes when either field changes', () => {
    const { publishers, patches, statuses } = harness();
    publishers.publishOwnStatus({ availability: 'away', text: '' });
    publishers.publishOwnStatus({ availability: 'away', text: 'もくもく' });
    publishers.publishOwnStatus({ availability: 'busy', text: 'もくもく' });
    expect(patches).toEqual([
      { status: statusLabel({ availability: 'away', text: '' }), availability: 'away' },
      { status: statusLabel({ availability: 'away', text: 'もくもく' }), availability: 'away' },
      { status: statusLabel({ availability: 'busy', text: 'もくもく' }), availability: 'busy' },
    ]);
    expect(statuses.map((view) => `${view.availability}:${view.text}`)).toEqual([
      'away:',
      'away:もくもく',
      'busy:もくもく',
    ]);
  });

  it('publishes the default status with no label line', () => {
    const { publishers, patches } = harness();
    publishers.publishOwnStatus({ availability: 'online', text: '' });
    expect(patches).toEqual([{ status: undefined, availability: 'online' }]);
  });
});
