import { ConnectionId, Identity, Timestamp } from 'spacetimedb';
import {
  createModuleTestHarness,
  TestAuth,
  TestClock,
  type ModuleTestHarness,
} from 'spacetimedb/server/test-utils';
import type { InferSchema } from 'spacetimedb/server';
import schema, * as moduleExports from '../src/index';
import type { Ctx } from '../src/world';

/**
 * The seam the server unit tests are written against: the official
 * SpacetimeDB module test harness (spacetimedb 2.15's
 * `spacetimedb/server/test-utils`). The real `spacetimedb/server` entry
 * cannot be imported outside a module host (it loads the host-only
 * `spacetime:sys` module), so the package's vite.config.ts registers
 * the harness's vitest plugin, which makes the module importable and
 * backs it with a portable in-process datastore.
 *
 * Everything a test touches is therefore the real thing: the committed
 * schema, real table handles (index find / insert / update / delete
 * semantics included), and a real ReducerCtx whose sender is the
 * identity the harness derives from the test auth's JWT payload — the
 * same iss+sub derivation a Clerk sign-in produces in production.
 */

export type Harness = ModuleTestHarness<InferSchema<typeof schema>>;

/** A harness on a fresh datastore, its clock pinned at `millis`. */
export function makeHarness(millis = 100_000): Harness {
  return createModuleTestHarness(schema, moduleExports, { clock: new TestClock(at(millis)) });
}

const ISSUER = 'https://clerk.kaede.town';

/**
 * An authenticated test auth for the member whose provider subject is
 * `sub`. The harness derives the sender Identity from iss+sub, so one
 * sub is one stable identity across harnesses.
 */
function authFor(sub: string): TestAuth {
  return TestAuth.fromJwtPayload(
    JSON.stringify({ iss: ISSUER, sub, exp: 9_999_999_999 }),
    ConnectionId.random(),
  );
}

/** The sender identity `sub` maps to in this harness. */
export function identityFor(harness: Harness, sub: string): Identity {
  return harness.withReducerTx(authFor(sub), (ctx) => ctx.sender);
}

/** Runs `body` as `sub` in one reducer transaction and returns its result. */
export function as<T>(harness: Harness, sub: string, body: (ctx: Ctx) => T): T {
  // The harness's ctx is the same ReducerCtx the helpers take (Ctx);
  // its expanded readonly form just does not unify with the alias, so
  // withReducerTx infers the result type from the body.
  return harness.withReducerTx(authFor(sub), body);
}

/** Runs `body` as the module itself (seeding and cross-member reads). */
export function asModule<T>(harness: Harness, body: (ctx: Ctx) => T): T {
  return harness.withReducerTx(TestAuth.internal(), body);
}

/** A Timestamp `millis` after the epoch. */
export function at(millis: number): Timestamp {
  return new Timestamp(BigInt(millis) * 1000n);
}
