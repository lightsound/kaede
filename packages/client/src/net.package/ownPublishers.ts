import { type StatusView, statusLabel } from '@kaede/shared';
import type { PlayerLabelPatch } from '../game.package';

/** What the own-view publishers need from the net stack that owns them (startNet). */
export interface OwnPublishersDeps {
  /** Applies one patch to the local player's canvas label (GameApp.patchLocalLabel). */
  patchLocalLabel(patch: PlayerLabelPatch): void;
  /** Reports the authoritative own display name (NetHooks.onOwnName). */
  onOwnName(name: string | undefined): void;
  /** Reports the own manual status (NetHooks.onOwnStatus). */
  onOwnStatus(view: StatusView): void;
}

/**
 * The single paths for own-name and own-status changes: each fans one
 * authoritative value out to the canvas label and the UI hook,
 * deduplicated by value so a double report cannot drift the two apart.
 */
export interface OwnPublishers {
  publishOwnName(name: string | undefined): void;
  publishOwnStatus(view: StatusView): void;
}

/**
 * Builds the own-view publishers. The dedupe state lives here, one per
 * net stack: a replacement stack starts empty, so its first session
 * re-publishes the truth its predecessor may have left stale.
 */
export function createOwnPublishers(deps: OwnPublishersDeps): OwnPublishers {
  // The single path for own-name changes, so the label and the onOwnName
  // consumer cannot drift apart, and so the double report a join produces
  // (handleOwnRow and the player_name insert event both publish the same
  // name) is deduplicated here instead of leaning on React's same-value
  // bailout. `undefined` means "no own row is known".
  // Caller contract: any caller on an async event path must run behind the
  // session's staleness guard, i.e. from a callback registered through
  // SessionRows (on / onAny / live): playerFeed.ts's row handlers, and
  // admission.ts's onAny(reevaluate), which reaches it through enterWorld.
  // dispose() itself is the only caller that may run after the flip, and
  // only with `undefined`.
  let lastOwnName: string | undefined;
  function publishOwnName(name: string | undefined): void {
    if (name === lastOwnName) return;
    lastOwnName = name;
    // The label keeps its last text while the row is gone: the local sprite
    // stays visible while offline (the sim keeps running), so blanking the
    // label would flash; the replacement row brings the authoritative name.
    if (name !== undefined) deps.patchLocalLabel({ name });
    deps.onOwnName(name);
  }

  // The single path for own-status changes (the publishOwnName shape): the
  // canvas line and the onOwnStatus consumer cannot drift apart, and the
  // double report a session entry produces (handleOwnRow seeds from the
  // cache, then a row event may repeat the same value) is deduplicated by
  // value here. Unlike the name there is no "row unknown" state to report:
  // a missing row IS a status (the default), so the value never goes
  // undefined — the control disables through the onOwnName gate instead.
  // For the same reason dispose() has no reset counterpart to its
  // publishOwnName(undefined): a consumer surviving this stack holds a
  // stale-but-disabled value at worst, and the replacement stack's own
  // handleOwnRow seed (its dedupe starts empty) republishes the truth.
  let lastOwnStatus: StatusView | undefined;
  function publishOwnStatus(view: StatusView): void {
    if (
      lastOwnStatus !== undefined &&
      lastOwnStatus.availability === view.availability &&
      lastOwnStatus.text === view.text
    ) {
      return;
    }
    lastOwnStatus = view;
    // The composed line is the text display; the derived poses (away =
    // sleep, busy = headphones — ①c) read the raw availability.
    deps.patchLocalLabel({ status: statusLabel(view), availability: view.availability });
    deps.onOwnStatus(view);
  }

  return { publishOwnName, publishOwnStatus };
}
