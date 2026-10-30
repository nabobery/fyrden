/*
 * Whether a feed's funded live work may wake its alarm. Intended work (a
 * queued renewal, a pump unit) is not reason enough: only readiness
 * established by funded reconciliation is (its coverage, fences, owner and
 * capacity all current), until it lapses. Unknown or blocked readiness
 * wakes nothing, and nothing is read to rediscover the work. Nothing in
 * production establishes readiness yet.
 */

export type LiveReadiness =
  | { readonly status: "blocked" }
  | {
      readonly status: "ready";
      /** When the work is due. */
      readonly at: number;
      /** When the readiness lapses (its coverage's validity). */
      readonly validUntil: number;
      /** The reconciliation it came from: a newer one replaces it. */
      readonly generation: number;
    };

export const LIVE_BLOCKED: LiveReadiness = { status: "blocked" };

/** When funded live work wakes the alarm (null: it does not). Reads no state. */
export function eligibleLiveDeadline(readiness: LiveReadiness, now: number): number | null {
  if (readiness.status !== "ready" || now >= readiness.validUntil) return null;
  return Math.max(readiness.at, now);
}
