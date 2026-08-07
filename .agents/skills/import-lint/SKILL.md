---
name: import-lint
description: Run ImportLint and fix its errors. Use when the project contains a .importlintrc.jsonc or .importlintrc.json file, when a lint run reports "Cannot import a package-private export" or "Cannot import a private export" (rule package-access), or when the user asks about package boundaries, import access, or @public/@package/@private annotations.
---

# ImportLint

ImportLint enforces directory-level encapsulation in TypeScript/JavaScript. A directory is a
"package" (unrelated to npm packages); its exports are importable only from files inside it until
an export is explicitly opened up with a JSDoc tag. It is a fast Rust CLI, a drop-in replacement
for eslint-plugin-import-access.

## Mental model

- Each export has an **importability**: `public` (importable anywhere), `package` (only within the
  same package), or `private` (nowhere, not even same-package). It is declared with a JSDoc tag
  directly above the `export`; untagged exports fall back to the config's `defaultImportability`.
- Child directories may import from ancestor packages; the reverse is a violation.
- If the config sets `packageDirectory` (glob patterns, e.g. `["**/*.package"]`), only matching
  directories are boundaries. Otherwise every directory is its own package.
- **Index loophole** (on by default): a bare re-export in a package's `index.ts` promotes that
  export one level out, to the parent package. This is the idiomatic way to expose a package's API.
- **One-hop re-export semantics**: a re-export statement's own JSDoc tag governs visibility for
  whoever imports through it. A bare (untagged) re-export resets importability to
  `defaultImportability` — even if the original export was `@public`.
- Only imports resolving to files inside the project are checked; npm packages and Node builtins
  are never flagged.

## Annotation syntax

Place directly above the `export` (case-sensitive tag names):

```ts
/** @public */
export const token = ...;   // also: @package, @private
/** @access public */        // equivalent alternate spelling
```

## Running the linter

```sh
pnpm lint:imports
pnpm lint:imports --format json
```

- Exit codes: `0` clean or warnings only, `1` at least one error, `2` invalid usage/config.
- The default `pretty` format prints nothing when clean.
- Other useful flags: `--config <path>`, `--quiet` (errors only), `--report-unresolved`,
  `--watch`, `--format github` (CI annotations).
- Config: `.importlintrc.jsonc` (or `.json`), discovered by walking up from cwd; its directory is
  the project root. Unknown config keys are a hard error (exit 2), not ignored.

## Fixing a violation

First locate the exporting file and its package boundary (the nearest ancestor directory matching
`packageDirectory`, or the file's own directory if `packageDirectory` is unset). Then pick the
first fix that fits, in this order:

1. **Move the importing file into the package** if it conceptually belongs there.
2. **Re-export through the package's `index.ts`**. This is kaede's normal public API pattern.
3. **Tag the original export `/** @public */`** only when it truly must be importable anywhere.

Do not weaken the rule, expand exclusions, or loosen `defaultImportability` to fix a violation.
After editing, rerun `pnpm lint:imports`.

### Suppression directives — do not use in kaede

Since v0.1.7 the CLI accepts ESLint-style directives
(`// import-lint-disable-next-line package-access -- reason`, or
`// import-lint-disable-line` at the end of the line). In kaede these are
**not an accepted fix**: a violation is a design issue and must be resolved
with one of the three structural fixes above. Add a directive only when the
user explicitly asks for one, and always include the ` -- reason`
justification (mirroring fallow's `require-suppression-reason` policy).
Every directive is a hole in the boundary.

## Project convention

- Every first-level `packages/*/src/*` directory is automatically a boundary; use `*.package`
  for an explicit name and for nested boundaries.
- External consumers import only from the package's `index.ts`, never from internal files.
- Package tests live outside source boundaries and are excluded from ImportLint so they may test
  package-private implementation details directly.
- Fallow owns workspace-level boundaries (`client`, `server`, `shared`); ImportLint owns
  directory-level boundaries inside those workspaces.

## Deeper documentation

The installed CLI ships documentation matching its exact version:

- `pnpm exec import-lint explain <message-id>`
- `pnpm exec import-lint docs concepts`
- `pnpm exec import-lint docs config`
- `pnpm exec import-lint docs fixing`

