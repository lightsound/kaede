// fallow-ignore-file coverage-gaps -- a type-only alias over the generated bindings; nothing executes, so no test dependency path can exist
import type { DbConnection } from '../module_bindings';

/**
 * A generated row type, inferred because the bindings don't re-export them.
 * The one definition for every net.package module that reads subscribed rows
 * (sync, admission, chatFeed, reactionFeed).
 */
export type RowOf<T extends keyof DbConnection['db']> =
  ReturnType<DbConnection['db'][T]['iter']> extends Iterator<infer R> ? R : never;
