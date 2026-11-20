---
name: delete-comment
description: Audit, categorise, and remove code comments in this repo, and migrate Decision Records into ADRs. Use when running a comment-cleanup round, when the comment ratchet (`bun run lint:comments`) fails, when deciding whether a comment may be written or must go to an ADR, or when migrating Decision Record comments into docs/adr-*.md.
---

# Delete Comment

Code comments in kaede are treated as a liability with one legitimate exception:
a **Decision Record** — the non-obvious _why_ — and even that belongs in an ADR,
not inline, once it grows past a line or two. Everything else is deleted on
sight in periodic cleanup rounds, and the comment ratchet
(`scripts/comment-ratchet.mjs`, wired into `bun run lint` as `lint:comments`)
makes the total only ever shrink.

## The five categories

Classify every comment **block** (a run of adjacent own-line comments, or one
block comment) into exactly one category:

- **Tautology** — restates what the code already says; a label with no
  information beyond the name it sits on.
  - `packages/shared/src/map.ts`: `/** y coordinate of the walkable ground
    surface (shared by every map). */` above `export const GROUND_TOP = 656;`
  - `scripts/describe-table-names.mjs`: a comment saying it builds the
    `source_name → canonical_name` table, directly above the code building it.
- **Excuse** — the comment's job is to let a hacky implementation stand
  ("acceptable", "for now", "we don't test X") where fixing it properly is
  within the project's control.
  - `packages/client/test/playerFeed.test.ts`: the fake fires `onApplied`
    synchronously, unlike the real SDK, and the comment concludes the tests
    "pin the wiring, not timing". Proper fix: make the fake fire
    asynchronously and pin the timing-dependent behaviour too.
  - `packages/client/src/game.package/touchControls.ts`: a finger sliding to
    the neighbouring button does not transfer the press — "Acceptable."
    Proper fix: hit-test on `pointermove` / revisit pointer capture.
- **Stale** — references code, symbols, versions, or a state of the world that
  no longer exists. Always re-verify against the current tree (grep the
  symbol, check the pinned version) before acting on a Stale call.
  - `packages/server/src/calls.ts`: "(the vetCallRegistration precedent)" —
    `vetCallRegistration` no longer exists; the logic lives in
    `recordingCallOf` / `recordingControlSetupIn`.
  - `packages/shared/src/auth.ts`: "see the server's CONNECTION_POLICY" —
    that symbol is gone; the policy is built by `connectionPolicyFor`.
- **Decision Record** — a non-obvious why: design rationale, invariants,
  rejected alternatives, external constraints, security reasoning.
  - `packages/shared/src/auth.ts` (`memberIssuersFor`): the production
    database trusts only the production Clerk instance because the development
    instance's sign-up is open — a dev token could otherwise seed itself as
    the first admin on an empty database.
  - `infra/alchemy.run.ts`: why the scripts pin a repo-dedicated Alchemy
    profile — a profile linked to another account makes every resource look
    foreign and produces false replace plans (an R2 data-loss path).
- **Functional** — not prose at all: tool directives whose removal changes
  behaviour. Never deleted, never counted by the ratchet.
  - `// fallow-ignore-file coverage-gaps -- <reason>` headers,
    `// oxlint-disable-next-line <rule> -- <reason>`, `// oxfmt-ignore: ...`,
    import-lint's `/** @public */` tags.

Borderline rules: a block whose _reason_ is still valid but whose _version
number_ has rotted is a Decision Record with a stale number — strip or update
the number, keep the rationale. Splitting a function to stay under the CRAP
budget is a legitimate response to a tool constraint, so comments recording
that are Decision Records, not Excuses.

## The cleanup process

1. **Extract.** Reuse the ratchet script's extractor
   (`scripts/comment-ratchet.mjs`: `@babel/parser` for TS/JS, a small scanner
   for JSONC; adjacent own-line comments group into one block) and dump every
   block in scope (`packages/*/src`, `packages/*/test`, `infra`, `scripts`,
   root config files; excluding `module_bindings`, generated output, docs)
   with file, line range, and verbatim text.
2. **Classify** every block into the five categories. Re-verify each Excuse
   and Stale claim against the current tree before trusting it.
3. **Act per category:**
   - Tautology / Stale: delete the comment.
   - Excuse: delete the comment **and** file a GitHub issue naming the hack
     and the proper fix (issues are written in Japanese in this repo).
   - Decision Record: migrate into an ADR (below). Until its theme's ADR
     lands, the comment stays — the ratchet baseline tolerates it.
   - Functional: never touch.
   - **Mixed blocks** (a stale/excuse portion inside a Decision Record block):
     edit only that portion and keep the remainder verbatim. When in doubt,
     err toward preserving the Decision Record side.
4. **Verify the deletion is comment-only.** For every modified file, the
   non-comment token stream (e.g. `@babel/parser` tokens) must be identical
   before and after. (The formatter may drop a trailing comma or separator
   when a literal reflows after its comment vanishes — that is inert.) Then
   re-run the extraction and account for every remaining block:
   Decision Records + Functional + deliberately edited mixed blocks, nothing
   else. Run the full gates: `bun run lint`, `bun run test`,
   `bun run test:coverage` and the four fallow subcommands.
5. **Regenerate the baseline in the same PR:**
   `bun scripts/comment-ratchet.mjs --write`. The baseline may only shrink —
   per-file counts decrease or entries disappear. **A PR whose baseline grows
   is wrong**: it means new prose comments were added instead of deleted.

## Migrating Decision Records into ADRs

Never one ADR per comment. Aggregate by theme into `docs/adr-<kebab-topic>.md`,
following the existing ADRs' format: title `# ADR: <the decision as a
sentence>` (Japanese), a meta block (ステータス / 対象 / 最終更新), then
numbered sections — decision, the premises it depends on, alternatives
considered, and re-evaluation triggers.

Theme map from the 2026-11-21 audit (1,029 Decision Records) — the starting
point for the migration:

- Server authority, sync, lifecycle (221) → new `adr-server-authority-and-sync.md`
- Test design and harnesses (191) → new `adr-testing-harness.md`
- Avatar, assets, game rendering (126) → supplement the existing design docs
  (`docs/avatar-rig.md`, `docs/asset-pipeline.md`, `docs/avatar-head-group.md`)
- Calls and recording / RealtimeKit (69) → new `adr-calls-and-recording.md`
- Conversation scope, chat, DM, membership (60) → new `adr-conversation-scope.md`
- Auth, connection policy, RLS (44) → supplement
  `docs/adr-auth-clerk-and-tenant-design.md`
- Complexity budgets (CRAP, clone avoidance) → new `adr-complexity-budgets.md`
- Infra: Alchemy / Effect isolation (16) → new `adr-infra-alchemy-effect.md`
- Observability → supplement `docs/adr-observability-posthog-over-sentry.md`
- **Config-file rationale (38) stays in place**: the rationale's value is
  living next to the setting it justifies; do not migrate these.

When a theme's ADR lands, delete its comments from the code and regenerate the
baseline (step 5). A one-line pointer comment is not a substitute for the ADR.

## Writing new comments

Don't. If a decision is worth recording, write or extend the ADR. The only
comments that may be added freely are Functional directives (with the reason
the repo's rules already require, e.g. fallow's `require-suppression-reason`).
If the ratchet fails on your change, the fix is to remove the comment — never
to raise the baseline.
