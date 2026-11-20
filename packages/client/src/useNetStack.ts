// fallow-ignore-file coverage-gaps -- a React hook that mounts the canvas and starts the net stack in an effect; needs a DOM, and no DOM test environment is configured. The commands it hands out are netActions.ts, which is unit-tested
import { DEFAULT_STATUS, type StatusView } from '@kaede/shared';
import { type Dispatch, type SetStateAction, useContext, useEffect, useRef, useState } from 'react';
import { AuthSessionContext } from './auth.package';
import { createGameApp, type GameApp } from './game.package';
import {
  type AuthTokenGetter,
  type ChatLog,
  type ChatScopeView,
  type ConnectionStatus,
  type HuddleView,
  type Net,
  type NetHooks,
  type RecordingLabelView,
  type SpaceView,
  startNet,
  type ZoneAdminView,
} from './net.package';
import { netActionsOf } from './netActions';
import { dmNotifier } from './notify.package';

function useConnectionViews() {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  // The authoritative display name from the own player row; undefined
  // whenever no row is known to exist (before the first spawn, during a
  // reconnect, after a retention sweep — see startNet's onOwnName contract).
  // While undefined a rename has nowhere to land (the server would refuse it
  // as no-target), so the form stays disabled.
  const [ownName, setOwnName] = useState<string>();
  const [ownStatus, setOwnStatus] = useState<StatusView>(DEFAULT_STATUS);
  return { status, setStatus, ownName, setOwnName, ownStatus, setOwnStatus };
}

function useSpaceViews() {
  const [space, setSpace] = useState<SpaceView>();
  const [zones, setZones] = useState<ZoneAdminView[]>([]);
  return { space, setSpace, zones, setZones };
}

function useChatViews() {
  const [chatLog, setChatLog] = useState<ChatLog>([]);
  // True after a send was dropped or refused server-side (onChatRefused) —
  // the panel clears its draft optimistically, so this is the only trace
  // the sender gets. Cleared by the next send attempt.
  const [chatSendRefused, setChatSendRefused] = useState(false);
  const [chatScopes, setChatScopes] = useState<ChatScopeView>([]);
  return { chatLog, setChatLog, chatSendRefused, setChatSendRefused, chatScopes, setChatScopes };
}

function useCallViews() {
  const [ownGroupId, setOwnGroupId] = useState<bigint>();
  const [recordings, setRecordings] = useState<RecordingLabelView[]>([]);
  return { ownGroupId, setOwnGroupId, recordings, setRecordings };
}

type NetViewSetters = {
  setStatus: Dispatch<SetStateAction<ConnectionStatus>>;
  setOwnName: Dispatch<SetStateAction<string | undefined>>;
  setOwnStatus: Dispatch<SetStateAction<StatusView>>;
  setSpace: Dispatch<SetStateAction<SpaceView | undefined>>;
  setZones: Dispatch<SetStateAction<ZoneAdminView[]>>;
  setChatLog: Dispatch<SetStateAction<ChatLog>>;
  setChatSendRefused: Dispatch<SetStateAction<boolean>>;
  setChatScopes: Dispatch<SetStateAction<ChatScopeView>>;
  setHuddle: Dispatch<SetStateAction<HuddleView>>;
  setOwnGroupId: Dispatch<SetStateAction<bigint | undefined>>;
  setRecordings: Dispatch<SetStateAction<RecordingLabelView[]>>;
};

function netHooksOf(setters: NetViewSetters): NetHooks {
  return {
    onStatus: setters.setStatus,
    onOwnName: setters.setOwnName,
    onSpace: setters.setSpace,
    onChat: setters.setChatLog,
    onChatRefused: () => setters.setChatSendRefused(true),
    onOwnStatus: setters.setOwnStatus,
    onZones: setters.setZones,
    onHuddle: setters.setHuddle,
    onChatScopes: setters.setChatScopes,
    onOwnGroup: setters.setOwnGroupId,
    onRecordings: setters.setRecordings,
    onDmRow: (event) => dmNotifier().onDmRow(event),
  };
}

/**
 * The boot stage: creates the game over the host element and starts the
 * net stack over it, returning the teardown the effect registers as its
 * cleanup. Returns undefined when the host is not mounted — the caller
 * must attach it on its first render, and there is no retry.
 *
 * Teardown contract, in order: flag cancellation (a create still in
 * flight then destroys its game instead of mounting), dispose the net
 * stack and clear `netRef`, then destroy the game.
 */
function bootNetStack(
  hostRef: { current: HTMLDivElement | null },
  getToken: AuthTokenGetter,
  netRef: { current: Net | undefined },
  hooks: NetHooks,
): (() => void) | undefined {
  const host = hostRef.current;
  if (!host) return undefined;
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
    netRef.current = startNet(created, getToken, hooks);
  })();

  return () => {
    cancelled = true;
    netRef.current?.dispose();
    netRef.current = undefined;
    game?.destroy();
  };
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
  const connection = useConnectionViews();
  const spaceViews = useSpaceViews();
  const chatViews = useChatViews();
  const [huddle, setHuddle] = useState<HuddleView>({ own: undefined, joinable: undefined });
  const calls = useCallViews();
  // The one handle on the net stack: created inside the effect, disposed by
  // its cleanup, read by the commands (netActions.ts) at call time. A ref
  // rather than state because nothing needs to re-render when it changes.
  const netRef = useRef<Net>(undefined);

  useEffect(() => {
    const hooks = netHooksOf({
      setStatus: connection.setStatus,
      setOwnName: connection.setOwnName,
      setOwnStatus: connection.setOwnStatus,
      setSpace: spaceViews.setSpace,
      setZones: spaceViews.setZones,
      setChatLog: chatViews.setChatLog,
      setChatSendRefused: chatViews.setChatSendRefused,
      setChatScopes: chatViews.setChatScopes,
      setHuddle,
      setOwnGroupId: calls.setOwnGroupId,
      setRecordings: calls.setRecordings,
    });
    return bootNetStack(hostRef, session.getToken, netRef, hooks);
    // The setters the assembly reads are useState setters bundled by the
    // view hooks — identity-stable, listed to satisfy the exhaustive-deps
    // lint. (setHuddle is this hook's own useState setter, which the lint
    // knows is stable and does not ask for.)
  }, [
    session,
    connection.setStatus,
    connection.setOwnName,
    connection.setOwnStatus,
    spaceViews.setSpace,
    spaceViews.setZones,
    chatViews.setChatLog,
    chatViews.setChatSendRefused,
    chatViews.setChatScopes,
    calls.setOwnGroupId,
    calls.setRecordings,
  ]);

  return {
    hostRef,
    status: connection.status,
    ownName: connection.ownName,
    space: spaceViews.space,
    chatLog: chatViews.chatLog,
    chatSendRefused: chatViews.chatSendRefused,
    ownStatus: connection.ownStatus,
    zones: spaceViews.zones,
    huddle,
    chatScopes: chatViews.chatScopes,
    ownGroupId: calls.ownGroupId,
    recordings: calls.recordings,
    // oxlint-disable-next-line react/refs -- netRef は安定したハンドルとして渡し、.current の読み取りはコールバック内でのみ行う
    actions: netActionsOf(netRef, () => chatViews.setChatSendRefused(false)),
  };
}
