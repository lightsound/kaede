import { describe, expect, it } from 'vitest';
import type {
  AssetCatalog,
  AssetFrame,
  AvatarAsset,
  ItemAsset,
} from '../src/studio.package/catalog';
import {
  carryVariantOf,
  DEFAULT_OUTFIT_ID,
  frameFor,
  maxFrameSize,
  outfitOptions,
  resolveStageLook,
  stageOverlays,
} from '../src/studio.package/dressup';

const frame = (over: Partial<AssetFrame> = {}): AssetFrame => ({
  file: 'stand.png',
  url: '/a/stand.png',
  size: [52, 96],
  anchors: { neck: [25, 49], hand: [26, 64] },
  ...over,
});

const avatar = (id: string, over: Partial<AvatarAsset> = {}): AvatarAsset => ({
  id,
  name: `名前 ${id}`,
  dir: `./${id}`,
  poses: [{ pose: 'stand', frame: frame() }],
  handLayer: undefined,
  missingPoses: [],
  ...over,
});

const item = (id: string, grip: readonly [number, number] = [5, 12]): ItemAsset => ({
  id,
  name: `アイテム ${id}`,
  dir: `./items/${id}`,
  frame: frame({ file: `${id}.png`, url: `/items/${id}.png`, size: [10, 16], anchors: { grip } }),
});

const catalogOf = (avatars: AvatarAsset[], items: ItemAsset[] = []): AssetCatalog => ({
  avatars,
  items,
  poseUnion: ['stand'],
  problems: [],
});

describe('outfitOptions / carryVariantOf', () => {
  it('offers every sheet except the carry variants, and pairs an outfit with its carry sheet', () => {
    const basic = avatar('avatar.boy-basic');
    const carry = avatar('avatar.boy-basic-carry');
    const red = avatar('avatar.boy-basic-red');
    const pants = avatar(DEFAULT_OUTFIT_ID);
    const catalog = catalogOf([basic, carry, red, pants]);
    expect(outfitOptions(catalog).map((o) => o.id)).toEqual([
      DEFAULT_OUTFIT_ID,
      'avatar.boy-basic',
      'avatar.boy-basic-red',
    ]);
    expect(carryVariantOf(catalog, 'avatar.boy-basic')?.id).toBe('avatar.boy-basic-carry');
    expect(carryVariantOf(catalog, 'avatar.boy-basic-red')).toBeUndefined();
  });
});

describe('resolveStageLook', () => {
  const basic = avatar('avatar.boy-basic');
  const carry = avatar('avatar.boy-basic-carry');
  const red = avatar('avatar.boy-basic-red');
  const pants = avatar(DEFAULT_OUTFIT_ID);
  const pantsCarry = avatar(`${DEFAULT_OUTFIT_ID}-carry`);
  const mug = item('item.mug');

  it('defaults to the pants-only base outfit with empty hands', () => {
    const look = resolveStageLook(
      catalogOf([basic, carry, red, pants, pantsCarry], [mug]),
      undefined,
      undefined,
    );
    expect(look?.outfit.id).toBe(DEFAULT_OUTFIT_ID);
    expect(look?.body.id).toBe(DEFAULT_OUTFIT_ID);
    expect(look?.item).toBeUndefined();
    expect(look?.note).toBeUndefined();
  });

  it('holding an item swaps the body to the carry variant (one decision, not two)', () => {
    const look = resolveStageLook(
      catalogOf([basic, carry, red], [mug]),
      'avatar.boy-basic',
      'item.mug',
    );
    expect(look?.outfit.id).toBe('avatar.boy-basic');
    expect(look?.body.id).toBe('avatar.boy-basic-carry');
    expect(look?.item?.id).toBe('item.mug');
  });

  it('an outfit without a carry sheet drops the item and says why', () => {
    const look = resolveStageLook(
      catalogOf([basic, red], [mug]),
      'avatar.boy-basic-red',
      'item.mug',
    );
    expect(look?.body.id).toBe('avatar.boy-basic-red');
    expect(look?.item).toBeUndefined();
    expect(look?.note).toContain('carry');
  });

  it('unknown selections degrade to the defaults instead of failing', () => {
    const look = resolveStageLook(catalogOf([basic]), 'avatar.gone', 'item.gone');
    expect(look?.outfit.id).toBe('avatar.boy-basic');
    expect(look?.item).toBeUndefined();
    expect(resolveStageLook(catalogOf([]), undefined, undefined)).toBeUndefined();
  });
});

describe('frameFor / maxFrameSize', () => {
  const sheet = avatar('avatar.a', {
    poses: [
      { pose: 'stand', frame: frame({ size: [52, 96] }) },
      { pose: 'walk-a', frame: frame({ size: [57, 92] }) },
    ],
  });

  it('selects the pose frame, falling back to stand for a missing pose', () => {
    expect(frameFor(sheet, 'walk-a')?.pose).toBe('walk-a');
    expect(frameFor(sheet, 'walk-d')?.pose).toBe('stand');
    expect(frameFor(avatar('avatar.b', { poses: [] }), 'stand')).toBeUndefined();
  });

  it('reserves the largest frame footprint so pose swaps cannot resize the box', () => {
    expect(maxFrameSize(sheet)).toEqual([57, 96]);
    expect(maxFrameSize(avatar('avatar.c', { poses: [] }))).toEqual([64, 96]);
  });
});

describe('stageOverlays', () => {
  const handLayer = frame({
    file: 'hand.png',
    url: '/carry/hand.png',
    size: [16, 12],
    anchors: { grip: [14, 4] },
  });
  const carry = avatar('avatar.boy-basic-carry', { handLayer });
  const mug = item('item.mug');

  it('stacks the bare item then the sheet hand cutout, grips landing on the hand anchor', () => {
    const look = { outfit: carry, body: carry, item: mug, note: undefined };
    // hand (26,64): item grip (5,12) → (21,52); hand-layer grip (14,4) → (12,60).
    expect(stageOverlays(look, frame())).toEqual([
      { url: '/items/item.mug.png', left: 21, top: 52, width: 10 },
      { url: '/carry/hand.png', left: 12, top: 60, width: 16 },
    ]);
  });

  it('is empty with nothing held or no hand anchor, and skips layers lacking url/grip/size', () => {
    const bare = { outfit: carry, body: carry, item: undefined, note: undefined };
    expect(stageOverlays(bare, frame())).toEqual([]);
    const held = { outfit: carry, body: carry, item: mug, note: undefined };
    expect(stageOverlays(held, frame({ anchors: { neck: [25, 49] } }))).toEqual([]);
    const brokenItem = {
      outfit: carry,
      body: carry,
      item: item('item.x', [5, 12]),
      note: undefined,
    };
    brokenItem.item.frame.url = undefined;
    // The broken item drops out; the hand cutout still renders over the empty hand.
    expect(stageOverlays(brokenItem, frame())).toEqual([
      { url: '/carry/hand.png', left: 12, top: 60, width: 16 },
    ]);
  });
});
