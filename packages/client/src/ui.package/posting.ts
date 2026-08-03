/**
 * When the posting controls (the chat panel and the status panel) are
 * unusable: acting needs a player row to land on — the server refuses
 * otherwise — and `ownName` is defined exactly while one exists. One
 * definition so the two panels cannot drift on the rule. The rename form's
 * gate is deliberately NOT this one: a waiting-room member may rename
 * (RenameControl), but has no row to post from.
 */
export function postingDisabled(connected: boolean, ownName: string | undefined): boolean {
  return !connected || ownName === undefined;
}

/**
 * Wraps a fire-and-forget button action so the button BLURS after acting —
 * the rule every palette/vocabulary button row (reactions, the status
 * switch) shares. Leaving the focus would make the browser's default
 * activation re-fire the action on a later Enter, and — because isTextEntry
 * (game.package/input.ts) exempts only text fields, not buttons — feed held
 * keys to the world input at the same time, with Space additionally caught
 * by the MOVE_KEYS preventDefault (a keydown default the button's keyup
 * click synthesis then trips over, browser-dependently). Blurring makes
 * every key after a click mean exactly one thing: walking the avatar.
 * Verified by hand for the reaction row (2026-08-03) and re-verified for
 * the status buttons (2026-08-03): without the blur, Enter after a click
 * re-sent the action; with it, arrows/Space/Enter all go to the world.
 *
 * Structurally typed (not React's MouseEvent) so the rule itself is
 * unit-testable without a DOM; a React click handler narrows into it.
 */
export function blurringClick(act: () => void): (e: { currentTarget: { blur(): void } }) => void {
  return (e) => {
    act();
    e.currentTarget.blur();
  };
}
