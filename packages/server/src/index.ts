// fallow-ignore-file coverage-gaps -- the SpacetimeDB module entry: re-exports only
// fallow-ignore-file unused-export -- EVERY export here is consumed by the SpacetimeDB host and by nothing in this repo: the default export is the schema it loads, the star re-exports are the reducers it registers, and the named ones are the row-level-security filters it applies. A per-export suppression is not an option — the formatter merges the filter list into one wrapped statement, which no next-line comment can cover.
import { spacetimedb } from './tables';

export default spacetimedb;

// Only reducer files may be re-exported here: the host refuses an
// entry-module export that is not a spacetime export, which is why the
// lifecycle helpers both files build on live in world.ts (not re-exported).
export * from './calls';
export * from './huddles';
export * from './posting';
export * from './reducers';
// The row-level-security filters are spacetime exports too: the host only
// applies a filter that reaches it through the entry module. The four
// chat_message filters are an allow-list, not four independent rules — see
// their comment in tables.ts.
export {
  chatGroupMemberVisibility,
  chatMapVisibility,
  chatOpenGroupVisibility,
  chatSpaceVisibility,
  dmMessageVisibility,
  groupCallVisibility,
} from './tables';
export * from './zones';
