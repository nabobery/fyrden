import type { LiveRefusalReason } from "./budget.js";

/** How long a proven closure is remembered: a reopening is late by at most this. */
const MEMO_MS = 60_000;

/**
 * A refusal an opening's transport got. Its price is fixed, so these gates close
 * every opening alike. Anything else (one feed's epoch or recovery target, a plan's
 * dates, an answer lost, owners' places) proves nothing of the next attempt.
 */
const closesEveryOpening = (gate: LiveRefusalReason) =>
  gate.startsWith("debt:") ||
  [
    "daily_total",
    "ordinary_share",
    "duration_day",
    "second_day",
    "duration_closed",
    "escrow_full",
    "overdue_receipts",
    "old_days",
  ].includes(gate);

export interface LiveClosure {
  readonly reason: "daily" | "temporary";
  readonly gate: LiveRefusalReason;
  readonly retryAt?: number;
}

let held: { readonly closure: LiveClosure; readonly until: number } | null = null;

/**
 * This isolate's memory of the ledger being closed to new openings, read only by
 * a listen and a ticket before they read anything of it. Set only on proof that
 * an opening's transport cannot fit: a later grant's refusal depends on what its
 * feed holds. Per isolate, so another isolate only saves fewer reads.
 */
export const liveRefusalMemo = {
  closed(now: number): LiveClosure | null {
    return held && now < held.until ? held.closure : null;
  },
  note(closure: LiveClosure, now: number): void {
    if (closesEveryOpening(closure.gate))
      held = {
        closure,
        until: Math.min(now + MEMO_MS, closure.retryAt ?? Number.MAX_SAFE_INTEGER),
      };
  },
  clear(): void {
    held = null;
  },
};
