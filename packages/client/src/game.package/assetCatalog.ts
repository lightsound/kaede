// fallow-ignore-file coverage-gaps -- import.meta.glob wiring over the bundled asset files; manifest interpretation, validation and the pose-diff live in studio.package/catalog.ts, which is unit-tested

/**
 * Enumerates the bundled asset sources for the dev-only asset studio
 * (Phase 5 ①b⑷ — the read-only inspection viewer). The manifest/PNG files
 * live inside game.package, so this file is the one place that touches
 * them on the studio's behalf: the ImportLint boundary stays intact and
 * the studio consumes plain records through the package index.
 *
 * Both globs exist in dev builds only, behind the same import.meta.env.DEV
 * gate as the studio itself (main.tsx). Lazy thunks alone are not enough
 * here: they hang off an export the package index re-exports, so a
 * production build loads every file they name before tree-shaking drops
 * that export, and Vite emits each loaded PNG as a build asset whether or
 * not any chunk still references it. The gate folds to `{}` before the
 * bundler collects the module's imports, so nothing is loaded at all.
 */
const manifestModules = import.meta.env.DEV
  ? import.meta.glob('./**/manifest.json', { import: 'default' })
  : {};
const imageUrlModules = import.meta.env.DEV
  ? import.meta.glob('./**/*.png', { query: '?url', import: 'default' })
  : {};

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
 * catalog's business, not this enumeration's. Dev builds only: in a
 * production build both records are empty (the gate above), so
 * production code must not call this.
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
