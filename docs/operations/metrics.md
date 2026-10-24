# Metrics

Fyrden writes its metrics to [Workers Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/),
in the dataset `fyrden_metrics` of the account it is deployed to. This page
lists every metric, how it is laid out in the dataset, and example queries for
push and clone dashboards. Limits referred to here are described in
[limits.md](limits.md).

## Layout

A data point has this layout:

| Column | Holds |
|---|---|
| `index1` | The metric name, for example `git.push`. Never a value from a request, so Analytics Engine samples each metric on its own |
| `blob1` … `blobN` | The metric's dimensions, in the order listed below (`blob1` is the first) |
| `double1` | The value: 1 for a plain count, otherwise the amount (bytes, calls, milliseconds) |
| `timestamp` | When the point was written |
| `_sample_interval` | How many events the row stands for when Analytics Engine has sampled the data |

Analytics Engine may sample rows. Always weight by `_sample_interval`:
`SUM(_sample_interval * double1)` for totals, `SUM(_sample_interval)` for event
counts, and `quantileExactWeighted(q)(double1, _sample_interval)` for
quantiles ([sampling](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/#sampling)).
Data is kept for three months, and one invocation can write at most 250 data
points ([platform limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)).

So that a large push or a ref listing of a repository with many tags stays
under that limit, Fyrden combines points within one invocation (a Worker
request, a Durable Object method or alarm, a Tail batch) and writes them when
it ends:

- **Counters** (most metrics): one point per metric and dimensions, whose
  `double1` is the sum. Count events with `SUM(_sample_interval * double1)`,
  not `SUM(_sample_interval)`.
- **Gauges** (`git.repo.packs`, `git.repo.bytes`): one point per invocation
  with the latest value.
- **Samples** (`subrequests`, `do.active_ms`, `worker.cpu_ms`,
  `worker.wall_ms`): one point each, as before, for quantiles.

One invocation writes at most 200 points. Points past that are dropped and
counted in `metrics.dropped`; a metrics write never fails the operation.

## Engine metrics

### Per invocation

| Metric | Dimensions (`blob1`, `blob2`, …) | Value |
|---|---|---|
| `subrequests` | `where` (`worker` or `do`), `budget` (`internal` or `external`), `op` | Calls one invocation made against one subrequest budget, written once when the invocation ends. `internal` is R2, D1 and Durable Object calls; `external` is outbound `fetch` and Cache API calls. For the Worker, `op` is the method and route pattern (`POST /:owner/:repo/git-receive-pack`) and the count includes calls made while a response streams; for a Durable Object it is the method (`runPush`, `planFetch`, `alarm`, …). A budget the invocation did not use writes no point |
| `do.active_ms` | `class`, `method` | Wall time of one Durable Object invocation (an RPC method or the alarm), in milliseconds: a proxy for the object's billed active time. The runtime's clock advances only on I/O, so time spent computing after the last I/O is not included, and overlapping invocations of one object are each counted |
| `worker.cpu_ms` | `script`, `entrypoint`, `event`, `method`, `outcome` | CPU time of one invocation, in milliseconds, from the platform's Tail events. `entrypoint` is the Durable Object class (empty for the Worker itself); `event` is `fetch`, `rpc`, `alarm`, `queue`, `scheduled` or `other`; `method` is the RPC method name for `rpc`; `outcome` is the platform's (`ok`, `exceededCpu`, `exception`, …) |
| `worker.wall_ms` | as `worker.cpu_ms` | Wall time of the same invocation |
| `metrics.dropped` | `where`, `op` (as for `subrequests`; `op` is `tail` for a Tail batch) | Data points the invocation could not write: over its budget of 200, or refused by Analytics Engine. Any point other than zero means the metrics of that invocation are incomplete |

Workers report CPU time to Tail handlers only, not to the running code.
`fyrden-web` is `fyrden-api`'s Tail consumer and writes `worker.cpu_ms` and
`worker.wall_ms`. Tail Workers need the Workers Paid plan
([platform docs](https://developers.cloudflare.com/workers/observability/logs/tail-workers/)),
so on Free there are no CPU metrics. Whether Durable Object invocations
appear in Tail events alongside the Worker's has not been checked on a
deployment yet.

### Per repository

| Metric | Dimensions | Value |
|---|---|---|
| `git.repo.packs` | `repo` (repository id), `group` | Number of packs in the group |
| `git.repo.bytes` | `repo`, `group` | Bytes of those packs (`.pack` files; their indexes are not included) |

Both are gauges: they are written once by each invocation that commits (push,
import, upload session) and by every alarm run (where maintenance happens),
for every group, zeros included, with the values when the invocation ends.
The latest point of a group is its current value.

| `group` | Packs |
|---|---|
| `live_own` | The repository's own live packs: the ones every fetch reads and the pack-count cap limits |
| `live_borrowed` | Live packs shared from the repository's fork network |
| `pending` | Pushes and uploads not committed yet |
| `superseded` | Replaced by a repack, kept for the retention period |
| `garbage` | Unreachable objects, kept until their time to live ends |
| `condemned` | Waiting for deletion |
| `discarded` | Failed or abandoned uploads, waiting for cleanup |
| `fetch` | Stored fetch responses (regenerated or framed packs) |

### Git operations

| Metric | Dimensions | Value |
|---|---|---|
| `git.push` | `outcome` (`committed`, `partial`, `rejected`, `refused`, `failed`), `what` (`pushes`, `objects`, `bytes`, `refs`) | Per finished push: 1 for `pushes`, else the amount |
| `push.version_retry` | `class` | Per commit attempt of a push tried again because another push to the repository (any branch) committed first |
| `git.pack_cap` | `outcome` (`within`, `merged`, `refused_budget`, `refused_leased`) | Push commits checked against the pack-count cap (a push without `--atomic` commits once per ref) |
| `git.fetch` | `request` (`clone`, `fetch`, `negotiate`, `refused`), `plan` (`as-is`, `stitched`, `regenerated`, `none`), `mode` (`stored`: Free serving, `transport`: Paid serving), `cached` (`true`, `false`) | 1 per fetch request |
| `git.fetch.bytes_out` | `mode` | Response bytes sent for one fetch |
| `git.fetch.calls` | `where` (`worker`, `do`), `kind` (`r2`, `cache_api`) | R2 and Cache API calls one fetch made |
| `git.fetch.blocks` | `tier` (`memory`, `cache_api`, `miss`) | Pack block reads of one fetch plan, by the cache tier that answered (`miss`: read from R2) |
| `git.maintenance` | `job` (`repack`, `gc`, `reachability`, `retire`), `what` | Amounts per maintenance step (`bytes_in`, `bytes_out`, `objects`, `packs_in`, `packs_out`, `garbage_objects`, `garbage_bytes`, `condemned`, `deleted`, `deleted_bytes`, `expired_fetch`, `stale_output`, `all_reachable`, `slices`, `restarts`) |
| `git.reaped` | `what` (`upload`, `pack`, `scratch`, `object`, `abort_failed`) | Items the cleanup of abandoned uploads removed |

### Effects

| Metric | Dimensions | Value |
|---|---|---|
| `effects.recover` | `outcome` (`ok`, `error`) | 1 per run of the effects cron's recovery (sending overdue effects to their queue again, and deleting effects past retention) |
| `webhooks.reconcile` | `outcome` (`ok`, `error`) | 1 per run of the effects cron's webhook reconciliation (late sends, dead claims, hooks to turn off, expired deliveries) |
| `effects.dispatch` | `outcome` (`ok`, `error`) | 1 per events consumer invocation that sent effects to their queues or delivered some itself |
| `effects.consume` | `sink`, `outcome` (`ok`, `error`) | 1 per effects queue invocation (`error`: an outcome could not be recorded, or what was left could not be sent back; its messages are retried) |
| `effects.recovered` | `sink` | Overdue effects the cron sent to their queue again (a message lost or never sent, or a claim that died) |
| `effects.invalidated` | `sink` | Effects ended without delivery because their source was deleted, restored to an earlier state, or transferred since (unless the effect stands across transfers: a settlement of review requests, or any of a sink whose effects all do) |
| `effects.failed` | `sink` | Effects that failed for good: their attempts spent (a claim counts as one), their sink gone, or ended by their sink (a feed page past its delivery deadline, gone, or not what its event names) |
| `feed.audience_dropped` | — | Recipients an event named past the 100 it carries and its 128 pages (the value is the amount; the bounds keep every event within them) |
| `feed.participants_overflow` | — | Joins a thread refused at its cap of 1,000 participants, by principals not already participating |
| `code_owners.request_skipped` | `reason` | Code owners not asked to review: `team_too_large` (a team with more members than one request asks; never asked), `reviewers` (more reviewers that can matter than one read covers; asked again once a review changes) |
| `webhooks.stage_ms` | `stage` (`rows`, `body`, `claim`, `hooks`, `hook`, `body_read`, `post`, `record`) | Wall time of one stage of making webhook deliveries, in milliseconds, one point each. An event's effect writes `rows` (its deliveries' rows and which wait), `body` (storing it), `claim` (the tombstone and its first attempts' claims) and `hooks` (their hooks, in one call) once, then `post` (address lookup, request and the answer's excerpt) and `record` per first attempt; a queued attempt writes `claim`, `hook`, `body_read`, `post` and `record`. First attempts run side by side, so their stages overlap. The runtime's clock advances only on I/O. The effect also logs these times in one line (`webhooks.materialize`), with how long it took in all |
| `feed.stage_ms` | `stage` (`pages`, `calls`) | Wall time of one stage of a batch of feed deliveries, in milliseconds, one point each: `pages` (reading its audience pages from their repositories, when it has any) and `calls` (the calls to recipients' feeds, up to 32 under way at once). The batch also logs these times in one line (`feed.deliver`), with its effects, pages and calls |

Any `error` means effects are not being sent, claimed or delivered: the
failure is logged at error level (`op` `cron.effects`, `effects.dispatch`
or `effects.consume`), and the effects stay pending; the effects cron sends
them again once overdue. `GET /healthz` reports how late the oldest pending
effect is (`checks.effects.overdueS`), and whether one failed for good in
the last hour (`checks.effects.failed`); either makes `checks.effects.ok`
false.

### Cost counters

| Metric | Dimensions | Value |
|---|---|---|
| `r2.class_a` | `bucket`, `op` | R2 Class A operations (writes, multipart, deletes) |
| `r2.class_b` | `bucket`, `op` | R2 Class B operations (reads) |
| `do.request` | `class`, `method` | Calls to a Durable Object |
| `do.rows_written` | `class`, `op` | Durable Object SQLite rows written (the billed unit) |
| `d1.query` | `db`, `op` | D1 statements |
| `queue.send` | `queue` | Queue messages sent (an outbox drain sends one per batch of events) |
| `http.request` | `route`, `method`, `status` | One per HTTP request |
| `auth.token` | `type`, `outcome` | One per token check |
| `acl.snapshot` | `purpose` (`read` or `write`), `outcome` (`cached`, `pulled`, `denied`: no usable snapshot, and the pull failed or was refused) | One per access decision a repository object makes from its ACL snapshot |
| `acl.snapshot_age_ms` | `purpose` | Age of the snapshot that decision used, in milliseconds (one point per decision; its maximum is the snapshot staleness bound in practice: at most 60 s for writes, 5 minutes for reads) |

`r2.*`, `do.request` and `d1.query` are also what the `internal` budget of
`subrequests` counts. A D1 batch is counted once per statement here, while the
platform counts it once, so the `internal` figure can be slightly higher than
the platform's count.

## Querying

Queries go to the Analytics Engine SQL API with an API token that has
**Account Analytics: Read**
([SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)):

```sh
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $API_TOKEN" \
  --data-binary @query.sql
```

The queries below use the [SQL reference](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/)'s
functions (`toStartOfInterval`, `quantileExactWeighted`, `argMax`). Adjust the
time windows to taste. Analytics Engine may take a minute or so to show new
points.

### Push dashboard

Pushes per hour by outcome:

```sql
SELECT
  toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hour,
  blob1 AS outcome,
  SUM(_sample_interval * double1) AS pushes
FROM fyrden_metrics
WHERE index1 = 'git.push' AND blob2 = 'pushes'
  AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY hour, outcome
ORDER BY hour
```

Bytes and objects received:

```sql
SELECT
  blob2 AS what,
  SUM(_sample_interval * double1) AS amount
FROM fyrden_metrics
WHERE index1 = 'git.push' AND blob1 = 'committed' AND blob2 IN ('bytes', 'objects', 'refs')
  AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY what
```

Subrequests per push request in the Worker, against the budgets (50 external
and 1,000 internal on Free; 10,000 on Paid):

```sql
SELECT
  blob2 AS budget,
  max(double1) AS max_calls,
  quantileExactWeighted(0.99)(double1, _sample_interval) AS p99_calls,
  SUM(_sample_interval) AS invocations
FROM fyrden_metrics
WHERE index1 = 'subrequests' AND blob1 = 'worker'
  AND blob3 = 'POST /:owner/:repo/git-receive-pack'
  AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY budget
```

Durable Object time and calls per push step:

```sql
SELECT
  blob2 AS method,
  SUM(_sample_interval) AS invocations,
  SUM(_sample_interval * double1) AS total_ms,
  quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms
FROM fyrden_metrics
WHERE index1 = 'do.active_ms' AND blob1 = 'RepoDO'
  AND blob2 IN ('runPush', 'pushStatus', 'finalizePush', 'completeChunked', 'alarm')
  AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY method
ORDER BY total_ms DESC
```

```sql
SELECT
  blob3 AS method,
  blob2 AS budget,
  max(double1) AS max_calls,
  SUM(_sample_interval * double1) AS total_calls
FROM fyrden_metrics
WHERE index1 = 'subrequests' AND blob1 = 'do'
  AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY method, budget
ORDER BY max_calls DESC
```

R2 operations by kind:

```sql
SELECT
  index1 AS metric,
  blob2 AS op,
  SUM(_sample_interval * double1) AS operations
FROM fyrden_metrics
WHERE index1 IN ('r2.class_a', 'r2.class_b') AND blob1 = 'fyrden-git'
  AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY metric, op
ORDER BY operations DESC
```

Pack-count cap at push time:

```sql
SELECT
  blob1 AS outcome,
  SUM(_sample_interval * double1) AS commits
FROM fyrden_metrics
WHERE index1 = 'git.pack_cap' AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY outcome
```

### Clone dashboard

Fetches by kind, plan and serving mode:

```sql
SELECT
  blob1 AS request,
  blob2 AS plan,
  blob3 AS mode,
  SUM(_sample_interval * double1) AS fetches
FROM fyrden_metrics
WHERE index1 = 'git.fetch' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY request, plan, mode
ORDER BY fetches DESC
```

Bytes served:

```sql
SELECT
  toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hour,
  SUM(_sample_interval * double1) AS bytes_out
FROM fyrden_metrics
WHERE index1 = 'git.fetch.bytes_out' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY hour
ORDER BY hour
```

Subrequests per fetch request (Worker) and per fetch plan (Durable Object):

```sql
SELECT
  blob1 AS side,
  blob2 AS budget,
  max(double1) AS max_calls,
  quantileExactWeighted(0.99)(double1, _sample_interval) AS p99_calls
FROM fyrden_metrics
WHERE index1 = 'subrequests'
  AND blob3 IN ('POST /:owner/:repo/git-upload-pack', 'planFetch', 'lsRefs')
  AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY side, budget
```

Block cache effectiveness:

```sql
SELECT
  blob1 AS tier,
  SUM(_sample_interval * double1) AS blocks
FROM fyrden_metrics
WHERE index1 = 'git.fetch.blocks' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY tier
```

### CPU (Paid only)

CPU per invocation of `fyrden-api` and its Durable Objects:

```sql
SELECT
  blob2 AS entrypoint,
  blob3 AS event,
  blob4 AS method,
  SUM(_sample_interval) AS invocations,
  quantileExactWeighted(0.5)(double1, _sample_interval) AS p50_cpu_ms,
  quantileExactWeighted(0.99)(double1, _sample_interval) AS p99_cpu_ms,
  max(double1) AS max_cpu_ms
FROM fyrden_metrics
WHERE index1 = 'worker.cpu_ms' AND blob1 = 'fyrden-api'
  AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY entrypoint, event, method
ORDER BY p99_cpu_ms DESC
```

Invocations stopped for CPU:

```sql
SELECT
  blob2 AS entrypoint,
  blob3 AS event,
  SUM(_sample_interval) AS invocations
FROM fyrden_metrics
WHERE index1 = 'worker.cpu_ms' AND blob5 = 'exceededCpu'
  AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY entrypoint, event
```

### Storage

Current own live pack count and storage of the largest repositories:

```sql
SELECT
  blob1 AS repo,
  argMax(double1, timestamp) AS live_bytes,
  max(timestamp) AS as_of
FROM fyrden_metrics
WHERE index1 = 'git.repo.bytes' AND blob2 = 'live_own'
  AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY repo
ORDER BY live_bytes DESC
LIMIT 20
```

```sql
SELECT
  blob1 AS repo,
  argMax(double1, timestamp) AS live_packs
FROM fyrden_metrics
WHERE index1 = 'git.repo.packs' AND blob2 = 'live_own'
  AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY repo
ORDER BY live_packs DESC
LIMIT 20
```

A repository not written to in the window has no row; widen the window to
find it. Sampled rows can hide the newest point of a rarely written group.
