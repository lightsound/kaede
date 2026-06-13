import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { BAR_BG, NORD_RED, NORD_YELLOW } from '../colors';

const HUD_STYLE = new TextStyle({ fill: 0xeceff4, fontSize: 14, fontFamily: 'sans-serif' });

export interface Hud {
  /** Screen-space container; add it to the stage so it stays fixed. */
  container: Container;
  /** Update the bars (HP red, XP-to-next yellow) and the level label. */
  set(hp: number, maxHp: number, xp: number, xpNext: number, level: number): void;
}

/** Bottom-left HP/XP bars fixed to the stage. `viewH` anchors them to the floor. */
export function createHud(viewH: number): Hud {
  const container = new Container();
  const X = 16;
  const Y = viewH - 56;
  const BAR_W = 180;
  const BAR_H = 14;

  const label = new Text({ text: 'Lv.1', style: HUD_STYLE });
  label.position.set(X, Y - 20);

  const hpBg = new Graphics().rect(X, Y, BAR_W, BAR_H).fill(BAR_BG);
  const hpFill = new Graphics().rect(0, 0, BAR_W, BAR_H).fill(NORD_RED);
  hpFill.position.set(X, Y);

  const xpBg = new Graphics().rect(X, Y + BAR_H + 4, BAR_W, BAR_H).fill(BAR_BG);
  const xpFill = new Graphics().rect(0, 0, BAR_W, BAR_H).fill(NORD_YELLOW);
  xpFill.position.set(X, Y + BAR_H + 4);

  container.addChild(label, hpBg, hpFill, xpBg, xpFill);

  return {
    container,
    set(hp, maxHp, xp, xpNext, level) {
      label.text = `Lv.${level}`;
      hpFill.scale.x = Math.max(0, Math.min(1, maxHp > 0 ? hp / maxHp : 0));
      xpFill.scale.x = Math.max(0, Math.min(1, xpNext > 0 ? xp / xpNext : 0));
    },
  };
}
