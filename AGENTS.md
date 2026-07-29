# AGENTS.md

## Cursor Cloud specific instructions

`maple-like` is a single-product pnpm monorepo (a MapleStory-style 2D multiplayer game). Full setup, run, and command docs live in `README.md`; the notes below only cover non-obvious cloud caveats. Standard scripts are in the root `package.json` (`dev`, `typecheck`, `test`, `test:coverage`, `lint`, `analyze`).

### SpacetimeDB CLI binary name
The pinned CLI (`v2.7.0-hotfix3`) is installed from the GitHub release tarball into `~/.local/bin`, which ships **`spacetimedb-cli`** and `spacetimedb-standalone` — there is **no `spacetime` command**. README examples say `spacetime ...`; read those as `spacetimedb-cli ...`. `~/.local/bin` is on `PATH` via `~/.bashrc`. If the binary is missing on a fresh VM, reinstall it:

```sh
curl -sSfL -o /tmp/spacetime.tar.gz "https://github.com/clockworklabs/SpacetimeDB/releases/download/v2.7.0-hotfix3/spacetime-x86_64-unknown-linux-gnu.tar.gz"
mkdir -p "$HOME/.local/bin" && tar -xzf /tmp/spacetime.tar.gz -C "$HOME/.local/bin"
```

### Running the game end-to-end
Order matters and the backend must be running before publish:
1. `spacetimedb-cli start` — long-running host on `ws://localhost:3000` (run in its own tmux session, leave it up).
2. `spacetimedb-cli publish maple-like --server local --yes` — run from repo root (`spacetime.json` points at `packages/server`).
3. `spacetimedb-cli generate --lang typescript --module-path packages/server --out-dir packages/client/src/module_bindings --yes` — only needed if the server schema changed; committed bindings must not drift (CI enforces this).
4. `pnpm dev` — Vite client on `http://localhost:5173`. Open two browser windows to see multiplayer sync.

The client defaults to `ws://localhost:3000` and DB `maple-like` in dev, so no env vars are needed locally.

### Static analysis / testing gotcha
`fallow health` (part of `pnpm analyze` and CI) **requires** `coverage/coverage-final.json`; run `pnpm test:coverage` first if invoking `fallow` directly (`pnpm analyze` already does). `packages/server` has no unit tests — it only runs inside the SpacetimeDB host, so all testable pure logic lives in `packages/shared`.
