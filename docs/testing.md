# Testing Fyrden

## Tiers

| Tier | Where | Runs in | Command |
|---|---|---|---|
| Unit | `packages/{git-core,domain,api-contract,cli,testing}`, `tools/ci` | Node (plain Vitest) | `pnpm turbo run test` |
| Workerd integration | `apps/api`, `packages/adapters-cloudflare` | workerd via `@cloudflare/vitest-plugin`, with local D1, R2, KV, Queues and Durable Objects | `pnpm turbo run test` |
| Shuffle guard | workerd suites | the same, in random file and test order with several seeds | `pnpm turbo run test:shuffle` |
| Dry-run deploy | both Workers | wrangler bundling | `pnpm turbo run deploy:dry-run` |
| Local end to end | both Workers under one `wrangler dev`, with the real service binding; the web UI in Chromium through Playwright, every page checked with axe (WCAG 2.x A and AA); hostile Markdown and Mermaid stay inert, and no form takes a post from another origin | Node driving workerd and the browser (Playwright's Chromium must be installed: `pnpm --filter @fyrden/ci-tools exec playwright install chromium`) | `pnpm turbo run test:e2e` |
| Smoke | a deployed instance | Node | `node tools/ci/src/smoke.ts <api-url> <web-url>` |
| Git interoperability | `tools/ci/interop`: real git (and JGit) against `fyrden-api` under `wrangler dev` | Node driving git and workerd | `pnpm --filter @fyrden/ci-tools test:interop` |
| MCP conformance | `tools/ci/conformance`: the MCP conformance suite (pinned version, the 2026-07-28 requirement set) against `fyrden-api` under `wrangler dev`, with a per-check baseline of known failures, and the authorization server metadata scenario | Node driving the suite (needs network for `npx`) | `pnpm --filter @fyrden/ci-tools test:conformance` |
| REST API fuzzing | `tools/ci/schemathesis`: Schemathesis (pinned version) generates requests for every operation in the OpenAPI document (coverage, fuzzing and stateful phases) against `fyrden-api` under `wrangler dev`, with seeded data to point at; any server error or undocumented response fails | Node driving Schemathesis through `uvx` (needs uv and network) | `pnpm --filter @fyrden/ci-tools test:schemathesis` |
| Parser fuzzing | `packages/git-core/fuzz` | Node (Vitest), time-boxed | `pnpm --filter @fyrden/git-core fuzz` |
| Mutation testing | `packages/git-core`, one `src/` directory per run | Stryker | `FYRDEN_MUTATION_SCOPE=<scope> pnpm --filter @fyrden/git-core mutation` |

Pull requests and pushes to `main` run the unit, workerd, shuffle, dry-run
and end-to-end tiers, MCP conformance and REST API fuzzing (one job,
`contract`, which deploys also wait for), and the interoperability subset with
the current pinned git. Pull requests also run mutation testing
(incremental) for the `git-core` scopes they change. The nightly workflow runs
every interoperability case on every pinned git, long fuzzing budgets, and a
full mutation run of every scope.

`git-core` and `domain` run under plain Node on purpose: it proves they do not
depend on the Workers runtime.

### Test workers on a local machine

Locally, `git-core`, `adapters-cloudflare`, `apps/api` and `apps/web` run at
most two Vitest workers each; on CI (`CI` set) Vitest picks its own number.
`FYRDEN_TEST_WORKERS=<n>` overrides both, also through `pnpm turbo run`. The cap
is per package run: Turbo runs several packages' tests at the same time, so on
a machine short of memory add `--concurrency=1` to heavy runs (`test`,
`test:coverage`, `test:shuffle`), for example
`FYRDEN_TEST_WORKERS=1 pnpm turbo run test --concurrency=1`.

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
- Locally, Durable Object alarms fire on their own when they are due. A test
  that drives alarms itself (`runDurableObjectAlarm`) must keep them from firing
  on their own, for example by running the clock ahead with fake `Date` timers.
- Wait on explicit signals, never on sleeps or wall-clock polling: under a full
  parallel run, timings stretch several times. Deployed Durable Objects run other
  requests during R2 awaits, but the local pool does not, so race tests pause
  code at explicit hooks.

## Coverage and mutation testing

Coverage is Istanbul (V8 coverage does not work inside workerd). `git-core` and
`domain` have an 80% line floor.

Stryker mutation testing runs one scope, a directory under `git-core/src/`, per
run (`FYRDEN_MUTATION_SCOPE`, default `protocol`; `stryker.config.mjs` lists
the scopes). It runs the scope's tests once per mutant through Stryker's
command runner: its Vitest runner does not switch mutants under Vitest 5, and
the TypeScript 7 compiler has no API for its tsconfig rewriting. Because the
whole command runs per mutant, each scope runs a fast subset of the tests
(its own test directory without the slow git-oracle files); the full suite
still runs on every pull request. Tests run under a private `TMPDIR` that is
removed after each mutant, since `--bail` skips the tests' cleanup hooks.
Each mutant's run is also capped at 3 GB of resident memory
(`FYRDEN_MUTANT_MAX_RSS_MB`): some mutants allocate without bound (a growth
condition mutated to `true` doubles typed arrays on every call) and would
exhaust the machine, a CI runner included, long before Stryker's timeout. A
run over the cap is killed and its mutant counts as detected.

The score must not drop below the recorded baseline, which the config
enforces as `break` (the baseline rounded down; see the note under the
table). Stryker's timeout is 60 s: a mutant that makes a test wait forever
fails at Vitest's 30 s test timeout and counts as killed, so only a loop that
never yields times out (with Stryker's default, slow runs on a busy machine
were counted as timed out, that is detected, even for string-literal
mutants). Pull requests run
`--incremental` from the results the nightly full run caches: without per-test
coverage (command runner) Stryker reuses every mutant whose own code did not
change, so only the full nightly run sees a change elsewhere that weakens the
tests. When no cached results exist (before the first nightly run, or after
the cache was evicted), the pull request runs every mutant of each changed
scope instead, so the gate is never skipped.

Stryker 10 cannot instrument two TypeScript patterns safely (measured): an
`as` expression as the left operand of `|` or `&` loses its parentheses when
printed, so `(flags[i] as number) | SEEN` runs as `flags[i] as (number |
SEEN)` and the bit operation disappears; and `(x as number)++` makes the
update-operator mutator throw. Files with either are left out of their scope,
with a warning naming them, until the code avoids the pattern (a non-null
assertion or a local variable does). They are listed below.

| Scope | Baseline | Killed outright | Mutants | Not mutated (pattern above) | `break` | Recorded |
|---|---|---|---|---|---|---|
| `src/protocol` | 86.2% | 84.8% | 1,249 | | 84 | 2026-10-11 \* |
| `src/object` | 80.1% | 77.7% | 1,178 | | 77 | 2026-10-11 \* |
| `src/hash` | 89.4% | 88.3% | 751 | `sha1dc.ts` | 88 | 2026-10-11 \* |
| `src/refs` | 87.4% | 83.3% | 246 | | 87 | 2026-10-11 |
| `src/pack` | 77.7% | 74.7% | 1,924 | `crc32.ts`, `existence-filter.ts` | 77 | 2026-10-12 |
| `src/pack-write` | 68.7% | 65.2% | 1,132 | `compaction-plan.ts` | 68 | 2026-10-11 |
| `src/graph` | 67.0% | 59.3% | 570 | `bitset.ts`, `generation.ts`, `merge-base.ts`, `reachability.ts` | 59 | 2026-10-11 \* |
| `src/reader` | 74.5% | 61.4% | 581 | | 61 | 2026-10-11 \* |
| `src/receive-pack` without the push object checks † | 61.5% | 57.6% | 1,778 | | 61 | 2026-10-12 |
| `push-fsck` †: `fsck.ts`, `gitmodules.ts`, `special-names.ts`, `git-config.ts` in `src/receive-pack` | 69.7% | 66.2% | 1,631 | | 69 | 2026-10-12 |
| `src/upload-pack` | 56.0% | 55.6% | 932 | `commits.ts`, `reach.ts`, `shallow.ts` | 56 | 2026-10-11 |

The baseline counts timed-out mutants as detected, as Stryker does.
\* Measured on a busy machine with Stryker's default timeout, under which
slow runs were counted as timeouts (detected); their `break` is the share
killed outright, rounded down, until the nightly full run (60 s timeout)
re-records them. The other rows were measured with the 60 s timeout.
† `src/receive-pack` (66.4%, 61.1% killed outright, 2,831 mutants on
2026-10-11) grew past what one CI job can run (3,409 mutants, about six hours)
and was split: the push object checks became `push-fsck`, which runs only
their own tests.

## Writing git-core tests

- Tests come first (see `AGENTS.md`). Parsers get a fast-check property suite
  (encode then parse round-trips) and a fuzz test that mutates valid objects
  and expects only typed errors.
- Give every bound a fixed case too (the value at a limit, the first one
  past it). Property inputs are random, so a mutant that only they can catch
  dies in some runs and not others, and the mutation score moves with it.
- Compare with git itself wherever git can be the oracle. The object tests
  write a seeded corpus of well-formed and mutated trees, commits and tags
  with `git hash-object --literally` and require `git fsck` to report the same
  findings as `parseTree`, `parseCommit` and `parseTag`.
- Code that uses the storage ports (`PackStore`, `RefStore`, `BlockCache`,
  `MemoryBudget`) tests against the in-memory fakes from
  `@fyrden/git-core/testing`. Every implementation of a port, fake or
  Cloudflare adapter, runs the same contract suite
  (`describeRepoStoreContract` and the others) from that module.

## Git interoperability

`@fyrden/git-core/testing/git-cli` (also exported as `@fyrden/testing/git-cli`)
runs a real `git` with an isolated `HOME` and fixed author dates, so object ids
are reproducible. It can feed git's stdin and return its output as bytes. Set
`FYRDEN_GIT_BINARY` to test a specific git build.

### The interoperability matrix

`tools/ci/interop` runs cases ported from git's own test suite (git.git `t/`,
v2.53.0) against `fyrden-api` under `wrangler dev`, with one git binary per
run (`FYRDEN_GIT_BINARY`). Each case runs the same git commands against
Fyrden and against an oracle, a bare repository served by the same git's own
`upload-pack` and `receive-pack` over `file://` and configured like Fyrden
(push options advertised, `refs/pull/` hidden, fsck on receive), and compares
refs, objects, shallow boundaries and `--porcelain` output, with `git fsck`
on everything fetched. Every case gets its own token (rate limits count per
token) and repositories.

The catalogue (`tools/ci/interop/cases/`) cites the script and test name of
each case. Every test of the cited scripts is either ported or listed as not
ported with a reason (other transports, server hooks or configuration Fyrden
does not have, client-side behaviour); `tools/ci/test/interop-catalogue.test.ts`
checks that bookkeeping, and with `FYRDEN_GIT_SOURCE` pointing at a git source
tree it checks it against the scripts themselves. Scripts: `t5500-fetch-pack`,
`t5516-fetch-push`, `t5533-push-cas`, `t5537-fetch-shallow`,
`t5538-push-shallow`, `t5543-atomic-push`, `t5545-push-options`,
`t5546-receive-limits`, `t5551-http-fetch-smart`, `t5700-protocol-v1`,
`t5702-protocol-v2`, `t5704-protocol-violations`.

Cases marked `fast` form the pull request subset; `FYRDEN_INTEROP_FULL=1`
runs them all, and `FYRDEN_INTEROP_PLAN=paid` serves fetches the Paid way.
Deliberate differences from git are cases with a note: Fyrden's upload-pack
speaks protocol v2 only, does not advertise `filter`, `server-option`,
`wait-for-done` or packfile URIs, and sends only objects reachable from its
refs (git's own v2 server sends any object it has).

| git | Why | Runs |
|---|---|---|
| 2.53.0 | current release, as developers run it | every pull request (subset) and nightly (all cases, Free and Paid) |
| 2.43.7 | newest maintenance release of the 2.43 line, which Ubuntu 24.04 LTS ships ([packages.ubuntu.com](https://packages.ubuntu.com/noble/git)) | nightly |
| 2.39.5 | newest maintenance release of the 2.39 line, which Debian 12 ships ([packages.debian.org](https://packages.debian.org/bookworm/git)) | nightly |
| the runner image's git | newest release, unpinned: an early warning | nightly |

Pinned releases are built from their kernel.org tarballs, checked against the
SHA-256 in `tools/ci/interop/git-versions.txt`, by
`tools/ci/interop/build-git.sh <version> <prefix>` (CI caches the build). To
run the matrix locally against another git:

```sh
tools/ci/interop/build-git.sh 2.39.5 /tmp/git-2.39.5
FYRDEN_GIT_BINARY=/tmp/git-2.39.5/bin/git FYRDEN_INTEROP_FULL=1 \
  pnpm --filter @fyrden/ci-tools test:interop
```

A deliberately planted protocol bug (ls-refs without the `peeled` attribute,
in a copy of the repository served through `FYRDEN_INTEROP_ROOT`) failed 7
of the 27 pull request cases.

### A second protocol v2 client: JGit

isomorphic-git cannot be the second client (it has no protocol v2
upload-pack), and libgit2 has no protocol v2 client (its 1.9.7 smart
transport sends no `Git-Protocol` header and has no `ls-refs`; checked in the
source). JGit has fetched with protocol v2 by default since 5.11
([release notes](https://wiki.eclipse.org/JGit/New_and_Noteworthy/5.11)) and
pushes with v0. `tools/ci/interop/jgit/FyrdenJGit.java` is a small client over
JGit core, run as a single source file by the runner's default Java (17); the
jars (JGit 7.8.0 and its three runtime dependencies) come from Maven Central,
pinned with their SHA-256 in `jgit/jars.txt` and fetched by
`jgit/fetch-jars.sh`. `jgit.test.ts` runs nightly with the current git; set
`FYRDEN_JGIT_CLASSPATH` to run it locally.

## MCP conformance

`tools/ci/conformance/mcp.test.ts` runs the MCP conformance suite's server
scenarios for the 2026-07-28 revision (`--requirements 2026-07-28`) against a
local `fyrden-api`, through a proxy that adds a token (the suite sends none and
Fyrden's MCP server takes no anonymous request). Known failures are listed one
check at a time in `mcp-expected-failures.yml`: checks that need the suite's
own fixture tools, resources and prompts, and features Fyrden does not offer
(prompts, completion, the tasks extension, tools that ask for input). A new
failure, or a listed check that starts passing, fails the run; update the
baseline in the same change. The authorization code grant scenario needs a
person to sign in and consent, so it is not run here.

## REST API fuzzing

`tools/ci/schemathesis/rest.test.ts` runs Schemathesis against a local
`fyrden-api`, from the API's own `/api/openapi.json`. Before the run it
bootstraps a user and creates what path parameters point at: a repository
with a README, an organization with a team, and an agent. Operations that
would remove those targets (deleting or transferring the repository, deleting
the agent) get disposable ones of their own. Two checks apply:
`not_a_server_error` and `response_schema_conformance`; a 4xx the document
describes passes. The local rate limits are raised for the run (a copy of
`wrangler.jsonc` beside the original, removed afterwards), because at the
real limits most generated requests are refused with 429 before they reach an
operation; the test reads the run's HAR report and fails if any request was
rate limited. A failure prints the run's seed: rerun Schemathesis with
`--seed` to reproduce it.

## Fuzzing

The git-core tests mutate valid inputs for a fixed number of runs. The
nightly fuzzer (`packages/git-core/fuzz`) does the same for a time budget per
target: fast-check edits seed corpora (`test/corpus` packs and protocol
violations, valid protocol messages, objects from the corpus packs) with
byte flips, inserts, deletes, repeated runs, rewritten pkt-line lengths, edge
32-bit words and splices between seeds. Targets: pkt-line and side-band
readers, protocol v2 requests and advertisements, receive-pack requests and
push bodies, pack parsing, delta application, `.idx` reading, commit, tag and
tree parsing, and `.gitmodules` config parsing. Each may throw only its typed
error (the config parser and `.gitmodules` checks may not throw at all).

Bounds: inputs up to 1 MiB; each input within `FYRDEN_FUZZ_INPUT_MS` (2,000
ms by default, measured after it returns, so a parser that never returns is
caught by the job timeout); live memory (heap plus ArrayBuffers after a
garbage collection) under `FYRDEN_FUZZ_MAX_LIVE_MB` (1,024), resident memory
under `FYRDEN_FUZZ_MAX_RSS_MB` (2,048) and the heap under Node's
`--max-old-space-size=1536`; parsers run with explicit limits (a 72 MiB
memory budget for pack parsing). A finding fails the
run and writes the input to `FYRDEN_FUZZ_OUT`; `FYRDEN_FUZZ_SEED` reproduces a
run and `FYRDEN_FUZZ_SECONDS` sets the budget (10 by default, 150 nightly).

Coverage-guided fuzzing with Jazzer.js was considered and not adopted: it is a
native module built for Linux x86_64, macOS and Windows only, it does not run
TypeScript fuzz targets directly, and it integrates with Jest, not Vitest
([jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js)).
