// fallow-ignore-file coverage-gaps -- a React overlay that polls the dev-only window hooks on an interval; needs a DOM, and no DOM test environment is configured. The readout it prints is perfHudLine.ts, which is unit-tested

// The dev-only `?perf=1` overlay for the concurrent-mover probe: FPS, how
// many remote players are drawn, the player-row update rate and how far
// apart the remotes stand, sampled four times a second.
import type { E2EWorldSnapshot } from '@kaede/shared';
import { type CSSProperties, useEffect, useState } from 'react';
import { UI_GOLD, UI_GOLD_BORDER, UI_PANEL_BG } from '../theme';
import { perfHudLine, perSecond } from './perfHudLine';

const PERF_HUD_STYLE: CSSProperties = {
  position: 'absolute',
  top: 12,
  left: 12,
  padding: '8px 12px',
  borderRadius: 8,
  background: UI_PANEL_BG,
  border: UI_GOLD_BORDER,
  color: UI_GOLD,
  font: '12px ui-monospace, SFMono-Regular, Menlo, monospace',
  zIndex: 30,
  pointerEvents: 'none',
  whiteSpace: 'pre',
  lineHeight: 1.45,
};

function perfHudEnabled(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get('perf') === '1';
}

function worldSnap(): E2EWorldSnapshot | undefined {
  const snap = window.__kaedeE2E?.snapshot();
  if (snap === undefined || snap.tick < 0) return undefined;
  return snap;
}

function samplePerfHud(
  lastUpdates: number,
  lastAt: number,
): { text: string; updates: number; at: number } {
  const now = performance.now();
  const updates = window.__kaedeE2ENet?.playerRowUpdates ?? 0;
  const updateRate = perSecond(updates - lastUpdates, (now - lastAt) / 1000);
  const snap = worldSnap();
  if (!snap) return { text: 'waiting for world…', updates, at: now };
  return { text: perfHudLine(snap, updateRate), updates, at: now };
}

/** Dev-only `?perf=1` overlay for the concurrent-mover probe. */
function PerfHud() {
  const [text, setText] = useState('measuring…');
  useEffect(() => {
    let lastUpdates = 0;
    let lastAt = performance.now();
    const id = window.setInterval(() => {
      const sample = samplePerfHud(lastUpdates, lastAt);
      lastUpdates = sample.updates;
      lastAt = sample.at;
      setText(sample.text);
    }, 250);
    return () => window.clearInterval(id);
  }, []);
  return <div style={PERF_HUD_STYLE}>{text}</div>;
}

export function DevPerfHud() {
  if (!perfHudEnabled()) return null;
  return <PerfHud />;
}
