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

### Measured on CI (draft PR #62)

Run [43007739558](https://github.com/nabobery/fyrden/actions/runs/43007739558),
at `a2a6662`, after the fixture split and with Turbo results saved by an
earlier run of the same pull request. API inputs were unchanged since that
run; `tools/ci` was not.

| Job | Baseline median | This run |
| --- | ---: | ---: |
| One shuffle seed | 19.7 min | 16.8, 17.5 and 20.9 min (seed 1's tests all passed; a later push cancelled its job) |
| One API coverage shard (Turbo replay) | 6.8 min | 0.4 to 0.6 min |
| Merged API coverage (from replayed reports) | | 0.4 min |
| Package tests with coverage | | 0.8 min (2.7 min with an empty cache) |
| Lint, typecheck, audit, dry-run | 48 s | 0.5 min |
| End to end | 8.3 min | 8.0 min |

The first run of the changed-scope mutation matrix found no results under the
renamed nightly key: all 14 scopes started in full and held 14 runners, which
queued required jobs. Mutation now falls back to the old key until a nightly
run saves under the new one, and runs at most four scopes at a time. Jobs still
waited 4 to 6 minutes for a runner while a nightly run overlapped.

### Shuffle seeds split across four jobs each

The shuffle seed was the slowest job even after the fixture split. One seed's
pass of the API's suite (278 files) now runs as four jobs, `vitest run
--shard=<n>/4` with the pass's seed. Vitest assigns files to shards by a hash
of their path before shuffling (vitest 5.0.3, `executeTests` then
`BaseSequencer.shard`), so every file runs once a pass whatever the seed.
Checked through Vitest's own sequencer: shards of 70, 70, 69 and 69 files,
278 distinct, both projects included. The adapters' suite (30 files, 62 s
measured on CI) runs whole in each pass's first shard. A pass's seed comes
from the run id, so rerunning a shard repeats its order, and each shard prints
its reproduce command. The nightly ten seeds stay whole passes, so files of
different shards still run together there.

This raises the shuffle jobs from 3 to 12. Run
[43013999125](https://github.com/nabobery/fyrden/actions/runs/43013999125)
(`b56b9d5`; a later push cancelled four of its jobs): the shards that ran to
the end took 2.5 to 5.8 minutes each, after waits of up to 4 minutes for a
runner. The fixture split alone did not show a clear gain on CI: one seed
in the run before took 20.9 minutes, two took 16.8 and 17.5. With shuffle
split, end to end (about 7 to 8 minutes) is the longest job.

### One fewer wrangler dev start in the end-to-end tests

The two checks of `local-workers.test.ts` (the web Worker's page and health
check through the API service binding; no token in the logs for a URL React
Router cannot match) now run on the web UI suite's stack, and the file is
gone. Its wait for the error log line polled every 100 ms; `WebStack`'s
`waitForLine` resolves as the output arrives. Verified locally: the web UI
suite passes (19 tests), and with the error handler made to print the raw path
the token check fails. The end-to-end run starts 22 stacks instead of 23; the
saving is one stack's start, not measured.

## Candidate next steps

- Enforce job selection behind the existing required checks once the reports
  agree with real pull requests (plan task 5).
- Measure Vitest's worker count on the 4-vCPU runners (its default there is
  3) for the shuffle shards.
- `fsModuleCache` (vitest 5.0.3) was tried on three API files, one run each:
  34.9 s without it and 33.6 s warm; with coverage, 41.7 s and 36.1 s warm,
  and a 65 MB cache. Not adopted: no gain for shuffle runs, and coverage runs
  that Turbo cannot replay would pay the restore.
- `browseFixtures` (2.06 MiB, measured) is the next largest fixture every API
  file receives. Six files read it.
