// fallow-ignore-file coverage-gaps -- wires live SpacetimeDB row events to the chat scope selector; needs a running host. The rules it projects (which scopes exist, what each is called) are chatScopeOptions / chatScopeTag in @kaede/shared, unit-tested there
import {
  type ChatScope,
  chatScopeOptions,
  chatScopeTag,
  DEFAULT_MAP_ID,
  mapFor,
} from '@kaede/shared';
import type { Identity } from 'spacetimedb';
import type { DbConnection } from '../module_bindings';
import { onAnyRowEvent } from './rowEvents';

/**
 * One scope the sender may pick right now (ROADMAP Phase 3 増分④): the
 * scope column value a send would carry, and what the control calls it —
 * 全体, the map's display name, or the conversation group's name, composed
 * by the same chatScopeTag that marks the log lines, so the selector and
 * the log can never name one scope two ways.
 */
export interface ChatScopeOption {
  scope: ChatScope;
  label: string;
}

/** Everything the scope selector renders: the offered scopes, widest first. */
export type ChatScopeView = readonly ChatScopeOption[];

/** What projecting the scope selector needs from the session that wires it. */
export interface ChatScopeFeedHooks {
  /** True once this session's events must be ignored (see wireSession). */
  isStale(): boolean;
  /** Every change of the offered scopes, deduplicated by value. */
  onChatScopes(view: ChatScopeView): void;
}

/**
 * Wires one session's chat scope selector: which scopes the sender may
 * address from where it stands, re-derived from the subscribed cache
 * whenever the rows behind that answer change — the own player row (its
 * map), the own group_member row (the conversation group), and the group
 * rows themselves (a rename, or the group being deleted out from under a
 * member). The zoneFeed's HuddleView shape: a whole value, deduplicated
 * here so the row-event cadence stays out of React.
 *
 * The context is read from the AUTHORITATIVE own row rather than from the
 * session's rendered map: a send is ruled against the server's rows, so
 * offering a scope the server would refuse is exactly what this must not
 * do.
 */
export function wireChatScopes(
  c: DbConnection,
  myIdentity: Identity,
  hooks: ChatScopeFeedHooks,
): void {
  let lastKey = '';

  /**
   * Where the sender stands, from the cache. No own row (the waiting room,
   * or between sessions) reads as the default map and no group: the panel
   * is disabled in that state anyway, and the control must never render an
   * empty selector.
   */
  const contextOf = () => ({
    mapId: c.db.player.identity.find(myIdentity)?.mapId ?? DEFAULT_MAP_ID,
    groupId: c.db.groupMember.identity.find(myIdentity)?.groupId,
  });

  const derive = (): ChatScopeView => {
    const context = contextOf();
    const labelOf = (scope: ChatScope) =>
      chatScopeTag({
        scope,
        announcement: false,
        mapName: mapFor(context.mapId).name,
        groupName:
          context.groupId === undefined
            ? undefined
            : c.db.conversationGroup.id.find(context.groupId)?.name,
      });
    const options: ChatScopeOption[] = [];
    for (const scope of chatScopeOptions(context)) {
      const label = labelOf(scope);
      if (label !== undefined) options.push({ scope, label });
    }
    return options;
  };

  const publish = (): void => {
    const view = derive();
    const key = view.map((option) => `${option.scope}:${option.label}`).join('|');
    if (key === lastKey) return;
    lastKey = key;
    hooks.onChatScopes(view);
  };

  const publishUnlessStale = (): void => {
    if (hooks.isStale()) return;
    publish();
  };

  onAnyRowEvent(c.db.player, publishUnlessStale);
  onAnyRowEvent(c.db.groupMember, publishUnlessStale);
  onAnyRowEvent(c.db.conversationGroup, publishUnlessStale);
  publish();
}
