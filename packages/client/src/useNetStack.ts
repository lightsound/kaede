// fallow-ignore-file coverage-gaps -- a React hook that mounts the canvas and starts the net stack in an effect; needs a DOM, and no DOM test environment is configured. The commands it hands out are netActions.ts, which is unit-tested
import { DEFAULT_STATUS, type StatusView } from '@kaede/shared';
import { useContext, useEffect, useRef, useState } from 'react';
import { AuthSessionContext } from './auth.package';
import { createGameApp, type GameApp } from './game.package';
import {
  type ChatLog,
  type ChatScopeView,
  type ConnectionStatus,
  type HuddleView,
  type Net,
  type RecordingLabelView,
  type SpaceView,
  startNet,
  type ZoneAdminView,
} from './net.package';
import { netActionsOf } from './netActions';
import { dmNotifier } from './notify.package';

/**
 * The call-related views the net stack publishes (ROADMAP Phase 4):
 * which conversation group this client is in (増分① — the call dock's
 * offer and auto-leave watch ride it) and the recording label rows
 * (増分④ — the 録画一覧 decorates the module's R2 listing with them).
 */
function useCallViews() {
  const [ownGroupId, setOwnGroupId] = useState<bigint>();
  const [recordings, setRecordings] = useState<RecordingLabelView[]>([]);
  return { ownGroupId, setOwnGroupId, recordings, setRecordings };
}

/**
 * The App's net stack: mounts the game canvas into `hostRef`, starts the
 * net stack over it, and mirrors everything the stack publishes as React
 * state, together with the commands that reach it (netActions.ts). The
 * caller must attach `hostRef` on its first render: the effect reads it
 * once per auth session and does not retry. The session comes from
 * AuthSessionContext, whose values are identity-stable; a new one (sign-in
 * or sign-out) re-runs the effect, which tears the old game and net stack
 * down first.
 */
export function useNetStack() {
  const session = useContext(AuthSessionContext);
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  // The authoritative display name from the own player row; undefined
  // whenever no row is known to exist (before the first spawn, during a
  // reconnect, after a retention sweep — see startNet's onOwnName contract).
  // While undefined a rename has nowhere to land (the server would refuse it
  // as no-target), so the form stays disabled.
  const [ownName, setOwnName] = useState<string>();
  // Everything membership-related (own admission, roster, guest setting),
  // published by the net stack on every space_member / space_setting change;
  // undefined until the first session reports. Held as one value so the
  // overlays and the admin panel can never disagree about the same instant.
  const [space, setSpace] = useState<SpaceView>();
  // The global-scope chat history, published whole by the net stack on
  // every chat_message change (seed and row events alike).
  const [chatLog, setChatLog] = useState<ChatLog>([]);
  // True after a send was dropped or refused server-side (onChatRefused) —
  // the panel clears its draft optimistically, so this is the only trace
  // the sender gets. Cleared by the next send attempt.
  const [chatSendRefused, setChatSendRefused] = useState(false);
  // The authoritative own status (ステータス手動切替), published by the net
  // stack on session entry and every own player_status change. Never
  // undefined: a missing row IS the default status.
  const [ownStatus, setOwnStatus] = useState<StatusView>(DEFAULT_STATUS);
  // The meeting-room zones (every map), published by the net stack on every
  // conversation_group change — the admin panel's zone section renders it.
  const [zones, setZones] = useState<ZoneAdminView[]>([]);
  // The huddle control's answer (own huddle / joinable huddle / neither),
  // published deduplicated by the net stack (ROADMAP Phase 3 増分③).
  const [huddle, setHuddle] = useState<HuddleView>({ own: undefined, joinable: undefined });
  // Which chat scopes a send may address right now (全体 / このマップ /
  // いまの会話グループ), published deduplicated by the net stack (ROADMAP
  // Phase 3 増分④). Empty until the first session reports; the panel is
  // disabled until then anyway.
  const [chatScopes, setChatScopes] = useState<ChatScopeView>([]);
  // The call-related views (own group + recording labels), bundled in one
  // custom hook to keep this hook under the cognitive budget.
  const calls = useCallViews();
  // The one handle on the net stack: created inside the effect, disposed by
  // its cleanup, read by the commands (netActions.ts) at call time. A ref
  // rather than state because nothing needs to re-render when it changes.
  const netRef = useRef<Net>(undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let game: GameApp | undefined;
    let cancelled = false;

    void (async () => {
      const created = await createGameApp(host);
      // The effect may have been torn down (StrictMode double-invoke) while we
      // were awaiting init; if so, dispose immediately and never mount.
      if (cancelled) {
        created.destroy();
        return;
      }
      game = created;
      netRef.current = startNet(created, session.getToken, {
        onStatus: setStatus,
        onOwnName: setOwnName,
        onSpace: setSpace,
        onChat: setChatLog,
        onChatRefused: () => setChatSendRefused(true),
        onOwnStatus: setOwnStatus,
        onZones: setZones,
        onHuddle: setHuddle,
        onChatScopes: setChatScopes,
        onOwnGroup: calls.setOwnGroupId,
        onRecordings: calls.setRecordings,
        // The DM → browser-notification pipeline: the notifier decides
        // (shouldNotifyDm) and raises; nothing app-side needs to re-render,
        // so no state rides this hook.
        onDmRow: (event) => dmNotifier().onDmRow(event),
      });
    })();

    return () => {
      cancelled = true;
      netRef.current?.dispose();
      netRef.current = undefined;
      game?.destroy();
    };
    // The two setters are useState setters bundled by useCallViews —
    // identity-stable, listed to satisfy the exhaustive-deps lint.
  }, [session, calls.setOwnGroupId, calls.setRecordings]);

  return {
    hostRef,
    status,
    ownName,
    space,
    chatLog,
    chatSendRefused,
    ownStatus,
    zones,
    huddle,
    chatScopes,
    ownGroupId: calls.ownGroupId,
    recordings: calls.recordings,
    actions: netActionsOf(netRef, () => setChatSendRefused(false)),
  };
}
