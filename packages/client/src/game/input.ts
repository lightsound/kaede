import type { PlayerInput } from '@maple/shared';

const MOVE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'KeyZ']);

/** Field-wise OR of two inputs, so multiple sources (keyboard, touch) combine. */
export function mergeInputs(a: PlayerInput, b: PlayerInput): PlayerInput {
  return {
    left: a.left || b.left,
    right: a.right || b.right,
    up: a.up || b.up,
    down: a.down || b.down,
    jump: a.jump || b.jump,
    attack: a.attack || b.attack,
  };
}

/**
 * True while the event originated from a text-entry element. When chat (or the
 * name overlay) has focus, key events must NOT reach the game: otherwise typing
 * "z" would swing the sword and arrow keys (caret movement) would be eaten by
 * preventDefault. We let those events fall straight through to the input.
 */
function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** Window keyboard listener that samples held keys into a PlayerInput. */
export function createInput(): { sample(): PlayerInput; dispose(): void } {
  const held = new Set<string>();

  const onDown = (e: KeyboardEvent) => {
    // Ignore (and don't preventDefault) while typing into chat/name: see
    // isTextEntry. Returning before touching `held` also means no key is left
    // stuck "down" because its keyup landed on the input instead of the window.
    if (isTextEntry(e.target)) return;
    if (MOVE_KEYS.has(e.code)) e.preventDefault();
    held.add(e.code);
  };
  const onUp = (e: KeyboardEvent) => {
    if (isTextEntry(e.target)) return;
    if (MOVE_KEYS.has(e.code)) e.preventDefault();
    held.delete(e.code);
  };
  // Focusing the chat input (or alt-tabbing away) steals the keyup that would
  // clear a held movement key, which would otherwise leave the player walking.
  // Clearing `held` on blur guarantees no key stays stuck.
  const onBlur = () => held.clear();

  window.addEventListener('keydown', onDown);
  window.addEventListener('keyup', onUp);
  window.addEventListener('blur', onBlur);

  return {
    sample: () => ({
      left: held.has('ArrowLeft'),
      right: held.has('ArrowRight'),
      up: held.has('ArrowUp'),
      down: held.has('ArrowDown'),
      jump: held.has('Space'),
      attack: held.has('KeyZ'),
    }),
    dispose: () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    },
  };
}
