# CI performance

What makes Fyrden's CI slow, what was changed to speed it up, and how each
claim was measured. Record new measurements here with their commands, so the
next change starts from evidence rather than estimates.

## Baseline (pull requests, 2026-11-05 to 2026-11-11)

Measured from GitHub Actions job timestamps of 57 successful first-attempt
pull request runs. These jobs overlap, so their medians do not add up to the
run's duration.

| Measured | Median |
| --- | ---: |
| Whole successful pull request run | 25.1 min (15.9 min on 2026-10-11 to 14) |
| One shuffle seed (the slowest job in all 57 runs) | 19.7 min |
| End to end | 8.3 min |
| One API coverage shard | 6.8 min |
| Lint, typecheck, audit, dry-run | 48 s |

A cold mutation run of the `blame` scope (no cached baseline) ran all 2,367
mutants in about 218 minutes. Mutation is not a required check.

## Changes and their evidence

### API fixtures sent only to the files that read them

The Cloudflare Vitest pool sends every value a global setup provides with each
test file it runs, serialized (verified in `@cloudflare/vitest-plugin`
1.4.12, `send()` in `dist/pool/index.mjs`). A project also receives the root
project's values (verified in vitest 5.0.3, `TestProject.getProvidedContext`).
`apps/api` provided 25.21 MiB to each of its 278 files (measured), 23.02 MiB
of it the chunked upload and import fixtures that two files read.

The chunked fixtures now live in a Vitest project of their own, `api-chunked`.
Measured with the Vitest Node API after a run: the `api` project's provided
context is 2.19 MiB per file, `api-chunked`'s 23.03 MiB for its 2 files. That
is about 0.65 GB serialized per full pass instead of about 7.0 GB.

`vitest list --filesOnly --json` gives the same 278 files before and after,
each in exactly one project.

Local full run, one fixed seed, 10-core laptop, `CI=1 FYRDEN_TEST_WORKERS=4`,
each variant once, with other light work on the machine (directional only):

```sh
pnpm --filter @fyrden/api exec vitest run --sequence.shuffle.files --sequence.shuffle.tests --sequence.seed=683778754
```

| Config | Files | Tests | Duration |
| --- | ---: | ---: | ---: |
| Before (one project) | 278 passed | 3,805 passed | 378 s |
| After (two projects) | 278 passed | 3,805 passed | 297 s |

Not yet measured: the saving on a hosted runner. Compare three runs of each
on the same runner class before quoting a CI number.

### Turbo task results kept between runs

`.github/actions/turbo-cache` restores `.turbo/cache` for the static, package,
API shard and end-to-end (web build only) jobs, keyed by runner OS,
architecture, Node version and job. Turbo's task hashes decide what replays.
Before saving, `tools/ci/src/prune-turbo-cache.ts` keeps only the entries
this job's runs used (from `TURBO_RUN_SUMMARY` summaries), so the archive does
not grow with every run. A failed job saves nothing.

Verified locally: a pruned cache still replays every task of the run that
wrote it (2 of 2 cached). An audit of test reads outside their package found
three undeclared inputs, now in `apps/api/turbo.json`, `apps/web/turbo.json`
and `packages/cli/turbo.json`.

Not yet measured: hit rates, archive sizes and restore times on CI.

### Mutation runners only for changed scopes, with pull request baselines

The `detect` job lists the scopes a pull request changed
(`tools/ci/src/select-mutation.ts`). The matrix gets only those, so a pull
request that changes no scope uses no mutation runner instead of 14. A passing
scope saves its incremental results for the pull request's next push. A
restore prefers those, then the nightly run's results.

The nightly key changed to `mutation-nightly-v1-<scope>:`. The old prefix
`mutation-incremental-pack-` also matched `pack-write`'s entries.

### Job selection, report only

`tools/ci/src/select-ci.ts` reports in the `detect` job summary which jobs a
pull request needs, from its changed paths and Turbo's `--affected` graph.
Every job still runs. Compare its reports with real pull requests
(documentation, web, API, shared package, dependency and CI changes) before
any job is skipped on its word.

## Candidate next steps

- Enforce job selection behind the existing required checks once the reports
  agree with real pull requests (plan task 5).
- Re-measure shuffle seeds on CI after the fixture change, then decide whether
  shuffle needs sharding (plan task 8).
- Vitest reports module transforms at a third of the API run's tracked time,
  redone each run. `fsModuleCache` (vitest 5.0.3, off by default) could keep
  them between runs if CI saves its directory. Not yet tried.
- `browseFixtures` (2.06 MiB, measured) is the next largest fixture every API
  file receives. Six files read it.
