---
name: testing-call-ui
description: End-to-end GUI testing of the kaede call UI (Cloudflare RealtimeKit) on a VM with no media devices and no Cloudflare/Clerk credentials — prod-backend trick, Chrome fake-media flags, and multi-guest technique.
---

# Testing the kaede call UI end-to-end

The call flow is: in-world huddle/zone membership → CallDock `📞 通話に参加` → `join_group_call` SpacetimeDB procedure → RealtimeKit meeting → InCallPanel (UI-Kit components). Calls only work when the backend's `call_config` row is seeded with real Cloudflare credentials (owner SQL only).

## Devin Secrets Needed

None for guest-path testing on prod. A Cloudflare **Realtime-Admin** API token is needed only to seed `call_config` on a *local* SpacetimeDB — `HEROUI_AUTH_TOKEN` is NOT a Cloudflare token. A Clerk publishable key + member account is needed to test member-only features (recording controls) — without it the app is guest-only (`ClerkGate` renders children).

## Running against the production backend (no credentials needed)

When the local DB can't run calls, point the Vite client at prod maincloud — the schema is identical and prod's `call_config` is already seeded:

```sh
cd packages/client && VITE_SPACETIME_URI=wss://maincloud.spacetimedb.com VITE_SPACETIME_DB=kaede pnpm dev
```

Guests auto-enter the prod world. Footprint is small and self-cleaning: found a transient huddle (`ここで立ち話`), join its call, then leave both — an empty huddle auto-deletes and the RealtimeKit meeting ends when all participants leave. Flag the prod usage in the report.

## Media devices on a VM

Relaunch managed Chrome with fake devices so toggles actually function and `getDisplayMedia` auto-accepts:

```sh
chrome --use-fake-device-for-media-stream --use-fake-ui-for-media-stream ...
```

Fake camera = green test-pattern video; mic toggles fine. Install `fonts-noto-cjk` (`sudo apt install fonts-noto-cjk && fc-cache -f`) or Japanese UI renders as tofu.

## Multi-participant testing

Two guests need two separate Chrome profiles (sessionStorage is per-tab but a shared profile is fragile — `--new-window` aborts on SingletonLock with remote debugging). Launch a second instance:

```sh
chrome --user-data-dir=/tmp/chrome-profile-b --use-fake-device-for-media-stream --use-fake-ui-for-media-stream --no-first-run http://localhost:5173
```

Guest B sees a `立ち話に参加` button for A's huddle → joins → B's CallDock appears → B joins the same meeting. Verify bidirectional remote video by enabling cameras on both.

## Useful assertions

- CallDock only renders when `connected && ownGroupId` — founding/joining a huddle is the guest-accessible trigger.
- Join stages show Japanese progress copy (`通話室を準備しています…` → `通話サーバーに接続しています…`); failures show `通話に参加できませんでした`.
- In-call DOM: `rtk-grid`/`rtk-participant-tile` per participant, toggles `マイク オン/オフ`, `カメラ オン/オフ`, `画面共有`, `設定`, `退出`; dialogs via `rtk-dialog-manager` (`rtk-leave-meeting` for `通話から退出しますか？`, settings shows マイク入力/スピーカー出力/カメラ sections).
- `browser_console` dumps accumulated logs ONLY when called with the `content` parameter omitted entirely; passing any script runs it and never returns the log buffer.
- Spare Chrome processes: `pkill -f` patterns can match the shell's own cmdline and kill the exec session — write launch scripts to files and launch when 0 chrome procs remain.
