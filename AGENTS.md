# AGENTS.md

## Project direction (read first)

This project has pivoted from a game MVP to **kaede**, a MapleStory-style 2D side-scrolling **work collaboration tool** (a virtual office replacing oVice for a small community, with future SaaS ambitions). Before starting any task, read:

- `docs/VISION.md` — product vision, target users, and all settled technical decisions (auth, video calls, art pipeline, scope exclusions)
- `docs/ROADMAP.md` — phase ordering, per-phase goals and completion criteria, and the oVice-migration milestone

Do not add gameplay features (combat, mobs, XP); that direction was abandoned (PR #2 closed). Update `docs/ROADMAP.md` via PR when a phase completes or the plan changes.

## Cursor Cloud specific instructions

`maple-like` is a single-product pnpm monorepo (a MapleStory-style 2D multiplayer game). Full setup, run, and command docs live in `README.md`; the notes below only cover non-obvious cloud caveats. Standard scripts are in the root `package.json` (`dev`, `typecheck`, `test`, `test:coverage`, `test:e2e`, `lint`, `lint:imports`, `analyze`).

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

`pnpm test:e2e` runs the Playwright smoke tests (`packages/e2e`) and only needs steps 1–2: Playwright boots the Vite dev server itself. Install browsers once with `pnpm --filter @maple/e2e exec playwright install --with-deps chromium`. The guest-admission spec shells out to the CLI (`sql`), whose binary name defaults to `spacetime`; on this VM run `SPACETIME_BIN=spacetimedb-cli pnpm test:e2e` (CI sets the same variable in `ci.yml`).

### Merging checklist
Before merging a PR, check the review feedback the GitHub apps left on the PR
itself — `gh api repos/<owner>/<repo>/pulls/<n>/comments` (inline findings by
`cursor[bot]`, i.e. Bugbot) and `.../pulls/<n>/reviews` — and address or
explicitly assess every finding. These are separate from any review loop run
locally and are easy to miss because they arrive asynchronously after a push.

### Static analysis / testing gotcha
`fallow health` (part of `pnpm analyze` and CI) **requires** `coverage/coverage-final.json`; run `pnpm test:coverage` first if invoking `fallow` directly (`pnpm analyze` already does). `packages/server` has no unit tests — it only runs inside the SpacetimeDB host, so all testable pure logic lives in `packages/shared`.

Before pushing, also run `pnpm exec fallow health` **standalone**: CI runs it as
its own step, and a passing `pnpm analyze` does not guarantee that step passes —
PR #30 hit exactly this (a new file missing its `fallow-ignore-file
coverage-gaps` header failed only the CI `fallow health` step). Every new file
that cannot be unit-tested (reducers, live-connection wiring, DOM components,
Playwright specs) needs that header with a reason naming where the testable
logic lives.

### Internal package boundaries
ImportLint enforces directory-level encapsulation inside each workspace; fallow continues to
enforce the workspace-level `client` / `server` / `shared` dependency graph.

- Every first-level `packages/*/src/*` directory is automatically a boundary; use the
  `*.package` suffix to make boundaries explicit and for nested packages.
- Package-private exports are the default. Expose the intended API through the package's
  `index.ts`; external consumers must import from that index, never an internal file.
- Use `/** @public */` only when an export genuinely needs unrestricted project-wide access.
- Run `pnpm lint:imports` after moving files or changing imports. `pnpm lint` runs both Biome and
  ImportLint.
- Tests are excluded so they may import package-private implementation details directly.
- Read `.agents/skills/import-lint/SKILL.md` before fixing ImportLint diagnostics.

<!-- stripe-projects-cli managed:agents-md:start -->
## Stripe Projects CLI

This repository is initialized for the Stripe project "kaede".

## Tools used

- [Stripe CLI](https://docs.stripe.com/stripe-cli) with the `projects` plugin to manage third-party services, credentials, and deployments for this project. Use the stripe-projects-cli to manage deploying and access to third party services.
<!-- stripe-projects-cli managed:agents-md:end -->
