# Fyrden: notes for coding agents and contributors

Fyrden is an open-source, self-hostable code forge on Cloudflare Workers. Read
this file before changing code. `CONTRIBUTING.md` covers the human process;
`docs/testing.md` covers the test tiers.

## Layout

| Path | What it is | Rule |
|---|---|---|
| `apps/api` | `fyrden-api` Worker (Hono): REST, MCP, git smart HTTP, runner protocol, all Durable Object classes in `src/do/` | Wires packages together; no business rules that belong in `domain` |
| `apps/web` | `fyrden-web` Worker (React Router SSR) | Talks to the API only through the `API` service binding and `ApiRpcContract` |
| `packages/git-core` | Pure TypeScript git engine | **No Cloudflare imports.** Storage only through ports |
| `packages/domain` | Principals, repos, PRs, issues, events | **No Cloudflare imports** |
| `packages/adapters-cloudflare` | R2, D1, Durable Object SQLite, KV, Queues implementations; logging, redaction, SSRF guard | The only package that implements ports with Cloudflare APIs |
| `packages/api-contract` | Zod operation registry → REST routes, OpenAPI, MCP tools | Every API capability is one operation here |
| `packages/cli` | `fyrden deploy`, `fyrden doctor` and `fyrden destroy` | Wraps the pinned wrangler |
| `packages/testing` | Test helpers: unique ids, log capture, SSRF cases (the git CLI sandbox and port fakes live in `@fyrden/git-core/testing`) | Test code only |
| `tools/ci` | DCO check and smoke tests run by CI | |

The import boundary for `git-core` and `domain` is enforced by Biome
(`biome.json`) and proven by `packages/testing/test/import-boundary.test.ts`.

## Commands

```sh
pnpm install
pnpm lint                       # Biome lint + format check
pnpm turbo run typecheck        # also checks generated Worker types are current
pnpm turbo run test             # unit (Node) and workerd integration tests
pnpm turbo run test:coverage    # Istanbul coverage
pnpm turbo run test:shuffle     # workerd suites in shuffled order, several seeds
pnpm turbo run deploy:dry-run   # wrangler deploy --dry-run for both Workers
pnpm turbo run test:e2e         # both Workers together locally, through the service binding
pnpm --filter @fyrden/api types # regenerate worker-configuration.d.ts after editing wrangler.jsonc
pnpm audit                      # known advisories (CI fails on high and critical)
```

## Rules

1. **Tests first in `git-core` and `domain`.** Write the failing test, see it
   fail for the right reason, then write the code. New parsers get a
   fast-check property suite.
2. **One operation, every surface.** Add an API capability as an operation in
   `packages/api-contract/ops/` with a permission from the table in
   `packages/domain/src/authz/permissions.ts` and allowed principal types,
   and a handler in `apps/api/src/ops/handlers.ts`. REST, MCP and OpenAPI come
   from it; never add a hand-written route for an API capability. A handler
   checks a repository permission itself (`canAccess`), and a repository
   operation needs an input in `apps/api/test/authz.repo-operations.test.ts`.
3. **Schema changes are forward-only.** Durable Object schemas are lists of
   numbered migrations (`apps/api/src/do/schema/`); never edit a released
   migration. Destructive steps must be marked as contract steps. D1 changes
   are new numbered files in `apps/api/migrations/`. Update the committed
   expected schema snapshot and add a fixture for each released version.
4. **Never log secrets.** Use the logger from `@fyrden/adapters-cloudflare/obs`;
   wrap secret values with `secret()`. Integration tests fail if any log line
   contains an unredacted token.
5. **Outbound fetches of user-supplied URLs go through `guardedFetch`** in
   `@fyrden/adapters-cloudflare/net`. No exceptions.
6. **Workerd tests share storage within a file.** Use `uniqueId()` for every
   Durable Object name, key and row a test touches.
7. **Dependencies are pinned and reviewed.** Shared tools go in the
   `catalog:` of `pnpm-workspace.yaml` as exact versions; never add a range.
   The supply-chain settings there (release age, trust policy, reviewed
   build scripts) stay on: when one blocks an install, investigate and, if
   the package is fine, add a narrow, dated exception with the reason
   (see `trustPolicyExclude`) instead of loosening the setting. Upgrade
   pinned versions in a dedicated change.
8. **Facts need a source.** In docs and comments, mark platform facts as
   measured, verified (with a link) or unverified.
9. **Sign off every commit**, merges included (`git commit -s`, see `CONTRIBUTING.md`). The person
   who submits a change signs off on it and is responsible for it, whoever or
   whatever wrote it.

## Reviews

Every change gets an adversarial review before merge. A review prompt names
the task and the decisions not to relitigate, the exact diff scope, and asks
for: correctness, edge cases (empty input, boundaries, concurrency, retries),
performance, security, maintainability and repo conventions; completeness
(all callers, docs, tests) and leftover cleanup; concrete attempts to break the
change; whether the tests prove what they claim. Findings come with severity
(BLOCKER, SHOULD-FIX, NIT), file and line, a failure scenario and a fix, and
are verified against the code before anyone acts on them.
