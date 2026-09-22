/**
 * Manifest interpretation for the asset studio (Phase 5 ①b⑷ — the
 * read-only inspection viewer): turns the raw glob records that
 * game.package enumerates (parsed manifest JSON + bundled PNG URLs, both
 * keyed by `./dir/file` paths) into a typed catalog, and runs the
 * read-side integrity checks — the pose-diff against the whole roster
 * (ROADMAP ①b(b): manifest poses の差集合) plus the plumbing ones a
 * broken import would cause (referenced PNG absent, duplicate id,
 * unknown type). Pure functions only; the DOM side just renders the
 * result.
 */

import { WALK_POSES } from '../game.package';

/** One drawable frame a manifest points at (a pose cell, an item, a hand layer). */
export interface AssetFrame {
  file: string;
  /** The bundled PNG's served URL, or undefined when the file is absent (also reported as a problem). */
  url: string | undefined;
  /** [width, height] in source pixels (4x display resolution), when the manifest carries it. */
  size: readonly [number, number] | undefined;
  /** Anchor points by name (neck / hand / grip …), in source pixels from the frame's top-left. */
  anchors: Readonly<Record<string, readonly [number, number]>>;
}

/** One avatar-body manifest, poses in manifest order. */
export interface AvatarAsset {
  id: string;
  name: string;
  dir: string;
  poses: ReadonlyArray<{ readonly pose: string; readonly frame: AssetFrame }>;
  /** The carry sheets' hand overlay (manifest handLayer), when present. */
  handLayer: AssetFrame | undefined;
  /** Poses other avatars declare but this one lacks (the ①b(b) set difference). */
  missingPoses: readonly string[];
}

/** One held-item manifest. */
export interface ItemAsset {
  id: string;
  name: string;
  dir: string;
  frame: AssetFrame;
  /**
   * Which carry sheet family the item rides (its manifest's carryStyle —
   * owner direction 2026-08-12): 'light' = one-hand carry, 'heavy' =
   * two-arm front carry. Manifests without the field count as heavy.
   */
  carryStyle: 'light' | 'heavy';
}

export interface AssetCatalog {
  avatars: readonly AvatarAsset[];
  items: readonly ItemAsset[];
  /**
   * The ①c gesture sheets (type avatar-gesture) — the AvatarAsset shape,
   * but deliberately OUTSIDE the avatar pose-diff: their vocabulary (sit /
   * sleep / dance frames) is per-character production status, not a gap
   * every walk sheet must fill. Their own missingPoses diff runs within
   * the type once more characters gain gesture sheets.
   */
  gestures: readonly AvatarAsset[];
  /** The worn overlays (type headgear — the busy headphones), item-shaped. */
  headgear: readonly ItemAsset[];
  /** Every pose name any avatar-body declares, in first-seen order — the diff baseline. */
  poseUnion: readonly string[];
  /** Human-readable integrity findings; empty when every manifest checks out. */
  problems: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A two-number tuple ([x, y] anchor or [w, h] size), or undefined. */
function asPair(value: unknown): readonly [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [a, b] = value;
  return typeof a === 'number' && typeof b === 'number' ? [a, b] : undefined;
}

function parseAnchors(value: unknown): Record<string, readonly [number, number]> {
  if (!isRecord(value)) return {};
  const anchors: Record<string, readonly [number, number]> = {};
  for (const [name, point] of Object.entries(value)) {
    const pair = asPair(point);
    if (pair) anchors[name] = pair;
  }
  return anchors;
}

/** The mutable state threaded through one buildCatalog run. */
interface Collect {
  avatars: AvatarAsset[];
  items: ItemAsset[];
  gestures: AvatarAsset[];
  headgear: ItemAsset[];
  problems: string[];
  seenIds: Map<string, string>;
}

/**
 * Reads one frame object ({file, size, anchors}) and resolves its PNG
 * against the bundled URLs; a missing file or PNG is reported under
 * `label` (e.g. `./avatar/manifest.json poses.stand`).
 */
function parseFrame(
  value: unknown,
  dir: string,
  imageUrls: Readonly<Record<string, string>>,
  problems: string[],
  label: string,
): AssetFrame | undefined {
  if (!isRecord(value) || typeof value.file !== 'string') {
    problems.push(`${label}: frame 定義が不正です（file がありません）`);
    return undefined;
  }
  const url = imageUrls[`${dir}/${value.file}`];
  if (url === undefined) problems.push(`${label}: 参照先 PNG（${value.file}）が同梱されていません`);
  return { file: value.file, url, size: asPair(value.size), anchors: parseAnchors(value.anchors) };
}

/** Reads the identity fields every manifest type shares, or reports why not. */
function parseHeader(
  manifest: Record<string, unknown>,
  path: string,
  collect: Collect,
): { id: string; name: string } | undefined {
  const { id, name } = manifest;
  if (typeof id !== 'string' || id === '') {
    collect.problems.push(`${path}: id がありません`);
    return undefined;
  }
  const previous = collect.seenIds.get(id);
  if (previous) collect.problems.push(`${path}: id「${id}」が ${previous} と重複しています`);
  else collect.seenIds.set(id, path);
  return { id, name: typeof name === 'string' ? name : id };
}

/** Where one manifest sits: its parsed JSON, glob path, directory, and the PNG URL space. */
interface ManifestSite {
  manifest: Record<string, unknown>;
  path: string;
  dir: string;
  imageUrls: Readonly<Record<string, string>>;
}

function parseAvatar(site: ManifestSite, collect: Collect, into: AvatarAsset[]): void {
  const { manifest, path, dir, imageUrls } = site;
  const header = parseHeader(manifest, path, collect);
  if (!header) return;
  const poses: Array<{ pose: string; frame: AssetFrame }> = [];
  const rawPoses = isRecord(manifest.poses) ? manifest.poses : {};
  if (Object.keys(rawPoses).length === 0) collect.problems.push(`${path}: poses が空です`);
  for (const [pose, value] of Object.entries(rawPoses)) {
    const frame = parseFrame(value, dir, imageUrls, collect.problems, `${path} poses.${pose}`);
    if (frame) poses.push({ pose, frame });
  }
  const handLayer =
    manifest.handLayer === undefined
      ? undefined
      : parseFrame(manifest.handLayer, dir, imageUrls, collect.problems, `${path} handLayer`);
  into.push({ ...header, dir, poses, handLayer, missingPoses: [] });
}

function parseItem(site: ManifestSite, collect: Collect, into: ItemAsset[]): void {
  const header = parseHeader(site.manifest, site.path, collect);
  if (!header) return;
  const label = `${site.path} frame`;
  const frame = parseFrame(site.manifest.frame, site.dir, site.imageUrls, collect.problems, label);
  const carryStyle = site.manifest.carryStyle === 'light' ? 'light' : 'heavy';
  if (frame) into.push({ ...header, dir: site.dir, frame, carryStyle });
}

/**
 * The ①b(b) missing-pose detection: the baseline vocabulary is the union
 * of every avatar's declared poses (first-seen order), and each avatar's
 * gap is the set difference against it. Returns the union and rewrites
 * each avatar with its diff filled in.
 *
 * Walk frames are EXCLUDED from the union since the A-3 densification
 * (2026-08-20): sheets legitimately differ in walk density (12 dense / 4
 * legacy carry-light — 裁定④ 据え置き), so a shorter cycle is not a gap.
 * What IS a defect in a walk cycle is a hole in the middle — validated
 * separately as "the walk poses must be a contiguous prefix of the
 * canonical stride alphabet" (walkCycleProblems).
 */
function diffPoses(avatars: readonly AvatarAsset[]): {
  poseUnion: readonly string[];
  avatars: readonly AvatarAsset[];
} {
  const poseUnion: string[] = [];
  for (const avatar of avatars) {
    for (const { pose } of avatar.poses) {
      if (!pose.startsWith('walk-') && !poseUnion.includes(pose)) poseUnion.push(pose);
    }
  }
  return {
    poseUnion,
    avatars: avatars.map((avatar) => {
      const own = new Set(avatar.poses.map(({ pose }) => pose));
      return { ...avatar, missingPoses: poseUnion.filter((pose) => !own.has(pose)) };
    }),
  };
}

/**
 * The walk-cycle integrity rule that replaces the union diff for walk
 * frames: a sheet's walk poses must read `walk-a`, `walk-b`, … in order
 * with no hole — a contiguous prefix of the canonical WALK_POSES. A hole
 * (walk-a, walk-c) means a frame went missing mid-cycle and the played
 * loop would skip a beat.
 */
function walkCycleProblems(avatars: readonly AvatarAsset[]): string[] {
  const problems: string[] = [];
  for (const avatar of avatars) {
    const walkPoses = avatar.poses.map(({ pose }) => pose).filter((p) => p.startsWith('walk-'));
    if (walkPoses.length === 0) continue; // no cycle to validate (synthetic sheets)
    const expected = WALK_POSES.slice(0, walkPoses.length);
    if (walkPoses.join() !== expected.join()) {
      problems.push(
        `${avatar.dir}/manifest.json: walk コマが正準の連続列（${expected.join(', ')}）と一致しません（実際: ${walkPoses.join(', ')}）`,
      );
    }
  }
  return problems;
}

/**
 * Builds the inspection catalog from the raw glob records. Never throws:
 * a malformed manifest degrades into `problems` lines so the viewer can
 * show what is wrong instead of going blank — this page exists to inspect
 * exactly such states.
 */
export function buildCatalog(
  manifests: Readonly<Record<string, unknown>>,
  imageUrls: Readonly<Record<string, string>>,
): AssetCatalog {
  const collect: Collect = {
    avatars: [],
    items: [],
    gestures: [],
    headgear: [],
    problems: [],
    seenIds: new Map(),
  };
  for (const path of Object.keys(manifests).sort()) {
    const manifest = manifests[path];
    const dir = path.slice(0, path.length - '/manifest.json'.length);
    if (!isRecord(manifest)) {
      collect.problems.push(`${path}: JSON がオブジェクトではありません`);
    } else if (manifest.type === 'avatar-body') {
      parseAvatar({ manifest, path, dir, imageUrls }, collect, collect.avatars);
    } else if (manifest.type === 'avatar-gesture') {
      parseAvatar({ manifest, path, dir, imageUrls }, collect, collect.gestures);
    } else if (manifest.type === 'held-item') {
      parseItem({ manifest, path, dir, imageUrls }, collect, collect.items);
    } else if (manifest.type === 'headgear') {
      parseItem({ manifest, path, dir, imageUrls }, collect, collect.headgear);
    } else {
      collect.problems.push(`${path}: 未知の type（${String(manifest.type)}）です`);
    }
  }
  // Stable-id order (asset-pipeline.md §5: the id is the authority), not
  // glob-path order — the path sort would lead with the carry variants.
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  const { poseUnion, avatars } = diffPoses([...collect.avatars].sort(byId));
  collect.problems.push(...walkCycleProblems(avatars));
  // Gesture sheets diff within their own type: once several characters
  // carry gesture sheets, a missing dance frame shows up here the way a
  // missing walk frame shows up for the bodies.
  const gestureDiff = diffPoses([...collect.gestures].sort(byId));
  return {
    avatars,
    items: [...collect.items].sort(byId),
    gestures: gestureDiff.avatars,
    headgear: [...collect.headgear].sort(byId),
    poseUnion,
    problems: collect.problems,
  };
}
