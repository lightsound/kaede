import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/studio.package/catalog';

const pose = (file: string) => ({
  file,
  size: [52, 96],
  anchors: { neck: [25, 49], hand: [15, 67] },
});

const avatarManifest = (id: string, poses: Record<string, unknown>) => ({
  id,
  type: 'avatar-body',
  name: `名前 ${id}`,
  poses,
});

const itemManifest = (id: string) => ({
  id,
  type: 'held-item',
  name: `アイテム ${id}`,
  frame: { file: 'item.png', size: [10, 16], anchors: { grip: [5, 12] } },
});

describe('buildCatalog', () => {
  it('builds avatars and items with resolved PNG URLs and anchors', () => {
    const catalog = buildCatalog(
      {
        './a/manifest.json': avatarManifest('avatar.a', { stand: pose('stand.png') }),
        './items/mug/manifest.json': itemManifest('item.mug'),
      },
      { './a/stand.png': '/assets/stand.png', './items/mug/item.png': '/assets/item.png' },
    );
    expect(catalog.problems).toEqual([]);
    expect(catalog.avatars).toHaveLength(1);
    const avatar = catalog.avatars[0];
    expect(avatar?.id).toBe('avatar.a');
    expect(avatar?.name).toBe('名前 avatar.a');
    expect(avatar?.poses).toEqual([
      {
        pose: 'stand',
        frame: {
          file: 'stand.png',
          url: '/assets/stand.png',
          size: [52, 96],
          anchors: { neck: [25, 49], hand: [15, 67] },
        },
      },
    ]);
    expect(catalog.items).toHaveLength(1);
    expect(catalog.items[0]?.frame.url).toBe('/assets/item.png');
    expect(catalog.items[0]?.frame.anchors.grip).toEqual([5, 12]);
  });

  it('detects missing poses as the set difference against the roster union', () => {
    const catalog = buildCatalog(
      {
        './a/manifest.json': avatarManifest('avatar.a', {
          stand: pose('stand.png'),
          'walk-a': pose('walk-a.png'),
          'walk-b': pose('walk-b.png'),
        }),
        './b/manifest.json': avatarManifest('avatar.b', {
          stand: pose('stand.png'),
          'walk-a': pose('walk-a.png'),
          sit: pose('sit.png'),
        }),
      },
      {
        './a/stand.png': 'u',
        './a/walk-a.png': 'u',
        './a/walk-b.png': 'u',
        './b/stand.png': 'u',
        './b/walk-a.png': 'u',
        './b/sit.png': 'u',
      },
    );
    // First-seen order: avatar.a's poses, then avatar.b's novel ones.
    expect(catalog.poseUnion).toEqual(['stand', 'walk-a', 'walk-b', 'sit']);
    expect(catalog.avatars.map((a) => a.missingPoses)).toEqual([['sit'], ['walk-b']]);
    expect(catalog.problems).toEqual([]);
  });

  it('reports a referenced PNG that is not bundled, keeping the frame with url undefined', () => {
    const catalog = buildCatalog(
      { './a/manifest.json': avatarManifest('avatar.a', { stand: pose('stand.png') }) },
      {},
    );
    expect(catalog.problems).toEqual([
      './a/manifest.json poses.stand: 参照先 PNG（stand.png）が同梱されていません',
    ]);
    expect(catalog.avatars[0]?.poses[0]?.frame.url).toBeUndefined();
  });

  it('reports duplicate ids, unknown types, and non-object manifests', () => {
    const catalog = buildCatalog(
      {
        './a/manifest.json': avatarManifest('avatar.a', { stand: pose('stand.png') }),
        './b/manifest.json': avatarManifest('avatar.a', { stand: pose('stand.png') }),
        './c/manifest.json': { id: 'x', type: 'mystery' },
        './d/manifest.json': 'not an object',
      },
      { './a/stand.png': 'u', './b/stand.png': 'u' },
    );
    expect(catalog.problems).toEqual([
      './b/manifest.json: id「avatar.a」が ./a/manifest.json と重複しています',
      './c/manifest.json: 未知の type（mystery）です',
      './d/manifest.json: JSON がオブジェクトではありません',
    ]);
    // Both rows still render — inspection shows the duplicate instead of hiding it.
    expect(catalog.avatars).toHaveLength(2);
  });

  it('reports empty poses, a missing id, and a frame without file', () => {
    const catalog = buildCatalog(
      {
        './a/manifest.json': avatarManifest('avatar.a', {}),
        './b/manifest.json': { type: 'avatar-body', poses: { stand: pose('stand.png') } },
        './c/manifest.json': { id: 'item.c', type: 'held-item', frame: { size: [1, 2] } },
      },
      {},
    );
    expect(catalog.problems).toEqual([
      './a/manifest.json: poses が空です',
      './b/manifest.json: id がありません',
      './c/manifest.json frame: frame 定義が不正です（file がありません）',
    ]);
    expect(catalog.avatars).toHaveLength(1);
    expect(catalog.items).toHaveLength(0);
  });

  it('parses the carry sheets handLayer and falls back to the id when name is absent', () => {
    const catalog = buildCatalog(
      {
        './carry/manifest.json': {
          id: 'avatar.carry',
          type: 'avatar-body',
          poses: { stand: pose('stand.png') },
          handLayer: { file: 'hand.png', size: [16, 12], anchors: { grip: [14, 4] } },
        },
      },
      { './carry/stand.png': 'u', './carry/hand.png': '/assets/hand.png' },
    );
    expect(catalog.problems).toEqual([]);
    const avatar = catalog.avatars[0];
    expect(avatar?.name).toBe('avatar.carry');
    expect(avatar?.handLayer).toEqual({
      file: 'hand.png',
      url: '/assets/hand.png',
      size: [16, 12],
      anchors: { grip: [14, 4] },
    });
  });

  it('drops malformed anchor and size pairs instead of failing', () => {
    const catalog = buildCatalog(
      {
        './a/manifest.json': avatarManifest('avatar.a', {
          stand: { file: 'stand.png', size: 'huge', anchors: { neck: [1, 2], hand: 'nope' } },
        }),
      },
      { './a/stand.png': 'u' },
    );
    const frame = catalog.avatars[0]?.poses[0]?.frame;
    expect(frame?.size).toBeUndefined();
    expect(frame?.anchors).toEqual({ neck: [1, 2] });
  });
});
