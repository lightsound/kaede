// fallow-ignore-file coverage-gaps -- helpers over the SpacetimeDB reducer context; they only run inside a module host, and the one rule worth testing (reading the provider's name claim) is delegated to profileNameFrom in @kaede/shared and unit-tested there

// The account row's write paths (the global profile — see the account
// table comment in tables.ts): the sign-in bootstrap a member's connect
// runs (onConnect in connection.ts) and the name persistence a rename
// takes (set_display_name in membership.ts). Shared by those two reducer
// files, so it lives outside both (the world.ts header rule).
import { profileNameFrom } from '@kaede/shared';
import type { Ctx } from './world';

/**
 * Guarantees a member has an account row, carrying the display name its
 * identity provider vouches for (the JWT `name` claim) as the initial
 * profile name — the Discord-model account exists, with a name, before any
 * membership application is filed. Only members get an account: a member's
 * Identity is stable across devices and reconnects (derived from the
 * provider's issuer+subject), so the row it maps to genuinely is the same
 * person; a guest Identity is per-tab and transient, and an account keyed by
 * it would be garbage the moment the tab closes.
 *
 * The claim only ever fills an empty name: a name the user chose is theirs,
 * and a later Google rename must not overwrite it. A missing claim (the
 * Clerk JWT template may not carry `name` yet — see ROADMAP) leaves the
 * profile nameless, exactly as before.
 *
 * find-then-insert is race-free here: reducers are atomic transactions that
 * the host serializes, so two first-time connections from the same member
 * (two tabs, two devices) cannot interleave — the second clientConnected
 * runs after the first committed and finds its row.
 */
export function ensureAccount(ctx: Ctx, subject: string): void {
  const claimedName = profileNameFrom(ctx.senderAuth.jwt?.fullPayload);
  const existing = ctx.db.account.identity.find(ctx.sender);
  if (existing === null) {
    ctx.db.account.insert({
      id: 0n, // 0 asks autoInc to assign the real id
      identity: ctx.sender,
      displayName: claimedName,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      subject,
    });
    return;
  }
  backfillAccountName(ctx, existing.displayName, claimedName);
  backfillAccountSubject(ctx, subject);
}

/**
 * Fills an account's empty display name from the provider's claim, if any —
 * through the same write path a rename takes (persistMemberName), so the
 * public space_member projection of a member who applied nameless picks the
 * name up too and cannot drift from the account. A separate function (not
 * inlined into ensureAccount) to keep the untestable reducer helpers under
 * the CRAP budget fallow enforces for uncovered functions.
 */
function backfillAccountName(
  ctx: Ctx,
  currentName: string | undefined,
  claimedName: string | undefined,
): void {
  if (currentName !== undefined || claimedName === undefined) return;
  persistMemberName(ctx, claimedName);
}

/**
 * Records the provider subject on the sender's account row (see the
 * `subject` column comment in tables.ts): fills rows that predate the
 * column, and rewrites it if a re-link ever changes the identity's
 * provider mapping. Re-read rather than passed through because
 * backfillAccountName may have just rewritten the row (persistMemberName)
 * and a stale copy would clobber it. A separate function to keep
 * ensureAccount under the CRAP budget (the backfillAccountName
 * precedent).
 */
function backfillAccountSubject(ctx: Ctx, subject: string): void {
  const account = ctx.db.account.identity.find(ctx.sender);
  if (account === null || account.subject === subject) return;
  ctx.db.account.id.update({ ...account, subject, updatedAt: ctx.timestamp });
}

/**
 * Persists a member's name on its account (the source of truth) and mirrors
 * it onto the public space_member projection, so the admin UI and the
 * waiting room show the same name the next join will spawn under.
 */
export function persistMemberName(ctx: Ctx, name: string): void {
  const account = ctx.db.account.identity.find(ctx.sender);
  if (account !== null) {
    ctx.db.account.id.update({ ...account, displayName: name, updatedAt: ctx.timestamp });
  }
  const member = ctx.db.spaceMember.identity.find(ctx.sender);
  if (member !== null) {
    ctx.db.spaceMember.identity.update({ ...member, displayName: name, updatedAt: ctx.timestamp });
  }
}
