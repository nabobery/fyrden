import { AsyncLocalStorage } from "node:async_hooks";
import type { Metrics } from "./metrics.js";

/**
 * The two per-invocation subrequest budgets (measured on Workers Free,
 * 2026-10-10): `internal` is calls to R2, D1, Durable Objects and other
 * bindings (1,000 on Free), `external` is outbound `fetch` and Cache API
 * calls (50 on Free). Paid allows 10,000 of each by default (verified:
 * https://developers.cloudflare.com/workers/platform/limits/).
 */
export type SubrequestBudget = "internal" | "external";

/**
 * Analytics Engine accepts at most 250 data points per Worker invocation;
 * every `writeDataPoint` call counts, and the next one throws (verified:
 * https://developers.cloudflare.com/analytics/analytics-engine/limits/;
 * the error, "Analytics Engine write limit exceeded.", measured on a
 * deployment 2026-10-11).
 */
export const ANALYTICS_ENGINE_POINTS_PER_INVOCATION = 250;

/**
 * The data points one invocation writes at most, its `metrics.dropped`
 * point included. Proposed: kept below the platform's limit so a write
 * made some other way still fits.
 */
export const METRIC_POINT_BUDGET = 200;

/**
 * How the points of one metric with the same dimensions combine within an
 * invocation: `sum` adds the values (counters), `last` keeps the latest
 * value (gauges), `each` keeps every point (one sample per event).
 */
export type MetricAggregation = "sum" | "last" | "each";

/** A data point to write: its index (the metric name), dimensions and value. */
export interface PendingPoint {
  readonly name: string;
  readonly blobs: readonly string[];
  value: number;
}

export interface InvocationOptions {
  /** A Worker request or a Durable Object invocation (RPC method or alarm). */
  readonly where: "worker" | "do";
  /** The route pattern or method name: a short name from code, never a value from a request. */
  op: string;
  /** For a Durable Object: its class, to record the invocation's wall time as `do.active_ms`. */
  readonly doClass?: string;
  readonly now?: () => number;
}

const scope = new AsyncLocalStorage<Invocation>();

/**
 * The data points one platform invocation may still write, shared by an
 * invocation and any invocation measured inside it.
 */
export class PointBudget {
  written = 0;
  dropped = 0;
  /** The platform refused a write: nothing more is tried in this invocation. */
  refused = false;
  /** Invocations using this budget that have not written their points yet. */
  open = 0;

  /** Writes one point if the budget allows; a refusal or failure is counted, never thrown. */
  write(dataset: AnalyticsEngineDataset, point: PendingPoint, reserve = 1): boolean {
    if (this.refused || this.written >= METRIC_POINT_BUDGET - reserve) {
      this.dropped++;
      return false;
    }
    try {
      dataset.writeDataPoint({
        indexes: [point.name],
        blobs: [...point.blobs],
        doubles: [point.value],
      });
      this.written++;
      return true;
    } catch {
      this.refused = true;
      this.dropped++;
      return false;
    }
  }
}

/**
 * The subrequests one platform invocation has made so far, shared by an
 * invocation and any invocation measured inside it (the platform's budgets
 * are per invocation, however the code inside measures itself).
 */
export class SubrequestTally {
  internal = 0;
  external = 0;
  /**
   * D1 statements run (each of a batch too), counted at the binding (see
   * `countedD1`): D1 allows a Free invocation 50 queries besides its
   * share of the internal calls (https://developers.cloudflare.com/d1/platform/limits/).
   */
  d1 = 0;
}

/** Points written outside any invocation that the platform refused, reported by the next invocation. */
let droppedOutside = 0;

/** Writes one point outside any invocation, at once; a failure is counted, never thrown. */
export function writeOutsideInvocation(dataset: AnalyticsEngineDataset, point: PendingPoint): void {
  try {
    dataset.writeDataPoint({
      indexes: [point.name],
      blobs: [...point.blobs],
      doubles: [point.value],
    });
  } catch {
    droppedOutside++;
  }
}

/**
 * One invocation's metrics. Subrequests are counted as they are made and
 * written as `subrequests` data points (one per budget used) when it ends.
 * Every other point counted inside it is held and combined by metric and
 * dimensions (see `MetricAggregation`), and written once at the end, within
 * `METRIC_POINT_BUDGET`; points over the budget are dropped and counted as
 * `metrics.dropped`. Nothing here ever throws into the caller.
 *
 * Calls are attributed through async context, so concurrent invocations of
 * one Durable Object are counted apart. Background work that outlives the
 * response (a streamed body, `waitUntil`) holds the invocation open.
 */
export class Invocation {
  internal = 0;
  external = 0;
  /** The point budget of the platform invocation this one runs in. */
  readonly pointBudget: PointBudget;
  /** The subrequests of the platform invocation this one runs in. */
  readonly tally: SubrequestTally;
  readonly #metrics: Metrics;
  readonly #options: InvocationOptions;
  readonly #now: () => number;
  readonly #startedAt: number;
  /** Held points by dataset, then by metric and dimensions. */
  readonly #held = new Map<AnalyticsEngineDataset, Map<string, PendingPoint>>();
  #heldCount = 0;
  #samples = 0;
  #holds = 1;
  #reportingDropped = false;
  /** Work to run once when the invocation ends, by key. */
  readonly #atEnd = new Map<string, () => void>();

  constructor(metrics: Metrics, options: InvocationOptions) {
    this.#metrics = metrics;
    this.#options = { ...options };
    this.#now = options.now ?? Date.now;
    this.#startedAt = this.#now();
    const outer = scope.getStore();
    this.pointBudget = outer?.pointBudget ?? new PointBudget();
    this.tally = outer?.tally ?? new SubrequestTally();
    this.pointBudget.open++;
  }

  get op(): string {
    return this.#options.op;
  }

  /** Renames the invocation (the route is known only after routing). */
  set op(op: string) {
    this.#options.op = op;
  }

  add(budget: SubrequestBudget, n: number): void {
    if (!(n > 0)) return;
    // Background work after the end still spends the platform's budget.
    this.tally[budget] += n;
    if (this.#holds === 0) return;
    this[budget] += n;
  }

  /**
   * Records one data point: held and combined until the invocation ends,
   * or written at once (within the budget) once it has ended.
   */
  record(
    dataset: AnalyticsEngineDataset,
    point: PendingPoint,
    aggregation: MetricAggregation,
  ): void {
    if (this.#holds === 0) {
      // The dropped count uses the slot the budget keeps for it.
      this.pointBudget.write(dataset, point, this.#reportingDropped ? 0 : 1);
      return;
    }
    let held = this.#held.get(dataset);
    if (held === undefined) {
      held = new Map();
      this.#held.set(dataset, held);
    }
    const key =
      aggregation === "each"
        ? `#${this.#samples++}`
        : `${point.name}\u0000${point.blobs.join("\u0000")}`;
    const existing = held.get(key);
    if (existing !== undefined) {
      existing.value = aggregation === "sum" ? existing.value + point.value : point.value;
      return;
    }
    // Held points are bounded: past the budget they could never be written.
    if (this.#heldCount >= METRIC_POINT_BUDGET) {
      this.pointBudget.dropped++;
      return;
    }
    this.#heldCount++;
    held.set(key, { name: point.name, blobs: point.blobs, value: point.value });
  }

  /**
   * Runs `fn` once when the invocation ends, before its points are written
   * (a gauge measured once however often its subject changed). A second
   * call with the same key replaces the first; once ended, `fn` runs now.
   * Errors from `fn` are ignored: it must handle its own.
   */
  atEnd(key: string, fn: () => void): void {
    if (this.#holds === 0) runIgnoringErrors(fn);
    else this.#atEnd.set(key, fn);
  }

  /** Runs `fn` as part of this invocation: every call it makes is counted here. */
  run<R>(fn: () => R): R {
    return scope.run(this, fn);
  }

  /** Keeps the invocation open until the returned function is called (once). */
  hold(): () => void {
    if (this.#holds === 0) return () => {};
    this.#holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#release();
    };
  }

  /** The invocation's own work is done; it is written once no hold remains. */
  end(): void {
    this.#release();
  }

  #release(): void {
    if (this.#holds === 0) return;
    if (--this.#holds > 0) return;
    // Written inside the invocation's own context, so a dataset can tell
    // which invocation a point belongs to.
    scope.run(this, () => this.#flush());
  }

  #flush(): void {
    const { where, op, doClass } = this.#options;
    const atEnd = [...this.#atEnd.values()];
    this.#atEnd.clear();
    for (const fn of atEnd) runIgnoringErrors(fn);
    // The invocation's own points first: they are written at once now.
    for (const budget of ["internal", "external"] as const) {
      if (this[budget] > 0) this.#metrics.count("subrequests", { where, budget, op }, this[budget]);
    }
    if (doClass !== undefined) {
      this.#metrics.count(
        "do.active_ms",
        { class: doClass, method: op },
        Math.max(0, this.#now() - this.#startedAt),
      );
    }
    const budget = this.pointBudget;
    for (const [dataset, held] of this.#held) {
      for (const point of held.values()) budget.write(dataset, point);
    }
    this.#held.clear();
    this.#heldCount = 0;
    // The last invocation of the budget to finish reports what was dropped.
    if (--budget.open > 0) return;
    const dropped = budget.dropped + droppedOutside;
    if (dropped === 0 || budget.refused) return;
    budget.dropped = 0;
    droppedOutside = 0;
    this.#reportingDropped = true;
    try {
      this.#metrics.count("metrics.dropped", { where, op }, dropped);
    } finally {
      this.#reportingDropped = false;
    }
  }
}

function runIgnoringErrors(fn: () => void): void {
  try {
    fn();
  } catch {
    // The caller's work is done; a failure here must not fail it.
  }
}

/** Runs `fn` when the current invocation ends (see `Invocation.atEnd`), or now outside one. */
export function atInvocationEnd(key: string, fn: () => void): void {
  const invocation = scope.getStore();
  if (invocation === undefined) runIgnoringErrors(fn);
  else invocation.atEnd(key, fn);
}

/** The invocation the caller runs in, if any. */
export function currentInvocation(): Invocation | undefined {
  return scope.getStore();
}

/** D1 statements the platform invocation the caller runs in has run (0 outside any). */
export function d1StatementsRun(): number {
  return scope.getStore()?.tally.d1 ?? 0;
}

/** Counts `n` D1 statements in the current invocation (none: not counted). */
export function countD1Statements(n = 1): void {
  const invocation = scope.getStore();
  if (invocation) invocation.tally.d1 += n;
}

/** Counts `n` calls against `budget` in the current invocation (none: not counted). */
export function countSubrequests(budget: SubrequestBudget, n = 1): void {
  scope.getStore()?.add(budget, n);
}

/**
 * Admits one optional external call (a Cache API match or put) while the
 * platform invocation the caller runs in has made fewer than `limit`
 * external calls, whoever made them (other cache tiers, outbound fetches),
 * and counts it. A fresh cache tier per phase or job therefore cannot reset
 * the allowance within one invocation. Outside any invocation the caller's
 * own count, `ownCalls`, stands in.
 */
export function admitExternalCall(limit: number, ownCalls: number): boolean {
  const made = scope.getStore()?.tally.external ?? ownCalls;
  if (made >= limit) return false;
  countSubrequests("external");
  return true;
}

/** Runs `fn` as a new invocation and writes its counts when it settles. */
export async function measureInvocation<R>(
  metrics: Metrics,
  options: InvocationOptions,
  fn: () => R | Promise<R>,
): Promise<R> {
  const invocation = new Invocation(metrics, options);
  try {
    return await invocation.run(fn);
  } finally {
    invocation.end();
  }
}
