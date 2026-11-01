import { DEFAULT_JOB_POLICY, type JobPolicy } from "@fyrden/adapters-cloudflare/git";
import { workersPlan } from "./git/fetch/mode.js";

/**
 * Calls to internal services (D1 queries, R2, Durable Objects, Queues) one
 * invocation may make on Workers Free: 1,000, shared by all of them, in a
 * Worker request, a Durable Object request or alarm, and a queue consumer
 * (measured on Workers Free, 2026-10-10 and 2026-10-26; a `db.batch()`
 * counts once). D1's own limits page says 50 D1 queries on Free, which
 * did not hold in any of them. Free cannot raise it.
 */
export const FREE_INTERNAL_CALLS = 1_000;

/** The most Workers Paid allows an invocation (`limits.subrequests`). */
export const MAX_INTERNAL_CALLS = 10_000_000;

/**
 * Calls one job slice may make: the queue starts no slice once the
 * invocation has made more than its limit less these (slices are sized to
 * fit, mergeability's and CODEOWNERS' at 150 reads).
 */
export const SLICE_CALLS = 200;

/**
 * The deployment's budget of internal calls per invocation, which sliced
 * work (jobs, the events consumer's messages, archives) is admitted
 * against. Free: 1,000, whatever is set. Paid: `FYRDEN_INTERNAL_CALLS`
 * when it is a whole number from 1,000 to 10,000,000 (`fyrden deploy
 * --plan paid --internal-calls` sets it, with `limits.subrequests` to
 * match); otherwise 1,000 until a Paid deployment measures more. Cloudflare's
 * pages disagree for Paid (D1's says 1,000 D1 queries, Workers' 10,000
 * internal calls by default), and too high a budget fails calls mid-slice,
 * while too low a one only costs more invocations.
 */
export function internalCallLimit(env: object): number {
  if (workersPlan(env) !== "paid") return FREE_INTERNAL_CALLS;
  const raw = (env as { FYRDEN_INTERNAL_CALLS?: unknown }).FYRDEN_INTERNAL_CALLS;
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw)
        ? Number(raw)
        : NaN;
  return Number.isSafeInteger(value) && value >= FREE_INTERNAL_CALLS && value <= MAX_INTERNAL_CALLS
    ? value
    : FREE_INTERNAL_CALLS;
}

/** The job queue's policy for this deployment: no slice starts past the limit less a slice's calls. */
export function jobPolicy(env: object): JobPolicy {
  return { ...DEFAULT_JOB_POLICY, maxInternalCalls: internalCallLimit(env) - SLICE_CALLS };
}

/** Calls a queue consumer leaves unspent: its own bookkeeping, and a margin. */
export const CONSUMER_MARGIN = 100;

/** Calls a queue consumer's messages (events, effects) share in one invocation. */
export function consumerCalls(env: object): number {
  return internalCallLimit(env) - CONSUMER_MARGIN;
}
