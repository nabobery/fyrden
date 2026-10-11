import { DEFAULT_PART_BYTES, REFLOG_RETENTION_MS } from "@fyrden/adapters-cloudflare/git";

const MiB = 1024 * 1024;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Budgets and timings of repack and garbage collection. Every
 * value is a Proposed default, tuned under load; `RepoDO.maintenance` holds
 * the policy in use (tests replace it).
 */
export interface MaintenancePolicy {
  /**
   * Wall time one slice may run. A Durable Object alarm gets 30 s of CPU
   * and is reset past it, losing the slice's writes (measured on Workers
   * Free, 2026-10-10); wall time bounds CPU time from above. 20 s leaves
   * room for the other jobs of the same alarm.
   */
  readonly sliceMs: number;
  /** Pack bytes one slice writes before it saves its place (a second bound, independent of the clock). */
  readonly sliceBytes: number;
  /** Objects one slice walks (marking) or copies (writing a pack). */
  readonly sliceObjects: number;
  /**
   * R2 calls one slice makes before it saves its place. Calls from a
   * Durable Object to its bindings count toward a per-invocation limit
   * (1,000 on every plan, unverified for alarms).
   */
  readonly sliceR2Calls: number;
  /** Multipart part size of the packs maintenance writes (at least 5 MiB, all parts but the last equal). */
  readonly partBytes: number;
  /**
   * Geometric repack factor: own live packs, sorted by size, should each be
   * at least this many times the total of the smaller ones (as `git repack
   * --geometric=2`).
   */
  readonly geometricFactor: number;
  /**
   * Most objects one repack or collection may rewrite. Writing keeps about
   * 49 bytes per object (plan and entry table) and the sources' indexes
   * about 28, beside a part buffer and read windows, all from the 72 MiB
   * operation pool; the same bound as a push's tail merge.
   */
  readonly maxRewriteObjects: number;
  /**
   * How long a swap waits for leases on the packs it replaces. After that
   * it replaces them anyway: a superseded pack stays readable, and is never
   * deleted while a lease from before its condemnation is unexpired, so the
   * clone holding the lease is unaffected.
   */
  readonly leaseWaitMs: number;
  /** How long a swap waits for pushes being indexed (their dependencies may name the replaced packs). */
  readonly indexingWaitMs: number;
  /** Delay before trying a refused swap again. */
  readonly retryMs: number;
  /**
   * Unreachable objects (a garbage pack) are condemned no earlier than this
   * after the pack was last touched (JGit's default time to live for
   * unreachable garbage; unverified).
   */
  readonly garbageTtlMs: number;
  /** Reflog entries newer than this are reachability roots (as long as reflog pruning keeps them). */
  readonly reflogRetentionMs: number;
  /** A collection runs this long after a non-fast-forward update, so a burst of them is collected once. */
  readonly gcDelayMs: number;
  /** A repack check runs this long after a push. */
  readonly repackDelayMs: number;
  /** Packs a push adds are checked for all-reachable this long after it. */
  readonly reachabilityDelayMs: number;
  /** The lease maintenance holds on a pack it is writing, renewed by every slice. */
  readonly outputLeaseMs: number;
  /** Objects a collection's final catch-up walk (refs moved during the run) may visit under the commit lock. */
  readonly maxCatchUpObjects: number;
}

export const MAINTENANCE_DEFAULTS: MaintenancePolicy = Object.freeze({
  sliceMs: 20_000,
  sliceBytes: 256 * MiB,
  sliceObjects: 200_000,
  sliceR2Calls: 500,
  partBytes: DEFAULT_PART_BYTES,
  geometricFactor: 2,
  maxRewriteObjects: 500_000,
  leaseWaitMs: HOUR,
  indexingWaitMs: 10 * MINUTE,
  retryMs: MINUTE,
  garbageTtlMs: DAY,
  reflogRetentionMs: REFLOG_RETENTION_MS,
  gcDelayMs: 10 * MINUTE,
  repackDelayMs: MINUTE,
  reachabilityDelayMs: 30_000,
  outputLeaseMs: 2 * HOUR,
  maxCatchUpObjects: 100_000,
});
