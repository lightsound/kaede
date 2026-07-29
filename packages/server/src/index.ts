// fallow-ignore-file coverage-gaps -- the SpacetimeDB module entry: re-exports only
import { spacetimedb } from './tables';

// fallow-ignore-next-line unused-export -- the SpacetimeDB host loads this module's default export as the schema; no in-repo importer exists
export default spacetimedb;

export * from './reducers';
