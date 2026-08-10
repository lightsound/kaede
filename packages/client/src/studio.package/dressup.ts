/**
 * The try-on rules of the asset studio's dress-up stage (owner feedback
 * 2026-08-09 on ①b⑷): which body sheets count as outfits, how an outfit
 * pairs with its carry variant when an item is held, and where the held
 * layers land on the frame. Pure functions only — the DOM side (stage.tsx)
 * just renders the result.
 *
 * Vocabulary note: under the asset spec an "outfit" IS a whole body sheet
 * (コーデ単位 — avatar-rig.md §2; free clothing mix is DP-A), so trying on
 * a shirt means swapping the sheet, and holding an item means swapping to
 * the `-carry` sheet variant plus compositing the item under the sheet's
 * hand layer — the ①b(a)⑵ spec, same as the in-game avatarView.
 */

import type { AssetCatalog, AssetFrame, AvatarAsset, ItemAsset } from './catalog';

/** The carry variant naming rule: `<outfit id>-carry` (avatar.boy-basic-carry). */
const CARRY_SUFFIX = '-carry';

/**
 * Try-on stage default (owner 2026-08-09): the pants-only boy base outfit.
 * Falls back to the first non-carry sheet when that id is not in the roster
 * (e.g. unit tests with synthetic catalogs).
 */
export const DEFAULT_OUTFIT_ID = 'avatar.boy-pants';

/** The body sheets offered as outfits: everything that is not itself a carry variant. */
export function outfitOptions(catalog: AssetCatalog): readonly AvatarAsset[] {
  const outfits = catalog.avatars.filter((avatar) => !avatar.id.endsWith(CARRY_SUFFIX));
  return [...outfits].sort((a, b) => {
    if (a.id === DEFAULT_OUTFIT_ID) return -1;
    if (b.id === DEFAULT_OUTFIT_ID) return 1;
    return 0;
  });
}

/** The carry sheet paired with an outfit, when the roster ships one. */
export function carryVariantOf(catalog: AssetCatalog, outfitId: string): AvatarAsset | undefined {
  return catalog.avatars.find((avatar) => avatar.id === `${outfitId}${CARRY_SUFFIX}`);
}

/**
 * What the stage renders: the chosen outfit, the body sheet actually worn
 * (the outfit itself, or its carry variant while an item is held), the
 * held item, and a note when the item had to be dropped because the
 * outfit has no carry sheet to hold it with.
 */
export interface StageLook {
  outfit: AvatarAsset;
  body: AvatarAsset;
  item: ItemAsset | undefined;
  note: string | undefined;
}

/**
 * Resolves the stage state from the two selections. Undefined selections
 * fall back to the first outfit and empty hands; an unknown id (a sheet
 * removed from the roster) degrades the same way instead of failing —
 * this is an inspection page, it shows what exists.
 */
export function resolveStageLook(
  catalog: AssetCatalog,
  outfitId: string | undefined,
  heldItemId: string | undefined,
): StageLook | undefined {
  const outfits = outfitOptions(catalog);
  const outfit =
    outfits.find((option) => option.id === outfitId) ??
    outfits.find((option) => option.id === DEFAULT_OUTFIT_ID) ??
    outfits[0];
  if (!outfit) return undefined;
  const item = catalog.items.find((candidate) => candidate.id === heldItemId);
  if (!item) return { outfit, body: outfit, item: undefined, note: undefined };
  const carry = carryVariantOf(catalog, outfit.id);
  if (!carry) {
    return {
      outfit,
      body: outfit,
      item: undefined,
      note: `「${outfit.name}」には持ち歩き（carry）シートがないため、アイテムを持てません`,
    };
  }
  return { outfit, body: carry, item, note: undefined };
}

/**
 * The frame to show while the walk clock says `pose`: a body missing that
 * pose falls back to stand (the gap is already flagged by the missing-pose
 * badge, so the preview degrades quietly).
 */
export function frameFor(
  avatar: AvatarAsset,
  pose: string,
): { readonly pose: string; readonly frame: AssetFrame } | undefined {
  return (
    avatar.poses.find((p) => p.pose === pose) ??
    avatar.poses.find((p) => p.pose === 'stand') ??
    avatar.poses[0]
  );
}

/**
 * The largest frame footprint of a body sheet, in source pixels. The walk
 * previews reserve this box and ground every frame at its bottom edge, so
 * a pose swap can never resize the layout (the owner's 横揺れ feedback —
 * trimmed frames differ by a few pixels per pose).
 */
export function maxFrameSize(avatar: AvatarAsset): readonly [number, number] {
  let w = 0;
  let h = 0;
  for (const { frame } of avatar.poses) {
    if (!frame.size) continue;
    w = Math.max(w, frame.size[0]);
    h = Math.max(h, frame.size[1]);
  }
  return [w > 0 ? w : 64, h > 0 ? h : 96];
}

/** One composited layer over the body frame, in source pixels from the frame's top-left. */
export interface OverlayLayer {
  url: string;
  left: number;
  top: number;
  width: number;
}

/** Top-left offset (source px) that puts a layer's grip point on the pose's hand anchor. */
function gripOffset(
  hand: readonly [number, number],
  grip: readonly [number, number] | undefined,
): readonly [number, number] | undefined {
  return grip ? [hand[0] - grip[0], hand[1] - grip[1]] : undefined;
}

function overlayOf(frame: AssetFrame, hand: readonly [number, number]): OverlayLayer | undefined {
  const offset = gripOffset(hand, frame.anchors.grip);
  if (!offset || frame.url === undefined || !frame.size) return undefined;
  return { url: frame.url, left: offset[0], top: offset[1], width: frame.size[0] };
}

/**
 * The held-item layers over one body frame, bottom-up: the bare item
 * resting on the hand anchor, then the sheet's own hand cutout on top —
 * body → item → hand, the MapleStory hand-over-item order avatarView
 * renders in-game. Empty when nothing is held or the frame carries no
 * hand anchor.
 */
export function stageOverlays(look: StageLook, frame: AssetFrame): readonly OverlayLayer[] {
  const hand = frame.anchors.hand;
  if (!look.item || !hand) return [];
  const layers: OverlayLayer[] = [];
  const item = overlayOf(look.item.frame, hand);
  if (item) layers.push(item);
  const handLayer = look.body.handLayer && overlayOf(look.body.handLayer, hand);
  if (handLayer) layers.push(handLayer);
  return layers;
}
