---
name: testing-kaede-e2e
description: How to run and manually test the kaede app end-to-end (local SpacetimeDB host, Vite dev client, guest multi-window sync, idle suspend/resume, Playwright e2e suite)
---

# Testing kaede end-to-end

## Stack bring-up (order matters)

1. `export PATH="$HOME/.local/bin:$PATH"` — the pinned CLI binary is `spacetimedb-cli` (NOT `spacetime`).
2. `spacetimedb-cli start` — long-running host on `ws://localhost:3000`, keep it up in background.
3. `spacetimedb-cli publish kaede --server local --yes` from repo root.
4. `pnpm dev` → Vite client on `http://localhost:5173` (client defaults to ws://localhost:3000 + DB `kaede` in dev; no env vars needed).

Verify host: `spacetimedb-cli list --server local` shows `kaede`. The `sql` subcommand needs `--server local` explicitly or it hits maincloud and fails with `InvalidSignature` 401.

## Client behavior that shapes tests

- **Guests auto-join**: no button. `decideAdmission` → 'admitted' → `enterWorld` → `join` reducer spawns the row. `space_setting` empty/absent → `guestsAllowedFrom` defaults **true**.
- **Identity = anonymous token in `sessionStorage`** (`kaede.spacetime.token`): same-tab reload/navigation resumes the SAME identity + position; a new window/tab = a NEW identity. Two windows → two guests.
- **Movement**: ArrowLeft/Right walk, ArrowUp/Down climb ropes (`ROPE_GRAB_RANGE=16px` of rope x), Space jumps. `MOVE_SPEED=240` px/s.
- **Idle guard**: `?idleMs=<ms>` dev-only override (e.g. `?idleMs=5000`); banner text `離席中のため接続を休止しています。…`; ANY of `keydown/pointerdown/pointermove/wheel` on that window resumes — **park the mouse over the other window during idle waits** (pointermove counts).
- **`?perf=1` dev HUD**: top-left overlay shows `remotes` (remotePlayers count), `row upd/s`, `x-spread` — on-screen proof of sync without devtools.
- **`window.__kaedeE2E.snapshot()`** (dev hook): `{ tick, local, remotePlayers }`; `tick >= 0` = in world.
- **`?perf=1` + rope trick for remote-avatar visibility**: the DOM UI panels occlude ground-level remote avatars. Climb a rope (plaza ropes at world x=550/990 reachable from ground) or stand on a platform to render the remote avatar above the panel strip. Beware camera edge-clamping: remotes far right of the observer go off-screen.
- **Server truth**: `spacetimedb-cli sql kaede "SELECT identity,x,y,rope,online FROM player" --server local` — `online=false` = suspended/offline (row lingers ~10min retention). `connection_event` table logs connected/disconnected with `guest`/`idle`/`unannounced` labels — great for reconstructing event ordering; `spacetimedb-cli sql` probes themselves appear there as their own identity.
- **Reconnect notes**: join → `online=true` immediately; the client sends a heartbeat when it sees its own row `online=false` (self-heal for stale-disconnect races). A suspended-then-resumed client re-suspends after another idleMs of no input — don't misread post-resume `online=false` SQL reads as a failure; check `connection_event` timing.

## Playwright e2e suite

```sh
pnpm --filter @kaede/e2e exec playwright install --with-deps chromium   # once
SPACETIME_BIN=spacetimedb-cli pnpm test:e2e                              # host+publish required first
```

- Config `reuseExistingServer: !CI` reuses a running `pnpm dev` on :5173; workers=1, 120s/spec.
- **Close manual test windows before running the suite** — lingering online player rows count as extra remotes and break count assertions.
- Specs share one world; helpers write admin state via `sql()` (SPACETIME_BIN needed because helper defaults to `spacetime`).

## Two-window manual sync test recipe

`google-chrome --new-window http://localhost:5173/?perf=1` twice → `wmctrl -lG` for ids → tile side-by-side (this box: real display 1600x1200, screenshots scale to 1024x768 — `wmctrl -i -r <id> -e 0,x,y,800,1145`). Activate a window without pointer events via `wmctrl -i -a <id>`; send keys with `hold_key`/`key`. Verify positions via SQL rather than pixel-guessing.
