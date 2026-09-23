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

## Chat rate-limit / server-refusal testing

Chat sends sit behind a token-bucket (`sendAllowance.ts`: cost 1s/send, burst 5; marker = "paid until T", send ok iff marker ≤ now, accepted → marker += 1s, floored at now-4s). Two mirrors of it exist and produce DIFFERENT notices:

- **Client mirror** = per-tab `allowanceRef` in ChatPanel → block shows 「送信が速すぎます。少し待ってから送ってください」 and the draft STAYS in the input (never dispatched).
- **Server bucket** = `chat_guard` row per identity → refusal shows 「送信できませんでした。少し待ってからもう一度お試しください」; the refused text never reaches `chat_message` and the draft clears (dispatch happened).

To trigger a real server refusal you need ANOTHER connection spending the same identity's bucket — a single tab can never outrun it (client mirror and server bucket advance in lockstep; single-tab floods only ever produce the client-side 速すぎます). Technique: **right-click the world tab → Duplicate** (Chrome clones sessionStorage → same anonymous token → same identity → shared `chat_guard`). The duplicate lands at tab position+1, so `ctrl+2`/`ctrl+1` switch between the pair. Confirm sharing via `SELECT identity,name FROM player_name` — no new row appears (stale rows from dead sessions linger ~10min, ignore them).

Timing recipe that worked: pre-stage drafts in BOTH tabs (type but don't send), then in ONE tool batch — Enter (tab A send lands, marker pinned ≈ now+1) → ctrl+N → Enter (tab B send inside the <1s window → refused) → rapid-fire ~8 more sends. Expect an alternating land/refuse pattern; corroborate which sends landed with `spacetimedb-cli sql kaede "SELECT * FROM chat_message" --server local` (`sent_at` timestamps let you reconstruct the marker math exactly — a send that lands <1s after a refusal proves the refusal refunded the client mirror; without the refund it would have been mirror-blocked instead).

Caveats: tool actions run ~0.5–0.7s each, so the critical gap must be ≤2 actions — pre-stage everything. `type` cannot produce Japanese text — use ASCII chat messages. The chat input keeps focus across tab switches and after Enter, so staged drafts + bare Enter work.
