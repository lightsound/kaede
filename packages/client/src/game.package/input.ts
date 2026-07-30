import type { PlayerInput } from '@maple/shared';

const MOVE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space']);

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

/** Field-wise OR of two inputs, so multiple sources (keyboard, touch) combine. */
export function mergeInputs(a: PlayerInput, b: PlayerInput): PlayerInput {
  return {
    left: a.left || b.left,
    right: a.right || b.right,
    up: a.up || b.up,
    down: a.down || b.down,
    jump: a.jump || b.jump,
  };
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

  window.addEventListener('keydown', onDown);
  window.addEventListener('keyup', onUp);

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
    },
  };
}
