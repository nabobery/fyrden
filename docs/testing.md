# Testing Fyrden

## Tiers

| Tier | Where | Runs in | Command |
|---|---|---|---|
| Unit | `packages/{git-core,domain,api-contract,cli,testing}`, `tools/ci` | Node (plain Vitest) | `pnpm turbo run test` |
| Workerd integration | `apps/api`, `packages/adapters-cloudflare` | workerd via `@cloudflare/vitest-plugin`, with local D1, R2, KV, Queues and Durable Objects | `pnpm turbo run test` |
| Shuffle guard | workerd suites | the same, in random file and test order with several seeds | `pnpm turbo run test:shuffle` |
| Dry-run deploy | both Workers | wrangler bundling | `pnpm turbo run deploy:dry-run` |
| Local end to end | both Workers under one `wrangler dev`, with the real service binding | Node driving workerd | `pnpm turbo run test:e2e` |
| Smoke | a deployed instance | Node | `node tools/ci/src/smoke.ts <api-url> <web-url>` |

`git-core` and `domain` run under plain Node on purpose: it proves they do not
depend on the Workers runtime.

## Writing workerd tests

- **Storage is isolated per file, not per test.** Use `uniqueId()` from
  `@fyrden/testing` for every Durable Object name, R2 key and D1 row, so tests
  pass in any order. The shuffle guard catches tests that depend on order.
- Import `env` and `exports` from `cloudflare:workers`; helpers such as
  `runInDurableObject`, `evictDurableObject` and `applyD1Migrations` come from
  `cloudflare:test`.
- D1 migrations are applied by `apps/api/test/setup/apply-migrations.ts`.
- Every workerd test file captures logs (`test/setup/log-capture.ts`) and fails
  if a line contains an unredacted token.
- An error thrown inside a Durable Object and caught by the test is still
  reported by workerd as uncaught. Test-only RPC methods return errors as
  values instead.
- Mock outbound HTTP with `@msw/cloudflare` (`setupNetwork()`), not by stubbing
  `fetch`.

## Coverage and mutation testing

Coverage is Istanbul (V8 coverage does not work inside workerd). `git-core` and
`domain` have an 80% line floor. Stryker mutation testing starts with the first
`git-core` code; its score must not drop below the recorded baseline.

## Git interoperability

`@fyrden/testing/git-cli` runs a real `git` with an isolated `HOME` and fixed
author dates, so object ids are reproducible. Set `FYRDEN_GIT_BINARY` to test
a specific git build.
