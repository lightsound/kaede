import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInput } from '../src/game/input';

type Listener = (e: { code: string; preventDefault(): void }) => void;

/**
 * The smallest stand-in for `window` that createInput uses: a listener registry
 * plus dispatch. Keeping it hand-rolled (rather than pulling in a DOM
 * environment) lets the assertions check registration and removal directly.
 */
function fakeWindow() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
    addEventListener(type: string, fn: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      listeners.get(type)?.delete(fn);
    },
    press(type: 'keydown' | 'keyup', code: string) {
      let defaultPrevented = false;
      const event = {
        code,
        preventDefault() {
          defaultPrevented = true;
        },
      };
      for (const fn of listeners.get(type) ?? []) fn(event);
      return defaultPrevented;
    },
  };
}

const install = () => {
  const win = fakeWindow();
  vi.stubGlobal('window', win);
  return win;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createInput', () => {
  it('samples all-false before any key is held', () => {
    install();
    const input = createInput();
    expect(input.sample()).toEqual({
      left: false,
      right: false,
      up: false,
      down: false,
      jump: false,
    });
    input.dispose();
  });

  it('maps each arrow key and Space onto its input field', () => {
    const win = install();
    const input = createInput();
    for (const [code, field] of [
      ['ArrowLeft', 'left'],
      ['ArrowRight', 'right'],
      ['ArrowUp', 'up'],
      ['ArrowDown', 'down'],
      ['Space', 'jump'],
    ] as const) {
      win.press('keydown', code);
      expect(input.sample()[field]).toBe(true);
      win.press('keyup', code);
      expect(input.sample()[field]).toBe(false);
    }
    input.dispose();
  });

  it('holds several keys at once', () => {
    const win = install();
    const input = createInput();
    win.press('keydown', 'ArrowRight');
    win.press('keydown', 'Space');
    expect(input.sample()).toMatchObject({ right: true, jump: true, left: false });
    input.dispose();
  });

  it('prevents the default only for keys the game uses, so the page cannot scroll', () => {
    const win = install();
    const input = createInput();
    expect(win.press('keydown', 'ArrowDown')).toBe(true);
    expect(win.press('keyup', 'Space')).toBe(true);
    expect(win.press('keydown', 'KeyQ')).toBe(false);
    input.dispose();
  });

  it('unregisters both listeners on dispose', () => {
    const win = install();
    const input = createInput();
    expect(win.listenerCount('keydown')).toBe(1);
    expect(win.listenerCount('keyup')).toBe(1);
    input.dispose();
    expect(win.listenerCount('keydown')).toBe(0);
    expect(win.listenerCount('keyup')).toBe(0);
  });
});
