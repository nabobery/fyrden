import {
  countSubrequests,
  currentInvocation,
  type MetricAggregation,
  type SubrequestBudget,
  writeOutsideInvocation,
} from "./invocation.js";

/**
 * Typed product and cost counters written to Analytics Engine. Every feature
 * counts the billable operations it makes (D1, R2, Durable Object, queue), so
 * per-deployment cost can be reported. A counter is added with the first
 * feature that emits it.
 *
 * Data point layout: index = metric name; blobs = dimensions in a fixed order;
 * doubles[0] = value. The index is always the metric name, never a value from
 * a request, so Analytics Engine samples each metric on its own; ids such as
 * a repository id go in blobs. Public reference: docs/operations/metrics.md.
 *
 * Inside a measured invocation (`Invocation`), points are combined per
 * metric and dimensions and written once when it ends, within a budget
 * below Analytics Engine's per-invocation limit (`METRIC_AGGREGATION`,
 * `METRIC_POINT_BUDGET`). A metrics write never throws into the caller.
 */
export const METRICS = {
  "http.request": ["route", "method", "status"],
  "r2.class_a": ["bucket", "op"],
  "r2.class_b": ["bucket", "op"],
  "do.rows_written": ["class", "op"],
  "do.request": ["class", "method"],
  "d1.query": ["db", "op"],
  // Queue messages sent (Queues bill per 64 KB of a message).
  "queue.send": ["queue"],
  "auth.token": ["type", "outcome"],
  // ACL snapshots in a repository object: purpose = read | write; outcome
  // = cached | pulled | denied.
  "acl.snapshot": ["purpose", "outcome"],
  // Age of the snapshot an access decision used, in milliseconds.
  "acl.snapshot_age_ms": ["purpose"],
  // Orphan reaper: what = upload | pack | scratch | object | abort_failed.
  "git.reaped": ["what"],
  // Fetch responses: request = clone | fetch | negotiate | refused; plan =
  // as-is | stitched | regenerated | none; mode = stored | transport.
  "git.fetch": ["request", "plan", "mode", "cached"],
  "git.fetch.bytes_out": ["mode"],
  // Calls one fetch request made, by where (worker | do) and kind (r2 | cache_api),
  // for the per-invocation subrequest budgets.
  "git.fetch.calls": ["where", "kind"],
  // Pack block reads of one fetch plan, by the tier that answered them
  // (memory | cache_api | miss: read from R2).
  "git.fetch.blocks": ["tier"],
  // Pushes: outcome = committed | partial | rejected | refused | failed;
  // what = pushes | objects | bytes | refs (the value is the amount).
  "git.push": ["outcome", "what"],
  // A push's commit tried again because another push (to any branch) committed first.
  "push.version_retry": ["class"],
  // Repack and garbage collection: job = repack | gc | reachability | retire;
  // what = bytes_in | bytes_out | objects | packs_in | packs_out | garbage_objects |
  // garbage_bytes | condemned | deleted | deleted_bytes | expired_fetch | stale_output |
  // all_reachable | slices | restarts (the value is the amount).
  "git.maintenance": ["job", "what"],
  // The pack-count cap at a commit: outcome = within | merged | refused_budget | refused_leased.
  "git.pack_cap": ["outcome"],
  // Per repository, written after every commit and every alarm run: packs
  // and their bytes (.pack files only) by group = live_own | live_borrowed |
  // pending | superseded | garbage | condemned | discarded | fetch. Every
  // group is written each time (zeros too), so the latest point is the value.
  "git.repo.packs": ["repo", "group"],
  "git.repo.bytes": ["repo", "group"],
  // Calls one invocation made against one subrequest budget, written once
  // when it ends: where = worker | do; budget = internal (R2, D1, Durable
  // Object calls) | external (outbound fetch and Cache API); op = the route
  // pattern (Worker) or method (Durable Object).
  subrequests: ["where", "budget", "op"],
  // Wall time of one Durable Object invocation (RPC method or alarm), in ms:
  // a proxy for billed active time. The clock advances only on I/O.
  "do.active_ms": ["class", "method"],
  // CPU and wall time of one invocation, in ms, from Tail events (the only
  // place the platform reports CPU): script, entrypoint (Durable Object
  // class or empty), event = fetch | rpc | alarm | queue | scheduled | other,
  // method (RPC method or empty), outcome.
  "worker.cpu_ms": ["script", "entrypoint", "event", "method", "outcome"],
  "worker.wall_ms": ["script", "entrypoint", "event", "method", "outcome"],
  // Data points one invocation could not write: over its budget, or
  // refused by Analytics Engine. Written once, by the invocation (where,
  // op as for `subrequests`), when it ends.
  "metrics.dropped": ["where", "op"],
} as const satisfies Record<string, readonly string[]>;

export type MetricName = keyof typeof METRICS;

/**
 * Metrics whose points do not add up within an invocation (every other
 * metric is a counter: `sum`). Gauges keep their latest value; samples keep
 * one point per event, as their quantiles are queried.
 */
export const METRIC_AGGREGATION: Partial<Record<MetricName, MetricAggregation>> = {
  "git.repo.packs": "last",
  "git.repo.bytes": "last",
  subrequests: "each",
  "do.active_ms": "each",
  "acl.snapshot_age_ms": "each",
  "worker.cpu_ms": "each",
  "worker.wall_ms": "each",
  "metrics.dropped": "each",
};
export type MetricDimensions<N extends MetricName> = Record<(typeof METRICS)[N][number], string>;

export interface Metrics {
  count<N extends MetricName>(name: N, dimensions: MetricDimensions<N>, value?: number): void;
}

/**
 * The cost counters that are also subrequests, by the per-invocation budget
 * they count against (measured on Workers Free, 2026-10-10: R2, D1 and
 * Durable Object calls share the 1,000 calls to internal services; outbound
 * fetch and the Cache API share the 50). External calls are counted where
 * they are made (`countSubrequests`), as they have no cost counter.
 */
export const SUBREQUEST_BUDGETS: Partial<Record<MetricName, SubrequestBudget>> = {
  "r2.class_a": "internal",
  "r2.class_b": "internal",
  "d1.query": "internal",
  "do.request": "internal",
};

/**
 * Metrics written to `dataset`: held and combined in the current invocation,
 * or written at once outside any. A failed write is counted, never thrown.
 */
export function createMetrics(dataset: AnalyticsEngineDataset): Metrics {
  return {
    count(name, dimensions, value = 1) {
      const blobs = METRICS[name].map((key) => (dimensions as Record<string, string>)[key] ?? "");
      const point = { name, blobs, value };
      const invocation = currentInvocation();
      if (invocation === undefined) writeOutsideInvocation(dataset, point);
      else invocation.record(dataset, point, METRIC_AGGREGATION[name] ?? "sum");
      const budget = SUBREQUEST_BUDGETS[name];
      if (budget !== undefined) countSubrequests(budget, value);
    },
  };
}
