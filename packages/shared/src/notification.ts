/**
 * The browser notification for incoming DMs (ROADMAP Phase 2): whether one
 * dm_message row handed to a client should become an OS notification, and
 * what that notification says. Pure and shared (the planChatDraft
 * precedent) so the rules are unit-tested here; the client's notifier glue
 * only reads the environment (document visibility, Notification.permission,
 * the session mute) and feeds it in as inputs — which is also what lets the
 * E2E specs steer the decision through a dev-only visibility override
 * without faking the Notification API itself.
 */

/**
 * Where a dm_message row reached this client from: the subscription seed
 * (entry / reload / reconnect hands over the retained history) or a live
 * insert EVENT. Notifications fire from events ONLY — the chatFeed bubble
 * rule pointed at notifications: a seed is history, and replaying it as a
 * burst of notifications on every reload would train people to ignore
 * them. The accepted consequence: a DM sent while its recipient was
 * disconnected arrives as the next session's seed, so it never notifies.
 */
export type DmRowSource = 'seed' | 'event';

/**
 * The browser's Notification.permission vocabulary plus 'unsupported' for
 * browsers without the API at all, so every caller handles the missing API
 * as just another non-granted state instead of branching on existence.
 */
export type NotificationPermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

/**
 * One dm_message row as the notification pipeline reads it, carried from
 * the row event (net.package's chat feed) to the notifier. `own` is
 * "this client sent it" — the sender column matched, so the row landing on
 * the SENDER's other tab is own there too. `senderKey` is the opaque
 * identity hex, the stable per-sender handle the notification tag needs
 * (names are neither unique nor stable).
 */
export interface DmRowEvent {
  source: DmRowSource;
  own: boolean;
  senderName: string;
  senderKey: string;
  text: string;
}

/**
 * The environment half of the decision, read by the wiring at decision
 * time and passed in (never read inside — see the module comment).
 * `hidden` and `hasFocus` are document.hidden / document.hasFocus(), kept
 * as the two raw signals rather than one precomputed "visible" so the
 * visibility rule itself lives (and is tested) here, not in the glue.
 */
export interface DmNotifyContext {
  permission: NotificationPermissionState;
  /** The session-local toggle (NotificationControl); never persisted. */
  muted: boolean;
  /** document.hidden — true when the tab is switched away or minimized. */
  hidden: boolean;
  /** document.hasFocus() — false while another window/app holds the focus. */
  hasFocus: boolean;
}

/**
 * Whether one DM row becomes a notification. Every clause is a settled
 * rule:
 * - events only, never the seed (see DmRowSource);
 * - never for own sends — the sender is looking at the conversation by
 *   definition, and the row echoing back to their other tab is not news;
 * - only with the permission actually granted and the session toggle on;
 * - only while the tab is not "visible" — where visible means BOTH
 *   un-hidden AND focused. document.hidden alone only catches tab
 *   switches and minimizing; kaede's main posture is "the tab open on the
 *   side while working in another app" (the idle.ts rationale), where the
 *   tab stays un-hidden but unfocused — exactly when a DM needs to reach
 *   its reader. So focus loss notifies too (the Slack model). The cost —
 *   a notification while the tab is on a visible second monitor with the
 *   focus elsewhere — is mild: the reader sees both, and the tag-based
 *   replacement keeps it to one.
 */
export function shouldNotifyDm(event: DmRowEvent, context: DmNotifyContext): boolean {
  return (
    event.source === 'event' &&
    !event.own &&
    context.permission === 'granted' &&
    !context.muted &&
    (context.hidden || !context.hasFocus)
  );
}

/** What one DM notification shows; the Notification constructor's inputs. */
export interface DmNotificationContent {
  title: string;
  body: string;
  /**
   * The replacement slot: same tag = the newer notification replaces the
   * older one instead of stacking. Per SENDER, so bursts from one person
   * collapse to their latest line while two people's DMs stay side by
   * side — and because tags are per-origin, a member with two kaede tabs
   * open gets ONE notification, not one per tab.
   */
  tag: string;
}

/**
 * Composes one DM notification: the sender in the title, the full text in
 * the body. Showing the body is deliberate — kaede is a small community's
 * private office, and a notification that says only "DMがあります" makes
 * the reader switch tabs to learn whether it was worth switching for.
 * (Hiding message previews is a future per-user setting, out of scope with
 * the rest of notification persistence.)
 */
export function dmNotificationContent(
  event: Pick<DmRowEvent, 'senderName' | 'senderKey' | 'text'>,
): DmNotificationContent {
  return {
    title: `${event.senderName} からのDM`,
    body: event.text,
    tag: `kaede-dm:${event.senderKey}`,
  };
}
