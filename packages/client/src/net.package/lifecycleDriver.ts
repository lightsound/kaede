// fallow-ignore-file coverage-gaps -- performs the lifecycle machine's effects against a live connection (sockets, timers, status callbacks); the decisions are pure and unit-tested in lifecycle.ts, and this shell is covered end-to-end by e2e
import type { DbConnection } from '../module_bindings';
import { captureEvent } from '../telemetry.package';
import { type AuthTokenGetter, type Connected, connect, target } from './connection';
import {
  type ConnectionStatus,
  type LifecycleEffect,
  type LifecycleEvent,
  type LifecycleState,
  transition,
} from './lifecycle';

/** What the lifecycle driver needs from the net stack that owns it (startNet). */
export interface LifecycleDriverDeps {
  /** The pure lifecycle state (lifecycle.ts), owned by startNet. */
  getState(): LifecycleState;
  /** Stores the state a transition produced. */
  setState(state: LifecycleState): void;
  /** The live connection, read when an effect runs. */
  getConnection(): DbConnection | undefined;
  /** Adopts (wire-session) or drops the live connection. */
  setConnection(conn: DbConnection | undefined): void;
  /** Reports the connection status to the UI (NetHooks.onStatus). */
  onStatus(status: ConnectionStatus): void;
  /** Wires a freshly settled connection as the live session (sessionWiring.ts). */
  wireSession(settled: Connected, generation: number): void;
  /** Tears the live session's state down (sessionWiring.ts). */
  dropSession(): void;
  /** Produces a fresh OIDC token per connect attempt (connection.ts). */
  getAuthToken: AuthTokenGetter;
}

/**
 * The shell around the pure lifecycle machine (lifecycle.ts): the one
 * path lifecycle events enter through, performing each returned effect
 * (timers, sockets, session wiring, status callbacks) in order.
 */
export interface LifecycleDriver {
  /** Runs one lifecycle step and performs its effects in order. */
  dispatch(event: LifecycleEvent, settled?: Connected): LifecycleEffect[];
}

/**
 * One runner per lifecycle effect kind, each receiving its narrowed payload.
 * A handler MAP rather than the codebase's usual `switch` + `satisfies never`
 * deliberately: this shell is uncovered (it needs a live host — see the
 * fallow-ignore header), and a 9-branch uncovered switch busts the CRAP
 * budget fallow enforces, while a map is branch-free and still makes a new
 * effect kind a compile error (a missing key). The lifecycle's event
 * dispatch adopted the same shape once its switch grew big enough to trip
 * the clone detector (see eventHandlers in lifecycle.ts).
 */
type EffectRunners = {
  [K in LifecycleEffect['kind']]: (effect: Extract<LifecycleEffect, { kind: K }>) => void;
};

/**
 * Calls the runner matching the effect's kind. Generic over the kind so the
 * indexed access stays correlated — the runner receives exactly its own
 * payload type, with no cast and no narrowing switch.
 */
function runEffect<K extends LifecycleEffect['kind']>(
  runners: EffectRunners,
  effect: Extract<LifecycleEffect, { kind: K }>,
): void {
  const runner: (e: typeof effect) => void = runners[effect.kind];
  runner(effect);
}

/**
 * Builds the lifecycle driver. It owns the retry timer — the one piece of
 * shell state no other piece reads — and nothing else: the lifecycle
 * state and the connection stay startNet's, reached through the deps.
 */
export function createLifecycleDriver(deps: LifecycleDriverDeps): LifecycleDriver {
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * One runner per effect kind, built per dispatch so the runners close over
   * that dispatch's context: `closing` is the conn captured BEFORE the
   * effects run (so `disconnect` closes the connection the transition
   * decided to cut even after `drop-session` cleared the ref), and `settled`
   * is the connection a `connect-ok` event is about (not `conn` yet —
   * adopting it is itself an effect). A map instead of a switch so a new
   * effect kind is a compile error here, not a silently ignored case.
   */
  function effectRunners(
    closing: DbConnection | undefined,
    settled: Connected | undefined,
  ): EffectRunners {
    return {
      status: (e) => deps.onStatus(e.status),
      connect: (e) => startConnect(e.generation, e.consecutiveFailures),
      'wire-session': (e) => {
        if (!settled) {
          // Unreachable — only a connect-ok dispatch carries a settled
          // connection — but narrowing must not read as a silent no-op
          // (the transitionMember precedent).
          console.error('SpacetimeDB: wire-session effect without a settled connection');
          return;
        }
        deps.setConnection(settled.conn);
        deps.wireSession(settled, e.generation);
      },
      'discard-attempt': () => settled?.conn.disconnect(),
      'arm-retry': (e) => {
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          dispatch({ kind: 'retry-due' });
        }, e.delayMs);
      },
      'cancel-retry': () => {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      },
      'drop-session': () => deps.dropSession(),
      disconnect: () => closing?.disconnect(),
      // Failure is fine: an announce that never lands just means the server
      // logs this cut as 'unannounced', which is the label it would have
      // gotten anyway without this effect.
      'announce-suspend': () => {
        closing?.reducers.announceIdleSuspend({}).catch(() => {});
      },
      'probe-session': (e) => {
        // Read the socket state the pure machine cannot: isSocketClosed
        // (SDK 2.7.1) is true even when the browser never delivered the
        // close event — the zombie a frozen tab leaves behind. Dispatching
        // from inside a runner is safe here because probe-session is always
        // its transition's only effect, so no sibling effect runs against
        // the superseded state.
        const c = deps.getConnection();
        if (!c || c.isDisconnectRequested || !c.isSocketClosed) return;
        console.warn('SpacetimeDB: socket died while the page was hidden, reconnecting');
        captureEvent('spacetimedb_session_dead');
        dispatch({ kind: 'session-dead', generation: e.generation });
      },
    };
  }

  /** Runs one lifecycle step and performs its effects in order. */
  function dispatch(event: LifecycleEvent, settled?: Connected): LifecycleEffect[] {
    const step = transition(deps.getState(), event);
    deps.setState(step.state);
    const runners = effectRunners(deps.getConnection(), settled);
    for (const effect of step.effects) runEffect(runners, effect);
    return step.effects;
  }

  /** One connect attempt; every outcome is reported back as a lifecycle event. */
  function startConnect(generation: number, consecutiveFailures: number): void {
    connect(
      {
        onDisconnect() {
          // Read BEFORE the dispatch: a failed handshake reports both a
          // rejection and this socket close, and the close's transition
          // still performs a (vacuous) drop-session — so the effect alone
          // cannot tell "an established session dropped" from "the connect
          // attempt never got one". Only the former is a disconnect; the
          // latter is already reported as spacetimedb_connect_failed.
          const wasLive = deps.getState().sessionLive;
          const effects = dispatch({ kind: 'socket-closed', generation });
          // Only an unexpected drop of the live session is worth a log: a
          // stale close produces no effects, and a close the idle guard
          // asked for leaves the state suspended. The same rule picks what
          // is worth a telemetry event (ADR §8.2-A: WebSocket は自動計装
          // されないため、送らなければ何も記録されない).
          if (
            wasLive &&
            effects.some((e) => e.kind === 'drop-session') &&
            !deps.getState().suspended
          ) {
            console.warn('SpacetimeDB: connection dropped, reconnecting');
            captureEvent('spacetimedb_disconnected');
          }
        },
      },
      consecutiveFailures,
      deps.getAuthToken,
    )
      .then((settled) => {
        // Recovery after a failure streak. The count is read before the
        // dispatch resets it, but the event is sent only if the success was
        // ADOPTED (wire-session): a connect settling into an idle-suspended
        // or disposed stack is discarded and leaves the user offline, which
        // must not read as a recovery. Successful first connects and clean
        // reconnects stay silent — the metric is "how long did retries fail".
        const failuresBeforeSuccess = deps.getState().consecutiveFailures;
        const effects = dispatch({ kind: 'connect-ok' }, settled);
        if (failuresBeforeSuccess > 0 && effects.some((e) => e.kind === 'wire-session')) {
          captureEvent('spacetimedb_reconnected', { failedAttempts: failuresBeforeSuccess });
        }
      })
      // The overlay can only ever say "connecting", so without this the actual
      // cause (host not running, unknown database name, stale schema) never
      // reaches anyone. Naming the target makes the common misconfigurations
      // self-evident from the first line of the log.
      .catch((err: unknown) => {
        const effects = dispatch({ kind: 'connect-failed' });
        const retry = effects.find(
          (e): e is Extract<LifecycleEffect, { kind: 'arm-retry' }> => e.kind === 'arm-retry',
        );
        // 再接続の連続失敗は例外として投げられない(ADR §8.2-A)ので、
        // 明示的に送る。失敗のたび1イベント(最短でも backoff 間隔)。
        captureEvent('spacetimedb_connect_failed', {
          consecutiveFailures: deps.getState().consecutiveFailures,
          everConnected: deps.getState().everConnected,
          willRetry: retry !== undefined,
        });
        console.error(
          `SpacetimeDB: connection to ${target} failed, ${
            retry ? `retrying in ${retry.delayMs}ms` : 'suspended for idle (input reconnects)'
          }`,
          err,
        );
      });
  }

  return { dispatch };
}
