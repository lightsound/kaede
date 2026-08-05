// fallow-ignore-file coverage-gaps -- the SpacetimeDB module entry: re-exports only
import { spacetimedb } from './tables';

// fallow-ignore-next-line unused-export -- the SpacetimeDB host loads this module's default export as the schema; no in-repo importer exists
export default spacetimedb;

// Only reducer files may be re-exported here: the host refuses an
// entry-module export that is not a spacetime export, which is why the
// lifecycle helpers both files build on live in world.ts (not re-exported).
export * from './huddles';
export * from './posting';
export * from './reducers';
// The row-level-security filters are spacetime exports too: the host only
// applies a filter that reaches it through the entry module. The four
// chat_message filters are an allow-list, not four independent rules — see
// their comment in tables.ts.
// fallow-ignore-next-line unused-export -- the SpacetimeDB host registers the RLS filters from these exports; no in-repo importer exists
export {
  chatGroupMemberVisibility,
  chatMapVisibility,
  chatOpenGroupVisibility,
  chatSpaceVisibility,
  dmMessageVisibility,
} from './tables';
export * from './zones';
