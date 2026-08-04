import type { PlayerInput } from '@maple/shared';

const MOVE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space']);

// mergeInputs (the keyboard/touch combinator) lives in its own file:
// sampling (this file) and combining are separate concerns with separate
// consumers, and fallow's health gate flags the pairing as a high-impact
// split candidate.

/**
 * True when the key event is aimed at a text-entry element (the display-name
 * form today, chat later), so the avatar must not react to it. Structural
 * rather than `instanceof HTMLElement`: the check needs no DOM globals, which
 * also keeps it testable under the fake window the unit tests install.
 */
function isTextEntry(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  return el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable === true;
}

/** Window keyboard listener that samples held keys into a PlayerInput. */
export function createInput(): { sample(): PlayerInput; dispose(): void } {
  const held = new Set<string>();

  const onDown = (e: KeyboardEvent) => {
    if (isTextEntry(e.target)) return;
    if (MOVE_KEYS.has(e.code)) e.preventDefault();
    held.add(e.code);
  };
  const onUp = (e: KeyboardEvent) => {
    // Always release: a key pressed in the world but released over a text
    // field must not stay held forever. Only the world path eats the event.
    held.delete(e.code);
    if (isTextEntry(e.target)) return;
    if (MOVE_KEYS.has(e.code)) e.preventDefault();
  };
  // A key still physically held when focus enters a text field would keep
  // the avatar walking while the player types: its keydown landed before the
  // focus change and its auto-repeats are ignored above, so nothing else
  // would ever clear it. Releasing everything on entry is safe — the world
  // ignores keys while the field has focus anyway.
  const onFocusIn = (e: FocusEvent) => {
    if (isTextEntry(e.target)) held.clear();
  };

  window.addEventListener('keydown', onDown);
  window.addEventListener('keyup', onUp);
  window.addEventListener('focusin', onFocusIn);

  return {
    sample: () => ({
      left: held.has('ArrowLeft'),
      right: held.has('ArrowRight'),
      up: held.has('ArrowUp'),
      down: held.has('ArrowDown'),
      jump: held.has('Space'),
    }),
    dispose: () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('focusin', onFocusIn);
    },
  };
}
