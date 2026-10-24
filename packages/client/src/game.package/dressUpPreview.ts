// fallow-ignore-file coverage-gaps -- dev-only preview loader over PixiJS Assets and Vite's literal import() chunks, which needs a browser to decode the images (the unit-test setup has no browser or DOM); it only picks which bundled files to load, and the manifests it reads are validated by studio.package/catalog.ts, which is unit-tested

// The dev-only dress-up preview (?outfit=red, ?held=<item>). GameApp.ts
// calls only resolveAvatarLook, which gates on import.meta.env.DEV, so
// production bundles drop the rest of this module and its loaders.
import { Assets } from 'pixi.js';
import type { AvatarSheetTextures, HeldItemDisplay } from './avatarView';

/**
 * What the dev-only dress-up preview swaps in (ROADMAP ①b 着手順⑵ — the
 * layer-composition verification spike): an outfit-swapped pose sheet
 * and/or a held item pinned to the hand anchors. 増分①e replaces this with
 * real selection UI + persistence; until then the preview exists so the
 * generated assets can be verified walking in the actual game.
 */
interface DressUpPreview {
  sheet?: AvatarSheetTextures;
  held?: HeldItemDisplay;
}

/** Builds one pose sheet from its five loaded frame modules, in pose order. */
async function sheetFromModules(mods: { default: string }[]): Promise<AvatarSheetTextures> {
  const [stand, walkA, walkB, walkC, walkD] = await Promise.all(
    mods.map((m) => Assets.load(m.default)),
  );
  return { stand, 'walk-a': walkA, 'walk-b': walkB, 'walk-c': walkC, 'walk-d': walkD };
}

/** The red-hoodie outfit sheet (avatar.boy-basic-red), loaded on demand. */
async function loadRedSheet(): Promise<AvatarSheetTextures> {
  return sheetFromModules(
    await Promise.all([
      import('./avatar-red/stand.png'),
      import('./avatar-red/walk-a.png'),
      import('./avatar-red/walk-b.png'),
      import('./avatar-red/walk-c.png'),
      import('./avatar-red/walk-d.png'),
    ]),
  );
}

/**
 * How an item is carried (its manifest's carryStyle — owner direction
 * 2026-08-12): light items ride the one-hand carry sheets, heavy/bulky
 * ones the two-arm front carry. Which pose sheet a body wears and whether
 * an item can ride it stay one decision (the ①b(a) verdict); the style
 * only picks WHICH carry family.
 */
type CarryStyle = 'light' | 'heavy';

/**
 * The carry-pose sheet variants: a stable hand anchor through the whole
 * stride — the ①b(a) verdict that a statically anchored item cannot ride
 * the swing-walk sheets (see HeldItemDisplay). Vite needs literal import()
 * paths, hence the four-thunk table.
 */
const CARRY_SHEET_LOADERS: Record<string, () => Promise<{ default: string }[]>> = {
  'heavy-base': () =>
    Promise.all([
      import('./avatar-carry/stand.png'),
      import('./avatar-carry/walk-a.png'),
      import('./avatar-carry/walk-b.png'),
      import('./avatar-carry/walk-c.png'),
      import('./avatar-carry/walk-d.png'),
    ]),
  'heavy-red': () =>
    Promise.all([
      import('./avatar-red-carry/stand.png'),
      import('./avatar-red-carry/walk-a.png'),
      import('./avatar-red-carry/walk-b.png'),
      import('./avatar-red-carry/walk-c.png'),
      import('./avatar-red-carry/walk-d.png'),
    ]),
  'light-base': () =>
    Promise.all([
      import('./avatar-carry-light/stand.png'),
      import('./avatar-carry-light/walk-a.png'),
      import('./avatar-carry-light/walk-b.png'),
      import('./avatar-carry-light/walk-c.png'),
      import('./avatar-carry-light/walk-d.png'),
    ]),
  'light-red': () =>
    Promise.all([
      import('./avatar-red-carry-light/stand.png'),
      import('./avatar-red-carry-light/walk-a.png'),
      import('./avatar-red-carry-light/walk-b.png'),
      import('./avatar-red-carry-light/walk-c.png'),
      import('./avatar-red-carry-light/walk-d.png'),
    ]),
};

/** The carry sheets' manifest + hand cutout, keyed like CARRY_SHEET_LOADERS. */
const CARRY_KIT_LOADERS = {
  'heavy-base': () =>
    Promise.all([import('./avatar-carry/manifest.json'), import('./avatar-carry/hand.png')]),
  'heavy-red': () =>
    Promise.all([
      import('./avatar-red-carry/manifest.json'),
      import('./avatar-red-carry/hand.png'),
    ]),
  'light-base': () =>
    Promise.all([
      import('./avatar-carry-light/manifest.json'),
      import('./avatar-carry-light/hand.png'),
    ]),
  'light-red': () =>
    Promise.all([
      import('./avatar-red-carry-light/manifest.json'),
      import('./avatar-red-carry-light/hand.png'),
    ]),
};

async function loadCarrySheet(style: CarryStyle, redOutfit: boolean): Promise<AvatarSheetTextures> {
  return sheetFromModules(await CARRY_SHEET_LOADERS[`${style}-${redOutfit ? 'red' : 'base'}`]());
}

/**
 * The held-item catalog of the dev preview (the ①b(a) genericity check:
 * one resting rule, five item classes — compact, flat, long-shafted,
 * plush, and a spear taller than the character). Thunks so production
 * DCE drops the chunks with the rest of the preview.
 */
const HELD_ITEM_LOADERS = {
  mug: () =>
    Promise.all([
      import('./items/coffee-mug/manifest.json'),
      import('./items/coffee-mug/coffee-mug.png'),
    ]),
  notebook: () =>
    Promise.all([
      import('./items/notebook/manifest.json'),
      import('./items/notebook/notebook.png'),
    ]),
  umbrella: () =>
    Promise.all([
      import('./items/umbrella/manifest.json'),
      import('./items/umbrella/umbrella.png'),
    ]),
  plush: () =>
    Promise.all([
      import('./items/plush-bear/manifest.json'),
      import('./items/plush-bear/plush-bear.png'),
    ]),
  spear: () =>
    Promise.all([import('./items/spear/manifest.json'), import('./items/spear/spear.png')]),
};

/**
 * One held item, manifest-driven: the item's grip point comes from its own
 * manifest, and the per-pose hand anchors from the manifest of the carry
 * sheet being worn — the anchors are frame coordinates, so they must match
 * the frames actually rendered.
 */
async function loadHeldItem(
  loader: (typeof HELD_ITEM_LOADERS)[keyof typeof HELD_ITEM_LOADERS],
  style: CarryStyle,
  redOutfit: boolean,
): Promise<HeldItemDisplay> {
  const [[itemManifest, itemUrl], [bodyManifest, handUrl]] = await Promise.all([
    loader(),
    CARRY_KIT_LOADERS[`${style}-${redOutfit ? 'red' : 'base'}`](),
  ]);
  const [texture, handTexture] = await Promise.all([
    Assets.load(itemUrl.default),
    Assets.load(handUrl.default),
  ]);
  const poses = bodyManifest.default.poses;
  return {
    texture,
    grip: itemManifest.default.frame.anchors.grip,
    hands: {
      stand: poses.stand.anchors.hand,
      'walk-a': poses['walk-a'].anchors.hand,
      'walk-b': poses['walk-b'].anchors.hand,
      'walk-c': poses['walk-c'].anchors.hand,
      'walk-d': poses['walk-d'].anchors.hand,
    },
    hand: { texture: handTexture, grip: bodyManifest.default.handLayer.anchors.grip },
  };
}

/**
 * The carrying look for one held item: the item's own manifest names its
 * carry style (light = one-hand, heavy = two-arm front), and the body
 * swaps to that carry family. Split from loadDressUpPreview to keep both
 * under the CRAP complexity budget (the createGameApp precedent).
 */
async function loadHeldPreview(
  loader: (typeof HELD_ITEM_LOADERS)[keyof typeof HELD_ITEM_LOADERS],
  redOutfit: boolean,
): Promise<DressUpPreview> {
  const [itemManifest] = await loader();
  const style: CarryStyle = itemManifest.default.carryStyle === 'light' ? 'light' : 'heavy';
  return {
    sheet: await loadCarrySheet(style, redOutfit),
    held: await loadHeldItem(loader, style, redOutfit),
  };
}

/**
 * Reads the dev-only preview selection from the URL (?outfit=red,
 * ?held=mug|notebook|umbrella|plush|spear). Dev builds only — the callers
 * gate on import.meta.env.DEV, so production bundles drop this code and
 * the preview assets with it. Holding an item swaps the whole body sheet
 * to the carry variant: which pose sheet a body wears and whether an item
 * can ride it are one decision (the ①b(a) verdict), not two independent
 * toggles.
 */
async function loadDressUpPreview(): Promise<DressUpPreview> {
  const params = new URLSearchParams(window.location.search);
  const redOutfit = params.get('outfit') === 'red';
  const held = params.get('held');
  const loader = held ? HELD_ITEM_LOADERS[held as keyof typeof HELD_ITEM_LOADERS] : undefined;
  if (loader) return loadHeldPreview(loader, redOutfit);
  if (redOutfit) return { sheet: await loadRedSheet() };
  return {};
}

/**
 * The avatar look every player view in this tab renders: the base sheet,
 * unless the dev-only dress-up preview (the ①b(a) spike) swaps in an
 * outfit sheet and/or a held item. A helper rather than inline branches so
 * createGameApp stays under the CRAP complexity budget.
 */
export async function resolveAvatarLook(
  base: AvatarSheetTextures,
): Promise<{ sheet: AvatarSheetTextures; held?: HeldItemDisplay }> {
  const preview: DressUpPreview = import.meta.env.DEV ? await loadDressUpPreview() : {};
  return { sheet: preview.sheet ?? base, held: preview.held };
}
