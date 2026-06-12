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

/** Window keyboard listener that samples held keys into a PlayerInput. */
export function createInput(): { sample(): PlayerInput; dispose(): void } {
  const held = new Set<string>();

  const onDown = (e: KeyboardEvent) => {
    if (MOVE_KEYS.has(e.code)) e.preventDefault();
    held.add(e.code);
  };
  const onUp = (e: KeyboardEvent) => {
    if (MOVE_KEYS.has(e.code)) e.preventDefault();
    held.delete(e.code);
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
      attack: held.has('KeyZ'),
    }),
    dispose: () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    },
  };
}
