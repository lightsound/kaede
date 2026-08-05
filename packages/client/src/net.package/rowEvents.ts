// fallow-ignore-file coverage-gaps -- a three-line registration helper over the generated table handles; needs a live connection, and the handlers it registers are the callers' (admission.ts, zoneFeed.ts)

/** A generated table handle, as far as whole-table re-projection needs it. */
export interface RowEventSource {
  onInsert(handler: () => void): unknown;
  onUpdate(handler: () => void): unknown;
  onDelete(handler: () => void): unknown;
}

/**
 * Registers one argument-less handler on every row event of `table` — for
 * feeds that re-project a whole view from the cache on any change
 * (admission's SpaceView, the zone feed's layer/list) rather than acting
 * on the individual row. The handler owns its own staleness guard.
 */
export function onAnyRowEvent(table: RowEventSource, handler: () => void): void {
  table.onInsert(handler);
  table.onUpdate(handler);
  table.onDelete(handler);
}
