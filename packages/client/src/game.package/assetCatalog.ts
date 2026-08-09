// fallow-ignore-file coverage-gaps -- import.meta.glob wiring over the bundled asset files; manifest interpretation, validation and the pose-diff live in studio.package/catalog.ts, which is unit-tested

/**
 * Enumerates the bundled asset sources for the dev-only asset studio
 * (Phase 5 ①b⑷ — the read-only inspection viewer). The manifest/PNG files
 * live inside game.package, so this file is the one place that touches
 * them on the studio's behalf: the ImportLint boundary stays intact and
 * the studio consumes plain records through the package index.
 *
 * Both globs are lazy (thunks, not eager modules) so production builds —
 * where the only caller sits behind main.tsx's import.meta.env.DEV gate —
 * tree-shake the whole enumeration away with the studio itself.
 */
const manifestModules = import.meta.glob('./**/manifest.json', { import: 'default' });
const imageUrlModules = import.meta.glob('./**/*.png', { query: '?url', import: 'default' });

async function loadAll<T>(
  modules: Record<string, () => Promise<unknown>>,
): Promise<Record<string, T>> {
  const entries = await Promise.all(
    Object.entries(modules).map(async ([path, load]) => [path, (await load()) as T] as const),
  );
  return Object.fromEntries(entries);
}

/**
 * Loads every bundled manifest (parsed JSON, keyed by its game.package
 * relative path such as `./avatar/manifest.json`) and every bundled PNG's
 * served URL (same key space). Deliberately untyped records: what a
 * manifest means — and whether it is well-formed — is the studio
 * catalog's business, not this enumeration's.
 */
export async function loadAssetModules(): Promise<{
  manifests: Record<string, unknown>;
  imageUrls: Record<string, string>;
}> {
  const [manifests, imageUrls] = await Promise.all([
    loadAll<unknown>(manifestModules),
    loadAll<string>(imageUrlModules),
  ]);
  return { manifests, imageUrls };
}
