import type { GitStorageContext, JobQueue } from "@fyrden/adapters-cloudflare/git";
import type { Logger, MetricDimensions, Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { NetworkRegistry } from "./registry.js";

const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
const DAY = 24 * HOUR;

/** Budgets and timings of a fork network. Every value is a Proposed default, tuned under load. */
export interface NetworkPolicy {
  /** How long fork creation (and detach) waits for a collection's mark phase to end before a retryable refusal. */
  readonly fenceWaitMs: number;
  /** A fork still joining this long after it began is taken as abandoned. */
  readonly joiningTtlMs: number;
  /** Shared packs are deleted no earlier than this after they are condemned (Durable Object point-in-time recovery reaches back 30 days). */
  readonly retentionMs: number;
  /** Delay before asking again a member that has not acknowledged a condemned pack. */
  readonly ackRetryMs: number;
  /** A collection of a network with more than one member runs this often. */
  readonly gcIntervalMs: number;
  /** An object under the network's pack prefix that no registry names is deleted once older than this. */
  readonly sweepTtlMs: number;
  /** Objects listed per sweep page. */
  readonly sweepListLimit: number;
  /** Wall time one slice may run (an alarm gets 30 s of CPU, measured on Workers Free, 2026-10-10). */
  readonly sliceMs: number;
  /**
   * Calls to members, R2 and D1 one slice makes at most (a call to a member
   * counts with the directory check that may follow it). The job queue
   * starts no slice past 800 calls in an invocation, so a slice must fit in
   * the rest of the 1,000 Free allows (measured on Workers Free, 2026-10-10).
   */
  readonly sliceCalls: number;
}

export const NETWORK_DEFAULTS: NetworkPolicy = Object.freeze({
  fenceWaitMs: 10 * SECOND,
  joiningTtlMs: HOUR,
  retentionMs: 30 * DAY,
  ackRetryMs: 10 * 60 * SECOND,
  gcIntervalMs: DAY,
  sweepTtlMs: DAY,
  sweepListLimit: 100,
  sliceMs: 20 * SECOND,
  sliceCalls: 100,
});

type CallMetric = "r2.class_a" | "d1.query" | "do.request";

/**
 * The calls one slice of a network job has made, within the policy's
 * `sliceCalls`. Each is counted before it is made, in the slice and as its
 * cost counter (which the invocation counts against its budget).
 */
export class SliceCalls {
  #made = 0;

  constructor(
    private readonly limit: number,
    private readonly metrics: Metrics,
  ) {}

  /** Whether `n` more calls fit in the slice. */
  fits(n: number): boolean {
    return this.#made + n <= this.limit;
  }

  /** Counts a call about to be made. */
  count<N extends CallMetric>(name: N, dimensions: MetricDimensions<N>): void {
    this.#made++;
    this.metrics.count(name, dimensions);
  }
}

/** Pause points for tests (the network's ordering under concurrency). */
export interface NetworkHooks {
  /** Before the collection snapshots member `repoId` in its mark phase. */
  readonly onMarkMember?: (epoch: number, repoId: string) => Promise<void> | void;
  /** Before member `repoId` is asked to acknowledge condemned packs; throwing leaves it unacknowledged. */
  readonly beforeAck?: (repoId: string, packIds: readonly string[]) => Promise<void> | void;
  /** After a shared pack is chosen for deletion and before the claims are checked a last time. */
  readonly beforeDelete?: (packId: string) => Promise<void> | void;
  /** Inside a deletion: the fence is set and the bytes are about to be deleted. Throwing interrupts it. */
  readonly whileDeleting?: (packId: string) => Promise<void> | void;
}

/** What the network's jobs work with. */
export interface NetworkRuntime {
  readonly env: Env;
  readonly context: GitStorageContext;
  readonly registry: NetworkRegistry;
  readonly jobs: JobQueue;
  readonly policy: NetworkPolicy;
  readonly hooks: NetworkHooks;
  readonly log: Logger;
}

export const NETWORK_GC_JOB_ID = "network-gc";
export const NETWORK_DELETE_JOB_ID = "network-delete";

/** Schedules the deletion job at `at` (or sooner, if it is due sooner). */
export function scheduleDeletions(runtime: NetworkRuntime, at = runtime.context.now()): void {
  runtime.jobs.ensure("network_delete", NETWORK_DELETE_JOB_ID, { runAt: at });
}

export function scheduleNetworkGc(runtime: NetworkRuntime, at: number): void {
  runtime.jobs.ensure("network_gc", NETWORK_GC_JOB_ID, { runAt: at });
}
