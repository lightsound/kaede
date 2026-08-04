// fallow-ignore-file coverage-gaps -- reads the live document / Notification environment and constructs OS notifications; the decision and content rules are shouldNotifyDm / dmNotificationContent, unit-tested in @kaede/shared, and the dev-only override parser is visibilityOverride.ts (unit-tested here in packages/client)
import {
  type DmNotificationContent,
  type DmNotifyContext,
  type DmRowEvent,
  dmNotificationContent,
  type NotificationPermissionState,
  shouldNotifyDm,
} from '@kaede/shared';
import { parseVisibilityOverride, type VisibilityReading } from './visibilityOverride';

/** What the permission UI renders from (see NotificationControl). */
export interface NotifyUiState {
  permission: NotificationPermissionState;
  /** The session-local mute toggle; never persisted (out of scope). */
  muted: boolean;
}

export interface DmNotifier {
  /**
   * Feeds one dm_message row (seed or event — source-tagged) through the
   * decision rule and, when it says so, raises the OS notification. The
   * caller (App wiring NetHooks.onDmRow) never decides anything.
   */
  onDmRow(event: DmRowEvent): void;
  uiState(): NotifyUiState;
  /**
   * Asks the browser for notification permission. Must be called from a
   * user gesture (the NotificationControl click) — browsers ignore or
   * auto-deny requests fired on load. Resolves when the prompt settles;
   * the caller re-reads uiState() for the outcome.
   */
  requestPermission(): Promise<void>;
  setMuted(muted: boolean): void;
}

/**
 * The live permission, with a missing API read as its own state so every
 * consumer treats "this browser cannot notify" as just another non-granted
 * permission (existing features must keep working there).
 */
function readPermission(): NotificationPermissionState {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/**
 * Bumps the E2E decision counter (see E2ENetStats.dmNotifyDecisions).
 * Called BEFORE construction, so the probe measures the decision — the
 * unit-tested rule applied to live inputs — not the platform's willingness
 * to actually display one. Production builds drop the body entirely.
 */
function countDecisionForE2E(): void {
  if (!import.meta.env.DEV) return;
  const stats = window.__kaedeE2ENet;
  if (stats) stats.dmNotifyDecisions += 1;
}

/** Constructs the OS notification; clicking it focuses this tab and dismisses. */
function raiseNotification(content: DmNotificationContent): void {
  try {
    const notification = new Notification(content.title, {
      body: content.body,
      tag: content.tag,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Granted permission does not prove constructibility: some platforms
    // (e.g. Android Chrome) refuse page-scoped Notification and require a
    // ServiceWorker. Nothing to fall back to, and the DM already reached
    // the chat log.
  }
}

function createDmNotifier(): DmNotifier {
  // The dev-only E2E lever (see visibilityOverride.ts); undefined in
  // production builds and on any URL without the parameter.
  const override = import.meta.env.DEV
    ? parseVisibilityOverride(window.location.search)
    : undefined;
  let muted = false;

  return {
    onDmRow(event) {
      // Environment reads happen HERE, per row — visibility and permission
      // change over a tab's life, so nothing may be captured at wiring time.
      const visibility: VisibilityReading = override ?? {
        hidden: document.hidden,
        hasFocus: document.hasFocus(),
      };
      const context: DmNotifyContext = { permission: readPermission(), muted, ...visibility };
      if (!shouldNotifyDm(event, context)) return;
      countDecisionForE2E();
      raiseNotification(dmNotificationContent(event));
    },
    uiState: () => ({ permission: readPermission(), muted }),
    async requestPermission() {
      if (typeof Notification === 'undefined') return;
      await Notification.requestPermission();
    },
    setMuted(next) {
      muted = next;
    },
  };
}

let instance: DmNotifier | undefined;

/**
 * The one notifier of this tab. A lazy module singleton — not a per-mount
 * factory like startNet — because everything it holds (the permission, the
 * session mute, the visibility override) is per-TAB environment state that
 * must survive React remounts (a StrictMode probe mount resetting the mute
 * would flip notifications back on behind the user's back), and it owns no
 * resources that a teardown would need to release.
 */
export function dmNotifier(): DmNotifier {
  instance ??= createDmNotifier();
  return instance;
}
